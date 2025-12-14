export async function loadGraphStream(readableStream, onProgress) {
    if (!readableStream) throw new Error("No stream provided");

    // Decompress the GZIP stream
    // We assume the input stream is GZIP (gzipped JSON)
    const ds = new DecompressionStream("gzip");
    const decompressedStream = readableStream.pipeThrough(ds);
    const reader = decompressedStream.getReader();

    const decoder = new TextDecoder("utf-8");

    // Capacity: Start with 1M, grow as needed
    let capacityNodes = 1000000;
    let capacityLinks = 1000000;
    let nodeCount = 0;
    let linkCount = 0;

    let xArr = new Float32Array(capacityNodes);
    let yArr = new Float32Array(capacityNodes);
    let sizeArr = new Float32Array(capacityNodes);
    // Color is R,G,B (3 floats)
    let rArr = new Float32Array(capacityNodes);
    let gArr = new Float32Array(capacityNodes);
    let bArr = new Float32Array(capacityNodes);

    // Labels (Standard Array, strings)
    let labelsArr = new Array(capacityNodes);

    // Links: Source/Target indices
    let linkSrc = new Uint32Array(capacityLinks);
    let linkTgt = new Uint32Array(capacityLinks);

    let buffer = '';
    let state = 'SEARCH_NODES';
    let totalBytes = 0;

    // Helper to resize arrays
    function resizeNodes() {
        capacityNodes *= 2;
        // console.log("Resizing nodes to", capacityNodes);

        const newX = new Float32Array(capacityNodes); newX.set(xArr); xArr = newX;
        const newY = new Float32Array(capacityNodes); newY.set(yArr); yArr = newY;
        const newS = new Float32Array(capacityNodes); newS.set(sizeArr); sizeArr = newS;
        const newR = new Float32Array(capacityNodes); newR.set(rArr); rArr = newR;
        const newG = new Float32Array(capacityNodes); newG.set(gArr); gArr = newG;
        const newB = new Float32Array(capacityNodes); newB.set(bArr); bArr = newB;
        // Resize labels array? Standard array grows automatically, but we initialized with size.
        // Actually for standard array in JS, length is dynamic.
    }

    function resizeLinks() {
        capacityLinks *= 2;
        // console.log("Resizing links to", capacityLinks);
        const newSrc = new Uint32Array(capacityLinks); newSrc.set(linkSrc); linkSrc = newSrc;
        const newTgt = new Uint32Array(capacityLinks); newTgt.set(linkTgt); linkTgt = newTgt;
    }

    // Parse Hex Color
    function parseColor(hexStr, idx) {
        if (!hexStr) return;
        // #RRGGBB
        if (hexStr.startsWith('#')) hexStr = hexStr.slice(1);
        const r = parseInt(hexStr.substring(0, 2), 16) / 255.0;
        const g = parseInt(hexStr.substring(2, 4), 16) / 255.0;
        const b = parseInt(hexStr.substring(4, 6), 16) / 255.0;
        rArr[idx] = r || 0.5;
        gArr[idx] = g || 0.5;
        bArr[idx] = b || 0.5;
    }

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
            if (state === 'SEARCH_NODES') {
                const idx = buffer.indexOf('"nodes":[');
                if (idx !== -1) {
                    buffer = buffer.slice(idx + 9);
                    state = 'IN_NODES';
                } else {
                    if (buffer.length > 50) buffer = buffer.slice(-50); // Keep tail
                    break;
                }
            }

            if (state === 'IN_NODES' || state === 'IN_LINKS') {
                buffer = buffer.trimStart();
                if (buffer.startsWith(',')) buffer = buffer.slice(1).trimStart();

                if (buffer.startsWith(']')) {
                    buffer = buffer.slice(1);
                    state = (state === 'IN_NODES') ? 'SEARCH_LINKS' : 'DONE';
                    if (state === 'DONE') {
                        return {
                            nodeCount, linkCount,
                            x: xArr.slice(0, nodeCount),
                            y: yArr.slice(0, nodeCount),
                            size: sizeArr.slice(0, nodeCount),
                            r: rArr.slice(0, nodeCount),
                            g: gArr.slice(0, nodeCount),
                            b: bArr.slice(0, nodeCount),
                            // Slice labels to correct length
                            labels: labelsArr.slice(0, nodeCount),
                            linkSrc: linkSrc.slice(0, linkCount),
                            linkTgt: linkTgt.slice(0, linkCount)
                        };
                    }
                    continue;
                }

                if (buffer.startsWith('{')) {
                    // Naive JSON object extraction: find matching }
                    // This assumes no nested objects in our specific schema, or handles it simply.
                    // Our schema is flat: {id, x, y, size, color, label}

                    let endIdx = -1;
                    let braceCount = 0;
                    let inString = false;

                    // Optimized scan
                    for (let i = 0; i < buffer.length; i++) {
                        const char = buffer[i];
                        if (char === '"' && buffer[i - 1] !== '\\') { inString = !inString; continue; }
                        if (inString) continue;

                        if (char === '{') braceCount++;
                        else if (char === '}') {
                            braceCount--;
                            if (braceCount === 0) {
                                endIdx = i;
                                break;
                            }
                        }
                    }

                    if (endIdx !== -1) {
                        const objStr = buffer.slice(0, endIdx + 1);
                        buffer = buffer.slice(endIdx + 1);

                        try {
                            const obj = JSON.parse(objStr);

                            if (state === 'IN_NODES') {
                                if (nodeCount >= capacityNodes) resizeNodes();
                                xArr[nodeCount] = obj.x;
                                yArr[nodeCount] = obj.y;
                                sizeArr[nodeCount] = obj.size || 2.0;
                                parseColor(obj.color, nodeCount);
                                labelsArr[nodeCount] = obj.label || ""; // Capture Label
                                nodeCount++;
                                if (nodeCount % 50000 === 0) onProgress(`nodes: ${nodeCount}`);
                            } else {
                                if (linkCount >= capacityLinks) resizeLinks();
                                linkSrc[linkCount] = obj.source; // Integer ID
                                linkTgt[linkCount] = obj.target; // Integer ID
                                linkCount++;
                                if (linkCount % 50000 === 0) onProgress(`links: ${linkCount}`);
                            }
                        } catch (e) {
                            console.warn("Parse error", e);
                        }
                        continue;
                    } else {
                        // Need more data
                        break;
                    }
                } else {
                    // Unexpected char?
                    if (buffer.indexOf('"links":[') !== -1) {
                        // We might have skipped the closing bracket?
                        let idx = buffer.indexOf('"links":[');
                        buffer = buffer.slice(idx + 9);
                        state = 'IN_LINKS';
                        continue;
                    }
                    break;
                }
            }

            if (state === 'SEARCH_LINKS') {
                const idx = buffer.indexOf('"links":[');
                if (idx !== -1) {
                    buffer = buffer.slice(idx + 9);
                    state = 'IN_LINKS';
                } else {
                    if (buffer.length > 50) buffer = buffer.slice(-50);
                    break;
                }
            }
        }
    }

    // Fallback: Return whatever we have if stream ends
    console.warn("Stream ended unexpectedly or finished without clean exit. Returning captured data.", state);
    return {
        nodeCount, linkCount,
        x: xArr.slice(0, nodeCount),
        y: yArr.slice(0, nodeCount),
        size: sizeArr.slice(0, nodeCount),
        r: rArr.slice(0, nodeCount),
        g: gArr.slice(0, nodeCount),
        b: bArr.slice(0, nodeCount),
        labels: labelsArr.slice(0, nodeCount),
        linkSrc: linkSrc.slice(0, linkCount),
        linkTgt: linkTgt.slice(0, linkCount)
    };
}

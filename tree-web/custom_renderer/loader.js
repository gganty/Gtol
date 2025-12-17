export async function loadGraphStream(readableStream, onProgress) {
    if (!readableStream) throw new Error("No stream provided");

    // 1. Decompression stream setup (GZIP)
    // Browser unpacks .gz on the fly.
    const ds = new DecompressionStream("gzip");
    const decompressedStream = readableStream.pipeThrough(ds);
    const reader = decompressedStream.getReader();

    const decoder = new TextDecoder("utf-8");

    // 2. Memory allocation (Typed Arrays)
    // Analog to std::vector<float> with reserve() in C++.
    // Use flat arrays for maximum GPU speed.
    let capacityNodes = 1000000; // Start with 1 million nodes
    let capacityLinks = 1000000;

    let nodeCount = 0;
    let linkCount = 0;

    // Arrays for Nodes (Structure of Arrays layout)
    let xArr = new Float32Array(capacityNodes);
    let yArr = new Float32Array(capacityNodes);
    let sizeArr = new Float32Array(capacityNodes);
    let rArr = new Float32Array(capacityNodes); // Red
    let gArr = new Float32Array(capacityNodes); // Green
    let bArr = new Float32Array(capacityNodes); // Blue
    let labelsArr = new Array(capacityNodes);   // JS Strings are managed by V8

    // Arrays for Links
    let linkSrc = new Uint32Array(capacityLinks);
    let linkTgt = new Uint32Array(capacityLinks);

    // Buffer for stitching text chunks
    let buffer = '';
    // State of our state machine
    let state = 'SEARCH_NODES';
    let totalBytes = 0;

    // --- Helpers ---

    function resizeNodes() {
        // Double the size (Amortized O(1) insertion)
        capacityNodes *= 2;
        // console.log("Resizing nodes to", capacityNodes);

        const newX = new Float32Array(capacityNodes); newX.set(xArr); xArr = newX;
        const newY = new Float32Array(capacityNodes); newY.set(yArr); yArr = newY;
        const newS = new Float32Array(capacityNodes); newS.set(sizeArr); sizeArr = newS;
        const newR = new Float32Array(capacityNodes); newR.set(rArr); rArr = newR;
        const newG = new Float32Array(capacityNodes); newG.set(gArr); gArr = newG;
        const newB = new Float32Array(capacityNodes); newB.set(bArr); bArr = newB;
    }

    function resizeLinks() {
        capacityLinks *= 2;
        const newSrc = new Uint32Array(capacityLinks); newSrc.set(linkSrc); linkSrc = newSrc;
        const newTgt = new Uint32Array(capacityLinks); newTgt.set(linkTgt); linkTgt = newTgt;
    }

    // Fast color parsing #RRGGBB
    function parseColor(hexStr, idx) {
        if (!hexStr) return;
        if (hexStr.startsWith('#')) hexStr = hexStr.slice(1);

        // Bitwise shifts in JS are slower than parseInt for strings, so:
        const r = parseInt(hexStr.substring(0, 2), 16) / 255.0;
        const g = parseInt(hexStr.substring(2, 4), 16) / 255.0;
        const b = parseInt(hexStr.substring(4, 6), 16) / 255.0;

        rArr[idx] = r || 0.5;
        gArr[idx] = g || 0.5;
        bArr[idx] = b || 0.5;
    }

    // --- Main Loop ---

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        // Decode bytes to text and append to buffer tail
        buffer += decoder.decode(value, { stream: true });

        // Process buffer while we can extract data
        while (true) {
            // STATE 1: Look for start of nodes list "nodes":[
            if (state === 'SEARCH_NODES') {
                const idx = buffer.indexOf('"nodes":[');
                if (idx !== -1) {
                    buffer = buffer.slice(idx + 9); // Skip header
                    state = 'IN_NODES';
                } else {
                    // Keep only buffer tail in case key was split
                    if (buffer.length > 50) buffer = buffer.slice(-50);
                    break; // Wait for more data
                }
            }

            // STATE 2 & 3: Read objects inside arrays
            if (state === 'IN_NODES' || state === 'IN_LINKS') {
                // Clean garbage (commas, spaces)
                buffer = buffer.trimStart();
                if (buffer.startsWith(',')) buffer = buffer.slice(1).trimStart();

                // Check for array end ']'
                if (buffer.startsWith(']')) {
                    buffer = buffer.slice(1);
                    // If nodes finished -> look for links. If links finished -> done.
                    state = (state === 'IN_NODES') ? 'SEARCH_LINKS' : 'DONE';

                    if (state === 'DONE') {
                        // RETURN RESULT
                        // Trim arrays (.slice) to actual element count
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
                    continue;
                }

                // Try to find full JSON object {...}
                if (buffer.startsWith('{')) {
                    // We need to find the closing brace }
                    // IMPORTANT: Cannot just search for '}' as it might be inside a label string.
                    // Primitive brace balance scanner:

                    let endIdx = -1;
                    let braceCount = 0;
                    let inString = false;

                    for (let i = 0; i < buffer.length; i++) {
                        const char = buffer[i];
                        // If we meet a quote and it's not escaped
                        if (char === '"' && buffer[i - 1] !== '\\') {
                            inString = !inString;
                            continue;
                        }
                        if (inString) continue; // Ignore braces inside string

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
                        // Yay, we have full text of one object
                        const objStr = buffer.slice(0, endIdx + 1);
                        buffer = buffer.slice(endIdx + 1); // Remove processed from buffer

                        try {
                            // Parse only this small chunk
                            const obj = JSON.parse(objStr);

                            if (state === 'IN_NODES') {
                                if (nodeCount >= capacityNodes) resizeNodes();

                                xArr[nodeCount] = obj.x;
                                yArr[nodeCount] = obj.y;
                                sizeArr[nodeCount] = obj.size || 2.0;
                                parseColor(obj.color, nodeCount);
                                labelsArr[nodeCount] = obj.label || "";

                                nodeCount++;
                                if (nodeCount % 50000 === 0) onProgress(`Loading nodes: ${nodeCount}`);

                            } else { // IN_LINKS
                                if (linkCount >= capacityLinks) resizeLinks();

                                linkSrc[linkCount] = obj.source;
                                linkTgt[linkCount] = obj.target;

                                linkCount++;
                                if (linkCount % 50000 === 0) onProgress(`Loading links: ${linkCount}`);
                            }
                        } catch (e) {
                            console.warn("Skipping bad JSON chunk", e);
                        }
                        continue; // Immediately look for next object
                    } else {
                        // Closing brace not found -> object incomplete
                        // Break inner loop, wait for next network chunk
                        break;
                    }
                } else {
                    // If we are here, buffer doesn't start with '{' or ']'.
                    // Possibly in transition phase between arrays ("nodes": [...] , "links": [...])
                    if (buffer.indexOf('"links":[') !== -1) {
                        // Skip garbage until links start
                        let idx = buffer.indexOf('"links":[');
                        buffer = buffer.slice(idx + 9);
                        state = 'IN_LINKS';
                        continue;
                    }
                    // If unclear — wait for data (or it's EOF)
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

    return {
        nodeCount, linkCount,
        x: xArr.slice(0, nodeCount),
        y: yArr.slice(0, nodeCount),
        labels: labelsArr.slice(0, nodeCount),
        // ... return what we accumulated, even if stream broke
        size: sizeArr.slice(0, nodeCount),
        r: rArr.slice(0, nodeCount), g: gArr.slice(0, nodeCount), b: bArr.slice(0, nodeCount),
        linkSrc: linkSrc.slice(0, linkCount), linkTgt: linkTgt.slice(0, linkCount)
    };
}
/**
 * Binary format I/O for GTOL (.gtol) files.
 * Layout:
 * [Header 32b]
 * [Nodes X Float32]
 * [Nodes Y Float32]
 * [Nodes Size Float32]
 * [Nodes R Float32]
 * [Nodes G Float32]
 * [Nodes B Float32]
 * [Links Src Uint32]
 * [Links Tgt Uint32]
 * [Label Offsets Uint32]
 * [Label Chars Uint8]
 */

const MAGIC = "GTOL"; // 0x47544F4C
const VERSION = 1;

export function serializeLabels(labels) {
    const nodeCount = labels.length;
    const enc = new TextEncoder();
    const labelOffsets = new Uint32Array(nodeCount);

    // heuristic: estimate 12 bytes per label
    let cap = Math.min(nodeCount * 12, 1024 * 1024 * 512); // cap start size
    let labelBytes = new Uint8Array(cap);
    let cursorBytes = 0;

    for (let i = 0; i < nodeCount; i++) {
        const str = labels[i] || "";
        const maxLen = str.length * 3;

        if (cursorBytes + maxLen > cap) {
            const newCap = Math.max(cap * 1.5, cursorBytes + maxLen + 1024 * 1024);
            // check for safe limit
            const newBuf = new Uint8Array(newCap);
            newBuf.set(labelBytes);
            labelBytes = newBuf;
            cap = newCap;
        }

        const res = enc.encodeInto(str, labelBytes.subarray(cursorBytes));
        cursorBytes += res.written;
        labelOffsets[i] = cursorBytes;
    }

    // return exact sized buffer for transfer
    const finalBytes = labelBytes.slice(0, cursorBytes);
    return { labelOffsets, labelBytes: finalBytes };
}

export function saveToGTOL(data) {
    const { nodeCount, linkCount, x, y, size, r, g, b, linkSrc, linkTgt, labels } = data;

    let labelOffsets, labelBytes;

    // check if labels are already serialized (lazy proxy or worker result)
    if (labels && labels._offsets && labels._buffer) {
        labelOffsets = labels._offsets;
        labelBytes = labels._buffer;
    }
    // or if passed as separate props (e.g. from serializeLabels)
    else if (data.labelOffsets && data.labelBytes) {
        labelOffsets = data.labelOffsets;
        labelBytes = data.labelBytes;
    }
    else {
        // serialize now
        const ser = serializeLabels(labels);
        labelOffsets = ser.labelOffsets;
        labelBytes = ser.labelBytes;
    }

    const totalLabelBytes = labelBytes.byteLength;

    // 2. calculate total size
    // header: 32 bytes
    // nodes: 6 arrays * 4 bytes * nodeCount
    // links: 2 arrays * 4 bytes * linkCount
    // label offsets: 4 bytes * nodeCount
    // label bytes: totalLabelBytes

    const HEADER_SIZE = 32;
    const NODE_BLOCK_SIZE = nodeCount * 4 * 6; // x, y, size, r, g, b
    const LINK_BLOCK_SIZE = linkCount * 4 * 2; // src, tgt
    const LABEL_OFFSET_SIZE = nodeCount * 4;

    const TOTAL_SIZE = HEADER_SIZE + NODE_BLOCK_SIZE + LINK_BLOCK_SIZE + LABEL_OFFSET_SIZE + totalLabelBytes;

    const buffer = new ArrayBuffer(TOTAL_SIZE);
    const view = new DataView(buffer);

    // 3. write header
    // magic (4 bytes)
    view.setUint8(0, MAGIC.charCodeAt(0));
    view.setUint8(1, MAGIC.charCodeAt(1));
    view.setUint8(2, MAGIC.charCodeAt(2));
    view.setUint8(3, MAGIC.charCodeAt(3));

    view.setUint32(4, VERSION, true); // version
    view.setUint32(8, nodeCount, true);
    view.setUint32(12, linkCount, true);
    view.setUint32(16, totalLabelBytes, true); // store label blob size
    // reserved 20..32

    let cursor = HEADER_SIZE;

    // helper to write float array
    function writeFloats(arr) {
        const dest = new Float32Array(buffer, cursor, nodeCount);
        dest.set(arr);
        cursor += nodeCount * 4;
    }

    writeFloats(x);
    writeFloats(y);
    writeFloats(size);
    writeFloats(r);
    writeFloats(g);
    writeFloats(b);

    // Links
    function writeInts(arr, count) {
        const dest = new Uint32Array(buffer, cursor, count);
        dest.set(arr);
        cursor += count * 4;
    }

    writeInts(linkSrc, linkCount);
    writeInts(linkTgt, linkCount);

    // Label offsets
    writeInts(labelOffsets, nodeCount);

    // Label bytes
    const labelDest = new Uint8Array(buffer, cursor, totalLabelBytes);
    // careful: labelBytes is the large growable buffer, we only want the used part
    labelDest.set(labelBytes.subarray(0, totalLabelBytes));

    return buffer;
}

export function saveToGTOLParts(data) {
    // similar to saveToGTOL but returns array of parts for Blob
    const { nodeCount, linkCount, x, y, size, r, g, b, linkSrc, linkTgt, labels } = data;

    let labelOffsets, labelBytes;

    if (labels && labels._offsets && labels._buffer) {
        labelOffsets = labels._offsets;
        labelBytes = labels._buffer;
    } else if (data.labelOffsets && data.labelBytes) {
        labelOffsets = data.labelOffsets;
        labelBytes = data.labelBytes;
    } else {
        const ser = serializeLabels(labels);
        labelOffsets = ser.labelOffsets;
        labelBytes = ser.labelBytes;
    }

    const parts = [];

    // header
    const HEADER_SIZE = 32;
    const headerBuf = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(headerBuf);

    view.setUint8(0, MAGIC.charCodeAt(0));
    view.setUint8(1, MAGIC.charCodeAt(1));
    view.setUint8(2, MAGIC.charCodeAt(2));
    view.setUint8(3, MAGIC.charCodeAt(3));

    view.setUint32(4, VERSION, true);
    view.setUint32(8, nodeCount, true);
    view.setUint32(12, linkCount, true);
    view.setUint32(16, labelBytes.byteLength, true);

    parts.push(headerBuf);

    // nodes
    parts.push(x);
    parts.push(y);
    parts.push(size);
    parts.push(r);
    parts.push(g);
    parts.push(b);

    // links
    parts.push(linkSrc);
    parts.push(linkTgt);

    // label offsets
    parts.push(labelOffsets);

    // label bytes
    parts.push(labelBytes);

    return parts;
}

export function loadFromGTOL(buffer) {
    const view = new DataView(buffer);

    // check magic
    const m0 = view.getUint8(0);
    const m1 = view.getUint8(1);
    const m2 = view.getUint8(2);
    const m3 = view.getUint8(3);
    const magicStr = String.fromCharCode(m0, m1, m2, m3);

    if (magicStr !== MAGIC) {
        throw new Error(`Invalid GTOL file. Expected magic '${MAGIC}', got '${magicStr}'`);
    }

    const version = view.getUint32(4, true);
    if (version !== 1) {
        throw new Error(`Unsupported GTOL version: ${version}`);
    }

    const nodeCount = view.getUint32(8, true);
    const linkCount = view.getUint32(12, true);
    const totalLabelBytes = view.getUint32(16, true);

    let cursor = 32; // header size
    // create views (zero copy where possible)

    function readFloats(name) {
        const arr = new Float32Array(buffer, cursor, nodeCount);
        const copy = new Float32Array(nodeCount);
        copy.set(arr);
        cursor += nodeCount * 4;
        return copy;
    }

    const x = readFloats("x");
    const y = readFloats("y");
    const size = readFloats("size");
    const r = readFloats("r");
    const g = readFloats("g");
    const b = readFloats("b");

    function readInts(count) {
        const arr = new Uint32Array(buffer, cursor, count);
        const copy = new Uint32Array(count);
        copy.set(arr);
        cursor += count * 4;
        return copy;
    }

    const linkSrc = readInts(linkCount);
    const linkTgt = readInts(linkCount);

    const labelOffsets = readInts(nodeCount);
    const labelBytes = new Uint8Array(buffer, cursor, totalLabelBytes);

    // lazy labels: don't decode everything at once to save memory.
    // return an interface with .get(i)
    // we need to keep references to buffers for the lazy decoder
    const labelsProxy = {
        _decoder: new TextDecoder(),
        _buffer: labelBytes,
        _offsets: labelOffsets,
        length: nodeCount,

        get(i) {
            if (i < 0 || i >= this.length) return "";

            const start = (i === 0) ? 0 : this._offsets[i - 1];
            const end = this._offsets[i];
            const sub = this._buffer.subarray(start, end);
            return this._decoder.decode(sub);
        },

        // helper to check if label exists without decoding
        has(i) {
            if (i < 0 || i >= this.length) return false;
            const start = (i === 0) ? 0 : this._offsets[i - 1];
            const end = this._offsets[i];
            return end > start;
        }
    };

    const proxy = new Proxy(labelsProxy, {
        get(target, prop, receiver) {
            // intercept numeric indices
            if (typeof prop === 'string' && !isNaN(prop)) {
                return target.get(parseInt(prop, 10));
            }
            return Reflect.get(target, prop, receiver);
        }
    });

    return {
        nodeCount, linkCount,
        x, y, size, r, g, b,
        linkSrc, linkTgt,
        labels: proxy,
        labelBytes,
        labelOffsets
    };
}

/**
 * async chunked loader for large files (file/blob)
 * avoids reading the entire file into a single ArrayBuffer.
 */
export async function loadFromGTOLFile(file, onProgress) {
    // 1. read header
    const headerParams = await readHeader(file);
    const { nodeCount, linkCount, totalLabelBytes, version } = headerParams;

    if (version !== 1) throw new Error("Unsupported Version");

    // calculate offsets
    let cursor = 32;
    const sizeFloat = nodeCount * 4;
    const sizeInt = nodeCount * 4; // label offsets
    const sizeLink = linkCount * 4;

    const sections = {};

    function addSec(name, size) {
        sections[name] = { start: cursor, end: cursor + size };
        cursor += size;
    }

    addSec('x', sizeFloat);
    addSec('y', sizeFloat);
    addSec('size', sizeFloat);
    addSec('r', sizeFloat);
    addSec('g', sizeFloat);
    addSec('b', sizeFloat);

    addSec('linkSrc', sizeLink);
    addSec('linkTgt', sizeLink);
    addSec('labelOffsets', sizeInt);
    addSec('labelBytes', totalLabelBytes);

    // 2. read chunks sequentially
    // helper
    async function readSectionFloat(name) {
        const { start, end } = sections[name];
        if (onProgress) onProgress(`Loading ${name}...`);
        const buf = await file.slice(start, end).arrayBuffer();
        return new Float32Array(buf);
    }

    async function readSectionUint32(name) {
        const { start, end } = sections[name];
        if (onProgress) onProgress(`Loading ${name}...`);
        const buf = await file.slice(start, end).arrayBuffer();
        return new Uint32Array(buf);
    }

    async function readSectionUint8(name) {
        const { start, end } = sections[name];
        if (onProgress) onProgress(`Loading ${name}...`);
        const buf = await file.slice(start, end).arrayBuffer();
        return new Uint8Array(buf);
    }


    const x = await readSectionFloat('x');
    const y = await readSectionFloat('y');
    const size = await readSectionFloat('size');
    const r = await readSectionFloat('r');
    const g = await readSectionFloat('g');
    const b = await readSectionFloat('b');

    const linkSrc = await readSectionUint32('linkSrc');
    const linkTgt = await readSectionUint32('linkTgt');
    const labelOffsets = await readSectionUint32('labelOffsets');
    const labelBytes = await readSectionUint8('labelBytes');

    // 3. construct proxy
    const labelsProxy = {
        _decoder: new TextDecoder(),
        _buffer: labelBytes,
        _offsets: labelOffsets,
        length: nodeCount,

        get(i) {
            if (i < 0 || i >= this.length) return "";
            const start = (i === 0) ? 0 : this._offsets[i - 1];
            const end = this._offsets[i];
            return this._decoder.decode(this._buffer.subarray(start, end));
        }
    };

    const proxy = new Proxy(labelsProxy, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                return target.get(parseInt(prop, 10));
            }
            return Reflect.get(target, prop, receiver);
        }
    });

    if (onProgress) onProgress("Done");

    return {
        nodeCount, linkCount,
        x, y, size, r, g, b,
        linkSrc, linkTgt,
        labels: proxy,
        labelBytes,
        labelOffsets
    };
}

async function readHeader(file) {
    const headBuf = await file.slice(0, 32).arrayBuffer();
    const view = new DataView(headBuf);

    // magic
    const m0 = view.getUint8(0);
    const m1 = view.getUint8(1);
    const m2 = view.getUint8(2);
    const m3 = view.getUint8(3);
    const magicStr = String.fromCharCode(m0, m1, m2, m3);

    if (magicStr !== MAGIC) throw new Error("Invalid Magic");

    return {
        version: view.getUint32(4, true),
        nodeCount: view.getUint32(8, true),
        linkCount: view.getUint32(12, true),
        totalLabelBytes: view.getUint32(16, true)
    };
}

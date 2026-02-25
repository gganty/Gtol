/**
 * search.worker.js
 * Handles search operations for massive datasets off the main thread.
 */

let labels = [];
let labelBytes = null;
let labelOffsets = null;
let decoder = null;
let count = 0;

// log proxy
const originalLog = console.log;
console.log = function (...args) {
    // originalLog(...args);
    self.postMessage({ type: 'LOG', level: 'info', args: args.map(String) });
};
const originalError = console.error;
console.error = function (...args) {
    // originalError(...args);
    self.postMessage({ type: 'LOG', level: 'error', args: args.map(String) });
};

self.onmessage = function (e) {
    const { type } = e.data;

    if (type === 'INIT') {
        initCommon(e.data.labelBytes, e.data.labelOffsets, e.data.labels);
    }
    else if (type === 'INIT_FILE') {
        const file = e.data.file;
        console.log("[Worker] Initializing from File:", file.name, file.size);
        loadFile(file).then(({ bytes, offsets }) => {
            initCommon(bytes, offsets, null);
        }).catch(err => {
            console.error("[Worker] File Read Error:", err);
            self.postMessage({ type: 'ERROR', message: "Failed to read file: " + err.message });
        });
    }
    else if (type === 'SEARCH') {
        const { query, isRegex, limit } = e.data;
        const results = [];
        const maxResults = limit || 50;

        if (!query || query.length === 0) {
            self.postMessage({ type: 'RESULTS', results: [] });
            return;
        }

        console.log(`[Worker] Searching for "${query}" (Regex: ${isRegex}) in ${count} items...`);

        try {
            let matches = 0;
            // helper to get text
            const getLabel = (i) => {
                if (labels) return labels[i];
                if (labelBytes) {
                    const start = (i === 0) ? 0 : labelOffsets[i - 1];
                    const end = labelOffsets[i];
                    return decoder.decode(labelBytes.subarray(start, end));
                }
                return "";
            };

            // debug: log first few labels to verify decoding
            for (let k = 0; k < 5 && k < count; k++) {
                console.log(`[Worker] Label ${k}: "${getLabel(k)}"`);
            }

            // regex search
            if (isRegex) {
                const regex = new RegExp(query, 'i');
                for (let i = 0; i < count; i++) {
                    const txt = getLabel(i);
                    if (txt && regex.test(txt)) {
                        results.push({ index: i, label: txt });
                        matches++;
                        if (matches >= maxResults) break;
                    }
                }
            }
            // substring search
            else {
                const lowerQuery = query.toLowerCase();
                for (let i = 0; i < count; i++) {
                    const txt = getLabel(i);
                    if (txt && txt.toLowerCase().includes(lowerQuery)) {
                        results.push({ index: i, label: txt });
                        matches++;
                        if (matches >= maxResults) break;
                    }
                }
            }
        } catch (err) {
            console.error("[Worker] Search Error", err);
            self.postMessage({ type: 'ERROR', message: err.message });
            return;
        }

        self.postMessage({ type: 'RESULTS', results });
    }
};

function initCommon(bytes, offsets, arrayLabels) {
    if (bytes && offsets) {
        labelBytes = bytes;
        labelOffsets = offsets;
        decoder = new TextDecoder();
        labels = null;
        count = labelOffsets.length;
        console.log(`[Worker] Loaded binary labels: ${count}`);
    } else if (arrayLabels) {
        labels = arrayLabels;
        labelBytes = null;
        count = labels.length;
        console.log(`[Worker] Loaded array labels: ${count}`);
    } else {
        self.postMessage({ type: 'ERROR', message: "Invalid INIT data" });
        return;
    }
    self.postMessage({ type: 'INIT_COMPLETE', count: count });
}
async function loadFile(file) {
    // basic GTOL reader for labels only
    // header 32b
    const headBuf = await file.slice(0, 32).arrayBuffer();
    const view = new DataView(headBuf);
    const nodeCount = view.getUint32(8, true);
    const linkCount = view.getUint32(12, true);
    const totalLabelBytes = view.getUint32(16, true);

    let cursor = 32 + (nodeCount * 24) + (linkCount * 8);

    // read label offsets
    console.log("[Worker] Reading Label Offsets at", cursor);
    const offsetsBlob = file.slice(cursor, cursor + nodeCount * 4);
    const offsetsBuf = await offsetsBlob.arrayBuffer();
    const offsets = new Uint32Array(offsetsBuf);

    cursor += nodeCount * 4;

    // read label bytes
    console.log("[Worker] Reading Label Bytes at", cursor, "Size:", totalLabelBytes);
    const bytesBlob = file.slice(cursor, cursor + totalLabelBytes);
    const bytesBuf = await bytesBlob.arrayBuffer();
    const bytes = new Uint8Array(bytesBuf);

    return { bytes, offsets };
}

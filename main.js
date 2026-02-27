import { GraphRenderer } from './engine.js';
import { loadFromGTOL, saveToGTOLParts, loadFromGTOLFile } from './src/io/binary_format.js';

// engine initialization
const canvas = document.getElementById('glcanvas');
const textCanvas = document.getElementById('text-canvas');

let transform = { x: 0, y: 0, k: 0.1 }; // start zoomed out
let renderer;
let currentData = null; // store for reset
let currentFile = null;
let isDragging = false;
let lastX = 0, lastY = 0;

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    textCanvas.width = window.innerWidth * dpr;
    textCanvas.height = window.innerHeight * dpr;

    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    textCanvas.style.width = window.innerWidth + 'px';
    textCanvas.style.height = window.innerHeight + 'px';

    const ctx = textCanvas.getContext('2d');
    ctx.scale(dpr, dpr);

    if (renderer) {
        renderer.setTransform(transform.x, transform.y, transform.k, false);
    }
}
window.addEventListener('resize', resize);

try {
    renderer = new GraphRenderer(canvas);
    renderer.setTextCanvas(textCanvas);
} catch (e) {
    document.getElementById('status').innerText = "WebGL Error: " + e.message;
}

resize();

const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress-bar');
const memStatsEl = document.getElementById('memory-stats');
const dlSection = document.getElementById('section-download');

// --- worker setup ---
const computeWorker = new Worker('./src/compute.worker.js', { type: 'module' });

computeWorker.onmessage = function (e) {
    const { type, stage, progress, result, error } = e.data;

    if (type === 'PROGRESS') {
        statusEl.innerText = stage;
        progressEl.style.width = progress + '%';
    } else if (type === 'COMPLETE') {
        statusEl.innerText = "Rendering...";
        progressEl.style.width = '100%';

        // result is now a component object with zero-copy buffers
        const result = e.data.result;
        console.log(`[Main] Received results. Nodes: ${result.nodeCount}.`);

        const labelsProxy = {
            _decoder: new TextDecoder(),
            _buffer: result.labelBytes,
            _offsets: result.labelOffsets,
            length: result.nodeCount,
            get(i) {
                if (i < 0 || i >= this.length) return "";
                const start = (i === 0) ? 0 : this._offsets[i - 1];
                const end = this._offsets[i];
                const sub = this._buffer.subarray(start, end);
                return this._decoder.decode(sub);
            },
            has(i) {
                if (i < 0 || i >= this.length) return false;
                const start = (i === 0) ? 0 : this._offsets[i - 1];
                const end = this._offsets[i];
                return end > start;
            }
        };

        // wrap in proxy for array-like access
        const proxy = new Proxy(labelsProxy, {
            get(target, prop, receiver) {
                if (typeof prop === 'string' && !isNaN(prop)) {
                    return target.get(parseInt(prop, 10));
                }
                return Reflect.get(target, prop, receiver);
            }
        });

        const data = {
            ...result,
            labels: proxy
        };

        try {
            loadDataToEngine(data);
            statusEl.innerText = `Computed ${data.nodeCount.toLocaleString()} nodes.`;

            dlSection.style.display = 'block';
        } catch (err) {
            console.error(err);
            alert("Error loading computed data: " + err.message);
        }
    } else if (type === 'ERROR') {
        statusEl.innerText = "Error: " + error;
        alert("Computation Error: " + error);
        progressEl.style.width = '0%';
    }
};

// --- compute (web worker) ---
document.getElementById('btn-compute').addEventListener('click', async () => {
    const fileInput = document.getElementById('compute-file-input');
    if (fileInput.files.length === 0) {
        alert("Please select a .nwk file.");
        return;
    }

    statusEl.innerText = "Reading file...";
    progressEl.style.width = '0%';
    dlSection.style.display = 'none';

    const file = fileInput.files[0];
    const text = await file.text(); // read as text for parsing

    statusEl.innerText = "Starting Worker...";

    // post to worker
    computeWorker.postMessage({ type: 'START_JOB', payload: text });
});

// --- load binary (.gtol) ---
document.getElementById('btn-load-file').addEventListener('click', async () => {
    const fileInput = document.getElementById('file-input');
    if (fileInput.files.length === 0) {
        alert("Please select a .gtol file.");
        return;
    }

    const file = fileInput.files[0];
    currentFile = file;
    statusEl.innerText = "Loading binary...";
    progressEl.style.width = '10%';

    try {
        // use chunked loader for safe large file handling
        const data = await loadFromGTOLFile(file, (msg) => {
            statusEl.innerText = msg;
        });

        loadDataToEngine(data);
        statusEl.innerText = `Loaded ${data.nodeCount.toLocaleString()} nodes.`;
        progressEl.style.width = '100%';
        dlSection.style.display = 'block';
    } catch (e) {
        console.error(e);
        alert("Failed to load GTOL: " + e.message);
        statusEl.innerText = "Error loading file";
    }
});
// --- download GTOL ---
document.getElementById('btn-download').addEventListener('click', () => {
    if (!currentData) return;

    statusEl.innerText = "Generating GTOL...";

    try {
        const parts = saveToGTOLParts(currentData);

        const blob = new Blob(parts, { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "graph.gtol";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        statusEl.innerText = "Download started.";
    } catch (e) {
        console.error(e);
        alert("Export failed: " + e.message);
    }
});

function loadDataToEngine(data) {
    console.log("[Main] loadDataToEngine called. Data keys:", Object.keys(data));
    currentData = data;
    renderer.setData(data);

    // init search worker
    const searchMsg = { type: 'INIT' };

    if (currentFile) {
        console.log("[Main] Sending INIT_FILE to Search Worker");
        searchWorker.postMessage({ type: 'INIT_FILE', file: currentFile });
    }
    else if (data.labelBytes && data.labelOffsets) {
        // direct Binary mode (preferred from compute)
        searchMsg.labelBytes = data.labelBytes;
        searchMsg.labelOffsets = data.labelOffsets;
        searchWorker.postMessage(searchMsg);
    } else if (data.labels._buffer && data.labels._offsets) {
        // proxy fallback
        searchMsg.labelBytes = data.labels._buffer;
        searchMsg.labelOffsets = data.labels._offsets;
        searchWorker.postMessage(searchMsg);
    } else {
        // legacy / Test mode
        searchMsg.labels = data.labels;
        searchWorker.postMessage(searchMsg);
    }

    fitToScreen(data);

    // show controls panel
    const pRight = document.getElementById('panel-right');
    pRight.style.display = 'flex';
    setTimeout(() => { pRight.style.opacity = '1'; }, 10);

    // mem stats
    if (window.performance && window.performance.memory) {
        const used = Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024);
        memStatsEl.innerText = `JS Heap: ${used} MB`;
    }
}

function fitToScreen(data) {
    if (!data || !renderer) return;

    if (renderer.minX !== undefined) {
        const w = renderer.maxX - renderer.minX;
        const h = renderer.maxY - renderer.minY;
        const cx = (renderer.minX + renderer.maxX) / 2;
        const cy = (renderer.minY + renderer.maxY) / 2;

        const k = Math.min(window.innerWidth / w, window.innerHeight / h) * 0.9;

        const tx = (window.innerWidth / 2) / k - cx;
        const ty = (window.innerHeight / 2) / k - cy;

        renderer.setTransform(tx, ty, k);
        transform = { x: tx, y: ty, k };
        return;
    }
}

// --- camera controls ---
document.getElementById('btn-reset-cam').addEventListener('click', () => {
    if (currentData) fitToScreen(currentData);
});

document.getElementById('btn-zoom-in').addEventListener('click', () => {
    applyZoom(1.2);
});

document.getElementById('btn-zoom-out').addEventListener('click', () => {
    applyZoom(1 / 1.2);
});

function applyZoom(factor) {
    if (!renderer) return;
    const mx = window.innerWidth / 2;
    const my = window.innerHeight / 2;
    const wx = mx / transform.k - transform.x;
    const wy = my / transform.k - transform.y;
    transform.k *= factor;
    transform.x = mx / transform.k - wx;
    transform.y = my / transform.k - wy;
    renderer.setTransform(transform.x, transform.y, transform.k, false);
}

// --- UI panels ---
const panelLeft = document.getElementById('panel-left');
const toggleLeft = document.getElementById('toggle-left');
const panelRight = document.getElementById('panel-right');
const toggleRight = document.getElementById('toggle-right');

toggleLeft.addEventListener('click', () => {
    panelLeft.classList.toggle('collapsed');
    toggleLeft.innerHTML = panelLeft.classList.contains('collapsed') ? '&rarr;' : '&larr;';
});

toggleRight.addEventListener('click', () => {
    panelRight.classList.toggle('collapsed');
    toggleRight.innerHTML = panelRight.classList.contains('collapsed') ? '&larr;' : '&rarr;';
});

// --- interaction (mouse & wheel) ---
canvas.addEventListener('mousedown', e => {
    isDragging = true;
    lastX = e.clientX; lastY = e.clientY;
});

window.addEventListener('mouseup', () => {
    isDragging = false;
    renderer.setTransform(transform.x, transform.y, transform.k, false);
});

canvas.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    transform.x += dx / transform.k;
    transform.y -= dy / transform.k;
    renderer.setTransform(transform.x, transform.y, transform.k, true);
});

canvas.addEventListener('wheel', e => {
    e.preventDefault();

    // Smooth scrolling using dynamic delta for trackpads & mice
    // Adjust scaling so negative delta zooms in, positive zooms out
    const zoomSpeed = 0.0008;
    const direction = Math.exp(-e.deltaY * zoomSpeed);

    const mx = e.clientX;
    const my = window.innerHeight - e.clientY;
    const wx = mx / transform.k - transform.x;
    const wy = my / transform.k - transform.y;
    transform.k *= direction;
    transform.x = mx / transform.k - wx;
    transform.y = my / transform.k - wy;
    renderer.setTransform(transform.x, transform.y, transform.k, true);
    clearTimeout(window.zoomTimer);
    window.zoomTimer = setTimeout(() => {
        renderer.setTransform(transform.x, transform.y, transform.k, false);
    }, 200);
}, { passive: false });

// --- search system ---
const searchWorker = new Worker('./search.worker.js?v=' + (Date.now() + 1));

const searchInput = document.getElementById('search-input');
const searchRegex = document.getElementById('search-regex');
const searchResults = document.getElementById('search-results');
let searchDebounce = null;

searchInput.addEventListener('input', (e) => {
    const query = e.target.value;
    const isRegex = searchRegex.checked;
    console.log(`[Main] Input: "${query}" (Regex: ${isRegex})`);

    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        console.log("[Main] Posting SEARCH message...");
        searchWorker.postMessage({ type: 'SEARCH', query, isRegex, limit: 50 });
    }, 300);
});

searchWorker.onmessage = function (e) {
    // console.log("[Main] Received message from Search Worker:", e.data.type);
    const { type, results, message, args } = e.data;
    if (type === 'LOG') {
        console.log(`[Worker]`, ...args);
        return;
    }
    if (type === 'RESULTS') {
        console.log(`[Main] Results Length: ${results.length}`);
        if (results.length > 0) {
            console.log("[Main] First Result:", results[0]);
        }
        renderSearchResults(results);
    } else if (type === 'ERROR') {
        console.error("[Search Worker Error]", message);
        statusEl.innerText = "Search Error: " + message;
    } else if (type === 'INIT_COMPLETE') {
        console.log(`[Main] Search Worker Ready (${e.data.count} items)`);
        statusEl.innerText += " Search Ready.";
    };

    function renderSearchResults(results) {
        searchResults.innerHTML = '';

        const updatePosition = () => {
            const rect = searchInput.getBoundingClientRect();
            searchResults.style.left = rect.left + 'px';
            searchResults.style.top = (rect.bottom + 5) + 'px';
            searchResults.style.width = rect.width + 'px';
        };
        updatePosition();
        searchResults.style.display = 'block';

        if (results.length === 0) {
            const div = document.createElement('div');
            div.className = 'no-results';
            div.innerText = "No results available";
            searchResults.appendChild(div);
            return;
        }

        results.forEach(item => {
            const div = document.createElement('div');
            div.className = 'result-item';
            div.textContent = item.label;
            div.addEventListener('click', () => {
                if (currentData) {
                    const x = currentData.x[item.index];
                    const y = currentData.y[item.index];
                    flyTo(x, y);
                    searchResults.style.display = 'none';
                }
            });
            searchResults.appendChild(div);
        });
    }

    function flyTo(targetX, targetY) {
        if (!renderer) return;

        // current state
        const startK = transform.k;
        const startX = (window.innerWidth / 2) / startK - transform.x;
        const startY = (window.innerHeight / 2) / startK - transform.y;

        // target state
        const endK = Math.max(startK, 1.5);

        // distance calculation
        const dx = targetX - startX;
        const dy = targetY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const w = window.innerWidth;
        let midK = w / (dist * 1.5 + w / startK);

        midK = Math.min(midK, startK, endK);
        midK = Math.max(midK, 0.002);

        const duration = Math.min(4000, 1000 * Math.log(dist / 500 + 2));
        const startTime = performance.now();

        const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        function animate(now) {
            const elapsed = now - startTime;
            if (elapsed >= duration) {
                transform.k = endK;
                transform.x = (window.innerWidth / 2) / endK - targetX;
                transform.y = (window.innerHeight / 2) / endK - targetY;
                renderer.setTransform(transform.x, transform.y, transform.k, false);
                return;
            }

            const p = elapsed / duration;
            const t = ease(p);

            const wx = startX + dx * t;
            const wy = startY + dy * t;

            const logStart = Math.log(startK);
            const logEnd = Math.log(endK);
            const currentLogBase = logStart + (logEnd - logStart) * t;

            const logMid = Math.log(midK);
            const logBaseMid = 0.5 * (logStart + logEnd);
            const archHeight = logMid - logBaseMid;

            const currentLog = currentLogBase + archHeight * Math.sin(Math.PI * t);

            const k = Math.exp(currentLog);

            transform.k = k;
            transform.x = (window.innerWidth / 2) / k - wx;
            transform.y = (window.innerHeight / 2) / k - wy;

            renderer.setTransform(transform.x, transform.y, transform.k, true);
            requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
    }

    searchInput.addEventListener('input', () => {
        const query = searchInput.value;
        clearTimeout(searchDebounce);
        if (query.length < 2) {
            searchResults.style.display = 'none';
            return;
        }
        searchDebounce = setTimeout(() => {
            searchWorker.postMessage({
                type: 'SEARCH',
                query: query,
                isRegex: searchRegex.checked,
                limit: 200
            });
        }, 300);
    });

    document.addEventListener('click', (e) => {
        if (!document.getElementById('search-container').contains(e.target)) {
            searchResults.style.display = 'none';
        }
    });
}

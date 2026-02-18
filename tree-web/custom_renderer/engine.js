import { POINT_VS, POINT_FS, LINE_VS, LINE_FS } from './shaders.js';

export class GraphRenderer {
    /**
     * WebGL-based renderer for massive graphs.
     * Uses Point Sprites for nodes and Lines for edges.
     * Implements spatial hashing and dynamic LOD for performance.
     * @param {HTMLCanvasElement} canvas - The WebGL canvas element.
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', {
            antialias: false,
            depth: false,
            alpha: false
        });

        if (!this.gl) throw new Error("WebGL not supported");

        // Initialization of programs and variables
        this.program = this.createProgram(POINT_VS, POINT_FS);
        this.programLine = this.createProgram(LINE_VS, LINE_FS);

        // Attributes & Uniforms (Points)
        this.locPos = this.gl.getAttribLocation(this.program, 'a_position');
        this.locSize = this.gl.getAttribLocation(this.program, 'a_size');
        this.locColor = this.gl.getAttribLocation(this.program, 'a_color');
        this.locRes = this.gl.getUniformLocation(this.program, 'u_resolution');
        this.locTrans = this.gl.getUniformLocation(this.program, 'u_transform');
        this.locIsLine = this.gl.getUniformLocation(this.program, 'u_is_line');

        // Attributes & Uniforms (Lines)
        this.locLinePos = this.gl.getAttribLocation(this.programLine, 'a_position');
        this.locLineRes = this.gl.getUniformLocation(this.programLine, 'u_resolution');
        this.locLineTrans = this.gl.getUniformLocation(this.programLine, 'u_transform');

        // Buffers
        this.bufPos = this.gl.createBuffer();
        this.bufSize = this.gl.createBuffer();
        this.bufColor = this.gl.createBuffer();
        this.bufLinkPos = null;

        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // Extension for indices > 65535
        this.ext = this.gl.getExtension('OES_element_index_uint');

        this.ctx = null;
        this.transform = { x: 0, y: 0, k: 1.0 };
        this.isInteracting = false;
        this.pendingFrame = null;
        this.dpr = window.devicePixelRatio || 1;
    }

    setTextCanvas(canvas) {
        this.ctx = canvas.getContext('2d');
    }

    /**
     * Creates and links a WebGL program from vertex and fragment shaders.
     * @param {string} vsSource - Vertex shader source code.
     * @param {string} fsSource - Fragment shader source code.
     * @returns {WebGLProgram} The linked WebGL program.
     */
    createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        return program;
    }

    /**
     * Compiles a single shader.
     * @param {number} type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
     * @param {string} source - Shader source code.
     * @returns {WebGLShader} The compiled shader.
     */
    compileShader(type, source) {
        const gl = this.gl;
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(s));
            throw new Error("Shader Compile Error");
        }
        return s;
    }

    /**
     * Uploads graph data to GPU buffers.
     * Prepares spatial alignment and sorting for efficient rendering.
     * @param {Object} data - Object containing typed arrays of node/link data.
     */
    /**
     * Uploads graph data to GPU buffers.
     * Prepares spatial alignment and sorting for efficient rendering.
     * @param {Object} data - Object containing typed arrays of node/link data.
     */
    setData(data) {
        const gl = this.gl;
        this.nodeCount = data.nodeCount;
        this.linkCount = data.linkCount;

        // Save references for labels (original order)
        this.dataX = data.x;
        this.dataY = data.y;
        this.dataLabels = data.labels;
        this.dataSize = data.size;

        // 1. Calculate bounds & center
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < this.nodeCount; i++) {
            const x = data.x[i]; const y = data.y[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }

        // Padding & Center
        const padX = (maxX - minX) * 0.01;
        const padY = (maxY - minY) * 0.01;
        this.minX = minX - padX;
        this.maxX = maxX + padX;
        this.minY = minY - padY;
        this.maxY = maxY + padY;

        this.centerX = (this.minX + this.maxX) / 2;
        this.centerY = (this.minY + this.maxY) / 2;

        const width = this.maxX - this.minX;
        const height = this.maxY - this.minY;

        // 2. Setup grid
        console.time("AdaptiveGrid");
        const TARGET_CHUNKS = 4096;
        const aspect = width / height;

        let nRows = Math.sqrt(TARGET_CHUNKS / aspect);
        let nCols = nRows * aspect;

        if (nRows < 1) nRows = 1; if (nCols < 1) nCols = 1;
        nRows = Math.ceil(nRows); nCols = Math.ceil(nCols);

        this.grid = {
            minX: this.minX, maxX: this.maxX, minY: this.minY, maxY: this.maxY, width, height,
            nCols, nRows,
            chunks: new Array(nCols * nRows)
        };

        // Helpers
        const getChunkIdx = (x, y) => {
            let cx = Math.floor(((x - this.minX) / width) * nCols);
            let cy = Math.floor(((y - this.minY) / height) * nRows);
            if (cx >= nCols) cx = nCols - 1; if (cx < 0) cx = 0;
            if (cy >= nRows) cy = nRows - 1; if (cy < 0) cy = 0;
            return cy * nCols + cx;
        };

        // 3. Count
        const counts = new Uint32Array(nCols * nRows);
        for (let i = 0; i < this.nodeCount; i++) {
            counts[getChunkIdx(data.x[i], data.y[i])]++;
        }

        // 4. Initialize chunks
        const offsets = new Uint32Array(nCols * nRows);
        let accum = 0;
        for (let i = 0; i < counts.length; i++) {
            offsets[i] = accum;

            // Chunk bounds
            const cx = i % nCols;
            const cy = Math.floor(i / nCols);

            const chunkX1 = this.minX + cx * (width / nCols);
            const chunkY1 = this.minY + cy * (height / nRows);

            this.grid.chunks[i] = {
                id: i,
                startIndex: accum, // Index in the GPU arrays
                count: counts[i],
                x1: chunkX1,
                y1: chunkY1,
                x2: this.minX + (cx + 1) * (width / nCols),
                y2: chunkY1 + (height / nRows),

                // Edge Bounding Box (initially invalid)
                linkMinX: Infinity,
                linkMaxX: -Infinity,
                linkMinY: Infinity,
                linkMaxY: -Infinity,
                linkCount: 0,
                linkStartIndex: 0
            };

            accum += counts[i];
        }

        // 5. Sort indices
        const sortedIndices = new Uint32Array(this.nodeCount);
        const currOffsets = new Uint32Array(offsets);

        for (let i = 0; i < this.nodeCount; i++) {
            const c = getChunkIdx(data.x[i], data.y[i]);
            sortedIndices[currOffsets[c]++] = i;
        }

        // 6. Sort chunks by size
        for (const chunk of this.grid.chunks) {
            if (chunk.count === 0) continue;
            const start = chunk.startIndex;
            const end = chunk.startIndex + chunk.count;
            const sub = sortedIndices.subarray(start, end);
            sub.sort((a, b) => data.size[b] - data.size[a]);
        }

        // --- Process edges ---
        if (this.linkCount > 0) {
            // A. Count edges per chunk
            // We use the SOURCE node to determine which chunk "owns" the edge.
            const linkCounts = new Uint32Array(nCols * nRows);
            for (let i = 0; i < this.linkCount; i++) {
                const s = data.linkSrc[i];
                // Lookup chunk of source node
                linkCounts[getChunkIdx(data.x[s], data.y[s])]++;
            }

            // B. Calculate offsets for links
            const linkOffsets = new Uint32Array(nCols * nRows);
            let linkAccum = 0;
            for (let i = 0; i < linkCounts.length; i++) {
                linkOffsets[i] = linkAccum;

                // Store metadata in chunk
                if (this.grid.chunks[i]) {
                    this.grid.chunks[i].linkStartIndex = linkAccum;
                    this.grid.chunks[i].linkCount = linkCounts[i];
                }

                linkAccum += linkCounts[i];
            }

            // C. Sort links
            this.bufLinkPos = gl.createBuffer();
            const linkPos = new Float32Array(this.linkCount * 4);
            const currLinkOffsets = new Uint32Array(linkOffsets);

            for (let i = 0; i < this.linkCount; i++) {
                const s = data.linkSrc[i];
                const t = data.linkTgt[i];

                // Identify Chunk
                const sx = data.x[s];
                const sy = data.y[s];
                const tx = data.x[t];
                const ty = data.y[t];

                const cIdx = getChunkIdx(sx, sy);
                const chunk = this.grid.chunks[cIdx];

                // Destination Index in Sorted Buffer
                const ptr = currLinkOffsets[cIdx]++;
                const offset = ptr * 4;

                // Store relative to chunk origin
                // x1, y1 (Source)
                linkPos[offset] = sx - chunk.x1;
                linkPos[offset + 1] = sy - chunk.y1;

                // x2, y2 (Target)
                linkPos[offset + 2] = tx - chunk.x1;
                linkPos[offset + 3] = ty - chunk.y1;

                // Update Chunk Edge Bounds (Include both Source and Target)
                if (sx < chunk.linkMinX) chunk.linkMinX = sx;
                if (sx > chunk.linkMaxX) chunk.linkMaxX = sx;
                if (sy < chunk.linkMinY) chunk.linkMinY = sy;
                if (sy > chunk.linkMaxY) chunk.linkMaxY = sy;

                if (tx < chunk.linkMinX) chunk.linkMinX = tx;
                if (tx > chunk.linkMaxX) chunk.linkMaxX = tx;
                if (ty < chunk.linkMinY) chunk.linkMinY = ty;
                if (ty > chunk.linkMaxY) chunk.linkMaxY = ty;
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.bufferData(gl.ARRAY_BUFFER, linkPos, gl.STATIC_DRAW);
        }

        // 7. Generate GPU buffers for nodes
        // We recreate data arrays in the sorted order.
        const posData = new Float32Array(this.nodeCount * 2);
        const colData = new Float32Array(this.nodeCount * 3);
        const sizeData = new Float32Array(this.nodeCount); // bufSize

        for (let i = 0; i < this.nodeCount; i++) {
            const originalIdx = sortedIndices[i];

            // Optimized lookup
            const ox = data.x[originalIdx];
            const oy = data.y[originalIdx];

            const cIdx = getChunkIdx(ox, oy);
            const chunk = this.grid.chunks[cIdx];

            // Chunk relative position
            // pos = absolute - chunkOrigin
            posData[i * 2] = ox - chunk.x1;
            posData[i * 2 + 1] = oy - chunk.y1;

            // Copy other props
            sizeData[i] = data.size[originalIdx];
            colData[i * 3] = data.r[originalIdx];
            colData[i * 3 + 1] = data.g[originalIdx];
            colData[i * 3 + 2] = data.b[originalIdx];
        }

        // Upload Points
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.bufferData(gl.ARRAY_BUFFER, posData, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.bufferData(gl.ARRAY_BUFFER, sizeData, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.bufferData(gl.ARRAY_BUFFER, colData, gl.STATIC_DRAW);

        this.sortedIndices = sortedIndices; // Expose for Labels
        console.timeEnd("AdaptiveGrid");
    }

    /**
     * Main render loop.
     * clears screen, calculates visible chunks, and issues draw calls.
     */
    render() {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (!this.grid) return; // Not loaded

        // Update DPR in case it changed (e.g. window move to other monitor)
        this.dpr = window.devicePixelRatio || 1;

        const { x: tx, y: ty, k } = this.transform;

        // Effective zoom for physical pixels
        // WebGL needs to output to physical coordinates (-1..1 maps to 0..Width*DPR)
        // If we use physical width for Resolution uniform, we must scale zoom by DPR.
        const physK = k * this.dpr;

        // Offset transform by graph center since GPU buffers are centered
        const glTx = tx + (this.centerX || 0);
        const glTy = ty + (this.centerY || 0);

        // --- LOD logic ---
        // Use physical W/H for uniform calculation
        // But for LOD (world bounds), using physical W + physical K cancels out to same logic.

        // 1. World view
        const screenMinX = -w; const screenMaxX = 2 * w;
        const screenMinY = -h; const screenMaxY = 2 * h;

        const worldMinX = screenMinX / k - tx;
        const worldMaxX = screenMaxX / k - tx;
        const worldMinY = (h - screenMaxY) / k - ty;
        const worldMaxY = (h - screenMinY) / k - ty;

        // 2. Visible chunks
        const visibleNodeChunks = [];
        const visibleLinkChunks = [];

        let potentialPoints = 0;

        for (const chunk of this.grid.chunks) {
            // A. Check node visibility
            let isNodeVisible = false;

            if (chunk.count > 0 &&
                !(chunk.x2 < worldMinX || chunk.x1 > worldMaxX ||
                    chunk.y2 < worldMinY || chunk.y1 > worldMaxY)) {

                visibleNodeChunks.push(chunk);
                potentialPoints += chunk.count;
                isNodeVisible = true;
            }

            // B. Check link visibility
            if (chunk.linkCount > 0) {
                if (isNodeVisible) {
                    visibleLinkChunks.push(chunk);
                } else {
                    // Extended check
                    if (!(chunk.linkMaxX < worldMinX || chunk.linkMinX > worldMaxX ||
                        chunk.linkMaxY < worldMinY || chunk.linkMinY > worldMaxY)) {
                        visibleLinkChunks.push(chunk);
                    }
                }
            }
        }

        // 3. Draw count
        const MAX_VERTS = 1000000; // budget

        let lodRatio = 1.0;
        if (potentialPoints > MAX_VERTS) {
            lodRatio = MAX_VERTS / potentialPoints;
        }

        // 4. Draw

        // Pass 1: Lines
        if (potentialPoints < 500000 && this.bufLinkPos) {
            gl.useProgram(this.programLine);
            gl.uniform2f(this.locLineRes, w, h);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.vertexAttribPointer(this.locLinePos, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.locLinePos);

            for (const chunk of visibleLinkChunks) {
                if (!chunk.linkCount) continue;

                // Chunk Relative Translation for Lines
                // (Using same chunk origin as points)
                const chunkTx = tx + chunk.x1;
                const chunkTy = ty + chunk.y1;

                gl.uniform3f(this.locLineTrans, chunkTx, chunkTy, physK);
                gl.drawArrays(gl.LINES, chunk.linkStartIndex * 2, chunk.linkCount * 2);
            }
        }

        // Pass 2: Points
        gl.useProgram(this.program);
        gl.uniform2f(this.locRes, w, h);
        gl.uniform1i(this.locIsLine, 0);

        // Bind buffers
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locPos);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.vertexAttribPointer(this.locSize, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locSize);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.vertexAttribPointer(this.locColor, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locColor);

        // We use drawArrays, no index buffer needed for points now

        for (const chunk of visibleNodeChunks) {
            const drawCount = Math.ceil(chunk.count * lodRatio);
            if (drawCount > 0) {
                // Chunk relative translation
                // ScreenPos = (LocalX + ChunkX + transX) * k

                const chunkTx = tx + chunk.x1;
                const chunkTy = ty + chunk.y1;

                gl.uniform3f(this.locTrans, chunkTx, chunkTy, physK);

                // Draw range from sorted buffers
                gl.drawArrays(gl.POINTS, chunk.startIndex, drawCount);
            }
        }

        // 5. Labels
        if (this.ctx) {
            this.renderLabels(w / this.dpr, h / this.dpr, visibleNodeChunks, lodRatio);
        }
    }

    /**
     * Renders text labels on the 2D overlay canvas.
     * Uses a hybrid strategy: Global importance (size) for zoomed-out views, 
     * and spatial scanning for zoomed-in views.
     * @param {number} w - Canvas width.
     * @param {number} h - Canvas height.
     * @param {Array} visibleChunks - List of currently visible grid chunks.
     * @param {number} lodRatio - Level of Detail ratio (used to switch strategies).
     */
    renderLabels(w, h, visibleChunks, lodRatio) {
        const ctx = this.ctx;
        // Since we scale ctx by DPR in index.html, we clear logical area
        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = "white";
        ctx.font = "12px sans-serif";
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.textAlign = "center";

        if (!this.sortedIndices) return;

        const occupied = new Set();
        let drawn = 0;
        const MAX_LABELS = 600;

        // Candidate collection
        const candidates = [];

        // Target sorting pool
        const targetCandidates = 2000;
        const perChunk = Math.ceil(targetCandidates / (visibleChunks.length || 1));

        for (const chunk of visibleChunks) {
            // chunk.indices are already sorted by size
            const count = Math.min(chunk.count, perChunk);
            const start = chunk.startIndex;
            const end = chunk.startIndex + chunk.count;

            // Collect top 'count' nodes
            for (let i = start; i < end && i < start + count; i++) {
                candidates.push(this.sortedIndices[i]);
            }
        }

        // Sort candidates globally by size
        candidates.sort((a, b) => this.dataSize[b] - this.dataSize[a]);

        // Draw
        for (const idx of candidates) {
            if (drawn >= MAX_LABELS) break;

            const px = (this.dataX[idx] + this.transform.x) * this.transform.k;
            const py = (this.dataY[idx] + this.transform.y) * this.transform.k;
            const sx = px;
            const sy = h - py;

            // Simple skip if way off screen
            // Use larger margin to prevent pop-in at edges
            if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100) continue;

            const gx = Math.floor(sx / 120);
            const gy = Math.floor(sy / 20);
            const key = `${gx},${gy}`;

            if (occupied.has(key)) continue;

            const text = this.dataLabels[idx];
            ctx.strokeText(text, sx, sy - 5);
            ctx.fillText(text, sx, sy - 5);

            occupied.add(key);
            drawn++;
        }
    }

    /**
     * Updates the camera transform (pan/zoom) and requests a new frame.
     * @param {number} x - Translation X.
     * @param {number} y - Translation Y.
     * @param {number} k - Zoom scale.
     * @param {boolean} isInteracting - Whether the user is currently dragging/zooming (for lower LOD).
     */
    setTransform(x, y, k, isInteracting = false) {
        this.transform = { x, y, k };
        this.isInteracting = isInteracting;

        if (!this.pendingFrame) {
            this.pendingFrame = requestAnimationFrame(() => {
                this.pendingFrame = null;
                this.render();
            });
        }
    }


}
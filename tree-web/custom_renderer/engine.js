import { POINT_VS, POINT_FS, LINE_VS, LINE_FS } from './shaders.js';

export class GraphRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', {
            antialias: false,
            depth: false,
            alpha: false
        });

        if (!this.gl) throw new Error("WebGL not supported");

        // --- Initialization of programs and variables ---
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

        // Extension for indices > 65535 (critical for large graphs)
        this.ext = this.gl.getExtension('OES_element_index_uint');

        this.ctx = null;
        this.transform = { x: 0, y: 0, k: 1.0 };
        this.isInteracting = false;
        this.pendingFrame = null;
    }

    setTextCanvas(canvas) {
        this.ctx = canvas.getContext('2d');
    }

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

    setData(data) {
        const gl = this.gl;
        this.nodeCount = data.nodeCount;
        this.linkCount = data.linkCount;

        // Save references for Labels
        this.dataX = data.x;
        this.dataY = data.y;
        this.dataLabels = data.labels;
        this.dataSize = data.size;

        // 1. Positions
        const posData = new Float32Array(this.nodeCount * 2);
        for (let i = 0; i < this.nodeCount; i++) {
            posData[i * 2] = data.x[i];
            posData[i * 2 + 1] = data.y[i];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.bufferData(gl.ARRAY_BUFFER, posData, gl.STATIC_DRAW);

        // 2. Sizes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.bufferData(gl.ARRAY_BUFFER, data.size, gl.STATIC_DRAW);

        // 3. Colors
        const colData = new Float32Array(this.nodeCount * 3);
        for (let i = 0; i < this.nodeCount; i++) {
            colData[i * 3] = data.r[i];
            colData[i * 3 + 1] = data.g[i];
            colData[i * 3 + 2] = data.b[i];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.bufferData(gl.ARRAY_BUFFER, colData, gl.STATIC_DRAW);

        // 4. Links
        if (data.linkCount > 0) {
            const linkPos = new Float32Array(data.linkCount * 4);
            let ptr = 0;
            for (let i = 0; i < data.linkCount; i++) {
                const s = data.linkSrc[i];
                const t = data.linkTgt[i];
                linkPos[ptr++] = data.x[s];
                linkPos[ptr++] = data.y[s];
                linkPos[ptr++] = data.x[t];
                linkPos[ptr++] = data.y[t];
            }
            this.bufLinkPos = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.bufferData(gl.ARRAY_BUFFER, linkPos, gl.STATIC_DRAW);
        }

        console.time("AdaptiveGrid");

        // A. Bounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < this.nodeCount; i++) {
            const x = data.x[i]; const y = data.y[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        // Small padding
        const padX = (maxX - minX) * 0.01;
        const padY = (maxY - minY) * 0.01;
        minX -= padX; maxX += padX; minY -= padY; maxY += padY;

        const width = maxX - minX;
        const height = maxY - minY;

        // B. Calculate Dynamic Grid Resolution based on Aspect Ratio
        // Target ~4096 chunks for fine-grained culling and deep zoom support.
        const TARGET_CHUNKS = 4096;
        const aspect = width / height;

        // cols * rows = TARGET
        // cols / rows = aspect -> cols = rows * aspect
        // rows * aspect * rows = TARGET -> rows^2 = TARGET / aspect
        let nRows = Math.sqrt(TARGET_CHUNKS / aspect);
        let nCols = nRows * aspect;

        // Clamp & Integerize
        if (nRows < 1) nRows = 1;
        if (nCols < 1) nCols = 1;
        nRows = Math.ceil(nRows);
        nCols = Math.ceil(nCols);

        this.grid = {
            minX, maxX, minY, maxY, width, height,
            nCols, nRows,
            chunks: new Array(nCols * nRows)
        };

        // C. Assign Nodes to Chunks
        // Helpers
        const getChunkIdx = (x, y) => {
            let cx = Math.floor(((x - minX) / width) * nCols);
            let cy = Math.floor(((y - minY) / height) * nRows);
            if (cx >= nCols) cx = nCols - 1; if (cx < 0) cx = 0;
            if (cy >= nRows) cy = nRows - 1; if (cy < 0) cy = 0;
            return cy * nCols + cx;
        };

        // 1. Count
        const counts = new Uint32Array(nCols * nRows);
        for (let i = 0; i < this.nodeCount; i++) {
            counts[getChunkIdx(data.x[i], data.y[i])]++;
        }

        // 2. Offsets (for temporary sorting bucket)
        const offsets = new Uint32Array(nCols * nRows);
        let accum = 0;
        for (let i = 0; i < counts.length; i++) {
            offsets[i] = accum;
            accum += counts[i];

            // Init chunk metadata
            this.grid.chunks[i] = {
                id: i,
                offset: offsets[i], // Offset in the sorted index buffer
                count: counts[i],
                // Store spatial bounds of chunk for culling
                x1: minX + (i % nCols) * (width / nCols),
                x2: minX + (i % nCols + 1) * (width / nCols),
                y1: minY + Math.floor(i / nCols) * (height / nRows),
                y2: minY + Math.floor(i / nCols + 1) * (height / nRows)
            };
        }

        // 3. Fill Indices (Unsorted first, but grouped by chunk)
        // We will then sort WITHIN each chunk range.
        const sortedIndices = new Uint32Array(this.nodeCount);
        const currOffsets = new Uint32Array(offsets);

        // Pre-fill grouping
        for (let i = 0; i < this.nodeCount; i++) {
            const c = getChunkIdx(data.x[i], data.y[i]);
            sortedIndices[currOffsets[c]++] = i;
        }

        // 4. Sort Each Chunk by Importance (Size)
        // This is crucial for Linear LOD. The first N indices of a chunk ARE the most important.
        for (let i = 0; i < this.grid.chunks.length; i++) {
            const chunk = this.grid.chunks[i];
            if (chunk.count === 0) continue;

            const start = chunk.offset;
            const end = chunk.offset + chunk.count;

            // Subarray view
            const sub = sortedIndices.subarray(start, end);
            sub.sort((a, b) => data.size[b] - data.size[a]);
        }

        // Upload to Index Buffer
        this.bufSpatial = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.bufSpatial);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, sortedIndices, this.gl.STATIC_DRAW);

        this.sortedIndices = sortedIndices; // Expose for Labels
        console.timeEnd("AdaptiveGrid");
    }

    render() {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.04, 0.06, 0.08, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (!this.grid) return; // Not loaded

        const { x: tx, y: ty, k } = this.transform;

        // 1. Calculate World View
        const screenMinX = -w; const screenMaxX = 2 * w;
        const screenMinY = -h; const screenMaxY = 2 * h;

        const worldMinX = screenMinX / k - tx;
        const worldMaxX = screenMaxX / k - tx;
        const worldMinY = (h - screenMaxY) / k - ty;
        const worldMaxY = (h - screenMinY) / k - ty;

        // 2. Determine Visible Chunks
        const visibleChunks = [];
        let potentialPoints = 0;

        for (const chunk of this.grid.chunks) {
            if (chunk.count === 0) continue;
            if (chunk.x2 < worldMinX || chunk.x1 > worldMaxX ||
                chunk.y2 < worldMinY || chunk.y1 > worldMaxY) {
                continue;
            }
            visibleChunks.push(chunk);
            potentialPoints += chunk.count;
        }

        // 3. Dynamic Draw Count Calculation
        const MAX_VERTS = 1000000; // Global Budget

        let lodRatio = 1.0;
        if (potentialPoints > MAX_VERTS) {
            lodRatio = MAX_VERTS / potentialPoints;
        }

        // 4. Draw
        // Links
        if (potentialPoints < 500000 && this.bufLinkPos) {
            gl.useProgram(this.programLine);
            gl.uniform2f(this.locLineRes, w, h);
            gl.uniform3f(this.locLineTrans, tx, ty, k);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.vertexAttribPointer(this.locLinePos, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.locLinePos);
            gl.drawArrays(gl.LINES, 0, this.linkCount * 2);
        }

        // Points
        gl.useProgram(this.program);
        gl.uniform2f(this.locRes, w, h);
        gl.uniform3f(this.locTrans, tx, ty, k);
        gl.uniform1i(this.locIsLine, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locPos);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.vertexAttribPointer(this.locSize, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locSize);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.vertexAttribPointer(this.locColor, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locColor);

        // Bind Sorted Index Buffer
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufSpatial);

        for (const chunk of visibleChunks) {
            const drawCount = Math.ceil(chunk.count * lodRatio);

            if (drawCount > 0) {
                gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, chunk.offset * 4);
            }
        }

        // 5. Labels
        if (this.ctx) {
            this.renderLabels(w, h, visibleChunks, lodRatio);
        }
    }

    renderLabels(w, h, visibleChunks, lodRatio) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "white";
        ctx.font = "500 10px sans-serif";
        ctx.textAlign = "center";

        const occupied = new Set();
        let drawn = 0;
        const MAX_LABELS = 400;

        // FIX: Sort chunks by distance to center of screen.
        // Currently we iterate bottom-to-top (index order), so we run out of label budget
        // at the bottom, leaving the top empty.
        // By sorting Center-Out, we prioritize the middle of the screen.
        const centerX = (this.transform.x * -1) + (w / 2 / this.transform.k);
        const centerY = (this.transform.y * -1) + (h / 2 / this.transform.k);

        // Sort copy relative to center
        // We modify 'visibleChunks' array in place or copy?
        // It's created new in render(), so it's safe to sort.
        visibleChunks.sort((a, b) => {
            const acx = (a.x1 + a.x2) / 2;
            const acy = (a.y1 + a.y2) / 2;
            const bcx = (b.x1 + b.x2) / 2;
            const bcy = (b.y1 + b.y2) / 2;

            const distA = (acx - centerX) ** 2 + (acy - centerY) ** 2;
            const distB = (bcx - centerX) ** 2 + (bcy - centerY) ** 2;
            return distA - distB;
        });

        // Global scan limiter
        let totalScans = 0;
        const GLOBAL_SCAN_LIMIT = 200000;

        for (const chunk of visibleChunks) {
            if (drawn >= MAX_LABELS) break;
            if (totalScans >= GLOBAL_SCAN_LIMIT) break;

            const start = chunk.offset;
            const end = chunk.offset + chunk.count;

            const scanDepth = Math.max(100, Math.ceil(20000 * lodRatio));

            let checked = 0;

            for (let i = start; i < end; i++) {
                const idx = this.sortedIndices[i];
                checked++;
                totalScans++;

                if (checked > scanDepth) break;
                if (totalScans > GLOBAL_SCAN_LIMIT) break;

                // Project
                const px = (this.dataX[idx] + this.transform.x) * this.transform.k;
                const py = (this.dataY[idx] + this.transform.y) * this.transform.k;
                const sx = px;
                const sy = h - py;

                // Strict bounds
                if (sx < -10 || sx > w + 10 || sy < -10 || sy > h + 10) continue;

                // Collision (Increased Spacing 150x40 to fix "dense clutter")
                const gx = Math.floor(sx / 150);
                const gy = Math.floor(sy / 40);
                const key = `${gx},${gy}`;

                if (occupied.has(key)) continue;

                ctx.fillText(this.dataLabels[idx], sx, sy - 5);
                occupied.add(key);
                drawn++;
                if (drawn >= MAX_LABELS) return;
            }
        }
    }

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
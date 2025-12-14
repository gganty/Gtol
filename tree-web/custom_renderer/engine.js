import { POINT_VS, POINT_FS, LINE_VS, LINE_FS } from './shaders.js';

export class GraphRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', {
            antialias: false,
            depth: false,
            alpha: false
        });

        if (!this.gl) {
            throw new Error("WebGL not supported");
        }

        // --- POINT PROGRAM ---
        this.program = this.createProgram(POINT_VS, POINT_FS);
        this.locPos = this.gl.getAttribLocation(this.program, 'a_position');
        this.locSize = this.gl.getAttribLocation(this.program, 'a_size');
        this.locColor = this.gl.getAttribLocation(this.program, 'a_color');
        this.locRes = this.gl.getUniformLocation(this.program, 'u_resolution');
        this.locTrans = this.gl.getUniformLocation(this.program, 'u_transform');
        this.locIsLine = this.gl.getUniformLocation(this.program, 'u_is_line');

        // --- LINE PROGRAM ---
        this.programLine = this.createProgram(LINE_VS, LINE_FS);
        this.locLinePos = this.gl.getAttribLocation(this.programLine, 'a_position');
        this.locLineRes = this.gl.getUniformLocation(this.programLine, 'u_resolution');
        this.locLineTrans = this.gl.getUniformLocation(this.programLine, 'u_transform');

        // Buffers
        this.nodeCount = 0;
        this.linkCount = 0;
        this.bufPos = this.gl.createBuffer();
        this.bufSize = this.gl.createBuffer();
        this.bufColor = this.gl.createBuffer();
        this.bufLink = this.gl.createBuffer(); // For Lines
        // this.bufLinkPos is created in setData

        // Transform (x, y, scale)
        this.transform = { x: 0, y: 0, k: 1.0 };

        // Quality
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // Extensions (Required for Lines with >65k indices)
        this.ext = this.gl.getExtension('OES_element_index_uint');

        // Text Context
        this.ctx = null;
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

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(program));
            throw new Error("Program Link Error");
        }
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

        // Save raw data references for labels
        this.dataX = data.x;
        this.dataY = data.y;
        this.dataLabels = data.labels;
        this.dataSize = data.size;

        // 1. Position (x, y)
        const posData = new Float32Array(this.nodeCount * 2);
        for (let i = 0; i < this.nodeCount; i++) {
            posData[i * 2] = data.x[i];
            posData[i * 2 + 1] = data.y[i];
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.bufferData(gl.ARRAY_BUFFER, posData, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.bufferData(gl.ARRAY_BUFFER, data.size, gl.STATIC_DRAW);

        // Color
        const colData = new Float32Array(this.nodeCount * 3);

        console.log("SetData: Colors Available?", !!data.r, !!data.g, !!data.b);
        if (data.r) console.log("SetData: First Color R:", data.r[0]);

        if (data.r && data.g && data.b) {
            // Fast Path: Loader already parsed colors to Floats
            console.time("InterleaveColor");
            for (let i = 0; i < this.nodeCount; i++) {
                colData[i * 3] = data.r[i];
                colData[i * 3 + 1] = data.g[i];
                colData[i * 3 + 2] = data.b[i];
            }
            console.timeEnd("InterleaveColor");
        } else {
            // Fallback: Parse strings (Legacy)
            const parseColor = (c) => {
                if (!c) return [0.5, 0.5, 0.5];
                if (typeof c === 'string') {
                    if (c.startsWith('#')) {
                        let r = parseInt(c.substr(1, 2), 16) / 255;
                        let g = parseInt(c.substr(3, 2), 16) / 255;
                        let b = parseInt(c.substr(5, 2), 16) / 255;
                        return [r, g, b];
                    }
                }
                return [0.5, 0.5, 0.5];
            };

            for (let i = 0; i < this.nodeCount; i++) {
                const c = data.colors ? data.colors[i] : null;
                const [r, g, b] = parseColor(c);
                colData[i * 3] = r;
                colData[i * 3 + 1] = g;
                colData[i * 3 + 2] = b;
            }
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.bufferData(gl.ARRAY_BUFFER, colData, gl.STATIC_DRAW);

        // Links
        if (data.linkSrc && data.linkCount > 0) {
            console.log("SetData: Processing Links. NodeCount:", this.nodeCount, "LinkCount:", data.linkCount);

            // Build Explicit Geometry (x1,y1, x2,y2) for drawArrays
            const linkPos = new Float32Array(data.linkCount * 2 * 2); // 2 verts * 2 coords
            let ptr = 0;
            for (let i = 0; i < data.linkCount; i++) {
                const s = data.linkSrc[i];
                const t = data.linkTgt[i];
                // Lookup coords
                linkPos[ptr++] = data.x[s];
                linkPos[ptr++] = data.y[s];
                linkPos[ptr++] = data.x[t];
                linkPos[ptr++] = data.y[t];
            }

            if (!this.bufLinkPos) this.bufLinkPos = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.bufferData(gl.ARRAY_BUFFER, linkPos, gl.STATIC_DRAW);
        }

        // Create mapping: StringID -> IntID
        // ... (Already done in backend, here we just receive raw arrays)

        // --- SPATIAL GRID INIT ---
        console.time("SpatialGrid");
        // 1. Calculate Bounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        // Sample down to find bounds (exact bounds loop is fast enough for 34M? ~50ms in C++, JS maybe 200ms)
        // Let's do a stride sample for bounds to be fast
        for (let i = 0; i < this.nodeCount; i += 100) {
            const x = data.x[i];
            const y = data.y[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        // Add margin to bounds
        minX -= 10; maxX += 10; minY -= 10; maxY += 10;

        this.gridBounds = { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };

        // 2. Setup Grid
        // 64x64 grid = 4096 buckets.
        const GRID_RES = 64;
        this.gridRes = GRID_RES;
        this.gridCounts = new Uint32Array(GRID_RES * GRID_RES);
        this.gridOffsets = new Uint32Array(GRID_RES * GRID_RES);

        // 3. Pass 1: Count
        const getBucket = (x, y) => {
            let bx = Math.floor(((x - minX) / this.gridBounds.width) * GRID_RES);
            let by = Math.floor(((y - minY) / this.gridBounds.height) * GRID_RES);
            if (bx < 0) bx = 0; if (bx >= GRID_RES) bx = GRID_RES - 1;
            if (by < 0) by = 0; if (by >= GRID_RES) by = GRID_RES - 1;
            return by * GRID_RES + bx;
        };

        for (let i = 0; i < this.nodeCount; i++) {
            this.gridCounts[getBucket(data.x[i], data.y[i])]++;
        }

        // 4. Calculate Offsets
        let accum = 0;
        for (let i = 0; i < this.gridCounts.length; i++) {
            this.gridOffsets[i] = accum;
            accum += this.gridCounts[i];
        }

        // 5. Pass 2: Fill Indices
        // We need a temp offset tracker locally because we fill buckets incrementally
        const currOffsets = new Uint32Array(this.gridOffsets);
        const spatialIndices = new Uint32Array(this.nodeCount);

        for (let i = 0; i < this.nodeCount; i++) {
            const b = getBucket(data.x[i], data.y[i]);
            const pos = currOffsets[b]++;
            spatialIndices[pos] = i;
        }

        // Upload Index Buffer
        this.bufSpatial = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.bufSpatial);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, spatialIndices, this.gl.STATIC_DRAW);

        console.timeEnd("SpatialGrid");

        // --- PREPARE LABELS ---
        console.time("PrepLabels");
        let candidates = [];
        for (let i = 0; i < this.nodeCount; i++) {
            if (data.labels && data.labels[i]) {
                candidates.push(i);
            }
        }
        // Sort by size descending (Critical for "Show Biggest First" logic)
        candidates.sort((a, b) => {
            return data.size[b] - data.size[a];
        });

        // No limit! User wants "ALL" (subject to visibility)
        this.labelIndices = new Uint32Array(candidates);
        console.timeEnd("PrepLabels");
    }

    render(stride = 1) {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.04, 0.06, 0.08, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // --- 0. CALCULATE VISIBILITY & STRIDE (Moved to Top) ---
        const { x: tx, y: ty, k } = this.transform;

        // Critical: Check if grid exists before accessing
        // If not, we still need effectiveStride defined
        let visibleBuckets = [];
        let visiblePoints = 0;

        if (this.gridBounds) {
            const screenMinX = -w; const screenMaxX = 2 * w;
            const screenMinY = -h; const screenMaxY = 2 * h;
            const worldMinX = screenMinX / k - tx;
            const worldMaxX = screenMaxX / k - tx;
            const worldMinY = (h - screenMaxY) / k - ty;
            const worldMaxY = (h - screenMinY) / k - ty;

            const gx1 = Math.floor(((worldMinX - this.gridBounds.minX) / this.gridBounds.width) * this.gridRes);
            const gx2 = Math.floor(((worldMaxX - this.gridBounds.minX) / this.gridBounds.width) * this.gridRes);
            const gy1 = Math.floor(((Math.min(worldMinY, worldMaxY) - this.gridBounds.minY) / this.gridBounds.height) * this.gridRes);
            const gy2 = Math.floor(((Math.max(worldMinY, worldMaxY) - this.gridBounds.minY) / this.gridBounds.height) * this.gridRes);

            const bxStart = Math.max(0, gx1); const bxEnd = Math.min(this.gridRes - 1, gx2);
            const byStart = Math.max(0, gy1); const byEnd = Math.min(this.gridRes - 1, gy2);

            for (let by = byStart; by <= byEnd; by++) {
                for (let bx = bxStart; bx <= bxEnd; bx++) {
                    const b = by * this.gridRes + bx;
                    const count = this.gridCounts[b];
                    if (count > 0) {
                        visiblePoints += count;
                        visibleBuckets.push({ offset: this.gridOffsets[b], count: count });
                    }
                }
            }
        } else {
            // Fallback
            visiblePoints = this.nodeCount;
        }

        let effectiveStride = stride;
        if (stride > 1 && visiblePoints < 500000) effectiveStride = 1;


        // --- 1. DRAW LINES (Background) ---
        if (effectiveStride === 1 && this.linkCount > 0 && this.bufLinkPos) {
            gl.useProgram(this.programLine);

            gl.uniform2f(this.locLineRes, w, h);
            gl.uniform3f(this.locLineTrans, this.transform.x, this.transform.y, this.transform.k);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.vertexAttribPointer(this.locLinePos, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.locLinePos);

            gl.drawArrays(gl.LINES, 0, this.linkCount * 2);
        }

        // --- 2. DRAW POINTS (Foreground) ---
        gl.useProgram(this.program);
        gl.uniform2f(this.locRes, w, h);
        gl.uniform3f(this.locTrans, this.transform.x, this.transform.y, this.transform.k);
        gl.uniform1i(this.locIsLine, 0);

        // Bind Point Attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locPos);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.vertexAttribPointer(this.locSize, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locSize);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.vertexAttribPointer(this.locColor, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locColor);

        if (effectiveStride === 1 && this.ext && this.gridBounds) {
            // SPATIAL DRAW
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufSpatial);
            for (const bucket of visibleBuckets) {
                gl.drawElements(gl.POINTS, bucket.count, gl.UNSIGNED_INT, bucket.offset * 4);
            }
        } else {
            // STRIDE DRAW
            const bStride = stride;
            const FLOAT_BYTES = 4;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
            gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, bStride * 2 * FLOAT_BYTES, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
            gl.vertexAttribPointer(this.locSize, 1, gl.FLOAT, false, bStride * 1 * FLOAT_BYTES, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
            gl.vertexAttribPointer(this.locColor, 3, gl.FLOAT, false, bStride * 3 * FLOAT_BYTES, 0);

            const drawCount = Math.floor(this.nodeCount / stride);
            gl.drawArrays(gl.POINTS, 0, drawCount);
        }

        // --- 3. DRAW LABELS ---
        // (Keep existing label logic)
        if (this.ctx && (stride === 1 || effectiveStride === 1) && this.labelIndices) {
            const ctx = this.ctx;
            ctx.clearRect(0, 0, w, h);

            ctx.fillStyle = "rgba(255, 255, 255, 1.0)"; // Solid White
            ctx.font = "500 10px Inter, sans-serif";
            ctx.textAlign = "center";
            // Shadow Removed as requested
            ctx.shadowBlur = 0;

            const occupied = new Set();
            const CELL_W = 120;
            const CELL_H = 30;

            for (let i = 0; i < this.labelIndices.length; i++) {
                const idx = this.labelIndices[i];
                const screenSize = this.dataSize[idx] * k;
                if (screenSize < 2.0) continue;

                const wx = (this.dataX[idx] + tx) * k;
                const wy = (this.dataY[idx] + ty) * k;
                const sx = wx;
                const sy = h - wy;

                if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;

                const gx = Math.floor(sx / CELL_W);
                const gy = Math.floor(sy / CELL_H);
                const key = `${gx},${gy}`;

                if (occupied.has(key)) continue;
                occupied.add(key);

                ctx.fillText(this.dataLabels[idx], sx, sy - 8);
            }
            ctx.shadowBlur = 0;
        }
    }

    setTransform(x, y, k, isInteracting = false) {
        this.transform = { x, y, k };
        requestAnimationFrame(() => this.render(isInteracting ? 10 : 1));
    }
}

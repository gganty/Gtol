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
        this.bufLOD = this.gl.createBuffer();
        this.lodCount = 0;
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

        // --- SPATIAL GRID BUILD ---
        console.time("SpatialGrid");

        // A. Bounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < this.nodeCount; i += 100) {
            const x = data.x[i]; const y = data.y[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        minX -= 100; maxX += 100; minY -= 100; maxY += 100;
        this.gridBounds = { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };

        // B. Counting
        const GRID_RES = 64;
        this.gridRes = GRID_RES;
        this.gridCounts = new Uint32Array(GRID_RES * GRID_RES);
        this.gridOffsets = new Uint32Array(GRID_RES * GRID_RES);

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

        // C. Offsets
        let accum = 0;
        for (let i = 0; i < this.gridCounts.length; i++) {
            this.gridOffsets[i] = accum;
            accum += this.gridCounts[i];
        }

        // D. Index Buffer
        const currOffsets = new Uint32Array(this.gridOffsets);
        const spatialIndices = new Uint32Array(this.nodeCount);

        for (let i = 0; i < this.nodeCount; i++) {
            const b = getBucket(data.x[i], data.y[i]);
            const pos = currOffsets[b]++;
            spatialIndices[pos] = i;
        }

        this.bufSpatial = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.bufSpatial);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, spatialIndices, this.gl.STATIC_DRAW);
        this.spatialIndices = spatialIndices; // Expose for Label Renderer
        console.timeEnd("SpatialGrid");

        // --- LOD BUFFER BUILD (Uniform Downsampling) ---
        // Target ~200k points for interaction
        const LOD_TARGET = 200000;
        const stride = Math.max(5, Math.ceil(this.nodeCount / LOD_TARGET));
        const lodIndices = [];
        for (let i = 0; i < this.nodeCount; i += stride) {
            lodIndices.push(i);
        }
        this.lodCount = lodIndices.length;
        const lodData = new Uint32Array(lodIndices);

        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.bufLOD);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, lodData, this.gl.STATIC_DRAW);

        // Labels prep
        let candidates = [];
        for (let i = 0; i < this.nodeCount; i++) {
            if (data.labels[i]) candidates.push(i);
        }
        candidates.sort((a, b) => data.size[b] - data.size[a]);
        this.labelIndices = new Uint32Array(candidates);
    }

    render() {
        const gl = this.gl;
        const w = this.canvas.width;
        const h = this.canvas.height;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.04, 0.06, 0.08, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const { x: tx, y: ty, k } = this.transform;

        // --- CULLING LOGIC ---
        let visibleBuckets = [];
        let visiblePoints = 0;

        if (this.gridBounds && this.ext) {
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

            const bxStart = Math.max(0, gx1);
            const bxEnd = Math.min(this.gridRes - 1, gx2);
            const byStart = Math.max(0, gy1);
            const byEnd = Math.min(this.gridRes - 1, gy2);

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
            visiblePoints = this.nodeCount;
        }

        // --- HYBRID DECISION ---
        // 1. Zoomed In (visiblePoints low) -> Always use Grid (Best Quality & Speed)
        // 2. Zoomed Out + Interacting -> Use LOD (Uniform Downsampling)
        // 3. Zoomed Out + Static -> Use Grid (Full Quality)

        const BUDGET = 200000;
        let useLOD = false;

        if (this.isInteracting) {
            // If we see FEWER points than our LOD budget, just draw them exactly (Grid).
            // This fixes the "Zoom In" lag where downsampling was actually slower/worse.
            if (visiblePoints > BUDGET) {
                useLOD = true;
            }
        }

        // 1. Draw Links (Hide during interaction if using LOD)
        if (!useLOD && this.linkCount > 0 && this.bufLinkPos) {
            gl.useProgram(this.programLine);
            gl.uniform2f(this.locLineRes, w, h);
            gl.uniform3f(this.locLineTrans, tx, ty, k);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);
            gl.vertexAttribPointer(this.locLinePos, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.locLinePos);
            gl.drawArrays(gl.LINES, 0, this.linkCount * 2);
        }

        // 2. Draw Points
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

        if (useLOD) {
            // LOD DRAW (Downsampled via Index Buffer)
            // Draws ~200k points uniformly distributed across the WHOLE graph
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufLOD);
            gl.drawElements(gl.POINTS, this.lodCount, gl.UNSIGNED_INT, 0);
        } else if (this.ext && this.gridBounds) {
            // GRID DRAW (Culling / Full Detail)
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufSpatial);
            for (const bucket of visibleBuckets) {
                gl.drawElements(gl.POINTS, bucket.count, gl.UNSIGNED_INT, bucket.offset * 4);
            }
        } else {
            // Fallback (No extension? Should not happen if fixed)
            gl.drawArrays(gl.POINTS, 0, this.nodeCount);
        }

        // 3. Labels
        if (this.ctx && this.labelIndices) {
            this.renderLabels(w, h, visibleBuckets, !useLOD);
        }
    }

    renderLabels(w, h, visibleBuckets, useGrid) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "white";
        ctx.font = "500 10.5px sans-serif";
        ctx.textAlign = "center";

        const occupied = new Set();
        let drawn = 0;
        const MAX_LABELS = 2000;

        // --- HYBRID LABEL STRATEGY ---
        // A. Zoomed In (useGrid=true): Iterate SPATIAL buckets. Fast & Exact.
        // B. Zoomed Out (useGrid=false): Iterate IMPORTANCE list. Good covers.

        let candidates = [];

        if (useGrid && this.spatialIndices && visibleBuckets.length > 0) {
            // SPATIAL LOOKUP (Iterate only visible buckets)
            // Limit buckets if too many to prevent slow loops
            // (If visibleBuckets is huge, we are probably not deeply zoomed, but useGrid flags handles that)
            let count = 0;
            for (const bucket of visibleBuckets) {
                // Indices in spatialIndices are contiguous per bucket
                const start = bucket.offset;
                const end = bucket.offset + bucket.count;
                for (let i = start; i < end; i++) {
                    candidates.push(this.spatialIndices[i]);
                    count++;
                    if (count > 20000) break; // Hard limit for safety
                }
                if (count > 20000) break;
            }
            // Sort spatial candidates by size/importance roughly? 
            // Better: just filter by importance since spatialIndices is random order
            // Actually, spatialIndices is just position. 
            // We need to prioritize important nodes within the visible set.
            // Fast approach: Check standard important list against visible bounds?
            // "candidates" here contains ALL visible points (e.g. 500 points).
            // This is perfect. we just draw them.
        } else {
            // IMPORTANCE LOOKUP (Legacy)
            // Iterate top nodes globally
            // candidates is just an iterator simulation or we just iterate directly
        }

        const iterator = (useGrid && candidates.length > 0) ? candidates : this.labelIndices;
        const limit = (useGrid && candidates.length > 0) ? candidates.length : this.labelIndices.length;

        for (let i = 0; i < limit; i++) {
            const idx = iterator[i];

            // Screen projection
            const px = (this.dataX[idx] + this.transform.x) * this.transform.k;
            const py = (this.dataY[idx] + this.transform.y) * this.transform.k;

            const sx = px;
            const sy = h - py;

            // Culling off-screen (Strict)
            if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;

            // Text collision
            const gx = Math.floor(sx / 100);
            const gy = Math.floor(sy / 24);
            const key = `${gx},${gy}`;

            if (occupied.has(key)) continue;

            // Draw
            ctx.fillText(this.dataLabels[idx], sx, sy - 5);
            occupied.add(key);
            drawn++;

            if (drawn > MAX_LABELS) break;
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
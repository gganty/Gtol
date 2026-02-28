import { POINT_VS, POINT_FS, LINE_VS, LINE_FS } from './shaders.js?v=cw2';

export class GraphRenderer {
    /**
     * WebGL-based renderer for massive graphs.
     * Uses point sprites for nodes and lines for edges.
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

        // initialization of programs and variables
        this.program = this.createProgram(POINT_VS, POINT_FS);
        this.programLine = this.createProgram(LINE_VS, LINE_FS);

        // attributes & uniforms (points)
        this.locSize = this.gl.getAttribLocation(this.program, 'a_size');
        this.locColor = this.gl.getAttribLocation(this.program, 'a_color');
        this.locRes = this.gl.getUniformLocation(this.program, 'u_resolution');
        this.locTrans = this.gl.getUniformLocation(this.program, 'u_transform');
        this.locIsLine = this.gl.getUniformLocation(this.program, 'u_is_line');
        this.locIsCirc = this.gl.getUniformLocation(this.program, 'u_is_circular');
        this.locNodeScale = this.gl.getUniformLocation(this.program, 'u_node_scale');


        // attributes & uniforms (lines)
        this.locLineT = this.gl.getAttribLocation(this.programLine, 'a_t');
        this.locLineCoords = this.gl.getAttribLocation(this.programLine, 'a_link_coords');
        this.locLineRes = this.gl.getUniformLocation(this.programLine, 'u_resolution');
        this.locLineTrans = this.gl.getUniformLocation(this.programLine, 'u_transform');
        this.locLineIsCirc = this.gl.getUniformLocation(this.programLine, 'u_is_circular');
        this.locLineHole = this.gl.getUniformLocation(this.programLine, 'u_hole_radius');
        this.locLineScaleX = this.gl.getUniformLocation(this.programLine, 'u_scale_x');
        this.locLineMaxY = this.gl.getUniformLocation(this.programLine, 'u_max_y');

        // buffers
        this.bufPos = this.gl.createBuffer();
        this.bufSize = this.gl.createBuffer();
        this.bufColor = this.gl.createBuffer();
        this.bufLinkPos = null;
        this.bufLineT = this.gl.createBuffer();

        const tData = new Float32Array(32);
        for (let i = 0; i < 32; i++) tData[i] = i / 31.0;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.bufLineT);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, tData, this.gl.STATIC_DRAW);

        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        // extension for indices > 65535
        this.ext = this.gl.getExtension('OES_element_index_uint');
        this.extInstanced = this.gl.getExtension('ANGLE_instanced_arrays');
        if (!this.extInstanced) console.warn("ANGLE_instanced_arrays not supported!");

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
     * creates and links a WebGL program from vertex and fragment shaders.
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
     * compiles a single shader.
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
    setData(data, isCircular = false) {
        const gl = this.gl;
        this.nodeCount = data.nodeCount;
        this.linkCount = data.linkCount;
        this.isCircular = isCircular;
        this.polarParams = null;

        // lazy saving of original coordinates on first load
        if (!data.origX) {
            data.origX = new Float64Array(data.x);
            data.origY = new Float64Array(data.y);
        }

        if (isCircular) {
            let maxY_orig = -Infinity;
            let maxX_orig = -Infinity;
            // searching for max in original data
            for (let i = 0; i < this.nodeCount; i++) {
                if (data.origY[i] > maxY_orig) maxY_orig = data.origY[i];
                if (data.origX[i] > maxX_orig) maxX_orig = data.origX[i];
            }

            // --- FIX SCALE ---
            // To prevent nodes from clumping, the length of the outer circumference 
            // should equal the original tree height.
            // 2 * PI * R_max = maxY_orig  =>  R_max = maxY_orig / (2 * PI)
            const R_max = maxY_orig / (2.0 * Math.PI);

            // Smart Scaling for 1M+ nodes. 
            // The more nodes, the larger the center hole needs to be to fit the diverging branches.
            // Using a logarithmic scale mapped between 10% (small trees) and 300%+ (huge trees)
            // Math.max guarantees at least 0.1 for small graphs.
            let holeMultiplier = 0.1;
            if (this.nodeCount > 500) {
                // Formula: ln(nodeCount / 500) * 0.4 + 0.1
                // Example values:
                // 10K nodes: ln(20) * 0.4 + 0.1 ≈ 1.3 (130%)
                // 1M nodes: ln(2000) * 0.4 + 0.1 ≈ 3.14 (314%)
                holeMultiplier = Math.max(0.1, Math.log(this.nodeCount / 500.0) * 0.4 + 0.1);
            }

            const HOLE_RADIUS = R_max * holeMultiplier;

            // Branch stretch coefficient along radius (X)
            // Ensure the tree thickness itself is always pushed outwards (positively), 
            // no matter how large the inner hole radius becomes.
            const thickness = R_max * 0.9;
            const scaleX = thickness / (maxX_orig > 0 ? maxX_orig : 1) * 2.5;

            this.polarParams = { holeRadius: HOLE_RADIUS, scaleX: scaleX, maxY: maxY_orig };

            for (let i = 0; i < this.nodeCount; i++) {
                // New radius with proportional scaling
                const r = HOLE_RADIUS + (data.origX[i] * scaleX);

                // Angle
                const theta = (data.origY[i] / maxY_orig) * 2.0 * Math.PI - (Math.PI / 2.0);

                data.x[i] = r * Math.cos(theta);
                data.y[i] = r * Math.sin(theta);
            }
        } else {
            // restore original coordinates
            data.x.set(data.origX);
            data.y.set(data.origY);
        }

        // save references for labels (original order)
        this.dataX = data.x;
        this.dataY = data.y;
        this.dataLabels = data.labels;
        this.dataSize = data.size;

        // 1. calculate bounds & center
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < this.nodeCount; i++) {
            const x = data.x[i]; const y = data.y[i];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }

        // padding & center
        const padX = (maxX - minX) * 0.01;
        const padY = (maxY - minY) * 0.01;
        this.minX = minX - padX;
        this.maxX = maxX + padX;
        this.minY = minY - padY;
        this.maxY = maxY + padY;

        this.centerX = (this.minX + this.maxX) / 2;
        this.centerY = (this.minY + this.maxY) / 2;

        let width = this.maxX - this.minX;
        let height = this.maxY - this.minY;

        // Prevent layout collision when generating grids for 0-dimension point trees or edge cases.
        if (width <= 0 || isNaN(width)) width = 1.0;
        if (height <= 0 || isNaN(height)) height = 1.0;

        // 2. setup grid
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

        // helpers
        const getChunkIdx = (x, y) => {
            let cx = Math.floor(((x - this.minX) / width) * nCols);
            let cy = Math.floor(((y - this.minY) / height) * nRows);
            if (cx >= nCols) cx = nCols - 1; if (cx < 0) cx = 0;
            if (cy >= nRows) cy = nRows - 1; if (cy < 0) cy = 0;
            return cy * nCols + cx;
        };

        // 3. count
        const counts = new Uint32Array(nCols * nRows);
        for (let i = 0; i < this.nodeCount; i++) {
            counts[getChunkIdx(data.x[i], data.y[i])]++;
        }

        // 4. initialize chunks
        const offsets = new Uint32Array(nCols * nRows);
        let accum = 0;
        for (let i = 0; i < counts.length; i++) {
            offsets[i] = accum;

            // chunk bounds
            const cx = i % nCols;
            const cy = Math.floor(i / nCols);

            const chunkX1 = this.minX + cx * (width / nCols);
            const chunkY1 = this.minY + cy * (height / nRows);

            this.grid.chunks[i] = {
                id: i,
                startIndex: accum, // index in the GPU arrays
                count: counts[i],
                x1: chunkX1,
                y1: chunkY1,
                x2: this.minX + (cx + 1) * (width / nCols),
                y2: chunkY1 + (height / nRows),

                // edge bounding box
                linkMinX: Infinity,
                linkMaxX: -Infinity,
                linkMinY: Infinity,
                linkMaxY: -Infinity,
                linkCount: 0,
                linkStartIndex: 0
            };

            accum += counts[i];
        }

        // 5. sort indices
        const sortedIndices = new Uint32Array(this.nodeCount);
        const currOffsets = new Uint32Array(offsets);

        for (let i = 0; i < this.nodeCount; i++) {
            const c = getChunkIdx(data.x[i], data.y[i]);
            sortedIndices[currOffsets[c]++] = i;
        }

        // 6. sort chunks by size
        for (const chunk of this.grid.chunks) {
            if (chunk.count === 0) continue;
            const start = chunk.startIndex;
            const end = chunk.startIndex + chunk.count;
            const sub = sortedIndices.subarray(start, end);
            sub.sort((a, b) => data.size[b] - data.size[a]);
        }

        // --- process edges ---
        if (this.linkCount > 0) {
            // a. count edges per chunk
            // we use the source node to determine which chunk owns the edge.
            const linkCounts = new Uint32Array(nCols * nRows);
            for (let i = 0; i < this.linkCount; i++) {
                const s = data.linkSrc[i];
                // lookup chunk of source node
                linkCounts[getChunkIdx(data.x[s], data.y[s])]++;
            }

            // b. calculate offsets for links
            const linkOffsets = new Uint32Array(nCols * nRows);
            let linkAccum = 0;
            for (let i = 0; i < linkCounts.length; i++) {
                linkOffsets[i] = linkAccum;

                // store metadata in chunk
                if (this.grid.chunks[i]) {
                    this.grid.chunks[i].linkStartIndex = linkAccum;
                    this.grid.chunks[i].linkCount = linkCounts[i];
                }

                linkAccum += linkCounts[i];
            }

            // c. sort links
            this.bufLinkPos = gl.createBuffer();
            let linkPos;
            if (this.isCircular) {
                linkPos = new Float32Array(this.linkCount * 4);
            } else {
                linkPos = new Float32Array(this.linkCount * 4); // same size for layout toggle compatibility
            }
            const currLinkOffsets = new Uint32Array(linkOffsets);

            for (let i = 0; i < this.linkCount; i++) {
                const s = data.linkSrc[i];
                const t = data.linkTgt[i];

                // Identify chunk (ALWAYS visually mapped, x/y is active spatial bounding)
                const sx = data.x[s];
                const sy = data.y[s];
                const tx = data.x[t];
                const ty = data.y[t];

                const cIdx = getChunkIdx(sx, sy);
                const chunk = this.grid.chunks[cIdx];

                // destination index in sorted buffer
                const ptr = currLinkOffsets[cIdx]++;
                const offset = ptr * 4;

                if (this.isCircular) {
                    // Store absolute pre-polar (Cartesian original) coordinates for instancing
                    linkPos[offset] = data.origX[s];
                    linkPos[offset + 1] = data.origY[s] / this.polarParams.maxY;
                    linkPos[offset + 2] = data.origX[t];
                    linkPos[offset + 3] = data.origY[t] / this.polarParams.maxY;
                } else {
                    // Store relative Cartesian coordinates directly for Manhattan chunks
                    linkPos[offset] = sx - chunk.x1;
                    linkPos[offset + 1] = sy - chunk.y1;
                    linkPos[offset + 2] = tx - chunk.x1;
                    linkPos[offset + 3] = ty - chunk.y1;
                }

                // update chunk edge bounds (include both source and target)
                // Use the visual projected coordinates (data.x / data.y) because the camera
                // culling frustum checks against the final visual space
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

        // 7. generate GPU buffers for nodes
        // we recreate data arrays in the sorted order.
        const posData = new Float32Array(this.nodeCount * 2);
        const colData = new Float32Array(this.nodeCount * 3);
        const sizeData = new Float32Array(this.nodeCount); // bufSize

        for (let i = 0; i < this.nodeCount; i++) {
            const originalIdx = sortedIndices[i];

            // optimized lookup
            const ox = data.x[originalIdx];
            const oy = data.y[originalIdx];

            const cIdx = getChunkIdx(ox, oy);
            const chunk = this.grid.chunks[cIdx];

            // chunk relative position
            // pos = absolute - chunkOrigin
            posData[i * 2] = ox - chunk.x1;
            posData[i * 2 + 1] = oy - chunk.y1;

            // copy other props
            sizeData[i] = data.size[originalIdx];
            colData[i * 3] = data.r[originalIdx];
            colData[i * 3 + 1] = data.g[originalIdx];
            colData[i * 3 + 2] = data.b[originalIdx];
        }

        // upload points
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.bufferData(gl.ARRAY_BUFFER, posData, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.bufferData(gl.ARRAY_BUFFER, sizeData, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.bufferData(gl.ARRAY_BUFFER, colData, gl.STATIC_DRAW);

        this.sortedIndices = sortedIndices; // expose for labels
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

        if (!this.grid) return; // not loaded

        // update DPR in case it changed (e.g. window move to other monitor)
        this.dpr = window.devicePixelRatio || 1;

        const { x: tx, y: ty, k } = this.transform;

        // effective zoom for physical pixels
        // WebGL needs to output to physical coordinates (-1..1 maps to 0..Width*DPR)
        // If we use physical width for Resolution uniform, we must scale zoom by DPR.
        const physK = k * this.dpr;

        // offset transform by graph center since GPU buffers are centered
        const glTx = tx + (this.centerX || 0);
        const glTy = ty + (this.centerY || 0);

        // --- LOD logic ---
        // use physical W/H for uniform calculation

        // 1. world view
        const screenMinX = -w; const screenMaxX = 2 * w;
        const screenMinY = -h; const screenMaxY = 2 * h;

        const worldMinX = screenMinX / k - tx;
        const worldMaxX = screenMaxX / k - tx;
        const worldMinY = (h - screenMaxY) / k - ty;
        const worldMaxY = (h - screenMinY) / k - ty;

        // 2. visible chunks
        const visibleNodeChunks = [];
        const visibleLinkChunks = [];

        let potentialPoints = 0;

        for (const chunk of this.grid.chunks) {
            // a. check node visibility
            let isNodeVisible = false;

            if (chunk.count > 0 &&
                !(chunk.x2 < worldMinX || chunk.x1 > worldMaxX ||
                    chunk.y2 < worldMinY || chunk.y1 > worldMaxY)) {

                visibleNodeChunks.push(chunk);
                potentialPoints += chunk.count;
                isNodeVisible = true;
            }

            // b. check link visibility
            if (chunk.linkCount > 0) {
                if (isNodeVisible) {
                    visibleLinkChunks.push(chunk);
                } else {
                    // extended check
                    if (!(chunk.linkMaxX < worldMinX || chunk.linkMinX > worldMaxX ||
                        chunk.linkMaxY < worldMinY || chunk.linkMinY > worldMaxY)) {
                        visibleLinkChunks.push(chunk);
                    }
                }
            }
        }

        // 3. draw count
        const MAX_VERTS = 1000000; // budget

        let lodRatio = 1.0;
        if (potentialPoints > MAX_VERTS) {
            lodRatio = MAX_VERTS / potentialPoints;
        }

        // 4. draw

        // pass 1: lines
        // Drawing edges on 28M node trees natively requires raising the cut-off
        if (potentialPoints < 8000000 && this.bufLinkPos) {
            gl.useProgram(this.programLine);
            gl.uniform2f(this.locLineRes, w, h);
            gl.uniform1f(this.locLineIsCirc, this.isCircular ? 1.0 : 0.0);

            if (this.isCircular && this.polarParams) {
                gl.uniform1f(this.locLineHole, this.polarParams.holeRadius);
                gl.uniform1f(this.locLineScaleX, this.polarParams.scaleX);
                gl.uniform1f(this.locLineMaxY, this.polarParams.maxY);
            }

            // Bind base geometry a_t
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLineT);
            gl.vertexAttribPointer(this.locLineT, 1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.locLineT);
            if (this.extInstanced) {
                this.extInstanced.vertexAttribDivisorANGLE(this.locLineT, 0);
            }

            // Bind instance geometry a_link_coords or a_position equivalent depending on shader usage
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLinkPos);

            if (this.isCircular && this.extInstanced) {
                const bytesPerInstance = 16; // 4 floats * 4 bytes

                for (const chunk of visibleLinkChunks) {
                    if (!chunk.linkCount) continue;

                    // Lines are absolute, apply only global pan
                    gl.uniform3f(this.locLineTrans, tx, ty, physK);

                    gl.vertexAttribPointer(this.locLineCoords, 4, gl.FLOAT, false, 0, chunk.linkStartIndex * bytesPerInstance);
                    gl.enableVertexAttribArray(this.locLineCoords);
                    this.extInstanced.vertexAttribDivisorANGLE(this.locLineCoords, 1);

                    this.extInstanced.drawArraysInstancedANGLE(gl.LINE_STRIP, 0, 32, chunk.linkCount);
                }

                this.extInstanced.vertexAttribDivisorANGLE(this.locLineCoords, 0);
            } else {
                // Cartesian Manhattan layout: standard chunk-relative drawing
                const bytesPerVertex = 8; // 2 floats * 4 bytes (mapping back coordinates out of packed buffer layout)

                // Set `a_link_coords` pointer to mimic packed pairs or switch to simple `a_link_coords.xy` usage in `LINE_VS`:
                // We packed it as [sx, sy, tx, ty] => 1 line = 2 points. Let's just draw them correctly
                // To reuse LINE_VS (which reads vec4 a_link_coords and uses .xy .zw), we can set divisor=1 and draw 2 points via t parameter?
                // Wait, if it's not circular, LINE_VS uses local_pos = mix(start, end, t), so we actually CAN use the exact same instanced call!

                if (this.extInstanced) {
                    const bytesPerInstance = 16;
                    for (const chunk of visibleLinkChunks) {
                        if (!chunk.linkCount) continue;

                        // Cartesian lines are relative to chunk, apply global pan + local translation
                        const chunkTx = tx + chunk.x1;
                        const chunkTy = ty + chunk.y1;
                        gl.uniform3f(this.locLineTrans, chunkTx, chunkTy, physK);

                        gl.vertexAttribPointer(this.locLineCoords, 4, gl.FLOAT, false, 0, chunk.linkStartIndex * bytesPerInstance);
                        gl.enableVertexAttribArray(this.locLineCoords);
                        this.extInstanced.vertexAttribDivisorANGLE(this.locLineCoords, 1);

                        // Draw lines as instanced segments (using 32 instances of base geometry 0..1 to match circular divisor state)
                        // This matches LINE_VS which reads start/end from vec4 and interpolates 
                        // linearly when u_is_circular is 0.0 using `mix(start, end, t)`
                        this.extInstanced.drawArraysInstancedANGLE(gl.LINE_STRIP, 0, 32, chunk.linkCount);
                    }
                    this.extInstanced.vertexAttribDivisorANGLE(this.locLineCoords, 0);
                }
            }
        }

        // pass 2: points
        gl.useProgram(this.program);
        gl.uniform2f(this.locRes, w, h);
        gl.uniform1i(this.locIsLine, 0);
        gl.uniform1f(this.locIsCirc, this.isCircular ? 1.0 : 0.0);
        // Fetch UI Scaling Slider Value dynamically per-frame
        const scaleVal = parseFloat(document.getElementById('node-size-slider').value) || 1.0;
        gl.uniform1f(this.locNodeScale, scaleVal);


        // bind buffers
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
        gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locPos);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize);
        gl.vertexAttribPointer(this.locSize, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locSize);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor);
        gl.vertexAttribPointer(this.locColor, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.locColor);

        // we use drawArrays, no index buffer needed for points now

        for (const chunk of visibleNodeChunks) {
            const drawCount = Math.ceil(chunk.count * lodRatio);
            if (drawCount > 0) {
                // chunk relative translation
                // ScreenPos = (LocalX + ChunkX + transX) * k

                const chunkTx = tx + chunk.x1;
                const chunkTy = ty + chunk.y1;

                gl.uniform3f(this.locTrans, chunkTx, chunkTy, physK);

                // draw range from sorted buffers
                gl.drawArrays(gl.POINTS, chunk.startIndex, drawCount);
            }
        }

        // 5. labels
        if (this.ctx) {
            this.renderLabels(w / this.dpr, h / this.dpr, visibleNodeChunks, lodRatio);
        }
    }

    /**
     * renders text labels on the 2D overlay canvas.
     * uses a hybrid strategy: global importance (size) for zoomed-out views, 
     * and spatial scanning for zoomed-in views.
     * @param {number} w - Canvas width.
     * @param {number} h - Canvas height.
     * @param {Array} visibleChunks - List of currently visible grid chunks.
     * @param {number} lodRatio - Level of Detail ratio (used to switch strategies).
     */
    renderLabels(w, h, visibleChunks, lodRatio) {
        const ctx = this.ctx;
        // since we scale ctx by DPR in index.html, we clear logical area
        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = "white";
        ctx.font = "12px sans-serif";
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.textAlign = "center";

        if (!this.sortedIndices) return;

        const occupied = new Set();
        let drawn = 0;
        const MAX_LABELS = 4000; // Increased to allow all nodes on larger topologies to show labels 
        // candidate collection
        const candidates = [];

        // target sorting pool
        const targetCandidates = 8000;
        const perChunk = Math.ceil(targetCandidates / (visibleChunks.length || 1));

        for (const chunk of visibleChunks) {
            // chunk.indices are already sorted by size
            const count = Math.min(chunk.count, perChunk);
            const start = chunk.startIndex;
            const end = chunk.startIndex + chunk.count;

            // collect top 'count' nodes
            for (let i = start; i < end && i < start + count; i++) {
                candidates.push(this.sortedIndices[i]);
            }
        }

        // sort candidates globally by size
        candidates.sort((a, b) => this.dataSize[b] - this.dataSize[a]);

        // draw
        for (const idx of candidates) {
            if (drawn >= MAX_LABELS) break;

            const px = (this.dataX[idx] + this.transform.x) * this.transform.k;
            const py = (this.dataY[idx] + this.transform.y) * this.transform.k;
            const sx = px;
            const sy = h - py;

            // simple skip if way off screen
            // use larger margin to prevent pop-in at edges
            if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100) continue;

            const gx = Math.floor(sx / 120);
            const gy = Math.floor(sy / 20);
            const key = `${gx},${gy}`;

            if (occupied.has(key)) continue;

            let text = this.dataLabels.get ? this.dataLabels.get(idx) : this.dataLabels[idx];

            if (text && text !== "undefined") {
                ctx.strokeText(text, sx, sy - 5);
                ctx.fillText(text, sx, sy - 5);
            }

            occupied.add(key);
            drawn++;
        }
    }

    /**
     * updates the camera transform (pan/zoom) and requests a new frame.
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
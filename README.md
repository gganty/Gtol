# Custom WebGL Phylogenetic Tree Viewer

## Overview

A high-performance visualization engine designed to render massive phylogenetic trees (successfully tested on up to 12+ million nodes) in the browser. Unlike standard libraries (e.g. Cosmograph) that fail with OOM (Out of Memory) on such datasets, this project implements a custom **Streaming Pipeline** and a dedicated **WebGL rendering engine** optimized for memory efficiency and 60 FPS interactivity.

## Key Features

* **Scale:** Handles 10M+ nodes / edges.
* **Performance:** Constant 60 FPS via Dynamic Level of Detail (LOD) and Spatial Hashing.
* **Memory Efficiency:** Zero-copy streaming parser and Structure of Arrays (SoA) memory layout.
* **Layout:** Orthogonal (Manhattan) layout calculated server-side.

---

## Architecture Pipeline

The data flow is designed to minimize RAM usage at every step, moving from raw text to GPU VRAM without keeping full object trees in memory.

```mermaid
graph LR
    A["Newick File"] --> B("Python Backend")
    B --> C["Gzip Stream"]
    C --> D("JS Loader")
    D --> E["TypedArrays"]
    E --> F("WebGL Engine")

```

### 1. Backend Processing (`tree_algo.py`)

*Responsible for parsing, layout calculation, and geometry generation.*

* **Parsing (Iterative Stack Machine):**
* Uses a custom **iterative state-machine parser** instead of recursion to handle extremely deep trees without hitting Python's `RecursionError`.
* Time Complexity: O(N).
* *Nuance:* Explicitly handles unclosed groups and assigns branch lengths/labels to the correct nodes using a LIFO stack.


* **Layout Calculation:**
* **X-Coordinate:** Computed via DFS as cumulative branch length from the root.
* **Y-Coordinate:**
* Leaves are spaced equidistantly (`leaf_step`).
* Internal nodes are centered based on the mean Y-position of their children (Post-order traversal).




* **Orthogonal Routing:**
* Generates "Manhattan-style" edges by inserting synthetic "Bend" nodes (Elbows).
* *Optimization:* Uses a `point_cache` to merge overlapping bend points, reducing the total vertex count.



### 2. Server & Streaming API (`app_custom.py`)

*Responsible for non-blocking execution and data delivery.*

* **Async Job Queue:**
* Calculations run in a background `threading.Thread` to prevent blocking the FastAPI main loop (CPU-bound task).
* Progress is reported via **Server-Sent Events (SSE)**.


* **String -> Integer Mapping:**
* Converts string IDs (`"SARS-CoV-2..."`) to integer indices (`0, 1, 2...`) server-side. This drastically reduces memory usage on the frontend (Int32 vs String objects).


* **Manual Chunked Gzip Streaming:**
* Instead of `json.dumps()` (which builds a huge string in RAM), the server manually writes JSON chunks directly into a Gzip buffer.
* This allows sending 500MB+ datasets with minimal server memory footprint.



### 3. Frontend Ingestion (`loader.js`)

*Responsible for parsing the stream without crashing the browser.*

* **Decompression:** Uses the browser native `DecompressionStream('gzip')` to unpack data on the fly.
* **Custom Streaming JSON Parser:**
* Standard `JSON.parse()` crashes on large files.
* This module implements a **Finite State Machine** that reads raw bytes, decodes them, and counts braces `{}` to extract and parse one object at a time.


* **Memory Layout (Structure of Arrays):**
* Data is loaded directly into `Float32Array` and `Uint32Array`.
* Avoids JS Objects overhead (`{x:1, y:2}` uses much more RAM than 8 bytes in a TypedArray).
* Implements dynamic array resizing (amortized O(1) insertion).



### 4. Rendering Engine (`engine.js` & `shaders.js`)

*Responsible for drawing 12M points at 60 FPS.*

* **WebGL Pipeline:**
* **Vertex Shader:** Handles coordinate transformation (Pan/Zoom) and projection to Clip Space (-1..1).
* **Fragment Shader:** Uses **SDF (Signed Distance Fields)** to draw perfect circles with antialiasing inside point primitives.


* **Optimization 1: Spatial Hash Grid (Culling):**
* The world is divided into a 64x64 grid.
* An index buffer sorts points by their grid cell.
* During rendering, the CPU calculates which grid cells are visible (Frustum Culling) and issues draw calls *only* for those cells.


* **Optimization 2: Dynamic LOD:**
* **Static State:** Draws high-quality output using the Spatial Grid.
* **Interaction State (Pan/Zoom):** Switches to "Strided Rendering" (drawing every 5th or 10th point) to maintain fluidity during heavy GPU load.


* **Text Rendering:**
* Uses a secondary 2D Canvas overlay.
* Implements collision detection based on the spatial grid to prevent label overlapping.



---

## Installation & Usage

1. **Dependencies:**
```bash
pip install fastapi uvicorn pandas numpy

```


2. **Run Server:**
```bash
uvicorn app_custom:app --reload

```


3. **Access:**
Open `http://127.0.0.1:8000/custom/index.html`

---

## Algorithms Recap

| Component | Algorithm / Technique | Reason |
| --- | --- | --- |
| **Parser** | Iterative Stack Machine | Avoid Recursion Limit / Parsing Speed |
| **Geometry** | DFS (X) + Mean Centering (Y) | Phylogenetic standard visualization |
| **Network** | Chunked Gzip Stream | Prevent Server OOM |
| **Loader** | Brace-Counting Stream Parser | Prevent Browser OOM |
| **Render** | Spatial Hashing + Frustum Culling | GPU Optimization for 10M+ points |
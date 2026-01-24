# Custom WebGL Phylogenetic Tree Viewer

## Overview

This is a high-performance visualization engine designed to render massive phylogenetic trees in the browser. It has been successfully tested on datasets with over 12 million nodes. Unlike standard libraries that often run out of memory on such large datasets, this project uses a custom streaming pipeline and a dedicated WebGL rendering engine to maintain memory efficiency and keep the interface smooth (60 FPS).

## Key features

*   **Scale:** It can handle over 10 million nodes and edges.
*   **Performance:** Maintains a constant 60 FPS by using dynamic level of detail and adaptive spatial hashing.
*   **Memory efficiency:** Uses a zero-copy streaming parser and a structure of arrays memory layout to minimize overhead.
*   **Layout:** The orthogonal layout is calculated entirely on the server.

---

## Architecture pipeline

The data flow is designed to minimize RAM usage at every step. It moves data from raw text on disk to GPU memory without ever keeping the full object tree in system memory.

```
[Newick File] -> (Python Backend) -> [Gzip Stream] -> (JS Loader) -> [TypedArrays] -> (WebGL Engine)
```

### 1. Backend processing (`tree_algo.py`)

This module handles parsing, layout calculation, and geometry generation.

*   **Parsing:** We use a custom iterative state-machine parser instead of recursion. This allows us to handle extremely deep trees without hitting Python's recursion limit. The complexity is linear, O(N). It explicitly handles unclosed groups and assigns branch lengths to the correct nodes using a stack.
*   **Layout calculation:**
    *   The X-coordinate is computed via DFS as the cumulative branch length from the root.
    *   The Y-coordinate is determined by spacing leaves equidistantly and centering internal nodes based on the average position of their children.
*   **Orthogonal routing:** The engine generates Manhattan-style edges by inserting synthetic bend nodes. We use a point cache to merge overlapping bends, which reduces the total number of vertices.

### 2. Server & streaming API (`app_custom.py`)

This handles non-blocking execution and delivery of data to the frontend.

*   **Async job queue:** Calculations run in a background thread so they don't block the main application loop. Progress is reported back to the client using Server-Sent Events.
*   **String to integer mapping:** To save memory on the frontend, we convert string IDs (like "SARS-CoV-2...") to integer indices (0, 1, 2...) on the server.
*   **Manual chunked gzip streaming:** Instead of creating a huge JSON string in RAM, the server manually writes JSON chunks directly into a gzip buffer. This allows us to send 500MB+ datasets with a very small memory footprint.

### 3. Frontend ingestion (`loader.js`)

This script is responsible for parsing the incoming data stream without crashing the browser.

*   **Decompression:** We use the browser's native `DecompressionStream` to unpack data on the fly.
*   **Custom streaming JSON parser:** Standard `JSON.parse()` will crash on files of this size, so we implemented a finite state machine that reads raw bytes, decodes them, and parses one object at a time.
*   **Memory layout:** Data is loaded directly into `Float32Array` and `Uint32Array` buffers. This avoids the overhead of JavaScript objects (which use significantly more RAM) and uses dynamic array resizing for efficient insertion.

### 4. Rendering engine (`engine.js` & `shaders.js`)

This component draws the millions of points at 60 frames per second.

*   **WebGL pipeline:**
    *   **Vertex shader:** Handles coordinate transformation (pan/zoom) and projection to the screen.
    *   **Fragment shader:** Uses signed distance fields to draw smooth, antialiased circles for points.
*   **Optimization 1 (Culling):** The world is divided into dynamic grid chunks. An index buffer sorts points by their cell. During rendering, the CPU calculates which cells are visible and only draws those.
*   **Optimization 2 (LOD):**
    *   When zoomed out, we use stratified sampling to ensure the most important nodes are visible across the map.
    *   When zoomed in, we switch to a full spatial scan to reveal local details.
    *   During heavy interaction (like panning or zooming), we switch to a lower level of detail to keep the frame rate high.
*   **Text rendering:** Labels are drawn on a secondary 2D canvas overlay. We use the spatial grid to detect collisions and prevent labels from overlapping.

---

## Installation & usage

1.  **Dependencies:**
    ```bash
    pip install fastapi uvicorn pandas numpy
    ```

2.  **Run server:**
    ```bash
    uvicorn app_custom:app --reload
    ```

3.  **Access:**
    Open `http://127.0.0.1:8000/custom/index.html`

---

## Algorithms recap

| Component | Algorithm / Technique | Reason |
| --- | --- | --- |
| **Parser** | Iterative stack machine | Avoid recursion limit / parsing speed |
| **Geometry** | DFS (X) + Mean centering (Y) | Standard phylogenetic visualization |
| **Network** | Chunked gzip stream | Prevent server OOM |
| **Loader** | Brace-counting stream parser | Prevent browser OOM |
| **Render** | Adaptive spatial hashing + Frustum culling | GPU optimization for 10M+ points |
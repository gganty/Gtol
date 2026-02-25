# Custom WebGL Phylogenetic Tree Viewer (Gtol)

## Overview

Gtol is a high-performance visualization engine designed to render massive phylogenetic trees directly in the browser. It has been successfully tested on datasets with over 12 million nodes. Unlike standard libraries that often run out of memory on such large datasets, this project uses a custom streaming pipeline, iterative algorithms via Web Workers, and a dedicated WebGL rendering engine to maintain memory efficiency and keep the interface smooth at 60 FPS.

This project is a fully client-side web application.

## Features
- **Local Computation:** Uses Web Workers to parse Newick files and compute layouts directly in the browser seamlessly.
- **Binary Format (.gtol):** Save computation results to a highly efficient binary format for instant reloading.
- **High Performance:** Iterative algorithms and TypedArrays ensure support for incredibly large trees.

## How to Run

Since this is a static web application, you can serve it using any standard static file server.

### Option 1: Python HTTP Server (Recommended)
```bash
# From the project root directory
python3 -m http.server 8000
```
Then, open `http://localhost:8000` in your web browser.

### Option 2: Live Server (VS Code)
Right-click `index.html` and select "Open with Live Server".

## Testing
Open `http://localhost:8000/tests.html` in your browser to run the verification suite for the algorithms and binary format.

## Architecture & Key Files
- `index.html`: Main UI orchestrating the worker and renderer.
- `main.js` / `style.css`: UI logic and styling.
- `engine.js`: WebGL rendering engine.
- `src/logic/tree_algo_iterative.js`: Core graph algorithms (Iterative).
- `src/io/binary_format.js`: GTOL binary format reader/writer.
- `search.worker.js` & `src/compute.worker.js`: Web Worker entry points for non-blocking computation.
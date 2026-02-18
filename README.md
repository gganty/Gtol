# Custom WebGL Phylogenetic Tree Viewer

## Overview

Gtol is a high-performance visualization engine designed to render massive phylogenetic trees in the browser. It has been successfully tested on datasets with over 12 million nodes. Unlike standard libraries that often run out of memory on such large datasets, this project uses a custom streaming pipeline and a dedicated WebGL rendering engine to maintain memory efficiency and keep the interface smooth at 60 FPS.

## Installation & usage

1.  **Dependencies:**
    ```bash
    pip install fastapi uvicorn pandas python-multipart
    ```

2.  **Run server:**
    ```bash
    uvicorn app_custom:app --reload
    ```

3.  **Access:**
    Open `http://127.0.0.1:8000/custom/index.html`
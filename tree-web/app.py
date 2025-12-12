from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from typing import Any, Mapping, Sequence, Callable, Optional, Iterable, List
import numpy as np
import pandas as pd
import json
import gzip
import io
import asyncio
import queue
import threading
from tree_algo import build_graph

app = FastAPI()

# serve static files (index.html lives here)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", include_in_schema=False)
def home():
    return FileResponse("static/index.html")

def _to_native(x: Any) -> Any:
    if isinstance(x, np.generic):
        return x.item()
    return x

def _norm_nodes(nodes: Sequence[Mapping[str, Any]]):
    out = []
    for d in nodes:
        dd = {k: _to_native(v) for k, v in dict[str, Any](d).items()}
        # required by Cosmograph
        dd["id"] = str(dd.get("id") or dd.get("name"))
        if "x" in dd: dd["x"] = float(dd["x"])
        if "y" in dd: dd["y"] = float(dd["y"])
        out.append(dd)
    return out

def _norm_links(links: Sequence[Mapping[str, Any]]):
    out = []
    for d in links:
        dd = {k: _to_native(v) for k, v in dict[str, Any](d).items()}
        src = dd.get("source") or dd.get("parent")
        tgt = dd.get("target") or dd.get("child")
        dd["source"] = str(src)
        dd["target"] = str(tgt)
        out.append(dd)
    return out

@app.get("/api/graph")
def api_graph():
    nodes, links = build_graph()
    # accept DataFrames as well
    if isinstance(nodes, pd.DataFrame): nodes = nodes.to_dict("records")
    if isinstance(links, pd.DataFrame): links = links.to_dict("records")
    return {"nodes": _norm_nodes(nodes), "links": _norm_links(links)}

@app.get("/api/graph/stream")
async def api_graph_stream():
    """Stream graph computation with progress updates via Server-Sent Events."""

    def chunk(seq: Sequence[Any], size: int) -> Iterable[List[Any]]:
        for i in range(0, len(seq), size):
            yield list(seq[i:i + size])

    async def generate():
        progress_queue = queue.Queue()
        computation_done = threading.Event()
        final_message_sent = threading.Event()
        
        def callback(stage: str, progress: float):
            try:
                progress_queue.put({"stage": stage, "progress": progress}, timeout=1.0)
            except queue.Full:
                pass  # Skip if queue is full
        
        # Store result for final fetch
        result_storage = {"nodes": None, "links": None, "ready": False}

        def compute():
            try:
                nodes, links = build_graph(progress_callback=callback)
                # accept DataFrames as well (handled in streaming loop)

                # Store raw result
                result_storage["nodes"] = nodes
                result_storage["links"] = links
                result_storage["ready"] = True

                # Send completion message (without data to avoid huge payload)
                progress_queue.put({
                    "stage": "complete",
                    "progress": 100.0
                }, timeout=1.0)
            except Exception as e:
                import traceback
                error_msg = str(e)
                progress_queue.put({
                    "stage": "error",
                    "progress": 0.0,
                    "error": error_msg
                }, timeout=1.0)
            finally:
                computation_done.set()
        
        # Start computation in a separate thread
        thread = threading.Thread(target=compute, daemon=True)
        thread.start()
        
        # Stream progress updates
        try:
            while True:
                # Check if computation is done and queue is empty
                if computation_done.is_set() and progress_queue.empty():
                    # Wait a bit to ensure final message is processed
                    await asyncio.sleep(0.1)
                    if progress_queue.empty():
                        break
                
                try:
                    # Try to get update with timeout
                    update = progress_queue.get(timeout=0.2)
                    message = f"data: {json.dumps(update)}\n\n"
                    yield message
                    
                    # If this is the final message, send data in a separate message
                    if update.get("stage") == "complete":
                        # Wait for data to be ready
                        max_wait = 50  # Wait up to 5 seconds
                        waited = 0
                        while not result_storage["ready"] and waited < max_wait:
                            await asyncio.sleep(0.1)
                            waited += 1

                        if not result_storage["ready"]:
                            error_msg = {"stage": "error", "progress": 0.0, "error": "Data not ready"}
                            yield f"data: {json.dumps(error_msg)}\n\n"
                            break

                        # Stream chunks to keep payload sizes manageable for cosmograph
                        nodes = result_storage["nodes"]
                        links = result_storage["links"]
                        
                        # Handle DataFrame or list
                        node_total = len(nodes)
                        link_total = len(links)
                        chunk_size = 50_000

                        # Send node chunks
                        for i in range(0, node_total, chunk_size):
                            # Slice
                            if isinstance(nodes, pd.DataFrame):
                                chunk_raw = nodes.iloc[i : i + chunk_size].to_dict("records")
                            else:
                                chunk_raw = nodes[i : i + chunk_size]
                            
                            node_chunk = _norm_nodes(chunk_raw)
                            
                            progress = 95.0 + 2.0 * ((i + len(node_chunk)) / max(1, node_total))
                            data_message = {
                                "stage": "nodes_chunk",
                                "index": i // chunk_size,
                                "total": node_total,
                                "progress": min(progress, 99.0),
                                "nodes": node_chunk,
                            }
                            yield f"data: {json.dumps(data_message)}\n\n"
                            # Small sleep to yield control
                            await asyncio.sleep(0.01)

                        # Send link chunks
                        for i in range(0, link_total, chunk_size):
                            # Slice
                            if isinstance(links, pd.DataFrame):
                                chunk_raw = links.iloc[i : i + chunk_size].to_dict("records")
                            else:
                                chunk_raw = links[i : i + chunk_size]
                                
                            link_chunk = _norm_links(chunk_raw)
                            
                            progress = 97.0 + 2.0 * ((i + len(link_chunk)) / max(1, link_total))
                            data_message = {
                                "stage": "links_chunk",
                                "index": i // chunk_size,
                                "total": link_total,
                                "progress": min(progress, 99.9),
                                "links": link_chunk,
                            }
                            yield f"data: {json.dumps(data_message)}\n\n"
                            await asyncio.sleep(0.01)

                        # Signal completion
                        yield f"data: {json.dumps({'stage': 'data_complete', 'progress': 100.0})}\n\n"
                        await asyncio.sleep(0.1)
                        break
                    elif update.get("stage") == "error":
                        await asyncio.sleep(0.1)
                        break
                except queue.Empty:
                    # If computation is done but we're waiting for final message, continue
                    if not computation_done.is_set():
                        await asyncio.sleep(0.05)
                    else:
                        # Computation done, wait a bit more for final message
                        await asyncio.sleep(0.1)
                        if progress_queue.empty():
                            break
            
            # Final check for any remaining messages
            while not progress_queue.empty():
                try:
                    update = progress_queue.get_nowait()
                    message = f"data: {json.dumps(update)}\n\n"
                    yield message
                    if update.get("stage") == "complete" or update.get("stage") == "error":
                        await asyncio.sleep(0.1)
                except queue.Empty:
                    break
        except Exception as e:
            # Send error message if something goes wrong
            error_msg = {"stage": "error", "progress": 0.0, "error": f"Stream error: {str(e)}"}
            yield f"data: {json.dumps(error_msg)}\n\n"
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@app.get("/api/graph/binary")
def api_graph_binary():
    """Return the entire graph as a pre-gzipped binary payload.

    This avoids EventSource chunking and lets the client stream a single
    compressed file it can fully decompress before handing data to Cosmograph.
    """
    nodes, links = build_graph()
    if isinstance(nodes, pd.DataFrame):
        nodes = nodes.to_dict("records")
    if isinstance(links, pd.DataFrame):
        links = links.to_dict("records")

    payload = json.dumps({
        "nodes": _norm_nodes(nodes),
        "links": _norm_links(links)
    }).encode("utf-8")

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as f:
        f.write(payload)
    compressed = buf.getvalue()

    return StreamingResponse(
        iter([compressed]),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(len(compressed)),
            "Content-Disposition": "attachment; filename=graph.json.gz"
        },
    )


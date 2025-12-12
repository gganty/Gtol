from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from typing import Any, Mapping, Sequence, Callable, Optional
import numpy as np
import pandas as pd
import json
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
                # accept DataFrames as well
                if isinstance(nodes, pd.DataFrame): nodes = nodes.to_dict("records")
                if isinstance(links, pd.DataFrame): links = links.to_dict("records")
                
                # Normalize the data
                result_storage["nodes"] = _norm_nodes(nodes)
                result_storage["links"] = _norm_links(links)
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
                        
                        if result_storage["ready"]:
                            # Send data in chunks to avoid huge single message
                            # For very large datasets, we'll send it all at once but with proper error handling
                            try:
                                data_message = {
                                    "stage": "data",
                                    "nodes": result_storage["nodes"],
                                    "links": result_storage["links"]
                                }
                                yield f"data: {json.dumps(data_message)}\n\n"
                            except Exception as e:
                                # If serialization fails, send error
                                error_msg = {"stage": "error", "progress": 0.0, "error": f"Data serialization error: {str(e)}"}
                                yield f"data: {json.dumps(error_msg)}\n\n"
                        else:
                            error_msg = {"stage": "error", "progress": 0.0, "error": "Data not ready"}
                            yield f"data: {json.dumps(error_msg)}\n\n"
                        
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


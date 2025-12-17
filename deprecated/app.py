from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from typing import Any, Mapping, Sequence, Callable, Optional, List, Dict
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

# --- Async Job Pattern (V2) ---

import uuid
import time
import gzip
import io

class Job:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.created_at = time.time()
        self.progress_queue = queue.Queue()
        self.result: Optional[bytes] = None
        self.error: Optional[str] = None
        self.done = threading.Event()
        self.thread: Optional[threading.Thread] = None

    def post_progress(self, stage: str, progress: float):
        try:
            self.progress_queue.put({"stage": stage, "progress": progress}, timeout=0.1)
        except queue.Full:
            pass

JOBS: Dict[str, Job] = {}

def _cleanup_old_jobs():
    """Remove jobs older than 1 hour."""
    now = time.time()
    to_del = [jid for jid, job in JOBS.items() if now - job.created_at > 3600]
    for jid in to_del:
        JOBS.pop(jid, None)

@app.post("/api/v2/graph/start")
def start_graph_job():
    _cleanup_old_jobs()
    job = Job()
    JOBS[job.id] = job

    def compute():
        try:
            def callback(stage: str, progress: float):
                job.post_progress(stage, progress)

            # 1. Build Graph (returns DataFrames)
            nodes_df, links_df = build_graph(progress_callback=callback)
            
            # --- ZERO-OVERHEAD OPTIMIZATION: Remap IDs to Integers ---
            job.post_progress("layout", 99.0)
            
            # Create mapping: StringID -> IntID
            if "id" not in nodes_df.columns:
                nodes_df["id"] = nodes_df.index
            
            # Create dictionary mapping string IDs to 0..N
            id_map = {str(nid): i for i, nid in enumerate(nodes_df["id"])}
            
            # Remap Links (Source/Target -> Int)
            links_df["source"] = links_df["source"].astype(str).map(id_map).fillna(-1).astype(int)
            links_df["target"] = links_df["target"].astype(str).map(id_map).fillna(-1).astype(int)
            
            # Update Nodes ID to 0..N
            # We preserve 'label', 'color', 'size', 'x', 'y'
            nodes_df["id"] = range(len(nodes_df))
            
            # 2. Stream to Gzip Buffer
            job.post_progress("compressing", 0.0)
            
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                def write(s):
                    gz.write(s.encode("utf-8"))

                write('{"nodes":[')
                
                # Stream nodes
                chunk_size = 50000
                total_nodes = len(nodes_df)
                
                for i in range(0, total_nodes, chunk_size):
                    # Convert to list of dicts directly
                    # keys: id (int), x, y, size, color, label 
                    chunk = nodes_df.iloc[i:i+chunk_size].to_dict("records")
                    
                    json_str = json.dumps(chunk)
                    inner = json_str[1:-1]
                    
                    if i > 0 and len(inner) > 0:
                        write(",")
                    write(inner)
                    
                    if i % 250000 == 0:
                        job.post_progress("compressing", 50.0 * (i / total_nodes))
                        time.sleep(0) 

                write('],"links":[')
                
                # Stream links
                total_links = len(links_df)
                for i in range(0, total_links, chunk_size):
                    chunk = links_df.iloc[i:i+chunk_size].to_dict("records")
                    
                    json_str = json.dumps(chunk)
                    inner = json_str[1:-1]
                    
                    if i > 0 and len(inner) > 0:
                        write(",")
                    write(inner)
                    
                    if i % 250000 == 0:
                         job.post_progress("compressing", 50.0 + 50.0 * (i / total_links))
                         time.sleep(0)

                write(']}')

            job.result = buf.getvalue()
            job.post_progress("complete", 100.0)
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            job.error = str(e)
            job.post_progress("error", 0.0)
        finally:
            job.done.set()

    job.thread = threading.Thread(target=compute, daemon=True)
    job.thread.start()
    return {"job_id": job.id}

@app.get("/api/v2/graph/{job_id}/progress")
async def get_job_progress(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Job not found"}, 404

    async def generate():
        while True:
            try:
                # Check for completion
                if job.done.is_set() and job.progress_queue.empty():
                    yield f"data: {json.dumps({'stage': 'complete', 'progress': 100.0})}\n\n"
                    break

                try:
                    update = job.progress_queue.get(timeout=0.5)
                    yield f"data: {json.dumps(update)}\n\n"
                    if update.get("stage") == "error":
                        break
                except queue.Empty:
                    if job.done.is_set():
                         yield f"data: {json.dumps({'stage': 'complete', 'progress': 100.0})}\n\n"
                         break
                    await asyncio.sleep(0.1)
            except Exception:
                break
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )

@app.get("/api/v2/graph/{job_id}/result")
def get_job_result(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Job not found"}, 404
    
    if not job.done.is_set():
         return {"error": "Job not ready"}, 400
         
    if job.error:
        return {"error": job.error}, 500

    if not job.result:
        return {"error": "No result data"}, 500

    return StreamingResponse(
        iter([job.result]),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(len(job.result)),
            "Content-Disposition": "attachment; filename=graph.json.gz",
            # "Content-Encoding": "gzip", <--- REMOVED TO PREVENT AUTO-DECOMPRESS
            "Cache-Control": "no-store",
        }
    )

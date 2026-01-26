from fastapi import FastAPI, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import json
import asyncio
import queue
import threading
import uuid
import time
import gzip
import io
import os
import hashlib
import pandas as pd
from typing import Optional, Dict

# Import our application logic
from tree_algo import build_graph

app = FastAPI()

# Mount static files (frontend)
app.mount("/custom", StaticFiles(directory="custom_renderer"), name="custom")

# DEFAULT TREE PATH (For the "Compute" button)
# DEFAULT_TREE_PATH = "/Users/gushchin_a/Downloads/Mammals Species.nwk"
# DEFAULT_TREE_PATH = "/Users/gushchin_a/Downloads/Chond 10Cal 10k TreeSet.tre"
DEFAULT_TREE_PATH = "/Users/gushchin_a/Downloads/UShER SARS-CoV-2 latest.nwk"

# Generate cache filename based on the source path and mtime
algo_mtime = os.path.getmtime("tree_algo.py")
cache_key = f"{DEFAULT_TREE_PATH}_{algo_mtime}"
path_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
CACHE_FILE = f"graph_cache_{path_hash}.json.gz"


@app.get("/", include_in_schema=False)
def home():
    """
    Serves the main HTML page for the visualization.
    """
    return FileResponse("custom_renderer/index.html")


# --- Async jobs ---


class Job:
    """
    Represents a background graph calculation job.
    Manages state, result storage, and progress reporting via a thread-safe queue.
    """
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.created_at = time.time()
        self.progress_queue = queue.Queue() # Thread-safe queue for progress messages
        self.result: Optional[bytes] = None
        self.error: Optional[str] = None
        self.done = threading.Event()       # Completion flag
        self.thread: Optional[threading.Thread] = None

    def post_progress(self, stage: str, progress: float):
        """
        Updates the job progress status.
        Args:
            stage: Current stage of the job (e.g., 'parsing', 'layout').
            progress: Percentage complete (0.0 to 100.0).
        """
        try:
            # put_nowait to avoid blocking worker thread if queue is full
            self.progress_queue.put_nowait({"stage": stage, "progress": progress})
        except queue.Full:
            pass


# Global job storage (in-memory)
JOBS: Dict[str, Job] = {}

def _cleanup_old_jobs():
    """Remove jobs older than 1 hour to free memory."""
    now = time.time()
    # Create list of keys to delete to avoid modifying dict while iterating
    to_del = [jid for jid, job in JOBS.items() if now - job.created_at > 3600]
    for jid in to_del:
        JOBS.pop(jid, None)

@app.post("/api/v2/graph/start")
def start_graph_job(use_cache: bool = True):
    """
    Starts the heavy graph calculation process in a background thread.
    Returns the job ID immediately so the client can poll for progress.
    """
    _cleanup_old_jobs()
    job = Job()
    JOBS[job.id] = job

    # 1. Cache check
    print(f"[DEBUG] Request to start job. Configured Path: {DEFAULT_TREE_PATH}")
    print(f"[DEBUG] Target Cache File: {CACHE_FILE}")
    
    if use_cache and os.path.exists(CACHE_FILE):
        print(f"[Server] Cache Hit: {CACHE_FILE}")
        try:
            with open(CACHE_FILE, "rb") as f:
                job.result = f.read()
            job.post_progress("complete", 100.0)
            job.done.set()
            return {"job_id": job.id}
        except Exception as e:
            print(f"[Server] Cache Read Error: {e}")
            # If read error, continue recalculating

    # 2. Worker function
    def compute_worker():
        try:
            def callback(stage: str, progress: float):
                job.post_progress(stage, progress)

            # Stage 1: Math (CPU Bound)
            # Call our function from tree_algo
            nodes_df, links_df = build_graph(DEFAULT_TREE_PATH, progress_callback=callback)
            
            job.post_progress("optimization", 99.0)
            
            # Stage 2: Optimization for WebGL
            
            if "id" not in nodes_df.columns:
                nodes_df["id"] = nodes_df.index
            
            # Create map: StringID -> IntID
            # This is memory expensive but necessary.
            id_map = {str(nid): i for i, nid in enumerate(nodes_df["id"])}
            
            # Rewrite source/target links to numbers
            # fillna(-1) needed for broken links
            links_df["source"] = links_df["source"].astype(str).map(id_map).fillna(-1).astype(int)
            links_df["target"] = links_df["target"].astype(str).map(id_map).fillna(-1).astype(int)
            
            # Nodes now are just sequential 0..N
            nodes_df["id"] = range(len(nodes_df))
            
            # Stage 3: Streaming Serialization (IO Bound)
            job.post_progress("compressing", 0.0)
            
            # Write gzip
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                def write(s):
                    gz.write(s.encode("utf-8"))

                write('{"nodes":[')
                
                # Write nodes in 50k chunks to save RAM
                chunk_size = 50000
                total_nodes = len(nodes_df)
                
                for i in range(0, total_nodes, chunk_size):
                    # Convert DataFrame chunk to list of dicts
                    chunk = nodes_df.iloc[i:i+chunk_size].to_dict("records")
                    
                    # Serialize chunk. [1:-1] removes external array brackets []
                    json_str = json.dumps(chunk)
                    inner = json_str[1:-1]
                    
                    if i > 0 and len(inner) > 0:
                        write(",") # Comma between chunks
                    write(inner)
                    
                    # Yield to other threads
                    if i % 250000 == 0:
                        progress = 50.0 * (i / total_nodes)
                        job.post_progress("compressing", progress)
                        time.sleep(0)  # this is necessary

                write('],"links":[')
                
                # Same for links
                total_links = len(links_df)
                for i in range(0, total_links, chunk_size):
                    chunk = links_df.iloc[i:i+chunk_size].to_dict("records")
                    json_str = json.dumps(chunk)
                    inner = json_str[1:-1]
                    
                    if i > 0 and len(inner) > 0:
                        write(",")
                    write(inner)
                    
                    if i % 250000 == 0:
                         progress = 50.0 + 50.0 * (i / total_links)
                         job.post_progress("compressing", progress)
                         time.sleep(0)  # this is necessary

                write(']}') # Close JSON

            job.result = buf.getvalue()
            
            # Save to disk cache
            try:
                with open(CACHE_FILE, "wb") as f:
                     f.write(job.result)
                print(f"[Server] Cache Saved ({len(job.result)} bytes)")
            except Exception as e:
                print(f"[Server] Cache Write Error: {e}")

            job.post_progress("complete", 100.0)
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            job.error = str(e)
            job.post_progress("error", 0.0)
        finally:
            job.done.set()

    # Start thread
    job.thread = threading.Thread(target=compute_worker, daemon=True)
    job.thread.start()
    
    return {"job_id": job.id}

@app.get("/api/v2/graph/{job_id}/progress")
async def get_job_progress(job_id: str):
    """
    SSE (Server-Sent Events) endpoint.
    Keeps connection open and sends real-time status updates to the client.
    """
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Job not found"}, 404

    async def event_generator():
        while True:
            try:
                # If job done and queue empty then signal finish and exit
                if job.done.is_set() and job.progress_queue.empty():
                    yield f"data: {json.dumps({'stage': 'complete', 'progress': 100.0})}\n\n"
                    break

                try:
                    # Wait for queue message (with timeout to avoid hanging)
                    update = job.progress_queue.get(timeout=0.5)
                    yield f"data: {json.dumps(update)}\n\n"
                    if update.get("stage") == "error":
                        break
                except queue.Empty:
                    # If no messages but job done - exit on next iteration
                    if job.done.is_set():
                         continue
                    # Otherwise send keep-alive pause
                    await asyncio.sleep(0.1)
            except Exception:
                break
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )

@app.get("/api/v2/graph/{job_id}/result")
def get_job_result(job_id: str):
    """
    Returns the binary file (gzipped JSON) for a completed job.
    """
    job = JOBS.get(job_id)
    if not job: return {"error": "Job not found"}, 404
    if not job.done.is_set(): return {"error": "Job not ready"}, 400
    if job.error: return {"error": job.error}, 500
    if not job.result: return {"error": "No result data"}, 500

    return StreamingResponse(
        io.BytesIO(job.result),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": "attachment; filename=graph.json.gz",
            # IMPORTANT!!!!!!: Do not set Content-Encoding: gzip, otherwise browser unpacks it,
            # and our JS loader expects compressed byte stream!
        }
    )
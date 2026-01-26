from fastapi import FastAPI, BackgroundTasks, UploadFile, File
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
import shutil
import tempfile
import pandas as pd
from typing import Optional, Dict

# Import our application logic
from tree_algo import build_graph

app = FastAPI()

# Mount static files (frontend)
app.mount("/custom", StaticFiles(directory="custom_renderer"), name="custom")

# Ensure temp directory exists
TEMP_DIR = "temp_uploads"
os.makedirs(TEMP_DIR, exist_ok=True)

# Generate cache filename based on the source path and mtime
algo_mtime = os.path.getmtime("tree_algo.py")

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
        self.result_path: Optional[str] = None # Path to disk file
        self.error: Optional[str] = None
        self.done = threading.Event()       # Completion flag
        self.thread: Optional[threading.Thread] = None
        self.temp_input_path: Optional[str] = None # Path to uploaded input file
        self.original_filename: str = "graph.nwk" # Default if unknown

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
    
    def cleanup(self):
        """Deletes temporary files associated with this job."""
        if self.temp_input_path and os.path.exists(self.temp_input_path):
            try:
                os.remove(self.temp_input_path)
            except OSError:
                pass
        
        # Result file is cleaned up by BackgroundTasks in the endpoint


# Global job storage (in-memory)
JOBS: Dict[str, Job] = {}

def _cleanup_old_jobs():
    """Remove jobs older than 1 hour to free memory."""
    now = time.time()
    # Create list of keys to delete to avoid modifying dict while iterating
    to_del = []
    for jid, job in JOBS.items():
        if now - job.created_at > 3600:
            job.cleanup() # Delete input file if still there
            if job.result_path and os.path.exists(job.result_path):
                 try:
                     os.remove(job.result_path)
                 except OSError:
                     pass
            to_del.append(jid)
    
    for jid in to_del:
        JOBS.pop(jid, None)

@app.post("/api/v2/graph/start")
def start_graph_job(file: UploadFile = File(...)):
    """
    Starts the heavy graph calculation process in a background thread using an uploaded file.
    Streams input to disk and output to disk to minimize RAM usage.
    """
    _cleanup_old_jobs()
    job = Job()
    JOBS[job.id] = job
    job.original_filename = file.filename
    
    # Stream upload to temp file
    input_filename = f"input_{job.id}_{file.filename}"
    job.temp_input_path = os.path.join(TEMP_DIR, input_filename)
    
    with open(job.temp_input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # 2. Worker function
    def compute_worker():
        try:
            def callback(stage: str, progress: float):
                job.post_progress(stage, progress)

            # Stage 1: Math (CPU Bound)
            # Call our function from tree_algo
            nodes_df, links_df = build_graph(job.temp_input_path, progress_callback=callback)
            
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
            
            # Prepare result file path
            result_filename = f"result_{job.id}.json.gz"
            job.result_path = os.path.join(TEMP_DIR, result_filename)
            
            # Write gzip stream directly to disk
            with gzip.open(job.result_path, "wb") as gz:
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

def delete_file(path: str):
    try:
        os.remove(path)
        print(f"[Server] Deleted temp file: {path}")
    except Exception as e:
        print(f"[Server] Error deleting file {path}: {e}")

@app.get("/api/v2/graph/{job_id}/result")
def get_job_result(job_id: str, background_tasks: BackgroundTasks):
    """
    Returns the binary file (gzipped JSON) for a completed job.
    Streamed from disk. Deletes file after sending.
    """
    job = JOBS.get(job_id)
    if not job: return {"error": "Job not found"}, 404
    if not job.done.is_set(): return {"error": "Job not ready"}, 400
    if job.error: return {"error": job.error}, 500
    if not job.result_path or not os.path.exists(job.result_path): return {"error": "No result data on disk"}, 500

    # Schedule cleanup of the result file after response is sent
    background_tasks.add_task(delete_file, job.result_path)
    # Also cleanup input file if not already done
    background_tasks.add_task(job.cleanup)

    base_name = os.path.splitext(job.original_filename)[0]
    out_name = f"computed_{base_name}.json.gz"

    return FileResponse(
        job.result_path,
        media_type="application/octet-stream",
        filename=out_name,
        headers={
            "Content-Disposition": "attachment; filename=graph.json.gz",
            # IMPORTANT!!!!!!: Do not set Content-Encoding: gzip, otherwise browser unpacks it,
            # and our JS loader expects compressed byte stream!
        }
    )
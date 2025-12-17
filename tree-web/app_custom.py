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

# Импортируем нашу очищенную логику
from tree_algo import build_graph

app = FastAPI()

# Подключаем статику (наш фронтенд)
app.mount("/custom", StaticFiles(directory="custom_renderer"), name="custom")

# ПУТЬ К ФАЙЛУ ПО УМОЛЧАНИЮ (Для кнопки "Compute" на сайте)
# Измени этот путь на реальный файл на твоем компьютере перед демо!
# DEFAULT_TREE_PATH = "/Users/gushchin_a/Downloads/Mammals Species.nwk"
# DEFAULT_TREE_PATH = "/Users/gushchin_a/Downloads/Chond 10Cal 10k TreeSet.tre"
DEFAULT_TREE_PATH = "/Users/gushchin_a/Downloads/UShER SARS-CoV-2 latest.nwk"

# Generate cache filename based on the source path AND code modification time
# This ensures that if we change tree_algo.py, we don't load a stale "bad" tree from cache.
algo_mtime = os.path.getmtime("tree_algo.py")
cache_key = f"{DEFAULT_TREE_PATH}_{algo_mtime}"
path_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
CACHE_FILE = f"graph_cache_{path_hash}.json.gz"

@app.get("/", include_in_schema=False)
def home():
    return FileResponse("custom_renderer/index.html")

# --- Async Job System ---
# Почему мы делаем это так сложно?
# Расчет дерева на 10M узлов занимает время (секунды/минуты).
# Если делать это в основном потоке, сервер "зависнет" и перестанет отвечать другим пользователям.
# Мы используем паттерн "Job Queue": клиент запускает задачу, получает ID и опрашивает статус.

class Job:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.created_at = time.time()
        self.progress_queue = queue.Queue() # Thread-safe очередь для сообщений прогресса
        self.result: Optional[bytes] = None
        self.error: Optional[str] = None
        self.done = threading.Event()       # Флаг завершения
        self.thread: Optional[threading.Thread] = None

    def post_progress(self, stage: str, progress: float):
        try:
            # put_nowait, чтобы не блокировать рабочий поток, если очередь переполнена
            self.progress_queue.put_nowait({"stage": stage, "progress": progress})
        except queue.Full:
            pass

# Глобальное хранилище задач (в памяти)
JOBS: Dict[str, Job] = {}

def _cleanup_old_jobs():
    """Удаляем задачи старше 1 часа, чтобы не забить память."""
    now = time.time()
    # Создаем список ключей для удаления, чтобы не менять словарь во время итерации
    to_del = [jid for jid, job in JOBS.items() if now - job.created_at > 3600]
    for jid in to_del:
        JOBS.pop(jid, None)

@app.post("/api/v2/graph/start")
def start_graph_job(use_cache: bool = True):
    """
    Запускает тяжелый процесс расчета в фоновом потоке.
    """
    _cleanup_old_jobs()
    job = Job()
    JOBS[job.id] = job

    # 1. Проверка Кэша (Fast Path)
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
            # Если ошибка чтения, продолжаем вычислять заново

    # 2. Функция для потока (Worker)
    def compute_worker():
        try:
            def callback(stage: str, progress: float):
                job.post_progress(stage, progress)

            # --- ЭТАП 1: Математика (CPU Bound) ---
            # Вызываем нашу чистую функцию из tree_algo
            nodes_df, links_df = build_graph(DEFAULT_TREE_PATH, progress_callback=callback)
            
            job.post_progress("optimization", 99.0)
            
            # --- ЭТАП 2: Оптимизация для WebGL ---
            # WebGL любит числа (Int/Float), он ненавидит строки.
            # Мы переводим строковые ID ("node_A", "node_B") в индексы (0, 1, 2...).
            
            if "id" not in nodes_df.columns:
                nodes_df["id"] = nodes_df.index
            
            # Создаем карту: StringID -> IntID
            # Это самая дорогая операция с памятью, но она необходима.
            id_map = {str(nid): i for i, nid in enumerate(nodes_df["id"])}
            
            # Переписываем ссылки source/target на числа
            # fillna(-1) нужен на случай, если ссылка ведет в никуда (битое дерево)
            links_df["source"] = links_df["source"].astype(str).map(id_map).fillna(-1).astype(int)
            links_df["target"] = links_df["target"].astype(str).map(id_map).fillna(-1).astype(int)
            
            # Сами узлы теперь просто идут по порядку 0..N
            nodes_df["id"] = range(len(nodes_df))
            
            # --- ЭТАП 3: Потоковая Сериализация (IO Bound) ---
            job.post_progress("compressing", 0.0)
            
            # Мы пишем GZIP вручную в буфер памяти.
            # ПОЧЕМУ? pandas.to_json() создаст гигантскую строку. Мы хотим писать чанками.
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                def write(s):
                    gz.write(s.encode("utf-8"))

                write('{"nodes":[')
                
                # Пишем узлы кусками по 50k, чтобы не грузить RAM
                chunk_size = 50000
                total_nodes = len(nodes_df)
                
                for i in range(0, total_nodes, chunk_size):
                    # Превращаем кусочек DataFrame в список словарей
                    chunk = nodes_df.iloc[i:i+chunk_size].to_dict("records")
                    
                    # Сериализуем кусочек. [1:-1] убирает внешние скобки массива []
                    json_str = json.dumps(chunk)
                    inner = json_str[1:-1]
                    
                    if i > 0 and len(inner) > 0:
                        write(",") # Запятая между чанками
                    write(inner)
                    
                    # Даем другим потокам подышать
                    if i % 250000 == 0:
                        progress = 50.0 * (i / total_nodes)
                        job.post_progress("compressing", progress)
                        time.sleep(0) 

                write('],"links":[')
                
                # То же самое для связей
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
                         time.sleep(0)

                write(']}') # Закрываем JSON

            job.result = buf.getvalue()
            
            # Сохраняем в кэш на диск
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

    # Запускаем поток
    job.thread = threading.Thread(target=compute_worker, daemon=True)
    job.thread.start()
    
    return {"job_id": job.id}

@app.get("/api/v2/graph/{job_id}/progress")
async def get_job_progress(job_id: str):
    """
    SSE (Server-Sent Events) эндпоинт.
    Держит соединение открытым и шлет обновления статуса в реальном времени.
    """
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Job not found"}, 404

    async def event_generator():
        while True:
            try:
                # Если задача завершена и очередь пуста -> сообщаем финиш и выходим
                if job.done.is_set() and job.progress_queue.empty():
                    yield f"data: {json.dumps({'stage': 'complete', 'progress': 100.0})}\n\n"
                    break

                try:
                    # Ждем сообщения из очереди (с таймаутом, чтобы не висеть вечно)
                    update = job.progress_queue.get(timeout=0.5)
                    yield f"data: {json.dumps(update)}\n\n"
                    if update.get("stage") == "error":
                        break
                except queue.Empty:
                    # Если сообщений нет, но задача сделана - выходим на след. итерации
                    if job.done.is_set():
                         continue
                    # Иначе просто шлем "keep-alive" паузу
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
    Отдает готовый бинарный файл (gzip).
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
            # Важно: Не ставим Content-Encoding: gzip, иначе браузер распакует его сам,
            # а наш JS loader ожидает именно сжатый поток байт!
        }
    )
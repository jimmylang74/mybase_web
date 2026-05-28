#!/usr/bin/env python3
import os
import logging

logging.raiseExceptions = False
#only for windows
if os.name == "nt":
    import click
    click.echo = print

import re
import sys
import time
import logging
import signal
import json
import uuid
import sqlite3
import argparse
import shutil
import stat
import base64
import tempfile
import threading
import contextlib
import multiprocessing as mp


from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, jsonify, request, render_template, send_from_directory, abort
from werkzeug.utils import secure_filename


# Early log level setup for PaddleX/PaddleOCR - must run BEFORE import
logging.getLogger("paddlex").setLevel(logging.ERROR)
logging.getLogger("paddleocr").setLevel(logging.ERROR)
logging.getLogger("ppocr").setLevel(logging.ERROR)
os.environ.setdefault("PADDLEOCR_DISABLE_AUTO_LOGGING_CONFIG", "1")

# Additional Paddle/PaddleX environment variables to suppress C++ logs
os.environ.setdefault("GLOG_v", "0")
os.environ.setdefault("GLOG_minloglevel", "3")
os.environ.setdefault("GLOG_logtostderr", "0")
os.environ.setdefault("FLAGS_logtostderr", "0")
os.environ.setdefault("FLAGS_log_dir", tempfile.gettempdir())
os.environ.setdefault("FLAGS_v", "-1")

# Suppress PaddleX model creation prints
os.environ.setdefault("PADDLEX_DISABLE_MODEL_PRINT", "1")

# Global shutdown flag for CTRL+C handling
_shutdown_requested = threading.Event()

# Background indexing tracking (for /api/indexing-status)
_indexing_counter = 0
_indexing_lock = threading.Lock()


def _shutdown_signal_handler(signum, frame):
    """Handle SIGINT (CTRL+C) by setting shutdown flag and raising KeyboardInterrupt."""
    _shutdown_requested.set()
    print("\n  [CTRL+C] Shutdown requested. Stopping worker threads...", flush=True)
    raise KeyboardInterrupt()


def _run_in_background(func, *args, **kwargs):
    """Run *func(*args, **kwargs)* in a background daemon thread (fire-and-forget).

    Tracks the running count so the frontend can show indexing status.
    """
    def _wrapped():
        global _indexing_counter
        with _indexing_lock:
            _indexing_counter += 1
        try:
            func(*args, **kwargs)
        finally:
            with _indexing_lock:
                _indexing_counter -= 1
    thread = threading.Thread(target=_wrapped, args=(), kwargs={}, daemon=True)
    thread.start()


# Register signal handlers for main process
signal.signal(signal.SIGINT, _shutdown_signal_handler)
if hasattr(signal, 'SIGTERM'):
    signal.signal(signal.SIGTERM, _shutdown_signal_handler)


BASE_DIR = Path(__file__).parent


@contextlib.contextmanager
def suppress_stdout_stderr():
    """Context manager to suppress stdout/stderr output.

    On POSIX this redirects at the OS FD level (os.dup/dup2) to also silence
    C-level output (e.g. PaddlePaddle model loading).  On Windows the
    fileno/dup calls may fail in environments without real FDs (pythonw.exe,
    IDLE, py.exe redirect); in that case a Python-level
    ``contextlib.redirect_stdout`` fallback is used.
    """
    try:
        stdout_fd = sys.stdout.fileno()
        stderr_fd = sys.stderr.fileno()
        old_stdout = os.dup(stdout_fd)
        old_stderr = os.dup(stderr_fd)
    except (OSError, AttributeError):
        # Windows / non-FD environment: Python-level redirect only
        with open(os.devnull, 'w', encoding='utf-8') as null:
            with contextlib.redirect_stdout(null), \
                 contextlib.redirect_stderr(null):
                yield
        return

    with open(os.devnull, 'wb') as devnull:
        os.dup2(devnull.fileno(), stdout_fd)
        os.dup2(devnull.fileno(), stderr_fd)

        try:
            yield
        finally:
            os.dup2(old_stdout, stdout_fd)
            os.dup2(old_stderr, stderr_fd)
            os.close(old_stdout)
            os.close(old_stderr)

app = Flask(__name__,
    template_folder=str(BASE_DIR / 'web' / 'templates'),
    static_folder=str(BASE_DIR / 'web' / 'static'),
    static_url_path='/static')

UPLOAD_DIR_NAME = 'images'
data_dir: Path = BASE_DIR / 'data'
mybase_dir: Path = data_dir / 'mybase'
index_db_dir: Path = data_dir / 'db' / 'index_db'
common_db: Path = data_dir / 'db' / 'common.db'
server_port = 9999
force_index_target = None
ocr_disabled = False
ocr_debug = False
workers_ocr = 8
workers_menu = 8
_ocr_logger = None


def ocr_log(msg: str):
    """Write a timestamped OCR debug message to mybase.log.
    No-op unless --debug is enabled at startup.
    Thread-safe via logging.FileHandler.
    """
    if _ocr_logger is not None:
        _ocr_logger.info(msg)
        # Flush immediately so the log is visible in real time
        # (especially important on Windows where the default file
        # buffering delays writes until process exit).
        for h in _ocr_logger.handlers:
            h.flush()


def parse_args():
    parser = argparse.ArgumentParser(description='Web of Mybase Knowledge Server')
    parser.add_argument('--data', type=str, default='data',
                        help='Data root directory (default: data)')
    parser.add_argument('--port', type=int, default=9999,
                        help='Server port (default: 9999)')
    parser.add_argument('--force-index', type=str, nargs='?', const='all', default=None,
                        help='Force reindex a specific knowledge base. If no name given, reindex all.')
    parser.add_argument('--disable-ocr', action='store_true',
                        help='Disable OCR image text indexing.')
    parser.add_argument('--workers-ocr', type=int, default=8,
                        help='Number of OCR worker processes (default: 8, each owns 1 PaddleOCR instance; Windows limited to 1)')
    parser.add_argument('--workers-menu', type=int, default=8,
                        help='Number of parallel menu item indexing workers (default: 8; Windows limited to 1)')
    parser.add_argument('--debug', action='store_true',
                        help='Enable debug mode: write OCR inference logs to mybase.log with timestamps.')
    return parser.parse_args()


def init_config():
    global data_dir, mybase_dir, index_db_dir, common_db, server_port, force_index_target, ocr_disabled, workers_ocr, workers_menu, ocr_debug, _ocr_logger
    args = parse_args()
    data_dir = BASE_DIR / args.data
    mybase_dir = data_dir / 'mybase'
    index_db_dir = data_dir / 'db' / 'index_db'
    common_db = data_dir / 'db' / 'common.db'
    server_port = args.port
    force_index_target = args.force_index
    ocr_disabled = args.disable_ocr
    workers_ocr = args.workers_ocr
    workers_menu = args.workers_menu
    ocr_debug = args.debug

    # Windows: limit workers to 1 to avoid multiprocessing & thread-pool issues
    if os.name == "nt":
        if workers_ocr > 1:
            workers_ocr = 1
        if workers_menu > 1:
            workers_menu = 1
    data_dir.mkdir(exist_ok=True)
    (data_dir / 'db').mkdir(exist_ok=True)
    mybase_dir.mkdir(exist_ok=True)
    if ocr_debug:
        _ocr_logger = logging.getLogger('ocr_debug')
        _ocr_logger.setLevel(logging.DEBUG)
        _ocr_logger.handlers.clear()
        log_path = BASE_DIR / 'mybase.log'
        handler = logging.FileHandler(str(log_path), mode='a', encoding='utf-8')
        handler.setFormatter(logging.Formatter('%(asctime)s %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
        _ocr_logger.addHandler(handler)
        _ocr_logger.info(f"========== OCR Session Start (workers-ocr={workers_ocr}, workers-menu={workers_menu}) ==========")
        print(f"  Debug log: {log_path}")


def get_tab_path(tab_name):
    tab_path = mybase_dir / tab_name
    if tab_path.exists() and tab_path.is_dir():
        return tab_path
    return None


def get_menu_path(tab_name):
    tab_path = get_tab_path(tab_name)
    if tab_path:
        return tab_path / 'menu.json'
    return None


def get_nav_path(tab_name):
    tab_path = get_tab_path(tab_name)
    if tab_path:
        nav = tab_path / 'nav.html'
        if nav.exists():
            return nav
    return None


def get_content_dir(tab_name):
    tab_path = get_tab_path(tab_name)
    if tab_path:
        content_dir = tab_path / 'content'
        content_dir.mkdir(exist_ok=True)
        return content_dir
    return None


def get_upload_dir(tab_name):
    tab_path = get_tab_path(tab_name)
    if tab_path:
        upload_dir = tab_path / UPLOAD_DIR_NAME
        upload_dir.mkdir(exist_ok=True)
        return upload_dir
    return None


def parse_nav_to_menu(nav_path):
    with open(nav_path, 'r', encoding='utf-8') as f:
        content = f.read()

    li_pattern = re.compile(r'<li\s+([^>]*)>(.*?)</li>', re.DOTALL)
    raw_items = []
    for match in li_pattern.finditer(content):
        attrs_str = match.group(1)
        inner = match.group(2).strip()
        inner = (inner.replace('&amp;', '&').replace('&apos;', "'")
                 .replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"'))
        level_m = re.search(r'level="(\d+)"', attrs_str)
        href_m = re.search(r'href="([^"]*)"', attrs_str)
        level = int(level_m.group(1)) if level_m else 1
        href = href_m.group(1) if href_m else ''
        raw_items.append((level, href, inner))

    if raw_items and not raw_items[0][1]:
        raw_items = raw_items[1:]

    tree = []
    stack = []
    for level, href, label in raw_items:
        node = {
            'id': str(uuid.uuid4()),
            'label': label,
            'children': []
        }
        if href:
            node['href'] = href
        while stack and stack[-1][0] >= level:
            stack.pop()
        if stack:
            stack[-1][1]['children'].append(node)
        else:
            tree.append(node)
        stack.append((level, node))
    return tree


def load_menu(tab_name):
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return []
    menu_path = tab_path / 'menu.json'
    nav_path = tab_path / 'nav.html'

    if menu_path.exists():
        with open(menu_path, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
                if data:
                    return data
            except json.JSONDecodeError:
                pass

    if nav_path.exists():
        menu = parse_nav_to_menu(nav_path)
        save_menu(tab_name, menu)
        return menu

    return []


def save_menu(tab_name, menu_data):
    menu_path = get_menu_path(tab_name)
    if menu_path:
        menu_path.parent.mkdir(exist_ok=True)
        with open(menu_path, 'w', encoding='utf-8') as f:
            json.dump(menu_data, f, ensure_ascii=False, indent=2)
        menu_js = menu_path.with_name('menu.js')
        js_content = 'var MENU_DATA = ' + json.dumps(menu_data, ensure_ascii=False) + ';'
        with open(menu_js, 'w', encoding='utf-8') as f:
            f.write(js_content)
        return True
    return False


def find_content_file(tab_name, item_id):
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return None, None

    content_dir = tab_path / 'content'
    content_file = content_dir / f"{item_id}.html"
    if content_file.exists():
        return content_file, 'html'

    menu = load_menu(tab_name)
    item = find_menu_item(menu, item_id)
    if item and 'href' in item:
        href_path = tab_path / item['href']
        if href_path.exists():
            return href_path, 'qrich'
    return None, None


def load_content(tab_name, item_id):
    content_file, ctype = find_content_file(tab_name, item_id)
    if content_file:
        with open(content_file, 'r', encoding='utf-8') as f:
            raw = f.read()
        if ctype == 'qrich':
            return _extract_body_from_qrich(raw)
        return raw
    return ''


def _extract_body_from_qrich(html):
    """Extract <body> content from a .qrich.html file, stripping nav/scripts."""
    body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)
    if body_match:
        body = body_match.group(1)
        body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.DOTALL)
        body = re.sub(r'<nav[^>]*>.*?</nav>', '', body, flags=re.DOTALL)
        return body.strip()
    return html


# ─── Search Index Engine (SQLite3) ─────────────────────────────────────────


def get_index_db_path(tab_name):
    """Return path to the SQLite index db for a given tab."""
    return index_db_dir / f"{tab_name}.db"


def init_index_db(tab_name):
    """Create the index database and table for a tab if not exists."""
    index_db_dir.mkdir(exist_ok=True)
    db_path = get_index_db_path(tab_name)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS item_index (
            menu_item_id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            content_text TEXT DEFAULT '',
            menu_path TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def strip_html_tags(html_text):
    """Strip HTML tags and decode entities for plain text indexing."""
    if not html_text:
        return ''
    text = re.sub(r'<[^>]+>', ' ', html_text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def make_snippet(text, query, context_len=40):
    """Create a text snippet around the first keyword match."""
    if not text:
        return ''
    idx = text.lower().find(query.lower())
    if idx == -1:
        return text[:80]
    start = max(0, idx - context_len)
    end = min(len(text), idx + len(query) + context_len)
    snippet = text[start:end]
    if start > 0:
        snippet = '...' + snippet
    if end < len(text):
        snippet = snippet + '...'
    return snippet


def compute_item_path(menu, item_id, tab_name):
    """Find the full menu path for an item (tab/label/label/...)."""
    def _walk(items, target_id, parent_path):
        for item in items:
            current = f"{parent_path}/{item['label']}"
            if item['id'] == target_id:
                return current
            if item.get('children'):
                result = _walk(item['children'], target_id, current)
                if result:
                    return result
        return None
    return _walk(menu, item_id, tab_name)


def index_tab(tab_name):
    """Full reindex of a single knowledge base tab.

    Menu items are indexed in parallel controlled by --workers-menu;
    OCR within each item uses the shared OCR thread pool (--workers-ocr).
    Results are collected in memory and batch-inserted at the end to avoid
    SQLite write contention between threads.
    """
    if not get_tab_path(tab_name):
        return
    _t_start = time.perf_counter()
    init_index_db(tab_name)
    menu = load_menu(tab_name)

    def _flatten(items, parent_path):
        rows = []
        for item in items:
            path = f"{parent_path}/{item['label']}"
            rows.append((item, path))
            if item.get('children'):
                rows.extend(_flatten(item['children'], path))
        return rows

    flat = _flatten(menu, tab_name)
    total = len(flat)
    if total == 0:
        return

    # ── Process menu items (sequential or parallel per --workers-menu) ──
    # OCR within each item runs in parallel via the shared OCR thread pool.
    # All progress printing is done from the main thread to avoid multi-threaded
    # stdout interleaving that can swallow progress lines.
    results = []
    _lock = threading.Lock()
    _progress = [0]

    def _process(item_path):
        """Index one item and return its label (or None on error/shutdown)."""
        if _shutdown_requested.is_set():
            return None
        item, path = item_path
        try:
            content = load_content(tab_name, item['id'])
            text = strip_html_tags(content)
            ocr_text = extract_text_from_html_images(content, tab_name)
            if ocr_text:
                text = (text + ' ' + ocr_text) if text else ocr_text
            with _lock:
                results.append((item['id'], item['label'], text, path))
            return item['label']
        except Exception as e:
            print(f"  ERROR indexing item '{item['label']}': {e}", flush=True)
            return None

    if workers_menu <= 1:
        # ── Sequential ──
        for item_path in flat:
            if _shutdown_requested.is_set():
                print("  Indexing interrupted.")
                raise KeyboardInterrupt()
            label = _process(item_path)
            if label is not None:
                _progress[0] += 1
                print(f"    [{_progress[0]}/{total}] {label[:40]}", flush=True)
    else:
        # ── Parallel via thread pool ──
        # Use as_completed instead of wait() to avoid timeout-based batching
        # that can make progress output appear discontinuous.
        executor = ThreadPoolExecutor(max_workers=workers_menu)
        try:
            fut_map = {executor.submit(_process, t): t for t in flat}
            for future in as_completed(fut_map):
                if _shutdown_requested.is_set():
                    break
                try:
                    label = future.result()
                except Exception as e:
                    print(f"  ERROR in menu indexing thread: {e}", flush=True)
                    continue
                if label is not None:
                    _progress[0] += 1
                    print(f"    [{_progress[0]}/{total}] {label[:40]}", flush=True)
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

    if _shutdown_requested.is_set():
        print("  Indexing interrupted.")
        raise KeyboardInterrupt()

    # ── Single-threaded batch insert ──
    conn = sqlite3.connect(str(get_index_db_path(tab_name)))
    conn.execute("DELETE FROM item_index")
    conn.executemany(
        "INSERT OR REPLACE INTO item_index (menu_item_id, label, content_text, menu_path) VALUES (?, ?, ?, ?)",
        results
    )
    conn.commit()
    conn.close()

    _t_elapsed = time.perf_counter() - _t_start
    ocr_log(f"  索引完成: {tab_name} ({total} 项), 耗时: {_t_elapsed:.2f}s")
    print(f"  索引完成: {tab_name} ({total} 项), 耗时: {_t_elapsed:.2f}s")


def index_all_tabs():
    """Reindex all existing knowledge bases."""
    if mybase_dir.exists():
        for entry in sorted(mybase_dir.iterdir()):
            if entry.is_dir() and not entry.name.startswith('.'):
                index_tab(entry.name)


def search_index(tab_name, query):
    """Search within a single tab's index. Returns list of result dicts."""
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return []
    conn = sqlite3.connect(str(db_path))
    try:
        like_pattern = f'%{query}%'
        cursor = conn.execute(
            "SELECT menu_item_id, label, content_text, menu_path FROM item_index "
            "WHERE label LIKE ? OR content_text LIKE ? ORDER BY menu_path LIMIT 50",
            (like_pattern, like_pattern)
        )
        results = []
        for row in cursor.fetchall():
            content_text = row[2] or ''
            snippet = ''
            # Try to find match in label first, then content
            if query.lower() in row[1].lower():
                snippet = row[1]
            elif query.lower() in content_text.lower():
                snippet = make_snippet(content_text, query)
            else:
                snippet = content_text[:80]
            results.append({
                'menu_item_id': row[0],
                'label': row[1],
                'menu_path': row[3],
                'snippet': snippet,
                'tab': tab_name,
            })
        return results
    finally:
        conn.close()


def search_all_tabs(query):
    """Search across all indexed knowledge bases."""
    results = []
    if index_db_dir.exists():
        for db_file in sorted(index_db_dir.glob("*.db")):
            tab_name = db_file.stem
            results.extend(search_index(tab_name, query))
    return results


def update_item_in_index(tab_name, item_id):
    """Incremental update: reindex a single item (e.g. after content save)."""
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return
    menu = load_menu(tab_name)
    item = find_menu_item(menu, item_id)
    if not item:
        return
    path = compute_item_path(menu, item_id, tab_name)
    if not path:
        return
    content = load_content(tab_name, item_id)
    text = strip_html_tags(content)
    ocr_text = extract_text_from_html_images(content, tab_name)
    if ocr_text:
        text = (text + ' ' + ocr_text) if text else ocr_text
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("DELETE FROM item_index WHERE menu_item_id = ?", (item_id,))
        conn.execute(
            "INSERT OR REPLACE INTO item_index (menu_item_id, label, content_text, menu_path) VALUES (?, ?, ?, ?)",
            (item_id, item['label'], text, path)
        )
        conn.commit()
    finally:
        conn.close()


def update_item_path_in_index(tab_name, item_id, menu, path):
    """Update the menu_path for a moved/renamed item without re-running OCR."""
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "UPDATE item_index SET menu_path = ? WHERE menu_item_id = ?",
            (path, item_id)
        )
        conn.commit()
    finally:
        conn.close()


def delete_item_from_index(tab_name, item_id):
    """Remove a single item from the index."""
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("DELETE FROM item_index WHERE menu_item_id = ?", (item_id,))
        conn.commit()
    finally:
        conn.close()


def reindex_tab(tab_name):
    """Full reindex of a tab (for menu mutations that change paths)."""
    if get_tab_path(tab_name):
        index_tab(tab_name)


def delete_tab_index(tab_name):
    """Remove the index db file for a deleted tab."""
    db_path = get_index_db_path(tab_name)
    if db_path.exists():
        db_path.unlink()


def ensure_indexes():
    """On startup: delete orphan index files, auto-index new tabs, force-index if requested."""
    index_db_dir.mkdir(exist_ok=True)

    tabs = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and not entry.name.startswith('.'):
                tabs.add(entry.name)

    for db_file in list(index_db_dir.glob("*.db")):
        if db_file.stem not in tabs:
            print(f"  Removing orphan index: {db_file.stem}")
            db_file.unlink()

    indexed = {db.stem for db in index_db_dir.glob("*.db")}

    global force_index_target

    # ── Auto-index (for tabs that will NOT be force-indexed later) ──
    # Build set of tabs that force-index will handle, so we skip them here
    skip_auto = set()
    if force_index_target == 'all':
        skip_auto = tabs
    elif force_index_target and force_index_target in tabs:
        skip_auto = {force_index_target}

    for tab in sorted(tabs):
        if tab not in indexed and tab not in skip_auto:
            print(f"  Creating index for tab: {tab}")
            try:
                index_tab(tab)
            except Exception as e:
                print(f"  ERROR creating index for {tab}: {e}")

    # ── Force-index (if requested) ──
    if force_index_target:
        if force_index_target == 'all':
            tab_list = sorted(tabs)
            total = len(tab_list)
            for tab_idx, tab in enumerate(tab_list, 1):
                print(f"  [{tab_idx}/{total}] Force reindexing: {tab}")
                try:
                    index_tab(tab)
                except Exception as e:
                    print(f"  ERROR reindexing {tab}: {e}")
        elif force_index_target in tabs:
            print(f"  Force reindexing: {force_index_target}")
            try:
                index_tab(force_index_target)
            except Exception as e:
                print(f"  ERROR reindexing {force_index_target}: {e}")
        else:
            print(f"  Warning: Knowledge base '{force_index_target}' not found, skipping.")



# ─── OCR Process Pool ───────────────────────────────────────────────────
# Each worker process owns exactly 1 PaddleOCR instance, avoiding both
# the GIL contention of threads and the fork-safety issues of sharing
# instances across processes.

OCR_MODEL_DIR = BASE_DIR / 'models' / 'ocr'
ocr_process_pool: 'OCRProcessPool | None' = None


def _ocr_worker_init():
    """Initialize env + 1 PaddleOCR instance inside a worker process."""
    OCR_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('PADDLE_PDX_CACHE_HOME', str(OCR_MODEL_DIR))
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
    os.environ.setdefault('GLOG_v', '3')
    os.environ.setdefault('GLOG_logtostderr', '0')
    os.environ.setdefault('FLAGS_logtostderr', '0')
    os.environ.setdefault('FLAGS_log_dir', tempfile.gettempdir())
    os.environ['FLAGS_print_ir'] = '0'
    os.environ['FLAGS_log_level'] = '3'

    from paddleocr import PaddleOCR
    try:
        import paddle as _paddle
        _paddle.disable_signal_handler()
    except (ImportError, AttributeError):
        pass
    with suppress_stdout_stderr():
        return PaddleOCR(
            use_textline_orientation=True,
            lang='ch',
            device='cpu',
            enable_mkldnn=False,
        )


def _ocr_worker(task_queue, result_queue):
    """Worker entry point: init → loop reading tasks → write results."""
    # Ignore SIGINT inherited from parent so workers aren't killed by CTRL+C.
    # Workers exit via sentinel in the task queue, not by signals.
    import signal as _signal
    _signal.signal(_signal.SIGINT, _signal.SIG_IGN)

    try:
        _ocr = _ocr_worker_init()
    except BaseException:
        return  # PaddleOCR init failed, nothing we can do

    while True:
        try:
            task_id, image_path = task_queue.get()
        except (EOFError, OSError):
            break
        if task_id is None:   # shutdown sentinel
            break
        try:
            result_queue.put((task_id, None, time.monotonic()))
            result = _ocr.predict(str(image_path))
            texts = []
            if result:
                for page_result in result:
                    if page_result is None:
                        continue
                    rec_texts = page_result.get('rec_texts', [])
                    if rec_texts:
                        texts.extend(rec_texts)
            result_queue.put((task_id, ' '.join(texts)))
        except BaseException:
            result_queue.put((task_id, ''))


class OCRProcessPool:
    """Fixed-size pool of dedicated OCR worker processes.

    Each process holds 1 PaddleOCR instance.  Tasks are dispatched via
    ``predict_batch()`` which submits all images, waits with a deadline,
    and returns a list of recognised text strings (same order as input).

    Individual process hangs are tolerated — the deadline bounds the
    worst-case wait.

    A background collector thread continuously drains ``result_queue``
    and dispatches results by task-id, so multiple callers can submit
    batches concurrently without a global lock.
    """

    def __init__(self, size: int):
        self._size = size
        self._task_queue = mp.Queue()
        self._result_queue = mp.Queue()
        self._processes: list[mp.Process] = []

        # ── Lock-free result dispatch via Condition ──
        self._results: dict[str, str] = {}   # tid → text
        self._started: dict[str, float] = {} # tid → processing start time (monotonic)
        self._cv = threading.Condition()     # guards _results & _started

        for _ in range(size):
            p = mp.Process(
                target=_ocr_worker,
                args=(self._task_queue, self._result_queue),
                daemon=True,
            )
            p.start()
            self._processes.append(p)

        # Background collector: drains result_queue → _results
        self._collector = threading.Thread(target=self._collect_loop, daemon=True)
        self._collector.start()

        ocr_log(f"[OCR] 进程池启动: {size} 个进程")

    # ── Background collector ─────────────────────────────────────────────

    def _collect_loop(self) -> None:
        """Daemon: drain ``result_queue`` forever, dispatch by task-id.

        Handles two message formats:
          - ``(tid, None, start_time)`` → "started" signal (store in _started)
          - ``(tid, text)``             → result (store in _results)
        """
        while True:
            try:
                msg = self._result_queue.get()
            except (EOFError, OSError):
                break
            with self._cv:
                if len(msg) == 3:
                    # "started" signal: carry start_time for per-task timeout
                    tid, _, start_time = msg
                    self._started[tid] = start_time
                else:
                    tid, text = msg
                    self._results[tid] = text
                    self._cv.notify_all()

    # ── Public API ──────────────────────────────────────────────────────

    def predict_batch(
        self,
        image_paths: list[Path],
        batch_timeout: float = 300.0,
    ) -> list[str]:
        """Submit images, return texts.

        Results preserve the order of *image_paths*.  Images that exceed
        *batch_timeout* seconds of actual *processing* time (not counting
        mp.Queue waiting) yield an empty string.

        Multiple threads may call this concurrently — the background
        collector dispatches results by task-id so there is no race on
        ``result_queue``.
        """
        if not image_paths:
            return []

        task_ids = [str(uuid.uuid4()) for _ in image_paths]

        # ── Submit (no lock needed — mp.Queue is thread-safe) ──
        for tid, path in zip(task_ids, image_paths):
            self._task_queue.put((tid, str(path)))
            ocr_log(f"[OCR] 推理中: {path.name}")

        # ── Collect with per-task processing timeout ──
        remaining_ids = set(task_ids)
        results: dict[str, str] = {}

        with self._cv:
            while remaining_ids:
                now = time.monotonic()

                # Timeout check — only tasks that have STARTED processing
                # are subject to the deadline; queue-waiting tasks are exempt.
                for tid in list(remaining_ids):
                    if tid in self._started:
                        if now - self._started[tid] > batch_timeout:
                            self._started.pop(tid)
                            remaining_ids.discard(tid)

                for tid in list(remaining_ids):
                    if tid in self._results:
                        results[tid] = self._results.pop(tid)
                        self._started.pop(tid, None)
                        remaining_ids.discard(tid)

                if not remaining_ids:
                    break

                self._cv.wait(timeout=1.0)

            for tid in list(remaining_ids):
                if tid in self._results:
                    results[tid] = self._results.pop(tid)
                    remaining_ids.discard(tid)
                self._started.pop(tid, None)

        # ── Map back to input order ──
        output: list[str] = []
        for tid, path in zip(task_ids, image_paths):
            text = results.get(tid, None)
            if text is not None:
                output.append(text)
                if text:
                    ocr_log(f"[OCR] 完成: {path.name}")
                else:
                    ocr_log(f"[OCR] 完成(无文本): {path.name}")
            else:
                output.append('')
                ocr_log(f"[OCR] 跳过(超时): {path.name}")
                print(f"  OCR timeout on {path.name}, skipping", flush=True)

        skipped = len(task_ids) - len(results)
        if skipped:
            print(f"  OCR batch: {skipped}/{len(task_ids)} timed out", flush=True)

        return output

    def shutdown(self) -> None:
        """Send sentinel tasks and wait for workers to exit cleanly."""
        for _ in range(self._size):
            try:
                self._task_queue.put((None, None))
            except Exception:
                pass
        for p in self._processes:
            p.join(timeout=20)
            if p.is_alive():
                print(f"  [WARN] OCR worker (PID {p.pid}) did not exit within 20s, sending terminate()...", flush=True)
                p.terminate()


def resolve_image_path(img_src, tab_name):
    """Resolve an HTML <img> src attribute to a local file path.

    Handles:
      - URL pattern: /uploads/<tab>/images/<filename>
      - Relative path: images/<filename> or <filename>
      - Base64 data URIs: data:image/... (returns None, unsupported)
    """
    if not img_src or img_src.startswith('data:'):
        return None

    # URL pattern: /uploads/<tab>/images/<filename>
    m = re.match(r'^/uploads/([^/]+)/images/(.+)$', img_src)
    if m:
        tab_path = get_tab_path(m.group(1))
        if tab_path:
            return tab_path / 'images' / m.group(2)

    # Relative path (e.g. images/foo.png, ./images/foo.png, foo.png)
    tab_path = get_tab_path(tab_name)
    if tab_path:
        candidate = tab_path / img_src.lstrip('/')
        if candidate.exists():
            return candidate

    return None


def extract_text_from_html_images(html_content, tab_name):
    """Find all <img> tags in HTML, run OCR on each, return combined text.

    Supports:
      - URL-referenced images  (/uploads/<tab>/images/<file>)
      - Relative paths         (images/foo.png)
      - Base64 embedded images (data:image/...;base64,...)

    Returns '' immediately when OCR is disabled (--disable-ocr).
    OCR runs in parallel across all images in the HTML using a thread pool.
    """
    if ocr_disabled or not html_content:
        return ''
    img_pattern = re.compile(
        r'<img[^>]+src=[\'"]([^\'"]+)[\'"][^>]*>', re.IGNORECASE
    )

    # ── Phase 1: collect all image Paths, decode base64 to temp files ──
    image_paths = []   # list[Path]  — what to OCR
    temp_files = []    # list[str]   — temp files to clean up afterwards

    for match in img_pattern.finditer(html_content):
        img_src = match.group(1)
        if not img_src:
            continue

        # Base64 embedded image  →  decode to temp file
        if img_src.startswith('data:'):
            m = re.match(r'^data:image/[^;]+;base64,(.+)$', img_src)
            if not m:
                continue
            try:
                img_data = base64.b64decode(m.group(1))
                with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                    f.write(img_data)
                    temp_path = f.name
                image_paths.append(Path(temp_path))
                temp_files.append(temp_path)
            except Exception as e:
                print(f"  Base64 decode error: {e}")
            continue

        # File-based image
        image_path = resolve_image_path(img_src, tab_name)
        if image_path and image_path.exists():
            image_paths.append(image_path)

    if not image_paths:
        return ''

    # ── Phase 2: OCR via process pool ──
    # The pool handles parallelism across processes, each with its own
    # PaddleOCR instance — no GIL contention, no fork-safety issues.
    pool = ocr_process_pool
    if pool is None:
        return ''

    texts = pool.predict_batch(image_paths, batch_timeout=300.0)

    # ── Phase 3: clean up temp files from base64 decoding ──
    for tp in temp_files:
        try:
            if os.path.exists(tp):
                os.chmod(tp, stat.S_IWRITE)
                os.unlink(tp)
        except Exception as e:
            print(f"  Temp file cleanup error: {e}")

    return ' '.join(t for t in texts if t).strip()


# ─── Common Database (tab_order, general config) ───────────────────────────


def init_common_db():
    """Create common.db and tab_order / tab_kb_visibility tables if not exists."""
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_order (
                tab_name TEXT PRIMARY KEY,
                sort_order INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_kb_visibility (
                tab_name TEXT PRIMARY KEY,
                visible INTEGER NOT NULL DEFAULT 1
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_current_item (
                tab_name TEXT PRIMARY KEY,
                current_item_id TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS font_config (
                id INTEGER PRIMARY KEY DEFAULT 1,
                font_family TEXT NOT NULL DEFAULT 'Arial',
                font_size TEXT NOT NULL DEFAULT '5',
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            INSERT OR IGNORE INTO font_config (id, font_family, font_size)
            VALUES (1, 'Arial', '5')
        """)
        conn.commit()
    finally:
        conn.close()


def get_tab_order():
    """Return list of tab names ordered by sort_order."""
    if not common_db.exists():
        return []
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_order ORDER BY sort_order ASC")
        return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


def set_tab_order(tab_names):
    """Replace entire tab_order table with a new ordered list."""
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_order")
        for i, name in enumerate(tab_names):
            conn.execute(
                "INSERT INTO tab_order (tab_name, sort_order) VALUES (?, ?)",
                (name, i)
            )
        conn.commit()
    finally:
        conn.close()


def add_tab_to_order(tab_name):
    """Append a tab to the end of the order list."""
    names = get_tab_order()
    if tab_name not in names:
        names.append(tab_name)
        set_tab_order(names)


def remove_tab_from_order(tab_name):
    """Remove a tab from the order list."""
    names = get_tab_order()
    if tab_name in names:
        names.remove(tab_name)
        set_tab_order(names)


# ─── Tab Knowledge Base Visibility ─────────────────────────────────────────


def init_tab_visibility(tab_name):
    """Ensure a tab has a visibility entry (default: visible)."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR IGNORE INTO tab_kb_visibility (tab_name, visible) VALUES (?, 1)",
            (tab_name,)
        )
        conn.commit()
    finally:
        conn.close()


def get_tab_visibility():
    """Return dict of {tab_name: bool} for all known tabs."""
    if not common_db.exists():
        return {}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, visible FROM tab_kb_visibility")
        return {row[0]: bool(row[1]) for row in cursor.fetchall()}
    finally:
        conn.close()


def set_tab_visibility(tab_name, visible):
    """Set visibility for a single tab."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO tab_kb_visibility (tab_name, visible) VALUES (?, ?)",
            (tab_name, 1 if visible else 0)
        )
        conn.commit()
    finally:
        conn.close()


def set_tab_visibility_batch(visibility_dict):
    """Replace all visibility entries with a new dict {tab_name: bool}."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_kb_visibility")
        for name, visible in visibility_dict.items():
            conn.execute(
                "INSERT INTO tab_kb_visibility (tab_name, visible) VALUES (?, ?)",
                (name, 1 if visible else 0)
            )
        conn.commit()
    finally:
        conn.close()


def delete_tab_visibility(tab_name):
    """Remove visibility entry for a deleted tab."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_kb_visibility WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()


# ─── Tab Current Item (reading position) ────────────────────────────────────


def get_tab_current_items():
    """Return dict of {tab_name: current_item_id}."""
    if not common_db.exists():
        return {}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, current_item_id FROM tab_current_item")
        return {row[0]: row[1] for row in cursor.fetchall()}
    finally:
        conn.close()


def set_tab_current_item(tab_name, item_id):
    """Upsert the current item for a single tab."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO tab_current_item (tab_name, current_item_id) VALUES (?, ?)",
            (tab_name, item_id)
        )
        conn.commit()
    finally:
        conn.close()


def delete_tab_current_item(tab_name):
    """Remove current item entry for a deleted tab."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_current_item WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()




# ─── Font Config ───────────────────────────────────────────────────────────


def get_font_config():
    """Return font config dict from common.db."""
    if not common_db.exists():
        return {'font_family': 'Arial', 'font_size': '5'}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT font_family, font_size FROM font_config WHERE id = 1"
        )
        row = cursor.fetchone()
        if row:
            return {
                'font_family': row[0],
                'font_size': row[1],
            }
        return {'font_family': 'Arial', 'font_size': '5'}
    finally:
        conn.close()


def set_font_config(font_family, font_size):
    """Upsert font config row in common.db."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO font_config (id, font_family, font_size, updated_at) "
            "VALUES (1, ?, ?, datetime('now', 'localtime'))",
            (font_family, font_size)
        )
        conn.commit()
    finally:
        conn.close()


# ─── End Common Database ──────────────────────────────────────────────────


def save_content(tab_name, item_id, content_html):
    content_dir = get_content_dir(tab_name)
    if content_dir:
        content_file = content_dir / f"{item_id}.html"
        with open(content_file, 'w', encoding='utf-8') as f:
            f.write(content_html)
        return True
    return False




def find_menu_item(items, item_id):
    for item in items:
        if item['id'] == item_id:
            return item
        if 'children' in item:
            result = find_menu_item(item['children'], item_id)
            if result:
                return result
    return None


def add_menu_item(items, parent_id, new_item):
    if parent_id is None:
        items.append(new_item)
        return True
    parent = find_menu_item(items, parent_id)
    if parent:
        if 'children' not in parent:
            parent['children'] = []
        parent['children'].append(new_item)
        return True
    return False


def add_menu_item_after(items, new_item, after_id):
    for i, item in enumerate(items):
        if item['id'] == after_id:
            items.insert(i + 1, new_item)
            return True
        if item.get('children'):
            if add_menu_item_after(item['children'], new_item, after_id):
                return True
    return False


def update_menu_item(items, item_id, updates):
    item = find_menu_item(items, item_id)
    if item:
        for key, value in updates.items():
            if key != 'id' and key != 'children':
                item[key] = value
        return True
    return False


def delete_menu_item(items, item_id):
    deleted_ids = []

    def _delete_recursive(items_list):
        new_items = []
        for item in items_list:
            if item['id'] == item_id:
                deleted_ids.append(item['id'])
                _collect_descendants(item, deleted_ids)
                continue
            if 'children' in item:
                item['children'] = _delete_recursive(item['children'])
            new_items.append(item)
        return new_items

    def _collect_descendants(item, ids_list):
        for child in item.get('children', []):
            ids_list.append(child['id'])
            _collect_descendants(child, ids_list)

    updated = _delete_recursive(items)
    return updated, deleted_ids


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/tabs')
def list_tabs():
    tabs = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and not entry.name.startswith('.'):
                tabs.add(entry.name)
    if not tabs:
        return jsonify([])
    # Return tabs in order from common.db, unknown tabs appended at end
    ordered = get_tab_order()
    result = [t for t in ordered if t in tabs]
    for t in sorted(tabs):
        if t not in result:
            result.append(t)
    return jsonify(result)


@app.route('/api/<tab>/menu')
def get_menu(tab):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    menu = load_menu(tab)
    return jsonify(menu)


@app.route('/api/<tab>/menu', methods=['POST'])
def create_menu_item(tab):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    data = request.get_json()
    if not data or 'label' not in data:
        return jsonify({'error': 'Label is required'}), 400

    new_item = {
        'id': str(uuid.uuid4()),
        'label': data['label'],
        'children': []
    }
    parent_id = data.get('parent_id')
    after_id = data.get('after_id')

    menu = load_menu(tab)
    if after_id:
        success = add_menu_item_after(menu, new_item, after_id)
    else:
        success = add_menu_item(menu, parent_id, new_item)
    if not success:
        return jsonify({'error': 'Parent or reference item not found'}), 404

    save_menu(tab, menu)
    path = compute_item_path(menu, new_item['id'], tab)
    if path:
        db_path = get_index_db_path(tab)
        if db_path.exists():
            conn = sqlite3.connect(str(db_path))
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO item_index (menu_item_id, label, content_text, menu_path) VALUES (?, ?, '', ?)",
                    (new_item['id'], new_item['label'], path)
                )
                conn.commit()
            finally:
                conn.close()
    return jsonify(new_item), 201


@app.route('/api/<tab>/menu/<item_id>', methods=['PUT'])
def update_menu_item_route(tab, item_id):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    menu = load_menu(tab)
    success = update_menu_item(menu, item_id, data)
    if not success:
        return jsonify({'error': 'Item not found'}), 404

    save_menu(tab, menu)
    _run_in_background(update_item_in_index, tab, item_id)
    return jsonify({'success': True})


@app.route('/api/<tab>/menu/<item_id>', methods=['DELETE'])
def delete_menu_item_route(tab, item_id):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404

    menu = load_menu(tab)
    menu, deleted_ids = delete_menu_item(menu, item_id)

    if not deleted_ids:
        return jsonify({'error': 'Item not found'}), 404

    save_menu(tab, menu)

    content_dir = get_content_dir(tab)
    if content_dir:
        for did in deleted_ids:
            content_file = content_dir / f"{did}.html"
            if content_file.exists():
                content_file.unlink()

    for did in deleted_ids:
        delete_item_from_index(tab, did)
    return jsonify({'deleted_ids': deleted_ids})


@app.route('/api/<tab>/content/<item_id>')
def get_content(tab, item_id):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    content = load_content(tab, item_id)
    return jsonify({'content': content})


@app.route('/api/<tab>/content/<item_id>', methods=['PUT'])
def save_content_route(tab, item_id):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    data = request.get_json()
    if data is None or 'content' not in data:
        return jsonify({'error': 'Content is required'}, 400)

    save_content(tab, item_id, data['content'])
    _run_in_background(update_item_in_index, tab, item_id)
    return jsonify({'success': True})


@app.route('/api/<tab>/upload', methods=['POST'])
def upload_image(tab):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    if 'image' not in request.files:
        return jsonify({'error': 'No image file provided'}), 400

    file = request.files['image']
    if not file.filename:
        return jsonify({'error': 'No file selected'}), 400

    orig_filename = secure_filename(file.filename)
    if not orig_filename:
        orig_filename = f"img_{uuid.uuid4().hex[:8]}.png"

    name_part, ext_part = os.path.splitext(orig_filename) if '.' in orig_filename else (orig_filename, '.png')
    unique_name = f"{name_part}_{uuid.uuid4().hex[:4]}{ext_part}"

    upload_dir = get_upload_dir(tab)
    assert upload_dir is not None, "tab verified above"
    file_path = upload_dir / unique_name
    file.save(str(file_path))

    return jsonify({'url': f'/uploads/{tab}/images/{unique_name}'}), 201


@app.route('/uploads/<tab>/images/<filename>')
def serve_uploaded_image(tab, filename):
    tab_path = get_tab_path(tab)
    if not tab_path:
        abort(404)
    upload_dir = tab_path / UPLOAD_DIR_NAME
    return send_from_directory(str(upload_dir), filename)


@app.route('/api/search')
def search():
    query = request.args.get('q', '').strip()
    tab = request.args.get('tab', '').strip()
    if not query:
        return jsonify([])
    if tab:
        results = search_index(tab, query)
    else:
        results = search_all_tabs(query)
    return jsonify(results)


@app.route('/api/indexing-status')
def get_indexing_status():
    busy = _indexing_counter > 0
    return jsonify({
        'busy': busy,
        'status': '正在建立索引...' if busy else 'idle',
    })



def generate_standalone_html(tab_name):
    return '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>''' + tab_name + '''</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; height:100vh; display:flex; color:#333; }
  #sidebar { width:300px; min-width:200px; display:flex; flex-direction:column; border-right:1px solid #ddd; background:#fff; }
  #tree { flex:1; overflow:auto; padding:8px 0; }
  #main { flex:1; display:flex; flex-direction:column; }
  #content { flex:1; position:relative; }
  #content iframe { width:100%; height:100%; border:none; display:block; }
  #placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#999; font-size:14px; }
  .node { user-select:none; }
  .node-header { display:flex; align-items:center; padding:4px 8px; cursor:pointer; border-radius:3px; margin:1px 4px; }
  .node-header:hover { background:#e8f0fe; }
  .node-header.active { background:#d4e4fc; font-weight:600; }
  .toggle { width:18px; font-size:10px; color:#888; flex-shrink:0; cursor:pointer; }
  .toggle.empty { visibility:hidden; }
  .label { flex:1; font-size:13px; padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .children { padding-left:20px; }
</style>
</head>
<body>
<div id="sidebar">
  <div id="tree"></div>
</div>
<div id="main">
  <div id="content">
    <div id="placeholder">Select an item</div>
    <iframe id="content-frame" name="content-frame" style="display:none"></iframe>
  </div>
</div>
<script src="menu.js"></script>
<script>
(function() {
  var treeEl = document.getElementById('tree');
  var frame = document.getElementById('content-frame');
  var placeholder = document.getElementById('placeholder');

  function render(items, container) {
    items.forEach(function(item) {
      var div = document.createElement('div');
      div.className = 'node';
      var hdr = document.createElement('div');
      hdr.className = 'node-header';
      var tgl = document.createElement('span');
      var hasKids = item.children && item.children.length;
      tgl.className = 'toggle' + (hasKids ? '' : ' empty');
      tgl.textContent = hasKids ? '\\u25BE' : '\\u25B8';
      var lbl = document.createElement('span');
      lbl.className = 'label';
      lbl.textContent = item.label;
      hdr.appendChild(tgl);
      hdr.appendChild(lbl);
      div.appendChild(hdr);
      if (hasKids) {
        var ch = document.createElement('div');
        ch.className = 'children';
        render(item.children, ch);
        div.appendChild(ch);
        tgl.addEventListener('click', function(e) { e.stopPropagation(); var d = ch.style.display; ch.style.display = d==='none'?'':'none'; this.textContent = d==='none'?'\\u25BE':'\\u25B8'; });
      }
      hdr.addEventListener('click', function() {
        var act = document.querySelectorAll('.node-header');
        for (var i = 0; i < act.length; i++) act[i].classList.remove('active');
        this.classList.add('active');
        frame.style.display = 'block';
        placeholder.style.display = 'none';
        frame.src = 'content/' + item.id + '.html';
      });
      container.appendChild(div);
    });
  }

  render(MENU_DATA, treeEl);
})();
</script>
</body>
</html>'''


@app.route('/api/tab-visibility')
def get_tab_visibility_route():
    """Return visibility dict for all tabs."""
    tabs = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and not entry.name.startswith('.'):
                tabs.add(entry.name)
    vis = get_tab_visibility()
    # Ensure all existing tabs have an entry; default visible=True
    result = {}
    for t in tabs:
        result[t] = vis.get(t, True)
    return jsonify(result)


@app.route('/api/tab-visibility', methods=['PUT'])
def set_tab_visibility_route():
    """Set visibility for all tabs at once. Expects {tab_name: bool, ...}."""
    data = request.get_json()
    if not isinstance(data, dict):
        return jsonify({'error': 'Expected a dict of {tab_name: visible}'}), 400
    set_tab_visibility_batch(data)
    return jsonify({'success': True})


@app.route('/api/tab-current-items')
def get_tab_current_items_route():
    """Return dict of {tab_name: current_item_id}."""
    return jsonify(get_tab_current_items())


@app.route('/api/tab-current-item', methods=['PUT'])
def set_tab_current_item_route():
    """Set current item for a tab. Expects {tab_name, current_item_id}."""
    data = request.get_json()
    if not data or 'tab_name' not in data or 'current_item_id' not in data:
        return jsonify({'error': 'Expected {tab_name, current_item_id}'}), 400
    set_tab_current_item(data['tab_name'], data['current_item_id'])
    return jsonify({'success': True})


@app.route('/api/tab-order')
def get_tab_order_route():
    return jsonify(get_tab_order())


@app.route('/api/tab-order', methods=['PUT'])
def set_tab_order_route():
    data = request.get_json()
    if not isinstance(data, list):
        return jsonify({'error': 'Expected a list of tab names'}), 400
    set_tab_order(data)
    return jsonify({'success': True})


@app.route('/api/font-config')
def get_font_config_route():
    """Return font configuration (font_family, font_size)."""
    return jsonify(get_font_config())


@app.route('/api/font-config', methods=['PUT'])
def set_font_config_route():
    """Save font configuration."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    font_family = data.get('font_family', 'Arial')
    font_size = data.get('font_size', '5')
    set_font_config(font_family, font_size)
    return jsonify({'success': True})


@app.route('/api/tabs', methods=['POST'])
def create_tab():
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    if not name:
        name = f"NewTab_{uuid.uuid4().hex[:6]}"
    tab_path = mybase_dir / name
    if tab_path.exists():
        return jsonify({'error': 'Tab already exists'}), 409
    tab_path.mkdir(parents=True)
    save_menu(name, [])
    add_tab_to_order(name)
    init_tab_visibility(name)
    index_html = generate_standalone_html(name)
    with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
        f.write(index_html)
    return jsonify({'name': name}), 201


def rename_tab_in_index_db(old_name, new_name):
    db_path = get_index_db_path(old_name)
    if not db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
    try:
        old_prefix = old_name + '/'
        new_prefix = new_name + '/'
        conn.execute(
            "UPDATE item_index SET menu_path = replace(menu_path, ?, ?)",
            (old_prefix, new_prefix)
        )
        conn.commit()
    finally:
        conn.close()


def rename_tab_in_common_db(old_name, new_name):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "UPDATE tab_order SET tab_name = ? WHERE tab_name = ?",
            (new_name, old_name)
        )
        conn.execute(
            "UPDATE tab_kb_visibility SET tab_name = ? WHERE tab_name = ?",
            (new_name, old_name)
        )
        conn.execute(
            "UPDATE tab_current_item SET tab_name = ? WHERE tab_name = ?",
            (new_name, old_name)
        )
        conn.commit()
    finally:
        conn.close()


def regenerate_index_html(tab_name, tab_path):
    index_html = generate_standalone_html(tab_name)
    with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
        f.write(index_html)


@app.route('/api/tabs/<old_name>', methods=['PUT'])
def rename_tab(old_name):
    data = request.get_json() or {}
    new_name = data.get('new_name', '').strip()

    if not new_name:
        return jsonify({'error': 'New name is required'}), 400

    if new_name == old_name:
        return jsonify({'success': True})

    old_tab_path = get_tab_path(old_name)
    if not old_tab_path:
        return jsonify({'error': 'Tab not found'}), 404

    new_tab_path = mybase_dir / new_name
    if new_tab_path.exists():
        return jsonify({'error': 'Tab with new name already exists'}), 409

    old_index_db_path = get_index_db_path(old_name)
    new_index_db_path = get_index_db_path(new_name)

    try:
        if old_index_db_path.exists():
            rename_tab_in_index_db(old_name, new_name)

        rename_tab_in_common_db(old_name, new_name)

        if old_index_db_path.exists():
            old_index_db_path.rename(new_index_db_path)
            wal_file = old_index_db_path.with_suffix('.db-wal')
            shm_file = old_index_db_path.with_suffix('.db-shm')
            if wal_file.exists():
                wal_file.rename(new_index_db_path.with_suffix('.db-wal'))
            if shm_file.exists():
                shm_file.rename(new_index_db_path.with_suffix('.db-shm'))

        old_tab_path.rename(new_tab_path)
        regenerate_index_html(new_name, new_tab_path)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tabs/<tab>', methods=['DELETE'])
def delete_tab(tab):
    tab_path = get_tab_path(tab)
    if not tab_path:
        return jsonify({'error': 'Tab not found'}), 404
    delete_tab_index(tab)
    remove_tab_from_order(tab)
    delete_tab_visibility(tab)
    delete_tab_current_item(tab)

    def _remove_readonly(func, path, _):
        """Clear read-only flag and retry (required on Windows)."""
        os.chmod(path, stat.S_IWRITE)
        func(path)

    shutil.rmtree(str(tab_path), onerror=_remove_readonly)
    return jsonify({'success': True})


def move_menu_item(items, item_id, direction):
    for i, item in enumerate(items):
        if item['id'] == item_id:
            if direction == 'up' and i > 0:
                items[i], items[i-1] = items[i-1], items[i]
                return True
            elif direction == 'down' and i < len(items) - 1:
                items[i], items[i+1] = items[i+1], items[i]
                return True
            return False
        if 'children' in item and item['children']:
            if move_menu_item(item['children'], item_id, direction):
                return True
    return False


def move_menu_item_to_parent(items, item_id, target_parent_id):
    item_to_move = None
    def find_and_remove(items_list):
        nonlocal item_to_move
        new_list = []
        for item in items_list:
            if item['id'] == item_id:
                item_to_move = item
                continue
            if 'children' in item:
                item['children'] = find_and_remove(item['children'])
            new_list.append(item)
        return new_list
    updated = find_and_remove(items)
    if item_to_move is None:
        return items, False
    if target_parent_id is None:
        updated.append(item_to_move)
    else:
        target = find_menu_item(updated, target_parent_id)
        if target is None:
            return items, False
        if 'children' not in target:
            target['children'] = []
        target['children'].append(item_to_move)
    return updated, True


@app.route('/api/<tab>/menu/<item_id>/move', methods=['PUT'])
def move_menu_item_route(tab, item_id):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    menu = load_menu(tab)
    direction = data.get('direction')
    target_parent_id = data.get('target_parent_id')

    if direction in ('up', 'down'):
        success = move_menu_item(menu, item_id, direction)
        if not success:
            return jsonify({'error': 'Cannot move item'}), 400
    elif 'target_parent_id' in data:
        menu, success = move_menu_item_to_parent(menu, item_id, target_parent_id)
        if not success:
            return jsonify({'error': 'Cannot move item to target'}), 400
    else:
        return jsonify({'error': 'Specify direction or target_parent_id'}), 400

    save_menu(tab, menu)
    path = compute_item_path(menu, item_id, tab)
    if path:
        update_item_path_in_index(tab, item_id, menu, path)
    return jsonify({'success': True})


@app.route('/api/<tab>/tree')
def get_tree(tab):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    menu = load_menu(tab)

    def flatten(items, parent_id=None, depth=0):
        result = []
        for item in items:
            node = {
                'id': item['id'],
                'label': item['label'],
                'parent_id': parent_id,
                'depth': depth,
                'has_children': bool(item.get('children'))
            }
            result.append(node)
            if item.get('children'):
                result.extend(flatten(item['children'], item['id'], depth + 1))
        return result

    return jsonify(flatten(menu))


if __name__ == '__main__':
    try:
        init_config()
        print("=" * 60)
        print("  Web of Mybase Knowledge Server")
        print("=" * 60)
        print(f"  Data directory: {data_dir}")
        print(f"  MyBase directory: {mybase_dir}")
        if force_index_target:
            print(f"  Force reindex: {force_index_target}")
        if ocr_disabled:
            print(f"  OCR disabled via --disable-ocr")
        print(f"  Server URL: http://0.0.0.0:{server_port}")
        print("=" * 60)

        # Start OCR process pool
        if not ocr_disabled:
            ocr_process_pool = OCRProcessPool(workers_ocr)

        print("  Checking indexes...")
        ensure_indexes()
        init_common_db()
        print("  Done.")
        print("=" * 60)
        app.run(host='0.0.0.0', port=server_port, debug=False)
    except KeyboardInterrupt:
        _shutdown_requested.set()
        if ocr_process_pool is not None:
            ocr_process_pool.shutdown()
        print("\n  [EXIT] Shutdown complete. Bye.")
        sys.exit(1)

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
import zipfile
import io
import mimetypes
from datetime import datetime


from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, jsonify, request, render_template, send_from_directory, send_file, abort
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
import html.parser
import html as html_module
from fpdf import FPDF

# Password hashing and encryption
import bcrypt
from Crypto.Cipher import AES
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Random import get_random_bytes

# ─── Version ────────────────────────────────────────────────────────────────
def _read_version():
    try:
        v = Path(__file__).parent / 'VERSION'
        if v.exists():
            return v.read_text().strip()
    except Exception:
        pass
    return 'v0.0.0'

version = _read_version()


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

# Edit conflict prevention: track which items are being edited by whom
# key=(tab, item_id) -> value=sid (socket session id)
_item_locks: dict = {}
_item_locks_lock = threading.Lock()


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
app.config['SECRET_KEY'] = os.urandom(24).hex()

# Flask-SocketIO for real-time collaboration
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

UPLOAD_DIR_NAME = 'images'
data_dir: Path = BASE_DIR / 'data'
mybase_dir: Path = data_dir / 'mybase'
user_data_dir: Path = data_dir / 'user'
index_db_dir: Path = data_dir / 'db' / 'index_db'
common_db: Path = data_dir / 'db' / 'common.db'
server_port = 9999
force_index_target = None
ocr_disabled = False
ocr_debug = False
ocr_mobile = False
workers_ocr = 8
workers_menu = 8
_file_logger = None

def ocr_log(msg: str):
    """Write a timestamped debug message to mybase.log.
    No-op when --no-debug is active.
    Thread-safe via logging.FileHandler.
    """
    if _file_logger is not None and ocr_debug:
        _file_logger.info(msg)
        # Flush immediately so the log is visible in real time
        # (especially important on Windows where the default file
        # buffering delays writes until process exit).
        for h in _file_logger.handlers:
            h.flush()


def log_error(func_name: str, error: Exception, extra: str = ""):
    """Log an exception with function name to screen **and** mybase.log.
    Always writes to both screen and log file regardless of --no-debug.
    """
    err_msg = f"{func_name}: {error}"
    if extra:
        err_msg += f" ({extra})"
    print(f"  [ERROR] {err_msg}", flush=True)
    # Write directly to file (bypasses ocr_log's debug guard)
    if _file_logger is not None:
        _file_logger.info(f"[ERROR] {err_msg}")
        for h in _file_logger.handlers:
            h.flush()


def parse_args():
    parser = argparse.ArgumentParser(
        description=f'Web of Mybase Knowledge Server  {version}',
        epilog="Note: The mobile OCR model is enabled by default. Disable with --mobile-ocr false.")
    parser.add_argument('--data', type=str, default='data',
                        help='Data root directory (default: data)')
    parser.add_argument('--port', type=int, default=9999,
                        help='Server port (default: 9999)')
    parser.add_argument('--force-index', type=str, nargs='?', const='all', default=None,
                        help='Force reindex a specific knowledge base. If no name given, reindex all.')
    parser.add_argument('--disable-ocr', action='store_true',
                        help='Disable OCR image text indexing.')
    parser.add_argument('--mobile-ocr', type=str, default='true', dest='mobile_ocr',
                        choices=['true', 'false'], metavar='true|false',
                        help='Use lightweight mobile OCR model (less accurate but lower memory usage). Default: enabled.')
    parser.add_argument('--workers-ocr', type=int, default=8,
                        help='Number of OCR worker processes (default: 8, each owns 1 PaddleOCR instance; Windows limited to 1)')
    parser.add_argument('--workers-menu', type=int, default=8,
                        help='Number of parallel menu item indexing workers (default: 8; Windows limited to 1)')
    parser.add_argument('--no-debug', action='store_false', dest='debug', default=True,
                        help='Disable verbose debug logging to mybase.log.')
    parser.add_argument('--single-user', action='store_true',
                        help='Single-user mode: skip login, auto-admin. Hides login UI.')
    return parser.parse_args()


_single_user_mode = False


def init_config():
    global data_dir, mybase_dir, index_db_dir, common_db, server_port, force_index_target, ocr_disabled, ocr_mobile, workers_ocr, workers_menu, ocr_debug, _file_logger, _single_user_mode
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
    _single_user_mode = args.single_user

    ocr_mobile = (args.mobile_ocr == 'true')

    # Windows: limit workers to 1 to avoid multiprocessing & thread-pool issues
    if os.name == "nt":
        if workers_ocr > 1:
            workers_ocr = 1
        if workers_menu > 1:
            workers_menu = 1

    # Propagate ocr_mobile to OCR worker processes via environment variable
    os.environ['OCR_MOBILE'] = '1' if ocr_mobile else '0'
    data_dir.mkdir(exist_ok=True)
    (data_dir / 'db').mkdir(exist_ok=True)
    mybase_dir.mkdir(exist_ok=True)
    # Initialize file logger for mybase.log (always created for error logging)
    _file_logger = logging.getLogger('mybase')
    _file_logger.setLevel(logging.DEBUG)
    _file_logger.handlers.clear()
    log_path = BASE_DIR / 'mybase.log'
    handler = logging.FileHandler(str(log_path), mode='a', encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
    _file_logger.addHandler(handler)
    if ocr_debug:
        _file_logger.info(f"========== Session Start (workers-ocr={workers_ocr}, workers-menu={workers_menu}) ==========")
    print(f"  Log file: {log_path}")


_SYSTEM_TAB_DIRS = frozenset(['content', 'images', '__pycache__'])


def _is_valid_tab_dir(name: str) -> bool:
    """Check if a directory name could be a valid tab (not a system directory)."""
    return bool(name) and not name.startswith('.') and name not in _SYSTEM_TAB_DIRS


def get_tab_path(tab_name):
    """Get tab path checking owner subdirectories first, then root."""
    tab_path = mybase_dir / tab_name
    if tab_path.exists() and tab_path.is_dir():
        return tab_path
    # Check user subdirectories
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                sub_path = user_entry / tab_name
                if sub_path.exists() and sub_path.is_dir():
                    return sub_path
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

    # Check both plain and encrypted menu.json
    menu_exists = menu_path.exists() or (menu_path.with_suffix('.json.enc')).exists()
    if menu_exists:
        raw = read_tab_text(tab_name, 'menu.json')
        if raw is not None:
            try:
                data = json.loads(raw)
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
        json_str = json.dumps(menu_data, ensure_ascii=False, indent=2)
        write_tab_text(tab_name, 'menu.json', json_str)
        menu_js = menu_path.with_name('menu.js')
        js_content = 'var MENU_DATA = ' + json.dumps(menu_data, ensure_ascii=False) + ';'
        # menu.js is always plain-text (frontend reads it directly for standalone export)
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
    # Check both plain and encrypted versions
    if content_file.exists() or (content_file.with_suffix(content_file.suffix + '.enc')).exists():
        return content_file, 'html'

    menu = load_menu(tab_name)
    item = find_menu_item(menu, item_id)
    if item and 'href' in item:
        href_path = tab_path / item['href']
        if href_path.exists() or (href_path.with_suffix(href_path.suffix + '.enc')).exists():
            return href_path, 'qrich'
    return None, None


def load_content(tab_name, item_id):
    content_file, ctype = find_content_file(tab_name, item_id)
    if content_file:
        raw = read_tab_text(tab_name, content_file.relative_to(tab_path_for_rel(tab_name)))
        if raw is None:
            return ''
        if ctype == 'qrich':
            return _extract_body_from_qrich(raw)
        return raw
    return ''


def tab_path_for_rel(tab_name):
    """Return the base path for a tab, for computing relative paths."""
    return get_tab_path(tab_name)


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
            log_error("index_tab._process", e, item['label'])
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
                    log_error("index_tab.worker", e)
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
    tabs = set()
    if mybase_dir.exists():
        for entry in sorted(mybase_dir.iterdir()):
            if entry.is_dir() and _is_valid_tab_dir(entry.name):
                tabs.add(entry.name)
    if user_data_dir.exists():
        for user_entry in sorted(user_data_dir.iterdir()):
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                for tab_entry in sorted(user_entry.iterdir()):
                    if tab_entry.is_dir() and _is_valid_tab_dir(tab_entry.name):
                        tabs.add(tab_entry.name)
    for tab in sorted(tabs):
        index_tab(tab)


def search_index(tab_name, query, use_regex=False):
    """Search within a single tab's index. Returns list of result dicts.

    When *use_regex* is True, *query* is treated as a regular expression
    pattern (``re.IGNORECASE``).  Raises ``ValueError`` on invalid regex.

    When *use_regex* is False, the query supports four formats:
      - ``xxxx``                  — single-term simple search (SQL LIKE).
      - ``aaa | bbb | ccc``       — OR mode: match any term (pipe-separated).
      - ``aaa bbb ccc`` or
        ``aaa && bbb && ccc``     — AND mode: all terms must match.
      - ``aaa ^ bbb``             — EXCLUDE mode: ``aaa`` must exist AND
                                    ``bbb`` must NOT exist.
    """
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return []

    if use_regex:
        return _search_index_regex(tab_name, query, db_path)

    query = query.strip()

    # ── OR mode: split by | ──────────────────────────────────────────
    if '|' in query:
        terms = [q.strip() for q in query.split('|') if q.strip()]
        if len(terms) > 1:
            return _search_index_multi(tab_name, terms, 'or', db_path)

    # ── EXCLUDE mode: split by ^ (must have | must NOT have) ───────
    if '^' in query:
        parts = query.split('^')
        include_str = parts[0].strip()
        exclude_str = ' '.join(p.strip() for p in parts[1:]).strip()
        if include_str and exclude_str:
            _split_terms = lambda s: [t.strip() for t in s.replace('&&', ' ').split() if t.strip()]
            include_terms = _split_terms(include_str)
            exclude_terms = _split_terms(exclude_str)
            if include_terms and exclude_terms:
                return _search_index_exclude(tab_name, include_terms, exclude_terms, db_path)

    # ── AND mode: split by && or whitespace ─────────────────────────
    if '&&' in query:
        terms = [q.strip() for q in query.split('&&') if q.strip()]
    else:
        terms = query.split()

    if len(terms) > 1:
        return _search_index_multi(tab_name, terms, 'and', db_path)

    # ── Simple mode (single term) — fast SQL LIKE ───────────────────
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


def _search_index_exclude(tab_name, include_terms, exclude_terms, db_path):
    """Exclusion search — all *include_terms* must exist AND none of
    *exclude_terms* may exist in a matching item.

    Args:
        tab_name: knowledge base tab name.
        include_terms: terms that MUST be present (AND logic).
        exclude_terms: terms that must NOT be present (any match excludes).
        db_path: path to the SQLite index database.

    Returns:
        List of result dicts (same schema as :func:`search_index`).
    """
    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.execute(
            "SELECT menu_item_id, label, content_text, menu_path FROM item_index "
            "ORDER BY menu_path"
        )
        results = []
        seen_ids = set()
        include_lower = [t.lower() for t in include_terms if t]
        exclude_lower = [t.lower() for t in exclude_terms if t]

        for row in cursor.fetchall():
            content_text = row[2] or ''
            label_lower = row[1].lower()
            content_lower = content_text.lower()

            # All include terms must match
            if not all(
                tl in label_lower or tl in content_lower
                for tl in include_lower
            ):
                continue

            # No exclude term may match
            if any(
                tl in label_lower or tl in content_lower
                for tl in exclude_lower
            ):
                continue

            if row[0] in seen_ids:
                continue
            seen_ids.add(row[0])

            # Snippet from first include term
            matched_term = include_terms[0]
            snippet = ''
            if matched_term.lower() in row[1].lower():
                snippet = row[1]
            elif matched_term.lower() in content_text.lower():
                snippet = make_snippet(content_text, matched_term)
            else:
                snippet = content_text[:80]

            results.append({
                'menu_item_id': row[0],
                'label': row[1],
                'menu_path': row[3],
                'snippet': snippet,
                'tab': tab_name,
            })
            if len(results) >= 50:
                break

        return results
    finally:
        conn.close()


def _search_index_multi(tab_name, terms, mode, db_path):
    """Multi-term search (OR/AND) — iterates all rows, filters in Python.

    Args:
        tab_name: knowledge base tab name.
        terms: list of term strings to search for.
        mode: ``'or'`` (match any) or ``'and'`` (match all).
        db_path: path to the SQLite index database.

    Returns:
        List of result dicts (same schema as :func:`search_index`).
    """
    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.execute(
            "SELECT menu_item_id, label, content_text, menu_path FROM item_index "
            "ORDER BY menu_path"
        )
        results = []
        seen_ids = set()
        terms_lower = [t.lower() for t in terms if t]

        for row in cursor.fetchall():
            content_text = row[2] or ''
            label_lower = row[1].lower()
            content_lower = content_text.lower()

            if mode == 'or':
                # Match ANY term
                match_idx = -1
                for i, tl in enumerate(terms_lower):
                    if tl in label_lower or tl in content_lower:
                        match_idx = i
                        break
                if match_idx == -1:
                    continue
                if row[0] in seen_ids:
                    continue
                seen_ids.add(row[0])
                matched_term = terms[match_idx]
            else:  # 'and'
                # Match ALL terms
                if not all(
                    tl in label_lower or tl in content_lower
                    for tl in terms_lower
                ):
                    continue
                matched_term = terms[0]

            # Build snippet around the matched term
            snippet = ''
            if matched_term.lower() in row[1].lower():
                snippet = row[1]
            elif matched_term.lower() in content_text.lower():
                snippet = make_snippet(content_text, matched_term)
            else:
                snippet = content_text[:80]

            results.append({
                'menu_item_id': row[0],
                'label': row[1],
                'menu_path': row[3],
                'snippet': snippet,
                'tab': tab_name,
            })
            if len(results) >= 50:
                break

        return results
    finally:
        conn.close()


def _search_index_regex(tab_name, pattern, db_path):
    # Preprocess: split by unescaped |, trim whitespace on each sub-expression.
    # This lets users type "abc | def" naturally instead of needing "abc|def".
    parts = re.split(r'(?<!\\)\|', pattern)
    if len(parts) > 1:
        pattern = '|'.join(p.strip() for p in parts)
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"无效的正则表达式: {e}")

    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.execute(
            "SELECT menu_item_id, label, content_text, menu_path FROM item_index "
            "ORDER BY menu_path"
        )
        results = []
        for row in cursor.fetchall():
            content_text = row[2] or ''
            label_match = regex.search(row[1])
            content_match = regex.search(content_text) if content_text else None

            if not label_match and not content_match:
                continue

            if label_match:
                snippet = row[1]
            elif content_match:
                start = max(0, content_match.start() - 40)
                end = min(len(content_text), content_match.end() + 40)
                snippet = content_text[start:end]
                if start > 0:
                    snippet = '...' + snippet
                if end < len(content_text):
                    snippet = snippet + '...'
            else:
                snippet = content_text[:80]

            results.append({
                'menu_item_id': row[0],
                'label': row[1],
                'menu_path': row[3],
                'snippet': snippet,
                'tab': tab_name,
            })
            if len(results) >= 50:
                break

        return results
    finally:
        conn.close()


def _tab_searchable(tab_name):
    """Check whether a tab can be searched for the current session.

    Encrypted tabs are only searchable if the calling session has unlocked
    them. Each window independently controls which tabs it can search.
    """
    if is_tab_encrypted(tab_name) and get_cached_encryption_key(tab_name, _get_current_sid()) is None:
        return False
    return True


def search_all_tabs(query, use_regex=False):
    """Search across all indexed knowledge bases (skips encrypted-not-unlocked tabs)."""
    results = []
    if index_db_dir.exists():
        for db_file in sorted(index_db_dir.glob("*.db")):
            tab_name = db_file.stem
            if not _tab_searchable(tab_name):
                continue
            results.extend(search_index(tab_name, query, use_regex=use_regex))
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


def update_item_meta_in_index(tab_name, item_id, label, path):
    """Update only label and menu_path for a menu item (no content/OCR)."""
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "UPDATE item_index SET label = ?, menu_path = ? WHERE menu_item_id = ?",
            (label, path, item_id)
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


def _index_db_has_rows(tab_name):
    """Check if an index DB has any indexed items."""
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return False
    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.execute("SELECT COUNT(*) FROM item_index")
        return cursor.fetchone()[0] > 0
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


def ensure_indexes():
    """On startup: delete orphan index files, auto-index new tabs, force-index if requested."""
    index_db_dir.mkdir(exist_ok=True)

    tabs = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and _is_valid_tab_dir(entry.name):
                tabs.add(entry.name)
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                for tab_entry in user_entry.iterdir():
                    if tab_entry.is_dir() and _is_valid_tab_dir(tab_entry.name):
                        tabs.add(tab_entry.name)

    for db_file in list(index_db_dir.glob("*.db")):
        if db_file.stem not in tabs:
            print(f"  Removing orphan index: {db_file.stem}")
            db_file.unlink()

    # ── Ensure all tabs have visibility and order entries ──
    # Tabs copied directly into mybase/ won't have entries in common.db,
    # which excludes them from global search (_get_visible_tab_names).
    for tab in sorted(tabs):
        add_tab_to_order(tab)
        init_tab_visibility(tab)

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
                log_error("ensure_indexes", e, f"creating index for {tab}")

    # ── Rebuild stale empty indexes ──
    # If an index DB exists but has 0 rows (e.g. initial index_tab ran before
    # any menu items existed), re-index to populate it.
    for tab in sorted(tabs):
        if tab in indexed and tab not in skip_auto:
            if not _index_db_has_rows(tab):
                menu = load_menu(tab)
                if menu:  # tab has content but empty index → stale
                    print(f"  Rebuilding stale empty index for tab: {tab}")
                    try:
                        index_tab(tab)
                    except Exception as e:
                        log_error("ensure_indexes", e, f"rebuilding index for {tab}")

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
                    log_error("ensure_indexes", e, f"reindexing {tab}")
        elif force_index_target in tabs:
            print(f"  Force reindexing: {force_index_target}")
            try:
                index_tab(force_index_target)
            except Exception as e:
                log_error("ensure_indexes", e, f"reindexing {force_index_target}")
        else:
            print(f"  Warning: Knowledge base '{force_index_target}' not found, skipping.")



# ─── OCR Process Pool ───────────────────────────────────────────────────
# Each worker process owns exactly 1 PaddleOCR instance, avoiding both
# the GIL contention of threads and the fork-safety issues of sharing
# instances across processes.

#PaddleOCR 3.5 using below , and set PADDLE_PDX_CACHE_HOME
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

    # Read ocr_mobile from the env var set by init_config() in the parent process.
    # Default to mobile ('1') for safety if the var is somehow absent.
    _use_mobile = os.environ.get('OCR_MOBILE', '1') == '1'

    from paddleocr import PaddleOCR
    try:
        import paddle as _paddle
        _paddle.disable_signal_handler()
    except (ImportError, AttributeError):
        pass

    _kwargs = dict(
        use_textline_orientation=True,
        lang='ch',
        device='cpu',
        enable_mkldnn=False,
        ocr_version="PP-OCRv5",
    )
    if _use_mobile:
        _kwargs['text_detection_model_name'] = "PP-OCRv5_mobile_det"
        _kwargs['text_recognition_model_name'] = "PP-OCRv5_mobile_rec"
    else:
        _kwargs['text_detection_model_name'] = "PP-OCRv5_server_det"
        _kwargs['text_recognition_model_name'] = "PP-OCRv5_server_rec"

    with suppress_stdout_stderr():
        return PaddleOCR(**_kwargs)


def _ocr_worker(task_queue, result_queue):
    """Worker entry point: init → loop reading tasks → write results."""
    # Ignore SIGINT inherited from parent so workers aren't killed by CTRL+C.
    # Workers exit via sentinel in the task queue, not by signals.
    import signal as _signal
    _signal.signal(_signal.SIGINT, _signal.SIG_IGN)

    try:
        _ocr = _ocr_worker_init()
    except BaseException as e:
        log_error("_ocr_worker.init", e, "PaddleOCR init failed, OCR disabled")
        return

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
            # OCR prediction failed for this image; return empty text
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
                log_error("extract_text_from_html_images.decode", e)
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
            log_error("extract_text_from_html_images.cleanup", e)

    return ' '.join(t for t in texts if t).strip()


# ─── Common Database (tab_order, general config) ───────────────────────────


def init_common_db():
    """Create common.db and tables if not exists."""
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
                visible INTEGER NOT NULL DEFAULT 1,
                is_active INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_current_item (
                tab_name TEXT PRIMARY KEY,
                current_item_id TEXT NOT NULL,
                scroll_top INTEGER NOT NULL DEFAULT 0
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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS system_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            INSERT OR IGNORE INTO system_config (name, value)
            VALUES ('version', 'v4.5.4')
        """)
        # ── User authentication tables ──
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_owner (
                tab_name TEXT PRIMARY KEY,
                owner TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_tab_visibility (
                username TEXT NOT NULL,
                tab_name TEXT NOT NULL,
                visible INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (username, tab_name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_tab_current_item (
                username TEXT NOT NULL,
                tab_name TEXT NOT NULL,
                current_item_id TEXT NOT NULL DEFAULT '',
                scroll_top INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (username, tab_name)
            )
        """)
        # ── Public edit (discussion mode) ──
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_public_edit (
                tab_name TEXT PRIMARY KEY,
                public_edit INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.commit()
    finally:
        conn.close()
    _init_password_tables()
    _init_user_tables()


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
            "INSERT OR IGNORE INTO tab_kb_visibility (tab_name, visible, is_active) VALUES (?, 1, 0)",
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
            "INSERT OR REPLACE INTO tab_kb_visibility (tab_name, visible, is_active) "
            "VALUES (?, ?, COALESCE((SELECT is_active FROM tab_kb_visibility WHERE tab_name = ?), 0))",
            (tab_name, 1 if visible else 0, tab_name)
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
        # Preserve the currently selected tab across the batch replace
        cursor = conn.execute("SELECT tab_name FROM tab_kb_visibility WHERE is_active = 1")
        row = cursor.fetchone()
        selected_tab = row[0] if row else None

        conn.execute("DELETE FROM tab_kb_visibility")
        for name, visible in visibility_dict.items():
            is_active = 1 if name == selected_tab else 0
            conn.execute(
                "INSERT INTO tab_kb_visibility (tab_name, visible, is_active) VALUES (?, ?, ?)",
                (name, 1 if visible else 0, is_active)
            )
        conn.commit()
    finally:
        conn.close()


def get_user_tab_visibility(username: str) -> dict:
    """Return dict of {tab_name: bool} for a specific user's own tabs."""
    if not common_db.exists():
        return {}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT tab_name, visible FROM user_tab_visibility WHERE username = ?",
            (username,)
        )
        return {row[0]: bool(row[1]) for row in cursor.fetchall()}
    finally:
        conn.close()


def set_user_tab_visibility_batch(username: str, visibility_dict: dict):
    """Save per-user visibility. Only processes tabs owned by this user."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        for name, visible in visibility_dict.items():
            owner = get_tab_owner(name)
            if owner == username:
                # Preserve sort_order and is_active from existing row
                cursor = conn.execute(
                    "SELECT sort_order, is_active FROM user_tab_visibility WHERE username = ? AND tab_name = ?",
                    (username, name)
                )
                row = cursor.fetchone()
                sort_order = row[0] if row else 0
                is_active = row[1] if row else 0
                conn.execute(
                    "INSERT OR REPLACE INTO user_tab_visibility "
                    "(username, tab_name, visible, sort_order, is_active) VALUES (?, ?, ?, ?, ?)",
                    (username, name, 1 if visible else 0, sort_order, is_active)
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


def get_selected_tab():
    """Return the tab_name that is currently selected (last active), or None."""
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_kb_visibility WHERE is_active = 1")
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def set_selected_tab(tab_name):
    """Mark a single tab as the currently selected tab, deselect others."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("UPDATE tab_kb_visibility SET is_active = 0")
        conn.execute("UPDATE tab_kb_visibility SET is_active = 1 WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()


def set_user_selected_tab(username: str, tab_name: str):
    """Mark a tab as the currently selected tab for a specific user.
    Falls back to INSERT if no user_tab_visibility row exists yet."""
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("UPDATE user_tab_visibility SET is_active = 0 WHERE username = ?", (username,))
        cursor = conn.execute(
            "UPDATE user_tab_visibility SET is_active = 1 WHERE username = ? AND tab_name = ?",
            (username, tab_name)
        )
        if cursor.rowcount == 0:
            conn.execute(
                "INSERT INTO user_tab_visibility (username, tab_name, visible, sort_order, is_active) VALUES (?, ?, 1, 0, 1)",
                (username, tab_name)
            )
        conn.commit()
    finally:
        conn.close()


def get_user_selected_tab(username: str) -> str | None:
    """Return the tab_name that the user last selected, or None."""
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT tab_name FROM user_tab_visibility WHERE username = ? AND is_active = 1",
            (username,)
        )
        row = cursor.fetchone()
        return row[0] if row else None
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


def get_system_config(name):
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT value FROM system_config WHERE name = ?", (name,)
        )
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def set_system_config(name, value):
    """Upsert a key-value pair in system_config table."""
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO system_config (name, value) VALUES (?, ?)",
            (name, value)
        )
        conn.commit()
    finally:
        conn.close()


# ─── End Common Database ──────────────────────────────────────────────────


# === User Authentication System =============================================

# In-memory session store: session_token -> {username, sid}
_user_sessions: dict[str, dict] = {}
_user_sessions_lock = threading.Lock()


def _init_user_tables():
    """Seed default admin user if no users exist."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT COUNT(*) FROM users")
        count = cursor.fetchone()[0]
        if count == 0:
            pw_hash = bcrypt.hashpw(b'1234', bcrypt.gensalt()).decode('utf-8')
            conn.execute(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                ('admin', pw_hash, 'admin')
            )
            conn.commit()
    finally:
        conn.close()


def get_user(username: str) -> dict | None:
    """Return user dict {username, password_hash, role} or None."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT username, password_hash, role FROM users WHERE username = ? COLLATE NOCASE",
            (username,)
        )
        row = cursor.fetchone()
        if row:
            return {'username': row[0], 'password_hash': row[1], 'role': row[2]}
        return None
    finally:
        conn.close()


def get_all_users() -> list[dict]:
    """Return list of all non-admin users."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT username, role FROM users WHERE role != 'admin' ORDER BY username"
        )
        return [{'username': row[0], 'role': row[1]} for row in cursor.fetchall()]
    finally:
        conn.close()


def create_user(username: str, password: str) -> str:
    """Create a new normal user. Returns error string or '' on success."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (username,)
        )
        if cursor.fetchone():
            return '用户名已存在'
        pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        conn.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')",
            (username, pw_hash)
        )
        conn.commit()
        (user_data_dir / username).mkdir(parents=True, exist_ok=True)
        return ''
    finally:
        conn.close()


def delete_user(username: str) -> str:
    """Delete a normal user and move their KBs to admin. Returns error or ''."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT role FROM users WHERE username = ? COLLATE NOCASE", (username,)
        )
        row = cursor.fetchone()
        if not row:
            return '用户不存在'
        if row[0] == 'admin':
            return '不能删除admin用户'

        # 1. Find all tabs owned by this user and set owner to '' (admin)
        cursor2 = conn.execute(
            "SELECT tab_name FROM tab_owner WHERE owner = ? COLLATE NOCASE", (username,)
        )
        owned_tabs = [r[0] for r in cursor2.fetchall()]

        # 2. Move tab directories from user's folder to admin's folder
        user_base = user_data_dir / username
        for tab_name in owned_tabs:
            tab_path = user_data_dir / username / tab_name
            admin_path = mybase_dir / tab_name
            if tab_path.exists() and tab_path.is_dir():
                if admin_path.exists():
                    shutil.move(str(tab_path), str(mybase_dir / f"{tab_name}_migrated_{uuid.uuid4().hex[:4]}"))
                else:
                    shutil.move(str(tab_path), str(admin_path))
                old_db = get_index_db_path(f"{username}/{tab_name}")
                new_db = get_index_db_path(tab_name)
                if old_db.exists():
                    if new_db.exists():
                        old_db.unlink()
                    else:
                        old_db.rename(new_db)

        # 3. Set owner to '' for all tabs that belonged to this user
        conn.execute(
            "UPDATE tab_owner SET owner = '' WHERE owner = ? COLLATE NOCASE",
            (username,)
        )

        # 4. Delete user-related records
        conn.execute("DELETE FROM users WHERE username = ? COLLATE NOCASE", (username,))
        conn.execute("DELETE FROM user_tab_visibility WHERE username = ? COLLATE NOCASE", (username,))
        conn.execute("DELETE FROM user_tab_current_item WHERE username = ? COLLATE NOCASE", (username,))
        conn.commit()

        # 5. Force-logout all sessions for this user
        with _user_sessions_lock:
            tokens_to_remove = [
                token for token, sess in _user_sessions.items()
                if sess['username'].lower() == username.lower()
            ]
            for token in tokens_to_remove:
                sess = _user_sessions.pop(token, None)
                if sess and sess.get('sid'):
                    try:
                        socketio.emit('force_logout', {'reason': '用户已被管理员删除'}, room=sess['sid'])
                    except Exception:
                        pass

        # Notify admin windows to refresh tab owner badges
        try:
            socketio.emit('tabs_updated', {}, room='admin_sync')
        except Exception:
            pass

        # 6. Remove user's KB directory if empty
        if user_base.exists() and user_base.is_dir():
            try:
                remaining = list(user_base.iterdir())
                if not remaining:
                    shutil.rmtree(str(user_base), ignore_errors=True)
            except Exception:
                pass

        return ''
    finally:
        conn.close()


def update_user_password(username: str, new_password: str) -> str:
    """Update a user's password. Returns '' on success or error string."""
    conn = sqlite3.connect(str(common_db))
    try:
        pw_hash = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ? COLLATE NOCASE",
            (pw_hash, username)
        )
        conn.commit()
        return ''
    finally:
        conn.close()


def force_reset_user_password(username: str, new_password: str) -> str:
    """Admin force-resets a user's password. Resets all sessions. Returns '' or error."""
    user = get_user(username)
    if not user:
        return '用户不存在'
    if user['role'] == 'admin':
        return '不能重置admin密码'
    err = update_user_password(username, new_password)
    if err:
        return err
    # Reset all sessions for this user
    with _user_sessions_lock:
        tokens_to_remove = [
            token for token, sess in _user_sessions.items()
            if sess['username'].lower() == username.lower()
        ]
        for token in tokens_to_remove:
            sess = _user_sessions.pop(token, None)
            if sess and sess.get('sid'):
                try:
                    socketio.emit('force_logout', {
                        'reason': '管理员已重置您的密码，请重新登录'
                    }, room=sess['sid'])
                except Exception:
                    pass
    return ''


def verify_login(username: str, password: str) -> dict | None:
    """Verify username/password. Returns session info dict or None on failure."""
    user = get_user(username)
    if not user:
        return None
    if not bcrypt.checkpw(password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        return None
    # Create session token
    token = str(uuid.uuid4())
    with _user_sessions_lock:
        _user_sessions[token] = {
            'username': user['username'],
            'role': user['role'],
            'sid': _get_current_sid(),
        }
    return {
        'token': token,
        'username': user['username'],
        'role': user['role'],
    }


def logout_session(token: str):
    """Remove a session token."""
    with _user_sessions_lock:
        _user_sessions.pop(token, None)


def get_session_user(token: str) -> dict | None:
    """Return user info for a valid session token, or None."""
    with _user_sessions_lock:
        sess = _user_sessions.get(token)
        if sess:
            sid = _get_current_sid()
            if sid:
                sess['sid'] = sid
            return {'username': sess['username'], 'role': sess['role']}
    # Single-user mode: act as admin regardless of token sent
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    return None


def require_auth():
    """Check request for valid auth. Returns user dict or sends 401."""
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        abort(401, description='未登录或会话已过期')
    return user


def require_admin():
    """Check request for admin auth. Returns user dict or sends 403."""
    user = require_auth()
    if user['role'] != 'admin':
        abort(403, description='需要管理员权限')
    return user


def _is_tab_name_globally_used(name: str) -> tuple[bool, str]:
    """Check if a tab name exists in any user's directory or admin directory.
    Returns (exists, owner_username) where owner is '' for admin-owned tabs."""
    if mybase_dir.exists() and (mybase_dir / name).is_dir():
        return True, get_tab_owner(name)
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                if (user_entry / name).is_dir():
                    return True, get_tab_owner(name)
    return False, ''


def get_tab_owner(tab_name: str) -> str:
    """Return owner username for a tab, or '' if admin-owned."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT owner FROM tab_owner WHERE tab_name = ?", (tab_name,)
        )
        row = cursor.fetchone()
        if row:
            return row[0]
        return ''
    finally:
        conn.close()


def set_tab_owner(tab_name: str, owner: str):
    """Set owner for a tab. Owner '' means admin-owned."""
    conn = sqlite3.connect(str(common_db))
    try:
        if owner == '':
            conn.execute("DELETE FROM tab_owner WHERE tab_name = ?", (tab_name,))
        else:
            conn.execute(
                "INSERT OR REPLACE INTO tab_owner (tab_name, owner) VALUES (?, ?)",
                (tab_name, owner)
            )
        conn.commit()
    finally:
        conn.close()


def get_tab_public_edit(tab_name: str) -> bool:
    """Check if a tab has public edit (discussion mode) enabled."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT public_edit FROM tab_public_edit WHERE tab_name = ?", (tab_name,)
        )
        row = cursor.fetchone()
        return bool(row and row[0])
    finally:
        conn.close()


def set_tab_public_edit(tab_name: str, enabled: bool):
    """Set public edit status for a tab."""
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO tab_public_edit (tab_name, public_edit) VALUES (?, ?)",
            (tab_name, 1 if enabled else 0)
        )
        conn.commit()
    finally:
        conn.close()


def get_all_tab_public_edits() -> dict:
    """Return dict of {tab_name: bool} for all tabs with public edit."""
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, public_edit FROM tab_public_edit WHERE public_edit = 1")
        return {row[0]: bool(row[1]) for row in cursor.fetchall()}
    finally:
        conn.close()


def get_tab_effective_path(tab_name: str) -> Path:
    """Return the actual directory path for a tab based on its owner."""
    owner = get_tab_owner(tab_name)
    if owner and owner != '':
        user_base = user_data_dir / owner
        user_base.mkdir(exist_ok=True)
        tab_path = user_base / tab_name
        return tab_path
    # Admin/empty owner tabs are in mybase root
    return mybase_dir / tab_name


def get_tab_path_with_owner(tab_name: str) -> Path | None:
    """Get tab path considering ownership. Handles migrated paths."""
    # First check user-specific directory
    owner = get_tab_owner(tab_name)
    if owner and owner != '':
        user_path = user_data_dir / owner / tab_name
        if user_path.exists() and user_path.is_dir():
            return user_path
    # Fall back to root mybase
    root_path = mybase_dir / tab_name
    if root_path.exists() and root_path.is_dir():
        return root_path
    return None


def get_effective_tab_path(tab_name: str) -> Path | None:
    """Get tab path, checking owner directory first, then root."""
    return get_tab_path_with_owner(tab_name)


# Also override the original get_tab_path internally
def _get_tab_path_with_owner(tab_name):
    """Override-compatible: check owner directory then root."""
    return get_tab_path_with_owner(tab_name)


def can_read_tab(tab_name: str, user: dict) -> bool:
    """Check if user can read a tab."""
    owner = get_tab_owner(tab_name)
    if user['role'] == 'admin':
        return True
    if owner == '' or owner == user['username']:
        return True
    return False


def can_write_tab(tab_name: str, user: dict) -> bool:
    """Check if user can modify content/tabs for a tab."""
    owner = get_tab_owner(tab_name)
    if user['role'] == 'admin':
        return True
    if owner == user['username']:
        return True
    # Public edit (discussion mode): any authenticated user can write
    if get_tab_public_edit(tab_name):
        return True
    return False


def can_delete_tab(tab_name: str, user: dict) -> bool:
    """Check if user can delete a tab."""
    return user['role'] == 'admin'


def can_export_tab(tab_name: str, user: dict) -> bool:
    """Check if user can export a tab."""
    if user['role'] == 'admin':
        return True
    owner = get_tab_owner(tab_name)
    if owner == user['username']:
        return True
    # Discussion tabs (public edit) — any authenticated user can export
    if get_tab_public_edit(tab_name):
        return True
    return False


def get_user_visible_tabs(username: str, role: str) -> list[str]:
    """Return list of tab names visible to a user, in user's order."""
    conn = sqlite3.connect(str(common_db))
    try:
        all_tabs = set()
        if mybase_dir.exists():
            for entry in mybase_dir.iterdir():
                if entry.is_dir() and _is_valid_tab_dir(entry.name):
                    all_tabs.add(entry.name)
        if user_data_dir.exists():
            for user_entry in user_data_dir.iterdir():
                if user_entry.is_dir() and not user_entry.name.startswith('.'):
                    for tab_entry in user_entry.iterdir():
                        if tab_entry.is_dir() and _is_valid_tab_dir(tab_entry.name):
                            all_tabs.add(tab_entry.name)

        if role == 'admin':
            # Admin sees all tabs from all users
            ordered = []
            cursor = conn.execute(
                "SELECT tab_name FROM tab_order ORDER BY sort_order"
            )
            global_ordered = [r[0] for r in cursor.fetchall()]
            for t in global_ordered:
                if t in all_tabs:
                    ordered.append(t)
            for t in sorted(all_tabs):
                if t not in ordered:
                    ordered.append(t)
            return ordered

        # Non-admin: only see tabs owned by self or admin (owner='')
        visible = []
        cursor = conn.execute(
            "SELECT tab_name, owner FROM tab_owner"
        )
        owner_map = dict(cursor.fetchall())

        # Get user's personal tab order
        cursor = conn.execute(
            "SELECT tab_name, sort_order FROM user_tab_visibility WHERE username = ? AND visible = 1 ORDER BY sort_order",
            (username,)
        )
        user_ordered = [(r[0], r[1]) for r in cursor.fetchall()]

        # Tabs visible to this user: owned by user OR owned by admin (empty)
        user_tabs = set()
        for tab in all_tabs:
            owner = owner_map.get(tab, '')
            if owner == '' or owner == username:
                user_tabs.add(tab)

        # Return in user's order, then alphabetical for the rest
        ordered = []
        seen = set()
        for tab_name, _ in user_ordered:
            if tab_name in user_tabs:
                ordered.append(tab_name)
                seen.add(tab_name)
        # Add admin tabs in global order
        global_cursor = conn.execute(
            "SELECT tab_name FROM tab_order ORDER BY sort_order"
        )
        for r in global_cursor:
            if r[0] in user_tabs and r[0] not in seen:
                ordered.append(r[0])
                seen.add(r[0])
        for t in sorted(user_tabs):
            if t not in seen:
                ordered.append(t)
        return ordered
    finally:
        conn.close()


# === End User Authentication System =========================================


# === Password & Encryption System ==========================================

# Per-session cache of derived AES keys for unlocked encrypted tabs.
# Structure: {socket_sid: {tab_name: 32-byte AES key}}
# Each browser window/tab has its own Socket.IO session ID (sid).
# A window only has access to keys it personally unlocked.
# When a socket disconnects, its keys are automatically cleaned up.
_session_encryption_keys: dict[str, dict[str, bytes]] = {}
_session_encryption_keys_lock = threading.Lock()


def _get_current_sid() -> str | None:
    """Extract the client's Socket.IO session ID from the current request.

    Works in both REST routes (via X-Socket-ID header) and Socket.IO
    handlers (via request.sid). Returns None outside request context
    (background threads, startup, etc.).
    """
    from flask import request as _flask_req
    try:
        # Socket.IO handler context — request.sid is injected by Flask-SocketIO
        return _flask_req.sid
    except (AttributeError, RuntimeError):
        pass
    try:
        # REST handler context (frontend sends X-Socket-ID on every API call)
        return _flask_req.headers.get('X-Socket-ID')
    except RuntimeError:
        # No request context at all
        return None


def _init_password_tables():
    """Create password/encryption tables in common.db if not exists."""
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_passwords (
                tab_name TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                enc_salt BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.commit()
    finally:
        conn.close()


def is_tab_encrypted(tab_name: str) -> bool:
    """Check if a knowledge base has a password set."""
    if not common_db.exists():
        return False
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT 1 FROM tab_passwords WHERE tab_name = ?", (tab_name,)
        )
        return cursor.fetchone() is not None
    finally:
        conn.close()


def get_encrypted_tabs() -> list[str]:
    """Return list of tab names that have passwords set."""
    if not common_db.exists():
        return []
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_passwords")
        return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


def set_tab_password(tab_name: str, password: str) -> str:
    """Set/change password for a tab. Returns error string or empty string on success.

    On first-time setup (no existing password), also encrypts all KB files.
    On password change (existing password), re-encrypts all files with new key.
    """
    pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    # Generate new salt for AES key derivation
    new_salt = get_random_bytes(16)
    new_key = PBKDF2(password.encode('utf-8'), new_salt, dkLen=32, count=100000)

    existing_salt = None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT enc_salt FROM tab_passwords WHERE tab_name = ?", (tab_name,)
        )
        row = cursor.fetchone()
        if row:
            existing_salt = row[0]

        conn.execute(
            "INSERT OR REPLACE INTO tab_passwords (tab_name, password_hash, enc_salt) VALUES (?, ?, ?)",
            (tab_name, pw_hash, new_salt)
        )
        conn.commit()
    finally:
        conn.close()

    # Cache the new key for the current session.
    # On password change, stale keys in OTHER sessions must be purged so
    # they re-prompt for the new password instead of using the old key.
    _sid = _get_current_sid()
    with _session_encryption_keys_lock:
        if existing_salt:
            # Password change — remove stale key from ALL sessions
            for keys in _session_encryption_keys.values():
                keys.pop(tab_name, None)
        if _sid:
            if _sid not in _session_encryption_keys:
                _session_encryption_keys[_sid] = {}
            _session_encryption_keys[_sid][tab_name] = new_key

    # If this is a new password (no existing salt), encrypt all files
    if not existing_salt:
        try:
            _encrypt_all_tab_files(tab_name, new_key)
        except Exception as e:
            log_error("set_tab_password._encrypt_all_tab_files", e, tab_name)
            return f"加密文件失败: {e}"
    elif existing_salt != new_salt:
        # Password changed, re-encrypt with new key
        try:
            _encrypt_all_tab_files(tab_name, new_key)
        except Exception as e:
            log_error("set_tab_password._encrypt_all_tab_files", e, tab_name)
            return f"重新加密文件失败: {e}"

    return ""


def verify_tab_password(tab_name: str, password: str) -> bool:
    """Verify password for a tab. On success, caches the derived AES key
    for the calling session only."""
    if not common_db.exists():
        return False
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT password_hash, enc_salt FROM tab_passwords WHERE tab_name = ?",
            (tab_name,)
        )
        row = cursor.fetchone()
        if not row:
            return False
        pw_hash, salt = row
        if not bcrypt.checkpw(password.encode('utf-8'), pw_hash.encode('utf-8')):
            return False
        # Derive and cache the AES key for the current session only
        key = PBKDF2(password.encode('utf-8'), salt, dkLen=32, count=100000)
        sid = _get_current_sid()
        with _session_encryption_keys_lock:
            if sid not in _session_encryption_keys:
                _session_encryption_keys[sid] = {}
            _session_encryption_keys[sid][tab_name] = key
        return True
    finally:
        conn.close()


def remove_tab_password(tab_name: str, password: str) -> str:
    """Remove password protection from a tab. Returns '' on success or error message."""
    if not verify_tab_password(tab_name, password):
        return "密码验证失败"

    # Decrypt all files back to plaintext
    key = get_cached_encryption_key(tab_name)
    if key:
        try:
            _decrypt_all_tab_files(tab_name, key)
        except Exception as e:
            log_error("remove_tab_password._decrypt_all_tab_files", e, tab_name)
            return f"解密文件失败: {e}"

    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_passwords WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()

    with _session_encryption_keys_lock:
        for keys in _session_encryption_keys.values():
            keys.pop(tab_name, None)
    return ""


def get_cached_encryption_key(tab_name: str, sid: str | None = None) -> bytes | None:
    """Return cached AES key for a tab, scoped to a session.

    Args:
        tab_name: The tab to look up.
        sid: Socket.IO session ID. When provided, only checks that session's
             keys. When None (background/admin tasks with no request context),
             checks all sessions as a fallback.

    Returns:
        The 32-byte AES key, or None if the session hasn't unlocked this tab.
    """
    if sid is None:
        sid = _get_current_sid()
    with _session_encryption_keys_lock:
        if sid:
            session_keys = _session_encryption_keys.get(sid)
            if session_keys:
                return session_keys.get(tab_name)
            return None
        # No SID available — check all sessions (for background/admin tasks
        # like indexing that run without a request context).
        for keys in _session_encryption_keys.values():
            if tab_name in keys:
                return keys[tab_name]
        return None


def clear_session_encryption_keys(sid: str):
    """Remove all cached keys for a specific session (on socket disconnect)."""
    with _session_encryption_keys_lock:
        _session_encryption_keys.pop(sid, None)


# ─── File-level AES-GCM Encryption ────────────────────────────────────────

def _encrypt_file_data(data: bytes, key: bytes) -> bytes:
    """Encrypt *data* with AES-256-GCM using a random 12-byte nonce.
    Returns: nonce (12) + ciphertext + tag (16).
    """
    nonce = get_random_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(data)
    return nonce + ciphertext + tag


def _decrypt_file_data(encrypted: bytes, key: bytes) -> bytes:
    """Decrypt data produced by _encrypt_file_data.
    Returns original plaintext or raises ValueError on authentication failure.
    """
    if len(encrypted) < 28:
        raise ValueError("数据损坏: 加密数据过短")
    nonce = encrypted[:12]
    tag = encrypted[-16:]
    ciphertext = encrypted[12:-16]
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    try:
        return cipher.decrypt_and_verify(ciphertext, tag)
    except (ValueError, KeyError) as e:
        raise ValueError(f"解密失败: {e}")


def _encrypt_file_at_path(file_path: Path, key: bytes) -> Path:
    """Encrypt a file in-place. Replaces file with .enc version.
    Returns the new .enc path, or raises on error.
    """
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    data = file_path.read_bytes()
    enc_data = _encrypt_file_data(data, key)
    enc_path.write_bytes(enc_data)
    file_path.unlink()  # remove original
    return enc_path


def _decrypt_file_at_path(enc_path: Path, key: bytes) -> Path:
    """Decrypt a .enc file back to original. Returns the original path."""
    if not enc_path.suffix.endswith('.enc'):
        return enc_path  # not encrypted
    orig_suffix = enc_path.suffix[:-4]  # remove .enc
    orig_path = enc_path.with_suffix(orig_suffix)
    data = enc_path.read_bytes()
    plain = _decrypt_file_data(data, key)
    orig_path.write_bytes(plain)
    enc_path.unlink()
    return orig_path


def _read_decrypted_file(file_path: Path, key: bytes) -> bytes:
    """Read a file, transparently decrypting if .enc version exists."""
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    if enc_path.exists():
        data = enc_path.read_bytes()
        return _decrypt_file_data(data, key)
    # Plain file exists
    if file_path.exists():
        return file_path.read_bytes()
    raise FileNotFoundError(f"文件不存在: {file_path}")


def _write_encrypted_file(file_path: Path, data: bytes, key: bytes):
    """Write data, transparently encrypted. Removes any old plaintext file."""
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    # Remove old plaintext if it exists
    if file_path.exists():
        file_path.unlink()
    enc_data = _encrypt_file_data(data, key)
    enc_path.write_bytes(enc_data)


def _walk_tab_files(tab_name: str) -> list[Path]:
    """Return all files (paths) under a tab's directory, excluding .enc files
    (since we iterate the originals and their .enc counterparts are handled together)."""
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return []
    files = []
    for root, _dirs, filenames in os.walk(tab_path):
        for f in filenames:
            fp = Path(root) / f
            if fp.suffix == '.enc':
                continue  # we handle these via their originals
            # Skip hidden files
            if f.startswith('.'):
                continue
            # Skip the exported index.html (re-generatable)
            if f == 'index.html' and fp.parent == tab_path:
                continue
            files.append(fp)
    return files


def _encrypt_all_tab_files(tab_name: str, key: bytes):
    """Encrypt all files under a tab's directory with AES-GCM."""
    files = _walk_tab_files(tab_name)
    for fp in files:
        try:
            _encrypt_file_at_path(fp, key)
        except Exception as e:
            log_error("_encrypt_all_tab_files", e, f"{tab_name}/{fp.name}")


def _decrypt_all_tab_files(tab_name: str, key: bytes):
    """Decrypt all .enc files under a tab's directory back to plaintext."""
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return
    for root, _dirs, filenames in os.walk(tab_path):
        for f in filenames:
            if not f.endswith('.enc'):
                continue
            enc_path = Path(root) / f
            try:
                _decrypt_file_at_path(enc_path, key)
            except Exception as e:
                log_error("_decrypt_all_tab_files", e, f"{tab_name}/{f}")


# ─── Modified file I/O for encrypted tabs ─────────────────────────────────

def read_tab_file(tab_name: str, rel_path: str) -> bytes | None:
    """Read a file from a tab, transparently decrypting if tab is encrypted.
    *rel_path* is relative to the tab's directory (e.g. 'content/uuid.html').
    Returns bytes or None if the file doesn't exist.

    Decryption uses the calling session's cached AES key, so each window
    must unlock the tab independently to read its content.
    """
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return None
    file_path = tab_path / rel_path

    key = get_cached_encryption_key(tab_name, _get_current_sid())
    if key:
        # Tab is encrypted, try reading the .enc version
        try:
            return _read_decrypted_file(file_path, key)
        except FileNotFoundError:
            return None
        except ValueError as e:
            log_error("read_tab_file", e, f"{tab_name}/{rel_path}")
            return None
    else:
        if is_tab_encrypted(tab_name):
            # Tab is encrypted but not unlocked
            log_error("read_tab_file", Exception("access denied"),
                      f"{tab_name}/{rel_path} - tab is encrypted but not unlocked")
            return None
        # Plain file
        if not file_path.exists():
            return None
        return file_path.read_bytes()


def write_tab_file(tab_name: str, rel_path: str, data: bytes) -> bool:
    """Write a file to a tab, transparently encrypting if tab is encrypted.
    Returns True on success.

    Encryption uses the calling session's cached AES key. A session must
    have unlocked the tab to be able to write encrypted content.
    """
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return False
    file_path = tab_path / rel_path
    file_path.parent.mkdir(parents=True, exist_ok=True)

    key = get_cached_encryption_key(tab_name, _get_current_sid())
    if key:
        _write_encrypted_file(file_path, data, key)
    else:
        file_path.write_bytes(data)
    return True


def read_tab_text(tab_name: str, rel_path: str, encoding='utf-8') -> str | None:
    """Read a text file from a tab with transparent decryption."""
    data = read_tab_file(tab_name, rel_path)
    if data is None:
        return None
    return data.decode(encoding)


def write_tab_text(tab_name: str, rel_path: str, text: str, encoding='utf-8') -> bool:
    """Write a text file to a tab with transparent encryption."""
    return write_tab_file(tab_name, rel_path, text.encode(encoding))


def tab_file_exists(tab_name: str, rel_path: str) -> bool:
    """Check if a file exists in a tab (handles both plain and encrypted versions)."""
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return False
    file_path = tab_path / rel_path
    if file_path.exists():
        return True
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    return enc_path.exists()


def list_tab_files(tab_name: str, rel_dir: str) -> list[str]:
    """List files in a tab directory, handling .enc naming transparently.
    Returns original filenames (without .enc suffix).
    """
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return []
    dir_path = tab_path / rel_dir
    if not dir_path.exists():
        return []
    names = set()
    for f in dir_path.iterdir():
        name = f.name
        if name.endswith('.enc'):
            name = name[:-4]
        if not name.startswith('.'):
            names.add(name)
    return sorted(names)


# === End Password & Encryption System ======================================


def save_content(tab_name, item_id, content_html):
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return False
    rel_path = f"content/{item_id}.html"
    return write_tab_text(tab_name, rel_path, content_html)




# ─── WebSocket Real-time Sync (Flask-SocketIO) ──────────────────────────

def _release_locks_by_sid(sid):
    """Release all document/delete locks held by a given socket session."""
    with _item_locks_lock:
        to_release = [k for k, v in _item_locks.items() if v == sid]
        for k in to_release:
            del _item_locks[k]
        return to_release


def _collect_all_descendant_ids(items, item_id):
    """Collect the given item_id and all its descendant IDs."""
    def _find_and_collect(items_list):
        for item in items_list:
            if item['id'] == item_id:
                result = [item['id']]
                _collect_children(item, result)
                return result
            if item.get('children'):
                result = _find_and_collect(item['children'])
                if result:
                    return result
        return None
    def _collect_children(node, acc):
        for child in node.get('children', []):
            acc.append(child['id'])
            _collect_children(child, acc)
    return _find_and_collect(items)


def ws_emit_menu_changed(tab):
    """Broadcast menu_changed event. Admin tab changes go to all users (via admin_sync room).
    User tab changes go only to that user's sessions (via user:username room).
    Encrypted tabs don't broadcast menu changes."""
    if is_tab_encrypted(tab):
        return
    try:
        owner = get_tab_owner(tab)
        if owner == '':
            # Admin tab - broadcast to admin_sync room (all users)
            socketio.emit('menu_changed', {'tab': tab}, room='admin_sync')
        else:
            # User tab - broadcast to that user's sessions
            socketio.emit('menu_changed', {'tab': tab}, room=f'user:{owner}')
        # Also broadcast to the tab room for backward compatibility
        socketio.emit('menu_changed', {'tab': tab}, room=f'tab:{tab}')
    except Exception:
        pass


def ws_emit_content_saved(tab, item_id, content):
    """Broadcast content_saved event. Admin tab changes go to all users.
    User tab changes go only to that user's sessions.
    Encrypted tabs don't broadcast content saves."""
    if is_tab_encrypted(tab):
        return
    try:
        payload = {'tab': tab, 'item_id': item_id, 'content': content}
        owner = get_tab_owner(tab)
        if owner == '':
            socketio.emit('content_saved', payload, room='admin_sync')
        else:
            socketio.emit('content_saved', payload, room=f'user:{owner}')
        socketio.emit('content_saved', payload, room=f'tab:{tab}')
    except Exception:
        pass


def ws_emit_encrypted_tab_event(tab, event, data=None, sender_sid=None):
    """Emit a lifecycle event to ALL clients.

    These events (delete, password-change, decrypt) are broadcast to every
    connected client so that *all* windows update the tab bar and encryption
    indicators — not just windows that have visited this specific tab.

    *sender_sid* is the socket ID of the window that triggered the event —
    the frontend uses it to skip self-notification.
    """
    payload = {'tab': tab}
    if data:
        payload.update(data)
    if sender_sid:
        payload['sender_sid'] = sender_sid
    try:
        socketio.emit(event, payload)
    except Exception:
        pass  # emit is best-effort outside SocketIO handler


@socketio.on('connect')
def ws_handle_connect():
    print(f'  [WS] Client connected', flush=True)


@socketio.on('disconnect')
def ws_handle_disconnect():
    sid = request.sid
    released = _release_locks_by_sid(sid)
    if released:
        print(f'  [WS] Released locks on disconnect: {released}', flush=True)
    # Clean up this session's encryption keys — other windows are unaffected
    clear_session_encryption_keys(sid)


@socketio.on('join_tab')
def ws_join_tab(data):
    """Client joins rooms for this tab.

    Every client joins the :notify room to receive encrypted-tab lifecycle
    events (delete, password-change, decrypt) regardless of encryption status.

    The regular tab room is for menu/content sync.
    For auth-aware sync: admin tab changes broadcast to ALL users (global_user room),
    while user-owned tab changes only sync within the same user's sessions.

    Encrypted tabs that haven't been unlocked by THIS session are denied.
    """
    tab = data.get('tab')
    if tab:
        join_room(f'tab:{tab}:notify')
        if is_tab_encrypted(tab) and get_cached_encryption_key(tab, request.sid) is None:
            emit('sync_denied', {'tab': tab, 'reason': '加密知识库不能同步'}, room=request.sid)
            return
        join_room(f'tab:{tab}')
        # Also join user-specific room for auth-aware sync
        token = data.get('auth_token', '')
        user = get_session_user(token)
        if user:
            join_room(f'user:{user["username"]}')
            if user['role'] == 'admin':
                join_room('admin_sync')


@socketio.on('leave_tab')
def ws_leave_tab(data):
    """Client leaves both the tab room and the notification room."""
    tab = data.get('tab')
    if tab:
        leave_room(f'tab:{tab}')
        leave_room(f'tab:{tab}:notify')


@socketio.on('join_document')
def ws_join_document(data):
    """Client joins a document room so it receives edits for that document."""
    tab = data.get('tab')
    item_id = data.get('item_id')
    if tab and item_id:
        room = f'doc:{tab}:{item_id}'
        join_room(room)


@socketio.on('leave_document')
def ws_leave_document(data):
    """Client leaves a document room (e.g. when switching items/tabs)."""
    tab = data.get('tab')
    item_id = data.get('item_id')
    if tab and item_id:
        room = f'doc:{tab}:{item_id}'
        leave_room(room)


@socketio.on('content_change')
def ws_content_change(data):
    """Receive real-time content change from one client and broadcast to others
    in the same document room (excludes the sender).
    Encrypted tabs cannot sync content via WebSocket."""
    tab = data.get('tab')
    if tab and is_tab_encrypted(tab):
        emit('sync_denied', {'tab': tab, 'reason': '加密知识库不能同步'}, room=request.sid)
        return
    token = request.args.get('token', '')
    user = get_session_user(token)
    if not user or not can_write_tab(tab, user):
        return
    item_id = data.get('item_id')
    content = data.get('content')
    if tab and item_id and content is not None:
        room = f'doc:{tab}:{item_id}'
        emit('content_update', {
            'tab': tab,
            'item_id': item_id,
            'content': content,
        }, room=room, include_self=False)


@socketio.on('lock_document')
def ws_lock_document(data):
    """Client requests an edit lock for an item (to prevent deletion by others).
    If the item is already locked by a different session, respond with lock_denied.
    Encrypted tabs cannot use document locks (no sync)."""
    tab = data.get('tab')
    item_id = data.get('item_id')
    if not tab or not item_id:
        return
    if is_tab_encrypted(tab):
        emit('sync_denied', {'tab': tab, 'reason': '加密知识库不能同步'}, room=request.sid)
        return
    token = request.args.get('token', '')
    user = get_session_user(token)
    if not user or not can_write_tab(tab, user):
        return
    key = (tab, item_id)
    sid = request.sid
    with _item_locks_lock:
        existing = _item_locks.get(key)
        if existing is None or existing == sid:
            _item_locks[key] = sid
            emit('lock_acquired', {'tab': tab, 'item_id': item_id}, room=sid)
        else:
            emit('lock_denied', {
                'tab': tab,
                'item_id': item_id,
                'reason': '该条目正在被其他用户编辑，无法锁定',
            }, room=sid)


@socketio.on('unlock_document')
def ws_unlock_document(data):
    """Client releases an edit lock."""
    tab = data.get('tab')
    item_id = data.get('item_id')
    if not tab or not item_id:
        return
    key = (tab, item_id)
    sid = request.sid
    with _item_locks_lock:
        if _item_locks.get(key) == sid:
            del _item_locks[key]


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
    return render_template('index.html', version=version, single_user=_single_user_mode)


@app.route('/help')
def help_page():
    """Serve the comprehensive help documentation page."""
    lang = get_system_config('language') or 'zh-CN'
    return render_template('help.html', version=version, lang=lang)


@app.route('/api/tabs')
def list_tabs():
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if user:
        visible = get_user_visible_tabs(user['username'], user['role'])
        return jsonify(visible)
    # No auth - return only admin-owned tabs at root level
    all_tabs = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and _is_valid_tab_dir(entry.name):
                all_tabs.add(entry.name)
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                for tab_entry in user_entry.iterdir():
                    if tab_entry.is_dir() and _is_valid_tab_dir(tab_entry.name):
                        all_tabs.add(tab_entry.name)
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, owner FROM tab_owner")
        owned_tabs = dict(cursor.fetchall())
        admin_tabs = {t for t in all_tabs if t not in owned_tabs or owned_tabs.get(t) == ''}
    finally:
        conn.close()
    result = [t for t in sorted(all_tabs) if t in admin_tabs]
    return jsonify(result)


def _auth_check_read(tab):
    """Check read access for a tab. Returns user dict or None.
    Anonymous users can read admin-owned (public) tabs.
    Others must be authenticated and authorized."""
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        # Allow anonymous read of admin-owned tabs
        owner = get_tab_owner(tab)
        if owner == '':
            return None
        abort(401, description='未登录')
    if not can_read_tab(tab, user):
        abort(403, description='无权限访问该知识库')
    return user


def _auth_check_write(tab):
    """Check write access for a tab. Returns user dict or abort response."""
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        abort(401, description='未登录')
    if not can_write_tab(tab, user):
        abort(403, description='无权限修改该知识库')
    return user


def _auth_check_admin():
    """Check admin access. Returns user dict or abort response."""
    return require_admin()


@app.route('/api/<tab>/menu')
def get_menu(tab):
    _auth_check_read(tab)
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    menu = load_menu(tab)
    return jsonify(menu)


@app.route('/api/<tab>/menu', methods=['POST'])
def create_menu_item(tab):
    _auth_check_write(tab)
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
    # Notify other clients in this tab to reload their menu
    ws_emit_menu_changed(tab)
    return jsonify(new_item), 201


@app.route('/api/<tab>/menu/<item_id>', methods=['PUT'])
def update_menu_item_route(tab, item_id):
    _auth_check_write(tab)
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
    path = compute_item_path(menu, item_id, tab)
    item = find_menu_item(menu, item_id)
    if path and item:
        _run_in_background(update_item_meta_in_index, tab, item_id, item['label'], path)
    ws_emit_menu_changed(tab)
    return jsonify({'success': True})


@app.route('/api/<tab>/menu/<item_id>', methods=['DELETE'])
def delete_menu_item_route(tab, item_id):
    _auth_check_write(tab)
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404

    request_sid = request.headers.get('X-Socket-ID')
    menu = load_menu(tab)
    all_ids = _collect_all_descendant_ids(menu, item_id)
    if all_ids:
        locked_items = []
        with _item_locks_lock:
            for did in all_ids:
                lock_sid = _item_locks.get((tab, did))
                if lock_sid is not None and lock_sid != request_sid:
                    locked_items.append(did)
        if locked_items:
            return jsonify({'error': '该条目正在被其他用户编辑，无法删除', 'locked_ids': locked_items}), 409

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
    ws_emit_menu_changed(tab)
    return jsonify({'deleted_ids': deleted_ids})


@app.route('/api/<tab>/content/<item_id>')
def get_content(tab, item_id):
    _auth_check_read(tab)
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    content = load_content(tab, item_id)
    return jsonify({'content': content})


@app.route('/api/<tab>/content/<item_id>', methods=['PUT'])
def save_content_route(tab, item_id):
    _auth_check_write(tab)
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    data = request.get_json()
    if data is None or 'content' not in data:
        return jsonify({'error': 'Content is required'}, 400)

    content_html = data['content']
    save_content(tab, item_id, content_html)
    _run_in_background(update_item_in_index, tab, item_id)
    tab_path = get_tab_path(tab)
    if tab_path:
        index_html = generate_standalone_html(tab)
        if index_html is not None:
            with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
                f.write(index_html)
    ws_emit_content_saved(tab, item_id, content_html)
    return jsonify({'success': True})


@app.route('/api/<tab>/upload', methods=['POST'])
def upload_image(tab):
    _auth_check_write(tab)
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
    file_data = file.read()
    write_tab_file(tab, f"images/{unique_name}", file_data)

    return jsonify({'url': f'/uploads/{tab}/images/{unique_name}'}), 201


@app.route('/api/<tab>/upload/file', methods=['POST'])
def upload_file(tab):
    _auth_check_write(tab)
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'No file selected'}), 400

    orig_filename = secure_filename(file.filename)
    if not orig_filename:
        orig_filename = f"file_{uuid.uuid4().hex[:8]}.bin"

    name_part, ext_part = os.path.splitext(orig_filename) if '.' in orig_filename else (orig_filename, '.bin')
    unique_name = f"{name_part}_{uuid.uuid4().hex[:4]}{ext_part}"

    file_data = file.read()
    write_tab_file(tab, f"images/{unique_name}", file_data)

    return jsonify({
        'url': f'/uploads/{tab}/files/{unique_name}',
        'filename': orig_filename,
        'size': len(file_data)
    }), 201


@app.route('/uploads/<tab>/files/<filename>')
def serve_uploaded_file(tab, filename):
    tab_path = get_tab_path(tab)
    if not tab_path:
        abort(404)
    # Check if this tab is encrypted and try to serve decrypted file
    key = get_cached_encryption_key(tab)
    if key:
        rel_path = f"images/{filename}"
        data = read_tab_file(tab, rel_path)
        if data is None:
            abort(404)
        # Determine mimetype from extension
        mime, _ = mimetypes.guess_type(filename)
        if mime is None:
            mime = 'application/octet-stream'
        return send_file(io.BytesIO(data), mimetype=mime)
    # Plain file
    upload_dir = tab_path / UPLOAD_DIR_NAME
    file_path = upload_dir / filename
    if not file_path.exists():
        enc_path = file_path.with_suffix(file_path.suffix + '.enc')
        if enc_path.exists():
            abort(404)  # encrypted but not unlocked
        abort(404)
    mime, _ = mimetypes.guess_type(filename)
    if mime is None:
        mime = 'application/octet-stream'
    return send_from_directory(str(upload_dir), filename, mimetype=mime)


@app.route('/uploads/<tab>/images/<filename>')
def serve_uploaded_image(tab, filename):
    tab_path = get_tab_path(tab)
    if not tab_path:
        abort(404)
    # Check if this tab is encrypted and try to serve decrypted image
    key = get_cached_encryption_key(tab)
    if key:
        rel_path = f"images/{filename}"
        data = read_tab_file(tab, rel_path)
        if data is None:
            abort(404)
        # Determine mimetype from extension
        ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else 'png'
        mime_map = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                     'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp'}
        mime = mime_map.get(ext, 'application/octet-stream')
        return send_file(io.BytesIO(data), mimetype=mime)
    # Plain file
    upload_dir = tab_path / UPLOAD_DIR_NAME
    file_path = upload_dir / filename
    if not file_path.exists():
        # Also check .enc version
        enc_path = file_path.with_suffix(file_path.suffix + '.enc')
        if enc_path.exists():
            abort(404)  # encrypted but not unlocked
        abort(404)
    return send_from_directory(str(upload_dir), filename)


def _get_visible_tab_names():
    """Return set of visible tab names from tab_kb_visibility.
    Returns None if the DB doesn't exist (all tabs visible by default)."""
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, visible FROM tab_kb_visibility")
        result = {row[0] for row in cursor.fetchall() if row[1]}
        return result
    finally:
        conn.close()


@app.route('/api/search')
def search():
    query = request.args.get('q', '').strip()
    tab = request.args.get('tab', '').strip()
    use_regex = request.args.get('regex', '').lower() in ('true', '1', 'yes')
    if not query:
        return jsonify([])

    # Determine visible tabs based on user auth
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if user:
        visible_tabs = set(get_user_visible_tabs(user['username'], user['role']))
    else:
        visible_tabs = _get_visible_tab_names()
        if visible_tabs is not None:
            # Anonymous: only admin-owned tabs (match list_tabs behavior)
            _conn = sqlite3.connect(str(common_db))
            try:
                _cursor = _conn.execute("SELECT tab_name, owner FROM tab_owner")
                _owned = dict(_cursor.fetchall())
            finally:
                _conn.close()
            visible_tabs = {t for t in visible_tabs if t not in _owned or _owned.get(t) == ''}

    if visible_tabs is not None:
        vis = get_tab_visibility()
        visible_tabs = {t for t in visible_tabs if vis.get(t, True)}

    try:
        if tab:
            if (visible_tabs is not None and tab not in visible_tabs) or not _tab_searchable(tab):
                results = []
            else:
                results = search_index(tab, query, use_regex=use_regex)
        else:
            if visible_tabs is None:
                results = search_all_tabs(query, use_regex=use_regex)
            else:
                results = []
                for t in sorted(visible_tabs):
                    if not _tab_searchable(t):
                        continue
                    results.extend(search_index(t, query, use_regex=use_regex))
        return jsonify(results)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/indexing-status')
def get_indexing_status():
    busy = _indexing_counter > 0
    return jsonify({
        'busy': busy,
        'status': '正在建立索引...' if busy else 'idle',
    })



def generate_standalone_html(tab_name):
    # Encrypted tabs cannot export standalone HTML (content files are encrypted)
    if is_tab_encrypted(tab_name) and get_cached_encryption_key(tab_name) is None:
        return None
    content_data = {}
    img_pattern = re.compile(r'/uploads/' + re.escape(tab_name) + r'/images/')
    tab_path = get_tab_path(tab_name)

    # Read content/ files (new-style web editor)
    content_dir = get_content_dir(tab_name)
    if content_dir and content_dir.exists():
        for f in sorted(content_dir.glob('*.html')):
            html = read_tab_text(tab_name, f"content/{f.name}")
            if html is not None:
                html = img_pattern.sub('images/', html)
                content_data[f.stem] = html

    # Read .qrich.html files (legacy frameset tabs)
    if tab_path:
        for f in sorted(tab_path.glob('*.qrich.html')):
            html = f.read_text(encoding='utf-8')
            body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)
            if body_match:
                html = body_match.group(1)
                html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
                html = re.sub(r'<nav[^>]*>.*?</nav>', '', html, flags=re.DOTALL)
            html = img_pattern.sub('images/', html)
            content_data[f.name] = html.strip()

    content_json = json.dumps(content_data, ensure_ascii=False)
    title_escaped = tab_name.replace('&', '&amp;').replace('<', '&lt;').replace('"', '&quot;')

    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title_escaped}</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; height:100vh; display:flex; color:#333; }}
  #sidebar {{ width:300px; min-width:200px; display:flex; flex-direction:column; border-right:1px solid #ddd; background:#fff; }}
  #tree {{ flex:1; overflow:auto; padding:8px 0; }}
  #main {{ flex:1; display:flex; flex-direction:column; }}
  #content {{ flex:1; overflow:auto; padding:20px; position:relative; }}
  #placeholder {{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#999; font-size:14px; }}
  .node {{ user-select:none; }}
  .node-header {{ display:flex; align-items:center; padding:4px 8px; cursor:pointer; border-radius:3px; margin:1px 4px; }}
  .node-header:hover {{ background:#e8f0fe; }}
  .node-header.active {{ background:#d4e4fc; font-weight:600; }}
  .toggle {{ width:18px; font-size:10px; color:#888; flex-shrink:0; cursor:pointer; }}
  .toggle.empty {{ visibility:hidden; }}
  .label {{ flex:1; font-size:13px; padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .children {{ padding-left:20px; }}
</style>
</head>
<body>
<div id="sidebar">
  <div id="tree"></div>
</div>
<div id="main">
  <div id="content">
    <div id="placeholder">Select an item</div>
    <div id="content-area"></div>
  </div>
</div>
<script src="menu.js"></script>
<script>
var CONTENT_DATA = {content_json};

(function() {{
  var treeEl = document.getElementById('tree');
  var contentArea = document.getElementById('content-area');
  var placeholder = document.getElementById('placeholder');

  function render(items, container) {{
    items.forEach(function(item) {{
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
      if (hasKids) {{
        var ch = document.createElement('div');
        ch.className = 'children';
        render(item.children, ch);
        div.appendChild(ch);
        tgl.addEventListener('click', function(e) {{ e.stopPropagation(); var d = ch.style.display; ch.style.display = d==='none'?'':'none'; this.textContent = d==='none'?'\\u25BE':'\\u25B8'; }});
      }}
      hdr.addEventListener('click', function() {{
        var act = document.querySelectorAll('.node-header');
        for (var i = 0; i < act.length; i++) act[i].classList.remove('active');
        this.classList.add('active');
        var html = CONTENT_DATA[item.id] || (item.href && CONTENT_DATA[item.href]);
        if (html) {{
          contentArea.innerHTML = html;
          contentArea.style.display = 'block';
          placeholder.style.display = 'none';
        }}
      }});
      container.appendChild(div);
    }});
  }}

  render(MENU_DATA, treeEl);
}})();
</script>
</body>
</html>'''


@app.route('/api/tab-visibility')
def get_tab_visibility_route():
    """Return visibility dict for all tabs, plus the currently selected tab.
    
    Visibility is role-dependent:
    - Admin: uses global tab_kb_visibility (controls all tabs)
    - Logged-in user: merges global visibility for admin tabs with per-user visibility for own tabs
    - Anonymous: all admin tabs visible, cannot hide
    """
    tabs = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and not entry.name.startswith('.'):
                tabs.add(entry.name)
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                for tab_entry in user_entry.iterdir():
                    if tab_entry.is_dir() and not tab_entry.name.startswith('.'):
                        tabs.add(tab_entry.name)
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)

    global_vis = get_tab_visibility()
    result = {}

    if user and user['role'] == 'admin':
        # Admin: global visibility controls all tabs
        for t in tabs:
            result[t] = global_vis.get(t, True)
    elif user:
        # Non-admin user: merge global (admin tabs) + per-user (own tabs)
        user_vis = get_user_tab_visibility(user['username'])
        for t in tabs:
            owner = get_tab_owner(t)
            if owner == '':
                # Admin tab — use global visibility (admin controls it)
                result[t] = global_vis.get(t, True)
            elif owner == user['username']:
                # Own tab — use per-user visibility
                result[t] = user_vis.get(t, True)
            else:
                # Someone else's tab — not visible
                result[t] = False
    else:
        # Anonymous: only see admin tabs, all visible (cannot hide)
        for t in tabs:
            owner = get_tab_owner(t)
            if owner == '':
                result[t] = global_vis.get(t, True)

    result['_selected_tab'] = get_user_selected_tab(user['username']) if user else get_selected_tab()
    return jsonify(result)


@app.route('/api/tab-visibility', methods=['PUT'])
def set_tab_visibility_route():
    """Set visibility for tabs. Expects {tab_name: bool, ...}.
    
    Behavior depends on user role:
    - Admin: saves globally to tab_kb_visibility (controls all tabs)
    - Non-admin user: saves per-user to user_tab_visibility (only own tabs)
    - Anonymous: rejected (cannot hide tabs)
    """
    data = request.get_json()
    if not isinstance(data, dict):
        return jsonify({'error': 'Expected a dict of {tab_name: visible}'}), 400
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        return jsonify({'error': '请先登录'}), 401
    if user['role'] == 'admin':
        set_tab_visibility_batch(data)
    else:
        set_user_tab_visibility_batch(user['username'], data)
    socketio.emit('tabs_updated', {})
    return jsonify({'success': True})


@app.route('/api/tab-current-items')
def get_tab_current_items_route():
    """Return dict of {tab_name: current_item_id}."""
    return jsonify(get_tab_current_items())


@app.route('/api/tab-current-item', methods=['PUT'])
def set_tab_current_item_route():
    """Set current item for a tab. Expects {tab_name, current_item_id}. Also marks the tab as the currently selected tab."""
    data = request.get_json()
    if not data or 'tab_name' not in data or 'current_item_id' not in data:
        return jsonify({'error': 'Expected {tab_name, current_item_id}'}), 400
    set_tab_current_item(data['tab_name'], data['current_item_id'])
    set_selected_tab(data['tab_name'])
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


@app.route('/api/system-config/<name>')
def get_system_config_route(name):
    """Get a system config value by name."""
    value = get_system_config(name)
    if value is None:
        return jsonify({'value': None}), 404
    return jsonify({'name': name, 'value': value})


@app.route('/api/system-config/<name>', methods=['PUT'])
def set_system_config_route(name):
    """Set a system config value by name."""
    data = request.get_json()
    if not data or 'value' not in data:
        return jsonify({'error': 'Missing value'}), 400
    set_system_config(name, data['value'])
    return jsonify({'success': True})


@app.route('/api/tabs', methods=['POST'])
def create_tab():
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        abort(401, description='未登录')
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    if not name:
        name = f"NewTab_{uuid.uuid4().hex[:6]}"

    # Determine tab path based on user role
    if user['role'] == 'admin':
        tab_path = mybase_dir / name
    else:
        tab_path = user_data_dir / user['username'] / name
        tab_path.parent.mkdir(parents=True, exist_ok=True)

    tab_name_exists, tab_owner = _is_tab_name_globally_used(name)
    if tab_name_exists:
        if tab_owner:
            return jsonify({'error': f'知识库名称 "{name}" 已被用户 "{tab_owner}" 使用'}), 409
        else:
            return jsonify({'error': f'知识库名称 "{name}" 已存在'}), 409
    tab_path.mkdir(parents=True)
    save_menu(name, [])
    add_tab_to_order(name)
    init_tab_visibility(name)

    # Auto-set owner for non-admin users
    if user['role'] != 'admin':
        set_tab_owner(name, user['username'])
    # Admin tabs have no owner (empty = admin/公告栏)

    index_html = generate_standalone_html(name)
    if index_html is not None:
        with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
            f.write(index_html)
    _run_in_background(index_tab, name)
    try:
        if user['role'] == 'admin':
            # Admin tabs are public — notify ALL connected clients
            socketio.emit('tab_added', {'tab': name, 'sender_sid': _get_current_sid()})
        else:
            socketio.emit('tab_added', {'tab': name, 'sender_sid': _get_current_sid()}, room=f'user:{user["username"]}')
    except Exception:
        pass
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
        conn.execute(
            "UPDATE tab_passwords SET tab_name = ? WHERE tab_name = ?",
            (new_name, old_name)
        )
        conn.commit()
    finally:
        conn.close()


def _update_image_urls_after_rename(tab_path, old_name, new_name):
    """Update image URLs in content files after a tab rename.
    
    Content HTML contains <img src="/uploads/OLD_NAME/images/..."> references.
    After renaming the tab, these URLs must point to the new tab name so images
    can still be served by the /uploads/<tab>/ route.
    
    Handles both modern content/*.html files and legacy *.qrich.html files.
    """
    old_prefix = f'/uploads/{old_name}/'
    new_prefix = f'/uploads/{new_name}/'
    # Modern content files
    content_dir = tab_path / 'content'
    if content_dir.exists():
        for fpath in content_dir.glob('*.html'):
            try:
                original = fpath.read_text(encoding='utf-8')
                if old_prefix in original:
                    fpath.write_text(original.replace(old_prefix, new_prefix), encoding='utf-8')
            except Exception as e:
                log_error("_update_image_urls_after_rename", e, str(fpath))
    # Legacy .qrich.html files stored directly in tab root
    for fpath in tab_path.glob('*.qrich.html'):
        try:
            original = fpath.read_text(encoding='utf-8')
            if old_prefix in original:
                fpath.write_text(original.replace(old_prefix, new_prefix), encoding='utf-8')
        except Exception as e:
            log_error("_update_image_urls_after_rename", e, str(fpath))


def regenerate_index_html(tab_name, tab_path):
    index_html = generate_standalone_html(tab_name)
    if index_html is not None:
        with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
            f.write(index_html)


@app.route('/api/tabs/<old_name>', methods=['PUT'])
def rename_tab(old_name):
    _auth_check_write(old_name)
    data = request.get_json() or {}
    new_name = data.get('new_name', '').strip()

    if not new_name:
        return jsonify({'error': 'New name is required'}), 400

    if new_name == old_name:
        return jsonify({'success': True})

    old_tab_path = get_tab_path(old_name)
    if not old_tab_path:
        return jsonify({'error': 'Tab not found'}), 404

    tab_name_exists, tab_owner = _is_tab_name_globally_used(new_name)
    if tab_name_exists:
        if tab_owner:
            return jsonify({'error': f'知识库名称 "{new_name}" 已被用户 "{tab_owner}" 使用'}), 409
        else:
            return jsonify({'error': f'知识库名称 "{new_name}" 已存在'}), 409
    new_tab_path = mybase_dir / new_name

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
        _update_image_urls_after_rename(new_tab_path, old_name, new_name)
        regenerate_index_html(new_name, new_tab_path)

        # Notify all clients that a tab was renamed
        try:
            socketio.emit('tab_renamed', {
                'old_name': old_name,
                'new_name': new_name,
                'sender_sid': _get_current_sid(),
            })
        except Exception:
            pass

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tabs/<tab>', methods=['DELETE'])
def delete_tab(tab):
    require_admin()
    tab_path = get_tab_path(tab)
    if not tab_path:
        return jsonify({'error': 'Tab not found'}), 404
    delete_tab_index(tab)
    remove_tab_from_order(tab)
    delete_tab_visibility(tab)
    delete_tab_current_item(tab)
    # Remove password entry if exists
    if common_db.exists():
        conn = sqlite3.connect(str(common_db))
        try:
            conn.execute("DELETE FROM tab_passwords WHERE tab_name = ?", (tab,))
            conn.commit()
        finally:
            conn.close()
    with _session_encryption_keys_lock:
        for keys in _session_encryption_keys.values():
            keys.pop(tab, None)

    # Notify other windows that this encrypted tab has been deleted
    ws_emit_encrypted_tab_event(tab, 'encrypted_tab_deleted', sender_sid=_get_current_sid())
    # Also send a generic tab_deleted event for all clients (encrypted or not)
    try:
        socketio.emit('tab_deleted', {
            'tab': tab,
            'sender_sid': _get_current_sid(),
        })
    except Exception:
        pass

    def _remove_readonly(func, path, _):
        """Clear read-only flag and retry (required on Windows)."""
        os.chmod(path, stat.S_IWRITE)
        func(path)

    shutil.rmtree(str(tab_path), onerror=_remove_readonly)
    return jsonify({'success': True})


# ─── Password Management API Routes ───────────────────────────────────────


@app.route('/api/tabs/<tab>/password', methods=['POST'])
def set_tab_password_route(tab):
    """Set or change password for a knowledge base."""
    if not get_tab_path(tab):
        return jsonify({'error': '知识库不存在'}), 404
    data = request.get_json()
    if not data or 'password' not in data:
        return jsonify({'error': '需要提供密码'}), 400

    password = data['password']
    if len(password) < 1:
        return jsonify({'error': '密码不能为空'}), 400

    # If tab already has a password, verify the old one
    was_encrypted = is_tab_encrypted(tab)
    if was_encrypted:
        old_password = data.get('old_password', '')
        if not verify_tab_password(tab, old_password):
            return jsonify({'error': '原密码验证失败'}), 403

    err = set_tab_password(tab, password)
    if err:
        return jsonify({'error': err}), 500

    # Notify other windows — whether first-time encryption or password change
    ws_emit_encrypted_tab_event(tab, 'encrypted_tab_password_changed', sender_sid=_get_current_sid())

    return jsonify({'success': True})


@app.route('/api/tabs/<tab>/verify-password', methods=['POST'])
def verify_tab_password_route(tab):
    """Verify password for a tab. On success, caches the derived AES key."""
    if not get_tab_path(tab):
        return jsonify({'error': '知识库不存在'}), 404
    data = request.get_json()
    if not data or 'password' not in data:
        return jsonify({'error': '需要提供密码'}), 400

    if verify_tab_password(tab, data['password']):
        return jsonify({'success': True})
    return jsonify({'error': '密码错误'}), 403


@app.route('/api/tabs/<tab>/password', methods=['DELETE'])
def remove_tab_password_route(tab):
    """Remove password protection from a tab."""
    if not get_tab_path(tab):
        return jsonify({'error': '知识库不存在'}), 404
    if not is_tab_encrypted(tab):
        return jsonify({'error': '该知识库没有设置密码'}), 400

    data = request.get_json()
    if not data or 'password' not in data:
        return jsonify({'error': '需要提供密码'}), 400

    err = remove_tab_password(tab, data['password'])
    if err:
        return jsonify({'error': err}), 403

    # Notify other windows that this tab is no longer encrypted
    ws_emit_encrypted_tab_event(tab, 'encrypted_tab_decrypted', sender_sid=_get_current_sid())

    return jsonify({'success': True})


@app.route('/api/encrypted-tabs')
def get_encrypted_tabs_route():
    """Return list of tab names that have passwords set."""
    return jsonify({'encrypted_tabs': get_encrypted_tabs()})


@app.route('/api/clear-encryption-cache', methods=['POST'])
def clear_encryption_cache():
    """Clear cached encryption keys for the current session (if called).
    No longer triggered by the frontend — keys are now per-session and
    cleaned up automatically on socket disconnect."""
    sid = _get_current_sid()
    if sid:
        clear_session_encryption_keys(sid)
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
    ws_emit_menu_changed(tab)
    return jsonify({'success': True})


@app.route('/api/<tab>/menu/paste', methods=['POST'])
def paste_menu_item(tab):
    """Paste a copied menu item as a sibling after the target item.
    Also copies content if provided in the contents map."""
    _auth_check_write(tab)
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404

    data = request.get_json()
    if not data or 'item' not in data:
        return jsonify({'error': 'No item data provided'}), 400

    after_id = data.get('after_id')
    if not after_id:
        return jsonify({'error': 'after_id is required'}), 400
    contents = data.get('contents') or {}

    def _clone_with_new_ids(src):
        new_id = str(uuid.uuid4())
        new_item = {
            'id': new_id,
            'label': src['label'],
            'children': [_clone_with_new_ids(c) for c in src.get('children', [])]
        }
        if 'style' in src and src['style']:
            new_item['style'] = dict(src['style'])
        return new_item

    new_item = _clone_with_new_ids(data['item'])

    menu = load_menu(tab)
    success = add_menu_item_after(menu, new_item, after_id)
    if not success:
        return jsonify({'error': 'Target item not found'}), 404

    save_menu(tab, menu)

    def _process_items(src_item, dst_item):
        if src_item['id'] in contents:
            save_content(tab, dst_item['id'], contents[src_item['id']])
        path = compute_item_path(menu, dst_item['id'], tab)
        if path:
            db_path = get_index_db_path(tab)
            if db_path.exists():
                conn = sqlite3.connect(str(db_path))
                try:
                    conn.execute(
                        "INSERT OR REPLACE INTO item_index (menu_item_id, label, content_text, menu_path) VALUES (?, ?, '', ?)",
                        (dst_item['id'], dst_item['label'], path)
                    )
                    conn.commit()
                finally:
                    conn.close()
        for i, child in enumerate(dst_item.get('children', [])):
            _process_items(src_item['children'][i], child)

    _process_items(data['item'], new_item)

    ws_emit_menu_changed(tab)
    return jsonify(new_item), 201


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


# ─── Backup Knowledge Base ───────────────────────────────────────────────

_backup_tasks: dict = {}
_backup_lock = threading.Lock()

_BACKUP_EXCLUDE_DIRS = {'__pycache__', '.sisyphus'}
_BACKUP_ROOT_EXCLUDE_DIRS = {'backups', 'data'}
_BACKUP_ROOT_EXCLUDE_FILES = {'.gitignore', 'mybase.log', 'nohup.out'}


def _get_backup_dir() -> Path:
    backup_dir = Path(tempfile.gettempdir()) / 'mybase_backups'
    backup_dir.mkdir(exist_ok=True)
    return backup_dir


def _walk_real_files(start_dir, arc_prefix, seen, root_skip_dirs, root_skip_files, skip_real_dir=None, dir_filter=None):
    start = Path(start_dir)
    for root, dirs, files in os.walk(start, followlinks=True):
        root_path = Path(root)
        rel = os.path.relpath(root, start)
        kept = []
        for d in dirs:
            if d in _BACKUP_EXCLUDE_DIRS:
                continue
            real = (root_path / d).resolve()
            if rel == '.' and d in root_skip_dirs:
                continue
            if skip_real_dir is not None and real == skip_real_dir:
                continue
            if real in seen:
                continue
            if dir_filter and not dir_filter(rel, d):
                continue
            seen.add(real)
            kept.append(d)
        dirs[:] = kept
        for f in files:
            if rel == '.' and f in root_skip_files:
                continue
            if rel == '.':
                arc = os.path.join(arc_prefix, f) if arc_prefix else f
            else:
                arc = os.path.join(arc_prefix, rel, f) if arc_prefix else os.path.join(rel, f)
            yield str(root_path / f), arc


def _iter_backup_files(backup_user=None):
    """Iterate backup files. If backup_user is set and not admin, only include
    tabs owned by that user."""
    seen: set = set()
    base_real = BASE_DIR.resolve()
    data_real = data_dir.resolve()

    yield from _walk_real_files(
        BASE_DIR, '', seen,
        root_skip_dirs=_BACKUP_ROOT_EXCLUDE_DIRS,
        root_skip_files=_BACKUP_ROOT_EXCLUDE_FILES,
        skip_real_dir=data_real,
    )

    if data_real.exists() and data_real != base_real:
        # Determine which tabs to include
        if backup_user and backup_user.get('role') != 'admin':
            visible_tabs = set(get_user_visible_tabs(backup_user['username'], backup_user['role']))
        else:
            visible_tabs = None

        def _data_dir_filter(rel, dirname):
            if rel == 'mybase':
                if visible_tabs is not None:
                    return dirname in visible_tabs
                return True
            if rel.startswith('mybase/'):
                # Tabs directly under data/mybase/ — always include
                return True
            if rel == 'user':
                # Enter data/user/; filter at subdir level
                return True
            if rel.startswith('user/'):
                if backup_user and backup_user.get('role') != 'admin':
                    user_prefix = f"user/{backup_user['username']}"
                    return rel == user_prefix or rel.startswith(user_prefix + '/')
                return True
            return True

        yield from _walk_real_files(
            data_dir, 'data', seen,
            root_skip_dirs=set(),
            root_skip_files=set(),
            dir_filter=_data_dir_filter,
        )


def _cleanup_old_backups(backup_dir: Path, max_age_seconds: int = 3600):
    now = time.time()
    if backup_dir.exists():
        for f in backup_dir.iterdir():
            if f.suffix == '.zip' and f.name.startswith('mybase-'):
                if now - f.stat().st_mtime > max_age_seconds:
                    try:
                        f.unlink()
                    except Exception:
                        pass


@app.route('/api/backup', methods=['POST'])
def start_backup():
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        abort(401, description='未登录')
    task_id = str(uuid.uuid4())
    backup_dir = _get_backup_dir()
    _cleanup_old_backups(backup_dir)

    total = sum(1 for _ in _iter_backup_files(backup_user=user))

    with _backup_lock:
        _backup_tasks[task_id] = {
            'total': total,
            'current': 0,
            'done': False,
            'filename': None,
            'error': None,
        }

    def _do_backup():
        try:
            now = datetime.now()
            filename = f"mybase-{now.strftime('%Y%m%d-%H%M%S')}.zip"
            zip_path = backup_dir / filename
            with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
                for file_path, arcname in _iter_backup_files(backup_user=user):
                    try:
                        zf.write(file_path, arcname)
                    except Exception:
                        pass
                    with _backup_lock:
                        _backup_tasks[task_id]['current'] += 1
            with _backup_lock:
                _backup_tasks[task_id]['done'] = True
                _backup_tasks[task_id]['filename'] = filename
        except Exception as e:
            with _backup_lock:
                _backup_tasks[task_id]['error'] = str(e)
                _backup_tasks[task_id]['done'] = True

    thread = threading.Thread(target=_do_backup, daemon=True)
    thread.start()

    return jsonify({'task_id': task_id, 'total': total})


@app.route('/api/backup/status/<task_id>')
def get_backup_status(task_id):
    with _backup_lock:
        task = _backup_tasks.get(task_id)
    if not task:
        return jsonify({'error': '任务不存在'}), 404
    return jsonify({
        'done': task['done'],
        'total': task['total'],
        'current': task['current'],
        'filename': task['filename'],
        'error': task['error'],
    })


@app.route('/api/backup/download/<task_id>')
def download_backup(task_id):
    token = request.headers.get('X-Auth-Token', '') or request.args.get('token', '')
    user = get_session_user(token)
    if not user:
        abort(401, description='未登录')
    with _backup_lock:
        task = _backup_tasks.get(task_id)
    if not task or not task['done']:
        return jsonify({'error': '备份未就绪'}), 404
    if task['error']:
        return jsonify({'error': task['error']}), 500
    filename = task['filename']
    if not filename:
        return jsonify({'error': '备份文件不存在'}), 404
    return send_from_directory(str(_get_backup_dir()), filename, as_attachment=True)


# ─── Export (PDF & ZIP) ──────────────────────────────────────────────────

_EXPORT_DIR = Path(tempfile.gettempdir()) / 'mybase_exports'
_EXPORT_DIR.mkdir(exist_ok=True)
_PDF_FONT_DIR = BASE_DIR / 'pdf_fonts'


class _TableParser(html.parser.HTMLParser):
    """Parse a <table> HTML fragment into a list of rows of cell text."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self._current_row = None
        self._current_cell_data = None
        self.has_th = False

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self._current_row = []
        elif tag in ('td', 'th'):
            self._current_cell_data = []
            if tag == 'th':
                self.has_th = True
        elif tag == 'br' and self._current_cell_data is not None:
            self._current_cell_data.append(' ')

    def handle_endtag(self, tag):
        if tag == 'tr' and self._current_row is not None:
            self.rows.append(self._current_row)
            self._current_row = None
        elif tag in ('td', 'th') and self._current_row is not None:
            cell_text = ''.join(self._current_cell_data).strip() if self._current_cell_data else ''
            cell_text = re.sub(r'\s+', ' ', cell_text)
            self._current_row.append(cell_text)
            self._current_cell_data = None

    def handle_data(self, data):
        if self._current_cell_data is not None:
            self._current_cell_data.append(data)


def _parse_html_table(table_html):
    """Parse an HTML <table> string into (rows, has_th).

    *rows* is a list of rows, each row is a list of cell text strings.
    *has_th* is True if any <th> element was found.
    """
    parser = _TableParser()
    parser.feed(table_html)
    return parser.rows, parser.has_th


def _cleanup_old_exports(max_age_seconds: int = 600):
    """Remove export files older than *max_age_seconds*."""
    now = time.time()
    if _EXPORT_DIR.exists():
        for f in _EXPORT_DIR.iterdir():
            if now - f.stat().st_mtime > max_age_seconds:
                try:
                    if f.is_file():
                        f.unlink()
                    elif f.is_dir():
                        shutil.rmtree(str(f), ignore_errors=True)
                except Exception:
                    pass


def _collect_subtree_content(tab_name, items, target_id, depth=0):
    """Collect (label, content_html, depth) for a menu node and all descendants.
    Returns list sorted by pre-order traversal."""
    rows = []
    for item in items:
        if item['id'] == target_id or target_id is None:
            # Found the target (or collecting all items when target_id is None)
            if target_id is not None:
                # Only this subtree
                rows.append((item['label'], load_content(tab_name, item['id']), depth))
                if item.get('children'):
                    for child in item['children']:
                        rows.extend(_collect_subtree_content(tab_name, [child], child['id'], depth + 1))
                return rows
            else:
                # Collect all (tab-level export)
                rows.append((item['label'], load_content(tab_name, item['id']), depth))
                if item.get('children'):
                    for child in item['children']:
                        rows.extend(_collect_subtree_content(tab_name, [child], child['id'], depth + 1))
        else:
            if item.get('children'):
                rows.extend(_collect_subtree_content(tab_name, item['children'], target_id, depth))
    return rows


def _collect_all_tab_content(tab_name):
    """Collect all menu items' (label, content_html, depth) for an entire tab."""
    menu = load_menu(tab_name)
    return _collect_subtree_content(tab_name, menu, None, 0)


def _html_to_pdf_text(html):
    """Convert HTML to plain text preserving paragraph breaks for PDF."""
    if not html:
        return ''
    text = re.sub(r'</p>\s*<p[^>]*>', '\n\n', html, flags=re.DOTALL)
    text = re.sub(r'</?(?:p|div|h[1-6]|blockquote|li)[^>]*>', '\n', text, flags=re.DOTALL)
    text = text.replace('<br>', '\n').replace('<br/>', '\n').replace('<br />', '\n')
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _iter_dom_elements(html):
    """Yield (type, content) tuples preserving DOM order.

    Types: 'text', 'img', 'svg', 'table' — yielded in the exact order
    they appear in the HTML so PDF rendering respects the document order.
    """
    pat = re.compile(
        r'(<table\b[^>]*>.*?</table>)'
        r'|(<img\b[^>]*/?>)'
        r'|(<svg\b[^>]*>.*?</svg>)',
        re.DOTALL | re.IGNORECASE,
    )
    pos = 0
    for m in pat.finditer(html):
        if m.start() > pos:
            yield ('text', html[pos : m.start()])
        if m.group(1):
            yield ('table', m.group(1))
        elif m.group(2):
            yield ('img', m.group(2))
        elif m.group(3):
            yield ('svg', m.group(3))
        pos = m.end()
    if pos < len(html):
        yield ('text', html[pos:])


def _generate_pdf(items, title, tab_name=None):
    regular_ttf = _PDF_FONT_DIR / 'NotoSansSC-Regular.ttf'
    bold_ttf = _PDF_FONT_DIR / 'NotoSansSC-Bold.ttf'
    has_font = regular_ttf.exists() or bold_ttf.exists()

    def _setup_fonts(pdf):
        if regular_ttf.exists():
            pdf.add_font('CJK', '', str(regular_ttf))
        if bold_ttf.exists():
            pdf.add_font('CJK', 'B', str(bold_ttf))

    def _resolve_img_data(src):
        if not src or src.startswith('data:') or not tab_name:
            return None
        # URL pattern: /uploads/<tab>/images/<filename>
        m = re.match(r'^/uploads/([^/]+)/images/(.+)$', src)
        if m:
            return read_tab_file(m.group(1), f'images/{m.group(2)}')
        tab_path = get_tab_path(tab_name)
        if tab_path:
            return read_tab_file(tab_name, src.lstrip('/'))
        return None

    def _render_text_html(pdf, html_text, indent):
        link_pat = re.compile(
            r'<a\b[^>]*href=[\'"]([^\'"]+)[\'"][^>]*>(.*?)</a>',
            re.DOTALL | re.IGNORECASE,
        )
        if not link_pat.search(html_text):
            text = _html_to_pdf_text(html_text)
            if text:
                pdf.set_x(pdf.l_margin + indent + 4)
                pdf.set_font('CJK', '', 9)
                pdf.multi_cell(pdf.epw - indent - 4, 5, text)
                pdf.ln(2)
            return
        # multi_cell draws text at (cell_x + cm, cell_y + cm) while
        # write() draws at (x, y) directly.  We add c_margin to the
        # left margin and starting y so link text aligns with non-link
        # text, then advance to bottom of the last line plus spacing.
        cm = pdf.c_margin
        old_lm = pdf.l_margin
        blk_close = re.compile(
            r'</(?:div|pre|p|blockquote|li|h[1-6])>\s*$', re.IGNORECASE
        )
        blk_open = re.compile(
            r'^\s*<(?:div|pre|p|blockquote|li|h[1-6])\b', re.IGNORECASE
        )
        try:
            new_lm = pdf.l_margin + indent + 4 + cm
            pdf.set_left_margin(new_lm)
            pdf.set_x(pdf.l_margin)
            pdf.set_y(pdf.get_y() + cm)
            pdf.set_font('CJK', '', 9)
            pos = 0
            for m in link_pat.finditer(html_text):
                if m.start() > pos:
                    seg = html_text[pos : m.start()]
                    t = _html_to_pdf_text(seg)
                    if t:
                        # _html_to_pdf_text.strip() removes trailing \n
                        # from block-level close tags; restore it so
                        # the link starts on its own line.
                        if blk_close.search(seg):
                            t += '\n'
                        pdf.write(5, t)
                link_txt = _html_to_pdf_text(m.group(2))
                link_url = m.group(1)
                if link_txt:
                    pdf.set_text_color(0, 0, 255)
                    pdf.write(5, link_txt, link=link_url)
                    pdf.set_text_color(0, 0, 0)
                pos = m.end()
            if pos < len(html_text):
                seg = html_text[pos:]
                t = _html_to_pdf_text(seg)
                if t:
                    if blk_open.search(seg):
                        t = '\n' + t
                    pdf.write(5, t)
        finally:
            pdf.set_left_margin(old_lm)
        # write(5, ...) leaves y at top of last line (no advance on
        # single-line text).  Jump to bottom of last line (=5mm) plus
        # 2mm spacing, minus the cm we added at the start.
        pdf.ln(7 - cm)

    def _render_item(pdf, label, content_html, depth, sep=True):
        if not has_font:
            pdf.set_font('Courier', '', 10)
            pdf.multi_cell(pdf.epw, 5, f"{label}\n{_html_to_pdf_text(content_html)}\n")
            return
        # Heading
        heading_size = max(13 - depth * 2, 9)
        indent = depth * 6
        pdf.set_x(pdf.l_margin + indent)
        pdf.set_font('CJK', 'B', heading_size)
        pdf.multi_cell(pdf.epw - indent, 7, label)
        pdf.ln(1)

        if content_html and content_html.strip():
            # Process elements (text, table, img, svg) in DOM order
            for elem_type, elem_content in _iter_dom_elements(content_html):
                if elem_type == 'table':
                    cells, has_th = _parse_html_table(elem_content)
                    if cells:
                        pdf.set_x(pdf.l_margin + indent + 4)
                        pdf.set_font('CJK', '', 9)
                        tw = pdf.epw - indent - 4
                        with pdf.table(
                            first_row_as_headings=has_th,
                            text_align='LEFT',
                            width=tw,
                            borders_layout='ALL',
                            line_height=5,
                            padding=1,
                        ) as tbl:
                            for row_data in cells:
                                row = tbl.row()
                                for cell_text in row_data:
                                    row.cell(cell_text)
                        pdf.ln(3)
                elif elem_type == 'text':
                    _render_text_html(pdf, elem_content, indent)
                elif elem_type == 'img':
                    src_match = re.search(r'src=[\'"]([^\'"]+)[\'"]', elem_content)
                    if src_match:
                        img_data = _resolve_img_data(src_match.group(1))
                        if img_data:
                            # Image width: full available width with a reasonable cap
                            max_w = min(pdf.epw - indent - 20, 150)
                            if max_w > 20:
                                try:
                                    pdf.image(io.BytesIO(img_data), w=max_w)
                                    pdf.ln(3)
                                except Exception:
                                    pass
                elif elem_type == 'svg':
                    png_src = re.search(
                        r'data-png="(data:image/png;base64,[^"]*)"', elem_content
                    )
                    if png_src:
                        svg_max_w = pdf.epw - indent - 20
                        if svg_max_w > 20:
                            try:
                                b64_data = png_src.group(1).split(',', 1)[1]
                                png_data = base64.b64decode(b64_data)
                                pdf.image(io.BytesIO(png_data), w=svg_max_w)
                                pdf.ln(3)
                            except Exception:
                                pass
        if sep:
            pdf.ln(2)
            pdf.set_draw_color(200, 200, 200)
            y = pdf.get_y()
            pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
            pdf.ln(4)

    # ── Pre-pass A: render title + TOC to measure pages consumed ──
    pdf_toc = FPDF()
    pdf_toc.add_page()
    _setup_fonts(pdf_toc)
    if has_font:
        pdf_toc.set_font('CJK', 'B', 16)
        pdf_toc.multi_cell(pdf_toc.epw, 11, strip_html_tags(title), align='C')
        pdf_toc.ln(4)
        if items:
            pdf_toc.set_font('CJK', 'B', 11)
            pdf_toc.cell(pdf_toc.epw, 7, '目  录', align='C')
            pdf_toc.ln(9)
            for label, _, depth in items:
                indent = depth * 12
                pdf_toc.set_x(pdf_toc.l_margin + indent)
                pdf_toc.set_font('CJK', '', 9)
                pdf_toc.multi_cell(pdf_toc.epw - indent, 6, label)
    else:
        pdf_toc.set_font('Courier', '', 12)
        pdf_toc.multi_cell(pdf_toc.epw, 8, title)
        for label, _, depth in items:
            pdf_toc.multi_cell(pdf_toc.epw, 6, label)
    pdf_toc.add_page()
    toc_pages = pdf_toc.page - 1

    # ── Pre-pass B: render content items to get accurate page numbers ──
    pdf_items = FPDF()
    pdf_items.add_page()
    _setup_fonts(pdf_items)
    item_pages = {}
    for i, (label, content_html, depth) in enumerate(items):
        item_pages[i] = pdf_items.page
        _render_item(pdf_items, label, content_html, depth, sep=(i < len(items) - 1))

    # ── Final pass: build PDF with correct page numbers ──
    pdf = FPDF()
    pdf.add_page()
    _setup_fonts(pdf)

    if has_font:
        pdf.set_font('CJK', 'B', 16)
        pdf.multi_cell(pdf.epw, 11, strip_html_tags(title), align='C')
        pdf.ln(4)

        if items:
            pdf.set_font('CJK', 'B', 11)
            pdf.cell(pdf.epw, 7, '目  录', align='C')
            pdf.ln(9)
            for i, (label, _, depth) in enumerate(items):
                indent = depth * 12
                pdf.set_x(pdf.l_margin + indent)
                pdf.set_font('CJK', '', 9)
                pn = item_pages.get(i, i + 1) + toc_pages
                pdf.multi_cell(pdf.epw - indent, 6, f"{label}  . . .  {pn}")

        pdf.add_page()

        for i, (label, content_html, depth) in enumerate(items):
            _render_item(pdf, label, content_html, depth, sep=(i < len(items) - 1))
    else:
        pdf.set_font('Courier', '', 12)
        pdf.multi_cell(pdf.epw, 8, f"[PDF Export: {title}]")
        pdf.ln(5)
        for label, content_html, depth in items:
            text = _html_to_pdf_text(content_html) if content_html else ''
            pdf.multi_cell(pdf.epw, 6, f"{label}\n{text}\n")

    return pdf.output()


def _build_standalone_subtree_html(tab_name, items, title, dest_dir=None):
    """Build a standalone interactive HTML for a subtree (for ZIP export).
    If *dest_dir* is given, images referenced in the HTML are copied into
    ``dest_dir/images/`` and their ``src`` attributes rewritten to match."""
    content_data = {}
    img_pattern = re.compile(r'/uploads/' + re.escape(tab_name) + r'/images/')

    # Build tree structure AND content_data in ONE pass, using SAME uuid for both.
    tree_data = []
    depth_stack = [tree_data]
    for label, content_html, depth in items:
        item_id = str(uuid.uuid4())
        node = {
            'id': item_id,
            'label': label,
            'children': [],
        }
        # Store content under the same uuid — copy images first if dest_dir given
        html = content_html
        if html:
            html = img_pattern.sub('images/', html)
            if dest_dir:
                html = _copy_export_images(html, tab_name, dest_dir)
        content_data[item_id] = html

        # Find parent based on depth
        while len(depth_stack) > depth + 1:
            depth_stack.pop()
        depth_stack[-1].append(node)
        depth_stack.append(node['children'])

    title_escaped = title.replace('&', '&amp;').replace('<', '&lt;').replace('"', '&quot;')
    content_json = json.dumps(content_data, ensure_ascii=False)

    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title_escaped}</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif; height:100vh; display:flex; color:#333; }}
  #sidebar {{ width:300px; min-width:200px; display:flex; flex-direction:column; border-right:1px solid #ddd; background:#fff; }}
  #tree {{ flex:1; overflow:auto; padding:8px 0; }}
  #main {{ flex:1; display:flex; flex-direction:column; }}
  #content {{ flex:1; overflow:auto; padding:20px; position:relative; }}
  #placeholder {{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#999; font-size:14px; }}
  .node {{ user-select:none; }}
  .node-header {{ display:flex; align-items:center; padding:4px 8px; cursor:pointer; border-radius:3px; margin:1px 4px; }}
  .node-header:hover {{ background:#e8f0fe; }}
  .node-header.active {{ background:#d4e4fc; font-weight:600; }}
  .toggle {{ width:18px; font-size:10px; color:#888; flex-shrink:0; cursor:pointer; }}
  .toggle.empty {{ visibility:hidden; }}
  .label {{ flex:1; font-size:13px; padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .children {{ padding-left:20px; }}
  img {{ max-width:100%; height:auto !important; }}
  table {{ border-collapse:collapse; }}
  td, th {{ border:1px solid #ccc; padding:4px 8px; }}
</style>
</head>
<body>
<div id="sidebar">
  <div id="tree"></div>
</div>
<div id="main">
  <div id="content">
    <div id="placeholder">Select an item</div>
    <div id="content-area"></div>
  </div>
</div>
<script>
var CONTENT_DATA = {content_json};
(function() {{
  var treeEl = document.getElementById('tree');
  var contentArea = document.getElementById('content-area');
  var placeholder = document.getElementById('placeholder');

  function render(items, container) {{
    items.forEach(function(item) {{
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
      if (hasKids) {{
        var ch = document.createElement('div');
        ch.className = 'children';
        render(item.children, ch);
        div.appendChild(ch);
        tgl.addEventListener('click', function(e) {{ e.stopPropagation(); var d = ch.style.display; ch.style.display = d==='none'?'':'none'; this.textContent = d==='none'?'\\u25BE':'\\u25B8'; }});
      }}
      hdr.addEventListener('click', function() {{
        var act = document.querySelectorAll('.node-header');
        for (var i = 0; i < act.length; i++) act[i].classList.remove('active');
        this.classList.add('active');
        var html = CONTENT_DATA[item.id];
        if (html) {{
          contentArea.innerHTML = html;
          contentArea.style.display = 'block';
          placeholder.style.display = 'none';
        }}
      }});
      container.appendChild(div);
    }});
  }}
  render({json.dumps(tree_data, ensure_ascii=False)}, treeEl);
}})();
</script>
</body>
</html>'''


def _export_temp_dir():
    """Create a temp directory for ZIP exports and return its Path."""
    _cleanup_old_exports()
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    tmp_dir = _EXPORT_DIR / f'export_{ts}_{uuid.uuid4().hex[:6]}'
    tmp_dir.mkdir(parents=True, exist_ok=True)
    return tmp_dir


def _copy_export_images(html_content, tab_name, dest_dir):
    """Copy referenced images from HTML to dest_dir/images/ and rewrite img src attributes.
    Returns the modified HTML with updated image paths."""
    img_pattern = re.compile(r'(<img[^>]+src=[\'"])([^\'"]+)([\'"][^>]*>)', re.IGNORECASE)

    def _replace_img(match):
        prefix = match.group(1)
        src = match.group(2)
        suffix = match.group(3)
        if src.startswith('data:'):
            return match.group(0)
        img_data = None
        img_filename = None
        # URL pattern: /uploads/<tab>/images/<filename>
        m = re.match(r'^/uploads/([^/]+)/images/(.+)$', src)
        if m:
            img_data = read_tab_file(m.group(1), f'images/{m.group(2)}')
            img_filename = m.group(2)
        else:
            rel = src.lstrip('/')
            img_data = read_tab_file(tab_name, rel)
            img_filename = os.path.basename(rel)
        if img_data is not None and img_filename:
            img_dest = dest_dir / 'images'
            img_dest.mkdir(exist_ok=True)
            dest_file = img_dest / img_filename
            dest_file.write_bytes(img_data)
            return f'{prefix}images/{img_filename}{suffix}'
        return match.group(0)

    return img_pattern.sub(_replace_img, html_content)


# ─── Markdown Export Helpers ─────────────────────────────────────────────

_MERMAID_OPEN_PAT = re.compile(
    r'<div\b[^>]*?class="[^"]*mermaid-block[^"]*"[^>]*>',
    re.IGNORECASE,
)
_MERMAID_SOURCE_PAT = re.compile(r'data-mermaid-source="([^"]*)"')


def _replace_mermaid_blocks(html_content):
    """Replace mermaid-block divs with placeholders.

    Returns (modified_html, {placeholder_key: mermaid_source}).
    Uses depth-counting to correctly match nested <div> tags.
    """
    sources = {}
    pieces = []
    pos = 0
    counter = 0

    for m in _MERMAID_OPEN_PAT.finditer(html_content):
        source_m = _MERMAID_SOURCE_PAT.search(m.group(0))
        if not source_m:
            continue

        # Find matching </div> by counting depth
        start = m.start()
        scan = m.end()
        depth = 1
        div_open_re = re.compile(r'<div\b', re.IGNORECASE)
        div_close_re = re.compile(r'</div>', re.IGNORECASE)

        while depth > 0 and scan < len(html_content):
            next_open = div_open_re.search(html_content, scan)
            next_close = div_close_re.search(html_content, scan)
            if next_close is None:
                scan = len(html_content)
                break
            if next_open and next_open.start() < next_close.start():
                depth += 1
                scan = next_open.end()
            else:
                depth -= 1
                scan = next_close.end()
                if depth == 0:
                    break

        key = f'\x00MERMAID{counter}\x00'
        sources[key] = html_module.unescape(source_m.group(1))
        pieces.append(html_content[pos:start])
        pieces.append(key)
        pos = scan
        counter += 1

    pieces.append(html_content[pos:])
    return ''.join(pieces), sources


def _table_to_md(rows, has_th):
    """Convert table rows to Markdown pipe-table syntax."""
    if not rows:
        return ''

    max_cols = max(len(row) for row in rows)
    for row in rows:
        while len(row) < max_cols:
            row.append('')

    lines = []
    lines.append('| ' + ' | '.join(rows[0]) + ' |')
    lines.append('| ' + ' | '.join(['---'] * max_cols) + ' |')
    for row in rows[1:]:
        lines.append('| ' + ' | '.join(row) + ' |')

    return '\n'.join(lines) + '\n'


def _copy_image_for_md(src, tab_name, dest_dir):
    """Copy an image to dest_dir/images/ and return the relative path for MD.

    Handles both data: URIs and /uploads/<tab>/images/<filename> paths.
    Returns None if the image can't be resolved.
    """
    if not src:
        return None

    if src.startswith('data:'):
        m = re.match(r'data:image/(\w+);base64,(.+)', src, re.DOTALL)
        if m:
            ext = m.group(1)
            if ext == 'jpeg':
                ext = 'jpg'
            try:
                img_data = base64.b64decode(m.group(2))
            except Exception:
                return None
            img_dir = dest_dir / 'images'
            img_dir.mkdir(exist_ok=True)
            filename = f'inline_{uuid.uuid4().hex[:8]}.{ext}'
            (img_dir / filename).write_bytes(img_data)
            return f'images/{filename}'
        return None

    img_data = None
    img_filename = None

    m = re.match(r'^/uploads/([^/]+)/images/(.+)$', src)
    if m:
        img_data = read_tab_file(m.group(1), f'images/{m.group(2)}')
        img_filename = m.group(2)
    else:
        rel = src.lstrip('/')
        img_data = read_tab_file(tab_name, rel)
        img_filename = os.path.basename(rel)

    if img_data is not None and img_filename:
        img_dir = dest_dir / 'images'
        img_dir.mkdir(exist_ok=True)
        (img_dir / img_filename).write_bytes(img_data)
        return f'images/{img_filename}'

    return None


def _generate_md(items, title, tab_name, dest_dir):
    """Generate Markdown content from collected items.

    items: [(label, content_html, depth), ...]
    Images are copied to dest_dir/images/.
    Returns the markdown string.
    """
    try:
        from markdownify import markdownify as md_convert
    except ImportError:
        md_convert = None

    lines = [f'# {title}\n']

    for label, content_html, depth in items:
        heading = '#' * min(depth + 2, 6)
        lines.append(f'\n{heading} {label}\n')

        if not content_html or not content_html.strip():
            continue

        processed_html, mermaid_sources = _replace_mermaid_blocks(content_html)

        for elem_type, fragment in _iter_dom_elements(processed_html):
            if elem_type == 'text':
                for key, source in mermaid_sources.items():
                    if key in fragment:
                        lines.append(f'\n```mermaid\n{source}\n```\n')
                        fragment = fragment.replace(key, '')

                fragment = re.sub(
                    r'<div\b[^>]*class="[^"]*mermaid-(?:header|render)[^"]*"[^>]*>.*?</div>',
                    '', fragment, flags=re.DOTALL | re.IGNORECASE,
                )
                fragment = re.sub(
                    r'<pre\b[^>]*class="[^"]*mermaid-source-edit[^"]*"[^>]*>.*?</pre>',
                    '', fragment, flags=re.DOTALL | re.IGNORECASE,
                )

                if md_convert:
                    md_text = md_convert(
                        fragment,
                        strip=['img', 'svg'],
                        heading_style='ATX',
                        bullets='-',
                    )
                else:
                    md_text = _html_to_pdf_text(fragment)

                if md_text and md_text.strip():
                    lines.append(md_text.strip() + '\n')

            elif elem_type == 'table':
                rows, has_th = _parse_html_table(fragment)
                if rows:
                    lines.append(_table_to_md(rows, has_th))

            elif elem_type == 'img':
                src_match = re.search(r'src=[\'"]([^\'"]+)[\'"]', fragment)
                if src_match:
                    local_path = _copy_image_for_md(src_match.group(1), tab_name, dest_dir)
                    if local_path:
                        lines.append(f'\n![]({local_path})\n')

            elif elem_type == 'svg':
                # Skip SVGs — mermaid ones already handled via source code
                pass

    return '\n'.join(lines)


def _build_md_export(tab_name, items, title, filename_base):
    """Build MD export: plain .md if no images, ZIP (.md + images/) otherwise.

    Returns (file_path, download_filename, mimetype).
    """
    tmp_dir = _export_temp_dir()
    try:
        md_content = _generate_md(items, title, tab_name, tmp_dir)
        has_images = (tmp_dir / 'images').exists() and any((tmp_dir / 'images').iterdir())

        if not has_images:
            md_filename = f'{filename_base}.md'
            md_path = _EXPORT_DIR / md_filename
            md_path.write_text(md_content, encoding='utf-8')
            return md_path, md_filename, 'text/markdown'

        (tmp_dir / 'index.md').write_text(md_content, encoding='utf-8')
        date_str = datetime.now().strftime('%Y%m%d')
        zip_filename = f'{filename_base}-{date_str}.zip'
        zip_path = _EXPORT_DIR / zip_filename

        with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(tmp_dir):
                rel_dir = os.path.relpath(root, tmp_dir)
                for f in files:
                    file_path = os.path.join(root, f)
                    arcname = os.path.join(rel_dir, f)
                    zf.write(file_path, arcname)

        return zip_path, zip_filename, 'application/zip'
    finally:
        shutil.rmtree(str(tmp_dir), ignore_errors=True)


# ─── Tab PDF Export ──────────────────────────────────────────────────────

@app.route('/api/<tab>/export/pdf')
def export_tab_pdf(tab):
    if _single_user_mode:
        user = {'username': 'admin', 'role': 'admin'}
    else:
        token = request.headers.get('X-Auth-Token', '')
        user = get_session_user(token)
    if not user or not can_export_tab(tab, user):
        return jsonify({'error': '无权限导出该知识库'}), 403
    try:
        if not get_tab_path(tab):
            return jsonify({'error': 'Tab not found'}), 404

        items = _collect_all_tab_content(tab)
        if not items:
            return jsonify({'error': 'No content to export'}), 400

        pdf_bytes = _generate_pdf(items, tab, tab_name=tab)
        filename = f"{tab}.pdf"
        buf = io.BytesIO(pdf_bytes)
        buf.seek(0)
        return send_file(buf, mimetype='application/pdf', as_attachment=True, download_name=filename)
    except Exception as e:
        log_error('export_tab_pdf', e, tab)
        return jsonify({'error': f'PDF generation failed: {e}'}), 500


# ─── Tab ZIP Export ──────────────────────────────────────────────────────

@app.route('/api/<tab>/export/zip')
def export_tab_zip(tab):
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user or not can_export_tab(tab, user):
        return jsonify({'error': '无权限导出该知识库'}), 403
    try:
        tab_path = get_tab_path(tab)
        if not tab_path:
            return jsonify({'error': 'Tab not found'}), 404

        _cleanup_old_exports()
        date_str = datetime.now().strftime('%Y%m%d')
        filename = f"{tab}-{date_str}.zip"
        zip_path = _EXPORT_DIR / filename

        tab_encrypted = is_tab_encrypted(tab)
        tab_unlocked = get_cached_encryption_key(tab) is not None

        # Create zip of the tab's data folder
        with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(tab_path):
                rel_dir = os.path.relpath(root, tab_path.parent)
                for f in files:
                    file_path = os.path.join(root, f)
                    arcname = os.path.join(rel_dir, f)

                    # For encrypted+unlocked tabs, decrypt .enc files on-the-fly
                    if tab_encrypted and tab_unlocked and f.endswith('.enc'):
                        orig_name = f[:-4]  # strip .enc
                        tab_rel = os.path.relpath(root, tab_path)
                        if tab_rel == '.':
                            tab_rel_path = orig_name
                        else:
                            tab_rel_path = os.path.join(tab_rel, orig_name)
                        tab_rel_path = tab_rel_path.replace('\\', '/')
                        data = read_tab_file(tab, tab_rel_path)
                        if data is not None:
                            # Write decrypted content with original filename
                            arcname = os.path.join(rel_dir, orig_name)
                            zf.writestr(arcname, data)
                            continue

                    zf.write(file_path, arcname)

        return send_file(str(zip_path), mimetype='application/zip', as_attachment=True, download_name=filename)
    except Exception as e:
        log_error('export_tab_zip', e, tab)
        return jsonify({'error': f'ZIP generation failed: {e}'}), 500


# ─── Tree Item PDF Export ────────────────────────────────────────────────

@app.route('/api/<tab>/export/pdf/<item_id>')
def export_tree_item_pdf(tab, item_id):
    if _single_user_mode:
        user = {'username': 'admin', 'role': 'admin'}
    else:
        token = request.headers.get('X-Auth-Token', '')
        user = get_session_user(token)
    if not user or not can_export_tab(tab, user):
        return jsonify({'error': '无权限导出'}), 403
    try:
        if not get_tab_path(tab):
            return jsonify({'error': 'Tab not found'}), 404

        menu = load_menu(tab)
        item = find_menu_item(menu, item_id)
        if not item:
            return jsonify({'error': 'Item not found'}), 404

        items = _collect_subtree_content(tab, menu, item_id, 0)
        if not items:
            return jsonify({'error': 'No content to export'}), 400

        title = f"{tab} - {item['label']}"
        pdf_bytes = _generate_pdf(items, title, tab_name=tab)
        safe_name = re.sub(r'[\\/*?:"<>|]', '_', item['label'])
        filename = f"{safe_name}.pdf"
        buf = io.BytesIO(pdf_bytes)
        buf.seek(0)
        return send_file(buf, mimetype='application/pdf', as_attachment=True, download_name=filename)
    except Exception as e:
        log_error('export_tree_item_pdf', e, f'{tab}/{item_id}')
        return jsonify({'error': f'PDF generation failed: {e}'}), 500


# ─── Tree Item ZIP Export ────────────────────────────────────────────────

@app.route('/api/<tab>/export/zip/<item_id>')
def export_tree_item_zip(tab, item_id):
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user or not can_export_tab(tab, user):
        return jsonify({'error': '无权限导出'}), 403
    try:
        if not get_tab_path(tab):
            return jsonify({'error': 'Tab not found'}), 404

        menu = load_menu(tab)
        item = find_menu_item(menu, item_id)
        if not item:
            return jsonify({'error': 'Item not found'}), 404

        items = _collect_subtree_content(tab, menu, item_id, 0)
        if not items:
            return jsonify({'error': 'No content to export'}), 400

        title = f"{tab} - {item['label']}"

        # Create temp directory and write files
        tmp_dir = _export_temp_dir()
        safe_name = re.sub(r'[\\/*?:"<>|]', '_', item['label'])
        filename = f"{safe_name}.zip"
        zip_path = _EXPORT_DIR / filename

        try:
            # Build standalone HTML — also copies images into tmp_dir/images/
            html = _build_standalone_subtree_html(tab, items, title, dest_dir=tmp_dir)
            index_path = tmp_dir / 'index.html'
            index_path.write_text(html, encoding='utf-8')

            # Create zip
            with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
                for root, dirs, files in os.walk(tmp_dir):
                    rel_dir = os.path.relpath(root, tmp_dir)
                    for f in files:
                        file_path = os.path.join(root, f)
                        arcname = os.path.join(rel_dir, f)
                        zf.write(file_path, arcname)

            return send_file(str(zip_path), mimetype='application/zip', as_attachment=True, download_name=filename)
        finally:
            # Clean up temp dir
            shutil.rmtree(str(tmp_dir), ignore_errors=True)
    except Exception as e:
        log_error('export_tree_item_zip', e, f'{tab}/{item_id}')
        return jsonify({'error': f'ZIP generation failed: {e}'}), 500


# ─── Markdown Export ─────────────────────────────────────────────────────

@app.route('/api/<tab>/export/md')
def export_tab_md(tab):
    if _single_user_mode:
        user = {'username': 'admin', 'role': 'admin'}
    else:
        token = request.headers.get('X-Auth-Token', '')
        user = get_session_user(token)
    if not user or not can_export_tab(tab, user):
        return jsonify({'error': '无权限导出该知识库'}), 403
    try:
        if not get_tab_path(tab):
            return jsonify({'error': 'Tab not found'}), 404

        items = _collect_all_tab_content(tab)
        if not items:
            return jsonify({'error': 'No content to export'}), 400

        _cleanup_old_exports()
        safe_name = re.sub(r'[\\/*?:"<>|]', '_', tab)
        file_path, filename, mimetype = _build_md_export(tab, items, tab, safe_name)
        return send_file(str(file_path), mimetype=mimetype, as_attachment=True, download_name=filename)
    except Exception as e:
        log_error('export_tab_md', e, tab)
        return jsonify({'error': f'MD generation failed: {e}'}), 500


@app.route('/api/<tab>/export/md/<item_id>')
def export_tree_item_md(tab, item_id):
    if _single_user_mode:
        user = {'username': 'admin', 'role': 'admin'}
    else:
        token = request.headers.get('X-Auth-Token', '')
        user = get_session_user(token)
    if not user or not can_export_tab(tab, user):
        return jsonify({'error': '无权限导出'}), 403
    try:
        if not get_tab_path(tab):
            return jsonify({'error': 'Tab not found'}), 404

        menu = load_menu(tab)
        item = find_menu_item(menu, item_id)
        if not item:
            return jsonify({'error': 'Item not found'}), 404

        items = _collect_subtree_content(tab, menu, item_id, 0)
        if not items:
            return jsonify({'error': 'No content to export'}), 400

        title = f"{tab} - {item['label']}"
        _cleanup_old_exports()
        safe_name = re.sub(r'[\\/*?:"<>|]', '_', item['label'])
        file_path, filename, mimetype = _build_md_export(tab, items, title, safe_name)
        return send_file(str(file_path), mimetype=mimetype, as_attachment=True, download_name=filename)
    except Exception as e:
        log_error('export_tree_item_md', e, f'{tab}/{item_id}')
        return jsonify({'error': f'MD generation failed: {e}'}), 500


# ─── User Authentication API Routes ─────────────────────────────────────────

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    """Login: verify username/password, return session token."""
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400
    result = verify_login(username, password)
    if not result:
        return jsonify({'error': '用户名或密码错误'}), 401
    return jsonify(result)


@app.route('/api/auth/logout', methods=['POST'])
def api_logout():
    """Logout: invalidate session token."""
    token = request.headers.get('X-Auth-Token', '')
    logout_session(token)
    return jsonify({'success': True})


@app.route('/api/auth/me')
def api_auth_me():
    """Return current user info from session token."""
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        return jsonify({'user': None})
    return jsonify({'user': user})


@app.route('/api/auth/change-password', methods=['PUT'])
def api_change_password():
    """Change own password (no old password needed)."""
    user = require_auth()
    data = request.get_json() or {}
    new_password = data.get('new_password', '')
    if len(new_password) < 1:
        return jsonify({'error': '密码不能为空'}), 400
    err = update_user_password(user['username'], new_password)
    if err:
        return jsonify({'error': err}), 500
    return jsonify({'success': True})


@app.route('/api/admin/users')
def api_admin_list_users():
    """Return list of all non-admin users."""
    require_admin()
    return jsonify(get_all_users())


@app.route('/api/admin/users', methods=['POST'])
def api_admin_create_user():
    """Create a new normal user."""
    require_admin()
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username:
        return jsonify({'error': '用户名不能为空'}), 400
    if not password or len(password) < 1:
        return jsonify({'error': '密码不能为空'}), 400
    err = create_user(username, password)
    if err:
        return jsonify({'error': err}), 409
    return jsonify({'success': True}), 201


@app.route('/api/admin/users/<username>', methods=['DELETE'])
def api_admin_delete_user(username):
    """Delete a normal user and move their KBs to admin."""
    require_admin()
    if username.lower() == 'admin':
        return jsonify({'error': '不能删除admin用户'}), 400
    err = delete_user(username)
    if err:
        return jsonify({'error': err}), 400
    return jsonify({'success': True})


@app.route('/api/admin/users/<username>/reset-password', methods=['PUT'])
def api_admin_reset_user_password(username):
    """Admin force-resets a user's password (resets their sessions)."""
    require_admin()
    data = request.get_json() or {}
    new_password = data.get('new_password', '')
    if not new_password or len(new_password) < 1:
        return jsonify({'error': '密码不能为空'}), 400
    err = force_reset_user_password(username, new_password)
    if err:
        return jsonify({'error': err}), 400
    return jsonify({'success': True})


@app.route('/api/admin/change-password', methods=['PUT'])
def api_admin_change_password():
    """Admin changes own password."""
    user = require_admin()
    data = request.get_json() or {}
    new_password = data.get('new_password', '')
    if len(new_password) < 1:
        return jsonify({'error': '密码不能为空'}), 400
    err = update_user_password(user['username'], new_password)
    if err:
        return jsonify({'error': err}), 500
    return jsonify({'success': True})


# ─── Tab Ownership API Routes ──────────────────────────────────────────────


@app.route('/api/tab-owner/<tab>')
def api_get_tab_owner(tab):
    """Get owner of a tab."""
    require_auth()
    owner = get_tab_owner(tab)
    return jsonify({'owner': owner})


@app.route('/api/tab-owner/<tab>', methods=['PUT'])
def api_set_tab_owner(tab):
    """Set owner of a tab (admin only). Also moves tab directory."""
    require_admin()
    data = request.get_json() or {}
    owner = data.get('owner', '')
    if owner == '':
        # Moving to admin (root)
        owner = ''
    else:
        # Verify user exists and is not admin
        user = get_user(owner)
        if not user:
            return jsonify({'error': '用户不存在'}), 404
        if user['role'] == 'admin':
            return jsonify({'error': '不能设置为admin'}), 400

    # Cannot set owner on a discussion tab while it's unlocked (public_edit enabled)
    if get_tab_public_edit(tab):
        return jsonify({'error': '讨论区知识库在解锁可编辑状态下不能设置Owner，请先加锁不可编辑'}), 400

    old_path = get_tab_path_with_owner(tab)
    if not old_path or not old_path.exists():
        return jsonify({'error': 'Tab不存在'}), 404

    # Move directory to new owner's location
    if owner == '':
        new_path = mybase_dir / tab
    else:
        new_path = user_data_dir / owner / tab
        new_path.parent.mkdir(parents=True, exist_ok=True)

    if old_path != new_path:
        if new_path.exists():
            shutil.rmtree(str(new_path))
        old_path.rename(new_path)

    set_tab_owner(tab, owner)

    # Notify ALL connected clients to refresh tab lists — ownership change
    # affects visibility for every user (the tab may appear/disappear).
    socketio.emit('tabs_updated', {})

    return jsonify({'success': True})


@app.route('/api/tabs-with-owner')
def api_list_tabs_with_owner():
    """List all tabs with their owner information, filtered by user visibility."""
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)

    all_tabs_set = set()
    if mybase_dir.exists():
        for entry in mybase_dir.iterdir():
            if entry.is_dir() and _is_valid_tab_dir(entry.name):
                all_tabs_set.add(entry.name)
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                for tab_entry in user_entry.iterdir():
                    if tab_entry.is_dir() and _is_valid_tab_dir(tab_entry.name):
                        all_tabs_set.add(tab_entry.name)

    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, owner FROM tab_owner")
        owner_map = dict(cursor.fetchall())

        public_edit_map = get_all_tab_public_edits()

        result = []
        for tab in sorted(all_tabs_set):
            owner = owner_map.get(tab, '')
            public_edit = public_edit_map.get(tab, False)
            if user:
                # Filter by visibility
                if user['role'] == 'admin':
                    result.append({'name': tab, 'owner': owner, 'public_edit': public_edit})
                else:
                    if owner == '' or owner == user['username']:
                        result.append({'name': tab, 'owner': owner, 'public_edit': public_edit})
            else:
                # No auth - only show admin tabs
                if owner == '':
                    result.append({'name': tab, 'owner': owner, 'public_edit': public_edit})
        return jsonify(result)
    finally:
        conn.close()


# ─── Public Edit (Discussion Mode) API Routes ──────────────────────────────


@app.route('/api/tabs-public-edit')
def api_get_tabs_public_edit():
    """Return dict of {tab_name: bool} for all tabs with public edit enabled."""
    require_auth()
    return jsonify(get_all_tab_public_edits())


@app.route('/api/tabs/<tab>/public-edit', methods=['PUT'])
def api_set_tab_public_edit(tab):
    """Set public edit (discussion mode) for a tab. Requires write access."""
    _auth_check_write(tab)
    data = request.get_json() or {}
    enabled = data.get('public_edit', False)
    set_tab_public_edit(tab, bool(enabled))
    # Notify other windows
    try:
        socketio.emit('tabs_updated', {})
    except Exception:
        pass
    return jsonify({'success': True})


# ─── User-Specific Tab Ordering ────────────────────────────────────────────


@app.route('/api/user-tab-order')
def api_get_user_tab_order():
    """Get tab order for current user."""
    user = require_auth()
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT tab_name, sort_order, visible FROM user_tab_visibility WHERE username = ? ORDER BY sort_order",
            (user['username'],)
        )
        items = [{'tab_name': r[0], 'sort_order': r[1], 'visible': bool(r[2])} for r in cursor.fetchall()]
        return jsonify(items)
    finally:
        conn.close()


@app.route('/api/user-tab-order', methods=['PUT'])
def api_set_user_tab_order():
    """Save tab order and visibility for current user."""
    user = require_auth()
    data = request.get_json()
    if not isinstance(data, list):
        return jsonify({'error': 'Expected a list'}), 400
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM user_tab_visibility WHERE username = ?", (user['username'],))
        for i, item in enumerate(data):
            tab_name = item.get('tab_name', '')
            visible = 1 if item.get('visible', True) else 0
            is_active = 1 if item.get('is_active', False) else 0
            conn.execute(
                "INSERT INTO user_tab_visibility (username, tab_name, visible, sort_order, is_active) VALUES (?, ?, ?, ?, ?)",
                (user['username'], tab_name, visible, i, is_active)
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({'success': True})


@app.route('/api/user-tab-current-items')
def api_get_user_tab_current_items():
    """Return dict of {tab_name: current_item_id} for the current user."""
    token = request.headers.get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        return jsonify({})
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT tab_name, current_item_id FROM user_tab_current_item WHERE username = ?",
            (user['username'],)
        )
        return jsonify({row[0]: row[1] for row in cursor.fetchall()})
    finally:
        conn.close()


@app.route('/api/user-tab-current-item', methods=['PUT'])
def api_set_user_tab_current_item():
    """Set current item for a tab for the current user."""
    user = require_auth()
    data = request.get_json() or {}
    tab_name = data.get('tab_name', '')
    item_id = data.get('current_item_id', '')
    if not tab_name:
        return jsonify({'error': 'tab_name required'}), 400
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO user_tab_current_item (username, tab_name, current_item_id, scroll_top) VALUES (?, ?, ?, 0)",
            (user['username'], tab_name, item_id)
        )
        # Also record this as the user's current selected tab
        conn.execute("UPDATE user_tab_visibility SET is_active = 0 WHERE username = ?", (user['username'],))
        cursor = conn.execute(
            "UPDATE user_tab_visibility SET is_active = 1 WHERE username = ? AND tab_name = ?",
            (user['username'], tab_name)
        )
        if cursor.rowcount == 0:
            conn.execute(
                "INSERT INTO user_tab_visibility (username, tab_name, visible, sort_order, is_active) VALUES (?, ?, 1, 0, 1)",
                (user['username'], tab_name)
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({'success': True})


def main():
    """Entry point: parse args, init, start server.

    Extracted so that the compiled Cython module exposes a callable entry
    point for ``main.py`` (the thin loader).  Also keeps ``python server.py``
    working as before.
    """
    global ocr_process_pool
    try:
        init_config()
        print("=" * 60)
        print(f"  Web of Mybase Knowledge Server  {version}")
        print("=" * 60)
        print(f"  Data directory: {data_dir}")
        print(f"  MyBase directory: {mybase_dir}")
        if force_index_target:
            print(f"  Force reindex: {force_index_target}")
        if ocr_disabled:
            print(f"  OCR disabled via --disable-ocr")
        elif ocr_mobile:
            print(f"  OCR model: mobile (lightweight)")
        else:
            print(f"  OCR model: server (high accuracy)")
        print(f"  Server URL: http://0.0.0.0:{server_port}")
        if _single_user_mode:
            print(f"  Single-user mode: login disabled (auto-admin)")
        print("=" * 60)

        # Start OCR process pool
        if not ocr_disabled:
            ocr_process_pool = OCRProcessPool(workers_ocr)

        init_common_db()
        print("  Checking indexes...")
        ensure_indexes()
        print("  Done.")
        print("=" * 60)
        socketio.run(app, host='0.0.0.0', port=server_port, debug=False, allow_unsafe_werkzeug=True)
    except KeyboardInterrupt:
        _shutdown_requested.set()
        if ocr_process_pool is not None:
            ocr_process_pool.shutdown()
        print("\n  [EXIT] Shutdown complete. Bye.")
        sys.exit(1)


if __name__ == '__main__':
    main()

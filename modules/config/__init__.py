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

# ─── Version ────────────────────────────────────────────────────────────────
def _read_version():
    try:
        v = Path(__file__).parent.parent.parent / 'VERSION'
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


BASE_DIR = Path(__file__).parent.parent.parent

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

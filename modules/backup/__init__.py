import os
import io
import time
import uuid
import json
import re
import html.parser
import threading
import zipfile
import shutil
import tempfile
import base64
from pathlib import Path
from datetime import datetime

from modules.config import BASE_DIR, data_dir, mybase_dir, user_data_dir, common_db, index_db_dir, log_error, _is_valid_tab_dir
from modules.auth import get_session_user, get_user_visible_tabs, get_tab_owner, get_tab_path_with_owner


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


# ─── Backup API Helpers ──────────────────────────────────────────────────

def start_backup_task(user):
    """Start a backup in background. Returns (task_id, total)."""
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

    return task_id, total


def get_backup_status(task_id):
    """Get status of a backup task."""
    with _backup_lock:
        task = _backup_tasks.get(task_id)
    return task


def get_backup_filename(task_id):
    """Get filename of completed backup task."""
    with _backup_lock:
        task = _backup_tasks.get(task_id)
    if task and task['done'] and not task['error']:
        return task['filename']
    return None

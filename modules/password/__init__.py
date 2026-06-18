import os
import sqlite3
import threading
from pathlib import Path

import bcrypt
from Crypto.Protocol.KDF import PBKDF2

from modules.config import common_db, log_error
from modules.compat import _get_current_sid
from modules.encryption import (
    _read_decrypted_file,
    _write_encrypted_file,
    _encrypt_all_tab_files as _encrypt_all,
    _decrypt_all_tab_files as _decrypt_all,
)


def _get_tab_path(tab_name: str):
    """Late-import get_tab_path to avoid circular import (modules.tab imports modules.password)."""
    from modules.tab import get_tab_path as _gp
    return _gp(tab_name)


# === Password & Encryption System ==========================================

_session_encryption_keys: dict[str, dict[str, bytes]] = {}
_session_encryption_keys_lock = threading.Lock()


def _init_password_tables():
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
    if not common_db.exists():
        return []
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_passwords")
        return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


def set_tab_password(tab_name: str, password: str) -> str:
    pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    new_salt = __import__('Crypto.Random', fromlist=['get_random_bytes']).get_random_bytes(16)
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

    _sid = _get_current_sid()
    with _session_encryption_keys_lock:
        if existing_salt:
            for keys in _session_encryption_keys.values():
                keys.pop(tab_name, None)
        if _sid:
            if _sid not in _session_encryption_keys:
                _session_encryption_keys[_sid] = {}
            _session_encryption_keys[_sid][tab_name] = new_key

    if not existing_salt:
        try:
            _encrypt_all(tab_name, new_key)
        except Exception as e:
            log_error("set_tab_password._encrypt_all_tab_files", e, tab_name)
            return f"加密文件失败: {e}"
    elif existing_salt != new_salt:
        try:
            _encrypt_all(tab_name, new_key)
        except Exception as e:
            log_error("set_tab_password._encrypt_all_tab_files", e, tab_name)
            return f"重新加密文件失败: {e}"

    return ""


def verify_tab_password(tab_name: str, password: str) -> bool:
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
    if not verify_tab_password(tab_name, password):
        return "密码验证失败"

    key = get_cached_encryption_key(tab_name)
    if key:
        try:
            _decrypt_all(tab_name, key)
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


def get_cached_encryption_key(tab_name: str, sid: str | None = None):
    if sid is None:
        sid = _get_current_sid()
    with _session_encryption_keys_lock:
        if sid:
            session_keys = _session_encryption_keys.get(sid)
            if session_keys:
                return session_keys.get(tab_name)
            return None
        for keys in _session_encryption_keys.values():
            if tab_name in keys:
                return keys[tab_name]
        return None


def clear_session_encryption_keys(sid: str):
    with _session_encryption_keys_lock:
        _session_encryption_keys.pop(sid, None)


# ─── Modified file I/O for encrypted tabs ─────────────────────────────────

def read_tab_file(tab_name: str, rel_path: str) -> bytes | None:
    tab_path = _get_tab_path(tab_name)
    if not tab_path:
        return None
    file_path = tab_path / rel_path

    key = get_cached_encryption_key(tab_name, _get_current_sid())
    if key:
        try:
            return _read_decrypted_file(file_path, key)
        except FileNotFoundError:
            return None
        except ValueError as e:
            log_error("read_tab_file", e, f"{tab_name}/{rel_path}")
            return None
    else:
        if is_tab_encrypted(tab_name):
            log_error("read_tab_file", Exception("access denied"),
                      f"{tab_name}/{rel_path} - tab is encrypted but not unlocked")
            return None
        if not file_path.exists():
            return None
        return file_path.read_bytes()


def write_tab_file(tab_name: str, rel_path: str, data: bytes) -> bool:
    tab_path = _get_tab_path(tab_name)
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


def read_tab_text(tab_name: str, rel_path: str, encoding='utf-8'):
    data = read_tab_file(tab_name, rel_path)
    if data is None:
        return None
    return data.decode(encoding)


def write_tab_text(tab_name: str, rel_path: str, text: str, encoding='utf-8') -> bool:
    return write_tab_file(tab_name, rel_path, text.encode(encoding))


def tab_file_exists(tab_name: str, rel_path: str) -> bool:
    tab_path = _get_tab_path(tab_name)
    if not tab_path:
        return False
    file_path = tab_path / rel_path
    if file_path.exists():
        return True
    enc_path = file_path.with_suffix(file_path.suffix + '.enc')
    return enc_path.exists()


def list_tab_files(tab_name: str, rel_dir: str) -> list[str]:
    tab_path = _get_tab_path(tab_name)
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

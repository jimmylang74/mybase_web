import os
import uuid
import sqlite3
import threading
import shutil

import bcrypt

from modules.config import common_db, mybase_dir, user_data_dir, _single_user_mode, log_error, _is_valid_tab_dir
from modules.compat import _get_current_sid
from modules.search import get_index_db_path


# === User Authentication System =============================================

_user_sessions: dict[str, dict] = {}
_user_sessions_lock = threading.Lock()


def _init_user_tables():
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


def get_user(username: str):
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
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT username, role FROM users WHERE role != 'admin' ORDER BY username"
        )
        return [{'username': row[0], 'role': row[1]} for row in cursor.fetchall()]
    finally:
        conn.close()


def create_user(username: str, password: str) -> str:
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

        cursor2 = conn.execute(
            "SELECT tab_name FROM tab_owner WHERE owner = ? COLLATE NOCASE", (username,)
        )
        owned_tabs = [r[0] for r in cursor2.fetchall()]

        user_base = user_data_dir / username
        for tab_name in owned_tabs:
            tab_path = user_data_dir / username / tab_name
            admin_path = mybase_dir / tab_name
            if tab_path.exists() and tab_path.is_dir():
                if admin_path.exists():
                    import shutil
                    shutil.move(str(tab_path), str(mybase_dir / f"{tab_name}_migrated_{uuid.uuid4().hex[:4]}"))
                else:
                    import shutil
                    shutil.move(str(tab_path), str(admin_path))
                old_db = get_index_db_path(f"{username}/{tab_name}")
                new_db = get_index_db_path(tab_name)
                if old_db.exists():
                    if new_db.exists():
                        old_db.unlink()
                    else:
                        old_db.rename(new_db)

        conn.execute(
            "UPDATE tab_owner SET owner = '' WHERE owner = ? COLLATE NOCASE",
            (username,)
        )

        conn.execute("DELETE FROM users WHERE username = ? COLLATE NOCASE", (username,))
        conn.execute("DELETE FROM user_tab_visibility WHERE username = ? COLLATE NOCASE", (username,))
        conn.execute("DELETE FROM user_tab_current_item WHERE username = ? COLLATE NOCASE", (username,))
        conn.commit()

        with _user_sessions_lock:
            tokens_to_remove = [
                token for token, sess in _user_sessions.items()
                if sess['username'].lower() == username.lower()
            ]
            for token in tokens_to_remove:
                sess = _user_sessions.pop(token, None)
                if sess and sess.get('sid'):
                    try:
                        from modules.app import socketio
                        socketio.emit('force_logout', {'reason': '用户已被管理员删除'}, room=sess['sid'])
                    except Exception:
                        pass

        try:
            from modules.app import socketio
            socketio.emit('tabs_updated', {}, room='admin_sync')
        except Exception:
            pass

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
    user = get_user(username)
    if not user:
        return '用户不存在'
    if user['role'] == 'admin':
        return '不能重置admin密码'
    err = update_user_password(username, new_password)
    if err:
        return err
    with _user_sessions_lock:
        tokens_to_remove = [
            token for token, sess in _user_sessions.items()
            if sess['username'].lower() == username.lower()
        ]
        for token in tokens_to_remove:
            sess = _user_sessions.pop(token, None)
            if sess and sess.get('sid'):
                try:
                    from modules.app import socketio
                    socketio.emit('force_logout', {
                        'reason': '管理员已重置您的密码，请重新登录'
                    }, room=sess['sid'])
                except Exception:
                    pass
    return ''


def verify_login(username: str, password: str):
    user = get_user(username)
    if not user:
        return None
    if not bcrypt.checkpw(password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        return None
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
    with _user_sessions_lock:
        _user_sessions.pop(token, None)


def get_session_user(token: str):
    with _user_sessions_lock:
        sess = _user_sessions.get(token)
        if sess:
            sid = _get_current_sid()
            if sid:
                sess['sid'] = sid
            return {'username': sess['username'], 'role': sess['role']}
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    return None


def require_auth():
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    token = request_header_get('X-Auth-Token', '')
    user = get_session_user(token)
    if not user:
        from flask import abort
        abort(401, description='未登录或会话已过期')
    return user


def require_admin():
    user = require_auth()
    if user['role'] != 'admin':
        from flask import abort
        abort(403, description='需要管理员权限')
    return user


def request_header_get(name, default=None):
    from flask import request
    return request.headers.get(name, default)


def _is_tab_name_globally_used(name: str):
    if mybase_dir.exists() and (mybase_dir / name).is_dir():
        return True, get_tab_owner(name)
    if user_data_dir.exists():
        for user_entry in user_data_dir.iterdir():
            if user_entry.is_dir() and not user_entry.name.startswith('.'):
                if (user_entry / name).is_dir():
                    return True, get_tab_owner(name)
    return False, ''


def get_tab_owner(tab_name: str) -> str:
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
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, public_edit FROM tab_public_edit WHERE public_edit = 1")
        return {row[0]: bool(row[1]) for row in cursor.fetchall()}
    finally:
        conn.close()


def get_tab_effective_path(tab_name: str):
    owner = get_tab_owner(tab_name)
    if owner and owner != '':
        user_base = user_data_dir / owner
        user_base.mkdir(exist_ok=True)
        tab_path = user_base / tab_name
        return tab_path
    return mybase_dir / tab_name


def get_tab_path_with_owner(tab_name: str):
    owner = get_tab_owner(tab_name)
    if owner and owner != '':
        user_path = user_data_dir / owner / tab_name
        if user_path.exists() and user_path.is_dir():
            return user_path
    root_path = mybase_dir / tab_name
    if root_path.exists() and root_path.is_dir():
        return root_path
    return None


def get_effective_tab_path(tab_name: str):
    return get_tab_path_with_owner(tab_name)


def _get_tab_path_with_owner(tab_name):
    return get_tab_path_with_owner(tab_name)


def can_read_tab(tab_name: str, user: dict) -> bool:
    owner = get_tab_owner(tab_name)
    if user['role'] == 'admin':
        return True
    if owner == '' or owner == user['username']:
        return True
    return False


def can_write_tab(tab_name: str, user: dict) -> bool:
    owner = get_tab_owner(tab_name)
    if user['role'] == 'admin':
        return True
    if owner == user['username']:
        return True
    if get_tab_public_edit(tab_name):
        return True
    return False


def can_delete_tab(tab_name: str, user: dict) -> bool:
    return user['role'] == 'admin'


def can_export_tab(tab_name: str, user: dict) -> bool:
    if user['role'] == 'admin':
        return True
    owner = get_tab_owner(tab_name)
    if owner == user['username']:
        return True
    if get_tab_public_edit(tab_name):
        return True
    return False


def get_user_visible_tabs(username: str, role: str) -> list[str]:
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

        visible = []
        cursor = conn.execute(
            "SELECT tab_name, owner FROM tab_owner"
        )
        owner_map = dict(cursor.fetchall())

        cursor = conn.execute(
            "SELECT tab_name, sort_order FROM user_tab_visibility WHERE username = ? AND visible = 1 ORDER BY sort_order",
            (username,)
        )
        user_ordered = [(r[0], r[1]) for r in cursor.fetchall()]

        user_tabs = set()
        for tab in all_tabs:
            owner = owner_map.get(tab, '')
            if owner == '' or owner == username:
                user_tabs.add(tab)

        ordered = []
        seen = set()
        for tab_name, _ in user_ordered:
            if tab_name in user_tabs:
                ordered.append(tab_name)
                seen.add(tab_name)
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

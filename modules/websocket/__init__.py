# ─── WebSocket Real-time Sync (Flask-SocketIO) ──────────────────────────

from flask_socketio import emit, join_room, leave_room

from modules.config import _item_locks_lock, _item_locks, log_error
from modules.password import is_tab_encrypted, get_cached_encryption_key, clear_session_encryption_keys
from modules.auth import get_tab_owner


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
        from modules.app import socketio
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
        from modules.app import socketio
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
        from modules.app import socketio
        socketio.emit(event, payload)
    except Exception:
        pass  # emit is best-effort outside SocketIO handler


# ─── SocketIO Event Handlers ────────────────────────────────────────────

def register_handlers(socketio):
    from flask import request as _flask_req

    @socketio.on('connect')
    def ws_handle_connect():
        print(f'  [WS] Client connected', flush=True)

    @socketio.on('disconnect')
    def ws_handle_disconnect():
        sid = _flask_req.sid
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
            if is_tab_encrypted(tab) and get_cached_encryption_key(tab, _flask_req.sid) is None:
                emit('sync_denied', {'tab': tab, 'reason': '加密知识库不能同步'}, room=_flask_req.sid)
                return
            join_room(f'tab:{tab}')
            # Also join user-specific room for auth-aware sync
            token = data.get('auth_token', '')
            from modules.auth import get_session_user
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
            emit('sync_denied', {'tab': tab, 'reason': '加密知识库不能同步'}, room=_flask_req.sid)
            return
        token = _flask_req.args.get('token', '')
        from modules.auth import get_session_user, can_write_tab
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
            emit('sync_denied', {'tab': tab, 'reason': '加密知识库不能同步'}, room=_flask_req.sid)
            return
        token = _flask_req.args.get('token', '')
        from modules.auth import get_session_user, can_write_tab
        user = get_session_user(token)
        if not user or not can_write_tab(tab, user):
            return
        key = (tab, item_id)
        sid = _flask_req.sid
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
        sid = _flask_req.sid
        with _item_locks_lock:
            if _item_locks.get(key) == sid:
                del _item_locks[key]

# ─── All HTTP API Route Handlers ─────────────────────────────────────────

import os
import re
import io
import uuid
import json
import sqlite3
import zipfile
import shutil
import stat
import threading
import mimetypes
import tempfile
import base64
from pathlib import Path
from datetime import datetime

from flask import request, jsonify, render_template, abort, send_file, send_from_directory
from werkzeug.utils import secure_filename

from modules.config import (
    BASE_DIR, data_dir, mybase_dir, user_data_dir, common_db, index_db_dir,
    server_port, version, _single_user_mode, _item_locks, _item_locks_lock,
    _indexing_counter, UPLOAD_DIR_NAME, _is_valid_tab_dir, _run_in_background,
    log_error, ocr_log, _shutdown_requested,
)
from modules.compat import _get_current_sid
from modules.database import (
    init_common_db, get_tab_order, set_tab_order, add_tab_to_order,
    remove_tab_from_order, init_tab_visibility,
    get_tab_visibility, set_tab_visibility_batch,
    get_user_tab_visibility, set_user_tab_visibility_batch, delete_tab_visibility,
    get_selected_tab, set_selected_tab,
    get_user_selected_tab, set_user_selected_tab,
    get_tab_current_items, set_tab_current_item, delete_tab_current_item,
    get_font_config, set_font_config, get_system_config, set_system_config,
)
from modules.auth import (
    get_session_user, require_auth, require_admin,
    verify_login, logout_session, get_user, get_all_users, create_user, delete_user,
    update_user_password, force_reset_user_password,
    get_tab_owner, set_tab_owner, get_tab_path_with_owner,
    get_tab_public_edit, set_tab_public_edit, get_all_tab_public_edits,
    can_read_tab, can_write_tab, can_export_tab,
    get_user_visible_tabs, _is_tab_name_globally_used,
)
from modules.tab import (
    get_tab_path, get_menu_path, get_nav_path, get_content_dir, get_upload_dir,
    load_menu, save_menu, load_content, save_content,
    rename_tab_in_index_db, rename_tab_in_common_db, regenerate_index_html,
    generate_standalone_html, _update_image_urls_after_rename,
)
from modules.menu import (
    find_menu_item, add_menu_item, add_menu_item_after,
    update_menu_item, delete_menu_item, move_menu_item, move_menu_item_to_parent,
)
from modules.search import (
    get_index_db_path, search_index, search_all_tabs, _tab_searchable,
    index_tab, update_item_in_index, update_item_meta_in_index,
    update_item_path_in_index, delete_item_from_index, compute_item_path,
    delete_tab_index, ensure_indexes,
)
from modules.password import (
    is_tab_encrypted, get_encrypted_tabs, get_cached_encryption_key,
    set_tab_password, verify_tab_password, remove_tab_password,
    read_tab_file, write_tab_file, clear_session_encryption_keys,
)
from modules.websocket import (
    ws_emit_menu_changed, ws_emit_content_saved, ws_emit_encrypted_tab_event,
    _collect_all_descendant_ids,
)
from modules.backup import start_backup_task, _get_backup_dir
from modules.export import (
    _EXPORT_DIR, _generate_pdf, _collect_all_tab_content, _collect_subtree_content,
    _build_standalone_subtree_html, _export_temp_dir, _cleanup_old_exports,
    _get_export_user, _copy_export_images,
)
from modules.ocr import extract_text_from_html_images


# ─── Page Routes ─────────────────────────────────────────────────────────

def register_routes(app, socketio):

    @app.route('/')
    def index():
        return render_template('index.html', version=version, single_user=_single_user_mode)

    @app.route('/help')
    def help_page():
        """Serve the comprehensive help documentation page."""
        lang = get_system_config('language') or 'zh-CN'
        return render_template('help.html', version=version, lang=lang)

    # ─── Tab Listing ──────────────────────────────────────────────────────

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

    # ─── Auth Check Helpers ───────────────────────────────────────────────

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

    # ─── Menu Routes ──────────────────────────────────────────────────────

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

    # ─── Content Routes ─────────────────────────────────────────────────

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
            index_html = regenerate_index_html(tab, tab_path)
            if index_html is not None:
                with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
                    f.write(index_html)
        ws_emit_content_saved(tab, item_id, content_html)
        return jsonify({'success': True})

    # ─── Upload Routes ──────────────────────────────────────────────────

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

    # ─── Visibility + Tab Ordering ──────────────────────────────────────

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

    # ─── Tab CRUD ─────────────────────────────────────────────────────────

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
        from modules.password import _session_encryption_keys_lock, _session_encryption_keys
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

    # ─── Password Management API Routes ───────────────────────────────────

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

    # ─── Menu Move / Paste ──────────────────────────────────────────────

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

    # ─── Backup API Routes ──────────────────────────────────────────────

    @app.route('/api/backup', methods=['POST'])
    def api_start_backup():
        token = request.headers.get('X-Auth-Token', '')
        user = get_session_user(token)
        if not user:
            abort(401, description='未登录')
        from modules.backup import start_backup_task
        task_id, total = start_backup_task(user)
        return jsonify({'task_id': task_id, 'total': total})

    @app.route('/api/backup/status/<task_id>')
    def api_backup_status(task_id):
        from modules.backup import get_backup_status
        task = get_backup_status(task_id)
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
    def api_download_backup(task_id):
        token = request.headers.get('X-Auth-Token', '') or request.args.get('token', '')
        user = get_session_user(token)
        if not user:
            abort(401, description='未登录')
        from modules.backup import get_backup_status
        task = get_backup_status(task_id)
        if not task or not task['done']:
            return jsonify({'error': '备份未就绪'}), 404
        if task['error']:
            return jsonify({'error': task['error']}), 500
        from modules.backup import _get_backup_dir
        filename = task['filename']
        if not filename:
            return jsonify({'error': '备份文件不存在'}), 404
        return send_from_directory(str(_get_backup_dir()), filename, as_attachment=True)

    # ─── Export API Routes ──────────────────────────────────────────────

    @app.route('/api/<tab>/export/pdf')
    def export_tab_pdf(tab):
        user = _get_export_user()
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

    @app.route('/api/<tab>/export/zip')
    def export_tab_zip(tab):
        user = _get_export_user()
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

    @app.route('/api/<tab>/export/pdf/<item_id>')
    def export_tree_item_pdf(tab, item_id):
        user = _get_export_user()
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

    @app.route('/api/<tab>/export/zip/<item_id>')
    def export_tree_item_zip(tab, item_id):
        user = _get_export_user()
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

    # ─── User Authentication API Routes ─────────────────────────────────────

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

    # ─── Tab Ownership API Routes ──────────────────────────────────────────

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

    # ─── Public Edit (Discussion Mode) API Routes ──────────────────────────

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

    # ─── User-Specific Tab Ordering ────────────────────────────────────────

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

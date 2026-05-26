#!/usr/bin/env python3
import os
import re
import json
import uuid
from pathlib import Path
from flask import Flask, jsonify, request, render_template, send_from_directory, abort
from werkzeug.utils import secure_filename

app = Flask(__name__)

BASE_DIR = Path(__file__).parent
MYBASE_DIR = BASE_DIR / 'mybase'
UPLOAD_DIR_NAME = 'images'

MYBASE_DIR.mkdir(exist_ok=True)


def get_tab_path(tab_name):
    tab_path = MYBASE_DIR / tab_name
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
    tabs = []
    if MYBASE_DIR.exists():
        for entry in sorted(MYBASE_DIR.iterdir()):
            if entry.is_dir() and not entry.name.startswith('.'):
                tabs.append(entry.name)
    return jsonify(tabs)


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

    menu = load_menu(tab)
    success = add_menu_item(menu, parent_id, new_item)
    if not success and parent_id is not None:
        return jsonify({'error': 'Parent item not found'}), 404

    save_menu(tab, menu)
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
        return jsonify({'error': 'Content is required'}), 400

    save_content(tab, item_id, data['content'])
    return jsonify({'success': True})


@app.route('/api/<tab>/upload', methods=['POST'])
def upload_image(tab):
    if not get_tab_path(tab):
        return jsonify({'error': 'Tab not found'}), 404
    if 'image' not in request.files:
        return jsonify({'error': 'No image file provided'}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    orig_filename = secure_filename(file.filename)
    if not orig_filename:
        orig_filename = f"img_{uuid.uuid4().hex[:8]}.png"

    name_part, ext_part = os.path.splitext(orig_filename) if '.' in orig_filename else (orig_filename, '.png')
    unique_name = f"{name_part}_{uuid.uuid4().hex[:4]}{ext_part}"

    upload_dir = get_upload_dir(tab)
    file_path = upload_dir / unique_name
    file.save(str(file_path))

    return jsonify({'url': f'/static/{tab}/images/{unique_name}'}), 201


@app.route('/static/<tab>/images/<filename>')
def serve_uploaded_image(tab, filename):
    tab_path = get_tab_path(tab)
    if not tab_path:
        abort(404)
    upload_dir = tab_path / UPLOAD_DIR_NAME
    return send_from_directory(str(upload_dir), filename)

if __name__ == '__main__':
    print("=" * 60)
    print("  Web Document Center Server")
    print("=" * 60)
    print(f"  MyBase directory: {MYBASE_DIR}")
    print(f"  Server URL: http://0.0.0.0:9999")
    print("=" * 60)
    app.run(host='0.0.0.0', port=9999, debug=False)

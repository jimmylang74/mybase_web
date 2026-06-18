import re
import json
import uuid
from pathlib import Path

from modules.config import mybase_dir, user_data_dir, UPLOAD_DIR_NAME, BASE_DIR, _is_valid_tab_dir, version, log_error
from modules.password import read_tab_text, write_tab_text, is_tab_encrypted, get_cached_encryption_key


def get_tab_path(tab_name):
    tab_path = mybase_dir / tab_name
    if tab_path.exists() and tab_path.is_dir():
        return tab_path
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
    if content_file.exists() or (content_file.with_suffix(content_file.suffix + '.enc')).exists():
        return content_file, 'html'

    from modules.menu import find_menu_item
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
        raw = read_tab_text(tab_name, str(content_file.relative_to(get_tab_path(tab_name))))
        if raw is None:
            return ''
        if ctype == 'qrich':
            return _extract_body_from_qrich(raw)
        return raw
    return ''


def tab_path_for_rel(tab_name):
    return get_tab_path(tab_name)


def _extract_body_from_qrich(html):
    body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL)
    if body_match:
        body = body_match.group(1)
        body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.DOTALL)
        body = re.sub(r'<nav[^>]*>.*?</nav>', '', body, flags=re.DOTALL)
        return body.strip()
    return html


def save_content(tab_name, item_id, content_html):
    tab_path = get_tab_path(tab_name)
    if not tab_path:
        return False
    rel_path = f"content/{item_id}.html"
    return write_tab_text(tab_name, rel_path, content_html)


def generate_standalone_html(tab_name):
    if is_tab_encrypted(tab_name) and get_cached_encryption_key(tab_name) is None:
        return None
    content_data = {}
    img_pattern = re.compile(r'/uploads/' + re.escape(tab_name) + r'/images/')
    tab_path = get_tab_path(tab_name)

    content_dir = get_content_dir(tab_name)
    if content_dir and content_dir.exists():
        for f in sorted(content_dir.glob('*.html')):
            html = read_tab_text(tab_name, f"content/{f.name}")
            if html is not None:
                html = img_pattern.sub('images/', html)
                content_data[f.stem] = html

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


def _update_image_urls_after_rename(tab_path, old_name, new_name):
    old_prefix = f'/uploads/{old_name}/'
    new_prefix = f'/uploads/{new_name}/'
    content_dir = tab_path / 'content'
    if content_dir.exists():
        for fpath in content_dir.glob('*.html'):
            try:
                original = fpath.read_text(encoding='utf-8')
                if old_prefix in original:
                    fpath.write_text(original.replace(old_prefix, new_prefix), encoding='utf-8')
            except Exception as e:
                log_error("_update_image_urls_after_rename", e, str(fpath))
    for fpath in tab_path.glob('*.qrich.html'):
        try:
            original = fpath.read_text(encoding='utf-8')
            if old_prefix in original:
                fpath.write_text(original.replace(old_prefix, new_prefix), encoding='utf-8')
        except Exception as e:
            log_error("_update_image_urls_after_rename", e, str(fpath))


def rename_tab_in_index_db(old_name, new_name):
    from modules.search import get_index_db_path
    db_path = get_index_db_path(old_name)
    if not db_path.exists():
        return
    import sqlite3
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
    from modules.config import common_db
    if not common_db.exists():
        return
    import sqlite3
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


def regenerate_index_html(tab_name, tab_path):
    index_html = generate_standalone_html(tab_name)
    if index_html is not None:
        with open(tab_path / 'index.html', 'w', encoding='utf-8') as f:
            f.write(index_html)

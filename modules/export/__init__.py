import os
import io
import re
import uuid
import json
import html.parser
import zipfile
import shutil
import tempfile
import base64
import time
from pathlib import Path
from datetime import datetime

from fpdf import FPDF

from modules.config import BASE_DIR, log_error, _single_user_mode
from modules.tab import get_tab_path, load_menu, load_content, save_content, get_content_dir
from modules.menu import find_menu_item
from modules.password import is_tab_encrypted, get_cached_encryption_key, read_tab_file, read_tab_text
from modules.auth import can_export_tab, get_session_user, get_tab_owner


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
            # Split by <table> boundaries so tables interleave correctly with text/images
            segments = re.split(
                r'(<table\b[^>]*>.*?</table>)',
                content_html,
                flags=re.DOTALL | re.IGNORECASE,
            )
            for segment in segments:
                segment = segment.strip()
                if not segment:
                    continue
                if re.match(r'<table\b', segment, re.IGNORECASE):
                    # ── Render HTML table via fpdf2 table() ──
                    cells, has_th = _parse_html_table(segment)
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
                else:
                    # ── Text + images + SVG diagrams ──
                    text_only = re.sub(r'<img[^>]+>', '', segment)
                    text_only = re.sub(r'<svg\b[^>]*>.*?</svg>', '', text_only, flags=re.DOTALL)
                    text = _html_to_pdf_text(text_only)
                    if text:
                        pdf.set_x(pdf.l_margin + indent + 4)
                        pdf.set_font('CJK', '', 9)
                        pdf.multi_cell(pdf.epw - indent - 4, 5, text)
                        pdf.ln(2)
                    for match in re.finditer(r'<img[^>]+src=[\'"]([^\'"]+)[\'"]', segment):
                        src = match.group(1)
                        img_data = _resolve_img_data(src)
                        if img_data:
                            # Cap image width at 90pt = 31.75mm (fpdf2 uses mm)
                            max_w = min(pdf.epw - indent - 20, 31.75)
                            if max_w > 20:
                                try:
                                    pdf.image(io.BytesIO(img_data), w=max_w)
                                    pdf.ln(3)
                                except Exception:
                                    pass
                    # SVG/Mermaid diagrams — use full available page width so
                    # text-heavy diagrams (esp. sequence diagrams) are readable
                    svg_max_w = pdf.epw - indent - 20
                    if svg_max_w > 20:
                        for svg_match in re.finditer(r'<svg\b[^>]*>.*?</svg>', segment, flags=re.DOTALL):
                            svg_str = svg_match.group(0)
                            png_src = re.search(r'data-png="(data:image/png;base64,[^"]*)"', svg_str)
                            if png_src:
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
        pdf_toc.multi_cell(pdf_toc.epw, 11, re.sub(r'<[^>]+>', '', title), align='C')
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
        pdf.multi_cell(pdf.epw, 11, re.sub(r'<[^>]+>', '', title), align='C')
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


# ─── Helper to check export permissions within route handlers ────────────

def _get_export_user():
    """Get user from request context for export endpoints."""
    if _single_user_mode:
        return {'username': 'admin', 'role': 'admin'}
    from flask import request
    token = request.headers.get('X-Auth-Token', '')
    return get_session_user(token)

import re
import time
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from modules.config import index_db_dir, mybase_dir, user_data_dir, workers_menu, _shutdown_requested, log_error, ocr_log, force_index_target, _is_valid_tab_dir, _run_in_background
from modules.tab import get_tab_path, load_menu, load_content
from modules.menu import find_menu_item
from modules.ocr import extract_text_from_html_images
from modules.password import is_tab_encrypted, get_cached_encryption_key


# ─── Search Index Engine (SQLite3) ─────────────────────────────────────────

def get_index_db_path(tab_name):
    return index_db_dir / f"{tab_name}.db"


def init_index_db(tab_name):
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

    results = []
    _lock = threading.Lock()
    _progress = [0]

    def _process(item_path):
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
        for item_path in flat:
            if _shutdown_requested.is_set():
                print("  Indexing interrupted.")
                raise KeyboardInterrupt()
            label = _process(item_path)
            if label is not None:
                _progress[0] += 1
                print(f"    [{_progress[0]}/{total}] {label[:40]}", flush=True)
    else:
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
    db_path = get_index_db_path(tab_name)
    if not db_path.exists():
        return []

    if use_regex:
        return _search_index_regex(tab_name, query, db_path)

    query = query.strip()

    if '|' in query:
        terms = [q.strip() for q in query.split('|') if q.strip()]
        if len(terms) > 1:
            return _search_index_multi(tab_name, terms, 'or', db_path)

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

    if '&&' in query:
        terms = [q.strip() for q in query.split('&&') if q.strip()]
    else:
        terms = query.split()

    if len(terms) > 1:
        return _search_index_multi(tab_name, terms, 'and', db_path)

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

            if not all(
                tl in label_lower or tl in content_lower
                for tl in include_lower
            ):
                continue

            if any(
                tl in label_lower or tl in content_lower
                for tl in exclude_lower
            ):
                continue

            if row[0] in seen_ids:
                continue
            seen_ids.add(row[0])

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
            else:
                if not all(
                    tl in label_lower or tl in content_lower
                    for tl in terms_lower
                ):
                    continue
                matched_term = terms[0]

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
    if is_tab_encrypted(tab_name) and get_cached_encryption_key(tab_name, _get_current_sid_from_compat()) is None:
        return False
    return True


def _get_current_sid_from_compat():
    from modules.compat import _get_current_sid
    return _get_current_sid()


def search_all_tabs(query, use_regex=False):
    results = []
    if index_db_dir.exists():
        for db_file in sorted(index_db_dir.glob("*.db")):
            tab_name = db_file.stem
            if not _tab_searchable(tab_name):
                continue
            results.extend(search_index(tab_name, query, use_regex=use_regex))
    return results


def update_item_in_index(tab_name, item_id):
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
    if get_tab_path(tab_name):
        index_tab(tab_name)


def delete_tab_index(tab_name):
    db_path = get_index_db_path(tab_name)
    if db_path.exists():
        db_path.unlink()


def _index_db_has_rows(tab_name):
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
    from modules.database import add_tab_to_order, init_tab_visibility
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

    for tab in sorted(tabs):
        add_tab_to_order(tab)
        init_tab_visibility(tab)

    indexed = {db.stem for db in index_db_dir.glob("*.db")}

    global force_index_target

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

    for tab in sorted(tabs):
        if tab in indexed and tab not in skip_auto:
            if not _index_db_has_rows(tab):
                menu = load_menu(tab)
                if menu:
                    print(f"  Rebuilding stale empty index for tab: {tab}")
                    try:
                        index_tab(tab)
                    except Exception as e:
                        log_error("ensure_indexes", e, f"rebuilding index for {tab}")

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

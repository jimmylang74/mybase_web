import sqlite3
from modules.config import common_db


# ─── Common Database (tab_order, general config) ───────────────────────────

def init_common_db():
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_order (
                tab_name TEXT PRIMARY KEY,
                sort_order INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_kb_visibility (
                tab_name TEXT PRIMARY KEY,
                visible INTEGER NOT NULL DEFAULT 1,
                is_active INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_current_item (
                tab_name TEXT PRIMARY KEY,
                current_item_id TEXT NOT NULL,
                scroll_top INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS font_config (
                id INTEGER PRIMARY KEY DEFAULT 1,
                font_family TEXT NOT NULL DEFAULT 'Arial',
                font_size TEXT NOT NULL DEFAULT '5',
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            INSERT OR IGNORE INTO font_config (id, font_family, font_size)
            VALUES (1, 'Arial', '5')
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS system_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            INSERT OR IGNORE INTO system_config (name, value)
            VALUES ('version', 'v4.5.4')
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_owner (
                tab_name TEXT PRIMARY KEY,
                owner TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_tab_visibility (
                username TEXT NOT NULL,
                tab_name TEXT NOT NULL,
                visible INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (username, tab_name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_tab_current_item (
                username TEXT NOT NULL,
                tab_name TEXT NOT NULL,
                current_item_id TEXT NOT NULL DEFAULT '',
                scroll_top INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (username, tab_name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tab_public_edit (
                tab_name TEXT PRIMARY KEY,
                public_edit INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.commit()
    finally:
        conn.close()
    from modules.password import _init_password_tables
    _init_password_tables()
    from modules.auth import _init_user_tables
    _init_user_tables()


def get_tab_order():
    if not common_db.exists():
        return []
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_order ORDER BY sort_order ASC")
        return [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()


def set_tab_order(tab_names):
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_order")
        for i, name in enumerate(tab_names):
            conn.execute(
                "INSERT INTO tab_order (tab_name, sort_order) VALUES (?, ?)",
                (name, i)
            )
        conn.commit()
    finally:
        conn.close()


def add_tab_to_order(tab_name):
    names = get_tab_order()
    if tab_name not in names:
        names.append(tab_name)
        set_tab_order(names)


def remove_tab_from_order(tab_name):
    names = get_tab_order()
    if tab_name in names:
        names.remove(tab_name)
        set_tab_order(names)


# ─── Tab Knowledge Base Visibility ─────────────────────────────────────────

def init_tab_visibility(tab_name):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR IGNORE INTO tab_kb_visibility (tab_name, visible, is_active) VALUES (?, 1, 0)",
            (tab_name,)
        )
        conn.commit()
    finally:
        conn.close()


def get_tab_visibility():
    if not common_db.exists():
        return {}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, visible FROM tab_kb_visibility")
        return {row[0]: bool(row[1]) for row in cursor.fetchall()}
    finally:
        conn.close()


def set_tab_visibility(tab_name, visible):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO tab_kb_visibility (tab_name, visible, is_active) "
            "VALUES (?, ?, COALESCE((SELECT is_active FROM tab_kb_visibility WHERE tab_name = ?), 0))",
            (tab_name, 1 if visible else 0, tab_name)
        )
        conn.commit()
    finally:
        conn.close()


def set_tab_visibility_batch(visibility_dict):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_kb_visibility WHERE is_active = 1")
        row = cursor.fetchone()
        selected_tab = row[0] if row else None

        conn.execute("DELETE FROM tab_kb_visibility")
        for name, visible in visibility_dict.items():
            is_active = 1 if name == selected_tab else 0
            conn.execute(
                "INSERT INTO tab_kb_visibility (tab_name, visible, is_active) VALUES (?, ?, ?)",
                (name, 1 if visible else 0, is_active)
            )
        conn.commit()
    finally:
        conn.close()


def get_user_tab_visibility(username: str) -> dict:
    if not common_db.exists():
        return {}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT tab_name, visible FROM user_tab_visibility WHERE username = ?",
            (username,)
        )
        return {row[0]: bool(row[1]) for row in cursor.fetchall()}
    finally:
        conn.close()


def set_user_tab_visibility_batch(username: str, visibility_dict: dict):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        for name, visible in visibility_dict.items():
            from modules.auth import get_tab_owner
            owner = get_tab_owner(name)
            if owner == username:
                cursor = conn.execute(
                    "SELECT sort_order, is_active FROM user_tab_visibility WHERE username = ? AND tab_name = ?",
                    (username, name)
                )
                row = cursor.fetchone()
                sort_order = row[0] if row else 0
                is_active = row[1] if row else 0
                conn.execute(
                    "INSERT OR REPLACE INTO user_tab_visibility "
                    "(username, tab_name, visible, sort_order, is_active) VALUES (?, ?, ?, ?, ?)",
                    (username, name, 1 if visible else 0, sort_order, is_active)
                )
        conn.commit()
    finally:
        conn.close()


def delete_tab_visibility(tab_name):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_kb_visibility WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()


def get_selected_tab():
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name FROM tab_kb_visibility WHERE is_active = 1")
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def set_selected_tab(tab_name):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("UPDATE tab_kb_visibility SET is_active = 0")
        conn.execute("UPDATE tab_kb_visibility SET is_active = 1 WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()


def set_user_selected_tab(username: str, tab_name: str):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("UPDATE user_tab_visibility SET is_active = 0 WHERE username = ?", (username,))
        cursor = conn.execute(
            "UPDATE user_tab_visibility SET is_active = 1 WHERE username = ? AND tab_name = ?",
            (username, tab_name)
        )
        if cursor.rowcount == 0:
            conn.execute(
                "INSERT INTO user_tab_visibility (username, tab_name, visible, sort_order, is_active) VALUES (?, ?, 1, 0, 1)",
                (username, tab_name)
            )
        conn.commit()
    finally:
        conn.close()


def get_user_selected_tab(username: str):
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT tab_name FROM user_tab_visibility WHERE username = ? AND is_active = 1",
            (username,)
        )
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


# ─── Tab Current Item (reading position) ────────────────────────────────────

def get_tab_current_items():
    if not common_db.exists():
        return {}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute("SELECT tab_name, current_item_id FROM tab_current_item")
        return {row[0]: row[1] for row in cursor.fetchall()}
    finally:
        conn.close()


def set_tab_current_item(tab_name, item_id):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO tab_current_item (tab_name, current_item_id) VALUES (?, ?)",
            (tab_name, item_id)
        )
        conn.commit()
    finally:
        conn.close()


def delete_tab_current_item(tab_name):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute("DELETE FROM tab_current_item WHERE tab_name = ?", (tab_name,))
        conn.commit()
    finally:
        conn.close()


# ─── Font Config ───────────────────────────────────────────────────────────

def get_font_config():
    if not common_db.exists():
        return {'font_family': 'Arial', 'font_size': '5'}
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT font_family, font_size FROM font_config WHERE id = 1"
        )
        row = cursor.fetchone()
        if row:
            return {
                'font_family': row[0],
                'font_size': row[1],
            }
        return {'font_family': 'Arial', 'font_size': '5'}
    finally:
        conn.close()


def set_font_config(font_family, font_size):
    if not common_db.exists():
        return
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO font_config (id, font_family, font_size, updated_at) "
            "VALUES (1, ?, ?, datetime('now', 'localtime'))",
            (font_family, font_size)
        )
        conn.commit()
    finally:
        conn.close()


def get_system_config(name):
    if not common_db.exists():
        return None
    conn = sqlite3.connect(str(common_db))
    try:
        cursor = conn.execute(
            "SELECT value FROM system_config WHERE name = ?", (name,)
        )
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def set_system_config(name, value):
    conn = sqlite3.connect(str(common_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO system_config (name, value) VALUES (?, ?)",
            (name, value)
        )
        conn.commit()
    finally:
        conn.close()

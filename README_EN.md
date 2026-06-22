# KBase v6.9.10

**Web of Mybase Knowledge Server** — A Chinese knowledge base management system built with Flask + PaddleOCR.

Designed for personal, team, and family knowledge management. It provides a convenient tool for accumulating experience, and is a great companion for PM project management and team collaboration.

Supports multi-KB tabs, tree menu organization, rich text editing, image OCR text recognition, full-text search, and one-click backup.

## Features

### v6.x (In Progress)
- **Export menu items as PPT** — Configure a backend AI PPT agent; menu items are sent to the agent which summarizes them into a PPT (In progress)
- **Excel tables Copy to HTML** — Copy from excel and paste into HTML
- **In picture words copy** — Copy words from in a picture (by using tesseract.js)
- ""Mermaid Diagram support"" — Add Mermaid Diagram support (by using mermaid.js)


### v5.x
- **Improved color picker** — Now includes common colors and transparent color
- **Improved "Move to..." dialog** — The target tree can now be searched directly
- **Mobile screen adaptation** — Simple mobile layout; sidebar can be hidden
- **Multi-user management** — Supports multiple users; admin can publish announcement-style KBs
  - Admin default password: 1234 (can create / delete users in settings)
  - Admin-created KBs are public (visible to all users, editable by none)
  - Admin can assign an owner to any KB
  - User-created KBs are owned by the user; users only see their own KBs and admin's public KBs
  - Users can only export their own KBs, not admin's KBs
  - Admin edits are synced to all logged-in users in real-time via WebSocket (bulletin-style)
  - Deleting a user reassigns all their KBs to admin and immediately logs out the deleted user
  - Admin/users can password-protect their own KBs (password required to view/edit)
- **Team discuss Tab** - Now admin can set a tab as discuss tab, all members of KB system can login and edit on it, everyone can see it at once
- **Menu Item Copy/Paste** - Menu item and its all children can be copied to another Tab
- **Single user mode** - Run in single user mode by setting command line parameter

### v4.x
- **Text background color** — Content area text can now have background colors
- **Search highlighting** — Searched text is highlighted in the content area (image text not yet supported)
- **Cython build support** — `make build` / `make package` for commercial distribution
- **Table support** — Insert tables in the editor; columns can be resized; cell formulas and formatting supported
- **Image and table scaling** — Drag to resize images and tables

### v3.x
- **Menu item PDF/ZIP export** — KB-level and menu-item-level PDF and ZIP export, standalone HTML ZIP output
- **Settings** — Language support (Chinese / English)
- **WebSocket real-time collaboration** — Built on flask-socketio: multi-window sync, document locking, encrypted-KB sync denial
- **KB encryption** — AES-256-GCM file encryption + BCrypt password hashing + PBKDF2 key derivation; per-KB, session-based unlock
- **Mobile OCR** — Lighter mobile OCR model with lower memory usage and faster inference

### v2.x
- **Custom tree menu styles** — Foreground/background colors, emoji icons, etc.
- **Regex search** — Standard regex syntax in search
- **Backup KB** — Package the entire application, docs, libraries, and KB together for easy migration

### v1.x
- 📚 **Multi-KB management** — Create independent KB tabs, drag-to-reorder, independent indexing
- 🌳 **Tree menu** — Nested menus with drag-to-move, inline rename, custom styles
- ✏️ **Rich text editor** — WYSIWYG with font/color/size/bold/italic/link support
- 🔍 **Full-text search** — SQLite-backed; per-KB and global; regex, OR (`|`), AND (space / `&&`), and exclusion (`^`) syntax
- 🖼️ **OCR image text recognition** — PaddleOCR-based; auto-extracts image text into the index
- 📦 **One-click backup** — ZIP package of all KB data for download
- 🌐 **Standalone export** — Each KB can generate a self-contained single-page HTML
- **Ubuntu & Windows support** — Support Ubuntu/Windows os deployment

## Installation

### Requirements

- Python >= 3.10
- OS: Windows / Linux / macOS
- Key dependencies: flask-socketio>=5.3.0, fpdf2>=2.8.0, bcrypt>=4.0.0, pycryptodome>=3.20.0

### Steps

```bash
# 1. Clone or download the project
cd web-of-mybase

# 2. (Recommended) Create a virtual environment
python -m venv venv
source venv/bin/activate    # Linux / macOS
venv\Scripts\activate       # Windows

# 3. Install dependencies
# On Windows: if Python is not installed, install python-3.10.11-amd64.exe first
pip install -r requirements.txt
```

> **GPU acceleration (optional)**: To use GPU-accelerated OCR, uninstall the CPU version and install the GPU version:
> ```bash
> pip uninstall paddlepaddle -y
> pip install paddlepaddle-gpu
> ```

## Quick Start

```bash
# Default startup (port 9999)
python server.py
```

Open http://localhost:9999 in your browser.

## Command-Line Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--port PORT` | 9999 | Server port |
| `--data DIR` | data | Data root directory |
| `--force-index [NAME]` | — | Force rebuild index (specific KB or all) |
| `--disable-ocr` | — | Disable OCR |
| `--mobile-ocr` | true | Use lightweight Mobile OCR model (lower accuracy, less memory). Enabled by default on Windows |
| `--workers-ocr N` | 8 | OCR worker processes |
| `--workers-menu N` | 8 | Menu item indexing workers |
| `--no-debug` | — | Disable debug logging |

### Usage Examples

```bash
# Custom port and data directory
python server.py --port 8080 --data /path/to/data

# Force rebuild all indexes on startup
python server.py --force-index

# Rebuild specific KB index + disable OCR
python server.py --force-index my_kb --disable-ocr

# Low-resource environment
python server.py --workers-ocr 2 --workers-menu 2
```

## Directory Structure

```
├── server.py              # Main server program
├── main.py                # Cython loader
├── setup.py               # Cython build script
├── Makefile               # Build / clean / package scripts
├── requirements.txt       # Python dependencies
├── pdf_fonts/             # PDF export font directory
├── web/
│   ├── templates/         # HTML templates
│   │   ├── index.html     # Main interface
│   │   └── help.html      # Help documentation
│   └── static/
│       ├── app.js         # Frontend logic
│       └── style.css      # Stylesheet
├── data/
│   ├── mybase/            # Admin-owned KB data
│   │   └── <kb_name>/
│   │       ├── menu.json  # Menu structure
│   │       ├── menu.js    # Frontend menu data
│   │       ├── index.html # Standalone export page
│   │       ├── content/   # Entry content files
│   │       └── images/    # Uploaded images
│   └── user/
│       └── <username>/    # A user's KB data
│           └── <kb_name>/
│               ├── menu.json
│               ├── menu.js
│               ├── index.html
│               ├── content/
│               └── images/
│   └── db/
│       ├── common.db      # General config database
│       └── index_db/      # Search index databases
├── models/
│   └── ocr/               # Pre-downloaded PaddleOCR models (Server & Mobile)
└── mybase.log             # Runtime log
```

## User Guide

### Basic Operations

1. **Create a KB** — Click the "New KB" button on the toolbar
2. **Add menu items** — Right-click in the sidebar and choose "Add Root Menu" or "Add Child Menu"
3. **Edit content** — Click a menu item and edit in the rich text editor on the right
4. **Save** — `Ctrl + S` or click the "💾 Save" button
5. **Search** — Type keywords in the search box; supports global search, regex search, and smart syntax: OR (`|`), AND (space / `&&`), exclusion (`^`)

### Keyboard Shortcuts

| Shortcut | Function |
|----------|----------|
| `Ctrl + S` | Save current content |
| `Esc` | Close popup menu / dialog |
| Double-click menu item | Inline rename |

### Data Backup

Click the "📦 Backup KB" button to package all KB data into a ZIP file for download.

## Index System

- Server automatically detects and indexes new KBs on startup
- Incremental index update on content save
- OCR image text extraction included in index
- Manual force rebuild via `--force-index`

## OCR Notes

- OCR is enabled by default; uses PaddleOCR to recognize text in images
- Runs in a separate process pool — does not affect server responsiveness
- Use `--disable-ocr` to disable and save resources
- OCR models (~100MB) are downloaded automatically on first use

## FAQ

**Q: Error `ModuleNotFoundError: No module named 'paddle'` on startup**  
A: Install paddlepaddle: `pip install paddlepaddle`

**Q: OCR is slow**  
A: The first model load under CPU mode is normal. Adjust `--workers-ocr` to tune concurrency.

**Q: How do I change the port?**  
A: Use `--port`: `python server.py --port 8080`

**Q: How do I migrate data?**  
A: Copy the entire `data/` directory and use `--data` to point to the new path.

## License

MIT

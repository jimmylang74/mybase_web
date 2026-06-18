#!/usr/bin/env python3
"""Web of Mybase Knowledge Server — Shim that delegates to modules/main.py.

Original monolithic code is preserved in server.py.orig.
"""
import sys
import os

# Ensure the project root is on sys.path so `python server.py` works from anywhere
_root = os.path.dirname(os.path.abspath(__file__))
if _root not in sys.path:
    sys.path.insert(0, _root)

from modules.main import main

if __name__ == '__main__':
    main()

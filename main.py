#!/usr/bin/env python3
"""Thin loader — imports the compiled Cython module and delegates to it.

All business logic, CLI argument parsing, and server code lives in the
compiled ``server`` extension (``server.so`` on Linux/macOS,
``server.pyd`` on Windows).

This file is intentionally kept minimal so the compiled module is the
real executable.
"""
import sys
import os

# Ensure the directory containing the compiled .so/.pyd is on sys.path.
# This allows ``python main.py`` to work from any directory.
_basedir = os.path.dirname(os.path.abspath(__file__))
if _basedir not in sys.path:
    sys.path.insert(0, _basedir)

import server  # type: ignore[import-untyped]   # compiled Cython module

if __name__ == "__main__":
    server.main()

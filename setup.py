#!/usr/bin/env python3
"""Cython build script for server.py → .so/.pyd.

Usage:
    python setup.py build_ext --inplace
"""
import sys
from setuptools import setup, Extension
from Cython.Build import cythonize

# Platform-specific extension suffix is handled automatically by setuptools:
#   Linux/macOS → *.so    Windows → *.pyd
ext_modules = cythonize(
    [
        Extension(
            "server",
            ["server.py"],
            # bundle Cython runtime inside the extension for standalone use
            define_macros=[("CYTHON_CSTRING", "1")],
        )
    ],
    language_level=3,
    compiler_directives={
        "binding": False,
        "boundscheck": False,
        "wraparound": False,
        "initializedcheck": False,
        "cdivision": True,
    },
)

setup(
    name="mybase-server",
    version="3.5.1",
    description="Web of Mybase Knowledge Server (Cython compiled)",
    ext_modules=ext_modules,
    zip_safe=False,
)

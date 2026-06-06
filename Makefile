#!/usr/bin/env make
# ===========================================================================
# Makefile — Cython compile server.py → .so/.pyd + package into deployable ZIP
#
# Targets:
#   all          — build the Cython extension (default)
#   build        — alias for `all`
#   clean        — remove all build artefacts
#   package      — build + produce a platform-specific deployable ZIP
#   package-win  — build + produce a Windows-specific deployable ZIP
# ===========================================================================

SHELL := /bin/bash
.PHONY: all build clean package package-win

# ---- config ---------------------------------------------------------------
PROJECT   := mybase-server
VERSION   := $(shell grep "^version" server.py 2>/dev/null | head -1 | sed "s/.*= *'//; s/'.*//" || echo "3.5.1")
PYTHON    ?= python3

# Detect OS
UNAME_S := $(shell uname -s 2>/dev/null || echo "Windows")
ifeq ($(findstring MINGW,$(UNAME_S))$(findstring MSYS,$(UNAME_S))$(findstring CYGWIN,$(UNAME_S)),)
  ifeq ($(UNAME_S),Windows)
    IS_WINDOWS := 1
  else
    IS_WINDOWS := 0
  endif
else
  IS_WINDOWS := 1
endif

# Extension name — setuptools produces platform-specific tagged files
# e.g. server.cpython-310-x86_64-linux-gnu.so or server.cpython-310-win_amd64.pyd
# We locate it by glob after build.
ifeq ($(IS_WINDOWS),1)
  EXT_PATTERN := server.*.pyd
  ZIP_OS      := win
else
  EXT_PATTERN := server.*.so
  ZIP_OS      := $(shell uname -s | tr '[:upper:]' '[:lower:]')
endif

ZIP_NAME  := $(PROJECT)-$(VERSION)-$(ZIP_OS).zip

# ---- targets --------------------------------------------------------------

all: build

build:
	@echo "==> Cython-compiling server.py ..."
	$(PYTHON) -c "import Cython; print('Cython', Cython.__version__)"
	$(PYTHON) setup.py build_ext --inplace
	@echo ""
	@echo "==> Built extension(s):"
	@ls -lh server.*.so server.*.pyd 2>/dev/null || echo "     (none found)"

clean:
	@echo "==> Cleaning build artefacts ..."
	rm -rf build/ __pycache__/
	rm -f server.c server.*.so server.*.pyd
	rm -f server.html  # Cython annotation output, if any
	rm -f *.zip
	@echo "     done."

# ---------------------------------------------------------------------------
# Package — build + collect everything into a deployable ZIP
# ---------------------------------------------------------------------------
package: build
	@echo "==> Creating $(ZIP_NAME) ..."
	@export TMPDIR=$$(mktemp -d /tmp/$(PROJECT)-pkg-XXXXXX); \
	 DEST="$$TMPDIR/$(PROJECT)"; \
	 mkdir -p "$$DEST"; \
	 cp main.py "$$DEST/"; \
	 cp requirements.txt "$$DEST/"; \
	 cp README.md "$$DEST/"; \
	 echo "  + main.py"; \
	 echo "  + requirements.txt"; \
	 echo "  + README.md"; \
	 SO_FILE=$$(ls server.*.so 2>/dev/null | head -1); \
	 PYD_FILE=$$(ls server.*.pyd 2>/dev/null | head -1); \
	 if [ -n "$$SO_FILE" ]; then \
	   cp "$$SO_FILE" "$$DEST/"; \
	   echo "  + $$SO_FILE"; \
	 fi; \
	 if [ -n "$$PYD_FILE" ]; then \
	   cp "$$PYD_FILE" "$$DEST/"; \
	   echo "  + $$PYD_FILE"; \
	 fi; \
	 if [ -d doc ]; then cp -r doc "$$DEST/"; echo "  + doc/"; fi; \
	 if [ -d web ]; then cp -r web "$$DEST/"; echo "  + web/"; fi; \
	 if [ -d models ]; then cp -r models "$$DEST/"; echo "  + models/"; fi; \
	 if [ -d pdf_fonts ]; then cp -r pdf_fonts "$$DEST/"; echo "  + pdf_fonts/"; fi; \
	 $(PYTHON) -c "import shutil,zipfile,os; src='$$TMPDIR/$(PROJECT)'; dst='$(CURDIR)/$(ZIP_NAME)'; zf=zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED); [zf.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),'$$TMPDIR')) for r,_,fs in os.walk(src) for f in fs]; zf.close()"; \
	 echo "==> Package created: $(ZIP_NAME)"; \
	 SZ=$$(python3 -c "import os; print(round(os.path.getsize('$(CURDIR)/$(ZIP_NAME)')/1024/1024,1))" 2>/dev/null || echo "?"); \
	 echo "    Size: $${SZ} MB"; \
	 rm -rf "$$TMPDIR"

# -- Windows-specific packaging (explicit .pyd in the ZIP) ------------------
package-win: build
	$(MAKE) package  # same target handles both .so and .pyd automatically

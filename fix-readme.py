#!/usr/bin/env python3
"""fix-readme.py — Update version in README.md and README_EN.md from VERSION.

Usage:
    python fix-readme.py          # update both README files in-place
    python fix-readme.py --check  # check if READMEs match VERSION, exit 1 if not
"""

import sys
from pathlib import Path


HERE = Path(__file__).parent
VERSION_FILE = HERE / 'VERSION'
README = HERE / 'README.md'
README_EN = HERE / 'README_EN.md'

# Maps (filename, lang) → format string that must contain exactly one {ver} placeholder
SPECS = {
    'README.md':    '# 知识库 KBase {ver}\n',
    'README_EN.md': '# KBase {ver}\n',
}


def read_version() -> str:
    try:
        return VERSION_FILE.read_text().strip()
    except Exception as e:
        print(f'ERROR: cannot read {VERSION_FILE}: {e}', file=sys.stderr)
        sys.exit(1)


def expected_line(filename: str, version: str) -> str:
    fmt = SPECS.get(filename)
    if fmt is None:
        print(f'ERROR: unknown file {filename}', file=sys.stderr)
        sys.exit(1)
    return fmt.format(ver=version)


def check_file(filename: str, version: str) -> bool:
    path = HERE / filename
    try:
        first = path.read_text().splitlines()[0] + '\n' if path.exists() else ''
    except Exception:
        first = ''
    expected = expected_line(filename, version)
    if first == expected:
        return True
    print(f'MISMATCH: {filename}')
    print(f'  expected: {expected!r}')
    print(f'  actual:   {first!r}')
    return False


def fix_file(filename: str, version: str) -> bool:
    path = HERE / filename
    if not path.exists():
        print(f'SKIP: {filename} not found')
        return False
    lines = path.read_text().splitlines(keepends=True)
    if not lines:
        lines = ['']
    expected = expected_line(filename, version)
    if lines[0] == expected:
        return False
    old = lines[0]
    lines[0] = expected
    path.write_text(''.join(lines))
    print(f'UPDATED: {filename}')
    print(f'  old: {old!r}')
    print(f'  new: {expected!r}')
    return True


def main():
    version = read_version()

    if '--check' in sys.argv:
        ok = all(check_file(fn, version) for fn in SPECS)
        sys.exit(0 if ok else 1)

    any_changed = False
    for fn in SPECS:
        if fix_file(fn, version):
            any_changed = True
    if not any_changed:
        print('All README files already up-to-date.')
    sys.exit(0)


if __name__ == '__main__':
    main()

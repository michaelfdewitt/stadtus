#!/usr/bin/env python3
"""Turn a directory tree into a city: one building per file.

    python3 adapters/filesystem.py <dir> -o data/files.json [--max 5000] [--hidden]

Height = file size (log scale), color = extension, spire = days since modified.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import stadtus  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root")
    ap.add_argument("-o", "--out", default="data/files.json")
    ap.add_argument("--max", type=int, default=5000, help="stop after this many files")
    ap.add_argument("--hidden", action="store_true", help="include dot-files and dot-directories")
    a = ap.parse_args()

    root = os.path.abspath(a.root)
    now = time.time()
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        if not a.hidden:
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            filenames = [f for f in filenames if not f.startswith(".")]
        dirnames.sort()
        rel = os.path.relpath(dirpath, root)
        path = [] if rel == "." else rel.split(os.sep)
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            ext = os.path.splitext(fn)[1].lstrip(".").lower() or "(none)"
            items.append({
                "name": fn,
                "path": path,
                "size": st.st_size,
                "ext": ext,
                "modified": time.strftime("%Y-%m-%d", time.localtime(st.st_mtime)),
                "age_days": int((now - st.st_mtime) / 86400),
                "depth": len(path),
            })
            if len(items) >= a.max:
                break
        if len(items) >= a.max:
            print(f"stopped at --max {a.max} files", file=sys.stderr)
            break

    doc = stadtus.city(
        os.path.basename(root) or root, items,
        fields={
            "size": {"type": "number", "label": "size", "unit": "B", "scale": "log"},
            "ext": {"type": "category", "label": "extension"},
            "modified": {"type": "date"},
            "age_days": {"type": "number", "label": "age (days)"},
            "depth": {"type": "number"},
        },
        defaults={"height": "size", "color": "ext", "spire": "age_days"},
    )
    stadtus.write(doc, a.out)


if __name__ == "__main__":
    main()

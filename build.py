#!/usr/bin/env python3
"""Bundle index.html + src/ into a single self-contained dist/stadtus.html.

The result works when opened directly from disk (file://) and needs no server;
Three.js is still fetched from the CDN. Run:  python3 build.py
"""
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
ORDER = ["palette", "model", "layout", "renderer", "ui", "main"]  # dependency order


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def strip_module(src):
    """Remove local imports/exports; collect 'three' imports to hoist."""
    externals = []
    out = []
    for line in src.splitlines():
        m = re.match(r"\s*import\s.*\sfrom\s+'(\.[^']*)';?\s*$", line)
        if m:
            continue  # local import: everything is in one scope now
        m = re.match(r"\s*import\s.*\sfrom\s+'(three[^']*)';?\s*$", line)
        if m:
            externals.append(line.strip())
            continue
        if re.match(r"\s*export\s*\{[^}]*\};?\s*$", line):
            continue  # re-export list
        out.append(re.sub(r"^(\s*)export\s+(?=(const|let|function|class)\b)", r"\1", line))
    return externals, "\n".join(out)


def main():
    externals, parts = [], []
    for name in ORDER:
        ext, body = strip_module(read(f"src/{name}.js"))
        externals += ext
        parts.append(f"// ---- src/{name}.js ----\n{body}")
    bundle = "\n".join(dict.fromkeys(externals)) + "\n\n" + "\n\n".join(parts)
    html = read("index.html")
    html = html.replace('<link rel="stylesheet" href="src/style.css">', "<style>\n" + read("src/style.css") + "</style>")
    html = html.replace('<script type="module" src="src/main.js"></script>', "<script type=\"module\">\n" + bundle + "\n</script>")
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", "stadtus.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()

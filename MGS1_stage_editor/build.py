#!/usr/bin/env python3
"""
Bundle the split source files back into a single self-contained HTML.

Usage: python build.py [output.html]
  Default output: MGS_Stage_Editor_PSX_30_.html

Reads:
  styles.css
  vendor/head_init.js
  vendor/three.min.js
  vendor/jszip.min.js
  src/*.js  (in the order specified in index.html)
"""
import os, re, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'MGS_Stage_Editor_PSX_30_.html'
HERE = os.path.dirname(os.path.abspath(__file__))

def read(*parts):
    return open(os.path.join(HERE, *parts), 'r', encoding='utf-8').read()

# Get the script load order from index.html
index = read('index.html')
script_srcs = re.findall(r'<script src="([^"]+)"></script>', index)
print(f"Found {len(script_srcs)} scripts to bundle")

css = read('styles.css').strip()

# Parse head and body from index.html
head_match = re.search(r'<head>(.*?)</head>', index, re.DOTALL)
head_inner = head_match.group(1)
# Strip out the link to styles.css since we're inlining
head_inner = re.sub(r'<link rel="stylesheet"[^>]*>', '', head_inner).strip()

body_match = re.search(r'<body[^>]*>(.*?)</body>', index, re.DOTALL)
body_inner = body_match.group(1)
# Strip out the script tags since we'll inline them
body_inner = re.sub(r'<script src="[^"]+"></script>\s*', '', body_inner).strip()

# Build the inlined HTML
parts = ['<!DOCTYPE html>', '<html lang="en">', '<head>',
         head_inner,
         f'<style>{css}</style>',
         '</head>', '<body>',
         body_inner]
for src in script_srcs:
    parts.append(f'<script>{read(src)}</script>')
parts.extend(['</body>', '</html>', ''])

html = '\n'.join(parts)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(html)
print(f"Wrote {OUT} ({len(html):,} bytes)")

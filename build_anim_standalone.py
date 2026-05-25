#!/usr/bin/env python3
"""
Build a standalone Animation Swapper — single HTML file, no stage editor,
no sound editor, no GCL tools. Just the animation swap/edit/splice/crossfade
feature isolated from the rest of the suite.

Usage:
    python build_anim_standalone.py

Expects the following files in the SAME directory as this script:
    17_anim_tools.js  — the animation swapper source (v4: bone remapper
                        removed, AT_compactArchive present which strips
                        orphaned bytes from prior swap operations on
                        export)
    three.min.js      — Three.js r140 (623,549 bytes)
    bootstrap.js      — Standalone bootstrap (1,000 bytes)

Output:
    MGS_Animation_Swapper_Standalone.html (~770 KB) — ready to upload
    to GitHub or share. Open directly in any modern browser.
"""
import os
import sys

# All asset files live alongside this script
HERE = os.path.dirname(os.path.abspath(__file__))
SRC        = os.path.join(HERE, "17_anim_tools.js")
THREE_JS   = os.path.join(HERE, "three.min.js")
BOOTSTRAP  = os.path.join(HERE, "bootstrap.js")
OUT_HTML   = os.path.join(HERE, "MGS_Animation_Swapper_Standalone.html")

# Minimal CSS — only what the anim swapper actually needs.
# Includes a splash screen shown while Three.js + the swapper JS load.
CSS = """*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0a0e14;color:#aabbcc;font-family:monospace;font-size:11px;overflow:hidden}
.btn{background:#111827;color:#aabbcc;border:1px solid #1a2535;padding:1px 6px;font-size:10px;font-family:monospace;cursor:pointer;border-radius:2px;line-height:16px;white-space:nowrap}
.btn:hover{background:#1a2535;border-color:#334455}
.btn.active{background:#1a3a55;border-color:#0088cc;color:#00ccff}
.btn:disabled{opacity:0.4;cursor:default}
input[type=number]::-webkit-inner-spin-button{opacity:0.5}
input[type=range]{accent-color:#0088cc;vertical-align:middle}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0a0e14}
::-webkit-scrollbar-thumb{background:#1a2535;border-radius:3px}
/* Splash screen shown briefly while Three.js + the swapper JS load */
#splash{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#7cf;font-family:system-ui,sans-serif;background:#0a0e14;z-index:1}
#splash h1{font-size:18px;font-weight:bold}
#splash p{color:#666;font-size:11px}"""


def build():
    print("Building standalone Animation Swapper HTML")
    print("=" * 50)

    # Check assets
    for path, label in [(SRC, "17_anim_tools.js"),
                        (THREE_JS, "three.min.js"),
                        (BOOTSTRAP, "bootstrap.js")]:
        if not os.path.exists(path):
            print(f"  MISSING: {label} (expected at {path})")
            sys.exit(1)

    anim_js   = open(SRC).read()
    three_js  = open(THREE_JS).read()
    bootstrap = open(BOOTSTRAP).read()

    print(f"  17_anim_tools.js: {len(anim_js):,} bytes")
    print(f"  three.min.js:     {len(three_js):,} bytes")
    print(f"  bootstrap.js:     {len(bootstrap):,} bytes")

    html = (
        '<!DOCTYPE html>\n'
        '<html lang="en">\n'
        '<head>\n'
        '<meta charset="UTF-8">\n'
        '<title>MGS1 Animation Swapper</title>\n'
        f'<style>{CSS}</style>\n'
        '</head>\n'
        '<body>\n'
        '<div id="splash"><h1>🎬 MGS1 Animation Swapper</h1><p>Loading…</p></div>\n'
        f'<script>{three_js}</script>\n'
        f'<script>{anim_js}</script>\n'
        f'<script>{bootstrap}</script>\n'
        '</body>\n'
        '</html>\n'
    )

    with open(OUT_HTML, "w") as f:
        f.write(html)

    print()
    print(f"Wrote: {OUT_HTML}")
    print(f"Total size: {len(html):,} bytes ({len(html)/1024:.1f} KB)")


if __name__ == "__main__":
    build()

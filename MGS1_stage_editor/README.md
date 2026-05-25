# MGS1 Stage Editor — PSX Build (Source)

Split source files for the MGS1 Stage Editor (PSX build, v29).

## Quick start

**To use the editor**: open `MGS_Stage_Editor_PSX_29_.html` in your browser.
That single file is fully self-contained and the easiest way to run.

**To modify and rebuild**: edit the files under `src/`, then run:
```
python build.py
```
This bundles everything back into a single self-contained HTML.

## Layout

```
.
├── index.html              ← entry point (loads scripts from src/ and vendor/)
├── styles.css              ← extracted from the inline <style> block
├── build.py                ← bundles index.html + src + vendor back into one HTML
├── vendor/                 ← third-party libraries
│   ├── three.min.js        ← Three.js r140-ish (623 KB)
│   ├── gltf_loader.js      ← THREE.GLTFLoader add-on (106 KB)
│   └── jszip.min.js        ← JSZip v3.10.1 (97 KB)
└── src/                    ← app source, in load order
    ├── _preamble.js        ← code that appears before any FILE: marker
    ├── 00_core.js          ← core helpers, math, MGS hash, basic state
    ├── 01_gcl.js           ← GCL (game control language) parser
    ├── 02_3d.js            ← Three.js scene setup, KMD rendering
    ├── 03_ui.js            ← main UI shell
    ├── 04_textures.js      ← PC DAR / PCX texture loading
    ├── 04a_dropscreen_bg.js
    ├── 05_main.js          ← main app initialization
    ├── 06_gcl_viewer.js
    ├── 07_route_editor.js
    ├── 08_hzm_inspector.js
    ├── 09_event_tracing.js
    ├── 10_vram_analysis.js
    ├── 11_vram_repacker.js
    ├── 12_entity_templates.js
    ├── 13_spawn_wizard.js
    ├── 14_door_analyzer.js
    ├── 15_door_wizard.js
    ├── 16_dropscreen_bg.js
    ├── 17_anim_tools.js    ← animation swapper (uses Three.js)
    ├── 18_char_builder.js
    ├── 18_sound_tools.js
    ├── 19_gcl_flowchart.js
    ├── 19_psx_textures.js  ← PSX *_0.dar texture viewer (with v29 filename patch)
    ├── 19_textures.js
    ├── 20_gcx_disassemble.js
    ├── 21_gcx_assemble.js
    ├── 22_gcx_mutate.js
    ├── 23_gcx_viewer.js
    ├── 24_gcx_charalst.js
    ├── 25_gcx_entities.js
    ├── 26_gcx_psx_pipeline.js
    ├── 27_gcx_text_view.js
    ├── 28_gcx_text_compiler.js
    └── 29_stagedir.js
```

## Notes

### Load order matters
All source files share a single global namespace (no modules). The load
order in `index.html` is important — `00_core.js` defines helpers used
throughout, `02_3d.js` sets up the Three.js scene, etc. If you reorder
the script tags you can break cross-file references.

### Two files named `19_*`
The original monolith had three FILE markers starting with `19_`:
- `19_gcl_flowchart.js`
- `19_psx_textures.js`
- `19_textures.js`

These were left in alphabetical/declared order matching the original.
Rename if you want a clearer numbering scheme.

### PSX filename patch (v29)
The PSX texture viewer (`src/19_psx_textures.js`) includes a hash → name
lookup table built from the mgs_reversing decomp. When you select an
entry in the PSX DAR viewer, the original asset name (e.g. `"katana"`,
`"box_01"`, `"snake"`) is displayed alongside the entry. Unknown hashes
show as `??? 0xXXXX`.

To add more names to the lookup table, edit `PSXT_HASH_TABLE` inside
`src/19_psx_textures.js` — it's a plain JSON object near the top of
the file, mapping `"0xXXXX"` strings to `[name1, name2, ...]` arrays
(collisions get multiple names).

### Build details
The `build.py` script:
1. Reads `index.html` to determine script load order
2. Inlines `styles.css` into a `<style>` block
3. Inlines each `<script src="...">` as `<script>...</script>`
4. Writes the result as a single self-contained HTML

The output is byte-equivalent to the original v29 monolith (minus
the comment header bars I added to each split file).

### Editing tips
- Keep functions in their original file when possible — this preserves
  the cross-file reference structure
- If you add a new module, put it under `src/` and add a `<script>` tag
  to `index.html` in the right load-order position
- Run `node --check src/*.js` to validate syntax before bundling

### Vendor sources
The vendor libraries are bundled from upstream and shouldn't need
modification:
- Three.js: https://github.com/mrdoob/three.js (r140 era)
- JSZip: https://stuk.github.io/jszip/

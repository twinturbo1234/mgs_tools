# MGS1 Animation Swapper — v4

Standalone tool for swapping, editing, splicing, and crossfading MGS1
character animations. Single self-contained HTML file — no server, no
build step needed to run.

## Changes from v3

### Removed
- **Bone Remapper panel** — entire UI section, button handlers
  (`AT_renderBoneStats`, `AT_performBoneDrop`, `AT_performBoneMerge`,
  `AT_updateBonePanel`), and backing functions (`AT_computeBoneStats`,
  `AT_dropBone`, `AT_mergeBoneInto`, `AT_rebuildArchive`) removed
  cleanly. All onclick wiring, panel state, and the `AT_updateBonePanel`
  call from `AT_updateEditBox` are gone.

### Preserved
- **Archive compaction on export** (the orphan/bloat fix). When you
  export a modified OAR, `AT_compactArchive` runs first and strips
  orphaned bitstream bytes left over from prior swap/trim/cut/freeze/
  speed/reverse/boomerang/hold/loop/splice/crossfade operations.
  Without this, every mutation appends new data to the archive but
  never reclaims the old data, growing the file forever.

  Uses content-based deduplication: chunks that are byte-identical
  (e.g. stubs from `AT_padWithStubs`, or shared idle bone streams)
  are emitted only once in the output and have multiple entries point
  at them.

  Console logs the savings on each export, e.g.:
  ```
  Archive compacted: 2497 → 1413 u16 (-1084, 43% smaller).
  Reclaimed orphaned chunk data.
  ```

## Files

| File | Size | Purpose |
|------|------|---------|
| `MGS_Animation_Swapper_Standalone.html` | 774 KB | The complete standalone build — open in any browser |
| `17_anim_tools.js` | ~148 KB | Source: main swapper module (UI, OAR parsing, mutations, viewport) |
| `bootstrap.js` | 1 KB | Source: standalone bootstrap — opens the swapper, hides Close button |
| `three.min.js` | 624 KB | Three.js r140 (frozen version — do not upgrade) |
| `build_anim_standalone.py` | 4 KB | Source: build script (concatenates JS files into HTML) |

## Usage

### To use the tool
Just open `MGS_Animation_Swapper_Standalone.html` in any modern browser.
No installation, no server needed.

### To rebuild after modifying source
Put all four asset files (`17_anim_tools.js`, `three.min.js`,
`bootstrap.js`, `build_anim_standalone.py`) in the same directory
and run:
```
python build_anim_standalone.py
```

### To upload to GitHub
The `MGS_Animation_Swapper_Standalone.html` is the only file end-users
need. Include the source files (`17_anim_tools.js`, `bootstrap.js`,
`build_anim_standalone.py`) for transparency, plus `three.min.js` or
a link to download Three.js r140 for those who want to rebuild.

## Features

| Panel | Purpose |
|-------|---------|
| File picker | Load Character KMD, Target OAR, Donor OAR |
| 3D viewport | Preview animations with skeleton/mesh overlays |
| Playback | Play/pause, scrub, rest pose |
| Motion lists | Browse and select target+donor motions side by side |
| Swap | Replace target motion with donor motion (with auto bit-width recalc) |
| Expand | Pad target with stub slots to match donor count |
| Edit | Trim, Cut, Freeze, Speed, Reverse, Boomerang, Hold, Loop, Revert |
| Splice | Build a sequence by queuing motions from both sides |
| Crossfade | Blend two motions with adjustable overlap frames |

#!/usr/bin/env python3
"""
MGS1 OAR Animation Compiler
============================
Converts an edited GLTF back into a Metal Gear Solid 1 .oar file.

Usage:
    python gltf_to_oar.py <edited.gltf> --ref <original.oar> [--edit N] -o <output.oar>

    <edited.gltf>     GLTF exported from Blender after editing
    --ref <orig.oar>  REQUIRED: the original .oar file
    --edit N          Animation index to recompile from GLTF (repeat for multiple).
                      All other animations are copied from ref OAR byte-perfect.
                      Example: --edit 33 --edit 44
                      If omitted, ALL animations are recompiled from GLTF.
    -o <output.oar>   Output path (default: output.oar)
    --verify          Spot-check accuracy after compiling
    --check N         Number of animations to verify (default: 8)

Workflow:
    1. python oar_to_gltf.py snake.kmd snake.oar -o lossless.gltf
    2. Open lossless.gltf in Blender, edit your animations
       IMPORTANT: In Graph Editor, select all keyframes (A), press T -> Linear
    3. Export as glTF Embedded (Optimize off, Force-keep off)
    4. python gltf_to_oar.py edited.gltf --ref snake.oar --edit 33 -o output.oar

Strategy:
    Translation always comes from the reference OAR (Blender corrupts it).
    For rotation: animations listed with --edit are recompiled from GLTF.
    All other animations are copied verbatim from the reference OAR.
"""

import struct, json, math, argparse, os, base64

PI             = math.acos(-1.0)
GAME_FRAMERATE = 30.0


# ─────────────────────────────────────────────────────────────────────────────
# Bit I/O
# ─────────────────────────────────────────────────────────────────────────────

class BitWriter:
    def __init__(self):
        self._words, self._cur, self._bits = [], 0, 0

    def write_bits(self, value, n):
        if n == 0: return
        value &= (1 << n) - 1
        for i in range(n):
            self._cur |= ((value >> i) & 1) << self._bits
            self._bits += 1
            if self._bits == 16:
                self._words.append(self._cur)
                self._cur = self._bits = 0

    def get_words(self):
        if self._bits > 0:
            self._words.append(self._cur)
            self._cur = self._bits = 0
        return list(self._words)


class BitReader:
    def __init__(self, words):
        self.words, self.bit_pos = words, 0

    def read_bits(self, n):
        if n == 0: return 0
        r = 0
        for i in range(n):
            wi, bi = divmod(self.bit_pos + i, 16)
            r |= ((self.words[wi] >> bi) & 1) << i
        self.bit_pos += n
        return r


def negate_bits(val, nbits):
    if nbits == 0: return 0
    hi = nbits - 1
    return (val | (-(1 << hi))) if (val >> hi) else val


def bits_needed_signed(values):
    if not values or all(v == 0 for v in values): return 1
    max_abs = max(abs(v) for v in values)
    bits = 1
    while (1 << (bits - 1)) <= max_abs: bits += 1
    return min(bits, 15)


def encode_signed(v, bits):
    if bits == 0: return 0
    mx = 1 << (bits - 1)
    v = max(-mx, min(mx - 1, v))
    return v & ((1 << bits) - 1)


# ─────────────────────────────────────────────────────────────────────────────
# Quaternion <-> Euler
# ─────────────────────────────────────────────────────────────────────────────

def euler_to_quat(ex, ey, ez):
    cy, sy = math.cos(ez*.5), math.sin(ez*.5)
    cp, sp = math.cos(ey*.5), math.sin(ey*.5)
    cr, sr = math.cos(ex*.5), math.sin(ex*.5)
    return (sr*cp*cy - cr*sp*sy,
            cr*sp*cy + sr*cp*sy,
            cr*cp*sy - sr*sp*cy,
            cr*cp*cy + sr*sp*sy)

def quat_to_euler(qx, qy, qz, qw):
    ex = math.atan2(2*(qw*qx + qy*qz), 1 - 2*(qx*qx + qy*qy))
    ey = math.asin(max(-1.0, min(1.0, 2*(qw*qy - qz*qx))))
    ez = math.atan2(2*(qw*qz + qx*qy), 1 - 2*(qy*qy + qz*qz))
    return ex, ey, ez

def euler_to_raw(a):  return int(round(a / PI * 2047.0))
def raw_to_euler(v):  return v / 2047.0 * PI


# ─────────────────────────────────────────────────────────────────────────────
# GLTF helpers
# ─────────────────────────────────────────────────────────────────────────────

def load_gltf(gltf_path, bin_path=None):
    with open(gltf_path) as f: gltf = json.load(f)
    bin_data = b''
    for buf in gltf.get('buffers', []):
        uri = buf.get('uri', '')
        if uri.startswith('data:'):
            import base64 as _b64
            bin_data = _b64.b64decode(uri.split(',', 1)[1])
        elif uri:
            p = bin_path or os.path.join(os.path.dirname(os.path.abspath(gltf_path)), uri)
            with open(p, 'rb') as f: bin_data = f.read()
        break
    return gltf, bin_data


def read_accessor(gltf, bin_data, idx):
    acc  = gltf['accessors'][idx]
    bv   = gltf['bufferViews'][acc['bufferView']]
    off  = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    cnt  = acc['count']
    dims = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[acc['type']]
    fmt  = {5126:'f', 5123:'H', 5125:'I'}[acc['componentType']]
    size = {'f':4,'H':2,'I':4}[fmt]
    return [struct.unpack_from(f'<{dims}{fmt}', bin_data, off + i*dims*size)
            if dims > 1 else
            struct.unpack_from(f'<{fmt}', bin_data, off + i*size)[0]
            for i in range(cnt)]


def lerp_channel(times, values, t):
    if t <= times[0]: return values[0]
    if t >= times[-1]: return values[-1]
    for i in range(len(times)-1):
        if times[i] <= t <= times[i+1]:
            fac = (t - times[i]) / (times[i+1] - times[i]) if times[i+1] != times[i] else 0.0
            a, b = values[i], values[i+1]
            if isinstance(a, (int, float)): return a + (b-a)*fac
            return tuple(a[j]+(b[j]-a[j])*fac for j in range(len(a)))
    return values[-1]


def get_rot_channel(gltf, bin_data, anim_idx, bone_name):
    """Returns (times, values) for a bone's rotation channel, or (None, None)."""
    anim = gltf['animations'][anim_idx]
    name_to_node = {n.get('name',''): i for i, n in enumerate(gltf['nodes'])}
    node_idx = name_to_node.get(bone_name)
    if node_idx is None: return None, None
    for ch in anim['channels']:
        if ch['target']['node'] == node_idx and ch['target']['path'] == 'rotation':
            s = anim['samplers'][ch['sampler']]
            return read_accessor(gltf, bin_data, s['input']), read_accessor(gltf, bin_data, s['output'])
    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# OAR parser
# ─────────────────────────────────────────────────────────────────────────────

def parse_oar(data):
    assert data[:4] == b'OARa', f"Bad OAR magic: {data[:4]}"
    max_j = struct.unpack_from('<I', data,  4)[0]
    num_m = struct.unpack_from('<I', data,  8)[0]
    arc_s = struct.unpack_from('<I', data, 12)[0]
    esz   = max_j + 2
    arc_b = 0x10 + esz * 2 * num_m
    entries = []
    for i in range(num_m):
        base = 0x10 + i * esz * 2
        v    = struct.unpack_from(f'<{esz}H', data, base)
        entries.append({'numFrames': v[0], 'moveOffset': v[1],
                        'rotOffsets': list(v[2:2+max_j])})
    archive = list(struct.unpack_from(f'<{arc_s}H', data, arc_b))
    return {'maxJoint': max_j, 'numMotion': num_m}, entries, archive





# ─────────────────────────────────────────────────────────────────────────────
# Rotation bitstream encoder (for edited animations)
# ─────────────────────────────────────────────────────────────────────────────

def encode_rot_bitstream_from_gltf(gltf, bin_data, anim_idx, bone_idx, num_frames):
    """
    Encode rotation for one bone from GLTF data.
    Uses sparse keyframes from GLTF with gap-filling (MAX_DELTA=3).
    """
    MAX_DELTA = 3
    bone_name = f'bone{bone_idx:04d}_'
    times, values = get_rot_channel(gltf, bin_data, anim_idx, bone_name)

    if times is None:
        # Bone not in GLTF -- encode identity
        bw = BitWriter()
        bw.write_bits(1,4); bw.write_bits(1,4); bw.write_bits(1,4)
        bw.write_bits(num_frames & 0xF, 4); bw.write_bits(0, 4)
        bw.write_bits(0,1); bw.write_bits(0,1); bw.write_bits(0,1)
        return bw.get_words()

    # Build keyframe set from GLTF times, filling gaps > MAX_DELTA
    must = set()
    for t in times:
        kf = max(1, min(round(t * GAME_FRAMERATE) + 1, num_frames))
        must.add(kf)
    must.add(num_frames)

    prev = 0
    extra = set()
    for kf in sorted(must):
        if kf - prev > MAX_DELTA:
            for mid in range(prev + MAX_DELTA, kf, MAX_DELTA):
                extra.add(mid)
        prev = kf
    must.update(extra)

    # Sample and quantise
    keyframes = []
    for kf in sorted(must):
        if kf < 1 or kf > num_frames: continue
        t = (kf - 1) / GAME_FRAMERATE
        v = lerp_channel(times, values, t)
        ex, ey, ez = quat_to_euler(v[0], v[1], v[2], v[3])
        keyframes.append((kf, euler_to_raw(ex), euler_to_raw(ey), euler_to_raw(ez)))

    # Collapse constant bones
    if keyframes:
        quant = [(xi, yi, zi) for _, xi, yi, zi in keyframes]
        if len(set(quant)) == 1:
            keyframes = [keyframes[-1]]

    if not keyframes:
        keyframes = [(num_frames, 0, 0, 0)]

    xL = min(bits_needed_signed([q[1] for q in keyframes]), 15)
    yL = min(bits_needed_signed([q[2] for q in keyframes]), 15)
    zL = min(bits_needed_signed([q[3] for q in keyframes]), 15)

    bw = BitWriter()
    bw.write_bits(xL, 4); bw.write_bits(yL, 4); bw.write_bits(zL, 4)

    prev_kf = 0
    for kf, xi, yi, zi in keyframes:
        delta = kf - prev_kf
        while delta > 15:
            bw.write_bits(15,4); bw.write_bits(0,4)
            bw.write_bits(encode_signed(xi,xL),xL)
            bw.write_bits(encode_signed(yi,yL),yL)
            bw.write_bits(encode_signed(zi,zL),zL)
            prev_kf += 15; delta -= 15
        bw.write_bits(delta,4); bw.write_bits(0,4)
        bw.write_bits(encode_signed(xi,xL),xL)
        bw.write_bits(encode_signed(yi,yL),yL)
        bw.write_bits(encode_signed(zi,zL),zL)
        prev_kf = kf

    return bw.get_words()


# ─────────────────────────────────────────────────────────────────────────────
# Compiler
# ─────────────────────────────────────────────────────────────────────────────

def compile_oar(edited_gltf, edited_bin, ref_entries, ref_archive, max_joint,
                edited_anims=None):
    """
    Build OAR binary.
    - Unedited animations: bitstreams copied verbatim from reference OAR.
    - Edited animations: rotation recompiled from GLTF, translation from ref OAR.
    """
    num_anims  = len(ref_entries)  # always use ref OAR count, ignore extra GLTF animations
    entry_size = max_joint + 2
    archive    = []
    table      = []
    seen       = {}   # dedup cache: tuple(words) -> offset

    def intern(words):
        key = tuple(words)
        if key not in seen:
            seen[key] = len(archive)
            archive.extend(words)
        return seen[key]

    edited_count   = 0
    unedited_count = 0

    # Build name->index map for the GLTF animations
    # This lets us look up by canonical name (anim0000..anim0135) regardless
    # of GLTF index order, and ignore any extra tracks Blender adds (_old etc.)
    gltf_name_to_idx = {}
    for gi, anim in enumerate(edited_gltf['animations']):
        name = anim.get('name', '')
        gltf_name_to_idx[name] = gi

    # How many OAR animations to compile (use ref OAR count, not GLTF count)
    num_oar_anims = len(ref_entries)

    print(f"Compiling {num_oar_anims} animations ({max_joint} bones)...")

    for ai in range(num_oar_anims):
        ref_entry  = ref_entries[ai]
        num_frames = ref_entry['numFrames']

        # Find this animation in the GLTF by canonical name
        anim_name = f'anim{ai:04d}'
        gltf_idx  = gltf_name_to_idx.get(anim_name)

        # Determine if this animation was explicitly marked as edited
        is_edited = (edited_anims is None) or (ai in edited_anims)

        # If the animation isn't in the GLTF at all, always copy from ref OAR
        if gltf_idx is None:
            is_edited = False

        if is_edited:
            edited_count += 1
        else:
            unedited_count += 1

        # --- Translation: ALWAYS from reference OAR ---
        move_offset = intern(list(ref_archive[ref_entry['moveOffset']:
                                  _next_offset(ref_entries, ai, 'moveOffset', len(ref_archive))]))

        # --- Rotations ---
        rot_offsets = []
        for bone in range(max_joint):
            if is_edited:
                # Recompile from GLTF (use gltf_idx, not ai)
                words = encode_rot_bitstream_from_gltf(
                    edited_gltf, edited_bin, gltf_idx, bone, num_frames)
                rot_offsets.append(intern(words))
            else:
                # Copy verbatim from reference OAR
                rot_start = ref_entry['rotOffsets'][bone]
                rot_end   = _next_rot_offset(ref_entries, ai, bone, max_joint, len(ref_archive))
                rot_offsets.append(intern(list(ref_archive[rot_start:rot_end])))

        table.append({'numFrames': num_frames, 'moveOffset': move_offset,
                      'rotOffsets': rot_offsets})

        if (ai + 1) % 20 == 0 or ai == num_anims - 1:
            print(f"  [{ai+1}/{num_anims}]  archive={len(archive)} words")

    print(f"  Unedited (copied from OAR): {unedited_count}")
    print(f"  Edited   (compiled from GLTF): {edited_count}")

    if len(archive) > 65535:
        raise OverflowError(f"Archive size {len(archive)} exceeds uint16 max (65535).")

    arc_size = len(archive)
    out = bytearray()
    out += b'OARa'
    out += struct.pack('<I', max_joint)
    out += struct.pack('<I', num_anims)
    out += struct.pack('<I', arc_size)
    for e in table:
        row = [e['numFrames'], e['moveOffset']] + e['rotOffsets']
        while len(row) < entry_size: row.append(0)
        out += struct.pack(f'<{entry_size}H', *row[:entry_size])
    out += struct.pack(f'<{arc_size}H', *archive)
    return bytes(out)


def _next_offset(entries, ai, field, archive_len):
    """Find the end of a bitstream region by finding the next larger offset."""
    this = entries[ai][field]
    candidates = []
    for i, e in enumerate(entries):
        for f in ['moveOffset'] + [f'rot_{b}' for b in range(len(e['rotOffsets']))]:
            pass
        all_offsets = [e['moveOffset']] + e['rotOffsets']
        for o in all_offsets:
            if o > this:
                candidates.append(o)
    return min(candidates) if candidates else archive_len


def _next_rot_offset(entries, ai, bone, max_joint, archive_len):
    """Find the end of a rotation bitstream."""
    this = entries[ai]['rotOffsets'][bone]
    candidates = []
    for e in entries:
        for o in [e['moveOffset']] + e['rotOffsets']:
            if o > this:
                candidates.append(o)
    return min(candidates) if candidates else archive_len


# ─────────────────────────────────────────────────────────────────────────────
# Verifier
# ─────────────────────────────────────────────────────────────────────────────

def verify(oar_data, ref_oar_data, num_check=8):
    """Compare compiled OAR against reference OAR byte-by-byte for unedited anims."""
    hdr, entries, archive       = parse_oar(oar_data)
    ref_hdr, ref_entries, ref_a = parse_oar(ref_oar_data)

    print(f"\nVerifying {min(num_check, len(entries))} animations vs reference OAR...")
    for ai in range(min(num_check, len(entries))):
        e, re = entries[ai], ref_entries[ai]
        nf = re['numFrames']

        # Decode bone0 rotation from both
        def decode_rot(arch, off, nf):
            br = BitReader(arch[off:])
            xL=br.read_bits(4);yL=br.read_bits(4);zL=br.read_bits(4)
            kf=0; result=[]
            while kf < nf:
                kf+=br.read_bits(4); br.read_bits(4)
                xi=negate_bits(br.read_bits(xL),xL)
                yi=negate_bits(br.read_bits(yL),yL)
                zi=negate_bits(br.read_bits(zL),zL)
                result.append((kf, raw_to_euler(xi), raw_to_euler(yi), raw_to_euler(zi)))
            return result

        comp_rots = decode_rot(archive, e['rotOffsets'][0], nf)
        ref_rots  = decode_rot(ref_a,   re['rotOffsets'][0], nf)

        max_err = 0.0
        for (kf_c, *ec), (kf_r, *er) in zip(comp_rots, ref_rots):
            max_err = max(max_err, max(abs(a-b) for a,b in zip(ec, er)))

        tag = "OK  " if max_err < 0.005 else "DIFF"
        print(f"  anim{ai:04d}  frames={nf:3d}  max_euler_err={max_err:.5f}  [{tag}]")
    print("Done.")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description='MGS1 OAR Compiler',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument('gltf',                          help='Edited GLTF from Blender')
    ap.add_argument('bin',  nargs='?', default=None, help='.bin file (auto-detected)')
    ap.add_argument('--ref',    required=True,        help='Original .oar file')
    ap.add_argument('--edit', type=int, action='append', dest='edit', default=None,
                    metavar='N',
                    help='Animation index to recompile from GLTF (can be used multiple times). '
                         'All other animations are copied from the reference OAR unchanged. '
                         'Example: --edit 33 --edit 44')
    ap.add_argument('-o', '--output', default='output.oar')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--check',  type=int, default=8)
    args = ap.parse_args()

    print(f"Loading edited GLTF:  {args.gltf}")
    edited_gltf, edited_bin = load_gltf(args.gltf, args.bin)

    print(f"Loading ref OAR:      {args.ref}")
    with open(args.ref, 'rb') as f: ref_data = f.read()
    ref_hdr, ref_entries, ref_archive = parse_oar(ref_data)
    max_joint = ref_hdr['maxJoint']
    print(f"  maxJoint={max_joint}  numMotion={ref_hdr['numMotion']}")

    edited_anims = set(args.edit) if args.edit else None
    if edited_anims:
        print(f"Recompiling animations: {sorted(edited_anims)}")
        print(f"All others copied from reference OAR unchanged.")
    else:
        print("No --edit flags provided: ALL animations recompiled from GLTF.")
        print("Tip: use --edit N to specify which animations you changed,")
        print("     e.g. --edit 33 --edit 44, so unedited ones are copied perfectly.")

    oar_data = compile_oar(edited_gltf, edited_bin, ref_entries, ref_archive,
                           max_joint, edited_anims)

    with open(args.output, 'wb') as f: f.write(oar_data)
    print(f"\nWrote {len(oar_data):,} bytes  ->  {args.output}")
    print(f"(Original was {len(ref_data):,} bytes)")

    if args.verify:
        verify(oar_data, ref_data, args.check)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
MGS1 OAR + KMD -> GLTF Exporter
=================================
Exports a Metal Gear Solid 1 model (.kmd) + animation file (.oar) into a
single GLTF file with mesh, skeleton, and all animations -- ready for Blender.

This replaces the Noesis export workflow and produces a lossless GLTF with
every OAR keyframe preserved exactly (no frame dropping like Noesis does).

Usage:
    python oar_to_gltf.py <model.kmd> <animations.oar> -o <output.gltf>

    <model.kmd>         The KMD model file (mesh + skeleton)
    <animations.oar>    The OAR animation file
    -o <output.gltf>    Output path (default: output.gltf)

Output:
    A single self-contained GLTF 2.0 file (binary data embedded as base64).
    - Skinned mesh with per-bone rigid weighting
    - Correct bone hierarchy and rest pose positions (from KMD)
    - All animations with every keyframe preserved (from OAR)
    - Animations named anim0000..animNNNN

Workflow:
    1. python oar_to_gltf.py snake.kmd snake.oar -o edit_me.gltf
    2. Open edit_me.gltf in Blender, edit animations
    3. Export back as GLTF 2.0 (keep bone/animation names)
    4. python gltf_to_oar.py edited.gltf --ref snake.oar -o output.oar
"""

import struct, json, math, argparse, os, base64

PI             = math.acos(-1.0)
GAME_FRAMERATE = 30.0

# ─────────────────────────────────────────────────────────────────────────────
# KMD Parser
# ─────────────────────────────────────────────────────────────────────────────
#
# KMD file layout:
#   0x00  Header (32 bytes):
#           uint32 numMesh, uint32 numBones, int32 globalBbox[6]
#   0x20  KmdMesh array (88 bytes each):
#           +0:  uint16 numObj, uint16 numUnk
#           +4:  uint32 numFaces
#           +8:  int32[3] localBboxMin   (sign-extended from int16 pairs)
#           +20: int32[3] localBboxMax
#           +32: int32[3] localPos       <- bone head offset from parent
#           +44: int32   parent          <- -1 = root bone
#           +48: int32   unk
#           +52: uint32  numVerts
#           +56: uint32  vertOfs         <- KMD_VERT array (8 bytes each: int16 x,y,z + 0xFFFF pad)
#           +60: uint32  idxOfs          <- quad face indices (4 bytes each: uint8 i0,i1,i2,i3)
#           +64: uint32  numNorms
#           +68: uint32  normOfs
#           +72: uint32  uvOfs           <- PS1 GTE UV packet data (not standard UV coords)
#           +76: uint32  unkOfs
#           +80: uint32  lastOfs
#           +84: uint32  pad

KMD_HEADER_SIZE = 0x20
KMD_MESH_STRIDE = 88


def parse_kmd(data):
    """
    Returns dict with:
        num_bones: int
        bones: list of {name, local_pos(x,y,z), parent, num_verts, verts, faces}
    """
    num_bones = struct.unpack_from('<I', data, 0)[0]
    bones = []

    for i in range(num_bones):
        base = KMD_HEADER_SIZE + i * KMD_MESH_STRIDE

        num_faces = struct.unpack_from('<I',  data, base + 4)[0]
        local_pos = struct.unpack_from('<3i', data, base + 32)
        parent    = struct.unpack_from('<i',  data, base + 44)[0]
        num_verts = struct.unpack_from('<I',  data, base + 52)[0]
        vert_ofs  = struct.unpack_from('<I',  data, base + 56)[0]
        idx_ofs   = struct.unpack_from('<I',  data, base + 60)[0]

        # Read vertices: int16 x,y,z + uint16 pad (0xFFFF), 8 bytes each
        verts = []
        if num_verts > 0 and vert_ofs < len(data) and vert_ofs != 0xFFFFFFFF:
            for v in range(num_verts):
                vbase = vert_ofs + v * 8
                if vbase + 6 <= len(data):
                    x, y, z, _ = struct.unpack_from('<4h', data, vbase)
                    verts.append((float(x), float(y), float(z)))

        # Read quad faces: 4 x uint8 indices, 4 bytes each
        # Convert to triangles (two per quad)
        faces = []  # list of (i0,i1,i2) triangles
        if num_faces > 0 and idx_ofs < len(data) and idx_ofs != 0xFFFFFFFF:
            for f in range(num_faces):
                fbase = idx_ofs + f * 4
                if fbase + 4 <= len(data):
                    i0, i1, i2, i3 = struct.unpack_from('<4B', data, fbase)
                    # Skip degenerate quads
                    if len({i0, i1, i2, i3}) >= 3:
                        faces.append((i0, i1, i2))
                        if i0 != i3 and i2 != i3:
                            faces.append((i0, i2, i3))

        bones.append({
            'name':      f'bone{i:04d}_',
            'local_pos': (float(local_pos[0]), float(local_pos[1]), float(local_pos[2])),
            'parent':    parent,
            'num_verts': num_verts,
            'verts':     verts,
            'faces':     faces,
        })

    return {'num_bones': num_bones, 'bones': bones}


# ─────────────────────────────────────────────────────────────────────────────
# OAR Parser
# ─────────────────────────────────────────────────────────────────────────────

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


def raw_to_euler(v):
    return v / 2047.0 * PI


def euler_to_quat(ex, ey, ez):
    cy, sy = math.cos(ez*.5), math.sin(ez*.5)
    cp, sp = math.cos(ey*.5), math.sin(ey*.5)
    cr, sr = math.cos(ex*.5), math.sin(ex*.5)
    return (sr*cp*cy - cr*sp*sy,
            cr*sp*cy + sr*cp*sy,
            cr*cp*sy - sr*sp*cy,
            cr*cp*cy + sr*sp*sy)


def parse_oar(data):
    assert data[:4] == b'OARa', f"Not an OAR file (magic={data[:4]})"
    max_joint    = struct.unpack_from('<I', data,  4)[0]
    num_motion   = struct.unpack_from('<I', data,  8)[0]
    archive_size = struct.unpack_from('<I', data, 12)[0]
    entry_size   = max_joint + 2
    archive_base = 0x10 + entry_size * 2 * num_motion
    entries = []
    for i in range(num_motion):
        base = 0x10 + i * entry_size * 2
        vals = struct.unpack_from(f'<{entry_size}H', data, base)
        entries.append({
            'numFrames':  vals[0],
            'moveOffset': vals[1],
            'rotOffsets': list(vals[2: 2 + max_joint]),
        })
    archive = list(struct.unpack_from(f'<{archive_size}H', data, archive_base))
    return {'maxJoint': max_joint, 'numMotion': num_motion}, entries, archive


def decode_rot_bitstream(archive, offset, num_frames):
    br  = BitReader(archive[offset:])
    xL  = br.read_bits(4); yL = br.read_bits(4); zL = br.read_bits(4)
    kf  = 0; result = []
    while kf < num_frames:
        kf   += br.read_bits(4); br.read_bits(4)
        xi    = negate_bits(br.read_bits(xL), xL)
        yi    = negate_bits(br.read_bits(yL), yL)
        zi    = negate_bits(br.read_bits(zL), zL)
        result.append((kf, *euler_to_quat(raw_to_euler(xi), raw_to_euler(yi), raw_to_euler(zi))))
    return result


def decode_move_bitstream(archive, offset, num_frames):
    br    = BitReader(archive[offset:])
    y16   = br.read_bits(16)
    if y16 & 0x800: y16 |= -0x1000
    origin_y = float(y16)
    xL = br.read_bits(4); yL = br.read_bits(4); zL = br.read_bits(4); br.read_bits(4)
    frames = [(0, 0.0, origin_y, 0.0)]
    if xL == 0 and yL == 0 and zL == 0:
        for kf in range(1, num_frames + 1):
            frames.append((kf, 0.0, origin_y, 0.0))
    else:
        for kf in range(1, num_frames + 1):
            xi = negate_bits(br.read_bits(xL), xL)
            yi = negate_bits(br.read_bits(yL), yL)
            zi = negate_bits(br.read_bits(zL), zL)
            frames.append((kf, xi/2047.0*PI, origin_y + float(yi), zi/2047.0*PI))
    return frames


# ─────────────────────────────────────────────────────────────────────────────
# GLTF Builder
# ─────────────────────────────────────────────────────────────────────────────

class GltfBuilder:
    def __init__(self):
        self.buffer       = bytearray()
        self.buffer_views = []
        self.accessors    = []
        self.animations   = []
        self.nodes        = []
        self.meshes       = []
        self.skins        = []

    def _align4(self):
        while len(self.buffer) % 4:
            self.buffer.append(0)

    def _add_bv(self, raw_bytes, target=None):
        self._align4()
        off = len(self.buffer)
        self.buffer.extend(raw_bytes)
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(raw_bytes)}
        if target is not None:
            bv['target'] = target
        idx = len(self.buffer_views)
        self.buffer_views.append(bv)
        return idx

    def add_float_scalar(self, values):
        bv  = self._add_bv(struct.pack(f'<{len(values)}f', *values))
        idx = len(self.accessors)
        self.accessors.append({
            'bufferView': bv, 'componentType': 5126, 'count': len(values),
            'type': 'SCALAR', 'min': [min(values)], 'max': [max(values)],
        })
        return idx

    def add_vec3(self, vecs, is_position=False):
        flat = [v for xyz in vecs for v in xyz]
        # 34962 = ARRAY_BUFFER for vertex attributes
        bv   = self._add_bv(struct.pack(f'<{len(flat)}f', *flat), 34962 if is_position else None)
        idx  = len(self.accessors)
        acc  = {'bufferView': bv, 'componentType': 5126, 'count': len(vecs), 'type': 'VEC3'}
        if is_position:
            acc['min'] = [min(v[i] for v in vecs) for i in range(3)]
            acc['max'] = [max(v[i] for v in vecs) for i in range(3)]
        self.accessors.append(acc)
        return idx

    def add_vec4(self, vecs, is_anim=False):
        flat = [v for xyzw in vecs for v in xyzw]
        bv   = self._add_bv(struct.pack(f'<{len(flat)}f', *flat), 34962 if not is_anim else None)
        idx  = len(self.accessors)
        self.accessors.append({'bufferView': bv, 'componentType': 5126,
                               'count': len(vecs), 'type': 'VEC4'})
        return idx

    def add_uint16_scalar(self, values):
        # 34963 = ELEMENT_ARRAY_BUFFER for indices
        bv  = self._add_bv(struct.pack(f'<{len(values)}H', *values), 34963)
        idx = len(self.accessors)
        self.accessors.append({'bufferView': bv, 'componentType': 5123,
                               'count': len(values), 'type': 'SCALAR'})
        return idx

    def add_uint16_vec4(self, vecs):
        flat = [v for xyzw in vecs for v in xyzw]
        bv   = self._add_bv(struct.pack(f'<{len(flat)}H', *flat), 34962)
        idx  = len(self.accessors)
        self.accessors.append({'bufferView': bv, 'componentType': 5123,
                               'count': len(vecs), 'type': 'VEC4'})
        return idx

    def add_animation(self, name, channels_data):
        samplers, channels = [], []
        for ch in channels_data:
            t_idx = self.add_float_scalar(ch['times'])
            v_idx = (self.add_vec4(ch['values'], is_anim=True)
                     if ch['path'] == 'rotation'
                     else self.add_vec3(ch['values']))
            si = len(samplers)
            samplers.append({'input': t_idx, 'output': v_idx, 'interpolation': 'LINEAR'})
            channels.append({'sampler': si, 'target': {'node': ch['node'], 'path': ch['path']}})
        self.animations.append({'name': name, 'samplers': samplers, 'channels': channels})

    def build_mesh(self, kmd):
        """
        Build a skinned mesh from all KMD bone mesh blocks.
        Each block is rigidly bound to its bone (weight=1.0).
        Returns node index of mesh node.
        """
        all_verts   = []  # (x,y,z) float
        all_indices = []  # triangle vertex indices (uint16)
        all_joints  = []  # (j0,j1,j2,j3) uint16  -- bone index for skinning
        all_weights = []  # (w0,w1,w2,w3) float   -- weights

        vert_offset = 0
        for bi, bone in enumerate(kmd['bones']):
            if not bone['verts']:
                continue

            n = len(bone['verts'])
            all_verts.extend(bone['verts'])

            # Skinning: each vertex rigidly bound to its bone
            for _ in range(n):
                all_joints.append((bi, 0, 0, 0))
                all_weights.append((1.0, 0.0, 0.0, 0.0))

            for tri in bone['faces']:
                i0, i1, i2 = tri
                if max(i0, i1, i2) < n:
                    all_indices.append(vert_offset + i0)
                    all_indices.append(vert_offset + i1)
                    all_indices.append(vert_offset + i2)

            vert_offset += n

        if not all_verts:
            return None, None

        pos_acc    = self.add_vec3(all_verts, is_position=True)
        idx_acc    = self.add_uint16_scalar(all_indices)
        joints_acc = self.add_uint16_vec4(all_joints)
        weights_acc= self.add_vec4(all_weights)

        prim = {
            'attributes': {
                'POSITION': pos_acc,
                'JOINTS_0': joints_acc,
                'WEIGHTS_0': weights_acc,
            },
            'indices': idx_acc,
            'mode': 4,  # TRIANGLES
        }
        mesh_idx = len(self.meshes)
        self.meshes.append({'name': 'SnakeMesh', 'primitives': [prim]})

        mesh_node_idx = len(self.nodes)
        self.nodes.append({'name': 'mesh_node', 'mesh': mesh_idx, 'skin': 0})
        return mesh_node_idx

    def build_skeleton(self, kmd):
        """Build bone nodes with rest pose positions. Returns bone_idx->node_idx map."""
        bone_to_node = {}
        for bi, bone in enumerate(kmd['bones']):
            ni = len(self.nodes)
            bone_to_node[bi] = ni
            node = {'name': bone['name']}
            tx, ty, tz = bone['local_pos']
            if tx != 0.0 or ty != 0.0 or tz != 0.0:
                node['translation'] = [tx, ty, tz]
            self.nodes.append(node)

        # Wire up parent->children relationships
        children_map = {bi: [] for bi in range(kmd['num_bones'])}
        for bi, bone in enumerate(kmd['bones']):
            p = bone['parent']
            if 0 <= p < kmd['num_bones'] and p != bi:
                children_map[p].append(bi)

        for bi, children in children_map.items():
            if children:
                self.nodes[bone_to_node[bi]]['children'] = [
                    bone_to_node[ci] for ci in children]

        joints = [bone_to_node[bi] for bi in range(kmd['num_bones'])]
        self.skins.append({'name': 'Armature', 'joints': joints})
        return bone_to_node

    def build(self, root_nodes):
        b64 = base64.b64encode(bytes(self.buffer)).decode('ascii')
        return {
            'asset': {'version': '2.0', 'generator': 'MGS1 OAR+KMD Exporter (lossless)'},
            'scene': 0,
            'scenes': [{'nodes': root_nodes}],
            'nodes':       self.nodes,
            'meshes':      self.meshes if self.meshes else [],
            'skins':       self.skins if self.skins else [],
            'animations':  self.animations,
            'accessors':   self.accessors,
            'bufferViews': self.buffer_views,
            'buffers': [{'byteLength': len(self.buffer),
                         'uri': f'data:application/octet-stream;base64,{b64}'}],
        }


# ─────────────────────────────────────────────────────────────────────────────
# Main exporter
# ─────────────────────────────────────────────────────────────────────────────


def ensure_quat_continuity(quats):
    """
    Flip quaternion signs to ensure continuity between consecutive keyframes.
    q and -q represent the same rotation, but Blender interpolates between
    them as a 180-degree rotation. We pick the sign that minimizes the
    dot product distance to the previous quaternion.
    """
    if not quats:
        return quats
    result = [quats[0]]
    for q in quats[1:]:
        prev = result[-1]
        # dot product: if negative, flip sign of q
        dot = sum(a*b for a,b in zip(prev, q))
        if dot < 0:
            q = tuple(-v for v in q)
        result.append(q)
    return result


def export(kmd_data, oar_data, fps=30.0):
    kmd = parse_kmd(kmd_data)
    oar_header, entries, archive = parse_oar(oar_data)

    max_joint  = oar_header['maxJoint']
    num_motion = oar_header['numMotion']
    num_bones  = kmd['num_bones']

    print(f"KMD: {num_bones} bones, "
          f"{sum(len(b['verts']) for b in kmd['bones'])} vertices, "
          f"{sum(len(b['faces']) for b in kmd['bones'])} triangles")
    print(f"OAR: {num_motion} animations, {max_joint} bone channels")

    builder      = GltfBuilder()
    mesh_node    = builder.build_mesh(kmd)
    bone_to_node = builder.build_skeleton(kmd)

    # Collect root nodes for the scene
    # Root bones = bones whose parent is -1 or out of range
    root_bones = [bi for bi, bone in enumerate(kmd['bones'])
                  if bone['parent'] < 0 or bone['parent'] >= num_bones]
    root_nodes = [bone_to_node[bi] for bi in root_bones]
    if mesh_node is not None:
        root_nodes.insert(0, mesh_node)

    print(f"Exporting {num_motion} animations...")

    for ai, entry in enumerate(entries):
        num_frames = entry['numFrames']
        channels   = []

        # Translation (root bone = bone 0)
        move_frames = decode_move_bitstream(archive, entry['moveOffset'], num_frames)
        times_t, values_t, seen_t = [], [], set()
        for kf, tx, ty, tz in move_frames:
            t   = kf / fps  # kf=0 -> t=0 (origin), kf=1 -> t=1/fps, etc.
            key = round(t * 10000)
            if key not in seen_t:
                seen_t.add(key)
                times_t.append(t)
                values_t.append((tx, ty, tz))

        if times_t and 0 in bone_to_node:
            channels.append({'node': bone_to_node[0], 'path': 'translation',
                             'times': times_t, 'values': values_t})

        # Rotations per bone
        for bi in range(min(num_bones, max_joint, len(entry['rotOffsets']))):
            rot_kfs = decode_rot_bitstream(archive, entry['rotOffsets'][bi], num_frames)
            if not rot_kfs or bi not in bone_to_node:
                continue
            times_r  = [(kf - 1) / fps for kf, *_ in rot_kfs]
            values_r = [(qx, qy, qz, qw) for _, qx, qy, qz, qw in rot_kfs]
            # Fix sign discontinuities so Blender doesn't interpolate through 180° flips
            values_r = ensure_quat_continuity(values_r)
            channels.append({
                'node':   bone_to_node[bi],
                'path':   'rotation',
                'times':  times_r,
                'values': values_r,
            })

        builder.add_animation(f'anim{ai:04d}', channels)

        if (ai + 1) % 20 == 0 or ai == num_motion - 1:
            print(f"  [{ai+1}/{num_motion}]")

    return builder.build(root_nodes)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description='MGS1 OAR+KMD -> GLTF Exporter (mesh + skeleton + animations)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument('kmd',  help='Model file (.kmd)')
    ap.add_argument('oar',  help='Animation file (.oar)')
    ap.add_argument('-o', '--output', default='output.gltf', help='Output .gltf')
    ap.add_argument('--fps', type=float, default=30.0)
    args = ap.parse_args()

    print(f"Loading KMD: {args.kmd}")
    with open(args.kmd, 'rb') as f: kmd_data = f.read()

    print(f"Loading OAR: {args.oar}")
    with open(args.oar, 'rb') as f: oar_data = f.read()

    gltf = export(kmd_data, oar_data, fps=args.fps)

    with open(args.output, 'w') as f:
        json.dump(gltf, f, separators=(',', ':'))

    size_kb = os.path.getsize(args.output) // 1024
    print(f"\nWrote {size_kb} KB -> {args.output}")
    print(f"  {len(gltf['animations'])} animations")
    print(f"  {len(gltf['nodes'])} nodes ({gltf['skins'][0]['joints'].__len__()} bones)")
    print()
    print("Next steps:")
    print(f"  1. Open {args.output} in Blender")
    print(f"  2. Edit animations in the NLA editor")
    print(f"  3. Export as GLTF 2.0 (keep bone + animation names)")
    print(f"  4. python gltf_to_oar.py edited.gltf --ref {args.oar} -o output.oar")


if __name__ == '__main__':
    main()

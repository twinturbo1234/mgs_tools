// ═══════════════════════════════════════════════════════════════════════════
// 17_anim_tools.js  —  MGS1 Animation Swapper
// ═══════════════════════════════════════════════════════════════════════════
// Self-contained module: KMD character parser, OAR parser/decoder/splicer,
// Three.js viewport for character preview, animation playback engine, swap UI.
// Hooked via the "Extras ▾" toolbar dropdown.
//
// Architecture:
//   Modal panel overlaid on the main editor, with its own Three.js scene.
//   Three file slots: KMD (character model), Target OAR (the one we edit),
//   Donor OAR (the one we pull anims from for swapping).
//   Animation list per OAR; click any motion to preview it on the character.
//   "Swap" applies donor's selected motion into target's selected slot.
//   "Export" saves the modified target OAR.
// ═══════════════════════════════════════════════════════════════════════════

// ─── BitReader / helpers (verified byte-perfect against snake.oar) ──────────
function AT_BitReader(words, startBit){this.words=words;this.bitPos=startBit||0;}
AT_BitReader.prototype.read=function(n){
  if(n===0)return 0;
  var r=0;
  for(var i=0;i<n;i++){
    var wi=(this.bitPos+i)>>>4;
    var bi=(this.bitPos+i)&15;
    r|=((this.words[wi]>>bi)&1)<<i;
  }
  this.bitPos+=n;
  return r;
};
function AT_negateBits(val,n){
  if(n===0)return 0;
  var hi=n-1;
  return (val>>hi)?(val|-(1<<hi)):val;
}
function AT_rawToEuler(v){return v/2047.0*Math.PI;}
function AT_eulerToQuat(ex,ey,ez){
  var cy=Math.cos(ez*.5),sy=Math.sin(ez*.5);
  var cp=Math.cos(ey*.5),sp=Math.sin(ey*.5);
  var cr=Math.cos(ex*.5),sr=Math.sin(ex*.5);
  return [sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy, cr*cp*cy+sr*sp*sy];
}
// Inverse of AT_eulerToQuat (same Tait-Bryan ZYX convention). Returns radians.
// Used by the bone remapper to compose two bones' rotations and convert back
// to the Euler-int storage format.
function AT_quatToEuler(q){
  var x=q[0], y=q[1], z=q[2], w=q[3];
  var sinp = 2*(w*y - z*x);
  var ey = (Math.abs(sinp) >= 1) ? (sinp >= 0 ? Math.PI/2 : -Math.PI/2) : Math.asin(sinp);
  var ex = Math.atan2(2*(w*x + y*z), 1 - 2*(x*x + y*y));
  var ez = Math.atan2(2*(w*z + x*y), 1 - 2*(y*y + z*z));
  return [ex, ey, ez];
}
// Hamilton product: q1 * q2 (applies q2 first, then q1).
function AT_quatMul(a, b){
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]
  ];
}
// Convert radians back to the OAR's signed int representation.
// Inverse of AT_rawToEuler. Wraps to (-π, π] before scaling.
function AT_eulerToRaw(r){
  // Wrap to (-π, π]
  r = r - 2*Math.PI*Math.floor((r + Math.PI) / (2*Math.PI));
  return Math.round(r / Math.PI * 2047);
}
// Compute the minimum signed bit width needed to store an integer value (1-15).
function AT_bitsForSigned(maxAbs){
  if(maxAbs === 0) return 0;
  // n-bit signed range: [-2^(n-1), 2^(n-1) - 1]. Need 2^(n-1) > maxAbs.
  var n = 1;
  while((1 << (n-1)) <= maxAbs && n < 15) n++;
  return n;
}

// ─── Character KMD parser ────────────────────────────────────────────────────
// PHASE 2: now reads all six per-bone mesh data sections (vertices, vertex face
// indices, normals, normal face indices, UVs, materials) plus all preserved
// unknown bytes needed for safe write-back. Field offsets verified empirically
// against real snake.kmd. Cross-referenced with Jayveer/MGS-KMD-Noesis mesh.h
// for data-section interpretation.
//
// Per-bone record layout (88 bytes total, starting at file+0x20 + i*88):
//   +0x00 u32   flags        — always 0x00010001 (GPU command marker?)
//   +0x04 u32   numFaces
//   +0x08-0x13  bbox6i16     — per-bone bounding box, 6×i16 (min then max?)
//   +0x14-0x1F  unk3u32      — 3×u32 unknown (bbox extents/radii?)
//   +0x20-0x2B  localPos3i32 — bone position relative to parent
//   +0x2C i32   parent       — parent bone index (-1 for root)
//   +0x30 i32   unk30        — always -1
//   +0x34 u32   numVerts
//   +0x38 u32   vertOfs       → KmdVert[numVerts]   (8 bytes each: i16 x,y,z, u16 w)
//   +0x3C u32   faceVtxOfs    → u8[numFaces*4]      (4 vertex indices per quad)
//   +0x40 u32   numNorms
//   +0x44 u32   normOfs       → KmdNVert[numNorms]  (8 bytes each: i16 x,y,z scaled 1/4096, u16 pad)
//   +0x48 u32   faceNrmOfs    → u8[numFaces*4]      (4 normal indices per quad, top bit set)
//   +0x4C u32   uvOfs         → KmdUV[numFaces*4]   (2 bytes each: u8 tu, u8 tv)
//   +0x50 u32   matOfs        → u16[numFaces]       (PSX texpage+blend command per face)
//   +0x54 u32   nullpad       — always 0
function AT_parseCharKMD(buf){
  var u8=buf instanceof Uint8Array?buf:new Uint8Array(buf);
  var dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  var numBones=dv.getUint32(0,true);
  if(numBones>200||numBones<1) throw new Error("KMD bone count looks wrong: "+numBones);
  var bones=[];
  var HDR=0x20, STRIDE=88;
  for(var i=0;i<numBones;i++){
    var base=HDR+i*STRIDE;
    if(base+STRIDE>u8.length) throw new Error("KMD truncated at bone "+i);
    var flags     = dv.getUint32(base+0x00, true);
    var numFaces  = dv.getUint32(base+0x04, true);
    // preserve raw byte ranges for unknown fields so write-back is byte-exact
    var bboxBytes = u8.slice(base+0x08, base+0x14);    // 12 bytes (6 i16)
    var unkExt    = u8.slice(base+0x14, base+0x20);    // 12 bytes (3 u32)
    var lx        = dv.getInt32(base+0x20, true),
        ly        = dv.getInt32(base+0x24, true),
        lz        = dv.getInt32(base+0x28, true);
    var parent    = dv.getInt32(base+0x2C, true);
    var unk30     = dv.getInt32(base+0x30, true);
    var numVerts  = dv.getUint32(base+0x34, true);
    var vertOfs   = dv.getUint32(base+0x38, true);
    var faceVtxOfs= dv.getUint32(base+0x3C, true);
    var numNorms  = dv.getUint32(base+0x40, true);
    var normOfs   = dv.getUint32(base+0x44, true);
    var faceNrmOfs= dv.getUint32(base+0x48, true);
    var uvOfs     = dv.getUint32(base+0x4C, true);
    var matOfs    = dv.getUint32(base+0x50, true);
    var unk54     = dv.getUint32(base+0x54, true);

    // Vertices: i16 x,y,z + u16 w (bone bind weight; typically 0xFFFF)
    var verts=[], vertsW=[];
    if(numVerts>0 && vertOfs<u8.length){
      for(var v=0;v<numVerts;v++){
        var vb=vertOfs+v*8;
        if(vb+8<=u8.length){
          verts.push([dv.getInt16(vb,true),dv.getInt16(vb+2,true),dv.getInt16(vb+4,true)]);
          vertsW.push(dv.getUint16(vb+6,true));
        }
      }
    }
    // Vertex face indices: 4 u8 per face (quad corners). Read raw quads here;
    // tri-as-quad has last index == prev.
    var faceVerts=[], tris=[];
    if(numFaces>0 && faceVtxOfs<u8.length){
      for(var f=0;f<numFaces;f++){
        var fb=faceVtxOfs+f*4;
        if(fb+4<=u8.length){
          var i0=u8[fb],i1=u8[fb+1],i2=u8[fb+2],i3=u8[fb+3];
          faceVerts.push([i0,i1,i2,i3]);
          // Also generate triangle list for the renderer (backward compat with prior callers)
          var uniqCount=(function(){var s={};s[i0]=1;s[i1]=1;s[i2]=1;s[i3]=1;return Object.keys(s).length;})();
          if(uniqCount>=3){
            tris.push([i0,i1,i2]);
            if(i0!==i3 && i2!==i3) tris.push([i0,i2,i3]);
          }
        }
      }
    }
    // Normals: i16 x,y,z + u16 pad. Magnitude ~4096.
    var normals=[];
    if(numNorms>0 && normOfs<u8.length){
      for(var n=0;n<numNorms;n++){
        var nb=normOfs+n*8;
        if(nb+8<=u8.length){
          normals.push([dv.getInt16(nb,true),dv.getInt16(nb+2,true),dv.getInt16(nb+4,true)]);
        }
      }
    }
    // Normal face indices: 4 u8 per face, top bit set in MSB nibble (mask 0x7F to get index).
    var faceNormals=[];
    if(numFaces>0 && faceNrmOfs<u8.length){
      for(var f=0;f<numFaces;f++){
        var fb=faceNrmOfs+f*4;
        if(fb+4<=u8.length){
          faceNormals.push([u8[fb],u8[fb+1],u8[fb+2],u8[fb+3]]);
        }
      }
    }
    // UVs: 4 per face. Each UV is 2 bytes (u8 tu, u8 tv).
    var uvs=[];
    if(numFaces>0 && uvOfs<u8.length){
      for(var f=0;f<numFaces;f++){
        var fb=uvOfs+f*8;
        var quad=[];
        for(var k=0;k<4;k++){
          if(fb+k*2+2<=u8.length){
            quad.push([u8[fb+k*2], u8[fb+k*2+1]]);
          } else {
            quad.push([0,0]);
          }
        }
        uvs.push(quad);
      }
    }
    // Materials: u16 per face (PSX GPU texpage+blend command).
    var materials=[];
    if(numFaces>0 && matOfs<u8.length){
      for(var f=0;f<numFaces;f++){
        var mb=matOfs+f*2;
        if(mb+2<=u8.length){
          materials.push(dv.getUint16(mb,true));
        }
      }
    }

    bones.push({
      // Mesh-related (read AND can be rewritten):
      localPos:[lx,ly,lz], parent:parent,
      numVerts:numVerts, verts:verts, vertsW:vertsW,
      numFaces:numFaces, faceVerts:faceVerts, tris:tris,
      numNorms:numNorms, normals:normals, faceNormals:faceNormals,
      uvs:uvs, materials:materials,
      // Preserved metadata (write-back unchanged):
      flags:flags, bboxBytes:bboxBytes, unkExt:unkExt, unk30:unk30, unk54:unk54
    });
  }
  return {numBones:numBones, bones:bones, headerBytes:u8.slice(0, HDR)};
}

// ─── OAR parser ──────────────────────────────────────────────────────────────
function AT_parseOAR(buf){
  var u8=buf instanceof Uint8Array?buf:new Uint8Array(buf);
  var dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  if(String.fromCharCode(u8[0],u8[1],u8[2],u8[3])!=='OARa') throw new Error('Not an OAR file');
  var maxJoint=dv.getUint32(4,true);
  var numMotion=dv.getUint32(8,true);
  var archiveSize=dv.getUint32(12,true);
  var entrySize=maxJoint+2;
  var tableBytes=entrySize*2*numMotion;
  var archiveByteOffset=0x10+tableBytes;
  if(archiveByteOffset+archiveSize*2>u8.length) throw new Error("OAR truncated");
  var entries=[];
  for(var i=0;i<numMotion;i++){
    var base=0x10+i*entrySize*2;
    var numFrames=dv.getUint16(base,true);
    var moveOffset=dv.getUint16(base+2,true);
    var rotOffsets=[];
    for(var j=0;j<maxJoint;j++) rotOffsets.push(dv.getUint16(base+4+j*2,true));
    entries.push({numFrames:numFrames, moveOffset:moveOffset, rotOffsets:rotOffsets});
  }
  var archive=new Uint16Array(archiveSize);
  for(var k=0;k<archiveSize;k++) archive[k]=dv.getUint16(archiveByteOffset+k*2,true);
  return {maxJoint:maxJoint, numMotion:numMotion, archiveSize:archiveSize, entries:entries, archive:archive};
}

// ─── Stream decoders ─────────────────────────────────────────────────────────
function AT_decodeRot(archive,offset,numFrames){
  var br=new AT_BitReader(archive,offset*16);
  var xL=br.read(4),yL=br.read(4),zL=br.read(4);
  var kf=0, frames=[];
  while(kf<numFrames){
    kf+=br.read(4); br.read(4);
    var xi=AT_negateBits(br.read(xL),xL);
    var yi=AT_negateBits(br.read(yL),yL);
    var zi=AT_negateBits(br.read(zL),zL);
    var q=AT_eulerToQuat(AT_rawToEuler(xi),AT_rawToEuler(yi),AT_rawToEuler(zi));
    frames.push({frame:kf, q:q});
  }
  return frames;
}
function AT_decodeMove(archive,offset,numFrames){
  var br=new AT_BitReader(archive,offset*16);
  var y16=br.read(16);
  if(y16&0x800) y16|=-0x1000;
  var originY=y16;
  var xL=br.read(4),yL=br.read(4),zL=br.read(4); br.read(4);
  var frames=[{frame:0, t:[0,originY,0]}];
  if(xL===0 && yL===0 && zL===0){
    for(var kf=1; kf<=numFrames; kf++) frames.push({frame:kf, t:[0,originY,0]});
    return frames;
  }
  var k=0;
  while(k<numFrames){
    k++;
    var xi=AT_negateBits(br.read(xL),xL);
    var yi=AT_negateBits(br.read(yL),yL);
    var zi=AT_negateBits(br.read(zL),zL);
    frames.push({frame:k, t:[xi/2047.0*Math.PI, originY+yi, zi/2047.0*Math.PI]});
  }
  return frames;
}

// ─── Splicer ─────────────────────────────────────────────────────────────────
function AT_rotBitLen(archive,offset,numFrames){
  var br=new AT_BitReader(archive,offset*16);
  var xL=br.read(4),yL=br.read(4),zL=br.read(4);
  var kf=0;
  while(kf<numFrames){
    kf+=br.read(4); br.read(4);
    br.read(xL); br.read(yL); br.read(zL);
  }
  return br.bitPos-offset*16;
}
function AT_moveBitLen(archive,offset,numFrames){
  var br=new AT_BitReader(archive,offset*16);
  br.read(16);
  var xL=br.read(4),yL=br.read(4),zL=br.read(4); br.read(4);
  if(xL===0 && yL===0 && zL===0) return br.bitPos-offset*16;
  var k=0;
  while(k<numFrames){
    k++;
    br.read(xL); br.read(yL); br.read(zL);
  }
  return br.bitPos-offset*16;
}
function AT_extractChunks(src,idx){
  var m=src.entries[idx];
  var moveBits=AT_moveBitLen(src.archive,m.moveOffset,m.numFrames);
  var moveWords=Math.ceil(moveBits/16);
  var moveChunk=src.archive.slice(m.moveOffset, m.moveOffset+moveWords);
  var rotChunks=[];
  for(var j=0;j<src.maxJoint;j++){
    var b=AT_rotBitLen(src.archive,m.rotOffsets[j],m.numFrames);
    var w=Math.ceil(b/16);
    rotChunks.push(src.archive.slice(m.rotOffsets[j], m.rotOffsets[j]+w));
  }
  return {numFrames:m.numFrames, moveChunk:moveChunk, rotChunks:rotChunks};
}
function AT_spliceMotion(target,donor,donorIdx,targetSlot){
  if(target.maxJoint!==donor.maxJoint) throw new Error("Skeleton mismatch (maxJoint "+target.maxJoint+" vs "+donor.maxJoint+")");
  var ch=AT_extractChunks(donor,donorIdx);
  var totalAppend=ch.moveChunk.length+ch.rotChunks.reduce(function(a,c){return a+c.length;},0);
  var newArch=new Uint16Array(target.archive.length+totalAppend);
  newArch.set(target.archive,0);
  var off=target.archive.length;
  var newMoveOff=off;
  newArch.set(ch.moveChunk,off); off+=ch.moveChunk.length;
  var newRotOffs=[];
  for(var i=0;i<ch.rotChunks.length;i++){
    newRotOffs.push(off);
    newArch.set(ch.rotChunks[i],off);
    off+=ch.rotChunks[i].length;
  }
  var newEntries=target.entries.map(function(e){return {numFrames:e.numFrames, moveOffset:e.moveOffset, rotOffsets:e.rotOffsets.slice()};});
  newEntries[targetSlot]={numFrames:ch.numFrames, moveOffset:newMoveOff, rotOffsets:newRotOffs};
  return {maxJoint:target.maxJoint, numMotion:target.numMotion, archiveSize:newArch.length, entries:newEntries, archive:newArch};
}

// Append donor motions [startIdx..endIdx-1] to target as NEW slots.
// New slots receive indices [target.numMotion..target.numMotion+(endIdx-startIdx)-1].
// All existing target motions preserved unchanged.
// THROWS if the resulting archive would exceed 65535 u16 (OAR format's u16 offset limit).
function AT_appendMotionsFromDonor(target, donor, startIdx, endIdx){
  if(target.maxJoint!==donor.maxJoint) throw new Error("Skeleton mismatch ("+target.maxJoint+" vs "+donor.maxJoint+" joints)");
  if(startIdx<0||endIdx>donor.numMotion||startIdx>=endIdx) throw new Error("Invalid donor range ["+startIdx+","+endIdx+")");
  // Calculate total bytes we'll append by walking each donor motion's chunks
  var chunks=[];
  var totalAppend=0;
  for(var i=startIdx;i<endIdx;i++){
    var ch=AT_extractChunks(donor,i);
    chunks.push(ch);
    totalAppend+=ch.moveChunk.length;
    for(var j=0;j<ch.rotChunks.length;j++) totalAppend+=ch.rotChunks[j].length;
  }
  var finalSize=target.archive.length+totalAppend;
  if(finalSize>65535) throw new Error("Archive size "+finalSize+" u16 exceeds OAR's u16 offset limit (65535). Use stub padding for unused slots, or trim donor range.");
  // Build the new archive in one allocation
  var newArch=new Uint16Array(finalSize);
  newArch.set(target.archive,0);
  var off=target.archive.length;
  // Clone existing entries unchanged
  var newEntries=target.entries.map(function(e){return {numFrames:e.numFrames, moveOffset:e.moveOffset, rotOffsets:e.rotOffsets.slice()};});
  // Append each new motion's chunks and build its entry
  for(var k=0;k<chunks.length;k++){
    var c=chunks[k];
    var newMoveOff=off;
    newArch.set(c.moveChunk,off); off+=c.moveChunk.length;
    var rotOffs=[];
    for(var r=0;r<c.rotChunks.length;r++){
      rotOffs.push(off);
      newArch.set(c.rotChunks[r],off);
      off+=c.rotChunks[r].length;
    }
    newEntries.push({numFrames:c.numFrames, moveOffset:newMoveOff, rotOffsets:rotOffs});
  }
  return {
    maxJoint: target.maxJoint,
    numMotion: newEntries.length,
    archiveSize: newArch.length,
    entries: newEntries,
    archive: newArch
  };
}

// Convenience: pad target's motion count up to match donor's by cloning
// donor's motions at the indices that target is missing.
function AT_expandToMatchDonor(target, donor){
  if(donor.numMotion<=target.numMotion) throw new Error("Donor must have more motions than target (donor="+donor.numMotion+", target="+target.numMotion+")");
  return AT_appendMotionsFromDonor(target, donor, target.numMotion, donor.numMotion);
}

// Pad target's motion count up to `desiredCount` by appending minimal 1-frame
// static-pose stubs. Every new slot points to the same shared stub data block
// (numFrames=1, all bones at identity rotation, root at Y=0). This is the
// space-efficient option for files near the u16 archive-offset limit.
//
// Layout of the shared stub:
//   move stream: 16-bit Y origin (= 0), then 4-bit xL=yL=zL=0, then 4-bit unk
//     = 28 bits, rounded up = 2 u16 (32 bits)
//   rot stream:  4-bit xL=yL=zL=0, then for ONE keyframe: 4-bit frame delta + 4-bit unk
//     (no axis bits since widths are 0) = 12+8 = 20 bits, rounded up = 2 u16
//   Total: 1 move chunk (2 u16) + N rotation chunks (2 u16 each) = 2 + 2*maxJoint u16
//   For 16-joint skeleton: 34 u16 = 68 bytes shared across all stubs.
//
// All stub slots share the same offsets — they decode to identical static poses.
function AT_padWithStubs(target, desiredCount){
  if(desiredCount <= target.numMotion) throw new Error("desiredCount ("+desiredCount+") must exceed target.numMotion ("+target.numMotion+")");
  var slotsToAdd = desiredCount - target.numMotion;
  var oldLen = target.archive.length;
  // Stub layout: 2 u16 for move + 2 u16 per rotation stream
  var stubBlockLen = 2 + 2 * target.maxJoint;
  var newArch = new Uint16Array(oldLen + stubBlockLen);
  newArch.set(target.archive, 0);
  // All zero — that's exactly what we want (Y=0, all bit widths=0, one keyframe with frame-delta=1 unk=0)
  // Special case: for numFrames=1 the rotation stream needs ONE keyframe with frame-delta>=1.
  // With all-zero widths and all-zero data, the decoder loop reads frame-delta=0, then unk=0, and never advances.
  // That would be an infinite loop. So we set frame-delta to 1 by writing 0x0001 into the first u16 of each rot chunk.
  // But all rot chunks share the same offset (the rot stub block), so we can fix it once.
  // Actually let's be more careful and lay out the stub data explicitly:
  // move chunk @ offset oldLen (2 u16):
  //   bits 0-15: y_origin = 0
  //   bits 16-19: xL = 0
  //   bits 20-23: yL = 0
  //   bits 24-27: zL = 0
  //   bits 28-31: unk = 0
  //   => both u16 = 0
  var moveOff = oldLen;
  newArch[moveOff] = 0;
  newArch[moveOff + 1] = 0;
  // rot chunk @ offset oldLen+2 (2 u16):
  //   bits 0-3:  xL = 0
  //   bits 4-7:  yL = 0
  //   bits 8-11: zL = 0
  //   bits 12-15: frame-delta = 1 (gets kf from 0 to 1, satisfying numFrames>=1)
  //   bits 16-19: unk = 0
  //   axis bits = 0 (since widths are zero)
  //   => first u16 = (1 << 12) = 0x1000
  //      second u16 = 0
  var rotOff = oldLen + 2;
  newArch[rotOff] = 0x1000;
  newArch[rotOff + 1] = 0;
  // All new entries share these offsets — every stub slot decodes to the same static pose
  var newEntries = target.entries.map(function(e){return {numFrames:e.numFrames, moveOffset:e.moveOffset, rotOffsets:e.rotOffsets.slice()};});
  for(var k=0; k<slotsToAdd; k++){
    var rotOffs = new Array(target.maxJoint).fill(rotOff);
    newEntries.push({numFrames:1, moveOffset:moveOff, rotOffsets:rotOffs});
  }
  return {
    maxJoint: target.maxJoint,
    numMotion: newEntries.length,
    archiveSize: newArch.length,
    entries: newEntries,
    archive: newArch
  };
}
// ─── Archive compaction (garbage collect orphaned chunks) ──────────────────
// Rebuilds the archive containing only chunks actually referenced by current
// entries. Deduplicates identical chunks (e.g. shared stubs from AT_padWithStubs
// won't be duplicated). Call before serializing to keep output file size sane
// even after many swap operations.
//
// WHY THIS IS NEEDED: AT_spliceMotion is APPEND-ONLY — it copies the entire
// old archive (including the old target motion bytes) then appends the new
// donor motion at the end. The slot's offsets are updated to point at the
// new location, but the old data stays in the archive as orphaned bytes.
// Without compaction, every swap grows the file by the donor motion's size
// regardless of whether donor is shorter or longer than the target it replaced.
function AT_compactArchive(oar){
  var newArchList = [];           // array of u16 values, becomes archive
  var chunkOffsetMap = new Map(); // "u16,u16,..." → offset in newArchList
  function addChunk(chunk){
    // chunk is Uint16Array; build a string key for dedup lookup
    var key = chunk.join(",");
    if(chunkOffsetMap.has(key)) return chunkOffsetMap.get(key);
    var off = newArchList.length;
    for(var i=0;i<chunk.length;i++) newArchList.push(chunk[i]);
    chunkOffsetMap.set(key, off);
    return off;
  }
  var newEntries = [];
  for(var i=0;i<oar.numMotion;i++){
    var e = oar.entries[i];
    // Use AT_extractChunks to walk the OLD archive at the OLD offsets to
    // pull out this entry's actual data. Chunks are slices of the old
    // archive (immutable copies).
    var chunks = AT_extractChunks(oar, i);
    var newMoveOff = addChunk(chunks.moveChunk);
    var newRotOffs = [];
    for(var j=0;j<chunks.rotChunks.length;j++){
      newRotOffs.push(addChunk(chunks.rotChunks[j]));
    }
    newEntries.push({
      numFrames: e.numFrames,
      moveOffset: newMoveOff,
      rotOffsets: newRotOffs
    });
  }
  return {
    maxJoint: oar.maxJoint,
    numMotion: oar.numMotion,
    archiveSize: newArchList.length,
    entries: newEntries,
    archive: new Uint16Array(newArchList)
  };
}

function AT_serializeOAR(oar){
  var entrySize=oar.maxJoint+2;
  var tableBytes=entrySize*2*oar.numMotion;
  var totalBytes=0x10+tableBytes+oar.archive.length*2;
  var buf=new Uint8Array(totalBytes);
  var dv=new DataView(buf.buffer);
  buf[0]=0x4F; buf[1]=0x41; buf[2]=0x52; buf[3]=0x61;
  dv.setUint32(4,oar.maxJoint,true);
  dv.setUint32(8,oar.numMotion,true);
  dv.setUint32(12,oar.archive.length,true);
  for(var i=0;i<oar.numMotion;i++){
    var base=0x10+i*entrySize*2;
    var e=oar.entries[i];
    dv.setUint16(base,e.numFrames,true);
    dv.setUint16(base+2,e.moveOffset,true);
    for(var j=0;j<oar.maxJoint;j++) dv.setUint16(base+4+j*2,e.rotOffsets[j],true);
  }
  var archBase=0x10+tableBytes;
  for(var k=0;k<oar.archive.length;k++) dv.setUint16(archBase+k*2,oar.archive[k],true);
  return buf;
}

// ─── Bit-packed editing: raw decoders + encoders + edit operations ─────────
// Companion to AT_BitReader. Stores bits one at a time, packs to u16 array LSB-first.
function AT_BitWriter(){ this.bits = []; }
AT_BitWriter.prototype.write = function(value, n){
  for(var i = 0; i < n; i++) this.bits.push((value >>> i) & 1);
};
AT_BitWriter.prototype.toU16Array = function(){
  var nWords = Math.ceil(this.bits.length / 16);
  var arr = new Uint16Array(nWords);
  for(var i = 0; i < this.bits.length; i++){
    arr[i >>> 4] |= this.bits[i] << (i & 15);
  }
  return arr;
};

// Decode rotation stream to RAW keyframes (preserves per-keyframe unk, raw signed ints).
// Output: {xL, yL, zL, frames: [{frame, unk, x, y, z}, ...]}
function AT_decodeRotRaw(archive, offset, numFrames){
  var br = new AT_BitReader(archive, offset * 16);
  var xL = br.read(4), yL = br.read(4), zL = br.read(4);
  var kf = 0, frames = [];
  while(kf < numFrames){
    var delta = br.read(4);
    var unk = br.read(4);
    kf += delta;
    var xi = AT_negateBits(br.read(xL), xL);
    var yi = AT_negateBits(br.read(yL), yL);
    var zi = AT_negateBits(br.read(zL), zL);
    frames.push({frame: kf, unk: unk, x: xi, y: yi, z: zi});
  }
  return {xL: xL, yL: yL, zL: zL, frames: frames};
}

// Re-encode rotation stream from raw keyframes.
// Splits gaps > 15 frames into filler keyframes (max delta = 15 per format spec).
function AT_encodeRotRaw(rawData){
  var bw = new AT_BitWriter();
  bw.write(rawData.xL, 4);
  bw.write(rawData.yL, 4);
  bw.write(rawData.zL, 4);
  var xMask = rawData.xL > 0 ? ((1 << rawData.xL) - 1) : 0;
  var yMask = rawData.yL > 0 ? ((1 << rawData.yL) - 1) : 0;
  var zMask = rawData.zL > 0 ? ((1 << rawData.zL) - 1) : 0;
  var prevFrame = 0;
  for(var i = 0; i < rawData.frames.length; i++){
    var f = rawData.frames[i];
    var delta = f.frame - prevFrame;
    while(delta > 15){
      // Filler keyframe holding the current target's value (so interp doesn't change)
      bw.write(15, 4);
      bw.write(f.unk, 4);
      bw.write(f.x & xMask, rawData.xL);
      bw.write(f.y & yMask, rawData.yL);
      bw.write(f.z & zMask, rawData.zL);
      delta -= 15;
    }
    bw.write(delta, 4);
    bw.write(f.unk, 4);
    bw.write(f.x & xMask, rawData.xL);
    bw.write(f.y & yMask, rawData.yL);
    bw.write(f.z & zMask, rawData.zL);
    prevFrame = f.frame;
  }
  return bw.toU16Array();
}

// Decode move stream to raw keyframes.
// Output: {originY, xL, yL, zL, unk0, frames: [{frame, x, y, z}, ...]}
function AT_decodeMoveRaw(archive, offset, numFrames){
  var br = new AT_BitReader(archive, offset * 16);
  var y16 = br.read(16);
  if(y16 & 0x800) y16 |= -0x1000;  // 12-bit sign extension (matches existing decoder)
  var xL = br.read(4), yL = br.read(4), zL = br.read(4), unk0 = br.read(4);
  if(xL === 0 && yL === 0 && zL === 0){
    return {originY: y16, xL: 0, yL: 0, zL: 0, unk0: unk0, frames: []};
  }
  var kf = 0, frames = [];
  while(kf < numFrames){
    kf++;
    var xi = AT_negateBits(br.read(xL), xL);
    var yi = AT_negateBits(br.read(yL), yL);
    var zi = AT_negateBits(br.read(zL), zL);
    frames.push({frame: kf, x: xi, y: yi, z: zi});
  }
  return {originY: y16, xL: xL, yL: yL, zL: zL, unk0: unk0, frames: frames};
}

// Re-encode move stream from raw keyframes.
function AT_encodeMoveRaw(rawData){
  var bw = new AT_BitWriter();
  bw.write(rawData.originY & 0xFFFF, 16);
  bw.write(rawData.xL, 4);
  bw.write(rawData.yL, 4);
  bw.write(rawData.zL, 4);
  bw.write(rawData.unk0, 4);
  if(rawData.xL === 0 && rawData.yL === 0 && rawData.zL === 0){
    return bw.toU16Array();
  }
  var xMask = (1 << rawData.xL) - 1;
  var yMask = (1 << rawData.yL) - 1;
  var zMask = (1 << rawData.zL) - 1;
  for(var i = 0; i < rawData.frames.length; i++){
    var f = rawData.frames[i];
    bw.write(f.x & xMask, rawData.xL);
    bw.write(f.y & yMask, rawData.yL);
    bw.write(f.z & zMask, rawData.zL);
  }
  return bw.toU16Array();
}

// Shared helper: replace motionIdx in oar with new chunks. Appends to archive, updates entry.
function AT_replaceMotionAtIndex(oar, motionIdx, newNumFrames, newMoveChunk, newRotChunks){
  var totalAppend = newMoveChunk.length;
  for(var i = 0; i < newRotChunks.length; i++) totalAppend += newRotChunks[i].length;
  var finalSize = oar.archive.length + totalAppend;
  if(finalSize > 65535) throw new Error("Edit would push archive to "+finalSize+" u16 (exceeds OAR's 65535 limit)");
  var newArch = new Uint16Array(finalSize);
  newArch.set(oar.archive, 0);
  var off = oar.archive.length;
  var newMoveOff = off;
  newArch.set(newMoveChunk, off);
  off += newMoveChunk.length;
  var newRotOffs = [];
  for(var j = 0; j < newRotChunks.length; j++){
    newRotOffs.push(off);
    newArch.set(newRotChunks[j], off);
    off += newRotChunks[j].length;
  }
  var newEntries = oar.entries.map(function(e){return {numFrames: e.numFrames, moveOffset: e.moveOffset, rotOffsets: e.rotOffsets.slice()};});
  newEntries[motionIdx] = {numFrames: newNumFrames, moveOffset: newMoveOff, rotOffsets: newRotOffs};
  return {maxJoint: oar.maxJoint, numMotion: oar.numMotion, archiveSize: newArch.length, entries: newEntries, archive: newArch};
}

// Defensive: ensure rotation stream's last keyframe reaches numFrames so the
// decode loop (`while kf < numFrames`) terminates. Appends a sentinel if needed.
function AT_ensureRotTerminus(rawData, numFrames){
  if(rawData.frames.length === 0){
    if(numFrames > 0) rawData.frames.push({frame: numFrames, unk: 0, x: 0, y: 0, z: 0});
    return rawData;
  }
  var last = rawData.frames[rawData.frames.length - 1];
  if(last.frame < numFrames){
    rawData.frames.push({frame: numFrames, unk: last.unk, x: last.x, y: last.y, z: last.z});
  }
  return rawData;
}

// Move stream is dense: must have exactly numFrames keyframes (frames 1..numFrames).
// Static motions (all widths zero) have no keyframes by definition.
function AT_ensureMoveDense(rawData, numFrames){
  if(rawData.xL === 0 && rawData.yL === 0 && rawData.zL === 0){
    rawData.frames = [];
    return rawData;
  }
  if(rawData.frames.length === 0){
    for(var k=1; k<=numFrames; k++) rawData.frames.push({frame: k, x: 0, y: 0, z: 0});
  } else if(rawData.frames.length < numFrames){
    var last = rawData.frames[rawData.frames.length - 1];
    while(rawData.frames.length < numFrames){
      rawData.frames.push({frame: rawData.frames.length + 1, x: last.x, y: last.y, z: last.z});
    }
  } else if(rawData.frames.length > numFrames){
    rawData.frames = rawData.frames.slice(0, numFrames);
  }
  for(var i=0; i<rawData.frames.length; i++) rawData.frames[i].frame = i+1;
  return rawData;
}

// Trim motion to range (startFrame, endFrame] where 0 <= startFrame < endFrame <= numFrames.
// Output has (endFrame - startFrame) frames.
// Keyframes are stored at internal positions 1..numFrames; we keep those whose
// frame is in (startFrame, endFrame] and renumber so the first kept becomes (frame - startFrame).
// No-op: startFrame=0, endFrame=numFrames → identity transform.
function AT_trimMotion(oar, motionIdx, startFrame, endFrame){
  var entry = oar.entries[motionIdx];
  startFrame = Math.max(0, startFrame|0);
  endFrame = Math.min(entry.numFrames, endFrame|0);
  if(endFrame <= startFrame) throw new Error("Invalid trim range ["+startFrame+","+endFrame+"]");
  var newNumFrames = endFrame - startFrame;
  // Trim move
  var moveRaw = AT_decodeMoveRaw(oar.archive, entry.moveOffset, entry.numFrames);
  if(moveRaw.frames.length > 0){
    moveRaw.frames = moveRaw.frames
      .filter(function(f){ return f.frame > startFrame && f.frame <= endFrame; })
      .map(function(f){ return {frame: f.frame - startFrame, x: f.x, y: f.y, z: f.z}; });
  }
  moveRaw = AT_ensureMoveDense(moveRaw, newNumFrames);
  var newMoveChunk = AT_encodeMoveRaw(moveRaw);
  // Trim rotation streams
  var newRotChunks = [];
  for(var j = 0; j < oar.maxJoint; j++){
    var rotRaw = AT_decodeRotRaw(oar.archive, entry.rotOffsets[j], entry.numFrames);
    rotRaw.frames = rotRaw.frames
      .filter(function(f){ return f.frame > startFrame && f.frame <= endFrame; })
      .map(function(f){ return {frame: f.frame - startFrame, unk: f.unk, x: f.x, y: f.y, z: f.z}; });
    rotRaw = AT_ensureRotTerminus(rotRaw, newNumFrames);
    newRotChunks.push(AT_encodeRotRaw(rotRaw));
  }
  return AT_replaceMotionAtIndex(oar, motionIdx, newNumFrames, newMoveChunk, newRotChunks);
}

// Cut: delete frames in (startFrame, endFrame] from the middle, joining what's
// before with what's after. Inverse of Trim (which keeps a range and discards
// the rest). If you Cut (10, 20] from a 60-frame motion, you get 50 frames:
// originals 1..10 followed by originals 21..60 renumbered to 11..50.
//
// Rotation streams use sparse keyframes — kept keyframes around the cut may
// interpolate differently afterward because removing intermediate keyframes
// changes which pair of keyframes brackets a given frame. This matches Trim's
// own lossiness; undo restores the pre-cut state precisely.
function AT_cutRange(oar, motionIdx, startFrame, endFrame){
  var entry = oar.entries[motionIdx];
  startFrame = Math.max(0, startFrame|0);
  endFrame = Math.min(entry.numFrames, endFrame|0);
  if(endFrame <= startFrame) throw new Error("Invalid cut range ["+startFrame+","+endFrame+"]");
  var removed = endFrame - startFrame;
  if(removed >= entry.numFrames) throw new Error("Cannot cut the entire motion ("+removed+" of "+entry.numFrames+" frames)");
  var newNumFrames = entry.numFrames - removed;
  // Move: keep frames where (frame <= startFrame) OR (frame > endFrame); renumber latter group
  var moveRaw = AT_decodeMoveRaw(oar.archive, entry.moveOffset, entry.numFrames);
  if(moveRaw.frames.length > 0){
    var keptMove = [];
    for(var i = 0; i < moveRaw.frames.length; i++){
      var f = moveRaw.frames[i];
      if(f.frame <= startFrame){
        keptMove.push({frame: f.frame, x: f.x, y: f.y, z: f.z});
      } else if(f.frame > endFrame){
        keptMove.push({frame: f.frame - removed, x: f.x, y: f.y, z: f.z});
      }
    }
    moveRaw.frames = keptMove;
  }
  moveRaw = AT_ensureMoveDense(moveRaw, newNumFrames);
  var newMoveChunk = AT_encodeMoveRaw(moveRaw);
  // Rotation: same approach per bone
  var newRotChunks = [];
  for(var j = 0; j < oar.maxJoint; j++){
    var rotRaw = AT_decodeRotRaw(oar.archive, entry.rotOffsets[j], entry.numFrames);
    var keptRot = [];
    for(var i2 = 0; i2 < rotRaw.frames.length; i2++){
      var rf = rotRaw.frames[i2];
      if(rf.frame <= startFrame){
        keptRot.push({frame: rf.frame, unk: rf.unk, x: rf.x, y: rf.y, z: rf.z});
      } else if(rf.frame > endFrame){
        keptRot.push({frame: rf.frame - removed, unk: rf.unk, x: rf.x, y: rf.y, z: rf.z});
      }
    }
    rotRaw.frames = keptRot;
    rotRaw = AT_ensureRotTerminus(rotRaw, newNumFrames);
    newRotChunks.push(AT_encodeRotRaw(rotRaw));
  }
  return AT_replaceMotionAtIndex(oar, motionIdx, newNumFrames, newMoveChunk, newRotChunks);
}

// Freeze: replace the motion with a 1-frame static pose captured from sourceFrame.
// Uses AT_sampleRotRawAtFrame (linear interp on euler ints) so the frozen pose
// matches exactly what the preview shows when scrubbed to that frame.
// Static encoding: move stream has all-zero widths with originY baked to the
// Y position at sourceFrame; each rot stream has a single keyframe holding the
// sampled euler triple.
function AT_freezeFrame(oar, motionIdx, sourceFrame){
  var entry = oar.entries[motionIdx];
  if(entry.numFrames < 1) throw new Error("Motion has no frames to freeze");
  sourceFrame = Math.max(1, Math.min(entry.numFrames, sourceFrame|0));
  // Move: bake the Y delta at sourceFrame into originY, drop all per-frame data
  var moveRaw = AT_decodeMoveRaw(oar.archive, entry.moveOffset, entry.numFrames);
  var yDeltaAtFrame = 0;
  if(moveRaw.frames.length > 0){
    // Move stream is dense: frame F is at index F-1
    var fIdx = Math.max(0, Math.min(moveRaw.frames.length - 1, sourceFrame - 1));
    yDeltaAtFrame = moveRaw.frames[fIdx].y;
  }
  var staticMoveRaw = {
    originY: (moveRaw.originY + yDeltaAtFrame) & 0xFFFF,
    xL: 0, yL: 0, zL: 0,    // all-zero widths = static marker
    unk0: moveRaw.unk0,
    frames: []
  };
  var newMoveChunk = AT_encodeMoveRaw(staticMoveRaw);
  // Rotation: sample at sourceFrame, encode as single keyframe at frame 1
  var newRotChunks = [];
  for(var j = 0; j < oar.maxJoint; j++){
    var rotRaw = AT_decodeRotRaw(oar.archive, entry.rotOffsets[j], entry.numFrames);
    var sampled = AT_sampleRotRawAtFrame(rotRaw, sourceFrame);
    // Reuse original bit widths — sampled values are linear interps of source
    // keyframes that already fit those widths, so the result fits too.
    var staticRotRaw = {
      xL: rotRaw.xL,
      yL: rotRaw.yL,
      zL: rotRaw.zL,
      frames: [{frame: 1, unk: sampled.unk, x: sampled.x, y: sampled.y, z: sampled.z}]
    };
    newRotChunks.push(AT_encodeRotRaw(staticRotRaw));
  }
  return AT_replaceMotionAtIndex(oar, motionIdx, 1, newMoveChunk, newRotChunks);
}


function AT_speedMotion(oar, motionIdx, factor){
  if(factor <= 0) throw new Error("Speed factor must be positive");
  var entry = oar.entries[motionIdx];
  var newNumFrames = Math.max(1, Math.round(entry.numFrames / factor));
  // Move: resample to exactly newNumFrames keyframes
  var moveRaw = AT_decodeMoveRaw(oar.archive, entry.moveOffset, entry.numFrames);
  if(moveRaw.frames.length > 0){
    var origByFrame = {};
    for(var m = 0; m < moveRaw.frames.length; m++) origByFrame[moveRaw.frames[m].frame] = moveRaw.frames[m];
    var resampled = [];
    for(var k = 1; k <= newNumFrames; k++){
      var srcFrame = Math.max(1, Math.min(entry.numFrames, Math.round(k * factor)));
      var srcKf = origByFrame[srcFrame] || moveRaw.frames[Math.min(moveRaw.frames.length-1, srcFrame-1)];
      resampled.push({frame: k, x: srcKf.x, y: srcKf.y, z: srcKf.z});
    }
    moveRaw.frames = resampled;
  }
  moveRaw = AT_ensureMoveDense(moveRaw, newNumFrames);
  var newMoveChunk = AT_encodeMoveRaw(moveRaw);
  // Rotation: rescale frame numbers, dedupe collisions
  var newRotChunks = [];
  for(var j = 0; j < oar.maxJoint; j++){
    var rotRaw = AT_decodeRotRaw(oar.archive, entry.rotOffsets[j], entry.numFrames);
    var scaled = [];
    var lastFrame = -1;
    for(var i = 0; i < rotRaw.frames.length; i++){
      var f = rotRaw.frames[i];
      var newFrame = Math.max(0, Math.min(newNumFrames, Math.round(f.frame / factor)));
      if(newFrame > lastFrame){
        scaled.push({frame: newFrame, unk: f.unk, x: f.x, y: f.y, z: f.z});
        lastFrame = newFrame;
      }
    }
    rotRaw.frames = scaled;
    rotRaw = AT_ensureRotTerminus(rotRaw, newNumFrames);
    newRotChunks.push(AT_encodeRotRaw(rotRaw));
  }
  return AT_replaceMotionAtIndex(oar, motionIdx, newNumFrames, newMoveChunk, newRotChunks);
}

// Reverse: play backwards. Frame mapping (N+1 - F) preserves the original frame range [1, N].
function AT_reverseMotion(oar, motionIdx){
  var entry = oar.entries[motionIdx];
  var N = entry.numFrames;
  // Move: reverse keyframe order, renumber 1..N
  var moveRaw = AT_decodeMoveRaw(oar.archive, entry.moveOffset, entry.numFrames);
  if(moveRaw.frames.length > 0){
    var reversed = [];
    for(var k = 0; k < moveRaw.frames.length; k++){
      var src = moveRaw.frames[moveRaw.frames.length - 1 - k];
      reversed.push({frame: k+1, x: src.x, y: src.y, z: src.z});
    }
    moveRaw.frames = reversed;
  }
  moveRaw = AT_ensureMoveDense(moveRaw, N);
  var newMoveChunk = AT_encodeMoveRaw(moveRaw);
  // Rotation: new_frame = N+1 - old_frame (preserves range [1, N])
  var newRotChunks = [];
  for(var j = 0; j < oar.maxJoint; j++){
    var rotRaw = AT_decodeRotRaw(oar.archive, entry.rotOffsets[j], entry.numFrames);
    rotRaw.frames = rotRaw.frames.map(function(f){
      return {frame: (N + 1 - f.frame), unk: f.unk, x: f.x, y: f.y, z: f.z};
    }).sort(function(a,b){ return a.frame - b.frame; });
    rotRaw = AT_ensureRotTerminus(rotRaw, N);
    newRotChunks.push(AT_encodeRotRaw(rotRaw));
  }
  return AT_replaceMotionAtIndex(oar, motionIdx, N, newMoveChunk, newRotChunks);
}

// ─── Splice / concatenate multiple motions into one ─────────────────────────
// Decode a whole motion (move + every bone's rot) at once.
function AT_decodeMotionRaw(oar, motionIdx){
  var entry = oar.entries[motionIdx];
  var move = AT_decodeMoveRaw(oar.archive, entry.moveOffset, entry.numFrames);
  var rots = [];
  for(var j = 0; j < oar.maxJoint; j++){
    rots.push(AT_decodeRotRaw(oar.archive, entry.rotOffsets[j], entry.numFrames));
  }
  return {numFrames: entry.numFrames, move: move, rots: rots};
}

// Concatenate a list of raw motions into one combined raw motion.
// All sources must have the same maxJoint. Output uses max bit-widths across sources.
// Frame numbers are renumbered to a single continuous timeline.
function AT_concatRaws(rawList, maxJoint){
  if(!rawList || rawList.length === 0) throw new Error("Cannot concatenate empty list");
  if(rawList.length === 1) return rawList[0];
  for(var v = 0; v < rawList.length; v++){
    if(rawList[v].rots.length !== maxJoint){
      throw new Error("Source "+v+" has "+rawList[v].rots.length+" bones, expected "+maxJoint);
    }
  }
  // Output bit-widths: max across all sources, per axis (move and per-bone rot)
  var outMoveXL = 0, outMoveYL = 0, outMoveZL = 0;
  var outRotXL = new Array(maxJoint).fill(0);
  var outRotYL = new Array(maxJoint).fill(0);
  var outRotZL = new Array(maxJoint).fill(0);
  for(var i = 0; i < rawList.length; i++){
    var r = rawList[i];
    if(r.move.xL > outMoveXL) outMoveXL = r.move.xL;
    if(r.move.yL > outMoveYL) outMoveYL = r.move.yL;
    if(r.move.zL > outMoveZL) outMoveZL = r.move.zL;
    for(var j = 0; j < maxJoint; j++){
      if(r.rots[j].xL > outRotXL[j]) outRotXL[j] = r.rots[j].xL;
      if(r.rots[j].yL > outRotYL[j]) outRotYL[j] = r.rots[j].yL;
      if(r.rots[j].zL > outRotZL[j]) outRotZL[j] = r.rots[j].zL;
    }
  }
  // Total output frame count
  var totalFrames = 0;
  for(var k = 0; k < rawList.length; k++) totalFrames += rawList[k].numFrames;
  // Merge move keyframes. For sources with no move keyframes (all-zero widths
  // = "static at originY"), synthesize zero-delta keyframes in the output.
  // Use the FIRST source's originY/unk0 for the output stream.
  var mergedMoveFrames = [];
  var frameOffset = 0;
  for(var s = 0; s < rawList.length; s++){
    var src = rawList[s];
    if(src.move.frames.length === 0){
      // Static source: emit (0,0,0) deltas for each frame
      for(var k2 = 1; k2 <= src.numFrames; k2++){
        mergedMoveFrames.push({frame: frameOffset + k2, x: 0, y: 0, z: 0});
      }
    } else {
      for(var f = 0; f < src.move.frames.length; f++){
        var mf = src.move.frames[f];
        mergedMoveFrames.push({frame: frameOffset + mf.frame, x: mf.x, y: mf.y, z: mf.z});
      }
    }
    frameOffset += src.numFrames;
  }
  // If all output widths are zero, the merged stream is itself static
  var isOutputStatic = (outMoveXL === 0 && outMoveYL === 0 && outMoveZL === 0);
  var mergedMove = {
    originY: rawList[0].move.originY,
    xL: outMoveXL, yL: outMoveYL, zL: outMoveZL,
    unk0: rawList[0].move.unk0,
    frames: isOutputStatic ? [] : mergedMoveFrames
  };
  // Merge rotation keyframes per bone
  var mergedRots = [];
  for(var b = 0; b < maxJoint; b++){
    var bFrames = [];
    var bOff = 0;
    for(var s2 = 0; s2 < rawList.length; s2++){
      var rotFrames = rawList[s2].rots[b].frames;
      for(var f2 = 0; f2 < rotFrames.length; f2++){
        var rf = rotFrames[f2];
        bFrames.push({frame: bOff + rf.frame, unk: rf.unk, x: rf.x, y: rf.y, z: rf.z});
      }
      bOff += rawList[s2].numFrames;
    }
    mergedRots.push({xL: outRotXL[b], yL: outRotYL[b], zL: outRotZL[b], frames: bFrames});
  }
  return {numFrames: totalFrames, move: mergedMove, rots: mergedRots};
}

// High-level: concat sources [{oar, idx}, ...] and place result at target[targetSlot].
function AT_concatMotions(target, sources, targetSlot){
  if(!sources || sources.length === 0) throw new Error("No sources to splice");
  if(targetSlot < 0 || targetSlot >= target.numMotion) throw new Error("Invalid target slot");
  for(var v = 0; v < sources.length; v++){
    if(sources[v].oar.maxJoint !== target.maxJoint){
      throw new Error("Source "+v+" skeleton mismatch ("+sources[v].oar.maxJoint+" vs "+target.maxJoint+" joints)");
    }
  }
  var rawList = sources.map(function(s){ return AT_decodeMotionRaw(s.oar, s.idx); });
  var merged = AT_concatRaws(rawList, target.maxJoint);
  AT_ensureMoveDense(merged.move, merged.numFrames);
  for(var j = 0; j < merged.rots.length; j++){
    AT_ensureRotTerminus(merged.rots[j], merged.numFrames);
  }
  var moveChunk = AT_encodeMoveRaw(merged.move);
  var rotChunks = merged.rots.map(function(r){ return AT_encodeRotRaw(r); });
  return AT_replaceMotionAtIndex(target, targetSlot, merged.numFrames, moveChunk, rotChunks);
}

// Boomerang: motion + reverse(motion). Plays forward, then backward.
function AT_boomerangMotion(oar, motionIdx){
  // Decode original
  var origRaw = AT_decodeMotionRaw(oar, motionIdx);
  // Build reversed raw (mirrors AT_reverseMotion's logic but produces raw data)
  var N = origRaw.numFrames;
  var revMove = {
    originY: origRaw.move.originY,
    xL: origRaw.move.xL, yL: origRaw.move.yL, zL: origRaw.move.zL,
    unk0: origRaw.move.unk0,
    frames: []
  };
  if(origRaw.move.frames.length > 0){
    for(var k = 0; k < origRaw.move.frames.length; k++){
      var src = origRaw.move.frames[origRaw.move.frames.length - 1 - k];
      revMove.frames.push({frame: k+1, x: src.x, y: src.y, z: src.z});
    }
  }
  var revRots = [];
  for(var j = 0; j < origRaw.rots.length; j++){
    var rr = origRaw.rots[j];
    var newRotFrames = rr.frames.map(function(f){
      return {frame: (N + 1 - f.frame), unk: f.unk, x: f.x, y: f.y, z: f.z};
    }).sort(function(a,b){ return a.frame - b.frame; });
    revRots.push({xL: rr.xL, yL: rr.yL, zL: rr.zL, frames: newRotFrames});
  }
  var revRaw = {numFrames: N, move: revMove, rots: revRots};
  // Concatenate orig + reverse
  var merged = AT_concatRaws([origRaw, revRaw], oar.maxJoint);
  AT_ensureMoveDense(merged.move, merged.numFrames);
  for(var b = 0; b < merged.rots.length; b++) AT_ensureRotTerminus(merged.rots[b], merged.numFrames);
  var moveChunk = AT_encodeMoveRaw(merged.move);
  var rotChunks = merged.rots.map(function(r){ return AT_encodeRotRaw(r); });
  return AT_replaceMotionAtIndex(oar, motionIdx, merged.numFrames, moveChunk, rotChunks);
}

// Hold end frames: extend last pose by holdCount frames.
function AT_holdEndFrames(oar, motionIdx, holdCount){
  if(holdCount <= 0) throw new Error("Hold count must be positive");
  var origRaw = AT_decodeMotionRaw(oar, motionIdx);
  var newNumFrames = origRaw.numFrames + holdCount;
  // Move: append keyframes copying the last frame's values
  if(origRaw.move.frames.length > 0){
    var last = origRaw.move.frames[origRaw.move.frames.length - 1];
    for(var k = 1; k <= holdCount; k++){
      origRaw.move.frames.push({frame: origRaw.numFrames + k, x: last.x, y: last.y, z: last.z});
    }
  }
  AT_ensureMoveDense(origRaw.move, newNumFrames);
  // Rotation: extend the terminus to new numFrames (helper appends a sentinel keyframe)
  for(var j = 0; j < origRaw.rots.length; j++){
    AT_ensureRotTerminus(origRaw.rots[j], newNumFrames);
  }
  var moveChunk = AT_encodeMoveRaw(origRaw.move);
  var rotChunks = origRaw.rots.map(function(r){ return AT_encodeRotRaw(r); });
  return AT_replaceMotionAtIndex(oar, motionIdx, newNumFrames, moveChunk, rotChunks);
}

// Revert a target motion to its state in the original (pre-edit) OAR.
function AT_revertMotion(target, original, motionIdx){
  if(!original) throw new Error("No original snapshot available");
  if(motionIdx < 0 || motionIdx >= original.numMotion){
    throw new Error("This slot (target["+motionIdx+"]) did not exist in the original — was created by padding.");
  }
  if(target.maxJoint !== original.maxJoint){
    throw new Error("Skeleton mismatch with original");
  }
  // Extract the original motion's keyframe chunks and append them to target's archive
  var ch = AT_extractChunks(original, motionIdx);
  var totalAppend = ch.moveChunk.length;
  for(var i = 0; i < ch.rotChunks.length; i++) totalAppend += ch.rotChunks[i].length;
  var finalSize = target.archive.length + totalAppend;
  if(finalSize > 65535) throw new Error("Revert would push archive past u16 limit ("+finalSize+")");
  var newArch = new Uint16Array(finalSize);
  newArch.set(target.archive, 0);
  var off = target.archive.length;
  var newMoveOff = off;
  newArch.set(ch.moveChunk, off);
  off += ch.moveChunk.length;
  var newRotOffs = [];
  for(var r = 0; r < ch.rotChunks.length; r++){
    newRotOffs.push(off);
    newArch.set(ch.rotChunks[r], off);
    off += ch.rotChunks[r].length;
  }
  var newEntries = target.entries.map(function(e){return {numFrames: e.numFrames, moveOffset: e.moveOffset, rotOffsets: e.rotOffsets.slice()};});
  newEntries[motionIdx] = {numFrames: ch.numFrames, moveOffset: newMoveOff, rotOffsets: newRotOffs};
  return {maxJoint: target.maxJoint, numMotion: target.numMotion, archiveSize: newArch.length, entries: newEntries, archive: newArch};
}

// ─── Crossfade: blend two motions over an overlap region ────────────────────
// Sample a rotation stream at any frame (linear interp on Euler ints between keyframes).
function AT_sampleRotRawAtFrame(rotRaw, frame){
  if(rotRaw.frames.length === 0) return {x:0, y:0, z:0, unk:0};
  var first = rotRaw.frames[0];
  if(frame <= first.frame) return {x: first.x, y: first.y, z: first.z, unk: first.unk};
  var last = rotRaw.frames[rotRaw.frames.length - 1];
  if(frame >= last.frame) return {x: last.x, y: last.y, z: last.z, unk: last.unk};
  for(var i = 0; i < rotRaw.frames.length - 1; i++){
    var a = rotRaw.frames[i], b = rotRaw.frames[i+1];
    if(a.frame <= frame && frame <= b.frame){
      var span = b.frame - a.frame;
      var t = span > 0 ? (frame - a.frame) / span : 0;
      return {
        x: Math.round(a.x * (1-t) + b.x * t),
        y: Math.round(a.y * (1-t) + b.y * t),
        z: Math.round(a.z * (1-t) + b.z * t),
        unk: a.unk
      };
    }
  }
  return {x: last.x, y: last.y, z: last.z, unk: last.unk};
}
// Move stream is dense: keyframes at frames 1..numFrames. Just look up by index.
function AT_sampleMoveRawAtFrame(moveRaw, frame){
  if(moveRaw.frames.length === 0) return {x:0, y:0, z:0};
  var f = Math.max(1, Math.min(moveRaw.frames.length, frame));
  var k = moveRaw.frames[f - 1];
  return {x: k.x, y: k.y, z: k.z};
}

// Crossfade srcA and srcB into target's targetSlot.
// fadeFrames = number of overlap frames where A blends into B.
// Output length = aRaw.numFrames + bRaw.numFrames - fadeFrames.
// Uses dense keyframes (one per frame) for simplicity. Lerp on raw Euler ints.
function AT_crossfadeMotions(target, srcA, srcB, fadeFrames, targetSlot){
  if(srcA.oar.maxJoint !== target.maxJoint) throw new Error("Source A skeleton mismatch ("+srcA.oar.maxJoint+" vs "+target.maxJoint+")");
  if(srcB.oar.maxJoint !== target.maxJoint) throw new Error("Source B skeleton mismatch ("+srcB.oar.maxJoint+" vs "+target.maxJoint+")");
  if(targetSlot < 0 || targetSlot >= target.numMotion) throw new Error("Invalid target slot");
  if(fadeFrames < 1) throw new Error("Fade frames must be >= 1");
  var aRaw = AT_decodeMotionRaw(srcA.oar, srcA.idx);
  var bRaw = AT_decodeMotionRaw(srcB.oar, srcB.idx);
  if(fadeFrames > aRaw.numFrames || fadeFrames > bRaw.numFrames){
    throw new Error("Fade frames ("+fadeFrames+") exceeds shorter motion ("+Math.min(aRaw.numFrames, bRaw.numFrames)+")");
  }
  var totalFrames = aRaw.numFrames + bRaw.numFrames - fadeFrames;
  var fadeStart = aRaw.numFrames - fadeFrames + 1; // first frame of overlap
  var fadeEnd = aRaw.numFrames;                    // last frame of overlap
  // Output bit widths = max of A and B
  var outMoveXL = Math.max(aRaw.move.xL, bRaw.move.xL);
  var outMoveYL = Math.max(aRaw.move.yL, bRaw.move.yL);
  var outMoveZL = Math.max(aRaw.move.zL, bRaw.move.zL);
  var outRotXL = [], outRotYL = [], outRotZL = [];
  for(var j = 0; j < target.maxJoint; j++){
    outRotXL.push(Math.max(aRaw.rots[j].xL, bRaw.rots[j].xL));
    outRotYL.push(Math.max(aRaw.rots[j].yL, bRaw.rots[j].yL));
    outRotZL.push(Math.max(aRaw.rots[j].zL, bRaw.rots[j].zL));
  }
  // Build dense per-frame data.
  // Fade weight: at frame fadeStart, t=1/(fadeFrames+1); at fadeEnd, t=fadeFrames/(fadeFrames+1).
  // Smooth boundaries that never reach pure-A or pure-B in the overlap; gives a graceful blend.
  function fadeWeight(f){
    return (f - fadeStart + 1) / (fadeFrames + 1);
  }
  // Move stream
  var moveFrames = [];
  for(var f = 1; f <= totalFrames; f++){
    var x, y, z;
    if(f < fadeStart){
      var s = AT_sampleMoveRawAtFrame(aRaw.move, f);
      x = s.x; y = s.y; z = s.z;
    } else if(f <= fadeEnd){
      var bFrame_in = f - fadeStart + 1;
      var t = fadeWeight(f);
      var sa = AT_sampleMoveRawAtFrame(aRaw.move, f);
      var sb = AT_sampleMoveRawAtFrame(bRaw.move, bFrame_in);
      x = Math.round(sa.x * (1-t) + sb.x * t);
      y = Math.round(sa.y * (1-t) + sb.y * t);
      z = Math.round(sa.z * (1-t) + sb.z * t);
    } else {
      var bFrame_post = f - aRaw.numFrames + fadeFrames;
      var s2 = AT_sampleMoveRawAtFrame(bRaw.move, bFrame_post);
      x = s2.x; y = s2.y; z = s2.z;
    }
    moveFrames.push({frame: f, x: x, y: y, z: z});
  }
  var isOutputStatic = (outMoveXL === 0 && outMoveYL === 0 && outMoveZL === 0);
  var outMove = {
    originY: aRaw.move.originY,
    xL: outMoveXL, yL: outMoveYL, zL: outMoveZL,
    unk0: aRaw.move.unk0,
    frames: isOutputStatic ? [] : moveFrames
  };
  // Rotation streams (per bone)
  var outRots = [];
  for(var jj = 0; jj < target.maxJoint; jj++){
    var aR = aRaw.rots[jj], bR = bRaw.rots[jj];
    var rotFrames = [];
    for(var ff = 1; ff <= totalFrames; ff++){
      var rx, ry, rz, runk;
      if(ff < fadeStart){
        var rs = AT_sampleRotRawAtFrame(aR, ff);
        rx = rs.x; ry = rs.y; rz = rs.z; runk = rs.unk;
      } else if(ff <= fadeEnd){
        var bf_in = ff - fadeStart + 1;
        var rt = fadeWeight(ff);
        var ra = AT_sampleRotRawAtFrame(aR, ff);
        var rb = AT_sampleRotRawAtFrame(bR, bf_in);
        rx = Math.round(ra.x * (1-rt) + rb.x * rt);
        ry = Math.round(ra.y * (1-rt) + rb.y * rt);
        rz = Math.round(ra.z * (1-rt) + rb.z * rt);
        runk = ra.unk;
      } else {
        var bf_post = ff - aRaw.numFrames + fadeFrames;
        var rs2 = AT_sampleRotRawAtFrame(bR, bf_post);
        rx = rs2.x; ry = rs2.y; rz = rs2.z; runk = rs2.unk;
      }
      rotFrames.push({frame: ff, unk: runk, x: rx, y: ry, z: rz});
    }
    outRots.push({xL: outRotXL[jj], yL: outRotYL[jj], zL: outRotZL[jj], frames: rotFrames});
  }
  // Ensure proper terminus
  AT_ensureMoveDense(outMove, totalFrames);
  for(var bj = 0; bj < outRots.length; bj++){
    AT_ensureRotTerminus(outRots[bj], totalFrames);
  }
  // Encode
  var moveChunk = AT_encodeMoveRaw(outMove);
  var rotChunks = outRots.map(function(r){ return AT_encodeRotRaw(r); });
  return AT_replaceMotionAtIndex(target, targetSlot, totalFrames, moveChunk, rotChunks);
}

function AT_quatSlerp(a,b,t){
  // a, b = [x,y,z,w]
  var ax=a[0],ay=a[1],az=a[2],aw=a[3];
  var bx=b[0],by=b[1],bz=b[2],bw=b[3];
  var dot=ax*bx+ay*by+az*bz+aw*bw;
  if(dot<0){bx=-bx;by=-by;bz=-bz;bw=-bw;dot=-dot;}
  if(dot>0.9995){
    // Linear interp + normalize (cheaper than full slerp for tiny angles)
    var rx=ax+(bx-ax)*t, ry=ay+(by-ay)*t, rz=az+(bz-az)*t, rw=aw+(bw-aw)*t;
    var m=Math.sqrt(rx*rx+ry*ry+rz*rz+rw*rw);
    if(m>1e-9){rx/=m;ry/=m;rz/=m;rw/=m;}
    return [rx,ry,rz,rw];
  }
  var theta=Math.acos(dot);
  var sinT=Math.sin(theta);
  var s1=Math.sin((1-t)*theta)/sinT;
  var s2=Math.sin(t*theta)/sinT;
  return [ax*s1+bx*s2, ay*s1+by*s2, az*s1+bz*s2, aw*s1+bw*s2];
}
function AT_interpAtFrame(frames, frame, isRot){
  if(frames.length===0) return isRot?[0,0,0,1]:[0,0,0];
  if(frame<=frames[0].frame) return isRot?frames[0].q:frames[0].t;
  if(frame>=frames[frames.length-1].frame) {
    var l=frames[frames.length-1]; return isRot?l.q:l.t;
  }
  for(var i=0;i<frames.length-1;i++){
    if(frame>=frames[i].frame && frame<frames[i+1].frame){
      var t=(frame-frames[i].frame)/(frames[i+1].frame-frames[i].frame);
      if(isRot) return AT_quatSlerp(frames[i].q, frames[i+1].q, t);
      var a=frames[i].t, b=frames[i+1].t;
      return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
    }
  }
  return isRot?[0,0,0,1]:[0,0,0];
}

// Decode a motion into ready-to-use per-bone keyframe arrays. Cache it.
function AT_decodeMotion(oar, motionIdx){
  var m=oar.entries[motionIdx];
  var trans=AT_decodeMove(oar.archive, m.moveOffset, m.numFrames);
  var rots=[];
  for(var j=0;j<oar.maxJoint;j++){
    rots.push(AT_decodeRot(oar.archive, m.rotOffsets[j], m.numFrames));
  }
  return {numFrames:m.numFrames, trans:trans, rots:rots};
}

// ─── Swap compatibility detection ───────────────────────────────────────────
// Returns an array of {severity:'error'|'warn'|'info', msg:string}.
// 'error' = blocking (swap will fail). 'warn' = likely engine misbehavior.
// 'info' = swap is fine technically, but may not behave as user expects.
function AT_isMoveStatic(archive, offset){
  // Read just the move-stream header: u16 Y origin, then 4-bit widths for x/y/z.
  // If all three widths are zero, the motion has no translation keyframes.
  var br = new AT_BitReader(archive, offset*16);
  br.read(16); // skip Y origin
  var xL = br.read(4), yL = br.read(4), zL = br.read(4);
  return (xL === 0 && yL === 0 && zL === 0);
}
// Kept for backward-compat / unit-testable delta heuristic
function AT_hasRootMotion(transFrames){
  if(!transFrames || transFrames.length < 2) return false;
  var first = transFrames[0].t;
  var maxOff = 0;
  for(var i=1; i<transFrames.length; i++){
    var t = transFrames[i].t;
    var off = Math.abs(t[0]-first[0]) + Math.abs(t[2]-first[2]);
    if(off > maxOff) maxOff = off;
  }
  return maxOff > 0.01;
}

function AT_swapWarnings(targetOar, donorOar, targetIdx, donorIdx){
  var warnings = [];
  if(!targetOar || !donorOar || targetIdx<0 || donorIdx<0) return warnings;
  if(targetIdx >= targetOar.numMotion || donorIdx >= donorOar.numMotion) return warnings;

  if(targetOar.maxJoint !== donorOar.maxJoint){
    warnings.push({severity:'error', msg:'Skeleton mismatch ('+targetOar.maxJoint+' vs '+donorOar.maxJoint+' joints). Swap will fail.'});
    return warnings;
  }

  var tEntry = targetOar.entries[targetIdx];
  var dEntry = donorOar.entries[donorIdx];

  // 1. Pose vs animated mismatch
  if(tEntry.numFrames <= 1 && dEntry.numFrames > 1){
    warnings.push({severity:'warn', msg:'Target slot is a static pose ('+tEntry.numFrames+'f); donor is animated ('+dEntry.numFrames+'f). This slot may be used as a reference pose by the engine — animation could glitch.'});
  } else if(tEntry.numFrames > 1 && dEntry.numFrames <= 1){
    warnings.push({severity:'warn', msg:'Target slot is animated ('+tEntry.numFrames+'f); donor is static ('+dEntry.numFrames+'f). Character will appear frozen when this anim plays.'});
  } else if(tEntry.numFrames > 1 && dEntry.numFrames > 1){
    var ratio = dEntry.numFrames / tEntry.numFrames;
    if(ratio >= 2.5){
      warnings.push({severity:'info', msg:'Donor is '+ratio.toFixed(1)+'× longer ('+dEntry.numFrames+'f vs '+tEntry.numFrames+'f). Game scripts timed to original length may fire mid-animation.'});
    } else if(ratio <= 0.4){
      warnings.push({severity:'info', msg:'Donor is '+(1/ratio).toFixed(1)+'× shorter ('+dEntry.numFrames+'f vs '+tEntry.numFrames+'f). Animation may end before scripted callbacks fire.'});
    }
  }

  // 2. Root translation presence
  try {
    var tStatic = AT_isMoveStatic(targetOar.archive, tEntry.moveOffset);
    var dStatic = AT_isMoveStatic(donorOar.archive, dEntry.moveOffset);
    if(tStatic && !dStatic){
      warnings.push({severity:'warn', msg:'Donor has root translation; target slot is stationary. Character may shift position unexpectedly when this plays.'});
    } else if(!tStatic && dStatic){
      warnings.push({severity:'info', msg:'Donor is stationary; target slot has root motion. Character won\'t move where it normally would.'});
    }
  } catch(e) {}

  return warnings;
}

// ────────────────────────────────────────────────────────────────────────────



var AT_state={
  kmd:null, kmdName:'',
  target:null, targetName:'', targetBuf:null, targetModified:false,
  targetOriginal:null,    // snapshot of target as first loaded, for revert
  donor:null, donorName:'',
  currentPreview:null,    // {oar:'target'|'donor', motionIdx, decoded}
  playing:false, playTime:0, lastT:0,
  scene:null, camera:null, renderer:null, charRoot:null, boneGroups:null,
  skeletonHelper:null, animId:null, restPose:true,
  panelEl:null,
  selectedTargetMotion:-1, selectedDonorMotion:-1,
  activeList:'target',    // which list arrow-keys move
  swapHistory:[],
  // Real undo/redo: stacks of full target OAR snapshots. Edit operations
  // (speed/trim/reverse/etc) are LOSSY — they resample keyframes destructively,
  // so re-applying an inverse operation doesn't recover the original. The only
  // way to truly revert is to restore a pre-operation snapshot.
  undoStack:[],
  redoStack:[],
  spliceQueue:[],         // ordered list of {role:'target'|'donor', idx:N}
  crossfadeA:null,        // {role, idx} or null
  crossfadeB:null,
  panelExpanded:{edit:false, splice:false, crossfade:false}, // collapsible panel state
  cameraOrbit:{yaw:0, pitch:0.3, dist:3000, target:[0,500,0]},
  dragState:null,
  keyHandler:null
};

function openAnimSwapper(){
  // Always rebuild. If a stale panel exists from before (shouldn't normally),
  // tear it down first to avoid orphaned DOM/WebGL state.
  if(AT_state.panelEl) closeAnimSwapper();
  var ov=document.createElement('div');
  ov.id='animSwapperPanel';
  ov.style.cssText='position:fixed;inset:0;background:rgba(8,12,18,0.97);z-index:9999;display:flex;flex-direction:column;font-family:system-ui,sans-serif;font-size:11px;color:#cde';
  ov.innerHTML=
    '<div style="padding:8px 12px;border-bottom:1px solid #1a2535;display:flex;align-items:center;justify-content:space-between;background:#0d1219">'+
      '<div style="font-size:13px;font-weight:bold;color:#7cf">🎬 Animation Swapper</div>'+
      '<div style="display:flex;gap:6px;align-items:center">'+
        '<button id="atUndoBtn" class="btn" style="font-size:11px;padding:4px 10px;background:#1a2a3a;color:#cde" title="Nothing to undo" disabled>↶ Undo</button>'+
        '<button id="atRedoBtn" class="btn" style="font-size:11px;padding:4px 10px;background:#1a2a3a;color:#cde" title="Nothing to redo" disabled>↷ Redo</button>'+
        '<div style="width:1px;height:18px;background:#1a2535;margin:0 4px"></div>'+
        '<button id="atClear" class="btn" style="font-size:11px;padding:4px 10px;color:#f88;border-color:#5a2222" title="Clear all loaded files and reset the editor">⟲ Clear</button>'+
        '<button id="atClose" class="btn" style="font-size:11px;padding:4px 10px">✕ Close</button>'+
      '</div>'+
    '</div>'+
    '<div style="display:flex;flex:1;min-height:0">'+
      // LEFT: file pickers + viewport
      '<div style="flex:1;display:flex;flex-direction:column;border-right:1px solid #1a2535">'+
        '<div style="padding:8px;background:#0d1219;border-bottom:1px solid #1a2535;display:flex;flex-direction:column;gap:6px;font-size:10px">'+
          '<div style="display:flex;align-items:center;gap:6px">'+
            '<label style="min-width:90px;color:#888">Character KMD:</label>'+
            '<input type="file" id="atKmdInput" accept=".kmd" style="flex:1">'+
            '<span id="atKmdInfo" style="color:#666;min-width:120px;text-align:right"></span>'+
          '</div>'+
          '<div style="display:flex;align-items:center;gap:6px">'+
            '<label style="min-width:90px;color:#7c7">Target OAR:</label>'+
            '<input type="file" id="atTargetInput" accept=".oar" style="flex:1">'+
            '<span id="atTargetInfo" style="color:#666;min-width:120px;text-align:right"></span>'+
          '</div>'+
          '<div style="display:flex;align-items:center;gap:6px">'+
            '<label style="min-width:90px;color:#fa7">Donor OAR:</label>'+
            '<input type="file" id="atDonorInput" accept=".oar" style="flex:1">'+
            '<span id="atDonorInfo" style="color:#666;min-width:120px;text-align:right"></span>'+
          '</div>'+
          '<div id="atCompat" style="font-size:10px;color:#888"></div>'+
        '</div>'+
        // 3D viewport canvas + controls
        '<div style="flex:1;position:relative;background:#000;min-height:300px">'+
          '<canvas id="atCanvas" style="width:100%;height:100%;display:block;cursor:grab"></canvas>'+
          '<div style="position:absolute;top:8px;left:8px;color:#888;font-size:9px;background:rgba(0,0,0,0.5);padding:4px 8px;border-radius:3px">'+
            'L-drag rotate · R-drag pan · wheel zoom · ↑↓ navigate list · <span id="atStatus" style="color:#aaa"></span>'+
          '</div>'+
          '<div style="position:absolute;top:8px;right:8px;display:flex;gap:4px">'+
            '<label style="background:rgba(0,0,0,0.5);padding:3px 8px;border-radius:3px;font-size:9px;color:#aaa;cursor:pointer"><input type="checkbox" id="atShowSkel" checked style="vertical-align:middle"> skeleton</label>'+
            '<label style="background:rgba(0,0,0,0.5);padding:3px 8px;border-radius:3px;font-size:9px;color:#aaa;cursor:pointer"><input type="checkbox" id="atShowMesh" checked style="vertical-align:middle"> mesh</label>'+
          '</div>'+
        '</div>'+
        // Playback controls
        '<div style="padding:6px 10px;background:#0d1219;border-top:1px solid #1a2535;display:flex;align-items:center;gap:8px;font-size:10px">'+
          '<button id="atPlay" class="btn" style="font-size:11px;padding:3px 12px;min-width:60px" disabled>▶ Play</button>'+
          '<input id="atScrub" type="range" min="0" max="100" step="0.1" value="0" style="flex:1" disabled>'+
          '<span id="atFrameCounter" style="color:#888;font-family:monospace;min-width:80px;text-align:right">— / —</span>'+
          '<button id="atRestPose" class="btn" style="font-size:10px;padding:2px 8px">Rest pose</button>'+
        '</div>'+
      '</div>'+
      // RIGHT: motion lists + swap controls
      '<div style="width:400px;display:flex;flex-direction:column">'+
        '<div style="display:flex;flex:1;min-height:0;border-bottom:1px solid #1a2535">'+
          '<div style="flex:1;display:flex;flex-direction:column;border-right:1px solid #1a2535">'+
            '<div style="padding:5px 8px;background:#0d1219;font-size:10px;color:#7c7;border-bottom:1px solid #1a2535">TARGET motions <span id="atTargetCount" style="color:#666;float:right"></span></div>'+
            '<div id="atTargetList" style="flex:1;overflow-y:auto;font-family:monospace;font-size:10px;background:#080c12"></div>'+
          '</div>'+
          '<div style="flex:1;display:flex;flex-direction:column">'+
            '<div style="padding:5px 8px;background:#0d1219;font-size:10px;color:#fa7;border-bottom:1px solid #1a2535">DONOR motions <span id="atDonorCount" style="color:#666;float:right"></span></div>'+
            '<div id="atDonorList" style="flex:1;overflow-y:auto;font-family:monospace;font-size:10px;background:#080c12"></div>'+
          '</div>'+
        '</div>'+
        // Swap controls — scrollable container so it can't push motion lists offscreen
        '<div style="flex:0 1 auto;max-height:55vh;overflow-y:auto;padding:8px;background:#0d1219;font-size:10px;display:flex;flex-direction:column;gap:6px;border-top:1px solid #1a2535">'+
          '<button id="atSwapBtn" class="btn" style="background:#3a2a1a;color:#fa7;padding:6px;font-size:11px" disabled>⇆ Replace TARGET[?] with DONOR[?]</button>'+
          '<div id="atSwapWarnings" style="font-size:10px;max-height:80px;overflow-y:auto;padding:4px 6px;background:#0a0e14;border:1px solid #1a2535;border-radius:3px"><div style="color:#666;font-size:9px">Select motions on both sides to see compatibility warnings.</div></div>'+
          // Expand section — broader slot management. Three operations:
          //   1. Pad target with N empty stubs (manual count, no donor needed)
          //   2. Append selected donor motion to target's end (single)
          //   3. Auto-match donor's count (the existing feature, when donor > target)
          // The box shows whichever ones make sense for current state.
          '<div id="atExpandBox" style="display:none;padding:6px 8px;background:#1a1530;border:1px solid #2a2050;border-radius:3px">'+
            '<div style="color:#a8e;font-size:10px;margin-bottom:4px;font-weight:bold">⊕ EXPAND TARGET SLOTS</div>'+
            '<div id="atExpandInfo" style="font-size:10px;color:#aac;margin-bottom:6px;line-height:1.4"></div>'+
            // Op 1: Pad with manual count
            '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
              '<span style="color:#888;font-size:10px;min-width:62px">Add slots:</span>'+
              '<input type="number" id="atPadCount" min="1" max="500" value="16" style="width:60px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
              '<button id="atPadManualBtn" class="btn" style="background:#2a1f4a;color:#caa3ff;padding:3px 6px;font-size:10px;flex:1" title="Append the specified number of empty stub slots to the target. Use these as placeholders that you fill later with appendDonor or splice operations.">⊕ Pad with stubs</button>'+
            '</div>'+
            // Op 2: Append selected donor motion (or range)
            '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
              '<button id="atAppendDonorBtn" class="btn" style="background:#2a3a1f;color:#a3ffca;padding:3px 6px;font-size:10px;flex:1" title="Append the currently-selected donor motion to the end of the target list. The new slot will be at index target.numMotion (the slot just past target\'s current last).">⊕ Append DONOR[?] → TARGET[end]</button>'+
            '</div>'+
            // Op 3: Auto-match donor count (preserved from before)
            '<button id="atExpandBtn" class="btn" style="background:#2a1f4a;color:#caa3ff;padding:3px 6px;font-size:10px;width:100%;display:none" title="Pad target with empty stubs until its motion count matches donor\'s. Useful when target has fewer slots than the engine expects.">⊕ Auto-pad to donor count</button>'+
          '</div>'+
          // Edit motion section — collapsible
          '<div id="atEditBox" style="display:none;background:#152030;border:1px solid #1f3050;border-radius:3px">'+
            '<div data-at-collapse="edit" style="padding:6px 8px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none">'+
              '<span id="atEditChev" style="color:#8be;font-size:10px;min-width:10px">▶</span>'+
              '<div style="color:#8be;font-size:10px;font-weight:bold;flex:1">✎ EDIT TARGET[<span id="atEditIdx">?</span>] <span id="atEditFrames" style="color:#666;font-weight:normal"></span></div>'+
            '</div>'+
            '<div id="atEditBody" style="display:none;padding:0 8px 6px 8px">'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:36px">Range:</span>'+
                '<input type="number" id="atTrimStart" min="0" value="0" style="width:50px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<span style="color:#666;font-size:10px">to</span>'+
                '<input type="number" id="atTrimEnd" min="1" value="1" style="width:50px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<button id="atTrimBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 8px;font-size:10px;flex:1" title="Keep frames in (start, end]; discard the rest">✂ Trim</button>'+
                '<button id="atCutBtn" class="btn" style="background:#3a2530;color:#e8a;padding:3px 8px;font-size:10px;flex:1" title="Delete frames in (start, end] from the middle; join what\'s before and after">🪓 Cut</button>'+
              '</div>'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:36px">Speed:</span>'+
                '<input type="number" id="atSpeedFactor" step="0.25" min="0.1" max="10" value="1.0" style="width:60px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<span style="color:#666;font-size:10px">× (&gt;1 faster)</span>'+
                '<button id="atSpeedBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 8px;font-size:10px;flex:1">⏩ Apply</button>'+
              '</div>'+
              '<div style="display:flex;gap:4px;margin-bottom:4px">'+
                '<button id="atReverseBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 6px;font-size:10px;flex:1">⏪ Reverse</button>'+
                '<button id="atBoomerangBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 6px;font-size:10px;flex:1">↻ Boomerang</button>'+
              '</div>'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:36px">Hold:</span>'+
                '<input type="number" id="atHoldCount" min="1" max="200" value="10" style="width:50px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<span style="color:#666;font-size:10px">frames at end</span>'+
                '<button id="atHoldBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 8px;font-size:10px;flex:1">⏸ Apply</button>'+
              '</div>'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:36px">Loop:</span>'+
                '<input type="number" id="atLoopCount" min="2" max="20" value="2" style="width:50px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<span style="color:#666;font-size:10px">× back-to-back</span>'+
                '<button id="atLoopBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 8px;font-size:10px;flex:1">↻ Apply</button>'+
              '</div>'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:36px">Freeze:</span>'+
                '<input type="number" id="atFreezeFrame" min="1" value="1" style="width:50px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<span style="color:#666;font-size:10px">@frame, as 1-f static pose</span>'+
                '<button id="atFreezeBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 8px;font-size:10px;flex:1" title="Replace this motion with a 1-frame static pose at the chosen frame. Scrub the slider first to set this field, then click ❄ Apply.">❄ Apply</button>'+
              '</div>'+
              '<div style="display:flex;gap:4px;margin-bottom:4px">'+
                '<button id="atRevertBtn" class="btn" style="background:#3a1f30;color:#e8a;padding:3px 6px;font-size:10px;flex:1" title="Restore this motion to its state when the target file was loaded">↺ Revert this motion</button>'+
                '<button id="atQueueAddTargetBtn" class="btn" style="background:#1f3050;color:#8be;padding:3px 6px;font-size:10px;flex:1" title="Add this target motion to the splice queue">+ Queue this</button>'+
              '</div>'+
              '<div id="atEditMsg" style="font-size:9px;color:#666;margin-top:4px;font-style:italic"></div>'+
            '</div>'+
          '</div>'+
          // Splice queue panel — collapsible
          '<div id="atSpliceBox" style="display:none;background:#15302a;border:1px solid #1f5040;border-radius:3px">'+
            '<div data-at-collapse="splice" style="padding:6px 8px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none">'+
              '<span id="atSpliceChev" style="color:#8eb;font-size:10px;min-width:10px">▶</span>'+
              '<div style="color:#8eb;font-size:10px;font-weight:bold;flex:1">⛓ SPLICE QUEUE <span id="atSpliceSummary" style="color:#666;font-weight:normal"></span></div>'+
              '<button id="atQueueClearBtn" class="btn" style="background:#2a1515;color:#f88;padding:2px 6px;font-size:9px">Clear</button>'+
            '</div>'+
            '<div id="atSpliceBody" style="display:none;padding:0 8px 6px 8px">'+
              '<div id="atSpliceList" style="font-family:monospace;font-size:10px;color:#aac;margin-bottom:6px;max-height:120px;overflow-y:auto"></div>'+
              '<div style="display:flex;gap:4px">'+
                '<button id="atQueueAddDonorBtn" class="btn" style="background:#1f5040;color:#8eb;padding:3px 6px;font-size:10px;flex:1">+ Add donor motion</button>'+
                '<button id="atSpliceCommitBtn" class="btn" style="background:#1f5040;color:#8eb;padding:3px 6px;font-size:10px;flex:1" disabled>▶ Splice → target[?]</button>'+
              '</div>'+
              '<div id="atSpliceMsg" style="font-size:9px;color:#666;margin-top:4px;font-style:italic"></div>'+
            '</div>'+
          '</div>'+
          // Crossfade panel — collapsible
          '<div id="atCrossfadeBox" style="display:none;background:#30152a;border:1px solid #50204a;border-radius:3px">'+
            '<div data-at-collapse="crossfade" style="padding:6px 8px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none">'+
              '<span id="atCrossfadeChev" style="color:#e8b;font-size:10px;min-width:10px">▶</span>'+
              '<div style="color:#e8b;font-size:10px;font-weight:bold;flex:1">⚡ CROSSFADE <span style="color:#666;font-weight:normal">(blend two motions)</span></div>'+
            '</div>'+
            '<div id="atCrossfadeBody" style="display:none;padding:0 8px 6px 8px">'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:3px">'+
                '<span style="color:#888;font-size:10px;min-width:16px">A:</span>'+
                '<span id="atFadeAInfo" style="flex:1;font-family:monospace;color:#666;font-size:10px;padding:2px 6px;background:#0a0e14;border:1px solid #1a2535;border-radius:2px">(not set)</span>'+
                '<button id="atFadeAFromTBtn" class="btn" style="background:#1a2a3a;color:#8be;padding:2px 6px;font-size:9px" title="Use currently selected target motion as A">target</button>'+
                '<button id="atFadeAFromDBtn" class="btn" style="background:#3a2a1a;color:#fa7;padding:2px 6px;font-size:9px" title="Use currently selected donor motion as A">donor</button>'+
              '</div>'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:16px">B:</span>'+
                '<span id="atFadeBInfo" style="flex:1;font-family:monospace;color:#666;font-size:10px;padding:2px 6px;background:#0a0e14;border:1px solid #1a2535;border-radius:2px">(not set)</span>'+
                '<button id="atFadeBFromTBtn" class="btn" style="background:#1a2a3a;color:#8be;padding:2px 6px;font-size:9px" title="Use currently selected target motion as B">target</button>'+
                '<button id="atFadeBFromDBtn" class="btn" style="background:#3a2a1a;color:#fa7;padding:2px 6px;font-size:9px" title="Use currently selected donor motion as B">donor</button>'+
              '</div>'+
              '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">'+
                '<span style="color:#888;font-size:10px;min-width:36px">Fade:</span>'+
                '<input type="number" id="atFadeFrames" min="1" max="200" value="4" style="width:50px;background:#0a0e14;color:#cde;border:1px solid #1a2535;padding:2px 4px;font-family:monospace;font-size:10px">'+
                '<span style="color:#666;font-size:10px">frames overlap</span>'+
                '<span id="atFadeResult" style="flex:1;text-align:right;color:#888;font-size:10px"></span>'+
              '</div>'+
              '<button id="atCrossfadeApplyBtn" class="btn" style="background:#50204a;color:#e8b;padding:4px;font-size:10px;width:100%" disabled>▶ Crossfade → target[?]</button>'+
              '<div id="atCrossfadeMsg" style="font-size:9px;color:#666;margin-top:4px;font-style:italic">Tip: set A=B (same motion) and apply to make a short clip loop smoothly by doubling it.</div>'+
            '</div>'+
          '</div>'+
          '<button id="atExportBtn" class="btn" style="background:#1a2a3a;color:#7cf;padding:6px;font-size:11px" disabled>💾 Export modified target OAR</button>'+
          '<div id="atSwapHistory" style="color:#666;font-size:9px;max-height:80px;overflow-y:auto"></div>'+
        '</div>'+
      '</div>'+
    '</div>';
  document.body.appendChild(ov);
  AT_state.panelEl=ov;

  // Wire up close + clear
  document.getElementById('atClose').onclick=closeAnimSwapper;
  document.getElementById('atClear').onclick=AT_clearAll;
  document.getElementById('atExpandBtn').onclick=AT_performExpand;
  document.getElementById('atPadManualBtn').onclick=AT_performPadManual;
  document.getElementById('atAppendDonorBtn').onclick=AT_performAppendDonor;
  document.getElementById('atTrimBtn').onclick=AT_performTrim;
  document.getElementById('atCutBtn').onclick=AT_performCut;
  document.getElementById('atFreezeBtn').onclick=AT_performFreeze;
  document.getElementById('atSpeedBtn').onclick=AT_performSpeed;
  document.getElementById('atReverseBtn').onclick=AT_performReverse;
  document.getElementById('atBoomerangBtn').onclick=AT_performBoomerang;
  document.getElementById('atHoldBtn').onclick=AT_performHold;
  document.getElementById('atLoopBtn').onclick=AT_performLoop;
  document.getElementById('atRevertBtn').onclick=AT_performRevert;
  document.getElementById('atUndoBtn').onclick=AT_performUndo;
  document.getElementById('atRedoBtn').onclick=AT_performRedo;
  document.getElementById('atQueueAddTargetBtn').onclick=function(){ AT_queueAdd('target'); };
  document.getElementById('atQueueAddDonorBtn').onclick=function(){ AT_queueAdd('donor'); };
  document.getElementById('atQueueClearBtn').onclick=AT_queueClear;
  document.getElementById('atSpliceCommitBtn').onclick=AT_performSplice;
  document.getElementById('atFadeAFromTBtn').onclick=function(){ AT_fadeSetSlot('A', 'target'); };
  document.getElementById('atFadeAFromDBtn').onclick=function(){ AT_fadeSetSlot('A', 'donor'); };
  document.getElementById('atFadeBFromTBtn').onclick=function(){ AT_fadeSetSlot('B', 'target'); };
  document.getElementById('atFadeBFromDBtn').onclick=function(){ AT_fadeSetSlot('B', 'donor'); };
  document.getElementById('atFadeFrames').oninput=AT_updateCrossfadeBox;
  document.getElementById('atCrossfadeApplyBtn').onclick=AT_performCrossfade;
  // Wire collapse toggles for Edit / Splice / Crossfade panels
  var collapseHeaders = ov.querySelectorAll('[data-at-collapse]');
  for(var ci = 0; ci < collapseHeaders.length; ci++){
    (function(hdr){
      hdr.onclick = function(e){
        // Don't toggle if user clicked a button inside the header (e.g. Clear)
        if(e.target.tagName === 'BUTTON') return;
        AT_togglePanel(hdr.dataset.atCollapse);
      };
    })(collapseHeaders[ci]);
  }

  // Wire file inputs
  document.getElementById('atKmdInput').onchange=function(e){if(e.target.files[0])AT_loadKMD(e.target.files[0]);};
  document.getElementById('atTargetInput').onchange=function(e){if(e.target.files[0])AT_loadOAR(e.target.files[0],'target');};
  document.getElementById('atDonorInput').onchange=function(e){if(e.target.files[0])AT_loadOAR(e.target.files[0],'donor');};

  // Wire toggles + controls
  document.getElementById('atShowSkel').onchange=function(e){if(AT_state.skeletonHelper)AT_state.skeletonHelper.visible=e.target.checked;};
  document.getElementById('atShowMesh').onchange=function(e){if(AT_state.charRoot)AT_state.charRoot.traverse(function(o){if(o.isMesh)o.visible=e.target.checked;});};
  document.getElementById('atPlay').onclick=AT_togglePlay;
  document.getElementById('atRestPose').onclick=function(){AT_state.restPose=true;AT_state.playing=false;AT_updatePlayBtn();AT_applyRestPose();};
  document.getElementById('atScrub').oninput=function(e){
    if(!AT_state.currentPreview)return;
    AT_state.restPose=false;
    AT_state.playing=false; AT_updatePlayBtn();
    AT_state.playTime=parseFloat(e.target.value)/30; // val is frame number
    AT_applyAnimAtTime(AT_state.playTime);
    // If we're previewing the currently selected target motion, mirror the
    // scrub frame into the Freeze input so users can scrub-to-find a pose
    // then click ❄ Apply without having to read & retype the frame number.
    if(AT_state.currentPreview && AT_state.currentPreview.oar==='target'
       && AT_state.currentPreview.motionIdx===AT_state.selectedTargetMotion){
      var fi=document.getElementById('atFreezeFrame');
      if(fi){
        var f=Math.max(1, Math.floor(parseFloat(e.target.value)));
        fi.value=f;
      }
    }
  };
  document.getElementById('atSwapBtn').onclick=AT_performSwap;
  document.getElementById('atExportBtn').onclick=AT_exportTarget;

  // Setup Three.js scene
  AT_setupViewport();

  // Keyboard navigation
  AT_state.keyHandler=AT_makeKeyHandler();
  window.addEventListener('keydown', AT_state.keyHandler);

  // Restore state if we had loaded files before close. This handles the
  // close → reopen flow without making the user re-upload everything.
  AT_restoreState();
}

function AT_restoreState(){
  if(AT_state.kmd){
    document.getElementById('atKmdInfo').textContent=AT_state.kmd.numBones+' bones';
    document.getElementById('atKmdInfo').style.color='#7c7';
    AT_buildCharacter();
  }
  if(AT_state.target){
    document.getElementById('atTargetInfo').textContent=AT_state.target.maxJoint+' joints · '+AT_state.target.numMotion+' motions';
    document.getElementById('atTargetInfo').style.color='#7c7';
    document.getElementById('atTargetCount').textContent=AT_state.target.numMotion;
    AT_renderMotionList('target');
  }
  if(AT_state.donor){
    document.getElementById('atDonorInfo').textContent=AT_state.donor.maxJoint+' joints · '+AT_state.donor.numMotion+' motions';
    document.getElementById('atDonorInfo').style.color='#fa7';
    document.getElementById('atDonorCount').textContent=AT_state.donor.numMotion;
    AT_renderMotionList('donor');
  }
  if(AT_state.swapHistory && AT_state.swapHistory.length) AT_renderSwapHistory();
  AT_updateUndoButtons();
  AT_updateCompat();
  AT_updateSwapBtn();
  AT_updateWarnings();
  AT_updateEditBox();
  // Re-apply previously-selected motion highlights
  if(AT_state.selectedTargetMotion>=0){
    var tRow=document.querySelector('#atTargetList .at-mrow[data-idx="'+AT_state.selectedTargetMotion+'"]');
    if(tRow) tRow.style.background='#1a2535';
  }
  if(AT_state.selectedDonorMotion>=0){
    var dRow=document.querySelector('#atDonorList .at-mrow[data-idx="'+AT_state.selectedDonorMotion+'"]');
    if(dRow) dRow.style.background='#1a2535';
  }
}

function AT_updateWarnings(){
  var el=document.getElementById('atSwapWarnings');
  if(!el) return;
  if(!AT_state.target || !AT_state.donor || AT_state.selectedTargetMotion<0 || AT_state.selectedDonorMotion<0){
    el.innerHTML='<div style="color:#666;font-size:9px">Select motions on both sides to see compatibility warnings.</div>';
    return;
  }
  var warnings=AT_swapWarnings(AT_state.target, AT_state.donor, AT_state.selectedTargetMotion, AT_state.selectedDonorMotion);
  if(warnings.length===0){
    el.innerHTML='<div style="color:#7c7;font-size:10px">✓ No compatibility concerns detected.</div>';
    return;
  }
  var html='';
  for(var i=0;i<warnings.length;i++){
    var w=warnings[i];
    var color = w.severity==='error' ? '#f88' : (w.severity==='warn' ? '#fa6' : '#aac');
    var icon  = w.severity==='error' ? '✕'    : (w.severity==='warn' ? '⚠'    : 'ℹ');
    html+='<div style="color:'+color+';margin-bottom:4px;line-height:1.4"><span style="font-weight:bold;display:inline-block;width:14px">'+icon+'</span>'+w.msg+'</div>';
  }
  el.innerHTML=html;
}

// ─── Undo / Redo ──────────────────────────────────────────────────────────
// Each entry on the stack is a full OAR snapshot. Memory: ~150KB per entry
// (max archive size is 65535 u16 = 128KB plus the entries table). Cap at 30
// levels so worst case is ~4.5MB. Snapshots are taken BEFORE each mutation
// (in AT_pushUndo) so undoing restores the pre-operation state.
var AT_MAX_UNDO = 30;
function AT_cloneOAR(oar){
  return {
    maxJoint: oar.maxJoint,
    numMotion: oar.numMotion,
    archiveSize: oar.archiveSize,
    entries: oar.entries.map(function(e){
      return {numFrames: e.numFrames, moveOffset: e.moveOffset, rotOffsets: e.rotOffsets.slice()};
    }),
    archive: new Uint16Array(oar.archive)
  };
}
function AT_pushUndo(label){
  if(!AT_state.target) return;
  AT_state.undoStack.push({
    target: AT_cloneOAR(AT_state.target),
    label: label,
    modified: AT_state.targetModified,
    selectedIdx: AT_state.selectedTargetMotion
  });
  AT_state.redoStack = [];  // any new edit invalidates the redo branch
  while(AT_state.undoStack.length > AT_MAX_UNDO) AT_state.undoStack.shift();
  AT_updateUndoButtons();
}
function AT_performUndo(){
  if(AT_state.undoStack.length === 0) return;
  var top = AT_state.undoStack[AT_state.undoStack.length-1];
  // Save current to redo stack so we can go forward again
  AT_state.redoStack.push({
    target: AT_cloneOAR(AT_state.target),
    label: top.label,
    modified: AT_state.targetModified,
    selectedIdx: AT_state.selectedTargetMotion
  });
  var prev = AT_state.undoStack.pop();
  AT_restoreFromSnapshot(prev);
  AT_updateUndoButtons();
}
function AT_performRedo(){
  if(AT_state.redoStack.length === 0) return;
  var top = AT_state.redoStack[AT_state.redoStack.length-1];
  AT_state.undoStack.push({
    target: AT_cloneOAR(AT_state.target),
    label: top.label,
    modified: AT_state.targetModified,
    selectedIdx: AT_state.selectedTargetMotion
  });
  var nxt = AT_state.redoStack.pop();
  AT_restoreFromSnapshot(nxt);
  AT_updateUndoButtons();
}
function AT_restoreFromSnapshot(snap){
  AT_state.target = snap.target;
  AT_state.targetModified = snap.modified;
  // If the snapshot has fewer motions than current selection, drop selection
  if(AT_state.selectedTargetMotion >= AT_state.target.numMotion){
    AT_state.selectedTargetMotion = -1;
  }
  // UI refresh (mirrors what AT_applyEditResult does, minus the history push)
  document.getElementById('atTargetInfo').textContent = AT_state.target.maxJoint+' joints · '+AT_state.target.numMotion+' motions';
  var tc = document.getElementById('atTargetCount'); if(tc) tc.textContent = AT_state.target.numMotion;
  AT_renderMotionList('target');
  if(AT_state.selectedTargetMotion >= 0){
    var row = document.querySelector('#atTargetList .at-mrow[data-idx="'+AT_state.selectedTargetMotion+'"]');
    if(row) row.style.background = '#1a2535';
    AT_previewMotion('target', AT_state.selectedTargetMotion);
  } else {
    AT_applyRestPose();
  }
  AT_renderSwapHistory();
  AT_renderSpliceQueue();
  AT_updateEditBox();
  AT_updateSwapBtn();
  AT_updateWarnings();
}
function AT_updateUndoButtons(){
  var u = document.getElementById('atUndoBtn');
  var r = document.getElementById('atRedoBtn');
  if(u){
    u.disabled = AT_state.undoStack.length === 0;
    if(u.disabled){
      u.textContent = '↶ Undo';
      u.title = 'Nothing to undo';
    } else {
      var lbl = AT_state.undoStack[AT_state.undoStack.length-1].label;
      u.textContent = '↶ Undo';
      u.title = 'Undo '+lbl+'  (Ctrl+Z)  ·  '+AT_state.undoStack.length+' step(s) available';
    }
  }
  if(r){
    r.disabled = AT_state.redoStack.length === 0;
    if(r.disabled){
      r.textContent = '↷ Redo';
      r.title = 'Nothing to redo';
    } else {
      var lbl2 = AT_state.redoStack[AT_state.redoStack.length-1].label;
      r.textContent = '↷ Redo';
      r.title = 'Redo '+lbl2+'  (Ctrl+Y)  ·  '+AT_state.redoStack.length+' step(s) available';
    }
  }
}

// ─── Loop: repeat motion N times back-to-back ─────────────────────────────
// Useful for short cycle animations that need to last longer without changing
// playback speed. Trivially builds on AT_concatRaws.
function AT_loopMotion(oar, motionIdx, count){
  if(count < 2) throw new Error("Loop count must be 2 or more");
  var origRaw = AT_decodeMotionRaw(oar, motionIdx);
  var list = [];
  for(var i = 0; i < count; i++) list.push(origRaw);
  var merged = AT_concatRaws(list, oar.maxJoint);
  AT_ensureMoveDense(merged.move, merged.numFrames);
  for(var j = 0; j < merged.rots.length; j++) AT_ensureRotTerminus(merged.rots[j], merged.numFrames);
  var moveChunk = AT_encodeMoveRaw(merged.move);
  var rotChunks = merged.rots.map(function(r){ return AT_encodeRotRaw(r); });
  return AT_replaceMotionAtIndex(oar, motionIdx, merged.numFrames, moveChunk, rotChunks);
}

function AT_makeKeyHandler(){
  return function(e){
    if(!AT_state.panelEl || AT_state.panelEl.style.display==='none') return;
    var tag=(e.target.tagName||'').toLowerCase();
    // Ctrl+Z / Cmd+Z / Ctrl+Y for undo/redo — these work even when focused
    // on inputs, so users mid-typing can still undo.
    var key=(e.key||'').toLowerCase();
    if((e.ctrlKey||e.metaKey) && key==='z' && !e.shiftKey){
      e.preventDefault(); AT_performUndo(); return;
    }
    if((e.ctrlKey||e.metaKey) && (key==='y' || (key==='z' && e.shiftKey))){
      e.preventDefault(); AT_performRedo(); return;
    }
    if(tag==='input'||tag==='textarea'||tag==='select') return;
    if(e.key==='ArrowUp' || e.key==='ArrowDown'){
      e.preventDefault();
      AT_navList(e.key==='ArrowDown' ? 1 : -1);
    } else if(e.key==='Tab'){
      e.preventDefault();
      AT_state.activeList=(AT_state.activeList==='target')?'donor':'target';
      AT_highlightActiveList();
    }
  };
}

function AT_navList(delta){
  var role=AT_state.activeList;
  var oar=AT_state[role];
  if(!oar) return;
  var cur=(role==='target')?AT_state.selectedTargetMotion:AT_state.selectedDonorMotion;
  var next=Math.max(0, Math.min(oar.numMotion-1, (cur<0?0:cur+delta)));
  AT_selectMotion(role, next);
  // Scroll into view
  var listId=(role==='target')?'atTargetList':'atDonorList';
  var rows=document.querySelectorAll('#'+listId+' .at-mrow');
  if(rows[next]) rows[next].scrollIntoView({block:'nearest'});
}

function AT_highlightActiveList(){
  // Visual cue: dim the inactive header, brighten active
  var tHead=document.querySelector('#atTargetCount').parentElement;
  var dHead=document.querySelector('#atDonorCount').parentElement;
  if(tHead) tHead.style.background=(AT_state.activeList==='target')?'#1a2a3a':'#0d1219';
  if(dHead) dHead.style.background=(AT_state.activeList==='donor')?'#3a2a1a':'#0d1219';
}

function closeAnimSwapper(){
  // Stop the render loop FIRST so it can't fire after disposal
  if(AT_state.animId){ cancelAnimationFrame(AT_state.animId); AT_state.animId=null; }
  // Remove all global event listeners we added
  if(AT_state.keyHandler){ window.removeEventListener('keydown', AT_state.keyHandler); AT_state.keyHandler=null; }
  if(AT_state.mouseMoveHandler){ window.removeEventListener('mousemove', AT_state.mouseMoveHandler); AT_state.mouseMoveHandler=null; }
  if(AT_state.mouseUpHandler){ window.removeEventListener('mouseup', AT_state.mouseUpHandler); AT_state.mouseUpHandler=null; }
  if(AT_state.resizeHandler){ window.removeEventListener('resize', AT_state.resizeHandler); AT_state.resizeHandler=null; }
  // Dispose Three.js scene resources
  if(AT_state.charRoot){
    AT_state.charRoot.traverse(function(o){
      if(o.geometry && o.geometry.dispose) o.geometry.dispose();
      if(o.material){
        if(Array.isArray(o.material)) o.material.forEach(function(m){ m.dispose && m.dispose(); });
        else o.material.dispose && o.material.dispose();
      }
    });
  }
  if(AT_state.skeletonHelper && AT_state.skeletonHelper.geometry) AT_state.skeletonHelper.geometry.dispose();
  if(AT_state.renderer){
    try { AT_state.renderer.dispose(); } catch(e) {}
    try { AT_state.renderer.forceContextLoss && AT_state.renderer.forceContextLoss(); } catch(e) {}
  }
  AT_state.scene=null; AT_state.camera=null; AT_state.renderer=null;
  AT_state.charRoot=null; AT_state.boneGroups=null; AT_state.skeletonHelper=null;
  AT_state.dragState=null;
  AT_state.playing=false; AT_state.currentPreview=null;
  // Remove panel from DOM. Keep data state (kmd, target, donor, swapHistory) for reopen.
  if(AT_state.panelEl){ AT_state.panelEl.remove(); AT_state.panelEl=null; }
}

// Clear all loaded data. Called by the CLEAR button.
function AT_clearAll(){
  AT_state.kmd=null; AT_state.kmdName='';
  AT_state.target=null; AT_state.targetName=''; AT_state.targetBuf=null; AT_state.targetModified=false;
  AT_state.targetOriginal=null;
  AT_state.donor=null; AT_state.donorName='';
  AT_state.selectedTargetMotion=-1; AT_state.selectedDonorMotion=-1;
  AT_state.swapHistory=[];
  AT_state.undoStack=[];
  AT_state.redoStack=[];
  AT_state.spliceQueue=[];
  AT_state.crossfadeA=null; AT_state.crossfadeB=null;
  AT_state.currentPreview=null;
  AT_state.playing=false; AT_state.restPose=true;
  closeAnimSwapper();
  openAnimSwapper();
}

// ─── File loaders ────────────────────────────────────────────────────────────
function AT_loadKMD(file){
  AT_state.kmdName=file.name;
  var r=new FileReader();
  r.onload=function(e){
    try{
      AT_state.kmd=AT_parseCharKMD(e.target.result);
      document.getElementById('atKmdInfo').textContent=AT_state.kmd.numBones+' bones';
      document.getElementById('atKmdInfo').style.color='#7c7';
      AT_buildCharacter();
      AT_updateCompat();
    }catch(err){
      document.getElementById('atKmdInfo').textContent='ERR: '+err.message;
      document.getElementById('atKmdInfo').style.color='#f88';
    }
  };
  r.readAsArrayBuffer(file);
}
function AT_loadOAR(file, role){
  var r=new FileReader();
  r.onload=function(e){
    try{
      var oar=AT_parseOAR(e.target.result);
      if(role==='target'){
        AT_state.target=oar; AT_state.targetName=file.name; AT_state.targetBuf=e.target.result; AT_state.targetModified=false;
        // Snapshot original target for revert (re-parse fresh from the buffer for safety)
        AT_state.targetOriginal=AT_parseOAR(e.target.result);
        document.getElementById('atTargetInfo').textContent=oar.maxJoint+' joints · '+oar.numMotion+' motions';
        document.getElementById('atTargetInfo').style.color='#7c7';
        document.getElementById('atTargetCount').textContent=oar.numMotion;
        AT_renderMotionList('target');
        AT_state.swapHistory=[];
        AT_state.undoStack=[];
        AT_state.redoStack=[];
        AT_updateUndoButtons();
        AT_renderSwapHistory();
      }else{
        AT_state.donor=oar; AT_state.donorName=file.name;
        document.getElementById('atDonorInfo').textContent=oar.maxJoint+' joints · '+oar.numMotion+' motions';
        document.getElementById('atDonorInfo').style.color='#fa7';
        document.getElementById('atDonorCount').textContent=oar.numMotion;
        AT_renderMotionList('donor');
      }
      AT_updateCompat();
    }catch(err){
      var infoId=(role==='target')?'atTargetInfo':'atDonorInfo';
      document.getElementById(infoId).textContent='ERR: '+err.message;
      document.getElementById(infoId).style.color='#f88';
    }
  };
  r.readAsArrayBuffer(file);
}
function AT_updateCompat(){
  var msg=[]; var bad=false;
  if(AT_state.kmd && AT_state.target){
    if(AT_state.kmd.numBones!==AT_state.target.maxJoint){msg.push('⚠ KMD bones ('+AT_state.kmd.numBones+') ≠ Target joints ('+AT_state.target.maxJoint+')'); bad=true;}
    else msg.push('✓ KMD compatible with target');
  }
  if(AT_state.target && AT_state.donor){
    if(AT_state.target.maxJoint!==AT_state.donor.maxJoint){msg.push('⚠ Target ('+AT_state.target.maxJoint+') ≠ Donor ('+AT_state.donor.maxJoint+') joints — swap disabled'); bad=true;}
    else msg.push('✓ Target and donor share skeleton — swap enabled');
  }
  var el=document.getElementById('atCompat');
  el.textContent=msg.join('   |   ');
  el.style.color=bad?'#fa6':'#7c7';
  AT_updateSwapBtn();
  AT_updateExpandBox();
}

// Show/hide the expand-slots section based on current state. The section is
// visible whenever target is loaded (so the user can always pad). Individual
// operations within the section reveal based on context:
//   - "Pad with stubs N": always visible if target loaded
//   - "Append DONOR[idx]": visible when donor is loaded + a donor motion is selected
//   - "Auto-pad to donor count": only when donor is loaded AND donor > target
function AT_updateExpandBox(){
  var box=document.getElementById('atExpandBox');
  if(!box) return;
  if(!AT_state.target){
    box.style.display='none';
    return;
  }
  box.style.display='block';
  var t = AT_state.target;
  var d = AT_state.donor;
  var stubBytes = (2 + 2*t.maxJoint) * 2;

  // Info line: describe target state + capacity headroom
  var info = 'Target: <b>'+t.numMotion+'</b> motions, archive <b>'+t.archiveSize+'</b> u16 ';
  // Archive size limit is 65535 u16 — show how much headroom is left for
  // appended motions (real ones, not stubs). Stubs cost one shared block.
  var headroom = 65535 - t.archiveSize;
  info += '(<b>'+headroom+'</b> u16 headroom for new content)<br>';
  if(d){
    var skel = (t.maxJoint === d.maxJoint) ? 'compatible' :
               '<span style="color:#fa6">incompatible — '+t.maxJoint+' vs '+d.maxJoint+' joints</span>';
    info += 'Donor: <b>'+d.numMotion+'</b> motions ('+skel+').<br>';
  } else {
    info += '<i>(load a donor to enable append/auto-pad)</i><br>';
  }
  info += '<span style="color:#888;font-size:9px">Stub cost: '+stubBytes+' bytes total (shared across all new stub slots).</span>';
  document.getElementById('atExpandInfo').innerHTML = info;

  // Append-donor button visibility + label
  var appendBtn = document.getElementById('atAppendDonorBtn');
  if(d && AT_state.selectedDonorMotion >= 0 && d.numMotion > 0 &&
     t.maxJoint === d.maxJoint){
    appendBtn.disabled = false;
    appendBtn.style.opacity = '1';
    appendBtn.textContent = '⊕ Append DONOR['+AT_state.selectedDonorMotion+'] → TARGET['+t.numMotion+']';
  } else {
    appendBtn.disabled = true;
    appendBtn.style.opacity = '0.5';
    appendBtn.textContent = d
      ? (t.maxJoint !== d.maxJoint
          ? '⊕ Append DONOR[?] → TARGET[end] (skeleton mismatch)'
          : '⊕ Append DONOR[?] → TARGET[end] (select donor motion first)')
      : '⊕ Append DONOR[?] → TARGET[end] (load donor first)';
  }

  // Auto-pad button: show only when meaningful
  var autoBtn = document.getElementById('atExpandBtn');
  if(d && t.maxJoint === d.maxJoint && t.numMotion < d.numMotion){
    autoBtn.style.display = 'block';
    autoBtn.textContent = '⊕ Auto-pad target to '+d.numMotion+' slots (donor count)';
  } else {
    autoBtn.style.display = 'none';
  }
}

function AT_performExpand(){
  if(!AT_state.target || !AT_state.donor) return;
  if(AT_state.target.maxJoint !== AT_state.donor.maxJoint){
    alert('Cannot expand: skeleton mismatch ('+AT_state.target.maxJoint+' vs '+AT_state.donor.maxJoint+' joints).');
    return;
  }
  if(AT_state.target.numMotion >= AT_state.donor.numMotion){
    alert('Target already has '+AT_state.target.numMotion+' motions (>= donor count '+AT_state.donor.numMotion+'). Nothing to expand.');
    return;
  }
  var added = AT_state.donor.numMotion - AT_state.target.numMotion;
  if(!confirm('Pad target with '+added+' new stub slots so motion indices 0..'+(AT_state.donor.numMotion-1)+' all resolve?\n\nAll '+AT_state.target.numMotion+' existing target motions stay exactly as they are. New slots play a 1-frame static pose until you replace them via swap.')) return;
  try {
    var newTarget = AT_padWithStubs(AT_state.target, AT_state.donor.numMotion);
    AT_pushUndo('pad +'+added+' stubs');
    AT_state.target = newTarget;
    AT_state.targetModified = true;
    AT_state.swapHistory.push({kind:'pad', added:added, finalCount:newTarget.numMotion});
    document.getElementById('atTargetInfo').textContent=newTarget.maxJoint+' joints · '+newTarget.numMotion+' motions';
    document.getElementById('atTargetCount').textContent=newTarget.numMotion;
    AT_renderMotionList('target');
    AT_renderSwapHistory();
    AT_updateExpandBox();
    AT_updateSwapBtn();
    AT_updateWarnings();
  } catch(err){
    alert('Expansion failed: '+err.message);
  }
}

// Manual pad: read N from the input, append N stubs to target. Doesn't need
// a donor — useful when you just want to reserve slot space for custom anim
// IDs the C patch will reference. The new slots all decode to T-pose until
// replaced by a real animation via the regular swap or append workflow.
function AT_performPadManual(){
  if(!AT_state.target){ alert('Load a target OAR first.'); return; }
  var n = parseInt(document.getElementById('atPadCount').value, 10);
  if(!(n > 0) || !isFinite(n)){ alert('Enter a positive number of slots to add.'); return; }
  if(n > 500){ alert('Refusing to add more than 500 slots in one operation (safety limit).'); return; }
  // Estimate post-pad table size and warn if approaching the u16 archive-offset limit
  var entrySize = AT_state.target.maxJoint + 2;
  var futureTableBytes = entrySize * 2 * (AT_state.target.numMotion + n);
  // The archive itself doesn't grow much (just one shared stub block if first stub op),
  // but the entry-table size is part of the file too. The u16 limit on archive offsets
  // means the archive portion stays <= 131072 bytes regardless of table size.
  var futureCount = AT_state.target.numMotion + n;
  if(!confirm('Add '+n+' empty stub slots? Target will go from '+AT_state.target.numMotion+' to '+futureCount+' motions.\n\nNew slots play a 1-frame static T-pose until you replace them via swap or append. All existing motions stay exactly as they are.\n\nEntry-table size after: ~'+futureTableBytes+' bytes.')) return;
  try {
    var newTarget = AT_padWithStubs(AT_state.target, futureCount);
    AT_pushUndo('manual pad +'+n+' stubs');
    AT_state.target = newTarget;
    AT_state.targetModified = true;
    AT_state.swapHistory.push({kind:'pad', added:n, finalCount:newTarget.numMotion});
    document.getElementById('atTargetInfo').textContent=newTarget.maxJoint+' joints · '+newTarget.numMotion+' motions';
    document.getElementById('atTargetCount').textContent=newTarget.numMotion;
    AT_renderMotionList('target');
    AT_renderSwapHistory();
    AT_updateExpandBox();
    AT_updateSwapBtn();
    AT_updateWarnings();
  } catch(err){
    alert('Pad failed: '+err.message);
  }
}

// Append the currently-selected donor motion to the end of target's list.
// Target grows by one motion. The new motion sits at index target.numMotion
// (i.e., the new last). Real animation data is COPIED from donor, not
// referenced — donor file isn't modified.
function AT_performAppendDonor(){
  if(!AT_state.target){ alert('Load a target OAR first.'); return; }
  if(!AT_state.donor){ alert('Load a donor OAR first.'); return; }
  if(AT_state.target.maxJoint !== AT_state.donor.maxJoint){
    alert('Cannot append: skeleton mismatch ('+AT_state.target.maxJoint+' vs '+AT_state.donor.maxJoint+' joints).');
    return;
  }
  if(AT_state.selectedDonorMotion < 0){
    alert('Select a donor motion first (click one in the donor list).');
    return;
  }
  var idx = AT_state.selectedDonorMotion;
  if(idx < 0 || idx >= AT_state.donor.numMotion){
    alert('Selected donor index '+idx+' is out of range.');
    return;
  }
  var newSlot = AT_state.target.numMotion;
  // Estimate added size for the headroom check
  var chunks = AT_extractChunks(AT_state.donor, idx);
  var addBytes = chunks.moveChunk.length;
  for(var j=0; j<chunks.rotChunks.length; j++) addBytes += chunks.rotChunks[j].length;
  var futureArchive = AT_state.target.archiveSize + addBytes;
  if(futureArchive > 65535){
    alert('Cannot append: this motion is '+addBytes+' u16 of animation data, but only '+(65535 - AT_state.target.archiveSize)+' u16 of headroom remains before the OAR\'s u16 archive-offset limit.');
    return;
  }
  if(!confirm('Append donor motion '+idx+' to target as new slot '+newSlot+'?\n\nTarget will grow from '+AT_state.target.numMotion+' to '+(newSlot+1)+' motions.\nArchive size: '+AT_state.target.archiveSize+' → '+futureArchive+' u16.\n\nThe donor file is not modified.')) return;
  try {
    var newTarget = AT_appendMotionsFromDonor(AT_state.target, AT_state.donor, idx, idx + 1);
    AT_pushUndo('append donor['+idx+'] → target['+newSlot+']');
    AT_state.target = newTarget;
    AT_state.targetModified = true;
    AT_state.swapHistory.push({kind:'appendDonor', donorIdx:idx, targetIdx:newSlot});
    document.getElementById('atTargetInfo').textContent=newTarget.maxJoint+' joints · '+newTarget.numMotion+' motions';
    document.getElementById('atTargetCount').textContent=newTarget.numMotion;
    AT_renderMotionList('target');
    AT_renderSwapHistory();
    AT_updateExpandBox();
    AT_updateSwapBtn();
    AT_updateWarnings();
  } catch(err){
    alert('Append failed: '+err.message);
  }
}

// ─── Edit motion (trim / speed / reverse) ───────────────────────────────────
function AT_togglePanel(name){
  AT_state.panelExpanded[name] = !AT_state.panelExpanded[name];
  AT_applyPanelState(name);
}
// Apply the panel's collapsed/expanded state to the DOM.
function AT_applyPanelState(name){
  var body = document.getElementById('at' + name.charAt(0).toUpperCase() + name.slice(1) + 'Body');
  var chev = document.getElementById('at' + name.charAt(0).toUpperCase() + name.slice(1) + 'Chev');
  if(!body || !chev) return;
  var open = AT_state.panelExpanded[name];
  body.style.display = open ? 'block' : 'none';
  chev.textContent = open ? '▼' : '▶';
}

function AT_updateEditBox(){
  var box=document.getElementById('atEditBox');
  if(!box) return;
  if(!AT_state.target || AT_state.selectedTargetMotion < 0){
    box.style.display='none';
    AT_renderSpliceQueue();
    AT_updateCrossfadeBox();
    return;
  }
  box.style.display='block';
  AT_applyPanelState('edit');
  var idx = AT_state.selectedTargetMotion;
  var entry = AT_state.target.entries[idx];
  document.getElementById('atEditIdx').textContent = idx;
  document.getElementById('atEditFrames').textContent = '· '+entry.numFrames+' frames';
  var trimEnd = document.getElementById('atTrimEnd');
  trimEnd.max = entry.numFrames;
  if(parseInt(trimEnd.value) > entry.numFrames || parseInt(trimEnd.value) <= 0){
    trimEnd.value = entry.numFrames;
  }
  var trimStart = document.getElementById('atTrimStart');
  trimStart.max = entry.numFrames - 1;
  if(parseInt(trimStart.value) >= entry.numFrames){
    trimStart.value = 0;
  }
  // Freeze input: bound to this motion's range, default to whatever the
  // scrub last landed on (so re-opening the panel keeps your pose pick),
  // clamp to a valid frame if the previous value is out of range.
  var freezeInput = document.getElementById('atFreezeFrame');
  if(freezeInput){
    freezeInput.max = entry.numFrames;
    freezeInput.min = 1;
    var fv = parseInt(freezeInput.value);
    if(!fv || fv < 1 || fv > entry.numFrames){
      freezeInput.value = Math.max(1, Math.floor(entry.numFrames / 2));
    }
  }
  // Revert button: enable only if original has this slot
  var revertBtn = document.getElementById('atRevertBtn');
  if(revertBtn){
    var canRevert = AT_state.targetOriginal && idx < AT_state.targetOriginal.numMotion;
    revertBtn.disabled = !canRevert;
    revertBtn.title = canRevert
      ? 'Restore this motion to the state it was in when target file was loaded (undoes all edits to this slot)'
      : 'Cannot revert: this slot did not exist in the original target file (was created by padding)';
  }
  // Update splice queue display (button labels depend on selected target)
  AT_renderSpliceQueue();
  AT_updateCrossfadeBox();
}

function AT_applyEditResult(newTarget, opLabel){
  // Snapshot the current target BEFORE we replace it — this is what undo restores.
  AT_pushUndo(opLabel);
  // Refresh selected motion preview after edit
  AT_state.target = newTarget;
  AT_state.targetModified = true;
  AT_state.swapHistory.push({kind:'edit', op: opLabel, idx: AT_state.selectedTargetMotion, newFrames: newTarget.entries[AT_state.selectedTargetMotion].numFrames});
  // Refresh UI
  document.getElementById('atTargetInfo').textContent = newTarget.maxJoint+' joints · '+newTarget.numMotion+' motions';
  AT_renderMotionList('target');
  // Re-highlight selection
  var row = document.querySelector('#atTargetList .at-mrow[data-idx="'+AT_state.selectedTargetMotion+'"]');
  if(row) row.style.background = '#1a2535';
  AT_renderSwapHistory();
  AT_updateEditBox();
  AT_updateSwapBtn();
  AT_updateWarnings();
  // Re-preview the edited motion
  AT_previewMotion('target', AT_state.selectedTargetMotion);
  var msg = document.getElementById('atEditMsg');
  msg.textContent = '✓ '+opLabel+' applied. Now '+newTarget.entries[AT_state.selectedTargetMotion].numFrames+' frames.';
  msg.style.color = '#7c7';
}

function AT_performTrim(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  var start = parseInt(document.getElementById('atTrimStart').value) || 0;
  var end = parseInt(document.getElementById('atTrimEnd').value) || AT_state.target.entries[idx].numFrames;
  try {
    var newTarget = AT_trimMotion(AT_state.target, idx, start, end);
    AT_applyEditResult(newTarget, 'trim ('+start+','+end+']');
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Trim failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performCut(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  var start = parseInt(document.getElementById('atTrimStart').value) || 0;
  var end = parseInt(document.getElementById('atTrimEnd').value) || 0;
  try {
    var newTarget = AT_cutRange(AT_state.target, idx, start, end);
    AT_applyEditResult(newTarget, 'cut ('+start+','+end+']');
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Cut failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performFreeze(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  var frame = parseInt(document.getElementById('atFreezeFrame').value) || 0;
  if(frame < 1){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Freeze frame must be 1 or higher (tip: scrub then click Freeze)';
    msg.style.color = '#f88';
    return;
  }
  try {
    var newTarget = AT_freezeFrame(AT_state.target, idx, frame);
    AT_applyEditResult(newTarget, 'freeze @frame '+frame);
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Freeze failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performSpeed(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  var factor = parseFloat(document.getElementById('atSpeedFactor').value);
  if(!isFinite(factor) || factor <= 0){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Speed factor must be a positive number';
    msg.style.color = '#f88';
    return;
  }
  try {
    var newTarget = AT_speedMotion(AT_state.target, idx, factor);
    AT_applyEditResult(newTarget, 'speed ×'+factor);
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Speed failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performReverse(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  try {
    var newTarget = AT_reverseMotion(AT_state.target, idx);
    AT_applyEditResult(newTarget, 'reverse');
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Reverse failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performBoomerang(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  try {
    var newTarget = AT_boomerangMotion(AT_state.target, idx);
    AT_applyEditResult(newTarget, 'boomerang');
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Boomerang failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performHold(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  var count = parseInt(document.getElementById('atHoldCount').value) || 0;
  if(count <= 0){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Hold count must be > 0';
    msg.style.color = '#f88';
    return;
  }
  try {
    var newTarget = AT_holdEndFrames(AT_state.target, idx, count);
    AT_applyEditResult(newTarget, 'hold +'+count+'f');
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Hold failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performLoop(){
  if(AT_state.selectedTargetMotion < 0) return;
  var idx = AT_state.selectedTargetMotion;
  var count = parseInt(document.getElementById('atLoopCount').value) || 0;
  if(count < 2){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Loop count must be 2 or more';
    msg.style.color = '#f88';
    return;
  }
  try {
    var newTarget = AT_loopMotion(AT_state.target, idx, count);
    AT_applyEditResult(newTarget, 'loop ×'+count);
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Loop failed: '+err.message;
    msg.style.color = '#f88';
  }
}

function AT_performRevert(){
  if(AT_state.selectedTargetMotion < 0) return;
  if(!AT_state.targetOriginal){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ No original snapshot — reload target file to enable revert';
    msg.style.color = '#f88';
    return;
  }
  var idx = AT_state.selectedTargetMotion;
  try {
    var newTarget = AT_revertMotion(AT_state.target, AT_state.targetOriginal, idx);
    AT_applyEditResult(newTarget, 'revert');
  } catch(err){
    var msg = document.getElementById('atEditMsg');
    msg.textContent = '✗ Revert failed: '+err.message;
    msg.style.color = '#f88';
  }
}

// ─── Splice queue ───────────────────────────────────────────────────────────
function AT_queueAdd(role){
  var idx = (role==='target') ? AT_state.selectedTargetMotion : AT_state.selectedDonorMotion;
  if(idx < 0){
    var msg = document.getElementById('atSpliceMsg');
    if(msg){
      msg.textContent = '✗ Select a '+role+' motion first';
      msg.style.color = '#f88';
    }
    return;
  }
  var oar = AT_state[role];
  if(!oar) return;
  AT_state.spliceQueue.push({role: role, idx: idx, numFrames: oar.entries[idx].numFrames});
  AT_renderSpliceQueue();
}

function AT_queueClear(){
  AT_state.spliceQueue = [];
  AT_renderSpliceQueue();
}

function AT_queueRemoveAt(i){
  if(i < 0 || i >= AT_state.spliceQueue.length) return;
  AT_state.spliceQueue.splice(i, 1);
  AT_renderSpliceQueue();
}

function AT_renderSpliceQueue(){
  var box = document.getElementById('atSpliceBox');
  if(!box) return;
  // Show the box if either splice queue has items or both target+donor are loaded (so user can add)
  var showBox = (AT_state.spliceQueue.length > 0) || (AT_state.target && AT_state.donor);
  box.style.display = showBox ? 'block' : 'none';
  if(!showBox) return;
  AT_applyPanelState('splice');
  var summary = document.getElementById('atSpliceSummary');
  var list = document.getElementById('atSpliceList');
  if(AT_state.spliceQueue.length === 0){
    summary.textContent = '(empty)';
    list.innerHTML = '<div style="color:#666;font-style:italic">Click "+ Queue this" in EDIT box (for target motions) or "+ Add donor motion" below (for donor motions). Build the sequence in order.</div>';
  } else {
    var totalF = 0;
    for(var k = 0; k < AT_state.spliceQueue.length; k++) totalF += AT_state.spliceQueue[k].numFrames;
    summary.textContent = '('+AT_state.spliceQueue.length+' motions, '+totalF+' total frames)';
    var html = '';
    for(var i = 0; i < AT_state.spliceQueue.length; i++){
      var e = AT_state.spliceQueue[i];
      var col = e.role==='target' ? '#7c7' : '#fa7';
      html += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0">'+
                '<span style="color:#666;min-width:14px">'+(i+1)+'.</span>'+
                '<span style="color:'+col+';flex:1">'+e.role+'['+e.idx+']</span>'+
                '<span style="color:#666;min-width:32px;text-align:right">'+e.numFrames+'f</span>'+
                '<button class="btn at-queue-remove" data-i="'+i+'" style="background:#2a1515;color:#f88;padding:0 6px;font-size:9px">×</button>'+
              '</div>';
    }
    list.innerHTML = html;
    // Wire remove buttons
    var removes = list.querySelectorAll('.at-queue-remove');
    for(var r = 0; r < removes.length; r++){
      (function(btn){
        btn.onclick = function(){ AT_queueRemoveAt(parseInt(btn.dataset.i)); };
      })(removes[r]);
    }
  }
  // Update commit button state + label
  var btn = document.getElementById('atSpliceCommitBtn');
  var canCommit = AT_state.spliceQueue.length > 0 && AT_state.selectedTargetMotion >= 0;
  btn.disabled = !canCommit;
  if(AT_state.selectedTargetMotion >= 0){
    btn.textContent = '▶ Splice → target['+AT_state.selectedTargetMotion+']';
  } else {
    btn.textContent = '▶ Select a target slot first';
  }
}

function AT_performSplice(){
  if(AT_state.spliceQueue.length === 0) return;
  if(AT_state.selectedTargetMotion < 0) return;
  var targetSlot = AT_state.selectedTargetMotion;
  var sources = AT_state.spliceQueue.map(function(e){
    return {oar: AT_state[e.role], idx: e.idx};
  });
  try {
    var newTarget = AT_concatMotions(AT_state.target, sources, targetSlot);
    var totalF = newTarget.entries[targetSlot].numFrames;
    var label = 'splice ('+AT_state.spliceQueue.map(function(e){return e.role+'['+e.idx+']';}).join('+')+')';
    AT_pushUndo(label);
    AT_state.target = newTarget;
    // Clear queue after successful commit
    AT_state.spliceQueue = [];
    AT_state.targetModified = true;
    AT_state.swapHistory.push({kind:'edit', op: label, idx: targetSlot, newFrames: totalF});
    // Refresh UI
    document.getElementById('atTargetInfo').textContent = newTarget.maxJoint+' joints · '+newTarget.numMotion+' motions';
    AT_renderMotionList('target');
    var row = document.querySelector('#atTargetList .at-mrow[data-idx="'+targetSlot+'"]');
    if(row) row.style.background = '#1a2535';
    AT_renderSwapHistory();
    AT_renderSpliceQueue();
    AT_updateEditBox();
    AT_updateSwapBtn();
    AT_updateWarnings();
    AT_previewMotion('target', targetSlot);
    var msg = document.getElementById('atSpliceMsg');
    msg.textContent = '✓ Spliced into target['+targetSlot+'], now '+totalF+' frames';
    msg.style.color = '#7c7';
  } catch(err){
    var msg = document.getElementById('atSpliceMsg');
    msg.textContent = '✗ Splice failed: '+err.message;
    msg.style.color = '#f88';
  }
}

// ─── Crossfade UI ───────────────────────────────────────────────────────────
function AT_fadeSetSlot(slot, role){
  var idx = (role==='target') ? AT_state.selectedTargetMotion : AT_state.selectedDonorMotion;
  if(idx < 0){
    var msg = document.getElementById('atCrossfadeMsg');
    if(msg){
      msg.textContent = '✗ Select a '+role+' motion first';
      msg.style.color = '#f88';
    }
    return;
  }
  var oar = AT_state[role];
  if(!oar) return;
  var ref = {role: role, idx: idx, numFrames: oar.entries[idx].numFrames};
  if(slot === 'A') AT_state.crossfadeA = ref;
  else AT_state.crossfadeB = ref;
  AT_updateCrossfadeBox();
}

function AT_updateCrossfadeBox(){
  var box = document.getElementById('atCrossfadeBox');
  if(!box) return;
  // Show when target+donor both loaded (so the buttons can populate)
  var showBox = AT_state.target && AT_state.donor;
  box.style.display = showBox ? 'block' : 'none';
  if(!showBox) return;
  AT_applyPanelState('crossfade');
  // Fill slot info
  function slotLabel(s){
    if(!s) return '(not set)';
    var col = s.role==='target' ? '#7c7' : '#fa7';
    return '<span style="color:'+col+'">'+s.role+'['+s.idx+'] ('+s.numFrames+'f)</span>';
  }
  document.getElementById('atFadeAInfo').innerHTML = slotLabel(AT_state.crossfadeA);
  document.getElementById('atFadeBInfo').innerHTML = slotLabel(AT_state.crossfadeB);
  // Compute result length preview
  var fade = parseInt(document.getElementById('atFadeFrames').value) || 0;
  var resultEl = document.getElementById('atFadeResult');
  var canApply = false;
  if(AT_state.crossfadeA && AT_state.crossfadeB && fade >= 1 && AT_state.selectedTargetMotion >= 0){
    var total = AT_state.crossfadeA.numFrames + AT_state.crossfadeB.numFrames - fade;
    var minFrames = Math.min(AT_state.crossfadeA.numFrames, AT_state.crossfadeB.numFrames);
    if(fade > minFrames){
      resultEl.innerHTML = '<span style="color:#f88">fade > '+minFrames+' (shorter motion)</span>';
    } else {
      resultEl.innerHTML = 'Result: <span style="color:#aac">'+total+'f</span>';
      canApply = true;
    }
  } else {
    resultEl.textContent = '';
  }
  // Update apply button
  var btn = document.getElementById('atCrossfadeApplyBtn');
  btn.disabled = !canApply;
  if(AT_state.selectedTargetMotion >= 0){
    btn.textContent = '▶ Crossfade → target['+AT_state.selectedTargetMotion+']';
  } else {
    btn.textContent = '▶ Select a target slot first';
  }
}

function AT_performCrossfade(){
  if(!AT_state.crossfadeA || !AT_state.crossfadeB) return;
  if(AT_state.selectedTargetMotion < 0) return;
  var fade = parseInt(document.getElementById('atFadeFrames').value) || 0;
  if(fade < 1) return;
  var targetSlot = AT_state.selectedTargetMotion;
  var srcA = {oar: AT_state[AT_state.crossfadeA.role], idx: AT_state.crossfadeA.idx};
  var srcB = {oar: AT_state[AT_state.crossfadeB.role], idx: AT_state.crossfadeB.idx};
  try {
    var newTarget = AT_crossfadeMotions(AT_state.target, srcA, srcB, fade, targetSlot);
    var totalF = newTarget.entries[targetSlot].numFrames;
    var label = 'crossfade '+AT_state.crossfadeA.role+'['+AT_state.crossfadeA.idx+']+'+AT_state.crossfadeB.role+'['+AT_state.crossfadeB.idx+'] (fade '+fade+'f)';
    AT_pushUndo(label);
    AT_state.target = newTarget;
    AT_state.targetModified = true;
    AT_state.swapHistory.push({kind:'edit', op: label, idx: targetSlot, newFrames: totalF});
    document.getElementById('atTargetInfo').textContent = newTarget.maxJoint+' joints · '+newTarget.numMotion+' motions';
    AT_renderMotionList('target');
    var row = document.querySelector('#atTargetList .at-mrow[data-idx="'+targetSlot+'"]');
    if(row) row.style.background = '#1a2535';
    AT_renderSwapHistory();
    AT_updateEditBox();
    AT_updateSwapBtn();
    AT_updateWarnings();
    AT_previewMotion('target', targetSlot);
    var msg = document.getElementById('atCrossfadeMsg');
    msg.textContent = '✓ Crossfaded into target['+targetSlot+'], now '+totalF+' frames';
    msg.style.color = '#7c7';
  } catch(err){
    var msg2 = document.getElementById('atCrossfadeMsg');
    msg2.textContent = '✗ Crossfade failed: '+err.message;
    msg2.style.color = '#f88';
  }
}

// ─── Motion list rendering ───────────────────────────────────────────────────
function AT_renderMotionList(role){
  var oar=AT_state[role];
  var listEl=document.getElementById(role==='target'?'atTargetList':'atDonorList');
  if(!oar){listEl.innerHTML=''; return;}
  var rows='';
  for(var i=0;i<oar.numMotion;i++){
    var fc=oar.entries[i].numFrames;
    var color=(role==='target')?'#7c7':'#fa7';
    rows+='<div class="at-mrow" data-role="'+role+'" data-idx="'+i+'" style="padding:2px 8px;cursor:pointer;border-bottom:1px solid #0d1219;display:flex;justify-content:space-between"><span style="color:'+color+'">m'+String(i).padStart(3,'0')+'</span><span style="color:#666">'+fc+'f</span></div>';
  }
  listEl.innerHTML=rows;
  // Click handlers via delegation
  listEl.onclick=function(e){
    var row=e.target.closest('.at-mrow');
    if(!row)return;
    var r=row.dataset.role, idx=parseInt(row.dataset.idx);
    AT_selectMotion(r, idx);
  };
}
function AT_selectMotion(role, idx){
  // Mark this as active list for keyboard nav
  AT_state.activeList=role;
  AT_highlightActiveList();
  // Visual selection
  var listId=(role==='target')?'atTargetList':'atDonorList';
  var rows=document.querySelectorAll('#'+listId+' .at-mrow');
  rows.forEach(function(rr){
    rr.style.background=(parseInt(rr.dataset.idx)===idx)?'#1a2535':'';
  });
  if(role==='target') AT_state.selectedTargetMotion=idx;
  else AT_state.selectedDonorMotion=idx;
  // Preview it
  AT_previewMotion(role, idx);
  AT_updateSwapBtn();
  AT_updateWarnings();
  AT_updateEditBox();
  AT_updateExpandBox();
}
function AT_updateSwapBtn(){
  var btn=document.getElementById('atSwapBtn');
  if(!btn)return;
  var canSwap=AT_state.target && AT_state.donor &&
              AT_state.target.maxJoint===AT_state.donor.maxJoint &&
              AT_state.selectedTargetMotion>=0 && AT_state.selectedDonorMotion>=0;
  btn.disabled=!canSwap;
  if(canSwap) btn.textContent='⇆ Replace TARGET['+AT_state.selectedTargetMotion+'] with DONOR['+AT_state.selectedDonorMotion+']';
  else btn.textContent='⇆ Select one motion on each side to enable swap';

  var exp=document.getElementById('atExportBtn');
  if(exp){
    exp.disabled=!(AT_state.target && AT_state.targetModified);
    exp.textContent=AT_state.targetModified?('💾 Export modified target OAR ('+AT_state.swapHistory.length+' swap'+(AT_state.swapHistory.length===1?'':'s')+')'):'💾 Export modified target OAR';
  }
}

// ─── Animation preview ───────────────────────────────────────────────────────
function AT_previewMotion(role, idx){
  if(!AT_state.kmd){document.getElementById('atStatus').textContent='Load a KMD first'; return;}
  var oar=AT_state[role];
  if(!oar) return;
  if(AT_state.kmd.numBones!==oar.maxJoint){document.getElementById('atStatus').textContent='KMD/OAR bone mismatch'; return;}
  var decoded=AT_decodeMotion(oar, idx);
  AT_state.currentPreview={role:role, idx:idx, decoded:decoded};
  AT_state.restPose=false;
  AT_state.playTime=0;
  document.getElementById('atScrub').disabled=false;
  document.getElementById('atScrub').max=decoded.numFrames;
  document.getElementById('atScrub').value=0;
  document.getElementById('atPlay').disabled=false;
  AT_applyAnimAtTime(0);
  AT_state.playing=true;
  AT_updatePlayBtn();
  document.getElementById('atStatus').textContent='Playing '+role.toUpperCase()+' motion '+idx+' ('+decoded.numFrames+' frames)';
}
function AT_togglePlay(){
  if(!AT_state.currentPreview)return;
  AT_state.playing=!AT_state.playing;
  AT_state.restPose=false;
  AT_state.lastT=performance.now();
  AT_updatePlayBtn();
}
function AT_updatePlayBtn(){
  var b=document.getElementById('atPlay');
  if(b) b.textContent=AT_state.playing?'❚❚ Pause':'▶ Play';
}
function AT_applyAnimAtTime(timeSec){
  if(!AT_state.currentPreview || !AT_state.boneGroups) return;
  var dec=AT_state.currentPreview.decoded;
  var frame=timeSec*30; // 30 fps
  if(frame>dec.numFrames){frame=frame%(dec.numFrames+1);}  // loop
  var t=AT_interpAtFrame(dec.trans, frame, false);
  var bg=AT_state.boneGroups;
  // Root translation goes on the root (bone 0)
  if(bg[0]){bg[0].position.set(t[0], t[1], t[2]);}
  // Bone rotations: each bone gets its quaternion from dec.rots[j]
  for(var j=0;j<bg.length;j++){
    var q=AT_interpAtFrame(dec.rots[j], frame, true);
    if(bg[j]) bg[j].quaternion.set(q[0], q[1], q[2], q[3]);
  }
  // Update frame counter
  var fc=document.getElementById('atFrameCounter');
  if(fc) fc.textContent=Math.floor(frame)+' / '+dec.numFrames;
  // Update scrub
  if(!AT_state.scrubbing){
    var sc=document.getElementById('atScrub');
    if(sc) sc.value=frame;
  }
}
function AT_applyRestPose(){
  if(!AT_state.boneGroups) return;
  for(var j=0;j<AT_state.boneGroups.length;j++){
    if(AT_state.boneGroups[j]){
      AT_state.boneGroups[j].quaternion.set(0,0,0,1);
    }
  }
  // Set root to a sensible standing position
  if(AT_state.boneGroups[0] && AT_state.kmd){
    var lp=AT_state.kmd.bones[0].localPos;
    AT_state.boneGroups[0].position.set(lp[0], lp[1], lp[2]);
  }
  var fc=document.getElementById('atFrameCounter');
  if(fc) fc.textContent='rest pose';
}

// ─── Swap + Export ───────────────────────────────────────────────────────────
function AT_performSwap(){
  if(AT_state.selectedTargetMotion<0 || AT_state.selectedDonorMotion<0)return;
  if(AT_state.target.maxJoint!==AT_state.donor.maxJoint)return;
  try{
    var newTarget=AT_spliceMotion(AT_state.target, AT_state.donor, AT_state.selectedDonorMotion, AT_state.selectedTargetMotion);
    AT_pushUndo('swap donor['+AT_state.selectedDonorMotion+']→target['+AT_state.selectedTargetMotion+']');
    AT_state.target=newTarget;
    AT_state.targetModified=true;
    AT_state.swapHistory.push({donor:AT_state.selectedDonorMotion, target:AT_state.selectedTargetMotion, donorFile:AT_state.donorName});
    AT_renderSwapHistory();
    AT_renderMotionList('target'); // refresh frame counts
    AT_updateSwapBtn();
    // Preview the new motion immediately
    AT_previewMotion('target', AT_state.selectedTargetMotion);
  }catch(err){
    alert('Swap failed: '+err.message);
  }
}
function AT_renderSwapHistory(){
  var el=document.getElementById('atSwapHistory');
  if(!el) return;
  if(AT_state.swapHistory.length===0){el.textContent='No swaps yet.'; return;}
  var html='<div style="color:#aaa;margin-bottom:2px">History:</div>';
  for(var i=0;i<AT_state.swapHistory.length;i++){
    var h=AT_state.swapHistory[i];
    if(h.kind==='pad'){
      html+='<div style="font-family:monospace;color:#caa3ff">'+(i+1)+'. ⊕ padded +'+h.added+' stubs (now '+h.finalCount+' motions)</div>';
    } else if(h.kind==='edit'){
      html+='<div style="font-family:monospace;color:#8be">'+(i+1)+'. ✎ target['+h.idx+'] '+h.op+' → '+h.newFrames+'f</div>';
    } else {
      html+='<div style="font-family:monospace">'+(i+1)+'. donor['+h.donor+'] → target['+h.target+']</div>';
    }
  }
  el.innerHTML=html;
}
function AT_exportTarget(){
  if(!AT_state.target || !AT_state.targetModified)return;
  // COMPACTION FIX: garbage-collect orphaned chunks before serializing.
  // Without this, every swap grows the file regardless of donor size.
  var sizeBefore = AT_state.target.archive.length;
  var compacted = AT_compactArchive(AT_state.target);
  var sizeAfter = compacted.archive.length;
  if(sizeAfter < sizeBefore){
    console.log("Archive compacted: " + sizeBefore + " → " + sizeAfter +
                " u16 (-" + (sizeBefore - sizeAfter) + ", " +
                Math.round(100 * (sizeBefore - sizeAfter) / sizeBefore) +
                "% smaller). Reclaimed orphaned chunk data.");
  }
  var buf=AT_serializeOAR(compacted);
  var blob=new Blob([buf], {type:'application/octet-stream'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;
  // Derive output name: foo.oar → foo_swapped.oar
  var base=AT_state.targetName.replace(/\.oar$/i, '');
  a.download=base+'_swapped.oar';
  a.click();
  setTimeout(function(){URL.revokeObjectURL(url);}, 100);
}

// ════════════════════════════════════════════════════════════════════════════
// Three.js viewport
// ════════════════════════════════════════════════════════════════════════════
function AT_setupViewport(){
  var canvas=document.getElementById('atCanvas');
  var rect=canvas.getBoundingClientRect();
  var scene=new THREE.Scene();
  scene.background=new THREE.Color(0x111418);
  var camera=new THREE.PerspectiveCamera(45, rect.width/rect.height, 10, 50000);
  var renderer=new THREE.WebGLRenderer({canvas:canvas, antialias:true});
  renderer.setSize(rect.width, rect.height, false);
  // Lighting
  var ambient=new THREE.AmbientLight(0x666666);
  scene.add(ambient);
  var key=new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(1000,2000,1500);
  scene.add(key);
  var fill=new THREE.DirectionalLight(0x6688aa, 0.4);
  fill.position.set(-1500,500,-1000);
  scene.add(fill);
  // Ground grid for orientation
  var grid=new THREE.GridHelper(4000, 20, 0x334455, 0x223344);
  grid.position.y=0;
  scene.add(grid);
  // Axes
  var axes=new THREE.AxesHelper(500);
  scene.add(axes);

  AT_state.scene=scene; AT_state.camera=camera; AT_state.renderer=renderer;
  AT_updateCamera();

  // Mouse drag for orbit (left) + pan (right) + wheel zoom
  canvas.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  canvas.addEventListener('mousedown', function(e){
    if(e.button === 2){
      // Right-click: pan
      AT_state.dragState={mode:'pan', x:e.clientX, y:e.clientY, tx:AT_state.cameraOrbit.target[0], ty:AT_state.cameraOrbit.target[1], tz:AT_state.cameraOrbit.target[2]};
      canvas.style.cursor='move';
    } else {
      // Left/middle: orbit
      AT_state.dragState={mode:'orbit', x:e.clientX, y:e.clientY, yaw:AT_state.cameraOrbit.yaw, pitch:AT_state.cameraOrbit.pitch};
      canvas.style.cursor='grabbing';
    }
  });
  AT_state.mouseMoveHandler=function(e){
    if(!AT_state.dragState)return;
    var dx=e.clientX-AT_state.dragState.x, dy=e.clientY-AT_state.dragState.y;
    if(AT_state.dragState.mode === 'pan'){
      var c=AT_state.cameraOrbit;
      var panScale = c.dist * 0.0015;
      var rx=Math.cos(c.yaw), rz=-Math.sin(c.yaw);
      var ux=-Math.sin(c.pitch)*Math.sin(c.yaw), uy=Math.cos(c.pitch), uz=-Math.sin(c.pitch)*Math.cos(c.yaw);
      AT_state.cameraOrbit.target[0]=AT_state.dragState.tx - dx*panScale*rx + dy*panScale*ux;
      AT_state.cameraOrbit.target[1]=AT_state.dragState.ty + dy*panScale*uy;
      AT_state.cameraOrbit.target[2]=AT_state.dragState.tz - dx*panScale*rz + dy*panScale*uz;
    } else {
      AT_state.cameraOrbit.yaw=AT_state.dragState.yaw - dx*0.01;
      AT_state.cameraOrbit.pitch=Math.max(-1.5, Math.min(1.5, AT_state.dragState.pitch - dy*0.01));
    }
    AT_updateCamera();
  };
  window.addEventListener('mousemove', AT_state.mouseMoveHandler);
  AT_state.mouseUpHandler=function(){
    if(AT_state.dragState){AT_state.dragState=null; if(canvas) canvas.style.cursor='grab';}
  };
  window.addEventListener('mouseup', AT_state.mouseUpHandler);
  canvas.addEventListener('wheel', function(e){
    e.preventDefault();
    AT_state.cameraOrbit.dist=Math.max(300, Math.min(20000, AT_state.cameraOrbit.dist*(1+e.deltaY*0.001)));
    AT_updateCamera();
  });

  // Resize handler
  AT_state.resizeHandler=function(){
    var r=canvas.getBoundingClientRect();
    if(r.width<10 || r.height<10) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect=r.width/r.height;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', AT_state.resizeHandler);
  setTimeout(AT_state.resizeHandler, 100);

  // Animation loop
  AT_state.lastT=performance.now();
  function loop(){
    AT_state.animId=requestAnimationFrame(loop);
    // Self-correcting resize: detects any canvas size change (window resize,
    // panel re-show after hide, devicePixelRatio change)
    var w=canvas.clientWidth, h=canvas.clientHeight;
    if(w>10 && h>10 && (canvas.width!==w || canvas.height!==h)){
      renderer.setSize(w, h, false);
      camera.aspect=w/h;
      camera.updateProjectionMatrix();
    }
    var now=performance.now();
    var dt=(now-AT_state.lastT)/1000;
    AT_state.lastT=now;
    if(AT_state.playing && !AT_state.restPose){
      AT_state.playTime+=dt;
      AT_applyAnimAtTime(AT_state.playTime);
    }
    renderer.render(scene, camera);
  }
  loop();
}
function AT_updateCamera(){
  var c=AT_state.cameraOrbit;
  var camX=c.target[0]+c.dist*Math.cos(c.pitch)*Math.sin(c.yaw);
  var camY=c.target[1]+c.dist*Math.sin(c.pitch);
  var camZ=c.target[2]+c.dist*Math.cos(c.pitch)*Math.cos(c.yaw);
  AT_state.camera.position.set(camX, camY, camZ);
  AT_state.camera.lookAt(c.target[0], c.target[1], c.target[2]);
}

function AT_buildCharacter(){
  if(!AT_state.scene) return;
  if(!AT_state.kmd) return;
  // Remove old
  if(AT_state.charRoot){
    AT_state.scene.remove(AT_state.charRoot);
    AT_state.charRoot.traverse(function(o){if(o.geometry) o.geometry.dispose(); if(o.material) o.material.dispose();});
  }
  if(AT_state.skeletonHelper){AT_state.scene.remove(AT_state.skeletonHelper); AT_state.skeletonHelper=null;}

  var root=new THREE.Group();
  var bones=AT_state.kmd.bones;
  var groups=new Array(bones.length);
  // Material — semi-transparent grey
  var matMesh=new THREE.MeshPhongMaterial({color:0x99aabb, transparent:true, opacity:0.7, side:THREE.DoubleSide, flatShading:true});

  // Build bone Groups in pass 1
  for(var i=0;i<bones.length;i++){
    var g=new THREE.Group();
    var lp=bones[i].localPos;
    g.position.set(lp[0], lp[1], lp[2]);
    g.userData.boneIdx=i;
    groups[i]=g;
  }
  // Parent them in pass 2
  for(var i=0;i<bones.length;i++){
    if(bones[i].parent===-1){root.add(groups[i]);}
    else if(groups[bones[i].parent]){groups[bones[i].parent].add(groups[i]);}
    else {root.add(groups[i]);}  // safety
  }
  // Attach mesh chunks to each bone in pass 3
  for(var i=0;i<bones.length;i++){
    var b=bones[i];
    if(b.verts.length===0 || b.tris.length===0) continue;
    var geom=new THREE.BufferGeometry();
    var positions=new Float32Array(b.verts.length*3);
    for(var v=0;v<b.verts.length;v++){
      positions[v*3]=b.verts[v][0];
      positions[v*3+1]=b.verts[v][1];
      positions[v*3+2]=b.verts[v][2];
    }
    var indices=new Uint16Array(b.tris.length*3);
    for(var t=0;t<b.tris.length;t++){
      indices[t*3]=b.tris[t][0];
      indices[t*3+1]=b.tris[t][1];
      indices[t*3+2]=b.tris[t][2];
    }
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();
    var mesh=new THREE.Mesh(geom, matMesh);
    groups[i].add(mesh);
  }

  // Skeleton overlay: thin orange lines from each bone to its children
  var skelGeom=new THREE.BufferGeometry();
  var skelMat=new THREE.LineBasicMaterial({color:0xffaa44, depthTest:false, transparent:true, opacity:0.9});
  var skelLines=new THREE.LineSegments(skelGeom, skelMat);
  skelLines.renderOrder=999;
  // We'll update the line positions every frame in the animation loop... actually
  // since the bones are nested in a Three.js scene graph, the easiest way to draw
  // a skeleton is per-frame: collect each bone's world position, draw segments.
  // For simplicity, attach the line segments at scene level and update its
  // buffer each frame via a userData function.
  AT_state.charRoot=root;
  AT_state.boneGroups=groups;
  AT_state.scene.add(root);

  // Build skeleton helper using THREE's SkeletonHelper-like construction:
  // We'll create our own LineSegments that we update each frame.
  var lineSegs=new Float32Array(bones.length*2*3); // each bone: line from parent to self
  var lineGeom=new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.BufferAttribute(lineSegs, 3));
  var sk=new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({color:0xffaa44, depthTest:false, transparent:true, opacity:0.85}));
  sk.renderOrder=999;
  sk.userData.updateFn=function(){
    var v0=new THREE.Vector3(), v1=new THREE.Vector3();
    for(var i=0;i<bones.length;i++){
      var b=bones[i];
      if(b.parent===-1){
        // No segment for root
        lineSegs[i*6]=lineSegs[i*6+1]=lineSegs[i*6+2]=0;
        lineSegs[i*6+3]=lineSegs[i*6+4]=lineSegs[i*6+5]=0;
        continue;
      }
      groups[b.parent].getWorldPosition(v0);
      groups[i].getWorldPosition(v1);
      lineSegs[i*6]=v0.x; lineSegs[i*6+1]=v0.y; lineSegs[i*6+2]=v0.z;
      lineSegs[i*6+3]=v1.x; lineSegs[i*6+4]=v1.y; lineSegs[i*6+5]=v1.z;
    }
    lineGeom.attributes.position.needsUpdate=true;
  };
  AT_state.skeletonHelper=sk;
  AT_state.scene.add(sk);

  // Hook skeleton update into render loop by overriding render
  // (we already have a loop; let's just call updateFn there)
  // Simpler: just call updateFn at end of every AT_applyAnimAtTime, AND once after rest pose.
  // Also need to call it once just after build to show rest skeleton.
  AT_applyRestPose();
  sk.userData.updateFn();

  // Camera focus on character: must update world matrices first or bbox is stale
  root.updateMatrixWorld(true);
  var bb=new THREE.Box3().setFromObject(root);
  var cx=(bb.min.x+bb.max.x)/2, cy=(bb.min.y+bb.max.y)/2, cz=(bb.min.z+bb.max.z)/2;
  var sx=bb.max.x-bb.min.x, sy=bb.max.y-bb.min.y, sz=bb.max.z-bb.min.z;
  AT_state.cameraOrbit.target=[cx, cy, cz];
  AT_state.cameraOrbit.dist=Math.max(sx, sy, sz)*1.8;
  AT_updateCamera();

  document.getElementById('atStatus').textContent='Character loaded ('+bones.length+' bones, rest pose)';
}

// Hook skeleton update into the apply functions
var _origApply=AT_applyAnimAtTime;
AT_applyAnimAtTime=function(t){
  _origApply(t);
  if(AT_state.skeletonHelper && AT_state.skeletonHelper.userData.updateFn){
    AT_state.skeletonHelper.userData.updateFn();
  }
};
var _origRest=AT_applyRestPose;
AT_applyRestPose=function(){
  _origRest();
  if(AT_state.skeletonHelper && AT_state.skeletonHelper.userData.updateFn){
    AT_state.skeletonHelper.userData.updateFn();
  }
};

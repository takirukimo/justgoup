// Procedural climbing holds + the per-boulder hold set.
//
// Hold-local frame: x → right, y → the GRIP side (the incut faces +y), z → out of the wall.
// A hold's back is flat on z = 0. In the wall, a hold is rotated about its normal by
// (angle + PI/2), so the classic incut-on-top hold (angle = −PI/2) needs no rotation and an
// undercling (angle = +PI/2) is flipped — the good side always faces away from the body.
//
// Route holds are separate meshes (for highlights); deco holds are merged into one mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoulderDef, HoldDef, HoldType } from '../core/types';
import { Rng } from '../core/rng';
import type { WallFrame } from './wall-frame';
import { createSurfaceMaterial, ensureSurfaceAttributes, type SurfaceMaterial } from './shading';
import { createLabelAtlas, softBlobTexture, speckleNormal, type AtlasRect } from './textures';

export const HOLD_VARIANTS = 6;

interface ProfilePt {
  y: number;
  z: number;
  ao: number;
  chalk: number;
}

const pp = (y: number, z: number, ao = 0, chalk = 0): ProfilePt => ({ y, z, ao, chalk });

// ───────────────────────────── profiles (unit size) ─────────────────────────────

const JUG: ProfilePt[] = [
  pp(-0.92, 0.0, 0.4), pp(-0.88, 0.2, 0.15), pp(-0.76, 0.42, 0, 0.02), pp(-0.56, 0.6, 0, 0.03),
  pp(-0.3, 0.7, 0, 0.05), pp(0.0, 0.74, 0, 0.07), pp(0.3, 0.75, 0, 0.12), pp(0.5, 0.72, 0, 0.32),
  pp(0.6, 0.64, 0, 0.55), pp(0.63, 0.52, 0.04, 0.62), pp(0.57, 0.42, 0.22, 0.58), pp(0.44, 0.36, 0.4, 0.48),
  pp(0.32, 0.28, 0.55, 0.4), pp(0.31, 0.17, 0.52, 0.35), pp(0.42, 0.08, 0.44, 0.3), pp(0.58, 0.03, 0.38, 0.2),
  pp(0.74, 0.0, 0.4, 0.1),
];
const EDGE: ProfilePt[] = [
  pp(-0.5, 0.0, 0.4), pp(-0.47, 0.16, 0.15), pp(-0.36, 0.32, 0, 0.02), pp(-0.14, 0.42, 0, 0.04),
  pp(0.12, 0.45, 0, 0.08), pp(0.3, 0.43, 0, 0.25), pp(0.38, 0.37, 0, 0.55), pp(0.37, 0.28, 0.08, 0.7),
  pp(0.33, 0.18, 0.2, 0.65), pp(0.3, 0.09, 0.35, 0.5), pp(0.31, 0.0, 0.45, 0.3),
];
const CRIMP: ProfilePt[] = [
  pp(-0.4, 0.0, 0.4), pp(-0.36, 0.1, 0.1), pp(-0.22, 0.2, 0, 0.03), pp(0.0, 0.25, 0, 0.08),
  pp(0.18, 0.26, 0, 0.3), pp(0.26, 0.22, 0, 0.6), pp(0.25, 0.15, 0.1, 0.7), pp(0.21, 0.07, 0.3, 0.6),
  pp(0.22, 0.0, 0.45, 0.4),
];
const PINCH: ProfilePt[] = [
  pp(-0.55, 0, 0.4, 0.1), pp(-0.52, 0.22, 0.1, 0.35), pp(-0.44, 0.42, 0, 0.45), pp(-0.26, 0.58, 0, 0.25),
  pp(0.0, 0.64, 0, 0.1), pp(0.26, 0.58, 0, 0.25), pp(0.44, 0.42, 0, 0.45), pp(0.52, 0.22, 0.1, 0.35),
  pp(0.55, 0, 0.4, 0.1),
];
const SLOPER: ProfilePt[] = (() => {
  const out: ProfilePt[] = [];
  const n = 14;
  for (let k = 0; k <= n; k++) {
    const a = (Math.PI * k) / n;
    const y = -Math.cos(a) * 0.95;
    const z = 0.6 * Math.pow(Math.sin(a), 0.8) * (1 - 0.16 * Math.max(0, y));
    const chalk = Math.max(0, Math.min(1, (y + 0.1) / 0.9)) * 0.5;
    out.push(pp(y, z, k === 0 || k === n ? 0.38 : k === 1 || k === n - 1 ? 0.12 : 0, chalk));
  }
  return out;
})();

/** Lathe profiles: (r, z). */
const POCKET: ProfilePt[] = [
  pp(1.0, 0.0, 0.4), pp(0.97, 0.18, 0.1), pp(0.86, 0.38, 0, 0.03), pp(0.68, 0.52, 0, 0.1),
  pp(0.5, 0.58, 0, 0.3), pp(0.38, 0.54, 0.1, 0.5), pp(0.32, 0.42, 0.35, 0.55), pp(0.3, 0.28, 0.55, 0.5),
  pp(0.24, 0.16, 0.7, 0.4), pp(0.12, 0.12, 0.75, 0.3), pp(0.0, 0.11, 0.75, 0.3),
];
const FOOT: ProfilePt[] = [pp(1.0, 0, 0.4), pp(0.92, 0.22, 0.1), pp(0.72, 0.42, 0, 0.05), pp(0.42, 0.55, 0, 0.1), pp(0.0, 0.6, 0, 0.12)];

// ───────────────────────────── noise ─────────────────────────────

type Noise3 = (x: number, y: number, z: number) => number;

function makeNoise(rng: Rng, fLo: number, fHi: number, waves = 7): Noise3 {
  const k: number[] = [];
  for (let i = 0; i < waves; i++) {
    const th = rng.range(0, Math.PI * 2);
    const ph = Math.acos(rng.range(-1, 1));
    const f = rng.range(fLo, fHi);
    k.push(Math.sin(ph) * Math.cos(th) * f, Math.sin(ph) * Math.sin(th) * f, Math.cos(ph) * f, rng.range(0, Math.PI * 2));
  }
  return (x, y, z) => {
    let s = 0;
    for (let i = 0; i < k.length; i += 4) s += Math.sin(k[i] * x + k[i + 1] * y + k[i + 2] * z + k[i + 3]);
    return s / Math.sqrt(waves);
  };
}

// ───────────────────────────── builders ─────────────────────────────

interface Built {
  geo: THREE.BufferGeometry;
  /** Grid info for locating the bolt point. */
  boltVertex: number;
}

interface SweepOpts {
  /** −1..1: makes one end fatter than the other. */
  asym?: number;
  /** Second, finer noise octave amplitude (relative). */
  detail?: number;
  halfLen: number;
  segU: number;
  taperP: number;
  bend: number;
  zKeep: number; // exponent on taper for depth (lower = fuller ends)
  noise: Noise3;
  noiseAmp: number;
  boltJ: number;
}

function profileNormals(prof: ProfilePt[]): { ny: number; nz: number }[] {
  // The profile runs bottom → over the front → top, so the outward normal is the tangent
  // rotated by +90° in the (y, z) plane: (dy, dz) → (−dz, dy).
  const out: { ny: number; nz: number }[] = [];
  for (let j = 0; j < prof.length; j++) {
    const a = prof[Math.max(0, j - 1)];
    const b = prof[Math.min(prof.length - 1, j + 1)];
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const l = Math.hypot(dy, dz) || 1;
    out.push({ ny: -dz / l, nz: dy / l });
  }
  return out;
}

function sweep(prof: ProfilePt[], o: SweepOpts): Built {
  const nV = prof.length;
  const nU = o.segU + 1;
  const pos = new Float32Array(nU * nV * 3);
  const uv = new Float32Array(nU * nV * 2);
  const surf = new Float32Array(nU * nV * 4);
  const pn = profileNormals(prof);
  // arc length along the profile for UVs
  const arc: number[] = [0];
  for (let j = 1; j < nV; j++) arc.push(arc[j - 1] + Math.hypot(prof[j].y - prof[j - 1].y, prof[j].z - prof[j - 1].z));
  const maxZ = Math.max(...prof.map((p) => p.z));
  const asym = o.asym ?? 0;
  const detail = o.detail ?? 0.22;
  for (let i = 0; i < nU; i++) {
    const u = -1 + (2 * i) / o.segU;
    const lump = 1 + 0.06 * o.noise(u * 2.1, 3.7, 1.3);
    const s = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), o.taperP)), 1 / o.taperP) * (1 + asym * u * 0.3) * lump;
    const sz = Math.pow(Math.max(0, s), o.zKeep);
    for (let j = 0; j < nV; j++) {
      const p = prof[j];
      let x = u * o.halfLen;
      let y = p.y * (0.25 + 0.75 * s) + o.bend * u * u;
      let z = p.z * sz;
      const contact = Math.min(1, z / (maxZ * 0.3 + 1e-6));
      const n = (o.noise(x, y, z) + detail * o.noise(x * 3.3 + 7, y * 3.3, z * 3.3)) * o.noiseAmp * contact;
      y += pn[j].ny * n;
      z += pn[j].nz * n * 0.6;
      x += o.noise(y * 1.7, z, x) * o.noiseAmp * 0.3 * contact;
      if (z < 0) z = 0;
      const k = i * nV + j;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x;
      uv[k * 2 + 1] = arc[j];
      const wallAo = Math.max(0, 1 - z / (maxZ * 0.28 + 1e-6)) * 0.32;
      surf[k * 4] = p.chalk * (0.55 + 0.45 * s);
      surf[k * 4 + 1] = 0;
      surf[k * 4 + 2] = Math.min(0.85, p.ao * (0.5 + 0.5 * s) + wallAo);
      surf[k * 4 + 3] = 0;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < o.segU; i++) {
    for (let j = 0; j < nV - 1; j++) {
      const a = i * nV + j;
      const b = (i + 1) * nV + j;
      const c = i * nV + j + 1;
      const d = (i + 1) * nV + j + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, boltVertex: Math.floor(o.segU / 2) * nV + o.boltJ };
}

interface LatheOpts {
  seg: number;
  sx: number;
  sy: number;
  holeShift: number; // +y shift of the inner part (pocket opening toward the grip side)
  noise: Noise3;
  noiseAmp: number;
}

function lathe(prof: ProfilePt[], o: LatheOpts): Built {
  const nV = prof.length;
  const nU = o.seg;
  const pos = new Float32Array(nU * nV * 3);
  const uv = new Float32Array(nU * nV * 2);
  const surf = new Float32Array(nU * nV * 4);
  const maxZ = Math.max(...prof.map((p) => p.z));
  for (let i = 0; i < nU; i++) {
    const th = (i / nU) * Math.PI * 2;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    for (let j = 0; j < nV; j++) {
      const p = prof[j];
      const inner = Math.max(0, 1 - p.y / 0.5); // p.y holds r for lathe profiles
      let x = p.y * ct * o.sx;
      let y = p.y * st * o.sy + o.holeShift * inner;
      let z = p.z;
      // tilt the pocket: deeper toward the grip side
      z -= inner * Math.max(0, st) * 0.05;
      const contact = Math.min(1, z / (maxZ * 0.3 + 1e-6));
      const n = o.noise(x, y, z) * o.noiseAmp * contact;
      x += ct * n;
      y += st * n;
      z += n * 0.4;
      if (z < 0) z = 0;
      const k = i * nV + j;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x;
      uv[k * 2 + 1] = y + z;
      const wallAo = Math.max(0, 1 - z / (maxZ * 0.28 + 1e-6)) * 0.32;
      const gripSide = 0.5 + 0.5 * st;
      surf[k * 4] = p.chalk * (0.4 + 0.6 * gripSide);
      surf[k * 4 + 2] = Math.min(0.85, p.ao + wallAo);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nU; i++) {
    const i2 = (i + 1) % nU;
    for (let j = 0; j < nV - 1; j++) {
      const a = i * nV + j;
      const b = i2 * nV + j;
      const c = i * nV + j + 1;
      const d = i2 * nV + j + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, boltVertex: nV - 1 };
}

/** Flat-shaded polyhedron builder for volumes. */
class FacetBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  surf: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private v = new THREE.Vector3();

  /** Convex planar polygon (CCW seen from outside). */
  face(pts: THREE.Vector3[], shade: number, gloss: number, chalkTop: number): void {
    const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
    // in-plane axes for UVs (meters)
    const ax = new THREE.Vector3().subVectors(pts[1], pts[0]).normalize();
    const ay = new THREE.Vector3().crossVectors(n, ax);
    const base = this.pos.length / 3;
    const chalk = Math.max(0, n.y) * chalkTop;
    for (const p of pts) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.v.subVectors(p, pts[0]);
      this.uv.push(this.v.dot(ax), this.v.dot(ay));
      const ao = p.z < 0.02 ? 0.28 : 0;
      this.surf.push(chalk, 0, ao, gloss);
      this.col.push(shade, shade, shade);
    }
    for (let k = 1; k < pts.length - 1; k++) this.idx.push(base, base + k, base + k + 1);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 4));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

interface VolumeBuilt {
  geo: THREE.BufferGeometry;
  /** Largest face: centroid, normal, in-plane x axis, inradius (for decals + bolts). */
  face: { c: THREE.Vector3; n: THREE.Vector3; ax: THREE.Vector3; r: number };
}

/** Volume in unit size (radius ≈ 1). kind: 0 pyramid, 1 frustum, 2 wedge, 3 dual-tex pyramid. */
export function buildVolume(rng: Rng, kind: number): VolumeBuilt {
  const fb = new FacetBuilder();
  const faces: { pts: THREE.Vector3[] }[] = [];
  const addFace = (pts: THREE.Vector3[], shade: number, gloss: number) => {
    fb.face(pts, shade, gloss, 0.25);
    faces.push({ pts });
  };
  if (kind === 2) {
    // wedge: rectangle base, ridge offset toward the grip side
    const hx = rng.range(0.9, 1.15);
    const hy = rng.range(0.5, 0.7);
    const h = rng.range(0.38, 0.6);
    const ry = rng.range(-0.2, 0.25) * hy;
    const tx = rng.range(0.55, 0.85) * hx;
    const b0 = new THREE.Vector3(-hx, -hy, 0), b1 = new THREE.Vector3(hx, -hy, 0);
    const b2 = new THREE.Vector3(hx, hy, 0), b3 = new THREE.Vector3(-hx, hy, 0);
    const r0 = new THREE.Vector3(-tx, ry, h), r1 = new THREE.Vector3(tx, ry, h);
    addFace([b0, b1, r1, r0], 1, 0);
    addFace([b1, b2, r1], 0.86, 0);
    addFace([b2, b3, r0, r1], 1, 0);
    addFace([b3, b0, r0], 0.86, 0);
  } else {
    const n = rng.int(3, 5);
    const base: THREE.Vector3[] = [];
    const a0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2 + rng.range(-0.35, 0.35) * (Math.PI / n);
      const r = rng.range(0.82, 1.08);
      base.push(new THREE.Vector3(Math.cos(a) * r * 1.08, Math.sin(a) * r * 0.92, 0));
    }
    const h = rng.range(0.42, 0.72);
    const apex = new THREE.Vector3(rng.range(-0.25, 0.25), rng.range(-0.3, 0.15), h);
    if (kind === 1) {
      const t = rng.range(0.32, 0.5);
      const top = base.map((b) => new THREE.Vector3().lerpVectors(apex, new THREE.Vector3(b.x, b.y, h), t).setZ(h));
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        addFace([base[k], base[k2], top[k2], top[k]], k % 2 === 0 ? 1 : 0.9, 0);
      }
      addFace(top, 1, 0.15);
    } else {
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const dual = kind === 3 && k % 2 === 1;
        addFace([base[k], base[k2], apex], dual ? 0.42 : k % 2 === 0 ? 1 : 0.9, dual ? 1 : 0);
      }
    }
  }
  // largest face
  let best = faces[0];
  let bestA = -1;
  for (const f of faces) {
    let a = 0;
    for (let k = 1; k < f.pts.length - 1; k++) {
      a += new THREE.Vector3().subVectors(f.pts[k], f.pts[0]).cross(new THREE.Vector3().subVectors(f.pts[k + 1], f.pts[0])).length() / 2;
    }
    if (a > bestA) {
      bestA = a;
      best = f;
    }
  }
  const c = new THREE.Vector3();
  for (const p of best.pts) c.add(p);
  c.divideScalar(best.pts.length);
  const nrm = new THREE.Vector3().subVectors(best.pts[1], best.pts[0]).cross(new THREE.Vector3().subVectors(best.pts[2], best.pts[0])).normalize();
  // in-plane axis that is as horizontal as possible
  const ax = new THREE.Vector3(1, 0, 0).sub(nrm.clone().multiplyScalar(nrm.x)).normalize();
  let r = Infinity;
  for (let k = 0; k < best.pts.length; k++) {
    const a = best.pts[k];
    const b = best.pts[(k + 1) % best.pts.length];
    const e = new THREE.Vector3().subVectors(b, a);
    const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(c, a).dot(e) / e.lengthSq()));
    r = Math.min(r, c.distanceTo(a.clone().addScaledVector(e, t)));
  }
  return { geo: fb.build(), face: { c, n: nrm, ax, r } };
}

// ───────────────────────────── bolts ─────────────────────────────

let boltProto: THREE.BufferGeometry | null = null;

/** Hex-socket bolt + washer, axis +Z, base at z = 0 (absolute meters). */
function boltGeometry(): THREE.BufferGeometry {
  if (boltProto) return boltProto;
  const parts: THREE.BufferGeometry[] = [];
  const washer = new THREE.CylinderGeometry(0.0115, 0.0118, 0.003, 18, 1).rotateX(Math.PI / 2).translate(0, 0, 0.0015);
  const head = new THREE.CylinderGeometry(0.0082, 0.0086, 0.0065, 18, 1).rotateX(Math.PI / 2).translate(0, 0, 0.003 + 0.00325);
  const sock = new THREE.CircleGeometry(0.0042, 6).translate(0, 0, 0.0096);
  for (const [g, ao] of [[washer, 0.1], [head, 0], [sock, 0.92]] as const) {
    const n = g.getAttribute('position').count;
    const s = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) s.set([0, 1, ao, 0], i * 4);
    g.setAttribute('aSurf', new THREE.BufferAttribute(s, 4));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    parts.push(g);
  }
  boltProto = mergeGeometries(parts, false) as THREE.BufferGeometry;
  for (const p of parts) p.dispose();
  return boltProto;
}

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

function placeBolt(at: THREE.Vector3, normal: THREE.Vector3, scale = 1): THREE.BufferGeometry {
  const b = boltGeometry().clone();
  _q.setFromUnitVectors(Z, normal.clone().normalize());
  _m.compose(at.clone().addScaledVector(normal, -0.0025 * scale), _q, new THREE.Vector3(scale, scale, scale));
  b.applyMatrix4(_m);
  return b;
}

// ───────────────────────────── geometry cache ─────────────────────────────

export interface HoldGeometry {
  geo: THREE.BufferGeometry;
  /** Local-space footprint half extents (for AO decals and highlight rings). */
  halfX: number;
  halfY: number;
  /** Height of the hold above the wall (m). */
  depth: number;
  /** Logo decal placement for volumes (local space), if any. */
  face?: VolumeBuilt['face'];
}

const geoCache = new Map<string, HoldGeometry>();
/**
 * Every problem brings new hold shapes (type × variant × size), and route holds are drawn with the
 * cached geometry itself, so the cache keeps GPU buffers alive: an endless Send Train run would
 * grow it with every boulder. Past this many entries, the shapes the current wall does not use
 * are freed (least recently used first). Disposing is safe even if something still draws one: three.js simply
 * re-uploads it.
 */
const GEO_CACHE_MAX = 120;
/** HoldSet.build() generation, and the generation that last asked for each cache key. */
let geoEpoch = 0;
const geoUsed = new Map<string, number>();

function trimHoldCache(): void {
  if (geoCache.size <= GEO_CACHE_MAX) return;
  const target = Math.floor(GEO_CACHE_MAX * 0.75);
  for (const [key, entry] of geoCache) {
    if (geoCache.size <= target) break;
    if ((geoUsed.get(key) ?? -1) >= geoEpoch) continue; // on the wall right now
    entry.geo.dispose();
    geoCache.delete(key);
    geoUsed.delete(key);
  }
}

function ensureColor(g: THREE.BufferGeometry): void {
  if (!g.getAttribute('color')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
}

/**
 * Cached hold geometry in hold-local space, real size (meters).
 * lod 1 = background detail (fewer segments, no bolt) for the neighbouring walls.
 * lod 2 = deco holds on the main wall (two thirds of the segments, no bolt): dimmed and never
 *         touched, they don't need the route holds' tessellation at phone resolution.
 */
export function holdGeometry(type: HoldType, seed: number, size: number, lod: 0 | 1 | 2 = 0): HoldGeometry {
  const variant = Math.abs(seed) % HOLD_VARIANTS;
  const sb = Math.max(1, Math.round(size * 200));
  const key = `${type}:${variant}:${sb}:${lod}`;
  const segU = (n: number) => (lod === 1 ? Math.max(8, Math.round(n * 0.5)) : lod === 2 ? Math.max(10, Math.round(n * 0.66)) : n);
  geoUsed.set(key, geoEpoch);
  const hit = geoCache.get(key);
  if (hit) {
    // keep the Map in least-recently-used order for trimHoldCache()
    geoCache.delete(key);
    geoCache.set(key, hit);
    return hit;
  }
  const s = sb / 200;
  const rng = new Rng(0x4011d + variant * 7919 + type.length * 131);
  let built: Built | null = null;
  let vol: VolumeBuilt | null = null;
  let boltScale = 1;
  const noise = makeNoise(rng, 2.2, 6.5);
  switch (type) {
    case 'jug':
      built = sweep(JUG, { halfLen: rng.range(1.0, 1.3), segU: segU(18), taperP: rng.range(2.0, 2.8), bend: rng.range(-0.22, 0.05), zKeep: 0.6, noise, noiseAmp: 0.08, boltJ: 14, asym: rng.range(-1, 1) });
      break;
    case 'edge':
      built = sweep(EDGE, { halfLen: rng.range(1.35, 1.7), segU: segU(18), taperP: rng.range(3, 5), bend: rng.range(-0.12, 0.12), zKeep: 0.5, noise, noiseAmp: 0.06, boltJ: 4, asym: rng.range(-0.8, 0.8) });
      break;
    case 'crimp':
      built = sweep(CRIMP, { halfLen: rng.range(1.4, 1.9), segU: segU(16), taperP: rng.range(2.5, 4), bend: rng.range(-0.2, 0.2), zKeep: 0.5, noise, noiseAmp: 0.05, boltJ: 3, asym: rng.range(-0.8, 0.8) });
      boltScale = 0.8;
      break;
    case 'sloper':
      built = sweep(SLOPER, { halfLen: rng.range(0.95, 1.2), segU: segU(20), taperP: rng.range(1.9, 2.4), bend: rng.range(-0.1, 0.1), zKeep: 0.75, noise, noiseAmp: 0.08, boltJ: 5, asym: rng.range(-0.6, 0.6), detail: 0.5 });
      break;
    case 'pinch': {
      built = sweep(PINCH, { halfLen: rng.range(1.3, 1.6), segU: segU(18), taperP: rng.range(2.2, 3), bend: rng.range(-0.15, 0.15), zKeep: 0.6, noise, noiseAmp: 0.08, boltJ: 4, asym: rng.range(-1, 1) });
      built.geo.rotateZ(Math.PI / 2);
      break;
    }
    case 'pocket':
      built = lathe(POCKET, { seg: lod === 1 ? 12 : lod === 2 ? 16 : 22, sx: rng.range(1.0, 1.25), sy: rng.range(0.8, 0.95), holeShift: rng.range(0.08, 0.2), noise, noiseAmp: 0.06 });
      break;
    case 'foot':
      built = lathe(FOOT, { seg: lod === 1 ? 9 : lod === 2 ? 11 : 14, sx: rng.range(1.1, 1.5), sy: rng.range(0.7, 0.95), holeShift: 0, noise: makeNoise(rng, 1.5, 4), noiseAmp: 0.14 });
      boltScale = 0.55;
      break;
    case 'volume':
      vol = buildVolume(rng, variant % 4);
      break;
  }

  let geo: THREE.BufferGeometry;
  let face: VolumeBuilt['face'] | undefined;
  if (vol) {
    geo = vol.geo;
    geo.scale(s, s, s);
    face = { c: vol.face.c.clone().multiplyScalar(s), n: vol.face.n.clone(), ax: vol.face.ax.clone(), r: vol.face.r * s };
    // UVs are generated in unit space → meters
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
    // two bolts on the largest face
    const bolts: THREE.BufferGeometry[] = [];
    for (const off of lod ? [] : [-0.45, 0.45]) {
      _v.copy(face.c).addScaledVector(face.ax, off * face.r);
      bolts.push(placeBolt(_v, face.n, 0.9));
    }
    if (bolts.length) geo = mergeGeometries([geo, ...bolts], false) as THREE.BufferGeometry;
  } else if (built) {
    geo = built.geo;
    geo.scale(s, s, s);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
    geo.computeVertexNormals();
    ensureColor(geo);
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const nr = geo.getAttribute('normal') as THREE.BufferAttribute;
    _v.fromBufferAttribute(p, built.boltVertex);
    _n.fromBufferAttribute(nr, built.boltVertex).normalize();
    if (type === 'pocket') _n.set(0, 0.25, 1).normalize();
    const bscale = Math.min(1, Math.max(0.5, s / 0.06)) * boltScale;
    if (!lod) geo = mergeGeometries([geo, placeBolt(_v, _n, bscale)], false) as THREE.BufferGeometry;
  } else {
    geo = new THREE.SphereGeometry(s, 12, 8);
  }
  ensureSurfaceAttributes(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const bb = geo.boundingBox as THREE.Box3;
  const entry: HoldGeometry = {
    geo,
    halfX: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
    halfY: Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y)),
    depth: bb.max.z,
    face,
  };
  geoCache.set(key, entry);
  return entry;
}

/** World transform of a hold on the wall. */
export function holdMatrix(h: HoldDef, frame: WallFrame, out: THREE.Matrix4): THREE.Matrix4 {
  _q.setFromAxisAngle(Z, h.angle + Math.PI / 2).premultiply(frame.quaternion);
  frame.toWorldXYZ(h.x, h.y, -0.0015, _v);
  return out.compose(_v, _q, new THREE.Vector3(1, 1, 1));
}

const _hsl = { h: 0, s: 0, l: 0 };
/** Hold colours are judged in display (sRGB) terms: that is how the wall + palette were authored. */
const SRGB = THREE.SRGBColorSpace;

/** Lightness the charcoal wall reads at (HSL). Deco holds are pulled toward it so they recede. */
const WALL_L = 0.17;

/**
 * Deco colour: desaturated, and its lightness compressed toward the wall's (bright whites dim,
 * blacks lift a touch) so holds of other routes recede behind the current one. With a dark
 * `routeHex` (black route on a dark wall) the deco holds recede further still.
 */
export function decoColor(hex: string, out = new THREE.Color(), routeHex?: string): THREE.Color {
  let k = 0.56;
  if (routeHex) {
    out.set(routeHex).getHSL(_hsl, SRGB);
    if (_hsl.l < 0.25) k = 0.4;
  }
  out.set(hex);
  out.getHSL(_hsl, SRGB);
  out.setHSL(_hsl.h, _hsl.s * 0.5, WALL_L + (_hsl.l - WALL_L) * k, SRGB);
  return out;
}

/** Look of a route hold of colour `hex`: albedo, finish and the edge light that separates it from the wall. */
export interface RouteHoldLook {
  color: THREE.Color;
  roughness: number;
  edgeColor: THREE.Color;
  edgeStrength: number;
  edgePower: number;
  lift: number;
}

export function routeHoldLook(hex: string): RouteHoldLook {
  const color = new THREE.Color(hex);
  color.getHSL(_hsl, SRGB);
  const { h, s, l } = _hsl;
  if (l < 0.25) {
    // black on a charcoal wall: glossy plastic + a cool chalky edge light carry the silhouette
    color.setHSL(h, s, Math.max(l, 0.12), SRGB);
    return { color, roughness: 0.3, edgeColor: new THREE.Color('#B4C2D2'), edgeStrength: 0.42, edgePower: 3.0, lift: 0 };
  }
  if (s < 0.2 && l > 0.75) {
    // white already pops: just a warm hairline
    return { color, roughness: 0.5, edgeColor: new THREE.Color('#FFF1DE'), edgeStrength: 0.1, edgePower: 3.6, lift: 0.02 };
  }
  color.setHSL(h, Math.min(1, s * 1.08), l, SRGB);
  const edgeColor = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
  return { color, roughness: 0.48, edgeColor, edgeStrength: 0.3, edgePower: 2.8, lift: 0.07 };
}

// ───────────────────────────── per-boulder hold set ─────────────────────────────

export interface HoldSetOptions {
  /** Build every hold as its own mesh (editor), instead of merging deco holds. */
  separateAll?: boolean;
  /** Merged deco holds cast key-light shadows (default true; off below 'high' quality). */
  decoShadows?: boolean;
  gradeText?: string;
  name?: string;
}

/**
 * Builds and owns the meshes for one boulder's holds: one mesh per route hold, deco holds merged,
 * START/TOP tape + route card (one mesh), contact-AO decals (one mesh).
 */
export class HoldSet {
  readonly group = new THREE.Group();
  readonly meshes = new Map<string, THREE.Mesh>();
  readonly holds = new Map<string, HoldDef>();
  readonly geoms = new Map<string, HoldGeometry>();
  private decoMesh: THREE.Mesh | null = null;
  private tapeMesh: THREE.Mesh | null = null;
  private aoMesh: THREE.Mesh | null = null;
  private routeMats: SurfaceMaterial[] = [];
  private decoMat: SurfaceMaterial;
  private aoMat: THREE.MeshBasicMaterial;
  private tapeMat: THREE.MeshStandardMaterial | null = null;

  constructor(private frame: WallFrame) {
    this.group.name = 'holds';
    this.decoMat = createSurfaceMaterial({ roughness: 0.74, normalMap: speckleNormal(), normalScale: 0.35, normalRepeat: 22, envMapIntensity: 0.32 });
    this.aoMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: softBlobTexture(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }

  /** Rebuild everything for `holds` on `boulder`. */
  build(boulder: BoulderDef, holds: readonly HoldDef[], opts: HoldSetOptions = {}): void {
    this.clear();
    geoEpoch++;
    const deco: { h: HoldDef; g: HoldGeometry }[] = [];
    const m = new THREE.Matrix4();
    for (const h of holds) {
      const mergedDeco = h.role === 'deco' && !opts.separateAll;
      const g = holdGeometry(h.type, h.seed, h.size, mergedDeco ? 2 : 0);
      this.holds.set(h.id, h);
      this.geoms.set(h.id, g);
      if (h.role === 'deco' && !opts.separateAll) {
        deco.push({ h, g });
        continue;
      }
      const look = h.role === 'deco' ? null : routeHoldLook(h.color);
      const mat = createSurfaceMaterial({
        color: look ? look.color : decoColor(h.color, undefined, boulder.color),
        roughness: look ? look.roughness : 0.74,
        normalMap: speckleNormal(),
        normalScale: 0.38,
        normalRepeat: 22,
        rim: true,
        envMapIntensity: look ? 0.6 : 0.32,
      });
      if (look) {
        const u = mat.userData.surf;
        u.uEdgeColor.value.copy(look.edgeColor);
        u.uEdgeStrength.value = look.edgeStrength;
        u.uEdgePower.value = look.edgePower;
        u.uLift.value = look.lift;
      }
      this.routeMats.push(mat);
      const mesh = new THREE.Mesh(g.geo, mat);
      holdMatrix(h, this.frame, m);
      m.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `hold:${h.id}`;
      mesh.userData.holdId = h.id;
      this.meshes.set(h.id, mesh);
      this.group.add(mesh);
    }
    if (deco.length) {
      const parts: THREE.BufferGeometry[] = [];
      const col = new THREE.Color();
      for (const { h, g } of deco) {
        const geo = g.geo.clone();
        holdMatrix(h, this.frame, m);
        geo.applyMatrix4(m);
        decoColor(h.color, col, boulder.color);
        const c = geo.getAttribute('color') as THREE.BufferAttribute;
        for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * col.r, c.getY(i) * col.g, c.getZ(i) * col.b);
        parts.push(geo);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (merged) {
        this.decoMesh = new THREE.Mesh(merged, this.decoMat);
        this.decoMesh.castShadow = opts.decoShadows !== false;
        this.decoMesh.receiveShadow = true;
        this.decoMesh.name = 'holds:deco';
        this.group.add(this.decoMesh);
      }
    }
    this.buildAo(holds);
    this.buildTapes(boulder, holds, opts);
    trimHoldCache();
  }

  private buildAo(holds: readonly HoldDef[]): void {
    const n = holds.length;
    if (!n) return;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const idx: number[] = [];
    const q = new THREE.Quaternion();
    const c = new THREE.Vector3();
    const ax = new THREE.Vector3();
    const ay = new THREE.Vector3();
    let k = 0;
    for (const h of holds) {
      const g = this.geoms.get(h.id);
      if (!g) continue;
      q.setFromAxisAngle(Z, h.angle + Math.PI / 2).premultiply(this.frame.quaternion);
      const spread = h.type === 'volume' ? 1.08 : 1.3;
      const pad = h.type === 'volume' ? 0.035 : 0.018;
      ax.set(1, 0, 0).applyQuaternion(q).multiplyScalar(g.halfX * spread + pad);
      ay.set(0, 1, 0).applyQuaternion(q).multiplyScalar(g.halfY * spread + pad);
      this.frame.toWorldXYZ(h.x, h.y, 0.0012, c);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let i = 0; i < 4; i++) {
        const [sx, sy] = corners[i];
        pos[(k * 4 + i) * 3] = c.x + ax.x * sx + ay.x * sy;
        pos[(k * 4 + i) * 3 + 1] = c.y + ax.y * sx + ay.y * sy;
        pos[(k * 4 + i) * 3 + 2] = c.z + ax.z * sx + ay.z * sy;
        uv[(k * 4 + i) * 2] = (sx + 1) / 2;
        uv[(k * 4 + i) * 2 + 1] = (sy + 1) / 2;
      }
      const b = k * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      k++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.aoMesh = new THREE.Mesh(g, this.aoMat);
    this.aoMesh.renderOrder = 1;
    this.aoMesh.name = 'holds:ao';
    this.group.add(this.aoMesh);
  }

  private buildTapes(boulder: BoulderDef, holds: readonly HoldDef[], opts: HoldSetOptions): void {
    const starts = holds.filter((h) => h.role === 'start');
    const tops = holds.filter((h) => h.role === 'top');
    if (!starts.length && !tops.length) return;
    const atlas = createLabelAtlas(boulder.color, opts.gradeText ?? `V${boulder.grade}`, opts.name ?? boulder.name, boulder.seed);
    this.tapeMat = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      transparent: true,
      alphaTest: 0.35,
      roughness: 0.48,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const quads: { cx: number; cy: number; w: number; h: number; rot: number; r: AtlasRect }[] = [];
    const rng = new Rng(boulder.seed ^ 0x7a9e5);
    for (const h of starts) {
      const g = this.geoms.get(h.id);
      const below = (g ? Math.max(g.halfX, g.halfY) * 0.85 : h.size) + 0.05;
      const w = 0.21;
      quads.push({ cx: h.x + rng.range(-0.02, 0.02), cy: h.y - below, w, h: w / atlas.aspect.start, rot: rng.range(-0.1, 0.1), r: atlas.start });
    }
    for (const h of tops) {
      const g = this.geoms.get(h.id);
      const above = (g ? Math.max(g.halfX, g.halfY) * 0.85 : h.size) + 0.055;
      const w = 0.19;
      quads.push({ cx: h.x + rng.range(-0.02, 0.02), cy: h.y + above, w, h: w / atlas.aspect.top, rot: rng.range(-0.08, 0.08), r: atlas.top });
    }
    if (starts.length) {
      const minX = Math.min(...starts.map((s) => s.x));
      const cardW = 0.22;
      const cx = Math.max(-boulder.width / 2 + 0.2, Math.min(boulder.width / 2 - 0.2, minX - 0.32));
      quads.push({ cx, cy: 0.66, w: cardW, h: cardW / atlas.aspect.card, rot: rng.range(-0.03, 0.03), r: atlas.card });
    }
    const pos = new Float32Array(quads.length * 12);
    const nrm = new Float32Array(quads.length * 12);
    const uv = new Float32Array(quads.length * 8);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    quads.forEach((qd, i) => {
      const cs = Math.cos(qd.rot);
      const sn = Math.sin(qd.rot);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      corners.forEach(([sx, sy], k) => {
        const lx = (sx * qd.w) / 2;
        const ly = (sy * qd.h) / 2;
        this.frame.toWorldXYZ(qd.cx + lx * cs - ly * sn, qd.cy + lx * sn + ly * cs, 0.0018, p);
        pos.set([p.x, p.y, p.z], (i * 4 + k) * 3);
        nrm.set([this.frame.normal.x, this.frame.normal.y, this.frame.normal.z], (i * 4 + k) * 3);
        uv.set([sx < 0 ? qd.r.u0 : qd.r.u1, sy < 0 ? qd.r.v0 : qd.r.v1], (i * 4 + k) * 2);
      });
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.tapeMesh = new THREE.Mesh(g, this.tapeMat);
    this.tapeMesh.receiveShadow = true;
    this.tapeMesh.renderOrder = 2;
    this.tapeMesh.name = 'holds:tape';
    this.group.add(this.tapeMesh);
  }

  /** Toggle key-light shadows of the merged deco holds (quality changes). */
  setDecoShadows(on: boolean): void {
    if (this.decoMesh) this.decoMesh.castShadow = on;
  }

  /** Rim glow on a route hold mesh (highlights). strength 0 = off. */
  setRim(holdId: string, color: THREE.Color, strength: number, power = 2.2): void {
    const mesh = this.meshes.get(holdId);
    if (!mesh) return;
    const surf = (mesh.material as SurfaceMaterial).userData.surf;
    surf.uRimColor.value.copy(color);
    surf.uRimStrength.value = strength;
    surf.uRimPower.value = power;
  }

  clear(): void {
    for (const m of this.routeMats) m.dispose();
    this.routeMats = [];
    for (const mesh of this.meshes.values()) this.group.remove(mesh);
    this.meshes.clear();
    this.holds.clear();
    this.geoms.clear();
    for (const mesh of [this.decoMesh, this.aoMesh, this.tapeMesh]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    if (this.tapeMat) {
      this.tapeMat.map?.dispose();
      this.tapeMat.dispose();
      this.tapeMat = null;
    }
    this.decoMesh = this.aoMesh = this.tapeMesh = null;
  }

  dispose(): void {
    this.clear();
    this.decoMat.dispose();
    this.aoMat.dispose();
  }
}

/** Frees all cached hold geometries (call on renderer dispose). */
export function disposeHoldCache(): void {
  for (const g of geoCache.values()) g.geo.dispose();
  geoCache.clear();
  geoUsed.clear();
  boltProto?.dispose();
  boltProto = null;
}

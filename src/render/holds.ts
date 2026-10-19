// Procedural climbing holds + the per-boulder hold set.
//
// Hold-local frame: x → right, y → the GRIP side (the incut faces +y), z → out of the wall.
// A hold's back is flat on z = 0. In the wall, a hold is rotated about its normal by
// (angle + PI/2), so the classic incut-on-top hold (angle = −PI/2) needs no rotation and an
// undercling (angle = +PI/2) is flipped — the good side always faces away from the body.
//
// In the game, route holds are merged per band of SHADOW_BAND m up the wall (one draw per band; a
// lead tower's far bands drop to coarse geometry through THREE.LOD), with per-hold highlight rims
// read from a small data texture; wooden route holds and the editor's holds stay separate meshes.
// Deco holds are merged into one mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoulderDef, HoldDef, HoldShape, HoldType } from '../core/types';
import { Rng } from '../core/rng';
import type { WallFrame } from './wall-frame';
import { createSurfaceMaterial, ensureSurfaceAttributes, type SurfaceMaterial } from './shading';
import { createLabelAtlas, softBlobTexture, speckleNormal, type AtlasRect } from './textures';
import { bakeCurvature } from './curvature';
import type { HoldInfo } from './climber';

export const HOLD_VARIANTS = 6;

/** Hold tessellation: 0 route holds, 1 neighbour walls, 2 main-wall deco, 3 the lead hall's far faces. */
export type HoldLod = 0 | 1 | 2 | 3;

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
  pp(0.5, 0.58, 0, 0.35), pp(0.4, 0.55, 0.12, 0.6), pp(0.33, 0.43, 0.45, 0.55), pp(0.3, 0.28, 0.68, 0.45),
  pp(0.24, 0.16, 0.82, 0.35), pp(0.12, 0.12, 0.85, 0.25), pp(0.0, 0.11, 0.85, 0.25),
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
      // chalk lies in patches (where hands actually go), never as an even coat
      const patch = Math.max(0, Math.min(1, 0.55 + 0.6 * o.noise(x * 2.6 + 3.1, y * 2.6, z * 2.6)));
      surf[k * 4] = p.chalk * (0.55 + 0.45 * s) * patch;
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
  /** Pockets: x / y scale of the opening (r < 0.5 of the profile) relative to the rim. */
  holeSX?: number;
  holeSY?: number;
  /** Pockets: z of the pocket floor (unit; the profile's inner bottom). */
  floor?: number;
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
      // the opening (inside the rim) scales on its own: a mono is a round hole, a 4-finger pocket a wide slot
      const hole = Math.min(1, Math.max(0, (0.62 - p.y) / 0.3));
      const hsx = 1 + ((o.holeSX ?? 1) - 1) * hole;
      const hsy = 1 + ((o.holeSY ?? 1) - 1) * hole;
      let x = p.y * ct * o.sx * hsx;
      let y = p.y * st * o.sy * hsy + o.holeShift * inner;
      let z = p.z;
      // deeper / shallower pocket floor
      if (o.floor !== undefined && p.y < 0.36) z = Math.min(z, o.floor + (p.z - 0.11) * 0.5);
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

/** Volume shapes buildVolume knows (variant % VOLUME_KINDS). */
export const VOLUME_KINDS = 6;

/**
 * Volume in unit size (radius ≈ 1). kind: 0 pyramid, 1 frustum, 2 wedge, 3 dual-tex pyramid,
 * 4 faceted half-dome, 5 ridge (a long prism with hipped ends).
 */
export function buildVolume(rng: Rng, kind: number): VolumeBuilt {
  const fb = new FacetBuilder();
  const faces: { pts: THREE.Vector3[] }[] = [];
  const addFace = (pts: THREE.Vector3[], shade: number, gloss: number) => {
    fb.face(pts, shade, gloss, 0.25);
    faces.push({ pts });
  };
  if (kind === 4) {
    // faceted half-dome: rings of flat facets (a geodesic look that matches the other volumes)
    const seg = 9;
    const rings = 3;
    const R = rng.range(0.92, 1.05);
    const H = rng.range(0.5, 0.68);
    const ringPts: THREE.Vector3[][] = [];
    const a0 = rng.range(0, Math.PI);
    for (let r = 0; r <= rings; r++) {
      const phi = (r / rings) * (Math.PI / 2) * 0.92;
      const rr = Math.cos(phi) * R;
      const zz = Math.sin(phi) * H;
      const ring: THREE.Vector3[] = [];
      for (let k = 0; k < seg; k++) {
        const a = a0 + ((k + (r % 2) * 0.5) / seg) * Math.PI * 2;
        ring.push(new THREE.Vector3(Math.cos(a) * rr * 1.06, Math.sin(a) * rr * 0.94, zz));
      }
      ringPts.push(ring);
    }
    for (let r = 0; r < rings; r++) {
      const A = ringPts[r];
      const B = ringPts[r + 1];
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        const sh = (k + r) % 2 === 0 ? 1 : 0.9;
        if (r % 2 === 0) {
          addFace([A[k], A[k2], B[k]], sh, 0);
          addFace([A[k2], B[k2], B[k]], sh * 0.96, 0);
        } else {
          addFace([A[k], A[k2], B[k2]], sh, 0);
          addFace([A[k], B[k2], B[k]], sh * 0.96, 0);
        }
      }
    }
    addFace(ringPts[rings], 1, 0.1);
  } else if (kind === 5) {
    // ridge: a long triangular prism, hipped at both ends
    const hx = rng.range(1.15, 1.4);
    const hy = rng.range(0.42, 0.55);
    const h = rng.range(0.42, 0.58);
    const tx = hx - rng.range(0.3, 0.45);
    const ry = rng.range(-0.12, 0.12) * hy;
    const b0 = new THREE.Vector3(-hx, -hy, 0), b1 = new THREE.Vector3(hx, -hy, 0);
    const b2 = new THREE.Vector3(hx, hy, 0), b3 = new THREE.Vector3(-hx, hy, 0);
    const r0 = new THREE.Vector3(-tx, ry, h), r1 = new THREE.Vector3(tx, ry, h);
    addFace([b0, b1, r1, r0], 1, 0);
    addFace([b1, b2, r1], 0.84, 0);
    addFace([b2, b3, r0, r1], 0.94, 0);
    addFace([b3, b0, r0], 0.84, 0);
  } else if (kind === 2) {
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

// ───────────────────────────── variety (Phase B hold catalogue) ─────────────────────────────

/** The product details of a hold that change its geometry (HoldDef fields; all optional). */
export interface HoldVariant {
  shape?: HoldShape;
  edgeDepthMm?: number;
  lipAngle?: number;
  fingers?: 1 | 2 | 3 | 4;
}

/** A deep closed bucket: a high curled lip over a scooped cavity (unit size). */
const BUCKET: ProfilePt[] = [
  pp(-0.85, 0.0, 0.4), pp(-0.82, 0.25, 0.15), pp(-0.7, 0.5, 0, 0.02), pp(-0.45, 0.72, 0, 0.03),
  pp(-0.15, 0.86, 0, 0.05), pp(0.15, 0.92, 0, 0.1), pp(0.42, 0.9, 0, 0.3), pp(0.58, 0.8, 0, 0.55),
  pp(0.63, 0.66, 0.05, 0.62), pp(0.56, 0.56, 0.25, 0.56), pp(0.4, 0.5, 0.5, 0.46), pp(0.22, 0.42, 0.66, 0.36),
  pp(0.13, 0.28, 0.72, 0.3), pp(0.17, 0.14, 0.64, 0.26), pp(0.34, 0.06, 0.52, 0.2), pp(0.55, 0.02, 0.42, 0.12),
  pp(0.7, 0.0, 0.4, 0.08),
];

/**
 * Edge / crimp cross-section from its product numbers (unit size, s = hold radius in m): the shelf
 * the fingers sit on is `depthMm` deep (z extent at the lip) and tilts by `lipDeg` (+ incut: the
 * shelf drops toward the wall behind the lip, a hook; − slopey: it falls away over the lip).
 * `body` is the height of the hold under the lip (unit), `round` the lip radius (unit).
 */
function edgeProfile(s: number, depthMm: number, lipDeg: number, body: number, round: number): ProfilePt[] {
  const D = Math.min(0.95, Math.max(0.07, depthMm / 1000 / s));
  const yL = 0.3;
  const tl = Math.tan((Math.max(-30, Math.min(30, lipDeg)) * Math.PI) / 180);
  const yW = yL - D * tl;
  const r = Math.min(round, D * 0.45);
  const shelf = (t: number) => yL + (yW - yL) * t;
  return [
    pp(-body, 0.0, 0.4),
    pp(-body * 0.95, D * 0.3 + 0.03, 0.15),
    pp(-body * 0.72, D * 0.72 + 0.02, 0, 0.02),
    pp(-body * 0.3, D * 0.93 + 0.015, 0, 0.04),
    pp(yL - r * 2.2, D + 0.01, 0, 0.14),
    pp(yL - r * 0.6, D - r * 0.25, 0, 0.5),
    pp(yL, D - r, 0.04, 0.66),
    pp(shelf(0.3) + 0.005, D * 0.7 - r * 0.5, 0.12, 0.72),
    pp(shelf(0.65), D * 0.35, 0.3, 0.6),
    pp(yW, 0.0, 0.45, 0.32),
  ];
}

/** Sloper dome: `lipDeg` −20 (friendly: a boxier shoulder on the grip side) … −40 (a round, flat dome). */
function sloperProfile(lipDeg: number, flat = 1): ProfilePt[] {
  const k = Math.max(0, Math.min(1, (-lipDeg - 18) / 24));
  const e = 0.55 + 0.8 * k; // superellipse exponent: < 1 boxy, > 1 pointed / flat-sided
  const peak = 0.16 * k; // the crown moves toward the wall side on hard slopers
  const out: ProfilePt[] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * i) / n;
    const y = -Math.cos(a) * 0.95;
    const sn = Math.pow(Math.sin(a), e);
    const z = 0.6 * flat * sn * (1 - (0.16 + 0.2 * k) * Math.max(0, y - peak));
    const chalk = Math.max(0, Math.min(1, (y + 0.1) / 0.9)) * 0.34;
    out.push(pp(y, z, i === 0 || i === n ? 0.38 : i === 1 || i === n - 1 ? 0.12 : 0, chalk));
  }
  return out;
}

/** A horn: a tapered post standing out of the wall, curling toward the grip side; you wrap it. */
function horn(rng: Rng, lod: 0 | 1 | 2): Built {
  const nU = lod === 1 ? 8 : lod === 2 ? 10 : 14; // around
  const nV = lod === 1 ? 6 : 9; // along
  const L = rng.range(1.25, 1.55); // unit length out of the wall
  const bend = rng.range(0.55, 0.8);
  const r0 = rng.range(0.27, 0.33);
  const pos: number[] = [];
  const uv: number[] = [];
  const surf: number[] = [];
  const idx: number[] = [];
  const noise = makeNoise(rng, 2, 5);
  for (let j = 0; j <= nV; j++) {
    const t = j / nV;
    // centreline: out along z, curving up (+y) toward the tip
    const cz = L * Math.sin(t * 1.2) / Math.sin(1.2);
    const cy = bend * t * t;
    // tangent for the ring frame (in the y–z plane)
    const tz = (L * 1.2 * Math.cos(t * 1.2)) / Math.sin(1.2);
    const ty = 2 * bend * t;
    const tl = Math.hypot(tz, ty) || 1;
    const ny = tz / tl; // ring "up" axis ⟂ tangent in the y–z plane
    const nz = -ty / tl;
    // flared foot, tapering shaft, rounded tip
    const flare = 1 + 0.55 * Math.pow(Math.max(0, 1 - t / 0.18), 2);
    const tip = t > 0.86 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.86) / 0.14, 2))) : 1;
    const r = r0 * (1 - 0.5 * t) * flare * (j === nV ? 0.02 : tip);
    for (let i = 0; i < nU; i++) {
      const a = (i / nU) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const lump = 1 + 0.07 * noise(ca * 2, sa * 2, t * 3);
      const x = ca * r * lump;
      const y = cy + sa * r * lump * ny;
      let z = cz + sa * r * lump * nz;
      if (j === 0) z = 0;
      pos.push(x, y, Math.max(0, z));
      uv.push(a * r0, t * L);
      // chalk on the top / grip side of the shaft, AO at the wall
      const grip = Math.max(0, sa) * (0.25 + 0.5 * t);
      surf.push(grip * 0.7, 0, j === 0 ? 0.45 : t < 0.12 ? 0.18 : 0, 0);
    }
  }
  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      const i2 = (i + 1) % nU;
      const a = j * nU + i;
      const b = j * nU + i2;
      const c = (j + 1) * nU + i;
      const d = (j + 1) * nU + i2;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSurf', new THREE.Float32BufferAttribute(surf, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  // bolt through the foot on the lower side (washer just clear of the shaft)
  return { geo: g, boltVertex: Math.floor(nU * 0.75) };
}

/** A tiny screw-on foot chip: an angular faceted wedge, flat-shaded. */
function chip(rng: Rng): THREE.BufferGeometry {
  const fb = new FacetBuilder();
  const n = rng.int(4, 6);
  const a0 = rng.range(0, Math.PI * 2);
  const base: THREE.Vector3[] = [];
  const top: THREE.Vector3[] = [];
  const h = rng.range(0.42, 0.6);
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const r = rng.range(0.85, 1.1);
    const x = Math.cos(a) * r * 1.25;
    const y = Math.sin(a) * r * 0.8;
    base.push(new THREE.Vector3(x, y, 0));
    // the top facet leans toward the stepping side (+y): thicker at the top edge
    top.push(new THREE.Vector3(x * 0.55, y * 0.55 + 0.08, h * (0.7 + 0.3 * Math.max(0, Math.sin(a)))));
  }
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    fb.face([base[k], base[k2], top[k2], top[k]], 0.92, 0, 0);
  }
  fb.face(top, 1, 0, 0.12);
  return fb.build();
}

/**
 * Dual-tex / wood / macro finishes, per vertex (they survive the deco merge): dual-tex keeps a matte,
 * slightly darker textured zone on the grip side and a glossy smooth zone over the rest, split by a
 * fine seam; wood gets a warm grain (vertex colour) and loses most of its chalk shine.
 */
function applyFinish(g: THREE.BufferGeometry, finish: 'dual' | 'wood', halfY: number, seed: number): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const surf = g.getAttribute('aSurf') as THREE.BufferAttribute;
  let col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col) {
    col = new THREE.BufferAttribute(new Float32Array(p.count * 3).fill(1), 3);
    g.setAttribute('color', col);
  }
  const rng = new Rng(seed ^ 0x3d7);
  const ph = rng.range(0, 6.28);
  const freq = rng.range(130, 190);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    if (finish === 'dual') {
      // grip zone: the upper 45% (the side the fingers / palm go)
      const t = y / Math.max(1e-4, halfY);
      const grip = THREE.MathUtils.smoothstep(t, 0.02, 0.12);
      const seam = Math.exp(-Math.pow((t - 0.07) / 0.035, 2));
      const tone = (0.78 + 0.22 * (1 - grip)) * (1 - 0.35 * seam);
      col.setXYZ(i, col.getX(i) * tone, col.getY(i) * tone, col.getZ(i) * tone);
      if (surf) surf.setW(i, (1 - grip) * 0.8);
    } else {
      // growth rings: bands across the long axis, warped by a low-frequency wobble
      const w = Math.sin(x * 9 + ph) * 0.004 + Math.sin(z * 13 + ph * 2) * 0.003;
      const ring = 0.5 + 0.5 * Math.sin((y + w) * freq + ph);
      const fine = 0.5 + 0.5 * Math.sin((y * 2.7 + x * 0.4 + w * 3) * freq * 2.3);
      const v = 0.7 + 0.26 * Math.pow(ring, 2.5) + 0.07 * fine;
      col.setXYZ(i, col.getX(i) * v * 1.05, col.getY(i) * v, col.getZ(i) * v * 0.88);
      if (surf) surf.setX(i, surf.getX(i) * 0.4);
    }
  }
  col.needsUpdate = true;
  if (surf) surf.needsUpdate = true;
}

// ───────────────────────────── bolts ─────────────────────────────

let boltProto: THREE.BufferGeometry | null = null;

/** Hex-socket bolt + washer, axis +Z, base at z = 0 (absolute meters). */
function boltGeometry(): THREE.BufferGeometry {
  if (boltProto) return boltProto;
  const parts: THREE.BufferGeometry[] = [];
  const washer = new THREE.CylinderGeometry(0.0115, 0.0118, 0.003, 12, 1).rotateX(Math.PI / 2).translate(0, 0, 0.0015);
  const head = new THREE.CylinderGeometry(0.0082, 0.0086, 0.0065, 12, 1).rotateX(Math.PI / 2).translate(0, 0, 0.003 + 0.00325);
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
  /**
   * Vertices of the hold itself at the start of `geo` (the bolt is merged after them): the contact
   * surface hands and feet are placed on (render/grip.ts).
   */
  ownVerts: number;
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
 * lod 3 = the far faces of the 15 m lead hall (about a quarter of the segments).
 * `v` (HoldDef shape / edgeDepthMm / lipAngle / fingers) picks the product variant: a deep incut
 * edge reads differently from a 7 mm crimp, a mono from a three-finger pocket, a horn, a rail,
 * a bucket, a chip, a macro, dual-tex and wooden holds each have their own build or finish.
 */
export function holdGeometry(type: HoldType, seed: number, size: number, lod: HoldLod = 0, v: HoldVariant = {}): HoldGeometry {
  const variant = Math.abs(seed) % HOLD_VARIANTS;
  const sb = Math.max(1, Math.round(size * 200));
  const shape = v.shape;
  // quantised product numbers keep the cache small (2 mm depth steps, 5° lip steps)
  const dq = v.edgeDepthMm !== undefined ? Math.round(v.edgeDepthMm / 2) : -1;
  const lq = v.lipAngle !== undefined ? Math.round(v.lipAngle / 5) : 99;
  const fq = v.fingers ?? 0;
  const key = `${type}:${shape ?? '-'}:${variant}:${sb}:${lod}:${dq}:${lq}:${fq}`;
  const segU = (n: number) =>
    lod === 3 ? Math.max(5, Math.round(n * 0.28)) : lod === 1 ? Math.max(6, Math.round(n * 0.4)) : lod === 2 ? Math.max(10, Math.round(n * 0.66)) : n;
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
  let flat: THREE.BufferGeometry | null = null;
  let boltScale = 1;
  const noise = makeNoise(rng, 2.2, 6.5);
  const depth = (fallback: number) => (dq >= 0 ? dq * 2 : fallback);
  const lip = (fallback: number) => (lq !== 99 ? lq * 5 : fallback);
  switch (type) {
    case 'jug':
      if (shape === 'bucket') {
        built = sweep(BUCKET, { halfLen: rng.range(0.85, 1.05), segU: segU(20), taperP: rng.range(1.8, 2.3), bend: rng.range(-0.3, -0.1), zKeep: 0.72, noise, noiseAmp: 0.07, boltJ: 13, asym: rng.range(-0.6, 0.6) });
      } else {
        built = sweep(JUG, { halfLen: rng.range(1.0, 1.3), segU: segU(18), taperP: rng.range(2.0, 2.8), bend: rng.range(-0.22, 0.05), zKeep: 0.6, noise, noiseAmp: 0.08, boltJ: 14, asym: rng.range(-1, 1) });
      }
      break;
    case 'edge': {
      const rail = shape === 'rail';
      const prof = edgeProfile(s, depth(rail ? 22 : 24), lip(8), rail ? 0.42 : 0.52, 0.05);
      built = sweep(prof, {
        halfLen: rail ? rng.range(3.4, 4.2) : rng.range(1.7, 2.15),
        segU: segU(rail ? 28 : 20),
        taperP: rail ? rng.range(7, 10) : rng.range(4.5, 6.5),
        bend: rail ? rng.range(-0.06, 0.06) : rng.range(-0.14, 0.1),
        zKeep: rail ? 0.25 : 0.38,
        noise,
        noiseAmp: rail ? 0.025 : 0.032,
        boltJ: 2,
        asym: rng.range(-0.7, 0.7),
        detail: 0.12,
      });
      break;
    }
    case 'crimp': {
      const micro = shape === 'micro';
      const prof = edgeProfile(s, depth(micro ? 6 : 10), lip(4), micro ? 0.3 : 0.4, micro ? 0.012 : 0.025);
      built = sweep(prof, { halfLen: micro ? rng.range(1.1, 1.5) : rng.range(1.8, 2.4), segU: segU(18), taperP: rng.range(3.2, 5), bend: rng.range(-0.25, 0.25), zKeep: 0.4, noise, noiseAmp: micro ? 0.018 : 0.026, boltJ: 2, asym: rng.range(-0.8, 0.8), detail: 0.1 });
      boltScale = micro ? 0.6 : 0.8;
      break;
    }
    case 'sloper': {
      const macro = shape === 'macro';
      built = sweep(sloperProfile(lip(-32), macro ? 0.72 : 1), {
        halfLen: macro ? rng.range(1.45, 1.8) : rng.range(0.95, 1.2),
        segU: segU(macro ? 24 : 20),
        taperP: macro ? rng.range(2.4, 3.2) : rng.range(1.9, 2.4),
        bend: rng.range(-0.1, 0.1),
        zKeep: macro ? 0.85 : 0.75,
        noise,
        noiseAmp: macro ? 0.05 : 0.08,
        boltJ: 5,
        asym: rng.range(-0.6, 0.6),
        detail: 0.5,
      });
      break;
    }
    case 'pinch': {
      if (shape === 'horn') {
        built = horn(rng, lod === 3 ? 1 : lod);
        boltScale = 0.8;
      } else {
        built = sweep(PINCH, { halfLen: rng.range(1.3, 1.6), segU: segU(18), taperP: rng.range(2.2, 3), bend: rng.range(-0.15, 0.15), zKeep: 0.6, noise, noiseAmp: 0.08, boltJ: 4, asym: rng.range(-1, 1) });
        built.geo.rotateZ(Math.PI / 2);
      }
      break;
    }
    case 'pocket': {
      // the opening fits the fingers it takes: a round mono, a two-finger slot, a wide 3–4 finger pocket
      const f = fq || 3;
      const hx = f === 1 ? 0.42 : f === 2 ? 0.72 : f === 3 ? 1 : 1.25;
      const hy = f === 1 ? 0.55 : f === 2 ? 0.6 : f === 3 ? 0.68 : 0.78;
      const floor = dq >= 0 ? Math.max(0.05, Math.min(0.42, 0.58 - (dq * 2) / 1000 / s)) : 0.11;
      built = lathe(POCKET, {
        seg: lod === 3 ? 9 : lod === 1 ? 12 : lod === 2 ? 16 : 22,
        sx: rng.range(1.0, 1.25) * (f >= 4 ? 1.15 : 1),
        sy: rng.range(0.8, 0.95),
        holeShift: rng.range(0.08, 0.2),
        noise,
        noiseAmp: 0.06,
        holeSX: hx,
        holeSY: hy,
        floor,
      });
      break;
    }
    case 'foot':
      if (shape === 'chip') {
        flat = chip(rng);
        boltScale = 0.45;
      } else {
        built = lathe(FOOT, { seg: lod === 3 ? 7 : lod === 1 ? 9 : lod === 2 ? 11 : 14, sx: rng.range(1.1, 1.5), sy: rng.range(0.7, 0.95), holeShift: 0, noise: makeNoise(rng, 1.5, 4), noiseAmp: 0.14 });
        boltScale = 0.55;
      }
      break;
    case 'volume':
      vol = buildVolume(rng, shape === 'dual-tex' ? 3 : variant % VOLUME_KINDS);
      break;
  }

  let geo: THREE.BufferGeometry;
  let face: VolumeBuilt['face'] | undefined;
  let ownVerts = 0;
  if (vol) {
    geo = vol.geo;
    geo.scale(s, s, s);
    face = { c: vol.face.c.clone().multiplyScalar(s), n: vol.face.n.clone(), ax: vol.face.ax.clone(), r: vol.face.r * s };
    // UVs are generated in unit space → meters
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
    ownVerts = geo.getAttribute('position').count;
    // two bolts on the largest face
    const bolts: THREE.BufferGeometry[] = [];
    for (const off of lod ? [] : [-0.45, 0.45]) {
      _v.copy(face.c).addScaledVector(face.ax, off * face.r);
      bolts.push(placeBolt(_v, face.n, 0.9));
    }
    if (bolts.length) geo = mergeGeometries([geo, ...bolts], false) as THREE.BufferGeometry;
  } else if (flat) {
    geo = flat;
    geo.scale(s, s, s);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
    ownVerts = geo.getAttribute('position').count;
    if (!lod) geo = mergeGeometries([geo, placeBolt(_v.set(0, 0.04 * s, 0.5 * s), _n.set(0, 0.2, 1).normalize(), Math.max(0.4, s / 0.06) * boltScale)], false) as THREE.BufferGeometry;
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
    if (shape === 'horn') {
      // through the flared foot, below the shaft
      _v.set(0, -0.5 * s, 0.1 * s);
      _n.set(0, -0.35, 1).normalize();
    }
    const bscale = Math.min(1, Math.max(0.5, s / 0.06)) * boltScale;
    ownVerts = geo.getAttribute('position').count;
    if (!lod) geo = mergeGeometries([geo, placeBolt(_v, _n, bscale)], false) as THREE.BufferGeometry;
  } else {
    geo = new THREE.SphereGeometry(s, 12, 8);
    ownVerts = geo.getAttribute('position').count;
  }
  ensureSurfaceAttributes(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const bb = geo.boundingBox as THREE.Box3;
  const halfY = Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y));
  if (shape === 'dual-tex' || shape === 'macro') applyFinish(geo, 'dual', halfY, seed);
  else if (shape === 'wood') applyFinish(geo, 'wood', halfY, seed);
  // thin-hold shading (research §4.4): per-vertex curvature, so lips and thin edges read at phone scale
  bakeCurvature(geo);
  const entry: HoldGeometry = {
    geo,
    halfX: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)),
    halfY,
    depth: bb.max.z,
    face,
    ownVerts,
  };
  geoCache.set(key, entry);
  return entry;
}

/** The variant fields of a hold (for holdGeometry). */
export function holdVariant(h: Pick<HoldDef, 'shape' | 'edgeDepthMm' | 'lipAngle' | 'fingers'>): HoldVariant {
  return { shape: h.shape, edgeDepthMm: h.edgeDepthMm, lipAngle: h.lipAngle, fingers: h.fingers };
}

const _pq = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

/** World transform of a hold on the wall (bolted to the panel at its y: that panel's sharp frame). */
export function holdMatrix(h: HoldDef, frame: WallFrame, out: THREE.Matrix4): THREE.Matrix4 {
  _q.setFromAxisAngle(Z, h.angle + Math.PI / 2).premultiply(frame.quaternionAt(h.y, _pq));
  frame.toWorldXYZ(h.x, h.y, 0, _v).addScaledVector(frame.normalAt(h.y, _n, false), -0.0015);
  return out.compose(_v, _q, ONE);
}

/** Panels meeting at a fold this far apart (deg) count as a lip / an inside corner for foldClampY. */
const FOLD_MIN = 8;
/** Clearance (m) a hold keeps from a fold, and the most a hold is moved to get it. */
const FOLD_GAP = 0.006;
const FOLD_MAX_SHIFT = 0.12;

/**
 * Render-side clamp for holds next to a convex fold (a roof lip, the top of a steep section easing
 * off, a slab bulge): a hold is bolted flat to its own panel, so a footprint reaching past such a
 * fold would stick out into the air beyond the lip. The hold slides back along its panel until its
 * footprint ends just short of the fold (at most FOLD_MAX_SHIFT); a panel shorter than the hold keeps
 * it centred. Inside corners (the wall steepening) are left alone: a hold sitting into the corner
 * reads naturally there, and the sim's contact point stays exactly on the drawn hold.
 * Returns the surface y to draw the hold at.
 */
export function foldClampY(h: Pick<HoldDef, 'y' | 'angle'>, halfX: number, halfY: number, frame: WallFrame): number {
  if (!frame.folded) return h.y;
  const spans = frame.spans();
  const i = frame.panelIndex(h.y);
  const sp = spans[i];
  if (!sp) return h.y;
  const rot = h.angle + Math.PI / 2;
  const ey = Math.abs(Math.sin(rot)) * halfX + Math.abs(Math.cos(rot)) * halfY;
  const prev = spans[i - 1];
  const next = spans[i + 1];
  // convex: going up, the wall eases off (the panel above is less steep than this one, or this one
  // is less steep than the panel below)
  const lo = prev && prev.angle - sp.angle >= FOLD_MIN ? sp.y0 + FOLD_GAP + ey : -Infinity;
  const hi = next && sp.angle - next.angle >= FOLD_MIN ? sp.y1 - FOLD_GAP - ey : Infinity;
  let y = h.y;
  if (lo > hi) y = (sp.y0 + sp.y1) / 2;
  else y = Math.min(hi, Math.max(lo, y));
  return h.y + Math.max(-FOLD_MAX_SHIFT, Math.min(FOLD_MAX_SHIFT, y - h.y));
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

/** Natural beech / ash of wooden holds (display sRGB). */
const WOOD = new THREE.Color('#B9875A');

/**
 * A wooden hold's colour: natural wood stained `k` toward the route colour; with `routeHex`
 * (a deco hold behind that route) it recedes like the other deco holds.
 */
export function woodColor(hex: string, k: number, routeHex?: string, out = new THREE.Color()): THREE.Color {
  out.copy(WOOD).lerp(new THREE.Color(hex), k);
  if (routeHex) decoColor(`#${out.getHexString()}`, out, routeHex);
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

// ───────────────────────────── contact AO across folds ─────────────────────────────

interface AoVert {
  x: number;
  y: number;
  u: number;
  v: number;
}

const AO_CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
/** A fold sharper than this (degrees) counts as a lip / inside corner for the contact AO. */
const AO_FOLD_MIN = 2;

/** Fade length (m along the surface) of a hold's contact AO past a convex fold of `deltaDeg`. */
function aoLipFade(deltaDeg: number): number {
  // the rigid hold's plane leaves the turned-away panel by d·sin(Δ): gone once that is ~1.5 cm
  return Math.max(0.02, 0.015 / Math.max(1e-3, Math.sin((deltaDeg * Math.PI) / 180)));
}

/** Contact AO strength at surface height y for a hold whose home (own panel) is at homeY. */
export function aoFade(spans: readonly { y1: number; angle: number }[], homeY: number, y: number): number {
  let a = 1;
  for (let i = 0; i + 1 < spans.length; i++) {
    const yb = spans[i].y1;
    const delta = spans[i].angle - spans[i + 1].angle; // > 0: the upper panel turns away (a lip)
    if (delta < AO_FOLD_MIN) continue;
    if (homeY >= yb === y >= yb) continue;
    a *= Math.max(0, 1 - Math.abs(y - yb) / aoLipFade(delta));
  }
  return a;
}

/** Surface heights inside (lo, hi) where a hold's AO patch must be cut: folds + lip-fade ends. */
export function aoCuts(spans: readonly { y1: number; angle: number }[], homeY: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  const add = (y: number) => {
    if (y > lo + 1e-5 && y < hi - 1e-5 && !out.some((c) => Math.abs(c - y) < 1e-5)) out.push(y);
  };
  for (let i = 0; i + 1 < spans.length; i++) {
    const yb = spans[i].y1;
    const delta = spans[i].angle - spans[i + 1].angle;
    if (Math.abs(delta) < AO_FOLD_MIN / 4) continue;
    add(yb);
    if (delta >= AO_FOLD_MIN) add(yb + (homeY >= yb ? -1 : 1) * aoLipFade(delta));
  }
  return out.sort((p, q) => p - q);
}

/** Clip a convex polygon to the half plane dir·(y − c) ≥ 0 (dir = 1 keeps above c, −1 below). */
function clipY(poly: readonly AoVert[], c: number, dir: 1 | -1): AoVert[] {
  const out: AoVert[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = dir * (a.y - c);
    const db = dir * (b.y - c);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: c, u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
    }
  }
  return out;
}

// ───────────────────────────── per-boulder hold set ─────────────────────────────

export interface HoldSetOptions {
  /** Build every hold as its own mesh (editor), instead of merging deco holds. */
  separateAll?: boolean;
  /** Merged deco holds cast key-light shadows (default true; off below 'high' quality). */
  decoShadows?: boolean;
  gradeText?: string;
  name?: string;
  /** Tessellation of the merged deco holds (default 2; a 15 m lead wall uses 1: it shows many more). */
  decoLod?: HoldLod;
}

/**
 * Builds and owns the meshes for one boulder's holds: one mesh per route hold, deco holds merged,
 * START/TOP tape + route card (one mesh), contact-AO decals (one mesh).
 */
/** Where a hold bolted onto a volume (HoldDef.onVolume) sits: on the volume's face, square to it. */
export interface HoldMount {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Height of the mounting point above the wall surface (m, along the panel normal). */
  lift: number;
}

/** Attributes a merged route band keeps (plus its own aHold / aGrip). */
const BAND_ATTRS = new Set(['position', 'normal', 'uv', 'color', 'aSurf', 'aCurv']);
/** Lead towers: route bands farther than this (m) from the camera draw their coarse tessellation. */
const LOD_FAR = 7.5;

/** Draw-range start past any index count: renderBufferDirect returns before issuing a draw. */
const HIDDEN_RANGE = 1 << 30;
/** Height of a route-hold shadow proxy band (m along the wall). */
const SHADOW_BAND = 2.4;
/** The shadow proxy's material (never drawn in the main pass; its depth variant renders the shadow). */
const _shadowProxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

const _ray = new THREE.Raycaster();
const _probe = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
_probe.matrixAutoUpdate = false;

export class HoldSet {
  readonly group = new THREE.Group();
  readonly meshes = new Map<string, THREE.Mesh>();
  readonly holds = new Map<string, HoldDef>();
  readonly geoms = new Map<string, HoldGeometry>();
  /** Holds bolted onto volumes: their mounting point + orientation on the volume face. */
  readonly mounts = new Map<string, HoldMount>();
  private decoMesh: THREE.Mesh | null = null;
  /**
   * The route holds merged in bands up the wall, drawn ONLY into the key-light shadow map (one call
   * per band instead of one per hold; each band is still culled against the light's frustum).
   */
  private shadowMeshes: THREE.Mesh[] = [];
  private tapeMesh: THREE.Mesh | null = null;
  private aoMesh: THREE.Mesh | null = null;
  private routeMats: SurfaceMaterial[] = [];
  /** Merged route-hold bands (game): one LOD (rope) or mesh per band, their geometries, the rim texture. */
  private bands: THREE.Object3D[] = [];
  private bandGeos: THREE.BufferGeometry[] = [];
  private rimTex: THREE.DataTexture | null = null;
  private readonly rimIdx = new Map<string, number>();
  private decoMat: SurfaceMaterial;
  private aoMat: THREE.MeshBasicMaterial;
  private tapeMat: THREE.MeshStandardMaterial | null = null;

  constructor(private frame: WallFrame) {
    this.group.name = 'holds';
    this.decoMat = createSurfaceMaterial({ roughness: 0.74, normalMap: speckleNormal(), normalScale: 0.35, normalRepeat: 22, envMapIntensity: 0.32, curv: true });
    this.aoMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      // per-vertex alpha: the patch fades out past a roof lip (buildAo)
      vertexColors: true,
      map: softBlobTexture(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }

  /**
   * Mount a hold on its volume: a ray along the panel normal through the hold's wall position finds
   * the volume's face; the hold sits there square to that face, its grip side turned as on the wall.
   */
  private mountOn(h: HoldDef, vol: HoldDef, vg: HoldGeometry): HoldMount | null {
    const mVol = holdMatrix(vol, this.frame, new THREE.Matrix4());
    _probe.geometry = vg.geo;
    _probe.matrixWorld.copy(mVol);
    const n = this.frame.normalAt(h.y, new THREE.Vector3(), false);
    const base = this.frame.toWorldXYZ(h.x, h.y, 0, new THREE.Vector3());
    _ray.set(base.clone().addScaledVector(n, 2), n.clone().negate());
    _ray.far = 2.2;
    const hits = _ray.intersectObject(_probe, false);
    _probe.geometry = new THREE.BufferGeometry();
    const hit = hits.find((x) => x.face);
    if (!hit || !hit.face) return null;
    const z = hit.face.normal.clone().transformDirection(mVol).normalize();
    if (z.dot(n) < 0.05) return null;
    // the grip side on the wall (hold-local +y), projected onto the face
    const wallQ = new THREE.Quaternion().setFromAxisAngle(Z, h.angle + Math.PI / 2).premultiply(this.frame.quaternionAt(h.y, new THREE.Quaternion()));
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(wallQ);
    y.addScaledVector(z, -y.dot(z));
    if (y.lengthSq() < 1e-6) y.set(0, 1, 0).addScaledVector(z, -z.y);
    y.normalize();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    const pos = hit.point.clone().addScaledVector(z, -0.0015);
    return { pos, quat, lift: Math.max(0, hit.point.clone().sub(base).dot(n)) };
  }

  /**
   * What the climber needs to put a hand / foot on hold `id` (type, product, the drawn geometry and its
   * world transform incl. a volume mount, the stand-off from the wall). `srcY`: the problem's own y of
   * the hold (a hold slid back from a roof lip is drawn elsewhere: dy). False when the id is unknown.
   */
  contactInfo(id: string, out: HoldInfo, srcY?: number): boolean {
    const h = this.holds.get(id);
    if (!h) return false;
    out.type = h.type;
    out.angle = h.angle;
    out.size = h.size;
    const g = this.geoms.get(id);
    const mount = this.mounts.get(id);
    // a hold bolted onto a volume stands off the wall by the volume's face height there
    out.depth = (g?.depth ?? h.size * 0.5) + (mount?.lift ?? 0);
    out.dy = srcY !== undefined ? h.y - srcY : 0;
    out.shape = h.shape;
    out.fingers = h.fingers;
    out.edgeDepthMm = h.edgeDepthMm;
    out.geom = g ?? null;
    out.hasMatrix = false;
    if (g && out.matrix) {
      if (mount) out.matrix.compose(mount.pos, mount.quat, ONE);
      else holdMatrix(h, this.frame, out.matrix);
      out.hasMatrix = true;
    }
    return true;
  }

  /** Rebuild everything for `holds` on `boulder`. */
  build(boulder: BoulderDef, holds: readonly HoldDef[], opts: HoldSetOptions = {}): void {
    this.clear();
    geoEpoch++;
    const deco: { h: HoldDef; g: HoldGeometry }[] = [];
    const merge: { h: HoldDef; g: HoldGeometry }[] = [];
    const m = new THREE.Matrix4();
    // holds bolted onto volumes: find their mounting points first (volumes may come later in the list)
    const byId = new Map<string, HoldDef>();
    for (const h of holds) byId.set(h.id, h);
    for (const h of holds) {
      if (!h.onVolume) continue;
      const vol = byId.get(h.onVolume);
      if (!vol || vol.type !== 'volume') continue;
      const vg = holdGeometry('volume', vol.seed, vol.size, vol.role === 'deco' && !opts.separateAll ? (opts.decoLod ?? 2) : 0, holdVariant(vol));
      const mount = this.mountOn(h, vol, vg);
      if (mount) this.mounts.set(h.id, mount);
    }
    for (const h0 of holds) {
      const mergedDeco = h0.role === 'deco' && !opts.separateAll;
      const g = holdGeometry(h0.type, h0.seed, h0.size, mergedDeco ? (opts.decoLod ?? 2) : 0, holdVariant(h0));
      // next to a fold the drawn hold slides back onto its own panel (never past a roof lip); the
      // render copy carries that position for the AO, tapes, highlights and contact depth
      let h = h0;
      if (!this.mounts.has(h0.id) && h0.type !== 'volume') {
        const y = foldClampY(h0, g.halfX, g.halfY, this.frame);
        if (Math.abs(y - h0.y) > 1e-4) h = { ...h0, y };
      }
      this.holds.set(h.id, h);
      this.geoms.set(h.id, g);
      if (h.role === 'deco' && !opts.separateAll) {
        deco.push({ h, g });
        continue;
      }
      const look = h.role === 'deco' ? null : routeHoldLook(h.color);
      const wood = h.shape === 'wood';
      if (look && !wood && !opts.separateAll) {
        merge.push({ h, g });
        continue;
      }
      let color = look ? look.color : decoColor(h.color, undefined, boulder.color);
      // wooden holds stay wood (the route's colour only stains them; its edge light keeps the route readable)
      if (wood) color = woodColor(h.color, look ? 0.22 : 0.1, look ? undefined : boulder.color);
      const mat = createSurfaceMaterial({
        color,
        roughness: wood ? 0.66 : look ? look.roughness : 0.74,
        normalMap: speckleNormal(),
        normalScale: wood ? 0.12 : 0.38,
        normalRepeat: 22,
        rim: true,
        envMapIntensity: wood ? 0.35 : look ? 0.6 : 0.32,
        curv: true,
        // the within-reach rim + glint: only holds of the problem a limb may use
        cue: h.role !== 'deco',
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
      const mount = this.mounts.get(h.id);
      if (mount) {
        mesh.position.copy(mount.pos);
        mesh.quaternion.copy(mount.quat);
      } else {
        holdMatrix(h, this.frame, m);
        m.decompose(mesh.position, mesh.quaternion, mesh.scale);
      }
      // in the game every route hold casts through the merged shadow proxy; the editor's holds move
      // one by one, so there each casts its own
      mesh.castShadow = !!opts.separateAll;
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
        const mount = this.mounts.get(h.id);
        if (mount) m.compose(mount.pos, mount.quat, ONE);
        else holdMatrix(h, this.frame, m);
        geo.applyMatrix4(m);
        if (h.shape === 'wood') woodColor(h.color, 0.1, boulder.color, col);
        else decoColor(h.color, col, boulder.color);
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
    if (merge.length) this.buildBands(boulder, merge);
    if (!opts.separateAll) this.buildShadowProxy();
    const drawn = [...this.holds.values()];
    this.buildAo(drawn);
    this.buildTapes(boulder, drawn, opts);
    trimHoldCache();
  }

  /**
   * Route holds merged per band of SHADOW_BAND m up the wall: one draw per band instead of one per
   * hold (a lead tower's ~80 route holds become ~7 draws, still culled band by band), casting their
   * own shadows. Each vertex carries its hold's index (aHold: highlight rims from the rim texture) and
   * its hold's grip direction (aGrip: the within-reach cue). On a lead tower each band is a THREE.LOD:
   * the hold geometry at full detail near the camera, the coarse (neighbour-wall) tessellation past LOD_FAR.
   */
  private buildBands(boulder: BoulderDef, items: { h: HoldDef; g: HoldGeometry }[]): void {
    const W = Math.max(1, items.length);
    const data = new Float32Array(W * 2 * 4);
    for (let i = 0; i < W; i++) data[(W + i) * 4] = 2.2; // row 1: rim power
    const tex = new THREE.DataTexture(data, W, 2, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.rimTex = tex;
    const looks = new Map<string, { look: RouteHoldLook; mat: SurfaceMaterial }>();
    const lod = boulder.mode === 'rope';
    const groups = new Map<string, { key: string; idx: number[] }>();
    items.forEach((it, i) => {
      this.rimIdx.set(it.h.id, i);
      const key = `${it.h.color}|${Math.floor(it.h.y / SHADOW_BAND)}`;
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { key, idx: [] }));
      gr.idx.push(i);
    });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const grip = new THREE.Vector3();
    const center = new THREE.Vector3();
    const build = (idx: number[], coarse: boolean, col: THREE.Color): THREE.BufferGeometry | null => {
      const parts: THREE.BufferGeometry[] = [];
      for (const i of idx) {
        const { h, g } = items[i];
        const src = coarse ? holdGeometry(h.type, h.seed, h.size, 1, holdVariant(h)).geo : g.geo;
        const geo = src.clone();
        for (const name of Object.keys(geo.attributes)) if (!BAND_ATTRS.has(name)) geo.deleteAttribute(name);
        const mount = this.mounts.get(h.id);
        if (mount) m.compose(mount.pos, mount.quat, ONE);
        else holdMatrix(h, this.frame, m);
        geo.applyMatrix4(m);
        m.decompose(_v, q, _n);
        grip.set(0, 1, 0).applyQuaternion(q);
        const n = geo.getAttribute('position').count;
        const c = geo.getAttribute('color') as THREE.BufferAttribute;
        for (let k = 0; k < c.count; k++) c.setXYZ(k, c.getX(k) * col.r, c.getY(k) * col.g, c.getZ(k) * col.b);
        geo.setAttribute('aHold', new THREE.BufferAttribute(new Float32Array(n).fill(i), 1));
        const ga = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) ga.set([grip.x, grip.y, grip.z], k * 3);
        geo.setAttribute('aGrip', new THREE.BufferAttribute(ga, 3));
        parts.push(geo);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) return null;
      merged.translate(-center.x, -center.y, -center.z);
      merged.computeBoundingSphere();
      this.bandGeos.push(merged);
      return merged;
    };
    for (const gr of groups.values()) {
      const color = gr.key.split('|')[0];
      let lk = looks.get(color);
      if (!lk) {
        const look = routeHoldLook(color);
        const mat = createSurfaceMaterial({
          color: 0xffffff,
          roughness: look.roughness,
          normalMap: speckleNormal(),
          normalScale: 0.38,
          normalRepeat: 22,
          rim: true,
          envMapIntensity: 0.6,
          curv: true,
          cue: true,
          rimTex: tex,
        });
        const u = mat.userData.surf;
        u.uEdgeColor.value.copy(look.edgeColor);
        u.uEdgeStrength.value = look.edgeStrength;
        u.uEdgePower.value = look.edgePower;
        u.uLift.value = look.lift;
        this.routeMats.push(mat);
        looks.set(color, (lk = { look, mat }));
      }
      // the band's centre (LOD distance + local geometry)
      center.set(0, 0, 0);
      for (const i of gr.idx) {
        const h = items[i].h;
        const mount = this.mounts.get(h.id);
        if (mount) center.add(mount.pos);
        else center.add(this.frame.toWorldXYZ(h.x, h.y, 0, _v));
      }
      center.multiplyScalar(1 / gr.idx.length);
      let wallY = 0;
      for (const i of gr.idx) wallY += items[i].h.y;
      wallY /= gr.idx.length;
      const g0 = build(gr.idx, false, lk.look.color);
      if (!g0) continue;
      const mk = (g: THREE.BufferGeometry, name: string): THREE.Mesh => {
        const mesh = new THREE.Mesh(g, lk.mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = name;
        return mesh;
      };
      if (lod) {
        const g2 = build(gr.idx, true, lk.look.color);
        const o = new THREE.LOD();
        o.name = 'holds:route-band';
        o.position.copy(center);
        o.addLevel(mk(g0, 'holds:route-band'), 0, 0.12);
        if (g2) o.addLevel(mk(g2, 'holds:route-band-far'), LOD_FAR, 0.12);
        o.userData.wallY = wallY;
        this.bands.push(o);
        this.group.add(o);
      } else {
        const mesh = mk(g0, 'holds:route-band');
        mesh.position.copy(center);
        mesh.userData.wallY = wallY;
        this.bands.push(mesh);
        this.group.add(mesh);
      }
    }
  }

  /**
   * The route holds' key-light shadows in a few draws: their geometry merged, per band of
   * SHADOW_BAND m up the wall, into meshes that skip the main pass (an empty draw range there: three
   * draws nothing, not even an empty call) and open their full range only while the shadow map
   * renders them (onBeforeShadow / onAfterShadow). A lead route's ~90 shadow-pass calls become ~6,
   * a boulder's ~20 become 2, and a tight key on the climber still culls the bands out of its reach.
   */
  private buildShadowProxy(): void {
    const bands = new Map<number, THREE.BufferGeometry[]>();
    for (const [id, mesh] of this.meshes) {
      const h = this.holds.get(id);
      if (!h) continue;
      mesh.updateMatrix();
      const src = mesh.geometry;
      const g = new THREE.BufferGeometry();
      const pos = src.getAttribute('position');
      g.setAttribute('position', pos.clone());
      // mergeGeometries wants all parts indexed (or none)
      if (src.index) g.setIndex(src.index.clone());
      else g.setIndex(Array.from({ length: pos.count }, (_, i) => i));
      g.applyMatrix4(mesh.matrix);
      const k = Math.floor(h.y / SHADOW_BAND);
      let list = bands.get(k);
      if (!list) bands.set(k, (list = []));
      list.push(g);
    }
    for (const parts of bands.values()) {
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.setDrawRange(HIDDEN_RANGE, 0);
      const proxy = new THREE.Mesh(merged, _shadowProxyMat);
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.name = 'holds:shadow-proxy';
      proxy.onBeforeShadow = () => merged.setDrawRange(0, Infinity);
      proxy.onAfterShadow = () => merged.setDrawRange(HIDDEN_RANGE, 0);
      this.shadowMeshes.push(proxy);
      this.group.add(proxy);
    }
  }

  private buildAo(holds: readonly HoldDef[]): void {
    if (!holds.length) return;
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const spans = this.frame.spans();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const h of holds) {
      const g = this.geoms.get(h.id);
      if (!g || this.mounts.has(h.id)) continue;
      const th = h.angle + Math.PI / 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const spread = h.type === 'volume' ? 1.08 : 1.3;
      const pad = h.type === 'volume' ? 0.035 : 0.018;
      const ex = g.halfX * spread + pad;
      const ey = g.halfY * spread + pad;
      // corners in wall-surface coordinates (x, y) with their patch uv
      const poly: AoVert[] = [];
      for (const [sx, sy] of AO_CORNERS) {
        poly.push({ x: h.x + cs * ex * sx - sn * ey * sy, y: h.y + sn * ex * sx + cs * ey * sy, u: (sx + 1) / 2, v: (sy + 1) / 2 });
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of poly) {
        lo = Math.min(lo, v.y);
        hi = Math.max(hi, v.y);
      }
      // cut lines: folds inside the patch, plus the end of the fade past each convex fold
      const cuts = aoCuts(spans, h.y, lo, hi);
      const fade = (y: number) => aoFade(spans, h.y, y);
      const bands = cuts.length ? cuts.length + 1 : 1;
      for (let bi = 0; bi < bands; bi++) {
        const b0 = bi === 0 ? -Infinity : cuts[bi - 1];
        const b1 = bi === bands - 1 ? Infinity : cuts[bi];
        let piece = poly;
        if (b0 > -Infinity) piece = clipY(piece, b0, 1);
        if (b1 < Infinity) piece = clipY(piece, b1, -1);
        if (piece.length < 3) continue;
        // the fade is linear between cut lines, so the corners carry it exactly
        const alphas = piece.map((v) => fade(v.y));
        if (!alphas.some((a) => a > 0.002)) continue;
        const midY = (Math.max(b0, lo) + Math.min(b1, hi)) / 2;
        // the piece lies on one panel: its sharp normal lifts it off the plywood
        this.frame.normalAt(midY, n, false);
        const base = pos.length / 3;
        piece.forEach((v, i) => {
          this.frame.toWorldXYZ(v.x, v.y, 0, p).addScaledVector(n, 0.0012);
          pos.push(p.x, p.y, p.z);
          uv.push(v.u, v.v);
          col.push(0, 0, 0, alphas[i]);
        });
        for (let i = 1; i + 1 < piece.length; i++) idx.push(base, base + i, base + i + 1);
      }
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
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
      // a label sits flat on the panel under its centre (labels are small: never across a fold)
      const qn = this.frame.normalAt(qd.cy, new THREE.Vector3(), false);
      const qu = this.frame.upAt(qd.cy, new THREE.Vector3(), false);
      const qc = this.frame.toWorldXYZ(qd.cx, qd.cy, 0, new THREE.Vector3()).addScaledVector(qn, 0.0018);
      corners.forEach(([sx, sy], k) => {
        const lx = (sx * qd.w) / 2;
        const ly = (sy * qd.h) / 2;
        p.copy(qc)
          .addScaledVector(this.frame.right, lx * cs - ly * sn)
          .addScaledVector(qu, lx * sn + ly * cs);
        pos.set([p.x, p.y, p.z], (i * 4 + k) * 3);
        nrm.set([qn.x, qn.y, qn.z], (i * 4 + k) * 3);
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

  /**
   * Shadow focus (wall-local y, or null for all): while the key light is tight on the climber, only
   * the route bands within `range` m of it cast (a lead tower's far bands are outside its pool).
   */
  setShadowFocus(y: number | null, range = 3.2): void {
    for (const b of this.bands) {
      const on = y === null || Math.abs((b.userData.wallY as number) - y) <= range;
      if (b.userData.castOn === on) continue;
      b.userData.castOn = on;
      b.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = on;
      });
    }
  }

  /** Ids of the problem's holds a limb may use (start / hand / foot / top), merged or not. */
  routeIds(): string[] {
    const out: string[] = [];
    for (const [id, h] of this.holds) if (h.role !== 'deco') out.push(id);
    return out;
  }

  /** Rim glow on a route hold mesh (highlights). strength 0 = off. */
  setRim(holdId: string, color: THREE.Color, strength: number, power = 2.2): void {
    const bi = this.rimIdx.get(holdId);
    if (bi !== undefined && this.rimTex) {
      // merged band: the hold's column of the rim texture (re-uploaded only when it changes)
      const d = this.rimTex.image.data as Float32Array;
      const W = this.rimTex.image.width;
      const o = bi * 4;
      const p = (W + bi) * 4;
      if (d[o] !== color.r || d[o + 1] !== color.g || d[o + 2] !== color.b || d[o + 3] !== strength || d[p] !== power) {
        d[o] = color.r;
        d[o + 1] = color.g;
        d[o + 2] = color.b;
        d[o + 3] = strength;
        d[p] = power;
        this.rimTex.needsUpdate = true;
      }
      return;
    }
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
    this.mounts.clear();
    for (const mesh of [this.decoMesh, this.aoMesh, this.tapeMesh, ...this.shadowMeshes]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.shadowMeshes = [];
    for (const b of this.bands) this.group.remove(b);
    this.bands = [];
    for (const g of this.bandGeos) g.dispose();
    this.bandGeos = [];
    this.rimTex?.dispose();
    this.rimTex = null;
    this.rimIdx.clear();
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

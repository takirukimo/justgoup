// CHARACTER: hands and feet on the REAL hold geometry.
//
// The sim says which hold a limb is on and where along it (LimbSnapshot.pos: the hold centre moved
// toward its grip side, spread for matched limbs). Where the skin actually touches the plastic comes
// from the drawn hold itself: its surface (the mesh's own vertices, the bolt left out) is read once
// per hold shape into a small point set in hold-local space (x along the hold, y = its grip side,
// z out of the wall or the volume face it is bolted to) and queried with
//   support()       — the extreme surface point in a direction inside a strip / window: the lip a
//                     hand hooks, the top a shoe stands on, the side a heel or toe pulls on;
//   convexHeight()  — the face of a volume / chip under a point (they are convex polyhedra);
//   heightUnder()   — how far a dome falls away under a finger (slopers);
// and turned into a hand placement (handSite: the contact point, the hand's axes and per-finger curls,
// with the contact expressed in hand coordinates so the IK puts THAT point of the hand on the hold) for
// each grip style: hook (jugs, buckets, edges, rails, crimps — fingers over the lip, tips into the
// incut), pocket (1–4 fingers in the hole, the rest folded), drape (slopers, volumes — the palm laid on
// the surface, fingers following it), pinch (thumb against fingers across a rib) and horn (wrapped).

import * as THREE from 'three';
import type { HoldShape, HoldType } from '../core/types';
import type { HoldGeometry } from './holds';

// ═══════════════════════════════ hand geometry (shared with climber.ts) ═══════════════════════════════

/** Wrist → knuckles (m). */
export const PALM = 0.058;
/** Finger segment lengths: proximal (+ middle) and distal (m), scaled per finger by FING_L. */
export const FING_A = 0.034;
export const FING_B = 0.03;
/** Knuckle x per finger (index → pinky) in the RIGHT hand frame (−x = thumb side). */
export const FING_X = [-0.0255, -0.0085, 0.0085, 0.0255] as const;
/** Per-finger length and radius scale (index, middle, ring, pinky). */
export const FING_L = [1.0, 1.07, 1.0, 0.84] as const;
export const FING_R = [1.0, 1.04, 1.0, 0.9] as const;
/** Splay (lean away from the hand's centre line) per unit knuckle x, proximal segment (radians / m). */
export const FING_SPLAY = 1.6;
/** Palmar skin of the palm (m below the hand's mid plane) and finger pad radius. */
const PALM_SKIN = 0.0145;
const PAD_A = 0.0085;
const PAD_B = 0.0078;

// ═══════════════════════════════ surface ═══════════════════════════════

export interface HoldSurface {
  /** Contact points (hold-local, m): x, y, z per point. */
  pts: Float32Array;
  count: number;
  /** Convex holds (volumes, chips): the front-facing face planes [nx, ny, nz, d] (d = n·p). */
  planes: Float32Array | null;
  planeCount: number;
  halfX: number;
  halfY: number;
  depth: number;
  /** Pockets: the hole's floor centre and the opening's half sizes and rim height (m). */
  hole: { x: number; y: number; z: number; rx: number; ry: number; rim: number } | null;
}

const MAX_PTS = 720;
const cache = new WeakMap<HoldGeometry, HoldSurface>();

/** The contact surface of a hold geometry (cached per shape). */
export function holdSurface(g: HoldGeometry, type: HoldType): HoldSurface {
  const hit = cache.get(g);
  if (hit) return hit;
  const pos = g.geo.getAttribute('position') as THREE.BufferAttribute;
  const own = Math.min(pos.count, g.ownVerts > 0 ? g.ownVerts : pos.count);
  const step = Math.max(1, Math.ceil(own / MAX_PTS));
  const n = Math.ceil(own / step);
  const pts = new Float32Array(n * 3);
  let k = 0;
  for (let i = 0; i < own && k < n; i += step, k++) {
    pts[k * 3] = pos.getX(i);
    pts[k * 3 + 1] = pos.getY(i);
    pts[k * 3 + 2] = pos.getZ(i);
  }
  let planes: Float32Array | null = null;
  let planeCount = 0;
  const nrm = g.geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if ((type === 'volume' || type === 'foot') && nrm) {
    // flat-shaded convex solids: one plane per distinct face normal (front-facing)
    const list: number[] = [];
    for (let i = 0; i < own; i++) {
      const nx = nrm.getX(i);
      const ny = nrm.getY(i);
      const nz = nrm.getZ(i);
      if (nz < 0.03) continue;
      const d = nx * pos.getX(i) + ny * pos.getY(i) + nz * pos.getZ(i);
      let dup = false;
      for (let j = 0; j < list.length; j += 4) {
        if (Math.abs(list[j] - nx) + Math.abs(list[j + 1] - ny) + Math.abs(list[j + 2] - nz) < 0.02 && Math.abs(list[j + 3] - d) < 0.002) {
          dup = true;
          break;
        }
      }
      if (!dup) list.push(nx, ny, nz, d);
    }
    // a faceted solid has few planes; a smooth lathe (the round foot jibs) has one per vertex: not convex-planar
    if (list.length / 4 <= 64) {
      planes = Float32Array.from(list);
      planeCount = list.length / 4;
    }
  }
  let hole: HoldSurface['hole'] = null;
  if (type === 'pocket') {
    // the floor: the deepest point well inside the outline; the opening: the inner points below the rim
    let fx = 0;
    let fy = 0;
    let fz = Infinity;
    let rim = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      if (z > rim) rim = z;
      if (Math.abs(x) < g.halfX * 0.45 && Math.abs(y) < g.halfY * 0.6 && z > 1e-4 && z < fz) {
        fz = z;
        fx = x;
        fy = y;
      }
    }
    if (Number.isFinite(fz)) {
      const mid = fz + (rim - fz) * 0.6;
      let rx = 0.006;
      let ry = 0.006;
      for (let i = 0; i < n; i++) {
        const z = pts[i * 3 + 2];
        if (z > mid) continue;
        const dx = Math.abs(pts[i * 3] - fx);
        const dy = Math.abs(pts[i * 3 + 1] - fy);
        if (dx > g.halfX * 0.6 || dy > g.halfY * 0.7) continue;
        if (dx > rx) rx = dx;
        if (dy > ry) ry = dy;
      }
      hole = { x: fx, y: fy, z: fz, rx, ry, rim };
    }
  }
  const s: HoldSurface = { pts, count: n, planes, planeCount, halfX: g.halfX, halfY: g.halfY, depth: g.depth, hole };
  cache.set(g, s);
  return s;
}

/**
 * Extreme surface point in direction (dx, dy, dz) among the points whose XY offset from (cx, cy)
 * lies within `bandT` along the tangent (tx, ty) and within `bandN` across it (Infinity = a strip),
 * and whose z is in [zMin, zMax]. Widens the window when it holds no point. → out (hold-local).
 * Returns the support value (dot with the direction).
 */
export function support(
  s: HoldSurface,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  bandT: number,
  bandN: number,
  out: THREE.Vector3,
  zMin = -Infinity,
  zMax = Infinity,
): number {
  const P = s.pts;
  for (let pass = 0; pass < 3; pass++) {
    const bt = pass === 0 ? bandT : pass === 1 ? bandT * 2.5 : Infinity;
    const bn = pass === 0 ? bandN : pass === 1 ? bandN * 2.5 : Infinity;
    let best = -Infinity;
    let bi = -1;
    for (let i = 0; i < s.count; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      if (z < zMin || z > zMax) continue;
      const ox = x - cx;
      const oy = y - cy;
      const t = ox * tx + oy * ty;
      if (t > bt || t < -bt) continue;
      if (bn !== Infinity) {
        const m = ox * ty - oy * tx;
        if (m > bn || m < -bn) continue;
      }
      const v = x * dx + y * dy + z * dz;
      if (v > best) {
        best = v;
        bi = i;
      }
    }
    if (bi >= 0) {
      out.set(P[bi * 3], P[bi * 3 + 1], P[bi * 3 + 2]);
      return best;
    }
  }
  out.set(cx, cy, s.depth * 0.5);
  return -Infinity;
}

/**
 * Height of a convex hold's surface over (x, y) (hold-local; the lowest front-facing face plane there)
 * and that face's normal → outN. NaN when the surface has no planes.
 */
export function convexHeight(s: HoldSurface, x: number, y: number, outN: THREE.Vector3): number {
  const Q = s.planes;
  if (!Q || !s.planeCount) return Number.NaN;
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < s.planeCount; i++) {
    const o = i * 4;
    const z = (Q[o + 3] - Q[o] * x - Q[o + 1] * y) / Q[o + 2];
    if (z < best) {
      best = z;
      bi = i;
    }
  }
  outN.set(Q[bi * 4], Q[bi * 4 + 1], Q[bi * 4 + 2]);
  return Math.max(0, best);
}

/**
 * How high the surface stands over the point q along n (max of (p − q)·n over the points within
 * `r` of q in the plane ⟂ n, spanned by u, v); −Infinity when no point lies under that window.
 */
export function heightUnder(s: HoldSurface, q: THREE.Vector3, n: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, r: number): number {
  const P = s.pts;
  let best = -Infinity;
  for (let i = 0; i < s.count; i++) {
    const px = P[i * 3] - q.x;
    const py = P[i * 3 + 1] - q.y;
    const pz = P[i * 3 + 2] - q.z;
    const a = px * u.x + py * u.y + pz * u.z;
    if (a > r || a < -r) continue;
    const b = px * v.x + py * v.y + pz * v.z;
    if (b > r || b < -r) continue;
    const h = px * n.x + py * n.y + pz * n.z;
    if (h > best) best = h;
  }
  return best;
}

// ═══════════════════════════════ hand forward kinematics ═══════════════════════════════

/**
 * A point of finger f (hand-local; right = side +1, left = −1): its knuckle-to-tip chain bent by the
 * proximal curl `a` and distal curl `b` about the finger's own x axis, the splay leaning it away from
 * the hand's centre line. `seg` 0 = the crook between the segments, 1 = along the distal pad at t
 * (0 = its base, 1 = the tip); the point is on the palmar skin. → out.
 */
export function fingerPoint(f: number, side: number, a: number, b: number, seg: 0 | 1, t: number, out: THREE.Vector3): THREE.Vector3 {
  const kx = FING_X[f] * side;
  const lean = -kx * FING_SPLAY; // rotation about z: leans the finger away from the centre line
  const la = FING_A * FING_L[f];
  const lb = FING_B * FING_L[f];
  // chain in the finger's own (unsplayed) y–z plane
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(a + b);
  const sb = Math.sin(a + b);
  let y: number;
  let z: number;
  if (seg === 0) {
    // the crook: palmar side at the joint, along the mean of both segments' palmar normals
    y = la * ca - PAD_A * Math.sin(a + b * 0.5);
    z = -la * sa - PAD_A * Math.cos(a + b * 0.5);
  } else {
    y = la * ca + lb * t * cb - PAD_B * sb;
    z = -la * sa - lb * t * sb - PAD_B * cb;
  }
  // splay: rotate (0, y) about z by `lean`
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  return out.set(kx - y * sl, PALM + y * cl, z);
}

// ═══════════════════════════════ grip styles ═══════════════════════════════

export type GripStyle = 'hook' | 'pocket' | 'drape' | 'flat' | 'pinch' | 'horn';

interface StyleDef {
  style: GripStyle;
  /** Finger curls (radians): proximal, distal; thumb opposition 0..1. */
  a: number;
  b: number;
  thumb: number;
  /** Palm pitch: the fingers tip into the wall by this (radians). */
  beta: number;
  /** Contact: 0 = the crook between the segments, else the distal pad at this fraction. */
  pad: number;
  /** How far the hand may turn about the hold's normal toward the arm (radians). */
  turn: number;
  /** Lip search direction: + z tilt over the grip side. */
  lipZ: number;
}

const STYLES: Record<string, StyleDef> = {
  jug: { style: 'hook', a: 1.05, b: 1.12, thumb: 0.5, beta: 0.0, pad: 0, turn: 0.75, lipZ: 0.3 },
  bucket: { style: 'hook', a: 1.18, b: 1.28, thumb: 0.55, beta: 0.04, pad: 0, turn: 0.6, lipZ: 0.25 },
  edge: { style: 'hook', a: 0.98, b: 0.72, thumb: 0.45, beta: 0.14, pad: 0.45, turn: 0.32, lipZ: 0.3 },
  rail: { style: 'hook', a: 0.98, b: 0.72, thumb: 0.4, beta: 0.12, pad: 0.45, turn: 0.22, lipZ: 0.3 },
  crimp: { style: 'hook', a: 1.32, b: 0.34, thumb: 0.92, beta: 0.3, pad: 0.66, turn: 0.26, lipZ: 0.3 },
  micro: { style: 'hook', a: 1.4, b: 0.28, thumb: 0.95, beta: 0.36, pad: 0.8, turn: 0.2, lipZ: 0.3 },
  chip: { style: 'hook', a: 1.28, b: 0.42, thumb: 0.85, beta: 0.28, pad: 0.66, turn: 0.3, lipZ: 0.35 },
  pocket: { style: 'pocket', a: 0.72, b: 0.95, thumb: 0.35, beta: 0.08, pad: 0, turn: 0.55, lipZ: 0 },
  sloper: { style: 'drape', a: 0.3, b: 0.2, thumb: 0.22, beta: 0, pad: 0, turn: 0.45, lipZ: 0 },
  volume: { style: 'flat', a: 0.14, b: 0.08, thumb: 0.18, beta: 0, pad: 0, turn: 0.6, lipZ: 0 },
  pinch: { style: 'pinch', a: 1.0, b: 1.0, thumb: 1.0, beta: 0.08, pad: 0, turn: 0.4, lipZ: 0 },
  horn: { style: 'horn', a: 1.3, b: 1.25, thumb: 0.75, beta: 0.0, pad: 0, turn: 0.8, lipZ: 0.15 },
};

/** The grip style of a hold (type + product shape). */
export function gripStyleOf(type: HoldType, shape?: HoldShape): StyleDef {
  switch (type) {
    case 'jug':
      return shape === 'bucket' ? STYLES.bucket : STYLES.jug;
    case 'edge':
      return shape === 'rail' ? STYLES.rail : STYLES.edge;
    case 'crimp':
      return shape === 'micro' ? STYLES.micro : STYLES.crimp;
    case 'foot':
      return STYLES.chip;
    case 'pocket':
      return STYLES.pocket;
    case 'sloper':
      return STYLES.sloper;
    case 'volume':
      return STYLES.volume;
    case 'pinch':
      return shape === 'horn' ? STYLES.horn : STYLES.pinch;
  }
  return STYLES.edge;
}

/** Where a hand goes on a hold (all hold-local; `local` in hand coordinates). */
export interface HandSite {
  style: GripStyle;
  /** Contact point on the hold. */
  p: THREE.Vector3;
  /** The hand's finger axis and back-of-hand axis. */
  dir: THREE.Vector3;
  up: THREE.Vector3;
  /** Out of the surface at the contact: the grab approaches along it. */
  n: THREE.Vector3;
  /** The point of the hand that touches `p`, in hand coordinates. */
  local: THREE.Vector3;
  /** Per-finger curls (index → pinky) and thumb opposition. */
  a: [number, number, number, number];
  b: [number, number, number, number];
  thumb: number;
}

export function createHandSite(): HandSite {
  return {
    style: 'hook',
    p: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, 1),
    n: new THREE.Vector3(0, 0, 1),
    local: new THREE.Vector3(0, 0.07, -0.03),
    a: [1, 1, 1, 1],
    b: [1, 1, 1, 1],
    thumb: 0.4,
  };
}

/** Fingers a pocket takes (index → pinky): mono = middle, two = middle + ring, three = index – ring. */
export function pocketFingers(n: number): [boolean, boolean, boolean, boolean] {
  if (n <= 1) return [false, true, false, false];
  if (n === 2) return [false, true, true, false];
  if (n === 3) return [true, true, true, false];
  return [true, true, true, true];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _X = new THREE.Vector3();
const _Y = new THREE.Vector3();
const _Z = new THREE.Vector3(0, 0, 1);
const _hx = new THREE.Vector3();

/**
 * Hand placement on a hold (hold-local). (cx, cy): where the sim holds it (hold-local XY); (gx, gy):
 * the grip direction (unit, hold-local XY: the side the fingers go over, already turned toward the
 * arm); `side` −1 left / +1 right hand; `fingers` for pockets; `across` for pinches (+1: fingers wrap
 * the +x side). → out.
 */
export function handSite(
  s: HoldSurface,
  def: StyleDef,
  cx: number,
  cy: number,
  gx: number,
  gy: number,
  side: number,
  fingers: number,
  across: number,
  out: HandSite,
): HandSite {
  out.style = def.style;
  out.thumb = def.thumb;
  for (let f = 0; f < 4; f++) {
    out.a[f] = def.a;
    out.b[f] = def.b;
  }
  _Y.set(gx, gy, 0);
  _X.set(gy, -gx, 0); // Y × Z
  const beta = def.beta;
  switch (def.style) {
    case 'hook':
    case 'horn': {
      // the lip: the extreme point over the grip side (a little out from the wall), within the
      // fingers' span along it; a horn is wrapped round the middle of its shaft
      const zLo = def.style === 'horn' ? s.depth * 0.3 : -Infinity;
      const zHi = def.style === 'horn' ? s.depth * 0.72 : Infinity;
      support(s, gx, gy, def.lipZ, cx, cy, _X.x, _X.y, 0.022, Infinity, out.p, zLo, zHi);
      out.n.copy(_Y).multiplyScalar(0.8).addScaledVector(_Z, 0.6).normalize();
      handAxes(_Y, beta, out);
      contactLocal(def, side, null, out);
      break;
    }
    case 'pocket': {
      const h = s.hole;
      const sel = pocketFingers(fingers);
      // the fingers go over the body-side rim of the opening, into the hole
      const hx = h ? h.x : cx;
      const hy = h ? h.y : cy;
      const ry = h ? Math.hypot(gx * h.rx, gy * h.ry) : 0.012;
      const rimX = hx - gx * ry * 0.85;
      const rimY = hy - gy * ry * 0.85;
      // the rim top right there (a small window), else the hold's top along the grip side
      support(s, _Z.x, _Z.y, 1, rimX, rimY, _X.x, _X.y, 0.009, 0.006, out.p);
      out.n.copy(_Y).multiplyScalar(0.5).addScaledVector(_Z, 0.85).normalize();
      for (let f = 0; f < 4; f++) {
        if (sel[f]) continue;
        // the free fingers fold into the palm below the hole
        out.a[f] = 1.45;
        out.b[f] = 1.5;
      }
      handAxes(_Y, beta, out);
      contactLocal(def, side, sel, out);
      // the contact's x is the inserted fingers' mean: centre them on the hole
      break;
    }
    case 'drape':
    case 'flat': {
      // the palm on the surface: a dome's upper front (where its normal leans toward the grip side),
      // a volume's face under the sim's point
      if (def.style === 'flat' && s.planes) {
        const z = convexHeight(s, cx, cy, out.n);
        out.p.set(cx, cy, z);
      } else {
        _a.copy(_Y).multiplyScalar(0.5).addScaledVector(_Z, 0.866);
        support(s, _a.x, _a.y, _a.z, cx, cy, _X.x, _X.y, 0.03, Infinity, out.p);
        out.n.copy(_a);
      }
      out.up.copy(out.n);
      out.dir.copy(_Y).addScaledVector(out.n, -_Y.dot(out.n));
      if (out.dir.lengthSq() < 1e-6) out.dir.set(0, 1, 0).addScaledVector(out.n, -out.n.y);
      out.dir.normalize();
      out.local.set(0, PALM * 0.52, -PALM_SKIN);
      if (def.style === 'drape') {
        // the fingers follow the dome down: curl each by how far the surface falls away under it
        _hx.crossVectors(out.dir, out.up);
        for (let f = 0; f < 4; f++) {
          const kx = FING_X[f] * side;
          _c.copy(out.p).addScaledVector(out.dir, PALM - out.local.y + 0.04 * FING_L[f]).addScaledVector(_hx, kx);
          const h = heightUnder(s, _c, out.up, _hx, out.dir, 0.012);
          const drop = h === -Infinity ? 0.05 : Math.max(0, -h);
          const k = Math.min(1.1, Math.atan2(drop, 0.04) * 1.15);
          out.a[f] = 0.12 + k;
          out.b[f] = 0.08 + k * 0.7;
        }
      }
      break;
    }
    case 'pinch': {
      // a rib along local y: the palm over its front, the fingers wrapping the far side, the thumb the
      // near one
      const ax = across >= 0 ? 1 : -1;
      support(s, ax, 0, 0, cx, cy, 0, 1, 0.012, Infinity, _b); // far edge at this height
      const px = _b.x - ax * (PALM * 0.5 + 0.002);
      support(s, 0, 0, 1, px, cy, 1, 0, 0.01, 0.012, out.p);
      out.n.set(0, 0, 1);
      _d.set(ax, 0, 0);
      handAxes(_d, beta, out);
      out.local.set(0, PALM * 0.5, -PALM_SKIN);
      // a wide rib: the fingers curl less round it; a narrow one: the thumb tucks right under
      const w = Math.abs(_b.x - px) * 2;
      const k = Math.min(1, Math.max(0, (w - 0.03) / 0.05));
      for (let f = 0; f < 4; f++) {
        out.a[f] = def.a + 0.25 * (1 - k);
        out.b[f] = def.b + 0.15 * (1 - k);
      }
      break;
    }
  }
  return out;
}

/** Hand axes from the grip direction Y and the palm pitch: fingers over Y tipped into the wall. */
function handAxes(Y: THREE.Vector3, beta: number, out: HandSite): void {
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  out.dir.copy(Y).multiplyScalar(cb).addScaledVector(_Z, -sb).normalize();
  out.up.copy(Y).multiplyScalar(sb).addScaledVector(_Z, cb).normalize();
}

/** The hook's contact in hand coordinates: the mean crook / pad of the (selected) fingers. */
function contactLocal(def: StyleDef, side: number, sel: readonly boolean[] | null, out: HandSite): void {
  out.local.set(0, 0, 0);
  let n = 0;
  for (let f = 0; f < 4; f++) {
    if (sel && !sel[f]) continue;
    if (def.pad > 0) fingerPoint(f, side, out.a[f], out.b[f], 1, def.pad, _c);
    else fingerPoint(f, side, out.a[f], out.b[f], 0, 0, _c);
    out.local.add(_c);
    n++;
  }
  if (n) out.local.multiplyScalar(1 / n);
}

// ═══════════════════════════════ feet ═══════════════════════════════

/**
 * Where a sole resting on the hold touches it: the support point in the sole's normal direction
 * `up` (hold-local, unit) within a shoe-wide strip around (cx, cy) across the tangent (tx, ty); for
 * convex holds (volumes, chips) the face under the point instead when its normal faces the sole.
 * → out; returns the surface normal at the contact in outN.
 */
export function soleContact(
  s: HoldSurface,
  up: THREE.Vector3,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  band: number,
  out: THREE.Vector3,
  outN: THREE.Vector3,
): void {
  if (s.planes && s.planeCount && s.depth > 0.05) {
    // a volume: stand on (or smear on) the face under the foot
    const z = convexHeight(s, cx, cy, outN);
    out.set(cx, cy, z);
    return;
  }
  support(s, up.x, up.y, up.z, cx, cy, tx, ty, band, Infinity, out);
  outN.copy(up);
}

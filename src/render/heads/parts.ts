// Shared building blocks for the procedural animal heads: a kit that collects fur / keratin /
// eye geometry into three merged meshes (≈3 draw calls per head), plus eyes with blinking lids
// (morph target), horns with ridges, cupped ears, fur locks, feathers and SDF-based AO.

import * as THREE from 'three';
import {
  MeshBuilder,
  addTube,
  lin,
  loft,
  mixRGB,
  sampleCurve,
  sat,
  shrinkwrap,
  sstep,
  type RGB,
  type Sdf,
  type VertexAttribs,
} from './geo';
import { createEyeMaterial, createFurMaterial, createKeratinMaterial, type EyeStyle, type FurOptions } from '../materials';

export const HEAD_SCALE = 1.15;

const _v = new THREE.Vector3();

/** Ambient occlusion from a signed distance field (classic 5-tap). */
export function sdfAO(f: Sdf, p: THREE.Vector3, n: THREE.Vector3, scale = 0.012): number {
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= 5; i++) {
    const h = scale * i;
    const d = f(p.x + n.x * h, p.y + n.y * h, p.z + n.z * h);
    occ += (h - d) * w;
    w *= 0.6;
  }
  return sat(1 - occ * (2.2 / scale) * 0.12);
}

export interface LidSpec {
  /** Upper lid edge elevation when open (deg, 0 = gaze level). */
  upper: number;
  /** Lower lid edge elevation when open (deg, negative). */
  lower: number;
  /** Inner-corner droop (deg): >0 gives a determined/fierce look. */
  frown?: number;
  color: string;
  rim?: string;
}

export interface EyeSpec {
  center: [number, number, number];
  radius: number;
  /** Gaze direction of the right eye (x>0); the left eye is mirrored. */
  gaze: [number, number, number];
  style: EyeStyle;
  lids?: LidSpec;
}

/** Collects one head's geometry. */
export class HeadKit {
  readonly fur = new MeshBuilder();
  readonly ker = new MeshBuilder();
  readonly eye = new MeshBuilder();
  private lidOpen: number[] = [];
  private lidClosed: number[] = [];
  private lidStart = -1;
  private eyeStyle: EyeStyle | null = null;

  constructor() {
    this.fur.defaults.aux = [1, 0, 1, 0];
    this.ker.defaults.aux = [1, 0, 0, 0];
  }

  // ── eyes ──

  /** Both eyes (mirrored) with optional upper/lower lids that blink via a morph target. */
  addEyes(e: EyeSpec): void {
    this.eyeStyle = e.style;
    const r = e.radius;
    const gaze = new THREE.Vector3(...e.gaze).normalize();
    for (const side of [1, -1]) {
      const c = new THREE.Vector3(e.center[0] * side, e.center[1], e.center[2]);
      const g = gaze.clone();
      g.x *= side;
      // eye frame: Z = gaze, Y = up-ish
      const z = g;
      const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), z).normalize();
      const y = new THREE.Vector3().crossVectors(z, x).normalize();
      const basis = new THREE.Matrix4().makeBasis(x, y, z).setPosition(c);
      // eyeball (poles on ±y in loft space → rotate so the texture faces +z)
      const start = this.eye.vertexCount;
      loft(this.eye, {
        rows: 14,
        cols: 18,
        point: (v, u, out) => {
          const th = v * Math.PI;
          const ph = u * Math.PI * 2;
          out.set(Math.sin(th) * Math.cos(ph) * r, -Math.cos(th) * r, Math.sin(th) * Math.sin(ph) * r);
        },
      });
      // planar UVs from the front
      for (let i = start; i < this.eye.vertexCount; i++) {
        const px = this.eye.pos[i * 3];
        const py = this.eye.pos[i * 3 + 1];
        this.eye.uv[i * 2] = 0.5 - (px / r) * 0.5;
        this.eye.uv[i * 2 + 1] = 0.5 + (py / r) * 0.5;
      }
      this.eye.transform(basis, start);
      if (e.lids) this.addLids(basis, r, e.lids, side);
    }
  }

  private addLids(basis: THREE.Matrix4, r: number, l: LidSpec, side: number): void {
    const col = lin(l.color);
    const rim = lin(l.rim ?? '#1d1612');
    const D = Math.PI / 180;
    const frown = (l.frown ?? 0) * D;
    const rl = r * 1.06;
    const pt = (e: number, ph: number, rad: number, out: THREE.Vector3) =>
      out.set(Math.cos(e) * Math.sin(ph) * rad, Math.sin(e) * rad, Math.cos(e) * Math.cos(ph) * rad).applyMatrix4(basis);
    const phW = 92 * D;
    const make = (upper: boolean) => {
      const rows = 9;
      const cols = 17;
      const eBack = upper ? 105 * D : -100 * D;
      const eOpen = (upper ? l.upper : l.lower) * D;
      const eClosed = (upper ? -6 : -10) * D;
      const edge = (eEdge: number, ph: number) => {
        // inner corner (toward the nose: ph < 0 for the right eye in eye space) droops for "frown"
        const inner = sat(-ph / phW);
        const arch = Math.cos(ph * 0.9) * (upper ? 6 : -4) * D;
        return eEdge + arch - (upper ? frown * inner : 0);
      };
      const startOpen = this.fur.vertexCount;
      const P = new THREE.Vector3();
      const Pc = new THREE.Vector3();
      const a: VertexAttribs = { color: [0, 0, 0], aux: [1, 0, 1, 0], skinIndex: [0, 0, 0, 0], skinWeight: [1, 0, 0, 0] };
      const idx0 = this.fur.vertexCount;
      for (let ri = 0; ri < rows; ri++) {
        const v = ri / (rows - 1);
        for (let ci = 0; ci < cols; ci++) {
          const ph = -phW + (2 * phW * ci) / (cols - 1);
          const phs = ph * side; // mirror so "inner" stays inner on both eyes
          const eO = edge(eOpen, ph);
          const eC = edge(eClosed, ph);
          const rimK = sstep(0.72, 1, v);
          const rad = rl * (1 + 0.07 * rimK) * (1 + 0.04 * Math.sin(v * Math.PI));
          const eo = eBack + (eO - eBack) * v;
          const ec = eBack + (eC - eBack) * v;
          pt(eo, phs, rad, P);
          pt(ec, phs, rad, Pc);
          mixRGB(col, rim, rimK * 0.85, a.color);
          a.aux[0] = 1 - 0.25 * rimK;
          const n = P.clone().sub(_v.setFromMatrixPosition(basis)).normalize();
          this.fur.addVertex(P, n, 0, 0, a);
          this.lidOpen.push(P.x, P.y, P.z);
          this.lidClosed.push(Pc.x, Pc.y, Pc.z);
        }
      }
      if (this.lidStart < 0) this.lidStart = startOpen;
      for (let ri = 0; ri < rows - 1; ri++) {
        for (let ci = 0; ci < cols - 1; ci++) {
          const i0 = idx0 + ri * cols + ci;
          const i1 = i0 + 1;
          const i2 = i0 + cols;
          const i3 = i2 + 1;
          this.fur.tri(i0, i1, i2);
          this.fur.tri(i1, i3, i2);
        }
      }
      // orient by normals
      orientRange(this.fur, idx0);
    };
    make(true);
    make(false);
  }

  // ── build ──

  build(name: string, fur: FurOptions, keratin: { roughness?: number; clearcoat?: number } = {}): THREE.Group {
    const g = new THREE.Group();
    g.name = `head:${name}`;
    const inner = new THREE.Group();
    inner.scale.setScalar(HEAD_SCALE);
    // authored skulls sit ~0.2 m above the joint: drop them so the head centre is ≈ BODY.neck
    inner.position.set(0, -0.052, 0.012);
    g.add(inner);
    const furGeo = this.fur.build({ aux: true, uv: false });
    if (this.lidStart >= 0) {
      const n = this.fur.vertexCount;
      const delta = new Float32Array(n * 3);
      const base = this.lidStart;
      for (let i = 0; i < this.lidOpen.length / 3; i++) {
        const vi = base + i;
        if (vi >= n) break;
        delta[vi * 3] = this.lidClosed[i * 3] - this.lidOpen[i * 3];
        delta[vi * 3 + 1] = this.lidClosed[i * 3 + 1] - this.lidOpen[i * 3 + 1];
        delta[vi * 3 + 2] = this.lidClosed[i * 3 + 2] - this.lidOpen[i * 3 + 2];
      }
      furGeo.morphAttributes.position = [new THREE.BufferAttribute(delta, 3)];
      furGeo.morphTargetsRelative = true;
    }
    const furMesh = new THREE.Mesh(furGeo, createFurMaterial(fur));
    furMesh.name = 'fur';
    if (this.lidStart >= 0) furMesh.updateMorphTargets();
    inner.add(furMesh);
    if (this.ker.vertexCount) {
      const km = new THREE.Mesh(this.ker.build({ aux: true, uv: false }), createKeratinMaterial(keratin));
      km.name = 'keratin';
      inner.add(km);
    }
    if (this.eye.vertexCount && this.eyeStyle) {
      const em = new THREE.Mesh(this.eye.build({ color: false }), createEyeMaterial(this.eyeStyle));
      em.name = 'eyes';
      inner.add(em);
    }
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return g;
  }
}

/** Make the triangles of vertices ≥ start face along their vertex normals. */
function orientRange(b: MeshBuilder, start: number): void {
  const a = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3(), vn = new THREE.Vector3();
  for (let t = 0; t < b.idx.length; t += 3) {
    const i = b.idx[t], j = b.idx[t + 1], k = b.idx[t + 2];
    if (i < start) continue;
    a.set(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    e1.set(b.pos[j * 3], b.pos[j * 3 + 1], b.pos[j * 3 + 2]).sub(a);
    e2.set(b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2]).sub(a);
    fn.crossVectors(e1, e2);
    vn.set(b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2]);
    if (fn.dot(vn) < 0) {
      b.idx[t + 1] = k;
      b.idx[t + 2] = j;
    }
  }
}

// ───────────────────────────── skull (shrink-wrapped SDF) ─────────────────────────────

export interface SkullSpec {
  sdf: Sdf;
  a: [number, number, number];
  b: [number, number, number];
  rows?: number;
  cols?: number;
  /** Colour + aux painter. aux: x AO (pre-filled from the SDF), y gloss, z sheen, w pattern. */
  paint: (p: THREE.Vector3, n: THREE.Vector3, out: VertexAttribs) => void;
  aoScale?: number;
}

export function addSkull(kit: HeadKit, s: SkullSpec): void {
  const aoScale = s.aoScale ?? 0.01;
  shrinkwrap(kit.fur, {
    sdf: s.sdf,
    a: s.a,
    b: s.b,
    rows: s.rows ?? 50,
    cols: s.cols ?? 42,
    maxDist: 0.3,
    attrib: (p, n, _v2, _u, out) => {
      out.aux[0] = 0.55 + 0.45 * sdfAO(s.sdf, p, n, aoScale);
      out.aux[1] = 0;
      out.aux[2] = 1;
      out.aux[3] = 0;
      s.paint(p, n, out);
    },
  });
}

// ───────────────────────────── neck ─────────────────────────────

/** Furry neck from the joint (origin) up into the skull. */
export function addNeck(
  kit: HeadKit,
  o: { top: [number, number, number]; r0: number; r1: number; front?: number; paint?: (p: THREE.Vector3, n: THREE.Vector3, out: VertexAttribs) => void; color: string },
): void {
  const base = lin(o.color);
  // the kit's inner group is shifted forward (+z) by 0.012/scale: start the tube behind to stay centred in the collar
  const z0 = -0.011;
  const pts = sampleCurve([new THREE.Vector3(0, -0.02, z0), new THREE.Vector3(0, o.top[1] * 0.5, z0 + o.top[2] * 0.4), new THREE.Vector3(...o.top)], 10);
  addTube(
    kit.fur,
    pts,
    (t, ang) => {
      const r = o.r0 + (o.r1 - o.r0) * t;
      // slightly deeper front-to-back (throat)
      const front = o.front ?? 1.08;
      return r * (1 + (front - 1) * Math.max(0, Math.sin(ang)));
    },
    16,
    {
      capStart: false,
      up: new THREE.Vector3(0, 0, 1),
      attrib: (p, n, v, _u, out) => {
        out.color[0] = base[0];
        out.color[1] = base[1];
        out.color[2] = base[2];
        out.aux[0] = 0.78 + 0.22 * sstep(0, 0.5, v);
        out.aux[2] = 1;
        if (o.paint) o.paint(p, n, out);
      },
    },
  );
}

// ───────────────────────────── horns ─────────────────────────────

export interface HornSpec {
  /** Control points of the RIGHT horn centreline (base → tip); the left one is mirrored. */
  ctrl: [number, number, number][];
  samples?: number;
  cols?: number;
  /** Radius at t ∈ [0,1]. */
  radius: (t: number) => number;
  /** Cross-section: angle → radius multiplier (shape). Angle 0 = curve normal (front/outer side). */
  section?: (ang: number, t: number) => number;
  /** Ridge bumps: count along the length, amplitude (fraction of radius), angular mask. */
  ridges?: { count: number; amp: number; sharp?: number; mask?: (ang: number) => number; start?: number; end?: number };
  /** Fine growth rings. */
  rings?: { count: number; amp: number };
  /** Section twist over the length (radians). */
  twist?: number;
  /** Reference "up" for the frames (defines where angle 0 points at the base). */
  up?: [number, number, number];
  base: string;
  tip: string;
  ridgeColor?: string;
  mirror?: boolean;
}

export function addHorns(kit: HeadKit, h: HornSpec): void {
  const ctrl = h.ctrl.map((c) => new THREE.Vector3(...c));
  const pts = sampleCurve(ctrl, h.samples ?? 64);
  const cBase = lin(h.base);
  const cTip = lin(h.tip);
  const cRidge = lin(h.ridgeColor ?? h.tip);
  const ridgeF = (t: number) => {
    if (!h.ridges) return 0;
    const s0 = h.ridges.start ?? 0.04;
    const s1 = h.ridges.end ?? 0.9;
    if (t < s0 || t > s1) return 0;
    const ph = ((t - s0) / (s1 - s0)) * h.ridges.count;
    const f = ph - Math.floor(ph);
    // asymmetric ridge: steep on the tip side, gentle toward the base
    const k = h.ridges.sharp ?? 6;
    const bump = Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(f, 0.7))), k);
    const fade = sstep(s0, s0 + 0.06, t) * (1 - sstep(s1 - 0.12, s1, t));
    return bump * fade;
  };
  const start = kit.ker.vertexCount;
  addTube(
    kit.ker,
    pts,
    (t, ang) => {
      let r = h.radius(t);
      if (h.section) r *= h.section(ang, t);
      if (h.ridges) {
        const m = h.ridges.mask ? h.ridges.mask(ang) : 1;
        r *= 1 + h.ridges.amp * ridgeF(t) * m;
      }
      if (h.rings) {
        const ph = t * h.rings.count;
        r *= 1 + h.rings.amp * (Math.sin(ph * Math.PI * 2) * 0.5 + 0.5) * (1 - t * 0.5);
      }
      return r;
    },
    h.cols ?? 18,
    {
      capStart: true,
      capEnd: true,
      up: new THREE.Vector3(...(h.up ?? [0, 0, 1])),
      twist: h.twist ? (t) => t * (h.twist as number) : undefined,
      attrib: (_p, _n, v, u, out) => {
        // v spans the cap rows too; approximate t by v
        const t = v;
        const col: RGB = [0, 0, 0];
        mixRGB(cBase, cTip, sstep(0.05, 1, t), col);
        const ang = u * Math.PI * 2;
        const m = h.ridges?.mask ? h.ridges.mask(ang) : 1;
        const rf = ridgeF(t) * m;
        mixRGB(col, cRidge, rf * 0.75, out.color);
        // grooves between ridges get a touch of AO; tips are glossier (worn smooth)
        out.aux[0] = 0.78 + 0.22 * Math.max(rf, sstep(0.0, 0.25, ridgeF(Math.min(1, t + 0.01)) + 0.15)) ;
        out.aux[0] *= 0.55 + 0.45 * sstep(0.02, 0.14, t);
        out.aux[1] = 0.15 + 0.5 * sstep(0.6, 1, t);
      },
    },
  );
  if (h.mirror !== false) kit.ker.mirrorCopyX(start);
}

// ───────────────────────────── ears ─────────────────────────────

export interface EarSpec {
  /** Base position (right ear) and outward pointing direction. */
  base: [number, number, number];
  dir: [number, number, number];
  /** Which way the cup opens (roughly forward/outward). */
  open: [number, number, number];
  length: number;
  width: number;
  /** Cup depth (0 = flat, 1 = deep). */
  cup?: number;
  /** Tip sharpness: 0 rounded … 1 pointed. */
  point?: number;
  outer: string;
  inner: string;
  rim?: string;
  /** Optional tuft at the tip (lynx). */
  tuft?: { length: number; color: string };
}

export function addEars(kit: HeadKit, e: EarSpec): void {
  const start = kit.fur.vertexCount;
  const dir = new THREE.Vector3(...e.dir).normalize();
  const open = new THREE.Vector3(...e.open);
  open.addScaledVector(dir, -open.dot(dir)).normalize();
  const side = new THREE.Vector3().crossVectors(dir, open).normalize();
  const base = new THREE.Vector3(...e.base);
  const cOut = lin(e.outer);
  const cIn = lin(e.inner);
  const cRim = lin(e.rim ?? e.outer);
  const cup = e.cup ?? 0.55;
  const pnt = e.point ?? 0.5;
  const thick = e.width * 0.24;
  loft(kit.fur, {
    rows: 12,
    cols: 16,
    point: (v, u, out) => {
      // leaf outline along the length
      const t = v;
      const w = e.width * Math.pow(Math.sin(Math.PI * Math.min(1, t * (1 - 0.25 * pnt) + 0.0001)), 0.75 + pnt * 0.6) * (t < 0.08 ? 0.6 + 5 * t : 1);
      const ang = u * Math.PI * 2;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      // crescent section: the open side (sy > 0) is pushed back to form a cup
      const x = cx * w * 0.5;
      let y = sy * thick * (1 - 0.6 * t);
      y -= cup * w * 0.42 * (1 - cx * cx) * (sy > 0 ? 1 : 0.65);
      out.copy(base).addScaledVector(dir, t * e.length).addScaledVector(side, x).addScaledVector(open, y + cup * w * 0.3 * (1 - cx * cx));
    },
    attrib: (_p, _n, v, u, out) => {
      const sy = Math.sin(u * Math.PI * 2);
      const cx = Math.cos(u * Math.PI * 2);
      const inside = sstep(0.1, 0.6, sy) * (1 - sstep(0.55, 0.9, Math.abs(cx))) * sstep(0.04, 0.2, v) * (1 - sstep(0.75, 0.97, v));
      mixRGB(cOut, cIn, inside, out.color);
      if (Math.abs(cx) > 0.8) mixRGB(out.color, cRim, 0.5, out.color);
      out.aux[0] = inside > 0.5 ? 0.62 + 0.3 * v : 0.85 + 0.15 * v;
      out.aux[2] = inside > 0.5 ? 0.4 : 1;
    },
  });
  if (e.tuft) {
    const tip = base.clone().addScaledVector(dir, e.length * 0.97);
    addLock(kit, {
      base: [tip.x, tip.y, tip.z],
      dir: [dir.x, dir.y + 0.15, dir.z],
      length: e.tuft.length,
      width: e.width * 0.16,
      color: e.tuft.color,
      tipColor: e.tuft.color,
      bend: [open.x * -0.3, open.y * -0.3, open.z * -0.3],
    });
  }
  kit.fur.mirrorCopyX(start);
}

// ───────────────────────────── fur locks + feathers ─────────────────────────────

export interface LockSpec {
  base: [number, number, number];
  dir: [number, number, number];
  length: number;
  width: number;
  /** Flatness of the section (1 = round). */
  flat?: number;
  /** Lateral bend at the tip (vector added along the length, quadratic). */
  bend?: [number, number, number];
  color: string;
  tipColor?: string;
  /** Orientation hint for the flat side. */
  up?: [number, number, number];
  ao?: number;
}

/** A tapered, slightly flattened lock of fur (beards, ruffs, tufts, shag). */
export function addLock(kit: HeadKit, l: LockSpec, b: MeshBuilder = kit.fur): number {
  const base = new THREE.Vector3(...l.base);
  const dir = new THREE.Vector3(...l.dir).normalize();
  const bend = new THREE.Vector3(...(l.bend ?? [0, 0, 0]));
  const pts: THREE.Vector3[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(base.clone().addScaledVector(dir, t * l.length).addScaledVector(bend, t * t * l.length));
  }
  const c0 = lin(l.color);
  const c1 = lin(l.tipColor ?? l.color);
  const flat = l.flat ?? 0.55;
  return addTube(
    b,
    pts,
    (t, ang) => {
      // soft clump: full body, rounded taper into a gentle point
      const r = l.width * 0.5 * Math.pow(Math.max(0, 1 - Math.pow(t, 1.8)), 0.75) * (0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, 0.35 + t)));
      return r * (Math.abs(Math.cos(ang)) * (1 - flat) + flat);
    },
    6,
    {
      capStart: true,
      capEnd: false,
      up: new THREE.Vector3(...(l.up ?? [0, 1, 0])),
      attrib: (_p, _n, v, _u, out) => {
        mixRGB(c0, c1, v, out.color);
        out.aux[0] = (l.ao ?? 0.72) + (1 - (l.ao ?? 0.72)) * sstep(0, 0.6, v);
        out.aux[2] = 1;
      },
    },
  );
}

export interface FeatherSpec {
  base: [number, number, number];
  /** Pointing direction (root → tip). */
  dir: [number, number, number];
  /** Outward surface normal (which side faces out). */
  normal: [number, number, number];
  length: number;
  width: number;
  color: string;
  tipColor?: string;
  /** Curvature toward the body (0..1). */
  curl?: number;
}

/** A layered contour feather: a cupped, pointed leaf with a central ridge. */
export function addFeather(kit: HeadKit, f: FeatherSpec, b: MeshBuilder = kit.fur): number {
  const base = new THREE.Vector3(...f.base);
  const dir = new THREE.Vector3(...f.dir).normalize();
  const nrm = new THREE.Vector3(...f.normal);
  nrm.addScaledVector(dir, -nrm.dot(dir)).normalize();
  const side = new THREE.Vector3().crossVectors(nrm, dir).normalize();
  const c0 = lin(f.color);
  const c1 = lin(f.tipColor ?? f.color);
  const curl = f.curl ?? 0.25;
  const th = f.width * 0.12;
  return loft(b, {
    rows: 6,
    cols: 8,
    point: (v, u, out) => {
      const t = v;
      const w = f.width * 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.92)), 0.8) * (1 - 0.35 * t);
      const ang = u * Math.PI * 2;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      const ridge = (1 - cx * cx) * th * 0.8;
      const along = t * f.length;
      out
        .copy(base)
        .addScaledVector(dir, along)
        .addScaledVector(side, cx * w)
        .addScaledVector(nrm, sy * th * (1 - t * 0.7) + ridge - cx * cx * w * 0.25 - curl * t * t * f.length * 0.35);
    },
    attrib: (_p, _n, v, _u, out) => {
      mixRGB(c0, c1, sstep(0.3, 1, v), out.color);
      out.aux[0] = 0.62 + 0.38 * sstep(0.0, 0.7, v);
      out.aux[2] = 0.85;
    },
  });
}

/** Spread items over [0,1) with a golden-ratio sequence (deterministic, even). */
export function golden(i: number): number {
  return (i * 0.6180339887498949) % 1;
}


// ───────────────────────────── surface helpers ─────────────────────────────

/** Project p onto the SDF's zero set (a few Newton steps); writes the surface normal into n. */
export function toSurface(f: Sdf, p: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
  const e = 0.0008;
  for (let i = 0; i < 8; i++) {
    const d = f(p.x, p.y, p.z);
    n.set(
      f(p.x + e, p.y, p.z) - f(p.x - e, p.y, p.z),
      f(p.x, p.y + e, p.z) - f(p.x, p.y - e, p.z),
      f(p.x, p.y, p.z + e) - f(p.x, p.y, p.z - e),
    );
    const l = n.length();
    if (l < 1e-12) break;
    n.multiplyScalar(1 / l);
    p.addScaledVector(n, -d);
    if (Math.abs(d) < 1e-5) break;
  }
  return p;
}

export interface ScatterSpec {
  /** Seeds: unit directions from `center` (golden-spiral sampled), kept when `mask(p, n) > rnd`. */
  center: [number, number, number];
  count: number;
  mask: (p: THREE.Vector3, n: THREE.Vector3) => number;
  /** Lock for a surface point (return null to skip). */
  lock: (p: THREE.Vector3, n: THREE.Vector3, i: number) => LockSpec | null;
  /** Push the root slightly inside the surface (m). */
  sink?: number;
  seed?: number;
}

/** Scatter fur locks over an SDF surface (shag, ruffs, cheek fluff). */
export function scatterLocks(kit: HeadKit, f: Sdf, s: ScatterSpec): void {
  const c = new THREE.Vector3(...s.center);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const N = s.count * 4;
  let placed = 0;
  for (let i = 0; i < N && placed < s.count; i++) {
    // golden spiral on the sphere
    const k = i + 0.5;
    const phi = Math.acos(1 - (2 * k) / N);
    const th = Math.PI * (1 + Math.sqrt(5)) * k + (s.seed ?? 0);
    p.set(Math.cos(th) * Math.sin(phi), Math.cos(phi), Math.sin(th) * Math.sin(phi)).multiplyScalar(0.3).add(c);
    toSurface(f, p, n);
    const m = s.mask(p, n);
    const r = golden(i * 7 + (s.seed ?? 0) * 13);
    if (m <= r) continue;
    p.addScaledVector(n, -(s.sink ?? 0.004));
    const spec = s.lock(p, n, placed);
    if (!spec) continue;
    addLock(kit, spec);
    placed++;
  }
}

// ───────────────────────────── beaks ─────────────────────────────

export interface BeakSpec {
  /** Centreline control points (base → tip). */
  ctrl: [number, number, number][];
  /** Half width / half height along t. */
  width: (t: number) => number;
  height: (t: number) => number;
  /** Colour along t (writes linear RGB). */
  color: (t: number, out: RGB) => void;
  /** Gloss along t (0..1). */
  gloss?: (t: number) => number;
  samples?: number;
  cols?: number;
}

/** A keratin beak part: a sharp-ridged (culmen) tapered tube along a curve. */
export function addBeak(kit: HeadKit, s: BeakSpec): number {
  const pts = sampleCurve(s.ctrl.map((c) => new THREE.Vector3(...c)), s.samples ?? 28);
  const start = kit.ker.vertexCount;
  addTube(
    kit.ker,
    pts,
    (t, ang) => {
      // ang = 0 → curve normal (up): sharpen the top ridge, round the sides and the gape
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const h = s.height(t);
      const w = s.width(t);
      const top = c > 0 ? Math.pow(c, 0.7) : c;
      const r = Math.hypot(top * h, sn * w);
      return r;
    },
    s.cols ?? 14,
    {
      up: new THREE.Vector3(0, 1, 0),
      capStart: true,
      capEnd: true,
      attrib: (_p, _n, v, _u, out) => {
        s.color(v, out.color);
        out.aux[0] = 0.75 + 0.25 * sstep(0.0, 0.15, v);
        out.aux[1] = s.gloss ? s.gloss(v) : 0.4;
      },
    },
  );
  return start;
}

export interface RuffSpec {
  /** Rows from the top (y0) down to the bottom (y1); radius of the body under the feathers. */
  y0: number;
  y1: number;
  rows: number;
  perRow: number;
  /** Surface radius at height y (feathers sit just outside it). */
  radius: (y: number) => number;
  /** Arc covered (radians, centred on the back = −z); 2π for a full collar. */
  arc?: number;
  zOffset?: number;
  length: number;
  width: number;
  color: (row: number, i: number) => [string, string];
}

/** Layered feathers that hug a roughly cylindrical neck: overlapping rows pointing down/back. */
export function addFeatherRuff(kit: HeadKit, r: RuffSpec): void {
  const arc = r.arc ?? Math.PI * 2;
  for (let row = 0; row < r.rows; row++) {
    const y = r.y0 + ((r.y1 - r.y0) * row) / Math.max(1, r.rows - 1);
    const rad = r.radius(y);
    const n = r.perRow;
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i + 0.5 * (row % 2) - (n - 1) / 2) * (arc / n);
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      const [c0, c1] = r.color(row, i);
      addFeather(kit, {
        base: [sx * (rad - 0.004), y, sz * (rad - 0.004) + (r.zOffset ?? 0)],
        dir: [sx * 0.18, -1, sz * 0.18],
        normal: [sx, 0, sz],
        length: r.length * (1 + 0.12 * Math.sin(i * 2.3 + row)),
        width: r.width,
        color: c0,
        tipColor: c1,
        curl: -0.35,
      });
    }
  }
}

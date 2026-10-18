// Procedural geometry toolkit for the CHARACTER module (heads, body, guide).
//
//  • MeshBuilder — accumulates vertices with position / normal / uv / colour / aux (vec4) and
//    optional skinning data, then emits one BufferGeometry. Parts are generated in their own
//    local frame and placed with transform(); symmetric parts are mirrored with mirrorX().
//  • loft()      — a grid surface swept along v and wrapped around u (tubes, capsules, horns,
//    limbs, shoes, beaks). Rows whose ring collapses to a point become clean poles.
//  • shrinkwrap()— projects a capsule-parameterised mesh onto a signed-distance field along rays
//    cast from the capsule's axis segment. Heads are authored as smooth unions of SDF primitives,
//    which gives smooth, evenly-tessellated surfaces with analytic normals.
//
// Everything here runs at build time only (never per frame).

import * as THREE from 'three';

export type Sdf = (x: number, y: number, z: number) => number;

// ───────────────────────────── SDF primitives ─────────────────────────────

/** Polynomial smooth minimum (union). */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
/** Smooth maximum (intersection / subtraction with −b). */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** Ellipsoid (iq's bound — good enough for shrink-wrapping). */
export function sdEllipsoid(px: number, py: number, pz: number, rx: number, ry: number, rz: number): number {
  const k0 = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry) + (pz * pz) / (rz * rz));
  const k1 = Math.sqrt((px * px) / (rx * rx * rx * rx) + (py * py) / (ry * ry * ry * ry) + (pz * pz) / (rz * rz * rz * rz));
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

export function sdSphere(px: number, py: number, pz: number, r: number): number {
  return Math.sqrt(px * px + py * py + pz * pz) - r;
}

/** Capsule between a and b with radii ra → rb (round cone). */
export function sdRoundCone(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  ra: number, rb: number,
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / l2)) : 0;
  const dx = pax - bax * t, dy = pay - bay * t, dz = paz - baz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * t);
}

/** A rotated + translated ellipsoid, prepared once (build-time closures are fine). */
export function ellipsoid(
  c: [number, number, number],
  r: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
): Sdf {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ')).invert();
  const e = m.elements;
  const [cx, cy, cz] = c;
  const [rx, ry, rz] = r;
  return (x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const lx = e[0] * dx + e[4] * dy + e[8] * dz;
    const ly = e[1] * dx + e[5] * dy + e[9] * dz;
    const lz = e[2] * dx + e[6] * dy + e[10] * dz;
    return sdEllipsoid(lx, ly, lz, rx, ry, rz);
  };
}

export function roundCone(a: [number, number, number], b: [number, number, number], ra: number, rb: number): Sdf {
  return (x, y, z) => sdRoundCone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], ra, rb);
}

/** Smooth union of several fields with one blend radius. */
export function unionAll(fields: Sdf[], k: number): Sdf {
  return (x, y, z) => {
    let d = fields[0](x, y, z);
    for (let i = 1; i < fields.length; i++) d = smin(d, fields[i](x, y, z), k);
    return d;
  };
}

/** Mirror a field across x = 0 (evaluates with |x|). */
export function mirrorX(f: Sdf): Sdf {
  return (x, y, z) => f(Math.abs(x), y, z);
}

// ───────────────────────────── math helpers ─────────────────────────────

export const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (e0: number, e1: number, x: number): number => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Deterministic hash → [0,1). */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 3D value noise in [-1, 1] (build-time only). */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => hash1(a * 157 + b * 113 + c * 271) * 2 - 1;
  const x00 = mix(h(ix, iy, iz), h(ix + 1, iy, iz), ux);
  const x10 = mix(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), ux);
  const x01 = mix(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), ux);
  const x11 = mix(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), ux);
  return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz);
}

const _c = new THREE.Color();
/** Hex (sRGB) → linear RGB triple written into `out`. */
export function lin(hex: string | number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  _c.set(hex);
  out[0] = _c.r;
  out[1] = _c.g;
  out[2] = _c.b;
  return out;
}
export type RGB = [number, number, number];
export function mixRGB(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// ───────────────────────────── builder ─────────────────────────────

/** Per-vertex write target handed to attribute callbacks. */
export interface VertexAttribs {
  color: RGB;
  /** Free vec4 channel (heads: x = AO, y = gloss, z = fur mask, w = pattern mask; body: region, chalk, AO, seam). */
  aux: [number, number, number, number];
  skinIndex: [number, number, number, number];
  skinWeight: [number, number, number, number];
}

export type AttribFn = (p: THREE.Vector3, n: THREE.Vector3, v: number, u: number, out: VertexAttribs) => void;

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  aux: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  idx: number[] = [];
  /** Default attributes used when a part does not provide a callback. */
  defaults: VertexAttribs = {
    color: [1, 1, 1],
    aux: [1, 0, 0, 0],
    skinIndex: [0, 0, 0, 0],
    skinWeight: [1, 0, 0, 0],
  };

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  addVertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, a: VertexAttribs): number {
    const i = this.vertexCount;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(a.color[0], a.color[1], a.color[2]);
    this.aux.push(a.aux[0], a.aux[1], a.aux[2], a.aux[3]);
    this.si.push(a.skinIndex[0], a.skinIndex[1], a.skinIndex[2], a.skinIndex[3]);
    this.sw.push(a.skinWeight[0], a.skinWeight[1], a.skinWeight[2], a.skinWeight[3]);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Apply a matrix to vertices [from, end) (positions + normals). */
  transform(m: THREE.Matrix4, from: number, to = this.vertexCount): this {
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    for (let i = from; i < to; i++) {
      v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]).applyMatrix4(m);
      this.pos[i * 3] = v.x;
      this.pos[i * 3 + 1] = v.y;
      this.pos[i * 3 + 2] = v.z;
      v.set(this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]).applyMatrix3(nm).normalize();
      this.nrm[i * 3] = v.x;
      this.nrm[i * 3 + 1] = v.y;
      this.nrm[i * 3 + 2] = v.z;
    }
    return this;
  }

  /** Duplicate vertices [from, to) (and the triangles that use only them) mirrored across x = 0. */
  mirrorCopyX(from: number, to = this.vertexCount, remapSkin?: (i: number) => number): this {
    const offset = this.vertexCount - from;
    for (let i = from; i < to; i++) {
      this.pos.push(-this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.nrm.push(-this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]);
      this.uv.push(this.uv[i * 2], this.uv[i * 2 + 1]);
      this.col.push(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
      for (let k = 0; k < 4; k++) this.aux.push(this.aux[i * 4 + k]);
      for (let k = 0; k < 4; k++) this.si.push(remapSkin ? remapSkin(this.si[i * 4 + k]) : this.si[i * 4 + k]);
      for (let k = 0; k < 4; k++) this.sw.push(this.sw[i * 4 + k]);
    }
    const n = this.idx.length;
    for (let t = 0; t < n; t += 3) {
      const a = this.idx[t], b = this.idx[t + 1], c = this.idx[t + 2];
      if (a >= from && a < to && b >= from && b < to && c >= from && c < to) {
        this.idx.push(a + offset, c + offset, b + offset);
      }
    }
    return this;
  }

  /** Mirror vertices [from, to) in place across x = 0 (flips winding of their triangles). */
  mirrorInPlaceX(from: number, to = this.vertexCount, triFrom = 0): this {
    for (let i = from; i < to; i++) {
      this.pos[i * 3] = -this.pos[i * 3];
      this.nrm[i * 3] = -this.nrm[i * 3];
    }
    for (let t = triFrom; t < this.idx.length; t += 3) {
      const a = this.idx[t];
      if (a >= from && a < to) {
        const b = this.idx[t + 1];
        this.idx[t + 1] = this.idx[t + 2];
        this.idx[t + 2] = b;
      }
    }
    return this;
  }

  /** Set the skin binding of vertices [from, to) to a single bone. */
  bindRigid(bone: number, from: number, to = this.vertexCount): this {
    for (let i = from; i < to; i++) {
      this.si[i * 4] = bone;
      this.si[i * 4 + 1] = 0;
      this.si[i * 4 + 2] = 0;
      this.si[i * 4 + 3] = 0;
      this.sw[i * 4] = 1;
      this.sw[i * 4 + 1] = 0;
      this.sw[i * 4 + 2] = 0;
      this.sw[i * 4 + 3] = 0;
    }
    return this;
  }

  /** Append another builder's content. */
  append(o: MeshBuilder): this {
    const off = this.vertexCount;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.uv.push(...o.uv);
    this.col.push(...o.col);
    this.aux.push(...o.aux);
    this.si.push(...o.si);
    this.sw.push(...o.sw);
    for (const i of o.idx) this.idx.push(i + off);
    return this;
  }

  build(opts: { skin?: boolean; aux?: boolean; color?: boolean; uv?: boolean } = {}): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (opts.uv !== false) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (opts.color !== false) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (opts.aux) g.setAttribute('aAux', new THREE.Float32BufferAttribute(this.aux, 4));
    if (opts.skin) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    const vc = this.vertexCount;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ───────────────────────────── loft ─────────────────────────────

export interface LoftSpec {
  /** Samples along v (≥ 2), including both ends. */
  rows: number;
  /** Samples around u (≥ 3). A duplicate seam column is added for UVs. */
  cols: number;
  /** Surface point for v ∈ [0,1], u ∈ [0,1). */
  point: (v: number, u: number, out: THREE.Vector3) => void;
  /** UV rectangle [u0, v0, u1, v1] (default unit square). */
  uvRect?: [number, number, number, number];
  attrib?: AttribFn;
  /** Open surface in u (no wrap): a strip/patch instead of a tube. */
  openU?: boolean;
  /** Flip the face winding (inside-out surfaces such as cupped ears seen from inside). */
  flip?: boolean;
  /** Optional v remap for row distribution (e.g. denser near the ends). */
  vDist?: (t: number) => number;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();

/**
 * Sweep a surface into the builder. Returns the first vertex index.
 * Normals are oriented outward automatically for wrapped tubes (any parameterisation); open
 * patches use du × dv (pass `flip` to reverse).
 */
export function loft(b: MeshBuilder, s: LoftSpec): number {
  const rows = s.rows;
  const cols = s.cols;
  const wrap = !s.openU;
  const cu = wrap ? cols : cols - 1; // u step divisor
  const P: THREE.Vector3[] = [];
  const vAt = (r: number) => (s.vDist ? s.vDist(r / (rows - 1)) : r / (rows - 1));
  for (let r = 0; r < rows; r++) {
    const v = vAt(r);
    for (let c = 0; c < cols; c++) {
      const p = new THREE.Vector3();
      s.point(v, c / cu, p);
      P.push(p);
    }
  }
  const at = (r: number, c: number) => {
    if (wrap) c = ((c % cols) + cols) % cols;
    else c = Math.max(0, Math.min(cols - 1, c));
    r = Math.max(0, Math.min(rows - 1, r));
    return P[r * cols + c];
  };
  const centroids: THREE.Vector3[] = [];
  const isPole: boolean[] = [];
  for (let r = 0; r < rows; r++) {
    const ce = new THREE.Vector3();
    for (let c = 0; c < cols; c++) ce.add(P[r * cols + c]);
    ce.multiplyScalar(1 / cols);
    centroids.push(ce);
    let m = 0;
    for (let c = 0; c < cols; c++) m = Math.max(m, P[r * cols + c].distanceTo(ce));
    isPole.push(m < 1e-7);
  }
  // raw normals (du × dv)
  const N: THREE.Vector3[] = [];
  let vote = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = new THREE.Vector3();
      if (!isPole[r]) {
        if (wrap || (c > 0 && c < cols - 1)) _du.subVectors(at(r, c + 1), at(r, c - 1));
        else if (c === 0) _du.subVectors(at(r, 1), at(r, 0));
        else _du.subVectors(at(r, cols - 1), at(r, cols - 2));
        let ra = r - 1, rb = r + 1;
        if (ra < 0) ra = 0;
        if (rb > rows - 1) rb = rows - 1;
        // skip pole neighbours for a better tangent estimate
        if (isPole[ra] && ra !== r) ra = r;
        if (isPole[rb] && rb !== r) rb = r;
        if (ra === rb) {
          ra = Math.max(0, r - 1);
          rb = Math.min(rows - 1, r + 1);
        }
        _dv.subVectors(at(rb, c), at(ra, c));
        n.crossVectors(_du, _dv);
        if (n.lengthSq() < 1e-18) n.subVectors(at(r, c), centroids[r]);
        n.normalize();
        if (wrap) vote += Math.sign(n.dot(_tmpA.subVectors(at(r, c), centroids[r])));
      }
      N.push(n);
    }
  }
  const inv = wrap && vote < 0;
  const flip = !!s.flip;
  // pole normals: away from the neighbouring ring
  for (let r = 0; r < rows; r++) {
    if (!isPole[r]) continue;
    const nr = r === 0 ? 1 : r === rows - 1 ? rows - 2 : r + 1;
    _tmpB.subVectors(P[r * cols], centroids[nr]);
    if (_tmpB.lengthSq() < 1e-16) _tmpB.set(0, 1, 0);
    _tmpB.normalize();
    for (let c = 0; c < cols; c++) N[r * cols + c].copy(_tmpB);
  }
  const outward = (r: number, c: number, out: THREE.Vector3) => {
    out.copy(N[r * cols + c]);
    if (inv && !isPole[r]) out.negate();
    if (flip) out.negate();
    return out;
  };

  const [u0, v0, u1, v1] = s.uvRect ?? [0, 0, 1, 1];
  const start = b.vertexCount;
  const a = b.defaults;
  const attrs: VertexAttribs = {
    color: [a.color[0], a.color[1], a.color[2]],
    aux: [a.aux[0], a.aux[1], a.aux[2], a.aux[3]],
    skinIndex: [a.skinIndex[0], a.skinIndex[1], a.skinIndex[2], a.skinIndex[3]],
    skinWeight: [a.skinWeight[0], a.skinWeight[1], a.skinWeight[2], a.skinWeight[3]],
  };
  const colsOut = wrap ? cols + 1 : cols;
  for (let r = 0; r < rows; r++) {
    const v = vAt(r);
    for (let c = 0; c < colsOut; c++) {
      const cc = wrap ? c % cols : c;
      _p.copy(P[r * cols + cc]);
      outward(r, cc, _n);
      const uu = c / cu;
      if (s.attrib) {
        attrs.color[0] = a.color[0]; attrs.color[1] = a.color[1]; attrs.color[2] = a.color[2];
        attrs.aux[0] = a.aux[0]; attrs.aux[1] = a.aux[1]; attrs.aux[2] = a.aux[2]; attrs.aux[3] = a.aux[3];
        attrs.skinIndex[0] = a.skinIndex[0]; attrs.skinIndex[1] = a.skinIndex[1]; attrs.skinIndex[2] = a.skinIndex[2]; attrs.skinIndex[3] = a.skinIndex[3];
        attrs.skinWeight[0] = a.skinWeight[0]; attrs.skinWeight[1] = a.skinWeight[1]; attrs.skinWeight[2] = a.skinWeight[2]; attrs.skinWeight[3] = a.skinWeight[3];
        s.attrib(_p, _n, v, uu, attrs);
      }
      b.addVertex(_p, _n, u0 + (u1 - u0) * uu, v0 + (v1 - v0) * v, attrs);
    }
  }
  // winding follows du × dv; reverse it when the normals were inverted
  const rev = inv !== flip;
  const segU = wrap ? cols : cols - 1;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < segU; c++) {
      const i0 = start + r * colsOut + c;
      const i1 = i0 + 1;
      const i2 = i0 + colsOut;
      const i3 = i2 + 1;
      if (isPole[r] && isPole[r + 1]) continue;
      if (isPole[r]) {
        if (rev) b.tri(i1, i2, i3);
        else b.tri(i1, i3, i2);
      } else if (isPole[r + 1]) {
        if (rev) b.tri(i0, i2, i1);
        else b.tri(i0, i1, i2);
      } else if (rev) {
        b.tri(i0, i2, i1);
        b.tri(i1, i2, i3);
      } else {
        b.tri(i0, i1, i2);
        b.tri(i1, i3, i2);
      }
    }
  }
  return start;
}

// ───────────────────────────── shrink-wrap ─────────────────────────────

export interface ShrinkSpec {
  sdf: Sdf;
  /** Axis segment; rays are cast from it. Both ends must be inside the shape. */
  a: [number, number, number];
  b: [number, number, number];
  /** Rings around the axis and samples per ring. */
  rows: number;
  cols: number;
  /** Search distance along each ray. */
  maxDist?: number;
  attrib?: AttribFn;
  /** Rotates the u = 0 seam around the axis (radians). Default puts it at the bottom (−y side). */
  seamAngle?: number;
}

/**
 * Builds a closed surface by casting rays outward from the a→b axis (hemispherical caps at the
 * ends) and finding the outermost SDF zero crossing. Normals come from the SDF gradient.
 */
export function shrinkwrap(b: MeshBuilder, s: ShrinkSpec): number {
  const A = new THREE.Vector3(...s.a);
  const B = new THREE.Vector3(...s.b);
  const axis = new THREE.Vector3().subVectors(B, A);
  const L = axis.length();
  axis.normalize();
  // perpendicular frame (seam at −y by default)
  const ref = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1);
  const e1 = ref.clone().addScaledVector(axis, -ref.dot(axis)).normalize();
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize();
  if (s.seamAngle) {
    const q = new THREE.Quaternion().setFromAxisAngle(axis, s.seamAngle);
    e1.applyQuaternion(q);
    e2.applyQuaternion(q);
  }
  const f = s.sdf;
  const maxD = s.maxDist ?? 0.6;
  // characteristic radius for distributing rows over caps vs cylinder
  const R = Math.max(0.02, -f(A.x * 0.5 + B.x * 0.5, A.y * 0.5 + B.y * 0.5, A.z * 0.5 + B.z * 0.5));
  const capLen = (Math.PI / 2) * R;
  const total = capLen * 2 + L;
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const march = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number => {
    // step from inside to the outermost crossing within maxD
    let t = 0;
    let last = -1;
    let inside = f(ox, oy, oz) < 0;
    let prevT = 0;
    const minStep = 0.0015;
    while (t < maxD) {
      const v = f(ox + dx * t, oy + dy * t, oz + dz * t);
      const nowInside = v < 0;
      if (inside && !nowInside) {
        // refine between prevT and t
        let lo = prevT, hi = t;
        for (let k = 0; k < 24; k++) {
          const m = (lo + hi) * 0.5;
          if (f(ox + dx * m, oy + dy * m, oz + dz * m) < 0) lo = m;
          else hi = m;
        }
        last = (lo + hi) * 0.5;
      }
      inside = nowInside;
      prevT = t;
      t += Math.max(minStep, Math.abs(v) * 0.9);
    }
    return last < 0 ? 0 : last;
  };
  const rows = s.rows;
  const cols = s.cols;
  const start = b.vertexCount;
  const attrs: VertexAttribs = {
    color: [...b.defaults.color] as RGB,
    aux: [...b.defaults.aux] as [number, number, number, number],
    skinIndex: [...b.defaults.skinIndex] as [number, number, number, number],
    skinWeight: [...b.defaults.skinWeight] as [number, number, number, number],
  };
  const eps = 0.0008;
  const n = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    const sDist = v * total;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const ang = u * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // radial direction
      _tmpA.copy(e1).multiplyScalar(ca).addScaledVector(e2, sa);
      if (sDist <= capLen) {
        const phi = (sDist / capLen) * (Math.PI / 2); // 0 at pole
        o.copy(A);
        d.copy(axis).multiplyScalar(-Math.cos(phi)).addScaledVector(_tmpA, Math.sin(phi));
      } else if (sDist >= capLen + L) {
        const phi = ((total - sDist) / capLen) * (Math.PI / 2);
        o.copy(B);
        d.copy(axis).multiplyScalar(Math.cos(phi)).addScaledVector(_tmpA, Math.sin(phi));
      } else {
        o.copy(A).addScaledVector(axis, sDist - capLen);
        d.copy(_tmpA);
      }
      d.normalize();
      const t = march(o.x, o.y, o.z, d.x, d.y, d.z);
      p.copy(o).addScaledVector(d, t);
      n.set(
        f(p.x + eps, p.y, p.z) - f(p.x - eps, p.y, p.z),
        f(p.x, p.y + eps, p.z) - f(p.x, p.y - eps, p.z),
        f(p.x, p.y, p.z + eps) - f(p.x, p.y, p.z - eps),
      );
      if (n.lengthSq() < 1e-18) n.copy(d);
      n.normalize();
      if (s.attrib) {
        attrs.color[0] = b.defaults.color[0]; attrs.color[1] = b.defaults.color[1]; attrs.color[2] = b.defaults.color[2];
        attrs.aux[0] = b.defaults.aux[0]; attrs.aux[1] = b.defaults.aux[1]; attrs.aux[2] = b.defaults.aux[2]; attrs.aux[3] = b.defaults.aux[3];
        s.attrib(p, n, v, u, attrs);
      }
      b.addVertex(p, n, u, v, attrs);
    }
  }
  const W = cols + 1;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const i0 = start + r * W + c;
      const i1 = i0 + 1;
      const i2 = i0 + W;
      const i3 = i2 + 1;
      if (r === 0) b.tri(i0, i3, i2);
      else if (r === rows - 2) b.tri(i0, i1, i2);
      else {
        b.tri(i0, i1, i2);
        b.tri(i1, i3, i2);
      }
    }
  }
  // orientation check: make the winding agree with the normals
  fixWinding(b, start);
  return start;
}

/** Flip triangles (from vertex `start` onward) whose face normal disagrees with the vertex normals. */
export function fixWinding(b: MeshBuilder, start: number): void {
  let agree = 0;
  let disagree = 0;
  const a = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3(), fn = new THREE.Vector3(), vn = new THREE.Vector3();
  const tris: number[] = [];
  for (let t = 0; t < b.idx.length; t += 3) {
    if (b.idx[t] < start) continue;
    tris.push(t);
    const i = b.idx[t], j = b.idx[t + 1], k = b.idx[t + 2];
    a.set(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    c.set(b.pos[j * 3], b.pos[j * 3 + 1], b.pos[j * 3 + 2]).sub(a);
    d.set(b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2]).sub(a);
    fn.crossVectors(c, d);
    vn.set(b.nrm[i * 3] + b.nrm[j * 3] + b.nrm[k * 3], b.nrm[i * 3 + 1] + b.nrm[j * 3 + 1] + b.nrm[k * 3 + 1], b.nrm[i * 3 + 2] + b.nrm[j * 3 + 2] + b.nrm[k * 3 + 2]);
    if (fn.dot(vn) >= 0) agree++;
    else disagree++;
  }
  if (disagree > agree) {
    for (const t of tris) {
      const x = b.idx[t + 1];
      b.idx[t + 1] = b.idx[t + 2];
      b.idx[t + 2] = x;
    }
  }
}

// ───────────────────────────── curves & frames ─────────────────────────────

/**
 * Rotation-minimising frames along a polyline-sampled curve. Returns per-sample tangent (T),
 * normal (N) and binormal (B); N starts from `up` projected off the first tangent.
 */
export function curveFrames(pts: THREE.Vector3[], up: THREE.Vector3): { T: THREE.Vector3[]; N: THREE.Vector3[]; B: THREE.Vector3[] } {
  const n = pts.length;
  const T: THREE.Vector3[] = [];
  const N: THREE.Vector3[] = [];
  const B: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  let nPrev = up.clone().addScaledVector(T[0], -up.dot(T[0]));
  if (nPrev.lengthSq() < 1e-8) nPrev = new THREE.Vector3(1, 0, 0).addScaledVector(T[0], -T[0].x);
  nPrev.normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // double reflection (Wang et al.) — cheap and stable
      const v1 = new THREE.Vector3().subVectors(pts[i], pts[i - 1]);
      const c1 = v1.dot(v1);
      if (c1 > 1e-14) {
        const rL = nPrev.clone().addScaledVector(v1, (-2 / c1) * v1.dot(nPrev));
        const tL = T[i - 1].clone().addScaledVector(v1, (-2 / c1) * v1.dot(T[i - 1]));
        const v2 = new THREE.Vector3().subVectors(T[i], tL);
        const c2 = v2.dot(v2);
        nPrev = c2 > 1e-14 ? rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL)) : rL;
      }
      nPrev.addScaledVector(T[i], -nPrev.dot(T[i])).normalize();
    }
    N.push(nPrev.clone());
    B.push(new THREE.Vector3().crossVectors(T[i], nPrev).normalize());
  }
  return { T, N, B };
}

/** Sample a CatmullRom through control points into `count` points (uniform in arc length). */
export function sampleCurve(ctrl: THREE.Vector3[], count: number, tension = 0.5): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', tension);
  return curve.getSpacedPoints(count - 1);
}

/** Superellipse ring point: angle → (cos, sin) with exponent e (2 = ellipse, >2 boxier). */
export function superCos(a: number, e: number): number {
  const c = Math.cos(a);
  return Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
}
export function superSin(a: number, e: number): number {
  const s = Math.sin(a);
  return Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
}

// ───────────────────────────── small primitives ─────────────────────────────

/** Ellipsoid via loft (poles on ±y) placed by a matrix. */
export function addEllipsoid(
  b: MeshBuilder,
  r: [number, number, number],
  m: THREE.Matrix4,
  rows = 12,
  cols = 16,
  attrib?: AttribFn,
): number {
  const start = loft(b, {
    rows,
    cols,
    point: (v, u, out) => {
      const th = v * Math.PI;
      const ph = u * Math.PI * 2;
      out.set(Math.sin(th) * Math.cos(ph) * r[0], -Math.cos(th) * r[1], -Math.sin(th) * Math.sin(ph) * r[2]);
    },
    attrib,
  });
  b.transform(m, start);
  return start;
}

/** Tube along sampled points with a radius function of t ∈ [0,1] and closed rounded ends. */
export function addTube(
  b: MeshBuilder,
  pts: THREE.Vector3[],
  radius: (t: number, ang: number) => number,
  cols = 10,
  opts: { up?: THREE.Vector3; capStart?: boolean; capEnd?: boolean; attrib?: AttribFn; uvRect?: [number, number, number, number]; twist?: (t: number) => number } = {},
): number {
  const up = opts.up ?? new THREE.Vector3(0, 1, 0);
  const { T, N, B } = curveFrames(pts, up);
  const n = pts.length;
  const capS = opts.capStart !== false;
  const capE = opts.capEnd !== false;
  // add pole rows: extend by a small rounded cap
  const rowsCore = n;
  const capRows = 3;
  const rows = rowsCore + (capS ? capRows : 0) + (capE ? capRows : 0);
  return loft(b, {
    rows,
    cols,
    uvRect: opts.uvRect,
    point: (v, u, out) => {
      const ri = Math.round(v * (rows - 1));
      const ang = u * Math.PI * 2 + (opts.twist ? opts.twist(0) : 0);
      let i: number;
      let capF = 1; // radius scale
      let ext = 0; // axial extension for cap
      if (capS && ri < capRows) {
        i = 0;
        const k = (capRows - ri) / capRows; // 1 → pole
        const phi = k * (Math.PI / 2);
        capF = Math.cos(phi);
        ext = -Math.sin(phi);
      } else if (capE && ri >= rows - capRows) {
        i = n - 1;
        const k = (ri - (rows - capRows - 1)) / capRows;
        const phi = k * (Math.PI / 2);
        capF = Math.cos(phi);
        ext = Math.sin(phi);
      } else {
        i = ri - (capS ? capRows : 0);
      }
      const t = i / (n - 1);
      const a2 = ang + (opts.twist ? opts.twist(t) : 0);
      const r = radius(t, a2);
      const rr = r * capF;
      if (capF < 1e-6) {
        out.copy(pts[i]).addScaledVector(T[i], ext * r);
        return;
      }
      out
        .copy(pts[i])
        .addScaledVector(N[i], Math.cos(a2) * rr)
        .addScaledVector(B[i], Math.sin(a2) * rr)
        .addScaledVector(T[i], ext * r);
    },
    attrib: opts.attrib,
  });
}

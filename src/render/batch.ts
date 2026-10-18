// Geometry batching: collect many small static pieces (each with a transform + colour) and merge
// them into one BufferGeometry, optionally with baked per-vertex lighting. Keeps the static gym
// at a handful of draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type BakeFn = (p: THREE.Vector3, n: THREE.Vector3) => number;

interface Item {
  geo: THREE.BufferGeometry;
}

export interface BatchOpts {
  /** Colour attribute with alpha (itemSize 4). */
  alpha?: boolean;
  /** Include an aSurf attribute (surface material). */
  surf?: boolean;
}

export class Batch {
  private items: Item[] = [];
  private readonly alpha: boolean;
  private readonly surf: boolean;
  private tmpC = new THREE.Color();

  constructor(opts: BatchOpts = {}) {
    this.alpha = !!opts.alpha;
    this.surf = !!opts.surf;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Adds a geometry (consumed: it is transformed in place). `color` multiplies any existing
   * vertex colours; `surf` sets aSurf when the batch has it and the geometry doesn't.
   */
  add(
    geo: THREE.BufferGeometry,
    matrix: THREE.Matrix4 | null,
    color: THREE.ColorRepresentation = 0xffffff,
    opts: { alpha?: number; surf?: [number, number, number, number]; uvScale?: number } = {},
  ): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('position').count;
    const c = this.tmpC.set(color);
    const size = this.alpha ? 4 : 3;
    const prev = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const col = new Float32Array(n * size);
    for (let i = 0; i < n; i++) {
      const pr = prev ? prev.getX(i) : 1;
      const pg = prev ? prev.getY(i) : 1;
      const pb = prev ? prev.getZ(i) : 1;
      const pa = prev && prev.itemSize === 4 ? prev.getW(i) : 1;
      col[i * size] = pr * c.r;
      col[i * size + 1] = pg * c.g;
      col[i * size + 2] = pb * c.b;
      if (this.alpha) col[i * size + 3] = pa * (opts.alpha ?? 1);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, size));
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    else if (opts.uvScale) {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * opts.uvScale, uv.getY(i) * opts.uvScale);
    }
    if (this.surf) {
      if (!g.getAttribute('aSurf')) {
        const s = new Float32Array(n * 4);
        const sv = opts.surf ?? [0, 0, 0, 0];
        for (let i = 0; i < n; i++) s.set(sv, i * 4);
        g.setAttribute('aSurf', new THREE.BufferAttribute(s, 4));
      }
    } else if (g.getAttribute('aSurf')) {
      g.deleteAttribute('aSurf');
    }
    // keep only the attributes every item shares
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color', 'aSurf'].includes(name)) g.deleteAttribute(name);
    }
    g.clearGroups();
    this.items.push({ geo: g });
  }

  /**
   * Merge everything. `bake` multiplies vertex colours by a lighting factor in world space;
   * `maxColor` caps the baked colour (use ≈0.9 when colours are albedos, so bright paints never
   * exceed physical range and bloom; leave uncapped when colours are texture multipliers).
   */
  build(bake?: BakeFn, maxColor = Infinity): THREE.BufferGeometry | null {
    if (!this.items.length) return null;
    const merged = mergeGeometries(
      this.items.map((i) => i.geo),
      false,
    );
    for (const i of this.items) i.geo.dispose();
    this.items = [];
    if (!merged) return null;
    if (bake) {
      const p = merged.getAttribute('position') as THREE.BufferAttribute;
      const nr = merged.getAttribute('normal') as THREE.BufferAttribute;
      const col = merged.getAttribute('color') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        n.fromBufferAttribute(nr, i);
        const f = bake(v, n);
        col.setXYZ(i, Math.min(maxColor, col.getX(i) * f), Math.min(maxColor, col.getY(i) * f), Math.min(maxColor, col.getZ(i) * f));
      }
    }
    merged.computeBoundingSphere();
    return merged;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Shorthand transform: position, Euler rotation (XYZ), scale. Returns a shared matrix. */
export function tr(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Matrix that maps a box spanning segment a→b (along its local +Y) with the given thickness. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, out = new THREE.Matrix4()): THREE.Matrix4 {
  const d = _p.subVectors(b, a);
  const len = d.length();
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return out.compose(mid, _q, _s.set(1, len, 1));
}

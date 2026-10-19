// Exact volume shapes for the editor (main thread only): the outline of a volume's base on the wall and
// the height of its faces, read from the renderer's own geometry (render/holds.ts holdGeometry), so a
// hold bolted onto a volume in the editor lands where the renderer seats it (HoldSet.mountOn casts a
// ray along the wall normal onto the volume's faces). Installed into the pure model with
// setVolumeShapes(); the model falls back to an ellipse without it (worker, tests).

import type { HoldDef, Vec2 } from '../core/types';
import { holdGeometry, holdVariant } from '../render/holds';
import type { VolumeShape } from './model';

interface UnitShape {
  /** Convex hull of the base (unit size, hold-local x/y). */
  hull: Vec2[];
  /** Upward-facing triangles (x, y, z per vertex, 9 floats each), unit size. */
  tris: Float32Array;
}

const units = new Map<string, UnitShape>();

function unitShape(seed: number, shape: HoldDef['shape']): UnitShape | null {
  const v = Math.abs(Math.floor(seed)) % 6;
  const dual = shape === 'dual-tex';
  const key = `${v}:${dual ? 'd' : ''}`;
  const hit = units.get(key);
  if (hit) return hit;
  let geo;
  try {
    // size 1 → the unit build (the geometry scales linearly with size); the finish doesn't change it
    geo = holdGeometry('volume', v + 6, 1, 0, holdVariant({ shape: dual ? 'dual-tex' : undefined })).geo;
  } catch {
    return null;
  }
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const base: Vec2[] = [];
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < 0.01) base.push({ x: pos.getX(i), y: pos.getY(i) });
  const hull = convexHull(base);
  if (hull.length < 3) return null;
  const tris: number[] = [];
  const n = idx ? idx.count : pos.count;
  for (let k = 0; k + 2 < n; k += 3) {
    const a = idx ? idx.getX(k) : k;
    const b = idx ? idx.getX(k + 1) : k + 1;
    const c = idx ? idx.getX(k + 2) : k + 2;
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    // upward (toward the climber) faces only; skip the base and slivers
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(nz) < 1e-6) continue;
    if (Math.max(az, bz, cz) < 0.005) continue;
    tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  const out = { hull, tris: new Float32Array(tris) };
  units.set(key, out);
  return out;
}

function convexHull(pts: Vec2[]): Vec2[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Highest face of the unit shape above hold-local point (x, y), 0 when off it. */
function unitLift(u: UnitShape, x: number, y: number): number {
  const t = u.tris;
  let best = 0;
  for (let k = 0; k < t.length; k += 9) {
    const ax = t[k], ay = t[k + 1], az = t[k + 2];
    const bx = t[k + 3], by = t[k + 4], bz = t[k + 5];
    const cx = t[k + 6], cy = t[k + 7], cz = t[k + 8];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const z = l1 * az + l2 * bz + l3 * cz;
    if (z > best) best = z;
  }
  return best;
}

/** The exact base outline + face height of a volume as the renderer builds it, or null. */
export function exactVolumeShape(vol: HoldDef): VolumeShape | null {
  if (vol.type !== 'volume') return null;
  const u = unitShape(vol.seed, vol.shape);
  if (!u) return null;
  const t = vol.angle + Math.PI / 2;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = vol.size;
  const outline = u.hull.map((q) => ({ x: vol.x + (q.x * c - q.y * s) * k, y: vol.y + (q.x * s + q.y * c) * k }));
  return {
    outline,
    lift: (p) => {
      const dx = (p.x - vol.x) / k;
      const dy = (p.y - vol.y) / k;
      return unitLift(u, dx * c + dy * s, -dx * s + dy * c) * k;
    },
  };
}

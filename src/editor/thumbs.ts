// Real 3D previews of holds and volumes for the palette and the inspector, drawn from the renderer's
// own geometry (render/holds.ts holdGeometry: the exact shape, edge depth, lip, fingers, dual-tex and
// wood finish the wall shows) with a tiny flat-shaded software rasteriser into a 2D canvas: no second
// WebGL context, cheap enough to redraw every tile when the route colour changes.

import type { HoldDef } from '../core/types';
import { holdGeometry, holdVariant, woodColor } from '../render/holds';

export type ThumbHold = Pick<HoldDef, 'type' | 'size' | 'seed'> & Partial<Pick<HoldDef, 'shape' | 'fingers' | 'edgeDepthMm' | 'lipAngle'>>;

export interface ThumbOpts {
  /** CSS size of the canvas. */
  w: number;
  h: number;
  /** Route colour (hex). */
  color: string;
  dpr?: number;
  /** Scale the hold by its real size (palette: bigger products read bigger) instead of filling the tile. */
  sized?: boolean;
}

const LIGHT = norm3(-0.45, 0.68, 0.6);
const HALF = norm3(LIGHT[0], LIGHT[1], LIGHT[2] + 1);
const YAW = -0.32;
const PITCH = 0.62;

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function hexLin(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0xd54051;
  return [toLin(((n >> 16) & 255) / 255), toLin(((n >> 8) & 255) / 255), toLin((n & 255) / 255)];
}

interface Tri {
  z: number;
  pts: number[];
  col: string;
}

/** Projected, shaded triangles of a hold (cached per product + colour). */
const cache = new Map<string, { tris: Tri[]; minX: number; maxX: number; minY: number; maxY: number }>();

function build(h: ThumbHold, color: string): { tris: Tri[]; minX: number; maxX: number; minY: number; maxY: number } {
  const v = holdVariant(h);
  const key = `${h.type}:${h.shape ?? ''}:${Math.abs(h.seed) % 6}:${Math.round(h.size * 200)}:${v.edgeDepthMm ?? ''}:${v.lipAngle ?? ''}:${v.fingers ?? ''}:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = holdGeometry(h.type, h.seed, h.size, 0, v).geo;
  const pos = g.getAttribute('position');
  const col = g.getAttribute('color');
  const surf = g.getAttribute('aSurf');
  const idx = g.getIndex();
  const n = pos.count;
  // yaw then pitch (seen from the front, a little from above and to the left)
  const cy = Math.cos(YAW);
  const sy = Math.sin(YAW);
  const cp = Math.cos(PITCH);
  const sp = Math.sin(PITCH);
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const Z = new Float32Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    X[i] = x1;
    Y[i] = y2;
    Z[i] = z2;
    if (x1 < minX) minX = x1;
    if (x1 > maxX) maxX = x1;
    if (y2 < minY) minY = y2;
    if (y2 > maxY) maxY = y2;
  }
  let base = hexLin(color);
  if (h.shape === 'wood') {
    const c = woodColor(color, 0.22);
    base = [c.r, c.g, c.b];
  }
  const tris: Tri[] = [];
  const count = idx ? idx.count : n;
  for (let k = 0; k + 2 < count; k += 3) {
    const a = idx ? idx.getX(k) : k;
    const b = idx ? idx.getX(k + 1) : k + 1;
    const c = idx ? idx.getX(k + 2) : k + 2;
    const ux = X[b] - X[a];
    const uy = Y[b] - Y[a];
    const uz = Z[b] - Z[a];
    const vx = X[c] - X[a];
    const vy = Y[c] - Y[a];
    const vz = Z[c] - Z[a];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nz <= 0.02) continue; // facing away
    const tone = col ? (col.getX(a) + col.getX(b) + col.getX(c)) / 3 : 1;
    const gloss = surf ? (surf.getW(a) + surf.getW(b) + surf.getW(c)) / 3 : 0;
    const chalk = surf ? (surf.getX(a) + surf.getX(b) + surf.getX(c)) / 3 : 0;
    const dif = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const spec = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 26) * (0.18 + 0.5 * gloss);
    const rim = Math.pow(1 - nz, 3) * 0.1;
    const lit = 0.2 + 0.95 * dif;
    const ch = Math.min(0.5, chalk * 0.35);
    const rgb = [0, 1, 2].map((j) => {
      const albedo = base[j] * tone * (1 - ch) + 0.75 * ch;
      return Math.round(Math.min(1, toSrgb(Math.min(1, albedo * lit + spec + rim))) * 255);
    });
    tris.push({ z: (Z[a] + Z[b] + Z[c]) / 3, pts: [X[a], Y[a], X[b], Y[b], X[c], Y[c]], col: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` });
  }
  tris.sort((p, q) => p.z - q.z);
  const out = { tris, minX, maxX, minY, maxY };
  if (cache.size > 160) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

/** Draw a hold preview into `canvas` (sized to opts.w × opts.h CSS px). Returns false when 2D canvas is missing. */
export function drawThumb(canvas: HTMLCanvasElement, h: ThumbHold, o: ThumbOpts): boolean {
  const dpr = o.dpr ?? Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const W = Math.round(o.w * dpr);
  const H = Math.round(o.h * dpr);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  let m: ReturnType<typeof build>;
  try {
    m = build(h, o.color);
  } catch {
    return false;
  }
  const bw = Math.max(1e-4, m.maxX - m.minX);
  const bh = Math.max(1e-4, m.maxY - m.minY);
  const pad = 3 * dpr;
  let k = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
  if (o.sized) {
    // bigger products read bigger, compressed so a foot chip is still a readable shape
    const d = Math.max(bw, bh);
    k *= Math.min(1, Math.max(0.5, 0.42 + 0.58 * Math.sqrt(d / 0.3)));
  }
  const cx = W / 2 - ((m.minX + m.maxX) / 2) * k;
  const cy = H / 2 + ((m.minY + m.maxY) / 2) * k;
  const path = (t: Tri, dx: number, dy: number): void => {
    ctx.beginPath();
    ctx.moveTo(cx + t.pts[0] * k + dx, cy - t.pts[1] * k + dy);
    ctx.lineTo(cx + t.pts[2] * k + dx, cy - t.pts[3] * k + dy);
    ctx.lineTo(cx + t.pts[4] * k + dx, cy - t.pts[5] * k + dy);
    ctx.closePath();
  };
  // contact shadow on the wall, down and right of the hold
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  try {
    ctx.filter = `blur(${(1.6 * dpr).toFixed(1)}px)`;
  } catch {
    /* no canvas filters */
  }
  const sd = 2.2 * dpr;
  for (const t of m.tris) {
    path(t, sd * 0.6, sd);
    ctx.fill();
  }
  ctx.restore();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.6, 0.5 * dpr);
  for (const t of m.tris) {
    path(t, 0, 0);
    ctx.fillStyle = t.col;
    ctx.strokeStyle = t.col;
    ctx.fill();
    ctx.stroke();
  }
  return true;
}

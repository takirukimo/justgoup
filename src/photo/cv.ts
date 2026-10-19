// Local hold detector (research §5.1 steps 3–5), plain TypeScript on the rectified wall image:
//   colour distance map (Lab, against 1–3 tapped samples) → threshold → 3×3 majority → open → close →
//   fill holes → 8-connected components → moments, hull, solidity → split touching holds (persistence
//   watershed on the distance transform) → merge fragments → tape / volume / noise filters.
// Morphology runs on a 5-7-11 chamfer distance transform (Borgefors: within ~2 % of Euclidean), so the
// round structuring elements cost two cache-friendly raster passes whatever their radius. No DOM: runs
// in a worker.

import { colorDistance, type LabImage } from './color';
import type { BlobKind, DetectParams, DetectResult, Lab, PhotoBlob } from './types';

export const CV = {
  /** Sensitivity 0..1 → colour distance threshold (ΔE-ish units). Research: start at 12–18. */
  tMin: 7,
  tMax: 31,
  defaultSensitivity: 0.45,
  /** Opening radius (m): removes specks thinner than ~2 r. */
  openM: 0.005,
  /** Closing radius (m): bridges gloss, chalk and seams inside a hold. */
  closeM: 0.014,
  /** Smallest hold kept (equivalent diameter, m). */
  minHoldM: 0.018,
  /** Tape: long and thin. */
  tapeAspect: 4.2,
  tapeMaxWidthM: 0.04,
  tapeMinLengthM: 0.1,
  /** …and straight: a curved crescent edge has a hollow hull. */
  tapeSolidity: 0.72,
  /** Bigger than this (longest dimension, m) reads as a volume. */
  volumeM: 0.5,
  volumeEqM: 0.4,
  /** Blobs less solid than this are tested for touching holds. */
  splitSolidity: 0.92,
  /** Blobs less solid than this are checked for start tape stuck against them… */
  peelSolidity: 0.86,
  /** …with a round opening this wide (radius, m): wider than tape (≈ 2.5 cm, a little more once blurred). */
  peelM: 0.021,
  /** A second peak must stand this far (fraction of its radius) above the saddle to be its own hold. */
  splitPersistence: 0.3,
  /** Fragments closer than this (m) merge into one hold… */
  mergeGapM: 0.035,
  /** …unless the merged hold would be longer than this (m). */
  mergeMaxM: 0.32,
  /** Pocket: a filled hole this big and this much darker than the hold around it. */
  pocketHoleFrac: 0.05,
  pocketDarkL: 12,
  /** …or a core this much darker (L) than the ring around it. */
  pocketCoreL: 9,
  /** Small regions whose colour only just matches are dropped (conf below this). */
  minConf: 0.45,
  minConfKeepM: 0.08,
} as const;

export const thresholdFor = (sensitivity: number): number => CV.tMin + (CV.tMax - CV.tMin) * Math.max(0, Math.min(1, sensitivity));

/**
 * Per-pixel colour distance to the nearest sample. A pixel nearer to an "exclude" colour (a tap on a
 * similar hold of another route, or the wall itself) than to every sample never matches: purple vs
 * blue, red vs pink and black holds on a charcoal wall are decided by the nearer class, not a threshold.
 */
export function distanceMap(lab: LabImage, samples: readonly Lab[], exclude: readonly Lab[] = []): Float32Array {
  const n = lab.width * lab.height;
  const out = new Float32Array(n);
  const { L, a, b } = lab;
  const reject = CV.tMax + 1;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let s = 0; s < samples.length; s++) {
      const d = colorDistance(L[i], a[i], b[i], samples[s]);
      if (d < best) best = d;
    }
    if (best < reject) {
      for (let s = 0; s < exclude.length; s++) {
        if (colorDistance(L[i], a[i], b[i], exclude[s]) < best * 0.92) {
          best = Math.max(best, reject);
          break;
        }
      }
    }
    out[i] = best;
  }
  return out;
}

/** The wall's own colour: the per-channel median of the image (holds cover a small part of it). */
export function wallColor(lab: LabImage): Lab {
  const hist = (arr: Float32Array, lo: number, hi: number): number => {
    const bins = new Uint32Array(hi - lo + 1);
    const step = Math.max(1, Math.floor(arr.length / 120000));
    let cnt = 0;
    for (let i = 0; i < arr.length; i += step) {
      bins[Math.max(0, Math.min(hi - lo, Math.round(arr[i]) - lo))]++;
      cnt++;
    }
    let acc = 0;
    for (let k = 0; k < bins.length; k++) {
      acc += bins[k];
      if (acc * 2 >= cnt) return k + lo;
    }
    return 0;
  };
  return { L: hist(lab.L, 0, 100), a: hist(lab.a, -128, 127), b: hist(lab.b, -128, 127) };
}

/** Exclude colours for a sample set: the user's "not this" taps, plus the wall unless it looks like the hold. */
export function excludeSet(wall: Lab | null, samples: readonly Lab[], negatives: readonly Lab[]): Lab[] {
  const out = [...negatives];
  if (wall && samples.every((s) => colorDistance(wall.L, wall.a, wall.b, s) > CV.tMax * 0.9)) out.push(wall);
  return out;
}

// ───────────────────────────── binary morphology ─────────────────────────────

const FAR = 1 << 28;

/**
 * Chamfer distance (5-7-11 units: 5 per pixel step) from every pixel to the nearest pixel with
 * mask === feature. Divide by 5 for pixels.
 */
export function chamfer(mask: Uint8Array, w: number, h: number, feature: 0 | 1): Int32Array {
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] === feature ? 0 : FAR;
  // forward: neighbours above and to the left
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 5);
      if (y > 0) {
        const u = i - w;
        v = Math.min(v, d[u] + 5);
        if (x > 0) v = Math.min(v, d[u - 1] + 7);
        if (x < w - 1) v = Math.min(v, d[u + 1] + 7);
        if (x > 1) v = Math.min(v, d[u - 2] + 11);
        if (x < w - 2) v = Math.min(v, d[u + 2] + 11);
        if (y > 1) {
          const uu = u - w;
          if (x > 0) v = Math.min(v, d[uu - 1] + 11);
          if (x < w - 1) v = Math.min(v, d[uu + 1] + 11);
        }
      }
      d[i] = v;
    }
  }
  // backward: neighbours below and to the right
  for (let y = h - 1; y >= 0; y--) {
    const o = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = o + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 5);
      if (y < h - 1) {
        const u = i + w;
        v = Math.min(v, d[u] + 5);
        if (x < w - 1) v = Math.min(v, d[u + 1] + 7);
        if (x > 0) v = Math.min(v, d[u - 1] + 7);
        if (x < w - 2) v = Math.min(v, d[u + 2] + 11);
        if (x > 1) v = Math.min(v, d[u - 2] + 11);
        if (y < h - 2) {
          const uu = u + w;
          if (x < w - 1) v = Math.min(v, d[uu + 1] + 11);
          if (x > 0) v = Math.min(v, d[uu - 1] + 11);
        }
      }
      d[i] = v;
    }
  }
  return d;
}

/** Pixels within r of the mask. */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const d = chamfer(m, w, h, 1);
  const out = new Uint8Array(w * h);
  const lim = r * 5;
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= lim ? 1 : 0;
  return out;
}

/** Mask pixels further than r from the background (the image border does not count as background). */
export function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const d = chamfer(m, w, h, 0);
  const out = new Uint8Array(w * h);
  const lim = r * 5;
  for (let i = 0; i < out.length; i++) out[i] = d[i] > lim ? 1 : 0;
  return out;
}

/** 3×3 majority (the median of a binary image), via separable box sums. */
export function majority3(m: Uint8Array, w: number, h: number): Uint8Array {
  const hs = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) hs[o + x] = m[o + x] + (x > 0 ? m[o + x - 1] : 0) + (x < w - 1 ? m[o + x + 1] : 0);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const ny = (y > 0 ? 1 : 0) + 1 + (y < h - 1 ? 1 : 0);
    for (let x = 0; x < w; x++) {
      const s = hs[o + x] + (y > 0 ? hs[o + x - w] : 0) + (y < h - 1 ? hs[o + x + w] : 0);
      const nx = (x > 0 ? 1 : 0) + 1 + (x < w - 1 ? 1 : 0);
      out[o + x] = s * 2 > nx * ny ? 1 : 0;
    }
  }
  return out;
}

/** Fill enclosed background (4-connected background, so 8-connected regions enclose). Returns the hole mask. */
export function fillHoles(m: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const push = (i: number): void => {
    if (!m[i] && !seen[i]) {
      seen[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const holes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!m[i] && !seen[i]) {
      holes[i] = 1;
      m[i] = 1;
    }
  }
  return holes;
}

// ───────────────────────────── components ─────────────────────────────

interface Components {
  /** Label per pixel (0 = background, 1..count). */
  labels: Int32Array;
  count: number;
  /** Pixel indices grouped by component: pix[start[c] .. start[c] + len[c]). */
  pix: Int32Array;
  start: Int32Array;
  len: Int32Array;
}

/** 8-connected component labelling (raster union-find, then a counting sort into pixel lists). */
export function label8(m: Uint8Array, w: number, h: number): Components {
  const n = w * h;
  const labels = new Int32Array(n);
  const parent: number[] = [0];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number): number => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    if (ra < rb) {
      parent[rb] = ra;
      return ra;
    }
    parent[ra] = rb;
    return rb;
  };
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      if (!m[i]) continue;
      let l = 0;
      if (x > 0 && labels[i - 1]) l = labels[i - 1];
      if (y > 0) {
        const u = i - w;
        if (x > 0 && labels[u - 1]) l = l ? union(l, labels[u - 1]) : labels[u - 1];
        if (labels[u]) l = l ? union(l, labels[u]) : labels[u];
        if (x < w - 1 && labels[u + 1]) l = l ? union(l, labels[u + 1]) : labels[u + 1];
      }
      if (!l) {
        l = parent.length;
        parent.push(l);
      }
      labels[i] = l;
    }
  }
  // compact the roots to 1..count
  const remap = new Int32Array(parent.length);
  let count = 0;
  for (let k = 1; k < parent.length; k++) {
    const r = find(k);
    if (!remap[r]) remap[r] = ++count;
    remap[k] = remap[r];
  }
  const len = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) {
    if (!labels[i]) continue;
    const c = remap[labels[i]];
    labels[i] = c;
    len[c]++;
  }
  const start = new Int32Array(count + 1);
  let acc = 0;
  for (let c = 1; c <= count; c++) {
    start[c] = acc;
    acc += len[c];
  }
  const pix = new Int32Array(acc);
  const fillAt = start.slice();
  for (let i = 0; i < n; i++) if (labels[i]) pix[fillAt[labels[i]]++] = i;
  return { labels, count, pix, start, len };
}

/** Monotone-chain convex hull of flat points; returns flat CCW (screen: CW) hull. */
export function convexHull(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => pts[i * 2] - pts[j * 2] || pts[i * 2 + 1] - pts[j * 2 + 1]);
  const cross = (o: number, a: number, b: number): number =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const out: number[] = [];
  for (const i of lower.concat(upper)) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

export function polyArea(p: number[]): number {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(s) / 2;
}

/** Is (x, y) inside the convex polygon (flat), grown by `pad` px? */
export function inHull(hull: number[], x: number, y: number, pad = 0): boolean {
  const n = hull.length / 2;
  if (n < 3) return n > 0 && Math.hypot(hull[0] - x, hull[1] - y) <= pad + 1;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = hull[i * 2];
    const ay = hull[i * 2 + 1];
    const ex = hull[j * 2] - ax;
    const ey = hull[j * 2 + 1] - ay;
    const len = Math.hypot(ex, ey) || 1;
    const c = (ex * (y - ay) - ey * (x - ax)) / len;
    if (c > pad) pos++;
    else if (c < -pad) neg++;
  }
  return pos === 0 || neg === 0;
}

/** Shortest gap between two convex polygons (0 when they overlap). */
export function hullGap(a: number[], b: number[]): number {
  const na = a.length / 2;
  const nb = b.length / 2;
  for (let i = 0; i < na; i++) if (inHull(b, a[i * 2], a[i * 2 + 1])) return 0;
  for (let i = 0; i < nb; i++) if (inHull(a, b[i * 2], b[i * 2 + 1])) return 0;
  let best = Infinity;
  const segDist = (px: number, py: number, p: number[], n: number): number => {
    let m = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const ux = p[j * 2] - ax;
      const uy = p[j * 2 + 1] - ay;
      const l2 = ux * ux + uy * uy;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ux + (py - ay) * uy) / l2));
      m = Math.min(m, Math.hypot(px - ax - ux * t, py - ay - uy * t));
    }
    return m;
  };
  for (let i = 0; i < na; i++) best = Math.min(best, segDist(a[i * 2], a[i * 2 + 1], b, nb));
  for (let i = 0; i < nb; i++) best = Math.min(best, segDist(b[i * 2], b[i * 2 + 1], a, na));
  return best;
}

/** Running moments of a pixel set (plus the pixel lists, for the hull and the overlay). */
class Moments {
  n = 0;
  sx = 0;
  sy = 0;
  sxx = 0;
  syy = 0;
  sxy = 0;
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  holes = 0;
  holeL = 0;
  solidL = 0;
  dSum = 0;
  lists: Int32Array[] = [];

  add(x: number, y: number): void {
    this.n++;
    this.sx += x;
    this.sy += y;
    this.sxx += x * x;
    this.syy += y * y;
    this.sxy += x * y;
    if (x < this.x0) this.x0 = x;
    if (x > this.x1) this.x1 = x;
    if (y < this.y0) this.y0 = y;
    if (y > this.y1) this.y1 = y;
  }

  merge(o: Moments): void {
    this.n += o.n;
    this.sx += o.sx;
    this.sy += o.sy;
    this.sxx += o.sxx;
    this.syy += o.syy;
    this.sxy += o.sxy;
    this.x0 = Math.min(this.x0, o.x0);
    this.y0 = Math.min(this.y0, o.y0);
    this.x1 = Math.max(this.x1, o.x1);
    this.y1 = Math.max(this.y1, o.y1);
    this.holes += o.holes;
    this.holeL += o.holeL;
    this.solidL += o.solidL;
    this.dSum += o.dSum;
    for (const l of o.lists) this.lists.push(l);
  }

  /** Convex hull (pixel corners) from the per-row extents. `w` = image width (pixel index → x, y). */
  hull(w: number): number[] {
    if (!this.n) return [];
    const rows = this.y1 - this.y0 + 1;
    const lo = new Int32Array(rows).fill(1 << 30);
    const hi = new Int32Array(rows).fill(-1);
    for (const l of this.lists) {
      for (let k = 0; k < l.length; k++) {
        const i = l[k];
        const x = i % w;
        const r = (i - x) / w - this.y0;
        if (x < lo[r]) lo[r] = x;
        if (x > hi[r]) hi[r] = x;
      }
    }
    const pts: number[] = [];
    for (let r = 0; r < rows; r++) {
      if (hi[r] < 0) continue;
      const y = r + this.y0;
      pts.push(lo[r], y, lo[r], y + 1, hi[r] + 1, y, hi[r] + 1, y + 1);
    }
    return convexHull(pts);
  }
}

interface Region {
  mo: Moments;
  /** Peeled off a hold as tape. */
  tape?: boolean;
  /** Original component (split siblings never merge back). */
  parent: number;
  alive: boolean;
}

function blobOf(id: number, r: Region, kind: BlobKind, threshold: number, w: number): PhotoBlob {
  const mo = r.mo;
  const n = mo.n;
  const cx = mo.sx / n;
  const cy = mo.sy / n;
  const a = mo.sxx / n - cx * cx + 1 / 12;
  const c = mo.syy / n - cy * cy + 1 / 12;
  const b = mo.sxy / n - cx * cy;
  const tr = (a + c) / 2;
  const det = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b));
  const l1 = tr + det;
  const l2 = Math.max(1e-6, tr - det);
  const hull = mo.hull(w);
  const ha = polyArea(hull);
  const solid = n - mo.holes;
  const holeFrac = mo.holes / n;
  const pocket = holeFrac >= CV.pocketHoleFrac && mo.holes > 0 && solid > 0 && mo.holeL / mo.holes < mo.solidL / solid - CV.pocketDarkL;
  const meanD = solid > 0 ? mo.dSum / solid : threshold;
  return {
    id,
    kind,
    x: cx + 0.5,
    y: cy + 0.5,
    area: n,
    major: 4 * Math.sqrt(l1),
    minor: 4 * Math.sqrt(l2),
    theta: 0.5 * Math.atan2(2 * b, a - c),
    solidity: ha > 0 ? Math.min(1, n / ha) : 1,
    hull,
    holeFrac,
    pocket,
    conf: Math.max(0, Math.min(1, 1 - meanD / Math.max(1e-6, threshold)) * 0.7 + 0.3),
  };
}

/** What a region reads as at this scale (null = noise, dropped). */
export function classify(major: number, minor: number, area: number, ppm: number, solidity = 1): BlobKind | null {
  const eq = (2 * Math.sqrt(area / Math.PI)) / ppm;
  const M = major / ppm;
  const m = minor / ppm;
  if (eq < CV.minHoldM) return null;
  if (M > CV.volumeM || eq > CV.volumeEqM) return 'volume';
  // tape is a straight strip; a crescent edge is as long and thin but curved (hollow hull)
  if (M / Math.max(1e-6, m) > CV.tapeAspect && m < CV.tapeMaxWidthM && M > CV.tapeMinLengthM && solidity >= CV.tapeSolidity) return 'tape';
  return 'hold';
}

/**
 * Seeds of the holds a blob is made of: peaks of the inner distance transform that stand clear of the
 * saddle joining them to a higher peak (persistence), so two holds touching at a neck split while a
 * crescent's even ridge or a peanut-shaped hold stays whole.
 */
function splitSeeds(pixels: Int32Array, dist: Float32Array, w: number, scratch: Int32Array): { x: number; y: number; r: number }[] {
  const n = pixels.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => dist[pixels[j]] - dist[pixels[i]]);
  const parent = new Int32Array(n).fill(-1);
  const peak = new Float32Array(n);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let k = 0; k < n; k++) scratch[pixels[k]] = k + 1;
  const seeds: { x: number; y: number; r: number }[] = [];
  const peakPos = new Int32Array(n);
  for (const li of order) {
    const gi = pixels[li];
    const d = dist[gi];
    parent[li] = li;
    peak[li] = d;
    peakPos[li] = gi;
    const x = gi % w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if ((dx < 0 && x === 0) || (dx > 0 && x === w - 1)) continue;
        const gj = gi + dy * w + dx;
        if (gj < 0 || gj >= scratch.length) continue;
        const lj = scratch[gj] - 1;
        if (lj < 0 || parent[lj] < 0) continue;
        const ra = find(li);
        const rb = find(lj);
        if (ra === rb) continue;
        // the lower peak meets the higher one at this saddle
        const lo = peak[ra] <= peak[rb] ? ra : rb;
        const hi = lo === ra ? rb : ra;
        const pLo = peak[lo];
        if (pLo - d >= Math.max(2, CV.splitPersistence * pLo) && pLo >= 3) {
          const p = peakPos[lo];
          seeds.push({ x: p % w, y: Math.floor(p / w), r: pLo });
        }
        parent[lo] = hi;
      }
    }
  }
  for (let k = 0; k < n; k++) scratch[pixels[k]] = 0;
  if (!seeds.length) return [];
  // the peak that absorbed the others is a seed too
  const root = find(order[0]);
  const tp = peakPos[root];
  seeds.push({ x: tp % w, y: Math.floor(tp / w), r: peak[root] });
  return seeds;
}

/** A pocket's mouth that did not match (filled as a hole): enough hole pixels far darker than the hold. */
function darkHoles(mo: Moments, holes: Uint8Array, L: Float32Array): boolean {
  const solid = mo.n - mo.holes;
  if (mo.holes < 6 || solid <= 0) return false;
  const ref = mo.solidL / solid - 15;
  let dark = 0;
  for (const l of mo.lists) for (let k = 0; k < l.length; k++) if (holes[l[k]] && L[l[k]] < ref) dark++;
  return dark >= Math.max(6, mo.n * 0.04);
}

/**
 * A pocket whose mouth still matched the colour (a dark shade of it): the hold's core is clearly darker
 * than the ring around it, where a dome or an edge is lit (or glossy) in the middle.
 */
function darkCore(mo: Moments, inner: Float32Array, L: Float32Array): boolean {
  let maxD = 0;
  for (const l of mo.lists) for (let k = 0; k < l.length; k++) if (inner[l[k]] > maxD) maxD = inner[l[k]];
  if (maxD < 4) return false;
  let cs = 0;
  let cn = 0;
  let rs = 0;
  let rn = 0;
  for (const l of mo.lists) {
    for (let k = 0; k < l.length; k++) {
      const d = inner[l[k]];
      if (d >= maxD * 0.55) {
        cs += L[l[k]];
        cn++;
      } else if (d > 1.5 && d < maxD * 0.4) {
        rs += L[l[k]];
        rn++;
      }
    }
  }
  if (cn < 10 || rn < 10) return false;
  const core = cs / cn;
  const ring = rs / rn;
  return ring - core > CV.pocketCoreL && core < ring * 0.84;
}

/**
 * Start tape stuck right against a hold makes one blob with a thin tail. A round opening a little wider
 * than tape keeps the hold's body; long, thin leftovers are the tape. Returns [hold pixels, tape pixels…],
 * or null when the blob has no tape on it.
 */
function peelTape(pixels: Int32Array, w: number, ppm: number): Int32Array[] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < pixels.length; k++) {
    const i = pixels[k];
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const pad = 2;
  const lw = x1 - x0 + 1 + pad * 2;
  const lh = y1 - y0 + 1 + pad * 2;
  const local = new Uint8Array(lw * lh);
  const at = (i: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    return (y - y0 + pad) * lw + (x - x0 + pad);
  };
  for (let k = 0; k < pixels.length; k++) local[at(pixels[k])] = 1;
  const r = Math.max(1.5, CV.peelM * ppm);
  const opened = dilate(erode(local, lw, lh, r), lw, lh, r + 1);
  const residue = new Uint8Array(lw * lh);
  let core = 0;
  for (let i = 0; i < residue.length; i++) {
    residue[i] = local[i] && !opened[i] ? 1 : 0;
    if (local[i] && opened[i]) core++;
  }
  if (core < Math.PI * (0.02 * ppm) ** 2) return null;
  const comps = label8(residue, lw, lh);
  const tapeLabel = new Uint8Array(comps.count + 1);
  let any = false;
  for (let c = 1; c <= comps.count; c++) {
    const mo = new Moments();
    for (let k = 0; k < comps.len[c]; k++) {
      const i = comps.pix[comps.start[c] + k];
      const x = i % lw;
      mo.add(x, (i - x) / lw);
    }
    const n = mo.n;
    if (n < 4) continue;
    const cx = mo.sx / n;
    const cy = mo.sy / n;
    const a = mo.sxx / n - cx * cx + 1 / 12;
    const cc = mo.syy / n - cy * cy + 1 / 12;
    const b = mo.sxy / n - cx * cy;
    const det = Math.sqrt(Math.max(0, ((a - cc) / 2) ** 2 + b * b));
    const major = 4 * Math.sqrt((a + cc) / 2 + det);
    const minor = 4 * Math.sqrt(Math.max(1e-6, (a + cc) / 2 - det));
    if (major / minor > CV.tapeAspect * 0.8 && minor / ppm < CV.tapeMaxWidthM && major / ppm > CV.tapeMinLengthM * 0.8) {
      tapeLabel[c] = 1;
      any = true;
    }
  }
  if (!any) return null;
  const hold: number[] = [];
  const tapes = new Map<number, number[]>();
  for (let k = 0; k < pixels.length; k++) {
    const i = pixels[k];
    const c = comps.labels[at(i)];
    if (c && tapeLabel[c]) {
      let t = tapes.get(c);
      if (!t) tapes.set(c, (t = []));
      t.push(i);
    } else hold.push(i);
  }
  return [Int32Array.from(hold), ...[...tapes.values()].map((t) => Int32Array.from(t))];
}

/**
 * Detect the regions of the sampled colour. `dist` is distanceMap(lab, samples); `lab` supplies the
 * lightness for the pocket test.
 */
export function detectBlobs(lab: LabImage, dist: Float32Array, p: DetectParams): DetectResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const w = lab.width;
  const h = lab.height;
  const n = w * h;
  const T = thresholdFor(p.sensitivity);
  let m: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = dist[i] < T ? 1 : 0;
  m = majority3(m, w, h);
  const rOpen = Math.max(1, CV.openM * p.ppm);
  const rClose = Math.max(1.5, CV.closeM * p.ppm);
  m = dilate(erode(m, w, h, rOpen), w, h, rOpen);
  m = erode(dilate(m, w, h, rClose), w, h, rClose);
  const holes = fillHoles(m, w, h);
  const comps = label8(m, w, h);
  const ch = chamfer(m, w, h, 0);
  const inner = new Float32Array(n);
  for (let i = 0; i < n; i++) inner[i] = ch[i] / 5;
  const scratch = new Int32Array(n);

  const regions: Region[] = [];
  const addPixels = (mo: Moments, pixels: Int32Array): void => {
    for (let k = 0; k < pixels.length; k++) {
      const i = pixels[k];
      const x = i % w;
      mo.add(x, (i - x) / w);
      if (holes[i]) {
        mo.holes++;
        mo.holeL += lab.L[i];
      } else {
        mo.solidL += lab.L[i];
        mo.dSum += dist[i];
      }
    }
    mo.lists.push(pixels);
  };
  const minPx = Math.PI * (CV.minHoldM * p.ppm * 0.5) ** 2;
  const addGroup = (pixels: Int32Array, c: number, peeled: boolean): void => {
    const len = pixels.length;
    // solidity first (cheap): only hollow-looking blobs pay for the tape peel and the split test
    const mo = new Moments();
    addPixels(mo, pixels);
    const solid = mo.n / Math.max(1, polyArea(mo.hull(w)));
    const big = (Math.max(mo.x1 - mo.x0, mo.y1 - mo.y0) + 1) / p.ppm;
    if (!peeled && solid < CV.peelSolidity && big < CV.volumeM * 1.2) {
      const groups = peelTape(pixels, w, p.ppm);
      if (groups) {
        addGroup(groups[0], c, true);
        for (let k = 1; k < groups.length; k++) {
          const t = new Moments();
          addPixels(t, groups[k]);
          regions.push({ mo: t, parent: c, alive: true, tape: true });
        }
        return;
      }
    }
    const seeds = solid < CV.splitSolidity && big < CV.volumeM * 1.2 ? splitSeeds(pixels, inner, w, scratch) : [];
    if (seeds.length < 2) {
      regions.push({ mo, parent: c, alive: true });
      return;
    }
    // power-diagram assignment: each pixel to the seed it sits deepest inside
    const buckets: number[][] = seeds.map(() => []);
    for (let k = 0; k < len; k++) {
      const i = pixels[k];
      const x = i % w;
      const y = (i - x) / w;
      let best = 0;
      let bv = -Infinity;
      for (let s = 0; s < seeds.length; s++) {
        const v = seeds[s].r - Math.hypot(x - seeds[s].x, y - seeds[s].y);
        if (v > bv) {
          bv = v;
          best = s;
        }
      }
      buckets[best].push(i);
    }
    for (const b of buckets) {
      if (!b.length) continue;
      const part = new Moments();
      addPixels(part, Int32Array.from(b));
      regions.push({ mo: part, parent: c, alive: true });
    }
  };
  for (let c = 1; c <= comps.count; c++) {
    const st = comps.start[c];
    const len = comps.len[c];
    if (len < minPx * 0.9) continue;
    addGroup(comps.pix.subarray(st, st + len), c, false);
  }

  // merge fragments of one hold (a chalk band or a glossy stripe across it)
  const prelim = regions.map((r, i) => {
    const b = blobOf(i, r, 'hold', T, w);
    const kind: BlobKind | null = r.tape ? 'tape' : classify(b.major, b.minor, b.area, p.ppm, b.solidity);
    return { b, kind };
  });
  const gapPx = Math.max(2, CV.mergeGapM * p.ppm);
  for (let i = 0; i < regions.length; i++) {
    if (!regions[i].alive || prelim[i].kind === 'volume' || prelim[i].kind === 'tape') continue;
    for (let j = i + 1; j < regions.length; j++) {
      if (!regions[j].alive || regions[j].parent === regions[i].parent) continue;
      // tape stays tape and volumes stay whole: never glue them onto a hold
      if (prelim[j].kind === 'volume' || prelim[j].kind === 'tape') continue;
      const a = regions[i].mo;
      const b = regions[j].mo;
      if (a.x0 - gapPx > b.x1 + 1 || b.x0 - gapPx > a.x1 + 1 || a.y0 - gapPx > b.y1 + 1 || b.y0 - gapPx > a.y1 + 1) continue;
      const span = Math.max(Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0), Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0)) + 1;
      if (span > CV.mergeMaxM * p.ppm) continue;
      if (hullGap(prelim[i].b.hull, prelim[j].b.hull) > gapPx) continue;
      a.merge(b);
      regions[j].alive = false;
      const nb = blobOf(i, regions[i], 'hold', T, w);
      prelim[i] = { b: nb, kind: classify(nb.major, nb.minor, nb.area, p.ppm, nb.solidity) };
      if (prelim[i].kind !== 'hold') break;
      j = i; // re-scan: the grown region may reach more fragments
    }
  }

  const blobs: PhotoBlob[] = [];
  const mask = new Uint8Array(n);
  const code: Record<BlobKind, number> = { hold: 1, tape: 2, volume: 3 };
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (!r.alive) continue;
    const b = prelim[i].b;
    const kind = prelim[i].kind;
    if (!kind) continue;
    // a small region whose colour only just matches: another route's shaded hold, a stain
    if (b.conf < CV.minConf && Math.sqrt(b.area) / p.ppm < CV.minConfKeepM) continue;
    b.kind = kind;
    if (kind === 'hold' && !b.pocket) b.pocket = darkHoles(r.mo, holes, lab.L) || darkCore(r.mo, inner, lab.L);
    blobs.push(b);
    // overlay mask: this region's pixels, by kind
    const cv = code[kind];
    for (const l of r.mo.lists) for (let k = 0; k < l.length; k++) mask[l[k]] = cv;
  }
  // reading order: top to bottom, then left to right, so the numbers read like a topo
  blobs.sort((a, b) => a.y - b.y || a.x - b.x);
  blobs.forEach((b, i) => (b.id = i + 1));
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { blobs, mask, width: w, height: h, threshold: T, ms: t1 - t0 };
}

/**
 * The region of the sampled colour under a tap, with a looser threshold (a hold the detector missed):
 * flood from the best-matching pixel near the tap, kept to a window around it. Null when nothing there
 * matches or the region is wall-sized.
 */
export function regionAt(lab: LabImage, dist: Float32Array, x: number, y: number, p: DetectParams): PhotoBlob | null {
  const w = lab.width;
  const h = lab.height;
  const T = thresholdFor(Math.min(1, p.sensitivity + 0.3)) * 1.15;
  const R = Math.max(4, Math.round(0.35 * p.ppm));
  const wx0 = Math.max(0, Math.round(x) - R);
  const wy0 = Math.max(0, Math.round(y) - R);
  const wx1 = Math.min(w - 1, Math.round(x) + R);
  const wy1 = Math.min(h - 1, Math.round(y) + R);
  const ww = wx1 - wx0 + 1;
  const wh = wy1 - wy0 + 1;
  if (ww < 3 || wh < 3) return null;
  let m: Uint8Array = new Uint8Array(ww * wh);
  for (let j = 0; j < wh; j++) for (let i = 0; i < ww; i++) m[j * ww + i] = dist[(wy0 + j) * w + wx0 + i] < T ? 1 : 0;
  m = majority3(m, ww, wh);
  const rClose = Math.max(1.5, CV.closeM * p.ppm);
  m = erode(dilate(m, ww, wh, rClose), ww, wh, rClose);
  // start at the best pixel within a finger's width of the tap
  const sr = Math.max(3, Math.round(0.03 * p.ppm));
  let seed = -1;
  let bd = Infinity;
  for (let j = -sr; j <= sr; j++) {
    for (let i = -sr; i <= sr; i++) {
      const xx = Math.round(x) - wx0 + i;
      const yy = Math.round(y) - wy0 + j;
      if (xx < 0 || yy < 0 || xx >= ww || yy >= wh || !m[yy * ww + xx]) continue;
      const d = dist[(yy + wy0) * w + xx + wx0] + Math.hypot(i, j) * 0.5;
      if (d < bd) {
        bd = d;
        seed = yy * ww + xx;
      }
    }
  }
  if (seed < 0) return null;
  const comps = label8(m, ww, wh);
  const c = comps.labels[seed];
  if (!c) return null;
  const st = comps.start[c];
  const len = comps.len[c];
  const mo = new Moments();
  let touches = false;
  const list = new Int32Array(len);
  for (let k = 0; k < len; k++) {
    const i = comps.pix[st + k];
    const xx = i % ww;
    const yy = (i - xx) / ww;
    if ((xx === 0 && wx0 > 0) || (yy === 0 && wy0 > 0) || (xx === ww - 1 && wx1 < w - 1) || (yy === wh - 1 && wy1 < h - 1)) touches = true;
    const gi = (yy + wy0) * w + xx + wx0;
    list[k] = gi;
    mo.add(xx + wx0, yy + wy0);
    mo.solidL += lab.L[gi];
    mo.dSum += dist[gi];
  }
  if (touches) return null; // spills out of the window: the wall itself, or a volume
  mo.lists.push(list);
  const b = blobOf(0, { mo, parent: 0, alive: true }, 'hold', T, w);
  const kind = classify(b.major, b.minor, b.area, p.ppm, b.solidity);
  if (!kind || kind === 'volume') return null;
  b.kind = kind === 'tape' ? 'tape' : 'hold';
  b.manual = true;
  return b;
}

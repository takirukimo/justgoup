// Procedural canvas textures for the CHIRAL gym: wall panels (albedo + normal + roughness),
// tileable plywood for neighbouring walls, crash-pad fabric, polished concrete, hold speckle,
// decal atlas (logo / wordmark / blobs), route tape labels, signage, windows and light shafts.
//
// Everything is deterministic for a given seed so a boulder looks the same on every device.

import * as THREE from 'three';
import { BRAND, PALETTE, WALL } from '../config/brand';
import type { ClimbMode, HoldDef } from '../core/types';
import { Rng, hashString } from '../core/rng';
import { clamp } from '../core/math';
import { drawLogoMark, drawStrokeText, measureStrokeText } from './glyphs';

export const PANEL_W = 1.22;
export const PANEL_H = 2.44;
export const TNUT_STEP = 0.2;

const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace";

// ───────────────────────────── helpers ─────────────────────────────

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${m(A.r, B.r)},${m(A.g, B.g)},${m(A.b, B.b)})`;
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function finishTexture(
  tex: THREE.Texture,
  opts: { srgb?: boolean; repeat?: boolean; anisotropy?: number; mipmaps?: boolean } = {},
): THREE.Texture {
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (opts.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  else tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = opts.anisotropy ?? 4;
  tex.generateMipmaps = opts.mipmaps ?? true;
  tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function canvasTexture(c: HTMLCanvasElement, opts: Parameters<typeof finishTexture>[1] = {}): THREE.CanvasTexture {
  return finishTexture(new THREE.CanvasTexture(c), opts) as THREE.CanvasTexture;
}

// ───────────────────────────── noise tiles ─────────────────────────────

const noiseCache = new Map<string, HTMLCanvasElement>();

/** Tileable gray white-noise tile (alpha = 1). */
function whiteNoiseTile(size: number, seed: number, lo = 0, hi = 255): HTMLCanvasElement {
  const key = `w:${size}:${seed}:${lo}:${hi}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(size, size);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(size, size);
  const rng = new Rng(seed);
  for (let i = 0; i < size * size; i++) {
    const v = lo + (hi - lo) * rng.next();
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseCache.set(key, c);
  return c;
}

/** Tileable value-noise tile (smooth blotches), `cells` lattice cells per side, fractal octaves. */
function valueNoiseTile(size: number, cells: number, seed: number, octaves = 3): HTMLCanvasElement {
  const key = `v:${size}:${cells}:${seed}:${octaves}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(size, size);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(size, size);
  const acc = new Float32Array(size * size);
  const rng = new Rng(seed);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    const lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * n;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = y0 % n;
      const yb = (y0 + 1) % n;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % n;
        const xb = (x0 + 1) % n;
        const a = lat[ya * n + xa] + (lat[ya * n + xb] - lat[ya * n + xa]) * sx;
        const b = lat[yb * n + xa] + (lat[yb * n + xb] - lat[yb * n + xa]) * sx;
        acc[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < acc.length; i++) {
    const v = (acc[i] / norm) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseCache.set(key, c);
  return c;
}

/** Fills the whole canvas (in its current transform) with a scaled, repeating tile. */
function fillPattern(
  ctx: CanvasRenderingContext2D,
  tile: HTMLCanvasElement,
  w: number,
  h: number,
  scale: number,
  alpha: number,
  op: GlobalCompositeOperation = 'source-over',
): void {
  const pat = ctx.createPattern(tile, 'repeat');
  if (!pat) return;
  pat.setTransform(new DOMMatrix().scale(scale, scale));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Height canvas (R channel) → tangent-space normal map canvas. `strength` ≈ px of relief. */
export function heightToNormal(height: HTMLCanvasElement, strength: number, wrap = false): HTMLCanvasElement {
  const w = height.width;
  const h = height.height;
  const src = ctx2d(height).getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const octx = ctx2d(out);
  const img = octx.createImageData(w, h);
  const d = img.data;
  const at = (x: number, y: number): number => {
    if (wrap) {
      x = (x + w) % w;
      y = (y + h) % h;
    } else {
      x = x < 0 ? 0 : x >= w ? w - 1 : x;
      y = y < 0 ? 0 : y >= h ? h - 1 : y;
    }
    return src[(y * w + x) * 4] / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
      // Canvas y goes down; tangent-space +Y is up (texture v up) → flip dy.
      let nx = -dx, ny = dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function gray(v: number, a = 1): string {
  const g = Math.round(clamp(v, 0, 1) * 255);
  return a >= 1 ? `rgb(${g},${g},${g})` : `rgba(${g},${g},${g},${a})`;
}

// ───────────────────────────── wall textures ─────────────────────────────

export interface WallTextureOpts {
  /** Panel width (m). */
  width: number;
  /** Vertical range of this segment (wall-local m). */
  y0: number;
  y1: number;
  /** Full wall height (m). */
  wallHeight: number;
  angleDeg: number;
  mode: ClimbMode;
  holds: readonly HoldDef[];
  seed: number;
  pxPerMeter: number;
  anisotropy?: number;
  /** Wall number used in the spec labels. */
  wallNo?: number;
}

export interface WallTextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  dispose(): void;
}

interface Layer {
  ctx: CanvasRenderingContext2D;
  k: number;
}

/**
 * Builds the albedo/normal/roughness set for one wall segment. The design is laid out in
 * global wall coordinates so stacked segments (rope walls) join seamlessly.
 */
export function createWallTextures(o: WallTextureOpts): WallTextureSet {
  const ppm = o.pxPerMeter;
  const W = Math.min(2048, Math.round(o.width * ppm));
  const ppmX = W / o.width;
  const H = Math.min(2048, Math.round((o.y1 - o.y0) * ppm));
  const ppmY = H / (o.y1 - o.y0);
  const rng = new Rng(o.seed ^ 0x5a17);

  const albedoC = makeCanvas(W, H);
  const heightC = makeCanvas(W / 2, H / 2);
  const roughC = makeCanvas(W / 4, H / 4);
  const A: Layer = { ctx: ctx2d(albedoC), k: 1 };
  const Hh: Layer = { ctx: ctx2d(heightC), k: 0.5 };
  const R: Layer = { ctx: ctx2d(roughC), k: 0.25 };
  for (const L of [A, Hh, R]) L.ctx.setTransform(L.k, 0, 0, L.k, 0, 0);

  const halfW = o.width / 2;
  const X = (x: number) => (x + halfW) * ppmX;
  const Y = (y: number) => (o.y1 - y) * ppmY;
  const M = (m: number) => m * ppmX;

  // ── 1. panel base fill ──
  Hh.ctx.fillStyle = gray(0.5);
  Hh.ctx.fillRect(0, 0, W, H);
  R.ctx.fillStyle = gray(0.8);
  R.ctx.fillRect(0, 0, W, H);

  const iMin = Math.floor(-halfW / PANEL_W) - 1;
  const iMax = Math.ceil(halfW / PANEL_W) + 1;
  const jMin = Math.floor(o.y0 / PANEL_H);
  const jMax = Math.ceil(o.y1 / PANEL_H);
  const panels: { x0: number; x1: number; y0: number; y1: number; no: number }[] = [];
  for (let j = jMin; j < jMax; j++) {
    for (let i = iMin; i < iMax; i++) {
      const x0 = Math.max(-halfW, i * PANEL_W);
      const x1 = Math.min(halfW, (i + 1) * PANEL_W);
      if (x1 - x0 < 0.02) continue;
      const y0 = j * PANEL_H;
      const y1 = Math.min(o.wallHeight, (j + 1) * PANEL_H);
      const prng = new Rng(hashString(`${o.seed}:${i}:${j}`));
      const no = (j * 10 + (i - iMin) + 1) % 100;
      panels.push({ x0, x1, y0, y1, no });
      const t = prng.range(0, 1);
      A.ctx.fillStyle = mixHex(WALL.panel, WALL.panelAlt, t * 0.8);
      A.ctx.fillRect(X(x0), Y(y1), M(x1 - x0), (y1 - y0) * ppmY);
    }
  }

  // ── 2. mottling + paint speckle ──
  fillPattern(A.ctx, valueNoiseTile(128, 4, o.seed & 0xff), W, H, M(1.6) / 128, 0.07, 'soft-light');
  fillPattern(A.ctx, valueNoiseTile(128, 8, (o.seed >> 3) & 0xff), W, H, M(0.6) / 128, 0.06, 'soft-light');
  fillPattern(A.ctx, whiteNoiseTile(128, 7, 60, 200), W, H, Math.max(1, ppmX / 300), 0.05, 'overlay');
  fillPattern(Hh.ctx, whiteNoiseTile(128, 11, 100, 160), W, H, Math.max(1, ppmX / 300), 0.5);
  fillPattern(R.ctx, valueNoiseTile(64, 4, 23), W, H, M(0.8) / 64, 0.18);

  // ── 3. plywood grain (runs along the long panel axis = vertical) ──
  for (const p of panels) {
    const prng = new Rng(hashString(`g${o.seed}:${p.x0}:${p.y0}`));
    const pw = p.x1 - p.x0;
    const lines = Math.round(pw * 34);
    for (let n = 0; n < lines; n++) {
      const gx = p.x0 + prng.range(0.01, pw - 0.01);
      const amp = prng.range(0.002, 0.012);
      const freq = prng.range(1.5, 5);
      const ph = prng.range(0, 6.28);
      const light = prng.chance(0.45);
      const a = prng.range(0.008, 0.022);
      const lw = prng.range(1, 2.6) * (ppmX / 400);
      const ys = Math.max(p.y0, o.y0 - 0.1);
      const ye = Math.min(p.y1, o.y1 + 0.1);
      for (const L of [A, Hh]) {
        L.ctx.beginPath();
        for (let y = ys; y <= ye; y += 0.08) {
          const xx = gx + Math.sin(y * freq + ph) * amp + Math.sin(y * freq * 3.1 + ph * 2) * amp * 0.3;
          if (y === ys) L.ctx.moveTo(X(xx), Y(y));
          else L.ctx.lineTo(X(xx), Y(y));
        }
        L.ctx.lineWidth = lw;
        if (L === A) L.ctx.strokeStyle = light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`;
        else L.ctx.strokeStyle = light ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
        L.ctx.stroke();
      }
    }
  }

  // ── 4. old chalk haze in the climbing band + traffic grime near the bottom ──
  {
    const g = A.ctx.createLinearGradient(0, Y(0.3), 0, Y(1.4));
    g.addColorStop(0, 'rgba(0,0,0,0.20)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    if (o.y0 < 1.4) {
      A.ctx.fillStyle = g;
      A.ctx.fillRect(0, Y(1.4), W, Y(0) - Y(1.4));
    }
    const hazeCount = Math.round(o.width * (o.y1 - o.y0) * 1.6);
    for (let n = 0; n < hazeCount; n++) {
      const x = rng.range(-halfW + 0.2, halfW - 0.2);
      const y = rng.range(Math.max(0.6, o.y0), Math.min(o.wallHeight - 0.2, o.y1));
      softBlob(A.ctx, X(x), Y(y), M(rng.range(0.12, 0.45)), PALETTE.chalk, rng.range(0.012, 0.04), rng.range(0.6, 1.4));
    }
  }

  // ── 5. tone-on-tone wordmark + logo mark (glossier paint: shows in roughness + height) ──
  drawWallBranding(o, { A, Hh, R }, X, Y, M);

  // ── 6. panel seams ──
  const seamW = Math.max(2, M(0.006));
  for (const L of [A, Hh, R]) {
    L.ctx.save();
    for (let i = iMin; i <= iMax; i++) {
      const sx = i * PANEL_W;
      if (sx <= -halfW + 0.01 || sx >= halfW - 0.01) continue;
      seamLine(L, X(sx), 0, X(sx), H, seamW, true);
    }
    for (let j = jMin; j <= jMax; j++) {
      const sy = j * PANEL_H;
      if (sy <= 0.01 || sy >= o.wallHeight - 0.01) continue;
      seamLine(L, 0, Y(sy), W, Y(sy), seamW, false);
    }
    L.ctx.restore();
  }

  // ── 7. spec labels, ruler, registration marks ──
  drawSpecDetails(o, panels, A, X, Y, M);

  // ── 8. T-nut grid (staggered rows) ──
  const rOuter = M(0.0085);
  const rInner = M(0.0048);
  for (let row = 0; ; row++) {
    const y = 0.1 + row * TNUT_STEP;
    if (y > o.wallHeight - 0.05) break;
    if (y < o.y0 - 0.02 || y > o.y1 + 0.02) continue;
    const off = row % 2 === 0 ? 0 : TNUT_STEP / 2;
    for (let x = -Math.floor(halfW / TNUT_STEP) * TNUT_STEP + off - TNUT_STEP; x < halfW; x += TNUT_STEP) {
      if (x < -halfW + 0.05 || x > halfW - 0.05) continue;
      const nearSeamX = Math.abs(x / PANEL_W - Math.round(x / PANEL_W)) * PANEL_W < 0.035;
      const nearSeamY = Math.abs(y / PANEL_H - Math.round(y / PANEL_H)) * PANEL_H < 0.035;
      if (nearSeamX || nearSeamY) continue;
      const px = X(x);
      const py = Y(y);
      // albedo: flange ring, barrel, dark bore
      A.ctx.fillStyle = 'rgba(70,74,80,0.55)';
      circle(A.ctx, px, py, rOuter);
      A.ctx.fillStyle = '#16171a';
      circle(A.ctx, px, py, rOuter * 0.82);
      A.ctx.fillStyle = '#060707';
      circle(A.ctx, px, py, rInner);
      A.ctx.fillStyle = 'rgba(255,255,255,0.10)';
      circle(A.ctx, px - rInner * 0.35, py - rInner * 0.35, rInner * 0.35);
      Hh.ctx.fillStyle = gray(0.38);
      circle(Hh.ctx, px, py, rOuter);
      Hh.ctx.fillStyle = gray(0.05);
      circle(Hh.ctx, px, py, rInner);
      R.ctx.fillStyle = gray(0.42);
      circle(R.ctx, px, py, rOuter);
    }
  }

  // ── 9. chalk + rubber around holds ──
  for (const hold of o.holds) {
    if (hold.y < o.y0 - 0.5 || hold.y > o.y1 + 0.5) continue;
    drawHoldWear(hold, A, R, X, Y, M);
  }

  // general scuffs (more near the bottom)
  const scuffs = Math.round(o.width * (o.y1 - o.y0) * 5);
  for (let n = 0; n < scuffs; n++) {
    const y = o.y0 + Math.pow(rng.next(), 1.6) * (o.y1 - o.y0);
    const yy = o.mode === 'boulder' ? 0.3 + Math.pow(rng.next(), 1.8) * (o.wallHeight - 0.5) : y;
    if (yy < o.y0 || yy > o.y1) continue;
    const x = rng.range(-halfW + 0.1, halfW - 0.1);
    scuffMark(A.ctx, X(x), Y(yy), M(rng.range(0.02, 0.07)), rng, rng.range(0.08, 0.22));
  }

  // ── 10. edge darkening (trim shadow) ──
  {
    const e = M(0.12);
    const gl = A.ctx.createLinearGradient(0, 0, e, 0);
    gl.addColorStop(0, 'rgba(0,0,0,0.35)');
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    A.ctx.fillStyle = gl;
    A.ctx.fillRect(0, 0, e, H);
    const gr = A.ctx.createLinearGradient(W, 0, W - e, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.35)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    A.ctx.fillStyle = gr;
    A.ctx.fillRect(W - e, 0, e, H);
    if (o.y1 >= o.wallHeight - 0.01) {
      const gt = A.ctx.createLinearGradient(0, 0, 0, e);
      gt.addColorStop(0, 'rgba(0,0,0,0.35)');
      gt.addColorStop(1, 'rgba(0,0,0,0)');
      A.ctx.fillStyle = gt;
      A.ctx.fillRect(0, 0, W, e);
    }
  }

  const aniso = o.anisotropy ?? 8;
  const map = canvasTexture(albedoC, { srgb: true, anisotropy: aniso });
  const normalMap = canvasTexture(heightToNormal(heightC, 2.2), { anisotropy: aniso });
  const roughnessMap = canvasTexture(roughC, { anisotropy: 2 });
  return {
    map,
    normalMap,
    roughnessMap,
    dispose() {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
  ctx.fill();
}

function softBlob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha: number,
  stretch = 1,
  rot = 0,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(stretch, 1);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.55, rgba(color, alpha * 0.45));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();
}

function seamLine(L: Layer, x0: number, y0: number, x1: number, y1: number, w: number, vertical: boolean): void {
  const ctx = L.ctx;
  const isAlbedo = L.k === 1;
  const isHeight = L.k === 0.5;
  // groove
  ctx.strokeStyle = isAlbedo ? WALL.seam : isHeight ? gray(0.12) : gray(0.9);
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  if (isAlbedo) {
    // chamfer catch-light on one side, shadow on the other
    const o = w * 0.9;
    ctx.lineWidth = Math.max(1, w * 0.35);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(x0 + o, y0);
      ctx.lineTo(x1 + o, y1);
    } else {
      ctx.moveTo(x0, y0 - o);
      ctx.lineTo(x1, y1 - o);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(x0 - o, y0);
      ctx.lineTo(x1 - o, y1);
    } else {
      ctx.moveTo(x0, y0 + o);
      ctx.lineTo(x1, y1 + o);
    }
    ctx.stroke();
  } else if (isHeight) {
    ctx.lineWidth = w * 2.4;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

function scuffMark(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, rng: Rng, alpha: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rng.range(-0.6, 0.6) + (rng.chance(0.5) ? 0 : Math.PI));
  ctx.lineCap = 'round';
  const strokes = rng.int(1, 3);
  for (let s = 0; s < strokes; s++) {
    ctx.strokeStyle = `rgba(4,4,5,${alpha * rng.range(0.6, 1)})`;
    ctx.lineWidth = Math.max(1, len * rng.range(0.08, 0.2));
    ctx.beginPath();
    const oy = rng.range(-len * 0.15, len * 0.15);
    ctx.moveTo(-len / 2, oy);
    ctx.quadraticCurveTo(0, oy + rng.range(-len * 0.25, len * 0.1), len / 2, oy + rng.range(-len * 0.1, len * 0.1));
    ctx.stroke();
  }
  ctx.restore();
}

function drawHoldWear(
  hold: HoldDef,
  A: Layer,
  R: Layer,
  X: (x: number) => number,
  Y: (y: number) => number,
  M: (m: number) => number,
): void {
  const rng = new Rng(hold.seed ^ 0xc4a1);
  const route = hold.role !== 'deco';
  const handy = hold.type !== 'foot' && hold.role !== 'foot';
  const s = hold.type === 'volume' ? Math.min(hold.size, 0.3) : hold.size;
  // Grip side: opposite to the body direction.
  const gx = -Math.cos(hold.angle);
  const gy = -Math.sin(hold.angle);
  if (handy) {
    const cx = hold.x + gx * s * 0.55;
    const cy = hold.y + gy * s * 0.55;
    const r = M(s * 1.7 + 0.05);
    const a = route ? rng.range(0.16, 0.26) : rng.range(0.05, 0.11);
    const rot = -Math.atan2(gy, gx) + Math.PI / 2;
    softBlob(A.ctx, X(cx), Y(cy), r, PALETTE.chalk, a, 1.5, rot);
    softBlob(R.ctx, X(cx), Y(cy), r, '#ffffff', 0.35, 1.5, rot);
    // finger drags radiating from the grip edge
    const drags = route ? rng.int(3, 7) : rng.int(0, 3);
    A.ctx.lineCap = 'round';
    for (let d = 0; d < drags; d++) {
      const spread = rng.range(-0.9, 0.9);
      const ang = Math.atan2(gy, gx) + spread;
      const start = s * rng.range(0.7, 1.0);
      const len = rng.range(0.02, 0.06);
      const ox = hold.x + Math.cos(ang) * start;
      const oy = hold.y + Math.sin(ang) * start;
      A.ctx.strokeStyle = rgba(PALETTE.chalk, a * rng.range(0.25, 0.5));
      A.ctx.lineWidth = Math.max(1, M(rng.range(0.008, 0.014)));
      A.ctx.beginPath();
      A.ctx.moveTo(X(ox), Y(oy));
      A.ctx.lineTo(X(ox + Math.cos(ang) * len), Y(oy + Math.sin(ang) * len));
      A.ctx.stroke();
    }
  }
  // rubber around footholds (and below low hand holds that double as feet)
  if (!handy || hold.y < 1.6) {
    const marks = route ? rng.int(4, 9) : rng.int(1, 4);
    for (let m = 0; m < marks; m++) {
      const ang = rng.range(Math.PI * 1.05, Math.PI * 1.95);
      const dist = s + rng.range(0.01, 0.08);
      scuffMark(A.ctx, X(hold.x + Math.cos(ang) * dist), Y(hold.y + Math.sin(ang) * dist), M(rng.range(0.02, 0.055)), rng, route ? 0.32 : 0.18);
    }
    R.ctx.fillStyle = 'rgba(80,80,80,0.25)';
    R.ctx.beginPath();
    R.ctx.arc(X(hold.x), Y(hold.y - s * 0.6), M(s + 0.04), 0, Math.PI * 2);
    R.ctx.fill();
  }
}

function drawWallBranding(
  o: WallTextureOpts,
  L: { A: Layer; Hh: Layer; R: Layer },
  X: (x: number) => number,
  Y: (y: number) => number,
  M: (m: number) => number,
): void {
  const tone = WALL.logoTone;
  const halfW = o.width / 2;

  type Mark = { kind: 'word' | 'logo' | 'vword'; x: number; y: number; size: number };
  const marks: Mark[] = [];
  if (o.mode === 'boulder') {
    // Wordmark across the upper wall, logo mark low on the right.
    const cap = Math.min(1.05, (o.width - 0.5) / 3.75);
    marks.push({ kind: 'word', x: 0, y: Math.min(o.wallHeight - 0.42, 3.95), size: cap });
    marks.push({ kind: 'logo', x: halfW - 1.62, y: 2.18, size: 1.42 });
  } else {
    // Rope tower: a giant vertical wordmark running up the right side, logo marks stacked.
    marks.push({ kind: 'vword', x: halfW - 0.32, y: 1.2, size: Math.min(1.1, o.width * 0.25) });
    marks.push({ kind: 'logo', x: -halfW + 0.35, y: 7.1, size: 1.5 });
    marks.push({ kind: 'word', x: -0.35, y: 13.2, size: 0.62 });
  }

  for (const mk of marks) {
    for (const layer of [L.A, L.Hh, L.R]) {
      const ctx = layer.ctx;
      const isA = layer === L.A;
      const isH = layer === L.Hh;
      ctx.save();
      ctx.strokeStyle = isA ? tone : isH ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.14)';
      ctx.fillStyle = ctx.strokeStyle;
      if (mk.kind === 'word') {
        drawStrokeText(ctx, BRAND.name, X(mk.x), Y(mk.y), M(mk.size), { weight: 1.45, tracking: 1.2, align: 'center' });
      } else if (mk.kind === 'vword') {
        ctx.translate(X(mk.x), Y(mk.y));
        ctx.rotate(-Math.PI / 2);
        drawStrokeText(ctx, BRAND.name, 0, -M(mk.size) / 2, M(mk.size), { weight: 1.45, tracking: 1.2 });
      } else {
        drawLogoMark(ctx, BRAND.logoPaths, X(mk.x), Y(mk.y), M(mk.size));
      }
      ctx.restore();
    }
  }
}

function drawSpecDetails(
  o: WallTextureOpts,
  panels: { x0: number; x1: number; y0: number; y1: number; no: number }[],
  A: Layer,
  X: (x: number) => number,
  Y: (y: number) => number,
  M: (m: number) => number,
): void {
  const ctx = A.ctx;
  const halfW = o.width / 2;
  const fontPx = Math.max(9, M(0.021));
  const angle = Math.round(o.angleDeg);
  const ink = 'rgba(233,229,221,0.34)';
  const inkDim = 'rgba(233,229,221,0.16)';
  ctx.save();
  ctx.font = `500 ${fontPx}px ${MONO}`;
  ctx.textBaseline = 'alphabetic';
  // per-panel labels + registration crosses
  for (const p of panels) {
    const label = `${BRAND.name} // PANEL ${String(p.no).padStart(2, '0')} // ${angle}°`;
    ctx.fillStyle = ink;
    ctx.fillText(label, X(p.x0) + M(0.035), Y(p.y0) - M(0.03));
    // registration cross at the panel's top-right
    const cx = X(p.x1) - M(0.05);
    const cy = Y(p.y1) + M(0.05);
    const cr = M(0.014);
    ctx.strokeStyle = inkDim;
    ctx.lineWidth = Math.max(1, M(0.0016));
    ctx.beginPath();
    ctx.moveTo(cx - cr, cy);
    ctx.lineTo(cx + cr, cy);
    ctx.moveTo(cx, cy - cr);
    ctx.lineTo(cx, cy + cr);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, cr * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  // height ruler along the left edge
  const rx = X(-halfW + 0.045);
  ctx.strokeStyle = 'rgba(233,229,221,0.22)';
  ctx.lineWidth = Math.max(1, M(0.0018));
  ctx.beginPath();
  ctx.moveTo(rx, Y(Math.max(0.3, o.y0)));
  ctx.lineTo(rx, Y(Math.min(o.wallHeight - 0.08, o.y1)));
  ctx.stroke();
  for (let i = 3; i * 0.1 <= o.wallHeight - 0.08; i++) {
    const y = i * 0.1;
    if (y < o.y0 - 0.01 || y > o.y1 + 0.01) continue;
    const major = i % 10 === 0;
    const half = i % 5 === 0;
    const len = major ? 0.034 : half ? 0.022 : 0.012;
    ctx.beginPath();
    ctx.moveTo(rx, Y(y));
    ctx.lineTo(rx + M(len), Y(y));
    ctx.stroke();
    if (major) {
      ctx.save();
      ctx.strokeStyle = ink;
      drawStrokeText(ctx, `${i / 10}M`, rx + M(0.045), Y(y) - M(0.012), M(0.024), { weight: 0.9, tracking: 1.4 });
      ctx.restore();
    }
  }

  // spec block bottom-left (boulder) or at each 5 m mark (rope)
  const blocks: number[] = o.mode === 'boulder' ? [0.62] : [0.62, 5.1, 10.1];
  for (const by of blocks) {
    if (by < o.y0 - 0.2 || by > o.y1 + 0.2) continue;
    const bx = X(-halfW + 0.16);
    const lineH = fontPx * 1.45;
    ctx.fillStyle = 'rgba(255,79,31,0.55)';
    ctx.fillRect(bx, Y(by) - lineH * 3.2, Math.max(2, M(0.004)), lineH * 3.1);
    ctx.fillStyle = ink;
    const wallNo = String(o.wallNo ?? 1).padStart(2, '0');
    ctx.fillText(`${BRAND.gym} — ${o.mode === 'rope' ? 'LEAD' : 'WALL'} ${wallNo}`, bx + M(0.016), Y(by) - lineH * 2.25);
    ctx.fillStyle = inkDim;
    ctx.fillText(`ANGLE ${angle >= 0 ? '+' : ''}${angle}°  //  ${o.width.toFixed(2)} × ${o.wallHeight.toFixed(2)} M`, bx + M(0.016), Y(by) - lineH * 1.25);
    ctx.fillText(`T-NUT ${TNUT_STEP * 1000} MM  //  M10`, bx + M(0.016), Y(by) - lineH * 0.25);
  }

  // inset hairline frame
  ctx.strokeStyle = 'rgba(233,229,221,0.07)';
  ctx.lineWidth = Math.max(1, M(0.0015));
  const inset = 0.025;
  ctx.strokeRect(X(-halfW + inset), Y(Math.min(o.wallHeight - inset, o.y1 + 1)), M(o.width - inset * 2), Y(Math.max(0.3, o.y0 - 1)) - Y(Math.min(o.wallHeight - inset, o.y1 + 1)));
  ctx.restore();
}

// ───────────────────────────── tileable plywood (neighbour walls) ─────────────────────────────

export interface TileSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  /** Meters covered by one texture repeat. */
  meters: number;
}

let plyCache: { size: number; set: TileSet } | null = null;

/** 2.44 × 2.44 m tile (two panels side by side), T-nuts on a 12-per-tile grid so it repeats cleanly. */
export function plywoodTile(size: number): TileSet {
  if (plyCache && plyCache.size === size) return plyCache.set;
  const meters = PANEL_H;
  const ppm = size / meters;
  const A = ctx2d(makeCanvas(size, size));
  const hC = makeCanvas(size / 2, size / 2);
  const Hh = ctx2d(hC);
  Hh.scale(0.5, 0.5);
  const rC = makeCanvas(size / 4, size / 4);
  const R = ctx2d(rC);
  R.scale(0.25, 0.25);
  const rng = new Rng(0x9e11);

  A.fillStyle = WALL.panel;
  A.fillRect(0, 0, size, size);
  A.fillStyle = WALL.panelAlt;
  A.fillRect(size / 2, 0, size / 2, size);
  Hh.fillStyle = gray(0.5);
  Hh.fillRect(0, 0, size, size);
  R.fillStyle = gray(0.82);
  R.fillRect(0, 0, size, size);
  fillPattern(A, valueNoiseTile(128, 4, 77), size, size, size / 2 / 128, 0.07, 'soft-light');
  fillPattern(A, whiteNoiseTile(128, 5, 60, 200), size, size, Math.max(1, ppm / 300), 0.05, 'overlay');
  fillPattern(Hh, whiteNoiseTile(128, 9, 100, 160), size, size, Math.max(1, ppm / 300), 0.5);

  // grain
  for (let p = 0; p < 2; p++) {
    for (let n = 0; n < 80; n++) {
      const gx = (p * 0.5 + rng.range(0.01, 0.49)) * size;
      const amp = rng.range(1, 5);
      const ph = rng.range(0, 6.28);
      const light = rng.chance(0.5);
      A.strokeStyle = light ? `rgba(255,255,255,${rng.range(0.012, 0.03)})` : `rgba(0,0,0,${rng.range(0.02, 0.045)})`;
      A.lineWidth = rng.range(1, 2.4);
      A.beginPath();
      for (let y = 0; y <= size; y += 24) {
        // period that divides the tile height → seamless vertically
        const xx = gx + Math.sin((y / size) * Math.PI * 2 * 3 + ph) * amp;
        if (y === 0) A.moveTo(xx, y);
        else A.lineTo(xx, y);
      }
      A.stroke();
    }
  }
  // old chalk
  for (let n = 0; n < 26; n++) {
    softBlob(A, rng.range(0.1, 0.9) * size, rng.range(0.1, 0.9) * size, rng.range(0.05, 0.2) * ppm, PALETTE.chalk, rng.range(0.015, 0.05));
  }
  for (let n = 0; n < 50; n++) {
    scuffMark(A, rng.range(0.05, 0.95) * size, rng.range(0.05, 0.95) * size, rng.range(0.02, 0.06) * ppm, rng, rng.range(0.08, 0.2));
  }
  // seams at the tile border and centre
  const seamW = Math.max(2, 0.006 * ppm);
  for (const L of [A, Hh, R]) {
    const isA = L === A;
    L.strokeStyle = isA ? WALL.seam : L === Hh ? gray(0.12) : gray(0.92);
    L.lineWidth = seamW;
    L.beginPath();
    for (const sx of [0, size / 2, size]) {
      L.moveTo(sx, 0);
      L.lineTo(sx, size);
    }
    for (const sy of [0, size]) {
      L.moveTo(0, sy);
      L.lineTo(size, sy);
    }
    L.stroke();
  }
  // T-nuts
  const step = size / 12;
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 12; col++) {
      const x = col * step + (row % 2 === 0 ? step / 2 : 0);
      const y = row * step + step / 2;
      if (Math.abs(x - size / 2) < 0.03 * ppm || x < 0.03 * ppm || x > size - 0.03 * ppm) continue;
      A.fillStyle = 'rgba(70,74,80,0.5)';
      circle(A, x, y, 0.0085 * ppm);
      A.fillStyle = '#060707';
      circle(A, x, y, 0.005 * ppm);
      Hh.fillStyle = gray(0.05);
      circle(Hh, x, y, 0.005 * ppm);
    }
  }
  const set: TileSet = {
    map: canvasTexture(A.canvas, { srgb: true, repeat: true, anisotropy: 4 }),
    normalMap: canvasTexture(heightToNormal(hC, 2, true), { repeat: true, anisotropy: 4 }),
    roughnessMap: canvasTexture(rC, { repeat: true }),
    meters,
  };
  plyCache = { size, set };
  return set;
}

// ───────────────────────────── crash pads ─────────────────────────────

let padCache: { top: TileSet; band: THREE.CanvasTexture } | null = null;

/** Pad top fabric (2 × 2 m tile) + the front band (orange stripe + CHIRAL print, 4 m per repeat). */
export function padTextures(): { top: TileSet; band: THREE.CanvasTexture } {
  if (padCache) return padCache;
  const size = 1024;
  const meters = 2;
  const ppm = size / meters;
  const A = ctx2d(makeCanvas(size, size));
  const hC = makeCanvas(512, 512);
  const Hh = ctx2d(hC);
  const rng = new Rng(0x7ad);
  A.fillStyle = WALL.mat;
  A.fillRect(0, 0, size, size);
  fillPattern(A, valueNoiseTile(128, 4, 31), size, size, size / 128, 0.16, 'soft-light');
  // cordura weave
  const weave = makeCanvas(8, 8);
  const wctx = ctx2d(weave);
  wctx.fillStyle = 'rgb(128,128,128)';
  wctx.fillRect(0, 0, 8, 8);
  wctx.fillStyle = 'rgb(165,165,165)';
  wctx.fillRect(0, 0, 4, 2);
  wctx.fillRect(4, 4, 4, 2);
  wctx.fillStyle = 'rgb(95,95,95)';
  wctx.fillRect(0, 2, 2, 2);
  wctx.fillRect(4, 6, 2, 2);
  fillPattern(A, weave, size, size, 1, 0.2, 'overlay');
  Hh.fillStyle = gray(0.5);
  Hh.fillRect(0, 0, 512, 512);
  fillPattern(Hh, weave, 512, 512, 0.5, 0.6);
  fillPattern(Hh, valueNoiseTile(64, 4, 12), 512, 512, 512 / 64, 0.35);
  // quilting: stitched channels every 0.5 m (dashed), with a soft crease shadow
  for (let k = 1; k < 4; k++) {
    const y = (k / 4) * size;
    A.fillStyle = 'rgba(0,0,0,0.22)';
    A.fillRect(0, y - 5, size, 10);
    A.strokeStyle = 'rgba(255,255,255,0.06)';
    A.lineWidth = 2;
    A.setLineDash([9, 7]);
    A.beginPath();
    A.moveTo(0, y - 9);
    A.lineTo(size, y - 9);
    A.moveTo(0, y + 9);
    A.lineTo(size, y + 9);
    A.stroke();
    A.setLineDash([]);
    Hh.fillStyle = 'rgba(0,0,0,0.5)';
    Hh.fillRect(0, y / 2 - 3, 512, 6);
  }
  // chalk dust: broad haze + concentrated traffic patches + shoe-print smudges
  for (let n = 0; n < 26; n++) {
    softBlob(A, rng.range(0, 1) * size, rng.range(0, 1) * size, rng.range(0.25, 0.6) * ppm, PALETTE.chalk, rng.range(0.02, 0.045), rng.range(0.8, 1.8), rng.range(0, 3));
  }
  for (let n = 0; n < 70; n++) {
    softBlob(A, rng.range(0, 1) * size, rng.range(0, 1) * size, rng.range(0.03, 0.09) * ppm, PALETTE.chalk, rng.range(0.04, 0.1), rng.range(1.4, 2.4), rng.range(0, 3));
  }
  for (let n = 0; n < 14; n++) softBlob(A, rng.range(0, 1) * size, rng.range(0, 1) * size, rng.range(0.1, 0.3) * ppm, '#000000', rng.range(0.05, 0.12));
  // roughness: matte cordura (≈0.9), slightly polished where feet scuff it
  const rC = makeCanvas(256, 256);
  const R = ctx2d(rC);
  R.fillStyle = gray(0.92);
  R.fillRect(0, 0, 256, 256);
  fillPattern(R, valueNoiseTile(64, 4, 13), 256, 256, 4, 0.25, 'multiply');
  const top: TileSet = {
    map: canvasTexture(A.canvas, { srgb: true, repeat: true, anisotropy: 8 }),
    normalMap: canvasTexture(heightToNormal(hC, 1.2, true), { repeat: true, anisotropy: 8 }),
    roughnessMap: canvasTexture(rC, { repeat: true }),
    meters,
  };

  // front band: 4 m × 0.3 m
  const bw = 2048;
  const bh = 160;
  const bppm = bw / 4;
  const B = ctx2d(makeCanvas(bw, bh));
  B.fillStyle = '#1a1c1f';
  B.fillRect(0, 0, bw, bh);
  fillPattern(B, weave, bw, bh, 1, 0.12, 'overlay');
  B.fillStyle = PALETTE.signal;
  B.fillRect(0, bh * 0.16, bw, bh * 0.16);
  B.fillStyle = 'rgba(0,0,0,0.25)';
  B.fillRect(0, bh * 0.32 - 2, bw, 2);
  for (let k = 0; k < 2; k++) {
    const ox = k * 2 * bppm;
    B.fillStyle = PALETTE.bone;
    drawLogoMark(B, BRAND.logoPaths, ox + 0.18 * bppm, bh * 0.43, bh * 0.4);
    B.strokeStyle = PALETTE.bone;
    drawStrokeText(B, BRAND.name, ox + 0.18 * bppm + bh * 0.52, bh * 0.47, bh * 0.32, { weight: 1.35, tracking: 1.3 });
    B.font = `500 ${Math.round(bh * 0.13)}px ${MONO}`;
    B.fillStyle = 'rgba(233,229,221,0.45)';
    B.fillText('IMPACT ZONE // 300 MM // CHIRAL HQ', ox + 0.95 * bppm, bh * 0.73);
    B.fillStyle = 'rgba(255,79,31,0.8)';
    B.fillRect(ox + 1.95 * bppm, bh * 0.45, 3, bh * 0.36);
  }
  const band = canvasTexture(B.canvas, { srgb: true, repeat: true, anisotropy: 8 });
  padCache = { top, band };
  return padCache;
}

// ───────────────────────────── concrete floor ─────────────────────────────

let concreteCache: TileSet | null = null;

/** Polished dark concrete, 4 × 4 m per repeat with a saw-cut joint at the border. */
export function concreteTile(): TileSet {
  if (concreteCache) return concreteCache;
  const size = 1024;
  const A = ctx2d(makeCanvas(size, size));
  const rC = makeCanvas(256, 256);
  const R = ctx2d(rC);
  const rng = new Rng(0xc0c);
  A.fillStyle = '#1a1b1e';
  A.fillRect(0, 0, size, size);
  fillPattern(A, valueNoiseTile(128, 3, 41, 4), size, size, size / 128, 0.1, 'soft-light');
  fillPattern(A, valueNoiseTile(128, 12, 42), size, size, size / 384, 0.08, 'soft-light');
  fillPattern(A, whiteNoiseTile(128, 43, 40, 220), size, size, 1, 0.06, 'overlay');
  for (let n = 0; n < 1400; n++) {
    A.fillStyle = rng.chance(0.5) ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.1)';
    circle(A, rng.range(0, size), rng.range(0, size), rng.range(0.5, 1.8));
  }
  for (let n = 0; n < 5; n++) softBlob(A, rng.range(0, size), rng.range(0, size), rng.range(60, 180), '#000000', rng.range(0.03, 0.07));
  // faint trowel arcs of a polished slab
  A.lineWidth = 1.5;
  for (let n = 0; n < 40; n++) {
    A.strokeStyle = `rgba(255,255,255,${rng.range(0.008, 0.02)})`;
    A.beginPath();
    A.arc(rng.range(0, size), rng.range(0, size), rng.range(80, 260), rng.range(0, 6.28), rng.range(0, 6.28) + rng.range(0.3, 0.9));
    A.stroke();
  }
  A.strokeStyle = 'rgba(0,0,0,0.65)';
  A.lineWidth = 4;
  A.strokeRect(0, 0, size, size);
  A.strokeStyle = 'rgba(255,255,255,0.05)';
  A.lineWidth = 1;
  A.strokeRect(3, 3, size - 6, size - 6);
  R.fillStyle = gray(0.72);
  R.fillRect(0, 0, 256, 256);
  fillPattern(R, valueNoiseTile(64, 4, 44), 256, 256, 4, 0.3);
  concreteCache = {
    map: canvasTexture(A.canvas, { srgb: true, repeat: true, anisotropy: 8 }),
    normalMap: canvasTexture(heightToNormal(whiteNoiseTile(128, 45, 90, 170), 0.5, true), { repeat: true }),
    roughnessMap: canvasTexture(rC, { repeat: true }),
    meters: 4,
  };
  return concreteCache;
}

// ───────────────────────────── hold speckle ─────────────────────────────

let speckleCache: THREE.CanvasTexture | null = null;

/** Tileable fine speckle normal map for textured polyurethane (UVs in meters × 25). */
export function speckleNormal(): THREE.CanvasTexture {
  if (speckleCache) return speckleCache;
  const size = 256;
  const h = makeCanvas(size, size);
  const ctx = ctx2d(h);
  ctx.drawImage(whiteNoiseTile(size, 0x5bec, 0, 255), 0, 0);
  // soften: blend in a slightly blurred copy (wrap-safe by drawing offsets)
  ctx.globalAlpha = 0.5;
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) ctx.drawImage(h, dx + ox, dy + oy);
  }
  ctx.globalAlpha = 1;
  fillPattern(ctx, valueNoiseTile(64, 4, 0x5bed), size, size, 4, 0.35);
  speckleCache = canvasTexture(heightToNormal(h, 1.6, true), { repeat: true, anisotropy: 4 });
  return speckleCache;
}

// ───────────────────────────── decal atlas ─────────────────────────────

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface DecalAtlas {
  texture: THREE.CanvasTexture;
  logo: AtlasRect;
  word: AtlasRect;
  solid: AtlasRect;
  blob: AtlasRect;
  ring: AtlasRect;
}

let atlasCache: DecalAtlas | null = null;

/** White-on-transparent decals: logo mark, CHIRAL wordmark, solid, soft blob, hairline ring. */
export function decalAtlas(): DecalAtlas {
  if (atlasCache) return atlasCache;
  const S = 1024;
  const ctx = ctx2d(makeCanvas(S, S));
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  // logo (0..512, 0..512)
  drawLogoMark(ctx, BRAND.logoPaths, 24, 24, 464);
  // wordmark (0..1024, 512..704)
  const cap = 150;
  const ww = measureStrokeText(BRAND.name, cap, { weight: 1.4, tracking: 1.2 });
  drawStrokeText(ctx, BRAND.name, (S - ww) / 2, 512 + 21, cap, { weight: 1.4, tracking: 1.2 });
  // solid (512..1024, 0..256)
  ctx.fillRect(516, 4, 504, 248);
  // blob (512..768, 256..512)
  const g = ctx.createRadialGradient(640, 384, 0, 640, 384, 126);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(514, 258, 252, 252);
  // ring (768..1024, 256..512)
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(896, 384, 110, 0, Math.PI * 2);
  ctx.stroke();
  const r = (x0: number, y0: number, x1: number, y1: number): AtlasRect => ({ u0: x0 / S, v0: 1 - y1 / S, u1: x1 / S, v1: 1 - y0 / S });
  atlasCache = {
    texture: canvasTexture(ctx.canvas, { srgb: true, anisotropy: 4 }),
    logo: r(0, 0, 512, 512),
    word: r(0, 512, 1024, 704),
    solid: r(520, 8, 1016, 248),
    blob: r(512, 256, 768, 512),
    ring: r(768, 256, 1024, 512),
  };
  return atlasCache;
}

let blobCache: THREE.CanvasTexture | null = null;

/** Soft radial falloff (white → transparent), for contact shadows and AO decals. */
export function softBlobTexture(): THREE.CanvasTexture {
  if (blobCache) return blobCache;
  const S = 128;
  const ctx = ctx2d(makeCanvas(S, S));
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  blobCache = canvasTexture(ctx.canvas, { srgb: false, anisotropy: 1 });
  return blobCache;
}

// ───────────────────────────── route tape labels ─────────────────────────────

export interface LabelAtlas {
  texture: THREE.CanvasTexture;
  start: AtlasRect;
  top: AtlasRect;
  card: AtlasRect;
  /** Physical aspect (w/h) of each slot. */
  aspect: { start: number; top: number; card: number };
}

/** START / TOP tape strips in the route colour plus a route card (grade + name). */
export function createLabelAtlas(color: string, gradeText: string, name: string, seed: number): LabelAtlas {
  const S = 512;
  const ctx = ctx2d(makeCanvas(S, S));
  const rng = new Rng(seed ^ 0x7a9e);
  ctx.clearRect(0, 0, S, S);
  const dark = luminance(color) > 0.55;
  const ink = dark ? '#121316' : '#F6F4EF';

  const tape = (y0: number, h: number, text: string): void => {
    const x0 = 8;
    const x1 = S - 8;
    ctx.save();
    ctx.beginPath();
    // torn ends
    ctx.moveTo(x0 + 6, y0);
    ctx.lineTo(x1 - 6, y0);
    for (let k = 0; k <= 6; k++) ctx.lineTo(x1 - (k % 2 === 0 ? 0 : rng.range(5, 12)), y0 + (h * k) / 6);
    ctx.lineTo(x0 + 6, y0 + h);
    for (let k = 6; k >= 0; k--) ctx.lineTo(x0 + (k % 2 === 0 ? 0 : rng.range(5, 12)), y0 + (h * k) / 6);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.clip();
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    g.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, h);
    fillPattern(ctx, whiteNoiseTile(64, 99, 90, 170), S, S, 1, 0.08, 'overlay');
    ctx.strokeStyle = ink;
    const cap = h * 0.5;
    drawStrokeText(ctx, text, S / 2, y0 + (h - cap) / 2, cap, { weight: 1.3, tracking: 2.2, align: 'center' });
    // small chevrons either side
    ctx.lineWidth = cap * 0.16;
    ctx.beginPath();
    ctx.moveTo(40, y0 + h * 0.3);
    ctx.lineTo(56, y0 + h * 0.5);
    ctx.lineTo(40, y0 + h * 0.7);
    ctx.moveTo(S - 40, y0 + h * 0.3);
    ctx.lineTo(S - 56, y0 + h * 0.5);
    ctx.lineTo(S - 40, y0 + h * 0.7);
    ctx.stroke();
    ctx.restore();
  };
  tape(6, 132, 'START');
  tape(150, 132, 'TOP');

  // route card (bone card, signal band, grade + name)
  const cy0 = 296;
  const ch = 208;
  ctx.save();
  ctx.fillStyle = PALETTE.bone;
  ctx.fillRect(10, cy0, S - 20, ch);
  ctx.fillStyle = color;
  ctx.fillRect(10, cy0, 34, ch);
  ctx.fillStyle = PALETTE.signal;
  ctx.fillRect(44, cy0, S - 54, 10);
  ctx.strokeStyle = '#121316';
  drawStrokeText(ctx, gradeText, 64, cy0 + 34, 92, { weight: 1.4, tracking: 1.4 });
  const nm = name.toUpperCase().slice(0, 18);
  const nameCap = Math.min(34, (S - 84) / Math.max(1, measureStrokeText(nm, 10, { tracking: 1.6 }) / 10));
  drawStrokeText(ctx, nm, 64, cy0 + 142, nameCap, { weight: 1.1, tracking: 1.6 });
  ctx.fillStyle = '#121316';
  drawLogoMark(ctx, BRAND.logoPaths, S - 104, cy0 + 34, 76);
  ctx.font = `600 18px ${MONO}`;
  ctx.fillStyle = 'rgba(18,19,22,0.6)';
  ctx.fillText(`${BRAND.name} HQ // SET ${String((seed % 89) + 10)}`, 64, cy0 + 196);
  ctx.restore();

  const r = (x0: number, y0: number, x1: number, y1: number): AtlasRect => ({ u0: x0 / S, v0: 1 - y1 / S, u1: x1 / S, v1: 1 - y0 / S });
  return {
    texture: canvasTexture(ctx.canvas, { srgb: true, anisotropy: 8 }),
    start: r(0, 0, S, 144),
    top: r(0, 144, S, 288),
    card: r(0, 290, S, 512),
    aspect: { start: S / 144, top: S / 144, card: S / 222 },
  };
}

// ───────────────────────────── signage, windows, shafts, banners ─────────────────────────────

/** Backlit CHIRAL sign (logo mark + wordmark + HQ), white on transparent, used as an emissive map. */
export function signTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 512;
  const ctx = ctx2d(makeCanvas(W, H));
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  drawLogoMark(ctx, BRAND.logoPaths, 40, 56, 400);
  drawStrokeText(ctx, BRAND.name, 500, 120, 270, { weight: 1.35, tracking: 1.3 });
  ctx.globalAlpha = 0.75;
  const hqX = 500 + measureStrokeText(BRAND.name, 270, { weight: 1.35, tracking: 1.3 }) + 60;
  drawStrokeText(ctx, 'HQ', hqX, 250, 140, { weight: 1.1, tracking: 1.6 });
  return canvasTexture(ctx.canvas, { srgb: true, anisotropy: 4 });
}

/** Tall window with mullions: cool daylight gradient. */
export function windowTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 512;
  const ctx = ctx2d(makeCanvas(W, H));
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#dff3f7');
  g.addColorStop(0.55, '#9ccfdb');
  g.addColorStop(1, '#6b9fb0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.moveTo(0, H * 0.15);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H * 0.2);
  ctx.lineTo(0, H * 0.45);
  ctx.fill();
  ctx.fillStyle = '#0c0d0f';
  const bar = 10;
  ctx.fillRect(0, 0, W, bar);
  ctx.fillRect(0, H - bar, W, bar);
  ctx.fillRect(0, 0, bar, H);
  ctx.fillRect(W - bar, 0, bar, H);
  ctx.fillRect(W / 2 - bar / 2, 0, bar, H);
  for (let k = 1; k < 4; k++) ctx.fillRect(0, (H * k) / 4 - bar / 2, W, bar);
  return canvasTexture(ctx.canvas, { srgb: true });
}

/** Light shaft: fades along its length (v) and softly across (u). */
export function shaftTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const ctx = ctx2d(makeCanvas(W, H));
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const along = Math.pow(1 - y / H, 1.6);
    for (let x = 0; x < W; x++) {
      const u = (x / (W - 1)) * 2 - 1;
      const across = Math.exp(-u * u * 3.2) * (0.85 + 0.15 * Math.sin(x * 0.45));
      const v = clamp(along * across, 0, 1) * 255;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(ctx.canvas, { srgb: false, mipmaps: true });
}

/** Hanging fabric banner: signal orange, bone logo mark, vertical wordmark. */
export function bannerTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 1024;
  const ctx = ctx2d(makeCanvas(W, H));
  ctx.fillStyle = PALETTE.signal;
  ctx.fillRect(0, 0, W, H);
  fillPattern(ctx, valueNoiseTile(64, 4, 0xba), W, H, 4, 0.12, 'soft-light');
  ctx.fillStyle = PALETTE.bone;
  drawLogoMark(ctx, BRAND.logoPaths, W * 0.2, 60, W * 0.6);
  ctx.save();
  ctx.translate(W * 0.5, 300);
  ctx.rotate(Math.PI / 2);
  ctx.strokeStyle = PALETTE.bone;
  drawStrokeText(ctx, BRAND.name, 0, -60, 120, { weight: 1.4, tracking: 1.3 });
  ctx.restore();
  ctx.fillStyle = 'rgba(13,14,16,0.85)';
  ctx.font = `600 18px ${MONO}`;
  ctx.fillText(BRAND.tagline.slice(0, 22), 20, H - 60);
  ctx.fillRect(20, H - 44, W - 40, 3);
  // fabric sag shading
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.22)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return canvasTexture(ctx.canvas, { srgb: true });
}

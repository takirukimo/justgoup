// A tiny geometric stroke font for in-world lettering (wall wordmark, tape labels, signage,
// rulers). Font-independent, so textures look identical online and offline.
//
// Glyphs live on a grid 10 units tall (y down). Strokes are centre-lines for a 2-unit stroke:
// outer edges land on 0 and 10 vertically. Chamfered corners give the "technical" feel.
//
// Brand artwork (the CHIRAL mark, the CHIRAL SPORTS wordmark and their lockup) is never set in
// this font: drawMark / drawWordmark / drawLockup render the official outlined paths.

import { BRAND } from '../config/brand';

type Poly = { pts: number[]; closed?: boolean };
interface Glyph {
  w: number;
  polys: Poly[];
}

const c = 1.4; // chamfer
const P = (pts: number[], closed = false): Poly => ({ pts, closed });

const O_SHAPE = P([1 + c, 1, 5 - c, 1, 5, 1 + c, 5, 9 - c, 5 - c, 9, 1 + c, 9, 1, 9 - c, 1, 1 + c], true);

const GLYPHS: Record<string, Glyph> = {
  A: { w: 6, polys: [P([1, 10, 1, 1 + c, 1 + c, 1, 5 - c, 1, 5, 1 + c, 5, 10]), P([1, 6, 5, 6])] },
  B: { w: 6, polys: [P([1, 9, 1, 1, 4, 1, 5, 2, 5, 4, 4, 5, 1, 5]), P([4, 5, 5, 6, 5, 8, 4, 9, 0.4, 9])] },
  C: { w: 6, polys: [P([6, 1, 1 + c, 1, 1, 1 + c, 1, 9 - c, 1 + c, 9, 6, 9])] },
  D: { w: 6, polys: [P([1, 1, 1, 9, 5 - c, 9, 5, 9 - c, 5, 1 + c, 5 - c, 1], true)] },
  E: { w: 6, polys: [P([6, 1, 1, 1, 1, 9, 6, 9]), P([1, 5, 4.6, 5])] },
  F: { w: 6, polys: [P([6, 1, 1, 1, 1, 10]), P([1, 5, 4.6, 5])] },
  G: { w: 6, polys: [P([6, 1, 1 + c, 1, 1, 1 + c, 1, 9 - c, 1 + c, 9, 5, 9, 5, 5.4, 3.2, 5.4])] },
  H: { w: 6, polys: [P([1, 0, 1, 10]), P([5, 0, 5, 10]), P([1, 5, 5, 5])] },
  I: { w: 2, polys: [P([1, 0, 1, 10])] },
  J: { w: 6, polys: [P([5, 0, 5, 9 - c, 5 - c, 9, 0, 9])] },
  K: { w: 6, polys: [P([1, 0, 1, 10]), P([1, 5.2, 2.6, 5.2]), P([5.6, 0, 2.6, 5.2, 5.6, 10])] },
  L: { w: 6, polys: [P([1, 0, 1, 9, 6, 9])] },
  M: { w: 7, polys: [P([1, 10, 1, 1, 3.5, 5.4, 6, 1, 6, 10])] },
  N: { w: 6, polys: [P([1, 10, 1, 1, 5, 9, 5, 0])] },
  O: { w: 6, polys: [O_SHAPE] },
  P: { w: 6, polys: [P([1, 10, 1, 1, 4, 1, 5, 2, 5, 4.6, 4, 5.6, 1, 5.6])] },
  Q: { w: 6, polys: [O_SHAPE, P([3.4, 7, 5.8, 10])] },
  R: { w: 6, polys: [P([1, 10, 1, 1, 4, 1, 5, 2, 5, 4.4, 4, 5.4, 1, 5.4]), P([3.2, 5.4, 5.3, 10])] },
  S: { w: 6, polys: [P([6, 1, 1 + c, 1, 1, 1 + c, 1, 4, 2, 5, 4, 5, 5, 6, 5, 9 - c, 5 - c, 9, 0, 9])] },
  T: { w: 6, polys: [P([0, 1, 6, 1]), P([3, 1, 3, 10])] },
  U: { w: 6, polys: [P([1, 0, 1, 9 - c, 1 + c, 9, 5 - c, 9, 5, 9 - c, 5, 0])] },
  V: { w: 6, polys: [P([0.8, 0, 3, 9.3, 5.2, 0])] },
  W: { w: 8, polys: [P([0.8, 0, 2.2, 9.3, 4, 3.4, 5.8, 9.3, 7.2, 0])] },
  X: { w: 6, polys: [P([0.9, 0, 5.1, 10]), P([5.1, 0, 0.9, 10])] },
  Y: { w: 6, polys: [P([0.8, 0, 3, 5, 5.2, 0]), P([3, 5, 3, 10])] },
  Z: { w: 6, polys: [P([0, 1, 5, 1, 1, 9, 6, 9])] },
  '0': { w: 6, polys: [O_SHAPE] },
  '1': { w: 4, polys: [P([0.2, 2.8, 3, 1.1, 3, 10])] },
  '2': { w: 6, polys: [P([0, 1, 4, 1, 5, 2, 5, 4, 4, 5, 2, 5, 1, 6, 1, 9, 6, 9])] },
  '3': { w: 6, polys: [P([0, 1, 4, 1, 5, 2, 5, 4, 4, 5, 2, 5]), P([4, 5, 5, 6, 5, 8, 4, 9, 0, 9])] },
  '4': { w: 6, polys: [P([1, 0, 1, 6.6, 6, 6.6]), P([4.4, 3.4, 4.4, 10])] },
  '5': { w: 6, polys: [P([6, 1, 1, 1, 1, 5, 4, 5, 5, 6, 5, 8, 4, 9, 0, 9])] },
  '6': { w: 6, polys: [P([5.6, 1, 1 + c, 1, 1, 1 + c, 1, 9 - c, 1 + c, 9, 4, 9, 5, 8, 5, 6, 4, 5, 1, 5])] },
  '7': { w: 6, polys: [P([0, 1, 5, 1, 5, 2.6, 2.4, 10])] },
  '8': {
    w: 6,
    polys: [
      P([1.8, 1, 4.2, 1, 5, 1.8, 5, 4.2, 4.2, 5, 1.8, 5, 1, 4.2, 1, 1.8], true),
      P([1.8, 5, 4.2, 5, 5, 5.8, 5, 8.2, 4.2, 9, 1.8, 9, 1, 8.2, 1, 5.8], true),
    ],
  },
  '9': { w: 6, polys: [P([0.4, 9, 5 - c, 9, 5, 9 - c, 5, 1 + c, 5 - c, 1, 2, 1, 1, 2, 1, 4, 2, 5, 5, 5])] },
  '/': { w: 4, polys: [P([0.4, 10, 3.6, 0])] },
  '-': { w: 4, polys: [P([0.4, 5, 3.6, 5])] },
  '+': { w: 6, polys: [P([0.6, 5, 5.4, 5]), P([3, 2.6, 3, 7.4])] },
  '.': { w: 2, polys: [P([1, 8.4, 1, 10])] },
  ',': { w: 2, polys: [P([1, 8.4, 1, 10, 0.4, 11.2])] },
  ':': { w: 2, polys: [P([1, 2.4, 1, 4]), P([1, 8.4, 1, 10])] },
  "'": { w: 2, polys: [P([1, 0, 1, 3])] },
  '!': { w: 2, polys: [P([1, 0, 1, 6.6]), P([1, 8.4, 1, 10])] },
  '?': { w: 6, polys: [P([0.4, 1, 4, 1, 5, 2, 5, 4, 4, 5, 3, 5, 3, 6.8]), P([3, 8.4, 3, 10])] },
  '°': { w: 4, polys: [P([1, 1, 3, 1, 3, 3, 1, 3], true)] },
  '#': { w: 7, polys: [P([2.4, 0.6, 1.6, 9.4]), P([5.4, 0.6, 4.6, 9.4]), P([0.4, 3.4, 6.6, 3.4]), P([0.4, 6.6, 6.6, 6.6])] },
  '&': { w: 6, polys: [P([6, 10, 1.6, 4.2, 1.6, 2, 2.6, 1, 3.6, 1, 4.4, 2, 4.4, 3.4, 1, 6.4, 1, 8.4, 1.8, 9, 3.6, 9, 5.6, 6.6])] },
  ' ': { w: 3, polys: [] },
};

export interface StrokeTextOpts {
  /** Stroke weight multiplier (1 = regular, 1.25 = bold, 0.75 = light). */
  weight?: number;
  /** Extra spacing between glyphs, in grid units (default 1.6). */
  tracking?: number;
  align?: 'left' | 'center' | 'right';
}

function glyphFor(ch: string): Glyph {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS[' '];
}

/** Width in pixels of `text` drawn with cap height `cap`. */
export function measureStrokeText(text: string, cap: number, opts: StrokeTextOpts = {}): number {
  const tracking = opts.tracking ?? 1.6;
  const s = cap / 10;
  let w = 0;
  const up = text.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    w += glyphFor(up[i]).w + (i < up.length - 1 ? tracking : 0);
  }
  return w * s;
}

/**
 * Draws upper-case `text` with its cap line at `y` (top) — uses the context's current strokeStyle.
 * Returns the drawn width in pixels.
 */
export function drawStrokeText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  cap: number,
  opts: StrokeTextOpts = {},
): number {
  const tracking = opts.tracking ?? 1.6;
  const weight = opts.weight ?? 1;
  const s = cap / 10;
  const total = measureStrokeText(text, cap, opts);
  let ox = x;
  if (opts.align === 'center') ox -= total / 2;
  else if (opts.align === 'right') ox -= total;

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 3;
  ctx.lineWidth = 2 * weight * s;
  const up = text.toUpperCase();
  let cx = ox;
  for (let i = 0; i < up.length; i++) {
    const g = glyphFor(up[i]);
    ctx.beginPath();
    for (const poly of g.polys) {
      const p = poly.pts;
      ctx.moveTo(cx + p[0] * s, y + p[1] * s);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(cx + p[k] * s, y + p[k + 1] * s);
      if (poly.closed) ctx.closePath();
    }
    ctx.stroke();
    cx += (g.w + tracking) * s;
  }
  ctx.restore();
  return total;
}

/** Draws the CHIRAL logo mark (BRAND.logoPaths, 64×64 box) filled with the current fillStyle. */
export function drawLogoMark(ctx: CanvasRenderingContext2D, paths: readonly string[], x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 64, size / 64);
  for (const d of paths) ctx.fill(new Path2D(d));
  ctx.restore();
}

// ───────────────────────────── official CHIRAL SPORTS artwork ─────────────────────────────
// The outlined paths from assets/brand (BRAND.markPaths / wordmarkPaths) drawn with their real
// viewBoxes, so the proportions are exactly the official ones. Everything fills with the
// context's current fillStyle. Path2D objects are built once and reused.

const pathCache = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

const MARK_W = BRAND.markViewBox[0];
const MARK_H = BRAND.markViewBox[1];
const WORD_W = BRAND.wordmarkViewBox[0];
const WORD_H = BRAND.wordmarkViewBox[1];
/** Official lockup geometry (assets/brand/chiral-lockup-livetext.svg): wordmark starts at x = 165.74. */
const LOCKUP_WORD_X = 165.74;
const LOCKUP_MARK_Y = 5.86;
const LOCKUP_W = LOCKUP_WORD_X + WORD_W;
const LOCKUP_H = WORD_H;

/** Width / height of the official mark, wordmark and horizontal lockup. */
export const BRAND_ASPECT = {
  mark: MARK_W / MARK_H,
  word: WORD_W / WORD_H,
  lockup: LOCKUP_W / LOCKUP_H,
} as const;

function fillPaths(ctx: CanvasRenderingContext2D, paths: readonly string[]): void {
  for (const d of paths) ctx.fill(path2d(d));
}

/** The official CHIRAL mark (two swooshes), top-left at (x, y), `width` px wide (height = width / 1.913). */
export function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, width: number): void {
  const s = width / MARK_W;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  fillPaths(ctx, BRAND.markPaths);
  ctx.restore();
}

/** The official mark centred in a square box (decal atlases that assume a square logo slot). */
export function drawMarkInBox(ctx: CanvasRenderingContext2D, x: number, y: number, box: number): void {
  const w = box;
  const h = w / BRAND_ASPECT.mark;
  drawMark(ctx, x, y + (box - h) / 2, w);
}

/** The official CHIRAL SPORTS wordmark, top-left at (x, y), `height` px tall (cap height ≈ height). */
export function drawWordmark(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, align: 'left' | 'center' | 'right' = 'left'): number {
  const s = height / WORD_H;
  const w = WORD_W * s;
  const ox = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.save();
  ctx.translate(ox, y);
  ctx.scale(s, s);
  fillPaths(ctx, BRAND.wordmarkPaths);
  ctx.restore();
  return w;
}

/**
 * Mark + wordmark lockup with the official spacing, top-left at (x, y), `height` px tall (the
 * wordmark's height; the mark sits on the baseline). Returns the drawn width.
 */
export function drawLockup(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, align: 'left' | 'center' | 'right' = 'left'): number {
  const s = height / LOCKUP_H;
  const w = LOCKUP_W * s;
  const ox = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.save();
  ctx.translate(ox, y);
  ctx.scale(s, s);
  ctx.save();
  ctx.translate(0, LOCKUP_MARK_Y);
  fillPaths(ctx, BRAND.markPaths);
  ctx.restore();
  ctx.translate(LOCKUP_WORD_X, 0);
  fillPaths(ctx, BRAND.wordmarkPaths);
  ctx.restore();
  return w;
}

/**
 * The wordmark set vertically like the back print of the CHIRAL SPORTS tee: letters rotated 90°
 * clockwise, reading top to bottom. (x, y) is the top of the column's left edge; `height` is the
 * letter height (= column width). Returns the column length.
 */
export function drawWordmarkVertical(ctx: CanvasRenderingContext2D, x: number, y: number, height: number): number {
  const len = WORD_W * (height / WORD_H);
  ctx.save();
  ctx.translate(x + height, y);
  ctx.rotate(Math.PI / 2);
  drawWordmark(ctx, 0, 0, height);
  ctx.restore();
  return len;
}

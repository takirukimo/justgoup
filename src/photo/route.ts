// Photo holds → a BoulderDef on the game's wall (research §5.1 steps 6–7). Positions keep the photo's
// proportions (one scale for x and y: the wall's corners in the photo span the wall's surface length),
// the route is centred (and squeezed only if it is wider than the 4.6 m wall), sizes come from the
// blob's real size, types are guessed from its shape, and start / top from tape and height.

import type { BoulderDef, HoldDef, HoldShape, HoldType } from '../core/types';
import { ROUTE_COLORS } from '../config/brand';
import { GAME } from '../config/tuning';
import { extentOf, sizeRange } from '../editor/catalog';
import { capsuleGap, clampToBounds, holdBounds } from '../editor/model';
import { cleanWall, presetById, presetWall, setWall, WALL_PRESETS, type WallPreset } from '../editor/walls';
import { hexToLab } from './color';
import type { Lab, PhotoHold } from './types';

export const ROUTE = {
  wallWidth: GAME.boulderWall.width,
  /** Side margin kept free when the route is fitted onto the wall (m). */
  margin: 0.12,
  /** Start holds sit at least this high unless nothing else can start (m). */
  startMinY: 0.75,
  /** A second start: about level with the first, a hand-width or more apart. */
  pairDy: 0.35,
  pairDxMin: 0.12,
  pairDxMax: 0.9,
  /** Tape this close (m) to a hold marks it as a start. */
  tapeReach: 0.35,
  /**
   * The game draws holds about twice their real size (readable on a phone), so a photo hold's real
   * length is scaled by this before it becomes a HoldDef size.
   */
  gameScale: 1.8,
  /** Default wall (research: most gym boulder walls lean out a little). */
  defaultPreset: 'gentle',
} as const;

/** What the importer guesses a hold is. */
export interface HoldGuess {
  type: HoldType;
  shape?: HoldShape;
  fingers?: 1 | 2 | 3 | 4;
  /** Characteristic radius (HoldDef.size, m). */
  size: number;
  /** HoldDef.angle: from the hold toward the climber's body. */
  angle: number;
}

/** A photo hold placed on the wall (metres), before the BoulderDef is assembled. */
export interface PlacedHold {
  x: number;
  y: number;
  guess: HoldGuess;
  /** Longest dimension on the wall (m). */
  lengthM: number;
}

/**
 * Guess type, product shape and size from a blob's real dimensions (research §5.1 step 6). Sloper vs jug
 * is undecidable in 2D, so a round mid-size blob is a jug only while it is jug-sized; bigger round ones
 * read as slopers (the conservative capacity).
 * `lengthM` / `widthM`: longest and cross dimension; `thetaWall`: major axis direction in wall
 * coordinates (y up); `towardX`: +1 / −1, the side the route's line is on (for sidepulls).
 */
export function guessHold(o: { lengthM: number; widthM: number; thetaWall: number; pocket: boolean; kind: PhotoHold['kind']; towardX: number }): HoldGuess {
  const L = Math.max(0.01, o.lengthM);
  const aspect = L / Math.max(0.005, o.widthM);
  let type: HoldType;
  let shape: HoldShape | undefined;
  let fingers: HoldGuess['fingers'];
  if (o.kind === 'volume') type = 'volume';
  else if (L < 0.05) {
    type = 'foot';
    if (L < 0.036) shape = 'chip';
  } else if (o.pocket && L < 0.2) {
    type = 'pocket';
    fingers = L < 0.07 ? 2 : 3;
  } else if (L < 0.1) {
    if (aspect > 2.6) {
      type = 'crimp';
      if (o.widthM < 0.022) shape = 'micro';
    } else if (aspect > 1.6) type = 'edge';
    else type = 'crimp';
  } else if (L < 0.25) {
    const vertical = Math.abs(Math.cos(o.thetaWall)) < 0.5;
    if (aspect > 3) {
      type = 'edge';
      if (L >= 0.16) shape = 'rail';
    } else if (aspect > 1.9 && vertical) type = 'pinch';
    else if (aspect > 1.9) type = 'edge';
    else if (L < 0.17) type = 'jug';
    else if (aspect < 1.35) type = 'sloper';
    else {
      type = 'jug';
      if (L >= 0.2) shape = 'bucket';
    }
  } else if (L < 0.5) {
    type = 'sloper';
    shape = 'macro';
  } else type = 'volume';

  // size: the in-game hold's longest extent follows the photo's (at the game's drawing scale)
  const size = sizeFor(type, shape, L, fingers);

  // pull: square to the long axis, toward the body below; a vertical edge is a sidepull toward the line
  let angle = -Math.PI / 2;
  if (aspect >= 1.6 && type !== 'pinch' && type !== 'foot' && type !== 'volume') {
    let nx = -Math.sin(o.thetaWall);
    let ny = Math.cos(o.thetaWall);
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    if (Math.abs(ny) < 0.3 && Math.sign(nx) !== Math.sign(o.towardX) && o.towardX !== 0) {
      nx = -nx;
      ny = -ny;
    }
    angle = Math.atan2(ny, nx);
  }
  const g: HoldGuess = { type, size, angle };
  if (shape) g.shape = shape;
  if (fingers) g.fingers = fingers;
  return g;
}

/** HoldDef.size whose in-game longest extent is the photo length at the game's drawing scale. */
export function sizeFor(type: HoldType, shape: HoldShape | undefined, lengthM: number, fingers?: HoldGuess['fingers']): number {
  const e = extentOf({ type, shape, seed: 0, fingers });
  const range = sizeRange({ type, shape });
  const scale = type === 'volume' ? 1 : ROUTE.gameScale;
  return Math.max(range.min, Math.min(range.max, (lengthM * scale) / 2 / Math.max(e.hx, e.hy)));
}

/** The wall a preset builds (cleaned: it stands under the gym's ceiling). */
export function wallFor(presetId: string): { preset: WallPreset; panels: { y0: number; angle: number }[]; length: number } {
  const preset = presetById(presetId) ?? presetById(ROUTE.defaultPreset) ?? WALL_PRESETS[0];
  const w = cleanWall(presetWall(preset));
  return { preset, panels: w.panels, length: w.length };
}

/**
 * Place photo holds on the wall: rectified px → metres with one scale (the rectified image's height is
 * the wall's surface length), the route centred on the wall, squeezed sideways only when wider than it.
 */
export function placeHolds(holds: readonly PhotoHold[], rectW: number, rectH: number, length: number): PlacedHold[] {
  const mpp = length / rectH;
  const raw = holds.map((h) => {
    const x = (h.x - rectW / 2) * mpp;
    const y = length - h.y * mpp;
    return { h, x, y };
  });
  const W = ROUTE.wallWidth;
  const half = W / 2 - ROUTE.margin;
  // fit: centre the route when it pokes past the side, squeeze when it is wider than the wall
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const r of raw) {
    const ext = ((r.h.sizeM ?? r.h.major * mpp) / 2) * 0.8;
    x0 = Math.min(x0, r.x - ext);
    x1 = Math.max(x1, r.x + ext);
  }
  let shift = 0;
  let squeeze = 1;
  if (raw.length && (x0 < -half || x1 > half)) {
    shift = -(x0 + x1) / 2;
    const span = x1 - x0;
    if (span > half * 2) squeeze = (half * 2) / span;
  }
  const lineX = raw.length ? raw.reduce((s, r) => s + r.x, 0) / raw.length : 0;
  return raw.map(({ h, x, y }) => {
    const lengthM = h.sizeM ?? h.major * mpp;
    const widthM = Math.min(lengthM, h.minor * mpp);
    const thetaWall = -h.theta;
    const guess = guessHold({ lengthM, widthM, thetaWall, pocket: h.pocket, kind: h.kind, towardX: Math.sign(lineX - x) });
    if (h.type) {
      // Claude (or the user) named the type: keep the size guess for that type
      guess.type = h.type;
      if (h.shape) guess.shape = h.shape;
      else delete guess.shape;
      if (h.type !== 'pocket') delete guess.fingers;
      else guess.fingers = guess.fingers ?? 3;
      guess.size = sizeFor(h.type, h.shape, lengthM, guess.fingers);
      if (h.type === 'pinch' || h.type === 'foot' || h.type === 'volume' || h.type === 'jug' || h.type === 'sloper' || h.type === 'pocket') guess.angle = -Math.PI / 2;
    }
    return { x: (x + shift) * squeeze, y, guess, lengthM };
  });
}

/** Start (1–2) and top guesses (indices into `placed`). Tape marks starts; else the lowest hand holds. */
export function guessRoles(placed: readonly PlacedHold[], tapes: readonly { x: number; y: number }[] = []): { starts: number[]; top: number | null } {
  const hands = placed.map((p, i) => ({ p, i })).filter(({ p }) => p.guess.type !== 'foot' && p.guess.type !== 'volume');
  if (!hands.length) return { starts: [], top: null };
  const topH = hands.reduce((a, b) => (b.p.y > a.p.y ? b : a));
  const pool = hands.filter((h) => h.i !== topH.i);
  let starts: number[] = [];
  // tape low on the wall marks the start holds
  for (const t of tapes) {
    if (t.y > 2.2) continue;
    let best = -1;
    let bd: number = ROUTE.tapeReach;
    for (const h of pool) {
      const d = Math.hypot(h.p.x - t.x, h.p.y - t.y) - h.p.lengthM / 2;
      if (d < bd && !starts.includes(h.i)) {
        bd = d;
        best = h.i;
      }
    }
    if (best >= 0 && starts.length < 2) starts.push(best);
  }
  if (!starts.length && pool.length) {
    const high = pool.filter((h) => h.p.y >= ROUTE.startMinY);
    const cands = high.length ? high : pool;
    const first = cands.reduce((a, b) => (b.p.y < a.p.y ? b : a));
    starts = [first.i];
    let pair: { p: PlacedHold; i: number } | null = null;
    let pd = Infinity;
    for (const h of cands) {
      if (h.i === first.i) continue;
      const dy = Math.abs(h.p.y - first.p.y);
      const dx = Math.abs(h.p.x - first.p.x);
      if (dy <= ROUTE.pairDy && dx >= ROUTE.pairDxMin && dx <= ROUTE.pairDxMax) {
        const d = Math.hypot(dx, dy);
        if (d < pd) {
          pd = d;
          pair = h;
        }
      }
    }
    if (pair) starts.push(pair.i);
  }
  return { starts, top: topH.i };
}

/**
 * The route colour of the game's palette closest to a sampled colour: by hue for a coloured sample (a
 * shaded blue is still blue, never black), by lightness for a white / grey / black one.
 */
export function routeColorFor(c: Lab): { name: string; hex: string } {
  const chromaC = Math.hypot(c.a, c.b);
  const coloured = chromaC >= 12;
  const hue = (l: Lab): number => Math.atan2(l.b, l.a);
  let best = ROUTE_COLORS[0];
  let bd = Infinity;
  for (const rc of ROUTE_COLORS) {
    const r = hexToLab(rc.hex);
    const chromaR = Math.hypot(r.a, r.b);
    if (coloured !== chromaR >= 12) continue;
    let d: number;
    if (coloured) {
      let dh = Math.abs(hue(c) - hue(r));
      if (dh > Math.PI) dh = 2 * Math.PI - dh;
      // hue first; chroma and lightness only split near neighbours (pink vs red, yellow vs orange)
      d = dh * 60 + Math.abs(chromaC - chromaR) * 0.12 + Math.abs(c.L - r.L) * 0.08;
    } else d = Math.abs(c.L - r.L);
    if (d < bd) {
      bd = d;
      best = rc;
    }
  }
  return best;
}

export interface BuildOptions {
  holds: readonly PhotoHold[];
  rectW: number;
  rectH: number;
  /** Indices into `holds`. */
  starts: readonly number[];
  top: number | null;
  presetId: string;
  color: string;
  name: string;
  seed?: number;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Assemble the BoulderDef the editor loads as a draft. */
export function buildBoulder(o: BuildOptions): BoulderDef {
  const wall = wallFor(o.presetId);
  const placed = placeHolds(o.holds, o.rectW, o.rectH, wall.length);
  const seed = o.seed ?? 1 + Math.floor(Math.random() * 0x7ffffffe);
  const b: BoulderDef = {
    id: `photo-${seed.toString(36)}`,
    name: o.name,
    grade: 0,
    mode: 'boulder',
    wallAngle: 0,
    width: ROUTE.wallWidth,
    height: wall.length,
    holds: [],
    color: o.color,
    seed,
  };
  setWall(b, { panels: wall.panels, length: wall.length }, { restyle: true });
  let n = 0;
  placed.forEach((p, i) => {
    const g = p.guess;
    const role: HoldDef['role'] = g.type === 'foot' || g.type === 'volume' ? 'foot' : i === o.top ? 'top' : o.starts.includes(i) ? 'start' : 'hand';
    const h: HoldDef = {
      id: `${role === 'start' ? 's' : role === 'top' ? 't' : g.type === 'volume' ? 'v' : role === 'foot' ? 'f' : 'h'}${++n}`,
      x: r3(p.x),
      y: r3(p.y),
      type: g.type,
      size: r3(g.size),
      angle: r3(g.angle),
      role,
      color: o.color,
      seed: (Math.imul(seed ^ (i + 1), 2654435761) >>> 1) % 0x7ffffff0 || 1,
    };
    if (g.shape) h.shape = g.shape;
    if (g.fingers) h.fingers = g.fingers;
    b.holds.push(h);
  });
  settle(b);
  return b;
}

/**
 * Keep every hold on the wall and off its neighbours: clamp into the wall's bounds, then shrink the
 * smaller of two overlapping holds (within its product's size range) and nudge it away.
 */
export function settle(b: BoulderDef): void {
  const holds = b.holds;
  for (const h of holds) {
    const c = clampToBounds(h, holdBounds(b, h));
    h.x = r3(c.x);
    h.y = r3(c.y);
  }
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < holds.length; i++) {
      for (let j = i + 1; j < holds.length; j++) {
        const a = holds[i];
        const c = holds[j];
        let gap = capsuleGap(a, a, c, c);
        if (gap >= -0.004) continue;
        const small = a.size * (a.type === 'volume' ? 0.3 : 1) <= c.size * (c.type === 'volume' ? 0.3 : 1) ? a : c;
        const other = small === a ? c : a;
        const range = sizeRange(small);
        if (small.size > range.min) {
          small.size = r3(Math.max(range.min, small.size + gap * 0.6));
          gap = capsuleGap(small, small, other, other);
        }
        if (gap < -0.004) {
          let dx = small.x - other.x;
          let dy = small.y - other.y;
          const d = Math.hypot(dx, dy) || 1;
          dx /= d;
          dy /= d;
          const push = -gap + 0.006;
          const to = clampToBounds({ x: small.x + dx * push, y: small.y + dy * push }, holdBounds(b, small));
          small.x = r3(to.x);
          small.y = r3(to.y);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

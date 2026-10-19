// Wall types for the editor (Phase C): presets from docs/climbing-research.md §3.2 and per-panel editing
// of a multi-angle wall (BoulderDef.profile). Pure: no DOM, no three.js (unit-tested in walls.test.ts).
//
// A wall here is a stack of panels along its surface (WallPanel y0 + angle) and a surface length
// (BoulderDef.height). Holds live in surface coordinates, so they stay on the surface whatever the
// panels do; a wall that would stand taller than the gym (WALL.ceiling) is shortened from the top.

import type { BoulderDef, RouteStyle, WallPanel } from '../core/types';
import { GAME } from '../config/tuning';
import { makeProfile, panelsFromLengths, PROFILE_PRESETS, steepestAngle, worldHeight } from '../game/wall-profile';

export type WallType = 'slab' | 'vertical' | 'overhang' | 'steep' | 'cave' | 'mixed';
export const WALL_TYPES: readonly WallType[] = ['slab', 'vertical', 'overhang', 'steep', 'cave', 'mixed'];
export const WALL_TYPE_LABEL: Readonly<Record<WallType, string>> = {
  slab: 'Slab',
  vertical: 'Vertical',
  overhang: 'Overhang',
  steep: 'Steep',
  cave: 'Cave',
  mixed: 'Mixed',
};

export const WALL = {
  /** A one-panel wall (no profile) keeps BoulderDef.wallAngle's range. */
  flatMin: -15,
  flatMax: 45,
  /** Panels of a multi-angle wall (net validation: −20…90, 90 = a flat roof). */
  panelMin: -20,
  panelMax: 90,
  maxPanels: 8,
  /** Shortest panel (m of surface): a kicker. */
  minPanel: 0.3,
  /** Fold heights snap to this (m). */
  foldStep: 0.05,
  /** Surface length range (m). */
  lengthMin: 3,
  lengthMax: 6,
  /** Highest a boulder wall may stand (m above the floor; the flat wall is GAME.boulderWall.height). */
  ceiling: GAME.boulderWall.height + 0.05,
  defaultLength: GAME.boulderWall.height,
  /** Lowest a wall may stand (m): room to hang under a roof and fall onto the pads. */
  minHeight: 2,
  /** Angle a new fold gives the panel above it (relative), so the fold reads at once. */
  splitStep: 15,
} as const;

export interface WallPreset {
  id: string;
  type: WallType;
  /** Variant label inside its type (e.g. '25°', 'BOARD 40°'). */
  label: string;
  /** [surface length m, angle°] per panel, bottom → top. */
  spec: readonly (readonly [number, number])[];
}

/** §3.2 presets by wall type (the first of each type is what its chip applies). */
export const WALL_PRESETS: readonly WallPreset[] = [
  { id: 'slab', type: 'slab', label: '−8°', spec: PROFILE_PRESETS.SLAB },
  { id: 'slab-steep', type: 'slab', label: '−15°', spec: PROFILE_PRESETS.SLAB_STEEP },
  { id: 'vertical', type: 'vertical', label: '0°', spec: PROFILE_PRESETS.VERTICAL },
  { id: 'vertical-5', type: 'vertical', label: '5°', spec: [[4.5, 5]] },
  { id: 'gentle', type: 'overhang', label: '15°', spec: PROFILE_PRESETS.GENTLE },
  { id: 'overhang-25', type: 'overhang', label: '25°', spec: PROFILE_PRESETS.OVERHANG_25 },
  { id: 'wave', type: 'overhang', label: 'WAVE', spec: PROFILE_PRESETS.WAVE_20_40 },
  { id: 'board-40', type: 'overhang', label: 'BOARD 40°', spec: PROFILE_PRESETS.BOARD_40 },
  { id: 'steep-45', type: 'steep', label: '45°', spec: PROFILE_PRESETS.STEEP_45 },
  { id: 'kick', type: 'steep', label: '30 / 60', spec: PROFILE_PRESETS.KICK_30_60 },
  { id: 'cave', type: 'cave', label: 'CAVE 85°', spec: PROFILE_PRESETS.CAVE },
  { id: 'roof', type: 'cave', label: 'ROOF 90°', spec: [[0.3, 0], [1.6, 30], [1.6, 90], [0.9, 25]] },
  { id: 'bulge', type: 'mixed', label: 'BULGE', spec: PROFILE_PRESETS.BULGE },
  { id: 'step', type: 'mixed', label: 'STEP', spec: [[2.0, -8], [2.5, 18]] },
];

export const presetsOf = (t: WallType): WallPreset[] => WALL_PRESETS.filter((p) => p.type === t);
export const presetById = (id: string): WallPreset | null => WALL_PRESETS.find((p) => p.id === id) ?? null;

/** Wall styles (BoulderDef.style) that describe the wall; the others describe the route and survive wall edits. */
const WALL_STYLES: readonly RouteStyle[] = ['slab', 'vertical', 'overhang', 'cave', 'mixed'];
export const isWallStyle = (s: RouteStyle | undefined): boolean => !s || WALL_STYLES.includes(s);

/** A wall being edited: its panels (bottom → top, first at 0) and its surface length. */
export interface WallState {
  panels: WallPanel[];
  length: number;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const snapFold = (y: number): number => r3(Math.round(y / WALL.foldStep) * WALL.foldStep);

/** The draft's wall as panels + length (a flat wall is one panel at wallAngle). */
export function wallOf(b: Pick<BoulderDef, 'wallAngle' | 'height' | 'profile'>): WallState {
  const length = Number.isFinite(b.height) ? b.height : WALL.defaultLength;
  if (b.profile && b.profile.length >= 2) return { panels: b.profile.map((p) => ({ y0: p.y0, angle: p.angle })), length };
  return { panels: [{ y0: 0, angle: b.wallAngle }], length };
}

export function presetWall(p: WallPreset): WallState {
  const { panels, length } = panelsFromLengths(p.spec);
  return { panels, length };
}

/** Angle limits for a panel of a wall with `n` panels. */
export function angleLimits(n: number): { min: number; max: number } {
  return n <= 1 ? { min: WALL.flatMin, max: WALL.flatMax } : { min: WALL.panelMin, max: WALL.panelMax };
}

/** Surface range [y0, y1) of panel i. */
export function panelRange(w: WallState, i: number): [number, number] {
  const p = w.panels;
  return [p[i].y0, i + 1 < p.length ? p[i + 1].y0 : w.length];
}

/** Does the wall stand too low to climb (WALL.minHeight)? */
export function tooLow(w: WallState): boolean {
  return wallHeightOf(cleanWall(w)) < WALL.minHeight - 1e-6;
}

/** World height (m) of the top of the wall. */
export function wallHeightOf(w: WallState): number {
  return worldHeight(makeProfile(w.panels, w.panels[0]?.angle ?? 0, Infinity), w.length);
}

/**
 * Sanitise a wall: sorted panels from 0, angles clamped (integer degrees), folds on the fold grid and at
 * least a panel apart, at most WALL.maxPanels, length in range and short enough to stand under the ceiling.
 */
export function cleanWall(w: WallState): WallState {
  let panels = w.panels
    .filter((p) => p && Number.isFinite(p.y0) && Number.isFinite(p.angle))
    .map((p) => ({ y0: Math.max(0, p.y0), angle: p.angle }))
    .sort((a, b) => a.y0 - b.y0);
  if (!panels.length) panels = [{ y0: 0, angle: 0 }];
  panels[0].y0 = 0;
  // folds a panel apart (a later fold too close to the previous one is dropped), on the grid
  const kept: WallPanel[] = [panels[0]];
  for (let i = 1; i < panels.length && kept.length < WALL.maxPanels; i++) {
    const y0 = r3(panels[i].y0);
    if (y0 - kept[kept.length - 1].y0 < WALL.minPanel - 1e-6) continue;
    kept.push({ y0, angle: panels[i].angle });
  }
  const lim = angleLimits(kept.length);
  for (const p of kept) p.angle = Math.round(clamp(p.angle, lim.min, lim.max));
  let length = clamp(Number.isFinite(w.length) ? w.length : WALL.defaultLength, WALL.lengthMin, WALL.lengthMax);
  // the top panel needs its length too
  while (kept.length > 1 && length - kept[kept.length - 1].y0 < WALL.minPanel - 1e-6) kept.pop();
  length = fitLength(kept, length);
  while (kept.length > 1 && length - kept[kept.length - 1].y0 < WALL.minPanel - 1e-6) kept.pop();
  if (kept.length === 1) kept[0].angle = Math.round(clamp(kept[0].angle, WALL.flatMin, WALL.flatMax));
  return { panels: kept, length: r3(length) };
}

/** Longest surface ≤ `length` whose top stands under WALL.ceiling (the gym's height). */
export function fitLength(panels: readonly WallPanel[], length: number): number {
  const prof = makeProfile(panels, panels[0]?.angle ?? 0, Infinity);
  if (worldHeight(prof, length) <= WALL.ceiling) return length;
  let lo = Math.max(WALL.lengthMin, (panels.length > 1 ? panels[panels.length - 1].y0 : 0) + WALL.minPanel);
  if (worldHeight(prof, lo) > WALL.ceiling) return lo;
  let hi = length;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (worldHeight(prof, mid) > WALL.ceiling) hi = mid;
    else lo = mid;
  }
  return Math.floor(lo * 100) / 100;
}

/**
 * Write a wall onto a draft: profile (2+ panels) or wallAngle (one panel), height, and the wall style.
 * The style is read off the wall when `restyle`, or when the draft has a wall style (or none) and not
 * `keepStyle`; a route style (dyno, traverse, compression…) survives wall edits.
 */
export function setWall(b: BoulderDef, w: WallState, opts: { restyle?: boolean; keepStyle?: boolean } = {}): void {
  const c = cleanWall(w);
  if (c.panels.length >= 2) {
    b.profile = c.panels.map((p) => ({ y0: r3(p.y0), angle: p.angle }));
    b.wallAngle = Math.round(steepestAngle(c.panels));
  } else {
    delete b.profile;
    b.wallAngle = c.panels[0].angle;
  }
  b.height = c.length;
  if (opts.restyle || !b.style || (!opts.keepStyle && isWallStyle(b.style))) b.style = wallStyleOf(c);
}

// ───────────────────────────── classification ─────────────────────────────

/** Panels that shape the wall (a short kicker at the bottom doesn't make an overhang "mixed"). */
function dominant(w: WallState): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.panels.length; i++) {
    const [a, b] = panelRange(w, i);
    if (b - a >= 0.5) out.push(w.panels[i].angle);
  }
  return out.length ? out : w.panels.map((p) => p.angle);
}

/** Route style a wall reads as: slab · vertical · overhang · cave (a roof) · mixed (a bulge / slab into overhang). */
export function wallStyleOf(w: WallState): RouteStyle {
  const d = dominant(w);
  const max = Math.max(...d);
  const min = Math.min(...d);
  if (max >= 70) return 'cave';
  let convex = false;
  for (let i = 1; i < w.panels.length; i++) {
    const [a0, a1] = panelRange(w, i - 1);
    const [b0, b1] = panelRange(w, i);
    if (a1 - a0 >= 0.5 && b1 - b0 >= 0.5 && w.panels[i].angle < w.panels[i - 1].angle - 8) convex = true;
  }
  if (convex || (min <= -3 && max >= 10)) return 'mixed';
  if (max <= -3) return 'slab';
  if (max <= 6 && min >= -5) return 'vertical';
  if (max >= 7) return 'overhang';
  return d.reduce((s, a) => s + a, 0) / d.length < -2 ? 'slab' : 'vertical';
}

/** The wall-type chip a wall belongs to (steep = an overhang of 42° or more). */
export function wallTypeOf(w: WallState): WallType {
  const s = wallStyleOf(w);
  if (s === 'overhang') return Math.max(...dominant(w)) >= 42 ? 'steep' : 'overhang';
  return s === 'slab' || s === 'vertical' || s === 'cave' || s === 'mixed' ? s : 'overhang';
}

/** The preset this exact wall is, if any. */
export function matchPreset(w: WallState): WallPreset | null {
  const c = cleanWall(w);
  for (const p of WALL_PRESETS) {
    const q = cleanWall(presetWall(p));
    if (q.panels.length !== c.panels.length || Math.abs(q.length - c.length) > 0.06) continue;
    if (q.panels.every((pp, i) => Math.abs(pp.angle - c.panels[i].angle) < 0.5 && Math.abs(pp.y0 - c.panels[i].y0) < 0.02)) return p;
  }
  return null;
}

/** Short reading of a wall for the drawer header: 'OVERHANG · 25°', 'CAVE · 30° / 85°', 'SLAB · −8°'. */
export function wallWords(w: WallState): string {
  const t = WALL_TYPE_LABEL[wallTypeOf(w)].toUpperCase();
  const deg = (a: number): string => `${a < 0 ? '−' : ''}${Math.abs(Math.round(a))}°`;
  const angles = w.panels.filter((_, i) => {
    const [a, b] = panelRange(w, i);
    return b - a >= 0.5 || w.panels.length === 1;
  });
  const list = (angles.length ? angles : w.panels).map((p) => deg(p.angle));
  return `${t} · ${list.join(' / ')}`;
}

// ───────────────────────────── editing ─────────────────────────────

const copy = (w: WallState): WallState => ({ panels: w.panels.map((p) => ({ ...p })), length: w.length });

export function setPanelAngle(w: WallState, i: number, deg: number): WallState {
  const out = copy(w);
  if (!out.panels[i]) return out;
  const lim = angleLimits(out.panels.length);
  out.panels[i].angle = Math.round(clamp(deg, lim.min, lim.max));
  return out;
}

/** Move the fold at the bottom of panel i (i ≥ 1) to surface height y0 (snapped, a panel from its neighbours). */
export function moveFold(w: WallState, i: number, y0: number): WallState {
  const out = copy(w);
  if (i < 1 || i >= out.panels.length) return out;
  const lo = out.panels[i - 1].y0 + WALL.minPanel;
  const hi = (i + 1 < out.panels.length ? out.panels[i + 1].y0 : out.length) - WALL.minPanel;
  if (hi < lo) return out;
  out.panels[i].y0 = clamp(snapFold(y0), Math.ceil(lo / WALL.foldStep - 1e-6) * WALL.foldStep, Math.floor(hi / WALL.foldStep + 1e-6) * WALL.foldStep);
  out.panels[i].y0 = r3(out.panels[i].y0);
  return out;
}

/** Can panel i be split in two (long enough, room for another panel)? */
export function canSplit(w: WallState, i: number): boolean {
  const [a, b] = panelRange(w, i);
  return w.panels.length < WALL.maxPanels && b - a >= 2 * WALL.minPanel;
}

/**
 * Split panel i at its middle: the upper half leans WALL.splitStep further (back when that would leave
 * the range), so the new fold is visible at once. Returns the new wall and the new (upper) panel's index.
 */
export function splitPanel(w: WallState, i: number): { wall: WallState; index: number } | null {
  if (!canSplit(w, i)) return null;
  const [a, b] = panelRange(w, i);
  const out = copy(w);
  const mid = clamp(snapFold((a + b) / 2), a + WALL.minPanel, b - WALL.minPanel);
  const base = out.panels[i].angle;
  const lim = angleLimits(out.panels.length + 1);
  const up = base + WALL.splitStep <= lim.max ? base + WALL.splitStep : base - WALL.splitStep;
  out.panels.splice(i + 1, 0, { y0: r3(mid), angle: Math.round(clamp(up, lim.min, lim.max)) });
  return { wall: out, index: i + 1 };
}

/**
 * Remove panel i: it merges into the panel below (the bottom panel merges into the one above).
 * Returns the wall and the index of the panel that grew; null for a one-panel wall.
 */
export function mergePanel(w: WallState, i: number): { wall: WallState; index: number; clamped: boolean } | null {
  if (w.panels.length < 2 || i < 0 || i >= w.panels.length) return null;
  const out = copy(w);
  let index: number;
  if (i === 0) {
    out.panels.splice(1, 1);
    out.panels[0].angle = w.panels[1].angle;
    index = 0;
  } else {
    out.panels.splice(i, 1);
    index = i - 1;
  }
  let clamped = false;
  if (out.panels.length === 1) {
    const a = clamp(out.panels[0].angle, WALL.flatMin, WALL.flatMax);
    clamped = a !== out.panels[0].angle;
    out.panels[0].angle = a;
  }
  return { wall: out, index, clamped };
}

/** The panel a fresh wall's controls start on: the longest one (the main face, not the kicker). */
export function mainPanel(w: WallState): number {
  let best = 0;
  let bl = -1;
  for (let i = 0; i < w.panels.length; i++) {
    const [a, b] = panelRange(w, i);
    if (b - a > bl + 1e-6) {
      bl = b - a;
      best = i;
    }
  }
  return best;
}

/** Side view of a wall: (out, height) of every fold, foot first, top last (wall-local, m). */
export function sideView(w: WallState): { z: number; h: number }[] {
  const pts = [{ z: 0, h: 0 }];
  for (let i = 0; i < w.panels.length; i++) {
    const [a, b] = panelRange(w, i);
    const t = (w.panels[i].angle * Math.PI) / 180;
    const q = pts[pts.length - 1];
    pts.push({ z: q.z + Math.sin(t) * (b - a), h: q.h + Math.cos(t) * (b - a) });
  }
  return pts;
}

/** Side-view point of surface height y (on the wall). */
export function sidePoint(w: WallState, y: number): { z: number; h: number; angle: number } {
  const pts = sideView(w);
  const n = w.panels.length;
  let i = n - 1;
  while (i > 0 && y < w.panels[i].y0) i--;
  const t = (w.panels[i].angle * Math.PI) / 180;
  const d = clamp(y, 0, w.length) - w.panels[i].y0;
  return { z: pts[i].z + Math.sin(t) * d, h: pts[i].h + Math.cos(t) * d, angle: w.panels[i].angle };
}

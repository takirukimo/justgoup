// Pure editor model: draft creation + sanitising, T-nut snapping, wall bounds + overlap rules,
// validation, content hashing (test → publish gating), undo history and draft persistence.
// No DOM, no three.js — unit-tested in model.test.ts and shared with the solver worker.

import type { BoulderDef, HoldDef, HoldRole, HoldShape, HoldType, RouteStyle, Vec2, WallPanel } from '../core/types';
import { makeProfile, steepestAngle } from '../game/wall-profile';
import { GAME } from '../config/tuning';
import { ROUTE_COLORS } from '../config/brand';
import { hashString, Rng, uid } from '../core/rng';
import { clamp, DEG } from '../core/math';

/** Roles a setter can assign (deco belongs to other routes and is never authored). */
export type EditRole = Exclude<HoldRole, 'deco'>;
export const EDIT_ROLES: readonly EditRole[] = ['start', 'hand', 'foot', 'top'];
export const HOLD_TYPES: readonly HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot', 'volume'];

export const EDITOR = {
  /** T-nut lattice: rows every 0.2 m from y = 0.1 m, odd rows offset by 0.1 m (a checkerboard of the 0.1 m grid). */
  tnutStep: 0.2,
  tnutRow0: 0.1,
  angleMin: -10,
  angleMax: 45,
  angleDefault: 10,
  rotateStep: 15 * DEG,
  /** Free clearance (m) between hold footprints when placing or moving. */
  clearance: 0.012,
  /** Validation only flags footprints that overlap by more than this fraction of the smaller one. */
  overlapTolerance: 0.3,
  /** Hold centres stay above the crash pads. */
  floorY: 0.3,
  maxStarts: 2,
  minHands: 4,
  maxHolds: 64,
  nameMax: 28,
  historyMax: 100,
  /** Minimum vertical gap between the highest start hold and the top. */
  minRise: 0.6,
  storageKey: 'jgu.editor.draft',
} as const;

/** Size slider range per hold type (characteristic radius, m). Mirrors the generator's sizes, a little wider. */
export const SIZE_RANGE: Readonly<Record<HoldType, { min: number; max: number; def: number }>> = {
  jug: { min: 0.07, max: 0.13, def: 0.1 },
  edge: { min: 0.045, max: 0.09, def: 0.065 },
  crimp: { min: 0.025, max: 0.05, def: 0.038 },
  sloper: { min: 0.07, max: 0.13, def: 0.1 },
  pinch: { min: 0.045, max: 0.09, def: 0.065 },
  pocket: { min: 0.035, max: 0.07, def: 0.05 },
  foot: { min: 0.018, max: 0.04, def: 0.028 },
  volume: { min: 0.2, max: 0.45, def: 0.32 },
};

/** Footprint radius ÷ size per type (edges and crimps are long and thin). */
const FOOTPRINT: Readonly<Record<HoldType, number>> = {
  jug: 1.1,
  edge: 1.35,
  crimp: 1.45,
  sloper: 1.05,
  pinch: 1.25,
  pocket: 1.1,
  foot: 1.25,
  volume: 1,
};

export const TYPE_LABEL: Readonly<Record<HoldType, string>> = {
  jug: 'Jug',
  edge: 'Edge',
  crimp: 'Crimp',
  sloper: 'Sloper',
  pinch: 'Pinch',
  pocket: 'Pocket',
  foot: 'Foot chip',
  volume: 'Volume',
};

export const ROLE_LABEL: Readonly<Record<EditRole, string>> = { start: 'Start', hand: 'Hand', foot: 'Foot', top: 'Top' };

const NAMES = [
  'Salt Lick', 'Scree Dance', 'Gneiss Try', 'Cornice', 'Bergschrund', 'Couloir Kid', 'Moraine Line', 'Edelweiss',
  'Marmot Alarm', 'Serac Attack', 'Glacier Mint', 'Alpenglow', 'Horn Dance', 'Firn Line', 'Hanging Valley',
  'Ridge Runner', 'Lichen It', 'Cirque du Crimp', 'Steinbock Start', 'Dam Wall Dreams', 'Föhn Rider', 'Talus Tango',
] as const;

export function randomName(rng: Rng = new Rng((Math.random() * 2 ** 32) >>> 0)): string {
  return rng.pick(NAMES);
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const randomSeed = (): number => 1 + Math.floor(Math.random() * 0x7ffffffe);
const isType = (t: unknown): t is HoldType => typeof t === 'string' && (HOLD_TYPES as readonly string[]).includes(t);
const isRole = (r: unknown): r is EditRole => typeof r === 'string' && (EDIT_ROLES as readonly string[]).includes(r);
const isHex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

/** Hands may use start / hand / top holds that are not foot chips (same rule as the sim). */
export const handUsable = (h: HoldDef): boolean => (h.role === 'start' || h.role === 'hand' || h.role === 'top') && h.type !== 'foot';

export function footprint(h: { type: HoldType; size: number }): number {
  return h.size * FOOTPRINT[h.type];
}

// ───────────────────────────── drafts ─────────────────────────────

export interface DraftOptions {
  name?: string;
  color?: string;
  wallAngle?: number;
  seed?: number;
}

/** An empty boulder on the CHIRAL wall. */
export function createDraft(o: DraftOptions = {}): BoulderDef {
  const seed = o.seed ?? randomSeed();
  const rng = new Rng(seed);
  return {
    id: uid('u-'),
    name: o.name ?? randomName(rng),
    grade: 0,
    mode: 'boulder',
    wallAngle: clamp(Math.round(o.wallAngle ?? EDITOR.angleDefault), EDITOR.angleMin, EDITOR.angleMax),
    width: GAME.boulderWall.width,
    height: GAME.boulderWall.height,
    holds: [],
    color: o.color && isHex(o.color) ? o.color : ROUTE_COLORS[rng.int(0, 6)].hex,
    seed,
  };
}

/**
 * Sanitise any incoming boulder (localStorage, a generated sample, a problem being remixed) into an
 * editable draft: boulder mode on the standard wall, no deco / quickdraws, finite numbers, unique ids,
 * route colour on every hold, angle in the editor range.
 */
export function normalizeDraft(input: BoulderDef): BoulderDef {
  const base = createDraft();
  const color = isHex(input.color) ? input.color : base.color;
  const W = GAME.boulderWall.width;
  const H = GAME.boulderWall.height;
  const seen = new Set<string>();
  const holds: HoldDef[] = [];
  for (const raw of Array.isArray(input.holds) ? input.holds : []) {
    if (!raw || raw.role === 'deco' || !isType(raw.type) || !isRole(raw.role)) continue;
    const x = finite(raw.x, NaN);
    const y = finite(raw.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > W / 2 || y < 0 || y > H) continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid('h');
    while (seen.has(id)) id = uid('h');
    seen.add(id);
    const range = SIZE_RANGE[raw.type];
    const role: EditRole = raw.type === 'foot' && raw.role !== 'foot' ? 'foot' : raw.role;
    const h: HoldDef = {
      id,
      x: r3(x),
      y: r3(y),
      type: raw.type,
      size: r3(clamp(finite(raw.size, range.def), range.min * 0.8, range.max * 1.1)),
      angle: r3(finite(raw.angle, -Math.PI / 2)),
      role,
      color,
      seed: Math.floor(Math.abs(finite(raw.seed, randomSeed()))) || 1,
    };
    keepVariety(raw, h);
    holds.push(h);
    if (holds.length >= EDITOR.maxHolds) break;
  }
  const out: BoulderDef = {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 60) : base.id,
    name: cleanName(typeof input.name === 'string' ? input.name : '') || base.name,
    grade: clamp(Math.round(finite(input.grade, 0)), 0, 12),
    mode: 'boulder',
    wallAngle: clamp(Math.round(finite(input.wallAngle, EDITOR.angleDefault)), EDITOR.angleMin, EDITOR.angleMax),
    width: W,
    height: H,
    holds,
    color,
    seed: Math.floor(Math.abs(finite(input.seed, base.seed))) || 1,
  };
  if (typeof input.author === 'string' && input.author) out.author = input.author.slice(0, 40);
  // a multi-angle wall (generated samples, community problems) keeps its panels; wallAngle is then
  // the steepest panel's angle, as everywhere else (panel editing itself is a later phase)
  const prof = cleanProfile(input.profile, H);
  if (prof) {
    out.profile = prof;
    out.wallAngle = Math.round(steepestAngle(prof));
  }
  if (typeof input.style === 'string' && ROUTE_STYLES.includes(input.style)) out.style = input.style;
  const sf = pruneStartFeet(input.startFeet, holds);
  if (sf) out.startFeet = sf;
  return out;
}

const ROUTE_STYLES: readonly RouteStyle[] = ['vertical', 'slab', 'overhang', 'cave', 'traverse', 'dyno', 'compression', 'mixed', 'zigzag', 'diagonal'];
const HOLD_SHAPES: readonly HoldShape[] = ['bucket', 'horn', 'rail', 'micro', 'chip', 'macro', 'dual-tex', 'wood'];
const MAX_PANELS = 8;

/**
 * Copy the optional hold-variety fields (Phase B) from untrusted input, sanitised. Holds bolted onto
 * volumes (onVolume) are not editable yet: they come in as ordinary wall holds.
 */
function keepVariety(raw: HoldDef, h: HoldDef): void {
  if (Number.isFinite(raw.edgeDepthMm)) h.edgeDepthMm = r3(clamp(raw.edgeDepthMm as number, 2, 80));
  if (Number.isFinite(raw.lipAngle)) h.lipAngle = r3(clamp(raw.lipAngle as number, -60, 60));
  if (raw.fingers === 1 || raw.fingers === 2 || raw.fingers === 3 || raw.fingers === 4) h.fingers = raw.fingers;
  if (typeof raw.shape === 'string' && HOLD_SHAPES.includes(raw.shape)) h.shape = raw.shape;
}

/** A sanitised multi-angle profile (2…8 panels inside the wall), or undefined for a flat wall. */
function cleanProfile(panels: unknown, height: number): WallPanel[] | undefined {
  if (!Array.isArray(panels) || panels.length < 2) return undefined;
  const raw: WallPanel[] = [];
  for (const p of panels.slice(0, MAX_PANELS * 2)) {
    const q = p as Partial<WallPanel> | null;
    if (q && Number.isFinite(q.y0) && Number.isFinite(q.angle)) raw.push({ y0: q.y0 as number, angle: q.angle as number });
  }
  const prof = makeProfile(raw, 0, height);
  if (prof.flat || prof.panels.length < 2 || prof.panels.length > MAX_PANELS) return undefined;
  return prof.panels.map((p) => ({ y0: r3(p.y0), angle: r3(p.angle) }));
}

/** Keep authored start feet only while they still point at footholds that exist. */
export function pruneStartFeet(sf: BoulderDef['startFeet'], holds: readonly HoldDef[]): BoulderDef['startFeet'] | undefined {
  if (!sf) return undefined;
  const ok = (id: string | undefined): id is string => !!id && holds.some((h) => h.id === id);
  const out: { LF?: string; RF?: string } = {};
  if (ok(sf.LF)) out.LF = sf.LF;
  if (ok(sf.RF)) out.RF = sf.RF;
  return out.LF || out.RF ? out : undefined;
}

export function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, EDITOR.nameMax);
}

/** A generated problem → a remixable draft (other routes' deco holds removed). */
export function draftFromSample(b: BoulderDef): BoulderDef {
  const d = normalizeDraft({ ...b, id: uid('u-') });
  d.grade = clamp(Math.round(b.grade), 0, 12);
  return d;
}

export function cloneDraft(b: BoulderDef): BoulderDef {
  const c: BoulderDef = { ...b, holds: b.holds.map((h) => ({ ...h })) };
  if (b.profile) c.profile = b.profile.map((p) => ({ ...p }));
  if (b.startFeet) c.startFeet = { ...b.startFeet };
  if (b.quickdraws) c.quickdraws = b.quickdraws.map((q) => ({ ...q }));
  return c;
}

/** New hold of `type` / `role` at `p` with type defaults (classic orientation: body below). */
export function makeHold(type: HoldType, role: EditRole, p: Vec2, color: string, size?: number): HoldDef {
  const range = SIZE_RANGE[type];
  return {
    id: uid('h'),
    x: r3(p.x),
    y: r3(p.y),
    type,
    size: r3(clamp(size ?? range.def, range.min, range.max)),
    angle: -Math.PI / 2,
    role: type === 'foot' ? 'foot' : role,
    color,
    seed: randomSeed(),
  };
}

/** Stable content hash: what the climb is (holds, wall, colour) — not its name, id or grade. */
export function draftHash(b: BoulderDef): string {
  const hs = [...b.holds].sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
  let s = `${b.wallAngle}|${b.color}|${b.startFeet?.LF ?? ''},${b.startFeet?.RF ?? ''}`;
  if (b.profile) s += `|p${b.profile.map((p) => `${r3(p.y0)}:${r3(p.angle)}`).join(',')}`;
  for (const h of hs) s += `|${h.id}:${r3(h.x)},${r3(h.y)},${h.type},${r3(h.size)},${r3(h.angle)},${h.role},${h.seed}`;
  return hashString(s).toString(36) + hs.length.toString(36);
}

// ───────────────────────────── geometry rules ─────────────────────────────

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Where the centre of a hold of this type/size may sit on the wall. */
export function holdBounds(b: Pick<BoulderDef, 'width' | 'height'>, h: { type: HoldType; size: number }): Bounds {
  const r = footprint(h);
  const side = Math.max(0.05, r * 0.9 + 0.02);
  return {
    x0: -b.width / 2 + side,
    x1: b.width / 2 - side,
    y0: Math.max(EDITOR.floorY, 0.26 + r * 0.6),
    y1: b.height - side,
  };
}

export function inBounds(p: Vec2, bd: Bounds, tol = 0): boolean {
  return p.x >= bd.x0 - tol && p.x <= bd.x1 + tol && p.y >= bd.y0 - tol && p.y <= bd.y1 + tol;
}

export function clampToBounds(p: Vec2, bd: Bounds): Vec2 {
  return { x: clamp(p.x, bd.x0, bd.x1), y: clamp(p.y, bd.y0, bd.y1) };
}

/** Nearest T-nut to p (staggered 0.2 m lattice, i.e. the 0.1 m checkerboard the wall is drilled on). */
export function snapToTnut(p: Vec2): Vec2 {
  const step = EDITOR.tnutStep;
  const r0 = Math.round((p.y - EDITOR.tnutRow0) / step);
  let best = { x: p.x, y: p.y };
  let bd = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    const y = EDITOR.tnutRow0 + r * step;
    const off = Math.abs(r) % 2 === 1 ? step / 2 : 0;
    const x = Math.round((p.x - off) / step) * step + off;
    const d = (x - p.x) ** 2 + (y - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = { x: r3(x), y: r3(y) };
    }
  }
  return best;
}

/** T-nuts within `radius` of p, nearest first. */
export function tnutsNear(p: Vec2, radius: number): Vec2[] {
  const step = EDITOR.tnutStep;
  const out: { p: Vec2; d: number }[] = [];
  const rMin = Math.floor((p.y - radius - EDITOR.tnutRow0) / step);
  const rMax = Math.ceil((p.y + radius - EDITOR.tnutRow0) / step);
  for (let r = rMin; r <= rMax; r++) {
    const y = EDITOR.tnutRow0 + r * step;
    const off = Math.abs(r) % 2 === 1 ? step / 2 : 0;
    const kMin = Math.floor((p.x - radius - off) / step);
    const kMax = Math.ceil((p.x + radius - off) / step);
    for (let k = kMin; k <= kMax; k++) {
      const x = k * step + off;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= radius) out.push({ p: { x: r3(x), y: r3(y) }, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map((o) => o.p);
}

/** Edge-to-edge clearance between a prospective hold and its nearest neighbour (Infinity if alone). */
export function clearanceAt(holds: readonly HoldDef[], p: Vec2, h: { type: HoldType; size: number }, ignoreId?: string): number {
  const r = footprint(h);
  let g = Infinity;
  for (const o of holds) {
    if (o.id === ignoreId) continue;
    const d = Math.hypot(o.x - p.x, o.y - p.y) - r - footprint(o);
    if (d < g) g = d;
  }
  return g;
}

export function fits(b: BoulderDef, p: Vec2, h: { type: HoldType; size: number }, ignoreId?: string): boolean {
  return inBounds(p, holdBounds(b, h), 1e-6) && clearanceAt(b.holds, p, h, ignoreId) >= EDITOR.clearance;
}

/**
 * Best legal spot for a hold near `want`: the nearest free T-nut (snap) or the nearest free point
 * (free mode, pushed out of neighbours). null when nothing fits within `searchRadius`.
 */
export function findSpot(
  b: BoulderDef,
  want: Vec2,
  h: { type: HoldType; size: number },
  opts: { snap: boolean; ignoreId?: string; searchRadius?: number } = { snap: true },
): Vec2 | null {
  const bd = holdBounds(b, h);
  const radius = opts.searchRadius ?? 0.3;
  if (opts.snap) {
    const c = clampToBounds(want, bd);
    for (const t of tnutsNear(c, radius + 0.15)) {
      if (Math.hypot(t.x - want.x, t.y - want.y) > radius + 0.15) continue;
      if (fits(b, t, h, opts.ignoreId)) return t;
    }
    return null;
  }
  let p = clampToBounds(want, bd);
  const r = footprint(h);
  for (let iter = 0; iter < 8; iter++) {
    let worst: HoldDef | null = null;
    let wg: number = EDITOR.clearance;
    for (const o of b.holds) {
      if (o.id === opts.ignoreId) continue;
      const g = Math.hypot(o.x - p.x, o.y - p.y) - r - footprint(o);
      if (g < wg) {
        wg = g;
        worst = o;
      }
    }
    if (!worst) break;
    let dx = p.x - worst.x;
    let dy = p.y - worst.y;
    let l = Math.hypot(dx, dy);
    if (l < 1e-6) {
      dx = want.x - worst.x || 1;
      dy = want.y - worst.y;
      l = Math.hypot(dx, dy) || 1;
    }
    const need = r + footprint(worst) + EDITOR.clearance + 0.002;
    p = clampToBounds({ x: worst.x + (dx / l) * need, y: worst.y + (dy / l) * need }, bd);
  }
  const out = { x: r3(p.x), y: r3(p.y) };
  if (Math.hypot(out.x - want.x, out.y - want.y) > radius) return null;
  return fits(b, out, h, opts.ignoreId) ? out : null;
}

// ───────────────────────────── validation ─────────────────────────────

export type RuleId = 'start' | 'top' | 'hands' | 'wall' | 'rise';

export interface RuleCheck {
  id: RuleId;
  ok: boolean;
  label: string;
  /** Short value, e.g. '2/2', '6/4+'. */
  value: string;
  /** What to do when it fails. */
  fix: string;
  /** Compact form of `fix` for the status chip. */
  short: string;
}

export interface DraftCheck {
  ok: boolean;
  rules: RuleCheck[];
  /** Holds that break a placement rule (outside the wall or overlapping another hold). */
  flagged: Set<string>;
  counts: { start: number; top: number; hands: number; feet: number; total: number };
  /** First failing rule's fix, '' when ok. */
  headline: string;
  /** Compact headline for the status chip. */
  short: string;
}

/** Live rules for a publishable problem: 1–2 starts, one top above them, 4+ hand holds, all holds on the wall. */
export function validateDraft(b: BoulderDef): DraftCheck {
  const starts = b.holds.filter((h) => h.role === 'start' && handUsable(h));
  const tops = b.holds.filter((h) => h.role === 'top' && handUsable(h));
  const hands = b.holds.filter(handUsable).length;
  const feet = b.holds.filter((h) => h.role === 'foot').length;
  const flagged = new Set<string>();
  let off = 0;
  let overlaps = 0;
  for (let i = 0; i < b.holds.length; i++) {
    const h = b.holds[i];
    if (!inBounds(h, holdBounds(b, h), 0.012)) {
      flagged.add(h.id);
      off++;
    }
    for (let j = i + 1; j < b.holds.length; j++) {
      const o = b.holds[j];
      const ra = footprint(h);
      const rb = footprint(o);
      const gap = Math.hypot(h.x - o.x, h.y - o.y) - ra - rb;
      if (gap < -EDITOR.overlapTolerance * Math.min(ra, rb) * 2) {
        if (!flagged.has(h.id) || !flagged.has(o.id)) overlaps++;
        flagged.add(h.id);
        flagged.add(o.id);
      }
    }
  }
  const sOk = starts.length >= 1 && starts.length <= EDITOR.maxStarts;
  const tOk = tops.length === 1;
  const hOk = hands >= EDITOR.minHands;
  const wOk = flagged.size === 0;
  const maxStartY = starts.length ? Math.max(...starts.map((h) => h.y)) : -Infinity;
  const rOk = !(sOk && tOk) || tops[0].y >= maxStartY + EDITOR.minRise;
  const more = EDITOR.minHands - hands;
  const rules: RuleCheck[] = [
    {
      id: 'start',
      ok: sOk,
      label: 'Start holds',
      value: `${starts.length}/${EDITOR.maxStarts}`,
      fix: starts.length === 0 ? 'Add a start hold' : `Max ${EDITOR.maxStarts} start holds`,
      short: starts.length === 0 ? 'Need a start' : `Max ${EDITOR.maxStarts} starts`,
    },
    {
      id: 'top',
      ok: tOk,
      label: 'Top hold',
      value: `${tops.length}/1`,
      fix: tops.length === 0 ? 'Add a top hold' : 'Only one top hold',
      short: tops.length === 0 ? 'Need a top' : 'One top only',
    },
    {
      id: 'hands',
      ok: hOk,
      label: 'Hand holds',
      value: `${hands}/${EDITOR.minHands}+`,
      fix: `Add ${more} more hand hold${more === 1 ? '' : 's'}`,
      short: `Need ${more} hand${more === 1 ? '' : 's'}`,
    },
    {
      id: 'wall',
      ok: wOk,
      label: 'On the wall',
      value: wOk ? 'OK' : `${flagged.size} hold${flagged.size === 1 ? '' : 's'}`,
      fix: overlaps > 0 ? 'Separate overlapping holds' : 'Move holds onto the wall',
      short: overlaps > 0 ? 'Overlapping' : 'Off the wall',
    },
    { id: 'rise', ok: rOk, label: 'Top above start', value: rOk ? 'OK' : 'LOW', fix: 'Set the top higher than the start', short: 'Top too low' },
  ];
  void off;
  const failing = rules.find((r) => !r.ok);
  return {
    ok: !failing,
    rules,
    flagged,
    counts: { start: starts.length, top: tops.length, hands, feet, total: b.holds.length },
    headline: failing ? failing.fix : '',
    short: failing ? failing.short : '',
  };
}

// ───────────────────────────── undo history ─────────────────────────────

export interface Snapshot {
  holds: HoldDef[];
  wallAngle: number;
  color: string;
  startFeet?: BoulderDef['startFeet'];
  /** Multi-angle panels (flattening a sample's wall with the angle slider is undoable). */
  profile?: WallPanel[];
}

export function snapshotOf(b: BoulderDef): Snapshot {
  const s: Snapshot = { holds: b.holds.map((h) => ({ ...h })), wallAngle: b.wallAngle, color: b.color };
  if (b.startFeet) s.startFeet = { ...b.startFeet };
  if (b.profile) s.profile = b.profile.map((p) => ({ ...p }));
  return s;
}

export function applySnapshot(b: BoulderDef, s: Snapshot): void {
  b.holds = s.holds.map((h) => ({ ...h }));
  b.wallAngle = s.wallAngle;
  b.color = s.color;
  if (s.startFeet) b.startFeet = { ...s.startFeet };
  else delete b.startFeet;
  if (s.profile) b.profile = s.profile.map((p) => ({ ...p }));
  else delete b.profile;
}

/** Snapshot undo/redo stack. Call checkpoint(draft) right BEFORE a mutation. */
export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  constructor(private max: number = EDITOR.historyMax) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  checkpoint(b: BoulderDef): void {
    this.undoStack.push(snapshotOf(b));
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Drop the newest checkpoint (a gesture that ended up changing nothing). */
  discard(): void {
    this.undoStack.pop();
  }

  /** Forget the redo branch (an undo that should not be redoable, e.g. a double-tap take-back). */
  discardRedo(): void {
    this.redoStack.length = 0;
  }

  undo(b: BoulderDef): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(snapshotOf(b));
    applySnapshot(b, s);
    return true;
  }

  redo(b: BoulderDef): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(snapshotOf(b));
    applySnapshot(b, s);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

// ───────────────────────────── persistence ─────────────────────────────

export interface StoredDraft {
  v: 1;
  draft: BoulderDef;
  /** draftHash of the revision the player sent in a test climb (publish gate). */
  passed: string | null;
  /** draftHash of the revision last published. */
  published: string | null;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadStoredDraft(store: Storage | null = storage()): StoredDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(EDITOR.storageKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (!v || v.v !== 1 || !v.draft || typeof v.draft !== 'object') return null;
    return {
      v: 1,
      draft: normalizeDraft(v.draft as BoulderDef),
      passed: typeof v.passed === 'string' ? v.passed : null,
      published: typeof v.published === 'string' ? v.published : null,
      savedAt: finite(v.savedAt, 0),
    };
  } catch {
    return null;
  }
}

export function saveStoredDraft(s: StoredDraft, store: Storage | null = storage()): boolean {
  if (!store) return false;
  try {
    store.setItem(EDITOR.storageKey, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

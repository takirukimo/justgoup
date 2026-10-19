// Pure editor model: draft creation + sanitising, T-nut snapping, footprints (capsules fitted to each
// product), holds bolted onto volumes, wall bounds + overlap rules, validation, content hashing
// (test → publish gating), undo history and draft persistence.
// No DOM, no three.js — unit-tested in model.test.ts and shared with the solver worker.

import type { BoulderDef, HoldDef, HoldRole, HoldShape, HoldType, RouteStyle, Vec2, WallPanel } from '../core/types';
import { makeProfile } from '../game/wall-profile';
import { cleanWall, setWall, WALL } from './walls';
import { extentOf, sizeRange, SIZE_RANGE } from './catalog';
import { GAME } from '../config/tuning';
import { ROUTE_COLORS } from '../config/brand';
import { hashString, Rng, uid } from '../core/rng';
import { clamp, DEG } from '../core/math';

export { SIZE_RANGE, sizeRange } from './catalog';

/** Roles a setter can assign (deco belongs to other routes and is never authored). */
export type EditRole = Exclude<HoldRole, 'deco'>;
export const EDIT_ROLES: readonly EditRole[] = ['start', 'hand', 'foot', 'top'];
export const HOLD_TYPES: readonly HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot', 'volume'];

export const EDITOR = {
  /** T-nut lattice: rows every 0.2 m from y = 0.1 m, odd rows offset by 0.1 m (a checkerboard of the 0.1 m grid). */
  tnutStep: 0.2,
  tnutRow0: 0.1,
  /** One-panel wall angle range (walls.ts WALL.flatMin / flatMax). */
  angleMin: WALL.flatMin,
  angleMax: WALL.flatMax,
  angleDefault: 10,
  rotateStep: 15 * DEG,
  /** Free clearance (m) between hold footprints when placing or moving. */
  clearance: 0.012,
  /** Validation only flags footprints that overlap by more than this fraction of the smaller one. */
  overlapTolerance: 0.3,
  /** A bolted-on hold may sit this far (m) past its volume's outline before it is flagged. */
  mountTolerance: 0.03,
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
    height: WALL.defaultLength,
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
  // the wall: its surface length (a folded sample's own, e.g. a cave's lip), panels, and the ceiling
  const H0 = clamp(finite(input.height, WALL.defaultLength), WALL.lengthMin, WALL.lengthMax);
  const prof = cleanProfile(input.profile, H0);
  const wall = cleanWall({ panels: prof ?? [{ y0: 0, angle: clamp(Math.round(finite(input.wallAngle, EDITOR.angleDefault)), EDITOR.angleMin, EDITOR.angleMax) }], length: H0 });
  const H = wall.length;
  const seen = new Set<string>();
  const renamed = new Map<string, string>();
  const holds: HoldDef[] = [];
  for (const raw of Array.isArray(input.holds) ? input.holds : []) {
    if (!raw || raw.role === 'deco' || !isType(raw.type) || !isRole(raw.role)) continue;
    const x = finite(raw.x, NaN);
    const y = finite(raw.y, NaN);
    // (a hold a little past the top of a shortened wall stays: the rules flag it, the setter moves it)
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > W / 2 || y < 0 || y > H + 0.5) continue;
    let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid('h');
    while (seen.has(id)) id = uid('h');
    seen.add(id);
    const range = sizeRange({ type: raw.type, shape: typeof raw.shape === 'string' && HOLD_SHAPES.includes(raw.shape) ? raw.shape : undefined });
    const role: EditRole = raw.type === 'foot' && raw.role !== 'foot' ? 'foot' : raw.role;
    if (typeof raw.id === 'string' && raw.id && raw.id !== id) renamed.set(raw.id.slice(0, 40), id);
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
    if (typeof raw.onVolume === 'string' && raw.onVolume && raw.type !== 'volume') h.onVolume = raw.onVolume.slice(0, 40);
    holds.push(h);
    if (holds.length >= EDITOR.maxHolds) break;
  }
  // holds bolted onto volumes keep their volume (followed through renamed duplicate ids), when it is here
  for (const h of holds) {
    if (!h.onVolume) continue;
    const vid = renamed.get(h.onVolume) ?? h.onVolume;
    if (holds.some((v) => v.id === vid && v.type === 'volume')) h.onVolume = vid;
    else delete h.onVolume;
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
  if (typeof input.style === 'string' && ROUTE_STYLES.includes(input.style)) out.style = input.style;
  // a multi-angle wall (generated samples, community problems, the setter's own) keeps its panels;
  // wallAngle is then the steepest panel's angle, as everywhere else. A route style (dyno, traverse…)
  // stays; a missing style is read off the wall.
  setWall(out, wall, { keepStyle: true });
  const sf = pruneStartFeet(input.startFeet, holds);
  if (sf) out.startFeet = sf;
  return out;
}

const ROUTE_STYLES: readonly RouteStyle[] = ['vertical', 'slab', 'overhang', 'cave', 'traverse', 'dyno', 'compression', 'mixed', 'zigzag', 'diagonal'];
const HOLD_SHAPES: readonly HoldShape[] = ['bucket', 'horn', 'rail', 'micro', 'chip', 'macro', 'dual-tex', 'wood'];
const MAX_PANELS = 8;

/** Copy the optional hold-variety fields (Phase B) from untrusted input, sanitised. */
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
  // a generated hold sitting inside a route volume's base (no onVolume) would be buried in it: bolt it on
  for (const h of d.holds) {
    if (h.onVolume || h.type === 'volume') continue;
    const v = volumeAt(d, h);
    if (v && insideDistance(volumeShape(v).outline, h) > 0.02) h.onVolume = v.id;
  }
  return d;
}

export function cloneDraft(b: BoulderDef): BoulderDef {
  const c: BoulderDef = { ...b, holds: b.holds.map((h) => ({ ...h })) };
  if (b.profile) c.profile = b.profile.map((p) => ({ ...p }));
  if (b.startFeet) c.startFeet = { ...b.startFeet };
  if (b.quickdraws) c.quickdraws = b.quickdraws.map((q) => ({ ...q }));
  return c;
}

/**
 * New hold of `type` / `role` at `p` with its product's defaults (classic orientation: body below).
 * `extra` carries the product (shape, fingers, seed for a volume's geometry) and a volume to bolt onto.
 */
export function makeHold(
  type: HoldType,
  role: EditRole,
  p: Vec2,
  color: string,
  size?: number,
  extra: Partial<Pick<HoldDef, 'shape' | 'fingers' | 'seed' | 'onVolume' | 'angle'>> = {},
): HoldDef {
  const range = sizeRange({ type, shape: extra.shape });
  const h: HoldDef = {
    id: uid('h'),
    x: r3(p.x),
    y: r3(p.y),
    type,
    size: r3(clamp(size ?? range.def, range.min, range.max)),
    angle: extra.angle ?? -Math.PI / 2,
    role: type === 'foot' ? 'foot' : role,
    color,
    seed: extra.seed ?? randomSeed(),
  };
  if (extra.shape) h.shape = extra.shape;
  if (extra.fingers) h.fingers = extra.fingers;
  if (extra.onVolume && type !== 'volume') h.onVolume = extra.onVolume;
  return h;
}

/** Stable content hash: what the climb is (holds, wall, colour) — not its name, id or grade. */
export function draftHash(b: BoulderDef): string {
  const hs = [...b.holds].sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
  let s = `${b.wallAngle}|${b.color}|${b.startFeet?.LF ?? ''},${b.startFeet?.RF ?? ''}`;
  if (b.profile) s += `|p${b.profile.map((p) => `${r3(p.y0)}:${r3(p.angle)}`).join(',')}`;
  // the wall's surface length (only when it differs from the standard wall: older hashes stay valid)
  if (Number.isFinite(b.height) && Math.abs(b.height - WALL.defaultLength) > 1e-6) s += `|L${r3(b.height)}`;
  for (const h of hs) {
    s += `|${h.id}:${r3(h.x)},${r3(h.y)},${h.type},${r3(h.size)},${r3(h.angle)},${h.role},${h.seed}`;
    // product details change the climb too (grip, shape); mounted holds name their volume
    if (h.shape) s += `,${h.shape}`;
    if (h.edgeDepthMm !== undefined) s += `,d${r3(h.edgeDepthMm)}`;
    if (h.lipAngle !== undefined) s += `,l${r3(h.lipAngle)}`;
    if (h.fingers !== undefined) s += `,f${h.fingers}`;
    if (h.onVolume) s += `,@${h.onVolume}`;
  }
  return hashString(s).toString(36) + hs.length.toString(36);
}

// ───────────────────────────── geometry rules ─────────────────────────────
//
// Footprints are capsules fitted to each product's real geometry (catalog.ts extentOf): a rail is long
// and thin, a pinch tall, a jug round. Holds bolted onto a volume (onVolume) live inside that volume's
// outline on the wall (volumeShape) and only keep clear of their siblings; the volume and its holds move,
// turn and scale together (transformVolume).

/** What placement needs to know about a hold (a whole HoldDef works). */
export type Proto = Pick<HoldDef, 'type' | 'size'> & Partial<Pick<HoldDef, 'id' | 'angle' | 'shape' | 'seed' | 'fingers' | 'onVolume'>>;

/** A placed spot: the wall point, and the volume it is bolted onto (if any). */
export type Spot = Vec2 & { onVolume?: string };

interface Capsule {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  /** Axis-aligned half extents (bounds). */
  ex: number;
  ey: number;
}

/** Footprint capsule of `h` centred on p (default: the hold's own position). */
export function capsuleOf(h: Proto, p: Vec2 = h as unknown as Vec2): Capsule {
  const e = extentOf({ type: h.type, shape: h.shape, seed: h.seed ?? 0, fingers: h.fingers });
  const s = h.size;
  const a = h.angle ?? -Math.PI / 2;
  // hold-local x (along the grip side) and y (toward it) on the wall (render/holds.ts holdMatrix)
  const long = e.hx >= e.hy;
  const dx = long ? -Math.sin(a) : -Math.cos(a);
  const dy = long ? Math.cos(a) : -Math.sin(a);
  const half = Math.abs(e.hx - e.hy) * s;
  // holds taper toward their ends: the capsule hugs the body a touch inside the max extents
  const r = Math.min(e.hx, e.hy) * s * 0.92;
  return { ax: p.x - dx * half, ay: p.y - dy * half, bx: p.x + dx * half, by: p.y + dy * half, r, ex: Math.abs(dx) * half + r, ey: Math.abs(dy) * half + r };
}

/** Outer footprint radius (m): rings, ripples, touch targets. */
export function footprint(h: Proto): number {
  const e = extentOf({ type: h.type, shape: h.shape, seed: h.seed ?? 0, fingers: h.fingers });
  return Math.max(e.hx, e.hy) * h.size;
}

function segSegDist(c: Capsule, d: Capsule): number {
  const pd = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const ux = bx - ax;
    const uy = by - ay;
    const l2 = ux * ux + uy * uy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ux + (py - ay) * uy) / l2));
    return Math.hypot(px - ax - ux * t, py - ay - uy * t);
  };
  // proper intersection of the two segments
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number): number => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(c.ax, c.ay, c.bx, c.by, d.ax, d.ay);
  const d2 = cross(c.ax, c.ay, c.bx, c.by, d.bx, d.by);
  const d3 = cross(d.ax, d.ay, d.bx, d.by, c.ax, c.ay);
  const d4 = cross(d.ax, d.ay, d.bx, d.by, c.bx, c.by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pd(c.ax, c.ay, d.ax, d.ay, d.bx, d.by), pd(c.bx, c.by, d.ax, d.ay, d.bx, d.by), pd(d.ax, d.ay, c.ax, c.ay, c.bx, c.by), pd(d.bx, d.by, c.ax, c.ay, c.bx, c.by));
}

/** Edge-to-edge gap between two footprints (negative = overlapping). */
export function capsuleGap(a: Proto, pa: Vec2, b: Proto, pb: Vec2): number {
  const c = capsuleOf(a, pa);
  const d = capsuleOf(b, pb);
  return segSegDist(c, d) - c.r - d.r;
}

/** Round footprint radius ÷ size per type (the generator's spacing model; validation's lenient check). */
const ROUND: Readonly<Record<HoldType, number>> = { jug: 1.1, edge: 1.35, crimp: 1.45, sloper: 1.05, pinch: 1.25, pocket: 1.1, foot: 1.25, volume: 1 };
const roundRadius = (h: Proto): number => h.size * ROUND[h.type];

/** A hold and the volume it is bolted onto never collide with each other. */
const mountPair = (a: Proto, b: Proto): boolean => (!!a.onVolume && a.onVolume === b.id) || (!!b.onVolume && b.onVolume === a.id);

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Where the centre of a hold may sit on the wall. */
export function holdBounds(b: Pick<BoulderDef, 'width' | 'height'>, h: Proto): Bounds {
  const c = capsuleOf(h, { x: 0, y: 0 });
  const sideX = Math.max(0.05, c.ex * 0.9 + 0.02);
  const sideY = Math.max(0.05, c.ey * 0.9 + 0.02);
  return {
    x0: -b.width / 2 + sideX,
    x1: b.width / 2 - sideX,
    y0: Math.max(EDITOR.floorY, 0.26 + c.ey * 0.6),
    y1: b.height - sideY,
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

/**
 * Edge-to-edge clearance between a prospective hold at p and its nearest neighbour (Infinity if alone).
 * Skips `ignore` (ids), the hold itself, and its mount partner (its volume / the volume's own holds).
 */
export function clearanceAt(holds: readonly HoldDef[], p: Vec2, h: Proto, ignore?: string | ReadonlySet<string>): number {
  const c = capsuleOf(h, p);
  let g = Infinity;
  for (const o of holds) {
    if (o.id === h.id || (typeof ignore === 'string' ? o.id === ignore : ignore?.has(o.id))) continue;
    if (mountPair(h, o)) continue;
    const d = capsuleOf(o);
    const gap = segSegDist(c, d) - c.r - d.r;
    if (gap < g) g = gap;
  }
  return g;
}

// ── volumes ──

/** A volume's base on the wall, for bolting holds onto it. */
export interface VolumeShape {
  /** Convex outline of the volume's base (wall-local, m). */
  outline: Vec2[];
  /** Height of the volume's surface above the wall at wall point p (m; 0 off it). */
  lift(p: Vec2): number;
}

let shapeProvider: ((vol: HoldDef) => VolumeShape | null) | null = null;

/**
 * Exact volume shapes (the editor installs the renderer's geometry, editor/shapes.ts). Without one (the
 * analysis worker, tests) a volume is the ellipse of its extents.
 */
export function setVolumeShapes(fn: ((vol: HoldDef) => VolumeShape | null) | null): void {
  shapeProvider = fn;
}

function ellipseShape(vol: HoldDef): VolumeShape {
  const e = extentOf(vol);
  const t = vol.angle + Math.PI / 2;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const rx = e.hx * vol.size;
  const ry = e.hy * vol.size;
  const outline: Vec2[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const lx = Math.cos(a) * rx;
    const ly = Math.sin(a) * ry;
    outline.push({ x: vol.x + lx * c - ly * s, y: vol.y + lx * s + ly * c });
  }
  return {
    outline,
    lift: (p) => {
      const dx = p.x - vol.x;
      const dy = p.y - vol.y;
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      const q = (lx / rx) ** 2 + (ly / ry) ** 2;
      return q >= 1 ? 0 : vol.size * 0.55 * (1 - q);
    },
  };
}

export function volumeShape(vol: HoldDef): VolumeShape {
  return (shapeProvider && shapeProvider(vol)) || ellipseShape(vol);
}

/** Signed distance from p to the inside of a convex polygon's boundary (positive inside). */
export function insideDistance(poly: readonly Vec2[], p: Vec2): number {
  const n = poly.length;
  if (n < 3) return -Infinity;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const sgn = area >= 0 ? 1 : -1;
  let d = Infinity;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const l = Math.hypot(ex, ey) || 1;
    // inward normal
    const nx = (-ey / l) * sgn;
    const ny = (ex / l) * sgn;
    const di = (p.x - a.x) * nx + (p.y - a.y) * ny;
    if (di < d) d = di;
  }
  return d;
}

/** Push p inside a convex polygon until it is `inset` from every edge (null when the polygon is too small). */
function pushInside(poly: readonly Vec2[], p: Vec2, inset: number): Vec2 | null {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += poly[i].x * poly[(i + 1) % n].y - poly[(i + 1) % n].x * poly[i].y;
  const sgn = area >= 0 ? 1 : -1;
  const q = { x: p.x, y: p.y };
  for (let it = 0; it < 6; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const l = Math.hypot(ex, ey) || 1;
      const nx = (-ey / l) * sgn;
      const ny = (ex / l) * sgn;
      const di = (q.x - a.x) * nx + (q.y - a.y) * ny;
      if (di < inset) {
        q.x += nx * (inset - di);
        q.y += ny * (inset - di);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return insideDistance(poly, q) >= inset - 1e-4 ? q : null;
}

/** How far inside its volume's outline a mounted hold's centre stays (most of the hold on the face). */
export function mountInset(h: Proto): number {
  return clamp(capsuleOf(h, { x: 0, y: 0 }).r * 0.6 + 0.008, 0.012, 0.05);
}

/** The volume whose base contains wall point p (holds bolt onto it), skipping `skipId`. */
export function volumeAt(b: BoulderDef, p: Vec2, skipId?: string): HoldDef | null {
  let best: HoldDef | null = null;
  let bd = -Infinity;
  for (const v of b.holds) {
    if (v.type !== 'volume' || v.id === skipId) continue;
    const d = insideDistance(volumeShape(v).outline, p);
    if (d >= 0 && d > bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/** Holds bolted onto volume `id`. */
export const mountsOf = (b: BoulderDef, id: string): HoldDef[] => b.holds.filter((h) => h.onVolume === id);

/** Is a hold at p, bolted onto `vol`, inside its face and clear of the other holds? */
function mountFits(b: BoulderDef, vol: HoldDef, p: Vec2, h: Proto, ignore?: string): boolean {
  const ph = { ...h, onVolume: vol.id };
  if (insideDistance(volumeShape(vol).outline, p) < mountInset(ph) - 1e-4) return false;
  return clearanceAt(b.holds, p, ph, ignore) >= EDITOR.clearance;
}

export function fits(b: BoulderDef, p: Vec2, h: Proto, ignoreId?: string): boolean {
  if (h.onVolume && h.type !== 'volume') {
    const vol = b.holds.find((v) => v.id === h.onVolume && v.type === 'volume');
    if (vol) return mountFits(b, vol, p, h, ignoreId);
  }
  const wall = { ...h, onVolume: undefined };
  // (spots are rounded to the mm: half a mm of rounding past a bound is fine)
  return inBounds(p, holdBounds(b, wall), 6e-4) && clearanceAt(b.holds, p, wall, ignoreId) >= EDITOR.clearance;
}

/**
 * Can volume `vol` sit at `to` with its holds (moved along with it)? The group keeps clear of every other
 * hold; the volume's own holds are part of it.
 */
export function groupFits(b: BoulderDef, vol: HoldDef, to: Vec2): boolean {
  const mounts = mountsOf(b, vol.id);
  const skip = new Set<string>([vol.id, ...mounts.map((m) => m.id)]);
  if (!inBounds(to, holdBounds(b, vol), 6e-4) || clearanceAt(b.holds, to, vol, skip) < EDITOR.clearance) return false;
  const dx = to.x - vol.x;
  const dy = to.y - vol.y;
  for (const m of mounts) if (clearanceAt(b.holds, { x: m.x + dx, y: m.y + dy }, { ...m, onVolume: undefined }, skip) < EDITOR.clearance) return false;
  return true;
}

/**
 * Best legal spot for a hold near `want`. A (non-volume) hold wanted on a volume's face is bolted onto
 * it (free placement on the face, clear of its siblings). Otherwise: the nearest free T-nut (snap) or
 * the nearest free point (free mode, pushed out of neighbours); a volume brings its holds along.
 * null when nothing fits within `searchRadius`.
 */
export function findSpot(
  b: BoulderDef,
  want: Vec2,
  h: Proto,
  opts: { snap: boolean; ignoreId?: string; searchRadius?: number; mount?: boolean } = { snap: true },
): Spot | null {
  const radius = opts.searchRadius ?? 0.3;
  const ignore = opts.ignoreId ?? h.id;
  if (h.type !== 'volume' && opts.mount !== false) {
    const vol = volumeAt(b, want, h.id);
    if (vol) return mountSpot(b, vol, want, h, radius, ignore);
  }
  const wall: Proto = { ...h, onVolume: undefined };
  const group = h.type === 'volume' && h.id ? b.holds.find((v) => v.id === h.id) : undefined;
  const ok = (p: Vec2): boolean => (group && mountsOf(b, group.id).length ? groupFits(b, { ...group, ...wall } as HoldDef, p) : fits(b, p, wall, ignore));
  const bd = holdBounds(b, wall);
  if (opts.snap) {
    const c = clampToBounds(want, bd);
    for (const t of tnutsNear(c, radius + 0.15)) {
      if (Math.hypot(t.x - want.x, t.y - want.y) > radius + 0.15) continue;
      if (ok(t)) return t;
    }
    return null;
  }
  let p = clampToBounds(want, bd);
  const skip = group ? new Set<string>([group.id, ...mountsOf(b, group.id).map((m) => m.id)]) : null;
  for (let iter = 0; iter < 8; iter++) {
    let worst: HoldDef | null = null;
    let wg: number = EDITOR.clearance;
    for (const o of b.holds) {
      if (o.id === ignore || skip?.has(o.id) || mountPair(wall, o)) continue;
      const g = capsuleGap(wall, p, o, o);
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
    const need = EDITOR.clearance + 0.002 - wg;
    p = clampToBounds({ x: p.x + (dx / l) * need, y: p.y + (dy / l) * need }, bd);
  }
  // to the mm, rounded into the bounds
  const out = {
    x: clamp(r3(p.x), Math.ceil(bd.x0 * 1000 - 1e-6) / 1000, Math.floor(bd.x1 * 1000 + 1e-6) / 1000),
    y: clamp(r3(p.y), Math.ceil(bd.y0 * 1000 - 1e-6) / 1000, Math.floor(bd.y1 * 1000 + 1e-6) / 1000),
  };
  if (Math.hypot(out.x - want.x, out.y - want.y) > radius) return null;
  return ok(out) ? out : null;
}

/** A free spot on `vol`'s face near `want` for hold h (bolted onto it), or null. */
function mountSpot(b: BoulderDef, vol: HoldDef, want: Vec2, h: Proto, radius: number, ignore?: string): Spot | null {
  const shape = volumeShape(vol);
  const ph: Proto = { ...h, onVolume: vol.id };
  const inset = mountInset(ph);
  let p = pushInside(shape.outline, want, inset);
  if (!p) return null;
  for (let iter = 0; iter < 8; iter++) {
    let worst: HoldDef | null = null;
    let wg: number = EDITOR.clearance;
    for (const o of b.holds) {
      if (o.id === ignore || o.id === h.id || mountPair(ph, o)) continue;
      const g = capsuleGap(ph, p, o, o);
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
    const need = EDITOR.clearance + 0.002 - wg;
    const q = pushInside(shape.outline, { x: p.x + (dx / l) * need, y: p.y + (dy / l) * need }, inset);
    if (!q) return null;
    p = q;
  }
  const out = { x: r3(p.x), y: r3(p.y), onVolume: vol.id };
  if (Math.hypot(out.x - want.x, out.y - want.y) <= radius && mountFits(b, vol, out, h, ignore)) return out;
  // boxed in against the face's edge: the nearest free spot on rings around the finger
  for (let r = 0.02; r <= radius + 1e-9; r += 0.02) {
    let best: Spot | null = null;
    let bd = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const q = pushInside(shape.outline, { x: want.x + Math.cos(a) * r, y: want.y + Math.sin(a) * r }, inset);
      if (!q) continue;
      const c = { x: r3(q.x), y: r3(q.y), onVolume: vol.id };
      const d = Math.hypot(c.x - want.x, c.y - want.y);
      if (d < bd && d <= radius && mountFits(b, vol, c, h, ignore)) {
        bd = d;
        best = c;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Move / turn / scale volume `id` and every hold bolted onto it as one piece (the holds keep their place
 * on the face). Mutates the draft; returns false when there is no such volume.
 */
export function transformVolume(b: BoulderDef, id: string, t: { x?: number; y?: number; angle?: number; size?: number }): boolean {
  const vol = b.holds.find((h) => h.id === id && h.type === 'volume');
  if (!vol) return false;
  const x = t.x ?? vol.x;
  const y = t.y ?? vol.y;
  const da = (t.angle ?? vol.angle) - vol.angle;
  const k = t.size !== undefined && vol.size > 0 ? t.size / vol.size : 1;
  const c = Math.cos(da);
  const s = Math.sin(da);
  for (const m of mountsOf(b, id)) {
    const ox = (m.x - vol.x) * k;
    const oy = (m.y - vol.y) * k;
    m.x = r3(x + ox * c - oy * s);
    m.y = r3(y + ox * s + oy * c);
    if (da) m.angle = wrapA(m.angle + da);
  }
  vol.x = r3(x);
  vol.y = r3(y);
  if (t.angle !== undefined) vol.angle = r3(t.angle);
  if (t.size !== undefined) vol.size = r3(t.size);
  return true;
}

const wrapA = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r3(r);
};

/** Remove a hold (a volume takes the holds bolted onto it along). Returns the removed holds. */
export function removeHold(b: BoulderDef, id: string): HoldDef[] {
  const gone = b.holds.filter((h) => h.id === id || h.onVolume === id);
  if (gone.length) b.holds = b.holds.filter((h) => !gone.includes(h));
  return gone;
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
  let unmounted = 0;
  const byId = new Map(b.holds.map((h) => [h.id, h] as const));
  const caps = b.holds.map((h) => capsuleOf(h));
  for (let i = 0; i < b.holds.length; i++) {
    const h = b.holds[i];
    const vol = h.onVolume ? byId.get(h.onVolume) : undefined;
    if (vol && vol.type === 'volume') {
      // bolted onto a volume: it must sit on that volume's face
      if (insideDistance(volumeShape(vol).outline, h) < -EDITOR.mountTolerance) {
        flagged.add(h.id);
        unmounted++;
      }
    } else if (!inBounds(h, holdBounds(b, { ...h, onVolume: undefined }), 0.012)) {
      flagged.add(h.id);
      off++;
    }
    for (let j = i + 1; j < b.holds.length; j++) {
      const o = b.holds[j];
      if (mountPair(h, o)) continue;
      // only clear collisions: the tight capsule footprints AND the generous round ones both overlap
      // well past the tolerance (generated problems — the game's own reference — always pass)
      const ca = caps[i];
      const cb = caps[j];
      if (segSegDist(ca, cb) - ca.r - cb.r >= -EDITOR.overlapTolerance * Math.min(ca.r, cb.r) * 2) continue;
      const ra = roundRadius(h);
      const rb = roundRadius(o);
      if (Math.hypot(h.x - o.x, h.y - o.y) - ra - rb < -EDITOR.overlapTolerance * Math.min(ra, rb) * 2) {
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
      fix: overlaps > 0 ? 'Separate overlapping holds' : unmounted > 0 ? 'Move holds back onto their volume' : 'Move holds onto the wall',
      short: overlaps > 0 ? 'Overlapping' : unmounted > 0 ? 'Off its volume' : 'Off the wall',
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
  /** Multi-angle panels, surface length and style (wall presets and panel edits are undoable). */
  profile?: WallPanel[];
  height: number;
  style?: RouteStyle;
}

export function snapshotOf(b: BoulderDef): Snapshot {
  const s: Snapshot = { holds: b.holds.map((h) => ({ ...h })), wallAngle: b.wallAngle, color: b.color, height: b.height };
  if (b.startFeet) s.startFeet = { ...b.startFeet };
  if (b.profile) s.profile = b.profile.map((p) => ({ ...p }));
  if (b.style) s.style = b.style;
  return s;
}

export function applySnapshot(b: BoulderDef, s: Snapshot): void {
  b.holds = s.holds.map((h) => ({ ...h }));
  b.wallAngle = s.wallAngle;
  b.color = s.color;
  b.height = s.height;
  if (s.startFeet) b.startFeet = { ...s.startFeet };
  else delete b.startFeet;
  if (s.profile) b.profile = s.profile.map((p) => ({ ...p }));
  else delete b.profile;
  if (s.style) b.style = s.style;
  else delete b.style;
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

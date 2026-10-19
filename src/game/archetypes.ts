// Route archetypes (Phase B, docs/ROADMAP.md B1/B4/B5; research §3.2–§3.5): which kind of problem to set,
// on which wall, with which holds — and how a run of problems rotates through them so consecutive
// problems feel different. Pure and deterministic (dmath only): the generator calls it with its seeded Rng.
//
//  style        wall (flat unless GEN.profiles)              line / moves
//  vertical     0–5°                                         a meandering ladder
//  slab         −8 … −15°                                    small hands, many feet, balance
//  overhang     20–45° by grade                              jugs, pinches, toe-pull feet
//  cave         kicker → 25–35° → 65–88° roof → lip (profile) roof jugs + hooks, top on the lip
//  traverse     any                                          across the wall (top on the far side)
//  zigzag       any                                          headings alternate ±(31–40)°
//  diagonal     any                                          a rising line 30–50° off vertical
//  dyno         0–25°                                        one throw ≥ the static reach to a good hold
//  compression  20–45°                                       wide squeezes: pinches, inward sidepulls, volumes
//  mixed        multi-angle profile (wave / kick / bulge), or flat with a mixed hold set

import type { HoldDef, HoldShape, HoldType, RouteStyle, WallPanel } from '../core/types';
import { hashString, Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import { DEG } from '../core/math';
import { dcos, dsin } from './dmath';
import { SIM } from '../config/tuning';

/** Every archetype, in a fixed order (decks, tests). */
export const STYLES: readonly RouteStyle[] = ['vertical', 'slab', 'overhang', 'cave', 'traverse', 'zigzag', 'diagonal', 'dyno', 'compression', 'mixed'];

/** Archetypes that only exist on a multi-angle wall (GEN.profiles). */
export const PROFILE_STYLES: readonly RouteStyle[] = ['cave'];

/** Natural weights by grade band [V0–1, V2, V3–5, V6–8, V9+] (research §3.4 grade bands + archetypes). */
const STYLE_W: Record<RouteStyle, readonly [number, number, number, number, number]> = {
  vertical: [3, 2.2, 1.4, 0.9, 0.5],
  slab: [2.2, 2, 1.3, 1, 0.7],
  overhang: [1, 1.5, 2, 2.4, 2.6],
  cave: [0, 0.4, 1, 1.4, 1.8],
  traverse: [1.4, 1.4, 1.1, 0.9, 0.6],
  zigzag: [1, 1.2, 1.1, 1, 0.9],
  diagonal: [1.2, 1.3, 1.1, 1, 0.9],
  dyno: [0, 0.5, 1, 1.2, 1.3],
  compression: [0, 0.4, 1, 1.4, 1.6],
  mixed: [0.4, 0.8, 1.2, 1.4, 1.4],
};

const band = (g: number): number => (g <= 1 ? 0 : g <= 2 ? 1 : g <= 5 ? 2 : g <= 8 ? 3 : 4);

/** The archetypes that can be set right now (cave only with profiles). */
export function availableStyles(profiles: boolean): RouteStyle[] {
  return STYLES.filter((s) => profiles || !PROFILE_STYLES.includes(s));
}

/** A style that can't be set without profiles falls back to its closest flat relative. */
export function flatFallback(style: RouteStyle, profiles: boolean): RouteStyle {
  if (profiles || !PROFILE_STYLES.includes(style)) return style;
  return 'overhang';
}

/** Archetype for a single problem: weighted by grade. */
export function pickStyle(grade: number, rng: Rng, profiles: boolean): RouteStyle {
  const styles = availableStyles(profiles);
  const b = band(grade);
  return rng.weighted(
    styles,
    styles.map((s) => STYLE_W[s][b]),
  );
}

/** Send Train: the first problems of a run (V0–V2) skip the archetypes that need technique. */
const EARLY_SKIP: readonly RouteStyle[] = ['dyno', 'compression', 'cave'];
const EARLY_RUN = 3;

/**
 * Send Train rotation: the archetype of problem `index` of the run seeded `seed`. Each block of problems
 * deals the available archetypes in a seeded order (a deck), so the run cycles through all of them; a
 * problem never repeats the archetype of the one before it (nor, when the deck allows, of the one before
 * that), and the first EARLY_RUN problems skip the technical ones. Deterministic in (seed, index).
 */
export function runStyle(seed: number, index: number, profiles: boolean): RouteStyle {
  const styles = availableStyles(profiles);
  const n = styles.length;
  const seq: RouteStyle[] = [];
  const deck = (block: number): RouteStyle[] => new Rng(hashString(`run-deck:${seed >>> 0}:${block}`)).shuffle(styles.slice());
  let cur: RouteStyle[] = deck(0);
  let curBlock = 0;
  const used = new Set<RouteStyle>();
  const last = Math.max(0, Math.floor(index));
  for (let i = 0; i <= last; i++) {
    const block = Math.floor(i / n);
    if (block !== curBlock) {
      curBlock = block;
      cur = deck(block);
      used.clear();
    }
    const prev = seq[i - 1];
    const prev2 = seq[i - 2];
    const ok = (s: RouteStyle, strict: boolean): boolean =>
      s !== prev && (!strict || s !== prev2) && !(i < EARLY_RUN && EARLY_SKIP.includes(s));
    // deal the next card of the deck that fits; the deck order is the rotation
    let pick: RouteStyle | null = null;
    for (const strict of [true, false]) {
      for (const s of cur) {
        if (used.has(s) || !ok(s, strict)) continue;
        pick = s;
        break;
      }
      if (pick) break;
      for (const s of cur) {
        if (!ok(s, strict)) continue;
        pick = s;
        break;
      }
      if (pick) break;
    }
    pick ??= styles.find((s) => s !== prev) ?? styles[0];
    used.add(pick);
    seq.push(pick);
  }
  return seq[last];
}

/**
 * Daily Boulder archetype by UTC weekday (and week parity), so consecutive days always differ:
 * Mon vertical / mixed · Tue slab · Wed traverse · Thu zigzag / diagonal · Fri dyno · Sat compression ·
 * Sun cave (profiles) / overhang. Matches dailyGrade's weekly curve (V2 … V7).
 */
export function dailyStyle(dateKey: string, profiles: boolean): RouteStyle {
  const d = new Date(`${dateKey}T12:00:00Z`);
  const t = d.getTime();
  const wd = Number.isNaN(t) ? 3 : d.getUTCDay();
  const week = Number.isNaN(t) ? 0 : Math.floor(t / (7 * 86400000));
  const odd = (week & 1) === 1;
  switch (wd) {
    case 0:
      return profiles ? 'cave' : 'overhang';
    case 1:
      return odd ? 'mixed' : 'vertical';
    case 2:
      return 'slab';
    case 3:
      return 'traverse';
    case 4:
      return odd ? 'diagonal' : 'zigzag';
    case 5:
      return 'dyno';
    default:
      return 'compression';
  }
}

// ═══════════════════════════════ walls ═══════════════════════════════

const ANGLES = [-8, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45] as const;

/** Wall angle by grade for lines on any wall (research §6.7: V0–2 −10…20, V3–5 0…35, V6–8 20…50, V9+ 30…60). */
function gradeAngle(grade: number, rng: Rng): number {
  let w: number[];
  if (grade <= 2) w = [1, 4, 2.5, 2, 1, 0.5, 0, 0, 0, 0, 0];
  else if (grade <= 5) w = [0.6, 1.2, 1.2, 2, 2.2, 1.8, 1.2, 0.8, 0.3, 0, 0];
  else if (grade <= 8) w = [0, 0.3, 0.4, 0.8, 1.4, 2, 2, 1.8, 1.2, 0.8, 0.4];
  else w = [0, 0, 0.2, 0.4, 0.8, 1.4, 2, 2, 1.8, 1.4, 1];
  return rng.weighted(ANGLES, w);
}

/** Flat wall angle (degrees) for a boulder of `style` (cave: its flat fallback, a steep overhang). */
export function styleAngle(style: RouteStyle, grade: number, rng: Rng): number {
  switch (style) {
    case 'vertical':
      return rng.weighted([0, 3, 5], [3, 1.5, 1]);
    case 'slab':
      return grade <= 2 ? rng.weighted([-8, -10, -12], [3, 2, 1]) : rng.weighted([-8, -10, -12, -15], [1.5, 2, 2, 1.2]);
    case 'overhang':
    case 'cave':
      if (grade <= 2) return 20;
      if (grade <= 5) return rng.weighted([20, 25, 30, 35], [2, 2.5, 2, 1]);
      if (grade <= 8) return rng.weighted([25, 30, 35, 40, 45], [1, 2, 2.5, 2, 1]);
      return rng.weighted([30, 35, 40, 45], [1, 2, 2.5, 2.5]);
    case 'dyno':
      return grade <= 4 ? rng.weighted([0, 5, 10, 15], [2, 2, 1.5, 1]) : rng.weighted([0, 5, 10, 15, 20, 25], [1, 1.5, 2, 2, 1.5, 1]);
    case 'compression':
      if (grade <= 2) return rng.weighted([15, 20], [1, 1]);
      if (grade <= 5) return rng.weighted([20, 25, 30, 35], [2, 2, 1.5, 1]);
      return rng.weighted([25, 30, 35, 40, 45], [1, 2, 2, 1.5, 1]);
    default:
      return gradeAngle(grade, rng);
  }
}

/** Lead Tower flat angle (degrees): research lead walls are 15–60° (≈30° average); a flat 15 m tower stays ≤ 25°. */
export function leadAngle(grade: number, rng: Rng): number {
  if (grade <= 2) return rng.weighted([0, 5, 10], [1.5, 2, 1.5]);
  if (grade <= 5) return rng.weighted([5, 10, 15, 20], [1, 2, 2, 1.2]);
  return rng.weighted([10, 15, 20, 25], [1, 2, 2, 1.4]);
}

/** A multi-angle wall: panels (y0 along the surface, angle) and its surface length. */
export interface ProfileSpec {
  panels: WallPanel[];
  length: number;
  /** Short name of the shape ('CAVE', 'WAVE', 'KICK', 'BULGE', 'STEP', 'TOWER'). */
  kind: string;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Panels from [length, angle] pairs (lengths rounded to mm). */
function stack(spec: [number, number][], kind: string): ProfileSpec {
  const panels: WallPanel[] = [];
  let y = 0;
  for (const [len, angle] of spec) {
    panels.push({ y0: r3(y), angle: Math.round(angle) });
    y += r3(len);
  }
  return { panels, length: r3(y), kind };
}

/** Height (m) a stack of [length, angle] panels reaches. */
function stackHeight(spec: [number, number][]): number {
  let h = 0;
  for (const [len, a] of spec) h += len * dcos(a * DEG);
  return h;
}

/** Make the last panel long enough for the wall to stand `height` m tall (within [lo, hi] of surface). */
function topUp(spec: [number, number][], height: number, lo: number, hi: number): void {
  const last = spec[spec.length - 1];
  const below = stackHeight(spec.slice(0, -1));
  const c = dcos(last[1] * DEG);
  last[0] = clamp(c > 0.05 ? (height - below) / c : lo, lo, hi);
}

/**
 * Multi-angle boulder wall for `style` (null when the style sets a flat wall). Research §3.2 presets with
 * seeded variation; a boulder stands ≈4.4 m tall at most (caves are low: ≈2.3–3.5 m to the lip).
 */
export function styleProfile(style: RouteStyle, grade: number, rng: Rng): ProfileSpec | null {
  if (style === 'cave') {
    const roof = grade <= 3 ? rng.range(65, 75) : grade <= 7 ? rng.range(70, 85) : rng.range(78, 88);
    return stack(
      [
        [0.3, 0],
        [rng.range(1.35, 1.7), rng.range(25, 35)],
        [rng.range(1.8, 2.3), roof],
        [rng.range(0.55, 0.7), rng.range(12, 25)],
      ],
      'CAVE',
    );
  }
  if (style === 'mixed') {
    const kinds = grade <= 2 ? ['STEP', 'BULGE', 'WAVE'] : grade <= 5 ? ['WAVE', 'BULGE', 'STEP', 'KICK'] : ['WAVE', 'KICK', 'BULGE'];
    const w = grade <= 2 ? [2, 1.5, 1] : grade <= 5 ? [2, 1.5, 1, 1] : [2, 2, 1];
    const kind = rng.weighted(kinds, w);
    let spec: [number, number][];
    switch (kind) {
      case 'WAVE': {
        const a1 = grade <= 2 ? rng.range(10, 15) : rng.range(15, 25);
        const a2 = grade <= 2 ? rng.range(20, 25) : grade <= 5 ? rng.range(30, 40) : rng.range(35, 45);
        spec = [
          [0.3, 0],
          [rng.range(1.9, 2.3), a1],
          [2.5, a2],
        ];
        break;
      }
      case 'KICK':
        spec = [
          [0.3, 0],
          [rng.range(1.8, 2.2), rng.range(25, 35)],
          [2.6, grade <= 6 ? rng.range(45, 55) : rng.range(50, 60)],
        ];
        break;
      case 'BULGE':
        spec = [
          [rng.range(1.4, 1.8), rng.range(0, 5)],
          [rng.range(1.0, 1.3), grade <= 2 ? rng.range(20, 28) : rng.range(30, 40)],
          [1.8, rng.range(-8, -3)],
        ];
        break;
      default:
        // STEP: a slab that rears up into an overhang
        spec = [
          [rng.range(1.8, 2.2), rng.range(-12, -6)],
          [2.4, grade <= 2 ? rng.range(8, 15) : rng.range(12, 22)],
        ];
    }
    topUp(spec, rng.range(4.25, 4.45), 0.9, 3.6);
    return stack(spec, kind);
  }
  return null;
}

/**
 * Lead Tower profile (GEN.profiles): a vertical start, an overhanging headwall that steepens, a roof crux
 * (45° easy … 60°+ hard) at 55–75 % of the height, a transition panel over its lip when the fold is big,
 * and a less steep finish to the anchor (research §3.2 lead tower, §3.5 template).
 * The surface is `length` m long (the sim's y extent; GAME.ropeWall.height), so the world height is lower.
 */
export function leadProfile(grade: number, rng: Rng, length: number): ProfileSpec {
  const steep = clamp(grade / 10, 0, 1);
  const spec: [number, number][] = [
    [rng.range(2.4, 3.0), rng.range(0, 5)],
    [rng.range(2.6, 3.4), lerp(10, 18, steep) + rng.range(-3, 3)],
    [rng.range(2.4, 3.2), lerp(18, 32, steep) + rng.range(-3, 3)],
    // the roof crux: 45° at the easy end, a 60°+ roof at the hard end (research §3.2 tower: [2.0, 60])
    [rng.range(1.3, 1.8), lerp(45, 63, steep) + rng.range(-3, 2)],
  ];
  // the roof crux starts at 55–75 % of the route; the finish panel takes the rest
  const sofar = spec.reduce((a, s) => a + s[0], 0) - spec[3][0];
  const want = length * rng.range(0.56, 0.68);
  spec[2][0] = clamp(spec[2][0] + (want - sofar), 1.6, 4.2);
  // over the roof's lip: a convex fold of more than ~25° is turned in two steps (a short transition
  // panel), as on real towers — a single 40° lip would leave the feet hanging under the roof
  const crux = spec[3][1];
  const finish = lerp(14, 28, steep) + rng.range(-3, 3);
  if (crux - finish > 25) spec.push([rng.range(0.8, 1.1), (crux + finish) / 2]);
  // the finish panel lands the surface exactly on `length` (stack rounds each panel to mm)
  const used = spec.reduce((a, s) => a + r3(s[0]), 0);
  spec.push([Math.max(1.5, r3(length - used)), finish]);
  return stack(spec, 'TOWER');
}

// ═══════════════════════════════ holds ═══════════════════════════════

/** Hand-hold type weights [jug, edge, crimp, sloper, pinch, pocket] by grade, wall angle and style. */
export function handTypeWeights(grade: number, angle: number, style: RouteStyle): number[] {
  let w: number[];
  if (grade <= 1) w = [8, 2, 0, 0, 0, 0];
  else if (grade <= 3) w = [5, 4, 0, 0.5, 1, 1];
  else if (grade <= 5) w = [2.5, 4, 1.5, 1, 1.5, 1];
  else if (grade <= 8) w = [1.2, 3, 2.5, 1.5, 1.5, 1];
  else w = [0.6, 2.5, 3, 2, 1.5, 1];
  const s = Math.max(0, angle) / 40;
  w[0] *= 1 + 1.6 * s; // jug
  w[1] *= 1 + 0.3 * s; // edge
  w[2] *= Math.max(0.05, 1 - 0.65 * s); // crimp
  w[3] *= Math.max(0.05, 1 - 0.75 * s); // sloper
  w[4] *= 1 + 0.5 * s; // pinch
  if (angle < 0) {
    w[3] *= 1.5;
    w[2] *= 1.3;
    w[0] *= 0.8;
  }
  switch (style) {
    case 'slab':
      // balance on small edges and slopey pads: few jugs
      w[0] *= 0.55;
      w[1] *= 1.2;
      w[3] *= 1.4;
      break;
    case 'compression':
      w[4] *= 3; // pinches
      w[3] *= 1.3;
      w[2] *= 0.3;
      w[5] *= 0.4;
      break;
    case 'cave':
      w[0] *= 1.6;
      w[4] *= 1.5;
      w[2] *= 0.3;
      w[5] *= 0.5;
      break;
    case 'mixed':
      // a bit of everything: flatten the weights toward uniform
      for (let i = 0; i < 6; i++) w[i] = w[i] * 0.6 + 0.8;
      break;
    case 'dyno':
      w[0] *= 1.3;
      break;
    default:
  }
  return w;
}

export interface DressContext {
  grade: number;
  /** Panel angle (degrees) the hold is bolted to. */
  angle: number;
  style: RouteStyle;
  /** Route (true) or another route's deco hold. */
  route: boolean;
  /** The hold's role (start / top holds stay friendly: no dual-tex, no wood). */
  role?: HoldDef['role'];
}

/** Edge depth (mm) an edge / crimp of radius `size` has without an explicit value (SIM.edgeDepthBySize). */
function derivedDepth(type: 'edge' | 'crimp' | 'pocket', size: number): number {
  const [s0, s1, m0, m1] = SIM.edgeDepthBySize[type];
  return lerp(m0, m1, clamp((size - s0) / (s1 - s0), 0, 1));
}

/**
 * Product variety for a hold (research §3.3 catalogue): a shape refining its type, plus edge depth / lip
 * angle / pocket fingers in the ranges of its grade band. Grip-relevant fields stay in the band the type
 * already had (the builder verifies every move with them), so variety changes the feel, not the grade.
 * Mutates and returns h. Consumes rng in a fixed order per type (deterministic).
 */
export function dressHold(h: HoldDef, ctx: DressContext, rng: Rng): HoldDef {
  const g = ctx.grade;
  const steep = ctx.angle >= 30;
  let shape: HoldShape | undefined;
  switch (h.type) {
    case 'jug':
      if (h.size >= 0.1 && rng.chance(g <= 4 || steep ? 0.45 : 0.2)) shape = 'bucket';
      break;
    case 'pinch':
      if (rng.chance(ctx.style === 'compression' || ctx.style === 'cave' ? 0.45 : 0.22)) shape = 'horn';
      break;
    case 'edge': {
      const r = rng.next();
      if (r < 0.16) shape = 'rail';
      else if (r < 0.2 && ctx.route) shape = 'dual-tex';
      const depth = derivedDepth('edge', h.size) * rng.range(0.88, 1.12);
      h.edgeDepthMm = Math.round(shape === 'rail' ? clamp(depth, 15, 30) : depth);
      // easy grades get incut edges, hard ones flatter / slightly slopey lips
      h.lipAngle = Math.round(g <= 3 ? rng.range(5, 22) : g <= 7 ? rng.range(-5, 12) : rng.range(-12, 5));
      break;
    }
    case 'crimp': {
      const micro = g >= 7 && rng.chance(g >= 10 ? 0.45 : 0.3);
      if (micro) shape = 'micro';
      const depth = micro ? rng.range(5, 9) : derivedDepth('crimp', h.size) * rng.range(0.9, 1.1);
      h.edgeDepthMm = Math.round(depth);
      h.lipAngle = Math.round(g <= 5 ? rng.range(0, 15) : rng.range(-8, 8));
      break;
    }
    case 'sloper': {
      const r = rng.next();
      if (r < 0.12 && h.size >= 0.1) shape = 'macro';
      else if (r < 0.3) shape = 'dual-tex';
      // research: −20 (friendly) … −40 (hard)
      h.lipAngle = Math.round(lerp(-20, -38, clamp(g / 11, 0, 1)) + rng.range(-4, 4));
      break;
    }
    case 'pocket': {
      // 3–4 fingers at easy grades, 2–3 in the middle, 1–2 (rare monos) at the top
      const f = g <= 3 ? rng.weighted([3, 4], [2, 1]) : g <= 7 ? rng.weighted([2, 3, 4], [1, 2, 0.6]) : rng.weighted([1, 2, 3], [0.6, 2, 1.4]);
      h.fingers = f as 1 | 2 | 3 | 4;
      h.edgeDepthMm = Math.round(derivedDepth('pocket', h.size) * rng.range(0.9, 1.1));
      break;
    }
    case 'foot':
      // tiny screw-on chips are a hard-problem foothold (research §3.4: V6–8 "chips and smears")
      if (rng.chance(g <= 2 ? 0 : g <= 5 ? 0.3 : 0.55)) shape = 'chip';
      break;
    case 'volume':
      if (h.size >= 0.3 && rng.chance(0.35)) shape = 'dual-tex';
      break;
    default:
  }
  // a few wooden holds (lower friction) on mixed problems and on other routes
  if (shape === undefined && h.type !== 'volume' && h.type !== 'foot' && rng.chance(ctx.style === 'mixed' ? 0.12 : ctx.route ? 0.03 : 0.06)) shape = 'wood';
  // start and top holds, and every route hold at V0–V1, keep a plain grip surface (dual-tex's narrow good
  // zone and wood's low friction are for problems that ask for precision)
  if ((shape === 'dual-tex' || shape === 'wood') && ctx.route && (ctx.role === 'start' || ctx.role === 'top' || g <= 1)) shape = undefined;
  if (shape !== undefined) h.shape = shape;
  else delete h.shape;
  return h;
}

/** Shapes of the hand holds of a problem (tests / tools). */
export function shapesOf(holds: readonly HoldDef[]): Partial<Record<HoldShape | HoldType, number>> {
  const out: Partial<Record<HoldShape | HoldType, number>> = {};
  for (const h of holds) {
    const k = h.shape ?? h.type;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** tan of an angle in degrees (deterministic). */
export const dtanDeg = (a: number): number => dsin(a * DEG) / dcos(a * DEG);

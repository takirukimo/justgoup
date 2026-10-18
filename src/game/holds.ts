// Hold rules + grip capacity. Shared by ClimberSim, the static solver, the planner and the generator.

import type { BoulderDef, HoldDef, HoldType, LimbId, QuickdrawDef, Vec2 } from '../core/types';
import { BODY as BODY_, GAME, SIM as SIM_ } from '../config/tuning';
import { clamp as clamp_, DEG } from '../core/math';
import { dcos, dsin } from './dmath';
import { envEval, pointSegDist } from './anatomy';

// Hot path (capacities are evaluated thousands of times per plan): plain module-local bindings
// (some module runners read imported bindings through a getter on every use).
const BODY = BODY_;
const SIM = SIM_;
const clamp = clamp_;

export const LIMB_IDS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];
export const LIMB_INDEX: Readonly<Record<LimbId, number>> = { LH: 0, RH: 1, LF: 2, RF: 3 };
export const isHandIdx = (i: number): boolean => i < 2;

/** Hands may use start / hand / top holds (never foot chips or deco). */
export function usableByHand(h: HoldDef): boolean {
  return (h.role === 'start' || h.role === 'hand' || h.role === 'top') && h.type !== 'foot';
}

/** Feet may use any non-deco hold (hand holds make good footholds). */
export function usableByFoot(h: HoldDef): boolean {
  return h.role !== 'deco';
}

export function usableBy(limbIdx: number, h: HoldDef): boolean {
  return isHandIdx(limbIdx) ? usableByHand(h) : usableByFoot(h);
}

/** Longest reach of a limb in any direction (its envelope's maximum, see anatomy.ts). */
export function maxReachIdx(limbIdx: number): number {
  return isHandIdx(limbIdx) ? BODY.armMax : BODY.legMax;
}

/**
 * Can limb `limbIdx` share `h` with its pair limb (two hands / two feet on one hold)? Matching needs
 * room: no hand matches on a small edge or a one-finger pocket, no two feet on a tiny chip. The top
 * hold can always be matched (that's how a problem is sent).
 */
export function canMatch(limbIdx: number, h: HoldDef): boolean {
  if (isHandIdx(limbIdx)) return h.role === 'top' || h.size >= (h.type === 'pocket' ? 0.06 : 0.045);
  return h.type === 'volume' || h.size >= 0.04;
}

/** Contact of an attached limb, as far as the self-clipping rules care. */
export interface LimbContact {
  x: number;
  y: number;
  hold: HoldDef | null;
}

/** Length (m) of another limb's segment, from its wall end, that a placement must keep clear of. */
const NEAR_SEGMENT = 0.3;

/**
 * Self-clipping rule shared by the sim and the planner: can limb `li` be put on contact point (x, y)
 * of hold `hold` (null = smear) while the other limbs hold `contacts` (null = free) with root joints
 * (ax, ay)? Blocked when
 *  • a hand would grab below every attached foot (less than SIM.handAboveFeet above them),
 *  • the hold is taken by a limb other than the pair limb (hands and feet never share a hold), or by
 *    the pair limb when the hold is too small to match,
 *  • the point is within SIM.handFootGap of a foot (for a hand) / of a hand (for a foot),
 *  • the point lies on another limb's segment near its wall end (within SIM.limbClearance of the last
 *    0.3 m before its contact): the limb would have to pass through it — e.g. a hand slipping under
 *    the other forearm, or a foot under the other shin.
 * Crossing a limb higher up (near its root, away from the wall) is fine: the crossing limb goes in
 * front. The pair limb matching the same hold is exempt.
 */
export function placementBlocked(
  li: number,
  x: number,
  y: number,
  hold: HoldDef | null,
  contacts: readonly (LimbContact | null)[],
  ax: ArrayLike<number>,
  ay: ArrayLike<number>,
  /** Extra clearance (m) on top of the SIM limits (the planner keeps a margin). */
  margin = 0,
): boolean {
  const pair = li ^ 1;
  const hand = isHandIdx(li);
  const gap = SIM.handFootGap + margin;
  const clear = SIM.limbClearance + margin;
  if (hand) {
    // a hand never grabs below both feet (wall up; a tilted torso doesn't change where "down" is)
    let feet = 0;
    let below = 0;
    for (let k = 2; k < 4; k++) {
      const c = contacts[k];
      if (!c) continue;
      feet++;
      if (y < c.y + SIM.handAboveFeet + margin) below++;
    }
    if (feet > 0 && below === feet) return true;
  }
  for (let k = 0; k < 4; k++) {
    if (k === li) continue;
    const c = contacts[k];
    if (!c) continue;
    if (hold && c.hold === hold) {
      if (k === pair && canMatch(li, hold)) continue;
      return true;
    }
    const dx = x - c.x;
    const dy = y - c.y;
    if (isHandIdx(k) !== hand && dx * dx + dy * dy < gap * gap) return true;
    let sx = ax[k] - c.x;
    let sy = ay[k] - c.y;
    const sl = Math.sqrt(sx * sx + sy * sy);
    if (sl > NEAR_SEGMENT) {
      sx *= NEAR_SEGMENT / sl;
      sy *= NEAR_SEGMENT / sl;
    }
    if (pointSegDist(x, y, c.x, c.y, c.x + sx, c.y + sy) < clear) return true;
  }
  return false;
}

/**
 * Grip point of a hold: on the incut side, i.e. slightly away from where the body should be.
 * Two hands matched on one hold are spread along the hold's tangent.
 */
export function contactPoint(h: HoldDef, limbIdx: number, matched: boolean, out: Vec2): Vec2 {
  const ca = dcos(h.angle);
  const sa = dsin(h.angle);
  const inset = h.type === 'volume' ? Math.min(h.size * 0.45, 0.14) : h.size * 0.32;
  let x = h.x - ca * inset;
  let y = h.y - sa * inset;
  if (matched) {
    // tangent = perpendicular to the good direction; left hand on the left side of the hold
    const spread = Math.min(Math.max(h.size * 0.55, 0.035), 0.07);
    const side = limbIdx === 0 || limbIdx === 2 ? -1 : 1;
    // choose the tangent that points to +x
    let tx = -sa;
    let ty = ca;
    if (tx < 0 || (tx === 0 && ty < 0)) {
      tx = -tx;
      ty = -ty;
    }
    x += tx * spread * side;
    y += ty * spread * side;
  }
  out.x = x;
  out.y = y;
  return out;
}

/** Bolt → carabiner point where the rope (and the clipping hand) goes. */
export function clipPoint(q: QuickdrawDef, out: Vec2): Vec2 {
  out.x = q.x;
  out.y = q.y - SIM.quickdrawDrop;
  return out;
}

interface ConeCos {
  ci: number;
  co: number;
  floor: number;
}

function coneCos(c: { inner: number; outer: number; floor: number }): ConeCos {
  return { ci: dcos(c.inner * DEG), co: dcos(Math.min(c.outer, 179.9) * DEG), floor: c.floor };
}

type ConeTable = Record<HoldType, ConeCos>;
const tableOf = (t: Record<HoldType, { inner: number; outer: number; floor: number }>): ConeTable => {
  const out = {} as ConeTable;
  for (const k of Object.keys(t) as HoldType[]) out[k] = coneCos(t[k]);
  return out;
};
const HAND_CONES = tableOf(SIM.handCone);
const FOOT_CONES = tableOf(SIM.footCone);
const SMEAR_CONE = coneCos(SIM.smearCone);

/** Grip quality from the cosine between the pull direction and the hold's good direction. */
function coneQ(cosD: number, c: ConeCos): number {
  let t = (cosD - c.ci) / (c.co - c.ci);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return c.floor + (1 - c.floor) * (1 - t * t * (3 - 2 * t));
}

function sizeFactor(t: HoldType, size: number): number {
  const ref = SIM.refSize[t];
  const range = SIM.refSizeRange[t];
  return 1 + SIM.sizeEffect * clamp((size - ref) / range, -1, 1);
}

export interface GripContext {
  wallAngle: number; // degrees
  assist: number;
  pump: number;
  /** max(0, sin(wallAngle)) */
  overhang: number;
}

/**
 * Hand capacity (fraction of body weight) on `h`. (hx, hy) is the hold's good direction
 * (cos/sin of h.angle); (dx, dy) the unit direction from the grip point to the shoulder.
 * hold type × size × pull-angle quality × overhang factor × match × pump × assist.
 */
export function handCapacity(h: HoldDef, hx: number, hy: number, dx: number, dy: number, matched: boolean, ctx: GripContext): number {
  const t = h.type;
  let cap = SIM.handCap[t] * sizeFactor(t, h.size);
  cap *= coneQ(dx * hx + dy * hy, HAND_CONES[t]);
  if (ctx.overhang > 0) cap *= 1 - SIM.overhangLoss[t] * ctx.overhang;
  if (matched) cap *= SIM.matchFactor;
  cap *= 1 - SIM.pumpCapLoss * ctx.pump * ctx.pump;
  cap *= 1 + SIM.assistCap * ctx.assist;
  return cap;
}

/**
 * Foot capacity on `h` (or a smear when h is null). (dx, dy) is the unit direction from the toe to
 * the hip; feet want the body on the opposite side of the hold's hand direction.
 * `normalPerFoot` < 0 means the feet must toe-pull (overhangs), which costs capacity.
 */
export function footCapacity(h: HoldDef | null, hx: number, hy: number, dx: number, dy: number, normalPerFoot: number, ctx: GripContext): number {
  let cap: number;
  if (h) {
    const t = h.type;
    cap = SIM.footCap[t] * sizeFactor(t, h.size);
    cap *= coneQ(-(dx * hx + dy * hy), FOOT_CONES[t]);
    if (normalPerFoot < 0) cap *= Math.max(SIM.toeMin, 1 + normalPerFoot / SIM.toeScale[t]);
  } else {
    const fric = clamp(1 - ctx.wallAngle / 14, 0.2, 1.25);
    cap = SIM.smearCap * fric * coneQ(dy, SMEAR_CONE);
    cap *= clamp(0.8 + normalPerFoot * 1.4, 0.15, 1.3);
  }
  cap *= 1 + SIM.assistCap * ctx.assist;
  return cap;
}

/** Ideal (best-direction) capacity of a hold for a limb kind, ignoring body position. */
export function nominalCapacity(h: HoldDef, hand: boolean, wallAngle: number): number {
  const t = h.type;
  if (hand) {
    const s = Math.max(0, dsin(wallAngle * DEG));
    return SIM.handCap[t] * sizeFactor(t, h.size) * (1 - SIM.overhangLoss[t] * s);
  }
  return SIM.footCap[t] * sizeFactor(t, h.size);
}

export function topHolds(b: BoulderDef): HoldDef[] {
  const tops = b.holds.filter((h) => h.role === 'top' && usableByHand(h));
  if (tops.length) return tops;
  // Fallback for hand-made problems without a marked top: the highest hand hold.
  let best: HoldDef | null = null;
  for (const h of b.holds) if (usableByHand(h) && (!best || h.y > best.y)) best = h;
  return best ? [best] : [];
}

/**
 * Start placement shared by the sim and the planner:
 * hands on the start holds (one per start hold, or both matched on a single one),
 * feet on authored startFeet or the best nearby footholds.
 */
export function startPlacement(b: BoulderDef): (string | null)[] {
  const out: (string | null)[] = [null, null, null, null];
  let starts = b.holds.filter((h) => h.role === 'start' && usableByHand(h));
  if (!starts.length) {
    starts = b.holds
      .filter((h) => usableByHand(h))
      .sort((a, c) => a.y - c.y)
      .slice(0, 2);
  }
  if (!starts.length) return out;
  if (starts.length === 1) {
    out[0] = starts[0].id;
    out[1] = starts[0].id;
  } else {
    // Two lowest starts, left one for the left hand.
    const s = [...starts].sort((a, c) => a.y - c.y).slice(0, 2).sort((a, c) => a.x - c.x);
    out[0] = s[0].id;
    out[1] = s[1].id;
  }
  const byId = new Map(b.holds.map((h) => [h.id, h] as const));
  const lh = byId.get(out[0]!)!;
  const rh = byId.get(out[1]!)!;
  const hx = (lh.x + rh.x) / 2;
  const hy = Math.min(lh.y, rh.y);

  const sf = b.startFeet;
  if (sf?.LF && byId.get(sf.LF) && usableByFoot(byId.get(sf.LF)!)) out[2] = sf.LF;
  if (sf?.RF && byId.get(sf.RF) && usableByFoot(byId.get(sf.RF)!)) out[3] = sf.RF;
  if (out[2] && out[3]) return out;

  // Feet must sit inside the leg envelopes of a plausible start stance: pelvis below the hands (as
  // ClimberSim / the planner settle it), upright torso. The pose search adapts the body afterwards,
  // so a generous tolerance; feet far above the hips or crossed far under the body are skipped.
  const inLegReach = (h: HoldDef, li: number): boolean => {
    const hipX = hx + (li === 2 ? -BODY.hipHalf : BODY.hipHalf);
    const py = Math.max(GAME.padHeight + 0.42, clamp(h.y + 0.62, hy - 1.15, hy - 0.35));
    return envEval(li, hipX, py, 0, 1, h.x, h.y).excess <= 0.12;
  };
  const cand = b.holds.filter(
    (h) => usableByFoot(h) && h.y > 0.08 && h.y < hy - 0.55 && h.y > hy - 2.0 && Math.abs(h.x - hx) < 1.0 && h.id !== out[0] && h.id !== out[1],
  );
  const score = (h: HoldDef, side: number): number => {
    const idealY = hy - 1.15;
    const idealX = hx + side * 0.24;
    return nominalCapacity(h, false, b.wallAngle) * 0.6 - Math.abs(h.y - idealY) * 0.9 - Math.abs(h.x - idealX) * 1.1 - (side * (h.x - hx) < -0.15 ? 0.6 : 0);
  };
  const pick = (side: number, exclude: string | null): string | null => {
    let best: HoldDef | null = null;
    let bs = -Infinity;
    for (const h of cand) {
      if (h.id === exclude) continue;
      if (!inLegReach(h, side < 0 ? 2 : 3)) continue;
      const s = score(h, side);
      if (s > bs) {
        bs = s;
        best = h;
      }
    }
    return best ? best.id : null;
  };
  if (!out[2]) out[2] = pick(-1, out[3]);
  if (!out[3]) out[3] = pick(1, out[2]);
  // A single big foothold can take both feet.
  if (!out[3] && out[2]) {
    const h = byId.get(out[2])!;
    if (h.size >= 0.05 && canMatch(3, h) && inLegReach(h, 3)) out[3] = out[2];
  }
  if (!out[2] && out[3]) {
    const h = byId.get(out[3])!;
    if (h.size >= 0.05 && canMatch(2, h) && inLegReach(h, 2)) out[2] = out[3];
  }
  return out;
}

export function holdMap(b: BoulderDef): Map<string, HoldDef> {
  return new Map(b.holds.map((h) => [h.id, h] as const));
}

export const SMEAR_OK = (wallAngle: number): boolean => wallAngle <= SIM.smearMaxAngle;
export const PAD = GAME.padHeight;

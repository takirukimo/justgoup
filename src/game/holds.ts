// Hold rules + grip capacity. Shared by ClimberSim, the static solver, the planner and the generator.

import type { BoulderDef, FootMode, HoldDef, HoldShape, HoldType, LimbId, QuickdrawDef, Vec2 } from '../core/types';
import { BODY as BODY_, GAME, SIM as SIM_ } from '../config/tuning';
import { clamp as clamp_, DEG } from '../core/math';
import { dcos, dsin } from './dmath';
import { envEvalOn, pointSegDist } from './anatomy';
import { angleAt, profileOf } from './wall-profile';

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

/** Holds bolted onto route volumes (HoldDef.onVolume), by volume id; null when the problem has none. */
export function mountsByVolume(holds: readonly HoldDef[]): Map<string, HoldDef[]> | null {
  let out: Map<string, HoldDef[]> | null = null;
  for (const h of holds) {
    if (!h.onVolume || h.role === 'deco') continue;
    out ??= new Map();
    const list = out.get(h.onVolume);
    if (list) list.push(h);
    else out.set(h.onVolume, [h]);
  }
  return out;
}

/**
 * Snap rule for a hold bolted onto a volume: a foot released within GAME.snapRadius of the mounted hold
 * takes that hold, not the volume under it (the volume is far bigger, so plain nearest-edge snapping
 * would always pick it). The sim's snapCandidate applies it; the generator keeps every volume's own
 * foot spot out of its mounted holds' range, so the planner's targets stay unambiguous.
 */
export function volumeYields(vol: HoldDef, px: number, py: number, mounts: ReadonlyMap<string, readonly HoldDef[]> | null): boolean {
  if (!mounts || vol.type !== 'volume') return false;
  const list = mounts.get(vol.id);
  if (!list) return false;
  for (const m of list) {
    const dx = px - m.x;
    const dy = py - m.y;
    const r = GAME.snapRadius + m.size;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
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
 * Where on a hold a hand grips / a foot presses, as a fraction of HoldDef.size from its centre toward the
 * grip side (−good direction), measured on the drawn geometry (render/holds.ts profiles, hold-local +y):
 *  hands — an edge's / crimp's shelf (≈ 0.25–0.30), the back of a jug's cavity behind the lip (0.31–0.44),
 *          a sloper's upper dome, inside a pocket's hole (its upper part, ≈ 0.2), a pinch's rib;
 *  feet  — where a shoe stands: a foot chip's upper shoulder (≈ 0.5–0.8; its front is flat), the toe in a
 *          jug's bucket, an edge's shelf, a sloper's upper dome, a pocket's rim above the hole.
 * (Volumes: their top facet, ≤ 0.14 m in.)
 */
const HAND_INSET: Record<HoldType, number> = { jug: 0.32, edge: 0.32, crimp: 0.32, sloper: 0.32, pinch: 0.32, pocket: 0.22, volume: 0.45, foot: 0.32 };
const FOOT_INSET: Record<HoldType, number> = { jug: 0.32, edge: 0.3, crimp: 0.3, sloper: 0.36, pinch: 0.34, pocket: 0.34, volume: 0.45, foot: 0.58 };

/**
 * Grip point of a hold: on the incut side, i.e. slightly away from where the body should be (HAND_INSET /
 * FOOT_INSET: the grip surface of the drawn hold). Two hands matched on one hold are spread along the
 * hold's tangent.
 */
export function contactPoint(h: HoldDef, limbIdx: number, matched: boolean, out: Vec2): Vec2 {
  const ca = dcos(h.angle);
  const sa = dsin(h.angle);
  const inset = h.type === 'volume' ? Math.min(h.size * 0.45, 0.14) : h.size * (limbIdx < 2 ? HAND_INSET[h.type] : FOOT_INSET[h.type]);
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

/**
 * Contact geometry of a limb on a hold (sim → renderer): the outward unit normal (nx, ny, nz) of the surface
 * the hand / foot touches, in the wall-local frame of the panel under the contact (x right, y up the
 * surface, z out of the wall), and the in-plane unit direction (gx, gy) from that surface toward the side
 * the limb grips / presses from (LimbSnapshot.contactNormal / gripDir).
 *
 * The grip surfaces match the drawn hold geometry (render/holds.ts profiles, unit = HoldDef.size, the grip
 * side on hold-local +y = −good direction), with contactPoint() at 0.32 · size on that side:
 *  • edge / crimp — the shelf the fingers sit on (≈ 0.30 · size, `edgeDepthMm` deep), facing up (−good
 *    direction) and tilted by the lip: incut into the wall, slopey out of it,
 *  • jug — inside the lip (the cavity behind it, 0.31–0.44 · size): its inner face hooks into the wall,
 *  • sloper — the upper dome (the chalked grip side), tilted out by the effective slope (−lip),
 *  • pocket — inside the hole, the pads on its rim, tilted in,
 *  • pinch — the rib's sides (normal ≈ the grip side, square to the wall),
 *  • volume — its face, tilted well out (a hand presses on it; a foot stands on its top facet),
 *  • a standing foot — the hold's top (the same grip side: a foot pushes where a hand pulls from below), a
 *    foot chip's dome tilted out; hooks — the far face the heel / toe pulls on.
 * A hold bolted onto a volume (onVolume, `vol`) sits square to the volume's face, which faces the climber
 * from the volume's centre: the whole frame tilts toward the hold's offset from that centre.
 * `mode` is the foot technique (null for hands). Writes `out` and returns it.
 */
export interface ContactFrame {
  nx: number;
  ny: number;
  nz: number;
  gx: number;
  gy: number;
}

/** Tilt (degrees, + = out of the wall) of the gripped surface normal by hold type: hands, standing feet. */
const HAND_TILT: Record<HoldType, number> = { jug: -20, edge: 0, crimp: 0, sloper: 35, pinch: 0, pocket: -25, volume: 45, foot: 20 };
const FOOT_TILT: Record<HoldType, number> = { jug: 5, edge: 5, crimp: 5, sloper: 30, pinch: 10, pocket: 0, volume: 30, foot: 35 };

export function contactFrame(h: HoldDef | null, li: number, mode: FootMode | null, vol: HoldDef | null, out: ContactFrame): ContactFrame {
  if (!h) {
    // a smear: the rubber on the wall itself
    out.nx = 0;
    out.ny = 0;
    out.nz = 1;
    out.gx = 0;
    out.gy = 1;
    return out;
  }
  const hx = dcos(h.angle);
  const hy = dsin(h.angle);
  const hand = isHandIdx(li);
  const hook = mode === 'heel' || mode === 'toe';
  let tilt: number;
  if (hand) {
    tilt = HAND_TILT[h.type];
    if (h.type === 'edge' || h.type === 'crimp') tilt = -clamp(lipAngleOf(h), -30, 30);
    else if (h.type === 'sloper') tilt = clamp(-lipAngleOf(h), 0, 70);
  } else if (hook) tilt = mode === 'heel' ? -10 : -15;
  else {
    tilt = FOOT_TILT[h.type];
    if (h.type === 'edge' || h.type === 'crimp') tilt = 5 - 0.5 * clamp(lipAngleOf(h), -30, 30);
    else if (h.type === 'sloper') tilt = clamp(-lipAngleOf(h), 0, 70);
  }
  const t = tilt * DEG;
  const ct = dcos(t);
  const st = dsin(t);
  // the gripped surface faces away from the good direction (−h), tilted out (+z) / in (−z)
  let nx = -hx * ct;
  let ny = -hy * ct;
  let nz = st;
  // hands and hooks wrap the surface from the good side; a pushing foot presses from the surface's side
  let gx = hand || hook ? hx : -hx;
  let gy = hand || hook ? hy : -hy;
  if (vol) {
    // square to the volume's face: rotate z toward the hold's offset m from the volume centre by φ
    let mx = h.x - vol.x;
    let my = h.y - vol.y;
    const ml = Math.sqrt(mx * mx + my * my);
    if (ml > 1e-6) {
      mx /= ml;
      my /= ml;
      const phi = clamp(ml / Math.max(vol.size, 0.05), 0, 1) * 45 * DEG;
      const c = dcos(phi);
      const s = dsin(phi);
      // Rodrigues about a = z × m = (−my, mx, 0)
      const ax = -my;
      const ay = mx;
      const rot = (vx: number, vy: number, vz: number, o: { x: number; y: number; z: number }): void => {
        const cx = ay * vz;
        const cy = -ax * vz;
        const cz = ax * vy - ay * vx;
        const d = (ax * vx + ay * vy) * (1 - c);
        o.x = vx * c + cx * s + ax * d;
        o.y = vy * c + cy * s + ay * d;
        o.z = vz * c + cz * s;
      };
      rot(nx, ny, nz, ROT);
      nx = ROT.x;
      ny = ROT.y;
      nz = ROT.z;
      // the grip direction stays in the wall plane: the in-plane part of the rotated tangent
      rot(gx, gy, 0, ROT);
      const gl = Math.sqrt(ROT.x * ROT.x + ROT.y * ROT.y);
      if (gl > 1e-6) {
        gx = ROT.x / gl;
        gy = ROT.y / gl;
      }
    }
  }
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  out.nx = nx / nl;
  out.ny = ny / nl;
  out.nz = nz / nl;
  out.gx = gx;
  out.gy = gy;
  return out;
}
const ROT = { x: 0, y: 0, z: 0 };

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
/** Hand cones of shapes that grip differently from their type (HoldDef.shape). */
const SHAPE_CONES: Partial<Record<HoldShape, ConeCos>> = {};
for (const k of Object.keys(SIM.shapeCone) as (keyof typeof SIM.shapeCone)[]) SHAPE_CONES[k] = coneCos(SIM.shapeCone[k]);
/** Hand pull cone of a hold (its shape's when that grips differently, else its type's). */
const handCone = (h: HoldDef): ConeCos => (h.shape !== undefined && SHAPE_CONES[h.shape]) || HAND_CONES[h.type];

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

/** Piecewise-linear lookup in [x, y] knots (clamped at the ends). Plain arithmetic: deterministic. */
function knots(table: readonly (readonly [number, number])[], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const n = table.length;
  for (let i = 1; i < n; i++) {
    const b = table[i];
    if (x <= b[0]) {
      const a = table[i - 1];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
  }
  return table[n - 1][1];
}

/**
 * Usable edge depth (mm) of an edge / crimp / pocket: HoldDef.edgeDepthMm, else derived from the
 * hold's size (generated edges ≈18–32 mm, crimps ≈7–13 mm, pockets ≈15–30 mm deep).
 */
export function edgeDepthMm(h: HoldDef): number {
  if (h.edgeDepthMm !== undefined && Number.isFinite(h.edgeDepthMm)) return clamp(h.edgeDepthMm, 2, 80);
  const m = h.type === 'crimp' ? SIM.edgeDepthBySize.crimp : h.type === 'pocket' ? SIM.edgeDepthBySize.pocket : SIM.edgeDepthBySize.edge;
  const t = (h.size - m[0]) / (m[1] - m[0]);
  return clamp(m[2] + (m[3] - m[2]) * t, 3, 60);
}

/**
 * Hot-path tables: a knot curve sampled at its integer x (every knot sits on an integer, so linear
 * interpolation between samples reproduces the piecewise-linear curve exactly). Plain arithmetic.
 */
function sampled(table: readonly (readonly [number, number])[]): { x0: number; ys: Float64Array } {
  const x0 = table[0][0];
  const x1 = table[table.length - 1][0];
  const ys = new Float64Array(x1 - x0 + 1);
  for (let i = 0; i < ys.length; i++) ys[i] = knots(table, x0 + i);
  return { x0, ys };
}
function lookup(t: { x0: number; ys: Float64Array }, x: number): number {
  const f = x - t.x0;
  const ys = t.ys;
  if (f <= 0) return ys[0];
  const last = ys.length - 1;
  if (f >= last) return ys[last];
  const i = f | 0;
  return ys[i] + (ys[i + 1] - ys[i]) * (f - i);
}
const DEPTH_T = sampled(SIM.edgeDepthCurve);
const SLOPE_T = sampled(SIM.sloperSlopeCurve);

/** Edge-depth multiplier relative to the 20 mm reference edge (research [22]). */
export function edgeDepthFactor(depthMm: number): number {
  return lookup(DEPTH_T, depthMm);
}

/** Lip angle (°) of a hold: HoldDef.lipAngle, else −35° for slopers and 0 for everything else. */
export function lipAngleOf(h: HoldDef): number {
  if (h.lipAngle !== undefined && Number.isFinite(h.lipAngle)) return clamp(h.lipAngle, -80, 60);
  return h.type === 'sloper' ? SIM.sloperLip : 0;
}

/** Sloper multiplier over the effective slope (−lip + wall angle, degrees; research [29]). */
export function sloperSlopeFactor(slopeDeg: number): number {
  return lookup(SLOPE_T, slopeDeg);
}

/**
 * Pumped-forearm capacity factor: 1 − pumpCapLoss·pump⁴ (fresh 1 → fully pumped 0.6, research [49]).
 * `pump` is 1 − the forearm's remaining W′ fraction (forearm.ts).
 */
export function pumpCapFactor(pump: number): number {
  const p = pump <= 0 ? 0 : pump >= 1 ? 1 : pump;
  const p2 = p * p;
  return 1 - SIM.pumpCapLoss * p2 * p2;
}

/** Chalk / sweat capacity factor for a hold type: friction 1 (fresh chalk) → 1, 0 (sweaty) → 1 − sense/3. */
export function frictionCapFactor(t: HoldType, friction: number): number {
  const f = friction <= 0 ? 0 : friction >= 1 ? 1 : friction;
  return 1 - (SIM.frictionSense[t] * (1 - f)) / 3;
}

/**
 * Best-direction hand capacity of a hold for a fresh climber of strength 1 with fresh chalk (no pull
 * cone, no match / pump / assist): the research grip model (§2.4) —
 *  • edge, crimp: the 20 mm edge × the edge-depth curve × the lip (incut / slopey) × overhangLoss,
 *  • sloper: sloperBase × size × the effective-slope curve (−lip + wall angle), no overhangLoss,
 *  • pocket: the 20 mm edge × fingers (mono 0.3 … 4 fingers 0.95) × size × overhangLoss,
 *  • jug, pinch, volume, foot: the handCap table × size × overhangLoss.
 * `overhang` is max(0, sin(wallAngle)).
 */
export function handGripBase(h: HoldDef, wallAngle: number, overhang: number): number {
  const t = h.type;
  if (t === 'sloper') return SIM.sloperBase * sizeFactor(t, h.size) * sloperSlopeFactor(wallAngle - lipAngleOf(h)) * (h.shape !== undefined ? SIM.shapeGrip[h.shape] ?? 1 : 1);
  let cap: number;
  if (t === 'edge' || t === 'crimp') {
    const lip = clamp(lipAngleOf(h), -30, 30);
    cap = SIM.edge20 * edgeDepthFactor(edgeDepthMm(h)) * (1 + SIM.edgeLipGain * lip);
  } else if (t === 'pocket') {
    const f = h.fingers !== undefined ? clamp(Math.round(h.fingers), 1, 4) : 3;
    cap = SIM.edge20 * SIM.pocketFingers[f - 1] * sizeFactor(t, h.size);
  } else cap = SIM.handCap[t] * sizeFactor(t, h.size);
  if (overhang > 0) cap *= 1 - SIM.overhangLoss[t] * overhang;
  if (h.shape !== undefined) cap *= SIM.shapeGrip[h.shape] ?? 1;
  return cap;
}

export interface GripContext {
  wallAngle: number; // degrees
  assist: number;
  /** Forearm pump 0..1 of the gripping hand (1 − remaining W′). */
  pump: number;
  /** max(0, sin(wallAngle)) */
  overhang: number;
  /** Chalk / skin friction 0..1 of the gripping hand (1 = fresh chalk). Optional: absent = 1. */
  friction?: number;
  /** Climber strength (× hand capacity; 1 = the default V3–V5 climber). Optional: absent = 1. */
  strength?: number;
}

/**
 * Hand capacity (fraction of body weight) on `h`. (hx, hy) is the hold's good direction
 * (cos/sin of h.angle); (dx, dy) the unit direction from the grip point to the shoulder.
 * grip base (type, edge depth, slope, fingers, size, overhang) × pull-angle quality × match × pump
 * × chalk friction × strength × assist.
 */
export function handCapacity(h: HoldDef, hx: number, hy: number, dx: number, dy: number, matched: boolean, ctx: GripContext): number {
  const t = h.type;
  let cap = handGripBase(h, ctx.wallAngle, ctx.overhang);
  cap *= coneQ(dx * hx + dy * hy, h.shape === undefined ? HAND_CONES[t] : handCone(h));
  if (matched) cap *= SIM.matchFactor;
  cap *= pumpCapFactor(ctx.pump);
  if (ctx.friction !== undefined && ctx.friction < 1) cap *= frictionCapFactor(t, ctx.friction);
  if (ctx.strength !== undefined) cap *= ctx.strength;
  cap *= 1 + SIM.assistCap * ctx.assist;
  return cap;
}

/**
 * Foot capacity on `h` (or a smear when h is null). (dx, dy) is the unit direction from the toe to
 * the hip; feet want the body on the opposite side of the hold's hand direction.
 * `normalPerFoot` < 0 means the feet must toe-pull (overhangs), which costs capacity; on steep walls a
 * foothold also loses capacity with sin(overhang) (SIM.steepFootLoss).
 */
export function footCapacity(h: HoldDef | null, hx: number, hy: number, dx: number, dy: number, normalPerFoot: number, ctx: GripContext): number {
  let cap: number;
  if (h) {
    const t = h.type;
    cap = SIM.footCap[t] * sizeFactor(t, h.size);
    if (h.shape !== undefined) cap *= SIM.shapeFoot[h.shape] ?? 1;
    cap *= coneQ(-(dx * hx + dy * hy), FOOT_CONES[t]);
    if (normalPerFoot < 0) cap *= Math.max(SIM.toeMin, 1 + normalPerFoot / SIM.toeScale[t]);
    if (ctx.overhang > 0) cap *= 1 - SIM.steepFootLoss * ctx.overhang;
  } else {
    const fric = clamp(1 - ctx.wallAngle / 14, 0.2, 1.25);
    cap = SIM.smearCap * fric * coneQ(dy, SMEAR_CONE);
    cap *= clamp(0.8 + normalPerFoot * 1.4, 0.15, 1.3);
  }
  cap *= 1 + SIM.assistCap * ctx.assist;
  return cap;
}

/**
 * Capacity of a HOOKING foot (heel hook when `heel`, else toe hook) on `h`: the leg pulls the hip toward
 * the hold, so the hold's good direction should point toward the hip, like a hand's. (dx, dy) is the
 * unit direction from the contact to the hip. Research §2.3: a heel hook carries up to ≈0.45 BW.
 */
export function hookCapacity(h: HoldDef, heel: boolean, hx: number, hy: number, dx: number, dy: number, ctx: GripContext): number {
  const t = h.type;
  let cap = (heel ? SIM.heelHookCap : SIM.toeHookCap) * SIM.hookHoldFactor[t];
  cap *= coneQ(dx * hx + dy * hy, h.shape === undefined ? HAND_CONES[t] : handCone(h));
  cap *= 1 + SIM.assistCap * ctx.assist;
  return cap;
}

/** Most out-of-plane pull-in (body weights) a hook on `h` can provide (it pulls the hips to the wall). */
export function hookPullIn(h: HoldDef | null, heel: boolean, assist: number): number {
  if (!h) return 0;
  return (heel ? SIM.heelHookPull : SIM.toeHookPull) * SIM.hookHoldFactor[h.type] * (1 + SIM.assistCap * assist);
}

/** Pull-direction quality 0..1 of a hand-style grip (also a hook) for the unit pull direction (dx, dy). */
export function pullQuality(h: HoldDef, dx: number, dy: number): number {
  return coneQ(dx * dcos(h.angle) + dy * dsin(h.angle), h.shape === undefined ? HAND_CONES[h.type] : handCone(h));
}

/** Push-direction quality 0..1 of a foothold for the unit direction toe → hip (dx, dy). */
export function pushQuality(h: HoldDef, dx: number, dy: number): number {
  return coneQ(-(dx * dcos(h.angle) + dy * dsin(h.angle)), FOOT_CONES[h.type]);
}

/** Ideal (best-direction) capacity of a hold for a limb kind, ignoring body position. */
export function nominalCapacity(h: HoldDef, hand: boolean, wallAngle: number): number {
  const t = h.type;
  if (hand) return handGripBase(h, wallAngle, Math.max(0, dsin(wallAngle * DEG)));
  return SIM.footCap[t] * sizeFactor(t, h.size) * (h.shape !== undefined ? SIM.shapeFoot[h.shape] ?? 1 : 1);
}

/**
 * How a foot on hold h at contact (cx, cy) is used, from where it is relative to its hip joint
 * (hipX, hipY) — research §2.2/§2.3 — with hysteresis against `current` (null = a fresh placement).
 * `wall` is the wall angle (degrees) the technique sees, `pelvisX` the pelvis x. Shared by ClimberSim
 * (every placement, re-checked for rock-overs) and the planner (on folded walls):
 *  • heel — a pull-able hold the foot can't stand on (its good direction points toward the hip) at /
 *    above hip height and out to the side, on a wall of SIM.heelMinAngle or steeper,
 *  • toe — the same kind of hold further away / lower (a toe pulling under a lip, the far side of a
 *    feature), from SIM.toeMinAngle; on a roof (≥ 60°) any pull-able foothold,
 *  • drop — a sidepull-like foothold out to the side below the hip, facing away from the body (the
 *    knee turns in, the hip goes to the wall),
 *  • edge — everything else (standing on it).
 */
export function footModeFor(
  h: HoldDef,
  cx: number,
  cy: number,
  hipX: number,
  hipY: number,
  pelvisX: number,
  wall: number,
  current: FootMode | null,
): FootMode {
  const vx = cx - hipX;
  const vy = cy - hipY;
  const dist = Math.sqrt(vx * vx + vy * vy);
  if (dist < 1e-6) return 'edge';
  // wall frame (what the player sees): height above the hip joint, distance out to the side
  const up = vy;
  const out = vx < 0 ? -vx : vx;
  // out to the foot's own side (beyond its hip, away from the pelvis): a hook never crosses the body
  const ownOut = (hipX - pelvisX) * vx > 0 ? out : -out;
  const dx = -vx / dist;
  const dy = -vy / dist;
  const push = pushQuality(h, dx, dy);
  const pull = pullQuality(h, dx, dy);
  const hooked = current === 'heel' || current === 'toe';
  // heel hook: at / above hip height out to the side on a steep wall, on a hold the heel can pull on
  // (hysteresis: it stays a heel hook until the hips rise over it — a rock-over)
  if (wall >= SIM.heelMinAngle && pull >= (hooked ? 0.3 : 0.4) && up >= (current === 'heel' ? -0.22 : -0.1) && ownOut >= (current === 'heel' ? 0.1 : 0.15) && dist <= 0.85) return 'heel';
  // toe hook: a hold the foot can pull on but not stand on (the far side of a feature, under a lip),
  // or any pull-able foothold on a roof
  // (on a roof a foot can't stand: anything it can pull on at all is toe-pulled; the statics give a pushing
  // foot there nothing — research §2.1 — so a near-miss of the pull cone must not leave it 'edge')
  if (wall >= SIM.toeMinAngle && ((pull >= (hooked ? 0.45 : 0.6) && push < (hooked ? 0.6 : 0.5)) || (wall >= 60 && pull >= (hooked ? 0.15 : 0.22)) || (wall >= 48 && pull >= (hooked ? 0.35 : 0.45)))) return 'toe';
  // drop knee: a sidepull-like foothold out to the side below the hip, facing away from the body
  const hx = dcos(h.angle);
  const ahx = hx < 0 ? -hx : hx;
  const dropOk = current === 'drop' ? ahx >= 0.5 && push >= 0.4 : ahx >= 0.6 && push >= 0.5;
  if (dropOk && wall >= -2 && hx * (cx - pelvisX) > 0 && out >= 0.1 && up <= 0.05 && up >= -0.62) return 'drop';
  return 'edge';
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
  const prof = profileOf(b);
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
    return envEvalOn(prof, li, hipX, py, 0, 1, h.x, h.y).excess <= 0.12;
  };
  const cand = b.holds.filter(
    (h) => usableByFoot(h) && h.y > 0.08 && h.y < hy - 0.55 && h.y > hy - 2.0 && Math.abs(h.x - hx) < 1.0 && h.id !== out[0] && h.id !== out[1],
  );
  const score = (h: HoldDef, side: number): number => {
    const idealY = hy - 1.15;
    const idealX = hx + side * 0.24;
    return nominalCapacity(h, false, prof ? angleAt(prof, h.y) : b.wallAngle) * 0.6 - Math.abs(h.y - idealY) * 0.9 - Math.abs(h.x - idealX) * 1.1 - (side * (h.x - hx) < -0.15 ? 0.6 : 0);
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

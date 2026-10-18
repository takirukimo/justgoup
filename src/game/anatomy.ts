// Anatomical reach envelopes: the CANONICAL limb-range tables of JUST GO UP.
//
// A limb's reach is not a circle around its root joint. A foot cannot go straight up past the hip,
// a hand cannot reach far down past the hips, and reaching across the body is short. Every reach
// decision in the sim, the planner and the generator goes through this file, and the renderer
// mirrors the same limits as joint-angle clamps (keep both in sync when tuning).
//
// ── Body frame (wall-local 2D) ──────────────────────────────────────────────────────────────
//   U = unit(chest − pelvis)      body up
//   R = (U.y, −U.x)               body right
//   O = −R for left limbs, +R for right limbs (outward)
// For v = target − anchor (anchor = hip joint for feet, shoulder joint for hands) the polar angle φ
// (degrees) is measured
//   LEGS: from straight DOWN (−U), positive toward O; ±180 = straight up,
//   ARMS: from straight UP (+U),   positive toward O; 180 = straight down.
// Max reach r(φ) is piecewise linear between the table knots; outside [φmin, φmax] the region is
// forbidden. Angles are unwrapped so the forbidden wedge is centred on the wrap-around point
// (legs: φ ∈ (160°, 250°) i.e. up and up-inward; arms: φ ∈ (195°, 210°) i.e. down-inward).
//
// Everything here is allocation-free on the hot paths (raw-number variants write into module
// scratch) and uses only IEEE basic arithmetic + Math.sqrt, so the generator stays bit-identical on
// every device (see dmath.ts).

import type { Vec2 } from '../core/types';
import { BODY, SIM } from '../config/tuning';

/** One knot: [φ degrees, max reach metres, anatomical strain weight 0..1 at the edge]. */
export type EnvelopeKnot = readonly [phi: number, r: number, strain: number];

/**
 * LEG (hip → toe), legMax 0.93. A foot rises at most ~0.33 m above the hip joint and only out to
 * the side with a bent knee (high step / rockover); it never goes straight up. It can cross under the
 * body a little (backstep / drop-knee); a wide frog stance is fine. The strain weight says how
 * awkward the limit is in that direction (a straight standing leg is barely strained at full
 * length, a deep high step or a deep cross-under is).
 */
export const LEG_ENVELOPE: readonly EnvelopeKnot[] = [
  [-110, 0.22, 1],
  [-90, 0.34, 1],
  [-60, 0.58, 0.75],
  [-30, 0.86, 0.35],
  [0, 0.93, 0.12],
  [45, 0.93, 0.12],
  [90, 0.84, 0.4],
  [115, 0.64, 0.75],
  [135, 0.46, 1],
  [150, 0.32, 1],
  [160, 0.22, 1],
];

/**
 * ARM (shoulder → grip point), armMax 0.66. Full reach up and to the side, crossovers above the head
 * to the other side, a limited reach across the chest, and hands down along the body to about hip
 * level, but not far down past the hips/feet or behind the opposite side.
 */
export const ARM_ENVELOPE: readonly EnvelopeKnot[] = [
  [-150, 0.22, 1],
  [-120, 0.3, 1],
  [-90, 0.4, 0.9],
  [-60, 0.52, 0.65],
  [-30, 0.64, 0.4],
  [0, 0.66, 0.3],
  [90, 0.66, 0.35],
  [135, 0.62, 0.5],
  [160, 0.52, 0.7],
  [180, 0.42, 0.85],
  [195, 0.3, 1],
];

/** Degrees over which the reach ratio of a forbidden direction ramps up past the angular limit. */
const FORBID_FALLOFF = 30;
/** Boundary sampling step (degrees) of the projection polygon (chord error < 0.6 mm). */
const PROJ_STEP = 4;

interface Envelope {
  phiMin: number;
  phiMax: number;
  /** φ values below this are unwrapped by +360 (centre of the forbidden wedge − 180). */
  lo: number;
  /** r and strain sampled at 1° from phiMin (exact: every knot is an integer degree). */
  r: Float64Array;
  w: Float64Array;
  rMax: number;
  /** Projection polygon in local (o, d) coordinates: [origin, boundary φmin → φmax]. */
  po: Float64Array;
  pd: Float64Array;
  /** true for legs: base direction is −U. */
  down: boolean;
}

function build(table: readonly EnvelopeKnot[], down: boolean): Envelope {
  const phiMin = table[0][0];
  const phiMax = table[table.length - 1][0];
  const span = phiMax - phiMin;
  const n = span + 1;
  const r = new Float64Array(n);
  const w = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const phi = phiMin + i;
    while (k < table.length - 2 && phi > table[k + 1][0]) k++;
    const a = table[k];
    const b = table[k + 1];
    const t = (phi - a[0]) / (b[0] - a[0]);
    r[i] = a[1] + (b[1] - a[1]) * t;
    w[i] = a[2] + (b[2] - a[2]) * t;
  }
  let rMax = 0;
  for (const kn of table) if (kn[1] > rMax) rMax = kn[1];
  const env: Envelope = { phiMin, phiMax, lo: phiMin - (360 - span) / 2, r, w, rMax, po: new Float64Array(0), pd: new Float64Array(0), down };
  // projection polygon: boundary samples every PROJ_STEP degrees (knots included)
  const phis: number[] = [];
  for (let p = phiMin; p < phiMax; p += PROJ_STEP) phis.push(p);
  for (const kn of table) if (!phis.includes(kn[0])) phis.push(kn[0]);
  phis.sort((a, b) => a - b);
  const po = new Float64Array(phis.length + 1);
  const pd = new Float64Array(phis.length + 1);
  for (let i = 0; i < phis.length; i++) {
    const rr = radiusAt(env, phis[i]);
    const s = dsinDeg(phis[i]);
    const c = dcosDeg(phis[i]);
    po[i + 1] = rr * s;
    pd[i + 1] = rr * c;
  }
  env.po = po;
  env.pd = pd;
  return env;
}

// ── tiny deterministic trig (degrees) for table building + polygon output ──
function dsinDeg(deg: number): number {
  // reduce to [-180, 180]
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  // sin(x) = sin(180 − x): fold to [-90, 90]
  if (d > 90) d = 180 - d;
  else if (d < -90) d = -180 - d;
  const x = (d * Math.PI) / 180;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 / 6227020800))))));
}
const dcosDeg = (deg: number): number => dsinDeg(deg + 90);

function radiusAt(e: Envelope, phi: number): number {
  const f = phi - e.phiMin;
  if (f <= 0) return e.r[0];
  const last = e.r.length - 1;
  if (f >= last) return e.r[last];
  const i = f | 0;
  const t = f - i;
  return e.r[i] + (e.r[i + 1] - e.r[i]) * t;
}

function strainAt(e: Envelope, phi: number): number {
  const f = phi - e.phiMin;
  if (f <= 0) return e.w[0];
  const last = e.w.length - 1;
  if (f >= last) return e.w[last];
  const i = f | 0;
  const t = f - i;
  return e.w[i] + (e.w[i + 1] - e.w[i]) * t;
}

const ARM = build(ARM_ENVELOPE, false);
const LEG = build(LEG_ENVELOPE, true);
/** Envelope per limb index (0 LH, 1 RH, 2 LF, 3 RF). */
const ENV: readonly Envelope[] = [ARM, ARM, LEG, LEG];
const SIDE = [-1, 1, -1, 1] as const;

/**
 * Deterministic atan2 in DEGREES (argument reduction + odd series, |error| < 1e-6°).
 * Pure arithmetic: identical results on every JS engine.
 */
export function atan2Deg(y: number, x: number): number {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const mx = ax > ay ? ax : ay;
  if (mx === 0) return 0;
  const mn = ax > ay ? ay : ax;
  // reduce a ∈ [0, 1] further to |b| ≤ tan(π/12) via atan(a) = π/6 + atan((a√3 − 1)/(a + √3))
  let a = mn / mx;
  let base = 0;
  if (a > 0.2679491924311227) {
    a = (a * 1.7320508075688772 - 1) / (a + 1.7320508075688772);
    base = 30;
  }
  const s = a * a;
  // atan series to a^11 (|a| ≤ 0.268 → error < 1e-9 rad)
  let r = a * (1 + s * (-1 / 3 + s * (1 / 5 + s * (-1 / 7 + s * (1 / 9 + s * (-1 / 11))))));
  r = base + r * 57.29577951308232;
  if (ay > ax) r = 90 - r;
  if (x < 0) r = 180 - r;
  return y < 0 ? -r : r;
}

// ═══════════════════════════════ hot-path core (raw numbers) ═══════════════════════════════

/** Result scratch of envEval (overwritten by every call). */
export const ENV_OUT = {
  /** Unwrapped polar angle (degrees) in the limb's convention. */
  phi: 0,
  /** |target − anchor| */
  r: 0,
  /** Max reach in that direction (the nearest angular edge's reach when forbidden). */
  rMax: 0,
  /** Degrees beyond the allowed angular range (0 inside it). */
  over: 0,
  /** Conservative distance outside the envelope (m, ≥ the true Euclidean distance; 0 inside). */
  excess: 0,
  /** r / r(φ): ≥ 1 at or beyond the edge, large for forbidden directions. */
  ratio: 0,
  /** Anatomical strain weight of the direction (0 comfortable … 1 awkward). */
  strain: 0,
  /** anatomicStrain(ratio, strain): the extra stress of this limb position. */
  edge: 0,
  /** Local frame components of v: outward and along the base direction (down for legs, up for arms). */
  vo: 0,
  vd: 0,
};

// flat hot-path tables: [r0, w0, r1, w1, …] at 1° from φmin
const interleave = (e: Envelope): Float64Array => {
  const out = new Float64Array(e.r.length * 2);
  for (let i = 0; i < e.r.length; i++) {
    out[2 * i] = e.r[i];
    out[2 * i + 1] = e.w[i];
  }
  return out;
};
const ARM_RW = interleave(ARM);
const LEG_RW = interleave(LEG);
const ARM_MIN = ARM.phiMin;
const ARM_MAX = ARM.phiMax;
const ARM_LO = ARM.lo;
const LEG_MIN = LEG.phiMin;
const LEG_MAX = LEG.phiMax;
const LEG_LO = LEG.lo;
const ARM_R0 = ARM.r[0];
const ARM_R1 = ARM.r[ARM.r.length - 1];
const LEG_R0 = LEG.r[0];
const LEG_R1 = LEG.r[LEG.r.length - 1];
// tuning snapshot (hot path: plain module constants)
const EDGE_START = SIM.edgeStart;
const EDGE_STRAIN = SIM.edgeStrain;
const EDGE_OVER_START = SIM.edgeOverStart;
const EDGE_OVER_SPAN = SIM.edgeOverFull - SIM.edgeOverStart;
const EDGE_OVER = SIM.edgeOver;
const EDGE_SPAN = 1 - SIM.edgeStart;

/**
 * Evaluate a target for limb `li` with its anchor (ax, ay) and the UNIT body-up vector (ux, uy).
 * Writes ENV_OUT and returns it. Hot path of the statics / planner: no allocation, one sqrt and one
 * division for the angle (polynomial atan, |error| < 0.001°).
 */
export function envEval(li: number, ax: number, ay: number, ux: number, uy: number, tx: number, ty: number): typeof ENV_OUT {
  const leg = li >= 2;
  const vx = tx - ax;
  const vy = ty - ay;
  const cr = vx * uy - vy * ux;
  const vo = li & 1 ? cr : -cr;
  const vu = vx * ux + vy * uy;
  const vd = leg ? -vu : vu;
  const r = Math.sqrt(vx * vx + vy * vy);
  const o = ENV_OUT;
  o.vo = vo;
  o.vd = vd;
  o.r = r;
  // φ = atan2(vo, vd) in degrees
  let phi = 0;
  {
    const aa = vd < 0 ? -vd : vd;
    const bb = vo < 0 ? -vo : vo;
    const mx = aa > bb ? aa : bb;
    if (mx > 1e-12) {
      const a = (aa > bb ? bb : aa) / mx;
      const q = a * a;
      phi = a * (57.2881 + q * (-18.92477 + q * (10.32133 + q * (-4.877765 + q * 1.193763))));
      if (bb > aa) phi = 90 - phi;
      if (vd < 0) phi = 180 - phi;
      if (vo < 0) phi = -phi;
    }
  }
  const lo = leg ? LEG_LO : ARM_LO;
  const pmin = leg ? LEG_MIN : ARM_MIN;
  const pmax = leg ? LEG_MAX : ARM_MAX;
  if (phi < lo) phi += 360;
  o.phi = phi;
  if (phi < pmin || phi > pmax) {
    const below = phi < pmin;
    const over = below ? pmin - phi : phi - pmax;
    const re = leg ? (below ? LEG_R0 : LEG_R1) : below ? ARM_R0 : ARM_R1;
    o.over = over;
    o.rMax = re;
    o.excess = r * over * 0.017453292519943295 + (r > re ? r - re : 0);
    let k = 1 - over / FORBID_FALLOFF;
    if (k < 0.04) k = 0.04;
    const q = r / (re * k);
    o.ratio = q > 8 ? 8 : q;
    o.strain = 1;
    o.edge = strainOf(o.ratio, 1);
  } else {
    const t = leg ? LEG_RW : ARM_RW;
    const f = phi - pmin;
    let i = f | 0;
    const last = (t.length >> 1) - 1;
    if (i >= last) i = last - 1;
    const w = f - i;
    const j = i << 1;
    const rm = t[j] + (t[j + 2] - t[j]) * w;
    o.over = 0;
    o.rMax = rm;
    o.excess = r > rm ? r - rm : 0;
    o.ratio = r / rm;
    o.strain = t[j + 1] + (t[j + 3] - t[j + 1]) * w;
    o.edge = o.ratio > EDGE_START ? strainOf(o.ratio, o.strain) : 0;
  }
  return o;
}

function strainOf(ratio: number, weight: number): number {
  let s = 0;
  if (weight > 0 && ratio > EDGE_START) {
    let t = (ratio - EDGE_START) / EDGE_SPAN;
    if (t > 1) t = 1;
    s += EDGE_STRAIN * weight * t * t * (3 - 2 * t);
  }
  if (ratio > EDGE_OVER_START) {
    let t = (ratio - EDGE_OVER_START) / EDGE_OVER_SPAN;
    if (t > 1) t = 1;
    s += EDGE_OVER * t * t * (3 - 2 * t);
  }
  return s;
}

/** Fast inside test (no tolerance): φ allowed and r ≤ r(φ). */
export function envInside(li: number, ax: number, ay: number, ux: number, uy: number, tx: number, ty: number): boolean {
  return envEval(li, ax, ay, ux, uy, tx, ty).excess <= 0;
}

/** Projection scratch (nearest allowed point, wall-local). */
export const PROJ_OUT = { x: 0, y: 0, dist: 0 };

/**
 * Nearest point of the envelope to (tx, ty) (the target itself when inside), into PROJ_OUT.
 * Returns the Euclidean distance outside (0 inside).
 */
export function envProject(li: number, ax: number, ay: number, ux: number, uy: number, tx: number, ty: number): number {
  const o = envEval(li, ax, ay, ux, uy, tx, ty);
  const out = PROJ_OUT;
  if (o.excess <= 0) {
    out.x = tx;
    out.y = ty;
    out.dist = 0;
    return 0;
  }
  const e = ENV[li];
  const qo = o.vo;
  const qd = o.vd;
  const po = e.po;
  const pd = e.pd;
  const n = po.length;
  let bestD = Infinity;
  let bo = 0;
  let bd = 0;
  // closed polygon: origin → boundary → origin
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    const x0 = po[i];
    const y0 = pd[i];
    const ex = po[j] - x0;
    const ey = pd[j] - y0;
    const ll = ex * ex + ey * ey;
    let t = ll > 1e-18 ? ((qo - x0) * ex + (qd - y0) * ey) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x0 + ex * t;
    const cy = y0 + ey * t;
    const dx = qo - cx;
    const dy = qd - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) {
      bestD = d2;
      bo = cx;
      bd = cy;
    }
  }
  // back to wall-local: v = o·O + d·D
  const s = SIDE[li];
  const Ox = s * uy;
  const Oy = -s * ux;
  const Dx = e.down ? -ux : ux;
  const Dy = e.down ? -uy : uy;
  out.x = ax + bo * Ox + bd * Dx;
  out.y = ay + bo * Oy + bd * Dy;
  out.dist = Math.sqrt(bestD);
  return out.dist;
}

/**
 * Clamp a target into the envelope grown by `tol` metres: inside → unchanged; within `tol` of the
 * envelope → unchanged; further out → `tol` short of the nearest envelope point, toward the target.
 * Result in PROJ_OUT (dist = remaining distance from the target).
 */
export function envClamp(li: number, ax: number, ay: number, ux: number, uy: number, tx: number, ty: number, tol: number): typeof PROJ_OUT {
  const d = envProject(li, ax, ay, ux, uy, tx, ty);
  const out = PROJ_OUT;
  if (d <= tol) {
    out.x = tx;
    out.y = ty;
    out.dist = 0;
    return out;
  }
  const k = tol / d;
  out.x += (tx - out.x) * k;
  out.y += (ty - out.y) * k;
  out.dist = d - tol;
  return out;
}

// ═══════════════════════════════ public helpers (Vec2) ═══════════════════════════════

const UP = { x: 0, y: 1 };
function unit(v: Vec2): Vec2 {
  const l = Math.sqrt(v.x * v.x + v.y * v.y);
  if (l < 1e-9) return UP;
  UNIT.x = v.x / l;
  UNIT.y = v.y / l;
  return UNIT;
}
const UNIT = { x: 0, y: 1 };

/** Normalise φ (degrees, any range) into the limb's unwrapped domain. */
export function normPhi(limbIdx: number, phiDeg: number): number {
  const e = ENV[limbIdx];
  let p = phiDeg % 360;
  if (p < e.lo) p += 360;
  if (p >= e.lo + 360) p -= 360;
  return p;
}

/** Allowed angular range [min, max] (degrees) of a limb. */
export function envelopeRange(limbIdx: number): { min: number; max: number } {
  const e = ENV[limbIdx];
  return { min: e.phiMin, max: e.phiMax };
}

/** Max reach (m) of limb `limbIdx` at polar angle φ (degrees, limb convention); 0 when forbidden. */
export function envelopeRadius(limbIdx: number, phiDeg: number): number {
  const e = ENV[limbIdx];
  const p = normPhi(limbIdx, phiDeg);
  if (p < e.phiMin || p > e.phiMax) return 0;
  return radiusAt(e, p);
}

/** Anatomical strain weight (0..1) of a direction; 1 for forbidden directions. */
export function envelopeStrain(limbIdx: number, phiDeg: number): number {
  const e = ENV[limbIdx];
  const p = normPhi(limbIdx, phiDeg);
  if (p < e.phiMin || p > e.phiMax) return 1;
  return strainAt(e, p);
}

/** Polar angle φ (degrees, unwrapped limb convention) of `target` seen from `anchor`. */
export function limbPhi(limbIdx: number, anchor: Vec2, bodyUp: Vec2, target: Vec2): number {
  const u = unit(bodyUp);
  return envEval(limbIdx, anchor.x, anchor.y, u.x, u.y, target.x, target.y).phi;
}

/** Is `target` inside the envelope (grown by `tolerance` metres, conservative outside the range)? */
export function inEnvelope(limbIdx: number, anchor: Vec2, bodyUp: Vec2, target: Vec2, tolerance = 0): boolean {
  const u = unit(bodyUp);
  return envEval(limbIdx, anchor.x, anchor.y, u.x, u.y, target.x, target.y).excess <= tolerance;
}

/** Conservative distance (m) of `target` outside the envelope; 0 inside. */
export function envelopeExcess(limbIdx: number, anchor: Vec2, bodyUp: Vec2, target: Vec2): number {
  const u = unit(bodyUp);
  return envEval(limbIdx, anchor.x, anchor.y, u.x, u.y, target.x, target.y).excess;
}

/** True (Euclidean) distance (m) of `target` outside the envelope; 0 inside. */
export function envelopeDistance(limbIdx: number, anchor: Vec2, bodyUp: Vec2, target: Vec2): number {
  const u = unit(bodyUp);
  return envProject(limbIdx, anchor.x, anchor.y, u.x, u.y, target.x, target.y);
}

/** r / r(φ): < 1 inside, ≥ 1 at or beyond the edge, large (up to 8) for forbidden directions. */
export function envelopeRatio(limbIdx: number, anchor: Vec2, bodyUp: Vec2, target: Vec2): number {
  const u = unit(bodyUp);
  return envEval(limbIdx, anchor.x, anchor.y, u.x, u.y, target.x, target.y).ratio;
}

/** Nearest allowed point to `target` (the target itself when inside) → `out`. */
export function clampToEnvelope(limbIdx: number, anchor: Vec2, bodyUp: Vec2, target: Vec2, out: Vec2): Vec2 {
  const u = unit(bodyUp);
  envProject(limbIdx, anchor.x, anchor.y, u.x, u.y, target.x, target.y);
  out.x = PROJ_OUT.x;
  out.y = PROJ_OUT.y;
  return out;
}

/** Number of boundary samples of envelopePolygon (the anchor is vertex 0). */
export const POLYGON_POINTS = 28;
const POLY_PHI: Float64Array[] = [ARM, ARM, LEG, LEG].map((e) => {
  // knots always included, the remaining samples spread evenly over the range
  const knots = (e === ARM ? ARM_ENVELOPE : LEG_ENVELOPE).map((k) => k[0]);
  const n = POLYGON_POINTS - 1;
  const set = new Set<number>(knots);
  for (let i = 0; set.size < n && i <= 4 * n; i++) {
    // fill the largest gaps first
    const sorted = [...set].sort((a, b) => a - b);
    let gi = 0;
    let gw = -1;
    for (let k = 0; k + 1 < sorted.length; k++) {
      const w = sorted[k + 1] - sorted[k];
      if (w > gw) {
        gw = w;
        gi = k;
      }
    }
    set.add(sorted[gi] + gw / 2);
  }
  return Float64Array.from([...set].sort((a, b) => a - b));
});

/**
 * Boundary of the reach envelope in wall-local coordinates: out[0] = anchor, then the boundary from
 * φmin to φmax (the polygon closes back to the anchor). `pad` grows the reach radially (e.g. the snap
 * tolerance). Reuses `out`'s Vec2 objects; returns `out` (length POLYGON_POINTS).
 */
export function envelopePolygon(limbIdx: number, anchor: Vec2, bodyUp: Vec2, out: Vec2[] = [], pad = 0): Vec2[] {
  const u = unit(bodyUp);
  const ux = u.x;
  const uy = u.y;
  const e = ENV[limbIdx];
  const phis = POLY_PHI[limbIdx];
  const s = SIDE[limbIdx];
  const Ox = s * uy;
  const Oy = -s * ux;
  const Dx = e.down ? -ux : ux;
  const Dy = e.down ? -uy : uy;
  const n = phis.length + 1;
  while (out.length < n) out.push({ x: 0, y: 0 });
  out.length = n;
  out[0].x = anchor.x;
  out[0].y = anchor.y;
  for (let i = 0; i < phis.length; i++) {
    const p = phis[i];
    const r = radiusAt(e, p) + pad;
    const so = dsinDeg(p) * r;
    const sd = dcosDeg(p) * r;
    out[i + 1].x = anchor.x + so * Ox + sd * Dx;
    out[i + 1].y = anchor.y + so * Oy + sd * Dy;
  }
  return out;
}

/** Longest reach of a limb in any direction (== BODY.armMax / legMax). */
export function envelopeMax(limbIdx: number): number {
  return ENV[limbIdx].rMax;
}

// ═══════════════════════════════ anatomical strain ═══════════════════════════════

/**
 * Extra stress a limb gets from its position in the envelope: near an awkward edge (deep high step,
 * crossover, hand far down) it works harder; pushed beyond the edge it pops off quickly.
 */
export function anatomicStrain(ratio: number, weight: number): number {
  return strainOf(ratio, weight);
}

// ═══════════════════════════════ self-clipping helpers (2D) ═══════════════════════════════

/** Do segments AB and CD properly intersect (crossing, not just touching at the ends)? */
export function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
}

/** Distance from P to segment AB. */
export function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const ll = ex * ex + ey * ey;
  let t = ll > 1e-18 ? ((px - ax) * ex + (py - ay) * ey) / ll : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t);
  const dy = py - (ay + ey * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Sanity: the tables' longest reach matches the body proportions. */
export const ENVELOPE_MAX_OK = Math.abs(ARM.rMax - BODY.armMax) < 1e-9 && Math.abs(LEG.rMax - BODY.legMax) < 1e-9;

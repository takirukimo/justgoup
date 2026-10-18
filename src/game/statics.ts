// Static equilibrium model shared by ClimberSim (live loads) and the planner (stance evaluation).
//
// Given a body pose (pelvis + chest) and up to four contacts, it distributes the climber's weight
// over the limbs with a small weighted least-squares problem:
//   unknowns  λᵢ (force along the limb axis: hands pull, feet push, λ ≥ 0), μᵢ (perpendicular
//             force, costlier: joint torque), τ (core torque slack)
//   subject to Σ fᵢ = (0, cos θ)  (in-plane weight)   and   Σ (pᵢ − com) × fᵢ + τ = 0
//   minimising Σ κᵢ λᵢ²/capᵢ² + ρ κᵢ μᵢ²/capᵢ² + τ²/τ₀²   (≈ minimise squared stress)
// solved in closed form (3×3 normal equations) with a tiny active-set loop for λ ≥ 0.
// The out-of-plane balance (side view) adds the "keep-in" pull the hands need to stop the body
// from toppling off the wall: Nₕ = (d·cos θ + sin θ·(y_com − y_feet)) / (y_hands − y_feet).
// On overhangs the feet must toe-pull (Nf < 0), which lowers their capacity.

import type { HoldDef } from '../core/types';
import { BODY, GAME, SIM } from '../config/tuning';
import { clamp, DEG, smoothstep } from '../core/math';
import { contactPoint, footCapacity, handCapacity, isHandIdx, maxReachIdx, type GripContext } from './holds';
import { dcos, dsin } from './dmath';

export interface Pose {
  px: number;
  py: number;
  cx: number;
  cy: number;
}

export interface Contact {
  /** null = smear (feet only). */
  hold: HoldDef | null;
  /** Contact point (grip point / toe), wall-local. */
  x: number;
  y: number;
  matched: boolean;
  /** Hold's good direction (cos, sin of hold.angle); (0, −1) for smears. */
  hx: number;
  hy: number;
}

/** Fill a contact for limb `li` on hold `h` (grip point + direction). */
export function setContact(c: Contact, h: HoldDef, li: number, matched: boolean): Contact {
  contactPoint(h, li, matched, c);
  c.hold = h;
  c.matched = matched;
  c.hx = dcos(h.angle);
  c.hy = dsin(h.angle);
  return c;
}

export function setSmear(c: Contact, x: number, y: number): Contact {
  c.hold = null;
  c.x = x;
  c.y = y;
  c.matched = false;
  c.hx = 0;
  c.hy = -1;
  return c;
}

export const newContact = (): Contact => ({ hold: null, x: 0, y: 0, matched: false, hx: 0, hy: -1 });

/** Indexed by limb: 0 LH, 1 RH, 2 LF, 3 RF. */
export type Contacts = (Contact | null)[];

export interface StaticsParams {
  wallAngle: number;
  assist: number;
  pump: number;
  /** Limb that is reaching (being dragged), −1 for none, and where it wants to go. */
  reachLimb: number;
  reachX: number;
  reachY: number;
  /** Cached trig of wallAngle (refreshed automatically when wallAngle changes). */
  trigAngle: number;
  cth: number;
  sth: number;
}

export function makeParams(wallAngle: number, assist = 0, pump = 0): StaticsParams {
  return {
    wallAngle,
    assist,
    pump,
    reachLimb: -1,
    reachX: 0,
    reachY: 0,
    trigAngle: wallAngle,
    cth: dcos(wallAngle * DEG),
    sth: dsin(wallAngle * DEG),
  };
}

export class StanceEval {
  readonly load = new Float64Array(4);
  readonly cap = new Float64Array(4);
  readonly stress = new Float64Array(4);
  readonly ratio = new Float64Array(4);
  readonly ax = new Float64Array(4);
  readonly ay = new Float64Array(4);
  /** In-plane force each contact applies to the body (body weights), full and axial-only. */
  readonly fx = new Float64Array(4);
  readonly fy = new Float64Array(4);
  readonly fax = new Float64Array(4);
  readonly fay = new Float64Array(4);
  tension = 0;
  worstStress = 0;
  worstLimb = -1;
  /** −1..1 CoM offset relative to the support base. */
  balance = 0;
  balancePen = 0;
  /** Signed barn-door amount (−1..1): + = CoM to the right of the contacts. */
  barn = 0;
  barnPen = 0;
  stretchPen = 0;
  corePen = 0;
  reachPen = 0;
  torque = 0;
  comX = 0;
  comY = 0;
  depth = 0.25;
  handsOn = 0;
  feetOn = 0;
  /** Total out-of-plane pull the hands provide (body weights). */
  normalHands = 0;
  /** Total foot normal force (negative = toe pull). */
  normalFeet = 0;
  feasible = true;
}

/** Shoulders (0, 1) and hips (2, 3) from the pose. */
export function computeAnchors(p: Pose, ax: Float64Array, ay: Float64Array): void {
  let sx = p.cx - p.px;
  let sy = p.cy - p.py;
  const l = sq(sx, sy) || 1;
  sx /= l;
  sy /= l;
  const rx = sy;
  const ry = -sx;
  const sh = BODY.shoulderHalf;
  const hh = BODY.hipHalf;
  ax[0] = p.cx - rx * sh;
  ay[0] = p.cy - ry * sh;
  ax[1] = p.cx + rx * sh;
  ay[1] = p.cy + ry * sh;
  ax[2] = p.px - rx * hh;
  ay[2] = p.py - ry * hh;
  ax[3] = p.px + rx * hh;
  ay[3] = p.py + ry * hh;
}

// ── scratch (no per-call allocation) ──
const MAXC = 9;
const A0 = new Float64Array(MAXC);
const A1 = new Float64Array(MAXC);
const A2 = new Float64Array(MAXC);
const WI = new Float64Array(MAXC);
const CL = new Int8Array(MAXC);
const CK = new Int8Array(MAXC);
const XS = new Float64Array(MAXC);
const LAM = new Float64Array(4);
const MU = new Float64Array(4);
const UX = new Float64Array(4);
const UY = new Float64Array(4);
const EXCL = new Uint8Array(4);
const GRIP: GripContext = { wallAngle: 0, assist: 0, pump: 0, overhang: 0 };
const sq = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** Estimated pelvis distance from the wall for a pose (bent legs push the hips out). */
export function estimateDepth(p: Pose, contacts: Contacts, ax: Float64Array, ay: Float64Array, wallAngle: number): number {
  let n = 0;
  let sum = 0;
  const L3 = SIM.legDepthLen;
  for (let i = 2; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    const l = sq(ax[i] - c.x, ay[i] - c.y);
    sum += clamp(Math.sqrt(Math.max(0, L3 * L3 - l * l)), 0.14, 0.62);
    n++;
  }
  if (n) return sum / n;
  let hy = 0;
  let nh = 0;
  for (let i = 0; i < 2; i++) {
    const c = contacts[i];
    if (c) {
      hy += c.y;
      nh++;
    }
  }
  const comY = p.py + BODY.comT * (p.cy - p.py);
  const s = Math.max(0, dsin(wallAngle * DEG));
  return clamp(0.2 + (nh ? s * Math.max(0, hy / nh - comY) * 0.85 : 0), 0.15, 1.2);
}

export function evaluateStance(pose: Pose, contacts: Contacts, prm: StaticsParams, out: StanceEval): StanceEval {
  if (prm.trigAngle !== prm.wallAngle) {
    prm.trigAngle = prm.wallAngle;
    prm.cth = dcos(prm.wallAngle * DEG);
    prm.sth = dsin(prm.wallAngle * DEG);
  }
  const cth = prm.cth;
  const sth = prm.sth;
  const ax = out.ax;
  const ay = out.ay;
  computeAnchors(pose, ax, ay);
  const comX = pose.px + BODY.comT * (pose.cx - pose.px);
  const comY = pose.py + BODY.comT * (pose.cy - pose.py);
  out.comX = comX;
  out.comY = comY;

  let nh = 0;
  let nf = 0;
  let hys = 0;
  let hxs = 0;
  let fys = 0;
  let fMin = Infinity;
  let fMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;
  let cSum = 0;
  let maxArm = 0;
  let maxLeg = 0;
  let crouch = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    out.load[i] = 0;
    out.stress[i] = 0;
    out.cap[i] = 0;
    out.fx[i] = 0;
    out.fy[i] = 0;
    out.fax[i] = 0;
    out.fay[i] = 0;
    if (!c) {
      out.ratio[i] = 0;
      continue;
    }
    const d = sq(c.x - ax[i], c.y - ay[i]);
    const r = d / maxReachIdx(i);
    out.ratio[i] = r;
    if (c.x < cMin) cMin = c.x;
    if (c.x > cMax) cMax = c.x;
    cSum += c.x;
    if (isHandIdx(i)) {
      nh++;
      hys += c.y;
      hxs += c.x;
      if (r > maxArm) maxArm = r;
    } else {
      nf++;
      fys += c.y;
      if (c.x < fMin) fMin = c.x;
      if (c.x > fMax) fMax = c.x;
      if (r > maxLeg) maxLeg = r;
      crouch += smoothstep(1.35, 1.0, d / BODY.legMin);
    }
  }
  out.handsOn = nh;
  out.feetOn = nf;
  const depth = estimateDepth(pose, contacts, ax, ay, prm.wallAngle);
  out.depth = depth;

  // ── out-of-plane balance ──
  let Nh = 0;
  let Nf = 0;
  const hyMean = nh ? hys / nh : 0;
  const fyMean = nf ? fys / nf : 0;
  if (nh > 0 && nf > 0) {
    const lever = Math.max(SIM.minLever, hyMean - fyMean);
    Nh = Math.max(0, (depth * cth + sth * (comY - fyMean)) / lever);
    Nf = Nh - sth;
  } else if (nh > 0) {
    Nh = Math.max(0, sth);
  } else {
    Nf = -sth;
  }
  out.normalHands = Nh;
  out.normalFeet = Nf;
  const nPerFoot = nf ? Nf / nf : 0;

  // ── capacities ──
  GRIP.wallAngle = prm.wallAngle;
  GRIP.assist = prm.assist;
  GRIP.pump = prm.pump;
  GRIP.overhang = sth > 0 ? sth : 0;
  let handCapSum = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    let dx = ax[i] - c.x;
    let dy = ay[i] - c.y;
    const dl = sq(dx, dy);
    if (dl > 1e-9) {
      dx /= dl;
      dy /= dl;
    } else {
      dx = 0;
      dy = -1;
    }
    let cap: number;
    if (isHandIdx(i)) {
      cap = c.hold ? handCapacity(c.hold, c.hx, c.hy, dx, dy, c.matched, GRIP) : 0.02;
      handCapSum += cap;
    } else {
      cap = footCapacity(c.hold, c.hx, c.hy, dx, dy, nPerFoot, GRIP);
    }
    out.cap[i] = Math.max(cap, 0.01);
  }

  // ── in-plane QP with active set ──
  for (let i = 0; i < 4; i++) {
    EXCL[i] = contacts[i] ? 0 : 1;
    LAM[i] = 0;
    MU[i] = 0;
  }
  let tau = 0;
  let feasible = false;
  for (let iter = 0; iter < 5; iter++) {
    let nc = 0;
    for (let i = 0; i < 4; i++) {
      if (EXCL[i]) continue;
      const c = contacts[i]!;
      let ux: number;
      let uy: number;
      if (isHandIdx(i)) {
        ux = c.x - ax[i];
        uy = c.y - ay[i];
      } else {
        ux = ax[i] - c.x;
        uy = ay[i] - c.y;
      }
      const l = sq(ux, uy);
      if (l < 1e-6) {
        ux = 0;
        uy = 1;
      } else {
        ux /= l;
        uy /= l;
      }
      UX[i] = ux;
      UY[i] = uy;
      const tx = -uy;
      const ty = ux;
      const rx = c.x - comX;
      const ry = c.y - comY;
      const cap = out.cap[i];
      const w = (isHandIdx(i) ? SIM.handCost : SIM.footCost) / (cap * cap);
      A0[nc] = ux;
      A1[nc] = uy;
      A2[nc] = rx * uy - ry * ux;
      WI[nc] = 1 / w;
      CL[nc] = i;
      CK[nc] = 0;
      nc++;
      A0[nc] = tx;
      A1[nc] = ty;
      A2[nc] = rx * ty - ry * tx;
      WI[nc] = 1 / (w * SIM.perpCost);
      CL[nc] = i;
      CK[nc] = 1;
      nc++;
    }
    if (nc === 0) break;
    A0[nc] = 0;
    A1[nc] = 0;
    A2[nc] = 1;
    WI[nc] = SIM.coreTorque * SIM.coreTorque;
    CL[nc] = -1;
    CK[nc] = 2;
    nc++;
    // M = Σ wi a aᵀ
    let m00 = 0;
    let m01 = 0;
    let m02 = 0;
    let m11 = 0;
    let m12 = 0;
    let m22 = 0;
    for (let k = 0; k < nc; k++) {
      const w = WI[k];
      const a0 = A0[k];
      const a1 = A1[k];
      const a2 = A2[k];
      m00 += w * a0 * a0;
      m01 += w * a0 * a1;
      m02 += w * a0 * a2;
      m11 += w * a1 * a1;
      m12 += w * a1 * a2;
      m22 += w * a2 * a2;
    }
    // Solve M y = b with b = (0, cos θ, 0) via the adjugate.
    const c00 = m11 * m22 - m12 * m12;
    const c01 = m02 * m12 - m01 * m22;
    const c02 = m01 * m12 - m02 * m11;
    const det = m00 * c00 + m01 * c01 + m02 * c02;
    if (Math.abs(det) < 1e-14) break;
    const c11 = m00 * m22 - m02 * m02;
    const c12 = m01 * m02 - m00 * m12;
    const inv = cth / det;
    const y0 = c01 * inv;
    const y1 = c11 * inv;
    const y2 = c12 * inv;
    let worst = -1;
    let worstV = -1e-9;
    for (let k = 0; k < nc; k++) {
      const x = WI[k] * (A0[k] * y0 + A1[k] * y1 + A2[k] * y2);
      XS[k] = x;
      if (CK[k] === 0 && x < worstV) {
        worstV = x;
        worst = CL[k];
      }
    }
    if (worst >= 0) {
      EXCL[worst] = 1;
      continue;
    }
    for (let k = 0; k < nc; k++) {
      if (CK[k] === 0) LAM[CL[k]] = XS[k];
      else if (CK[k] === 1) MU[CL[k]] = XS[k];
      else tau = XS[k];
    }
    feasible = true;
    break;
  }
  out.feasible = feasible;
  out.torque = tau;

  // ── loads + stress ──
  let worstStress = 0;
  let worstLimb = -1;
  const nAttached = nh + nf;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    let load: number;
    if (feasible) {
      load = sq(LAM[i], MU[i]);
      const l = LAM[i];
      const m = MU[i];
      out.fax[i] = l * UX[i];
      out.fay[i] = l * UY[i];
      out.fx[i] = l * UX[i] - m * UY[i];
      out.fy[i] = l * UY[i] + m * UX[i];
    } else {
      // No equilibrium (the body is swinging/falling): spread the weight over the hands.
      load = nh ? (isHandIdx(i) ? 1 / nh : 0.1) : 1 / Math.max(1, nAttached);
    }
    if (isHandIdx(i) && Nh > 0) {
      const share = handCapSum > 0 ? out.cap[i] / handCapSum : 1 / nh;
      load = sq(load, Nh * share);
    }
    out.load[i] = load;
    const s = load / out.cap[i];
    out.stress[i] = s;
    if (s > worstStress) {
      worstStress = s;
      worstLimb = i;
    }
  }
  if (!feasible && nAttached > 0) worstStress = Math.max(worstStress, 1.2);
  out.worstStress = worstStress;
  out.worstLimb = worstLimb;

  // ── balance (CoM vs feet base) ──
  if (nf > 0) {
    const mid = (fMin + fMax) / 2;
    const halfW = (fMax - fMin) / 2;
    out.balance = clamp((comX - mid) / Math.max(halfW + 0.1, 0.12), -1, 1);
    const excess = Math.max(0, Math.abs(comX - mid) - (halfW + 0.04));
    out.balancePen = SIM.balancePenalty * smoothstep(0, 0.4, excess);
  } else {
    out.balance = nh ? clamp((comX - hxs / nh) / 0.3, -1, 1) : 0;
    out.balancePen = 0;
  }

  // ── barn door (contacts in a narrow column, CoM off to one side) ──
  if (nh > 0 && nf > 0) {
    const spread = cMax - cMin;
    const meanX = cSum / nAttached;
    const off = comX < cMin ? cMin - comX : comX > cMax ? comX - cMax : 0;
    const lateral = comX - meanX;
    const narrow = 1 - smoothstep(0.18, 0.5, spread);
    let amt = smoothstep(0.03, 0.4, off) + narrow * smoothstep(0.08, 0.32, Math.abs(lateral)) * 0.6;
    amt = clamp(amt, 0, 1) * (nAttached >= 4 ? 0.5 : 1);
    out.barn = (lateral >= 0 ? 1 : -1) * amt;
    out.barnPen = SIM.barnPenalty * amt;
  } else {
    out.barn = 0;
    out.barnPen = 0;
  }

  // ── stretch / crouch ──
  const span = nh > 0 && nf > 0 ? Math.min(maxArm, maxLeg) : 0;
  out.stretchPen = SIM.spanPenalty * smoothstep(0.97, 1.02, span) + SIM.crouchPenalty * Math.min(1, crouch);

  // ── core torque ──
  out.corePen = SIM.corePenalty * smoothstep(0.06, 0.3, Math.abs(tau));

  // ── reach strain of a dragged limb ──
  if (prm.reachLimb >= 0) {
    const i = prm.reachLimb;
    const r = sq(prm.reachX - ax[i], prm.reachY - ay[i]) / maxReachIdx(i);
    out.reachPen = SIM.reachStrain * smoothstep(1.0, 1.2, r);
  } else out.reachPen = 0;

  out.tension = worstStress + out.balancePen + out.barnPen + out.stretchPen + out.corePen + out.reachPen;
  return out;
}

// ═══════════════════════════ pose optimisation (planner, reset, respawn) ═══════════════════════════

/** Upright spine direction, leaning toward the hands (or the reach target). Writes the chest into `p`. */
export function placeChest(p: Pose, contacts: Contacts, prm: StaticsParams, lean: number): void {
  let hx = 0;
  let hy = 0;
  let n = 0;
  for (let i = 0; i < 2; i++) {
    const c = contacts[i];
    if (c) {
      hx += c.x;
      hy += c.y;
      n++;
    }
  }
  if (prm.reachLimb >= 0 && prm.reachLimb < 2) {
    hx += prm.reachX * 1.5;
    hy += prm.reachY * 1.5;
    n += 1.5;
  }
  let ux = 0;
  let uy = 1;
  if (n > 0) {
    const dx = hx / n - p.px;
    const dy = hy / n - p.py;
    const l = sq(dx, dy);
    if (l > 1e-6) {
      ux += (SIM.uprightLean * dx) / l;
      uy += (SIM.uprightLean * dy) / l;
    }
  }
  // extra lean (radians) from the optimiser
  if (lean !== 0) {
    const c = dcos(lean);
    const s = dsin(lean);
    const rx = ux * c - uy * s;
    const ry = ux * s + uy * c;
    ux = rx;
    uy = ry;
  }
  const l = sq(ux, uy) || 1;
  p.cx = p.px + (BODY.spine * ux) / l;
  p.cy = p.py + (BODY.spine * uy) / l;
}

const minPelvisY = GAME.padHeight + 0.42;

/** Constraint violation (m) of a pose for the given contacts (+ optional reach target). */
export function poseViolation(contacts: Contacts, prm: StaticsParams, ev: StanceEval, py: number): number {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    const d = ev.ratio[i] * maxReachIdx(i);
    if (isHandIdx(i)) v += Math.max(0, d - BODY.armMax) + Math.max(0, SIM.armMinPlane - d);
    else v += Math.max(0, d - BODY.legMax) + Math.max(0, SIM.legMinPlane - d);
  }
  if (prm.reachLimb >= 0) {
    const i = prm.reachLimb;
    const d = sq(prm.reachX - ev.ax[i], prm.reachY - ev.ay[i]);
    v += Math.max(0, d - maxReachIdx(i)) + Math.max(0, (isHandIdx(i) ? SIM.armMinPlane : SIM.legMinPlane) + 0.03 - d);
  }
  v += Math.max(0, minPelvisY - py);
  return v;
}

export interface OptimizeResult {
  cost: number;
  tension: number;
  violation: number;
}

const TRY: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7071, 0.7071],
  [-0.7071, 0.7071],
  [0.7071, -0.7071],
  [-0.7071, -0.7071],
] as const;

function costAt(px: number, py: number, lean: number, contacts: Contacts, prm: StaticsParams, ev: StanceEval, res: OptimizeResult): number {
  TRY.px = px;
  TRY.py = py;
  placeChest(TRY, contacts, prm, lean);
  evaluateStance(TRY, contacts, prm, ev);
  const viol = poseViolation(contacts, prm, ev, py);
  let mean = 0;
  let n = 0;
  let comfort = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    mean += ev.stress[i];
    n++;
    // comfort: slightly bent legs, long arms (cosmetic preference, tiny next to tension)
    const r = ev.ratio[i];
    if (i < 2) {
      if (c.y > ev.ay[i]) comfort += 0.12 * (r - 0.88) * (r - 0.88);
    } else comfort += 0.25 * (r - 0.8) * (r - 0.8);
  }
  if (n) mean /= n;
  res.tension = ev.tension;
  res.violation = viol;
  res.cost = ev.tension + 0.25 * mean + comfort + LEAN_COST * lean * lean + 30 * viol;
  return res.cost;
}

const TMP_RES: OptimizeResult = { cost: 0, tension: 0, violation: 0 };
/** Torso lean limits (radians) and cost: climbers keep the torso fairly upright. */
export const LEAN_MAX = 0.42;
const LEAN_COST = 0.35;

/**
 * Finds a low-tension pose for the contacts: a coarse grid over the region the contacts allow,
 * then a pattern search over pelvis x/y + spine lean, seeded from the best of grid and `init`.
 * The best pose is written to `out` and evaluated into `ev`.
 */
export function optimizePose(
  contacts: Contacts,
  prm: StaticsParams,
  init: Pose,
  out: Pose,
  ev: StanceEval,
  maxEvals = 90,
  /** Warm start: skip the global grid, probe a small ring around `init` instead. */
  local = false,
): OptimizeResult {
  let bx = init.px;
  let by = init.py;
  let bl = 0;
  let best = costAt(bx, by, bl, contacts, prm, ev, TMP_RES);
  let evals = 1;
  if (local) {
    for (let k = 0; k < 8; k++) {
      const d = DIRS[k];
      const nx = init.px + d[0] * 0.22;
      const ny = init.py + d[1] * 0.22;
      const c = costAt(nx, ny, 0, contacts, prm, ev, TMP_RES);
      evals++;
      if (c < best) {
        best = c;
        bx = nx;
        by = ny;
      }
    }
  }

  // ── coarse grid over the feasible band ──
  let xMin = Infinity;
  let xMax = -Infinity;
  let yLo = -Infinity;
  let yHi = Infinity;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    if (c.x < xMin) xMin = c.x;
    if (c.x > xMax) xMax = c.x;
    if (i < 2) {
      // chest within arm reach → pelvis roughly within [hand − spine − armMax, hand − spine + armMax]
      yLo = Math.max(yLo, c.y - BODY.spine - BODY.armMax);
      yHi = Math.min(yHi, c.y - BODY.spine + BODY.armMax * 0.6);
    } else {
      yLo = Math.max(yLo, c.y + SIM.legMinPlane);
      yHi = Math.min(yHi, c.y + BODY.legMax);
    }
  }
  if (prm.reachLimb >= 0) {
    const ry = prm.reachY;
    if (prm.reachLimb < 2) yLo = Math.max(yLo, ry - BODY.spine - BODY.armMax - 0.05);
    else yHi = Math.min(yHi, ry + BODY.legMax + 0.05);
    xMin = Math.min(xMin, prm.reachX);
    xMax = Math.max(xMax, prm.reachX);
  }
  if (!local && Number.isFinite(xMin)) {
    if (!Number.isFinite(yLo)) yLo = by - 0.5;
    if (!Number.isFinite(yHi)) yHi = by + 0.5;
    yLo = Math.max(yLo, minPelvisY);
    if (yHi < yLo) {
      const m = (yHi + yLo) / 2;
      yLo = m - 0.15;
      yHi = m + 0.15;
    }
    const nx = xMax - xMin > 0.5 ? 5 : 3;
    const ny = 5;
    const x0 = xMin - 0.1;
    const x1 = xMax + 0.1;
    for (let a = 0; a < nx && evals < maxEvals; a++) {
      const gx = x0 + ((x1 - x0) * a) / (nx - 1);
      for (let b = 0; b < ny && evals < maxEvals; b++) {
        const gy = yLo + ((yHi - yLo) * (b + 0.5)) / ny;
        const c = costAt(gx, gy, 0, contacts, prm, ev, TMP_RES);
        evals++;
        if (c < best) {
          best = c;
          bx = gx;
          by = gy;
        }
      }
    }
  }

  // ── pattern search ──
  let step = 0.12;
  let lstep = 0.22;
  while (step > 0.012 && evals < maxEvals) {
    let improved = false;
    for (let k = 0; k < 8 && evals < maxEvals; k++) {
      const d = DIRS[k];
      const nx = bx + d[0] * step;
      const ny = by + d[1] * step;
      const c = costAt(nx, ny, bl, contacts, prm, ev, TMP_RES);
      evals++;
      if (c < best - 1e-6) {
        best = c;
        bx = nx;
        by = ny;
        improved = true;
      }
    }
    for (let s = -1; s <= 1 && evals < maxEvals; s += 2) {
      const nl = clamp(bl + s * lstep, -LEAN_MAX, LEAN_MAX);
      const c = costAt(bx, by, nl, contacts, prm, ev, TMP_RES);
      evals++;
      if (c < best - 1e-6) {
        best = c;
        bl = nl;
        improved = true;
      }
    }
    if (!improved) {
      step *= 0.5;
      lstep *= 0.5;
    }
  }
  const res: OptimizeResult = { cost: 0, tension: 0, violation: 0 };
  costAt(bx, by, bl, contacts, prm, ev, res);
  out.px = TRY.px;
  out.py = TRY.py;
  out.cx = TRY.cx;
  out.cy = TRY.cy;
  return res;
}

/**
 * Best spine lean for a fixed pelvis (the climber can't control it by touch, so the sim picks it the
 * way the planner does). Writes the chest into `out` and returns the tension there.
 */
export function bestLean(contacts: Contacts, prm: StaticsParams, px: number, py: number, ev: StanceEval, out: Pose, prevLean = 0): number {
  let bestL = prevLean;
  let best = Infinity;
  const tryL = (l: number): void => {
    TRY.px = px;
    TRY.py = py;
    placeChest(TRY, contacts, prm, l);
    evaluateStance(TRY, contacts, prm, ev);
    const v = poseViolation(contacts, prm, ev, py);
    const c = ev.tension + 30 * v + 0.12 * Math.abs(l - prevLean) + LEAN_COST * l * l;
    if (c < best) {
      best = c;
      bestL = l;
    }
  };
  tryL(clamp(prevLean, -LEAN_MAX, LEAN_MAX));
  for (let l = -0.4; l <= 0.41; l += 0.2) tryL(l);
  const c0 = bestL;
  tryL(clamp(c0 - 0.1, -LEAN_MAX, LEAN_MAX));
  tryL(clamp(c0 + 0.1, -LEAN_MAX, LEAN_MAX));
  const c1 = bestL;
  tryL(clamp(c1 - 0.05, -LEAN_MAX, LEAN_MAX));
  tryL(clamp(c1 + 0.05, -LEAN_MAX, LEAN_MAX));
  out.px = px;
  out.py = py;
  placeChest(out, contacts, prm, bestL);
  evaluateStance(out, contacts, prm, ev);
  LEAN_OUT.lean = bestL;
  return ev.tension;
}

/** Lean chosen by the last bestLean() call (radians). */
export const LEAN_OUT = { lean: 0 };

/** A reasonable initial pelvis guess for a set of contacts. */
export function initialPose(contacts: Contacts, prm: StaticsParams, out: Pose): Pose {
  let hx = 0;
  let hy = 0;
  let nh = 0;
  let fx = 0;
  let fy = 0;
  let nf = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    if (i < 2) {
      hx += c.x;
      hy += c.y;
      nh++;
    } else {
      fx += c.x;
      fy += c.y;
      nf++;
    }
  }
  if (nh) {
    hx /= nh;
    hy /= nh;
  }
  if (nf) {
    fx /= nf;
    fy /= nf;
  }
  if (nh && nf) {
    out.px = 0.45 * hx + 0.55 * fx;
    out.py = clamp(fy + 0.62, hy - 1.15, hy - 0.35);
    if (out.py < fy + BODY.legMin + 0.05) out.py = fy + BODY.legMin + 0.05;
  } else if (nh) {
    out.px = hx;
    out.py = hy - 1.1;
  } else {
    out.px = fx;
    out.py = fy + 0.75;
  }
  if (out.py < minPelvisY) out.py = minPelvisY;
  placeChest(out, contacts, prm, 0);
  return out;
}

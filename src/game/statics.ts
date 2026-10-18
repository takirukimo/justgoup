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
// Foot techniques (Phase B): a foot contact has a mode. Pushing feet (edge, smear, drop knee) push the
// hip away from the toe; a HOOK (heel or toe) pulls the hip toward the hold like an arm and also pulls the
// body in (it takes over part of the hands' keep-in pull, all of the legs' share on a roof). A drop knee
// turns the hip into the wall (smaller d → less keep-in pull). A FLAG is not a contact: the leg out to the
// side shifts the CoM (its mass) and widens the column the barn-door turns about (StaticsParams.flags).
// Multi-angle walls (Phase B, wall-profile.ts; StaticsParams.profile): every contact feels the panel its
// hold is on (grip base: sloper slope, overhang loss; feet: steep-wall loss, smears; per-foot normal
// force in its own panel), and the out-of-plane balance is solved in the true side view: the "effective
// wall" of a stance is the plane through its hands and feet (the chord from the feet to the hands in 3D),
// the CoM sits `depth` off the wall along the blended normal under it, and the keep-in pull is the same
// formula with the chord's angle, lever and CoM offset (on a flat wall it reduces exactly to the one
// above). The in-plane weight is cos of that effective angle (StanceEval.cth / sth for the dynamics).
// Reach across a fold uses the fold-aware metric (anatomy.envEvalOn). With profile null nothing changes.
// Anatomy (anatomy.ts): each contact is measured against its limb's reach envelope in the pose's
// body frame — ratio[] / excess[] — and gets an anatomical strain on top of its stress (awkward
// edge → harder work, past the edge → pops off). poseViolation() keeps every limb (and a dragged
// limb's target) inside its envelope, so the pose search never targets an illegal pose.

import type { HoldDef } from '../core/types';
import { BODY as BODY_, GAME, SIM as SIM_ } from '../config/tuning';
import { clamp as clamp_, DEG, smoothstep as smoothstep_ } from '../core/math';
import {
  contactPoint,
  footCapacity as footCapacity_,
  handCapacity as handCapacity_,
  hookCapacity as hookCapacity_,
  hookPullIn as hookPullIn_,
  isHandIdx as isHandIdx_,
  type GripContext,
} from './holds';
import { dcos, dsin, dcosSmall, dsinSmall } from './dmath';
import { envEval as envEval_, envEvalOn as envEvalOn_ } from './anatomy';
import { normalSide, panelIndexAt, surfaceSide, type Side, type WallProfile } from './wall-profile';

// Hot path (thousands of stance evaluations per plan): plain module-local bindings. Imported
// bindings are live, and some module runners (vitest's SSR transform) read them through a getter
// on every use; these are ordinary loads everywhere.
const BODY = BODY_;
const SIM = SIM_;
const clamp = clamp_;
const smoothstep = smoothstep_;
const footCapacity = footCapacity_;
const handCapacity = handCapacity_;
const hookCapacity = hookCapacity_;
const hookPullIn = hookPullIn_;
const isHandIdx = isHandIdx_;
const envEval = envEval_;
const envEvalOn = envEvalOn_;

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
  /** Feet: FOOT_PUSH (edge / smear), FOOT_HEEL, FOOT_TOE (hooks: the leg pulls) or FOOT_DROP. Hands: 0. */
  mode: number;
}

/** Contact.mode values (feet). */
export const FOOT_PUSH = 0;
export const FOOT_HEEL = 2;
export const FOOT_TOE = 3;
export const FOOT_DROP = 4;
const isHook = (m: number): boolean => m === FOOT_HEEL || m === FOOT_TOE;

/** Fill a contact for limb `li` on hold `h` (grip point + direction). */
export function setContact(c: Contact, h: HoldDef, li: number, matched: boolean): Contact {
  contactPoint(h, li, matched, c);
  c.hold = h;
  c.matched = matched;
  c.hx = dcos(h.angle);
  c.hy = dsin(h.angle);
  c.mode = FOOT_PUSH;
  return c;
}

export function setSmear(c: Contact, x: number, y: number): Contact {
  c.hold = null;
  c.x = x;
  c.y = y;
  c.matched = false;
  c.hx = 0;
  c.hy = -1;
  c.mode = FOOT_PUSH;
  return c;
}

export const newContact = (): Contact => ({ hold: null, x: 0, y: 0, matched: false, hx: 0, hy: -1, mode: FOOT_PUSH });

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
  /**
   * Highest pelvis y the pose search may use (Infinity = free). A dragged foot never lifts the body:
   * the live sim caps the reach posture at the current pelvis height.
   */
  maxPelvisY: number;
  /**
   * How far (m) inside its envelope the reaching limb's target should end up. 0 for the planner
   * (bare anatomical limit); the live climber reaches SIM.reachComfort deeper, so a release over the
   * hold never sits on the edge of the snap range.
   */
  reachMargin: number;
  /**
   * Most of the reaching limb's envelope excess (m) the pose violation counts (Infinity = all of
   * it). The live climber's torso lean only works toward a dragged FOOT target that is nearly
   * reachable: a foot pointed far out of range doesn't swing the whole torso over.
   */
  reachCap: number;
  /** Climber strength (× hand capacity, 1 = the default V3–V5 climber). */
  strength: number;
  /** Per-hand forearm pump (index 0 LH, 1 RH); null = use `pump` for both (the planner). */
  handPump: Float64Array | null;
  /** Per-hand chalk friction 0..1 (1 = fresh); null = fresh chalk on both hands (the planner). */
  handFric: Float64Array | null;
  /**
   * Flagging legs (no contact; counterweight): [onLF, xLF, yLF, onRF, xRF, yRF] with on = 1 and the
   * foot's wall-local position; null = no flags (the planner).
   */
  flags: Float64Array | null;
  /**
   * Multi-angle wall (wall-profile.ts), or null for one flat panel at wallAngle. When set, each contact
   * uses the angle of the panel it is on and the out-of-plane balance is solved in the side view.
   */
  profile: WallProfile | null;
  /** Cached trig of wallAngle (refreshed automatically when wallAngle changes). */
  trigAngle: number;
  cth: number;
  sth: number;
}

export function makeParams(wallAngle: number, assist = 0, pump = 0, profile: WallProfile | null = null): StaticsParams {
  return {
    wallAngle,
    assist,
    pump,
    reachLimb: -1,
    reachX: 0,
    reachY: 0,
    maxPelvisY: Infinity,
    reachMargin: 0,
    reachCap: Infinity,
    strength: 1,
    handPump: null,
    handFric: null,
    flags: null,
    profile: profile && !profile.flat ? profile : null,
    trigAngle: wallAngle,
    cth: dcos(wallAngle * DEG),
    sth: dsin(wallAngle * DEG),
  };
}

export class StanceEval {
  readonly load = new Float64Array(4);
  readonly cap = new Float64Array(4);
  readonly stress = new Float64Array(4);
  /** Envelope ratio r / r(φ) per contact (anatomy.ts): ≥ 1 at the anatomical edge. */
  readonly ratio = new Float64Array(4);
  /** Conservative distance (m) of each contact outside its limb's envelope. */
  readonly excess = new Float64Array(4);
  /** Anatomical strain (extra stress) of each contact's limb position. */
  readonly edge = new Float64Array(4);
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
  /** Unit body-up (chest − pelvis) of the evaluated pose. */
  ux = 0;
  uy = 1;
  /** Envelope excess (m) of the reach target of the dragged limb (0 when none). */
  reachExcess = 0;
  depth = 0.25;
  handsOn = 0;
  feetOn = 0;
  /** Total out-of-plane pull the hands provide (body weights). */
  normalHands = 0;
  /** Total foot normal force (negative = toe pull). */
  normalFeet = 0;
  /** Total pull-in of the hooking feet (heel / toe hooks, body weights). */
  normalHooks = 0;
  /** Per contact: out-of-plane pull-in of a hook (body weights; 0 for the others). */
  readonly hookN = new Float64Array(4);
  /**
   * cos / sin of the stance's effective wall angle: the wall angle on a flat wall; on a folded wall the
   * plane through the hands and feet (side view). The in-plane weight is `cth`, the pull off the wall `sth`.
   */
  cth = 1;
  sth = 0;
  /** Panel angle (degrees) under each contact (the wall angle on a flat wall). */
  readonly angle = new Float64Array(4);
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
const GRIP: GripContext = { wallAngle: 0, assist: 0, pump: 0, overhang: 0, friction: 1, strength: 1 };
const sq = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** Estimated pelvis distance from the wall for a pose (bent legs push the hips out). */
export function estimateDepth(p: Pose, contacts: Contacts, ax: Float64Array, ay: Float64Array, wallAngle: number, sinOverride = NaN): number {
  let n = 0;
  let sum = 0;
  let hooks = 0;
  const L3 = SIM.legDepthLen;
  for (let i = 2; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    if (isHook(c.mode)) {
      hooks++;
      continue;
    }
    const l = sq(ax[i] - c.x, ay[i] - c.y);
    let d = clamp(Math.sqrt(Math.max(0, L3 * L3 - l * l)), 0.14, 0.62);
    // drop knee: the hip turns in toward the wall
    if (c.mode === FOOT_DROP) d = Math.max(SIM.dropKneeMinDepth, d * SIM.dropKneeDepth);
    sum += d;
    n++;
  }
  if (n) {
    const d = sum / n;
    // a hooking leg pulls the hips in as well
    return hooks ? Math.max(0.14, d - SIM.hookDepthPull * hooks) : d;
  }
  if (hooks) return SIM.hookOnlyDepth;
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
  const s = Math.max(0, sinOverride === sinOverride ? sinOverride : dsin(wallAngle * DEG));
  return clamp(0.2 + (nh ? s * Math.max(0, hy / nh - comY) * 0.85 : 0), 0.15, 1.2);
}

export const __DBG = { evals: 0 };
export function evaluateStance(pose: Pose, contacts: Contacts, prm: StaticsParams, out: StanceEval): StanceEval {
  __DBG.evals++;
  if (prm.trigAngle !== prm.wallAngle) {
    prm.trigAngle = prm.wallAngle;
    prm.cth = dcos(prm.wallAngle * DEG);
    prm.sth = dsin(prm.wallAngle * DEG);
  }
  // effective wall angle of the stance (the wall angle on a flat wall; see the profile block below)
  let cth = prm.cth;
  let sth = prm.sth;
  const prof = prm.profile;
  const ax = out.ax;
  const ay = out.ay;
  computeAnchors(pose, ax, ay);
  let comX = pose.px + BODY.comT * (pose.cx - pose.px);
  const comY = pose.py + BODY.comT * (pose.cy - pose.py);
  // a flagging leg is a counterweight: its mass moves out with the foot (leg CoM ≈ halfway to the foot)
  const fl = prm.flags;
  if (fl !== null) {
    if (fl[0] > 0) comX += SIM.legMass * 0.5 * (fl[1] - ax[2]);
    if (fl[3] > 0) comX += SIM.legMass * 0.5 * (fl[4] - ax[3]);
  }
  out.comX = comX;
  out.comY = comY;
  let ux = pose.cx - pose.px;
  let uy = pose.cy - pose.py;
  {
    const l = sq(ux, uy);
    if (l > 1e-9) {
      ux /= l;
      uy /= l;
    } else {
      ux = 0;
      uy = 1;
    }
  }
  out.ux = ux;
  out.uy = uy;

  let nh = 0;
  let nf = 0;
  let nk = 0;
  let hys = 0;
  let hxs = 0;
  let fys = 0;
  let kys = 0;
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
      out.excess[i] = 0;
      out.edge[i] = 0;
      continue;
    }
    let en;
    if (prof === null) {
      en = envEval(i, ax[i], ay[i], ux, uy, c.x, c.y);
      out.angle[i] = prm.wallAngle;
    } else {
      en = envEvalOn(prof, i, ax[i], ay[i], ux, uy, c.x, c.y);
      out.angle[i] = prof.ang[panelIndexAt(prof, c.y)];
    }
    const d = en.r;
    const r = en.ratio;
    out.ratio[i] = r;
    out.excess[i] = en.excess;
    out.edge[i] = en.edge;
    if (c.x < cMin) cMin = c.x;
    if (c.x > cMax) cMax = c.x;
    cSum += c.x;
    if (isHandIdx(i)) {
      nh++;
      hys += c.y;
      hxs += c.x;
      if (r > maxArm) maxArm = r;
    } else {
      if (c.x < fMin) fMin = c.x;
      if (c.x > fMax) fMax = c.x;
      if (isHook(c.mode)) {
        nk++;
        kys += c.y;
        continue;
      }
      nf++;
      fys += c.y;
      if (r > maxLeg) maxLeg = r;
      crouch += smoothstep(1.35, 1.0, d / BODY.legMin);
    }
  }
  out.handsOn = nh;
  out.feetOn = nf + nk;
  // folded wall: the stance's effective plane in the side view (chord feet → hands)
  let leverE = 0;
  let fH = 0;
  let fZ = 0;
  if (prof !== null) {
    let hH = 0;
    let hZ = 0;
    for (let i = 0; i < 4; i++) {
      const c = contacts[i];
      if (!c || (i >= 2 && isHook(c.mode))) continue;
      surfaceSide(prof, c.y, SV);
      if (i < 2) {
        hH += SV.h;
        hZ += SV.z;
      } else {
        fH += SV.h;
        fZ += SV.z;
      }
    }
    if (nh) {
      hH /= nh;
      hZ /= nh;
    }
    if (nf) {
      fH /= nf;
      fZ /= nf;
    }
    // tangent of the wall under the centre of mass (blended across folds): the fallback frame
    normalSide(prof, comY, SV);
    const tH = SV.z;
    const tZ = -SV.h;
    if (nh > 0 && nf > 0) {
      let uh = hH - fH;
      let uz = hZ - fZ;
      if (uh * tH + uz * tZ >= SIM.minLever) {
        const l = Math.sqrt(uh * uh + uz * uz);
        uh /= l;
        uz /= l;
        cth = uh;
        sth = uz;
        leverE = l;
      } else {
        cth = tH;
        sth = tZ;
        leverE = SIM.minLever;
      }
    } else if (nh + nf + nk > 0) {
      // hanging from the hands (or standing on the feet alone): the panels under those contacts
      let cs = 0;
      let ss = 0;
      for (let i = nh > 0 ? 0 : 2; i < (nh > 0 ? 2 : 4); i++) {
        const c = contacts[i];
        if (!c) continue;
        const k = panelIndexAt(prof, c.y);
        cs += prof.c[k];
        ss += prof.s[k];
      }
      const l = Math.sqrt(cs * cs + ss * ss) || 1;
      cth = cs / l;
      sth = ss / l;
    } else {
      cth = tH;
      sth = tZ;
    }
  }
  const depth = estimateDepth(pose, contacts, ax, ay, prm.wallAngle, prof === null ? NaN : sth);
  out.depth = depth;

  // ── out-of-plane balance ──
  let Nh = 0;
  let Nf = 0;
  let Nk = 0;
  const hyMean = nh ? hys / nh : 0;
  const fyMean = nf ? fys / nf : 0;
  if (nh > 0 && nf > 0) {
    if (prof === null) {
      const lever = Math.max(SIM.minLever, hyMean - fyMean);
      Nh = Math.max(0, (depth * cth + sth * (comY - fyMean)) / lever);
    } else {
      // side view: the CoM `depth` off the wall along the blended normal, measured in the chord frame
      offsetSideInto(prof, comY, depth);
      const gh = SV.h - fH;
      const gz = SV.z - fZ;
      const along = gh * cth + gz * sth;
      const off = -gh * sth + gz * cth;
      Nh = Math.max(0, ((off > 0.05 ? off : 0.05) * cth + sth * along) / leverE);
    }
  } else if (nh > 0) {
    Nh = Math.max(0, sth);
  }
  out.hookN[0] = out.hookN[1] = out.hookN[2] = out.hookN[3] = 0;
  if (prof !== null && nk > 0 && nh > 0 && nf === 0 && Nh > 0) {
    // a folded wall, hanging on hands + hooks only (a roof): the out-of-plane weight splits between the
    // hands and the hooks by moments about the CoM — the hooks carry Nh·arm (arm = their lever share:
    // CoM near the hooks → they carry more), at most what they can pull; the hands the rest
    let kSum = 0;
    let capSum = 0;
    for (let i = 2; i < 4; i++) {
      const c = contacts[i];
      if (!c || !isHook(c.mode)) continue;
      out.hookN[i] = hookPullIn(c.hold, c.mode === FOOT_HEEL, prm.assist);
      capSum += out.hookN[i];
      kSum += c.y;
    }
    const kyMean = kSum / nk;
    const arm = clamp((hyMean - comY) / Math.max(0.2, hyMean - kyMean), 0, 1);
    const take = Math.min(Nh * arm, capSum, Nh * SIM.hookMaxShare);
    for (let i = 2; i < 4; i++) {
      if (out.hookN[i] <= 0) continue;
      out.hookN[i] = capSum > 0 ? (out.hookN[i] / capSum) * take : 0;
      Nk += out.hookN[i];
    }
    Nh -= take;
  } else if (nk > 0 && nh > 0 && Nh > 0) {
    // hooks pull the body in and take over part of the hands' keep-in pull: a hook near the hands'
    // height substitutes ≈1:1, a low one less; with no pushing foot (a roof) they carry the legs' share
    let capSum = 0;
    let effSum = 0;
    for (let i = 2; i < 4; i++) {
      const c = contacts[i];
      if (!c || !isHook(c.mode)) continue;
      const nMax = hookPullIn(c.hold, c.mode === FOOT_HEEL, prm.assist);
      let arm: number;
      if (nf > 0) arm = clamp((c.y - fyMean) / Math.max(SIM.minLever, hyMean - fyMean), 0.25, 1);
      else arm = clamp((hyMean - comY) / Math.max(0.2, hyMean - c.y), 0.2, 1);
      out.hookN[i] = nMax;
      capSum += nMax;
      effSum += nMax * arm;
    }
    const sub = Math.min(Nh * SIM.hookMaxShare, effSum);
    if (capSum > 0 && sub > 0) {
      for (let i = 2; i < 4; i++) {
        out.hookN[i] = (out.hookN[i] / capSum) * (sub / Math.max(effSum / capSum, 1e-6));
        Nk += out.hookN[i];
      }
      Nh -= sub;
    } else for (let i = 2; i < 4; i++) out.hookN[i] = 0;
  }
  if (nh > 0 && nf > 0) Nf = Nh + Nk - sth;
  else if (nh === 0) Nf = -sth;
  out.normalHands = Nh;
  out.normalFeet = Nf;
  out.normalHooks = Nk;
  const nPerFoot = nf ? Nf / nf : 0;

  // ── capacities ──
  GRIP.wallAngle = prm.wallAngle;
  GRIP.assist = prm.assist;
  GRIP.pump = prm.pump;
  GRIP.overhang = sth > 0 ? sth : 0;
  GRIP.strength = prm.strength;
  GRIP.friction = 1;
  const hp = prm.handPump;
  const hf = prm.handFric;
  let handCapSum = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    let nFoot = nPerFoot;
    if (prof !== null) {
      // the panel this contact is on
      const k = panelIndexAt(prof, c.y);
      const si = prof.s[k];
      const ci = prof.c[k];
      GRIP.wallAngle = prof.ang[k];
      GRIP.overhang = si > 0 ? si : 0;
      if (i >= 2 && nf > 0) {
        // the foot's own normal force: the chord-normal share turned into its panel, plus its push along
        // the chord pressing it into a less steep panel (a kicker under a steep board) or off a steeper one
        nFoot = nPerFoot * (ci * cth + si * sth) + ((FOOT_PUSH_SHARE * cth) / nf) * (sth * ci - cth * si);
      }
      // a pushing foot that has to PULL (toe-pull on a steep panel) carries that pull too
      FOOT_PULL[i] = i >= 2 && !isHook(c.mode) && c.hold !== null ? nFoot : 0;
    }
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
      GRIP.pump = hp ? hp[i] : prm.pump;
      GRIP.friction = hf ? hf[i] : 1;
      cap = c.hold ? handCapacity(c.hold, c.hx, c.hy, dx, dy, c.matched, GRIP) : 0.02;
      handCapSum += cap;
    } else if (isHook(c.mode)) {
      cap = c.hold ? hookCapacity(c.hold, c.mode === FOOT_HEEL, c.hx, c.hy, dx, dy, GRIP) : 0.02;
    } else {
      cap = footCapacity(c.hold, c.hx, c.hy, dx, dy, nFoot, GRIP);
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
      if (isHandIdx(i) || isHook(c.mode)) {
        // hands and hooking feet pull the body toward the contact
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
  const nAttached = nh + nf + nk;
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
    } else if (out.hookN[i] > 0) load = sq(load, out.hookN[i]);
    else if (prof !== null && FOOT_PULL[i] < 0) load = sq(load, FOOT_PULL[i]);
    out.load[i] = load;
    const s = load / out.cap[i] + out.edge[i];
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
  if (nf + nk > 0) {
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
  if (fl !== null) {
    // a flagging foot presses on the wall out to the side: the door turns about a wider column
    for (let j = 0; j < 2; j++) {
      if (fl[j * 3] <= 0) continue;
      const x = fl[j * 3 + 1];
      if (x < cMin) cMin += (x - cMin) * SIM.flagSpread;
      else if (x > cMax) cMax += (x - cMax) * SIM.flagSpread;
    }
  }
  if (nh > 0 && nf + nk > 0) {
    const spread = cMax - cMin;
    const meanX = cSum / nAttached;
    const off = comX < cMin ? cMin - comX : comX > cMax ? comX - cMax : 0;
    const lateral = comX - meanX;
    const narrow = 1 - smoothstep(0.18, 0.5, spread);
    let amt = smoothstep(0.03, 0.4, off) + narrow * smoothstep(0.08, 0.32, Math.abs(lateral)) * 0.6;
    amt = clamp(amt, 0, 1) * (nAttached >= 4 ? 0.5 : 1);
    out.barn = (lateral >= 0 ? 1 : -1) * amt;
    out.barnPen = SIM.barnPenalty * amt;
  } else if (nh === 1 && nf + nk === 0) {
    // hanging off one hand with no feet: the body swings open about the hand (more on overhangs);
    // with the left hand on, the right side swings away (+), and vice versa
    const lh = contacts[0] !== null;
    const amt = clamp(0.7 + 0.4 * (sth > 0 ? sth : 0), 0, 1);
    out.barn = (lh ? 1 : -1) * amt;
    out.barnPen = SIM.barnPenalty * 0.25 * amt;
  } else {
    out.barn = 0;
    out.barnPen = 0;
  }

  // ── stretch / crouch ──
  const span = nh > 0 && nf > 0 ? Math.min(maxArm, maxLeg) : 0;
  out.stretchPen = SIM.spanPenalty * smoothstep(0.97, 1.02, span) + SIM.crouchPenalty * Math.min(1, crouch);

  // ── core torque ──
  out.corePen = SIM.corePenalty * smoothstep(0.06, 0.3, Math.abs(tau));

  // ── reach strain of a dragged limb (beyond its anatomical envelope) ──
  if (prm.reachLimb >= 0) {
    const i = prm.reachLimb;
    const en = prof === null ? envEval(i, ax[i], ay[i], ux, uy, prm.reachX, prm.reachY) : envEvalOn(prof, i, ax[i], ay[i], ux, uy, prm.reachX, prm.reachY);
    const m = prm.reachMargin;
    out.reachExcess = m > 0 ? (en.over > 0 ? en.excess + m : Math.max(0, en.r - (en.rMax - m))) : en.excess;
    // a foot pressing against its limit strains less than an arm hauling the body after it
    out.reachPen = SIM.reachStrain * (isHandIdx(i) ? 1 : 0.5) * smoothstep(1.0, 1.15, en.ratio);
  } else {
    out.reachPen = 0;
    out.reachExcess = 0;
  }

  out.tension = worstStress + out.balancePen + out.barnPen + out.stretchPen + out.corePen + out.reachPen;
  out.cth = cth;
  out.sth = sth;
  return out;
}

/** Side-view scratch of the profile path. */
const SV: Side = { h: 0, z: 0 };
/** Profile path: each pushing foot's normal force in its own panel (negative = it must toe-pull). */
const FOOT_PULL = new Float64Array(4);
/** Share of the in-plane weight the feet are assumed to push along the chord (per-foot normal on a fold). */
const FOOT_PUSH_SHARE = 0.6;

/** SV ← side-view point `depth` off the wall at surface height y (blended normal). */
function offsetSideInto(prof: WallProfile, y: number, depth: number): void {
  surfaceSide(prof, y, SV);
  const h = SV.h;
  const z = SV.z;
  normalSide(prof, y, SV);
  SV.h = h + depth * SV.h;
  SV.z = z + depth * SV.z;
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
    // |lean| ≤ LEAN_MAX < π/4: the reduction-free polynomials (bit-identical to dcos / dsin there)
    const small = lean <= 0.78 && lean >= -0.78;
    const c = small ? dcosSmall(lean) : dcos(lean);
    const s = small ? dsinSmall(lean) : dsin(lean);
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

/**
 * Constraint violation (m) of a pose for the given contacts (+ optional reach target): every limb
 * inside its anatomical reach envelope (anatomy.ts), folded limbs no shorter than their in-plane
 * minimum, the pelvis above the pad (and under prm.maxPelvisY).
 */
export function poseViolation(contacts: Contacts, prm: StaticsParams, ev: StanceEval, py: number): number {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const c = contacts[i];
    if (!c) continue;
    v += ev.excess[i];
    const d = sq(c.x - ev.ax[i], c.y - ev.ay[i]);
    v += Math.max(0, (isHandIdx(i) ? SIM.armMinPlane : SIM.legMinPlane) - d);
  }
  if (prm.reachLimb >= 0) {
    const i = prm.reachLimb;
    const d = sq(prm.reachX - ev.ax[i], prm.reachY - ev.ay[i]);
    v += Math.min(ev.reachExcess, prm.reachCap) + Math.max(0, (isHandIdx(i) ? SIM.armMinPlane : SIM.legMinPlane) + 0.03 - d);
  }
  v += Math.max(0, minPelvisY - py);
  if (py > prm.maxPelvisY) v += py - prm.maxPelvisY;
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
  // a hard ceiling (a reaching foot can't lift the hips): the search slides along it
  if (py > prm.maxPelvisY) py = prm.maxPelvisY;
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

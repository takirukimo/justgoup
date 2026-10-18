// CHARACTER: the climber.
//
//  BodyRig    — a skinned, vinyl-figure style human body (≈1.75 m, proportions from BODY so the
//               3D skeleton matches the sim's skeleton) built procedurally: fitted tee with seams
//               and CHIRAL prints, tapered pants with knee darts and cuffs, downturned climbing
//               shoes (or approach shoes), mitten hands with thumbs and chalked fingertips, a
//               chalk bag on a belt, and an optional harness with belay loop + figure-8 knot.
//               One material for everything (palette regions), so the body is ONE draw call
//               (+1 for the harness). Posed from a BodyGoal by joint-limited two-bone IK: every
//               limb's elbow / knee swivel is searched for the one closest to its pole that keeps
//               the anatomical limits (JOINT_LIMITS: hip / shoulder cones and rotation, knee /
//               elbow flexion, ankle, wrist, spine twist, head look) and clears the wall; a target
//               outside that range is pulled in (the hand / foot hangs short, no joint breaks).
//               Then capsule self-collision (torso, pelvis, neck, fitted head + horn spheres,
//               limbs; depth-layer hint for crossings) swivels elbows / knees out of contact.
//  ClimberModel — maps ClimberState (wall-local sim output) to BodyGoals every frame: hands on
//               holds, toes on holds with dropped heels, frog-stance knees, drop knees with the
//               hip turned in, high steps with the hips sitting back, matched hands / feet side
//               by side, damped secondary motion (breathing, sway, Elvis-leg tremor, body shake,
//               head tracking) and phase poses (falling, landed, hanging, topped + celebrate).

import * as THREE from 'three';
import type { ChalkId, ClimberState, ColorwayId, HeadId, HoldType, LimbId, LimbSnapshot, Vec2 } from '../core/types';
import { BODY, GAME } from '../config/tuning';
import { CHALKS, COLORWAYS, SKIN_TONE, type ColorwayDef } from '../config/skins';
import { PALETTE } from '../config/brand';
import type { WallFrame } from './wall-frame';
import { createHead, disposeHead, headBlinkWeights, setHeadBlink } from './heads/index';
import { MeshBuilder, loft, sstep, superCos, superSin, type AttribFn } from './heads/geo';
import { ATLAS_RECTS, REGION, TORSO_E, TORSO_Y0, TORSO_Y1, createBodyMaterial, createOutfitAtlas, type BodyMaterial, type OutfitStyle, type TorsoSection, type UvRect } from './materials';

// ═══════════════════════════════ skeleton layout ═══════════════════════════════

export const BONE = {
  pelvis: 0,
  spine: 1,
  chest: 2,
  neck: 3,
  uarmL: 4,
  farmL: 5,
  handL: 6,
  fingL: 7,
  tipL: 8,
  thumbL: 9,
  uarmR: 10,
  farmR: 11,
  handR: 12,
  fingR: 13,
  tipR: 14,
  thumbR: 15,
  thighL: 16,
  shinL: 17,
  footL: 18,
  thighR: 19,
  shinR: 20,
  footR: 21,
  bag: 22,
} as const;
const BONE_COUNT = 23;

/** Per side (0 = left, 1 = right) bone ids. */
const ARM = [
  { uarm: BONE.uarmL, farm: BONE.farmL, hand: BONE.handL, fing: BONE.fingL, tip: BONE.tipL, thumb: BONE.thumbL },
  { uarm: BONE.uarmR, farm: BONE.farmR, hand: BONE.handR, fing: BONE.fingR, tip: BONE.tipR, thumb: BONE.thumbR },
] as const;
const LEG = [
  { thigh: BONE.thighL, shin: BONE.shinL, foot: BONE.footL },
  { thigh: BONE.thighR, shin: BONE.shinR, foot: BONE.footR },
] as const;
const SIGN = [-1, 1] as const;

// Dimensions (m). Limb lengths come from BODY so hands/feet land where the sim puts them.
const UPPER = BODY.upperArm;
const FORE = BODY.forearm;
const THIGH = BODY.thigh;
const SHIN = BODY.shin;
const SHOULDER_DROP = 0.035; // visual shoulder joint sits a little below the neck base
const PALM = 0.058; // wrist → knuckles
const FING_A = 0.034;
const FING_B = 0.03;
/** Torso bone origins above the pelvis centre (rest). */
const SPINE_Y = 0.2;
const CHEST_Y = 0.36;

/** Grip point in the hand frame for a curl amount (contact with the hold). */
function gripLocal(curl: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0.076 - 0.012 * curl, -0.02 - 0.009 * curl);
}
/** Toe contact point in the foot frame (side: −1 left, +1 right). */
function toeLocal(side: number, shoe: 'climbing' | 'approach', out: THREE.Vector3): THREE.Vector3 {
  return shoe === 'climbing' ? out.set(-0.011 * side, 0.168, -0.066) : out.set(-0.006 * side, 0.172, -0.064);
}
/** Sole bottom height below the ankle (flat standing). */
const ANKLE_H = 0.074;

// ═══════════════════════════════ pose goal ═══════════════════════════════

export interface LimbGoal {
  /** Hands: grip point. Feet: toe contact point. */
  target: THREE.Vector3;
  /** Hands: finger direction. Feet: heel → toe. */
  dir: THREE.Vector3;
  /** Hands: back of the hand. Feet: instep (top of the foot). */
  up: THREE.Vector3;
  /** Elbow / knee direction hint. */
  pole: THREE.Vector3;
  /** Hands: proximal / distal finger curl (radians) and thumb opposition 0..1. */
  curlA: number;
  curlB: number;
  thumb: number;
  /** Feet: allow pointing the foot (raising the heel) when the leg is too short. */
  autoPoint: boolean;
  /** Shoulder elevation (m) for this arm. */
  lift: number;
  /** Treat `target` as the wrist / ankle position instead of the grip / toe point. */
  jointTarget: boolean;
  /**
   * The end effector is planted (on a hold, the floor, the rope): self-collision may only move the
   * elbow / knee. Free limbs (dangling, waving) may also have the hand / foot nudged out of the body.
   */
  pinned: boolean;
  /** Depth layer when this limb crosses another: the higher one passes in front (toward `away`). */
  layer: number;
}

export interface BodyGoal {
  pelvis: THREE.Vector3;
  chest: THREE.Vector3;
  /** Lateral (character right) axes of the hips and the shoulders. */
  pelvisRight: THREE.Vector3;
  chestRight: THREE.Vector3;
  /** Lateral pelvic tilt (radians, + = right hip up): hip hike for high steps. */
  pelvisTilt: number;
  hands: [LimbGoal, LimbGoal];
  feet: [LimbGoal, LimbGoal];
  /** World point the head looks at, and how strongly (0 = follow the chest). */
  look: THREE.Vector3;
  lookWeight: number;
  /** Extra head pitch (+ = nod down) and roll. */
  headNod: number;
  headRoll: number;
  /** Breathing phase value −1..1 and depth 0..1. */
  breath: number;
  breathDepth: number;
  /** Optional wall plane (rig space): elbows / knees / head stay in front of it. */
  wall: boolean;
  wallN: THREE.Vector3;
  wallP: THREE.Vector3;
  /** Preferred escape direction for self-collision (toward the camera / away from the wall); zero = none. */
  away: THREE.Vector3;
}

function limbGoal(): LimbGoal {
  return {
    target: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, 1),
    pole: new THREE.Vector3(0, -1, 0),
    curlA: 0.5,
    curlB: 0.5,
    thumb: 0.3,
    autoPoint: true,
    lift: 0,
    jointTarget: false,
    pinned: false,
    layer: 0,
  };
}

export function createBodyGoal(): BodyGoal {
  return {
    pelvis: new THREE.Vector3(0, 0.96, 0),
    chest: new THREE.Vector3(0, 1.46, 0),
    pelvisRight: new THREE.Vector3(1, 0, 0),
    chestRight: new THREE.Vector3(1, 0, 0),
    pelvisTilt: 0,
    hands: [limbGoal(), limbGoal()],
    feet: [limbGoal(), limbGoal()],
    look: new THREE.Vector3(0, 1.6, -2),
    lookWeight: 1,
    headNod: 0,
    headRoll: 0,
    breath: 0,
    breathDepth: 0.3,
    wall: false,
    wallN: new THREE.Vector3(0, 0, 1),
    wallP: new THREE.Vector3(),
    away: new THREE.Vector3(),
  };
}

// ═══════════════════════════════ math helpers (scratch, no allocation) ═══════════════════════════════

const _m4 = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _e = new THREE.Euler();
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEG2 = Math.PI / 180;

/** Orthonormal basis with Y = yAxis and Z as close to zHint as possible → quaternion. */
function basisQuat(yAxis: THREE.Vector3, zHint: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _y.copy(yAxis).normalize();
  _x.crossVectors(_y, zHint);
  if (_x.lengthSq() < 1e-10) {
    _x.crossVectors(_y, Math.abs(_y.z) < 0.9 ? AX_Z : AX_X);
  }
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m4.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m4);
}

/**
 * Analytic two-bone IK. Writes the middle joint and the reached end point. Allows a little
 * stretch (≤ maxStretch) so endpoints stay planted when the sim reaches slightly further than
 * the visual skeleton. Returns the stretch factor applied to both bones.
 */
function twoBoneIK(
  root: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  outMid: THREE.Vector3,
  outEnd: THREE.Vector3,
  maxStretch: number,
): number {
  _t0.subVectors(target, root);
  let dist = _t0.length();
  const reach = l1 + l2;
  let k = 1;
  if (dist > reach * 0.999) k = Math.min(maxStretch, dist / (reach * 0.999));
  const L1 = l1 * k;
  const L2 = l2 * k;
  if (dist < 1e-6) {
    _t0.copy(pole);
    dist = 1e-6;
  }
  _t0.normalize();
  const dc = Math.min(Math.max(dist, Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.9995);
  const a = (L1 * L1 - L2 * L2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _t1.copy(pole).addScaledVector(_t0, -pole.dot(_t0));
  if (_t1.lengthSq() < 1e-10) {
    _t1.crossVectors(_t0, Math.abs(_t0.y) < 0.9 ? AX_Y : AX_X);
  }
  _t1.normalize();
  outMid.copy(root).addScaledVector(_t0, a).addScaledVector(_t1, h);
  _t2.subVectors(target, outMid);
  const l = _t2.length();
  if (l > 1e-9) outEnd.copy(outMid).addScaledVector(_t2, L2 / l);
  else outEnd.copy(target);
  return k;
}

/** Rotate `v` toward `toward` so the angle between them is at most maxAngle (both unit). */
function clampAngle(v: THREE.Vector3, toward: THREE.Vector3, maxAngle: number): THREE.Vector3 {
  const d = Math.min(1, Math.max(-1, v.dot(toward)));
  const ang = Math.acos(d);
  if (ang <= maxAngle) return v;
  const t = (ang - maxAngle) / ang;
  return v.lerp(toward, t).normalize();
}

const DEG = Math.PI / 180;
const clampN = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

/** Smooth clamp: identity in the middle, eases into [lo, hi] over `soft` (no hard snap at a limit). */
function softClamp(x: number, lo: number, hi: number, soft: number): number {
  const a = lo + soft;
  const b = hi - soft;
  if (x > b) return b + soft * Math.tanh((x - b) / soft);
  if (x < a) return a - soft * Math.tanh((a - x) / soft);
  return x;
}

// ═══════════════════════════════ anatomy: joint limits ═══════════════════════════════
//
// The sim owns the canonical wall-plane reach envelope (src/game/anatomy.ts: polar r(φ) tables per
// limb). The body mirrors it here as 3D joint-angle limits, applied by BodyRig.solve() after (and
// instead of) plain IK, so the figure stays anatomical whatever targets it receives: illegal sim
// input, fall flailing, celebration, the guide's poses. A target outside the reachable region is
// moved to the nearest reachable point (the hand / foot hangs short) instead of breaking a joint.

/** Polar limit table: [azimuth°, max angle°] rows, azimuth ascending over 0..360 (first = last). */
type PolarTable = readonly (readonly [number, number])[];

export const JOINT_LIMITS = {
  /**
   * Hip: thigh direction in the pelvis frame, max angle from straight DOWN per azimuth
   * (0° = outward / abduction, 90° = forward / flexion, 180° = inward / adduction, 270° = backward /
   * extension). Frog abduction ≈ 95°, flexion 125° (out-forward 128° for the high step to belly
   * height, knee by the chest), crossing ≤ 30°, extension ≤ 22°. The thigh can never point up.
   */
  hipCone: [
    [0, 95], [30, 115], [55, 128], [90, 125], [120, 108], [150, 80], [180, 30], [210, 22], [270, 22], [315, 45], [340, 75], [360, 95],
  ] as PolarTable,
  /** Flexion beyond this needs a bent knee (straight-leg raise is limited by the hamstrings). */
  hipFlexStraight: 92,
  /**
   * Hip rotation = knee-apex twist about the thigh, knee out (+) / knee in (−). Neutral apex: forward
   * for a hanging thigh, up for a flexed or abducted one. Frog knees measure −21…+38°, a deep frog
   * squat (feet tucked in front of the hips, knees out) 74…85°, a standing knee turned out / in
   * ±45°, a drop knee ≈ −45°; a knee pointing back with the shin up / forward (impossible) ≥ 93°
   * and a reversed knee ≈ 180°.
   */
  hipRotOut: 85,
  hipRotIn: 55,
  /** Knee flexion 0..150° (one way only: the swivel never reverses the hinge). */
  kneeFlex: 150,
  /** Ankle (foot vs shin): pointing (plantar) / flexing (dorsi), toe-out / toe-in yaw, inversion roll. */
  anklePlantar: 45,
  ankleDorsi: 30,
  ankleYawOut: 40,
  ankleYawIn: 22,
  ankleRoll: 26,
  /**
   * Shoulder: humerus direction in the chest frame, max angle from straight OUT to the side per azimuth
   * (0° = up, 90° = forward, 180° = down, 270° = backward). Full overhead incl. crossovers (up to
   * 40° past vertical, the shoulder girdle helping), across the chest ≤ 135°, down along the body,
   * extension behind ≤ ~40°.
   */
  shoulderCone: [
    [0, 130], [30, 133], [60, 134], [90, 135], [120, 128], [150, 112], [180, 100], [210, 95], [225, 88], [250, 60], [270, 40], [300, 55],
    [320, 78], [340, 108], [360, 130],
  ] as PolarTable,
  /** Shoulder rotation = elbow-apex twist about the humerus (0 = elbow back with the arm hanging). */
  shoulderRotIn: 110,
  shoulderRotOut: 125,
  /** Elbow flexion 0..150° (no hyperextension). */
  elbowFlex: 150,
  /** Wrist: max deviation of the fingers from the forearm line, and forearm twist (pro/supination). */
  wristDev: 75,
  wristTwist: 100,
  /** Torso twist of the chest relative to the pelvis. */
  spineTwist: 35,
  /** Head look-at: yaw ±, pitch up / down (soft-clamped, no snapping). */
  headYaw: 75,
  headPitchUp: 60,
  headPitchDown: 45,
} as const;

/** Max angle (radians) of a polar table at azimuth `omegaDeg`. */
function polarMax(t: PolarTable, omegaDeg: number): number {
  let w = omegaDeg % 360;
  if (w < 0) w += 360;
  for (let i = 1; i < t.length; i++) {
    const b = t[i];
    if (w <= b[0]) {
      const a = t[i - 1];
      return (a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])) * DEG;
    }
  }
  return t[t.length - 1][1] * DEG;
}

// Self-collision proxy radii (m).
const R_UPPER = [0.05, 0.041] as const;
const R_FORE = [0.04, 0.03] as const;
const R_THIGH = [0.082, 0.06] as const;
const R_SHIN = [0.056, 0.042] as const;
const R_ELBOW_WALL = 0.05;
const R_KNEE_WALL = 0.068;
const WALL_MARGIN = 0.012;
/** Swivel search: step, coarse step (existence tests), hysteresis margin (radians). */
const SW_STEP = Math.PI / 12;
const SW_COARSE = Math.PI / 6;
const SW_HYST = 0.5;
/** The warm start remembers a swivel this far inside the valid range (boundaries are fragile). */
const SW_WARM = 0.06;
/** Joint-violation radians per metre of wall penetration when no swivel clears both. */
const SW_WALL_COST = 6;
/** A swivel missing the joint limits by less than this (radians) is accepted rather than pulling the end in. */
const SW_SOFT = 0.16;

// closest points of two segments (scratch, no allocation)
const _sd1 = new THREE.Vector3();
const _sd2 = new THREE.Vector3();
const _sr = new THREE.Vector3();
const _cp1 = new THREE.Vector3();
const _cp2 = new THREE.Vector3();
let segS = 0;
let segT = 0;

/** Closest points between segments p1q1 and p2q2 → _cp1/_cp2, params segS/segT; returns the distance. */
function segSeg(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): number {
  _sd1.subVectors(q1, p1);
  _sd2.subVectors(q2, p2);
  _sr.subVectors(p1, p2);
  const a = _sd1.lengthSq();
  const e = _sd2.lengthSq();
  const f = _sd2.dot(_sr);
  let s = 0;
  let t = 0;
  if (a <= 1e-10 && e <= 1e-10) {
    s = 0;
    t = 0;
  } else if (a <= 1e-10) {
    t = clampN(f / e, 0, 1);
  } else {
    const c = _sd1.dot(_sr);
    if (e <= 1e-10) {
      s = clampN(-c / a, 0, 1);
    } else {
      const b = _sd1.dot(_sd2);
      const den = a * e - b * b;
      s = den > 1e-12 ? clampN((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clampN(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clampN((b - c) / a, 0, 1);
      }
    }
  }
  segS = s;
  segT = t;
  _cp1.copy(p1).addScaledVector(_sd1, s);
  _cp2.copy(p2).addScaledVector(_sd2, t);
  return _cp1.distanceTo(_cp2);
}

/**
 * Collision spheres for a head (skull, snout, ears, beard and horns, or the human's cap), fitted once
 * from its geometry with a small k-means: the fur and the keratin (horns / beak) or cap are clustered
 * separately so the ibex's big swept horns get their own chain of spheres. Centres are in the head's PARENT frame
 * (the neck bone), so call it with the head's local transform already set. Writes [x, y, z, r] rows
 * into `out` and returns the number of spheres.
 */
export function fitHeadProxies(head: THREE.Object3D, out: Float32Array): number {
  const parent = head.parent;
  if (parent) parent.remove(head);
  head.updateMatrixWorld(true);
  const groups: { pts: number[]; k: number }[] = [
    { pts: [], k: 5 },
    { pts: [], k: 6 },
  ];
  const v = new THREE.Vector3();
  head.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m.name !== 'fur' && m.name !== 'keratin' && m.name !== 'cap')) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const g = m.name === 'fur' ? groups[0] : groups[1];
    const step = Math.max(1, Math.floor(pos.count / 2500));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      g.pts.push(v.x, v.y, v.z);
    }
  });
  if (parent) parent.add(head);
  let n = 0;
  const maxN = Math.floor(out.length / 4);
  for (const g of groups) {
    const np = g.pts.length / 3;
    if (np < 8) continue;
    const k = Math.min(g.k, maxN - n);
    if (k <= 0) break;
    const P = g.pts;
    const C = new Float32Array(k * 3);
    // farthest-point init from the point farthest from the centroid (deterministic)
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < np; i++) {
      cx += P[i * 3];
      cy += P[i * 3 + 1];
      cz += P[i * 3 + 2];
    }
    cx /= np;
    cy /= np;
    cz /= np;
    const dmin = new Float32Array(np).fill(Infinity);
    let pick = 0;
    let best = -1;
    for (let i = 0; i < np; i++) {
      const d = (P[i * 3] - cx) ** 2 + (P[i * 3 + 1] - cy) ** 2 + (P[i * 3 + 2] - cz) ** 2;
      if (d > best) {
        best = d;
        pick = i;
      }
    }
    for (let c = 0; c < k; c++) {
      C[c * 3] = P[pick * 3];
      C[c * 3 + 1] = P[pick * 3 + 1];
      C[c * 3 + 2] = P[pick * 3 + 2];
      best = -1;
      for (let i = 0; i < np; i++) {
        const d = (P[i * 3] - C[c * 3]) ** 2 + (P[i * 3 + 1] - C[c * 3 + 1]) ** 2 + (P[i * 3 + 2] - C[c * 3 + 2]) ** 2;
        if (d < dmin[i]) dmin[i] = d;
        if (dmin[i] > best) {
          best = dmin[i];
          pick = i;
        }
      }
    }
    const lab = new Int32Array(np);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < np; i++) {
        let bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = (P[i * 3] - C[c * 3]) ** 2 + (P[i * 3 + 1] - C[c * 3 + 1]) ** 2 + (P[i * 3 + 2] - C[c * 3 + 2]) ** 2;
          if (d < bd) {
            bd = d;
            lab[i] = c;
          }
        }
      }
      const acc = new Float32Array(k * 4);
      for (let i = 0; i < np; i++) {
        const c = lab[i];
        acc[c * 4] += P[i * 3];
        acc[c * 4 + 1] += P[i * 3 + 1];
        acc[c * 4 + 2] += P[i * 3 + 2];
        acc[c * 4 + 3] += 1;
      }
      for (let c = 0; c < k; c++) {
        if (acc[c * 4 + 3] < 1) continue;
        C[c * 3] = acc[c * 4] / acc[c * 4 + 3];
        C[c * 3 + 1] = acc[c * 4 + 1] / acc[c * 4 + 3];
        C[c * 3 + 2] = acc[c * 4 + 2] / acc[c * 4 + 3];
      }
    }
    // radius: 88th percentile of the member distances (tips poke out a little, no huge spheres)
    for (let c = 0; c < k; c++) {
      const ds: number[] = [];
      for (let i = 0; i < np; i++) {
        if (lab[i] !== c) continue;
        ds.push(Math.sqrt((P[i * 3] - C[c * 3]) ** 2 + (P[i * 3 + 1] - C[c * 3 + 1]) ** 2 + (P[i * 3 + 2] - C[c * 3 + 2]) ** 2));
      }
      if (ds.length < 4) continue;
      ds.sort((a, b) => a - b);
      out[n * 4] = C[c * 3];
      out[n * 4 + 1] = C[c * 3 + 1];
      out[n * 4 + 2] = C[c * 3 + 2];
      out[n * 4 + 3] = Math.max(0.015, ds[Math.floor(ds.length * 0.88)]);
      n++;
    }
  }
  return n;
}

// ═══════════════════════════════ geometry ═══════════════════════════════

export interface OutfitOptions {
  style: OutfitStyle;
  shoe: 'climbing' | 'approach';
  chalkBag: boolean;
  belt: boolean;
  /** Harness front: figure-8 tie-in knot (climber) or a belay device on a locker (belayer). */
  tieIn?: 'knot' | 'device';
}

interface Section {
  rx: number;
  rz: number;
  /** Front (−z in the torso, +z apex in limbs) vs back extent multipliers. */
  rzBack?: number;
  ox?: number;
  oz?: number;
  e?: number;
}

/** Writes region/chalk/AO into aux and a rigid skin binding. */
function attr(region: number, bone: number, chalk = 0, ao = 1): AttribFn {
  return (_p, _n, _v, _u, out) => {
    out.aux[0] = region;
    out.aux[1] = chalk;
    out.aux[2] = ao;
    out.aux[3] = 1;
    out.skinIndex[0] = bone;
    out.skinIndex[1] = 0;
    out.skinIndex[2] = 0;
    out.skinIndex[3] = 0;
    out.skinWeight[0] = 1;
    out.skinWeight[1] = 0;
    out.skinWeight[2] = 0;
    out.skinWeight[3] = 0;
  };
}

/**
 * Capsule-like loft along local +Y from y0 to y1 with rounded (hemispherical) closed ends.
 * u = 0 faces +Z (the limb's apex side), u = .25 faces +X.
 */
function capsule(
  b: MeshBuilder,
  o: {
    y0: number;
    y1: number;
    sec: (y: number) => Section;
    cap0: number;
    cap1: number;
    rows: number;
    capRows?: number;
    cols: number;
    uvRect?: UvRect;
    attrib: AttribFn;
  },
): number {
  const capRows = o.capRows ?? 5;
  const rows = o.rows + capRows * 2;
  return loft(b, {
    rows,
    cols: o.cols,
    uvRect: o.uvRect,
    point: (v, u, out) => {
      const r = Math.round(v * (rows - 1));
      let y: number;
      let sc = 1;
      let s: Section;
      if (r < capRows) {
        const th = (r / capRows) * (Math.PI / 2);
        y = o.y0 - o.cap0 * Math.cos(th);
        sc = Math.sin(th);
        s = o.sec(o.y0);
      } else if (r > rows - 1 - capRows) {
        const th = ((rows - 1 - r) / capRows) * (Math.PI / 2);
        y = o.y1 + o.cap1 * Math.cos(th);
        sc = Math.sin(th);
        s = o.sec(o.y1);
      } else {
        const t = (r - capRows) / Math.max(1, rows - 1 - capRows * 2);
        y = o.y0 + (o.y1 - o.y0) * t;
        s = o.sec(y);
      }
      const a = u * Math.PI * 2;
      const e = s.e ?? 2.2;
      const cz = superCos(a, e);
      const sx = superSin(a, e);
      const rz = cz >= 0 ? s.rz : s.rz * (s.rzBack ?? 1);
      out.set((s.ox ?? 0) + sx * s.rx * sc, y, (s.oz ?? 0) + cz * rz * sc);
    },
    attrib: o.attrib,
  });
}

/** Piecewise-smooth interpolation of a keyed profile. */
function profile(keys: [number, ...number[]][]): (y: number) => number[] {
  return (y: number) => {
    if (y <= keys[0][0]) return keys[0].slice(1);
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (y <= b[0]) {
        const t = (y - a[0]) / (b[0] - a[0]);
        const s = t * t * (3 - 2 * t);
        const out: number[] = [];
        for (let k = 1; k < a.length; k++) out.push(a[k] + (b[k] - a[k]) * s);
        return out;
      }
    }
    return keys[keys.length - 1].slice(1);
  };
}

interface TorsoRow {
  y: number;
  hw: number;
  f: number;
  b: number;
  region?: number;
  ao?: number;
  /** Outward lip (tee hem) */
}

/** Torso rows (rest, y above the pelvis centre). Includes the tee hem lip and the rib collar fold. */
const TORSO_ROWS: TorsoRow[] = [
  { y: -0.07, hw: 0, f: 0, b: 0, region: REGION.bottom, ao: 0.8 },
  { y: -0.06, hw: 0.07, f: 0.04, b: 0.05, region: REGION.bottom, ao: 0.85 },
  { y: -0.03, hw: 0.13, f: 0.07, b: 0.085, region: REGION.bottom },
  { y: 0.012, hw: 0.145, f: 0.078, b: 0.09, region: REGION.bottom },
  { y: 0.045, hw: 0.146, f: 0.08, b: 0.088, region: REGION.bottom },
  { y: 0.066, hw: 0.146, f: 0.082, b: 0.086, region: REGION.bottom, ao: 0.62 },
  { y: 0.07, hw: 0.159, f: 0.095, b: 0.097, region: REGION.top, ao: 0.8 },
  { y: 0.086, hw: 0.159, f: 0.096, b: 0.097, region: REGION.top },
  { y: 0.14, hw: 0.151, f: 0.093, b: 0.09, region: REGION.top },
  { y: 0.2, hw: 0.152, f: 0.097, b: 0.091, region: REGION.top },
  { y: 0.27, hw: 0.159, f: 0.107, b: 0.096, region: REGION.top },
  { y: 0.33, hw: 0.166, f: 0.112, b: 0.1, region: REGION.top },
  { y: 0.385, hw: 0.174, f: 0.105, b: 0.101, region: REGION.top },
  { y: 0.43, hw: 0.182, f: 0.093, b: 0.098, region: REGION.top },
  { y: 0.458, hw: 0.178, f: 0.08, b: 0.088, region: REGION.top },
  { y: 0.482, hw: 0.145, f: 0.072, b: 0.08, region: REGION.top },
  { y: 0.5, hw: 0.108, f: 0.07, b: 0.076, region: REGION.top },
  { y: 0.508, hw: 0.094, f: 0.077, b: 0.08, region: REGION.collar },
  { y: 0.52, hw: 0.088, f: 0.074, b: 0.077, region: REGION.collar },
  { y: 0.522, hw: 0.08, f: 0.067, b: 0.07, region: REGION.collar, ao: 0.7 },
  { y: 0.505, hw: 0.073, f: 0.06, b: 0.064, region: REGION.collar, ao: 0.4 },
  { y: 0.48, hw: 0.05, f: 0.04, b: 0.044, region: REGION.collar, ao: 0.25 },
  { y: 0.47, hw: 0, f: 0, b: 0, region: REGION.collar, ao: 0.2 },
];

/** Torso cross-section at a rest height (linear between the outer TORSO_ROWS): feeds the print painter. */
function torsoSection(y: number): TorsoSection {
  const rows = TORSO_ROWS;
  let i = 1;
  // the outer surface rises monotonically up to the collar top; the fold back inside is skipped
  const last = rows.findIndex((r, k) => k > 0 && r.y < rows[k - 1].y) - 1;
  const n = last > 0 ? last : rows.length - 1;
  if (y <= rows[1].y) return { hw: rows[1].hw, f: rows[1].f, b: rows[1].b };
  while (i < n && rows[i + 1].y < y) i++;
  const a = rows[i];
  const c = rows[Math.min(n, i + 1)];
  const t = c.y > a.y ? clampN((y - a.y) / (c.y - a.y), 0, 1) : 0;
  return { hw: a.hw + (c.hw - a.hw) * t, f: a.f + (c.f - a.f) * t, b: a.b + (c.b - a.b) * t };
}

/** Torso skin weights by rest height: pelvis → spine → chest. */
function torsoWeights(y: number, out: { i: [number, number, number, number]; w: [number, number, number, number] }): void {
  const a = sstep(0.04, 0.2, y); // pelvis → spine
  const c = sstep(0.24, 0.42, y); // spine → chest
  const wp = 1 - a;
  const ws = a * (1 - c);
  const wc = a * c;
  out.i[0] = BONE.pelvis;
  out.i[1] = BONE.spine;
  out.i[2] = BONE.chest;
  out.i[3] = 0;
  out.w[0] = wp;
  out.w[1] = ws;
  out.w[2] = wc;
  out.w[3] = 0;
}

// ═══════════════════════════════ BodyRig ═══════════════════════════════

export class BodyRig {
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  readonly skeleton: THREE.Skeleton;
  readonly mesh: THREE.SkinnedMesh;
  readonly harness: THREE.SkinnedMesh;
  readonly material: BodyMaterial;
  readonly outfit: OutfitOptions;
  private bound = new THREE.Sphere(new THREE.Vector3(), 1.25);
  private boundH = new THREE.Sphere(new THREE.Vector3(), 0.6);

  // solved joints (rig space)
  readonly joints = {
    shoulder: [new THREE.Vector3(), new THREE.Vector3()],
    elbow: [new THREE.Vector3(), new THREE.Vector3()],
    wrist: [new THREE.Vector3(), new THREE.Vector3()],
    grip: [new THREE.Vector3(), new THREE.Vector3()],
    hip: [new THREE.Vector3(), new THREE.Vector3()],
    knee: [new THREE.Vector3(), new THREE.Vector3()],
    ankle: [new THREE.Vector3(), new THREE.Vector3()],
    toe: [new THREE.Vector3(), new THREE.Vector3()],
    tieIn: new THREE.Vector3(),
    head: new THREE.Vector3(),
  };
  private qPelvis = new THREE.Quaternion();
  private qChest = new THREE.Quaternion();
  private qHand = [new THREE.Quaternion(), new THREE.Quaternion()];
  private qFoot = [new THREE.Quaternion(), new THREE.Quaternion()];
  // head look (damped angles)
  private yaw = 0;
  private pitch = 0;
  // chalk bag pendulum
  private bagTip = new THREE.Vector3();
  private bagVel = new THREE.Vector3();
  private bagInit = false;
  private tmpGoalDir = new THREE.Vector3();
  private tmpGoalUp = new THREE.Vector3();
  private footAxis = new THREE.Vector3();

  // ── anatomy (limits + self-collision) ──
  /** Pelvis / chest axes (rig space): X = character right, Y = up, Z = back (the figure faces −Z). */
  private PX = new THREE.Vector3(1, 0, 0);
  private PY = new THREE.Vector3(0, 1, 0);
  private PZ = new THREE.Vector3(0, 0, 1);
  private CX = new THREE.Vector3(1, 0, 0);
  private CY = new THREE.Vector3(0, 1, 0);
  private CZ = new THREE.Vector3(0, 0, 1);
  private chestRightW = new THREE.Vector3(1, 0, 0);
  /** Working pole / end target per limb (0 = left arm, 1 = right arm, 2 = left leg, 3 = right leg). */
  private poleW = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private tgtW = [0, 1, 2, 3].map(() => new THREE.Vector3());
  /** Chosen swivel direction (elbow / knee apex) and the side preferred when a limit clamps it. */
  readonly apex = [0, 1, 2, 3].map(() => new THREE.Vector3(0, 0, 1));
  private swivelSign = [1, 1, 1, 1];
  private lastTh = [0, 0, 0, 0];
  /**
   * Wall QA (last solve): how far the hips would have to move out from the wall for a limb's
   * anatomical mid joint to clear it, and the spare clearance of each knee / elbow.
   */
  readonly wallNeed = [0, 0, 0, 0];
  readonly wallSlack = [1, 1, 1, 1];
  private vWall = 0;
  /** Collision re-solves run the wrist / ankle range once (the first solve already settled it). */
  private quick = false;
  /** QA: the limb's target was outside the anatomical range and the end was pulled in (last solve). */
  readonly fallback = [false, false, false, false];
  private reqEnd = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private stretchK = [1, 1, 1, 1];
  private wallOn = false;
  private wallN = new THREE.Vector3(0, 0, 1);
  private wallP = new THREE.Vector3();
  private awayV = new THREE.Vector3();
  // chain solve scratch (one chain at a time)
  private cD = new THREE.Vector3();
  private cE1 = new THREE.Vector3();
  private cE2 = new THREE.Vector3();
  private cC = new THREE.Vector3();
  private cEnd = new THREE.Vector3();
  private cMid = new THREE.Vector3();
  private cA = new THREE.Vector3();
  private cB = new THREE.Vector3();
  private cN = new THREE.Vector3();
  private cSafe = new THREE.Vector3();
  private cTgt = new THREE.Vector3();
  private cQ = new THREE.Quaternion();
  private cRoot = new THREE.Vector3();
  private cV = new THREE.Vector3();
  private cGrip = new THREE.Vector3();
  private cToe = new THREE.Vector3();
  private cOut = new THREE.Vector3();
  private kA = new THREE.Vector3();
  private kB = new THREE.Vector3();
  private kC = new THREE.Vector3();
  private kD = new THREE.Vector3();
  private kE = new THREE.Vector3();
  private kN = new THREE.Vector3();
  private cH = 0;
  private cL1 = 0;
  private cL2 = 0;
  // collision proxies (rig space)
  private headLocal = new Float32Array(4 * 12);
  private headN = 0;
  private headW = new Float32Array(4 * 12);
  private chestA = new THREE.Vector3();
  private chestB = new THREE.Vector3();
  private bellyA = new THREE.Vector3();
  private bellyB = new THREE.Vector3();
  private pelvA = new THREE.Vector3();
  private pelvB = new THREE.Vector3();
  private neckB = new THREE.Vector3();
  private hs = new THREE.Vector3();
  private push = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private endPush = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private headAvoid = 0;
  private headAvoidT = 0;
  private headWallPitch = 0;
  /** Contacts resolved in the last solve (QA counter). */
  contacts = 0;
  /** Limit evaluations / chain solves in the last solve (QA counters). */
  evals = 0;
  chains = 0;
  readonly evalsL = [0, 0, 0, 0];
  /** Self-collision on/off (QA). */
  collide = true;

  constructor(outfit: OutfitOptions) {
    this.outfit = outfit;
    this.root.name = 'body-rig';
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.name = `b${i}`;
      this.bones.push(b);
      this.root.add(b);
    }
    // rest pose → bind
    const rest = createBodyGoal();
    this.restGoal(rest);
    this.solve(rest, 0);
    this.root.updateMatrixWorld(true);
    const inverses = this.bones.map((b) => b.matrix.clone().invert());
    const restMats = this.bones.map((b) => b.matrix.clone());
    this.skeleton = new THREE.Skeleton(this.bones, inverses);

    this.material = createBodyMaterial(createOutfitAtlas(outfit.style, torsoSection));

    const body = new MeshBuilder();
    this.buildBody(body, restMats);
    const geo = body.build({ skin: true, aux: true, color: false });
    this.mesh = new THREE.SkinnedMesh(geo, this.material);
    this.mesh.name = 'body';
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.boundingSphere = this.bound;
    this.root.add(this.mesh);

    const hb = new MeshBuilder();
    this.buildHarness(hb, restMats);
    this.harness = new THREE.SkinnedMesh(hb.build({ skin: true, aux: true, color: false }), this.material);
    this.harness.name = 'harness';
    this.harness.bind(this.skeleton, new THREE.Matrix4());
    this.harness.castShadow = true;
    this.harness.receiveShadow = true;
    this.harness.boundingSphere = this.boundH;
    this.harness.visible = false;
    this.root.add(this.harness);
  }

  /** Standing rest pose (also the bind pose). */
  restGoal(g: BodyGoal, x = 0, z = 0, floorY = 0): void {
    g.pelvis.set(x, floorY + 0.96, z);
    g.chest.set(x, floorY + 1.46, z);
    g.pelvisRight.set(1, 0, 0);
    g.chestRight.set(1, 0, 0);
    g.pelvisTilt = 0;
    for (let s = 0; s < 2; s++) {
      const sg = SIGN[s];
      const h = g.hands[s];
      h.target.set(x + sg * 0.3, floorY + 0.88, z - 0.02);
      h.dir.set(sg * 0.25, -1, 0).normalize();
      h.up.set(sg, 0, 0);
      h.pole.set(sg * 0.3, 0, 1);
      h.curlA = 0.35;
      h.curlB = 0.35;
      h.thumb = 0.2;
      h.lift = 0;
      h.jointTarget = false;
      const f = g.feet[s];
      f.dir.set(sg * 0.12, 0, -1).normalize();
      f.up.set(0, 1, 0);
      f.pole.set(sg * 0.15, 0, -1);
      f.autoPoint = false;
      f.jointTarget = true;
      f.target.set(x + sg * 0.12, floorY + ANKLE_H + 0.006, z);
    }
    g.look.set(x, floorY + 1.6, z - 3);
    g.lookWeight = 1;
    g.headNod = 0;
    g.headRoll = 0;
    g.breath = 0;
    g.breathDepth = 0;
  }

  // ───────────────────────────── geometry ─────────────────────────────

  private buildBody(b: MeshBuilder, rest: THREE.Matrix4[]): void {
    this.buildTorso(b);
    for (let s = 0; s < 2; s++) {
      this.buildArm(b, rest, s);
      this.buildLeg(b, rest, s);
    }
    if (this.outfit.chalkBag) this.buildBag(b, rest);
    if (this.outfit.belt) this.buildBelt(b);
  }

  private buildTorso(b: MeshBuilder): void {
    const rows = TORSO_ROWS;
    // subdivide rows (Catmull-Rom on all fields) for smoothness
    const sub: TorsoRow[] = [];
    const lerpRow = (a: TorsoRow, c: TorsoRow, t: number): TorsoRow => ({
      y: a.y + (c.y - a.y) * t,
      hw: a.hw + (c.hw - a.hw) * t,
      f: a.f + (c.f - a.f) * t,
      b: a.b + (c.b - a.b) * t,
      region: t < 0.5 ? a.region : c.region,
      ao: (a.ao ?? 1) + ((c.ao ?? 1) - (a.ao ?? 1)) * t,
    });
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const c = rows[i + 1];
      const big = Math.abs(c.y - a.y) > 0.03 && a.hw > 0 && c.hw > 0;
      const n = big ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const r = lerpRow(a, c, t);
        if (big && k > 0) {
          // smooth the silhouette with neighbours (Catmull-Rom-ish on widths)
          const p0 = rows[Math.max(0, i - 1)];
          const p3 = rows[Math.min(rows.length - 1, i + 2)];
          const cr = (v0: number, v1: number, v2: number, v3: number) =>
            0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t);
          if (p0.hw > 0 && p3.hw > 0) {
            r.hw = cr(p0.hw, a.hw, c.hw, p3.hw);
            r.f = cr(p0.f, a.f, c.f, p3.f);
            r.b = cr(p0.b, a.b, c.b, p3.b);
          }
        }
        sub.push(r);
      }
    }
    sub.push(rows[rows.length - 1]);
    const n = sub.length;
    const yMin = TORSO_Y0;
    const yMax = TORSO_Y1;
    const tw = { i: [0, 0, 0, 0] as [number, number, number, number], w: [1, 0, 0, 0] as [number, number, number, number] };
    const pelvisY = 0.96;
    const [u0, v0, u1, v1] = ATLAS_RECTS.torso;
    const start = b.vertexCount;
    loft(b, {
      rows: n,
      cols: 40,
      point: (v, u, out) => {
        const r = sub[Math.round(v * (n - 1))];
        const a = u * Math.PI * 2;
        const e = TORSO_E;
        const sx = superSin(a, e);
        const cz = superCos(a, e);
        // u = 0 → front (−z), u = .25 → character left (−x): prints read correctly front + back
        out.set(-sx * r.hw, pelvisY + r.y, -cz * (cz >= 0 ? r.f : r.b));
      },
      attrib: (p, _n, v, _u, out) => {
        const r = sub[Math.round(v * (n - 1))];
        const y = p.y - pelvisY;
        torsoWeights(y, tw);
        out.skinIndex[0] = tw.i[0];
        out.skinIndex[1] = tw.i[1];
        out.skinIndex[2] = tw.i[2];
        out.skinIndex[3] = 0;
        out.skinWeight[0] = tw.w[0];
        out.skinWeight[1] = tw.w[1];
        out.skinWeight[2] = tw.w[2];
        out.skinWeight[3] = 0;
        out.aux[0] = r.region ?? REGION.top;
        out.aux[1] = 0;
        // cavity AO: armpit sides + under the collar fold
        const side = Math.abs(p.x) / Math.max(0.05, r.hw);
        const pit = sstep(0.38, 0.47, y) * sstep(0.85, 1, side) * 0.25;
        out.aux[2] = (r.ao ?? 1) * (1 - pit);
        out.aux[3] = 1;
      },
    });
    // UVs: torso rect (u around, v by height); collar rows → collar rect
    for (let i = start; i < b.vertexCount; i++) {
      const y = b.pos[i * 3 + 1] - pelvisY;
      const reg = b.aux[i * 4];
      const u = b.uv[i * 2];
      if (reg === REGION.collar) {
        const [c0, cv0, c1, cv1] = ATLAS_RECTS.collar;
        b.uv[i * 2] = c0 + (c1 - c0) * u;
        b.uv[i * 2 + 1] = cv0 + (cv1 - cv0) * 0.5;
      } else {
        b.uv[i * 2] = u0 + (u1 - u0) * u;
        b.uv[i * 2 + 1] = v0 + (v1 - v0) * Math.min(1, Math.max(0, (y - yMin) / (yMax - yMin)));
      }
    }
  }

  private buildArm(b: MeshBuilder, rest: THREE.Matrix4[], s: number): void {
    const ids = ARM[s];
    const mirror = s === 0;
    const place = (start: number, bone: number) => {
      if (mirror) b.mirrorInPlaceX(start, b.vertexCount, 0);
      b.transform(rest[bone], start);
    };
    // upper arm: deltoid ball at the shoulder, tee sleeve with hem lip, skin below
    const ua = profile([
      [0, 0.051, 0.052],
      [0.06, 0.051, 0.053],
      [0.128, 0.05, 0.051],
      [0.13, 0.054, 0.055],
      [0.142, 0.054, 0.055],
      [0.145, 0.046, 0.048],
      [0.2, 0.045, 0.048],
      [0.27, 0.0405, 0.041],
      [UPPER, 0.0395, 0.0395],
    ]);
    let st = b.vertexCount;
    capsule(b, {
      y0: 0,
      y1: UPPER,
      cap0: 0.051,
      cap1: 0.0395,
      rows: 17,
      capRows: 4,
      cols: 20,
      sec: (y) => {
        const [rx, rz] = ua(y);
        return { rx, rz, e: 2.1 };
      },
      uvRect: ATLAS_RECTS.sleeve,
      attrib: (p, _n, _v, _u, out) => {
        const sleeve = p.y < 0.143;
        attr(sleeve ? REGION.top : REGION.skin, ids.uarm, 0, sleeve ? (p.y > 0.128 ? 0.92 : 1) : p.y < 0.152 ? 0.7 : 1)(p, _n, _v, _u, out);
      },
    });
    // sleeve UV v: shoulder (1) → hem (0) over 0..0.15
    for (let i = st; i < b.vertexCount; i++) {
      const y = b.pos[i * 3 + 1];
      if (b.aux[i * 4] !== REGION.top) {
        b.uv[i * 2] = ATLAS_RECTS.blank[0] + 0.001;
        b.uv[i * 2 + 1] = ATLAS_RECTS.blank[1] + 0.001;
        continue;
      }
      const [, sv0, , sv1] = ATLAS_RECTS.sleeve;
      b.uv[i * 2 + 1] = sv0 + (sv1 - sv0) * Math.min(1, Math.max(0, 1 - y / 0.15));
    }
    place(st, ids.uarm);

    // forearm
    const fa = profile([
      [0, 0.031, 0.032],
      [0.02, 0.0385, 0.0378],
      [0.075, 0.046, 0.041],
      [0.15, 0.039, 0.034],
      [FORE, 0.03, 0.025],
    ]);
    st = b.vertexCount;
    capsule(b, {
      y0: 0,
      y1: FORE,
      cap0: 0.031,
      cap1: 0.025,
      rows: 12,
      capRows: 4,
      cols: 20,
      sec: (y) => {
        const [rx, rz] = fa(y);
        return { rx, rz, e: 2.0 };
      },
      uvRect: ATLAS_RECTS.blank,
      attrib: attr(REGION.skin, ids.farm, 0, 1),
    });
    place(st, ids.farm);

    // hand: rounded palm (wrist → knuckles); +z = back of the hand, −x = thumb side (right hand)
    const palm = profile([
      // y, half width, dorsal depth, palmar depth, x shift (thenar bulge toward the thumb)
      [-0.012, 0.025, 0.014, 0.013, 0],
      [0.008, 0.031, 0.016, 0.017, -0.002],
      [0.03, 0.035, 0.016, 0.016, -0.001],
      [PALM, 0.035, 0.0135, 0.013, 0],
    ]);
    st = b.vertexCount;
    capsule(b, {
      y0: -0.008,
      y1: PALM - 0.004,
      cap0: 0.012,
      cap1: 0.011,
      rows: 7,
      capRows: 3,
      cols: 18,
      sec: (y) => {
        const [rx, rzD, rzP, ox] = palm(y);
        return { rx, rz: rzD, rzBack: rzP / rzD, e: 2.5, oz: -0.002, ox };
      },
      uvRect: ATLAS_RECTS.blank,
      attrib: (p, n, v, u, out) => {
        // palm side picks up chalk; a soft crease line across the palm
        const palmSide = sstep(0.2, -0.6, n.z);
        attr(REGION.skin, ids.hand, palmSide * 0.22, 1)(p, n, v, u, out);
        if (n.z < -0.5 && Math.abs(p.y - 0.034) < 0.003) out.aux[2] = 0.86;
      },
    });
    // knuckle bumps along the back of the hand
    for (let f = 0; f < 4; f++) {
      const x = -0.0255 + f * 0.017;
      const kn = b.vertexCount;
      capsule(b, {
        y0: -0.004,
        y1: 0.004,
        cap0: 0.007,
        cap1: 0.007,
        rows: 2,
        capRows: 3,
        cols: 8,
        sec: () => ({ rx: 0.0072, rz: 0.006 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.skin, ids.hand, 0, 0.95),
      });
      b.transform(new THREE.Matrix4().makeTranslation(x, PALM - 0.004, 0.0062), kn);
    }
    place(st, ids.hand);

    // fingers: four distinct capsules per segment (index → pinky from the thumb side), fused at
    // the knuckle line; chalk-whitened pads and tips
    const FX = [-0.0255, -0.0085, 0.0085, 0.0255];
    const FL = [1.0, 1.07, 1.0, 0.84];
    const FR = [1.0, 1.04, 1.0, 0.9];
    const fingerSeg = (bone: number, len: number, r0: number, r1: number, chalk0: number, chalk1: number, tip: boolean) => {
      const sst = b.vertexCount;
      for (let f = 0; f < 4; f++) {
        const L = len * FL[f];
        const fs = b.vertexCount;
        capsule(b, {
          y0: 0,
          y1: L,
          cap0: r0 * FR[f] * 0.9,
          cap1: r1 * FR[f],
          rows: 3,
          capRows: 3,
          cols: 10,
          sec: (y) => {
            const k = y / L;
            const r = (r0 + (r1 - r0) * k) * FR[f];
            return { rx: r * 1.02, rz: r * 0.94, e: 2.1 };
          },
          uvRect: ATLAS_RECTS.blank,
          attrib: (p, n, v, u, out) => {
            const k = Math.min(1, Math.max(0, p.y / L));
            const pad = sstep(0.3, -0.5, n.z); // palm-side pads hold more chalk
            const c = (chalk0 + (chalk1 - chalk0) * (tip ? k * k : k)) * (0.5 + 0.5 * pad);
            attr(REGION.skin, bone, c, 1)(p, n, v, u, out);
          },
        });
        // slight splay + the finger's own lean
        b.transform(new THREE.Matrix4().makeRotationZ(-FX[f] * (tip ? 0.9 : 1.6)).setPosition(FX[f], 0, 0), fs);
      }
      place(sst, bone);
    };
    fingerSeg(ids.fing, FING_A, 0.0092, 0.0086, 0.1, 0.22, false);
    fingerSeg(ids.tip, FING_B, 0.0084, 0.0074, 0.28, 0.9, true);

    // thumb: thick base tapering to a rounded, chalked tip
    st = b.vertexCount;
    capsule(b, {
      y0: 0,
      y1: 0.047,
      cap0: 0.0135,
      cap1: 0.0095,
      rows: 5,
      capRows: 3,
      cols: 12,
      sec: (y) => ({ rx: 0.0135 - y * 0.07, rz: 0.0118 - y * 0.05, e: 2.15 }),
      uvRect: ATLAS_RECTS.blank,
      attrib: (p, n, v, u, out) => attr(REGION.skin, ids.thumb, 0.06 + sstep(0.028, 0.056, p.y) * 0.7, 1)(p, n, v, u, out),
    });
    place(st, ids.thumb);
  }

  private buildLeg(b: MeshBuilder, rest: THREE.Matrix4[], s: number): void {
    const ids = LEG[s];
    const mirror = s === 0;
    const place = (start: number, bone: number) => {
      if (mirror) b.mirrorInPlaceX(start, b.vertexCount, 0);
      b.transform(rest[bone], start);
    };
    // thigh (pants): u = 0 front (+z apex = knee front), .25 lateral (+x). The tube starts at the
    // waistband and covers half of the pelvis (the two halves meet at the centre seams), blended
    // from the pelvis bone to the thigh bone so the hips stay one continuous surface.
    const TOP = -0.085;
    const th = profile([
      // y, rx, rz(front), back ratio, medial shift, superellipse exponent
      [TOP, 0.084, 0.088, 1.18, -0.043, 3.4],
      [-0.03, 0.085, 0.09, 1.2, -0.041, 3.2],
      [0.02, 0.087, 0.091, 1.14, -0.031, 2.8],
      [0.09, 0.088, 0.09, 1.0, -0.01, 2.3],
      [0.2, 0.078, 0.08, 0.97, -0.004, 2.1],
      [0.36, 0.064, 0.067, 0.97, 0, 2.1],
      [THIGH, 0.06, 0.061, 1.0, 0, 2.1],
    ]);
    let st = b.vertexCount;
    capsule(b, {
      y0: TOP,
      y1: THIGH,
      cap0: 0.0,
      cap1: 0.061,
      rows: 22,
      capRows: 4,
      cols: 22,
      sec: (y) => {
        const [rx, rz, back, ox, e] = th(y);
        return { rx, rz, rzBack: back, ox, e };
      },
      uvRect: ATLAS_RECTS.thigh,
      attrib: (p, n, v, u, out) => {
        attr(REGION.bottom, ids.thigh, 0, 1)(p, n, v, u, out);
        const wp = 1 - sstep(-0.03, 0.15, p.y);
        out.skinIndex[0] = ids.thigh;
        out.skinIndex[1] = BONE.pelvis;
        out.skinWeight[0] = 1 - wp;
        out.skinWeight[1] = wp;
        out.aux[3] = s === 1 ? 1 : 0; // logo on the right thigh only (the left one is mirrored)
      },
    });
    for (let i = st; i < b.vertexCount; i++) {
      const y = b.pos[i * 3 + 1];
      const [, tv0, , tv1] = ATLAS_RECTS.thigh;
      b.uv[i * 2 + 1] = tv0 + (tv1 - tv0) * Math.min(1, Math.max(0, 1 - y / THIGH));
    }
    place(st, ids.thigh);

    // shin: calf bulge at the back (−z), elastic cuff, bare ankle
    const sh = profile([
      [0, 0.053, 0.054, 0.0],
      [0.07, 0.056, 0.054, -0.006],
      [0.26, 0.047, 0.046, -0.002],
      [0.345, 0.043, 0.042, 0],
      [0.352, 0.047, 0.047, 0],
      [0.392, 0.046, 0.046, 0],
      [0.398, 0.034, 0.034, 0],
      [SHIN, 0.031, 0.031, 0],
    ]);
    st = b.vertexCount;
    capsule(b, {
      y0: 0,
      y1: SHIN,
      cap0: 0.054,
      cap1: 0.03,
      rows: 22,
      capRows: 4,
      cols: 18,
      sec: (y) => {
        const [rx, rz, oz] = sh(y);
        return { rx, rz, rzBack: 1.08, oz, e: 2.1 };
      },
      uvRect: ATLAS_RECTS.shin,
      attrib: (p, n, v, u, out) => {
        const cuff = p.y > 0.348 && p.y < 0.396;
        const skin = p.y >= 0.396;
        attr(skin ? REGION.skin : cuff ? REGION.cuff : REGION.bottom, ids.shin, 0, cuff ? 0.92 : skin && p.y < 0.405 ? 0.6 : 1)(p, n, v, u, out);
      },
    });
    for (let i = st; i < b.vertexCount; i++) {
      const y = b.pos[i * 3 + 1];
      const reg = b.aux[i * 4];
      if (reg === REGION.cuff) {
        const [c0, cv0, c1, cv1] = ATLAS_RECTS.cuff;
        const u = (b.uv[i * 2] - ATLAS_RECTS.shin[0]) / (ATLAS_RECTS.shin[2] - ATLAS_RECTS.shin[0]);
        b.uv[i * 2] = c0 + (c1 - c0) * u;
        b.uv[i * 2 + 1] = cv0 + (cv1 - cv0) * Math.min(1, Math.max(0, (0.396 - y) / 0.048));
      } else {
        const [, sv0, , sv1] = ATLAS_RECTS.shin;
        b.uv[i * 2 + 1] = sv0 + (sv1 - sv0) * Math.min(1, Math.max(0, 1 - y / 0.35));
      }
    }
    place(st, ids.shin);

    if (this.outfit.shoe === 'climbing') this.buildClimbingShoe(b, ids.foot);
    else this.buildApproachShoe(b, ids.foot);
    // shoe was built at the end of the builder in foot-local space
    place(this.shoeStart, ids.foot);
  }

  private shoeStart = 0;

  /**
   * Aggressive downturned climbing shoe (right foot, foot-local: +y heel→toe, +z instep up,
   * +x lateral). Pointed asymmetric toe (big-toe side), rubber rand + toe patch, velcro strap
   * in the shoe accent colour, heel tab.
   */
  private buildClimbingShoe(b: MeshBuilder, bone: number): void {
    this.shoeStart = b.vertexCount;
    const yH = -0.07;
    const yT = 0.182;
    const L = yT - yH;
    // profiles over t = (y − yH)/L: half width, sole z, top z, medial offset of the centre
    const pr = profile([
      [0.0, 0.026, -0.05, 0.004, 0],
      [0.06, 0.033, -0.07, 0.03, 0],
      [0.22, 0.035, -0.072, 0.034, 0],
      [0.42, 0.034, -0.062, 0.012, -0.001],
      [0.62, 0.041, -0.067, -0.008, -0.004],
      [0.78, 0.04, -0.072, -0.024, -0.008],
      [0.9, 0.03, -0.075, -0.042, -0.012],
      [0.97, 0.015, -0.074, -0.056, -0.014],
      [1.0, 0.004, -0.072, -0.064, -0.015],
    ]);
    const rows = 28;
    const cols = 20;
    loft(b, {
      rows,
      cols,
      point: (v, u, out) => {
        const [hw, zb, zt, xo] = pr(v);
        const a = u * Math.PI * 2;
        const zc = (zb + zt) / 2;
        const hz = (zt - zb) / 2;
        // u = 0 → sole (−z), .25 → lateral (+x)
        const cz = -superCos(a, 2.6);
        const sx = superSin(a, 2.6);
        let z = zc + cz * hz;
        // flatten the sole
        if (cz < -0.75) z = zb + (z - zb) * 0.35;
        // heel rounding
        const heel = v < 0.06 ? Math.sqrt(Math.max(0, 1 - Math.pow((0.06 - v) / 0.06, 2))) : 1;
        out.set(xo + sx * hw * (0.5 + 0.5 * heel), yH + v * L - (1 - heel) * 0.012, z);
      },
      attrib: (p, n, v, u, out) => {
        const [, zb] = pr(v);
        const a = u * Math.PI * 2;
        const cz = -Math.cos(a);
        // rand: rubber up to ~1.4 cm above the sole; toe patch over the front top; heel cup rubber
        const rand = p.z < zb + 0.014 || cz < -0.6;
        const toePatch = v > 0.8 && cz > -0.2;
        const heelCup = v < 0.12 && cz > -0.4 && cz < 0.6;
        const region = rand || toePatch || heelCup ? REGION.rubber : REGION.shoe;
        out.aux[0] = region;
        out.aux[1] = 0;
        out.aux[2] = region === REGION.rubber && cz < -0.6 ? 0.75 : 1;
        out.aux[3] = 0;
        out.skinIndex[0] = bone;
        out.skinWeight[0] = 1;
        out.skinIndex[1] = out.skinIndex[2] = out.skinIndex[3] = 0;
        out.skinWeight[1] = out.skinWeight[2] = out.skinWeight[3] = 0;
      },
      uvRect: ATLAS_RECTS.shoe,
    });
    // ankle collar: a soft padded ring around the opening
    const collarStart = b.vertexCount;
    capsule(b, {
      y0: -0.012,
      y1: 0.012,
      cap0: 0.012,
      cap1: 0.012,
      rows: 3,
      capRows: 3,
      cols: 20,
      sec: () => ({ rx: 0.036, rz: 0.04, e: 2 }),
      uvRect: ATLAS_RECTS.blank,
      attrib: attr(REGION.shoe, bone, 0, 0.85),
    });
    // (rotate that ring to lie around the ankle opening: built along y, map y→z)
    b.transform(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, -0.012, 0.012), collarStart);
    // velcro strap over the instep (shoe accent), slightly proud of the upper
    const strap = (vc: number, wid: number) => {
      loft(b, {
        rows: 4,
        cols: 18,
        openU: true,
        point: (v, u, out) => {
          const t = vc + (v - 0.5) * wid;
          const [hw, zb, zt, xo] = pr(t);
          const a = Math.PI * (0.18 + 0.64 * u); // from lateral-low over the top to medial-low
          const zc = (zb + zt) / 2;
          const hz = (zt - zb) / 2 + 0.004;
          out.set(xo + Math.cos(a) * (hw + 0.004), yH + t * L, zc + Math.sin(a) * hz);
        },
        attrib: attr(REGION.strap, bone, 0, 1),
        uvRect: ATLAS_RECTS.blank,
      });
      // the strap edges get a thickness illusion via a second, slightly inset copy
    };
    strap(0.4, 0.13);
    // buckle (D-ring) on the lateral side
    {
      const st = b.vertexCount;
      capsule(b, {
        y0: -0.008,
        y1: 0.008,
        cap0: 0.004,
        cap1: 0.004,
        rows: 3,
        capRows: 3,
        cols: 8,
        sec: () => ({ rx: 0.004, rz: 0.004 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.metal, bone, 0, 1),
      });
      const [hw, zb, zt, xo] = pr(0.4);
      b.transform(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(xo + hw + 0.006, yH + 0.4 * L, (zb + zt) / 2 - 0.004), st);
    }
    // heel pull tab
    {
      const st = b.vertexCount;
      capsule(b, {
        y0: 0,
        y1: 0.022,
        cap0: 0.004,
        cap1: 0.006,
        rows: 4,
        capRows: 3,
        cols: 10,
        sec: () => ({ rx: 0.009, rz: 0.003, e: 2.6 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.strap, bone, 0, 1),
      });
      b.transform(new THREE.Matrix4().makeRotationX(-0.25).setPosition(0, yH + 0.004, 0.0), st);
    }
  }

  /** Approach shoe (guide): chunky lugged sole, laces, padded collar. */
  private buildApproachShoe(b: MeshBuilder, bone: number): void {
    this.shoeStart = b.vertexCount;
    const yH = -0.075;
    const yT = 0.19;
    const L = yT - yH;
    const pr = profile([
      [0.0, 0.03, -0.062, 0.02, 0],
      [0.08, 0.038, -0.074, 0.03, 0],
      [0.3, 0.04, -0.074, 0.03, 0],
      [0.55, 0.045, -0.074, 0.0, -0.002],
      [0.78, 0.045, -0.074, -0.02, -0.004],
      [0.92, 0.036, -0.072, -0.036, -0.005],
      [1.0, 0.012, -0.066, -0.05, -0.005],
    ]);
    loft(b, {
      rows: 24,
      cols: 20,
      point: (v, u, out) => {
        const [hw, zb, zt, xo] = pr(v);
        const a = u * Math.PI * 2;
        const zc = (zb + zt) / 2;
        const hz = (zt - zb) / 2;
        const cz = -superCos(a, 3);
        const sx = superSin(a, 3);
        let z = zc + cz * hz;
        if (cz < -0.7) z = zb + (z - zb) * 0.3;
        const heel = v < 0.05 ? Math.sqrt(Math.max(0, 1 - Math.pow((0.05 - v) / 0.05, 2))) : 1;
        out.set(xo + sx * (hw + (cz < -0.5 ? 0.003 : 0)) * (0.55 + 0.45 * heel), yH + v * L, z);
      },
      attrib: (p, n, v, u, out) => {
        const [, zb] = pr(v);
        const sole = p.z < zb + 0.022;
        const toe = v > 0.86 && p.z < zb + 0.04;
        out.aux[0] = sole || toe ? REGION.rubber : REGION.shoe;
        out.aux[1] = 0;
        out.aux[2] = sole ? 0.8 : 1;
        out.aux[3] = 0;
        out.skinIndex[0] = bone;
        out.skinWeight[0] = 1;
        out.skinIndex[1] = out.skinIndex[2] = out.skinIndex[3] = 0;
        out.skinWeight[1] = out.skinWeight[2] = out.skinWeight[3] = 0;
      },
      uvRect: ATLAS_RECTS.shoe,
    });
    // laces: little bars across the instep
    for (let k = 0; k < 5; k++) {
      const t = 0.42 + k * 0.075;
      const [hw, , zt, xo] = pr(t);
      const st = b.vertexCount;
      capsule(b, {
        y0: -hw * 0.45,
        y1: hw * 0.45,
        cap0: 0.003,
        cap1: 0.003,
        rows: 3,
        capRows: 2,
        cols: 6,
        sec: () => ({ rx: 0.0028, rz: 0.0028 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.strap, bone, 0, 1),
      });
      b.transform(new THREE.Matrix4().makeRotationZ(-Math.PI / 2).setPosition(xo, yH + t * L, zt + 0.002), st);
    }
  }

  private buildBag(b: MeshBuilder, rest: THREE.Matrix4[]): void {
    // bag-local: origin = belt attach point, +y up, +z away from the body; the bag hangs below
    const st = b.vertexCount;
    capsule(b, {
      y0: -0.1,
      y1: -0.012,
      cap0: 0.026,
      cap1: 0.0,
      rows: 10,
      capRows: 4,
      cols: 22,
      sec: (y) => ({ rx: 0.043 + (y + 0.1) * 0.035, rz: 0.04 + (y + 0.1) * 0.035, oz: 0.046, e: 2.05 }),
      uvRect: ATLAS_RECTS.bag,
      attrib: (p, n, v, u, out) => attr(REGION.bag, BONE.bag, sstep(-0.04, -0.012, p.y) * 0.25, 1)(p, n, v, u, out),
    });
    // fleece rim (chalk colour) — a fat torus around the opening
    capsule(b, {
      y0: -0.012,
      y1: 0.006,
      cap0: 0.009,
      cap1: 0.009,
      rows: 3,
      capRows: 4,
      cols: 24,
      sec: () => ({ rx: 0.048, rz: 0.045, oz: 0.046, e: 2 }),
      uvRect: ATLAS_RECTS.blank,
      attrib: attr(REGION.bagRim, BONE.bag, 0, 1),
    });
    // opening (dark interior disc)
    loft(b, {
      rows: 3,
      cols: 22,
      point: (v, u, out) => {
        const a = u * Math.PI * 2;
        const r = (1 - v) * 0.041;
        out.set(Math.sin(a) * r, 0.004 - v * 0.004, 0.046 + Math.cos(a) * r * 0.94);
      },
      attrib: attr(REGION.webbing, BONE.bag, 0.3, 0.35),
      uvRect: ATLAS_RECTS.blank,
    });
    // brush holder loop on the side
    {
      const s2 = b.vertexCount;
      capsule(b, {
        y0: -0.03,
        y1: 0.03,
        cap0: 0.006,
        cap1: 0.006,
        rows: 4,
        capRows: 3,
        cols: 8,
        sec: () => ({ rx: 0.006, rz: 0.004 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.webbing, BONE.bag, 0, 1),
      });
      b.transform(new THREE.Matrix4().makeTranslation(0.047, -0.055, 0.046), s2);
    }
    b.transform(rest[BONE.bag], st);
  }

  private buildBelt(b: MeshBuilder): void {
    // thin webbing belt following the torso at the waistband height (pelvis bone)
    const y = 0.05;
    const r = TORSO_ROWS.find((row) => row.y >= y) ?? TORSO_ROWS[6];
    const hw = r.hw + 0.006;
    const f = r.f + 0.006;
    const bk = r.b + 0.006;
    loft(b, {
      rows: 4,
      cols: 48,
      point: (v, u, out) => {
        const a = u * Math.PI * 2;
        const sx = superSin(a, 2.35);
        const cz = superCos(a, 2.35);
        const k = v < 0.2 || v > 0.8 ? 0.996 : 1.004;
        out.set(sx * hw * k, 0.96 + y + (v - 0.5) * 0.022, -cz * (cz >= 0 ? f : bk) * k);
      },
      attrib: attr(REGION.webbing, BONE.pelvis, 0, 1),
      uvRect: ATLAS_RECTS.webbing,
    });
    // buckle at the front
    const s2 = b.vertexCount;
    capsule(b, {
      y0: -0.012,
      y1: 0.012,
      cap0: 0.004,
      cap1: 0.004,
      rows: 3,
      capRows: 3,
      cols: 10,
      sec: () => ({ rx: 0.016, rz: 0.004, e: 4 }),
      uvRect: ATLAS_RECTS.blank,
      attrib: attr(REGION.metal, BONE.pelvis, 0, 1),
    });
    b.transform(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 0.96 + y, -f - 0.004), s2);
  }

  private buildHarness(b: MeshBuilder, rest: THREE.Matrix4[]): void {
    // waist belt: padded band (harness colour) with dark webbing edges
    const yW = 0.085;
    const r0 = TORSO_ROWS.find((row) => row.y >= yW) ?? TORSO_ROWS[9];
    const hw = r0.hw + 0.009;
    const f = r0.f + 0.008;
    const bk = r0.b + 0.009;
    loft(b, {
      rows: 6,
      cols: 52,
      point: (v, u, out) => {
        const a = u * Math.PI * 2;
        const sx = superSin(a, 2.35);
        const cz = superCos(a, 2.35);
        const back = cz < 0 ? -cz : 0; // wider padding at the back
        const h = 0.036 + 0.018 * back;
        const k = v === 0 || v === 1 ? 0.985 : 1 + 0.012 * Math.sin(v * Math.PI);
        out.set(sx * hw * k, 0.96 + yW + (v - 0.5) * h, -cz * (cz >= 0 ? f : bk) * k);
      },
      attrib: (p, n, v, u, out) => attr(v < 0.2 || v > 0.8 ? REGION.webbing : REGION.harness, BONE.pelvis, 0, 1)(p, n, v, u, out),
      uvRect: ATLAS_RECTS.webbing,
    });
    // leg loops around each thigh (thigh-local ring, tilted: higher at the front-outside)
    for (let s = 0; s < 2; s++) {
      const bone = LEG[s].thigh;
      const st = b.vertexCount;
      loft(b, {
        rows: 4,
        cols: 30,
        point: (v, u, out) => {
          const a = u * Math.PI * 2;
          const rr = 0.096 + 0.003 * Math.sin(v * Math.PI);
          const yy = 0.085 + (v - 0.5) * 0.026 - Math.cos(a) * 0.022;
          out.set(Math.sin(a) * rr, yy, Math.cos(a) * rr * 0.98);
        },
        attrib: (p, n, v, u, out) => attr(v < 0.2 || v > 0.8 ? REGION.harness : REGION.webbing, bone, 0, 1)(p, n, v, u, out),
        uvRect: ATLAS_RECTS.webbing,
      });
      if (s === 0) b.mirrorInPlaceX(st, b.vertexCount, 0);
      b.transform(rest[bone], st);
    }
    // belay loop: vertical ring at the front centre joining waist belt and leg loops
    {
      const st = b.vertexCount;
      const R = 0.032;
      loft(b, {
        rows: 24,
        cols: 10,
        point: (v, u, out) => {
          const a = v * Math.PI * 2;
          const c = u * Math.PI * 2;
          const cx = Math.cos(a) * R * 0.55;
          const cy = Math.sin(a) * R;
          const tube = 0.0065;
          out.set(cx + Math.cos(a) * Math.cos(c) * tube, cy + Math.sin(c) * tube * 0.6 + Math.sin(a) * Math.cos(c) * tube, Math.sin(c) * tube * 0.8);
        },
        attrib: attr(REGION.harness, BONE.pelvis, 0, 1),
        uvRect: ATLAS_RECTS.blank,
      });
      b.transform(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0.96 + 0.035, -(r0.f + 0.024)), st);
    }
    if (this.outfit.tieIn === 'device') this.buildBelayDevice(b, r0.f);
    // figure-8 follow-through knot at the tie-in (rope colour), two parallel strands
    else {
      const knotC = new THREE.Vector3(0, 0.96 + 0.02, -(r0.f + 0.05));
      for (const off of [-1, 1]) {
        const st = b.vertexCount;
        const N = 80;
        const curve: THREE.Vector3[] = [];
        for (let i = 0; i <= N; i++) {
          const t = (i / N) * Math.PI * 2;
          // figure-eight knot (4₁) parametric curve, flattened and stretched vertically
          const x = (2 + Math.cos(2 * t)) * Math.cos(3 * t);
          const y = (2 + Math.cos(2 * t)) * Math.sin(3 * t);
          const z = Math.sin(4 * t);
          curve.push(new THREE.Vector3(x * 0.0058, y * 0.0085, z * 0.006 + off * 0.0035));
        }
        loft(b, {
          rows: N + 1,
          cols: 8,
          point: (v, u, out) => {
            const i = Math.round(v * N);
            const p = curve[i % N];
            const q = curve[(i + 1) % N];
            const pm = curve[(i + N - 1) % N];
            _t0.subVectors(q, pm).normalize();
            _t1.crossVectors(_t0, AX_Z);
            if (_t1.lengthSq() < 1e-6) _t1.set(1, 0, 0);
            _t1.normalize();
            _t2.crossVectors(_t0, _t1).normalize();
            const a = u * Math.PI * 2;
            const r = 0.0048;
            out.copy(p).addScaledVector(_t1, Math.cos(a) * r).addScaledVector(_t2, Math.sin(a) * r);
          },
          attrib: attr(REGION.rope, BONE.pelvis, 0, 1),
          uvRect: ATLAS_RECTS.rope,
        });
        b.transform(new THREE.Matrix4().setPosition(knotC), st);
      }
      // the rope leaving the knot upward (tail + standing end stub)
      const st = b.vertexCount;
      capsule(b, {
        y0: 0,
        y1: 0.05,
        cap0: 0.005,
        cap1: 0.005,
        rows: 6,
        capRows: 3,
        cols: 8,
        sec: () => ({ rx: 0.005, rz: 0.005 }),
        uvRect: ATLAS_RECTS.rope,
        attrib: attr(REGION.rope, BONE.pelvis, 0, 1),
      });
      b.transform(new THREE.Matrix4().makeRotationZ(-0.25).setPosition(knotC.x + 0.008, knotC.y + 0.018, knotC.z - 0.004), st);
    }
    // gear loops with two hanging quickdraw stubs on the hips
    for (let s = 0; s < 2; s++) {
      const sg = SIGN[s];
      const st = b.vertexCount;
      loft(b, {
        rows: 14,
        cols: 6,
        point: (v, u, out) => {
          const a = Math.PI * v;
          const c = u * Math.PI * 2;
          const tube = 0.004;
          out.set(Math.cos(a) * 0.035 + Math.cos(c) * tube * Math.cos(a), -Math.sin(a) * 0.022 + Math.sin(c) * tube, Math.cos(c) * tube * Math.sin(a) * 0.5);
        },
        attrib: attr(REGION.webbing, BONE.pelvis, 0, 1),
        uvRect: ATLAS_RECTS.blank,
      });
      b.transform(new THREE.Matrix4().makeRotationY(sg * 1.35).setPosition(sg * (hw + 0.004), 0.96 + yW - 0.014, -0.02), st);
      // quickdraw: carabiner (metal) + dogbone (webbing)
      const s2 = b.vertexCount;
      capsule(b, {
        y0: -0.03,
        y1: 0.0,
        cap0: 0.004,
        cap1: 0.004,
        rows: 4,
        capRows: 2,
        cols: 6,
        sec: () => ({ rx: 0.008, rz: 0.003, e: 3 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.harness, BONE.pelvis, 0, 1),
      });
      capsule(b, {
        y0: -0.07,
        y1: -0.034,
        cap0: 0.006,
        cap1: 0.006,
        rows: 4,
        capRows: 2,
        cols: 8,
        sec: () => ({ rx: 0.011, rz: 0.003, e: 2 }),
        uvRect: ATLAS_RECTS.blank,
        attrib: attr(REGION.metal, BONE.pelvis, 0, 1),
      });
      b.transform(new THREE.Matrix4().makeRotationY(sg * 1.4).setPosition(sg * (hw + 0.006), 0.96 + yW - 0.03, 0.0), s2);
    }
  }

  /** Tube-style belay device on a locking carabiner, rope loops running through it. */
  private buildBelayDevice(b: MeshBuilder, front: number): void {
    const z = -(front + 0.05);
    const y = 0.96 + 0.0;
    // locking carabiner (metal) hanging from the belay loop
    let st = b.vertexCount;
    loft(b, {
      rows: 20,
      cols: 8,
      point: (v, u, out) => {
        const a = v * Math.PI * 2;
        const c = u * Math.PI * 2;
        const tube = 0.0045;
        const rx = 0.016;
        const ry = 0.03;
        const px = Math.cos(a) * rx;
        const py = Math.sin(a) * ry;
        out.set(px + Math.cos(a) * Math.cos(c) * tube, py + Math.sin(a) * Math.cos(c) * tube, Math.sin(c) * tube);
      },
      attrib: attr(REGION.metal, BONE.pelvis, 0, 1),
      uvRect: ATLAS_RECTS.blank,
    });
    b.transform(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0, y + 0.0, z + 0.006), st);
    // the device body (anodised accent) — a rounded block with two slots
    st = b.vertexCount;
    capsule(b, {
      y0: -0.018,
      y1: 0.018,
      cap0: 0.008,
      cap1: 0.008,
      rows: 4,
      capRows: 3,
      cols: 14,
      sec: () => ({ rx: 0.022, rz: 0.011, e: 3.2 }),
      uvRect: ATLAS_RECTS.blank,
      attrib: attr(REGION.harness, BONE.pelvis, 0, 1),
    });
    b.transform(new THREE.Matrix4().setPosition(0, y - 0.032, z - 0.012), st);
    // rope bights through the slots
    for (const sx of [-1, 1]) {
      st = b.vertexCount;
      capsule(b, {
        y0: -0.05,
        y1: 0.0,
        cap0: 0.005,
        cap1: 0.005,
        rows: 6,
        capRows: 3,
        cols: 8,
        sec: () => ({ rx: 0.005, rz: 0.005 }),
        uvRect: ATLAS_RECTS.rope,
        attrib: attr(REGION.rope, BONE.pelvis, 0, 1),
      });
      b.transform(new THREE.Matrix4().makeRotationZ(sx * 0.12).setPosition(sx * 0.008, y - 0.04, z - 0.02), st);
    }
  }

  // ───────────────────────────── appearance ─────────────────────────────

  setPalette(cw: ColorwayDef, chalk: string, opts: { bagColor?: string; bagPrint?: string; top2?: string; harness?: string } = {}): void {
    const u = this.material.userData.body;
    const set = (r: number, hex: string, rough: number, sheen: number, metal = 0) => {
      u.uPal.value[r].set(hex);
      u.uMat.value[r].set(rough, sheen, metal, 0);
    };
    const top = new THREE.Color(cw.top);
    const bottom = new THREE.Color(cw.bottom);
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    set(REGION.top, cw.top, 0.78, 0.9);
    set(REGION.top2, opts.top2 ?? '#' + top.clone().multiplyScalar(0.82).getHexString(), 0.86, 1);
    set(REGION.bottom, cw.bottom, 0.82, 0.75);
    set(REGION.bottom2, '#' + bottom.clone().multiplyScalar(0.85).getHexString(), 0.84, 0.75);
    set(REGION.collar, '#' + top.clone().multiplyScalar(0.88).getHexString(), 0.86, 0.9);
    set(REGION.cuff, '#' + bottom.clone().multiplyScalar(0.8).getHexString(), 0.88, 0.7);
    set(REGION.skin, SKIN_TONE, 0.58, 0.45);
    set(REGION.shoe, cw.shoe, 0.62, 0.35);
    set(REGION.rubber, '#1B1C1F', 0.72, 0.1);
    set(REGION.strap, cw.shoeAccent, 0.6, 0.4);
    // chalk bag: black with the CHIRAL mark in pink; the fleece rim carries the chalk colour
    set(REGION.bag, opts.bagColor ?? '#141518', 0.78, 0.75);
    set(REGION.bagRim, chalk, 0.95, 1);
    set(REGION.webbing, '#25272B', 0.8, 0.5);
    // harness padding: CHIRAL pink on every colourway (webbing edges stay graphite)
    set(REGION.harness, opts.harness ?? PALETTE.signal, 0.62, 0.55);
    set(REGION.metal, '#B9BEC6', 0.3, 0, 1);
    set(REGION.rope, PALETTE.signal, 0.75, 0.7);
    // print colour: the accent, nudged for contrast against the top
    const acc = new THREE.Color(cw.accent);
    if (Math.abs(lum(acc) - lum(top)) < 0.12) acc.copy(top).multiplyScalar(lum(top) > 0.35 ? 0.45 : 2.2);
    u.uPrint.value.copy(acc);
    u.uBagPrint.value.set(opts.bagPrint ?? PALETTE.signal);
    u.uAccent2.value.set(cw.shoeAccent);
    u.uChalk.value.set(chalk);
  }

  setHarness(on: boolean): void {
    this.harness.visible = on;
  }

  // ───────────────────────────── solve ─────────────────────────────

  /**
   * Collision spheres for the head (from fitHeadProxies, in the neck-bone frame). Call after the
   * head is created / swapped.
   */
  setHeadProxies(head: THREE.Object3D | null): void {
    this.headN = head ? fitHeadProxies(head, this.headLocal) : 0;
  }

  /** Pose every bone from the goal (rig space). dt drives the head damping + chalk-bag swing. */
  solve(g: BodyGoal, dt: number): void {
    const B = this.bones;
    this.wallOn = g.wall;
    this.wallN.copy(g.wallN);
    this.wallP.copy(g.wallP);
    this.awayV.copy(g.away);
    // ── torso ──
    _t0.subVectors(g.chest, g.pelvis);
    const spineLen = _t0.length();
    const spineDir = _t3.copy(_t0).multiplyScalar(1 / Math.max(1e-6, spineLen));
    // pelvis: up = spine (a touch more upright), right = pelvisRight
    _t1.copy(spineDir).lerp(WORLD_UP, 0.15).normalize();
    _t2.crossVectors(g.pelvisRight, _t1); // back (z = x × y)
    basisQuat(_t1, _t2, this.qPelvis);
    if (g.pelvisTilt !== 0) this.qPelvis.multiply(_q0.setFromAxisAngle(AX_Z, clampN(g.pelvisTilt, -0.45, 0.45)));
    this.PX.set(1, 0, 0).applyQuaternion(this.qPelvis);
    this.PY.set(0, 1, 0).applyQuaternion(this.qPelvis);
    this.PZ.set(0, 0, 1).applyQuaternion(this.qPelvis);
    B[BONE.pelvis].position.copy(g.pelvis);
    B[BONE.pelvis].quaternion.copy(this.qPelvis);
    B[BONE.pelvis].scale.set(1, 1, 1);
    // chest: its twist relative to the pelvis is limited (soft clamp about the spine)
    const cr = this.chestRightW.copy(g.chestRight).addScaledVector(spineDir, -g.chestRight.dot(spineDir));
    _t1.copy(this.PX).addScaledVector(spineDir, -this.PX.dot(spineDir));
    if (cr.lengthSq() > 1e-8 && _t1.lengthSq() > 1e-8) {
      cr.normalize();
      _t1.normalize();
      _t2.crossVectors(_t1, cr);
      const tw = Math.atan2(_t2.dot(spineDir), _t1.dot(cr));
      const lim = JOINT_LIMITS.spineTwist * DEG;
      const twc = softClamp(tw, -lim, lim, 0.14);
      if (twc !== tw) cr.copy(_t1).applyAxisAngle(spineDir, twc);
    } else cr.copy(g.chestRight);
    _t2.crossVectors(cr, spineDir);
    basisQuat(spineDir, _t2, this.qChest);
    this.CX.set(1, 0, 0).applyQuaternion(this.qChest);
    this.CY.set(0, 1, 0).applyQuaternion(this.qChest);
    this.CZ.set(0, 0, 1).applyQuaternion(this.qChest);
    const breath = g.breath * g.breathDepth;
    B[BONE.chest].quaternion.copy(this.qChest);
    _t1.set(0, CHEST_Y - BODY.spine, 0).applyQuaternion(this.qChest);
    B[BONE.chest].position.copy(g.chest).add(_t1);
    B[BONE.chest].scale.set(1 + 0.018 * breath, 1, 1 + 0.03 * breath);
    // spine: halfway
    B[BONE.spine].quaternion.copy(this.qPelvis).slerp(this.qChest, 0.5);
    _t1.set(0, SPINE_Y, 0).applyQuaternion(this.qPelvis).add(g.pelvis);
    _t2.set(0, SPINE_Y - CHEST_Y, 0).applyQuaternion(this.qChest).add(B[BONE.chest].position);
    B[BONE.spine].position.copy(_t1).lerp(_t2, 0.5);
    B[BONE.spine].scale.set(1 + 0.01 * breath, 1, 1 + 0.02 * breath);

    // ── head ──
    this.solveHead(g, dt);

    // ── limbs: limited IK, then self-collision, then the bones ──
    this.evals = 0;
    this.chains = 0;
    this.evalsL.fill(0);
    this.wallNeed.fill(0);
    for (let s = 0; s < 2; s++) {
      this.tgtW[s].copy(g.hands[s].target);
      this.poleW[s].copy(g.hands[s].pole);
      this.tgtW[2 + s].copy(g.feet[s].target);
      this.poleW[2 + s].copy(g.feet[s].pole);
    }
    for (let s = 0; s < 2; s++) this.solveArm(g, s);
    for (let s = 0; s < 2; s++) this.solveLeg(g, s);
    this.contacts = 0;
    if (this.collide) this.resolveCollisions(g);
    else this.headAvoidT = 0;
    for (let s = 0; s < 2; s++) {
      this.writeArm(g, s);
      this.writeLeg(s);
    }

    // ── tie-in point (front of the harness) + chalk bag ──
    this.joints.tieIn.set(0, 0.03, -0.155).applyQuaternion(this.qPelvis).add(g.pelvis);
    this.solveBag(dt);

    // culling spheres follow the body
    this.bound.center.copy(g.pelvis).lerp(g.chest, 0.3);
    this.boundH.center.copy(g.pelvis);
  }

  private solveHead(g: BodyGoal, dt: number): void {
    const B = this.bones;
    const neck = B[BONE.neck];
    neck.position.copy(g.chest);
    // desired direction in chest-local space
    _q0.copy(this.qChest).invert();
    _t0.subVectors(g.look, g.chest).applyQuaternion(_q0);
    let yaw = 0;
    let pitch = 0;
    if (_t0.lengthSq() > 1e-8) {
      // a target overhead counts as in front (a chest leaning into the wall puts the holds above
      // just behind its frontal plane: without this the yaw flips to ±180° and the head spins)
      const fz = _t0.y > 0 ? Math.max(-_t0.z, _t0.y * 0.4) : -_t0.z;
      yaw = Math.atan2(-_t0.x, fz);
      // targets behind the head: keep turning the way we already are (no left/right flip)
      if (Math.abs(yaw) > 2.4 && this.yaw !== 0 && Math.sign(yaw) !== Math.sign(this.yaw)) yaw = Math.sign(this.yaw) * Math.PI;
      pitch = Math.atan2(_t0.y - 0.15, Math.hypot(_t0.x, fz));
    }
    const L = JOINT_LIMITS;
    const k = dt <= 0 ? 1 : 1 - Math.exp(-dt * 9);
    // turn away from an arm crossing in front of the face (from the last collision pass)
    this.headAvoid += (this.headAvoidT - this.headAvoid) * (dt <= 0 ? 1 : 1 - Math.exp(-dt * 6));
    yaw = yaw * g.lookWeight + this.headAvoid;
    pitch *= g.lookWeight;
    // anatomical neck range, eased in (no snapping at the limit)
    yaw = softClamp(yaw, -L.headYaw * DEG, L.headYaw * DEG, 0.3);
    pitch = softClamp(pitch, -L.headPitchDown * DEG, L.headPitchUp * DEG, 0.22) - g.headNod;
    this.yaw += (yaw - this.yaw) * k;
    this.pitch += (pitch - this.pitch) * k;
    // keep the snout / horns off the wall: tilt the head when it would touch the wall
    let wallTarget = 0;
    if (this.wallOn && this.headN > 0) {
      const m0 = this.headClearance(neck, this.pitch, g.headRoll);
      if (m0 < 0.025) {
        const mUp = this.headClearance(neck, this.pitch + 0.35, g.headRoll);
        const mDn = this.headClearance(neck, this.pitch - 0.35, g.headRoll);
        const up = mUp >= mDn;
        const m1 = up ? mUp : mDn;
        if (m1 > m0 + 1e-4) wallTarget = (up ? 0.35 : -0.35) * clampN((0.025 - m0) / (m1 - m0), 0, 2);
      }
    }
    this.headWallPitch += (wallTarget - this.headWallPitch) * (dt <= 0 ? 1 : 1 - Math.exp(-dt * 14));
    _e.set(this.pitch + this.headWallPitch, this.yaw, g.headRoll, 'YXZ');
    _q1.setFromEuler(_e);
    neck.quaternion.copy(this.qChest).multiply(_q1);
    this.joints.head.set(0, BODY.neck, 0).applyQuaternion(neck.quaternion).add(neck.position);
  }

  /** Smallest wall clearance of the head spheres for a head pitch (rig space). */
  private headClearance(neck: THREE.Bone, pitch: number, roll: number): number {
    _e.set(pitch, this.yaw, roll, 'YXZ');
    _q1.setFromEuler(_e);
    _qa.copy(this.qChest).multiply(_q1);
    let m = Infinity;
    const H = this.headLocal;
    for (let j = 0; j < this.headN; j++) {
      this.hs.set(H[j * 4], H[j * 4 + 1], H[j * 4 + 2]).applyQuaternion(_qa).add(neck.position);
      const c = this.hs.sub(this.wallP).dot(this.wallN) - H[j * 4 + 3];
      if (c < m) m = c;
    }
    return m;
  }

  private solveArm(g: BodyGoal, s: number): void {
    const sg = SIGN[s];
    const goal = g.hands[s];
    const J = this.joints;
    // shoulder joint: chest node ± shoulderHalf along the chest's right axis, slightly lowered
    const S = J.shoulder[s];
    _t0.set(sg * BODY.shoulderHalf, -SHOULDER_DROP + goal.lift, 0).applyQuaternion(this.qChest);
    S.copy(g.chest).add(_t0);
    const qh = this.qHand[s];
    const dir = this.tmpGoalDir.copy(goal.dir).normalize();
    const up = this.tmpGoalUp.copy(goal.up);
    const tgt = this.tgtW[s];
    const curl = clampN(goal.curlA / 1.4, 0, 1);
    gripLocal(curl, this.cGrip);
    // first guess: protract / elevate the shoulder toward a far target (≤ 6 cm) and keep the
    // fingers within the wrist range of the rough forearm line
    basisQuat(dir, up, qh);
    if (goal.jointTarget) J.wrist[s].copy(tgt);
    else J.wrist[s].copy(tgt).sub(_t2.copy(this.cGrip).applyQuaternion(qh));
    _t3.subVectors(J.wrist[s], S);
    const d = _t3.length();
    const over = d - (UPPER + FORE) * 0.985;
    if (over > 0) S.addScaledVector(_t3, Math.min(0.06, over) / d);
    _t3.subVectors(J.wrist[s], S).normalize();
    clampAngle(dir, _t3, JOINT_LIMITS.wristDev * DEG);
    const iters = this.quick ? 1 : 3;
    for (let iter = 0; iter < iters; iter++) {
      basisQuat(dir, up, qh);
      if (goal.jointTarget) J.wrist[s].copy(tgt);
      else J.wrist[s].copy(tgt).sub(_t2.copy(this.cGrip).applyQuaternion(qh));
      this.stretchK[s] = this.chain(s, S, J.wrist[s], this.poleW[s], J.elbow[s], this.cOut);
      J.wrist[s].copy(this.cOut);
      if (!this.wristLimit(s)) break;
    }
    basisQuat(dir, up, qh);
    _t0.copy(this.cGrip).applyQuaternion(qh);
    J.grip[s].copy(J.wrist[s]).add(_t0);
  }

  /** Wrist range vs the solved forearm: finger deviation and pro/supination. True if it changed the hand. */
  private wristLimit(s: number): boolean {
    const J = this.joints;
    const L = JOINT_LIMITS;
    const dir = this.tmpGoalDir;
    const up = this.tmpGoalUp;
    const f = this.kA.subVectors(J.wrist[s], J.elbow[s]).normalize();
    let changed = false;
    const dev = L.wristDev * DEG;
    if (dir.dot(f) < Math.cos(dev) - 1e-3) {
      clampAngle(dir, f, dev);
      changed = true;
    }
    // neutral back of the hand = lateral side of the elbow hinge ("handshake")
    const nb = this.kB.crossVectors(this.cD, this.apex[s]).multiplyScalar(-SIGN[s]);
    nb.addScaledVector(f, -nb.dot(f));
    const hu = this.kN.copy(up).addScaledVector(dir, -up.dot(dir));
    hu.addScaledVector(f, -hu.dot(f));
    if (nb.lengthSq() > 1e-6 && hu.lengthSq() > 1e-6) {
      nb.normalize();
      hu.normalize();
      const psi = Math.atan2(_t1.crossVectors(nb, hu).dot(f), nb.dot(hu));
      const lim = L.wristTwist * DEG;
      if (Math.abs(psi) > lim) {
        const r = Math.sign(psi) * lim - psi;
        up.applyAxisAngle(f, r);
        dir.applyAxisAngle(f, r);
        changed = true;
      }
    }
    return changed;
  }

  private writeArm(g: BodyGoal, s: number): void {
    const B = this.bones;
    const ids = ARM[s];
    const sg = SIGN[s];
    const goal = g.hands[s];
    const J = this.joints;
    const S = J.shoulder[s];
    const qh = this.qHand[s];
    const k = this.stretchK[s];
    // bones: Z = elbow apex direction
    _t0.subVectors(J.elbow[s], S).normalize(); // upper dir
    _t1.subVectors(J.wrist[s], J.elbow[s]).normalize(); // fore dir
    _t2.copy(_t0).sub(_t1); // apex ≈ (upper − fore): points out of the elbow's outside
    if (_t2.lengthSq() < 1e-4) _t2.copy(this.apex[s]);
    B[ids.uarm].position.copy(S);
    basisQuat(_t0, _t2, B[ids.uarm].quaternion);
    B[ids.uarm].scale.set(1, k, 1);
    B[ids.farm].position.copy(J.elbow[s]);
    basisQuat(_t1, _t2, B[ids.farm].quaternion);
    B[ids.farm].scale.set(1, k, 1);
    // hand
    const H = B[ids.hand];
    H.position.copy(J.wrist[s]);
    H.quaternion.copy(qh);
    // fingers: curl about the hand's local x (toward the palm = −z)
    const F = B[ids.fing];
    _t0.set(0, PALM, 0).applyQuaternion(qh);
    F.position.copy(J.wrist[s]).add(_t0);
    _q0.setFromAxisAngle(AX_X, -goal.curlA);
    F.quaternion.copy(qh).multiply(_q0);
    const T = B[ids.tip];
    _t0.set(0, FING_A, 0).applyQuaternion(F.quaternion);
    T.position.copy(F.position).add(_t0);
    _q0.setFromAxisAngle(AX_X, -goal.curlB);
    T.quaternion.copy(F.quaternion).multiply(_q0);
    // thumb: from the thumb side of the palm; opposition swings it under the palm
    const Th = B[ids.thumb];
    _t0.set(-sg * 0.03, 0.012, -0.006).applyQuaternion(qh);
    Th.position.copy(J.wrist[s]).add(_t0);
    const opp = goal.thumb;
    _e.set(-0.35 - 0.9 * opp, 0, sg * (0.55 - 0.25 * opp), 'XYZ');
    _q0.setFromEuler(_e);
    Th.quaternion.copy(qh).multiply(_q0);
  }

  private solveLeg(g: BodyGoal, s: number): void {
    const sg = SIGN[s];
    const li = 2 + s;
    const goal = g.feet[s];
    const J = this.joints;
    const Hp = J.hip[s];
    _t0.set(sg * BODY.hipHalf, 0, 0).applyQuaternion(this.qPelvis);
    Hp.copy(g.pelvis).add(_t0);
    const qf = this.qFoot[s];
    const dir = this.tmpGoalDir.copy(goal.dir).normalize();
    const up = this.tmpGoalUp.copy(goal.up);
    const tgt = this.tgtW[li];
    toeLocal(sg, this.outfit.shoe, this.cToe);
    const maxLeg = (THIGH + SHIN) * 0.992;
    // raise the heel (point the foot) when the leg can't reach the ankle
    for (let iter = 0; iter < 4; iter++) {
      basisQuat(dir, up, qf);
      _t2.copy(this.cToe).applyQuaternion(qf);
      if (goal.jointTarget) J.ankle[s].copy(tgt);
      else J.ankle[s].copy(tgt).sub(_t2);
      const d = J.ankle[s].distanceTo(Hp);
      if (goal.jointTarget || !goal.autoPoint || d <= maxLeg) break;
      // pitch about the foot's lateral axis: heel up (toe stays) — rotate dir/up by +angle
      this.footAxis.crossVectors(dir, up).normalize();
      const ang = Math.min(0.5, (d - maxLeg) * 3.2 + 0.05);
      // choose the rotation sign that moves the ankle toward the hip
      _q0.setFromAxisAngle(this.footAxis, ang);
      _t3.copy(dir).applyQuaternion(_q0);
      _t2.copy(up).applyQuaternion(_q0);
      basisQuat(_t3, _t2, _qa);
      _t0.copy(this.cToe).applyQuaternion(_qa);
      const dA = _t0.negate().add(tgt).distanceTo(Hp);
      if (dA < d) {
        dir.copy(_t3);
        up.copy(_t2);
      } else {
        _q0.setFromAxisAngle(this.footAxis, -ang);
        dir.applyQuaternion(_q0);
        up.applyQuaternion(_q0);
      }
    }
    // limited IK; the ankle range re-orients the foot about the toe (the toe stays on the hold)
    const iters = this.quick ? 1 : 3;
    for (let iter = 0; iter < iters; iter++) {
      basisQuat(dir, up, qf);
      if (goal.jointTarget) J.ankle[s].copy(tgt);
      else J.ankle[s].copy(tgt).sub(_t2.copy(this.cToe).applyQuaternion(qf));
      this.stretchK[li] = this.chain(li, Hp, J.ankle[s], this.poleW[li], J.knee[s], this.cOut);
      J.ankle[s].copy(this.cOut);
      const changed = this.ankleLimit(s);
      if (!changed || goal.jointTarget) break;
    }
    basisQuat(dir, up, qf);
    _t0.copy(this.cToe).applyQuaternion(qf);
    J.toe[s].copy(J.ankle[s]).add(_t0);
  }

  /** Ankle range vs the solved shin: point / flex, toe-out / toe-in, roll. True if it changed the foot. */
  private ankleLimit(s: number): boolean {
    const J = this.joints;
    const L = JOINT_LIMITS;
    const sg = SIGN[s];
    const dir = this.tmpGoalDir;
    const up = this.tmpGoalUp;
    const sh = this.kA.subVectors(J.ankle[s], J.knee[s]).normalize();
    let changed = false;
    // pointing (+) / flexing (−): the foot's angle out of the plane perpendicular to the shin
    const dl = Math.asin(clampN(dir.dot(sh), -1, 1));
    const dlc = clampN(dl, -L.ankleDorsi * DEG, L.anklePlantar * DEG);
    if (Math.abs(dlc - dl) > 1e-3) {
      const ax = this.kB.crossVectors(dir, sh);
      if (ax.lengthSq() > 1e-8) {
        ax.normalize();
        dir.applyAxisAngle(ax, dlc - dl);
        up.applyAxisAngle(ax, dlc - dl);
        changed = true;
      }
    }
    // toe-out (+) / toe-in (−) about the shin, relative to the front of the knee
    const fr = this.kB.copy(this.apex[2 + s]).addScaledVector(sh, -this.apex[2 + s].dot(sh));
    const dp = this.kN.copy(dir).addScaledVector(sh, -dir.dot(sh));
    if (fr.lengthSq() > 1e-6 && dp.lengthSq() > 1e-4) {
      fr.normalize();
      dp.normalize();
      const g0 = Math.atan2(_t1.crossVectors(fr, dp).dot(sh), fr.dot(dp)) * sg;
      const gc = clampN(g0, -L.ankleYawIn * DEG, L.ankleYawOut * DEG);
      if (Math.abs(gc - g0) > 1e-3) {
        const r = (gc - g0) * sg;
        dir.applyAxisAngle(sh, r);
        up.applyAxisAngle(sh, r);
        changed = true;
      }
    }
    // roll (inversion / eversion) of the instep about the foot axis
    const ref = this.kB.copy(sh).negate().addScaledVector(dir, sh.dot(dir));
    const hu = this.kN.copy(up).addScaledVector(dir, -up.dot(dir));
    if (ref.lengthSq() > 1e-4 && hu.lengthSq() > 1e-6) {
      ref.normalize();
      hu.normalize();
      const rho = Math.atan2(_t1.crossVectors(ref, hu).dot(dir), ref.dot(hu));
      const rc = clampN(rho, -L.ankleRoll * DEG, L.ankleRoll * DEG);
      if (Math.abs(rc - rho) > 1e-3) {
        up.applyAxisAngle(dir, rc - rho);
        changed = true;
      }
    }
    return changed;
  }

  private writeLeg(s: number): void {
    const B = this.bones;
    const ids = LEG[s];
    const J = this.joints;
    const Hp = J.hip[s];
    const k = this.stretchK[2 + s];
    _t0.subVectors(J.knee[s], Hp).normalize();
    _t1.subVectors(J.ankle[s], J.knee[s]).normalize();
    // knee apex = front of the knee = outside of the bend (thigh dir − shin dir)
    _t2.copy(_t0).sub(_t1);
    if (_t2.lengthSq() < 1e-4) _t2.copy(this.apex[2 + s]);
    B[ids.thigh].position.copy(Hp);
    basisQuat(_t0, _t2, B[ids.thigh].quaternion);
    B[ids.thigh].scale.set(1, k, 1);
    B[ids.shin].position.copy(J.knee[s]);
    basisQuat(_t1, _t2, B[ids.shin].quaternion);
    B[ids.shin].scale.set(1, k, 1);
    B[ids.foot].position.copy(J.ankle[s]);
    B[ids.foot].quaternion.copy(this.qFoot[s]);
  }

  // ───────────────────────────── limited two-bone chains ─────────────────────────────

  /**
   * Two-bone chain with anatomical limits (li: 0/1 = left/right arm, 2/3 = left/right leg). The
   * mid joint (elbow / knee) takes the swivel closest to `pole` that satisfies the joint limits and
   * stays in front of the wall. If no swivel is valid the end is pulled toward a safe, reachable
   * point by bisection, so the hand / foot hangs short instead of a joint breaking. Writes the mid
   * joint and the reached end, returns the stretch factor.
   */
  private chain(li: number, root: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, outMid: THREE.Vector3, outEnd: THREE.Vector3): number {
    this.reqEnd[li].copy(target);
    this.chains++;
    let k = this.chainCircle(li, root, target);
    let th = this.swivel(li, pole);
    this.fallback[li] = Number.isNaN(th);
    if (Number.isNaN(th)) {
      // pull in along the wall (foot straight down below its hold, hand toward shoulder height);
      // if even that is out of range, toward a point under the hip / by the hip
      this.pullEnd(li, root, target, this.cSafe);
      this.chainCircle(li, root, this.cSafe);
      if (Number.isNaN(this.swivel(li, pole, true))) this.safeEnd(li, root, this.cSafe);
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) * 0.5;
        this.cTgt.copy(this.cSafe).lerp(target, m);
        this.chainCircle(li, root, this.cTgt);
        if (Number.isNaN(this.swivel(li, pole, true))) hi = m;
        else lo = m;
      }
      this.cTgt.copy(this.cSafe).lerp(target, lo);
      k = this.chainCircle(li, root, this.cTgt);
      th = this.swivel(li, pole);
      if (Number.isNaN(th)) th = 0;
    }
    const ap = this.apex[li].copy(this.cE1).multiplyScalar(Math.cos(th)).addScaledVector(this.cE2, Math.sin(th));
    outMid.copy(this.cC).addScaledVector(ap, this.cH);
    this.wallSlack[li] = this.wallOn
      ? this.cA.subVectors(outMid, this.wallP).dot(this.wallN) - (li >= 2 ? R_KNEE_WALL : R_ELBOW_WALL) - WALL_MARGIN
      : 1;
    this.cA.subVectors(this.cEnd, outMid);
    const l = this.cA.length();
    if (l > 1e-9) outEnd.copy(outMid).addScaledVector(this.cA, this.cL2 / l);
    else outEnd.copy(this.cEnd);
    return k;
  }

  /** Swivel circle for a chain: axis cD, centre cC, radius cH, reached end cEnd (flexion-limited). */
  private chainCircle(li: number, root: THREE.Vector3, target: THREE.Vector3): number {
    const leg = li >= 2;
    const l1 = leg ? THIGH : UPPER;
    const l2 = leg ? SHIN : FORE;
    const maxStretch = leg ? 1.08 : 1.14;
    const d = this.cD.subVectors(target, root);
    let dist = d.length();
    const reach = l1 + l2;
    let k = 1;
    if (dist > reach * 0.999) k = Math.min(maxStretch, dist / (reach * 0.999));
    const L1 = l1 * k;
    const L2 = l2 * k;
    if (dist < 1e-6) {
      d.copy(leg ? this.PY : this.CY).negate();
      dist = 1e-6;
    } else d.multiplyScalar(1 / dist);
    // max flexion → minimum root–end distance (law of cosines)
    const flexMax = (leg ? JOINT_LIMITS.kneeFlex : JOINT_LIMITS.elbowFlex) * DEG;
    const dMin = Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * Math.cos(flexMax));
    const dc = clampN(dist, Math.max(dMin, Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.9995);
    const a = (L1 * L1 - L2 * L2 + dc * dc) / (2 * dc);
    this.cH = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    this.cC.copy(root).addScaledVector(d, a);
    this.cEnd.copy(root).addScaledVector(d, dc);
    this.cRoot.copy(root);
    this.cL1 = L1;
    this.cL2 = L2;
    return k;
  }

  /**
   * Swivel angle (radians from the pole direction) of the closest valid mid joint, or NaN. Prefers
   * swivels that satisfy the joint limits AND keep the elbow / knee off the wall, then joint limits
   * alone. Warm-started from the last solve; `coarse` only tests existence (30° steps).
   */
  private swivel(li: number, pole: THREE.Vector3, coarse = false): number {
    const d = this.cD;
    const e1 = this.cE1.copy(pole).addScaledVector(d, -pole.dot(d));
    if (e1.lengthSq() < 1e-8) {
      // pole along the limb: fall back to the anatomical default (knee forward, elbow back)
      if (li >= 2) e1.copy(this.PZ).negate();
      else e1.copy(this.CZ);
      e1.addScaledVector(d, -e1.dot(d));
      if (e1.lengthSq() < 1e-8) e1.crossVectors(d, Math.abs(d.y) < 0.9 ? AX_Y : AX_X);
    }
    e1.normalize();
    this.cE2.crossVectors(d, e1);
    const v0 = this.violation(li, 0);
    const w0 = this.vWall;
    if (v0 <= 0 && w0 <= 0) return (this.lastTh[li] = 0);
    if (coarse) {
      if (v0 <= 0) return 0;
      for (let k = 1; k <= 6; k++) {
        if (this.violation(li, k * SW_COARSE) <= 0) return k * SW_COARSE;
        if (k < 6 && this.violation(li, -k * SW_COARSE) <= 0) return -k * SW_COARSE;
      }
      return Number.NaN;
    }
    // warm start: last solve's swivel, if still fully valid → bisect toward the pole
    const last = this.lastTh[li];
    if (last !== 0) {
      if (this.violation(li, last) <= 0 && this.vWall <= 0) {
        // bracket the boundary between `last` and the pole with growing steps, then bisect
        const sl = last > 0 ? 1 : -1;
        let good = last;
        let bad = 0;
        let step = 0.12;
        for (let i = 0; i < 5; i++) {
          const t = good - sl * step;
          if (t * sl <= 0) break;
          if (this.violation(li, t) <= 0 && this.vWall <= 0) good = t;
          else {
            bad = t;
            break;
          }
          step *= 2;
        }
        const th = this.refineSwivel(li, bad, good, true);
        const inward = th > 0 ? SW_WARM : -SW_WARM;
        // the other side wins only when clearly closer (hysteresis)
        const lim = Math.abs(th) - SW_HYST;
        const sg = th > 0 ? -1 : 1;
        for (let k = 1; k * SW_COARSE < lim; k++) {
          if (this.violation(li, sg * k * SW_COARSE) <= 0 && this.vWall <= 0) {
            const o = this.refineSwivel(li, sg * (k - 1) * SW_COARSE, sg * k * SW_COARSE, true);
            this.swivelSign[li] = sg;
            this.lastTh[li] = o + sg * SW_WARM;
            return o;
          }
        }
        this.lastTh[li] = th + inward;
        return th;
      }
    }
    // sweep both sides outward: first fully valid (F) and first joint-valid (J) step per side, and
    // the least-bad swivel (joint violation + wall penetration) in case nothing is fully valid
    let pF = 0;
    let nF = 0;
    let pJ = 0;
    let nJ = 0;
    let bestC = v0 + SW_WALL_COST * w0;
    let bestK = 0;
    let bestV = v0;
    let needJ = v0 <= 0 ? w0 : Infinity;
    for (let k = 1; k <= 12; k++) {
      if (!pF) {
        const v = this.violation(li, k * SW_STEP);
        const c = v + SW_WALL_COST * this.vWall;
        if (v < bestV) bestV = v;
        if (c < bestC) {
          bestC = c;
          bestK = k;
        }
        if (v <= 0) {
          if (!pJ) pJ = k;
          if (this.vWall <= 0) pF = k;
          else if (this.vWall < needJ) needJ = this.vWall;
        }
      }
      if (!nF && k < 12) {
        const v = this.violation(li, -k * SW_STEP);
        const c = v + SW_WALL_COST * this.vWall;
        if (v < bestV) bestV = v;
        if (c < bestC) {
          bestC = c;
          bestK = -k;
        }
        if (v <= 0) {
          if (!nJ) nJ = k;
          if (this.vWall <= 0) nF = k;
          else if (this.vWall < needJ) needJ = this.vWall;
        }
      }
      if (pF && nF) break;
      const f = pF || nF;
      if (f && k >= f + 2) break;
    }
    const kF = pF || nF ? this.pickSide(li, pF, nF) : 0;
    if (kF) {
      const sg = kF > 0 ? 1 : -1;
      const th = this.refineSwivel(li, sg * (Math.abs(kF) - 1) * SW_STEP, kF * SW_STEP, true);
      this.swivelSign[li] = sg;
      this.lastTh[li] = th + sg * SW_WARM;
      return th;
    }
    // out of the joints' range by more than a few degrees: pull the end in
    if (v0 > 0 && !pJ && !nJ && bestV > SW_SOFT) return Number.NaN;
    // anatomical swivels exist but all put the joint into the wall (or the limits are only just
    // missed): least-bad compromise, refined
    this.wallNeed[li] = Math.max(this.wallNeed[li], Number.isFinite(needJ) ? needJ : 0);
    let lo = (bestK - 1) * SW_STEP;
    let hi = (bestK + 1) * SW_STEP;
    for (let i = 0; i < 4; i++) {
      const m1 = lo + (hi - lo) * 0.382;
      const m2 = lo + (hi - lo) * 0.618;
      const c1 = this.violation(li, m1) + SW_WALL_COST * this.vWall;
      const c2 = this.violation(li, m2) + SW_WALL_COST * this.vWall;
      if (c1 < c2) hi = m2;
      else lo = m1;
    }
    this.lastTh[li] = 0;
    return (lo + hi) * 0.5;
  }

  /** Signed step of the side to use (hysteresis: keep last side unless the other is ≥ 2 steps closer). */
  private pickSide(li: number, p: number, n: number): number {
    if (!p) return -n;
    if (!n) return p;
    const pref = this.swivelSign[li] > 0 ? p : -n;
    const other = this.swivelSign[li] > 0 ? -n : p;
    return Math.abs(other) + 2 <= Math.abs(pref) ? other : pref;
  }

  /** Bisection between an invalid and a valid swivel angle → the boundary (valid side). */
  private refineSwivel(li: number, bad: number, good: number, full: boolean): number {
    for (let i = 0; i < 4; i++) {
      const m = (bad + good) * 0.5;
      if (this.violation(li, m) <= 0 && (!full || this.vWall <= 0)) good = m;
      else bad = m;
    }
    return good;
  }

  /**
   * How far a swivel breaks the limb's limits (0 = anatomical): the hip / shoulder cone and the hip /
   * shoulder rotation (twist of the knee / elbow apex about the bone). The mid joint's wall
   * penetration goes to `vWall`. Uses the circle from chainCircle + the basis from swivel.
   */
  private violation(li: number, th: number): number {
    this.evals++;
    this.evalsL[li]++;
    const leg = li >= 2;
    const sg = SIGN[li & 1];
    const L = JOINT_LIMITS;
    const e = this.cV.copy(this.cE1).multiplyScalar(Math.cos(th)).addScaledVector(this.cE2, Math.sin(th));
    const mid = this.cMid.copy(this.cC).addScaledVector(e, this.cH);
    const root = this.cRoot;
    const u = this.cA.subVectors(mid, root).normalize(); // upper arm / thigh
    const f = this.cB.subVectors(this.cEnd, mid).normalize(); // forearm / shin
    const flex = Math.acos(clampN(u.dot(f), -1, 1));
    let v = 0;
    // apex ⟂ bone: twist reference (well defined for straight limbs too)
    const ap = e.addScaledVector(u, -e.dot(u));
    const hasAp = ap.lengthSq() > 1e-8;
    if (hasAp) ap.normalize();
    if (leg) {
      const ox = u.dot(this.PX) * sg;
      const oy = u.dot(this.PY);
      const oz = -u.dot(this.PZ);
      const theta = Math.acos(clampN(-oy, -1, 1));
      let max = polarMax(L.hipCone, Math.atan2(oz, ox) / DEG);
      if (oz > 0) {
        // straight-leg raise: deep flexion needs a bent knee
        const straight = L.hipFlexStraight * DEG;
        if (max > straight) max -= (max - straight) * (oz / Math.max(1e-6, Math.hypot(ox, oz))) * (1 - sstep(0.35, 1.05, flex));
      }
      if (theta > max) v += theta - max;
      if (hasAp) {
        // neutral knee apex: ⟂ thigh, toward forward (hanging thigh) … up (flexed / abducted thigh)
        const w = sstep(30 * DEG, 100 * DEG, theta);
        const n = this.cN.copy(this.PY).multiplyScalar(w).addScaledVector(this.PZ, w - 1);
        n.addScaledVector(u, -n.dot(u)).normalize();
        const psi = Math.atan2(this.kC.crossVectors(n, ap).dot(u), n.dot(ap)) * sg;
        if (psi > L.hipRotOut * DEG) v += psi - L.hipRotOut * DEG;
        else if (psi < -L.hipRotIn * DEG) v += -L.hipRotIn * DEG - psi;
      }
    } else {
      const ox = u.dot(this.CX) * sg;
      const oy = u.dot(this.CY);
      const oz = -u.dot(this.CZ);
      const theta = Math.acos(clampN(ox, -1, 1));
      const max = polarMax(L.shoulderCone, Math.atan2(oz, oy) / DEG);
      if (theta > max) v += theta - max;
      if (hasAp) {
        this.cN.copy(this.CX).multiplyScalar(sg);
        this.cQ.setFromUnitVectors(this.cN, u);
        const n = this.cN.copy(this.CZ).applyQuaternion(this.cQ);
        const psi = Math.atan2(this.kC.crossVectors(n, ap).dot(u), n.dot(ap)) * sg;
        if (psi > L.shoulderRotOut * DEG) v += psi - L.shoulderRotOut * DEG;
        else if (psi < -L.shoulderRotIn * DEG) v += -L.shoulderRotIn * DEG - psi;
      }
    }
    this.vWall = 0;
    if (this.wallOn) {
      const dep = this.cN.subVectors(mid, this.wallP).dot(this.wallN) - (leg ? R_KNEE_WALL : R_ELBOW_WALL) - WALL_MARGIN;
      if (dep < 0) this.vWall = -dep;
    }
    return v;
  }

  /** The target slid along the body axis into range: a foot down to 0.45 m below the hip, a hand to ±0.25 m of the shoulder. */
  private pullEnd(li: number, root: THREE.Vector3, target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const up = li >= 2 ? this.PY : this.CY;
    const h = this.kA.subVectors(target, root).dot(up);
    const want = li >= 2 ? Math.min(h, -0.45) : clampN(h, -0.25, 0.25);
    out.copy(target).addScaledVector(up, want - h);
    // and no further than a comfortable reach from the root
    this.kA.subVectors(out, root);
    const l = this.kA.length();
    const maxL = li >= 2 ? 0.72 : 0.5;
    if (l > maxL) out.copy(root).addScaledVector(this.kA, maxL / l);
    return out;
  }

  /** A comfortably reachable end point for the bisection fallback (hand by the hip, foot under it). */
  private safeEnd(li: number, root: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const sg = SIGN[li & 1];
    if (li >= 2) return out.copy(root).addScaledVector(this.PY, -0.62).addScaledVector(this.PZ, -0.12).addScaledVector(this.PX, sg * 0.05);
    return out.copy(root).addScaledVector(this.CY, -0.3).addScaledVector(this.CZ, -0.22).addScaledVector(this.CX, sg * 0.06);
  }

  // ───────────────────────────── self-collision ─────────────────────────────

  /** Torso / pelvis / neck capsules and the head spheres in rig space. */
  private updateProxies(g: BodyGoal): void {
    const B = this.bones;
    // ribcage: a lateral capsule through the chest
    this.kA.copy(g.chest).addScaledVector(this.CY, -0.11);
    this.chestA.copy(this.kA).addScaledVector(this.CX, -0.075);
    this.chestB.copy(this.kA).addScaledVector(this.CX, 0.075);
    // belly / waist
    this.kB.copy(this.PX).add(this.CX).normalize();
    this.bellyA.copy(B[BONE.spine].position).addScaledVector(this.kB, -0.055);
    this.bellyB.copy(B[BONE.spine].position).addScaledVector(this.kB, 0.055);
    // pelvis between the hip joints
    this.kA.copy(g.pelvis).addScaledVector(this.PY, 0.03);
    this.pelvA.copy(this.kA).addScaledVector(this.PX, -0.06);
    this.pelvB.copy(this.kA).addScaledVector(this.PX, 0.06);
    // neck: base of the neck → under the skull
    this.neckB.copy(g.chest).lerp(this.joints.head, 0.62);
    // head (skull, snout, ears, beard, horns)
    const nq = B[BONE.neck].quaternion;
    const np = B[BONE.neck].position;
    const H = this.headLocal;
    const W = this.headW;
    for (let j = 0; j < this.headN; j++) {
      this.hs.set(H[j * 4], H[j * 4 + 1], H[j * 4 + 2]).applyQuaternion(nq).add(np);
      W[j * 4] = this.hs.x;
      W[j * 4 + 1] = this.hs.y;
      W[j * 4 + 2] = this.hs.z;
      W[j * 4 + 3] = H[j * 4 + 3];
    }
  }

  /** Segment endpoints of a limb part: seg 0 = upper arm / thigh, 1 = forearm / shin. */
  private segOf(li: number, seg: number, outA: THREE.Vector3, outB: THREE.Vector3, p0: number): void {
    const J = this.joints;
    const s = li & 1;
    const arm = li < 2;
    const r = arm ? J.shoulder[s] : J.hip[s];
    const m = arm ? J.elbow[s] : J.knee[s];
    const e = arm ? J.wrist[s] : J.ankle[s];
    if (seg === 0) {
      outA.copy(r).lerp(m, p0);
      outB.copy(m);
    } else {
      outA.copy(m);
      outB.copy(e);
    }
  }

  private radiusOf(li: number, seg: number, t: number): number {
    const R = li < 2 ? (seg === 0 ? R_UPPER : R_FORE) : seg === 0 ? R_THIGH : R_SHIN;
    return R[0] + (R[1] - R[0]) * t;
  }

  /**
   * Limb part vs a body capsule (C–D, radius rc; C = D for a sphere). Accumulates the elbow / knee
   * push that clears the contact (scaled by the lever from the fixed end) and, for free limbs, a
   * nudge of the hand / foot. Returns 1 on contact.
   */
  private hitBody(li: number, seg: number, p0: number, C: THREE.Vector3, D: THREE.Vector3, rc: number, head: boolean): number {
    this.segOf(li, seg, this.kA, this.kB, p0);
    const dist = segSeg(this.kA, this.kB, C, D);
    const tFull = seg === 0 ? p0 + (1 - p0) * segS : segS;
    const pen = this.radiusOf(li, seg, tFull) + rc - dist;
    if (pen <= 0) return 0;
    const n = this.kN.subVectors(_cp1, _cp2);
    if (dist > 1e-6) n.multiplyScalar(1 / dist);
    else if (this.awayV.lengthSq() > 0) n.copy(this.awayV);
    else n.copy(this.PZ);
    const lever = seg === 0 ? tFull : 1 - segS;
    this.push[li].addScaledVector(n, pen / Math.max(0.35, lever));
    if (seg === 1 && segS > 0.45) this.endPush[li].addScaledVector(n, pen * segS);
    if (head) {
      // turn the head away from the contact side (positive yaw = look toward −X)
      const lat = this.kC.subVectors(_cp2, this.joints.head).dot(this.CX);
      this.headPushAcc += (lat >= 0 ? 1 : -1) * pen * 5;
    }
    return 1;
  }
  private headPushAcc = 0;

  /** Front (+1: limb i passes in front, toward `away`) when two limbs cross. */
  private frontOf(g: BodyGoal, li: number, lj: number): number {
    const gi = li < 2 ? g.hands[li] : g.feet[li - 2];
    const gj = lj < 2 ? g.hands[lj] : g.feet[lj - 2];
    if (gi.layer !== gj.layer) return gi.layer > gj.layer ? 1 : -1;
    // heuristic: the limb whose end crossed further toward the other side is the crossing one
    return this.crossAmount(li) <= this.crossAmount(lj) ? 1 : -1;
  }

  /** How far a limb's end sits on its own side of its root (negative = crossed toward the other side). */
  private crossAmount(l: number): number {
    const J = this.joints;
    const s = l & 1;
    const arm = l < 2;
    const r = arm ? J.shoulder[s] : J.hip[s];
    const e = arm ? J.wrist[s] : J.ankle[s];
    return this.kC.subVectors(e, r).dot(arm ? this.CX : this.PX) * SIGN[s];
  }

  /** Limb part vs limb part: the front limb moves toward `away`, the back one toward the wall. */
  private hitLimbs(g: BodyGoal, li: number, si: number, lj: number, sj: number, p0: number): number {
    this.segOf(li, si, this.kA, this.kB, si === 0 ? p0 : 0);
    this.segOf(lj, sj, this.kD, this.kE, sj === 0 ? p0 : 0);
    const dist = segSeg(this.kA, this.kB, this.kD, this.kE);
    const ti = si === 0 ? p0 + (1 - p0) * segS : segS;
    const tj = sj === 0 ? p0 + (1 - p0) * segT : segT;
    const pen = this.radiusOf(li, si, ti) + this.radiusOf(lj, sj, tj) - dist;
    if (pen <= 0) return 0;
    const n = this.kN.subVectors(_cp1, _cp2);
    if (dist > 1e-6) n.multiplyScalar(1 / dist);
    else n.set(0, 0, 0);
    const front = this.frontOf(g, li, lj);
    if (this.awayV.lengthSq() > 0) n.multiplyScalar(0.35).addScaledVector(this.awayV, 0.75 * front);
    if (n.lengthSq() < 1e-8) n.copy(this.PZ).multiplyScalar(front);
    n.normalize();
    const li0 = si === 0 ? ti : 1 - segS;
    const lj0 = sj === 0 ? tj : 1 - segT;
    this.push[li].addScaledVector(n, (0.55 * pen) / Math.max(0.35, li0));
    this.push[lj].addScaledVector(n, (-0.55 * pen) / Math.max(0.35, lj0));
    return 1;
  }

  /**
   * Capsule self-collision after the limited IK: arms vs the head (incl. horns), neck and torso,
   * legs vs the torso, and the limbs against each other (the depth layer decides who passes in
   * front). Contacts swivel the elbow / knee away (the chain solver keeps every joint limit and
   * the wall clearance); hands / feet stay on their holds. Fixed pair list, ≤ 3 iterations.
   */
  private resolveCollisions(g: BodyGoal): void {
    const J = this.joints;
    this.headPushAcc = 0;
    for (let it = 0; it < 3; it++) {
      this.updateProxies(g);
      for (let i = 0; i < 4; i++) {
        this.push[i].set(0, 0, 0);
        this.endPush[i].set(0, 0, 0);
      }
      let hits = 0;
      const W = this.headW;
      for (let s = 0; s < 2; s++) {
        const leg = 2 + s;
        // arms vs head (skull, snout, ears, beard, horns) and neck
        for (let j = 0; j < this.headN; j++) {
          this.hs.set(W[j * 4], W[j * 4 + 1], W[j * 4 + 2]);
          const r = W[j * 4 + 3];
          hits += this.hitBody(s, 0, 0.3, this.hs, this.hs, r, it === 0);
          hits += this.hitBody(s, 1, 0, this.hs, this.hs, r, it === 0);
        }
        hits += this.hitBody(s, 0, 0.45, g.chest, this.neckB, 0.055, false);
        hits += this.hitBody(s, 1, 0, g.chest, this.neckB, 0.055, false);
        // arms vs torso (crossing the chest, hands low by the hips)
        hits += this.hitBody(s, 1, 0, this.chestA, this.chestB, 0.105, false);
        hits += this.hitBody(s, 1, 0, this.bellyA, this.bellyB, 0.097, false);
        hits += this.hitBody(s, 1, 0, this.pelvA, this.pelvB, 0.088, false);
        hits += this.hitBody(s, 0, 0.55, this.bellyA, this.bellyB, 0.097, false);
        // legs vs torso (high steps, tight crouches)
        hits += this.hitBody(leg, 0, 0.45, this.bellyA, this.bellyB, 0.097, false);
        hits += this.hitBody(leg, 0, 0.45, this.chestA, this.chestB, 0.105, false);
        hits += this.hitBody(leg, 1, 0, this.bellyA, this.bellyB, 0.097, false);
        hits += this.hitBody(leg, 1, 0, this.chestA, this.chestB, 0.105, false);
        hits += this.hitBody(leg, 1, 0, this.pelvA, this.pelvB, 0.088, false);
      }
      // limbs vs limbs
      hits += this.hitLimbs(g, 0, 1, 1, 1, 0);
      hits += this.hitLimbs(g, 0, 0, 1, 1, 0.35);
      hits += this.hitLimbs(g, 0, 1, 1, 0, 0.35);
      hits += this.hitLimbs(g, 0, 0, 1, 0, 0.35);
      hits += this.hitLimbs(g, 2, 0, 3, 0, 0.4);
      hits += this.hitLimbs(g, 2, 1, 3, 1, 0);
      hits += this.hitLimbs(g, 2, 0, 3, 1, 0.4);
      hits += this.hitLimbs(g, 2, 1, 3, 0, 0.4);
      for (let a = 0; a < 2; a++) {
        hits += this.hitLimbs(g, a, 1, 2, 0, 0.3);
        hits += this.hitLimbs(g, a, 1, 3, 0, 0.3);
      }
      if (!hits) break;
      this.contacts += hits;
      for (let i = 0; i < 4; i++) {
        const p = this.push[i];
        const e = this.endPush[i];
        if (p.lengthSq() < 1e-10 && e.lengthSq() < 1e-10) continue;
        const arm = i < 2;
        const s = i & 1;
        const root = arm ? J.shoulder[s] : J.hip[s];
        const mid = arm ? J.elbow[s] : J.knee[s];
        this.poleW[i].subVectors(mid, root).addScaledVector(p, 1.35);
        const lg = arm ? g.hands[s] : g.feet[s];
        if (!lg.pinned && e.lengthSq() > 0) this.tgtW[i].addScaledVector(e, 1.1);
        this.quick = true;
        if (arm) this.solveArm(g, s);
        else this.solveLeg(g, s);
        this.quick = false;
      }
    }
    this.headAvoidT = clampN(this.headPushAcc, -0.3, 0.3);
  }

  /** QA: why a limb's target is (un)reachable — samples its swivel circle (cone, rotation, wall). */
  diagnose(li: number): string {
    const J = this.joints;
    const s = li & 1;
    const leg = li >= 2;
    const root = leg ? J.hip[s] : J.shoulder[s];
    // the ankle / wrist position requested in the last solve (before any pull-in)
    const end = this.cOut.copy(this.reqEnd[li]);
    this.chainCircle(li, root, end);
    const e1 = this.cE1.copy(this.poleW[li]).addScaledVector(this.cD, -this.poleW[li].dot(this.cD)).normalize();
    this.cE2.crossVectors(this.cD, e1);
    const L = JOINT_LIMITS;
    const sg = SIGN[s];
    const rows: string[] = [`limb ${li} dist ${end.distanceTo(root).toFixed(3)} h ${this.cH.toFixed(3)} fb ${this.fallback[li]}`];
    for (let k = 0; k < 24; k++) {
      const th = (k * Math.PI) / 12;
      const v = this.violation(li, th);
      const vw = this.vWall;
      const u = this.cA;
      const ap = this.cV;
      let cone = '';
      let rot = '';
      if (leg) {
        const ox = u.dot(this.PX) * sg;
        const oy = u.dot(this.PY);
        const oz = -u.dot(this.PZ);
        const theta = Math.acos(clampN(-oy, -1, 1));
        const om = Math.atan2(oz, ox) / DEG;
        cone = `θ ${(theta / DEG).toFixed(0)} ω ${om.toFixed(0)} max ${(polarMax(L.hipCone, om) / DEG).toFixed(0)}`;
        const w = sstep(30 * DEG, 100 * DEG, theta);
        const n = this.cN.copy(this.PY).multiplyScalar(w).addScaledVector(this.PZ, w - 1);
        n.addScaledVector(u, -n.dot(u)).normalize();
        rot = `ψ ${((Math.atan2(this.kC.crossVectors(n, ap).dot(u), n.dot(ap)) * sg) / DEG).toFixed(0)}`;
      } else {
        const ox = u.dot(this.CX) * sg;
        const oy = u.dot(this.CY);
        const oz = -u.dot(this.CZ);
        const om = Math.atan2(oz, oy) / DEG;
        cone = `θ ${(Math.acos(clampN(ox, -1, 1)) / DEG).toFixed(0)} ω ${om.toFixed(0)} max ${(polarMax(L.shoulderCone, om) / DEG).toFixed(0)}`;
        this.cN.copy(this.CX).multiplyScalar(sg);
        this.cQ.setFromUnitVectors(this.cN, u);
        const n = this.cN.copy(this.CZ).applyQuaternion(this.cQ);
        rot = `ψ ${((Math.atan2(this.kC.crossVectors(n, ap).dot(u), n.dot(ap)) * sg) / DEG).toFixed(0)}`;
      }
      const mid = this.cMid;
      const dep = mid.clone().sub(this.wallP).dot(this.wallN);
      rows.push(`sw ${k * 15} v ${v.toFixed(3)} vw ${vw.toFixed(3)} ${cone} ${rot} depth ${dep.toFixed(2)}`);
    }
    return rows.join('\n');
  }

  /** QA: visit every collision proxy (a, b, radius at a, radius at b; a = b for spheres). */
  forEachProxy(cb: (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number) => void): void {
    const J = this.joints;
    cb(this.chestA, this.chestB, 0.105, 0.105);
    cb(this.bellyA, this.bellyB, 0.097, 0.097);
    cb(this.pelvA, this.pelvB, 0.088, 0.088);
    cb(this.bones[BONE.neck].position, this.neckB, 0.055, 0.055);
    for (let j = 0; j < this.headN; j++) {
      this.hs.set(this.headW[j * 4], this.headW[j * 4 + 1], this.headW[j * 4 + 2]);
      cb(this.hs, this.hs, this.headW[j * 4 + 3], this.headW[j * 4 + 3]);
    }
    for (let s = 0; s < 2; s++) {
      cb(J.shoulder[s], J.elbow[s], R_UPPER[0], R_UPPER[1]);
      cb(J.elbow[s], J.wrist[s], R_FORE[0], R_FORE[1]);
      cb(J.hip[s], J.knee[s], R_THIGH[0], R_THIGH[1]);
      cb(J.knee[s], J.ankle[s], R_SHIN[0], R_SHIN[1]);
    }
  }

  private solveBag(dt: number): void {
    const bag = this.bones[BONE.bag];
    // attach point: back of the belt, right of centre
    _t0.set(0.05, 0.05, 0.098).applyQuaternion(this.qPelvis).add(this.bones[BONE.pelvis].position);
    bag.position.copy(_t0);
    // pendulum tip
    _t1.set(0, -1, 0).lerp(_t2.set(0, -1, 0).applyQuaternion(this.qPelvis), 0.35).normalize();
    _t1.multiplyScalar(0.08).add(_t0); // rest tip
    if (!this.bagInit || dt <= 0 || dt > 0.2) {
      this.bagTip.copy(_t1);
      this.bagVel.set(0, 0, 0);
      this.bagInit = true;
    } else {
      _t2.subVectors(_t1, this.bagTip).multiplyScalar(140);
      this.bagVel.addScaledVector(_t2, dt).multiplyScalar(Math.exp(-dt * 7));
      this.bagTip.addScaledVector(this.bagVel, dt);
      _t2.subVectors(this.bagTip, _t0);
      const l = _t2.length();
      if (l > 1e-6) this.bagTip.copy(_t0).addScaledVector(_t2, 0.08 / l);
    }
    _t2.subVectors(_t0, this.bagTip).normalize(); // bag up axis
    _t3.set(0, 0, 1).applyQuaternion(this.qPelvis); // away from the body (back)
    basisQuat(_t2, _t3, bag.quaternion);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.harness.geometry.dispose();
    // the outfit atlas is shared by every rig of the same style (cached in materials.ts)
    this.material.dispose();
    this.skeleton.dispose();
  }
}

// ═══════════════════════════════ ClimberModel ═══════════════════════════════

/** Optional per-hold information the renderer can supply (hand shapes + contact depth). */
export interface HoldInfo {
  type: HoldType;
  /** HoldDef.angle: direction from the hold toward where the body should be. */
  angle: number;
  size: number;
  /** Height of the hold above the wall surface (m). */
  depth: number;
}

interface HandShape {
  a: number;
  b: number;
  thumb: number;
}

/** Finger curl per hold type (radians for the two segments + thumb opposition). */
const GRIP: Record<HoldType, HandShape> = {
  jug: { a: 1.05, b: 1.15, thumb: 0.5 },
  edge: { a: 0.95, b: 0.8, thumb: 0.45 },
  crimp: { a: 1.2, b: 0.35, thumb: 0.9 },
  sloper: { a: 0.32, b: 0.22, thumb: 0.25 },
  pinch: { a: 0.8, b: 0.65, thumb: 1.0 },
  pocket: { a: 0.85, b: 1.05, thumb: 0.35 },
  volume: { a: 0.18, b: 0.12, thumb: 0.2 },
  foot: { a: 1.15, b: 0.9, thumb: 0.7 },
};
const SHAPE_FREE: HandShape = { a: 0.42, b: 0.48, thumb: 0.25 };
const SHAPE_REACH: HandShape = { a: 0.14, b: 0.1, thumb: 0.22 };
const SHAPE_OPEN: HandShape = { a: 0.08, b: 0.04, thumb: 0.08 };
const SHAPE_CLIP: HandShape = { a: 0.75, b: 0.55, thumb: 0.95 };
const SHAPE_FIST: HandShape = { a: 1.45, b: 1.55, thumb: 1.0 };

const HAND_IDS: readonly LimbId[] = ['LH', 'RH'];
const FOOT_IDS: readonly LimbId[] = ['LF', 'RF'];

/** Smooth pseudo-random signal in [-1, 1] (sum of incommensurate sines). */
function wobble(t: number, seed: number): number {
  return Math.sin(t * 1.0 + seed) * 0.55 + Math.sin(t * 2.37 + seed * 1.9) * 0.3 + Math.sin(t * 5.11 + seed * 3.1) * 0.15;
}

const dampK = (lambda: number, dt: number): number => (dt <= 0 ? 1 : 1 - Math.exp(-lambda * dt));

/**
 * Depth-layer hint from the sim (optional LimbSnapshot fields, read defensively): `layer` (higher
 * = in front, toward the camera) or `front` (true = in front). 0 when absent.
 */
function layerOf(L: LimbSnapshot): number {
  const x = L as LimbSnapshot & { layer?: unknown; front?: unknown };
  if (typeof x.layer === 'number' && Number.isFinite(x.layer)) return x.layer;
  if (typeof x.front === 'boolean') return x.front ? 1 : 0;
  return 0;
}

export class ClimberModel extends THREE.Group {
  readonly rig: BodyRig;
  private head: THREE.Group;
  private headId: HeadId;
  private blinkW: number[] | null = null;
  private goal = createBodyGoal();
  private look: Vec2 = { x: 0, y: 0 };
  private hasLook = false;
  private holdLookup: ((id: string, out: HoldInfo) => boolean) | null = null;
  private ropeAnchor = new THREE.Vector3();
  private hasRopeAnchor = false;
  private holdInfo: HoldInfo[] = [0, 1, 2, 3].map(() => ({ type: 'edge' as HoldType, angle: -Math.PI / 2, size: 0.06, depth: 0.03 }));
  private time = 0;
  private phase: ClimberState['phase'] | null = null;
  private phaseT = 0;
  private celebrateT = -1;
  private blinkT = 2.2;
  private blink = 0;
  private initialized = false;
  private limbWorld: Record<LimbId, THREE.Vector3> = { LH: new THREE.Vector3(), RH: new THREE.Vector3(), LF: new THREE.Vector3(), RF: new THREE.Vector3() };

  // smoothed state
  private sP = new THREE.Vector3();
  private sC = new THREE.Vector3();
  private sHand = [new THREE.Vector3(), new THREE.Vector3()];
  private sFoot = [new THREE.Vector3(), new THREE.Vector3()];
  private sLook = new THREE.Vector3();
  private sChestDepth = 0.25;
  private sYaw = 0;
  private sShape: HandShape[] = [{ ...SHAPE_FREE }, { ...SHAPE_FREE }];
  private sRope = [0, 0];
  private sStand = 0;
  /** Drop-knee / backstep amount per foot (foot crossed inward of its hip) and the hip turn it drives. */
  private dropK = [0, 0];
  private sDrop = 0;
  /** High step: the hips sit back from the wall and that hip hikes up. */
  private sSit = 0;
  private sHike = 0;

  // scratch
  private rawP = new THREE.Vector3();
  private rawC = new THREE.Vector3();
  private U = new THREE.Vector3();
  private Rb = new THREE.Vector3();
  private Nh = new THREE.Vector3();
  private S = new THREE.Vector3();
  private Hp = new THREE.Vector3();
  private v0 = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private p2: Vec2 = { x: 0, y: 0 };

  constructor(opts?: { head?: HeadId; colorway?: ColorwayId; chalk?: ChalkId }) {
    super();
    this.name = 'climber';
    this.rig = new BodyRig({ style: 'climber', shoe: 'climbing', chalkBag: true, belt: true });
    this.add(this.rig.root);
    this.headId = opts?.head ?? 'ibex';
    this.head = createHead(this.headId);
    this.head.rotation.y = Math.PI;
    this.rig.bones[BONE.neck].add(this.head);
    this.rig.setHeadProxies(this.head);
    this.blinkW = headBlinkWeights(this.head);
    this.setSkin(this.headId, opts?.colorway ?? 'basalt', opts?.chalk ?? 'classic');
    this.rig.restGoal(this.goal);
    this.rig.solve(this.goal, 0);
  }

  setSkin(head: HeadId, colorway: ColorwayId, chalk: ChalkId): void {
    const cw = COLORWAYS.find((c) => c.id === colorway) ?? COLORWAYS[0];
    const ch = CHALKS.find((c) => c.id === chalk) ?? CHALKS[0];
    this.rig.setPalette(cw, ch.color);
    if (head !== this.headId) {
      this.rig.bones[BONE.neck].remove(this.head);
      disposeHead(this.head);
      this.headId = head;
      this.head = createHead(head);
      this.head.rotation.y = Math.PI;
      this.rig.bones[BONE.neck].add(this.head);
      this.rig.setHeadProxies(this.head);
      this.blinkW = headBlinkWeights(this.head);
    }
  }

  setHarness(on: boolean): void {
    this.rig.setHarness(on);
  }

  setLookTarget(p: Vec2 | null): void {
    this.hasLook = !!p;
    if (p) {
      this.look.x = p.x;
      this.look.y = p.y;
    }
  }

  /**
   * Optional: hold lookup for hand shapes and contact depth (the renderer wires its HoldSet).
   * The callback fills `out` and returns false when the id is unknown (no allocation per frame).
   */
  setHoldLookup(fn: ((id: string, out: HoldInfo) => boolean) | null): void {
    this.holdLookup = fn;
  }

  private lookupHold(id: string | null, slot: number): HoldInfo | null {
    if (!id || !this.holdLookup) return null;
    const out = this.holdInfo[slot];
    return this.holdLookup(id, out) ? out : null;
  }

  celebrate(): void {
    if (this.celebrateT < 0 || this.celebrateT > 1.5) this.celebrateT = 0;
  }

  /** Optional: world position the rope runs to from the harness (last clipped draw), or null. */
  setRopeAnchor(p: THREE.Vector3 | null): void {
    this.hasRopeAnchor = !!p;
    if (p) this.ropeAnchor.copy(p);
  }

  getHarnessWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.rig.joints.tieIn);
  }

  getLimbWorld(limb: LimbId, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.limbWorld[limb]);
  }

  // ───────────────────────────── posing ─────────────────────────────

  pose(state: ClimberState, frame: WallFrame, dt: number): void {
    const d = Math.min(Math.max(dt, 0), 0.1);
    this.time += d;
    const ph = state.phase;
    let snap = !this.initialized || dt <= 0;
    if (ph !== this.phase) {
      // a reset (anything → idle) teleports the climber onto the start holds: snap
      if (ph === 'idle' || this.phase === null) snap = true;
      if (ph === 'falling' || ph === 'idle') this.celebrateT = -1;
      // the send celebration plays automatically on topping out (celebrate() can also trigger it)
      if (ph === 'topped' && this.celebrateT < 0) this.celebrateT = 0;
      this.phase = ph;
      this.phaseT = 0;
    } else this.phaseT += d;
    if (this.celebrateT >= 0) this.celebrateT += d;
    const g = this.goal;
    const Rw = frame.right;
    const Uw = frame.up;
    const Nw = frame.normal;
    const t = this.time;
    // horizontal "toward the camera" (wall normal flattened)
    this.Nh.set(Nw.x, 0, Nw.z);
    if (this.Nh.lengthSq() < 1e-6) this.Nh.set(0, 0, 1);
    this.Nh.normalize();
    const overhang = Math.max(0, Math.sin((frame.angleDeg * Math.PI) / 180));

    // body frame in the wall plane (spec: U = chest − pelvis, R = (U.y, −U.x))
    const bux = state.chest.x - state.pelvis.x;
    const buy = state.chest.y - state.pelvis.y;
    const bul = Math.max(1e-6, Math.hypot(bux, buy));
    const bUx = bux / bul;
    const bUy = buy / bul;
    const bRx = bUy;
    const bRy = -bUx;
    const onWall = ph === 'climbing' || ph === 'idle' || ph === 'topped';

    // high step: a foot near / above hip height makes the hips sit back from the wall (room for the
    // knee in front of the hip) and hikes that hip, as real climbers do to get a foot up high
    let sit = 0;
    let hike = 0;
    if (onWall) {
      for (let s = 0; s < 2; s++) {
        const L = state.limbs[FOOT_IDS[s]];
        if (L.holdId === null && !L.smearing && !L.dragging) continue;
        const vx = L.pos.x - L.anchor.x;
        const vy = L.pos.y - L.anchor.y;
        const hf = vx * bUx + vy * bUy;
        const out = (vx * bRx + vy * bRy) * SIGN[s];
        sit = Math.max(sit, 0.2 * sstep(-0.14, 0.3, hf));
        hike += SIGN[s] * 0.4 * sstep(-0.1, 0.25, hf) * sstep(0.0, 0.2, out);
      }
    }
    this.sSit += (sit - this.sSit) * (snap ? 1 : dampK(5, d));
    this.sHike += (hike - this.sHike) * (snap ? 1 : dampK(5, d));

    // ── pelvis + chest ──
    frame.toWorld(state.pelvis, Math.max(0.13, state.pelvisDepth) + this.sSit, this.rawP);
    let chestDepth = Math.min(0.42, Math.max(0.17, 0.15 + 0.36 * state.pelvisDepth));
    if (ph === 'climbing' || ph === 'idle' || ph === 'topped') {
      for (let s = 0; s < 2; s++) {
        const L = state.limbs[HAND_IDS[s]];
        if (!L.holdId && !L.busy) continue;
        const dp = Math.hypot(L.pos.x - L.anchor.x, L.pos.y - L.anchor.y);
        const reach = 0.64;
        const gap = Math.sqrt(Math.max(0, reach * reach - dp * dp));
        chestDepth = Math.min(chestDepth, L.depth + gap);
      }
      chestDepth = Math.max(0.15, chestDepth);
    } else if (ph === 'falling') chestDepth = state.pelvisDepth + 0.04;
    else chestDepth = state.pelvisDepth + 0.06;
    this.sChestDepth += (chestDepth - this.sChestDepth) * (snap ? 1 : dampK(7, d));
    frame.toWorld(state.chest, this.sChestDepth, this.rawC);

    const pad = GAME.padHeight;
    if (ph === 'landed') {
      // crouch on impact, then stand up; upright in WORLD space (the wall may be tilted)
      const simStand = sstep(pad + 0.6, pad + 0.88, this.rawP.y);
      const stand = Math.max(simStand, sstep(0.85, 1.9, this.phaseT));
      this.sStand += (stand - this.sStand) * (snap ? 1 : dampK(6, d));
      const st = this.sStand;
      const standY = pad + 0.93;
      this.rawP.y = this.rawP.y + (Math.max(this.rawP.y, standY) - this.rawP.y) * st;
      // relaxed weight shift once standing
      this.rawP.addScaledVector(frame.right, Math.sin(this.time * 0.85) * 0.018 * st);
      this.rawP.y -= (0.5 + 0.5 * Math.sin(this.time * 1.7)) * 0.006 * st;
      this.rawC.copy(this.rawP).addScaledVector(WORLD_UP, 0.49).addScaledVector(this.Nh, -0.13 * (1 - st));
      this.rawC.addScaledVector(frame.right, -Math.sin(this.time * 0.85) * 0.008 * st);
    } else if (ph === 'hanging') {
      // sit in the harness under the rope: torso upright, leaning back off the wall a little. The
      // sim's swinging spine may point anywhere (even head-down right after the catch): only its
      // sideways lean is kept, never more than ~25° off upright.
      this.v0.subVectors(this.rawC, this.rawP);
      this.v0.y = 0;
      const lean = Math.min(1, this.v0.length() / BODY.spine);
      if (lean > 1e-4) this.v0.normalize();
      this.v0.multiplyScalar(0.42 * lean).addScaledVector(WORLD_UP, 1).addScaledVector(Nw, 0.12).normalize();
      this.rawC.copy(this.rawP).addScaledVector(this.v0, BODY.spine);
    } else if (ph === 'falling') {
      // the rope catches the harness, so the sim's spine can whip past horizontal: keep the torso
      // within 50° of upright so a fall never reads as a head-first dive
      this.v0.subVectors(this.rawC, this.rawP);
      const len = this.v0.length();
      if (len > 1e-5) {
        this.v0.multiplyScalar(1 / len);
        const cosMax = Math.cos(50 * DEG2);
        if (this.v0.y < cosMax) {
          this.v1.copy(this.v0).addScaledVector(WORLD_UP, -this.v0.y);
          if (this.v1.lengthSq() < 1e-6) this.v1.copy(Nw);
          this.v1.normalize();
          this.v0.copy(WORLD_UP).multiplyScalar(cosMax).addScaledVector(this.v1, Math.sqrt(1 - cosMax * cosMax));
          this.rawC.copy(this.rawP).addScaledVector(this.v0, len);
        }
      }
    }

    // smoothing (phase dependent); big jumps snap
    const lamBody = ph === 'falling' ? 60 : ph === 'hanging' ? 28 : ph === 'landed' ? 16 : 24;
    const kB = snap ? 1 : dampK(lamBody, d);
    if (snap || this.sP.distanceToSquared(this.rawP) > 0.36) {
      this.sP.copy(this.rawP);
      this.sC.copy(this.rawC);
    } else {
      this.sP.lerp(this.rawP, kB);
      this.sC.lerp(this.rawC, kB);
    }
    g.pelvis.copy(this.sP);
    g.chest.copy(this.sC);
    // whole-body shake + idle sway (in the wall plane)
    const shake = state.shake * 0.009;
    if (shake > 1e-5) {
      g.pelvis.addScaledVector(Rw, wobble(t * 31, 1.3) * shake).addScaledVector(Uw, wobble(t * 27, 4.1) * shake * 0.6);
      g.chest.addScaledVector(Rw, wobble(t * 33, 2.2) * shake * 1.3).addScaledVector(Nw, wobble(t * 29, 7.7) * shake * 0.6);
    }
    if (ph === 'climbing' || ph === 'idle' || ph === 'topped') {
      g.pelvis.addScaledVector(Rw, Math.sin(t * 0.9) * 0.004).addScaledVector(Nw, Math.sin(t * 0.71 + 1) * 0.004);
    }

    // celebration bounce
    const ct = this.celebrateT;
    const celebrating = ct >= 0 && (ph === 'topped' || ph === 'climbing');
    if (celebrating) g.pelvis.addScaledVector(WORLD_UP, Math.abs(Math.sin(ct * 10)) * 0.012 * Math.exp(-ct * 0.9));

    // ── body axes (yaw = barn-door twist) ──
    this.U.subVectors(g.chest, g.pelvis).normalize();
    this.Rb.copy(Rw).addScaledVector(this.U, -Rw.dot(this.U)).normalize();
    let yaw = state.bodyYaw;
    if (celebrating) yaw += 0.34 * sstep(0.1, 0.6, ct); // open the right side toward the camera
    this.sYaw += (yaw - this.sYaw) * (snap ? 1 : dampK(10, d));
    // drop-knee / backstep: a foot crossed inward of its hip turns that hip into the wall
    let dk = 0;
    for (let s = 0; s < 2; s++) {
      const L = state.limbs[FOOT_IDS[s]];
      const on = (L.holdId !== null || L.smearing) && onWall;
      const across = -((L.pos.x - L.anchor.x) * bRx + (L.pos.y - L.anchor.y) * bRy) * SIGN[s];
      const k = on ? sstep(0.0, 0.26, across) : 0;
      this.dropK[s] += (k - this.dropK[s]) * (snap ? 1 : dampK(8, d));
      dk -= SIGN[s] * this.dropK[s] * 0.42;
    }
    this.sDrop += (dk - this.sDrop) * (snap ? 1 : dampK(8, d));
    this.q.setFromAxisAngle(this.U, -(this.sYaw * 0.75 + this.sDrop));
    g.pelvisRight.copy(this.Rb).applyQuaternion(this.q);
    this.q.setFromAxisAngle(this.U, -this.sYaw);
    g.chestRight.copy(this.Rb).applyQuaternion(this.q);
    g.pelvisTilt = this.sHike;

    // wall plane + escape direction (toward the camera) for joint limits and self-collision
    g.wall = true;
    g.wallN.copy(Nw);
    g.wallP.copy(frame.origin);
    g.away.copy(Nw);

    // ── hands ──
    for (let s = 0; s < 2; s++) this.poseHand(state, frame, s, d, snap, celebrating ? ct : -1);
    // ── feet ──
    for (let s = 0; s < 2; s++) this.poseFoot(state, frame, s, d, snap, overhang);
    // matched hands / feet sit side by side on a shared hold (never inside each other), and a
    // foot never shares a spot with a hand
    this.separate(g.hands[0].target, g.hands[1].target, 0.075, Rw, Uw);
    this.separate(g.feet[0].target, g.feet[1].target, 0.085, Rw, Uw);
    for (let f = 0; f < 2; f++) for (let h = 0; h < 2; h++) this.keepApart(g.feet[f].target, g.hands[h].target, 0.1, Uw, Nw);

    // ── head ──
    this.poseHead(state, frame, d, snap, celebrating ? ct : -1);

    // ── breathing ──
    const effort = Math.min(1, state.tension * 0.8 + state.pump * 0.6);
    const rate = 0.26 + 0.34 * effort + (ph === 'landed' ? 0.25 * Math.exp(-this.phaseT * 0.3) : 0);
    g.breath = Math.sin(t * rate * Math.PI * 2);
    g.breathDepth = 0.45 + 0.55 * effort;

    // blink
    this.blinkT -= d;
    if (this.blinkT <= 0) this.blinkT = 2.4 + ((Math.sin(t * 12.9898) * 43758.5453) % 1 + 1) % 1 * 3.2;
    this.blink = this.blinkT < 0.13 ? Math.sin((this.blinkT / 0.13) * Math.PI) : 0;
    setHeadBlink(this.blinkW, this.blink);

    this.rig.solve(g, snap ? 0 : d);
    // reached endpoints
    this.limbWorld.LH.copy(this.rig.joints.grip[0]);
    this.limbWorld.RH.copy(this.rig.joints.grip[1]);
    this.limbWorld.LF.copy(this.rig.joints.toe[0]);
    this.limbWorld.RF.copy(this.rig.joints.toe[1]);
    this.initialized = true;
  }

  private shoulderApprox(s: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.goal.chest).addScaledVector(this.goal.chestRight, SIGN[s] * BODY.shoulderHalf).addScaledVector(this.U, -SHOULDER_DROP);
  }

  private poseHand(state: ClimberState, frame: WallFrame, s: number, d: number, snap: boolean, ct: number): void {
    const g = this.goal;
    const hg = g.hands[s];
    const L = state.limbs[HAND_IDS[s]];
    const side = SIGN[s];
    const Rw = frame.right;
    const Uw = frame.up;
    const Nw = frame.normal;
    const ph = state.phase;
    const t = this.time;
    const S = this.shoulderApprox(s, this.S);
    const info = this.lookupHold(L.holdId, s);
    let depth = L.depth;
    if (L.holdId && info) depth = Math.max(L.depth, info.depth * 0.58 + 0.012);
    frame.toWorld(L.pos, depth, this.v0);
    let shape: HandShape = SHAPE_FREE;
    hg.jointTarget = false;
    hg.lift = 0;

    // phase-specific targets
    let ropeK = 0;
    if (ph === 'falling') {
      // arms up and out from the (upright-clamped) shoulders, flailing — never wherever a tumbling
      // sim skeleton left them, so a fall can't read upside down
      const w = 8.5;
      this.v1.copy(S).addScaledVector(WORLD_UP, 0.34).addScaledVector(this.goal.chestRight, side * 0.36).addScaledVector(Nw, 0.16);
      this.v0.lerp(this.v1, 0.75);
      this.v0.addScaledVector(Rw, Math.sin(t * w + s * 2.1) * 0.11 * side).addScaledVector(Uw, Math.cos(t * w * 1.27 + s) * 0.1);
      shape = SHAPE_OPEN;
    } else if (ph === 'landed') {
      const st = this.sStand;
      // crouch: hands toward the knees/pad (sim) → stand: hanging relaxed at the sides
      this.v1.copy(S).addScaledVector(WORLD_UP, -0.525).addScaledVector(this.goal.chestRight, side * 0.06).addScaledVector(this.Nh, -0.045);
      this.v1.addScaledVector(this.Nh, Math.sin(t * 0.8 + s * 1.7) * 0.012 * st);
      // little shake-out of the forearms once standing (pumped climbers do this)
      const shakeOut = st > 0.95 ? sstep(0, 0.2, Math.sin(this.phaseT * 0.9 + s) - 0.75) : 0;
      if (shakeOut > 0) this.v1.addScaledVector(this.goal.chestRight, Math.sin(t * 38 + s) * 0.025 * shakeOut);
      this.v0.lerp(this.v1, st);
      hg.jointTarget = st > 0.5;
      shape = SHAPE_FREE;
    } else if (ph === 'hanging') {
      // until the hands find the rope they stay up by the shoulders (not on the tumbling sim limbs)
      this.v1.copy(S).addScaledVector(WORLD_UP, 0.28).addScaledVector(this.goal.chestRight, side * 0.3).addScaledVector(Nw, 0.12);
      this.v0.lerp(this.v1, 0.8);
      ropeK = sstep(0.55, 1.1, this.phaseT);
    }
    this.sRope[s] += (ropeK - this.sRope[s]) * (snap ? 1 : dampK(8, d));
    const rk = this.sRope[s];
    if (rk > 0.001) {
      // both hands on the rope above the tie-in knot (upper = left), along the rope's real direction
      this.v1.copy(this.rig.joints.tieIn);
      if (this.hasRopeAnchor) {
        this.v2.subVectors(this.ropeAnchor, this.v1);
        if (this.v2.lengthSq() < 0.04 || this.v2.y < 0) this.v2.copy(WORLD_UP);
        this.v2.normalize();
      } else this.v2.copy(WORLD_UP).multiplyScalar(0.94).addScaledVector(Nw, -0.34).normalize();
      this.v1.addScaledVector(this.v2, s === 0 ? 0.42 : 0.24).addScaledVector(this.goal.chestRight, side * 0.012);
      this.v0.lerp(this.v1, rk);
    }

    // celebration: the right hand lets go and pumps a fist overhead
    let fistK = 0;
    if (ct >= 0 && s === 1) {
      fistK = sstep(0.08, 0.45, ct);
      const pump = Math.sin(ct * 11) * Math.exp(-Math.max(0, ct - 0.4) * 0.8) * 0.07;
      this.v1.copy(S).addScaledVector(WORLD_UP, 0.6 + pump).addScaledVector(Rw, 0.17).addScaledVector(Nw, 0.2);
      this.v0.lerp(this.v1, fistK);
    }

    // smoothing
    const lam = L.holdId ? 40 : L.dragging ? 30 : ph === 'falling' ? 50 : 16;
    if (snap || this.sHand[s].distanceToSquared(this.v0) > 0.3) this.sHand[s].copy(this.v0);
    else this.sHand[s].lerp(this.v0, dampK(lam, d));
    hg.target.copy(this.sHand[s]);
    hg.pinned = rk > 0.5 || ((L.holdId !== null || L.busy) && ph !== 'falling' && ph !== 'landed' && fistK < 0.5);
    hg.layer = layerOf(L);

    // orientation
    this.v2.subVectors(hg.target, S); // arm direction
    const armLen = this.v2.length();
    if (armLen > 1e-5) this.v2.multiplyScalar(1 / armLen);
    const dir = hg.dir;
    const up = hg.up;
    if (rk > 0.5) {
      dir.copy(this.goal.chestRight).multiplyScalar(-side).addScaledVector(WORLD_UP, 0.15).normalize();
      up.copy(Nw).multiplyScalar(-1).addScaledVector(this.goal.chestRight, side * 0.25);
      shape = SHAPE_FIST;
    } else if (fistK > 0.5) {
      dir.copy(WORLD_UP).addScaledVector(Nw, -0.15).normalize();
      up.copy(Nw).addScaledVector(Rw, 0.3);
      shape = SHAPE_FIST;
    } else if (L.holdId && ph !== 'falling' && ph !== 'landed') {
      // fingers wrap over the hold: opposite to the hold's good direction, blended with the arm line
      this.v3.copy(this.v2).addScaledVector(Nw, -this.v2.dot(Nw));
      if (this.v3.lengthSq() < 1e-6) this.v3.copy(Uw);
      this.v3.normalize();
      if (info) {
        const ca = Math.cos(info.angle);
        const sa = Math.sin(info.angle);
        dir.copy(Rw).multiplyScalar(-ca).addScaledVector(Uw, -sa).multiplyScalar(0.65).addScaledVector(this.v3, 0.35);
      } else dir.copy(this.v3);
      dir.normalize();
      up.copy(Nw).multiplyScalar(0.8).addScaledVector(dir, 0.35);
      dir.addScaledVector(Nw, -0.3).normalize();
      shape = GRIP[info ? info.type : 'edge'];
    } else if (L.busy) {
      dir.copy(Uw).multiplyScalar(0.6).addScaledVector(Nw, -0.5).normalize();
      up.copy(Nw).multiplyScalar(0.6).addScaledVector(Rw, -side * 0.6);
      shape = SHAPE_CLIP;
    } else if (L.dragging) {
      dir.copy(this.v2).addScaledVector(Nw, -this.v2.dot(Nw) * 0.7).addScaledVector(Nw, -0.12).normalize();
      up.copy(Nw).addScaledVector(dir, -dir.dot(Nw));
      if (up.lengthSq() < 1e-6) up.copy(Nw);
      shape = SHAPE_REACH;
    } else {
      // dangling / free: fingers down, palm toward the body
      dir.copy(WORLD_UP).multiplyScalar(-0.85).addScaledVector(this.v2, 0.4).normalize();
      up.copy(this.goal.chestRight).multiplyScalar(side).addScaledVector(Nw, 0.3);
      if (ph !== 'falling') shape = SHAPE_FREE;
    }
    // grip shape (damped so hands visibly close on a hold)
    const sh = this.sShape[s];
    const kS = snap ? 1 : dampK(14, d);
    sh.a += (shape.a - sh.a) * kS;
    sh.b += (shape.b - sh.b) * kS;
    sh.thumb += (shape.thumb - sh.thumb) * kS;
    hg.curlA = sh.a;
    hg.curlB = sh.b;
    hg.thumb = sh.thumb;
    // shoulder shrug when reaching up
    const rel = this.v0.subVectors(hg.target, S).dot(WORLD_UP);
    hg.lift = sstep(0.2, 0.55, rel) * 0.025;

    // elbow pole: down + out on high holds, back + out on low ones; tremor wobbles the elbow
    const hi = sstep(-0.35, 0.25, rel);
    const pole = hg.pole;
    pole
      .copy(Nw)
      .multiplyScalar(0.75 * (1 - hi) + 0.3 * hi)
      .addScaledVector(this.goal.chestRight, side * (0.45 + 0.15 * hi))
      .addScaledVector(WORLD_UP, -0.25 * (1 - hi) - 0.65 * hi);
    if (ph === 'landed') pole.copy(Nw).multiplyScalar(0.8).addScaledVector(this.goal.chestRight, side * 0.6);
    if (rk > 0.5) pole.copy(WORLD_UP).multiplyScalar(-0.6).addScaledVector(this.goal.chestRight, side * 0.8).addScaledVector(Nw, 0.2);
    const tremor = L.shake;
    if (tremor > 0.01) {
      pole.addScaledVector(Uw, wobble(t * 41, s * 3.3) * tremor * 0.6).addScaledVector(Rw, wobble(t * 37, s * 5.1 + 2) * tremor * 0.5);
    }
    pole.normalize();
  }

  private poseFoot(state: ClimberState, frame: WallFrame, s: number, d: number, snap: boolean, overhang: number): void {
    const g = this.goal;
    const fg = g.feet[s];
    const L = state.limbs[FOOT_IDS[s]];
    const side = SIGN[s];
    const Rw = frame.right;
    const Uw = frame.up;
    const Nw = frame.normal;
    const ph = state.phase;
    const t = this.time;
    const Hp = this.Hp.copy(g.pelvis).addScaledVector(g.pelvisRight, side * BODY.hipHalf);
    const info = this.lookupHold(L.holdId, 2 + s);
    let depth = L.depth;
    if (L.holdId && info) depth = Math.max(L.depth, info.depth * 0.55 + 0.008);
    else if (L.smearing) depth = 0.012;
    frame.toWorld(L.pos, depth, this.v0);
    fg.jointTarget = false;
    fg.autoPoint = true;
    const dir = fg.dir;
    const up = fg.up;
    const pole = fg.pole;
    let mode: 'hold' | 'drag' | 'dangle' | 'stand' | 'wall' = L.holdId || L.smearing ? 'hold' : L.dragging ? 'drag' : 'dangle';

    if (ph === 'landed') {
      mode = 'stand';
      const st = this.sStand;
      // feet flat on the pad; tuck them under the hips while standing up
      this.v1.copy(g.pelvis).addScaledVector(g.pelvisRight, side * 0.125).addScaledVector(this.Nh, 0.02);
      this.v0.x += (this.v1.x - this.v0.x) * st;
      this.v0.z += (this.v1.z - this.v0.z) * st;
      this.v0.y = GAME.padHeight + ANKLE_H + 0.004;
      fg.jointTarget = true;
    } else if (ph === 'hanging' && state.pelvisDepth < 0.85) {
      // feet against the wall, legs bent: the classic post-whipper sit. They swing in from below
      // the hips (never from wherever the tumbling sim skeleton left them).
      mode = 'wall';
      this.v0.copy(Hp).addScaledVector(WORLD_UP, -(THIGH + SHIN) * 0.86).addScaledVector(this.Nh, 0.14);
      this.p2.x = state.pelvis.x + side * 0.17;
      this.p2.y = state.pelvis.y - 0.36;
      frame.toWorld(this.p2, 0.03, this.v1);
      this.v0.lerp(this.v1, sstep(0.3, 0.9, this.phaseT));
    } else if (ph === 'falling' || ph === 'hanging') {
      // legs hang below the hips (slightly forward, knees soft), whatever the sim skeleton does
      this.v1.copy(Hp).addScaledVector(WORLD_UP, -(THIGH + SHIN) * 0.86).addScaledVector(this.Nh, 0.14).addScaledVector(g.pelvisRight, side * 0.06);
      this.v0.lerp(this.v1, 0.85);
      const kick = ph === 'falling' ? 1 : 0.35;
      this.v0.addScaledVector(Uw, Math.sin(t * 9.5 + s * 2.4) * 0.07 * kick).addScaledVector(Rw, Math.cos(t * 7.3 + s) * 0.04 * side * kick);
      mode = 'dangle';
    }

    const lam = L.holdId || L.smearing ? 40 : L.dragging ? 30 : ph === 'falling' ? 50 : 14;
    if (snap || this.sFoot[s].distanceToSquared(this.v0) > 0.3) this.sFoot[s].copy(this.v0);
    else this.sFoot[s].lerp(this.v0, dampK(lam, d));
    fg.target.copy(this.sFoot[s]);
    fg.pinned = mode === 'hold' || mode === 'wall' || mode === 'stand';
    fg.layer = layerOf(L);

    // foot height relative to the hip (wall-local up)
    const hf = this.v1.subVectors(fg.target, Hp).dot(Uw);
    const high = sstep(-0.75, -0.05, hf);
    if (mode === 'hold' || mode === 'wall') {
      // toe into the wall, turned out (inside edge), heel dropped; Elvis leg = heel bounce
      const turn = (0.36 + 0.55 * high) * (1 - 0.55 * overhang) * (mode === 'wall' ? 0.4 : 1);
      dir.copy(Nw).multiplyScalar(-Math.cos(turn)).addScaledVector(Rw, side * Math.sin(turn));
      let heel = L.smearing ? 0.72 : 0.24 + 0.1 * (1 - high) - 0.28 * overhang;
      if (mode === 'wall') heel = 0.95;
      heel += Math.sin(t * 69 + s * 1.7) * 0.34 * L.shake + Math.sin(t * 43 + s) * 0.08 * L.shake;
      dir.multiplyScalar(Math.cos(heel)).addScaledVector(Uw, Math.sin(heel)).normalize();
      up.copy(Uw).addScaledVector(dir, -Uw.dot(dir)).normalize();
      // roll onto the inside edge for frog feet
      this.q.setFromAxisAngle(dir, side * 0.32 * high);
      up.applyQuaternion(this.q);
      pole
        .copy(Rw)
        .multiplyScalar(side * (0.45 + 0.65 * high))
        .addScaledVector(Nw, 0.6 - 0.15 * high)
        .addScaledVector(Uw, 0.05 + 0.55 * high);
      if (mode === 'wall') pole.copy(Nw).multiplyScalar(0.5).addScaledVector(WORLD_UP, 0.6).addScaledVector(Rw, side * 0.45);
      // drop knee: the knee turns in and down when the foot crosses inward of the hip
      const dkk = this.dropK[s];
      if (dkk > 0.001 && mode === 'hold') {
        this.v2.copy(Rw).multiplyScalar(-side * 0.45).addScaledVector(Uw, -0.7).addScaledVector(Nw, 0.35).normalize();
        pole.normalize().lerp(this.v2, dkk);
      }
    } else if (mode === 'drag') {
      dir.copy(Nw).multiplyScalar(-0.85).addScaledVector(Uw, -0.15).addScaledVector(Rw, side * 0.25).normalize();
      up.copy(Uw).addScaledVector(dir, -Uw.dot(dir)).normalize();
      pole.copy(Rw).multiplyScalar(side * 0.6).addScaledVector(Nw, 0.55).addScaledVector(Uw, 0.3);
    } else if (mode === 'stand') {
      const st = this.sStand;
      dir.copy(this.Nh).multiplyScalar(-1);
      this.q.setFromAxisAngle(WORLD_UP, -side * 0.2);
      dir.applyQuaternion(this.q);
      up.copy(WORLD_UP);
      pole.copy(this.Nh).multiplyScalar(-0.75).addScaledVector(g.pelvisRight, side * (0.55 - 0.3 * st)).addScaledVector(WORLD_UP, 0.1);
    } else {
      // dangling: toes point down, knees a touch forward
      dir.copy(Nw).multiplyScalar(-0.45).addScaledVector(WORLD_UP, -0.9).addScaledVector(Rw, side * 0.12).normalize();
      up.copy(Nw).multiplyScalar(-0.9).addScaledVector(WORLD_UP, 0.4);
      pole.copy(Nw).multiplyScalar(-0.65).addScaledVector(Rw, side * 0.4).addScaledVector(WORLD_UP, 0.1);
    }
    pole.normalize();
  }

  /**
   * Keep two limb targets (left `a`, right `b`) at least `min` apart in the wall plane by sliding
   * them apart along the wall's right axis, preserving their left/right order (continuous).
   */
  private separate(a: THREE.Vector3, b: THREE.Vector3, min: number, Rw: THREE.Vector3, Uw: THREE.Vector3): void {
    this.v1.subVectors(b, a);
    const dx = this.v1.dot(Rw);
    const dy = this.v1.dot(Uw);
    if (dx * dx + dy * dy >= min * min) return;
    const want = (dx < 0 ? -1 : 1) * Math.sqrt(Math.max(0, min * min - dy * dy));
    const sh = (want - dx) * 0.5;
    a.addScaledVector(Rw, -sh);
    b.addScaledVector(Rw, sh);
  }

  /** Push a foot target out of a hand's spot (in the wall plane; downward when they coincide). */
  private keepApart(foot: THREE.Vector3, hand: THREE.Vector3, min: number, Uw: THREE.Vector3, Nw: THREE.Vector3): void {
    this.v1.subVectors(foot, hand);
    this.v1.addScaledVector(Nw, -this.v1.dot(Nw));
    const dist = this.v1.length();
    if (dist >= min) return;
    if (dist < 1e-4) this.v1.copy(Uw).negate();
    else this.v1.multiplyScalar(1 / dist);
    foot.addScaledVector(this.v1, min - dist);
  }

  private poseHead(state: ClimberState, frame: WallFrame, d: number, snap: boolean, ct: number): void {
    const g = this.goal;
    const Uw = frame.up;
    const Nw = frame.normal;
    const ph = state.phase;
    const t = this.time;
    const target = this.v0;
    let lam = 5;
    if (ph === 'falling') {
      target.copy(g.pelvis).addScaledVector(WORLD_UP, -2).addScaledVector(Nw, 1.2);
      lam = 8;
    } else if (ph === 'landed') {
      // look back up at the problem, slowly reading the route
      target.copy(g.pelvis).addScaledVector(WORLD_UP, 1.5 + Math.sin(t * 0.21) * 0.5).addScaledVector(this.Nh, -2.2);
      target.addScaledVector(frame.right, Math.sin(t * 0.33) * 0.8);
    } else if (ph === 'hanging') {
      if (this.hasRopeAnchor) target.copy(this.ropeAnchor);
      else target.copy(g.pelvis).addScaledVector(WORLD_UP, 2.4).addScaledVector(Nw, -0.9);
    } else if (this.hasLook) {
      frame.toWorld(this.look, 0, target);
    } else {
      // the dragged limb, else just above the hands (reading the next move)
      let dragged: LimbId | null = null;
      for (const id of HAND_IDS) if (state.limbs[id].dragging) dragged = id;
      for (const id of FOOT_IDS) if (state.limbs[id].dragging) dragged = id;
      if (dragged) frame.toWorld(state.limbs[dragged].pos, 0, target);
      else {
        target.copy(g.hands[0].target).add(g.hands[1].target).multiplyScalar(0.5).addScaledVector(Uw, 0.25);
        this.v1.copy(g.chest).addScaledVector(Uw, 0.42);
        target.lerp(this.v1, 0.45);
        // project onto the wall surface
        this.v1.subVectors(target, frame.origin);
        target.addScaledVector(Nw, -this.v1.dot(Nw));
        target.addScaledVector(frame.right, Math.sin(t * 0.37) * 0.12).addScaledVector(Uw, Math.sin(t * 0.53 + 1) * 0.06);
      }
    }
    let nod = 0;
    const weight = 1;
    if (ct >= 0) {
      // fist pump: nod along and look back at the camera
      const k = sstep(0.15, 0.7, ct);
      this.v1.copy(g.chest).addScaledVector(Nw, 1.7).addScaledVector(frame.right, 2.1).addScaledVector(WORLD_UP, 0.35);
      target.lerp(this.v1, k);
      nod = Math.sin(ct * 10) * 0.16 * Math.exp(-ct * 0.7) * k;
      lam = 7;
    }
    if (snap) this.sLook.copy(target);
    else this.sLook.lerp(target, dampK(lam, d));
    g.look.copy(this.sLook);
    g.lookWeight = weight;
    g.headNod = nod;
    g.headRoll = ph === 'climbing' ? Math.sin(t * 0.41) * 0.04 : 0;
  }

  dispose(): void {
    disposeHead(this.head);
    this.rig.dispose();
  }
}


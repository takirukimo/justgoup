// CHARACTER: the climber.
//
//  BodyRig    — a skinned, vinyl-figure style human body (≈1.75 m, proportions from BODY so the
//               3D skeleton matches the sim's skeleton) built procedurally: fitted tee with seams
//               and CHIRAL prints, tapered pants with knee darts and cuffs, downturned climbing
//               shoes (or approach shoes), mitten hands with thumbs and chalked fingertips, a
//               chalk bag on a belt, and an optional harness with belay loop + figure-8 knot.
//               One material for everything (palette regions), so the body is ONE draw call
//               (+1 for the harness). Posed by analytic two-bone IK from a BodyGoal.
//  ClimberModel — maps ClimberState (wall-local sim output) to BodyGoals every frame: hands on
//               holds, toes on holds with dropped heels, frog-stance knees, damped secondary
//               motion (breathing, sway, Elvis-leg tremor, body shake, head tracking) and
//               phase poses (falling, landed, hanging, topped + celebrate).

import * as THREE from 'three';
import type { ChalkId, ClimberState, ColorwayId, HeadId, HoldType, LimbId, Vec2 } from '../core/types';
import { BODY, GAME } from '../config/tuning';
import { CHALKS, COLORWAYS, SKIN_TONE, type ColorwayDef } from '../config/skins';
import { PALETTE } from '../config/brand';
import type { WallFrame } from './wall-frame';
import { createHead, disposeHead, headBlinkWeights, setHeadBlink } from './heads/index';
import { MeshBuilder, loft, sstep, superCos, superSin, type AttribFn } from './heads/geo';
import { ATLAS_RECTS, REGION, createBodyMaterial, createOutfitAtlas, type BodyMaterial, type OutfitStyle, type UvRect } from './materials';

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
}

export interface BodyGoal {
  pelvis: THREE.Vector3;
  chest: THREE.Vector3;
  /** Lateral (character right) axes of the hips and the shoulders. */
  pelvisRight: THREE.Vector3;
  chestRight: THREE.Vector3;
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
  };
}

export function createBodyGoal(): BodyGoal {
  return {
    pelvis: new THREE.Vector3(0, 0.96, 0),
    chest: new THREE.Vector3(0, 1.46, 0),
    pelvisRight: new THREE.Vector3(1, 0, 0),
    chestRight: new THREE.Vector3(1, 0, 0),
    hands: [limbGoal(), limbGoal()],
    feet: [limbGoal(), limbGoal()],
    look: new THREE.Vector3(0, 1.6, -2),
    lookWeight: 1,
    headNod: 0,
    headRoll: 0,
    breath: 0,
    breathDepth: 0.3,
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

// ═══════════════════════════════ geometry ═══════════════════════════════

export interface OutfitOptions {
  style: OutfitStyle;
  shoe: 'climbing' | 'approach';
  chalkBag: boolean;
  belt: boolean;
  /** Harness front: figure-8 tie-in knot (climber) or a belay device on a locker (belayer). */
  tieIn?: 'knot' | 'device';
  /** Knit beanie sitting behind the horns (guide). */
  beanie?: boolean;
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
  private atlas: THREE.Texture;
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

    this.atlas = createOutfitAtlas(outfit.style);
    this.material = createBodyMaterial(this.atlas);

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
    if (this.outfit.beanie) this.buildBeanie(b, rest);
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
    const yMin = -0.14;
    const yMax = 0.56;
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
        const e = 2.35;
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

  /** Knit beanie (graphite, signal tab, pompom) pushed back on the skull behind the horns. */
  private buildBeanie(b: MeshBuilder, rest: THREE.Matrix4[]): void {
    const st = b.vertexCount;
    // neck-bone frame: +y up, +z back. Skull centre ≈ (0, 0.186, 0.006), radius ≈ 0.09.
    loft(b, {
      rows: 14,
      cols: 28,
      point: (v, u, out) => {
        // dome from the cuff (v = 0) to the crown (v = 1)
        const th = v * (Math.PI / 2);
        const a = u * Math.PI * 2;
        const r = 0.094 * Math.cos(th) + (v < 0.18 ? 0.006 : 0);
        out.set(Math.sin(a) * r, Math.sin(th) * 0.082, Math.cos(a) * r * 1.04);
      },
      attrib: (p, n, v, u, out) => {
        attr(REGION.top2, BONE.neck, 0, v < 0.18 ? 0.85 : 1)(p, n, v, u, out);
        // rib knit lines on the cuff via AO stripes
        if (v < 0.18) out.aux[2] = 0.82 + 0.18 * Math.abs(Math.sin(u * Math.PI * 56));
      },
      uvRect: ATLAS_RECTS.blank,
    });
    // pompom
    const s2 = b.vertexCount;
    loft(b, {
      rows: 10,
      cols: 14,
      point: (v, u, out) => {
        const th = v * Math.PI;
        const a = u * Math.PI * 2;
        const r = 0.026 * (1 + 0.12 * Math.sin(a * 5) * Math.sin(th * 4));
        out.set(Math.sin(th) * Math.cos(a) * r, -Math.cos(th) * r, Math.sin(th) * Math.sin(a) * r);
      },
      attrib: attr(REGION.harness, BONE.neck, 0, 1),
      uvRect: ATLAS_RECTS.blank,
    });
    b.transform(new THREE.Matrix4().setPosition(0, 0.09, 0), s2);
    // brand tab on the cuff (print colour)
    const s3 = b.vertexCount;
    capsule(b, {
      y0: -0.008,
      y1: 0.008,
      cap0: 0.003,
      cap1: 0.003,
      rows: 3,
      capRows: 2,
      cols: 8,
      sec: () => ({ rx: 0.012, rz: 0.003, e: 4 }),
      uvRect: ATLAS_RECTS.blank,
      attrib: attr(REGION.strap, BONE.neck, 0, 1),
    });
    b.transform(new THREE.Matrix4().setPosition(0.07, 0.012, 0.066).multiply(new THREE.Matrix4().makeRotationY(0.8)), s3);
    // tilt the whole hat back behind the horns and place it on the skull
    const m = new THREE.Matrix4().makeTranslation(0, 0.205, 0.034).multiply(new THREE.Matrix4().makeRotationX(0.62));
    b.transform(m, st);
    b.transform(rest[BONE.neck], st);
  }

  // ───────────────────────────── appearance ─────────────────────────────

  setPalette(cw: ColorwayDef, chalk: string, opts: { bagColor?: string; top2?: string; harness?: string } = {}): void {
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
    set(REGION.bag, opts.bagColor ?? cw.shoe, 0.74, 0.7);
    set(REGION.bagRim, chalk, 0.95, 1);
    set(REGION.webbing, '#25272B', 0.8, 0.5);
    set(REGION.harness, opts.harness ?? cw.accent, 0.62, 0.55);
    set(REGION.metal, '#B9BEC6', 0.3, 0, 1);
    set(REGION.rope, PALETTE.signal, 0.75, 0.7);
    // print colour: the accent, nudged for contrast against the top
    const acc = new THREE.Color(cw.accent);
    if (Math.abs(lum(acc) - lum(top)) < 0.12) acc.copy(top).multiplyScalar(lum(top) > 0.35 ? 0.45 : 2.2);
    u.uPrint.value.copy(acc);
    u.uAccent2.value.set(cw.shoeAccent);
    u.uChalk.value.set(chalk);
  }

  setHarness(on: boolean): void {
    this.harness.visible = on;
  }

  // ───────────────────────────── solve ─────────────────────────────

  /** Pose every bone from the goal (rig space). dt drives the head damping + chalk-bag swing. */
  solve(g: BodyGoal, dt: number): void {
    const B = this.bones;
    // ── torso ──
    _t0.subVectors(g.chest, g.pelvis);
    const spineLen = _t0.length();
    const spineDir = _t3.copy(_t0).multiplyScalar(1 / Math.max(1e-6, spineLen));
    // pelvis: up = spine (a touch more upright), right = pelvisRight
    _t1.copy(spineDir).lerp(WORLD_UP, 0.15).normalize();
    _t2.crossVectors(g.pelvisRight, _t1); // back (z = x × y)
    basisQuat(_t1, _t2, this.qPelvis);
    B[BONE.pelvis].position.copy(g.pelvis);
    B[BONE.pelvis].quaternion.copy(this.qPelvis);
    B[BONE.pelvis].scale.set(1, 1, 1);
    // chest
    _t2.crossVectors(g.chestRight, spineDir);
    basisQuat(spineDir, _t2, this.qChest);
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

    // ── arms ──
    for (let s = 0; s < 2; s++) this.solveArm(g, s);
    // ── legs ──
    for (let s = 0; s < 2; s++) this.solveLeg(g, s);

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
      yaw = Math.atan2(-_t0.x, -_t0.z);
      // targets behind the head: keep turning the way we already are (no left/right flip)
      if (Math.abs(yaw) > 2.4 && this.yaw !== 0 && Math.sign(yaw) !== Math.sign(this.yaw)) yaw = Math.sign(this.yaw) * Math.PI;
      pitch = Math.atan2(_t0.y - 0.15, Math.hypot(_t0.x, _t0.z));
    }
    yaw *= g.lookWeight;
    pitch *= g.lookWeight;
    yaw = Math.max(-1.05, Math.min(1.05, yaw));
    pitch = Math.max(-0.65, Math.min(0.62, pitch)) - g.headNod;
    const k = dt <= 0 ? 1 : 1 - Math.exp(-dt * 9);
    this.yaw += (yaw - this.yaw) * k;
    this.pitch += (pitch - this.pitch) * k;
    _e.set(this.pitch, this.yaw, g.headRoll, 'YXZ');
    _q1.setFromEuler(_e);
    neck.quaternion.copy(this.qChest).multiply(_q1);
    this.joints.head.set(0, BODY.neck, 0).applyQuaternion(neck.quaternion).add(neck.position);
  }

  private solveArm(g: BodyGoal, s: number): void {
    const B = this.bones;
    const ids = ARM[s];
    const sg = SIGN[s];
    const goal = g.hands[s];
    const J = this.joints;
    // shoulder joint: chest node ± shoulderHalf along the chest's right axis, slightly lowered
    const S = J.shoulder[s];
    _t0.set(sg * BODY.shoulderHalf, -SHOULDER_DROP + goal.lift, 0).applyQuaternion(this.qChest);
    S.copy(g.chest).add(_t0);
    // hand orientation (fingers dir + back of hand)
    const qh = this.qHand[s];
    this.tmpGoalDir.copy(goal.dir).normalize();
    this.tmpGoalUp.copy(goal.up);
    // wrist from grip point
    const curl = Math.min(1, Math.max(0, goal.curlA / 1.4));
    gripLocal(curl, _t1);
    for (let iter = 0; iter < 2; iter++) {
      basisQuat(this.tmpGoalDir, this.tmpGoalUp, qh);
      _t2.copy(_t1).applyQuaternion(qh);
      if (goal.jointTarget) J.wrist[s].copy(goal.target);
      else J.wrist[s].copy(goal.target).sub(_t2);
      // protract / elevate the shoulder toward a far target (≤ 6 cm)
      _t3.subVectors(J.wrist[s], S);
      const d = _t3.length();
      const over = d - (UPPER + FORE) * 0.985;
      if (over > 0 && iter === 0) S.addScaledVector(_t3, Math.min(0.06, over) / d);
      if (iter === 0) {
        // keep the wrist plausible: fingers within ~75° of the forearm direction
        _t3.subVectors(J.wrist[s], S).normalize(); // rough forearm direction
        clampAngle(this.tmpGoalDir, _t3, 1.35);
      }
    }
    const k = twoBoneIK(S, J.wrist[s], UPPER, FORE, goal.pole, J.elbow[s], _t3, 1.14);
    J.wrist[s].copy(_t3);
    // bones: Z = elbow apex direction
    _t0.subVectors(J.elbow[s], S).normalize(); // upper dir
    _t1.subVectors(J.wrist[s], J.elbow[s]).normalize(); // fore dir
    _t2.copy(_t0).sub(_t1); // apex ≈ (upper − fore): points out of the elbow's outside
    if (_t2.lengthSq() < 1e-6) _t2.copy(goal.pole);
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
    // reached grip point
    gripLocal(curl, _t0).applyQuaternion(qh);
    J.grip[s].copy(J.wrist[s]).add(_t0);
  }

  private solveLeg(g: BodyGoal, s: number): void {
    const B = this.bones;
    const ids = LEG[s];
    const sg = SIGN[s];
    const goal = g.feet[s];
    const J = this.joints;
    const Hp = J.hip[s];
    _t0.set(sg * BODY.hipHalf, 0, 0).applyQuaternion(this.qPelvis);
    Hp.copy(g.pelvis).add(_t0);
    const qf = this.qFoot[s];
    this.tmpGoalDir.copy(goal.dir).normalize();
    this.tmpGoalUp.copy(goal.up);
    toeLocal(sg, this.outfit.shoe, _t1);
    const maxLeg = (THIGH + SHIN) * 0.992;
    // raise the heel (point the foot) when the leg can't reach the ankle
    for (let iter = 0; iter < 4; iter++) {
      basisQuat(this.tmpGoalDir, this.tmpGoalUp, qf);
      _t2.copy(_t1).applyQuaternion(qf);
      if (goal.jointTarget) J.ankle[s].copy(goal.target);
      else J.ankle[s].copy(goal.target).sub(_t2);
      const d = J.ankle[s].distanceTo(Hp);
      if (goal.jointTarget || !goal.autoPoint || d <= maxLeg) break;
      // pitch about the foot's lateral axis: heel up (toe stays) — rotate dir/up by +angle
      this.footAxis.crossVectors(this.tmpGoalDir, this.tmpGoalUp).normalize();
      const ang = Math.min(0.5, (d - maxLeg) * 3.2 + 0.05);
      // choose the rotation sign that moves the ankle toward the hip
      _q0.setFromAxisAngle(this.footAxis, ang);
      _t3.copy(this.tmpGoalDir).applyQuaternion(_q0);
      _t2.copy(this.tmpGoalUp).applyQuaternion(_q0);
      _q1.copy(qf);
      basisQuat(_t3, _t2, _qa);
      _t0.copy(_t1).applyQuaternion(_qa);
      const dA = _t0.negate().add(goal.target).distanceTo(Hp);
      if (dA < d) {
        this.tmpGoalDir.copy(_t3);
        this.tmpGoalUp.copy(_t2);
      } else {
        _q0.setFromAxisAngle(this.footAxis, -ang);
        this.tmpGoalDir.applyQuaternion(_q0);
        this.tmpGoalUp.applyQuaternion(_q0);
      }
    }
    basisQuat(this.tmpGoalDir, this.tmpGoalUp, qf);
    const k = twoBoneIK(Hp, J.ankle[s], THIGH, SHIN, goal.pole, J.knee[s], _t3, 1.08);
    J.ankle[s].copy(_t3);
    _t0.subVectors(J.knee[s], Hp).normalize();
    _t1.subVectors(J.ankle[s], J.knee[s]).normalize();
    // knee apex = front of the knee = outside of the bend (thigh dir − shin dir)
    _t2.copy(_t0).sub(_t1);
    if (_t2.lengthSq() < 1e-6) _t2.copy(goal.pole);
    B[ids.thigh].position.copy(Hp);
    basisQuat(_t0, _t2, B[ids.thigh].quaternion);
    B[ids.thigh].scale.set(1, k, 1);
    B[ids.shin].position.copy(J.knee[s]);
    basisQuat(_t1, _t2, B[ids.shin].quaternion);
    B[ids.shin].scale.set(1, k, 1);
    B[ids.foot].position.copy(J.ankle[s]);
    B[ids.foot].quaternion.copy(qf);
    toeLocal(sg, this.outfit.shoe, _t0).applyQuaternion(qf);
    J.toe[s].copy(J.ankle[s]).add(_t0);
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
    this.material.dispose();
    this.atlas.dispose();
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

    // ── pelvis + chest ──
    frame.toWorld(state.pelvis, state.pelvisDepth, this.rawP);
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
      // sit in the harness under the rope: torso upright, leaning back off the wall a little
      this.v0.subVectors(this.rawC, this.rawP).normalize();
      this.v0.multiplyScalar(0.25).addScaledVector(WORLD_UP, 0.75).addScaledVector(Nw, 0.12).normalize();
      this.rawC.copy(this.rawP).addScaledVector(this.v0, BODY.spine);
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
    this.q.setFromAxisAngle(this.U, -this.sYaw * 0.75);
    g.pelvisRight.copy(this.Rb).applyQuaternion(this.q);
    this.q.setFromAxisAngle(this.U, -this.sYaw);
    g.chestRight.copy(this.Rb).applyQuaternion(this.q);

    // ── hands ──
    for (let s = 0; s < 2; s++) this.poseHand(state, frame, s, d, snap, celebrating ? ct : -1);
    // ── feet ──
    for (let s = 0; s < 2; s++) this.poseFoot(state, frame, s, d, snap, overhang);

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
      const w = 8.5;
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
      // feet against the wall, legs bent: the classic post-whipper sit
      mode = 'wall';
      this.p2.x = state.pelvis.x + side * 0.17;
      this.p2.y = state.pelvis.y - 0.36;
      frame.toWorld(this.p2, 0.03, this.v1);
      this.v0.lerp(this.v1, sstep(0.3, 0.9, this.phaseT));
    } else if (ph === 'falling') {
      this.v0.addScaledVector(Uw, Math.sin(t * 9.5 + s * 2.4) * 0.07).addScaledVector(Rw, Math.cos(t * 7.3 + s) * 0.04 * side);
      mode = 'dangle';
    }

    const lam = L.holdId || L.smearing ? 40 : L.dragging ? 30 : ph === 'falling' ? 50 : 14;
    if (snap || this.sFoot[s].distanceToSquared(this.v0) > 0.3) this.sFoot[s].copy(this.v0);
    else this.sFoot[s].lerp(this.v0, dampK(lam, d));
    fg.target.copy(this.sFoot[s]);

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


// CHARACTER: Steini the ibex — CHIRAL staff guide who runs the intro, the tutorial and belays in
// rope mode. Same body system as the climber (BodyRig) with the ibex head, a signal-orange CHIRAL
// STAFF tee, dark pants, approach shoes and a knit beanie pushed back behind the horns.
//
// Poses: idle (weight shift, breathing, look-arounds), wave, point (at lookAt), clap, cheer,
// think (hand on chin), belay (guide hand on the rope, brake hand low, device on the harness).
// Every pose writes a target set; the live goal springs toward it, so transitions are smooth.

import * as THREE from 'three';
import type { GuidePose, GuideState } from '../core/contracts';
import { PALETTE } from '../config/brand';
import { GAME } from '../config/tuning';
import { SKIN_TONE, type ColorwayDef } from '../config/skins';
import type { WallFrame } from './wall-frame';
import { BONE, BodyRig, createBodyGoal, type BodyGoal, type LimbGoal } from './climber';
import { createGuideHead, disposeHead, headBlinkWeights, setHeadBlink } from './heads/index';

const STAFF: ColorwayDef = {
  id: 'ember',
  name: 'Staff',
  unlock: { kind: 'free' },
  top: PALETTE.signal,
  bottom: '#24272C',
  shoe: '#4A4F57',
  shoeAccent: PALETTE.signal,
  accent: PALETTE.chalk,
};

const SIGN = [-1, 1] as const;
const UPV = new THREE.Vector3(0, 1, 0);
const ANKLE = 0.078;

const dampK = (lambda: number, dt: number): number => (dt <= 0 ? 1 : 1 - Math.exp(-lambda * dt));

interface HandPose {
  wrist: THREE.Vector3;
  dir: THREE.Vector3;
  up: THREE.Vector3;
  pole: THREE.Vector3;
  a: number;
  b: number;
  thumb: number;
}

function handPose(): HandPose {
  return { wrist: new THREE.Vector3(), dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(1, 0, 0), pole: new THREE.Vector3(0, 0, 1), a: 0.4, b: 0.4, thumb: 0.3 };
}

/** Target set a pose writes (guide-local axes already resolved to world). */
interface PoseTargets {
  pelvis: THREE.Vector3;
  chest: THREE.Vector3;
  hands: [HandPose, HandPose];
  feet: [THREE.Vector3, THREE.Vector3];
  footDir: [THREE.Vector3, THREE.Vector3];
  knee: [THREE.Vector3, THREE.Vector3];
  look: THREE.Vector3;
  nod: number;
  roll: number;
}

function targets(): PoseTargets {
  return {
    pelvis: new THREE.Vector3(),
    chest: new THREE.Vector3(),
    hands: [handPose(), handPose()],
    feet: [new THREE.Vector3(), new THREE.Vector3()],
    footDir: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)],
    knee: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)],
    look: new THREE.Vector3(),
    nod: 0,
    roll: 0,
  };
}

export class GuideModel extends THREE.Group {
  readonly rig: BodyRig;
  private head: THREE.Group;
  private blinkW: number[] | null;
  private goal: BodyGoal = createBodyGoal();
  private T: PoseTargets = targets();
  private time = 0;
  private poseT = 0;
  private pose: GuidePose = 'idle';
  private yaw = 0;
  private initialized = false;
  private blinkT = 1.5;
  // guide frame
  private O = new THREE.Vector3();
  private F = new THREE.Vector3();
  private R = new THREE.Vector3();
  private lookW = new THREE.Vector3();
  private v0 = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private S = [new THREE.Vector3(), new THREE.Vector3()];

  constructor() {
    super();
    this.name = 'guide';
    this.rig = new BodyRig({ style: 'staff', shoe: 'approach', chalkBag: false, belt: false, tieIn: 'device', beanie: true });
    // no chalk on the guide's hands (chalk colour = skin)
    this.rig.setPalette(STAFF, SKIN_TONE, { top2: '#2B2D31', harness: PALETTE.signal });
    this.add(this.rig.root);
    this.head = createGuideHead();
    this.head.rotation.y = Math.PI;
    this.rig.bones[BONE.neck].add(this.head);
    this.rig.setHeadProxies(this.head);
    this.blinkW = headBlinkWeights(this.head);
    this.rig.restGoal(this.goal);
    this.rig.solve(this.goal, 0);
  }

  setState(g: GuideState, frame: WallFrame, dt: number): void {
    const d = Math.min(Math.max(dt, 0), 0.1);
    this.time += d;
    if (g.pose !== this.pose) {
      this.pose = g.pose;
      this.poseT = 0;
    } else this.poseT += d;
    const snap = !this.initialized || dt <= 0;
    const pad = GAME.padHeight;
    // ── guide frame: feet on the mats, facing the camera side, turned toward what he looks at ──
    this.O.set(frame.origin.x + g.x, pad, frame.origin.z + g.depth);
    if (g.lookAt) frame.toWorld(g.lookAt, 0, this.lookW);
    else this.lookW.set(this.O.x + 0.4, pad + 1.6, this.O.z + 4);
    // facing yaw: 0 = +Z (toward the camera). Belay faces the wall/climber.
    this.v0.subVectors(this.lookW, this.O);
    const toLook = Math.atan2(this.v0.x, this.v0.z);
    let target: number;
    if (g.pose === 'belay') target = toLook;
    else if (g.pose === 'point') target = toLook * 0.55;
    else target = (g.lookAt ? toLook : 0) * 0.3 + (g.x < 0 ? 0.28 : -0.28);
    // shortest-path damping
    let diff = target - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * (snap ? 1 : dampK(4, d));
    this.F.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.R.crossVectors(this.F, UPV).normalize();

    this.computePose(g.pose);
    this.blendIntoGoal(snap, d);

    // harness (with the belay device) only while belaying
    this.rig.setHarness(g.pose === 'belay');

    // blink
    this.blinkT -= d;
    if (this.blinkT <= 0) this.blinkT = 2.2 + ((Math.sin(this.time * 91.7) * 43758.5453) % 1 + 1) % 1 * 3;
    setHeadBlink(this.blinkW, this.blinkT < 0.14 ? Math.sin((this.blinkT / 0.14) * Math.PI) : 0);

    this.rig.solve(this.goal, snap ? 0 : d);
    this.initialized = true;
  }

  getHandWorld(hand: 'L' | 'R', out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.rig.joints.grip[hand === 'L' ? 0 : 1]);
  }

  // ───────────────────────────── poses ─────────────────────────────

  /** Local helper: O + R·x + up·y + F·z. */
  private at(out: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
    return out.copy(this.O).addScaledVector(this.R, x).addScaledVector(UPV, y).addScaledVector(this.F, z);
  }
  private dirL(out: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
    return out.set(0, 0, 0).addScaledVector(this.R, x).addScaledVector(UPV, y).addScaledVector(this.F, z).normalize();
  }

  private computePose(pose: GuidePose): void {
    const T = this.T;
    const t = this.time;
    const pt = this.poseT;
    // ── base stance: weight shift + breathing ──
    const shift = Math.sin(t * 0.55) * 0.022;
    let bob = 0;
    let lean = 0.015;
    let stance = 0.12;
    let front = 0;
    if (pose === 'cheer') bob = -Math.abs(Math.sin(t * 6.5)) * 0.045;
    if (pose === 'clap') bob = -Math.abs(Math.sin(t * 9)) * 0.008;
    if (pose === 'belay') {
      stance = 0.17;
      front = 0.12;
      lean = -0.02;
    }
    this.at(T.pelvis, shift, 0.925 + bob, 0);
    this.at(T.chest, shift * 0.4, 0.925 + bob + 0.5, lean);
    for (let s = 0; s < 2; s++) {
      const sg = SIGN[s];
      // belay: left foot forward
      this.at(T.feet[s], sg * stance, ANKLE, pose === 'belay' && s === 0 ? front : pose === 'belay' ? -front * 0.4 : 0);
      this.dirL(T.footDir[s], sg * 0.22, 0, 1);
      this.dirL(T.knee[s], sg * 0.25, 0, 1);
    }
    // shoulders (for arm targets)
    for (let s = 0; s < 2; s++) this.S[s].copy(T.chest).addScaledVector(this.R, SIGN[s] * 0.19).addScaledVector(UPV, -0.035);
    // ── defaults: relaxed arms ──
    for (let s = 0; s < 2; s++) {
      const sg = SIGN[s];
      const h = T.hands[s];
      h.wrist.copy(this.S[s]).addScaledVector(UPV, -0.54).addScaledVector(this.R, sg * 0.07).addScaledVector(this.F, 0.04);
      h.wrist.addScaledVector(this.F, Math.sin(t * 1.1 + s * 2) * 0.01);
      this.dirL(h.dir, sg * 0.15, -1, 0.15);
      this.dirL(h.up, sg, 0, -0.2);
      this.dirL(h.pole, sg * 0.4, 0, -1);
      h.a = 0.45;
      h.b = 0.5;
      h.thumb = 0.25;
    }
    T.look.copy(this.lookW);
    T.nod = 0;
    T.roll = 0;
    const L = T.hands[0];
    const Rh = T.hands[1];
    switch (pose) {
      case 'idle': {
        // left hand on the hip, occasional look around
        this.handOnHip(L, 0);
        const glance = Math.sin(t * 0.31) > 0.75 ? 1 : 0;
        if (glance) T.look.addScaledVector(this.R, 1.2).addScaledVector(UPV, 0.3);
        T.roll = Math.sin(t * 0.4) * 0.05;
        break;
      }
      case 'wave': {
        const w = Math.sin(pt * 9);
        Rh.wrist.copy(this.S[1]).addScaledVector(UPV, 0.4).addScaledVector(this.R, 0.2 + w * 0.035).addScaledVector(this.F, 0.1);
        this.dirL(Rh.dir, w * 0.55, 1, 0.1);
        this.dirL(Rh.up, 0, 0, -1);
        this.dirL(Rh.pole, 0.7, -1, -0.2);
        Rh.a = 0.08;
        Rh.b = 0.05;
        Rh.thumb = 0.1;
        T.roll = w * 0.04 + 0.08;
        break;
      }
      case 'point': {
        // right arm extended toward the look target, left hand on the hip
        this.v1.subVectors(this.lookW, this.S[1]).normalize();
        Rh.wrist.copy(this.S[1]).addScaledVector(this.v1, 0.56);
        Rh.dir.copy(this.v1);
        this.dirL(Rh.up, 0, 1, 0);
        Rh.up.addScaledVector(this.v1, -Rh.up.dot(this.v1)).normalize();
        Rh.up.multiplyScalar(0.3).addScaledVector(this.R, 0.9);
        this.dirL(Rh.pole, 0.3, -1, -0.3);
        Rh.a = 0.04;
        Rh.b = 0.02;
        Rh.thumb = 0.05;
        this.handOnHip(L, 0);
        break;
      }
      case 'clap': {
        const c = Math.abs(Math.sin(pt * 4.5 * Math.PI));
        for (let s = 0; s < 2; s++) {
          const sg = SIGN[s];
          const h = T.hands[s];
          h.wrist.copy(T.chest).addScaledVector(this.F, 0.3).addScaledVector(UPV, -0.17).addScaledVector(this.R, sg * (0.03 + 0.07 * c));
          this.dirL(h.dir, -sg * 0.15, 0.65, 0.75);
          this.dirL(h.up, sg, 0, 0);
          this.dirL(h.pole, sg * 0.8, -1, -0.2);
          h.a = 0.12;
          h.b = 0.08;
          h.thumb = 0.15;
        }
        T.nod = Math.sin(pt * 9) * 0.04;
        break;
      }
      case 'cheer': {
        const pump = Math.sin(t * 6.5) * 0.03;
        for (let s = 0; s < 2; s++) {
          const sg = SIGN[s];
          const h = T.hands[s];
          h.wrist.copy(this.S[s]).addScaledVector(UPV, 0.5 + pump).addScaledVector(this.R, sg * 0.24).addScaledVector(this.F, 0.06);
          this.dirL(h.dir, sg * 0.2, 1, 0);
          this.dirL(h.up, sg * 0.3, 0, -1);
          this.dirL(h.pole, sg, -0.6, -0.2);
          h.a = 1.45;
          h.b = 1.5;
          h.thumb = 1;
        }
        T.look.copy(this.O).addScaledVector(this.F, 4).addScaledVector(UPV, 2.1);
        T.nod = -0.15;
        break;
      }
      case 'think': {
        // right hand under the chin, left arm across supporting the right elbow
        const head = this.v2.copy(T.chest).addScaledVector(UPV, 0.16).addScaledVector(this.F, 0.13);
        Rh.wrist.copy(head).addScaledVector(UPV, -0.1).addScaledVector(this.F, 0.02).addScaledVector(this.R, 0.02);
        this.dirL(Rh.dir, -0.25, 0.85, 0.35);
        this.dirL(Rh.up, 0, -0.2, 1);
        this.dirL(Rh.pole, 0.35, -1, 0.2);
        Rh.a = 1.1;
        Rh.b = 1.2;
        Rh.thumb = 0.6;
        L.wrist.copy(T.chest).addScaledVector(this.F, 0.22).addScaledVector(UPV, -0.27).addScaledVector(this.R, 0.1);
        this.dirL(L.dir, 1, 0.1, 0.1);
        this.dirL(L.up, 0, 0, 1);
        this.dirL(L.pole, -0.6, -1, 0.1);
        L.a = 0.6;
        L.b = 0.6;
        L.thumb = 0.4;
        T.look.copy(this.O).addScaledVector(UPV, 2.4).addScaledVector(this.R, 0.9).addScaledVector(this.F, 2);
        T.roll = 0.16 + Math.sin(t * 0.8) * 0.03;
        break;
      }
      case 'belay': {
        // guide hand (right) high on the climber strand, brake hand (left) low by the hip
        Rh.wrist.copy(this.S[1]).addScaledVector(UPV, 0.2).addScaledVector(this.F, 0.3).addScaledVector(this.R, -0.07);
        Rh.wrist.addScaledVector(UPV, Math.sin(t * 0.9) * 0.015);
        this.dirL(Rh.dir, -0.9, 0.15, 0.2);
        this.dirL(Rh.up, 0.1, 0.2, 1);
        this.dirL(Rh.pole, 0.8, -1, -0.3);
        Rh.a = 1.2;
        Rh.b = 1.25;
        Rh.thumb = 0.9;
        L.wrist.copy(T.pelvis).addScaledVector(this.R, -0.19).addScaledVector(UPV, -0.1).addScaledVector(this.F, 0.06);
        this.dirL(L.dir, 0.2, -0.3, 1);
        this.dirL(L.up, -1, 0, 0);
        this.dirL(L.pole, -0.4, 0.2, -1);
        L.a = 1.3;
        L.b = 1.35;
        L.thumb = 0.95;
        break;
      }
    }
  }

  private handOnHip(h: HandPose, s: number): void {
    const sg = SIGN[s];
    h.wrist.copy(this.T.pelvis).addScaledVector(this.R, sg * 0.2).addScaledVector(UPV, 0.07).addScaledVector(this.F, -0.01);
    this.dirL(h.dir, -sg * 0.35, -0.6, 0.7);
    this.dirL(h.up, sg, 0.3, 0);
    this.dirL(h.pole, sg, -0.2, -0.5);
    h.a = 0.35;
    h.b = 0.3;
    h.thumb = 0.2;
  }

  private blendIntoGoal(snap: boolean, d: number): void {
    const g = this.goal;
    const T = this.T;
    const k = snap ? 1 : dampK(9, d);
    const kf = snap ? 1 : dampK(12, d);
    g.pelvis.lerp(T.pelvis, snap ? 1 : dampK(10, d));
    g.chest.lerp(T.chest, snap ? 1 : dampK(10, d));
    g.pelvisRight.copy(this.R);
    g.chestRight.copy(this.R);
    // self-collision escapes toward the guide's front (no wall); feet stay planted on the mats
    g.wall = false;
    g.away.copy(this.F);
    for (let s = 0; s < 2; s++) {
      const h = T.hands[s];
      const gh: LimbGoal = g.hands[s];
      gh.jointTarget = true;
      gh.target.lerp(h.wrist, kf);
      gh.dir.lerp(h.dir, k).normalize();
      gh.up.lerp(h.up, k).normalize();
      gh.pole.lerp(h.pole, k).normalize();
      gh.curlA += (h.a - gh.curlA) * k;
      gh.curlB += (h.b - gh.curlB) * k;
      gh.thumb += (h.thumb - gh.thumb) * k;
      gh.lift = 0;
      gh.pinned = false;
      gh.layer = s === 1 ? 1 : 0;
      const gf: LimbGoal = g.feet[s];
      gf.jointTarget = true;
      gf.autoPoint = false;
      gf.pinned = true;
      gf.layer = 0;
      gf.target.lerp(T.feet[s], k);
      gf.dir.lerp(T.footDir[s], k).normalize();
      gf.up.copy(UPV);
      gf.pole.lerp(T.knee[s], k).normalize();
    }
    g.look.lerp(T.look, snap ? 1 : dampK(5, d));
    g.lookWeight = 1;
    g.headNod += (T.nod - g.headNod) * k;
    g.headRoll += (T.roll - g.headRoll) * dampK(4, d);
    g.breath = Math.sin(this.time * 0.3 * Math.PI * 2);
    g.breathDepth = 0.55;
  }

  dispose(): void {
    disposeHead(this.head);
    this.rig.dispose();
  }
}

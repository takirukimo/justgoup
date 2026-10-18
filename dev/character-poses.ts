// CHARACTER dev harness — `view=climber`: ClimberModels on a simple wall, posed from synthetic
// ClimberStates covering every phase (climb, reach, frog, shake/Elvis leg, falling, landed,
// hanging on the rope, topped + celebrate). `pose=<name>` shows a single one. The models are
// stepped for a couple of seconds before the first frame so phase timers (stand-up, hands on
// the rope, fist pump) have progressed.

import * as THREE from 'three';
import type { ClimberPhase, ClimberState, LimbId, LimbSnapshot, Vec2 } from '../src/core/types';
import { BODY } from '../src/config/tuning';
import { ClimberModel } from '../src/render/climber';
import { RopeMesh } from '../src/render/rope-mesh';
import { WallFrame } from '../src/render/wall-frame';

export type PoseName = 'climb' | 'reach' | 'frog' | 'shake' | 'falling' | 'landed' | 'hanging' | 'topped';
export const POSES: PoseName[] = ['climb', 'reach', 'frog', 'shake', 'falling', 'landed', 'hanging', 'topped'];

function limb(id: LimbId, pos: Vec2, anchor: Vec2, depth: number, extra: Partial<LimbSnapshot> = {}): LimbSnapshot {
  return {
    id, holdId: 'h', pos, anchor, depth, dragging: false, load: 0.3, stress: 0.4, capacity: 0.8,
    reachRatio: 0.7, smearing: false, shake: 0, busy: false, ...extra,
  };
}

/** Synthetic state for a pose at wall-local x offset `ox`. */
export function poseState(name: PoseName, ox: number, t: number): ClimberState {
  let phase: ClimberPhase = 'climbing';
  let pelvis: Vec2 = { x: 0, y: 1.25 };
  let chest: Vec2 = { x: 0.02, y: 1.75 };
  let pd = 0.32;
  let lh: Vec2 = { x: -0.3, y: 2.02 };
  let rh: Vec2 = { x: 0.26, y: 2.18 };
  let lf: Vec2 = { x: -0.26, y: 0.72 };
  let rf: Vec2 = { x: 0.3, y: 0.86 };
  const ex: Partial<Record<LimbId, Partial<LimbSnapshot>>> = {};
  let shake = 0;
  let tension = 0.35;
  let vel: Vec2 = { x: 0, y: 0 };
  let yaw = 0;
  switch (name) {
    case 'reach':
      rh = { x: 0.52, y: 2.45 };
      pelvis = { x: 0.08, y: 1.33 };
      chest = { x: 0.16, y: 1.82 };
      ex.RH = { holdId: null, dragging: true, depth: 0.12 };
      break;
    case 'frog':
      pelvis = { x: 0, y: 1.42 };
      chest = { x: 0, y: 1.92 };
      pd = 0.5;
      lh = { x: -0.24, y: 2.2 };
      rh = { x: 0.24, y: 2.28 };
      lf = { x: -0.36, y: 1.28 };
      rf = { x: 0.38, y: 1.32 };
      break;
    case 'shake':
      shake = 0.8;
      tension = 1.2;
      lf = { x: -0.3, y: 0.82 };
      ex.LF = { shake: 1, stress: 1.3 };
      ex.RH = { shake: 0.7, stress: 1.1 };
      yaw = 0.25;
      break;
    case 'falling':
      phase = 'falling';
      pelvis = { x: 0.1, y: 1.6 };
      chest = { x: -0.15, y: 2.05 };
      pd = 0.6;
      vel = { x: 0.6, y: -4 };
      lh = { x: -0.55, y: 2.25 };
      rh = { x: 0.35, y: 2.45 };
      lf = { x: -0.1, y: 0.85 };
      rf = { x: 0.4, y: 0.95 };
      for (const id of ['LH', 'RH', 'LF', 'RF'] as LimbId[]) ex[id] = { holdId: null, depth: 0.5 };
      break;
    case 'landed':
      phase = 'landed';
      pelvis = { x: 0, y: 0.75 };
      chest = { x: 0.03, y: 1.21 };
      pd = 0.7;
      lh = { x: -0.25, y: 0.62 };
      rh = { x: 0.25, y: 0.62 };
      lf = { x: -0.23, y: 0.3 };
      rf = { x: 0.23, y: 0.3 };
      for (const id of ['LH', 'RH', 'LF', 'RF'] as LimbId[]) ex[id] = { holdId: null, depth: 0.75 };
      break;
    case 'hanging':
      phase = 'hanging';
      pelvis = { x: 0, y: 2.2 };
      chest = { x: 0.0, y: 2.7 };
      pd = 0.55;
      lh = { x: -0.2, y: 2.35 };
      rh = { x: 0.2, y: 2.35 };
      lf = { x: -0.12, y: 1.4 };
      rf = { x: 0.12, y: 1.4 };
      for (const id of ['LH', 'RH', 'LF', 'RF'] as LimbId[]) ex[id] = { holdId: null, depth: 0.5 };
      break;
    case 'topped':
      phase = 'topped';
      lh = { x: -0.03, y: 2.3 };
      rh = { x: 0.05, y: 2.3 };
      pelvis = { x: 0.0, y: 1.42 };
      chest = { x: 0.01, y: 1.92 };
      break;
  }
  const add = (p: Vec2): Vec2 => ({ x: p.x + ox, y: p.y });
  const sh = BODY.shoulderHalf;
  const hh = BODY.hipHalf;
  return {
    phase,
    pelvis: add(pelvis),
    chest: add(chest),
    com: add({ x: pelvis.x + (chest.x - pelvis.x) * BODY.comT, y: pelvis.y + (chest.y - pelvis.y) * BODY.comT }),
    pelvisDepth: pd,
    bodyYaw: yaw,
    velocity: vel,
    limbs: {
      LH: limb('LH', add(lh), add({ x: chest.x - sh, y: chest.y }), 0.03, ex.LH),
      RH: limb('RH', add(rh), add({ x: chest.x + sh, y: chest.y }), 0.03, ex.RH),
      LF: limb('LF', add(lf), add({ x: pelvis.x - hh, y: pelvis.y }), 0.02, ex.LF),
      RF: limb('RF', add(rf), add({ x: pelvis.x + hh, y: pelvis.y }), 0.02, ex.RF),
    },
    tension,
    pump: 0.3,
    shake,
    balance: 0,
    topProgress: name === 'topped' ? 1 : 0,
    time: t,
    clipped: [],
  };
}

export interface PoseScene {
  climbers: { m: ClimberModel; name: PoseName; ox: number }[];
  frame: WallFrame;
  rope: RopeMesh | null;
  tick(dt: number, t: number): void;
}

/** Wall + mats + climbers (+ a rope for the hanging pose). */
export function buildPoseScene(scene: THREE.Scene, names: PoseName[], angle: number): PoseScene {
  const frame = new WallFrame(angle);
  const sp = 1.15;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(names.length * sp + 3, 5), new THREE.MeshStandardMaterial({ color: '#2B2D31', roughness: 0.92 }));
  wall.quaternion.copy(frame.quaternion);
  wall.position.copy(frame.toWorldXYZ(0, 2.5, 0));
  wall.receiveShadow = true;
  scene.add(wall);
  const mats = new THREE.Mesh(new THREE.BoxGeometry(names.length * sp + 3, 0.3, 2.4), new THREE.MeshStandardMaterial({ color: '#1F2124', roughness: 0.95 }));
  mats.position.set(0, 0.15, 1.2);
  mats.receiveShadow = true;
  scene.add(mats);
  const holdMat = new THREE.MeshStandardMaterial({ color: '#F2C230', roughness: 0.55 });
  const holdGeo = new THREE.SphereGeometry(0.045, 16, 10);
  const climbers: PoseScene['climbers'] = [];
  names.forEach((name, i) => {
    const ox = (i - (names.length - 1) / 2) * sp;
    const m = new ClimberModel({ head: 'ibex', colorway: 'basalt', chalk: 'classic' });
    if (name === 'hanging') m.setHarness(true);
    scene.add(m);
    climbers.push({ m, name, ox });
    const st = poseState(name, ox, 0);
    for (const id of ['LH', 'RH', 'LF', 'RF'] as LimbId[]) {
      const L = st.limbs[id];
      if (!L.holdId || st.phase === 'falling' || st.phase === 'landed' || st.phase === 'hanging') continue;
      const h = new THREE.Mesh(holdGeo, holdMat);
      h.scale.set(1, 1, 0.55);
      h.position.copy(frame.toWorld(L.pos, 0.012));
      h.quaternion.copy(frame.quaternion);
      h.castShadow = true;
      scene.add(h);
    }
  });
  let rope: RopeMesh | null = null;
  const hang = climbers.find((c) => c.name === 'hanging');
  const ropePts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  if (hang) {
    rope = new RopeMesh();
    scene.add(rope);
  }
  const tick = (dt: number, t: number) => {
    for (const c of climbers) c.m.pose(poseState(c.name, c.ox, t), frame, dt);
    if (hang && rope) {
      // belayer hand on the floor left of the wall → draw above the climber → harness
      ropePts[0].set(hang.ox - 0.9, 1.3, 1.4);
      frame.toWorldXYZ(hang.ox + 0.15, 3.1, 0.08, ropePts[1]);
      hang.m.getHarnessWorld(ropePts[2]);
      hang.m.setRopeAnchor(ropePts[1]);
      rope.setPath(ropePts);
      rope.update(dt);
    }
  };
  // pre-roll so phase timers have progressed
  for (let k = 0; k < 150; k++) tick(1 / 60, k / 60);
  return { climbers, frame, rope, tick };
}

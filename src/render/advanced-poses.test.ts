// Advanced moves on the body (owner: "also add bat hang / heel-toe cam and the figure 4 move"; shared sim +
// render spec v0.3), posed by the REAL ClimberModel from the REAL sim's state:
//  - heel-toe cam: the shoe spans the two opposing holds, the heel on one, the toe on the other;
//  - bat hang: the body hangs inverted below the cammed feet (chest and head below the hips, hands
//    hanging toward the mats), the feet still on their holds, the swing in is smooth;
//  - figure 4: the leg over the opposite holding arm, the back of the knee on its forearm (touching,
//    not through it), the body pressed up.
import '../../dev/character-stub';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoulderDef, HoldDef } from '../core/types';
import { ClimberSim } from '../game/climber-sim';
import { BONE, ClimberModel } from './climber';
import { HoldSet } from './holds';
import { WallFrame } from './wall-frame';

const hold = (id: string, x: number, y: number, type: HoldDef['type'], size: number, role: HoldDef['role'], deg = -90): HoldDef => ({
  id,
  x,
  y,
  type,
  size,
  angle: (deg * Math.PI) / 180,
  role,
  color: '#F2C230',
  seed: 1,
});
const base = (holds: HoldDef[], o: Partial<BoulderDef> = {}): BoulderDef => ({
  id: 'adv',
  name: 'Advanced',
  grade: 5,
  mode: 'boulder',
  wallAngle: 0,
  width: 4.6,
  height: 4.5,
  color: '#F2C230',
  seed: 1,
  holds,
  ...o,
});
/** A cave roof `roof` m up (advanced.test.ts' cave lifted so a bat hang clears the mats). */
function cave(roof = 2.3): BoulderDef {
  const o = roof - 1.3;
  return base(
    [
      hold('s1', -0.25, 2.25 + o, 'jug', 0.11, 'start'),
      hold('s2', 0.25, 2.25 + o, 'jug', 0.11, 'start'),
      hold('a1', -0.3, 1.6 + o, 'edge', 0.07, 'foot', -90),
      hold('a2', 0.3, 1.6 + o, 'edge', 0.07, 'foot', -90),
      hold('b1', -0.3, 1.84 + o, 'edge', 0.07, 'foot', 90),
      hold('b2', 0.3, 1.84 + o, 'edge', 0.07, 'foot', 90),
      hold('t', 0, 4.1 + o, 'jug', 0.12, 'top'),
    ],
    { wallAngle: 90, height: 4.5 + o, profile: [{ y0: 0, angle: 0 }, { y0: roof, angle: 90 }], startFeet: { LF: 'a1', RF: 'a2' } },
  );
}
const ladder = (): BoulderDef =>
  base(
    [
      hold('s1', -0.2, 2.0, 'jug', 0.11, 'start'),
      hold('s2', 0.25, 2.05, 'jug', 0.11, 'start'),
      hold('f1', -0.25, 0.75, 'jug', 0.08, 'foot'),
      hold('f2', 0.3, 0.8, 'jug', 0.08, 'foot'),
      hold('t', 0, 4.1, 'jug', 0.12, 'top'),
    ],
    { startFeet: { LF: 'f1', RF: 'f2' } },
  );

interface Run {
  sim: ClimberSim;
  model: ClimberModel;
  frame: WallFrame;
  set: HoldSet;
  step: (secs: number, each?: () => void) => void;
}
function setup(b: BoulderDef): Run {
  const sim = new ClimberSim(b, { invincible: true });
  sim.reset();
  sim.start();
  const frame = new WallFrame(b.wallAngle);
  frame.setWall(b);
  const set = new HoldSet(frame);
  set.build(b, b.holds);
  const holds = new Map(b.holds.map((h) => [h.id, h]));
  const model = new ClimberModel({ head: 'ibex' });
  model.setHoldLookup((id, o) => set.contactInfo(id, o, holds.get(id)?.y));
  const step = (secs: number, each?: () => void) => {
    for (let i = 0; i < Math.round(secs * 60); i++) {
      sim.step(1 / 60);
      const st = sim.getState();
      frame.setBodyY((st.pelvis.y + st.chest.y) / 2);
      model.pose(st, frame, 1 / 60);
      each?.();
    }
  };
  return { sim, model, frame, set, step };
}

/** World point of a hold's foot contact `p` (wall-local) a little off the surface. */
const at = (r: Run, p: { x: number; y: number }, depth: number) => r.frame.toWorld(p, depth, new THREE.Vector3());
/** The shoe's heel back in world (foot bone frame: +y heel → toe, +z instep). */
const heelOf = (m: ClimberModel, s: number) => {
  const fb = m.rig.bones[s ? BONE.footR : BONE.footL];
  return new THREE.Vector3(0, -0.07, -0.042).applyQuaternion(fb.quaternion).add(fb.position);
};

describe('advanced moves on the body', { timeout: 120_000 }, () => {
  it('heel-toe cam: each shoe spans its two holds, heel on one, toe on the other', () => {
    const r = setup(cave());
    r.step(1);
    const check = (span: boolean) => {
      const st = r.sim.getState();
      for (const [id, s] of [['LF', 0], ['RF', 1]] as const) {
        const L = st.limbs[id];
        expect(L.footMode).toBe('cam');
        const A = at(r, L.contactPos!, 0.03);
        const B = at(r, L.camPos!, 0.03);
        const toe = r.model.rig.joints.toe[s];
        const heel = heelOf(r.model, s);
        // the toe jammed on one contact …
        expect(Math.min(toe.distanceTo(A), toe.distanceTo(B)), id).toBeLessThan(0.035);
        // … and, where the leg lets the ankle square up to the jam, the heel on the other
        if (span) {
          const d1 = Math.max(toe.distanceTo(A), heel.distanceTo(B));
          const d2 = Math.max(toe.distanceTo(B), heel.distanceTo(A));
          expect(Math.min(d1, d2), id).toBeLessThan(0.08);
        }
        expect(r.model.rig.fallback[2 + s], id).toBe(false);
      }
    };
    // the sim's roof stance (hips right under the feet: the folded legs can't square every ankle up)
    check(false);
    // hanging below the feet the shins come straight down to them: heel and toe both on their holds
    r.sim.batHang?.();
    r.step(2.5);
    check(true);
    r.model.dispose();
  });

  it('bat hang: inverted below the feet, head and hands toward the mats; the swing in is smooth', () => {
    const r = setup(cave());
    r.step(1);
    expect(r.sim.canBatHang?.()).toBe(true);
    expect(r.sim.batHang?.()).toBe(true);
    const J = r.model.rig.joints;
    let maxJump = 0;
    const prev = new THREE.Vector3();
    let first = true;
    r.step(2.5, () => {
      if (!first) maxJump = Math.max(maxJump, J.head.distanceTo(prev));
      prev.copy(J.head);
      first = false;
    });
    const st = r.sim.getState();
    expect(st.special).toBe('bat');
    const hips = J.hip[0].clone().add(J.hip[1]).multiplyScalar(0.5);
    const shoulders = J.shoulder[0].clone().add(J.shoulder[1]).multiplyScalar(0.5);
    // inverted: shoulders well below the hips, the head lowest, the hands hanging below the shoulders
    expect(shoulders.y).toBeLessThan(hips.y - 0.35);
    expect(J.head.y).toBeLessThan(shoulders.y);
    for (let s = 0; s < 2; s++) expect(J.wrist[s].y).toBeLessThan(shoulders.y - 0.2);
    // the feet stay on their holds (the cams) above the hips
    for (let s = 0; s < 2; s++) {
      expect(J.ankle[s].y).toBeGreaterThan(hips.y + 0.25);
      expect(r.model.rig.fallback[2 + s]).toBe(false);
    }
    // the swing into the hang is smooth: the head never jumps more than a few cm per frame
    expect(maxJump).toBeLessThan(0.06);
    // and back up: grabbing a hold sits the climber up into an upright body again
    r.sim.beginDrag('RH');
    const s2 = r.sim.boulder.holds.find((h) => h.id === 's2')!;
    for (let i = 0; i < 30; i++) {
      r.sim.dragTo('RH', { x: s2.x, y: s2.y });
      r.step(1 / 60);
    }
    r.sim.endDrag('RH');
    r.step(1.5);
    expect(r.sim.getState().special ?? null).toBeNull();
    const sh2 = J.shoulder[0].clone().add(J.shoulder[1]).multiplyScalar(0.5);
    const hp2 = J.hip[0].clone().add(J.hip[1]).multiplyScalar(0.5);
    // under the roof the upright body lies along it: the shoulders no longer hang below the hips
    expect(sh2.y).toBeGreaterThan(hp2.y - 0.15);
    r.model.dispose();
  });

  it('figure 4: the opposite leg over the holding arm, the back of the knee on the forearm', () => {
    const r = setup(ladder());
    r.step(1);
    expect(r.sim.figure4?.('RF')).toBe(true);
    r.step(1.2);
    const st = r.sim.getState();
    expect(st.special).toBe('figure4');
    const J = r.model.rig.joints;
    // the right thigh (leg 1) resting on the left forearm (hand 0) near the knee: their surfaces touch
    // (axis distance ≈ thigh + forearm radii ≈ 0.1 m), not through each other and not a gap apart
    const seg = new THREE.Line3(J.elbow[0], J.wrist[0]);
    const q = new THREE.Vector3();
    const p = new THREE.Vector3();
    let gap = Infinity;
    let at = 0;
    for (let i = 0; i <= 40; i++) {
      p.copy(J.hip[1]).lerp(J.knee[1], i / 40);
      seg.closestPointToPoint(p, true, q);
      const d = p.distanceTo(q);
      if (d < gap) {
        gap = d;
        at = i / 40;
      }
    }
    expect(gap).toBeGreaterThan(0.07);
    expect(gap).toBeLessThan(0.13);
    // … over the arm near the knee end of the thigh (the back of the knee hooks the forearm)
    expect(at).toBeGreaterThan(0.6);
    // the knee up by the arm, above the hip (the leg lifted across the body), the shin hanging down
    expect(J.knee[1].y).toBeGreaterThan(J.hip[1].y + 0.12);
    expect(J.ankle[1].y).toBeLessThan(J.knee[1].y - 0.25);
    // … past the far (left) side of the holding arm
    expect(J.ankle[1].clone().sub(J.wrist[0]).dot(r.frame.right)).toBeLessThan(0.05);
    expect(r.model.rig.fallback[3]).toBe(false);
    r.model.dispose();
  });
});

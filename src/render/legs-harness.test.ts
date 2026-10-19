// Legs + harness (owner feedback v0.2: "legs look a bit weird sometimes" — a leg sticking out sideways,
// harness leg loops / belay loop looking broken, the rope passing through the thigh).
//  - a standing foot tucked under its hip: the knee goes forward toward the wall and only as far out
//    as the wall needs (it tracks over the toes), never straight out sideways in a Z;
//  - the knee never ends inside the wall while it turns round to a new side;
//  - the rope leaves the tie-in knot up and away from the body and goes round the legs (RopeMesh body
//    capsules), never through a thigh.
import '../../dev/character-stub';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoulderDef, ClimberState, HoldDef } from '../core/types';
import type { SimEvent } from '../core/contracts';
import { ClimberSim } from '../game/climber-sim';
import { BetaBot } from '../game/bot';
import { RopeSystem } from '../game/rope';
import { generateBoulder, generateRopeRoute } from '../game/generator';
import { BONE, ClimberModel } from './climber';
import { RopeMesh } from './rope-mesh';
import { WallFrame } from './wall-frame';
import { HoldSet } from './holds';

const hold = (id: string, x: number, y: number, type: HoldDef['type'], role: HoldDef['role'], angle = -Math.PI / 2, size = 0.07): HoldDef => ({
  id,
  x,
  y,
  type,
  size,
  angle,
  role,
  color: '#F2C230',
  seed: 3,
});

function wall(angle: number, extra: HoldDef[] = []): BoulderDef {
  return {
    id: 'legs',
    name: 'Legs',
    grade: 3,
    mode: 'boulder',
    wallAngle: angle,
    width: 4.6,
    height: 4.5,
    color: '#F2C230',
    seed: 1,
    holds: [
      hold('s1', -0.24, 2.05, 'jug', 'start', -Math.PI / 2, 0.09),
      hold('s2', 0.24, 2.12, 'jug', 'start', -Math.PI / 2, 0.09),
      hold('f1', -0.22, 0.78, 'foot', 'foot', -Math.PI / 2, 0.045),
      hold('f2', 0.2, 0.84, 'foot', 'foot', -Math.PI / 2, 0.045),
      hold('t', 0.05, 4.1, 'jug', 'top'),
      ...extra,
    ],
    startFeet: { LF: 'f1', RF: 'f2' },
  };
}

/**
 * Play a generated problem with the planner bot (the real sim) and pose the climber every frame; `at`
 * is called for each frame in [t0, t1] with the model and the sim state.
 */
function play(b: BoulderDef, t0: number, t1: number, at: (m: ClimberModel, st: ClimberState) => void): void {
  const sim = new ClimberSim(b);
  sim.reset();
  const rope = b.mode === 'rope' ? new RopeSystem(b) : null;
  const bot = new BetaBot(sim);
  sim.start();
  const model = new ClimberModel({ head: 'ibex' });
  model.setHarness(!!rope);
  const holds = new Map(b.holds.map((h) => [h.id, h]));
  const frame = new WallFrame(b.wallAngle);
  frame.setWall(b);
  const set = new HoldSet(frame);
  set.build(b, b.holds);
  model.setHoldLookup((id, o) => set.contactInfo(id, o, holds.get(id)?.y));
  const dt = 1 / 60;
  let events: SimEvent[] = [];
  for (let i = 0; i * dt <= t1; i++) {
    bot.update(dt, events);
    if (rope) {
      const c = rope.catchParams(sim.getState().pelvis);
      sim.setRope(c.anchor, c.length);
    }
    events = sim.step(dt);
    for (const e of events) if (e.type === 'clip-done' && rope) rope.clip(e.quickdrawId);
    const st = sim.getState();
    frame.setBodyY((st.pelvis.y + st.chest.y) / 2);
    model.pose(st, frame, dt);
    if (i * dt >= t0) at(model, st);
  }
  model.dispose();
}

/** How far leg s's knee sticks out to its side beyond both its hip joint and its ankle (m). */
function kneeOut(model: ClimberModel, s: number): number {
  const J = model.rig.joints;
  const px = new THREE.Vector3(1, 0, 0).applyQuaternion(model.rig.bones[BONE.pelvis].quaternion);
  const sg = s ? 1 : -1;
  const out = (p: THREE.Vector3) => p.clone().sub(J.hip[s]).dot(px) * sg;
  return out(J.knee[s]) - Math.max(0, out(J.ankle[s]));
}

describe('legs in real play', { timeout: 120_000 }, () => {
  it('lead: a foot tucked under its hip on the tower takes the knee forward, not straight out sideways', () => {
    // the owner's "one leg sticks out sideways" frame: route seed 29, the left foot 0.4 m under its hip
    let worst = 0;
    let wall = Infinity;
    play(generateRopeRoute({ seed: 29, grade: 3, mode: 'rope' }), 16.0, 16.6, (m) => {
      worst = Math.max(worst, kneeOut(m, 0));
      wall = Math.min(wall, m.rig.wallDepth(m.rig.joints.knee[0]));
    });
    // was ≈0.34 m beyond the hip / foot line (a Z-shaped leg); the knee now comes in toward the wall
    expect(worst).toBeLessThan(0.28);
    expect(wall).toBeGreaterThan(0.05);
  });

  it('a knee turning round to a new side never sweeps through the wall', () => {
    // boulder seed 715: the left foot inside its hip at the start, its knee used to swing through the wall
    let wall = Infinity;
    play(generateBoulder({ seed: 715, grade: 8, mode: 'boulder' }), 0.4, 0.9, (m) => {
      wall = Math.min(wall, m.rig.wallDepth(m.rig.joints.knee[0]));
    });
    expect(wall).toBeGreaterThan(0.04);
  });
});

describe('harness + rope', () => {
  it('the rope leaves the tie-in knot up and away from the body', () => {
    const model = new ClimberModel({ head: 'ibex' });
    model.setHarness(true);
    const knot = model.getHarnessWorld(new THREE.Vector3());
    const lead = model.getRopeLead(new THREE.Vector3());
    const pelvis = model.rig.bones[BONE.pelvis];
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pelvis.quaternion);
    const d = lead.clone().sub(knot);
    expect(d.length()).toBeGreaterThan(0.03);
    expect(d.y).toBeGreaterThan(0.01);
    expect(d.dot(fwd)).toBeGreaterThan(0.01);
    // the knot sits in front of the hips, between the belt and the leg loops
    expect(knot.clone().sub(pelvis.position).dot(fwd)).toBeGreaterThan(0.12);
    const caps = new Float32Array(12 * 8);
    expect(model.getRopeColliders(caps)).toBe(7);
    model.dispose();
  });

  it('a rope from the harness to a draw below runs round a raised thigh, not through it', () => {
    const rope = new RopeMesh();
    // a thigh lying across the straight line from the knot down to the draw
    const caps = new Float32Array([-0.1, 0.92, -0.2, 0.25, 0.92, -0.35, 0.09, 0.07]);
    const knot = new THREE.Vector3(0, 1.0, -0.2);
    const lead = new THREE.Vector3(0, 1.04, -0.23);
    const draw = new THREE.Vector3(0.1, 0.1, -0.45);
    const belayer = new THREE.Vector3(-1, 1, 1.5);
    rope.setColliders(caps, 1);
    rope.setPath([belayer, draw, lead, knot]);
    for (let i = 0; i < 90; i++) rope.update(1 / 60);
    const p = (rope as unknown as { p: THREE.Vector3[]; pCount: number; pinned: Int8Array });
    const a = new THREE.Vector3(caps[0], caps[1], caps[2]);
    const b = new THREE.Vector3(caps[3], caps[4], caps[5]);
    const line = new THREE.Line3(a, b);
    const q = new THREE.Vector3();
    let worst = Infinity;
    for (let i = 0; i < p.pCount; i++) {
      if (p.pinned[i]) continue;
      line.closestPointToPoint(p.p[i], true, q);
      const t = line.closestPointToPointParameter(p.p[i], true);
      const r = caps[6] + (caps[7] - caps[6]) * t;
      worst = Math.min(worst, p.p[i].distanceTo(q) - r);
    }
    expect(worst).toBeGreaterThan(0);
    rope.dispose();
  });
});

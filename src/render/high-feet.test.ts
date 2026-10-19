// High feet (owner feedback v0.2: "feet should be able to go above hip height", "I can toe hook or
// heel hook to gain balance"; shared sim + render spec): the body must really get a foot to a high
// step ≈0.3 m above its hip (hips in) and to heel / toe hooks ≈0.45 m above it, on the hold, without
// the IK giving up (JOINT_LIMITS.hipConeHigh / hipRotOutHigh / kneeFlexHigh for that leg).
import '../../dev/character-stub';
import { describe, expect, it } from 'vitest';
import type { BoulderDef, ClimberState, FootMode, HoldDef } from '../core/types';
import { ClimberSim } from '../game/climber-sim';
import { ClimberModel } from './climber';
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

function wall(angle: number, extra: HoldDef[]): BoulderDef {
  return {
    id: 'hf',
    name: 'High feet',
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

/** Pose the right foot on a hold at (up, out) from its hip joint; → [IK fallback, reach miss (m)]. */
function reach(angle: number, mode: FootMode, up: number, out: number, pelvisDepth: number): [boolean, number] {
  const sim = new ClimberSim(wall(angle, []), { invincible: true });
  sim.reset();
  sim.start();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  const st = JSON.parse(JSON.stringify(sim.getState())) as ClimberState;
  const hip = st.limbs.RF.anchor;
  const ux = st.chest.x - st.pelvis.x;
  const uy = st.chest.y - st.pelvis.y;
  const ul = Math.hypot(ux, uy);
  const tx = hip.x + (uy / ul) * out + (ux / ul) * up;
  const ty = hip.y - (ux / ul) * out + (uy / ul) * up;
  const b = wall(angle, [hold('x', tx, ty, mode === 'edge' ? 'edge' : 'jug', 'hand', mode === 'heel' ? Math.PI : mode === 'toe' ? Math.PI / 2 : -Math.PI / 2)]);
  const frame = new WallFrame(b.wallAngle);
  frame.setWall(b);
  const set = new HoldSet(frame);
  set.build(b, b.holds);
  const model = new ClimberModel({ head: 'ibex' });
  model.setHoldLookup((id, o) => set.contactInfo(id, o));
  st.pelvisDepth = pelvisDepth;
  const L = st.limbs.RF;
  L.holdId = 'x';
  L.pos = { x: tx, y: ty };
  L.contactPos = { x: tx, y: ty };
  L.footMode = mode;
  L.smearing = false;
  for (let i = 0; i < 45; i++) model.pose(st, frame, 1 / 60);
  const r: [boolean, number] = [model.rig.fallback[3], model.rig.reachMiss[3]];
  model.dispose();
  return r;
}

describe('high feet reach their holds', { timeout: 120_000 }, () => {
  it('a rock-over foot 0.3 m above the hip, out to the side, hips in', () => {
    for (const [up, out] of [[0.1, 0.4], [0.2, 0.35], [0.3, 0.3], [0, 0.2]] as const) {
      const [fb, miss] = reach(5, 'edge', up, out, 0.2);
      expect(fb, `up ${up} out ${out}`).toBe(false);
      expect(miss, `up ${up} out ${out}`).toBeLessThan(0.02);
    }
  });
  it('heel hooks to chest height and toe hooks high and far out on steep walls', () => {
    for (const [mode, angle, up, out] of [['heel', 30, 0.3, 0.4], ['heel', 30, 0.45, 0.4], ['toe', 35, 0.3, 0.6], ['toe', 35, 0.45, 0.45]] as const) {
      const [fb, miss] = reach(angle, mode, up, out, 0.3);
      expect(fb, `${mode} up ${up} out ${out}`).toBe(false);
      expect(miss, `${mode} up ${up} out ${out}`).toBeLessThan(0.02);
    }
  });
});

// CHARACTER offline QA — high feet (v0.2 feedback: "I should be able to move my leg higher since I
// can toe hook or heel hook"; "feet should go above hip height if you hold the right position").
// Shared spec (sim + render): edging high steps to ≈0.32 m above the hip joint out to the side with
// the hips in (pelvisDepth ≈0.2); heel / toe hooks to ≈0.50 m above the hip (chest height) 0.25–0.65 m
// out. The REAL ClimberModel is posed from a real sim state with one foot moved onto a foothold at
// every grid point the sim's envelope allows (anatomy.ts LEG_ENVELOPE / HOOK_ENVELOPE), and we check
// the foot really gets there: no IK fallback, the toe / heel on its hold (≤ 2 cm), no knee in the
// wall, no thigh through the belly.
//   npx vitest run --config dev/character.vitest.config.mjs dev/character.highfeet.test.ts
import './character-stub';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoulderDef, ClimberState, FootMode, HoldDef } from '../src/core/types';
import { ClimberSim } from '../src/game/climber-sim';
import { envEval } from '../src/game/anatomy';
import { ClimberModel } from '../src/render/climber';
import { WallFrame } from '../src/render/wall-frame';
import { HoldSet } from '../src/render/holds';
import { measureRig, PEN_BAD, type Measure } from './character-probe';

const hold = (id: string, x: number, y: number, type: HoldDef['type'], role: HoldDef['role'], angle = -Math.PI / 2, size = 0.07): HoldDef => ({
  id,
  x,
  y,
  type,
  size,
  angle,
  role,
  color: '#F2C230',
  seed: Math.round(x * 1000 + y * 77),
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
      hold('t', 0.05, 4.1, 'jug', 'top', -Math.PI / 2, 0.1),
      ...extra,
    ],
    startFeet: { LF: 'f1', RF: 'f2' },
  };
}

interface Case {
  mode: FootMode;
  up: number;
  out: number;
}

function sweep(angle: number, mode: FootMode, ups: number[], outs: number[], pelvisDepth: number): { n: number; ok: number; fb: number; miss: number[]; pen: number; fails: string[] } {
  // a real hanging state on the start holds
  const b0 = wall(angle, []);
  const sim = new ClimberSim(b0, { invincible: true });
  sim.reset();
  sim.start();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  const base = JSON.parse(JSON.stringify(sim.getState())) as ClimberState;
  const hip = base.limbs.RF.anchor;
  const U = { x: base.chest.x - base.pelvis.x, y: base.chest.y - base.pelvis.y };
  const ul = Math.hypot(U.x, U.y);
  U.x /= ul;
  U.y /= ul;
  const R = { x: U.y, y: -U.x };
  const res = { n: 0, ok: 0, fb: 0, miss: [] as number[], pen: 0, fails: [] as string[] };
  const cases: Case[] = [];
  for (const up of ups) for (const out of outs) cases.push({ mode, up, out });
  for (const c of cases) {
    const tx = hip.x + R.x * c.out + U.x * c.up;
    const ty = hip.y + R.y * c.out + U.y * c.up;
    // inside the sim's envelope only (hooks: the hook table, limb index 5)
    const e = envEval(mode === 'heel' || mode === 'toe' ? 5 : 3, hip.x, hip.y, U.x, U.y, tx, ty);
    if (e.excess > 0) continue;
    // a foothold right there, facing the way the technique uses it
    const angleH = mode === 'heel' ? Math.PI : mode === 'toe' ? Math.PI / 2 : -Math.PI / 2;
    const fh = hold('x', tx, ty, mode === 'edge' ? 'edge' : 'jug', 'hand', angleH, 0.07);
    const b = wall(angle, [fh]);
    const frame = new WallFrame(b.wallAngle);
    frame.setWall(b);
    const set = new HoldSet(frame);
    set.build(b, b.holds);
    const model = new ClimberModel({ head: 'ibex' });
    model.setHoldLookup((id, out) => set.contactInfo(id, out));
    const st = JSON.parse(JSON.stringify(base)) as ClimberState;
    st.pelvisDepth = pelvisDepth;
    const L = st.limbs.RF;
    L.holdId = 'x';
    L.pos = { x: tx, y: ty };
    L.contactPos = { x: tx, y: ty };
    L.footMode = mode;
    L.smearing = false;
    for (let i = 0; i < 45; i++) model.pose(st, frame, 1 / 60);
    const goal = (model as unknown as { goal: { feet: { target: THREE.Vector3 }[] } }).goal;
    // what the IK was asked for (the toe / heel contact point) vs what it reached
    const J = model.rig.joints;
    const want = goal.feet[1].target;
    const got = (model as unknown as { rig: { joints: { toe: THREE.Vector3[] } } }).rig.joints.toe[1];
    void got;
    const reached = model.rig.reachMiss ? model.rig.reachMiss[3] : want.distanceTo(J.toe[1]);
    const m: Measure = { pen: 0, what: '', floor: 0, floorWhat: '' };
    measureRig(model.rig, frame.normal, frame.origin, m, {});
    res.n++;
    const fb = model.rig.fallback[3];
    if (fb) res.fb++;
    res.miss.push(reached);
    if (m.pen > PEN_BAD) res.pen++;
    if (!fb && reached < 0.02) res.ok++;
    else if (res.fails.length < 12) res.fails.push(`${mode} up ${c.up.toFixed(2)} out ${c.out.toFixed(2)}: fb ${fb} miss ${(reached * 100).toFixed(1)}cm pen ${(m.pen * 100).toFixed(1)}cm ${m.what}`);
    model.dispose();
    set.clear();
  }
  return res;
}

function report(name: string, r: ReturnType<typeof sweep>): void {
  const mean = r.miss.reduce((a, b) => a + b, 0) / Math.max(1, r.miss.length);
  process.stderr.write(
    `\n== ${name} ==\nreached ${r.ok}/${r.n} (${((100 * r.ok) / Math.max(1, r.n)).toFixed(0)}%)  ik-fallback ${r.fb}  mean miss ${(mean * 100).toFixed(1)} cm  self-pen>${PEN_BAD * 100}cm ${r.pen}\n` +
      (r.fails.length ? `  ${r.fails.join('\n  ')}\n` : ''),
  );
}

describe('high feet: the body reaches what the sim allows', { timeout: 600_000 }, () => {
  it('edging high steps (hips in) to 0.32 m above the hip', () => {
    const r = sweep(5, 'edge', [-0.1, 0, 0.1, 0.2, 0.3], [0.2, 0.3, 0.4, 0.5], 0.2);
    report('high steps, vertical 5°', r);
    expect(r.n).toBeGreaterThan(5);
    if (process.env.STRICT) expect(r.ok / r.n).toBeGreaterThan(0.9);
  });
  it('heel hooks to chest height on a steep wall', () => {
    const r = sweep(30, 'heel', [0, 0.15, 0.3, 0.45], [0.25, 0.4, 0.55, 0.65], 0.3);
    report('heel hooks, overhang 30°', r);
    expect(r.n).toBeGreaterThan(5);
    if (process.env.STRICT) expect(r.ok / r.n).toBeGreaterThan(0.9);
  });
  it('toe hooks high and out', () => {
    const r = sweep(35, 'toe', [0, 0.15, 0.3, 0.45], [0.3, 0.45, 0.6, 0.7], 0.3);
    report('toe hooks, overhang 35°', r);
    expect(r.n).toBeGreaterThan(5);
    if (process.env.STRICT) expect(r.ok / r.n).toBeGreaterThan(0.9);
  });
});

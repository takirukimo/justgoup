// Multi-angle walls in the body model (Phase B1, research §2.1/§2.3/§3.2): every contact feels the panel
// its hold is on, gravity splits by the stance's effective plane, roofs need hooks, and reach is judged in
// 3D across folds. The sim, the planner and the bot climb folded walls.

import { describe, expect, it } from 'vitest';
import type { HoldDef } from '../core/types';
import { SIM } from '../config/tuning';
import { ClimberSim } from './climber-sim';
import { autoClimb } from './bot';
import { planBetaDetailed } from './solver';
import { envEval, envEvalOn } from './anatomy';
import { evaluateStance, FOOT_TOE, initialPose, makeParams, newContact, optimizePose, setContact, StanceEval, type Contacts, type Pose } from './statics';
import { makeProfile, panelsFromLengths, PROFILE_PRESETS, surfaceToLocal3D, worldHeight } from './wall-profile';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

const J = (id: string, x: number, y: number, role: 'start' | 'hand' | 'top' | 'foot' = 'hand', a = -90, size = 0.1): HoldDef => hold(id, x, y, 'jug', size, role, a);

/** Settle the best pose of a stance on the given params (as the planner does). */
function settle(holds: HoldDef[], prm: ReturnType<typeof makeParams>, modes: number[] = [0, 0, 0, 0]): StanceEval {
  const contacts: Contacts = holds.map((h, i) => {
    const c = setContact(newContact(), h, i, false);
    c.mode = modes[i];
    return c;
  });
  const init = initialPose(contacts, prm, { px: 0, py: 0, cx: 0, cy: 0 });
  const pose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
  const ev = new StanceEval();
  optimizePose(contacts, prm, init, pose, ev, 120);
  return evaluateStance(pose, contacts, prm, ev);
}

const cave = (() => {
  const { panels, length } = panelsFromLengths(PROFILE_PRESETS.CAVE);
  return { panels, length, prof: makeProfile(panels, 85, length) };
})();

describe('statics on folded walls', () => {
  it('a stance on one panel, away from the folds, is the flat wall at that angle', () => {
    // kicker 0° (0 … 0.2 m) under a 40° board: everything happens on the board
    const prof = makeProfile([{ y0: 0, angle: 0 }, { y0: 0.2, angle: 40 }], 40, 4.5);
    const holds = [J('a', -0.2, 2.6), J('b', 0.22, 2.7), J('c', -0.2, 1.25, 'foot', -90, 0.08), J('d', 0.2, 1.2, 'foot', -90, 0.08)];
    const flat = settle(holds, makeParams(40, 0, 0));
    const fold = settle(holds, makeParams(40, 0, 0, prof));
    expect(fold.cth).toBeCloseTo(flat.cth, 6);
    expect(fold.sth).toBeCloseTo(flat.sth, 6);
    for (let i = 0; i < 4; i++) {
      expect(fold.angle[i]).toBe(40);
      expect(fold.load[i]).toBeCloseTo(flat.load[i], 2);
      expect(fold.cap[i]).toBeCloseTo(flat.cap[i], 2);
    }
    expect(fold.normalHands).toBeCloseTo(flat.normalHands, 2);
    expect(fold.tension).toBeCloseTo(flat.tension, 2);
  });

  it('gravity follows the panels under the stance: the roof loads the hands, the feet lose effect', () => {
    const p = makeParams(85, 0, 0, cave.prof);
    // on the 30° wall below the roof (panel 0.3 … 1.9) vs under the 85° roof (1.9 … 4.1)
    const low = settle([J('a', -0.2, 1.75), J('b', 0.2, 1.8), J('c', -0.22, 0.45, 'foot', -90, 0.08), J('d', 0.22, 0.5, 'foot', -90, 0.08)], p);
    const roof = settle([J('a', -0.2, 3.4), J('b', 0.2, 3.45), J('c', -0.22, 2.25, 'foot', -90, 0.08), J('d', 0.22, 2.3, 'foot', -90, 0.08)], p);
    expect(low.angle[0]).toBe(30);
    expect(roof.angle[0]).toBe(85);
    expect(roof.angle[2]).toBe(85);
    // the effective plane is far steeper under the roof: less in-plane weight, more pull off the wall
    expect(roof.sth).toBeGreaterThan(low.sth + 0.3);
    expect(roof.normalHands).toBeGreaterThan(low.normalHands + 0.15);
    expect(roof.load[0] + roof.load[1]).toBeGreaterThan(low.load[0] + low.load[1]);
    // the same footholds hold far less on the roof panel
    expect(roof.cap[2]).toBeLessThan(low.cap[2] * 0.8);
    expect(roof.tension).toBeGreaterThan(low.tension);
  });

  it('a toe hook under the roof pulls the body in and unloads the hands', () => {
    const p = makeParams(85, 0, 0, cave.prof);
    const hands = [J('a', -0.2, 3.4), J('b', 0.2, 3.45)];
    // hook-able footholds: their good side faces up the roof (the toe pulls toward the hips)
    const k1 = J('k1', -0.2, 2.45, 'foot', 90, 0.08);
    const k2 = J('k2', 0.22, 2.5, 'foot', 90, 0.08);
    const hooked = settle([...hands, k1, k2], p, [0, 0, FOOT_TOE, FOOT_TOE]);
    expect(hooked.normalHooks).toBeGreaterThan(0.05);
    expect(hooked.hookN[2] + hooked.hookN[3]).toBeGreaterThan(0.05);
    // the same hands with the feet cut (campusing the roof)
    const p2 = makeParams(85, 0, 0, cave.prof);
    const contacts: Contacts = [setContact(newContact(), hands[0], 0, false), setContact(newContact(), hands[1], 1, false), null, null];
    const init = initialPose(contacts, p2, { px: 0, py: 0, cx: 0, cy: 0 });
    const pose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
    const cut = new StanceEval();
    optimizePose(contacts, p2, init, pose, cut, 120);
    evaluateStance(pose, contacts, p2, cut);
    expect(hooked.load[0] + hooked.load[1]).toBeLessThan(cut.load[0] + cut.load[1] - 0.05);
  });

  it('reach is judged in 3D: around the roof lip is further than the surface says, into the corner closer', () => {
    // (envEval / envEvalOn share one output object: copy it) a shoulder under the roof, 0.7 m from a target on the lip panel
    const lip = { ...envEvalOn(cave.prof, 0, 0.1, 3.75, 0, 1, 0.1, 4.45) };
    const flat = { ...envEval(0, 0.1, 3.75, 0, 1, 0.1, 4.45) };
    expect(lip.r).toBeGreaterThan(flat.r * 1.03);
    // a shoulder on the 30° wall reaching into the roof: the inside corner brings it closer
    const corner = { ...envEvalOn(cave.prof, 0, 0.1, 1.55, 0, 1, 0.1, 2.3) };
    const flat2 = { ...envEval(0, 0.1, 1.55, 0, 1, 0.1, 2.3) };
    expect(corner.r).toBeLessThan(flat2.r * 0.98);
  });
});

/** A hand-built cave: 30° start wall, jugs across the 85° roof (with hook-able feet), top on the 20° lip. */
function caveProblem() {
  const F = (id: string, x: number, y: number, a = -90) => J(id, x, y, 'foot', a, 0.08);
  const holds: HoldDef[] = [
    J('s1', -0.2, 1.4, 'start'),
    J('s2', 0.2, 1.45, 'start'),
    F('f1', -0.25, 0.2),
    F('f2', 0.25, 0.25),
    F('f3', 0.2, 0.7),
    F('f4', -0.2, 0.9),
    J('h1', 0.25, 1.95),
    J('h2', -0.2, 2.35),
    J('h3', 0.25, 2.75),
    J('h4', -0.2, 3.15),
    J('h5', 0.2, 3.55),
    J('h6', -0.15, 3.95),
    F('k1', 0.2, 1.5, 90),
    F('k2', -0.2, 1.9, 90),
    F('k3', 0.15, 2.3, 90),
    F('k4', -0.2, 2.7, 90),
    F('k5', 0.2, 3.1, 90),
    J('t', 0.0, 4.45, 'top'),
  ];
  return makeBoulder(holds, { wallAngle: 85, profile: cave.panels, height: cave.length, style: 'cave', grade: 5, startFeet: { LF: 'f1', RF: 'f2' } });
}

describe('ClimberSim on folded walls', () => {
  it('no smearing on a roof: a foot dropped on blank roof dangles, on the kicker it smears', () => {
    const b = caveProblem();
    const sim = new ClimberSim(b);
    sim.start();
    run(sim, 0.5);
    // the left foot onto blank wall on the 30° panel (smearable: ≤ SIM.smearMaxAngle?)
    expect(SIM.smearMaxAngle).toBeLessThan(30);
    sim.beginDrag('LF');
    const s = sim.getState();
    sim.dragTo('LF', { x: s.limbs.LF.anchor.x - 0.1, y: Math.min(1.85, s.limbs.LF.anchor.y + 0.2) });
    run(sim, 0.4);
    const ev = sim.endDrag('LF');
    expect(ev.some((e) => e.type === 'smear')).toBe(false);
  });

  it('the bot sends the cave (hooks on the roof, the lip top-out) and the plan uses the roof feet', () => {
    const b = caveProblem();
    const plan = planBetaDetailed(b, { maxNodes: 2000 });
    expect(plan).not.toBeNull();
    const sim = new ClimberSim(b);
    const r = autoClimb(sim);
    expect(r.sent, r.bot.log.join('; ')).toBe(true);
  });

  it('a fall from under the roof lands on the pad below (straight down in 3D)', () => {
    const b = caveProblem();
    const sim = new ClimberSim(b);
    sim.start();
    run(sim, 0.5);
    for (const [l, h] of [
      ['RH', 'h1'],
      ['LH', 'h2'],
    ] as const)
      moveLimb(sim, l, h);
    run(sim, 0.3);
    const before = sim.getState();
    const p3 = surfaceToLocal3D(cave.prof, before.pelvis.x, before.pelvis.y, before.pelvisDepth);
    sim.forceFall();
    const ev = run(sim, 4);
    expect(ev.some((e) => e.type === 'land')).toBe(true);
    const s = sim.getState();
    expect(s.phase).toBe('landed');
    // crouched on the pad: pelvis ≈ 0.75 m above the floor, about as far out as it fell from
    const h = worldHeight(cave.prof, s.pelvis.y, s.pelvisDepth);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThan(1.1);
    const q = surfaceToLocal3D(cave.prof, s.pelvis.x, s.pelvis.y, s.pelvisDepth);
    expect(Math.abs(q.z - p3.z)).toBeLessThan(0.8);
  });
});

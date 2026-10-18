import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import type { LimbId } from '../core/types';
import { GAME, SIM } from '../config/tuning';
import { ClimberSim } from './climber-sim';
import { generateBoulder, tutorialBoulder, TUTORIAL_SEQUENCE } from './generator';
import { evaluateStance, makeParams, newContact, placeChest, setContact, StanceEval, type Contacts, type Pose } from './statics';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

const LIMBS: LimbId[] = ['LH', 'RH', 'LF', 'RF'];

describe('ClimberSim — stability', () => {
  it('settles calmly on easy problems with all four limbs on', { timeout: 30_000 }, () => {
    const problems = [tutorialBoulder()];
    for (let k = 0; k < 8; k++) problems.push(generateBoulder({ seed: 100 + k, grade: k % 2 }));
    for (const b of problems) {
      const sim = new ClimberSim(b);
      const s0 = sim.getState();
      expect(s0.phase).toBe('idle');
      for (const l of LIMBS) expect(s0.limbs[l].holdId, `${b.id} ${l}`).not.toBeNull();
      sim.start();
      const ev = run(sim, 2.5);
      const s = sim.getState();
      expect(s.phase).toBe('climbing');
      expect(s.tension, b.id).toBeLessThan(0.5);
      expect(ev.some((e) => e.type === 'fall' || e.type === 'slip')).toBe(false);
      // the feet carry most of the weight on an easy vertical-ish problem
      const feet = s.limbs.LF.load + s.limbs.RF.load;
      const hands = s.limbs.LH.load + s.limbs.RH.load;
      expect(feet).toBeGreaterThan(hands);
    }
  });

  it('getState returns one live object that is fully populated', () => {
    const sim = new ClimberSim(tutorialBoulder());
    const a = sim.getState();
    sim.start();
    sim.step(1 / 60);
    expect(sim.getState()).toBe(a);
    for (const l of LIMBS) {
      const ls = a.limbs[l];
      expect(ls.id).toBe(l);
      expect(Number.isFinite(ls.pos.x + ls.pos.y + ls.anchor.x + ls.anchor.y + ls.load + ls.stress + ls.capacity + ls.reachRatio)).toBe(true);
    }
    expect(Number.isFinite(a.com.x + a.com.y + a.pelvisDepth + a.bodyYaw + a.velocity.x + a.tension + a.pump + a.shake + a.balance)).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const b = generateBoulder({ seed: 7, grade: 4 });
    const runOnce = (): string => {
      const sim = new ClimberSim(b);
      sim.start();
      moveLimb(sim, 'RH', sim.reachableHolds('RH').find((id) => id !== sim.getState().limbs.RH.holdId) ?? sim.getState().limbs.RH.holdId!);
      run(sim, 1.3);
      return JSON.stringify(sim.getState());
    };
    expect(runOnce()).toBe(runOnce());
  });
});

describe('ClimberSim — loads, pump, slips', () => {
  it('campusing a jug ladder puts the full load on the hands and pumps them', () => {
    // 20° overhang: no smearing, no footholds → hanging on two jugs
    const b = makeBoulder(
      [hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'), hold('s2', 0.2, 2.1, 'jug', 0.11, 'start'), hold('h1', -0.2, 2.6, 'jug', 0.11, 'hand'), hold('t', 0, 4.1, 'jug', 0.12, 'top')],
      { wallAngle: 20 },
    );
    const sim = new ClimberSim(b);
    expect(sim.getState().limbs.LF.holdId).toBeNull();
    sim.start();
    run(sim, 2);
    const s = sim.getState();
    const hands = s.limbs.LH.load + s.limbs.RH.load;
    expect(hands).toBeGreaterThan(0.95);
    expect(s.limbs.LF.load + s.limbs.RF.load).toBe(0);
    const p2 = s.pump;
    run(sim, 3);
    expect(sim.getState().pump).toBeGreaterThan(p2 + 0.05);
    expect(sim.getState().phase).toBe('climbing');
  });

  // 15° wall: no smearing, so lifted feet really are off. Lifting several limbs at once (multi-touch)
  // leaves the climber hanging on the remaining hand.
  const hangFrom = (right: 'crimp' | 'jug') =>
    makeBoulder(
      [
        hold('s1', -0.2, 2.0, 'jug', 0.11, 'start'),
        hold('s2', 0.2, 2.0, right, right === 'crimp' ? 0.04 : 0.11, 'start'),
        hold('f1', -0.22, 0.85, 'jug', 0.08, 'foot'),
        hold('f2', 0.22, 0.85, 'jug', 0.08, 'foot'),
        hold('t', 0, 4.1, 'jug', 0.12, 'top'),
      ],
      { wallAngle: 15 },
    );

  it('a one-hand crimp hang overloads and slips within ~1.5 s', () => {
    const sim = new ClimberSim(hangFrom('crimp'));
    sim.start();
    const pre = run(sim, 1);
    expect(pre.some((e) => e.type === 'overload' || e.type === 'slip')).toBe(false);
    for (const l of ['LF', 'RF', 'LH'] as const) expect(sim.beginDrag(l)).toBe(true);
    const ev: SimEvent[] = [];
    let t = 0;
    while (t < 3 && !ev.some((e) => e.type === 'fall')) {
      run(sim, 1 / 60, ev);
      t += 1 / 60;
    }
    expect(ev.some((e) => e.type === 'overload' && e.limb === 'RH')).toBe(true);
    expect(ev.some((e) => e.type === 'slip' && e.limb === 'RH')).toBe(true);
    const fall = ev.find((e) => e.type === 'fall');
    expect(fall && fall.type === 'fall' && fall.reason).toBe('slip');
    expect(t).toBeLessThan(1.5);
  });

  it('shaking warns about a second before a slip', () => {
    const sim = new ClimberSim(hangFrom('jug'));
    sim.start();
    const pre = run(sim, 1);
    expect(pre.some((e) => e.type === 'shake-start')).toBe(false);
    for (const l of ['LF', 'RF', 'LH'] as const) sim.beginDrag(l);
    const times: Record<string, number> = {};
    let t = 0;
    while (t < 6 && times.slip === undefined) {
      for (const e of sim.step(1 / 60)) if (!(e.type in times)) times[e.type] = t;
      t += 1 / 60;
    }
    expect(times['shake-start']).toBeDefined();
    expect(times.slip).toBeDefined();
    const warning = times.slip - times['shake-start'];
    expect(warning).toBeGreaterThan(0.6);
    expect(warning).toBeLessThan(2.5);
  });

  it('a centre of mass far outside the support raises tension', () => {
    const b = makeBoulder([
      hold('s1', -0.2, 1.9, 'jug', 0.1, 'start'),
      hold('s2', 0.2, 1.9, 'jug', 0.1, 'start'),
      hold('f1', -0.2, 0.6, 'edge', 0.07, 'foot'),
      hold('f2', 0.2, 0.6, 'edge', 0.07, 'foot'),
      hold('t', 0, 4.1, 'jug', 0.12, 'top'),
    ]);
    const prm = makeParams(0);
    const contacts: Contacts = b.holds.slice(0, 4).map((h, i) => setContact(newContact(), h, i, false));
    const ev = new StanceEval();
    const at = (px: number): number => {
      const p: Pose = { px, py: 1.35, cx: 0, cy: 0 };
      placeChest(p, contacts, prm, 0);
      return evaluateStance(p, contacts, prm, ev).tension;
    };
    const centred = at(0);
    const off = at(0.7);
    expect(centred).toBeLessThan(0.55);
    expect(off).toBeGreaterThan(centred + 0.25);
    expect(ev.balance).toBeCloseTo(1, 1);

    // and live: drag the hips far to the side
    const sim = new ClimberSim(b);
    sim.start();
    run(sim, 1);
    const calm = sim.getState().tension;
    sim.setHipTarget({ x: 0.85, y: 1.3 });
    run(sim, 1.2);
    expect(sim.getState().tension).toBeGreaterThan(calm + 0.2);
    expect(sim.getState().balance).toBeGreaterThan(0.5);
  });

  it('pump at 1 is a fall; invincible climbers never fall', () => {
    const b = makeBoulder([hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'), hold('s2', 0.2, 2.1, 'jug', 0.11, 'start'), hold('t', 0, 4.1, 'jug', 0.12, 'top')], { wallAngle: 25 });
    const sim = new ClimberSim(b);
    sim.start();
    const ev = run(sim, 90);
    const fall = ev.find((e) => e.type === 'fall');
    expect(fall && fall.type === 'fall' ? fall.reason : null).toBe('pump');

    const safe = new ClimberSim(b, { invincible: true });
    safe.start();
    const ev2 = run(safe, 90);
    expect(ev2.some((e) => e.type === 'fall')).toBe(false);
    expect(safe.getState().pump).toBeLessThanOrEqual(SIM.pumpInvincibleCap + 1e-9);
  });

  it('assist raises capacity and slows pump', () => {
    const b = makeBoulder([hold('s1', -0.2, 2.1, 'edge', 0.06, 'start'), hold('s2', 0.2, 2.1, 'edge', 0.06, 'start'), hold('t', 0, 4.1, 'jug', 0.12, 'top')], { wallAngle: 15 });
    const a = new ClimberSim(b);
    const c = new ClimberSim(b, { assist: 1 });
    a.start();
    c.start();
    run(a, 3);
    run(c, 3);
    expect(c.getState().limbs.LH.capacity).toBeGreaterThan(a.getState().limbs.LH.capacity * 1.5);
    expect(c.getState().pump).toBeLessThan(a.getState().pump);
  });
});

describe('ClimberSim — limb rules', () => {
  const b = makeBoulder([
    hold('s1', -0.2, 1.6, 'jug', 0.1, 'start'),
    hold('s2', 0.2, 1.6, 'jug', 0.1, 'start'),
    hold('f1', -0.22, 0.45, 'edge', 0.07, 'foot'),
    hold('f2', 0.22, 0.45, 'edge', 0.07, 'foot'),
    hold('chip', 0.35, 1.95, 'foot', 0.03, 'foot'),
    hold('deco', -0.35, 2.0, 'jug', 0.1, 'deco'),
    hold('h1', 0.3, 2.05, 'jug', 0.1, 'hand'),
    hold('t', 0, 4.1, 'jug', 0.12, 'top'),
  ]);

  it('never uses deco holds; foot chips are feet only; feet may use hand holds', () => {
    const sim = new ClimberSim(b);
    sim.start();
    expect(sim.reachableHolds('LH')).not.toContain('deco');
    expect(sim.reachableHolds('RH')).not.toContain('chip');
    sim.beginDrag('LH');
    expect(sim.snapCandidate('LH', { x: -0.35, y: 2.0 })).toBeNull();
    sim.endDrag('LH');
    // a hand hold works for a foot
    const foot = new ClimberSim(makeBoulder([...b.holds, hold('low', 0.25, 0.85, 'jug', 0.1, 'hand')]));
    foot.start();
    const ev = moveLimb(foot, 'RF', 'low');
    expect(ev.some((e) => e.type === 'grab' && e.holdId === 'low')).toBe(true);
  });

  it('a hand released on nothing returns to its hold; a foot smears on vertical walls only', () => {
    const sim = new ClimberSim(b);
    sim.start();
    sim.beginDrag('RH');
    sim.dragTo('RH', { x: 0.7, y: 1.4 });
    run(sim, 0.3);
    const ev = sim.endDrag('RH');
    expect(ev).toEqual([{ type: 'return', limb: 'RH', holdId: 's2' }]);
    expect(sim.getState().limbs.RH.holdId).toBe('s2');

    sim.beginDrag('LF');
    sim.dragTo('LF', { x: -0.45, y: 0.75 });
    run(sim, 0.3);
    expect(sim.endDrag('LF')).toEqual([{ type: 'smear', limb: 'LF' }]);
    expect(sim.getState().limbs.LF.smearing).toBe(true);

    const steep = new ClimberSim({ ...b, wallAngle: 30 });
    steep.start();
    steep.beginDrag('LF');
    steep.dragTo('LF', { x: -0.45, y: 0.75 });
    run(steep, 0.3);
    expect(steep.endDrag('LF')[0].type).toBe('return');
  });

  it('beginDrag is refused before start and while a limb is already dragged', () => {
    const sim = new ClimberSim(b);
    expect(sim.beginDrag('LH')).toBe(false);
    sim.start();
    expect(sim.beginDrag('LH')).toBe(true);
    expect(sim.beginDrag('LH')).toBe(false);
  });

  it('predicts grip quality and reach consistently', () => {
    const sim = new ClimberSim(b);
    sim.start();
    const q = sim.predictGrip('RH', 'h1');
    expect(q).toBeGreaterThan(0.4);
    expect(q).toBeLessThanOrEqual(1);
    expect(sim.predictGrip('RH', 'deco')).toBe(0);
    expect(sim.maxReach('LH')).toBeCloseTo(0.66);
    const a = sim.limbAnchor('RH');
    expect(Math.hypot(a.x - sim.getState().limbs.RH.anchor.x, a.y - sim.getState().limbs.RH.anchor.y)).toBeLessThan(1e-9);
  });
});

describe('ClimberSim — topping out', () => {
  it('detects the top touch, then the send after matching for GAME.topHold', () => {
    const b = makeBoulder([
      hold('s1', -0.2, 3.25, 'jug', 0.1, 'start'),
      hold('s2', 0.2, 3.25, 'jug', 0.1, 'start'),
      hold('f1', -0.22, 2.1, 'jug', 0.08, 'foot'),
      hold('f2', 0.22, 2.1, 'jug', 0.08, 'foot'),
      hold('t', 0.05, 3.7, 'jug', 0.12, 'top'),
    ]);
    const sim = new ClimberSim(b);
    sim.start();
    const ev = moveLimb(sim, 'LH', 't');
    expect(ev.some((e) => e.type === 'top-touch' && e.limb === 'LH')).toBe(true);
    expect(sim.getState().topProgress).toBe(0);
    moveLimb(sim, 'RH', 't', ev);
    const tMatch = sim.getState().time;
    run(sim, GAME.topHold * 0.5, ev);
    expect(sim.getState().topProgress).toBeGreaterThan(0.3);
    expect(ev.some((e) => e.type === 'top')).toBe(false);
    run(sim, GAME.topHold, ev);
    expect(ev.some((e) => e.type === 'top')).toBe(true);
    const s = sim.getState();
    expect(s.phase).toBe('topped');
    expect(s.topProgress).toBe(1);
    expect(s.time).toBeLessThan(tMatch + GAME.topHold + 0.2);
    expect(sim.beginDrag('LF')).toBe(false);
  });

  it('a boulder fall lands on the pad', () => {
    const sim = new ClimberSim(tutorialBoulder());
    sim.start();
    run(sim, 0.5);
    sim.forceFall();
    const ev = run(sim, 3);
    expect(ev[0]).toEqual({ type: 'fall', reason: 'forced' });
    const land = ev.find((e) => e.type === 'land');
    expect(land).toBeDefined();
    expect(sim.getState().phase).toBe('landed');
  });
});

describe('Tutorial', () => {
  it('the scripted lesson sends tutorialBoulder via beginDrag / dragTo / endDrag', () => {
    const b = tutorialBoulder();
    const sim = new ClimberSim(b);
    sim.start();
    const ev: SimEvent[] = [];
    let shakeDuringLesson = false;
    for (const step of TUTORIAL_SEQUENCE) {
      const h = b.holds.find((x) => x.id === step.holdId)!;
      expect(h, step.holdId).toBeDefined();
      if (step.teach === 'hips') {
        // weight shift over the hold the limb is already on
        expect(sim.getState().limbs[step.limb].holdId).toBe(step.holdId);
        const before = sim.getState().limbs[step.limb].load;
        sim.setHipTarget({ x: h.x, y: sim.getState().pelvis.y + 0.1 });
        run(sim, 1, ev);
        sim.setHipTarget(null);
        expect(sim.getState().limbs[step.limb].load).toBeGreaterThan(before);
        continue;
      }
      const startIdx = ev.length;
      moveLimb(sim, step.limb, step.holdId, ev);
      run(sim, step.teach === 'shake' ? 1.2 : 0.6, ev);
      expect(sim.getState().limbs[step.limb].holdId, `${step.limb} → ${step.holdId}`).toBe(step.holdId);
      if (step.teach === 'shake') shakeDuringLesson = ev.slice(startIdx).some((e) => e.type === 'shake-start') || sim.getState().tension > SIM.shakeOn;
    }
    run(sim, 1.5, ev);
    expect(shakeDuringLesson).toBe(true);
    expect(ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
    expect(ev.some((e) => e.type === 'top')).toBe(true);
    expect(sim.getState().phase).toBe('topped');
  });

  it('teaches the moves in the documented order', () => {
    const order = TUTORIAL_SEQUENCE.map((s) => `${s.teach}:${s.limb}`);
    expect(order.slice(0, 6)).toEqual(['hand:RH', 'foot:RF', 'hips:RF', 'hand:LH', 'foot:LF', 'shake:RH']);
    expect(order.slice(-2)).toEqual(['match:LH', 'match:RH']);
  });
});

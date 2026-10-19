// Phase B body model, checked against docs/climbing-research.md (§2.4 grip, §2.6 pump, §2.7 chalk,
// §2.2/§2.3 foot techniques, §2.5 dynos). Each block names the research anchor it reproduces.

import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import type { BoulderDef, HoldDef, LimbId } from '../core/types';
import { GAME, SIM } from '../config/tuning';
import { ClimberSim, type ClimberSimOptions } from './climber-sim';
import { Forearm } from './forearm';
import { edgeDepthFactor, frictionCapFactor, handGripBase, pumpCapFactor } from './holds';
import { evaluateStance, FOOT_HEEL, FOOT_PUSH, makeParams, newContact, setContact, StanceEval, type Contacts, type Pose } from './statics';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';
import { autoClimb, BetaBot, BOT } from './bot';
import { generateRopeRoute, tutorialBoulder } from './generator';
import { RopeSystem } from './rope';

const grip = (h: HoldDef, wallAngle = 0): number => handGripBase(h, wallAngle, Math.max(0, Math.sin((wallAngle * Math.PI) / 180)));
const withDepth = (mm: number, type: 'edge' | 'crimp' = 'edge'): HoldDef => ({ ...hold('e', 0, 0, type, 0.06, 'hand'), edgeDepthMm: mm });

describe('grip model — edge depth and grip types (research §2.4, [22])', () => {
  it('a 1 cm edge gives ≈61 % of a 4 cm edge (≈39 % force drop); 20 mm is the reference', () => {
    const e10 = grip(withDepth(10));
    const e20 = grip(withDepth(20));
    const e40 = grip(withDepth(40));
    expect(e20).toBeCloseTo(SIM.edge20, 6);
    expect(e10 / e40).toBeGreaterThan(0.58);
    expect(e10 / e40).toBeLessThan(0.64);
    expect(e10 / e20).toBeGreaterThan(0.65); // 10 mm ≈ 0.65–0.75 × 20 mm
    expect(e10 / e20).toBeLessThan(0.75);
    expect(e40 / e20).toBeGreaterThan(1.1); // 40 mm ≈ 1.15 × 20 mm
    expect(e40 / e20).toBeLessThan(1.2);
    // monotone, micros are brutal
    let prev = 0;
    for (let mm = 3; mm <= 60; mm++) {
      const f = edgeDepthFactor(mm);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(edgeDepthFactor(5)).toBeLessThan(0.45);
  });

  it('generated crimps and edges keep their sizes as depths; crimps grip ≈0.65–0.8 × edges', () => {
    const crimp = grip(hold('c', 0, 0, 'crimp', 0.04, 'hand'));
    const edge = grip(hold('e', 0, 0, 'edge', 0.065, 'hand'));
    expect(crimp / edge).toBeGreaterThan(0.62);
    expect(crimp / edge).toBeLessThan(0.8);
    // a bigger edge hold has a deeper edge
    expect(grip(hold('e', 0, 0, 'edge', 0.08, 'hand'))).toBeGreaterThan(grip(hold('e', 0, 0, 'edge', 0.05, 'hand')));
  });

  it('per grip type: jugs 1.3–1.6 × the 20 mm edge, pockets by fingers, pinches 0.5–0.8', () => {
    const e20 = SIM.edge20;
    const jug = grip(hold('j', 0, 0, 'jug', 0.095, 'hand'));
    expect(jug / e20).toBeGreaterThan(1.3);
    expect(jug / e20).toBeLessThan(1.6);
    const pocket = (fingers: 1 | 2 | 3 | 4): number => grip({ ...hold('p', 0, 0, 'pocket', 0.05, 'hand'), fingers });
    expect(pocket(1) / e20).toBeGreaterThan(0.25);
    expect(pocket(1) / e20).toBeLessThan(0.35);
    expect(pocket(2) / e20).toBeGreaterThan(0.5);
    expect(pocket(2) / e20).toBeLessThan(0.6);
    expect(pocket(3) / e20).toBeGreaterThan(0.75);
    expect(pocket(3) / e20).toBeLessThan(0.85);
    const pinch = grip(hold('p', 0, 0, 'pinch', 0.065, 'hand'));
    expect(pinch / e20).toBeGreaterThan(0.5);
    expect(pinch / e20).toBeLessThanOrEqual(0.82);
  });

  it('slopers follow the effective slope (lip + wall angle): good on slabs, dying on steep walls', () => {
    const sl = hold('s', 0, 0, 'sloper', 0.1, 'hand');
    const flat = { ...sl, lipAngle: -15 };
    // ≈0.9 × the 20 mm edge at a shallow effective slope
    expect(grip(flat, 0) / SIM.edge20).toBeGreaterThan(0.85);
    expect(grip(flat, 0) / SIM.edge20).toBeLessThan(0.95);
    const at = [-8, 0, 15, 30, 45].map((a) => grip(sl, a));
    for (let k = 1; k < at.length; k++) expect(at[k]).toBeLessThan(at[k - 1]);
    expect(at[4] / at[1]).toBeLessThan(0.5);
    // a slopier lip is worse on the same wall
    expect(grip({ ...sl, lipAngle: -40 }, 10)).toBeLessThan(grip({ ...sl, lipAngle: -25 }, 10));
    // jugs barely care about the wall angle
    const jug = hold('j', 0, 0, 'jug', 0.1, 'hand');
    expect(grip(jug, 45) / grip(jug, 0)).toBeGreaterThan(0.9);
  });

  it('sweaty skin costs slopers most, then crimps/edges/pinches, then pockets, jugs least (§2.7)', () => {
    const order = (['sloper', 'edge', 'pocket', 'jug'] as const).map((t) => frictionCapFactor(t, 0));
    for (let k = 1; k < order.length; k++) expect(order[k]).toBeGreaterThan(order[k - 1]);
    // fresh chalk (1.2) vs sweaty (0.8): a sloper keeps 0.8 / 1.2 of its capacity
    expect(order[0]).toBeCloseTo(0.8 / 1.2, 6);
    expect(frictionCapFactor('crimp', 1)).toBe(1);
  });

  it('the live sim reads hold depth: a two-hand hang on 10 mm edges has ≈61 % of the 40 mm capacity', () => {
    const cap = (mm: number): number => {
      const e = (id: string, x: number): HoldDef => ({ ...hold(id, x, 2.0, 'edge', 0.06, 'start'), edgeDepthMm: mm });
      const sim = new ClimberSim(makeBoulder([e('s1', -0.2), e('s2', 0.2), hold('t', 0, 4.1, 'jug', 0.12, 'top')]));
      sim.start();
      run(sim, 0.5);
      return sim.getState().limbs.LH.capacity;
    };
    const r = cap(10) / cap(40);
    expect(r).toBeGreaterThan(0.56);
    expect(r).toBeLessThan(0.66);
  });
});

// ═══════════════════════════════ pump ═══════════════════════════════

/** Run until the climber is off the wall (or maxT); returns the time and the events. */
function untilFall(sim: ClimberSim, maxT: number, chunk = 0.5): { t: number; ev: SimEvent[] } {
  const ev: SimEvent[] = [];
  let t = 0;
  while (t < maxT && !ev.some((e) => e.type === 'fall')) {
    run(sim, chunk, ev);
    t += chunk;
  }
  return { t, ev };
}

/** Forearm alone: continuous or intermittent (on/off seconds) loading at intensity f until it fails. */
function forearmLife(f: number, on = Infinity, off = 0, maxT = 3600): number {
  const a = new Forearm();
  const dt = 1 / 120;
  for (let t = 0; t < maxT; t += dt) {
    const gripping = off === 0 || t % (on + off) < on;
    a.step(dt, { f: gripping ? f : 0, gripping, shaking: false, drainScale: 1 });
    // failure: spent W′, or the pumped hand can no longer hold the load (stress past the slip zone)
    if (a.exhausted || (gripping && f / pumpCapFactor(a.pump) > 1.15)) return t;
  }
  return Infinity;
}

const edgeHang = (mm: number | 'jug', opts: ClimberSimOptions = {}): ClimberSim => {
  const e = (id: string, x: number): HoldDef => (mm === 'jug' ? hold(id, x, 2.0, 'jug', 0.1, 'start') : { ...hold(id, x, 2.0, 'edge', 0.06, 'start'), edgeDepthMm: mm });
  const sim = new ClimberSim(makeBoulder([e('s1', -0.2), e('s2', 0.2), hold('t', 0, 4.1, 'jug', 0.12, 'top')]), opts);
  sim.start();
  // a true dead hang: lift both feet off the (smearable) vertical wall and keep them up
  sim.beginDrag('LF');
  sim.beginDrag('RF');
  return sim;
};

describe('per-forearm pump (research §2.6)', () => {
  it('the forearm model reproduces the measured anchors', () => {
    // continuous 60 % MVC: 48–66 s
    const c60 = forearmLife(0.6);
    expect(c60).toBeGreaterThan(48);
    expect(c60).toBeLessThan(66.5);
    // steady 40 % MVC: minutes, not seconds (7–14 min; the old global meter fell after ≈140 s)
    const c40 = forearmLife(0.4);
    expect(c40).toBeGreaterThan(7 * 60);
    expect(c40).toBeLessThan(14 * 60);
    // intermittent 80 % MVC 5 s on / 5 s off: 1.5–3 min
    const i80 = forearmLife(0.8, 5, 5);
    expect(i80).toBeGreaterThan(90);
    expect(i80).toBeLessThan(180);
    // intermittent loading recovers in the pauses: far longer than the same force held without release
    expect(forearmLife(0.6, 5, 5)).toBeGreaterThan(4 * c60);
    expect(forearmLife(0.4, 5, 2)).toBeGreaterThan(c40);
  });

  it('a no-feet hang lasts ≈23–59 s depending on the edge and the climber, and a hand fails first', { timeout: 30_000 }, () => {
    const hangTime = (mm: number | 'jug', strength = 1): number => {
      const r = untilFall(edgeHang(mm, { strength }), 120);
      const fall = r.ev.find((e) => e.type === 'fall');
      expect(fall && fall.type === 'fall' && fall.reason, `${mm} mm`).toBe('pump');
      // not a global meter: one overloaded forearm fails and that hand slips
      const slipIdx = r.ev.findIndex((e) => e.type === 'slip');
      expect(slipIdx).toBeGreaterThanOrEqual(0);
      const slip = r.ev[slipIdx];
      expect(slip.type === 'slip' && (slip.limb === 'LH' || slip.limb === 'RH')).toBe(true);
      return r.t;
    };
    const t20 = hangTime(20);
    const t40 = hangTime(40);
    const tJug = hangTime('jug');
    expect(t20).toBeGreaterThan(20);
    expect(t20).toBeLessThan(32);
    expect(t40).toBeGreaterThan(t20 + 4);
    expect(tJug).toBeGreaterThan(40);
    expect(tJug).toBeLessThan(65);
    // research [26] on a 25 mm edge: 23 / 42 / 59 s for low / intermediate / advanced climbers
    // (strength 0.9 / 1.25 / 1.5: ≈0.5 / 0.7 / 0.83 BW on that edge, research §2.4)
    const low = hangTime(25, 0.9);
    const mid = hangTime(25, 1.25);
    const adv = hangTime(25, 1.5);
    expect(low).toBeGreaterThan(17);
    expect(low).toBeLessThan(29);
    expect(mid).toBeGreaterThan(35);
    expect(mid).toBeLessThan(50);
    expect(adv).toBeGreaterThan(52);
    expect(adv).toBeLessThan(70);
  });

  it('a steady stance near the endurance threshold lasts minutes (7–14 min), not ≈140 s', { timeout: 60_000 }, () => {
    const e = (id: string, x: number): HoldDef => ({ ...hold(id, x, 2.3, 'edge', 0.06, 'start'), edgeDepthMm: 15 });
    const b = makeBoulder([e('s1', -0.2), e('s2', 0.2), hold('f1', -0.22, 0.75, 'jug', 0.08, 'foot'), hold('f2', 0.23, 0.75, 'jug', 0.08, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')], {
      wallAngle: 20,
    });
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    run(sim, 5);
    const s = sim.getState();
    expect(s.limbs.LF.holdId).toBe('f1');
    expect(s.limbs.LH.stress).toBeGreaterThan(0.33);
    expect(s.limbs.LH.stress).toBeLessThan(0.45);
    const r = untilFall(sim, 900, 5);
    expect(r.t + 5).toBeGreaterThan(7 * 60);
    expect(r.t + 5).toBeLessThan(14 * 60);
    const fall = r.ev.find((x) => x.type === 'fall');
    expect(fall && fall.type === 'fall' && fall.reason).toBe('pump');
  });

  it('pump is per forearm: ClimberState.pump is the worse hand, the free hand recovers', () => {
    const b = makeBoulder(
      [hold('s1', -0.2, 2.0, 'jug', 0.1, 'start'), hold('s2', 0.2, 2.0, 'jug', 0.1, 'start'), hold('f1', -0.22, 0.85, 'jug', 0.08, 'foot'), hold('f2', 0.22, 0.85, 'jug', 0.08, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')],
      { wallAngle: 20 },
    );
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    // lift the left hand and hold it in the air: the right forearm works alone
    expect(sim.beginDrag('LH')).toBe(true);
    for (let k = 0; k < 15 * 60; k++) {
      sim.dragTo('LH', { x: -0.45, y: 1.9 });
      sim.step(1 / 60);
    }
    const s = sim.getState();
    expect(s.phase).toBe('climbing');
    expect(s.limbs.RH.pump!).toBeGreaterThan(0.08);
    expect(s.limbs.LH.pump!).toBeLessThan(0.02);
    expect(s.pump).toBe(Math.max(s.limbs.LH.pump!, s.limbs.RH.pump!));
    expect(s.limbs.LF.pump).toBeUndefined();
  });
});

// ═══════════════════════════════ brute force vs technique ═══════════════════════════════

describe('brute force stays possible, good technique pumps less (research §2.1, §2.6)', () => {
  const steep = (): BoulderDef =>
    makeBoulder(
      [
        { ...hold('s1', -0.2, 2.1, 'edge', 0.06, 'start'), edgeDepthMm: 25 },
        { ...hold('s2', 0.2, 2.1, 'edge', 0.06, 'start'), edgeDepthMm: 25 },
        hold('f1', -0.22, 0.9, 'edge', 0.06, 'foot'),
        hold('f2', 0.22, 0.9, 'edge', 0.06, 'foot'),
        hold('t', 0, 4.1, 'jug', 0.12, 'top'),
      ],
      { wallAngle: 15 },
    );

  it('cutting feet (campusing) works for a while but pumps several times faster than feet on', () => {
    const feet = new ClimberSim(steep(), { sweat: 0 });
    feet.start();
    const campus = new ClimberSim(steep(), { sweat: 0 });
    campus.start();
    campus.beginDrag('LF');
    campus.beginDrag('RF');
    const ev = run(campus, 10);
    run(feet, 10);
    // strong but technically poor: still on the wall after 10 s of campusing …
    expect(ev.some((e) => e.type === 'fall')).toBe(false);
    expect(campus.getState().phase).toBe('climbing');
    // … at a far higher pump cost
    expect(campus.getState().pump).toBeGreaterThan(0.15);
    expect(campus.getState().pump).toBeGreaterThan(4 * feet.getState().pump + 0.05);
  });

  it('hips in (legs long, close to the wall) pumps less than sitting back with the hips out', () => {
    const b = makeBoulder(
      [
        { ...hold('s1', -0.2, 2.3, 'edge', 0.06, 'start'), edgeDepthMm: 20 },
        { ...hold('s2', 0.2, 2.3, 'edge', 0.06, 'start'), edgeDepthMm: 20 },
        hold('f1', -0.22, 0.85, 'jug', 0.08, 'foot'),
        hold('f2', 0.23, 0.85, 'jug', 0.08, 'foot'),
        hold('t', 0, 4.1, 'jug', 0.12, 'top'),
      ],
      { wallAngle: 15 },
    );
    const hang = (dy: number) => {
      const sim = new ClimberSim(b, { sweat: 0 });
      sim.start();
      run(sim, 1);
      sim.setHipTarget({ x: 0, y: sim.getState().pelvis.y + dy });
      run(sim, 2);
      const s = sim.getState();
      const r = { depth: s.pelvisDepth, hands: handLoad(sim), p0: s.pump };
      run(sim, 30);
      return { ...r, pump: sim.getState().pump - r.p0 };
    };
    const hipsIn = hang(0);
    const hipsOut = hang(-0.3);
    expect(hipsIn.depth).toBeLessThan(hipsOut.depth - 0.15);
    expect(hipsIn.hands).toBeLessThan(hipsOut.hands - 0.08);
    expect(hipsIn.pump).toBeLessThan(hipsOut.pump - 0.1);
  });

  it('a deep lock-off pumps more than hanging on straight arms', () => {
    const b = makeBoulder(
      [
        { ...hold('s1', -0.2, 2.3, 'edge', 0.06, 'start'), edgeDepthMm: 20 },
        { ...hold('s2', 0.2, 2.3, 'edge', 0.06, 'start'), edgeDepthMm: 20 },
        hold('f1', -0.22, 0.75, 'jug', 0.08, 'foot'),
        hold('f2', 0.23, 0.75, 'jug', 0.08, 'foot'),
        hold('t', 0, 4.1, 'jug', 0.12, 'top'),
      ],
      { wallAngle: 25 },
    );
    const pumpAfter = (hipY: number | null): number => {
      const sim = new ClimberSim(b, { sweat: 0 });
      sim.start();
      run(sim, 1);
      if (hipY !== null) sim.setHipTarget({ x: 0, y: hipY });
      run(sim, 40);
      expect(sim.getState().phase).toBe('climbing');
      return sim.getState().pump;
    };
    const straight = pumpAfter(1.25);
    const lockOff = pumpAfter(1.85);
    expect(lockOff).toBeGreaterThan(straight + 0.05);
  });
});

// ═══════════════════════════════ shake-out ═══════════════════════════════

describe('shake-out (research §2.6: +32 % reoxygenation beside the body)', () => {
  const jugs = (): BoulderDef =>
    makeBoulder(
      [hold('s1', -0.2, 2.0, 'jug', 0.1, 'start'), hold('s2', 0.2, 2.0, 'jug', 0.1, 'start'), hold('f1', -0.22, 0.85, 'jug', 0.08, 'foot'), hold('f2', 0.22, 0.85, 'jug', 0.08, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')],
      { wallAngle: 15 },
    );

  /** Pump both forearms by hanging without feet for `secs`, then put the feet back. */
  const pumped = (secs: number): ClimberSim => {
    const sim = new ClimberSim(jugs(), { sweat: 0 });
    sim.start();
    sim.beginDrag('LF');
    sim.beginDrag('RF');
    run(sim, secs);
    sim.endDrag('LF');
    sim.endDrag('RF');
    run(sim, 0.5);
    expect(sim.getState().limbs.LF.holdId).toBe('f1');
    return sim;
  };

  it('shaking out recovers with the shake-out half-life, faster than resting on a jug', { timeout: 30_000 }, () => {
    const f = new Forearm();
    expect(f.halfLife).toBeCloseTo(SIM.forearm.halfLife, 6);
    const sim = pumped(22);
    const p0 = sim.getState().limbs.LH.pump!;
    expect(p0).toBeGreaterThan(0.25);
    const ev: SimEvent[] = [];
    expect(sim.shakeOut('LH')).toBe(true);
    for (const e of sim.step(0)) ev.push(e);
    expect(ev.map((e) => e.type)).toEqual(['release', 'shake-out-start']);
    const s = sim.getState();
    expect(s.limbs.LH.shakingOut).toBe(true);
    expect(s.limbs.LH.holdId).toBeNull();
    let t = 0;
    while (sim.getState().limbs.LH.pump! > p0 / 2 && t < 90) {
      run(sim, 0.25, ev);
      t += 0.25;
    }
    const half = SIM.forearm.halfLife / SIM.forearm.shakeBoost;
    expect(t).toBeGreaterThan(half * 0.85);
    expect(t).toBeLessThan(half * 1.25);
    // the hand that kept holding on (with feet) recovered far less in the same time
    const rest = pumped(22);
    const r0 = rest.getState().limbs.LH.pump!;
    run(rest, t);
    expect(rest.getState().limbs.LH.pump!).toBeGreaterThan(r0 * 0.7);
    expect(ev.some((e) => e.type === 'fall' || e.type === 'slip')).toBe(false);
  });

  it('alternating hands shakes both forearms out; the shaking hand re-grabs by a normal drag', { timeout: 30_000 }, () => {
    // a vertical wall: one hand alone on a jug with the feet on works below its critical force
    const sim = new ClimberSim({ ...jugs(), wallAngle: 0 }, { sweat: 0 });
    sim.start();
    sim.beginDrag('LF');
    sim.beginDrag('RF');
    run(sim, 20);
    sim.endDrag('LF');
    sim.endDrag('RF');
    run(sim, 0.5);
    const p0 = sim.getState().pump;
    expect(sim.shakeOut('LH')).toBe(true);
    run(sim, 12);
    const ev = moveLimb(sim, 'LH', 's1');
    expect(ev.some((e) => e.type === 'shake-out-end' && e.limb === 'LH')).toBe(true);
    expect(sim.getState().limbs.LH.holdId).toBe('s1');
    expect(sim.shakeOut('RH')).toBe(true);
    run(sim, 12);
    moveLimb(sim, 'RH', 's2');
    const s = sim.getState();
    expect(s.limbs.RH.holdId).toBe('s2');
    expect(s.limbs.LH.pump!).toBeLessThan(p0 * 0.85);
    expect(s.limbs.RH.pump!).toBeLessThan(p0 * 0.85);
  });

  it('dropping a hand down beside the body shakes out; it is refused when the other hand is not good', () => {
    const sim = new ClimberSim(jugs());
    sim.start();
    run(sim, 1);
    const sh = sim.getState().limbs.RH.anchor;
    sim.beginDrag('RH');
    for (let k = 0; k < 20; k++) {
      sim.dragTo('RH', { x: sh.x + 0.12, y: sh.y - 0.5 });
      run(sim, 1 / 60);
    }
    const ev = sim.endDrag('RH');
    expect(ev).toEqual([{ type: 'shake-out-start', limb: 'RH' }]);
    expect(sim.getState().limbs.RH.shakingOut).toBe(true);
    // a crimp with no feet is not a hold to shake out on
    const bad = new ClimberSim(
      makeBoulder([hold('s1', -0.2, 2.0, 'crimp', 0.03, 'start'), hold('s2', 0.2, 2.0, 'jug', 0.1, 'start'), hold('t', 0, 4.1, 'jug', 0.12, 'top')], { wallAngle: 20 }),
    );
    bad.start();
    run(bad, 0.5);
    expect(bad.shakeOut('RH')).toBe(false);
    expect(bad.getState().limbs.RH.holdId).toBe('s2');
  });
});

// ═══════════════════════════════ chalk & sweat ═══════════════════════════════

describe('chalk & sweat (research §2.7, §6.5)', () => {
  const holds = (): HoldDef[] => [
    hold('s1', -0.2, 1.9, 'jug', 0.1, 'start'),
    hold('s2', 0.2, 1.9, 'sloper', 0.1, 'start'),
    hold('h1', 0.3, 2.15, 'jug', 0.1, 'hand'),
    hold('f1', -0.22, 0.75, 'jug', 0.08, 'foot'),
    hold('f2', 0.22, 0.75, 'jug', 0.08, 'foot'),
    hold('t', 0, 4.1, 'jug', 0.12, 'top'),
  ];
  /** n right-hand moves back and forth between s2 and h1 at a lead pace (≈6.5 s per move, research [40]). */
  const shuffle = (sim: ClimberSim, n: number): void => {
    for (let k = 0; k < n; k++) {
      moveLimb(sim, 'RH', k % 2 === 0 ? 'h1' : 's2');
      run(sim, 5);
    }
  };

  it('fades within ≈5 moves on lead, but only slowly when bouldering', () => {
    const lead = new ClimberSim(makeBoulder(holds(), { mode: 'rope', height: 15, width: 4.4, quickdraws: [{ id: 'q0', x: 0.9, y: 2.2 }] }));
    const boulder = new ClimberSim(makeBoulder(holds()));
    for (const sim of [lead, boulder]) {
      sim.start();
      expect(sim.getState().limbs.RH.friction).toBe(1);
      shuffle(sim, 6);
    }
    // lead: fresh → sweaty within ≈5 moves (≈35 s); bouldering: barely noticeable after 6 moves / ≈40 s
    expect(lead.getState().limbs.RH.friction!).toBeLessThan(0.1);
    expect(boulder.getState().limbs.RH.friction!).toBeGreaterThan(0.75);
    // the hand that didn't move wore less (each hand move costs chalk)
    expect(boulder.getState().limbs.LH.friction!).toBeGreaterThan(boulder.getState().limbs.RH.friction!);
    // time alone wears it too (bouldering: noticeable after ≈50–60 s)
    run(boulder, 30);
    expect(boulder.getState().limbs.LH.friction!).toBeLessThan(0.85);
    expect(boulder.getState().limbs.LH.friction!).toBeGreaterThan(0.4);
  });

  it('sweaty hands lose most on slopers, least on jugs', () => {
    const sim = new ClimberSim(makeBoulder(holds()), { sweat: 4 });
    sim.start();
    run(sim, 0.5);
    const c0 = { L: sim.getState().limbs.LH.capacity, R: sim.getState().limbs.RH.capacity };
    run(sim, 60);
    const s = sim.getState();
    expect(s.limbs.RH.friction!).toBeLessThan(0.05);
    const jugLoss = s.limbs.LH.capacity / c0.L;
    const sloperLoss = s.limbs.RH.capacity / c0.R;
    expect(sloperLoss).toBeLessThan(jugLoss - 0.15);
    expect(sloperLoss).toBeLessThan(0.75);
    expect(jugLoss).toBeGreaterThan(0.9);
  });

  it('chalkUp: the hand leaves for ≈1 s (busy, the other limbs hold), returns to its hold with fresh chalk', () => {
    const sim = new ClimberSim(makeBoulder(holds()), { sweat: 4 });
    expect(sim.chalkUp('RH')).toBe(false); // not before the climb starts
    sim.start();
    run(sim, 40);
    expect(sim.getState().limbs.RH.friction!).toBeLessThan(0.5);
    expect(sim.chalkUp('RH')).toBe(true);
    const ev: SimEvent[] = sim.step(0).slice();
    expect(ev.map((e) => e.type)).toEqual(['release', 'chalk-start']);
    let s = sim.getState();
    expect(s.limbs.RH.chalking).toBe(true);
    expect(s.limbs.RH.busy).toBe(true);
    expect(s.limbs.RH.holdId).toBeNull();
    expect(sim.beginDrag('RH')).toBe(false); // busy
    expect(sim.chalkUp('LH')).toBe(false); // the other hand is in the bag
    run(sim, SIM.chalkTime * 0.8, ev);
    expect(ev.some((e) => e.type === 'chalk-done')).toBe(false);
    run(sim, SIM.chalkTime * 0.4, ev);
    const types = ev.map((e) => e.type);
    expect(types.slice(-2)).toEqual(['chalk-done', 'return']);
    const ret = ev[ev.length - 1];
    expect(ret.type === 'return' && ret.holdId).toBe('s2');
    s = sim.getState();
    expect(s.limbs.RH.friction!).toBeGreaterThan(0.999);
    expect(s.limbs.RH.chalking).toBe(false);
    expect(s.limbs.RH.holdId).toBe('s2');
    expect(ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
  });

  it('reaching back to the chalk bag (a drag to the hips) chalks up too', () => {
    const sim = new ClimberSim(makeBoulder(holds()));
    sim.start();
    run(sim, 1);
    const p = sim.getState().pelvis;
    // the right hand leaves the sloper; the left hand holds the jug meanwhile
    sim.beginDrag('RH');
    for (let k = 0; k < 20; k++) {
      sim.dragTo('RH', { x: p.x, y: p.y - 0.1 });
      run(sim, 1 / 60);
    }
    expect(sim.endDrag('RH')).toEqual([{ type: 'chalk-start', limb: 'RH' as LimbId }]);
    const ev = run(sim, SIM.chalkTime + 0.2).filter((e) => e.type !== 'shake-start' && e.type !== 'shake-end');
    expect(ev.map((e) => e.type)).toEqual(['chalk-done', 'return']);
    expect(sim.getState().limbs.RH.holdId).toBe('s2');
  });
});

// ═══════════════════════════════ foot techniques ═══════════════════════════════

const handLoad = (sim: ClimberSim): number => sim.getState().limbs.LH.load + sim.getState().limbs.RH.load;

describe('foot techniques (research §2.2, §2.3)', () => {
  const steepWithHook = (wallAngle: number, k: HoldDef): BoulderDef =>
    makeBoulder(
      [hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'), hold('s2', 0.2, 2.1, 'jug', 0.11, 'start'), hold('f1', -0.2, 0.95, 'jug', 0.08, 'foot'), hold('f2', 0.2, 0.95, 'jug', 0.08, 'foot'), k, hold('t', 0, 4.1, 'jug', 0.12, 'top')],
      { wallAngle },
    );
  /** Hands' load with the right foot off, then with it put on hold k (and the events of that move). */
  const hookTrial = (b: BoulderDef): { off: number; on: number; sim: ClimberSim; ev: SimEvent[] } => {
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    run(sim, 1.5);
    sim.beginDrag('RF');
    run(sim, 1.5);
    const off = handLoad(sim);
    sim.endDrag('RF');
    run(sim, 0.5);
    const ev = moveLimb(sim, 'RF', 'k');
    run(sim, 1.5, ev);
    return { off, on: handLoad(sim), sim, ev };
  };

  it('a foot at / above hip height out to the side on an overhang heel-hooks and takes load off the hands', () => {
    for (const angle of [35, 50]) {
      const r = hookTrial(steepWithHook(angle, hold('k', 0.55, 1.35, 'jug', 0.1, 'hand')));
      const s = r.sim.getState();
      expect(s.limbs.RF.holdId).toBe('k');
      expect(s.limbs.RF.footMode, `${angle}°`).toBe('heel');
      expect(r.ev.some((e) => e.type === 'technique' && e.limb === 'RF' && e.technique === 'heel')).toBe(true);
      expect(r.on, `${angle}°`).toBeLessThan(r.off - 0.1);
      expect(r.ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
    }
    // on a vertical wall the same placement is just a foot on a hold
    const flat = hookTrial(steepWithHook(0, hold('k', 0.55, 1.35, 'jug', 0.1, 'hand')));
    expect(flat.sim.getState().limbs.RF.footMode).not.toBe('heel');
  });

  it('a toe hook pulls on a hold the foot cannot stand on (under a lip), also unloading the hands', () => {
    // the hold faces back toward the climber: the toe pulls on its far side
    const r = hookTrial(steepWithHook(45, hold('k', 0.75, 1.0, 'jug', 0.1, 'hand', 180)));
    expect(r.sim.getState().limbs.RF.footMode).toBe('toe');
    expect(r.ev.some((e) => e.type === 'technique' && e.technique === 'toe')).toBe(true);
    expect(r.on).toBeLessThan(r.off - 0.08);
  });

  it('statics: a hook pulls the hip toward the hold and pulls the body in (less keep-in for the hands)', () => {
    const h = [hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'), hold('s2', 0.2, 2.1, 'jug', 0.11, 'start'), hold('f1', -0.2, 0.95, 'jug', 0.08, 'foot'), hold('k', 0.55, 1.4, 'jug', 0.1, 'hand')];
    const prm = makeParams(45);
    const pose: Pose = { px: 0.05, py: 1.35, cx: 0.05, cy: 1.85 };
    const solve = (mode: number) => {
      const contacts: Contacts = h.map((x, i) => setContact(newContact(), x, i, false));
      contacts[3]!.mode = mode;
      const ev = evaluateStance(pose, contacts, prm, new StanceEval());
      return { hands: ev.load[0] + ev.load[1], keepIn: ev.normalHands, hooks: ev.normalHooks, fx: ev.fx[3], fy: ev.fy[3], ev };
    };
    const push = solve(FOOT_PUSH);
    const heel = solve(FOOT_HEEL);
    expect(push.hooks).toBe(0);
    expect(heel.hooks).toBeGreaterThan(0.05);
    expect(heel.keepIn).toBeLessThan(push.keepIn - 0.05);
    expect(heel.hands).toBeLessThan(push.hands - 0.05);
    // the heel's force on the body points from the hip toward the hold (up and out to the right)
    expect(heel.fx).toBeGreaterThan(0);
    expect(heel.fy).toBeGreaterThanOrEqual(0);
  });

  it('a flag counterbalances a barn-door: less swing, less tension, less pump', () => {
    const b = makeBoulder(
      [hold('s1', -0.35, 2.0, 'jug', 0.1, 'start'), hold('s2', -0.3, 1.7, 'jug', 0.1, 'start'), hold('f1', -0.3, 0.75, 'foot', 0.03, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')],
      { wallAngle: 15 },
    );
    const trial = (flagDx: number | null) => {
      const sim = new ClimberSim(b, { sweat: 0 });
      sim.start();
      run(sim, 1);
      const hip = sim.getState().limbs.RF.anchor;
      const ev: SimEvent[] = [];
      if (flagDx !== null) {
        sim.beginDrag('RF');
        for (let k = 0; k < 20; k++) {
          sim.dragTo('RF', { x: hip.x + flagDx, y: hip.y + (flagDx < 0 ? -0.4 : 0.05) });
          run(sim, 1 / 60, ev);
        }
        for (const e of sim.endDrag('RF')) ev.push(e);
      }
      // the body hangs off to the right of a column of contacts on the left: the door opens
      sim.setHipTarget({ x: 0.1, y: sim.getState().pelvis.y });
      run(sim, 2, ev);
      const s = sim.getState();
      const yaw = Math.abs(s.bodyYaw);
      const tension = s.tension;
      const p0 = s.pump;
      run(sim, 15, ev);
      return { yaw, tension, pump: sim.getState().pump - p0, mode: s.limbs.RF.footMode, ev };
    };
    const none = trial(null);
    const outside = trial(0.65);
    const back = trial(-0.45);
    expect(none.mode).toBeUndefined();
    expect(outside.mode).toBe('flag');
    expect(back.mode).toBe('flag');
    expect(outside.ev.some((e) => e.type === 'technique' && e.technique === 'flag')).toBe(true);
    for (const f of [outside, back]) {
      expect(f.yaw).toBeLessThan(none.yaw * 0.6);
      expect(f.tension).toBeLessThan(none.tension - 0.3);
      expect(f.pump).toBeLessThan(none.pump - 0.03);
    }
  });

  it('a drop knee on a sidepull foothold brings the hips to the wall and unloads the hands', () => {
    const trial = (angleDeg: number) => {
      const b = makeBoulder(
        [hold('s1', -0.2, 2.0, 'jug', 0.11, 'start'), hold('s2', 0.2, 2.0, 'jug', 0.11, 'start'), hold('f1', -0.2, 0.9, 'edge', 0.06, 'foot'), hold('f2', 0.2, 0.9, 'edge', 0.06, 'foot'), hold('k', 0.42, 1.05, 'edge', 0.07, 'foot', angleDeg), hold('t', 0, 4.1, 'jug', 0.12, 'top')],
        { wallAngle: 20 },
      );
      const sim = new ClimberSim(b, { sweat: 0 });
      sim.start();
      run(sim, 1);
      const ev = moveLimb(sim, 'RF', 'k');
      run(sim, 2, ev);
      const s = sim.getState();
      return { mode: s.limbs.RF.footMode, depth: s.pelvisDepth, hands: handLoad(sim), ev };
    };
    const drop = trial(0); // faces away from the body: the foot presses out against it
    const plain = trial(-90); // the same spot, a plain foothold
    expect(drop.mode).toBe('drop');
    expect(plain.mode).toBe('edge');
    expect(drop.ev.some((e) => e.type === 'technique' && e.technique === 'drop')).toBe(true);
    expect(drop.depth).toBeLessThan(plain.depth - 0.03);
    expect(drop.hands).toBeLessThan(plain.hands - 0.02);
  });

  it('feet on holds report edge / smear; a dragged foot reports no mode', () => {
    const sim = new ClimberSim(makeBoulder([hold('s1', -0.2, 1.6, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.6, 'jug', 0.1, 'start'), hold('f1', -0.22, 0.45, 'edge', 0.07, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')]));
    sim.start();
    run(sim, 0.5);
    const s = sim.getState();
    expect(s.limbs.LF.footMode).toBe('edge');
    expect(s.limbs.RF.footMode).toBe(s.limbs.RF.smearing ? 'smear' : 'edge');
    sim.beginDrag('LF');
    run(sim, 0.1);
    expect(sim.getState().limbs.LF.footMode).toBeUndefined();
    expect(sim.getState().limbs.LH.footMode).toBeUndefined();
  });
});

// ═══════════════════════════════ deadpoints + dynos ═══════════════════════════════

describe('deadpoints and dynos (research §2.5, §6.6)', () => {
  const deadpointWall = (target: HoldDef): BoulderDef =>
    makeBoulder([hold('s1', -0.2, 2.0, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.9, 'jug', 0.1, 'start'), hold('f1', -0.2, 0.9, 'jug', 0.08, 'foot'), hold('f2', 0.2, 0.9, 'jug', 0.08, 'foot'), target, hold('t', 0, 4.1, 'jug', 0.12, 'top')]);
  /** Climber crouched (hips pulled 0.2 m down) under a hold the right hand can't reach statically. */
  const crouched = (target: HoldDef): ClimberSim => {
    const sim = new ClimberSim(deadpointWall(target), { sweat: 0 });
    sim.start();
    run(sim, 1);
    sim.setHipTarget({ x: 0, y: sim.getState().pelvis.y - 0.2 });
    run(sim, 1);
    expect(sim.reachableHolds('RH')).not.toContain(target.id);
    return sim;
  };
  const fly = (sim: ClimberSim, secs: number, ev: SimEvent[]): { at: Record<string, number> } => {
    const at: Record<string, number> = {};
    for (let k = 0, t = 0; k < secs * 120; k++, t += 1 / 120)
      for (const e of sim.step(1 / 120)) {
        ev.push(e);
        if (!(e.type in at)) at[e.type] = t;
      }
    return { at };
  };

  it('a deadpoint throws the body on an arc and catches the hold just before the apex; feet and the other hand stay on', () => {
    const sim = crouched(hold('h1', 0.25, 2.85, 'jug', 0.1, 'hand'));
    const p0 = sim.getState().limbs.RH.pump!;
    const start = sim.dyno('RH', 'h1', 1);
    expect(start.map((e) => e.type)).toEqual(['release', 'dyno-start']);
    const ds = start[1];
    expect(ds.type === 'dyno-start' && ds.kind).toBe('deadpoint');
    let s = sim.getState();
    expect(s.airborne).toBe(true);
    expect(s.phase).toBe('climbing');
    expect(s.flight?.limbs).toEqual(['RH']);
    expect(s.limbs.RH.flying).toBe(true);
    expect(s.limbs.RH.flightTarget).toBe('h1');
    expect(s.velocity.y).toBeGreaterThan(1);
    const ev: SimEvent[] = [];
    const { at } = fly(sim, 1, ev);
    const c = ev.find((e) => e.type === 'dyno-catch');
    expect(c && c.type === 'dyno-catch' && c.limbs).toEqual(['RH']);
    // research [37]: the catch comes just before the apex (window −150 … +50 ms; the game allows +100 ms)
    expect(c && c.type === 'dyno-catch' && c.timing).toBeGreaterThan(-0.15);
    expect(c && c.type === 'dyno-catch' && c.timing).toBeLessThan(0.1);
    expect(at.grab).toBe(at['dyno-catch']);
    expect(at['dyno-catch']).toBeGreaterThan(0.08);
    expect(at['dyno-catch']).toBeLessThan(0.45);
    s = sim.getState();
    expect(s.airborne).toBe(false);
    expect(s.flight).toBeNull();
    expect([s.limbs.LH.holdId, s.limbs.RH.holdId, s.limbs.LF.holdId, s.limbs.RF.holdId]).toEqual(['s1', 'h1', 'f1', 'f2']);
    expect(s.limbs.RH.flying).toBe(false);
    // the throw and the catch cost forearm
    expect(s.limbs.RH.pump!).toBeGreaterThan(p0 + 0.003);
    expect(ev.some((e) => e.type === 'fall' || e.type === 'slip')).toBe(false);
  });

  it('a timid throw falls short; the deadpoint falls back onto the hold it left', () => {
    const sim = crouched(hold('h1', 0.25, 2.9, 'jug', 0.1, 'hand'));
    sim.dyno('RH', 'h1', 0.6);
    const ev: SimEvent[] = [];
    fly(sim, 1, ev);
    const miss = ev.find((e) => e.type === 'dyno-miss');
    expect(miss && miss.type === 'dyno-miss' && miss.reason).toBe('short');
    const ret = ev[ev.indexOf(miss!) + 1];
    expect(ret).toEqual({ type: 'return', limb: 'RH', holdId: 's2' });
    expect(sim.getState().phase).toBe('climbing');
    expect(sim.getState().limbs.RH.holdId).toBe('s2');
  });

  it('a hold too poor for the catch rips off (the catch load is 1.1–1.6 BW, not the static load)', () => {
    // a big throw at a crimp: the feet cut, the arm has to stop the whole body
    const sim = new ClimberSim(deadpointWall(hold('c1', 0.25, 3.0, 'crimp', 0.03, 'hand')), { sweat: 0 });
    sim.start();
    run(sim, 1);
    const start = sim.dyno('RH', 'c1', 1);
    expect(start.filter((e) => e.type === 'release').map((e) => e.type === 'release' && e.limb)).toEqual(['RH', 'LF', 'RF']);
    const ev: SimEvent[] = [];
    fly(sim, 1, ev);
    const miss = ev.find((e) => e.type === 'dyno-miss');
    expect(miss && miss.type === 'dyno-miss' && miss.reason).toBe('ripped');
    expect(ev.some((e) => e.type === 'dyno-catch')).toBe(false);
  });

  it('a double-hand dyno from a crouch: all four limbs leave, the flight outlasts the old no-hands grace, both hands catch', () => {
    const b = makeBoulder([hold('s1', -0.2, 1.7, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.7, 'jug', 0.1, 'start'), hold('f1', -0.2, 0.85, 'jug', 0.08, 'foot'), hold('f2', 0.2, 0.85, 'jug', 0.08, 'foot'), hold('t', 0, 3.2, 'jug', 0.12, 'top')]);
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    run(sim, 1);
    const pump0 = sim.getState().pump;
    const start = sim.dyno('both', 't', 1);
    expect(start.filter((e) => e.type === 'release')).toHaveLength(4);
    const ds = start.find((e) => e.type === 'dyno-start');
    expect(ds && ds.type === 'dyno-start' && ds.kind).toBe('dyno');
    const ev: SimEvent[] = [];
    const { at } = fly(sim, 2, ev);
    // research §6.6: ≈0.3 s with no hands on for a 0.5 m rise; the old 0.28 s grace would have dropped it
    expect(at['dyno-catch']).toBeGreaterThan(SIM.noHandsGrace);
    expect(at['dyno-catch']).toBeLessThan(0.5);
    const c = ev.find((e) => e.type === 'dyno-catch');
    expect(c && c.type === 'dyno-catch' && c.limbs).toEqual(['LH', 'RH']);
    expect(ev.some((e) => e.type === 'fall')).toBe(false);
    run(sim, GAME.topHold + 0.3, ev);
    expect(sim.getState().phase).toBe('topped');
    // dynos are expensive: both forearms paid for the launch and the catch
    expect(sim.getState().limbs.LH.pump!).toBeGreaterThan(pump0 + 0.03);
  });

  it('a double dyno that falls short is a fall (no hands left)', () => {
    const b = makeBoulder([hold('s1', -0.2, 1.7, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.7, 'jug', 0.1, 'start'), hold('f1', -0.2, 0.85, 'jug', 0.08, 'foot'), hold('f2', 0.2, 0.85, 'jug', 0.08, 'foot'), hold('t', 0, 3.2, 'jug', 0.12, 'top')]);
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    run(sim, 1);
    sim.dyno('both', 't', 0.65);
    const ev: SimEvent[] = [];
    fly(sim, 2, ev);
    const types = ev.map((e) => e.type);
    expect(types.indexOf('dyno-miss')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('fall')).toBeGreaterThan(types.indexOf('dyno-miss'));
    const fall = ev.find((e) => e.type === 'fall');
    expect(fall && fall.type === 'fall' && fall.reason).toBe('no-hands');
  });

  it('endDrag with a committed flick throws; a plain release keeps the old behaviour', () => {
    const target = hold('h1', 0.25, 2.85, 'jug', 0.1, 'hand');
    const flick = (velocity?: { x: number; y: number }): SimEvent[] => {
      const sim = crouched(target);
      expect(sim.beginDrag('RH')).toBe(true);
      for (let k = 0; k < 3; k++) {
        sim.dragTo('RH', { x: 0.25, y: 2.82 });
        sim.step(1 / 60);
      }
      const pv = sim.dynoCandidate('RH', { x: 0.25, y: 2.82 });
      expect(pv).toEqual({ holdId: 'h1', kind: 'deadpoint', rise: expect.any(Number), feasible: true });
      return sim.endDrag('RH', velocity ? { velocity } : undefined);
    };
    expect(flick({ x: 0.2, y: 3.2 }).map((e) => e.type)).toEqual(['dyno-start']);
    expect(flick({ x: 0, y: 0.3 }).map((e) => e.type)).toEqual(['return']); // no commitment
    expect(flick().map((e) => e.type)).toEqual(['return']);
  });

  it('a hand held past its reach stretches the body, but the throw is judged from the stance it left: the preview neither shrinks nor lies', () => {
    const trial = (y: number) => {
      const h = hold('h1', 0.25, y, 'jug', 0.1, 'hand');
      const sim = new ClimberSim(deadpointWall(h), { sweat: 0 });
      sim.start();
      run(sim, 1);
      const p0 = sim.getState().pelvis.y;
      expect(sim.beginDrag('RH')).toBe(true);
      sim.dragTo('RH', h);
      run(sim, 0.1);
      const early = sim.dynoCandidate('RH', h)!;
      for (let k = 0; k < 48; k++) {
        sim.dragTo('RH', h);
        sim.step(1 / 60);
      }
      const stretch = sim.getState().pelvis.y - p0;
      const late = sim.dynoCandidate('RH', h)!;
      const from = sim.getState().limbs.RH.pos;
      const l = Math.hypot(h.x - from.x, h.y - from.y);
      const v = SIM.dynoFlickRef;
      const ev = sim.endDrag('RH', { velocity: { x: ((h.x - from.x) / l) * v, y: ((h.y - from.y) / l) * v } });
      run(sim, 1.2, ev);
      return { stretch, early, late, caught: ev.some((e) => e.type === 'dyno-catch'), short: ev.some((e) => e.type === 'dyno-miss' && e.reason === 'short') };
    };
    const near = trial(3.15);
    // the body followed the reaching hand up (reach pull) …
    expect(near.stretch).toBeGreaterThan(0.1);
    // … but the preview still measures the throw from the stance: the rise doesn't shrink with the stretch
    expect(near.late.holdId).toBe('h1');
    expect(near.late.rise).toBeGreaterThan(near.early.rise - 0.03);
    expect(near.late.rise).toBeGreaterThan(0.3);
    // and it is honest: feasible → caught
    expect(near.late.feasible).toBe(true);
    expect(near.caught).toBe(true);
    // too far from this stance: TOO FAR, and the throw does fall short
    const far = trial(3.35);
    expect(far.late.feasible).toBe(false);
    expect(far.short).toBe(true);
  });

  it('flick power spreads over real phone flicks (≈4–12 m/s): 6 m/s is an ideal throw, harder flicks commit more', () => {
    const target = hold('h1', 0.25, 3.0, 'jug', 0.1, 'hand');
    const power = (speed: number): number => {
      const sim = crouched(target);
      expect(sim.beginDrag('RH')).toBe(true);
      sim.dragTo('RH', { x: 0.25, y: 2.97 });
      sim.step(1 / 60);
      const from = sim.getState().limbs.RH.pos;
      const l = Math.hypot(0.25 - from.x, 2.97 - from.y);
      const ev = sim.endDrag('RH', { velocity: { x: ((0.25 - from.x) / l) * speed, y: ((2.97 - from.y) / l) * speed } });
      const s = ev.find((e) => e.type === 'dyno-start');
      return s && s.type === 'dyno-start' ? s.power : NaN;
    };
    const p4 = power(4);
    const p6 = power(6);
    const p8 = power(8);
    expect(p4).toBeGreaterThan(0.6);
    expect(p4).toBeLessThan(p6);
    expect(p6).toBeCloseTo(1, 1);
    expect(p8).toBeGreaterThan(p6);
    expect(p8).toBeLessThan(1.4);
    expect(power(20)).toBe(1.4);
  });

  it('dynoCandidate flags a throw the climber cannot make', () => {
    const sim = new ClimberSim(deadpointWall(hold('far', 0.3, 3.85, 'jug', 0.1, 'hand')), { sweat: 0 });
    sim.start();
    run(sim, 1);
    const pv = sim.dynoCandidate('RH', { x: 0.3, y: 3.85 });
    expect(pv?.holdId).toBe('far');
    expect(pv?.feasible).toBe(false);
    expect(sim.dynoCandidate('RH', { x: 0.2, y: 1.9 })).toBeNull(); // in static reach: just grab it
  });
});

// ═══════════════════════════════ the bot manages its body ═══════════════════════════════

describe('BetaBot chalks and shakes out like a climber', () => {
  it('shakes out a pumped forearm on a good stance, re-grips and still sends', { timeout: 60_000 }, () => {
    const climb = (manageBody: boolean) => {
      const sim = new ClimberSim(tutorialBoulder(), { sweat: 0 });
      sim.start();
      run(sim, 0.5);
      sim.forearm('LH').spend(0.7); // arrive at the problem with a pumped left forearm
      const r = autoClimb(sim, { maxTime: 120, manageBody });
      expect(r.sent, r.bot.log.join('; ')).toBe(true);
      return { shakes: r.bot.shakes, pump: sim.getState().limbs.LH.pump! };
    };
    const managed = climb(true);
    const plain = climb(false);
    expect(managed.shakes).toBeGreaterThanOrEqual(1);
    expect(plain.shakes).toBe(0);
    expect(managed.pump).toBeLessThan(plain.pump - 0.15);
  });

  it('chalks on lead as the chalk wears off and sends the route', { timeout: 120_000 }, () => {
    const b = generateRopeRoute({ seed: 4242, grade: 4 });
    const sim = new ClimberSim(b);
    const rope = new RopeSystem(b);
    const bot = new BetaBot(sim);
    sim.start();
    let events: SimEvent[] = [];
    let minFric = 1;
    for (let t = 0; t < 400 && !bot.done && !bot.failed; t += 1 / 60) {
      bot.update(1 / 60, events);
      events = sim.step(1 / 60);
      for (const e of events) if (e.type === 'clip-done') rope.clip(e.quickdrawId);
      const s = sim.getState();
      minFric = Math.min(minFric, s.limbs.LH.friction!, s.limbs.RH.friction!);
      if (s.phase === 'climbing') {
        const c = rope.catchParams(s.pelvis);
        sim.setRope(c.anchor, c.length);
      }
    }
    expect(sim.getState().phase, bot.log.join('; ')).toBe('topped');
    expect(bot.chalks).toBeGreaterThan(4);
    expect(sim.getStats().chalkUps).toBe(bot.chalks);
    expect(minFric).toBeLessThan(BOT.chalkBelow);
  });
});

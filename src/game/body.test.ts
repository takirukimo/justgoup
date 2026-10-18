// Phase B body model, checked against docs/climbing-research.md (§2.4 grip, §2.6 pump, §2.7 chalk,
// §2.2/§2.3 foot techniques, §2.5 dynos). Each block names the research anchor it reproduces.

import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import type { BoulderDef, HoldDef, LimbId } from '../core/types';
import { SIM } from '../config/tuning';
import { ClimberSim, type ClimberSimOptions } from './climber-sim';
import { Forearm } from './forearm';
import { edgeDepthFactor, frictionCapFactor, handGripBase, pumpCapFactor } from './holds';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

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

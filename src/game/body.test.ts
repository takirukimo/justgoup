// Phase B body model, checked against docs/climbing-research.md (§2.4 grip, §2.6 pump, §2.7 chalk,
// §2.2/§2.3 foot techniques, §2.5 dynos). Each block names the research anchor it reproduces.

import { describe, expect, it } from 'vitest';
import type { HoldDef } from '../core/types';
import { SIM } from '../config/tuning';
import { ClimberSim } from './climber-sim';
import { edgeDepthFactor, frictionCapFactor, handGripBase } from './holds';
import { hold, makeBoulder, run } from './test-helpers';

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

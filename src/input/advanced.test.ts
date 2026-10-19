// The advanced-move previews (input/advanced.ts) say exactly what the sim then does on release.

import { describe, expect, it } from 'vitest';
import type { BoulderDef, HoldDef } from '../core/types';
import { ClimberSim } from '../game/climber-sim';
import { hold, makeBoulder, moveLimb, run } from '../game/test-helpers';
import { batHangAt, camAt, fig4HandFor, figure4At, figure4Possible, forearmSegment, segDist } from './advanced';

/** A cave: vertical to 1.3 m, then a flat roof; feet on roof edges a1 / a2, with opposing faces b1 / b2 a foot-length out. */
function cave(partners: boolean): BoulderDef {
  return makeBoulder(
    [
      hold('s1', -0.25, 2.25, 'jug', 0.11, 'start'),
      hold('s2', 0.25, 2.25, 'jug', 0.11, 'start'),
      hold('a1', -0.3, 1.6, 'edge', 0.07, 'foot', -90),
      hold('a2', 0.3, 1.6, 'edge', 0.07, 'foot', -90),
      ...(partners ? [hold('b1', -0.3, 1.84, 'edge', 0.07, 'foot', 90), hold('b2', 0.3, 1.84, 'edge', 0.07, 'foot', 90)] : []),
      hold('t', 0, 4.1, 'jug', 0.12, 'top'),
    ],
    { wallAngle: 90, height: 4.5, profile: [{ y0: 0, angle: 0 }, { y0: 1.3, angle: 90 }], startFeet: { LF: 'a1', RF: 'a2' } },
  );
}

const vertical = (extra: HoldDef[] = []): BoulderDef =>
  makeBoulder(
    [hold('s1', -0.2, 2.0, 'jug', 0.11, 'start'), hold('s2', 0.25, 2.05, 'jug', 0.11, 'start'), hold('f1', -0.25, 0.75, 'jug', 0.08, 'foot'), hold('f2', 0.3, 0.8, 'jug', 0.08, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top'), ...extra],
    { startFeet: { LF: 'f1', RF: 'f2' } },
  );

const byId = (b: BoulderDef, id: string): HoldDef => b.holds.find((h) => h.id === id)!;

describe('heel-toe cam preview', () => {
  it('previews the cam the sim then sets (same opposing hold), and nothing where there is no partner', () => {
    const b = cave(true);
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    run(sim, 1);
    sim.beginDrag('LF');
    run(sim, 0.05);
    const pv = camAt(sim, sim.getState(), 'LF', byId(b, 'a1'));
    expect(pv?.hold?.id).toBe('b1');
    sim.endDrag('LF');
    moveLimb(sim, 'LF', 'a1');
    run(sim, 0.5);
    expect(sim.getState().limbs.LF.footMode).toBe('cam');
    expect(sim.getState().limbs.LF.camHoldId).toBe('b1');

    const plain = new ClimberSim(cave(false), { sweat: 0 });
    plain.start();
    run(plain, 1);
    expect(camAt(plain, plain.getState(), 'LF', byId(plain.boulder, 'a1'))).toBeNull();
    // and never on a vertical wall
    const v = new ClimberSim(vertical(), { sweat: 0 });
    v.start();
    run(v, 1);
    expect(camAt(v, v.getState(), 'RF', byId(v.boulder, 'f2'))).toBeNull();
  });
});

describe('bat hang preview', () => {
  it('the last hand let go over nothing while both feet cam on a roof previews BAT HANG, and the sim hangs', () => {
    const sim = new ClimberSim(cave(true), { sweat: 0 });
    sim.start();
    run(sim, 1);
    // both hands on: letting go of one is not the last hand
    expect(batHangAt(sim, sim.getState(), 'RH', true)).toBe(false);
    sim.beginDrag('LH');
    sim.dragTo('LH', { x: -0.6, y: 2.0 });
    run(sim, 0.1);
    sim.beginDrag('RH');
    sim.dragTo('RH', { x: 0.6, y: 2.0 });
    run(sim, 0.1);
    const st = sim.getState();
    expect(batHangAt(sim, st, 'RH', true)).toBe(true);
    // a release that grabs / chalks / throws is not a bat hang
    expect(batHangAt(sim, st, 'RH', false)).toBe(false);
    sim.endDrag('RH');
    expect(sim.getState().special).toBe('bat');
  });

  it('weak feet or a vertical wall never preview a bat hang', () => {
    const toe = new ClimberSim(cave(false), { sweat: 0 });
    toe.start();
    run(toe, 1);
    toe.beginDrag('LH');
    run(toe, 0.1);
    expect(batHangAt(toe, toe.getState(), 'RH', true)).toBe(false);
  });
});

describe('figure 4 preview', () => {
  it('a foot dropped onto the opposite forearm previews the figure 4 the sim then does', () => {
    const b = vertical([hold('hi', 0.3, 3.05, 'jug', 0.08, 'hand')]);
    const sim = new ClimberSim(b, { sweat: 0 });
    sim.start();
    run(sim, 1);
    expect(fig4HandFor('RF')).toBe('LH');
    expect(figure4Possible(sim, sim.getState(), 'RF')).toBe(true);
    const a = { x: 0, y: 0 };
    const e = { x: 0, y: 0 };
    expect(forearmSegment(sim.getState(), 'LH', a, e)).toBe(true);
    const mid = { x: (a.x + e.x) / 2, y: (a.y + e.y) / 2 };
    expect(segDist(mid, a, e)).toBeLessThan(1e-9);
    sim.beginDrag('RF');
    sim.dragTo('RF', mid);
    run(sim, 0.05);
    const st = sim.getState();
    expect(figure4At(sim, st, 'RF', mid, null)).toBe('LH');
    // far from the arm: nothing
    expect(figure4At(sim, st, 'RF', { x: 0.6, y: 0.5 }, null)).toBeNull();
    // on the hand's own hold above the grip it is a foot on that hold, not a figure 4
    expect(figure4At(sim, st, 'RF', { x: a.x, y: a.y + 0.05 }, byId(b, 's1'))).toBeNull();
    sim.endDrag('RF');
    run(sim, 1);
    expect(sim.getState().special).toBe('figure4');
    expect(sim.getState().figure4?.hand).toBe('LH');
  });

  it('no figure 4 off a sloper', () => {
    const b = vertical();
    const sloper = makeBoulder(
      b.holds.map((h) => (h.id === 's1' ? { ...h, type: 'sloper' as const } : h)),
      { startFeet: { LF: 'f1', RF: 'f2' } },
    );
    const sim = new ClimberSim(sloper, { sweat: 0 });
    sim.start();
    run(sim, 1);
    expect(figure4Possible(sim, sim.getState(), 'RF')).toBe(false);
  });
});

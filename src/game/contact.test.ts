// Contact geometry (owner feedback v0.2: hands and feet must sit ON the drawn hold): where the sim puts a
// hand / foot on each hold type, and the surface normal + grip direction it hands the renderer.

import { describe, expect, it } from 'vitest';
import type { HoldDef } from '../core/types';
import { ClimberSim } from './climber-sim';
import { contactFrame, contactPoint, type ContactFrame } from './holds';
import { hold, makeBoulder, run } from './test-helpers';

const F = (): ContactFrame => ({ nx: 0, ny: 0, nz: 0, gx: 0, gy: 0 });
const len3 = (f: ContactFrame): number => Math.hypot(f.nx, f.ny, f.nz);

describe('contact points on the drawn hold', () => {
  it('hands grip the grip side (shelf / cavity / dome / hole), feet stand on the top', () => {
    const at = (h: HoldDef, li: number): number => contactPoint(h, li, false, { x: 0, y: 0 }).y - h.y;
    // classic holds (good direction down): the contact is above the centre, inside the drawn footprint
    const edge = hold('e', 0, 2, 'edge', 0.065, 'hand');
    expect(at(edge, 0) / edge.size).toBeCloseTo(0.32, 3); // the shelf (render edgeProfile: lip at 0.30)
    const chip = hold('c', 0, 1, 'foot', 0.028, 'foot');
    // a shoe stands on a chip's upper shoulder (its front is flat), not a third of the way up its face
    expect(at(chip, 2) / chip.size).toBeGreaterThan(0.5);
    expect(at(chip, 2) / chip.size).toBeLessThan(0.82);
    const pocket = hold('p', 0, 2, 'pocket', 0.05, 'hand');
    // the fingers go into the hole (≈ 0.05–0.25 · size), not onto its rim
    expect(at(pocket, 0) / pocket.size).toBeLessThan(0.26);
    const jug = hold('j', 0, 1, 'jug', 0.1, 'hand');
    // fingers and toe go into a jug's bucket behind the lip (its cavity: 0.31–0.44 · size)
    expect(at(jug, 1) / jug.size).toBeGreaterThanOrEqual(0.31);
    expect(at(jug, 3) / jug.size).toBeLessThanOrEqual(0.44);
    // a sidepull (good direction to the right): the grip side is the left face, for hands and feet
    const side = hold('s', 0, 1.5, 'edge', 0.065, 'hand', 0);
    expect(contactPoint(side, 1, false, { x: 0, y: 0 }).x).toBeLessThan(0);
    expect(contactPoint(side, 3, false, { x: 0, y: 0 }).x).toBeLessThan(0);
  });
});

describe('contact frame (surface normal + grip direction)', () => {
  it('hands: the shelf faces up, incut edges tilt into the wall, slopers out; the grip side is the body side', () => {
    const incut = { ...hold('e', 0, 2, 'edge', 0.065, 'hand'), lipAngle: 15 };
    const f = contactFrame(incut, 0, null, null, F());
    expect(len3(f)).toBeCloseTo(1, 6);
    expect(f.ny).toBeGreaterThan(0.95);
    expect(f.nz).toBeLessThan(-0.2);
    expect(f.gx).toBeCloseTo(0, 6);
    expect(f.gy).toBeCloseTo(-1, 6); // the hand pulls from below
    const sloper = contactFrame(hold('s', 0, 2, 'sloper', 0.1, 'hand'), 1, null, null, F());
    expect(sloper.nz).toBeGreaterThan(0.45);
    expect(sloper.ny).toBeGreaterThan(0.6);
    const jug = contactFrame(hold('j', 0, 2, 'jug', 0.1, 'hand'), 0, null, null, F());
    expect(jug.nz).toBeLessThan(0); // the cavity behind the lip hooks
    // an undercling: the gripped surface faces down, the hand pulls from above
    const under = contactFrame(hold('u', 0, 1.2, 'edge', 0.065, 'hand', 90), 0, null, null, F());
    expect(under.ny).toBeLessThan(-0.95);
    expect(under.gy).toBeCloseTo(1, 6);
  });

  it('feet: a standing foot presses on the top from above; hooks wrap the far face; a smear presses on the wall', () => {
    const top = contactFrame(hold('f', 0, 0.6, 'edge', 0.06, 'foot'), 2, 'edge', null, F());
    expect(top.ny).toBeGreaterThan(0.95);
    expect(top.nz).toBeGreaterThan(0);
    expect(top.gy).toBeCloseTo(1, 6); // the sole comes from above
    const chip = contactFrame(hold('c', 0, 0.6, 'foot', 0.028, 'foot'), 3, 'edge', null, F());
    expect(chip.nz).toBeGreaterThan(0.4); // the chip's domed shoulder
    // a heel hook on a hold whose good side faces the hip (left of it): the heel wraps its far (right) face
    const heel = contactFrame(hold('k', 0.6, 1.4, 'jug', 0.1, 'hand', 180), 3, 'heel', null, F());
    expect(heel.nx).toBeGreaterThan(0.9);
    expect(heel.gx).toBeCloseTo(-1, 6);
    const smear = contactFrame(null, 2, 'smear', null, F());
    expect([smear.nx, smear.ny, smear.nz]).toEqual([0, 0, 1]);
  });

  it('a hold bolted onto a volume is tilted with the volume face', () => {
    // the generator's mount: the volume's centre behind the hold on its far side (here above a jug)
    const vol: HoldDef = { ...hold('v', 0, 2.2, 'volume', 0.3, 'foot'), angle: -Math.PI / 2 };
    const h: HoldDef = { ...hold('h', 0, 2.08, 'edge', 0.065, 'hand'), onVolume: 'v' };
    const flat = contactFrame(h, 0, null, null, F());
    const mounted = contactFrame(h, 0, null, vol, F());
    expect(len3(mounted)).toBeCloseTo(1, 6);
    // the volume's lower face looks down at the climber: the shelf's normal tilts out of the wall
    expect(mounted.nz).toBeGreaterThan(flat.nz + 0.25);
    expect(mounted.ny).toBeGreaterThan(0.6);
    expect(Math.hypot(mounted.gx, mounted.gy)).toBeCloseTo(1, 6);
  });

  it('the live sim reports the contact, its normal and grip side while attached (null while free)', () => {
    const sim = new ClimberSim(
      makeBoulder([hold('s1', -0.2, 1.8, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.8, 'edge', 0.065, 'start'), hold('f1', -0.22, 0.55, 'foot', 0.028, 'foot'), hold('f2', 0.22, 0.55, 'edge', 0.06, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')]),
    );
    sim.start();
    run(sim, 0.5);
    const s = sim.getState();
    for (const id of ['LH', 'RH', 'LF', 'RF'] as const) {
      const L = s.limbs[id];
      expect(L.holdId, id).not.toBeNull();
      const h = sim.boulder.holds.find((x) => x.id === L.holdId)!;
      const cp = contactPoint(h, ['LH', 'RH', 'LF', 'RF'].indexOf(id), false, { x: 0, y: 0 });
      expect(L.contactPos!.x).toBeCloseTo(cp.x, 6);
      expect(L.contactPos!.y).toBeCloseTo(cp.y, 6);
      // the endpoint has settled onto it
      expect(Math.hypot(L.pos.x - cp.x, L.pos.y - cp.y)).toBeLessThan(0.005);
      expect(Math.hypot(L.contactNormal!.x, L.contactNormal!.y, L.contactNormal!.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(L.gripDir!.x, L.gripDir!.y)).toBeCloseTo(1, 6);
    }
    expect(s.limbs.LH.gripDir!.y).toBeLessThan(-0.9);
    expect(s.limbs.LF.gripDir!.y).toBeGreaterThan(0.9);
    sim.beginDrag('RH');
    run(sim, 0.1);
    expect(sim.getState().limbs.RH.contactPos).toBeNull();
    expect(sim.getState().limbs.RH.contactNormal).toBeNull();
    expect(sim.getState().limbs.RH.gripDir).toBeNull();
  });
});

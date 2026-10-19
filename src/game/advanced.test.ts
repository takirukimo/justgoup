// Advanced moves (owner: "also add bathang / heel toe cam and the figur 4 move"; shared sim spec): heel-toe
// cams, bat hangs and figure 4s — statics, inference, state, 'technique' / 'special-end' events.

import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import type { BoulderDef, HoldDef } from '../core/types';
import { ClimberSim } from './climber-sim';
import type { Forearm } from './forearm';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

/** A cave: vertical to 1.3 m, then a flat roof. Hands on two roof jugs, feet on two roof edges `a1` / `a2`. */
function cave(partners: boolean, extra: HoldDef[] = []): BoulderDef {
  return makeBoulder(
    [
      hold('s1', -0.25, 2.25, 'jug', 0.11, 'start'),
      hold('s2', 0.25, 2.25, 'jug', 0.11, 'start'),
      hold('a1', -0.3, 1.6, 'edge', 0.07, 'foot', -90),
      hold('a2', 0.3, 1.6, 'edge', 0.07, 'foot', -90),
      // the opposing faces a foot-length further out: a heel-toe cam between a and b
      ...(partners ? [hold('b1', -0.3, 1.84, 'edge', 0.07, 'foot', 90), hold('b2', 0.3, 1.84, 'edge', 0.07, 'foot', 90)] : []),
      hold('t', 0, 4.1, 'jug', 0.12, 'top'),
      ...extra,
    ],
    { wallAngle: 90, height: 4.5, profile: [{ y0: 0, angle: 0 }, { y0: 1.3, angle: 90 }], startFeet: { LF: 'a1', RF: 'a2' } },
  );
}

const handLoad = (sim: ClimberSim): number => sim.getState().limbs.LH.load + sim.getState().limbs.RH.load;
const quiet = (ev: SimEvent[]): boolean => !ev.some((e) => e.type === 'slip' || e.type === 'fall' || e.type === 'overload');

describe('heel-toe cam', () => {
  it('a foot between two opposing holds cams on a roof and holds better than standing / toe-pulling on one', () => {
    const cam = new ClimberSim(cave(true), { sweat: 0 });
    const plain = new ClimberSim(cave(false), { sweat: 0 });
    cam.start();
    plain.start();
    const ev = run(cam, 3);
    run(plain, 3);
    const s = cam.getState();
    expect(s.limbs.LF.footMode).toBe('cam');
    expect(s.limbs.RF.footMode).toBe('cam');
    expect(s.limbs.LF.camHoldId).toBe('b1');
    expect(s.limbs.RF.camHoldId).toBe('b2');
    expect(s.limbs.LF.camPos).toBeTruthy();
    expect(plain.getState().limbs.LF.footMode).not.toBe('cam');
    expect(quiet(ev)).toBe(true);
    // the cams carry more of the body: less on the hands, a less strained stance
    expect(handLoad(cam)).toBeLessThan(handLoad(plain) - 0.08);
    expect(s.tension).toBeLessThan(plain.getState().tension - 0.1);
  });

  it("placing a foot into the cam is a 'technique' event, and the cam survives the body moving around it", () => {
    const sim = new ClimberSim(cave(true), { sweat: 0 });
    sim.start();
    run(sim, 1);
    const ev: SimEvent[] = [];
    moveLimb(sim, 'LF', 'a1', ev);
    run(sim, 1, ev);
    expect(ev.some((e) => e.type === 'technique' && e.technique === 'cam' && e.limb === 'LF')).toBe(true);
    expect(sim.getState().limbs.LF.camHoldId).toBe('b1');
    // a hand move shifts the hips: the feet stay jammed
    moveLimb(sim, 'RH', 's1', ev);
    run(sim, 1.5, ev);
    expect(sim.getState().limbs.LF.footMode).toBe('cam');
    expect(sim.getState().limbs.RF.footMode).toBe('cam');
  });
});

describe('bat hang', () => {
  it('with both feet cammed on a roof the climber lets go and hangs inverted; the arms recover fast', () => {
    const sim = new ClimberSim(cave(true), { sweat: 0 });
    sim.start();
    run(sim, 1);
    expect(sim.canBatHang()).toBe(true);
    // pumped arms
    const fa = (sim as unknown as { forearms: Forearm[] }).forearms;
    fa[0].spend(0.6);
    fa[1].spend(0.6);
    const ctrl = new ClimberSim(cave(true), { sweat: 0 });
    ctrl.start();
    run(ctrl, 1);
    (ctrl as unknown as { forearms: Forearm[] }).forearms.forEach((f) => f.spend(0.6));
    const pump0 = sim.forearm('LH').pump;
    const ev: SimEvent[] = [];
    expect(sim.batHang()).toBe(true);
    run(sim, 10, ev);
    run(ctrl, 10);
    const s = sim.getState();
    expect(ev.some((e) => e.type === 'technique' && e.technique === 'bat')).toBe(true);
    expect(s.special).toBe('bat');
    expect(s.bat!.blend).toBe(1);
    expect(s.bat!.fatigue).toBeGreaterThan(0.1);
    expect(s.limbs.LH.holdId).toBeNull();
    expect(s.limbs.RH.holdId).toBeNull();
    // inverted: the chest hangs below the pelvis along the surface and further out of the wall
    expect(s.chest.y).toBeLessThan(s.pelvis.y + 0.2);
    expect(s.chestDepth!).toBeGreaterThan(s.pelvisDepth + 0.3);
    expect(quiet(ev)).toBe(true);
    // the hanging arms shake out much faster than on the holds
    expect(sim.forearm('LH').pump).toBeLessThan(pump0 - 0.12);
    expect(sim.forearm('LH').pump).toBeLessThan(ctrl.forearm('LH').pump - 0.1);
  });

  it('a grab sits up out of it into a normal stance', () => {
    const sim = new ClimberSim(cave(true), { sweat: 0 });
    sim.start();
    run(sim, 1);
    sim.batHang();
    run(sim, 3);
    const ev = moveLimb(sim, 'RH', 's2');
    run(sim, 1.5, ev);
    const s = sim.getState();
    expect(ev.some((e) => e.type === 'special-end' && e.special === 'bat' && e.reason === 'grab')).toBe(true);
    expect(s.special ?? null).toBeNull();
    expect(s.limbs.RH.holdId).toBe('s2');
    expect(s.chest.y).toBeGreaterThan(s.pelvis.y + 0.3);
    expect(s.limbs.LF.footMode).toBe('cam');
    expect(quiet(ev)).toBe(true);
    expect(s.tension).toBeLessThan(1);
    // and the climb goes on
    const ev2 = moveLimb(sim, 'LH', 's1');
    run(sim, 1, ev2);
    expect(sim.getState().limbs.LH.holdId).toBe('s1');
    expect(quiet(ev2)).toBe(true);
  });

  it('letting go of the last hand over nothing while cammed falls back into a bat hang instead of off the wall', () => {
    const sim = new ClimberSim(cave(true), { sweat: 0 });
    sim.start();
    run(sim, 1);
    const ev: SimEvent[] = [];
    // the left hand is up in the air (reaching), the right one lets go over blank wall
    sim.beginDrag('LH');
    sim.dragTo('LH', { x: -0.6, y: 2.0 });
    run(sim, 0.1, ev);
    sim.beginDrag('RH');
    sim.dragTo('RH', { x: 0.6, y: 2.0 });
    run(sim, 0.1, ev);
    for (const e of sim.endDrag('RH')) ev.push(e);
    expect(sim.getState().special).toBe('bat');
    run(sim, 0.3, ev);
    for (const e of sim.endDrag('LH')) ev.push(e);
    run(sim, 2, ev);
    const s = sim.getState();
    expect(s.special).toBe('bat');
    expect(s.phase).toBe('climbing');
    expect(s.limbs.LH.shakingOut && s.limbs.RH.shakingOut).toBe(true);
    expect(ev.some((e) => e.type === 'fall')).toBe(false);
    expect(ev.filter((e) => e.type === 'technique' && e.technique === 'bat').length).toBe(1);
    // holding both hands off with no drop at all does the same after a moment
    const b = new ClimberSim(cave(true), { sweat: 0 });
    b.start();
    run(b, 1);
    b.beginDrag('LH');
    b.beginDrag('RH');
    const ev2 = run(b, 1.5);
    expect(b.getState().special).toBe('bat');
    expect(ev2.some((e) => e.type === 'fall')).toBe(false);
  });

  it('the hang tires the core: held too long the feet let go', () => {
    const sim = new ClimberSim(cave(true), { sweat: 0 });
    sim.start();
    run(sim, 1);
    sim.batHang();
    const ev = run(sim, 40);
    expect(ev.some((e) => e.type === 'special-end' && e.special === 'bat' && e.reason === 'fatigue')).toBe(true);
    expect(ev.some((e) => e.type === 'fall')).toBe(true);
  });

  it('weak feet (two toe hooks on edges, or a vertical wall) cannot bat-hang', () => {
    const toe = new ClimberSim(cave(false), { sweat: 0 });
    toe.start();
    run(toe, 1);
    expect(toe.canBatHang()).toBe(false);
    expect(toe.batHang()).toBe(false);
    expect(toe.getState().limbs.LH.holdId).toBe('s1');
    const v = new ClimberSim(
      makeBoulder([hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'), hold('s2', 0.25, 2.15, 'jug', 0.11, 'start'), hold('f1', -0.25, 0.75, 'jug', 0.08, 'foot'), hold('f2', 0.3, 0.8, 'jug', 0.08, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top')], {
        startFeet: { LF: 'f1', RF: 'f2' },
      }),
      { sweat: 0 },
    );
    v.start();
    run(v, 1);
    expect(v.canBatHang()).toBe(false);
  });
});

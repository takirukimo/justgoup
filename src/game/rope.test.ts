import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import { GAME } from '../config/tuning';
import { ClimberSim } from './climber-sim';
import { RopeSystem, ROPE } from './rope';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

/** A short lead problem: start low, a quickdraw just above the right shoulder, anchor at the top. */
function leadWall(startY: number) {
  return makeBoulder(
    [
      hold('s1', -0.2, startY, 'jug', 0.1, 'start'),
      hold('s2', 0.2, startY, 'jug', 0.1, 'start'),
      hold('f1', -0.22, startY - 1.15, 'jug', 0.08, 'foot'),
      hold('f2', 0.22, startY - 1.15, 'jug', 0.08, 'foot'),
      hold('h1', 0.3, startY + 0.45, 'jug', 0.1, 'hand'),
      hold('t', 0, 14.25, 'jug', 0.12, 'top'),
    ],
    {
      mode: 'rope',
      width: 4.4,
      height: 15,
      quickdraws: [
        { id: 'q0', x: 0.32, y: startY + 0.5 },
        { id: 'q1', x: 0.0, y: 14.67 },
      ],
    },
  );
}

describe('RopeSystem', () => {
  it('tracks clips in wall order and builds the rope path', () => {
    const b = leadWall(1.6);
    const rope = new RopeSystem(b);
    expect(rope.lastClip()).toBeNull();
    expect(rope.nextClip()?.id).toBe('q0');
    const harness = { x: 0, y: 1.2 };
    // before the first clip the rope runs straight to the belayer
    expect(rope.ropePath(harness)).toHaveLength(2);
    expect(rope.fallOutcome(harness).groundFall).toBe(true);
    rope.clip('q0');
    rope.clip('q0');
    expect(rope.clipped).toEqual(['q0']);
    expect(rope.isClipped('q0')).toBe(true);
    expect(rope.nextClip()?.id).toBe('q1');
    const path = rope.ropePath(harness);
    expect(path).toHaveLength(3);
    expect(path[1].y).toBeCloseTo(b.quickdraws![0].y - 0.15);
    const c = rope.catchParams(harness);
    expect(c.anchor.y).toBeCloseTo(b.quickdraws![0].y - 0.15);
    expect(c.length).toBeGreaterThan(Math.hypot(harness.x - c.anchor.x, harness.y - c.anchor.y) + ROPE.slack - 1e-9);
    expect(rope.belayer().y).toBe(0);
  });

  it('predicts big falls above the last clip and ground falls low down', () => {
    // low: 2.5 m above a clip at 2 m decks
    const low = new RopeSystem(leadWall(1.6));
    low.clip('q0');
    expect(low.fallOutcome({ x: 0, y: 1.5 }).groundFall).toBe(true);
    expect(low.fallOutcome({ x: 0, y: 4.6 }).groundFall).toBe(true);
    // high: the same 2.5 m run-out at 8.5 m is a clean (big) catch
    const b = leadWall(8);
    const rope = new RopeSystem(b);
    rope.clip('q0');
    const clipY = b.quickdraws![0].y - 0.15;
    const high = rope.fallOutcome({ x: 0, y: clipY + 2.5 });
    expect(high.groundFall).toBe(false);
    // ≈ 2 × height above the clip + slack + stretch
    expect(high.fallDistance).toBeGreaterThan(2 * 2.5);
    expect(high.catchY).toBeLessThan(clipY - 2.5);
  });
});

describe('ClimberSim — rope', () => {
  it('clips a quickdraw: busy hand, clip-done, back on its hold', () => {
    const b = leadWall(1.6);
    const sim = new ClimberSim(b);
    sim.start();
    run(sim, 0.5);
    const q = b.quickdraws![0];
    const cp = { x: q.x, y: q.y - 0.15 };
    expect(sim.beginDrag('RH')).toBe(true);
    for (let k = 0; k < 30; k++) {
      sim.dragTo('RH', cp);
      run(sim, 1 / 60);
    }
    expect(sim.clipCandidate('RH', cp)?.id).toBe('q0');
    const ev: SimEvent[] = sim.endDrag('RH');
    expect(ev).toEqual([{ type: 'clip', quickdrawId: 'q0' }]);
    expect(sim.getState().limbs.RH.busy).toBe(true);
    expect(sim.getState().limbs.RH.holdId).toBeNull();
    run(sim, GAME.clipTime * 0.5, ev);
    expect(ev.some((e) => e.type === 'clip-done')).toBe(false);
    expect(sim.beginDrag('RH')).toBe(false);
    run(sim, GAME.clipTime, ev);
    expect(ev).toContainEqual({ type: 'clip-done', quickdrawId: 'q0', limb: 'RH' });
    expect(ev).toContainEqual({ type: 'return', limb: 'RH', holdId: 's2' });
    const s = sim.getState();
    expect(s.clipped).toEqual(['q0']);
    expect(s.limbs.RH.busy).toBe(false);
    expect(s.limbs.RH.holdId).toBe('s2');
    expect(ev.some((e) => e.type === 'fall')).toBe(false);
  });

  it('a fall above a clip is caught by the rope; a fall before it decks', () => {
    // high up: the climber starts 8 m up with a quickdraw clipped just above
    const high = leadWall(8);
    const sim = new ClimberSim(high);
    const rope = new RopeSystem(high);
    rope.clip('q0');
    sim.start();
    run(sim, 0.5);
    const startY = sim.getState().pelvis.y;
    const c = rope.catchParams(sim.getState().pelvis);
    sim.setRope(c.anchor, c.length);
    sim.forceFall();
    const ev = run(sim, 4);
    const caught = ev.find((e) => e.type === 'caught');
    expect(caught).toBeDefined();
    expect(ev.some((e) => e.type === 'ground-fall' || e.type === 'land')).toBe(false);
    expect(sim.getState().phase).toBe('hanging');
    if (caught && caught.type === 'caught') {
      expect(caught.fallDistance).toBeGreaterThan(0.3);
      expect(caught.fallDistance).toBeLessThan(4);
    }
    expect(sim.getState().pelvis.y).toBeLessThan(startY);
    // back on the wall near the last clip
    sim.respawn({});
    const s = sim.getState();
    expect(s.phase).toBe('climbing');
    expect(s.limbs.LH.holdId && s.limbs.RH.holdId).toBeTruthy();
    expect(s.tension).toBeLessThan(0.8);

    // low down, nothing clipped: the rope can't catch → ground fall, then land
    const low = leadWall(1.6);
    const sim2 = new ClimberSim(low);
    const rope2 = new RopeSystem(low);
    sim2.start();
    run(sim2, 0.3);
    const c2 = rope2.catchParams(sim2.getState().pelvis);
    sim2.setRope(c2.anchor, c2.length);
    sim2.forceFall();
    const ev2 = run(sim2, 3);
    const types = ev2.map((e) => e.type);
    expect(types).toContain('ground-fall');
    expect(types).toContain('land');
    expect(types).not.toContain('caught');
    expect(types.indexOf('ground-fall')).toBeLessThan(types.indexOf('land'));
    expect(sim2.getState().phase).toBe('landed');
  });

  it('clipping the anchor tops the route', () => {
    const b = makeBoulder(
      [
        hold('s1', -0.2, 13.9, 'jug', 0.1, 'start'),
        hold('s2', 0.2, 13.9, 'jug', 0.1, 'start'),
        hold('f1', -0.22, 12.75, 'jug', 0.08, 'foot'),
        hold('f2', 0.22, 12.75, 'jug', 0.08, 'foot'),
        hold('t', 0, 14.25, 'jug', 0.12, 'top'),
      ],
      { mode: 'rope', width: 4.4, height: 15, quickdraws: [{ id: 'anchor', x: 0.25, y: 14.4 }] },
    );
    const sim = new ClimberSim(b);
    sim.start();
    const ev = moveLimb(sim, 'RH', 't');
    // matching the top hold alone does not top a lead route
    run(sim, 1, ev);
    expect(sim.getState().phase).toBe('climbing');
    const q = b.quickdraws![0];
    const cp = { x: q.x, y: q.y - 0.15 };
    sim.beginDrag('LH');
    for (let k = 0; k < 20 || (k < 90 && !sim.clipCandidate('LH', cp)); k++) {
      sim.dragTo('LH', cp);
      run(sim, 1 / 60, ev);
    }
    for (const e of sim.endDrag('LH')) ev.push(e);
    run(sim, GAME.clipTime + 0.2, ev);
    expect(ev.some((e) => e.type === 'clip')).toBe(true);
    expect(ev.some((e) => e.type === 'top')).toBe(true);
    expect(sim.getState().phase).toBe('topped');
  });
});

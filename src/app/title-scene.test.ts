import { describe, expect, it } from 'vitest';
import type { GuideState } from '../core/contracts';
import { usableByFoot, usableByHand } from '../game/holds';
import { TitleScene, titleWall } from './title-scene';
import type { Services } from './services';

function fakeServices(): { svc: Services; guides: (GuideState | null)[] } {
  const guides: (GuideState | null)[] = [];
  const renderer = {
    loadBoulder: () => undefined,
    setRope: () => undefined,
    setHoldHighlights: () => undefined,
    setClimberVisible: () => undefined,
    setCameraFocusHint: () => undefined,
    updateClimber: () => undefined,
    setGuide: (g: GuideState | null) => guides.push(g ? { ...g, lookAt: g.lookAt ? { ...g.lookAt } : undefined } : null),
    setTitleFraming: () => undefined,
    setCameraMode: () => undefined,
    fx: { chalkPuff: () => undefined, dust: () => undefined, confetti: () => undefined, cameraShake: () => undefined },
  };
  return { svc: { renderer } as unknown as Services, guides };
}

describe('home screen backdrop (owner: steady up on the wall, Steini looking up)', () => {
  it('the demo wall has a jug band ~3 m up with footholds below, and a real route', () => {
    const b = titleWall();
    const jugs = b.holds.filter((h) => h.type === 'jug' && h.role === 'hand');
    expect(jugs.length).toBeGreaterThanOrEqual(5);
    for (const j of jugs) expect(j.y).toBeGreaterThan(2.9);
    expect(b.holds.filter((h) => h.role === 'foot' && usableByFoot(h)).length).toBeGreaterThanOrEqual(5);
    expect(b.holds.some((h) => h.role === 'top')).toBe(true);
    expect(b.holds.filter((h) => h.role === 'start' && usableByHand(h)).length).toBe(2);
    expect(new Set(b.holds.map((h) => h.id)).size).toBe(b.holds.length);
    expect(b.holds.filter((h) => h.role === 'deco').length).toBeGreaterThan(20);
    // same wall every launch
    expect(JSON.stringify(titleWall())).toBe(JSON.stringify(b));
  });

  it('hangs steady ~2 m up for two minutes with slow idle moves and never falls', () => {
    const { svc, guides } = fakeServices();
    const scene = new TitleScene(svc);
    scene.enter('title');
    const sim = scene.currentSim;
    const dt = 1 / 30;
    let changes = 0;
    let prev = '';
    let minPelvis = Infinity;
    let maxTension = 0;
    const phases = new Set<string>();
    for (let i = 0; i < 120 * 30; i++) {
      scene.frame(dt);
      const st = scene.state;
      phases.add(st.phase);
      minPelvis = Math.min(minPelvis, st.pelvis.y);
      maxTension = Math.max(maxTension, st.tension);
      const key = ['LH', 'RH', 'LF', 'RF'].map((l) => st.limbs[l as 'LH'].holdId ?? '-').join(',');
      if (key !== prev && !key.includes('-')) {
        if (prev) changes++;
        prev = key;
      }
    }
    expect([...phases]).toEqual(['climbing']);
    expect(minPelvis).toBeGreaterThan(1.6);
    expect(sim.getStats().maxPump).toBeLessThan(0.15);
    expect(maxTension).toBeLessThan(0.8);
    // one move every 8–12 s over 120 s: about 8–14 stance changes (chalk-ups don't change holds)
    expect(changes).toBeGreaterThanOrEqual(6);
    expect(changes).toBeLessThanOrEqual(15);
    // every planned move lands on its hold (the weight shift makes each reach comfortable)
    expect(scene.moveStats.missed).toBe(0);
    expect(scene.moveStats.done).toBe(changes);
    // Steini looks at the climber's chest
    const g = guides.filter((x): x is GuideState => !!x).pop()!;
    expect(g.depth).toBeGreaterThan(0.8);
    const st = scene.state;
    expect(Math.hypot(g.lookAt!.x - st.chest.x, g.lookAt!.y - st.chest.y)).toBeLessThan(0.3);
    expect(scene.guideState).not.toBeNull();
  });

  it('the locker close-up hides Steini', () => {
    const { svc, guides } = fakeServices();
    const scene = new TitleScene(svc);
    scene.enter('locker');
    expect(guides[guides.length - 1]).toBeNull();
    expect(scene.guideState).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { createDraft } from './model';
import { cleanWall, fitLength, matchPreset, mergePanel, moveFold, presetWall, setWall, splitPanel, wallHeightOf, wallOf, wallStyleOf, wallTypeOf, WALL, WALL_PRESETS } from './walls';

describe('wall presets', () => {
  it('every preset stands under the ceiling, reads as its type and matches itself', () => {
    for (const p of WALL_PRESETS) {
      const d = createDraft();
      setWall(d, presetWall(p));
      const w = wallOf(d);
      expect(wallHeightOf(w), p.id).toBeLessThanOrEqual(WALL.ceiling + 1e-6);
      expect(wallTypeOf(w), p.id).toBe(p.type);
      expect(matchPreset(w)?.id, p.id).toBe(p.id);
      if (p.spec.length > 1) expect(d.profile?.length).toBe(p.spec.length);
      else expect(d.profile).toBeUndefined();
    }
  });
});

describe('panel editing', () => {
  const base = () => presetWall(WALL_PRESETS.find((p) => p.id === 'overhang-25')!);

  it('splits a panel at its middle with a visible fold and merges it back', () => {
    const w = cleanWall(base());
    const r = splitPanel(w, 1)!;
    expect(r.index).toBe(2);
    expect(r.wall.panels.length).toBe(3);
    expect(r.wall.panels[2].angle).toBe(40);
    expect(r.wall.panels[2].y0).toBeGreaterThan(r.wall.panels[1].y0 + WALL.minPanel - 1e-9);
    const m = mergePanel(r.wall, 2)!;
    expect(m.index).toBe(1);
    expect(m.wall.panels).toEqual(w.panels);
    // a kicker too short to split; a one-panel wall cannot merge
    expect(splitPanel(w, 0)).toBeNull();
    expect(mergePanel({ panels: [{ y0: 0, angle: 10 }], length: 4.5 }, 0)).toBeNull();
  });

  it('merging down to one panel clamps it into the flat range', () => {
    const m = mergePanel({ panels: [{ y0: 0, angle: 0 }, { y0: 1, angle: 70 }], length: 4.5 }, 0)!;
    expect(m.wall.panels).toEqual([{ y0: 0, angle: 45 }]);
    expect(m.clamped).toBe(true);
  });

  it('moves folds on a 5 cm grid, a panel away from their neighbours', () => {
    const w = cleanWall(presetWall(WALL_PRESETS.find((p) => p.id === 'cave')!));
    const a = moveFold(w, 2, 1.234);
    expect(a.panels[2].y0).toBeCloseTo(1.25, 6);
    const lo = moveFold(w, 2, -5);
    expect(lo.panels[2].y0).toBeCloseTo(w.panels[1].y0 + WALL.minPanel, 6);
    const hi = moveFold(w, 2, 99);
    expect(hi.panels[2].y0).toBeLessThanOrEqual(w.panels[3].y0 - WALL.minPanel + 1e-9);
    // the first panel has no fold below it
    expect(moveFold(w, 0, 1)).toEqual(w);
  });

  it('a wall never stands taller than the gym: the top is shortened under the ceiling', () => {
    const tall = cleanWall({ panels: [{ y0: 0, angle: 0 }, { y0: 0.3, angle: 45 }], length: 5.9 });
    expect(tall.length).toBeCloseTo(5.9, 6);
    // the steep panel brought back to vertical would stand 5.9 m tall
    const flat = cleanWall({ panels: [{ y0: 0, angle: 0 }, { y0: 0.3, angle: 2 }], length: 5.9 });
    expect(wallHeightOf(flat)).toBeLessThanOrEqual(WALL.ceiling + 1e-6);
    expect(flat.length).toBeLessThan(4.6);
    expect(fitLength([{ y0: 0, angle: 0 }], 6)).toBeLessThanOrEqual(WALL.ceiling + 1e-6);
  });

  it('reads the wall style off the panels (a short kicker does not make it mixed)', () => {
    const st = (panels: [number, number][], length = 4.5) => wallStyleOf({ panels: panels.map(([y0, angle]) => ({ y0, angle })), length });
    expect(st([[0, -10]])).toBe('slab');
    expect(st([[0, 3]])).toBe('vertical');
    expect(st([[0, 0], [0.3, 25]])).toBe('overhang');
    expect(st([[0, 0], [0.3, 30], [1.9, 85], [4.1, 20]], 4.7)).toBe('cave');
    expect(st([[0, 0], [1.6, 35], [2.8, -5]], 4.6)).toBe('mixed');
    expect(st([[0, -8], [2, 18]])).toBe('mixed');
  });
});

describe('drafts on edited walls', () => {
  it('setWall writes profile / wallAngle / height / style, keeping a route style', () => {
    const d = createDraft();
    setWall(d, presetWall(WALL_PRESETS.find((p) => p.id === 'cave')!));
    expect(d.profile?.length).toBe(4);
    expect(d.wallAngle).toBe(85);
    expect(d.height).toBeCloseTo(4.7, 6);
    expect(d.style).toBe('cave');
    d.style = 'dyno';
    setWall(d, presetWall(WALL_PRESETS.find((p) => p.id === 'slab')!));
    expect(d.profile).toBeUndefined();
    expect(d.wallAngle).toBe(-8);
    expect(d.style).toBe('dyno');
    setWall(d, presetWall(WALL_PRESETS.find((p) => p.id === 'slab')!), { restyle: true });
    expect(d.style).toBe('slab');
  });
});

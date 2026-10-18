import { describe, expect, it } from 'vitest';
import type { BoulderDef, HoldDef } from '../core/types';
import { generateBoulder } from '../game/generator';
import {
  cloneDraft,
  createDraft,
  draftFromSample,
  draftHash,
  EDITOR,
  findSpot,
  fits,
  footprint,
  History,
  holdBounds,
  loadStoredDraft,
  makeHold,
  normalizeDraft,
  saveStoredDraft,
  snapToTnut,
  tnutsNear,
  validateDraft,
} from './model';

const onLattice = (p: { x: number; y: number }): boolean => {
  const r = (p.y - EDITOR.tnutRow0) / EDITOR.tnutStep;
  if (Math.abs(r - Math.round(r)) > 1e-6) return false;
  const off = Math.abs(Math.round(r)) % 2 === 1 ? EDITOR.tnutStep / 2 : 0;
  const k = (p.x - off) / EDITOR.tnutStep;
  return Math.abs(k - Math.round(k)) < 1e-6;
};

/** A small, valid problem: 2 starts, 4 hands, top, 2 feet. */
function validDraft(): BoulderDef {
  const d = createDraft({ wallAngle: 5, seed: 42 });
  const add = (type: HoldDef['type'], role: HoldDef['role'] & string, x: number, y: number): void => {
    d.holds.push(makeHold(type, role === 'deco' ? 'hand' : role, snapToTnut({ x, y }), d.color));
  };
  add('jug', 'start', -0.3, 1.5);
  add('jug', 'start', 0.3, 1.5);
  add('jug', 'hand', -0.2, 2.1);
  add('edge', 'hand', 0.4, 2.5);
  add('jug', 'hand', -0.3, 3.0);
  add('pinch', 'hand', 0.2, 3.5);
  add('jug', 'top', 0, 4.05);
  add('foot', 'foot', -0.3, 0.7);
  add('foot', 'foot', 0.35, 0.9);
  return d;
}

describe('T-nut snapping', () => {
  it('snaps to the staggered 0.2 m lattice (0.1 m checkerboard)', () => {
    for (let i = 0; i < 200; i++) {
      const p = { x: -2 + ((i * 37) % 400) / 100, y: 0.3 + ((i * 53) % 400) / 100 };
      const s = snapToTnut(p);
      expect(onLattice(s)).toBe(true);
      // nearest: no lattice point is closer
      const best = tnutsNear(p, 0.3)[0];
      expect(Math.hypot(s.x - p.x, s.y - p.y)).toBeLessThanOrEqual(Math.hypot(best.x - p.x, best.y - p.y) + 1e-9);
    }
  });

  it('lists nearby T-nuts nearest first', () => {
    const near = tnutsNear({ x: 0.03, y: 1.52 }, 0.25);
    expect(near.length).toBeGreaterThan(3);
    for (let i = 1; i < near.length; i++) {
      const a = Math.hypot(near[i - 1].x - 0.03, near[i - 1].y - 1.52);
      const b = Math.hypot(near[i].x - 0.03, near[i].y - 1.52);
      expect(a).toBeLessThanOrEqual(b + 1e-9);
    }
    expect(near.every(onLattice)).toBe(true);
  });
});

describe('placement rules', () => {
  it('findSpot never overlaps and stays inside the wall (snap + free)', () => {
    const d = validDraft();
    for (const snap of [true, false]) {
      for (const h of d.holds) {
        const spot = findSpot(d, { x: h.x + 0.02, y: h.y + 0.01 }, { type: 'jug', size: 0.1 }, { snap, searchRadius: 0.3 });
        if (!spot) continue;
        expect(fits(d, spot, { type: 'jug', size: 0.1 })).toBe(true);
        if (snap) expect(onLattice(spot)).toBe(true);
      }
    }
  });

  it('clamps placements to the climbable panel', () => {
    const d = createDraft();
    const spot = findSpot(d, { x: 5, y: -1 }, { type: 'volume', size: 0.4 }, { snap: false, searchRadius: 10 });
    expect(spot).not.toBeNull();
    const bd = holdBounds(d, { type: 'volume', size: 0.4 });
    expect(spot!.x).toBeLessThanOrEqual(bd.x1 + 1e-9);
    expect(spot!.y).toBeGreaterThanOrEqual(bd.y0 - 1e-9);
  });

  it('refuses a spot when nothing fits nearby', () => {
    const d = createDraft();
    d.holds.push(makeHold('volume', 'foot', { x: 0, y: 2 }, d.color, 0.45));
    expect(findSpot(d, { x: 0, y: 2 }, { type: 'volume', size: 0.45 }, { snap: true, searchRadius: 0.1 })).toBeNull();
  });
});

describe('validation', () => {
  it('a complete problem passes every rule', () => {
    const c = validateDraft(validDraft());
    expect(c.ok).toBe(true);
    expect(c.headline).toBe('');
    expect(c.counts).toMatchObject({ start: 2, top: 1, hands: 7, feet: 2, total: 9 });
  });

  it('reports missing / extra starts and tops, too few hands, low tops', () => {
    expect(validateDraft(createDraft()).rules.filter((r) => !r.ok).map((r) => r.id)).toEqual(['start', 'top', 'hands']);

    const three = validDraft();
    three.holds.push(makeHold('jug', 'start', { x: 1.2, y: 1.5 }, three.color));
    expect(validateDraft(three).headline).toMatch(/max 2 start/i);

    const twoTops = validDraft();
    twoTops.holds.push(makeHold('jug', 'top', { x: 1.2, y: 3.9 }, twoTops.color));
    expect(validateDraft(twoTops).rules.find((r) => r.id === 'top')!.ok).toBe(false);

    const few = validDraft();
    few.holds = few.holds.filter((h) => h.role !== 'hand');
    const c = validateDraft(few);
    expect(c.rules.find((r) => r.id === 'hands')!.ok).toBe(false);
    expect(c.short).toMatch(/need 1 hand/i);

    const low = validDraft();
    low.holds.find((h) => h.role === 'top')!.y = 1.7;
    expect(validateDraft(low).rules.find((r) => r.id === 'rise')!.ok).toBe(false);
  });

  it('flags overlapping and off-wall holds', () => {
    const d = validDraft();
    const a = d.holds[2];
    d.holds.push({ ...makeHold('jug', 'hand', { x: a.x + 0.02, y: a.y }, d.color), id: 'dup' });
    d.holds.push({ ...makeHold('jug', 'hand', { x: 0, y: 3 }, d.color), id: 'off', x: d.width / 2 - 0.01 });
    const c = validateDraft(d);
    expect(c.ok).toBe(false);
    expect(c.flagged.has('dup')).toBe(true);
    expect(c.flagged.has(a.id)).toBe(true);
    expect(c.flagged.has('off')).toBe(true);
  });

  it('generated samples become valid, deco-free drafts', () => {
    for (const grade of [0, 2, 4, 6]) {
      for (const seed of [11, 202, 3003]) {
        const b = generateBoulder({ seed: seed + grade, grade });
        const d = draftFromSample(b);
        expect(d.holds.some((h) => h.role === 'deco')).toBe(false);
        expect(d.mode).toBe('boulder');
        expect(d.wallAngle).toBeGreaterThanOrEqual(EDITOR.angleMin);
        const c = validateDraft(d);
        expect(c.ok, `${grade}/${seed}: ${c.headline}`).toBe(true);
      }
    }
  });
});

describe('drafts', () => {
  it('normalizeDraft sanitises untrusted input', () => {
    const raw = {
      ...createDraft(),
      mode: 'rope',
      wallAngle: 80,
      quickdraws: [{ id: 'q', x: 0, y: 3 }],
      holds: [
        { id: 'a', x: 0, y: 1, type: 'jug', size: 0.1, angle: 0, role: 'hand', color: '#000000', seed: 3 },
        { id: 'a', x: 0.5, y: 1, type: 'foot', size: 0.03, angle: 0, role: 'start', color: '#000000', seed: 4 },
        { id: 'b', x: 0.4, y: 2, type: 'jug', size: 0.1, angle: 0, role: 'deco', color: '#000000', seed: 5 },
        { id: 'c', x: Number.NaN, y: 2, type: 'jug', size: 0.1, angle: 0, role: 'hand', color: '#000000', seed: 6 },
        { id: 'd', x: 0, y: 2, type: 'bogus', size: 0.1, angle: 0, role: 'hand', color: '#000000', seed: 7 },
      ],
    } as unknown as BoulderDef;
    const d = normalizeDraft(raw);
    expect(d.mode).toBe('boulder');
    expect(d.wallAngle).toBe(EDITOR.angleMax);
    expect(d.quickdraws).toBeUndefined();
    expect(d.holds.length).toBe(2);
    expect(new Set(d.holds.map((h) => h.id)).size).toBe(2);
    expect(d.holds[1].role).toBe('foot'); // foot chips are feet only
    expect(d.holds.every((h) => h.color === d.color)).toBe(true);
  });

  it('draftHash tracks content, not name or id', () => {
    const d = validDraft();
    const h0 = draftHash(d);
    expect(draftHash(cloneDraft(d))).toBe(h0);
    expect(draftHash({ ...cloneDraft(d), name: 'Other', id: 'x', grade: 9 })).toBe(h0);
    const moved = cloneDraft(d);
    moved.holds[0].x += 0.1;
    expect(draftHash(moved)).not.toBe(h0);
    const steeper = cloneDraft(d);
    steeper.wallAngle += 5;
    expect(draftHash(steeper)).not.toBe(h0);
  });

  it('history undoes, redoes and discards', () => {
    const d = validDraft();
    const h = new History();
    const before = draftHash(d);
    h.checkpoint(d);
    d.holds.pop();
    d.wallAngle = 30;
    const after = draftHash(d);
    expect(h.undo(d)).toBe(true);
    expect(draftHash(d)).toBe(before);
    expect(h.redo(d)).toBe(true);
    expect(draftHash(d)).toBe(after);
    h.checkpoint(d);
    h.discard();
    expect(h.undo(d)).toBe(true);
    expect(draftHash(d)).toBe(before);
    expect(h.canRedo).toBe(true);
    h.discardRedo();
    expect(h.canRedo).toBe(false);
  });

  it('persists through a Storage and survives garbage', () => {
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as Storage;
    const d = validDraft();
    expect(saveStoredDraft({ v: 1, draft: d, passed: draftHash(d), published: null, savedAt: 1 }, store)).toBe(true);
    const back = loadStoredDraft(store)!;
    expect(draftHash(back.draft)).toBe(draftHash(d));
    expect(back.passed).toBe(draftHash(d));
    mem.set(EDITOR.storageKey, '{not json');
    expect(loadStoredDraft(store)).toBeNull();
    expect(loadStoredDraft(null)).toBeNull();
  });

  it('footprints scale with size and type', () => {
    expect(footprint({ type: 'edge', size: 0.06 })).toBeGreaterThan(footprint({ type: 'jug', size: 0.06 }));
    expect(footprint({ type: 'jug', size: 0.12 })).toBeCloseTo(2 * footprint({ type: 'jug', size: 0.06 }));
  });
});

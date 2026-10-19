import { describe, expect, it } from 'vitest';
import type { HoldDef } from '../core/types';
import { CATALOG, entryById, entryOf, extentOf, seedForVariant, sizeRange, variantOf } from './catalog';
import {
  capsuleGap,
  createDraft,
  draftHash,
  findSpot,
  fits,
  groupFits,
  insideDistance,
  makeHold,
  mountsOf,
  normalizeDraft,
  removeHold,
  setVolumeShapes,
  snapToTnut,
  transformVolume,
  validateDraft,
  volumeShape,
} from './model';
import { exactVolumeShape } from './shapes';

function withVolume(variant = 0, size = 0.36): { d: ReturnType<typeof createDraft>; vol: HoldDef } {
  const d = createDraft({ seed: 9 });
  const vol = makeHold('volume', 'foot', snapToTnut({ x: 0, y: 2.1 }), d.color, size, { seed: seedForVariant(variant) });
  d.holds.push(vol);
  return { d, vol };
}

describe('catalogue', () => {
  it('maps every product back to its own tile, volumes by geometry variant', () => {
    for (const e of CATALOG) {
      const h = makeHold(e.type, 'hand', { x: 0, y: 2 }, '#D54051', undefined, { shape: e.shape, fingers: e.fingers, seed: e.type === 'volume' ? seedForVariant(e.variant) : 7 });
      expect(entryOf(h).id, e.id).toBe(e.id);
      const r = sizeRange(h);
      expect(h.size).toBeGreaterThanOrEqual(r.min);
      expect(h.size).toBeLessThanOrEqual(r.max);
    }
    for (let v = 0; v < 6; v++) for (let k = 0; k < 20; k++) expect(variantOf(seedForVariant(v))).toBe(v);
    // products the generator makes without a tile of their own fall back to their type
    expect(entryOf({ type: 'edge', shape: 'dual-tex', seed: 3 }).id).toBe('edge');
    expect(entryOf({ type: 'pocket', fingers: 2, seed: 3 }).id).toBe('pocket');
  });

  it('footprints follow the real shapes: a rail is long and thin, a pinch tall', () => {
    const rail = extentOf({ type: 'edge', shape: 'rail', seed: 1 });
    expect(rail.hx / rail.hy).toBeGreaterThan(6);
    const pinch = extentOf({ type: 'pinch', seed: 1 });
    expect(pinch.hy).toBeGreaterThan(pinch.hx);
    // two rails side by side along their length collide, stacked 12 cm apart they don't
    const a = { type: 'edge' as const, shape: 'rail' as const, size: 0.065, angle: -Math.PI / 2, seed: 1 };
    expect(capsuleGap(a, { x: 0, y: 2 }, a, { x: 0.4, y: 2 })).toBeLessThan(0);
    expect(capsuleGap(a, { x: 0, y: 2 }, a, { x: 0, y: 2.12 })).toBeGreaterThan(0);
  });
});

describe('volumes and the holds bolted onto them', () => {
  it('a hold wanted on a volume face is bolted onto it, free of the T-nut grid, inside the face', () => {
    const { d, vol } = withVolume();
    const spot = findSpot(d, { x: vol.x + 0.033, y: vol.y + 0.071 }, { type: 'jug', size: 0.1 }, { snap: true });
    expect(spot?.onVolume).toBe(vol.id);
    expect(Math.hypot(spot!.x - vol.x - 0.033, spot!.y - vol.y - 0.071)).toBeLessThan(0.05);
    expect(insideDistance(volumeShape(vol).outline, spot!)).toBeGreaterThan(0);
    // the volume itself is not in the way of its own holds, but holds on it keep clear of each other
    d.holds.push(makeHold('jug', 'hand', spot!, d.color, 0.1, { onVolume: vol.id }));
    const second = findSpot(d, spot!, { type: 'jug', size: 0.1 }, { snap: true, searchRadius: 0.3 });
    expect(second?.onVolume).toBe(vol.id);
    expect(capsuleGap({ type: 'jug', size: 0.1 }, second!, { type: 'jug', size: 0.1 }, spot!)).toBeGreaterThan(0);
    expect(validateDraft(d).flagged.size).toBe(0);
    // a volume tool never bolts onto a volume
    expect(findSpot(d, vol, { type: 'volume', size: 0.3, seed: 6 }, { snap: true, searchRadius: 0.1 })).toBeNull();
  });

  it('a volume moves, turns and scales with its holds; removing it takes them along', () => {
    const { d, vol } = withVolume(2);
    const m = makeHold('edge', 'hand', { x: vol.x + 0.06, y: vol.y + 0.04 }, d.color, 0.06, { onVolume: vol.id });
    d.holds.push(m);
    const off = { x: m.x - vol.x, y: m.y - vol.y };
    expect(groupFits(d, vol, { x: 1.1, y: 3.1 })).toBe(true);
    transformVolume(d, vol.id, { x: 1.1, y: 3.1 });
    expect(m.x - vol.x).toBeCloseTo(off.x, 3);
    expect(m.y - vol.y).toBeCloseTo(off.y, 3);
    const a0 = m.angle;
    transformVolume(d, vol.id, { angle: vol.angle + Math.PI / 2 });
    expect(m.x - vol.x).toBeCloseTo(-off.y, 2);
    expect(m.y - vol.y).toBeCloseTo(off.x, 2);
    expect(Math.abs(Math.cos(m.angle - a0))).toBeLessThan(1e-3);
    transformVolume(d, vol.id, { size: vol.size * 1.5 });
    expect(Math.hypot(m.x - vol.x, m.y - vol.y)).toBeCloseTo(Math.hypot(off.x, off.y) * 1.5, 2);
    expect(validateDraft(d).flagged.size).toBe(0);
    // the group can't be moved onto another hold
    d.holds.push(makeHold('jug', 'hand', { x: -1.2, y: 1.3 }, d.color));
    expect(groupFits(d, vol, { x: -1.2, y: 1.3 })).toBe(false);
    expect(removeHold(d, vol.id).length).toBe(2);
    expect(d.holds.length).toBe(1);
  });

  it('flags a bolted-on hold that ends up off its volume, and keeps mounts through normalisation', () => {
    const { d, vol } = withVolume();
    const m = makeHold('jug', 'hand', { x: vol.x, y: vol.y + 0.05 }, d.color, 0.1, { onVolume: vol.id });
    d.holds.push(m);
    expect(fits(d, m, m, m.id)).toBe(true);
    const n = normalizeDraft(d);
    expect(n.holds.find((h) => h.id === m.id)?.onVolume).toBe(vol.id);
    expect(draftHash(n)).toBe(draftHash(d));
    m.x += 0.6;
    const c = validateDraft(d);
    expect(c.flagged.has(m.id)).toBe(true);
    expect(c.rules.find((r) => r.id === 'wall')!.short).toMatch(/volume/i);
    // a mount whose volume is gone becomes a wall hold
    const lone = normalizeDraft({ ...d, holds: d.holds.filter((h) => h.id !== vol.id) });
    expect(lone.holds[0].onVolume).toBeUndefined();
    expect(mountsOf(d, vol.id).length).toBe(1);
  });

  it('the draft hash sees product details and mounts (a test pass covers exactly what was climbed)', () => {
    const { d, vol } = withVolume();
    const e = makeHold('edge', 'hand', { x: 1, y: 3 }, d.color);
    d.holds.push(e);
    const h0 = draftHash(d);
    e.edgeDepthMm = 30;
    const h1 = draftHash(d);
    expect(h1).not.toBe(h0);
    e.lipAngle = 12;
    expect(draftHash(d)).not.toBe(h1);
    const m = makeHold('jug', 'hand', { x: vol.x, y: vol.y }, d.color, 0.1, { onVolume: vol.id });
    d.holds.push(m);
    const h2 = draftHash(d);
    delete m.onVolume;
    expect(draftHash(d)).not.toBe(h2);
  });
});

describe('exact volume shapes (the renderer geometry)', () => {
  it('every volume product has a convex base around its centre, faces above it and nothing outside', () => {
    for (const e of CATALOG.filter((x) => x.type === 'volume')) {
      const v = makeHold('volume', 'foot', { x: 0.4, y: 2.2 }, '#D54051', 0.3, { shape: e.shape, seed: seedForVariant(e.variant), angle: -1.2 });
      const s = exactVolumeShape(v)!;
      expect(s, e.id).not.toBeNull();
      expect(insideDistance(s.outline, v), e.id).toBeGreaterThan(0.03);
      expect(s.lift(v), e.id).toBeGreaterThan(0.05);
      expect(s.lift({ x: v.x + 1, y: v.y }), e.id).toBe(0);
      // the outline stays inside the catalogue's footprint extents
      const ex = extentOf(v);
      for (const p of s.outline) expect(Math.hypot(p.x - v.x, p.y - v.y)).toBeLessThanOrEqual(Math.hypot(ex.hx, ex.hy) * v.size + 1e-3);
    }
  });

  it('bolts holds where the exact shape has a face (the model uses the provider when installed)', () => {
    setVolumeShapes(exactVolumeShape);
    try {
      const { d, vol } = withVolume(5);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const want = { x: vol.x + Math.cos(a) * 0.1, y: vol.y + Math.sin(a) * 0.1 };
        const spot = findSpot(d, want, { type: 'crimp', size: 0.035 }, { snap: false, searchRadius: 0.3 });
        if (!spot?.onVolume) continue;
        expect(exactVolumeShape(vol)!.lift(spot)).toBeGreaterThan(0);
      }
    } finally {
      setVolumeShapes(null);
    }
  });

  it('the catalogue entry of a volume survives a reload', () => {
    const e = entryById('v-dome-dt')!;
    const v = makeHold('volume', 'foot', { x: 0, y: 2 }, '#D54051', 0.3, { shape: e.shape, seed: seedForVariant(e.variant) });
    expect(entryOf(normalizeDraft({ ...createDraft(), holds: [v] }).holds[0]).id).toBe('v-dome-dt');
  });
});

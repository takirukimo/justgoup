import { describe, expect, it } from 'vitest';
import { randomTip, TIPS, tipFor, wallTerrain } from './tips';

const OVERHANG_TIP = /overhang|steep|roof|hook your heel/i;
const SLAB_TIP = /slab/i;

describe('tips match the wall', () => {
  it('classifies the terrain from the angle, the profile and the style', () => {
    expect([...wallTerrain({ wallAngle: 0 })]).toEqual([]);
    expect(wallTerrain({ wallAngle: 30 }).has('steep')).toBe(true);
    expect(wallTerrain({ wallAngle: -10 }).has('slab')).toBe(true);
    const mixed = wallTerrain({ wallAngle: 45, profile: [{ y0: 0, angle: -8 }, { y0: 2, angle: 45 }] });
    expect(mixed.has('slab') && mixed.has('steep')).toBe(true);
    expect(wallTerrain({ wallAngle: 0, style: 'dyno' }).has('dyno')).toBe(true);
    expect(wallTerrain({ wallAngle: 0, style: 'cave' }).has('steep')).toBe(true);
  });

  it('never gives overhang tips on vertical walls or slabs, nor slab tips on overhangs', () => {
    for (let seed = 0; seed < 400; seed++) {
      expect(randomTip(seed, 'boulder', { wallAngle: 0 })).not.toMatch(OVERHANG_TIP);
      expect(randomTip(seed, 'boulder', { wallAngle: 0 })).not.toMatch(SLAB_TIP);
      expect(randomTip(seed, 'boulder', { wallAngle: -10, style: 'slab' })).not.toMatch(OVERHANG_TIP);
      expect(randomTip(seed, 'boulder', { wallAngle: 35, style: 'overhang' })).not.toMatch(SLAB_TIP);
      expect(randomTip(seed, 'rope', { wallAngle: 5 })).not.toMatch(OVERHANG_TIP);
      expect(tipFor('slip', seed, 'boulder', { wallAngle: -8 })).not.toMatch(OVERHANG_TIP);
      expect(tipFor('pump', seed, 'boulder', { wallAngle: 40 })).not.toMatch(SLAB_TIP);
      // no wall known: only tips that are true anywhere
      expect(randomTip(seed)).not.toMatch(OVERHANG_TIP);
    }
  });

  it('does offer the terrain tips where they fit', () => {
    const steep = new Set(Array.from({ length: 400 }, (_, i) => randomTip(i, 'boulder', { wallAngle: 40 })));
    expect([...steep].some((t) => OVERHANG_TIP.test(t))).toBe(true);
    const slab = new Set(Array.from({ length: 400 }, (_, i) => randomTip(i, 'boulder', { wallAngle: -10 })));
    expect([...slab].some((t) => SLAB_TIP.test(t))).toBe(true);
    const dyno = new Set(Array.from({ length: 400 }, (_, i) => randomTip(i, 'boulder', { wallAngle: 10, style: 'dyno' })));
    expect([...dyno].some((t) => /dyno|throw/i.test(t))).toBe(true);
  });

  it('chalk advice is for lead routes only (on a boulder nobody needs to chalk up mid-climb)', () => {
    const CHALK_TIP = /sweaty|to chalk up|chalk before/i;
    for (let seed = 0; seed < 400; seed++) {
      expect(randomTip(seed, 'boulder', { wallAngle: 0 })).not.toMatch(CHALK_TIP);
      expect(tipFor('slip', seed, 'boulder', { wallAngle: 0 })).not.toMatch(CHALK_TIP);
      expect(tipFor('pump', seed, 'boulder', { wallAngle: 30 })).not.toMatch(CHALK_TIP);
    }
    const lead = new Set(Array.from({ length: 400 }, (_, i) => randomTip(i, 'rope', { wallAngle: 5 })));
    expect([...lead].some((t) => CHALK_TIP.test(t))).toBe(true);
  });

  it('teaches the new moves: chalk, shake-outs, hooks, flags', () => {
    const all = TIPS.join(' ');
    expect(all).toMatch(/chalk up/i);
    expect(all).toMatch(/shake it out/i);
    expect(all).toMatch(/heel/i);
    expect(all).toMatch(/flag/i);
  });
});

// Contact AO under holds on folded walls (HoldSet.buildAo helpers): a patch is cut at every fold
// it crosses; past a convex lip it fades out within a few cm, into an inside corner it wraps on.
import { describe, expect, it } from 'vitest';
import { aoCuts, aoFade } from './holds';

// vertical 0..2 m, roof (70°) 2..3.2 m, headwall over the lip (20°) 3.2.. m
const spans = [
  { y1: 2, angle: 0 },
  { y1: 3.2, angle: 70 },
  { y1: 4.5, angle: 20 },
];

describe('contact AO across folds', () => {
  it('a hold away from every fold keeps its full patch, uncut', () => {
    expect(aoCuts(spans, 1.0, 0.9, 1.1)).toEqual([]);
    expect(aoFade(spans, 1.0, 0.9)).toBe(1);
    expect(aoFade(spans, 1.0, 1.1)).toBe(1);
  });

  it('wraps into an inside corner (vertical → roof) at full strength', () => {
    // a volume at the top of the vertical panel, its patch reaching onto the roof
    const cuts = aoCuts(spans, 1.85, 1.6, 2.1);
    expect(cuts).toEqual([2]);
    expect(aoFade(spans, 1.85, 2.08)).toBe(1);
  });

  it('fades out within a few cm past a convex roof lip (both directions)', () => {
    // a hold on the roof just under the lip: the patch crossing onto the headwall
    const cuts = aoCuts(spans, 3.12, 2.95, 3.3);
    expect(cuts[0]).toBeCloseTo(3.2, 6);
    expect(cuts.length).toBe(2);
    const fadeEnd = cuts[1];
    expect(fadeEnd - 3.2).toBeGreaterThan(0.015);
    expect(fadeEnd - 3.2).toBeLessThan(0.04);
    expect(aoFade(spans, 3.12, 3.2)).toBe(1);
    expect(aoFade(spans, 3.12, fadeEnd)).toBeCloseTo(0, 6);
    expect(aoFade(spans, 3.12, 3.29)).toBe(0);
    // a hold on the headwall just over the lip: its patch reaching back under the roof fades too
    const back = aoCuts(spans, 3.26, 3.1, 3.4);
    expect(back[0]).toBeLessThan(3.2);
    expect(aoFade(spans, 3.26, back[0])).toBeCloseTo(0, 6);
    expect(aoFade(spans, 3.26, 3.12)).toBe(0);
  });

  it('a gentle convex fold fades over a longer stretch than a sharp lip', () => {
    const gentle = [
      { y1: 2, angle: 10 },
      { y1: 4.5, angle: 2 },
    ];
    const sharp = [
      { y1: 2, angle: 60 },
      { y1: 4.5, angle: 0 },
    ];
    expect(aoFade(gentle, 1.9, 2.05)).toBeGreaterThan(aoFade(sharp, 1.9, 2.05));
  });
});

import { describe, expect, it } from 'vitest';
import { ADVICE, colorAdvice, decodeAdvice, frameAdvice, holdsAdvice, holdsReady, photoAdvice, rolesAdvice } from './advice';
import { hexToLab } from './color';
import { ROUTE } from './route';

describe('photo advice', () => {
  it('flags tiny, small and panorama photos; a normal phone photo passes', () => {
    expect(photoAdvice(4032, 3024)).toBeNull();
    expect(photoAdvice(1200, 1600)).toBeNull();
    expect(photoAdvice(480, 640)?.level).toBe('warn');
    expect(photoAdvice(480, 640)?.body).toContain('480 × 640');
    expect(photoAdvice(160, 200)?.level).toBe('bad');
    expect(photoAdvice(1000, 3000)?.title).toMatch(/panorama/i);
  });

  it('explains why a file could not be opened', () => {
    expect(decodeAdvice('image/heic', 'IMG_0001.HEIC')).toMatch(/HEIC/);
    expect(decodeAdvice('', 'wall.heif')).toMatch(/HEIC/);
    expect(decodeAdvice('application/pdf', 'topo.pdf')).toMatch(/isn’t a photo/);
    expect(decodeAdvice('image/jpeg', 'broken.jpg')).toMatch(/couldn’t be opened/);
  });

  it('flags a frame that is tiny in the photo or much wider than tall', () => {
    expect(frameAdvice(0.5, 0.8)).toBeNull();
    expect(frameAdvice(0.03, 0.8)?.title).toMatch(/small/);
    expect(frameAdvice(0.5, 3)?.title).toMatch(/wide/);
  });

  it('a colour tap on the wall itself is called out, a hold colour is not', () => {
    const wall = hexToLab('#34322f');
    expect(colorAdvice(hexToLab('#36332f'), wall)?.actions).toContain('recolor');
    expect(colorAdvice(hexToLab('#F2C230'), wall)).toBeNull();
    // black holds on a charcoal wall still differ enough
    expect(colorAdvice(hexToLab('#0b0b0c'), wall)).toBeNull();
    expect(colorAdvice(hexToLab('#36332f'), null)).toBeNull();
  });

  it('detection: nothing found, a loose colour, too many / too few holds, the frame scale', () => {
    const base = { coverage: 0.03, medianM: 0.12, sensitivity: 0.45 };
    expect(holdsAdvice({ ...base, n: 16 })).toEqual([]);
    const none = holdsAdvice({ ...base, n: 0, medianM: null });
    expect(none[0].level).toBe('bad');
    expect(none[0].actions).toEqual(['more', 'recolor']);
    expect(holdsAdvice({ ...base, n: 0, medianM: null, sensitivity: 1 })[0].actions).toEqual(['recolor']);
    expect(holdsAdvice({ ...base, n: 30, coverage: 0.4 })[0].actions).toContain('less');
    // the wall's own colour: one huge region (or none) covering most of the wall
    const wall = holdsAdvice({ ...base, n: 0, coverage: 0.9, medianM: null });
    expect(wall[0].title).toMatch(/is the wall/);
    expect(wall[0].actions?.[0]).toBe('recolor');
    expect(holdsAdvice({ ...base, n: 60 })[0].level).toBe('bad');
    expect(holdsAdvice({ ...base, n: 40 })[0].level).toBe('warn');
    expect(holdsAdvice({ ...base, n: 1, medianM: null })[0].title).toMatch(/one hold/);
    expect(holdsAdvice({ ...base, n: 3, medianM: null })[0].title).toMatch(/3 holds/);
    expect(holdsAdvice({ ...base, n: 12, medianM: 0.02 })[0].actions).toEqual(['reframe']);
    expect(holdsAdvice({ ...base, n: 12, medianM: 0.5 })[0].title).toMatch(/huge/);
    expect(holdsReady(0)).toBe(false);
    expect(holdsReady(1)).toBe(false);
    expect(holdsReady(2)).toBe(true);
    expect(holdsReady(ADVICE.maxHolds)).toBe(true);
    expect(holdsReady(ADVICE.maxHolds + 1)).toBe(false);
  });

  it('start / top: missing marks and a low top block, a sit start and few hands warn', () => {
    expect(rolesAdvice({ startYs: [1.5], topY: 4.1, hands: 10 })).toBeNull();
    expect(rolesAdvice({ startYs: [], topY: 4.1, hands: 10 })?.level).toBe('bad');
    expect(rolesAdvice({ startYs: [1.5], topY: null, hands: 10 })?.level).toBe('bad');
    expect(rolesAdvice({ startYs: [1.5, 1.7], topY: 2.0, hands: 10 })?.level).toBe('bad');
    const sit = rolesAdvice({ startYs: [ROUTE.startMinY - 0.2], topY: 4.1, hands: 10 });
    expect(sit?.level).toBe('warn');
    expect(sit?.title).toMatch(/sit start/i);
    expect(rolesAdvice({ startYs: [1.5], topY: 4.1, hands: 3 })?.level).toBe('warn');
  });
});

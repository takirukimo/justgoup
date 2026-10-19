import { describe, expect, it } from 'vitest';
import { draftFromSample, validateDraft } from '../editor/model';
import { hexToLab, grayWorldGains, samplePatch, toLab } from './color';
import { CV, detectBlobs, distanceMap, excludeSet, wallColor } from './cv';
import { quadAspect, rectSize, warpQuad } from './geometry';
import { buildBoulder, guessHold, guessRoles, placeHolds, routeColorFor, wallFor, type PlacedHold } from './route';
import { synthPhoto } from './synth';
import type { PhotoBlob, PhotoHold } from './types';

const H = (o: Partial<PhotoHold> & { x: number; y: number; major: number; minor?: number }): PhotoHold => ({
  minor: o.major * 0.8,
  theta: 0,
  solidity: 0.95,
  pocket: false,
  kind: 'hold',
  hull: [],
  ...o,
});

const g = (lengthM: number, widthM: number, extra: Partial<Parameters<typeof guessHold>[0]> = {}) =>
  guessHold({ lengthM, widthM, thetaWall: 0, pocket: false, kind: 'hold', towardX: 0, ...extra });

describe('hold guesses', () => {
  it('reads type and product from the blob', () => {
    expect(g(0.03, 0.025).type).toBe('foot');
    expect(g(0.03, 0.025).shape).toBe('chip');
    expect(g(0.045, 0.03).type).toBe('foot');
    expect(g(0.07, 0.06).type).toBe('crimp');
    expect(g(0.09, 0.03).type).toBe('crimp');
    expect(g(0.09, 0.045).type).toBe('edge');
    expect(g(0.13, 0.11).type).toBe('jug');
    expect(g(0.21, 0.19).type).toBe('sloper');
    expect(g(0.22, 0.13)).toMatchObject({ type: 'jug', shape: 'bucket' });
    expect(g(0.2, 0.05)).toMatchObject({ type: 'edge', shape: 'rail' });
    expect(g(0.16, 0.07, { thetaWall: Math.PI / 2 }).type).toBe('pinch');
    expect(g(0.3, 0.25)).toMatchObject({ type: 'sloper', shape: 'macro' });
    expect(g(0.12, 0.1, { pocket: true }).type).toBe('pocket');
    expect(g(0.7, 0.6, { kind: 'volume' }).type).toBe('volume');
  });

  it('pulls square to an edge, toward the body below', () => {
    expect(g(0.09, 0.03).angle).toBeCloseTo(-Math.PI / 2, 5);
    // an edge tilted up to the right: the pull leans left of straight down
    const tilted = g(0.09, 0.03, { thetaWall: 0.4 }).angle;
    expect(Math.sin(tilted)).toBeLessThan(0);
    expect(Math.cos(tilted)).toBeGreaterThan(0.2);
    // a vertical edge left of the line is a sidepull toward it
    const side = g(0.12, 0.03, { thetaWall: Math.PI / 2, towardX: 1 }).angle;
    expect(Math.cos(side)).toBeGreaterThan(0.9);
    // compact holds: classic orientation
    expect(g(0.13, 0.11).angle).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('sizes the in-game hold like the photo (within its product range)', () => {
    const small = g(0.11, 0.1);
    const big = g(0.16, 0.14);
    expect(big.size).toBeGreaterThan(small.size);
    expect(g(0.6, 0.5, { kind: 'volume' }).size).toBeLessThanOrEqual(0.55);
  });
});

describe('placing holds on the wall', () => {
  it('keeps proportions with one scale and the wall height of the preset', () => {
    const wall = wallFor('vertical');
    const holds = [H({ x: 100, y: 100, major: 20 }), H({ x: 300, y: 500, major: 20 })];
    const p = placeHolds(holds, 400, 600, wall.length);
    const mpp = wall.length / 600;
    expect(p[1].x - p[0].x).toBeCloseTo(200 * mpp, 6);
    expect(p[0].y - p[1].y).toBeCloseTo(400 * mpp, 6);
    expect(p[0].y).toBeCloseTo(wall.length - 100 * mpp, 6);
  });

  it('centres a route that pokes off the side and squeezes one wider than the wall', () => {
    const wall = wallFor('vertical');
    // rectified image 2:1 → 9 m wide at 4.5 m: holds near the right edge
    const off = placeHolds([H({ x: 1500, y: 300, major: 20 }), H({ x: 1700, y: 200, major: 20 })], 2000, 1000, wall.length);
    for (const q of off) expect(Math.abs(q.x)).toBeLessThan(2.3);
    const wide = placeHolds([H({ x: 50, y: 300, major: 20 }), H({ x: 1950, y: 200, major: 20 })], 2000, 1000, wall.length);
    expect(Math.abs(wide[0].x)).toBeLessThan(2.3);
    expect(Math.abs(wide[1].x)).toBeLessThan(2.3);
    expect(wide[0].x).toBeCloseTo(-wide[1].x, 3);
  });

  it('takes Claude / user types over the guess', () => {
    const [p] = placeHolds([H({ x: 200, y: 200, major: 30, type: 'sloper' })], 400, 400, 4.5);
    expect(p.guess.type).toBe('sloper');
  });
});

describe('start and top', () => {
  const P = (x: number, y: number, type: PlacedHold['guess']['type'] = 'jug'): PlacedHold => ({ x, y, lengthM: 0.12, guess: { type, size: 0.1, angle: -Math.PI / 2 } });

  it('takes the highest hand hold as the top and a level pair low down as the starts', () => {
    const r = guessRoles([P(0, 3.9), P(-0.3, 1.25), P(0.25, 1.3), P(0.1, 2.3), P(0, 0.4, 'foot'), P(0.5, 0.5)]);
    expect(r.top).toBe(0);
    expect(r.starts.sort()).toEqual([1, 2]);
  });

  it('follows start tape', () => {
    const r = guessRoles([P(0, 3.9), P(-0.8, 1.2), P(0.6, 1.6), P(0.1, 2.3)], [{ x: 0.62, y: 1.4 }]);
    expect(r.starts).toEqual([2]);
  });

  it('never makes a foot chip a start or the top', () => {
    const r = guessRoles([P(0, 4.2, 'foot'), P(0, 3.5), P(0, 1.2), P(0, 0.4, 'foot')]);
    expect(r.top).toBe(1);
    expect(r.starts).toEqual([2]);
  });
});

describe('route colours', () => {
  it('maps a sampled colour to the game palette', () => {
    expect(routeColorFor(hexToLab('#E8C440')).name).toBe('Yellow');
    expect(routeColorFor(hexToLab('#3570E0')).name).toBe('Blue');
    expect(routeColorFor(hexToLab('#F0F0EE')).name).toBe('White');
    expect(routeColorFor(hexToLab('#202124')).name).toBe('Black');
    // a shaded blue sample is still blue; orange stays orange; pink stays pink
    expect(routeColorFor(hexToLab('#16336A')).name).toBe('Blue');
    expect(routeColorFor(hexToLab('#E8741F')).name).toBe('Orange');
    expect(routeColorFor(hexToLab('#EE72AC')).name).toBe('Pink');
    expect(routeColorFor(hexToLab('#2BAF6A')).name).toBe('Green');
    expect(routeColorFor(hexToLab('#25B5AD')).name).toBe('Teal');
    expect(routeColorFor(hexToLab('#DD4038')).name).toBe('Red');
    expect(routeColorFor(hexToLab('#8A5CF0')).name).toBe('Purple');
  });
});

describe('photo → BoulderDef', () => {
  it('builds a problem the editor accepts, on the chosen wall', () => {
    const s = synthPhoto({ seed: 3, view: 'below', photoW: 720, photoH: 960, ppm: 170 });
    const { w, h } = rectSize(quadAspect(s.quad, s.photo.width, s.photo.height), 800);
    const rect = warpQuad(s.photo, s.quad, w, h);
    const lab = toLab(rect, grayWorldGains(rect));
    const route = s.holds.filter((hd) => hd.route && hd.r > 0.05)[0];
    const sample = samplePatch(lab, ((route.x + 2.3) / 4.6) * w, ((4.5 - route.y) / 4.5) * h)!;
    const res = detectBlobs(lab, distanceMap(lab, [sample], excludeSet(wallColor(lab), [sample], [])), { sensitivity: CV.defaultSensitivity, ppm: h / 4.5 });
    const holds: PhotoHold[] = res.blobs.filter((b) => b.kind === 'hold').map((b: PhotoBlob) => ({ ...b }));
    const tapes = res.blobs.filter((b) => b.kind === 'tape');
    for (const presetId of ['vertical', 'overhang-25', 'cave', 'slab']) {
      const wall = wallFor(presetId);
      const placed = placeHolds(holds, w, h, wall.length);
      const mpp = wall.length / h;
      const roles = guessRoles(placed, tapes.map((t) => ({ x: (t.x - w / 2) * mpp, y: wall.length - t.y * mpp })));
      const b = buildBoulder({ holds, rectW: w, rectH: h, starts: roles.starts, top: roles.top, presetId, color: '#F2C230', name: 'Yellow Snapshot', seed: 42 });
      expect(b.mode).toBe('boulder');
      expect(b.width).toBe(4.6);
      expect(b.height).toBe(wall.length);
      expect(b.holds.length).toBe(holds.length);
      if (wall.panels.length > 1) expect(b.profile?.length).toBe(wall.panels.length);
      const check = validateDraft(draftFromSample(b));
      expect(check.ok, `${presetId}: ${check.headline}`).toBe(true);
    }
  }, 20000);
});

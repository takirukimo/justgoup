import { describe, expect, it } from 'vitest';
import { colorName, grayWorldGains, hexToLab, labToHex, rgbToLab, samplePatch, toLab, type LabImage } from './color';
import { chamfer, CV, detectBlobs, distanceMap, excludeSet, fillHoles, label8, majority3, regionAt, wallColor } from './cv';
import { applyH, invert3, quadAspect, quadValid, rectSize, solveHomography, warpQuad } from './geometry';
import { synthPhoto, type SynthHold, type SynthOptions } from './synth';
import type { Lab, PhotoBlob, Quad } from './types';

// ───────────────────────────── helpers ─────────────────────────────

const WALL_W = 4.6;
const WALL_H = 4.5;

/** Shoot a synthetic photo, rectify it with the true corners, detect with a tap on a route hold. */
function run(o: SynthOptions, opts: { sensitivity?: number; exclude?: Lab[]; tapIndex?: number } = {}) {
  const s = synthPhoto({ photoW: 720, photoH: 960, ppm: 170, ...o });
  const aspect = quadAspect(s.quad, s.photo.width, s.photo.height);
  const { w, h } = rectSize(aspect, 800);
  const rect = warpQuad(s.photo, s.quad, w, h);
  const lab = toLab(rect, grayWorldGains(rect));
  const ppm = h / WALL_H;
  const toPx = (hd: { x: number; y: number }) => ({ x: ((hd.x + WALL_W / 2) / WALL_W) * w, y: ((WALL_H - hd.y) / WALL_H) * h });
  const route = s.holds.filter((hd) => hd.route && hd.r > 0.05);
  const tap = toPx(route[opts.tapIndex ?? 0]);
  const sample = samplePatch(lab, tap.x, tap.y, 3)!;
  const dist = distanceMap(lab, [sample], excludeSet(wallColor(lab), [sample], opts.exclude ?? []));
  const res = detectBlobs(lab, dist, { sensitivity: opts.sensitivity ?? CV.defaultSensitivity, ppm });
  return { s, rect, lab, dist, res, ppm, w, h, toPx, sample, aspect };
}

/** Match detected blobs of `kind` to truth holds (centre within tol metres). */
function match(blobs: PhotoBlob[], truth: SynthHold[], toPx: (p: { x: number; y: number }) => { x: number; y: number }, ppm: number, tolM = 0.07) {
  const used = new Set<number>();
  let hits = 0;
  for (const t of truth) {
    const p = toPx(t);
    let best = -1;
    let bd = tolM * ppm + t.r * ppm * 0.5;
    blobs.forEach((b, i) => {
      if (used.has(i)) return;
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      hits++;
    }
  }
  return { hits, extra: blobs.length - used.size };
}

/** A synthetic Lab image: background grey, `paint(x, y)` → true where the hold colour is. */
function labImage(w: number, h: number, paint: (x: number, y: number) => boolean): { lab: LabImage; sample: Lab } {
  const L = new Float32Array(w * h).fill(45);
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h).fill(2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!paint(x, y)) continue;
      const i = y * w + x;
      L[i] = 55;
      a[i] = 62;
      b[i] = 30;
    }
  }
  return { lab: { width: w, height: h, L, a, b }, sample: { L: 55, a: 62, b: 30 } };
}

// ───────────────────────────── colour ─────────────────────────────

describe('colour', () => {
  it('converts sRGB to CIELAB (D65)', () => {
    const white = rgbToLab(255, 255, 255);
    expect(white.L).toBeCloseTo(100, 1);
    expect(Math.abs(white.a)).toBeLessThan(0.5);
    const red = rgbToLab(255, 0, 0);
    expect(red.L).toBeCloseTo(53.24, 0);
    expect(red.a).toBeCloseTo(80.09, 0);
    expect(red.b).toBeCloseTo(67.2, 0);
  });

  it('round-trips hex through Lab', () => {
    for (const hex of ['#F2C230', '#2F6FEB', '#2FB36D', '#E5433B', '#1E1F22']) expect(labToHex(hexToLab(hex))).toBe(hex);
  });

  it('names the gym colours', () => {
    expect(colorName(hexToLab('#F2C230'))).toBe('Yellow');
    expect(colorName(hexToLab('#2F6FEB'))).toBe('Blue');
    expect(colorName(hexToLab('#2FB36D'))).toBe('Green');
    expect(colorName(hexToLab('#E5433B'))).toBe('Red');
    expect(colorName(hexToLab('#8B5CF6'))).toBe('Purple');
    expect(colorName(hexToLab('#EDEDED'))).toBe('White');
    expect(colorName(hexToLab('#1E1F22'))).toBe('Black');
  });

  it('samples a hold through gloss and the wall at its edge', () => {
    // a red patch with a white highlight and a grey corner
    const { lab } = labImage(9, 9, (x, y) => !(x < 2 && y < 2));
    lab.L[4 * 9 + 4] = 98;
    lab.a[4 * 9 + 4] = 0;
    const s = samplePatch(lab, 4, 4, 3)!;
    expect(s.a).toBeCloseTo(62, 0);
    expect(s.L).toBeCloseTo(55, 0);
  });

  it('white-balances a colour cast on the wall', () => {
    const s = synthPhoto({ photoW: 240, photoH: 320, ppm: 60, cast: [1.15, 1.0, 0.8], noise: 0 });
    const g = grayWorldGains(s.photo);
    expect(g[2]).toBeGreaterThan(g[0]);
  });
});

// ───────────────────────────── geometry ─────────────────────────────

describe('geometry', () => {
  it('solves and inverts a homography', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    const dst = [
      { x: 12, y: 30 },
      { x: 140, y: 18 },
      { x: 160, y: 150 },
      { x: 4, y: 120 },
    ];
    const m = solveHomography(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const p = applyH(m, src[i].x, src[i].y);
      expect(p.x).toBeCloseTo(dst[i].x, 6);
      expect(p.y).toBeCloseTo(dst[i].y, 6);
    }
    const inv = invert3(m)!;
    const q = applyH(inv, 80, 60);
    const back = applyH(m, q.x, q.y);
    expect(back.x).toBeCloseTo(80, 6);
    expect(back.y).toBeCloseTo(60, 6);
    expect(solveHomography(src, [dst[0], dst[0], dst[0], dst[0]])).toBeNull();
  });

  it('rejects crossed or tiny quads', () => {
    const ok: Quad = [
      { x: 10, y: 10 },
      { x: 200, y: 20 },
      { x: 190, y: 300 },
      { x: 20, y: 280 },
    ];
    expect(quadValid(ok)).toBe(true);
    expect(quadValid([ok[0], ok[2], ok[1], ok[3]])).toBe(false);
    expect(quadValid([ok[0], { x: 12, y: 11 }, ok[2], ok[3]])).toBe(false);
  });

  it('recovers the wall aspect ratio from a perspective photo', () => {
    for (const view of ['front', 'below', 'left'] as const) {
      const s = synthPhoto({ view, photoW: 360, photoH: 480, ppm: 40, distractors: 0, routeCount: 3, tape: false, volume: 'none' });
      const a = quadAspect(s.quad, s.photo.width, s.photo.height);
      expect(Math.abs(a / (WALL_W / WALL_H) - 1), view).toBeLessThan(0.04);
    }
  });

  it('sizes the rectified image by aspect', () => {
    expect(rectSize(1.5, 900)).toEqual({ w: 900, h: 600 });
    expect(rectSize(0.5, 900)).toEqual({ w: 450, h: 900 });
  });

  it('rectifies the wall back to its square-on painting', () => {
    const s = synthPhoto({ view: 'below', photoW: 720, photoH: 960, ppm: 120, noise: 0, cast: [1, 1, 1] });
    const w = 552;
    const h = 540;
    const rect = warpQuad(s.photo, s.quad, w, h);
    // every big route hold has its colour at its centre in the rectified image
    for (const hd of s.holds.filter((q) => q.route && q.r > 0.06 && q.shape !== 'pocket')) {
      const x = Math.round(((hd.x + WALL_W / 2) / WALL_W) * w);
      const y = Math.round(((WALL_H - hd.y) / WALL_H) * h);
      const o = (y * w + x) * 4;
      const c = rgbToLab(rect.data[o], rect.data[o + 1], rect.data[o + 2]);
      const t = hexToLab(hd.color);
      expect(Math.hypot(c.a - t.a, c.b - t.b), `hold at ${hd.x.toFixed(2)}, ${hd.y.toFixed(2)}`).toBeLessThan(40);
    }
  });
});

// ───────────────────────────── morphology ─────────────────────────────

describe('morphology', () => {
  it('chamfer distances stay close to Euclidean', () => {
    const w = 41;
    const m = new Uint8Array(w * w);
    m[20 * w + 20] = 1;
    const d = chamfer(m, w, w, 1);
    expect(d[20 * w + 30] / 5).toBe(10);
    expect(Math.abs(d[27 * w + 27] / 5 - Math.hypot(7, 7))).toBeLessThan(0.25);
    expect(Math.abs(d[24 * w + 31] / 5 - Math.hypot(4, 11))).toBeLessThan(0.3);
  });

  it('labels 8-connected components and fills holes', () => {
    const w = 20;
    const h = 12;
    const m = new Uint8Array(w * h);
    // a ring (with a hole) and a diagonal pair (one component under 8-connectivity)
    for (let y = 2; y <= 8; y++) for (let x = 2; x <= 8; x++) if (x === 2 || x === 8 || y === 2 || y === 8) m[y * w + x] = 1;
    m[3 * w + 14] = 1;
    m[4 * w + 15] = 1;
    const c = label8(m, w, h);
    expect(c.count).toBe(2);
    const holes = fillHoles(m, w, h);
    expect(holes[5 * w + 5]).toBe(1);
    expect(m[5 * w + 5]).toBe(1);
    expect(holes[0]).toBe(0);
  });

  it('majority filter drops specks and keeps solid regions', () => {
    const w = 10;
    const m = new Uint8Array(w * w);
    m[1 * w + 1] = 1;
    for (let y = 4; y < 9; y++) for (let x = 4; x < 9; x++) m[y * w + x] = 1;
    const o = majority3(m, w, w);
    expect(o[1 * w + 1]).toBe(0);
    expect(o[6 * w + 6]).toBe(1);
  });
});

// ───────────────────────────── shapes ─────────────────────────────

describe('blob shapes', () => {
  const ppm = 200;
  const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;

  it('splits two holds touching at a neck', () => {
    const a = disc(60, 60, 15);
    const b = disc(91, 60, 15);
    const { lab, sample } = labImage(150, 120, (x, y) => a(x, y) || b(x, y));
    const res = detectBlobs(lab, distanceMap(lab, [sample]), { sensitivity: 0.5, ppm });
    const holds = res.blobs.filter((q) => q.kind === 'hold');
    expect(holds.length).toBe(2);
    expect(Math.abs(holds[0].x - holds[1].x)).toBeGreaterThan(20);
  });

  it('keeps a crescent edge and a peanut-shaped hold whole', () => {
    const outer = disc(70, 60, 22);
    const inner = disc(70, 46, 22);
    const peanutA = disc(40, 140, 13);
    const peanutB = disc(56, 140, 12);
    const { lab, sample } = labImage(160, 180, (x, y) => (outer(x, y) && !inner(x, y)) || peanutA(x, y) || peanutB(x, y));
    const res = detectBlobs(lab, distanceMap(lab, [sample]), { sensitivity: 0.5, ppm });
    expect(res.blobs.length).toBe(2);
    expect(res.blobs.every((q) => q.kind === 'hold')).toBe(true);
  });

  it('merges a hold cut by a chalk band, but not two separate holds', () => {
    const a = disc(50, 50, 16);
    const b = disc(120, 50, 16);
    // a 3 cm band across the first hold: wider than the closing bridges, within the merge gap
    const { lab, sample } = labImage(170, 100, (x, y) => (a(x, y) && Math.abs(y - 49.5) > 3) || b(x, y));
    const res = detectBlobs(lab, distanceMap(lab, [sample]), { sensitivity: 0.5, ppm: 200 });
    expect(res.blobs.length).toBe(2);
  });

  it('reads long thin strips as tape and huge regions as volumes', () => {
    const tape = (x: number, y: number) => x >= 30 && x < 35 && y >= 20 && y < 60;
    const vol = (x: number, y: number) => x >= 60 && x < 180 && y >= 10 && y < 120;
    const { lab, sample } = labImage(200, 140, (x, y) => tape(x, y) || vol(x, y));
    const res = detectBlobs(lab, distanceMap(lab, [sample]), { sensitivity: 0.5, ppm: 200 });
    expect(res.blobs.map((q) => q.kind).sort()).toEqual(['tape', 'volume']);
  });

  it('peels start tape off the hold it is stuck to', () => {
    const hold = disc(60, 40, 16);
    const tape = (x: number, y: number) => x >= 57 && x < 63 && y >= 54 && y < 90;
    const { lab, sample } = labImage(120, 110, (x, y) => hold(x, y) || tape(x, y));
    const res = detectBlobs(lab, distanceMap(lab, [sample]), { sensitivity: 0.5, ppm: 220 });
    const kinds = res.blobs.map((q) => q.kind).sort();
    expect(kinds).toEqual(['hold', 'tape']);
    const h = res.blobs.find((q) => q.kind === 'hold')!;
    expect(Math.hypot(h.x - 60, h.y - 40)).toBeLessThan(2.5);
  });

  it('finds a pocket from its dark mouth', () => {
    const hold = disc(50, 50, 18);
    const mouth = disc(50, 48, 7);
    const { lab, sample } = labImage(100, 100, (x, y) => hold(x, y) && !mouth(x, y));
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (mouth(x, y)) lab.L[y * 100 + x] = 8;
    const res = detectBlobs(lab, distanceMap(lab, [sample]), { sensitivity: 0.5, ppm: 200 });
    expect(res.blobs.length).toBe(1);
    expect(res.blobs[0].pocket).toBe(true);
    expect(res.blobs[0].holeFrac).toBeGreaterThan(0.05);
  });
});

// ───────────────────────────── whole photos ─────────────────────────────

describe('detection on synthetic photos', () => {
  it('finds a yellow problem shot from below on a charcoal wall', () => {
    const r = run({ seed: 3, view: 'below', route: '#F2C230', wall: 'charcoal' });
    expect(Math.abs(r.aspect / (WALL_W / WALL_H) - 1)).toBeLessThan(0.03);
    const holds = r.res.blobs.filter((b) => b.kind === 'hold');
    const truth = r.s.holds.filter((hd) => hd.route);
    const m = match(holds, truth, r.toPx, r.ppm);
    expect(m.hits / truth.length).toBeGreaterThanOrEqual(0.9);
    expect(m.extra).toBeLessThanOrEqual(1);
    // the start tape is tape, not a hold
    const tape = r.s.holds.find((hd) => hd.shape === 'tape')!;
    const tapes = r.res.blobs.filter((b) => b.kind === 'tape');
    expect(match(tapes, [tape], r.toPx, r.ppm).hits).toBe(1);
  }, 20000);

  it('handles a blue problem from the side: same-colour volume, touching holds, tape stuck on', () => {
    const r = run({ seed: 5, view: 'left', route: '#2F6FEB', wall: 'grey', volume: 'route', touching: true, tapeTouch: true });
    const holds = r.res.blobs.filter((b) => b.kind === 'hold');
    const truth = r.s.holds.filter((hd) => hd.route);
    const m = match(holds, truth, r.toPx, r.ppm);
    expect(m.hits / truth.length).toBeGreaterThanOrEqual(0.9);
    expect(m.extra).toBeLessThanOrEqual(1);
    const vol = r.s.holds.find((hd) => hd.shape === 'volume')!;
    expect(match(r.res.blobs.filter((b) => b.kind === 'volume'), [vol], r.toPx, r.ppm, 0.15).hits).toBe(1);
    expect(r.res.blobs.filter((b) => b.kind === 'tape').length).toBe(1);
  }, 20000);

  it('finds white holds (achromatic) on a charcoal wall and keeps the bone volume out', () => {
    const r = run({ seed: 9, view: 'front', route: '#EDEDED', wall: 'charcoal' });
    const holds = r.res.blobs.filter((b) => b.kind === 'hold');
    const truth = r.s.holds.filter((hd) => hd.route);
    const m = match(holds, truth, r.toPx, r.ppm);
    expect(m.hits / truth.length).toBeGreaterThanOrEqual(0.85);
    expect(m.extra).toBeLessThanOrEqual(2);
  }, 20000);

  it('an exclude tap keeps purple holds out of a blue problem', () => {
    const r0 = run({ seed: 21, view: 'below', route: '#2F6FEB', distractors: 30 });
    const purple = r0.s.holds.filter((hd) => hd.color === '#8B5CF6');
    expect(purple.length).toBeGreaterThan(0);
    const ex = purple.find((p) => p.r > 0.05) ?? purple[0];
    const px = r0.toPx(ex);
    const neg = samplePatch(r0.lab, px.x, px.y, 2)!;
    const r = run({ seed: 21, view: 'below', route: '#2F6FEB', distractors: 30 }, { exclude: [neg], sensitivity: 0.7 });
    const holds = r.res.blobs.filter((b) => b.kind === 'hold');
    expect(match(holds, purple, r.toPx, r.ppm, 0.03).hits).toBe(0);
    const truth = r.s.holds.filter((hd) => hd.route);
    expect(match(holds, truth, r.toPx, r.ppm).hits / truth.length).toBeGreaterThanOrEqual(0.85);
  }, 30000);

  it('sensitivity grows the mask; a tap finds a hold the detector skipped', () => {
    const r = run({ seed: 3, view: 'below' }, { sensitivity: 0.15 });
    const loose = detectBlobs(r.lab, r.dist, { sensitivity: 0.75, ppm: r.ppm });
    const count = (m: Uint8Array) => m.reduce((s, v) => s + (v ? 1 : 0), 0);
    expect(count(loose.mask)).toBeGreaterThan(count(r.res.mask));
    const big = r.s.holds.filter((hd) => hd.route && hd.r > 0.06)[2];
    const p = r.toPx(big);
    const b = regionAt(r.lab, r.dist, p.x, p.y, { sensitivity: 0.3, ppm: r.ppm });
    expect(b).not.toBeNull();
    expect(Math.hypot(b!.x - p.x, b!.y - p.y)).toBeLessThan(0.06 * r.ppm);
    // blank wall: nothing there
    expect(regionAt(r.lab, r.dist, 12, r.h - 12, { sensitivity: 0.3, ppm: r.ppm })).toBeNull();
  }, 20000);
});

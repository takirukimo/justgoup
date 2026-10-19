import { afterEach, describe, expect, it } from 'vitest';
import { asSampleError, resolveSample } from './sample';
import { circleHull, mergeVision, parseVision, visionErrorCopy, VisionError, visionPrompt, type VisionContext, type VisionResult } from './vision';
import type { PhotoHold } from './types';

const ctx: VisionContext = {
  width: 1000,
  height: 1000,
  colorName: 'Yellow',
  colorHex: '#F2C230',
  candidates: [
    { id: 1, x: 0.5, y: 0.1, size: 0.03 },
    { id: 2, x: 0.45, y: 0.4, size: 0.03 },
    { id: 3, x: 0.55, y: 0.7, size: 0.03 },
    { id: 4, x: 0.2, y: 0.8, size: 0.05 },
  ],
  wallW: 4.6,
  wallH: 4.5,
  images: 2,
};

const hold = (x: number, y: number, extra: Partial<PhotoHold> = {}): PhotoHold => ({
  x,
  y,
  major: 30,
  minor: 24,
  theta: 0,
  solidity: 0.95,
  pocket: false,
  kind: 'hold',
  hull: circleHull(x, y, 15),
  ...extra,
});

describe('the prompt', () => {
  it('describes the images, the colour, the markers and the exact JSON', () => {
    const p = visionPrompt(ctx);
    expect(p).toContain('1000×1000 px');
    expect(p).toContain('yellow holds');
    expect(p).toContain('#F2C230');
    expect(p).toContain('Image 2 is the same photo with numbered markers');
    expect(p).toContain('3: (0.550, 0.700) size 0.030');
    expect(p).toContain('Reply with only JSON');
    expect(p).toContain('"holds":[{"id":3');
    expect(visionPrompt({ ...ctx, images: 1, candidates: [] })).toContain('(none: the detector found nothing)');
  });
});

describe('validating Claude’s answer', () => {
  const good = {
    holds: [
      { id: 1, x: 0.5, y: 0.1, size: 0.04, type: 'jug', role: 'top', confidence: 0.95 },
      { id: 2, x: 0.45, y: 0.4, size: 0.03, type: 'crimp', role: 'hand', confidence: 0.8 },
      { id: 3, x: 0.55, y: 0.7, size: 0.03, type: 'Edge', role: 'start', confidence: 0.9 },
      { id: null, x: 0.3, y: 0.55, size: 0.02, type: 'rail', role: 'hand', confidence: 0.7 },
    ],
    rejected: [4],
    wallAngleDeg: 20,
  };

  it('accepts a well-formed answer, bottom to top', () => {
    const r = parseVision(good, ctx);
    expect(r.holds.map((h) => h.id)).toEqual([3, null, 2, 1]);
    expect(r.holds[1]).toMatchObject({ type: 'edge', shape: 'rail' });
    expect(r.holds[0].type).toBe('edge');
    expect(r.rejected).toEqual([4]);
    expect(r.wallAngle).toBe(20);
  });

  it('is tolerant of pixels, numeric strings and a bare array', () => {
    const r = parseVision(
      [
        { id: '1', x: '500', y: 100, size: 40, type: 'jug', role: 'top' },
        { x: 450, y: 400, type: 'crimp' },
        { x: 0.55, y: 0.7, type: 'mystery', role: 'start' },
      ],
      ctx,
    );
    expect(r.holds.length).toBe(3);
    const top = r.holds.find((h) => h.role === 'top')!;
    expect(top.x).toBeCloseTo(0.5, 5);
    expect(top.size).toBeCloseTo(0.04, 5);
    expect(top.id).toBe(1);
    expect(r.holds.find((h) => h.role === 'start')!.type).toBeNull();
    expect(r.wallAngle).toBeNull();
  });

  it('drops out-of-bounds holds and unknown markers, and merges duplicates', () => {
    const r = parseVision(
      {
        holds: [
          { id: 99, x: 0.5, y: 0.2 },
          { x: 1.4, y: 0.5 },
          { x: 0.3, y: 0.3, confidence: 0.4 },
          { x: 0.31, y: 0.305, confidence: 0.9, type: 'sloper' },
          { x: 0.7, y: 0.6 },
          { x: 0.6, y: 0.9 },
        ],
        rejected: [2, 2, 77, 'x', { id: 3 }],
        wallAngleDeg: 140,
      },
      ctx,
    );
    expect(r.holds.length).toBe(4);
    expect(r.holds.find((h) => Math.abs(h.x - 0.31) < 1e-6)!.type).toBe('sloper');
    expect(r.holds.some((h) => Math.abs(h.x - 0.3) < 1e-6)).toBe(false);
    expect(r.holds[r.holds.length - 1].id).toBeNull(); // id 99 is no marker
    expect(r.rejected).toEqual([2, 3]);
    expect(r.wallAngle).toBeNull();
  });

  it('keeps one top (the highest) and two starts (the lowest); a foot is never either', () => {
    const r = parseVision(
      {
        holds: [
          { x: 0.5, y: 0.1, role: 'top' },
          { x: 0.5, y: 0.3, role: 'top' },
          { x: 0.3, y: 0.7, role: 'start' },
          { x: 0.6, y: 0.75, role: 'start' },
          { x: 0.45, y: 0.6, role: 'start' },
          { x: 0.5, y: 0.9, role: 'start', type: 'foot' },
        ],
      },
      ctx,
    );
    expect(r.holds.filter((h) => h.role === 'top').map((h) => h.y)).toEqual([0.1]);
    expect(r.holds.filter((h) => h.role === 'start').map((h) => h.y).sort()).toEqual([0.7, 0.75]);
    expect(r.holds.find((h) => h.type === 'foot')!.role).toBe('foot');
  });

  it('rejects answers that are not a problem', () => {
    expect(() => parseVision('nope', ctx)).toThrow(VisionError);
    expect(() => parseVision({ items: [] }, ctx)).toThrow(/no holds array/);
    try {
      parseVision({ holds: [{ x: 0.5, y: 0.5 }] }, ctx);
      expect.unreachable();
    } catch (e) {
      expect((e as VisionError).reason).toBe('count');
    }
    const many = Array.from({ length: 60 }, (_, i) => ({ x: (i % 10) / 10 + 0.05, y: Math.floor(i / 10) / 6 + 0.05 }));
    expect(() => parseVision({ holds: many }, ctx)).toThrow(VisionError);
  });
});

describe('merging with the local detection', () => {
  // local holds in a 1000 × 1000 rectified image: marker i + 1
  const local = [hold(500, 100), hold(450, 400), hold(550, 700), hold(200, 800, { kind: 'hold' }), hold(800, 300)];
  const v: VisionResult = {
    holds: [
      { id: 3, x: 0.55, y: 0.7, size: 0.03, type: 'edge', role: 'start', confidence: 0.9 },
      { id: null, x: 0.3, y: 0.55, size: 0.04, type: 'sloper', role: 'hand', confidence: 0.8 },
      { id: null, x: 0.452, y: 0.402, size: 0.03, type: 'pinch', role: 'hand', confidence: 0.8 },
      { id: 1, x: 0.5, y: 0.1, size: 0.04, type: 'jug', role: 'top', confidence: 0.95 },
    ],
    rejected: [4],
    wallAngle: 25,
  };

  it('merge: keeps unmentioned holds, drops rejected ones, applies types and roles, adds missed holds', () => {
    const m = mergeVision(local, v, 'merge', 1000, 1000);
    expect(m.holds.length).toBe(5); // 1, 2 (snapped: pinch), 3, 5, + the sloper
    expect(m.stats).toEqual({ kept: 2, dropped: 1, added: 1 });
    expect(m.holds.find((h) => h.x === 450)!.type).toBe('pinch');
    const added = m.holds.find((h) => h.manual)!;
    expect(added).toMatchObject({ x: 300, y: 550, type: 'sloper', source: 'claude' });
    expect(added.major).toBeCloseTo(40, 5);
    expect(m.holds[m.top!].y).toBe(100);
    expect(m.starts.map((i) => m.holds[i].y)).toEqual([700]);
    expect(m.holds.some((h) => h.x === 200)).toBe(false);
    expect(m.holds.some((h) => h.x === 800)).toBe(true);
  });

  it('claude: only Claude’s holds, with the local outlines it named', () => {
    const m = mergeVision(local, v, 'claude', 1000, 1000);
    // the pinch Claude found without a number snaps onto the region the detector had there
    expect(m.holds.map((h) => h.x).sort((a, b) => a - b)).toEqual([300, 450, 500, 550]);
    expect(m.holds.find((h) => h.x === 450)!.type).toBe('pinch');
    expect(m.stats).toEqual({ kept: 3, dropped: 2, added: 1 });
    expect(m.holds.find((h) => h.x === 550)!.hull).toEqual(local[2].hull);
  });

  it('a volume Claude names becomes a volume hold', () => {
    const m = mergeVision([hold(500, 500, { kind: 'volume', major: 200 })], { holds: [{ id: 1, x: 0.5, y: 0.5, size: 0.2, type: 'volume', role: 'foot', confidence: 0.8 }], rejected: [], wallAngle: null }, 'merge', 1000, 1000);
    expect(m.holds[0]).toMatchObject({ kind: 'volume', type: 'volume' });
  });
});

describe('error handling', () => {
  it('has copy for every failure, and hides the feature only when it can never work here', () => {
    expect(visionErrorCopy({ code: 'cancelled', message: '' })).toBeNull();
    for (const code of ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'images_unavailable']) {
      expect(visionErrorCopy({ code, message: '' })!.hide, code).toBe(true);
    }
    for (const code of ['rate_limited', 'session_expired', 'invalid_json', 'empty_completion', 'upstream_error', 'something_new']) {
      const c = visionErrorCopy({ code, message: '' })!;
      expect(c.hide, code).toBe(false);
      expect(c.retry, code).toBe(true);
    }
    for (const code of ['image_rejected', 'refused', 'invalid_request', 'prompt_too_large', 'transform_error', 'queue_overflow']) {
      expect(visionErrorCopy({ code, message: '' })!.retry, code).toBe(false);
    }
    expect(visionErrorCopy(new VisionError('count', '1 holds'))!.retry).toBe(true);
  });

  it('normalises whatever a call rejects with', () => {
    expect(asSampleError({ code: 'rate_limited', message: 'slow down', text: 'partial' })).toEqual({ code: 'rate_limited', message: 'slow down', text: 'partial' });
    expect(asSampleError(new Error('boom')).code).toBe('upstream_error');
    expect(asSampleError('weird').code).toBe('upstream_error');
  });
});

describe('finding the capability', () => {
  const g = globalThis as unknown as { claude?: unknown };
  afterEach(() => {
    delete g.claude;
  });

  it('is absent outside claude.ai', async () => {
    expect(await resolveSample()).toBeNull();
  });

  it('is absent when the view cannot send images', async () => {
    const fn = Object.assign(async () => ({ text: '', truncated: false }), { json: async () => ({}), limits: async () => ({ maxPromptBytes: 262144 }) });
    g.claude = { use: async () => fn };
    expect(await resolveSample()).toBeNull();
    g.claude = { use: async () => null };
    expect(await resolveSample()).toBeNull();
    g.claude = { use: async () => Promise.reject(new Error('no')) };
    expect(await resolveSample()).toBeNull();
  });

  it('resolves with image limits when images are declared', async () => {
    const images = { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png'] };
    const fn = Object.assign(async () => ({ text: '', truncated: false }), { json: async () => ({}), limits: async () => ({ maxPromptBytes: 262144, images }) });
    g.claude = { use: async (n: string) => (n === 'sample' ? fn : null) };
    const a = await resolveSample();
    expect(a?.images).toEqual(images);
  });
});

import { describe, expect, it } from 'vitest';
import { ExertionDirector, VOCAL_GAP, type ExertMoment } from './exertion';

/** Deterministic RNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HARD: ExertMoment[] = ['move-overload', 'reach-edge', 'slip', 'dyno-start', 'dyno-catch', 'pump-warning'];
const SOFT: ExertMoment[] = ['overload', 'shake'];

describe('exertion director (owner: effort audio was annoying)', () => {
  it('never voices two efforts within the 4 s minimum, even when hard moments are spammed', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed);
      const d = new ExertionDirector(r);
      const vocals: number[] = [];
      for (let t = 0; t < 300; t += 0.1) {
        const m = HARD[Math.floor(r() * HARD.length)];
        const a = d.decide(t, m, r());
        if (a.vocal) vocals.push(t);
      }
      expect(vocals.length).toBeGreaterThan(10);
      for (let i = 1; i < vocals.length; i++) expect(vocals[i] - vocals[i - 1]).toBeGreaterThanOrEqual(VOCAL_GAP.min - 1e-9);
    }
  });

  it('draws a fresh random cooldown in the 4–8 s range (not a fixed beat)', () => {
    const d = new ExertionDirector(rng(7));
    const vocals: number[] = [];
    for (let t = 0; t < 600; t += 0.05) if (d.decide(t, 'move-overload', 0.5).vocal) vocals.push(t);
    const gaps = vocals.slice(1).map((v, i) => v - vocals[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(VOCAL_GAP.min - 1e-9);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(VOCAL_GAP.max + 0.06);
    // varied: not all gaps the same
    expect(new Set(gaps.map((g) => g.toFixed(1))).size).toBeGreaterThan(5);
  });

  it('only breathes on soft moments: no grunt for hanging still or the tremor starting', () => {
    const d = new ExertionDirector(rng(3));
    for (let t = 0; t < 120; t += 0.25) {
      for (const m of SOFT) {
        const a = d.decide(t, m, 1);
        expect(a.vocal).toBeNull();
        expect(a.breathe).toBeGreaterThan(0);
      }
    }
  });

  it('a hard moment inside the cooldown breathes harder instead', () => {
    const d = new ExertionDirector(rng(5));
    expect(d.decide(10, 'move-overload', 0.6).vocal).toBe('effort');
    const a = d.decide(11, 'reach-edge', 0.9);
    expect(a.vocal).toBeNull();
    expect(a.breathe).toBeGreaterThan(0);
  });

  it('a dyno launch is voiced and its catch only breathes out right after', () => {
    const d = new ExertionDirector(rng(9));
    expect(d.decide(50, 'dyno-start', 1).vocal).toBe('effort');
    const c = d.decide(50.6, 'dyno-catch', 0.8);
    expect(c.vocal).toBeNull();
    expect(c.breath).toBe('exhale');
  });

  it('a pump warning is heavy breathing, and slips gasp (not grunt)', () => {
    const d = new ExertionDirector(rng(11));
    const p = d.decide(5, 'pump-warning', 0.7);
    expect(p.vocal).toBeNull();
    expect(p.breathe).toBeGreaterThan(0.5);
    expect(d.decide(20, 'slip', 0.5).vocal).toBe('gasp');
  });
});

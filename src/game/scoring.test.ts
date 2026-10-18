import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { generateBoulder, generateRopeRoute } from './generator';
import { fontGrade, gradeColor, gradeLabel } from './grades';
import { parTime, runGradeFor, scoreRope, scoreSend } from './scoring';

describe('scoreSend', () => {
  it('base points are 100 · (grade + 1)', () => {
    const s = scoreSend({ grade: 4, time: 999, par: 30, flash: false, streak: 0, hintsUsed: 0 });
    expect(s.points).toBe(500);
    expect(s.breakdown).toEqual([{ label: 'V4 send', value: 500 }]);
  });

  it('applies flash, speed, hints and streak, and the breakdown sums to the total', () => {
    const flash = scoreSend({ grade: 2, time: 999, par: 30, flash: true, streak: 0, hintsUsed: 0 });
    expect(flash.points).toBe(450);
    const fast = scoreSend({ grade: 2, time: 10, par: 30, flash: false, streak: 0, hintsUsed: 0 });
    expect(fast.points).toBe(450); // ≤ 40 % of par → full +50 %
    const half = scoreSend({ grade: 2, time: 21, par: 30, flash: false, streak: 0, hintsUsed: 0 });
    expect(half.points).toBe(375);
    const streak = scoreSend({ grade: 2, time: 999, par: 30, flash: false, streak: 4, hintsUsed: 0 });
    expect(streak.points).toBe(600); // ×2
    const hints = scoreSend({ grade: 2, time: 999, par: 30, flash: false, streak: 0, hintsUsed: 2 });
    expect(hints.points).toBe(150);
    expect(scoreSend({ grade: 2, time: 999, par: 30, flash: false, streak: 0, hintsUsed: 9 }).points).toBe(0);
    const all = scoreSend({ grade: 6, time: 18, par: 45, flash: true, streak: 3, hintsUsed: 1 });
    expect(all.breakdown.reduce((a, b) => a + b.value, 0)).toBe(all.points);
    expect(Number.isInteger(all.points)).toBe(true);
    expect(all.breakdown.map((b) => b.label)).toEqual(['V6 send', 'Flash', 'Speed', 'Hints ×1', 'Streak ×1.75']);
  });
});

describe('parTime + runGradeFor + scoreRope', () => {
  it('par grows with the problem', { timeout: 60_000 }, () => {
    const easy = parTime(generateBoulder({ seed: 1, grade: 0 }));
    const hard = parTime(generateBoulder({ seed: 1, grade: 10 }));
    const rope = parTime(generateRopeRoute({ seed: 1, grade: 3 }));
    expect(easy).toBeGreaterThan(15);
    expect(easy).toBeLessThan(120);
    expect(hard).toBeGreaterThan(easy * 0.8);
    expect(rope).toBeGreaterThan(easy * 2);
  });

  it('Send Train starts at V0–V1 and climbs about a grade every 1.5 sends', () => {
    const rng = new Rng(9);
    for (let k = 0; k < 50; k++) expect(runGradeFor(0, rng)).toBeLessThanOrEqual(2);
    const at = (streak: number) => {
      let s = 0;
      for (let k = 0; k < 400; k++) s += runGradeFor(streak, rng);
      return s / 400;
    };
    expect(at(0)).toBeLessThan(1);
    expect(at(6)).toBeGreaterThan(3.5);
    expect(at(6)).toBeLessThan(5.5);
    expect(at(12)).toBeGreaterThan(7.5);
    for (let k = 0; k < 100; k++) expect(runGradeFor(100, rng)).toBeLessThanOrEqual(12);
  });

  it('rope score rewards height, clips and the top, and costs falls', () => {
    const a = scoreRope({ heightM: 7, clips: 3, topped: false, falls: 0, grade: 3 });
    const b = scoreRope({ heightM: 14, clips: 8, topped: true, falls: 0, grade: 3 });
    const c = scoreRope({ heightM: 14, clips: 8, topped: true, falls: 2, grade: 3 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBe(b - 300);
    expect(scoreRope({ heightM: 0, clips: 0, topped: false, falls: 5, grade: 0 })).toBe(0);
    expect(Number.isInteger(a)).toBe(true);
  });
});

describe('grades', () => {
  it('labels V-grades and Font equivalents', () => {
    expect(gradeLabel(0)).toBe('V0');
    expect(gradeLabel(12)).toBe('V12');
    expect(gradeLabel(15)).toBe('V12');
    expect(fontGrade(0)).toBe('4');
    expect(fontGrade(3)).toBe('6A+');
    expect(fontGrade(6)).toBe('7A');
    expect(fontGrade(11)).toBe('8A');
    expect(gradeColor(5)).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

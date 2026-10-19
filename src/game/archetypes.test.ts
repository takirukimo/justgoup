// Route archetypes (Phase B, ROADMAP B1/B4/B5; research §3.3–§3.5): every style sets the wall, the line,
// the holds and the signature move it claims, the label describes the wall the player sees, runs rotate
// archetypes, the daily problem follows the weekday, and hold variety comes from the research catalogue.

import { describe, expect, it } from 'vitest';
import type { BoulderDef, RouteStyle } from '../core/types';
import { GEN } from '../config/tuning';
import { wallLabel } from '../ui/format';
import { dailyBoulder, dailyGrade, generateBoulder } from './generator';
import { availableStyles, dailyStyle, runStyle, STYLES } from './archetypes';
import { planBetaDetailed } from './solver';
import { contactPoint, usableByHand } from './holds';
import { profileOf, angleAt, wallTopHeight } from './wall-profile';
import { ClimberSim } from './climber-sim';
import { autoClimb } from './bot';

const route = (b: BoulderDef) => b.holds.filter((h) => h.role !== 'deco');
const hands = (b: BoulderDef) => b.holds.filter((h) => usableByHand(h) && h.role !== 'deco');
const startX = (b: BoulderDef) => {
  const s = b.holds.filter((h) => h.role === 'start');
  return s.reduce((a, h) => a + h.x, 0) / s.length;
};
const topOf = (b: BoulderDef) => b.holds.find((h) => h.role === 'top')!;

/** A few boulders of one style across the grades. */
function some(style: RouteStyle, profiles = false, grades = [1, 4, 7, 10]): BoulderDef[] {
  return grades.map((g, k) => generateBoulder({ seed: 4242 + k * 131 + g, grade: g, style, profiles }));
}

describe('archetypes — the wall and the line each style claims', () => {
  it('the multi-angle switch ships ON (the renderer folds the panels); without it profile styles fall back', () => {
    expect(GEN.profiles).toBe(true);
    expect(availableStyles(false)).not.toContain('cave');
    expect(availableStyles(true)).toContain('cave');
    // the shipped default: a cave is a folded wall with a roof
    const c = generateBoulder({ seed: 7, grade: 6, style: 'cave' });
    expect(c.style).toBe('cave');
    expect(c.profile!.length).toBeGreaterThanOrEqual(3);
    expect(c.wallAngle).toBeGreaterThanOrEqual(65);
    // profiles off (per problem): the closest flat relative, a steep overhang
    const b = generateBoulder({ seed: 7, grade: 6, style: 'cave', profiles: false });
    expect(b.profile).toBeUndefined();
    expect(b.style).toBe('overhang');
    expect(b.wallAngle).toBeGreaterThanOrEqual(25);
    // an explicit wall angle is a flat wall, profiles or not
    const f = generateBoulder({ seed: 7, grade: 6, style: 'cave', profiles: true, wallAngle: 30 });
    expect(f.profile).toBeUndefined();
    expect(f.wallAngle).toBe(30);
  });

  it('vertical / slab / overhang / compression set the wall angle their label says', { timeout: 120_000 }, () => {
    for (const b of some('vertical')) {
      expect(b.style).toBe('vertical');
      expect(Math.abs(b.wallAngle)).toBeLessThan(6);
      expect(wallLabel(b).text).toBe('VERTICAL');
    }
    for (const b of some('slab')) {
      expect(b.style).toBe('slab');
      expect(b.wallAngle).toBeLessThanOrEqual(-8);
      expect(wallLabel(b).kind).toBe('SLAB');
    }
    for (const b of some('overhang')) {
      expect(b.style).toBe('overhang');
      expect(b.wallAngle).toBeGreaterThanOrEqual(20);
      expect(b.wallAngle).toBeLessThanOrEqual(45);
      expect(wallLabel(b).kind).toBe('OVERHANG');
    }
    for (const b of some('compression')) {
      expect(b.style).toBe('compression');
      expect(b.wallAngle).toBeGreaterThanOrEqual(15);
      expect(wallLabel(b).text).toMatch(/^COMPRESSION · OVERHANG/);
      // wide squeezes: the hands work far apart (pinches, inward sidepulls, hand volumes)
      const hs = hands(b).filter((h) => h.role === 'hand');
      const inward = hs.filter((h) => Math.abs(Math.cos(h.angle)) > 0.5 || h.type === 'pinch' || h.type === 'volume');
      expect(inward.length / hs.length).toBeGreaterThan(0.3);
    }
    // overhangs get steeper with the grade (research: V0–2 to 20°, V6–8 20–50°)
    const ov = some('overhang', false, [1, 10]);
    expect(ov[1].wallAngle).toBeGreaterThan(ov[0].wallAngle);
  });

  it('traverse: across the wall to a top on the far side; diagonal: a rising line; zigzag: the line switches', { timeout: 120_000 }, () => {
    for (const b of some('traverse')) {
      expect(b.style).toBe('traverse');
      expect(Math.abs(topOf(b).x - startX(b))).toBeGreaterThanOrEqual(2.2);
      expect(wallLabel(b).text).toMatch(/^TRAVERSE · /);
      // the hand holds spread along the wall, not up it
      const hs = hands(b);
      const xs = hs.map((h) => h.x);
      const ys = hs.map((h) => h.y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys));
    }
    for (const b of some('diagonal')) {
      expect(b.style).toBe('diagonal');
      expect(Math.abs(topOf(b).x - startX(b))).toBeGreaterThan(0.9);
    }
    for (const b of some('zigzag')) {
      expect(b.style).toBe('zigzag');
      // the line (mean x of the hand holds per 0.6 m band) changes direction at least once
      const hs = hands(b).sort((a, c) => a.y - c.y);
      const bands: number[] = [];
      for (let y = 1.3; y < b.height; y += 0.6) {
        const inBand = hs.filter((h) => h.y >= y && h.y < y + 0.6);
        if (inBand.length) bands.push(inBand.reduce((a, h) => a + h.x, 0) / inBand.length);
      }
      let turns = 0;
      for (let i = 2; i < bands.length; i++) if ((bands[i] - bands[i - 1]) * (bands[i - 1] - bands[i - 2]) < 0) turns++;
      expect(turns, b.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('dyno: the verified beta throws (a deadpoint or a double dyno) and the label says DYNO', { timeout: 120_000 }, () => {
    for (const b of some('dyno', false, [2, 5, 8, 11])) {
      expect(b.style).toBe('dyno');
      expect(wallLabel(b).text).toMatch(/^DYNO · /);
      const plan = planBetaDetailed(b, { maxNodes: 900 });
      expect(plan).not.toBeNull();
      const throws = plan!.steps.filter((s) => s.move.dyno);
      expect(throws.length).toBeGreaterThanOrEqual(1);
      // research §2.5: the throw goes past the static reach toward a good hold
      for (const s of throws) expect(s.dyno!.rise).toBeGreaterThan(0.05);
    }
  });

  it('cave (profiles on): kicker → steep → roof → lip, roof hooks, top on the lip; mixed folds too', { timeout: 200_000 }, () => {
    for (const b of some('cave', true)) {
      expect(b.style).toBe('cave');
      const prof = profileOf(b)!;
      expect(prof).not.toBeNull();
      expect(prof.n).toBe(4);
      expect(prof.ang[0]).toBe(0);
      expect(prof.maxAngle).toBeGreaterThanOrEqual(65);
      expect(b.wallAngle).toBe(prof.maxAngle);
      // a low cave: the lip is ≈2.3–3.5 m above the floor (lower the steeper the roof)
      expect(wallTopHeight(prof, b.height)).toBeLessThan(3.6);
      // the top sits on the lip panel; route holds live under the roof
      const t = topOf(b);
      expect(angleAt(prof, t.y)).toBeLessThan(30);
      expect(route(b).some((h) => angleAt(prof, h.y) >= 60)).toBe(true);
      expect(wallLabel(b).text).toMatch(/^CAVE · MIXED/);
      expect(planBetaDetailed(b, { maxNodes: 900 })).not.toBeNull();
    }
    for (const b of some('mixed', true)) {
      expect(b.style).toBe('mixed');
      const prof = profileOf(b);
      expect(prof).not.toBeNull();
      expect(prof!.n).toBeGreaterThanOrEqual(2);
      expect(wallTopHeight(prof!, b.height)).toBeLessThan(4.6);
      expect(wallLabel(b).kind).toBe('MIXED');
    }
    // without profiles 'mixed' is a flat wall with a mixed hold set
    for (const b of some('mixed', false, [3, 8])) expect(b.profile).toBeUndefined();
  });

  it('every archetype is deterministic per (seed, grade, style, profiles)', { timeout: 120_000 }, () => {
    for (const style of STYLES) {
      const a = generateBoulder({ seed: 99, grade: 5, style, profiles: style === 'cave' });
      const b = generateBoulder({ seed: 99, grade: 5, style, profiles: style === 'cave' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('profiled generation uses no engine-dependent math either', { timeout: 120_000 }, () => {
    const banned = ['random', 'sin', 'cos', 'tan', 'atan', 'atan2', 'hypot', 'exp', 'pow', 'log'] as const;
    const m = Math as unknown as Record<string, unknown>;
    const saved = banned.map((k) => m[k]);
    for (const k of banned)
      m[k] = () => {
        throw new Error(`Math.${k} used during generation`);
      };
    try {
      const c = generateBoulder({ seed: 5150, grade: 6, style: 'cave', profiles: true });
      const t = generateBoulder({ seed: 5150, grade: 4, style: 'traverse' });
      const d = generateBoulder({ seed: 5150, grade: 6, style: 'dyno' });
      expect(c.profile).toBeTruthy();
      expect(t.style).toBe('traverse');
      expect(d.style).toBe('dyno');
    } finally {
      banned.forEach((k, i) => (m[k] = saved[i]));
    }
  });
});

describe('archetypes — rotation (Send Train) and the daily problem', () => {
  it('a run never repeats the archetype of the problem before, cycles through all of them, starts gentle', () => {
    for (const profiles of [false, true]) {
      const all = availableStyles(profiles);
      for (const seed of [1, 77, 123456, 0x7ffffffe]) {
        const seq = Array.from({ length: 60 }, (_, i) => runStyle(seed, i, profiles));
        for (let i = 1; i < seq.length; i++) expect(seq[i], `${seed}@${i}`).not.toBe(seq[i - 1]);
        // the first problems skip the technical archetypes
        for (const s of seq.slice(0, 3)) expect(['dyno', 'compression', 'cave']).not.toContain(s);
        // every archetype shows up within the first two decks
        expect(new Set(seq.slice(0, all.length * 2)).size).toBe(all.length);
        // deterministic, and independent of how far the run has got
        expect(runStyle(seed, 17, profiles)).toBe(seq[17]);
      }
      // different runs deal different orders
      const a = Array.from({ length: 10 }, (_, i) => runStyle(5, i, profiles)).join();
      const b = Array.from({ length: 10 }, (_, i) => runStyle(6, i, profiles)).join();
      expect(a).not.toBe(b);
    }
  });

  it('generateBoulder({ run }) sets the rotation archetype', { timeout: 120_000 }, () => {
    const seq: string[] = [];
    for (let i = 0; i < 5; i++) {
      const b = generateBoulder({ seed: 3000 + i * 17, grade: Math.min(12, i), run: { seed: 4711, index: i } });
      expect(b.style).toBe(runStyle(4711, i, GEN.profiles));
      seq.push(b.style!);
    }
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it('the daily problem rotates by weekday (consecutive days differ) and its label matches', { timeout: 200_000 }, () => {
    // 2026-10-19 is a Monday
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 19 + i));
      return d.toISOString().slice(0, 10);
    });
    const styles = days.map((k) => dailyStyle(k, false));
    for (let i = 1; i < styles.length; i++) expect(styles[i]).not.toBe(styles[i - 1]);
    expect(new Set(styles).size).toBeGreaterThanOrEqual(8);
    expect(styles[1]).toBe('slab');
    expect(styles[2]).toBe('traverse');
    expect(styles[4]).toBe('dyno');
    expect(styles[5]).toBe('compression');
    expect(styles[6]).toBe('overhang');
    expect(dailyStyle(days[6], true)).toBe('cave');
    for (const k of days.slice(0, 7)) {
      const b = dailyBoulder(k);
      // the daily problem follows the shipped switch (profiles ON: Sunday is a cave)
      expect(b.style).toBe(dailyStyle(k, GEN.profiles));
      expect(b.grade).toBe(dailyGrade(k));
      const label = wallLabel(b);
      if (b.style === 'slab') expect(label.kind).toBe('SLAB');
      if (b.style === 'traverse') expect(label.style).toBe('TRAVERSE');
      if (b.style === 'dyno') expect(label.style).toBe('DYNO');
      if (b.style === 'compression') expect(label.style).toBe('COMPRESSION');
      if (b.style === 'cave') expect(label.style).toBe('CAVE');
    }
  });
});

describe('archetypes — hold variety (research §3.3 catalogue)', () => {
  it('shapes, edge depths, lips and pocket fingers come in the ranges of each grade band', { timeout: 200_000 }, () => {
    const shapes = new Map<string, number>();
    const depth: Record<'easy' | 'hard', number[]> = { easy: [], hard: [] };
    const lips: Record<'easy' | 'hard', number[]> = { easy: [], hard: [] };
    const fingers: Record<'easy' | 'hard', number[]> = { easy: [], hard: [] };
    for (let i = 0; i < 40; i++) {
      const grade = i % 2 ? 1 + (i % 3) : 8 + (i % 5);
      const band = grade <= 3 ? 'easy' : 'hard';
      const b = generateBoulder({ seed: 777 + i * 53, grade });
      for (const h of b.holds) {
        if (h.shape) shapes.set(h.shape, (shapes.get(h.shape) ?? 0) + 1);
        if (h.role === 'deco') continue;
        if ((h.type === 'edge' || h.type === 'crimp') && usableByHand(h)) {
          expect(h.edgeDepthMm).toBeGreaterThan(3);
          expect(h.edgeDepthMm).toBeLessThan(50);
          depth[band].push(h.edgeDepthMm!);
        }
        if (h.type === 'sloper') {
          expect(h.lipAngle).toBeLessThanOrEqual(-14);
          expect(h.lipAngle).toBeGreaterThanOrEqual(-44);
          lips[band].push(h.lipAngle!);
        }
        if (h.type === 'pocket') fingers[band].push(h.fingers!);
        if (h.shape === 'micro') {
          expect(grade).toBeGreaterThanOrEqual(7);
          expect(h.edgeDepthMm).toBeLessThanOrEqual(9);
        }
      }
    }
    for (const s of ['bucket', 'horn', 'rail', 'micro', 'chip', 'dual-tex', 'wood']) expect(shapes.get(s) ?? 0, s).toBeGreaterThan(0);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    // harder problems: shallower edges, slopier slopers, fewer fingers in the pockets
    expect(avg(depth.hard)).toBeLessThan(avg(depth.easy));
    if (lips.easy.length && lips.hard.length) expect(avg(lips.hard)).toBeLessThan(avg(lips.easy));
    if (fingers.easy.length && fingers.hard.length) expect(avg(fingers.hard)).toBeLessThan(avg(fingers.easy));
  });
});

describe('archetypes — the bot sends every one of them', () => {
  it('through the player input API, with profiles off and on (throws on the dyno, roof hooks in the cave)', { timeout: 300_000 }, () => {
    const failed: string[] = [];
    for (const profiles of [false, true])
      for (const style of availableStyles(profiles))
        for (const grade of [3, 7]) {
          const b = generateBoulder({ seed: 8100 + grade * 7 + STYLES.indexOf(style) * 131, grade, style, profiles });
          expect(b.style).toBe(style);
          const sim = new ClimberSim(b);
          const r = autoClimb(sim);
          if (!r.sent) failed.push(`${style} V${grade} (profiles ${profiles}): ${r.bot.log.slice(-3).join('; ')}`);
          // (a dyno problem's signature move: a throw, or from V6 now and then a figure 4)
          else if (style === 'dyno') expect(r.bot.throws + sim.getStats().figure4s, `${b.id} throws / figure 4s`).toBeGreaterThanOrEqual(1);
        }
    expect(failed).toEqual([]);
  });
});

describe('archetypes — holds bolted onto volumes (GEN.holdsOnVolumes)', () => {
  it('ships ON (the renderer seats them on the volume face); without it no hold is mounted', { timeout: 120_000 }, () => {
    expect(GEN.holdsOnVolumes).toBe(true);
    const mounted = (holdsOnVolumes?: boolean) =>
      [4, 9, 4, 9, 4, 9].map((g, k) => generateBoulder({ seed: 4242 + k * 131 + g, grade: g, style: 'compression', ...(holdsOnVolumes === undefined ? {} : { holdsOnVolumes }) })).some((b) => b.holds.some((h) => h.onVolume));
    expect(mounted()).toBe(true);
    expect(mounted(false)).toBe(false);
  });

  it('compression squeezes sit on route volumes; a foot by the hold takes it, on top of the volume the volume', { timeout: 200_000 }, () => {
    let mounted = 0;
    for (const grade of [4, 6, 8, 10]) {
      const b = generateBoulder({ seed: 300 + grade * 13, grade, style: 'compression', holdsOnVolumes: true });
      const byId = new Map(b.holds.map((h) => [h.id, h] as const));
      const sim = new ClimberSim(b);
      for (const h of b.holds.filter((x) => x.onVolume)) {
        mounted++;
        const v = byId.get(h.onVolume!)!;
        // a route volume (feet may stand on it, hands use the hold), the hold on its face
        expect(v.type).toBe('volume');
        expect(v.role).toBe('foot');
        expect(usableByHand(h)).toBe(true);
        expect(Math.hypot(v.x - h.x, v.y - h.y)).toBeLessThan(v.size);
        // the volume's own foot spot stays out of the mounted hold's snap range (unambiguous targets)
        const spot = contactPoint(v, 2, false, { x: 0, y: 0 });
        expect(Math.hypot(spot.x - h.x, spot.y - h.y) - h.size).toBeGreaterThan(0.11);
        // the sim's snap rule: a foot released on the hold takes the hold, not the volume under it
        const onHold = contactPoint(h, 2, false, { x: 0, y: 0 });
        const snapped = sim.snapCandidate('LF', onHold) ?? sim.snapCandidate('RF', onHold);
        if (snapped) expect(snapped.id).not.toBe(v.id);
      }
      const r = autoClimb(sim);
      expect(r.sent, `${b.id}: ${r.bot.log.join('; ')}`).toBe(true);
    }
    expect(mounted).toBeGreaterThanOrEqual(3);
  });
});

import { describe, expect, it } from 'vitest';
import { GAME } from '../config/tuning';
import { ROUTE_COLORS } from '../config/brand';
import { dailyBoulder, dailyGrade, generateBoulder, generateRopeRoute, todayKey, tutorialBoulder, TUTORIAL_SEQUENCE } from './generator';
import { planBeta, planBetaDetailed } from './solver';
import { nominalCapacity, usableByHand } from './holds';
import { leadProfile } from './archetypes';
import { angleAt, profileOf, wallTopHeight } from './wall-profile';
import { Rng } from '../core/rng';
import { ClimberSim } from './climber-sim';
import { autoClimb } from './bot';

const routeHolds = (b: ReturnType<typeof generateBoulder>) => b.holds.filter((h) => h.role !== 'deco');

describe('generator — determinism + structure', () => {
  it('same seed + grade → identical boulder JSON; different seeds differ', { timeout: 60_000 }, () => {
    const a = generateBoulder({ seed: 12345, grade: 5 });
    const b = generateBoulder({ seed: 12345, grade: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateBoulder({ seed: 12346, grade: 5 });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
    const r1 = generateRopeRoute({ seed: 99, grade: 3 });
    const r2 = generateRopeRoute({ seed: 99, grade: 3 });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('generation uses no engine-dependent math (bit-identical on every device)', { timeout: 60_000 }, () => {
    const banned = ['random', 'sin', 'cos', 'tan', 'atan', 'atan2', 'hypot', 'exp', 'pow', 'log'] as const;
    const m = Math as unknown as Record<string, unknown>;
    const saved = banned.map((k) => m[k]);
    for (const k of banned)
      m[k] = () => {
        throw new Error(`Math.${k} used during generation`);
      };
    try {
      const a = generateBoulder({ seed: 31337, grade: 6 });
      const r = generateRopeRoute({ seed: 31337, grade: 4 });
      const d = dailyBoulder('2026-10-24');
      expect(planBeta(a, { maxNodes: 900 })).not.toBeNull();
      expect(r.quickdraws!.length).toBeGreaterThan(5);
      expect(d.grade).toBe(6);
    } finally {
      banned.forEach((k, i) => (m[k] = saved[i]));
    }
  });

  it('builds a complete, well-formed problem', { timeout: 60_000 }, () => {
    for (const grade of [0, 3, 6, 9, 12]) {
      const b = generateBoulder({ seed: 2024 + grade, grade });
      expect(b.mode).toBe('boulder');
      expect(b.grade).toBe(grade);
      expect(b.width).toBe(GAME.boulderWall.width);
      if (b.profile) {
        // a folded wall (GEN.profiles): the sim's y runs along the surface, which is longer than the wall
        // is tall; it never stands taller than the flat boulder wall
        expect(b.height).toBeGreaterThan(b.profile[b.profile.length - 1].y0);
        expect(wallTopHeight(profileOf(b)!)).toBeLessThanOrEqual(GAME.boulderWall.height + 0.01);
      } else expect(b.height).toBe(GAME.boulderWall.height);
      expect(b.name.length).toBeGreaterThan(3);
      const ids = new Set(b.holds.map((h) => h.id));
      expect(ids.size).toBe(b.holds.length);
      const starts = b.holds.filter((h) => h.role === 'start');
      expect(starts.length).toBeGreaterThanOrEqual(1);
      expect(starts.length).toBeLessThanOrEqual(2);
      for (const s of starts) {
        expect(s.y).toBeGreaterThanOrEqual(1.3);
        expect(s.y).toBeLessThanOrEqual(1.85);
      }
      const tops = b.holds.filter((h) => h.role === 'top');
      expect(tops.length).toBe(1);
      expect(tops[0].size).toBeGreaterThanOrEqual(0.07);
      expect(['jug', 'edge']).toContain(tops[0].type);
      // a traverse finishes on the far side of the wall, the others at the top
      if (b.style === 'traverse') expect(tops[0].y).toBeGreaterThan(2.3);
      else expect(tops[0].y).toBeGreaterThan(b.height - 0.5);
      expect(b.style).toBeTruthy();
      expect(b.startFeet?.LF && b.startFeet?.RF).toBeTruthy();
      const feet = [b.startFeet!.LF!, b.startFeet!.RF!].map((id) => b.holds.find((h) => h.id === id)!);
      for (const f of feet) {
        expect(f.y).toBeGreaterThanOrEqual(0.25);
        expect(f.y).toBeLessThanOrEqual(0.8);
      }
      // other routes' holds fill the wall, all inside the panel
      const deco = b.holds.filter((h) => h.role === 'deco' && h.type !== 'volume');
      expect(deco.length).toBeGreaterThanOrEqual(40);
      expect(deco.length).toBeLessThanOrEqual(90);
      expect(deco.every((h) => h.color !== b.color)).toBe(true);
      // wall volumes (deco or route feet); compression problems add hand volumes on top, and route volumes
      // that carry a bolted-on hand hold (GEN.holdsOnVolumes) come with that hold's move
      const carriers = new Set(b.holds.map((h) => h.onVolume).filter((v) => v !== undefined));
      const volumes = b.holds.filter((h) => h.type === 'volume' && h.role !== 'hand' && !carriers.has(h.id));
      expect(volumes.length).toBeGreaterThanOrEqual(1);
      expect(volumes.length).toBeLessThanOrEqual(4);
      for (const h of b.holds) {
        expect(Math.abs(h.x)).toBeLessThanOrEqual(b.width / 2);
        expect(h.y).toBeGreaterThan(0);
        expect(h.y).toBeLessThan(b.height);
        expect(h.size).toBeGreaterThan(0);
      }
      // route holds share the route colour; deco holds don't overlap route holds
      for (const h of routeHolds(b)) if (h.type !== 'volume') expect(h.color).toBe(b.color);
      for (const d of deco)
        for (const r of routeHolds(b)) expect(Math.hypot(d.x - r.x, d.y - r.y)).toBeGreaterThan(d.size + r.size + 0.05);
    }
  });

  it('scales difficulty with grade: wall angle, hold types', { timeout: 120_000 }, () => {
    const stats = (grades: number[]) => {
      let angle = 0;
      let jugs = 0;
      let hands = 0;
      let n = 0;
      for (const g of grades)
        for (let k = 0; k < 8; k++) {
          const b = generateBoulder({ seed: 700 + k * 31 + g, grade: g });
          angle += b.wallAngle;
          for (const h of b.holds) if (h.role === 'hand' || h.role === 'start') {
            hands++;
            if (h.type === 'jug') jugs++;
          }
          n++;
        }
      return { angle: angle / n, jugShare: jugs / hands };
    };
    const easy = stats([0, 1, 2]);
    const hard = stats([9, 10, 11, 12]);
    expect(easy.angle).toBeLessThan(10);
    expect(hard.angle).toBeGreaterThan(15);
    expect(easy.jugShare).toBeGreaterThan(hard.jugShare + 0.2);
  });

  it('uses the requested colour and wall angle', () => {
    const b = generateBoulder({ seed: 5, grade: 3, colorIndex: 1, wallAngle: 25, name: 'Ibex Crack' });
    expect(b.color).toBe(ROUTE_COLORS[1].hex);
    expect(b.wallAngle).toBe(25);
    expect(b.name).toBe('Ibex Crack');
  });

  it('lead routes bolt to the EN standard: first ≤ 3.1 m, ≤ 1 m apart to 5 m, ≤ 1.5 m to 8 m, ≤ 2 m above; anchor over the top', { timeout: 120_000 }, () => {
    for (const grade of [0, 4, 8]) {
      const r = generateRopeRoute({ seed: 31 + grade, grade });
      expect(r.mode).toBe('rope');
      expect(r.height).toBe(GAME.ropeWall.height);
      const q = r.quickdraws!;
      // research §3.5: 10–14 draws + the anchor on a 15 m wall
      expect(q.length).toBeGreaterThanOrEqual(10);
      expect(q.length).toBeLessThanOrEqual(15);
      expect(q[0].y).toBeGreaterThanOrEqual(1.6);
      expect(q[0].y).toBeLessThanOrEqual(3.1);
      for (let i = 1; i < q.length - 1; i++) {
        const dy = q[i].y - q[i - 1].y;
        const max = q[i - 1].y < 5 ? 1.0 : q[i - 1].y < 8 ? 1.5 : 2.0;
        expect(dy, `${r.id} q${i}`).toBeGreaterThanOrEqual(0.55);
        expect(dy, `${r.id} q${i}`).toBeLessThanOrEqual(max + 1e-9);
      }
      const top = r.holds.find((h) => h.role === 'top')!;
      const anchor = q[q.length - 1];
      expect(anchor.y).toBeGreaterThan(top.y);
      expect(anchor.y - top.y).toBeLessThan(0.6);
      expect(top.y).toBeGreaterThan(r.height - 1.0);
      // clipping stances: most draws sit at chest height under a positive hand hold beside them (judged on
      // the panel the hold is bolted to: a folded tower's wallAngle is its steepest panel)
      const prof = profileOf(r);
      const at = (y: number) => (prof ? angleAt(prof, y) : r.wallAngle);
      let clipHolds = 0;
      for (const d of q.slice(0, -1))
        if (r.holds.some((h) => usableByHand(h) && h.role !== 'top' && h.y - d.y >= 0.2 && h.y - d.y <= 0.75 && Math.abs(h.x - d.x) < 0.5 && nominalCapacity(h, true, at(h.y)) >= 0.5)) clipHolds++;
      expect(clipHolds / (q.length - 1)).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('lead routes vary: wall angles, lines and hold sets differ between seeds', { timeout: 120_000 }, () => {
    const mixOf = (r: ReturnType<typeof generateRopeRoute>) => {
      const hands = r.holds.filter((h) => h.role === 'hand');
      const share = (t: string) => hands.filter((h) => h.type === t).length / hands.length;
      return ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket'].map(share);
    };
    // flat towers: the hold theme shows as the dominant non-jug hold type, which is not the same on every route
    const flat = [0, 1, 2, 3, 4, 5].map((k) => generateRopeRoute({ seed: 900 + k * 37, grade: 5, profiles: false }));
    expect(new Set(flat.map((r) => r.wallAngle)).size).toBeGreaterThanOrEqual(2);
    const dominant = flat.map(mixOf).map((m) => m.slice(1).indexOf(Math.max(...m.slice(1))));
    expect(new Set(dominant).size).toBeGreaterThanOrEqual(2);
    // the shipped profiled towers: the headwall / roof angles differ, and so do the hold mixes (the steep
    // panels favour jugs and pinches on every theme, so the mix is compared as a whole)
    const routes = [0, 1, 2, 3, 4, 5].map((k) => generateRopeRoute({ seed: 900 + k * 37, grade: 5 }));
    expect(routes.every((r) => r.profile !== undefined)).toBe(true);
    expect(new Set(routes.map((r) => r.wallAngle)).size).toBeGreaterThanOrEqual(2);
    const mix = routes.map(mixOf);
    let spread = 0;
    for (let i = 0; i < mix.length; i++) for (let j = i + 1; j < mix.length; j++) spread = Math.max(spread, mix[i].reduce((a, v, t) => a + Math.abs(v - mix[j][t]), 0));
    expect(spread).toBeGreaterThanOrEqual(0.3);
    // the crux (55–75 % of the height) is set on poorer holds than the start (below 4.2 m)
    // (each hold judged on the panel it is bolted to: a folded tower's wallAngle is its steepest panel)
    const mean = (pick: (r: (typeof routes)[number], y: number) => boolean) => {
      let sum = 0;
      let n = 0;
      for (const r of routes) {
        const prof = profileOf(r);
        for (const h of r.holds)
          if (h.role === 'hand' && pick(r, h.y)) {
            sum += nominalCapacity(h, true, prof ? angleAt(prof, h.y) : r.wallAngle);
            n++;
          }
      }
      return sum / Math.max(1, n);
    };
    expect(mean((_r, y) => y < 4.2)).toBeGreaterThan(mean((r, y) => y > 0.55 * r.height && y < 0.75 * r.height));
  });
});

describe('generator — lead tower variety', () => {
  it('lines vary: some routes cross the wall on a diagonal, others meander or zigzag up the middle', { timeout: 120_000 }, () => {
    const dx = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
      const r = generateRopeRoute({ seed: 4400 + k * 53, grade: 2 + (k % 5) });
      const starts = r.holds.filter((h) => h.role === 'start');
      const top = r.holds.find((h) => h.role === 'top')!;
      return Math.abs(top.x - starts.reduce((a, h) => a + h.x, 0) / starts.length);
    });
    expect(dx.some((d) => d >= 2.0), dx.join()).toBe(true);
    expect(dx.some((d) => d < 1.2), dx.join()).toBe(true);
  });

  it('profiled towers (GEN.profiles): vertical start → steepening headwall → roof crux at 55–75 % → eased lip → finish', () => {
    for (let k = 0; k < 40; k++) {
      const grade = k % 11;
      const { panels, length } = leadProfile(grade, new Rng(77 + k * 31), GAME.ropeWall.height);
      expect(panels.length).toBeGreaterThanOrEqual(5);
      expect(panels[0].angle).toBeLessThanOrEqual(5);
      expect(length).toBeGreaterThanOrEqual(GAME.ropeWall.height - 0.01);
      // the crux is the steepest panel: 45° (easy) … 60°+ (hard), starting at 55–75 % of the route
      let ci = 0;
      for (let i = 1; i < panels.length; i++) if (panels[i].angle > panels[ci].angle) ci = i;
      expect(ci).toBe(3);
      expect(panels[ci].angle).toBeGreaterThanOrEqual(grade >= 8 ? 55 : 41);
      expect(panels[ci].y0 / length).toBeGreaterThanOrEqual(0.5);
      expect(panels[ci].y0 / length).toBeLessThanOrEqual(0.75);
      // the headwall steepens on the way up; every lip after the crux eases off by ≤ 26° at a time
      for (let i = 1; i <= ci; i++) expect(panels[i].angle).toBeGreaterThan(panels[i - 1].angle - 4);
      for (let i = ci + 1; i < panels.length; i++) {
        expect(panels[i].angle).toBeLessThan(panels[i - 1].angle);
        expect(panels[i - 1].angle - panels[i].angle).toBeLessThanOrEqual(26);
      }
    }
  });

  it('a profiled tower is generated (no ladder fallback) and the bot climbs it clipping every draw', { timeout: 200_000 }, () => {
    const r = generateRopeRoute({ seed: 2718, grade: 4, profiles: true });
    const prof = profileOf(r)!;
    expect(prof).not.toBeNull();
    expect(prof.maxAngle).toBeGreaterThanOrEqual(45);
    // the route climbs through the roof crux, on the reward holds over its lip
    const hands = r.holds.filter((h) => h.role === 'hand');
    expect(hands.some((h) => angleAt(prof, h.y) >= 45)).toBe(true);
    expect(hands.some((h) => h.type !== 'jug')).toBe(true);
    const sim = new ClimberSim(r);
    const res = autoClimb(sim, { maxTime: 900 });
    expect(res.sent, res.bot.log.join('; ')).toBe(true);
    // every draw, the anchor (the topping clip) included
    expect(sim.getState().clipped.length).toBe(r.quickdraws!.length);
  });
});

describe('generator — solvability', () => {
  const boulders = (profiles: boolean) => {
    const fails: string[] = [];
    let genMs = 0;
    let worstGen = 0;
    const styles = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const grade = i % 13;
      const t0 = performance.now();
      const b = generateBoulder({ seed: 10_000 + i * 7919, grade, profiles });
      const dt = performance.now() - t0;
      genMs += dt;
      worstGen = Math.max(worstGen, dt);
      expect(b.grade).toBe(grade);
      styles.set(b.style!, (styles.get(b.style!) ?? 0) + 1);
      if (!profiles) expect(b.profile).toBeUndefined();
      if (!planBeta(b, { maxNodes: 900 })) fails.push(`${b.id} (V${grade}, ${b.style}, ${b.wallAngle}°)`);
    }
    console.info(
      `generateBoulder (profiles ${profiles ? 'on' : 'off'}): ${(genMs / 300).toFixed(0)} ms mean, ${worstGen.toFixed(0)} ms worst; styles ${[...styles].map(([k, v]) => `${k} ${v}`).join(', ')}`,
    );
    return { fails, styles };
  };

  it('300 generated boulders across V0–V12 are all solvable by planBeta() (profiles off)', { timeout: 400_000 }, () => {
    const { fails, styles } = boulders(false);
    expect(fails).toEqual([]);
    expect(styles.has('cave')).toBe(false);
    expect(styles.size).toBeGreaterThanOrEqual(8);
  });

  it('300 generated boulders are all solvable with multi-angle profiles on (caves, mixed walls)', { timeout: 500_000 }, () => {
    const { fails, styles } = boulders(true);
    expect(fails).toEqual([]);
    expect(styles.get('cave') ?? 0).toBeGreaterThan(5);
  });

  it('40 lead routes are solvable and every quickdraw is clippable along the beta (+ 8 profiled towers)', { timeout: 500_000 }, () => {
    const fails: string[] = [];
    let genMs = 0;
    for (let i = 0; i < 48; i++) {
      const profiles = i >= 40;
      const t0 = performance.now();
      const r = generateRopeRoute({ seed: 50_000 + i * 104729, grade: i % 9, profiles });
      genMs += performance.now() - t0;
      if (profiles) expect(r.profile && r.profile.length >= 4).toBe(true);
      const plan = planBetaDetailed(r, { maxNodes: 3000 });
      if (!plan || plan.clipsPlanned !== r.quickdraws!.length) fails.push(r.id);
    }
    console.info(`generateRopeRoute: ${(genMs / 48).toFixed(0)} ms mean over 48 routes`);
    expect(fails).toEqual([]);
  });
});

describe('daily + tutorial', () => {
  it('todayKey is a UTC YYYY-MM-DD key', () => {
    expect(todayKey(new Date(Date.UTC(2026, 0, 5, 23, 59)))).toBe('2026-01-05');
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('daily boulder is the same for everyone and harder through the week', { timeout: 60_000 }, () => {
    const a = dailyBoulder('2026-10-19');
    const b = dailyBoulder('2026-10-19');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.id).toBe('daily-2026-10-19');
    expect(dailyBoulder('2026-10-20').seed).not.toBe(a.seed);
    // 2026-10-19 is a Monday … 2026-10-25 a Sunday
    const week = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map(dailyGrade);
    expect(week[0]).toBe(2);
    expect(week[6]).toBe(7);
    for (let i = 1; i < 7; i++) expect(week[i]).toBeGreaterThanOrEqual(week[i - 1]);
    expect(a.grade).toBe(2);
  });

  it('the tutorial is a friendly CHIRAL-pink jug problem with stable ids', () => {
    const t = tutorialBoulder();
    expect(t.grade).toBe(0);
    expect(t.wallAngle).toBe(0);
    expect(t.color).toBe('#D54051');
    for (const h of t.holds) if (h.role !== 'deco' && h.type !== 'volume') expect(h.color).toBe('#D54051');
    expect(JSON.stringify(tutorialBoulder())).toBe(JSON.stringify(t));
    for (const step of TUTORIAL_SEQUENCE) expect(t.holds.some((h) => h.id === step.holdId)).toBe(true);
    const hands = t.holds.filter((h) => h.role !== 'deco' && usableByHand(h));
    expect(hands.filter((h) => h.type === 'jug').length).toBeGreaterThanOrEqual(hands.length - 1);
    expect(planBeta(t, { maxNodes: 900 })).not.toBeNull();
  });
});

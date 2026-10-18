import { describe, expect, it } from 'vitest';
import { GAME } from '../config/tuning';
import { ROUTE_COLORS } from '../config/brand';
import { dailyBoulder, dailyGrade, generateBoulder, generateRopeRoute, todayKey, tutorialBoulder, TUTORIAL_SEQUENCE } from './generator';
import { planBeta, planBetaDetailed } from './solver';
import { usableByHand } from './holds';

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
      expect(b.height).toBe(GAME.boulderWall.height);
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
      expect(tops[0].y).toBeGreaterThan(b.height - 0.5);
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
      const volumes = b.holds.filter((h) => h.type === 'volume');
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

  it('builds lead routes with quickdraws every ~1.4–2.0 m and the anchor at the top', { timeout: 60_000 }, () => {
    for (const grade of [0, 4, 8]) {
      const r = generateRopeRoute({ seed: 31 + grade, grade });
      expect(r.mode).toBe('rope');
      expect(r.height).toBe(GAME.ropeWall.height);
      const q = r.quickdraws!;
      expect(q.length).toBeGreaterThanOrEqual(6);
      expect(q[0].y).toBeGreaterThanOrEqual(1.85);
      expect(q[0].y).toBeLessThanOrEqual(2.25);
      for (let i = 1; i < q.length - 1; i++) {
        const dy = q[i].y - q[i - 1].y;
        expect(dy).toBeGreaterThanOrEqual(1.39);
        expect(dy).toBeLessThanOrEqual(2.01);
      }
      const top = r.holds.find((h) => h.role === 'top')!;
      const anchor = q[q.length - 1];
      expect(anchor.y).toBeGreaterThan(top.y);
      expect(anchor.y - top.y).toBeLessThan(0.6);
      expect(top.y).toBeGreaterThan(r.height - 1.0);
    }
  });
});

describe('generator — solvability', () => {
  it('300 generated boulders across V0–V12 are all solvable by planBeta()', { timeout: 240_000 }, () => {
    const fails: string[] = [];
    let genMs = 0;
    let worstGen = 0;
    for (let i = 0; i < 300; i++) {
      const grade = i % 13;
      const t0 = performance.now();
      const b = generateBoulder({ seed: 10_000 + i * 7919, grade });
      const dt = performance.now() - t0;
      genMs += dt;
      worstGen = Math.max(worstGen, dt);
      expect(b.grade).toBe(grade);
      if (!planBeta(b, { maxNodes: 900 })) fails.push(`${b.id} (V${grade}, ${b.wallAngle}°)`);
    }
    console.info(`generateBoulder: ${(genMs / 300).toFixed(0)} ms mean, ${worstGen.toFixed(0)} ms worst over 300 boulders`);
    expect(fails).toEqual([]);
  });

  it('30 lead routes are solvable and every quickdraw is clippable along the beta', { timeout: 240_000 }, () => {
    const fails: string[] = [];
    let genMs = 0;
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const r = generateRopeRoute({ seed: 50_000 + i * 104729, grade: i % 9 });
      genMs += performance.now() - t0;
      const plan = planBetaDetailed(r, { maxNodes: 3000 });
      if (!plan || plan.clipsPlanned !== r.quickdraws!.length) fails.push(r.id);
    }
    console.info(`generateRopeRoute: ${(genMs / 30).toFixed(0)} ms mean over 30 routes`);
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

  it('the tutorial is a friendly orange jug problem with stable ids', () => {
    const t = tutorialBoulder();
    expect(t.grade).toBe(0);
    expect(t.wallAngle).toBe(0);
    expect(t.color).toBe('#FF4F1F');
    expect(JSON.stringify(tutorialBoulder())).toBe(JSON.stringify(t));
    for (const step of TUTORIAL_SEQUENCE) expect(t.holds.some((h) => h.id === step.holdId)).toBe(true);
    const hands = t.holds.filter((h) => h.role !== 'deco' && usableByHand(h));
    expect(hands.filter((h) => h.type === 'jug').length).toBeGreaterThanOrEqual(hands.length - 1);
    expect(planBeta(t, { maxNodes: 900 })).not.toBeNull();
  });
});

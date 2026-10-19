import { describe, expect, it } from 'vitest';
import { ClimberSim } from './climber-sim';
import { autoClimb, BetaBot } from './bot';
import { generateBoulder, generateRopeRoute, tutorialBoulder } from './generator';
import { estimateGrade, nextHint, planBeta, planBetaDetailed } from './solver';
import { RopeSystem } from './rope';
import { hold, makeBoulder } from './test-helpers';
import { usableByFoot, usableByHand } from './holds';
import { availableStyles } from './archetypes';

/**
 * Milliseconds of CPU this process has used (falls back to wall-clock time where process.cpuUsage is
 * missing). Timing guards measure CPU time: on a shared box (other test files, other agents, CI
 * neighbours) wall-clock time also counts the slices the scheduler gave to someone else.
 */
function cpuMs(): number {
  const proc = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } }).process;
  if (typeof proc?.cpuUsage === 'function') {
    const u = proc.cpuUsage();
    return (u.user + u.system) / 1000;
  }
  return performance.now();
}

/** ≥ 1: how much busier than one runnable task per core the machine is right now (1 when unknown). */
function loadFactor(): number {
  type OS = { loadavg(): number[]; cpus(): unknown[] };
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const os = proc?.getBuiltinModule?.('node:os') as OS | undefined;
  if (!os) return 1;
  return Math.max(1, os.loadavg()[0] / Math.max(1, os.cpus().length));
}

describe('planBeta', () => {
  it('finds a legal beta that ends with both hands on the top', () => {
    const b = generateBoulder({ seed: 42, grade: 4 });
    const plan = planBeta(b);
    expect(plan).not.toBeNull();
    const byId = new Map(b.holds.map((h) => [h.id, h] as const));
    for (const m of plan!) {
      const h = byId.get(m.holdId);
      if (!h) continue; // smear
      expect(m.limb === 'LH' || m.limb === 'RH' ? usableByHand(h) : usableByFoot(h)).toBe(true);
    }
    // the beta ends with the last hand move onto the top, and both hands' final holds are the top
    const top = b.holds.find((h) => h.role === 'top')!;
    const handMoves = plan!.filter((m) => m.limb === 'LH' || m.limb === 'RH');
    expect(handMoves[handMoves.length - 1].holdId).toBe(top.id);
    for (const hand of ['LH', 'RH'] as const) expect(handMoves.filter((m) => m.limb === hand || m.dyno === 'both').pop()!.holdId).toBe(top.id);
  });

  it('is fast on typical boulders (< 60 ms median)', { timeout: 60_000 }, () => {
    const problems = [0, 2, 4, 6, 8, 10, 12].map((g) => generateBoulder({ seed: 900 + g, grade: g }));
    planBeta(problems[0]); // warm-up (JIT)
    const times: number[] = [];
    for (const b of problems) {
      // best of three: robust against other test files running in parallel
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = cpuMs();
        expect(planBeta(b, { maxMs: 1000 })).not.toBeNull();
        best = Math.min(best, cpuMs() - t0);
      }
      times.push(best);
    }
    times.sort((a, b) => a - b);
    // 60 ms of CPU (typical boulders of the shipped default, folded walls included); the budget also
    // scales with the machine's load (shared CI / dev boxes: steal time, cache and memory contention)
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(60 * loadFactor());
  });

  it('stays fast on every archetype, multi-angle walls included (< 60 ms median, deterministic budgets)', { timeout: 120_000 }, () => {
    const problems: ReturnType<typeof generateBoulder>[] = [];
    for (const profiles of [false, true])
      for (const style of availableStyles(profiles)) for (const g of [2, 6, 10]) problems.push(generateBoulder({ seed: 5100 + g * 3 + style.length, grade: g, style, profiles }));
    planBeta(problems[0]); // warm-up (JIT)
    const times: number[] = [];
    for (const b of problems) {
      let best = Infinity;
      for (let k = 0; k < 2; k++) {
        const t0 = cpuMs();
        // the generator's own deterministic budget: every generated problem solves within it
        expect(planBeta(b, { maxNodes: 700 }), b.id).not.toBeNull();
        best = Math.min(best, cpuMs() - t0);
      }
      times.push(best);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(60 * loadFactor());
  });

  it('returns null for an impossible problem', () => {
    const b = makeBoulder([hold('s1', -0.2, 1.6, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.6, 'jug', 0.1, 'start'), hold('t', 0, 4.1, 'jug', 0.12, 'top')], { wallAngle: 20 });
    expect(planBeta(b, { maxNodes: 200 })).toBeNull();
  });

  it('planned betas are executable in the sim through the player input API', { timeout: 120_000 }, () => {
    const failed: string[] = [];
    for (let g = 0; g <= 12; g++) {
      for (let k = 0; k < 2; k++) {
        const b = generateBoulder({ seed: 3000 + g * 17 + k, grade: g });
        const r = autoClimb(new ClimberSim(b));
        if (!r.sent) failed.push(`${b.id}: ${r.bot.log.join('; ')}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it('a lead route is executable with every quickdraw clipped', { timeout: 120_000 }, () => {
    const b = generateRopeRoute({ seed: 4242, grade: 3 });
    const sim = new ClimberSim(b);
    const rope = new RopeSystem(b);
    const bot = new BetaBot(sim);
    sim.start();
    let events: ReturnType<typeof sim.step> = [];
    for (let t = 0; t < 400 && !bot.done && !bot.failed; t += 1 / 60) {
      bot.update(1 / 60, events);
      events = sim.step(1 / 60);
      for (const e of events) if (e.type === 'clip-done') rope.clip(e.quickdrawId);
      const s = sim.getState();
      if (s.phase === 'climbing') {
        const c = rope.catchParams(s.pelvis);
        sim.setRope(c.anchor, c.length);
      }
    }
    expect(sim.getState().phase).toBe('topped');
    expect(rope.clipped.length).toBe(b.quickdraws!.length);
  });
});

describe('planBeta — foot technique realism', () => {
  it('rarely crosses the feet: a cross-through only where it is clearly better (SOLVER.footCross)', { timeout: 120_000 }, () => {
    let stances = 0;
    let crossed = 0;
    for (const style of availableStyles(true))
      for (const grade of [3, 8]) {
        const b = generateBoulder({ seed: 5300 + grade * 23 + style.length * 11, grade, style });
        const plan = planBetaDetailed(b);
        expect(plan, b.id).not.toBeNull();
        const byId = new Map(b.holds.map((h) => [h.id, h] as const));
        const feet: Record<'LF' | 'RF', { x: number } | null> = {
          LF: b.startFeet?.LF ? byId.get(b.startFeet.LF)! : null,
          RF: b.startFeet?.RF ? byId.get(b.startFeet.RF)! : null,
        };
        for (const st of plan!.steps) {
          const m = st.move;
          if (m.limb === 'LF' || m.limb === 'RF') feet[m.limb] = byId.get(m.holdId) ?? st.smear ?? null;
          if (st.dyno) for (const c of st.dyno.cut) if (c === 'LF' || c === 'RF') feet[c] = null;
          stances++;
          // the left foot right of the right one (two different holds / smears)
          if (feet.LF && feet.RF && feet.LF !== feet.RF && feet.LF.x > feet.RF.x + 0.03) crossed++;
        }
      }
    // (≈28 % of the planned stances crossed their feet before the cost)
    expect(crossed / stances).toBeLessThan(0.12);
  });
});

describe('nextHint', () => {
  it('suggests a reachable, useful move from the live stance', () => {
    const b = tutorialBoulder();
    const sim = new ClimberSim(b);
    sim.start();
    const hint = nextHint(sim);
    expect(hint).not.toBeNull();
    const h = b.holds.find((x) => x.id === hint!.holdId)!;
    expect(h.role).not.toBe('deco');
    // within reach once the body follows the limb (the planner's reach)
    const a = sim.limbAnchor(hint!.limb);
    expect(Math.hypot(h.x - a.x, h.y - a.y)).toBeLessThan(sim.maxReach(hint!.limb) + 0.6);
    // and it is the first move of a full beta from here
    expect(planBeta(b)![0]).toEqual(hint);
  });

  it('suggests clipping when a quickdraw is in reach on a lead route', () => {
    const b = makeBoulder(
      [
        hold('s1', -0.2, 1.6, 'jug', 0.1, 'start'),
        hold('s2', 0.2, 1.6, 'jug', 0.1, 'start'),
        hold('f1', -0.22, 0.45, 'jug', 0.08, 'foot'),
        hold('f2', 0.22, 0.45, 'jug', 0.08, 'foot'),
        hold('t', 0, 14.2, 'jug', 0.12, 'top'),
      ],
      { mode: 'rope', height: 15, width: 4.4, quickdraws: [{ id: 'q0', x: 0.3, y: 2.05 }, { id: 'q1', x: 0, y: 14.6 }] },
    );
    const sim = new ClimberSim(b);
    sim.start();
    const hint = nextHint(sim);
    expect(hint?.holdId).toBe('q0');
  });
});

describe('estimateGrade', () => {
  it('rises with the generated grade', { timeout: 120_000 }, () => {
    const band = (grades: number[]) => {
      let sum = 0;
      let n = 0;
      for (const g of grades)
        for (let k = 0; k < 4; k++) {
          sum += estimateGrade(generateBoulder({ seed: 8000 + g * 101 + k, grade: g }));
          n++;
        }
      return sum / n;
    };
    const easy = band([0, 1, 2]);
    const mid = band([5, 6, 7]);
    const hard = band([10, 11, 12]);
    expect(easy).toBeLessThan(mid);
    expect(mid).toBeLessThan(hard);
    expect(easy).toBeLessThan(3.5);
    expect(hard).toBeGreaterThan(7);
  });

  it('rates the tutorial as easy and an impossible wall as V12', () => {
    expect(estimateGrade(tutorialBoulder())).toBeLessThanOrEqual(2);
    const b = makeBoulder([hold('s1', -0.2, 1.6, 'jug', 0.1, 'start'), hold('s2', 0.2, 1.6, 'jug', 0.1, 'start'), hold('t', 0, 4.1, 'crimp', 0.03, 'top')], { wallAngle: 40 });
    expect(estimateGrade(b)).toBe(12);
  });

  it('plans tall routes in stages within budget', { timeout: 60_000 }, () => {
    const r = generateRopeRoute({ seed: 77, grade: 2 });
    const p = planBetaDetailed(r, { maxNodes: 3000 });
    expect(p).not.toBeNull();
    expect(p!.moves.length).toBeGreaterThan(40);
  });
});

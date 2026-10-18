import { describe, expect, it } from 'vitest';
import { ClimberSim } from '../game/climber-sim';
import { generateBoulder } from '../game/generator';
import type { SimEvent } from '../core/contracts';
import type { LimbId, Vec2 } from '../core/types';
import { SIM } from '../config/tuning';
import { VelocityTracker } from './velocity';
import {
  alongSpeed,
  chalkBagAt,
  flickPower,
  frictionWord,
  inChalkZone,
  inShakeLane,
  isFlick,
  riseLabel,
  shakeLanePoint,
  SHAKE_LANE,
  spineUp,
  throwWord,
} from './release';
import { isPureMode, onPureMode, setPureMode } from './pure';

describe('VelocityTracker', () => {
  it('reads a steady flick as its speed (units / s)', () => {
    const v = new VelocityTracker();
    v.reset(1000, 0, 0);
    for (let i = 1; i <= 6; i++) v.add(1000 + i * 16, i * 0.08, i * 0.04);
    const out = v.velocity(1000 + 6 * 16 + 4, { x: 0, y: 0 });
    expect(out.x).toBeCloseTo(5, 1);
    expect(out.y).toBeCloseTo(2.5, 1);
  });

  it('a finger that stopped before lifting reads as still', () => {
    const v = new VelocityTracker();
    v.reset(0, 0, 0);
    for (let i = 1; i <= 6; i++) v.add(i * 16, i * 0.1, 0);
    const out = v.velocity(6 * 16 + 200, { x: 9, y: 9 });
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it('only the last ~90 ms count (a slow drag that ends in a flick is a flick)', () => {
    const v = new VelocityTracker();
    v.reset(0, 0, 0);
    // slow for half a second…
    for (let i = 1; i <= 30; i++) v.add(i * 16, i * 0.002, 0);
    // …then fast
    const t0 = 30 * 16;
    for (let i = 1; i <= 4; i++) v.add(t0 + i * 16, 0.06 + i * 0.1, 0);
    const out = v.velocity(t0 + 4 * 16, { x: 0, y: 0 });
    expect(out.x).toBeGreaterThan(4);
  });

  it('handles a single sample in the window and bad input', () => {
    const v = new VelocityTracker();
    v.reset(0, 0, 0);
    v.add(40, 0.2, 0);
    expect(v.velocity(40, { x: 0, y: 0 }).x).toBeCloseTo(5, 6);
    v.add(NaN, 1, 1);
    v.add(10, 5, 5); // out of order: ignored
    expect(v.velocity(40, { x: 0, y: 0 }).x).toBeCloseTo(5, 6);
    const empty = new VelocityTracker();
    expect(empty.velocity(0, { x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
  });
});

describe('release helpers', () => {
  it('spine frame, chalk bag and zones', () => {
    const up = spineUp({ x: 0, y: 1 }, { x: 0, y: 1.5 }, { x: 0, y: 0 });
    expect(up).toEqual({ x: 0, y: 1 });
    expect(spineUp({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 1 });
    const bag = chalkBagAt({ x: 0.2, y: 1 }, up, { x: 0, y: 0 });
    expect(bag.x).toBeCloseTo(0.2);
    expect(bag.y).toBeCloseTo(0.9);
    expect(inChalkZone(bag, 0.2, 0.9 + SIM.chalkZone * 0.9)).toBe(true);
    expect(inChalkZone(bag, 0.2, 0.9 + SIM.chalkZone * 1.1)).toBe(false);
    // the shake lane: below the shoulder on the hand's own side, never across the chest
    const sh: Vec2 = { x: -0.19, y: 1.5 };
    const mid = shakeLanePoint(0, sh, up, (SHAKE_LANE.down0 + SHAKE_LANE.down1) / 2, 0.15, { x: 0, y: 0 });
    expect(mid.x).toBeLessThan(sh.x); // left hand → out to the left
    expect(inShakeLane(0, sh, up, mid.x, mid.y)).toBe(true);
    expect(inShakeLane(0, sh, up, sh.x + 0.3, mid.y)).toBe(false); // across the body
    expect(inShakeLane(0, sh, up, mid.x, sh.y + 0.1)).toBe(false); // above the shoulder
    const midR = shakeLanePoint(1, { x: 0.19, y: 1.5 }, up, 0.45, 0.15, { x: 0, y: 0 });
    expect(midR.x).toBeGreaterThan(0.19);
    expect(inShakeLane(1, { x: 0.19, y: 1.5 }, up, midR.x, midR.y)).toBe(true);
  });

  it('flick mapping matches the sim (threshold, power clamp) and words', () => {
    expect(alongSpeed({ x: 0, y: 3 }, { x: 0, y: 0 }, { x: 0, y: 2 })).toBeCloseTo(3);
    expect(alongSpeed({ x: 3, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2 })).toBeCloseTo(0);
    expect(alongSpeed({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
    expect(isFlick(SIM.dynoMinFlick)).toBe(true);
    expect(isFlick(SIM.dynoMinFlick - 0.01)).toBe(false);
    expect(flickPower(SIM.dynoFlickRef)).toBeCloseTo(1);
    expect(flickPower(0.1)).toBe(0.6);
    expect(flickPower(99)).toBe(1.4);
    expect(frictionWord(1)).toBe('FRESH');
    expect(frictionWord(0.5)).toBe('WORN');
    expect(frictionWord(0.1)).toBe('GREASY');
    expect(riseLabel(0.184)).toBe('+18 CM');
    expect(riseLabel(1.24)).toBe('+1.2 M');
    expect(riseLabel(-1)).toBe('+0 CM');
    expect(throwWord({ kind: 'deadpoint', rise: 0.3, feasible: true })).toEqual({ word: 'DEADPOINT', type: '+30 CM' });
    expect(throwWord({ kind: 'dyno', rise: 0.5, feasible: true }).word).toBe('DYNO');
    expect(throwWord({ kind: 'dyno', rise: 0.9, feasible: false }).word).toBe('TOO FAR');
  });
});

describe('release previews agree with the sim', () => {
  const settle = (sim: ClimberSim, s = 0.5): void => {
    for (let t = 0; t < s; t += 1 / 60) sim.step(1 / 60);
  };
  const fresh = (seed: number, grade: number, style?: 'dyno'): ClimberSim => {
    const sim = new ClimberSim(generateBoulder({ seed, grade, ...(style ? { style } : {}) }), { invincible: true });
    sim.reset();
    sim.start();
    settle(sim);
    return sim;
  };
  const types = (ev: SimEvent[]): string[] => ev.map((e) => e.type);

  it('a hand released in the chalk zone chalks up', () => {
    const sim = fresh(3, 2);
    const st = sim.getState();
    const up = spineUp(st.pelvis, st.chest, { x: 0, y: 0 });
    const bag = chalkBagAt(st.pelvis, up, { x: 0, y: 0 });
    expect(sim.beginDrag('LH')).toBe(true);
    sim.dragTo('LH', bag);
    expect(sim.snapCandidate('LH', bag)).toBeNull();
    expect(inChalkZone(bag, bag.x, bag.y)).toBe(true);
    expect(types(sim.endDrag('LH'))).toContain('chalk-start');
  });

  it('a hand released in the shake lane shakes out (when the stance holds)', () => {
    let tried = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sim = fresh(seed, 0);
      const st = sim.getState();
      const up = spineUp(st.pelvis, st.chest, { x: 0, y: 0 });
      const p = shakeLanePoint(1, st.limbs.RH.anchor, up, 0.45, 0.15, { x: 0, y: 0 });
      if (sim.snapCandidate('RH', p)) continue;
      expect(inShakeLane(1, st.limbs.RH.anchor, up, p.x, p.y)).toBe(true);
      sim.beginDrag('RH');
      sim.dragTo('RH', p);
      const ev = types(sim.endDrag('RH'));
      tried++;
      if (ev.includes('shake-out-start')) return;
      // the stance may be too hard to hang off one hand: the hand returns instead
      expect(ev).toContain('return');
    }
    expect(tried).toBeGreaterThan(0);
    throw new Error('no start stance shook out');
  });

  it('a tracked flick toward a throw target deadpoints with the input power mapping', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const sim = fresh(seed, 4, 'dyno');
      const st = sim.getState();
      for (const limb of ['RH', 'LH'] as LimbId[]) {
        const L = st.limbs[limb];
        const target = sim.boulder.holds.find((h) => {
          if (h.role === 'deco' || h.type === 'foot' || h.y <= L.pos.y) return false;
          const d = sim.dynoCandidate(limb, h);
          return !!d && d.holdId === h.id && d.rise > 0.35;
        });
        if (!target) continue;
        const from = { x: L.pos.x, y: L.pos.y };
        expect(sim.beginDrag(limb)).toBe(true);
        sim.dragTo(limb, target);
        // the throw preview right at the hold (no static grab there)
        expect(sim.snapCandidate(limb, target)).toBeNull();
        expect(sim.dynoCandidate(limb, target)?.holdId).toBe(target.id);
        // a finger flick: 4 samples 16 ms apart ending on the hold
        const vt = new VelocityTracker();
        const t0 = 5000;
        vt.reset(t0, from.x + (target.x - from.x) * 0.5, from.y + (target.y - from.y) * 0.5);
        for (let i = 1; i <= 4; i++) vt.add(t0 + i * 16, from.x + (target.x - from.x) * (0.5 + i / 8), from.y + (target.y - from.y) * (0.5 + i / 8));
        const v = vt.velocity(t0 + 4 * 16 + 6, { x: 0, y: 0 });
        const ev = sim.endDrag(limb, { velocity: v });
        const start = ev.find((e) => e.type === 'dyno-start');
        expect(start, `seed ${seed} ${limb} → ${target.id}`).toBeTruthy();
        if (start && start.type === 'dyno-start') {
          expect(start.holdId).toBe(target.id);
          expect(start.limbs).toContain(limb);
          expect(start.power).toBeGreaterThanOrEqual(0.6);
          expect(start.power).toBeLessThanOrEqual(1.4);
        }
        return;
      }
    }
    throw new Error('no throwable start found');
  });

  it('a still release at a throw target does not throw', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const sim = fresh(seed, 4, 'dyno');
      const st = sim.getState();
      const L = st.limbs.RH;
      const target = sim.boulder.holds.find((h) => {
        if (h.role === 'deco' || h.type === 'foot' || h.y <= L.pos.y) return false;
        const d = sim.dynoCandidate('RH', h);
        return !!d && d.holdId === h.id && d.rise > 0.35;
      });
      if (!target) continue;
      sim.beginDrag('RH');
      sim.dragTo('RH', target);
      const vt = new VelocityTracker();
      vt.reset(0, target.x, target.y);
      vt.add(16, target.x, target.y);
      const ev = sim.endDrag('RH', { velocity: vt.velocity(400, { x: 0, y: 0 }) });
      expect(types(ev)).not.toContain('dyno-start');
      return;
    }
    throw new Error('no throwable start found');
  });
});

describe('pure mode flag', () => {
  it('notifies subscribers once per change and on subscribe', () => {
    const seen: boolean[] = [];
    const off = onPureMode((v) => seen.push(v));
    expect(seen).toEqual([isPureMode()]);
    setPureMode(true);
    setPureMode(true);
    setPureMode(false);
    off();
    setPureMode(true);
    expect(seen).toEqual([false, true, false]);
    setPureMode(false);
  });
});

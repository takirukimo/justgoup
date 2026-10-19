// Body as feedback (research §4.2): the climber's body has to carry pump, effort and grip state
// without a HUD (Pure mode), so these cues are checked on the real ClimberModel posed from real sim
// states with the signals forced.
// headless canvas stand-ins for the procedural textures (as the offline anatomy QA uses)
import '../../dev/character-stub';
import { describe, expect, it } from 'vitest';
import type { ClimberState, LimbId } from '../core/types';
import { ClimberSim } from '../game/climber-sim';
import { tutorialBoulder } from '../game/generator';
import { ClimberModel } from './climber';
import { WallFrame } from './wall-frame';

function setup(): { model: ClimberModel; frame: WallFrame; base: ClimberState } {
  const b = tutorialBoulder();
  const sim = new ClimberSim(b, { invincible: true });
  sim.reset();
  sim.start();
  sim.step(0.5);
  const frame = new WallFrame(b.wallAngle);
  frame.setWall(b);
  const model = new ClimberModel({ head: 'ibex', colorway: 'basalt', chalk: 'classic' });
  const st = sim.getState();
  const base = JSON.parse(JSON.stringify(st)) as ClimberState;
  return { model, frame, base };
}

function forced(base: ClimberState, o: { tension?: number; pump?: number; limbs?: Partial<Record<LimbId, Partial<ClimberState['limbs'][LimbId]>>> }): ClimberState {
  const limbs = { ...base.limbs };
  for (const [id, patch] of Object.entries(o.limbs ?? {})) limbs[id as LimbId] = { ...limbs[id as LimbId], ...patch };
  return { ...base, tension: o.tension ?? base.tension, pump: o.pump ?? base.pump, limbs };
}

/** Breaths per minute over `secs` (upward zero crossings of the breath value) after a warm-up. */
function breathRate(model: ClimberModel, frame: WallFrame, st: ClimberState, secs = 12): { rpm: number; range: number } {
  const dt = 1 / 60;
  for (let i = 0; i < 240; i++) model.pose(st, frame, dt);
  let prev = model.breathValue;
  let ups = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < secs / dt; i++) {
    model.pose(st, frame, dt);
    const v = model.breathValue;
    if (prev < 0 && v >= 0) ups++;
    prev = v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { rpm: (ups * 60) / secs, range: hi - lo };
}

describe('body as feedback', { timeout: 60_000 }, () => {
  it('breathes 15 → 30 → 45 times a minute from rest to a crux, deeper as it works', () => {
    const { model, frame, base } = setup();
    const rest = breathRate(model, frame, forced(base, { tension: 0, pump: 0 }));
    const work = breathRate(model, frame, forced(base, { tension: 0.5, pump: 0.2 }));
    const crux = breathRate(model, frame, forced(base, { tension: 0.3, pump: 1 }));
    expect(rest.rpm).toBeGreaterThanOrEqual(12);
    expect(rest.rpm).toBeLessThanOrEqual(18);
    expect(work.rpm).toBeGreaterThanOrEqual(26);
    expect(work.rpm).toBeLessThanOrEqual(34);
    expect(crux.rpm).toBeGreaterThanOrEqual(40);
    expect(crux.rpm).toBeLessThanOrEqual(50);
    expect(model.breathDepth).toBeGreaterThan(1);
  });

  it('holds the breath through a crux (tension past 0.8) and breathes on once it eases', () => {
    const { model, frame, base } = setup();
    const held = breathRate(model, frame, forced(base, { tension: 0.95, pump: 0.3 }), 6);
    expect(held.rpm).toBeLessThanOrEqual(5);
    expect(model.breathValue).toBeGreaterThan(0.5); // chest full
    const after = breathRate(model, frame, forced(base, { tension: 0.4, pump: 0.3 }), 6);
    expect(after.rpm).toBeGreaterThan(15);
  });

  it('shows the chalk on each hand fading with its friction (greasy hands bare and glossy), and the pumped forearm flushing', () => {
    const { model, frame, base } = setup();
    const u = model.rig.material.userData.body;
    for (let i = 0; i < 300; i++) model.pose(forced(base, { limbs: { LH: { friction: 1, pump: 0 }, RH: { friction: 0.05, pump: 0.95 } } }), frame, 1 / 60);
    expect(u.uHandChalk.value.x).toBeGreaterThan(0.95);
    expect(u.uHandChalk.value.y).toBeLessThan(0.2);
    expect(u.uHandSweat.value.x).toBe(0);
    expect(u.uHandSweat.value.y).toBeGreaterThan(0.5);
    expect(u.uFlush.value.x).toBe(0);
    expect(u.uFlush.value.y).toBeGreaterThan(0.4);
  });

  it("a running slip clock creeps the fingers before the slip (once per episode), not on a safe hold", () => {
    const { model, frame, base } = setup();
    const dt = 1 / 60;
    const fired: LimbId[] = [];
    model.onCreep = (l) => fired.push(l);
    const hand = base.limbs.RH.holdId ? 'RH' : 'LH';
    for (let i = 0; i < 60; i++) model.pose(forced(base, { limbs: { [hand]: { stress: 0.8 } } }), frame, dt);
    expect(model.maxSlip).toBe(0);
    for (let i = 0; i < 30; i++) model.pose(forced(base, { limbs: { [hand]: { stress: 1.5 } } }), frame, dt);
    expect(model.maxSlip).toBeGreaterThan(0.5);
    expect(fired).toEqual([hand]);
    for (let i = 0; i < 30; i++) model.pose(forced(base, { limbs: { [hand]: { stress: 1.5 } } }), frame, dt);
    expect(fired.length).toBe(1);
    for (let i = 0; i < 120; i++) model.pose(forced(base, { limbs: { [hand]: { stress: 0.5 } } }), frame, dt);
    expect(model.maxSlip).toBe(0);
  });
});

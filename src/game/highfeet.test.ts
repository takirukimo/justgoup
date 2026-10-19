// High feet (owner feedback v0.2: "I should be able to move my leg higher since I can toe hook or heel
// hook to gain balance"; shared sim + render spec): a standing foot high-steps to ≈0.32 m above the hip
// joint with the hips brought in, a hooking foot reaches ≈0.5 m (chest height) out to the side. The
// technique is decided before the reach check.

import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import type { BoulderDef, HoldDef } from '../core/types';
import { SIM } from '../config/tuning';
import { ClimberSim } from './climber-sim';
import { autoClimb } from './bot';
import { evaluateStance, FOOT_HEEL, FOOT_PUSH, makeParams, newContact, setContact, StanceEval, type Contacts, type Pose } from './statics';
import { planBetaDetailed } from './solver';
import { generateBoulder } from './generator';
import { contactPoint, footModeFor, LIMB_INDEX } from './holds';
import { computeAnchors } from './statics';
import { angleAt, profileOf, smoothAngleAt } from './wall-profile';
import { BODY } from '../config/tuning';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

const base = (extra: HoldDef[], wallAngle: number): BoulderDef =>
  makeBoulder(
    [hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'), hold('s2', 0.25, 2.15, 'jug', 0.11, 'start'), hold('f1', -0.25, 0.75, 'jug', 0.08, 'foot'), hold('f2', 0.3, 0.8, 'jug', 0.08, 'foot'), hold('t', 0, 4.1, 'jug', 0.12, 'top'), ...extra],
    { startFeet: { LF: 'f1', RF: 'f2' }, wallAngle },
  );

/** The right hip joint of the settled start stance on `wallAngle`. */
function hipOf(wallAngle: number): { x: number; y: number } {
  const sim = new ClimberSim(base([], wallAngle), { sweat: 0 });
  sim.start();
  run(sim, 1);
  return { ...sim.getState().limbs.RF.anchor };
}

describe('high feet: high steps (standing foot)', () => {
  it('a foot steps up onto a hold ≈0.28 m above the hip joint out to the side; the hips come in while it is high', () => {
    const hip = hipOf(0);
    // a positive foothold well above the hip, 0.42 m out (the toe ≈0.28 m above the hip joint)
    const sim = new ClimberSim(base([hold('hi', hip.x + 0.42, hip.y + 0.26, 'edge', 0.065, 'foot')], 0), { sweat: 0 });
    sim.start();
    run(sim, 1);
    const d0 = sim.getState().pelvisDepth;
    const ev = moveLimb(sim, 'RF', 'hi');
    run(sim, 1.5, ev);
    const s = sim.getState();
    expect(ev.some((e) => e.type === 'grab' && e.holdId === 'hi')).toBe(true);
    expect(s.limbs.RF.holdId).toBe('hi');
    expect(s.limbs.RF.footMode).toBe('edge');
    expect(ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
    // the hips came in toward the wall (≈0.2 m) while the foot is high
    if (s.limbs.RF.contactPos!.y - s.limbs.RF.anchor.y > SIM.highStepDepthFull) expect(s.pelvisDepth).toBeLessThan(SIM.highStepDepth + 0.03);
    expect(s.pelvisDepth).toBeLessThan(d0 - 0.05);
    // the attached foot stays inside the standing leg's envelope
    expect(Math.max(...Array.from(sim.envelopeViolation()))).toBeLessThan(0.01);
  });

  it('the technique is decided before the reach check: a chest-high hold is reachable only as a hook', () => {
    const hip = hipOf(35);
    // the same spot 0.42 m out, 0.45 m up: facing back toward the hip (hookable) or facing up (nothing to hook)
    const at = (angleDeg: number): ClimberSim => {
      const sim = new ClimberSim(base([hold('k', hip.x + 0.42, hip.y + 0.45, 'edge', 0.07, 'foot', angleDeg)], 35), { sweat: 0 });
      sim.start();
      run(sim, 1);
      return sim;
    };
    expect(at(180).reachableHolds('RF')).toContain('k');
    expect(at(90).reachableHolds('RF')).not.toContain('k');
    // a vertical wall takes no heel hook: a standing foot doesn't reach chest height there
    const v = hipOf(0);
    const sim = new ClimberSim(base([hold('k', v.x + 0.42, v.y + 0.45, 'edge', 0.07, 'foot', 180)], 0), { sweat: 0 });
    sim.start();
    run(sim, 1);
    expect(sim.reachableHolds('RF')).not.toContain('k');
  });

  it('a deep high step strains the leg more than a moderate one (anatomical strain near the edge)', () => {
    const prm = makeParams(0);
    const ev = new StanceEval();
    const pose: Pose = { px: 0, py: 1.3, cx: 0, cy: 1.8 };
    const stress = (fy: number): number => {
      const hs = [hold('a', -0.2, 2.15, 'jug', 0.1, 'start'), hold('b', 0.2, 2.15, 'jug', 0.1, 'start'), hold('c', -0.2, 0.55, 'jug', 0.08, 'foot'), hold('d', 0.45, fy, 'edge', 0.065, 'foot')];
      const c: Contacts = hs.map((h, i) => setContact(newContact(), h, i, false));
      evaluateStance(pose, c, prm, ev);
      return ev.edge[3];
    };
    expect(stress(1.62)).toBeGreaterThan(stress(1.38) + 0.05);
  });

  it('a high step only goes on while a hand holds the climber', () => {
    const hip = hipOf(0);
    const sim = new ClimberSim(base([hold('hi', hip.x + 0.42, hip.y + 0.26, 'edge', 0.065, 'foot')], 0), { sweat: 0, invincible: true });
    sim.start();
    run(sim, 1);
    const cp = contactPoint(sim.boulder.holds.find((h) => h.id === 'hi')!, 3, false, { x: 0, y: 0 });
    sim.beginDrag('RF');
    run(sim, 0.1);
    expect(sim.snapCandidate('RF', cp)?.id).toBe('hi');
    sim.beginDrag('LH');
    sim.beginDrag('RH');
    expect(sim.snapCandidate('RF', cp)).toBeNull();
  });
});

describe('high feet: heel / toe hooks', () => {
  it('on an overhang a heel hook reaches ≈0.45 m above the hip joint, out to the side, and takes load off the hands', () => {
    const hip = hipOf(35);
    // a jug facing back toward the hip, 0.45 m out, ≈0.42 m up
    const k = hold('k', hip.x + 0.47, hip.y + 0.4, 'jug', 0.09, 'hand', 180);
    const sim = new ClimberSim(base([k], 35), { sweat: 0 });
    sim.start();
    run(sim, 1.5);
    sim.beginDrag('RF');
    run(sim, 1);
    const off = sim.getState().limbs.LH.load + sim.getState().limbs.RH.load;
    sim.endDrag('RF');
    run(sim, 0.5);
    const ev: SimEvent[] = moveLimb(sim, 'RF', 'k');
    run(sim, 1.5, ev);
    const s = sim.getState();
    expect(s.limbs.RF.holdId).toBe('k');
    expect(s.limbs.RF.footMode).toBe('heel');
    expect(ev.some((e) => e.type === 'technique' && e.technique === 'heel')).toBe(true);
    expect(s.limbs.LH.load + s.limbs.RH.load).toBeLessThan(off - 0.05);
    expect(ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
    // the foot sits well above the hip joint, inside the hooking leg's range
    expect(s.limbs.RF.contactPos!.y - s.limbs.RF.anchor.y).toBeGreaterThan(0.3);
    expect(Math.max(...Array.from(sim.envelopeViolation()))).toBeLessThan(0.01);
  });

  it('statics: a hook pulls only its share of the keep-in (a hook stance is not strained to the limit)', () => {
    const hs = [hold('a', -0.2, 2.1, 'jug', 0.1, 'start'), hold('b', 0.2, 2.1, 'jug', 0.1, 'start'), hold('c', -0.2, 0.95, 'jug', 0.08, 'foot'), hold('k', 0.6, 1.4, 'jug', 0.09, 'foot', 180)];
    const c: Contacts = hs.map((h, i) => setContact(newContact(), h, i, false));
    c[3]!.mode = FOOT_HEEL;
    const ev = new StanceEval();
    evaluateStance({ px: -0.05, py: 1.38, cx: -0.02, cy: 1.88 }, c, makeParams(30), ev);
    expect(ev.normalHooks).toBeGreaterThan(0.05);
    expect(ev.stress[3]).toBeLessThan(0.75);
    c[3]!.mode = FOOT_PUSH;
    expect(ev.cap[3]).toBeGreaterThan(0);
  });

  it('generated steep problems use the occasional high heel hook, and the bot climbs them', { timeout: 300_000 }, () => {
    let highHooks = 0;
    let withHook: BoulderDef | null = null;
    for (const style of ['overhang', 'cave', 'mixed'] as const)
      for (let k = 0; k < 8; k++) {
        const b = generateBoulder({ seed: 7000 + k * 17 + style.length, grade: 3 + (k % 6), style });
        const plan = planBetaDetailed(b, { maxNodes: 900 });
        if (!plan) continue;
        const byId = new Map(b.holds.map((h) => [h.id, h]));
        const prof = profileOf(b);
        for (const st of plan.steps) {
          const li = LIMB_INDEX[st.move.limb];
          const h = byId.get(st.move.holdId);
          if (li < 2 || !h) continue;
          const ax = new Float64Array(4);
          const ay = new Float64Array(4);
          computeAnchors(st.pose, ax, ay);
          const c = contactPoint(h, li, false, { x: 0, y: 0 });
          const comY = st.pose.py + BODY.comT * (st.pose.cy - st.pose.py);
          const wall = prof ? Math.max(angleAt(prof, c.y), smoothAngleAt(prof, comY)) : b.wallAngle;
          if (footModeFor(h, c.x, c.y, ax[li], ay[li], st.pose.px, wall, null) === 'heel' && c.y - ay[li] > 0.15) {
            highHooks++;
            withHook ??= b;
          }
        }
      }
    expect(highHooks).toBeGreaterThanOrEqual(3);
    expect(withHook).not.toBeNull();
    const r = autoClimb(new ClimberSim(withHook!));
    expect(r.sent, r.bot.log.join('; ')).toBe(true);
  });
});

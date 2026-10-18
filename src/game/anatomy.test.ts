import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../core/contracts';
import type { HoldDef, LimbId, Vec2 } from '../core/types';
import { BODY, SIM } from '../config/tuning';
import {
  anatomicStrain,
  ARM_ENVELOPE,
  atan2Deg,
  clampToEnvelope,
  envelopeDistance,
  envelopeExcess,
  envelopePolygon,
  envelopeRadius,
  envelopeRange,
  envelopeRatio,
  ENVELOPE_MAX_OK,
  envEval,
  inEnvelope,
  LEG_ENVELOPE,
  limbPhi,
  POLYGON_POINTS,
  segmentsCross,
} from './anatomy';
import { ClimberSim } from './climber-sim';
import { BetaBot } from './bot';
import { generateBoulder, tutorialBoulder, TUTORIAL_SEQUENCE } from './generator';
import { canMatch, contactPoint, LIMB_INDEX, placementBlocked } from './holds';
import { evaluateStance, makeParams, newContact, placeChest, setContact, StanceEval, type Contacts, type Pose } from './statics';
import { hold, makeBoulder, moveLimb, run } from './test-helpers';

const IDS: LimbId[] = ['LH', 'RH', 'LF', 'RF'];
const UP: Vec2 = { x: 0, y: 1 };
const O: Vec2 = { x: 0, y: 0 };
const deg = (d: number): number => (d * Math.PI) / 180;
/** Point at polar angle φ (limb convention) and radius r from the origin, upright body frame. */
function polar(li: number, phi: number, r: number): Vec2 {
  const side = li === 0 || li === 2 ? -1 : 1;
  const leg = li >= 2;
  const o = Math.sin(deg(phi)) * r; // outward
  const d = Math.cos(deg(phi)) * r; // along the base direction
  return { x: side * o, y: leg ? -d : d };
}
const bodyUp = (s: { pelvis: Vec2; chest: Vec2 }): Vec2 => {
  const dx = s.chest.x - s.pelvis.x;
  const dy = s.chest.y - s.pelvis.y;
  const l = Math.hypot(dx, dy);
  return { x: dx / l, y: dy / l };
};

describe('anatomy — reach envelopes', () => {
  it('canonical tables: longest reach = BODY.legMax / armMax, knots exact, forbidden outside the range', () => {
    expect(ENVELOPE_MAX_OK).toBe(true);
    for (const [li, table] of [
      [0, ARM_ENVELOPE],
      [3, LEG_ENVELOPE],
    ] as const) {
      for (const [phi, r] of table) expect(envelopeRadius(li, phi)).toBeCloseTo(r, 12);
      const { min, max } = envelopeRange(li);
      expect(envelopeRadius(li, min - 1)).toBe(0);
      expect(envelopeRadius(li, max + 1)).toBe(0);
    }
    expect(Math.max(...LEG_ENVELOPE.map((k) => k[1]))).toBeCloseTo(BODY.legMax, 12);
    expect(Math.max(...ARM_ENVELOPE.map((k) => k[1]))).toBeCloseTo(BODY.armMax, 12);
    // straight down for an arm is continuous through the wrap: −170° ≡ 190°
    expect(envelopeRadius(1, -170)).toBeCloseTo(envelopeRadius(1, 190), 12);
    // a foot never goes straight up; at most ~0.33 m above the hip joint, out to the side
    expect(envelopeRadius(3, 180)).toBe(0);
    let top = 0;
    for (let phi = 90; phi <= 160; phi += 0.5) top = Math.max(top, -Math.cos(deg(phi)) * envelopeRadius(3, phi));
    expect(top).toBeGreaterThan(0.28);
    expect(top).toBeLessThan(0.36);
  });

  it('φ follows the shared body-frame convention (legs from down, arms from up, + outward)', () => {
    expect(limbPhi(2, O, UP, { x: 0, y: -0.5 })).toBeCloseTo(0, 6); // LF straight down
    expect(limbPhi(3, O, UP, { x: 0.5, y: 0 })).toBeCloseTo(90, 6); // RF outward
    expect(limbPhi(2, O, UP, { x: -0.5, y: 0 })).toBeCloseTo(90, 6); // LF outward = −x
    expect(limbPhi(2, O, UP, { x: 0.5, y: 0 })).toBeCloseTo(-90, 6); // LF crossing under
    expect(Math.abs(limbPhi(3, O, UP, { x: 0, y: 0.5 }))).toBeCloseTo(180, 6); // RF straight up
    expect(limbPhi(1, O, UP, { x: 0, y: 0.5 })).toBeCloseTo(0, 6); // RH up
    expect(limbPhi(1, O, UP, { x: 0.5, y: 0 })).toBeCloseTo(90, 6); // RH outward
    expect(limbPhi(1, O, UP, { x: 0, y: -0.5 })).toBeCloseTo(180, 6); // RH down
    expect(limbPhi(0, O, UP, { x: 0.5, y: 0 })).toBeCloseTo(-90, 6); // LH across the chest
    // the frame turns with the torso
    const tilted = { x: Math.sin(deg(20)), y: Math.cos(deg(20)) };
    expect(limbPhi(1, O, tilted, { x: tilted.x, y: tilted.y })).toBeCloseTo(0, 6);
    // deterministic atan2 matches Math.atan2
    for (let k = 0; k < 2000; k++) {
      const y = Math.sin(k * 1.7) * 2;
      const x = Math.cos(k * 0.37) * 3;
      let d = Math.abs(atan2Deg(y, x) - (Math.atan2(y, x) * 180) / Math.PI);
      if (d > 180) d = 360 - d;
      expect(d).toBeLessThan(1e-5);
    }
  });

  it('envelope helpers are continuous and monotone', () => {
    for (const li of [0, 1, 2, 3]) {
      const { min, max } = envelopeRange(li);
      let prev = envelopeRadius(li, min);
      for (let phi = min + 0.25; phi <= max; phi += 0.25) {
        const r = envelopeRadius(li, phi);
        expect(Math.abs(r - prev), `${li} @${phi}`).toBeLessThan(0.0045);
        prev = r;
      }
      // the ratio grows monotonically along every ray, and is 1 on the boundary
      for (let phi = min + 0.5; phi <= max - 0.5; phi += 7) {
        const rm = envelopeRadius(li, phi);
        let last = -1;
        for (let r = 0.02; r < 1.2; r += 0.02) {
          const q = envelopeRatio(li, O, UP, polar(li, phi, r));
          expect(q).toBeGreaterThan(last);
          last = q;
        }
        expect(envelopeRatio(li, O, UP, polar(li, phi, rm))).toBeCloseTo(1, 4);
        expect(inEnvelope(li, O, UP, polar(li, phi, rm * 0.98))).toBe(true);
        expect(inEnvelope(li, O, UP, polar(li, phi, rm * 1.02 + 0.002))).toBe(false);
      }
      // continuous across the angular limit, rising quickly into the forbidden wedge
      for (const edge of [min, max]) {
        const out = edge === min ? -1 : 1;
        const r = envelopeRadius(li, edge) * 0.6;
        const a = envelopeRatio(li, O, UP, polar(li, edge - out * 0.05, r));
        const b = envelopeRatio(li, O, UP, polar(li, edge + out * 0.05, r));
        expect(Math.abs(a - b)).toBeLessThan(0.01);
        expect(envelopeRatio(li, O, UP, polar(li, edge + out * 6, r))).toBeGreaterThan(a);
        // excess is ≥ 0 and continuous too
        expect(envelopeExcess(li, O, UP, polar(li, edge + out * 0.05, r))).toBeLessThan(0.002);
      }
    }
    // a foot 0.4 m straight above the hip is deep in the forbidden wedge
    expect(envelopeRatio(3, O, UP, { x: 0, y: 0.4 })).toBeGreaterThan(4);
  });

  it('clampToEnvelope returns the nearest allowed point', () => {
    const out = { x: 0, y: 0 };
    for (const li of [0, 1, 2, 3]) {
      const { min, max } = envelopeRange(li);
      // dense sample of the allowed region (brute-force nearest point)
      const inside: Vec2[] = [];
      for (let phi = min; phi <= max; phi += 1) {
        const rm = envelopeRadius(li, phi);
        for (let r = 0; r <= rm; r += rm / 40) inside.push(polar(li, phi, r));
      }
      for (let k = 0; k < 60; k++) {
        const t = { x: Math.cos(k * 2.3) * (0.3 + (k % 5) * 0.25), y: Math.sin(k * 1.1) * (0.3 + (k % 4) * 0.3) };
        clampToEnvelope(li, O, UP, t, out);
        if (inEnvelope(li, O, UP, t)) {
          expect(out).toEqual(t);
          continue;
        }
        expect(inEnvelope(li, O, UP, out, 0.002)).toBe(true);
        const d = Math.hypot(out.x - t.x, out.y - t.y);
        let best = Infinity;
        for (const p of inside) best = Math.min(best, Math.hypot(p.x - t.x, p.y - t.y));
        expect(d).toBeLessThan(best + 0.004);
      }
    }
  });

  it('envelopePolygon: anchor first, boundary on the edge, turns with the body, mirrors left/right', () => {
    const a = { x: 0.3, y: 1.2 };
    for (const li of [0, 1, 2, 3]) {
      const poly = envelopePolygon(li, a, UP);
      expect(poly.length).toBe(POLYGON_POINTS);
      expect(poly[0]).toEqual(a);
      for (let k = 1; k < poly.length; k++) expect(envelopeRatio(li, a, UP, poly[k])).toBeCloseTo(1, 4);
      const tilted = { x: Math.sin(deg(25)), y: Math.cos(deg(25)) };
      const t = envelopePolygon(li, a, tilted);
      for (let k = 1; k < t.length; k++) expect(envelopeRatio(li, a, tilted, t[k])).toBeCloseTo(1, 4);
      // grown by a pad
      const padded = envelopePolygon(li, a, UP, [], 0.07);
      for (let k = 1; k < padded.length; k++) expect(envelopeExcess(li, a, UP, padded[k])).toBeCloseTo(0.07, 4);
    }
    const l = envelopePolygon(2, O, UP);
    const r = envelopePolygon(3, O, UP);
    for (let k = 0; k < l.length; k++) {
      expect(l[k].x).toBeCloseTo(-r[k].x, 9);
      expect(l[k].y).toBeCloseTo(r[k].y, 9);
    }
  });

  it('anatomical strain: awkward edges strain the limb, forced beyond the edge it pops off', () => {
    expect(anatomicStrain(0.5, 1)).toBe(0);
    expect(anatomicStrain(0.97, 1)).toBeGreaterThan(anatomicStrain(0.97, 0.3));
    expect(anatomicStrain(1, 1)).toBeCloseTo(SIM.edgeStrain, 6);
    // past the edge the stress alone is enough to run the slip clock at full speed
    expect(anatomicStrain(SIM.edgeOverFull, 0)).toBeGreaterThan(SIM.slipFull);
    // in the static solve: a hand forced past its envelope gets that stress on top
    const holds = [hold('a', -0.2, 2.0, 'jug', 0.1, 'start'), hold('b', 0.2, 2.0, 'jug', 0.1, 'start'), hold('c', -0.2, 0.9, 'jug', 0.08, 'foot'), hold('d', 0.2, 0.9, 'jug', 0.08, 'foot')];
    const contacts: Contacts = holds.map((h, i) => setContact(newContact(), h, i, false));
    const prm = makeParams(0);
    const ev = new StanceEval();
    const pose: Pose = { px: 0, py: 1.3, cx: 0, cy: 1.8 };
    placeChest(pose, contacts, prm, 0);
    evaluateStance(pose, contacts, prm, ev);
    const calm = ev.stress[1];
    pose.py = 0.7; // drop the body: the arms are pulled past their reach
    placeChest(pose, contacts, prm, 0);
    evaluateStance(pose, contacts, prm, ev);
    expect(ev.ratio[1]).toBeGreaterThan(SIM.edgeOverFull);
    expect(ev.stress[1]).toBeGreaterThan(calm + SIM.slipFull);
  });
});

// ─────────────────────────────── sim ───────────────────────────────

const baseHolds = (): HoldDef[] => [
  hold('s1', -0.2, 2.1, 'jug', 0.11, 'start'),
  hold('s2', 0.25, 2.15, 'jug', 0.11, 'start'),
  hold('f1', -0.25, 0.75, 'jug', 0.08, 'foot'),
  hold('f2', 0.3, 0.8, 'jug', 0.08, 'foot'),
  hold('t', 0, 4.1, 'jug', 0.12, 'top'),
];
const lab = (extra: HoldDef[] = [], wallAngle = 0) => makeBoulder([...baseHolds(), ...extra], { startFeet: { LF: 'f1', RF: 'f2' }, wallAngle });

/** The settled start pose of the lab problem (identical for any extra, unused holds). */
function settled(): ReturnType<ClimberSim['getState']> {
  const sim = new ClimberSim(lab());
  sim.start();
  run(sim, 1);
  return JSON.parse(JSON.stringify(sim.getState()));
}

/** Max envelope excess of the attached limbs in the current state (m). */
function maxExcess(sim: ClimberSim): number {
  const s = sim.getState();
  const u = bodyUp(s);
  let m = 0;
  for (let i = 0; i < 4; i++) {
    const L = s.limbs[IDS[i]];
    if (!L.holdId && !L.smearing) continue;
    if (L.dragging) continue;
    m = Math.max(m, envEval(i, L.anchor.x, L.anchor.y, u.x, u.y, L.pos.x, L.pos.y).excess);
  }
  return m;
}

describe('anatomy — ClimberSim', () => {
  const s0 = settled();
  const hip = s0.limbs.RF.anchor;

  it('a foot cannot snap to a hold 0.5 m directly above its hip', () => {
    const sim = new ClimberSim(lab([hold('up', hip.x, hip.y + 0.5, 'jug', 0.09, 'foot')]));
    sim.start();
    run(sim, 1);
    expect(sim.reachableHolds('RF')).not.toContain('up');
    expect(sim.predictGrip('RF', 'up')).toBe(0);
    const y0 = sim.getState().pelvis.y;
    const ev = moveLimb(sim, 'RF', 'up');
    expect(ev.some((e) => e.type === 'grab' && e.holdId === 'up')).toBe(false);
    expect(sim.getState().limbs.RF.holdId).not.toBe('up');
    // and the body was not hauled up after the foot
    expect(sim.getState().pelvis.y).toBeLessThan(y0 + 0.03);
  });

  it('a foot can high-step to a hold ~0.25 m above and 0.35 m out from the hip', () => {
    const sim = new ClimberSim(lab([hold('hi', hip.x + 0.35, hip.y + 0.25, 'jug', 0.09, 'foot')]));
    sim.start();
    run(sim, 1);
    const ev = moveLimb(sim, 'RF', 'hi');
    run(sim, 2, ev);
    expect(ev.some((e) => e.type === 'grab' && e.holdId === 'hi')).toBe(true);
    expect(sim.getState().limbs.RF.holdId).toBe('hi');
    expect(ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
    expect(maxExcess(sim)).toBeLessThan(0.01);
  });

  it('dragging the hips down below a high foot is stopped where the leg would fold past its limit', () => {
    const sim = new ClimberSim(lab([hold('hi', hip.x + 0.38, hip.y + 0.12, 'jug', 0.09, 'foot')]));
    sim.start();
    run(sim, 1);
    moveLimb(sim, 'RF', 'hi');
    run(sim, 1);
    const p0 = { ...sim.getState().pelvis };
    sim.setHipTarget({ x: p0.x - 0.5, y: p0.y - 0.6 });
    let worst = 0;
    let wobble = 0;
    let prev = { ...p0 };
    const ev: SimEvent[] = [];
    for (let k = 0; k < 150; k++) {
      run(sim, 1 / 60, ev);
      const s = sim.getState();
      if (k >= 60) {
        worst = Math.max(worst, maxExcess(sim), ...Array.from(sim.envelopeViolation()));
        wobble = Math.max(wobble, Math.hypot(s.pelvis.x - prev.x, s.pelvis.y - prev.y));
      }
      prev = { ...s.pelvis };
    }
    const s = sim.getState();
    expect(s.limbs.RF.holdId).toBe('hi');
    expect(worst).toBeLessThan(0.01);
    expect(wobble).toBeLessThan(0.006); // settled: no jitter, no explosion
    // the hips moved (the player's pull works) but stopped well short of the target
    expect(s.pelvis.y).toBeLessThan(p0.y - 0.03);
    expect(s.pelvis.y).toBeGreaterThan(p0.y - 0.45);
    // the leg never points above the hip: φ inside the allowed range
    const u = bodyUp(s);
    const e = envEval(3, s.limbs.RF.anchor.x, s.limbs.RF.anchor.y, u.x, u.y, s.limbs.RF.pos.x, s.limbs.RF.pos.y);
    expect(e.over).toBe(0);
    expect(ev.some((x) => x.type === 'slip' || x.type === 'fall')).toBe(false);
    sim.setHipTarget(null);
  });

  it('a hand cannot grab a hold below the feet', () => {
    const sim = new ClimberSim(lab([hold('low', 0.35, 0.55, 'jug', 0.1, 'hand')]));
    sim.start();
    run(sim, 1);
    expect(sim.reachableHolds('RH')).not.toContain('low');
    const ev = moveLimb(sim, 'RH', 'low');
    expect(ev.some((e) => e.type === 'grab' && e.holdId === 'low')).toBe(false);
    expect(sim.getState().limbs.RH.holdId).toBe('s2');
  });

  it('a crossover above the head works, and the crossing arm goes in front', () => {
    const lh = s0.limbs.LH.pos;
    const sim = new ClimberSim(lab([hold('x', lh.x - 0.3, lh.y + 0.35, 'jug', 0.1, 'hand')]));
    sim.start();
    run(sim, 1);
    const ev = moveLimb(sim, 'RH', 'x');
    run(sim, 1, ev);
    const s = sim.getState();
    expect(s.limbs.RH.holdId).toBe('x');
    expect(s.limbs.RH.pos.x).toBeLessThan(s.limbs.LH.pos.x); // crossed over
    expect(s.limbs.RH.pos.y).toBeGreaterThan(s.chest.y + BODY.neck); // above the head's base
    expect(ev.some((e) => e.type === 'slip' || e.type === 'fall')).toBe(false);
    // segments cross in the wall plane → the right arm is the front one
    const crossing = segmentsCross(s.limbs.RH.anchor.x, s.limbs.RH.anchor.y, s.limbs.RH.pos.x, s.limbs.RH.pos.y, s.limbs.LH.anchor.x, s.limbs.LH.anchor.y, s.limbs.LH.pos.x, s.limbs.LH.pos.y);
    if (crossing) {
      expect(s.limbs.RH.front).toBe(true);
      expect(s.limbs.LH.front).toBe(false);
    }
  });

  it('a dragged foot never pulls the body up toward a target above the hip', () => {
    const sim = new ClimberSim(lab());
    sim.start();
    run(sim, 1);
    const p0 = sim.getState().pelvis.y;
    sim.beginDrag('RF');
    let maxP = p0;
    for (let k = 0; k < 90; k++) {
      const a = sim.getState().limbs.RF.anchor;
      sim.dragTo('RF', { x: a.x + 0.1, y: a.y + 0.6 });
      run(sim, 1 / 60);
      maxP = Math.max(maxP, sim.getState().pelvis.y);
      // the foot itself stays inside its (snap-padded) envelope
      const s = sim.getState();
      expect(envelopeDistance(3, s.limbs.RF.anchor, bodyUp(s), s.limbs.RF.pos)).toBeLessThan(SIM.reachTolerance + 0.005);
    }
    expect(maxP).toBeLessThan(p0 + 0.02);
    sim.endDrag('RF');
  });

  it('reachEnvelope: polygon around the live anchor, containing the reachable holds', () => {
    const sim = new ClimberSim(generateBoulder({ seed: 5, grade: 2 }));
    sim.start();
    run(sim, 0.5);
    for (const l of IDS) {
      const poly = sim.reachEnvelope(l);
      expect(poly.length).toBe(POLYGON_POINTS);
      expect(poly[0]).toEqual(sim.limbAnchor(l));
      const s = sim.getState();
      const u = bodyUp(s);
      for (let k = 1; k < poly.length; k++) expect(envelopeExcess(LIMB_INDEX[l], poly[0], u, poly[k])).toBeCloseTo(SIM.reachTolerance, 4);
      for (const id of sim.reachableHolds(l)) {
        const h = sim.boulder.holds.find((x) => x.id === id)!;
        const c = contactPoint(h, LIMB_INDEX[l], false, { x: 0, y: 0 });
        expect(inEnvelope(LIMB_INDEX[l], poly[0], u, c, SIM.reachTolerance + 0.03)).toBe(true);
      }
    }
  });
});

describe('anatomy — no self-clipping', () => {
  const s0 = settled();

  it('hands and feet never share a spot', () => {
    // the right foot can't step onto the jug the right hand holds, nor right next to the hand
    const lowHand = hold('lj', 0.42, 1.25, 'jug', 0.12, 'hand');
    const next = hold('nx', 0.45, 1.2, 'edge', 0.05, 'foot');
    const sim = new ClimberSim(lab([lowHand, next]));
    sim.start();
    run(sim, 1);
    const ev = moveLimb(sim, 'RH', 'lj');
    expect(ev.some((e) => e.type === 'grab' && e.holdId === 'lj')).toBe(true);
    run(sim, 0.5);
    expect(sim.reachableHolds('RF')).not.toContain('lj');
    expect(sim.reachableHolds('RF')).not.toContain('nx');
    const ev2 = moveLimb(sim, 'RF', 'lj');
    expect(ev2.some((e) => e.type === 'grab' && e.holdId === 'lj')).toBe(false);
    // and a hand can't take a hold a foot stands on
    const foot = new ClimberSim(lab());
    foot.start();
    run(foot, 1);
    expect(foot.reachableHolds('RH')).not.toContain('f2');
  });

  it('matching needs room: no hand match on a small crimp, no two feet on a chip; the top always matches', () => {
    expect(canMatch(0, hold('c', 0, 2, 'crimp', 0.035, 'hand'))).toBe(false);
    expect(canMatch(0, hold('p', 0, 2, 'pocket', 0.05, 'hand'))).toBe(false);
    expect(canMatch(1, hold('j', 0, 2, 'jug', 0.1, 'hand'))).toBe(true);
    expect(canMatch(1, hold('t', 0, 2, 'crimp', 0.03, 'top'))).toBe(true);
    expect(canMatch(2, hold('f', 0, 1, 'foot', 0.025, 'foot'))).toBe(false);
    expect(canMatch(3, hold('v', 0, 1, 'volume', 0.3, 'foot'))).toBe(true);
    const sim = new ClimberSim(lab([hold('cr', 0.0, 2.35, 'crimp', 0.035, 'hand')]));
    sim.start();
    run(sim, 1);
    moveLimb(sim, 'RH', 'cr');
    expect(sim.getState().limbs.RH.holdId).toBe('cr');
    run(sim, 0.5);
    expect(sim.reachableHolds('LH')).not.toContain('cr');
  });

  it('a limb is never placed through another one near the wall (under a forearm / shin)', () => {
    // right hand high on the wall: a point right on its forearm, just below the grip
    const contacts = [null, { x: 0.25, y: 2.4, hold: null }, null, null];
    const ax = [-0.17, 0.21, -0.09, 0.13];
    const ay = [1.83, 1.83, 1.33, 1.33];
    expect(placementBlocked(0, 0.245, 2.3, null, contacts, ax, ay)).toBe(true);
    // the same arm near the shoulder is well off the wall: crossing there is fine
    expect(placementBlocked(0, 0.22, 1.95, null, contacts, ax, ay)).toBe(false);
    // a foot on the other shin, just above that foot
    const feet = [null, null, { x: -0.25, y: 0.75, hold: null }, null];
    expect(placementBlocked(3, -0.23, 0.82, null, feet, ax, ay)).toBe(true);
    expect(placementBlocked(3, 0.3, 0.8, null, feet, ax, ay)).toBe(false);
  });

  it('a backstep crosses the legs with the crossing leg in front; uncrossing clears it', () => {
    const rf = s0.limbs.RF.pos;
    const sim = new ClimberSim(lab([hold('bs', rf.x + 0.17, rf.y + 0.2, 'jug', 0.08, 'foot'), hold('home', -0.3, 0.95, 'jug', 0.08, 'foot')]));
    sim.start();
    run(sim, 1);
    const ev = moveLimb(sim, 'LF', 'bs');
    run(sim, 0.8, ev);
    let s = sim.getState();
    expect(s.limbs.LF.holdId).toBe('bs');
    expect(s.limbs.LF.pos.x).toBeGreaterThan(s.limbs.RF.pos.x); // feet crossed
    expect(s.limbs.LF.front).toBe(true);
    expect(s.limbs.LF.layer).toBeGreaterThan(0);
    expect(s.limbs.RF.front).toBe(false);
    expect(maxExcess(sim)).toBeLessThan(0.01);
    moveLimb(sim, 'LF', 'home');
    run(sim, 0.8);
    s = sim.getState();
    expect(s.limbs.LF.holdId).toBe('home');
    expect(s.limbs.LF.front).toBe(false);
    for (const l of IDS) expect(s.limbs[l].layer).toBe(0);
  });

  it('the crossing order sticks while the limbs stay crossed', () => {
    const lh = s0.limbs.LH.pos;
    const sim = new ClimberSim(lab([hold('x', lh.x - 0.32, lh.y + 0.3, 'jug', 0.1, 'hand'), hold('x2', lh.x - 0.12, lh.y + 0.42, 'jug', 0.1, 'hand')]));
    sim.start();
    run(sim, 1);
    moveLimb(sim, 'RH', 'x');
    run(sim, 0.6);
    const before = sim.getState().limbs.RH.front;
    // the left hand moves while the arms stay crossed: the right arm stays in front
    sim.beginDrag('LH');
    for (let k = 0; k < 20; k++) {
      sim.dragTo('LH', { x: lh.x, y: lh.y + 0.05 });
      run(sim, 1 / 60);
      if (before) expect(sim.getState().limbs.RH.front).toBe(true);
    }
    sim.endDrag('LH');
  });
});

describe('anatomy — whole climbs stay anatomical', () => {
  it('the bot sends generated boulders without any limb leaving its envelope', { timeout: 120_000 }, () => {
    const failed: string[] = [];
    for (const [seed, grade] of [
      [61, 1],
      [62, 3],
      [63, 5],
      [64, 7],
      [65, 9],
      [66, 11],
    ]) {
      const b = generateBoulder({ seed, grade });
      const sim = new ClimberSim(b);
      let worst = 0;
      let footUp = 0;
      // drive the bot manually so every frame can be checked
      const r = autoClimbChecked(sim, () => {
        worst = Math.max(worst, ...Array.from(sim.envelopeViolation()));
        const s = sim.getState();
        const u = bodyUp(s);
        for (const l of ['LF', 'RF'] as const) {
          const L = s.limbs[l];
          if (!L.holdId && !L.smearing) continue;
          const e = envEval(LIMB_INDEX[l], L.anchor.x, L.anchor.y, u.x, u.y, L.pos.x, L.pos.y);
          footUp = Math.max(footUp, e.over);
        }
      });
      if (!r) failed.push(`${b.id}: not sent`);
      // (≤ 3 cm: the bot's hip handle can hold the body a little past the edge, which the limb feels
      // as strain; anything more would pop it off)
      if (worst > 0.03) failed.push(`${b.id}: envelope violation ${worst.toFixed(3)}`);
      if (footUp > 1) failed.push(`${b.id}: a foot pointed into the forbidden wedge (${footUp.toFixed(1)}°)`);
    }
    expect(failed).toEqual([]);
  });
});

/** autoClimb with a per-frame callback (the bot only uses the public input API). */
function autoClimbChecked(sim: ClimberSim, each: () => void): boolean {
  const bot = new BetaBot(sim);
  sim.start();
  let events: SimEvent[] = [];
  for (let t = 0; t < 240 && !bot.done && !bot.failed; t += 1 / 60) {
    bot.update(1 / 60, events);
    events = sim.step(1 / 60);
    if (sim.getState().phase === 'climbing') each();
    if (sim.getState().phase === 'topped') break;
  }
  return sim.getState().phase === 'topped';
}

describe('anatomy — tutorial margins', () => {
  /**
   * Player-like move: drag the limb onto the hold in 0.4 s and keep the finger there. Returns the
   * envelope slack (m) of the target 0.3 s after the finger arrives and the best slack within 1 s.
   */
  function reachSlack(sim: ClimberSim, limb: LimbId, holdId: string): { early: number; best: number; grabbed: boolean } {
    const b = sim.boulder;
    const h = b.holds.find((x) => x.id === holdId)!;
    const li = LIMB_INDEX[limb];
    const s0 = sim.getState();
    const t = contactPoint(h, li, s0.limbs[IDS[li ^ 1]].holdId === h.id, { x: 0, y: 0 });
    const slack = (): number => {
      const s = sim.getState();
      const u = bodyUp(s);
      const L = s.limbs[limb];
      const e = envEval(li, L.anchor.x, L.anchor.y, u.x, u.y, t.x, t.y);
      return e.over > 0 ? -e.excess : e.rMax - e.r;
    };
    sim.beginDrag(limb);
    const p0 = { ...sim.getState().limbs[limb].pos };
    for (let k = 1; k <= 24; k++) {
      const f = k / 24;
      sim.dragTo(limb, { x: p0.x + (t.x - p0.x) * f, y: p0.y + (t.y - p0.y) * f });
      run(sim, 1 / 60);
    }
    let early = -1;
    let best = -1;
    for (let k = 0; k < 60; k++) {
      sim.dragTo(limb, t);
      run(sim, 1 / 60);
      const m = slack();
      if (k === 17) early = m;
      best = Math.max(best, m);
    }
    const ev = sim.endDrag(limb);
    return { early, best, grabbed: ev.some((e) => e.type === 'grab' && e.holdId === holdId) };
  }

  // the app runs the lesson with TUTORIAL_SIM_OPTIONS (src/tutorial): assist 0.5, invincible
  for (const [label, opts] of [
    ['default sim', {}],
    ['tutorial options', { assist: 0.5, invincible: true }],
  ] as const) {
    it(`every scripted step has ≥ 5 cm of reach margin (${label})`, () => {
      const b = tutorialBoulder();
      const sim = new ClimberSim(b, opts);
      sim.start();
      run(sim, 1);
      const rows: string[] = [];
      for (const step of TUTORIAL_SEQUENCE) {
        if (step.teach === 'hips') {
          const h = b.holds.find((x) => x.id === step.holdId)!;
          sim.setHipTarget({ x: h.x, y: sim.getState().pelvis.y + 0.1 });
          run(sim, 1);
          sim.setHipTarget(null);
          continue;
        }
        const r = reachSlack(sim, step.limb, step.holdId);
        run(sim, step.teach === 'shake' ? 1.2 : 0.6);
        rows.push(`${step.limb}→${step.holdId}: early ${r.early.toFixed(3)} best ${r.best.toFixed(3)}`);
        expect(r.grabbed, rows.at(-1)).toBe(true);
        // the climber's reach brings every hold at least 5 cm inside the anatomical envelope …
        expect(r.best, rows.at(-1)).toBeGreaterThanOrEqual(0.05);
        // … and 0.3 s after the finger arrives it is already well inside the snap range
        expect(r.early + SIM.reachTolerance, rows.at(-1)).toBeGreaterThanOrEqual(0.05);
      }
      run(sim, 1.5);
      expect(sim.getState().phase).toBe('topped');
    });
  }
});

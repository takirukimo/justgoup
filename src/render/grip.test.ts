// Hands and feet on the REAL hold geometry (owner feedback v0.2: "feet not sticking to the hold, same
// with hands, they just look slapped on or are in the air"): the placement sits on the drawn hold's
// surface, the fingers wrap its lip without going through the plastic, a shoe's sole rests on its top,
// and the finger model the placement is computed with is the rig's own.
import '../../dev/character-stub';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { HoldShape, HoldType } from '../core/types';
import { holdGeometry } from './holds';
import { createHandSite, fingerPoint, gripStyleOf, handSite, holdSurface, signedDist, soleContact, PALM, FING_A, FING_L } from './grip';
import { ClimberSim } from '../game/climber-sim';
import { tutorialBoulder } from '../game/generator';
import { BONE, ClimberModel } from './climber';
import { WallFrame } from './wall-frame';

const q = new THREE.Vector3();
const w = new THREE.Vector3();
const hx = new THREE.Vector3();

/** Deepest skin point of the fingers inside the hold (m, ≥ 0) for a site. */
function fingersInside(type: HoldType, shape: HoldShape | undefined, size: number, seed: number, th: number, side: number): number {
  const g = holdGeometry(type, seed, size, 0, { shape });
  const s = holdSurface(g, type);
  const site = handSite(s, gripStyleOf(type, shape), 0, 0.32 * size, -Math.sin(th), Math.cos(th), side, 3, 1, createHandSite());
  hx.crossVectors(site.dir, site.up);
  let worst = 0;
  for (let f = 0; f < 4; f++)
    for (const [seg, t] of [[2, 0.8], [1, 0.5], [1, 1]] as const) {
      fingerPoint(f, side, site.a[f], site.b[f], seg, t, q);
      w.copy(site.p).addScaledVector(hx, q.x - site.local.x).addScaledVector(site.dir, q.y - site.local.y).addScaledVector(site.up, q.z - site.local.z);
      worst = Math.min(worst, signedDist(s, w));
    }
  return -worst;
}

describe('hands on the drawn holds', { timeout: 120_000 }, () => {
  it('crimps, edges and jugs: the fingers hook the lip without going through the plastic', () => {
    for (const [type, shape, size, okShare] of [
      ['crimp', undefined, 0.045, 0.95],
      ['crimp', 'micro', 0.035, 0.95],
      ['edge', undefined, 0.06, 0.85],
      ['jug', undefined, 0.09, 0.6],
      ['jug', 'bucket', 0.09, 0.55],
    ] as const) {
      let ok = 0;
      let n = 0;
      for (let seed = 1; seed <= 12; seed++)
        for (const th of [0, 0.25, -0.25])
          for (const side of [-1, 1]) {
            n++;
            if (fingersInside(type, shape, size, seed * 7, th, side) < 0.004) ok++;
          }
      expect(ok / n, `${type}${shape ? '/' + shape : ''}`).toBeGreaterThanOrEqual(okShare);
    }
  });

  it('the hook contact is on the hold (the lip under the fingers), the palm off its face', () => {
    for (const type of ['jug', 'edge', 'crimp'] as const) {
      const size = type === 'jug' ? 0.09 : type === 'edge' ? 0.06 : 0.045;
      const g = holdGeometry(type, 21, size, 0, {});
      const s = holdSurface(g, type);
      const site = handSite(s, gripStyleOf(type), 0, 0.3 * size, 0, 1, 1, 3, 1, createHandSite());
      // the contact (the pads on an edge / crimp; the knuckle row in front of a jug's lip) is within a
      // finger's reach of the plastic, above the hold's middle (its grip side)
      expect(Math.abs(signedDist(s, site.p)), type).toBeLessThan(type === 'jug' ? 0.045 : 0.02);
      expect(site.p.y).toBeGreaterThan(0);
      // the fingers point over the grip side (+y), the back of the hand faces out (+z)
      expect(site.dir.y).toBeGreaterThan(0.6);
      expect(site.up.z).toBeGreaterThan(0.6);
    }
  });

  it('pockets: the fingers that go in are centred on the hole', () => {
    for (const fingers of [1, 2, 3] as const) {
      const g = holdGeometry('pocket', 13, 0.055, 0, { fingers });
      const s = holdSurface(g, 'pocket');
      expect(s.hole).not.toBeNull();
      const site = handSite(s, gripStyleOf('pocket'), 0, 0, 0, 1, 1, fingers, 1, createHandSite());
      // the contact sits on the rim under the hole, across the hole's x
      expect(Math.abs(site.p.x - s.hole!.x)).toBeLessThan(0.012);
      expect(site.p.y).toBeLessThan(s.hole!.y + 0.003);
      // the folded fingers curl into the palm, the inserted ones less
      const sel = fingers === 1 ? [1] : fingers === 2 ? [1, 2] : [0, 1, 2];
      const free = [0, 1, 2, 3].filter((f) => !sel.includes(f));
      for (const f of free) for (const i of sel) expect(site.a[f]).toBeGreaterThan(site.a[i]);
    }
  });

  it('slopers: the hand lies on the dome, each finger following it down', () => {
    const g = holdGeometry('sloper', 5, 0.1, 0, {});
    const s = holdSurface(g, 'sloper');
    const site = handSite(s, gripStyleOf('sloper'), 0, 0.03, 0, 1, 1, 3, 1, createHandSite());
    hx.crossVectors(site.dir, site.up);
    for (let f = 0; f < 4; f++) {
      // the distal pad touches the dome (within a few mm either side)
      fingerPoint(f, 1, site.a[f], site.b[f], 1, 0.5, q);
      w.copy(site.p).addScaledVector(hx, q.x - site.local.x).addScaledVector(site.dir, q.y - site.local.y).addScaledVector(site.up, q.z - site.local.z);
      expect(Math.abs(signedDist(s, w))).toBeLessThan(0.012);
    }
  });
});

describe('feet on the drawn holds', { timeout: 60_000 }, () => {
  it("the sole's support point is on the hold and nothing of it pokes through the sole", () => {
    const up = new THREE.Vector3(0, 0.92, 0.38).normalize();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const [type, shape, size] of [['foot', undefined, 0.045], ['foot', 'chip', 0.03], ['edge', undefined, 0.06], ['jug', undefined, 0.09]] as const) {
      const g = holdGeometry(type, 9, size, 0, { shape });
      const s = holdSurface(g, type);
      soleContact(s, up, 0, 0.3 * size, 1, 0, 0.034, c, n);
      // on top of the hold (its upper half)
      expect(c.y, type).toBeGreaterThan(0);
      expect(signedDist(s, c), type).toBeGreaterThan(-0.004);
      // no point of the hold under the shoe's width stands above the sole plane
      let above = 0;
      for (let i = 0; i < s.count; i++) {
        const x = s.pts[i * 3];
        if (Math.abs(x) > 0.034) continue;
        const h = (x - c.x) * up.x + (s.pts[i * 3 + 1] - c.y) * up.y + (s.pts[i * 3 + 2] - c.z) * up.z;
        if (h > above) above = h;
      }
      expect(above, type).toBeLessThan(0.0015);
    }
  });

  it('a foot on a volume stands on the face under it', () => {
    const g = holdGeometry('volume', 4, 0.28, 0, {});
    const s = holdSurface(g, 'volume');
    expect(s.planeCount).toBeGreaterThan(2);
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    soleContact(s, new THREE.Vector3(0, 1, 0), 0.02, 0.08, 1, 0, 0.034, c, n);
    expect(c.z).toBeGreaterThan(0.01);
    expect(n.z).toBeGreaterThan(0.05);
    // the point is on that face's plane
    expect(Math.abs(n.dot(c) - [...Array(s.planeCount).keys()].map((i) => s.planes![i * 4 + 3]).reduce((m, d) => (Math.abs(d - n.dot(c)) < Math.abs(m - n.dot(c)) ? d : m), Infinity))).toBeLessThan(0.002);
  });
});

describe('the placement uses the rig\'s own hand', { timeout: 60_000 }, () => {
  it('finger forward kinematics match the skinned finger bones', () => {
    const b = tutorialBoulder();
    const sim = new ClimberSim(b, { invincible: true });
    sim.reset();
    sim.start();
    const frame = new WallFrame(b.wallAngle);
    frame.setWall(b);
    const model = new ClimberModel({ head: 'ibex' });
    for (let i = 0; i < 30; i++) {
      sim.step(1 / 60);
      model.pose(sim.getState(), frame, 1 / 60);
    }
    const goal = (model as unknown as { goal: { hands: { fingA: number[]; fingB: number[] }[] } }).goal;
    for (const s of [0, 1]) {
      const B = model.rig.bones;
      const hand = B[s ? BONE.handR : BONE.handL];
      const inv = hand.quaternion.clone().invert();
      const prox = s ? [BONE.fingR, BONE.fingR1, BONE.fingR2, BONE.fingR3] : [BONE.fingL, BONE.fingL1, BONE.fingL2, BONE.fingL3];
      for (let f = 0; f < 4; f++) {
        // the proximal pad at its middle: skin = centre line + the palmar normal × the pad radius
        fingerPoint(f, s ? 1 : -1, goal.hands[s].fingA[f], goal.hands[s].fingB[f], 2, 0.5, q);
        const bone = B[prox[f]];
        w.set(0, FING_A * FING_L[f] * 0.5, 0).applyQuaternion(bone.quaternion).add(bone.position).sub(model.rig.joints.wrist[s]).applyQuaternion(inv);
        // centre line → skin is ≤ 9 mm; the knuckle row sits at PALM
        expect(q.distanceTo(w)).toBeLessThan(0.0095);
        expect(Math.abs(w.y - PALM)).toBeLessThan(FING_A * 1.2);
      }
    }
  });
});

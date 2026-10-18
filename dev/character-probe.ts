// CHARACTER QA probe (not shipped): measures the posed body every frame in the REAL game.
//   const { startProbe } = await import('/dev/character-probe.ts'); startProbe(() => rigs)
// For every rig (climber, guide) it reports the worst capsule interpenetration between body parts
// that must never overlap (limb ↔ limb, forearm / shin ↔ torso, any limb ↔ head + horns), joints
// below the crash-pad surface, and IK targets the anatomy had to pull in (fallbacks), each with the
// phase and time it happened, plus how many frames went over the thresholds.

import * as THREE from 'three';
import { GAME } from '../src/config/tuning';
import type { BodyRig } from '../src/render/climber';

export interface ProbeTarget {
  name: string;
  rig: BodyRig;
  /** Current phase label (climber: sim phase; guide: pose). */
  phase: () => string;
  /** Wall plane (world) for the pad zone test, and the floor height under the pads. */
  wallN: THREE.Vector3;
  wallP: THREE.Vector3;
}

interface Worst {
  v: number;
  what: string;
  phase: string;
  t: number;
}

export interface ProbeStats {
  frames: number;
  pen: Worst;
  floor: Worst;
  /** Frames with any pair penetrating more than PEN_BAD / any joint under the pad by > FLOOR_BAD. */
  penFrames: number;
  floorFrames: number;
  fallbackFrames: number;
  fallbackPhases: Record<string, number>;
}

const PEN_BAD = 0.02;
const FLOOR_BAD = 0.01;

const SEG = ['chest', 'belly', 'pelvis', 'neck'];
const LIMB = ['upperArmL', 'foreArmL', 'thighL', 'shinL', 'upperArmR', 'foreArmR', 'thighR', 'shinR'];

const a1 = new THREE.Vector3();
const b1 = new THREE.Vector3();
const d1 = new THREE.Vector3();
const d2 = new THREE.Vector3();
const r = new THREE.Vector3();

function segDist(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): [number, number, number] {
  d1.subVectors(q1, p1);
  d2.subVectors(q2, p2);
  r.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;
  if (a < 1e-12 && e < 1e-12) return [p1.distanceTo(p2), 0, 0];
  if (a < 1e-12) t = Math.min(1, Math.max(0, f / e));
  else {
    const c = d1.dot(r);
    if (e < 1e-12) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = d1.dot(d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  a1.copy(p1).addScaledVector(d1, s);
  b1.copy(p2).addScaledVector(d2, t);
  return [a1.distanceTo(b1), s, t];
}

interface Cap {
  a: THREE.Vector3;
  b: THREE.Vector3;
  ra: number;
  rb: number;
  name: string;
  /** 0 torso/neck, 1 head, 2 limb */
  kind: number;
  limb: number;
  seg: number;
}

/** Pairs that are anatomically attached (contact there is normal). */
function attached(x: Cap, y: Cap): boolean {
  if (x.kind === 2 && y.kind === 2) return x.limb === y.limb; // same limb: upper ↔ fore, thigh ↔ shin
  const limb = x.kind === 2 ? x : y.kind === 2 ? y : null;
  const other = limb === x ? y : x;
  if (!limb) return true; // torso ↔ torso / head ↔ neck
  const arm = limb.limb === 0 || limb.limb === 2;
  if (other.kind === 0) {
    if (arm && limb.seg === 0) return other.name === 'chest' || other.name === 'neck'; // shoulder joint
    if (!arm && limb.seg === 0) return other.name === 'pelvis'; // hip joint
  }
  return false;
}

export function startProbe(targets: () => ProbeTarget[]): { stats: Record<string, ProbeStats>; reset(): void; stop(): void } {
  const stats: Record<string, ProbeStats> = {};
  const fresh = (): ProbeStats => ({
    frames: 0,
    pen: { v: 0, what: '', phase: '', t: 0 },
    floor: { v: 0, what: '', phase: '', t: 0 },
    penFrames: 0,
    floorFrames: 0,
    fallbackFrames: 0,
    fallbackPhases: {},
  });
  const caps: Cap[] = Array.from({ length: 32 }, () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), ra: 0, rb: 0, name: '', kind: 0, limb: 0, seg: 0 }));
  const t0 = performance.now();
  let on = true;
  const tick = () => {
    if (!on) return;
    const now = (performance.now() - t0) / 1000;
    for (const tg of targets()) {
      const st = (stats[tg.name] ??= fresh());
      const rig = tg.rig;
      if (!rig.root.visible || !rig.root.parent?.visible) continue;
      let n = 0;
      rig.forEachProxy((a, b, ra, rb) => {
        const c = caps[n];
        c.a.copy(a);
        c.b.copy(b);
        c.ra = ra;
        c.rb = rb;
        n++;
      });
      const headN = n - 12;
      for (let i = 0; i < n; i++) {
        const c = caps[i];
        if (i < 4) {
          c.kind = 0;
          c.name = SEG[i];
        } else if (i < 4 + headN) {
          c.kind = 1;
          c.name = `head${i - 4}`;
        } else {
          const k = i - 4 - headN;
          c.kind = 2;
          c.name = LIMB[k];
          // limb index: 0 left arm, 1 left leg, 2 right arm, 3 right leg (seg 0 = proximal)
          c.limb = Math.floor(k / 2);
          c.seg = k % 2;
        }
      }
      // world → the rig root may be transformed (guide / climber are at the origin; keep generic)
      const phase = tg.phase();
      let worst = 0;
      let what = '';
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const x = caps[i];
          const y = caps[j];
          if (x.kind !== 2 && y.kind !== 2) continue;
          if (attached(x, y)) continue;
          const [d, s, t] = segDist(x.a, x.b, y.a, y.b);
          const pen = x.ra + (x.rb - x.ra) * s + y.ra + (y.rb - y.ra) * t - d;
          if (pen > worst) {
            worst = pen;
            what = `${x.name}↔${y.name}`;
          }
        }
      }
      st.frames++;
      if (worst > PEN_BAD) st.penFrames++;
      if (worst > st.pen.v) st.pen = { v: worst, what, phase, t: now };
      // joints under the pad surface (only in the pad zone in front of the wall)
      const J = rig.joints;
      const padTop = GAME.padHeight;
      let fl = 0;
      let flw = '';
      const pts: [string, THREE.Vector3][] = [
        ['kneeL', J.knee[0]],
        ['kneeR', J.knee[1]],
        ['ankleL', J.ankle[0]],
        ['ankleR', J.ankle[1]],
        ['toeL', J.toe[0]],
        ['toeR', J.toe[1]],
        ['wristL', J.wrist[0]],
        ['wristR', J.wrist[1]],
      ];
      for (const [nm, p] of pts) {
        const out = d1.subVectors(p, tg.wallP).dot(tg.wallN);
        if (out < 0.25) continue;
        // a toe / ankle / wrist on top of the pad sits ≥ its own thickness above it
        const minY = nm.startsWith('ankle') ? padTop + 0.06 : nm.startsWith('toe') ? padTop : padTop + 0.02;
        const under = minY - p.y;
        if (under > fl) {
          fl = under;
          flw = nm;
        }
      }
      if (fl > FLOOR_BAD) st.floorFrames++;
      if (fl > st.floor.v) st.floor = { v: fl, what: flw, phase, t: now };
      if (rig.fallback.some(Boolean)) {
        st.fallbackFrames++;
        st.fallbackPhases[phase] = (st.fallbackPhases[phase] ?? 0) + 1;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stats,
    reset() {
      for (const k of Object.keys(stats)) delete stats[k];
    },
    stop() {
      on = false;
    },
  };
}

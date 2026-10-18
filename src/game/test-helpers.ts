// Small synchronous helpers for the game tests: hand-built problems and player-like limb moves.

import type { BoulderDef, HoldDef, HoldRole, HoldType, LimbId } from '../core/types';
import type { ClimberSimAPI, SimEvent } from '../core/contracts';
import { contactPoint, LIMB_INDEX } from './holds';

export function hold(id: string, x: number, y: number, type: HoldType, size: number, role: HoldRole, angleDeg = -90): HoldDef {
  return { id, x, y, type, size, angle: (angleDeg * Math.PI) / 180, role, color: '#F2C230', seed: 1 };
}

export function makeBoulder(holds: HoldDef[], opts: Partial<BoulderDef> = {}): BoulderDef {
  return {
    id: 'test',
    name: 'Test Problem',
    grade: 0,
    mode: 'boulder',
    wallAngle: 0,
    width: 4.6,
    height: 4.5,
    holds,
    color: '#F2C230',
    seed: 1,
    ...opts,
  };
}

/** Step the sim for `secs` at 60 fps, collecting events. */
export function run(sim: ClimberSimAPI, secs: number, out: SimEvent[] = []): SimEvent[] {
  const n = Math.round(secs * 60);
  for (let k = 0; k < n; k++) for (const e of sim.step(1 / 60)) out.push(e);
  return out;
}

/**
 * Move a limb onto a hold like a player: lift it, drag it there over ~0.4 s, hold the finger on the
 * hold until it would snap (≤ 2 s), release. Returns every event that happened.
 */
export function moveLimb(sim: ClimberSimAPI, limb: LimbId, holdId: string, out: SimEvent[] = []): SimEvent[] {
  const h = sim.boulder.holds.find((x) => x.id === holdId);
  if (!h) throw new Error(`no hold ${holdId}`);
  if (!sim.beginDrag(limb)) return out;
  const s = sim.getState();
  const p0 = { x: s.limbs[limb].pos.x, y: s.limbs[limb].pos.y };
  const pair: LimbId = limb === 'LH' ? 'RH' : limb === 'RH' ? 'LH' : limb === 'LF' ? 'RF' : 'LF';
  const target = contactPoint(h, LIMB_INDEX[limb], s.limbs[pair].holdId === h.id, { x: 0, y: 0 });
  for (let k = 1; k <= 24; k++) {
    const t = k / 24;
    sim.dragTo(limb, { x: p0.x + (target.x - p0.x) * t, y: p0.y + (target.y - p0.y) * t });
    run(sim, 1 / 60, out);
  }
  for (let k = 0; k < 120 && sim.snapCandidate(limb, target)?.id !== h.id; k++) {
    sim.dragTo(limb, target);
    run(sim, 1 / 60, out);
  }
  for (const e of sim.endDrag(limb)) out.push(e);
  return out;
}

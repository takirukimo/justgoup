// Release-intent geometry shared by the limb overlay and the HUD: where the sim's chalk bag and
// shake-out lane are (mirrors ClimberSim.releaseZone, so the preview targets light up exactly where a
// release does that), how a flick maps to throw power (mirrors ClimberSim.flickThrow), and the words
// the overlay / HUD use for chalk and throws. Pure functions, allocation-free where it matters.

import type { DynoPreview } from '../core/contracts';
import type { Vec2 } from '../core/types';
import { BODY, SIM } from '../config/tuning';

/** Spine "up" unit vector (pelvis → chest), into `out`; straight up when degenerate. */
export function spineUp(pelvis: Vec2, chest: Vec2, out: Vec2): Vec2 {
  const dx = chest.x - pelvis.x;
  const dy = chest.y - pelvis.y;
  const l = Math.hypot(dx, dy);
  if (l > 1e-9) {
    out.x = dx / l;
    out.y = dy / l;
  } else {
    out.x = 0;
    out.y = 1;
  }
  return out;
}

/** Chalk-bag centre (wall-local): behind the hips, 0.1 m down the spine from the pelvis. */
export function chalkBagAt(pelvis: Vec2, up: Vec2, out: Vec2): Vec2 {
  out.x = pelvis.x - up.x * 0.1;
  out.y = pelvis.y - up.y * 0.1;
  return out;
}

/** Is (x, y) inside the chalk-bag release zone (SIM.chalkZone around the bag)? */
export function inChalkZone(bag: Vec2, x: number, y: number): boolean {
  return Math.hypot(x - bag.x, y - bag.y) <= SIM.chalkZone;
}

/** Shake-out lane extents in the spine frame: metres below the shoulder and out to the hand's own side. */
export const SHAKE_LANE = {
  down0: SIM.shakeOutDrop,
  down1: BODY.armMax + 0.15,
  out0: -0.05,
  out1: 0.4,
} as const;

/**
 * Is a hand (0 = LH, 1 = RH) released at (x, y) in the shake-out lane: well below its shoulder `a`,
 * on its own side of the body (not across the chest)?
 */
export function inShakeLane(hand: number, a: Vec2, up: Vec2, x: number, y: number): boolean {
  const vx = x - a.x;
  const vy = y - a.y;
  const down = -(vx * up.x + vy * up.y);
  const side = hand === 0 ? -1 : 1;
  const out = side * (vx * up.y - vy * up.x);
  return down >= SHAKE_LANE.down0 && down <= SHAKE_LANE.down1 && out >= SHAKE_LANE.out0 && out <= SHAKE_LANE.out1;
}

/** Wall-local point of the shake lane at (down, out) in the spine frame of shoulder `a`, into `out`. */
export function shakeLanePoint(hand: number, a: Vec2, up: Vec2, down: number, outward: number, out: Vec2): Vec2 {
  const side = hand === 0 ? -1 : 1;
  // perpendicular to the spine, toward the hand's own side: side · (up.y, −up.x)
  out.x = a.x - up.x * down + side * up.y * outward;
  out.y = a.y - up.y * down - side * up.x * outward;
  return out;
}

/** Speed (m/s) of `v` along the direction from → to (negative when moving away). */
export function alongSpeed(v: Vec2, from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return 0;
  return (v.x * dx + v.y * dy) / l;
}

/** Is a flick this fast along the throw line committed (SIM.dynoMinFlick)? */
export function isFlick(along: number): boolean {
  return along >= SIM.dynoMinFlick;
}

/** Throw power of a committed flick (the sim's flickThrow mapping: 1 at SIM.dynoFlickRef). */
export function flickPower(along: number): number {
  const p = along / SIM.dynoFlickRef;
  return p < 0.6 ? 0.6 : p > 1.4 ? 1.4 : p;
}

/** Hand friction (1 fresh … 0 sweaty) as a word. */
export function frictionWord(f: number): 'FRESH' | 'WORN' | 'GREASY' {
  return f >= 0.7 ? 'FRESH' : f >= 0.4 ? 'WORN' : 'GREASY';
}

/** "+18 CM" / "+1.2 M": how far beyond the static reach a throw goes. */
export function riseLabel(rise: number): string {
  const r = Math.max(0, rise);
  return r < 0.995 ? `+${Math.round(r * 100)} CM` : `+${r.toFixed(1)} M`;
}

/**
 * Tag text for a throw preview: kind + rise; TOO FAR when it falls short, WON'T STICK when it reaches but
 * the catch would rip off (DynoPreview.sticks === false: the hold can't stop the body at that speed).
 */
export function throwWord(d: Pick<DynoPreview, 'kind' | 'rise' | 'feasible'> & { sticks?: boolean }): { word: string; type: string } {
  const word = !d.feasible ? 'TOO FAR' : d.sticks === false ? 'WON’T STICK' : d.kind === 'dyno' ? 'DYNO' : 'DEADPOINT';
  return { word, type: riseLabel(d.rise) };
}

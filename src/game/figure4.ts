// Figure 4 (advanced moves, shared by ClimberSim and the planner): the climber hooks a leg over the
// OPPOSITE holding arm (the knee / thigh over the forearm near the elbow) and presses the body up on it, so
// the free hand reaches ≈0.3–0.45 m higher than from the stance before. Both feet are off the wall while it
// lasts; it ends when a foot goes back on a hold. It needs a positive hold (a straight-down pull on it holds
// the body: jugs, buckets, big edges), and it is pumpy: the holding forearm carries ≈SIM.fig4Load BW in a
// locked-off position (× SIM.fig4Pump drain).

import type { HoldDef } from '../core/types';
import { BODY, SIM } from '../config/tuning';
import { dcos, dsin } from './dmath';
import { handCapacity, type GripContext } from './holds';
import type { Pose } from './statics';

/** The leg that hooks over hand k's arm: the opposite one (LH → RF, RH → LF). Limb indices. */
export const FIG4_LEG: readonly number[] = [3, 2];
/** The hand whose arm leg i hooks over (LF → RH, RF → LH), or −1 for a hand index. */
export const fig4HandOf = (leg: number): number => (leg === 3 ? 0 : leg === 2 ? 1 : -1);

const CTX: GripContext = { wallAngle: 0, assist: 0, pump: 0, overhang: 0, friction: 1, strength: 1 };

/**
 * The holding hand's capacity (BW) in a figure 4 on hold h: its capacity for a straight-down pull (the
 * forearm hangs below the hold, the leg on it) × SIM.fig4Grip, on a panel of `wallAngle` degrees.
 */
export function fig4Capacity(h: HoldDef, wallAngle: number, assist = 0, pump = 0, friction = 1, strength = 1): number {
  CTX.wallAngle = wallAngle;
  CTX.overhang = Math.max(0, dsin(wallAngle * (Math.PI / 180)));
  CTX.assist = assist;
  CTX.pump = pump;
  CTX.friction = friction;
  CTX.strength = strength;
  return handCapacity(h, dcos(h.angle), dsin(h.angle), 0, -1, false, CTX) * SIM.fig4Grip;
}

/** Can a figure 4 be held on h at all (a positive hold: fig4Capacity ≥ SIM.fig4MinCap, fresh)? */
export function fig4Hold(h: HoldDef, wallAngle: number, assist = 0, strength = 1): boolean {
  return fig4Capacity(h, wallAngle, assist, 0, 1, strength) >= SIM.fig4MinCap;
}

/**
 * Can the leg get over the arm: the holding hand's contact (hx, hy) within SIM.fig4LegReach of the leg's
 * hip joint (hipX, hipY) and above it (the knee comes up to the elbow).
 */
export function fig4LegReaches(hipX: number, hipY: number, hx: number, hy: number): boolean {
  const dx = hx - hipX;
  const dy = hy - hipY;
  return dy > 0.1 && dx * dx + dy * dy <= SIM.fig4LegReach * SIM.fig4LegReach;
}

/**
 * The pressed-up figure-4 body for holding hand k (0 LH, 1 RH) on a contact at (hx, hy), from the pose
 * `entry` the move starts in: the pelvis SIM.fig4Side toward the free side of the hand and SIM.fig4Drop
 * below it (rising at most SIM.fig4Rise, never sinking), the spine upright, leaning a little toward the free
 * side. Writes and returns `out`.
 */
export function fig4Pose(entry: Pose, hx: number, hy: number, k: number, out: Pose): Pose {
  const side = k === 0 ? 1 : -1;
  const want = hy - SIM.fig4Drop;
  const rise = Math.min(Math.max(want - entry.py, 0), SIM.fig4Rise);
  out.px = hx + side * SIM.fig4Side;
  out.py = entry.py + rise;
  // (deterministic trig: the planner, and so the generator, uses this pose)
  const lean = 0.16 * side;
  out.cx = out.px + dsin(lean) * BODY.spine;
  out.cy = out.py + dcos(lean) * BODY.spine;
  return out;
}

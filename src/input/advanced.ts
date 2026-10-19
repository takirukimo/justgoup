// Advanced moves on the input side (shared spec: heel-toe cam, bat hang, figure 4). The sim decides
// everything at release (ClimberSim.endDrag); these helpers PREVIEW what a release would do so the
// limb controls can show it honestly while a limb is dragged:
//
//   figure 4   a foot dragged onto the opposite holding hand / forearm hooks the leg over that arm
//              (sim.figure4Candidate; on the hand's own hold only below the grip, like endDrag)
//   bat hang   the last hand let go over nothing while both feet hook / cam on a steep panel
//              (sim.canBatHang; the other hand already off its hold)
//   cam        a foot put on a hold with an opposing surface a foot-length away jams between them
//              (holds.camPartner with the sim's own inputs, mirroring ClimberSim.camFor)
//
// Every sim call is optional (ClimberSimAPI's advanced moves are optional): a sim without them
// previews nothing. Nothing here allocates per call except the first use per boulder.

import type { ClimberSimAPI } from '../core/contracts';
import type { BoulderDef, ClimberState, HoldDef, LimbId, Vec2 } from '../core/types';
import { BODY } from '../config/tuning';
import { camPartner, contactPoint, usableByFoot, type CamPartner } from '../game/holds';
import { angleAt, profileOf, smoothAngleAt, type WallProfile } from '../game/wall-profile';

const IDS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];

/** The hand whose arm a foot hooks in a figure 4: the opposite one (left foot → right arm). */
export function fig4HandFor(foot: 'LF' | 'RF'): 'LH' | 'RH' {
  return foot === 'LF' ? 'RH' : 'LH';
}

/**
 * The holding arm's forearm as a segment in wall coordinates (the hand's contact toward the shoulder,
 * BODY.forearm + BODY.handLen long), the same span ClimberSim.figure4Candidate snaps to. Writes
 * `a` (hand end) and `b` (elbow end); false when that hand holds nothing.
 */
export function forearmSegment(state: ClimberState, hand: 'LH' | 'RH', a: Vec2, b: Vec2): boolean {
  const H = state.limbs[hand];
  if (!H.holdId || H.dragging) return false;
  let ex = H.anchor.x - H.pos.x;
  let ey = H.anchor.y - H.pos.y;
  const el = Math.hypot(ex, ey) || 1;
  ex /= el;
  ey /= el;
  const len = Math.min(BODY.forearm + BODY.handLen, el);
  a.x = H.pos.x;
  a.y = H.pos.y;
  b.x = H.pos.x + ex * len;
  b.y = H.pos.y + ey * len;
  return true;
}

/** Distance from p to the segment a–b. */
export function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/**
 * Would releasing foot `foot` at p hook it into a figure 4 right now (the same test as endDrag)? `cand` is
 * the hold the release would otherwise take (the controls' candidate). Returns the hooked hand, or null.
 */
export function figure4At(sim: ClimberSimAPI, state: ClimberState, foot: 'LF' | 'RF', p: Vec2, cand: HoldDef | null): 'LH' | 'RH' | null {
  if (typeof sim.figure4Candidate !== 'function' || state.special) return null;
  const hand = sim.figure4Candidate(foot, p);
  if (!hand) return null;
  if (!cand) return hand;
  // on the hand's own hold only below the grip (higher up it is a foot on that hold)
  const H = state.limbs[hand];
  return cand.id === H.holdId && p.y < H.pos.y - 0.04 ? hand : null;
}

/** Is a figure 4 with foot `foot` possible at all right now (the arm holds a positive hold, the leg reaches)? */
export function figure4Possible(sim: ClimberSimAPI, state: ClimberState, foot: 'LF' | 'RF'): boolean {
  if (typeof sim.figure4Candidate !== 'function' || state.special) return false;
  const hand = fig4HandFor(foot);
  const H = state.limbs[hand];
  if (!H.holdId || H.dragging || H.busy) return false;
  // a probe right on the forearm: only the sim's own "can this arm take the leg" decides
  return sim.figure4Candidate(foot, H.pos) === hand;
}

/**
 * Would letting go of hand `hand` over nothing enter a bat hang (the last hand off, both feet hooked /
 * cammed on a steep panel: sim.canBatHang)? `nothing`: the release would take no hold, clip, chalk dip,
 * shake-out or throw (the caller knows).
 */
export function batHangAt(sim: ClimberSimAPI, state: ClimberState, hand: 'LH' | 'RH', nothing: boolean): boolean {
  if (!nothing || typeof sim.canBatHang !== 'function' || state.special) return false;
  const o = state.limbs[hand === 'LH' ? 'RH' : 'LH'];
  if (o.holdId || o.busy) return false;
  return sim.canBatHang();
}

/** Per-boulder inputs of the cam preview (the sim's foot holds and wall profile). */
interface CamCtx {
  boulder: BoulderDef;
  footHolds: HoldDef[];
  prof: WallProfile | null;
}

let camCtx: CamCtx | null = null;
const camTaken: (HoldDef | null)[] = [null, null, null, null, null, null];
const camOut: CamPartner = { hold: null, x: 0, y: 0 };
const contact: Vec2 = { x: 0, y: 0 };

function ctxFor(b: BoulderDef): CamCtx {
  if (camCtx && camCtx.boulder === b) return camCtx;
  camCtx = { boulder: b, footHolds: b.holds.filter(usableByFoot), prof: profileOf(b) };
  return camCtx;
}

/**
 * Heel-toe cam preview: would foot `foot` put on `h` now jam between it and an opposing surface a
 * foot-length away? Mirrors ClimberSim.camFor (the same holds.camPartner, foot holds, taken holds, hip
 * anchor, body axis and technique angle). Returns the opposing surface (hold + point; the result is
 * reused, copy what you keep) or null.
 */
export function camAt(sim: ClimberSimAPI, state: ClimberState, foot: 'LF' | 'RF', h: HoldDef): CamPartner | null {
  if (!usableByFoot(h)) return null;
  const b = sim.boulder;
  const c = ctxFor(b);
  const li = foot === 'LF' ? 2 : 3;
  const byId = (id: string | null | undefined): HoldDef | null => (id ? (b.holds.find((x) => x.id === id) ?? null) : null);
  let n = 0;
  for (let k = 0; k < 4; k++) {
    if (k === li) continue;
    const L = state.limbs[IDS[k]];
    camTaken[n++] = L.holdId && !L.dragging ? byId(L.holdId) : null;
    if (k >= 2) camTaken[n++] = L.footMode === 'cam' ? byId(L.camHoldId) : null;
  }
  while (n < camTaken.length) camTaken[n++] = null;
  contactPoint(h, li, false, contact);
  const hip = sim.limbAnchor(foot);
  const P = state.pelvis;
  const C = state.chest;
  let ux = C.x - P.x;
  let uy = C.y - P.y;
  const ul = Math.hypot(ux, uy);
  if (ul > 1e-9) {
    ux /= ul;
    uy /= ul;
  } else {
    ux = 0;
    uy = 1;
  }
  // ClimberSim.techAngle: the panel under the foot, or the body's (smoothed) panel when steeper
  const comY = P.y + BODY.comT * (C.y - P.y);
  const wall = c.prof ? Math.max(angleAt(c.prof, contact.y), smoothAngleAt(c.prof, comY)) : b.wallAngle;
  return camPartner(h, contact.x, contact.y, li, hip.x, hip.y, ux, uy, wall, c.footHolds, camTaken, camOut, c.prof, null);
}

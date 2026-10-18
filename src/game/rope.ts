// Lead-rope bookkeeping for the Lead Tower: clipped quickdraws, the rope polyline for rendering, and
// the anchor + rope length the sim needs to catch a fall.
//
// Typical session wiring:
//   const rope = new RopeSystem(boulder);
//   every climbing frame: const c = rope.catchParams(state.pelvis); sim.setRope(c.anchor, c.length);
//   on 'clip-done':       rope.clip(e.quickdrawId);
//   rendering:            renderer.setRope(rope.ropePath(state.pelvis), rope.clipped);
// The sim freezes the rope it was given while a fall is in progress.

import type { BoulderDef, QuickdrawDef, Vec2 } from '../core/types';
import type { RopeSystemAPI } from '../core/contracts';
import { GAME, SIM } from '../config/tuning';
import { clamp } from '../core/math';

export const ROPE = {
  /** Slack the belayer keeps out (m). */
  slack: 0.6,
  /** Static stretch per metre of rope out. */
  stretch: 0.035,
  /** Extra dynamic stretch during a hard catch, per metre of rope out. */
  dynamicStretch: 0.05,
  /** Height of the belay device above the floor (m). */
  deviceHeight: 1.0,
  /** Harness (pelvis) → lowest foot when hanging (m). */
  harnessToFeet: 0.95,
} as const;

export class RopeSystem implements RopeSystemAPI {
  readonly quickdraws: QuickdrawDef[];
  readonly clipped: string[] = [];
  private readonly belay: Vec2;
  private readonly index = new Map<string, number>();

  constructor(boulder: BoulderDef) {
    this.quickdraws = boulder.quickdraws ? boulder.quickdraws.slice() : [];
    this.quickdraws.forEach((q, i) => this.index.set(q.id, i));
    // Belayer stands about 1.2 m left of the wall centre, a little toward the route.
    const first = this.quickdraws[0];
    const bx = first ? clamp(first.x - 1.0, -1.6, -0.8) : -1.2;
    this.belay = { x: Math.round(bx * 100) / 100, y: 0 };
  }

  clip(id: string): void {
    if (!this.index.has(id) || this.clipped.includes(id)) return;
    this.clipped.push(id);
    // keep wall order (bottom → top) so the rope path is a clean zig-zag
    this.clipped.sort((a, b) => this.index.get(a)! - this.index.get(b)!);
  }

  isClipped(id: string): boolean {
    return this.clipped.includes(id);
  }

  /** Highest clipped quickdraw, or null. */
  lastClip(): QuickdrawDef | null {
    if (!this.clipped.length) return null;
    return this.quickdraws[this.index.get(this.clipped[this.clipped.length - 1])!];
  }

  /** Lowest unclipped quickdraw above the last clip (the one to clip next), or null when done. */
  nextClip(): QuickdrawDef | null {
    const last = this.lastClip();
    const from = last ? this.index.get(last.id)! + 1 : 0;
    for (let i = from; i < this.quickdraws.length; i++) if (!this.clipped.includes(this.quickdraws[i].id)) return this.quickdraws[i];
    return null;
  }

  /** The anchor (top quickdraw) — clipping it tops the route. */
  anchor(): QuickdrawDef | null {
    return this.quickdraws.length ? this.quickdraws[this.quickdraws.length - 1] : null;
  }

  belayer(): Vec2 {
    return { x: this.belay.x, y: this.belay.y };
  }

  /** Belay device → clipped carabiners (in order) → harness. */
  ropePath(harness: Vec2): Vec2[] {
    const out: Vec2[] = [{ x: this.belay.x, y: ROPE.deviceHeight }];
    for (const id of this.clipped) {
      const q = this.quickdraws[this.index.get(id)!];
      out.push({ x: q.x, y: q.y - SIM.quickdrawDrop });
    }
    out.push({ x: harness.x, y: harness.y });
    return out;
  }

  /** Rope paid out from the belay device to the harness along the current path (+ slack). */
  ropeOut(harness: Vec2): number {
    const p = this.ropePath(harness);
    let len = 0;
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    return len + ROPE.slack;
  }

  catchParams(harness: Vec2): { anchor: Vec2; length: number } {
    const last = this.lastClip();
    const anchor: Vec2 = last ? { x: last.x, y: last.y - SIM.quickdrawDrop } : { x: this.belay.x, y: ROPE.deviceHeight };
    const free = Math.hypot(harness.x - anchor.x, harness.y - anchor.y);
    const out = this.ropeOut(harness);
    return { anchor, length: free + ROPE.slack + ROPE.stretch * out };
  }

  fallOutcome(harness: Vec2): { groundFall: boolean; fallDistance: number; catchY: number } {
    const floorHarness = GAME.padHeight + ROPE.harnessToFeet;
    const last = this.lastClip();
    if (!last) {
      return { groundFall: true, fallDistance: Math.max(0, harness.y - floorHarness), catchY: floorHarness };
    }
    const { anchor, length } = this.catchParams(harness);
    const catchY = anchor.y - length - ROPE.dynamicStretch * this.ropeOut(harness);
    const groundFall = catchY - ROPE.harnessToFeet < SIM.deckHeight;
    const lowest = groundFall ? floorHarness : catchY;
    return { groundFall, fallDistance: Math.max(0, harness.y - lowest), catchY: lowest };
  }

  reset(): void {
    this.clipped.length = 0;
  }
}

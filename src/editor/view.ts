// Editor camera framing: the renderer's 'editor' camera looks straight at the wall, centred on
// `center` and showing `meters` of wall height over the full canvas height. This class owns that
// state, fits the wall into the free area between the top bar and the tray, and implements
// zoom-about-a-point and panning in wall meters with sensible limits.
//
// Folded walls: center / meters are wall-SURFACE coordinates, but on a multi-angle wall the screen
// is no longer a linear image of the surface (panels at other angles are foreshortened, the camera
// squares up to the panel under the centre). Points are therefore picked through the renderer's
// ray cast (setPicker → RendererAPI.screenToWall, which crosses every panel); the linear model is
// only the fallback off the wall. A zoom keeps the TRUE wall point under the fingers: the gap
// between the picked point and the linear model at the gesture's start is carried along and
// shrinks with the zoom, so nothing jumps when the pinch begins and the point converges under the
// fingers as you zoom in.

import type { Vec2 } from '../core/types';
import { clamp } from '../core/math';

export interface ViewRect {
  /** Canvas size (CSS px). */
  w: number;
  h: number;
  /** Free area (canvas CSS px) not covered by the top bar / tray. */
  top: number;
  bottom: number;
}

export interface WallSize {
  width: number;
  height: number;
}

const MIN_METERS = 1.3;

/** Picks the wall point under a canvas pixel (the renderer's ray cast), or null off the wall. */
export type WallPicker = (sx: number, sy: number) => Vec2 | null;

/** A zoom gesture's anchor: the wall point under the fingers when it began. */
export interface ZoomAnchor {
  /** The real wall point under the fingers (picked; the linear model off the wall). */
  wall: Vec2;
  /** Picked − linear model at the start (0 on a flat wall seen straight on), at scale k0. */
  bias: Vec2;
  /** Meters per pixel when the gesture began. */
  k0: number;
}

export class EditorView {
  center: Vec2 = { x: 0, y: 2.25 };
  meters = 10;
  private fitCenter: Vec2 = { x: 0, y: 2.25 };
  private fitMeters = 10;
  private rect: ViewRect = { w: 390, h: 844, top: 0, bottom: 844 };
  private wall: WallSize = { width: 4.6, height: 4.5 };
  private pick: WallPicker | null = null;

  /** Use the renderer's ray cast for screen → wall (handles folded, multi-angle walls). */
  setPicker(pick: WallPicker | null): void {
    this.pick = pick;
  }

  /** Meters of wall per CSS pixel at the wall plane. */
  get k(): number {
    return this.meters / Math.max(1, this.rect.h);
  }

  get isFit(): boolean {
    return Math.abs(this.meters - this.fitMeters) < 0.02 && Math.abs(this.center.x - this.fitCenter.x) < 0.02 && Math.abs(this.center.y - this.fitCenter.y) < 0.02;
  }

  get zoom(): number {
    return this.fitMeters / this.meters;
  }

  /** Recompute the whole-wall framing; `reset` also jumps to it. */
  layout(rect: ViewRect, wall: WallSize, reset: boolean): void {
    const prevFit = this.isFit;
    this.rect = { ...rect };
    this.wall = { ...wall };
    const freeH = Math.max(120, rect.bottom - rect.top);
    // whole climbable panel + a strip of pads below and trim above
    const spanW = wall.width + 0.34;
    const y0 = 0.12;
    const y1 = wall.height + 0.14;
    const spanH = y1 - y0;
    const k = Math.max(spanW / Math.max(1, rect.w), spanH / freeH);
    this.fitMeters = k * rect.h;
    const midFree = (rect.top + rect.bottom) / 2;
    // wall point at the canvas centre such that the wall's middle lands in the middle of the free area
    this.fitCenter = { x: 0, y: (y0 + y1) / 2 - (rect.h / 2 - midFree) * k };
    if (reset || prevFit) this.reset();
    else this.clampState();
  }

  reset(): void {
    this.center = { ...this.fitCenter };
    this.meters = this.fitMeters;
  }

  /** Wall point under a canvas pixel: the renderer's pick (any wall profile), else the straight-on model. */
  screenToWall(sx: number, sy: number): Vec2 {
    const p = this.pick ? this.pick(sx, sy) : null;
    return p ? { x: p.x, y: p.y } : this.linearToWall(sx, sy);
  }

  /** The straight-on linear model of the editor camera (exact for a flat wall). */
  linearToWall(sx: number, sy: number): Vec2 {
    const k = this.k;
    return { x: this.center.x + (sx - this.rect.w / 2) * k, y: this.center.y - (sy - this.rect.h / 2) * k };
  }

  /** Anchor a zoom at canvas pixel (sx, sy): the real wall point there, and how far the linear model is off. */
  zoomAnchor(sx: number, sy: number): ZoomAnchor {
    const wall = this.screenToWall(sx, sy);
    const lin = this.linearToWall(sx, sy);
    return { wall, bias: { x: wall.x - lin.x, y: wall.y - lin.y }, k0: this.k };
  }

  /**
   * Zoom to `meters` keeping the anchor's wall point under `now` (canvas px). The start-of-gesture
   * gap between the picked point and the linear model scales with the zoom, so the first frame
   * doesn't jump and the real point settles under the fingers as the view closes in.
   */
  zoomAbout(anchor: ZoomAnchor | Vec2, now: { x: number; y: number }, meters: number): void {
    const a: ZoomAnchor = 'wall' in anchor ? anchor : { wall: anchor, bias: { x: 0, y: 0 }, k0: this.k };
    this.meters = clamp(meters, MIN_METERS, this.fitMeters * 1.3);
    const k = this.k;
    const f = a.k0 > 0 ? k / a.k0 : 1;
    this.center = {
      x: a.wall.x - a.bias.x * f - (now.x - this.rect.w / 2) * k,
      y: a.wall.y - a.bias.y * f + (now.y - this.rect.h / 2) * k,
    };
    this.clampState();
  }

  panPx(dx: number, dy: number): void {
    const k = this.k;
    this.center = { x: this.center.x - dx * k, y: this.center.y + dy * k };
    this.clampState();
  }

  private clampState(): void {
    this.meters = clamp(this.meters, MIN_METERS, this.fitMeters * 1.3);
    // the middle of the free area always stays over the wall
    const off = ((this.rect.top + this.rect.bottom) / 2 - this.rect.h / 2) * this.k;
    const mid = clamp(this.center.y - off, 0.2, this.wall.height);
    this.center = { x: clamp(this.center.x, -this.wall.width / 2, this.wall.width / 2), y: mid + off };
  }
}

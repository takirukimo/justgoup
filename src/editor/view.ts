// Editor camera framing: the renderer's 'editor' camera looks straight at the wall, centred on
// `center` and showing `meters` of wall height over the full canvas height. This class owns that
// state, fits the wall into the free area between the top bar and the tray, and implements
// zoom-about-a-point and panning in wall meters with sensible limits.

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

export class EditorView {
  center: Vec2 = { x: 0, y: 2.25 };
  meters = 10;
  private fitCenter: Vec2 = { x: 0, y: 2.25 };
  private fitMeters = 10;
  private rect: ViewRect = { w: 390, h: 844, top: 0, bottom: 844 };
  private wall: WallSize = { width: 4.6, height: 4.5 };

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

  /** Approximate wall point under a canvas pixel (straight-on camera). */
  screenToWall(sx: number, sy: number): Vec2 {
    const k = this.k;
    return { x: this.center.x + (sx - this.rect.w / 2) * k, y: this.center.y - (sy - this.rect.h / 2) * k };
  }

  /** Keep the wall point under `anchor` (canvas px, at the start of the gesture) under `now` after zooming to `meters`. */
  zoomAbout(anchorWall: Vec2, now: { x: number; y: number }, meters: number): void {
    this.meters = clamp(meters, MIN_METERS, this.fitMeters * 1.3);
    const k = this.k;
    this.center = { x: anchorWall.x - (now.x - this.rect.w / 2) * k, y: anchorWall.y + (now.y - this.rect.h / 2) * k };
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

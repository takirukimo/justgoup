// Release velocity of a drag: a small ring of timestamped wall-local samples and a least-squares
// slope over the last few tens of milliseconds, so a flick that ends the drag reads as fast while a
// finger that stopped before lifting reads as still. Allocation-free.

import type { Vec2 } from '../core/types';

export interface VelocityOptions {
  /** Samples older than this (ms) before the release are ignored. */
  window?: number;
  /** A finger whose last motion is older than this (ms) at release has stopped: velocity 0. */
  stale?: number;
}

export class VelocityTracker {
  static readonly N = 16;
  private readonly t = new Float64Array(VelocityTracker.N);
  private readonly x = new Float64Array(VelocityTracker.N);
  private readonly y = new Float64Array(VelocityTracker.N);
  private head = 0;
  private count = 0;
  readonly window: number;
  readonly stale: number;

  constructor(opts: VelocityOptions = {}) {
    this.window = opts.window ?? 90;
    this.stale = opts.stale ?? 60;
  }

  /** Start a new gesture at (x, y). */
  reset(t: number, x: number, y: number): void {
    this.head = 0;
    this.count = 0;
    this.add(t, x, y);
  }

  add(t: number, x: number, y: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // out-of-order timestamps (mixed event sources): keep the newest only
    if (this.count > 0 && t < this.t[(this.head + VelocityTracker.N - 1) % VelocityTracker.N]) return;
    this.t[this.head] = t;
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.head = (this.head + 1) % VelocityTracker.N;
    if (this.count < VelocityTracker.N) this.count++;
  }

  /** Units per second at time `now` (ms), into `out`. Zero when the finger stopped or too few samples. */
  velocity(now: number, out: Vec2): Vec2 {
    out.x = 0;
    out.y = 0;
    const N = VelocityTracker.N;
    if (this.count < 2) return out;
    const last = (this.head + N - 1) % N;
    if (now - this.t[last] > this.stale) return out;
    const from = Math.max(now, this.t[last]) - this.window;
    // samples inside the window, newest first
    let n = 0;
    let st = 0;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < this.count; k++) {
      const i = (last - k + N) % N;
      if (this.t[i] < from) break;
      n++;
      st += this.t[i];
      sx += this.x[i];
      sy += this.y[i];
    }
    if (n < 2) {
      // one sample in the window: difference with the sample just before it
      if (this.count < 2) return out;
      const prev = (last + N - 1) % N;
      const dt = this.t[last] - this.t[prev];
      if (dt <= 0 || dt > this.window * 2) return out;
      out.x = ((this.x[last] - this.x[prev]) / dt) * 1000;
      out.y = ((this.y[last] - this.y[prev]) / dt) * 1000;
      return out;
    }
    const mt = st / n;
    const mx = sx / n;
    const my = sy / n;
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (let k = 0; k < n; k++) {
      const i = (last - k + N) % N;
      const dt = this.t[i] - mt;
      stt += dt * dt;
      stx += dt * (this.x[i] - mx);
      sty += dt * (this.y[i] - my);
    }
    if (stt < 1e-9) return out;
    out.x = (stx / stt) * 1000;
    out.y = (sty / stt) * 1000;
    return out;
  }
}

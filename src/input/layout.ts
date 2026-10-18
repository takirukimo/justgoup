// Screen-space layout for the limb handles: a few relaxation passes that push overlapping
// handles apart (respecting how movable each one is), push them off fixed obstacles (the reticle
// and the hold being aimed at) and keep them inside the safe viewport. Allocation-free.

export interface SafeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class HandleLayout {
  static readonly MAX = 8;
  readonly x = new Float64Array(HandleLayout.MAX);
  readonly y = new Float64Array(HandleLayout.MAX);
  /** Collision radius (px). */
  readonly r = new Float64Array(HandleLayout.MAX);
  /** 0 = pinned (e.g. the handle under the finger), 1 = fully movable. */
  readonly mob = new Float64Array(HandleLayout.MAX);
  /** Inactive bodies are ignored (hidden handles). */
  readonly active = new Uint8Array(HandleLayout.MAX);
  /** Bodies that obstacles push (others only take part in pairwise spacing). */
  readonly avoid = new Uint8Array(HandleLayout.MAX);
  n = 0;

  static readonly MAX_OBS = 12;
  readonly ox = new Float64Array(HandleLayout.MAX_OBS);
  readonly oy = new Float64Array(HandleLayout.MAX_OBS);
  readonly or = new Float64Array(HandleLayout.MAX_OBS);
  on = 0;

  setBody(i: number, x: number, y: number, r: number, mob: number, avoid = mob > 0, active = true): void {
    this.x[i] = x;
    this.y[i] = y;
    this.r[i] = r;
    this.mob[i] = mob;
    this.avoid[i] = avoid ? 1 : 0;
    this.active[i] = active ? 1 : 0;
    if (i >= this.n) this.n = i + 1;
  }

  clearObstacles(): void {
    this.on = 0;
  }

  addObstacle(x: number, y: number, r: number): void {
    if (this.on >= HandleLayout.MAX_OBS) return;
    this.ox[this.on] = x;
    this.oy[this.on] = y;
    this.or[this.on] = r;
    this.on++;
  }

  /**
   * Relax: bodies keep at least `gap` px between their circles, stay out of obstacles and inside
   * `rect` (each body's circle fully inside).
   */
  solve(rect: SafeRect, gap: number, iterations = 6): void {
    const { x, y, r, mob, active, n } = this;
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue;
        for (let j = i + 1; j < n; j++) {
          if (!active[j]) continue;
          const mi = mob[i];
          const mj = mob[j];
          const ms = mi + mj;
          if (ms <= 0) continue;
          let dx = x[j] - x[i];
          let dy = y[j] - y[i];
          let d = Math.hypot(dx, dy);
          const min = r[i] + r[j] + gap;
          if (d >= min) continue;
          if (d < 1e-3) {
            // coincident: separate deterministically (lower index goes left / up)
            dx = i < j ? 1 : -1;
            dy = 0.35;
            d = Math.hypot(dx, dy);
          }
          const push = (min - d) / d;
          const wi = mi / ms;
          const wj = mj / ms;
          x[i] -= dx * push * wi;
          y[i] -= dy * push * wi;
          x[j] += dx * push * wj;
          y[j] += dy * push * wj;
        }
        if (mob[i] > 0 && this.avoid[i]) {
          for (let k = 0; k < this.on; k++) {
            let dx = x[i] - this.ox[k];
            let dy = y[i] - this.oy[k];
            let d = Math.hypot(dx, dy);
            const min = r[i] + this.or[k];
            if (d >= min) continue;
            if (d < 1e-3) {
              dx = 0;
              dy = 1;
              d = 1;
            }
            const push = (min - d) / d;
            x[i] += dx * push;
            y[i] += dy * push;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (!active[i] || mob[i] <= 0) continue;
        const ri = r[i];
        const l = rect.left + ri;
        const rr = rect.right - ri;
        const t = rect.top + ri;
        const b = rect.bottom - ri;
        x[i] = l <= rr ? (x[i] < l ? l : x[i] > rr ? rr : x[i]) : (rect.left + rect.right) / 2;
        y[i] = t <= b ? (y[i] < t ? t : y[i] > b ? b : y[i]) : (rect.top + rect.bottom) / 2;
      }
    }
  }
}

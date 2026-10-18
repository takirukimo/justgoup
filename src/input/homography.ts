// Plane → screen projective mapping for the limb-control overlay.
//
// A pinhole camera maps the (flat) wall plane to the screen with an exact 2D homography, so four
// renderer.wallToScreen() correspondences per frame are enough to project any number of
// wall-local points (reach arcs, reticles, quickdraws) with zero allocations, and to invert the
// mapping for finger → wall conversions anywhere on the plane.

import type { Vec2 } from '../core/types';

export class Homography {
  /** Row-major 3×3 matrix (m[8] = 1). Wall-local (x, y) → screen CSS px. */
  readonly m = new Float64Array(9);
  /** Inverse (screen → wall). */
  readonly inv = new Float64Array(9);
  valid = false;
  private readonly a = new Float64Array(8 * 9);

  /**
   * Solve from four correspondences. `src` / `dst` are flat [x0, y0, x1, y1, x2, y2, x3, y3].
   * Returns false (and leaves `valid` false) for degenerate input.
   */
  solve(src: ArrayLike<number>, dst: ArrayLike<number>): boolean {
    const a = this.a;
    for (let i = 0; i < 4; i++) {
      const x = src[i * 2];
      const y = src[i * 2 + 1];
      const u = dst[i * 2];
      const v = dst[i * 2 + 1];
      let r = i * 2 * 9;
      a[r] = x;
      a[r + 1] = y;
      a[r + 2] = 1;
      a[r + 3] = 0;
      a[r + 4] = 0;
      a[r + 5] = 0;
      a[r + 6] = -u * x;
      a[r + 7] = -u * y;
      a[r + 8] = u;
      r += 9;
      a[r] = 0;
      a[r + 1] = 0;
      a[r + 2] = 0;
      a[r + 3] = x;
      a[r + 4] = y;
      a[r + 5] = 1;
      a[r + 6] = -v * x;
      a[r + 7] = -v * y;
      a[r + 8] = v;
    }
    // Gaussian elimination with partial pivoting on the 8×9 augmented system.
    for (let c = 0; c < 8; c++) {
      let piv = c;
      let best = Math.abs(a[c * 9 + c]);
      for (let r = c + 1; r < 8; r++) {
        const val = Math.abs(a[r * 9 + c]);
        if (val > best) {
          best = val;
          piv = r;
        }
      }
      if (best < 1e-12) {
        this.valid = false;
        return false;
      }
      if (piv !== c) {
        for (let k = c; k < 9; k++) {
          const t = a[c * 9 + k];
          a[c * 9 + k] = a[piv * 9 + k];
          a[piv * 9 + k] = t;
        }
      }
      const d = a[c * 9 + c];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = a[r * 9 + c] / d;
        if (f === 0) continue;
        for (let k = c; k < 9; k++) a[r * 9 + k] -= f * a[c * 9 + k];
      }
    }
    const m = this.m;
    for (let i = 0; i < 8; i++) m[i] = a[i * 9 + 8] / a[i * 9 + i];
    m[8] = 1;
    for (let i = 0; i < 9; i++) {
      if (!Number.isFinite(m[i])) {
        this.valid = false;
        return false;
      }
    }
    this.valid = invert3(m, this.inv);
    return this.valid;
  }

  /** Wall → screen. Returns false when the point is behind the camera (or no valid solve). */
  map(x: number, y: number, out: Vec2): boolean {
    const m = this.m;
    const w = m[6] * x + m[7] * y + m[8];
    if (!this.valid || w <= 1e-9) return false;
    out.x = (m[0] * x + m[1] * y + m[2]) / w;
    out.y = (m[3] * x + m[4] * y + m[5]) / w;
    return true;
  }

  /** Screen → wall (on the infinite wall plane). */
  unmap(u: number, v: number, out: Vec2): boolean {
    const m = this.inv;
    const w = m[6] * u + m[7] * v + m[8];
    if (!this.valid || Math.abs(w) < 1e-12) return false;
    out.x = (m[0] * u + m[1] * v + m[2]) / w;
    out.y = (m[3] * u + m[4] * v + m[5]) / w;
    return Number.isFinite(out.x) && Number.isFinite(out.y);
  }

  /** Approximate screen pixels per wall metre around (x, y). */
  scaleAt(x: number, y: number, tmpA: Vec2, tmpB: Vec2): number {
    if (!this.map(x, y, tmpA)) return 0;
    let s = 0;
    if (this.map(x + 0.1, y, tmpB)) s += Math.hypot(tmpB.x - tmpA.x, tmpB.y - tmpA.y);
    if (this.map(x, y + 0.1, tmpB)) s += Math.hypot(tmpB.x - tmpA.x, tmpB.y - tmpA.y);
    return s * 5; // (sum of two 0.1 m spans) / 2 / 0.1
  }
}

function invert3(m: Float64Array, out: Float64Array): boolean {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return false;
  const k = 1 / det;
  out[0] = A * k;
  out[1] = -(b * i - c * h) * k;
  out[2] = (b * f - c * e) * k;
  out[3] = B * k;
  out[4] = (a * i - c * g) * k;
  out[5] = -(a * f - c * d) * k;
  out[6] = C * k;
  out[7] = -(a * h - b * g) * k;
  out[8] = (a * e - b * d) * k;
  return true;
}

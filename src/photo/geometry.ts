// Perspective rectification (research §5.1 step 2): a DLT homography from the four wall corners the user
// drags, the wall's true aspect ratio recovered from the corners (Zhang & He's rectangle method with a
// phone-camera focal length), and a bilinear warp of the photo into a square-on wall image.

import type { Pt, Quad, RGBAImage } from './types';

export type Mat3 = Float64Array; // row-major 3×3

/** Homography mapping src[i] → dst[i] (4 point pairs), or null when degenerate. */
export function solveHomography(src: readonly Pt[], dst: readonly Pt[]): Mat3 | null {
  const a = new Float64Array(8 * 9);
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    let r = i * 18;
    a.set([x, y, 1, 0, 0, 0, -u * x, -u * y, u], r);
    r += 9;
    a.set([0, 0, 0, x, y, 1, -v * x, -v * y, v], r);
  }
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
    if (best < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < 9; k++) {
        const t = a[c * 9 + k];
        a[c * 9 + k] = a[piv * 9 + k];
        a[piv * 9 + k] = t;
      }
    }
    const d = a[c * 9 + c];
    for (let k = c; k < 9; k++) a[c * 9 + k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const fct = a[r * 9 + c];
      if (fct === 0) continue;
      for (let k = c; k < 9; k++) a[r * 9 + k] -= fct * a[c * 9 + k];
    }
  }
  const m = new Float64Array(9);
  for (let i = 0; i < 8; i++) m[i] = a[i * 9 + 8];
  m[8] = 1;
  for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i])) return null;
  return m;
}

export function applyH(m: Mat3, x: number, y: number, out: Pt = { x: 0, y: 0 }): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  out.x = (m[0] * x + m[1] * y + m[2]) / w;
  out.y = (m[3] * x + m[4] * y + m[5]) / w;
  return out;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const r = new Float64Array([A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]);
  for (let k = 0; k < 9; k++) r[k] /= det;
  return r;
}

/** Is the quad a proper convex quadrilateral (corners in TL, TR, BR, BL order, no self crossing)? */
export function quadValid(q: Quad, minSide = 8): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i];
    const p1 = q[(i + 1) % 4];
    const p2 = q[(i + 2) % 4];
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < minSide) return false;
    const cr = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (Math.abs(cr) < 1e-6) return false;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign > 0; // clockwise on screen (y down): TL → TR → BR → BL
}

/** Quad area (shoelace, px²). */
export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * True width / height of the rectangle the quad images, assuming a pinhole camera with its principal
 * point at the image centre and a focal length of `focal` px (phone main cameras: ≈ 0.75 × the long
 * edge). Falls back to the mean side lengths when the perspective is too weak to tell.
 */
export function quadAspect(q: Quad, imgW: number, imgH: number, focal = 0.78 * Math.max(imgW, imgH)): number {
  const simple = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) /
    Math.max(1e-6, Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y));
  // Zhang & He (2004): corners m1 m2 m3 m4 = TL, TR, BL, BR, centred on the principal point
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m1 = [q[0].x - u0, q[0].y - v0, 1];
  const m2 = [q[1].x - u0, q[1].y - v0, 1];
  const m3 = [q[3].x - u0, q[3].y - v0, 1];
  const m4 = [q[2].x - u0, q[2].y - v0, 1];
  const cross = (p: number[], r: number[]): number[] => [p[1] * r[2] - p[2] * r[1], p[2] * r[0] - p[0] * r[2], p[0] * r[1] - p[1] * r[0]];
  const dot = (p: number[], r: number[]): number => p[0] * r[0] + p[1] * r[1] + p[2] * r[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const f2 = focal * focal;
  const num = n2[0] * n2[0] + n2[1] * n2[1] + f2 * n2[2] * n2[2];
  const den = n3[0] * n3[0] + n3[1] * n3[1] + f2 * n3[2] * n3[2];
  const r = Math.sqrt(num / den);
  if (!Number.isFinite(r) || r < 0.2 || r > 5 || Math.abs(r / simple - 1) > 0.6) return simple;
  return r;
}

/** Rectified working size for a wall of aspect w/h: the long edge is `long` px. */
export function rectSize(aspect: number, long = 960): { w: number; h: number } {
  const a = Math.max(0.3, Math.min(2.2, aspect));
  return a >= 1 ? { w: long, h: Math.max(32, Math.round(long / a)) } : { w: Math.max(32, Math.round(long * a)), h: long };
}

/** Homography from the rectified image (w × h) to the photo quad. */
export function rectToPhoto(q: Quad, w: number, h: number): Mat3 | null {
  return solveHomography(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    q,
  );
}

/** Warp the photo's quad into a w × h square-on image (bilinear; pixels outside the photo are black). */
export function warpQuad(src: RGBAImage, q: Quad, w: number, h: number): RGBAImage {
  const m = rectToPhoto(q, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  if (!m) return { width: w, height: h, data: out };
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < h; y++) {
    const yy = y + 0.5;
    // incremental projective mapping along the row
    let X = m[0] * 0.5 + m[1] * yy + m[2];
    let Y = m[3] * 0.5 + m[4] * yy + m[5];
    let W = m[6] * 0.5 + m[7] * yy + m[8];
    for (let x = 0; x < w; x++) {
      const px = X / W - 0.5;
      const py = Y / W - 0.5;
      X += m[0];
      Y += m[3];
      W += m[6];
      const o = (y * w + x) * 4;
      if (px < -0.5 || py < -0.5 || px > sw - 0.5 || py > sh - 0.5) {
        out[o + 3] = 255;
        continue;
      }
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(px)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(py)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, px - x0));
      const fy = Math.max(0, Math.min(1, py - y0));
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Default corner guess: the photo inset a little (the user drags from there). */
export function defaultQuad(w: number, h: number): Quad {
  const ix = w * 0.1;
  const iy = h * 0.08;
  return [
    { x: ix, y: iy },
    { x: w - ix, y: iy },
    { x: w - ix, y: h - iy },
    { x: ix, y: h - iy },
  ];
}

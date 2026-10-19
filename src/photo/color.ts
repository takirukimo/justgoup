// Colour science for the hold detector (research §5.1 step 3): sRGB → CIELAB (D65), gray-world white
// balance, robust patch sampling and a ΔE weighted toward (a, b) so shading and shadows on a hold matter
// less than its hue. Pure TS on plain buffers.

import type { Lab, RGBAImage } from './types';

/** sRGB byte → linear light (LUT). */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// D65 reference white
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

const f = (t: number): number => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

/** Linear RGB (0..1) → Lab. */
export function linearToLab(r: number, g: number, b: number, out: Lab = { L: 0, a: 0, b: 0 }): Lab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  out.L = 116 * fy - 16;
  out.a = 500 * (fx - fy);
  out.b = 200 * (fy - fz);
  return out;
}

/** sRGB bytes → Lab. */
export function rgbToLab(r: number, g: number, b: number, out?: Lab): Lab {
  return linearToLab(LIN[r & 255], LIN[g & 255], LIN[b & 255], out);
}

/** Lab → sRGB hex (for swatches and the route colour). */
export function labToHex(c: Lab): string {
  const fy = (c.L + 16) / 116;
  const fx = fy + c.a / 500;
  const fz = fy - c.b / 200;
  const inv = (t: number): number => (t * t * t > EPS ? t * t * t : (116 * t - 16) / KAPPA);
  const x = inv(fx) * XN;
  const y = (c.L > KAPPA * EPS ? fy * fy * fy : c.L / KAPPA) * YN;
  const z = inv(fz) * ZN;
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const enc = (v: number): number => {
    const c2 = Math.max(0, Math.min(1, v));
    const s = c2 <= 0.0031308 ? 12.92 * c2 : 1.055 * Math.pow(c2, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };
  return '#' + [enc(r), enc(g), enc(b)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function hexToLab(hex: string): Lab {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

export const chroma = (c: Lab): number => Math.hypot(c.a, c.b);

/** Below this chroma a sample is "achromatic" (white, grey, black holds): lightness decides. */
export const ACHROMATIC = 12;

/**
 * Colour distance of a pixel to a sample: ΔE weighted toward (a, b) for chromatic samples (shading and
 * shadow change L far more than hue), and toward L — with a penalty on any chroma — for achromatic ones.
 */
export function colorDistance(L: number, a: number, b: number, s: Lab): number {
  const dL = L - s.L;
  const da = a - s.a;
  const db = b - s.b;
  if (chroma(s) < ACHROMATIC) {
    // white / grey / black: lightness, and the pixel must stay colourless
    const c = Math.hypot(a, b);
    return Math.sqrt(0.6 * dL * dL + 1.6 * (da * da + db * db) + 0.8 * c * c);
  }
  // a shaded side of a coloured hold keeps its hue but loses chroma with L: compare against the sample
  // scaled to the pixel's lightness as well, and take the better of the two
  const k = Math.max(0.45, Math.min(1.25, (L + 4) / (s.L + 4)));
  const da2 = a - s.a * k;
  const db2 = b - s.b * k;
  const plain = 0.12 * dL * dL + da * da + db * db;
  const shaded = 0.06 * dL * dL + da2 * da2 + db2 * db2 + 30;
  return Math.sqrt(Math.min(plain, shaded));
}

/** A Lab image: L, a, b planes. */
export interface LabImage {
  width: number;
  height: number;
  L: Float32Array;
  a: Float32Array;
  b: Float32Array;
}

/**
 * Gray-world white balance gains (linear RGB), estimated on the low-chroma pixels (the wall itself),
 * so an LED cast on the wall is neutralised without the holds' colours skewing it.
 */
export function grayWorldGains(img: RGBAImage): [number, number, number] {
  const d = img.data;
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 60000));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let cnt = 0;
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let all = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (d[o + 3] < 8) continue;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const lr = LIN[r];
    const lg = LIN[g];
    const lb = LIN[b];
    ar += lr;
    ag += lg;
    ab += lb;
    all++;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx < 12 || mx > 250) continue;
    if (mx - mn > 0.32 * mx) continue; // a coloured pixel (a hold): not the wall
    sr += lr;
    sg += lg;
    sb += lb;
    cnt++;
  }
  if (cnt < all * 0.08) {
    sr = ar;
    sg = ag;
    sb = ab;
    cnt = all;
  }
  if (cnt === 0 || sr <= 0 || sg <= 0 || sb <= 0) return [1, 1, 1];
  const gray = (sr + sg + sb) / 3;
  const cl = (v: number): number => Math.max(0.6, Math.min(1.6, v));
  return [cl(gray / sr), cl(gray / sg), cl(gray / sb)];
}

/** Whole image → Lab planes, white balanced with `gains`. */
export function toLab(img: RGBAImage, gains: [number, number, number] = [1, 1, 1]): LabImage {
  const n = img.width * img.height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const d = img.data;
  const tmp: Lab = { L: 0, a: 0, b: 0 };
  const [gr, gg, gb] = gains;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    linearToLab(Math.min(1, LIN[d[o]] * gr), Math.min(1, LIN[d[o + 1]] * gg), Math.min(1, LIN[d[o + 2]] * gb), tmp);
    L[i] = tmp.L;
    A[i] = tmp.a;
    B[i] = tmp.b;
  }
  return { width: img.width, height: img.height, L, a: A, b: B };
}

const median = (v: number[]): number => {
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The colour of the hold under a tap: the median of a (2r+1)² Lab patch, after dropping glossy
 * highlights (bright, colourless) and wall pixels at the hold's edge (the least chromatic third of a
 * chromatic patch).
 */
export function samplePatch(lab: LabImage, x: number, y: number, r = 3): Lab | null {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const pts: { L: number; a: number; b: number; c: number }[] = [];
  for (let j = -r; j <= r; j++) {
    const yy = cy + j;
    if (yy < 0 || yy >= lab.height) continue;
    for (let i = -r; i <= r; i++) {
      const xx = cx + i;
      if (xx < 0 || xx >= lab.width) continue;
      const k = yy * lab.width + xx;
      pts.push({ L: lab.L[k], a: lab.a[k], b: lab.b[k], c: Math.hypot(lab.a[k], lab.b[k]) });
    }
  }
  if (!pts.length) return null;
  const cMed = median(pts.map((p) => p.c));
  let keep = pts;
  if (cMed >= ACHROMATIC) {
    // a coloured hold: drop gloss (bright + colourless) and the least chromatic pixels (wall at its edge)
    const sorted = [...pts].sort((p, q) => q.c - p.c);
    keep = sorted.slice(0, Math.max(4, Math.ceil(sorted.length * 0.66)));
  } else {
    const lMed = median(pts.map((p) => p.L));
    keep = pts.filter((p) => Math.abs(p.L - lMed) < 18);
    if (keep.length < 4) keep = pts;
  }
  return { L: median(keep.map((p) => p.L)), a: median(keep.map((p) => p.a)), b: median(keep.map((p) => p.b)) };
}

/** Plain-language colour name for a sample (UI swatches, the problem's name). */
export function colorName(c: Lab): string {
  const C = chroma(c);
  if (C < ACHROMATIC) return c.L > 70 ? 'White' : c.L < 30 ? 'Black' : 'Grey';
  const h = ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;
  // Lab hue angles (approximate)
  if (h < 20 || h >= 345) return c.L > 62 && C < 55 ? 'Pink' : 'Red';
  if (h < 45) return c.L > 62 && C < 45 ? 'Pink' : c.L > 55 ? 'Orange' : 'Red';
  if (h < 68) return c.L < 50 ? 'Brown' : 'Orange';
  if (h < 105) return c.L < 55 ? 'Olive' : 'Yellow';
  if (h < 172) return 'Green';
  if (h < 235) return 'Teal';
  if (h < 292) return 'Blue';
  if (h < 325) return 'Purple';
  return 'Pink';
}

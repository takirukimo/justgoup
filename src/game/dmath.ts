// Deterministic math for generation and statics.
//
// Math.sin / cos / atan2 / hypot are allowed to differ in the last bit between JavaScript engines,
// and the generator makes threshold decisions with them — a one-ulp difference could change a
// Daily Boulder between Safari and Chrome. These versions use only IEEE-754 basic arithmetic and
// Math.sqrt (both correctly rounded everywhere), so results are bit-identical on every device.
// Accuracy is ~1e-12, far beyond what the game needs.

const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const QUARTER_PI = 0.7853981633974483;

function sinPoly(x: number): number {
  // |x| ≤ π/4, Taylor to x^15
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))));
}

function cosPoly(x: number): number {
  // |x| ≤ π/4, Taylor to x^16
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 / 20922789888000)))))));
}

/** Reduce to r ∈ [−π/4, π/4] and quadrant q (x = q·π/2 + r). */
function reduce(x: number): { r: number; q: number } {
  const k = Math.round(x / TWO_PI);
  let r = x - k * TWO_PI;
  const q = Math.round(r / HALF_PI);
  r -= q * HALF_PI;
  return { r, q: ((q % 4) + 4) % 4 };
}

export function dsin(x: number): number {
  const { r, q } = reduce(x);
  switch (q) {
    case 0:
      return sinPoly(r);
    case 1:
      return cosPoly(r);
    case 2:
      return -sinPoly(r);
    default:
      return -cosPoly(r);
  }
}

export function dcos(x: number): number {
  const { r, q } = reduce(x);
  switch (q) {
    case 0:
      return cosPoly(r);
    case 1:
      return -sinPoly(r);
    case 2:
      return -cosPoly(r);
    default:
      return sinPoly(r);
  }
}

/** atan for |x| ≤ 1 via two half-angle reductions and a Taylor series. */
function atanUnit(x: number): number {
  // atan(x) = 2·atan(x / (1 + sqrt(1 + x²)))
  let y = x / (1 + Math.sqrt(1 + x * x));
  y = y / (1 + Math.sqrt(1 + y * y));
  const y2 = y * y;
  let s = 0;
  let term = y;
  for (let n = 0; n < 9; n++) {
    s += term / (2 * n + 1);
    term = -term * y2;
  }
  return 4 * s;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let a = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

export const dhypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);

export { PI as D_PI, QUARTER_PI as D_QUARTER_PI };

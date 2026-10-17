import type { Vec2 } from './types';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  lerp(b0, b1, clamp01(invLerp(a0, a1, v)));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing. `lambda` ≈ 1/time-constant. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
/** Smallest signed difference between two angles (radians), in [-PI, PI]. */
export const angleDiff = (a: number, b: number): number => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

// ── Vec2 helpers (pure, allocate new objects; fine at our scale) ──
export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vDot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const vCross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const vLen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const vNorm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
export const vLerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const vPerp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const vAngle = (a: Vec2): number => Math.atan2(a.y, a.x);
export const vFromAngle = (r: number, len = 1): Vec2 => ({ x: Math.cos(r) * len, y: Math.sin(r) * len });
export const vClampLen = (a: Vec2, max: number): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l > max && l > 1e-9 ? { x: (a.x / l) * max, y: (a.y / l) * max } : { x: a.x, y: a.y };
};
export const vCopy = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });

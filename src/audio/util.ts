// Shared DSP helpers for the procedural audio engine: math, randomness, pre-rendered noise,
// band-limited wavetables (PeriodicWave), shaper curves and the procedural hall impulse response.
// Everything that is expensive to build is cached once per BaseAudioContext.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const finite = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
export const randInt = (lo: number, hiInclusive: number): number => Math.floor(rand(lo, hiInclusive + 1));
export const chance = (p: number): boolean => Math.random() < p;
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
/** Weighted pick from [item, weight] pairs. */
export function weighted<T>(items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let r = Math.random() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** MIDI note → Hz. */
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
/** Decibels → linear gain. */
export const db = (d: number): number => Math.pow(10, d / 20);
/** Cents → frequency ratio. */
export const cents = (c: number): number => Math.pow(2, c / 1200);
/** Perceptual volume curve for 0..1 UI sliders. */
export const volumeCurve = (v: number): number => Math.pow(clamp(finite(v, 0), 0, 1), 1.6);

// ─────────────────────────────── per-context bank ───────────────────────────────

export type NoiseKind = 'white' | 'pink' | 'brown' | 'drift';
/** Nominal bandwidth (Hz) of the 'drift' noise at playbackRate 1. */
export const DRIFT_HZ = 12;

export type WaveId = 'warm' | 'glottal' | 'pressed' | 'pluck' | 'soft' | 'reed' | 'hollow' | 'organ';

interface Bank {
  noise: Partial<Record<NoiseKind, AudioBuffer>>;
  waves: Partial<Record<WaveId, PeriodicWave>>;
  curves: Map<string, Float32Array<ArrayBuffer>>;
  silent?: AudioBuffer;
  hall?: AudioBuffer;
}

const banks = new WeakMap<BaseAudioContext, Bank>();

function bank(ctx: BaseAudioContext): Bank {
  let b = banks.get(ctx);
  if (!b) {
    b = { noise: {}, waves: {}, curves: new Map() };
    banks.set(ctx, b);
  }
  return b;
}

/** Pre-render every shared buffer now (call once after creating a context to avoid first-play hitches). */
export function warmBank(ctx: BaseAudioContext): void {
  noiseBuffer(ctx, 'white');
  noiseBuffer(ctx, 'pink');
  noiseBuffer(ctx, 'brown');
  noiseBuffer(ctx, 'drift');
  silentBuffer(ctx);
  hallImpulse(ctx);
  for (const id of Object.keys(WAVE_DEFS) as WaveId[]) wave(ctx, id);
}

// ─────────────────────────────── noise ───────────────────────────────

const NOISE_SECONDS = 2.5;

/** Looping noise buffer (seamless loop), normalised to RMS 0.25 (drift: smooth ±1 random signal). */
export function noiseBuffer(ctx: BaseAudioContext, kind: NoiseKind): AudioBuffer {
  const b = bank(ctx);
  const cached = b.noise[kind];
  if (cached) return cached;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);

  if (kind === 'drift') {
    // Cosine-interpolated random control points: a smooth signal with ~DRIFT_HZ bandwidth.
    const step = Math.max(1, Math.floor(sr / (DRIFT_HZ * 2)));
    const points = Math.ceil(len / step);
    const cp = new Float32Array(points + 1);
    for (let i = 0; i < points; i++) cp[i] = Math.random() * 2 - 1;
    cp[points] = cp[0]; // seamless loop
    for (let i = 0; i < len; i++) {
      const k = Math.floor(i / step);
      const f = (i - k * step) / step;
      const m = (1 - Math.cos(f * Math.PI)) * 0.5;
      out[i] = cp[k] * (1 - m) + cp[Math.min(k + 1, points)] * m;
    }
  } else {
    // Generate extra samples and cross-fade the tail into the head for a click-free loop.
    const fade = Math.floor(sr * 0.05);
    const raw = new Float32Array(len + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') raw[i] = w;
      else if (kind === 'pink') {
        // Paul Kellet's refined pink filter.
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        raw[i] = last;
      }
    }
    for (let i = 0; i < len; i++) {
      if (i < fade) {
        const x = i / fade;
        out[i] = raw[i] * Math.sin(x * Math.PI * 0.5) + raw[len + i] * Math.cos(x * Math.PI * 0.5);
      } else out[i] = raw[i];
    }
    // Remove DC and normalise RMS.
    let mean = 0;
    for (let i = 0; i < len; i++) mean += out[i];
    mean /= len;
    let sq = 0;
    for (let i = 0; i < len; i++) {
      out[i] -= mean;
      sq += out[i] * out[i];
    }
    const k = 0.25 / Math.sqrt(sq / len || 1);
    for (let i = 0; i < len; i++) out[i] = clamp(out[i] * k, -1, 1);
  }
  b.noise[kind] = buf;
  return buf;
}

/** A one-sample silent buffer (watchers + iOS unlock). */
export function silentBuffer(ctx: BaseAudioContext): AudioBuffer {
  const b = bank(ctx);
  if (!b.silent) b.silent = ctx.createBuffer(1, 128, ctx.sampleRate);
  return b.silent;
}

// ─────────────────────────────── wavetables ───────────────────────────────

/** Harmonic amplitude for harmonic n (1-based) of each wavetable. */
const WAVE_DEFS: Record<WaveId, { n: number; amp: (n: number) => number }> = {
  // Mellow detuned-pad source: between a saw and a square, upper harmonics tamed.
  warm: { n: 24, amp: (n) => (1 / Math.pow(n, 1.45)) * (n % 2 === 0 ? 0.72 : 1) },
  // Radiated glottal source (≈ −6 dB/oct) for modal voice.
  glottal: { n: 48, amp: (n) => 1 / Math.pow(n, 1.15) },
  // Pressed/strained phonation: brighter, flatter spectrum.
  pressed: { n: 48, amp: (n) => 1 / Math.pow(n, 0.85) },
  // Plucked string-ish source with a gentle comb colour.
  pluck: { n: 32, amp: (n) => (1 / Math.pow(n, 1.1)) * (0.75 + 0.25 * Math.abs(Math.sin(n * 1.31))) },
  // Sine with a little 2nd/3rd harmonic — sub bass that still reads on phone speakers.
  soft: { n: 4, amp: (n) => [1, 0.38, 0.14, 0.05][n - 1] ?? 0 },
  // Odd-heavy reed for rubber squeaks.
  reed: { n: 24, amp: (n) => (n % 2 === 1 ? 1 / n : 0.45 / n) },
  // Hollow, glassy (odd partials, quickly falling).
  hollow: { n: 9, amp: (n) => (n % 2 === 1 ? 1 / (n * n) : 0) },
  // Soft drawbar-ish organ for drones.
  organ: { n: 8, amp: (n) => [1, 0.5, 0.25, 0.3, 0, 0.12, 0, 0.08][n - 1] ?? 0 },
};

export function wave(ctx: BaseAudioContext, id: WaveId): PeriodicWave {
  const b = bank(ctx);
  const cached = b.waves[id];
  if (cached) return cached;
  const def = WAVE_DEFS[id];
  const real = new Float32Array(def.n + 1);
  const imag = new Float32Array(def.n + 1);
  for (let n = 1; n <= def.n; n++) imag[n] = def.amp(n);
  const w = ctx.createPeriodicWave(real, imag);
  b.waves[id] = w;
  return w;
}

export function isWaveId(k: string): k is WaveId {
  return k in WAVE_DEFS;
}

// ─────────────────────────────── shaper curves ───────────────────────────────

/** tanh soft-clip curve normalised so that ±1 maps to ±1. */
export function softClip(ctx: BaseAudioContext, drive: number): Float32Array<ArrayBuffer> {
  const key = 'soft' + drive.toFixed(2);
  const b = bank(ctx);
  let c = b.curves.get(key);
  if (!c) {
    const n = 1024;
    c = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * drive) / norm;
    }
    b.curves.set(key, c);
  }
  return c;
}

// ─────────────────────────────── hall impulse response ───────────────────────────────

/**
 * Procedural stereo impulse response of a big bouldering hall: 14 ms pre-delay, sparse early
 * reflections off the walls and pads, then a dense tail (RT60 ≈ 1.8 s) whose high end decays
 * faster than the lows (absorptive crash pads, air absorption).
 */
export function hallImpulse(ctx: BaseAudioContext): AudioBuffer {
  const b = bank(ctx);
  if (b.hall) return b.hall;
  const sr = ctx.sampleRate;
  const seconds = 2.2;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(sr * 0.014);
  const rt60 = 1.8;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9 * t) / rt60);
      // Cut-off glides from ~9 kHz down to ~1.2 kHz across the tail.
      const fc = 1200 + 7800 * Math.exp(-t * 2.2);
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
      const fadeIn = Math.min(1, t / 0.012);
      d[i] = lp * env * fadeIn * (0.6 + 0.4 * (fc / 9000));
    }
    // Early reflections (different per ear for width).
    const taps = 9;
    for (let k = 0; k < taps; k++) {
      const tt = 0.008 + Math.random() * 0.075 + k * 0.004;
      const idx = pre + Math.floor(tt * sr);
      const amp = (0.5 - k * 0.04) * (Math.random() < 0.5 ? -1 : 1);
      for (let j = 0; j < 24 && idx + j < len; j++) d[idx + j] += amp * Math.exp(-j / 5) * (j === 0 ? 1 : 0.4);
    }
  }
  b.hall = buf;
  return buf;
}

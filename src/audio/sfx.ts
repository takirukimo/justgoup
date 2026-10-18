// The sound-effect library: one builder per SfxId. Each builder layers short synthesized
// elements (pitched thumps, filtered noise bursts, inharmonic metal partials, formant voices)
// into a `Sound`, relative to `s.t` (start time) and `s.p` (pitch multiplier, already including
// the per-call random micro-variation). Builders render into any BaseAudioContext.

import type { SfxId } from '../core/contracts';
import { Sound } from './sound';
import { bleat, effort, gasp, strain, whoa, type VoiceProfile } from './voice';
import { cents, chance, mtof, pick, rand, type NoiseKind } from './util';

export interface SfxKit {
  voice: VoiceProfile;
}

export interface SfxDef {
  /** Base output level. */
  gain: number;
  /** Reverb send amount (hall). */
  send: number;
  /** Max simultaneous voices of this id; the oldest is stolen. */
  max: number;
  /** Random pitch variation per call (± fraction). */
  vary: number;
  /** Minimum seconds between two triggers (rate limit for spammy events). */
  gap?: number;
  /** UI sounds: centred, no timing jitter, no level jitter. */
  ui?: boolean;
  build(s: Sound, k: SfxKit): void;
}

/** Seconds between countdown steps in the full 'countdown' sequence. */
export const COUNT_STEP = 0.8;

// ─────────────────────────────── building blocks ───────────────────────────────

/** Sine thump with an exponential pitch drop. */
function thump(s: Sound, t: number, f0: number, f1: number, glide: number, peak: number, decay: number, dest: AudioNode = s.out): void {
  const o = s.osc('sine', f0, t, t + decay + 0.03);
  s.glide(o.frequency, t, f0, f1, glide);
  const g = s.gain(0);
  s.perc(g.gain, t, peak, 0.0025, decay);
  s.chain(o, g, dest);
}

/** Filtered noise burst. */
function burst(
  s: Sound, t: number, kind: NoiseKind, type: BiquadFilterType, freq: number, q: number,
  peak: number, a: number, d: number, dest: AudioNode = s.out,
): BiquadFilterNode {
  const n = s.noise(kind, t, t + a + d + 0.02);
  const f = s.filter(type, freq, q);
  const g = s.gain(0);
  s.perc(g.gain, t, peak, a, d);
  s.chain(n, f, g, dest);
  return f;
}

/** Inharmonic sine partials: [Hz, peak, decay]. */
function ring(s: Sound, t: number, partials: readonly (readonly [number, number, number])[], dest: AudioNode = s.out): void {
  for (const [f, pk, d] of partials) {
    const o = s.osc('sine', f, t, t + d + 0.02);
    const g = s.gain(0);
    s.perc(g.gain, t, pk, 0.0008, d);
    s.chain(o, g, dest);
  }
}

/** Stick-slip scrape: swept band-passed noise with grainy amplitude modulation. */
function scrape(
  s: Sound, t: number, dur: number, f0: number, f1: number, q: number, peak: number,
  rough = 0.6, attack = 0.01, kind: NoiseKind = 'white', dest: AudioNode = s.out,
): void {
  const n = s.noise(kind, t, t + attack + dur + 0.03);
  const bp = s.filter('bandpass', f0, q);
  s.glide(bp.frequency, t, f0, f1, attack + dur);
  const env = s.gain(0);
  s.perc(env.gain, t, peak, attack, dur);
  const am = s.gain(1 - rough * 0.5);
  s.wobble(am.gain, rough * 0.5, 90, t, t + attack + dur + 0.03);
  s.chain(n, bp, env, am, dest);
}

/** Short rubber squeak (shoe on plastic). */
function squeak(s: Sound, t: number, f: number, dur: number, peak: number, dest: AudioNode = s.out): void {
  const o = s.osc('reed', f, t, t + dur + 0.06);
  s.glide(o.frequency, t, f, f * rand(1.08, 1.2), dur);
  s.lfo(o.frequency, rand(28, 40), f * 0.03, t, t + dur + 0.06);
  const bp = s.filter('bandpass', f * 2.2, 2);
  const hp = s.filter('highpass', 800);
  const g = s.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.006);
  g.gain.setValueAtTime(peak, t + dur * 0.6);
  g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.12);
  s.chain(o, bp, hp, g, dest);
}

/** Glassy tone (odd partials + soft octave). */
function tone(s: Sound, t: number, f: number, peak: number, a: number, d: number, dest: AudioNode = s.out): void {
  const o = s.osc('hollow', f, t, t + a + d + 0.02);
  const g = s.gain(0);
  s.perc(g.gain, t, peak, a, d);
  s.chain(o, g, dest);
  const o2 = s.osc('sine', f * 2, t, t + a + d * 0.6 + 0.02);
  const g2 = s.gain(0);
  s.perc(g2.gain, t, peak * 0.18, a, d * 0.5);
  s.chain(o2, g2, dest);
}

/** Soft plucked note with a closing low-pass. */
function pluckNote(s: Sound, t: number, f: number, peak: number, pan: number, decay: number, dest: AudioNode = s.out): void {
  const o = s.osc('pluck', f, t, t + decay + 0.05);
  const lp = s.filter('lowpass', 6000, 1);
  s.glide(lp.frequency, t, Math.min(9000, f * 8), Math.max(f * 1.2, 500), 0.4);
  const g = s.gain(0);
  s.perc(g.gain, t, peak, 0.002, decay);
  const pn = s.panner(pan);
  s.chain(o, lp, g, pn, dest);
  const o2 = s.osc('sine', f * 2, t, t + 0.3);
  const g2 = s.gain(0);
  s.perc(g2.gain, t, peak * 0.3, 0.002, 0.22);
  s.chain(o2, g2, pn);
}

/** FM bell (ratio 3.5, decaying index). */
function bell(s: Sound, t: number, f: number, peak: number, decay: number, pan: number, dest: AudioNode = s.out): void {
  const car = s.osc('sine', f, t, t + decay + 0.05);
  const mod = s.osc('sine', f * 3.5, t, t + decay + 0.05);
  const idx = s.gain(0);
  s.perc(idx.gain, t, f * 1.8, 0.001, decay * 0.5);
  mod.connect(idx);
  idx.connect(car.frequency);
  const g = s.gain(0);
  s.perc(g.gain, t, peak, 0.002, decay);
  const pn = s.panner(pan);
  s.chain(car, g, pn, dest);
}

/** Stereo panner sweeping from → to (gain passthrough where unsupported). */
function panSweep(s: Sound, t: number, from: number, to: number, dur: number): AudioNode {
  const p = s.panner(from);
  if (typeof StereoPannerNode !== 'undefined' && p instanceof StereoPannerNode) {
    p.pan.setValueAtTime(from, t);
    p.pan.linearRampToValueAtTime(to, t + dur);
  }
  return p;
}

/** One countdown element: tick (go=false) or the brighter, longer GO. */
export function countBeep(s: Sound, t: number, go: boolean): void {
  const p = s.p;
  if (!go) {
    tone(s, t, 880 * p, 0.17, 0.002, 0.15);
    burst(s, t, 'white', 'bandpass', 3000, 1.2, 0.1, 0.0005, 0.006);
    thump(s, t, 420 * p, 300 * p, 0.02, 0.05, 0.04);
  } else {
    tone(s, t, mtof(93) * p, 0.15, 0.003, 0.6);
    tone(s, t + 0.012, mtof(88) * p, 0.08, 0.003, 0.5);
    tone(s, t + 0.024, mtof(81) * p, 0.08, 0.003, 0.45);
    thump(s, t, 150 * p, 70 * p, 0.05, 0.22, 0.14);
    burst(s, t, 'white', 'highpass', 6000, 0.7, 0.05, 0.005, 0.25);
  }
}

// ─────────────────────────────── the library ───────────────────────────────

export const SFX: Record<SfxId, SfxDef> = {
  grab: {
    gain: 1.3, send: 0.1, max: 6, vary: 0.04,
    build(s) {
      const t = s.t, p = s.p;
      thump(s, t, 230 * p, 96 * p, 0.05, 0.22, 0.07); // meat of the palm
      burst(s, t, 'white', 'bandpass', 1500 * p, 0.8, 1.8, 0.001, 0.05); // slap
      burst(s, t, 'pink', 'lowpass', 3800, 0.7, 0.35, 0.001, 0.07); // skin
      burst(s, t + 0.001, 'white', 'bandpass', 960 * p, 7, 3.5, 0.001, 0.05); // hollow plastic knock
      burst(s, t + 0.001, 'white', 'bandpass', 2350 * p, 9, 1.8, 0.001, 0.035);
      ring(s, t, [[540 * p, 0.08, 0.05]]);
      for (let i = 0; i < 3; i++) {
        burst(s, t + rand(0.004, 0.03), 'white', 'highpass', 3500, 0.7, rand(0.1, 0.18), 0.0005, 0.004); // texture grit
      }
      burst(s, t + 0.012, 'pink', 'bandpass', 5200, 0.6, 0.28, 0.015, 0.22); // chalk puff
    },
  },

  'grab-bad': {
    gain: 1.0, send: 0.1, max: 5, vary: 0.05,
    build(s) {
      const t = s.t, p = s.p;
      thump(s, t, 320 * p, 170 * p, 0.04, 0.2, 0.05);
      burst(s, t, 'white', 'bandpass', 2600 * p, 1.1, 1.8, 0.001, 0.03);
      burst(s, t + 0.001, 'white', 'bandpass', 1250 * p, 6, 2.5, 0.001, 0.03);
      scrape(s, t + 0.012, 0.2, 2900 * p, 1300 * p, 2.2, 1.4, 0.7, 0.012);
      burst(s, t + 0.02, 'white', 'highpass', 4500, 0.7, 0.12, 0.004, 0.08); // fingertip skid
    },
  },

  release: {
    gain: 1.4, send: 0.06, max: 4, vary: 0.05,
    build(s) {
      const t = s.t, p = s.p;
      burst(s, t, 'pink', 'bandpass', 1200 * p, 0.7, 0.75, 0.003, 0.07);
      thump(s, t, 170 * p, 120 * p, 0.04, 0.1, 0.05);
      burst(s, t + 0.01, 'white', 'bandpass', 2600, 0.7, 0.1, 0.02, 0.1);
    },
  },

  chalk: {
    gain: 0.9, send: 0.1, max: 2, vary: 0.05,
    build(s) {
      const t = s.t, p = s.p;
      // Fingers rustling in the chalk bag.
      const n = s.noise('white', t, t + 0.25);
      const bp = s.filter('bandpass', 3400 * p, 1.4);
      const env = s.gain(0);
      s.swell(env.gain, t, 0.8, 0.03, 0.06, 0.1);
      const am = s.gain(0.4);
      s.wobble(am.gain, 0.4, 60, t, t + 0.25);
      s.chain(n, bp, env, am, s.out);
      // Dusty breathy puff.
      const t2 = t + 0.13;
      const pn = s.noise('pink', t2, t2 + 0.5);
      const b1 = s.filter('bandpass', 900 * p, 0.9);
      s.glide(b1.frequency, t2, 850 * p, 1500 * p, 0.25);
      const g1 = s.gain(0);
      s.perc(g1.gain, t2, 0.7, 0.04, 0.36);
      s.chain(pn, b1, g1, s.out);
      const b2 = s.filter('bandpass', 2800 * p, 1.3);
      const g2 = s.gain(0);
      s.perc(g2.gain, t2, 0.35, 0.05, 0.3);
      s.chain(pn, b2, g2, s.out);
      // Floating dust.
      burst(s, t2 + 0.02, 'white', 'highpass', 7000, 0.7, 0.07, 0.05, 0.38);
    },
  },

  foot: {
    gain: 1.0, send: 0.08, max: 4, vary: 0.05,
    build(s) {
      const t = s.t, p = s.p;
      thump(s, t, 190 * p, 110 * p, 0.04, 0.22, 0.05);
      burst(s, t, 'pink', 'lowpass', 2400, 0.7, 0.4, 0.001, 0.03); // damped rubber click
      burst(s, t + 0.001, 'white', 'bandpass', 1250 * p, 5, 1.6, 0.001, 0.03);
      if (chance(0.55)) squeak(s, t + rand(0.006, 0.02), rand(1050, 1500) * p, rand(0.04, 0.07), rand(0.18, 0.3));
    },
  },

  smear: {
    gain: 0.72, send: 0.08, max: 3, vary: 0.05,
    build(s) {
      const t = s.t, p = s.p;
      thump(s, t, 170 * p, 110 * p, 0.04, 0.18, 0.05);
      burst(s, t, 'pink', 'lowpass', 2000, 0.7, 0.3, 0.001, 0.03);
      // Rubber squeal.
      const f = rand(700, 950) * p;
      const dur = rand(0.2, 0.28);
      const t1 = t + 0.01;
      const o = s.osc('reed', f, t1, t1 + dur + 0.1);
      s.glide(o.frequency, t1, f, f * rand(1.1, 1.25), dur);
      s.wobble(o.frequency, f * 0.06, 18, t1, t1 + dur + 0.1);
      const bp = s.filter('bandpass', 2000 * p, 3);
      const hp = s.filter('highpass', 600);
      const g = s.gain(0);
      s.swell(g.gain, t1, 0.35, 0.02, dur * 0.55, dur * 0.4);
      s.chain(o, bp, hp, g, s.out);
      // Sole dragging on the wall.
      scrape(s, t + 0.005, 0.3, 1500 * p, 1100 * p, 1.4, 1.2, 0.7, 0.02, 'pink');
    },
  },

  slip: {
    gain: 1.2, send: 0.12, max: 2, vary: 0.04,
    build(s, k) {
      const t = s.t, p = s.p;
      scrape(s, t, 0.28, 3800 * p, 900 * p, 2.2, 2.2, 0.75, 0.004);
      burst(s, t, 'white', 'highpass', 5000, 0.7, 0.3, 0.002, 0.06);
      thump(s, t, 260 * p, 140 * p, 0.03, 0.18, 0.04);
      gasp(s, k.voice, t + 0.07, 0.35);
    },
  },

  effort: {
    gain: 0.36, send: 0.06, max: 2, vary: 0.03, gap: 0.12,
    build(s, k) {
      effort(s, k.voice);
    },
  },

  strain: {
    gain: 0.42, send: 0.06, max: 1, vary: 0.03, gap: 0.4,
    build(s, k) {
      strain(s, k.voice);
    },
  },

  fall: {
    gain: 0.85, send: 0.14, max: 1, vary: 0.03,
    build(s, k) {
      const t = s.t;
      const dur = 1.0;
      const n = s.noise('pink', t, t + dur + 0.05);
      const bp = s.filter('bandpass', 350, 1.4);
      s.path(bp.frequency, t, [[0, 350], [0.3, 1600], [dur, 500]]);
      const g = s.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1.3, t + 0.28);
      g.gain.setTargetAtTime(0, t + 0.3, 0.14);
      s.chain(n, bp, g, panSweep(s, t, -0.3, 0.3, dur), s.out);
      whoa(s, k.voice, t + 0.04, 0.32);
    },
  },

  land: {
    gain: 0.85, send: 0.12, max: 2, vary: 0.04,
    build(s) {
      const t = s.t, p = s.p;
      // Deep thump, softly saturated so it still reads on phone speakers.
      const o = s.osc('sine', 78 * p, t, t + 0.6);
      s.glide(o.frequency, t, 78 * p, 38 * p, 0.14);
      const g = s.gain(0);
      s.perc(g.gain, t, 1, 0.003, 0.42);
      const drive = s.gain(1.5);
      const sh = s.shaper(1.6);
      const post = s.gain(0.42);
      s.chain(o, g, drive, sh, post, s.out);
      const sub = s.osc('sine', 46 * p, t, t + 0.5);
      const sg = s.gain(0);
      s.perc(sg.gain, t, 0.28, 0.01, 0.38);
      s.chain(sub, sg, s.out);
      // Muffled foam.
      burst(s, t, 'brown', 'lowpass', 380, 0.7, 0.75, 0.004, 0.28);
      // Air pushed out of the pad.
      const a = s.noise('pink', t + 0.01, t + 0.6);
      const lp = s.filter('lowpass', 900, 0.6);
      s.glide(lp.frequency, t + 0.01, 1400, 350, 0.45);
      const ag = s.gain(0);
      s.perc(ag.gain, t + 0.01, 0.28, 0.035, 0.42);
      s.chain(a, lp, ag, s.out);
      // Foam "whump" in the low mids — what you actually hear on small speakers.
      burst(s, t + 0.002, 'pink', 'bandpass', 460 * p, 0.9, 2.5, 0.006, 0.17);
      // Body on vinyl.
      burst(s, t, 'white', 'lowpass', 1800, 0.7, 1.2, 0.001, 0.04);
    },
  },

  send: {
    gain: 1.4, send: 0.28, max: 1, vary: 0.0,
    build(s) {
      const t = s.t, p = s.p;
      // Low body.
      const lo = s.osc('soft', mtof(38) * p, t, t + 1.4);
      const lg = s.gain(0);
      s.perc(lg.gain, t, 0.26, 0.006, 1.2);
      s.chain(lo, lg, s.out);
      // Rising pluck arpeggio, D major.
      const arp = [74, 78, 81, 86];
      arp.forEach((m, i) => {
        pluckNote(s, t + i * 0.055 + rand(0, 0.006), mtof(m) * p, 0.15 * (1 - i * 0.08), (i / (arp.length - 1) - 0.5) * 0.6, 1.1);
      });
      pluckNote(s, t + 0.24, mtof(90) * p, 0.07, 0.25, 1.3);
      // Pad swell (Dmaj9) opening up.
      const lp = s.filter('lowpass', 500, 0.8);
      s.path(lp.frequency, t, [[0, 500], [0.35, 3400], [1.5, 1600]]);
      const pe = s.gain(0);
      s.swell(pe.gain, t, 1, 0.22, 0.35, 1.05);
      s.chain(lp, pe, s.out);
      for (const m of [62, 66, 69, 73, 76]) {
        for (const side of [-1, 1]) {
          const o = s.osc('warm', mtof(m) * p * cents(side * 7 + rand(-2, 2)), t, t + 1.75);
          const g = s.gain(0.042);
          s.chain(o, g, s.panner(side * 0.45), lp);
        }
      }
      // Sparkle.
      for (let i = 0; i < 7; i++) {
        const tt = t + 0.12 + i * 0.1 + rand(0, 0.05);
        const f = mtof(pick([86, 88, 90, 93, 95, 98])) * p;
        const o = s.osc('sine', f, tt, tt + 0.5);
        const g = s.gain(0);
        s.perc(g.gain, tt, rand(0.03, 0.05), 0.002, 0.35);
        s.chain(o, g, s.panner(rand(-0.7, 0.7)), s.out);
      }
      burst(s, t + 0.05, 'white', 'highpass', 6500, 0.7, 0.04, 0.3, 0.8);
    },
  },

  'top-touch': {
    gain: 0.75, send: 0.25, max: 2, vary: 0.01,
    build(s) {
      const t = s.t, p = s.p;
      const f = mtof(81) * p;
      ring(s, t, [[f, 0.12, 0.9], [f * 2.76, 0.035, 0.35], [f * 5.4, 0.018, 0.15]]);
      const f2 = mtof(88) * p;
      ring(s, t + 0.07, [[f2, 0.08, 0.8], [f2 * 2.76, 0.02, 0.3]]);
    },
  },

  clip: {
    gain: 2.0, send: 0.12, max: 2, vary: 0.03,
    build(s) {
      const t = s.t, p = s.p;
      // Stage 1: the rope pushes the gate open.
      burst(s, t, 'white', 'highpass', 3000, 0.7, 0.35, 0.0005, 0.012);
      ring(s, t, [[3150 * p, 0.06, 0.06], [4720 * p, 0.045, 0.045], [6930 * p, 0.03, 0.03]]);
      burst(s, t + 0.006, 'pink', 'bandpass', 1100, 1, 0.14, 0.02, 0.06);
      // Stage 2: the gate snaps shut.
      const t2 = t + rand(0.065, 0.085);
      burst(s, t2, 'white', 'highpass', 2000, 0.7, 0.6, 0.0005, 0.018);
      burst(s, t2, 'white', 'bandpass', 1450 * p, 4, 0.5, 0.0005, 0.025);
      ring(s, t2, [[2610 * p, 0.09, 0.13], [3980 * p, 0.07, 0.09], [5770 * p, 0.05, 0.065], [8210 * p, 0.03, 0.04]]);
      // The draw's sling settles.
      for (const dt of [0.13, 0.2]) {
        const tt = t2 + dt + rand(-0.01, 0.015);
        ring(s, tt, [[rand(3300, 4200) * p, 0.025, 0.05], [rand(5200, 6400) * p, 0.015, 0.035]]);
      }
    },
  },

  'rope-catch': {
    gain: 1.1, send: 0.14, max: 1, vary: 0.04,
    build(s) {
      const t = s.t, p = s.p;
      // Zing: the rope loads through the carabiner.
      const o = s.osc('reed', 70 * p, t, t + 0.5);
      s.path(o.frequency, t, [[0, 70 * p], [0.18, 260 * p], [0.42, 180 * p]]);
      s.wobble(o.frequency, 12, 40, t, t + 0.5);
      const bp = s.filter('bandpass', 700, 4);
      s.path(bp.frequency, t, [[0, 300], [0.18, 1100], [0.42, 700]]);
      const g = s.gain(0);
      s.swell(g.gain, t, 0.8, 0.04, 0.12, 0.25);
      s.chain(o, bp, g, s.out);
      const n = s.noise('white', t, t + 0.45);
      const nb = s.filter('bandpass', 600, 5);
      s.path(nb.frequency, t, [[0, 600], [0.2, 2400], [0.4, 1500]]);
      const ng = s.gain(0);
      s.swell(ng.gain, t, 1.5, 0.06, 0.08, 0.22);
      const am = s.gain(0.6);
      s.wobble(am.gain, 0.4, 70, t, t + 0.45);
      s.chain(n, nb, ng, am, s.out);
      // Thud into the harness.
      const t2 = t + 0.12;
      thump(s, t2, 95 * p, 50 * p, 0.1, 0.3, 0.25);
      burst(s, t2, 'pink', 'bandpass', 520, 3, 0.7, 0.002, 0.12);
      burst(s, t2, 'brown', 'lowpass', 400, 0.7, 0.25, 0.003, 0.18);
      ring(s, t2 + 0.02, [[2200 * p, 0.04, 0.08], [3400 * p, 0.03, 0.06]]);
    },
  },

  'ui-tap': {
    gain: 2.1, send: 0.03, max: 4, vary: 0.015, gap: 0.03, ui: true,
    build(s) {
      const t = s.t, p = s.p;
      burst(s, t, 'white', 'bandpass', 3200, 1.2, 0.22, 0.0005, 0.008);
      const o = s.osc('sine', 1150 * p, t, t + 0.06);
      s.glide(o.frequency, t, 1150 * p, 880 * p, 0.03);
      const g = s.gain(0);
      s.perc(g.gain, t, 0.13, 0.001, 0.035);
      s.chain(o, g, s.out);
      thump(s, t, 340 * p, 280 * p, 0.02, 0.08, 0.03);
    },
  },

  'ui-back': {
    gain: 1.3, send: 0.03, max: 3, vary: 0.015, gap: 0.03, ui: true,
    build(s) {
      const t = s.t, p = s.p;
      const o = s.osc('sine', 880 * p, t, t + 0.12);
      s.glide(o.frequency, t, 880 * p, 560 * p, 0.07);
      const g = s.gain(0);
      s.perc(g.gain, t, 0.14, 0.002, 0.08);
      s.chain(o, g, s.out);
      burst(s, t, 'pink', 'lowpass', 2500, 0.7, 0.12, 0.0005, 0.012);
      const t2 = t + 0.05;
      const o2 = s.osc('sine', 620 * p, t2, t2 + 0.08);
      const g2 = s.gain(0);
      s.perc(g2.gain, t2, 0.06, 0.002, 0.05);
      s.chain(o2, g2, s.out);
    },
  },

  'ui-confirm': {
    gain: 0.85, send: 0.1, max: 3, vary: 0.01, gap: 0.04, ui: true,
    build(s) {
      const t = s.t, p = s.p;
      burst(s, t, 'white', 'bandpass', 3500, 1.2, 0.15, 0.0005, 0.008);
      tone(s, t, mtof(86) * p, 0.11, 0.003, 0.2);
      tone(s, t + 0.07, mtof(93) * p, 0.1, 0.003, 0.38);
    },
  },

  'ui-swipe': {
    gain: 0.85, send: 0.05, max: 3, vary: 0.04, gap: 0.04, ui: true,
    build(s) {
      const t = s.t, p = s.p;
      const n = s.noise('pink', t, t + 0.25);
      const bp = s.filter('bandpass', 900 * p, 1.1);
      s.glide(bp.frequency, t, 900 * p, 3800 * p, 0.15);
      const g = s.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1.0, t + 0.06);
      g.gain.setTargetAtTime(0, t + 0.07, 0.035);
      const pn = panSweep(s, t, -0.4, 0.4, 0.18);
      s.chain(n, bp, g, pn, s.out);
      burst(s, t + 0.02, 'white', 'highpass', 6000, 0.7, 0.12, 0.04, 0.08, pn);
    },
  },

  unlock: {
    gain: 2.0, send: 0.32, max: 1, vary: 0.0,
    build(s) {
      const t = s.t, p = s.p;
      const notes = [86, 90, 93, 98, 102]; // D6 F#6 A6 D7 F#7
      notes.forEach((m, i) => bell(s, t + i * 0.075, mtof(m) * p, 0.085 * (1 - i * 0.1), 1.1 + i * 0.1, rand(-0.6, 0.6)));
      for (const m of [74, 78, 81]) {
        for (const d of [-1, 1]) {
          const o = s.osc('sine', mtof(m) * p + d * rand(2, 4), t, t + 2.0);
          const g = s.gain(0);
          s.swell(g.gain, t, 0.022, 0.4, 0.35, 1.1);
          s.chain(o, g, s.panner(d * 0.5), s.out);
        }
      }
      const o = s.osc('warm', mtof(62) * p, t, t + 2.0);
      const lp = s.filter('lowpass', 900, 0.7);
      const g = s.gain(0);
      s.swell(g.gain, t, 0.05, 0.3, 0.4, 1.1);
      s.chain(o, lp, g, s.out);
      burst(s, t + 0.05, 'white', 'highpass', 7000, 0.7, 0.05, 0.4, 0.9);
    },
  },

  whoosh: {
    gain: 0.85, send: 0.1, max: 2, vary: 0.06,
    build(s) {
      const t = s.t, p = s.p;
      const dur = 0.6;
      const pn = panSweep(s, t, -0.5, 0.5, dur);
      const n = s.noise('pink', t, t + dur + 0.1);
      const bp = s.filter('bandpass', 280 * p, 1.3);
      s.path(bp.frequency, t, [[0, 280 * p], [0.22, 1900 * p], [dur, 500 * p]]);
      const g = s.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1.0, t + 0.2);
      g.gain.setTargetAtTime(0, t + 0.22, 0.09);
      s.chain(n, bp, g, pn, s.out);
      const b = s.noise('brown', t, t + dur + 0.1);
      const lp = s.filter('lowpass', 300, 0.7);
      const bg = s.gain(0);
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(0.3, t + 0.2);
      bg.gain.setTargetAtTime(0, t + 0.22, 0.09);
      s.chain(b, lp, bg, s.out);
      burst(s, t + 0.12, 'white', 'highpass', 4500, 0.7, 0.05, 0.08, 0.2, pn);
    },
  },

  countdown: {
    gain: 0.64, send: 0.1, max: 1, vary: 0.0, ui: true,
    build(s) {
      for (let i = 0; i < 3; i++) countBeep(s, s.t + i * COUNT_STEP, false);
      countBeep(s, s.t + 3 * COUNT_STEP, true);
    },
  },

  guide: {
    gain: 0.2, send: 0.05, max: 2, vary: 0.02, gap: 0.05,
    build(s) {
      bleat(s);
    },
  },

  'score-tick': {
    gain: 2.1, send: 0.04, max: 4, vary: 0.02, gap: 0.025, ui: true,
    build(s) {
      const t = s.t, p = s.p;
      ring(s, t, [[2400 * p, 0.09, 0.028], [3610 * p, 0.035, 0.018]]);
      burst(s, t, 'white', 'highpass', 8000, 0.7, 0.03, 0.0005, 0.004);
    },
  },
};

export const SFX_IDS = Object.keys(SFX) as SfxId[];

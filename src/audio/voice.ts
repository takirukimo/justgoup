// Vocal synthesis: a small source–filter voice model. A band-limited glottal wavetable (with
// jitter, vibrato and tremolo) plus aspiration noise feed a parallel bank of three formant
// band-passes whose frequencies can morph over time between vowels. Used for the climber's
// grunts, strained breaths, gasps and "whoa", the breathing layer, and Steini's goat bleat.
// The per-head voice sets (species.ts) build on these primitives; the gestures below are the human set.

import type { HeadId } from '../core/types';
import type { Sound } from './sound';
import { chance, pick, rand, weighted } from './util';

export type VowelId = 'a' | 'ae' | 'e' | 'eh' | 'i' | 'o' | 'u' | 'uh' | 'nn' | 'm';

interface Vowel {
  f: readonly [number, number, number];
  g: readonly [number, number, number];
}

const VOWELS: Record<VowelId, Vowel> = {
  a: { f: [780, 1180, 2600], g: [1, 0.6, 0.3] },
  ae: { f: [680, 1700, 2450], g: [1, 0.55, 0.28] },
  e: { f: [480, 1900, 2600], g: [1, 0.45, 0.3] },
  eh: { f: [560, 1650, 2500], g: [1, 0.5, 0.28] },
  i: { f: [310, 2250, 3000], g: [1, 0.35, 0.25] },
  o: { f: [520, 860, 2550], g: [1, 0.65, 0.2] },
  u: { f: [340, 720, 2450], g: [1, 0.5, 0.14] },
  uh: { f: [640, 1190, 2390], g: [1, 0.55, 0.25] },
  nn: { f: [270, 1250, 2400], g: [1, 0.16, 0.1] },
  m: { f: [250, 950, 2300], g: [1, 0.1, 0.06] },
};

/** Formant bandwidths (Hz) at bw scale 1. */
const BW = [95, 125, 175] as const;
/** Make-up gain per formant band (narrow band-passes lose a lot of level). */
const MAKEUP = [2.6, 3.4, 3.8] as const;

export type VowelPath = VowelId | readonly (readonly [number, VowelId])[];

/** The climber's voice: base pitch + vocal tract scale, and which head's voice set speaks (species.ts). */
export interface VoiceProfile {
  f0: number;
  tract: number;
  /** Head whose voice set this is (species.ts VOICE_SETS); absent = human. */
  species?: HeadId;
}

export const DEFAULT_VOICE: VoiceProfile = { f0: 132, tract: 1, species: 'human' };

/**
 * Parallel formant filter: `src` → 3 band-passes (+ a low body path) → returned gain node.
 * `path` is a vowel or a list of [time fraction, vowel] key-frames across `dur`.
 */
export function formantBank(
  s: Sound,
  src: AudioNode,
  t: number,
  dur: number,
  path: VowelPath,
  shift = 1,
  bw = 1,
): GainNode {
  const out = s.gain(1);
  const keys: readonly (readonly [number, VowelId])[] = typeof path === 'string' ? [[0, path]] : path;
  const v0 = VOWELS[keys[0][1]];
  for (let i = 0; i < 3; i++) {
    const f0 = v0.f[i] * shift;
    const bp = s.filter('bandpass', f0, f0 / (BW[i] * bw * (0.85 + 0.15 * shift)));
    const g = s.gain(v0.g[i] * MAKEUP[i] / Math.sqrt(bw));
    if (keys.length > 1) {
      bp.frequency.setValueAtTime(f0, t);
      g.gain.setValueAtTime(v0.g[i] * MAKEUP[i] / Math.sqrt(bw), t);
      for (let k = 1; k < keys.length; k++) {
        const v = VOWELS[keys[k][1]];
        const tk = t + keys[k][0] * dur;
        bp.frequency.linearRampToValueAtTime(v.f[i] * shift, tk);
        g.gain.linearRampToValueAtTime(v.g[i] * MAKEUP[i] / Math.sqrt(bw), tk);
      }
    }
    s.chain(src, bp, g, out);
  }
  // Low "chest" path keeps the voice from sounding like a whistle.
  const body = s.filter('lowpass', v0.f[0] * shift * 1.15, 0.7);
  const bg = s.gain(0.22);
  s.chain(src, body, bg, out);
  return out;
}

export interface VocalSpec {
  t: number;
  /** Total duration including release. */
  dur: number;
  attack: number;
  release: number;
  /** Pitch contour: [time fraction 0..1, Hz]. */
  f0: readonly (readonly [number, number])[];
  /** Voiced amplitude (0 = whisper / breath only). */
  voice: number;
  /** Aspiration noise amplitude. */
  breath: number;
  /** 'lead' = aspirated onset ("h…"), 'flat' = follows the voice envelope. */
  breathShape?: 'lead' | 'flat';
  vowel: VowelPath;
  /** Formant scale (vocal tract size). */
  shift?: number;
  /** Formant bandwidth scale (wider = breathier). */
  bw?: number;
  wave?: 'glottal' | 'pressed';
  /** Random pitch jitter as a fraction of f0. */
  jitter?: number;
  vibrato?: readonly [number, number];
  tremolo?: readonly [number, number];
  level?: number;
  dest?: AudioNode;
}

/** Render one vocal gesture into `s`. */
export function vocal(s: Sound, v: VocalSpec): void {
  const t0 = v.t;
  const t1 = v.t + v.dur;
  const relStart = Math.max(t0 + v.attack, t1 - v.release);
  const mix = s.gain(1);
  const fAvg = v.f0.reduce((a, [, hz]) => a + hz, 0) / v.f0.length;

  if (v.voice > 0) {
    const o = s.osc(v.wave ?? 'glottal', v.f0[0][1], t0, t1 + 0.03);
    o.frequency.setValueAtTime(v.f0[0][1], t0);
    for (let i = 1; i < v.f0.length; i++) {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, v.f0[i][1]), t0 + v.f0[i][0] * v.dur);
    }
    if (v.jitter) s.wobble(o.frequency, fAvg * v.jitter, 22, t0, t1 + 0.03);
    if (v.vibrato) s.lfo(o.frequency, v.vibrato[0], fAvg * v.vibrato[1], t0, t1 + 0.03);
    const vg = s.gain(0);
    vg.gain.setValueAtTime(0, t0);
    vg.gain.linearRampToValueAtTime(v.voice, t0 + v.attack);
    vg.gain.setValueAtTime(v.voice, relStart);
    vg.gain.setTargetAtTime(0, relStart, Math.max(0.005, v.release / 5));
    let tail: AudioNode = vg;
    if (v.tremolo) {
      const tg = s.gain(1 - v.tremolo[1] * 0.5);
      s.lfo(tg.gain, v.tremolo[0], v.tremolo[1] * 0.5, t0, t1 + 0.03);
      vg.connect(tg);
      tail = tg;
    }
    o.connect(vg);
    tail.connect(mix);
  }

  if (v.breath > 0) {
    const n = s.noise('white', t0, t1 + 0.03);
    const hp = s.filter('highpass', 260, 0.6);
    const ng = s.gain(0);
    ng.gain.setValueAtTime(0, t0);
    if (v.breathShape === 'lead') {
      ng.gain.linearRampToValueAtTime(v.breath, t0 + Math.max(0.008, v.attack * 0.6));
      ng.gain.setTargetAtTime(v.breath * 0.3, t0 + v.attack, 0.05);
      ng.gain.setValueAtTime(v.breath * 0.3, relStart);
    } else {
      ng.gain.linearRampToValueAtTime(v.breath, t0 + v.attack);
      ng.gain.setValueAtTime(v.breath, relStart);
    }
    ng.gain.setTargetAtTime(0, relStart, Math.max(0.005, v.release / 5));
    s.chain(n, hp, ng, mix);
  }

  const shaped = formantBank(s, mix, t0, v.dur, v.vowel, v.shift ?? 1, v.bw ?? 1);
  const lvl = s.gain(v.level ?? 1);
  s.chain(shaped, lvl, v.dest ?? s.out);
}

// ─────────────────────────────── climber gestures ───────────────────────────────

/** Short exhale / grunt. Every call picks a different style, vowel, pitch and length. */
export function effort(s: Sound, voice: VoiceProfile, t = s.t): void {
  const f = voice.f0 * s.p * rand(0.92, 1.1);
  const tract = voice.tract * rand(0.96, 1.04);
  const style = weighted([
    ['hup', 3],
    ['hff', 2],
    ['ngh', 2],
    ['hah', 2],
  ] as const);
  if (style === 'hff') {
    const dur = rand(0.22, 0.34);
    vocal(s, {
      t, dur, attack: 0.018, release: dur * 0.75, f0: [[0, f]], voice: 0, breath: 1,
      vowel: pick(['o', 'u', 'uh'] as const), shift: tract, bw: 1.9, level: 0.95,
    });
  } else if (style === 'hup') {
    const dur = rand(0.17, 0.26);
    vocal(s, {
      t, dur, attack: 0.03, release: 0.09, f0: [[0, f * 1.06], [0.35, f], [1, f * 0.84]], voice: 1, breath: 0.4,
      breathShape: 'lead', vowel: pick(['uh', 'a', 'o', 'uh'] as const), shift: tract, jitter: 0.02, level: 0.85,
    });
  } else if (style === 'ngh') {
    const dur = rand(0.18, 0.26);
    // Glottal stop onset.
    const c = s.noise('pink', t, t + 0.03);
    const cf = s.filter('bandpass', 900, 1.2);
    const cg = s.gain(0);
    s.perc(cg.gain, t, 0.12, 0.001, 0.012);
    s.chain(c, cf, cg, s.out);
    vocal(s, {
      t: t + 0.006, dur, attack: 0.02, release: 0.08, f0: [[0, f * 1.16], [1, f * 0.98]], voice: 1, breath: 0.15,
      vowel: [[0, 'nn'], [0.45, 'uh'], [1, 'uh']], wave: 'pressed', shift: tract * 0.95, jitter: 0.025, level: 0.7,
    });
  } else {
    const dur = rand(0.22, 0.32);
    vocal(s, {
      t, dur, attack: 0.025, release: 0.14, f0: [[0, f * 1.1], [1, f * 0.78]], voice: 0.7, breath: 0.65,
      breathShape: 'lead', vowel: 'a', shift: tract, jitter: 0.02, bw: 1.2, level: 0.85,
    });
  }
}

/** Long strained "nnngh…" with tremor, ending in a released exhale. Returns its duration. */
export function strain(s: Sound, voice: VoiceProfile, t = s.t): number {
  const f = voice.f0 * s.p * rand(1.04, 1.16);
  const tract = voice.tract * rand(0.97, 1.03);
  const d1 = rand(0.75, 1.0);
  const rate = rand(5.5, 7.5);
  vocal(s, {
    t, dur: d1, attack: 0.14, release: 0.1, f0: [[0, f], [0.6, f * 1.17], [1, f * 1.26]], voice: 1, breath: 0.22,
    vowel: [[0, 'nn'], [0.5, 'uh'], [1, 'eh']], wave: 'pressed', shift: tract * 0.96, jitter: 0.03,
    vibrato: [rate, 0.022], tremolo: [rate, 0.45], level: 0.62,
  });
  const t2 = t + d1 - 0.04;
  const d2 = rand(0.3, 0.42);
  vocal(s, {
    t: t2, dur: d2, attack: 0.02, release: 0.26, f0: [[0, f * 1.05], [1, f * 0.7]], voice: 0.35, breath: 1,
    breathShape: 'lead', vowel: 'a', shift: tract, bw: 1.6, level: 0.75,
  });
  return d1 + d2;
}

/** Sharp surprised inhale. */
export function gasp(s: Sound, voice: VoiceProfile, t = s.t, level = 0.8): void {
  const f = voice.f0 * s.p * rand(1.6, 1.9);
  vocal(s, {
    t, dur: rand(0.2, 0.26), attack: 0.022, release: 0.15, f0: [[0, f], [1, f * 1.12]], voice: 0.16, breath: 1,
    vowel: [[0, 'a'], [1, 'e']], shift: voice.tract * 1.08, bw: 1.6, level,
  });
}

/** Falling "whoa!". */
export function whoa(s: Sound, voice: VoiceProfile, t = s.t, level = 0.78): void {
  const f = voice.f0 * s.p * rand(1.2, 1.35);
  const dur = rand(0.42, 0.55);
  vocal(s, {
    t, dur, attack: 0.05, release: 0.16, f0: [[0, f * 0.9], [0.3, f * 1.25], [1, f * 0.85]], voice: 1, breath: 0.3,
    breathShape: 'lead', vowel: [[0, 'u'], [0.25, 'o'], [0.7, 'a'], [1, 'a']], shift: voice.tract, jitter: 0.03,
    vibrato: [5, 0.012], level,
  });
}

/** One breath (inhale or exhale) for the effort layer. `strainAmt` 0..1 adds voicing. */
export function breath(s: Sound, voice: VoiceProfile, t: number, dur: number, inhale: boolean, level: number, strainAmt: number): void {
  const f = voice.f0 * rand(0.95, 1.05) * (1 + strainAmt * 0.15);
  vocal(s, {
    t, dur,
    attack: inhale ? dur * 0.45 : dur * 0.14,
    release: inhale ? dur * 0.45 : dur * 0.7,
    f0: [[0, f], [1, f * 0.9]],
    voice: inhale ? 0 : strainAmt * 0.28,
    breath: 1,
    vowel: inhale ? (chance(0.5) ? 'e' : 'i') : pick(['o', 'uh', 'a'] as const),
    shift: voice.tract * (inhale ? 1.06 : 1),
    bw: 2.1,
    jitter: 0.02,
    level,
  });
}

// ─────────────────────────────── Steini ───────────────────────────────

/**
 * Steini's speech blip: one tiny goat-like syllable. FM source (ratio 1, decaying index) with
 * the characteristic fast goat quaver (FM + AM ≈ 24 Hz), shaped by small-tract formants that
 * open from a closed "m" into a random vowel. 70–150 ms so it can be fired per word chunk.
 */
export function bleat(s: Sound, t = s.t): void {
  const f = rand(330, 470) * s.p;
  const dur = rand(0.075, 0.15);
  const end = t + dur;
  const stop = end + 0.08;
  const vowel = pick(['eh', 'e', 'ae', 'a', 'eh'] as const);
  const question = chance(0.14);

  const car = s.osc('sine', f, t, stop);
  const mod = s.osc('sine', f, t, stop);
  const idx = s.gain(0);
  idx.gain.setValueAtTime(f * 2.4, t);
  idx.gain.linearRampToValueAtTime(f * 1.3, end);
  mod.connect(idx);
  idx.connect(car.frequency);
  for (const fp of [car.frequency, mod.frequency]) {
    fp.setValueAtTime(f * 0.93, t);
    fp.linearRampToValueAtTime(f, t + 0.03);
    fp.setValueAtTime(f, Math.max(t + 0.031, end - 0.035));
    fp.linearRampToValueAtTime(f * (question ? 1.14 : 0.88), end + 0.04);
  }
  // Goat quaver.
  const qRate = rand(21, 28);
  const q = s.osc('sine', qRate, t, stop);
  const qf = s.gain(f * 0.035);
  q.connect(qf);
  qf.connect(car.frequency);
  qf.connect(mod.frequency);
  const trem = s.gain(0.72);
  const qa = s.gain(0.28);
  q.connect(qa);
  qa.connect(trem.gain);

  const env = s.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + 0.012);
  env.gain.setValueAtTime(1, end - 0.02);
  env.gain.setTargetAtTime(0, end - 0.02, 0.02);

  const src = s.gain(1);
  car.connect(src);
  const shaped = formantBank(s, src, t, dur, [[0, 'm'], [0.32, vowel], [1, vowel]], 1.32, 1.25);
  const dry = s.filter('lowpass', 2600, 0.7);
  const dg = s.gain(0.16);
  s.chain(src, dry, dg, env);
  const sg = s.gain(0.55);
  s.chain(shaped, sg, env);
  s.chain(env, trem, s.out);
}

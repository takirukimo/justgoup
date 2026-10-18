// Per-head voice sets. The climber is a human body with an animal head, and the head decides how
// the climber sounds: every set has the same gestures (short effort, long strain, gasp, falling yell,
// breathing, a relieved exhale and the head's signature call), voiced the way that animal would:
//
//   human        exhale, grunt, "hup", breath (src/audio/voice.ts)
//   ibex         nasal grunts and a deep, quavering bleat; alarm snort
//   chamois      higher, hoarse bleat; the sharp whistle-snort of a chamois alarm
//   goat         bright "meeh" with the slow, deep goat tremolo
//   ram          deep "hrmph" grunts and a low "baah"
//   marmot       whistles and chirps (the marmot alarm whistle)
//   eagle        "kyik" yelps and a descending screech
//   vulture      hisses, wheezes, croaks and bill clacks (vultures have no song)
//   snowleopard  chuffs (prusten), deep growls and a moaning yowl
//   lynx         spitting hisses, rolling growls and a high "mrrow"
//
// Steini's speech blips stay ibex (voice.ts bleat). All builders render relative to `t` into `s.out`
// and work in any BaseAudioContext (scripts/audio-check.mjs renders every set offline).

import type { HeadId } from '../core/types';
import type { Sound } from './sound';
import {
  breath as humanBreath,
  effort as humanEffort,
  gasp as humanGasp,
  strain as humanStrain,
  vocal,
  whoa as humanWhoa,
  type VoiceProfile,
  type VowelId,
  type VowelPath,
} from './voice';
import { chance, pick, rand, randInt, type NoiseKind } from './util';

/** One head's voice. Every gesture renders at `t` into `s.out`. */
export interface VoiceSet {
  readonly id: HeadId;
  /** Grunt pitch (Hz) and formant scale (vocal-tract size) before the per-launch variation. */
  readonly f0: number;
  readonly tract: number;
  /** Short effort: exhale / grunt / hup, or the head's equivalent. Never the same style twice in a row. */
  effort(s: Sound, v: VoiceProfile, t: number): void;
  /** Long strained effort ending in a released breath. Returns its duration (s). */
  strain(s: Sound, v: VoiceProfile, t: number): number;
  /** Sharp surprised inhale (slips). */
  gasp(s: Sound, v: VoiceProfile, t: number, level?: number): void;
  /** Falling yell. */
  whoa(s: Sound, v: VoiceProfile, t: number, level?: number): void;
  /** One breath of the breathing layer. `strainAmt` 0..1 adds voicing. */
  breath(s: Sound, v: VoiceProfile, t: number, dur: number, inhale: boolean, level: number, strainAmt: number): void;
  /** Long relieved exhale (shaking out, after a hard move). */
  exhale(s: Sound, v: VoiceProfile, t: number, level?: number): void;
  /** The head's signature call (send celebration, locker preview). */
  call(s: Sound, v: VoiceProfile, t: number): void;
}

// ─────────────────────────────── shared building blocks ───────────────────────────────

/** Filtered noise hit: 0 → peak over a, exponential decay over d. */
function hit(
  s: Sound, t: number, kind: NoiseKind, type: BiquadFilterType, f: number, q: number,
  peak: number, a: number, d: number, dest: AudioNode = s.out,
): BiquadFilterNode {
  const n = s.noise(kind, t, t + a + d + 0.03);
  const fl = s.filter(type, f, q);
  const g = s.gain(0);
  s.perc(g.gain, t, peak, a, d);
  s.chain(n, fl, g, dest);
  return fl;
}

interface AirSpec {
  kind?: NoiseKind;
  type: BiquadFilterType;
  f: number;
  /** End frequency (exponential glide over the duration). */
  f1?: number;
  q: number;
  level: number;
  attack?: number;
  release?: number;
  /** Amplitude roughness 0..1 (rattle / growl texture) at `roughHz`. */
  rough?: number;
  roughHz?: number;
  dest?: AudioNode;
}

/** Sustained filtered noise (hiss, wheeze, snort) with attack / hold / release. */
function air(s: Sound, t: number, dur: number, o: AirSpec): void {
  const end = t + dur;
  const n = s.noise(o.kind ?? 'white', t, end + 0.06);
  const fl = s.filter(o.type, o.f, o.q);
  if (o.f1 !== undefined) s.glide(fl.frequency, t, o.f, o.f1, dur);
  const g = s.gain(0);
  const a = Math.max(0.003, o.attack ?? 0.02);
  const r = Math.max(0.01, o.release ?? dur * 0.4);
  const relStart = Math.max(t + a, end - r);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.level, t + a);
  g.gain.setValueAtTime(o.level, relStart);
  g.gain.setTargetAtTime(0, relStart, r / 5);
  s.chain(n, fl, g);
  let tail: AudioNode = g;
  if (o.rough) {
    const am = s.gain(1 - o.rough * 0.5);
    s.lfo(am.gain, o.roughHz ?? 30, o.rough * 0.5, t, end + 0.06);
    g.connect(am);
    tail = am;
  }
  tail.connect(o.dest ?? s.out);
}

/** A pure whistle (marmot): quick rise into f0, then a glide to f1; a little breath around the tone. */
function whistle(s: Sound, t: number, dur: number, f0: number, f1: number, level: number, vib = 0): void {
  const end = t + dur;
  const o = s.osc('sine', f0, t, end + 0.05);
  o.frequency.setValueAtTime(f0 * 0.86, t);
  o.frequency.exponentialRampToValueAtTime(f0, t + Math.min(0.04, dur * 0.25));
  o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), end);
  if (vib) s.lfo(o.frequency, rand(7, 10), f0 * vib, t, end + 0.05);
  const g = s.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.012);
  g.gain.setValueAtTime(level, Math.max(t + 0.013, end - dur * 0.35));
  g.gain.setTargetAtTime(0, Math.max(t + 0.013, end - dur * 0.35), dur * 0.08);
  s.chain(o, g, s.out);
  // breathy edge
  air(s, t, dur, { type: 'bandpass', f: f0, f1, q: 6, level: level * 1.6, attack: 0.01, release: dur * 0.5 });
}

/** Raptor screech: a raspy sawtooth band (2.5–5 kHz) plus rough noise, pitch path f0 → f1. */
function screech(s: Sound, t: number, dur: number, f0: number, f1: number, level: number, rough = 0.6): void {
  const end = t + dur;
  const src = s.osc('sawtooth', f0, t, end + 0.05);
  s.path(src.frequency, t, [[0, f0 * 0.9], [dur * 0.14, f0], [dur, f1]]);
  s.lfo(src.frequency, rand(30, 42), f0 * 0.04 * rough, t, end + 0.05);
  const hp = s.filter('highpass', 1100, 0.7);
  const b1 = s.filter('bandpass', 3000, 1.5);
  const b2 = s.filter('bandpass', 4600, 2.2);
  const g1 = s.gain(1.1);
  const g2 = s.gain(0.7);
  const env = s.gain(0);
  const relStart = Math.max(t + 0.03, end - dur * 0.45);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level, t + 0.025);
  env.gain.setValueAtTime(level, relStart);
  env.gain.setTargetAtTime(0, relStart, dur * 0.1);
  s.chain(src, hp, b1, g1, env);
  s.chain(hp, b2, g2, env);
  env.connect(s.out);
  air(s, t, dur, { type: 'bandpass', f: 3800, q: 1.1, level: level * 0.9 * rough, attack: 0.02, release: dur * 0.45, rough: 0.7, roughHz: 55 });
}

/** Rough low growl (cats, ram): pressed voice with a strong amplitude roll + a subharmonic rumble. */
function growl(
  s: Sound, v: VoiceProfile, t: number, dur: number, f: number, level: number,
  o: { vowel?: VowelPath; roll?: number; rollHz?: number; rise?: number; breath?: number } = {},
): void {
  vocal(s, {
    t, dur, attack: Math.min(0.06, dur * 0.25), release: dur * 0.35,
    f0: [[0, f], [0.5, f * (o.rise ?? 1.08)], [1, f * 0.9]], voice: 1, breath: o.breath ?? 0.35,
    vowel: o.vowel ?? [[0, 'uh'], [1, 'o']], wave: 'pressed', shift: v.tract, jitter: 0.05,
    tremolo: [o.rollHz ?? rand(24, 30), o.roll ?? 0.85], level,
  });
  const sub = s.osc('triangle', f / 2, t, t + dur + 0.05);
  const lp = s.filter('lowpass', 320, 0.8);
  const sg = s.gain(0);
  s.swell(sg.gain, t, level * 0.22, Math.min(0.06, dur * 0.25), dur * 0.4, dur * 0.4);
  s.chain(sub, lp, sg, s.out);
}

/** Cat chuff (prusten): a few soft nasal puffs. Returns the duration. */
function chuff(s: Sound, t: number, pulses: number, level: number, f = 950): number {
  let tt = t;
  for (let i = 0; i < pulses; i++) {
    const k = 1 - i * 0.14;
    hit(s, tt, 'pink', 'bandpass', f * rand(0.88, 1.12), 1.1, level * 3.2 * k, 0.006, 0.055);
    hit(s, tt, 'brown', 'lowpass', 650, 0.7, level * 1.4 * k, 0.005, 0.07);
    tt += rand(0.085, 0.12);
  }
  return tt - t + 0.08;
}

/** Hiss (vulture, lynx spit): bright noise, optionally rattling. */
function hiss(s: Sound, t: number, dur: number, level: number, rough = 0, f = 3200): void {
  air(s, t, dur, { kind: 'white', type: 'highpass', f, q: 0.7, level: level * 0.55, attack: 0.012, release: dur * 0.5, rough, roughHz: rand(26, 34) });
  air(s, t, dur, { kind: 'white', type: 'bandpass', f: f * 1.6, q: 1.3, level: level * 1.1, attack: 0.015, release: dur * 0.55, rough, roughHz: rand(26, 34) });
}

/** Bill clack (vulture). */
function clack(s: Sound, t: number, level: number): void {
  hit(s, t, 'white', 'bandpass', rand(2200, 2800), 5, level * 3, 0.0008, 0.012);
  hit(s, t, 'white', 'highpass', 4200, 0.7, level * 0.5, 0.0005, 0.006);
  const o = s.osc('sine', rand(560, 700), t, t + 0.04);
  const g = s.gain(0);
  s.perc(g.gain, t, level * 0.25, 0.001, 0.02);
  s.chain(o, g, s.out);
}

interface BreathTone {
  /** Formant scale relative to the voice's tract. */
  shift: number;
  inV: readonly VowelId[];
  outV: readonly VowelId[];
  bw: number;
  /** Voicing allowed on strained exhales (0..1). */
  voice: number;
}

/** One breath with a head-specific timbre (nasal for the bovids, light and bright for small heads). */
function toneBreath(s: Sound, v: VoiceProfile, t: number, dur: number, inhale: boolean, level: number, strainAmt: number, b: BreathTone): void {
  const f = v.f0 * rand(0.95, 1.05) * (1 + strainAmt * 0.15);
  vocal(s, {
    t, dur,
    attack: inhale ? dur * 0.45 : dur * 0.14,
    release: inhale ? dur * 0.45 : dur * 0.7,
    f0: [[0, f], [1, f * 0.9]],
    voice: inhale ? 0 : strainAmt * b.voice,
    breath: 1,
    vowel: pick(inhale ? b.inV : b.outV),
    shift: v.tract * b.shift * (inhale ? 1.06 : 1),
    bw: b.bw,
    jitter: 0.02,
    level,
  });
}

/** Long relieved exhale with a given breath timbre. */
function sigh(s: Sound, v: VoiceProfile, t: number, level: number, b: BreathTone, dur = rand(0.8, 1.1)): void {
  vocal(s, {
    t, dur, attack: 0.06, release: dur * 0.75, f0: [[0, v.f0 * 1.02], [1, v.f0 * 0.82]], voice: 0.05 * b.voice, breath: 1,
    breathShape: 'lead', vowel: [[0, b.outV[0]], [1, b.outV[b.outV.length - 1]]], shift: v.tract * b.shift, bw: b.bw * 1.05, level,
  });
}

// Never the same effort style twice in a row (per head).
const lastStyle = new Map<HeadId, string>();
function style<T extends string>(id: HeadId, items: readonly (readonly [T, number])[]): T {
  const prev = lastStyle.get(id);
  const pool = items.length > 1 ? items.filter(([k]) => k !== prev) : items;
  let total = 0;
  for (const [, w] of pool) total += w;
  let r = Math.random() * total;
  let out = pool[pool.length - 1][0];
  for (const [k, w] of pool) {
    r -= w;
    if (r <= 0) {
      out = k;
      break;
    }
  }
  lastStyle.set(id, out);
  return out;
}

/** Per-launch pitch ratio of this voice against its set's base pitch. */
const ratio = (v: VoiceProfile, set: { f0: number }): number => (set.f0 > 0 ? v.f0 / set.f0 : 1);

// ─────────────────────────────── human ───────────────────────────────

const HUMAN_BREATH: BreathTone = { shift: 1, inV: ['e', 'i'], outV: ['o', 'uh', 'a'], bw: 2.1, voice: 0.28 };

const HUMAN: VoiceSet = {
  id: 'human',
  f0: 132,
  tract: 1,
  effort: (s, v, t) => humanEffort(s, v, t),
  strain: (s, v, t) => humanStrain(s, v, t),
  gasp: (s, v, t, level = 0.8) => humanGasp(s, v, t, level),
  whoa: (s, v, t, level = 0.78) => humanWhoa(s, v, t, level),
  breath: (s, v, t, dur, inhale, level, strainAmt) => humanBreath(s, v, t, dur, inhale, level, strainAmt),
  exhale: (s, v, t, level = 0.75) => sigh(s, v, t, level, HUMAN_BREATH),
  call(s, v, t) {
    // "whoo!" — rising, open, a little vibrato
    const f = v.f0 * s.p;
    vocal(s, {
      t, dur: rand(0.48, 0.58), attack: 0.05, release: 0.2, f0: [[0, f * 1.45], [0.45, f * 2.15], [1, f * 1.85]], voice: 1, breath: 0.35,
      breathShape: 'lead', vowel: [[0, 'u'], [0.4, 'o'], [1, 'o']], shift: v.tract, jitter: 0.02, vibrato: [5.5, 0.018], level: 0.62,
    });
  },
};

// ─────────────────────────────── bovids: ibex, chamois, goat, ram ───────────────────────────────

interface BovidSpec {
  id: HeadId;
  f0: number;
  tract: number;
  /** Bleat pitch (Hz). */
  call: number;
  /** Quaver (the bleat's AM/FM flutter): rate Hz, AM depth, FM depth fraction. */
  quaver: number;
  qDepth: number;
  qFm: number;
  /** Breathy hoarseness 0..1. */
  hoarse: number;
  vowel: VowelId;
  /** Snort band (Hz) and Q (a chamois alarm snort is a sharp whistle). */
  snortHz: number;
  snortQ: number;
  callDur: readonly [number, number];
}

const BOVID_BREATH: BreathTone = { shift: 1.05, inV: ['nn', 'e'], outV: ['nn', 'm', 'uh'], bw: 2.3, voice: 0.22 };

function bovid(b: BovidSpec): VoiceSet {
  const snort = (s: Sound, t: number, level: number, dur = rand(0.14, 0.2)): void => {
    air(s, t, dur, { type: 'bandpass', f: b.snortHz * s.p, f1: b.snortHz * s.p * 0.82, q: b.snortQ, level: level * 2.2, attack: 0.008, release: dur * 0.6, rough: 0.5, roughHz: b.quaver * 1.4 });
    air(s, t, dur * 0.8, { kind: 'pink', type: 'lowpass', f: 900, q: 0.7, level: level * 0.9, attack: 0.006, release: dur * 0.5 });
  };
  const bleatVoice = (s: Sound, v: VoiceProfile, t: number, dur: number, f: number, fEnd: number, level: number, open: VowelPath): void => {
    vocal(s, {
      t, dur, attack: 0.03, release: Math.min(0.16, dur * 0.4), f0: [[0, f * 0.94], [0.16, f], [0.8, f * 0.98], [1, fEnd]], voice: 1, breath: b.hoarse,
      breathShape: 'flat', vowel: open, shift: v.tract, bw: 1 + b.hoarse * 0.6, wave: 'glottal', jitter: 0.03,
      vibrato: [b.quaver, b.qFm], tremolo: [b.quaver, b.qDepth], level,
    });
  };
  const set: VoiceSet = {
    id: b.id,
    f0: b.f0,
    tract: b.tract,
    effort(s, v, t) {
      const f = v.f0 * s.p * rand(0.94, 1.08);
      const k = style(b.id, [['snort', 2], ['mmh', 3], ['meh', 2], ['huff', 2]] as const);
      if (k === 'snort') snort(s, t, 0.42);
      else if (k === 'mmh') {
        const dur = rand(0.19, 0.27);
        vocal(s, {
          t, dur, attack: 0.025, release: 0.09, f0: [[0, f * 1.06], [1, f * 0.88]], voice: 1, breath: 0.22, vowel: [[0, 'm'], [0.55, 'nn'], [1, 'm']],
          wave: 'pressed', shift: v.tract, jitter: 0.025, tremolo: [b.quaver, b.qDepth * 0.45], level: 0.95,
        });
      } else if (k === 'meh') {
        const c = b.call * ratio(v, b) * s.p * rand(0.78, 0.86);
        bleatVoice(s, v, t, rand(0.2, 0.28), c, c * 0.8, 0.62, [[0, 'm'], [0.3, b.vowel], [1, b.vowel]]);
      } else {
        const dur = rand(0.2, 0.3);
        vocal(s, { t, dur, attack: 0.016, release: dur * 0.75, f0: [[0, f]], voice: 0, breath: 1, vowel: pick(['nn', 'uh', 'o'] as const), shift: v.tract, bw: 2, level: 0.9 });
        if (chance(0.4)) snort(s, t + dur * 0.55, 0.18, 0.1);
      }
    },
    strain(s, v, t) {
      const f = v.f0 * s.p * rand(1.04, 1.14);
      const d1 = rand(0.7, 0.9);
      vocal(s, {
        t, dur: d1, attack: 0.12, release: 0.12, f0: [[0, f], [0.5, f * 1.22], [1, f * 1.38]], voice: 1, breath: 0.2 + b.hoarse * 0.3,
        vowel: [[0, 'm'], [0.35, 'nn'], [0.72, b.vowel], [1, b.vowel]], wave: 'pressed', shift: v.tract, jitter: 0.03,
        vibrato: [b.quaver, b.qFm * 0.8], tremolo: [b.quaver, b.qDepth], level: 0.6,
      });
      snort(s, t + d1 - 0.03, 0.36, 0.26);
      return d1 + 0.26;
    },
    gasp(s, v, t, level = 0.8) {
      const dur = rand(0.17, 0.23);
      // a low snort band carries less perceived level: even it out across the bovids
      const k = Math.sqrt(1300 / b.snortHz);
      air(s, t, dur, { type: 'bandpass', f: b.snortHz * 0.7 * s.p, f1: b.snortHz * 1.25 * s.p, q: 2.2, level: level * 1.5 * k, attack: dur * 0.3, release: dur * 0.45 });
      vocal(s, { t, dur, attack: 0.03, release: 0.12, f0: [[0, v.f0 * 1.7], [1, v.f0 * 1.9]], voice: 0.1, breath: 1, vowel: [[0, 'nn'], [1, 'i']], shift: v.tract * 1.08, bw: 1.8, level: level * 0.6 });
    },
    whoa(s, v, t, level = 0.78) {
      const c = b.call * ratio(v, b) * s.p;
      bleatVoice(s, v, t, rand(0.42, 0.52), c * 1.12, c * 0.72, level * 0.85, [[0, 'm'], [0.18, b.vowel], [0.7, 'a'], [1, 'a']]);
    },
    breath(s, v, t, dur, inhale, level, strainAmt) {
      toneBreath(s, v, t, dur, inhale, level, strainAmt, BOVID_BREATH);
    },
    exhale(s, v, t, level = 0.75) {
      sigh(s, v, t, level * 1.5, BOVID_BREATH); // nasal: the closed vowels lose level
      if (chance(0.5)) snort(s, t + rand(0.5, 0.7), 0.12, 0.12);
    },
    call(s, v, t) {
      const c = b.call * ratio(v, b) * s.p;
      const dur = rand(b.callDur[0], b.callDur[1]);
      bleatVoice(s, v, t, dur, c, c * 0.84, 0.66, [[0, 'm'], [0.16, b.vowel], [0.85, b.vowel], [1, 'eh']]);
    },
  };
  return set;
}

const IBEX = bovid({ id: 'ibex', f0: 150, tract: 1.1, call: 250, quaver: 19, qDepth: 0.55, qFm: 0.03, hoarse: 0.25, vowel: 'ae', snortHz: 1300, snortQ: 2.4, callDur: [0.55, 0.68] });
const CHAMOIS = bovid({ id: 'chamois', f0: 205, tract: 1.27, call: 365, quaver: 27, qDepth: 0.48, qFm: 0.025, hoarse: 0.7, vowel: 'eh', snortHz: 2700, snortQ: 7, callDur: [0.42, 0.52] });
const GOAT = bovid({ id: 'goat', f0: 185, tract: 1.2, call: 330, quaver: 11, qDepth: 0.85, qFm: 0.045, hoarse: 0.3, vowel: 'e', snortHz: 1600, snortQ: 2.6, callDur: [0.7, 0.85] });
const RAM = bovid({ id: 'ram', f0: 92, tract: 0.84, call: 152, quaver: 14, qDepth: 0.5, qFm: 0.03, hoarse: 0.35, vowel: 'a', snortHz: 720, snortQ: 2, callDur: [0.6, 0.75] });

// ─────────────────────────────── marmot ───────────────────────────────

const SMALL_BREATH: BreathTone = { shift: 1.0, inV: ['i', 'e'], outV: ['e', 'eh', 'uh'], bw: 2.2, voice: 0.12 };

const MARMOT: VoiceSet = {
  id: 'marmot',
  f0: 260,
  tract: 1.5,
  effort(s, v, t) {
    const r = ratio(v, MARMOT) * s.p;
    const k = style('marmot', [['chirp', 3], ['chitter', 2], ['huff', 2]] as const);
    if (k === 'chirp') {
      whistle(s, t, rand(0.06, 0.09), rand(2350, 2650) * r, rand(1800, 2000) * r, 0.22);
      air(s, t, 0.12, { type: 'bandpass', f: 1800, q: 1, level: 0.5, attack: 0.008, release: 0.08 });
    } else if (k === 'chitter') {
      const n = randInt(2, 3);
      for (let i = 0; i < n; i++) whistle(s, t + i * rand(0.06, 0.075), 0.045, (2200 + i * 160) * r, (1900 + i * 120) * r, 0.18);
    } else {
      const dur = rand(0.16, 0.22);
      vocal(s, { t, dur, attack: 0.012, release: dur * 0.7, f0: [[0, v.f0]], voice: 0, breath: 1, vowel: pick(['e', 'eh'] as const), shift: v.tract, bw: 2, level: 0.8 });
      whistle(s, t + dur * 0.6, 0.05, 2500 * r, 2100 * r, 0.12);
    }
  },
  strain(s, v, t) {
    const r = ratio(v, MARMOT) * s.p;
    const n = randInt(6, 8);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const f = (2000 + i * 90) * r;
      whistle(s, tt, 0.055, f, f * 0.86, 0.15 + i * 0.01);
      tt += rand(0.075, 0.095);
    }
    toneBreath(s, v, tt - 0.05, 0.3, false, 0.7, 0.2, SMALL_BREATH);
    return tt - t + 0.3;
  },
  gasp(s, v, t, level = 0.8) {
    const r = ratio(v, MARMOT) * s.p;
    whistle(s, t, 0.11, 1900 * r, 2900 * r, 0.16 * level);
    toneBreath(s, v, t, 0.18, true, level * 0.7, 0, SMALL_BREATH);
  },
  whoa(s, v, t, level = 0.78) {
    const r = ratio(v, MARMOT) * s.p;
    whistle(s, t, rand(0.45, 0.55), 3100 * r, 1500 * r, 0.24 * level, 0.01);
  },
  breath(s, v, t, dur, inhale, level, strainAmt) {
    toneBreath(s, v, t, dur * 0.85, inhale, level * 0.85, strainAmt, SMALL_BREATH);
  },
  exhale(s, v, t, level = 0.75) {
    sigh(s, v, t, level * 0.9, SMALL_BREATH, rand(0.6, 0.8));
  },
  call(s, v, t) {
    // the marmot alarm: a long "fiiiu" and a short echo
    const r = ratio(v, MARMOT) * s.p;
    whistle(s, t, 0.3, 2850 * r, 2150 * r, 0.24, 0.006);
    whistle(s, t + 0.42, 0.13, 2750 * r, 2250 * r, 0.18);
  },
};

// ─────────────────────────────── eagle ───────────────────────────────

const BIRD_BREATH: BreathTone = { shift: 1.0, inV: ['i', 'e'], outV: ['eh', 'e', 'uh'], bw: 2.3, voice: 0.08 };

const EAGLE: VoiceSet = {
  id: 'eagle',
  f0: 300,
  tract: 1.4,
  effort(s, v, t) {
    const r = ratio(v, EAGLE) * s.p;
    const k = style('eagle', [['kyik', 3], ['kak', 2], ['huff', 2]] as const);
    if (k === 'kyik') screech(s, t, rand(0.09, 0.12), 1850 * r, 1500 * r, 0.5, 0.45);
    else if (k === 'kak') {
      screech(s, t, 0.06, 1700 * r, 1550 * r, 0.42, 0.4);
      screech(s, t + rand(0.09, 0.11), 0.06, 1650 * r, 1450 * r, 0.36, 0.4);
    } else {
      const dur = rand(0.18, 0.25);
      vocal(s, { t, dur, attack: 0.014, release: dur * 0.72, f0: [[0, v.f0]], voice: 0, breath: 1, vowel: pick(['eh', 'e'] as const), shift: v.tract, bw: 2.1, level: 0.85 });
    }
  },
  strain(s, v, t) {
    const r = ratio(v, EAGLE) * s.p;
    const d = rand(0.5, 0.62);
    screech(s, t, d, 1600 * r, 1250 * r, 0.27, 0.75);
    toneBreath(s, v, t + d - 0.04, 0.3, false, 0.7, 0.1, BIRD_BREATH);
    return d + 0.3;
  },
  gasp(s, v, t, level = 0.8) {
    const r = ratio(v, EAGLE) * s.p;
    screech(s, t, 0.1, 1500 * r, 2100 * r, 0.3 * level, 0.3);
    toneBreath(s, v, t + 0.02, 0.16, true, level * 0.6, 0, BIRD_BREATH);
  },
  whoa(s, v, t, level = 0.78) {
    const r = ratio(v, EAGLE) * s.p;
    screech(s, t, rand(0.62, 0.75), 2300 * r, 1300 * r, 0.5 * level, 0.8);
  },
  breath(s, v, t, dur, inhale, level, strainAmt) {
    toneBreath(s, v, t, dur, inhale, level * 0.9, strainAmt, BIRD_BREATH);
  },
  exhale(s, v, t, level = 0.75) {
    sigh(s, v, t, level, BIRD_BREATH, rand(0.7, 0.9));
  },
  call(s, v, t) {
    // "kee — eeeer"
    const r = ratio(v, EAGLE) * s.p;
    screech(s, t, 0.13, 2500 * r, 2350 * r, 0.42, 0.5);
    screech(s, t + 0.17, rand(0.6, 0.7), 2400 * r, 1450 * r, 0.48, 0.85);
  },
};

// ─────────────────────────────── vulture ───────────────────────────────

const VULTURE_BREATH: BreathTone = { shift: 1.0, inV: ['i', 'e'], outV: ['uh', 'o', 'eh'], bw: 1.7, voice: 0.12 };

const VULTURE: VoiceSet = {
  id: 'vulture',
  f0: 110,
  tract: 1.2,
  effort(s, v, t) {
    const k = style('vulture', [['hiss', 3], ['croak', 2], ['clack', 2]] as const);
    if (k === 'hiss') hiss(s, t, rand(0.2, 0.28), 0.8, 0.2);
    else if (k === 'croak') {
      growl(s, v, t, rand(0.12, 0.16), v.f0 * s.p * rand(0.95, 1.08), 0.9, { vowel: 'o', roll: 0.6, rollHz: 31, breath: 0.5 });
      hiss(s, t + 0.1, 0.16, 0.6, 0.1);
    } else {
      clack(s, t, 0.75);
      clack(s, t + rand(0.05, 0.07), 0.58);
      hiss(s, t + 0.08, 0.17, 0.66, 0.15);
    }
  },
  strain(s, v, t) {
    const d = rand(0.65, 0.8);
    hiss(s, t, d, 0.7, 0.75);
    growl(s, v, t + 0.05, d * 0.8, v.f0 * s.p, 0.46, { vowel: 'uh', roll: 0.8, rollHz: 30, breath: 0.6 });
    return d + 0.1;
  },
  gasp(s, v, t, level = 0.8) {
    air(s, t, 0.2, { type: 'bandpass', f: 2600 * s.p, f1: 3600 * s.p, q: 4, level: level * 1.6, attack: 0.05, release: 0.1 });
  },
  whoa(s, v, t, level = 0.78) {
    growl(s, v, t, 0.22, v.f0 * s.p * 1.15, 0.78 * level, { vowel: [[0, 'o'], [1, 'a']], roll: 0.6, breath: 0.5 });
    hiss(s, t + 0.16, 0.45, 0.68 * level, 0.35);
  },
  breath(s, v, t, dur, inhale, level, strainAmt) {
    toneBreath(s, v, t, dur, inhale, level, strainAmt, VULTURE_BREATH);
    if (inhale && strainAmt > 0.3) air(s, t, dur, { type: 'bandpass', f: 3200, q: 6, level: level * 0.35 * strainAmt, attack: dur * 0.4, release: dur * 0.4 });
  },
  exhale(s, v, t, level = 0.75) {
    sigh(s, v, t, level, VULTURE_BREATH, rand(0.7, 0.9));
  },
  call(s, v, t) {
    clack(s, t, 1.0);
    clack(s, t + 0.07, 0.8);
    clack(s, t + 0.13, 0.62);
    growl(s, v, t + 0.2, 0.22, v.f0 * s.p, 1.0, { vowel: 'o', roll: 0.7, breath: 0.5 });
    hiss(s, t + 0.36, 0.42, 0.9, 0.3);
  },
};

// ─────────────────────────────── snow leopard ───────────────────────────────

const CAT_BREATH: BreathTone = { shift: 1.0, inV: ['e', 'eh'], outV: ['o', 'uh', 'a'], bw: 2.0, voice: 0.25 };

const SNOWLEOPARD: VoiceSet = {
  id: 'snowleopard',
  f0: 92,
  tract: 0.92,
  effort(s, v, t) {
    const k = style('snowleopard', [['chuff', 3], ['huff-growl', 2], ['grr', 2]] as const);
    if (k === 'chuff') chuff(s, t, randInt(2, 3), 0.75);
    else if (k === 'huff-growl') {
      const d = chuff(s, t, 1, 0.62);
      growl(s, v, t + d * 0.6, rand(0.16, 0.2), v.f0 * s.p, 1.0, { vowel: 'uh', roll: 0.8 });
    } else growl(s, v, t, rand(0.2, 0.26), v.f0 * s.p * rand(0.95, 1.1), 1.05, { vowel: [[0, 'uh'], [1, 'o']], roll: 0.85 });
  },
  strain(s, v, t) {
    const d = rand(0.75, 0.9);
    growl(s, v, t, d, v.f0 * s.p * 1.05, 0.82, { vowel: [[0, 'uh'], [0.6, 'o'], [1, 'a']], roll: 0.9, rise: 1.2 });
    const c = chuff(s, t + d - 0.05, 2, 0.56);
    return d + c;
  },
  gasp(s, v, t, level = 0.8) {
    air(s, t, 0.18, { kind: 'pink', type: 'bandpass', f: 800 * s.p, f1: 1500 * s.p, q: 1.6, level: level * 2.4, attack: 0.05, release: 0.09 });
  },
  whoa(s, v, t, level = 0.78) {
    growl(s, v, t, rand(0.45, 0.55), v.f0 * s.p * 1.5, 0.9 * level, { vowel: [[0, 'a'], [0.6, 'o'], [1, 'u']], roll: 0.7, rise: 1.3 });
  },
  breath(s, v, t, dur, inhale, level, strainAmt) {
    toneBreath(s, v, t, dur, inhale, level, strainAmt, CAT_BREATH);
  },
  exhale(s, v, t, level = 0.75) {
    chuff(s, t, 1, 0.22 * level);
    sigh(s, v, t + 0.08, level * 0.85, CAT_BREATH, rand(0.75, 0.95));
  },
  call(s, v, t) {
    // a low moaning yowl, then a soft chuff
    const f = v.f0 * s.p * 1.7;
    vocal(s, {
      t, dur: rand(0.85, 0.95), attack: 0.08, release: 0.3, f0: [[0, f * 0.95], [0.4, f * 1.45], [1, f * 0.9]], voice: 1, breath: 0.35,
      vowel: [[0, 'm'], [0.2, 'a'], [0.6, 'o'], [1, 'u']], wave: 'glottal', shift: v.tract, jitter: 0.04, vibrato: [5.5, 0.02], tremolo: [24, 0.25], level: 0.62,
    });
    chuff(s, t + 1.0, 2, 0.3);
  },
};

// ─────────────────────────────── lynx ───────────────────────────────

const LYNX: VoiceSet = {
  id: 'lynx',
  f0: 122,
  tract: 1.05,
  effort(s, v, t) {
    const k = style('lynx', [['spit', 2], ['grr', 3], ['mrr', 2]] as const);
    if (k === 'spit') {
      hit(s, t, 'white', 'highpass', 2800, 0.7, 0.9, 0.003, 0.11);
      hit(s, t, 'white', 'bandpass', 5200, 1.2, 1.4, 0.002, 0.07);
    } else if (k === 'grr') growl(s, v, t, rand(0.18, 0.24), v.f0 * s.p * rand(0.95, 1.1), 0.72, { vowel: 'uh', roll: 0.9, rollHz: rand(30, 36) });
    else {
      vocal(s, {
        t, dur: rand(0.2, 0.26), attack: 0.03, release: 0.1, f0: [[0, v.f0 * s.p * 1.6], [1, v.f0 * s.p * 1.35]], voice: 1, breath: 0.3,
        vowel: [[0, 'm'], [0.5, 'uh'], [1, 'uh']], wave: 'pressed', shift: v.tract, jitter: 0.04, tremolo: [32, 0.7], level: 0.75,
      });
    }
  },
  strain(s, v, t) {
    const d = rand(0.6, 0.75);
    growl(s, v, t, d, v.f0 * s.p * 1.08, 0.76, { vowel: [[0, 'uh'], [0.7, 'eh'], [1, 'eh']], roll: 0.9, rollHz: 33, rise: 1.25 });
    hiss(s, t + d - 0.06, 0.22, 0.55, 0);
    return d + 0.2;
  },
  gasp(s, v, t, level = 0.8) {
    hit(s, t, 'white', 'highpass', 3000, 0.7, 0.95 * level, 0.02, 0.12);
    toneBreath(s, v, t, 0.18, true, level * 0.6, 0, CAT_BREATH);
  },
  whoa(s, v, t, level = 0.78) {
    const f = v.f0 * s.p * 2.4;
    vocal(s, {
      t, dur: rand(0.45, 0.55), attack: 0.04, release: 0.16, f0: [[0, f], [0.3, f * 1.2], [1, f * 0.7]], voice: 1, breath: 0.4,
      vowel: [[0, 'ae'], [0.5, 'o'], [1, 'u']], wave: 'pressed', shift: v.tract, jitter: 0.04, vibrato: [6, 0.02], level: 0.66 * level,
    });
  },
  breath(s, v, t, dur, inhale, level, strainAmt) {
    toneBreath(s, v, t, dur, inhale, level, strainAmt, CAT_BREATH);
  },
  exhale(s, v, t, level = 0.75) {
    sigh(s, v, t, level, CAT_BREATH, rand(0.7, 0.9));
  },
  call(s, v, t) {
    // "mrrrOW": a rolled onset opening into a high yowl
    const f = v.f0 * s.p * 2.1;
    vocal(s, {
      t, dur: rand(0.66, 0.76), attack: 0.05, release: 0.2, f0: [[0, f * 0.95], [0.38, f * 1.5], [1, f * 0.85]], voice: 1, breath: 0.3,
      vowel: [[0, 'm'], [0.22, 'ae'], [0.6, 'o'], [1, 'u']], wave: 'glottal', shift: v.tract, jitter: 0.035, vibrato: [6.5, 0.02], tremolo: [30, 0.35], level: 0.62,
    });
  },
};

// ─────────────────────────────── registry ───────────────────────────────

export const VOICE_SETS: Readonly<Record<HeadId, VoiceSet>> = {
  human: HUMAN,
  ibex: IBEX,
  chamois: CHAMOIS,
  goat: GOAT,
  ram: RAM,
  marmot: MARMOT,
  eagle: EAGLE,
  vulture: VULTURE,
  snowleopard: SNOWLEOPARD,
  lynx: LYNX,
};

export const VOICE_IDS = Object.keys(VOICE_SETS) as HeadId[];

/** The voice set for a profile (an unknown or missing species sounds human). */
export function voiceSet(v: VoiceProfile): VoiceSet {
  return (v.species && VOICE_SETS[v.species]) || HUMAN;
}

/** A voice profile for `head`, with an optional per-launch variation (pitch / tract multipliers). */
export function voiceFor(head: HeadId, vary: { f0: number; tract: number } = { f0: 1, tract: 1 }): VoiceProfile {
  const set = VOICE_SETS[head] ?? HUMAN;
  return { species: set.id, f0: set.f0 * vary.f0, tract: set.tract * vary.tract };
}

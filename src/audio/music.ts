// Generative ambient music. Two tracks with lookahead scheduling and crossfades:
//
//  · MENU  — warm, spacious, alpine: detuned wavetable pads moving slowly through a Markov chain
//            around Dmaj9 → Bm11 → Gmaj7 → A6sus (with Em9 / F#m7 substitutions), voice-led
//            voicings, a soft sub, plucked pentatonic fragments with ping-pong echoes, rare high
//            bells and an airy wind layer.
//  · CLIMB — minimal and focused at 84 bpm: a soft pulse with pad ducking, sub bass, sparse
//            plucked motifs, offbeat ticks, and a pad low-pass that slowly opens over the climb.
//
// Tracks are time-agnostic: `tick(now)` schedules every event up to now + LOOKAHEAD, so the same
// code runs in a live AudioContext (ticked by the Clock) or offline (ticked in a loop).

import { Sound, type Dest } from './sound';
import { cents, chance, clamp, mtof, pick, rand, weighted } from './util';

export type TrackId = 'menu' | 'climb';
export type MusicChoice = TrackId | 'none';

const LOOKAHEAD = 0.35;

// ─────────────────────────────── harmony ───────────────────────────────

interface Chord {
  /** Root pitch class (0 = C). */
  root: number;
  pcs: readonly number[];
}

const D = 2, E = 4, Fs = 6, G = 7, A = 9, B = 11, Cs = 1;

const MENU_CHORDS = {
  Dmaj9: { root: D, pcs: [D, Fs, A, Cs, E] },
  Bm11: { root: B, pcs: [B, D, Fs, A, E] },
  Gmaj7: { root: G, pcs: [G, B, D, Fs, A] },
  A6sus: { root: A, pcs: [A, D, E, Fs] },
  Em9: { root: E, pcs: [E, G, B, D, Fs] },
  Fsm7: { root: Fs, pcs: [Fs, A, Cs, E] },
} as const satisfies Record<string, Chord>;
type MenuChord = keyof typeof MENU_CHORDS;

const MENU_NEXT: Record<MenuChord, readonly (readonly [MenuChord, number])[]> = {
  Dmaj9: [['Bm11', 0.7], ['Gmaj7', 0.2], ['Em9', 0.1]],
  Bm11: [['Gmaj7', 0.65], ['Em9', 0.2], ['Fsm7', 0.15]],
  Gmaj7: [['A6sus', 0.75], ['Bm11', 0.15], ['Em9', 0.1]],
  A6sus: [['Dmaj9', 0.85], ['Bm11', 0.15]],
  Em9: [['A6sus', 0.6], ['Gmaj7', 0.4]],
  Fsm7: [['Gmaj7', 0.7], ['Bm11', 0.3]],
};

const CLIMB_CHORDS = {
  Bm9: { root: B, pcs: [B, D, Fs, A, Cs] },
  Gmaj9: { root: G, pcs: [G, B, D, Fs, A] },
  Em9: { root: E, pcs: [E, G, B, D, Fs] },
  Dadd9: { root: D, pcs: [D, Fs, A, E] },
  Aadd9: { root: A, pcs: [A, Cs, E, B] },
  Fsm11: { root: Fs, pcs: [Fs, A, B, E] },
} as const satisfies Record<string, Chord>;
type ClimbChord = keyof typeof CLIMB_CHORDS;

const CLIMB_NEXT: Record<ClimbChord, readonly (readonly [ClimbChord, number])[]> = {
  Bm9: [['Gmaj9', 0.6], ['Em9', 0.25], ['Dadd9', 0.15]],
  Gmaj9: [['Dadd9', 0.4], ['Em9', 0.3], ['Fsm11', 0.3]],
  Em9: [['Fsm11', 0.4], ['Bm9', 0.35], ['Gmaj9', 0.25]],
  Dadd9: [['Aadd9', 0.5], ['Em9', 0.3], ['Bm9', 0.2]],
  Aadd9: [['Bm9', 0.6], ['Gmaj9', 0.4]],
  Fsm11: [['Bm9', 0.75], ['Gmaj9', 0.25]],
};

/** Pentatonic (D major = B minor) melody pool between lo and hi. */
function scalePool(lo: number, hi: number): number[] {
  const pcs = [D, E, Fs, A, B];
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(((m % 12) + 12) % 12)) out.push(m);
  return out;
}

/** Pick a voicing of `pcs` within [lo, hi] that moves smoothly from `prev`. */
function voiceLead(pcs: readonly number[], prev: readonly number[], lo: number, hi: number): number[] {
  let best: number[] = [];
  let bestScore = Infinity;
  const centre = (lo + hi) / 2;
  for (let k = 0; k < 60; k++) {
    const notes: number[] = [];
    for (const pc of pcs) {
      const cands: number[] = [];
      for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc) cands.push(m);
      notes.push(pick(cands));
    }
    notes.sort((a, b) => a - b);
    let ok = true;
    for (let i = 1; i < notes.length; i++) {
      const iv = notes[i] - notes[i - 1];
      if (iv < 2 || (notes[i - 1] < 57 && iv < 5)) ok = false;
    }
    if (!ok) continue;
    let score = 0;
    if (prev.length) {
      for (const n of notes) {
        let d = Infinity;
        for (const p of prev) d = Math.min(d, Math.abs(n - p));
        score += d;
      }
    } else {
      score = Math.abs(notes.reduce((a, b) => a + b, 0) / notes.length - centre);
    }
    score += notes[notes.length - 1] - notes[0] > 20 ? 4 : 0; // keep it compact
    score += rand(0, 2.5); // variety
    if (score < bestScore) {
      bestScore = score;
      best = notes;
    }
  }
  if (!best.length) {
    // Fallback: close position from the lowest available root.
    let base = lo;
    while (((base % 12) + 12) % 12 !== pcs[0]) base++;
    best = pcs.map((pc) => {
      let m = base;
      while (((m % 12) + 12) % 12 !== pc) m++;
      return m;
    }).sort((a, b) => a - b);
  }
  return best;
}

function nearestChordTone(pool: readonly number[], m: number, chord: Chord): number {
  let best = m;
  let bd = Infinity;
  for (const n of pool) {
    if (!chord.pcs.includes(n % 12)) continue;
    const d = Math.abs(n - m);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

// ─────────────────────────────── instruments ───────────────────────────────

interface PadOpts {
  level: number;
  attack: number;
  release: number;
  cutoff: number;
  detune?: number;
  spread?: number;
  send?: number;
}

/** Detuned wavetable pad chord with a slow filter bloom. */
function padChord(ctx: BaseAudioContext, dest: Dest, t: number, notes: readonly number[], dur: number, o: PadOpts): Sound {
  const s = new Sound(ctx, dest, t, { gain: o.level, send: o.send ?? 0 });
  const end = t + dur + o.release;
  const lp = s.filter('lowpass', o.cutoff * 0.55, 0.6);
  lp.frequency.setValueAtTime(o.cutoff * 0.55, t);
  lp.frequency.linearRampToValueAtTime(o.cutoff, t + o.attack * 1.2);
  lp.frequency.linearRampToValueAtTime(o.cutoff * 0.75, t + dur);
  s.lfo(lp.frequency, rand(0.05, 0.11), o.cutoff * 0.12, t, end);
  const env = s.gain(0);
  s.swell(env.gain, t, 1, o.attack, Math.max(0, dur - o.attack), o.release);
  s.chain(lp, env, s.out);
  const det = o.detune ?? 7;
  const spread = o.spread ?? 0.55;
  const per = 1 / Math.sqrt(notes.length * 2);
  for (const m of notes) {
    for (const side of [-1, 1]) {
      const osc = s.osc('warm', mtof(m) * cents(side * det + rand(-2.5, 2.5)), t, end);
      const g = s.gain(per * rand(0.85, 1));
      s.chain(osc, g, s.panner(side * spread * rand(0.6, 1)), lp);
    }
  }
  s.finish();
  return s;
}

interface PluckOpts {
  level: number;
  bright: number;
  decay: number;
  pan: number;
  send: number;
}

/** Soft plucked note (wavetable + closing low-pass + glassy octave). */
function pluck(ctx: BaseAudioContext, dest: Dest, t: number, midi: number, vel: number, o: PluckOpts): Sound {
  const f = mtof(midi);
  const s = new Sound(ctx, dest, t, { gain: o.level * vel, pan: o.pan, send: o.send });
  const osc = s.osc('pluck', f, t, t + o.decay + 0.05);
  const lp = s.filter('lowpass', o.bright, 1.1);
  s.glide(lp.frequency, t, Math.min(o.bright * (0.6 + vel * 0.6), 12000), Math.max(f * 1.4, 380), 0.45);
  const g = s.gain(0);
  s.perc(g.gain, t, 1, 0.003, o.decay);
  s.chain(osc, lp, g, s.out);
  const o2 = s.osc('sine', f * 2, t, t + 0.45);
  const g2 = s.gain(0);
  s.perc(g2.gain, t, 0.12 * vel, 0.002, 0.35);
  s.chain(o2, g2, s.out);
  s.finish();
  return s;
}

/** Distant FM bell. */
function bellNote(ctx: BaseAudioContext, dest: Dest, t: number, midi: number, level: number, pan: number, send: number): Sound {
  const f = mtof(midi);
  const s = new Sound(ctx, dest, t, { gain: level, pan, send });
  const decay = rand(2, 3);
  const car = s.osc('sine', f, t, t + decay + 0.05);
  const mod = s.osc('sine', f * 3, t, t + decay + 0.05);
  const idx = s.gain(0);
  s.perc(idx.gain, t, f * 1.2, 0.002, decay * 0.4);
  mod.connect(idx);
  idx.connect(car.frequency);
  const g = s.gain(0);
  s.perc(g.gain, t, 1, 0.004, decay);
  s.chain(car, g, s.out);
  s.finish();
  return s;
}

/** Sustained sub bass note ('soft' wavetable so it still reads on small speakers). */
function subNote(ctx: BaseAudioContext, dest: Dest, t: number, midi: number, dur: number, level: number, attack: number, release: number): Sound {
  const s = new Sound(ctx, dest, t, { gain: level });
  const o = s.osc('soft', mtof(midi), t, t + dur + release);
  const lp = s.filter('lowpass', 420, 0.7);
  const g = s.gain(0);
  s.swell(g.gain, t, 1, attack, Math.max(0, dur - attack), release);
  s.chain(o, lp, g, s.out);
  s.finish();
  return s;
}

/** Soft low pulse ("felt kick"). */
function pulse(ctx: BaseAudioContext, dest: Dest, t: number, level: number): Sound {
  const s = new Sound(ctx, dest, t, { gain: level });
  const o = s.osc('sine', 64, t, t + 0.4);
  s.glide(o.frequency, t, 64, 43, 0.09);
  const g = s.gain(0);
  s.perc(g.gain, t, 1, 0.005, 0.3);
  const drive = s.gain(1.4);
  const sh = s.shaper(1.5);
  const post = s.gain(0.6);
  s.chain(o, g, drive, sh, post, s.out);
  const n = s.noise('pink', t, t + 0.04);
  const lp = s.filter('lowpass', 1100, 0.7);
  const ng = s.gain(0);
  s.perc(ng.gain, t, 0.12, 0.001, 0.012);
  s.chain(n, lp, ng, s.out);
  s.finish();
  return s;
}

/** Muted offbeat tick. */
function tick(ctx: BaseAudioContext, dest: Dest, t: number, level: number, pan: number): Sound {
  const s = new Sound(ctx, dest, t, { gain: level, pan });
  const n = s.noise('white', t, t + 0.05);
  const hp = s.filter('highpass', 6500, 0.7);
  const bp = s.filter('peaking', 9000, 1, 4);
  const g = s.gain(0);
  s.perc(g.gain, t, 1, 0.001, 0.03);
  s.chain(n, hp, bp, g, s.out);
  s.finish();
  return s;
}

/** Slow glassy sustained note. */
function glass(ctx: BaseAudioContext, dest: Dest, t: number, midi: number, dur: number, level: number, pan: number, send: number): Sound {
  const s = new Sound(ctx, dest, t, { gain: level, pan, send });
  const f = mtof(midi);
  const o1 = s.osc('hollow', f, t, t + dur + 2);
  const o2 = s.osc('sine', f * cents(5), t, t + dur + 2);
  const g = s.gain(0);
  s.swell(g.gain, t, 1, dur * 0.4, dur * 0.2, 2);
  const g2 = s.gain(0.5);
  s.chain(o1, g, s.out);
  s.chain(o2, g2, g);
  s.finish();
  return s;
}

// ─────────────────────────────── tracks ───────────────────────────────

abstract class Track {
  /** Track bus: `out` = pre-fader mix, `fader` = crossfade. Also owns the delay network. */
  protected readonly bus: Sound;
  /** Where notes go: dry → mix, wet → ping-pong delay. */
  protected readonly notes: Dest;
  protected readonly sounds = new Set<Sound>();
  protected nextT = 0;
  protected step = 0;
  protected startT = 0;
  protected stopAt = Infinity;
  protected abstract readonly stepDur: number;

  constructor(
    protected readonly ctx: BaseAudioContext,
    dest: Dest,
    t: number,
    verb: number,
    delayTime: number,
    feedback: number,
    tone: number,
  ) {
    this.bus = new Sound(ctx, dest, t, { gain: 1, send: verb });
    this.bus.fader.gain.value = 0;
    // Ping-pong delay: mono in → L delay → R delay → (filtered) feedback → L.
    const b = this.bus;
    const inp = b.gain(1);
    inp.channelCount = 1;
    inp.channelCountMode = 'explicit';
    inp.channelInterpretation = 'speakers';
    const dl = b.delay(delayTime);
    const dr = b.delay(delayTime);
    const lp = b.filter('lowpass', tone, 0.5);
    const hp = b.filter('highpass', 240, 0.5);
    const fb = b.gain(feedback);
    const merger = b.reg(ctx.createChannelMerger(2));
    const ret = b.gain(0.85);
    inp.connect(dl);
    dl.connect(merger, 0, 0);
    dl.connect(dr);
    dr.connect(merger, 0, 1);
    dr.connect(lp);
    lp.connect(hp);
    hp.connect(fb);
    fb.connect(dl);
    merger.connect(ret);
    ret.connect(b.out);
    this.notes = { dry: b.out, wet: inp };
  }

  start(t: number, fadeIn: number): void {
    this.startT = t;
    this.nextT = t;
    this.step = 0;
    this.bus.fader.gain.setValueAtTime(0, t);
    this.bus.fader.gain.setTargetAtTime(1, t, fadeIn / 3);
    this.onStart(t);
  }

  stop(t: number, fadeOut: number): void {
    if (this.stopAt !== Infinity) return;
    this.bus.fadeTo(0, t, fadeOut / 4.5);
    this.stopAt = t + fadeOut;
  }

  /** Schedule ahead; returns false once the track has fully stopped and released. */
  tick(now: number): boolean {
    if (now >= this.stopAt) {
      for (const s of this.sounds) s.kill(now, 0.05);
      this.sounds.clear();
      this.bus.release(now + 0.1);
      return false;
    }
    if (this.nextT < now - 0.08) {
      // Resync after a stall/suspend: skip missed steps instead of bursting them out.
      const missed = Math.ceil((now - this.nextT) / this.stepDur);
      this.step += missed;
      this.nextT += missed * this.stepDur;
    }
    const horizon = Math.min(now + LOOKAHEAD, this.stopAt);
    while (this.nextT < horizon) {
      this.onStep(this.nextT, this.step);
      this.step++;
      this.nextT = this.startT + this.step * this.stepDur;
    }
    return true;
  }

  protected keep(s: Sound): void {
    if (s.isDone) return;
    this.sounds.add(s);
    s.onDone = () => this.sounds.delete(s);
  }

  protected abstract onStart(t: number): void;
  protected abstract onStep(t: number, step: number): void;
}

class MenuTrack extends Track {
  protected readonly stepDur = 60 / 72 / 2; // 8th notes at 72 bpm
  private chordName: MenuChord = 'Dmaj9';
  private chordEnd = 0;
  private voicing: number[] = [];
  private readonly melody = new Map<number, { m: number; v: number }[]>();
  private readonly pool = scalePool(69, 88);
  private lastNote = 78;
  private lastPhraseBar = -10;

  constructor(ctx: BaseAudioContext, dest: Dest, t: number) {
    super(ctx, dest, t, 0.32, (60 / 72) * 0.75, 0.38, 2600);
  }

  protected onStart(t: number): void {
    // Alpine air: slowly moving band of pink noise.
    const b = this.bus;
    const n = b.noise('pink', t);
    const bp = b.filter('bandpass', 2600, 0.5);
    const g = b.gain(0.03);
    b.lfo(g.gain, 0.05, 0.016, t);
    b.lfo(bp.frequency, 0.031, 900, t);
    b.chain(n, bp, g, b.out);
  }

  protected onStep(t: number, i: number): void {
    if (i >= this.chordEnd) this.nextChord(t, i);
    if (i % 8 === 0) this.planBar(i);
    const ns = this.melody.get(i);
    if (ns) {
      this.melody.delete(i);
      for (const n of ns) {
        this.keep(pluck(this.ctx, this.notes, t + rand(-0.004, 0.012), n.m, n.v, {
          level: 0.11, bright: 4200, decay: rand(1.3, 1.9), pan: rand(-0.35, 0.35), send: rand(0.25, 0.45),
        }));
      }
    }
    if (i > 16 && i % 2 === 1 && chance(0.012)) {
      const chord = MENU_CHORDS[this.chordName];
      const m = 86 + ((pick(chord.pcs) - 2 + 12) % 12);
      this.keep(bellNote(this.ctx, this.notes, t, m, 0.03, rand(-0.6, 0.6), 0.6));
    }
  }

  private nextChord(t: number, i: number): void {
    if (i > 0) this.chordName = weighted(MENU_NEXT[this.chordName]);
    const chord = MENU_CHORDS[this.chordName];
    const bars = i === 0 ? 2 : chance(0.22) ? 3 : 2;
    const steps = bars * 8;
    this.chordEnd = i + steps;
    const dur = steps * this.stepDur;
    this.voicing = voiceLead(chord.pcs, this.voicing, 50, 76);
    this.keep(padChord(this.ctx, this.notes, t, this.voicing, dur + 0.5, {
      level: 0.16, attack: i === 0 ? 3 : 2.2, release: 3.2, cutoff: rand(1100, 1700), send: 0.06,
    }));
    const bass = 38 + ((chord.root - 2 + 12) % 12);
    this.keep(subNote(this.ctx, { dry: this.notes.dry }, t, bass, dur, 0.085, 1.4, 2.4));
    // Occasionally a high glassy colour tone.
    if (i > 0 && chance(0.25)) {
      const m = 81 + ((pick(chord.pcs) - 9 + 12) % 12);
      this.keep(glass(this.ctx, this.notes, t + rand(0.5, 2), m, dur * 0.7, 0.025, rand(-0.5, 0.5), 0.5));
    }
  }

  private planBar(i: number): void {
    const bar = i / 8;
    if (bar < 1) return;
    const p = bar - this.lastPhraseBar <= 1 ? 0.22 : 0.55;
    if (!chance(p)) return;
    this.lastPhraseBar = bar;
    const rhythm = pick(MENU_RHYTHMS);
    const chord = MENU_CHORDS[this.chordName];
    let idx = this.pool.reduce((bi, m, k) => (Math.abs(m - this.lastNote) < Math.abs(this.pool[bi] - this.lastNote) ? k : bi), 0);
    rhythm.forEach((pos, k) => {
      idx = clamp(idx + pick(MENU_STEPS), 0, this.pool.length - 1);
      let m = this.pool[idx];
      if (k === rhythm.length - 1 || k === 0) m = nearestChordTone(this.pool, m, chord);
      const v = (k === 0 ? 0.85 : 0.6) * rand(0.75, 1.05);
      const list = this.melody.get(i + pos) ?? [];
      list.push({ m, v });
      this.melody.set(i + pos, list);
      this.lastNote = m;
    });
    // Sometimes answer the phrase an octave lower in the next bar's tail.
    if (chance(0.18)) {
      const echoPos = i + 8 + pick([4, 5, 6]);
      const m = this.lastNote - 12 >= 62 ? this.lastNote - 12 : this.lastNote;
      const list = this.melody.get(echoPos) ?? [];
      list.push({ m, v: 0.45 });
      this.melody.set(echoPos, list);
    }
  }
}

const MENU_RHYTHMS: readonly (readonly number[])[] = [
  [0, 2],
  [0, 3, 4],
  [1, 2, 4],
  [0, 1, 2, 4],
  [2, 3, 6],
  [0, 4, 5],
  [3, 4, 6],
  [0, 2, 3, 6],
  [0, 6],
];
const MENU_STEPS = [-2, -1, -1, 0, 1, 1, 2, 3, -3] as const;

class ClimbTrack extends Track {
  protected readonly stepDur = 60 / 84 / 4; // 16ths at 84 bpm
  private chordName: ClimbChord = 'Bm9';
  private chordEnd = 0;
  private voicing: number[] = [];
  private readonly pool = scalePool(66, 83);
  private lastNote = 74;
  private motif: number[] | null = null;
  private readonly plucks = new Map<number, { m: number; v: number }>();
  private padBus: GainNode | null = null;
  private padLp: BiquadFilterNode | null = null;
  /** Bars left in a sparse "breathing" section (pulse thins out, ticks rest). */
  private sparse = 0;

  constructor(ctx: BaseAudioContext, dest: Dest, t: number) {
    super(ctx, dest, t, 0.24, (60 / 84) * 0.75, 0.32, 2100);
  }

  protected onStart(t: number): void {
    const b = this.bus;
    this.padBus = b.gain(1);
    this.padLp = b.filter('lowpass', 420, 0.9);
    this.padLp.frequency.setValueAtTime(420, t);
    b.chain(this.padBus, this.padLp, b.out);
  }

  private get elapsed(): number {
    return Math.max(0, this.nextT - this.startT);
  }

  protected onStep(t: number, i: number): void {
    if (i >= this.chordEnd) this.nextChord(t, i);
    const inBar = i % 16;
    const open = 1 - Math.exp(-this.elapsed / 150);
    if (inBar === 0) {
      const bar = i / 16;
      if (this.sparse > 0) this.sparse--;
      else if (bar >= 8 && bar % 8 === 0 && chance(0.35)) this.sparse = 2;
      this.planBar(i);
      const cut = (420 + 1900 * open) * (1 + 0.08 * Math.sin(bar * 0.7));
      this.padLp?.frequency.setTargetAtTime(cut, t, 1.5);
    }
    if (i % 4 === 0 && (this.sparse === 0 || inBar === 0)) {
      const lvl = (inBar === 0 ? 1 : inBar === 8 ? 0.8 : 0.58) * (this.sparse > 0 ? 0.7 : 1);
      this.keep(pulse(this.ctx, { dry: this.notes.dry }, t, 0.17 * lvl));
      if (this.padBus) {
        // Gentle sidechain-style breathing of the pads.
        this.padBus.gain.setValueAtTime(0.8, t);
        this.padBus.gain.setTargetAtTime(1, t + 0.02, 0.14);
      }
    }
    if (i % 4 === 2 && i >= 32 && this.sparse === 0 && chance(0.3 + 0.4 * open)) {
      this.keep(tick(this.ctx, { dry: this.notes.dry }, t + rand(0, 0.006), rand(0.025, 0.04), rand(-0.3, 0.3)));
    }
    const n = this.plucks.get(i);
    if (n) {
      this.plucks.delete(i);
      this.keep(pluck(this.ctx, this.notes, t + rand(-0.003, 0.008), n.m, n.v, {
        level: 0.1, bright: 2400 + 1800 * open, decay: rand(0.9, 1.4), pan: rand(-0.4, 0.4), send: rand(0.3, 0.5),
      }));
    }
  }

  private nextChord(t: number, i: number): void {
    if (i > 0) this.chordName = weighted(CLIMB_NEXT[this.chordName]);
    const chord = CLIMB_CHORDS[this.chordName];
    const bars = i === 0 ? 4 : chance(0.25) ? 2 : 4;
    const steps = bars * 16;
    this.chordEnd = i + steps;
    const dur = steps * this.stepDur;
    this.voicing = voiceLead(chord.pcs, this.voicing, 50, 74);
    if (this.padBus) {
      this.keep(padChord(this.ctx, { dry: this.padBus, wet: this.notes.wet }, t, this.voicing, dur + 0.4, {
        level: 0.17, attack: i === 0 ? 2.5 : 1.6, release: 2.6, cutoff: 2600, detune: 9, spread: 0.6, send: 0.05,
      }));
    }
    const bass = 35 + ((chord.root - 11 + 12) % 12);
    this.keep(subNote(this.ctx, { dry: this.notes.dry }, t, bass, dur, 0.11, 0.6, 1.6));
    if (i > 0 && chance(0.35)) {
      const m = 83 + ((pick(chord.pcs) - 11 + 12) % 12);
      this.keep(glass(this.ctx, this.notes, t + rand(0.3, 1.5), m, dur * 0.5, 0.02, rand(-0.5, 0.5), 0.55));
    }
  }

  private planBar(i: number): void {
    const bar = i / 16;
    if (bar < 2) return;
    if (!chance(0.55)) {
      if (chance(0.5)) this.motif = null;
      return;
    }
    const chord = CLIMB_CHORDS[this.chordName];
    const rhythm = pick(CLIMB_RHYTHMS);
    // Re-use the last motif's contour now and then, so ideas recur.
    const reuse = this.motif !== null && this.motif.length === rhythm.length && chance(0.45);
    const notes: number[] = [];
    let idx = this.pool.indexOf(nearestChordTone(this.pool, this.lastNote, chord));
    if (idx < 0) idx = Math.floor(this.pool.length / 2);
    rhythm.forEach((pos, k) => {
      let m: number;
      if (reuse && this.motif) m = this.motif[k];
      else {
        idx = clamp(idx + pick(CLIMB_STEPS), 0, this.pool.length - 1);
        m = this.pool[idx];
        if (k === 0) m = nearestChordTone(this.pool, m, chord);
      }
      notes.push(m);
      this.plucks.set(i + pos, { m, v: (k === 0 ? 0.8 : 0.55) * rand(0.8, 1.05) });
      this.lastNote = m;
    });
    this.motif = notes;
  }
}

const CLIMB_RHYTHMS: readonly (readonly number[])[] = [
  [0, 6, 10],
  [0, 3, 8],
  [2, 8, 14],
  [0, 10],
  [4, 7, 12],
  [0, 6, 8, 14],
  [3, 11],
  [0, 2, 8],
  [6, 12],
];
const CLIMB_STEPS = [-2, -1, 0, 1, 1, 2, -1] as const;

// ─────────────────────────────── player ───────────────────────────────

/** Owns the current track and crossfades between tracks. */
export class MusicPlayer {
  private current: Track | null = null;
  private currentId: MusicChoice = 'none';
  private readonly fading = new Set<Track>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: Dest,
  ) {}

  get track(): MusicChoice {
    return this.currentId;
  }

  get busy(): boolean {
    return this.current !== null || this.fading.size > 0;
  }

  set(id: MusicChoice, now: number): void {
    if (id === this.currentId) return;
    if (this.current) {
      this.current.stop(now, id === 'none' ? 2.2 : 2.8);
      this.fading.add(this.current);
      this.current = null;
    }
    this.currentId = id;
    if (id === 'none') return;
    const t = now + 0.05;
    const tr = id === 'menu' ? new MenuTrack(this.ctx, this.dest, t) : new ClimbTrack(this.ctx, this.dest, t);
    tr.start(t, id === 'menu' ? 3.2 : 2.4);
    this.current = tr;
  }

  tick(now: number): boolean {
    if (this.current) this.current.tick(now);
    for (const f of this.fading) if (!f.tick(now)) this.fading.delete(f);
    return this.busy;
  }

  /** Immediately fade out and release everything. */
  stopAll(now: number): void {
    this.set('none', now);
  }
}

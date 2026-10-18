// Indoor bouldering-gym room tone: HVAC rumble, room air and vent hiss from filtered noise,
// plus occasional distant, reverberant events — a far-off crash-pad thump, a muffled carabiner
// clink, a chalk clap, a faint murmur of voices (band-passed noise syllables). Very subtle.

import { Sound, type Dest } from './sound';
import { chance, clamp, pick, rand, randInt, weighted } from './util';

const LOOKAHEAD = 0.3;

type AmbEvent = 'pad' | 'clink' | 'murmur' | 'clap';

export class Ambience {
  private tone: Sound | null = null;
  private on = false;
  private nextEvent = -1;
  private lastEvent: AmbEvent | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: Dest,
  ) {}

  get active(): boolean {
    return this.on;
  }

  start(now: number): void {
    if (this.on) return;
    this.on = true;
    this.nextEvent = now + rand(2.5, 5);
    const s = new Sound(this.ctx, { dry: this.dest.dry }, now, { gain: 1 });
    s.fader.gain.value = 0;
    // HVAC rumble.
    const b = s.noise('brown', now);
    const blp = s.filter('lowpass', 220, 0.5);
    const bg = s.gain(0.09);
    s.lfo(bg.gain, 0.06, 0.025, now);
    s.chain(b, blp, bg, s.out);
    // Room air.
    const p = s.noise('pink', now);
    const pbp = s.filter('bandpass', 650, 0.5);
    const pg = s.gain(0.028);
    s.lfo(pbp.frequency, 0.035, 120, now);
    s.chain(p, pbp, pg, s.out);
    // Vent hiss.
    const h = s.noise('pink', now);
    const hhp = s.filter('highpass', 3800, 0.6);
    const hlp = s.filter('lowpass', 9000, 0.6);
    const hg = s.gain(0.009);
    s.chain(h, hhp, hlp, hg, s.out);
    s.fadeTo(1, now, 0.6);
    this.tone = s;
  }

  stop(now: number): void {
    if (!this.on) return;
    this.on = false;
    if (this.tone) {
      this.tone.fadeTo(0, now, 0.35);
      this.tone.release(now + 2);
      this.tone = null;
    }
  }

  tick(now: number): boolean {
    if (!this.on) return false;
    if (this.nextEvent < now - 1) this.nextEvent = now + rand(1, 4);
    while (this.nextEvent < now + LOOKAHEAD) {
      this.event(this.nextEvent);
      this.nextEvent += rand(3.5, 11);
    }
    return true;
  }

  private event(t: number): void {
    const kind = weighted<AmbEvent>([
      ['pad', this.lastEvent === 'pad' ? 0.5 : 2],
      ['clink', this.lastEvent === 'clink' ? 0.5 : 2],
      ['murmur', this.lastEvent === 'murmur' ? 0.5 : 2.2],
      ['clap', 1],
    ]);
    this.lastEvent = kind;
    const pan = rand(-0.75, 0.75);
    const s = new Sound(this.ctx, this.dest, t, { gain: rand(0.7, 1.1), pan, send: 0.85 });
    const far = s.filter('lowpass', 1600, 0.6);
    far.connect(s.out);
    if (kind === 'pad') {
      const o = s.osc('sine', rand(62, 78), t, t + 0.5);
      s.glide(o.frequency, t, rand(62, 78), 40, 0.12);
      const g = s.gain(0);
      s.perc(g.gain, t, 0.22, 0.004, 0.32);
      s.chain(o, g, far);
      const n = s.noise('brown', t, t + 0.4);
      const lp = s.filter('lowpass', 260, 0.7);
      const ng = s.gain(0);
      s.perc(ng.gain, t, 0.3, 0.006, 0.26);
      s.chain(n, lp, ng, far);
    } else if (kind === 'clink') {
      far.frequency.value = 3200;
      const hits = chance(0.4) ? 2 : 1;
      for (let i = 0; i < hits; i++) {
        const tt = t + i * rand(0.08, 0.16);
        const base = rand(2500, 3600);
        for (const [r, pk, d] of [
          [1, 0.03, 0.08],
          [1.52, 0.02, 0.06],
          [2.21, 0.012, 0.04],
        ] as const) {
          const o = s.osc('sine', base * r, tt, tt + d + 0.02);
          const g = s.gain(0);
          s.perc(g.gain, tt, pk, 0.0008, d);
          s.chain(o, g, far);
        }
      }
    } else if (kind === 'clap') {
      for (let i = 0; i < 2; i++) {
        const tt = t + i * rand(0.15, 0.22);
        const n = s.noise('pink', tt, tt + 0.08);
        const bp = s.filter('bandpass', rand(1000, 1400), 0.8);
        const g = s.gain(0);
        s.perc(g.gain, tt, 0.07, 0.001, 0.05);
        s.chain(n, bp, g, far);
      }
    } else {
      // Murmur: two distant "voices" of band-passed noise syllables.
      far.frequency.value = 1300;
      const voices = randInt(1, 2);
      for (let v = 0; v < voices; v++) {
        let tt = t + v * rand(0.2, 0.6);
        const centre = rand(380, 900);
        const syll = randInt(3, 8);
        for (let i = 0; i < syll; i++) {
          const d = rand(0.08, 0.2);
          const n = s.noise('pink', tt, tt + d + 0.05);
          const f1 = clamp(centre * rand(0.75, 1.3), 250, 1200);
          const b1 = s.filter('bandpass', f1, 4);
          const b2 = s.filter('bandpass', f1 * pick([2.1, 2.6, 3.1]), 5);
          const g = s.gain(0);
          g.gain.setValueAtTime(0, tt);
          g.gain.linearRampToValueAtTime(rand(0.08, 0.14), tt + d * 0.3);
          g.gain.setTargetAtTime(0, tt + d * 0.6, d * 0.15);
          s.chain(n, b1, g);
          s.chain(n, b2, g);
          g.connect(far);
          tt += d + rand(0.03, 0.14);
        }
      }
    }
    s.finish();
  }
}

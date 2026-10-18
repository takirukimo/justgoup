// Continuous effort layer driven by the climber's tension (0..1.5) and pump (0..1):
//  · breathing — inhale/exhale cycles that speed up, get louder and start to voice with tension,
//  · heartbeat — "lub-dub" fading in above pump 0.4 and speeding up with pump,
//  · tension drone + riser — a low detuned drone and a rising band of noise above tension 1.0.
// Ticked by the shared Clock; time-agnostic (uses the `now` it is given) so it also renders offline.

import { Sound, type Dest } from './sound';
import { breath, type VoiceProfile } from './voice';
import { cents, clamp, finite, lerp, mtof, rand, smoothstep } from './util';

const LOOKAHEAD = 0.2;

export class IntensityLayer {
  private readonly out: GainNode;
  private tension = 0;
  private pump = 0;
  private st = 0;
  private sp = 0;
  private last = -1;
  private nextBreath = -1;
  private inhale = true;
  private nextBeat = -1;
  private drone: Sound | null = null;
  private droneGain: GainNode | null = null;
  private droneLp: BiquadFilterNode | null = null;
  private riserBp: BiquadFilterNode | null = null;
  private riserGain: GainNode | null = null;
  private droneIdle = 0;
  private applied = { dl: -1 };

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: Dest,
    private readonly voice: VoiceProfile,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest.dry);
  }

  set(tension: number, pump: number): void {
    this.tension = clamp(finite(tension, 0), 0, 1.5);
    this.pump = clamp(finite(pump, 0), 0, 1);
  }

  /** True while there is anything to play or fade. */
  get busy(): boolean {
    return this.tension > 0.001 || this.pump > 0.001 || this.st > 0.004 || this.sp > 0.004 || this.drone !== null;
  }

  tick(now: number): boolean {
    const dt = this.last < 0 ? 0.025 : clamp(now - this.last, 0, 0.25);
    this.last = now;
    this.st += (this.tension - this.st) * (1 - Math.exp(-dt / 0.35));
    this.sp += (this.pump - this.sp) * (1 - Math.exp(-dt / 0.5));
    if (this.tension === 0 && this.st < 0.004) this.st = 0;
    if (this.pump === 0 && this.sp < 0.004) this.sp = 0;

    this.scheduleBreaths(now);
    this.scheduleBeats(now);
    this.updateDrone(now);

    if (!this.busy) {
      this.last = -1;
      return false;
    }
    return true;
  }

  /** Stop everything quickly (e.g. leaving a climb). */
  stop(now: number): void {
    this.tension = this.pump = this.st = this.sp = 0;
    this.nextBreath = this.nextBeat = -1;
    if (this.drone) {
      this.drone.kill(now, 0.4);
      this.drone = null;
    }
  }

  // ───────────── breathing ─────────────

  private scheduleBreaths(now: number): void {
    const st = this.st, sp = this.sp;
    const level = st < 0.04 && sp < 0.05 ? 0 : 0.16 + 0.6 * smoothstep(0.1, 1.3, st) + 0.22 * sp;
    if (level <= 0) {
      this.nextBreath = -1;
      return;
    }
    if (this.nextBreath < now - 0.1) {
      this.nextBreath = now + 0.05;
      this.inhale = true;
    }
    while (this.nextBreath < now + LOOKAHEAD) {
      const period = lerp(3.6, 1.0, smoothstep(0, 1.4, st)) * (1 - 0.25 * sp) * rand(0.9, 1.1);
      const strainAmt = smoothstep(0.8, 1.4, st);
      const t = this.nextBreath;
      const dur = this.inhale ? period * 0.38 : period * 0.5;
      const lvl = level * (this.inhale ? 0.55 : 1) * rand(0.85, 1.1);
      const s = new Sound(this.ctx, { dry: this.out }, t, { gain: 1, pan: rand(-0.05, 0.05) });
      breath(s, this.voice, t, dur, this.inhale, lvl, this.inhale ? 0 : strainAmt);
      s.finish();
      this.nextBreath = t + dur + period * (this.inhale ? 0.03 : 0.09);
      this.inhale = !this.inhale;
    }
  }

  // ───────────── heartbeat ─────────────

  private scheduleBeats(now: number): void {
    const level = smoothstep(0.4, 0.95, this.sp);
    if (level < 0.01) {
      this.nextBeat = -1;
      return;
    }
    if (this.nextBeat < now - 0.1) this.nextBeat = now + 0.05;
    const bpm = 70 + 78 * smoothstep(0.4, 1, this.sp) + 12 * clamp(this.st, 0, 1);
    const interval = 60 / bpm;
    while (this.nextBeat < now + LOOKAHEAD) {
      this.beat(this.nextBeat, level * 0.5, interval);
      this.nextBeat += interval * rand(0.98, 1.02);
    }
  }

  private beat(t: number, level: number, interval: number): void {
    const s = new Sound(this.ctx, { dry: this.out }, t, { gain: level });
    const thud = (tt: number, f0: number, f1: number, pk: number, d: number): void => {
      const o = s.osc('sine', f0, tt, tt + d + 0.05);
      s.glide(o.frequency, tt, f0, f1, 0.07);
      const g = s.gain(0);
      s.perc(g.gain, tt, pk, 0.006, d);
      const drive = s.gain(1.8);
      const sh = s.shaper(2.2);
      const post = s.gain(0.55);
      s.chain(o, g, drive, sh, post, s.out);
      const n = s.noise('brown', tt, tt + d + 0.05);
      const lp = s.filter('lowpass', 170, 0.8);
      const ng = s.gain(0);
      s.perc(ng.gain, tt, pk * 0.5, 0.004, d * 0.7);
      s.chain(n, lp, ng, s.out);
    };
    thud(t, 62, 42, 1, 0.13);
    thud(t + Math.min(0.28, interval * 0.42), 70, 48, 0.7, 0.1);
    s.finish();
  }

  // ───────────── drone + riser ─────────────

  private updateDrone(now: number): void {
    const dl = smoothstep(1.0, 1.45, this.st);
    if (dl > 0.002 && !this.drone) this.startDrone(now);
    if (!this.drone) return;
    if (Math.abs(dl - this.applied.dl) > 0.004) {
      this.applied.dl = dl;
      this.droneGain?.gain.setTargetAtTime(dl * 0.1, now, 0.25);
      this.droneLp?.frequency.setTargetAtTime(160 + 1100 * dl, now, 0.3);
      this.riserBp?.frequency.setTargetAtTime(380 + 2600 * dl, now, 0.4);
      this.riserGain?.gain.setTargetAtTime(dl * 0.06, now, 0.3);
    }
    if (dl <= 0.002) {
      if (this.droneIdle === 0) this.droneIdle = now;
      if (now - this.droneIdle > 2.0) {
        this.drone.kill(now, 0.3);
        this.drone = null;
        this.droneIdle = 0;
        this.applied.dl = -1;
      }
    } else this.droneIdle = 0;
  }

  private startDrone(now: number): void {
    const s = new Sound(this.ctx, this.dest, now, { gain: 1, send: 0.18 });
    const g = s.gain(0);
    const lp = s.filter('lowpass', 140, 1.4);
    s.lfo(lp.frequency, 0.13, 40, now);
    const root = mtof(26); // D1
    for (const [f, d, lvl] of [
      [root, -7, 0.5],
      [root, 7, 0.5],
      [mtof(33), 4, 0.35],
      [mtof(38), -3, 0.25],
    ] as const) {
      const o = s.osc('sawtooth', f * cents(d), now);
      const og = s.gain(lvl);
      s.chain(o, og, lp);
    }
    s.chain(lp, g, s.out);
    // Rising band of noise.
    const n = s.noise('pink', now);
    const bp = s.filter('bandpass', 380, 5);
    const rg = s.gain(0);
    s.chain(n, bp, rg, s.out);
    this.drone = s;
    this.droneGain = g;
    this.droneLp = lp;
    this.riserBp = bp;
    this.riserGain = rg;
    this.applied.dl = -1;
  }
}

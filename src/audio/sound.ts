// `Sound`: a self-cleaning group of Web Audio nodes rendered into any BaseAudioContext.
//
// Every one-shot effect, music note and continuous layer is built from one of these. Layers
// connect into `sound.out`; the group owns its output gain, optional stereo panner and reverb
// send. When the last source has stopped, a silent "watcher" source fires `onended` and every
// node in the group is disconnected so the garbage collector can reclaim it. Works identically
// in a live AudioContext and in an OfflineAudioContext (used by the verification tools).

import { clamp, DRIFT_HZ, isWaveId, noiseBuffer, silentBuffer, softClip, wave, type NoiseKind, type WaveId } from './util';

/** Where a sound goes: a dry input and (optionally) a reverb/delay send input. */
export interface Dest {
  dry: AudioNode;
  wet?: AudioNode | null;
}

export interface SoundOptions {
  /** Output gain (linear). */
  gain?: number;
  /** Stereo position −1..1. */
  pan?: number;
  /** Amount sent to `dest.wet` (post-fader). */
  send?: number;
  /** Pitch multiplier exposed to builders as `p`. */
  pitch?: number;
}

type Src = AudioScheduledSourceNode;

export class Sound {
  readonly ctx: BaseAudioContext;
  /** Start time (context seconds). */
  readonly t: number;
  /** Pitch multiplier. */
  readonly p: number;
  /** Layers connect here. */
  readonly out: GainNode;
  /** Post-output fader used for fades, crossfades and voice stealing. */
  readonly fader: GainNode;
  /** Called once after the group finished and released its nodes. */
  onDone: (() => void) | null = null;
  /** Time at which the group will be released (valid after finish()/release()). */
  end = Infinity;

  private readonly nodes: AudioNode[] = [];
  private readonly srcs: Src[] = [];
  private lastStop: number;
  private watcher: AudioBufferSourceNode | null = null;
  private disposed = false;
  private persistent = false;

  constructor(ctx: BaseAudioContext, dest: Dest, t: number, o: SoundOptions = {}) {
    this.ctx = ctx;
    this.t = t;
    this.p = o.pitch ?? 1;
    this.lastStop = t;
    this.out = this.reg(ctx.createGain());
    this.out.gain.value = o.gain ?? 1;
    this.fader = this.reg(ctx.createGain());
    this.out.connect(this.fader);
    let tail: AudioNode = this.fader;
    const pan = clamp(o.pan ?? 0, -1, 1);
    if (Math.abs(pan) > 0.001 && typeof ctx.createStereoPanner === 'function') {
      const sp = this.reg(ctx.createStereoPanner());
      sp.pan.value = pan;
      tail.connect(sp);
      tail = sp;
    }
    tail.connect(dest.dry);
    const send = o.send ?? 0;
    if (dest.wet && send > 0) {
      const g = this.reg(ctx.createGain());
      g.gain.value = send;
      tail.connect(g);
      g.connect(dest.wet);
    }
  }

  get isDone(): boolean {
    return this.disposed;
  }

  /** Register an externally created node so it is released with the group. */
  reg<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private src<T extends Src>(n: T, t0: number, t1: number | undefined): T {
    this.nodes.push(n);
    this.srcs.push(n);
    if (t1 === undefined || !Number.isFinite(t1)) this.persistent = true;
    else {
      n.stop(t1);
      if (t1 > this.lastStop) this.lastStop = t1;
    }
    return n;
  }

  // ───────────── node builders ─────────────

  gain(v = 0): GainNode {
    const g = this.reg(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = Math.SQRT1_2, gainDb = 0): BiquadFilterNode {
    const f = this.reg(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = clamp(freq, 10, this.ctx.sampleRate * 0.49);
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  panner(pan: number): AudioNode {
    if (typeof this.ctx.createStereoPanner !== 'function') return this.gain(1);
    const p = this.reg(this.ctx.createStereoPanner());
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }

  shaper(drive: number): WaveShaperNode {
    const w = this.reg(this.ctx.createWaveShaper());
    w.curve = softClip(this.ctx, drive);
    w.oversample = '2x';
    return w;
  }

  delay(time: number, max = 2): DelayNode {
    const d = this.reg(this.ctx.createDelay(max));
    d.delayTime.value = time;
    return d;
  }

  /** Oscillator (built-in type or a named wavetable). Omit t1 for a persistent source. */
  osc(kind: OscillatorType | WaveId, freq: number, t0: number = this.t, t1?: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (isWaveId(kind)) o.setPeriodicWave(wave(this.ctx, kind));
    else o.type = kind;
    o.frequency.value = clamp(freq, 0.01, this.ctx.sampleRate * 0.49);
    o.start(t0);
    return this.src(o, t0, t1);
  }

  /** Looping noise from the pre-rendered bank, starting at a random offset. */
  noise(kind: NoiseKind, t0: number = this.t, t1?: number, rate = 1): AudioBufferSourceNode {
    const buf = noiseBuffer(this.ctx, kind);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t0, Math.random() * buf.duration * 0.9);
    return this.src(s, t0, t1);
  }

  /** Constant source (modulation offsets). */
  constant(value: number, t0: number = this.t, t1?: number): ConstantSourceNode | null {
    if (typeof this.ctx.createConstantSource !== 'function') return null;
    const c = this.ctx.createConstantSource();
    c.offset.value = value;
    c.start(t0);
    return this.src(c, t0, t1);
  }

  /** Periodic modulation: adds `depth · lfo(rate)` to `param`. */
  lfo(param: AudioParam, rate: number, depth: number, t0: number = this.t, t1?: number, type: OscillatorType = 'sine'): OscillatorNode {
    const o = this.osc(type, rate, t0, t1);
    const g = this.gain(depth);
    o.connect(g);
    g.connect(param);
    return o;
  }

  /** Smooth random modulation: adds ±depth with roughly `rateHz` bandwidth to `param`. */
  wobble(param: AudioParam, depth: number, rateHz: number, t0: number = this.t, t1?: number): void {
    const n = this.noise('drift', t0, t1, rateHz / DRIFT_HZ);
    const g = this.gain(depth);
    n.connect(g);
    g.connect(param);
  }

  /** Connect nodes in series; returns the last. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  // ───────────── envelopes ─────────────

  /** 0 → peak (linear over a) → exponential decay to −60 dB over d. Returns the end time. */
  perc(param: AudioParam, t0: number, peak: number, a: number, d: number): number {
    const pk = Math.max(Math.abs(peak), 1e-5);
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(pk, t0 + Math.max(a, 0.0005));
    param.exponentialRampToValueAtTime(pk * 1e-3, t0 + a + d);
    param.linearRampToValueAtTime(0, t0 + a + d + 0.004);
    return t0 + a + d + 0.004;
  }

  /** 0 → peak (linear over a) → hold → smooth release over r. Returns the end time. */
  swell(param: AudioParam, t0: number, peak: number, a: number, hold: number, r: number): number {
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(peak, t0 + Math.max(a, 0.0005));
    param.setValueAtTime(peak, t0 + a + hold);
    param.setTargetAtTime(0, t0 + a + hold, Math.max(r / 6, 0.001));
    return t0 + a + hold + r;
  }

  /** Exponential glide of a positive-valued param. */
  glide(param: AudioParam, t0: number, from: number, to: number, dur: number): void {
    param.setValueAtTime(Math.max(from, 1e-4), t0);
    param.exponentialRampToValueAtTime(Math.max(to, 1e-4), t0 + Math.max(dur, 0.001));
  }

  /** Piecewise exponential path through [time offset, value] points (value > 0). */
  path(param: AudioParam, t0: number, pts: readonly (readonly [number, number])[]): void {
    if (!pts.length) return;
    param.setValueAtTime(Math.max(pts[0][1], 1e-4), t0 + pts[0][0]);
    for (let i = 1; i < pts.length; i++) param.exponentialRampToValueAtTime(Math.max(pts[i][1], 1e-4), t0 + pts[i][0]);
  }

  // ───────────── lifecycle ─────────────

  /** Seal a one-shot sound: releases every node once the last source has stopped. */
  finish(extra = 0.05): number {
    if (this.persistent) return Infinity;
    return this.arm(this.lastStop + extra);
  }

  /** Stop all sources at `t` (persistent layers) and release the group shortly after. */
  release(t: number): number {
    for (const s of this.srcs) {
      try {
        s.stop(t);
      } catch {
        /* already stopped */
      }
    }
    this.persistent = false;
    this.lastStop = t;
    return this.arm(t + 0.05);
  }

  /** Fade the whole group out over `fade` seconds from `now`, then release it. */
  kill(now: number, fade = 0.03): void {
    if (this.disposed) return;
    const g = this.fader.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(0, now, fade / 4);
    this.release(now + fade);
  }

  /** Fade the group's fader to `value` with time constant tau. */
  fadeTo(value: number, t: number, tau: number): void {
    const g = this.fader.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(value, t, Math.max(tau, 0.001));
  }

  private arm(end: number): number {
    if (this.disposed) return end;
    if (this.watcher) {
      try {
        this.watcher.stop(end);
      } catch {
        /* ignore */
      }
      this.end = end;
      return end;
    }
    const w = this.ctx.createBufferSource();
    w.buffer = silentBuffer(this.ctx);
    w.loop = true;
    w.connect(this.out);
    w.onended = () => this.dispose();
    const start = Math.min(this.t, end - 0.001);
    w.start(Math.max(0, start));
    w.stop(end);
    this.watcher = w;
    this.end = end;
    return end;
  }

  /** Disconnect everything immediately. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.watcher) {
      this.watcher.onended = null;
      try {
        this.watcher.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
    this.srcs.length = 0;
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }
}

// Master mix graph, buildable on any BaseAudioContext (live or offline):
//
//   sfx.dry ─┐                                   ┌─ (dynamics) glue compressor → limiter ─┐
//   music.dry├──────────────► master gain ───────┤                                        ├─► destination
//   amb.dry ─┘        ▲                          └─ (no dynamics, offline analysis) ──────┘
//   *.wet ──► reverb in → HP/LP → convolver (procedural hall IR) → return ┘
//
// Every bus has a dry and a wet (reverb send) input; both are scaled by the bus volume so the
// reverb follows the player's volume settings.

import { hallImpulse } from './util';

export interface Bus {
  dry: GainNode;
  wet: GainNode;
}

export interface MixGraph {
  ctx: BaseAudioContext;
  master: GainNode;
  sfx: Bus;
  music: Bus;
  amb: Bus;
  /** Final node before the destination (tap point for analysers). */
  output: AudioNode;
}

export interface MixOptions {
  /** Glue compressor + limiter on the master (default true). */
  dynamics?: boolean;
  /** Master gain (default 0.8). */
  master?: number;
  /** Build the hall impulse response on the next task instead of synchronously (live unlock). */
  lazyReverb?: boolean;
}

export function createMixGraph(ctx: BaseAudioContext, o: MixOptions = {}): MixGraph {
  const master = ctx.createGain();
  master.gain.value = o.master ?? 0.8;
  let output: AudioNode = master;
  if (o.dynamics !== false) {
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 14;
    glue.ratio.value = 2.4;
    glue.attack.value = 0.012;
    glue.release.value = 0.28;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    // The spec's compressor applies automatic make-up gain; trim it back so the limiter has headroom.
    const trim = ctx.createGain();
    trim.gain.value = 0.72;
    master.connect(glue);
    glue.connect(trim);
    trim.connect(limiter);
    output = limiter;
  }
  output.connect(ctx.destination);

  // Hall reverb.
  const verbIn = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 220;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7000;
  const conv = ctx.createConvolver();
  conv.normalize = true;
  if (o.lazyReverb) setTimeout(() => (conv.buffer = hallImpulse(ctx)), 0);
  else conv.buffer = hallImpulse(ctx);
  const ret = ctx.createGain();
  ret.gain.value = 0.55;
  verbIn.connect(hp);
  hp.connect(lp);
  lp.connect(conv);
  conv.connect(ret);
  ret.connect(master);

  const bus = (): Bus => {
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.connect(master);
    wet.connect(verbIn);
    return { dry, wet };
  };

  return { ctx, master, sfx: bus(), music: bus(), amb: bus(), output };
}

/** Smoothly set a bus level (both dry and wet inputs). */
export function setBusLevel(b: Bus, value: number, t: number, tau = 0.06): void {
  for (const g of [b.dry.gain, b.wet.gain]) {
    if (tau <= 0) {
      g.cancelScheduledValues(t);
      g.setValueAtTime(value, t);
    } else g.setTargetAtTime(value, t, tau);
  }
}

// Offline rendering + analysis for QA. Renders any sound effect, music track, the ambience or the
// effort layer into an OfflineAudioContext through the same code paths the live engine uses,
// then measures peak, RMS, active duration, spectral centroid and NaN/Inf safety.
// Used by dev/audio.html and scripts/audio-check.mjs. Not imported by the game itself.

import type { SfxId } from '../core/contracts';
import type { HeadId } from '../core/types';
import { Ambience } from './ambience';
import { createMixGraph, setBusLevel } from './graph';
import { IntensityLayer } from './intensity';
import { MusicPlayer, type TrackId } from './music';
import { EXTRA_SFX_IDS, SFX, SFX_IDS, sfxDef, type AnySfxId } from './sfx';
import { Sound } from './sound';
import { VOICE_IDS, voiceFor } from './species';
import { DEFAULT_VOICE } from './voice';
import { rand } from './util';

export { EXTRA_SFX_IDS, SFX_IDS, VOICE_IDS };

export interface RenderOptions {
  sampleRate?: number;
  /** Include the master compressor/limiter (default false: measure the raw design). */
  dynamics?: boolean;
  pitch?: number;
  volume?: number;
  /** The head whose voice set speaks (default: the human DEFAULT_VOICE). */
  voice?: HeadId;
}

/** The voice the renders use: the head's set with a random per-launch variation, like GameAudio. */
function renderVoice(o: RenderOptions): typeof DEFAULT_VOICE {
  if (!o.voice) return { ...DEFAULT_VOICE, f0: DEFAULT_VOICE.f0 * rand(0.9, 1.08), tract: DEFAULT_VOICE.tract * rand(0.96, 1.04) };
  return voiceFor(o.voice, { f0: rand(0.92, 1.07), tract: rand(0.97, 1.03) });
}

/** The voice gestures every head's set provides, as the one-shots that play them. */
export const VOICE_GESTURES: readonly AnySfxId[] = ['effort', 'strain', 'gasp', 'fall', 'exhale', 'call'];

export interface AudioStats {
  /** Rendered buffer length (s). */
  length: number;
  /** Time until the signal last exceeds −60 dBFS (s). */
  active: number;
  peak: number;
  /** RMS over the active part. */
  rms: number;
  rmsDb: number;
  peakDb: number;
  /** Spectral centroid (Hz). */
  centroid: number;
  /** Energy fraction below 200 Hz. */
  low: number;
  /** Energy fraction above 4 kHz. */
  high: number;
  /** Any NaN / ±Infinity sample. */
  nan: boolean;
  /** Samples with |x| > 0.99. */
  overs: number;
  /** A-weighted loudest-100 ms level (dB) — a rough perceived-loudness figure for balancing. */
  loud: number;
  /** Energy fractions in bands <200, 200–800, 800–2.5k, 2.5k–6k, >6k Hz. */
  bands: number[];
}

/** A-weighting power gain at f Hz. */
function aWeight2(f: number): number {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  const g = ra * 1.2589; // +2 dB normalisation at 1 kHz
  return g * g;
}

const BAND_EDGES = [200, 800, 2500, 6000];

const TAIL = 2.8; // reverb tail allowance

function offline(seconds: number, sampleRate: number): OfflineAudioContext {
  return new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
}

/** Render one sound effect exactly as GameAudio.play() builds it (at full sfx volume). */
export async function renderSfx(id: AnySfxId, o: RenderOptions = {}): Promise<{ buffer: AudioBuffer; end: number }> {
  const sr = o.sampleRate ?? 48000;
  const def = sfxDef(id);
  if (!def) throw new Error(`unknown sfx '${id}'`);
  const voice = renderVoice(o);
  // Probe pass to learn the sound's length, then render with room for the reverb tail.
  const probe = offline(0.1, sr);
  const ps = new Sound(probe, { dry: probe.destination }, 0.01, { pitch: o.pitch ?? 1 });
  def.build(ps, { voice });
  const end = ps.finish();
  ps.dispose();

  const ctx = offline(end + TAIL, sr);
  const g = createMixGraph(ctx, { dynamics: o.dynamics ?? false });
  setBusLevel(g.sfx, 1, 0, 0);
  const pitch = (o.pitch ?? 1) * (1 + rand(-def.vary, def.vary));
  const s = new Sound(ctx, g.sfx, 0.01, { gain: def.gain * (o.volume ?? 1), send: def.send, pitch });
  def.build(s, { voice });
  s.finish();
  return { buffer: await ctx.startRendering(), end: end - 0.01 };
}

/** Render `seconds` of a music track (scheduler ticked every 25 ms ahead of rendering). */
export async function renderMusic(track: TrackId, seconds: number, o: RenderOptions = {}): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 44100;
  const ctx = offline(seconds, sr);
  const g = createMixGraph(ctx, { dynamics: o.dynamics ?? false });
  setBusLevel(g.music, o.volume ?? 1, 0, 0);
  const player = new MusicPlayer(ctx, g.music);
  player.set(track, 0);
  for (let t = 0; t < seconds; t += 0.025) player.tick(t);
  return ctx.startRendering();
}

/** Render the gym ambience. */
export async function renderAmbience(seconds: number, o: RenderOptions = {}): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 44100;
  const ctx = offline(seconds, sr);
  const g = createMixGraph(ctx, { dynamics: o.dynamics ?? false });
  setBusLevel(g.amb, o.volume ?? 1, 0, 0);
  const amb = new Ambience(ctx, g.amb);
  amb.start(0);
  for (let t = 0; t < seconds; t += 0.025) amb.tick(t);
  return ctx.startRendering();
}

/**
 * Render the effort layer at a fixed tension/pump (fades out over the last 2 s). `excite` adds a hard
 * moment's extra breathing at the start (the exertion director's push).
 */
export async function renderIntensity(tension: number, pump: number, seconds: number, o: RenderOptions & { excite?: number } = {}): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 44100;
  const ctx = offline(seconds, sr);
  const g = createMixGraph(ctx, { dynamics: o.dynamics ?? false });
  setBusLevel(g.sfx, o.volume ?? 1, 0, 0);
  const layer = new IntensityLayer(ctx, g.sfx, o.voice ? renderVoice(o) : DEFAULT_VOICE);
  layer.set(tension, pump);
  if (o.excite) layer.excite(o.excite);
  for (let t = 0; t < seconds; t += 0.025) {
    if (t > seconds - 2.5) layer.set(0, 0);
    layer.tick(t);
  }
  return ctx.startRendering();
}

/** Everything at once through the full master chain (worst-case final mix). */
export async function renderFullMix(seconds: number): Promise<AudioBuffer> {
  const sr = 44100;
  const ctx = offline(seconds, sr);
  const g = createMixGraph(ctx, { dynamics: true });
  setBusLevel(g.sfx, 1, 0, 0);
  setBusLevel(g.music, 0.8, 0, 0);
  setBusLevel(g.amb, 0.55, 0, 0);
  const player = new MusicPlayer(ctx, g.music);
  player.set('climb', 0);
  const amb = new Ambience(ctx, g.amb);
  amb.start(0);
  const layer = new IntensityLayer(ctx, g.sfx, DEFAULT_VOICE);
  layer.set(1.4, 0.9);
  for (let t = 0; t < seconds; t += 0.025) {
    player.tick(t);
    amb.tick(t);
    layer.tick(t);
  }
  // A dense burst of effects on top.
  const ids: SfxId[] = ['grab', 'foot', 'land', 'send', 'clip', 'rope-catch', 'slip', 'fall', 'unlock', 'grab-bad', 'smear'];
  let t = 0.5;
  for (const id of ids) {
    const def = SFX[id];
    const s = new Sound(ctx, g.sfx, t, { gain: def.gain * 1.5, send: def.send, pitch: 1 });
    def.build(s, { voice: DEFAULT_VOICE });
    s.finish();
    t += 0.18;
  }
  return ctx.startRendering();
}

// ─────────────────────────────── analysis ───────────────────────────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function analyze(buf: AudioBuffer): AudioStats {
  const sr = buf.sampleRate;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const len = buf.length;
  let peak = 0, nan = false, overs = 0, lastActive = 0;
  for (const d of chans) {
    for (let i = 0; i < len; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) {
        nan = true;
        continue;
      }
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a > 0.99) overs++;
      if (a > 0.001 && i > lastActive) lastActive = i;
    }
  }
  const activeLen = Math.max(1, lastActive + 1);
  let sq = 0;
  for (const d of chans) for (let i = 0; i < activeLen; i++) if (Number.isFinite(d[i])) sq += d[i] * d[i];
  const rms = Math.sqrt(sq / (activeLen * chans.length));

  // Spectrum: average power over Hann-windowed frames of the active region (mono sum).
  const N = 4096;
  const re = new Float64Array(N), im = new Float64Array(N);
  const power = new Float64Array(N / 2);
  const hop = N;
  const frames = Math.max(1, Math.min(64, Math.floor(activeLen / hop)));
  const stride = Math.max(hop, Math.floor(activeLen / frames));
  for (let f = 0; f < frames; f++) {
    const off = f * stride;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (const d of chans) {
        const x = d[off + i];
        if (x !== undefined && Number.isFinite(x)) v += x;
      }
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  let tot = 0, wsum = 0, low = 0, high = 0, aw = 0;
  const bands = [0, 0, 0, 0, 0];
  for (let k = 1; k < N / 2; k++) {
    const hz = (k * sr) / N;
    tot += power[k];
    wsum += power[k] * hz;
    aw += power[k] * aWeight2(hz);
    if (hz < 200) low += power[k];
    if (hz > 4000) high += power[k];
    let b = 0;
    while (b < BAND_EDGES.length && hz >= BAND_EDGES[b]) b++;
    bands[b] += power[k];
  }
  // Loudest 100 ms window (RMS), A-weighted by the overall spectral tilt.
  const win = Math.max(1, Math.floor(sr * 0.1));
  let best = 0;
  for (let start = 0; start < activeLen; start += Math.floor(win / 2)) {
    let e = 0, n = 0;
    for (const d of chans) {
      for (let i = start; i < Math.min(start + win, len); i++) {
        const x = d[i];
        if (Number.isFinite(x)) e += x * x;
        n++;
      }
    }
    if (n) best = Math.max(best, e / n);
  }
  const aRatio = tot > 0 ? aw / tot : 0;
  const loud = 10 * Math.log10(best * aRatio || 1e-12);
  const safe = (v: number): number => (Number.isFinite(v) ? v : 0);
  return {
    length: len / sr,
    active: activeLen / sr,
    peak,
    rms,
    rmsDb: 20 * Math.log10(rms || 1e-9),
    peakDb: 20 * Math.log10(peak || 1e-9),
    centroid: safe(tot > 0 ? wsum / tot : 0),
    low: safe(tot > 0 ? low / tot : 0),
    high: safe(tot > 0 ? high / tot : 0),
    nan,
    overs,
    loud: safe(loud),
    bands: bands.map((b) => safe(tot > 0 ? b / tot : 0)),
  };
}

// ─────────────────────────────── check suite ───────────────────────────────

export interface CheckRow {
  name: string;
  kind: 'sfx' | 'music' | 'ambience' | 'intensity' | 'mix' | 'voice';
  /** Designed length of the sound (s), sfx only. */
  dur: number;
  stats: AudioStats;
  /** Worst-case peak across variants (raw, pre-limiter). */
  peakMax: number;
  ok: boolean;
  problems: string[];
}

export interface CheckReport {
  ok: boolean;
  rows: CheckRow[];
  ms: number;
}

function judge(row: Omit<CheckRow, 'ok' | 'problems'>, minRms: number, maxPeak = 0.99): CheckRow {
  const problems: string[] = [];
  if (row.stats.nan) problems.push('NaN/Inf samples');
  if (row.peakMax > maxPeak) problems.push(`peak ${row.peakMax.toFixed(3)} > ${maxPeak}`);
  if (row.stats.peak < 0.005 || row.stats.rms < minRms) problems.push('silent');
  return { ...row, ok: problems.length === 0, problems };
}

/**
 * Render every sound effect (several random variants + pitch extremes), both music tracks, the
 * ambience, the effort layer and a dense full mix; judge each for silence, clipping and NaN.
 */
export async function runAudioCheck(o: { variants?: number; musicSeconds?: number } = {}): Promise<CheckReport> {
  const t0 = performance.now();
  const variants = o.variants ?? 4;
  const musicSeconds = o.musicSeconds ?? 40;
  const rows: CheckRow[] = [];

  /** Several random variants (+ pitch extremes) of one one-shot: the first's stats, the worst peak. */
  const sweep = async (id: AnySfxId, voice: HeadId | undefined, n: number): Promise<{ stats: AudioStats; end: number; peakMax: number; quiet: number }> => {
    let first: AudioStats | null = null;
    let end = 0;
    let peakMax = 0;
    let nan = false;
    let quiet = Infinity;
    const pitches = [1, 1, 0.8, 1.25];
    for (let v = 0; v < Math.max(n, 1); v++) {
      const r = await renderSfx(id, { pitch: pitches[v % pitches.length], voice });
      const st = analyze(r.buffer);
      if (!first) {
        first = st;
        end = r.end;
      }
      peakMax = Math.max(peakMax, st.peak);
      quiet = Math.min(quiet, st.peak);
      nan = nan || st.nan;
    }
    return { stats: { ...(first as AudioStats), nan }, end, peakMax, quiet };
  };

  for (const id of [...SFX_IDS, ...EXTRA_SFX_IDS]) {
    const r = await sweep(id, id === 'call' ? 'ibex' : undefined, variants);
    rows.push(judge({ name: id, kind: 'sfx', dur: r.end, stats: r.stats, peakMax: r.peakMax }, 1e-4));
  }

  // every head's voice set: each gesture renders non-silent (in EVERY variant) and never clips
  for (const head of VOICE_IDS) {
    for (const id of VOICE_GESTURES) {
      const n = id === 'effort' ? Math.max(variants, 6) : variants; // efforts rotate through 3–4 styles
      const r = await sweep(id, head, n);
      const row = judge({ name: `voice:${head}:${id}`, kind: 'voice', dur: r.end, stats: r.stats, peakMax: r.peakMax }, 1e-4);
      if (r.quiet < 0.005) {
        row.problems.push('a variant is silent');
        row.ok = false;
      }
      rows.push(row);
    }
    const buf = await renderIntensity(1.2, 0.85, 7, { voice: head, excite: 0.9 });
    const st = analyze(buf);
    rows.push(judge({ name: `voice:${head}:breathing`, kind: 'voice', dur: 7, stats: st, peakMax: st.peak }, 0.002));
  }

  for (const track of ['menu', 'climb'] as const) {
    const buf = await renderMusic(track, musicSeconds);
    const st = analyze(buf);
    rows.push(judge({ name: `music:${track}`, kind: 'music', dur: musicSeconds, stats: st, peakMax: st.peak }, 0.004));
  }

  {
    const buf = await renderAmbience(24);
    const st = analyze(buf);
    rows.push(judge({ name: 'ambience', kind: 'ambience', dur: 24, stats: st, peakMax: st.peak }, 0.001));
  }

  // easy climbing breathes barely audibly (owner: heavy breathing only when it is genuinely hard)
  for (const [tension, pump, minRms] of [
    [0.4, 0.1, 0.0007],
    [1.0, 0.6, 0.002],
    [1.5, 1.0, 0.002],
  ] as const) {
    const buf = await renderIntensity(tension, pump, 9);
    const st = analyze(buf);
    rows.push(judge({ name: `intensity:${tension}/${pump}`, kind: 'intensity', dur: 9, stats: st, peakMax: st.peak }, minRms));
  }

  {
    const buf = await renderFullMix(8);
    const st = analyze(buf);
    rows.push(judge({ name: 'full-mix (limited)', kind: 'mix', dur: 8, stats: st, peakMax: st.peak }, 0.01, 1.0));
  }

  return { ok: rows.every((r) => r.ok), rows, ms: Math.round(performance.now() - t0) };
}

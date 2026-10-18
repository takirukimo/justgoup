// GameAudio — the AudioAPI implementation. Fully procedural Web Audio (no audio files):
// tactile sound effects, a tension/pump-driven effort layer (breathing, heartbeat, drone),
// generative ambient music with crossfades, gym room ambience, and haptics.
//
// Lifecycle: nothing touches Web Audio until unlock() is called from a user gesture. Every call
// before that is a safe no-op that only records the wanted state (music, ambience, volumes),
// which is applied as soon as the context runs.

import type { AudioAPI, SfxId } from '../core/contracts';
import { Ambience } from './ambience';
import { Clock } from './clock';
import { createMixGraph, setBusLevel, type MixGraph } from './graph';
import { IntensityLayer } from './intensity';
import { MusicPlayer, type MusicChoice } from './music';
import { COUNT_STEP, countBeep, SFX, type SfxKit } from './sfx';
import { Sound } from './sound';
import { DEFAULT_VOICE, type VoiceProfile } from './voice';
import { clamp, db, finite, rand, volumeCurve, warmBank } from './util';

/** Global cap on simultaneous one-shot voices. */
const MAX_VOICES = 24;
/** Bus trims (at slider = 1). */
const SFX_TRIM = 1.0;
const MUSIC_TRIM = 0.8;
const AMB_TRIM = 0.55; // relative to the sfx slider

type Ctor = typeof AudioContext;

interface ActiveVoice {
  id: SfxId;
  sound: Sound;
  t: number;
}

export class GameAudio implements AudioAPI {
  private ctx: AudioContext | null = null;
  private graph: MixGraph | null = null;
  private clock: Clock | null = null;
  private music: MusicPlayer | null = null;
  private ambience: Ambience | null = null;
  private intensity: IntensityLayer | null = null;
  private unlockPromise: Promise<void> | null = null;

  private readonly voices = new Set<ActiveVoice>();
  private readonly lastPlay = new Map<SfxId, number>();
  private readonly kit: SfxKit;

  private sfxVolume = 0.85;
  private musicVolume = 0.6;
  private wantMusic: MusicChoice = 'none';
  private wantAmbience = false;
  private tension = 0;
  private pump = 0;
  private hapticsOn = true;
  private lastHaptic = 0;
  private userSuspended = false;
  private hidden = false;

  /** The climber's voice for this session (slightly different every launch). */
  readonly voice: VoiceProfile;

  constructor() {
    this.voice = { f0: DEFAULT_VOICE.f0 * rand(0.9, 1.08), tract: DEFAULT_VOICE.tract * rand(0.96, 1.04) };
    this.kit = { voice: this.voice };
  }

  // ═══════════════════════════════ AudioAPI ═══════════════════════════════

  unlock(): Promise<void> {
    if (this.unlockPromise) {
      // Already created: make sure it is running (iOS can re-suspend after interruptions).
      this.applyRunState();
      return this.unlockPromise;
    }
    this.unlockPromise = this.doUnlock().catch((err: unknown) => {
      console.warn('[audio] unlock failed', err);
      this.unlockPromise = null;
    });
    return this.unlockPromise;
  }

  play(id: SfxId, opts: { volume?: number; pitch?: number; pan?: number } = {}): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || ctx.state !== 'running') return;
    const def = SFX[id];
    if (!def) return;
    const now = ctx.currentTime;
    const last = this.lastPlay.get(id);
    if (def.gap !== undefined && last !== undefined && now - last < def.gap) return;
    this.lastPlay.set(id, now);

    const volume = clamp(finite(opts.volume, 1), 0, 2);
    if (volume <= 0.001) return;
    this.makeRoom(id, def.max, now);

    const pitch = clamp(finite(opts.pitch, 1), 0.25, 4) * (1 + rand(-def.vary, def.vary));
    const gain = def.gain * volume * (def.ui ? 1 : db(rand(-1.2, 1.2)));
    const pan = clamp(finite(opts.pan, 0) + (def.ui ? 0 : rand(-0.06, 0.06)), -1, 1);
    const t = now + 0.004 + (def.ui ? 0 : rand(0, 0.008));
    const sound = new Sound(ctx, g.sfx, t, { gain, pan, send: def.send, pitch });
    try {
      def.build(sound, this.kit);
    } catch (err) {
      console.warn(`[audio] sfx '${id}' failed`, err);
      sound.release(t);
      return;
    }
    this.track(id, sound, t);
  }

  setIntensity(tension: number, pump: number): void {
    this.tension = clamp(finite(tension, 0), 0, 1.5);
    this.pump = clamp(finite(pump, 0), 0, 1);
    const layer = this.intensity;
    if (!layer || !this.running) return;
    layer.set(this.tension, this.pump);
    if (layer.busy) this.clock?.add(this.intensityJob);
  }

  setMusic(track: 'menu' | 'climb' | 'none'): void {
    if (track !== 'menu' && track !== 'climb' && track !== 'none') return;
    this.wantMusic = track;
    if (!this.music || !this.ctx || !this.running) return;
    this.music.set(track, this.ctx.currentTime);
    if (this.music.busy) this.clock?.add(this.musicJob);
  }

  setVolumes(sfx: number, music: number): void {
    this.sfxVolume = clamp(finite(sfx, this.sfxVolume), 0, 1);
    this.musicVolume = clamp(finite(music, this.musicVolume), 0, 1);
    this.applyVolumes(false);
  }

  setAmbience(on: boolean): void {
    this.wantAmbience = !!on;
    const amb = this.ambience;
    if (!amb || !this.ctx || !this.running) return;
    if (on) {
      amb.start(this.ctx.currentTime);
      this.clock?.add(this.ambienceJob);
    } else amb.stop(this.ctx.currentTime);
  }

  haptic(pattern: number | number[]): void {
    if (!this.hapticsOn || typeof navigator === 'undefined') return;
    const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (typeof nav.vibrate !== 'function') return;
    if (nav.userActivation && !nav.userActivation.hasBeenActive) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const single = typeof pattern === 'number';
    if (single && now - this.lastHaptic < 40) return; // don't buzz-saw
    this.lastHaptic = now;
    const clean = single
      ? clamp(Math.round(finite(pattern, 0)), 0, 1000)
      : pattern.slice(0, 16).map((v) => clamp(Math.round(finite(v, 0)), 0, 1000));
    try {
      nav.vibrate(clean);
    } catch {
      /* not allowed here */
    }
  }

  setHaptics(on: boolean): void {
    this.hapticsOn = !!on;
    if (!on && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    }
  }

  // ═══════════════════════════════ optional extras ═══════════════════════════════

  /** Pause all audio (e.g. app hidden / game paused). Safe to call any time. */
  suspend(): void {
    this.userSuspended = true;
    this.applyRunState();
  }

  /** Undo suspend(). */
  resume(): void {
    this.userSuspended = false;
    this.applyRunState();
  }

  /**
   * One countdown element driven by the app's own timing: n > 0 → tick, n <= 0 → "GO".
   * (`play('countdown')` plays a complete 3-2-1-GO sequence with COUNT_STEP spacing instead.)
   */
  countdownStep(n: number): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    this.makeRoom('countdown', 3, now);
    const t = now + 0.004;
    const s = new Sound(ctx, g.sfx, t, { gain: SFX.countdown.gain, send: SFX.countdown.send });
    countBeep(s, t, n <= 0);
    this.track('countdown', s, t);
  }

  /** Seconds between steps of play('countdown'). */
  get countdownStepSeconds(): number {
    return COUNT_STEP;
  }

  /** True once the AudioContext exists and is running. */
  get isUnlocked(): boolean {
    return this.running;
  }

  /** The live AudioContext (null before unlock). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Number of one-shot voices currently alive. */
  get activeVoices(): number {
    return this.voices.size;
  }

  /** An AnalyserNode tapping the final mix (dev tools / visualisers). */
  createAnalyser(fftSize = 2048): AnalyserNode | null {
    if (!this.ctx || !this.graph) return null;
    const a = this.ctx.createAnalyser();
    a.fftSize = fftSize;
    a.smoothingTimeConstant = 0.75;
    this.graph.output.connect(a);
    return a;
  }

  /** Tear everything down (tests / hot reload). */
  dispose(): void {
    this.clock?.dispose();
    this.removeListeners();
    for (const v of this.voices) v.sound.dispose();
    this.voices.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.graph = null;
    this.music = null;
    this.ambience = null;
    this.intensity = null;
    this.unlockPromise = null;
    if (ctx) ctx.close().catch(() => undefined);
  }

  // ═══════════════════════════════ internals ═══════════════════════════════

  private get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  private async doUnlock(): Promise<void> {
    if (typeof window === 'undefined') return;
    const w = window as Window & { webkitAudioContext?: Ctor };
    const AC: Ctor | undefined = window.AudioContext ?? w.webkitAudioContext;
    if (!AC) return;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      ctx = new AC();
    }
    this.ctx = ctx;

    // iOS: play a silent buffer synchronously inside the gesture to unlock output.
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start(0);
      src.onended = () => src.disconnect();
    } catch {
      /* ignore */
    }
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => undefined);

    // Heavy buffers (hall IR, noise bank, wavetables) are built right after the gesture returns.
    this.graph = createMixGraph(ctx, { dynamics: true, lazyReverb: true });
    setTimeout(() => warmBank(ctx), 0);
    this.clock = new Clock(() => ctx.currentTime);
    this.music = new MusicPlayer(ctx, this.graph.music);
    this.ambience = new Ambience(ctx, this.graph.amb);
    this.intensity = new IntensityLayer(ctx, this.graph.sfx, this.voice);
    this.applyVolumes(true);
    this.addListeners();
    ctx.onstatechange = () => this.onStateChange();

    await Promise.race([resumed, new Promise<void>((r) => setTimeout(r, 1500))]);
    this.onStateChange();
  }

  /** (Re)apply wanted state whenever the context starts running; pause the clock otherwise. */
  private onStateChange(): void {
    const ctx = this.ctx;
    if (!ctx || !this.clock) return;
    if (ctx.state === 'running') {
      this.clock.resume();
      this.setMusic(this.wantMusic);
      this.setAmbience(this.wantAmbience);
      this.setIntensity(this.tension, this.pump);
    } else {
      this.clock.pause();
    }
  }

  private applyRunState(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const shouldRun = !this.userSuspended && !this.hidden;
    const state = ctx.state as string;
    if (shouldRun && state !== 'running' && state !== 'closed') {
      ctx.resume().catch(() => undefined);
    } else if (!shouldRun && state === 'running') {
      this.clock?.pause();
      ctx.suspend().catch(() => undefined);
    }
  }

  private applyVolumes(instant: boolean): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    const tau = instant ? 0 : 0.08;
    setBusLevel(g.sfx, volumeCurve(this.sfxVolume) * SFX_TRIM, t, tau);
    setBusLevel(g.music, volumeCurve(this.musicVolume) * MUSIC_TRIM, t, tau);
    setBusLevel(g.amb, volumeCurve(this.sfxVolume) * AMB_TRIM, t, tau);
  }

  private makeRoom(id: SfxId, max: number, now: number): void {
    let same = 0;
    let oldestSame: ActiveVoice | null = null;
    let oldest: ActiveVoice | null = null;
    for (const v of this.voices) {
      if (v.sound.isDone || v.sound.end < now) {
        this.voices.delete(v);
        continue;
      }
      if (v.id === id) {
        same++;
        if (!oldestSame || v.t < oldestSame.t) oldestSame = v;
      }
      if (!oldest || v.t < oldest.t) oldest = v;
    }
    if (same >= max && oldestSame) this.steal(oldestSame, now);
    else if (this.voices.size >= MAX_VOICES && oldest) this.steal(oldest, now);
  }

  private steal(v: ActiveVoice, now: number): void {
    this.voices.delete(v);
    v.sound.kill(now, 0.03);
  }

  private track(id: SfxId, sound: Sound, t: number): void {
    sound.finish();
    const v: ActiveVoice = { id, sound, t };
    this.voices.add(v);
    sound.onDone = () => this.voices.delete(v);
  }

  // Clock jobs (stable references so the clock can de-duplicate them).
  private readonly musicJob = (now: number): boolean => this.music?.tick(now) ?? false;
  private readonly ambienceJob = (now: number): boolean => this.ambience?.tick(now) ?? false;
  private readonly intensityJob = (now: number): boolean => this.intensity?.tick(now) ?? false;

  // Visibility + gesture listeners.
  private readonly onVisibility = (): void => {
    this.hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this.applyRunState();
  };

  private readonly onGesture = (): void => {
    const ctx = this.ctx;
    if (!ctx || this.userSuspended || this.hidden) return;
    if ((ctx.state as string) !== 'running') ctx.resume().catch(() => undefined);
  };

  private addListeners(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('pointerdown', this.onGesture, { passive: true, capture: true });
    document.addEventListener('touchend', this.onGesture, { passive: true, capture: true });
    document.addEventListener('keydown', this.onGesture, { capture: true });
  }

  private removeListeners(): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('pointerdown', this.onGesture, { capture: true });
    document.removeEventListener('touchend', this.onGesture, { capture: true });
    document.removeEventListener('keydown', this.onGesture, { capture: true });
  }
}

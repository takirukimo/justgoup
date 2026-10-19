// TUTORIAL: Steini the ibex, the CHIRAL SPORTS instructor, runs the first-launch intro and the
// scripted lesson on tutorialBoulder().
//
//   runIntro(ctx)     ~20 s cinematic: camera fly-in, letterbox + STEIBOCK title card (tap to move
//                     on), Steini (the CHIRAL SPORTS instructor) waving on the mats, three lines paced
//                     for reading (S.holdTime), ends pointing at the wall. Skippable.
//   runTutorial(ctx)  the lesson: one limb at a time from TUTORIAL_SEQUENCE (hand, foot, hips,
//                     shaking + pump, match on TOP), with gating, hold highlights, guide reactions,
//                     mistake handling and a finale. Two short Phase B beats ride along: a shake-out
//                     on the first big jug after the pump lesson, and a chalk dip before the TOP
//                     (phrased by the hand's real friction); a full stretch at a hold a throw would
//                     reach gets the deadpoint tip. Resolves 'done' or 'skipped'.
//
// ── What the app must do ─────────────────────────────────────────────────────────────────────
// runTutorial:
//  • Create the sim as `new ClimberSim(tutorialBoulder(), TUTORIAL_SIM_OPTIONS)` (assist 0.5 so the
//    stretch lesson really shakes, invincible so nobody falls), loadBoulder() it, bind the controls
//    and show the HUD with run.mode = 'tutorial'. The sim may be 'idle' or 'climbing'; the tutorial
//    calls sim.start() itself when the first lesson begins.
//  • Keep stepping the sim every frame, re-emit its events on bus 'sim:event', and call
//    renderer.updateClimber / controls.update / ui.hud.update as usual.
//  • While runTutorial is pending, leave the camera (preview → cut to follow → celebrate → cut to
//    a wide shot for the finale), the guide bubble, the guide NPC, hold highlights and
//    controls.setAllowed to the tutorial. On the 'top' event do NOT run the normal
//    send flow (callout, 'send' stinger, results): the tutorial plays its own finale. Per-event
//    sfx (grab, foot, …) are fine. Emit 'ui:pause' / 'ui:resume' as usual (the script pauses too).
//  • ctx.skipSignal: resolve it for any app-level skip. The tutorial also shows the guide bubble's
//    SKIP chip itself (ui.guide.setSkip, retired for the final TOP move) and treats 'ui:quit' as a skip.
//  • The tutorial never traps a player: a move that proves out of reach (full stretch, ring never
//    lights) triggers a rescue (an upcoming foot move that's in reach → stand up on it → retry),
//    and after that the lesson is let go. It never drives the sim's limbs or hips itself; besides
//    start() it only reads sim state and queries (reachableHolds).
//  • On exit (both results) highlights are cleared, gating is reset to 'all' + hips, the bubble
//    and SKIP chip are hidden, the guide NPC is hidden (pass keepGuide: true to keep him), and
//    bus 'tutorial:done' { skipped } is emitted.
// runIntro:
//  • Load the wall that should be on screen first (e.g. tutorialBoulder()); don't drive a sim yet,
//    so the climber stands on the mats next to Steini. Show UI screen 'none'. Audio should
//    already be unlocked (call it after the first tap).
//  • Steini stays on the mats afterwards (keepGuide defaults to true); call renderer.setGuide(null)
//    if the next scene shouldn't have him.
//
// Calling either function again while it runs returns the running promise (idempotent); calling
// runTutorial with a different sim aborts the old run (it resolves 'skipped') and starts over.

import type {
  AudioAPI,
  ClimberSimAPI,
  GuideLine,
  GuidePose,
  LimbControlsAPI,
  RendererAPI,
  SimEvent,
  SimOptions,
  TutorialContext,
  UIAPI,
} from '../core/contracts';
import type { BoulderDef, HoldDef, LimbId, Vec2 } from '../core/types';
import { bus } from '../core/events';
import { clamp } from '../core/math';
import { SIM } from '../config/tuning';
import { chalkBagAt, frictionWord, SHAKE_LANE, shakeLanePoint, spineUp } from '../input/release';
import { TUTORIAL_SEQUENCE, type TutorialStep } from '../game/generator';
import { Clock, Scope, isAborted } from './scope';
import { ensureTutorialStyles, IntroOverlay, overlayHost } from './overlay';
import * as S from './script';

// ═══════════════════════════════ public API ═══════════════════════════════

/** Sim options the app must use for the tutorial sim (see the header). */
export const TUTORIAL_SIM_OPTIONS: Readonly<Required<SimOptions>> = Object.freeze({ assist: 0.5, invincible: true });

export interface IntroContext {
  renderer: RendererAPI;
  ui: UIAPI;
  audio: AudioAPI;
  /** Optional app-level skip (the intro also shows its own SKIP chip). */
  skipSignal?: Promise<void>;
  /** Leave Steini standing on the mats afterwards (default true). */
  keepGuide?: boolean;
  /** Advanced: drive the script from your own loop (tests / headless). */
  clock?: Clock;
}

export interface TutorialRunContext extends TutorialContext {
  /** Leave Steini on the mats after the tutorial (default false). */
  keepGuide?: boolean;
  /** Advanced: drive the script from your own loop (tests / headless). */
  clock?: Clock;
}

export type TutorialPhase = 'idle' | 'intro' | 'opening' | 'lesson' | 'explain' | 'finale';

export interface TutorialStatus {
  running: boolean;
  phase: TutorialPhase;
  /** Index into TUTORIAL_SEQUENCE of the active lesson (-1 before the first). */
  step: number;
  total: number;
  /** The active lesson (limb + target hold), or null. */
  lesson: TutorialStep | null;
  /**
   * Set during a beat that isn't a plain move onto `lesson.holdId`:
   *  'stand-up'  the rescue's "stand up on that foot" (hips only; `lesson` is the foot + hold),
   *  'shake-out' let `lesson.limb` hang by the side (the sim's shake-out lane) and let go,
   *  'chalk'     dip `lesson.limb` into the chalk bag (drag it to the hips; on lead a forearm gauge tap works too).
   * (`lesson.holdId` is the hold that hand is on for the last two.)
   */
  beat: TutorialBeat | null;
  /**
   * 'shake-out' / 'chalk' beats: the wall-local point to let the hand go at right now (a spot of the
   * shake-out lane clear of holds, or the chalk bag); it moves with the body. Null otherwise.
   */
  target: Vec2 | null;
}

export type TutorialBeat = 'stand-up' | 'shake-out' | 'chalk';

const IDLE_STATUS: TutorialStatus = { running: false, phase: 'idle', step: -1, total: TUTORIAL_SEQUENCE.length, lesson: null, beat: null, target: null };

let activeIntro: { promise: Promise<void>; director: IntroDirector } | null = null;
let activeTutorial: { sim: ClimberSimAPI; promise: Promise<'done' | 'skipped'>; director: TutorialDirector } | null = null;

/** First-launch cinematic. Resolves when it ends or is skipped. */
export function runIntro(ctx: IntroContext): Promise<void> {
  if (activeIntro) return activeIntro.promise;
  const director = new IntroDirector(ctx);
  const entry = { director, promise: Promise.resolve() };
  entry.promise = director.run().finally(() => {
    if (activeIntro === entry) activeIntro = null;
  });
  activeIntro = entry;
  return entry.promise;
}

/** Steini's lesson on tutorialBoulder(). See the header for what the app must provide. */
export function runTutorial(ctx: TutorialRunContext): Promise<'done' | 'skipped'> {
  if (activeTutorial) {
    if (activeTutorial.sim === ctx.sim) return activeTutorial.promise;
    activeTutorial.director.supersede();
    activeTutorial = null;
  }
  const director = new TutorialDirector(ctx);
  const entry = { sim: ctx.sim, director, promise: Promise.resolve<'done' | 'skipped'>('skipped') };
  entry.promise = director.run().finally(() => {
    if (activeTutorial === entry) activeTutorial = null;
  });
  activeTutorial = entry;
  return entry.promise;
}

/** Optional: live progress of the running tutorial (QA, analytics, app chrome). */
export function tutorialStatus(): TutorialStatus {
  return activeTutorial ? activeTutorial.director.status() : activeIntro ? { ...IDLE_STATUS, running: true, phase: 'intro' } : IDLE_STATUS;
}

/** Optional: abort whatever is running (intro and/or tutorial), e.g. when the app tears down. */
export function abortTutorial(): void {
  activeIntro?.director.abort();
  activeTutorial?.director.abort();
}

// ═══════════════════════════════ shared stage ═══════════════════════════════

type GuideUI = UIAPI['guide'] & { setSkip?: (fn: (() => void) | null) => void };
type Pos = NonNullable<GuideLine['position']>;

/**
 * Where Steini stands on the mats (measured against the renderer's cameras on a 390×844 screen).
 * Every spot is on the SAME side, right of the start holds, where he ends the lesson (owner: "he
 * should stand on his final side from the beginning"): from the intro through the route reading,
 * the lessons and the finale he only ever takes a step or two, never crosses the mats.
 *  'intro'  right of the climber standing on the pads, both in the title shot;
 *  'wide'   low right of the start holds, fully in the route-preview shot, below the route's
 *           right-hand holds and clear of the climber (route reading + finale);
 *  'lesson' a step further right and back, off the right edge of the close follow camera, so the
 *           gameplay framing stays clean.
 */
export function guideSpot(b: BoulderDef | null, mode: 'intro' | 'wide' | 'lesson'): { x: number; depth: number } {
  const starts = b ? b.holds.filter((h) => h.role === 'start') : [];
  const cx = starts.length ? starts.reduce((a, h) => a + h.x, 0) / starts.length : 0;
  const hi = starts.length ? Math.max(...starts.map((h) => h.x)) : 0;
  const half = b ? b.width / 2 : 2.3;
  const x = mode === 'intro' ? cx + 0.95 : mode === 'wide' ? cx + 0.9 : hi + 1.25;
  return { x: clamp(x, -half + 0.45, half - 0.45), depth: mode === 'wide' ? 1.2 : mode === 'lesson' ? 1.45 : 1.3 };
}

/** The long-reach pump lesson ('shake') came before step i. */
function shakeTaught(steps: readonly TutorialStep[], i: number): boolean {
  for (let j = 0; j < i; j++) if (steps[j].teach === 'shake') return true;
  return false;
}

function topCenter(b: BoulderDef | null): Vec2 {
  if (!b) return { x: 0, y: 3.2 };
  const tops = b.holds.filter((h) => h.role === 'top');
  if (!tops.length) return { x: 0, y: b.height * 0.75 };
  return { x: tops.reduce((a, h) => a + h.x, 0) / tops.length, y: Math.max(...tops.map((h) => h.y)) };
}

/**
 * Base for both scripts: owns the clock + root scope, speech (with pause handling), Steini's pose,
 * skip wiring and teardown. Subclasses implement script().
 */
abstract class Director {
  protected readonly clock: Clock;
  protected readonly ownsClock: boolean;
  protected readonly root: Scope;
  protected spot = { x: -1.35, depth: 1.45 };
  protected time = 0;
  private paused = false;
  private pauseEpoch = 0;
  private lastLine: { line: S.Line; pos: Pos } | null = null;
  private waiting = false;
  private poseToken = 0;
  private basePose: { pose: GuidePose; look: Vec2 | null } = { pose: 'idle', look: null };
  private tornDown = false;
  protected aborted = false;

  constructor(
    protected readonly renderer: RendererAPI,
    protected readonly ui: UIAPI,
    protected readonly audio: AudioAPI,
    clock: Clock | undefined,
  ) {
    this.ownsClock = !clock;
    this.clock = clock ?? new Clock();
    this.root = new Scope(this.clock);
    this.root.every((dt) => {
      this.time += dt;
    });
    this.root.on('ui:pause', () => this.setPaused(true));
    this.root.on('ui:resume', () => this.setPaused(false));
    if (typeof document !== 'undefined') ensureTutorialStyles(document);
  }

  protected abstract script(): Promise<void>;
  protected abstract cleanup(): void;

  /** Abort the script (skip): synchronous teardown, the run promise settles right after. */
  abort(): void {
    if (this.tornDown) return;
    this.aborted = true;
    this.teardown();
  }

  protected async execute(): Promise<boolean> {
    try {
      await this.script();
      return !this.aborted;
    } catch (e) {
      if (!isAborted(e)) console.error('[tutorial] script failed', e);
      return false;
    } finally {
      this.teardown();
    }
  }

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.root.close();
    if (this.ownsClock) this.clock.stop();
    else this.clock.paused = false;
    try {
      this.cleanup();
    } catch (e) {
      console.error('[tutorial] cleanup failed', e);
    }
  }

  protected get guideUI(): GuideUI {
    return this.ui.guide as GuideUI;
  }

  // ── pause ──

  private setPaused(v: boolean): void {
    if (v === this.paused) return;
    this.paused = v;
    this.clock.paused = v;
    if (v) {
      this.pauseEpoch++;
      if (this.lastLine) this.ui.guide.hide();
    } else if (this.lastLine && !this.waiting) {
      void this.ui.guide.say({ text: this.lastLine.line.text, mood: this.lastLine.line.mood, position: this.lastLine.pos });
    }
  }

  /** Resolves on the next un-paused frame (immediately-ish when not paused). */
  private resumed(): Promise<boolean> {
    return this.paused ? this.root.until(() => true) : Promise.resolve(true);
  }

  // ── speech ──

  private bleat(soft: boolean): void {
    try {
      this.audio.play('guide', { volume: soft ? 0.55 : 0.85, pitch: 0.94 + Math.random() * 0.12 });
    } catch {
      /* audio is optional */
    }
  }

  /** Non-blocking line: shows and stays until replaced. */
  protected line(l: S.Line, pos: Pos = 'bottom', soft = false): void {
    if (this.root.isClosed) return;
    this.lastLine = { line: l, pos };
    this.waiting = false;
    this.bleat(soft);
    void this.ui.guide.say({ text: l.text, mood: l.mood, position: pos });
  }

  /**
   * Tap-to-continue line that also auto-advances after `auto` seconds (default: its hold time, see
   * S.holdTime, plus a beat to look at the scene). A tap always advances early. A pause in the
   * middle re-shows the line after resume.
   */
  protected async talk(l: S.Line, pos: Pos = 'bottom', auto?: number): Promise<void> {
    const wait = Math.max(auto ?? 0, S.holdTime(l.text) + TALK_EXTRA_S);
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = this.pauseEpoch;
      this.lastLine = { line: l, pos };
      this.waiting = true;
      this.bleat(false);
      const tap = this.ui.guide.say({ text: l.text, mood: l.mood, position: pos, waitForTap: true });
      try {
        await this.root.wait(Promise.race([tap, this.root.sleep(wait)]));
      } finally {
        this.waiting = false;
      }
      await this.resumed();
      if (this.pauseEpoch === epoch) return;
    }
  }

  protected sleep(sec: number): Promise<void> {
    return this.root.sleep(sec);
  }

  // ── Steini (guide NPC) ──

  protected setGuidePose(pose: GuidePose, look: Vec2 | null): void {
    if (this.root.isClosed) return;
    this.renderer.setGuide({ x: this.spot.x, depth: this.spot.depth, pose, lookAt: look ? { x: look.x, y: look.y } : undefined });
  }

  /** The pose Steini holds between reactions. */
  protected pose(pose: GuidePose, look: Vec2 | null = null): void {
    this.poseToken++;
    this.basePose = { pose, look };
    this.setGuidePose(pose, look);
  }

  /** A short reaction (clap, cheer, think) that falls back to the base pose. */
  protected react(pose: GuidePose, sec: number, look: Vec2 | null = this.basePose.look): void {
    const token = ++this.poseToken;
    this.setGuidePose(pose, look);
    this.root.timer(sec, () => {
      if (token === this.poseToken) this.setGuidePose(this.basePose.pose, this.basePose.look);
    });
  }

  /** Re-place Steini (instantly: do it on a camera cut or while he's off-screen). */
  protected moveGuide(spot: { x: number; depth: number }): void {
    this.spot = spot;
    this.setGuidePose(this.basePose.pose, this.basePose.look);
  }

  protected hideSpeech(): void {
    this.lastLine = null;
    this.ui.guide.hide();
  }
}

// ═══════════════════════════════ intro ═══════════════════════════════

const FLY_SECONDS = 7.5;
/** Extra beat on tap-to-continue lines so the player can also look at the scene (s). */
const TALK_EXTRA_S = 0.8;
/** The title card's staggered reveal and its fade-out (s), see src/tutorial/overlay.ts. */
const CARD_REVEAL_S = 0.6;
const CARD_LEAVE_S = 0.5;

class IntroDirector extends Director {
  private overlay: IntroOverlay | null = null;
  private readonly keepGuide: boolean;

  constructor(ctx: IntroContext) {
    super(ctx.renderer, ctx.ui, ctx.audio, ctx.clock);
    this.keepGuide = ctx.keepGuide ?? true;
    ctx.skipSignal?.then(
      () => this.abort(),
      () => undefined,
    );
  }

  async run(): Promise<void> {
    await this.execute();
  }

  protected async script(): Promise<void> {
    const r = this.renderer as RendererAPI & { playIntro?: (duration?: number) => Promise<void>; readonly introProgress?: number };
    const b = r.getBoulder();
    this.spot = guideSpot(b, 'intro');
    const wall = topCenter(b);

    // skip: the guide bubble's chip when the UI has one, else our own
    const skip = (): void => this.abort();
    if (typeof document !== 'undefined') this.overlay = new IntroOverlay(overlayHost(document));
    if (typeof this.guideUI.setSkip === 'function') this.guideUI.setSkip(skip);
    else this.overlay?.setSkip(skip);

    this.pose('wave', null);
    let landed = false;
    if (typeof r.playIntro === 'function') {
      void r.playIntro(FLY_SECONDS).then(() => {
        landed = true;
      });
    } else {
      r.setCameraMode('intro');
      this.root.timer(FLY_SECONDS, () => {
        landed = true;
      });
    }
    try {
      this.audio.play('whoosh', { volume: 0.6, pitch: 0.85 });
    } catch {
      /* optional */
    }
    // Steini: hello (waving), the idea, the goal (pointing at the wall)
    const [hello, idea, goal] = S.INTRO_LINES;
    const cardHold = S.cardHoldTime() + CARD_REVEAL_S;
    const estimate = 0.55 + cardHold + CARD_LEAVE_S + S.INTRO_LINES.reduce((a, l) => a + S.holdTime(l.text) + TALK_EXTRA_S, 0);
    let t = 0;
    this.root.every((dt) => {
      t += dt;
      this.overlay?.setProgress(t / estimate);
    });

    // title card over the fly-in: up long enough to read every word; a tap moves on early
    await this.sleep(0.55);
    this.overlay?.showCard();
    const beat = this.root.child();
    try {
      const tap = this.overlay?.waitForTap() ?? new Promise<void>(() => undefined);
      await beat.wait(Promise.race([tap, beat.sleep(cardHold)]));
    } finally {
      beat.close();
      this.overlay?.stopWaitingForTap();
    }
    this.overlay?.hideCard();
    await this.sleep(CARD_LEAVE_S);

    await this.talk(hello, 'bottom');
    this.pose('idle', null);
    await this.talk(idea, 'bottom');
    this.pose('point', wall);
    await this.talk(goal, 'bottom');
    this.hideSpeech();
    this.overlay?.setProgress(1);
    await this.root.until(() => landed, 2.5);
  }

  protected cleanup(): void {
    this.guideUI.setSkip?.(null);
    this.ui.guide.hide();
    this.overlay?.dispose();
    this.overlay = null;
    if (this.keepGuide) this.renderer.setGuide({ x: this.spot.x, depth: this.spot.depth, pose: 'idle', lookAt: topCenter(this.renderer.getBoulder()) });
    else this.renderer.setGuide(null);
  }
}

// ═══════════════════════════════ tutorial ═══════════════════════════════

const IDLE_NUDGE_S = 13;
const RESTORE_AFTER_MISTAKE_S = 3.4;
const MISTAKE_COOLDOWN_S = 1.6;
/** Full stretch without the target lighting up for this long = the move is out of reach from here. */
const STUCK_STRETCH_S = 4;
/** The rescue's stand-up beat moves on after this long without success. */
const STAND_UP_GIVE_UP_S = 28;
/** The shake-out / chalk beats move on after this long (or three misses) without it happening. */
const BEAT_GIVE_UP_S = 32;
/** How long the hand hangs and shakes before Steini asks for it back (s, game time). */
const SHAKE_OUT_HANG_S = 2.8;
/** Where a relaxed arm hangs in its shake-out lane: below the shoulder / out to its side (m). */
const HANG_DOWN = 0.42;
const HANG_OUT = 0.12;

interface LessonOutcome {
  /** The limb ended on the target hold. */
  placed: boolean;
  /** A 'shake-start' happened (or the climber shook) during the lesson. */
  shook: boolean;
}

interface LessonOptions {
  /** Custom success line (may wait a moment to decide). */
  success?: () => S.Line | Promise<S.Line>;
  /** Short success beat (the next line follows quickly). */
  quiet?: boolean;
  /** Give up (placed: false) when the target proves out of reach instead of waiting forever. */
  allowStuck?: boolean;
}

class TutorialDirector extends Director {
  private readonly sim: ClimberSimAPI;
  private readonly controls: LimbControlsAPI;
  private readonly keepGuide: boolean;
  private readonly holds = new Map<string, HoldDef>();
  private readonly steps: TutorialStep[];
  private readonly done = new Set<number>();
  /** The move being taught when it isn't steps[stepIdx] (rescue stand-up, the Phase B beats; reported by status()). */
  private beatLesson: TutorialStep | null = null;
  private beatKind: TutorialBeat | null = null;
  /** A shake-out / chalk beat is waiting for the hand to let go in its zone (status().target is live). */
  private beatArmed = false;
  /** The Phase B beats run once per tutorial. */
  private restDone = false;
  private chalkDone = false;
  private phase: TutorialPhase = 'opening';
  private stepIdx = -1;
  private superseded = false;
  private result: 'done' | 'skipped' = 'skipped';
  // once-per-tutorial tips
  private saidFirstDrag = false;
  private saidLetGo = false;
  private saidDeadpoint = false;
  private readonly mistakeAt = new Map<S.MistakeKind, number>();
  private readonly mistakeN = new Map<S.MistakeKind, number>();
  /** Hold time of the last mistake line (the instruction comes back only after it was readable). */
  private lastMistakeHold = 0;

  constructor(ctx: TutorialRunContext) {
    super(ctx.renderer, ctx.ui, ctx.audio, ctx.clock);
    this.sim = ctx.sim;
    this.controls = ctx.controls;
    this.keepGuide = !!ctx.keepGuide;
    for (const h of ctx.sim.boulder.holds) this.holds.set(h.id, h);
    this.steps = TUTORIAL_SEQUENCE.filter((s) => this.holds.has(s.holdId));
    ctx.skipSignal.then(
      () => this.abort(),
      () => undefined,
    );
    this.root.on('ui:quit', () => this.abort());
  }

  status(): TutorialStatus {
    const lesson = this.beatLesson ?? (this.stepIdx >= 0 && this.stepIdx < this.steps.length ? this.steps[this.stepIdx] : null);
    const beat = this.beatLesson ? this.beatKind : null;
    const target = this.beatLesson && this.beatArmed && (beat === 'shake-out' || beat === 'chalk') ? this.zonePoint(beat, this.beatLesson.limb === 'RH' ? 'RH' : 'LH') : null;
    return { running: true, phase: this.phase, step: this.stepIdx, total: this.steps.length, lesson, beat, target };
  }

  /** A newer runTutorial() took over: tear down quietly (no 'tutorial:done'). */
  supersede(): void {
    this.superseded = true;
    this.abort();
  }

  async run(): Promise<'done' | 'skipped'> {
    const ok = await this.execute();
    this.result = ok ? 'done' : 'skipped';
    if (!this.superseded) bus.emit('tutorial:done', { skipped: this.result === 'skipped' });
    return this.result;
  }

  protected cleanup(): void {
    this.renderer.setHoldHighlights([]);
    this.controls.setAllowed('all', true);
    this.guideUI.setSkip?.(null);
    this.ui.guide.hide();
    if (!this.keepGuide) this.renderer.setGuide(null);
    else this.renderer.setGuide({ x: this.spot.x, depth: this.spot.depth, pose: 'idle', lookAt: this.chest() });
  }

  // ── helpers ──

  private hold(id: string): HoldDef {
    return this.holds.get(id) as HoldDef;
  }

  private chest(): Vec2 {
    const c = this.sim.getState().chest;
    return { x: c.x, y: c.y };
  }

  private highlight(id: string | null): void {
    this.renderer.setHoldHighlights(id ? [{ holdId: id, kind: 'tutorial' }] : []);
  }

  private focus(h: HoldDef | null): void {
    this.renderer.setCameraMode('follow', h ? { focus: { x: h.x, y: h.y } } : undefined);
  }

  private chime(): void {
    try {
      this.audio.play('ui-confirm', { volume: 0.55 });
      this.audio.haptic(14);
    } catch {
      /* optional */
    }
  }

  private shaking(): boolean {
    const st = this.sim.getState();
    return st.shake > 0.02 || st.tension >= SIM.shakeOn;
  }

  private isPlaced(step: TutorialStep): boolean {
    const L = this.sim.getState().limbs[step.limb];
    return L.holdId === step.holdId && !L.dragging;
  }

  private isLastMatch(i: number): boolean {
    return this.steps[i].teach === 'match' && !this.steps.slice(i + 1).some((s) => s.teach === 'match');
  }

  /**
   * Which hand dips into the chalk bag: the one NOT on the jug (the other hangs on the best hold while
   * it is in the bag), else the more worn one, else `fallback`.
   */
  private chalkHand(fallback: 'LH' | 'RH'): 'LH' | 'RH' {
    const st = this.sim.getState();
    const jug = (l: 'LH' | 'RH'): boolean => {
      const id = st.limbs[l].holdId;
      return !!id && this.holds.get(id)?.type === 'jug';
    };
    if (jug('LH') !== jug('RH')) return jug('LH') ? 'RH' : 'LH';
    const fl = st.limbs.LH.friction ?? 1;
    const fr = st.limbs.RH.friction ?? 1;
    if (Math.abs(fl - fr) > 0.05) return fl < fr ? 'LH' : 'RH';
    return fallback;
  }

  /** The step's hand is on a big jug (a rest hold) now. */
  private onJug(step: TutorialStep): boolean {
    if (step.limb !== 'LH' && step.limb !== 'RH') return false;
    const id = this.sim.getState().limbs[step.limb].holdId;
    const h = id ? this.holds.get(id) : undefined;
    return !!h && h.type === 'jug';
  }

  /** A committed flick of the step's (hand) limb at its target would make it (the sim's throw preview). */
  private throwable(step: TutorialStep): boolean {
    if (step.limb !== 'LH' && step.limb !== 'RH') return false;
    const h = this.hold(step.holdId);
    const d = typeof this.sim.dynoCandidate === 'function' ? this.sim.dynoCandidate(step.limb, { x: h.x, y: h.y }) : null;
    return !!d && d.holdId === h.id && d.feasible;
  }

  /**
   * Where `hand` would let go for a beat right now: the chalk bag, or a spot of the hand's
   * shake-out lane (input/release.ts, mirrors the sim) clear of any hold it would grab instead,
   * as close as possible to where a relaxed arm hangs (well inside its reach, so the body doesn't
   * lean after the finger). Null when the whole lane is covered by holds.
   */
  private zonePoint(kind: 'shake-out' | 'chalk', hand: 'LH' | 'RH'): Vec2 | null {
    const st = this.sim.getState();
    const up = spineUp(st.pelvis, st.chest, { x: 0, y: 1 });
    if (kind === 'chalk') return chalkBagAt(st.pelvis, up, { x: 0, y: 0 });
    const A = st.limbs[hand].anchor;
    const idx = hand === 'LH' ? 0 : 1;
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    const p = { x: 0, y: 0 };
    for (let a = 1; a <= 5; a++) {
      for (let b = 1; b <= 5; b++) {
        const down = SHAKE_LANE.down0 + ((SHAKE_LANE.down1 - SHAKE_LANE.down0) * a) / 6;
        const out = SHAKE_LANE.out0 + ((SHAKE_LANE.out1 - SHAKE_LANE.out0) * b) / 6;
        shakeLanePoint(idx, A, up, down, out, p);
        if (this.sim.snapCandidate(hand, p)) continue;
        // clear of holds (up to a comfortable 15 cm), then nearest a relaxed hanging arm
        let clear = 1;
        for (const h of this.holds.values()) {
          if (h.role === 'deco') continue;
          clear = Math.min(clear, Math.hypot(h.x - p.x, h.y - p.y) - h.size);
        }
        const score = 2 * Math.min(clear, 0.15) - 0.5 * Math.hypot(down - HANG_DOWN, out - HANG_OUT);
        if (score > bestScore) {
          bestScore = score;
          best = { x: p.x, y: p.y };
        }
      }
    }
    return best;
  }

  // ── script ──

  protected async script(): Promise<void> {
    const { renderer, controls } = this;
    const wide = guideSpot(this.sim.boulder, 'wide');
    const lesson = guideSpot(this.sim.boulder, 'lesson');
    this.spot = wide;
    const top = topCenter(this.sim.boulder);
    if (typeof this.guideUI.setSkip === 'function') this.guideUI.setSkip(() => this.abort());

    controls.setAllowed([], false);
    this.highlight(null);

    // route reading
    this.phase = 'opening';
    renderer.setCameraMode('preview');
    this.pose('point', top);
    await this.sleep(0.7);
    const [routeLine, startTop] = S.tOpen(this.sim.boulder.color);
    await this.talk(routeLine, 'top');
    this.pose('idle', top);
    await this.talk(startTop, 'top');

    // on the wall: cut to the climbing camera; Steini steps off-frame for the lessons
    if (this.sim.getState().phase === 'idle') this.sim.start();
    renderer.setCameraMode('follow', { instant: true });
    this.moveGuide(lesson);
    this.pose('idle', this.chest());
    await this.sleep(0.9);
    await this.talk(S.T_HANDLES, 'top');

    let shakeFelt = false;
    for (let i = 0; i < this.steps.length; i++) {
      if (this.done.has(i)) continue;
      const step = this.steps[i];
      this.stepIdx = i;
      this.phase = 'lesson';
      const prev = i > 0 ? this.steps[i - 1] : null;
      // fresh chalk for the TOP moves: dip the hand that goes up first
      if (step.teach === 'match' && !this.chalkDone) {
        this.chalkDone = true;
        await this.chalkBeat(this.chalkHand(step.limb === 'RH' ? 'RH' : 'LH'));
      }
      if (step.teach === 'hips') {
        await this.hipsLesson(step);
      } else if (step.teach === 'shake') {
        shakeFelt = await this.shakeLesson(i);
      } else if (prev?.teach === 'shake' && step.limb !== prev.limb) {
        // "calm it with your feet": phrase it by what the player actually feels
        const copy = S.lessonCopy(step, i, false);
        if (!this.shaking()) copy.instruct = S.SHAKE.calmInstruct;
        await this.moveWithRescue(i, copy, {
          success: async () => {
            if (shakeFelt) await this.root.until(() => !this.shaking(), 0.9);
            return shakeFelt && !this.shaking() ? copy.success : S.SHAKE.calmSuccess;
          },
        });
      } else {
        const last = this.isLastMatch(i);
        // almost there: the HUD's MATCH & HOLD bar takes the SKIP chip's slot (pause → QUIT still skips)
        if (last) this.guideUI.setSkip?.(null);
        await this.moveWithRescue(i, S.lessonCopy(step, i, last), { quiet: last });
      }
      this.done.add(i);
      // the first big jug after the pump lesson is a rest: shake the other (pumped) arm out
      if (shakeTaught(this.steps, i) && !this.restDone && this.onJug(step)) {
        this.restDone = true;
        await this.shakeOutBeat(step.limb === 'LH' ? 'RH' : 'LH');
      }
    }
    await this.finale();
  }

  /**
   * A move lesson that can't trap the player: if the target turns out to be out of reach from the
   * current stance, Steini has them improve their feet first (an upcoming foot move that is in reach
   * now), then tries again; failing that, the lesson is let go and the climb continues.
   */
  private async moveWithRescue(i: number, copy: S.LessonCopy, opts: LessonOptions = {}): Promise<LessonOutcome> {
    const step = this.steps[i];
    const first = await this.moveLesson(step, copy, { ...opts, allowStuck: true });
    if (first.placed) return first;
    const second = await this.rescue(i, copy, opts);
    return { placed: second.placed, shook: first.shook || second.shook };
  }

  private async rescue(i: number, copy: S.LessonCopy, opts: LessonOptions): Promise<LessonOutcome> {
    const step = this.steps[i];
    const helper = this.findHelper(i);
    if (helper >= 0) {
      const h = this.steps[helper];
      this.highlight(null);
      this.pose('think', this.chest());
      this.phase = 'explain';
      await this.talk(S.RESCUE.feetFirst(h.limb), copy.pos);
      this.phase = 'lesson';
      this.stepIdx = helper;
      const foot = await this.moveLesson(h, S.lessonCopy(h, helper, false), { allowStuck: true });
      this.done.add(helper);
      this.stepIdx = i;
      // a high foot only helps once you stand up on it
      if (foot.placed) {
        this.beatLesson = { limb: h.limb, holdId: h.holdId, teach: 'hips' };
        this.beatKind = 'stand-up';
        try {
          await this.standUp(this.hold(h.holdId));
        } finally {
          this.beatLesson = null;
          this.beatKind = null;
        }
      }
    }
    const again = await this.moveLesson(step, { ...copy, instruct: helper >= 0 ? S.RESCUE.retry : copy.instruct }, { ...opts, allowStuck: true });
    if (!again.placed) {
      this.highlight(null);
      this.line(S.RESCUE.letGo, copy.pos);
      await this.sleep(S.holdTime(S.RESCUE.letGo.text));
    }
    return again;
  }

  /** An upcoming foot move that is in reach right now (the opposite foot first: it frees the reach). */
  private findHelper(i: number): number {
    const step = this.steps[i];
    const opposite: LimbId = step.limb === 'RH' || step.limb === 'RF' ? 'LF' : 'RF';
    let best = -1;
    let bestScore = -Infinity;
    for (let j = i + 1; j < this.steps.length; j++) {
      const s = this.steps[j];
      if (this.done.has(j) || (s.limb !== 'LF' && s.limb !== 'RF') || s.teach === 'hips') continue;
      if (this.isPlaced(s) || !this.sim.reachableHolds(s.limb).includes(s.holdId)) continue;
      const score = (s.limb === opposite ? 10 : 0) - (j - i);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    return best;
  }

  /**
   * One limb onto one hold. Gates the controls to that limb, highlights the hold, points Steini at
   * it, and waits until the sim has the limb on the hold. Handles wrong holds, misses, smears,
   * locked limbs, idle players, the hint button and reaches that are out of range.
   */
  private async moveLesson(step: TutorialStep, copy: S.LessonCopy, opts: LessonOptions = {}): Promise<LessonOutcome> {
    const { sim, controls } = this;
    const target = this.hold(step.holdId);
    const out: LessonOutcome = { placed: false, shook: false };
    if (this.isPlaced(step)) {
      out.placed = true;
      return out;
    }
    const s = this.root.child();
    try {
      controls.setAllowed([step.limb], false);
      this.highlight(step.holdId);
      this.focus(target);
      this.pose('point', target);
      this.line(copy.instruct, copy.pos);

      let fails = 0;
      let idle = 0;
      let nudges = 0;
      let dragging = false;
      let candidate: string | null = null;
      let stretchT = 0;
      let saidStretch = false;
      let stuck = false;
      /** A chalk dip is under way: its automatic 'return' to the hold is not a miss. */
      let chalking = false;
      let fromHold: string | null = sim.getState().limbs[step.limb].holdId;
      let restore: (() => void) | null = null;
      const scheduleRestore = (): void => {
        restore?.();
        restore = s.timer(Math.max(RESTORE_AFTER_MISTAKE_S, this.lastMistakeHold), () => {
          restore = null;
          if (!this.isPlaced(step) && !dragging) this.line(copy.instruct, copy.pos, true);
        });
      };
      /** The target is beyond reach from the current shoulder/hip (not just an overshoot past it). */
      const outOfReach = (): boolean => !sim.reachableHolds(step.limb).includes(step.holdId);
      /** Let go after straining at full stretch at a hold that's out of reach: this move doesn't work from here. */
      const strainedRelease = (): boolean => saidStretch && stretchT > 1.2 && outOfReach();
      const mistake = (kind: S.MistakeKind): void => {
        if (stuck && opts.allowStuck) return; // the lesson is about to hand over to the rescue
        if (this.sayMistake(kind, copy.pos)) scheduleRestore();
      };

      s.on('input:drag-start', (e) => {
        if (e.limb !== step.limb) return;
        dragging = true;
        idle = 0;
        restore?.();
        fromHold = sim.getState().limbs[step.limb].holdId ?? fromHold;
        if (!this.saidFirstDrag) {
          this.saidFirstDrag = true;
          this.line(S.DRAG_TIPS.firstDrag, copy.pos, true);
        }
      });
      s.on('input:drag-move', (e) => {
        if (e.limb !== step.limb) return;
        candidate = e.candidateHoldId;
        if (candidate !== step.holdId || this.saidLetGo) return;
        this.saidLetGo = true;
        this.line(S.DRAG_TIPS.letGo, copy.pos, true);
      });
      s.on('input:drag-end', (e) => {
        if (e.limb !== step.limb) return;
        dragging = false;
        candidate = null;
        if (strainedRelease()) stuck = true;
        stretchT = 0;
      });
      s.on('input:blocked', () => mistake('blocked'));
      s.on('ui:hint', () => {
        idle = 0;
        this.line(copy.nudge, copy.pos);
        this.react('point', 1.2, target);
      });
      s.on('sim:event', (e: SimEvent) => {
        if (e.type === 'shake-start') out.shook = true;
        if (e.type === 'dyno-miss') {
          // a flick that didn't stick: coach the throw (the invincible sim puts the hand back)
          if (e.limbs.includes(step.limb)) mistake('dyno-miss');
          return;
        }
        if (!('limb' in e) || e.limb !== step.limb) return;
        // (sim events of a drop arrive before input:drag-end)
        if ((e.type === 'return' || e.type === 'grab' || e.type === 'smear') && strainedRelease()) stuck = true;
        if (e.type === 'chalk-start') {
          // let go at the hips: the hand dips into the chalk bag and comes back by itself
          chalking = true;
          mistake('chalk');
        } else if (e.type === 'shake-out-start') {
          // let go down by the side: the arm hangs and shakes out until it is dragged again
          mistake('shake-out');
        } else if (e.type === 'grab' && e.holdId !== step.holdId) {
          fails++;
          mistake(e.holdId === fromHold ? 'short' : 'wrong');
        } else if (e.type === 'return') {
          if (chalking) {
            chalking = false;
            return;
          }
          fails++;
          mistake('return');
        } else if (e.type === 'smear') {
          fails++;
          mistake('smear');
        }
        if (fails === 3) s.timer(1.2, () => !stuck && this.sayMistake('struggle', copy.pos));
      });
      s.every((dt) => {
        if (dragging) {
          // a long reach: the hand is at full stretch short of the hold → the body has to follow
          const st = sim.getState();
          const L = st.limbs[step.limb];
          const short = candidate !== step.holdId;
          if (L.shake > 0.05 || st.shake > 0.05 || st.tension >= SIM.shakeOn) out.shook = true;
          // a stretch only counts toward the target: a hand dragged down by the side (the shake-out
          // lane) or off the other way is at full extension too, but not reaching for this hold
          const toward = Math.hypot(L.pos.x - target.x, L.pos.y - target.y) < Math.hypot(L.anchor.x - target.x, L.anchor.y - target.y);
          stretchT = L.reachRatio > 0.96 && short && toward ? stretchT + dt : short ? Math.max(0, stretchT - dt) : stretchT;
          if (stretchT > 0.8 && !saidStretch) {
            saidStretch = true;
            // a hand that could throw for it: teach the deadpoint flick instead of "keep holding"
            this.line(this.throwable(step) && !this.saidDeadpoint ? S.DRAG_TIPS.deadpoint : S.DRAG_TIPS.stretch, copy.pos, true);
            if (this.throwable(step)) this.saidDeadpoint = true;
          }
          if (stretchT > STUCK_STRETCH_S && !stuck && outOfReach()) stuck = true;
          return;
        }
        idle += dt;
        if (idle < IDLE_NUDGE_S + nudges * 4) return;
        idle = 0;
        nudges++;
        restore?.();
        this.line(nudges % 2 ? copy.nudge : copy.instruct, copy.pos);
        this.react('point', 1.4, target);
      });

      await s.until(() => this.isPlaced(step) || (!!opts.allowStuck && stuck && !dragging));
    } finally {
      s.close();
    }
    controls.setAllowed([], false);
    out.placed = this.isPlaced(step);
    if (!out.placed) return out;

    // success beat
    this.highlight(null);
    this.chime();
    this.react('clap', 1.3, this.chest());
    const praise = opts.success ? await opts.success() : copy.success;
    this.line(praise, copy.pos);
    // the praise stays readable before the next instruction replaces it (quiet: the finale follows)
    await this.sleep(opts.quiet ? 0.5 : S.holdTime(praise.text));
    return out;
  }

  /** The long reach: feel the shaking, learn about pump. Returns whether the player shook. */
  private async shakeLesson(i: number): Promise<boolean> {
    const step = this.steps[i];
    const copy = S.lessonCopy(step, i, false);
    const first = await this.moveLesson(step, copy, { allowStuck: true });
    if (first.placed) return this.explainShake(first.shook);
    // Out of reach from this stance. The overstretch itself is the lesson: name it, then fix the feet.
    const felt = await this.explainShake(first.shook || this.shaking());
    const again = await this.rescue(i, copy, {});
    return felt || again.shook;
  }

  /**
   * Rescue beat: stand up on a foot that was just placed high (drag the hip ring up). Gives up
   * gracefully after a few tries so it can never trap the player.
   */
  private async standUp(footHold: HoldDef): Promise<void> {
    const { sim, controls } = this;
    const y0 = sim.getState().pelvis.y;
    const need = 0.12;
    const pos: Pos = 'top';
    let best = 0;
    let drags = 0;
    let elapsed = 0;
    const s = this.root.child();
    try {
      controls.setAllowed([], true);
      this.highlight(footHold.id);
      this.pose('point', footHold);
      this.line(S.RESCUE.standUp, pos);
      let dragging = false;
      let held = 0;
      let idle = 0;
      s.on('input:hip-start', () => {
        dragging = true;
        idle = 0;
      });
      s.on('input:hip-end', () => {
        dragging = false;
        drags++;
        if (held === 0 && best > 0.02) this.line(S.RESCUE.higher, pos, true);
      });
      s.on('input:blocked', () => this.sayMistake('blocked', pos));
      s.on('ui:hint', () => this.line(S.RESCUE.standNudge, pos));
      s.every((dt) => {
        if (dragging) return;
        idle += dt;
        if (idle < IDLE_NUDGE_S) return;
        idle = 0;
        this.line(S.RESCUE.standNudge, pos);
      });
      await s.until((dt) => {
        elapsed += dt;
        const rise = sim.getState().pelvis.y - y0;
        if (rise > best) best = rise;
        held = rise >= need ? held + dt : 0;
        // done, or move on after a few tries / half a minute: this beat must never trap anyone
        return held >= 0.25 || (!dragging && (drags >= 3 || elapsed > STAND_UP_GIVE_UP_S));
      });
    } finally {
      s.close();
    }
    controls.setAllowed([], false);
    this.highlight(null);
    if (best >= need) {
      this.chime();
      this.line(S.RESCUE.stood, pos);
      this.react('clap', 1.3, this.chest());
      await this.sleep(S.holdTime(S.RESCUE.stood.text));
    }
  }

  /**
   * Rest beat (Phase B): on a big jug after the pump lesson, the other, pumped hand lets go down by the
   * side (the sim's shake-out lane), hangs and shakes for a moment, then goes back on its hold. Gives
   * up after a few misses or half a minute, so it never traps anyone.
   */
  private async shakeOutBeat(hand: 'LH' | 'RH'): Promise<void> {
    const { sim, controls } = this;
    const home = sim.getState().limbs[hand].holdId;
    if (!home || typeof sim.shakeOut !== 'function' || !this.zonePoint('shake-out', hand)) return;
    const pos: Pos = 'top';
    const instruct = S.SHAKE_OUT.instruct(hand);
    const nudge = S.SHAKE_OUT.nudge(hand);
    let started = false;
    this.beatLesson = { limb: hand, holdId: home, teach: 'hand' };
    this.beatKind = 'shake-out';
    this.beatArmed = true;
    const s = this.root.child();
    try {
      controls.setAllowed([hand], false);
      this.highlight(null);
      this.focus(null);
      this.pose('point', this.chest());
      this.line(instruct, pos);
      let dragging = false;
      let misses = 0;
      let idle = 0;
      let nudges = 0;
      let elapsed = 0;
      s.on('input:drag-start', (e) => {
        if (e.limb !== hand) return;
        dragging = true;
        idle = 0;
      });
      s.on('input:drag-end', (e) => {
        if (e.limb === hand) dragging = false;
      });
      s.on('input:blocked', () => this.sayMistake('blocked', pos));
      s.on('ui:hint', () => {
        idle = 0;
        this.line(nudge, pos);
      });
      s.on('sim:event', (e: SimEvent) => {
        if (!('limb' in e) || e.limb !== hand || started) return;
        if (e.type === 'shake-out-start') {
          // it hangs: no more drags until Steini asks for it back
          started = true;
          this.beatArmed = false;
          controls.setAllowed([], false);
        } else if (e.type === 'return' || e.type === 'grab' || e.type === 'smear' || e.type === 'chalk-start') {
          misses++;
          this.line(S.SHAKE_OUT.free, pos, true);
        }
      });
      s.every((dt) => {
        if (dragging) return;
        idle += dt;
        if (idle < IDLE_NUDGE_S + nudges * 4) return;
        idle = 0;
        nudges++;
        this.line(nudges % 2 ? nudge : instruct, pos);
        this.react('point', 1.4, this.chest());
      });
      await s.until((dt) => {
        elapsed += dt;
        return started || (!dragging && (misses >= 3 || elapsed > BEAT_GIVE_UP_S));
      });
    } finally {
      s.close();
      this.beatArmed = false;
      if (!started) {
        this.beatLesson = null;
        this.beatKind = null;
      }
    }
    controls.setAllowed([], false);
    if (started) {
      // let it hang: the forearm recovers while the arm shakes by the side
      this.react('clap', 1.0, this.chest());
      const shaking = S.SHAKE_OUT.shaking(hand, (sim.getState().limbs[hand].pump ?? 0) > 0.12);
      this.line(shaking, pos);
      await this.sleep(Math.max(SHAKE_OUT_HANG_S, S.readTime(shaking.text)));
    } else {
      this.line(S.SHAKE_OUT.skip, pos);
      await this.sleep(S.holdTime(S.SHAKE_OUT.skip.text));
    }
    // …and back on the hold it left (also after a miss onto another hold); status() reports that move
    if (sim.getState().limbs[hand].holdId === home) return;
    const back: TutorialStep = { limb: hand, holdId: home, teach: 'hand' };
    this.beatLesson = back;
    this.beatKind = null;
    try {
      const copy = S.SHAKE_OUT.back(hand);
      await this.moveLesson(back, started ? copy : { ...copy, instruct: S.backOn(hand), success: S.PRAISE_BACK }, { allowStuck: true });
    } finally {
      this.beatLesson = null;
    }
  }

  /**
   * Chalk beat (Phase B) before the TOP moves: dip `hand` into the chalk bag, by dragging it to the
   * hips or tapping its forearm gauge. Phrased by what the HUD shows for that hand (FRESH / WORN /
   * GREASY). The hand comes back to its hold by itself. Never traps: gives up like the rest beat.
   */
  private async chalkBeat(hand: 'LH' | 'RH'): Promise<void> {
    const { sim, controls } = this;
    const st = sim.getState();
    const home = st.limbs[hand].holdId;
    const other = st.limbs[hand === 'LH' ? 'RH' : 'LH'];
    if (!home || !other.holdId || st.phase !== 'climbing' || typeof sim.chalkUp !== 'function') return;
    const pos: Pos = 'top';
    const instruct = S.CHALK.instruct(hand, frictionWord(st.limbs[hand].friction ?? 1));
    const nudge = S.CHALK.nudge(hand);
    let started = false;
    this.beatLesson = { limb: hand, holdId: home, teach: 'hand' };
    this.beatKind = 'chalk';
    this.beatArmed = true;
    const s = this.root.child();
    try {
      controls.setAllowed([hand], false);
      this.highlight(null);
      this.focus(null);
      this.pose('point', this.chest());
      this.line(instruct, pos);
      let dragging = false;
      let misses = 0;
      let idle = 0;
      let nudges = 0;
      let elapsed = 0;
      s.on('input:drag-start', (e) => {
        if (e.limb !== hand) return;
        dragging = true;
        idle = 0;
      });
      s.on('input:drag-end', (e) => {
        if (e.limb === hand) dragging = false;
      });
      s.on('input:blocked', () => this.sayMistake('blocked', pos));
      s.on('ui:hint', () => {
        idle = 0;
        this.line(nudge, pos);
      });
      s.on('sim:event', (e: SimEvent) => {
        if (!('limb' in e) || e.limb !== hand || started) return;
        if (e.type === 'chalk-start') {
          // in the bag: it comes back by itself, hands off meanwhile
          started = true;
          this.beatArmed = false;
          controls.setAllowed([], false);
        } else if (e.type === 'return' || e.type === 'grab' || e.type === 'smear' || e.type === 'shake-out-start') {
          misses++;
          this.line(S.CHALK.miss, pos, true);
        }
      });
      s.every((dt) => {
        if (dragging) return;
        idle += dt;
        if (idle < IDLE_NUDGE_S + nudges * 4) return;
        idle = 0;
        nudges++;
        this.line(nudges % 2 ? nudge : instruct, pos);
        this.react('point', 1.4, this.chest());
      });
      await s.until((dt) => {
        elapsed += dt;
        return started || (!dragging && (misses >= 3 || elapsed > BEAT_GIVE_UP_S));
      });
      if (started) {
        this.line(S.CHALK.dipping, pos, true);
        // the dip takes SIM.chalkTime; the hand then goes back onto its hold by itself
        await s.until(() => {
          const L = sim.getState().limbs[hand];
          return !L.chalking && !L.busy && !L.dragging;
        }, SIM.chalkTime + 3);
      }
    } finally {
      s.close();
      this.beatArmed = false;
      this.beatLesson = null;
      this.beatKind = null;
    }
    controls.setAllowed([], false);
    const after = started ? S.CHALK.success : S.CHALK.skip;
    if (started) {
      this.chime();
      this.react('clap', 1.3, this.chest());
    }
    this.line(after, pos);
    await this.sleep(S.holdTime(after.text));
    // a hand that wandered off its hold (a miss onto another hold, a shake-out) goes back on first
    if (sim.getState().limbs[hand].holdId !== home && this.holds.has(home)) {
      const back: TutorialStep = { limb: hand, holdId: home, teach: 'hand' };
      this.beatLesson = back;
      try {
        await this.moveLesson(back, { ...S.SHAKE_OUT.back(hand), instruct: S.backOn(hand), success: S.PRAISE_BACK }, { allowStuck: true, quiet: true });
      } finally {
        this.beatLesson = null;
      }
    }
  }

  /** Weight shift: drag the hip ring over the foot that's already on `step.holdId`. */
  private async hipsLesson(step: TutorialStep): Promise<void> {
    const { sim, controls } = this;
    const h = this.hold(step.holdId);
    const st0 = sim.getState();
    const x0 = st0.pelvis.x;
    const sideDir = step.limb === 'LF' || step.limb === 'LH' ? -1 : 1;
    const dir = Math.abs(h.x - x0) > 0.02 ? Math.sign(h.x - x0) : sideDir;
    const dirWord: 'left' | 'right' = dir < 0 ? 'left' : 'right';
    const need = Math.max(0.05, Math.abs(h.x - x0) * 0.7);
    const pos: Pos = 'top';
    const s = this.root.child();
    try {
      controls.setAllowed([], true);
      this.highlight(step.holdId);
      this.focus(h);
      this.pose('point', h);
      const instruct = S.HIPS.instruct(step.limb, dirWord);
      const nudge = S.HIPS.nudge(step.limb, dirWord);
      this.line(instruct, pos);

      let touched = false;
      let dragging = false;
      let held = 0;
      let idle = 0;
      let nudges = 0;
      let best = 0;
      s.on('input:hip-start', () => {
        touched = true;
        dragging = true;
        idle = 0;
      });
      s.on('input:hip-end', () => {
        dragging = false;
        if (held > 0) return;
        if (best > 0.015) this.line(S.HIPS.further(dirWord), pos, true);
      });
      s.on('input:blocked', () => this.sayMistake('blocked', pos));
      s.on('ui:hint', () => {
        idle = 0;
        this.line(nudge, pos);
      });
      s.every((dt) => {
        if (dragging) return;
        idle += dt;
        if (idle < IDLE_NUDGE_S + nudges * 4) return;
        idle = 0;
        nudges++;
        this.line(nudges % 2 ? nudge : instruct, pos);
        this.react('point', 1.4, h);
      });
      await s.until((dt) => {
        const px = sim.getState().pelvis.x;
        const moved = (px - x0) * dir;
        if (moved > best) best = moved;
        const ok = touched && (moved >= need || Math.abs(px - h.x) <= 0.06);
        held = ok ? held + dt : 0;
        return held >= 0.25;
      });
    } finally {
      s.close();
    }
    controls.setAllowed([], false);
    this.highlight(null);
    this.chime();
    this.line(S.HIPS.success, pos);
    this.react('clap', 1.3, this.chest());
    await this.sleep(S.holdTime(S.HIPS.success.text));
  }

  /** After the long reach: name what the player feels (or would feel), then explain pump. */
  private async explainShake(shookDuringReach: boolean): Promise<boolean> {
    this.phase = 'explain';
    this.highlight(null);
    let felt = shookDuringReach || this.shaking();
    if (!felt) felt = await this.root.until(() => this.shaking(), 1.6);
    this.pose('think', this.chest());
    try {
      this.audio.haptic([18, 60, 18]);
    } catch {
      /* optional */
    }
    await this.talk(felt ? S.SHAKE.felt : S.SHAKE.concept, 'bottom');
    this.pose('idle', this.chest());
    await this.talk(S.SHAKE.pump, 'bottom');
    this.phase = 'lesson';
    return felt;
  }

  private sayMistake(kind: S.MistakeKind, pos: Pos): boolean {
    const last = this.mistakeAt.get(kind) ?? -99;
    if (this.time - last < MISTAKE_COOLDOWN_S) return false;
    this.mistakeAt.set(kind, this.time);
    const n = this.mistakeN.get(kind) ?? 0;
    this.mistakeN.set(kind, n + 1);
    const pool = S.MISTAKES[kind];
    const l = pool[n % pool.length];
    this.lastMistakeHold = S.holdTime(l.text);
    this.line(l, pos, true);
    return true;
  }

  private async finale(): Promise<void> {
    const { sim, controls, renderer, ui } = this;
    this.phase = 'finale';
    this.guideUI.setSkip?.(null);
    controls.setAllowed([], false);
    this.highlight(null);
    // safety net: make sure both hands really are on TOP (re-run the match lesson if not)
    const topIds = new Set(sim.boulder.holds.filter((h) => h.role === 'top').map((h) => h.id));
    const topId = [...topIds][0];
    for (let tries = 0; tries < 2 && topId && sim.getState().phase !== 'topped'; tries++) {
      if (await this.root.until(() => sim.getState().phase === 'topped', 2.2)) break;
      const st = sim.getState();
      const missing = (['LH', 'RH'] as const).find((l) => !topIds.has(st.limbs[l].holdId ?? ''));
      if (!missing) continue;
      this.sayMistake('off-top', 'bottom');
      await this.sleep(1.2);
      const step: TutorialStep = { limb: missing, holdId: topId, teach: 'match' };
      await this.moveLesson(step, S.lessonCopy(step, 99, true), { quiet: true, allowStuck: true });
    }
    const sent = await this.root.until(() => sim.getState().phase === 'topped', 2.2);

    const t = topCenter(sim.boulder);
    if (sent) {
      renderer.setCameraMode('celebrate');
      ui.hud.callout('SENT!', 'good');
      try {
        renderer.fx.confetti(t);
        this.audio.play('send');
        this.audio.haptic([30, 50, 30, 50, 80]);
      } catch {
        /* optional */
      }
      this.pose('cheer', t);
      await this.sleep(1.6);
      // cut to the wide shot: the topped-out climber up there, Steini cheering on the mats
      renderer.setCameraMode('preview', { instant: true });
      this.moveGuide(guideSpot(sim.boulder, 'wide'));
      this.pose('cheer', t);
      await this.talk(S.FINALE[0], 'bottom');
    } else {
      // never trap anyone in the tutorial: the idea landed, the real wall awaits
      this.pose('idle', this.chest());
      await this.talk(S.RESCUE.almost, 'bottom');
    }
    this.pose('idle', this.chest());
    await this.talk(S.FINALE[1], 'bottom');
    this.pose('point', t);
    await this.talk(S.FINALE[2], 'bottom');
    this.hideSpeech();
  }
}

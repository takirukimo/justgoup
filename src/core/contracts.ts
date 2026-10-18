// Module contracts. Each subsystem implements one of these interfaces; the app (src/app/*)
// wires them together. Do NOT change a signature here without updating every implementer —
// add optional members instead.

import type {
  BoulderDef,
  ChalkId,
  ClimberState,
  ColorwayId,
  CommunityProblem,
  HeadId,
  HoldDef,
  LeaderboardMode,
  LimbId,
  Profile,
  QualityLevel,
  QuickdrawDef,
  RouteStyle,
  RunInfo,
  ScoreEntry,
  Vec2,
} from './types';

// ═══════════════════════════════ SIM (src/game) ═══════════════════════════════

export type FallReason = 'pump' | 'slip' | 'no-hands' | 'no-contact' | 'barn-door' | 'forced';

export type SimEvent =
  | { type: 'grab'; limb: LimbId; holdId: string; quality: number }
  | { type: 'release'; limb: LimbId; holdId: string | null }
  | { type: 'return'; limb: LimbId; holdId: string | null } // drag ended on nothing → limb went back
  | { type: 'smear'; limb: LimbId }
  | { type: 'slip'; limb: LimbId; holdId: string }
  | { type: 'overload'; limb: LimbId } // stress crossed 1.0 upward
  | { type: 'shake-start' }
  | { type: 'shake-end' }
  | { type: 'fall'; reason: FallReason }
  | { type: 'land'; impact: number } // boulder: hit the crash pad (impact = m/s)
  | { type: 'caught'; fallDistance: number } // rope: caught by the rope
  | { type: 'ground-fall' } // rope: decked (run over)
  | { type: 'top-touch'; limb: LimbId } // a hand reached the top hold
  | { type: 'top' } // matched top long enough → SENT
  | { type: 'clip'; quickdrawId: string }
  | { type: 'clip-done'; quickdrawId: string; limb: LimbId }
  // ── Phase B body model (additive) ──
  | { type: 'chalk-start'; limb: LimbId } // the hand let go and dips into the chalk bag (busy ≈1 s)
  | { type: 'chalk-done'; limb: LimbId } // friction restored; a 'return' follows when it is back on its hold
  | { type: 'shake-out-start'; limb: LimbId } // a free hand hangs by the side and shakes the forearm out
  | { type: 'shake-out-end'; limb: LimbId }
  | { type: 'pump-warning'; limb: LimbId; pump: number } // this forearm crossed SIM.pumpWarn (deep pump)
  | { type: 'technique'; limb: LimbId; technique: 'heel' | 'toe' | 'flag' | 'drop' } // a foot technique began
  | { type: 'dyno-start'; limbs: LimbId[]; holdId: string; kind: 'deadpoint' | 'dyno'; power: number }
  | { type: 'dyno-catch'; limbs: LimbId[]; holdId: string; quality: number; timing: number } // timing: s vs the apex (− = rising)
  | { type: 'dyno-miss'; limbs: LimbId[]; holdId: string; reason: 'short' | 'ripped' };

/** Optional second argument of endDrag (Phase B): how the finger left the screen. */
export interface ReleaseOptions {
  /**
   * Finger velocity at release, wall-local m/s. A hand dragged beyond its static reach toward a hold
   * and flicked toward it (≥ SIM.dynoMinFlick along the line to the hold) throws a deadpoint / dyno.
   */
  velocity?: Vec2;
}

/** What a committed release (flick) of a hand at a point would throw to (input preview). */
export interface DynoPreview {
  holdId: string;
  /** 'deadpoint' (the other hand stays on) or 'dyno' (both hands go). */
  kind: 'deadpoint' | 'dyno';
  /** Body rise (m) the throw needs beyond the static reach. */
  rise: number;
  /** False when the climber can't throw that far from this stance (the throw would fall short). */
  feasible: boolean;
}

export interface SimOptions {
  /** 0 = normal, 1 = very forgiving (tutorial / assist). Scales capacities up and pump down. */
  assist?: number;
  /** Disable falling entirely (tutorial early steps, editor preview). */
  invincible?: boolean;
}

export interface ClimberSimAPI {
  readonly boulder: BoulderDef;
  /** Place the climber on the start holds (hands on start holds, feet on nearest footholds). phase = 'idle'. */
  reset(): void;
  /** Switch from 'idle' to 'climbing' (starts the clock + pump). */
  start(): void;
  /** Advance the simulation. Internally sub-steps at a fixed rate. Returns events that happened. */
  step(dt: number): SimEvent[];
  getState(): ClimberState;

  // ── limb input ──
  /** Detach a limb so the player can move it. Returns false if not allowed (phase, busy…). */
  beginDrag(limb: LimbId): boolean;
  /** Desired endpoint for the dragged limb (wall-local). The sim clamps it to reach. */
  dragTo(limb: LimbId, p: Vec2): void;
  /**
   * Drop the limb: grabs the snap candidate, clips a quickdraw (hands, rope mode), smears (feet), or returns.
   * Phase B: a foot dropped far out to the side flags; a hand dropped down beside the body shakes out, at the
   * hips it chalks up; with `opts.velocity` a committed flick toward an out-of-reach hold throws a dyno.
   */
  endDrag(limb: LimbId, opts?: ReleaseOptions): SimEvent[];
  /** Weight-shift input: pull the hips toward p (wall-local). null releases. */
  setHipTarget(p: Vec2 | null): void;

  // ── queries for UI / input / highlights ──
  /** Hold the dragged limb would grab if released at p, or null. Respects role/limb rules + reach. */
  snapCandidate(limb: LimbId, p: Vec2): HoldDef | null;
  /** Quickdraw a hand released at p would clip, or null (rope mode). */
  clipCandidate(limb: LimbId, p: Vec2): QuickdrawDef | null;
  /** 0..1 predicted grip quality if `limb` grabbed `holdId` with the current body position. */
  predictGrip(limb: LimbId, holdId: string): number;
  /** Hold ids usable by `limb` and currently within its reach. */
  reachableHolds(limb: LimbId): string[];
  /** Shoulder (hands) / hip (feet) position, wall-local. */
  limbAnchor(limb: LimbId): Vec2;
  maxReach(limb: LimbId): number;

  // ── rope mode ──
  /** Rope anchor (last clipped quickdraw, or belayer) and available rope length; null = no rope. */
  setRope(anchor: Vec2 | null, ropeLength: number): void;
  /** Put the climber back on the wall after being caught: limb → hold id. phase → 'climbing'. */
  respawn(placement: Partial<Record<LimbId, string>>): void;

  forceFall(): void;

  // ── Phase B (optional; ClimberSim implements all of them) ──
  /** Take a hand off and dip it into the chalk bag (≈ SIM.chalkTime); false if not allowed right now. */
  chalkUp?(hand: 'LH' | 'RH'): boolean;
  /** Let go with a hand and shake it out by the side (the other hand must hold); false if not allowed. */
  shakeOut?(hand: 'LH' | 'RH'): boolean;
  /** Throw a deadpoint ('LH' / 'RH') or a double-hand dyno ('both') at a hold; power 1 = ideal. */
  dyno?(limb: 'LH' | 'RH' | 'both', holdId: string, power?: number): SimEvent[];
  /** What a committed flick of the dragged hand released at p would throw to, or null. */
  dynoCandidate?(limb: LimbId, p: Vec2): DynoPreview | null;
}

export interface BetaMove {
  limb: LimbId;
  holdId: string;
  /**
   * Optional (Phase B): the move is thrown — 'LH' / 'RH' a deadpoint with that hand, 'both' a double-hand
   * dyno (both hands go to `holdId`; `limb` is the left hand). Execute it with ClimberSimAPI.dyno.
   */
  dyno?: 'LH' | 'RH' | 'both';
}

// Function signatures exported by src/game/*.ts (documented here for implementers):
//   generator.ts : generateBoulder(opts: GenerateOptions): BoulderDef
//                  generateRopeRoute(opts: GenerateOptions): BoulderDef
//                  tutorialBoulder(): BoulderDef
//                  dailyBoulder(dateKey: string): BoulderDef
//                  todayKey(date?: Date): string   // 'YYYY-MM-DD' (UTC)
//   solver.ts    : planBeta(boulder: BoulderDef, opts?: { maxMs?: number }): BetaMove[] | null
//                  nextHint(sim: ClimberSimAPI): BetaMove | null
//                  estimateGrade(boulder: BoulderDef): number
//   scoring.ts   : scoreSend(p: SendScoreInput): SendScore ; parTime(b: BoulderDef): number
//                  runGradeFor(streak: number, rng: Rng): number
//   rope.ts      : class RopeSystem implements RopeSystemAPI
//   grades.ts    : gradeLabel(g: number): string  ('V4')  ; fontGrade(g): string ('6B')

export interface GenerateOptions {
  seed: number;
  grade: number; // 0..12
  mode?: 'boulder' | 'rope';
  wallAngle?: number; // override
  colorIndex?: number; // into ROUTE_COLORS
  name?: string;
  // ── Phase B (all optional) ──
  /** Route archetype to set (boulders). Default: picked from the seed and the grade (or from `run`). */
  style?: RouteStyle;
  /**
   * A run of problems (Send Train): problem `index` of the run seeded `seed`. The generator picks the
   * archetype so consecutive problems of a run always differ (game/generator.ts runStyle).
   */
  run?: { seed: number; index: number };
  /** Multi-angle wall profiles for this problem (default: tuning GEN.profiles). */
  profiles?: boolean;
}

export interface SendScoreInput {
  grade: number;
  time: number; // seconds
  par: number; // seconds
  flash: boolean; // no slips / never critical tension
  streak: number; // sends before this one in the run
  hintsUsed: number;
}

export interface SendScore {
  points: number;
  breakdown: { label: string; value: number }[];
}

export interface RopeSystemAPI {
  readonly quickdraws: QuickdrawDef[];
  readonly clipped: string[];
  clip(id: string): void;
  isClipped(id: string): boolean;
  lastClip(): QuickdrawDef | null;
  nextClip(): QuickdrawDef | null;
  /** Belayer position (wall-local, on the floor). */
  belayer(): Vec2;
  /** Polyline belayer → clipped draws (in order) → harness. */
  ropePath(harness: Vec2): Vec2[];
  /** Anchor + rope length the sim should use for a fall right now. */
  catchParams(harness: Vec2): { anchor: Vec2; length: number };
  /** Predicts a fall from the current harness height. */
  fallOutcome(harness: Vec2): { groundFall: boolean; fallDistance: number; catchY: number };
}

// ═══════════════════════════════ RENDER (src/render) ═══════════════════════════════

export type CameraMode =
  | 'title' // slow cinematic orbit of the wall behind the title UI
  | 'intro' // scripted fly-in toward the wall (first launch)
  | 'preview' // pulled back to read the whole route
  | 'follow' // gameplay: framing the climber
  | 'editor' // straight-on, whole wall, for placing holds
  | 'celebrate' // swing around the climber after a send
  | 'fall'; // dramatic follow of a fall

export type HighlightKind =
  | 'reachable' // usable + in reach of the dragged limb (subtle)
  | 'candidate' // the snap target under the finger (strong; colour by quality)
  | 'hint' // suggested next move (pulsing)
  | 'tutorial' // tutorial target (pulsing ring + arrow)
  | 'selected'; // editor selection

export interface HoldHighlight {
  holdId: string;
  kind: HighlightKind;
  /** 0..1 grip quality for 'candidate' (red → amber → green). */
  quality?: number;
}

export type GuidePose = 'idle' | 'wave' | 'point' | 'clap' | 'cheer' | 'think' | 'belay';

export interface GuideState {
  /** Wall-local position on the floor/mats in front of the wall (x, depth). */
  x: number;
  depth: number;
  pose: GuidePose;
  /** Optional wall-local point the guide looks/points at. */
  lookAt?: Vec2;
}

export interface ScreenPoint {
  x: number; // CSS px relative to the canvas' top-left
  y: number;
  visible: boolean; // in front of the camera and inside the viewport
}

export interface RendererAPI {
  readonly canvas: HTMLCanvasElement;
  /** Build the persistent scene (gym environment, lights, climber model). */
  init(): Promise<void>;
  setQuality(q: QualityLevel): void;
  /** Call when the container size changes (also listens to window resize itself). */
  resize(): void;

  /** Build wall panel, holds, volumes, quickdraws for this problem. Replaces the previous one. */
  loadBoulder(b: BoulderDef): void;
  /** Rebuild just the holds after an edit (editor), keeping the wall. */
  updateHolds(holds: HoldDef[]): void;
  getBoulder(): BoulderDef | null;

  setClimberVisible(v: boolean): void;
  /** Pose the climber from sim state (called every frame while a sim runs). */
  updateClimber(state: ClimberState, dt: number): void;
  setSkin(head: HeadId, colorway: ColorwayId, chalk: ChalkId): void;

  /** Rope mode: polyline belayer → draws → harness (wall-local) or null to hide; clipped ids to show clipped draws. */
  setRope(path: Vec2[] | null, clippedIds: string[]): void;
  setHoldHighlights(h: HoldHighlight[]): void;
  /** Tutorial guide NPC (Steini the ibex) standing on the mats. null hides it. */
  setGuide(g: GuideState | null): void;

  setCameraMode(mode: CameraMode, opts?: { instant?: boolean; focus?: Vec2 }): void;
  /** Extra framing hint for 'follow' (e.g. the point being dragged), null to clear. */
  setCameraFocusHint(p: Vec2 | null): void;
  /** 'editor' camera: straight-on view centred on `center` showing `metersVisible` of wall height (pinch-zoom/pan). */
  setEditorView(center: Vec2, metersVisible: number): void;
  /** Offscreen-rendered 3/4 portrait of an animal head (PNG data URL, cached). Used by the locker + guide bubble. */
  portrait(head: HeadId, size?: number): string;

  /** Project a wall-local point (at `depth` m from the wall) to canvas CSS pixels. */
  wallToScreen(p: Vec2, depth?: number): ScreenPoint;
  /** Ray-cast canvas CSS pixels onto the wall plane → wall-local, or null if off-wall. */
  screenToWall(x: number, y: number): Vec2 | null;
  /** Approximate on-screen pixels per wall meter around p (for sizing touch targets/arcs). */
  pxPerMeter(p: Vec2): number;

  fx: {
    chalkPuff(p: Vec2, intensity?: number): void;
    dust(p: Vec2, intensity?: number): void; // crash-pad landing
    confetti(p: Vec2): void; // send celebration (chalk-coloured)
    cameraShake(amount: number): void; // 0..1 transient
  };

  /** Advance animations + draw one frame. */
  frame(dt: number): void;
  dispose(): void;
}

// ═══════════════════ CHARACTER (src/render/climber.ts, guide.ts, rope-mesh.ts, portrait.ts, heads/) ═══════════════════
// Used internally by the renderer (GameRenderer). Exact exported API:
//
//   climber.ts   export class ClimberModel extends THREE.Group {
//                  constructor(opts?: { head?: HeadId; colorway?: ColorwayId; chalk?: ChalkId });
//                  setSkin(head: HeadId, colorway: ColorwayId, chalk: ChalkId): void;
//                  setHarness(on: boolean): void;                 // rope mode: harness, belay loop, tie-in knot
//                  pose(state: ClimberState, frame: WallFrame, dt: number): void;  // IK + secondary animation
//                  setLookTarget(p: Vec2 | null): void;           // wall-local point the head turns toward
//                  getHarnessWorld(out: THREE.Vector3): THREE.Vector3;  // rope tie-in point (world)
//                  getLimbWorld(limb: LimbId, out: THREE.Vector3): THREE.Vector3;
//                  celebrate(): void;                             // one-shot send celebration
//                  dispose(): void;
//                }
//   guide.ts     export class GuideModel extends THREE.Group {    // Steini: full body + ibex head + staff outfit
//                  constructor();
//                  setState(g: GuideState, frame: WallFrame, dt: number): void;
//                  getHandWorld(hand: 'L' | 'R', out: THREE.Vector3): THREE.Vector3;  // belay hand for the rope
//                  dispose(): void;
//                }
//   rope-mesh.ts export class RopeMesh extends THREE.Object3D {   // dynamic rope tube with sag + slack
//                  constructor(color?: string);
//                  setPath(points: THREE.Vector3[] | null): void; // world points: belayer hand → draws → harness
//                  update(dt: number): void;
//                  dispose(): void;
//                }
//   portrait.ts  export function renderPortrait(renderer: THREE.WebGLRenderer, head: HeadId, size?: number): string;
//   heads/index.ts export function createHead(id: HeadId): THREE.Group;  // origin = neck joint, +Y up, faces +Z

// ═══════════════════════════════ INPUT (src/input) ═══════════════════════════════

export interface LimbControlsAPI {
  /** Overlay element (absolutely positioned over the canvas) that receives pointer events. */
  readonly element: HTMLElement;
  /** Bind to a sim for this climb (null to unbind). */
  bind(sim: ClimberSimAPI | null): void;
  setEnabled(v: boolean): void;
  /** Tutorial gating: which limbs (and whether hips) may be moved. */
  setAllowed(limbs: readonly LimbId[] | 'all', hips?: boolean): void;
  /** Reposition handles/reticles from the latest state. Call every frame after sim.step. */
  update(state: ClimberState, dt: number): void;
  /** Show the 'assist' visuals (labels, reach arcs). */
  setAssist(v: boolean): void;
  dispose(): void;
}

// ═══════════════════════════════ AUDIO (src/audio) ═══════════════════════════════

export type SfxId =
  | 'grab' // good grab
  | 'grab-bad' // poor-quality grab
  | 'release'
  | 'chalk'
  | 'foot' // foot placement (rubber on plastic)
  | 'smear'
  | 'slip'
  | 'effort' // short exhale/grunt
  | 'strain' // long strain (overload)
  | 'fall' // falling whoosh + yell
  | 'land' // crash pad thud
  | 'send' // big success stinger
  | 'top-touch'
  | 'clip' // carabiner snap
  | 'rope-catch'
  | 'ui-tap'
  | 'ui-back'
  | 'ui-confirm'
  | 'ui-swipe'
  | 'unlock'
  | 'whoosh' // camera transitions
  | 'countdown'
  | 'guide' // Steini's speech blip ("bleat")
  | 'score-tick';

export interface AudioAPI {
  /** Must be called from a user gesture (first tap) to start the AudioContext. */
  unlock(): Promise<void>;
  play(id: SfxId, opts?: { volume?: number; pitch?: number; pan?: number }): void;
  /** Continuous effort layer driven by tension (0..1.5) + pump (0..1): breathing, heartbeat. */
  setIntensity(tension: number, pump: number): void;
  setMusic(track: 'menu' | 'climb' | 'none'): void;
  setVolumes(sfx: number, music: number): void;
  setAmbience(on: boolean): void;
  /** Vibrate (Android/Chrome); no-op elsewhere or when haptics are off. */
  haptic(pattern: number | number[]): void;
  setHaptics(on: boolean): void;
}

// ═══════════════════════════════ UI (src/ui) ═══════════════════════════════

export type ScreenId =
  | 'splash' // logo + "tap to start" (unlocks audio)
  | 'title' // main menu over the live 3D scene
  | 'modes' // choose Send Train / Lead Tower / Daily / Community / Tutorial
  | 'name' // first-time player name entry
  | 'hud' // in-climb overlay
  | 'preview' // route-reading overlay before a climb ("TAP TO START")
  | 'pause'
  | 'results' // after a send or a fall
  | 'leaderboard'
  | 'locker' // skins: heads, colorways, chalk
  | 'settings'
  | 'community' // browse user problems
  | 'profile' // stats
  | 'editor' // the editor's DOM panel is owned by src/editor; UI just hides itself
  | 'none';

export interface ResultsProps {
  kind: 'send' | 'fall' | 'run-over' | 'topped-rope';
  mode: RunInfo['mode'];
  boulderName: string;
  grade: number;
  time?: number;
  points?: number;
  breakdown?: { label: string; value: number }[];
  runScore: number;
  streak: number;
  best: number;
  newBest: boolean;
  rank?: number | null;
  unlocks?: { kind: 'head' | 'colorway' | 'chalk'; id: string; name: string }[];
  canContinue: boolean; // "NEXT BOULDER" vs only retry/menu
  tip?: string; // Steini's tip after a fall
}

export interface ScreenProps {
  splash: {};
  title: { profile: Profile; backendLabel: string };
  modes: { profile: Profile; dailyKey: string; dailyBest?: number };
  name: { current: string };
  hud: { run: RunInfo };
  preview: { boulder: BoulderDef; run: RunInfo; tip?: string };
  pause: { run: RunInfo };
  results: ResultsProps;
  leaderboard: { mode: LeaderboardMode; entries: ScoreEntry[] | null; me: string; isGlobal: boolean; dailyKey: string };
  locker: { profile: Profile };
  settings: { profile: Profile };
  community: { problems: CommunityProblem[] | null; sort: 'new' | 'popular'; isGlobal: boolean };
  profile: { profile: Profile };
  editor: {};
  none: {};
}

export interface GuideLine {
  text: string;
  /** Speaker portrait mood. */
  mood?: 'happy' | 'point' | 'think' | 'cheer' | 'warn';
  /** If true, shows a "tap to continue" affordance and resolves on tap. Otherwise resolves immediately. */
  waitForTap?: boolean;
  /** Where the bubble sits. */
  position?: 'top' | 'bottom';
}

export interface UIAPI {
  mount(root: HTMLElement): void;
  show<K extends ScreenId>(screen: K, props: ScreenProps[K]): void;
  /** Update the current screen's props without a transition (e.g. leaderboard data arrives). */
  update<K extends ScreenId>(screen: K, props: ScreenProps[K]): void;
  readonly current: ScreenId;

  hud: {
    update(state: ClimberState, run: RunInfo): void;
    /** Big centered callout ("SENT!", "FLASH", "CLIPPED", "WHIPPER!", "3-2-1"). */
    callout(text: string, style?: 'good' | 'bad' | 'neutral'): void;
    toast(text: string): void;
  };

  /** Steini's speech bubble (tutorial + tips). Resolves when dismissed (or immediately if !waitForTap). */
  guide: {
    say(line: GuideLine): Promise<void>;
    hide(): void;
  };

  /** Generic modal confirm. */
  confirm(title: string, body: string, ok?: string, cancel?: string): Promise<boolean>;

  /** Provides 3D head portraits (data URLs) for the locker, profile chip and guide bubble. */
  setPortraitProvider(fn: (head: HeadId) => string): void;
}

// ═══════════════════════════════ NET (src/net) ═══════════════════════════════

export interface BackendAPI {
  readonly kind: 'supabase' | 'artifact' | 'local';
  /** True when scores are shared with other players (supabase / artifact db). */
  readonly isGlobal: boolean;
  readonly label: string; // e.g. 'GLOBAL', 'CLAUDE SHARED', 'OFFLINE'
  submitScore(e: ScoreEntry): Promise<{ rank: number | null }>;
  topScores(mode: LeaderboardMode, opts?: { limit?: number; dailyKey?: string }): Promise<ScoreEntry[]>;
  publishProblem(p: { name: string; author: string; grade: number; boulder: BoulderDef }): Promise<CommunityProblem>;
  listProblems(opts?: { sort?: 'new' | 'popular'; limit?: number }): Promise<CommunityProblem[]>;
  recordAttempt(problemId: string, sent: boolean): Promise<void>;
}

// src/net/backend.ts exports:  createBackend(): Promise<BackendAPI>
// src/net/profile.ts exports:  loadProfile(): Profile ; saveProfile(p: Profile): void ; defaultProfile(): Profile

// ═══════════════════════════════ EDITOR (src/editor) ═══════════════════════════════

export interface EditorAPI {
  /** Show the editor (its own DOM panel inside `root`), driving the renderer in 'editor' camera mode. */
  open(initial?: BoulderDef): void;
  close(): void;
  readonly isOpen: boolean;
  /** Called by the app after a test climb: whether the player sent it (enables publishing). */
  reportTestResult(sent: boolean): void;
  /** Per-frame hook while open. */
  frame(dt: number): void;
}

// ═══════════════════════════════ TUTORIAL (src/tutorial) ═══════════════════════════════

export interface TutorialContext {
  sim: ClimberSimAPI;
  renderer: RendererAPI;
  controls: LimbControlsAPI;
  ui: UIAPI;
  audio: AudioAPI;
  /** Resolves when the player taps "skip". */
  skipSignal: Promise<void>;
}

// src/tutorial/tutorial.ts exports:
//   runIntro(ctx: { renderer: RendererAPI; ui: UIAPI; audio: AudioAPI }): Promise<void>   // first-launch cinematic
//   runTutorial(ctx: TutorialContext): Promise<'done' | 'skipped'>
// The app owns the sim stepping + render loop; the tutorial only observes events via `bus`
// ('sim:event', 'input:*') and drives guide lines, highlights, gating, and the guide NPC.

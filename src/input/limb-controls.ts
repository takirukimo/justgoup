// LimbControls — the INPUT module's implementation of LimbControlsAPI.
//
// Four thumb-sized limb handles (LH, RH, LF, RF) float just outside the climber's hands and feet,
// joined to them by hairline leaders, plus a smaller hip handle on the pelvis. One drag at a time:
//   • press a limb handle → sim.beginDrag(limb); the limb's target then moves 1:1 with the finger
//     (wall-anchored: the target only moves when the finger moves, never when the camera pans),
//     sim.dragTo() every move, release → sim.endDrag() and its events go out on the bus
//     ('sim:event'), followed by 'input:drag-end';
//   • while dragging: the reach boundary (on the wall, via a per-frame homography) — the limb's
//     anatomical reach envelope when the sim provides one (optional ClimberSim.reachEnvelope(): a
//     foot can't reach above its hip, a hand only a little way across the chest or down past the
//     hips), else a circle of maxReach — with a soft fill, a hairline edge and an emphasised edge
//     toward the finger; a dashed
//     anchor → target line, a reticle at the target, reachable / candidate hold highlights through
//     the renderer, a "GOOD · JUG" grip label, and in rope mode a "CLIP" label on the quickdraw;
//   • the hip handle pulls the hips toward the finger (sim.setHipTarget) with a soft arrow.
// Phase B moves:
//   • release velocity: the finger's wall-local velocity over the last ~90 ms (VelocityTracker) goes
//     to sim.endDrag(limb, { velocity }), so a hand flicked toward a hold beyond its static reach
//     throws a deadpoint / dyno. While the target is such a hold (sim.dynoCandidate) the overlay shows
//     a throw preview instead of the grip reticle: a pink ballistic arc with a FLICK cue, a segmented
//     throw reticle on the hold and a "DEADPOINT · +18 CM" tag (grey "TOO FAR" when it can't be thrown);
//   • a dragged hand also shows two subtle release targets that fade in as the finger nears them: the
//     chalk bag behind the hips (release there → the sim chalks up) and the shake-out lane down beside
//     the body (release there → shake out), each lighting up with a CHALK UP / SHAKE OUT tag;
//   • double dyno: a second finger landing on the hip handle while it is held arms a two-hand throw
//     (also Shift + mouse on desktop). The fingers aim (the target is the matchable hold beyond
//     static reach closest to the aim direction, previewed with two arcs), and a flick toward it
//     releases sim.dyno('both', holdId, power); a slow lift cancels. A one-finger hip drag hints
//     "DYNO · 2 FINGERS + FLICK" the first few times a double dyno is on;
//   • HUD CHALK buttons arrive as 'ui:chalk' on the bus (bus-events.ts) → sim.chalkUp(hand); C on a
//     keyboard chalks the armed (else the greasier) hand;
//   • Pure mode (pure.ts): handles, leaders, labels, reach envelope and highlights are hidden; a
//     finger landing near a hand / foot / the hips picks that limb and shows only a faint ring.
// Handles repel each other (and the reticle / aimed hold) in screen space, stay inside the safe
// viewport, carry a stress ring (green → amber → red, pulsing + trembling when overloaded) and a
// spinner while the hand is busy clipping. Per-frame work is allocation-light: cached DOM nodes,
// transform-only writes, typed-array layout, quantised style updates.
//
// Integration notes:
//   • call update(state, dt) after renderer.frame(dt) so the handles match the rendered camera;
//   • hold highlights: setHoldHighlights() calls made by other modules (hints, tutorial targets)
//     are routed through this controller and merged with the drag highlights, so a drag never
//     wipes a tutorial ring and clearing the drag highlights restores theirs.

import type { CameraMode, ClimberSimAPI, DynoPreview, HoldHighlight, LimbControlsAPI, RendererAPI } from '../core/contracts';
import type { ClimberState, HoldDef, HoldType, LimbId, LimbSnapshot, QuickdrawDef, Vec2 } from '../core/types';
import { bus } from '../core/events';
import { FONTS, PALETTE } from '../config/brand';
import { BODY, GAME, SIM } from '../config/tuning';
import { clamp, damp } from '../core/math';
import { canMatch, usableByHand } from '../game/holds';
import './bus-events';
import { Homography } from './homography';
import { HandleLayout, type SafeRect } from './layout';
import { FOOT_GLYPH, HAND_GLYPH, HIP_GLYPH } from './glyphs';
import { onPureMode } from './pure';
import { alongSpeed, chalkBagAt, flickPower, frictionWord, inChalkZone, inShakeLane, isFlick, SHAKE_LANE, shakeLanePoint, spineUp, throwWord } from './release';
import { ensureLimbControlStyles } from './styles';
import { VelocityTracker } from './velocity';

// ───────────────────────────── constants ─────────────────────────────

const IDS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];
const HIP = 4;
const NONE = -1;

/** Visual radius (px) of a limb handle (ring outer edge) and of the hip handle. */
const HANDLE_R = 34;
const HIP_R = 24;
/** Touch slop: hit radius around a handle / around the limb itself / around the hip handle. */
const HIT_R = 44;
const LIMB_HIT_R = 26;
const HIP_HIT_R = 31;
/** Rest offset (px) of each handle from its limb, outward from the body. */
const OFFSET = [52, 52, 48, 48];
/** Canonical outward directions (screen space: +y is down): hands up/out, feet down/out. */
const CANON_X = [-0.58, 0.58, -0.5, 0.5];
const CANON_Y = [-0.81, -0.81, 0.87, 0.87];
/** Minimum clear gap (px) between handle circles (centres ≥ 2·34 + 6 = 74 px ≥ the 60 px spec). */
const GAP = 6;
/** Default reserved bands for the HUD (beyond the device safe-area insets). */
const RESERVE = { top: 76, bottom: 98, left: 6, right: 6 };
/** Stress-ring circumference (r = 32 in a 70-unit viewBox). */
const RING_R = 32;
const RING_C = 2 * Math.PI * RING_R;
/** Stress at which the ring is full. */
const RING_FULL = 1.25;

const F_FREE = 1;
const F_DRAG = 2;
const F_DIM = 4;
const F_LOCKED = 8;
const F_OVER = 16;
const F_CRIT = 32;
const F_BUSY = 64;
const F_ARMED = 128;
const F_SMEAR = 256;
const F_FOCUS = 512;
const F_THROW = 1024;
const F_DUO = 2048;
const F_AIR = 4096;
const FLAG_CLASSES: readonly (readonly [number, string])[] = [
  [F_THROW, 'is-throw'],
  [F_DUO, 'is-duo'],
  [F_AIR, 'is-air'],
  [F_FOCUS, 'is-focus'],
  [F_FREE, 'is-free'],
  [F_DRAG, 'is-drag'],
  [F_DIM, 'is-dim'],
  [F_LOCKED, 'is-locked'],
  [F_OVER, 'is-over'],
  [F_CRIT, 'is-crit'],
  [F_BUSY, 'is-busy'],
  [F_ARMED, 'is-armed'],
  [F_SMEAR, 'is-smear'],
];

const TYPE_WORD: Record<HoldType, string> = {
  jug: 'JUG',
  edge: 'EDGE',
  crimp: 'CRIMP',
  sloper: 'SLOPER',
  pinch: 'PINCH',
  pocket: 'POCKET',
  foot: 'CHIP',
  volume: 'VOLUME',
};

const KEY_LIMB: Readonly<Record<string, number>> = { '1': 0, '2': 1, '3': 2, '4': 3, '5': HIP, h: HIP, H: HIP };

/** Hand release targets previewed while a hand is dragged. */
const ZONE_NONE = 0;
const ZONE_CHALK = 1;
const ZONE_SHAKE = 2;
/** A second finger this close (px) to the held hip handle arms the double dyno. */
const DUO_R = 84;
/** Pure mode: hit radius (px) around a real hand / foot and around the pelvis (no visible handles). */
const PURE_HIT_R = 50;
const PURE_HIP_R = 36;
/** One-finger hip drags that may show the double-dyno hint per session. */
const DUO_HINTS = 4;
/** Throw colour (CHIRAL pink, lifted for hairlines on the dark wall) and its "too far" grey. */
const C_THROW = '#EE6B79';
const C_THROW_DIM = 'rgba(185,190,197,0.7)';

// ── colour tables (precomputed strings: no per-frame string building) ──

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixTable(stops: readonly (readonly [number, string])[], steps: number): string[] {
  const out: string[] = [];
  const rgb = stops.map(([t, c]) => [t, ...hexRgb(c)] as const);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    let k = 0;
    while (k < rgb.length - 2 && t > rgb[k + 1][0]) k++;
    const a = rgb[k];
    const b = rgb[k + 1];
    const u = clamp((t - a[0]) / (b[0] - a[0] || 1), 0, 1);
    const r = Math.round(a[1] + (b[1] - a[1]) * u);
    const g = Math.round(a[2] + (b[2] - a[2]) * u);
    const bl = Math.round(a[3] + (b[3] - a[3]) * u);
    out.push(`rgb(${r},${g},${bl})`);
  }
  return out;
}
const STRESS_STEPS = 32;
/** Stress colour: green ≤ 0.5, amber ≈ 0.85, red ≥ 1.1. */
const STRESS_COLORS = mixTable([[0, PALETTE.good], [0.58, PALETTE.warn], [1, PALETTE.bad]], STRESS_STEPS);
const stressIndex = (s: number): number => Math.round(clamp((s - 0.5) / 0.6, 0, 1) * (STRESS_STEPS - 1));
const QUALITY_STEPS = 33;
/** Grip quality colour (same ramp as the renderer's candidate ring): red → amber → green. */
const QUALITY_COLORS = mixTable([[0, PALETTE.bad], [0.5, PALETTE.warn], [1, PALETTE.good]], QUALITY_STEPS);
const qualityColor = (q: number): string => QUALITY_COLORS[Math.round(clamp(q, 0, 1) * (QUALITY_STEPS - 1))];
const qualityWord = (q: number): string => (q >= 0.66 ? 'GOOD' : q >= 0.4 ? 'OK' : 'POOR');

const C_BONE = 'rgba(233,229,221,1)';
const C_SHADOW = 'rgba(8,9,10,0.55)';
const DASH_ANCHOR: number[] = [4, 4];
const DASH_RING: number[] = [2, 5];
const DASH_NONE: number[] = [];
const DASH_THROW: number[] = [7, 5];
const FLICK_FONT = `700 9.5px ${FONTS.mono}`;

// ───────────────────────────── types ─────────────────────────────

interface HandleView {
  el: HTMLDivElement;
  nope: HTMLDivElement;
  arc: SVGCircleElement | null;
  /** Displayed (smoothed, pre-jitter) centre in overlay px. */
  x: number;
  y: number;
  /** Last written transform. */
  wx: number;
  wy: number;
  flags: number;
  dash: number;
  color: number;
  placed: boolean;
}

interface TagView {
  el: HTMLDivElement;
  dot: HTMLElement;
  word: HTMLElement;
  type: HTMLElement;
  on: boolean;
  w: number;
  h: number;
  x: number;
  y: number;
  key: string;
}

/** Optional renderer extras (GameRenderer exposes the live camera mode). */
interface RendererExtras {
  readonly cameraMode?: CameraMode;
}

/**
 * Optional sim extra (ClimberSim.releaseTarget): what a release at p does — grab `hold` or clip
 * `clip` (at most one set) — so the reticle previews exactly what endDrag() will do.
 */
type ReleaseTargetFn = (limb: LimbId, p: Vec2) => { hold: HoldDef | null; clip: QuickdrawDef | null };

/** LimbControls.releasePreview: what a release would do now. */
export interface ReleasePreview {
  kind: 'grab' | 'clip' | 'throw' | 'chalk' | 'shake' | 'double' | 'none';
  holdId: string | null;
  rise?: number;
  feasible?: boolean;
  throwKind?: 'deadpoint' | 'dyno';
}

export interface LimbControlsOptions {
  /** Extra space (CSS px) kept free of handles beyond the device safe-area insets (HUD bars). */
  reserve?: Partial<typeof RESERVE>;
}

// ───────────────────────────── controller ─────────────────────────────

export class LimbControls implements LimbControlsAPI {
  readonly element: HTMLElement;
  private readonly renderer: RendererAPI;
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly handles: HandleView[] = [];
  private readonly candTag: TagView;
  private readonly clipTag: TagView;
  private readonly hipTag: TagView;
  private readonly offChalk: () => void;
  private readonly layout = new HandleLayout();
  private readonly homo = new Homography();

  private sim: ClimberSimAPI | null = null;
  private state: ClimberState | null = null;
  private enabled = true;
  private visible = false;
  private assist = true;
  private reduced = false;
  private allowedMask = 15;
  private hipsAllowed = true;
  private armed = NONE;
  private cursor = '';
  private time = 0;
  private disposed = false;

  // viewport
  private W = 1;
  private H = 1;
  private dpr = 1;
  /** Canvas (renderer screen space) → overlay offset. */
  private offX = 0;
  private offY = 0;
  private rootLeft = 0;
  private rootTop = 0;
  private readonly safe: SafeRect = { left: 0, top: 0, right: 1, bottom: 1 };
  private readonly reserve = { ...RESERVE };
  private readonly insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private readonly probe: HTMLDivElement;

  // per-frame projections (overlay px)
  private readonly limbX = new Float64Array(4);
  private readonly limbY = new Float64Array(4);
  private pelvisX = 0;
  private pelvisY = 0;
  /** Head centre + radius on screen (kept clear of handles: the animal head is the hero). */
  private headX = 0;
  private headY = 0;
  private headR = 0;
  private readonly hDst = new Float64Array(8);
  /** Route holds (wall-local centre + visual radius) and their per-frame screen projection. */
  private holdN = 0;
  private holdWX = new Float64Array(0);
  private holdWY = new Float64Array(0);
  private holdWR = new Float64Array(0);
  private holdSX = new Float64Array(0);
  private holdSY = new Float64Array(0);
  private holdSR = new Float64Array(0);
  /** Last chosen offset angle per handle (hysteresis for the direction fan). */
  private readonly prevAng = new Float64Array([NaN, NaN, NaN, NaN]);
  private readonly hSrc = new Float64Array(8);

  // drag state
  private dragIdx = NONE; // 0..3 limb, HIP, or NONE
  private pointerId = -1;
  private fingerX = 0;
  private fingerY = 0;
  private prevX = 0;
  private prevY = 0;
  private grabOffX = 0;
  private grabOffY = 0;
  private pushAmt = 0;
  private readonly target: Vec2 = { x: 0, y: 0 };
  private reach = 0;
  private outOfReach = false;
  /** Reach envelope polygon of the dragged limb (wall-local, [0] = anchor), when the sim provides one. */
  private envPoly: Vec2[] = [];
  private envOn = false;
  private readonly rayHit: Vec2 = { x: 0, y: 0 };
  private cand: HoldDef | null = null;
  private candKnown = false;
  private quality = 0;
  private qualityT = 0;
  private clip: QuickdrawDef | null = null;
  private reachT = 0;
  private reachIds: string[] = [];
  private nextDrawReach: QuickdrawDef | null = null;
  private highlightsDirty = false;

  // release velocity (wall-local target samples of the drag)
  private readonly vel = new VelocityTracker();
  private readonly relVel: Vec2 = { x: 0, y: 0 };
  /** Release velocity of the last hand / foot drag (wall m/s; 0 when the finger had stopped). */
  readonly lastVel: Vec2 = { x: 0, y: 0 };
  // throw preview (a hand dragged beyond its static reach toward a hold)
  private dyno: DynoPreview | null = null;
  private dynoHold: HoldDef | null = null;
  // hand release targets: chalk bag (behind the hips) + shake-out lane (beside the body)
  private zone = ZONE_NONE;
  private chalkOk = false;
  private shakeOk = false;
  private readonly up: Vec2 = { x: 0, y: 1 };
  private readonly bag: Vec2 = { x: 0, y: 0 };

  // double dyno: a second finger on the held hip handle (or Shift + mouse)
  private duo = false;
  private duoPid = -1;
  private readonly duoX = new Float64Array(2);
  private readonly duoY = new Float64Array(2);
  private duoCX = 0;
  private duoCY = 0;
  /** Wall-local displacement of the two-finger centroid since the gesture began (the aim). */
  private readonly duoAim: Vec2 = { x: 0, y: 0 };
  private readonly duoVel = new VelocityTracker();
  private duoHold: HoldDef | null = null;
  private duoRise = 0;
  private duoFeasible = false;
  private duoT = 0;
  /** One-finger hip drags that showed the "2 FINGERS + FLICK" hint (it stops after a few, or once used). */
  private duoHints = 0;
  private duoHintOn = false;
  private duoHintT = 0;
  private duoUsed = false;
  private holdMap = new Map<string, HoldDef>();
  private duoHolds: HoldDef[] = [];

  // Pure mode (pure.ts)
  private pure = false;
  private readonly offPure: () => void;

  // highlights (merged with other modules' highlights)
  private readonly origSetHighlights: (h: HoldHighlight[]) => void;
  private readonly wrappedSetHighlights: (h: HoldHighlight[]) => void;
  /** Whether the renderer carried its own (instance) setHoldHighlights before we wrapped it. */
  private readonly hadOwnSetHighlights: boolean;
  private external: HoldHighlight[] = [];
  private readonly own: HoldHighlight[] = [];
  private readonly ownPool: HoldHighlight[] = [];
  private readonly merged: HoldHighlight[] = [];
  private ownActive = false;

  // canvas dirty box
  private dMinX = 0;
  private dMinY = 0;
  private dMaxX = 0;
  private dMaxY = 0;
  private drawn = false;

  // scratch
  private readonly s0: Vec2 = { x: 0, y: 0 };
  private readonly s1: Vec2 = { x: 0, y: 0 };
  private readonly s2: Vec2 = { x: 0, y: 0 };
  private readonly s3: Vec2 = { x: 0, y: 0 };
  private readonly laneQuad: Vec2[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  private readonly ro: ResizeObserver | null = null;
  private readonly mq: MediaQueryList | null = null;

  constructor(overlay: HTMLElement, renderer: RendererAPI, opts: LimbControlsOptions = {}) {
    this.element = overlay;
    this.renderer = renderer;
    Object.assign(this.reserve, opts.reserve ?? {});
    ensureLimbControlStyles(overlay.ownerDocument);

    const doc = overlay.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'jgl is-hidden';
    root.setAttribute('aria-hidden', 'true');
    this.root = root;

    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'jgl-cv';
    root.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('LimbControls: 2D canvas unavailable');
    this.ctx = ctx;

    for (let i = 0; i < 4; i++) this.handles.push(this.buildHandle(doc, i));
    this.handles.push(this.buildHip(doc));
    for (const h of this.handles) root.appendChild(h.el);

    this.candTag = this.buildTag(doc, '');
    this.clipTag = this.buildTag(doc, 'is-clip');
    this.clipTag.word.textContent = 'CLIP';
    this.hipTag = this.buildTag(doc, 'is-hint');
    root.appendChild(this.candTag.el);
    root.appendChild(this.clipTag.el);
    root.appendChild(this.hipTag.el);

    this.probe = doc.createElement('div');
    this.probe.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    root.appendChild(this.probe);

    if (getComputedStyle(overlay).position === 'static') overlay.style.position = 'relative';
    overlay.style.touchAction = 'none';
    overlay.style.pointerEvents = 'none';
    overlay.appendChild(root);

    // route other modules' highlight calls through the merge (restored in dispose())
    this.hadOwnSetHighlights = Object.prototype.hasOwnProperty.call(renderer, 'setHoldHighlights');
    this.origSetHighlights = renderer.setHoldHighlights.bind(renderer);
    this.wrappedSetHighlights = (h: HoldHighlight[]) => {
      this.external = h ? h.slice() : [];
      this.flushHighlights();
    };
    renderer.setHoldHighlights = this.wrappedSetHighlights;

    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointermove', this.onPointerMove);
    root.addEventListener('pointerup', this.onPointerUp);
    root.addEventListener('pointercancel', this.onPointerUp);
    root.addEventListener('lostpointercapture', this.onLostCapture);
    root.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onBlur);

    if (typeof window.matchMedia === 'function') {
      this.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = this.mq.matches;
      this.mq.addEventListener?.('change', this.onMotionPref);
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(root);
    }
    window.addEventListener('resize', this.onResize);
    this.offChalk = bus.on('ui:chalk', this.onChalk);
    this.offPure = onPureMode((v) => this.setPure(v));
    this.measure();
  }

  // ═══════════════════════════════ public API ═══════════════════════════════

  bind(sim: ClimberSimAPI | null): void {
    if (sim === this.sim) return;
    if (this.dragIdx !== NONE) this.finishDrag();
    this.sim = sim;
    this.state = null;
    this.armed = NONE;
    for (const h of this.handles) h.placed = false;
    this.prevAng.fill(NaN);
    this.indexHolds(sim);
    this.clearOwnHighlights();
    this.dyno = null;
    this.dynoHold = null;
    this.zone = ZONE_NONE;
    if (!sim) this.setVisible(false);
  }

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    this.root.classList.toggle('is-disabled', !v);
    if (!v) {
      if (this.dragIdx !== NONE) this.finishDrag();
      this.armed = NONE;
      this.setVisible(false);
    }
  }

  setAllowed(limbs: readonly LimbId[] | 'all', hips?: boolean): void {
    if (limbs === 'all') this.allowedMask = 15;
    else {
      let m = 0;
      for (const l of limbs) m |= 1 << IDS.indexOf(l);
      this.allowedMask = m;
    }
    this.hipsAllowed = hips ?? limbs === 'all';
  }

  setAssist(v: boolean): void {
    this.assist = v;
    this.root.classList.toggle('no-assist', !v);
  }

  update(state: ClimberState, dt: number): void {
    if (this.disposed) return;
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    this.time += d;
    const sim = this.sim;
    const mode = (this.renderer as RendererAPI & RendererExtras).cameraMode;
    const show = this.enabled && !!sim && state.phase === 'climbing' && (mode === undefined || mode === 'follow');
    if (!show) {
      if (this.dragIdx !== NONE) this.finishDrag();
      if (this.visible) this.setVisible(false);
      if (this.drawn) this.clearCanvas();
      for (const h of this.handles) h.placed = false;
      return;
    }
    this.state = state;
    if (!this.visible) this.setVisible(true);

    this.project(state);
    this.computeHomography(state);
    this.projectHolds(state);
    if (this.dragIdx !== NONE && this.dragIdx !== HIP) this.updateDragQueries(state, d);
    else if (this.dragIdx === HIP) this.updateHipQueries(state, d);
    this.layoutHandles(state, d);
    this.writeHandles(state);
    this.updateTags(state);
    if (this.highlightsDirty) this.rebuildOwnHighlights(state);
    this.draw(state);
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.dragIdx !== NONE) this.finishDrag();
    this.disposed = true;
    this.clearOwnHighlights();
    if (this.renderer.setHoldHighlights === this.wrappedSetHighlights) {
      if (this.hadOwnSetHighlights) this.renderer.setHoldHighlights = this.origSetHighlights;
      else delete (this.renderer as Partial<Pick<RendererAPI, 'setHoldHighlights'>>).setHoldHighlights;
    }
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerup', this.onPointerUp);
    this.root.removeEventListener('pointercancel', this.onPointerUp);
    this.root.removeEventListener('lostpointercapture', this.onLostCapture);
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
    this.offChalk();
    this.offPure();
    this.mq?.removeEventListener?.('change', this.onMotionPref);
    this.ro?.disconnect();
    this.root.remove();
    this.sim = null;
  }

  // ── optional extras (not part of the contract) ──

  /** Limb currently dragged ('HIP' for the hip handle), or null. */
  get dragging(): LimbId | 'HIP' | null {
    return this.dragIdx === NONE ? null : this.dragIdx === HIP ? 'HIP' : IDS[this.dragIdx];
  }

  /** Current on-screen centre of a handle (overlay CSS px), e.g. for tutorial pointers; null when hidden. */
  handlePosition(limb: LimbId | 'HIP'): { x: number; y: number } | null {
    if (!this.visible) return null;
    const h = this.handles[limb === 'HIP' ? HIP : IDS.indexOf(limb)];
    return h && h.placed ? { x: h.x, y: h.y } : null;
  }

  /**
   * What releasing the current drag would do right now (tests, tutorial): grab / clip the target,
   * throw at a hold ('throw', with the sim's preview), dip into the chalk bag, shake out, a double
   * dyno ('double', hip handle with two fingers), or nothing special ('none'). null when not dragging.
   */
  get releasePreview(): ReleasePreview | null {
    const idx = this.dragIdx;
    if (idx === NONE) return null;
    if (idx === HIP) {
      if (!this.duo) return { kind: 'none', holdId: null };
      return { kind: 'double', holdId: this.duoHold ? this.duoHold.id : null, rise: this.duoRise, feasible: this.duoFeasible };
    }
    if (this.clip) return { kind: 'clip', holdId: this.clip.id };
    if (this.cand) return { kind: 'grab', holdId: this.cand.id };
    if (this.dyno && this.dynoHold) return { kind: 'throw', holdId: this.dynoHold.id, rise: this.dyno.rise, feasible: this.dyno.feasible, throwKind: this.dyno.kind };
    if (this.zone === ZONE_CHALK) return { kind: 'chalk', holdId: null };
    if (this.zone === ZONE_SHAKE) return { kind: 'shake', holdId: null };
    return { kind: 'none', holdId: null };
  }

  /** Wall-local target of the dragged limb (a copy), or null when no limb is dragged. */
  get dragTarget(): Vec2 | null {
    return this.dragIdx >= 0 && this.dragIdx < 4 ? { x: this.target.x, y: this.target.y } : null;
  }

  /** The double-dyno target a two-finger flick straight up the spine would throw at now, or null. */
  previewDoubleDyno(): { holdId: string; rise: number; feasible: boolean } | null {
    const st = this.state;
    if (!st || this.duo) return this.duo && this.duoHold ? { holdId: this.duoHold.id, rise: this.duoRise, feasible: this.duoFeasible } : null;
    const ax = this.duoAim.x;
    const ay = this.duoAim.y;
    this.duoAim.x = this.duoAim.y = 0;
    spineUp(st.pelvis, st.chest, this.up);
    this.pickDuoTarget(st);
    this.duoAim.x = ax;
    this.duoAim.y = ay;
    const h = this.duoHold;
    const out = h ? { holdId: h.id, rise: this.duoRise, feasible: this.duoFeasible } : null;
    this.duoHold = null;
    return out;
  }

  /** Override the HUD bands kept free of handles (CSS px beyond the safe-area insets). */
  setReserve(r: Partial<typeof RESERVE>): void {
    Object.assign(this.reserve, r);
    this.measure();
  }

  /** Mirror the in-game reduced-motion setting (the OS preference is always respected). */
  setReducedMotion(v: boolean): void {
    this.root.classList.toggle('is-reduced', v);
    this.reduced = v || !!this.mq?.matches;
  }

  /** Drop the current drag (as if released). */
  cancelDrag(): void {
    if (this.dragIdx !== NONE) this.finishDrag();
  }

  /**
   * Pure mode (Phase D; usually driven by pure.ts setPureMode): the handles stay invisible until a
   * finger lands near a hand, foot or the hips, which then shows only a faint ring — no leaders,
   * labels, reach envelope, release targets or hold highlights.
   */
  setPure(v: boolean): void {
    if (this.pure === v) return;
    this.pure = v;
    this.root.classList.toggle('is-pure', v);
    if (v) {
      this.clearOwnHighlights();
      this.setTag(this.candTag, false);
      this.setTag(this.clipTag, false);
      this.setTag(this.hipTag, false);
    } else if (this.dragIdx >= 0 && this.dragIdx < 4) this.highlightsDirty = true;
  }

  get isPure(): boolean {
    return this.pure;
  }

  /**
   * Dip a hand into the chalk bag (the HUD CHALK button sends 'ui:chalk'). Respects tutorial gating
   * ('input:blocked') and refuses with a shake when the sim says no (other hand not holding, busy…).
   */
  chalkUp(hand: 'LH' | 'RH'): boolean {
    const sim = this.sim;
    const idx = hand === 'LH' ? 0 : 1;
    if (!this.enabled || !sim || !this.state || this.state.phase !== 'climbing' || this.dragIdx === idx || this.duo) return false;
    if (!(this.allowedMask & (1 << idx))) {
      this.refuse(idx);
      bus.emit('input:blocked', { limb: hand, reason: 'locked' });
      return false;
    }
    const ok = typeof sim.chalkUp === 'function' && sim.chalkUp(hand);
    if (!ok) this.refuse(idx);
    return ok;
  }

  private readonly onChalk = (e: { hand: 'LH' | 'RH' }): void => {
    if (e && (e.hand === 'LH' || e.hand === 'RH')) this.chalkUp(e.hand);
  };

  // ═══════════════════════════════ DOM construction ═══════════════════════════════

  private buildHandle(doc: Document, i: number): HandleView {
    const limb = IDS[i];
    const hand = i < 2;
    const left = i === 0 || i === 2;
    const el = doc.createElement('div');
    el.className = `jgl-h ${left ? 'jgl-l' : 'jgl-r'} ${hand ? 'jgl-hand' : 'jgl-foot'}`;
    el.dataset.limb = limb;
    el.innerHTML =
      '<div class="jgl-n"><div class="jgl-b">' +
      '<div class="jgl-glow"></div><div class="jgl-shd"></div>' +
      '<svg class="jgl-ring" viewBox="0 0 70 70" aria-hidden="true">' +
      `<circle class="jgl-halo" cx="35" cy="35" r="${RING_R}"/>` +
      `<circle class="jgl-trk" cx="35" cy="35" r="${RING_R}"/>` +
      `<circle class="jgl-arc" cx="35" cy="35" r="${RING_R}" transform="rotate(-90 35 35)" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/>` +
      `<circle class="jgl-spin" cx="35" cy="35" r="${RING_R}"/>` +
      '</svg>' +
      `<div class="jgl-disc">${hand ? HAND_GLYPH : FOOT_GLYPH}<span class="jgl-side">${left ? 'L' : 'R'}</span></div>` +
      `<span class="jgl-key">${i + 1}</span>` +
      '</div></div>';
    return {
      el,
      nope: el.firstElementChild as HTMLDivElement,
      arc: el.querySelector('.jgl-arc'),
      x: 0,
      y: 0,
      wx: NaN,
      wy: NaN,
      flags: 0,
      dash: -1,
      color: -1,
      placed: false,
    };
  }

  private buildHip(doc: Document): HandleView {
    const el = doc.createElement('div');
    el.className = 'jgl-h jgl-hip';
    el.dataset.limb = 'HIP';
    el.innerHTML =
      '<div class="jgl-n"><div class="jgl-b">' +
      '<div class="jgl-glow"></div><div class="jgl-shd"></div>' +
      '<svg class="jgl-ring" viewBox="0 0 50 50" aria-hidden="true"><circle class="jgl-trk" cx="25" cy="25" r="23"/></svg>' +
      `<div class="jgl-disc">${HIP_GLYPH}</div>` +
      '<span class="jgl-key">5</span>' +
      '</div></div>';
    return { el, nope: el.firstElementChild as HTMLDivElement, arc: null, x: 0, y: 0, wx: NaN, wy: NaN, flags: 0, dash: -1, color: -1, placed: false };
  }

  private buildTag(doc: Document, extra: string): TagView {
    const el = doc.createElement('div');
    el.className = `jgl-tag ${extra}`.trim();
    el.innerHTML = '<i></i><b></b><span></span>';
    return {
      el,
      dot: el.children[0] as HTMLElement,
      word: el.children[1] as HTMLElement,
      type: el.children[2] as HTMLElement,
      on: false,
      w: 72,
      h: 23,
      x: NaN,
      y: NaN,
      key: '',
    };
  }

  // ═══════════════════════════════ viewport ═══════════════════════════════

  private readonly onResize = (): void => this.measure();
  private readonly onMotionPref = (): void => {
    this.reduced = !!this.mq?.matches || this.root.classList.contains('is-reduced');
  };

  private measure(): void {
    if (this.disposed) return;
    const r = this.root.getBoundingClientRect();
    const W = Math.max(1, r.width || this.element.clientWidth || window.innerWidth);
    const H = Math.max(1, r.height || this.element.clientHeight || window.innerHeight);
    this.rootLeft = r.left;
    this.rootTop = r.top;
    const cr = this.renderer.canvas.getBoundingClientRect();
    this.offX = cr.width > 0 ? cr.left - r.left : 0;
    this.offY = cr.height > 0 ? cr.top - r.top : 0;
    const cs = getComputedStyle(this.probe);
    this.insets.top = parseFloat(cs.paddingTop) || 0;
    this.insets.right = parseFloat(cs.paddingRight) || 0;
    this.insets.bottom = parseFloat(cs.paddingBottom) || 0;
    this.insets.left = parseFloat(cs.paddingLeft) || 0;
    this.safe.left = this.insets.left + this.reserve.left;
    this.safe.right = W - this.insets.right - this.reserve.right;
    this.safe.top = this.insets.top + this.reserve.top;
    this.safe.bottom = H - this.insets.bottom - this.reserve.bottom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (W !== this.W || H !== this.H || dpr !== this.dpr) {
      this.W = W;
      this.H = H;
      this.dpr = dpr;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawn = false;
    }
  }

  private setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('is-hidden', !v);
    // the overlay only takes pointer events while climbing (the editor and UI use the canvas below)
    this.element.style.pointerEvents = v ? '' : 'none';
    if (!v) {
      this.setTag(this.candTag, false);
      this.setTag(this.clipTag, false);
    }
  }

  // ═══════════════════════════════ projection ═══════════════════════════════

  private project(state: ClimberState): void {
    const r = this.renderer;
    for (let i = 0; i < 4; i++) {
      const L = state.limbs[IDS[i]];
      const p = r.wallToScreen(L.pos, L.depth);
      this.limbX[i] = p.x + this.offX;
      this.limbY[i] = p.y + this.offY;
    }
    const pv = r.wallToScreen(state.pelvis, state.pelvisDepth);
    this.pelvisX = pv.x + this.offX;
    this.pelvisY = pv.y + this.offY;
    // head ≈ chest + spine direction · (neck + most of the head radius)
    let sx = state.chest.x - state.pelvis.x;
    let sy = state.chest.y - state.pelvis.y;
    const sl = Math.hypot(sx, sy) || 1;
    sx /= sl;
    sy /= sl;
    const k = BODY.neck + BODY.headRadius * 0.7;
    const cp = r.wallToScreen(state.chest, state.pelvisDepth);
    this.s0.x = state.chest.x + sx * k;
    this.s0.y = state.chest.y + sy * k;
    const hp = r.wallToScreen(this.s0, state.pelvisDepth + 0.05);
    this.headX = hp.x + this.offX;
    this.headY = hp.y + this.offY;
    // radius incl. ears / horns ≈ 0.19 m
    this.headR = Math.hypot(hp.x - cp.x, hp.y - cp.y) * (0.19 / k);
  }

  /** Wall plane → overlay homography around the current drag (the camera moves every frame). */
  private computeHomography(state: ClimberState): boolean {
    const c = this.dragIdx === HIP || this.dragIdx === NONE ? state.pelvis : state.limbs[IDS[this.dragIdx]].anchor;
    const s = 1.0;
    const src = this.hSrc;
    src[0] = c.x - s;
    src[1] = c.y - s;
    src[2] = c.x + s;
    src[3] = c.y - s;
    src[4] = c.x + s;
    src[5] = c.y + s;
    src[6] = c.x - s;
    src[7] = c.y + s;
    for (let k = 0; k < 4; k++) {
      this.s0.x = src[k * 2];
      this.s0.y = src[k * 2 + 1];
      const p = this.renderer.wallToScreen(this.s0, 0);
      this.hDst[k * 2] = p.x + this.offX;
      this.hDst[k * 2 + 1] = p.y + this.offY;
    }
    return this.homo.solve(src, this.hDst);
  }

  /** Cache the route holds of a climb (deco holds of other routes don't matter for layout). */
  private indexHolds(sim: ClimberSimAPI | null): void {
    const holds = sim ? sim.boulder.holds : [];
    let n = 0;
    for (const h of holds) if (h.role !== 'deco') n++;
    if (this.holdWX.length < n) {
      this.holdWX = new Float64Array(n);
      this.holdWY = new Float64Array(n);
      this.holdWR = new Float64Array(n);
      this.holdSX = new Float64Array(n);
      this.holdSY = new Float64Array(n);
      this.holdSR = new Float64Array(n);
    }
    let k = 0;
    this.holdMap = new Map();
    this.duoHolds = [];
    for (const h of holds) {
      if (h.role === 'deco') continue;
      this.holdWX[k] = h.x;
      this.holdWY[k] = h.y;
      this.holdWR[k] = holdRadius(h);
      this.holdMap.set(h.id, h);
      // double-dyno targets: hand holds both hands can share
      if (usableByHand(h) && canMatch(0, h)) this.duoHolds.push(h);
      k++;
    }
    this.holdN = k;
  }

  /** Project route holds near the climber (screen centre + radius) for handle placement. */
  private projectHolds(state: ClimberState): void {
    const H = this.homo;
    if (!H.valid) {
      for (let k = 0; k < this.holdN; k++) this.holdSR[k] = 0;
      return;
    }
    const scale = H.scaleAt(state.pelvis.x, state.pelvis.y, this.s2, this.s3);
    for (let k = 0; k < this.holdN; k++) {
      const wx = this.holdWX[k];
      const wy = this.holdWY[k];
      // only holds within ~1.6 m of the pelvis can sit under a handle
      if (Math.abs(wx - state.pelvis.x) > 1.6 || Math.abs(wy - state.pelvis.y) > 1.9 || !H.map(wx, wy, this.s1)) {
        this.holdSR[k] = 0;
        continue;
      }
      this.holdSX[k] = this.s1.x;
      this.holdSY[k] = this.s1.y;
      this.holdSR[k] = this.holdWR[k] * scale;
    }
  }

  // ═══════════════════════════════ pointer input ═══════════════════════════════

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  /** Window lost focus mid-gesture (notification, app switch): drop the limb, disarm keys. */
  private readonly onBlur = (): void => {
    this.armed = NONE;
    if (this.dragIdx !== NONE) this.finishDrag();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || !this.visible || !this.sim || !this.state) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.dragIdx !== NONE) {
      // one drag at a time: extra fingers are ignored — except a second finger on the held hip
      // handle, which arms a double dyno
      if (this.dragIdx === HIP && !this.duo && e.pointerId !== this.pointerId && e.pointerType !== 'mouse') {
        const x = e.clientX - this.rootLeft;
        const y = e.clientY - this.rootTop;
        const hip = this.handles[HIP];
        if (Math.hypot(x - hip.x, y - hip.y) <= DUO_R || Math.hypot(x - this.fingerX, y - this.fingerY) <= DUO_R) {
          e.preventDefault();
          this.startDuo(e, x, y, false);
        }
      }
      return;
    }
    const rr = this.root.getBoundingClientRect();
    this.rootLeft = rr.left;
    this.rootTop = rr.top;
    const x = e.clientX - this.rootLeft;
    const y = e.clientY - this.rootTop;
    const byKey = this.armed !== NONE && e.pointerType !== 'touch';
    const idx = byKey ? this.armed : this.hitTest(x, y);
    if (idx === NONE) return;
    e.preventDefault();

    if (idx === HIP) {
      if (!this.hipsAllowed) {
        this.refuse(HIP);
        return;
      }
      this.startHipDrag(e, x, y);
      // desktop: Shift + drag on the hips aims a double dyno with one pointer
      if (e.shiftKey && e.pointerType === 'mouse') this.startDuo(e, x, y, true);
      return;
    }
    const limb = IDS[idx];
    if (!(this.allowedMask & (1 << idx))) {
      this.refuse(idx);
      bus.emit('input:blocked', { limb, reason: 'locked' });
      return;
    }
    if (!this.sim.beginDrag(limb)) {
      this.refuse(idx);
      return;
    }
    this.startLimbDrag(e, idx, x, y);
  };

  private hitTest(x: number, y: number): number {
    if (this.pure) return this.pureHitTest(x, y);
    let best = NONE;
    let bestScore = Infinity;
    for (let i = 0; i < 5; i++) {
      const h = this.handles[i];
      if (!h.placed) continue;
      const hr = i === HIP ? HIP_HIT_R : HIT_R;
      const d = Math.hypot(x - h.x, y - h.y);
      // the hip handle sits on the body: limb handles win ties
      const score = d / hr + (i === HIP ? 0.15 : 0);
      if (d <= hr && score < bestScore) {
        best = i;
        bestScore = score;
      }
      if (i < 4) {
        const dl = Math.hypot(x - this.limbX[i], y - this.limbY[i]);
        const sl = dl / LIMB_HIT_R + 0.1;
        if (dl <= LIMB_HIT_R && sl < bestScore) {
          best = i;
          bestScore = sl;
        }
      }
    }
    return best;
  }

  /** Pure mode: no visible handles, so a finger picks the nearest real hand / foot (or the hips). */
  private pureHitTest(x: number, y: number): number {
    let best = NONE;
    let bestScore = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(x - this.limbX[i], y - this.limbY[i]);
      const sc = d / PURE_HIT_R;
      if (d <= PURE_HIT_R && sc < bestScore) {
        best = i;
        bestScore = sc;
      }
    }
    const dh = Math.hypot(x - this.pelvisX, y - this.pelvisY);
    // the hips lose ties against a hand / foot right next to them
    if (dh <= PURE_HIP_R && dh / PURE_HIP_R + 0.2 < bestScore) best = HIP;
    return best;
  }

  private capture(e: PointerEvent): void {
    this.pointerId = e.pointerId;
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer: moves still arrive while over the overlay */
    }
  }

  private startLimbDrag(e: PointerEvent, idx: number, x: number, y: number): void {
    const state = this.state as ClimberState;
    const sim = this.sim as ClimberSimAPI;
    const limb = IDS[idx];
    this.capture(e);
    this.dragIdx = idx;
    this.armed = NONE;
    this.fingerX = this.prevX = x;
    this.fingerY = this.prevY = y;
    const h = this.handles[idx];
    // keep the handle where it was grabbed relative to the finger; key-armed drags start at the finger
    if (!this.pure && h.placed && Math.hypot(h.x - x, h.y - y) <= HIT_R) {
      this.grabOffX = h.x - x;
      this.grabOffY = h.y - y;
    } else {
      this.grabOffX = 0;
      this.grabOffY = 0;
    }
    this.pushAmt = 0;
    const L = state.limbs[limb];
    this.target.x = L.pos.x;
    this.target.y = L.pos.y;
    this.reach = sim.maxReach(limb) + SIM.reachTolerance;
    this.refreshEnvelope(sim, limb);
    this.cand = null;
    this.candKnown = false;
    this.quality = 0;
    this.qualityT = 0;
    this.clip = null;
    this.reachT = Infinity; // refresh the reachable set on the first frame
    this.reachIds = [];
    this.nextDrawReach = null;
    this.dyno = null;
    this.dynoHold = null;
    this.zone = ZONE_NONE;
    this.vel.reset(e.timeStamp, this.target.x, this.target.y);
    sim.dragTo(limb, this.target);
    this.computeHomography(state);
    bus.emit('input:drag-start', { limb });
    this.evalCandidate(true);
    this.renderer.setCameraFocusHint(this.target);
    this.highlightsDirty = true;
    this.setCursor('grabbing');
  }

  private startHipDrag(e: PointerEvent, x: number, y: number): void {
    const state = this.state as ClimberState;
    this.capture(e);
    this.dragIdx = HIP;
    this.armed = NONE;
    this.fingerX = this.prevX = x;
    this.fingerY = this.prevY = y;
    this.target.x = state.pelvis.x;
    this.target.y = state.pelvis.y;
    this.computeHomography(state);
    (this.sim as ClimberSimAPI).setHipTarget(this.target);
    this.duoHintT = Infinity; // check for a double-dyno hint on the first frame
    bus.emit('input:hip-start');
    this.setCursor('grabbing');
  }

  /**
   * Arm a double dyno: the second finger (`single`: Shift + mouse, one pointer) on the held hip
   * handle. The hips stay where they are; the fingers' centroid now aims the throw.
   */
  private startDuo(e: PointerEvent, x: number, y: number, single: boolean): void {
    const sim = this.sim;
    const state = this.state;
    if (!sim || !state || typeof sim.dyno !== 'function' || typeof sim.dynoCandidate !== 'function') return;
    if ((this.allowedMask & 3) !== 3 || state.airborne) {
      this.refuse(HIP);
      return;
    }
    this.duo = true;
    this.duoPid = single ? -1 : e.pointerId;
    if (!single) {
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
    }
    this.duoX[0] = this.fingerX;
    this.duoY[0] = this.fingerY;
    this.duoX[1] = single ? this.fingerX : x;
    this.duoY[1] = single ? this.fingerY : y;
    this.duoCX = (this.duoX[0] + this.duoX[1]) / 2;
    this.duoCY = (this.duoY[0] + this.duoY[1]) / 2;
    this.duoAim.x = 0;
    this.duoAim.y = 0;
    this.duoVel.reset(e.timeStamp, 0, 0);
    // the hips keep the position the player chose while the throw is aimed
    sim.setHipTarget(null);
    this.duoHintOn = false;
    this.setTag(this.hipTag, false);
    spineUp(state.pelvis, state.chest, this.up);
    this.pickDuoTarget(state);
    this.duoT = 0;
  }

  /** One of the double-dyno fingers moved: move the centroid aim (wall-local, camera-independent). */
  private moveDuo(slot: number, x: number, y: number, t: number): void {
    if (this.duoPid < 0) {
      this.duoX[0] = this.duoX[1] = x;
      this.duoY[0] = this.duoY[1] = y;
    } else {
      this.duoX[slot] = x;
      this.duoY[slot] = y;
    }
    if (slot === 0) {
      this.fingerX = x;
      this.fingerY = y;
    }
    const cx = (this.duoX[0] + this.duoX[1]) / 2;
    const cy = (this.duoY[0] + this.duoY[1]) / 2;
    if (this.wallDelta(this.duoCX, this.duoCY, cx, cy, this.s3)) {
      this.duoAim.x += this.s3.x;
      this.duoAim.y += this.s3.y;
    }
    this.duoCX = cx;
    this.duoCY = cy;
    this.duoVel.add(t, this.duoAim.x, this.duoAim.y);
  }

  /** Release of a double-dyno finger: a flick toward the target throws, a slow lift cancels. */
  private finishDuo(t: number): void {
    const sim = this.sim;
    const state = this.state;
    const hold = this.duoHold;
    if (sim && state && hold && typeof sim.dyno === 'function') {
      const v = this.duoVel.velocity(t, this.relVel);
      this.s2.x = (state.limbs.LH.pos.x + state.limbs.RH.pos.x) / 2;
      this.s2.y = (state.limbs.LH.pos.y + state.limbs.RH.pos.y) / 2;
      const along = alongSpeed(v, this.s2, hold);
      if (isFlick(along)) {
        const power = flickPower(along);
        const events = sim.dyno('both', hold.id, power);
        for (const ev of events) bus.emit('sim:event', ev);
        bus.emit('input:dyno', { holdId: hold.id, power, thrown: events.length > 0 });
        if (events.length) this.duoUsed = true;
        else this.refuse(HIP);
      }
    }
    this.finishDrag();
  }

  /** Drop the double-dyno state (no throw). */
  private endDuo(): void {
    if (!this.duo) return;
    const pid = this.duoPid;
    this.duo = false;
    this.duoPid = -1;
    this.duoHold = null;
    if (pid >= 0 && this.root.hasPointerCapture?.(pid)) {
      try {
        this.root.releasePointerCapture(pid);
      } catch {
        /* already released */
      }
    }
  }

  /**
   * Double-dyno target: the hold both hands can share, beyond static reach (a dyno candidate of
   * either hand), closest to the aim direction (the spine's up before the fingers move).
   */
  private pickDuoTarget(state: ClimberState): void {
    const sim = this.sim;
    this.duoHold = null;
    this.duoRise = 0;
    this.duoFeasible = false;
    if (!sim || typeof sim.dynoCandidate !== 'function') return;
    const LH = state.limbs.LH;
    const RH = state.limbs.RH;
    if (LH.busy || RH.busy || state.airborne) return;
    const mx = (LH.pos.x + RH.pos.x) / 2;
    const my = (LH.pos.y + RH.pos.y) / 2;
    let dx = this.duoAim.x;
    let dy = this.duoAim.y;
    let dl = Math.hypot(dx, dy);
    if (dl < 0.03) {
      dx = this.up.x;
      dy = this.up.y;
      dl = 1;
    }
    const far = Math.max(sim.maxReach('LH'), sim.maxReach('RH')) + SIM.dynoMaxReach + GAME.snapRadius;
    let bestS = Infinity;
    for (const h of this.duoHolds) {
      const hx = h.x - mx;
      const hy = h.y - my;
      const d = Math.hypot(hx, hy);
      if (d < 0.2) continue;
      const cos = (hx * dx + hy * dy) / (d * dl);
      if (cos < 0.45) continue;
      if (Math.hypot(h.x - LH.anchor.x, h.y - LH.anchor.y) > far && Math.hypot(h.x - RH.anchor.x, h.y - RH.anchor.y) > far) continue;
      const sc = (1 - cos) * 3 + d * 0.25;
      if (sc >= bestS) continue;
      const pl = sim.dynoCandidate('LH', h);
      const pr = sim.dynoCandidate('RH', h);
      const okL = !!pl && pl.holdId === h.id;
      const okR = !!pr && pr.holdId === h.id;
      if (!okL && !okR) continue;
      bestS = sc;
      this.duoHold = h;
      this.duoRise = Math.max(okL && pl ? pl.rise : 0, okR && pr ? pr.rise : 0);
      this.duoFeasible = (!okL || !!pl?.feasible) && (!okR || !!pr?.feasible);
    }
  }

  /** Per-frame hip-drag work: re-aim a double dyno, or offer the double-dyno hint on a plain hip drag. */
  private updateHipQueries(state: ClimberState, dt: number): void {
    spineUp(state.pelvis, state.chest, this.up);
    if (this.duo) {
      this.duoT += dt;
      if (this.duoT >= 0.06) {
        this.duoT = 0;
        this.pickDuoTarget(state);
      }
      return;
    }
    this.duoHintT += dt;
    if (this.duoHintT < 0.3) return;
    this.duoHintT = 0;
    if (this.duoHintOn || this.duoUsed || this.duoHints >= DUO_HINTS || this.pure || !this.assist || (this.allowedMask & 3) !== 3) return;
    const p = this.previewDoubleDyno();
    if (p && p.feasible) {
      this.duoHintOn = true;
      this.duoHints++;
    }
  }

  private setCursor(c: string): void {
    if (c === this.cursor) return;
    this.cursor = c;
    this.root.style.cursor = c;
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.dragIdx === NONE && e.pointerType === 'mouse') {
      // desktop affordance: grab cursor over a handle
      if (this.visible) {
        const idx = this.armed !== NONE ? this.armed : this.hitTest(e.clientX - this.rootLeft, e.clientY - this.rootTop);
        this.setCursor(idx === NONE ? '' : 'grab');
      }
      return;
    }
    if (this.dragIdx === NONE || !this.sim) return;
    if (this.duo) {
      const slot = e.pointerId === this.pointerId ? 0 : e.pointerId === this.duoPid ? 1 : -1;
      if (slot < 0) return;
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (list && list.length > 1) for (const ce of list) this.moveDuo(slot, ce.clientX - this.rootLeft, ce.clientY - this.rootTop, ce.timeStamp);
      this.moveDuo(slot, e.clientX - this.rootLeft, e.clientY - this.rootTop, e.timeStamp);
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    const x = e.clientX - this.rootLeft;
    const y = e.clientY - this.rootTop;
    this.fingerX = x;
    this.fingerY = y;
    if (this.dragIdx === HIP) {
      if (this.applyFingerDelta(x, y)) this.sim.setHipTarget(this.target);
      return;
    }
    // browsers batch moves per frame: replay the coalesced samples so a flick keeps its speed
    let moved = false;
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (list && list.length > 1) {
      for (const ce of list) {
        if (this.applyFingerDelta(ce.clientX - this.rootLeft, ce.clientY - this.rootTop)) {
          this.vel.add(ce.timeStamp, this.target.x, this.target.y);
          moved = true;
        }
      }
    }
    if (this.applyFingerDelta(x, y)) {
      this.vel.add(e.timeStamp, this.target.x, this.target.y);
      moved = true;
    }
    if (!moved) return;
    this.sim.dragTo(IDS[this.dragIdx], this.target);
    this.evalCandidate(false);
    this.renderer.setCameraFocusHint(this.target);
  };

  /**
   * Wall-local motion (into `out`) between two overlay points, measured with the current camera on
   * both ends (so camera pans never move a limb, only the finger does).
   */
  private wallDelta(px: number, py: number, x: number, y: number, out: Vec2): boolean {
    const r = this.renderer;
    const a = r.screenToWall(px - this.offX, py - this.offY);
    const b = r.screenToWall(x - this.offX, y - this.offY);
    let dx: number;
    let dy: number;
    if (a && b) {
      dx = b.x - a.x;
      dy = b.y - a.y;
    } else if (this.homo.valid && this.homo.unmap(px, py, this.s0) && this.homo.unmap(x, y, this.s1)) {
      dx = this.s1.x - this.s0.x;
      dy = this.s1.y - this.s0.y;
    } else return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    out.x = dx;
    out.y = dy;
    return true;
  }

  /** Move the wall target by the finger's motion since the last event. */
  private applyFingerDelta(x: number, y: number): boolean {
    const px = this.prevX;
    const py = this.prevY;
    if (Math.abs(x - px) < 0.01 && Math.abs(y - py) < 0.01) return false;
    this.prevX = x;
    this.prevY = y;
    if (!this.wallDelta(px, py, x, y, this.s3)) return false;
    this.target.x += this.s3.x;
    this.target.y += this.s3.y;
    return true;
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragIdx === NONE) return;
    if (this.duo) {
      const slot = e.pointerId === this.pointerId ? 0 : e.pointerId === this.duoPid ? 1 : -1;
      if (slot < 0) return;
      this.moveDuo(slot, e.clientX - this.rootLeft, e.clientY - this.rootTop, e.timeStamp);
      this.finishDuo(e.timeStamp);
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    const idx = this.dragIdx;
    if (idx < 4) {
      // the lift point counts too (it can differ from the last move)
      const x = e.clientX - this.rootLeft;
      const y = e.clientY - this.rootTop;
      if (this.applyFingerDelta(x, y)) {
        this.vel.add(e.timeStamp, this.target.x, this.target.y);
        this.sim?.dragTo(IDS[idx], this.target);
      }
    }
    this.finishDrag(idx < 2 ? this.vel.velocity(e.timeStamp, this.relVel) : null);
  };

  private readonly onLostCapture = (e: PointerEvent): void => {
    if (this.dragIdx === NONE) return;
    if (this.duo && e.pointerId === this.duoPid) {
      // the second finger was taken away (system gesture): no throw, back to a plain hip drag end
      this.finishDrag();
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    this.finishDrag();
  };

  /**
   * End the active drag: drop the limb (grab / smear / clip / return; a hand released with a flick
   * `velocity` toward a hold beyond reach throws) or release the hips.
   */
  private finishDrag(velocity: Vec2 | null = null): void {
    const idx = this.dragIdx;
    if (idx === NONE) return;
    this.endDuo();
    const sim = this.sim;
    const pid = this.pointerId;
    this.dragIdx = NONE;
    this.pointerId = -1;
    if (pid >= 0 && this.root.hasPointerCapture?.(pid)) {
      try {
        this.root.releasePointerCapture(pid);
      } catch {
        /* already released */
      }
    }
    if (idx === HIP) {
      sim?.setHipTarget(null);
      bus.emit('input:hip-end');
    } else {
      const limb = IDS[idx];
      if (sim) {
        const v = velocity && Number.isFinite(velocity.x) && Number.isFinite(velocity.y) ? { x: velocity.x, y: velocity.y } : null;
        this.lastVel.x = v ? v.x : 0;
        this.lastVel.y = v ? v.y : 0;
        const events = v ? sim.endDrag(limb, { velocity: v }) : sim.endDrag(limb);
        for (const ev of events) bus.emit('sim:event', ev);
      }
      bus.emit('input:drag-end', { limb });
      this.renderer.setCameraFocusHint(null);
      this.cand = null;
      this.clip = null;
      this.dyno = null;
      this.dynoHold = null;
      this.zone = ZONE_NONE;
      this.clearOwnHighlights();
    }
    this.duoHintOn = false;
    this.setTag(this.candTag, false);
    this.setTag(this.clipTag, false);
    this.setTag(this.hipTag, false);
    this.setCursor('');
  }

  private refuse(idx: number): void {
    const el = this.handles[idx].nope;
    if (typeof el.animate !== 'function' || this.reduced) return;
    el.animate(
      [
        { transform: 'translate3d(0,0,0)' },
        { transform: 'translate3d(-6px,0,0)' },
        { transform: 'translate3d(5px,0,0)' },
        { transform: 'translate3d(-3px,0,0)' },
        { transform: 'translate3d(2px,0,0)' },
        { transform: 'translate3d(0,0,0)' },
      ],
      { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }

  // ── keyboard (desktop nicety: 1–4 arm a limb, 5/H the hips, Esc disarms) ──

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || !this.visible || !this.sim || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'Escape') {
      if (this.armed !== NONE) {
        this.armed = NONE;
        e.preventDefault();
      }
      return;
    }
    if ((e.key === 'c' || e.key === 'C') && this.dragIdx === NONE && this.state) {
      // chalk up the armed hand, else the greasier one
      const st = this.state;
      const hand = this.armed === 0 || this.armed === 1 ? IDS[this.armed] : (st.limbs.LH.friction ?? 1) <= (st.limbs.RH.friction ?? 1) ? 'LH' : 'RH';
      e.preventDefault();
      this.armed = NONE;
      this.chalkUp(hand as 'LH' | 'RH');
      return;
    }
    const idx = KEY_LIMB[e.key];
    if (idx === undefined || this.dragIdx !== NONE) return;
    e.preventDefault();
    this.armed = this.armed === idx ? NONE : idx;
  };

  // ═══════════════════════════════ drag queries ═══════════════════════════════

  private evalCandidate(force: boolean): void {
    const sim = this.sim;
    if (!sim || this.dragIdx < 0 || this.dragIdx > 3) return;
    const limb = IDS[this.dragIdx];
    const rope = this.dragIdx < 2 && sim.boulder.mode === 'rope';
    const release = (sim as ClimberSimAPI & { releaseTarget?: ReleaseTargetFn }).releaseTarget;
    let c: HoldDef | null;
    let q: QuickdrawDef | null = null;
    if (typeof release === 'function') {
      // the sim resolves hold vs. quickdraw the same way endDrag() will
      const r = release.call(sim, limb, this.target);
      c = r.hold;
      q = r.clip;
    } else {
      c = sim.snapCandidate(limb, this.target);
      if (rope) q = sim.clipCandidate(limb, this.target);
    }
    if (force || !this.candKnown || c !== this.cand) {
      this.cand = c;
      this.candKnown = true;
      this.quality = c ? sim.predictGrip(limb, c.id) : 0;
      this.qualityT = 0;
      this.highlightsDirty = true;
      bus.emit('input:drag-move', { limb, candidateHoldId: c ? c.id : null, quality: this.quality });
    }
    if (rope && q !== this.clip) {
      this.clip = q;
      this.highlightsDirty = true;
    }
    if (this.dragIdx < 2) this.evalDyno(sim, limb);
  }

  /** Throw preview: the hold a flick released here would deadpoint / dyno to (no static grab, no clip). */
  private evalDyno(sim: ClimberSimAPI, limb: LimbId): void {
    const d = !this.cand && !this.clip && typeof sim.dynoCandidate === 'function' ? sim.dynoCandidate(limb, this.target) : null;
    const prev = this.dynoHold;
    this.dyno = d;
    this.dynoHold = d ? (this.holdMap.get(d.holdId) ?? null) : null;
    if (this.dynoHold !== prev) this.highlightsDirty = true;
  }

  /**
   * Hand release targets (mirrors ClimberSim.releaseZone + its guards): the chalk bag needs the other
   * hand on a hold, the shake-out also a stance that holds without this hand. Only when the release
   * wouldn't grab a hold or clip.
   */
  private evalZone(state: ClimberState, idx: number): void {
    const L = state.limbs[IDS[idx]];
    const o = state.limbs[IDS[idx ^ 1]];
    spineUp(state.pelvis, state.chest, this.up);
    chalkBagAt(state.pelvis, this.up, this.bag);
    this.chalkOk = !!o.holdId && !o.busy && !o.dragging && !state.airborne;
    let worst = 0;
    if (this.chalkOk) {
      for (let k = 0; k < 4; k++) {
        if (k === idx) continue;
        const C = state.limbs[IDS[k]];
        if ((C.holdId || C.smearing) && C.stress > worst) worst = C.stress;
      }
    }
    this.shakeOk = this.chalkOk && worst <= SIM.shakeOutMaxStress;
    let z = ZONE_NONE;
    if (!this.cand && !this.clip) {
      const tx = this.target.x;
      const ty = this.target.y;
      if (inChalkZone(this.bag, tx, ty)) z = this.chalkOk ? ZONE_CHALK : ZONE_NONE;
      else if (this.shakeOk && inShakeLane(idx, L.anchor, this.up, tx, ty)) z = ZONE_SHAKE;
    }
    this.zone = z;
  }

  private updateDragQueries(state: ClimberState, dt: number): void {
    const sim = this.sim as ClimberSimAPI;
    const idx = this.dragIdx;
    const limb = IDS[idx];
    const L = state.limbs[limb];
    this.refreshEnvelope(sim, limb);
    this.outOfReach = this.envOn
      ? polyOutside(this.envPoly, this.target.x, this.target.y) > 0.01
      : Math.hypot(this.target.x - L.anchor.x, this.target.y - L.anchor.y) > this.reach + 0.01;
    // the anchor moves as the body sways: the candidate (reach-limited) can change without a move
    this.evalCandidate(false);
    if (idx < 2) this.evalZone(state, idx);
    else this.zone = ZONE_NONE;
    if (this.cand) {
      this.qualityT += dt;
      if (this.qualityT > 0.12) {
        this.qualityT = 0;
        const q = sim.predictGrip(limb, this.cand.id);
        if (Math.abs(q - this.quality) > 0.004) {
          this.quality = q;
          this.highlightsDirty = true;
        }
      }
    }
    this.reachT += dt;
    if (this.reachT > 0.15) {
      this.reachT = 0;
      const ids = sim.reachableHolds(limb);
      if (!sameIds(ids, this.reachIds)) {
        this.reachIds = ids;
        this.highlightsDirty = true;
      }
      let next: QuickdrawDef | null = null;
      if (idx < 2 && sim.boulder.mode === 'rope') next = nextReachableDraw(sim, state, L, this.envOn ? this.envPoly : null);
      if (next !== this.nextDrawReach) {
        this.nextDrawReach = next;
        this.highlightsDirty = true;
      }
    }
  }

  // ═══════════════════════════════ highlights ═══════════════════════════════

  private ownSlot(i: number): HoldHighlight {
    let h = this.ownPool[i];
    if (!h) {
      h = { holdId: '', kind: 'reachable', quality: 0 };
      this.ownPool[i] = h;
    }
    return h;
  }

  private rebuildOwnHighlights(state: ClimberState): void {
    this.highlightsDirty = false;
    if (this.dragIdx < 0 || this.dragIdx > 3) return;
    if (this.pure) {
      // Pure mode: no route-reading overlays — the climber's body is the feedback
      this.clearOwnHighlights();
      return;
    }
    const own = this.own;
    own.length = 0;
    let n = 0;
    const candId = this.cand ? this.cand.id : null;
    for (const id of this.reachIds) {
      if (id === candId) continue;
      const h = this.ownSlot(n++);
      h.holdId = id;
      h.kind = 'reachable';
      h.quality = 0;
      own.push(h);
    }
    if (this.nextDrawReach && (!this.clip || this.clip.id !== this.nextDrawReach.id)) {
      const h = this.ownSlot(n++);
      h.holdId = this.nextDrawReach.id;
      h.kind = 'reachable';
      h.quality = 0;
      own.push(h);
    }
    if (this.dynoHold && this.dynoHold.id !== candId) {
      // the throw target glows softly; the overlay draws the throw reticle on it
      const h = this.ownSlot(n++);
      h.holdId = this.dynoHold.id;
      h.kind = 'reachable';
      h.quality = 0;
      own.push(h);
    }
    if (candId) {
      const h = this.ownSlot(n++);
      h.holdId = candId;
      h.kind = 'candidate';
      h.quality = this.quality;
      own.push(h);
    }
    if (this.clip) {
      const h = this.ownSlot(n++);
      h.holdId = this.clip.id;
      h.kind = 'candidate';
      h.quality = 1;
      own.push(h);
    }
    this.ownActive = true;
    this.flushHighlights();
  }

  private clearOwnHighlights(): void {
    this.highlightsDirty = false;
    if (!this.ownActive) return;
    this.ownActive = false;
    this.own.length = 0;
    this.reachIds = [];
    this.flushHighlights();
  }

  private flushHighlights(): void {
    if (!this.ownActive || this.own.length === 0) {
      this.origSetHighlights(this.external);
      return;
    }
    if (this.external.length === 0) {
      this.origSetHighlights(this.own);
      return;
    }
    const m = this.merged;
    m.length = 0;
    for (const h of this.external) m.push(h);
    for (const h of this.own) m.push(h);
    this.origSetHighlights(m);
  }

  // ═══════════════════════════════ handle layout ═══════════════════════════════

  private layoutHandles(state: ClimberState, dt: number): void {
    const lay = this.layout;
    const drag = this.dragIdx;
    // body centre on screen (for the outward direction)
    let cx = this.pelvisX;
    let cy = this.pelvisY;
    for (let i = 0; i < 4; i++) {
      cx += this.limbX[i];
      cy += this.limbY[i];
    }
    cx /= 5;
    cy /= 5;

    for (let i = 0; i < 4; i++) {
      const h = this.handles[i];
      if (i === drag) {
        this.placeDraggedHandle(dt);
        lay.setBody(i, h.x, h.y, HANDLE_R * 1.12, 0);
        continue;
      }
      const lx = this.limbX[i];
      const ly = this.limbY[i];
      let bx = lx - cx;
      let by = ly - cy;
      const bl = Math.hypot(bx, by);
      if (bl > 1e-3) {
        bx /= bl;
        by /= bl;
      } else {
        bx = CANON_X[i];
        by = CANON_Y[i];
      }
      const r = drag !== NONE ? HANDLE_R * 0.84 : HANDLE_R;
      this.fitOffset(i, lx, ly, bx * 0.42 + CANON_X[i] * 0.58, by * 0.42 + CANON_Y[i] * 0.58, OFFSET[i], r);
      lay.setBody(i, this.s0.x, this.s0.y, r, 1);
    }
    // hip handle: sits on the pelvis, nudged only slightly when crowded (obstacles ignore it)
    lay.setBody(HIP, this.pelvisX, this.pelvisY, HIP_R, drag === HIP ? 0 : 0.12, false);

    lay.clearObstacles();
    // the hero head and the real hands / feet stay visible
    lay.addObstacle(this.headX, this.headY, this.headR + 2);
    for (let i = 0; i < 4; i++) if (i !== drag) lay.addObstacle(this.limbX[i], this.limbY[i], 15);
    if (drag !== NONE && drag !== HIP && this.homo.valid) {
      // keep every other handle off the reticle and the hold being aimed at
      if (this.homo.map(this.target.x, this.target.y, this.s1)) lay.addObstacle(this.s1.x, this.s1.y, 26);
      const c = this.cand ?? this.dynoHold;
      if (c && this.homo.map(c.x, c.y, this.s1)) {
        const rpx = holdRadius(c) * this.homo.scaleAt(c.x, c.y, this.s2, this.s3);
        lay.addObstacle(this.s1.x, this.s1.y, rpx + 8);
      }
      const tag = this.candTag;
      if (tag.on && Number.isFinite(tag.x)) lay.addObstacle(tag.x, tag.y, Math.max(tag.w, tag.h) * 0.5 + 4);
    }
    if (drag === HIP) {
      // the finger is on the hip target: keep handles off it
      lay.addObstacle(this.fingerX, this.fingerY, 30);
      const c = this.duo ? this.duoHold : null;
      if (c && this.homo.valid && this.homo.map(c.x, c.y, this.s1)) {
        const rpx = holdRadius(c) * this.homo.scaleAt(c.x, c.y, this.s2, this.s3);
        lay.addObstacle(this.s1.x, this.s1.y, rpx + 10);
      }
      if (this.duo && this.duoPid >= 0) lay.addObstacle(this.duoX[1], this.duoY[1], 30);
    }
    lay.solve(this.safe, GAP, 8);

    for (let i = 0; i < 5; i++) {
      const h = this.handles[i];
      if (i === drag && i !== HIP) continue;
      const tx = lay.x[i];
      const ty = lay.y[i];
      if (!h.placed) {
        h.x = tx;
        h.y = ty;
        h.placed = true;
      } else {
        const k = i === HIP ? 30 : 18;
        h.x = damp(h.x, tx, k, dt);
        h.y = damp(h.y, ty, k, dt);
      }
    }
  }

  /**
   * Desired handle centre (into s0): `off` px from the limb, choosing from a fan of directions around
   * the outward one the position that best fits the safe viewport, clears the head and doesn't hide
   * route holds (players read the next holds past the handles), with hysteresis against flicker.
   */
  private fitOffset(i: number, lx: number, ly: number, ux: number, uy: number, off: number, r: number): void {
    const base = Math.atan2(uy, ux);
    const sign = i === 1 || i === 2 ? 1 : -1;
    const rc = this.safe;
    const prev = this.prevAng[i];
    const STEP = (15 * Math.PI) / 180;
    let bestA = base;
    let bestCost = Infinity;
    for (let k = 0; k <= 20; k++) {
      const step = (k + 1) >> 1;
      const delta = (k === 0 ? 0 : (k & 1 ? sign : -sign) * step) * STEP;
      const a = base + delta;
      const x = lx + Math.cos(a) * off;
      const y = ly + Math.sin(a) * off;
      let cost = step * 15;
      // viewport
      let over = 0;
      if (x - r < rc.left) over += rc.left - (x - r);
      if (x + r > rc.right) over += x + r - rc.right;
      if (y - r < rc.top) over += rc.top - (y - r);
      if (y + r > rc.bottom) over += y + r - rc.bottom;
      cost += over * 6;
      // the hero head
      const hd = Math.hypot(x - this.headX, y - this.headY) - (this.headR + r);
      if (hd < 0) cost -= hd * 3;
      // route holds under the handle
      for (let k2 = 0; k2 < this.holdN; k2++) {
        const hr = this.holdSR[k2];
        if (hr <= 0) continue;
        const dd = Math.hypot(x - this.holdSX[k2], y - this.holdSY[k2]) - (hr + r + 2);
        if (dd < 0) cost -= dd * 2.2;
      }
      // hysteresis: stay with the previous choice unless something is clearly better
      if (prev === prev) {
        let dp = Math.abs(a - prev) % (Math.PI * 2);
        if (dp > Math.PI) dp = Math.PI * 2 - dp;
        cost += (dp / STEP) * 7;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestA = a;
      }
    }
    this.prevAng[i] = bestA;
    this.s0.x = lx + Math.cos(bestA) * off;
    this.s0.y = ly + Math.sin(bestA) * off;
  }

  /** Dragged handle: under the finger, leaning away from the target so it never covers the hold. */
  private placeDraggedHandle(dt: number): void {
    const h = this.handles[this.dragIdx];
    let hx = this.fingerX + this.grabOffX;
    let hy = this.fingerY + this.grabOffY;
    if (this.homo.valid && this.homo.map(this.target.x, this.target.y, this.s0)) {
      const vx = hx - this.s0.x;
      const vy = hy - this.s0.y;
      const len = Math.hypot(vx, vy);
      let holdPx = 18;
      const c = this.cand ?? this.dynoHold;
      if (c) holdPx = Math.max(holdPx, holdRadius(c) * this.homo.scaleAt(c.x, c.y, this.s2, this.s3));
      const need = HANDLE_R * 1.12 + holdPx + 10;
      this.pushAmt = damp(this.pushAmt, Math.max(0, need - len), 16, dt);
      if (len > 1e-3) {
        hx += (vx / len) * this.pushAmt;
        hy += (vy / len) * this.pushAmt;
      } else {
        hy -= this.pushAmt;
      }
    }
    // the handle may follow the finger to the edge, but the lean never pushes it further off-screen
    const m = HANDLE_R * 0.35;
    h.x = clamp(hx, Math.min(m, this.fingerX), Math.max(this.W - m, this.fingerX));
    h.y = clamp(hy, Math.min(m, this.fingerY), Math.max(this.H - m, this.fingerY));
    h.placed = true;
  }

  // ═══════════════════════════════ handle rendering ═══════════════════════════════

  private writeHandles(state: ClimberState): void {
    const drag = this.dragIdx;
    const t = this.time;
    const motion = !this.reduced;
    for (let i = 0; i < 5; i++) {
      const h = this.handles[i];
      let flags = 0;
      let jx = 0;
      let jy = 0;
      if (i < 4) {
        const L: LimbSnapshot = state.limbs[IDS[i]];
        const attached = !!L.holdId || L.smearing;
        if (i === drag) flags |= F_DRAG;
        else if (drag !== NONE) flags |= F_DIM;
        if (!(this.allowedMask & (1 << i))) flags |= F_LOCKED;
        if (L.busy) flags |= F_BUSY;
        else if (!attached && i !== drag) flags |= F_FREE;
        if (L.smearing) flags |= F_SMEAR;
        if (attached && !L.busy && i !== drag) {
          if (L.stress > 1.0 || L.shake > 0.45) flags |= F_OVER;
          if (L.stress > 1.3) flags |= F_CRIT;
        }
        if (this.armed === i) flags |= F_ARMED;
        if (drag === NONE && this.allowedMask !== 15 && this.allowedMask & (1 << i) && !L.busy) flags |= F_FOCUS;
        if (i === drag && this.dynoHold) flags |= F_THROW;
        if (state.airborne) flags |= F_AIR;
        // stress ring
        const stress = attached && i !== drag && !L.busy ? L.stress : 0;
        const frac = clamp(stress / RING_FULL, 0, 1);
        const dash = Math.round(RING_C * (1 - frac) * 2) / 2;
        if (dash !== h.dash && h.arc) {
          h.dash = dash;
          h.arc.style.strokeDashoffset = String(dash);
        }
        const ci = stressIndex(stress);
        if (ci !== h.color && h.arc) {
          h.color = ci;
          h.arc.style.stroke = STRESS_COLORS[ci];
        }
        // tremor: "Elvis leg" + whole-body shake + overload
        if (motion && attached && i !== drag) {
          const amp = Math.min(4.5, L.shake * 3.2 + state.shake * 1.8 + Math.max(0, L.stress - 1) * 4);
          if (amp > 0.05) {
            jx = amp * Math.sin(t * 71 + i * 1.7);
            jy = amp * Math.cos(t * 59 + i * 2.3);
          }
        }
      } else {
        if (drag === HIP) flags |= F_DRAG;
        else if (drag !== NONE) flags |= F_DIM;
        if (!this.hipsAllowed) flags |= F_LOCKED;
        if (this.armed === HIP) flags |= F_ARMED;
        if (drag === NONE && this.hipsAllowed && this.allowedMask === 0) flags |= F_FOCUS;
        if (drag === HIP && this.duo) flags |= F_DUO;
        if (state.airborne) flags |= F_AIR;
      }
      if (flags !== h.flags) {
        const diff = flags ^ h.flags;
        for (const [bit, cls] of FLAG_CLASSES) if (diff & bit) h.el.classList.toggle(cls, !!(flags & bit));
        h.flags = flags;
      }
      const x = h.x + jx;
      const y = h.y + jy;
      if (!(Math.abs(x - h.wx) <= 0.05 && Math.abs(y - h.wy) <= 0.05)) {
        h.wx = x;
        h.wy = y;
        h.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      }
    }
  }

  // ═══════════════════════════════ labels ═══════════════════════════════

  private setTag(tag: TagView, on: boolean): void {
    if (tag.on === on) return;
    tag.on = on;
    tag.el.classList.toggle('on', on);
    if (!on) tag.x = tag.y = NaN;
  }

  private setTagText(tag: TagView, word: string, type: string, color: string): void {
    const key = word + '|' + type + '|' + color;
    if (key === tag.key) return;
    tag.key = key;
    tag.word.textContent = word;
    tag.type.textContent = type;
    tag.el.style.color = color;
    tag.w = tag.el.offsetWidth || tag.w;
    tag.h = tag.el.offsetHeight || tag.h;
  }

  /**
   * Put a tag beside a screen point (radius `radius`), on the horizontal side away from the dragged
   * handle at (awayX, awayY), flipping when it would leave the viewport.
   */
  private placeTag(tag: TagView, px: number, py: number, radius: number, awayX: number, awayY: number): void {
    const m = 8;
    const half = tag.w / 2;
    let side = px >= awayX ? 1 : -1;
    const reach = radius + 10 + half;
    if (px + side * reach + half > this.W - m || px + side * reach - half < m) side = -side;
    let x = px + side * reach;
    let y = py;
    // never under the dragged handle
    const dy = y - awayY;
    if (Math.abs(x - awayX) < half + HANDLE_R * 1.12 + 4 && Math.abs(dy) < tag.h / 2 + HANDLE_R * 1.12 + 4) {
      y = awayY + (dy >= 0 ? 1 : -1) * (tag.h / 2 + HANDLE_R * 1.12 + 6);
    }
    x = clamp(x, m + half, this.W - m - half);
    y = clamp(y, this.insets.top + m + tag.h / 2, this.H - this.insets.bottom - m - tag.h / 2);
    if (!Number.isFinite(tag.x) || Math.abs(x - tag.x) > 0.1 || Math.abs(y - tag.y) > 0.1) {
      tag.x = x;
      tag.y = y;
      tag.el.style.transform = `translate3d(${(x - half).toFixed(1)}px,${(y - tag.h / 2).toFixed(1)}px,0)`;
    }
  }

  private updateTags(state: ClimberState): void {
    const idx = this.dragIdx;
    if (idx === HIP && this.assist && !this.pure && this.homo.valid) {
      this.setTag(this.clipTag, false);
      const hip = this.handles[HIP];
      const c = this.duo ? this.duoHold : null;
      if (c && this.homo.map(c.x, c.y, this.s0)) {
        const t = throwWord({ kind: 'dyno', rise: this.duoRise, feasible: this.duoFeasible });
        this.setTagText(this.candTag, t.word, t.type, this.duoFeasible ? C_THROW : PALETTE.mist);
        const rpx = holdRadius(c) * this.homo.scaleAt(c.x, c.y, this.s2, this.s3);
        this.placeTag(this.candTag, this.s0.x, this.s0.y, rpx + 6, hip.x, hip.y);
        this.setTag(this.candTag, true);
      } else this.setTag(this.candTag, false);
      if (this.duoHintOn && !this.duo) {
        this.setTagText(this.hipTag, 'DYNO', '2 FINGERS + FLICK', C_THROW);
        this.placeTag(this.hipTag, hip.x, hip.y, HIP_R + 2, hip.x + (hip.x >= this.W / 2 ? 1 : -1), hip.y + 999);
        this.setTag(this.hipTag, true);
      } else this.setTag(this.hipTag, false);
      return;
    }
    this.setTag(this.hipTag, false);
    if (idx < 0 || idx > 3 || !this.assist || this.pure || !this.homo.valid) {
      this.setTag(this.candTag, false);
      this.setTag(this.clipTag, false);
      return;
    }
    const sim = this.sim as ClimberSimAPI;
    const h = this.handles[idx];
    const c = this.cand;
    const d = this.dyno;
    const dh = this.dynoHold;
    let tagOn = false;
    if (c && this.homo.map(c.x, c.y, this.s0)) {
      const other = state.limbs[IDS[idx ^ 1]];
      const type = c.role === 'top' && idx < 2 ? 'TOP' : other.holdId === c.id && !other.dragging ? 'MATCH' : TYPE_WORD[c.type];
      this.setTagText(this.candTag, qualityWord(this.quality), type, qualityColor(this.quality));
      const rpx = holdRadius(c) * this.homo.scaleAt(c.x, c.y, this.s2, this.s3);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, rpx, h.x, h.y);
      tagOn = true;
    } else if (d && dh && this.homo.map(dh.x, dh.y, this.s0)) {
      const t = throwWord(d);
      this.setTagText(this.candTag, t.word, t.type, d.feasible ? C_THROW : PALETTE.mist);
      const rpx = holdRadius(dh) * this.homo.scaleAt(dh.x, dh.y, this.s2, this.s3);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, rpx + 6, h.x, h.y);
      tagOn = true;
    } else if (this.zone === ZONE_CHALK && this.homo.map(this.bag.x, this.bag.y, this.s0)) {
      const f = state.limbs[IDS[idx]].friction;
      this.setTagText(this.candTag, 'CHALK UP', f === undefined ? '' : frictionWord(f), PALETTE.chalk);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, SIM.chalkZone * this.homo.scaleAt(this.bag.x, this.bag.y, this.s2, this.s3), h.x, h.y);
      tagOn = true;
    } else if (this.zone === ZONE_SHAKE && this.homo.map(this.target.x, this.target.y, this.s0)) {
      const pump = state.limbs[IDS[idx]].pump;
      this.setTagText(this.candTag, 'SHAKE OUT', pump === undefined ? '' : `PUMP ${Math.round(clamp(pump, 0, 1) * 100)}%`, PALETTE.glacier);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, 18, h.x, h.y);
      tagOn = true;
    } else if (idx >= 2 && sim.boulder.wallAngle <= SIM.smearMaxAngle && !this.outOfReach && this.homo.map(this.target.x, this.target.y, this.s0)) {
      this.setTagText(this.candTag, 'SMEAR', '', PALETTE.glacier);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, 16, h.x, h.y);
      tagOn = true;
    }
    this.setTag(this.candTag, tagOn && !this.clip);

    const q = this.clip;
    if (q && this.homo.map(q.x, q.y - SIM.quickdrawDrop, this.s1)) {
      this.setTagText(this.clipTag, 'CLIP', state.clipped.length === 0 ? 'FIRST' : '', '#FFFFFF');
      this.placeTag(this.clipTag, this.s1.x, this.s1.y, 0.09 * this.homo.scaleAt(q.x, q.y, this.s2, this.s3), h.x, h.y);
      this.setTag(this.clipTag, true);
    } else this.setTag(this.clipTag, false);
  }

  // ═══════════════════════════════ overlay canvas ═══════════════════════════════

  private clearCanvas(): void {
    if (!this.drawn) return;
    const pad = 4;
    this.ctx.clearRect(this.dMinX - pad, this.dMinY - pad, this.dMaxX - this.dMinX + pad * 2, this.dMaxY - this.dMinY + pad * 2);
    this.drawn = false;
  }

  private grow(x: number, y: number, r: number): void {
    if (!this.drawn) {
      this.dMinX = x - r;
      this.dMinY = y - r;
      this.dMaxX = x + r;
      this.dMaxY = y + r;
      this.drawn = true;
      return;
    }
    if (x - r < this.dMinX) this.dMinX = x - r;
    if (y - r < this.dMinY) this.dMinY = y - r;
    if (x + r > this.dMaxX) this.dMaxX = x + r;
    if (y + r > this.dMaxY) this.dMaxY = y + r;
  }

  private draw(state: ClimberState): void {
    this.clearCanvas();
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drag = this.dragIdx;
    if (this.pure) return; // Pure mode: no overlay drawing at all (the handle shows a faint ring)
    if (drag >= 0 && drag < 4 && this.homo.valid) this.drawLimbDrag(state, drag);
    this.drawLeaders(state);
    if (drag === HIP && this.homo.valid) {
      if (this.duo) this.drawDuo(state);
      else this.drawHipDrag(state);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash(DASH_NONE);
  }

  /** Hairline leaders from each handle to its real hand / foot. */
  private drawLeaders(state: ClimberState): void {
    const ctx = this.ctx;
    const drag = this.dragIdx;
    for (let i = 0; i < 4; i++) {
      if (i === drag) continue;
      const h = this.handles[i];
      if (!h.placed) continue;
      const lx = this.limbX[i];
      const ly = this.limbY[i];
      const hx = h.wx;
      const hy = h.wy;
      let dx = lx - hx;
      let dy = ly - hy;
      const d = Math.hypot(dx, dy);
      const dimmed = drag !== NONE || !(this.allowedMask & (1 << i));
      const alpha = dimmed ? 0.22 : 1;
      const hr = drag !== NONE ? HANDLE_R * 0.84 : HANDLE_R;
      if (d > hr + 7) {
        dx /= d;
        dy /= d;
        const x0 = hx + dx * (hr + 1.5);
        const y0 = hy + dy * (hr + 1.5);
        const x1 = lx - dx * 5;
        const y1 = ly - dy * 5;
        ctx.setLineDash(DASH_NONE);
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = C_SHADOW;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.62;
        ctx.strokeStyle = C_BONE;
        ctx.lineWidth = 1;
        ctx.stroke();
        this.grow(x0, y0, 3);
        this.grow(x1, y1, 3);
      }
      // limb pip: hairline ring with a dark core
      const L = state.limbs[IDS[i]];
      const attached = !!L.holdId || L.smearing;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(13,14,16,0.72)';
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = attached ? STRESS_COLORS[stressIndex(L.stress)] : C_BONE;
      ctx.stroke();
      this.grow(lx, ly, 6);
    }
  }

  /** Pull the dragged limb's reach envelope from the sim (optional API; circle fallback). */
  private refreshEnvelope(sim: ClimberSimAPI, limb: LimbId): void {
    const env = (sim as ClimberSimAPI & { reachEnvelope?: (l: LimbId, out?: Vec2[]) => Vec2[] }).reachEnvelope;
    if (typeof env !== 'function') {
      this.envOn = false;
      return;
    }
    const poly = env.call(sim, limb, this.envPoly);
    this.envOn = Array.isArray(poly) && poly.length >= 4;
    if (this.envOn) this.envPoly = poly;
  }

  /** Boundary point of the envelope polygon along the ray from (ax, ay) at angle `a`, into `out`. */
  private envRay(ax: number, ay: number, a: number, out: Vec2): boolean {
    const poly = this.envPoly;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = -1;
    // edges between boundary vertices (vertex 0 is the anchor itself)
    for (let i = 1; i + 1 < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[i + 1];
      const ex = p1.x - p0.x;
      const ey = p1.y - p0.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = p0.x - ax;
      const qy = p0.y - ay;
      const t = (qx * ey - qy * ex) / den;
      const u = (qx * dy - qy * dx) / den;
      if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > best) best = t;
    }
    if (best <= 0) return false;
    out.x = ax + dx * best;
    out.y = ay + dy * best;
    return true;
  }

  /** Anatomical reach envelope: soft fill, faint dashed edge, emphasised edge + ticks toward the finger. */
  private drawEnvelope(ax: number, ay: number, tAng: number, out: boolean): void {
    const ctx = this.ctx;
    const H = this.homo;
    const p = this.s0;
    const poly = this.envPoly;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < poly.length; k++) {
      if (!H.map(poly[k].x, poly[k].y, p)) continue;
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else ctx.lineTo(p.x, p.y);
      this.grow(p.x, p.y, 8);
    }
    if (started) {
      ctx.closePath();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(246,244,239,0.045)';
      ctx.fill();
      ctx.setLineDash(DASH_RING);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(246,244,239,0.22)';
      ctx.stroke();
    }
    // emphasised edge toward the target (breaks where the envelope has no boundary: the forbidden
    // wedge, e.g. straight up from a hip)
    const span = (52 * Math.PI) / 180;
    const M = 26;
    const b = this.rayHit;
    ctx.setLineDash(DASH_NONE);
    ctx.beginPath();
    started = false;
    for (let k = 0; k <= M; k++) {
      const a = tAng - span + (2 * span * k) / M;
      if (!this.envRay(ax, ay, a, b) || !H.map(b.x, b.y, p)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = C_SHADOW;
    ctx.lineWidth = 3.5;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.strokeStyle = out ? PALETTE.signal : PALETTE.chalk;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    // spec-sheet ticks along it, pointing away from the anchor; the major tick at the target bearing
    const TK = 8;
    const step = span / TK;
    for (let k = -TK; k <= TK; k++) {
      const a = tAng + k * step;
      if (!this.envRay(ax, ay, a, b)) continue;
      const major = k === 0;
      const len = major ? 0.075 : k % 2 === 0 ? 0.045 : 0.028;
      if (!H.map(b.x, b.y, p)) continue;
      if (!H.map(b.x + Math.cos(a) * len, b.y + Math.sin(a) * len, this.s1)) continue;
      ctx.globalAlpha = (1 - Math.abs(k) / (TK + 1)) * (major ? 0.95 : 0.7);
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(this.s1.x, this.s1.y);
      ctx.stroke();
    }
  }

  private drawLimbDrag(state: ClimberState, idx: number): void {
    const ctx = this.ctx;
    const H = this.homo;
    const L = state.limbs[IDS[idx]];
    const ax = L.anchor.x;
    const ay = L.anchor.y;
    const R = this.reach;
    const tx = this.target.x;
    const ty = this.target.y;
    const tAng = Math.atan2(ty - ay, tx - ax);
    const p = this.s0;
    const out = this.outOfReach;

    if (this.assist && this.envOn) this.drawEnvelope(ax, ay, tAng, out);
    else if (this.assist) {
      // reachable disc (soft fill) + full boundary (faint dashes)
      const N = 72;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2;
        if (!H.map(ax + Math.cos(a) * R, ay + Math.sin(a) * R, p)) continue;
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
        this.grow(p.x, p.y, 8);
      }
      if (started) {
        ctx.closePath();
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(246,244,239,0.045)';
        ctx.fill();
        ctx.setLineDash(DASH_RING);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(246,244,239,0.22)';
        ctx.stroke();
      }
      // emphasised arc toward the target, with spec-sheet ticks
      const span = (52 * Math.PI) / 180;
      const M = 26;
      ctx.setLineDash(DASH_NONE);
      ctx.beginPath();
      started = false;
      for (let k = 0; k <= M; k++) {
        const a = tAng - span + (2 * span * k) / M;
        if (!H.map(ax + Math.cos(a) * R, ay + Math.sin(a) * R, p)) continue;
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = C_SHADOW;
      ctx.lineWidth = 3.5;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.strokeStyle = out ? PALETTE.signal : PALETTE.chalk;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      // ticks every 6.5°, fading toward the ends; the major tick points at the target
      const TK = 8;
      const step = span / TK;
      for (let k = -TK; k <= TK; k++) {
        const a = tAng + k * step;
        const major = k === 0;
        const len = major ? 0.075 : k % 2 === 0 ? 0.045 : 0.028;
        if (!H.map(ax + Math.cos(a) * R, ay + Math.sin(a) * R, p)) continue;
        if (!H.map(ax + Math.cos(a) * (R + len), ay + Math.sin(a) * (R + len), this.s1)) continue;
        ctx.globalAlpha = (1 - Math.abs(k) / (TK + 1)) * (major ? 0.95 : 0.7);
        ctx.lineWidth = major ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(this.s1.x, this.s1.y);
        ctx.stroke();
      }
    }

    // hand release targets: chalk bag at the hips, shake-out lane beside the body
    if (idx < 2) this.drawReleaseTargets(state, idx);

    // anchor (shoulder / hip) marker
    if (!H.map(ax, ay, p)) return;
    const axs = p.x;
    const ays = p.y;
    ctx.globalAlpha = 0.75;
    ctx.setLineDash(DASH_NONE);
    ctx.strokeStyle = PALETTE.chalk;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(axs - 5, ays);
    ctx.lineTo(axs + 5, ays);
    ctx.moveTo(axs, ays - 5);
    ctx.lineTo(axs, ays + 5);
    ctx.stroke();
    this.grow(axs, ays, 7);

    // reticle position
    if (!H.map(tx, ty, this.s1)) return;
    const rx = this.s1.x;
    const ry = this.s1.y;
    const c = this.cand;
    const dyno = this.dyno && this.dynoHold ? this.dyno : null;
    const colour = c
      ? qualityColor(this.quality)
      : dyno
        ? dyno.feasible
          ? C_THROW
          : C_THROW_DIM
        : this.zone === ZONE_CHALK
          ? PALETTE.chalk
          : this.zone === ZONE_SHAKE
            ? PALETTE.glacier
            : out
              ? PALETTE.fog
              : this.clip
                ? PALETTE.signal
                : PALETTE.chalk;
    const RR = 11;
    if (dyno && this.dynoHold) this.drawThrow(L.pos.x, L.pos.y, this.dynoHold, dyno.feasible, true);

    // dashed anchor → target line (stops at the reticle)
    let dx = rx - axs;
    let dy = ry - ays;
    const dl = Math.hypot(dx, dy);
    if (dl > RR + 8) {
      dx /= dl;
      dy /= dl;
      ctx.setLineDash(DASH_ANCHOR);
      ctx.lineDashOffset = -this.time * 18;
      ctx.beginPath();
      ctx.moveTo(axs + dx * 7, ays + dy * 7);
      ctx.lineTo(rx - dx * (RR + 3), ry - dy * (RR + 3));
      ctx.strokeStyle = C_SHADOW;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      ctx.strokeStyle = PALETTE.chalk;
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.72;
      ctx.stroke();
      ctx.lineDashOffset = 0;
    }

    // finger link: hairline from the dragged handle to the reticle
    const h = this.handles[idx];
    let fx = h.x - rx;
    let fy = h.y - ry;
    const fl = Math.hypot(fx, fy);
    const hr = HANDLE_R * 1.12;
    if (fl > hr + RR + 6) {
      fx /= fl;
      fy /= fl;
      ctx.setLineDash(DASH_NONE);
      ctx.beginPath();
      ctx.moveTo(rx + fx * (RR + 4), ry + fy * (RR + 4));
      ctx.lineTo(h.x - fx * (hr + 2), h.y - fy * (hr + 2));
      ctx.strokeStyle = C_SHADOW;
      ctx.lineWidth = 2.6;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.strokeStyle = PALETTE.chalk;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.42;
      ctx.stroke();
      this.grow(h.x, h.y, hr + 4);
    }

    // reticle: ring with four diagonal ticks and a centre dot
    ctx.setLineDash(out ? DASH_RING : DASH_NONE);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = C_SHADOW;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(rx, ry, RR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.75;
    ctx.stroke();
    ctx.setLineDash(DASH_NONE);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.moveTo(rx + ca * (RR + 3), ry + sa * (RR + 3));
      ctx.lineTo(rx + ca * (RR + 8), ry + sa * (RR + 8));
    }
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rx, ry, 1.9, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    this.grow(rx, ry, RR + 12);
  }

  /**
   * Throw preview: a ballistic arc (wall-local quadratic that bulges upward with the sideways
   * distance, like the body's flight) from the hand at (sx, sy) to the hold, a FLICK cue at its
   * middle, and a segmented throw reticle on the hold. Grey and short of the hold when infeasible.
   */
  private drawThrow(sx: number, sy: number, hold: HoldDef, feasible: boolean, cue: boolean): void {
    const ctx = this.ctx;
    const H = this.homo;
    const p = this.s0;
    const ex = hold.x;
    const ey = hold.y;
    const cx = (sx + ex) / 2;
    const cy = (sy + ey) / 2 + Math.abs(ex - sx) * 0.42 + 0.05;
    const N = 22;
    const tEnd = feasible ? 1 : 0.72;
    const scale = H.scaleAt(ex, ey, this.s2, this.s3);
    const holdPx = holdRadius(hold) * scale;
    const stop = holdPx + 7; // the arc ends at the reticle ring
    const endOk = H.map(ex, ey, this.s1);
    const hx = this.s1.x;
    const hy = this.s1.y;
    ctx.beginPath();
    let started = false;
    let lx = 0;
    let ly = 0;
    let px = 0;
    let py = 0;
    let midX = 0;
    let midY = 0;
    let midTx = 0;
    let midTy = 0;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * tEnd;
      const u = 1 - t;
      const x = u * u * sx + 2 * u * t * cx + t * t * ex;
      const y = u * u * sy + 2 * u * t * cy + t * t * ey;
      if (!H.map(x, y, p)) continue;
      if (k === N >> 1) {
        midX = p.x;
        midY = p.y;
      }
      // stop where the arc meets the reticle ring
      if (feasible && endOk && t > 0.5 && Math.hypot(p.x - hx, p.y - hy) < stop) break;
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else ctx.lineTo(p.x, p.y);
      px = lx;
      py = ly;
      lx = p.x;
      ly = p.y;
      this.grow(p.x, p.y, 10);
    }
    if (!started) return;
    ctx.setLineDash(DASH_NONE);
    ctx.strokeStyle = C_SHADOW;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.setLineDash(feasible ? DASH_THROW : DASH_RING);
    ctx.lineDashOffset = feasible && !this.reduced ? -this.time * 26 : 0;
    ctx.strokeStyle = feasible ? C_THROW : C_THROW_DIM;
    ctx.lineWidth = 2;
    ctx.globalAlpha = feasible ? 0.95 : 0.8;
    ctx.stroke();
    ctx.lineDashOffset = 0;
    ctx.setLineDash(DASH_NONE);
    // arrowhead along the last segment (feasible) / a small bar where a short throw dies
    let dx = lx - px;
    let dy = ly - py;
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-3) {
      dx /= dl;
      dy /= dl;
      ctx.beginPath();
      if (feasible) {
        ctx.moveTo(lx + dx * 2, ly + dy * 2);
        ctx.lineTo(lx - dx * 7 - dy * 5, ly - dy * 7 + dx * 5);
        ctx.lineTo(lx - dx * 7 + dy * 5, ly - dy * 7 - dx * 5);
        ctx.closePath();
        ctx.fillStyle = C_THROW;
        ctx.globalAlpha = 1;
        ctx.fill();
      } else {
        ctx.moveTo(lx - dy * 6, ly + dx * 6);
        ctx.lineTo(lx + dy * 6, ly - dx * 6);
        ctx.strokeStyle = C_THROW_DIM;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.9;
        ctx.stroke();
      }
    }
    // FLICK cue at the middle of the arc, offset to its outer side
    if (cue && feasible && this.assist && midX) {
      midTx = lx - midX;
      midTy = ly - midY;
      const ml = Math.hypot(midTx, midTy) || 1;
      let nx = -midTy / ml;
      let ny = midTx / ml;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      const tx = midX + nx * 14;
      const ty = midY + ny * 14;
      ctx.font = FLICK_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 3;
      ctx.strokeStyle = C_SHADOW;
      ctx.strokeText('FLICK', tx, ty);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C_THROW;
      ctx.fillText('FLICK', tx, ty);
      this.grow(tx, ty, 22);
    }
    // throw reticle: four rotating arcs around the hold + inward ticks
    if (!H.map(ex, ey, p)) return;
    const rx = p.x;
    const ry = p.y;
    const R = holdPx + 6;
    const rot = this.reduced ? Math.PI / 4 : Math.PI / 4 + this.time * 0.9;
    const col = feasible ? C_THROW : C_THROW_DIM;
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a0 = rot + (k * Math.PI) / 2 + 0.3;
        const a1 = rot + ((k + 1) * Math.PI) / 2 - 0.3;
        ctx.moveTo(rx + Math.cos(a0) * R, ry + Math.sin(a0) * R);
        ctx.arc(rx, ry, R, a0, a1);
      }
      ctx.setLineDash(pass === 1 && !feasible ? DASH_RING : DASH_NONE);
      ctx.strokeStyle = pass === 0 ? C_SHADOW : col;
      ctx.lineWidth = pass === 0 ? 4.5 : 2;
      ctx.globalAlpha = pass === 0 ? 0.6 : 1;
      ctx.stroke();
    }
    ctx.setLineDash(DASH_NONE);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = rot + (k * Math.PI) / 2;
      ctx.moveTo(rx + Math.cos(a) * (R + 4), ry + Math.sin(a) * (R + 4));
      ctx.lineTo(rx + Math.cos(a) * (R - 3), ry + Math.sin(a) * (R - 3));
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    this.grow(rx, ry, R + 8);
  }

  /** Double dyno: arcs from both hands to the shared target, or a faint ring at the hips with no target. */
  private drawDuo(state: ClimberState): void {
    const c = this.duoHold;
    const ctx = this.ctx;
    const hip = this.handles[HIP];
    if (!c) {
      ctx.setLineDash(DASH_RING);
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = C_THROW_DIM;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hip.x, hip.y, HIP_R + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash(DASH_NONE);
      this.grow(hip.x, hip.y, HIP_R + 16);
      return;
    }
    const LH = state.limbs.LH;
    const RH = state.limbs.RH;
    this.drawThrow(LH.pos.x, LH.pos.y, c, this.duoFeasible, false);
    this.drawThrow(RH.pos.x, RH.pos.y, c, this.duoFeasible, true);
  }

  /** Chalk bag + shake-out lane while a hand is dragged: faint until the finger nears them, lit when it would trigger. */
  private drawReleaseTargets(state: ClimberState, idx: number): void {
    const ctx = this.ctx;
    const H = this.homo;
    const p = this.s0;
    const tx = this.target.x;
    const ty = this.target.y;
    // chalk bag
    if (this.chalkOk && H.map(this.bag.x, this.bag.y, p)) {
      const d = Math.hypot(tx - this.bag.x, ty - this.bag.y) - SIM.chalkZone;
      const on = this.zone === ZONE_CHALK;
      // always a whisper while a hand is dragged, clearer as the finger nears the hips
      const a = on ? 1 : 0.22 + clamp(1 - d / 0.55, 0, 1) * 0.43;
      if (a > 0.02) {
        const bx = p.x;
        const by = p.y;
        const r = SIM.chalkZone * H.scaleAt(this.bag.x, this.bag.y, this.s2, this.s3);
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        if (on) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(246,244,239,0.12)';
          ctx.fill();
        }
        ctx.setLineDash(on ? DASH_NONE : DASH_RING);
        ctx.globalAlpha = a * 0.7;
        ctx.strokeStyle = C_SHADOW;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = a;
        ctx.strokeStyle = PALETTE.chalk;
        ctx.lineWidth = on ? 1.6 : 1.1;
        ctx.stroke();
        ctx.setLineDash(DASH_NONE);
        this.drawBagGlyph(bx, by, a);
        this.grow(bx, by, r + 4);
      }
    }
    // shake-out lane (beside the body, below the shoulder)
    if (this.shakeOk) {
      const A = state.limbs[IDS[idx]].anchor;
      const L = SHAKE_LANE;
      shakeLanePoint(idx, A, this.up, (L.down0 + L.down1) / 2, (L.out0 + L.out1) / 2, this.s1);
      const d = Math.max(0, Math.hypot(tx - this.s1.x, ty - this.s1.y) - 0.24);
      const on = this.zone === ZONE_SHAKE;
      const a = on ? 1 : 0.2 + clamp(1 - d / 0.45, 0, 1) * 0.4;
      if (a > 0.02 && on) {
        // the lane itself only shows while the finger is in it (a whisper of fill + a dashed edge)
        const c = this.laneQuad;
        shakeLanePoint(idx, A, this.up, L.down0, L.out0, c[0]);
        shakeLanePoint(idx, A, this.up, L.down0, L.out1, c[1]);
        shakeLanePoint(idx, A, this.up, L.down1, L.out1, c[2]);
        shakeLanePoint(idx, A, this.up, L.down1, L.out0, c[3]);
        ctx.beginPath();
        let ok = true;
        for (let k = 0; k < 4 && ok; k++) {
          ok = H.map(c[k].x, c[k].y, p);
          if (!ok) break;
          if (k === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
          this.grow(p.x, p.y, 4);
        }
        if (ok) {
          ctx.closePath();
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(154,212,222,0.07)';
          ctx.fill();
          ctx.setLineDash(DASH_RING);
          ctx.globalAlpha = 0.42;
          ctx.strokeStyle = PALETTE.glacier;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash(DASH_NONE);
        }
      }
      // the shake glyph (a short live wave) marks the lane's middle and fades in as the finger nears it
      if (a > 0.02 && H.map(this.s1.x, this.s1.y, p)) {
        const gx = p.x;
        const gy = p.y;
        ctx.beginPath();
        for (let k = 0; k <= 16; k++) {
          const u = k / 16;
          const x = gx - 9 + u * 18;
          const y = gy + Math.sin(u * Math.PI * 3 + (this.reduced ? 0 : this.time * 10)) * 2.6;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = a * 0.7;
        ctx.strokeStyle = C_SHADOW;
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.globalAlpha = a;
        ctx.strokeStyle = PALETTE.glacier;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        this.grow(gx, gy, 14);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A tiny chalk-bucket glyph (soft bucket, rim, drawstring) centred at (x, y). */
  private drawBagGlyph(x: number, y: number, a: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    // body
    ctx.moveTo(x - 5.5, y - 3.5);
    ctx.lineTo(x - 4.6, y + 4);
    ctx.quadraticCurveTo(x, y + 6.6, x + 4.6, y + 4);
    ctx.lineTo(x + 5.5, y - 3.5);
    // rim
    ctx.moveTo(x - 6.4, y - 4.2);
    ctx.lineTo(x + 6.4, y - 4.2);
    ctx.lineJoin = 'round';
    ctx.globalAlpha = a * 0.7;
    ctx.strokeStyle = C_SHADOW;
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.globalAlpha = a;
    ctx.strokeStyle = PALETTE.chalk;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // a puff of chalk over the rim
    ctx.beginPath();
    ctx.arc(x - 1.6, y - 7.2, 1.3, 0, Math.PI * 2);
    ctx.arc(x + 1.9, y - 8.2, 1, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.chalk;
    ctx.fill();
  }

  private drawHipDrag(state: ClimberState): void {
    const ctx = this.ctx;
    const hip = this.handles[HIP];
    const sx = hip.x;
    const sy = hip.y;
    const tp = this.renderer.wallToScreen(this.target, state.pelvisDepth);
    const tx = tp.x + this.offX;
    const ty = tp.y + this.offY;
    let dx = tx - sx;
    let dy = ty - sy;
    const d = Math.hypot(dx, dy);
    // target puck
    ctx.setLineDash(DASH_NONE);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(tx, ty, 9, 0, Math.PI * 2);
    ctx.strokeStyle = PALETTE.glacier;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.glacier;
    ctx.fill();
    this.grow(tx, ty, 12);
    if (d < HIP_R + 16) return;
    dx /= d;
    dy /= d;
    const x0 = sx + dx * (HIP_R + 4);
    const y0 = sy + dy * (HIP_R + 4);
    const x1 = tx - dx * 13;
    const y1 = ty - dy * 13;
    // soft arrow: wide translucent body + crisp core + head
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = 'rgba(154,212,222,0.22)';
    ctx.lineWidth = 9;
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.strokeStyle = PALETTE.glacier;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    const hx = x1 + dx * 2;
    const hy = y1 + dy * 2;
    ctx.beginPath();
    ctx.moveTo(hx + dx * 3, hy + dy * 3);
    ctx.lineTo(hx - dx * 7 - dy * 6, hy - dy * 7 + dx * 6);
    ctx.lineTo(hx - dx * 7 + dy * 6, hy - dy * 7 - dx * 6);
    ctx.closePath();
    ctx.fillStyle = PALETTE.glacier;
    ctx.fill();
    this.grow(x0, y0, 8);
    this.grow(x1, y1, 12);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

/** Approximate visual radius (m) of a hold, matching the renderer's highlight ring. */
function holdRadius(h: HoldDef): number {
  return h.type === 'volume' ? h.size * 0.85 + 0.03 : h.size * 1.12 + 0.035;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Rope mode: the next unclipped quickdraw if a free hand could reach it (envelope when known). */
function nextReachableDraw(sim: ClimberSimAPI, state: ClimberState, L: LimbSnapshot, env: Vec2[] | null): QuickdrawDef | null {
  const draws = sim.boulder.quickdraws;
  if (!draws) return null;
  for (const q of draws) {
    if (state.clipped.includes(q.id)) continue;
    const cy = q.y - SIM.quickdrawDrop;
    // the envelope already carries the snap tolerance; the clip radius reaches a little further
    if (env) return polyOutside(env, q.x, cy) <= GAME.clipRadius - SIM.reachTolerance ? q : null;
    const d = Math.hypot(q.x - L.anchor.x, cy - L.anchor.y);
    return d <= sim.maxReach(L.id) + GAME.clipRadius ? q : null;
  }
  return null;
}

/** Distance (wall m) of (x, y) outside a closed polygon; 0 inside. */
function polyOutside(poly: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const ll = ex * ex + ey * ey;
    let t = ll > 1e-18 ? ((x - a.x) * ex + (y - a.y) * ey) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a.x + ex * t), y - (a.y + ey * t));
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

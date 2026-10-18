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

import type { CameraMode, ClimberSimAPI, HoldHighlight, LimbControlsAPI, RendererAPI } from '../core/contracts';
import type { ClimberState, HoldDef, HoldType, LimbId, LimbSnapshot, QuickdrawDef, Vec2 } from '../core/types';
import { bus } from '../core/events';
import { PALETTE } from '../config/brand';
import { BODY, GAME, SIM } from '../config/tuning';
import { clamp, damp } from '../core/math';
import { Homography } from './homography';
import { HandleLayout, type SafeRect } from './layout';
import { FOOT_GLYPH, HAND_GLYPH, HIP_GLYPH } from './glyphs';
import { ensureLimbControlStyles } from './styles';

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
const FLAG_CLASSES: readonly (readonly [number, string])[] = [
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
    root.appendChild(this.candTag.el);
    root.appendChild(this.clipTag.el);

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
    for (const h of holds) {
      if (h.role === 'deco') continue;
      this.holdWX[k] = h.x;
      this.holdWY[k] = h.y;
      this.holdWR[k] = holdRadius(h);
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
    if (this.dragIdx !== NONE) return; // one drag at a time: extra fingers are ignored
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    if (h.placed && Math.hypot(h.x - x, h.y - y) <= HIT_R) {
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
    bus.emit('input:hip-start');
    this.setCursor('grabbing');
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
    if (this.dragIdx === NONE || e.pointerId !== this.pointerId || !this.sim) return;
    const x = e.clientX - this.rootLeft;
    const y = e.clientY - this.rootTop;
    this.fingerX = x;
    this.fingerY = y;
    if (!this.applyFingerDelta(x, y)) return;
    if (this.dragIdx === HIP) {
      this.sim.setHipTarget(this.target);
    } else {
      this.sim.dragTo(IDS[this.dragIdx], this.target);
      this.evalCandidate(false);
      this.renderer.setCameraFocusHint(this.target);
    }
  };

  /**
   * Move the wall target by the finger's motion since the last event, measured with the current
   * camera on both ends (so camera pans never move the limb, only the finger does).
   */
  private applyFingerDelta(x: number, y: number): boolean {
    const px = this.prevX;
    const py = this.prevY;
    if (Math.abs(x - px) < 0.01 && Math.abs(y - py) < 0.01) return false;
    this.prevX = x;
    this.prevY = y;
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
    this.target.x += dx;
    this.target.y += dy;
    return true;
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragIdx === NONE || e.pointerId !== this.pointerId) return;
    this.finishDrag();
  };

  private readonly onLostCapture = (e: PointerEvent): void => {
    if (this.dragIdx === NONE || e.pointerId !== this.pointerId) return;
    this.finishDrag();
  };

  /** End the active drag: drop the limb (grab / smear / clip / return) or release the hips. */
  private finishDrag(): void {
    const idx = this.dragIdx;
    if (idx === NONE) return;
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
        const events = sim.endDrag(limb);
        for (const ev of events) bus.emit('sim:event', ev);
      }
      bus.emit('input:drag-end', { limb });
      this.renderer.setCameraFocusHint(null);
      this.cand = null;
      this.clip = null;
      this.clearOwnHighlights();
    }
    this.setTag(this.candTag, false);
    this.setTag(this.clipTag, false);
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
      const c = this.cand;
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
      const c = this.cand;
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
    if (idx < 0 || idx > 3 || !this.assist || !this.homo.valid) {
      this.setTag(this.candTag, false);
      this.setTag(this.clipTag, false);
      return;
    }
    const sim = this.sim as ClimberSimAPI;
    const h = this.handles[idx];
    const c = this.cand;
    let tagOn = false;
    if (c && this.homo.map(c.x, c.y, this.s0)) {
      const other = state.limbs[IDS[idx ^ 1]];
      const type = c.role === 'top' && idx < 2 ? 'TOP' : other.holdId === c.id && !other.dragging ? 'MATCH' : TYPE_WORD[c.type];
      this.setTagText(this.candTag, qualityWord(this.quality), type, qualityColor(this.quality));
      const rpx = holdRadius(c) * this.homo.scaleAt(c.x, c.y, this.s2, this.s3);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, rpx, h.x, h.y);
      tagOn = true;
    } else if (idx >= 2 && sim.boulder.wallAngle <= SIM.smearMaxAngle && !this.outOfReach && this.homo.map(this.target.x, this.target.y, this.s0)) {
      this.setTagText(this.candTag, 'SMEAR', '', PALETTE.glacier);
      this.placeTag(this.candTag, this.s0.x, this.s0.y, 16, h.x, h.y);
      tagOn = true;
    }
    this.setTag(this.candTag, tagOn && !this.clip);

    const q = this.clip;
    if (q && this.homo.map(q.x, q.y - SIM.quickdrawDrop, this.s1)) {
      this.setTagText(this.clipTag, 'CLIP', state.clipped.length === 0 ? 'FIRST' : '', PALETTE.basalt);
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
    if (drag >= 0 && drag < 4 && this.homo.valid) this.drawLimbDrag(state, drag);
    this.drawLeaders(state);
    if (drag === HIP && this.homo.valid) this.drawHipDrag(state);
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
    const colour = c ? qualityColor(this.quality) : out ? PALETTE.fog : this.clip ? PALETTE.signal : PALETTE.chalk;
    const RR = 11;

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

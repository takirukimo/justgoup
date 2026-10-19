// BoulderEditor — the EDITOR module's implementation of EditorAPI.
//
// A touch-first problem setter on the CHIRAL wall: tap to set holds (snapped to the T-nut grid or
// free), tap to select, drag to move, twist/pinch or the gizmo knob to rotate/resize, pinch +
// two-finger pan to navigate, double-tap to reset the view. Live rule checks, a debounced beta
// search + grade estimate (in a worker), undo/redo, autosave, TEST → PUBLISH gating per revision.
//
// Cross-module traffic: renderer (RendererAPI), ui (UIAPI) and the typed bus only.

import './editor.css';

import type { BetaMove, EditorAPI, RendererAPI, UIAPI } from '../core/contracts';
import { bus } from '../core/events';
import type { BoulderDef, HoldDef, RouteStyle, Vec2 } from '../core/types';
import { clamp, lerp } from '../core/math';
import { gradeLabel } from '../game/grades';
import { Analyzer, type SolveResult } from './analyzer';
import { EditorOverlay, type OverlayGhost, type OverlayState, type Projector } from './overlay';
import { EditorPanel, SAMPLE_STYLES, type Drawer, type EditorPanelState, type PanelActions, type StatusKind } from './panel';
import { loadPhotoImport, type OpenPhotoImport } from './photo';
import { EditorView, type ZoomAnchor } from './view';
import type { WallCardState } from './wallcard';
import { exactVolumeShape } from './shapes';
import {
  depthRange,
  derivedDepth,
  derivedLip,
  entryById,
  entryOf,
  isVolumeEntry,
  lipRange,
  seedForVariant,
  shapeForFinish,
  sizeRange,
  type CatalogEntry,
  type Finish,
} from './catalog';
import {
  mainPanel,
  matchPreset,
  mergePanel,
  moveFold,
  presetById,
  presetsOf,
  presetWall,
  setPanelAngle,
  setWall,
  splitPanel,
  tooLow,
  wallHeightOf,
  wallOf,
  wallTypeOf,
  wallWords,
  WALL_TYPE_LABEL,
  type WallPreset,
  type WallState,
} from './walls';
import {
  clampToBounds,
  clearanceAt,
  draftFromSample,
  cleanName,
  cloneDraft,
  createDraft,
  draftHash,
  EDIT_ROLES,
  EDITOR,
  findSpot,
  fits,
  footprint,
  History,
  holdBounds,
  inBounds,
  loadStoredDraft,
  makeHold,
  mountsOf,
  normalizeDraft,
  pruneStartFeet,
  removeHold,
  ROLE_LABEL,
  saveStoredDraft,
  setVolumeShapes,
  transformVolume,
  validateDraft,
  insideDistance,
  volumeAt,
  volumeShape,
  type DraftCheck,
  type EditRole,
  type Proto,
} from './model';

interface Ptr {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
  /** Event timestamps (input time, not handler time: long frames must not break double-taps). */
  t0: number;
  t1: number;
  mouse: boolean;
}

type Gesture =
  | { kind: 'idle' }
  | { kind: 'pending'; id: number; holdId: string | null }
  | { kind: 'drag'; id: number; holdId: string; offset: Vec2; changed: boolean }
  | { kind: 'pan'; id: number; lastX: number; lastY: number }
  | { kind: 'knob'; id: number; holdId: string; changed: boolean }
  | { kind: 'pinch'; a: number; b: number; d0: number; m0: number; anchor: ZoomAnchor }
  | { kind: 'twist'; a: number; b: number; holdId: string; d0: number; a0: number; size0: number; angle0: number; changed: boolean }
  | { kind: 'settle' };

interface Analysis {
  hash: string;
  state: 'idle' | 'solving' | 'done';
  moves: BetaMove[] | null;
  grade: number | null;
}

const SOLVE_DEBOUNCE_MS = 420;
/** Wall-clock cap for the beta search; the solver's node budget bounds the real work (worker thread). */
const SOLVE_BUDGET_MS = 1200;
const TAP_SLOP_TOUCH = 9;
const TAP_SLOP_MOUSE = 4;
const DOUBLE_TAP_MS = 320;
const PREFS_KEY = 'jgu.editor.prefs';
const INTRO_KEY = 'jgu.editor.intro';

const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return Math.round(r * 1000) / 1000;
};
/** Snap a hold angle to 15° steps measured from the classic orientation (body below). */
const snapAngle = (a: number): number => {
  const step = EDITOR.rotateStep;
  return wrapAngle(-Math.PI / 2 + Math.round((a + Math.PI / 2) / step) * step);
};
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Identity of a draft's wall: panels + surface length (undo / redo rebuild the wall when it changes). */
function profileKey(b: BoulderDef): string {
  return `${b.profile ? b.profile.map((p) => `${p.y0}:${p.angle}`).join(',') : ''}|${b.height}`;
}

interface Prefs {
  snap: boolean;
  sampleGrade: number;
  /** Kind of bouldering a sample is set as (null: the generator's pick). */
  sampleStyle: RouteStyle | null;
}

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as { snap?: unknown; sampleGrade?: unknown; sampleStyle?: unknown } | null;
    return {
      snap: typeof v?.snap === 'boolean' ? v.snap : true,
      sampleGrade: typeof v?.sampleGrade === 'number' && Number.isFinite(v.sampleGrade) ? clamp(Math.round(v.sampleGrade), 0, 10) : 3,
      sampleStyle: SAMPLE_STYLES.find((s) => s.style === v?.sampleStyle)?.style ?? null,
    };
  } catch {
    return { snap: true, sampleGrade: 3, sampleStyle: null };
  }
}

function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: preferences are a convenience only */
  }
}

export class BoulderEditor implements EditorAPI {
  /** Optional: author stamped on published problems (the app may also fill it from the profile). */
  author = '';
  /** Optional: a photo importer to use instead of src/photo's (harnesses, tests). */
  photoImporter: OpenPhotoImport | null = null;

  private opened = false;
  private draft: BoulderDef = createDraft();
  private history = new History();
  private check: DraftCheck = validateDraft(this.draft);
  private hash = draftHash(this.draft);
  private version = 0;
  /** draftHash of the revision sent in a test climb / last published / last submitted to TEST. */
  private passed: string | null = null;
  private published: string | null = null;
  private tested: string | null = null;
  private pendingResult: boolean | null = null;
  private loaded = false;

  /** What a tap on the wall sets: a catalogue entry (hold or volume) in a role. */
  private tool: { entry: string; role: EditRole; lastHandEntry: string } = { entry: 'jug', role: 'start', lastHandEntry: 'jug' };
  /** The first hold bolted onto a volume explains itself once. */
  private mountTold = false;
  private snap = true;
  private selectedId: string | null = null;
  private drawer: Drawer | null = null;
  private checkOpen = false;
  private betaOn = false;
  private sampleGrade = 3;
  private sampleStyle: RouteStyle | null = null;
  /** The photo importer owns the screen. */
  private importing = false;
  private generating = false;

  private analyzer = new Analyzer();
  private analysis: Analysis = { hash: '', state: 'idle', moves: null, grade: null };
  private solveCache = new Map<string, SolveResult>();
  private solveTimer = 0;
  private saveTimer = 0;
  /** First-visit tip (Steini over the top bar) is up; it hides itself after a read. */
  private introOn = false;
  private introTimer = 0;

  private panel: EditorPanel | null = null;
  private overlay: EditorOverlay | null = null;
  private view = new EditorView();
  private resizeObs: ResizeObserver | null = null;
  private holdsDirty = false;
  private wallDirty = false;
  private holdsCooldown = 0;
  private wallCooldown = 0;
  private overlayDirty = true;
  private sig = { ax: -1e9, ay: -1e9, bx: -1e9, by: -1e9 };
  private ppmCache = 80;
  private frameDt = 0;
  private overlayQueued = false;
  /** Reused every frame (no per-frame allocation). */
  private readonly ovState: OverlayState = {
    boulder: this.draft,
    version: 0,
    selectedId: null,
    flagged: new Set<string>(),
    beta: null,
    ghost: null,
    boundsActive: false,
    dragging: false,
  };

  private ptrs = new Map<number, Ptr>();
  private gesture: Gesture = { kind: 'idle' };
  private lastTap: { t: number; x: number; y: number; placedId: string | null; version: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private ghost: OverlayGhost | null = null;
  private canvasRect = { left: 0, top: 0, width: 390, height: 844 };
  /** Continuous edits (size slider, panel angle, fold drag) hold one checkpoint until they end. */
  private continuous: 'size' | 'angle' | 'fold' | null = null;
  /** Wall panel the WALL drawer edits. */
  private wallSel = 0;
  /** View before an automatic pan that revealed the selection (restored on deselect if untouched). */
  private autoPan: { before: { center: Vec2; meters: number }; after: Vec2 } | null = null;
  private continuousStart = '';

  /** Panel intents (built once). */
  private readonly act: PanelActions = this.actions();

  private readonly projector: Projector = {
    toScreen: (p, depth) => this.renderer.wallToScreen(p, depth),
    ppm: () => this.ppmCache,
    depth: (h) => this.liftOf(h),
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly renderer: RendererAPI,
    private readonly ui: UIAPI,
  ) {
    const prefs = readPrefs();
    this.snap = prefs.snap;
    this.sampleGrade = prefs.sampleGrade;
    this.sampleStyle = prefs.sampleStyle;
    // zoom anchors are picked through the renderer's ray cast (works across a folded wall's panels)
    this.view.setPicker((x, y) => this.renderer.screenToWall(x, y));
    // holds bolt onto volumes exactly where the renderer seats them (its own volume geometry)
    setVolumeShapes(exactVolumeShape);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Optional: a copy of the working draft. */
  getDraft(): BoulderDef {
    return cloneDraft(this.draft);
  }

  // ═══════════════════════════════ lifecycle ═══════════════════════════════

  open(initial?: BoulderDef): void {
    this.adoptDraft(initial);
    if (this.opened) {
      this.afterDraftSwap();
      return;
    }
    this.opened = true;
    if (this.ui.current !== 'editor') this.ui.show('editor', {});

    const panel = new EditorPanel(this.act);
    const overlay = new EditorOverlay();
    panel.mountOverlay(overlay.el);
    this.panel = panel;
    this.overlay = overlay;
    this.root.appendChild(panel.el);
    this.bindSurface(panel.surface);
    window.addEventListener('keydown', this.onKey);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.layoutView(false));
      this.resizeObs.observe(this.root);
    }

    this.renderer.setClimberVisible(false);
    this.renderer.loadBoulder(cloneDraft(this.draft));
    this.renderer.setCameraMode('editor');
    this.selectedId = null;
    this.drawer = null;
    this.checkOpen = false;
    this.holdsDirty = false;
    this.wallDirty = false;
    this.sig.ax = this.sig.ay = this.sig.bx = this.sig.by = -1e9;
    this.overlayDirty = true;
    this.applyHighlights();
    this.layoutView(true);
    requestAnimationFrame(() => this.layoutView(this.view.isFit));

    this.refreshDerived();
    this.scheduleAnalysis(0);
    this.render();
    this.showPendingResult();
    this.maybeIntro();
  }

  close(): void {
    if (!this.opened) return;
    this.teardown();
    bus.emit('editor:close');
  }

  reportTestResult(sent: boolean): void {
    if (sent && this.tested) this.passed = this.tested;
    this.pendingResult = sent;
    this.saveNow();
    if (this.opened) {
      this.render();
      this.showPendingResult();
    }
  }

  frame(dt: number): void {
    if (!this.opened || !this.overlay) return;
    const d = clamp(dt, 0, 0.1);
    this.wallCooldown -= d;
    this.holdsCooldown -= d;
    if (this.wallDirty && this.wallCooldown <= 0) {
      this.renderer.loadBoulder(this.renderCopy());
      this.wallDirty = false;
      this.holdsDirty = false;
      this.wallCooldown = 0.14;
      this.applyHighlights();
      this.overlayDirty = true;
    } else if (this.holdsDirty && this.holdsCooldown <= 0) {
      this.renderer.updateHolds(this.draft.holds.map((h) => ({ ...h })));
      this.holdsDirty = false;
      this.holdsCooldown = this.gesture.kind === 'idle' ? 0 : 1 / 30;
      this.overlayDirty = true;
    }

    // Overlay after the renderer has moved the camera this frame: a microtask runs once the app's
    // animation-frame callback returns, so the order of editor.frame / renderer.frame doesn't matter.
    this.frameDt += d;
    if (!this.overlayQueued) {
      this.overlayQueued = true;
      queueMicrotask(this.flushOverlay);
    }
  }

  private readonly flushOverlay = (): void => {
    this.overlayQueued = false;
    const d = this.frameDt;
    this.frameDt = 0;
    if (!this.opened || !this.overlay) return;
    // re-project only when the camera moved, the draft changed or something animates
    const a = this.renderer.wallToScreen({ x: 0, y: 0 });
    const b = this.renderer.wallToScreen({ x: 1, y: 1 });
    const s = this.sig;
    const moved = Math.abs(a.x - s.ax) > 0.05 || Math.abs(a.y - s.ay) > 0.05 || Math.abs(b.x - s.bx) > 0.05 || Math.abs(b.y - s.by) > 0.05;
    if (moved) {
      s.ax = a.x;
      s.ay = a.y;
      s.bx = b.x;
      s.by = b.y;
      this.ppmCache = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) / Math.SQRT2);
    }
    if (moved || this.overlayDirty || this.overlay.animating || this.selectedId) {
      const st = this.ovState;
      st.boulder = this.draft;
      st.version = this.version;
      st.selectedId = this.selectedId;
      st.flagged = this.check.flagged;
      st.beta = this.betaOn && this.analysis.hash === this.hash ? this.analysis.moves : null;
      st.ghost = this.ghost;
      st.boundsActive = this.gesture.kind === 'drag' || this.gesture.kind === 'knob' || !!this.hover;
      st.dragging = this.gesture.kind === 'drag';
      this.overlay.setSize(this.canvasRect.width, this.canvasRect.height);
      this.overlay.update(st, d, this.projector);
      this.overlayDirty = false;
    }
  };

  private teardown(): void {
    this.dismissIntro();
    this.saveNow();
    clearTimeout(this.solveTimer);
    clearTimeout(this.saveTimer);
    window.removeEventListener('keydown', this.onKey);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.overlay?.dispose();
    this.panel?.el.remove();
    this.panel = null;
    this.overlay = null;
    this.ptrs.clear();
    this.gesture = { kind: 'idle' };
    this.ghost = null;
    this.hover = null;
    this.continuous = null;
    this.renderer.setHoldHighlights([]);
    this.renderer.setClimberVisible(true);
    this.opened = false;
  }

  /** Pick the working draft: an explicit one, the in-memory one, the saved one, or a fresh wall. */
  private adoptDraft(initial?: BoulderDef): void {
    const stored = this.loaded ? null : loadStoredDraft();
    if (initial) {
      const d = normalizeDraft(initial);
      if (this.loaded && d.id === this.draft.id) {
        // same problem back from a test climb: keep history + meta, take the incoming content
        if (draftHash(d) !== this.hash) {
          this.history.checkpoint(this.draft);
          this.draft = d;
        } else this.draft.name = d.name;
      } else {
        this.draft = d;
        this.history.clear();
        const meta = stored && stored.draft.id === d.id ? stored : null;
        this.passed = meta?.passed ?? null;
        this.published = meta?.published ?? null;
        this.tested = null;
      }
    } else if (!this.loaded) {
      if (stored) {
        this.draft = stored.draft;
        this.passed = stored.passed;
        this.published = stored.published;
      } else {
        this.draft = createDraft();
        this.passed = this.published = null;
      }
      this.history.clear();
    }
    this.loaded = true;
    this.wallSel = mainPanel(wallOf(this.draft));
    this.refreshDerived();
    const starts = this.check.counts.start;
    this.tool.role = starts === 0 ? 'start' : this.check.counts.top === 0 && starts > 0 && this.check.counts.hands >= 3 ? 'top' : 'hand';
    if (this.toolEntry().type === 'foot') this.tool.role = 'foot';
  }

  /** open() while already open with a different draft. */
  private afterDraftSwap(): void {
    this.selectedId = null;
    this.wallDirty = true;
    this.wallCooldown = 0;
    this.commit({ wall: true });
    this.showPendingResult();
  }

  // ═══════════════════════════════ derived state ═══════════════════════════════

  private refreshDerived(): void {
    const sf = pruneStartFeet(this.draft.startFeet, this.draft.holds);
    if (sf) this.draft.startFeet = sf;
    else delete this.draft.startFeet;
    this.hash = draftHash(this.draft);
    this.check = validateDraft(this.draft);
    if (this.selectedId && !this.draft.holds.some((h) => h.id === this.selectedId)) this.selectedId = null;
  }

  private statusKind(): StatusKind {
    if (!this.draft.holds.length) return 'empty';
    if (!this.check.ok) return 'invalid';
    if (this.published === this.hash) return 'live';
    if (this.passed === this.hash) return 'sent';
    if (this.analysis.hash !== this.hash || this.analysis.state !== 'done') return 'solving';
    return this.analysis.moves ? 'ok' : 'nobeta';
  }

  private currentGrade(): number | null {
    if (this.analysis.hash === this.hash && this.analysis.grade !== null) return this.analysis.grade;
    if (this.passed === this.hash || this.published === this.hash) return this.draft.grade;
    return null;
  }

  private selected(): HoldDef | null {
    return this.selectedId ? this.draft.holds.find((h) => h.id === this.selectedId) ?? null : null;
  }

  private panelState(): EditorPanelState {
    const sel = this.selected();
    const status = this.statusKind();
    return {
      name: this.draft.name,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      status,
      grade: this.currentGrade(),
      check: this.check,
      checkOpen: this.checkOpen,
      betaAvailable: this.analysis.hash === this.hash && !!this.analysis.moves,
      betaOn: this.betaOn,
      canTest: this.check.ok && !this.generating,
      canPublish: this.check.ok && this.passed === this.hash && this.published !== this.hash,
      published: this.published === this.hash,
      entry: this.tool.entry,
      role: this.tool.role,
      color: this.draft.color,
      angle: this.draft.wallAngle,
      wall: this.wallState(),
      snap: this.snap,
      drawer: this.drawer,
      sampleGrade: this.sampleGrade,
      sampleStyle: this.sampleStyle,
      generating: this.generating,
      selection: sel ? this.selectionInfo(sel) : null,
    };
  }

  private selectionInfo(sel: HoldDef): NonNullable<EditorPanelState['selection']> {
    const vol = sel.onVolume ? this.draft.holds.find((v) => v.id === sel.onVolume) : undefined;
    return {
      hold: sel,
      index: this.draft.holds.indexOf(sel) + 1,
      volumeName: vol ? entryOf(vol).name : undefined,
      mounts: sel.type === 'volume' ? mountsOf(this.draft, sel.id).length : undefined,
    };
  }

  private render(): void {
    this.panel?.render(this.panelState());
    this.overlayDirty = true;
  }

  // ═══════════════════════════════ mutations ═══════════════════════════════

  /** After every edit: derived state, renderer sync, analysis, autosave, UI. */
  private commit(o: { wall?: boolean } = {}): void {
    this.version++;
    this.refreshDerived();
    if (o.wall) {
      this.wallDirty = true;
      // the surface length may have changed: refit a fitted view
      this.layoutView(false);
    } else this.holdsDirty = true;
    this.scheduleAnalysis(SOLVE_DEBOUNCE_MS);
    this.scheduleSave();
    this.applyHighlights();
    this.render();
  }

  private toolEntry(): CatalogEntry {
    return entryById(this.tool.entry) ?? entryById('jug')!;
  }

  /** A fresh hold of the tool's product (a volume's geometry is fixed by its entry). */
  private toolProto(): Proto & { seed: number } {
    const e = this.toolEntry();
    return {
      type: e.type,
      size: sizeRange(e).def,
      shape: e.shape,
      fingers: e.fingers,
      seed: e.type === 'volume' ? seedForVariant(e.variant) : 1 + Math.floor(Math.random() * 0x7ffffffe),
      angle: -Math.PI / 2,
    };
  }

  /**
   * The wall point under a canvas pixel, seen through any volume in front of the wall: the renderer picks
   * the wall behind; on a volume the point is corrected for the face's height (parallax), so a hold
   * bolted onto a face lands under the finger. `vol` is the volume whose face is under the finger.
   */
  private pickFace(sx: number, sy: number): { p: Vec2; vol: HoldDef | null; lift: number } | null {
    const w = this.renderer.screenToWall(sx, sy);
    if (!w) return null;
    let best: { p: Vec2; vol: HoldDef | null; lift: number } = { p: w, vol: null, lift: 0 };
    const ppm = Math.max(1, this.ppmCache);
    for (const v of this.draft.holds) {
      if (v.type !== 'volume') continue;
      if (Math.hypot(v.x - w.x, v.y - w.y) > footprint(v) + 0.5) continue;
      const shape = volumeShape(v);
      let p = { x: w.x, y: w.y };
      let lift = 0;
      for (let k = 0; k < 4; k++) {
        lift = shape.lift(p);
        const sp = this.renderer.wallToScreen(p, lift);
        p = { x: p.x + (sx - sp.x) / ppm, y: p.y - (sy - sp.y) / ppm };
      }
      lift = shape.lift(p);
      if (lift > 0.002 && lift > best.lift) best = { p, vol: v, lift };
    }
    return best;
  }

  /** Height above the wall a hold's tags and rings are drawn at (a bolted-on hold sits on its volume). */
  private liftOf(h: HoldDef): number {
    if (!h.onVolume) return 0;
    const v = this.draft.holds.find((o) => o.id === h.onVolume);
    return v ? volumeShape(v).lift(h) : 0;
  }

  private placeAt(sx: number, sy: number, face?: { p: Vec2; vol: HoldDef | null } | null): string | null {
    const f = face ?? this.pickFace(sx, sy);
    if (!f) {
      this.toast('Tap on the wall to set a hold');
      return null;
    }
    if (this.draft.holds.length >= EDITOR.maxHolds) {
      this.toast(`Hold limit reached · ${EDITOR.maxHolds}`, 'bad');
      return null;
    }
    const e = this.toolEntry();
    let role: EditRole = e.type === 'foot' ? 'foot' : this.tool.role;
    // volumes are features for the feet (and hands, when HAND is picked), never a start or the top
    if (e.type === 'volume') role = role === 'hand' ? 'hand' : 'foot';
    else if (role === 'start' && this.check.counts.start >= EDITOR.maxStarts) {
      role = 'hand';
      this.tool.role = 'hand';
      this.toast('Two start holds max · set as hand');
    }
    const proto = this.toolProto();
    const onFace = !!f.vol && e.type !== 'volume';
    const spot = findSpot(this.draft, f.p, proto, { snap: this.snap && !onFace, searchRadius: onFace ? 0.1 : this.snap ? 0.16 : 0.14 });
    if (!spot) {
      this.overlay?.ripple(f.p, footprint(proto), true);
      this.toast(onFace ? 'No room on this face · try another spot' : 'No room here · too close to another hold', 'bad');
      return null;
    }
    this.history.checkpoint(this.draft);
    if (role === 'top') this.demoteTops(null);
    const h = makeHold(e.type, role, spot, this.draft.color, proto.size, { shape: e.shape, fingers: e.fingers, seed: proto.seed, onVolume: spot.onVolume });
    this.draft.holds.push(h);
    // smart role advance: after the starts and the top come the hands
    if (e.type !== 'volume') {
      if (role === 'start' && this.check.counts.start + 1 >= EDITOR.maxStarts) this.tool.role = 'hand';
      if (role === 'top') this.tool.role = 'hand';
    }
    this.overlay?.ripple(spot, footprint(h));
    bus.emit('ui:tap');
    this.commit();
    if (spot.onVolume && !this.mountTold) {
      this.mountTold = true;
      this.toast('Bolted onto the volume · it moves with it');
    }
    return h.id;
  }

  /** Every other TOP becomes a HAND (one top per problem). Returns how many moved. */
  private demoteTops(keepId: string | null): number {
    let n = 0;
    for (const h of this.draft.holds) {
      if (h.role === 'top' && h.id !== keepId) {
        h.role = 'hand';
        n++;
      }
    }
    if (n) this.toast('Top moved · old top is now a hand hold');
    return n;
  }

  private select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    if (id) this.closeDrawer();
    this.applyHighlights();
    this.render();
    if (id) this.ensureVisible(id);
    else this.restoreAutoPan();
  }

  /** Pan so the selected hold is not hidden under the inspector card (undone on deselect). */
  private ensureVisible(id: string): void {
    const h = this.draft.holds.find((x) => x.id === id);
    const p = this.panel;
    if (!h || !p) return;
    const sp = this.renderer.wallToScreen(h);
    const limit = p.inspectorTop() - this.canvasRect.top - 34 - footprint(h) * this.ppmCache - 30;
    if (sp.y <= limit) return;
    const before = { center: { ...this.view.center }, meters: this.view.meters };
    this.view.panPx(0, -(sp.y - limit));
    this.autoPan = { before, after: { ...this.view.center } };
    this.pushView();
  }

  private restoreAutoPan(): void {
    const a = this.autoPan;
    this.autoPan = null;
    if (!a) return;
    if (Math.abs(this.view.center.x - a.after.x) > 1e-3 || Math.abs(this.view.center.y - a.after.y) > 1e-3 || this.view.meters !== a.before.meters) return;
    this.view.center = { ...a.before.center };
    this.pushView();
  }

  private applyHighlights(): void {
    if (!this.opened) return;
    this.renderer.setHoldHighlights(this.selectedId ? [{ holdId: this.selectedId, kind: 'selected' }] : []);
  }

  private setRoleOf(h: HoldDef, role: EditRole): boolean {
    if (h.role === role) return false;
    if (h.type === 'foot' && role !== 'foot') {
      this.toast('Foot chips are for feet only');
      return false;
    }
    if (role === 'start') {
      const others = this.draft.holds.filter((o) => o.role === 'start' && o.id !== h.id).length;
      if (others >= EDITOR.maxStarts) {
        this.toast('Two start holds max');
        return false;
      }
    }
    this.history.checkpoint(this.draft);
    if (role === 'top') this.demoteTops(h.id);
    h.role = role;
    this.commit();
    return true;
  }

  private cycleRole(h: HoldDef): void {
    if (h.type === 'foot') {
      this.toast('Foot chip · feet only');
      return;
    }
    const cur = h.role === 'deco' ? 'hand' : h.role;
    const starts = this.draft.holds.filter((o) => o.role === 'start' && o.id !== h.id).length;
    let i = EDIT_ROLES.indexOf(cur);
    for (let k = 0; k < EDIT_ROLES.length; k++) {
      i = (i + 1) % EDIT_ROLES.length;
      const r = EDIT_ROLES[i];
      if (r === 'start' && starts >= EDITOR.maxStarts) continue;
      if (this.setRoleOf(h, r)) this.toast(`Role · ${ROLE_LABEL[r]}`);
      return;
    }
  }

  /** Turn a hold into another catalogue product (a volume into another volume shape, a jug into a horn…). */
  private setEntryOf(h: HoldDef, e: CatalogEntry): void {
    const cur = entryOf(h);
    if (cur.id === e.id) return;
    if (h.onVolume && e.type === 'volume') {
      this.toast('Volumes go on the wall · pick a hold to bolt on', 'bad');
      return;
    }
    if (h.type === 'volume' && e.type !== 'volume' && mountsOf(this.draft, h.id).length) {
      this.toast('Take the holds off this volume first', 'bad');
      return;
    }
    const from = sizeRange(h);
    const to = sizeRange(e);
    const t = clamp((h.size - from.min) / (from.max - from.min), 0, 1);
    const seed = e.type === 'volume' ? seedForVariant(e.variant) : h.seed;
    const next: Proto = { id: h.id, type: e.type, shape: e.shape, fingers: e.fingers, seed, angle: h.angle, onVolume: h.onVolume, size: r3(lerp(to.min, to.max, t)) };
    let pos: Vec2 = { x: h.x, y: h.y };
    let onVolume = h.onVolume;
    if (!fits(this.draft, pos, next, h.id)) {
      const spot = findSpot(this.draft, pos, next, { snap: this.snap && !h.onVolume, ignoreId: h.id, searchRadius: 0.25 });
      if (!spot) {
        // keep the spot, shrink until it fits
        let sz = next.size;
        while (sz > to.min && !fits(this.draft, pos, { ...next, size: sz }, h.id)) sz = r3(sz - 0.004);
        if (!fits(this.draft, pos, { ...next, size: sz }, h.id)) {
          this.toast(`No room for a ${e.name.toLowerCase()} here`, 'bad');
          return;
        }
        next.size = sz;
      } else {
        pos = spot;
        onVolume = spot.onVolume;
      }
    }
    this.history.checkpoint(this.draft);
    if (h.type === 'volume' && e.type === 'volume') transformVolume(this.draft, h.id, { x: pos.x, y: pos.y, size: next.size });
    else {
      h.x = pos.x;
      h.y = pos.y;
      h.size = next.size;
    }
    h.type = e.type;
    h.seed = seed;
    if (e.shape) h.shape = e.shape;
    else delete h.shape;
    if (e.type === 'pocket') h.fingers = e.fingers ?? h.fingers ?? 3;
    else delete h.fingers;
    if (!depthRange(h)) delete h.edgeDepthMm;
    if (!lipRange(h)) delete h.lipAngle;
    if (onVolume) h.onVolume = onVolume;
    else delete h.onVolume;
    if (e.type === 'foot') h.role = 'foot';
    this.commit();
  }

  private deleteSelected(): void {
    const h = this.selected();
    if (!h) return;
    this.history.checkpoint(this.draft);
    const gone = removeHold(this.draft, h.id);
    this.overlay?.ripple(h, footprint(h), true);
    this.selectedId = null;
    bus.emit('ui:tap');
    this.commit();
    if (gone.length > 1) this.toast(`Volume removed with its ${gone.length - 1} hold${gone.length === 2 ? '' : 's'} · undo to restore`);
  }

  /** Turn the selected hold (a volume turns with its holds). */
  private turnTo(h: HoldDef, angle: number): void {
    if (h.type === 'volume') transformVolume(this.draft, h.id, { angle });
    else h.angle = angle;
  }

  private rotateSelected(dir: -1 | 1): void {
    const h = this.selected();
    if (!h) return;
    this.history.checkpoint(this.draft);
    this.turnTo(h, this.snap ? snapAngle(h.angle + dir * EDITOR.rotateStep) : wrapAngle(h.angle + dir * EDITOR.rotateStep));
    this.commit();
  }

  private reshapeSelected(): void {
    const h = this.selected();
    // a volume's shape is its catalogue entry (the VOLUMES palette)
    if (!h || h.type === 'volume') return;
    this.history.checkpoint(this.draft);
    const v0 = Math.abs(h.seed) % 6;
    let sd = h.seed;
    for (let k = 0; k < 12 && Math.abs(sd) % 6 === v0; k++) sd = 1 + Math.floor(Math.random() * 0x7ffffffe);
    h.seed = sd;
    this.commit();
  }

  /** Product details (inspector steppers): edge depth (mm), lip angle (°), pocket fingers, finish. */
  private setDetail(kind: 'depth' | 'lip', delta: number): void {
    const h = this.selected();
    if (!h) return;
    if (kind === 'depth') {
      const r = depthRange(h);
      if (!r) return;
      const cur = h.edgeDepthMm ?? Math.round(derivedDepth(h) ?? r.min);
      const next = clamp(Math.round(cur + delta), r.min, r.max);
      if (next === h.edgeDepthMm) return;
      this.history.checkpoint(this.draft);
      h.edgeDepthMm = next;
    } else {
      const r = lipRange(h);
      if (!r) return;
      const cur = h.lipAngle ?? derivedLip(h);
      const next = clamp(Math.round(cur + delta), r.min, r.max);
      if (next === h.lipAngle) return;
      this.history.checkpoint(this.draft);
      h.lipAngle = next;
    }
    this.commit();
  }

  private setFingers(n: 1 | 2 | 3 | 4): void {
    const h = this.selected();
    if (!h || h.type !== 'pocket' || (h.fingers ?? 3) === n) return;
    this.history.checkpoint(this.draft);
    h.fingers = n;
    this.commit();
  }

  private setFinish(f: Finish): void {
    const h = this.selected();
    if (!h) return;
    const shape = shapeForFinish(h, f);
    if ((h.shape ?? undefined) === shape) return;
    this.history.checkpoint(this.draft);
    if (shape) h.shape = shape;
    else delete h.shape;
    this.commit();
  }

  /** Largest size (≤ want) that keeps the hold on the wall (or its volume) and clear of its neighbours. */
  private fitSize(h: HoldDef, want: number): number {
    const range = sizeRange(h);
    const skip = new Set<string>([h.id, ...(h.type === 'volume' ? mountsOf(this.draft, h.id).map((m) => m.id) : [])]);
    const ok = (sz: number): boolean => {
      const q = { ...h, size: sz };
      if (h.onVolume) return fits(this.draft, h, q, h.id);
      return inBounds(h, holdBounds(this.draft, q), 6e-4) && clearanceAt(this.draft.holds, h, q, skip) >= EDITOR.clearance;
    };
    const s = clamp(want, range.min, range.max);
    if (ok(s)) return r3(s);
    let lo = Math.min(range.min, h.size);
    let hi = s;
    if (!ok(lo)) return r3(Math.min(h.size, s));
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return Math.floor(lo * 1000) / 1000;
  }

  private undo(): void {
    const before = { a: this.draft.wallAngle, c: this.draft.color, p: profileKey(this.draft) };
    if (!this.history.undo(this.draft)) return;
    this.afterHistory(before);
    this.toast('Undo');
  }

  private redo(): void {
    const before = { a: this.draft.wallAngle, c: this.draft.color, p: profileKey(this.draft) };
    if (!this.history.redo(this.draft)) return;
    this.afterHistory(before);
    this.toast('Redo');
  }

  private afterHistory(before: { a: number; c: string; p: string }): void {
    const wall = before.a !== this.draft.wallAngle || before.c !== this.draft.color || before.p !== profileKey(this.draft);
    this.commit({ wall });
  }

  // ═══════════════════════════════ actions (panel intents) ═══════════════════════════════

  private actions(): PanelActions {
    return {
      close: () => this.close(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      rename: (name) => {
        this.draft.name = name;
        this.scheduleSave();
      },
      renameCommit: () => {
        this.draft.name = cleanName(this.draft.name) || 'Untitled problem';
        this.scheduleSave();
        this.render();
      },
      test: () => this.test(),
      publish: () => void this.publish(),
      toggleCheck: () => {
        this.checkOpen = !this.checkOpen;
        if (this.checkOpen) this.closeDrawer();
        this.render();
      },
      toggleBeta: () => {
        this.betaOn = !this.betaOn;
        if (this.betaOn) this.toast('Beta: numbered moves from Steini’s reader');
        this.render();
      },
      pickEntry: (id) => {
        const e = entryById(id);
        if (!e) return;
        const sel = this.selected();
        if (sel) {
          this.setEntryOf(sel, e);
          return;
        }
        if (e.type === 'foot') this.tool.role = 'foot';
        else {
          if (this.toolEntry().type === 'foot' && this.tool.role === 'foot') this.tool.role = this.check.counts.start === 0 ? 'start' : 'hand';
          this.tool.lastHandEntry = e.id;
        }
        this.tool.entry = e.id;
        if (isVolumeEntry(e) && e.type === 'volume') this.toastOnce('vol', 'Tap the wall to set it · then bolt holds onto its faces');
        this.render();
      },
      setDepth: (d) => this.setDetail('depth', d),
      setLip: (d) => this.setDetail('lip', d),
      setFingers: (n) => this.setFingers(n),
      setFinish: (f) => this.setFinish(f),
      pickRole: (r) => {
        const sel = this.selected();
        if (sel) {
          this.setRoleOf(sel, r);
          return;
        }
        this.tool.role = r;
        if (r !== 'foot' && this.toolEntry().type === 'foot') this.tool.entry = entryById(this.tool.lastHandEntry)?.type === 'foot' ? 'jug' : this.tool.lastHandEntry;
        this.render();
      },
      pickColor: (hex) => {
        if (hex.toLowerCase() === this.draft.color.toLowerCase()) return;
        this.history.checkpoint(this.draft);
        this.draft.color = hex;
        for (const h of this.draft.holds) h.color = hex;
        this.wallCooldown = Math.max(this.wallCooldown, 0.12);
        this.commit({ wall: true });
      },
      pickWallType: (t) => {
        // a type's chip applies its first preset; the variants row picks within the type
        if (wallTypeOf(wallOf(this.draft)) === t) return;
        this.applyPreset(presetsOf(t)[0]);
      },
      pickPreset: (id) => {
        const p = presetById(id);
        if (p) this.applyPreset(p);
      },
      selectPanel: (i) => {
        this.wallSel = clamp(i, 0, wallOf(this.draft).panels.length - 1);
        this.render();
      },
      panelAngleInput: (deg) => {
        if (this.continuous !== 'angle') this.beginContinuous('angle');
        // the side view follows live; the 3D wall rebuilds when the slider is let go
        this.editWall(setPanelAngle(wallOf(this.draft), this.wallSel, deg), false);
      },
      panelAngleCommit: () => {
        if (this.continuous === 'angle') this.endContinuous(true);
      },
      panelAngleStep: (delta) => {
        const w = wallOf(this.draft);
        const i = clamp(this.wallSel, 0, w.panels.length - 1);
        const a = w.panels[i].angle;
        const next = delta > 0 ? Math.floor(a / 5) * 5 + 5 : Math.ceil(a / 5) * 5 - 5;
        this.history.checkpoint(this.draft);
        const before = draftHash(this.draft);
        this.editWall(setPanelAngle(w, i, next), true, before);
      },
      foldInput: (i, y0) => {
        if (this.continuous !== 'fold') this.beginContinuous('fold');
        this.editWall(moveFold(wallOf(this.draft), i, y0), false);
      },
      foldCommit: () => {
        if (this.continuous === 'fold') this.endContinuous(true);
      },
      splitPanel: () => {
        const r = splitPanel(wallOf(this.draft), this.wallSel);
        if (!r) {
          this.toast('This panel is too short to fold', 'bad');
          return;
        }
        if (tooLow(r.wall)) {
          this.toast('Too low to climb · a wall stands at least 2 m tall', 'bad');
          return;
        }
        this.history.checkpoint(this.draft);
        this.wallSel = r.index;
        this.editWall(r.wall, true);
        this.toast('New fold · drag it, set the panel’s angle');
      },
      mergePanel: () => {
        const r = mergePanel(wallOf(this.draft), this.wallSel);
        if (!r) return;
        this.history.checkpoint(this.draft);
        this.wallSel = r.index;
        this.editWall(r.wall, true);
        if (r.clamped) this.toast('One panel goes from −15° to 45°');
      },
      toggleSnap: () => {
        this.snap = !this.snap;
        this.savePrefs();
        this.toast(this.snap ? 'Snap to T-nuts · 0.1 m grid' : 'Free placement');
        this.render();
      },
      setDrawer: (d) => {
        const wasWall = this.drawer === 'wall';
        if (d === 'wall' && !wasWall) this.wallSel = clamp(this.wallSel, 0, wallOf(this.draft).panels.length - 1);
        this.drawer = d;
        if ((d === 'wall') !== wasWall) this.wallFraming(d === 'wall');
        if (d) this.checkOpen = false;
        this.render();
      },
      newDraft: () => void this.newDraft(),
      sampleGrade: (delta) => {
        this.sampleGrade = clamp(this.sampleGrade + delta, 0, 10);
        this.savePrefs();
        this.render();
      },
      loadSample: () => void this.loadSample(),
      setSampleStyle: (st) => {
        this.sampleStyle = st;
        this.savePrefs();
        this.render();
      },
      importPhoto: () => void this.importPhoto(),
      clearAll: () => void this.clearAll(),
      sizeStart: () => {
        if (this.selected() && this.continuous !== 'size') this.beginContinuous('size');
      },
      sizeInput: (t) => {
        const h = this.selected();
        if (!h) return;
        if (this.continuous !== 'size') this.beginContinuous('size');
        const range = sizeRange(h);
        const size = this.fitSize(h, lerp(range.min, range.max, t));
        // a volume grows with the holds on it (they keep their place on its faces)
        if (h.type === 'volume') transformVolume(this.draft, h.id, { size });
        else h.size = size;
        this.holdsDirty = true;
        this.overlayDirty = true;
        this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1, this.selectionInfo(h));
      },
      sizeCommit: () => this.endContinuous(false),
      rotate: (dir) => this.rotateSelected(dir),
      reshape: () => this.reshapeSelected(),
      deleteSelected: () => this.deleteSelected(),
      deselect: () => this.select(null),
    };
  }

  // ═══════════════════════════════ wall ═══════════════════════════════

  private wallState(): WallCardState {
    const w = wallOf(this.draft);
    const selected = clamp(this.wallSel, 0, w.panels.length - 1);
    const holds = this.draft.holds.map((h) => ({ y: h.y, role: h.role }));
    const cut = this.draft.holds.filter((h) => h.y > w.length + 0.005).length;
    return { wall: w, selected, type: wallTypeOf(w), preset: matchPreset(w)?.id ?? null, words: wallWords(w), height: wallHeightOf(w), holds, cut };
  }

  /** A wall preset (research §3.2): panels, surface length, style. Holds keep their place on the surface. */
  private applyPreset(p: WallPreset): void {
    const before = draftHash(this.draft);
    this.history.checkpoint(this.draft);
    setWall(this.draft, presetWall(p));
    this.wallSel = mainPanel(wallOf(this.draft));
    if (draftHash(this.draft) === before) {
      this.history.discard();
      this.render();
      return;
    }
    this.wallCooldown = Math.max(this.wallCooldown, 0.05);
    this.commit({ wall: true });
    const cut = this.draft.holds.filter((h) => h.y > this.draft.height + 0.005).length;
    this.toast(cut ? `${cut} hold${cut === 1 ? '' : 's'} above the new wall · move ${cut === 1 ? 'it' : 'them'} down` : `${WALL_TYPE_LABEL[p.type]} wall · ${p.label}`, cut ? 'bad' : 'info');
  }

  /**
   * Write an edited wall onto the draft. `commitNow`: a discrete edit (stepper, fold button) rebuilds the
   * 3D wall after a short rest; otherwise only the side view follows until the gesture ends.
   */
  private editWall(w: WallState, commitNow: boolean, before?: string): void {
    if (tooLow(w) && !tooLow(wallOf(this.draft))) {
      // a roof 30 cm off the floor is no wall: the edit stops where the wall would stand under 2 m
      this.toastOnce('low', 'Too low to climb · a wall stands at least 2 m tall');
      if (before !== undefined) this.history.discard();
      this.render();
      return;
    }
    setWall(this.draft, w);
    this.wallSel = clamp(this.wallSel, 0, wallOf(this.draft).panels.length - 1);
    if (!commitNow) {
      this.render();
      return;
    }
    if (before !== undefined && draftHash(this.draft) === before) {
      this.history.discard();
      this.render();
      return;
    }
    this.wallCooldown = Math.max(this.wallCooldown, 0.25);
    this.commit({ wall: true });
  }

  private beginContinuous(kind: 'size' | 'angle' | 'fold'): void {
    if (this.continuous) this.endContinuous(this.continuous !== 'size');
    this.continuous = kind;
    this.continuousStart = draftHash(this.draft);
    this.history.checkpoint(this.draft);
  }

  private endContinuous(wall: boolean): void {
    if (!this.continuous) return;
    this.continuous = null;
    if (wall) this.wallCooldown = 0;
    if (draftHash(this.draft) === this.continuousStart) {
      this.history.discard();
      this.render();
      return;
    }
    this.commit({ wall });
  }

  private test(): void {
    if (!this.check.ok) {
      this.panel?.nudge('chip');
      this.checkOpen = true;
      this.toast(this.check.headline, 'bad');
      this.render();
      return;
    }
    this.panel?.blurName();
    this.tested = this.hash;
    const boulder = this.exportDraft();
    this.teardown();
    bus.emit('editor:test', { boulder });
  }

  private async publish(): Promise<void> {
    if (!this.check.ok) {
      this.panel?.nudge('chip');
      this.toast(this.check.headline, 'bad');
      return;
    }
    if (this.passed !== this.hash) {
      this.panel?.nudge('publish');
      this.toast('Send it in a test climb to unlock publish');
      return;
    }
    if (this.published === this.hash) return;
    const g = this.currentGrade() ?? this.draft.grade;
    const name = cleanName(this.draft.name) || 'Untitled problem';
    const ok = await this.ui.confirm(
      'Publish to community?',
      `“${name}” · ${gradeLabel(g)} goes live on the Community wall for every climber to try.`,
      'PUBLISH',
      'NOT YET',
    );
    if (!ok || !this.opened || this.passed !== this.hash) return;
    const boulder = this.exportDraft();
    boulder.createdAt = Date.now();
    this.published = this.hash;
    this.saveNow();
    bus.emit('editor:publish', { boulder });
    // the app reports where it landed (GLOBAL / CLAUDE SHARED / saved offline) in its own toast
    this.toast('Publishing to Community', 'good');
    this.render();
  }

  private async newDraft(): Promise<void> {
    if (this.draft.holds.length) {
      const ok = await this.ui.confirm('Start a new problem?', 'Strips every hold for a blank problem on this wall. Your current draft will be discarded.', 'DISCARD', 'CANCEL');
      if (!ok || !this.opened) return;
    }
    // a new problem on the same wall (type, panels, length)
    const wall = wallOf(this.draft);
    this.draft = createDraft({ wallAngle: this.draft.wallAngle });
    setWall(this.draft, wall);
    this.resetForNewDraft();
    this.toast(`New problem · ${this.draft.name}`);
  }

  private async loadSample(): Promise<void> {
    if (this.generating) return;
    const grade = this.sampleGrade;
    if (this.draft.holds.length) {
      const kind = this.sampleStyle ? `${SAMPLE_STYLES.find((x) => x.style === this.sampleStyle)?.label.toLowerCase() ?? ''} ` : '';
      const ok = await this.ui.confirm('Load a sample?', `Replaces the wall with a generated ${gradeLabel(grade)} ${kind}problem you can remix.`, 'REPLACE', 'CANCEL');
      if (!ok || !this.opened) return;
    }
    this.generating = true;
    this.render();
    const seed = 1 + Math.floor(Math.random() * 0x7ffffffe);
    try {
      const b = await this.analyzer.generate(seed, grade, this.sampleStyle ?? undefined);
      if (!this.opened) return;
      this.draft = normalizeDraft(b);
      this.draft.grade = grade;
      this.resetForNewDraft();
      this.toast(`${this.draft.name} · ${gradeLabel(grade)} · remix away`, 'good');
    } catch {
      this.toast('Could not set a sample · try again', 'bad');
    } finally {
      this.generating = false;
      this.render();
    }
  }

  private savePrefs(): void {
    writePrefs({ snap: this.snap, sampleGrade: this.sampleGrade, sampleStyle: this.sampleStyle });
  }

  /** Photo → route (src/photo): the importer takes the screen, its problem becomes the draft. */
  private async importPhoto(): Promise<void> {
    if (this.importing || this.generating) return;
    const open = this.photoImporter ?? (await loadPhotoImport());
    if (!this.opened) return;
    if (!open) {
      this.toast('Photo import isn’t in this build yet', 'bad');
      return;
    }
    if (this.draft.holds.length) {
      const ok = await this.ui.confirm('Import from a photo?', 'Your photo’s problem replaces this wall. The current draft will be discarded.', 'IMPORT', 'CANCEL');
      if (!ok || !this.opened) return;
    }
    this.importing = true;
    this.closeDrawer();
    this.render();
    this.saveNow();
    this.panel?.setAway(true);
    let b: BoulderDef | null = null;
    try {
      b = await open({ root: this.root, renderer: this.renderer, ui: this.ui });
    } catch {
      this.toast('Could not read that photo · try another one', 'bad');
    } finally {
      this.importing = false;
      this.panel?.setAway(false);
    }
    if (!this.opened) return;
    // the importer may have used the 3D view: the editor's wall and camera come back
    if (this.ui.current !== 'editor') this.ui.show('editor', {});
    this.renderer.setClimberVisible(false);
    this.renderer.setCameraMode('editor');
    if (!b || !Array.isArray(b.holds)) {
      this.wallDirty = true;
      this.wallCooldown = 0;
      this.pushView();
      this.render();
      return;
    }
    const grade = Number.isFinite(b.grade) ? b.grade : 0;
    this.draft = draftFromSample({ ...b, mode: 'boulder', grade });
    this.resetForNewDraft();
    this.layoutView(true);
    const n = this.draft.holds.length;
    this.toast(`${this.draft.name} · ${n} hold${n === 1 ? '' : 's'} from your photo · check start and top`, 'good');
  }

  private async clearAll(): Promise<void> {
    if (!this.draft.holds.length) {
      this.toast('The wall is already empty');
      return;
    }
    const ok = await this.ui.confirm('Clear every hold?', 'Strips the whole wall. You can undo this.', 'ERASE ALL', 'CANCEL');
    if (!ok || !this.opened) return;
    this.history.checkpoint(this.draft);
    this.draft.holds = [];
    delete this.draft.startFeet;
    this.selectedId = null;
    this.closeDrawer();
    this.tool.role = 'start';
    this.commit();
    this.toast('Wall cleared · undo to restore');
  }

  private resetForNewDraft(): void {
    this.history.clear();
    this.wallSel = mainPanel(wallOf(this.draft));
    this.passed = this.published = this.tested = null;
    this.selectedId = null;
    this.closeDrawer();
    this.checkOpen = false;
    this.betaOn = false;
    this.refreshDerived();
    this.tool.role = this.check.counts.start === 0 ? 'start' : 'hand';
    if (this.toolEntry().type === 'foot') this.tool.entry = 'jug';
    this.view.reset();
    this.pushView();
    this.commit({ wall: true });
  }

  /** The draft as a playable problem (deep copy). */
  private exportDraft(): BoulderDef {
    const b = cloneDraft(this.draft);
    b.name = cleanName(b.name) || 'Untitled problem';
    b.grade = clamp(Math.round(this.currentGrade() ?? b.grade), 0, 12);
    b.mode = 'boulder';
    b.author = this.author || b.author || '';
    delete b.quickdraws;
    return b;
  }

  private renderCopy(): BoulderDef {
    const b = cloneDraft(this.draft);
    const g = this.currentGrade();
    if (g !== null) b.grade = g;
    return b;
  }

  // ═══════════════════════════════ analysis ═══════════════════════════════

  private scheduleAnalysis(delay: number): void {
    clearTimeout(this.solveTimer);
    const hash = this.hash;
    if (!this.check.ok) {
      this.analysis = { hash, state: 'idle', moves: null, grade: null };
      return;
    }
    const cached = this.solveCache.get(hash);
    if (cached) {
      this.applySolve(hash, cached);
      return;
    }
    this.analysis = { hash, state: 'solving', moves: null, grade: null };
    const boulder = cloneDraft(this.draft);
    this.solveTimer = window.setTimeout(() => {
      this.analyzer
        .solve(boulder, SOLVE_BUDGET_MS)
        .then((r) => {
          this.solveCache.set(hash, r);
          if (this.solveCache.size > 48) this.solveCache.delete(this.solveCache.keys().next().value as string);
          this.applySolve(hash, r);
        })
        .catch(() => {
          if (hash === this.hash) {
            this.analysis = { hash, state: 'done', moves: null, grade: null };
            this.render();
          }
        });
    }, delay);
  }

  private applySolve(hash: string, r: SolveResult): void {
    if (hash !== this.hash) return;
    this.analysis = { hash, state: 'done', moves: r.moves, grade: r.grade };
    if (r.grade !== null && this.draft.grade !== r.grade) {
      this.draft.grade = r.grade;
      this.scheduleSave();
    }
    this.render();
  }

  // ═══════════════════════════════ persistence ═══════════════════════════════

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 300);
  }

  /** Write a pending autosave right now (the page is being hidden or closed). */
  flush(): void {
    if (this.saveTimer) this.saveNow();
  }

  private saveNow(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    saveStoredDraft({ v: 1, draft: cloneDraft(this.draft), passed: this.passed, published: this.published, savedAt: Date.now() });
  }

  // ═══════════════════════════════ view ═══════════════════════════════

  private layoutView(reset: boolean): void {
    const p = this.panel;
    if (!p || !this.opened) return;
    const cr = this.renderer.canvas.getBoundingClientRect();
    const w = cr.width || this.renderer.canvas.clientWidth || 390;
    const h = cr.height || this.renderer.canvas.clientHeight || 844;
    this.canvasRect = { left: cr.left, top: cr.top, width: w, height: h };
    const tb = p.top.getBoundingClientRect();
    // with the WALL drawer open the whole wall sits in the space above it (its 3D rebuilds show there)
    const tr = this.drawer === 'wall' ? p.wallCardRect() : p.tray.getBoundingClientRect();
    const top = Math.max(0, tb.bottom - cr.top + 10);
    const bottom = Math.min(h, (tr.top > 0 ? tr.top : h) - cr.top - 8);
    this.view.layout({ w, h, top, bottom: Math.max(top + 120, bottom) }, { width: this.draft.width, height: this.draft.height }, reset);
    this.pushView();
  }

  /** Close the open drawer (the WALL drawer gives the setter's view back). */
  private closeDrawer(): void {
    if (!this.drawer) return;
    const wasWall = this.drawer === 'wall';
    this.drawer = null;
    if (wasWall) this.wallFraming(false);
  }

  /** View before the WALL drawer framed the whole wall above itself (restored when it closes). */
  private preWallView: { center: Vec2; meters: number } | null = null;

  /** Frame the whole wall above the WALL drawer while it is open; give the setter's view back after. */
  private wallFraming(open: boolean): void {
    if (open) {
      this.preWallView = { center: { ...this.view.center }, meters: this.view.meters };
      // after the drawer (and the slimmer tray) are laid out
      requestAnimationFrame(() => {
        if (this.drawer === 'wall') this.layoutView(true);
      });
      return;
    }
    const v = this.preWallView;
    this.preWallView = null;
    requestAnimationFrame(() => {
      this.layoutView(!v);
      if (v && this.drawer !== 'wall') {
        this.view.zoomAbout({ x: v.center.x, y: v.center.y }, { x: this.canvasRect.width / 2, y: this.canvasRect.height / 2 }, v.meters);
        this.pushView();
      }
    });
  }

  private pushView(): void {
    this.renderer.setEditorView(this.view.center, this.view.meters);
    this.overlayDirty = true;
  }

  private resetView(): void {
    this.view.reset();
    this.pushView();
  }

  // ═══════════════════════════════ gestures ═══════════════════════════════

  private bindSurface(s: HTMLElement): void {
    s.addEventListener('pointerdown', this.onDown);
    s.addEventListener('pointermove', this.onMove);
    s.addEventListener('pointerup', this.onUp);
    s.addEventListener('pointercancel', this.onCancel);
    s.addEventListener('pointerleave', this.onLeave);
    s.addEventListener('wheel', this.onWheel, { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    return { x: e.clientX - this.canvasRect.left, y: e.clientY - this.canvasRect.top };
  }

  /** Hold under a canvas point (touch-friendly radius); prefers the selected hold. */
  private hitHold(x: number, y: number, mouse: boolean): HoldDef | null {
    const ppm = this.ppmCache;
    const slop = mouse ? 4 : 10;
    let best: HoldDef | null = null;
    let bs = Infinity;
    // on a volume's face, small holds don't get the generous finger margin: the volume is grabbable
    // right next to the holds bolted onto it
    const f = this.pickFace(x, y);
    const onFace = !!f?.vol;
    // holds first (one bolted onto a volume is drawn on its face), then the volume under the finger
    for (const h of this.draft.holds) {
      if (h.type === 'volume') continue;
      const sp = this.renderer.wallToScreen(h, this.liftOf(h));
      const r = onFace ? Math.max(footprint(h) * ppm, mouse ? 8 : 12) + slop * 0.5 : Math.max(footprint(h) * ppm, mouse ? 10 : 18) + slop;
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > r) continue;
      const score = d / r - (h.id === this.selectedId ? 0.35 : 0);
      if (score < bs) {
        bs = score;
        best = h;
      }
    }
    if (best) return best;
    if (f?.vol) return f.vol;
    // the rim of a volume (a finger's width past its outline)
    const w = f?.p ?? null;
    if (!w) return null;
    let bv: HoldDef | null = null;
    let bd = (slop + 6) / Math.max(1, ppm);
    for (const v of this.draft.holds) {
      if (v.type !== 'volume') continue;
      const d = -insideDistance(volumeShape(v).outline, w);
      if (d < bd) {
        bd = d;
        bv = v;
      }
    }
    return bv;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.opened) return;
    this.dismissIntro();
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const cr = this.renderer.canvas.getBoundingClientRect();
    this.canvasRect = { left: cr.left, top: cr.top, width: cr.width || this.canvasRect.width, height: cr.height || this.canvasRect.height };
    this.panel?.blurName();
    if (this.drawer || this.checkOpen) {
      // first touch on the wall just dismisses pop-ups
      this.closeDrawer();
      this.checkOpen = false;
      this.render();
      this.gesture = { kind: 'settle' };
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const p = this.local(e);
    const mouse = e.pointerType === 'mouse';
    this.ptrs.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, x0: p.x, y0: p.y, t0: e.timeStamp || performance.now(), t1: 0, mouse });
    this.hover = null;
    this.ghost = null;
    if (this.gesture.kind === 'settle') return;

    if (this.ptrs.size === 1) {
      if (mouse && e.button !== 0) {
        this.gesture = { kind: 'pan', id: e.pointerId, lastX: p.x, lastY: p.y };
        return;
      }
      const k = this.overlay?.knob;
      const sel = this.selected();
      if (sel && k && Math.hypot(p.x - k.x, p.y - k.y) <= k.r) {
        this.history.checkpoint(this.draft);
        this.gesture = { kind: 'knob', id: e.pointerId, holdId: sel.id, changed: false };
        return;
      }
      const hit = this.hitHold(p.x, p.y, mouse);
      this.gesture = { kind: 'pending', id: e.pointerId, holdId: hit ? hit.id : null };
      return;
    }
    if (this.ptrs.size === 2) this.beginTwoFinger();
  };

  private beginTwoFinger(): void {
    const [pa, pb] = [...this.ptrs.values()];
    const g = this.gesture;
    // finish a one-finger drag cleanly before transforming
    if (g.kind === 'drag') this.endDrag(g);
    if (g.kind === 'knob') this.endKnob(g);
    const sel = this.selected();
    const d0 = Math.max(1, Math.hypot(pb.x - pa.x, pb.y - pa.y));
    const near = (q: Ptr): boolean => {
      const s = this.overlay?.selection;
      return !!s && Math.hypot(q.x0 - s.x, q.y0 - s.y) <= s.r * 1.7 + 16;
    };
    if (sel && (near(pa) || near(pb) || (g.kind === 'drag' && g.holdId === sel.id) || (g.kind === 'pending' && g.holdId === sel.id))) {
      this.history.checkpoint(this.draft);
      this.gesture = { kind: 'twist', a: pa.id, b: pb.id, holdId: sel.id, d0, a0: Math.atan2(pb.y - pa.y, pb.x - pa.x), size0: sel.size, angle0: sel.angle, changed: false };
      return;
    }
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    this.gesture = { kind: 'pinch', a: pa.id, b: pb.id, d0, m0: this.view.meters, anchor: this.view.zoomAnchor(mid.x, mid.y) };
  }

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.opened) return;
    const p = this.local(e);
    const ptr = this.ptrs.get(e.pointerId);
    if (!ptr) {
      if (e.pointerType === 'mouse') this.updateHover(p.x, p.y);
      return;
    }
    ptr.x = p.x;
    ptr.y = p.y;
    const g = this.gesture;
    switch (g.kind) {
      case 'pending': {
        if (g.id !== e.pointerId) return;
        const slop = ptr.mouse ? TAP_SLOP_MOUSE : TAP_SLOP_TOUCH;
        if (Math.hypot(p.x - ptr.x0, p.y - ptr.y0) < slop) return;
        const h = g.holdId ? this.draft.holds.find((x) => x.id === g.holdId) : null;
        if (h) {
          // a volume is dragged by the wall behind it; a hold by the point under the finger (on a face)
          const w = (h.type === 'volume' ? this.renderer.screenToWall(ptr.x0, ptr.y0) : this.pickFace(ptr.x0, ptr.y0)?.p) ?? { x: h.x, y: h.y };
          this.history.checkpoint(this.draft);
          this.selectedId = h.id;
          this.closeDrawer();
          this.applyHighlights();
          this.gesture = { kind: 'drag', id: g.id, holdId: h.id, offset: { x: h.x - w.x, y: h.y - w.y }, changed: false };
          this.render();
          this.onMove(e);
        } else {
          this.gesture = { kind: 'pan', id: g.id, lastX: p.x, lastY: p.y };
        }
        return;
      }
      case 'drag': {
        if (g.id !== e.pointerId) return;
        const h = this.draft.holds.find((x) => x.id === g.holdId);
        const vol = h?.type === 'volume';
        const w = vol ? this.renderer.screenToWall(p.x, p.y) : this.pickFace(p.x, p.y)?.p;
        if (!h || !w) return;
        const raw = { x: w.x + g.offset.x, y: w.y + g.offset.y };
        // a hold dragged onto a volume's face bolts onto it (free on the face); off it, back to the T-nuts
        const spot = findSpot(this.draft, raw, h, { snap: this.snap, ignoreId: h.id, searchRadius: this.snap ? 0.16 : 0.1 });
        if (spot && (spot.x !== h.x || spot.y !== h.y || (spot.onVolume ?? '') !== (h.onVolume ?? ''))) {
          if (vol) transformVolume(this.draft, h.id, { x: spot.x, y: spot.y });
          else {
            h.x = spot.x;
            h.y = spot.y;
            if (spot.onVolume) h.onVolume = spot.onVolume;
            else delete h.onVolume;
          }
          g.changed = true;
          this.holdsDirty = true;
          this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1, this.selectionInfo(h));
        }
        const onFace = !!spot?.onVolume;
        const depth = onFace ? this.liftOf(h) : 0;
        const clamped = clampToBounds(raw, holdBounds(this.draft, { ...h, onVolume: undefined }));
        this.ghost = spot
          ? { p: spot, r: footprint(h), ok: true, raw: this.snap && !onFace ? clamped : null, showTnuts: this.snap && !onFace, ring: false, depth }
          : { p: clamped, r: footprint(h), ok: false, raw: null, showTnuts: this.snap, ring: true };
        this.overlayDirty = true;
        return;
      }
      case 'pan': {
        if (g.id !== e.pointerId) return;
        this.view.panPx(p.x - g.lastX, p.y - g.lastY);
        g.lastX = p.x;
        g.lastY = p.y;
        this.pushView();
        return;
      }
      case 'knob': {
        if (g.id !== e.pointerId) return;
        const h = this.draft.holds.find((x) => x.id === g.holdId);
        if (!h) return;
        // the knob marks the side the hold faces; `angle` points the other way (toward the body).
        // Measured in the wall plane (through the renderer's pick), so a panel seen at an angle
        // on a folded wall turns the hold the way the finger goes; on screen when off the wall.
        const w = this.renderer.screenToWall(p.x, p.y);
        const c = this.renderer.wallToScreen(h, this.liftOf(h));
        const raw = w && Math.hypot(w.x - h.x, w.y - h.y) > 0.01 ? Math.atan2(w.y - h.y, w.x - h.x) + Math.PI : Math.atan2(-(p.y - c.y), p.x - c.x) + Math.PI;
        const a = this.snap ? snapAngle(raw) : wrapAngle(raw);
        if (a !== h.angle) {
          this.turnTo(h, a);
          g.changed = true;
          this.holdsDirty = true;
          this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1, this.selectionInfo(h));
        }
        return;
      }
      case 'pinch': {
        const pa = this.ptrs.get(g.a);
        const pb = this.ptrs.get(g.b);
        if (!pa || !pb) return;
        const d = Math.max(1, Math.hypot(pb.x - pa.x, pb.y - pa.y));
        const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        this.view.zoomAbout(g.anchor, mid, g.m0 * (g.d0 / d));
        this.pushView();
        return;
      }
      case 'twist': {
        const pa = this.ptrs.get(g.a);
        const pb = this.ptrs.get(g.b);
        const h = this.draft.holds.find((x) => x.id === g.holdId);
        if (!pa || !pb || !h) return;
        const d = Math.max(1, Math.hypot(pb.x - pa.x, pb.y - pa.y));
        const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
        // screen y points down: a clockwise twist on screen is a negative wall rotation
        const rawA = g.angle0 - (ang - g.a0);
        const a = this.snap ? snapAngle(rawA) : wrapAngle(rawA);
        const size = this.fitSize(h, g.size0 * Math.pow(d / g.d0, 0.85));
        if (a !== h.angle || size !== h.size) {
          if (h.type === 'volume') transformVolume(this.draft, h.id, { angle: a, size });
          else {
            h.angle = a;
            h.size = size;
          }
          g.changed = true;
          this.holdsDirty = true;
          this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1, this.selectionInfo(h));
        }
        return;
      }
      default:
        return;
    }
  };

  private readonly onUp = (e: PointerEvent): void => this.release(e, false);
  private readonly onCancel = (e: PointerEvent): void => this.release(e, true);

  private readonly onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && !this.ptrs.has(e.pointerId)) {
      this.hover = null;
      this.ghost = null;
      this.overlayDirty = true;
    }
  };

  private release(e: PointerEvent, cancelled: boolean): void {
    const ptr = this.ptrs.get(e.pointerId);
    if (!ptr) return;
    ptr.t1 = e.timeStamp || performance.now();
    this.ptrs.delete(e.pointerId);
    const g = this.gesture;
    switch (g.kind) {
      case 'pending':
        if (g.id === e.pointerId && !cancelled) this.tap(ptr, g.holdId);
        this.gesture = { kind: 'idle' };
        break;
      case 'drag':
        if (g.id === e.pointerId) {
          this.endDrag(g);
          this.gesture = { kind: 'idle' };
        }
        break;
      case 'pan':
        if (g.id === e.pointerId) this.gesture = { kind: 'idle' };
        break;
      case 'knob':
        if (g.id === e.pointerId) {
          this.endKnob(g);
          this.gesture = { kind: 'idle' };
        }
        break;
      case 'pinch': {
        // keep panning with the finger that stays down
        const rest = [...this.ptrs.values()][0];
        this.gesture = rest ? { kind: 'pan', id: rest.id, lastX: rest.x, lastY: rest.y } : { kind: 'idle' };
        break;
      }
      case 'twist':
        if (g.changed) this.commit();
        else this.history.discard();
        this.gesture = this.ptrs.size ? { kind: 'settle' } : { kind: 'idle' };
        break;
      case 'settle':
        if (!this.ptrs.size) this.gesture = { kind: 'idle' };
        break;
      default:
        break;
    }
    if (!this.ptrs.size && this.gesture.kind !== 'idle') this.gesture = { kind: 'idle' };
    this.ghost = null;
    this.overlayDirty = true;
    if (e.pointerType === 'mouse' && !cancelled) this.updateHover(ptr.x, ptr.y);
  }

  private endDrag(g: Extract<Gesture, { kind: 'drag' }>): void {
    this.ghost = null;
    if (g.changed) {
      bus.emit('ui:tap');
      this.commit();
    } else {
      this.history.discard();
      this.render();
    }
  }

  private endKnob(g: Extract<Gesture, { kind: 'knob' }>): void {
    if (g.changed) this.commit();
    else this.history.discard();
  }

  private tap(ptr: Ptr, holdId: string | null): void {
    const now = ptr.t1;
    const lt = this.lastTap;
    // double-tap on empty wall → reset the view (and take back the hold the first tap set)
    if (!holdId || (lt && lt.placedId === holdId)) {
      if (lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(ptr.x - lt.x, ptr.y - lt.y) < 34) {
        if (lt.placedId && lt.version === this.version && this.history.canUndo) {
          this.history.undo(this.draft);
          this.history.discardRedo();
          this.commit();
        }
        this.lastTap = null;
        this.resetView();
        return;
      }
    }
    if (holdId) {
      const h = this.draft.holds.find((x) => x.id === holdId);
      this.lastTap = null;
      if (!h) return;
      // a hold tool on a volume's face bolts a hold onto it (a volume tool selects the volume)
      if (h.type === 'volume' && this.toolEntry().type !== 'volume' && (!this.selectedId || this.selectedId === h.id)) {
        const f = this.pickFace(ptr.x, ptr.y);
        const placed = f && f.vol?.id === h.id ? this.placeAt(ptr.x, ptr.y, f) : null;
        if (placed) {
          this.lastTap = { t: now, x: ptr.x, y: ptr.y, placedId: placed, version: this.version };
          return;
        }
        if (this.selectedId !== h.id) this.select(h.id);
        return;
      }
      if (this.selectedId === h.id) this.cycleRole(h);
      else this.select(h.id);
      return;
    }
    if (this.selectedId) {
      this.select(null);
      this.lastTap = { t: now, x: ptr.x, y: ptr.y, placedId: null, version: this.version };
      return;
    }
    const placed = this.placeAt(ptr.x, ptr.y);
    this.lastTap = { t: now, x: ptr.x, y: ptr.y, placedId: placed, version: this.version };
  }

  private updateHover(x: number, y: number): void {
    if (this.selectedId || this.drawer || this.gesture.kind !== 'idle') {
      if (this.ghost) {
        this.ghost = null;
        this.overlayDirty = true;
      }
      return;
    }
    const hit = this.hitHold(x, y, true);
    const e = this.toolEntry();
    // a hold tool over a volume previews the spot on its face
    const f = hit && !(hit.type === 'volume' && e.type !== 'volume') ? null : this.pickFace(x, y);
    if (!f) {
      this.hover = null;
      if (this.ghost) this.overlayDirty = true;
      this.ghost = null;
      return;
    }
    this.hover = { x, y };
    const proto = this.toolProto();
    proto.seed = e.type === 'volume' ? seedForVariant(e.variant, () => 0.5) : proto.seed;
    const onFace = !!f.vol && e.type !== 'volume';
    const spot = findSpot(this.draft, f.p, proto, { snap: this.snap && !onFace, searchRadius: onFace ? 0.1 : this.snap ? 0.16 : 0.14 });
    const p = spot ?? f.p;
    const depth = spot?.onVolume ? volumeShape(this.draft.holds.find((v) => v.id === spot.onVolume)!).lift(p) : 0;
    this.ghost = { p, r: footprint(proto), ok: !!spot, raw: this.snap && !onFace ? f.p : null, showTnuts: this.snap && !onFace, ring: true, depth };
    this.overlayDirty = true;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.opened) return;
    e.preventDefault();
    const p = this.local(e);
    const anchor = this.view.zoomAnchor(p.x, p.y);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.view.zoomAbout(anchor, p, this.view.meters * Math.exp(clamp(dy, -200, 200) * 0.0016));
    this.pushView();
  };

  // ═══════════════════════════════ keyboard ═══════════════════════════════

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.opened || !this.panel || this.importing) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type === 'text') return;
    if (this.root.querySelector('.modal')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod) return;
    const sel = this.selected();
    switch (e.key) {
      case 'Escape':
        // also the Android back button (src/app/lifecycle.ts): peel one layer per press
        if (this.checkOpen || this.drawer) {
          this.checkOpen = false;
          this.closeDrawer();
          this.render();
        } else if (sel) this.select(null);
        else this.close(); // the draft is saved on the way out
        return;
      case 'Delete':
      case 'Backspace':
        if (sel) {
          e.preventDefault();
          this.deleteSelected();
        }
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!sel) return;
        e.preventDefault();
        const step = this.snap ? EDITOR.tnutStep / 2 : e.shiftKey ? 0.05 : 0.01;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
        const spot = findSpot(this.draft, { x: sel.x + dx * (this.snap ? 2 : 1), y: sel.y + dy * (this.snap ? 2 : 1) }, sel, { snap: this.snap, ignoreId: sel.id, searchRadius: 0.12 });
        if (!spot || (spot.x === sel.x && spot.y === sel.y)) return;
        this.history.checkpoint(this.draft);
        sel.x = spot.x;
        sel.y = spot.y;
        this.commit();
        return;
      }
      case 'q':
      case 'Q':
        this.rotateSelected(1);
        return;
      case 'e':
      case 'E':
        this.rotateSelected(-1);
        return;
      case '0':
        this.resetView();
        return;
      default:
        break;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 8) {
      const keys = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot', 'v-pyramid'];
      this.act.pickEntry(keys[n - 1]);
    }
  };

  // ═══════════════════════════════ feedback ═══════════════════════════════

  private toast(text: string, tone: 'info' | 'good' | 'bad' = 'info'): void {
    this.panel?.toast(text, tone);
  }

  private told = new Set<string>();
  /** A tip shown once per session. */
  private toastOnce(key: string, text: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.toast(text);
  }

  private showPendingResult(): void {
    if (this.pendingResult === null || !this.panel) return;
    const sent = this.pendingResult;
    this.pendingResult = null;
    if (sent && this.passed === this.hash) {
      this.toast('Sent! Publish unlocked', 'good');
      this.panel.pulsePublish();
    } else if (sent) {
      this.toast('Sent an older version · test this one');
    } else {
      this.toast('Not sent yet · try again or tweak it');
    }
  }

  private maybeIntro(): void {
    let seen = false;
    try {
      seen = localStorage.getItem(INTRO_KEY) === '1';
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      seen = true;
    }
    if (seen) return;
    const text = 'Your wall, your rules. Tap to set holds, pick START, HAND, FOOT or TOP below. Send it yourself, then publish it for everyone.';
    void this.ui.guide.say({ text, mood: 'point', waitForTap: true, position: 'top' });
    // the tip sits over the top bar (close, TEST, PUBLISH): it leaves on the first touch of the wall,
    // or by itself once it has been readable (≈220 ms a word, plus a beat)
    this.introOn = true;
    clearTimeout(this.introTimer);
    this.introTimer = window.setTimeout(() => this.dismissIntro(), Math.max(6000, text.split(/\s+/).length * 220 + 3000));
  }

  private dismissIntro(): void {
    clearTimeout(this.introTimer);
    if (!this.introOn) return;
    this.introOn = false;
    this.ui.guide.hide();
  }
}


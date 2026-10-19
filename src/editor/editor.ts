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
import type { BoulderDef, HoldDef, HoldType, Vec2 } from '../core/types';
import { clamp, lerp } from '../core/math';
import { gradeLabel } from '../game/grades';
import { Analyzer, type SolveResult } from './analyzer';
import { EditorOverlay, type OverlayGhost, type OverlayState, type Projector } from './overlay';
import { EditorPanel, type Drawer, type EditorPanelState, type PanelActions, type StatusKind } from './panel';
import { EditorView, type ZoomAnchor } from './view';
import {
  clampToBounds,
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
  loadStoredDraft,
  makeHold,
  normalizeDraft,
  pruneStartFeet,
  ROLE_LABEL,
  saveStoredDraft,
  SIZE_RANGE,
  TYPE_LABEL,
  validateDraft,
  type DraftCheck,
  type EditRole,
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

/** Identity of a draft's wall panels (undo / redo rebuild the wall when it changes). */
function profileKey(b: BoulderDef): string {
  return b.profile ? b.profile.map((p) => `${p.y0}:${p.angle}`).join(',') : '';
}

function readPrefs(): { snap: boolean; sampleGrade: number } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as { snap?: unknown; sampleGrade?: unknown } | null;
    return {
      snap: typeof v?.snap === 'boolean' ? v.snap : true,
      sampleGrade: typeof v?.sampleGrade === 'number' && Number.isFinite(v.sampleGrade) ? clamp(Math.round(v.sampleGrade), 0, 10) : 3,
    };
  } catch {
    return { snap: true, sampleGrade: 3 };
  }
}

function writePrefs(p: { snap: boolean; sampleGrade: number }): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: preferences are a convenience only */
  }
}

export class BoulderEditor implements EditorAPI {
  /** Optional: author stamped on published problems (the app may also fill it from the profile). */
  author = '';

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

  private tool: { type: HoldType; role: EditRole; lastHandType: HoldType } = { type: 'jug', role: 'start', lastHandType: 'jug' };
  private snap = true;
  private selectedId: string | null = null;
  private drawer: Drawer | null = null;
  private checkOpen = false;
  private betaOn = false;
  private sampleGrade = 3;
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
  /** Continuous edits (slider, angle) hold one checkpoint until they end. */
  private continuous: 'size' | 'angle' | null = null;
  /** View before an automatic pan that revealed the selection (restored on deselect if untouched). */
  private autoPan: { before: { center: Vec2; meters: number }; after: Vec2 } | null = null;
  private continuousStart = '';

  /** Panel intents (built once). */
  private readonly act: PanelActions = this.actions();

  private readonly projector: Projector = {
    toScreen: (p, depth) => this.renderer.wallToScreen(p, depth),
    ppm: () => this.ppmCache,
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly renderer: RendererAPI,
    private readonly ui: UIAPI,
  ) {
    const prefs = readPrefs();
    this.snap = prefs.snap;
    this.sampleGrade = prefs.sampleGrade;
    // zoom anchors are picked through the renderer's ray cast (works across a folded wall's panels)
    this.view.setPicker((x, y) => this.renderer.screenToWall(x, y));
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
    this.refreshDerived();
    const starts = this.check.counts.start;
    this.tool.role = starts === 0 ? 'start' : this.check.counts.top === 0 && starts > 0 && this.check.counts.hands >= 3 ? 'top' : 'hand';
    if (this.tool.type === 'foot') this.tool.role = 'foot';
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
      type: this.tool.type,
      role: this.tool.role,
      color: this.draft.color,
      angle: this.draft.wallAngle,
      profile: this.draft.profile,
      snap: this.snap,
      drawer: this.drawer,
      sampleGrade: this.sampleGrade,
      generating: this.generating,
      selection: sel ? { hold: sel, index: this.draft.holds.indexOf(sel) + 1 } : null,
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
    if (o.wall) this.wallDirty = true;
    else this.holdsDirty = true;
    this.scheduleAnalysis(SOLVE_DEBOUNCE_MS);
    this.scheduleSave();
    this.applyHighlights();
    this.render();
  }

  private placeAt(sx: number, sy: number): string | null {
    const w = this.renderer.screenToWall(sx, sy);
    if (!w) {
      this.toast('Tap on the wall to set a hold');
      return null;
    }
    if (this.draft.holds.length >= EDITOR.maxHolds) {
      this.toast(`Hold limit reached · ${EDITOR.maxHolds}`, 'bad');
      return null;
    }
    const type = this.tool.type;
    let role: EditRole = type === 'foot' ? 'foot' : this.tool.role;
    if (role === 'start' && this.check.counts.start >= EDITOR.maxStarts) {
      role = 'hand';
      this.tool.role = 'hand';
      this.toast('Two start holds max · set as hand');
    }
    const proto = { type, size: SIZE_RANGE[type].def };
    const spot = findSpot(this.draft, w, proto, { snap: this.snap, searchRadius: this.snap ? 0.16 : 0.14 });
    if (!spot) {
      this.overlay?.ripple(w, footprint(proto), true);
      this.toast('No room here · too close to another hold', 'bad');
      return null;
    }
    this.history.checkpoint(this.draft);
    if (role === 'top') this.demoteTops(null);
    const h = makeHold(type, role, spot, this.draft.color);
    this.draft.holds.push(h);
    // smart role advance: after the starts and the top come the hands
    if (role === 'start' && this.check.counts.start + 1 >= EDITOR.maxStarts) this.tool.role = 'hand';
    if (role === 'top') this.tool.role = 'hand';
    this.overlay?.ripple(spot, footprint(h));
    bus.emit('ui:tap');
    this.commit();
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
    if (id) this.drawer = null;
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

  private setTypeOf(h: HoldDef, type: HoldType): void {
    if (h.type === type) return;
    const from = SIZE_RANGE[h.type];
    const to = SIZE_RANGE[type];
    const t = clamp((h.size - from.min) / (from.max - from.min), 0, 1);
    const next = { type, size: r3(lerp(to.min, to.max, t)) };
    let pos: Vec2 = { x: h.x, y: h.y };
    if (!fits(this.draft, pos, next, h.id)) {
      const spot = findSpot(this.draft, pos, next, { snap: this.snap, ignoreId: h.id, searchRadius: 0.25 });
      if (!spot) {
        // keep the spot, shrink until it fits
        let s = next.size;
        while (s > to.min && !fits(this.draft, pos, { type, size: s }, h.id)) s = r3(s - 0.004);
        if (!fits(this.draft, pos, { type, size: s }, h.id)) {
          this.toast(`No room for a ${TYPE_LABEL[type].toLowerCase()} here`, 'bad');
          return;
        }
        next.size = s;
      } else pos = spot;
    }
    this.history.checkpoint(this.draft);
    h.type = type;
    h.size = next.size;
    h.x = pos.x;
    h.y = pos.y;
    if (type === 'foot') h.role = 'foot';
    this.commit();
  }

  private deleteSelected(): void {
    const h = this.selected();
    if (!h) return;
    this.history.checkpoint(this.draft);
    this.draft.holds = this.draft.holds.filter((o) => o !== h);
    this.overlay?.ripple(h, footprint(h), true);
    this.selectedId = null;
    bus.emit('ui:tap');
    this.commit();
  }

  private rotateSelected(dir: -1 | 1): void {
    const h = this.selected();
    if (!h) return;
    this.history.checkpoint(this.draft);
    h.angle = this.snap ? snapAngle(h.angle + dir * EDITOR.rotateStep) : wrapAngle(h.angle + dir * EDITOR.rotateStep);
    this.commit();
  }

  private reshapeSelected(): void {
    const h = this.selected();
    if (!h) return;
    this.history.checkpoint(this.draft);
    const v0 = Math.abs(h.seed) % 6;
    let s = h.seed;
    for (let k = 0; k < 12 && Math.abs(s) % 6 === v0; k++) s = 1 + Math.floor(Math.random() * 0x7ffffffe);
    h.seed = s;
    this.commit();
  }

  /** Largest size (≤ want) that keeps the hold on the wall and clear of its neighbours. */
  private fitSize(h: HoldDef, want: number): number {
    const range = SIZE_RANGE[h.type];
    let s = clamp(want, range.min, range.max);
    const k = footprint({ type: h.type, size: 1 });
    for (const o of this.draft.holds) {
      if (o.id === h.id) continue;
      const room = Math.hypot(o.x - h.x, o.y - h.y) - footprint(o) - EDITOR.clearance;
      s = Math.min(s, room / k);
    }
    for (let i = 0; i < 12 && s > range.min; i++) {
      const bd = holdBounds(this.draft, { type: h.type, size: s });
      if (h.x >= bd.x0 && h.x <= bd.x1 && h.y >= bd.y0 && h.y <= bd.y1) break;
      s -= (range.max - range.min) / 24;
    }
    return r3(Math.max(Math.min(range.min, h.size), s));
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
        if (this.checkOpen) this.drawer = null;
        this.render();
      },
      toggleBeta: () => {
        this.betaOn = !this.betaOn;
        if (this.betaOn) this.toast('Beta: numbered moves from Steini’s reader');
        this.render();
      },
      pickType: (t) => {
        const sel = this.selected();
        if (sel) {
          this.setTypeOf(sel, t);
          return;
        }
        if (t === 'foot') this.tool.role = 'foot';
        else {
          if (this.tool.type === 'foot' && this.tool.role === 'foot') this.tool.role = this.check.counts.start === 0 ? 'start' : 'hand';
          this.tool.lastHandType = t;
        }
        this.tool.type = t;
        this.render();
      },
      pickRole: (r) => {
        const sel = this.selected();
        if (sel) {
          this.setRoleOf(sel, r);
          return;
        }
        this.tool.role = r;
        if (r !== 'foot' && this.tool.type === 'foot') this.tool.type = this.tool.lastHandType === 'foot' ? 'jug' : this.tool.lastHandType;
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
      angleInput: (deg) => {
        const a = clamp(Math.round(deg), EDITOR.angleMin, EDITOR.angleMax);
        if (this.continuous !== 'angle') this.beginContinuous('angle');
        if (a === this.draft.wallAngle && !this.draft.profile) return;
        // a multi-angle wall (a generated sample) becomes one flat panel at the slider's angle;
        // editing the panels themselves comes later. Undo brings the folded wall back.
        if (this.draft.profile) {
          delete this.draft.profile;
          delete this.draft.style;
          this.toast('One flat panel now · undo restores the folded wall');
        }
        this.draft.wallAngle = a;
        // the profile diagram follows live; the 3D wall rebuilds once the slider rests
        this.wallDirty = true;
        this.wallCooldown = Math.max(this.wallCooldown, 0.28);
        this.render();
      },
      angleCommit: (deg) => {
        if (this.continuous !== 'angle') this.beginContinuous('angle');
        if (this.draft.profile) {
          delete this.draft.profile;
          delete this.draft.style;
        }
        this.draft.wallAngle = clamp(Math.round(deg), EDITOR.angleMin, EDITOR.angleMax);
        this.endContinuous(true);
      },
      toggleSnap: () => {
        this.snap = !this.snap;
        writePrefs({ snap: this.snap, sampleGrade: this.sampleGrade });
        this.toast(this.snap ? 'Snap to T-nuts · 0.1 m grid' : 'Free placement');
        this.render();
      },
      setDrawer: (d) => {
        this.drawer = d;
        if (d) this.checkOpen = false;
        this.render();
      },
      newDraft: () => void this.newDraft(),
      sampleGrade: (delta) => {
        this.sampleGrade = clamp(this.sampleGrade + delta, 0, 10);
        writePrefs({ snap: this.snap, sampleGrade: this.sampleGrade });
        this.render();
      },
      loadSample: () => void this.loadSample(),
      clearAll: () => void this.clearAll(),
      sizeStart: () => {
        if (this.selected() && this.continuous !== 'size') this.beginContinuous('size');
      },
      sizeInput: (t) => {
        const h = this.selected();
        if (!h) return;
        if (this.continuous !== 'size') this.beginContinuous('size');
        const range = SIZE_RANGE[h.type];
        h.size = this.fitSize(h, lerp(range.min, range.max, t));
        this.holdsDirty = true;
        this.overlayDirty = true;
        this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1);
      },
      sizeCommit: () => this.endContinuous(false),
      rotate: (dir) => this.rotateSelected(dir),
      reshape: () => this.reshapeSelected(),
      deleteSelected: () => this.deleteSelected(),
      deselect: () => this.select(null),
    };
  }

  private beginContinuous(kind: 'size' | 'angle'): void {
    if (this.continuous) this.endContinuous(this.continuous === 'angle');
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
      const ok = await this.ui.confirm('Start a new problem?', 'This replaces the wall with a blank panel. Your current draft will be discarded.', 'DISCARD', 'CANCEL');
      if (!ok || !this.opened) return;
    }
    this.draft = createDraft({ wallAngle: this.draft.wallAngle });
    this.resetForNewDraft();
    this.toast(`New problem · ${this.draft.name}`);
  }

  private async loadSample(): Promise<void> {
    if (this.generating) return;
    const grade = this.sampleGrade;
    if (this.draft.holds.length) {
      const ok = await this.ui.confirm('Load a sample?', `Replaces the wall with a generated ${gradeLabel(grade)} problem you can remix.`, 'REPLACE', 'CANCEL');
      if (!ok || !this.opened) return;
    }
    this.generating = true;
    this.render();
    const seed = 1 + Math.floor(Math.random() * 0x7ffffffe);
    try {
      const b = await this.analyzer.generate(seed, grade);
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
    this.drawer = null;
    this.tool.role = 'start';
    this.commit();
    this.toast('Wall cleared · undo to restore');
  }

  private resetForNewDraft(): void {
    this.history.clear();
    this.passed = this.published = this.tested = null;
    this.selectedId = null;
    this.drawer = null;
    this.checkOpen = false;
    this.betaOn = false;
    this.refreshDerived();
    this.tool.role = this.check.counts.start === 0 ? 'start' : 'hand';
    if (this.tool.type === 'foot') this.tool.type = 'jug';
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
    const tr = p.tray.getBoundingClientRect();
    const top = Math.max(0, tb.bottom - cr.top + 10);
    const bottom = Math.min(h, (tr.top > 0 ? tr.top : h) - cr.top - 8);
    this.view.layout({ w, h, top, bottom: Math.max(top + 120, bottom) }, { width: this.draft.width, height: this.draft.height }, reset);
    this.pushView();
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
    for (const h of this.draft.holds) {
      const sp = this.renderer.wallToScreen(h);
      const r = Math.max(footprint(h) * ppm, mouse ? 10 : 18) + slop;
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d > r) continue;
      const score = d / r - (h.id === this.selectedId ? 0.35 : 0);
      if (score < bs) {
        bs = score;
        best = h;
      }
    }
    return best;
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
      this.drawer = null;
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
          const w = this.renderer.screenToWall(ptr.x0, ptr.y0) ?? { x: h.x, y: h.y };
          this.history.checkpoint(this.draft);
          this.selectedId = h.id;
          this.drawer = null;
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
        const w = this.renderer.screenToWall(p.x, p.y);
        if (!h || !w) return;
        const raw = { x: w.x + g.offset.x, y: w.y + g.offset.y };
        const spot = findSpot(this.draft, raw, h, { snap: this.snap, ignoreId: h.id, searchRadius: this.snap ? 0.16 : 0.1 });
        if (spot && (spot.x !== h.x || spot.y !== h.y)) {
          h.x = spot.x;
          h.y = spot.y;
          g.changed = true;
          this.holdsDirty = true;
          this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1);
        }
        const clamped = clampToBounds(raw, holdBounds(this.draft, h));
        this.ghost = spot
          ? { p: spot, r: footprint(h), ok: true, raw: this.snap ? clamped : null, showTnuts: this.snap, ring: false }
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
        const c = this.renderer.wallToScreen(h);
        const raw = w && Math.hypot(w.x - h.x, w.y - h.y) > 0.01 ? Math.atan2(w.y - h.y, w.x - h.x) + Math.PI : Math.atan2(-(p.y - c.y), p.x - c.x) + Math.PI;
        const a = this.snap ? snapAngle(raw) : wrapAngle(raw);
        if (a !== h.angle) {
          h.angle = a;
          g.changed = true;
          this.holdsDirty = true;
          this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1);
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
          h.angle = a;
          h.size = size;
          g.changed = true;
          this.holdsDirty = true;
          this.panel?.renderInspector(h, this.draft.holds.indexOf(h) + 1);
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
    const w = hit ? null : this.renderer.screenToWall(x, y);
    if (!w) {
      this.hover = null;
      if (this.ghost) this.overlayDirty = true;
      this.ghost = null;
      return;
    }
    this.hover = { x, y };
    const proto = { type: this.tool.type, size: SIZE_RANGE[this.tool.type].def };
    const spot = findSpot(this.draft, w, proto, { snap: this.snap, searchRadius: this.snap ? 0.16 : 0.14 });
    this.ghost = { p: spot ?? w, r: footprint(proto), ok: !!spot, raw: this.snap ? w : null, showTnuts: this.snap, ring: true };
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
    if (!this.opened || !this.panel) return;
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
          this.drawer = null;
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
      const types: HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot', 'volume'];
      this.act.pickType(types[n - 1]);
    }
  };

  // ═══════════════════════════════ feedback ═══════════════════════════════

  private toast(text: string, tone: 'info' | 'good' | 'bad' = 'info'): void {
    this.panel?.toast(text, tone);
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


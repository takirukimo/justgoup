// Photo → route importer (Phase E): a full-screen, mobile-first overlay inside the editor's root.
//   PHOTO  pick or take a photo (a plain file input: camera APIs are blocked in the claude.ai sandbox)
//   FRAME  drag the wall's four corners (magnifier loupe) → perspective-straightened wall
//   COLOUR tap the problem's colour (loupe, 1–3 samples, "not this" taps for look-alike colours)
//   HOLDS  detection preview: holds lit in their colour, sensitivity, tap to drop / add, Enhance with Claude
//   START  1–2 start holds and the top (guessed from tape and height)
//   WALL   pick the wall preset, previewed live in the 3D gym → the BoulderDef

import './photo.css';
import type { RendererAPI, UIAPI } from '../core/contracts';
import type { BoulderDef, HoldType } from '../core/types';
import { BRAND } from '../config/brand';
import { button, el, fromMarkup, setText, toggle } from '../ui/dom';
import { icon } from '../ui/icons';
import { WALL_PRESETS, WALL_TYPE_LABEL, wallTypeOf, presetById, presetWall, sideView, type WallPreset } from '../editor/walls';
import { colorName, labToHex } from './color';
import { CV, inHull } from './cv';
import { PhotoEngine } from './engine';
import { applyH, defaultQuad, quadArea, quadAspect, quadValid, rectSize, rectToPhoto } from './geometry';
import { colorAdvice, decodeAdvice, frameAdvice, holdsAdvice, holdsReady, photoAdvice, rolesAdvice, SENSITIVITY_STEP, type Advice, type AdviceAction } from './advice';
import { altWalls, buildWithReport, guessRoles, nearestPreset, placeHolds, routeColorFor, ROUTE, wallFor } from './route';
import { Analyzer } from '../editor/analyzer';
import { gradeLabel } from '../game/grades';
import { resolveSample, type SampleAccess, type SampleError } from './sample';
import { askClaude, circleHull, mergeVision, visionErrorCopy, VisionError, type VisionResult } from './vision';
import type { DetectResult, Lab, PhotoBlob, PhotoHold, Pt, Quad } from './types';

export type Step = 'photo' | 'frame' | 'color' | 'holds' | 'roles' | 'wall';
export const STEPS: readonly Step[] = ['photo', 'frame', 'color', 'holds', 'roles', 'wall'];
const STEP_LABEL: Readonly<Record<Step, string>> = { photo: 'Photo', frame: 'Frame', color: 'Colour', holds: 'Holds', roles: 'Start · Top', wall: 'Wall' };

export const IMPORT = {
  /** Long edge of the decoded photo (research: 1600 px). */
  photoLong: 1600,
  /** Long edge of the straightened wall image the detector works on. */
  rectLong: 960,
  /** The wall's surface length the straightened image spans, for the detector's metric filters (m). */
  nominalH: 4.5,
  maxSamples: 3,
  maxExcludes: 3,
  /** A tap that moves less than this (css px) is a tap, not a pan. */
  tapSlop: 9,
  maxZoom: 6,
  /** Slider → detection debounce (ms). */
  detectDebounce: 140,
  /** Beta reader budget per wall (ms, in the analyzer's worker). */
  betaMs: 900,
  /** Other walls tried when the chosen one has no beta. */
  altWalls: 6,
} as const;

interface Swatch {
  lab: Lab;
  hex: string;
  neg: boolean;
  /** Where it was tapped (rectified px), while that rectification lasts. */
  at: Pt | null;
}

type ImportHold = PhotoHold & { included: boolean };

const svg = (paths: string): SVGSVGElement =>
  fromMarkup<SVGSVGElement>(
    `<svg class="ph-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
  );
const IC = {
  camera: '<path d="M3.5 8.2h3.4l1.7-2.6h6.8l1.7 2.6h3.4v11.2h-17z"/><circle cx="12" cy="13.4" r="3.6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="9.6" r="1.7"/><path d="M4 17.5l4.6-4.6 3.4 3.4 2.6-2.6 5.4 5.3"/>',
  frame: '<path d="M4 8.5V4h4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5"/><path d="M8.5 9.2l7-1.2.8 8-7.8.8z" stroke-dasharray="2 2"/>',
  drop: '<path d="M12 3.6c3.2 4 5.6 7 5.6 10.1a5.6 5.6 0 0 1-11.2 0C6.4 10.6 8.8 7.6 12 3.6z"/>',
  sparkle: '<path d="M12 3.5l1.7 5.1 5.1 1.7-5.1 1.7L12 17.1l-1.7-5.1-5.1-1.7 5.1-1.7zM18.6 15.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  minus: '<circle cx="12" cy="12" r="8.6"/><path d="M8 12h8"/>',
  light: '<circle cx="12" cy="11" r="4.2"/><path d="M12 2.8v1.8M12 17.4v1.8M3.8 11h1.8M18.4 11h1.8M6.2 5.2l1.3 1.3M16.5 15.5l1.3 1.3M17.8 5.2l-1.3 1.3M7.5 15.5l-1.3 1.3M9.5 21.2h5"/>',
  level: '<rect x="2.8" y="8.5" width="18.4" height="7" rx="2"/><path d="M12 8.5v7M9 12h-3M18 12h-3"/>',
};

/** A wall preset's side profile as a tiny SVG polyline (bottom → top, the climber on the right). */
function presetGlyph(p: WallPreset): SVGSVGElement {
  const w = presetWall(p);
  const pts = sideView(w);
  const zs = pts.map((q) => q.z);
  const hs = pts.map((q) => q.h);
  const zMin = Math.min(0, ...zs);
  const zMax = Math.max(0.6, ...zs);
  const hMax = Math.max(...hs, 1);
  const k = 30 / Math.max(hMax, zMax - zMin);
  const d = pts.map((q, i) => `${i ? 'L' : 'M'}${(6 + (q.z - zMin) * k).toFixed(1)} ${(34 - q.h * k).toFixed(1)}`).join(' ');
  return fromMarkup<SVGSVGElement>(
    `<svg class="ph-wall-g" viewBox="0 0 40 38" aria-hidden="true"><path d="M2 34.5h36" class="ph-wall-floor"/><path d="${d}" class="ph-wall-line"/></svg>`,
  );
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export interface ImporterOptions {
  root: HTMLElement;
  renderer: RendererAPI;
  ui: UIAPI;
  /** Start straight at FRAME with this image (dev harness, drag & drop). */
  file?: Blob;
}

export class PhotoImporter {
  readonly el: HTMLDivElement;
  readonly done: Promise<BoulderDef | null>;
  private resolveDone!: (b: BoulderDef | null) => void;
  private finished = false;

  step: Step = 'photo';
  private readonly engine = new PhotoEngine();
  private readonly renderer: RendererAPI;
  private readonly ui: UIAPI;

  // photo + frame
  private photo: HTMLCanvasElement | null = null;
  quad: Quad | null = null;
  private photoError = '';
  /** A warning about the picked photo itself (small, panorama), shown while framing. */
  private photoWarn: Advice | null = null;
  /** The straightened wall's own colour (the detector's median), for the colour-tap check. */
  private wallLab: Lab | null = null;
  // straightened wall
  private rect: HTMLCanvasElement | null = null;
  private rectKey = '';
  rectW = 0;
  rectH = 0;
  // colour
  swatches: Swatch[] = [];
  private pickMode: 'match' | 'exclude' = 'match';
  // detection
  sensitivity: number = CV.defaultSensitivity;
  private detected: DetectResult | null = null;
  private detectKey = '';
  private detecting = 0;
  private detectTimer: ReturnType<typeof setTimeout> | null = null;
  holds: ImportHold[] = [];
  private edits: { x: number; y: number; included: boolean }[] = [];
  private manual: ImportHold[] = [];
  private spot: HTMLCanvasElement | null = null;
  // Claude
  private claude: SampleAccess | null = null;
  private claudeHidden = false;
  private claudeTries = 0;
  private asking: AbortController | null = null;
  private askProgress = 0;
  private vision: { base: PhotoHold[]; local: ImportHold[]; result: VisionResult } | null = null;
  visionMode: 'merge' | 'claude' | 'mine' = 'mine';
  private claudeNote: { title: string; body: string; bad: boolean } | null = null;
  // roles
  private roleMode: 'start' | 'top' = 'start';
  starts: Pt[] = [];
  top: Pt | null = null;
  private rolesTouched = false;
  // wall
  presetId: string = ROUTE.defaultPreset;
  private presetTouched = false;
  private preview: BoulderDef | null = null;
  private addedFeet = 0;
  private analyzer: Analyzer | null = null;
  private betaTicket = 0;
  beta: { state: 'idle' | 'reading' | 'ok' | 'none'; grade: number | null } = { state: 'idle', grade: null };
  /** When the chosen wall has no beta: the nearest wall that has one (searching, found, or none). */
  alt: { state: 'idle' | 'searching' | 'found' | 'none'; id: string; grade: number | null } = { state: 'idle', id: '', grade: null };

  // view
  private zoom = 1;
  private cx = 0.5;
  private cy = 0.5;
  private dpr = 1;
  private sw = 0;
  private sh = 0;
  private drawQueued = false;
  private readonly pointers = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private pinch: { d0: number; zoom0: number; mid: Pt; anchor: Pt } | null = null;
  private panning = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private loupeTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObs: ResizeObserver | null = null;

  // DOM
  private readonly stage: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly loupe: HTMLCanvasElement;
  private readonly busy: HTMLDivElement;
  private readonly busyText: HTMLSpanElement;
  private readonly hero: HTMLDivElement;
  private readonly corners: HTMLDivElement[] = [];
  private readonly progress: HTMLDivElement;
  private readonly stepLabel: HTMLSpanElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly sheet: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private readonly fileCam: HTMLInputElement;
  private readonly filePick: HTMLInputElement;

  constructor(private readonly opts: ImporterOptions) {
    this.renderer = opts.renderer;
    this.ui = opts.ui;
    this.done = new Promise((r) => (this.resolveDone = r));

    this.el = el('div', 'ph');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Import a problem from a photo');

    // top bar: back · step progress · close
    this.backBtn = button({ icon: 'back', variant: 'icon', cls: 'ph-back', aria: 'Back', onTap: () => void this.back() });
    const close = button({ icon: 'close', variant: 'icon', cls: 'ph-close', aria: 'Close photo import', onTap: () => void this.cancel() });
    this.progress = el('div', 'ph-prog');
    for (let i = 0; i < STEPS.length; i++) this.progress.appendChild(el('i', 'ph-prog-seg'));
    this.stepLabel = el('span', 'ph-step-l');
    const mid = el('div', 'ph-top-mid', el('span', 'ph-kicker', 'PHOTO TO ROUTE'), this.progress, this.stepLabel);
    const top = el('header', 'ph-top', this.backBtn, mid, close);

    // stage
    this.canvas = el('canvas', 'ph-canvas');
    this.canvas.setAttribute('role', 'img');
    this.g = this.canvas.getContext('2d')!;
    this.loupe = el('canvas', 'ph-loupe');
    this.loupe.width = this.loupe.height = 1;
    this.busyText = el('span', 'ph-busy-t', '');
    this.busy = el('div', 'ph-busy', el('i', 'ph-spin'), this.busyText);
    this.hero = el('div', 'ph-hero');
    this.stage = el('div', 'ph-stage', this.canvas, this.hero, this.loupe, this.busy);
    const names = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];
    for (let i = 0; i < 4; i++) {
      const c = el('div', 'ph-corner', el('i', 'ph-corner-ring'));
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.setAttribute('aria-label', `${names[i]} wall corner: drag, or use the arrow keys`);
      this.bindCorner(c, i);
      this.corners.push(c);
      this.stage.appendChild(c);
    }
    this.bindStage();

    this.sheet = el('div', 'ph-sheet');
    this.live = el('div', 'ph-live');
    this.live.setAttribute('aria-live', 'polite');

    // file inputs (camera / library); the sandbox blocks camera APIs, a file input still works
    this.fileCam = el('input', 'ph-file');
    this.fileCam.type = 'file';
    this.fileCam.accept = 'image/*';
    this.fileCam.setAttribute('capture', 'environment');
    this.filePick = el('input', 'ph-file');
    this.filePick.type = 'file';
    this.filePick.accept = 'image/*';
    for (const f of [this.fileCam, this.filePick]) {
      f.tabIndex = -1;
      f.setAttribute('aria-hidden', 'true');
      f.addEventListener('change', () => {
        const file = f.files?.[0];
        f.value = '';
        if (file) void this.loadFile(file);
      });
    }

    this.el.append(top, this.stage, this.sheet, this.live, this.fileCam, this.filePick);
    window.addEventListener('keydown', this.onKey);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.layout());
      this.resizeObs.observe(this.stage);
    }
    void resolveSample().then((a) => {
      this.claude = a;
      if (this.step === 'holds') this.renderSheet();
    });
  }

  /** Mount into the root and start (at FRAME when a file was handed in). */
  open(): Promise<BoulderDef | null> {
    this.opts.root.appendChild(this.el);
    requestAnimationFrame(() => this.el.classList.add('on'));
    this.go('photo');
    if (this.opts.file) void this.loadFile(this.opts.file);
    return this.done;
  }

  // ═══════════════════════════════ flow ═══════════════════════════════

  private go(step: Step): void {
    const leaving = this.step;
    this.step = step;
    if (leaving === 'wall' && step !== 'wall') this.leave3D();
    if (step !== 'frame') this.hideLoupe();
    if (step === 'holds' || step === 'roles' || step === 'color') {
      if (leaving === 'frame' || leaving === 'photo') this.resetView();
    }
    this.el.dataset.step = step;
    const idx = STEPS.indexOf(step);
    [...this.progress.children].forEach((c, i) => {
      toggle(c, 'done', i < idx);
      toggle(c, 'cur', i === idx);
    });
    setText(this.stepLabel, `${idx + 1} / ${STEPS.length} · ${STEP_LABEL[step].toUpperCase()}`);
    this.backBtn.setAttribute('aria-label', step === 'photo' ? 'Close photo import' : 'Back');
    if (step === 'roles') this.prepareRoles();
    if (step === 'wall') this.enter3D();
    this.renderHero();
    this.renderSheet();
    this.layout();
    this.say(`Step ${idx + 1} of ${STEPS.length}: ${STEP_LABEL[step]}`);
  }

  private async back(): Promise<void> {
    const i = STEPS.indexOf(this.step);
    if (i <= 0) return this.cancel();
    if (this.asking) this.asking.abort();
    // from COLOUR the next step back is the photo's frame (the straightened image is rebuilt on return)
    this.go(STEPS[i - 1]);
  }

  private async cancel(): Promise<void> {
    if (this.finished) return;
    if (this.step !== 'photo' && this.photo) {
      const ok = await this.ui.confirm('Leave photo import?', 'This photo’s holds and markings will be lost.', 'LEAVE', 'STAY');
      if (!ok) return;
    }
    this.finish(null);
  }

  private finish(b: BoulderDef | null): void {
    if (this.finished) return;
    this.finished = true;
    this.asking?.abort();
    this.leave3D();
    window.removeEventListener('keydown', this.onKey);
    this.resizeObs?.disconnect();
    if (this.detectTimer) clearTimeout(this.detectTimer);
    if (this.loupeTimer) clearTimeout(this.loupeTimer);
    this.engine.dispose();
    this.analyzer?.dispose();
    this.analyzer = null;
    this.el.classList.remove('on');
    this.el.classList.add('out');
    const remove = (): void => this.el.remove();
    if (this.reduced()) remove();
    else setTimeout(remove, 260);
    this.resolveDone(b);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      void this.back();
    }
  };

  // ═══════════════════════════════ PHOTO ═══════════════════════════════

  /** Decode a picked image (EXIF orientation applied), downscale, hand it to the detector. */
  async loadFile(file: Blob): Promise<void> {
    this.photoError = '';
    this.setBusy('Reading photo');
    try {
      const { canvas, srcW, srcH } = await decodePhoto(file, IMPORT.photoLong);
      const warn = photoAdvice(srcW, srcH);
      if (warn?.level === 'bad') {
        this.setBusy('');
        this.photoError = warn.body;
        this.go('photo');
        return;
      }
      this.photoWarn = warn;
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      const data = g.getImageData(0, 0, canvas.width, canvas.height);
      await this.engine.setPhoto({ width: data.width, height: data.height, data: data.data });
      this.photo = canvas;
      this.wallLab = null;
      this.quad = defaultQuad(canvas.width, canvas.height);
      this.rect = null;
      this.rectKey = '';
      this.detected = null;
      this.detectKey = '';
      this.holds = [];
      this.edits = [];
      this.manual = [];
      this.vision = null;
      this.visionMode = 'mine';
      this.claudeNote = null;
      this.rolesTouched = false;
      for (const s of this.swatches) s.at = null;
      this.setBusy('');
      this.go('frame');
    } catch {
      this.setBusy('');
      this.photoError = decodeAdvice(file.type, file instanceof File ? file.name : '');
      this.go('photo');
    }
  }

  private renderHero(): void {
    const h = this.hero;
    h.textContent = '';
    if (this.step !== 'photo') return;
    const frame = el('div', 'ph-viewfinder', el('i', 'ph-vf-c tl'), el('i', 'ph-vf-c tr'), el('i', 'ph-vf-c br'), el('i', 'ph-vf-c bl'));
    // a stylised problem inside the viewfinder: route dots climbing a wall
    const dots = [
      [0.5, 0.86, 7],
      [0.38, 0.7, 9],
      [0.58, 0.55, 8],
      [0.44, 0.4, 10],
      [0.62, 0.26, 8],
      [0.5, 0.12, 11],
    ];
    for (const [x, y, r] of dots) {
      const d = el('i', 'ph-vf-dot');
      d.style.left = `${x * 100}%`;
      d.style.top = `${y * 100}%`;
      d.style.width = d.style.height = `${r * 2}px`;
      frame.appendChild(d);
    }
    const mark = fromMarkup<SVGSVGElement>(BRAND.logoSvg);
    mark.classList.add('ph-hero-mark');
    h.append(frame, mark);
  }

  // ═══════════════════════════════ sheet ═══════════════════════════════

  private renderSheet(): void {
    const s = this.sheet;
    s.textContent = '';
    const n = this.included().length;
    const label: Record<Step, string> = {
      photo: 'Photo to route',
      frame: 'Your photo, with the wall framed by four corners',
      color: 'The straightened wall: tap a hold of your problem’s colour',
      holds: `The straightened wall with ${n} holds outlined`,
      roles: `The problem’s ${n} holds, start and top marked`,
      wall: 'The problem on the wall, in 3D',
    };
    this.canvas.setAttribute('aria-label', label[this.step]);
    const head = (title: string, hint: string): HTMLElement => el('div', 'ph-head', el('h2', 'ph-title', title), el('p', 'ph-hint', hint));
    switch (this.step) {
      case 'photo': {
        const tips = el(
          'ul',
          'ph-tips',
          el('li', null, svg(IC.level), el('span', null, 'Square on to the wall, 1× lens')),
          el('li', null, svg(IC.frame), el('span', null, 'Floor and top of the wall in frame')),
          el('li', null, svg(IC.light), el('span', null, 'Even light, no flash')),
        );
        const take = button({ label: 'TAKE PHOTO', variant: 'primary', cls: 'btn-xl ph-take', onTap: () => this.fileCam.click() });
        take.prepend(svg(IC.camera));
        const pick = button({ label: 'CHOOSE PHOTO', variant: 'glass', cls: 'btn-xl ph-pick', onTap: () => this.filePick.click() });
        pick.prepend(svg(IC.image));
        s.append(head('Photo to route', 'Turn a real problem into one you can climb and remix.'), tips);
        if (this.photoError) s.appendChild(el('p', 'ph-err', icon('warn', 'ph-err-ic'), el('span', null, this.photoError)));
        s.append(el('div', 'ph-actions ph-actions-col', take, pick), el('p', 'ph-foot', 'YOUR PHOTO STAYS ON THIS DEVICE'));
        break;
      }
      case 'frame': {
        const reset = button({ label: 'RESET', variant: 'ghost', cls: 'ph-reset', onTap: () => this.resetQuad() });
        const next = button({ label: 'STRAIGHTEN', variant: 'primary', cls: 'ph-next', icon: 'arrow', iconAfter: true, onTap: () => void this.straighten() });
        s.append(head('Frame the wall', 'Drag the corners to the wall’s edges, floor to top. We’ll straighten it.'));
        const adv = this.frameWarn() ?? this.photoWarn;
        if (adv) s.appendChild(this.adviceEl(adv));
        s.appendChild(el('div', 'ph-actions', reset, next));
        break;
      }
      case 'color': {
        const seg = this.segmented(
          [
            { id: 'match', label: 'MATCH' },
            { id: 'exclude', label: 'NOT THIS' },
          ],
          this.pickMode,
          (v) => {
            this.pickMode = v as 'match' | 'exclude';
            this.renderSheet();
          },
        );
        const sw = el('div', 'ph-swatches');
        const inc = this.swatches.filter((x) => !x.neg);
        const exc = this.swatches.filter((x) => x.neg);
        if (!this.swatches.length) sw.appendChild(el('span', 'ph-sw-empty', svg(IC.drop), el('span', null, 'NO COLOUR YET')));
        for (const x of [...inc, ...exc]) {
          const chip = el('button', `ph-sw${x.neg ? ' neg' : ''}`, el('i', 'ph-sw-dot'), el('span', 'ph-sw-l', x.neg ? 'NOT ' + colorName(x.lab).toUpperCase() : colorName(x.lab).toUpperCase()), icon('close', 'ph-sw-x'));
          chip.type = 'button';
          chip.style.setProperty('--sw', x.hex);
          chip.setAttribute('aria-label', `Remove ${x.neg ? 'excluded ' : ''}colour ${colorName(x.lab)}`);
          chip.addEventListener('click', () => {
            this.swatches = this.swatches.filter((q) => q !== x);
            this.detectKey = '';
            this.renderSheet();
            this.draw();
          });
          sw.appendChild(chip);
        }
        const next = button({ label: 'FIND HOLDS', variant: 'primary', cls: 'ph-next', icon: 'arrow', iconAfter: true, disabled: inc.length === 0, onTap: () => void this.findHolds() });
        const hint =
          this.pickMode === 'match'
            ? inc.length
              ? 'Add a tap where the light changes, or find the holds.'
              : 'Tap one of your problem’s holds. Pinch to zoom in.'
            : 'Tap a look-alike colour that isn’t yours, like purple next to blue.';
        s.append(head('Tap your colour', hint), seg, sw);
        const wallTap = inc.length ? inc.map((x) => colorAdvice(x.lab, this.wallLab)).find((a) => a) : null;
        if (wallTap) s.appendChild(this.adviceEl(wallTap));
        s.appendChild(el('div', 'ph-actions', next));
        break;
      }
      case 'holds': {
        const n = this.included().length;
        const advice = this.detected ? this.holdsAdvice() : [];
        const title = this.detecting && !this.detected ? 'Finding holds…' : n === 0 ? 'No holds found' : `${n} hold${n === 1 ? '' : 's'} found`;
        const slider = el('input', 'ph-range');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.value = String(Math.round(this.sensitivity * 100));
        slider.setAttribute('aria-label', 'Detection sensitivity');
        const val = el('span', 'ph-range-v', `${Math.round(this.sensitivity * 100)}`);
        slider.addEventListener('input', () => {
          this.sensitivity = Number(slider.value) / 100;
          setText(val, slider.value);
          this.scheduleDetect();
        });
        const sens = el('label', 'ph-sens', el('span', 'ph-lbl', 'SENSITIVITY'), slider, val);
        s.append(head(title, 'Tap a hold to drop it, or an empty spot to add one.'));
        if (advice.length && !this.detecting) s.appendChild(this.adviceEl(advice[0]));
        s.appendChild(sens);
        if (this.claude && !this.claudeHidden) s.appendChild(this.claudeBlock());
        else if (this.claudeNote) s.appendChild(this.noteEl());
        const next = button({ label: 'NEXT', variant: 'primary', cls: 'ph-next', icon: 'arrow', iconAfter: true, disabled: !holdsReady(n), onTap: () => this.go('roles') });
        s.appendChild(el('div', 'ph-actions', next));
        break;
      }
      case 'roles': {
        const seg = this.segmented(
          [
            { id: 'start', label: 'START' },
            { id: 'top', label: 'TOP' },
          ],
          this.roleMode,
          (v) => {
            this.roleMode = v as 'start' | 'top';
            this.renderSheet();
          },
        );
        const { starts, top } = this.resolveRoles();
        const status = el(
          'div',
          'ph-status',
          el('span', `ph-chip${starts.length ? ' ok' : ''}`, `START ${starts.length}/2`),
          el('span', `ph-chip${top !== null ? ' ok' : ''}`, top !== null ? 'TOP ✓' : 'TOP —'),
          el('span', `ph-chip${this.handCount() >= 4 ? ' ok' : ''}`, `HANDS ${this.handCount()}`),
        );
        const adv = this.rolesAdvice();
        const ok = starts.length >= 1 && top !== null && adv?.level !== 'bad';
        const next = button({ label: 'NEXT', variant: 'primary', cls: 'ph-next', icon: 'arrow', iconAfter: true, disabled: !ok, onTap: () => this.go('wall') });
        const hint = this.roleMode === 'start' ? 'Tap 1 or 2 start holds. Tap again to clear one.' : 'Tap the top hold: match both hands on it to send.';
        s.append(head('Start and top', hint), seg, status);
        if (adv) s.appendChild(this.adviceEl(adv));
        s.appendChild(el('div', 'ph-actions', next));
        break;
      }
      case 'wall': {
        const list = el('div', 'ph-walls');
        list.setAttribute('role', 'radiogroup');
        list.setAttribute('aria-label', 'Wall');
        for (const p of WALL_PRESETS) {
          const t = WALL_TYPE_LABEL[wallTypeOf(presetWall(p))].toUpperCase();
          const chip = el('button', `ph-wall${p.id === this.presetId ? ' on' : ''}`, presetGlyph(p), el('span', 'ph-wall-t', t), el('span', 'ph-wall-v', p.label));
          chip.type = 'button';
          chip.dataset.id = p.id;
          chip.setAttribute('role', 'radio');
          chip.setAttribute('aria-checked', String(p.id === this.presetId));
          chip.setAttribute('aria-label', `${t} ${p.label}`);
          chip.addEventListener('click', () => this.pickWall(p.id));
          list.appendChild(chip);
        }
        const c = this.routeColor();
        const n = this.included().length;
        const sum = el('div', 'ph-sum', el('i', 'ph-sum-dot'), el('span', null, `${c.name.toUpperCase()} SNAPSHOT · ${n} HOLD${n === 1 ? '' : 'S'}`, el('span', 'ph-sum-feet', '')));
        sum.style.setProperty('--sw', c.hex);
        const beta = el('div', 'ph-beta');
        beta.setAttribute('aria-live', 'polite');
        const make = button({ label: 'CREATE PROBLEM', variant: 'primary', cls: 'btn-xl ph-make', icon: 'check', onTap: () => this.confirm() });
        s.append(head('Pick the wall', 'How steep is the wall in your photo? Slide for more.'), list, sum, beta, el('div', 'ph-actions', make));
        requestAnimationFrame(() => this.renderBeta());
        requestAnimationFrame(() => list.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
        break;
      }
    }
  }

  /** The detection's advice: nothing found, too loose a colour, too many / few holds, the frame's scale. */
  private holdsAdvice(): Advice[] {
    const inc = this.included();
    const holds = inc.filter((h) => h.kind === 'hold');
    const medianM = holds.length >= 4 ? [...holds.map((h) => (h.sizeM ?? h.major / this.ppm()))].sort((a, b) => a - b)[holds.length >> 1] : null;
    const mask = this.detected?.mask;
    let on = 0;
    if (mask) for (let i = 0; i < mask.length; i++) on += mask[i];
    return holdsAdvice({ n: inc.length, coverage: mask && mask.length ? on / mask.length : 0, medianM, sensitivity: this.sensitivity });
  }

  /** The framed wall: too small in the photo, or much wider than tall. */
  private frameWarn(): Advice | null {
    if (!this.quad || !this.photo) return null;
    const area = quadArea(this.quad) / (this.photo.width * this.photo.height);
    return frameAdvice(area, quadAspect(this.quad, this.photo.width, this.photo.height));
  }

  /** Start / top on the chosen wall (heights in metres). */
  private rolesAdvice(): Advice | null {
    const inc = this.included();
    const { starts, top } = this.resolveRoles();
    const wall = wallFor(this.presetId);
    const placed = placeHolds(inc, this.rectW, this.rectH, wall.length);
    return rolesAdvice({ startYs: starts.map((i) => placed[i].y), topY: top !== null ? placed[top].y : null, hands: this.handCount() });
  }

  /** A message with the buttons that act on it. */
  private adviceEl(a: Advice): HTMLElement {
    const box = el('div', `ph-adv ${a.level}`, icon('warn', 'ph-adv-ic'), el('p', 'ph-adv-t', el('b', null, a.title), el('span', null, ' ' + a.body)));
    box.setAttribute('role', 'status');
    const LABEL: Partial<Record<AdviceAction, string>> = { more: 'FIND MORE', less: 'FIND FEWER', recolor: 'TAP A HOLD AGAIN', exclude: 'ADD NOT THIS', reframe: 'FIX THE CORNERS' };
    const acts = (a.actions ?? []).filter((x) => LABEL[x]);
    if (acts.length) {
      const row = el('div', 'ph-adv-acts');
      for (const x of acts) row.appendChild(button({ label: LABEL[x]!, variant: 'glass', cls: 'ph-adv-b', onTap: () => this.act(x) }));
      box.appendChild(row);
    }
    return box;
  }

  private act(x: AdviceAction): void {
    switch (x) {
      case 'more':
      case 'less':
        this.sensitivity = clamp(this.sensitivity + (x === 'more' ? SENSITIVITY_STEP : -SENSITIVITY_STEP), 0, 1);
        this.renderSheet();
        void this.detect();
        this.say(`Sensitivity ${Math.round(this.sensitivity * 100)}`);
        break;
      case 'recolor':
      case 'exclude':
        this.pickMode = x === 'exclude' ? 'exclude' : 'match';
        this.go('color');
        break;
      case 'reframe':
        this.go('frame');
        break;
      case 'add':
        break;
    }
  }

  private segmented(options: { id: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
    const wrap = el('div', 'ph-seg');
    wrap.setAttribute('role', 'radiogroup');
    for (const o of options) {
      const b = el('button', `ph-seg-b${o.id === value ? ' on' : ''}`, o.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(o.id === value));
      b.addEventListener('click', () => {
        if (o.id !== value) onChange(o.id);
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  private claudeBlock(): HTMLElement {
    const wrap = el('div', 'ph-claude');
    if (this.asking) {
      const stop = button({ label: 'STOP', variant: 'ghost', cls: 'ph-claude-stop', onTap: () => this.asking?.abort() });
      wrap.append(
        el('div', 'ph-claude-run', el('i', 'ph-spin'), el('span', null, this.askProgress ? `Claude is reading the holds · ${this.askProgress} characters` : 'Asking Claude… this can take up to a minute')),
        stop,
      );
      return wrap;
    }
    if (this.vision) {
      const seg = this.segmented(
        [
          { id: 'merge', label: 'MERGED' },
          { id: 'claude', label: 'CLAUDE' },
          { id: 'mine', label: 'MINE' },
        ],
        this.visionMode,
        (v) => this.applyVision(v as 'merge' | 'claude' | 'mine'),
      );
      wrap.append(el('div', 'ph-claude-h', svg(IC.sparkle), el('span', null, 'ENHANCED BY CLAUDE')), seg);
      if (this.claudeNote) wrap.appendChild(this.noteEl());
      return wrap;
    }
    const b = button({ label: this.claudeTries ? 'ASK CLAUDE AGAIN' : 'ENHANCE WITH CLAUDE', variant: 'glass', cls: 'ph-claude-go', onTap: () => void this.enhance() });
    b.prepend(svg(IC.sparkle));
    wrap.append(b, el('p', 'ph-claude-note', 'Sends this straightened photo to Claude on your account.'));
    if (this.claudeNote) wrap.appendChild(this.noteEl());
    return wrap;
  }

  private noteEl(): HTMLElement {
    const n = this.claudeNote!;
    return el('p', `ph-note${n.bad ? ' bad' : ''}`, el('b', null, n.title), el('span', null, ' ' + n.body));
  }

  // ═══════════════════════════════ FRAME ═══════════════════════════════

  private resetQuad(): void {
    if (!this.photo) return;
    this.quad = defaultQuad(this.photo.width, this.photo.height);
    this.layout();
  }

  private bindCorner(c: HTMLDivElement, i: number): void {
    let grab: Pt | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (!this.quad || this.step !== 'frame') return;
      e.preventDefault();
      e.stopPropagation();
      c.setPointerCapture(e.pointerId);
      const p = this.toScreen(this.quad[i]);
      const r = this.stage.getBoundingClientRect();
      grab = { x: e.clientX - r.left - p.x, y: e.clientY - r.top - p.y };
      c.classList.add('drag');
      this.showCornerLoupe(i);
    });
    c.addEventListener('pointermove', (e) => {
      if (!grab || !this.quad || !this.photo) return;
      const r = this.stage.getBoundingClientRect();
      const q = this.toImage({ x: e.clientX - r.left - grab.x, y: e.clientY - r.top - grab.y });
      this.moveCorner(i, q);
    });
    const end = (e: PointerEvent): void => {
      if (!grab) return;
      grab = null;
      c.classList.remove('drag');
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      this.hideLoupe();
      // the frame's advice follows the corners
      if (this.step === 'frame') this.renderSheet();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('keydown', (e) => {
      if (!this.quad) return;
      const step = (e.shiftKey ? 12 : 2) / Math.max(0.2, this.scale());
      const d: Record<string, Pt> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
      const m = d[e.key];
      if (!m) return;
      e.preventDefault();
      this.moveCorner(i, { x: this.quad[i].x + m.x, y: this.quad[i].y + m.y });
    });
  }

  private moveCorner(i: number, p: Pt): void {
    if (!this.quad || !this.photo) return;
    const next = this.quad.map((q) => ({ ...q })) as Quad;
    next[i] = { x: clamp(p.x, 0, this.photo.width), y: clamp(p.y, 0, this.photo.height) };
    if (!quadValid(next, 24)) return;
    this.quad = next;
    this.placeCorners();
    this.showCornerLoupe(i);
    this.draw();
  }

  private async straighten(): Promise<void> {
    if (!this.photo || !this.quad) return;
    const key = this.quad.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('|');
    if (this.rect && key === this.rectKey) {
      this.go('color');
      return;
    }
    this.setBusy('Straightening the wall');
    try {
      const aspect = quadAspect(this.quad, this.photo.width, this.photo.height);
      const { w, h } = rectSize(aspect, IMPORT.rectLong);
      const { image, wall } = await this.engine.rectify(this.quad, w, h);
      this.wallLab = wall;
      const c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      this.rect = c;
      this.rectW = w;
      this.rectH = h;
      this.rectKey = key;
      // the colours stay; where they were tapped, the holds and edits belong to the old framing
      for (const s of this.swatches) s.at = null;
      this.detected = null;
      this.detectKey = '';
      this.holds = [];
      this.edits = [];
      this.manual = [];
      this.vision = null;
      this.visionMode = 'mine';
      this.claudeNote = null;
      this.rolesTouched = false;
      this.spot = null;
      this.setBusy('');
      this.go('color');
    } catch {
      this.setBusy('');
      this.ui.hud.toast('Could not straighten that photo · try other corners');
    }
  }

  // ═══════════════════════════════ COLOUR ═══════════════════════════════

  private async pickColor(p: Pt, screen: Pt): Promise<void> {
    if (!this.rect) return;
    const lab = await this.engine.sample(p.x, p.y, 3).catch(() => null);
    if (!lab) return;
    const neg = this.pickMode === 'exclude';
    const sw: Swatch = { lab, hex: labToHex(lab), neg, at: p };
    const same = this.swatches.filter((s) => s.neg === neg);
    if (same.length >= (neg ? IMPORT.maxExcludes : IMPORT.maxSamples)) this.swatches.splice(this.swatches.indexOf(same[0]), 1);
    this.swatches.push(sw);
    this.detectKey = '';
    this.showTapLoupe(p, screen, sw.hex);
    this.say(`${neg ? 'Excluded' : 'Picked'} ${colorName(lab)}`);
    this.renderSheet();
    this.draw();
  }

  private samples(): { inc: Lab[]; exc: Lab[] } {
    return { inc: this.swatches.filter((s) => !s.neg).map((s) => s.lab), exc: this.swatches.filter((s) => s.neg).map((s) => s.lab) };
  }

  private ppm(): number {
    return this.rectH / IMPORT.nominalH;
  }

  // ═══════════════════════════════ HOLDS ═══════════════════════════════

  private async findHolds(): Promise<void> {
    if (!this.samples().inc.length) return;
    this.go('holds');
    await this.detect();
  }

  private scheduleDetect(): void {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = setTimeout(() => void this.detect(), IMPORT.detectDebounce);
  }

  /** (Re-)detect with the current colours and sensitivity; user edits and added holds carry over. */
  private async detect(): Promise<void> {
    const { inc, exc } = this.samples();
    if (!inc.length || !this.rect) return;
    const key = JSON.stringify([inc, exc, this.sensitivity, this.rectKey]);
    if (key === this.detectKey && this.detected) return;
    const ticket = ++this.detecting;
    this.el.classList.add('is-detecting');
    if (!this.detected) this.renderSheet();
    try {
      const res = await this.engine.detect(inc, exc, this.sensitivity, this.ppm());
      if (ticket !== this.detecting || this.finished) return;
      this.detected = res;
      this.detectKey = key;
      this.spot = spotlight(this.rect, res.mask);
      this.rebuildHolds();
      // a fresh detection renumbers the regions: an earlier Claude answer no longer applies
      if (this.vision) {
        this.vision = null;
        this.visionMode = 'mine';
        this.claudeNote = null;
      }
      const n = this.included().length;
      this.say(`${n} holds found`);
    } catch {
      if (ticket === this.detecting) this.ui.hud.toast('Could not read the holds · try another colour tap');
    } finally {
      if (ticket === this.detecting) {
        this.detecting = 0;
        this.el.classList.remove('is-detecting');
        if (this.step === 'holds') this.renderSheet();
        this.draw();
      }
    }
  }

  private rebuildHolds(): void {
    if (!this.detected) return;
    const out: ImportHold[] = this.detected.blobs.map((b) => holdOf(b, b.kind === 'hold'));
    for (const e of this.edits) {
      const h = out.find((q) => inHull(q.hull, e.x, e.y, 3));
      if (h) h.included = e.included;
    }
    // hand-added holds stay unless a detected region now covers them
    this.manual = this.manual.filter((m) => !out.some((q) => q.included && inHull(q.hull, m.x, m.y, 2)));
    this.holds = [...out, ...this.manual];
  }

  /** Holds in the problem, in topo reading order (top → bottom, left → right). */
  included(): ImportHold[] {
    return this.holds.filter((h) => h.included).sort((a, b) => a.y - b.y || a.x - b.x);
  }

  private async tapHolds(p: Pt): Promise<void> {
    const hit = this.hitHold(p, true);
    if (hit) {
      hit.included = !hit.included;
      if (hit.manual && !hit.included) {
        this.manual = this.manual.filter((m) => m !== hit);
        this.holds = this.holds.filter((m) => m !== hit);
      } else {
        this.edits = this.edits.filter((e) => !inHull(hit.hull, e.x, e.y, 3));
        this.edits.push({ x: hit.x, y: hit.y, included: hit.included });
      }
      this.say(hit.included ? 'Hold added back' : 'Hold dropped');
      this.afterHoldEdit();
      return;
    }
    const { inc, exc } = this.samples();
    const blob = await this.engine.region(p.x, p.y, inc, exc, this.sensitivity, this.ppm()).catch(() => null);
    if (this.finished || this.step !== 'holds') return;
    let h: ImportHold;
    if (blob && Math.hypot(blob.x - p.x, blob.y - p.y) < blob.major) h = holdOf(blob, true);
    else {
      const r = 0.045 * this.ppm();
      h = { x: p.x, y: p.y, major: r * 2, minor: r * 1.6, theta: 0, solidity: 1, pocket: false, kind: 'hold', hull: circleHull(p.x, p.y, r), included: true };
    }
    h.manual = true;
    h.source = 'user';
    this.manual.push(h);
    this.holds.push(h);
    this.say('Hold added');
    this.afterHoldEdit();
  }

  private afterHoldEdit(): void {
    this.rolesTouched = this.rolesTouched && this.starts.length + (this.top ? 1 : 0) > 0;
    this.renderSheet();
    this.draw();
  }

  /** The hold under a point (included ones first), with a finger-sized margin. */
  private hitHold(p: Pt, any: boolean): ImportHold | null {
    const pad = 14 / Math.max(0.05, this.scale());
    const pool = any ? this.holds : this.holds.filter((h) => h.included);
    let best: ImportHold | null = null;
    let bd = Infinity;
    for (const h of pool) {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      const inside = inHull(h.hull, p.x, p.y, pad);
      if (!inside) continue;
      const score = d - (h.included ? 1e6 : 0);
      if (score < bd) {
        bd = score;
        best = h;
      }
    }
    return best;
  }

  // ═══════════════════════════════ CLAUDE ═══════════════════════════════

  private async enhance(): Promise<void> {
    if (!this.claude || !this.rect || this.asking) return;
    const local = this.included();
    // the regions Claude sees, numbered: the problem's holds, then tape / volumes the detector set aside
    const extra = this.holds.filter((h) => !h.included && !h.manual && h.kind !== 'hold').sort((a, b) => a.y - b.y || a.x - b.x);
    const base: PhotoHold[] = [...local, ...extra];
    const ctl = new AbortController();
    this.asking = ctl;
    this.askProgress = 0;
    this.claudeNote = null;
    this.renderSheet();
    try {
      const result = await askClaude({
        access: this.claude,
        rect: this.rect,
        holds: base,
        colorName: colorName(this.samples().inc[0]),
        colorHex: labToHex(this.samples().inc[0]),
        wallW: (this.rectW / this.rectH) * IMPORT.nominalH,
        wallH: IMPORT.nominalH,
        signal: ctl.signal,
        onProgress: (n) => {
          this.askProgress = n;
          const run = this.sheet.querySelector('.ph-claude-run span');
          if (run) setText(run, `Claude is reading the holds · ${n} characters`);
        },
      });
      if (this.finished || this.asking !== ctl) return;
      this.asking = null;
      this.vision = { base, local: this.holds.map((h) => ({ ...h })), result };
      if (result.wallAngle !== null && !this.presetTouched) this.presetId = nearestPreset(result.wallAngle);
      this.applyVision('merge');
    } catch (e) {
      if (this.asking !== ctl) return;
      this.asking = null;
      const copy = visionErrorCopy(e instanceof VisionError ? e : (e as SampleError));
      if (copy) {
        this.claudeTries++;
        this.claudeNote = { title: copy.title, body: copy.body, bad: true };
        // research §5.2: one manual retry, never a loop
        if (copy.hide || !copy.retry || this.claudeTries >= 2) this.claudeHidden = true;
      }
      if (this.step === 'holds') this.renderSheet();
    }
  }

  /** Show Claude's merge, Claude's holds only, or the local detection (the user's edits included). */
  private applyVision(mode: 'merge' | 'claude' | 'mine'): void {
    if (!this.vision) return;
    this.visionMode = mode;
    const { base, local, result } = this.vision;
    if (mode === 'mine') {
      this.holds = local.map((h) => ({ ...h }));
      this.claudeNote = null;
    } else {
      const m = mergeVision(base, result, mode, this.rectW, this.rectH);
      const keep: ImportHold[] = m.holds.map((h) => ({ ...h, included: true }));
      // what Claude left out stays visible (dashed) so it can be tapped back in
      const out = local.filter((l) => !keep.some((k) => Math.hypot(k.x - l.x, k.y - l.y) < 2)).map((l) => ({ ...l, included: false }));
      this.holds = [...keep, ...out];
      if (!this.rolesTouched && (m.starts.length || m.top !== null)) {
        // Claude's starts only where the game's climber can start (standing): a sit start low on the
        // wall leaves the starts to the local guess, Claude's top stays
        const wall = wallFor(this.presetId);
        const placed = placeHolds(m.holds, this.rectW, this.rectH, wall.length);
        const standing = m.starts.filter((i) => placed[i].y >= ROUTE.startMinY);
        this.starts = standing.map((i) => ({ x: m.holds[i].x, y: m.holds[i].y }));
        this.top = m.top !== null ? { x: m.holds[m.top].x, y: m.holds[m.top].y } : null;
        this.rolesFromClaude = true;
      }
      const s = m.stats;
      this.claudeNote = { title: `${s.kept} confirmed`, body: `· ${s.added} added · ${s.dropped} dropped`, bad: false };
    }
    this.say(`${this.included().length} holds`);
    this.renderSheet();
    this.draw();
  }
  private rolesFromClaude = false;

  // ═══════════════════════════════ START / TOP ═══════════════════════════════

  private prepareRoles(): void {
    const kept = this.rolesTouched || this.rolesFromClaude ? this.resolveRoles() : { starts: [], top: null };
    // the player's (or Claude's) marks stay; whatever is missing is guessed
    if (this.rolesTouched && (kept.starts.length || kept.top !== null)) return;
    if (kept.starts.length && kept.top !== null) return;
    const inc = this.included();
    const wall = wallFor(this.presetId);
    const placed = placeHolds(inc, this.rectW, this.rectH, wall.length);
    const mpp = wall.length / this.rectH;
    const tapes = this.holds.filter((h) => h.kind === 'tape').map((t) => ({ x: (t.x - this.rectW / 2) * mpp, y: wall.length - t.y * mpp }));
    const g = guessRoles(placed, tapes);
    const top = kept.top ?? g.top;
    const starts = kept.starts.length ? kept.starts : g.starts.filter((i) => i !== top);
    this.starts = starts.map((i) => ({ x: inc[i].x, y: inc[i].y }));
    this.top = top !== null ? { x: inc[top].x, y: inc[top].y } : null;
  }

  /** Start / top marks → indices into included(). */
  private resolveRoles(): { starts: number[]; top: number | null } {
    const inc = this.included();
    const find = (p: Pt): number => {
      let best = -1;
      let bd = Infinity;
      inc.forEach((h, i) => {
        const d = Math.hypot(h.x - p.x, h.y - p.y);
        if (d < bd && (inHull(h.hull, p.x, p.y, 4) || d < 4)) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    const top = this.top ? find(this.top) : -1;
    const starts = [...new Set(this.starts.map(find).filter((i) => i >= 0 && i !== top))].slice(0, 2);
    return { starts, top: top >= 0 ? top : null };
  }

  private handCount(): number {
    const inc = this.included();
    const wall = wallFor(this.presetId);
    return placeHolds(inc, this.rectW, this.rectH, wall.length).filter((p) => p.guess.type !== 'foot' && p.guess.type !== 'volume').length;
  }

  private tapRoles(p: Pt): void {
    const h = this.hitHold(p, false);
    if (!h) return;
    const at = { x: h.x, y: h.y };
    const same = (q: Pt | null): boolean => !!q && Math.hypot(q.x - at.x, q.y - at.y) < 1;
    // a tiny hold picked as a start or the top is a hand hold, not a foot chip
    const lift = (): void => {
      const wall = wallFor(this.presetId);
      const [pl] = placeHolds([h], this.rectW, this.rectH, wall.length);
      if (pl.guess.type === 'foot') h.type = 'crimp' as HoldType;
    };
    if (this.roleMode === 'start') {
      if (this.starts.some(same)) this.starts = this.starts.filter((q) => !same(q));
      else {
        if (same(this.top)) this.top = null;
        this.starts.push(at);
        if (this.starts.length > 2) this.starts.shift();
        lift();
      }
    } else {
      this.starts = this.starts.filter((q) => !same(q));
      this.top = same(this.top) ? null : at;
      if (this.top) lift();
    }
    this.rolesTouched = true;
    this.say(this.roleMode === 'start' ? `${this.resolveRoles().starts.length} start holds` : this.top ? 'Top set' : 'Top cleared');
    this.renderSheet();
    this.draw();
  }

  // ═══════════════════════════════ WALL ═══════════════════════════════

  private build(): BoulderDef {
    const r = this.buildFor(this.presetId);
    this.addedFeet = r.addedFeet;
    if (this.beta.state === 'ok' && this.beta.grade !== null) r.boulder.grade = this.beta.grade;
    return r.boulder;
  }

  private buildFor(presetId: string): { boulder: BoulderDef; addedFeet: number } {
    const inc = this.included();
    const { starts, top } = this.resolveRoles();
    const c = this.routeColor();
    return buildWithReport({ holds: inc, rectW: this.rectW, rectH: this.rectH, starts, top, presetId, color: c.hex, name: `${c.name} Snapshot` });
  }

  /** Can the game's climber get up it on this wall? (the editor's beta reader, in its worker) */
  private checkBeta(b: BoulderDef): void {
    const ticket = ++this.betaTicket;
    this.beta = { state: 'reading', grade: null };
    this.alt = { state: 'idle', id: '', grade: null };
    this.renderBeta();
    this.analyzer ??= new Analyzer();
    this.analyzer
      .solve(b, IMPORT.betaMs)
      .then((r) => {
        if (ticket !== this.betaTicket || this.finished) return;
        this.beta = r.moves ? { state: 'ok', grade: r.grade } : { state: 'none', grade: null };
        if (!r.moves) void this.findAltWall(ticket);
      })
      .catch(() => {
        if (ticket === this.betaTicket) this.beta = { state: 'idle', grade: null };
      })
      .finally(() => {
        if (ticket === this.betaTicket) this.renderBeta();
      });
  }

  /**
   * No beta on the chosen wall: try the walls closest in steepness (flatter first on a tie) until one
   * has a beta, so the WALL step always offers a way on (never a dead end).
   */
  private async findAltWall(ticket: number): Promise<void> {
    this.alt = { state: 'searching', id: '', grade: null };
    this.renderBeta();
    for (const id of altWalls(this.presetId).slice(0, IMPORT.altWalls)) {
      if (ticket !== this.betaTicket || this.finished || !this.analyzer) return;
      let ok = false;
      let grade: number | null = null;
      try {
        const r = await this.analyzer.solve(this.buildFor(id).boulder, IMPORT.betaMs);
        ok = !!r.moves;
        grade = r.grade;
      } catch {
        /* a failed read is not a beta */
      }
      if (ticket !== this.betaTicket || this.finished) return;
      if (ok) {
        this.alt = { state: 'found', id, grade };
        this.renderBeta();
        return;
      }
    }
    this.alt = { state: 'none', id: '', grade: null };
    this.renderBeta();
  }

  private renderBeta(): void {
    const box = this.sheet.querySelector('.ph-beta');
    if (!box) return;
    box.textContent = '';
    box.className = `ph-beta is-${this.beta.state}`;
    const wallName = (id: string): string => {
      const p = presetById(id);
      return p ? `${WALL_TYPE_LABEL[wallTypeOf(presetWall(p))]} ${p.label}`.toUpperCase() : id.toUpperCase();
    };
    if (this.beta.state === 'reading') box.append(el('i', 'ph-spin'), el('span', null, 'READING THE BETA'));
    else if (this.beta.state === 'ok') box.append(icon('check', 'ph-beta-ic'), el('span', null, `CLIMBABLE${this.beta.grade !== null ? ' · ' + gradeLabel(this.beta.grade) : ''}`));
    else if (this.beta.state === 'none') {
      const line = el('div', 'ph-beta-line', icon('warn', 'ph-beta-ic'));
      box.appendChild(line);
      if (this.alt.state === 'searching') line.append(el('span', null, `NO BETA ON THIS WALL · TRYING OTHER WALLS`), el('i', 'ph-spin'));
      else if (this.alt.state === 'found') {
        const id = this.alt.id;
        line.appendChild(el('span', null, `NO BETA ON THIS WALL YET · CLIMBABLE ON ${wallName(id)}${this.alt.grade !== null ? ' · ' + gradeLabel(this.alt.grade) : ''}`));
        const use = button({ label: `USE ${wallName(id)}`, variant: 'glass', cls: 'ph-beta-use', icon: 'arrow', iconAfter: true, onTap: () => this.pickWall(id) });
        box.appendChild(use);
      } else line.appendChild(el('span', null, 'NO BETA YET · CREATE IT, THEN GIVE IT BIGGER HOLDS OR MORE FEET IN THE EDITOR'));
    }
    const feet = this.sheet.querySelector('.ph-sum-feet');
    if (feet) setText(feet, this.addedFeet ? ` · +${this.addedFeet} FOOTHOLD${this.addedFeet === 1 ? '' : 'S'} ADDED` : '');
  }

  /** Select a wall preset (chip tap or the beta reader's suggestion) and preview it. */
  private pickWall(id: string): void {
    this.presetId = id;
    this.presetTouched = true;
    const list = this.sheet.querySelector('.ph-walls');
    if (list) {
      for (const c of list.children) {
        const on = (c as HTMLElement).dataset.id === id;
        toggle(c, 'on', on);
        c.setAttribute('aria-checked', String(on));
        if (on) c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: this.reduced() ? 'auto' : 'smooth' });
      }
    }
    this.updatePreview();
  }

  private routeColor(): { name: string; hex: string } {
    const inc = this.samples().inc;
    return inc.length ? routeColorFor(inc[0]) : { name: 'Yellow', hex: '#F2C230' };
  }

  private enter3D(): void {
    this.el.classList.add('is-3d');
    this.updatePreview();
  }

  private updatePreview(): void {
    if (this.step !== 'wall') return;
    try {
      this.preview = this.build();
      this.renderer.setClimberVisible(false);
      this.renderer.loadBoulder(this.preview);
      const r = this.renderer as RendererAPI & { setViewInsets?: (top: number, bottom: number) => void };
      const H = this.el.clientHeight || 1;
      const topH = (this.el.querySelector('.ph-top') as HTMLElement | null)?.offsetHeight ?? 0;
      r.setViewInsets?.(Math.min(0.4, (topH + 8) / H), Math.min(0.45, (this.sheet.offsetHeight + 8) / H));
      this.renderer.setCameraMode('preview', { instant: false });
      this.checkBeta(this.preview);
    } catch {
      /* the 3D preview is a nicety: the problem is still built on confirm */
    }
  }

  private leave3D(): void {
    if (!this.el.classList.contains('is-3d')) return;
    this.el.classList.remove('is-3d');
    (this.renderer as RendererAPI & { setViewInsets?: (top: number, bottom: number) => void }).setViewInsets?.(0, 0);
  }

  private confirm(): void {
    this.finish(this.build());
  }

  // ═══════════════════════════════ stage: layout, view, input ═══════════════════════════════

  private layout(): void {
    const r = this.stage.getBoundingClientRect();
    this.sw = Math.max(1, r.width);
    this.sh = Math.max(1, r.height);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(this.sw * this.dpr);
    const H = Math.round(this.sh * this.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.placeCorners();
    this.draw();
  }

  private image(): HTMLCanvasElement | null {
    return this.step === 'frame' ? this.photo : this.step === 'photo' || this.step === 'wall' ? null : this.rect;
  }

  private fit(): number {
    const img = this.image();
    if (!img) return 1;
    const pad = this.step === 'frame' ? 28 : 12;
    return Math.min((this.sw - pad * 2) / img.width, (this.sh - pad * 2) / img.height);
  }

  private scale(): number {
    return this.fit() * (this.step === 'frame' ? 1 : this.zoom);
  }

  private origin(): Pt {
    const img = this.image();
    if (!img) return { x: 0, y: 0 };
    const s = this.scale();
    const z = this.step === 'frame' ? { x: 0.5, y: 0.5 } : { x: this.cx, y: this.cy };
    return { x: this.sw / 2 - z.x * img.width * s, y: this.sh / 2 - z.y * img.height * s };
  }

  toScreen(p: Pt): Pt {
    const o = this.origin();
    const s = this.scale();
    return { x: o.x + p.x * s, y: o.y + p.y * s };
  }

  toImage(p: Pt): Pt {
    const o = this.origin();
    const s = this.scale();
    return { x: (p.x - o.x) / s, y: (p.y - o.y) / s };
  }

  private resetView(): void {
    this.zoom = 1;
    this.cx = 0.5;
    this.cy = 0.5;
  }

  /** Keep the zoomed image covering the stage (no drifting off into the void). */
  private clampView(): void {
    const img = this.image();
    if (!img) return;
    this.zoom = clamp(this.zoom, 1, IMPORT.maxZoom);
    const s = this.scale();
    const hw = this.sw / 2 / (img.width * s);
    const hh = this.sh / 2 / (img.height * s);
    this.cx = hw >= 0.5 ? 0.5 : clamp(this.cx, hw, 1 - hw);
    this.cy = hh >= 0.5 ? 0.5 : clamp(this.cy, hh, 1 - hh);
  }

  /** Zoom about a screen point (it stays under the finger). */
  private zoomAt(screen: Pt, zoom: number, anchor?: Pt): void {
    const img = this.image();
    if (!img) return;
    const a = anchor ?? this.toImage(screen);
    this.zoom = clamp(zoom, 1, IMPORT.maxZoom);
    const s = this.scale();
    this.cx = (a.x * s - screen.x + this.sw / 2) / (img.width * s);
    this.cy = (a.y * s - screen.y + this.sh / 2) / (img.height * s);
    this.clampView();
    this.draw();
  }

  private bindStage(): void {
    const st = this.stage;
    const local = (e: PointerEvent | WheelEvent): Pt => {
      const r = st.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    st.addEventListener('pointerdown', (e) => {
      if (this.step === 'photo' || this.step === 'wall' || this.step === 'frame') return;
      if ((e.target as HTMLElement).closest('.ph-corner')) return;
      e.preventDefault();
      st.setPointerCapture(e.pointerId);
      const p = local(e);
      this.pointers.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: performance.now() });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom0: this.zoom, mid, anchor: this.toImage(mid) };
        this.panning = false;
      }
    });
    st.addEventListener('pointermove', (e) => {
      const q = this.pointers.get(e.pointerId);
      if (!q) return;
      const p = local(e);
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      q.x = p.x;
      q.y = p.y;
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.zoomAt(mid, this.pinch.zoom0 * (d / this.pinch.d0), this.pinch.anchor);
        return;
      }
      if (!this.panning && Math.hypot(p.x - q.x0, p.y - q.y0) > IMPORT.tapSlop && this.zoom > 1.02) this.panning = true;
      if (this.panning) {
        const img = this.image();
        if (!img) return;
        const s = this.scale();
        this.cx -= dx / (img.width * s);
        this.cy -= dy / (img.height * s);
        this.clampView();
        this.draw();
      }
    });
    const up = (e: PointerEvent): void => {
      const q = this.pointers.get(e.pointerId);
      if (!q) return;
      this.pointers.delete(e.pointerId);
      if (st.hasPointerCapture(e.pointerId)) st.releasePointerCapture(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size === 0) this.pinch = null;
        return;
      }
      const wasPan = this.panning;
      this.panning = false;
      if (e.type === 'pointercancel' || wasPan) return;
      const p = local(e);
      if (Math.hypot(p.x - q.x0, p.y - q.y0) > IMPORT.tapSlop) return;
      // double tap: zoom in (or back out)
      const now = performance.now();
      if (now - this.lastTap.t < 300 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
        this.lastTap.t = 0;
        this.zoomAt(p, this.zoom > 1.4 ? 1 : 2.6);
        return;
      }
      this.lastTap = { t: now, x: p.x, y: p.y };
      this.tap(p);
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener(
      'wheel',
      (e) => {
        if (this.step === 'photo' || this.step === 'wall' || this.step === 'frame') return;
        e.preventDefault();
        this.zoomAt(local(e), this.zoom * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    // desktop: drop a photo anywhere on the importer
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.el.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      if (f.type.startsWith('image/')) void this.loadFile(f);
    });
  }

  /** A tap on the stage (css px). Public for the QA harness. */
  tap(screen: Pt): void {
    const p = this.toImage(screen);
    if (!this.rect || p.x < 0 || p.y < 0 || p.x > this.rectW || p.y > this.rectH) return;
    if (this.step === 'color') void this.pickColor(p, screen);
    else if (this.step === 'holds') void this.tapHolds(p);
    else if (this.step === 'roles') this.tapRoles(p);
  }

  private placeCorners(): void {
    const on = this.step === 'frame' && !!this.quad;
    for (let i = 0; i < 4; i++) {
      const c = this.corners[i];
      c.hidden = !on;
      if (!on) continue;
      const p = this.toScreen(this.quad![i]);
      c.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
  }

  // ═══════════════════════════════ loupe ═══════════════════════════════

  private showCornerLoupe(i: number): void {
    if (!this.quad || !this.photo) return;
    const at = this.quad[i];
    const scr = this.toScreen(at);
    this.drawLoupe(this.photo, at, scr, 3.2 * this.scale(), (g, k, cx, cy) => {
      // the quad's edges through this corner
      g.strokeStyle = 'rgba(213, 64, 81, 0.95)';
      g.lineWidth = 2;
      g.beginPath();
      const a = this.quad![(i + 3) % 4];
      const b = this.quad![(i + 1) % 4];
      g.moveTo(cx + (a.x - at.x) * k, cy + (a.y - at.y) * k);
      g.lineTo(cx, cy);
      g.lineTo(cx + (b.x - at.x) * k, cy + (b.y - at.y) * k);
      g.stroke();
    });
  }

  private showTapLoupe(p: Pt, screen: Pt, hex: string): void {
    if (!this.rect) return;
    this.drawLoupe(this.rect, p, screen, Math.max(4, 4 * this.scale()), (g, k, cx, cy) => {
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, Math.max(6, 3.5 * k), 0, Math.PI * 2);
      g.stroke();
    });
    this.loupe.style.setProperty('--sw', hex);
    this.loupe.classList.add('tinted');
    if (this.loupeTimer) clearTimeout(this.loupeTimer);
    this.loupeTimer = setTimeout(() => this.hideLoupe(), 1300);
  }

  /** Draw a magnified circle of `src` around `at` (image px), floating above `screen`. */
  private drawLoupe(src: HTMLCanvasElement, at: Pt, screen: Pt, mag: number, extra: (g: CanvasRenderingContext2D, k: number, cx: number, cy: number) => void): void {
    const size = 128;
    const dpr = this.dpr;
    if (this.loupe.width !== size * dpr) {
      this.loupe.width = this.loupe.height = size * dpr;
    }
    const g = this.loupe.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#0d0e10';
    g.fillRect(0, 0, size, size);
    const k = mag; // screen px per image px inside the loupe
    g.imageSmoothingEnabled = k < 6;
    g.drawImage(src, at.x - size / 2 / k, at.y - size / 2 / k, size / k, size / k, 0, 0, size, size);
    extra(g, k, size / 2, size / 2);
    // crosshair
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(size / 2 - 9, size / 2);
    g.lineTo(size / 2 - 3, size / 2);
    g.moveTo(size / 2 + 3, size / 2);
    g.lineTo(size / 2 + 9, size / 2);
    g.moveTo(size / 2, size / 2 - 9);
    g.lineTo(size / 2, size / 2 - 3);
    g.moveTo(size / 2, size / 2 + 3);
    g.lineTo(size / 2, size / 2 + 9);
    g.stroke();
    g.restore();
    // float above the finger, flipped below near the top, kept inside the stage
    let x = screen.x - size / 2;
    let y = screen.y - size - 46;
    if (y < 6) y = screen.y + 46;
    x = clamp(x, 6, this.sw - size - 6);
    y = clamp(y, 6, this.sh - size - 6);
    this.loupe.style.transform = `translate(${x}px, ${y}px)`;
    this.loupe.classList.remove('tinted');
    this.loupe.classList.add('on');
  }

  private hideLoupe(): void {
    this.loupe.classList.remove('on');
  }

  // ═══════════════════════════════ drawing ═══════════════════════════════

  draw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.paint();
    });
  }

  private paint(): void {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.sw, this.sh);
    const img = this.image();
    if (!img) return;
    const o = this.origin();
    const s = this.scale();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (this.step === 'frame') return this.paintFrame(img, o, s);
    if (this.step === 'color') {
      g.drawImage(img, o.x, o.y, img.width * s, img.height * s);
      for (const sw of this.swatches) {
        if (!sw.at) continue;
        const p = this.toScreen(sw.at);
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(13,14,16,0.85)';
        g.beginPath();
        g.arc(p.x, p.y, 11, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = 2;
        g.strokeStyle = sw.neg ? '#ff8a66' : '#fff';
        g.stroke();
        if (sw.neg) {
          g.beginPath();
          g.moveTo(p.x - 6, p.y + 6);
          g.lineTo(p.x + 6, p.y - 6);
          g.stroke();
        }
      }
      return;
    }
    // HOLDS / START: the wall dimmed, the problem's colour lit
    g.drawImage(img, o.x, o.y, img.width * s, img.height * s);
    g.fillStyle = 'rgba(10, 11, 13, 0.64)';
    g.fillRect(o.x, o.y, img.width * s, img.height * s);
    if (this.spot) g.drawImage(this.spot, o.x, o.y, img.width * s, img.height * s);
    const inc = this.included();
    const roles = this.step === 'roles' ? this.resolveRoles() : null;
    // set-aside regions: dimmed back down, dashed
    for (const h of this.holds) {
      if (h.included) continue;
      const path = this.hullPath(h, 3);
      if (!h.manual) {
        g.fillStyle = 'rgba(10, 11, 13, 0.6)';
        g.fill(path);
      }
      g.setLineDash([4, 4]);
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(246, 244, 239, 0.55)';
      g.stroke(path);
      g.setLineDash([]);
      if (h.kind !== 'hold' && this.step === 'holds') this.tag(h, h.kind === 'tape' ? 'TAPE' : 'VOLUME', 'ghost', true);
    }
    inc.forEach((h, i) => {
      const path = this.hullPath(h, 3.5);
      if (h.manual || !this.spot) {
        g.fillStyle = 'rgba(246, 244, 239, 0.14)';
        g.fill(path);
      }
      const isStart = roles?.starts.includes(i) ?? false;
      const isTop = roles?.top === i;
      g.lineWidth = isStart || isTop ? 3 : 1.6;
      g.strokeStyle = isStart || isTop ? '#d54051' : h.source === 'claude' && h.manual ? '#9ad4de' : 'rgba(255,255,255,0.92)';
      g.shadowColor = 'rgba(0,0,0,0.6)';
      g.shadowBlur = 4;
      g.stroke(path);
      g.shadowBlur = 0;
      if (this.step === 'holds') this.badge(h, String(i + 1), h.source === 'claude' && !!h.manual);
      else if (isTop) this.tag(h, 'TOP', 'pink');
      else if (isStart) this.tag(h, roles!.starts.length > 1 ? `START ${roles!.starts.indexOf(i) + 1}` : 'START', 'pink');
    });
  }

  private paintFrame(img: HTMLCanvasElement, o: Pt, s: number): void {
    const g = this.g;
    g.drawImage(img, o.x, o.y, img.width * s, img.height * s);
    if (!this.quad) return;
    const q = this.quad.map((p) => this.toScreen(p));
    // dim outside the wall
    g.fillStyle = 'rgba(8, 9, 10, 0.62)';
    g.beginPath();
    g.rect(0, 0, this.sw, this.sh);
    g.moveTo(q[0].x, q[0].y);
    for (let i = 3; i >= 0; i--) g.lineTo(q[i].x, q[i].y);
    g.closePath();
    g.fill('evenodd');
    // the wall plane: a perspective grid through the corners
    const m = rectToPhoto(this.quad, 1, 1);
    if (m) {
      g.strokeStyle = 'rgba(246, 244, 239, 0.28)';
      g.lineWidth = 1;
      g.beginPath();
      for (let k = 1; k < 4; k++) {
        const t = k / 4;
        const a = this.toScreen(applyH(m, t, 0));
        const b = this.toScreen(applyH(m, t, 1));
        const c = this.toScreen(applyH(m, 0, t));
        const d = this.toScreen(applyH(m, 1, t));
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.moveTo(c.x, c.y);
        g.lineTo(d.x, d.y);
      }
      g.stroke();
    }
    g.strokeStyle = '#d54051';
    g.lineWidth = 2.2;
    g.shadowColor = 'rgba(213, 64, 81, 0.55)';
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(q[i].x, q[i].y);
    g.closePath();
    g.stroke();
    g.shadowBlur = 0;
    // floor / top labels along the edges
    g.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
    g.fillStyle = 'rgba(246, 244, 239, 0.86)';
    g.textAlign = 'center';
    const lbl = (a: Pt, b: Pt, text: string, dy: number): void => {
      g.save();
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + dy);
      g.rotate(Math.atan2(b.y - a.y, b.x - a.x));
      g.fillText(text, 0, 0);
      g.restore();
    };
    lbl(q[0], q[1], 'TOP OF WALL', -9);
    lbl(q[3], q[2], 'FLOOR', 17);
  }

  /** Hull path in screen space, grown by `grow` css px. */
  private hullPath(h: PhotoHold, grow: number): Path2D {
    const p = new Path2D();
    const s = this.scale();
    const n = h.hull.length / 2;
    if (n < 3) {
      const c = this.toScreen(h);
      p.arc(c.x, c.y, (h.major / 2) * s + grow, 0, Math.PI * 2);
      return p;
    }
    for (let i = 0; i < n; i++) {
      const x = h.hull[i * 2];
      const y = h.hull[i * 2 + 1];
      const dx = x - h.x;
      const dy = y - h.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = this.toScreen({ x, y });
      const px = sp.x + (dx / d) * grow;
      const py = sp.y + (dy / d) * grow;
      if (i) p.lineTo(px, py);
      else p.moveTo(px, py);
    }
    p.closePath();
    return p;
  }

  private topRight(h: PhotoHold): Pt {
    const s = this.scale();
    const c = this.toScreen(h);
    const r = Math.max(6, (h.major / 2) * s);
    return { x: c.x + r * 0.72 + 4, y: c.y - r * 0.72 - 4 };
  }

  private badge(h: PhotoHold, text: string, claude: boolean): void {
    const g = this.g;
    const p = this.topRight(h);
    g.font = "700 10px 'JetBrains Mono', ui-monospace, monospace";
    const w = Math.max(16, g.measureText(text).width + 8);
    g.fillStyle = claude ? '#9ad4de' : '#f6f4ef';
    roundRect(g, p.x - w / 2, p.y - 8, w, 16, 8);
    g.fill();
    g.fillStyle = '#0d0e10';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, p.x, p.y + 0.5);
    g.textBaseline = 'alphabetic';
  }

  private tag(h: PhotoHold, text: string, style: 'pink' | 'ghost', below = false): void {
    const g = this.g;
    let p = this.topRight(h);
    if (below) {
      // set-aside regions label under themselves, clear of the numbered holds' badges
      const c = this.toScreen(h);
      const r = Math.max(6, (h.major / 2) * this.scale());
      p = { x: c.x + r * 0.4, y: c.y + r + 12 };
    }
    g.font = "700 10px 'JetBrains Mono', ui-monospace, monospace";
    const w = g.measureText(text).width + 12;
    g.fillStyle = style === 'pink' ? '#d54051' : 'rgba(13, 14, 16, 0.86)';
    roundRect(g, p.x - 6, p.y - 9, w, 18, 5);
    g.fill();
    if (style === 'ghost') {
      g.strokeStyle = 'rgba(246,244,239,0.4)';
      g.lineWidth = 1;
      g.stroke();
    }
    g.fillStyle = style === 'pink' ? '#fff' : 'rgba(246,244,239,0.86)';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(text, p.x, p.y + 0.5);
    g.textBaseline = 'alphabetic';
  }

  // ═══════════════════════════════ misc ═══════════════════════════════

  private setBusy(text: string): void {
    setText(this.busyText, text);
    toggle(this.busy, 'on', !!text);
  }

  private say(text: string): void {
    setText(this.live, text);
  }

  private reduced(): boolean {
    return this.opts.root.classList.contains('reduced-motion') || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function holdOf(b: PhotoBlob, included: boolean): ImportHold {
  return { x: b.x, y: b.y, major: b.major, minor: b.minor, theta: b.theta, solidity: b.solidity, pocket: b.pocket, kind: b.kind, hull: b.hull, manual: b.manual, source: 'cv', included };
}

/** The straightened image cut out to the detected pixels (drawn over the dimmed wall). */
function spotlight(rect: HTMLCanvasElement, mask: Uint8Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = rect.width;
  c.height = rect.height;
  const g = c.getContext('2d')!;
  g.drawImage(rect, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < mask.length; i++) d[i * 4 + 3] = mask[i] ? 255 : 0;
  g.putImageData(img, 0, 0);
  return c;
}

/** Decode an image file with its EXIF orientation applied, downscaled to `long` px on its long edge. */
export async function decodePhoto(file: Blob, long: number): Promise<{ canvas: HTMLCanvasElement; srcW: number; srcH: number }> {
  let src: ImageBitmap | HTMLImageElement;
  let w: number;
  let h: number;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    h = src.height;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      src = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('decode'));
        im.src = url;
      });
      w = src.naturalWidth;
      h = src.naturalHeight;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  if (!w || !h) throw new Error('empty image');
  const k = Math.min(1, long / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  if ('close' in src) src.close();
  return { canvas: c, srcW: w, srcH: h };
}

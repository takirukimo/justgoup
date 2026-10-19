// The editor's DOM: top bar (close, name, undo/redo), status row (problem check chip, TEST,
// PUBLISH), a checklist popover, a floating inspector for the selected hold, pop-up drawers
// (route colour, wall angle, problem menu) and the bottom tray (tools, role selector, hold palette).
// Pure view: it renders EditorPanelState and reports intents through PanelActions.
// Built from the UI design system (src/ui/dom.ts helpers, .btn / .seg / .range / .grade / .t-label).

import type { HoldDef, HoldType, WallPanel } from '../core/types';
import { clamp } from '../core/math';
import { GAME } from '../config/tuning';
import { ROUTE_COLORS } from '../config/brand';
import { fontGrade, gradeColor, gradeLabel } from '../game/grades';
import { button, el, label, setText, toggle } from '../ui/dom';
import { wallLabel } from '../ui/format';
import { icon } from '../ui/icons';
import { glyph, holdGlyph, type EditorGlyph } from './glyphs';
import { EDIT_ROLES, EDITOR, HOLD_TYPES, ROLE_LABEL, SIZE_RANGE, TYPE_LABEL, type DraftCheck, type EditRole } from './model';

export type Drawer = 'color' | 'angle' | 'more';

export type StatusKind = 'empty' | 'invalid' | 'solving' | 'ok' | 'nobeta' | 'sent' | 'live';

export interface EditorPanelState {
  name: string;
  canUndo: boolean;
  canRedo: boolean;
  status: StatusKind;
  grade: number | null;
  check: DraftCheck;
  checkOpen: boolean;
  betaAvailable: boolean;
  betaOn: boolean;
  canTest: boolean;
  canPublish: boolean;
  published: boolean;
  type: HoldType;
  role: EditRole;
  color: string;
  angle: number;
  /** Multi-angle panels of the draft's wall (a generated sample), if any. */
  profile?: WallPanel[];
  snap: boolean;
  drawer: Drawer | null;
  sampleGrade: number;
  generating: boolean;
  /** Selected hold and its 1-based index in the draft. */
  selection: { hold: HoldDef; index: number } | null;
}

export interface PanelActions {
  close(): void;
  undo(): void;
  redo(): void;
  rename(name: string): void;
  renameCommit(): void;
  test(): void;
  publish(): void;
  toggleCheck(): void;
  toggleBeta(): void;
  pickType(t: HoldType): void;
  pickRole(r: EditRole): void;
  pickColor(hex: string): void;
  angleInput(deg: number): void;
  angleCommit(deg: number): void;
  toggleSnap(): void;
  setDrawer(d: Drawer | null): void;
  newDraft(): void;
  sampleGrade(delta: number): void;
  loadSample(): void;
  clearAll(): void;
  sizeStart(): void;
  sizeInput(v: number): void;
  sizeCommit(): void;
  rotate(dir: -1 | 1): void;
  reshape(): void;
  deleteSelected(): void;
  deselect(): void;
}

/** Relative luminance (0..1) of a #rrggbb colour. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const ch = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

const colorName = (hex: string): string => ROUTE_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? 'Custom';

function gbtn(g: EditorGlyph, aria: string, cls: string, onTap: () => void, variant: 'icon' | 'glass' | 'danger' = 'icon'): HTMLButtonElement {
  const b = button({ variant, cls, aria, onTap });
  b.prepend(glyph(g, 'btn-ic'));
  return b;
}

const setVar = (e: HTMLElement, k: string, v: string): void => {
  if (e.style.getPropertyValue(k) !== v) e.style.setProperty(k, v);
};

export class EditorPanel {
  readonly el: HTMLElement;
  /** Gesture surface behind every control (touches on the wall). */
  readonly surface: HTMLElement;
  readonly top: HTMLElement;
  readonly tray: HTMLElement;
  readonly bottom: HTMLElement;
  readonly toasts: HTMLElement;

  private nameIn: HTMLInputElement;
  private kicker: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private chip: HTMLButtonElement;
  private chipBadge: HTMLElement;
  private chipKick: HTMLElement;
  private chipVal: HTMLElement;
  private testBtn: HTMLButtonElement;
  private pubBtn: HTMLButtonElement;
  private pubLbl: HTMLElement;
  private pubIc: HTMLElement;
  private check: HTMLElement;
  private checkList: HTMLElement;
  private checkCount: HTMLElement;
  private betaRow: HTMLButtonElement;
  private checkNote: HTMLElement;

  private insp: HTMLElement;
  private inspIc: HTMLElement;
  private inspKick: HTMLElement;
  private inspName: HTMLElement;
  private inspRole: HTMLElement;
  private inspXY: HTMLElement;
  private sizeIn: HTMLInputElement;
  private sizeVal: HTMLElement;
  private drawers: Record<Drawer, HTMLElement>;
  private swatches: HTMLButtonElement[] = [];
  private angleIn: HTMLInputElement;
  private angleVal: HTMLElement;
  private angleWord: HTMLElement;
  private profile!: { wall: SVGPolylineElement; arc: SVGPathElement; dots: SVGCircleElement[] };
  private sampleVal: HTMLElement;
  private sampleBtn: HTMLButtonElement;

  private toolColor: HTMLButtonElement;
  private toolColorSw: HTMLElement;
  private toolColorTx: HTMLElement;
  private toolAngle: HTMLButtonElement;
  private toolAngleTx: HTMLElement;
  private toolSnap: HTMLButtonElement;
  private toolSnapTx: HTMLElement;
  private toolSnapIc: HTMLElement;
  private toolMore: HTMLButtonElement;
  private roles: HTMLElement;
  private roleBtns = new Map<EditRole, HTMLButtonElement>();
  private tiles = new Map<HoldType, HTMLButtonElement>();

  private last: Partial<Record<string, string>> = {};
  private nameFocused = false;

  constructor(private a: PanelActions) {
    this.surface = el('div', 'ed-surface');

    // ── top bar ──
    this.nameIn = el('input', 'ed-name-in');
    this.nameIn.type = 'text';
    this.nameIn.maxLength = EDITOR.nameMax;
    this.nameIn.spellcheck = false;
    this.nameIn.autocomplete = 'off';
    this.nameIn.setAttribute('autocapitalize', 'words');
    this.nameIn.setAttribute('enterkeyhint', 'done');
    this.nameIn.setAttribute('aria-label', 'Problem name');
    this.nameIn.addEventListener('input', () => a.rename(this.nameIn.value));
    this.nameIn.addEventListener('focus', () => (this.nameFocused = true));
    this.nameIn.addEventListener('blur', () => {
      this.nameFocused = false;
      a.renameCommit();
    });
    this.nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') this.nameIn.blur();
      e.stopPropagation();
    });
    this.kicker = label('SETTER · DRAFT', 'ed-name-k');
    const nameBox = el('label', 'ed-name', this.kicker, this.nameIn, icon('edit', 'ed-name-ic'));
    this.undoBtn = gbtn('undo', 'Undo', 'ed-hbtn', () => a.undo());
    this.redoBtn = gbtn('redo', 'Redo', 'ed-hbtn', () => a.redo());
    const close = button({ icon: 'close', variant: 'icon', cls: 'ed-x', aria: 'Close editor', onTap: () => a.close() });
    const bar = el('div', 'ed-bar', close, nameBox, el('div', 'ed-hist', this.undoBtn, el('i', 'ed-hist-sep'), this.redoBtn));

    // ── status row ──
    this.chipBadge = el('span', 'ed-chip-badge');
    this.chipKick = label('PROBLEM CHECK', 'ed-chip-k');
    this.chipVal = el('span', 'ed-chip-v');
    this.chip = el('button', 'ed-chip', this.chipBadge, el('span', 'ed-chip-txt', this.chipKick, this.chipVal));
    this.chip.type = 'button';
    this.chip.setAttribute('aria-haspopup', 'true');
    this.chip.addEventListener('click', () => a.toggleCheck());
    this.testBtn = button({ label: 'TEST', icon: 'play', variant: 'glass', cls: 'ed-test', onTap: () => a.test() });
    this.pubIc = el('span', 'ed-pub-ic');
    this.pubLbl = el('span', 'btn-lbl', 'PUBLISH');
    this.pubBtn = el('button', 'btn btn-primary ed-pub', this.pubIc, this.pubLbl);
    this.pubBtn.type = 'button';
    this.pubBtn.setAttribute('aria-label', 'Publish');
    this.pubBtn.addEventListener('click', () => {
      if (!this.pubBtn.disabled) a.publish();
    });
    const row2 = el('div', 'ed-row2', this.chip, this.testBtn, this.pubBtn);

    // ── checklist popover ──
    this.checkList = el('ul', 'ed-check-list');
    this.checkCount = label('', 'ed-check-count');
    this.betaRow = el('button', 'ed-beta-row', glyph('beta', 'ed-beta-ic'), el('span', 'ed-beta-tx', 'Show beta'), el('span', 'switch', el('i', 'switch-knob')));
    this.betaRow.type = 'button';
    this.betaRow.addEventListener('click', () => a.toggleBeta());
    this.checkNote = el('p', 'ed-check-note');
    this.check = el('div', 'ed-check', el('div', 'ed-check-h', label('PROBLEM CHECK'), this.checkCount), this.checkList, this.betaRow, this.checkNote);

    this.top = el('header', 'ed-top', bar, row2, this.check);
    this.toasts = el('div', 'ed-toasts');
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');

    // ── inspector ──
    this.inspIc = el('span', 'ed-insp-ic');
    this.inspKick = label('', 'ed-insp-k');
    this.inspName = el('b', 'ed-insp-name');
    this.inspRole = el('span', 'ed-insp-role');
    this.inspXY = el('span', 'ed-insp-xy t-num');
    const done = button({ icon: 'check', variant: 'icon', cls: 'ed-insp-done', aria: 'Done', onTap: () => a.deselect() });
    this.sizeIn = el('input', 'range ed-size-in');
    this.sizeIn.type = 'range';
    this.sizeIn.min = '0';
    this.sizeIn.max = '1000';
    this.sizeIn.step = '1';
    this.sizeIn.setAttribute('aria-label', 'Hold size');
    this.sizeIn.addEventListener('pointerdown', () => a.sizeStart());
    this.sizeIn.addEventListener('keydown', () => a.sizeStart());
    this.sizeIn.addEventListener('input', () => a.sizeInput(Number(this.sizeIn.value) / 1000));
    this.sizeIn.addEventListener('change', () => a.sizeCommit());
    this.sizeVal = el('span', 'ed-size-v t-num');
    this.insp = el(
      'section',
      'ed-insp ed-float-card',
      el('div', 'ed-insp-h', this.inspIc, el('div', 'ed-insp-t', this.inspKick, el('div', 'ed-insp-line', this.inspName, this.inspRole)), this.inspXY, done),
      el(
        'div',
        'ed-insp-row',
        gbtn('rotL', 'Rotate left 15°', 'ed-ibtn', () => a.rotate(1)),
        el('div', 'ed-size', el('div', 'ed-size-h', label('SIZE'), this.sizeVal), this.sizeIn),
        gbtn('rotR', 'Rotate right 15°', 'ed-ibtn', () => a.rotate(-1)),
        gbtn('shape', 'New shape', 'ed-ibtn', () => a.reshape()),
        gbtn('clear', 'Delete hold', 'ed-ibtn ed-del', () => a.deleteSelected(), 'danger'),
      ),
    );

    // ── drawers ──
    const sw = el('div', 'ed-swatches');
    for (const c of ROUTE_COLORS) {
      const b = el('button', 'ed-sw');
      b.type = 'button';
      b.style.setProperty('--sw', c.hex);
      b.setAttribute('aria-label', c.name);
      b.dataset.hex = c.hex;
      b.addEventListener('click', () => a.pickColor(c.hex));
      this.swatches.push(b);
      sw.appendChild(b);
    }
    const drColor = el('div', 'ed-drawer ed-float-card', el('div', 'ed-dr-h', label('ROUTE COLOUR'), label('ALL HOLDS', 'ed-dr-hint')), sw);

    this.angleIn = el('input', 'range ed-angle-in');
    this.angleIn.type = 'range';
    this.angleIn.min = String(EDITOR.angleMin);
    this.angleIn.max = String(EDITOR.angleMax);
    this.angleIn.step = '1';
    this.angleIn.setAttribute('aria-label', 'Wall angle');
    this.angleIn.addEventListener('input', () => a.angleInput(Number(this.angleIn.value)));
    this.angleIn.addEventListener('change', () => a.angleCommit(Number(this.angleIn.value)));
    this.angleVal = el('span', 'ed-angle-v');
    this.angleWord = label('', 'ed-angle-w');
    const ticks = el('div', 'ed-ticks');
    for (const t of [-10, 0, 15, 30, 45]) {
      const tk = el('span', 'ed-tick', `${t}°`);
      tk.style.setProperty('--p', String((t - EDITOR.angleMin) / (EDITOR.angleMax - EDITOR.angleMin)));
      ticks.appendChild(tk);
    }
    const drAngle = el(
      'div',
      'ed-drawer ed-float-card',
      el('div', 'ed-dr-h', label('WALL ANGLE'), this.angleWord),
      el('div', 'ed-angle-row', this.buildProfile(), this.angleVal, el('div', 'ed-angle-slider', this.angleIn, ticks)),
    );

    this.sampleVal = el('span', 'ed-sample-v');
    this.sampleBtn = button({ label: 'LOAD', variant: 'glass', cls: 'ed-sample-go', onTap: () => a.loadSample() });
    const drMore = el(
      'div',
      'ed-drawer ed-float-card',
      el('div', 'ed-dr-h', label('PROBLEM'), label('REMIX A GENERATED LINE', 'ed-dr-hint')),
      el(
        'div',
        'ed-sample',
        glyph('sample', 'ed-sample-ic'),
        el('div', 'ed-sample-t', el('span', 'ed-sample-l', 'Load sample'), label('PICK A GRADE')),
        el(
          'div',
          'ed-stepper',
          gbtn('minus', 'Easier', 'ed-step', () => a.sampleGrade(-1)),
          this.sampleVal,
          gbtn('plus', 'Harder', 'ed-step', () => a.sampleGrade(1)),
        ),
        this.sampleBtn,
      ),
      el(
        'div',
        'ed-more-row',
        (() => {
          const b = button({ label: 'NEW', variant: 'glass', cls: 'ed-more-btn', onTap: () => a.newDraft() });
          b.prepend(glyph('newDoc', 'btn-ic'));
          return b;
        })(),
        (() => {
          const b = button({ label: 'CLEAR ALL', variant: 'danger', cls: 'ed-more-btn', onTap: () => a.clearAll() });
          b.prepend(glyph('clear', 'btn-ic'));
          return b;
        })(),
      ),
    );
    this.drawers = { color: drColor, angle: drAngle, more: drMore };
    const float = el('div', 'ed-float', this.insp, drColor, drAngle, drMore);

    // ── tray ──
    this.toolColorSw = el('span', 'ed-tool-sw');
    this.toolColorTx = el('span', 'ed-tool-tx');
    this.toolColor = el('button', 'ed-tool ed-tool-color', this.toolColorSw, this.toolColorTx);
    this.toolAngleTx = el('span', 'ed-tool-tx t-num');
    this.toolAngle = el('button', 'ed-tool ed-tool-angle', icon('angle', 'ed-tool-ic'), this.toolAngleTx);
    this.toolSnapIc = el('span', 'ed-tool-icw');
    this.toolSnapTx = el('span', 'ed-tool-tx');
    this.toolSnap = el('button', 'ed-tool ed-tool-snap', this.toolSnapIc, this.toolSnapTx);
    this.toolMore = el('button', 'ed-tool ed-tool-more', glyph('more', 'ed-tool-ic'));
    for (const [b, aria] of [
      [this.toolColor, 'Route colour'],
      [this.toolAngle, 'Wall angle'],
      [this.toolSnap, 'Snap to T-nuts'],
      [this.toolMore, 'Problem menu'],
    ] as const) {
      b.type = 'button';
      b.setAttribute('aria-label', aria);
    }
    this.toolColor.addEventListener('click', () => a.setDrawer(this.last.drawer === 'color' ? null : 'color'));
    this.toolAngle.addEventListener('click', () => a.setDrawer(this.last.drawer === 'angle' ? null : 'angle'));
    this.toolMore.addEventListener('click', () => a.setDrawer(this.last.drawer === 'more' ? null : 'more'));
    this.toolSnap.addEventListener('click', () => a.toggleSnap());
    const tools = el('div', 'ed-tools', this.toolColor, this.toolAngle, this.toolSnap, this.toolMore);

    this.roles = el('div', 'seg seg-sm ed-roles', el('span', 'seg-ind'));
    this.roles.style.setProperty('--n', String(EDIT_ROLES.length));
    for (const r of EDIT_ROLES) {
      const b = el('button', `btn btn-plain seg-btn ed-role ed-role-${r}`, el('i', 'ed-role-mk'), el('span', null, ROLE_LABEL[r]));
      b.type = 'button';
      b.addEventListener('click', () => a.pickRole(r));
      this.roleBtns.set(r, b);
      this.roles.appendChild(b);
    }

    const palette = el('div', 'ed-palette');
    for (const t of HOLD_TYPES) {
      const b = el('button', 'ed-tile', holdGlyph(t), el('span', 'ed-tile-l', t === 'foot' ? 'FOOT' : TYPE_LABEL[t].toUpperCase()));
      b.type = 'button';
      b.setAttribute('aria-label', TYPE_LABEL[t]);
      b.addEventListener('click', () => a.pickType(t));
      this.tiles.set(t, b);
      palette.appendChild(b);
    }

    this.tray = el('footer', 'ed-tray', tools, this.roles, palette);
    this.bottom = el('div', 'ed-bottom', float, this.tray);
    this.el = el('div', 'ed', this.surface, this.top, this.toasts, this.bottom);
  }

  /** Side-profile diagram of the wall angle (live while the slider moves; the 3D wall rebuilds on rest). */
  private buildProfile(): SVGSVGElement {
    const NS = 'http://www.w3.org/2000/svg';
    const mk = <K extends keyof SVGElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
      const e = document.createElementNS(NS, tag);
      e.setAttribute('class', cls);
      for (const k in attrs) e.setAttribute(k, String(attrs[k]));
      return e;
    };
    const svgEl = mk('svg', 'ed-profile', { viewBox: '0 0 64 56', 'aria-hidden': 'true' });
    const wall = mk('polyline', 'pf-wall', { points: '18,50 18,6' });
    const arc = mk('path', 'pf-arc');
    const dots = [0.35, 0.6, 0.85].map(() => mk('circle', 'pf-hold', { r: 2.1 }));
    svgEl.append(
      mk('line', 'pf-ref', { x1: 18, y1: 50, x2: 18, y2: 4 }),
      mk('rect', 'pf-pad', { x: 28, y: 45.5, width: 32, height: 4.5, rx: 1 }),
      mk('line', 'pf-stripe', { x1: 29, y1: 45.6, x2: 59, y2: 45.6 }),
      mk('line', 'pf-floor', { x1: 2, y1: 50.5, x2: 62, y2: 50.5 }),
      arc,
      wall,
      ...dots,
    );
    this.profile = { wall, arc, dots };
    return svgEl;
  }

  /** Side view: one line at `angle`, or the folded panels of a multi-angle wall (arc = steepest). */
  private renderProfile(angle: number, panels?: readonly WallPanel[]): void {
    const p = this.profile;
    const t = (angle * Math.PI) / 180;
    const L = 44;
    // the wall as a polyline from its foot (18, 50): one segment, or every panel at its own angle
    const pts: { x: number; y: number; a: number }[] = [{ x: 18, y: 50, a: t }];
    if (panels && panels.length >= 2) {
      const total = Math.max(GAME.boulderWall.height, panels[panels.length - 1].y0 + 0.3);
      for (let i = 0; i < panels.length; i++) {
        const len = ((i + 1 < panels.length ? panels[i + 1].y0 : total) - panels[i].y0) * (L / total);
        const a = (clamp(panels[i].angle, -30, 95) * Math.PI) / 180;
        const q = pts[pts.length - 1];
        pts.push({ x: q.x + Math.sin(a) * len, y: q.y - Math.cos(a) * len, a });
      }
    } else pts.push({ x: 18 + Math.sin(t) * L, y: 50 - Math.cos(t) * L, a: t });
    p.wall.setAttribute('points', pts.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' '));
    const R = 15;
    const ax = 18 + Math.sin(t) * R;
    const ay = 50 - Math.cos(t) * R;
    p.arc.setAttribute('d', `M18 ${50 - R}A${R} ${R} 0 0 ${angle >= 0 ? 1 : 0} ${ax.toFixed(2)} ${ay.toFixed(2)}`);
    // holds sit on the climbing side of the wall, along its length
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    [0.35, 0.6, 0.85].forEach((k, i) => {
      let left = k * total;
      let j = 1;
      for (; j < pts.length - 1; j++) {
        const seg = Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y);
        if (left <= seg) break;
        left -= seg;
      }
      const a = pts[j - 1];
      const b = pts[j];
      const seg = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
      const f = Math.min(1, left / seg);
      const d = p.dots[i];
      d.setAttribute('cx', (a.x + (b.x - a.x) * f + Math.cos(b.a) * 2.6).toFixed(2));
      d.setAttribute('cy', (a.y + (b.y - a.y) * f + Math.sin(b.a) * 2.6).toFixed(2));
    });
  }

  /** Overlay SVG goes between the gesture surface and the controls. */
  mountOverlay(svgEl: SVGSVGElement): void {
    this.el.insertBefore(svgEl, this.top);
  }

  private changed(key: string, v: string): boolean {
    if (this.last[key] === v) return false;
    this.last[key] = v;
    return true;
  }

  render(s: EditorPanelState): void {
    // name
    if (!this.nameFocused && this.nameIn.value !== s.name) this.nameIn.value = s.name;
    setText(this.kicker, s.grade !== null && (s.status === 'ok' || s.status === 'sent' || s.status === 'live') ? `SETTER · DRAFT · ${gradeLabel(s.grade)}` : 'SETTER · DRAFT');
    this.undoBtn.disabled = !s.canUndo;
    this.redoBtn.disabled = !s.canRedo;

    this.renderStatus(s);
    this.renderCheck(s);

    this.testBtn.disabled = !s.canTest;
    this.pubBtn.disabled = !s.canPublish;
    const pubKey = s.published ? 'live' : s.canPublish ? 'ready' : 'locked';
    if (this.changed('pub', pubKey)) {
      this.pubIc.replaceChildren(icon(s.published ? 'check' : s.canPublish ? 'globe' : 'lock', 'btn-ic'));
      setText(this.pubLbl, s.published ? 'LIVE' : 'PUBLISH');
      toggle(this.pubBtn, 'is-ready', s.canPublish);
      toggle(this.pubBtn, 'is-live', s.published);
    }

    // tray: tools
    setVar(this.el, '--route', s.color);
    if (this.changed('color', s.color)) {
      setText(this.toolColorTx, colorName(s.color).toUpperCase());
      toggle(this.el, 'route-dark', luminance(s.color) < 0.05);
    }
    setText(this.toolAngleTx, `${s.angle > 0 ? '+' : ''}${s.angle}°`);
    if (this.changed('snap', String(s.snap))) {
      this.toolSnapIc.replaceChildren(glyph(s.snap ? 'snap' : 'free', 'ed-tool-ic'));
      setText(this.toolSnapTx, s.snap ? 'SNAP' : 'FREE');
      toggle(this.toolSnap, 'on', s.snap);
      this.toolSnap.setAttribute('aria-pressed', String(s.snap));
    }
    toggle(this.toolColor, 'open', s.drawer === 'color');
    toggle(this.toolAngle, 'open', s.drawer === 'angle');
    toggle(this.toolMore, 'open', s.drawer === 'more');

    // role + palette (reflect the selection while one exists)
    const sel = s.selection?.hold ?? null;
    const role: EditRole = sel ? (sel.role === 'deco' ? 'hand' : sel.role) : s.role;
    const type = sel ? sel.type : s.type;
    const ri = EDIT_ROLES.indexOf(role);
    setVar(this.roles, '--idx', String(ri));
    for (const [r, b] of this.roleBtns) {
      toggle(b, 'on', r === role);
      b.disabled = !!sel && sel.type === 'foot' && r !== 'foot';
    }
    for (const [t, b] of this.tiles) {
      toggle(b, 'on', t === type);
      b.setAttribute('aria-pressed', String(t === type));
    }
    toggle(this.tray, 'is-editing', !!sel);

    // drawers + inspector
    const floatKey = s.drawer ?? (sel ? 'insp' : '');
    if (this.changed('drawer', s.drawer ?? '')) {
      for (const k of Object.keys(this.drawers) as Drawer[]) toggle(this.drawers[k], 'open', s.drawer === k);
    }
    toggle(this.insp, 'open', floatKey === 'insp');
    for (const b of this.swatches) toggle(b, 'on', (b.dataset.hex ?? '').toLowerCase() === s.color.toLowerCase());
    // a folded wall shows its steepest panel on the slider (moving it makes one flat panel)
    const sa = clamp(s.angle, EDITOR.angleMin, EDITOR.angleMax);
    if (document.activeElement !== this.angleIn && this.angleIn.value !== String(sa)) this.angleIn.value = String(sa);
    setVar(this.angleIn, '--v', `${((sa - EDITOR.angleMin) / (EDITOR.angleMax - EDITOR.angleMin)) * 100}%`);
    const pkey = s.profile ? s.profile.map((p) => `${p.y0}:${p.angle}`).join(',') : '';
    if (this.changed('angle', `${s.angle}|${pkey}`)) {
      setText(this.angleVal, `${s.angle > 0 ? '+' : ''}${s.angle}°`);
      this.renderProfile(s.angle, s.profile);
    }
    // the same honest wall words as the route preview and the problem cards (±6° reads VERTICAL)
    const wl = wallLabel({ wallAngle: s.angle, profile: s.profile });
    setText(this.angleWord, wl.kind === 'WALL' ? wl.value : wl.kind);
    setText(this.sampleVal, gradeLabel(s.sampleGrade));
    this.sampleBtn.disabled = s.generating;
    toggle(this.sampleBtn, 'is-busy', s.generating);
    setText(this.sampleBtn.querySelector('.btn-lbl') as HTMLElement, s.generating ? 'SETTING…' : 'LOAD');

    if (sel && s.selection) this.renderInspector(sel, s.selection.index);
  }

  /** Inspector values only (cheap; called during gestures). */
  renderInspector(h: HoldDef, index: number): void {
    if (this.changed('inspType', h.type)) {
      this.inspIc.replaceChildren(holdGlyph(h.type));
      setText(this.inspName, TYPE_LABEL[h.type].toUpperCase());
    }
    setText(this.inspKick, `SELECTED · HOLD ${String(index).padStart(2, '0')}`);
    const role = h.role === 'deco' ? 'hand' : h.role;
    if (this.changed('inspRole', role)) {
      setText(this.inspRole, ROLE_LABEL[role].toUpperCase());
      this.inspRole.className = `ed-insp-role r-${role}`;
    }
    const deg = Math.round(((h.angle + Math.PI / 2) * 180) / Math.PI);
    const norm = ((((deg + 180) % 360) + 360) % 360) - 180;
    setText(this.inspXY, `X ${h.x.toFixed(2)}  Y ${h.y.toFixed(2)}  ${norm > 0 ? '+' : ''}${norm}°`);
    const range = SIZE_RANGE[h.type];
    const t = (h.size - range.min) / (range.max - range.min);
    const v = String(Math.round(Math.max(0, Math.min(1, t)) * 1000));
    if (document.activeElement !== this.sizeIn && this.sizeIn.value !== v) this.sizeIn.value = v;
    setVar(this.sizeIn, '--v', `${Math.max(0, Math.min(1, t)) * 100}%`);
    setText(this.sizeVal, `${Math.round(h.size * 200)} CM`);
  }

  private renderStatus(s: EditorPanelState): void {
    const passed = s.check.rules.filter((r) => r.ok).length;
    let kick = 'PROBLEM CHECK';
    let val = '';
    let badgeKey = s.status;
    switch (s.status) {
      case 'empty':
        kick = 'NEW PROBLEM';
        val = 'Tap the wall';
        break;
      case 'invalid':
        kick = `CHECKS ${passed}/${s.check.rules.length}`;
        val = s.check.short;
        break;
      case 'solving':
        kick = 'BETA READER';
        val = 'Reading…';
        break;
      case 'ok':
        kick = s.grade !== null ? `FONT ${fontGrade(s.grade)}` : 'BETA FOUND';
        val = 'Solvable';
        break;
      case 'nobeta':
        kick = 'BETA READER';
        val = 'No beta found';
        break;
      case 'sent':
        kick = 'TEST · SENT';
        val = 'Publish it';
        break;
      case 'live':
        kick = 'COMMUNITY';
        val = 'Live';
        break;
    }
    this.chip.dataset.status = s.status;
    setText(this.chipKick, kick);
    setText(this.chipVal, val);
    toggle(this.chipVal, 'long', val.length > 10);
    const g = s.grade;
    const showGrade = g !== null && (s.status === 'ok' || s.status === 'sent' || s.status === 'live');
    const key = `${badgeKey}:${showGrade ? g : ''}:${passed}`;
    if (this.changed('badge', key)) {
      this.chipBadge.replaceChildren();
      if (showGrade && g !== null) {
        const gr = el('span', 'grade ed-grade', el('b', null, gradeLabel(g)));
        gr.title = `Font ${fontGrade(g)}`;
        gr.style.setProperty('--g', gradeColor(g));
        this.chipBadge.appendChild(gr);
      } else if (s.status === 'solving') {
        this.chipBadge.appendChild(el('span', 'ed-spin'));
      } else if (s.status === 'nobeta') {
        this.chipBadge.appendChild(el('span', 'ed-badge-ic bad', icon('warn')));
      } else if (s.status === 'empty') {
        this.chipBadge.appendChild(el('span', 'ed-badge-ic', icon('holds')));
      } else {
        const ring = el('span', 'ed-ring', el('b', 't-num', String(passed)));
        ring.style.setProperty('--p', String(passed / s.check.rules.length));
        this.chipBadge.appendChild(ring);
      }
    }
    this.chip.setAttribute('aria-expanded', String(s.checkOpen));
    this.chip.setAttribute('aria-label', `${kick}: ${val}`);
  }

  private renderCheck(s: EditorPanelState): void {
    toggle(this.check, 'open', s.checkOpen);
    toggle(this.chip, 'open', s.checkOpen);
    if (!s.checkOpen) return;
    const key = s.check.rules.map((r) => `${r.id}${r.ok}${r.value}`).join('|');
    if (this.changed('rules', key)) {
      this.checkList.replaceChildren(
        ...s.check.rules.map((r) =>
          el('li', `ed-rule ${r.ok ? 'ok' : 'bad'}`, el('span', 'ed-rule-ic', icon(r.ok ? 'check' : 'close')), el('span', 'ed-rule-l', r.label), el('b', 'ed-rule-v t-num', r.value)),
        ),
      );
    }
    setText(this.checkCount, `${s.check.counts.total} HOLDS · ${s.check.counts.feet} FEET`);
    this.betaRow.disabled = !s.betaAvailable;
    toggle(this.betaRow, 'on', s.betaOn && s.betaAvailable);
    toggle(this.betaRow, 'row-toggle', true);
    let note: string;
    if (s.status === 'live') note = 'Live in Community. Any edit makes a new version to test and publish.';
    else if (s.status === 'sent') note = 'You sent this exact version. Publish it to the Community wall.';
    else if (!s.check.ok) note = 'Fix the checks above, then send it in a test climb to unlock Publish.';
    else if (s.status === 'nobeta') note = 'Steini’s beta reader found no sequence. Bigger footholds or a gentler angle usually help — or test it: if you send it, it goes.';
    else note = 'Send it yourself in a test climb to unlock Publish. Any edit needs a new test.';
    setText(this.checkNote, note);
  }

  /** Short toast under the top bar (reuses the UI toast look). */
  toast(text: string, tone: 'info' | 'good' | 'bad' = 'info'): void {
    while (this.toasts.children.length >= 2) this.toasts.firstElementChild?.remove();
    const t = el('div', `toast ed-toast t-${tone}`, el('i', 'toast-dot'), el('span', null, text));
    this.toasts.appendChild(t);
    setTimeout(() => {
      t.classList.add('toast-out');
      setTimeout(() => t.remove(), 260);
    }, 2200);
  }

  /** Brief attention shake on an element (e.g. TEST pressed while checks fail). */
  nudge(which: 'chip' | 'test' | 'publish'): void {
    const e = which === 'chip' ? this.chip : which === 'test' ? this.testBtn : this.pubBtn;
    e.classList.remove('bump-bad');
    void e.offsetWidth;
    e.classList.add('bump-bad');
    setTimeout(() => e.classList.remove('bump-bad'), 520);
  }

  pulsePublish(): void {
    this.pubBtn.classList.remove('ed-pulse');
    void this.pubBtn.offsetWidth;
    this.pubBtn.classList.add('ed-pulse');
  }

  /** Top edge (client px) of the floating inspector card. */
  inspectorTop(): number {
    return this.insp.getBoundingClientRect().top;
  }

  blurName(): void {
    if (this.nameFocused) this.nameIn.blur();
  }

  get editingName(): boolean {
    return this.nameFocused;
  }
}

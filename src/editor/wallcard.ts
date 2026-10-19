// The WALL drawer: wall-type presets (research §3.2) and a live side-view editor for a multi-angle wall —
// tap a panel to select it, drag a fold along the wall, set the selected panel's angle (slider or ±5°),
// add or remove folds. Pure view: renders WallCardState, reports intents through WallCardActions.
// The 3D wall is rebuilt by the editor when a gesture ends (panelAngleCommit / foldCommit).

import { button, el, label, setText, toggle } from '../ui/dom';
import { glyph } from './glyphs';
import {
  angleLimits,
  canSplit,
  panelRange,
  presetsOf,
  presetWall,
  sidePoint,
  sideView,
  WALL,
  WALL_TYPE_LABEL,
  WALL_TYPES,
  type WallState,
  type WallType,
} from './walls';

export interface WallCardState {
  wall: WallState;
  selected: number;
  type: WallType;
  /** Id of the preset this wall exactly is (variant highlight), or null after edits. */
  preset: string | null;
  words: string;
  /** World height of the wall's top (m). */
  height: number;
  /** Holds along the wall (surface y + role) for the side view. */
  holds: readonly { y: number; role: string }[];
  /** The draft has holds above the top of the wall (shortened under the ceiling). */
  cut: number;
}

export interface WallCardActions {
  pickWallType(t: WallType): void;
  pickPreset(id: string): void;
  selectPanel(i: number): void;
  panelAngleInput(deg: number): void;
  panelAngleCommit(): void;
  panelAngleStep(delta: number): void;
  foldInput(i: number, y0: number): void;
  foldCommit(): void;
  splitPanel(): void;
  mergePanel(): void;
}

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  if (cls) e.setAttribute('class', cls);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** Side view frame (m): out from the wall foot (z) and height (h). Fixed, so editing never rescales it. */
const Z0 = -1.35;
const Z1 = 4.35;
const H0 = -0.25;
const H1 = 4.85;
const SV_W = 148;
const K = SV_W / (Z1 - Z0);
const SV_H = Math.round((H1 - H0) * K);
const sx = (z: number): number => (z - Z0) * K;
const sy = (h: number): number => SV_H - (h - H0) * K;
const f2 = (v: number): string => v.toFixed(2);
const deg = (a: number): string => `${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(Math.round(a))}°`;

/** Tiny side-profile glyph of a wall (type chips, the tray's wall button). */
export function wallGlyph(w: WallState, cls = ''): SVGSVGElement {
  const s = svg('svg', `ed-wg ${cls}`.trim(), { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  s.append(svg('line', 'ed-wg-floor', { x1: 2, y1: 21.5, x2: 22, y2: 21.5 }), svg('polyline', 'ed-wg-wall'));
  setWallGlyph(s, w);
  return s;
}

export function setWallGlyph(s: SVGSVGElement, w: WallState): void {
  const pts = sideView(w);
  const k = 17 / 4.6;
  const zs = pts.map((p) => p.z);
  const zmin = Math.min(0, ...zs);
  const zmax = Math.max(0, ...zs);
  // fit wide walls (a long cave roof) into the glyph, foot near the left
  const kk = Math.min(k, 18 / Math.max(0.5, zmax - zmin));
  const ox = 5 - zmin * kk + (zmax - zmin < 1 ? 2 : 0);
  const line = s.querySelector('polyline');
  line?.setAttribute('points', pts.map((p) => `${f2(ox + p.z * kk)},${f2(21 - p.h * kk)}`).join(' '));
}

export class WallCard {
  readonly el: HTMLElement;
  private words: HTMLElement;
  private typeBtns = new Map<WallType, HTMLButtonElement>();
  private variants: HTMLElement;
  private variantKey = '';
  private variantBtns: { id: string; b: HTMLButtonElement }[] = [];
  private side: SVGSVGElement;
  private sv: {
    wall: SVGPolylineElement;
    sel: SVGLineElement;
    arc: SVGPathElement;
    ceil: SVGLineElement;
    folds: SVGGElement;
    holds: SVGGElement;
    top: SVGTextElement;
    tip: SVGTextElement;
  };
  private panelK: HTMLElement;
  private panelV: HTMLElement;
  private angleIn: HTMLInputElement;
  private minus: HTMLButtonElement;
  private plus: HTMLButtonElement;
  private splitBtn: HTMLButtonElement;
  private mergeBtn: HTMLButtonElement;
  private note: HTMLElement;
  private st: WallCardState | null = null;
  private drag: { id: number; fold: number } | null = null;
  private holdsKey = '';
  private foldKey = '';

  constructor(private a: WallCardActions) {
    this.words = label('', 'ed-wall-w');
    const grid = el('div', 'ed-wt-grid');
    for (const t of WALL_TYPES) {
      const b = el('button', `ed-wt ed-wt-${t}`, wallGlyph(presetWall(presetsOf(t)[0])), el('span', 'ed-wt-l', WALL_TYPE_LABEL[t].toUpperCase()));
      b.type = 'button';
      b.setAttribute('aria-label', `${WALL_TYPE_LABEL[t]} wall`);
      b.addEventListener('click', () => a.pickWallType(t));
      this.typeBtns.set(t, b);
      grid.appendChild(b);
    }
    this.variants = el('div', 'ed-wv');

    // ── side view ──
    this.side = svg('svg', 'ed-side', { viewBox: `0 0 ${SV_W} ${SV_H}`, width: SV_W, height: SV_H, role: 'img', 'aria-label': 'Wall side view: drag a fold, tap a panel' });
    const grid2 = svg('g', 'sv-grid');
    for (let m = 1; m <= 4; m++) grid2.appendChild(svg('line', 'sv-gl', { x1: 0, x2: SV_W, y1: sy(m), y2: sy(m) }));
    for (let m = 1; m <= 4; m++) {
      const t = svg('text', 'sv-gt', { x: 3, y: sy(m) - 2 });
      t.textContent = `${m}`;
      grid2.appendChild(t);
    }
    const ceil = svg('line', 'sv-ceil', { x1: 0, x2: SV_W, y1: sy(WALL.ceiling), y2: sy(WALL.ceiling) });
    const pad = svg('rect', 'sv-pad', { x: sx(0.15), y: sy(0.3), width: sx(2.4) - sx(0.15), height: sy(0) - sy(0.3), rx: 2 });
    const stripe = svg('line', 'sv-stripe', { x1: sx(0.15), x2: sx(2.4), y1: sy(0.3), y2: sy(0.3) });
    const floor = svg('line', 'sv-floor', { x1: 0, x2: SV_W, y1: sy(0), y2: sy(0) });
    const wall = svg('polyline', 'sv-wall');
    const sel = svg('line', 'sv-sel');
    const arc = svg('path', 'sv-arc');
    const holds = svg('g', 'sv-holds');
    const folds = svg('g', 'sv-folds');
    const top = svg('text', 'sv-top');
    const tip = svg('text', 'sv-tip');
    this.side.append(grid2, ceil, pad, stripe, floor, arc, wall, sel, holds, folds, top, tip);
    this.sv = { wall, sel, arc, ceil, folds, holds, top, tip };
    this.side.addEventListener('pointerdown', this.onDown);
    this.side.addEventListener('pointermove', this.onMove);
    this.side.addEventListener('pointerup', this.onUp);
    this.side.addEventListener('pointercancel', this.onUp);

    // ── panel controls ──
    this.panelK = label('', 'ed-wp-k');
    this.panelV = el('span', 'ed-wp-v t-num');
    this.minus = button({ variant: 'icon', cls: 'ed-wp-step', aria: 'Panel 5° less steep', onTap: () => a.panelAngleStep(-5) });
    this.minus.prepend(glyph('minus', 'btn-ic'));
    this.plus = button({ variant: 'icon', cls: 'ed-wp-step', aria: 'Panel 5° steeper', onTap: () => a.panelAngleStep(5) });
    this.plus.prepend(glyph('plus', 'btn-ic'));
    this.angleIn = el('input', 'range ed-wp-in');
    this.angleIn.type = 'range';
    this.angleIn.step = '1';
    this.angleIn.setAttribute('aria-label', 'Panel angle');
    this.angleIn.addEventListener('input', () => a.panelAngleInput(Number(this.angleIn.value)));
    this.angleIn.addEventListener('change', () => a.panelAngleCommit());
    this.splitBtn = button({ label: 'FOLD', variant: 'glass', cls: 'ed-wp-fold', aria: 'Add a fold in this panel', onTap: () => a.splitPanel() });
    this.splitBtn.prepend(glyph('plus', 'btn-ic'));
    this.mergeBtn = button({ label: 'FOLD', variant: 'glass', cls: 'ed-wp-fold', aria: 'Remove this panel’s fold', onTap: () => a.mergePanel() });
    this.mergeBtn.prepend(glyph('minus', 'btn-ic'));
    this.note = el('p', 'ed-wp-note');
    const ctl = el(
      'div',
      'ed-wp-ctl',
      this.panelK,
      el('div', 'ed-wp-ang', this.minus, this.panelV, this.plus),
      this.angleIn,
      el('div', 'ed-wp-folds', this.splitBtn, this.mergeBtn),
    );
    this.el = el(
      'div',
      'ed-drawer ed-float-card ed-wall',
      el('div', 'ed-dr-h', label('WALL TYPE'), this.words),
      grid,
      this.variants,
      el('div', 'ed-wp', el('div', 'ed-side-box', this.side), ctl),
      this.note,
    );
  }

  render(s: WallCardState): void {
    this.st = s;
    setText(this.words, s.words);
    for (const [t, b] of this.typeBtns) {
      toggle(b, 'on', t === s.type);
      b.setAttribute('aria-pressed', String(t === s.type));
    }
    // variants of the current type
    const vk = s.type;
    if (vk !== this.variantKey) {
      this.variantKey = vk;
      this.variantBtns = presetsOf(s.type).map((p) => {
        const b = el('button', 'ed-wv-b', p.label);
        b.type = 'button';
        b.setAttribute('aria-label', `${WALL_TYPE_LABEL[p.type]} ${p.label}`);
        b.addEventListener('click', () => this.a.pickPreset(p.id));
        return { id: p.id, b };
      });
      this.variants.replaceChildren(...this.variantBtns.map((v) => v.b));
    }
    for (const v of this.variantBtns) {
      toggle(v.b, 'on', v.id === s.preset);
      v.b.setAttribute('aria-pressed', String(v.id === s.preset));
    }
    this.renderSide(s);
    // selected panel
    const w = s.wall;
    const i = Math.min(s.selected, w.panels.length - 1);
    const [y0, y1] = panelRange(w, i);
    const n = w.panels.length;
    setText(this.panelK, n > 1 ? `PANEL ${i + 1}/${n} · ${y0.toFixed(2)}–${y1.toFixed(2)} M` : `ONE PANEL · ${y1.toFixed(1)} M`);
    const ang = w.panels[i].angle;
    setText(this.panelV, deg(ang));
    const lim = angleLimits(n);
    if (this.angleIn.min !== String(lim.min)) this.angleIn.min = String(lim.min);
    if (this.angleIn.max !== String(lim.max)) this.angleIn.max = String(lim.max);
    if (document.activeElement !== this.angleIn || !this.angleIn.matches(':active')) {
      if (this.angleIn.value !== String(ang)) this.angleIn.value = String(ang);
    }
    this.angleIn.style.setProperty('--v', `${((ang - lim.min) / (lim.max - lim.min)) * 100}%`);
    this.minus.disabled = ang <= lim.min;
    this.plus.disabled = ang >= lim.max;
    this.splitBtn.disabled = !canSplit(w, i);
    this.mergeBtn.disabled = n < 2;
    let note = '';
    if (s.cut > 0) note = `${s.cut} hold${s.cut === 1 ? '' : 's'} above the top of this wall · move ${s.cut === 1 ? 'it' : 'them'} down`;
    else if (n === 1) note = 'Add a fold for a kicker, a bulge or a roof.';
    else note = 'Drag a fold · tap a panel to set its angle.';
    setText(this.note, note);
    toggle(this.note, 'warn', s.cut > 0);
  }

  private renderSide(s: WallCardState): void {
    const w = s.wall;
    const pts = sideView(w);
    this.sv.wall.setAttribute('points', pts.map((p) => `${f2(sx(p.z))},${f2(sy(p.h))}`).join(' '));
    const i = Math.min(s.selected, w.panels.length - 1);
    const a = pts[i];
    const b = pts[i + 1];
    this.sv.sel.setAttribute('x1', f2(sx(a.z)));
    this.sv.sel.setAttribute('y1', f2(sy(a.h)));
    this.sv.sel.setAttribute('x2', f2(sx(b.z)));
    this.sv.sel.setAttribute('y2', f2(sy(b.h)));
    // angle arc at the selected panel's foot: from plumb to the panel
    const t = (w.panels[i].angle * Math.PI) / 180;
    const R = 16;
    const ax = sx(a.z);
    const ay = sy(a.h);
    const ex = ax + Math.sin(t) * R;
    const ey = ay - Math.cos(t) * R;
    this.sv.arc.setAttribute('d', `M${f2(ax)} ${f2(ay)}L${f2(ax)} ${f2(ay - R)}A${R} ${R} 0 0 ${t >= 0 ? 1 : 0} ${f2(ex)} ${f2(ey)}`);
    // folds (handles), rebuilt when their number changes
    const fk = String(w.panels.length);
    if (fk !== this.foldKey) {
      this.foldKey = fk;
      this.sv.folds.replaceChildren();
      for (let k = 1; k < w.panels.length; k++) this.sv.folds.appendChild(svg('circle', 'sv-fold', { r: 4.6 }));
    }
    const fe = this.sv.folds.children;
    for (let k = 1; k < w.panels.length; k++) {
      const c = fe[k - 1] as SVGCircleElement;
      c.setAttribute('cx', f2(sx(pts[k].z)));
      c.setAttribute('cy', f2(sy(pts[k].h)));
      c.classList.toggle('on', this.drag?.fold === k);
    }
    // holds as dots on the climbing side of the wall
    const hk = `${s.holds.map((h) => `${h.y}:${h.role}`).join(',')}|${w.panels.map((p) => `${p.y0}:${p.angle}`).join(',')}|${w.length}`;
    if (hk !== this.holdsKey) {
      this.holdsKey = hk;
      this.sv.holds.replaceChildren(
        ...s.holds.map((h) => {
          const q = sidePoint(w, h.y);
          const tt = (q.angle * Math.PI) / 180;
          const over = h.y > w.length + 0.01;
          return svg('circle', `sv-hold r-${h.role}${over ? ' over' : ''}`, { r: 1.9, cx: f2(sx(q.z) + Math.cos(tt) * 3.4), cy: f2(sy(q.h) + Math.sin(tt) * 3.4) });
        }),
      );
    }
    const topP = pts[pts.length - 1];
    this.sv.top.setAttribute('x', f2(Math.min(SV_W - 2, sx(topP.z) + 5)));
    this.sv.top.setAttribute('y', f2(Math.max(9, sy(topP.h) - 4)));
    this.sv.top.setAttribute('text-anchor', sx(topP.z) > SV_W - 34 ? 'end' : 'start');
    this.sv.top.textContent = `${s.height.toFixed(1)} M`;
    if (this.drag) {
      const p = pts[this.drag.fold];
      this.sv.tip.textContent = `${w.panels[this.drag.fold].y0.toFixed(2)} M`;
      this.sv.tip.setAttribute('x', f2(Math.max(4, sx(p.z) - 8)));
      this.sv.tip.setAttribute('y', f2(sy(p.h) + 3));
      this.sv.tip.setAttribute('text-anchor', 'end');
    } else this.sv.tip.textContent = '';
  }

  // ── side-view gestures ──

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.side.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * SV_W, y: ((e.clientY - r.top) / Math.max(1, r.height)) * SV_H };
  }

  private readonly onDown = (e: PointerEvent): void => {
    const s = this.st;
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    const p = this.local(e);
    const pts = sideView(s.wall);
    // nearest fold handle within a finger's reach (22 px on screen)
    const r = this.side.getBoundingClientRect();
    const pxPerUnit = r.width / SV_W || 1;
    let best = -1;
    let bd = 22 / pxPerUnit;
    for (let k = 1; k < pts.length - 1; k++) {
      const d = Math.hypot(sx(pts[k].z) - p.x, sy(pts[k].h) - p.y);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    if (best > 0) {
      try {
        this.side.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      this.drag = { id: e.pointerId, fold: best };
      this.renderSide(s);
      return;
    }
    // else: the nearest panel (segment) selects it
    let pi = -1;
    let pd = 20 / pxPerUnit;
    for (let k = 0; k < pts.length - 1; k++) {
      const d = segDist(p.x, p.y, sx(pts[k].z), sy(pts[k].h), sx(pts[k + 1].z), sy(pts[k + 1].h));
      if (d < pd) {
        pd = d;
        pi = k;
      }
    }
    if (pi >= 0 && pi !== s.selected) this.a.selectPanel(pi);
  };

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.drag;
    const s = this.st;
    if (!d || !s || e.pointerId !== d.id) return;
    e.preventDefault();
    const p = this.local(e);
    // the fold slides along the panel below it (that panel grows or shrinks)
    const w = s.wall;
    const pts = sideView(w);
    const base = pts[d.fold - 1];
    const t = (w.panels[d.fold - 1].angle * Math.PI) / 180;
    const mz = Z0 + p.x / K;
    const mh = H0 + (SV_H - p.y) / K;
    const along = (mz - base.z) * Math.sin(t) + (mh - base.h) * Math.cos(t);
    this.a.foldInput(d.fold, w.panels[d.fold - 1].y0 + along);
  };

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (this.st) this.renderSide(this.st);
    this.a.foldCommit();
  };

  get dragging(): boolean {
    return !!this.drag;
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

// SVG overlay drawn over the 3D wall while editing: climbable-panel outline, role tags, rule
// violation rings, the selection gizmo (ring + rotate knob on the hold's "body side"), the
// drag/hover ghost with nearby T-nuts, beta sequence labels and placement ripples.
// Positions are re-projected every frame (the editor camera springs) but attributes are only
// written when they actually move, so an idle editor costs almost nothing.

import type { BetaMove } from '../core/contracts';
import type { BoulderDef, HoldDef, Vec2 } from '../core/types';
import { EDITOR, footprint, tnutsNear, type EditRole } from './model';

const NS = 'http://www.w3.org/2000/svg';

export interface Projector {
  toScreen(p: Vec2, depth?: number): { x: number; y: number; visible: boolean };
  /** CSS px per wall meter (uniform for the straight-on editor camera). */
  ppm(): number;
}

export interface OverlayGhost {
  /** Wall point the hold would go to. */
  p: Vec2;
  /** Footprint radius (m). */
  r: number;
  ok: boolean;
  /** Raw finger point when snapping (draws the snap spoke). */
  raw?: Vec2 | null;
  showTnuts: boolean;
  /** Draw the footprint ring (hover preview, or a refused spot). */
  ring: boolean;
}

export interface OverlayState {
  boulder: BoulderDef;
  /** Bumped whenever holds change (rebuilds per-hold elements). */
  version: number;
  selectedId: string | null;
  flagged: ReadonlySet<string>;
  beta: readonly BetaMove[] | null;
  ghost: OverlayGhost | null;
  /** Emphasise the climbable panel outline (while placing / dragging). */
  boundsActive: boolean;
  /** A hold is being moved: the rotate knob steps aside for the drag ghost. */
  dragging: boolean;
}

interface Ripple {
  p: Vec2;
  t: number;
  r0: number;
  bad: boolean;
  el: SVGCircleElement;
}

interface Tag {
  g: SVGGElement;
  x: number;
  y: number;
  role: EditRole | 'deco';
}

const ROLE_GLYPH: Record<EditRole, string> = { start: 'S', hand: '', foot: 'F', top: 'T' };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  if (cls) e.setAttribute('class', cls);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

const f1 = (v: number): string => (Math.round(v * 10) / 10).toString();

export class EditorOverlay {
  readonly el: SVGSVGElement;
  private bounds: SVGPathElement;
  private tagLayer: SVGGElement;
  private flagLayer: SVGGElement;
  private betaLayer: SVGGElement;
  private fxLayer: SVGGElement;
  private gizmo: SVGGElement;
  private gSpoke: SVGLineElement;
  private gKnob: SVGGElement;
  private ghost: SVGGElement;
  private ghRing: SVGCircleElement;
  private ghSpoke: SVGLineElement;
  private ghCross: SVGPathElement;
  private ghDots: SVGCircleElement[] = [];

  private tags = new Map<string, Tag>();
  private flags = new Map<string, SVGCircleElement>();
  private betaEls: SVGGElement[] = [];
  private ripples: Ripple[] = [];
  private version = -1;
  private flaggedKey = '';
  private betaKey = '';
  private boundsKey = '';
  private dash = 0;
  private w = 0;
  private h = 0;
  /** Screen-space knob position of the selection gizmo (for hit tests). */
  knob: { x: number; y: number; r: number } | null = null;
  /** Screen-space centre + radius of the selected hold. */
  selection: { x: number; y: number; r: number } | null = null;

  constructor() {
    this.el = svg('svg', 'ed-ov', { 'aria-hidden': 'true' });
    this.bounds = svg('path', 'ov-bounds');
    this.flagLayer = svg('g', 'ov-flags');
    this.tagLayer = svg('g', 'ov-tags');
    this.betaLayer = svg('g', 'ov-beta');
    this.fxLayer = svg('g', 'ov-fx');

    this.gizmo = svg('g', 'ov-gizmo');
    this.gSpoke = svg('line', 'ov-g-spoke');
    this.gKnob = svg('g', 'ov-g-knob');
    this.gKnob.append(
      svg('circle', 'ov-g-knob-bg', { r: 13 }),
      svg('path', 'ov-g-knob-ic', { d: 'M-4.6 1.6a4.8 4.8 0 1 0 1.6-4.9M-3.4-6.2v3.3h3.3' }),
    );
    this.gizmo.append(this.gSpoke, this.gKnob);

    this.ghost = svg('g', 'ov-ghost');
    this.ghSpoke = svg('line', 'ov-gh-spoke');
    this.ghRing = svg('circle', 'ov-gh-ring', { r: 10 });
    this.ghCross = svg('path', 'ov-gh-cross');
    for (let i = 0; i < 12; i++) {
      const d = svg('circle', 'ov-gh-dot', { r: 2.2 });
      this.ghDots.push(d);
      this.ghost.appendChild(d);
    }
    this.ghost.append(this.ghSpoke, this.ghRing, this.ghCross);

    this.el.append(this.bounds, this.flagLayer, this.betaLayer, this.tagLayer, this.ghost, this.gizmo, this.fxLayer);
    this.gizmo.style.display = 'none';
    this.ghost.style.display = 'none';
  }

  setSize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.el.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.el.setAttribute('width', String(w));
    this.el.setAttribute('height', String(h));
  }

  /** Expanding ring where a hold was placed (or refused). */
  ripple(p: Vec2, r0: number, bad = false): void {
    const el = svg('circle', `ov-ripple${bad ? ' bad' : ''}`, { r: 1 });
    this.fxLayer.appendChild(el);
    this.ripples.push({ p: { ...p }, t: 0, r0, bad, el });
  }

  get animating(): boolean {
    return this.ripples.length > 0;
  }

  update(s: OverlayState, dt: number, proj: Projector): void {
    const ppm = proj.ppm();
    const b = s.boulder;
    if (s.version !== this.version) this.rebuildTags(b);
    this.version = s.version;

    // panel outline (climbable area above the pads)
    const c0 = proj.toScreen({ x: -b.width / 2, y: EDITOR.floorY });
    const c1 = proj.toScreen({ x: b.width / 2, y: EDITOR.floorY });
    const c2 = proj.toScreen({ x: b.width / 2, y: b.height });
    const c3 = proj.toScreen({ x: -b.width / 2, y: b.height });
    const bk = `M${f1(c0.x)} ${f1(c0.y)}L${f1(c1.x)} ${f1(c1.y)}L${f1(c2.x)} ${f1(c2.y)}L${f1(c3.x)} ${f1(c3.y)}Z`;
    if (bk !== this.boundsKey) {
      this.bounds.setAttribute('d', bk);
      this.boundsKey = bk;
    }
    this.bounds.classList.toggle('on', s.boundsActive);

    // role tags
    for (const h of b.holds) {
      const t = this.tags.get(h.id);
      if (!t) continue;
      const sp = proj.toScreen(h);
      const r = footprint(h) * ppm;
      const mini = t.role === 'foot' && ppm < 150;
      const x = sp.x + r * 0.78 + (mini ? 3 : 6);
      const y = sp.y - r * 0.78 - (mini ? 2 : 4);
      if (!(Math.abs(x - t.x) <= 0.25 && Math.abs(y - t.y) <= 0.25)) {
        t.g.setAttribute('transform', `translate(${f1(x)} ${f1(y)})`);
        t.x = x;
        t.y = y;
      }
      // footholds are many: a quiet dot until the view is zoomed in
      t.g.classList.toggle('mini', t.role === 'foot' && ppm < 150);
    }

    this.updateFlags(b, s.flagged, proj, ppm);
    this.updateBeta(b, s.beta, proj, ppm);
    this.updateGizmo(b, s.dragging ? null : s.selectedId, dt, proj, ppm);
    this.updateGhost(s.ghost, proj, ppm);

    // ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.t += dt;
      const k = rp.t / 0.5;
      if (k >= 1) {
        rp.el.remove();
        this.ripples.splice(i, 1);
        continue;
      }
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      const sp = proj.toScreen(rp.p);
      rp.el.setAttribute('cx', f1(sp.x));
      rp.el.setAttribute('cy', f1(sp.y));
      rp.el.setAttribute('r', f1(rp.r0 * ppm + 6 + 26 * e));
      rp.el.style.opacity = String((1 - k) * (rp.bad ? 0.95 : 0.85));
    }
  }

  private rebuildTags(b: BoulderDef): void {
    const keep = new Set<string>();
    for (const h of b.holds) {
      const role = h.role as EditRole;
      const glyph = ROLE_GLYPH[role] ?? '';
      if (!glyph) continue;
      keep.add(h.id);
      let t = this.tags.get(h.id);
      if (t && t.role !== role) {
        t.g.remove();
        this.tags.delete(h.id);
        t = undefined;
      }
      if (!t) {
        const g = svg('g', `ov-tag ov-tag-${role}`);
        const inner = svg('g', 'ov-tag-in');
        const tx = svg('text', 'ov-tag-tx', { x: 0, y: 0.5 });
        tx.textContent = glyph;
        inner.append(svg('rect', 'ov-tag-bg', { x: -7.5, y: -7.5, width: 15, height: 15, rx: role === 'top' ? 2 : 7.5 }), tx);
        g.appendChild(inner);
        this.tagLayer.appendChild(g);
        t = { g, x: NaN, y: NaN, role };
        this.tags.set(h.id, t);
      }
    }
    for (const [id, t] of this.tags) {
      if (keep.has(id)) continue;
      t.g.remove();
      this.tags.delete(id);
    }
  }

  private updateFlags(b: BoulderDef, flagged: ReadonlySet<string>, proj: Projector, ppm: number): void {
    const key = [...flagged].sort().join(',');
    if (key !== this.flaggedKey) {
      for (const [id, c] of this.flags) {
        if (flagged.has(id)) continue;
        c.remove();
        this.flags.delete(id);
      }
      for (const id of flagged) {
        if (this.flags.has(id)) continue;
        const c = svg('circle', 'ov-flag', { r: 10 });
        this.flagLayer.appendChild(c);
        this.flags.set(id, c);
      }
      this.flaggedKey = key;
    }
    if (!this.flags.size) return;
    for (const h of b.holds) {
      const c = this.flags.get(h.id);
      if (!c) continue;
      const sp = proj.toScreen(h);
      c.setAttribute('cx', f1(sp.x));
      c.setAttribute('cy', f1(sp.y));
      c.setAttribute('r', f1(Math.max(9, footprint(h) * ppm + 5)));
    }
  }

  private updateBeta(b: BoulderDef, beta: readonly BetaMove[] | null, proj: Projector, ppm: number): void {
    const key = beta ? beta.map((m) => m.limb + m.holdId).join('|') + '#' + this.version : '';
    if (key !== this.betaKey) {
      for (const e of this.betaEls) e.remove();
      this.betaEls = [];
      this.betaKey = key;
      if (beta) {
        const by = new Map<string, { n: number[]; feet: boolean; hands: boolean }>();
        beta.forEach((m, i) => {
          let e = by.get(m.holdId);
          if (!e) by.set(m.holdId, (e = { n: [], feet: false, hands: false }));
          e.n.push(i + 1);
          if (m.limb === 'LF' || m.limb === 'RF') e.feet = true;
          else e.hands = true;
        });
        for (const [id, e] of by) {
          if (!b.holds.some((h) => h.id === id)) continue;
          const text = e.n.length > 3 ? `${e.n[0]}·${e.n[1]}·…` : e.n.join('·');
          const g = svg('g', `ov-bnum ${e.hands ? 'hand' : 'foot'}`);
          const w = 9 + text.length * 5.6;
          g.dataset.id = id;
          g.dataset.w = String(w);
          g.append(svg('rect', 'ov-bnum-bg', { x: -w, y: -8, width: w, height: 16, rx: 8 }), svg('text', 'ov-bnum-tx', { x: -w / 2, y: 0.5 }));
          (g.lastChild as SVGTextElement).textContent = text;
          this.betaLayer.appendChild(g);
          this.betaEls.push(g);
        }
      }
    }
    for (const g of this.betaEls) {
      const h = b.holds.find((x) => x.id === g.dataset.id);
      if (!h) continue;
      const sp = proj.toScreen(h);
      const r = footprint(h) * ppm;
      g.setAttribute('transform', `translate(${f1(sp.x - r * 0.8 - 5)} ${f1(sp.y + r * 0.8 + 6)})`);
    }
  }

  private updateGizmo(b: BoulderDef, selectedId: string | null, dt: number, proj: Projector, ppm: number): void {
    const h: HoldDef | undefined = selectedId ? b.holds.find((x) => x.id === selectedId) : undefined;
    if (!h) {
      if (this.gizmo.style.display !== 'none') this.gizmo.style.display = 'none';
      this.knob = null;
      this.selection = null;
      return;
    }
    if (this.gizmo.style.display === 'none') this.gizmo.style.display = '';
    const sp = proj.toScreen(h);
    // the renderer draws the selection ring (≈ hold radius × 1.12 + 3.5 cm, min 15 px, outer hairline ×1.2)
    const R = Math.max((footprint(h) * 1.12 + 0.035) * ppm, 15) * 1.22;
    this.dash = (this.dash + dt * 14) % 1000;
    this.gSpoke.style.strokeDashoffset = f1(-this.dash * 0.5);
    // the knob sits on the side the hold faces (opposite the body direction stored in `angle`)
    const ca = -Math.cos(h.angle);
    const sa = Math.sin(h.angle);
    const kd = R + 20;
    const kx = sp.x + ca * kd;
    const ky = sp.y + sa * kd;
    this.gSpoke.setAttribute('x1', f1(sp.x + ca * (R + 1)));
    this.gSpoke.setAttribute('y1', f1(sp.y + sa * (R + 1)));
    this.gSpoke.setAttribute('x2', f1(kx - ca * 13));
    this.gSpoke.setAttribute('y2', f1(ky - sa * 13));
    this.gKnob.setAttribute('transform', `translate(${f1(kx)} ${f1(ky)})`);
    this.knob = { x: kx, y: ky, r: 24 };
    this.selection = { x: sp.x, y: sp.y, r: R };
  }

  private updateGhost(g: OverlayGhost | null, proj: Projector, ppm: number): void {
    if (!g) {
      if (this.ghost.style.display !== 'none') this.ghost.style.display = 'none';
      return;
    }
    if (this.ghost.style.display === 'none') this.ghost.style.display = '';
    const sp = proj.toScreen(g.p);
    const r = Math.max(8, g.r * ppm + 4);
    this.ghost.classList.toggle('bad', !g.ok);
    this.ghRing.style.display = g.ring ? '' : 'none';
    this.ghRing.setAttribute('cx', f1(sp.x));
    this.ghRing.setAttribute('cy', f1(sp.y));
    this.ghRing.setAttribute('r', f1(r));
    const c = 5;
    this.ghCross.setAttribute('d', `M${f1(sp.x - c)} ${f1(sp.y)}H${f1(sp.x + c)}M${f1(sp.x)} ${f1(sp.y - c)}V${f1(sp.y + c)}`);
    if (g.raw && (Math.abs(g.raw.x - g.p.x) > 0.005 || Math.abs(g.raw.y - g.p.y) > 0.005)) {
      const rp = proj.toScreen(g.raw);
      this.ghSpoke.style.display = '';
      this.ghSpoke.setAttribute('x1', f1(rp.x));
      this.ghSpoke.setAttribute('y1', f1(rp.y));
      this.ghSpoke.setAttribute('x2', f1(sp.x));
      this.ghSpoke.setAttribute('y2', f1(sp.y));
    } else this.ghSpoke.style.display = 'none';
    const dots = g.showTnuts ? tnutsNear(g.raw ?? g.p, 0.31) : [];
    for (let i = 0; i < this.ghDots.length; i++) {
      const d = this.ghDots[i];
      const t = dots[i];
      if (!t) {
        d.style.display = 'none';
        continue;
      }
      const tp = proj.toScreen(t);
      d.style.display = '';
      d.setAttribute('cx', f1(tp.x));
      d.setAttribute('cy', f1(tp.y));
      d.classList.toggle('hit', Math.abs(t.x - g.p.x) < 1e-3 && Math.abs(t.y - g.p.y) < 1e-3);
    }
  }

  dispose(): void {
    for (const r of this.ripples) r.el.remove();
    this.ripples = [];
    this.el.remove();
  }
}

// App-level overlays that belong to no single module: the transition veil between problems, the
// hint ghost (where the suggested limb should go), the "graphics paused" card shown while the
// WebGL context is lost, and the fatal-error card.

import { BRAND, FONTS, PALETTE } from '../config/brand';

const CSS = `
.jga-veil{position:absolute;inset:0;z-index:60;pointer-events:none;opacity:0;background:
radial-gradient(120% 80% at 50% 40%,rgba(23,25,29,.94),${PALETTE.basalt} 70%);transition:opacity .26s cubic-bezier(.2,.8,.2,1);
display:grid;place-items:center}
.jga-veil.on{opacity:1;pointer-events:auto}
.jga-veil.quick{transition-duration:.14s}
.jga-veil-in{display:flex;flex-direction:column;align-items:center;gap:10px;transform:translateY(6px);opacity:0;
transition:opacity .3s .08s,transform .4s .08s cubic-bezier(.2,.8,.2,1)}
.jga-veil.on .jga-veil-in{opacity:1;transform:none}
.jga-veil-k{font:600 10px/1 ${FONTS.mono};letter-spacing:.28em;color:${PALETTE.fog};text-transform:uppercase}
.jga-veil-t{font:800 34px/1 ${FONTS.display};letter-spacing:.08em;color:${PALETTE.bone};text-transform:uppercase;text-align:center;padding:0 24px}
.jga-veil-bar{width:120px;height:2px;background:rgba(255,255,255,.08);overflow:hidden;border-radius:2px;margin-top:6px}
.jga-veil-bar i{display:block;height:100%;width:40%;background:${PALETTE.signal};animation:jga-load 1.1s cubic-bezier(.6,.1,.4,.9) infinite}
@keyframes jga-load{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}
.jga-ghost{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:visible}
.jga-ghost svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.jga-ghost .g-line{stroke:${PALETTE.glacier};stroke-width:1.5;stroke-dasharray:4 6;fill:none;opacity:.85;animation:jga-dash 1s linear infinite}
.jga-ghost .g-ring{fill:rgba(154,212,222,.08);stroke:${PALETTE.glacier};stroke-width:1.5;stroke-dasharray:3 4}
.jga-ghost .g-core{fill:${PALETTE.glacier}}
.jga-ghost .g-pulse{fill:none;stroke:${PALETTE.glacier};stroke-width:1;transform-box:fill-box;transform-origin:center;animation:jga-ping 1.4s cubic-bezier(.2,.8,.2,1) infinite}
.jga-ghost .g-tag{position:absolute;left:0;top:0;padding:5px 8px 5px 7px;border-radius:8px;background:rgba(13,14,16,.78);
border:1px solid rgba(154,212,222,.35);font:600 9.5px/1 ${FONTS.mono};letter-spacing:.16em;color:${PALETTE.glacier};white-space:nowrap;
backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;gap:6px;align-items:center}
.jga-ghost .g-tag b{color:${PALETTE.bone};font-weight:700}
.jga-ghost.off{display:none}
@keyframes jga-dash{to{stroke-dashoffset:-20}}
@keyframes jga-ping{0%{transform:scale(.6);opacity:.9}100%{transform:scale(1.9);opacity:0}}
.jga-error{position:absolute;inset:0;z-index:90;display:grid;place-items:center;padding:24px;background:${PALETTE.basalt};color:${PALETTE.bone};pointer-events:auto}
.jga-error-card{box-sizing:border-box;max-width:340px;width:100%;display:flex;flex-direction:column;gap:14px;padding:26px 22px;border-radius:18px;
background:rgba(23,25,29,.9);border:1px solid rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.jga-error-mark{width:28px;height:28px;color:${PALETTE.signal}}
.jga-error-k{font:600 10px/1 ${FONTS.mono};letter-spacing:.26em;color:${PALETTE.signal}}
.jga-error-h{font:800 30px/1 ${FONTS.display};letter-spacing:.06em;text-transform:uppercase;margin:0}
.jga-error-p{font:400 14px/1.5 ${FONTS.ui};color:${PALETTE.mist};margin:0}
.jga-error-c{font:500 11px/1.45 ${FONTS.mono};color:${PALETTE.fog};background:rgba(0,0,0,.35);border-radius:10px;padding:10px 12px;
max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.jga-error-b{height:52px;border-radius:14px;border:0;background:${PALETTE.signal};color:${PALETTE.basalt};font:800 16px/1 ${FONTS.display};
letter-spacing:.16em;cursor:pointer}
.jga-error-b:active{transform:scale(.97)}
.jga-lost{position:absolute;inset:0;z-index:85;display:grid;place-items:center;padding:24px;pointer-events:auto;
background:radial-gradient(120% 80% at 50% 40%,rgba(23,25,29,.92),${PALETTE.basalt} 72%);color:${PALETTE.bone};
opacity:0;transition:opacity .22s cubic-bezier(.2,.8,.2,1)}
.jga-lost.on{opacity:1}
.jga-lost[hidden]{display:none}
.jga-lost .jga-error-card{align-items:flex-start}
.jga-lost-bar{width:100%;height:2px;background:rgba(255,255,255,.08);overflow:hidden;border-radius:2px}
.jga-lost-bar i{display:block;height:100%;width:40%;background:${PALETTE.signal};animation:jga-load 1.1s cubic-bezier(.6,.1,.4,.9) infinite}
.jga-lost .jga-error-b{width:100%}
.jga-lost .jga-error-b[hidden]{display:none}
@media (prefers-reduced-motion: reduce){.jga-veil,.jga-veil-in,.jga-lost{transition:none}.jga-ghost .g-line,.jga-ghost .g-pulse,.jga-veil-bar i,.jga-lost-bar i{animation:none}}
.reduced-motion-app .jga-veil,.reduced-motion-app .jga-veil-in{transition:none}
`;

let styled = false;
export function ensureAppStyles(doc: Document = document): void {
  if (styled) return;
  styled = true;
  const s = doc.createElement('style');
  s.dataset.jga = '1';
  s.textContent = CSS;
  doc.head.appendChild(s);
}

// ───────────────────────────── transition veil ─────────────────────────────

export class Veil {
  readonly el: HTMLDivElement;
  private readonly kicker: HTMLSpanElement;
  private readonly title: HTMLSpanElement;
  private readonly bar: HTMLDivElement;
  private reduced = false;

  constructor(host: HTMLElement) {
    ensureAppStyles(host.ownerDocument);
    const d = host.ownerDocument;
    this.el = d.createElement('div');
    this.el.className = 'jga-veil';
    this.el.setAttribute('aria-hidden', 'true');
    const inner = d.createElement('div');
    inner.className = 'jga-veil-in';
    this.kicker = d.createElement('span');
    this.kicker.className = 'jga-veil-k';
    this.title = d.createElement('span');
    this.title.className = 'jga-veil-t';
    this.bar = d.createElement('div');
    this.bar.className = 'jga-veil-bar';
    this.bar.appendChild(d.createElement('i'));
    inner.append(this.kicker, this.title, this.bar);
    this.el.appendChild(inner);
    host.appendChild(this.el);
  }

  setReducedMotion(v: boolean): void {
    this.reduced = v;
  }

  get shown(): boolean {
    return this.el.classList.contains('on');
  }

  /** Cover the screen (optionally with a spec-style caption). Resolves once opaque. */
  cover(kicker = '', title = '', quick = false): Promise<void> {
    this.kicker.textContent = kicker;
    this.title.textContent = title;
    this.bar.style.display = title ? '' : 'none';
    this.el.classList.toggle('quick', quick);
    this.el.classList.add('on');
    return new Promise((r) => setTimeout(r, this.reduced ? 0 : quick ? 150 : 270));
  }

  /** Reveal the scene again. */
  reveal(): Promise<void> {
    this.el.classList.remove('on');
    return new Promise((r) => setTimeout(r, this.reduced ? 0 : 260));
  }
}

// ───────────────────────────── hint ghost ─────────────────────────────

const SVGNS = 'http://www.w3.org/2000/svg';

export class HintGhost {
  readonly el: HTMLDivElement;
  private readonly line: SVGLineElement;
  private readonly ring: SVGCircleElement;
  private readonly pulse: SVGCircleElement;
  private readonly core: SVGCircleElement;
  private readonly tag: HTMLDivElement;
  private readonly tagLimb: HTMLElement;
  private visible = false;
  private lastLabel = '';

  constructor(host: HTMLElement, before: Element | null) {
    ensureAppStyles(host.ownerDocument);
    const d = host.ownerDocument;
    this.el = d.createElement('div');
    this.el.className = 'jga-ghost off';
    this.el.setAttribute('aria-hidden', 'true');
    const svg = d.createElementNS(SVGNS, 'svg');
    this.line = d.createElementNS(SVGNS, 'line');
    this.line.setAttribute('class', 'g-line');
    this.pulse = d.createElementNS(SVGNS, 'circle');
    this.pulse.setAttribute('class', 'g-pulse');
    this.ring = d.createElementNS(SVGNS, 'circle');
    this.ring.setAttribute('class', 'g-ring');
    this.core = d.createElementNS(SVGNS, 'circle');
    this.core.setAttribute('class', 'g-core');
    this.core.setAttribute('r', '3');
    svg.append(this.line, this.pulse, this.ring, this.core);
    this.tag = d.createElement('div');
    this.tag.className = 'g-tag';
    const k = d.createElement('span');
    k.textContent = 'HINT';
    this.tagLimb = d.createElement('b');
    this.tag.append(k, this.tagLimb);
    this.el.append(svg, this.tag);
    host.insertBefore(this.el, before);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('off');
  }

  /** Screen positions in host CSS px: from the limb to the target hold (radius in px). */
  show(fx: number, fy: number, tx: number, ty: number, r: number, label: string): void {
    if (!this.visible) {
      this.visible = true;
      this.el.classList.remove('off');
    }
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.tagLimb.textContent = label;
    }
    const rr = Math.max(16, Math.min(46, r));
    // stop the dashed leader at the ring
    const dx = tx - fx;
    const dy = ty - fy;
    const d = Math.hypot(dx, dy) || 1;
    const ex = tx - (dx / d) * rr;
    const ey = ty - (dy / d) * rr;
    this.line.setAttribute('x1', fx.toFixed(1));
    this.line.setAttribute('y1', fy.toFixed(1));
    this.line.setAttribute('x2', ex.toFixed(1));
    this.line.setAttribute('y2', ey.toFixed(1));
    for (const c of [this.ring, this.pulse]) {
      c.setAttribute('cx', tx.toFixed(1));
      c.setAttribute('cy', ty.toFixed(1));
      c.setAttribute('r', rr.toFixed(1));
    }
    this.core.setAttribute('cx', tx.toFixed(1));
    this.core.setAttribute('cy', ty.toFixed(1));
    // tag sits beside the ring, away from the limb
    const side = dx >= 0 ? 1 : -1;
    const tw = this.tag.offsetWidth || 90;
    const lx = side > 0 ? tx + rr + 8 : tx - rr - 8 - tw;
    this.tag.style.transform = `translate3d(${Math.round(lx)}px,${Math.round(ty - 11)}px,0)`;
  }
}

// ───────────────────────────── graphics paused (WebGL context lost) ─────────────────────────────

/** How long to wait for the browser to hand the GPU back before offering a reload. */
const RESTORE_PATIENCE_MS = 6000;

/**
 * Mobile browsers drop the WebGL context under memory pressure or after a long background stay.
 * The renderer rebuilds on 'webglcontextrestored'; until then this card covers the frozen canvas,
 * and if the restore never comes it offers a reload (progress is saved first by the caller).
 */
export class GraphicsLostCard {
  readonly el: HTMLDivElement;
  private readonly reload: HTMLButtonElement;
  private readonly body: HTMLParagraphElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement, onReload: () => void = () => location.reload()) {
    ensureAppStyles(host.ownerDocument);
    const d = host.ownerDocument;
    this.el = d.createElement('div');
    this.el.className = 'jga-lost';
    this.el.hidden = true;
    this.el.setAttribute('role', 'alert');
    const card = d.createElement('div');
    card.className = 'jga-error-card';
    const k = d.createElement('span');
    k.className = 'jga-error-k';
    k.textContent = 'GRAPHICS PAUSED';
    const h = d.createElement('h2');
    h.className = 'jga-error-h';
    h.textContent = 'Hold tight';
    this.body = d.createElement('p');
    this.body.className = 'jga-error-p';
    const bar = d.createElement('div');
    bar.className = 'jga-lost-bar';
    bar.appendChild(d.createElement('i'));
    this.reload = d.createElement('button');
    this.reload.type = 'button';
    this.reload.className = 'jga-error-b';
    this.reload.textContent = 'RELOAD';
    this.reload.hidden = true;
    this.reload.addEventListener('click', () => onReload());
    card.append(k, h, this.body, bar, this.reload);
    this.el.appendChild(card);
    host.appendChild(this.el);
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  show(): void {
    if (this.shown) return;
    this.body.textContent = 'Your phone paused the 3D wall to free up memory. Bringing it back now. Your climb is paused and your progress is saved.';
    this.reload.hidden = true;
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add('on'));
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.body.textContent = 'The wall did not come back by itself. Reload to keep climbing. Your progress is saved on this device.';
      this.reload.hidden = false;
    }, RESTORE_PATIENCE_MS);
  }

  hide(): void {
    this.clearTimer();
    this.el.classList.remove('on');
    this.el.hidden = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ───────────────────────────── fatal error ─────────────────────────────

export function showFatalError(host: HTMLElement, err: unknown, context = 'The game hit an unexpected error.'): void {
  ensureAppStyles(host.ownerDocument);
  if (host.querySelector('.jga-error')) return;
  const d = host.ownerDocument;
  const wrap = d.createElement('div');
  wrap.className = 'jga-error';
  wrap.setAttribute('role', 'alertdialog');
  const card = d.createElement('div');
  card.className = 'jga-error-card';
  const mark = d.createElement('div');
  mark.className = 'jga-error-mark';
  mark.innerHTML = BRAND.logoSvg;
  const k = d.createElement('span');
  k.className = 'jga-error-k';
  k.textContent = `${BRAND.name} · ${BRAND.game}`;
  const h = d.createElement('h2');
  h.className = 'jga-error-h';
  h.textContent = 'Off the wall';
  const p = d.createElement('p');
  p.className = 'jga-error-p';
  p.textContent = `${context} Your progress is saved on this device. Reload to get back on the wall.`;
  const code = d.createElement('pre');
  code.className = 'jga-error-c';
  code.textContent = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const b = d.createElement('button');
  b.type = 'button';
  b.className = 'jga-error-b';
  b.textContent = 'RELOAD';
  b.addEventListener('click', () => location.reload());
  card.append(mark, k, h, p, code, b);
  wrap.appendChild(card);
  host.appendChild(wrap);
}

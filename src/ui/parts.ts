// Reusable UI building blocks: headers, badges, chips, segmented controls, toggles, sliders,
// spec cells, empty states, skeletons, route thumbnails, Steini tip lines.

import type { ScreenId } from '../core/contracts';
import type { BoulderDef } from '../core/types';
import { BRAND } from '../config/brand';
import { backButton, button, el, label, type Child } from './dom';
import { icon, type IconName } from './icons';
import { fontG, grade, gradeHex } from './format';
import type { Portraits } from './portraits';

export function screenRoot(id: ScreenId, cls = ''): HTMLElement {
  const s = el('section', `scr scr-${id} ${cls}`.trim());
  s.dataset.screen = id;
  return s;
}

/** Topographic contour background layer (pattern from the --topo CSS var). */
export function topoLayer(cls = ''): HTMLElement {
  const t = el('div', `topo ${cls}`.trim());
  t.setAttribute('aria-hidden', 'true');
  return t;
}

export interface HeaderOpts {
  title: string;
  kicker?: string;
  back?: boolean;
  onBack?: () => void;
  right?: Child;
}

export function header(o: HeaderOpts): HTMLElement {
  return el(
    'header',
    'hdr stg',
    o.back === false ? el('span', 'hdr-spacer') : backButton(o.onBack),
    el('div', 'hdr-title', o.kicker ? label(o.kicker, 'hdr-kicker') : null, el('h2', 'hdr-h', o.title)),
    el('div', 'hdr-right', o.right ?? null),
  );
}

export type BackendKind = 'global' | 'shared' | 'offline' | 'pending';

/** Classify a BackendAPI label ('GLOBAL' / 'CLAUDE SHARED' / 'OFFLINE', or the app's 'CONNECTING'). */
export function backendKind(text: string): BackendKind {
  const t = text.toUpperCase();
  if (t.includes('OFFLINE') || t.includes('LOCAL')) return 'offline';
  if (t.includes('CLAUDE') || t.includes('SHARED')) return 'shared';
  if (!t.trim() || t.includes('CONNECT')) return 'pending';
  return 'global';
}

const BADGE: Record<BackendKind, { text: string; icon: IconName; help: string }> = {
  global: { text: 'GLOBAL', icon: 'globe', help: 'Global leaderboard: your scores count worldwide.' },
  shared: { text: 'CLAUDE SHARED', icon: 'community', help: 'Claude shared: scores are shared with everyone playing this game in claude.ai.' },
  offline: { text: 'OFFLINE', icon: 'offline', help: 'Offline: scores are saved on this device only.' },
  pending: { text: 'CONNECTING', icon: 'refresh', help: 'Connecting to the leaderboard…' },
};

/** Backend badge from a BackendAPI label: GLOBAL (Supabase), CLAUDE SHARED (claude.ai), OFFLINE. */
export function backendBadge(text: string): HTMLElement {
  const kind = backendKind(text);
  const b = BADGE[kind];
  const badge = el('span', `badge badge-${kind}`, icon(b.icon, 'badge-ic'), el('span', 'badge-txt', b.text));
  badge.title = b.help;
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-label', b.help);
  return badge;
}

/** One line on what the current backend means for the player's scores. */
export function backendNote(kind: BackendKind, what: 'scores' | 'problems'): string {
  if (kind === 'offline')
    return what === 'scores'
      ? 'You’re offline, so this board shows runs saved on this device. Open the game online to compete worldwide.'
      : 'You’re offline, so only problems saved on this device show up. Open the game online to see what others set.';
  if (kind === 'shared') return what === 'scores' ? 'Shared with everyone playing this game in claude.ai.' : 'Problems shared by everyone playing this game in claude.ai.';
  return what === 'scores' ? 'Worldwide board. Every run you finish counts.' : 'Set by climbers around the world.';
}

export function gradeChip(g: number, opts: { font?: boolean; size?: 'sm' | 'md' | 'lg' } = {}): HTMLElement {
  const chip = el('span', `grade grade-${opts.size ?? 'md'}`, el('b', null, grade(g)), opts.font ? el('i', null, fontG(g)) : null);
  chip.style.setProperty('--g', gradeHex(g));
  return chip;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(v: T): void;
}

export function segmented<T extends string>(o: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; cls?: string }): Segmented<T> {
  const wrap = el('div', `seg ${o.cls ?? ''}`.trim());
  wrap.setAttribute('role', 'tablist');
  wrap.style.setProperty('--n', String(o.options.length));
  const ind = el('span', 'seg-ind');
  wrap.appendChild(ind);
  let value = o.value;
  const btns = o.options.map((opt, i) =>
    button({
      label: opt.label,
      variant: 'plain',
      cls: 'seg-btn',
      onTap: () => {
        if (opt.id === value) return;
        set(opt.id);
        o.onChange(opt.id);
      },
    }),
  );
  btns.forEach((b) => {
    b.setAttribute('role', 'tab');
    wrap.appendChild(b);
  });
  const set = (v: T): void => {
    value = v;
    const idx = Math.max(0, o.options.findIndex((x) => x.id === v));
    wrap.style.setProperty('--idx', String(idx));
    btns.forEach((b, i) => {
      b.classList.toggle('on', i === idx);
      b.setAttribute('aria-selected', i === idx ? 'true' : 'false');
    });
  };
  set(value);
  return { el: wrap, set };
}

export function toggleRow(o: { label: string; sub?: string; icon: IconName; value: boolean; onChange: (v: boolean) => void }): HTMLElement {
  let v = o.value;
  const sw = el('span', 'switch', el('i', 'switch-knob'));
  const row = button({ variant: 'plain', cls: 'row row-toggle', aria: o.label });
  row.setAttribute('role', 'switch');
  row.append(
    icon(o.icon, 'row-ic'),
    el('span', 'row-txt', el('span', 'row-lbl', o.label), o.sub ? el('span', 'row-sub', o.sub) : null),
    sw,
  );
  const paint = (): void => {
    row.classList.toggle('on', v);
    row.setAttribute('aria-checked', v ? 'true' : 'false');
  };
  row.addEventListener('click', () => {
    v = !v;
    paint();
    o.onChange(v);
  });
  paint();
  return row;
}

export function sliderRow(o: { label: string; icon: IconName; value: number; onInput: (v: number) => void }): HTMLElement {
  const input = el('input', 'range');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.value = String(Math.round(o.value * 100));
  input.setAttribute('aria-label', o.label);
  const val = el('span', 'row-val t-num', `${input.value}`);
  const paint = (): void => {
    input.style.setProperty('--v', `${input.value}%`);
    val.textContent = input.value;
  };
  input.addEventListener('input', () => {
    paint();
    o.onInput(Number(input.value) / 100);
  });
  paint();
  return el('div', 'row row-slider', icon(o.icon, 'row-ic'), el('span', 'row-txt', el('span', 'row-lbl', o.label), input), val);
}

/** Spec-sheet cell: tiny mono label over a big value (+ optional unit). */
export function specCell(lbl: string, value: Child, unit?: string, cls = ''): HTMLElement {
  return el('div', `spec ${cls}`.trim(), label(lbl, 'spec-lbl'), el('div', 'spec-val', value, unit ? el('small', 'spec-unit', unit) : null));
}

export function emptyState(o: { icon: IconName; title: string; body: string; action?: HTMLElement }): HTMLElement {
  return el(
    'div',
    'empty stg',
    el('div', 'empty-ic', topoLayer('topo-ring'), icon(o.icon)),
    el('h3', 'empty-h', o.title),
    el('p', 'empty-p', o.body),
    o.action ?? null,
  );
}

export function skeletons(n: number, cls: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const s = el('div', `skel ${cls}`, el('i', 'skel-a'), el('i', 'skel-b'), el('i', 'skel-c'));
    s.style.setProperty('--i', String(i));
    out.push(s);
  }
  return out;
}

/** Steini's one-liner (preview / results). */
export function steiniTip(portraits: Portraits, text: string, cls = ''): HTMLElement {
  return el(
    'div',
    `steini-tip ${cls}`.trim(),
    portraits.frame('ibex', 'pt-steini'),
    el('div', 'st-body', el('span', 'st-name', BRAND.guideName.toUpperCase(), el('i', null, 'GUIDE')), el('p', 'st-text', text)),
  );
}

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
};

/** Miniature top-down map of a problem: route holds in the route colour, START / TOP marked. */
export function routeThumb(b: BoulderDef, cls = ''): SVGSVGElement {
  const W = b.width || 4.6;
  const H = b.height || 4.5;
  const pad = 0.25;
  const svg = svgEl('svg', { viewBox: `${-W / 2 - pad} ${-H - pad} ${W + pad * 2} ${H + pad * 2}`, class: `thumb ${cls}`.trim(), 'aria-hidden': 'true' });
  svg.appendChild(svgEl('rect', { x: -W / 2, y: -H, width: W, height: H, rx: 0.12, class: 'th-wall' }));
  // panel seams
  for (let x = -W / 2 + 1.22; x < W / 2 - 0.1; x += 1.22) svg.appendChild(svgEl('line', { x1: x, y1: -H, x2: x, y2: 0, class: 'th-seam' }));
  for (let y = 1.22; y < H - 0.1; y += 1.22) svg.appendChild(svgEl('line', { x1: -W / 2, y1: -y, x2: W / 2, y2: -y, class: 'th-seam' }));
  const route = b.holds.filter((h) => h.role !== 'deco');
  for (const h of b.holds) {
    if (h.role !== 'deco') continue;
    svg.appendChild(svgEl('circle', { cx: h.x, cy: -h.y, r: Math.max(0.05, h.size * 0.8), class: 'th-deco' }));
  }
  const fill = b.color || route[0]?.color || '#E9E5DD';
  const dark = luminance(fill) < 0.12;
  for (const h of route) {
    const r = Math.max(0.075, Math.min(0.3, h.size * (h.type === 'volume' ? 0.75 : 1.5)));
    svg.appendChild(svgEl('circle', { cx: h.x, cy: -h.y, r, fill, class: `th-hold th-${h.role}${dark ? ' th-dark' : ''}` }));
    if (h.role === 'start' || h.role === 'top') svg.appendChild(svgEl('circle', { cx: h.x, cy: -h.y, r: r + 0.13, class: `th-ring th-ring-${h.role}` }));
  }
  return svg;
}

/**
 * START / TOP tape chip in the route colour: the same tape the setter sticks under those holds on
 * the wall (src/render/textures.ts), so the legend matches what the player sees.
 */
export function tapeChip(text: string, routeHex: string): HTMLElement {
  const t = el('b', `tape${luminance(routeHex) > 0.55 ? ' tape-light' : ''}`, text);
  t.style.setProperty('--route', routeHex);
  return t;
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

/** Route-colour swatch dot. */
export function swatch(hex: string, cls = ''): HTMLElement {
  const s = el('i', `swatch ${cls}`.trim());
  s.style.setProperty('--sw', hex);
  return s;
}

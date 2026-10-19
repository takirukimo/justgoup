// Tiny DOM helpers for the UI layer (no framework). Everything the screens build goes through
// these so markup stays declarative and typed.

import { bus } from '../core/events';
import { icon, type IconName } from './icons';

export type Child = Node | string | number | null | undefined | false;

/** Create an element with a class list and children. Strings become text nodes (never HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) append(e, c);
  return e;
}

export function append(parent: Node, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
}

/** Replace all children. */
export function setChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  for (const c of children) append(parent, c);
}

/** Micro label (JetBrains Mono, tiny caps). */
export function label(value: string, cls = ''): HTMLSpanElement {
  return el('span', `t-label ${cls}`.trim(), value);
}

/** Set a text node only when it changed (cheap guard for hot paths). */
export function setText(e: Element, value: string): void {
  if (e.textContent !== value) e.textContent = value;
}

export function toggle(e: Element, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

/** Stagger index for entrance animations. */
export function stagger<T extends HTMLElement>(e: T, i: number): T {
  e.classList.add('stg');
  e.style.setProperty('--i', String(i));
  return e;
}

export type ButtonVariant = 'primary' | 'glass' | 'ghost' | 'danger' | 'icon' | 'tile' | 'plain';

export interface ButtonOpts {
  label?: string;
  icon?: IconName;
  /** Icon after the label instead of before it. */
  iconAfter?: boolean;
  variant?: ButtonVariant;
  cls?: string;
  aria?: string;
  /** A small second line under the label (what the button does, e.g. "SAME BOULDER"). */
  caption?: string;
  /** Back buttons also emit 'ui:back'. */
  back?: boolean;
  disabled?: boolean;
  onTap?: (ev: MouseEvent) => void;
}

/**
 * A press-able button. 'ui:tap' is emitted by the root click delegate in GameUI for every button,
 * so handlers here only do the button-specific work.
 */
export function button(o: ButtonOpts): HTMLButtonElement {
  const b = el('button', `btn btn-${o.variant ?? 'glass'} ${o.cls ?? ''}`.trim());
  b.type = 'button';
  if (o.aria) b.setAttribute('aria-label', o.aria);
  else if (o.label) b.setAttribute('aria-label', o.label);
  if (o.disabled) b.disabled = true;
  const ic = o.icon ? icon(o.icon, 'btn-ic') : null;
  if (ic && !o.iconAfter) b.appendChild(ic);
  if (o.label && o.caption) {
    b.classList.add('btn-2l');
    b.appendChild(el('span', 'btn-txt', el('span', 'btn-lbl', o.label), el('span', 'btn-cap', o.caption)));
  } else if (o.label) b.appendChild(el('span', 'btn-lbl', o.label));
  if (ic && o.iconAfter) b.appendChild(ic);
  if (o.back) b.dataset.back = '1';
  b.addEventListener('click', (ev) => {
    if (b.disabled) return;
    if (o.back) bus.emit('ui:back');
    o.onTap?.(ev);
  });
  return b;
}

/** Standard round back button (top-left of every sub-screen). */
export function backButton(onTap?: () => void): HTMLButtonElement {
  return button({ icon: 'back', variant: 'icon', cls: 'btn-back', aria: 'Back', back: true, onTap });
}

/** Image element for a head portrait; `src` may change later when a provider arrives. */
export function img(cls: string, src: string, alt = ''): HTMLImageElement {
  const i = el('img', cls);
  i.decoding = 'async';
  i.draggable = false;
  i.alt = alt;
  i.src = src;
  return i;
}

/** Element from an SVG/HTML string we authored (icons, logo, topo). Never use for user text. */
export function fromMarkup<T extends Element = Element>(markup: string): T {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as T;
}

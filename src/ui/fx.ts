// Global overlay effects: big centred callouts ("SENT!", "3-2-1", "WHIPPER!") and toasts.

import { el } from './dom';

export type CalloutStyle = 'good' | 'bad' | 'neutral';

export class FxLayer {
  readonly el: HTMLElement;
  private calloutEl: HTMLElement | null = null;
  private toasts: HTMLElement;

  constructor() {
    this.toasts = el('div', 'toasts');
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');
    this.el = el('div', 'fx-layer', this.toasts);
  }

  callout(text: string, style: CalloutStyle = 'neutral'): void {
    const prev = this.calloutEl;
    if (prev) {
      prev.classList.add('co-out');
      setTimeout(() => prev.remove(), 200);
    }
    const t = text.trim();
    const count = /^(\d|GO!?)$/i.test(t);
    const long = t.length > 9;
    const c = el(
      'div',
      `callout co-${style} ${count ? 'co-count' : ''} ${long ? 'co-long' : ''}`.trim(),
      el('span', 'co-stripe'),
      el('span', 'co-txt', t),
      count ? null : el('span', 'co-rule'),
    );
    c.setAttribute('aria-live', 'assertive');
    this.calloutEl = c;
    this.el.appendChild(c);
    const life = count ? 820 : 1500;
    setTimeout(() => {
      if (this.calloutEl === c) this.calloutEl = null;
      c.classList.add('co-out');
      setTimeout(() => c.remove(), 260);
    }, life);
  }

  toast(text: string): void {
    while (this.toasts.children.length >= 3) this.toasts.firstElementChild?.remove();
    const t = el('div', 'toast', el('i', 'toast-dot'), el('span', null, text));
    this.toasts.appendChild(t);
    setTimeout(() => {
      t.classList.add('toast-out');
      setTimeout(() => t.remove(), 260);
    }, 2400);
  }
}

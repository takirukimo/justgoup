// Generic confirm modal with a dim backdrop.

import { button, el } from './dom';
import { icon } from './icons';

export class Modal {
  readonly el: HTMLElement;
  private pending: ((v: boolean) => void) | null = null;

  constructor() {
    this.el = el('div', 'modal-layer');
  }

  get isOpen(): boolean {
    return this.pending !== null;
  }

  confirm(title: string, body: string, ok = 'CONFIRM', cancel = 'CANCEL'): Promise<boolean> {
    this.close(false);
    return new Promise<boolean>((resolve) => {
      const danger = /reset|delete|erase|discard|quit|abandon|wipe/i.test(ok);
      const done = (v: boolean): void => {
        if (this.pending !== finish) return;
        this.pending = null;
        card.classList.add('out');
        backdrop.classList.add('out');
        setTimeout(() => wrap.remove(), 220);
        resolve(v);
      };
      const finish = (v: boolean): void => done(v);
      this.pending = finish;

      const backdrop = el('div', 'modal-backdrop');
      backdrop.addEventListener('click', () => done(false));
      const okBtn = button({ label: ok.toUpperCase(), variant: danger ? 'danger' : 'primary', cls: 'modal-ok', onTap: () => done(true) });
      const cancelBtn = button({ label: cancel.toUpperCase(), variant: 'glass', cls: 'modal-cancel', onTap: () => done(false) });
      const card = el(
        'div',
        `modal-card glass ${danger ? 'is-danger' : ''}`,
        el('span', 'modal-ic', icon(danger ? 'warn' : 'info')),
        el('h3', 'modal-h', title),
        el('p', 'modal-p', body),
        el('div', 'modal-actions', cancelBtn, okBtn),
      );
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', title);
      const wrap = el('div', 'modal', backdrop, card);
      this.el.appendChild(wrap);
      if (matchMedia('(pointer: fine)').matches) setTimeout(() => (danger ? cancelBtn : okBtn).focus({ preventScroll: true }), 60);
    });
  }

  /** Resolve any open dialog (Escape, or a newer dialog replacing it). */
  close(value: boolean): void {
    const p = this.pending;
    if (p) p(value);
  }
}

// Steini's speech bubble: portrait, name tag, typewriter reveal, mood styles, top/bottom
// placement. Only captures touches while it waits for a tap, so the climb stays playable.

import type { GuideLine } from '../core/contracts';
import { BRAND } from '../config/brand';
import { button, el, label } from './dom';
import { icon, type IconName } from './icons';
import type { Portraits } from './portraits';

const MOOD_ICON: Record<NonNullable<GuideLine['mood']>, IconName | null> = {
  happy: null,
  point: 'arrow',
  think: 'bulb',
  cheer: 'star',
  warn: 'warn',
};

/** Typewriter reveal (keep in sync with the pacing helpers in src/tutorial/script.ts). */
const MS_PER_CHAR = 24;
const MAX_TYPE_MS = 2600;
/** Old text fades out before the new line types in (cross-fade, never a hard cut). */
const SWAP_OUT_MS = 150;
/** Card leave animation (hide, or moving between the top and bottom edge). */
const LEAVE_MS = 220;

export class GuideBubble {
  readonly el: HTMLElement;
  private catcher: HTMLElement;
  private card: HTMLElement;
  private textEl: HTMLElement;
  private moodEl: HTMLElement;
  private more: HTMLElement;
  private skipBtn: HTMLButtonElement;
  private resolveTap: (() => void) | null = null;
  private typed = true;
  private typeTimer = 0;
  private hideTimer = 0;
  private swapTimer = 0;
  private animTimer = 0;
  private swapping = false;
  private visible = false;
  private skipFn: (() => void) | null = null;

  constructor(
    private portraits: Portraits,
    private isReduced: () => boolean,
  ) {
    this.textEl = el('p', 'gb-text');
    this.moodEl = el('span', 'gb-mood');
    this.more = el('span', 'gb-more', 'TAP TO CONTINUE', icon('chevron'));
    this.card = el(
      'div',
      'gb-card',
      el('div', 'gb-pt', portraits.guideFrame('pt-guide'), this.moodEl),
      el('div', 'gb-body', el('div', 'gb-tag', el('span', 'gb-name', BRAND.guideName.toUpperCase()), label('INSTRUCTOR · ' + BRAND.gym)), this.textEl, this.more),
      el('span', 'gb-tail'),
    );
    this.catcher = el('div', 'gb-catcher');
    this.catcher.addEventListener('click', () => this.onTap());
    this.card.addEventListener('click', () => this.onTap());
    this.skipBtn = button({
      label: 'SKIP',
      icon: 'skip',
      iconAfter: true,
      variant: 'glass',
      cls: 'gb-skip',
      onTap: () => this.skipFn?.(),
    });
    this.el = el('div', 'guide-layer', this.catcher, this.card, this.skipBtn);
  }

  say(line: GuideLine): Promise<void> {
    clearTimeout(this.hideTimer);
    clearTimeout(this.swapTimer);
    // A newer line replaces (and resolves) a pending one.
    this.finishTap();
    const wasVisible = this.visible && this.el.classList.contains('on');
    this.visible = true;
    const pos = line.position ?? 'bottom';
    const mood = line.mood ?? 'happy';
    const moved = wasVisible && this.el.classList.contains('at-top') !== (pos === 'top');
    const apply = (mode: 'enter' | 'swap'): void => {
      this.swapping = false;
      this.el.classList.add('on');
      this.el.classList.toggle('at-top', pos === 'top');
      this.el.classList.toggle('at-bottom', pos !== 'top');
      this.card.className = `gb-card mood-${mood} ${mode}`;
      const mi = MOOD_ICON[mood];
      this.moodEl.replaceChildren(...(mi ? [icon(mi)] : []));
      this.moodEl.classList.toggle('none', !mi);
      this.setText(line.text);
    };
    // No hard cuts: a new line cross-fades the text in place; a line that moves to the other edge
    // lets the card leave first, then enters at its new spot.
    if (!wasVisible || this.isReduced()) {
      apply(wasVisible ? 'swap' : 'enter');
    } else if (moved) {
      this.swapping = true;
      this.card.classList.remove('enter', 'swap', 'swap-out');
      this.card.classList.add('leave');
      this.swapTimer = window.setTimeout(() => apply('enter'), LEAVE_MS);
    } else {
      this.swapping = true;
      this.card.classList.remove('enter', 'swap');
      this.card.classList.add('swap-out');
      this.swapTimer = window.setTimeout(() => apply('swap'), SWAP_OUT_MS);
    }
    const wait = !!line.waitForTap;
    this.el.classList.toggle('waiting', wait);
    if (!wait) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveTap = resolve;
    });
  }

  hide(): void {
    this.finishTap();
    clearTimeout(this.typeTimer);
    clearTimeout(this.swapTimer);
    this.swapping = false;
    const wasOn = this.visible;
    this.visible = false;
    this.el.classList.remove('waiting');
    clearTimeout(this.hideTimer);
    if (!wasOn) return;
    this.card.classList.remove('enter', 'swap', 'swap-out');
    this.card.classList.add('leave');
    this.hideTimer = window.setTimeout(() => {
      this.el.classList.remove('on');
      this.card.classList.remove('leave');
    }, this.isReduced() ? 0 : LEAVE_MS);
  }

  /** Optional: show a SKIP chip (tutorial); null hides it. */
  setSkip(fn: (() => void) | null): void {
    this.skipFn = fn;
    this.el.classList.toggle('has-skip', !!fn);
  }

  /** Re-point the portrait after the provider arrives. */
  refresh(): void {
    this.portraits.refresh(this.card);
  }

  private setText(text: string): void {
    clearTimeout(this.typeTimer);
    const frag = document.createDocumentFragment();
    const reduced = this.isReduced();
    const step = Math.min(MS_PER_CHAR, MAX_TYPE_MS / Math.max(1, text.length));
    let i = 0;
    // Words stay unbroken (nowrap spans); characters fade in via CSS animation delays,
    // so the reveal costs no JS per frame and the layout never reflows while typing.
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(' '));
        i++;
        continue;
      }
      const w = el('span', 'gb-w');
      for (const ch of part) {
        const s = el('span', 'gb-c', ch);
        s.style.animationDelay = `${Math.round(i * step)}ms`;
        w.appendChild(s);
        i++;
      }
      frag.appendChild(w);
    }
    this.textEl.replaceChildren(frag);
    this.textEl.setAttribute('aria-label', text);
    this.typed = reduced;
    this.card.classList.toggle('typed', reduced);
    if (!reduced) {
      this.typeTimer = window.setTimeout(() => this.completeTyping(), i * step + 120);
    }
    // drop the enter / swap animation class once it has played (so the next one can restart)
    clearTimeout(this.animTimer);
    this.animTimer = window.setTimeout(() => this.card.classList.remove('enter', 'swap'), 480);
  }

  private completeTyping(): void {
    clearTimeout(this.typeTimer);
    this.typed = true;
    this.card.classList.add('typed');
  }

  private onTap(): void {
    if (!this.visible || this.swapping) return;
    if (!this.typed) {
      this.completeTyping();
      return;
    }
    if (!this.resolveTap) return;
    this.finishTap();
    // Hide shortly after unless the next line arrives right away (sequenced dialogue).
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 90);
  }

  private finishTap(): void {
    const r = this.resolveTap;
    this.resolveTap = null;
    this.el.classList.remove('waiting');
    r?.();
  }
}

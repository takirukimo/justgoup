// Cinematic layer for the first-launch intro: letterbox bars, the STEIBOCK title card (horn-mark,
// tracked title, official CHIRAL SPORTS wordmark, a spec-sheet row about the gym), a hairline
// progress rule, a tap catcher so the card can be advanced early, and a SKIP chip fallback for UIs
// that don't expose `ui.guide.setSkip`. Lives inside #ui and reuses the UI design tokens (CSS vars on
// .jgu-ui) with literal fallbacks, so it matches the rest of the interface.

import { BRAND, FONTS, PALETTE } from '../config/brand';
import { INTRO_CARD } from './script';

const STYLE_ID = 'jgt-style';

const CSS = /* css */ `
.jgt {
  position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden;
  font-family: var(--f-ui, ${FONTS.ui});
  --jgt-ease: var(--ease, cubic-bezier(.2,.8,.2,1));
  --jgt-signal: var(--c-signal, ${PALETTE.signal});
  --jgt-ink: var(--c-signal-ink, #EE6B79);
  --jgt-chalk: var(--c-chalk, ${PALETTE.chalk});
  --jgt-fog: var(--c-fog, ${PALETTE.fog});
  --jgt-mono: var(--f-mono, ${FONTS.mono});
  --jgt-display: var(--f-display, ${FONTS.display});
}
.jgt-bar {
  position: absolute; left: 0; right: 0; height: 7.2%; background: ${PALETTE.basalt};
  transition: transform .9s var(--jgt-ease);
}
.jgt-bar.t { top: 0; transform: translateY(-101%); }
.jgt-bar.b { bottom: 0; transform: translateY(101%); }
.jgt.on .jgt-bar { transform: none; }
.jgt-prog {
  position: absolute; left: 0; bottom: 0; height: 1px; width: 100%;
  background: linear-gradient(90deg, var(--jgt-signal), rgba(var(--c-signal-rgb, 213,64,81),.25));
  transform-origin: 0 50%; transform: scaleX(0);
}
.jgt-scrim {
  position: absolute; left: 0; right: 0; top: 0; height: 54%;
  background: linear-gradient(180deg, rgba(13,14,16,.86) 0%, rgba(13,14,16,.66) 44%, rgba(13,14,16,0) 100%);
  opacity: 0; transition: opacity 1.1s var(--jgt-ease);
}
.jgt.card-on .jgt-scrim { opacity: 1; }
.jgt-card {
  position: absolute; left: calc(var(--safe-l, 0px) + 24px); right: calc(var(--safe-r, 0px) + 24px);
  top: calc(7.2% + var(--safe-t, 0px) + 34px);
  display: grid; grid-template-columns: auto 1fr; column-gap: 14px; align-items: center;
}
.jgt-eyebrow {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
  font: 500 9.5px/1 var(--jgt-mono); letter-spacing: .26em; color: var(--jgt-ink);
}
.jgt-eyebrow::before { content: ''; width: 22px; height: 1px; background: currentColor; }
.jgt-mark { width: 44px; color: var(--jgt-signal); filter: drop-shadow(0 4px 14px rgba(var(--c-signal-rgb, 213,64,81),.4)); }
.jgt-mark svg { width: 100%; height: auto; display: block; overflow: visible; }
.jgt-title {
  margin: 0; font: 800 min(58px, calc((100cqw - 106px) / 4.6))/.84 var(--jgt-display);
  letter-spacing: .12em; margin-right: -.12em; text-transform: uppercase;
  color: var(--jgt-chalk); white-space: nowrap; text-shadow: 0 2px 24px rgba(0,0,0,.45);
}
.jgt-by {
  grid-column: 2; display: flex; align-items: center; gap: 9px; margin-top: 10px; color: var(--c-bone, ${PALETTE.bone});
  font: 500 8.5px/1 var(--jgt-mono); letter-spacing: .28em;
}
.jgt-by span { color: var(--jgt-fog); }
.jgt-by svg { height: 10px; width: auto; display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
.jgt-rule {
  grid-column: 1 / -1; height: 1px; margin: 16px 0 11px; background: rgba(255,255,255,.22);
  transform-origin: 0 50%;
}
.jgt-specs { grid-column: 1 / -1; display: flex; gap: 18px; }
.jgt-spec { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.jgt-spec + .jgt-spec { padding-left: 18px; border-left: 1px solid rgba(255,255,255,.12); }
.jgt-spec small {
  font: 500 8.5px/1 var(--jgt-mono); letter-spacing: .2em; color: var(--jgt-fog); white-space: nowrap;
}
.jgt-spec b {
  font: 600 17px/1 var(--jgt-display); letter-spacing: .1em; color: var(--c-bone, ${PALETTE.bone}); white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0,0,0,.8), 0 0 14px rgba(0,0,0,.6);
}
.jgt-spec small, .jgt-eyebrow { text-shadow: 0 1px 2px rgba(0,0,0,.85); }
/* Steini's bubble sits above the bottom letterbox bar while the cinematic is up */
.jgu-ui:has(.jgt.on) .guide-layer { --gb-bottom: calc(7.2cqh + 14px); }
.jgt-tap { position: absolute; inset: 0; pointer-events: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.jgt.tap-wait .jgt-tap { pointer-events: auto; }
/* reveal: each row wipes in from the left, staggered */
.jgt-card > * { opacity: 0; transform: translateX(-14px); }
.jgt-card .jgt-rule { transform: scaleX(0); }
.jgt.card-on .jgt-card > * {
  opacity: 1; transform: none;
  transition: opacity .6s var(--jgt-ease), transform .8s var(--jgt-ease);
  transition-delay: calc(var(--i, 0) * 80ms);
}
.jgt.card-off .jgt-card > * {
  opacity: 0; transform: translateY(-8px);
  transition: opacity .45s ease, transform .5s var(--jgt-ease);
  transition-delay: calc(var(--i, 0) * 30ms);
}
.jgt-skip {
  position: absolute; top: calc(var(--safe-t, 0px) + 14px); right: calc(var(--safe-r, 0px) + 12px);
  pointer-events: auto; display: none; align-items: center; gap: 8px; height: 44px; padding: 0 14px;
  border-radius: 12px; border: 1px solid rgba(255,255,255,.14); color: var(--c-mist, ${PALETTE.mist});
  background: rgba(13,14,16,.72); -webkit-backdrop-filter: blur(18px) saturate(1.2); backdrop-filter: blur(18px) saturate(1.2);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.055);
  font: 700 13px/1 var(--jgt-display); letter-spacing: .16em; cursor: pointer;
  transition: transform .18s var(--jgt-ease), background .18s;
  -webkit-tap-highlight-color: transparent;
}
.jgt-skip:active { transform: scale(.97); background: rgba(35,39,46,.86); }
.jgt-skip svg { width: 14px; height: 14px; }
.jgt.has-skip .jgt-skip { display: inline-flex; }
.jgt.leave { opacity: 0; transition: opacity .5s var(--jgt-ease); }
@media (prefers-reduced-motion: reduce) {
  .jgt *, .jgt { transition-duration: .01ms !important; transition-delay: 0ms !important; }
}
.reduced-motion .jgt *, .reduced-motion .jgt { transition-duration: .01ms !important; transition-delay: 0ms !important; }
`;

/** Inject the tutorial/intro stylesheet once per document. */
export function ensureTutorialStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

function div(doc: Document, cls: string, text?: string): HTMLDivElement {
  const d = doc.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

const SKIP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 5l9 7-9 7z"/><path d="M19 5v14"/></svg>';

/** Where scripted overlays mount: the UI root (#ui / .jgu-ui), else the document body. */
export function overlayHost(doc: Document = document): HTMLElement {
  return doc.querySelector<HTMLElement>('.jgu-ui') ?? doc.getElementById('ui') ?? doc.body;
}

export class IntroOverlay {
  readonly el: HTMLDivElement;
  private readonly prog: HTMLDivElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly tap: HTMLDivElement;
  private skipFn: (() => void) | null = null;
  private tapResolve: (() => void) | null = null;
  private disposed = false;
  private lastProg = -1;

  constructor(host: HTMLElement) {
    const doc = host.ownerDocument;
    ensureTutorialStyles(doc);
    this.el = div(doc, 'jgt');
    this.el.setAttribute('aria-hidden', 'false');

    const top = div(doc, 'jgt-bar t');
    this.prog = div(doc, 'jgt-prog');
    top.appendChild(this.prog);
    const bot = div(doc, 'jgt-bar b');

    const card = div(doc, 'jgt-card');
    const eyebrow = div(doc, 'jgt-eyebrow', INTRO_CARD.eyebrow);
    const mark = div(doc, 'jgt-mark');
    mark.innerHTML = BRAND.logoSvg; // authored constant, not user content
    const title = doc.createElement('h1');
    title.className = 'jgt-title';
    title.textContent = INTRO_CARD.title;
    const by = div(doc, 'jgt-by');
    const byTxt = doc.createElement('span');
    byTxt.textContent = 'BY';
    by.appendChild(byTxt);
    by.insertAdjacentHTML('beforeend', BRAND.wordmarkSvg); // official outlined wordmark (authored constant)
    by.lastElementChild?.setAttribute('aria-label', `${BRAND.name} ${BRAND.sub}`);
    by.lastElementChild?.setAttribute('role', 'img');
    const rule = div(doc, 'jgt-rule');
    const specs = div(doc, 'jgt-specs');
    for (const [k, v] of INTRO_CARD.specs) {
      const spec = div(doc, 'jgt-spec');
      const small = doc.createElement('small');
      small.textContent = k;
      const b = doc.createElement('b');
      b.textContent = v;
      spec.append(small, b);
      specs.appendChild(spec);
    }
    [eyebrow, mark, title, by, rule, specs].forEach((e, i) => e.style.setProperty('--i', String([0, 1, 1, 2, 3, 4][i])));
    card.append(eyebrow, mark, title, by, rule, specs);
    this.tap = div(doc, 'jgt-tap');
    this.tap.addEventListener('click', this.onTap);

    this.skipBtn = doc.createElement('button');
    this.skipBtn.type = 'button';
    this.skipBtn.className = 'jgt-skip';
    this.skipBtn.setAttribute('aria-label', 'Skip intro');
    this.skipBtn.innerHTML = '<span>SKIP</span>' + SKIP_ICON;
    this.skipBtn.addEventListener('click', this.onSkip);

    this.el.append(div(doc, 'jgt-scrim'), this.tap, top, bot, card, this.skipBtn);
    host.appendChild(this.el);
    // next frame: slide the letterbox in
    void this.el.offsetWidth;
    this.el.classList.add('on');
  }

  showCard(): void {
    if (this.disposed) return;
    this.el.classList.remove('card-off');
    this.el.classList.add('card-on');
  }

  hideCard(): void {
    if (this.disposed) return;
    this.el.classList.remove('card-on');
    this.el.classList.add('card-off');
  }

  /** Resolves on the next tap anywhere on the scene (tap-to-advance for the title card). */
  waitForTap(): Promise<void> {
    this.stopWaitingForTap();
    if (this.disposed) return new Promise<void>(() => undefined);
    this.el.classList.add('tap-wait');
    return new Promise<void>((resolve) => {
      this.tapResolve = resolve;
    });
  }

  /** Stop catching taps (the promise from waitForTap stays pending). */
  stopWaitingForTap(): void {
    this.tapResolve = null;
    this.el.classList.remove('tap-wait');
  }

  /** 0..1 progress of the cinematic (hairline under the top bar). */
  setProgress(k: number): void {
    const v = Math.round(Math.min(1, Math.max(0, k)) * 400) / 400;
    if (v === this.lastProg || this.disposed) return;
    this.lastProg = v;
    this.prog.style.transform = `scaleX(${v})`;
  }

  /** Fallback SKIP chip (used only when the UI has no guide skip chip). */
  setSkip(fn: (() => void) | null): void {
    this.skipFn = fn;
    this.el.classList.toggle('has-skip', !!fn);
  }

  /** Retract the letterbox and remove the layer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.skipFn = null;
    this.skipBtn.removeEventListener('click', this.onSkip);
    this.tap.removeEventListener('click', this.onTap);
    this.stopWaitingForTap();
    this.el.classList.remove('on', 'card-on', 'has-skip');
    this.el.classList.add('leave');
    const el = this.el;
    setTimeout(() => el.remove(), 900);
  }

  private readonly onTap = (e: Event): void => {
    e.stopPropagation();
    const r = this.tapResolve;
    this.stopWaitingForTap();
    r?.();
  };

  private readonly onSkip = (e: Event): void => {
    e.stopPropagation();
    this.skipFn?.();
  };
}

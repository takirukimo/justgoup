// Cinematic layer for the first-launch intro: letterbox bars, a spec-sheet title card
// ("NOW ENTERING / CHIRAL HQ"), a hairline progress rule, and a SKIP chip fallback for UIs that
// don't expose `ui.guide.setSkip`. Lives inside #ui and reuses the UI design tokens (CSS vars on
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
  background: linear-gradient(90deg, var(--jgt-signal), rgba(255,79,31,.25));
  transform-origin: 0 50%; transform: scaleX(0);
}
.jgt-scrim {
  position: absolute; left: 0; right: 0; top: 0; height: 46%;
  background: linear-gradient(180deg, rgba(13,14,16,.74) 0%, rgba(13,14,16,.38) 48%, rgba(13,14,16,0) 100%);
  opacity: 0; transition: opacity 1.1s var(--jgt-ease);
}
.jgt.card-on .jgt-scrim { opacity: 1; }
.jgt-card {
  position: absolute; left: calc(var(--safe-l, 0px) + 24px); right: calc(var(--safe-r, 0px) + 24px);
  top: calc(7.2% + var(--safe-t, 0px) + 40px);
  display: grid; grid-template-columns: auto 1fr; column-gap: 14px; align-items: center;
}
.jgt-eyebrow {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
  font: 500 9.5px/1 var(--jgt-mono); letter-spacing: .26em; color: var(--jgt-signal);
}
.jgt-eyebrow::before { content: ''; width: 22px; height: 1px; background: currentColor; }
.jgt-mark { width: 38px; height: 38px; color: var(--jgt-signal); }
.jgt-mark svg { width: 100%; height: 100%; display: block; }
.jgt-title {
  margin: 0; font: 800 54px/.86 var(--jgt-display); letter-spacing: .06em; text-transform: uppercase;
  color: var(--jgt-chalk); white-space: nowrap; text-shadow: 0 2px 24px rgba(0,0,0,.45);
}
.jgt-rule {
  grid-column: 1 / -1; height: 1px; margin: 14px 0 10px; background: rgba(255,255,255,.22);
  transform-origin: 0 50%;
}
.jgt-specs { grid-column: 1 / -1; display: flex; gap: 22px; }
.jgt-spec { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.jgt-spec + .jgt-spec { padding-left: 22px; border-left: 1px solid rgba(255,255,255,.12); }
.jgt-spec small {
  font: 500 8.5px/1 var(--jgt-mono); letter-spacing: .2em; color: var(--jgt-fog); white-space: nowrap;
}
.jgt-spec b {
  font: 600 17px/1 var(--jgt-display); letter-spacing: .1em; color: var(--c-bone, ${PALETTE.bone}); white-space: nowrap;
}
/* reveal: each row wipes in from the left, staggered */
.jgt-card > * { opacity: 0; transform: translateX(-14px); }
.jgt-card .jgt-rule { transform: scaleX(0); }
.jgt.card-on .jgt-card > * {
  opacity: 1; transform: none;
  transition: opacity .6s var(--jgt-ease), transform .8s var(--jgt-ease);
  transition-delay: calc(var(--i, 0) * 90ms);
}
.jgt.card-off .jgt-card > * {
  opacity: 0; transform: translateY(-8px);
  transition: opacity .45s var(--jgt-ease), transform .5s var(--jgt-ease);
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
  private skipFn: (() => void) | null = null;
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
    [eyebrow, mark, title, rule, specs].forEach((e, i) => e.style.setProperty('--i', String(i === 2 ? 1 : i)));
    card.append(eyebrow, mark, title, rule, specs);

    this.skipBtn = doc.createElement('button');
    this.skipBtn.type = 'button';
    this.skipBtn.className = 'jgt-skip';
    this.skipBtn.setAttribute('aria-label', 'Skip intro');
    this.skipBtn.innerHTML = '<span>SKIP</span>' + SKIP_ICON;
    this.skipBtn.addEventListener('click', this.onSkip);

    this.el.append(div(doc, 'jgt-scrim'), top, bot, card, this.skipBtn);
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
    this.el.classList.remove('on', 'card-on', 'has-skip');
    this.el.classList.add('leave');
    const el = this.el;
    setTimeout(() => el.remove(), 900);
  }

  private readonly onSkip = (e: Event): void => {
    e.stopPropagation();
    this.skipFn?.();
  };
}

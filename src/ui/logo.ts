// Brand marks for the UI, all built from the official outlined CHIRAL SPORTS assets in BRAND
// (src/config/brand.ts). The live-text lockup file in assets/brand/ is never rendered.
//
//   chiralMark()      the two-swoosh mark (reads like a pair of ibex horns)
//   chiralWordmark()  "CHIRAL SPORTS" outlined wordmark
//   chiralLockup()    official mark + wordmark lockup (single colour)
//   gameLockup()      the STEIBOCK title treatment: horn-mark crest, tracked display title,
//                     and a "BY CHIRAL SPORTS" brand line set in the official wordmark

import { BRAND } from '../config/brand';
import { el, fromMarkup } from './dom';

function brandSvg(markup: string, cls: string, label?: string): SVGSVGElement {
  const svg = fromMarkup<SVGSVGElement>(markup);
  svg.setAttribute('class', cls);
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  return svg;
}

/** The CHIRAL SPORTS mark, single colour via currentColor. */
export function chiralMark(cls = ''): SVGSVGElement {
  return brandSvg(BRAND.logoSvg, `chiral-mark ${cls}`.trim());
}

/** The CHIRAL SPORTS wordmark (outlined paths), single colour via currentColor. */
export function chiralWordmark(cls = ''): SVGSVGElement {
  return brandSvg(BRAND.wordmarkSvg, `chiral-wordmark ${cls}`.trim(), `${BRAND.name} ${BRAND.sub}`);
}

/** Official mark + wordmark lockup (spacing from the brand file), single colour. */
export function chiralLockup(cls = ''): SVGSVGElement {
  return brandSvg(BRAND.lockupSvg, `chiral-lockup ${cls}`.trim(), `${BRAND.name} ${BRAND.sub}`);
}

/**
 * The game title lockup. `size` picks the scale:
 *  hero  — splash (crest + large title, letters assemble on entry)
 *  title — main menu over the live wall
 *  small — compact headers (no crest)
 */
export function gameLockup(size: 'hero' | 'title' | 'small' = 'title'): HTMLElement {
  const title = el('h1', 'lk-title');
  title.setAttribute('aria-label', BRAND.game);
  const letters = [...BRAND.game];
  letters.forEach((ch, k) => {
    const s = el('span', 'lk-l', ch);
    s.setAttribute('aria-hidden', 'true');
    s.style.setProperty('--k', String(k));
    // centred index (-3.5 … 3.5 for 8 letters) drives the "assemble" entrance on the splash
    s.style.setProperty('--d', String(k - (letters.length - 1) / 2));
    title.appendChild(s);
  });
  const by = el('div', 'lk-by', el('i', 'lk-rule'), el('span', 'lk-by-txt', 'BY'), chiralWordmark('lk-word'), el('i', 'lk-rule'));
  return el('div', `lockup lockup-${size}`, size === 'small' ? null : el('div', 'lk-crest', chiralMark()), title, by);
}

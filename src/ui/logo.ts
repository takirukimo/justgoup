// CHIRAL mark + JUST GO UP lockups, built from BRAND (src/config/brand.ts).

import { BRAND } from '../config/brand';
import { el, fromMarkup } from './dom';

/** The CHIRAL logo mark (two mirror-image shards), single colour via currentColor. */
export function chiralMark(cls = ''): SVGSVGElement {
  const svg = fromMarkup<SVGSVGElement>(BRAND.logoSvg);
  svg.setAttribute('class', `chiral-mark ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** Mark + "CHIRAL" wordmark + "SPORTS" sub. */
export function chiralLockup(cls = ''): HTMLElement {
  return el(
    'div',
    `chiral-lockup ${cls}`.trim(),
    chiralMark(),
    el('span', 'cl-word', BRAND.name),
    el('span', 'cl-sub', BRAND.sub),
  );
}

/**
 * The game title lockup. `size` picks the typographic scale:
 *  hero  — splash (huge, stacked)
 *  title — main menu
 *  small — headers
 */
export function gameLockup(size: 'hero' | 'title' | 'small' = 'title'): HTMLElement {
  const words = BRAND.game.split(' ');
  const last = words.pop() ?? '';
  const title = el(
    'h1',
    'lk-title',
    el('span', 'lk-a', words.join(' ')),
    el(
      'span',
      'lk-b',
      last,
      fromMarkup<SVGSVGElement>(
        '<svg class="lk-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15 12 6l9 9" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="square"/></svg>',
      ),
    ),
  );
  title.setAttribute('aria-label', BRAND.game);
  return el(
    'div',
    `lockup lockup-${size}`,
    el('div', 'lk-kicker', chiralMark(), el('span', null, `${BRAND.name} ${BRAND.sub}`), el('span', 'lk-rule')),
    title,
    el('div', 'lk-tag', BRAND.tagline),
  );
}

// Splash: the STEIBOCK key art full-bleed, the CHIRAL mark over STEIBOCK · BY CHIRAL SPORTS, and
// "TAP TO START" (the first tap also unlocks audio). Nothing else on it (owner).

import keyArt from '../../../assets/art/steibock-key-art.webp';
import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { BRAND } from '../../config/brand';
import { el } from '../dom';
import { gameLockup } from '../logo';
import { screenRoot } from '../parts';
import type { ScreenView, UICtx } from '../screen';

// Start fetching + decoding the art as soon as the UI module loads (while the 3D scene boots), so
// it is ready the moment the splash goes up.
if (typeof Image !== 'undefined') {
  const warm = new Image();
  warm.decoding = 'async';
  warm.src = keyArt;
  void warm.decode?.().catch(() => {});
}

export function createSplash(_ctx: UICtx, _props: ScreenProps['splash']): ScreenView<ScreenProps['splash']> {
  const root = screenRoot('splash');
  let fired = false;
  const tap = el('button', 'splash-hit');
  tap.type = 'button';
  tap.setAttribute('aria-label', `${BRAND.game}. Tap to start`);
  tap.addEventListener('click', () => {
    if (fired) return;
    fired = true;
    root.classList.add('splash-go');
    bus.emit('ui:start-intro-done');
  });

  const art = el('img', 'splash-art');
  art.alt = '';
  art.src = keyArt;

  root.append(
    el('div', 'splash-bg', art, el('div', 'splash-scrim')),
    el('div', 'splash-center', gameLockup('hero')),
    el('div', 'splash-bottom', el('div', 'splash-cta', el('span', 'cta-line'), el('span', 'cta-txt', 'TAP TO START'), el('span', 'cta-line'))),
    tap,
  );
  return { el: root, update: () => undefined, reuse: true };
}

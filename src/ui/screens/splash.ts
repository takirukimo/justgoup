// Splash: CHIRAL mark, JUST GO UP lockup, drifting topo, "TAP TO START" (unlocks audio).

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { BRAND } from '../../config/brand';
import { el, label } from '../dom';
import { chiralMark, gameLockup } from '../logo';
import { screenRoot, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

export function createSplash(_ctx: UICtx, _props: ScreenProps['splash']): ScreenView<ScreenProps['splash']> {
  const root = screenRoot('splash');
  let fired = false;
  const tap = el('button', 'splash-hit');
  tap.type = 'button';
  tap.setAttribute('aria-label', 'Tap to start');
  tap.addEventListener('click', () => {
    if (fired) return;
    fired = true;
    root.classList.add('splash-go');
    bus.emit('ui:start-intro-done');
  });

  const year = new Date().getFullYear();
  root.append(
    el('div', 'splash-bg', topoLayer('topo-drift topo-a'), topoLayer('topo-drift topo-b'), el('div', 'splash-sweep'), el('div', 'splash-vig')),
    el(
      'div',
      'splash-frame',
      el('span', 'reg reg-tl'),
      el('span', 'reg reg-tr'),
      el('span', 'reg reg-bl'),
      el('span', 'reg reg-br'),
    ),
    el(
      'div',
      'splash-top',
      label('46°57′N  07°26′E', 'stg'),
      label(`${BRAND.gym} · ALT 0542 M`, 'stg'),
    ),
    el(
      'div',
      'splash-center',
      el('div', 'splash-mark stg', chiralMark()),
      el('div', 'splash-presents stg', el('span', null, BRAND.name), el('i'), el('span', null, 'PRESENTS')),
      gameLockup('hero'),
    ),
    el(
      'div',
      'splash-bottom',
      el('div', 'splash-cta', el('span', 'cta-line'), el('span', 'cta-txt', 'TAP TO START'), el('span', 'cta-line')),
      el('div', 'splash-legal', label(`© ${year} ${BRAND.name} ${BRAND.sub}`), label('BUILD 0.1 · HANDHELD EDITION')),
    ),
    tap,
  );
  return { el: root, update: () => undefined, reuse: true };
}

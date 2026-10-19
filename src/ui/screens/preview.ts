// Route-reading overlay: compact spec card on top, clear middle, tip + TAP TO START below.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { BRAND, ROUTE_COLORS } from '../../config/brand';
import { gradeWord } from '../../game/grades';
import { backButton, el, label, setChildren } from '../dom';
import { icon } from '../icons';
import { fontG, modeTitle, wallLabel } from '../format';
import { gradeChip, screenRoot, specCell, steiniTip, swatch, tapeChip } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['preview'];

/** Route name, a size smaller for long names so it rarely needs an ellipsis. */
function nameEl(name: string): HTMLElement {
  const h = el('h2', 'pv-name', name);
  const n = name.length;
  if (n > 13) h.style.setProperty('--pv-fs', n > 18 ? '20px' : '23px');
  return h;
}

function colourName(hex: string): string {
  const h = hex.toLowerCase();
  return ROUTE_COLORS.find((c) => c.hex.toLowerCase() === h)?.name ?? 'Route';
}

export function createPreview(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('preview');
  const card = el('div', 'pv-card glass stg');
  const tipSlot = el('div', 'pv-tip-slot');
  let fired = false;

  const start = (): void => {
    if (fired) return;
    fired = true;
    root.classList.add('pv-go');
    bus.emit('ui:begin-climb');
  };

  const hit = el('button', 'pv-hit');
  hit.type = 'button';
  hit.setAttribute('aria-label', 'Tap to start');
  hit.addEventListener('click', start);

  const render = (p: P): void => {
    const b = p.boulder;
    const routeHolds = b.holds.filter((h) => h.role !== 'deco').length;
    const wall = wallLabel(b);
    const run = p.run;
    const mode = (modeTitle[run.mode] ?? run.mode).toUpperCase();
    const runBits =
      run.mode === 'boulder' && run.streak > 0
        ? `STREAK ×${run.streak}`
        : b.author
          ? `BY ${b.author.toUpperCase()}`
          : b.mode === 'rope'
            ? `${b.quickdraws?.length ?? 0} DRAWS`
            : run.mode === 'boulder'
              ? `BOULDER ${String(run.streak + 1).padStart(2, '0')}`
              : run.mode === 'daily'
                ? 'TODAY'
                : BRAND.gym;
    setChildren(
      card,
      el('div', 'pv-row1', label(`${mode} · ${runBits}${wall.style ? ` · ${wall.style}` : ''}`, 'pv-kicker'), el('span', 'pv-read', icon('eye'), 'READ THE LINE')),
      el('div', 'pv-row2', nameEl(b.name), gradeChip(b.grade, { size: 'lg' })),
      el(
        'div',
        'pv-specs',
        specCell('FONT', fontG(b.grade), undefined, 'spec-sm'),
        specCell(wall.kind, wall.value, undefined, 'spec-sm spec-wall'),
        b.mode === 'rope' ? specCell('HEIGHT', `${b.height} M`, undefined, 'spec-sm') : specCell('HOLDS', String(routeHolds), undefined, 'spec-sm'),
        specCell('COLOUR', el('span', 'pv-col', swatch(b.color), colourName(b.color)), undefined, 'spec-sm'),
      ),
      el(
        'div',
        'pv-legend',
        el('span', 'lg', tapeChip('START', b.color)),
        el('span', 'lg', tapeChip('TOP', b.color), b.mode === 'rope' ? 'CLIP THE ANCHOR' : 'MATCH BOTH HANDS'),
        el('span', 'pv-word', gradeWord(b.grade).toUpperCase()),
      ),
    );
    setChildren(tipSlot, p.tip ? steiniTip(ctx.portraits, p.tip, 'pv-tip stg') : null);
  };
  render(props);

  const back = backButton();
  back.classList.add('pv-back');
  root.append(
    el('div', 'scrim scrim-top scrim-soft'),
    el('div', 'scrim scrim-bottom scrim-soft'),
    hit,
    el('div', 'pv-top', back, card),
    el('div', 'pv-flex'),
    el(
      'div',
      'pv-bottom',
      tipSlot,
      el('div', 'pv-start stg', el('span', 'pv-start-ring'), el('span', 'pv-start-txt', 'TAP TO START'), label('CLOCK AND PUMP START ON TAP')),
    ),
  );
  return { el: root, update: render, reuse: false };
}

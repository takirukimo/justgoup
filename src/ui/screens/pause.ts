// Pause: resume / retry / quit, plus SFX & music quick toggles.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { GAME } from '../../config/tuning';
import { button, el, label, setChildren, stagger } from '../dom';
import { icon } from '../icons';
import { fmtInt, modeTitle } from '../format';
import { gradeChip, screenRoot, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['pause'];

export function createPause(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('pause', 'scr-dim');
  const info = el('div', 'pz-info');
  // Remember the level a channel had before muting so un-muting restores it.
  const restore = { sfx: 0.8, music: 0.6 };

  const render = (p: P): void => {
    const r = p.run;
    // Only the numbers that mean something in this mode.
    const stats: [string, string][] = [];
    if (r.mode === 'boulder') stats.push(['RUN SCORE', fmtInt(r.score)], ['STREAK', `×${r.streak}`]);
    else if (r.mode === 'rope') {
      stats.push(['SCORE', fmtInt(r.score)], ['HEIGHT', `${(r.heightM ?? 0).toFixed(1)} m`]);
      if (r.lives !== undefined) stats.push(['LIVES', `${r.lives}/${GAME.ropeLives}`]);
    }
    if (r.hintsLeft !== undefined && r.mode !== 'tutorial') stats.push(['HINTS LEFT', String(r.hintsLeft)]);
    setChildren(
      info,
      label(`${(modeTitle[r.mode] ?? r.mode).toUpperCase()} · ON THE WALL`),
      el('div', 'pz-route', el('span', 'pz-name', r.boulderName), gradeChip(r.grade)),
      stats.length ? el('div', 'pz-stats', ...stats.map(([k, v]) => el('span', null, label(k), el('b', 't-num', v)))) : null,
    );
  };
  render(props);

  const quick = (kind: 'sfx' | 'music'): HTMLButtonElement => {
    const b = button({ variant: 'glass', cls: 'pz-quick', aria: kind === 'sfx' ? 'Sound effects' : 'Music' });
    const paint = (): void => {
      const v = ctx.getSettings()[kind];
      const on = v > 0.001;
      b.classList.toggle('off', !on);
      b.replaceChildren(
        icon(kind === 'sfx' ? (on ? 'sound' : 'mute') : 'music', 'btn-ic'),
        el('span', 'btn-lbl', kind === 'sfx' ? 'SFX' : 'MUSIC'),
        el('span', 'pz-q-state', on ? 'ON' : 'OFF'),
      );
    };
    b.addEventListener('click', () => {
      const s = { ...ctx.getSettings() };
      if (s[kind] > 0.001) {
        restore[kind] = s[kind];
        s[kind] = 0;
      } else s[kind] = restore[kind] || 0.7;
      ctx.commitSettings(s);
      paint();
    });
    paint();
    return b;
  };

  const card = el(
    'div',
    'pz-card glass',
    topoLayer('pz-topo'),
    stagger(el('div', 'pz-head', el('span', 'pz-ic', icon('pause')), el('h2', 'pz-h', 'Paused')), 0),
    stagger(info, 1),
    stagger(
      button({ label: 'RESUME', icon: 'play', variant: 'primary', cls: 'btn-xl', onTap: () => bus.emit('ui:resume') }),
      2,
    ),
    stagger(
      el(
        'div',
        'pz-row',
        // In a run, restarting means a new run; on a single problem it restarts that climb.
        button({ label: props.run.mode === 'boulder' || props.run.mode === 'rope' ? 'NEW RUN' : 'RESTART', icon: 'retry', variant: 'glass', onTap: () => bus.emit('ui:retry') }),
        button({ label: 'QUIT', icon: 'home', variant: 'glass', onTap: () => bus.emit('ui:quit') }),
      ),
      3,
    ),
    stagger(el('div', 'pz-row pz-quickrow', quick('sfx'), quick('music')), 4),
  );
  root.append(card);
  return { el: root, update: render };
}

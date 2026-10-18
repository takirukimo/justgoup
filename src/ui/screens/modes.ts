// Mode select: spec-sheet cards for every way to climb.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { GAME } from '../../config/tuning';
import { button, el, label, setChildren, stagger } from '../dom';
import { icon, type IconName } from '../icons';
import { fmtDateKey, fmtInt, pad2 } from '../format';
import { header, screenRoot, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['modes'];

interface ModeCard {
  code: string;
  title: string;
  icon: IconName;
  desc: string;
  specs: [string, string][];
  tag?: string;
  featured?: boolean;
  compact?: boolean;
  go: () => void;
}

export function createModes(_ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('modes', 'scr-panel');
  const list = el('div', 'modes-list scroll');

  const render = (p: P): void => {
    const pr = p.profile;
    const dailyBest = p.dailyBest ?? pr.best.daily[p.dailyKey];
    const cards: ModeCard[] = [
      {
        code: 'ST-01',
        title: 'Send Train',
        icon: 'train',
        desc: 'Endless boulders that get harder with every send. One fall ends the run.',
        specs: [
          ['FORMAT', 'Endless'],
          ['GRADES', 'V0 → V12'],
          ['BEST', pr.best.boulder > 0 ? fmtInt(pr.best.boulder) : '—'],
        ],
        tag: 'RANKED',
        featured: true,
        go: () => bus.emit('ui:play', { mode: 'boulder' }),
      },
      {
        code: 'LT-15',
        title: 'Lead Tower',
        icon: 'tower',
        desc: `A ${GAME.ropeWall.height} m lead route. Clip every quickdraw on the way up. A whipper costs a life.`,
        specs: [
          ['HEIGHT', `${GAME.ropeWall.height} m`],
          ['LIVES', String(GAME.ropeLives)],
          ['BEST', pr.best.rope > 0 ? fmtInt(pr.best.rope) : '—'],
        ],
        tag: 'ROPE',
        go: () => bus.emit('ui:play', { mode: 'rope' }),
      },
      {
        code: 'DB-' + p.dailyKey.slice(5).replace('-', ''),
        title: 'Daily Boulder',
        icon: 'calendar',
        desc: 'One problem per day, the same for every climber. It resets at 00:00 UTC.',
        specs: [
          ['DATE', fmtDateKey(p.dailyKey)],
          ['YOUR BEST', dailyBest ? fmtInt(dailyBest) : 'Not yet'],
        ],
        tag: 'TODAY',
        go: () => bus.emit('ui:play', { mode: 'daily' }),
      },
      {
        code: 'CM-UGC',
        title: 'Community',
        icon: 'community',
        desc: 'Problems set by other climbers. Send theirs, then set your own.',
        specs: [
          ['SOURCE', 'Players'],
          ['SET YOURS', 'Editor'],
        ],
        go: () => bus.emit('ui:open', { screen: 'community' }),
      },
      {
        code: 'TU-00',
        title: 'Tutorial',
        icon: 'horns',
        desc: 'Steini teaches you hands, feet, hips and the shake-out. About three minutes.',
        specs: [['STATUS', pr.tutorialDone ? 'Complete' : 'Recommended']],
        compact: true,
        go: () => bus.emit('ui:tutorial'),
      },
    ];

    setChildren(
      list,
      ...cards.map((c, i) => {
        const card = button({ variant: 'plain', cls: `mode-card${c.featured ? ' mode-featured' : ''}${c.compact ? ' mode-compact' : ''}`, aria: c.title, onTap: c.go });
        card.append(
          c.featured ? topoLayer('mode-topo') : '',
          el(
            'div',
            'mc-head',
            el('span', 'mc-ic', icon(c.icon)),
            el('div', 'mc-titles', el('div', 'mc-coderow', label(`${pad2(i + 1)} — ${c.code}`, 'mc-code'), c.tag ? el('span', 'mc-tag', c.tag) : ''), el('h3', 'mc-title', c.title)),
            el('span', 'mc-go', icon(c.featured ? 'play' : 'chevron')),
          ),
          el('p', 'mc-desc', c.desc),
          el('div', 'mc-specs', ...c.specs.map(([k, v]) => el('div', 'mc-spec', label(k), el('span', 'mc-v', v)))),
        );
        return stagger(card, i + 1);
      }),
    );
  };
  render(props);

  root.append(topoLayer('panel-topo'), header({ title: 'Choose mode', kicker: 'SELECT · 05 MODES' }), list);
  return { el: root, update: render };
}

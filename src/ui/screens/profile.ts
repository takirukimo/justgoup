// Profile: portrait + name (editable), lifetime stats spec sheet, personal bests, loadout.

import type { ScreenProps } from '../../core/contracts';
import { CHALKS, COLORWAYS, HEADS } from '../../config/skins';
import { button, el, label, setChildren, stagger } from '../dom';
import { icon } from '../icons';
import { fmtInt, grade, pad2, pct } from '../format';
import { header, screenRoot, specCell, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['profile'];

export function createProfile(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('profile', 'scr-panel');
  const body = el('div', 'pf-body scroll');

  const render = (p: P, animate: boolean): void => {
    const pr = p.profile;
    const st = pr.stats;
    const head = HEADS.find((h) => h.id === pr.head) ?? HEADS[0];
    const cw = COLORWAYS.find((c) => c.id === pr.colorway) ?? COLORWAYS[0];
    const ch = CHALKS.find((c) => c.id === pr.chalk) ?? CHALKS[0];
    const total = HEADS.length + COLORWAYS.length + CHALKS.length;
    const have = pr.unlocked.heads.length + pr.unlocked.colorways.length + pr.unlocked.chalks.length;
    const sg = <T extends HTMLElement>(e: T, i: number): T => (animate ? stagger(e, i) : e);

    const edit = button({
      icon: 'edit',
      label: 'EDIT NAME',
      variant: 'ghost',
      cls: 'pf-edit',
      onTap: () => ctx.show('name', { current: pr.playerName }),
    });

    const hero = el(
      'div',
      'pf-hero glass',
      topoLayer('pf-topo'),
      el('div', 'pf-pt', ctx.portraits.frame(pr.head, 'pt-hero'), el('span', 'pf-ring')),
      el(
        'div',
        'pf-id',
        label(`CLIMBER · ${head.name.toUpperCase()}`),
        el('h2', 'pf-name', pr.playerName || 'New climber'),
        el('div', 'pf-pts', el('b', 't-num', fmtInt(st.totalScore)), el('span', null, 'LIFETIME PTS')),
        edit,
      ),
    );

    const cells: [string, string, string?][] = [
      ['SENDS', fmtInt(st.sends)],
      ['FLASHES', fmtInt(st.flashes)],
      ['HIGHEST GRADE', st.sends > 0 ? grade(st.highestGrade) : '—'],
      ['METERS CLIMBED', fmtInt(st.metersClimbed), 'm'],
      ['LONGEST STREAK', fmtInt(st.longestStreak)],
      ['QUICKDRAWS CLIPPED', fmtInt(st.clips)],
      ['FALLS', fmtInt(st.falls)],
      ['SEND RATE', pct(st.sends, st.sends + st.falls)],
    ];
    const grid = el(
      'div',
      'pf-grid',
      ...cells.map(([k, v, u], i) => {
        const c = specCell(k, v, u, 'pf-cell');
        c.prepend(el('span', 'pf-idx t-num', pad2(i + 1)));
        return c;
      }),
    );

    const dailyBest = Object.values(pr.best.daily).reduce((a, b) => Math.max(a, b), 0);
    const bests = el(
      'div',
      'pf-bests',
      el('div', 'pb', icon('train'), el('span', null, label('SEND TRAIN'), el('b', 't-num', pr.best.boulder ? fmtInt(pr.best.boulder) : '—'))),
      el('div', 'pb', icon('tower'), el('span', null, label('LEAD TOWER'), el('b', 't-num', pr.best.rope ? fmtInt(pr.best.rope) : '—'))),
      el('div', 'pb', icon('calendar'), el('span', null, label('BEST DAILY'), el('b', 't-num', dailyBest ? fmtInt(dailyBest) : '—'))),
    );

    const loadout = el(
      'div',
      'pf-loadout',
      el('span', null, label('HEAD'), el('b', null, head.name)),
      el('span', null, label('COLOURWAY'), el('b', null, cw.name)),
      el('span', null, label('CHALK'), el('b', null, ch.name)),
      el('span', null, label('UNLOCKED'), el('b', 't-num', `${have}/${total}`)),
    );

    setChildren(
      body,
      sg(hero, 1),
      sg(el('div', 'pf-sec', el('div', 'set-sec-h', label('LIFETIME · SPEC SHEET'), el('i', 'set-rule')), grid), 2),
      sg(el('div', 'pf-sec', el('div', 'set-sec-h', label('PERSONAL BESTS'), el('i', 'set-rule')), bests), 3),
      sg(el('div', 'pf-sec', el('div', 'set-sec-h', label('LOADOUT'), el('i', 'set-rule')), loadout), 4),
    );
  };

  root.append(topoLayer('panel-topo'), header({ title: 'Profile', kicker: 'CLIMBER · STATS' }), body);
  render(props, true);
  return { el: root, update: (p) => render(p, false) };
}

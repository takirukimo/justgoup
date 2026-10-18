// Title: transparent over the live 3D wall. Lockup on top, profile chip, PLAY + secondary grid.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { HEADS } from '../../config/skins';
import { button, el, label, setChildren, stagger } from '../dom';
import { icon } from '../icons';
import { fmtInt } from '../format';
import { gameLockup } from '../logo';
import { backendBadge, screenRoot } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['title'];

export function createTitle(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('title');
  const chipSlot = el('div', 'title-chip-slot');
  const badgeSlot = el('div', 'title-badge-slot');

  const renderTop = (p: P): void => {
    const pr = p.profile;
    const head = HEADS.find((h) => h.id === pr.head) ?? HEADS[0];
    const chip = button({
      variant: 'plain',
      cls: 'profile-chip',
      aria: 'Profile',
      onTap: () => bus.emit('ui:open', { screen: 'profile' }),
    });
    chip.append(
      ctx.portraits.frame(pr.head, 'pt-chip'),
      el(
        'span',
        'pc-txt',
        el('span', 'pc-name', pr.playerName || 'New climber'),
        el('span', 'pc-pts', el('b', 't-num', fmtInt(pr.stats.totalScore)), ' PTS · ', head.name.toUpperCase()),
      ),
      icon('chevron', 'pc-chev'),
    );
    setChildren(chipSlot, chip);
    setChildren(badgeSlot, backendBadge(p.backendLabel));
  };
  renderTop(props);

  const play = button({
    label: 'PLAY',
    icon: 'arrow',
    iconAfter: true,
    variant: 'primary',
    cls: 'btn-xl title-play',
    onTap: () => bus.emit('ui:open', { screen: 'modes' }),
  });
  play.prepend(el('span', 'play-kicker', label('SEND TRAIN · LEAD · DAILY')));

  const tiles: [string, Parameters<typeof icon>[0], () => void][] = [
    ['LEADERBOARD', 'podium', () => bus.emit('ui:open', { screen: 'leaderboard' })],
    ['LOCKER', 'hanger', () => bus.emit('ui:open', { screen: 'locker' })],
    ['CREATE', 'create', () => bus.emit('ui:open', { screen: 'editor' })],
    ['COMMUNITY', 'community', () => bus.emit('ui:open', { screen: 'community' })],
    ['PROFILE', 'user', () => bus.emit('ui:open', { screen: 'profile' })],
    ['SETTINGS', 'tune', () => bus.emit('ui:open', { screen: 'settings' })],
  ];
  const grid = el('nav', 'title-grid');
  tiles.forEach(([lbl, ic, fn], i) => grid.appendChild(stagger(button({ label: lbl, icon: ic, variant: 'tile', onTap: fn }), 6 + i)));

  root.append(
    el('div', 'scrim scrim-top'),
    el('div', 'scrim scrim-bottom'),
    el('div', 'title-top', stagger(chipSlot, 0), stagger(badgeSlot, 1)),
    stagger(el('div', 'title-lockup'), 2),
    el('div', 'title-flex'),
    el('div', 'title-bottom', stagger(play, 4), grid),
  );
  root.querySelector('.title-lockup')!.appendChild(gameLockup('title'));

  return {
    el: root,
    update: (p) => renderTop(p),
  };
}

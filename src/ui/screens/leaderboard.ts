// Leaderboard: Send Train / Lead Tower / Daily tabs, podium for the top three, ranked rows.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import type { LeaderboardMode, ScoreEntry } from '../../core/types';
import { button, el, label, setChildren, stagger } from '../dom';
import { fmtDateKey, fmtInt, grade, pad2 } from '../format';
import { emptyState, header, onlineBadge, screenRoot, segmented, skeletons, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['leaderboard'];

const TABS: { id: LeaderboardMode; label: string }[] = [
  { id: 'boulder', label: 'SEND TRAIN' },
  { id: 'rope', label: 'LEAD TOWER' },
  { id: 'daily', label: 'DAILY' },
];

const MEDAL = ['m-1', 'm-2', 'm-3'];

export function createLeaderboard(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('leaderboard', 'scr-panel');
  let cur = props;
  const badgeSlot = el('div', 'lb-badge');
  const sub = el('div', 'lb-sub');
  const body = el('div', 'lb-body scroll');

  const isMe = (e: ScoreEntry, me: string): boolean => !!me && e.player.trim().toLowerCase() === me.trim().toLowerCase();

  const subline = (e: ScoreEntry, mode: LeaderboardMode): string =>
    mode === 'rope' ? `MAX ${grade(e.maxGrade)}` : `${e.sends} ${e.sends === 1 ? 'SEND' : 'SENDS'} · MAX ${grade(e.maxGrade)}`;

  const render = (p: P): void => {
    cur = p;
    tabs.set(p.mode);
    setChildren(badgeSlot, onlineBadge(p.isGlobal));
    setChildren(
      sub,
      label(p.mode === 'daily' ? `DAILY BOULDER · ${fmtDateKey(p.dailyKey)}` : p.mode === 'rope' ? 'LEAD TOWER · 15 M · ALL TIME' : 'SEND TRAIN · ENDLESS · ALL TIME'),
      label(p.entries ? `${p.entries.length} CLIMBERS` : 'LOADING'),
    );

    if (p.entries === null) {
      setChildren(body, el('div', 'lb-skel', ...skeletons(7, 'skel-row')));
      return;
    }
    const entries = [...p.entries].sort((a, b) => b.score - a.score);
    if (!entries.length) {
      setChildren(
        body,
        emptyState({
          icon: 'podium',
          title: 'No scores yet',
          body: p.mode === 'daily' ? 'Nobody has sent today’s boulder. Be the first name on the board.' : 'The board is empty. Send something and claim the top spot.',
          action: button({
            label: p.mode === 'daily' ? 'CLIMB TODAY’S BOULDER' : p.mode === 'rope' ? 'CLIMB THE TOWER' : 'START A SEND TRAIN',
            icon: 'play',
            variant: 'primary',
            onTap: () => bus.emit('ui:play', { mode: p.mode }),
          }),
        }),
      );
      return;
    }

    const podium = entries.length >= 3 ? el('div', 'podium') : null;
    if (podium) {
      [1, 0, 2].forEach((idx, k) => {
        const e = entries[idx];
        const col = el(
          'div',
          `pd-col pd-${idx + 1} ${isMe(e, p.me) ? 'is-me' : ''}`,
          el('div', 'pd-pt', ctx.portraits.frame(e.head, `pt-pd ${MEDAL[idx]}`), el('span', `pd-rank ${MEDAL[idx]}`, String(idx + 1))),
          el('span', 'pd-name', e.player),
          el('b', 'pd-score t-num', fmtInt(e.score)),
          el('div', 'pd-block', label(subline(e, p.mode).split(' · ').pop() ?? '')),
        );
        podium.appendChild(stagger(col, k));
      });
    }

    const list = el('ol', 'lb-list');
    const start = podium ? 3 : 0;
    entries.slice(start).forEach((e, i) => {
      const rank = start + i + 1;
      const me = isMe(e, p.me);
      const row = el(
        'li',
        `lb-row ${rank <= 3 ? MEDAL[rank - 1] : ''} ${me ? 'is-me' : ''}`.trim(),
        el('span', 'lb-rank t-num', pad2(rank)),
        ctx.portraits.frame(e.head, 'pt-row'),
        el('span', 'lb-who', el('span', 'lb-name', e.player, me ? el('i', 'you-tag', 'YOU') : null), label(subline(e, p.mode))),
        el('b', 'lb-score t-num', fmtInt(e.score)),
      );
      list.appendChild(stagger(row, 3 + Math.min(i, 12)));
    });
    setChildren(body, podium, list);
  };

  const tabs = segmented<LeaderboardMode>({
    options: TABS,
    value: props.mode,
    cls: 'lb-tabs',
    onChange: (mode) => {
      render({ ...cur, mode, entries: null });
      bus.emit('ui:leaderboard-tab', { mode });
    },
  });

  root.append(
    topoLayer('panel-topo'),
    header({ title: 'Leaderboard', kicker: 'RANKINGS', right: badgeSlot }),
    stagger(el('div', 'lb-controls', tabs.el, sub), 1),
    body,
  );
  render(props);
  return { el: root, update: render };
}

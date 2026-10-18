// Leaderboard: Send Train / Lead Tower / Daily tabs, podium for the top three, ranked rows.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import type { LeaderboardMode, ScoreEntry } from '../../core/types';
import { button, el, label, setChildren, stagger } from '../dom';
import { icon } from '../icons';
import { fmtDateKey, fmtInt, grade, pad2 } from '../format';
import { backendBadge, backendKind, backendNote, emptyState, header, screenRoot, segmented, skeletons, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['leaderboard'];

const TABS: { id: LeaderboardMode; label: string }[] = [
  { id: 'boulder', label: 'SEND TRAIN' },
  { id: 'rope', label: 'LEAD TOWER' },
  { id: 'daily', label: 'DAILY' },
];

const MEDAL = ['m-1', 'm-2', 'm-3'];

/** The offline board is seeded with fictional pace-setters; their ids start with 'ghost-' (src/net/ghosts.ts). */
const isGhost = (e: ScoreEntry): boolean => typeof e.id === 'string' && e.id.startsWith('ghost-');

export function createLeaderboard(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('leaderboard', 'scr-panel');
  let cur = props;
  const badgeSlot = el('div', 'lb-badge');
  const meta = el('span', 'lb-meta');
  const sub = el('div', 'lb-sub', badgeSlot, meta);
  const note = el('p', 'board-note');
  const body = el('div', 'lb-body scroll');

  const isMe = (e: ScoreEntry, me: string): boolean => !!me && e.player.trim().toLowerCase() === me.trim().toLowerCase();

  const subline = (e: ScoreEntry, mode: LeaderboardMode): string =>
    mode === 'rope' ? `MAX ${grade(e.maxGrade)}` : `${e.sends} ${e.sends === 1 ? 'SEND' : 'SENDS'} · MAX ${grade(e.maxGrade)}`;

  const render = (p: P): void => {
    cur = p;
    tabs.set(p.mode);
    const label0 = ctx.backendLabel(p.isGlobal);
    const kind = backendKind(label0);
    setChildren(badgeSlot, backendBadge(label0));
    const scope = p.mode === 'daily' ? fmtDateKey(p.dailyKey) : 'ALL TIME';
    const n = p.entries?.length ?? 0;
    meta.textContent = p.entries ? `${scope} · ${n} ${n === 1 ? 'CLIMBER' : 'CLIMBERS'}` : `${scope} · LOADING`;
    // Offline is the case worth explaining; a live board needs no footnote.
    note.hidden = kind !== 'offline';
    setChildren(note, icon('offline', 'bn-ic'), el('span', null, backendNote(kind, 'scores')));

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
          title: p.mode === 'daily' ? 'No sends today' : 'No scores yet',
          body:
            p.mode === 'daily'
              ? 'Nobody has sent today’s boulder yet. Be the first name on the board.'
              : p.mode === 'rope'
                ? 'Nobody has climbed the tower yet. Clip a few draws and the top spot is yours.'
                : 'The board is empty. Send a few boulders and claim the top spot.',
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
          el(
            'div',
            'pd-pt',
            ctx.portraits.frame(e.head, `pt-pd ${MEDAL[idx]}`),
            el('span', `pd-rank ${MEDAL[idx]}`, String(idx + 1)),
            isMe(e, p.me) ? el('i', 'you-tag pd-you', 'YOU') : null,
          ),
          el('span', 'pd-name', e.player),
          el('b', 'pd-score t-num', fmtInt(e.score)),
          el('div', 'pd-block', label(`${isGhost(e) ? 'GHOST · ' : ''}${subline(e, p.mode).split(' · ').pop() ?? ''}`)),
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
        `lb-row ${rank <= 3 ? MEDAL[rank - 1] : ''} ${me ? 'is-me' : ''} ${isGhost(e) ? 'is-ghost' : ''}`.trim(),
        el('span', 'lb-rank t-num', pad2(rank)),
        ctx.portraits.frame(e.head, 'pt-row'),
        el(
          'span',
          'lb-who',
          el('span', 'lb-name', el('span', 'lb-player', e.player), me ? el('i', 'you-tag', 'YOU') : isGhost(e) ? el('i', 'ghost-tag', 'GHOST') : null),
          label(subline(e, p.mode)),
        ),
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
    header({ title: 'Leaderboard', kicker: 'RANKINGS' }),
    stagger(el('div', 'lb-controls', tabs.el, sub, note), 1),
    body,
  );
  render(props);
  return { el: root, update: render };
}

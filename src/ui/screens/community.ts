// Community problems: New / Popular, problem cards with a mini route map, play + create.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import type { CommunityProblem } from '../../core/types';
import { button, el, label, setChildren, stagger } from '../dom';
import { icon } from '../icons';
import { fmtAge, fmtInt, pct, wallAngle } from '../format';
import { emptyState, gradeChip, header, onlineBadge, routeThumb, screenRoot, segmented, skeletons, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['community'];
type Sort = P['sort'];

export function createCommunity(_ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('community', 'scr-panel');
  let cur = props;
  const badge = el('div', 'cm-badge');
  const body = el('div', 'cm-body scroll');
  const meta = el('span', 'cm-meta');

  const card = (pr: CommunityProblem, i: number): HTMLElement => {
    const b = pr.boulder;
    const ang = wallAngle(b.wallAngle);
    const holds = b.holds.filter((h) => h.role !== 'deco').length;
    const rate = pct(pr.sends, pr.plays);
    const c = button({ variant: 'plain', cls: 'cm-card', aria: `Play ${pr.name}`, onTap: () => bus.emit('ui:play-problem', { problem: pr }) });
    const bar = el('i', 'cm-rate-fill');
    bar.style.transform = `scaleX(${pr.plays ? Math.min(1, pr.sends / pr.plays) : 0})`;
    c.append(
      el('span', 'cm-thumb', routeThumb(b)),
      el(
        'span',
        'cm-info',
        el('span', 'cm-row1', el('span', 'cm-name', pr.name), gradeChip(pr.grade, { size: 'sm' })),
        el('span', 'cm-author', icon('user'), pr.author || 'Anonymous', el('i', 'cm-dot'), fmtAge(pr.createdAt)),
        el(
          'span',
          'cm-specs',
          el('span', null, label(ang.kind.toUpperCase()), el('b', 't-num', ang.value)),
          el('span', null, label('HOLDS'), el('b', 't-num', String(holds))),
          el('span', null, label('PLAYS'), el('b', 't-num', fmtInt(pr.plays))),
        ),
        el('span', 'cm-rate', label(`SEND RATE ${rate}`), el('span', 'cm-rate-bar', bar)),
      ),
      el('span', 'cm-play', icon('play')),
    );
    return stagger(c, 2 + Math.min(i, 10));
  };

  const create = (): HTMLButtonElement =>
    button({ label: 'SET A PROBLEM', icon: 'plus', variant: 'primary', cls: 'cm-create', onTap: () => bus.emit('ui:open', { screen: 'editor' }) });

  const render = (p: P): void => {
    cur = p;
    sort.set(p.sort);
    setChildren(badge, onlineBadge(p.isGlobal));
    meta.textContent = p.problems ? `${p.problems.length} PROBLEMS` : 'LOADING';
    if (p.problems === null) {
      setChildren(body, el('div', 'cm-list', ...skeletons(5, 'skel-card')));
      return;
    }
    if (!p.problems.length) {
      setChildren(
        body,
        emptyState({
          icon: 'holds',
          title: 'No problems yet',
          body: p.isGlobal ? 'The community wall is blank. Set the first problem and see who can send it.' : 'You are offline, so only problems on this device show up. Set one in the editor.',
          action: create(),
        }),
      );
      return;
    }
    setChildren(body, el('div', 'cm-list', ...p.problems.map(card)));
  };

  const sort = segmented<Sort>({
    options: [
      { id: 'new', label: 'NEW' },
      { id: 'popular', label: 'POPULAR' },
    ],
    value: props.sort,
    cls: 'cm-sort seg-sm',
    onChange: (s) => {
      render({ ...cur, sort: s, problems: null });
      bus.emit('ui:community-refresh', { sort: s });
    },
  });

  root.append(
    topoLayer('panel-topo'),
    header({ title: 'Community', kicker: 'PLAYER-SET PROBLEMS', right: badge }),
    stagger(el('div', 'cm-controls', sort.el, create()), 1),
    stagger(el('div', 'cm-subrow', meta, label('TAP A CARD TO CLIMB')), 1),
    body,
  );
  render(props);
  return { el: root, update: render };
}

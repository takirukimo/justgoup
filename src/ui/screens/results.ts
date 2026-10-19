// Results after a send / fall / run end / rope top: stamp, animated points tick-up, run stats,
// new-best burst, rank, unlock cards and the next action.

import type { ResultsProps, ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import '../intents';
import type { ChalkId, ColorwayId, HeadId } from '../../core/types';
import { CHALKS, COLORWAYS } from '../../config/skins';
import { button, el, label, stagger, type Child } from '../dom';
import { icon } from '../icons';
import { fmtDuration, fmtInt, fmtSigned, modeTitle } from '../format';
import { backendKind, gradeChip, screenRoot, steiniTip, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['results'];

const STAMP: Record<ResultsProps['kind'], { word: string; tone: 'good' | 'bad' | 'neutral' }> = {
  send: { word: 'SENT', tone: 'good' },
  fall: { word: 'FALL', tone: 'bad' },
  'run-over': { word: 'RUN OVER', tone: 'bad' },
  'topped-rope': { word: 'TOPPED', tone: 'good' },
};

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function outfitSwatch(id: ColorwayId): HTMLElement {
  const c = COLORWAYS.find((x) => x.id === id) ?? COLORWAYS[0];
  const fig = el('span', 'outfit');
  fig.style.setProperty('--top', c.top);
  fig.style.setProperty('--bottom', c.bottom);
  fig.style.setProperty('--shoe', c.shoe);
  fig.style.setProperty('--acc', c.shoeAccent);
  fig.style.setProperty('--print', c.accent);
  // every colourway is a CHIRAL SPORTS tee: the small mark on the chest in the print colour
  fig.append(el('i', 'of-top', el('i', 'of-mark')), el('i', 'of-bottom'), el('i', 'of-shoe'));
  return fig;
}

export function chalkSwatch(id: ChalkId): HTMLElement {
  const c = CHALKS.find((x) => x.id === id) ?? CHALKS[0];
  const s = el('span', 'chalk-sw', el('i'));
  s.style.setProperty('--chalk', c.color);
  return s;
}

export function createResults(ctx: UICtx, props: P): ScreenView<P> {
  const p = props;
  const st = STAMP[p.kind];
  const root = screenRoot('results', `res-${p.kind} res-${st.tone}`);
  const reduced = (): boolean => ctx.isReducedMotion();
  let raf = 0;
  const timers: number[] = [];
  const later = (fn: () => void, ms: number): void => {
    timers.push(window.setTimeout(fn, ms));
  };

  const flash = (p.breakdown ?? []).some((b) => /flash/i.test(b.label));
  const mode = (modeTitle[p.mode] ?? p.mode).toUpperCase();

  // ── hero ──
  const stamp = el(
    'div',
    `stamp stamp-${st.tone}`,
    el('span', 'stamp-txt', st.word),
    el('span', 'stamp-sub', label(p.kind === 'send' && flash ? 'FLASHED · FIRST GO' : p.kind === 'send' ? 'TOPPED OUT CLEAN' : p.kind === 'topped-rope' ? 'ANCHOR CLIPPED' : p.kind === 'fall' ? 'OFF THE WALL' : 'END OF THE LINE')),
  );
  const hero = el(
    'div',
    'res-hero',
    el('div', 'res-burst', ...Array.from({ length: 12 }, (_, i) => {
      const r = el('i');
      r.style.setProperty('--r', `${i * 30}deg`);
      return r;
    })),
    stamp,
    el(
      'div',
      'res-route',
      el('span', 'rr-name', p.boulderName),
      gradeChip(p.grade, { font: true }),
      p.time !== undefined ? el('span', 'rr-time', icon('stopwatch'), el('b', 't-num', fmtDuration(p.time))) : null,
    ),
  );

  // ── points breakdown ──
  const rows: { val: HTMLElement; value: number; row: HTMLElement }[] = [];
  let totalEl: HTMLElement | null = null;
  let breakdown: HTMLElement | null = null;
  if (p.breakdown && p.breakdown.length) {
    const list = el('div', 'bd-rows');
    for (const b of p.breakdown) {
      const val = el('b', 'bd-val t-num', '0');
      const row = el('div', `bd-row${b.value < 0 ? ' bd-neg' : ''}`, el('span', 'bd-lbl', b.label), el('i', 'bd-leader'), val);
      rows.push({ val, value: b.value, row });
      list.appendChild(row);
    }
    totalEl = el('b', 'bd-total-val t-num', '0');
    breakdown = el('div', 'res-card glass bd', el('div', 'bd-head', label('POINTS'), label(mode)), list, el('div', 'bd-total', el('span', null, 'TOTAL'), totalEl));
  }

  // ── run stats, rank, tip, unlocks (rebuilt in place when late data such as the rank arrives) ──
  let runVal: HTMLElement = el('b');
  const stat = (lbl: string, v: Child, cls = ''): HTMLElement => el('div', `rs ${cls}`.trim(), label(lbl), v);
  const buildLower = (q: P, animate: boolean): HTMLElement[] => {
    const sg = <T extends HTMLElement>(e: T, i: number): T => (animate ? stagger(e, i) : e);
    runVal = el('b', 'rs-val t-num', fmtInt(q.runScore));
    const out: HTMLElement[] = [];
    out.push(
      sg(
        el(
          'div',
          'res-stats',
          stat(q.mode === 'boulder' ? 'RUN SCORE' : q.mode === 'rope' ? 'TOWER SCORE' : 'SCORE', runVal, 'rs-main'),
          q.mode === 'boulder' ? stat('STREAK', el('b', 'rs-val t-num', `×${q.streak}`)) : null,
          q.newBest
            ? el('div', 'rs rs-best', el('span', 't-label nb-lbl', icon('star'), 'NEW BEST'), el('b', 'rs-val t-num', fmtInt(q.best)))
            : stat('BEST', el('b', 'rs-val t-num', fmtInt(q.best))),
        ),
        4,
      ),
    );
    if (q.rank !== undefined && q.rank !== null) {
      // Say which board the rank is on: worldwide, the claude.ai shared board, or this device.
      const kind = backendKind(ctx.backendName);
      const where = kind === 'offline' ? 'RANK ON THIS DEVICE' : kind === 'shared' ? 'SHARED BOARD RANK' : kind === 'global' ? 'GLOBAL RANK' : 'BOARD RANK';
      out.push(sg(el('div', 'res-rank', icon('podium'), el('span', null, where), el('b', 't-num', `#${fmtInt(q.rank)}`)), 5));
    }
    if (q.tip && (q.kind === 'fall' || q.kind === 'run-over')) out.push(sg(steiniTip(ctx.portraits, q.tip, 'res-tip'), 6));
    if (q.unlocks && q.unlocks.length) {
      out.push(
        el(
          'div',
          'res-unlocks',
          label('UNLOCKED'),
          el(
            'div',
            'ul-list',
            ...q.unlocks.map((u, i) => {
              const art =
                u.kind === 'head' ? ctx.portraits.frame(u.id as HeadId, 'pt-ul') : u.kind === 'colorway' ? outfitSwatch(u.id as ColorwayId) : chalkSwatch(u.id as ChalkId);
              const c = el('div', `ul-card ul-${u.kind}`, el('span', 'ul-art', art), el('span', 'ul-txt', label(u.kind === 'head' ? 'NEW HEAD' : u.kind === 'colorway' ? 'NEW COLOURWAY' : 'NEW CHALK'), el('b', null, u.name)));
              return sg(c, 8 + i);
            }),
          ),
        ),
      );
    }
    return out;
  };

  // ── actions ──
  // Same problem vs new problems, named for what they do (owner: "TRY AGAIN (same problem) and NEW
  // RUN (new random)"): a run that ended (Send Train / Lead Tower) can replay the problem it ended on
  // as a fresh run, or start fresh random problems; a single problem (daily, community, test) climbs
  // the same problem again; a community problem can also go back to the list.
  const actions = el('div', 'res-actions');
  const sent = p.kind === 'send' || p.kind === 'topped-rope';
  const inRun = p.mode === 'boulder' || p.mode === 'rope';
  const unit = p.mode === 'rope' ? 'ROUTE' : 'BOULDER';
  const emit = (k: 'ui:retry' | 'ui:new-run' | 'ui:next' | 'ui:quit' | 'ui:menu') => () => bus.emit(k);
  const menuBtn = (variant: 'glass' | 'primary', cls?: string): HTMLButtonElement =>
    p.mode === 'test'
      ? button({ label: 'EDITOR', icon: 'edit', variant, cls, onTap: emit('ui:quit') })
      : button({ label: 'MENU', icon: 'home', variant, cls, onTap: emit(p.mode === 'community' ? 'ui:menu' : 'ui:quit') });
  const newRun = (cls?: string): HTMLButtonElement =>
    button({ label: 'NEW RUN', caption: p.mode === 'rope' ? 'NEW ROUTES' : 'NEW PROBLEMS', icon: 'dice', variant: 'glass', cls: `res-new ${cls ?? ''}`.trim(), onTap: emit('ui:new-run') });
  if (p.canContinue) {
    // a send inside a run: on to the next problem; NEW RUN banks this run (the run asks first)
    actions.append(
      stagger(button({ label: p.kind === 'topped-rope' ? 'NEXT ROUTE' : 'NEXT BOULDER', icon: 'arrow', iconAfter: true, variant: 'primary', cls: 'btn-xl', onTap: emit('ui:next') }), 12),
      stagger(el('div', 'res-row', newRun(), menuBtn('glass')), 13),
    );
  } else if (inRun && !sent) {
    // the run is over: the same problem again as a fresh run, or new random problems
    actions.append(
      stagger(button({ label: 'TRY AGAIN', caption: `SAME ${unit} · FRESH RUN`, icon: 'retry', variant: 'primary', cls: 'btn-xl res-try', onTap: emit('ui:retry') }), 12),
      stagger(el('div', 'res-row', newRun(), menuBtn('glass')), 13),
    );
  } else if (p.mode === 'community') {
    const again = button({ label: sent ? 'CLIMB AGAIN' : 'TRY AGAIN', caption: 'SAME PROBLEM', icon: 'retry', variant: sent ? 'glass' : 'primary', cls: sent ? 'res-try' : 'btn-xl res-try', onTap: emit('ui:retry') });
    const list = button({ label: 'PROBLEMS', caption: 'BACK TO THE LIST', icon: 'community', variant: sent ? 'primary' : 'glass', cls: sent ? 'btn-xl res-list' : 'res-list', onTap: emit('ui:quit') });
    actions.append(
      stagger(sent ? list : again, 12),
      stagger(el('div', 'res-row', sent ? again : list, menuBtn('glass')), 13),
    );
  } else if (sent) {
    actions.append(
      stagger(button({ label: 'CLIMB AGAIN', caption: 'SAME PROBLEM · BEAT YOUR TIME', icon: 'retry', variant: 'primary', cls: 'btn-xl res-try', onTap: emit('ui:retry') }), 12),
      stagger(menuBtn('glass', 'btn-wide'), 13),
    );
  } else {
    actions.append(
      stagger(button({ label: 'TRY AGAIN', caption: 'SAME PROBLEM', icon: 'retry', variant: 'primary', cls: 'btn-xl res-try', onTap: emit('ui:retry') }), 12),
      stagger(menuBtn('glass', 'btn-wide'), 13),
    );
  }

  const body = el('div', 'res-body scroll');
  body.append(stagger(hero, 0));
  if (breakdown) body.append(stagger(breakdown, 3));
  let lower = buildLower(p, true);
  body.append(...lower);

  root.append(el('div', 'res-bg', topoLayer('res-topo'), el('div', 'res-glow')), body, actions);

  // ── choreography ──
  const tickNumber = (target: HTMLElement, to: number, dur: number): Promise<void> =>
    new Promise((resolve) => {
      if (reduced() || dur <= 0) {
        target.textContent = fmtInt(to);
        resolve();
        return;
      }
      const t0 = performance.now();
      const step = (now: number): void => {
        // rAF timestamps are the frame's start and can precede t0: clamp, or the first frame flashes a negative number
        const t = Math.min(1, Math.max(0, (now - t0) / dur));
        target.textContent = fmtInt(to * easeOut(t));
        if (t < 1) raf = requestAnimationFrame(step);
        else resolve();
      };
      raf = requestAnimationFrame(step);
    });

  const play = async (): Promise<void> => {
    const fast = reduced();
    if (rows.length && totalEl) {
      runVal.textContent = fmtInt(Math.max(0, p.runScore - (p.points ?? 0)));
      await new Promise<void>((r) => later(r, fast ? 0 : 620));
      let total = 0;
      for (const r of rows) {
        r.row.classList.add('in');
        await tickNumber(r.val, r.value, fast ? 0 : 320);
        r.val.textContent = fmtSigned(r.value);
        total += r.value;
        totalEl.textContent = fmtInt(total);
      }
      const finalPts = p.points ?? total;
      totalEl.textContent = fmtInt(finalPts);
      breakdown?.classList.add('done');
      await tickNumber(runVal, p.runScore, fast ? 0 : 520);
    } else {
      runVal.textContent = '0';
      await new Promise<void>((r) => later(r, fast ? 0 : 520));
      await tickNumber(runVal, p.runScore, fast ? 0 : 700);
    }
    if (p.newBest) root.classList.add('is-best');
  };

  return {
    el: root,
    reuse: false,
    // Late data (rank from the backend, unlocks, best) refreshes the lower cards without replaying the stamp.
    update: (q) => {
      const st0 = body.scrollTop;
      const next = buildLower(q, false);
      for (const n of lower) n.remove();
      body.append(...next);
      lower = next;
      body.scrollTop = st0;
    },
    entered: () => {
      void play();
    },
    destroy: () => {
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
    },
  };
}

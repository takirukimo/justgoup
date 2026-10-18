// Locker: heads / colourways / chalk. The top of the screen stays clear so the 3D climber
// behind shows the equipped skin; the catalogue lives in a bottom sheet.

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import type { ChalkId, ColorwayId, HeadId, Profile } from '../../core/types';
import { CHALKS, COLORWAYS, HEADS, unlockLabel, type Unlock } from '../../config/skins';
import { backButton, button, el, label, setChildren, stagger } from '../dom';
import { icon } from '../icons';
import { screenRoot, segmented, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';
import { chalkSwatch, outfitSwatch } from './results';

type P = ScreenProps['locker'];
type Tab = 'heads' | 'colorways' | 'chalks';

export function createLocker(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('locker');
  let profile: Profile = props.profile;
  let tab: Tab = 'heads';
  const grid = el('div', 'lk-grid');
  const scroller = el('div', 'lk-scroll scroll', grid);
  const count = el('span', 'lk-count t-num');
  const equipped = el('div', 'lk-equipped');

  const isUnlocked = (kind: Tab, id: string): boolean => (profile.unlocked[kind] as string[]).includes(id);

  const lockedTap = (card: HTMLElement, u: Unlock): void => {
    card.classList.remove('nope');
    void card.offsetWidth;
    card.classList.add('nope');
    ctx.toast(`LOCKED · ${unlockLabel(u).toUpperCase()}`);
  };

  const stateTag = (sel: boolean, unlocked: boolean, u: Unlock): HTMLElement =>
    sel
      ? el('span', 'lk-state lk-on', icon('check'), 'EQUIPPED')
      : unlocked
        ? el('span', 'lk-state', 'EQUIP')
        : el('span', 'lk-state lk-locked', icon('lock'), unlockLabel(u));

  const renderEquipped = (): void => {
    const h = HEADS.find((x) => x.id === profile.head) ?? HEADS[0];
    const c = COLORWAYS.find((x) => x.id === profile.colorway) ?? COLORWAYS[0];
    const k = CHALKS.find((x) => x.id === profile.chalk) ?? CHALKS[0];
    setChildren(
      equipped,
      el('div', 'eq-item', label('HEAD'), el('b', null, h.name)),
      el('div', 'eq-item', label('COLOURWAY'), el('b', null, c.name)),
      el('div', 'eq-item', label('CHALK'), el('b', null, k.name)),
    );
  };

  const render = (animate = true): void => {
    const total = HEADS.length + COLORWAYS.length + CHALKS.length;
    const have = profile.unlocked.heads.length + profile.unlocked.colorways.length + profile.unlocked.chalks.length;
    count.textContent = `${String(have).padStart(2, '0')}/${total}`;
    renderEquipped();
    grid.className = `lk-grid lk-grid-${tab}`;
    let cards: HTMLElement[] = [];
    if (tab === 'heads') {
      cards = HEADS.map((h, i) => {
        const un = isUnlocked('heads', h.id);
        const sel = profile.head === h.id;
        const card = button({ variant: 'plain', cls: `lk-card lk-head ${sel ? 'sel' : ''} ${un ? '' : 'locked'}`, aria: h.name });
        card.append(
          el('span', 'lk-art', topoLayer('lk-art-topo'), ctx.portraits.frame(h.id, 'pt-lk'), un ? null : el('span', 'lk-lock', icon('lock'))),
          el('span', 'lk-meta', el('span', 'lk-name', h.name), label(h.local, 'lk-local'), el('span', 'lk-blurb', h.blurb)),
          stateTag(sel, un, h.unlock),
        );
        card.addEventListener('click', () => {
          if (!un) return lockedTap(card, h.unlock);
          if (sel) return;
          profile = { ...profile, head: h.id as HeadId };
          bus.emit('ui:select-head', { head: h.id });
          render(false);
        });
        return animate ? stagger(card, i) : card;
      });
    } else if (tab === 'colorways') {
      cards = COLORWAYS.map((c, i) => {
        const un = isUnlocked('colorways', c.id);
        const sel = profile.colorway === c.id;
        const card = button({ variant: 'plain', cls: `lk-card lk-cw ${sel ? 'sel' : ''} ${un ? '' : 'locked'}`, aria: c.name });
        const chips = el('span', 'cw-chips');
        for (const [k, hex] of [['TOP', c.top], ['PANT', c.bottom], ['SHOE', c.shoe]] as const) {
          const chip = el('span', 'cw-chip', el('i'), k);
          chip.style.setProperty('--c', hex);
          chips.appendChild(chip);
        }
        card.append(
          el('span', 'lk-art lk-art-cw', outfitSwatch(c.id as ColorwayId), un ? null : el('span', 'lk-lock', icon('lock'))),
          el('span', 'lk-meta', el('span', 'lk-name', c.name), chips),
          stateTag(sel, un, c.unlock),
        );
        card.addEventListener('click', () => {
          if (!un) return lockedTap(card, c.unlock);
          if (sel) return;
          profile = { ...profile, colorway: c.id };
          bus.emit('ui:select-colorway', { colorway: c.id });
          render(false);
        });
        return animate ? stagger(card, i) : card;
      });
    } else {
      cards = CHALKS.map((c, i) => {
        const un = isUnlocked('chalks', c.id);
        const sel = profile.chalk === c.id;
        const card = button({ variant: 'plain', cls: `lk-card lk-chalk ${sel ? 'sel' : ''} ${un ? '' : 'locked'}`, aria: c.name });
        card.append(
          el('span', 'lk-art lk-art-chalk', chalkSwatch(c.id as ChalkId), un ? null : el('span', 'lk-lock', icon('lock'))),
          el('span', 'lk-meta', el('span', 'lk-name', c.name), label(c.color.toUpperCase(), 'lk-local')),
          stateTag(sel, un, c.unlock),
        );
        card.addEventListener('click', () => {
          if (!un) return lockedTap(card, c.unlock);
          if (sel) return;
          profile = { ...profile, chalk: c.id };
          bus.emit('ui:select-chalk', { chalk: c.id });
          render(false);
        });
        return animate ? stagger(card, i) : card;
      });
    }
    setChildren(grid, ...cards);
  };

  const tabs = segmented<Tab>({
    options: [
      { id: 'heads', label: 'HEADS' },
      { id: 'colorways', label: 'COLOURWAYS' },
      { id: 'chalks', label: 'CHALK' },
    ],
    value: tab,
    onChange: (t) => {
      tab = t;
      scroller.scrollTop = 0;
      render();
    },
  });

  root.append(
    el('div', 'scrim scrim-top scrim-soft'),
    el('div', 'lk-top', backButton(), el('div', 'lk-title stg', label('LOCKER · LOADOUT'), el('h2', 'hdr-h', 'Locker'))),
    el('div', 'lk-flex'),
    el(
      'div',
      'lk-sheet glass',
      el('span', 'lk-grabber'),
      el('div', 'lk-sheet-head', equipped, el('span', 'lk-have', label('UNLOCKED'), count)),
      tabs.el,
      scroller,
    ),
  );
  render();

  return {
    el: root,
    update: (p) => {
      profile = p.profile;
      const st = scroller.scrollTop;
      render(false);
      scroller.scrollTop = st;
    },
  };
}

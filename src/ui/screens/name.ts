// First-time name entry (also used to rename from the profile).

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import { BRAND } from '../../config/brand';
import { button, el, label, stagger } from '../dom';
import { chiralMark } from '../logo';
import { header, screenRoot, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['name'];

export const NAME_MIN = 2;
export const NAME_MAX = 16;
// Mirrors the backend rule: [A-Za-z0-9 ._-] plus common accented Latin letters, single spaces.
const ACC = 'À-ÖØ-öø-ÿĀ-ſ';
const BAD_CHARS = new RegExp(`[^A-Za-z0-9 ._\\-${ACC}]`, 'g');
const ALNUM = new RegExp(`[A-Za-z0-9${ACC}]`);

/** Live-clean typed input (keeps a trailing space while typing). */
export function cleanNameInput(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').replace(BAD_CHARS, '').replace(/^ +/, '').replace(/ {2,}/g, ' ').slice(0, NAME_MAX);
}

export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length < NAME_MIN) return `At least ${NAME_MIN} characters`;
  if (n.length > NAME_MAX) return `At most ${NAME_MAX} characters`;
  if (!ALNUM.test(n)) return 'Use at least one letter or number';
  return null;
}

const PRE = ['Crimp', 'Sloper', 'Jug', 'Pinch', 'Chalk', 'Crux', 'Mantle', 'Dyno', 'Smear', 'Pocket', 'Beta', 'Flash', 'Heel Hook', 'Undercling', 'Gaston', 'Dropknee'];
const ANIMAL = ['Ibex', 'Marmot', 'Chamois', 'Lynx', 'Eagle', 'Goat', 'Ram', 'Vulture', 'Leopard', 'Steinbock', 'Murmeli'];

export function suggestName(rnd: () => number = Math.random): string {
  for (let tries = 0; tries < 20; tries++) {
    const a = PRE[Math.floor(rnd() * PRE.length)];
    const b = ANIMAL[Math.floor(rnd() * ANIMAL.length)];
    let s = `${a} ${b}`;
    if (rnd() < 0.45) s += ` ${10 + Math.floor(rnd() * 89)}`;
    if (s.length <= NAME_MAX) return s;
  }
  return 'Crimp Ibex 27';
}

export function createName(_ctx: UICtx, props: P): ScreenView<P> {
  const editing = props.current.trim().length > 0;
  const root = screenRoot('name', 'scr-panel');

  const input = el('input', 'name-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = NAME_MAX;
  input.setAttribute('autocapitalize', 'words');
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('aria-label', 'Climber name');
  input.placeholder = 'Your climber name';
  input.value = cleanNameInput(props.current);

  const counter = el('span', 'name-count t-num');
  const hint = el('span', 'name-hint');
  const cardName = el('span', 'idc-name');
  const cont = button({ label: 'CONTINUE', icon: 'arrow', iconAfter: true, variant: 'primary', cls: 'btn-xl', onTap: () => submit() });

  const refresh = (): void => {
    const v = input.value;
    const prob = nameProblem(v);
    counter.textContent = `${String(v.trim().length).padStart(2, '0')}/${NAME_MAX}`;
    const blank = v.trim().length === 0;
    hint.textContent = blank ? `${NAME_MIN}–${NAME_MAX} characters · letters, numbers, space . _ -` : (prob ?? 'Looks good. Shown on leaderboards and on problems you set.');
    hint.classList.toggle('ok', !prob);
    hint.classList.toggle('neutral', blank);
    cont.disabled = !!prob;
    cardName.textContent = v.trim() || 'Your name';
    cardName.classList.toggle('is-empty', !v.trim());
  };

  const submit = (): void => {
    const name = input.value.trim();
    if (nameProblem(name)) {
      root.querySelector('.name-field')?.classList.remove('shake');
      void (root.querySelector('.name-field') as HTMLElement | null)?.offsetWidth;
      root.querySelector('.name-field')?.classList.add('shake');
      return;
    }
    input.blur();
    bus.emit('ui:set-name', { name });
  };

  input.addEventListener('input', () => {
    const c = cleanNameInput(input.value);
    if (c !== input.value) input.value = c;
    refresh();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  const chips = el('div', 'name-chips');
  const rollChips = (): void => {
    const seen = new Set<string>();
    const picks: string[] = [];
    while (picks.length < 3 && seen.size < 40) {
      const n = suggestName();
      if (!seen.has(n)) picks.push(n);
      seen.add(n);
    }
    chips.replaceChildren(
      ...picks.map((n, i) => {
        const b = button({
          label: n,
          variant: 'ghost',
          cls: 'name-chip',
          onTap: () => {
            input.value = n;
            refresh();
          },
        });
        b.style.setProperty('--i', String(i));
        return b;
      }),
    );
  };
  rollChips();

  const dice = button({
    icon: 'dice',
    variant: 'icon',
    cls: 'name-dice',
    aria: 'Suggest a name',
    onTap: () => {
      input.value = suggestName();
      refresh();
      rollChips();
      dice.classList.remove('spin');
      void dice.offsetWidth;
      dice.classList.add('spin');
    },
  });

  // Keep the CTA above the on-screen keyboard.
  const vv = window.visualViewport;
  const onVV = (): void => {
    if (!vv) return;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--kb', `${Math.round(kb)}px`);
  };
  vv?.addEventListener('resize', onVV);

  const idCard = el(
    'div',
    'id-card',
    topoLayer('idc-topo'),
    el('div', 'idc-top', chiralMark('idc-mark'), label(`${BRAND.name} ${BRAND.sub} · CLIMBER ID`), el('span', 'idc-no t-num', 'Nº 0001')),
    cardName,
    el('div', 'idc-bottom', label('MEMBER SINCE ' + new Date().getFullYear()), label('ALL WALLS · ALL GRADES')),
  );

  root.append(
    topoLayer('panel-topo'),
    editing ? header({ title: 'Edit name', kicker: 'PROFILE · NAME' }) : el('div', 'name-pad'),
    el(
      'div',
      'name-body',
      stagger(el('div', 'name-intro', label(editing ? 'RENAME' : 'STEP 01 · IDENTIFY'), el('h2', 'name-h', editing ? 'New name?' : 'Who’s climbing?')), 1),
      stagger(idCard, 2),
      stagger(el('div', 'name-field', input, counter, dice), 3),
      stagger(hint, 4),
      stagger(el('div', 'name-suggest', label('OR TAKE ONE OF THESE'), chips), 5),
    ),
    el('div', 'name-flex'),
    stagger(el('div', 'name-cta', cont), 6),
  );
  refresh();

  return {
    el: root,
    update: (p) => {
      input.value = cleanNameInput(p.current);
      refresh();
    },
    entered: () => {
      // Desktop: focus right away. Touch: let the player tap (avoids an instant keyboard pop).
      if (matchMedia('(pointer: fine)').matches) setTimeout(() => input.focus({ preventScroll: true }), 320);
    },
    destroy: () => vv?.removeEventListener('resize', onVV),
  };
}

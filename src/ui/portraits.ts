// Head portraits: 3D renders from the renderer's portrait provider, with crafted flat SVG
// emblems as the fallback (before the provider is set, or if it throws).

import type { HeadId } from '../core/types';
import { HEADS, type HeadDef } from '../config/skins';
import { el, img } from './dom';

const headDef = (id: HeadId): HeadDef => HEADS.find((h) => h.id === id) ?? HEADS[0];

// ── Flat side-profile emblems (100×100, facing right) ──

const UNGULATE = 'M30 101C29 86 31 71 37 59 41 50 46 43 53 41 61 39 67 43 72 49L84.5 61.5C87.5 64.5 86.5 69.5 82.5 70.5L70.5 73C64 74.5 58.5 77 55 83L53 101Z';
const CAT = 'M28 101C27 84 29 68 35 57 40 47 48 41 59 40.5 69 40 76.5 45.5 80 53L85 60C86.8 62.8 85.4 66.2 82 66.8L77 67.6C75 72 70.6 74.4 65 74.6 59 75.6 54.6 81.6 53 101Z';
const MARMOT = 'M29 101C25 82 29 64 39 53 47 45 57 42 66 43.5 76 45 82.5 52.5 84.5 61 86 67.5 81 72 74.5 72.5 67.5 74 61 77 57 83L55 101Z';
const BIRD = 'M30 101C28 82 30 66 37 55.5 43 47 51 42.5 60 42 68.5 41.5 74.5 45.5 77 51.5L80 54Z';

function svgFor(id: HeadId): string {
  const d = headDef(id);
  const { base, secondary, accent, eye } = d.colors;
  const g: string[] = [];
  const shade = `<path d="${'M30 101C29 86 31 71 37 59 41 50 46 43 53 41'}" fill="none" stroke="#000" stroke-opacity=".22" stroke-width="6"/>`;
  switch (id) {
    case 'ibex':
    case 'goat':
    case 'chamois':
    case 'ram': {
      // horns behind the head
      if (id === 'ibex') {
        g.push(`<path d="M47.5 44C44 26 32 13 10 9.5 27 16.5 36 28 40.5 46Z" fill="${accent}"/>`);
        g.push(`<path d="M16 12.6l2.2-4M22.3 15.4l2.6-4.2M28 19.6l3-4.2M32.6 25l3.4-3.6M36.2 31.4l3.6-2.8M38.8 38l3.8-1.8" stroke="${secondary}" stroke-opacity=".7" stroke-width="1.6"/>`);
      } else if (id === 'chamois') {
        g.push(`<path d="M49 43C48 33 49 23 52.5 17 55 12.5 60.5 12 61.5 16.8 62 19.5 59.4 20.4 58.4 18.2" fill="none" stroke="${accent}" stroke-width="4.6" stroke-linecap="round"/>`);
      } else if (id === 'goat') {
        g.push(`<path d="M49.5 43C47 33 41 25.5 32.5 22.5" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>`);
      }
      g.push(`<path d="${UNGULATE}" fill="${base}"/>`);
      g.push(shade);
      // muzzle / face markings
      if (id === 'chamois') {
        g.push(`<path d="M52 42C60 39.5 67 43 72 49L84.5 61.5C87.5 64.5 86.5 69.5 82.5 70.5L70.5 73C66 66 60 58 52 42Z" fill="${secondary}"/>`);
        g.push(`<path d="M53 44C58 50 64 56 76 63.5" stroke="${accent}" stroke-width="4.2" stroke-linecap="round" fill="none"/>`);
      } else if (id === 'goat') {
        g.push(`<path d="M72 72.5C73 80 70 89 66 95 64 87 63 80 64 74Z" fill="${secondary}"/>`);
      } else if (id === 'ibex') {
        g.push(`<path d="M72.5 72C73 78 71 83.5 67.5 87 66 82 65.5 77.5 66 73.5Z" fill="${secondary}"/>`);
        g.push(`<path d="M76 66.5C79 66 82 66.5 84 64" stroke="${secondary}" stroke-width="1.4" fill="none"/>`);
      } else {
        g.push(`<path d="M74 70.8C79 69 83.4 68.6 85 65.5" stroke="${secondary}" stroke-width="3" fill="none" stroke-linecap="round"/>`);
      }
      // ear
      g.push(`<path d="M47 49C40 46 34 46 28.5 48.5 34 52.5 40.5 53.5 46.5 52.5Z" fill="${id === 'goat' ? secondary : base}" stroke="#000" stroke-opacity=".18" stroke-width="1"/>`);
      if (id === 'ram') {
        g.push(`<path d="M51 42C39 32 23 38.5 23.5 53.5 24 66.5 39.5 70.5 45.5 61 49.5 54.5 43.5 47.5 37.5 51.5 34.5 53.5 35.5 58 38.6 58" fill="none" stroke="${accent}" stroke-width="7.5" stroke-linecap="round"/>`);
        g.push(`<path d="M30 42.5l3.6 3.6M25.6 48.4l4.4 2M26 58.5l4.6-1M31.6 65.4l3-3.6" stroke="${base}" stroke-opacity=".55" stroke-width="1.5"/>`);
      }
      g.push(`<ellipse cx="60.5" cy="51.5" rx="3" ry="2.6" fill="${eye}"/><circle cx="61.4" cy="50.6" r=".9" fill="#fff" fill-opacity=".8"/>`);
      g.push(`<ellipse cx="83.4" cy="64.4" rx="1.6" ry="1.2" fill="#000" fill-opacity=".55"/>`);
      break;
    }
    case 'snowleopard':
    case 'lynx': {
      g.push(`<path d="M42.5 47 47 23 59.5 41Z" fill="${base}"/>`);
      g.push(`<path d="M45.5 41 48 29 55 39.5Z" fill="${accent}" fill-opacity="${id === 'lynx' ? '.35' : '.6'}"/>`);
      if (id === 'lynx') g.push(`<path d="M47 23.5 47.8 11.5" stroke="${accent}" stroke-width="2.4" stroke-linecap="round"/>`);
      g.push(`<path d="${CAT}" fill="${base}"/>`);
      g.push(shade);
      g.push(`<path d="M66 56C72 55 78 57.5 82 61.5 84.6 64 83.6 66.6 81 67 77 67.8 73.5 72.6 65 74.6 61 70 61 61 66 56Z" fill="${secondary}" fill-opacity="${id === 'lynx' ? '.9' : '.55'}"/>`);
      if (id === 'lynx') {
        g.push(`<path d="M55.5 72 50 79.5 56.5 78.5 52.5 86 59 82.5 58 89 64 75Z" fill="${secondary}"/>`);
        g.push(`<path d="M58.5 47.2c4-1.4 8-1 11 1" stroke="${accent}" stroke-width="1.4" fill="none"/>`);
      } else {
        const spots = [[42, 62], [48, 70], [38, 74], [44, 82], [52, 58], [36, 86], [55, 90]];
        for (const [x, y] of spots) g.push(`<circle cx="${x}" cy="${y}" r="3.1" fill="none" stroke="${secondary}" stroke-width="1.8" stroke-dasharray="4 2"/>`);
        g.push(`<circle cx="62" cy="46" r="1.5" fill="${secondary}"/><circle cx="56.5" cy="45" r="1.3" fill="${secondary}"/>`);
      }
      g.push(`<path d="M62.5 52.5c2-1.6 4.8-1.8 6.6-.4-1.6 2-4.4 2.4-6.6.4z" fill="${eye}"/><circle cx="66.4" cy="52.2" r=".8" fill="#000"/>`);
      g.push(`<path d="M82.5 59.6 85.6 60.4 83.6 63Z" fill="#2a1d18"/>`);
      g.push(`<path d="M76.5 65.6c-1 2-3 3-5.4 3" stroke="#000" stroke-opacity=".35" stroke-width="1" fill="none"/>`);
      break;
    }
    case 'marmot': {
      g.push(`<path d="${MARMOT}" fill="${base}"/>`);
      g.push(shade);
      g.push(`<ellipse cx="76" cy="64.5" rx="9.5" ry="7" fill="${secondary}"/>`);
      g.push(`<path d="M80 71.8h3.4v4.2h-3.4z" fill="#F6F4EF"/>`);
      g.push(`<ellipse cx="84.4" cy="61" rx="2.2" ry="1.7" fill="${accent}"/>`);
      g.push(`<circle cx="47" cy="49.5" r="5" fill="${base}" stroke="#000" stroke-opacity=".25" stroke-width="1.2"/><circle cx="47" cy="49.5" r="2.4" fill="${accent}" fill-opacity=".55"/>`);
      g.push(`<circle cx="64" cy="54" r="2.8" fill="${eye}"/><circle cx="64.9" cy="53.1" r=".85" fill="#fff" fill-opacity=".8"/>`);
      g.push(`<path d="M55 46.5c5-2.4 11-2.4 15 0" stroke="${accent}" stroke-opacity=".35" stroke-width="2" fill="none"/>`);
      break;
    }
    case 'eagle':
    case 'vulture': {
      const isEagle = id === 'eagle';
      g.push(`<path d="${BIRD}L74 63C68 66 62 70 57 78L55 101Z" fill="${isEagle ? base : secondary}"/>`);
      g.push(shade);
      if (isEagle) {
        g.push(`<path d="M37 55.5C43 47 51 42.5 60 42 54 48 47 52 44 64 41 72 39 80 38 101H30C28 82 30 66 37 55.5Z" fill="${secondary}"/>`);
        g.push(`<path d="M73 49.5C80 48 88 50.5 92 56.5 94 60 92.5 65 89 66.5 89.5 63 87.5 61 85 61L74 62.5Z" fill="${accent}"/>`);
        g.push(`<path d="M88 59c2.6.6 4 2.6 3.6 5.4-.7 1.2-1.6 1.8-2.6 2.1.5-2.6-.3-4.4-2.4-5.3z" fill="#2B2116"/>`);
        g.push(`<path d="M58.5 50.5c3-2.2 7.2-2 9.6.4" stroke="#2B2116" stroke-width="2.4" fill="none"/>`);
        g.push(`<circle cx="64" cy="53.6" r="2.7" fill="${eye}"/><circle cx="64.3" cy="53.6" r="1.25" fill="#120c08"/>`);
      } else {
        g.push(`<path d="M37 55.5C43 47 51 42.5 60 42 68.5 41.5 74.5 45.5 77 51.5L80 54 74 62.5C69 60 64 59 58 60 50 61 44 66 41 75 37 70 35 62 37 55.5Z" fill="${accent}"/>`);
        g.push(`<path d="M56 50.5C62 48 70 49 76.5 53.5L72 57.5C67 55 61.5 54 56 55Z" fill="${base}"/>`);
        g.push(`<path d="M74 50.5C81 49 88 51.5 91.5 57 93 60 91.6 64.6 88.6 65.8 88.8 63 87 61.2 84.6 61.2L74.5 62.5Z" fill="#9C968A"/>`);
        g.push(`<path d="M76 63.5 78.5 72.5 74.2 66.6 73.4 73.6 71.2 64.4Z" fill="${base}"/>`);
        g.push(`<circle cx="65" cy="52.6" r="3.4" fill="${eye}"/><circle cx="65" cy="52.6" r="1.5" fill="#F2E6CF"/><circle cx="65.3" cy="52.6" r=".8" fill="#120c08"/>`);
      }
      break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g stroke-linejoin="round">${g.join('')}</g></svg>`;
}

const fallbackCache = new Map<HeadId, string>();

export function fallbackPortrait(head: HeadId): string {
  let u = fallbackCache.get(head);
  if (!u) {
    u = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(head))}`;
    fallbackCache.set(head, u);
  }
  return u;
}

/** Portrait source registry shared by every screen. */
export class Portraits {
  private provider: ((head: HeadId) => string) | null = null;
  private listeners = new Set<() => void>();

  setProvider(fn: (head: HeadId) => string): void {
    this.provider = fn;
    for (const l of this.listeners) l();
  }

  get hasProvider(): boolean {
    return this.provider !== null;
  }

  src(head: HeadId): string {
    if (this.provider) {
      try {
        const s = this.provider(head);
        if (s) return s;
      } catch (err) {
        console.warn('[ui] portrait provider failed', err);
      }
    }
    return fallbackPortrait(head);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * A framed portrait: `<span class="pt"><img></span>`. The element refreshes itself when the
   * provider arrives (the registry walks `[data-head]` images on change).
   */
  frame(head: HeadId, cls = ''): HTMLSpanElement {
    const i = img('pt-img', this.src(head), headDef(head).name);
    i.dataset.head = head;
    const wrap = el('span', `pt ${this.provider ? '' : 'pt-flat'} ${cls}`.trim(), i);
    wrap.dataset.headFrame = head;
    return wrap;
  }

  /** Re-point every portrait image under `root` (after the provider changes). */
  refresh(root: ParentNode): void {
    root.querySelectorAll<HTMLImageElement>('img[data-head]').forEach((im) => {
      const h = im.dataset.head as HeadId;
      im.src = this.src(h);
      im.parentElement?.classList.toggle('pt-flat', !this.provider);
    });
  }
}

// The hold palette: HOLDS and VOLUMES tabs over one scrolling strip of tiles, each a real 3D preview of
// the product (editor/thumbs.ts draws the renderer's own geometry in the route colour). Tapping a tile
// picks what a tap on the wall sets (or turns the selected hold into that product).

import { el, toggle } from '../ui/dom';
import { holdGlyph } from './glyphs';
import { CATALOG, tabEntries, type CatalogEntry, type PaletteTab } from './catalog';
import { drawThumb } from './thumbs';

const TILE_W = 50;
const TILE_H = 34;

export class Palette {
  readonly el: HTMLElement;
  private strip: HTMLElement;
  private tabs = new Map<PaletteTab, HTMLButtonElement>();
  private tiles = new Map<string, { b: HTMLButtonElement; c: HTMLCanvasElement; e: CatalogEntry }>();
  private sections = new Map<PaletteTab, HTMLElement>();
  private color = '';
  private active = '';
  private tab: PaletteTab = 'holds';
  private drawQueue: string[] = [];
  private drawing = 0;

  constructor(private onPick: (id: string) => void) {
    const tabRow = el('div', 'ed-pal-tabs');
    for (const t of ['holds', 'volumes'] as const) {
      const n = tabEntries(t).length;
      const b = el('button', `ed-pal-tab ed-pal-tab-${t}`, el('span', null, t === 'holds' ? 'HOLDS' : 'VOLUMES'), el('i', 'ed-pal-n', String(n)));
      b.type = 'button';
      b.setAttribute('aria-label', t === 'holds' ? `Holds, ${n} products` : `Volumes and macros, ${n} shapes`);
      b.addEventListener('click', () => this.showTab(t, true));
      this.tabs.set(t, b);
      tabRow.appendChild(b);
    }
    this.strip = el('div', 'ed-pal-strip');
    for (const t of ['holds', 'volumes'] as const) {
      const sec = el('div', `ed-pal-sec ed-pal-sec-${t}`);
      this.sections.set(t, sec);
      for (const e of CATALOG.filter((x) => x.tab === t)) {
        const c = el('canvas', 'ed-thumb');
        c.width = TILE_W * 2;
        c.height = TILE_H * 2;
        const b = el('button', `ed-tile ed-tile-${e.id}`, c, el('span', 'ed-tile-l', e.label));
        if (e.badge) b.appendChild(el('span', `ed-tile-badge b-${e.badge.toLowerCase()}`, e.badge));
        b.type = 'button';
        b.dataset.entry = e.id;
        b.setAttribute('aria-label', e.name);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => onPick(e.id));
        this.tiles.set(e.id, { b, c, e });
        sec.appendChild(b);
      }
      this.strip.appendChild(sec);
    }
    this.strip.addEventListener('scroll', this.onScroll, { passive: true });
    this.el = el('div', 'ed-pal', tabRow, this.strip);
    this.syncTabs();
  }

  /** Highlight the active product and (re)draw previews when the route colour changes. */
  render(activeId: string, color: string): void {
    if (activeId !== this.active) {
      const prev = this.tiles.get(this.active);
      if (prev) {
        toggle(prev.b, 'on', false);
        prev.b.setAttribute('aria-pressed', 'false');
      }
      this.active = activeId;
      const cur = this.tiles.get(activeId);
      if (cur) {
        toggle(cur.b, 'on', true);
        cur.b.setAttribute('aria-pressed', 'true');
        this.reveal(cur.b, cur.e.tab);
      }
    }
    if (color.toLowerCase() !== this.color) {
      this.color = color.toLowerCase();
      // the active tile first, then the visible tab, then the rest: a few per frame
      const ids = [...this.tiles.keys()];
      ids.sort((a, b) => this.rank(a) - this.rank(b));
      this.drawQueue = ids;
      if (!this.drawing) this.drawing = requestAnimationFrame(this.drawSome);
    }
  }

  private rank(id: string): number {
    const t = this.tiles.get(id)!;
    return id === this.active ? 0 : t.e.tab === this.tab ? 1 : 2;
  }

  private readonly drawSome = (): void => {
    this.drawing = 0;
    const t0 = performance.now();
    while (this.drawQueue.length && performance.now() - t0 < 8) {
      const id = this.drawQueue.shift()!;
      const t = this.tiles.get(id);
      if (!t) continue;
      const e = t.e;
      const ok = drawThumb(t.c, { type: e.type, shape: e.shape, fingers: e.fingers, seed: e.variant + 6, size: previewSize(e) }, { w: TILE_W, h: TILE_H, color: this.color, sized: true });
      if (!ok && !t.b.querySelector('.ed-hg')) {
        // no 2D canvas: the drawn glyph of its base type
        t.c.replaceWith(holdGlyph(e.type));
      }
    }
    if (this.drawQueue.length) this.drawing = requestAnimationFrame(this.drawSome);
  };

  private showTab(t: PaletteTab, scroll: boolean): void {
    this.tab = t;
    this.syncTabs();
    if (!scroll) return;
    const sec = this.sections.get(t);
    if (!sec) return;
    const left = t === 'holds' ? 0 : this.leftOf(sec) - 6;
    try {
      this.strip.scrollTo({ left, behavior: 'smooth' });
    } catch {
      this.strip.scrollLeft = left;
    }
  }

  private syncTabs(): void {
    for (const [k, b] of this.tabs) {
      toggle(b, 'on', k === this.tab);
      b.setAttribute('aria-pressed', String(k === this.tab));
    }
  }

  /** Scroll the active tile into view (and its tab), without moving the page. */
  private reveal(b: HTMLElement, tab: PaletteTab): void {
    if (tab !== this.tab) {
      this.tab = tab;
      this.syncTabs();
    }
    const s = this.strip;
    const l = this.leftOf(b);
    const r = l + b.offsetWidth;
    if (l < s.scrollLeft + 4) s.scrollLeft = Math.max(0, l - 24);
    else if (r > s.scrollLeft + s.clientWidth - 4) s.scrollLeft = r - s.clientWidth + 24;
  }

  private readonly onScroll = (): void => {
    const vol = this.sections.get('volumes');
    if (!vol) return;
    const t: PaletteTab = this.strip.scrollLeft + this.strip.clientWidth * 0.5 >= this.leftOf(vol) ? 'volumes' : 'holds';
    if (t !== this.tab) {
      this.tab = t;
      this.syncTabs();
    }
  };

  /** Left edge of an element in the strip's scroll coordinates. */
  private leftOf(e: HTMLElement): number {
    return e.getBoundingClientRect().left - this.strip.getBoundingClientRect().left + this.strip.scrollLeft;
  }

  /** Short status for the tab row: the active product's name. */
  label(): string {
    return this.tiles.get(this.active)?.e.name ?? '';
  }

  dispose(): void {
    if (this.drawing) cancelAnimationFrame(this.drawing);
    this.drawing = 0;
  }
}

/** The size a tile shows its product at (its default size). */
function previewSize(e: CatalogEntry): number {
  switch (e.id) {
    case 'jug':
      return 0.1;
    case 'bucket':
      return 0.115;
    case 'macro':
      return 0.15;
    default:
      return e.type === 'volume' ? 0.3 : e.type === 'foot' ? 0.03 : e.type === 'crimp' ? 0.04 : e.type === 'pocket' ? 0.055 : 0.07;
  }
}

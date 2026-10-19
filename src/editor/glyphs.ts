// Editor-only glyphs, drawn to match the UI icon set (24×24 grid, 1.75px hairline strokes, square caps)
// plus filled mini silhouettes of each hold type for the palette.

import type { HoldType } from '../core/types';

const S = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${body}</svg>`;

/** Filled hold silhouettes: body in currentColor, incut/shadow in translucent black, bolt dot. */
const H = (body: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const SH = 'fill="rgba(0,0,0,.34)"';
const BOLT = (x: number, y: number): string => `<circle cx="${x}" cy="${y}" r="1.05" fill="rgba(0,0,0,.6)"/>`;

export const EDITOR_GLYPHS = {
  undo: S('<path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4.5 9h10a5.5 5.5 0 0 1 0 11H10"/>'),
  redo: S('<path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M19.5 9h-10a5.5 5.5 0 0 0 0 11H14"/>'),
  rotL: S('<path d="M5 12.5a7 7 0 1 0 2.1-5"/><path d="M6.6 3.4v4h4"/><path d="M12 9.5v3l2 1.5" stroke-width="1.5"/>'),
  rotR: S('<path d="M19 12.5a7 7 0 1 1-2.1-5"/><path d="M17.4 3.4v4h-4"/><path d="M12 9.5v3l-2 1.5" stroke-width="1.5"/>'),
  snap: S('<circle cx="6" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.2" fill="currentColor" stroke="none"/><path d="M9.2 12H3.5M20.5 12h-5.7M12 3.5v5.7M12 20.5v-5.7" stroke-width="1.4"/>'),
  free: S('<path d="M12 3.5v17M3.5 12h17" stroke-dasharray="2 2.4"/><circle cx="12" cy="12" r="3.2"/>'),
  more: S('<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>'),
  shape: S('<path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8z"/><path d="M12 12 19.5 8M12 12v8.5M12 12 4.5 8" stroke-width="1.3"/>'),
  size: S('<path d="M4 20 20 4"/><path d="M13.5 4H20v6.5M10.5 20H4v-6.5"/>'),
  done: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  newDoc: S('<path d="M5 3.5h9l5 5v12H5z"/><path d="M14 3.5v5h5"/><path d="M12 11.5v6M9 14.5h6"/>'),
  sample: S('<path d="M4 20.5 10.5 9l3.6 6 2.4-3.2 3.5 8.7z"/><circle cx="16.5" cy="5.5" r="2"/>'),
  clear: S('<path d="M4 6.8h16M9.2 6.8V3.8h5.6v3M6 6.8l1 13.4h10l1-13.4"/><path d="M9.5 11l5 5M14.5 11l-5 5"/>'),
  beta: S('<circle cx="6" cy="18" r="2.2"/><circle cx="12" cy="11" r="2.2"/><circle cx="18" cy="5" r="2.2"/><path d="M7.6 16.3l2.8-3.3M13.6 9.3l2.8-2.6" stroke-dasharray="1.6 1.6"/>'),
  palette: S('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.1-1.6-1.1-2.7 0-1 .8-1.6 1.8-1.6h2.4a3.6 3.6 0 0 0 3.6-3.6C20.5 6.8 16.7 3.5 12 3.5z"/><circle cx="7.6" cy="11.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="7.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="7.6" r="1.1" fill="currentColor" stroke="none"/>'),
  photo: S('<path d="M3.5 8.5h3.6l1.7-2.6h6.4l1.7 2.6h3.6v11h-17z"/><circle cx="12" cy="13.6" r="3.4"/><circle cx="17.6" cy="11" r=".6" fill="currentColor" stroke="none"/>'),
  minus: S('<path d="M5 12h14"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
} as const;

export type EditorGlyph = keyof typeof EDITOR_GLYPHS;

export const HOLD_GLYPHS: Readonly<Record<HoldType, string>> = {
  jug: H(
    `<path d="M3.6 10.2C3.6 6.5 7.4 4.3 12 4.3s8.4 2.2 8.4 5.9c0 5.3-3.8 9.5-8.4 9.5s-8.4-4.2-8.4-9.5z" fill="currentColor"/>` +
      `<path d="M6.4 9.4c1.5 1.5 3.4 2.2 5.6 2.2s4.1-.7 5.6-2.2c-.6 3.3-2.9 5.2-5.6 5.2s-5-1.9-5.6-5.2z" ${SH}/>` +
      BOLT(12, 16.6),
  ),
  edge: H(
    `<path d="M2.8 10.4c0-1.3 1-2.3 2.3-2.3h13.8c1.3 0 2.3 1 2.3 2.3v1.4c0 2.4-2 4.3-4.3 4.3H7.1c-2.4 0-4.3-1.9-4.3-4.3z" fill="currentColor"/>` +
      `<path d="M4.4 10.6h15.2v1.2H4.4z" ${SH}/>` +
      BOLT(12, 13.8),
  ),
  crimp: H(
    `<path d="M2.6 11.4c0-.9.7-1.6 1.6-1.6h15.6c.9 0 1.6.7 1.6 1.6 0 1.5-1.2 2.7-2.7 2.7H5.3c-1.5 0-2.7-1.2-2.7-2.7z" fill="currentColor"/>` +
      `<path d="M4.2 11.2h15.6v.7H4.2z" ${SH}/>` +
      BOLT(12, 12.8),
  ),
  sloper: H(
    `<path d="M2.8 16.2c0-5.4 4.1-9.6 9.2-9.6s9.2 4.2 9.2 9.6c0 1.4-1.1 2.4-2.4 2.4H5.2c-1.3 0-2.4-1-2.4-2.4z" fill="currentColor"/>` +
      `<path d="M7.2 9.4c1.3-.9 2.9-1.4 4.8-1.4" stroke="rgba(255,255,255,.42)" stroke-width="1.3" fill="none" stroke-linecap="round"/>` +
      BOLT(12, 14),
  ),
  pinch: H(
    `<path d="M9.4 3.2c1.7-.7 3.5-.7 5.2 0 .7 3 1 5.9 1 8.8s-.3 5.8-1 8.8c-1.7.7-3.5.7-5.2 0-.7-3-1-5.9-1-8.8s.3-5.8 1-8.8z" fill="currentColor"/>` +
      `<path d="M10.7 5.2h1.1v13.6h-1.1z" ${SH}/>` +
      BOLT(13.4, 12),
  ),
  pocket: H(
    `<ellipse cx="12" cy="12.4" rx="8.4" ry="7.2" fill="currentColor"/>` +
      `<ellipse cx="12" cy="10.6" rx="4" ry="2.9" fill="rgba(0,0,0,.62)"/>` +
      BOLT(12, 16.4),
  ),
  foot: H(
    `<path d="M6.6 13.2c0-2.1 2.4-3.7 5.4-3.7s5.4 1.6 5.4 3.7-2.4 3.2-5.4 3.2-5.4-1.1-5.4-3.2z" fill="currentColor"/>` + BOLT(12, 13.2),
  ),
  volume: H(
    `<path d="M12 3.2 21.2 18.6H2.8z" fill="currentColor"/>` +
      `<path d="M12 3.2v9.6l9.2 5.8z" ${SH}/>` +
      `<path d="M12 12.8 2.8 18.6" stroke="rgba(0,0,0,.3)" stroke-width="1"/>` +
      BOLT(9.4, 14.6) +
      BOLT(12.6, 7.8),
  ),
};

const parsed = new Map<string, SVGSVGElement>();

function parse(markup: string): SVGSVGElement {
  let base = parsed.get(markup);
  if (!base) {
    const t = document.createElement('template');
    t.innerHTML = markup;
    base = t.content.firstElementChild as SVGSVGElement;
    parsed.set(markup, base);
  }
  return base.cloneNode(true) as SVGSVGElement;
}

export function glyph(name: EditorGlyph, cls = ''): SVGSVGElement {
  const n = parse(EDITOR_GLYPHS[name]);
  n.setAttribute('class', `ic ic-${name} ${cls}`.trim());
  return n;
}

export function holdGlyph(type: HoldType, cls = ''): SVGSVGElement {
  const n = parse(HOLD_GLYPHS[type]);
  n.setAttribute('class', `ed-hg ed-hg-${type} ${cls}`.trim());
  return n;
}

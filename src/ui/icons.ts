// Custom inline SVG icon set: 24×24 grid, 1.75px hairline-technical strokes, square caps.
// Single colour via currentColor. Parsed once, then cloned.

const S = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;
const R = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  pause: S('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="2.4"/>'),
  play: S('<path d="M8 5.2 19 12 8 18.8z" fill="currentColor" stroke="none"/>'),
  back: S('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  chevron: S('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  arrow: S('<path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5"/>'),
  up: S('<path d="M12 19.5V5M6.5 10.5 12 5l5.5 5.5"/>'),
  close: S('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  podium: S('<path d="M3 20.5h18M9 20.5V9h6v11.5M3.5 20.5V13H9M15 15.5h5.5v5"/><path d="M12 2.8l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L9.1 4.9l2-.3z" fill="currentColor" stroke="none"/>'),
  hanger: R('<path d="M12 8.2V7.4c0-.7.5-1 1.1-1.4a2.1 2.1 0 1 0-3.2-1.8"/><path d="M12 8.2 3.2 15.3c-.7.6-.3 1.7.6 1.7h16.4c.9 0 1.3-1.1.6-1.7z"/>'),
  create: S('<path d="M3.5 3.5h11v17h-11z"/><circle cx="7" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="11" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="7.4" cy="16.4" r="1.1" fill="currentColor" stroke="none"/><path d="M19 13v7M15.5 16.5h7"/>'),
  community: R('<circle cx="9" cy="8.2" r="3.2"/><path d="M3 20c.4-3.6 2.8-5.8 6-5.8s5.6 2.2 6 5.8"/><path d="M15.2 5.1a3.2 3.2 0 0 1 0 6.2M17.5 14.6c2 .8 3.2 2.7 3.5 5.4"/>'),
  globe: S('<circle cx="12" cy="12" r="8.75"/><path d="M3.5 12h17M12 3.25c2.4 2.4 3.6 5.3 3.6 8.75s-1.2 6.35-3.6 8.75c-2.4-2.4-3.6-5.3-3.6-8.75S9.6 5.65 12 3.25z"/>'),
  offline: S('<path d="M4 4l16 16"/><path d="M8.6 8.9A7 7 0 0 0 5 15M2.5 10.8A11 11 0 0 1 6.2 7.2M12.9 6.6a11 11 0 0 1 8.6 4.2M15 12.3a7 7 0 0 1 3.5 2.7"/><circle cx="12" cy="18.2" r="1.3" fill="currentColor" stroke="none"/>'),
  tune: S('<path d="M4 6.5h9M17.5 6.5H20M4 12h3M11.5 12H20M4 17.5h11M19.5 17.5h.5"/><path d="M13 4.2h4.5v4.6H13zM7 9.7h4.5v4.6H7zM15 15.2h4.5v4.6H15z"/>'),
  user: R('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.6-4.1 3.6-6.7 7.5-6.7s6.9 2.6 7.5 6.7"/>'),
  bulb: R('<path d="M9.2 17.5h5.6M10 20.8h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2v.7h5.2v-.7c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>'),
  eye: R('<path d="M2.2 12S5.8 5.2 12 5.2 21.8 12 21.8 12 18.2 18.8 12 18.8 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="3.1"/>'),
  flame: R('<path d="M12.2 2.8c.4 3.4 5.3 5.6 5.3 10.6a5.5 5.5 0 0 1-11 0c0-2.2 1-3.9 2.6-5 0 2 .9 3.2 2 3.4-.2-3.6-.6-6.3 1.1-9z" fill="currentColor" stroke="none"/>'),
  forearm: R('<path d="M3.8 21.2 9.6 14M8.6 21.6l5.6-6.8"/><path d="M9.6 14 9.2 9.4c-.1-1.3.9-2.4 2.2-2.4h6.3c1.5 0 2.7 1.2 2.7 2.7v2.6c0 1.9-1.6 3.4-3.5 3.4h-2.3"/><path d="M12.6 7v3.4M15.6 7v3.4M18.5 7.4v3"/><path d="M9.4 11.2h3.4"/>'),
  pulse: S('<path d="M2.5 12.5h4l2.2-6 4.6 12 2.4-6h5.8"/>'),
  rope: R('<path d="M12 12c2.4-1.6 4.1-3.2 4.1-5.1a4.1 4.1 0 0 0-8.2 0c0 1.9 1.7 3.5 4.1 5.1zm0 0c-2.4 1.6-4.1 3.2-4.1 5.1a4.1 4.1 0 0 0 8.2 0c0-1.9-1.7-3.5-4.1-5.1z"/><path d="M8.6 20.2 5.2 22.6M15.4 3.8l3.4-2.4"/>'),
  carabiner: R('<path d="M18.3 9.8c.5-3.7-2-6.8-5.4-6.8h-2.6C7.9 3 6 4.9 6 7.3v10.1C6 19.4 7.6 21 9.6 21h1.2c1.1 0 2.1-.6 2.7-1.5"/><path d="M17.6 12 14.3 18"/><path d="M8.6 7.2v9.4" stroke-opacity=".45"/>'),
  stopwatch: S('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4.2l2.6 2.1M9.5 2.75h5M18.3 6.6l1.4-1.4"/>'),
  lock: S('<path d="M5 10.5h14v10H5z"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/><path d="M12 14.2v2.6"/>'),
  dice: R('<rect x="3.8" y="3.8" width="16.4" height="16.4" rx="3.2"/><circle cx="8.5" cy="8.5" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.25" fill="currentColor" stroke="none"/>'),
  retry: S('<path d="M4.8 12.2a7.4 7.4 0 1 0 2.4-5.6"/><path d="M5.2 3.6v4h4"/>'),
  home: S('<path d="M4 10.8 12 4l8 6.8V20h-5.4v-5.6H9.4V20H4z"/>'),
  sound: S('<path d="M4 9.2h3.8L12.5 5v14l-4.7-4.2H4z"/><path d="M15.8 9.2a4 4 0 0 1 0 5.6M18.4 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  mute: S('<path d="M4 9.2h3.8L12.5 5v14l-4.7-4.2H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  music: R('<path d="M9 17.8V5.4l10.5-2v12.4"/><ellipse cx="6.7" cy="17.8" rx="2.4" ry="2" fill="currentColor"/><ellipse cx="17.2" cy="15.8" rx="2.4" ry="2" fill="currentColor"/>'),
  haptic: S('<path d="M8.2 3.5h7.6v17H8.2z"/><path d="M11 17.6h2M4.5 8v8M2 10v4M19.5 8v8M22 10v4"/>'),
  target: S('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
  motion: R('<path d="M3 8.5c2.5-2.3 4.5-2.3 7 0s4.5 2.3 7 0M3 15.5c2.5-2.3 4.5-2.3 7 0s4.5 2.3 7 0"/><path d="M20.5 6v12" stroke-dasharray="1 2.6"/>'),
  layers: S('<path d="M12 3.5 21 8.4 12 13.3 3 8.4z"/><path d="M3 12.6l9 4.9 9-4.9M3 16.6l9 4.9 9-4.9"/>'),
  trash: S('<path d="M4 6.8h16M9.2 6.8V3.8h5.6v3M6 6.8l1 13.4h10l1-13.4M10 10.5v6M14 10.5v6"/>'),
  edit: S('<path d="M4.2 19.8h4.2L19.3 8.9 15.1 4.7 4.2 15.6z"/><path d="M12.6 7.2l4.2 4.2"/>'),
  star: S('<path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 16.6l-5.3 2.9 1.1-5.9-4.4-4.1 6-.8z"/>'),
  medal: S('<circle cx="12" cy="15" r="5.8"/><path d="M8.2 10.6 5.6 3.5h4.2L12 8.6l2.2-5.1h4.2l-2.6 7.1"/>'),
  peak: S('<path d="M2.5 20 9.2 8.2l3.6 5.6 2.4-3.4L21.5 20z"/><path d="M7.6 11 9.2 12.4l1.4-1.5"/>'),
  angle: S('<path d="M4 20.5h16M4 20.5 14.5 4"/><path d="M10.5 20.5a6.6 6.6 0 0 0-2.6-5.6" stroke-dasharray="1.6 1.8"/>'),
  holds: R('<path d="M6.5 5.2c1.8-.9 3.9 0 4.3 1.8.4 1.7-.9 3.3-2.8 3.4-1.8.1-3.3-.8-3.3-2.4 0-1.2.7-2.2 1.8-2.8z" fill="currentColor"/><path d="M15.2 11.4c2-.6 4.1.6 4.3 2.6.2 1.8-1.5 3.1-3.4 2.9-1.6-.1-2.9-1.2-2.8-2.6 0-1.3.8-2.5 1.9-2.9z" fill="currentColor"/><circle cx="7.6" cy="17.6" r="1.6" fill="currentColor"/><circle cx="16.8" cy="5.4" r="1.2" fill="currentColor"/>'),
  flag: S('<path d="M5.5 21V3.8M5.5 4.5h12.5l-2.6 4.2 2.6 4.2H5.5"/>'),
  skip: S('<path d="M5 5.5 12 12l-7 6.5zM12 5.5l7 6.5-7 6.5z" fill="currentColor" stroke="none"/><path d="M20 5.5v13" stroke-width="2"/>'),
  warn: S('<path d="M12 3.5 21.5 20h-19z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.2" r="1" fill="currentColor" stroke="none"/>'),
  bolt: S('<path d="M13.4 2.8 5 13.5h6l-1.4 7.7L18 10.5h-6z" fill="currentColor" stroke="none"/>'),
  refresh: S('<path d="M19.6 10.2A8 8 0 0 0 5.4 7.4M4.4 13.8a8 8 0 0 0 14.2 2.8"/><path d="M5 3.4v4h4M19 20.6v-4h-4"/>'),
  calendar: S('<path d="M3.8 5.6h16.4v14.6H3.8zM3.8 10h16.4M8 3v4.4M16 3v4.4"/><path d="M8.6 13.6h2.4v2.4H8.6z" fill="currentColor"/>'),
  train: S('<path d="M5 20l7-6 7 6M5 14.2l7-6 7 6M5 8.4l7-6 7 6"/>'),
  tower: S('<path d="M3.5 21.5h17"/><path d="M8.5 21.5 15 16.5 9 11.5l6-4.5-3-4.5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15" cy="16.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="9" cy="11.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.7" fill="currentColor" stroke="none"/><path d="M10 2.5h4" stroke-width="2"/>'),
  horns: R('<path d="M10.2 13.6C9.4 8.8 7 5.2 3.4 3.2M13.8 13.6c.8-4.8 3.2-8.4 6.8-10.4" stroke-width="2.4"/><path d="M5.6 4.4l-1.2 1.6M7.6 6.4 6.2 7.7M9 8.8l-1.5 1M18.4 4.4l1.2 1.6M16.4 6.4l1.4 1.3M15 8.8l1.5 1" stroke-width="1.2"/><path d="M8.6 13.4h6.8l-1.3 5.4c-.3 1.4-1.2 2.2-2.1 2.2s-1.8-.8-2.1-2.2z"/>'),
  info: S('<circle cx="12" cy="12" r="8.75"/><path d="M12 10.8v5.6"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>'),
  chalk: R('<path d="M6 8.5h12l-1.3 11.2c-.1.8-.7 1.3-1.5 1.3H8.8c-.8 0-1.4-.5-1.5-1.3z"/><path d="M5.2 8.5h13.6M9 8.5V6.4c0-1.6 1.4-2.9 3-2.9s3 1.3 3 2.9v2.1"/><path d="M9.6 13h4.8" stroke-dasharray="1.2 1.8"/>'),
  shirt: S('<path d="M8.6 3.6 3.4 6.8l1.9 4 2.2-1v10.6h9V9.8l2.2 1 1.9-4-5.2-3.2c-.5 1.5-1.8 2.4-3.4 2.4s-2.9-.9-3.4-2.4z"/>'),
  height: S('<path d="M7 3.5v17M4.5 6 7 3.5 9.5 6M4.5 18 7 20.5 9.5 18"/><path d="M13 5h7M13 9.5h4M13 14h7M13 18.5h4"/>'),
  pure: R('<circle cx="12" cy="4.4" r="1.9"/><path d="M12 7.3v6M12 13.3l-3.6 7M12 13.3l3.4 3.2.4 4.1M12 8.8 7.6 5.8 6.4 3M12 8.8l4.3 1.2 1.5-3.4"/>'),
  hash: S('<path d="M9.5 3.5 8 20.5M16 3.5l-1.5 17M4 9h16.5M3.5 15H20"/>'),
} as const;

export type IconName = keyof typeof ICONS;

const cache = new Map<IconName, SVGSVGElement>();

/** A fresh SVG element for an icon. */
export function icon(name: IconName, cls = ''): SVGSVGElement {
  let base = cache.get(name);
  if (!base) {
    const t = document.createElement('template');
    t.innerHTML = ICONS[name];
    base = t.content.firstElementChild as SVGSVGElement;
    cache.set(name, base);
  }
  const node = base.cloneNode(true) as SVGSVGElement;
  node.setAttribute('class', `ic ic-${name} ${cls}`.trim());
  return node;
}

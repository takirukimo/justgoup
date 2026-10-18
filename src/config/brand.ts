// Brand + design tokens. Swap the logo/colours here to re-brand the whole game
// (wall textures, crash pads, volumes, UI and the splash all read from this file).

const MARK_PATHS = [
    'M0,3.36c7.64-.17,37.64.05,63.16,22.49,16.6,14.6,23.47,31.72,26.22,40.19h-25c-2.03-7.73-7.32-23.62-21.44-38.3C26.54,10.69,7.75,5.18,0,3.36Z',
    'M7,1.36C15.41.04,56.7-5.55,92.63,21.94c19.87,15.2,29.46,33.91,33.75,44.1h-33c-2.71-8.43-9.82-26.58-27.56-41.97C42.05,3.45,15.17,1.61,7,1.36Z',
  ];
const WORDMARK_PATHS = [
    'M0,35.9C0,13.1,12.8,0,32.6,0c15,0,27,7.6,28.6,24.1h-12.8c-2.1-8.8-8.3-12.7-16.1-12.7-12.7,0-18.9,10-18.9,24.5s6,24.6,18.9,24.6c7.8,0,14-3.9,16.1-12.9h12.8c-1.6,16.7-13.6,24.3-28.7,24.3C12.8,71.9,0,58.8,0,35.9Z',
    'M112.7,41.6h-30v29.3h-13.1V.9h13.1v29.8h30V.9h13.1v70h-13.1v-29.3Z',
    'M137.1.9h13.1v70h-13.1V.9Z',
    'M161.4.9h27.5c18,0,26.2,9.3,26.2,22.9,0,10.1-4.6,17.9-14.6,21.1l15.2,26h-13.1l-13.9-24.3h-14.2v24.3h-13.1V.9ZM201.6,23.8c0-7.1-4.2-11.4-13.2-11.4h-13.9v22.7h13.9c9,0,13.2-4.3,13.2-11.3Z',
    'M245.7.9h16.8l25.7,70h-13.9l-5-14.3h-30.5l-5,14.3h-13.8L245.7.9ZM265.9,46.8l-11.4-32.4h-.8l-11.4,32.4h23.6Z',
    'M295.4.9h13.1v58.5h33.2v11.5h-46.3V.9Z',
    'M371.4,48.7h13.5c.4,6.8,4.6,12.2,15.1,12.2,8.9,0,13.8-3.8,13.8-10.1,0-5.7-3.9-8.2-10.9-9.6l-9.6-1.9c-11.4-2.2-20-7.5-20-19.3,0-12.9,10.3-20,26.3-20s26.2,7.3,26.2,20.8h-13.5c0-6.4-5-9.8-13-9.8-8.9,0-12.2,4.2-12.2,9,0,3.9,2.4,7.3,9.4,8.8l9,1.8c15.6,3.1,22.2,9.2,22.2,20.1,0,14.4-11.8,21.2-27.8,21.2-17.9,0-28.5-8.6-28.5-23.2Z',
    'M437,.9h27.5c18,0,26.2,9.3,26.2,22.9s-8.2,22.8-26.2,22.8h-14.4v24.3h-13.1V.9ZM477.2,23.8c0-7.1-4.2-11.4-13.2-11.4h-13.9v22.7h13.9c9,0,13.2-4.3,13.2-11.3Z',
    'M497.39,35.9c0-22,13.3-35.9,32.9-35.9s33,13.9,33,35.9-13.4,36-33,36-32.9-14.1-32.9-36ZM549.7,35.9c0-15.4-7.4-24.5-19.4-24.5s-19.4,9.1-19.4,24.5,7.4,24.6,19.4,24.6,19.4-9.3,19.4-24.6Z',
    'M572.49.9h27.5c18,0,26.2,9.3,26.2,22.9,0,10.1-4.6,17.9-14.6,21.1l15.2,26h-13.1l-13.9-24.3h-14.2v24.3h-13.1V.9ZM612.7,23.8c0-7.1-4.2-11.4-13.2-11.4h-13.9v22.7h13.9c9,0,13.2-4.3,13.2-11.3Z',
    'M650.89,12.6h-20.8V.9h54.7v11.7h-20.8v58.3h-13.1V12.6Z',
    'M689.09,48.7h13.5c.4,6.8,4.6,12.2,15.1,12.2,8.9,0,13.8-3.8,13.8-10.1,0-5.7-3.9-8.2-10.9-9.6l-9.6-1.9c-11.4-2.2-20-7.5-20-19.3,0-12.9,10.3-20,26.3-20s26.2,7.3,26.2,20.8h-13.5c0-6.4-5-9.8-13-9.8-8.9,0-12.2,4.2-12.2,9,0,3.9,2.4,7.3,9.4,8.8l9,1.8c15.6,3.1,22.2,9.2,22.2,20.1,0,14.4-11.8,21.2-27.8,21.2-17.9,0-28.5-8.6-28.5-23.2Z',
  ];

export const BRAND = {
  /** Wall / pad / UI brand. */
  name: 'CHIRAL',
  sub: 'SPORTS',
  /** Game title (owner's decision: STEIBOCK, Swiss German for ibex). */
  game: 'STEIBOCK',
  tagline: 'BY CHIRAL SPORTS',
  gym: 'CHIRAL HQ',
  guideName: 'Steini',

  /** CHIRAL SPORTS pink (official). */
  pink: '#D54051',

  /**
   * Official CHIRAL SPORTS mark (two swooshes that read like ibex horns), from
   * assets/brand/chiral-mark.svg. viewBox = markViewBox. Single colour via `currentColor`.
   */
  markViewBox: [126.37, 66.04] as const,
  markPaths: MARK_PATHS,
  /** Official wordmark "CHIRAL SPORTS" as outlined paths (assets/brand/chiral-wordmark.svg). */
  wordmarkViewBox: [745.4, 71.9] as const,
  wordmarkPaths: WORDMARK_PATHS,
  logoSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 126.37 66.04" fill="currentColor">' +
    MARK_PATHS.map((d) => `<path d="${d}"/>`).join('') +
    '</svg>',
  wordmarkSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 745.4 71.9" fill="currentColor">' +
    WORDMARK_PATHS.map((d) => `<path d="${d}"/>`).join('') +
    '</svg>',
  /** Mark + wordmark lockup (spacing from the official lockup; mark bottom on the baseline). */
  lockupSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 911.14 71.9" fill="currentColor">' +
    '<g transform="translate(0 5.86)">' +
    MARK_PATHS.map((d) => `<path d="${d}"/>`).join('') +
    '</g><g transform="translate(165.74 0)">' +
    WORDMARK_PATHS.map((d) => `<path d="${d}"/>`).join('') +
    '</g></svg>',
  /**
   * The mark normalised into a 64×64 box (centred) for canvas Path2D drawing code that assumes
   * a square logo box (wall textures, decals).
   */
  logoPaths: [
    'M0 16.979c3.869 -0.086 19.063 0.025 31.987 11.39 8.407 7.394 11.886 16.065 13.279 20.354h-12.661c-1.028 -3.915 -3.707 -11.962 -10.858 -19.397C13.441 20.691 3.925 17.9 0 16.979Z',
    'M3.545 15.966C7.804 15.297 28.716 12.466 46.912 26.389c10.063 7.698 14.92 17.174 17.093 22.334h-16.713c-1.372 -4.269 -4.973 -13.461 -13.958 -21.256C21.296 17.024 7.683 16.092 3.545 15.966Z',
  ],
} as const;

/** Core palette — "alpine technical": near-black basalt, bone/chalk whites, one brand accent (CHIRAL pink). */
export const PALETTE = {
  basalt: '#0D0E10',
  graphite: '#17191D',
  slate: '#23272E',
  steel: '#3A4049',
  fog: '#8B929C',
  mist: '#B9BEC5',
  bone: '#E9E5DD',
  chalk: '#F6F4EF',
  signal: '#D54051', // primary accent: CHIRAL SPORTS pink (replaces the old signal orange everywhere)
  signalDeep: '#A8303F',
  glacier: '#9AD4DE', // secondary accent
  moss: '#7C8B5A',
  good: '#4FD18B',
  warn: '#FFB23F',
  bad: '#FF4545',
} as const;

/** Route colours (gym tape colours, slightly desaturated for a premium look). */
export const ROUTE_COLORS: readonly { name: string; hex: string }[] = [
  { name: 'Yellow', hex: '#F2C230' },
  { name: 'Blue', hex: '#2F6FEB' },
  { name: 'Green', hex: '#2FB36D' },
  { name: 'Red', hex: '#E5433B' },
  { name: 'Purple', hex: '#8B5CF6' },
  { name: 'Orange', hex: '#FF7A1A' },
  { name: 'Pink', hex: '#F06EA9' },
  { name: 'White', hex: '#EDEDED' },
  { name: 'Black', hex: '#1E1F22' },
  { name: 'Teal', hex: '#21B8B0' },
] as const;

/** Wall material colours. */
export const WALL = {
  panel: '#2B2D31', // charcoal plywood
  panelAlt: '#323439',
  seam: '#1A1B1E',
  tnut: '#121314',
  logoTone: 'rgba(255,255,255,0.055)', // tone-on-tone wordmark
  mat: '#1F2124', // crash pads
  matStripe: '#D54051',
  volumeColors: ['#E9E5DD', '#2B2D31', '#D54051', '#9AD4DE', '#55606E'],
} as const;

/** UI typography (Google Fonts loaded in index.html; system fallbacks keep it offline-safe). */
export const FONTS = {
  display: "'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif",
  ui: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

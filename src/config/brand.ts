// Brand + design tokens. Swap the logo/colours here to re-brand the whole game
// (wall textures, crash pads, volumes, UI and the splash all read from this file).

export const BRAND = {
  /** Wall / pad / UI brand. */
  name: 'CHIRAL',
  sub: 'SPORTS',
  /** Game title. */
  game: 'JUST GO UP',
  tagline: 'A CHIRAL BOULDERING GAME',
  gym: 'CHIRAL HQ',
  guideName: 'Steini',

  /**
   * Logo mark: two mirror-image shards, offset — a pair that can never be superimposed (chirality).
   * 64×64 viewBox, single colour via `currentColor`.
   */
  logoSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor">' +
    '<path d="M6 6h22v36L6 54z"/><path d="M58 12H36v36l22 12z"/></svg>',
  /** Path data of the mark (for canvas Path2D in wall textures), same 64×64 box. */
  logoPaths: ['M6 6h22v36L6 54z', 'M58 12H36v36l22 12z'],
} as const;

/** Core palette — "alpine technical": near-black basalt, bone/chalk whites, one hot signal accent. */
export const PALETTE = {
  basalt: '#0D0E10',
  graphite: '#17191D',
  slate: '#23272E',
  steel: '#3A4049',
  fog: '#8B929C',
  mist: '#B9BEC5',
  bone: '#E9E5DD',
  chalk: '#F6F4EF',
  signal: '#FF4F1F', // primary accent (safety orange)
  signalDeep: '#C93A12',
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
  matStripe: '#FF4F1F',
  volumeColors: ['#E9E5DD', '#2B2D31', '#FF4F1F', '#9AD4DE', '#55606E'],
} as const;

/** UI typography (Google Fonts loaded in index.html; system fallbacks keep it offline-safe). */
export const FONTS = {
  display: "'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif",
  ui: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

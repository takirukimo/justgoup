import type { ChalkId, ColorwayId, HeadId } from '../core/types';

/** Unlock rule: lifetime points (profile.stats.totalScore), a stat, or the tutorial. */
export type Unlock =
  | { kind: 'free' }
  | { kind: 'tutorial' }
  | { kind: 'points'; points: number }
  | { kind: 'grade'; grade: number } // send a problem of at least this grade
  | { kind: 'streak'; streak: number } // sends in a row in one run
  | { kind: 'rope-top' } // top out the Lead Tower
  | { kind: 'clips'; clips: number }
  | { kind: 'flashes'; flashes: number };

export interface HeadDef {
  id: HeadId;
  name: string;
  /** Swiss/German flavour name shown small under the name. */
  local: string;
  blurb: string;
  unlock: Unlock;
  /** Fur/feather base + secondary + accent (horns, beak) colours for the procedural head. */
  colors: { base: string; secondary: string; accent: string; eye: string };
}

export const HEADS: readonly HeadDef[] = [
  {
    id: 'ibex',
    name: 'Alpine Ibex',
    local: 'Steinbock',
    blurb: 'Climbs 50° dam walls for salt. You have no excuse.',
    unlock: { kind: 'free' },
    colors: { base: '#8A7458', secondary: '#5E4C38', accent: '#C9B79A', eye: '#1A140E' },
  },
  {
    id: 'marmot',
    name: 'Marmot',
    local: 'Murmeli',
    blurb: 'Whistles at danger. Sleeps six months. Sends in between.',
    unlock: { kind: 'tutorial' },
    colors: { base: '#9C7A55', secondary: '#D9C3A0', accent: '#2A1E14', eye: '#120C08' },
  },
  {
    id: 'chamois',
    name: 'Chamois',
    local: 'Gämse',
    blurb: 'Hooked horns, zero fear, perfect footwork.',
    unlock: { kind: 'points', points: 1500 },
    colors: { base: '#6B5440', secondary: '#E8DCC8', accent: '#1B1714', eye: '#120D09' },
  },
  {
    id: 'goat',
    name: 'Mountain Goat',
    local: 'Schneeziege',
    blurb: 'Beard for friction. Hooves for crimps.',
    unlock: { kind: 'points', points: 4000 },
    colors: { base: '#F1EEE7', secondary: '#D8D2C6', accent: '#1E1D1B', eye: '#1A1A1A' },
  },
  {
    id: 'eagle',
    name: 'Golden Eagle',
    local: 'Steinadler',
    blurb: 'Reads the line from 3,000 meters up.',
    unlock: { kind: 'grade', grade: 5 },
    colors: { base: '#5A3E26', secondary: '#C79A4E', accent: '#F2B632', eye: '#E8A417' },
  },
  {
    id: 'snowleopard',
    name: 'Snow Leopard',
    local: 'Schneeleopard',
    blurb: 'Silent feet. Long tail for balance. Unfair, really.',
    unlock: { kind: 'points', points: 9000 },
    colors: { base: '#D9D6CF', secondary: '#3B3A38', accent: '#F4F1EA', eye: '#7FB7A8' },
  },
  {
    id: 'lynx',
    name: 'Lynx',
    local: 'Luchs',
    blurb: 'Ear tufts as wind gauges. Ambush dynos.',
    unlock: { kind: 'streak', streak: 8 },
    colors: { base: '#B88A5A', secondary: '#EADBC4', accent: '#1F1712', eye: '#C8A23A' },
  },
  {
    id: 'ram',
    name: 'Bighorn Ram',
    local: 'Widder',
    blurb: 'Headbutts plateaus into submission.',
    unlock: { kind: 'rope-top' },
    colors: { base: '#7C6650', secondary: '#E3D6C2', accent: '#B8A486', eye: '#1A140E' },
  },
  {
    id: 'vulture',
    name: 'Bearded Vulture',
    local: 'Bartgeier',
    blurb: 'Drops bones from cliffs. Drops grades from V10.',
    unlock: { kind: 'points', points: 25000 },
    colors: { base: '#3A3A3D', secondary: '#E7A552', accent: '#D8D2C4', eye: '#E04A2A' },
  },
  {
    id: 'human',
    name: 'Human',
    local: 'Mönsch',
    blurb: 'No horns, no hooves. Just a CHIRAL SPORTS cap and stubbornness.',
    unlock: { kind: 'free' },
    // base = skin, secondary = hair, accent = cap, eye = iris
    colors: { base: '#C99A78', secondary: '#2B2420', accent: '#141517', eye: '#3B2A20' },
  },
];

export interface ColorwayDef {
  id: ColorwayId;
  name: string;
  unlock: Unlock;
  /** top (shirt/jacket), bottom (pants), shoes, accent (stitching/logo/harness), skin tone of arms/hands. */
  top: string;
  bottom: string;
  shoe: string;
  shoeAccent: string;
  accent: string;
}

export const COLORWAYS: readonly ColorwayDef[] = [
  // CHIRAL SPORTS tees (assets/reference/tee-*.webp): `accent` is the print colour (chest mark + vertical back wordmark).
  { id: 'basalt', name: 'CHIRAL Black', unlock: { kind: 'free' }, top: '#141517', bottom: '#1E2024', shoe: '#2B2E33', shoeAccent: '#D54051', accent: '#FFFFFF' },
  { id: 'white', name: 'CHIRAL White', unlock: { kind: 'free' }, top: '#F2F0EB', bottom: '#1E2024', shoe: '#E9E5DD', shoeAccent: '#D54051', accent: '#D54051' },
  { id: 'pink', name: 'CHIRAL Pink', unlock: { kind: 'free' }, top: '#D54051', bottom: '#1E2024', shoe: '#1E2024', shoeAccent: '#FFFFFF', accent: '#FFFFFF' },
  { id: 'glacier', name: 'Glacier', unlock: { kind: 'free' }, top: '#9AD4DE', bottom: '#2A2F38', shoe: '#E9E5DD', shoeAccent: '#2F6FEB', accent: '#E9E5DD' },
  { id: 'moss', name: 'Moss', unlock: { kind: 'points', points: 800 }, top: '#5E6B45', bottom: '#2F3328', shoe: '#C9B27A', shoeAccent: '#1E1F1A', accent: '#D8CFA8' },
  { id: 'ember', name: 'Oxblood', unlock: { kind: 'points', points: 2500 }, top: '#7A2430', bottom: '#1D1F23', shoe: '#1D1F23', shoeAccent: '#D54051', accent: '#F6F4EF' },
  { id: 'lichen', name: 'Lichen', unlock: { kind: 'flashes', flashes: 5 }, top: '#B9C4A0', bottom: '#4A5240', shoe: '#E3DFD3', shoeAccent: '#5E6B45', accent: '#2B2D31' },
  { id: 'dune', name: 'Dune', unlock: { kind: 'points', points: 6000 }, top: '#D8C7A6', bottom: '#8A7458', shoe: '#5E4C38', shoeAccent: '#F2C230', accent: '#3A2E22' },
  { id: 'alpenglow', name: 'Alpenglow', unlock: { kind: 'clips', clips: 30 }, top: '#E86A6A', bottom: '#2D2A3A', shoe: '#F0B49A', shoeAccent: '#8B5CF6', accent: '#FFE1C8' },
  { id: 'aurora', name: 'Aurora', unlock: { kind: 'grade', grade: 8 }, top: '#1E3B3A', bottom: '#14171C', shoe: '#21B8B0', shoeAccent: '#8B5CF6', accent: '#7CF2D4' },
];

export interface ChalkDef {
  id: ChalkId;
  name: string;
  color: string;
  unlock: Unlock;
}

export const CHALKS: readonly ChalkDef[] = [
  { id: 'classic', name: 'Classic', color: '#F6F4EF', unlock: { kind: 'free' } },
  { id: 'glacier', name: 'Glacier', color: '#B8E6F0', unlock: { kind: 'points', points: 1200 } },
  { id: 'moss', name: 'Moss', color: '#CFE0A8', unlock: { kind: 'points', points: 3000 } },
  { id: 'ember', name: 'Pink Dust', color: '#F2A9B2', unlock: { kind: 'streak', streak: 5 } },
  { id: 'gold', name: 'Gold Dust', color: '#F2D27A', unlock: { kind: 'points', points: 15000 } },
];

/** Skin tone for the climber's hands/arms/neck (single neutral tone; heads are animals). */
export const SKIN_TONE = '#C99A78';

export function unlockLabel(u: Unlock): string {
  switch (u.kind) {
    case 'free':
      return 'Unlocked';
    case 'tutorial':
      return 'Finish the tutorial';
    case 'points':
      return `${u.points.toLocaleString('en-US')} lifetime pts`;
    case 'grade':
      return `Send a V${u.grade}`;
    case 'streak':
      return `${u.streak} sends in one run`;
    case 'rope-top':
      return 'Top the Lead Tower';
    case 'clips':
      return `${u.clips} quickdraws clipped`;
    case 'flashes':
      return `${u.flashes} flashes`;
  }
}

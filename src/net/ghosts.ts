// "Ghost" content for the OFFLINE backend, so a fresh device never shows an empty board.
// Everything here is fictional and clearly marked: every id starts with `ghost-` (see isGhostId).
// Steini the ibex (the gym's guide) also set a handful of community problems on the CHIRAL wall.

import type { BoulderDef, CommunityProblem, HeadId, HoldDef, HoldRole, HoldType, LeaderboardMode, ScoreEntry } from '../core/types';
import { ROUTE_COLORS } from '../config/brand';
import { GAME } from '../config/tuning';
import { fnv1a } from './storage';

export const GHOST_PREFIX = 'ghost-';
export const isGhostId = (id: string | undefined): boolean => typeof id === 'string' && id.startsWith(GHOST_PREFIX);

/** Seed timestamp for ghost content (fixed, so ghosts always sort as "older" than real runs). */
const GHOST_EPOCH = Date.UTC(2026, 8, 1, 9, 0, 0);
const DAY = 86_400_000;

interface GhostClimber {
  name: string;
  head: HeadId;
  /** Relative strength 0..1 (drives scores, grades, sends). */
  level: number;
}

export const GHOST_CLIMBERS: readonly GhostClimber[] = [
  { name: 'Steini', head: 'ibex', level: 1 },
  { name: 'Crimpmeister', head: 'chamois', level: 0.82 },
  { name: 'Föhn', head: 'eagle', level: 0.68 },
  { name: 'Mira K.', head: 'lynx', level: 0.56 },
  // the plain human climber in the black CHIRAL SPORTS cap (shows on the boulder and rope boards)
  { name: 'Gipfel Gabi', head: 'human', level: 0.48 },
  { name: 'Basalt Bob', head: 'marmot', level: 0.42 },
  { name: 'Gneiss Guy', head: 'goat', level: 0.3 },
  { name: 'Dyno Dani', head: 'snowleopard', level: 0.2 },
  { name: 'Piz Pia', head: 'ram', level: 0.1 },
];

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Small deterministic PRNG (mulberry32) so ghost boards are stable per day. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ghost entries for one board. Boulder/rope are fixed; daily ghosts vary (deterministically) by date. */
export function ghostScores(mode: LeaderboardMode, dailyKey?: string): ScoreEntry[] {
  if (mode === 'daily') {
    if (!dailyKey) return [];
    const rnd = mulberry32(fnv1a(`daily:${dailyKey}`));
    // Five of the ghosts show up each day, in a date-dependent subset.
    const pool = [...GHOST_CLIMBERS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const dayStart = Date.parse(`${dailyKey}T06:00:00Z`);
    return pool.slice(0, 5).map((g, i) => ({
      id: `${GHOST_PREFIX}s-daily-${dailyKey}-${slug(g.name)}`,
      player: g.name,
      score: Math.round((180 + 720 * g.level) * (0.85 + 0.3 * rnd())),
      mode: 'daily' as const,
      sends: 1,
      maxGrade: 0,
      head: g.head,
      dailyKey,
      createdAt: (Number.isFinite(dayStart) ? dayStart : GHOST_EPOCH) + i * 47 * 60_000,
    }));
  }
  const top = mode === 'boulder' ? 3600 : 1500;
  const roster = mode === 'boulder' ? GHOST_CLIMBERS : GHOST_CLIMBERS.slice(0, 6);
  return roster.map((g, i) => ({
    id: `${GHOST_PREFIX}s-${mode}-${slug(g.name)}`,
    player: g.name,
    score: Math.round((top * (0.05 + 0.95 * g.level ** 1.15)) / 10) * 10,
    mode,
    sends: mode === 'boulder' ? Math.max(1, Math.round(2 + 16 * g.level)) : Math.max(1, Math.round(3 + 9 * g.level)),
    maxGrade: Math.round(1 + 6 * g.level),
    head: g.head,
    createdAt: GHOST_EPOCH - (i + 1) * 3 * DAY,
  }));
}

// ───────────────────────────── Steini's problems ─────────────────────────────

const UP = -Math.PI / 2; // classic incut: body below the hold

type HoldSpec = [type: HoldType, x: number, y: number, role: HoldRole, angle?: number, size?: number];

const DEFAULT_SIZE: Record<HoldType, number> = {
  jug: 0.1,
  edge: 0.075,
  crimp: 0.05,
  sloper: 0.115,
  pinch: 0.07,
  pocket: 0.06,
  foot: 0.03,
  volume: 0.3,
};

const DECO_COLORS = ROUTE_COLORS.map((c) => c.hex);

function buildBoulder(p: {
  id: string;
  name: string;
  grade: number;
  wallAngle: number;
  colorIndex: number;
  seed: number;
  createdAt: number;
  holds: HoldSpec[];
  deco: [type: HoldType, x: number, y: number][];
}): BoulderDef {
  const color = ROUTE_COLORS[p.colorIndex % ROUTE_COLORS.length].hex;
  const rnd = mulberry32(p.seed);
  const holds: HoldDef[] = p.holds.map(([type, x, y, role, angle, size], i) => ({
    id: `h${i}`,
    x,
    y,
    type,
    size: size ?? DEFAULT_SIZE[type],
    angle: angle ?? UP,
    role,
    color,
    seed: Math.floor(rnd() * 1e6),
  }));
  p.deco.forEach(([type, x, y], i) => {
    let deco = DECO_COLORS[(p.colorIndex + 3 + i * 2) % DECO_COLORS.length];
    if (deco === color) deco = DECO_COLORS[(p.colorIndex + 1) % DECO_COLORS.length];
    holds.push({
      id: `d${i}`,
      x,
      y,
      type,
      size: DEFAULT_SIZE[type] * (0.85 + 0.3 * rnd()),
      angle: UP + (rnd() - 0.5) * 1.2,
      role: 'deco',
      color: deco,
      seed: Math.floor(rnd() * 1e6),
    });
  });
  return {
    id: p.id,
    name: p.name,
    grade: p.grade,
    mode: 'boulder',
    wallAngle: p.wallAngle,
    width: GAME.boulderWall.width,
    height: GAME.boulderWall.height,
    holds,
    color,
    seed: p.seed,
    author: 'Steini',
    createdAt: p.createdAt,
  };
}

interface GhostProblemSpec {
  slug: string;
  name: string;
  grade: number;
  wallAngle: number;
  colorIndex: number;
  plays: number;
  sends: number;
  daysOld: number;
  holds: HoldSpec[];
  deco: [HoldType, number, number][];
}

const SPECS: readonly GhostProblemSpec[] = [
  {
    slug: 'warm-up',
    name: "Steini's Warm-Up",
    grade: 0,
    wallAngle: 0,
    colorIndex: 0, // yellow
    plays: 312,
    sends: 241,
    daysOld: 40,
    holds: [
      ['jug', -0.22, 1.75, 'start'],
      ['jug', 0.24, 1.7, 'start'],
      ['foot', -0.28, 0.45, 'foot'],
      ['foot', 0.3, 0.5, 'foot'],
      ['foot', 0.04, 0.92, 'foot'],
      ['foot', -0.36, 1.26, 'foot'],
      ['foot', 0.4, 1.4, 'foot'],
      ['jug', -0.34, 2.15, 'hand'],
      ['jug', 0.3, 2.52, 'hand'],
      ['edge', -0.2, 2.92, 'hand', UP, 0.085],
      ['jug', 0.34, 3.3, 'hand'],
      ['jug', -0.14, 3.7, 'hand'],
      ['jug', 0.1, 4.1, 'top', UP, 0.12],
    ],
    deco: [
      ['crimp', -1.5, 1.2],
      ['sloper', 1.6, 2.1],
      ['pinch', -1.7, 3.1],
      ['edge', 1.45, 3.6],
    ],
  },
  {
    slug: 'platten-puzzle',
    name: 'Platten-Puzzle',
    grade: 1,
    wallAngle: -8,
    colorIndex: 2, // green
    plays: 188,
    sends: 97,
    daysOld: 33,
    holds: [
      ['edge', -0.16, 1.8, 'start'],
      ['edge', 0.2, 1.78, 'start'],
      ['foot', -0.3, 0.4, 'foot'],
      ['foot', 0.26, 0.55, 'foot'],
      ['foot', -0.06, 0.96, 'foot'],
      ['foot', 0.4, 1.3, 'foot'],
      ['foot', -0.42, 1.52, 'foot'],
      ['pinch', 0.44, 2.2, 'hand', -Math.PI / 2 - 0.35],
      ['edge', -0.1, 2.56, 'hand'],
      ['sloper', 0.34, 2.96, 'hand'],
      ['edge', -0.3, 3.32, 'hand'],
      ['jug', 0.14, 3.66, 'hand'],
      ['jug', -0.06, 4.06, 'top'],
    ],
    deco: [
      ['jug', 1.55, 0.9],
      ['crimp', -1.45, 2.4],
      ['pocket', 1.7, 3.2],
      ['edge', -1.9, 3.8],
    ],
  },
  {
    slug: 'ziegenpfad',
    name: 'Ziegenpfad',
    grade: 2,
    wallAngle: 12,
    colorIndex: 1, // blue
    plays: 146,
    sends: 51,
    daysOld: 21,
    holds: [
      ['jug', -0.9, 1.72, 'start'],
      ['edge', -0.48, 1.66, 'start', UP, 0.085],
      ['foot', -1.0, 0.45, 'foot'],
      ['foot', -0.55, 0.42, 'foot'],
      ['foot', -0.76, 0.96, 'foot'],
      ['foot', -0.26, 1.2, 'foot'],
      ['foot', 0.1, 1.56, 'foot'],
      ['foot', 0.46, 1.96, 'foot'],
      ['edge', -0.2, 2.1, 'hand'],
      ['pinch', 0.25, 2.36, 'hand', -Math.PI / 2 + 0.3],
      ['edge', 0.04, 2.8, 'hand'],
      ['pocket', 0.54, 3.06, 'hand'],
      ['edge', 0.3, 3.5, 'hand', UP, 0.085],
      ['jug', 0.7, 3.95, 'top'],
    ],
    deco: [
      ['sloper', 1.5, 1.1],
      ['crimp', 1.75, 2.6],
      ['jug', -1.6, 2.9],
      ['pinch', -1.2, 3.85],
    ],
  },
  {
    slug: 'foehnsturm',
    name: 'Föhnsturm',
    grade: 4,
    wallAngle: 25,
    colorIndex: 4, // purple
    plays: 87,
    sends: 14,
    daysOld: 9,
    holds: [
      ['pinch', -0.2, 1.75, 'start', -Math.PI / 2 - 0.25],
      ['edge', 0.2, 1.7, 'start', UP, 0.085],
      ['foot', -0.25, 0.5, 'foot'],
      ['foot', 0.3, 0.45, 'foot'],
      ['foot', 0.0, 1.0, 'foot'],
      ['foot', 0.46, 1.34, 'foot'],
      ['foot', -0.46, 1.5, 'foot'],
      ['volume', 0.62, 1.92, 'hand', UP, 0.28],
      ['crimp', 0.4, 2.16, 'hand', UP, 0.055],
      ['sloper', -0.25, 2.46, 'hand', UP, 0.125],
      ['pinch', 0.2, 2.86, 'hand', -Math.PI / 2 + 0.3],
      ['edge', -0.3, 3.26, 'hand'],
      ['jug', 0.25, 3.62, 'hand'],
      ['jug', 0.0, 4.05, 'top', UP, 0.115],
    ],
    deco: [
      ['jug', -1.5, 1.4],
      ['edge', 1.6, 2.7],
      ['sloper', -1.75, 3.4],
      ['crimp', 1.3, 3.95],
    ],
  },
];

/** Steini's problems with their baseline play counts (local plays are added on top). */
export function ghostProblems(): CommunityProblem[] {
  return SPECS.map((s, i) => {
    const id = `${GHOST_PREFIX}p-${s.slug}`;
    const createdAt = GHOST_EPOCH - s.daysOld * DAY;
    const boulder = buildBoulder({
      id,
      name: s.name,
      grade: s.grade,
      wallAngle: s.wallAngle,
      colorIndex: s.colorIndex,
      seed: 7_100 + i * 977,
      createdAt,
      holds: s.holds,
      deco: s.deco,
    });
    return { id, name: s.name, author: 'Steini', grade: s.grade, boulder, plays: s.plays, sends: s.sends, createdAt };
  });
}

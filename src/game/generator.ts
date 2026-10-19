// Procedural problem generator for the CHIRAL wall.
//
// A route is built by "climbing it while setting it": a virtual climber moves its hands along the
// route's line (move length, hold types, awkward angles and wall angle scale with the grade),
// footholds are set where its feet need them, the top is a matchable jug/edge, and the wall is
// filled with other routes' (unusable) holds and volumes. Every candidate is verified with the
// beta planner; failed candidates are retried with derived seeds (then eased parameters), and a
// guaranteed ladder layout is the last resort. Budgets are node counts, so generation is
// deterministic on every device: same seed → identical boulder.
//
// Phase B (archetypes.ts): every problem has a route archetype (BoulderDef.style) that picks its wall
// (flat angle, or a multi-angle profile when GEN.profiles is on), its line (a meander, a diagonal, a
// zigzag, a traverse across the wall), its hold set and its signature move (a throw on 'dyno', wide
// squeezes on 'compression', roof hooks on 'cave'). Send Train runs rotate archetypes (runStyle), the
// daily problem follows the weekday (dailyStyle). Lead routes follow the research template (§3.5): a
// gentle start, bolts ≤ 1 m apart up to 5 m, a rest before the crux at 55–75 % of the height, a
// positive clip hold under every draw, and varied lines (meander / zigzag / diagonal) and hold themes.
// On a multi-angle wall a steep panel is never relaxed (a strain floor by panel angle), the holds over a
// lip are the crux's reward, and with GEN.holdsOnVolumes the squeezes of compression problems (and a few
// holds of the other boulders, most on mixed / steep ones) are bolted onto route volumes (HoldDef.onVolume;
// boulders only: a lead tower keeps its faces clear for the bolt line and the clipping stances).

import type { BoulderDef, HoldDef, HoldRole, HoldType, LimbId, QuickdrawDef, RouteStyle } from '../core/types';
import type { GenerateOptions } from '../core/contracts';
import { GAME, GEN, SIM } from '../config/tuning';
import { ROUTE_COLORS, WALL } from '../config/brand';
import { hashString, Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import { planBetaDetailed, SOLVER, StanceLab, type PlanResult } from './solver';
import type { Pose } from './statics';
import { datan2, dcos, dhypot, dsin } from './dmath';
import { canMatch, contactPoint, nominalCapacity, usableByHand } from './holds';
import { angleAt as profAngleAt, makeProfile, steepestAngle, type WallProfile } from './wall-profile';
import {
  dailyStyle,
  dressHold,
  dtanDeg,
  flatFallback,
  handTypeWeights,
  leadAngle,
  leadProfile,
  pickStyle,
  runStyle,
  styleAngle,
  styleProfile,
  type ProfileSpec,
} from './archetypes';

// ═══════════════════════════════ names ═══════════════════════════════

const NAME_A = [
  'Basalt', 'Ibex', 'Föhn', 'Salt', 'Glacier', 'Granite', 'Gneiss', 'Edelweiss', 'Alpenglow', 'Moraine',
  'Scree', 'Couloir', 'Serac', 'Cornice', 'Larch', 'Marmot', 'Chamois', 'Lynx', 'Firn', 'Névé',
  'Lichen', 'Rime', 'Hoarfrost', 'Talus', 'Schist', 'Quartz', 'Cirque', 'Gendarme', 'Bivouac', 'Summit',
  'Ridge', 'Cairn', 'Avalanche', 'Crevasse', 'Bergschrund', 'Meltwater', 'Arolla', 'Zirbe', 'Steinbock', 'Bise',
  'Graupel', 'Spindrift', 'Limestone', 'Dolomite', 'Obsidian', 'Kestrel', 'Ptarmigan', 'Chough', 'Carabiner', 'Chalk',
] as const;
const NAME_B = [
  'Ballet', 'Crack', 'Wind', 'Lick', 'Mouse', 'Traverse', 'Prow', 'Arête', 'Dihedral', 'Seam',
  'Roof', 'Lip', 'Shuffle', 'Dance', 'Theory', 'Logic', 'Gambit', 'Riddle', 'Echo', 'Whisper',
  'Ladder', 'Sermon', 'Engine', 'Nocturne', 'Groove', 'Rodeo', 'Mantra', 'Sonata', 'Express', 'Circuit',
  'Hymn', 'Lullaby', 'Protocol', 'Variation', 'Paradox', 'Spiral', 'Rhythm', 'Pilgrim', 'Shadow', 'Spell',
  'Waltz', 'Ritual', 'Compass', 'Signal', 'Tension', 'Static', 'Pendulum', 'Gradient', 'Fracture', 'Reverie',
] as const;
const NAME_SOLO = [
  'Glacier Mouse', 'Salt Lick', 'Föhn Wind', 'Ibex Crack', 'Basalt Ballet', 'Steini’s Revenge', 'Second Breakfast',
  'Horn of Plenty', 'The Long Winter', 'Cold Hands', 'Hut Tea', 'Last Gondola', 'Bluebird Day', 'Chalk Storm',
  'Summit Fever', 'Mirror Image', 'Left Hand Path', 'Opposable', 'Handed', 'Enantiomer',
] as const;

function routeName(rng: Rng): string {
  if (rng.chance(0.14)) return rng.pick(NAME_SOLO);
  return `${rng.pick(NAME_A)} ${rng.pick(NAME_B)}`;
}

// ═══════════════════════════════ tables ═══════════════════════════════

/** Lead setter: evaluations without a new high point before it jumps back, and how far (m) below the high point. */
const LEAD_STUCK = 320;
const LEAD_JUMP = 1.3;

/** Minimum gap (m) between a quickdraw's clip point and the edge of any route hold. */
const CLIP_CLEARANCE = 0.07;

const HAND_TYPES: readonly HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket'];

/**
 * Lead towers are set as one hold set, like a real setter's route (research §3.3 / §3.5): jugs + edges,
 * crimps + pockets, or slopers + pinches (and now and then a classic mix). The theme decides every graded
 * hold, what a "better" hold is (a crimp gets easier as a deep pocket or an incut edge, not as a generic
 * edge), and the good holds of the start, the clips and the easy moves (horns on a slopers + pinches tower,
 * deep pockets and incut rails on a crimps + pockets one). Rests before the crux, the lip of the roof and
 * the top stay real jugs. Boulders keep 'classic' (their archetype picks the hold mix).
 */
export type LeadTheme = 'classic' | 'jugs-edges' | 'crimps-pockets' | 'slopers-pinches';
export const LEAD_THEMES: readonly LeadTheme[] = ['classic', 'jugs-edges', 'crimps-pockets', 'slopers-pinches'];
type Theme = LeadTheme;

/**
 * Graded hand holds of a themed tower, [jug, edge, crimp, sloper, pinch, pocket] at V0, V3, V6, V9, V12
 * (interpolated between): each keeps about the mean grip of the classic mix at its grade (easy towers are
 * still mostly jugs, the theme shows in the rest), so a themed tower sets as reliably as a classic one.
 */
const THEME_MIX: Record<Exclude<Theme, 'classic'>, readonly (readonly number[])[]> = {
  'jugs-edges': [
    [3.6, 1.2, 0, 0, 0.1, 0],
    [2.2, 2.6, 0, 0.1, 0.3, 0.1],
    [1.1, 3.2, 0.3, 0.1, 0.4, 0.2],
    [0.6, 3.2, 0.8, 0.15, 0.4, 0.2],
    [0.4, 3.2, 1.2, 0.2, 0.4, 0.2],
  ],
  'crimps-pockets': [
    [3.2, 0.6, 0, 0, 0, 1.6],
    [1.7, 1.0, 0.5, 0, 0, 1.8],
    [0.9, 0.7, 1.4, 0, 0.1, 1.7],
    [0.45, 0.6, 2.1, 0.05, 0.1, 1.5],
    [0.3, 0.5, 2.4, 0.05, 0.1, 1.4],
  ],
  'slopers-pinches': [
    [3.2, 0.3, 0, 0.6, 1.6, 0],
    [1.6, 0.4, 0, 1.0, 2.0, 0],
    [0.8, 0.4, 0, 1.4, 2.2, 0.05],
    [0.45, 0.4, 0.05, 1.6, 2.2, 0.05],
    [0.3, 0.4, 0.1, 1.7, 2.2, 0.05],
  ],
};

/** THEME_MIX of a theme at grade g (a fresh array). */
function themeMix(th: Exclude<Theme, 'classic'>, g: number): number[] {
  const k = THEME_MIX[th];
  const f = clamp(g, 0, 12) / 3;
  const i = Math.min(3, Math.floor(f));
  const t = f - i;
  return k[i].map((v, j) => v + (k[i + 1][j] - v) * t);
}

/** Good holds (start, clips, easy moves) of a themed tower: [type, weight, easy-grade weight]. */
const THEME_GOOD: Record<Exclude<Theme, 'classic'>, readonly (readonly [HoldType, number, number])[]> = {
  'jugs-edges': [
    ['jug', 2, 3],
    ['edge', 1, 0.6],
  ],
  'crimps-pockets': [
    ['jug', 0.8, 1.6],
    ['pocket', 1.7, 1.3],
    ['edge', 0.6, 0.6],
  ],
  'slopers-pinches': [
    ['jug', 0.7, 1.4],
    ['pinch', 1.6, 1.4],
    // (big friendly slopers only on the near-vertical start panel: goodType)
    ['sloper', 0.9, 0.7],
  ],
};

const SIZE: Record<HoldType, [number, number]> = {
  jug: [0.08, 0.12],
  edge: [0.05, 0.08],
  crimp: [0.028, 0.045],
  sloper: [0.08, 0.12],
  pinch: [0.05, 0.08],
  pocket: [0.04, 0.06],
  foot: [0.02, 0.035],
  volume: [0.25, 0.45],
};

function holdSize(type: HoldType, t: number, rng: Rng): number {
  const [lo, hi] = SIZE[type];
  return lerp(hi, lo, clamp(t * 0.7 + rng.next() * 0.3, 0, 1));
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const HALF_PI = Math.PI / 2;

// ═══════════════════════════════ builder ═══════════════════════════════

interface Cand {
  li: number;
  hold: HoldDef;
  /** A new hold to be set (vs an existing route hold reused). */
  fresh: boolean;
  maxT: number;
  /** A throw (deadpoint / double dyno) instead of a static move. */
  dyno?: 'LH' | 'RH' | 'both';
  /** The route volume a fresh hand hold is bolted onto (set with the hold; GEN.holdsOnVolumes). */
  vol?: HoldDef;
}

interface Frame {
  slots: (HoldDef | null)[];
  pose: Pose;
  holdCount: number;
  counters: { s: number; h: number; f: number; t: number; v: number; d: number };
  sinceRest: number;
  boost: number;
  handMoves: number;
  dynoDone: boolean;
  transient: boolean;
  restDone: boolean;
  cands: Cand[];
  idx: number;
}

/** How the route travels: a meander up, a rising diagonal, a zigzag, or across the wall. */
type Line = 'wave' | 'diagonal' | 'zigzag' | 'traverse';

interface Params {
  grade: number;
  t: number;
  angle: number;
  gain: number;
  lateral: number;
  footGap: number;
  awkward: number;
  rope: boolean;
  style: RouteStyle;
  line: Line;
  profile: ProfileSpec | null;
  theme: Theme;
  /**
   * How strictly the theme is set (1 = fully; a retried tower that got stuck eases it toward the classic
   * mix, so it keeps its flavour instead of falling back to the ladder).
   */
  themeK: number;
  /** Hand holds may be bolted onto route volumes (GEN.holdsOnVolumes / GenerateOptions.holdsOnVolumes). */
  mounts: boolean;
}

class Builder {
  readonly holds: HoldDef[] = [];
  readonly draws: QuickdrawDef[] = [];
  readonly n = { s: 0, h: 0, f: 0, t: 0, v: 0, d: 0 };
  readonly W: number;
  readonly H: number;
  readonly color: string;
  readonly prof: WallProfile | null;
  private readonly dressRng: Rng;
  /** High heel hooks (hookCands): their own stream, so the rest of a route sets as before. */
  private readonly hookRng: Rng;
  private x0: number;
  private amp: number;
  private freq: number;
  private phase: number;
  private drift: number;
  // diagonal / zigzag / traverse line
  private dir = 1;
  private slope = 0;
  private leg = 1;
  private zd = 0;
  private zph = 0;
  private yRef = 1.55;
  private xStart = 0;
  private xEnd = 0;
  private yStart = 1.55;
  private rise = 0;
  startFeet: { LF?: string; RF?: string } = {};
  top: HoldDef | null = null;

  constructor(
    readonly rng: Rng,
    readonly p: Params,
    color: string,
  ) {
    const wall = p.rope ? GAME.ropeWall : GAME.boulderWall;
    this.W = wall.width;
    this.H = p.profile ? p.profile.length : wall.height;
    this.prof = p.profile ? makeProfile(p.profile.panels, steepestAngle(p.profile.panels), p.profile.length) : null;
    if (this.prof && this.prof.flat) this.prof = null;
    this.color = color;
    this.dressRng = rng.fork(0xd7e55);
    this.hookRng = rng.fork(0x4ee1);
    this.x0 = p.rope ? rng.range(-0.7, 0.7) : rng.range(-1.05, 1.05);
    this.amp = rng.range(0.08, p.rope ? 0.4 : 0.45);
    this.freq = rng.range(0.7, 1.5);
    this.phase = rng.range(0, Math.PI * 2);
    this.drift = rng.range(-0.1, 0.1) * (p.rope ? 0.35 : 1);
    this.dir = rng.chance(0.5) ? 1 : -1;
    const span = this.W / 2 - 0.55;
    switch (p.line) {
      case 'diagonal': {
        // a rising line 30–50° off vertical across the wall, with a small wobble
        const climb = this.H - 0.35 - this.yRef;
        this.slope = this.dir * Math.min(dtanDeg(rng.range(30, 50)), (2 * span - 0.2) / climb);
        this.x0 = clamp(-this.slope * climb * 0.5, -span, span);
        // a tower's diagonal crosses the whole wall over 13 m: a little more wander on the way
        this.amp = p.rope ? rng.range(0.08, 0.2) : rng.range(0.04, 0.1);
        break;
      }
      case 'zigzag': {
        // legs of 0.9–1.3 m (boulders; 2.2–3.4 m on the tower) heading ±(31–40)° off vertical
        this.leg = p.rope ? rng.range(2.2, 3.4) : rng.range(0.9, 1.3);
        this.zd = this.leg * dtanDeg(p.rope ? rng.range(14, 22) : rng.range(31, 40));
        this.zph = rng.range(0, 1);
        this.x0 = clamp(this.x0, -span + this.zd / 2, span - this.zd / 2);
        this.amp = rng.range(0.03, 0.07);
        break;
      }
      case 'traverse': {
        // start low on one side, cross the wall, finish rising to a top on the far side
        this.xStart = -this.dir * rng.range(1.4, 1.65);
        this.xEnd = this.dir * rng.range(1.35, 1.6);
        this.yStart = rng.range(1.48, 1.7);
        this.rise = rng.range(0.55, 1.15);
        this.amp = rng.range(0.05, 0.16);
        break;
      }
      default:
    }
  }

  /** Panel angle (degrees) at surface height y. */
  angleAt(y: number): number {
    return this.prof ? profAngleAt(this.prof, y) : this.p.angle;
  }

  lineX(y: number): number {
    const span = this.W / 2 - 0.55;
    let x: number;
    switch (this.p.line) {
      case 'diagonal':
        x = this.x0 + this.slope * (y - this.yRef) + this.amp * dsin(y * this.freq + this.phase);
        break;
      case 'zigzag': {
        const u = (y - this.yRef) / this.leg + this.zph;
        const k = Math.floor(u);
        const f = u - k;
        const s = (k & 1) === 1 ? 1 - f : f;
        x = this.x0 + this.dir * this.zd * (s - 0.5) + this.amp * dsin(y * this.freq + this.phase);
        break;
      }
      case 'traverse':
        x = this.xStart + (this.xEnd - this.xStart) * clamp((y - this.yStart) / Math.max(0.5, this.rise), 0, 1);
        break;
      default:
        x = this.x0 + this.amp * dsin(y * this.freq + this.phase) + this.drift * y;
    }
    return clamp(x, -span, span);
  }

  /** Traverse: the line's height at x (rising from the start to the top's foot on the far side). */
  lineY(x: number): number {
    const prog = clamp((x - this.xStart) / (this.xEnd - this.xStart), 0, 1);
    // flat across most of the wall, rising over the last third toward the top
    const r = prog < 0.6 ? prog * 0.35 : 0.21 + ((prog - 0.6) / 0.4) * 0.79;
    return this.yStart + this.rise * r + this.amp * dsin(x * this.freq + this.phase);
  }

  clampX(x: number): number {
    return clamp(x, -this.W / 2 + 0.22, this.W / 2 - 0.22);
  }

  /** Product variety for a hold on this wall (shape, edge depth, lip, fingers). */
  dress(h: HoldDef, route: boolean): HoldDef {
    return dressHold(h, { grade: this.p.grade, angle: this.angleAt(h.y), style: this.p.style, route, role: h.role }, this.dressRng);
  }

  add(role: HoldRole, type: HoldType, x: number, y: number, size: number, angle: number, color = this.color): HoldDef {
    const prefix = role === 'start' ? 's' : role === 'top' ? 't' : role === 'deco' ? (type === 'volume' ? 'v' : 'd') : role === 'foot' ? (type === 'volume' ? 'v' : 'f') : 'h';
    const key = prefix === 'v' ? 'v' : (prefix as 's' | 'h' | 'f' | 't' | 'd');
    const id = `${prefix}${this.n[key]++}`;
    const h: HoldDef = { id, x: r3(x), y: r3(y), type, size: r3(size), angle: r3(angle), role, color, seed: this.rng.int(1, 0x7fffffff) };
    this.dress(h, role !== 'deco');
    this.holds.push(h);
    return h;
  }

  /** Closest gap (edge to edge) between a prospective hold and the existing ones. */
  gap(x: number, y: number, size: number, filter?: (h: HoldDef) => boolean): number {
    let g = Infinity;
    for (const h of this.holds) {
      if (filter && !filter(h)) continue;
      const d = dhypot(h.x - x, h.y - y) - h.size - size;
      if (d < g) g = d;
    }
    return g;
  }

  handType(y: number): HoldType {
    const th = this.p.theme;
    if (th === 'classic') return this.rng.weighted(HAND_TYPES, handTypeWeights(this.p.grade, this.angleAt(y), this.p.style));
    // a themed tower: the theme's mix for the grade band, steered by the panel (slopers and crimps die on
    // steep panels, jugs and pinches take over there: a roof crux of a slopers + pinches tower is pinches)
    const g = this.p.grade;
    const w = themeMix(th, g);
    // a roof (≥ 38°) is set with the big holds every set has there: half the classic steep mix
    const kk = this.angleAt(y) >= 38 ? Math.min(this.p.themeK, 0.5) : this.p.themeK;
    if (kk < 1) {
      // an eased retry: blend toward the classic mix (both normalised)
      const c = handTypeWeights(g, this.angleAt(y), this.p.style);
      const sw = w.reduce((a, v) => a + v, 0) || 1;
      const sc = c.reduce((a, v) => a + v, 0) || 1;
      for (let i = 0; i < w.length; i++) w[i] = (kk * w[i]) / sw + ((1 - kk) * c[i]) / sc;
    }
    const s = Math.max(0, this.angleAt(y)) / 40;
    w[0] *= 1 + 1.2 * s;
    w[1] *= 1 + 0.3 * s;
    w[2] *= Math.max(0.05, 1 - 0.65 * s);
    w[3] *= Math.max(0.05, 1 - 0.75 * s);
    w[4] *= 1 + 0.5 * s;
    w[5] *= 1 + 0.1 * s;
    return this.rng.weighted(HAND_TYPES, w);
  }

  /** A good hold of the tower's theme at surface height y (start zone, easy moves): a jug on a classic route. */
  goodType(y: number): HoldType {
    const th = this.p.theme;
    if (th === 'classic' || (this.p.themeK < 1 && this.rng.chance(1 - this.p.themeK))) return 'jug';
    const opts = THEME_GOOD[th];
    const easy = this.p.grade <= 2;
    // a good sloper is a big friendly dome on a near-vertical panel; steeper, it is a sloper no more
    const flat = this.angleAt(y) <= 12;
    return this.rng.weighted(
      opts.map((o) => o[0]),
      opts.map((o) => (o[0] === 'sloper' && !flat ? 0 : easy ? o[2] : o[1])),
    );
  }

  /**
   * Product details that make a themed tower's hold read as its set, by how good the hold must be
   * (Cand mode): good holds are deep 4-finger pockets, incut rails and horns, better ones a finger or a few
   * mm more and a friendlier lip, graded slopers friendly enough for a 10–30° tower. Classic routes and
   * boulders are left as dressHold made them. Mutates and returns h.
   */
  themeHold(h: HoldDef, mode0: 'jug' | 'good' | 'better' | 'grade'): HoldDef {
    const th = this.p.theme;
    if (th === 'classic' || mode0 === 'jug') return h;
    const rng = this.dressRng;
    const g = this.p.grade;
    // a steep panel (the headwall's roof) gets the set's big versions: huecos, horns, deep rails
    const mode = this.angleAt(h.y) >= 38 ? (mode0 === 'grade' ? 'better' : 'good') : mode0;
    switch (h.type) {
      case 'pocket': {
        const f = h.fingers ?? 3;
        if (mode === 'good') {
          h.fingers = 4;
          h.size = r3(Math.max(h.size, rng.range(0.056, 0.062)));
          h.edgeDepthMm = Math.round(rng.range(26, 32));
        } else if (mode === 'better') {
          h.fingers = Math.min(4, f + 1) as 1 | 2 | 3 | 4;
          h.edgeDepthMm = Math.round(Math.max(h.edgeDepthMm ?? 20, rng.range(22, 28)));
        } else {
          // a tower is climbed on its pockets for 15 m: mostly three-finger ones, twos from V5, monos rare
          h.fingers = (g <= 4 ? rng.weighted([3, 4], [2, 1]) : g <= 8 ? rng.weighted([2, 3, 4], [1, 2, 0.8]) : rng.weighted([1, 2, 3], [0.25, 1.6, 1.6])) as 1 | 2 | 3 | 4;
        }
        break;
      }
      case 'edge':
        if (mode === 'good' || mode === 'better') {
          // incut, deep: a rail on the good ones of an edge-themed set
          if (mode === 'good' && rng.chance(th === 'slopers-pinches' ? 0.2 : 0.55)) h.shape = 'rail';
          else if (h.shape === 'dual-tex' || h.shape === 'wood') delete h.shape;
          h.edgeDepthMm = Math.round(mode === 'good' ? rng.range(25, 30) : Math.max(h.edgeDepthMm ?? 20, rng.range(20, 26)));
          h.lipAngle = Math.round(mode === 'good' ? rng.range(12, 22) : Math.max(h.lipAngle ?? 0, rng.range(4, 14)));
        } else if (th === 'jugs-edges' && !h.shape && rng.chance(0.18)) h.shape = 'rail';
        break;
      case 'crimp':
        // a tower's crimps: 9–16 mm by grade (a 15 m route is climbed on them, not one move), micros at the
        // hard end; the better ones incut
        if (mode === 'grade') {
          if (g >= 9 && !h.shape && rng.chance(0.25)) {
            h.shape = 'micro';
            h.edgeDepthMm = Math.round(rng.range(8, 10));
          } else h.edgeDepthMm = Math.round(lerp(16, 10, clamp((g - 3) / 7, 0, 1)) + rng.range(-1.5, 1.5));
        } else {
          if (h.shape === 'micro') delete h.shape;
          h.edgeDepthMm = Math.round(rng.range(14, 18));
          h.lipAngle = Math.round(rng.range(8, 16));
        }
        break;
      case 'pinch':
        if (mode === 'good') h.shape = 'horn';
        else if (mode === 'better' ? rng.chance(0.55) : th === 'slopers-pinches' && g <= 6 && rng.chance(0.18)) h.shape = 'horn';
        else if (h.shape === 'wood' && th === 'slopers-pinches') delete h.shape;
        break;
      case 'sloper':
        // slopers on a tower: big friendly domes (lip −12 … −26° by grade; research −20 … −40 for one
        // boulder move) — a sloper set is climbed for 15 m, a third of it on 10–30° panels
        h.lipAngle = Math.round(clamp(lerp(-14, -26, clamp(g / 11, 0, 1)) + rng.range(-3, 3) + (mode === 'grade' ? 0 : mode === 'better' ? 6 : 10), -30, -6));
        h.size = r3(Math.max(h.size, rng.range(0.1, 0.125)));
        if (h.shape === 'dual-tex' || h.shape === 'wood') delete h.shape;
        if (!h.shape && rng.chance(0.35)) h.shape = 'macro';
        break;
      default:
    }
    return h;
  }

  footType(y: number): HoldType {
    const g = this.p.grade;
    const a = this.angleAt(y);
    const s = clamp(Math.max(0, a) / 40, 0, 2);
    let w: number[]; // foot, edge, jug, crimp
    if (g <= 2) w = [3, 4.5, 2.5, 0];
    else if (g <= 6) w = [5.5, 3.5, 0.5, 1];
    else w = [7.5, 1.5, 0.2, 1];
    w[0] *= Math.max(0.1, 1 - 0.5 * s);
    w[1] *= 1 + s;
    w[2] *= 1 + 1.2 * s;
    if (this.p.style === 'slab') {
      // slab: chips and small edges, the feet do the work
      w[0] *= 1.5;
      w[2] *= 0.4;
    }
    return this.rng.weighted(['foot', 'edge', 'jug', 'crimp'] as const, w);
  }

  /** Classic down-pull angle with grade-dependent jitter. */
  classicAngle(): number {
    return -HALF_PI + this.rng.gauss() * lerp(0.1, 0.3, this.p.t) * 0.6;
  }

  // ── verified route construction ──
  private lab: StanceLab | null = null;
  private slots: (HoldDef | null)[] = [null, null, null, null];
  private pose: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };
  private tmpSeq = 0;
  private topY = 4.15;
  private maxT = 0.6;
  /** The grade's strain limit (maxT before the steep-panel floor of a profiled wall, see frame()). */
  private baseMaxT = 0.6;
  /** Strain the setter aims each move at (see buildRoute). */
  private targetT = 0.45;
  private sinceRest = 0;
  private boost = 1;
  private handMoves = 0;
  /** 'dyno': the signature throw is set. */
  private dynoDone = false;
  /** Right after a throw: the cut limbs go back on (stances up to SOLVER.dynoLandMax). */
  private transient = false;
  /** Lead: the rest jug before the crux is set. */
  private restDone = false;
  /** Lead: the crux band (surface y). */
  private cruxLo = Infinity;
  private cruxHi = Infinity;

  /** A hold that is not part of the wall yet (unique temporary id; renamed when accepted). */
  private temp(role: HoldRole, type: HoldType, x: number, y: number, size: number, angle: number, color = this.color): HoldDef {
    const h: HoldDef = { id: `~${this.tmpSeq++}`, x: r3(x), y: r3(y), type, size: r3(size), angle: r3(angle), role, color, seed: 0 };
    return this.dress(h, true);
  }

  /** Share of graded hand moves set on a hold bolted onto a route volume (Params.mounts). */
  private mountChance(): number {
    switch (this.p.style) {
      case 'compression':
        return 0.4;
      case 'mixed':
        return 0.22;
      case 'overhang':
      case 'cave':
        return 0.12;
      default:
        return 0.06;
    }
  }

  /**
   * A route volume for a hand hold at (x, y) facing `angle` to sit on (research §3.3: holds on volume faces):
   * the hold on the volume's face toward the climber, the volume's centre behind it. Null when the
   * volume would leave the wall, cover another route hold, or put its own foot spot (the top of the
   * volume, where a foot stands) within snap range of the mounted hold (holds.volumeYields).
   */
  private mountVolume(x: number, y: number, angle: number, holdSize: number): HoldDef | null {
    const { rng } = this;
    const vs = rng.range(0.22, 0.34);
    const off = vs * rng.range(0.38, 0.5);
    const cx = x - dcos(angle) * off;
    const cy = y - dsin(angle) * off;
    if (Math.abs(cx) + vs > this.W / 2 - 0.05 || cy - vs < 0.2 || cy + vs > this.H - 0.15) return null;
    if (this.gap(cx, cy, vs) < 0.03) return null;
    const vol = this.temp('foot', 'volume', cx, cy, vs, -HALF_PI + rng.range(-0.2, 0.2));
    const cp = contactPoint(vol, 2, false, { x: 0, y: 0 });
    if (dhypot(cp.x - x, cp.y - y) - holdSize < GAME.snapRadius + 0.03) return null;
    return vol;
  }

  private accept(h: HoldDef): HoldDef {
    const prefix = h.role === 'start' ? 's' : h.role === 'top' ? 't' : h.type === 'volume' ? 'v' : h.role === 'foot' ? 'f' : 'h';
    h.id = `${prefix}${this.n[prefix as 's' | 'h' | 'f' | 't' | 'v']++}`;
    h.seed = this.rng.int(1, 0x7fffffff);
    this.holds.push(h);
    return h;
  }

  /** Evaluate a candidate from the current stance (no state change). */
  private evalCand(c: Cand): { slots: (HoldDef | null)[]; pose: Pose; tension: number } | null {
    const lab = this.lab!;
    if (c.dyno) {
      const r = lab.dyno(this.slots, c.dyno, c.hold, this.pose);
      // both hands must end on holds (a deadpoint whose other hand can't stay is no route move)
      if (!r.ok || !r.slots[0] || !r.slots[1]) return null;
      return { slots: r.slots, pose: r.pose, tension: r.tension };
    }
    const li = c.li;
    const maxT = c.maxT;
    const r = lab.reach(this.slots, li, c.hold, this.pose);
    // hard grades may ask for brisk, strenuous moves (the sim's slip clock is slow just past 1.0)
    if (!r.ok || r.tension > Math.max(maxT + lerp(0.12, 0.34, this.p.t), 0.6)) return null;
    const next = this.slots.slice();
    next[li] = c.hold;
    const st = lab.stance(next, r.pose);
    if (!(st.violation <= 0.004) || st.tension > maxT) return null;
    return { slots: next, pose: st.pose, tension: Math.max(st.tension, r.tension * 0.85) };
  }

  private upgrade(t: HoldType): HoldType {
    const th = this.p.theme;
    if (th !== 'classic' && (this.p.themeK >= 1 || this.rng.chance(this.p.themeK))) {
      // a better hold of the same set: a crimp eases into a deep pocket or an incut edge, a sloper into a
      // pinch, a pinch into a horn (themeHold) — never into the generic edge every tower used to fill up on
      const hard = this.p.grade >= 8;
      const rng = this.rng;
      switch (th) {
        case 'crimps-pockets':
          if (t === 'crimp' || t === 'sloper') return rng.chance(0.65) ? 'pocket' : 'edge';
          if (t === 'pocket') return rng.chance(0.65) ? 'pocket' : 'edge';
          if (t === 'edge') return hard || rng.chance(0.6) ? 'pocket' : 'jug';
          return hard ? 'edge' : 'jug';
        case 'slopers-pinches':
          if (t === 'jug') return 'jug';
          if (t === 'pinch') return hard || rng.chance(0.7) ? 'pinch' : 'jug';
          if (t === 'sloper') return rng.chance(0.4) ? 'sloper' : 'pinch';
          return 'pinch';
        default:
      }
    }
    if (this.p.grade >= 8) {
      if (t === 'crimp' || t === 'pocket') return 'edge';
      if (t === 'sloper') return 'pinch';
      if (t === 'edge' || t === 'pinch') return this.rng.chance(0.5) ? 'pinch' : 'edge';
    }
    switch (t) {
      case 'crimp':
        return 'edge';
      case 'sloper':
        return 'pinch';
      case 'pocket':
        return 'edge';
      case 'pinch':
        return 'jug';
      case 'edge':
        return 'jug';
      default:
        return 'jug';
    }
  }

  /** Face a hold toward where the shoulder of limb li will be (sidepull / gaston / squeeze). */
  private facing(li: number, tx: number, ty: number, cur: HoldDef): number {
    const sh = this.lab!.anchor(this.pose, li);
    const ey = sh.y + (ty - cur.y) * 0.55;
    if (Math.abs(tx - sh.x) > 0.16) return datan2(ey - ty, sh.x - tx) + this.rng.range(-0.25, 0.25);
    return this.classicAngle() + this.rng.range(-0.45, 0.45);
  }

  /** Profiled walls: surface heights of the convex lips the line climbs past (a steep panel easing off). */
  private lips: number[] | null = null;

  /**
   * Turning a lip (a ≥ 40° panel easing off by ≥ 12°, research §3.4 "cruxes lead from poor holds to a
   * reward hold"): the hand holds just below and over it are the reward — positive holds the body can
   * pull over on. Not on a lip the route tops out on (a cave's lip top is the reward already).
   */
  private atLip(ty: number): boolean {
    if (!this.prof) return false;
    if (!this.lips) {
      this.lips = [];
      const pr = this.prof;
      for (let i = 1; i < pr.n; i++) if (pr.ang[i - 1] >= 40 && pr.ang[i - 1] - pr.ang[i] >= 12 && this.topY > pr.y0[i] + 0.9) this.lips.push(pr.y0[i]);
    }
    for (const y of this.lips) if (ty >= y - 0.25 && ty <= y + 0.75) return true;
    return false;
  }

  /** Lead: how the template shapes the hand hold at height ty ('jug' rest, 'easy' start, 'crux'). */
  private leadZone(ty: number): 'start' | 'rest' | 'crux' | 'normal' {
    if (!this.p.rope) return 'normal';
    if (ty < 4.2) return 'start';
    if (!this.restDone && ty >= this.cruxLo - 1.1 && ty < this.cruxLo) return 'rest';
    if (ty >= this.cruxLo && ty <= this.cruxHi) return 'crux';
    return 'normal';
  }

  private handCands(li: number, gains: readonly number[], out: Cand[], footHigh: number, bump = false): void {
    const { rng, p } = this;
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    const other = this.slots[1 - li]!;
    const cur = this.slots[li]!;
    const highY = Math.max(a.y, b.y);
    const side = li === 0 ? -1 : 1;
    const restJug = p.rope && this.sinceRest > 3.3;
    const squeeze = p.style === 'compression';
    if (!restJug && p.grade >= 4 && gains.length > 3 && rng.chance(p.awkward * 0.22) && this.leadZone(highY) !== 'start') {
      const ty = Math.max(cur.y + 0.2, highY - 0.1) + rng.range(0, 0.12);
      const tx = this.clampX(other.x + side * rng.range(0.22, 0.42));
      // (an undercling of the tower's set: a pinch on slopers + pinches, an edge or a pocket on crimps + pockets)
      let type: HoldType = rng.chance(0.5) ? 'edge' : 'pinch';
      if (p.theme === 'slopers-pinches') type = 'pinch';
      else if (p.theme === 'crimps-pockets' && type === 'pinch') type = 'pocket';
      const uc = this.themeHold(this.temp('hand', type, tx, ty, holdSize(type, p.t, rng), HALF_PI + rng.range(-0.35, 0.35)), 'better');
      out.push({ li, hold: uc, fresh: true, maxT: this.maxT });
    }
    for (let k = 0; k < gains.length; k++) {
      const zone = this.leadZone(highY + p.gain * gains[k]);
      const g = gains[k] * (zone === 'crux' ? 1.06 : 1);
      const ty = Math.min(highY + p.gain * g * rng.range(0.9, 1.1), this.topY - 0.18);
      if (ty < cur.y + 0.12) continue;
      if (Math.min(ty, other.y) - footHigh > p.footGap * 1.12) continue;
      // compression squeezes: the hands go wide, either side of the line
      const lat = squeeze ? rng.range(0.42, 0.62) : p.lateral * rng.range(0.4, 1.0);
      let tx = this.lineX(ty) + side * lat;
      tx = this.clampX(clamp(tx, other.x - (squeeze ? 1.25 : 0.85), other.x + (squeeze ? 1.25 : 0.85)));
      // hard grades try more same-grade holds before settling for better ones
      const gradeTries = p.grade >= 5 ? 5 : 3;
      const hard = p.grade >= 5;
      // 'jug' is a real jug (rests, the roof's lip); 'good' a good hold of the tower's theme (a jug on
      // classic routes and boulders)
      let mode: 'jug' | 'good' | 'better' | 'grade';
      if (restJug || zone === 'rest') mode = 'jug';
      else if (this.atLip(ty)) mode = k === 0 || g <= 0.74 ? 'jug' : 'better';
      else if (zone === 'start') mode = g <= 0.62 ? 'good' : 'better';
      else if (zone === 'crux') mode = k >= gradeTries + 2 ? 'better' : 'grade';
      else if (bump) mode = hard ? 'grade' : 'good';
      else if (g <= 0.5 || (g <= 0.62 && !hard)) mode = hard ? 'better' : 'good';
      else mode = k >= gradeTries ? 'better' : 'grade';
      const easy = mode === 'jug' || mode === 'good';
      let type: HoldType = mode === 'jug' ? 'jug' : mode === 'good' ? this.goodType(ty) : mode === 'better' ? this.upgrade(this.handType(ty)) : this.handType(ty);
      let size = holdSize(type, p.t, rng);
      // compression: some of the squeezes are route volumes the hands press on
      if (squeeze && !easy && rng.chance(0.22)) {
        type = 'volume';
        size = rng.range(0.16, 0.26);
      }
      let angle = this.classicAngle();
      const awkward = zone === 'crux' ? Math.min(0.9, p.awkward * 1.5) : zone === 'start' ? 0 : p.awkward;
      if (squeeze && !easy) angle = this.facing(li, tx, ty, cur);
      else if (mode === 'grade' && rng.chance(awkward)) angle = this.facing(li, tx, ty, cur);
      if (this.gap(tx, ty, type === 'volume' ? size : 0.07) < 0.03) tx = this.clampX(tx + side * (type === 'volume' ? size + 0.1 : 0.16));
      // holds bolted onto a route volume: squeezes on compression, now and then on mixed / steep problems
      const vol = p.mounts && !easy && type !== 'volume' && rng.chance(this.mountChance()) ? this.mountVolume(tx, ty, angle, size) : null;
      out.push({ li, hold: this.themeHold(this.temp('hand', type, tx, ty, size, angle), mode), fresh: true, maxT: this.maxT, vol: vol ?? undefined });
    }
  }

  /** 'dyno': the signature throw — a good hold well past the static reach, thrown for from this stance. */
  private dynoCands(out: Cand[]): void {
    const { rng, p } = this;
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    const highY = Math.max(a.y, b.y);
    const low: 'LH' | 'RH' = a.y <= b.y ? 'LH' : 'RH';
    const high: 'LH' | 'RH' = low === 'LH' ? 'RH' : 'LH';
    for (let k = 0; k < 4; k++) {
      const gapY = lerp(0.72, 1.0, p.t) * rng.range(0.92, 1.14) + k * 0.05;
      const ty = highY + gapY;
      if (ty > this.topY - 0.4) continue;
      const tx = this.clampX(this.lineX(ty) + rng.range(-0.22, 0.22));
      const target = this.temp('hand', 'jug', tx, ty, rng.range(0.095, 0.12), -HALF_PI + rng.range(-0.1, 0.1));
      const both = canMatch(0, target) && rng.chance(p.grade >= 4 ? 0.5 : 0.25);
      const order: ('LH' | 'RH' | 'both')[] = both ? ['both', low, high] : [low, high, 'both'];
      for (const d of order) out.push({ li: d === 'RH' ? 1 : 0, hold: target, fresh: true, maxT: SOLVER.dynoLandMax, dyno: d });
    }
  }

  /** A foot that is off (cut in a throw) counts as being at the bottom of the wall. */
  private footOf(fi: number): HoldDef {
    const f = this.slots[fi];
    if (f) return f;
    return { id: '~off', x: this.pose.px + (fi === 2 ? -0.2 : 0.2), y: -1, type: 'foot', size: 0.02, angle: -HALF_PI, role: 'foot', color: this.color, seed: 0 };
  }

  private footCands(fi: number, n: number, out: Cand[], maxT = this.maxT): void {
    const { rng, p } = this;
    const cur = this.footOf(fi);
    const side = fi === 2 ? -1 : 1;
    const lowHand = Math.min(this.slots[0]!.y, this.slots[1]!.y);
    const desired = lowHand - p.footGap * 0.82;
    const trav = p.line === 'traverse';
    const handX = (this.slots[0]!.x + this.slots[1]!.x) / 2;
    // progress: up the wall, or along it on a traverse
    const ahead = (h: { x: number; y: number }, by: number): boolean => (trav ? this.dir * (h.x - cur.x) > by : h.y > cur.y + by);
    // reuse a route hold (hand holds make good footholds)
    const reuse = this.holds
      .filter((h) => h.role !== 'deco' && h.role !== 'top' && ahead(h, trav ? 0.08 : 0.12) && h.y < this.pose.py - 0.15 && Math.abs(h.y - desired) < 0.32 && h !== this.slots[5 - fi] && (!trav || Math.abs(h.x - handX) < 0.75))
      .sort((x, y) => Math.abs(x.y - desired) - Math.abs(y.y - desired))
      .slice(0, 2);
    for (const h of reuse) out.push({ li: fi, hold: h, fresh: false, maxT });
    const rs = [0.84, 0.74, 0.94, 0.66, 1.02, 0.58];
    const dxs = [0.2, 0.3, 0.12, 0.4];
    for (let k = 0; k < n; k++) {
      const fy = lowHand - p.footGap * rs[k % rs.length] * rng.range(0.96, 1.04);
      let fx = this.pose.px + side * dxs[k % dxs.length] * rng.range(0.85, 1.15);
      if (trav) fx = this.pose.px + side * dxs[k % dxs.length] * 0.6 + this.dir * rng.range(0.1, 0.38);
      fx = this.clampX(fx);
      if (!ahead({ x: fx, y: fy }, trav ? 0.06 : 0.1)) continue;
      if (this.gap(fx, fy, 0.03) < 0.03) continue;
      const type = this.footType(fy);
      const size = type === 'foot' ? holdSize('foot', p.t, rng) : type === 'jug' ? rng.range(0.07, 0.09) : type === 'crimp' ? 0.035 : rng.range(0.055, 0.075);
      // under a roof half the footholds face up the roof: toe / heel hooks
      const hook = this.angleAt(fy) >= 55 && rng.chance(0.5);
      const angle = hook ? HALF_PI + rng.range(-0.3, 0.3) : -HALF_PI + rng.range(-0.3, 0.3);
      out.push({ li: fi, hold: this.temp('foot', type, fx, fy, size, angle), fresh: true, maxT });
    }
  }

  /**
   * Steep walls: now and then a high heel hook (high-feet spec) — a positive hold at or above the hip, out
   * to the side, facing back toward the hip, which the planner and the sim use as a heel hook (holds.
   * footModeFor). The usual verification decides whether it makes the move.
   */
  private hookCands(fi: number, out: Cand[]): void {
    const { p } = this;
    const rng = this.hookRng;
    const side = fi === 2 ? -1 : 1;
    for (let k = 0; k < 2; k++) {
      const hx = this.clampX(this.pose.px + side * rng.range(0.4, 0.6));
      const hy = this.pose.py + rng.range(-0.02, 0.3);
      if (this.gap(hx, hy, 0.07) < 0.04) continue;
      const type: HoldType = p.grade <= 5 || rng.chance(0.5) ? 'jug' : 'edge';
      const size = type === 'jug' ? rng.range(0.08, 0.1) : rng.range(0.06, 0.075);
      // the good side faces the hip (a little downward): the heel pulls it in
      const angle = datan2(this.pose.py - 0.05 - hy, this.pose.px - hx) + rng.range(-0.2, 0.2);
      // (a plain hold, not dressed: the dress stream of the rest of the route stays as it was)
      const h: HoldDef = { id: `~${this.tmpSeq++}`, x: r3(hx), y: r3(hy), type, size: r3(size), angle: r3(angle), role: 'foot', color: this.color, seed: 0 };
      out.push({ li: fi, hold: h, fresh: true, maxT: this.maxT });
    }
  }

  private topCands(out: Cand[]): void {
    const { rng, p } = this;
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    const trav = p.line === 'traverse';
    // the hand that goes first: the lower one (the leading one on a traverse)
    const first = trav ? (this.dir > 0 ? 1 : 0) : a.y <= b.y ? 0 : 1;
    const ref = trav ? this.slots[first]! : this.slots[1 - first]!;
    for (let k = 0; k < 3; k++) {
      const tx = trav
        ? this.clampX(this.xEnd + this.dir * rng.range(-0.05, 0.12))
        : this.clampX(clamp(this.lineX(this.topY) + rng.range(-0.14, 0.14), ref.x - 0.55, ref.x + 0.55));
      const type: HoldType = p.grade <= 4 || rng.chance(0.55) || k > 0 ? 'jug' : 'edge';
      const size = type === 'jug' ? rng.range(0.095, 0.12) : rng.range(0.075, 0.09);
      const top = this.temp('top', type, tx, this.topY, size, -HALF_PI + rng.range(-0.12, 0.12));
      out.push({ li: k < 2 ? first : 1 - first, hold: top, fresh: true, maxT: Math.max(this.maxT, 0.7) });
    }
  }

  /** Traverse hand moves: the leading hand reaches along the line, the trailing one catches up (or matches). */
  private traverseHandCands(out: Cand[], footHigh: number): void {
    const { rng, p } = this;
    const dir = this.dir;
    const leadI = dir > 0 ? 1 : 0;
    const trailI = 1 - leadI;
    const lead = this.slots[leadI]!;
    const trail = this.slots[trailI]!;
    const fwd: Cand[] = [];
    const back: Cand[] = [];
    const gains = p.grade >= 5 ? [1.06, 0.98, 0.9, 0.82, 0.72, 0.6, 0.48] : [1.04, 0.94, 0.84, 0.74, 0.62, 0.5];
    const hard = p.grade >= 5;
    const typeFor = (g: number, k: number): HoldType => {
      const mode = g <= 0.5 || (g <= 0.62 && !hard) ? (hard ? 'better' : 'jug') : k >= (hard ? 4 : 3) ? 'better' : 'grade';
      return mode === 'jug' ? 'jug' : mode === 'better' ? this.upgrade(this.handType(lead.y)) : this.handType(lead.y);
    };
    for (let k = 0; k < gains.length; k++) {
      const g = gains[k];
      let tx = lead.x + dir * p.gain * g * rng.range(0.9, 1.1);
      if (dir * (tx - this.xEnd) > -0.2) continue; // the top candidates take over at the end
      if (dir * (tx - trail.x) > 1.2) continue;
      tx = this.clampX(tx);
      const ty = clamp(this.lineY(tx) + rng.range(-0.13, 0.13), 1.2, this.topY - 0.3);
      if (Math.min(ty, trail.y) - footHigh > p.footGap * 1.12) continue;
      const type = typeFor(g, k);
      const angle = rng.chance(p.awkward) ? this.facing(leadI, tx, ty, lead) : this.classicAngle();
      fwd.push({ li: leadI, hold: this.temp('hand', type, tx, ty, holdSize(type, p.t, rng), angle), fresh: true, maxT: this.maxT });
    }
    for (let k = 0; k < 4; k++) {
      const tx = this.clampX(lead.x - dir * rng.range(0.15, 0.36));
      if (dir * (tx - trail.x) < 0.12) continue;
      const ty = clamp(this.lineY(tx) + rng.range(-0.12, 0.12), 1.2, this.topY - 0.3);
      if (this.gap(tx, ty, 0.06) < 0.02) continue;
      const type = typeFor(0.7, k + 1);
      back.push({ li: trailI, hold: this.temp('hand', type, tx, ty, holdSize(type, p.t, rng), this.classicAngle()), fresh: true, maxT: this.maxT });
    }
    if (canMatch(trailI, lead) && lead.size >= 0.075) back.push({ li: trailI, hold: lead, fresh: false, maxT: this.maxT });
    const behind = dir * (lead.x - trail.x);
    if (behind > p.gain * 0.75) out.push(...back, ...fwd);
    else out.push(...fwd, ...back);
  }

  private frame(): Frame {
    const { p } = this;
    const cands: Cand[] = [];
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    if (this.prof) {
      // A steep panel is never relaxed, whatever the grade (a cave's roof, a tower's crux, the lip above
      // it): the moves there may strain the body like the panel demands. The setter still aims every
      // move at the grade's targetT; the floor only lets the line get through.
      const hi = Math.max(a.y, b.y);
      const ang = Math.max(this.angleAt(hi), this.angleAt(hi + 0.4), this.angleAt(this.pose.py));
      this.maxT = Math.max(this.baseMaxT, ang >= 38 ? lerp(0.66, 0.78, clamp((ang - 38) / 32, 0, 1)) : 0);
    }
    const f2 = this.footOf(2);
    const f3 = this.footOf(3);
    const footHigh = Math.max(f2.y, f3.y, this.pose.py - 1.1);
    const lowF = f2.y <= f3.y ? 2 : 3;
    const topOn = a.role === 'top' ? 0 : b.role === 'top' ? 1 : -1;
    const trav = p.line === 'traverse';
    if (this.transient && (!this.slots[2] || !this.slots[3])) {
      // right after a throw: the cut feet go back on first
      const lt = SOLVER.dynoLandMax;
      if (!this.slots[2]) this.footCands(2, 6, cands, lt);
      if (!this.slots[3]) this.footCands(3, 6, cands, lt);
    } else if (topOn >= 0) {
      cands.push({ li: 1 - topOn, hold: this.slots[topOn]!, fresh: false, maxT: SOLVER.stanceMax });
      this.footCands(lowF, 4, cands);
      this.footCands(5 - lowF, 2, cands);
    } else if (trav) {
      const lead = this.slots[this.dir > 0 ? 1 : 0]!;
      if (this.dir * (this.xEnd - lead.x) <= p.gain * 1.35) this.topCands(cands);
      const hands: Cand[] = [];
      this.traverseHandCands(hands, footHigh);
      const feet: Cand[] = [];
      const trailF = this.dir * f2.x <= this.dir * f3.x ? 2 : 3;
      this.footCands(trailF, 6, feet);
      this.footCands(5 - trailF, 3, feet);
      const handMid = (a.x + b.x) / 2;
      const footMid = (f2.x + f3.x) / 2;
      const footFirst = this.dir * (handMid - footMid) > 0.5 || Math.min(a.y, b.y) - footHigh > p.footGap * 0.85;
      if (footFirst) cands.push(...feet, ...hands);
      else cands.push(...hands, ...feet);
    } else {
      const highY = Math.max(a.y, b.y);
      const lowY = Math.min(a.y, b.y);
      if (p.style === 'dyno' && !this.dynoDone && this.handMoves >= 2 && highY >= (p.rope ? 3 : 1.9)) this.dynoCands(cands);
      if (this.topY - highY <= p.gain * 1.35) this.topCands(cands);
      const lowH = a.y < b.y || (a.y === b.y && this.rng.chance(0.5)) ? 0 : 1;
      const hands: Cand[] = [];
      const gains = p.grade >= 5 ? [1.06 * this.boost, 0.98, 0.92, 0.86, 0.8, 0.74, 0.66, 0.5, 0.38] : [1.06 * this.boost, 0.96, 0.86, 0.86, 0.74, 0.62, 0.5, 0.38];
      this.handCands(lowH, gains, hands, footHigh);
      const feet: Cand[] = [];
      // a high heel hook on a steep panel (occasionally: a move to remember, not every foot)
      if (!p.rope && p.grade >= 3 && this.angleAt(this.pose.py) >= 25 && this.hookRng.next() < 0.18) this.hookCands(this.hookRng.chance(0.5) ? 2 : 3, feet);
      this.footCands(lowF, 6, feet);
      this.footCands(5 - lowF, 3, feet);
      const bump: Cand[] = [];
      this.handCands(1 - lowH, [0.5, 0.36], bump, footHigh, true);
      const footFirst = lowY - footHigh > p.footGap * 0.8;
      if (footFirst) cands.push(...feet, ...hands, ...bump);
      else cands.push(...hands, ...feet, ...bump);
    }
    return {
      slots: this.slots.slice(),
      pose: { ...this.pose },
      holdCount: this.holds.length,
      counters: { ...this.n },
      sinceRest: this.sinceRest,
      boost: this.boost,
      handMoves: this.handMoves,
      dynoDone: this.dynoDone,
      transient: this.transient,
      restDone: this.restDone,
      cands,
      idx: 0,
    };
  }

  private restore(f: Frame): void {
    this.slots = f.slots.slice();
    this.pose = { ...f.pose };
    this.holds.length = f.holdCount;
    Object.assign(this.n, f.counters);
    this.sinceRest = f.sinceRest;
    this.boost = f.boost;
    this.handMoves = f.handMoves;
    this.dynoDone = f.dynoDone;
    this.transient = f.transient;
    this.restDone = f.restDone;
  }

  /** Sets the route while climbing it (depth-first with backtracking); false when it got stuck. */
  buildRoute(): boolean {
    const { rng, p } = this;
    this.lab = new StanceLab(p.angle, 0, p.profile);
    const trav = p.line === 'traverse';
    this.topY = p.rope ? this.H - 0.75 : this.H - 0.35 + rng.range(-0.05, 0.03);
    if (trav) this.topY = r3(clamp(this.lineY(this.xEnd) + rng.range(0.3, 0.5), 2.4, this.H - 0.6));
    if (this.prof && p.style === 'cave') this.topY = this.H - rng.range(0.24, 0.34); // on the lip
    this.maxT = lerp(0.52, 0.8, p.t);
    this.targetT = lerp(0.3, 0.78, p.t);
    if (this.prof && p.style === 'cave') {
      // a roof is never relaxed: even an easy cave hangs off big holds with the body under tension
      this.maxT = Math.max(this.maxT, lerp(0.7, 0.8, p.t));
      this.targetT = Math.max(this.targetT, 0.5);
    }
    this.baseMaxT = this.maxT;
    if (p.rope) {
      // the crux band: the steepest panel (profiles), else 55–72 % of the height
      const prof = this.prof;
      if (prof) {
        let k = 0;
        for (let i = 1; i < prof.n; i++) if (prof.ang[i] > prof.ang[k]) k = i;
        this.cruxLo = prof.y0[k] - 0.3;
        this.cruxHi = (k + 1 < prof.n ? prof.y0[k + 1] : this.H) + 0.3;
      } else {
        this.cruxLo = this.H * rng.range(0.55, 0.6);
        this.cruxHi = this.H * rng.range(0.68, 0.74);
      }
    }
    // ── start holds ──
    const sy = trav ? this.yStart : rng.range(1.4, 1.75);
    const sx = trav ? this.xStart : this.lineX(sy);
    let L: HoldDef;
    let R: HoldDef;
    if (rng.chance(p.grade <= 6 ? 0.38 : 0.25)) {
      const type: HoldType = p.grade <= 3 || rng.chance(0.5) ? 'jug' : 'edge';
      L = R = this.accept(this.temp('start', type, sx, sy, type === 'jug' ? rng.range(0.095, 0.12) : rng.range(0.075, 0.09), -HALF_PI + rng.range(-0.12, 0.12)));
    } else {
      const dx = trav ? rng.range(0.13, 0.24) : rng.range(0.14, 0.3);
      const startType = (): HoldType => (p.grade <= 2 ? 'jug' : rng.weighted(['jug', 'edge', 'pinch'] as const, [3, 3, 1]));
      L = this.accept(this.temp('start', startType(), sx - dx, sy + rng.range(-0.08, 0.08), rng.range(0.07, 0.1), this.classicAngle()));
      R = this.accept(this.temp('start', startType(), sx + dx, sy + rng.range(-0.08, 0.08), rng.range(0.07, 0.1), this.classicAngle()));
    }
    // ── start feet (try a few placements until the start stance is comfortable) ──
    const cx = (L.x + R.x) / 2;
    let ok = false;
    for (let k = 0; k < 8 && !ok; k++) {
      const fy1 = k < 4 ? rng.range(0.3, 0.6) : rng.range(0.45, 0.75);
      const fy2 = k < 4 ? rng.range(0.3, 0.6) : rng.range(0.45, 0.75);
      const type = k < 5 ? this.footType(fy1) : 'edge';
      const sz = (t: HoldType): number => (t === 'foot' ? holdSize('foot', p.t, rng) : t === 'jug' ? 0.08 : t === 'crimp' ? 0.035 : 0.065);
      const fl = this.temp('foot', type, this.clampX(cx - rng.range(0.16, 0.32)), fy1, sz(type), -HALF_PI + rng.range(-0.25, 0.25));
      const fr = this.temp('foot', type, this.clampX(cx + rng.range(0.16, 0.32)), fy2, sz(type), -HALF_PI + rng.range(-0.25, 0.25));
      const slots = [L, R, fl, fr];
      const st = this.lab.stance(slots, null);
      if (st.ok && st.tension <= Math.max(this.maxT, 0.6)) {
        this.accept(fl);
        this.accept(fr);
        this.startFeet = { LF: fl.id, RF: fr.id };
        this.slots = slots;
        this.pose = st.pose;
        ok = true;
      }
    }
    if (!ok) return false;

    // ── the climb: depth-first over candidate moves, backtracking out of dead ends ──
    let budget = p.rope ? 2400 : trav ? 900 : this.prof ? 1100 : 650;
    const stack: Frame[] = [this.frame()];
    // Lead: the long tower gets stuck where it gets hard (the roof crux, the lip). Plain backtracking
    // then spends the whole budget on the last few moves below the dead end; instead, after
    // LEAD_STUCK evaluations without a new high point, the setter jumps back ≈ LEAD_JUMP m below the
    // highest hands and sets the approach to the crux anew (deterministic: counts only).
    let bestY = -Infinity;
    let sinceBest = 0;
    const handY = (f: Frame): number => Math.max(f.slots[0]!.y, f.slots[1]!.y);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const a = this.slots[0]!;
      const b = this.slots[1]!;
      if (a.role === 'top' && b === a) {
        this.top = a;
        return true;
      }
      if (p.rope && sinceBest > LEAD_STUCK && stack.length > 2) {
        sinceBest = 0;
        const floor = bestY - LEAD_JUMP;
        while (stack.length > 2 && handY(stack[stack.length - 1]) > floor) stack.pop();
        // the frame jumped back to tries its next candidate (its current one led into the dead end)
        this.restore(stack[stack.length - 1]);
        continue;
      }
      if (top.idx >= top.cands.length || budget <= 0) {
        stack.pop();
        if (!stack.length || budget <= 0) return false;
        this.restore(stack[stack.length - 1]);
        continue;
      }
      // Among the next few feasible candidates of the same kind, set the one whose strain is
      // closest to the grade's target (easy grades stay relaxed, hard grades live near the limit).
      const first = top.cands[top.idx++];
      budget--;
      sinceBest++;
      const r0 = this.evalCand(first);
      if (!r0) continue;
      let c = first;
      let r = r0;
      if (first.fresh && first.hold.role !== 'top' && !first.dyno) {
        let bestErr = Math.abs(r0.tension - this.targetT);
        for (let k = top.idx, seen = 0; k < top.cands.length && seen < 3 && budget > 0; k++) {
          const alt = top.cands[k];
          if (alt.li !== first.li || !alt.fresh || alt.hold.role === 'top' || alt.dyno) continue;
          seen++;
          budget--;
          const ra = this.evalCand(alt);
          if (!ra) continue;
          const err = Math.abs(ra.tension - this.targetT);
          if (err < bestErr) {
            bestErr = err;
            c = alt;
            r = ra;
          }
        }
        if (c !== first) {
          // keep the skipped first candidate available for backtracking
          const at = top.cands.indexOf(c);
          top.cands.splice(at, 1);
          top.cands.splice(top.idx, 0, first);
        }
      }
      this.slots = r.slots;
      this.pose = r.pose;
      if (c.fresh && c.vol) c.hold.onVolume = this.accept(c.vol).id;
      if (c.fresh) this.accept(c.hold);
      if (c.dyno) {
        this.dynoDone = true;
        this.transient = true;
        this.handMoves++;
      } else if (this.transient && this.slots[2] && this.slots[3] && r.tension <= SOLVER.stanceMax) this.transient = false;
      if (c.li < 2 && !c.dyno) {
        this.handMoves++;
        if (c.fresh && c.hold.angle > 0.5) this.boost = 1.12;
        if (p.rope && c.fresh) {
          this.sinceRest = c.hold.type === 'jug' ? 0 : this.sinceRest + p.gain * 0.5;
          if (c.hold.type === 'jug' && c.hold.y >= this.cruxLo - 1.1 && c.hold.y < this.cruxLo) this.restDone = true;
        }
      }
      stack.push(this.frame());
      const hy = Math.max(this.slots[0]!.y, this.slots[1]!.y);
      if (hy > bestY + 1e-9) {
        bestY = hy;
        sinceBest = 0;
      }
    }
    return false;
  }

  /** Extra footholds around the line (fewer on hard problems, more on slabs; none in a dyno's gap). */
  buildExtraFeet(): void {
    const { rng, p } = this;
    const topY = this.top ? this.top.y : this.H - 0.35;
    const k = p.style === 'slab' ? 1.6 : 1;
    const extra = Math.round(lerp(p.rope ? 9 : 5, p.rope ? 3 : 1, p.t) * rng.range(0.7, 1.3) * k);
    const trav = p.line === 'traverse';
    for (let i = 0; i < extra; i++) {
      let x: number;
      let y: number;
      if (trav) {
        x = this.clampX(rng.range(Math.min(this.xStart, this.xEnd), Math.max(this.xStart, this.xEnd)));
        y = clamp(this.lineY(x) - rng.range(0.9, 1.35), 0.3, topY - 1.0);
      } else {
        y = rng.range(0.35, topY - 1.0);
        x = this.clampX(this.lineX(y) + rng.range(-0.45, 0.45));
      }
      if (this.gap(x, y, 0.03) < 0.1) continue;
      if (p.style === 'dyno' && this.inDynoShadow(y)) continue;
      this.add('foot', this.footType(y) === 'jug' ? 'edge' : 'foot', x, y, holdSize('foot', p.t, rng) + (rng.chance(0.3) ? 0.025 : 0), -HALF_PI + rng.range(-0.3, 0.3));
    }
  }

  /** A foothold here could let the climber stand up into the dyno's target (no throw needed). */
  private inDynoShadow(y: number): boolean {
    for (const h of this.holds) if (h.role === 'hand' && h.type === 'jug' && y > h.y - 1.9 && y < h.y - 0.8) return true;
    return false;
  }

  /**
   * Bolts per EN 12572-1 / research §3.5: the first ≤ 3.1 m (here 1.95–2.25 m), ≤ 1 m apart up to 5 m,
   * 1.2–1.45 m up to 8 m, then 1.45–1.8 m; each draw sits at chest height of a climber on a positive
   * clip hold (the bolt 0.25–0.7 m under a good hand hold, beside it), then the anchor over the top.
   */
  buildQuickdraws(): void {
    const { rng } = this;
    const top = this.top!;
    let y = rng.range(1.95, 2.25);
    let side = rng.chance(0.5) ? -1 : 1;
    let i = 0;
    let prev = 0;
    // The bolt stays off the holds, and the carabiner (where the hand clips) stays clear of every
    // route hold, so releasing a hand on a hold never has to choose between grabbing and clipping.
    const clear = (x: number, y: number): boolean => this.gap(x, y, 0.05) >= 0.05 && this.gap(x, y - SIM.quickdrawDrop, CLIP_CLEARANCE) >= 0;
    const clipHolds = this.holds.filter((h) => usableByHand(h) && h.role !== 'top' && nominalCapacity(h, true, this.angleAt(h.y)) >= 0.5);
    while (y < top.y - 0.9) {
      const maxGap = prev < 5 ? 1.0 : prev < 8 ? 1.5 : 2.0;
      // a positive clip hold whose chest-height bolt (0.45 m under the hand) lands near the scheduled height
      const opts: { h: HoldDef; by: number; sc: number }[] = [];
      for (const h of clipHolds) {
        const by = r3(h.y - 0.45);
        if (by < y - 0.35 || by > y + 0.2 || by > top.y - 0.9) continue;
        if (i === 0 ? by > 3.0 || by < 1.6 : by - prev > maxGap || by - prev < 0.6) continue;
        opts.push({ h, by, sc: nominalCapacity(h, true, this.angleAt(h.y)) - Math.abs(by - y) * 1.2 });
      }
      opts.sort((a, b) => b.sc - a.sc);
      let placed: QuickdrawDef | null = null;
      for (const o of opts.slice(0, 4)) {
        const toLine = this.lineX(o.by) >= o.h.x ? 1 : -1;
        for (const dx of [0.26, 0.2, 0.34, -0.26, -0.34]) {
          const cx = this.clampX(o.h.x + toLine * dx * rng.range(0.92, 1.08));
          if (clear(cx, o.by)) {
            placed = { id: `q${i}`, x: r3(cx), y: o.by };
            break;
          }
        }
        if (placed) break;
      }
      if (!placed) {
        // no clip hold here: beside the line as before (the planner still verifies a clipping stance)
        const x0 = this.clampX(this.lineX(y) + side * rng.range(0.15, 0.35));
        let x = this.clampX(x0 + side * 0.15);
        if (clear(x0, y)) x = x0;
        else
          for (const dx of [0.15, 0.3, -0.15, 0.45, -0.3]) {
            const cx = this.clampX(x0 + side * dx);
            if (clear(cx, y)) {
              x = cx;
              break;
            }
          }
        placed = { id: `q${i}`, x: r3(x), y: r3(y) };
      }
      this.draws.push(placed);
      i++;
      prev = placed.y;
      y = prev + (prev < 5 ? rng.range(0.85, 0.98) : prev < 8 ? rng.range(1.2, 1.45) : rng.range(1.45, 1.8));
      if (rng.chance(0.7)) side = -side;
    }
    this.draws.push({ id: `q${i}`, x: r3(this.clampX(top.x + rng.range(-0.08, 0.08))), y: r3(top.y + 0.42) });
  }

  buildVolumes(): void {
    const { rng, p } = this;
    const n = rng.int(1, p.rope ? 5 : 4);
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 20; tries++) {
        const size = rng.range(0.25, 0.45);
        const route = p.grade >= 2 && rng.chance(0.3);
        const y = route ? rng.range(0.5, this.H - 1.4) : rng.range(0.6, this.H - 0.6);
        const x = route ? this.clampX(this.lineX(y) + rng.range(-0.5, 0.5)) : rng.range(-this.W / 2 + size + 0.1, this.W / 2 - size - 0.1);
        const minGap = route ? 0.05 : 0.14;
        if (this.gap(x, y, size, (h) => h.role !== 'deco' || h.type === 'volume') < minGap) continue;
        if (this.draws.some((q) => dhypot(q.x - x, q.y - y) < size + 0.15)) continue;
        if (route && p.style === 'dyno' && this.inDynoShadow(y)) continue;
        if (route) this.add('foot', 'volume', x, y, size, -HALF_PI + rng.range(-0.2, 0.2));
        else this.add('deco', 'volume', x, y, size, -HALF_PI + rng.range(-0.4, 0.4), rng.pick(WALL.volumeColors));
        break;
      }
    }
  }

  buildDeco(): void {
    const { rng, p } = this;
    const target = p.rope ? rng.int(90, 140) : rng.int(40, 90);
    const colors = ROUTE_COLORS.map((c) => c.hex).filter((c) => c !== this.color);
    rng.shuffle(colors);
    const nRoutes = p.rope ? rng.int(4, 6) : rng.int(4, 7);
    const types: HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot'];
    const weights = [3, 3, 2, 2, 2, 1, 2];
    let placed = 0;
    for (let r = 0; r < nRoutes * 3 && placed < target; r++) {
      const color = colors[r % colors.length];
      const x0 = rng.range(-this.W / 2 + 0.4, this.W / 2 - 0.4);
      const amp = rng.range(0.1, 0.5);
      const fr = rng.range(0.6, 1.6);
      const ph = rng.range(0, 6.28);
      const per = Math.ceil(target / nRoutes) + 2;
      const spacing = (this.H - 0.5) / per;
      for (let k = 0; k < per && placed < target; k++) {
        const y = 0.25 + k * spacing + rng.range(-spacing * 0.35, spacing * 0.35);
        const x = this.clampX(x0 + amp * dsin(y * fr + ph) + rng.range(-0.3, 0.3));
        const type = rng.weighted(types, weights);
        const size = holdSize(type, rng.next(), rng);
        if (this.gap(x, y, size, (h) => h.role === 'deco') < 0.07) continue;
        if (this.gap(x, y, size, (h) => h.role !== 'deco') < 0.13) continue;
        if (this.draws.some((q) => dhypot(q.x - x, q.y - y) < 0.2)) continue;
        this.add('deco', type, x, y, size, -HALF_PI + rng.gauss() * 0.45, color);
        placed++;
      }
    }
  }
}

function lineFor(style: RouteStyle, rope: boolean, rng: Rng): Line {
  // lead lines: a meander up the tower, zigzags between the edges, or a diagonal from one side to the other
  if (rope) return rng.weighted(['wave', 'zigzag', 'diagonal'] as const, [1.3, 1, 0.8]);
  switch (style) {
    case 'traverse':
      return 'traverse';
    case 'diagonal':
      return 'diagonal';
    case 'zigzag':
      return 'zigzag';
    default:
      return 'wave';
  }
}

/**
 * The hold set of a lead tower (LeadTheme), from the route's seed: every retry of a route keeps it, so the
 * tower the player sees is the set its seed promised. Easy towers lean on jugs + edges.
 */
export function leadTheme(seed: number, grade: number): LeadTheme {
  const g = clamp(Math.round(Number.isFinite(grade) ? grade : 0), 0, 12);
  const rng = new Rng(new Rng((Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0).fork(0x7e3e).int(1, 0x7fffffff));
  return rng.weighted(LEAD_THEMES, [0.55, g <= 3 ? 1.5 : 1.05, g <= 1 ? 0.6 : 1.15, g <= 1 ? 0.7 : 1.1]);
}

function paramsFor(grade: number, angle: number, rope: boolean, ease: number, style: RouteStyle, profile: ProfileSpec | null, rng: Rng, mounts = false, theme: Theme = 'classic'): Params {
  const g = clamp(Math.round(grade), 0, 12);
  const t = g / 12;
  const p: Params = {
    grade: g,
    t,
    angle,
    gain: lerp(0.36, 0.62, t) * (1 - 0.06 * ease) * (rope ? 0.95 : 1),
    lateral: lerp(0.17, 0.38, t),
    footGap: lerp(1.18, 1.48, t) - 0.08 * ease,
    awkward: lerp(0.0, 0.45, t) * (1 - 0.4 * ease),
    rope,
    style,
    line: lineFor(style, rope, rng.fork(0x11e)),
    profile,
    mounts,
    theme: rope ? theme : 'classic',
    themeK: 1,
  };
  switch (style) {
    case 'slab':
      // balance: high feet, slightly longer reaches between fewer hand holds, less body tension
      p.footGap -= 0.06;
      p.gain *= 1.04;
      p.awkward *= 0.6;
      break;
    case 'traverse':
      p.gain *= 0.92;
      break;
    case 'compression':
      p.awkward = Math.max(p.awkward, 0.3);
      break;
    case 'cave':
      p.gain *= 0.95;
      break;
    case 'mixed':
      p.awkward = Math.min(0.6, p.awkward * 1.3 + 0.05);
      break;
    default:
  }
  return p;
}

function routeColor(opts: GenerateOptions, rng: Rng): string {
  if (opts.colorIndex !== undefined && Number.isFinite(opts.colorIndex)) {
    const n = ROUTE_COLORS.length;
    return ROUTE_COLORS[((Math.floor(opts.colorIndex) % n) + n) % n].hex;
  }
  // Black on a charcoal wall reads poorly: never the seeded route colour.
  const pool = ROUTE_COLORS.filter((c) => c.name !== 'Black');
  return rng.pick(pool).hex;
}

const deriveSeed = (seed: number, attempt: number): number => (attempt === 0 ? seed >>> 0 : hashString(`${seed >>> 0}:${attempt}:chiral`));

/** Multi-angle profiles for these options (GenerateOptions.profiles, else the GEN.profiles switch). */
const profilesOn = (opts: GenerateOptions): boolean => (opts.profiles ?? GEN.profiles) === true && opts.wallAngle === undefined;

/**
 * Hand holds bolted onto route volumes for these options (GenerateOptions.holdsOnVolumes, else
 * GEN.holdsOnVolumes). Boulders only: lead towers keep their faces clear for the bolt line.
 */
const mountsOn = (opts: GenerateOptions): boolean => opts.mode !== 'rope' && (opts.holdsOnVolumes ?? GEN.holdsOnVolumes) === true;

/**
 * The archetype a boulder gets: GenerateOptions.style, else the Send Train rotation (opts.run), else a
 * grade-weighted pick from the seed. Without profiles, profile-only archetypes fall back (cave → overhang).
 */
export function styleFor(opts: GenerateOptions): RouteStyle {
  const profiles = profilesOn(opts);
  const seed = (Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 1) >>> 0;
  const grade = clamp(Math.round(Number.isFinite(opts.grade) ? opts.grade : 0), 0, 12);
  let s: RouteStyle;
  if (opts.style) s = opts.style;
  else if (opts.run && Number.isFinite(opts.run.seed) && Number.isFinite(opts.run.index)) s = runStyle(opts.run.seed, opts.run.index, profiles);
  else s = pickStyle(grade, new Rng(seed).fork(0x5791e), profiles);
  return flatFallback(s, profiles);
}

function assemble(rope: boolean, b: Builder, grade: number, angle: number, name: string, seed: number, style: RouteStyle | undefined): BoulderDef {
  const wall = rope ? GAME.ropeWall : GAME.boulderWall;
  const prof = b.p.profile;
  const def: BoulderDef = {
    id: `${rope ? 'r' : 'b'}-${(seed >>> 0).toString(36)}-${grade}`,
    name,
    grade,
    mode: rope ? 'rope' : 'boulder',
    wallAngle: prof ? steepestAngle(prof.panels) : angle,
    width: wall.width,
    height: prof ? prof.length : wall.height,
    holds: b.holds,
    color: b.color,
    seed: seed >>> 0,
    startFeet: { ...b.startFeet },
  };
  if (prof) def.profile = prof.panels.map((q) => ({ ...q }));
  if (style) def.style = style;
  if (rope) def.quickdraws = b.draws;
  return def;
}

/** A plain ladder that is always climbable: the generator's last resort (a vertical wall). */
function ladder(rope: boolean, color: string, name: string, seed: number): BoulderDef {
  const rng = new Rng(seed ^ 0x1add3);
  const p = paramsFor(0, 0, rope, 1, 'vertical', null, rng);
  p.line = 'wave';
  p.theme = 'classic';
  const b = new Builder(rng, p, color);
  const wall = rope ? GAME.ropeWall : GAME.boulderWall;
  const topY = rope ? wall.height - 0.75 : wall.height - 0.35;
  const cx = rng.range(-0.6, 0.6);
  b.add('start', 'jug', cx - 0.2, 1.5, 0.1, -HALF_PI);
  b.add('start', 'jug', cx + 0.2, 1.5, 0.1, -HALF_PI);
  const fl = b.add('foot', 'jug', cx - 0.22, 0.42, 0.08, -HALF_PI);
  const fr = b.add('foot', 'jug', cx + 0.22, 0.42, 0.08, -HALF_PI);
  b.startFeet = { LF: fl.id, RF: fr.id };
  let side = 1;
  for (let y = 1.86; y < topY - 0.3; y += 0.36) {
    b.add('hand', 'jug', cx + side * 0.2, y, 0.1, -HALF_PI);
    side = -side;
  }
  for (let y = 0.78; y < topY - 1.15; y += 0.36) {
    b.add('foot', 'jug', cx + side * 0.22, y, 0.08, -HALF_PI);
    side = -side;
  }
  // the ladder's holds are plain jugs (no shapes / wood): it must stay the easiest wall there is
  for (const h of b.holds) delete h.shape;
  b.top = b.add('top', 'jug', cx, topY, 0.11, -HALF_PI);
  delete b.top.shape;
  if (rope) b.buildQuickdraws();
  b.buildDeco();
  return assemble(rope, b, 0, 0, name, seed, rope ? undefined : 'vertical');
}

/** Minimum hand moves for a problem to feel like a problem. */
function interesting(plan: PlanResult, rope: boolean): boolean {
  let hands = 0;
  for (const m of plan.moves) if (m.limb === 'LH' || m.limb === 'RH') hands++;
  return hands >= (rope ? 12 : 4);
}

/** Does the verified beta climb the archetype the problem claims (labels must match the wall)? */
function climbsStyle(def: BoulderDef, plan: PlanResult): boolean {
  if (def.style === 'dyno') return plan.steps.some((s) => s.move.dyno !== undefined);
  if (def.style === 'traverse') {
    const starts = def.holds.filter((h) => h.role === 'start');
    const top = def.holds.find((h) => h.role === 'top');
    if (!top || !starts.length) return false;
    const sx = starts.reduce((a, h) => a + h.x, 0) / starts.length;
    return Math.abs(top.x - sx) >= 2.2;
  }
  return true;
}

/** One unverified candidate layout (attempt k of the retry chain). Exposed for tools and tests. */
export function generateCandidate(opts: GenerateOptions, attempt: number): BoulderDef | null {
  const rope = opts.mode === 'rope';
  const seed = (Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 1) >>> 0;
  const grade = clamp(Math.round(Number.isFinite(opts.grade) ? opts.grade : 0), 0, 12);
  const base = new Rng(seed);
  const name = opts.name ?? routeName(base.fork(0x5a17));
  const color = routeColor(opts, base.fork(0xc010));
  const attempts = rope ? ROPE_ATTEMPTS : BOULDER_ATTEMPTS;
  const rng = new Rng(deriveSeed(seed, attempt));
  const ease = attempt < attempts / 2 ? 0 : 1;
  const profiles = profilesOn(opts);
  const style = rope ? 'vertical' : styleFor(opts);
  let profile: ProfileSpec | null = null;
  let angle: number;
  if (opts.wallAngle !== undefined) angle = opts.wallAngle;
  else if (rope) {
    if (profiles) profile = leadProfile(Math.max(0, grade - 2 * ease), rng.fork(0x1ead), GAME.ropeWall.height);
    angle = leadAngle(grade, rng.fork(0xa9));
    if (ease) angle = Math.min(angle, 10);
  } else {
    if (profiles) profile = styleProfile(style, Math.max(0, grade - 2 * ease), rng.fork(0x9f0f));
    angle = styleAngle(style, grade, rng.fork(0xa9));
    // eased retries soften the wall (an overhang stays an overhang, a slab a slab)
    if (ease && style !== 'slab') angle = Math.min(angle, style === 'overhang' || style === 'compression' ? 25 : 20);
  }
  angle = clamp(angle, -15, 45);
  const params = paramsFor(grade, angle, rope, ease, style, profile, rng, mountsOn(opts), rope ? leadTheme(seed, grade) : 'classic');
  // a tower that got stuck twice eases its theme on the next tries (it keeps the set's flavour)
  if (rope) params.themeK = attempt < 2 ? 1 : attempt < 4 ? 0.65 : attempt < 6 ? 0.4 : 0.2;
  const b = new Builder(rng, params, color);
  if (!b.buildRoute()) return null;
  b.buildExtraFeet();
  if (rope) b.buildQuickdraws();
  b.buildVolumes();
  b.buildDeco();
  return assemble(rope, b, grade, angle, name, seed, rope ? undefined : style);
}

const BOULDER_ATTEMPTS = 12;
const ROPE_ATTEMPTS = 8;

function generate(opts: GenerateOptions, rope: boolean): BoulderDef {
  const o: GenerateOptions = { ...opts, mode: rope ? 'rope' : 'boulder' };
  const maxNodes = rope ? SOLVER.maxNodesRope : SOLVER.maxNodesBoulder;
  const attempts = rope ? ROPE_ATTEMPTS : BOULDER_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const def = generateCandidate(o, attempt);
    if (!def) continue;
    const plan = planBetaDetailed(def, { maxNodes });
    // rope: every quickdraw must be clippable from some stance along the beta
    if (plan && interesting(plan, rope) && climbsStyle(def, plan) && (!rope || plan.clipsPlanned === (def.quickdraws?.length ?? 0))) return def;
  }
  const seed = (Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 1) >>> 0;
  const base = new Rng(seed);
  const name = opts.name ?? routeName(base.fork(0x5a17));
  const color = routeColor(opts, base.fork(0xc010));
  return ladder(rope, color, name, seed);
}

// ═══════════════════════════════ public API ═══════════════════════════════

/** Randomized boulder problem (4.6 × 4.5 m CHIRAL wall). Deterministic per seed + grade (+ style / run). */
export function generateBoulder(opts: GenerateOptions): BoulderDef {
  return generate(opts, opts.mode === 'rope');
}

/** Lead route on the 15 m tower with quickdraws; the last quickdraw is the anchor. */
export function generateRopeRoute(opts: GenerateOptions): BoulderDef {
  return generate({ ...opts, mode: 'rope' }, true);
}

/** 'YYYY-MM-DD' in UTC. */
export function todayKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Daily grade by UTC weekday: Monday V2 … Sunday V7. */
export function dailyGrade(dateKey: string): number {
  const d = new Date(`${dateKey}T12:00:00Z`);
  const wd = Number.isNaN(d.getTime()) ? 3 : d.getUTCDay(); // 0 = Sunday
  return [7, 2, 3, 4, 5, 5, 6][wd];
}

/**
 * One seeded problem per UTC day, identical for every player. Its archetype follows the weekday
 * (archetypes.ts dailyStyle: Mon vertical/mixed · Tue slab · Wed traverse · Thu zigzag/diagonal · Fri dyno ·
 * Sat compression · Sun cave/overhang), so the daily problem feels different every day.
 */
export function dailyBoulder(dateKey: string): BoulderDef {
  const seed = hashString(`chiral-daily:${dateKey}`);
  const style = dailyStyle(dateKey, GEN.profiles);
  const b = generateBoulder({ seed, grade: dailyGrade(dateKey), mode: 'boulder', style });
  return { ...b, id: `daily-${dateKey}` };
}

/** Send Train: the archetype of problem `index` of a run (pass `run` to generateBoulder to get it). */
export { runStyle, dailyStyle } from './archetypes';

// ═══════════════════════════════ tutorial ═══════════════════════════════

export type TutorialTeach = 'hand' | 'foot' | 'hips' | 'shake' | 'match';

export interface TutorialStep {
  limb: LimbId;
  holdId: string;
  teach: TutorialTeach;
}

/** Steini's lesson holds are CHIRAL pink. */
const TUT = '#D54051';
const tutHold = (id: string, x: number, y: number, type: HoldType, size: number, role: HoldRole, angleDeg = -90, seed = 1): HoldDef => ({
  id,
  x,
  y,
  type,
  size,
  angle: r3((angleDeg * Math.PI) / 180),
  role,
  color: TUT,
  seed,
});

/**
 * Steini's hand-authored lesson: a friendly vertical problem on big CHIRAL-pink jugs. Laid out against
 * the anatomical reach envelopes (anatomy.ts): with the climber's natural reach every scripted move ends
 * at least 5 cm inside the limb's envelope (anatomy.test.ts checks it), the stretch to tut-hand-3 is
 * long enough to shake on the way, and the right foot coming up under it calms things down.
 */
export function tutorialBoulder(): BoulderDef {
  const holds: HoldDef[] = [
    tutHold('tut-start-l', -0.2, 1.5, 'jug', 0.11, 'start', -90, 11),
    tutHold('tut-start-r', 0.2, 1.52, 'jug', 0.11, 'start', -90, 12),
    tutHold('tut-foot-l', -0.24, 0.42, 'jug', 0.085, 'foot', -90, 13),
    tutHold('tut-foot-r', 0.22, 0.4, 'jug', 0.085, 'foot', -90, 14),
    tutHold('tut-hand-1', 0.3, 1.98, 'jug', 0.11, 'hand', -90, 15),
    tutHold('tut-foot-2', 0.28, 0.82, 'jug', 0.085, 'foot', -90, 16),
    tutHold('tut-hand-2', -0.24, 2.39, 'jug', 0.11, 'hand', -90, 17),
    tutHold('tut-foot-3', -0.32, 1.25, 'jug', 0.085, 'foot', -90, 18),
    tutHold('tut-hand-3', 0.95, 2.68, 'edge', 0.075, 'hand', -170, 19),
    tutHold('tut-foot-4', 0.43, 1.47, 'jug', 0.085, 'foot', -90, 20),
    tutHold('tut-hand-4', 0.11, 3.04, 'jug', 0.11, 'hand', -90, 21),
    tutHold('tut-foot-5', -0.09, 1.83, 'jug', 0.085, 'foot', -90, 22),
    tutHold('tut-top', 0.36, 3.61, 'jug', 0.12, 'top', -90, 23),
    tutHold('tut-foot-6', 0.56, 2.08, 'jug', 0.085, 'foot', -90, 24),
  ];
  const rng = new Rng(0x57e1);
  const b = new Builder(rng, paramsFor(0, 0, false, 1, 'vertical', null, rng), TUT);
  for (const h of holds) b.holds.push(h);
  b.buildVolumes();
  b.buildDeco();
  return {
    id: 'tutorial',
    name: 'Steini’s First Steps',
    grade: 0,
    mode: 'boulder',
    wallAngle: 0,
    width: GAME.boulderWall.width,
    height: GAME.boulderWall.height,
    holds: b.holds,
    color: TUT,
    seed: 0x57e1,
    author: 'Steini',
    startFeet: { LF: 'tut-foot-l', RF: 'tut-foot-r' },
    style: 'vertical',
  };
}

/**
 * Scripted lesson on tutorialBoulder(), in order: a right-hand move, a right-foot move, a weight
 * shift, a left-hand move, a left-foot move, an awkward reach that makes the climber shake, then up
 * to the top and match.
 *  - 'hips' steps don't move a limb: `limb` is already on `holdId`; the player drags the hips over
 *    that hold (setHipTarget) and feels the weight go onto it.
 *  - 'shake' is a deliberately long, sideways reach: tension rises past the shaking threshold
 *    without slipping, and the following foot move calms it down again.
 *  - 'match' steps put both hands on the top hold; holding the match sends the problem.
 */
export const TUTORIAL_SEQUENCE: readonly TutorialStep[] = [
  { limb: 'RH', holdId: 'tut-hand-1', teach: 'hand' },
  { limb: 'RF', holdId: 'tut-foot-2', teach: 'foot' },
  { limb: 'RF', holdId: 'tut-foot-2', teach: 'hips' },
  { limb: 'LH', holdId: 'tut-hand-2', teach: 'hand' },
  { limb: 'LF', holdId: 'tut-foot-3', teach: 'foot' },
  { limb: 'RH', holdId: 'tut-hand-3', teach: 'shake' },
  { limb: 'RF', holdId: 'tut-foot-4', teach: 'foot' },
  { limb: 'LH', holdId: 'tut-hand-4', teach: 'hand' },
  { limb: 'LF', holdId: 'tut-foot-5', teach: 'foot' },
  { limb: 'RF', holdId: 'tut-foot-6', teach: 'foot' },
  { limb: 'LH', holdId: 'tut-top', teach: 'match' },
  { limb: 'RH', holdId: 'tut-top', teach: 'match' },
];

// Procedural problem generator for the CHIRAL wall.
//
// A route is built by "climbing it while setting it": a virtual climber leapfrogs its hands up a
// meandering line (move length, hold types, awkward angles and wall angle scale with the grade),
// footholds are set where its feet need them, the top is a matchable jug/edge, and the wall is
// filled with other routes' (unusable) holds and volumes. Every candidate is verified with the
// beta planner; failed candidates are retried with derived seeds (then eased parameters), and a
// guaranteed ladder layout is the last resort. Budgets are node counts, so generation is
// deterministic on every device: same seed → identical boulder.

import type { BoulderDef, HoldDef, HoldRole, HoldType, LimbId, QuickdrawDef } from '../core/types';
import type { GenerateOptions } from '../core/contracts';
import { GAME, SIM } from '../config/tuning';
import { ROUTE_COLORS, WALL } from '../config/brand';
import { hashString, Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import { planBetaDetailed, SOLVER, StanceLab, type PlanResult } from './solver';
import type { Pose } from './statics';
import { datan2, dhypot, dsin } from './dmath';

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

const ANGLES = [-8, 0, 5, 10, 15, 20, 25, 30, 35, 40] as const;
/** Minimum gap (m) between a quickdraw's clip point and the edge of any route hold. */
const CLIP_CLEARANCE = 0.07;

function pickAngle(grade: number, rope: boolean, rng: Rng): number {
  let w: number[];
  if (rope) w = grade <= 3 ? [0, 3, 2, 1, 0, 0, 0, 0, 0, 0] : [0, 1, 2, 2, 1.2, 0.6, 0, 0, 0, 0];
  else if (grade <= 2) w = [1, 4, 2.5, 2, 0, 0, 0, 0, 0, 0];
  else if (grade <= 5) w = [0.8, 1.5, 1.5, 2.5, 2.5, 1.5, 0.7, 0, 0, 0];
  else if (grade <= 8) w = [0, 0.8, 0.8, 1.5, 2, 2, 1.6, 1.2, 0.6, 0];
  else w = [0, 0, 0.4, 0.8, 1.2, 1.8, 2, 2, 1.6, 1];
  return rng.weighted(ANGLES, w);
}

const HAND_TYPES: readonly HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket'];

function handTypeWeights(grade: number, angle: number): number[] {
  let w: number[];
  if (grade <= 1) w = [8, 2, 0, 0, 0, 0];
  else if (grade <= 3) w = [5, 4, 0, 0.5, 1, 1];
  else if (grade <= 5) w = [2.5, 4, 1.5, 1, 1.5, 1];
  else if (grade <= 8) w = [1.2, 3, 2.5, 1.5, 1.5, 1];
  else w = [0.6, 2.5, 3, 2, 1.5, 1];
  const s = Math.max(0, angle) / 40;
  w[0] *= 1 + 1.6 * s; // jug
  w[1] *= 1 + 0.3 * s; // edge
  w[2] *= 1 - 0.65 * s; // crimp
  w[3] *= 1 - 0.75 * s; // sloper
  w[4] *= 1 + 0.5 * s; // pinch
  if (angle < 0) {
    w[3] *= 1.5;
    w[2] *= 1.3;
    w[0] *= 0.8;
  }
  return w;
}

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


// ═══════════════════════════════ builder ═══════════════════════════════

interface Cand {
  li: number;
  hold: HoldDef;
  /** A new hold to be set (vs an existing route hold reused). */
  fresh: boolean;
  maxT: number;
}

interface Frame {
  slots: (HoldDef | null)[];
  pose: Pose;
  holdCount: number;
  counters: { s: number; h: number; f: number; t: number; v: number; d: number };
  sinceRest: number;
  boost: number;
  cands: Cand[];
  idx: number;
}

interface Params {
  grade: number;
  t: number;
  angle: number;
  gain: number;
  lateral: number;
  footGap: number;
  awkward: number;
  rope: boolean;
}

class Builder {
  readonly holds: HoldDef[] = [];
  readonly draws: QuickdrawDef[] = [];
  readonly n = { s: 0, h: 0, f: 0, t: 0, v: 0, d: 0 };
  readonly W: number;
  readonly H: number;
  readonly color: string;
  private x0: number;
  private amp: number;
  private freq: number;
  private phase: number;
  private drift: number;
  startFeet: { LF?: string; RF?: string } = {};
  top: HoldDef | null = null;

  constructor(
    readonly rng: Rng,
    readonly p: Params,
    color: string,
  ) {
    const wall = p.rope ? GAME.ropeWall : GAME.boulderWall;
    this.W = wall.width;
    this.H = wall.height;
    this.color = color;
    this.x0 = p.rope ? rng.range(-0.7, 0.7) : rng.range(-1.05, 1.05);
    this.amp = rng.range(0.08, p.rope ? 0.4 : 0.45);
    this.freq = rng.range(0.7, 1.5);
    this.phase = rng.range(0, Math.PI * 2);
    this.drift = rng.range(-0.1, 0.1) * (p.rope ? 0.35 : 1);
  }

  lineX(y: number): number {
    const x = this.x0 + this.amp * dsin(y * this.freq + this.phase) + this.drift * y;
    return clamp(x, -this.W / 2 + 0.55, this.W / 2 - 0.55);
  }

  clampX(x: number): number {
    return clamp(x, -this.W / 2 + 0.22, this.W / 2 - 0.22);
  }

  add(role: HoldRole, type: HoldType, x: number, y: number, size: number, angle: number, color = this.color): HoldDef {
    const prefix = role === 'start' ? 's' : role === 'top' ? 't' : role === 'deco' ? (type === 'volume' ? 'v' : 'd') : role === 'foot' ? (type === 'volume' ? 'v' : 'f') : 'h';
    const key = prefix === 'v' ? 'v' : (prefix as 's' | 'h' | 'f' | 't' | 'd');
    const id = `${prefix}${this.n[key]++}`;
    const h: HoldDef = { id, x: r3(x), y: r3(y), type, size: r3(size), angle: r3(angle), role, color, seed: this.rng.int(1, 0x7fffffff) };
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

  handType(): HoldType {
    return this.rng.weighted(HAND_TYPES, handTypeWeights(this.p.grade, this.p.angle));
  }

  footType(): HoldType {
    const g = this.p.grade;
    const s = Math.max(0, this.p.angle) / 40;
    let w: number[]; // foot, edge, jug, crimp
    if (g <= 2) w = [3, 4.5, 2.5, 0];
    else if (g <= 6) w = [5.5, 3.5, 0.5, 1];
    else w = [7.5, 1.5, 0.2, 1];
    w[0] *= 1 - 0.5 * s;
    w[1] *= 1 + s;
    w[2] *= 1 + 1.2 * s;
    return this.rng.weighted(['foot', 'edge', 'jug', 'crimp'] as const, w);
  }

  /** Classic down-pull angle with grade-dependent jitter. */
  classicAngle(): number {
    return -Math.PI / 2 + this.rng.gauss() * lerp(0.1, 0.3, this.p.t) * 0.6;
  }

  // ── verified route construction ──
  private lab: StanceLab | null = null;
  private slots: (HoldDef | null)[] = [null, null, null, null];
  private pose: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };
  private tmpSeq = 0;
  private topY = 4.15;
  private maxT = 0.6;
  /** Strain the setter aims each move at (see buildRoute). */
  private targetT = 0.45;
  private sinceRest = 0;
  private boost = 1;

  /** A hold that is not part of the wall yet (unique temporary id; renamed when accepted). */
  private temp(role: HoldRole, type: HoldType, x: number, y: number, size: number, angle: number, color = this.color): HoldDef {
    return { id: `~${this.tmpSeq++}`, x: r3(x), y: r3(y), type, size: r3(size), angle: r3(angle), role, color, seed: 0 };
  }

  private accept(h: HoldDef): HoldDef {
    const prefix = h.role === 'start' ? 's' : h.role === 'top' ? 't' : h.type === 'volume' ? 'v' : h.role === 'foot' ? 'f' : 'h';
    h.id = `${prefix}${this.n[prefix as 's' | 'h' | 'f' | 't' | 'v']++}`;
    h.seed = this.rng.int(1, 0x7fffffff);
    this.holds.push(h);
    return h;
  }

  /** Evaluate moving limb li onto h from the current stance (no state change). */
  private evalMove(li: number, h: HoldDef, maxT = this.maxT): { slots: (HoldDef | null)[]; pose: Pose; tension: number } | null {
    const lab = this.lab!;
    const r = lab.reach(this.slots, li, h, this.pose);
    // hard grades may ask for brisk, strenuous moves (the sim's slip clock is slow just past 1.0)
    if (!r.ok || r.tension > Math.max(maxT + lerp(0.12, 0.34, this.p.t), 0.6)) return null;
    const next = this.slots.slice();
    next[li] = h;
    const st = lab.stance(next, r.pose);
    if (!st.ok || st.tension > maxT) return null;
    return { slots: next, pose: st.pose, tension: Math.max(st.tension, r.tension * 0.85) };
  }

  private upgrade(t: HoldType): HoldType {
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

  private handCands(li: number, gains: readonly number[], out: Cand[], footHigh: number, bump = false): void {
    const { rng, p } = this;
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    const other = this.slots[1 - li]!;
    const cur = this.slots[li]!;
    const highY = Math.max(a.y, b.y);
    const side = li === 0 ? -1 : 1;
    const restJug = p.rope && this.sinceRest > 3.3;
    if (!restJug && p.grade >= 4 && gains.length > 3 && rng.chance(p.awkward * 0.22)) {
      const ty = Math.max(cur.y + 0.2, highY - 0.1) + rng.range(0, 0.12);
      const tx = this.clampX(other.x + side * rng.range(0.22, 0.42));
      const type: HoldType = rng.chance(0.5) ? 'edge' : 'pinch';
      out.push({ li, hold: this.temp('hand', type, tx, ty, holdSize(type, p.t, rng), Math.PI / 2 + rng.range(-0.35, 0.35)), fresh: true, maxT: this.maxT });
    }
    for (let k = 0; k < gains.length; k++) {
      const g = gains[k];
      const ty = Math.min(highY + p.gain * g * rng.range(0.9, 1.1), this.topY - 0.18);
      if (ty < cur.y + 0.12) continue;
      if (Math.min(ty, other.y) - footHigh > p.footGap * 1.12) continue;
      let tx = this.lineX(ty) + side * p.lateral * rng.range(0.4, 1.0);
      tx = this.clampX(clamp(tx, other.x - 0.85, other.x + 0.85));
      // hard grades try more same-grade holds before settling for better ones
      const gradeTries = p.grade >= 5 ? 5 : 3;
      const hard = p.grade >= 5;
      let mode: 'jug' | 'better' | 'grade';
      if (restJug) mode = 'jug';
      else if (bump) mode = hard ? 'grade' : 'jug';
      else if (g <= 0.5 || (g <= 0.62 && !hard)) mode = hard ? 'better' : 'jug';
      else mode = k >= gradeTries ? 'better' : 'grade';
      const type: HoldType = mode === 'jug' ? 'jug' : mode === 'better' ? this.upgrade(this.handType()) : this.handType();
      let angle = this.classicAngle();
      if (mode === 'grade' && rng.chance(p.awkward)) {
        // awkward: face the hold toward where the shoulder will be (sidepull / gaston feel)
        const sh = this.lab!.anchor(this.pose, li);
        const ey = sh.y + (ty - cur.y) * 0.55;
        if (Math.abs(tx - sh.x) > 0.16) angle = datan2(ey - ty, sh.x - tx) + rng.range(-0.25, 0.25);
        else angle += rng.range(-0.45, 0.45);
      }
      if (this.gap(tx, ty, 0.07) < 0.03) tx = this.clampX(tx + side * 0.16);
      out.push({ li, hold: this.temp('hand', type, tx, ty, holdSize(type, p.t, rng), angle), fresh: true, maxT: this.maxT });
    }
  }

  private footCands(fi: number, n: number, out: Cand[]): void {
    const { rng, p } = this;
    const cur = this.slots[fi]!;
    const side = fi === 2 ? -1 : 1;
    const lowHand = Math.min(this.slots[0]!.y, this.slots[1]!.y);
    const desired = lowHand - p.footGap * 0.82;
    // reuse a route hold (hand holds make good footholds)
    const reuse = this.holds
      .filter((h) => h.role !== 'deco' && h.role !== 'top' && h.y > cur.y + 0.12 && h.y < this.pose.py - 0.15 && Math.abs(h.y - desired) < 0.32 && h !== this.slots[5 - fi])
      .sort((x, y) => Math.abs(x.y - desired) - Math.abs(y.y - desired))
      .slice(0, 2);
    for (const h of reuse) out.push({ li: fi, hold: h, fresh: false, maxT: this.maxT });
    const rs = [0.84, 0.74, 0.94, 0.66, 1.02, 0.58];
    const dxs = [0.2, 0.3, 0.12, 0.4];
    for (let k = 0; k < n; k++) {
      const fy = lowHand - p.footGap * rs[k % rs.length] * rng.range(0.96, 1.04);
      if (fy < cur.y + 0.1) continue;
      const fx = this.clampX(this.pose.px + side * dxs[k % dxs.length] * rng.range(0.85, 1.15));
      if (this.gap(fx, fy, 0.03) < 0.03) continue;
      const type = this.footType();
      const size = type === 'foot' ? holdSize('foot', p.t, rng) : type === 'jug' ? rng.range(0.07, 0.09) : type === 'crimp' ? 0.035 : rng.range(0.055, 0.075);
      out.push({ li: fi, hold: this.temp('foot', type, fx, fy, size, -Math.PI / 2 + rng.range(-0.3, 0.3)), fresh: true, maxT: this.maxT });
    }
  }

  private topCands(out: Cand[]): void {
    const { rng, p } = this;
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    const low = a.y <= b.y ? 0 : 1;
    const high = this.slots[1 - low]!;
    for (let k = 0; k < 3; k++) {
      const tx = this.clampX(clamp(this.lineX(this.topY) + rng.range(-0.14, 0.14), high.x - 0.55, high.x + 0.55));
      const type: HoldType = p.grade <= 4 || rng.chance(0.55) || k > 0 ? 'jug' : 'edge';
      const size = type === 'jug' ? rng.range(0.095, 0.12) : rng.range(0.075, 0.09);
      const top = this.temp('top', type, tx, this.topY, size, -Math.PI / 2 + rng.range(-0.12, 0.12));
      out.push({ li: k < 2 ? low : 1 - low, hold: top, fresh: true, maxT: Math.max(this.maxT, 0.7) });
    }
  }

  private frame(): Frame {
    const { p } = this;
    const cands: Cand[] = [];
    const a = this.slots[0]!;
    const b = this.slots[1]!;
    const footHigh = Math.max(this.slots[2]!.y, this.slots[3]!.y);
    const lowF = this.slots[2]!.y <= this.slots[3]!.y ? 2 : 3;
    const topOn = a.role === 'top' ? 0 : b.role === 'top' ? 1 : -1;
    if (topOn >= 0) {
      cands.push({ li: 1 - topOn, hold: this.slots[topOn]!, fresh: false, maxT: SOLVER.stanceMax });
      this.footCands(lowF, 4, cands);
      this.footCands(5 - lowF, 2, cands);
    } else {
      const highY = Math.max(a.y, b.y);
      const lowY = Math.min(a.y, b.y);
      if (this.topY - highY <= p.gain * 1.35) this.topCands(cands);
      const lowH = a.y < b.y || (a.y === b.y && this.rng.chance(0.5)) ? 0 : 1;
      const hands: Cand[] = [];
      const gains = p.grade >= 5 ? [1.06 * this.boost, 0.98, 0.92, 0.86, 0.8, 0.74, 0.66, 0.5, 0.38] : [1.06 * this.boost, 0.96, 0.86, 0.86, 0.74, 0.62, 0.5, 0.38];
      this.handCands(lowH, gains, hands, footHigh);
      const feet: Cand[] = [];
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
  }

  /** Sets the route while climbing it (depth-first with backtracking); false when it got stuck. */
  buildRoute(): boolean {
    const { rng, p } = this;
    this.lab = new StanceLab(p.angle);
    this.topY = p.rope ? this.H - 0.75 : this.H - 0.35 + rng.range(-0.05, 0.03);
    this.maxT = lerp(0.52, 0.8, p.t);
    this.targetT = lerp(0.3, 0.78, p.t);
    // ── start holds ──
    const sy = rng.range(1.4, 1.75);
    const sx = this.lineX(sy);
    let L: HoldDef;
    let R: HoldDef;
    if (rng.chance(p.grade <= 6 ? 0.38 : 0.25)) {
      const type: HoldType = p.grade <= 3 || rng.chance(0.5) ? 'jug' : 'edge';
      L = R = this.accept(this.temp('start', type, sx, sy, type === 'jug' ? rng.range(0.095, 0.12) : rng.range(0.075, 0.09), -Math.PI / 2 + rng.range(-0.12, 0.12)));
    } else {
      const dx = rng.range(0.14, 0.3);
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
      const type = k < 5 ? this.footType() : 'edge';
      const sz = (t: HoldType): number => (t === 'foot' ? holdSize('foot', p.t, rng) : t === 'jug' ? 0.08 : t === 'crimp' ? 0.035 : 0.065);
      const fl = this.temp('foot', type, this.clampX(cx - rng.range(0.16, 0.32)), fy1, sz(type), -Math.PI / 2 + rng.range(-0.25, 0.25));
      const fr = this.temp('foot', type, this.clampX(cx + rng.range(0.16, 0.32)), fy2, sz(type), -Math.PI / 2 + rng.range(-0.25, 0.25));
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
    let budget = p.rope ? 2400 : 650;
    const stack: Frame[] = [this.frame()];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const a = this.slots[0]!;
      const b = this.slots[1]!;
      if (a.role === 'top' && b === a) {
        this.top = a;
        return true;
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
      const r0 = this.evalMove(first.li, first.hold, first.maxT);
      if (!r0) continue;
      let c = first;
      let r = r0;
      if (first.fresh && first.hold.role !== 'top') {
        let bestErr = Math.abs(r0.tension - this.targetT);
        for (let k = top.idx, seen = 0; k < top.cands.length && seen < 3 && budget > 0; k++) {
          const alt = top.cands[k];
          if (alt.li !== first.li || !alt.fresh || alt.hold.role === 'top') continue;
          seen++;
          budget--;
          const ra = this.evalMove(alt.li, alt.hold, alt.maxT);
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
      if (c.fresh) this.accept(c.hold);
      if (c.li < 2 && c.fresh) {
        if (c.hold.angle > 0.5) this.boost = 1.12;
        if (p.rope) this.sinceRest = c.hold.type === 'jug' ? 0 : this.sinceRest + p.gain * 0.5;
      }
      stack.push(this.frame());
    }
    return false;
  }

  /** Extra footholds around the line (fewer on hard problems). */
  buildExtraFeet(): void {
    const { rng, p } = this;
    const topY = this.top ? this.top.y : this.H - 0.35;
    const extra = Math.round(lerp(p.rope ? 9 : 5, p.rope ? 3 : 1, p.t) * rng.range(0.7, 1.3));
    for (let k = 0; k < extra; k++) {
      const y = rng.range(0.35, topY - 1.0);
      const x = this.clampX(this.lineX(y) + rng.range(-0.45, 0.45));
      if (this.gap(x, y, 0.03) < 0.1) continue;
      this.add('foot', this.footType() === 'jug' ? 'edge' : 'foot', x, y, holdSize('foot', p.t, rng) + (rng.chance(0.3) ? 0.025 : 0), -Math.PI / 2 + rng.range(-0.3, 0.3));
    }
  }

  buildQuickdraws(): void {
    const { rng } = this;
    const top = this.top!;
    let y = rng.range(1.9, 2.2);
    let side = rng.chance(0.5) ? -1 : 1;
    let i = 0;
    // The bolt stays off the holds, and the carabiner (where the hand clips) stays clear of every
    // route hold, so releasing a hand on a hold never has to choose between grabbing and clipping.
    const clear = (x: number, y: number): boolean => this.gap(x, y, 0.05) >= 0.05 && this.gap(x, y - SIM.quickdrawDrop, CLIP_CLEARANCE) >= 0;
    while (y < top.y - 0.9) {
      const x0 = this.clampX(this.lineX(y) + side * rng.range(0.15, 0.35));
      let x = x0;
      if (!clear(x, y)) {
        x = this.clampX(x0 + side * 0.15);
        for (const dx of [0.15, 0.3, -0.15, 0.45]) {
          const cx = this.clampX(x0 + side * dx);
          if (clear(cx, y)) {
            x = cx;
            break;
          }
        }
      }
      this.draws.push({ id: `q${i++}`, x: r3(x), y: r3(y) });
      y += rng.range(1.4, 2.0);
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
        if (route) this.add('foot', 'volume', x, y, size, -Math.PI / 2 + rng.range(-0.2, 0.2));
        else this.add('deco', 'volume', x, y, size, -Math.PI / 2 + rng.range(-0.4, 0.4), rng.pick(WALL.volumeColors));
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
        this.add('deco', type, x, y, size, -Math.PI / 2 + rng.gauss() * 0.45, color);
        placed++;
      }
    }
  }
}

function paramsFor(grade: number, angle: number, rope: boolean, ease: number): Params {
  const g = clamp(Math.round(grade), 0, 12);
  const t = g / 12;
  return {
    grade: g,
    t,
    angle,
    gain: lerp(0.36, 0.62, t) * (1 - 0.06 * ease) * (rope ? 0.95 : 1),
    lateral: lerp(0.17, 0.38, t),
    footGap: lerp(1.18, 1.48, t) - 0.08 * ease,
    awkward: lerp(0.0, 0.45, t) * (1 - 0.4 * ease),
    rope,
  };
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

function assemble(
  opts: GenerateOptions,
  rope: boolean,
  b: Builder,
  grade: number,
  angle: number,
  name: string,
  seed: number,
): BoulderDef {
  const wall = rope ? GAME.ropeWall : GAME.boulderWall;
  const def: BoulderDef = {
    id: `${rope ? 'r' : 'b'}-${(seed >>> 0).toString(36)}-${grade}`,
    name,
    grade,
    mode: rope ? 'rope' : 'boulder',
    wallAngle: angle,
    width: wall.width,
    height: wall.height,
    holds: b.holds,
    color: b.color,
    seed: seed >>> 0,
    startFeet: { ...b.startFeet },
  };
  if (rope) def.quickdraws = b.draws;
  void opts;
  return def;
}

/** A plain ladder that is always climbable: the generator's last resort. */
function ladder(opts: GenerateOptions, rope: boolean, color: string, name: string, seed: number): BoulderDef {
  const rng = new Rng(seed ^ 0x1add3);
  const p = paramsFor(0, 0, rope, 1);
  const b = new Builder(rng, p, color);
  const wall = rope ? GAME.ropeWall : GAME.boulderWall;
  const topY = rope ? wall.height - 0.75 : wall.height - 0.35;
  const cx = rng.range(-0.6, 0.6);
  const a = b.add('start', 'jug', cx - 0.2, 1.5, 0.1, -Math.PI / 2);
  const c = b.add('start', 'jug', cx + 0.2, 1.5, 0.1, -Math.PI / 2);
  void a;
  void c;
  const fl = b.add('foot', 'jug', cx - 0.22, 0.42, 0.08, -Math.PI / 2);
  const fr = b.add('foot', 'jug', cx + 0.22, 0.42, 0.08, -Math.PI / 2);
  b.startFeet = { LF: fl.id, RF: fr.id };
  let side = 1;
  for (let y = 1.86; y < topY - 0.3; y += 0.36) {
    b.add('hand', 'jug', cx + side * 0.2, y, 0.1, -Math.PI / 2);
    side = -side;
  }
  for (let y = 0.78; y < topY - 1.15; y += 0.36) {
    b.add('foot', 'jug', cx + side * 0.22, y, 0.08, -Math.PI / 2);
    side = -side;
  }
  b.top = b.add('top', 'jug', cx, topY, 0.11, -Math.PI / 2);
  if (rope) b.buildQuickdraws();
  b.buildDeco();
  return assemble(opts, rope, b, 0, 0, name, seed);
}

/** Minimum hand moves for a problem to feel like a problem. */
function interesting(plan: PlanResult, rope: boolean): boolean {
  let hands = 0;
  for (const m of plan.moves) if (m.limb === 'LH' || m.limb === 'RH') hands++;
  return hands >= (rope ? 12 : 4);
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
  let angle = opts.wallAngle ?? pickAngle(grade, rope, rng.fork(0xa9));
  if (ease && opts.wallAngle === undefined) angle = Math.min(angle, rope ? 10 : 20);
  angle = clamp(angle, -15, 45);
  const b = new Builder(rng, paramsFor(grade, angle, rope, ease), color);
  if (!b.buildRoute()) return null;
  b.buildExtraFeet();
  if (rope) b.buildQuickdraws();
  b.buildVolumes();
  b.buildDeco();
  return assemble(opts, rope, b, grade, angle, name, seed);
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
    if (plan && interesting(plan, rope) && (!rope || plan.clipsPlanned === (def.quickdraws?.length ?? 0))) return def;
  }
  const seed = (Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 1) >>> 0;
  const base = new Rng(seed);
  const name = opts.name ?? routeName(base.fork(0x5a17));
  const color = routeColor(opts, base.fork(0xc010));
  return ladder(o, rope, color, name, seed);
}

// ═══════════════════════════════ public API ═══════════════════════════════

/** Randomized boulder problem (4.6 × 4.5 m CHIRAL wall). Deterministic per seed + grade. */
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

/** One seeded problem per UTC day, identical for every player. */
export function dailyBoulder(dateKey: string): BoulderDef {
  const seed = hashString(`chiral-daily:${dateKey}`);
  const b = generateBoulder({ seed, grade: dailyGrade(dateKey), mode: 'boulder' });
  return { ...b, id: `daily-${dateKey}` };
}

// ═══════════════════════════════ tutorial ═══════════════════════════════

export type TutorialTeach = 'hand' | 'foot' | 'hips' | 'shake' | 'match';

export interface TutorialStep {
  limb: LimbId;
  holdId: string;
  teach: TutorialTeach;
}

const TUT = '#FF4F1F';
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
 * Steini's hand-authored lesson: a friendly vertical problem on big orange jugs. Laid out against the
 * anatomical reach envelopes (anatomy.ts): with the climber's natural reach every scripted move ends
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
    tutHold('tut-hand-3', 0.965, 2.68, 'edge', 0.075, 'hand', -170, 19),
    tutHold('tut-foot-4', 0.43, 1.47, 'jug', 0.085, 'foot', -90, 20),
    tutHold('tut-hand-4', 0.11, 3.04, 'jug', 0.11, 'hand', -90, 21),
    tutHold('tut-foot-5', -0.09, 1.83, 'jug', 0.085, 'foot', -90, 22),
    tutHold('tut-top', 0.36, 3.61, 'jug', 0.12, 'top', -90, 23),
    tutHold('tut-foot-6', 0.56, 2.08, 'jug', 0.085, 'foot', -90, 24),
  ];
  const rng = new Rng(0x57e1);
  const b = new Builder(rng, paramsFor(0, 0, false, 1), TUT);
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

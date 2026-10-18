// Beta planner: best-first search over limb moves, judged by the same static equilibrium model the
// sim uses (statics.ts). A move is legal when the three remaining limbs can hold a body position from
// which the moving limb reaches its target (tension under SOLVER.moveMax) and the new four-limb
// stance settles under SOLVER.stanceMax. Targets must also be anatomically legal: inside the limb's
// reach envelope (anatomy.ts, via the pose search) and clear of the other limbs (holds.placementBlocked,
// checked at the reach pose with a little extra margin so the sim never refuses a planned move).
// Search budgets are node counts (deterministic). Interactive calls may add a wall-clock cap, but it
// never ends a search before SOLVER.minNodes expansions, so a slow phone gets exactly the answer a
// fast desktop gets for every problem solvable within that many expansions (generated problems
// need ~35 at the median). The search evaluates children lazily (see expand()). It is weighted A*
// that turns greedier when a search runs long (SOLVER.greedAfter) and on multi-angle walls, so the
// long tail (hard traverses, caves, V10+ compression) stays near ~200 expansions.
// Hot-path numbers: ~30 ms median per generated boulder on a desktop core (every archetype, profiles
// on or off), p90 ≈ 100 ms.

import type { BoulderDef, HoldDef, LimbId, QuickdrawDef, Vec2, WallPanel } from '../core/types';
import type { BetaMove, ClimberSimAPI } from '../core/contracts';
import { BODY, GAME, SIM } from '../config/tuning';
import { clamp } from '../core/math';
import {
  canMatch,
  clipPoint,
  contactPoint,
  footModeFor,
  LIMB_IDS,
  LIMB_INDEX,
  maxReachIdx,
  mountsByVolume,
  nominalCapacity,
  placementBlocked,
  startPlacement,
  topHolds,
  usableByFoot,
  usableByHand,
  volumeYields,
} from './holds';
import {
  computeAnchors,
  evaluateStance,
  FOOT_DROP,
  FOOT_HEEL,
  FOOT_PUSH,
  FOOT_TOE,
  initialPose,
  makeParams,
  newContact,
  optimizePose,
  setContact,
  setSmear,
  StanceEval,
  type Contact,
  type Contacts,
  type Pose,
  type StaticsParams,
} from './statics';
import { dhypot } from './dmath';
import { envEvalOn } from './anatomy';
import { angleAt, makeProfile, profileOf, smoothAngleAt, type WallProfile } from './wall-profile';

/** Planner thresholds. The sim slips only above stress 1.05, so these leave a margin. */
export const SOLVER = {
  stanceMax: 0.82,
  /**
   * Three-limb tension allowed while a limb moves. Above ~1.05 the slip clock runs, but slowly
   * (≈5 s at 1.15), so hard moves are possible when done briskly — the climber shakes through them.
   */
  moveMax: 1.12,
  /**
   * Three-limb tension allowed while a hand clips a quickdraw. The hand is busy for GAME.clipTime on
   * top of the reach, so a clip stance keeps a clear margin under the slip threshold (1.05): a few
   * centimetres of difference between the planned and the live body must not turn it into a slip.
   */
  clipMax: 0.9,
  /** A clip stance this calm is taken at once; a more strenuous one looks up to clipLookahead moves ahead. */
  clipCalm: 0.62,
  clipLookahead: 2,
  /**
   * Forearm pump assumed while planning (capacity margin): pumpCapFactor(0.52) ≈ 0.971, the same
   * margin the planner had before the per-forearm model (1 − 0.32·0.3²).
   */
  pump: 0.52,
  /** Weighted A*: f = g + heuristicWeight · h. */
  heuristicWeight: 2.4,
  /**
   * The same on a multi-angle wall: a greedier search. Profiled stances cost ≈2× a flat one and steep
   * panels branch much more (caves needed ≈300 expansions at 2.4), so the search commits sooner:
   * ≈55 % fewer expansions over every archetype for ≈2 % more strain per move (no lost solutions).
   */
  heuristicWeightProfile: 3.5,
  /**
   * A search still open after `greedAfter` expansions turns greedier (heuristicWeightGreedy): the
   * typical problem (≈35 expansions) keeps its calm beta, the long tail (hard traverses, caves,
   * compression at V10+) commits sooner instead of running into the budget. Deterministic (counts).
   */
  greedAfter: 80,
  heuristicWeightGreedy: 4.5,
  maxNodesBoulder: 700,
  maxNodesRope: 2600,
  /**
   * A wall-clock cap (PlanOptions.maxMs) only applies after this many expansions: results are then
   * device-independent for every problem solvable within it (generated boulders: p99 ≈ 170).
   */
  minNodes: 320,
  /** Candidate targets kept per limb per expansion. */
  candidatesPerLimb: 7,
  // ── deadpoints + dynos (planned only for style 'dyno' problems or PlanOptions.dynos; research §2.5) ──
  /** Extra cost of a thrown move: a static beta is preferred whenever one exists. */
  dynoCost: 3,
  /** A throw is planned only to holds at least this good (nominal hand capacity, BW). */
  dynoMinCap: 0.5,
  /** The launch speed a throw needs must stay under this fraction of what the climber can produce. */
  dynoSpeedMargin: 0.8,
  /** The catch's peak stress must stay under this fraction of SIM.dynoCatchStress. */
  dynoCatchMargin: 0.85,
  /** Tension allowed right after a catch (feet cut: the climber puts them back at once). */
  dynoLandMax: 0.98,
} as const;

/** Extra clearance (m) the planner keeps beyond the sim's self-clipping limits. */
const PLAN_CLEARANCE_MARGIN = 0.015;

/** holdId used in a beta for a foot smeared on blank wall. */
export const SMEAR_ID = 'smear';

export interface PlanOptions {
  /**
   * Wall-clock safety cap (ms) for interactive calls; it never stops a search before `minNodes`
   * expansions, so results stay device-independent. Default: none with an explicit maxNodes,
   * else 120.
   */
  maxMs?: number;
  /** Deterministic expansion budget (default SOLVER.maxNodesBoulder / maxNodesRope). */
  maxNodes?: number;
  /** Expansions guaranteed before maxMs may end the search (default SOLVER.minNodes). */
  minNodes?: number;
  assist?: number;
  /** Start stance (hold ids per limb, null = free / smear). Defaults to the boulder's start placement. */
  start?: (string | null)[];
  /** Start pose hint (pelvis, chest) for planning from a live sim. */
  startPose?: Pose;
  /** Rope: quickdraw ids already clipped (only the anchor matters for the goal). */
  clipped?: readonly string[];
  /** Plan deadpoints / dynos too (default: only on problems of style 'dyno'). */
  dynos?: boolean;
  /**
   * Moves NOT to start with (from the start stance): a live climber that just missed one of them
   * (the bot, a hint after a failed move) gets a different first move when one exists.
   */
  avoid?: readonly { limb: LimbId; holdId: string }[];
}

export interface PlanStep {
  move: BetaMove;
  /** Tension of the three-limb stance while the limb moves. */
  moveTension: number;
  /** Settled tension of the new stance. */
  tension: number;
  /** Distance the limb travels (m). */
  distance: number;
  /** Body pose after the move (pelvis + chest). */
  pose: Pose;
  /** Pose the climber should be in while reaching. */
  reachPose: Pose;
  /** Smear point when move.holdId === SMEAR_ID. */
  smear?: Vec2;
  /** Rope: clip this quickdraw right after the move (verified: the other three limbs hold). */
  clip?: { quickdrawId: string; limb: LimbId; reachPose: Pose; tension: number };
  /**
   * A thrown move (move.dyno is set): launched from `reachPose` (the stance before), caught near the
   * apex. `cut` are the limbs that come off in the flight (feet of a dyno, the other hand when it can't
   * stay); the next steps put them back.
   */
  dyno?: { limbs: 'LH' | 'RH' | 'both'; kind: 'deadpoint' | 'dyno'; power: number; rise: number; speed: number; vmax: number; peakStress: number; cut: LimbId[] };
}

export interface PlanResult {
  moves: BetaMove[];
  steps: PlanStep[];
  /** Rope: quickdraws with a verified clip somewhere along the beta (anchor included). */
  clipsPlanned?: number;
  startTension: number;
  startPose: Pose;
  nodes: number;
  ms: number;
}

type Slot = HoldDef | 'smear' | null;

/** A throw the planner considers (planned with the sim's launch model, ClimberSim.throwPlan). */
interface DynoMove {
  hands: number[];
  kind: 'deadpoint' | 'dyno';
  limbs: 'LH' | 'RH' | 'both';
  vx: number;
  vy: number;
  /** Rigid body shift launch → apex. */
  sx: number;
  sy: number;
  rise: number;
  speed: number;
  vmax: number;
  /** Limbs that come off in the flight. */
  cut: number[];
}

/** Planner node behind each step (for post-processing such as clip planning). */
const STEP_NODE = new WeakMap<PlanStep, Node>();

interface Node {
  slots: Slot[];
  sx: number[];
  sy: number[];
  key: string;
  pose: Pose;
  tension: number;
  g: number;
  f: number;
  parent: Node | null;
  step: PlanStep | null;
  depth: number;
  /**
   * Lazy child (deferred evaluation): the move that leads here from `parent`, not yet checked. Its
   * g / f are optimistic lower bounds until the search pops it and evaluates the reach + stance.
   */
  move: LazyMove | null;
  /**
   * Right after a caught throw (feet cut, or still strenuous): the next moves may end in stances up to
   * SOLVER.dynoLandMax while the climber gets the cut limbs back on.
   */
  transient?: boolean;
}

interface LazyMove {
  li: number;
  hold: HoldDef | null;
  /** Target contact point. */
  tx: number;
  ty: number;
  /** Where the limb comes from (distance of the move). */
  fromX: number;
  fromY: number;
  reachKey: string;
  /** A thrown move (deadpoint / dyno) instead of a static reach. */
  dyno?: DynoMove;
}

class Heap {
  private a: Node[] = [];
  get size(): number {
    return this.a.length;
  }
  push(n: Node): void {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      this.down(0);
    }
    return top;
  }
  /** Scale every queued node's heuristic share (f − g) by k and restore the heap order. */
  reweight(k: number): void {
    const a = this.a;
    for (const n of a) n.f = n.g + (n.f - n.g) * k;
    for (let i = (a.length >> 1) - 1; i >= 0; i--) this.down(i);
  }
  private down(i: number): void {
    const a = this.a;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && a[l].f < a[m].f) m = l;
      if (r < a.length && a[r].f < a[m].f) m = r;
      if (m === i) break;
      [a[m], a[i]] = [a[i], a[m]];
      i = m;
    }
  }
}

const slotId = (s: Slot): string => (s === null ? '-' : s === 'smear' ? '~' : s.id);

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Search state for one boulder. */
class Planner {
  readonly b: BoulderDef;
  readonly prm: StaticsParams;
  readonly reachPrm: StaticsParams;
  readonly ev = new StanceEval();
  readonly handHolds: HoldDef[];
  readonly footHolds: HoldDef[];
  readonly topIds: Set<string>;
  readonly topY: number;
  /** Some panel of the wall takes a smear (≤ SIM.smearMaxAngle). */
  readonly smearOk: boolean;
  readonly anchor: QuickdrawDef | null;
  /** Folded wall (wall-profile.ts), null for a flat one. */
  readonly prof: WallProfile | null;
  /** Plan deadpoints / dynos (style 'dyno' problems, or PlanOptions.dynos). */
  dynos = false;
  /**
   * Traverse: the top is far to the side of the start, so progress is measured as the distance to the
   * top (not just height). Weight of the horizontal distance in the heuristic (0 = height only).
   */
  lateral = 0;
  topX = 0;
  private readonly contactObjs: Contact[] = [newContact(), newContact(), newContact(), newContact()];
  private readonly contacts: Contacts = [null, null, null, null];
  private readonly stanceCache = new Map<string, { pose: Pose; tension: number; violation: number; cth: number; sth: number }>();
  private readonly reachCache = new Map<string, { pose: Pose; tension: number; ok: boolean }>();
  private readonly tmpPose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
  private readonly tmpV = { x: 0, y: 0 };
  private readonly AX = new Float64Array(4);
  private readonly AY = new Float64Array(4);
  private readonly tmpC = { x: 0, y: 0 };

  /** Heuristic weight of this wall (SOLVER.heuristicWeight / heuristicWeightProfile), and the live one of a search. */
  readonly baseHw: number;
  hw: number;

  constructor(b: BoulderDef, assist: number, prof: WallProfile | null = profileOf(b)) {
    this.b = b;
    this.prof = prof && !prof.flat ? prof : null;
    this.baseHw = this.prof ? SOLVER.heuristicWeightProfile : SOLVER.heuristicWeight;
    this.hw = this.baseHw;
    this.prm = makeParams(b.wallAngle, assist, SOLVER.pump, this.prof);
    this.reachPrm = makeParams(b.wallAngle, assist, SOLVER.pump, this.prof);
    this.handHolds = b.holds.filter(usableByHand);
    this.footHolds = b.holds.filter(usableByFoot);
    this.mounts = mountsByVolume(b.holds);
    const tops = topHolds(b);
    this.topIds = new Set(tops.map((h) => h.id));
    this.topY = tops.length ? Math.max(...tops.map((h) => h.y)) : b.height - 0.35;
    this.topX = tops.length ? tops.reduce((a, h) => a + h.x, 0) / tops.length : 0;
    this.dynos = b.style === 'dyno';
    // a traverse: the top well off to the side of the start holds
    const starts = b.holds.filter((h) => h.role === 'start' && usableByHand(h));
    if (starts.length && tops.length) {
      const sx = starts.reduce((a, h) => a + h.x, 0) / starts.length;
      if (Math.abs(this.topX - sx) > 1.4) this.lateral = 1;
    }
    this.smearOk = this.prof ? this.prof.minAngle <= SIM.smearMaxAngle : b.wallAngle <= SIM.smearMaxAngle;
    const q = b.mode === 'rope' ? b.quickdraws ?? [] : [];
    this.anchor = q.length ? q[q.length - 1] : null;
  }

  /** PlanOptions.avoid: the root's key and the "limbIndex|holdId" moves it must not start with. */
  avoidKey: string | null = null;
  avoid: Set<string> | null = null;

  /** Holds bolted onto route volumes (the sim's snap rule, holds.volumeYields). */
  private readonly mounts: Map<string, HoldDef[]> | null;
  private readonly shadow = new Map<string, boolean>();

  /**
   * Would a limb released on hold h's grip point snap onto ANOTHER hold (the sim's snapCandidate picks
   * the hold whose edge is nearest — a big volume or jug right next to h wins)? Such a target is left out:
   * the planned move would grab the wrong hold. Conservative (ignores reach), cached per hold.
   */
  private shadowed(h: HoldDef, li: number, matched: boolean, cp: { x: number; y: number }): boolean {
    const hand = li < 2;
    const key = `${h.id}|${hand ? 'h' : 'f'}${matched ? 'm' : ''}${li & 1}`;
    const hit = this.shadow.get(key);
    if (hit !== undefined) return hit;
    let best: HoldDef | null = null;
    let bestD = Infinity;
    for (const o of hand ? this.handHolds : this.footHolds) {
      const d = dhypot(cp.x - o.x, cp.y - o.y) - o.size;
      if (d > GAME.snapRadius || d >= bestD) continue;
      if (!hand && volumeYields(o, cp.x, cp.y, this.mounts)) continue;
      best = o;
      bestD = d;
    }
    const out = best !== null && best !== h;
    this.shadow.set(key, out);
    return out;
  }

  /** A usable foothold within the sim's snap radius of (x, y): a foot released there grabs it, it doesn't smear. */
  nearFoothold(x: number, y: number): boolean {
    for (const h of this.footHolds) if (dhypot(h.x - x, h.y - y) - h.size <= GAME.snapRadius) return true;
    return false;
  }

  /** Wall angle (degrees) of the panel at surface height y. */
  angleOf(y: number): number {
    return this.prof ? angleAt(this.prof, y) : this.b.wallAngle;
  }

  /** Can a foot smear at surface height y (its panel ≤ SIM.smearMaxAngle)? */
  smearAt(y: number): boolean {
    return this.prof ? angleAt(this.prof, y) <= SIM.smearMaxAngle : this.smearOk;
  }

  /** Would the feet's modes at `pose` differ from the ones the contacts carry? */
  private footModesChange(contacts: Contacts, pose: Pose): boolean {
    const prof = this.prof;
    computeAnchors(pose, this.AX, this.AY);
    const comY = pose.py + BODY.comT * (pose.cy - pose.py);
    const bodyAngle = prof ? smoothAngleAt(prof, comY) : this.b.wallAngle;
    for (let i = 2; i < 4; i++) {
      const c = contacts[i];
      if (!c || !c.hold) continue;
      const wall = prof ? Math.max(angleAt(prof, c.y), bodyAngle) : bodyAngle;
      const m = footModeFor(c.hold, c.x, c.y, this.AX[i], this.AY[i], pose.px, wall, null);
      const mode = m === 'heel' ? FOOT_HEEL : m === 'toe' ? FOOT_TOE : m === 'drop' ? FOOT_DROP : FOOT_PUSH;
      if (mode !== c.mode) return true;
    }
    return false;
  }

  /**
   * Feet on holds get the technique the live climber would use there (holds.footModeFor, the sim's rule)
   * for the body in `pose`: hooks on roofs pull instead of pushing, a foot at hip height out to the side
   * of a steep flat wall heel-hooks, a sidepull foothold drops the knee. (Flat walls used to plan pushing
   * feet only, so a stance the sim turned into a weak heel hook could slip where the plan stood calm.)
   */
  applyFootModes(contacts: Contacts, pose: Pose): void {
    const prof = this.prof;
    computeAnchors(pose, this.AX, this.AY);
    const comY = pose.py + BODY.comT * (pose.cy - pose.py);
    const bodyAngle = prof ? smoothAngleAt(prof, comY) : this.b.wallAngle;
    for (let i = 2; i < 4; i++) {
      const c = contacts[i];
      if (!c || !c.hold) continue;
      const wall = prof ? Math.max(angleAt(prof, c.y), bodyAngle) : bodyAngle;
      const m = footModeFor(c.hold, c.x, c.y, this.AX[i], this.AY[i], pose.px, wall, null);
      c.mode = m === 'heel' ? FOOT_HEEL : m === 'toe' ? FOOT_TOE : m === 'drop' ? FOOT_DROP : FOOT_PUSH;
    }
  }

  /** Fill this.contacts for a node's slots, optionally without limb `skip`. */
  setContacts(n: { slots: Slot[]; sx: number[]; sy: number[] }, skip: number): Contacts {
    for (let i = 0; i < 4; i++) {
      const s = n.slots[i];
      if (i === skip || s === null) {
        this.contacts[i] = null;
        continue;
      }
      const c = this.contactObjs[i];
      if (s === 'smear') setSmear(c, n.sx[i], n.sy[i]);
      else {
        const pair = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 3 : 2;
        setContact(c, s, i, pair !== skip && n.slots[pair] === s);
      }
      this.contacts[i] = c;
    }
    return this.contacts;
  }

  /** Best settled pose of a full stance (cached). */
  stance(n: { slots: Slot[]; sx: number[]; sy: number[]; key: string }, seed: Pose | null): { pose: Pose; tension: number; violation: number; cth: number; sth: number } {
    const hit = this.stanceCache.get(n.key);
    if (hit) return hit;
    const contacts = this.setContacts(n, -1);
    this.prm.reachLimb = -1;
    const init = seed ?? initialPose(contacts, this.prm, this.tmpPose);
    this.applyFootModes(contacts, init);
    const pose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
    let r = seed ? optimizePose(contacts, this.prm, init, pose, this.ev, 44, true) : optimizePose(contacts, this.prm, init, pose, this.ev, 90);
    // the sim infers each foot's mode from where the body SETTLES: when the settled pose turns a toe hook
    // into a plain edge (or an edge into a heel hook), judge the stance with the modes the sim will use
    if (this.footModesChange(contacts, pose)) {
      this.applyFootModes(contacts, pose);
      const p2: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
      const r2 = optimizePose(contacts, this.prm, pose, p2, this.ev, 44, true);
      // keep the result only when the modes hold at the new pose too (no flip-flopping between two)
      if (!this.footModesChange(contacts, p2)) {
        r = r2;
        pose.px = p2.px;
        pose.py = p2.py;
        pose.cx = p2.cx;
        pose.cy = p2.cy;
      } else r = { cost: r2.cost, tension: Math.max(r.tension, r2.tension), violation: Math.max(r.violation, r2.violation) };
    }
    const out = { pose, tension: r.tension, violation: r.violation, cth: this.ev.cth, sth: this.ev.sth };
    this.stanceCache.set(n.key, out);
    return out;
  }

  /** Can limb `li` reach point (tx, ty) while the other three hold? */
  reach(n: Node, li: number, tx: number, ty: number, cacheKey: string): { pose: Pose; tension: number; ok: boolean } {
    const hit = this.reachCache.get(cacheKey);
    if (hit) return hit;
    const contacts = this.setContacts(n, li);
    this.applyFootModes(contacts, n.pose);
    const prm = this.reachPrm;
    prm.reachLimb = li;
    prm.reachX = tx;
    prm.reachY = ty;
    const pose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
    const r = optimizePose(contacts, prm, n.pose, pose, this.ev, 48, true);
    const out = { pose, tension: r.tension, ok: r.violation < 0.004 && r.tension <= SOLVER.moveMax };
    this.reachCache.set(cacheKey, out);
    return out;
  }

  /** Intermediate goal for staged planning: both hands at or above this height (null = the top). */
  goalY: number | null = null;

  heuristic(slots: Slot[]): number {
    let h = 0;
    const target = this.goalY ?? this.topY;
    if (this.lateral > 0 && this.goalY === null) return this.lateralHeuristic(slots);
    for (let i = 0; i < 2; i++) {
      const s = slots[i];
      const y = s && s !== 'smear' ? s.y : target - 2;
      if (this.goalY !== null) h += Math.max(0, (target - y) / 0.32);
      else if (!(s && s !== 'smear' && this.topIds.has(s.id))) h += Math.max(0.5, (target - y) / 0.32 + 0.5);
    }
    // feet should follow the hands
    let fy = -Infinity;
    for (let i = 2; i < 4; i++) {
      const s = slots[i];
      if (s && s !== 'smear') fy = Math.max(fy, s.y);
    }
    if (Number.isFinite(fy)) h += Math.max(0, target - 1.45 - fy) / 0.6;
    return h;
  }

  /** Traverse heuristic: hand moves left ≈ distance to the top; the feet follow the hands sideways. */
  lateralHeuristic(slots: Slot[]): number {
    let h = 0;
    let hx = 0;
    let nh = 0;
    for (let i = 0; i < 2; i++) {
      const s = slots[i];
      if (s && s !== 'smear') {
        hx += s.x;
        nh++;
        if (this.topIds.has(s.id)) continue;
        h += Math.max(0.5, dhypot(this.topX - s.x, this.topY - s.y) / 0.34 + 0.5);
      } else h += 6;
    }
    let fx = 0;
    let fy = -Infinity;
    let nf = 0;
    for (let i = 2; i < 4; i++) {
      const s = slots[i];
      if (s && s !== 'smear') {
        fx += s.x;
        fy = Math.max(fy, s.y);
        nf++;
      }
    }
    if (nf && nh) h += Math.max(0, Math.abs(fx / nf - hx / nh) - 0.45) / 0.6 + Math.max(0, this.topY - 1.45 - fy) / 0.6;
    return h;
  }

  isGoal(n: Node): boolean {
    const a = n.slots[0];
    const b = n.slots[1];
    if (!a || !b || a === 'smear' || b === 'smear') return false;
    if (this.goalY !== null) return Math.min(a.y, b.y) >= this.goalY;
    if (!this.topIds.has(a.id) || !this.topIds.has(b.id)) return false;
    if (!this.anchor) return true;
    // Rope: one hand must be able to clip the anchor while the other three limbs hold.
    const cp = clipPoint(this.anchor, this.tmpV);
    const cx = cp.x;
    const cy = cp.y;
    for (let li = 0; li < 2; li++) {
      const r = this.reach(n, li, cx, cy, `${n.key}>clip${li}`);
      if (r.ok && r.tension <= SOLVER.clipMax) return true;
    }
    return false;
  }

  makeNode(slots: Slot[], sx: number[], sy: number[], parent: Node | null, step: PlanStep | null, seed: Pose | null): Node | null {
    const key = slots.map(slotId).join('|');
    const tmp = { slots, sx, sy, key };
    const st = this.stance(tmp, seed);
    if (st.violation > 0.004 || st.tension > SOLVER.stanceMax) return null;
    const mt = step ? step.moveTension : 0;
    const g = parent ? parent.g + this.moveCost(st.tension, mt) : 0;
    return {
      slots,
      sx,
      sy,
      key,
      pose: st.pose,
      tension: st.tension,
      g,
      f: g + this.hw * this.heuristic(slots),
      parent,
      step,
      depth: parent ? parent.depth + 1 : 0,
      move: null,
    };
  }

  /** Cost of a move + the stance it ends in (the g increment of a child). */
  moveCost(stanceT: number, moveT: number): number {
    // tension is costly, and strenuous moves much more so: prefer the smooth beta when one exists
    return 1 + 0.8 * stanceT + 0.6 * moveT + 5 * Math.max(0, moveT - 0.68) + 5 * Math.max(0, stanceT - 0.58);
  }

  /**
   * Evaluate a lazy child in place: can its limb reach the target while the other three hold, and
   * does the new stance settle? Fills pose / tension / step / g / f; false when the move is illegal.
   */
  evaluate(n: Node): boolean {
    const m = n.move!;
    const parent = n.parent!;
    n.move = null;
    if (m.dyno) return this.evaluateDyno(n, m, m.dyno);
    const r = this.reach(parent, m.li, m.tx, m.ty, m.reachKey);
    if (!r.ok) return false;
    // the sim checks self-clipping where the limb is released, i.e. around the reach pose
    if (!this.clearAt(r.pose, parent, m.li, m.hold, m.tx, m.ty)) return false;
    const st = this.stance(n, r.pose);
    // right after a caught throw the climber may pass through strenuous stances while the cut limbs go back on
    const limit = parent.transient ? SOLVER.dynoLandMax : SOLVER.stanceMax;
    if (st.violation > 0.004 || st.tension > limit) return false;
    n.transient = !!parent.transient && (st.tension > SOLVER.stanceMax || !n.slots[2] || !n.slots[3]);
    const step: PlanStep = {
      move: { limb: LIMB_IDS[m.li], holdId: m.hold ? m.hold.id : SMEAR_ID },
      moveTension: r.tension,
      tension: st.tension,
      distance: dhypot(m.tx - m.fromX, m.ty - m.fromY),
      pose: st.pose,
      reachPose: r.pose,
      smear: m.hold ? undefined : { x: n.sx[m.li], y: n.sy[m.li] },
    };
    n.pose = st.pose;
    n.tension = st.tension;
    n.step = step;
    n.g = parent.g + this.moveCost(st.tension, r.tension);
    n.f = n.g + this.hw * this.heuristic(n.slots);
    STEP_NODE.set(step, n);
    return true;
  }

  private readonly apexPose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };

  /**
   * A thrown move from n (ClimberSim.throwPlan / launch, same model): the body shift that brings each
   * throwing hand inside its envelope (+SIM.dynoMargin) with the apex SIM.dynoAimPast past it, the launch
   * speed that needs against what the legs (their remaining extension) and arms produce, and which other
   * limbs can't stay on at the apex. null when it isn't a throw (in static reach) or can't be thrown.
   */
  throwFrom(n: Node, hands: number[], h: HoldDef): DynoMove | null {
    const pose = n.pose;
    computeAnchors(pose, this.AX, this.AY);
    let ux = pose.cx - pose.px;
    let uy = pose.cy - pose.py;
    const ul = dhypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    const both = hands.length === 2;
    let Dx = 0;
    let Dy = 0;
    let beyond = 0;
    for (const i of hands) {
      const c = contactPoint(h, i, both, this.tmpC);
      const en = envEvalOn(this.prof, i, this.AX[i], this.AY[i], ux, uy, c.x, c.y);
      if (en.excess > SIM.dynoMaxReach) return null;
      if (en.excess > beyond) beyond = en.excess;
      const vx = c.x - this.AX[i];
      const vy = c.y - this.AY[i];
      const l = dhypot(vx, vy) || 1;
      const need = en.excess > 0 ? en.excess + SIM.dynoMargin : 0;
      Dx += (vx / l) * need;
      Dy += (vy / l) * need;
    }
    // within static reach: a normal move does it
    if (beyond <= SIM.reachTolerance + 0.02) return null;
    Dx /= hands.length;
    Dy /= hands.length;
    const st = this.stanceCache.get(n.key);
    const cth = st ? st.cth : this.prm.cth;
    const sth = st ? st.sth : this.prm.sth;
    const gp = Math.max(0.5, SIM.gravity * cth);
    const hop = Math.max(Dy + SIM.dynoAimPast, SIM.dynoMinHop, SIM.dynoLateralHop * Math.abs(Dx));
    const vy = Math.sqrt(2 * gp * hop);
    const vx = Dx / (vy / gp);
    // launch speed: legs over their remaining extension (+ arms), as ClimberSim.launchSpeedMax
    let ext = 0;
    let nf = 0;
    for (let i = 2; i < 4; i++) {
      const sl = n.slots[i];
      if (!sl) continue;
      const fx = sl === 'smear' ? n.sx[i] : contactPoint(sl, i, n.slots[i ^ 1] === sl, this.tmpC).x;
      const fy = sl === 'smear' ? n.sy[i] : this.tmpC.y;
      ext += Math.max(0, BODY.legMax * 0.97 - dhypot(this.AX[i] - fx, this.AY[i] - fy));
      nf++;
    }
    const legs = nf ? Math.sqrt(2 * SIM.dynoLegAccel * (ext / nf)) * (1 - SIM.dynoSteepLegLoss * Math.max(0, sth)) : 0;
    let nh = 0;
    for (let i = 0; i < 2; i++) if (n.slots[i] && n.slots[i] !== 'smear') nh++;
    const arms = Math.sqrt(2 * SIM.dynoArmAccel * SIM.dynoArmExt * Math.max(nh, 1) * 0.5);
    const vmax = Math.sqrt(legs * legs + arms * arms);
    const speed = dhypot(vx, vy);
    if (speed > vmax * SOLVER.dynoSpeedMargin) return null;
    const tA = Math.max(0.04, vy / gp);
    const sx = vx * tA;
    const sy = vy * tA - 0.5 * gp * tA * tA;
    let kind: 'deadpoint' | 'dyno' = both ? 'dyno' : 'deadpoint';
    const cut: number[] = [];
    if (!both) {
      // the other hand stays if its arm reaches from the apex, else it lets go too
      const j = 1 - hands[0];
      const sl = n.slots[j] as HoldDef;
      const c = contactPoint(sl, j, false, this.tmpC);
      if (envEvalOn(this.prof, j, this.AX[j] + sx, this.AY[j] + sy, ux, uy, c.x, c.y).excess > 0.06) {
        cut.push(j);
        kind = 'dyno';
      }
    }
    for (let i = 2; i < 4; i++) {
      const sl = n.slots[i];
      if (!sl) continue;
      const fx = sl === 'smear' ? n.sx[i] : contactPoint(sl, i, n.slots[i ^ 1] === sl, this.tmpC).x;
      const fy = sl === 'smear' ? n.sy[i] : this.tmpC.y;
      const stay = kind === 'deadpoint' && envEvalOn(this.prof, i, this.AX[i] + sx, this.AY[i] + sy, ux, uy, fx, fy).excess <= 0.03;
      if (!stay) cut.push(i);
    }
    return {
      hands: hands.slice(),
      kind,
      limbs: both ? 'both' : hands[0] === 0 ? 'LH' : 'RH',
      vx,
      vy,
      sx,
      sy,
      rise: dhypot(Dx, Dy),
      speed,
      vmax,
      cut,
    };
  }

  /**
   * Evaluate a thrown child: at the apex (the launch pose shifted rigidly) every remaining contact must be
   * in reach, and each catching hand's peak stress — the static load × (1 + v²/2g·SIM.dynoAbsorb), the arm
   * absorbing the remaining speed (research 1.1–1.6 BW) — under the catch limit; then the body settles
   * into the post-catch stance (≤ SOLVER.dynoLandMax).
   */
  evaluateDyno(n: Node, m: LazyMove, d: DynoMove): boolean {
    const parent = n.parent!;
    const hold = m.hold!;
    const a = this.apexPose;
    a.px = parent.pose.px + d.sx;
    a.py = parent.pose.py + d.sy;
    a.cx = parent.pose.cx + d.sx;
    a.cy = parent.pose.cy + d.sy;
    const contacts = this.setContacts(n, -1);
    this.applyFootModes(contacts, a);
    const prm = this.prm;
    prm.reachLimb = -1;
    const ev = evaluateStance(a, contacts, prm, this.ev);
    if (!ev.feasible) return false;
    for (let i = 0; i < 4; i++) if (contacts[i] && ev.excess[i] > (i < 2 ? SIM.dynoCatchTol : 0.03)) return false;
    const v2 = d.vx * d.vx + SIM.dynoGrabVy * SIM.dynoGrabVy;
    const dyn = 1 + v2 / (2 * SIM.gravity * SIM.dynoAbsorb);
    let peak = 0;
    for (const i of d.hands) peak = Math.max(peak, (ev.load[i] * dyn) / Math.max(ev.cap[i], 0.01));
    if (peak > SIM.dynoCatchStress * SOLVER.dynoCatchMargin) return false;
    const st = this.stance(n, { px: a.px, py: a.py, cx: a.cx, cy: a.cy });
    if (st.violation > 0.004 || st.tension > SOLVER.dynoLandMax) return false;
    const fromH = parent.slots[d.hands[0]];
    const step: PlanStep = {
      move: { limb: LIMB_IDS[d.hands[0]], holdId: hold.id, dyno: d.limbs },
      moveTension: Math.max(parent.tension, peak * 0.75),
      tension: st.tension,
      distance: fromH && fromH !== 'smear' ? dhypot(hold.x - fromH.x, hold.y - fromH.y) : d.rise,
      pose: st.pose,
      reachPose: parent.pose,
      dyno: { limbs: d.limbs, kind: d.kind, power: 1, rise: d.rise, speed: d.speed, vmax: d.vmax, peakStress: peak, cut: d.cut.map((i) => LIMB_IDS[i]) },
    };
    n.pose = st.pose;
    n.tension = st.tension;
    n.step = step;
    n.transient = st.tension > SOLVER.stanceMax || !n.slots[2] || !n.slots[3] || !n.slots[0] || !n.slots[1];
    n.g = parent.g + this.moveCost(st.tension, 0.7) + SOLVER.dynoCost;
    n.f = n.g + this.hw * this.heuristic(n.slots);
    STEP_NODE.set(step, n);
    return true;
  }

  /** Lazy dyno children of n (only when this.dynos): throws to good holds beyond static reach. */
  expandDynos(n: Node, push: (c: Node) => void, closed: Set<string>): void {
    const a = n.slots[0];
    const b = n.slots[1];
    if (!a || !b || a === 'smear' || b === 'smear') return;
    if (!n.slots[2] && !n.slots[3]) return; // no campus dynos
    // one throw at a time: the cut limbs go back on (and the body calms down) before the next one
    if (n.transient) return;
    const maxHandY = Math.max(a.y, b.y);
    const mx = (a.x + b.x) / 2;
    for (const h of this.handHolds) {
      if (h === a || h === b) continue;
      if (h.y < maxHandY + 0.25) continue;
      if (dhypot(h.x - mx, h.y - maxHandY) > BODY.armMax + SIM.dynoMaxReach + 0.4) continue;
      if (!this.topIds.has(h.id) && nominalCapacity(h, true, this.angleOf(h.y)) < SOLVER.dynoMinCap) continue;
      // a double dyno jumps off both feet
      const tries: number[][] = canMatch(0, h) && n.slots[2] && n.slots[3] ? [[0, 1], [0], [1]] : [[0], [1]];
      for (const hands of tries) {
        const d = this.throwFrom(n, hands, h);
        if (!d) continue;
        const slots = n.slots.slice();
        for (const i of d.hands) slots[i] = h;
        for (const i of d.cut) slots[i] = null;
        const key = slots.map(slotId).join('|');
        if (closed.has(key)) continue;
        const g = n.g + 1 + SOLVER.dynoCost;
        push({
          slots,
          sx: n.sx.slice(),
          sy: n.sy.slice(),
          key,
          pose: n.pose,
          tension: n.tension,
          g,
          f: g + this.hw * this.heuristic(slots),
          parent: n,
          step: null,
          depth: n.depth + 1,
          move: { li: d.hands[0], hold: h, tx: h.x, ty: h.y, fromX: h.x, fromY: h.y, reachKey: '', dyno: d },
        });
      }
    }
  }

  /**
   * Is the target (contact point) of limb li legal from node n as far as anatomy and self-clipping
   * go: inside the limb's envelope seen from the node pose, grown by `slack` (the body still moves
   * while reaching), and not on / through another limb (holds.placementBlocked)?
   */
  targetOk(n: Node, li: number, hold: HoldDef | null, tx: number, ty: number, slack: number): boolean {
    const p = n.pose;
    computeAnchors(p, this.AX, this.AY);
    let ux = p.cx - p.px;
    let uy = p.cy - p.py;
    const l = dhypot(ux, uy) || 1;
    ux /= l;
    uy /= l;
    if (envEvalOn(this.prof, li, this.AX[li], this.AY[li], ux, uy, tx, ty).excess > slack) return false;
    const contacts = this.setContacts(n, li);
    return !placementBlocked(li, tx, ty, hold, contacts, this.AX, this.AY, PLAN_CLEARANCE_MARGIN);
  }

  /**
   * Self-clipping check of a placement with the body in `pose` (a little stricter than the sim's,
   * so a planned move is never refused live because the body sits a few cm elsewhere).
   */
  clearAt(pose: Pose, n: { slots: Slot[]; sx: number[]; sy: number[] }, li: number, hold: HoldDef | null, tx: number, ty: number): boolean {
    computeAnchors(pose, this.AX, this.AY);
    const contacts = this.setContacts(n, li);
    return !placementBlocked(li, tx, ty, hold, contacts, this.AX, this.AY, PLAN_CLEARANCE_MARGIN);
  }

  /** Candidate targets for limb li from node n (cheap geometric filter, best first). */
  candidates(n: Node, li: number, anchorX: number, anchorY: number): { hold: HoldDef | null; x: number; y: number; score: number }[] {
    const out: { hold: HoldDef | null; x: number; y: number; score: number }[] = [];
    const cur = n.slots[li];
    const hand = li < 2;
    const pair = li === 0 ? 1 : li === 1 ? 0 : li === 2 ? 3 : 2;
    const reach = maxReachIdx(li) + (hand ? 0.55 : 0.4);
    const list = hand ? this.handHolds : this.footHolds;
    // reach slack: the body follows a hand a long way, a foot much less (it can't lift the hips)
    const slack = hand ? 0.5 : 0.32;
    const curY = cur && cur !== 'smear' ? cur.y : hand ? anchorY : -1;
    let minHandY = Infinity;
    let maxHandY = -Infinity;
    for (let i = 0; i < 2; i++) {
      const s = n.slots[i];
      if (s && s !== 'smear') {
        minHandY = Math.min(minHandY, s.y);
        maxHandY = Math.max(maxHandY, s.y);
      }
    }
    const avoid = n.key === this.avoidKey ? this.avoid : null;
    for (const h of list) {
      if (h === cur) continue;
      if (avoid !== null && avoid.has(`${li}|${h.id}`)) continue;
      const d = dhypot(h.x - anchorX, h.y - anchorY);
      if (d > reach) continue;
      let score: number;
      if (hand) {
        if (h.y < curY - (this.lateral > 0 ? 0.45 : 0.3)) continue;
        // matching the other hand's hold is only useful on the top (or a big jug)
        if (n.slots[pair] === h && !this.topIds.has(h.id) && (h.size < 0.09 || !canMatch(li, h))) continue;
        // progress: height gained, or on a traverse the distance gained toward the top
        const gain =
          this.lateral > 0 && cur && cur !== 'smear'
            ? dhypot(this.topX - cur.x, this.topY - cur.y) - dhypot(this.topX - h.x, this.topY - h.y)
            : h.y - curY;
        score = gain * 1.6 + nominalCapacity(h, true, this.angleOf(h.y)) * 1.2 - d * 0.4;
        if (this.topIds.has(h.id)) score += 2;
      } else {
        if (h.y > n.pose.py - 0.12) continue;
        if (h.y < maxHandY - 2.15) continue;
        if (n.slots[pair] === h && (h.size < 0.05 || !canMatch(li, h))) continue;
        const ideal = minHandY - 1.2;
        score = -Math.abs(h.y - ideal) * 1.4 + nominalCapacity(h, false, this.angleOf(h.y)) * 0.35 + (h.y - curY) * 0.5 - Math.abs(h.x - n.pose.px) * 0.4;
      }
      const cp = contactPoint(h, li, n.slots[pair] === h, this.tmpC);
      if (this.shadowed(h, li, n.slots[pair] === h, cp)) continue;
      if (!this.targetOk(n, li, h, cp.x, cp.y, slack)) continue;
      out.push({ hold: h, x: h.x, y: h.y, score });
    }
    if (!hand && this.smearOk) {
      const side = li === 2 ? -1 : 1;
      const sx = n.pose.px + side * 0.16;
      const sy = Math.max(0.35, minHandY - 1.25);
      // (not where the sim would snap the foot onto a foothold instead)
      if (this.smearAt(sy) && !this.nearFoothold(sx, sy) && !(avoid !== null && avoid.has(`${li}|${SMEAR_ID}`)) && this.targetOk(n, li, null, sx, sy, slack))
        out.push({ hold: null, x: sx, y: sy, score: -1.2 });
    }
    out.sort((a, c) => c.score - a.score);
    if (out.length > SOLVER.candidatesPerLimb) out.length = SOLVER.candidatesPerLimb;
    return out;
  }

  /**
   * Children of n, one per candidate move, pushed LAZILY: only the cheap geometric checks run here
   * (envelope + self-clipping at the node pose, in candidates()); the expensive reach / stance pose
   * searches run when the search pops the child (evaluate()). The child's g is a lower bound
   * (parent.g + 1), so the search order is that of an eager A*, but most children of a node are
   * never popped and never cost a pose search.
   */
  expand(n: Node, push: (c: Node) => void, closed: Set<string>): void {
    const hBase = n.g + 1;
    for (let li = 0; li < 4; li++) {
      const hand = li < 2;
      if (hand) {
        const other = n.slots[li === 0 ? 1 : 0];
        if (!other || other === 'smear') continue;
      }
      let subKey: string | null = null;
      // anchor of the moving limb in the node pose
      const a = this.anchorOf(n.pose, li);
      const ax = a.x;
      const ay = a.y;
      const cands = this.candidates(n, li, ax, ay);
      const prevSlot = n.slots[li];
      let fromX = ax;
      let fromY = ay;
      if (prevSlot && prevSlot !== 'smear') {
        fromX = prevSlot.x;
        fromY = prevSlot.y;
      } else if (prevSlot === 'smear') {
        fromX = n.sx[li];
        fromY = n.sy[li];
      }
      for (const c of cands) {
        const slots = n.slots.slice();
        const sx = n.sx.slice();
        const sy = n.sy.slice();
        if (c.hold) slots[li] = c.hold;
        else {
          slots[li] = 'smear';
          sx[li] = Math.round(c.x * 100) / 100;
          sy[li] = Math.round(c.y * 100) / 100;
        }
        const key = slots.map(slotId).join('|');
        if (closed.has(key)) continue;
        // target contact point
        let tx = c.x;
        let ty = c.y;
        if (c.hold) {
          const pair = li === 0 ? 1 : li === 1 ? 0 : li === 2 ? 3 : 2;
          const p = contactPoint(c.hold, li, n.slots[pair] === c.hold, this.tmpV);
          tx = p.x;
          ty = p.y;
        }
        if (subKey === null) subKey = n.slots.map((s, i) => (i === li ? '_' : slotId(s))).join('|');
        const reachKey = `${subKey}>${li}:${c.hold ? c.hold.id : `s${sx[li]},${sy[li]}`}`;
        push({
          slots,
          sx,
          sy,
          key,
          pose: n.pose,
          tension: n.tension,
          g: hBase,
          f: hBase + this.hw * this.heuristic(slots),
          parent: n,
          step: null,
          depth: n.depth + 1,
          move: { li, hold: c.hold, tx, ty, fromX, fromY, reachKey },
        });
      }
    }
    if (this.dynos) this.expandDynos(n, push, closed);
  }

  private anchorTmp = { x: 0, y: 0 };
  anchorOf(p: Pose, li: number): Vec2 {
    let sx = p.cx - p.px;
    let sy = p.cy - p.py;
    const l = dhypot(sx, sy) || 1;
    sx /= l;
    sy /= l;
    const rx = sy;
    const ry = -sx;
    const side = li === 0 || li === 2 ? -1 : 1;
    const off = li < 2 ? BODY.shoulderHalf : BODY.hipHalf;
    const bx = li < 2 ? p.cx : p.px;
    const by = li < 2 ? p.cy : p.py;
    this.anchorTmp.x = bx + side * rx * off;
    this.anchorTmp.y = by + side * ry * off;
    return this.anchorTmp;
  }
}

/**
 * Stance/move evaluator built on the planner's internals, for tools that construct routes
 * (the generator verifies every move it sets with it).
 */
export class StanceLab {
  private readonly p: Planner;
  private readonly empty = [0, 0, 0, 0];
  private seq = 0;
  /** `profile`: panels of a folded wall (BoulderDef.profile) with its surface length, or null for a flat wall. */
  constructor(wallAngle: number, assist = 0, profile: { panels: readonly WallPanel[]; length: number } | null = null) {
    const b: BoulderDef = {
      id: 'lab',
      name: 'lab',
      grade: 0,
      mode: 'boulder',
      wallAngle,
      width: 4.6,
      height: profile ? profile.length : 4.5,
      holds: [],
      color: '#fff',
      seed: 0,
    };
    const prof = profile && profile.panels.length > 1 ? makeProfile(profile.panels, wallAngle, profile.length) : null;
    this.p = new Planner(b, assist, prof && !prof.flat ? prof : null);
  }

  /** Wall angle (degrees) of the panel at surface height y. */
  angleAt(y: number): number {
    return this.p.angleOf(y);
  }

  /** Settled pose + tension of a stance; ok when it is within the planner's limits (violation: anatomy). */
  stance(slots: (HoldDef | null)[], seed: Pose | null): { pose: Pose; tension: number; ok: boolean; violation: number } {
    // unique key: route builders rename and reuse ids while backtracking, so never cache
    const r = this.p.stance({ slots, sx: this.empty, sy: this.empty, key: `lab-s${this.seq++}` }, seed);
    return { pose: r.pose, tension: r.tension, ok: r.violation <= 0.004 && r.tension <= SOLVER.stanceMax, violation: r.violation };
  }

  /** Can limb `li` move to `target` from the stance (other three holding)? */
  reach(slots: (HoldDef | null)[], li: number, target: HoldDef, pose: Pose): { pose: Pose; tension: number; ok: boolean } {
    const pair = li === 0 ? 1 : li === 1 ? 0 : li === 2 ? 3 : 2;
    const tp = contactPoint(target, li, slots[pair] === target, { x: 0, y: 0 });
    // the same anatomy / self-clipping rules the sim applies to a placement
    if (slots[pair] === target && !canMatch(li, target)) return { pose, tension: Infinity, ok: false };
    const node = {
      slots,
      sx: this.empty,
      sy: this.empty,
      key: `lab-n${this.seq}`,
      pose,
      tension: 0,
      g: 0,
      f: 0,
      parent: null,
      step: null,
      depth: 0,
      move: null,
    } as Node;
    if (!this.p.targetOk(node, li, target, tp.x, tp.y, li < 2 ? 0.5 : 0.32)) return { pose, tension: Infinity, ok: false };
    return this.p.reach(node, li, tp.x, tp.y, `lab${this.seq++}`);
  }

  /**
   * Can the climber THROW for `target` from the stance (the planner's dyno model, ClimberSim.throwPlan):
   * 'LH' / 'RH' a deadpoint, 'both' a double-hand dyno. Fails when the target is within static reach
   * (no throw needed), too far, the launch too fast for the legs, the catch too hard, or the landing
   * stance too strenuous. On success: the stance after the catch (`slots` with the target in the
   * throwing hands and the cut limbs null), its pose and tension.
   */
  dyno(
    slots: (HoldDef | null)[],
    hands: 'LH' | 'RH' | 'both',
    target: HoldDef,
    pose: Pose,
  ): { ok: boolean; slots: (HoldDef | null)[]; pose: Pose; tension: number; kind: 'deadpoint' | 'dyno'; cut: number[]; rise: number } {
    const fail = { ok: false, slots, pose, tension: Infinity, kind: 'deadpoint' as const, cut: [] as number[], rise: 0 };
    if (!slots[0] || !slots[1]) return fail;
    if (hands === 'both' && !canMatch(0, target)) return fail;
    const parent = { slots, sx: this.empty, sy: this.empty, key: `lab-d${this.seq++}`, pose, tension: 0, g: 0, f: 0, parent: null, step: null, depth: 0, move: null } as Node;
    // the launch stance's effective plane (cached under its key) sets the throw's gravity split
    const st = this.p.stance(parent, pose);
    parent.tension = st.tension;
    const hs = hands === 'both' ? [0, 1] : [hands === 'LH' ? 0 : 1];
    const d = this.p.throwFrom(parent, hs, target);
    if (!d) return fail;
    const next = slots.slice();
    for (const i of d.hands) next[i] = target;
    for (const i of d.cut) next[i] = null;
    const child = { slots: next, sx: this.empty, sy: this.empty, key: `lab-d${this.seq++}`, pose, tension: 0, g: 0, f: 0, parent, step: null, depth: 1, move: null } as Node;
    const m: LazyMove = { li: d.hands[0], hold: target, tx: target.x, ty: target.y, fromX: target.x, fromY: target.y, reachKey: '', dyno: d };
    if (!this.p.evaluateDyno(child, m, d)) return fail;
    return { ok: true, slots: next, pose: child.pose, tension: child.tension, kind: d.kind, cut: d.cut.slice(), rise: d.rise };
  }

  /** Anchor (shoulder / hip) of a limb in a pose. */
  anchor(pose: Pose, li: number): Vec2 {
    const a = this.p.anchorOf(pose, li);
    return { x: a.x, y: a.y };
  }
}

function startSlots(p: Planner, ids: (string | null)[], b: BoulderDef, pose: Pose | undefined): { slots: Slot[]; sx: number[]; sy: number[] } | null {
  const byId = new Map(b.holds.map((h) => [h.id, h] as const));
  const slots: Slot[] = [null, null, null, null];
  const sx = [0, 0, 0, 0];
  const sy = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const id = ids[i];
    const h = id ? byId.get(id) : undefined;
    if (h && (i < 2 ? usableByHand(h) : usableByFoot(h))) slots[i] = h;
  }
  // one hand may be off (a live climber after half a double dyno stuck): the plan puts it back on first
  if (!slots[0] && !slots[1]) return null;
  // Feet without holds smear (same rule as the sim's start placement).
  const h0 = (slots[0] ?? slots[1]) as HoldDef;
  const h1 = (slots[1] ?? slots[0]) as HoldDef;
  if (p.smearOk && p.smearAt(Math.max(0.45, pose ? pose.py - 0.62 : Math.min(h0.y, h1.y) - 1.25))) {
    const cx = pose ? pose.px : (h0.x + h1.x) / 2;
    const fy = pose ? pose.py - 0.62 : Math.min(h0.y, h1.y) - 1.25;
    for (let i = 2; i < 4; i++) {
      if (slots[i]) continue;
      slots[i] = 'smear';
      sx[i] = Math.round((cx + (i === 2 ? -0.2 : 0.2)) * 100) / 100;
      sy[i] = Math.round(Math.max(0.45, fy) * 100) / 100;
    }
  }
  return { slots, sx, sy };
}

/**
 * Rope: find, along the beta, a stance from which each quickdraw (in order) can be clipped. Draws in
 * `clipped` are already in (a re-plan from a live climb); returns the number of draws that are
 * clipped or have a planned clip.
 */
function planClips(planner: Planner, steps: PlanStep[], clipped: readonly string[] = []): number {
  const draws = planner.b.mode === 'rope' ? planner.b.quickdraws ?? [] : [];
  if (!draws.length) return 0;
  const cp = { x: 0, y: 0 };
  let qi = 0;
  while (qi < draws.length && clipped.includes(draws[qi].id)) qi++;
  // The easiest clip of a draw: from the first stance it can be clipped from, or one of the next
  // CLIP_LOOKAHEAD stances when that is clearly calmer, with the hand that leaves the better hold holding
  // (the other three limbs hold the climber for GAME.clipTime: a strenuous clip stance is where lead
  // climbers come off).
  const best = { k: -1, li: -1, tension: Infinity, pose: null as Pose | null };
  const tryAt = (k: number, qd: QuickdrawDef): void => {
    const n = STEP_NODE.get(steps[k]);
    if (!n) return;
    clipPoint(qd, cp);
    for (let li = 0; li < 2; li++) {
      const other = n.slots[1 - li];
      if (!other || other === 'smear') continue;
      const a = planner.anchorOf(n.pose, li);
      if (dhypot(a.x - cp.x, a.y - cp.y) > BODY.armMax + 0.5) continue;
      const r = planner.reach(n, li, cp.x, cp.y, `${n.key}>clip${li}`);
      if (!r.ok || r.tension > SOLVER.clipMax) continue;
      if (r.tension < best.tension) {
        best.k = k;
        best.li = li;
        best.tension = r.tension;
        best.pose = r.pose;
      }
    }
  };
  for (let k = 0; k < steps.length && qi < draws.length; k++) {
    const isAnchor = qi === draws.length - 1;
    if (isAnchor && k < steps.length - 1) continue;
    best.k = -1;
    best.tension = Infinity;
    tryAt(k, draws[qi]);
    if (best.k < 0) continue;
    // a calmer stance a move or two later (the anchor is clipped from the top)
    if (!isAnchor && best.tension > SOLVER.clipCalm)
      for (let j = k + 1; j < Math.min(steps.length - 1, k + 1 + SOLVER.clipLookahead); j++) {
        const t0 = best.tension;
        tryAt(j, draws[qi]);
        if (best.tension < t0 - 0.12 && best.tension <= SOLVER.clipCalm) break;
      }
    steps[best.k].clip = { quickdrawId: draws[qi].id, limb: LIMB_IDS[best.li], reachPose: best.pose!, tension: best.tension };
    k = best.k;
    qi++;
  }
  return qi;
}

/** Height gained per stage when planning tall (rope) routes in stages. */
const STAGE = 2.6;
const STAGE_NODES = 520;

/** Full planner output (moves + per-step diagnostics). Null when no beta was found within budget. */
export function planBetaDetailed(boulder: BoulderDef, opts: PlanOptions & { goalY?: number } = {}): PlanResult | null {
  const t0 = now();
  const planner = new Planner(boulder, opts.assist ?? 0);
  if (opts.dynos !== undefined) planner.dynos = opts.dynos;
  if (!planner.topIds.size) return null;
  const startIds = opts.start ?? startPlacement(boulder);
  const st = startSlots(planner, startIds, boulder, opts.startPose);
  if (!st) return null;
  let root = planner.makeNode(st.slots, st.sx, st.sy, null, null, opts.startPose ?? null);
  if (!root) {
    // The start itself is too strenuous: still allow planning from it (the sim's start may be hard).
    const key = st.slots.map(slotId).join('|');
    const s = planner.stance({ ...st, key }, opts.startPose ?? null);
    if (s.violation > 0.02) return null;
    root = { ...st, key, pose: s.pose, tension: s.tension, g: 0, f: 0, parent: null, step: null, depth: 0, move: null };
  }
  if (opts.avoid?.length) {
    planner.avoidKey = root.key;
    planner.avoid = new Set(opts.avoid.map((m) => `${LIMB_INDEX[m.limb]}|${m.holdId}`));
  }
  const handY = (n: Node): number => {
    const a = n.slots[0];
    const b = n.slots[1];
    return Math.min(a && a !== 'smear' ? a.y : 0, b && b !== 'smear' ? b.y : 0);
  };
  const rope = boulder.mode === 'rope';
  const totalNodes = opts.maxNodes ?? (rope ? SOLVER.maxNodesRope : SOLVER.maxNodesBoulder);
  const clock: Clock = {
    t0,
    maxMs: opts.maxMs ?? (opts.maxNodes !== undefined ? Infinity : 120),
    minNodes: opts.minNodes ?? SOLVER.minNodes,
    used: 0,
  };
  // An explicit intermediate goal (hints on tall routes).
  if (opts.goalY !== undefined && opts.goalY < planner.topY - 0.3) {
    planner.goalY = opts.goalY;
    return searchFrom(planner, root, totalNodes, clock, root);
  }
  // Short problems: one search to the top. Tall routes: stages of STAGE metres.
  if (planner.topY - handY(root) <= STAGE + 1.4) {
    const r = searchFrom(planner, root, totalNodes, clock, root);
    if (r && rope) r.clipsPlanned = planClips(planner, r.steps, opts.clipped);
    return r;
  }
  const steps: PlanStep[] = [];
  let nodes = 0;
  let cur = root;
  for (let guard = 0; guard < 20; guard++) {
    const stageY = handY(cur) + STAGE;
    const final = stageY >= planner.topY - 1.2;
    planner.goalY = final ? null : stageY;
    const budget = Math.min(STAGE_NODES * (final ? 1.6 : 1), totalNodes - nodes);
    if (budget <= 0) return null;
    const r = searchFrom(planner, cur, budget, clock, root);
    if (!r) return null;
    nodes += r.nodes;
    steps.push(...r.steps);
    if (final) {
      const clipsPlanned = planClips(planner, steps, opts.clipped);
      return { moves: steps.map((s) => s.move), steps, startTension: root.tension, startPose: root.pose, nodes, ms: now() - t0, clipsPlanned };
    }
    // continue from the stage's final stance
    const last = r.steps[r.steps.length - 1];
    const goalNode = r.goal!;
    cur = { ...goalNode, parent: null, step: null, depth: 0, g: 0, f: 0, pose: last ? last.pose : goalNode.pose, move: null };
  }
  return null;
}

/** Wall-clock cap of one plan (shared by its stages): binds only after `minNodes` expansions. */
interface Clock {
  t0: number;
  maxMs: number;
  minNodes: number;
  /** Expansions so far (all stages). */
  used: number;
}

function searchFrom(planner: Planner, root: Node, maxNodes: number, clock: Clock, origin: Node): (PlanResult & { goal?: Node }) | null {
  const t0 = clock.t0;
  const open = new Heap();
  const closed = new Set<string>();
  const best = new Map<string, number>();
  planner.hw = planner.baseHw;
  open.push(root);
  best.set(root.key, root.g);
  let nodes = 0;
  let goal: Node | null = null;
  while (open.size) {
    const n = open.pop()!;
    if (closed.has(n.key)) continue;
    if (n.move) {
      // deferred evaluation: check the move now, then queue the child at its true cost
      if (!planner.evaluate(n)) continue;
      const prev = best.get(n.key);
      if (prev !== undefined && prev <= n.g) continue;
      best.set(n.key, n.g);
      open.push(n);
      continue;
    }
    closed.add(n.key);
    if (planner.isGoal(n)) {
      goal = n;
      break;
    }
    nodes++;
    clock.used++;
    if (nodes > maxNodes) break;
    if (nodes === SOLVER.greedAfter && planner.hw < SOLVER.heuristicWeightGreedy) {
      open.reweight(SOLVER.heuristicWeightGreedy / planner.hw);
      planner.hw = SOLVER.heuristicWeightGreedy;
    }
    if (clock.used > clock.minNodes && (nodes & 7) === 0 && now() - t0 > clock.maxMs) break;
    if (n.depth > 80) continue;
    planner.expand(
      n,
      (c) => {
        // a lazy child's g is a lower bound: skip it only when a cheaper path is already known
        const prev = best.get(c.key);
        if (prev !== undefined && prev <= c.g) return;
        open.push(c);
      },
      closed,
    );
  }
  if (!goal) return null;
  const steps: PlanStep[] = [];
  for (let n: Node | null = goal; n && n.step; n = n.parent) steps.push(n.step);
  steps.reverse();
  return {
    moves: steps.map((s) => s.move),
    steps,
    startTension: origin.tension,
    startPose: origin.pose,
    nodes,
    ms: now() - t0,
    goal,
  };
}

/** A sequence of limb moves from the start holds to matching the top, or null if none was found. */
export function planBeta(boulder: BoulderDef, opts?: { maxMs?: number; maxNodes?: number; minNodes?: number; assist?: number }): BetaMove[] | null {
  const r = planBetaDetailed(boulder, opts ?? {});
  return r ? r.moves : null;
}

/** Hint search budget: expansions, and how many always run before the wall-clock cap applies. */
const HINT_NODES = 700;
const HINT_MIN_NODES = 160;

/**
 * Next suggested move for a live climb. In rope mode, when the next quickdraw is clippable from the
 * current stance, returns `{ limb, holdId: <quickdraw id> }`.
 */
export function nextHint(sim: ClimberSimAPI): BetaMove | null {
  const s = sim.getState();
  if (s.phase !== 'climbing' && s.phase !== 'idle') return null;
  const b = sim.boulder;
  const ids: (string | null)[] = LIMB_IDS.map((l) => s.limbs[l].holdId);
  if (!ids[0] || !ids[1]) {
    // a hand is in the air: suggest the best hold it can reach right now
    const free: LimbId = !ids[0] ? 'LH' : 'RH';
    const reach = sim.reachableHolds(free);
    let best: string | null = null;
    let bq = -1;
    for (const id of reach) {
      const q = sim.predictGrip(free, id) + (b.holds.find((h) => h.id === id)!.y - s.chest.y) * 0.4;
      if (q > bq) {
        bq = q;
        best = id;
      }
    }
    return best ? { limb: free, holdId: best } : null;
  }
  // rope: clip when the next draw is within reach of a hand
  if (b.mode === 'rope' && b.quickdraws?.length) {
    const next = b.quickdraws.find((q) => !s.clipped.includes(q.id));
    if (next) {
      const cp = clipPoint(next, { x: 0, y: 0 });
      for (const limb of ['LH', 'RH'] as const) {
        if (sim.clipCandidate(limb, cp)) return { limb, holdId: next.id };
      }
    }
  }
  const pose: Pose = { px: s.pelvis.x, py: s.pelvis.y, cx: s.chest.x, cy: s.chest.y };
  const byId = new Map(b.holds.map((h) => [h.id, h] as const));
  const lowHand = Math.min(byId.get(ids[0]!)?.y ?? 0, byId.get(ids[1]!)?.y ?? 0);
  // On tall routes aim for the next couple of metres instead of the far-away top.
  const goalY = b.height > 6 ? lowHand + 1.6 : undefined;
  // Deterministic: the same stance gets the same hint on every device. Live stances need ~12
  // expansions at the median (p99 ≈ 90); the 70 ms cap only cuts off hopeless searches.
  const plan = planBetaDetailed(b, { start: ids, startPose: pose, goalY, maxNodes: HINT_NODES, minNodes: HINT_MIN_NODES, maxMs: 70 });
  if (plan && plan.moves.length) return plan.moves[0];
  // Fallback: the best upward reachable hand hold.
  let best: BetaMove | null = null;
  let bs = -Infinity;
  for (const limb of ['LH', 'RH'] as const) {
    const cur = b.holds.find((h) => h.id === s.limbs[limb].holdId);
    for (const id of sim.reachableHolds(limb)) {
      const h = b.holds.find((x) => x.id === id)!;
      if (cur && h.y <= cur.y) continue;
      const sc = sim.predictGrip(limb, id) + h.y * 0.3;
      if (sc > bs) {
        bs = sc;
        best = { limb, holdId: id };
      }
    }
  }
  return best;
}

// ═══════════════════════════════ grade estimation ═══════════════════════════════

export interface DifficultyMetrics {
  moves: number;
  handMoves: number;
  meanHandMove: number;
  maxHandMove: number;
  meanHandCap: number;
  minHandCap: number;
  worstTension: number;
  meanTension: number;
  wallAngle: number;
  /** Combined difficulty score (calibrated so that ≈ V-grade). */
  score: number;
}

/**
 * Calibration: mean difficulty score of generated problems per V-grade (monotone-smoothed), used to
 * map a score back to a grade. Regenerate with the calibration script when the model changes.
 */
const GRADE_SCORES: readonly number[] = [3.3, 4.1, 5.1, 5.9, 6.6, 7.3, 8.0, 8.5, 8.9, 9.3, 9.65, 9.95, 10.45];

export function difficultyMetrics(b: BoulderDef, plan: PlanResult): DifficultyMetrics {
  const byId = new Map(b.holds.map((h) => [h.id, h] as const));
  const prof = profileOf(b);
  let angSum = 0;
  let angN = 0;
  let handMoves = 0;
  let sumMove = 0;
  let maxMove = 0;
  let capSum = 0;
  let capN = 0;
  let minCap = Infinity;
  let worst = plan.startTension;
  let tSum = plan.startTension;
  for (const s of plan.steps) {
    worst = Math.max(worst, s.tension, s.moveTension * 0.92);
    tSum += s.tension;
    if (LIMB_INDEX[s.move.limb] < 2) {
      handMoves++;
      sumMove += s.distance;
      maxMove = Math.max(maxMove, s.distance);
      const h = byId.get(s.move.holdId);
      if (h) {
        const a = prof ? angleAt(prof, h.y) : b.wallAngle;
        angSum += a;
        angN++;
        const c = nominalCapacity(h, true, a);
        capSum += c;
        capN++;
        minCap = Math.min(minCap, c);
      }
    }
  }
  const meanMove = handMoves ? sumMove / handMoves : 0;
  const meanCap = capN ? capSum / capN : 0.75;
  if (!Number.isFinite(minCap)) minCap = meanCap;
  const meanT = tSum / (plan.steps.length + 1);
  // Raw difficulty: weaker holds, longer moves, steeper wall, more strenuous stances.
  const holdTerm = clamp((0.78 - meanCap) / 0.42, 0, 1.4) * 3.6 + clamp((0.7 - minCap) / 0.45, 0, 1.3) * 1.4;
  const moveTerm = clamp((meanMove - 0.36) / 0.34, -0.3, 1.5) * 2.4 + clamp((maxMove - 0.5) / 0.4, 0, 1.4) * 0.8;
  // the wall the hands actually climb (a folded wall: the mean panel angle under the hand moves)
  const wallAngle = prof && angN ? angSum / angN : b.wallAngle;
  const angleTerm = clamp(wallAngle / 40, -0.3, 1.1) * 2.2;
  const tensionTerm = clamp((meanT - 0.3) / 0.4, 0, 1.4) * 1.6 + clamp((worst - 0.45) / 0.45, 0, 1.2) * 1.2;
  const score = holdTerm + moveTerm + angleTerm + tensionTerm;
  return {
    moves: plan.steps.length,
    handMoves,
    meanHandMove: meanMove,
    maxHandMove: maxMove,
    meanHandCap: meanCap,
    minHandCap: minCap,
    worstTension: worst,
    meanTension: meanT,
    wallAngle,
    score,
  };
}

function scoreToGrade(score: number): number {
  const t = GRADE_SCORES;
  if (score <= t[0]) return 0;
  for (let g = 1; g < t.length; g++) {
    if (score <= t[g]) return g - 1 + (score - t[g - 1]) / (t[g] - t[g - 1]);
  }
  return 12;
}

/** V-grade estimate (0..12) from the planned beta; 12 when no beta is found. */
export function estimateGrade(boulder: BoulderDef): number {
  const plan = planBetaDetailed(boulder, { maxNodes: boulder.mode === 'rope' ? SOLVER.maxNodesRope : SOLVER.maxNodesBoulder });
  if (!plan) return 12;
  const m = difficultyMetrics(boulder, plan);
  return clamp(Math.round(scoreToGrade(m.score)), 0, 12);
}

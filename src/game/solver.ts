// Beta planner: best-first search over limb moves, judged by the same static equilibrium model the
// sim uses (statics.ts). A move is legal when the three remaining limbs can hold a body position from
// which the moving limb reaches its target (tension under SOLVER.moveMax) and the new four-limb
// stance settles under SOLVER.stanceMax. Targets must also be anatomically legal: inside the limb's
// reach envelope (anatomy.ts, via the pose search) and clear of the other limbs (holds.placementBlocked,
// checked at the reach pose with a little extra margin so the sim never refuses a planned move).
// Search budgets are node counts (deterministic). Interactive calls may add a wall-clock cap, but it
// never ends a search before SOLVER.minNodes expansions, so a slow phone gets exactly the answer a
// fast desktop gets for every problem solvable within that many expansions (generated problems
// need ~35 at the median and < 260 at worst). The search evaluates children lazily (see expand()).
// Hot-path numbers: ~25 ms median per generated boulder on a desktop core.

import type { BoulderDef, HoldDef, LimbId, QuickdrawDef, Vec2 } from '../core/types';
import type { BetaMove, ClimberSimAPI } from '../core/contracts';
import { BODY, SIM } from '../config/tuning';
import { clamp } from '../core/math';
import {
  canMatch,
  clipPoint,
  contactPoint,
  LIMB_IDS,
  LIMB_INDEX,
  maxReachIdx,
  nominalCapacity,
  placementBlocked,
  startPlacement,
  topHolds,
  usableByFoot,
  usableByHand,
} from './holds';
import { computeAnchors, initialPose, makeParams, newContact, optimizePose, setContact, setSmear, StanceEval, type Contact, type Contacts, type Pose, type StaticsParams } from './statics';
import { dhypot } from './dmath';
import { envEval } from './anatomy';

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
  /** Pump assumed while planning (capacity margin). */
  pump: 0.3,
  /** Weighted A*: f = g + heuristicWeight · h. */
  heuristicWeight: 2.4,
  maxNodesBoulder: 700,
  maxNodesRope: 2600,
  /**
   * A wall-clock cap (PlanOptions.maxMs) only applies after this many expansions: results are then
   * device-independent for every problem solvable within it (generated boulders: p99 ≈ 170).
   */
  minNodes: 320,
  /** Candidate targets kept per limb per expansion. */
  candidatesPerLimb: 7,
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
      let i = 0;
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
    return top;
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
  readonly smearOk: boolean;
  readonly anchor: QuickdrawDef | null;
  private readonly contactObjs: Contact[] = [newContact(), newContact(), newContact(), newContact()];
  private readonly contacts: Contacts = [null, null, null, null];
  private readonly stanceCache = new Map<string, { pose: Pose; tension: number; violation: number }>();
  private readonly reachCache = new Map<string, { pose: Pose; tension: number; ok: boolean }>();
  private readonly tmpPose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
  private readonly tmpV = { x: 0, y: 0 };
  private readonly AX = new Float64Array(4);
  private readonly AY = new Float64Array(4);
  private readonly tmpC = { x: 0, y: 0 };

  constructor(b: BoulderDef, assist: number) {
    this.b = b;
    this.prm = makeParams(b.wallAngle, assist, SOLVER.pump);
    this.reachPrm = makeParams(b.wallAngle, assist, SOLVER.pump);
    this.handHolds = b.holds.filter(usableByHand);
    this.footHolds = b.holds.filter(usableByFoot);
    const tops = topHolds(b);
    this.topIds = new Set(tops.map((h) => h.id));
    this.topY = tops.length ? Math.max(...tops.map((h) => h.y)) : b.height - 0.35;
    this.smearOk = b.wallAngle <= SIM.smearMaxAngle;
    const q = b.mode === 'rope' ? b.quickdraws ?? [] : [];
    this.anchor = q.length ? q[q.length - 1] : null;
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
  stance(n: { slots: Slot[]; sx: number[]; sy: number[]; key: string }, seed: Pose | null): { pose: Pose; tension: number; violation: number } {
    const hit = this.stanceCache.get(n.key);
    if (hit) return hit;
    const contacts = this.setContacts(n, -1);
    this.prm.reachLimb = -1;
    const init = seed ?? initialPose(contacts, this.prm, this.tmpPose);
    const pose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
    const r = seed ? optimizePose(contacts, this.prm, init, pose, this.ev, 44, true) : optimizePose(contacts, this.prm, init, pose, this.ev, 90);
    const out = { pose, tension: r.tension, violation: r.violation };
    this.stanceCache.set(n.key, out);
    return out;
  }

  /** Can limb `li` reach point (tx, ty) while the other three hold? */
  reach(n: Node, li: number, tx: number, ty: number, cacheKey: string): { pose: Pose; tension: number; ok: boolean } {
    const hit = this.reachCache.get(cacheKey);
    if (hit) return hit;
    const contacts = this.setContacts(n, li);
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
      f: g + SOLVER.heuristicWeight * this.heuristic(slots),
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
    const r = this.reach(parent, m.li, m.tx, m.ty, m.reachKey);
    if (!r.ok) return false;
    // the sim checks self-clipping where the limb is released, i.e. around the reach pose
    if (!this.clearAt(r.pose, parent, m.li, m.hold, m.tx, m.ty)) return false;
    const st = this.stance(n, r.pose);
    if (st.violation > 0.004 || st.tension > SOLVER.stanceMax) return false;
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
    n.f = n.g + SOLVER.heuristicWeight * this.heuristic(n.slots);
    STEP_NODE.set(step, n);
    return true;
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
    if (envEval(li, this.AX[li], this.AY[li], ux, uy, tx, ty).excess > slack) return false;
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
    for (const h of list) {
      if (h === cur) continue;
      const d = dhypot(h.x - anchorX, h.y - anchorY);
      if (d > reach) continue;
      let score: number;
      if (hand) {
        if (h.y < curY - 0.3) continue;
        // matching the other hand's hold is only useful on the top (or a big jug)
        if (n.slots[pair] === h && !this.topIds.has(h.id) && (h.size < 0.09 || !canMatch(li, h))) continue;
        score = (h.y - curY) * 1.6 + nominalCapacity(h, true, this.b.wallAngle) * 1.2 - d * 0.4;
        if (this.topIds.has(h.id)) score += 2;
      } else {
        if (h.y > n.pose.py - 0.12) continue;
        if (h.y < maxHandY - 2.15) continue;
        if (n.slots[pair] === h && (h.size < 0.05 || !canMatch(li, h))) continue;
        const ideal = minHandY - 1.2;
        score = -Math.abs(h.y - ideal) * 1.4 + nominalCapacity(h, false, this.b.wallAngle) * 0.35 + (h.y - curY) * 0.5 - Math.abs(h.x - n.pose.px) * 0.4;
      }
      const cp = contactPoint(h, li, n.slots[pair] === h, this.tmpC);
      if (!this.targetOk(n, li, h, cp.x, cp.y, slack)) continue;
      out.push({ hold: h, x: h.x, y: h.y, score });
    }
    if (!hand && this.smearOk) {
      const side = li === 2 ? -1 : 1;
      const sx = n.pose.px + side * 0.16;
      const sy = Math.max(0.35, minHandY - 1.25);
      if (this.targetOk(n, li, null, sx, sy, slack)) out.push({ hold: null, x: sx, y: sy, score: -1.2 });
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
          f: hBase + SOLVER.heuristicWeight * this.heuristic(slots),
          parent: n,
          step: null,
          depth: n.depth + 1,
          move: { li, hold: c.hold, tx, ty, fromX, fromY, reachKey },
        });
      }
    }
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
  constructor(wallAngle: number, assist = 0) {
    const b: BoulderDef = {
      id: 'lab',
      name: 'lab',
      grade: 0,
      mode: 'boulder',
      wallAngle,
      width: 4.6,
      height: 4.5,
      holds: [],
      color: '#fff',
      seed: 0,
    };
    this.p = new Planner(b, assist);
  }

  /** Settled pose + tension of a stance; ok when it is within the planner's limits. */
  stance(slots: (HoldDef | null)[], seed: Pose | null): { pose: Pose; tension: number; ok: boolean } {
    // unique key: route builders rename and reuse ids while backtracking, so never cache
    const r = this.p.stance({ slots, sx: this.empty, sy: this.empty, key: `lab-s${this.seq++}` }, seed);
    return { pose: r.pose, tension: r.tension, ok: r.violation <= 0.004 && r.tension <= SOLVER.stanceMax };
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
  if (!slots[0] || !slots[1]) return null;
  // Feet without holds smear (same rule as the sim's start placement).
  if (p.smearOk) {
    const h0 = slots[0] as HoldDef;
    const h1 = slots[1] as HoldDef;
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
  for (let k = 0; k < steps.length && qi < draws.length; k++) {
    const n = STEP_NODE.get(steps[k]);
    if (!n) continue;
    const isAnchor = qi === draws.length - 1;
    if (isAnchor && k < steps.length - 1) continue;
    clipPoint(draws[qi], cp);
    let done = false;
    for (let li = 0; li < 2 && !done; li++) {
      const other = n.slots[1 - li];
      if (!other || other === 'smear') continue;
      const a = planner.anchorOf(n.pose, li);
      if (dhypot(a.x - cp.x, a.y - cp.y) > BODY.armMax + 0.5) continue;
      const r = planner.reach(n, li, cp.x, cp.y, `${n.key}>clip${li}`);
      if (!r.ok || r.tension > SOLVER.clipMax) continue;
      steps[k].clip = { quickdrawId: draws[qi].id, limb: LIMB_IDS[li], reachPose: r.pose, tension: r.tension };
      done = true;
    }
    if (done) qi++;
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
        const c = nominalCapacity(h, true, b.wallAngle);
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
  const angleTerm = clamp(b.wallAngle / 40, -0.3, 1.1) * 2.2;
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
    wallAngle: b.wallAngle,
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

/**
 * ClimberSim: the four-limb climbing simulation behind JUST GO UP.
 *
 * Everything is wall-local 2D (metres, x right, y up). The sim is pure TypeScript and
 * deterministic: the same boulder + the same input/dt sequence gives the same result.
 *
 * ── Skeleton & dynamics ──────────────────────────────────────────────────────────────
 * Two point masses, pelvis P (1 − comT of the mass) and chest C (comT), joined by a rigid spine.
 * Shoulders and hips sit perpendicular to the spine (BODY.shoulderHalf / hipHalf). Each fixed
 * step (GAME.simHz, sub-stepped inside step(dt), dt clamped to 0.1 s) integrates:
 *   • gravity: in-plane g·cos(wallAngle) on both nodes,
 *   • support: the contacts push/pull with their statically solved forces (below) — feet with the
 *     full force vector (legs push the body up and sideways), hands only with the pull along the
 *     arm, so a body hanging off-plumb swings until the arms can hold it. The forces are smoothed:
 *     a released limb's share vanishes at once and a fresh grab ramps in, which gives natural sway,
 *   • an internal upright spring toward the torso lean that minimises tension (bestLean, ±0.42 rad,
 *     rate-limited) — the climber picks its lean, the player can't steer it by touch,
 *   • the player's hip target (strong, capped) or, when it is idle, an autonomic posture target: on
 *     every stance change the climber settles near the statically best hip position (local search
 *     first), and while a limb is dragged the posture follows the reach. Its strength fades with the
 *     grade (full up to V3, SIM.postureHardFrac at V11+; assist restores it), so hard problems need
 *     deliberate weight shifts with the hip handle,
 *   • a reach pull: a dragged limb reaching beyond 95 % of its anatomical range drags the whole body
 *     after it — a hand anywhere, a foot only toward targets below or out to the side (a leg in the
 *     air can't lift the hips),
 * then projects position constraints (PBD): spine length, every attached hand / foot inside its
 * ANATOMICAL REACH ENVELOPE around the shoulder / hip (anatomy.ts: a foot never above ~0.33 m over
 * the hip and never straight up, a hand only a little way across the chest or down past the hips;
 * a contact that would leave it moves the chest / pelvis instead, a fresh grab at the edge of the
 * snap range eases the body in over SOFT_ATTACH), and soft in-plane minimums (SIM.armMinPlane /
 * legMinPlane: shoulders and hips sit off the wall, so a folded limb projects short). Velocities
 * come from the projected positions.
 * (The original "legs as rest-length springs" idea was replaced by the statically solved support:
 * radial leg springs push an off-centre body further sideways, an inverted-pendulum runaway.)
 *
 * ── Loads, capacity, stress (statics.ts) ─────────────────────────────────────────────
 * Every step the current pose is solved statically: the weight is distributed over the
 * attached limbs by a capacity-weighted least-squares force balance (force + torque), plus the
 * out-of-plane "keep-in" pull the hands need (more on overhangs, more when crouched or when
 * the feet sit close below the hands). On overhangs the feet must toe-pull, which lowers
 * their capacity; on slabs the feet push harder and smears grip better.
 * capacity = hold type × size × pull-angle quality (direction hold → shoulder/hip vs
 * hold.angle, per-type tolerance cone) × overhang factor × match × pump × assist.
 * stress = load / capacity. Loads are smoothed (weight shifts take ~70 ms).
 *
 * ── Tension, shaking, pump, slips, falls ─────────────────────────────────────────────
 * tension = worst stress + balance (CoM outside the feet) + barn-door (contacts in a narrow
 * column with the CoM off to one side) + overstretch/crouch + core torque + reach strain.
 * Shaking: 'shake-start' above SIM.shakeOn (0.7), 'shake-end' below SIM.shakeOff (0.6).
 * Slip clock per limb: runs while stress > 1.05, at full speed (0.5 s to slip) from stress
 * 1.6; at stress 1.3 a slip takes ≈1.2 s, so shaking warns 1–2 s ahead. It drains when the
 * limb is back under capacity. A slipped limb detaches; if that leaves no hands or fewer
 * than two contacts the climber falls ('slip', or 'barn-door' when the barn-door caused it).
 * Pump creeps up (base + strain + campusing), recovers in good rests and shake-outs,
 * lowers hand capacity as it rises, and pump = 1 is a fall. Zero hands for longer than
 * SIM.noHandsGrace is a fall ('no-hands' / 'no-contact').
 *
 * ── Falling, landing, rope ───────────────────────────────────────────────────────────
 * Falling is ballistic (in-plane g·cosθ, out-of-plane g·sinθ, a little spin). Boulder:
 * the fall ends when the feet reach the pad (world height GAME.padHeight) → 'land'.
 * Rope (after setRope): when the harness gets further than the rope length from the anchor,
 * a soft rope spring (stiffness ∝ 1/rope out) catches the climber → 'caught' with the fall
 * distance, phase 'hanging' (damped pendulum). If the feet get below SIM.deckHeight before
 * the catch completes → 'ground-fall', then 'land'. setRope() is ignored while falling (the
 * belayer has locked the rope). Clipping: a hand released on an unclipped quickdraw within
 * GAME.clipRadius is busy for GAME.clipTime, then 'clip-done' and it returns to its hold;
 * clipping the last quickdraw (the anchor) tops a lead route.
 *
 * ── Anatomy & self-clipping ──────────────────────────────────────────────────────────
 * Every reach decision (drag clamp, snapCandidate, reachableHolds, predictGrip, clipCandidate,
 * returning a limb, start feet) uses the envelopes in the current body frame; the statics add an
 * anatomical strain to a limb near an awkward edge (deep high step, crossover, hand far down) and a
 * large one past the edge, so a limb forced beyond it pops off. Placements obey holds.placementBlocked
 * (hands and feet never share a hold or a spot, no hand below both feet, no limb slipped under another
 * one near the wall, matching only where there's room). Crossing limb segments get a sticky depth
 * order (LimbSnapshot.layer / front: the limb that moved into the crossing is in front) for the
 * renderer. reachEnvelope(limb) gives the input layer the reach boundary to draw.
 *
 * ── Conventions ──────────────────────────────────────────────────────────────────────
 * bodyYaw > 0: the climber's right side swings away from the wall (body opens to the right,
 * e.g. a barn-door with the contacts on the left). getState() returns the same object every
 * call (mutated in place); copy what you need to keep.
 */

import type { BoulderDef, ClimberPhase, ClimberState, HoldDef, LimbId, LimbSnapshot, QuickdrawDef, Vec2 } from '../core/types';
import type { ClimberSimAPI, FallReason, SimEvent, SimOptions } from '../core/contracts';
import { BODY, GAME, SIM } from '../config/tuning';
import { clamp, clamp01, damp, DEG, smoothstep } from '../core/math';
import {
  canMatch,
  clipPoint,
  contactPoint,
  LIMB_IDS,
  LIMB_INDEX,
  maxReachIdx,
  placementBlocked,
  startPlacement,
  type LimbContact,
  topHolds,
  usableByFoot,
  usableByHand,
} from './holds';
import { anatomicStrain, envClamp, envelopePolygon, envEval, envProject, PROJ_OUT, segmentsCross } from './anatomy';
import {
  computeAnchors,
  evaluateStance,
  initialPose,
  bestLean,
  LEAN_OUT,
  makeParams,
  newContact,
  optimizePose,
  placeChest,
  setContact,
  StanceEval,
  type Contact,
  type Contacts,
  type Pose,
  type StaticsParams,
} from './statics';

interface LimbRt {
  hold: HoldDef | null;
  smear: boolean;
  /** Contact point while attached (hold grip point or smear point). */
  cx: number;
  cy: number;
  prevHold: HoldDef | null;
  prevSmear: boolean;
  prevX: number;
  prevY: number;
  dragging: boolean;
  /** Raw drag target (finger). */
  tx: number;
  ty: number;
  /** Rendered endpoint. */
  px: number;
  py: number;
  depth: number;
  busy: boolean;
  busyT: number;
  busyDraw: QuickdrawDef | null;
  load: number;
  stress: number;
  cap: number;
  ratio: number;
  shake: number;
  slipT: number;
  overloaded: boolean;
  /** Attachment age (s) – fresh grabs ramp their load in. */
  age: number;
  /** Distance (m) the contact sat outside the envelope when it attached (eased away, see SOFT_ATTACH). */
  attachGap: number;
  /** Smoothed support force this contact applies to the body (body weights). */
  sfx: number;
  sfy: number;
  /** Good direction of the held hold (cos, sin of its angle); (0, −1) for a smear. */
  hx: number;
  hy: number;
  /** Move counter value of this limb's last lift / placement (newest crossing limb goes in front). */
  stamp: number;
}

export interface SimStats {
  /** Limb slips during this climb. */
  slips: number;
  /** Highest smoothed tension while climbing. */
  maxTension: number;
  /** Seconds spent shaking (tension above SIM.shakeOn). */
  shakeTime: number;
  /** Completed limb moves (grabs + smears). */
  moves: number;
  /** Highest point reached by the pelvis (m). */
  maxHeight: number;
}

const EMPTY_EVENTS: SimEvent[] = [];
const H = 1 / GAME.simHz;
const MP = 1 - BODY.comT;
const MC = BODY.comT;
const MIN_PELVIS_Y = GAME.padHeight + 0.42;
/**
 * A limb grabbed at the edge of its snap range (up to SIM.reachTolerance outside its envelope) eases
 * the body into reach over this many seconds instead of one hard projection (the allowed gap shrinks
 * linearly to 0; it never grows), and meanwhile being past the edge doesn't count toward popping off.
 */
const SOFT_ATTACH = 0.25;

function newLimb(): LimbRt {
  return {
    hold: null,
    smear: false,
    cx: 0,
    cy: 0,
    prevHold: null,
    prevSmear: false,
    prevX: 0,
    prevY: 0,
    dragging: false,
    tx: 0,
    ty: 0,
    px: 0,
    py: 0,
    depth: 0.05,
    busy: false,
    busyT: 0,
    busyDraw: null,
    load: 0,
    stress: 0,
    cap: 0,
    ratio: 0,
    shake: 0,
    slipT: 0,
    overloaded: false,
    age: 0,
    attachGap: 0,
    sfx: 0,
    sfy: 0,
    hx: 0,
    hy: -1,
    stamp: 0,
  };
}

function snapshot(id: LimbId): LimbSnapshot {
  return {
    id,
    holdId: null,
    pos: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
    depth: 0.05,
    dragging: false,
    load: 0,
    stress: 0,
    capacity: 0,
    reachRatio: 0,
    smearing: false,
    shake: 0,
    busy: false,
    layer: 0,
    front: false,
  };
}

/** Limb pairs whose segments are checked for crossings (depth-order hint for the renderer). */
const CROSS_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
];

export class ClimberSim implements ClimberSimAPI {
  readonly boulder: BoulderDef;
  private readonly assist: number;
  private readonly invincible: boolean;
  private readonly holdById: Map<string, HoldDef>;
  private readonly handHolds: HoldDef[];
  private readonly footHolds: HoldDef[];
  private readonly topIds: Set<string>;
  private readonly cth: number;
  private readonly sth: number;
  private readonly isRope: boolean;
  private readonly draws: QuickdrawDef[];
  /** 0..1 strength of the autonomic posture (fades with grade, restored by assist). */
  private readonly postureHelp: number;

  // body
  private P = { x: 0, y: 1 };
  private C = { x: 0, y: 1.5 };
  private Pv = { x: 0, y: 0 };
  private Cv = { x: 0, y: 0 };
  private depth = 0.25;
  private depthV = 0;
  private yaw = 0;
  private yawV = 0;
  private readonly pose: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };

  private readonly limbs: LimbRt[] = [newLimb(), newLimb(), newLimb(), newLimb()];
  private readonly contacts: Contacts = [null, null, null, null];
  private readonly contactObjs: Contact[] = [newContact(), newContact(), newContact(), newContact()];
  private readonly ev = new StanceEval();
  private readonly evScratch = new StanceEval();
  private readonly prm: StaticsParams;
  private readonly prmScratch: StaticsParams;
  private readonly ax = new Float64Array(4);
  private readonly ay = new Float64Array(4);

  private phase: ClimberPhase = 'idle';
  private acc = 0;
  private time = 0;
  private pump = 0;
  private tension = 0;
  private shakeAmt = 0;
  private shaking = false;
  private balance = 0;
  private barnPen = 0;
  private matchT = 0;
  private noHandsT = 0;
  private hipTarget: Vec2 | null = null;
  private readonly posture: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };
  private postureOn = false;
  /** Spine direction the upright spring aims for (chosen by bestLean). */
  private leanUx = 0;
  private leanUy = 1;
  private lean = 0;
  private leanTick = 0;
  private reachTick = 0;
  private readonly leanPose: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };
  private readonly clipped: string[] = [];
  /** Per CROSS_PAIRS entry: 0 = not crossing, 1 = first limb in front, 2 = second limb in front. */
  private readonly cross = new Int8Array(CROSS_PAIRS.length);
  private stampSeq = 0;
  /** Pelvis height when the current foot drag began (the reach posture may not lift above it). */
  private reachCapY = 0;
  /** Residual envelope violation (m) of each attached limb after the last PBD projection. */
  private readonly envResidual = new Float64Array(4);

  // falling / rope
  private ropeAnchor: Vec2 | null = null;
  private ropeLen = 0;
  private ropeTaut = false;
  /** Radial (away from the anchor) harness speed during the last air step. */
  private lastRadial = 0;
  private fallStartY = 0;
  private decked = false;
  private landing: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };

  private events: SimEvent[] = [];
  private readonly state: ClimberState;
  private readonly stats: SimStats = { slips: 0, maxTension: 0, shakeTime: 0, moves: 0, maxHeight: 0 };

  constructor(boulder: BoulderDef, opts: SimOptions = {}) {
    this.boulder = boulder;
    this.assist = clamp01(opts.assist ?? 0);
    this.invincible = !!opts.invincible;
    this.holdById = new Map(boulder.holds.map((h) => [h.id, h] as const));
    this.handHolds = boulder.holds.filter(usableByHand);
    this.footHolds = boulder.holds.filter(usableByFoot);
    this.topIds = new Set(topHolds(boulder).map((h) => h.id));
    this.cth = Math.cos(boulder.wallAngle * DEG);
    this.sth = Math.sin(boulder.wallAngle * DEG);
    this.isRope = boulder.mode === 'rope';
    this.draws = boulder.quickdraws ?? [];
    const fade = clamp01((boulder.grade - 3) / 8);
    this.postureHelp = Math.min(1, 1 - (1 - SIM.postureHardFrac) * fade + this.assist);
    this.prm = makeParams(boulder.wallAngle, this.assist, 0);
    this.prmScratch = makeParams(boulder.wallAngle, this.assist, 0);
    const limbs = {} as Record<LimbId, LimbSnapshot>;
    for (const id of LIMB_IDS) limbs[id] = snapshot(id);
    this.state = {
      phase: 'idle',
      pelvis: { x: 0, y: 1 },
      chest: { x: 0, y: 1.5 },
      com: { x: 0, y: 1.2 },
      pelvisDepth: 0.25,
      bodyYaw: 0,
      velocity: { x: 0, y: 0 },
      limbs,
      tension: 0,
      pump: 0,
      shake: 0,
      balance: 0,
      topProgress: 0,
      time: 0,
      clipped: [],
    };
    this.reset();
  }

  // ═══════════════════════════════ lifecycle ═══════════════════════════════

  reset(): void {
    this.phase = 'idle';
    this.acc = 0;
    this.time = 0;
    this.pump = 0;
    this.tension = 0;
    this.shakeAmt = 0;
    this.shaking = false;
    this.matchT = 0;
    this.noHandsT = 0;
    this.hipTarget = null;
    this.clipped.length = 0;
    this.ropeAnchor = null;
    this.ropeTaut = false;
    this.decked = false;
    this.events = [];
    this.stats.slips = 0;
    this.stats.maxTension = 0;
    this.stats.shakeTime = 0;
    this.stats.moves = 0;
    const place = startPlacement(this.boulder);
    this.placeLimbs(place, true);
    this.settle(1.6);
    this.stats.maxHeight = this.P.y;
    this.syncState();
  }

  start(): void {
    if (this.phase === 'idle') this.phase = 'climbing';
  }

  step(dt: number): SimEvent[] {
    const d = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this.acc += d;
    while (this.acc >= H) {
      this.acc -= H;
      this.substep(H);
    }
    this.syncState();
    if (!this.events.length) return EMPTY_EVENTS;
    const out = this.events;
    this.events = [];
    return out;
  }

  getState(): ClimberState {
    return this.state;
  }

  /** Optional extra: per-climb statistics (flash detection, results screen). */
  getStats(): Readonly<SimStats> {
    return this.stats;
  }

  /**
   * Optional extra: how far (m) each attached limb's contact sits outside its anatomical envelope
   * after the last constraint projection (≈ 0; > 0 only while contacts conflict). Index 0 LH … 3 RF.
   */
  envelopeViolation(): Readonly<Float64Array> {
    return this.envResidual;
  }

  /** Optional extra: current hold id per limb (null = free / smearing). */
  placement(): Record<LimbId, string | null> {
    return {
      LH: this.limbs[0].hold?.id ?? null,
      RH: this.limbs[1].hold?.id ?? null,
      LF: this.limbs[2].hold?.id ?? null,
      RF: this.limbs[3].hold?.id ?? null,
    };
  }

  // ═══════════════════════════════ input ═══════════════════════════════

  beginDrag(limb: LimbId): boolean {
    if (this.phase !== 'climbing') return false;
    const i = LIMB_INDEX[limb];
    const L = this.limbs[i];
    if (L.busy || L.dragging) return false;
    const held = L.hold;
    const wasAttached = !!held || L.smear;
    L.prevHold = held;
    L.prevSmear = L.smear;
    L.prevX = L.cx;
    L.prevY = L.cy;
    L.hold = null;
    L.smear = false;
    L.dragging = true;
    L.sfx = 0;
    L.sfy = 0;
    L.tx = L.px;
    L.ty = L.py;
    L.slipT = 0;
    L.overloaded = false;
    L.stamp = ++this.stampSeq;
    if (i >= 2) this.reachCapY = this.P.y;
    if (held && i < 2) this.refreshMatch();
    if (wasAttached) this.events.push({ type: 'release', limb, holdId: held ? held.id : null });
    this.retarget();
    this.syncState();
    return true;
  }

  dragTo(limb: LimbId, p: Vec2): void {
    const L = this.limbs[LIMB_INDEX[limb]];
    if (!L.dragging) return;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    L.tx = p.x;
    L.ty = p.y;
  }

  endDrag(limb: LimbId): SimEvent[] {
    const i = LIMB_INDEX[limb];
    const L = this.limbs[i];
    if (!L.dragging) return [];
    L.dragging = false;
    const out: SimEvent[] = [];
    if (this.phase !== 'climbing') return out;
    const p = { x: L.tx, y: L.ty };
    const hold = this.snapCandidate(limb, p);

    if (i < 2 && this.isRope) {
      const q = this.clipCandidate(limb, p);
      if (q) {
        const cp = clipPoint(q, { x: 0, y: 0 });
        let holdD = Infinity;
        if (hold) holdD = Math.hypot(p.x - hold.x, p.y - hold.y);
        if (Math.hypot(p.x - cp.x, p.y - cp.y) <= holdD) {
          L.busy = true;
          L.busyT = GAME.clipTime;
          L.busyDraw = q;
          out.push({ type: 'clip', quickdrawId: q.id });
          // hold still while the rope goes in: the other three limbs keep the current position
          this.posture.px = this.P.x;
          this.posture.py = this.P.y;
          this.postureOn = true;
          this.syncState();
          return out;
        }
      }
    }

    if (hold) {
      const quality = this.predictGrip(limb, hold.id);
      this.attach(i, hold);
      this.stats.moves++;
      out.push({ type: 'grab', limb, holdId: hold.id, quality });
      if (i < 2 && this.topIds.has(hold.id)) out.push({ type: 'top-touch', limb });
    } else if (i >= 2 && this.boulder.wallAngle <= SIM.smearMaxAngle && this.smearSpot(i, p.x, p.y)) {
      const c = this.smearTmp;
      this.attachSmear(i, c.x, c.y);
      this.stats.moves++;
      out.push({ type: 'smear', limb });
    } else {
      out.push({ type: 'return', limb, holdId: this.returnLimb(i) });
    }
    this.retarget();
    this.syncState();
    return out;
  }

  setHipTarget(p: Vec2 | null): void {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      if (!this.hipTarget) {
        this.hipTarget = { x: p.x, y: p.y };
        this.hipOrigin.x = this.P.x;
        this.hipOrigin.y = this.P.y;
      } else {
        this.hipTarget.x = p.x;
        this.hipTarget.y = p.y;
      }
    } else if (this.hipTarget) {
      // Releasing the hip handle: the climber keeps the position the player chose.
      this.hipTarget = null;
      this.posture.px = this.P.x;
      this.posture.py = this.P.y;
      this.postureOn = true;
    }
  }

  // ═══════════════════════════════ queries ═══════════════════════════════

  snapCandidate(limb: LimbId, p: Vec2): HoldDef | null {
    const i = LIMB_INDEX[limb];
    const list = i < 2 ? this.handHolds : this.footHolds;
    this.frameNow();
    const tmp = this.qTmp;
    let best: HoldDef | null = null;
    let bestD = Infinity;
    for (const h of list) {
      const d = Math.hypot(p.x - h.x, p.y - h.y) - h.size;
      if (d > GAME.snapRadius || d >= bestD) continue;
      contactPoint(h, i, this.wouldMatch(i, h), tmp);
      if (!this.reachOk(i, tmp.x, tmp.y, SIM.reachTolerance)) continue;
      if (this.blocked(i, tmp.x, tmp.y, h)) continue;
      best = h;
      bestD = d;
    }
    return best;
  }

  clipCandidate(limb: LimbId, p: Vec2): QuickdrawDef | null {
    const i = LIMB_INDEX[limb];
    if (i >= 2 || !this.isRope || !this.draws.length) return null;
    if (this.limbs[0].busy || this.limbs[1].busy) return null;
    const a = this.anchorOf(i);
    const cp = { x: 0, y: 0 };
    let next: QuickdrawDef | null = null;
    for (const q of this.draws)
      if (!this.clipped.includes(q.id)) {
        next = q;
        break;
      }
    let best: QuickdrawDef | null = null;
    let bestD = Infinity;
    const u = this.frameNow();
    for (const q of this.draws) {
      if (this.clipped.includes(q.id)) continue;
      clipPoint(q, cp);
      const d = Math.hypot(p.x - cp.x, p.y - cp.y);
      if (d > GAME.clipRadius) continue;
      if (envEval(i, a.x, a.y, u.x, u.y, cp.x, cp.y).excess > GAME.clipRadius) continue;
      const score = q === next ? d - 0.5 : d;
      if (score < bestD) {
        bestD = score;
        best = q;
      }
    }
    return best;
  }

  predictGrip(limb: LimbId, holdId: string): number {
    const h = this.holdById.get(holdId);
    if (!h) return 0;
    const i = LIMB_INDEX[limb];
    if (i < 2 ? !usableByHand(h) : !usableByFoot(h)) return 0;
    this.buildContacts();
    this.frameNow();
    const c = this.contactObjs[i];
    const saved = this.contacts[i];
    const matched = this.wouldMatch(i, h);
    setContact(c, h, i, matched);
    if (!this.reachOk(i, c.x, c.y, SIM.reachTolerance) || this.blocked(i, c.x, c.y, h)) {
      this.contacts[i] = saved;
      return 0;
    }
    this.contacts[i] = c;
    this.prmScratch.pump = this.pump;
    this.prmScratch.reachLimb = -1;
    this.prmScratch.maxPelvisY = Infinity;
    const ev = evaluateStance(this.pose, this.contacts, this.prmScratch, this.evScratch);
    this.contacts[i] = saved;
    const capRef = i < 2 ? 0.7 : 1.2;
    const capQ = clamp01(ev.cap[i] / capRef);
    const stab = 1 - smoothstep(0.35, 1.15, ev.tension);
    return clamp01(0.5 * capQ + 0.5 * stab);
  }

  reachableHolds(limb: LimbId): string[] {
    const i = LIMB_INDEX[limb];
    const list = i < 2 ? this.handHolds : this.footHolds;
    this.frameNow();
    const tmp = this.qTmp;
    const out: string[] = [];
    for (const h of list) {
      contactPoint(h, i, this.wouldMatch(i, h), tmp);
      if (this.reachOk(i, tmp.x, tmp.y, SIM.reachTolerance) && !this.blocked(i, tmp.x, tmp.y, h)) out.push(h.id);
    }
    return out;
  }

  /**
   * Optional extra (not in ClimberSimAPI): the limb's reach boundary right now, wall-local — its
   * anatomical envelope (anatomy.ts) around the current shoulder / hip in the current body frame,
   * grown by the snap tolerance. out[0] is the anchor; the polygon closes back to it. Reuses `out`.
   */
  reachEnvelope(limb: LimbId, out: Vec2[] = []): Vec2[] {
    const i = LIMB_INDEX[limb];
    const u = this.frameNow();
    const a = this.anchorOf(i);
    return envelopePolygon(i, a, u, out, SIM.reachTolerance);
  }

  limbAnchor(limb: LimbId): Vec2 {
    const a = this.anchorOf(LIMB_INDEX[limb]);
    return { x: a.x, y: a.y };
  }

  maxReach(limb: LimbId): number {
    return maxReachIdx(LIMB_INDEX[limb]);
  }

  // ═══════════════════════════════ rope ═══════════════════════════════

  setRope(anchor: Vec2 | null, ropeLength: number): void {
    // The belayer locks the rope when the climber comes off: a fall keeps the rope it started with.
    if (this.phase === 'falling') return;
    if (!anchor || !(ropeLength > 0)) {
      this.ropeAnchor = null;
      this.ropeLen = 0;
      return;
    }
    this.ropeAnchor = { x: anchor.x, y: anchor.y };
    this.ropeLen = ropeLength;
  }

  respawn(placement: Partial<Record<LimbId, string>>): void {
    const place: (string | null)[] = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const id = placement[LIMB_IDS[i]];
      const h = id ? this.holdById.get(id) : undefined;
      if (h && (i < 2 ? usableByHand(h) : usableByFoot(h))) place[i] = h.id;
    }
    this.autoFill(place);
    for (const L of this.limbs) {
      L.busy = false;
      L.busyDraw = null;
      L.dragging = false;
    }
    this.placeLimbs(place, false);
    this.settle(0.8);
    this.phase = 'climbing';
    this.shaking = false;
    this.noHandsT = 0;
    this.matchT = 0;
    this.decked = false;
    this.ropeTaut = false;
    this.pump = Math.max(0, this.pump - 0.2);
    this.syncState();
  }

  forceFall(): void {
    this.fall('forced');
  }

  // ═══════════════════════════════ internals: placement ═══════════════════════════════

  private anchorTmp = { x: 0, y: 0 };
  private anchorOf(i: number): Vec2 {
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    this.anchorTmp.x = this.ax[i];
    this.anchorTmp.y = this.ay[i];
    return this.anchorTmp;
  }

  private syncPose(): void {
    this.pose.px = this.P.x;
    this.pose.py = this.P.y;
    this.pose.cx = this.C.x;
    this.pose.cy = this.C.y;
  }

  private wouldMatch(i: number, h: HoldDef): boolean {
    const other = this.limbs[i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 3 : 2];
    return other.hold === h && !other.dragging;
  }

  private readonly qTmp = { x: 0, y: 0 };
  private readonly upTmp = { x: 0, y: 1 };
  /** Body-up unit vector of the current pose (also refreshes this.ax / this.ay). */
  private frameNow(): Vec2 {
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    const dx = this.C.x - this.P.x;
    const dy = this.C.y - this.P.y;
    const l = Math.hypot(dx, dy);
    if (l > 1e-9) {
      this.upTmp.x = dx / l;
      this.upTmp.y = dy / l;
    } else {
      this.upTmp.x = 0;
      this.upTmp.y = 1;
    }
    return this.upTmp;
  }

  /** Is (x, y) inside limb i's envelope (grown by tol) in the frame last set by frameNow()? */
  private reachOk(i: number, x: number, y: number, tol: number): boolean {
    return envEval(i, this.ax[i], this.ay[i], this.upTmp.x, this.upTmp.y, x, y).excess <= tol;
  }

  /** Self-clipping: would limb i on (x, y) / hold h overlap another limb? (frame from frameNow()). */
  private blocked(i: number, x: number, y: number, h: HoldDef | null): boolean {
    for (let k = 0; k < 4; k++) {
      const L = this.limbs[k];
      if (k !== i && (L.hold || L.smear) && !L.dragging && !L.busy) {
        const c = this.clipObjs[k];
        c.hold = L.hold;
        c.x = L.cx;
        c.y = L.cy;
        this.clipContacts[k] = c;
      } else this.clipContacts[k] = null;
    }
    return placementBlocked(i, x, y, h, this.clipContacts, this.ax, this.ay);
  }
  private readonly clipObjs: LimbContact[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, hold: null }));
  private readonly clipContacts: (LimbContact | null)[] = [null, null, null, null];

  /** Smear point for a foot released at (x, y): clamped into the leg envelope; false if blocked. */
  private readonly smearTmp = { x: 0, y: 0 };
  private smearSpot(i: number, x: number, y: number): boolean {
    const u = this.frameNow();
    const c = envClamp(i, this.ax[i], this.ay[i], u.x, u.y, x, y, 0);
    this.smearTmp.x = c.x;
    this.smearTmp.y = Math.max(c.y, 0.05);
    return !this.blocked(i, this.smearTmp.x, this.smearTmp.y, null);
  }

  private attach(i: number, h: HoldDef): void {
    const L = this.limbs[i];
    L.hold = h;
    L.hx = Math.cos(h.angle);
    L.hy = Math.sin(h.angle);
    L.smear = false;
    L.busy = false;
    L.age = 0;
    L.slipT = 0;
    L.stamp = ++this.stampSeq;
    this.refreshMatch();
    if (i >= 2) {
      const tmp = { x: 0, y: 0 };
      contactPoint(h, i, this.wouldMatch(i, h), tmp);
      L.cx = tmp.x;
      L.cy = tmp.y;
      const o = this.limbs[i === 2 ? 3 : 2];
      if (o.hold === h) {
        contactPoint(h, i === 2 ? 3 : 2, true, tmp);
        o.cx = tmp.x;
        o.cy = tmp.y;
      }
    }
    this.measureGap(i);
  }

  private attachSmear(i: number, x: number, y: number): void {
    const L = this.limbs[i];
    L.hold = null;
    L.hx = 0;
    L.hy = -1;
    L.smear = true;
    L.cx = x;
    L.cy = y;
    L.age = 0;
    L.slipT = 0;
    L.stamp = ++this.stampSeq;
    this.measureGap(i);
  }

  /**
   * Height the body follows a dragged limb's target to: a hand never reaches below both feet (it
   * couldn't grab there), so the body doesn't sink after a finger that points that low.
   */
  private reachY(i: number): number {
    const L = this.limbs[i];
    if (i >= 2) return L.ty;
    let floor = Infinity;
    for (let k = 2; k < 4; k++) {
      const F = this.limbs[k];
      if ((F.hold || F.smear) && !F.dragging && F.cy < floor) floor = F.cy;
    }
    return Number.isFinite(floor) ? Math.max(L.ty, floor + SIM.handAboveFeet) : L.ty;
  }

  /** How far the fresh contact of limb i sits outside its envelope (eased in by the PBD). */
  private measureGap(i: number): void {
    const L = this.limbs[i];
    const u = this.frameNow();
    L.attachGap = Math.min(envProject(i, this.ax[i], this.ay[i], u.x, u.y, L.cx, L.cy), SIM.reachTolerance + 0.35);
  }

  private softAllow(L: LimbRt): number {
    return L.age < SOFT_ATTACH && L.attachGap > 0 ? L.attachGap * (1 - L.age / SOFT_ATTACH) : 0;
  }

  /** Recompute hand contact points (matched hands share the hold). */
  private refreshMatch(): void {
    const a = this.limbs[0];
    const b = this.limbs[1];
    const tmp = { x: 0, y: 0 };
    const matched = !!a.hold && a.hold === b.hold;
    for (let i = 0; i < 2; i++) {
      const L = this.limbs[i];
      if (!L.hold) continue;
      contactPoint(L.hold, i, matched, tmp);
      L.cx = tmp.x;
      L.cy = tmp.y;
    }
  }

  /** Best usable hold within reach of limb i right now (by predicted grip), or null. */
  private bestReachable(i: number): string | null {
    const limb = LIMB_IDS[i];
    let best: string | null = null;
    let bq = 0.05;
    for (const id of this.reachableHolds(limb)) {
      const q = this.predictGrip(limb, id);
      if (q > bq) {
        bq = q;
        best = id;
      }
    }
    return best;
  }

  /**
   * Hand/foot let go over nothing → back to the previous hold if it is still (nearly) inside the
   * limb's envelope and nothing else took it; the PBD then eases the body back into reach.
   */
  private returnLimb(i: number): string | null {
    const L = this.limbs[i];
    this.frameNow();
    // a hand that just let go can still find its hold after the body leaned into the reach
    const tol = SIM.reachTolerance + (i < 2 ? 0.35 : 0.08);
    if (L.prevHold) {
      const tmp = this.qTmp;
      contactPoint(L.prevHold, i, this.wouldMatch(i, L.prevHold), tmp);
      if (this.reachOk(i, tmp.x, tmp.y, tol) && !this.blocked(i, tmp.x, tmp.y, L.prevHold)) {
        this.attach(i, L.prevHold);
        return L.prevHold.id;
      }
    } else if (L.prevSmear && i >= 2 && this.reachOk(i, L.prevX, L.prevY, tol) && !this.blocked(i, L.prevX, L.prevY, null)) {
      this.attachSmear(i, L.prevX, L.prevY);
      return null;
    }
    return null;
  }

  private placeLimbs(place: (string | null)[], resetPose: boolean): void {
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      const h = place[i] ? this.holdById.get(place[i]!) ?? null : null;
      L.hold = h;
      L.hx = h ? Math.cos(h.angle) : 0;
      L.hy = h ? Math.sin(h.angle) : -1;
      L.smear = false;
      L.dragging = false;
      L.busy = false;
      L.busyDraw = null;
      L.prevHold = h;
      L.prevSmear = false;
      L.slipT = 0;
      L.overloaded = false;
      L.age = 10;
      L.shake = 0;
    }
    this.refreshMatch();
    for (let i = 2; i < 4; i++) if (this.limbs[i].hold) this.attach(i, this.limbs[i].hold!);
    for (const L of this.limbs) L.age = 10;
    // Feet with no hold smear below the hands on vertical/slab walls.
    this.buildContacts();
    const init: Pose = { px: 0, py: 1, cx: 0, cy: 1.5 };
    initialPose(this.contacts, this.prm, init);
    for (let i = 2; i < 4; i++) {
      const L = this.limbs[i];
      if (!L.hold && this.boulder.wallAngle <= SIM.smearMaxAngle && (this.limbs[0].hold || this.limbs[1].hold)) {
        const side = i === 2 ? -1 : 1;
        this.attachSmear(i, init.px + side * 0.2, Math.max(GAME.padHeight + 0.15, init.py - 0.62));
        L.age = 10;
      }
    }
    this.buildContacts();
    initialPose(this.contacts, this.prm, init);
    const best: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
    this.prm.pump = this.pump;
    this.prm.reachLimb = -1;
    this.prm.maxPelvisY = Infinity;
    let opt = optimizePose(this.contacts, this.prm, init, best, this.evScratch, 110);
    // A foot that no body position can bring inside its leg envelope (it would have to point above
    // the hip, or cross far under the body) starts off its hold instead.
    for (let guard = 0; guard < 2 && opt.violation > 0.01; guard++) {
      let worst = -1;
      let wv = 0.01;
      for (let i = 2; i < 4; i++) if (this.contacts[i] && this.evScratch.excess[i] > wv) {
        wv = this.evScratch.excess[i];
        worst = i;
      }
      if (worst < 0) break;
      const L = this.limbs[worst];
      L.hold = null;
      L.smear = false;
      L.prevHold = null;
      if (this.boulder.wallAngle <= SIM.smearMaxAngle) {
        this.attachSmear(worst, best.px + (worst === 2 ? -0.2 : 0.2), Math.max(GAME.padHeight + 0.15, best.py - 0.62));
        L.age = 10;
      }
      this.buildContacts();
      const seed: Pose = { px: best.px, py: best.py, cx: best.cx, cy: best.cy };
      opt = optimizePose(this.contacts, this.prm, seed, best, this.evScratch, 110);
    }
    this.P.x = best.px;
    this.P.y = best.py;
    this.C.x = best.cx;
    this.C.y = best.cy;
    {
      const l = Math.hypot(best.cx - best.px, best.cy - best.py) || 1;
      this.leanUx = (best.cx - best.px) / l;
      this.leanUy = (best.cy - best.py) / l;
      this.lean = 0;
      this.leanTick = 0;
    }
    this.Pv.x = this.Pv.y = this.Cv.x = this.Cv.y = 0;
    this.depthV = 0;
    this.yaw = 0;
    this.yawV = 0;
    this.posture.px = best.px;
    this.posture.py = best.py;
    this.postureOn = true;
    if (resetPose) this.depth = 0.25;
    // limb endpoints at their contacts
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      if (L.hold || L.smear) {
        L.px = L.cx;
        L.py = L.cy;
      } else {
        L.px = this.ax[i];
        L.py = this.ay[i] - (i < 2 ? 0.5 : 0.82);
      }
      L.tx = L.px;
      L.ty = L.py;
    }
  }

  /** Fill missing respawn limbs with sensible holds near the current body. */
  private autoFill(place: (string | null)[]): void {
    const px = this.P.x;
    const py = this.P.y;
    const pick = (list: HoldDef[], score: (h: HoldDef) => number, exclude: (string | null)[]): string | null => {
      let best: HoldDef | null = null;
      let bs = -Infinity;
      for (const h of list) {
        if (exclude.includes(h.id)) continue;
        const s = score(h);
        if (s > bs) {
          bs = s;
          best = h;
        }
      }
      return best ? best.id : null;
    };
    for (let i = 0; i < 2; i++) {
      if (place[i]) continue;
      const side = i === 0 ? -1 : 1;
      place[i] = pick(
        this.handHolds,
        (h) => -Math.abs(h.y - (py + 1.0)) * 1.2 - Math.abs(h.x - (px + side * 0.25)) - (h.type === 'jug' ? 0 : 0.15),
        [place[1 - i]],
      );
    }
    const hy = Math.min(
      place[0] ? this.holdById.get(place[0])!.y : py + 1,
      place[1] ? this.holdById.get(place[1])!.y : py + 1,
    );
    for (let i = 2; i < 4; i++) {
      if (place[i]) continue;
      const side = i === 2 ? -1 : 1;
      place[i] = pick(
        this.footHolds.filter((h) => h.y < hy - 0.6 && h.y > hy - 1.9),
        (h) => -Math.abs(h.y - (hy - 1.15)) - Math.abs(h.x - (px + side * 0.22)) * 1.2,
        [place[5 - i]],
      );
    }
  }

  /** Pre-relax the body (no clock, no pump, no events) so the climber starts stable. */
  private settle(seconds: number): void {
    const saved = this.phase;
    this.phase = 'idle';
    const n = Math.round(seconds / H);
    for (let k = 0; k < n; k++) this.climbStep(H, k < n * 0.6 ? 2.2 : 1);
    this.phase = saved;
    // start from the settled loads
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      L.load = this.ev.load[i];
      L.stress = this.ev.stress[i];
      L.cap = this.ev.cap[i];
      L.slipT = 0;
      if (this.contacts[i]) {
        L.sfx = i < 2 ? this.ev.fax[i] : this.ev.fx[i];
        L.sfy = i < 2 ? this.ev.fay[i] : this.ev.fy[i];
      }
    }
    this.tension = this.ev.tension;
    this.Pv.x = this.Pv.y = this.Cv.x = this.Cv.y = 0;
    this.events.length = 0;
  }

  private buildContacts(): void {
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      if ((L.hold || L.smear) && !L.dragging && !L.busy) {
        const c = this.contactObjs[i];
        c.hold = L.hold;
        c.x = L.cx;
        c.y = L.cy;
        c.matched = !!L.hold && this.wouldMatch(i, L.hold);
        c.hx = L.hx;
        c.hy = L.hy;
        this.contacts[i] = c;
      } else this.contacts[i] = null;
    }
  }

  /** Pick the spine lean that minimises tension for the current pelvis position. */
  private updateLean(): void {
    this.buildContacts();
    // the torso leans into a reaching HAND; a reaching foot doesn't tilt the whole torso over to
    // fake a higher step (the hips may shift for it, see updateReachPosture)
    let reachLimb = -1;
    for (let i = 0; i < 2; i++)
      if (this.limbs[i].dragging) {
        reachLimb = i;
        break;
      }
    const prm = this.prmScratch;
    prm.pump = this.pump;
    prm.reachLimb = reachLimb;
    prm.maxPelvisY = Infinity;
    if (reachLimb >= 0) {
      prm.reachX = this.limbs[reachLimb].tx;
      prm.reachY = this.reachY(reachLimb);
    }
    let any = false;
    for (let i = 0; i < 4; i++) if (this.contacts[i]) any = true;
    if (!any) return;
    prm.reachMargin = reachLimb >= 0 ? SIM.reachComfort : 0;
    bestLean(this.contacts, prm, this.P.x, this.P.y, this.evScratch, this.leanPose, this.lean);
    prm.reachMargin = 0;
    // rate-limited: the torso turns smoothly (≈2.4 rad/s)
    const maxStep = 2.4 * H * 4;
    this.lean += clamp(LEAN_OUT.lean - this.lean, -maxStep, maxStep);
    this.leanPose.px = this.P.x;
    this.leanPose.py = this.P.y;
    placeChest(this.leanPose, this.contacts, prm, this.lean);
    const dx = this.leanPose.cx - this.leanPose.px;
    const dy = this.leanPose.cy - this.leanPose.py;
    const l = Math.hypot(dx, dy) || 1;
    this.leanUx = dx / l;
    this.leanUy = dy / l;
  }

  /** While a limb is dragged (and the player isn't steering the hips), the posture follows the reach. */
  private updateReachPosture(): void {
    if (this.hipTarget || (this.phase !== 'climbing' && this.phase !== 'idle')) return;
    let li = -1;
    for (let i = 0; i < 4; i++)
      if (this.limbs[i].dragging) {
        li = i;
        break;
      }
    if (li < 0) return;
    this.buildContacts();
    let any = false;
    for (let i = 0; i < 4; i++) if (this.contacts[i]) any = true;
    if (!any) return;
    const L = this.limbs[li];
    const prm = this.prmScratch;
    prm.pump = this.pump;
    prm.reachLimb = li;
    prm.reachX = L.tx;
    prm.reachY = this.reachY(li);
    // a reaching foot never lifts the body: the hips may sink or shift for it, not rise
    prm.maxPelvisY = li >= 2 ? this.reachCapY + 0.02 : Infinity;
    prm.reachMargin = SIM.reachComfort;
    const seed = this.leanPose;
    seed.px = this.posture.px;
    seed.py = this.posture.py;
    optimizePose(this.contacts, prm, seed, this.posture, this.evScratch, 36, true);
    prm.reachMargin = 0;
    this.postureOn = true;
  }

  /**
   * New autonomic posture target for the current stance: settle near where the body already is
   * (local search); only if that stays strenuous look for a better position further away.
   */
  private retarget(): void {
    if (this.phase !== 'climbing' && this.phase !== 'idle') return;
    this.buildContacts();
    let any = false;
    for (let i = 0; i < 4; i++) if (this.contacts[i]) any = true;
    if (!any) {
      this.postureOn = false;
      return;
    }
    this.syncPose();
    const prm = this.prmScratch;
    prm.pump = this.pump;
    prm.reachLimb = -1;
    // while a foot is lifted the climber may settle lower, not climb up on its own
    let footUp = false;
    for (let i = 2; i < 4; i++) if (this.limbs[i].dragging) footUp = true;
    prm.maxPelvisY = footUp ? this.P.y + 0.02 : Infinity;
    const r = optimizePose(this.contacts, prm, this.pose, this.posture, this.evScratch, 60, true);
    if (r.tension > 0.62 || r.violation > 0.01) {
      const alt: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
      const r2 = optimizePose(this.contacts, prm, this.pose, alt, this.evScratch, 90, false);
      if (r2.cost < r.cost - 0.08) {
        this.posture.px = alt.px;
        this.posture.py = alt.py;
        this.posture.cx = alt.cx;
        this.posture.cy = alt.cy;
      }
    }
    prm.maxPelvisY = Infinity;
    this.postureOn = true;
  }

  // ═══════════════════════════════ internals: stepping ═══════════════════════════════

  private substep(h: number): void {
    switch (this.phase) {
      case 'idle':
      case 'climbing':
      case 'topped':
        this.climbStep(h, 1);
        break;
      case 'falling':
        this.fallStep(h);
        break;
      case 'hanging':
        this.hangStep(h);
        break;
      case 'landed':
        this.landedStep(h);
        break;
    }
  }

  private climbStep(h: number, dampBoost: number): void {
    const climbing = this.phase === 'climbing';
    this.updateBusy(h);
    if (this.leanTick-- <= 0) {
      this.leanTick = 3;
      this.updateLean();
    }
    if (this.reachTick-- <= 0) {
      this.reachTick = 9;
      this.updateReachPosture();
    }
    this.integrateBody(h, dampBoost);
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    this.updateEndpoints(h);
    this.buildContacts();

    // statics
    let reachLimb = -1;
    for (let i = 0; i < 4; i++)
      if (this.limbs[i].dragging) {
        reachLimb = i;
        break;
      }
    this.prm.pump = this.pump;
    this.prm.reachLimb = reachLimb;
    if (reachLimb >= 0) {
      this.prm.reachX = this.limbs[reachLimb].tx;
      this.prm.reachY = this.reachY(reachLimb);
    }
    const ev = evaluateStance(this.pose, this.contacts, this.prm, this.ev);
    const k = 1 - Math.exp(-SIM.loadSmoothing * h);
    const ks = 1 - Math.exp(-SIM.supportSmoothing * h);
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      L.ratio = ev.ratio[i];
      if (this.contacts[i]) {
        L.age += h;
        L.cap = ev.cap[i];
        L.load += (ev.load[i] - L.load) * k;
        // + anatomical strain: awkward edge of the envelope, or forced beyond it (pops off) — not
        // while a fresh grab is still easing the body into reach
        L.stress = L.load / Math.max(L.cap, 0.01) + (L.age < SOFT_ATTACH ? Math.min(ev.edge[i], SIM.edgeStrain) : ev.edge[i]);
        const tx = i < 2 ? ev.fax[i] : ev.fx[i];
        const ty = i < 2 ? ev.fay[i] : ev.fy[i];
        L.sfx += (tx - L.sfx) * ks;
        L.sfy += (ty - L.sfy) * ks;
      } else {
        L.load = 0;
        L.stress = 0;
        L.cap = 0;
        L.sfx = 0;
        L.sfy = 0;
      }
    }
    // tension from the smoothed stresses + the penalties of this pose
    let worst = 0;
    for (let i = 0; i < 4; i++) if (this.limbs[i].stress > worst) worst = this.limbs[i].stress;
    if (!ev.feasible && (ev.handsOn || ev.feetOn)) worst = Math.max(worst, 1.2);
    const rawT = worst + ev.balancePen + ev.barnPen + ev.stretchPen + ev.corePen + ev.reachPen;
    this.tension += (rawT - this.tension) * k;
    this.balance = ev.balance;
    this.barnPen = ev.barnPen;
    this.depth = damp(this.depth, ev.depth, 4, h);
    const yawTarget = clamp(ev.barn * 0.75 + (reachLimb >= 0 ? 0 : 0), -0.8, 0.8);
    this.yawV += ((yawTarget - this.yaw) * 30 - this.yawV * 7) * h;
    this.yaw += this.yawV * h;

    // shake visuals
    const bodyShake = smoothstep(SIM.shakeOff, 1.3, this.tension);
    this.shakeAmt = damp(this.shakeAmt, bodyShake, 8, h);
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      let s = smoothstep(0.75, 1.3, L.stress);
      if (i < 2 && this.contacts[i]) s += 0.35 * smoothstep(0.6, 1, this.pump);
      if (i >= 2 && this.contacts[i]) s += 0.4 * bodyShake * smoothstep(0.4, 0.9, L.stress);
      L.shake = damp(L.shake, clamp01(s), 10, h);
    }

    if (!climbing) return;
    this.time += h;
    if (this.tension > this.stats.maxTension) this.stats.maxTension = this.tension;
    if (this.P.y > this.stats.maxHeight) this.stats.maxHeight = this.P.y;

    // shaking events (hysteresis)
    if (!this.shaking && this.tension > SIM.shakeOn) {
      this.shaking = true;
      this.events.push({ type: 'shake-start' });
    } else if (this.shaking && this.tension < SIM.shakeOff) {
      this.shaking = false;
      this.events.push({ type: 'shake-end' });
    }
    if (this.shaking) this.stats.shakeTime += h;

    this.updatePump(h);
    if (this.phase !== 'climbing') return;
    this.updateSlips(h);
    if (this.phase !== 'climbing') return;
    this.checkFalls(h);
    if (this.phase !== 'climbing') return;
    this.checkTop(h);
  }

  private integrateBody(h: number, dampBoost: number): void {
    const g = SIM.gravity;
    const P = this.P;
    const C = this.C;
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    const ax = this.ax;
    const ay = this.ay;
    let apx = 0;
    let apy = -g * this.cth;
    let acx = 0;
    let acy = -g * this.cth;

    // support: feet push with their full static force, hands only pull along the arm, so a
    // body that hangs off-plumb swings until the arms can hold it.
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      if (L.sfx === 0 && L.sfy === 0) continue;
      if (i < 2) {
        acx += (L.sfx * g) / MC;
        acy += (L.sfy * g) / MC;
      } else {
        apx += (L.sfx * g) / MP;
        apy += (L.sfy * g) / MP;
      }
    }

    // upright spine (internal force pair) toward the lean the statics prefer
    const tcx = P.x + BODY.spine * this.leanUx;
    const tcy = P.y + BODY.spine * this.leanUy;
    const fux = SIM.uprightStiffness * (tcx - C.x);
    const fuy = SIM.uprightStiffness * (tcy - C.y);
    acx += fux;
    acy += fuy;
    apx -= (fux * MC) / MP;
    apy -= (fuy * MC) / MP;

    // hip target (player) or autonomic posture
    if (this.phase === 'climbing' || this.phase === 'idle') {
      let tx = 0;
      let ty = 0;
      let k = 0;
      let cap = 0;
      let c = 0;
      if (this.hipTarget) {
        // aim at the furthest point toward the finger the attached limbs allow, so the hip spring
        // settles at the anatomical limit instead of fighting the envelope constraints (bobbing)
        this.feasibleHip(this.hipTarget.x, this.hipTarget.y, this.hipAim);
        tx = this.hipAim.x;
        ty = this.hipAim.y;
        k = SIM.hipStiffness;
        cap = SIM.hipMaxForce * g;
        c = SIM.hipDamping;
      } else if (this.postureOn) {
        tx = this.posture.px;
        ty = this.posture.py;
        k = SIM.postureStiffness * this.postureHelp;
        cap = SIM.postureMaxForce * g * this.postureHelp;
        c = SIM.postureDamping;
      }
      if (k > 0) {
        let fx = k * (tx - P.x) - c * this.Pv.x;
        let fy = k * (ty - P.y) - c * this.Pv.y;
        const fl = Math.hypot(fx, fy);
        if (fl > cap) {
          fx *= cap / fl;
          fy *= cap / fl;
        }
        apx += fx / MP;
        apy += fy / MP;
      }
    }

    // reach pull: the whole body follows a limb that reaches beyond its comfortable range (its
    // anatomical envelope). Hands pull the body anywhere; a foot never pulls the body UP — only
    // toward targets below or out to the side (the hips can't be lifted by a leg in the air).
    {
      let ux = C.x - P.x;
      let uy = C.y - P.y;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul;
      uy /= ul;
      for (let i = 0; i < 4; i++) {
        const L = this.limbs[i];
        if (!L.dragging) continue;
        const ty = this.reachY(i);
        const en = envEval(i, ax[i], ay[i], ux, uy, L.tx, ty);
        const d = en.r;
        if (d < 1e-6) continue;
        const beyond = en.over > 0 ? en.excess + en.rMax * (1 - SIM.reachFollowFrac) : d - en.rMax * SIM.reachFollowFrac;
        if (beyond <= 0) continue;
        const f = Math.min(SIM.reachStiffness * beyond, SIM.reachMaxForce * g);
        let fx = (f * (L.tx - ax[i])) / d;
        let fy = (f * (ty - ay[i])) / d;
        if (i >= 2) {
          const up = fx * ux + fy * uy;
          if (up > 0) {
            fx -= up * ux;
            fy -= up * uy;
          }
          // targets above the hip line don't pull at all
          const vu = (L.tx - ax[i]) * ux + (L.ty - ay[i]) * uy;
          if (vu > 0.05) continue;
        }
        acx += fx;
        acy += fy;
        apx += fx;
        apy += fy;
      }
    }

    // integrate
    const dmp = Math.exp(-SIM.dampClimb * dampBoost * h);
    this.Pv.x = (this.Pv.x + apx * h) * dmp;
    this.Pv.y = (this.Pv.y + apy * h) * dmp;
    this.Cv.x = (this.Cv.x + acx * h) * dmp;
    this.Cv.y = (this.Cv.y + acy * h) * dmp;
    const opx = P.x;
    const opy = P.y;
    const ocx = C.x;
    const ocy = C.y;
    P.x += this.Pv.x * h;
    P.y += this.Pv.y * h;
    C.x += this.Cv.x * h;
    C.y += this.Cv.y * h;

    this.projectClimb();

    this.Pv.x = (P.x - opx) / h;
    this.Pv.y = (P.y - opy) / h;
    this.Cv.x = (C.x - ocx) / h;
    this.Cv.y = (C.y - ocy) / h;
  }

  private readonly hipAim: Vec2 = { x: 0, y: 0 };
  /** Pelvis position when the current hip drag began: the feasible-aim search starts from here. */
  private readonly hipOrigin: Vec2 = { x: 0, y: 0 };
  private readonly hipAx = new Float64Array(4);
  private readonly hipAy = new Float64Array(4);
  private readonly hipPose: Pose = { px: 0, py: 0, cx: 0, cy: 0 };

  /**
   * Furthest pelvis position on the line from the hip drag's origin toward (tx, ty) at which every
   * attached limb stays inside its envelope (torso moved rigidly with the pelvis). Written to out.
   * Searching from a fixed origin (not the moving pelvis) keeps the aim still once it hits the limit,
   * so other forces can't make the hips creep along the boundary.
   */
  private feasibleHip(tx: number, ty: number, out: Vec2): void {
    const P = this.P;
    const C = this.C;
    const ox = C.x - P.x;
    const oy = C.y - P.y;
    const ol = Math.hypot(ox, oy) || 1;
    const ux = ox / ol;
    const uy = oy / ol;
    const O = this.hipOrigin;
    const ok = (t: number): boolean => {
      const q = this.hipPose;
      q.px = O.x + (tx - O.x) * t;
      q.py = O.y + (ty - O.y) * t;
      q.cx = q.px + ox;
      q.cy = q.py + oy;
      computeAnchors(q, this.hipAx, this.hipAy);
      for (let i = 0; i < 4; i++) {
        const L = this.limbs[i];
        if (!(L.hold || L.smear) || L.dragging || L.busy) continue;
        if (envProject(i, this.hipAx[i], this.hipAy[i], ux, uy, L.cx, L.cy) > this.softAllow(L) + 0.004) return false;
      }
      return true;
    };
    if (ok(1)) {
      out.x = tx;
      out.y = ty;
      return;
    }
    if (!ok(0)) {
      // the stance changed under the drag (a slip, a smear): restart the search from here
      O.x = P.x;
      O.y = P.y;
      if (!ok(0)) {
        out.x = P.x;
        out.y = P.y;
        return;
      }
    }
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 10; it++) {
      const mid = (lo + hi) * 0.5;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    out.x = O.x + (tx - O.x) * lo;
    out.y = O.y + (ty - O.y) * lo;
  }

  /**
   * PBD projection: arms and legs inside their anatomical envelopes (anatomy.ts) — an attached hand
   * that would leave its shoulder's envelope pulls/pushes the chest back, an attached foot that would
   * leave its hip's envelope pushes the pelvis back (with a high foot the hips can't sink or slide
   * past where the leg would fold beyond its limit) — soft in-plane minimums, spine length, floor.
   */
  private projectClimb(): void {
    const P = this.P;
    const C = this.C;
    const sh = BODY.shoulderHalf;
    const hh = BODY.hipHalf;
    const res = this.envResidual;
    for (let it = 0; it < SIM.pbdIterations; it++) {
      // spine frame
      let sx = C.x - P.x;
      let sy = C.y - P.y;
      let sl = Math.hypot(sx, sy) || 1;
      let ux = sx / sl;
      let uy = sy / sl;
      let rx = uy;
      let ry = -ux;
      for (let i = 0; i < 2; i++) {
        const L = this.limbs[i];
        if (!L.hold || L.dragging || L.busy) continue;
        const side = i === 0 ? -1 : 1;
        const shx = C.x + side * rx * sh;
        const shy = C.y + side * ry * sh;
        const dx = L.cx - shx;
        const dy = L.cy - shy;
        const d = Math.hypot(dx, dy);
        const dist = envProject(i, shx, shy, ux, uy, L.cx, L.cy);
        const allow = this.softAllow(L);
        if (dist > allow) {
          // move the shoulder so the grip point sits on the nearest allowed point (a fresh grab
          // at the edge of the snap range eases the body in instead of yanking it)
          const k = (dist - allow) / dist;
          C.x += (L.cx - PROJ_OUT.x) * k;
          C.y += (L.cy - PROJ_OUT.y) * k;
        } else if (d < SIM.armMinPlane && d > 1e-6) {
          // soft: a hand grabbed right at the shoulder pushes the body away gently
          const m = (Math.max(d - SIM.armMinPlane, -0.01) / d) * 0.5;
          C.x += dx * m;
          C.y += dy * m;
        }
      }
      sx = C.x - P.x;
      sy = C.y - P.y;
      sl = Math.hypot(sx, sy) || 1;
      ux = sx / sl;
      uy = sy / sl;
      rx = uy;
      ry = -ux;
      for (let i = 2; i < 4; i++) {
        const L = this.limbs[i];
        if (!(L.hold || L.smear) || L.dragging) continue;
        const side = i === 2 ? -1 : 1;
        const hx = P.x + side * rx * hh;
        const hy = P.y + side * ry * hh;
        const dx = L.cx - hx;
        const dy = L.cy - hy;
        const d = Math.hypot(dx, dy);
        const dist = envProject(i, hx, hy, ux, uy, L.cx, L.cy);
        const allow = this.softAllow(L);
        if (dist > allow) {
          const k = (dist - allow) / dist;
          P.x += (L.cx - PROJ_OUT.x) * k;
          P.y += (L.cy - PROJ_OUT.y) * k;
        } else if (d < SIM.legMinPlane && d > 1e-6) {
          // soft: a high-step folds the leg and eases the hips away instead of popping them
          const m = (Math.max(d - SIM.legMinPlane, -0.01) / d) * 0.5;
          P.x += dx * m;
          P.y += dy * m;
        }
      }
      // spine length (mass weighted)
      sx = C.x - P.x;
      sy = C.y - P.y;
      sl = Math.hypot(sx, sy);
      if (sl > 1e-6) {
        const diff = (sl - BODY.spine) / sl;
        P.x += sx * diff * MC;
        P.y += sy * diff * MC;
        C.x -= sx * diff * MP;
        C.y -= sy * diff * MP;
      }
      if (P.y < MIN_PELVIS_Y) P.y = MIN_PELVIS_Y;
      // keep the chest above the pelvis while climbing (no flips)
      if (C.y < P.y + 0.12) C.y = P.y + 0.12;
    }
    // residual violations (conflicting contacts): the limb that can't stay pops off via its stress
    {
      const dx = C.x - P.x;
      const dy = C.y - P.y;
      const l = Math.hypot(dx, dy) || 1;
      this.syncPose();
      computeAnchors(this.pose, this.ax, this.ay);
      for (let i = 0; i < 4; i++) {
        const L = this.limbs[i];
        const on = (L.hold || L.smear) && !L.dragging && !L.busy;
        res[i] = on ? Math.max(0, envProject(i, this.ax[i], this.ay[i], dx / l, dy / l, L.cx, L.cy) - this.softAllow(L)) : 0;
      }
    }
  }

  /** Dragged endpoints follow the finger (clamped to the reach envelope); free limbs dangle. */
  private updateEndpoints(h: number): void {
    const ax = this.ax;
    const ay = this.ay;
    let sx = this.C.x - this.P.x;
    let sy = this.C.y - this.P.y;
    const sl = Math.hypot(sx, sy) || 1;
    sx /= sl;
    sy /= sl;
    const rx = sy;
    const ry = -sx;
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      const side = i === 0 || i === 2 ? -1 : 1;
      if (L.dragging) {
        // the limb follows the finger up to its anatomical limit (a hold up to SIM.reachTolerance
        // further out still snaps on release; the body is then eased into reach)
        const c = envClamp(i, ax[i], ay[i], sx, sy, L.tx, L.ty, 0);
        const kk = 1 - Math.exp(-36 * h);
        L.px += (c.x - L.px) * kk;
        L.py += (c.y - L.py) * kk;
        // the body moves too: the endpoint itself never leaves the envelope
        const e = envClamp(i, ax[i], ay[i], sx, sy, L.px, L.py, 0);
        L.px = e.x;
        L.py = e.y;
        L.depth = damp(L.depth, 0.12, 14, h);
      } else if (L.busy && L.busyDraw) {
        const tx = L.busyDraw.x;
        const ty = L.busyDraw.y - SIM.quickdrawDrop;
        L.px = damp(L.px, tx, 18, h);
        L.py = damp(L.py, ty, 18, h);
        L.depth = damp(L.depth, 0.1, 14, h);
      } else if (L.hold || L.smear) {
        L.px = damp(L.px, L.cx, 30, h);
        L.py = damp(L.py, L.cy, 30, h);
        L.depth = damp(L.depth, L.smear ? 0.015 : i < 2 ? 0.03 : 0.02, 14, h);
      } else {
        // dangling: arms hang by the side (elbow soft, inside the arm envelope), legs hang down
        const down = i < 2 ? 0.4 : 0.82;
        const tx = ax[i] - sx * down + rx * side * (i < 2 ? 0.06 : 0.05);
        const ty = ay[i] - sy * down + ry * side * (i < 2 ? 0.06 : 0.05);
        L.px = damp(L.px, tx, 9, h);
        L.py = damp(L.py, ty, 9, h);
        L.depth = damp(L.depth, this.depth * 0.6 + 0.06, 6, h);
      }
    }
  }

  private updateBusy(h: number): void {
    for (let i = 0; i < 2; i++) {
      const L = this.limbs[i];
      if (!L.busy) continue;
      L.busyT -= h;
      if (L.busyT > 0) continue;
      const q = L.busyDraw!;
      L.busy = false;
      L.busyDraw = null;
      if (!this.clipped.includes(q.id)) this.clipped.push(q.id);
      this.events.push({ type: 'clip-done', quickdrawId: q.id, limb: LIMB_IDS[i] });
      let ret = this.returnLimb(i);
      if (ret === null && !L.hold) {
        // previous hold drifted out of reach: take the best hand hold within reach instead
        const id = this.bestReachable(i);
        if (id) {
          this.attach(i, this.holdById.get(id)!);
          ret = id;
        }
      }
      this.events.push({ type: 'return', limb: LIMB_IDS[i], holdId: ret });
      this.retarget();
      const anchor = this.draws[this.draws.length - 1];
      if (this.phase === 'climbing' && anchor && q.id === anchor.id) this.sendTop();
    }
  }

  private updatePump(h: number): void {
    let handStress = 0;
    let hands = 0;
    let feet = 0;
    let goodHands = true;
    for (let i = 0; i < 4; i++) {
      if (!this.contacts[i]) continue;
      const L = this.limbs[i];
      if (i < 2) {
        hands++;
        if (L.stress > handStress) handStress = L.stress;
        if (L.stress > 0.45) goodHands = false;
      } else feet++;
    }
    const scale = this.isRope ? SIM.ropePumpScale : 1;
    const recover = this.isRope ? SIM.ropeRecoverScale : 1;
    let rate = SIM.pumpBase * scale;
    if (hands) rate += SIM.pumpStrain * scale * smoothstep(0.25, 1.1, handStress) * (1 + handStress);
    if (hands && !feet) rate += SIM.pumpCampus;
    if (this.tension < 0.4 && feet && hands === 2 && goodHands) rate -= SIM.pumpRecover * recover;
    if (hands === 1 && feet && handStress < 0.55) {
      const free = this.limbs[this.contacts[0] ? 1 : 0];
      if (!free.dragging && !free.busy) rate -= SIM.pumpShakeOut * recover;
    }
    if (rate > 0) rate *= 1 - SIM.assistPump * this.assist;
    this.pump = clamp01(this.pump + rate * h);
    if (this.invincible) this.pump = Math.min(this.pump, SIM.pumpInvincibleCap);
    if (this.pump >= 1) this.fall('pump');
  }

  private updateSlips(h: number): void {
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      if (!this.contacts[i]) {
        L.slipT = 0;
        continue;
      }
      const s = L.stress;
      if (s > 1 && !L.overloaded) {
        L.overloaded = true;
        this.events.push({ type: 'overload', limb: LIMB_IDS[i] });
      } else if (s < 0.9) L.overloaded = false;
      if (s > SIM.slipStart) L.slipT += (h * smoothstep(SIM.slipStart, SIM.slipFull, s)) / SIM.slipTime;
      else L.slipT = Math.max(0, L.slipT - SIM.slipRecover * h);
      if (this.invincible) L.slipT = Math.min(L.slipT, 0.95);
      if (L.slipT >= 1) {
        this.slip(i);
        if (this.phase !== 'climbing') return;
      }
    }
  }

  private slip(i: number): void {
    const L = this.limbs[i];
    const id = L.hold ? L.hold.id : null;
    const barn = this.barnPen > 0.3;
    this.stats.slips++;
    if (id) this.events.push({ type: 'slip', limb: LIMB_IDS[i], holdId: id });
    else this.events.push({ type: 'slip', limb: LIMB_IDS[i], holdId: '' });
    L.hold = null;
    L.smear = false;
    L.prevHold = null;
    L.prevSmear = false;
    L.slipT = 0;
    L.overloaded = false;
    L.sfx = 0;
    L.sfy = 0;
    if (i < 2) this.refreshMatch();
    this.buildContacts();
    let hands = 0;
    let contacts = 0;
    for (let k = 0; k < 4; k++)
      if (this.contacts[k]) {
        contacts++;
        if (k < 2) hands++;
      }
    if (hands === 0 || contacts < 2) {
      this.fall(barn ? 'barn-door' : 'slip');
      return;
    }
    this.retarget();
  }

  private checkFalls(h: number): void {
    let hands = 0;
    let contacts = 0;
    for (let k = 0; k < 4; k++)
      if (this.contacts[k]) {
        contacts++;
        if (k < 2) hands++;
      }
    if (hands === 0) {
      this.noHandsT += h;
      if (this.noHandsT > SIM.noHandsGrace) this.fall(contacts === 0 ? 'no-contact' : 'no-hands');
    } else this.noHandsT = 0;
  }

  private checkTop(h: number): void {
    if (this.isRope) {
      this.matchT = 0;
      return;
    }
    const a = this.limbs[0];
    const b = this.limbs[1];
    const on = !!a.hold && !!b.hold && this.topIds.has(a.hold.id) && this.topIds.has(b.hold.id) && !a.dragging && !b.dragging;
    if (on) {
      this.matchT += h;
      if (this.matchT >= GAME.topHold) this.sendTop();
    } else this.matchT = Math.max(0, this.matchT - h * 3);
  }

  private sendTop(): void {
    this.phase = 'topped';
    this.matchT = GAME.topHold;
    this.hipTarget = null;
    for (const L of this.limbs) L.dragging = false;
    if (this.shaking) {
      this.shaking = false;
      this.events.push({ type: 'shake-end' });
    }
    this.events.push({ type: 'top' });
  }

  // ═══════════════════════════════ falling ═══════════════════════════════

  private fall(reason: FallReason): void {
    if (this.phase === 'falling' || this.phase === 'landed') return;
    if (this.invincible && reason !== 'forced') {
      if (reason === 'pump') this.pump = SIM.pumpInvincibleCap;
      return;
    }
    if (this.phase !== 'climbing' && this.phase !== 'topped' && this.phase !== 'hanging' && reason !== 'forced') return;
    if (this.shaking) {
      this.shaking = false;
      this.events.push({ type: 'shake-end' });
    }
    this.events.push({ type: 'fall', reason });
    this.phase = 'falling';
    this.hipTarget = null;
    this.postureOn = false;
    this.matchT = 0;
    this.noHandsT = 0;
    this.fallStartY = this.P.y;
    this.ropeTaut = false;
    this.decked = false;
    for (const L of this.limbs) {
      L.hold = null;
      L.smear = false;
      L.dragging = false;
      L.busy = false;
      L.busyDraw = null;
      L.load = 0;
      L.stress = 0;
      L.cap = 0;
      L.slipT = 0;
      L.sfx = 0;
      L.sfy = 0;
    }
    this.buildContacts();
    // push off the wall + a little spin
    this.depthV = Math.max(this.depthV, 0.7);
    const sx = this.C.x - this.P.x;
    const sy = this.C.y - this.P.y;
    const spin = (this.balance >= 0 ? -1 : 1) * 1.2;
    this.Cv.x += -sy * spin;
    this.Cv.y += sx * spin;
  }

  private airIntegrate(h: number, damping: number, rope: boolean): void {
    const g = SIM.gravity;
    const P = this.P;
    const C = this.C;
    let apx = 0;
    let apy = -g * this.cth;
    let acx = 0;
    let acy = -g * this.cth;
    // weak self-righting (the climber tries to get the feet under the body)
    const k = rope ? 2.25 : 0.62;
    acx += k * (P.x - C.x);
    acy += k * (P.y + BODY.spine - C.y);
    let radialOut = 0;
    if (rope && this.ropeAnchor) {
      const a = this.ropeAnchor;
      const dx = P.x - a.x;
      const dy = P.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > this.ropeLen && d > 1e-6) {
        const nx = dx / d;
        const ny = dy / d;
        const out = Math.max(1.5, a.y + this.ropeLen);
        const kr = SIM.ropeStiffness / out;
        const vr = this.Pv.x * nx + this.Pv.y * ny;
        radialOut = vr;
        const f = kr * (d - this.ropeLen) + SIM.ropeDamping * Math.max(0, vr);
        apx -= (f * nx) / MP;
        apy -= (f * ny) / MP;
        if (!this.ropeTaut) this.ropeTaut = true;
      }
    }
    const dmp = Math.exp(-damping * h);
    this.Pv.x = (this.Pv.x + apx * h) * dmp;
    this.Pv.y = (this.Pv.y + apy * h) * dmp;
    this.Cv.x = (this.Cv.x + acx * h) * dmp;
    this.Cv.y = (this.Cv.y + acy * h) * dmp;
    const opx = P.x;
    const opy = P.y;
    const ocx = C.x;
    const ocy = C.y;
    P.x += this.Pv.x * h;
    P.y += this.Pv.y * h;
    C.x += this.Cv.x * h;
    C.y += this.Cv.y * h;
    // spine
    const ddx = C.x - P.x;
    const ddy = C.y - P.y;
    const sl = Math.hypot(ddx, ddy);
    if (sl > 1e-6) {
      const diff = (sl - BODY.spine) / sl;
      P.x += ddx * diff * MC;
      P.y += ddy * diff * MC;
      C.x -= ddx * diff * MP;
      C.y -= ddy * diff * MP;
    }
    this.Pv.x = (P.x - opx) / h;
    this.Pv.y = (P.y - opy) / h;
    this.Cv.x = (C.x - ocx) / h;
    this.Cv.y = (C.y - ocy) / h;
    // out of plane: plumb fall (overhang pushes away from the wall)
    this.depthV += g * this.sth * h;
    this.depthV *= Math.exp(-(rope ? 2.5 : 0.3) * h);
    this.depth += this.depthV * h;
    if (rope) this.depth = damp(this.depth, 0.3 + Math.max(0, this.sth) * 0.4, 1.5, h);
    if (this.depth < 0.15) {
      this.depth = 0.15;
      if (this.depthV < 0) this.depthV = 0;
    }
    this.lastRadial = radialOut;
  }

  /** World height of the lowest (dangling) foot. */
  private feetWorldY(): number {
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    const down = (this.P.y - this.C.y) / BODY.spine;
    const fy = Math.min(this.ay[2], this.ay[3]) + down * BODY.legMax * 0.92;
    return fy * this.cth - (this.depth + 0.05) * this.sth;
  }

  private fallStep(h: number): void {
    const rope = !!this.ropeAnchor && this.isRope && !this.decked;
    this.airIntegrate(h, SIM.dampAir, rope);
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    this.updateFlail(h, 'fall');
    const fw = this.feetWorldY();
    if (this.isRope && !this.decked && fw <= SIM.deckHeight) {
      this.decked = true;
      this.events.push({ type: 'ground-fall' });
    }
    if (rope && this.ropeTaut && this.lastRadial <= 0 && !this.decked) {
      this.phase = 'hanging';
      this.events.push({ type: 'caught', fallDistance: Math.max(0, this.fallStartY - this.P.y) });
      return;
    }
    if (fw <= GAME.padHeight) this.land();
    this.tension = damp(this.tension, 0, 6, h);
    this.shakeAmt = damp(this.shakeAmt, 0, 6, h);
  }

  private hangStep(h: number): void {
    this.airIntegrate(h, SIM.dampHang, true);
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    this.updateFlail(h, 'hang');
    this.tension = damp(this.tension, 0, 4, h);
    this.shakeAmt = damp(this.shakeAmt, 0, 6, h);
    this.pump = Math.max(0, this.pump - 0.01 * h);
    if (this.feetWorldY() < GAME.padHeight) {
      // stretched to the floor while hanging – stand on the ground
      this.land();
    }
  }

  private land(): void {
    const vy = this.Pv.y * this.cth - this.depthV * this.sth;
    const impact = Math.abs(vy);
    this.phase = 'landed';
    this.events.push({ type: 'land', impact: Math.round(impact * 100) / 100 });
    // crouch on the pad
    const worldPelvis = GAME.padHeight + 0.45;
    const d = this.depth;
    const py = (worldPelvis + d * this.sth) / Math.max(0.3, this.cth);
    this.landing.px = this.P.x;
    this.landing.py = py;
    this.landing.cx = this.P.x + Math.sin(this.yaw * 0.2) * 0.05;
    this.landing.cy = py + BODY.spine * 0.92;
    this.Pv.x = this.Pv.y = this.Cv.x = this.Cv.y = 0;
    this.depthV = 0;
  }

  private landedStep(h: number): void {
    const t = this.landing;
    this.P.x = damp(this.P.x, t.px, 10, h);
    this.P.y = damp(this.P.y, t.py, 10, h);
    this.C.x = damp(this.C.x, t.cx, 8, h);
    this.C.y = damp(this.C.y, t.cy, 8, h);
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    this.updateFlail(h, 'land');
    this.yaw = damp(this.yaw, 0, 3, h);
    this.tension = damp(this.tension, 0, 6, h);
    this.shakeAmt = damp(this.shakeAmt, 0, 6, h);
  }

  private updateFlail(h: number, mode: 'fall' | 'hang' | 'land'): void {
    const ax = this.ax;
    const ay = this.ay;
    let sx = this.C.x - this.P.x;
    let sy = this.C.y - this.P.y;
    const sl = Math.hypot(sx, sy) || 1;
    sx /= sl;
    sy /= sl;
    const rx = sy;
    const ry = -sx;
    const padY = (GAME.padHeight + this.depth * this.sth) / Math.max(0.3, this.cth);
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      const side = i === 0 || i === 2 ? -1 : 1;
      let tx: number;
      let ty: number;
      if (i < 2) {
        if (mode === 'fall') {
          tx = ax[i] + sx * 0.42 + rx * side * 0.2;
          ty = ay[i] + sy * 0.42 + ry * side * 0.2;
        } else if (mode === 'hang') {
          tx = ax[i] + sx * 0.32 - rx * side * 0.12;
          ty = ay[i] + sy * 0.32 - ry * side * 0.12;
        } else {
          tx = ax[i] - sx * 0.45 + rx * side * 0.12;
          ty = ay[i] - sy * 0.45 + ry * side * 0.12;
        }
      } else if (mode === 'land') {
        tx = ax[i] + side * 0.12;
        ty = padY;
      } else {
        tx = ax[i] - sx * 0.8 + rx * side * 0.1;
        ty = ay[i] - sy * 0.8 + ry * side * 0.1;
      }
      L.px = damp(L.px, tx, 10, h);
      L.py = damp(L.py, ty, 10, h);
      L.depth = damp(L.depth, this.depth * (i < 2 ? 0.8 : 0.7) + 0.08, 6, h);
      L.load = 0;
      L.stress = 0;
      L.shake = damp(L.shake, 0, 8, h);
    }
  }

  // ═══════════════════════════════ state sync ═══════════════════════════════

  private syncState(): void {
    const s = this.state;
    s.phase = this.phase;
    s.pelvis.x = this.P.x;
    s.pelvis.y = this.P.y;
    s.chest.x = this.C.x;
    s.chest.y = this.C.y;
    s.com.x = this.P.x + BODY.comT * (this.C.x - this.P.x);
    s.com.y = this.P.y + BODY.comT * (this.C.y - this.P.y);
    s.pelvisDepth = this.depth;
    s.bodyYaw = this.yaw;
    s.velocity.x = this.Pv.x * MP + this.Cv.x * MC;
    s.velocity.y = this.Pv.y * MP + this.Cv.y * MC;
    s.tension = this.tension;
    s.pump = this.pump;
    s.shake = this.shakeAmt;
    s.balance = this.balance;
    s.topProgress = clamp01(this.matchT / GAME.topHold);
    s.time = this.time;
    if (s.clipped.length !== this.clipped.length || s.clipped.some((v, k) => v !== this.clipped[k])) {
      s.clipped.length = 0;
      for (const c of this.clipped) s.clipped.push(c);
    }
    const u = this.frameNow();
    this.updateLayers();
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      const o = s.limbs[LIMB_IDS[i]];
      o.holdId = L.hold ? L.hold.id : null;
      o.pos.x = L.px;
      o.pos.y = L.py;
      o.anchor.x = this.ax[i];
      o.anchor.y = this.ay[i];
      o.depth = L.depth;
      o.dragging = L.dragging;
      o.load = L.load;
      o.stress = L.stress;
      o.capacity = L.cap;
      // fraction of the anatomical reach in this direction (≥ 1 = at the envelope's edge)
      o.reachRatio = envEval(i, this.ax[i], this.ay[i], u.x, u.y, L.px, L.py).ratio;
      o.smearing = L.smear;
      o.shake = L.shake;
      o.busy = L.busy;
      let layer = 0;
      for (let p = 0; p < CROSS_PAIRS.length; p++) {
        const c = this.cross[p];
        if ((c === 1 && CROSS_PAIRS[p][0] === i) || (c === 2 && CROSS_PAIRS[p][1] === i)) layer++;
      }
      o.layer = layer;
      o.front = layer > 0;
    }
  }

  /**
   * Depth order of crossing limbs. When two limb segments (shoulder→hand, hip→foot) start to cross
   * in the wall plane, the limb that moved into the crossing (latest lift / placement) goes in front;
   * the order sticks while they keep crossing, so a limb never pops through another.
   */
  private updateLayers(): void {
    const active = this.phase === 'climbing' || this.phase === 'idle' || this.phase === 'topped';
    for (let p = 0; p < CROSS_PAIRS.length; p++) {
      if (!active) {
        this.cross[p] = 0;
        continue;
      }
      const a = CROSS_PAIRS[p][0];
      const b = CROSS_PAIRS[p][1];
      const A = this.limbs[a];
      const B = this.limbs[b];
      const crossing = segmentsCross(this.ax[a], this.ay[a], A.px, A.py, this.ax[b], this.ay[b], B.px, B.py);
      if (!crossing) this.cross[p] = 0;
      else if (this.cross[p] === 0) this.cross[p] = A.stamp >= B.stamp ? 1 : 2;
    }
  }
}



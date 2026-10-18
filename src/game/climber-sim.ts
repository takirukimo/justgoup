/**
 * ClimberSim: the four-limb climbing simulation behind STEIBOCK.
 *
 * Everything is wall-local 2D (metres, x right, y up). The sim is pure TypeScript and
 * deterministic: the same boulder + the same input/dt sequence gives the same result.
 * The body model follows docs/climbing-research.md (§2 biomechanics, §6 tuning table).
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
 * ANATOMICAL REACH ENVELOPE around the shoulder / hip (anatomy.ts: a foot at most ~0.17 m over the
 * hip and never straight up, a hand only a little way across the chest or down past the hips;
 * a contact that would leave it moves the chest / pelvis instead, a fresh grab at the edge of the
 * snap range eases the body in over SOFT_ATTACH), and soft in-plane minimums (SIM.armMinPlane /
 * legMinPlane: shoulders and hips sit off the wall, so a folded limb projects short). Velocities
 * come from the projected positions.
 * (The original "legs as rest-length springs" idea was replaced by the statically solved support:
 * radial leg springs push an off-centre body further sideways, an inverted-pendulum runaway.)
 *
 * ── Loads, capacity, stress (statics.ts, holds.ts) ───────────────────────────────────
 * Every step the current pose is solved statically: the weight is distributed over the
 * attached limbs by a capacity-weighted least-squares force balance (force + torque), plus the
 * out-of-plane "keep-in" pull the hands need (more on overhangs, more when crouched or when
 * the feet sit close below the hands). On overhangs the feet must toe-pull, which lowers
 * their capacity; on slabs the feet push harder and smears grip better.
 * Hand capacity = the research grip model (edge depth for edges / crimps, effective slope for
 * slopers, fingers for pockets, size) × pull-angle quality (direction hold → shoulder vs hold.angle,
 * per-type cone) × overhang factor × match × that FOREARM's pump × that hand's chalk friction ×
 * strength × assist. stress = load / capacity. Loads are smoothed (weight shifts take ~70 ms).
 *
 * ── Tension, shaking, slips, falls ───────────────────────────────────────────────────
 * tension = worst stress + balance (CoM outside the feet) + barn-door (contacts in a narrow
 * column with the CoM off to one side) + overstretch/crouch + core torque + reach strain.
 * Shaking: 'shake-start' above SIM.shakeOn (0.7), 'shake-end' below SIM.shakeOff (0.6).
 * Slip clock per limb: runs while stress > 1.05, at full speed (0.5 s to slip) from stress
 * 1.6; at stress 1.3 a slip takes ≈1.2 s, so shaking warns 1–2 s ahead. It drains when the
 * limb is back under capacity. A slipped limb detaches; if that leaves no hands or fewer
 * than two contacts the climber falls ('pump' when the slipping hand's forearm was spent / pumped,
 * 'barn-door' when the barn-door caused it, else 'slip'). Zero hands for longer than
 * SIM.noHandsGrace is a fall ('no-hands' / 'no-contact') — except in a dyno flight.
 *
 * ── Pump (forearm.ts), chalk, shake-outs ─────────────────────────────────────────────
 * Each hand has its own forearm: a critical-force / W′ model on the intensity load / fresh capacity
 * (+ lock-off and barn-door extras). Below CF it is near-sustainable, above it W′ drains (faster for
 * unbroken high-force grips: occlusion); free hands recover with a half-time (×1.3 shaking out), a
 * slow residual lowers CF on long climbs. The spent forearm's hand slips — no global pump meter;
 * ClimberState.pump is the max of LimbSnapshot.pump. 'pump-warning' when a forearm crosses SIM.pumpWarn.
 * Chalk: per-hand friction (1 fresh … 0 sweaty) wears with time on the wall and every hand move
 * (fast on lead, slow when bouldering) and costs capacity (slopers most, jugs least). chalkUp(hand),
 * or a hand dropped at the hips, dips it into the bag for SIM.chalkTime (busy; 'chalk-start' /
 * 'chalk-done' + 'return'). Shake-out: shakeOut(hand), or a hand dropped down beside the body while
 * the other hand holds well: it hangs by the side and recovers faster ('shake-out-start' / -end).
 *
 * ── Foot techniques ──────────────────────────────────────────────────────────────────
 * Inferred from where a foot goes (inferFootMode, re-checked every 0.25 s for rock-overs): heel hook
 * (at/above hip height out to the side on a steep wall), toe hook (a pull-able hold it can't stand on),
 * drop knee (a sidepull-like foothold facing away), flag (dropped over blank wall far out to the side,
 * or crossed behind on steep walls), edge / smear otherwise. The statics pull with hooks, turn the hip
 * in for a drop knee and use a flag as a counterweight (LimbSnapshot.footMode, 'technique' events).
 *
 * ── Deadpoints & dynos ───────────────────────────────────────────────────────────────
 * dyno(limb | 'both', holdId, power) or endDrag(limb, { velocity }) with a committed flick toward a
 * hold beyond the static reach: a ballistic flight (phase stays 'climbing', ClimberState.airborne /
 * flight) aimed to put the apex just past the hold, capped by the legs' remaining extension and the
 * arms. The hand closes near the apex if the catch's peak stress (static load × (1 + v²/2g·s)) holds;
 * else it misses — a deadpoint can fall back onto the hold it left, a dyno with no hands falls.
 * Events 'dyno-start' / 'dyno-catch' / 'dyno-miss'.
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

import type { BoulderDef, ClimberPhase, ClimberState, FlightInfo, FootMode, HoldDef, LimbId, LimbSnapshot, QuickdrawDef, Vec2 } from '../core/types';
import type { ClimberSimAPI, DynoPreview, FallReason, ReleaseOptions, SimEvent, SimOptions } from '../core/contracts';
import { BODY, GAME, SIM } from '../config/tuning';
import { clamp, clamp01, damp, DEG, smoothstep } from '../core/math';
import {
  canMatch,
  clipPoint,
  contactPoint,
  footModeFor,
  LIMB_IDS,
  LIMB_INDEX,
  maxReachIdx,
  placementBlocked,
  pumpCapFactor,
  startPlacement,
  type LimbContact,
  topHolds,
  usableByFoot,
  mountsByVolume,
  volumeYields,
  usableByHand,
} from './holds';
import { anatomicStrain, envClampOn, envelopePolygon, envEvalOn, envProjectOn, FOLD_K, PROJ_OUT, segmentsCross } from './anatomy';
import { angleAt, local3DToSurface, profileOf, smoothAngleAt, surfaceToLocal3D, worldHeight, type Vec3, type WallProfile } from './wall-profile';
import {
  computeAnchors,
  evaluateStance,
  FOOT_DROP,
  FOOT_HEEL,
  FOOT_PUSH,
  FOOT_TOE,
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
import { Forearm } from './forearm';

/**
 * ClimberSim construction options: the shared SimOptions plus Phase B body-model settings (kept out of
 * SimOptions so Required<SimOptions> users stay valid).
 */
export interface ClimberSimOptions extends SimOptions {
  /**
   * Climber strength: × hand capacity and faster forearm recovery (half-time ∝ strength^−1.6).
   * 1 = the default climber (≈0.52 BW on a 20 mm edge, research V3–V5 band); ≈1.6 a V6–V8 climber.
   */
  strength?: number;
  /** Sweat rate multiplier for chalk wear (1 = research rates, 1.5 ≈ a humid gym, 0 = chalk never wears). */
  sweat?: number;
}

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
  /** What keeps a busy hand busy: clipping a quickdraw or dipping into the chalk bag. */
  busyKind: 'clip' | 'chalk' | null;
  /** Hands: hanging free by the side, shaking the forearm out. */
  shakeOut: boolean;
  /** Hands: thrown at a hold in a dyno / deadpoint flight. */
  flying: boolean;
  /** Feet: how the attached foot is used (inferred from where it was put), null while free. */
  mode: FootMode | null;
  /** Feet: flagging (no hold; the leg is a counterweight). Offset of the foot from its hip in the body frame. */
  flag: boolean;
  flagO: number;
  flagU: number;
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
  /** Chalk dips during this climb. */
  chalkUps: number;
  /** Shake-outs started during this climb. */
  shakeOuts: number;
  /** Highest forearm pump reached (either hand). */
  maxPump: number;
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
/** A dragged foot's target turns the torso lean only while it is within this far (m) of reach. */
const FOOT_LEAN_REACH = 0.15;
/** Torso leans (rad, within statics.LEAN_MAX) the hip handle's feasibility search may assume. */
const HIP_LEANS = [0, -0.14, 0.14, -0.28, 0.28, -0.42, 0.42] as const;

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
    busyKind: null,
    shakeOut: false,
    flying: false,
    mode: null,
    flag: false,
    flagO: 0,
    flagU: 0,
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

/** A deadpoint / dyno in progress (ClimberSim.launch → flyStep → endFlight). */
interface Flight {
  kind: 'deadpoint' | 'dyno';
  /** Moving hand indices and, per entry, the target contact point. */
  hands: number[];
  limbs: LimbId[];
  hold: HoldDef;
  tx: number[];
  ty: number[];
  /** Per entry: settled (caught or missed), caught, ripped off, the target in reach last step, its excess. */
  done: boolean[];
  caught: boolean[];
  ripped: boolean[];
  inReach: boolean[];
  lastEx: number[];
  /** Per entry: the hold the hand left (a deadpoint may fall back onto it). */
  prev: (HoldDef | null)[];
  power: number;
  t: number;
  /** Predicted apex time, and the time the CoM really stopped rising (−1 until then). */
  tApex: number;
  apexAt: number;
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
    ...(id === 'LH' || id === 'RH' ? { pump: 0, friction: 1, shakingOut: false, chalking: false, flying: false, flightTarget: null } : {}),
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
  /** Holds bolted onto route volumes, by volume id (null: none). A foot next to one takes it, not the volume. */
  private readonly mounts: Map<string, HoldDef[]> | null;
  private readonly topIds: Set<string>;
  private readonly cth: number;
  private readonly sth: number;
  /** Folded wall (wall-profile.ts), null for a flat one. */
  private readonly prof: WallProfile | null;
  /**
   * cos / sin of the wall angle the body feels: the wall angle on a flat wall; on a folded wall the
   * stance's effective plane (statics), smoothed — in-plane gravity is g·gc, the pull off the wall g·gs.
   */
  private gc: number;
  private gs: number;
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
  /** Smoothed core torque of the static solution (body weights · m), applied as a spine couple. */
  private coreTq = 0;
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
  /** Folded walls: pelvis depth and the feet's surface y on the pad after landing. */
  private landDepth = 0.25;
  private padY = 0;
  private readonly v3: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly sp3 = { x: 0, y: 0, depth: 0 };

  private events: SimEvent[] = [];
  private readonly state: ClimberState;
  private readonly stats: SimStats = { slips: 0, maxTension: 0, shakeTime: 0, moves: 0, maxHeight: 0, chalkUps: 0, shakeOuts: 0, maxPump: 0 };

  // Phase B body model
  private readonly strength: number;
  private readonly sweatT: number;
  private readonly sweatM: number;
  /** Per-forearm W′ pump (index 0 LH, 1 RH). */
  private readonly forearms: [Forearm, Forearm];
  /** Pump / chalk friction per hand, shared with the statics params (per-hand capacity). */
  private readonly handPump = new Float64Array(2);
  private readonly handFric = new Float64Array([1, 1]);
  /**
   * Chalk wear per hand 0..1 (0 = fresh). friction = 1 − smoothstep(wear): a fresh chalk layer soaks up
   * the first sweat, then fades (research: bouldering noticeable only after ≈50 s / 10 moves).
   */
  private readonly chalkWear = new Float64Array(2);
  /** pumpCapFactor the statics applied to each hand this step (fresh capacity = cap / this). */
  private readonly capPumpF = new Float64Array([1, 1]);
  private readonly pumpWarned = [false, false];
  /** Signed barn-door amount of the last static solution. */
  private barnAmt = 0;
  /** Flagging legs for the statics: [onLF, xLF, yLF, onRF, xRF, yRF]. */
  private readonly flagArr = new Float64Array(6);
  /** Substeps until the next foot-technique re-check (rock-over onto a heel hook etc.). */
  private footTick = 0;
  /** Dyno / deadpoint in progress (phase stays 'climbing'). */
  private flight: Flight | null = null;
  private readonly flightInfo: FlightInfo = { kind: 'deadpoint', limbs: [], holdId: '', t: 0, apexIn: 0, power: 1 };

  constructor(boulder: BoulderDef, opts: ClimberSimOptions = {}) {
    this.boulder = boulder;
    this.assist = clamp01(opts.assist ?? 0);
    this.invincible = !!opts.invincible;
    this.strength = clamp(Number.isFinite(opts.strength) ? opts.strength! : 1, 0.4, 3);
    const sweat = Math.max(0, Number.isFinite(opts.sweat) ? opts.sweat! : 1);
    const rates = boulder.mode === 'rope' ? SIM.sweatLead : SIM.sweatBoulder;
    this.sweatT = rates.perSecond * sweat;
    this.sweatM = rates.perMove * sweat;
    this.forearms = [new Forearm(this.strength), new Forearm(this.strength)];
    this.holdById = new Map(boulder.holds.map((h) => [h.id, h] as const));
    this.handHolds = boulder.holds.filter(usableByHand);
    this.footHolds = boulder.holds.filter(usableByFoot);
    this.mounts = mountsByVolume(boulder.holds);
    this.topIds = new Set(topHolds(boulder).map((h) => h.id));
    this.cth = Math.cos(boulder.wallAngle * DEG);
    this.sth = Math.sin(boulder.wallAngle * DEG);
    this.prof = profileOf(boulder);
    this.gc = this.cth;
    this.gs = this.sth;
    this.isRope = boulder.mode === 'rope';
    this.draws = boulder.quickdraws ?? [];
    const fade = clamp01((boulder.grade - 3) / 8);
    this.postureHelp = Math.min(1, 1 - (1 - SIM.postureHardFrac) * fade + this.assist);
    this.prm = makeParams(boulder.wallAngle, this.assist, 0, this.prof);
    this.prmScratch = makeParams(boulder.wallAngle, this.assist, 0, this.prof);
    this.hipPrm = makeParams(boulder.wallAngle, this.assist, 0, this.prof);
    for (const prm of [this.prm, this.prmScratch, this.hipPrm]) {
      prm.strength = this.strength;
      prm.handPump = this.handPump;
      prm.handFric = this.handFric;
      prm.flags = this.flagArr;
    }
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
    for (let i = 0; i < 2; i++) {
      this.forearms[i].reset();
      this.handPump[i] = 0;
      this.handFric[i] = 1;
      this.chalkWear[i] = 0;
      this.capPumpF[i] = 1;
      this.pumpWarned[i] = false;
    }
    this.barnAmt = 0;
    this.flight = null;
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
    this.stats.chalkUps = 0;
    this.stats.shakeOuts = 0;
    this.stats.maxPump = 0;
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

  /**
   * Optional extra: the forearm model of a hand (forearm.ts) — W′ left, residual fatigue, the current
   * critical force and intensity. Read-only view for the HUD, debugging and tests.
   */
  forearm(hand: 'LH' | 'RH'): Readonly<Forearm> {
    return this.forearms[hand === 'LH' ? 0 : 1];
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
    if (this.phase !== 'climbing' || this.flight) return false;
    const i = LIMB_INDEX[limb];
    const L = this.limbs[i];
    if (L.busy || L.dragging) return false;
    const held = L.hold;
    const wasAttached = !!held || L.smear;
    if (L.flag) this.clearFlag(i);
    L.mode = null;
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
    if (L.shakeOut) this.endShakeOut(i);
    if (i < 2) this.forearms[i].release();
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

  endDrag(limb: LimbId, opts?: ReleaseOptions): SimEvent[] {
    const i = LIMB_INDEX[limb];
    const L = this.limbs[i];
    if (!L.dragging) return [];
    L.dragging = false;
    const out: SimEvent[] = [];
    if (this.phase !== 'climbing' || this.flight) return out;
    const p = { x: L.tx, y: L.ty };
    const intent = this.releaseTarget(limb, p);
    const hold = intent.hold;

    if (intent.clip) {
      const q = intent.clip;
      L.busy = true;
      L.busyKind = 'clip';
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

    if (!hold && i < 2 && opts?.velocity && !this.flight) {
      // a committed flick toward a hold beyond the static reach throws a deadpoint / dyno
      const thrown = this.flickThrow(i, p, opts.velocity);
      if (thrown) return thrown;
    }
    if (hold) {
      const quality = this.predictGrip(limb, hold.id);
      this.attach(i, hold);
      this.stats.moves++;
      // every hand move wears the chalk a little (research §6.5)
      if (i < 2) this.wearChalk(i, this.sweatM);
      out.push({ type: 'grab', limb, holdId: hold.id, quality });
      if (i < 2 && this.topIds.has(hold.id)) out.push({ type: 'top-touch', limb });
      if (i >= 2 && L.mode && L.mode !== 'edge') out.push({ type: 'technique', limb, technique: L.mode as 'heel' | 'toe' | 'drop' });
    } else if (i < 2 && this.releaseZone(i, p.x, p.y) === 'chalk' && this.startChalk(i, out)) {
      // reached back to the chalk bag (behind the hips)
    } else if (i < 2 && this.releaseZone(i, p.x, p.y) === 'shake' && this.canShakeOut(i)) {
      this.startShakeOut(i, out);
    } else if (i >= 2 && this.flagZone(i, p.x, p.y)) {
      this.setFlag(i, p.x, p.y);
      out.push({ type: 'technique', limb, technique: 'flag' });
    } else if (i >= 2 && this.smearableAt(p.y) && this.smearSpot(i, p.x, p.y) && this.smearableAt(this.smearTmp.y)) {
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

  // ═══════════════════════════════ chalk + shake-out ═══════════════════════════════

  /**
   * Chalk up: the hand lets go and dips into the chalk bag for SIM.chalkTime (busy, like clipping;
   * the other limbs hold the climber), then returns to its hold with fresh chalk (friction 1).
   * Events: 'release' (if it held a hold), 'chalk-start', later 'chalk-done' + 'return'. Refused while
   * the other hand isn't on a hold, during a flight, or when the hand is busy / dragged.
   */
  chalkUp(hand: 'LH' | 'RH'): boolean {
    const i = LIMB_INDEX[hand];
    if (i > 1 || this.phase !== 'climbing' || this.flight) return false;
    const L = this.limbs[i];
    if (L.busy || L.dragging) return false;
    const held = L.hold;
    if (held) {
      L.prevHold = held;
      L.prevSmear = false;
      L.prevX = L.cx;
      L.prevY = L.cy;
      L.hold = null;
      L.sfx = 0;
      L.sfy = 0;
      L.slipT = 0;
      L.overloaded = false;
      this.refreshMatch();
    }
    const out: SimEvent[] = [];
    if (!this.startChalk(i, out, !!held)) {
      if (held) {
        L.hold = held;
        this.refreshMatch();
      }
      return false;
    }
    if (held) this.events.push({ type: 'release', limb: hand, holdId: held.id });
    for (const e of out) this.events.push(e);
    this.syncState();
    return true;
  }

  /**
   * Shake out: the hand lets go of its hold and hangs by the side, recovering its forearm
   * SIM.forearm.shakeBoost × faster (research: +32 % reoxygenation). Only while the other hand holds a
   * good hold (the remaining stance's worst stress ≤ SIM.shakeOutMaxStress). The hand stays off until
   * it is dragged to a hold again. Events: 'release', 'shake-out-start' (… 'shake-out-end' on the drag).
   */
  shakeOut(hand: 'LH' | 'RH'): boolean {
    const i = LIMB_INDEX[hand];
    if (i > 1 || this.phase !== 'climbing' || this.flight) return false;
    const L = this.limbs[i];
    if (L.busy || L.dragging || L.shakeOut) return false;
    if (!this.canShakeOut(i)) return false;
    const held = L.hold;
    if (held) {
      L.prevHold = held;
      L.prevSmear = false;
      L.prevX = L.cx;
      L.prevY = L.cy;
      L.hold = null;
      L.sfx = 0;
      L.sfy = 0;
      L.slipT = 0;
      L.overloaded = false;
      this.refreshMatch();
      this.forearms[i].release();
      this.events.push({ type: 'release', limb: hand, holdId: held.id });
    }
    const out: SimEvent[] = [];
    this.startShakeOut(i, out);
    for (const e of out) this.events.push(e);
    this.syncState();
    return true;
  }

  /** Where a released hand's finger points when it isn't over a hold: the chalk bag, beside the body, or neither. */
  private releaseZone(i: number, x: number, y: number): 'chalk' | 'shake' | null {
    const u = this.frameNow();
    const P = this.P;
    // the chalk bag hangs behind the hips, a little below the pelvis
    const bx = P.x - u.x * 0.1;
    const by = P.y - u.y * 0.1;
    if (Math.hypot(x - bx, y - by) <= SIM.chalkZone) return 'chalk';
    // beside the body: well below the shoulder, on the hand's own side (not across the chest)
    const ax = this.ax[i];
    const ay = this.ay[i];
    const vx = x - ax;
    const vy = y - ay;
    const down = -(vx * u.x + vy * u.y);
    const side = i === 0 ? -1 : 1;
    const out = side * (vx * u.y - vy * u.x);
    // …where a hanging arm is: between shakeOutDrop and a little past arm's length below the shoulder
    if (down >= SIM.shakeOutDrop && down <= BODY.armMax + 0.15 && out >= -0.05 && out <= 0.4) return 'shake';
    return null;
  }

  /** Can hand i let go to shake out: the other hand on a hold and the remaining stance holding well? */
  private canShakeOut(i: number): boolean {
    const o = this.limbs[1 - i];
    if (!o.hold || o.dragging || o.busy) return false;
    this.buildContacts();
    const saved = this.contacts[i];
    this.contacts[i] = null;
    this.syncPose();
    const prm = this.prmScratch;
    prm.reachLimb = -1;
    prm.maxPelvisY = Infinity;
    const ev = evaluateStance(this.pose, this.contacts, prm, this.evScratch);
    this.contacts[i] = saved;
    return ev.feasible && ev.worstStress <= SIM.shakeOutMaxStress;
  }

  private startShakeOut(i: number, out: SimEvent[]): void {
    const L = this.limbs[i];
    L.shakeOut = true;
    this.stats.shakeOuts++;
    out.push({ type: 'shake-out-start', limb: LIMB_IDS[i] });
    // hold still on the other three limbs
    this.retarget();
  }

  private endShakeOut(i: number): void {
    const L = this.limbs[i];
    if (!L.shakeOut) return;
    L.shakeOut = false;
    this.events.push({ type: 'shake-out-end', limb: LIMB_IDS[i] });
  }

  /**
   * Start a chalk dip of hand i (already off its hold; `returnAfter` = go back to L.prevHold after).
   * Needs the other hand on a hold. Pushes 'chalk-start' to `out`.
   */
  private startChalk(i: number, out: SimEvent[], returnAfter = true): boolean {
    const L = this.limbs[i];
    const o = this.limbs[1 - i];
    if (!o.hold || o.dragging || o.busy || this.phase !== 'climbing') return false;
    if (L.shakeOut) this.endShakeOut(i);
    L.busy = true;
    L.busyKind = 'chalk';
    L.busyT = SIM.chalkTime;
    L.busyDraw = null;
    if (!returnAfter) L.prevHold = null;
    this.stats.chalkUps++;
    out.push({ type: 'chalk-start', limb: LIMB_IDS[i] });
    // hold still while the hand is in the bag: the other three limbs keep the current position
    this.posture.px = this.P.x;
    this.posture.py = this.P.y;
    this.postureOn = true;
    return true;
  }

  // ═══════════════════════════════ deadpoints + dynos ═══════════════════════════════

  /**
   * Throw at a hold (research §2.5): 'LH' / 'RH' is a deadpoint (the other hand stays on its hold, the
   * feet stay on when the legs allow, else they cut), 'both' a double-hand dyno (both hands and the feet
   * leave; best from a crouch). The body follows a ballistic arc aimed so its apex lands the hand just
   * past the hold; `power` scales the launch (1 = ideal; < ≈0.95 falls short, more overshoots), capped by
   * what the legs (crouch depth) and arms can produce. The hand closes on the hold near the apex if the
   * catch's peak stress stays under SIM.dynoCatchStress (it costs a pump spike); otherwise it misses —
   * a deadpoint may fall back onto the hold it left, a dyno with no hand left falls ('no-hands').
   * Events: 'release'…, 'dyno-start', later 'grab' + 'dyno-catch' or 'dyno-miss' (+ 'return' / 'fall').
   * Returns the launch events ([] when refused: wrong phase, a flight in progress, a busy hand, no other
   * hand on a hold for a deadpoint, a target a double dyno can't share).
   */
  dyno(limb: 'LH' | 'RH' | 'both', holdId: string, power = 1): SimEvent[] {
    if (this.phase !== 'climbing' || this.flight) return [];
    const h = this.holdById.get(holdId);
    if (!h || !usableByHand(h)) return [];
    const hands = limb === 'both' ? [0, 1] : [LIMB_INDEX[limb]];
    if (hands[0] > 1) return [];
    for (const i of hands) if (this.limbs[i].busy) return [];
    if (hands.length === 2 && !canMatch(0, h)) return [];
    if (hands.length === 1) {
      const o = this.limbs[1 - hands[0]];
      if (!o.hold || o.busy || o.dragging) return [];
    }
    for (const i of hands) this.limbs[i].dragging = false;
    return this.launch(hands, h, Number.isFinite(power) ? clamp(power, 0.2, 2) : 1);
  }

  /** What a committed flick of the dragged hand released at p would throw to (input preview), or null. */
  dynoCandidate(limb: LimbId, p: Vec2): DynoPreview | null {
    const i = LIMB_INDEX[limb];
    if (i > 1 || this.phase !== 'climbing' || this.flight) return null;
    const h = this.dynoTarget(i, p.x, p.y);
    if (!h) return null;
    const o = this.limbs[1 - i];
    const both = o.dragging && this.dynoTarget(1 - i, o.tx, o.ty) === h && canMatch(0, h);
    const hands = both ? [0, 1] : [i];
    const plan = this.throwPlan(hands, h, 1);
    return { holdId: h.id, kind: both || !(o.hold && !o.busy) ? 'dyno' : 'deadpoint', rise: plan.rise, feasible: plan.need <= plan.vmax + 1e-9 };
  }

  /** A usable hand hold near (x, y) beyond the static reach of hand i but within throwing range, or null. */
  private dynoTarget(i: number, x: number, y: number): HoldDef | null {
    const u = this.frameNow();
    const tmp = this.qTmp;
    let best: HoldDef | null = null;
    let bestD = Infinity;
    for (const h of this.handHolds) {
      const d = Math.hypot(x - h.x, y - h.y) - h.size;
      if (d > GAME.snapRadius || d >= bestD) continue;
      contactPoint(h, i, this.wouldMatch(i, h), tmp);
      const ex = envEvalOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, tmp.x, tmp.y).excess;
      if (ex <= SIM.reachTolerance || ex > SIM.dynoMaxReach) continue;
      if (this.blocked(i, tmp.x, tmp.y, h)) continue;
      best = h;
      bestD = d;
    }
    return best;
  }

  /** endDrag with a release velocity: throw when the flick commits toward an out-of-reach hold. */
  private flickThrow(i: number, p: Vec2, v: Vec2): SimEvent[] | null {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    const h = this.dynoTarget(i, p.x, p.y);
    if (!h) return null;
    const L = this.limbs[i];
    const tmp = contactPoint(h, i, false, this.releaseTmp);
    const dx = tmp.x - L.px;
    const dy = tmp.y - L.py;
    const len = Math.hypot(dx, dy) || 1;
    const along = (v.x * dx + v.y * dy) / len;
    if (along < SIM.dynoMinFlick) return null;
    const power = clamp(along / SIM.dynoFlickRef, 0.6, 1.4);
    const o = this.limbs[1 - i];
    // the other hand flicked at the same hold too (multi-touch): a double dyno
    if (o.dragging && !o.busy && canMatch(0, h) && this.dynoTarget(1 - i, o.tx, o.ty) === h) {
      o.dragging = false;
      return this.launch([0, 1], h, power);
    }
    if (o.busy) return null;
    return this.launch([i], h, power);
  }

  /** Most launch speed (m/s) the climber can produce now: legs over their remaining extension + arms. */
  private launchSpeedMax(): number {
    let ext = 0;
    let nf = 0;
    for (let i = 2; i < 4; i++) {
      const L = this.limbs[i];
      if (!(L.hold || L.smear) || L.dragging) continue;
      ext += Math.max(0, BODY.legMax * 0.97 - Math.hypot(this.ax[i] - L.cx, this.ay[i] - L.cy));
      nf++;
    }
    const legs = nf ? Math.sqrt(2 * SIM.dynoLegAccel * (ext / nf)) * (1 - SIM.dynoSteepLegLoss * Math.max(0, this.gs)) : 0;
    let nh = 0;
    for (let i = 0; i < 2; i++) if (this.limbs[i].hold && !this.limbs[i].busy) nh++;
    const arms = Math.sqrt(2 * SIM.dynoArmAccel * SIM.dynoArmExt * this.strength * Math.max(nh, 1) * 0.5);
    return Math.sqrt(legs * legs + arms * arms);
  }

  private readonly planOut = { vx: 0, vy: 0, tApex: 0, rise: 0, speed: 0, need: 0, vmax: 0, tx: [0, 0], ty: [0, 0] };

  /**
   * Ballistic launch for moving hands toward h: the body displacement that brings each hand inside its
   * envelope (+SIM.dynoMargin), an apex SIM.dynoAimPast past it, scaled by power and capped at the
   * climber's launch speed. Reuses its output object.
   */
  private throwPlan(hands: number[], h: HoldDef, power: number): typeof this.planOut {
    const u = this.frameNow();
    const o = this.planOut;
    const both = hands.length === 2;
    let Dx = 0;
    let Dy = 0;
    for (let k = 0; k < hands.length; k++) {
      const i = hands[k];
      const c = contactPoint(h, i, both, this.releaseTmp);
      o.tx[k] = c.x;
      o.ty[k] = c.y;
      const en = envEvalOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, c.x, c.y);
      const vx = c.x - this.ax[i];
      const vy = c.y - this.ay[i];
      const l = Math.hypot(vx, vy) || 1;
      const need = en.excess > 0 ? en.excess + SIM.dynoMargin : 0;
      Dx += (vx / l) * need;
      Dy += (vy / l) * need;
    }
    Dx /= hands.length;
    Dy /= hands.length;
    o.rise = Math.hypot(Dx, Dy);
    const gp = Math.max(0.5, SIM.gravity * this.gc);
    const hop = Math.max(Dy + SIM.dynoAimPast, SIM.dynoMinHop, SIM.dynoLateralHop * Math.abs(Dx));
    let vy = Math.sqrt(2 * gp * hop);
    let vx = Dx / (vy / gp);
    // the climber aims for the hold: extra commitment adds a little height (jumping past the hold is
    // good, research [37]), too little falls short
    const p = power > 1 ? 1 + 0.4 * (power - 1) : power;
    vx *= p;
    vy *= p;
    o.vmax = this.launchSpeedMax();
    let sp = Math.hypot(vx, vy);
    o.need = sp;
    if (sp > o.vmax) {
      vx *= o.vmax / sp;
      vy *= o.vmax / sp;
      sp = o.vmax;
    }
    o.vx = vx;
    o.vy = vy;
    o.speed = sp;
    o.tApex = Math.max(0.04, vy / gp);
    return o;
  }

  private launch(hands: number[], h: HoldDef, power: number): SimEvent[] {
    const out: SimEvent[] = [];
    const plan = this.throwPlan(hands, h, power);
    const both = hands.length === 2;
    const u = this.frameNow();
    // where the body will be at the apex (rigid shift), to see which contacts can stay on
    const gp = Math.max(0.5, SIM.gravity * this.gc);
    const sx = plan.vx * plan.tApex;
    const sy = plan.vy * plan.tApex - 0.5 * gp * plan.tApex * plan.tApex;
    let kind: 'deadpoint' | 'dyno' = both ? 'dyno' : 'deadpoint';
    let feetOn = 0;
    for (let i = 2; i < 4; i++) if ((this.limbs[i].hold || this.limbs[i].smear) && !this.limbs[i].dragging) feetOn++;
    // the launch work (feet ≈1.8× the hands; campusing it is all arms)
    const effort = plan.vmax > 0 ? (plan.speed / plan.vmax) * (plan.speed / plan.vmax) : 1;
    for (let i = 0; i < 2; i++) if (this.limbs[i].hold) this.forearms[i].spend(SIM.dynoLaunchPump * effort * (feetOn ? 1 : 2));
    const prev: (HoldDef | null)[] = [];
    for (const i of hands) {
      const L = this.limbs[i];
      prev.push(L.hold ?? L.prevHold);
      if (L.hold) {
        L.prevHold = L.hold;
        out.push({ type: 'release', limb: LIMB_IDS[i], holdId: L.hold.id });
      }
      if (L.shakeOut) {
        L.shakeOut = false;
        out.push({ type: 'shake-out-end', limb: LIMB_IDS[i] });
      }
      L.hold = null;
      L.dragging = false;
      L.flying = true;
      L.slipT = 0;
      this.forearms[i].release();
    }
    // the other hand of a deadpoint stays on if its arm reaches from the apex, else it lets go too
    if (!both) {
      const j = 1 - hands[0];
      const O = this.limbs[j];
      if (O.hold && envEvalOn(this.prof, j, this.ax[j] + sx, this.ay[j] + sy, u.x, u.y, O.cx, O.cy).excess > 0.06) {
        out.push({ type: 'release', limb: LIMB_IDS[j], holdId: O.hold.id });
        O.prevHold = O.hold;
        O.hold = null;
        kind = 'dyno';
      }
    }
    // feet: a dyno leaves the wall; a deadpoint keeps the feet the legs can still reach at the apex
    for (let i = 2; i < 4; i++) {
      const L = this.limbs[i];
      if (!(L.hold || L.smear) || L.dragging) continue;
      const stay = kind === 'deadpoint' && envEvalOn(this.prof, i, this.ax[i] + sx, this.ay[i] + sy, u.x, u.y, L.cx, L.cy).excess <= 0.03;
      if (stay) continue;
      out.push({ type: 'release', limb: LIMB_IDS[i], holdId: L.hold ? L.hold.id : null });
      L.prevHold = L.hold;
      L.prevSmear = L.smear;
      L.hold = null;
      L.smear = false;
      L.mode = null;
    }
    for (const L of this.limbs) {
      if (L.flag) L.flag = false;
      L.sfx = 0;
      L.sfy = 0;
    }
    this.refreshMatch();
    // the throw
    this.Pv.x = this.Cv.x = plan.vx;
    this.Pv.y = this.Cv.y = plan.vy;
    this.hipTarget = null;
    this.postureOn = false;
    this.noHandsT = 0;
    const limbs = hands.map((i) => LIMB_IDS[i]);
    this.flight = {
      kind,
      hands: hands.slice(),
      limbs,
      hold: h,
      tx: plan.tx.slice(0, hands.length),
      ty: plan.ty.slice(0, hands.length),
      done: hands.map(() => false),
      caught: hands.map(() => false),
      ripped: hands.map(() => false),
      inReach: hands.map(() => false),
      lastEx: hands.map(() => Infinity),
      prev,
      power,
      t: 0,
      tApex: plan.tApex,
      apexAt: -1,
    };
    out.push({ type: 'dyno-start', limbs: limbs.slice(), holdId: h.id, kind, power });
    this.syncState();
    return out;
  }

  /** One fixed step of a flight: ballistic body, hands reaching, catch near the apex or miss. */
  private flyStep(h: number): void {
    const F = this.flight!;
    F.t += h;
    this.time += h;
    this.updateBusy(h);
    this.integrateBody(h, 1);
    this.syncPose();
    computeAnchors(this.pose, this.ax, this.ay);
    this.updateEndpoints(h);
    this.buildContacts();
    this.updateForearms(h);
    if (this.P.y > this.stats.maxHeight) this.stats.maxHeight = this.P.y;
    const u = this.frameNow();
    const vy = this.Pv.y * MP + this.Cv.y * MC;
    if (F.apexAt < 0 && vy <= 0) F.apexAt = F.t;
    // which hands can close on the hold now: in reach and near the apex (or about to pass it)
    const ready: number[] = [];
    for (let k = 0; k < F.hands.length; k++) {
      if (F.done[k]) continue;
      const i = F.hands[k];
      const ex = envEvalOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, F.tx[k], F.ty[k]).excess;
      const inReach = ex <= SIM.dynoCatchTol;
      const leaving = F.inReach[k] && ex > F.lastEx[k] + 1e-4;
      if (inReach && (vy <= SIM.dynoGrabVy || leaving || F.apexAt >= 0)) ready.push(k);
      F.inReach[k] = inReach;
      F.lastEx[k] = ex;
    }
    if (ready.length) this.tryCatch(ready);
    const apex = F.apexAt >= 0 ? F.apexAt : F.tApex;
    if (F.t > apex + SIM.dynoLate || F.t > SIM.dynoMaxFlight) for (let k = 0; k < F.hands.length; k++) F.done[k] = true;
    if (F.done.every((d) => d)) this.endFlight();
  }

  /** The hands in `ks` (indices into the flight) close on the hold together; each holds or rips off. */
  private tryCatch(ks: number[]): void {
    const F = this.flight!;
    for (const k of ks) {
      const i = F.hands[k];
      this.attach(i, F.hold);
      this.limbs[i].flying = false;
    }
    this.buildContacts();
    this.syncPose();
    const prm = this.prmScratch;
    prm.reachLimb = -1;
    prm.maxPelvisY = Infinity;
    const ev = evaluateStance(this.pose, this.contacts, prm, this.evScratch);
    const vx = this.Pv.x * MP + this.Cv.x * MC;
    const vy = this.Pv.y * MP + this.Cv.y * MC;
    const v2 = vx * vx + vy * vy;
    // the arm absorbs the body's remaining speed over its flex: the peak finger load (research 1.1–1.6 BW)
    const dyn = 1 + v2 / (2 * SIM.gravity * SIM.dynoAbsorb);
    const apex = F.apexAt >= 0 ? F.apexAt : F.tApex;
    const timing = F.t - apex;
    const caughtLimbs: LimbId[] = [];
    let worst = 0;
    for (const k of ks) {
      const i = F.hands[k];
      const L = this.limbs[i];
      const load = (ev.feasible ? ev.load[i] : ks.length > 1 ? 0.5 : 1) * dyn;
      const peak = load / Math.max(ev.cap[i], 0.01);
      worst = Math.max(worst, peak);
      F.done[k] = true;
      this.forearms[i].spend(SIM.dynoCatchPump * peak * peak);
      if (peak <= SIM.dynoCatchStress) {
        F.caught[k] = true;
        caughtLimbs.push(LIMB_IDS[i]);
        L.age = 0;
        L.attachGap = 0;
        this.stats.moves++;
        this.wearChalk(i, this.sweatM);
      } else {
        // ripped off: the fingers can't stop the body
        F.ripped[k] = true;
        L.hold = null;
        L.flying = false;
      }
    }
    this.refreshMatch();
    if (caughtLimbs.length) {
      const quality = clamp01(1 - (0.6 * Math.max(0, worst - 0.6)) / (SIM.dynoCatchStress - 0.6) - 0.4 * clamp01(Math.abs(timing) / 0.25));
      for (const limb of caughtLimbs) {
        this.events.push({ type: 'grab', limb, holdId: F.hold.id, quality });
        if (this.topIds.has(F.hold.id)) this.events.push({ type: 'top-touch', limb });
      }
      this.events.push({ type: 'dyno-catch', limbs: caughtLimbs, holdId: F.hold.id, quality, timing });
    }
  }

  /** The flight is over: misses fall back (deadpoint) or fall; caught throws settle into the stance. */
  private endFlight(): void {
    const F = this.flight!;
    this.flight = null;
    const missed: LimbId[] = [];
    let ripped = false;
    for (let k = 0; k < F.hands.length; k++) {
      if (F.caught[k]) continue;
      const i = F.hands[k];
      this.limbs[i].flying = false;
      missed.push(LIMB_IDS[i]);
      if (F.ripped[k]) ripped = true;
    }
    if (F.caught.some((c) => c)) {
      // the arms absorb the throw
      this.Pv.x *= SIM.dynoKeep;
      this.Pv.y *= SIM.dynoKeep;
      this.Cv.x *= SIM.dynoKeep;
      this.Cv.y *= SIM.dynoKeep;
    }
    if (missed.length) {
      this.events.push({ type: 'dyno-miss', limbs: missed, holdId: F.hold.id, reason: ripped ? 'ripped' : 'short' });
      // a deadpoint can fall back onto the hold it left while the other hand still holds
      for (let k = 0; k < F.hands.length; k++) {
        if (F.caught[k]) continue;
        const i = F.hands[k];
        const prev = F.prev[k];
        const o = this.limbs[1 - i];
        if (F.kind !== 'deadpoint' || !prev || !o.hold) continue;
        this.frameNow();
        const tmp = contactPoint(prev, i, this.wouldMatch(i, prev), this.qTmp);
        if (this.reachOk(i, tmp.x, tmp.y, SIM.reachTolerance + 0.12) && !this.blocked(i, tmp.x, tmp.y, prev)) {
          this.attach(i, prev);
          this.forearms[i].spend(SIM.dynoCatchPump);
          this.events.push({ type: 'return', limb: LIMB_IDS[i], holdId: prev.id });
        }
      }
    }
    this.buildContacts();
    if (!this.contacts[0] && !this.contacts[1]) {
      this.fall('no-hands');
      return;
    }
    this.noHandsT = 0;
    this.retarget();
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
      if (i >= 2 && volumeYields(h, p.x, p.y, this.mounts)) continue;
      contactPoint(h, i, this.wouldMatch(i, h), tmp);
      if (!this.reachOk(i, tmp.x, tmp.y, SIM.reachTolerance)) continue;
      if (this.blocked(i, tmp.x, tmp.y, h)) continue;
      best = h;
      bestD = d;
    }
    return best;
  }

  private readonly releaseOut: { hold: HoldDef | null; clip: QuickdrawDef | null } = { hold: null, clip: null };
  private readonly releaseTmp = { x: 0, y: 0 };

  /**
   * Optional extra (not in ClimberSimAPI): what releasing `limb` at `p` does right now — clip the
   * quickdraw `clip` (rope, a hand), grab the hold `hold`, or neither (smear / return). At most one
   * of the two is set. endDrag() acts on exactly this, and the input layer previews it, so the
   * reticle never says CLIP while the release grabs a hold (or the other way round). With a hold
   * and a draw both in range, the release point picks the nearer of the hold's grip point (where
   * the hand closes) and the draw's clip point (where the rope goes in). Returns a reused object.
   */
  releaseTarget(limb: LimbId, p: Vec2): { hold: HoldDef | null; clip: QuickdrawDef | null } {
    const out = this.releaseOut;
    const i = LIMB_INDEX[limb];
    const hold = this.snapCandidate(limb, p);
    out.hold = hold;
    out.clip = null;
    if (i >= 2 || !this.isRope) return out;
    const q = this.clipCandidate(limb, p);
    if (!q) return out;
    const cp = clipPoint(q, this.releaseTmp);
    const clipD = Math.hypot(p.x - cp.x, p.y - cp.y);
    let holdD = Infinity;
    if (hold) {
      const g = contactPoint(hold, i, this.wouldMatch(i, hold), this.releaseTmp);
      holdD = Math.hypot(p.x - g.x, p.y - g.y);
    }
    if (clipD <= holdD) {
      out.hold = null;
      out.clip = q;
    }
    return out;
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
      if (envEvalOn(this.prof, i, a.x, a.y, u.x, u.y, cp.x, cp.y).excess > GAME.clipRadius) continue;
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
      L.busyKind = null;
      L.shakeOut = false;
      L.dragging = false;
    }
    this.flight = null;
    this.placeLimbs(place, false);
    this.settle(0.8);
    this.phase = 'climbing';
    this.shaking = false;
    this.noHandsT = 0;
    this.matchT = 0;
    this.decked = false;
    this.ropeTaut = false;
    // hanging on the rope: the forearms got a rest and the climber chalked up
    for (let i = 0; i < 2; i++) {
      const fa = this.forearms[i];
      fa.w = Math.min(1, fa.w + 0.2);
      fa.exhausted = false;
      this.handPump[i] = fa.pump;
      this.chalkWear[i] = 0;
      this.handFric[i] = 1;
    }
    this.pump = Math.max(this.handPump[0], this.handPump[1]);
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
    return envEvalOn(this.prof, i, this.ax[i], this.ay[i], this.upTmp.x, this.upTmp.y, x, y).excess <= tol;
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
    const c = envClampOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, x, y, 0);
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
      L.flag = false;
      L.mode = this.inferFootMode(i, h, L.cx, L.cy, null);
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
    L.flag = false;
    L.mode = 'smear';
    this.measureGap(i);
  }

  // ═══════════════════════════════ foot techniques ═══════════════════════════════

  /**
   * How a foot on hold h at contact (cx, cy) is used, from where it is relative to its hip (research
   * §2.2/§2.3), with hysteresis against `current` (null = a fresh placement):
   *  • heel — a pull-able hold the foot can't stand on (its good direction points toward the hip) at /
   *    above hip height and out to the side, on a wall of SIM.heelMinAngle or steeper,
   *  • toe — the same kind of hold further away / lower (a toe pulling under a lip, the far side of a
   *    feature), from SIM.toeMinAngle,
   *  • drop — a sidepull-like foothold out to the side below the hip, facing away from the body (the
   *    knee turns in, the hip goes to the wall),
   *  • edge — everything else (standing on it).
   */
  private inferFootMode(i: number, h: HoldDef, cx: number, cy: number, current: FootMode | null): FootMode {
    this.frameNow();
    return footModeFor(h, cx, cy, this.ax[i], this.ay[i], this.P.x, this.techAngle(cy), current);
  }

  /**
   * Wall angle (degrees) a foot technique at surface height y sees: the wall angle on a flat wall; on a
   * folded wall the steeper of the panel under the foot and the wall under the body (a heel hook on a
   * lip panel above a roof is still a roof move).
   */
  private techAngle(y: number): number {
    const prof = this.prof;
    if (!prof) return this.boulder.wallAngle;
    const comY = this.P.y + BODY.comT * (this.C.y - this.P.y);
    return Math.max(angleAt(prof, y), smoothAngleAt(prof, comY));
  }

  /** Can a foot smear at surface height y (its panel ≤ SIM.smearMaxAngle)? */
  private smearableAt(y: number): boolean {
    return (this.prof ? angleAt(this.prof, y) : this.boulder.wallAngle) <= SIM.smearMaxAngle;
  }

  /** Re-check the attached feet's techniques (a rock-over turns a heel hook into a standing foot). */
  private updateFootModes(): void {
    for (let i = 2; i < 4; i++) {
      const L = this.limbs[i];
      if (!L.hold || L.dragging) continue;
      const m = this.inferFootMode(i, L.hold, L.cx, L.cy, L.mode);
      if (m === L.mode) continue;
      L.mode = m;
      if (m !== 'edge' && this.phase === 'climbing') this.events.push({ type: 'technique', limb: LIMB_IDS[i], technique: m as 'heel' | 'toe' | 'drop' });
    }
  }

  /**
   * Is a foot released over blank wall at (x, y) a flag? Out to the side of its hip (≥ SIM.flagReach):
   * about level with the hip on walls that take a smear, anywhere from hip height down on steeper ones;
   * on walls too steep to smear also crossed behind the other leg (a back flag).
   */
  private flagZone(i: number, x: number, y: number): boolean {
    this.frameNow();
    // wall frame (what the player sees): out to the side of the hip, height relative to the hip
    const side = i === 2 ? -1 : 1;
    const out = side * (x - this.ax[i]);
    const up = y - this.ay[i];
    const smearable = this.smearableAt(this.ay[i]);
    // where a smear works (vertical / slab) only a leg held out about level with the hip flags
    if (out >= SIM.flagReach && up <= 0.3 && up >= (smearable ? -0.05 : -0.55)) return true;
    if (smearable) return false;
    const across = side * (x - this.P.x);
    return across <= -0.12 && up <= -0.15 && up >= -0.9;
  }

  private setFlag(i: number, x: number, y: number): void {
    const L = this.limbs[i];
    const u = this.frameNow();
    // the foot stays where the leg can be (inside its envelope), relative to the hip (it moves with the body)
    const c = envClampOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, x, y, 0);
    const vx = c.x - this.ax[i];
    const vy = c.y - this.ay[i];
    const side = i === 2 ? -1 : 1;
    L.flag = true;
    L.mode = 'flag';
    L.flagU = vx * u.x + vy * u.y;
    L.flagO = side * (vx * u.y - vy * u.x);
    L.hold = null;
    L.smear = false;
    L.stamp = ++this.stampSeq;
  }

  private clearFlag(i: number): void {
    const L = this.limbs[i];
    L.flag = false;
    if (L.mode === 'flag') L.mode = null;
    const j = (i - 2) * 3;
    this.flagArr[j] = 0;
  }

  /** Flagging feet → the statics' counterweight array (from the rendered foot positions). */
  private syncFlags(): void {
    for (let i = 2; i < 4; i++) {
      const L = this.limbs[i];
      const j = (i - 2) * 3;
      if (L.flag && !L.dragging) {
        this.flagArr[j] = 1;
        this.flagArr[j + 1] = L.px;
        this.flagArr[j + 2] = L.py;
      } else this.flagArr[j] = 0;
    }
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
    L.attachGap = Math.min(envProjectOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, L.cx, L.cy), SIM.reachTolerance + 0.35);
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
      L.busyKind = null;
      L.shakeOut = false;
      L.flag = false;
      L.mode = null;
      L.flying = false;
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
      const smY = Math.max(GAME.padHeight + 0.15, init.py - 0.62);
      if (!L.hold && this.smearableAt(smY) && (this.limbs[0].hold || this.limbs[1].hold)) {
        const side = i === 2 ? -1 : 1;
        this.attachSmear(i, init.px + side * 0.2, smY);
        L.age = 10;
      }
    }
    this.buildContacts();
    initialPose(this.contacts, this.prm, init);
    const best: Pose = { px: 0, py: 0, cx: 0, cy: 0 };
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
      if (this.smearableAt(Math.max(GAME.padHeight + 0.15, best.py - 0.62))) {
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
    if (this.prof) {
      // the effective plane of the settled start stance (statics.evaluateStance of the best pose)
      evaluateStance(best, this.contacts, this.prm, this.evScratch);
      this.gc = this.evScratch.cth;
      this.gs = this.evScratch.sth;
    }
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
    // foot techniques from the settled pose (attach() saw the old one)
    for (let i = 2; i < 4; i++) {
      const L = this.limbs[i];
      if (L.hold) L.mode = this.inferFootMode(i, L.hold, L.cx, L.cy, null);
    }
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
    this.coreTq = this.ev.feasible ? this.ev.torque : 0;
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
        c.mode = i < 2 || !L.hold ? FOOT_PUSH : L.mode === 'heel' ? FOOT_HEEL : L.mode === 'toe' ? FOOT_TOE : L.mode === 'drop' ? FOOT_DROP : FOOT_PUSH;
        this.contacts[i] = c;
      } else this.contacts[i] = null;
    }
  }

  /**
   * Pick the spine lean that minimises tension for the current pelvis position, keeping a dragged
   * limb's target inside its envelope where a lean can: the torso leans into a reaching hand, and
   * turns the hips so a foot can step to a target that is nearly in range — the same lean the
   * planner's reach pose uses (statics.optimizePose), so a planned high step is reachable live. A
   * foot pointed far out of range doesn't tilt the torso over (StaticsParams.reachCap).
   */
  private updateLean(): void {
    this.buildContacts();
    let reachLimb = -1;
    for (let i = 0; i < 4; i++)
      if (this.limbs[i].dragging) {
        reachLimb = i;
        break;
      }
    const prm = this.prmScratch;
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
    prm.reachCap = reachLimb >= 2 ? FOOT_LEAN_REACH : Infinity;
    bestLean(this.contacts, prm, this.P.x, this.P.y, this.evScratch, this.leanPose, this.lean);
    prm.reachMargin = 0;
    prm.reachCap = Infinity;
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
        if (this.flight) this.flyStep(h);
        else this.climbStep(h, 1);
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
    if (this.footTick-- <= 0) {
      this.footTick = 30;
      this.updateFootModes();
    }
    this.syncFlags();
    this.buildContacts();

    // statics
    let reachLimb = -1;
    for (let i = 0; i < 4; i++)
      if (this.limbs[i].dragging) {
        reachLimb = i;
        break;
      }
    this.prm.reachLimb = reachLimb;
    for (let i = 0; i < 2; i++) this.capPumpF[i] = pumpCapFactor(this.handPump[i]);
    if (reachLimb >= 0) {
      this.prm.reachX = this.limbs[reachLimb].tx;
      this.prm.reachY = this.reachY(reachLimb);
    }
    const ev = evaluateStance(this.pose, this.contacts, this.prm, this.ev);
    const k = 1 - Math.exp(-SIM.loadSmoothing * h);
    const ks = 1 - Math.exp(-SIM.supportSmoothing * h);
    if (this.prof && ev.handsOn + ev.feetOn > 0) {
      // a folded wall: the body feels the stance's effective plane (it changes as limbs cross folds)
      this.gc += (ev.cth - this.gc) * ks;
      this.gs += (ev.sth - this.gs) * ks;
    }
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
    this.coreTq += ((ev.feasible ? ev.torque : 0) - this.coreTq) * ks;
    const rawT = worst + ev.balancePen + ev.barnPen + ev.stretchPen + ev.corePen + ev.reachPen;
    this.tension += (rawT - this.tension) * k;
    this.balance = ev.balance;
    this.barnPen = ev.barnPen;
    this.barnAmt = ev.barn;
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
      if (i < 2 && this.contacts[i]) s += 0.35 * smoothstep(0.6, 1, this.handPump[i]);
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

    this.updateForearms(h);
    this.updateSweat(h);
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
    let apy = -g * this.gc;
    let acx = 0;
    let acy = -g * this.gc;

    // support: feet push with their full static force, hands only pull along the arm, so a
    // body that hangs off-plumb swings until the arms can hold it. Each force acts where it really
    // acts — a hand's pull along the arm through its shoulder, a foot's push at the toe — not at the
    // node that carries it: the difference is a pure couple on the spine (with the core torque the
    // statics allowed), so the statically solved pose, torso lean included, is an equilibrium of
    // the dynamics instead of the torso drooping toward the hands.
    // in a dyno / deadpoint flight the body is ballistic: no support forces, no posture, little damping
    const fly = this.flight !== null;
    let couple = fly ? 0 : this.coreTq;
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      if (fly || (L.sfx === 0 && L.sfy === 0)) continue;
      if (i < 2) {
        acx += (L.sfx * g) / MC;
        acy += (L.sfy * g) / MC;
        couple += (ax[i] - C.x) * L.sfy - (ay[i] - C.y) * L.sfx;
      } else {
        apx += (L.sfx * g) / MP;
        apy += (L.sfy * g) / MP;
        couple += (L.cx - P.x) * L.sfy - (L.cy - P.y) * L.sfx;
      }
    }
    if (couple !== 0 && SIM.supportCouple > 0) {
      // ±F perpendicular to the spine on chest / pelvis: torque F·spine, no net force
      const sx = C.x - P.x;
      const sy = C.y - P.y;
      const sl2 = sx * sx + sy * sy;
      if (sl2 > 1e-6) {
        const f = (couple * g * SIM.supportCouple) / sl2;
        acx += (-sy * f) / MC;
        acy += (sx * f) / MC;
        apx -= (-sy * f) / MP;
        apy -= (sx * f) / MP;
      }
    }

    // hip target (player) or autonomic posture
    if (!fly && (this.phase === 'climbing' || this.phase === 'idle')) {
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
        if (!L.dragging || fly) continue;
        const ty = this.reachY(i);
        const en = envEvalOn(this.prof, i, ax[i], ay[i], ux, uy, L.tx, ty);
        // the pull acts along the surface vector to the target (en.r is the fold-aware distance)
        const d = this.prof ? en.r / FOLD_K.k : en.r;
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
          // a reaching leg moves the hips (it hangs off the pelvis): pulling the whole body over
          // would swing the torso toward the foot whenever the hips are held (hip handle), turning
          // the hip frame so the step gets harder, not easier
          apx += fx / MP;
          apy += fy / MP;
          continue;
        }
        acx += fx;
        acy += fy;
        apx += fx;
        apy += fy;
      }
    }

    // upright spine (internal force pair) toward the lean the statics prefer. The core also holds
    // the lean against what the external forces do to it — the legs push the pelvis, the arms pull
    // the chest — up to SIM.coreHoldMax: that part of the internal torque is fed forward, so a
    // tilted torso doesn't droop ~10 cm off the posture the statics (and the planner) settled on.
    {
      const tcx = P.x + BODY.spine * this.leanUx;
      const tcy = P.y + BODY.spine * this.leanUy;
      let fux = SIM.uprightStiffness * (tcx - C.x);
      let fuy = SIM.uprightStiffness * (tcy - C.y);
      if (SIM.coreHold > 0) {
        const sx = C.x - P.x;
        const sy = C.y - P.y;
        const sl = Math.hypot(sx, sy);
        if (sl > 1e-6) {
          const nx = -sy / sl;
          const ny = sx / sl;
          // relative perpendicular acceleration of chest vs pelvis (it turns the spine); the
          // internal pair changes it by f / MP
          const rel = (acx - apx) * nx + (acy - apy) * ny;
          const cap = SIM.coreHoldMax * g * MP;
          const ff = clamp(-rel * MP * SIM.coreHold, -cap, cap);
          fux += ff * nx;
          fuy += ff * ny;
        }
      }
      acx += fux;
      acy += fuy;
      apx -= (fux * MC) / MP;
      apy -= (fuy * MC) / MP;
    }

    // integrate
    const dmp = Math.exp(-(fly ? SIM.dampAir : SIM.dampClimb * dampBoost) * h);
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
  private readonly hipPrm: StaticsParams;

  /**
   * Can the pelvis sit at (px, py) with every attached limb inside its envelope? First with the
   * torso moved rigidly (what the constraint projection sees right now), else with any torso lean
   * the climber can turn to (the lean the statics prefer there is picked by updateLean, which keeps
   * the limbs inside their envelopes too) — the same pose model as the planner (pelvis + lean), so
   * a planned weight shift is never refused just because the torso has not turned yet.
   */
  private hipFits(px: number, py: number, ox: number, oy: number, ux: number, uy: number): boolean {
    const q = this.hipPose;
    for (let k = 0; k <= HIP_LEANS.length; k++) {
      q.px = px;
      q.py = py;
      let vx = ux;
      let vy = uy;
      if (k === 0) {
        q.cx = px + ox;
        q.cy = py + oy;
      } else {
        placeChest(q, this.contacts, this.hipPrm, HIP_LEANS[k - 1]);
        const l = Math.hypot(q.cx - q.px, q.cy - q.py) || 1;
        vx = (q.cx - q.px) / l;
        vy = (q.cy - q.py) / l;
      }
      computeAnchors(q, this.hipAx, this.hipAy);
      let fits = true;
      for (let i = 0; i < 4 && fits; i++) {
        const L = this.limbs[i];
        if (!(L.hold || L.smear) || L.dragging || L.busy) continue;
        const allow = this.softAllow(L) + 0.004;
        // conservative excess first (cheap); the exact distance only near the edge
        if (envEvalOn(this.prof, i, this.hipAx[i], this.hipAy[i], vx, vy, L.cx, L.cy).excess <= allow) continue;
        if (envProjectOn(this.prof, i, this.hipAx[i], this.hipAy[i], vx, vy, L.cx, L.cy) > allow) fits = false;
      }
      if (fits) return true;
    }
    return false;
  }

  /**
   * Furthest pelvis position on the line from the hip drag's origin toward (tx, ty) at which every
   * attached limb can stay inside its envelope (hipFits). Written to out. Searching from a fixed
   * origin (not the moving pelvis) keeps the aim still once it hits the limit, so other forces can't
   * make the hips creep along the boundary.
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
    this.buildContacts();
    // the chest placement the lean search uses (a reaching hand pulls the torso toward its target)
    const prm = this.hipPrm;
    prm.reachLimb = -1;
    for (let i = 0; i < 2; i++)
      if (this.limbs[i].dragging) {
        prm.reachLimb = i;
        prm.reachX = this.limbs[i].tx;
        prm.reachY = this.reachY(i);
      }
    const ok = (t: number): boolean => this.hipFits(O.x + (tx - O.x) * t, O.y + (ty - O.y) * t, ox, oy, ux, uy);
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
    // in a flight the arms / legs fold in 3D past the shoulder / hip (a lock-off): no in-plane minimum
    const fly = this.flight !== null;
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
        const dist = envProjectOn(this.prof, i, shx, shy, ux, uy, L.cx, L.cy);
        const allow = this.softAllow(L);
        if (dist > allow) {
          // move the shoulder so the grip point sits on the nearest allowed point (a fresh grab
          // at the edge of the snap range eases the body in instead of yanking it)
          const k = (dist - allow) / dist;
          C.x += (L.cx - PROJ_OUT.x) * k;
          C.y += (L.cy - PROJ_OUT.y) * k;
        } else if (!fly && d < SIM.armMinPlane && d > 1e-6) {
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
        const dist = envProjectOn(this.prof, i, hx, hy, ux, uy, L.cx, L.cy);
        const allow = this.softAllow(L);
        if (dist > allow) {
          const k = (dist - allow) / dist;
          P.x += (L.cx - PROJ_OUT.x) * k;
          P.y += (L.cy - PROJ_OUT.y) * k;
        } else if (!fly && d < SIM.legMinPlane && d > 1e-6) {
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
        res[i] = on ? Math.max(0, envProjectOn(this.prof, i, this.ax[i], this.ay[i], dx / l, dy / l, L.cx, L.cy) - this.softAllow(L)) : 0;
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
        const c = envClampOn(this.prof, i, ax[i], ay[i], sx, sy, L.tx, L.ty, 0);
        const kk = 1 - Math.exp(-36 * h);
        L.px += (c.x - L.px) * kk;
        L.py += (c.y - L.py) * kk;
        // the body moves too: the endpoint itself never leaves the envelope
        const e = envClampOn(this.prof, i, ax[i], ay[i], sx, sy, L.px, L.py, 0);
        L.px = e.x;
        L.py = e.y;
        L.depth = damp(L.depth, 0.12, 14, h);
      } else if (L.busy && L.busyDraw) {
        const tx = L.busyDraw.x;
        const ty = L.busyDraw.y - SIM.quickdrawDrop;
        L.px = damp(L.px, tx, 18, h);
        L.py = damp(L.py, ty, 18, h);
        L.depth = damp(L.depth, 0.1, 14, h);
      } else if (L.flying && this.flight) {
        // reaching for the target hold through the flight (the arm stays inside its envelope)
        const F = this.flight;
        const k = F.hands.indexOf(i);
        const c = envClampOn(this.prof, i, ax[i], ay[i], sx, sy, F.tx[k], F.ty[k], 0);
        L.px = damp(L.px, c.x, 30, h);
        L.py = damp(L.py, c.y, 30, h);
        L.depth = damp(L.depth, 0.08, 14, h);
      } else if (L.busy && L.busyKind === 'chalk') {
        // into the chalk bag behind the hips (the depth puts the hand behind the body)
        const tx = this.P.x - sx * 0.1 + rx * side * 0.05;
        const ty = this.P.y - sy * 0.1 + ry * side * 0.05;
        L.px = damp(L.px, tx, 16, h);
        L.py = damp(L.py, ty, 16, h);
        L.depth = damp(L.depth, this.depth + 0.14, 12, h);
      } else if (L.shakeOut) {
        // hanging straight down beside the body, shaking (≈3 Hz) — the renderer animates the wrist too
        const w = Math.sin(this.time * Math.PI * 2 * 3.1) * 0.025;
        const tx = ax[i] - sx * 0.52 + rx * side * (0.09 + w);
        const ty = ay[i] - sy * 0.52 + ry * side * (0.09 + w);
        L.px = damp(L.px, tx, 12, h);
        L.py = damp(L.py, ty, 12, h);
        L.depth = damp(L.depth, this.depth * 0.6 + 0.1 + w, 10, h);
      } else if (L.hold || L.smear) {
        L.px = damp(L.px, L.cx, 30, h);
        L.py = damp(L.py, L.cy, 30, h);
        L.depth = damp(L.depth, L.smear ? 0.015 : i < 2 ? 0.03 : 0.02, 14, h);
      } else if (L.flag) {
        // flagging: the leg is held out where it was put (relative to the hip), the foot on / near the wall
        const tx = ax[i] + sx * L.flagU + rx * side * L.flagO;
        const ty = ay[i] + sy * L.flagU + ry * side * L.flagO;
        const c = envClampOn(this.prof, i, ax[i], ay[i], sx, sy, tx, ty, 0);
        L.px = damp(L.px, c.x, 16, h);
        L.py = damp(L.py, c.y, 16, h);
        L.depth = damp(L.depth, 0.03 + Math.max(0, this.gs) * 0.05, 10, h);
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
      if (L.busyKind === 'chalk') {
        L.busy = false;
        L.busyKind = null;
        this.chalkWear[i] = 0;
        this.handFric[i] = 1;
        this.events.push({ type: 'chalk-done', limb: LIMB_IDS[i] });
        if (L.prevHold) {
          let ret = this.returnLimb(i);
          if (ret === null && !L.hold) {
            const id = this.bestReachable(i);
            if (id) {
              this.attach(i, this.holdById.get(id)!);
              ret = id;
            }
          }
          this.events.push({ type: 'return', limb: LIMB_IDS[i], holdId: ret });
        }
        this.retarget();
        continue;
      }
      const q = L.busyDraw!;
      L.busy = false;
      L.busyKind = null;
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

  /**
   * Per-forearm pump (forearm.ts): intensity f = load / fresh capacity (the statics' capacity without
   * the pump factor) of each gripping hand, plus the technique extras — a bent loaded arm (lock-off) and
   * a barn-door swing make the forearm work harder. Free hands recover (shaking out / chalking faster).
   */
  private updateForearms(h: number): void {
    const FA = SIM.forearm;
    const drain = 1 - SIM.assistPump * this.assist;
    const barn = Math.abs(this.barnAmt);
    for (let i = 0; i < 2; i++) {
      const L = this.limbs[i];
      const fa = this.forearms[i];
      const gripping = !!this.contacts[i];
      let f = 0;
      if (gripping) {
        const fresh = Math.max(L.cap / Math.max(this.capPumpF[i], 1e-6), 0.01);
        f = L.load / fresh;
        // lock-off: how bent the loaded arm is in 3D (the shoulder sits ≈ pelvisDepth off the wall)
        const rx = L.cx - this.ax[i];
        const ry = L.cy - this.ay[i];
        const ds = clamp(this.depth, 0.18, 0.5);
        const ext = Math.sqrt(rx * rx + ry * ry + ds * ds) / BODY.armMax;
        const bend = 1 - smoothstep(0.42, 0.7, ext);
        f *= 1 + FA.lockoffCost * bend;
        f += FA.barnCost * barn;
      }
      fa.step(h, { f, gripping, shaking: L.shakeOut || L.busyKind === 'chalk', drainScale: drain });
      if (this.invincible) {
        if (fa.w < 1 - SIM.pumpInvincibleCap) fa.w = 1 - SIM.pumpInvincibleCap;
        fa.exhausted = false;
      }
      const p = fa.pump;
      this.handPump[i] = p;
      if (!this.pumpWarned[i] && p >= SIM.pumpWarn) {
        this.pumpWarned[i] = true;
        this.events.push({ type: 'pump-warning', limb: LIMB_IDS[i], pump: p });
      } else if (this.pumpWarned[i] && p < SIM.pumpWarnReset) this.pumpWarned[i] = false;
    }
    this.pump = Math.max(this.handPump[0], this.handPump[1]);
    if (this.pump > this.stats.maxPump) this.stats.maxPump = this.pump;
  }

  /** Chalk wears off with time on the wall (sweat); every hand move costs a bit more (endDrag). */
  private updateSweat(h: number): void {
    const d = this.sweatT * h;
    if (d <= 0) return;
    for (let i = 0; i < 2; i++) if (this.limbs[i].busyKind !== 'chalk') this.wearChalk(i, d);
  }

  private wearChalk(i: number, d: number): void {
    const w = Math.min(1, this.chalkWear[i] + d);
    this.chalkWear[i] = w;
    this.handFric[i] = 1 - smoothstep(0, 1, w);
  }

  private updateSlips(h: number): void {
    for (let i = 0; i < 4; i++) {
      const L = this.limbs[i];
      if (!this.contacts[i]) {
        L.slipT = 0;
        continue;
      }
      // a forearm out of W′ that still works above its critical force fails: that hand slips
      const s = i < 2 && this.forearms[i].exhausted ? Math.max(L.stress, SIM.slipFull) : L.stress;
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
    // the overloaded forearm failed: a pumped hand's slip is a pump failure
    const pumped = i < 2 && (this.forearms[i].exhausted || this.handPump[i] >= SIM.pumpFailAt);
    this.stats.slips++;
    if (id) this.events.push({ type: 'slip', limb: LIMB_IDS[i], holdId: id });
    else this.events.push({ type: 'slip', limb: LIMB_IDS[i], holdId: '' });
    L.hold = null;
    L.smear = false;
    L.mode = null;
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
      this.fall(pumped ? 'pump' : barn ? 'barn-door' : 'slip');
      return;
    }
    if (i < 2) this.forearms[i].release();
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
    if (this.invincible && reason !== 'forced') return;
    if (this.phase !== 'climbing' && this.phase !== 'topped' && this.phase !== 'hanging' && reason !== 'forced') return;
    if (this.shaking) {
      this.shaking = false;
      this.events.push({ type: 'shake-end' });
    }
    this.events.push({ type: 'fall', reason });
    this.phase = 'falling';
    this.flight = null;
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
      L.busyKind = null;
      L.shakeOut = false;
      L.flag = false;
      L.mode = null;
      L.flying = false;
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
    // a folded wall: gravity splits by the wall under the centre of mass (smooth across folds)
    if (this.prof) this.airFrame();
    let apx = 0;
    let apy = -g * this.gc;
    let acx = 0;
    let acy = -g * this.gc;
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
    this.depthV += g * this.gs * h;
    this.depthV *= Math.exp(-(rope ? 2.5 : 0.3) * h);
    this.depth += this.depthV * h;
    if (rope) this.depth = damp(this.depth, 0.3 + Math.max(0, this.gs) * 0.4, 1.5, h);
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
    if (this.prof) return worldHeight(this.prof, fy, this.depth + 0.05);
    return fy * this.cth - (this.depth + 0.05) * this.sth;
  }

  /** Falling on a folded wall: gravity's split (gc, gs) follows the wall under the centre of mass. */
  private airFrame(): void {
    const a = smoothAngleAt(this.prof!, this.P.y + BODY.comT * (this.C.y - this.P.y)) * DEG;
    this.gc = Math.cos(a);
    this.gs = Math.sin(a);
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
    this.restForearms(h);
    if (this.feetWorldY() < GAME.padHeight) {
      // stretched to the floor while hanging – stand on the ground
      this.land();
    }
  }

  /** Off the wall (hanging on the rope): both forearms recover, the residual slowly. */
  private restForearms(h: number): void {
    for (let i = 0; i < 2; i++) {
      const fa = this.forearms[i];
      fa.step(h, { f: 0, gripping: false, shaking: true, drainScale: 1 });
      this.handPump[i] = fa.pump;
    }
    this.pump = Math.max(this.handPump[0], this.handPump[1]);
  }

  private land(): void {
    const vy = this.Pv.y * this.gc - this.depthV * this.gs;
    const impact = Math.abs(vy);
    this.phase = 'landed';
    this.events.push({ type: 'land', impact: Math.round(impact * 100) / 100 });
    // crouch on the pad
    const worldPelvis = GAME.padHeight + 0.45;
    const d = this.depth;
    let py = (worldPelvis + d * this.sth) / Math.max(0.3, this.cth);
    if (this.prof) {
      // straight down onto the pad: same distance out from the wall base, pelvis at crouch height
      const p3 = surfaceToLocal3D(this.prof, this.P.x, this.P.y, d, this.v3);
      const sp = local3DToSurface(this.prof, p3.x, worldPelvis, p3.z, this.sp3);
      py = sp.y;
      this.landDepth = Math.max(0.15, sp.depth);
      const f3 = local3DToSurface(this.prof, p3.x, GAME.padHeight, p3.z + 0.05, this.sp3);
      this.padY = f3.y;
    }
    this.landing.px = this.P.x;
    this.landing.py = py;
    this.landing.cx = this.P.x + Math.sin(this.yaw * 0.2) * 0.05;
    this.landing.cy = py + BODY.spine * 0.92;
    this.Pv.x = this.Pv.y = this.Cv.x = this.Cv.y = 0;
    this.depthV = 0;
  }

  private landedStep(h: number): void {
    const t = this.landing;
    if (this.prof) this.depth = damp(this.depth, this.landDepth, 10, h);
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
    const padY = this.prof ? this.padY : (GAME.padHeight + this.depth * this.sth) / Math.max(0.3, this.cth);
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
    const F = this.flight;
    s.airborne = F !== null;
    if (F) {
      const fi = this.flightInfo;
      fi.kind = F.kind;
      fi.limbs = F.limbs;
      fi.holdId = F.hold.id;
      fi.t = F.t;
      fi.apexIn = (F.apexAt >= 0 ? F.apexAt : F.tApex) - F.t;
      fi.power = F.power;
      s.flight = fi;
    } else s.flight = null;
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
      o.reachRatio = envEvalOn(this.prof, i, this.ax[i], this.ay[i], u.x, u.y, L.px, L.py).ratio;
      o.smearing = L.smear;
      o.shake = L.shake;
      o.busy = L.busy;
      if (i >= 2) o.footMode = L.flag ? 'flag' : (L.hold || L.smear) && !L.dragging ? L.mode ?? 'edge' : undefined;
      if (i < 2) {
        o.pump = this.handPump[i];
        o.friction = this.handFric[i];
        o.shakingOut = L.shakeOut;
        o.chalking = L.busy && L.busyKind === 'chalk';
        o.flying = L.flying;
        o.flightTarget = L.flying && F ? F.hold.id : null;
      }
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



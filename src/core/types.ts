// Shared data types for JUST GO UP.
//
// COORDINATES: everything gameplay-related lives in WALL-LOCAL 2D space, in meters.
//   x → right, y → up, origin = bottom-centre of the climbing wall at floor level.
//   `depth` (where used) is the distance out from the wall surface, along its normal.
// The renderer maps wall-local → world via WallFrame (src/render/wall-frame.ts).

export interface Vec2 {
  x: number;
  y: number;
}

export type LimbId = 'LH' | 'RH' | 'LF' | 'RF';
export const LIMBS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'] as const;
export const HANDS: readonly LimbId[] = ['LH', 'RH'] as const;
export const FEET: readonly LimbId[] = ['LF', 'RF'] as const;
export const isHand = (l: LimbId): boolean => l === 'LH' || l === 'RH';
export const isFoot = (l: LimbId): boolean => l === 'LF' || l === 'RF';

export type HoldType =
  | 'jug' // big positive bucket — forgiving
  | 'edge' // flat positive edge
  | 'crimp' // thin edge — strong pull direction, low capacity
  | 'sloper' // round dome — only works with body right below the good side
  | 'pinch' // vertical rib — works in many directions
  | 'pocket' // hole — medium
  | 'foot' // tiny foot chip — feet only
  | 'volume'; // big geometric feature — low hand capacity, great for feet

/**
 * Role of a hold within a problem.
 *  start — marked start hand hold(s). Hands begin here.
 *  hand  — part of the route (hands or feet may use it)
 *  foot  — route foothold (feet only if type === 'foot')
 *  top   — finish hold. Match both hands on it to send.
 *  deco  — belongs to another route (different colour). NOT usable. Visual only.
 */
export type HoldRole = 'start' | 'hand' | 'foot' | 'top' | 'deco';

export interface HoldDef {
  id: string;
  x: number;
  y: number;
  type: HoldType;
  /** Characteristic radius in meters (≈0.02 foot chip … 0.12 big jug; volumes up to 0.45). */
  size: number;
  /**
   * Radians, in the wall plane. Direction FROM the hold TOWARD where the climber's body
   * should be for the best grip. A classic hold (incut on top) = -PI/2 (body below).
   * Undercling = +PI/2 (body above). Sidepull facing left (grip its right side) = 0.
   */
  angle: number;
  role: HoldRole;
  /** Hex colour, e.g. '#F2C230'. Route holds share the route colour. */
  color: string;
  /** Seed for procedural geometry variation. */
  seed: number;
  /**
   * Optional (Phase B grip model): usable depth (mm) of an edge / crimp / pocket. Drives hand
   * capacity strongly (research: a 10 mm edge gives ≈0.7×, a 40 mm edge ≈1.15× a 20 mm edge).
   * When absent the sim derives it from `type` + `size` (edges ≈18–32 mm, crimps ≈7–13 mm).
   */
  edgeDepthMm?: number;
  /**
   * Optional: lip angle (degrees) of the gripping surface. Negative = slopey (slopers ≈ −20…−40),
   * positive = incut. Slopers use it for their effective slope (lip + wall angle); when absent a
   * sloper is −35°, every other type 0.
   */
  lipAngle?: number;
  /** Optional: fingers a pocket takes (1 = mono … 4 = deep pocket). Absent = 3. */
  fingers?: 1 | 2 | 3 | 4;
  /**
   * Optional (Phase B hold variety): the product shape refining `type` (research §3.3). `type` stays the
   * base kind every layer already understands (geometry, glyphs); `shape` adds the variant:
   *  bucket (jug, deep closed lip) · horn (pinch: a post you wrap) · rail (edge: long, shuffle along it) ·
   *  micro (crimp: 4–10 mm) · chip (foot: a tiny screw-on chip) · macro (sloper / volume: a big dual-tex
   *  feature) · dual-tex (a textured grip zone on a smooth hold) · wood (low friction).
   * Absent = the plain type.
   */
  shape?: HoldShape;
  /** Optional: id of the route volume this hold is bolted onto (it sits on the volume's face). */
  onVolume?: string;
}

/** Product shape of a hold (HoldDef.shape). */
export type HoldShape = 'bucket' | 'horn' | 'rail' | 'micro' | 'chip' | 'macro' | 'dual-tex' | 'wood';

/**
 * How a foot is used (sim → renderer / IK), inferred by the sim from where the foot was put:
 *  edge  — standing on a hold (the default),
 *  smear — rubber on blank wall,
 *  heel  — heel hook: a hold at/above hip height to the side on steep terrain; the leg PULLS,
 *  toe   — toe hook: the toe pulls on the far side of a feature / under a roof lip,
 *  flag  — no hold: the leg is out to the side (or crossed behind) as a counterweight,
 *  drop  — drop knee: foot on a sidepull-like foothold, knee turned in, hips close to the wall.
 */
export type FootMode = 'edge' | 'smear' | 'heel' | 'toe' | 'flag' | 'drop';

export interface QuickdrawDef {
  id: string;
  /** Position of the bolt/hanger on the wall; the lower carabiner hangs ~0.15m below. */
  x: number;
  y: number;
}

export type ClimbMode = 'boulder' | 'rope';

export interface BoulderDef {
  id: string;
  name: string;
  /** 0..12 — V-scale number (V0..V12). Use gradeLabel() for display. */
  grade: number;
  mode: ClimbMode;
  /** Degrees. 0 = vertical, + = overhang (top leans toward the climber), − = slab. Range −15..45. */
  wallAngle: number;
  /**
   * Climbable panel width/height in meters (boulder ≈ 4.6 × 4.5, rope ≈ 4.4 × 15). With a `profile`,
   * `height` is the wall's SURFACE length (its y extent; the world height is shorter on a folded wall,
   * see game/wall-profile.ts wallTopHeight).
   */
  width: number;
  height: number;
  holds: HoldDef[];
  /** Rope mode only: bolts in order bottom → top. The last one is the anchor. */
  quickdraws?: QuickdrawDef[];
  /** Route colour (hex). */
  color: string;
  seed: number;
  author?: string;
  createdAt?: number;
  /** Optional authored start foot placement (hold ids). Otherwise the sim picks nearest footholds. */
  startFeet?: { LF?: string; RF?: string };
  /**
   * Optional multi-angle wall (Phase B): panels stacked bottom → top along the wall SURFACE.
   * Wall-local y is the distance along the surface, so a panel spans [y0, next panel's y0).
   * When absent the wall is one flat panel at `wallAngle`. When present, `wallAngle` is the
   * angle of the steepest panel the climber meets (for labels / grading).
   */
  profile?: WallPanel[];
  /** Optional route archetype (generator / editor / labels). */
  style?: RouteStyle;
}

/** One flat section of a multi-angle wall. */
export interface WallPanel {
  /** Distance along the wall surface (m) where this panel starts. The first panel starts at 0. */
  y0: number;
  /** Degrees: 0 vertical, + overhang (top toward the climber), − slab. −20..90 (90 = horizontal roof). */
  angle: number;
}

export type RouteStyle =
  | 'vertical'
  | 'slab'
  | 'overhang'
  | 'cave' // steep → roof
  | 'traverse'
  | 'dyno'
  | 'compression' // volumes, squeezing
  | 'mixed'
  | 'zigzag' // the line switches direction (headings alternate ±35°)
  | 'diagonal'; // a rising diagonal line across the wall

// ───────────────────────────── Sim output ─────────────────────────────

export interface LimbSnapshot {
  id: LimbId;
  /** Hold the limb is attached to, or null (dragging, dangling, smearing, busy clipping). */
  holdId: string | null;
  /** Current endpoint position (grip point of hand / toe of foot), wall-local. */
  pos: Vec2;
  /** Root joint: shoulder for hands, hip for feet, wall-local. */
  anchor: Vec2;
  /** Distance out from the wall surface of the endpoint (m). ~0.03 on a hold, more when dangling. */
  depth: number;
  dragging: boolean;
  /** Fraction of body weight carried (0..~1.2). */
  load: number;
  /** load / capacity. <0.6 relaxed, 0.6–1 working, >1 overloaded (shaking, slipping soon). */
  stress: number;
  /** Max sustainable load on the current hold at the current pull angle (fraction of body weight). */
  capacity: number;
  /** |pos − anchor| / maxReach. ≥1 = fully extended. */
  reachRatio: number;
  /** Foot pressed on blank wall (friction only). */
  smearing: boolean;
  /** Per-limb tremor 0..1 (e.g. "Elvis leg"). */
  shake: number;
  /** Rope mode: hand temporarily busy clipping the rope. */
  busy: boolean;
  /**
   * Optional depth-order hint (sim → renderer). 0 = normal. > 0: in the wall plane this limb's
   * segment (shoulder→hand / hip→foot) crosses that many other limbs' segments and passes IN FRONT
   * of them (further from the wall): a crossover, a backstep / drop-knee, a foot stepping past a
   * low hand. The limb that moved into the crossing is the one in front; it stays in front until
   * the segments no longer cross. Absent when the sim doesn't compute it.
   */
  layer?: number;
  /** Optional: `layer > 0` — this limb crosses in front of at least one other limb. */
  front?: boolean;
  // ── Phase B body model (all optional; hands / feet only as noted) ──
  /** Hands: forearm pump 0..1 (1 − remaining W′ of this forearm). ClimberState.pump is the max of both. */
  pump?: number;
  /** Hands: chalk / skin friction 0..1 (1 = fresh chalk, 0 = sweaty). */
  friction?: number;
  /** Hands: hanging by the side, shaking the forearm out (faster recovery). Animate an arm shake. */
  shakingOut?: boolean;
  /** Hands: dipping into the chalk bag (busy ≈1 s; pos is at the bag behind the hips). */
  chalking?: boolean;
  /** Hands: reaching through a dyno / deadpoint flight toward `flightTarget`. */
  flying?: boolean;
  /** Hands while `flying`: the target hold. */
  flightTarget?: string | null;
  /** Feet: how the foot is used (see FootMode); undefined while dangling / dragged. */
  footMode?: FootMode;
}

/** Optional ClimberState.flight: a dyno / deadpoint in progress. */
export interface FlightInfo {
  /** 'deadpoint': one hand moves, the other stays on; 'dyno': both hands (and the feet) leave. */
  kind: 'deadpoint' | 'dyno';
  limbs: LimbId[];
  holdId: string;
  /** Seconds since the launch. */
  t: number;
  /** Seconds until the predicted apex (negative once past it). */
  apexIn: number;
  /** Launch power relative to the ideal throw (1 = apex just past the hold). */
  power: number;
}

export type ClimberPhase =
  | 'idle' // before the climb starts (preview)
  | 'climbing'
  | 'falling' // airborne
  | 'landed' // boulder: on the crash pad
  | 'hanging' // rope: caught by the rope
  | 'topped'; // sent!

export interface ClimberState {
  phase: ClimberPhase;
  /** Wall-local positions of pelvis centre and chest (base of neck). */
  pelvis: Vec2;
  chest: Vec2;
  /** Centre of mass, wall-local. */
  com: Vec2;
  /** Distance of the pelvis from the wall surface (m). */
  pelvisDepth: number;
  /**
   * Optional (sim → renderer): distance of the chest (base of the neck) from the wall surface (m) the
   * sim's body model assumes — ≈ 0.15 + 0.36 · pelvisDepth on vertical walls, further out under steep
   * panels (body tension: SIM.steepChestDepth). Absent when the sim doesn't compute it.
   */
  chestDepth?: number;
  /** Rotation of the body about the vertical axis (radians): barn-door swing / flagging twist. */
  bodyYaw: number;
  /** Full-body velocity (m/s, wall-local) – used for fall/flail animation. */
  velocity: Vec2;
  limbs: Record<LimbId, LimbSnapshot>;
  /** 0..~1.5 overall instability. >1 = critical (shaking hard). */
  tension: number;
  /** 0..1 forearm pump / fatigue. Reaching 1 = fall. */
  pump: number;
  /** 0..1 whole-body shake amplitude for rendering + camera. */
  shake: number;
  /** −1..1 horizontal offset of the CoM relative to the support base (0 = centred). */
  balance: number;
  /** 0..1 progress of matching both hands on the top hold. */
  topProgress: number;
  /** Seconds since the climb started (excludes preview). */
  time: number;
  /** Rope mode: currently clipped quickdraw ids (in order). */
  clipped: string[];
  /** Optional (Phase B): true while the body flies through a dyno / deadpoint (phase stays 'climbing'). */
  airborne?: boolean;
  /** Optional (Phase B): the flight in progress, or null. */
  flight?: FlightInfo | null;
}

// ───────────────────────────── Meta ─────────────────────────────

export type HeadId =
  | 'ibex'
  | 'chamois'
  | 'goat'
  | 'marmot'
  | 'snowleopard'
  | 'eagle'
  | 'lynx'
  | 'ram'
  | 'vulture'
  | 'human'; // a plain human climber in a CHIRAL SPORTS cap

/** CHIRAL SPORTS tee variants: basalt = black tee + white logo, white = white tee + pink logo, pink = pink tee + white logo. */
export type ColorwayId = 'basalt' | 'white' | 'pink' | 'glacier' | 'moss' | 'ember' | 'lichen' | 'dune' | 'alpenglow' | 'aurora';

export type ChalkId = 'classic' | 'glacier' | 'ember' | 'moss' | 'gold';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface Settings {
  sfx: number; // 0..1
  music: number; // 0..1
  haptics: boolean;
  quality: QualityLevel | 'auto';
  /** Show limb labels / reach arcs etc. */
  assist: boolean;
  reducedMotion: boolean;
}

export interface Profile {
  version: 1;
  playerName: string; // '' until chosen
  head: HeadId;
  colorway: ColorwayId;
  chalk: ChalkId;
  unlocked: { heads: HeadId[]; colorways: ColorwayId[]; chalks: ChalkId[] };
  best: { boulder: number; rope: number; daily: Record<string, number> };
  stats: {
    sends: number;
    falls: number;
    highestGrade: number;
    metersClimbed: number;
    longestStreak: number;
    clips: number;
    flashes: number;
    totalScore: number; // lifetime points, drives unlocks
  };
  tutorialDone: boolean;
  introSeen: boolean;
  settings: Settings;
  /** Problems the player created locally (drafts + published). */
  myProblems: BoulderDef[];
}

export type LeaderboardMode = 'boulder' | 'rope' | 'daily';

export interface ScoreEntry {
  id?: string;
  player: string;
  score: number;
  mode: LeaderboardMode;
  sends: number;
  maxGrade: number;
  head: HeadId;
  /** YYYY-MM-DD for daily mode. */
  dailyKey?: string;
  createdAt?: number; // ms epoch
}

export interface CommunityProblem {
  id: string;
  name: string;
  author: string;
  grade: number;
  boulder: BoulderDef;
  plays: number;
  sends: number;
  createdAt: number; // ms epoch
}

/** Run-level info shown on the HUD. */
export interface RunInfo {
  mode: 'tutorial' | 'boulder' | 'rope' | 'daily' | 'community' | 'test';
  score: number;
  streak: number;
  /** Boulder currently being climbed. */
  boulderName: string;
  grade: number;
  /** Rope mode. */
  lives?: number;
  heightM?: number;
  nextClipIn?: number | null; // meters to next quickdraw, null if none
  hintsLeft?: number;
}

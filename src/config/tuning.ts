// Body proportions + gameplay tuning. Shared by the sim (src/game) and the climber model
// (src/render/climber.ts) so the 3D body always matches the physics skeleton.

export const BODY = {
  height: 1.75,
  /** Pelvis centre → base of neck (chest node). */
  spine: 0.5,
  /** Half distance between shoulders / hip joints. */
  shoulderHalf: 0.19,
  hipHalf: 0.11,
  /** Shoulder → grip point, fully extended. */
  upperArm: 0.3,
  forearm: 0.27, // elbow → wrist
  handLen: 0.09, // wrist → grip point
  armMax: 0.66,
  armMin: 0.14,
  /** Hip → toe, fully extended. */
  thigh: 0.45,
  shin: 0.43,
  footLen: 0.24, // heel → toe (shoe)
  legMax: 0.93,
  legMin: 0.3,
  /** Base of neck → centre of head. */
  neck: 0.17,
  headRadius: 0.13,
  /** Mass distribution: CoM sits this fraction from pelvis to chest. */
  comT: 0.38,
  mass: 68, // kg
} as const;

export const GAME = {
  /** Fixed sim rate. */
  simHz: 120,
  /** Snap radius (m) added to hold size when dropping a limb near a hold. */
  snapRadius: 0.11,
  /** Seconds both hands must stay matched on the top hold. */
  topHold: 0.7,
  /** Hand busy time while clipping a quickdraw (rope). */
  clipTime: 0.75,
  /** Quickdraw clip radius (m). */
  clipRadius: 0.16,
  boulderWall: { width: 4.6, height: 4.5 },
  ropeWall: { width: 4.4, height: 15 },
  /** Crash pad top surface height (m). */
  padHeight: 0.3,
  /** Rope mode lives. */
  ropeLives: 3,
} as const;

/**
 * Climbing-physics tuning for src/game (ClimberSim, statics, solver). All loads are in
 * fractions of body weight; stiffnesses are mass-normalised (accelerations per metre).
 */
export const SIM = {
  gravity: 9.81,

  // ── Dynamics (2-node PBD skeleton) ──
  /** Smoothing rate (1/s) of the support forces the contacts apply to the body. */
  supportSmoothing: 22,
  /** Chest → upright spring (1/s²) and how much the spine leans toward the hands (0..1). */
  uprightStiffness: 55,
  /**
   * Fraction of the support forces' true-lever couple applied to the spine (hands pull through the
   * shoulders, feet push at the toes; see ClimberSim.integrateBody). 1 = the static pose is an
   * equilibrium of the dynamics.
   */
  supportCouple: 1,
  /**
   * Core strength: the fraction of the external forces' turning effect on the spine the core
   * cancels outright (feed-forward), and its cap (g), so the torso holds the lean the statics chose.
   */
  coreHold: 1,
  coreHoldMax: 0.8,
  uprightLean: 0.45,
  /** Player hip-target spring (1/s²), its force cap (g) and damping (1/s). */
  hipStiffness: 46,
  hipMaxForce: 0.95,
  hipDamping: 7,
  /** Autonomic posture: the climber drifts toward the statically best hip position. */
  postureStiffness: 16,
  postureMaxForce: 0.4,
  postureDamping: 4,
  /**
   * The autonomic help fades with the grade (full up to V3, this fraction at V11+), so hard problems
   * need deliberate weight shifts with the hip handle. Assist restores it.
   */
  postureHardFrac: 0.35,
  /** Drag reach pull: the body follows a limb that is reaching beyond its range. */
  reachStiffness: 22,
  reachMaxForce: 0.45,
  /** Fraction of max reach at which the body starts to follow the dragged limb. */
  reachFollowFrac: 0.95,
  /**
   * The live climber's reach posture brings a dragged limb's target this far (m) inside its
   * anatomical envelope (the planner uses the bare limit), so releasing over the hold is reliable.
   */
  reachComfort: 0.05,
  /** Linear damping (1/s) while climbing / airborne / hanging on the rope. */
  dampClimb: 3.4,
  dampAir: 0.12,
  dampHang: 1.1,
  pbdIterations: 6,
  /**
   * In-plane minimum shoulder→grip and hip→toe distances. Smaller than BODY.armMin/legMin because the
   * shoulders and hips sit 0.2–0.5 m off the wall, so a folded limb can project almost to a point.
   */
  armMinPlane: 0.05,
  legMinPlane: 0.17,
  /** Extra reach tolerance (m) beyond the anatomical envelope for snapping a dragged limb onto a hold. */
  reachTolerance: 0.07,
  /** Smoothing rate (1/s) of loads/stress (weight shifts are not instantaneous). */
  loadSmoothing: 14,
  /** Seconds of grace with zero hands before falling (quick re-grabs survive). */
  noHandsGrace: 0.28,

  // ── Static load model ──
  /** QP cost multipliers: hands vs feet (legs are preferred), perpendicular force, core torque. */
  handCost: 1,
  footCost: 0.7,
  perpCost: 2.6,
  /** Comfortable core torque (body weight · m); larger torque is expensive and adds tension. */
  coreTorque: 0.1,
  /** In-plane 3D leg length used to estimate how far the hips sit off the wall. */
  legDepthLen: 0.7,
  /** Minimum vertical lever (m) between hands and feet for the out-of-plane balance. */
  minLever: 0.35,

  /** Hand capacity per hold type (fraction of body weight), before size/angle factors. */
  handCap: { jug: 0.75, edge: 0.55, pinch: 0.45, pocket: 0.45, crimp: 0.38, sloper: 0.32, volume: 0.3, foot: 0.05 },
  /** Foot capacity per hold type. */
  footCap: { jug: 1.5, edge: 1.3, volume: 1.35, pocket: 1.0, pinch: 0.9, crimp: 0.95, sloper: 0.8, foot: 1.0 },
  /** Typical size per type (m) and the ± range that maps to ±15 % capacity. */
  refSize: { jug: 0.095, edge: 0.065, pinch: 0.065, pocket: 0.05, crimp: 0.04, sloper: 0.1, volume: 0.32, foot: 0.028 },
  refSizeRange: { jug: 0.03, edge: 0.02, pinch: 0.02, pocket: 0.015, crimp: 0.012, sloper: 0.03, volume: 0.12, foot: 0.01 },
  sizeEffect: 0.15,
  /** Pull-angle tolerance cones (degrees): full grip inside `inner`, `floor` grip beyond `outer`. */
  handCone: {
    jug: { inner: 70, outer: 155, floor: 0.42 },
    edge: { inner: 45, outer: 120, floor: 0.2 },
    crimp: { inner: 35, outer: 100, floor: 0.14 },
    sloper: { inner: 26, outer: 82, floor: 0.06 },
    pinch: { inner: 85, outer: 175, floor: 0.5 },
    pocket: { inner: 50, outer: 130, floor: 0.28 },
    volume: { inner: 40, outer: 120, floor: 0.3 },
    foot: { inner: 30, outer: 90, floor: 0.1 },
  },
  footCone: {
    jug: { inner: 75, outer: 150, floor: 0.3 },
    edge: { inner: 60, outer: 130, floor: 0.22 },
    crimp: { inner: 50, outer: 120, floor: 0.2 },
    sloper: { inner: 40, outer: 100, floor: 0.12 },
    pinch: { inner: 70, outer: 150, floor: 0.3 },
    pocket: { inner: 60, outer: 130, floor: 0.25 },
    volume: { inner: 70, outer: 140, floor: 0.35 },
    foot: { inner: 60, outer: 125, floor: 0.2 },
  },
  /** Hand capacity lost per unit sin(overhang) — slopers and crimps hate steep walls. */
  overhangLoss: { jug: 0.08, edge: 0.22, pinch: 0.12, pocket: 0.18, crimp: 0.32, sloper: 0.55, volume: 0.4, foot: 0.5 },
  /** How much toe-pull (out-of-plane, body weights per foot) a foothold tolerates on overhangs. */
  toeScale: { jug: 0.36, edge: 0.32, volume: 0.34, pocket: 0.28, pinch: 0.28, crimp: 0.22, sloper: 0.2, foot: 0.22 },
  toeMin: 0.12,
  /** Matching two hands on one hold shares its surface. */
  matchFactor: 0.88,
  /** Smearing (foot on blank wall). */
  smearCap: 0.5,
  smearMaxAngle: 10,
  smearCone: { inner: 50, outer: 110, floor: 0.1 },
  /** Assist: capacity × (1 + assistCap·assist), pump × (1 − assistPump·assist). */
  assistCap: 0.6,
  assistPump: 0.7,

  // ── Tension, shaking, slipping ──
  shakeOn: 0.7,
  shakeOff: 0.6,
  /** Stress where the slip clock starts, and where it runs at full speed. */
  slipStart: 1.05,
  slipFull: 1.6,
  /** Slip clock: seconds at full overload; decay rate when back under capacity. */
  slipTime: 0.5,
  slipRecover: 1.3,
  balancePenalty: 0.3,
  barnPenalty: 0.8,
  spanPenalty: 0.3,
  crouchPenalty: 0.22,
  reachStrain: 0.42,
  corePenalty: 0.45,

  // ── Anatomy (reach envelopes, src/game/anatomy.ts) ──
  /**
   * Envelope ratio (r / r(φ)) where an awkward limb position (deep high step, crossover, hand far
   * down) starts to strain, and the extra stress it adds at the edge (× the direction's strain weight).
   */
  edgeStart: 0.8,
  edgeStrain: 0.3,
  /** Beyond the edge (forced there, e.g. by a slip): extra stress ramps to edgeOver → the limb pops off. */
  edgeOverStart: 1.02,
  edgeOverFull: 1.12,
  edgeOver: 1.7,
  /** Snap clearance (m): a limb can't be placed on another limb's contact or right on its segment. */
  limbClearance: 0.075,
  /** Feet and hands never share a spot: minimum contact separation (m). */
  handFootGap: 0.1,
  /** A hand is never placed lower than this (m) above every attached foot. */
  handAboveFeet: 0.1,

  // ── Pump ──
  /** Base creep per second, strain-driven rate, campus extra, recovery in a good rest. */
  pumpBase: 1 / 320,
  pumpStrain: 0.036,
  pumpCampus: 0.02,
  pumpRecover: 0.022,
  pumpShakeOut: 0.032,
  /** Hand capacity × (1 − pumpCapLoss·pump²). */
  pumpCapLoss: 0.32,
  /** Lead routes are long: base creep and strain pump scale down, rests count for more. */
  ropePumpScale: 0.6,
  ropeRecoverScale: 1.4,
  /** Invincible mode caps pump here. */
  pumpInvincibleCap: 0.85,

  // ── Falling + rope ──
  /** Rope: soft catch stiffness (1/s²) per metre of rope out, and damping. */
  ropeStiffness: 260,
  ropeDamping: 5,
  /** Below this feet height (m) a rope fall is a ground fall. */
  deckHeight: 0.4,
  /** Quickdraw carabiner hangs this far below the bolt. */
  quickdrawDrop: 0.15,
} as const;

export type HoldTypeTable = typeof SIM.handCap;

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

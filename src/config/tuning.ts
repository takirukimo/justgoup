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
  /**
   * Seconds both hands must stay matched on the top hold. Research §3.4: MoonBoard holds the finish for
   * 2 s, IFSC asks for a "stable position", 1–2 s recommended. 1.2 s proves control (a pumped climber
   * can still fail on the top) without dragging out every send on a phone, where there is no judge's
   * nod to read; it sits at the short end of the recommended band on purpose.
   */
  topHold: 1.2,
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
  /**
   * Body tension under steep panels (research §2.1 / §6.2: hip depth d ≈ 0.25 m "in" … 0.40 m "out"):
   * on an overhang or a roof toe-pull and hooks hold the hips up, but the pelvis never hugs the wall.
   * Over the stance's effective wall angle steepDepthFrom → steepDepthTo (°) its depth floor rises to
   * steepPelvisDepth, and the chest hangs a little further out than the hips (arms nearly straight from
   * the holds): steepChestDepth. Both reach the renderer (ClimberState.pelvisDepth / chestDepth); the
   * statics balance the CoM between them (statics.evaluateStance).
   */
  steepDepthFrom: 25,
  steepDepthTo: 60,
  steepPelvisDepth: 0.28,
  steepChestDepth: 0.36,

  /**
   * Hand capacity per hold type (fraction of body weight), before size/angle factors, for a fresh
   * climber of strength 1 (≈ a V3–V5 climber, research §2.4). jug, pinch, volume and foot use it
   * directly (× sizeFactor); edge, crimp, sloper and pocket come from the research grip model below
   * (edge depth, effective slope, fingers) and their entries here are the typical generated values.
   */
  handCap: { jug: 0.75, edge: 0.556, pinch: 0.42, pocket: 0.42, crimp: 0.39, sloper: 0.39, volume: 0.3, foot: 0.05 },

  // ── Grip model (docs/climbing-research.md §2.4, §6.3) ──
  /** One-hand capacity on a 20 mm edge (half crimp): the reference grip (research V3–V5: 0.55–0.70, bottom of the band). */
  edge20: 0.52,
  /**
   * Edge-depth multiplier knots [depth mm, × the 20 mm edge], piecewise linear (Bourne 2011 [22]:
   * 10 mm ≈ 0.70, 40 mm ≈ 1.15, i.e. a 1 cm edge gives 0.61× a 4 cm edge; micros 4–10 mm ≈ 0.3–0.7).
   */
  edgeDepthCurve: [
    [3, 0.25],
    [4, 0.31],
    [6, 0.46],
    [8, 0.59],
    [10, 0.7],
    [12, 0.78],
    [15, 0.88],
    [20, 1.0],
    [25, 1.07],
    [30, 1.11],
    [40, 1.15],
    [60, 1.17],
  ] as readonly (readonly [number, number])[],
  /** Edge depth (mm) of a hold without edgeDepthMm, from its size (radius m): [size lo, size hi, mm lo, mm hi]. */
  edgeDepthBySize: { edge: [0.05, 0.08, 18, 32], crimp: [0.028, 0.045, 7, 13], pocket: [0.04, 0.06, 15, 30] } as const,
  /** Incut (+) / slopey (−) lip on edges and crimps: capacity × (1 + edgeLipGain · lip°), lip clamped to ±30°. */
  edgeLipGain: 0.004,
  /** Sloper capacity at a shallow effective slope (≈0.9 × the 20 mm edge up to 20–30° of slope, Amca 2012 [29]). */
  sloperBase: 0.47,
  /** Lip angle (°) of a sloper without lipAngle (research: −20 … −40). */
  sloperLip: -35,
  /**
   * Sloper multiplier over the EFFECTIVE slope = −lip + wall angle (°) [29]; extrapolated gently past 40°.
   * This replaces overhangLoss for slopers: slopers die on steep walls.
   */
  sloperSlopeCurve: [
    [0, 1],
    [20, 1],
    [30, 0.95],
    [40, 0.72],
    [50, 0.56],
    [60, 0.44],
    [70, 0.34],
    [80, 0.26],
    [90, 0.2],
  ] as readonly (readonly [number, number])[],
  /** Pocket grip by fingers, × the 20 mm edge (index = fingers − 1: mono, 2, 3, 4 fingers). */
  pocketFingers: [0.3, 0.55, 0.8, 0.95] as const,
  /**
   * Chalk / sweat: capacity × (1 − frictionSense·(1 − friction)/3), friction 0..1 (1 = fresh chalk ≙ φ 1.2,
   * 0 = sweaty ≙ φ 0.8, research §2.7 / §6.5). Slopers lose most, jugs least.
   */
  frictionSense: { jug: 0.2, edge: 0.6, crimp: 0.6, pinch: 0.6, pocket: 0.4, sloper: 1.0, volume: 0.8, foot: 0.6 },
  /**
   * Foot capacity lost per unit sin(overhang) on holds: on steep walls the feet stay on only by toe-pull
   * (research §2.1: the hands' share was ≈0.07 BW below the band at 30–60°).
   */
  steepFootLoss: 0.6,
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
  // ── Foot techniques (research §2.2, §2.3; inferred from where the foot is put, ClimberSim) ──
  /** Heel / toe hook capacity (BW, best hold and direction) and the most pull-in they give (BW). */
  heelHookCap: 0.45,
  toeHookCap: 0.25,
  heelHookPull: 0.4,
  toeHookPull: 0.22,
  /** How well a hold type takes a hook (× the caps above). */
  hookHoldFactor: { jug: 1, edge: 0.85, crimp: 0.55, sloper: 0.6, pinch: 0.9, pocket: 0.55, volume: 0.95, foot: 0.35 },
  /** Hooks take over at most this share of the hands' keep-in pull. */
  hookMaxShare: 0.85,
  /** A hook pulls the hips in by this much (m) per hooking leg; hooks alone keep the hips this far out. */
  hookDepthPull: 0.06,
  hookOnlyDepth: 0.22,
  /** Wall angles (°) from which a pull-able foothold at / above the hip is a heel hook, and a far one a toe hook. */
  heelMinAngle: 8,
  toeMinAngle: 15,
  /** Drop knee: the hip turns in — its leg's hip depth × this (not below dropKneeMinDepth, m). */
  dropKneeDepth: 0.62,
  dropKneeMinDepth: 0.12,
  /** One leg's share of the body mass (counterweight of a flag) and how far a flag widens the barn-door column. */
  legMass: 0.16,
  flagSpread: 0.6,
  /** A foot dropped over blank wall at least this far (m) out to the side of its hip flags. */
  flagReach: 0.5,
  // ── Hold shapes (HoldDef.shape, research §3.3 type defaults) ──
  /** Hand grip × per shape (on top of the type's grip model): bucket 1.5 vs jug 1.35, horn 1.2 vs pinch 0.8 × the 20 mm edge. */
  shapeGrip: { bucket: 1.1, horn: 1.48, rail: 1, micro: 1, chip: 1, macro: 1, 'dual-tex': 1.1, wood: 0.9 },
  /** Foot capacity × per shape (a chip is a tiny screw-on; wood is slippery). */
  shapeFoot: { bucket: 1.05, horn: 1, rail: 1, micro: 0.8, chip: 0.75, macro: 1, 'dual-tex': 1, wood: 0.85 },
  /** Pull cones of shapes that grip differently from their type (horn ≈ 110° inner: a post you wrap; bucket ≈ 80°). */
  shapeCone: {
    bucket: { inner: 80, outer: 160, floor: 0.45 },
    horn: { inner: 110, outer: 178, floor: 0.6 },
    'dual-tex': { inner: 22, outer: 75, floor: 0.06 },
  },
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

  // ── Pump (per forearm; see src/game/forearm.ts) ──
  /**
   * Pumped capacity: hand capacity × (1 − pumpCapLoss·pump⁴), i.e. a fully pumped forearm bottoms out at
   * 60 % of its fresh force (research [49]: 50–65 %), the loss concentrated in the last third of W′.
   */
  pumpCapLoss: 0.4,
  /** Invincible mode caps pump here. */
  pumpInvincibleCap: 0.85,
  /**
   * Critical-force / W′ forearm model (research §2.6, fitted in forearm.ts; intensity f = load / fresh
   * capacity of the hold). Below the critical force CF a forearm is near-sustainable, above it W′ drains
   * at k·(f − CF). An unbroken grip above the occlusion band switches to the sustained values within
   * the first seconds (blood flow occludes at ≈51–75 % MVC [47]); releases reset that.
   */
  forearm: {
    cfIntermittent: 0.41,
    cfSustained: 0.3,
    kIntermittent: 1.0,
    kSustained: 1.8,
    /** Intensity band (MVC fraction) over which a sustained grip occludes. */
    occlusionLo: 0.42,
    occlusionHi: 0.62,
    /** Seconds of unbroken grip over which occlusion sets in. */
    occlusionRamp0: 0.5,
    occlusionRamp1: 2.0,
    /** W′ (MVC·s): the reserve above CF (research ≈30; fitted to the hang / 60 % anchors). */
    wPrime: 35,
    /**
     * Recovery half-time (s) of a free forearm for strength 1 (research [50]: intermediate 45–60,
     * advanced 15–30; a strong intermediate). Scales with strength^−1.6. Shaking out beside the body is
     * ×shakeBoost faster (+32 % reoxygenation, Baláš 2016); holding on at intensity f recovers ×(1 − f/CF).
     */
    halfLife: 40,
    shakeBoost: 1.3,
    /** Seconds off a hold over which recovery ramps in (reperfusion delay). */
    recoveryOnset: 1.0,
    /**
     * Slow residual fatigue: grows at creep·f per second of grip and lowers CF by (1 − residual); it decays
     * with residualTau (s) off the wall (lactate stays up > 20 min [51]). Fitted so a steady 40 % MVC stance
     * fails after ≈7.5 min and 40 % MVC 5 s on / 2 s off after ≈15 min (research [48]: 853 s for climbers;
     * the tuning table's 7–14 min for a steady stance).
     */
    creep: 0.0024,
    residualTau: 600,
    /** The residual only recovers after this many seconds off (not in the brief pauses between holds). */
    residualRestAfter: 5,
    /**
     * Technique: a bent, loaded arm also works the elbow flexors in the forearm (brachioradialis):
     * intensity × (1 + lockoffCost·bend). A barn-door swing makes both hands squeeze: + barnCost·|barn|.
     */
    lockoffCost: 0.25,
    barnCost: 0.12,
  },
  /** A forearm whose pump crosses this emits 'pump-warning' (re-armed below pumpWarnReset). */
  pumpWarn: 0.75,
  pumpWarnReset: 0.55,
  /** A slip of a hand this pumped (or a forearm out of W′) is a pump failure (fall reason 'pump'). */
  pumpFailAt: 0.7,

  // ── Chalk + sweat (research §2.7, §6.5) ──
  /** Seconds a hand is off for a chalk dip (ROADMAP ≈1 s; research 1–2 s). */
  chalkTime: 1.0,
  /**
   * Chalk wear per second on the wall and per hand move; friction = 1 − smoothstep(wear) (1 = fresh
   * chalk, 0 = sweaty). Lead: fresh → sweaty over ≈5 hand moves at a lead pace (≈35 s) [40].
   * Bouldering (owner DECISION, v0.2 playtest): a boulder attempt is 27–39 s on chalk from the start
   * (research [40], "boulderers chalk before each 30–40 s attempt"), so hands never get greasy in any
   * noticeable way there — no wear at all, friction stays 1 and no chalk dip is needed (the gesture stays
   * harmless and cosmetic). ClimberSim.chalkMatters tells the app which model a climb uses.
   */
  sweatBoulder: { perSecond: 0, perMove: 0 },
  sweatLead: { perSecond: 1 / 70, perMove: 0.1 },

  // ── Shake-out ──
  /** The other limbs must hold the climber below this worst stress for a hand to let go and shake. */
  shakeOutMaxStress: 0.95,
  /** Release zone for a shake-out: finger at least this far (m) below the shoulder, beside the body. */
  shakeOutDrop: 0.25,
  /** Release zone for a chalk dip: finger within this distance (m) of the chalk bag (behind the hips). */
  chalkZone: 0.2,

  // ── Dynamics: deadpoints + dynos (research §2.5, §6.6) ──
  /** The throw aims the hand this far (m) inside its reach envelope at the apex. */
  dynoMargin: 0.02,
  /** …and puts the apex this far past the needed rise ("aiming past the hold worked best" [37]). */
  dynoAimPast: 0.05,
  /** Smallest hop (m) of a throw, and the hop per metre of sideways throw (lateral dynos jump too). */
  dynoMinHop: 0.06,
  dynoLateralHop: 0.35,
  /**
   * Launch speed the climber can produce: legs (feet ≈1.8× the hands at launch [37]) accelerate the body
   * over the leg extension still available (a deep crouch throws further), the arms over dynoArmExt.
   * Defaults give ≈3.6 m/s from a crouch with arms (≈0.65 m of rise at vertical: a recreational 0.4–0.8 m
   * dyno), ≈2 m/s campusing. On overhangs the feet push less (dynoSteepLegLoss · sin θ).
   */
  dynoLegAccel: 18,
  dynoArmAccel: 7,
  dynoArmExt: 0.3,
  dynoSteepLegLoss: 0.4,
  /** Furthest a throw can be aimed (m beyond the static reach) for a dyno candidate. */
  dynoMaxReach: 1.3,
  /** Catch: the target within this (m) of the hand's envelope; the hand closes near the apex (CoM vy ≤ dynoGrabVy). */
  dynoCatchTol: 0.07,
  dynoGrabVy: 0.3,
  /** Seconds past the apex before an unreached throw is a miss (research catch window −150…+50 ms; game +100 ms). */
  dynoLate: 0.1,
  /** Arm flex (m) that absorbs the catch: peak load = static load × (1 + v²/(2 g · dynoAbsorb)) (research 1.1–1.6 BW). */
  dynoAbsorb: 0.18,
  /** A catch holds if its peak stress (peak load / capacity) stays under this; the hand rips off above it. */
  dynoCatchStress: 1.5,
  /** Pump: W′ fraction spent per launch (× (v / vmax)², ×2 without feet) and per catch (× peak stress²). */
  dynoLaunchPump: 0.03,
  dynoCatchPump: 0.05,
  /** Fraction of the body's speed left after a caught throw (the arms absorb the rest). */
  dynoKeep: 0.35,
  /**
   * Release flick (wall-local m/s along the line to the hold) that commits a throw, and the flick of an
   * ideal one (power 1; power = flick / ref, clamped 0.6–1.4, mirrored by input/release.ts flickPower).
   * A phone flick measures ≈4–12 m/s on the wall: a 6 m/s reference spreads power over that range
   * (4 → 0.67, 6 → 1, 8 → 1.33) instead of saturating every real flick at 1.4.
   */
  dynoMinFlick: 1.2,
  dynoFlickRef: 6.0,
  /** Longest flight (s) before the sim calls it a miss. */
  dynoMaxFlight: 1.2,

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

/**
 * Problem generator switches and route-setting tables (src/game/generator.ts, research §3).
 * Mutable on purpose: tests and dev tools flip the flags; the shipped defaults are what the live game uses.
 */
export const GEN: {
  /**
   * Multi-angle wall profiles (kicker → steep → roof stacks, caves, lead headwalls with a roof crux).
   * ON: the renderer folds the panels (render/wall-frame.ts + wall.ts). Every archetype that needs no
   * profile (slab / overhang angles, traverses, zigzags, diagonals, dynos, compression, hold variety)
   * is on regardless. GenerateOptions.profiles overrides it per problem.
   */
  profiles: boolean;
  /**
   * Hand holds bolted onto route volumes (HoldDef.onVolume; compression squeezes, a few on mixed / steep
   * problems). ON: the renderer seats a mounted hold on its volume's face (render/holds.ts HoldSet.mounts).
   * The sim and planner handle them (holds.volumeYields: a foot by the mounted hold takes it, not the
   * volume). GenerateOptions.holdsOnVolumes overrides it per problem.
   */
  holdsOnVolumes: boolean;
} = {
  profiles: true,
  holdsOnVolumes: true,
};

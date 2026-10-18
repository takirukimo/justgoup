// Per-forearm fatigue ("pump"): a critical-force / W′ model fitted to docs/climbing-research.md §2.6.
//
// Each hand has its own forearm. Its intensity is f = load / fresh capacity of the hold it grips (the
// fraction of the hand's maximum force on that hold at that pull angle, "MVC"). Three state values:
//   w        remaining fraction of W′, the reserve above the critical force (1 = fresh, 0 = spent),
//   residual slow fatigue 0..1 that lowers the critical force (metabolites; recovers over > 10 min),
//   holdT    seconds of unbroken grip on the current hold (sustained grips occlude the blood flow).
// Per step:
//   occl = smoothstep(occlusionLo, occlusionHi, f) · smoothstep(ramp0, ramp1, holdT)      (gripping only)
//   CF   = lerp(cfIntermittent, cfSustained, occl) · (1 − residual)
//   k    = lerp(kIntermittent, kSustained, occl)
//   f > CF:  w −= k·(f − CF) / W′ · dt                                                        (drain)
//   f ≤ CF:  w → 1 with half-time halfLife / (1 − f/CF), ×shakeBoost while shaking out        (recover)
//   residual += creep·f·dt while gripping; decays with residualTau once the hand has been off a while
// pump = 1 − w. The hand's capacity is × pumpCapFactor(pump) (holds.ts: down to 60 % when spent), and a
// forearm out of W′ while still working above its CF fails: that hand slips (ClimberSim).
//
// Fitted anchors (body.test.ts checks them through the live sim and this class):
//   • steady 40 % MVC with feet on → ≈10 min (research [48]: 7–14 min; the old global meter: ≈140 s),
//   • continuous 60 % MVC → ≈60 s (48–66 s),
//   • two-hand dead hang on edges (f ≈ 0.83–0.96 for the default climber) → ≈25–35 s, ≈60 s at f ≈ 0.6
//     (research [26]: 23 / 42 / 59 s for low / intermediate / advanced climbers),
//   • intermittent 80 % MVC 5 s on / 5 s off → ≈2 min (research [49]: 1.5–3 min),
//   • recovery half-time 40 s off the wall, ≈31 s shaking out (research [50] intermediate–advanced).

import { SIM } from '../config/tuning';

const F = SIM.forearm;

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface ForearmStep {
  /** Intensity (load / fresh capacity, technique extras included); 0 when the hand is off. */
  f: number;
  /** The hand grips a hold (a contraction is going on). */
  gripping: boolean;
  /** Hanging by the side shaking out (or dipping into the chalk bag): recovery × shakeBoost. */
  shaking: boolean;
  /** Multiplier on drains (assist lowers it). */
  drainScale: number;
}

export class Forearm {
  /** Remaining W′ fraction (1 = fresh, 0 = spent). */
  w = 1;
  /** Slow residual fatigue 0..1 (lowers the critical force). */
  residual = 0;
  /** Seconds of unbroken grip on the current hold. */
  holdT = 0;
  /** Seconds the hand has been off (the residual only recovers in a real rest, not between holds). */
  offT = 0;
  /** Critical force and drain slope of the last step (diagnostics / HUD). */
  cf: number = F.cfIntermittent;
  k: number = F.kIntermittent;
  /** Intensity of the last step. */
  f = 0;
  /** True when W′ is spent while the hand still works above its CF: the forearm fails. */
  exhausted = false;
  /** Recovery half-time (s) of a free, still forearm. */
  readonly halfLife: number;

  constructor(strength = 1) {
    const s = strength > 0.2 ? strength : 0.2;
    this.halfLife = Math.min(90, Math.max(8, F.halfLife * Math.pow(1 / s, 1.6)));
  }

  /** 0 (fresh) … 1 (spent). */
  get pump(): number {
    return 1 - this.w;
  }

  reset(): void {
    this.w = 1;
    this.residual = 0;
    this.holdT = 0;
    this.offT = 0;
    this.f = 0;
    this.exhausted = false;
  }

  /** A burst of work outside the steady model (a dyno launch or catch): spend this fraction of W′. */
  spend(fraction: number): void {
    if (fraction > 0) this.w = Math.max(0, this.w - fraction);
  }

  /** The hand let go of its hold: the next grip starts unoccluded. */
  release(): void {
    this.holdT = 0;
  }

  step(dt: number, s: ForearmStep): void {
    const f = s.f > 0 ? s.f : 0;
    this.f = f;
    let occl = 0;
    if (s.gripping) {
      this.holdT += dt;
      this.offT = 0;
      occl = smooth(F.occlusionLo, F.occlusionHi, f) * smooth(F.occlusionRamp0, F.occlusionRamp1, this.holdT);
    } else {
      this.holdT = 0;
      this.offT += dt;
    }
    const cf = (F.cfIntermittent + (F.cfSustained - F.cfIntermittent) * occl) * (1 - this.residual);
    const k = F.kIntermittent + (F.kSustained - F.kIntermittent) * occl;
    this.cf = cf;
    this.k = k;
    if (f > cf) {
      this.w -= ((k * (f - cf)) / F.wPrime) * dt * s.drainScale;
    } else if (this.w < 1) {
      let speed = cf > 1e-6 ? 1 - f / cf : 0;
      if (s.shaking) speed *= F.shakeBoost;
      // reperfusion takes a moment: the brief pauses between holds recover less than a real rest
      if (!s.gripping && this.offT < F.recoveryOnset) speed *= this.offT / F.recoveryOnset;
      if (speed > 0) this.w += (1 - this.w) * (1 - Math.exp((-Math.LN2 * dt * speed) / this.halfLife));
    }
    if (s.gripping && f > 0.02) this.residual += F.creep * f * dt * s.drainScale;
    else if (!s.gripping && this.offT > F.residualRestAfter) this.residual -= (this.residual * dt) / F.residualTau;
    if (this.residual > 1) this.residual = 1;
    else if (this.residual < 0) this.residual = 0;
    if (this.w > 1) this.w = 1;
    if (this.w <= 0) {
      this.w = 0;
      this.exhausted = s.gripping && f > cf;
    } else this.exhausted = false;
  }
}

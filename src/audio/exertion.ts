// Exertion director: decides what the climber's voice does at a hard moment, so effort sounds stay
// rare, varied and earned (owner: the v0.1 grunting was annoying).
//
//   • Vocal efforts (a grunt / "hup" / the head's equivalent, or the long strain) only on genuinely
//     hard moments: an overload while a limb is moving, a reach at the anatomical edge, a slip,
//     a dyno launch / catch, a deep-pump warning.
//   • Randomised cooldowns: at least VOCAL_GAP (4–8 s, drawn fresh after every vocal) between two
//     vocal sounds, and the long strain at most every STRAIN_GAP (10–16 s).
//   • Everything else (an overload while hanging still, the tremor starting, a hard moment inside a
//     cooldown) breathes harder instead: the breathing layer gets heavier for a few seconds.
//   • Nothing ever repeats on a timer: there is no looped grunt.
//
// Pure logic with an injectable clock + RNG (unit-tested in exertion.test.ts).

export type ExertMoment =
  | 'move-overload' // a limb overloads while the player is moving (dragging / just moved)
  | 'reach-edge' // a hand grabbed at the very edge of its anatomical reach
  | 'slip'
  | 'dyno-start'
  | 'dyno-catch'
  | 'dyno-miss'
  | 'pump-warning'
  | 'overload' // an overload while hanging still
  | 'shake'; // the tremor started

/** What to play: a vocal one-shot, a breath one-shot, or heavier breathing (`breathe` 0..1). */
export interface ExertAction {
  vocal: 'effort' | 'strain' | 'gasp' | null;
  breath: 'exhale' | null;
  /** Push the breathing layer this much harder for a few seconds (0 = no change). */
  breathe: number;
}

/** Seconds between two vocal sounds: uniform in [min, max], drawn after every vocal. */
export const VOCAL_GAP = { min: 4, max: 8 } as const;
/** Seconds between two long strains. */
export const STRAIN_GAP = { min: 10, max: 16 } as const;
/** Seconds between two breath one-shots (exhales). */
export const BREATH_GAP = { min: 2.5, max: 4.5 } as const;

const NONE: ExertAction = Object.freeze({ vocal: null, breath: null, breathe: 0 }) as ExertAction;

export class ExertionDirector {
  private lastVocal = -Infinity;
  private vocalGap: number = VOCAL_GAP.min;
  private lastStrain = -Infinity;
  private strainGap: number = STRAIN_GAP.min;
  private lastBreath = -Infinity;
  private breathGap: number = BREATH_GAP.min;
  private lastDynoVoiced = -Infinity;

  constructor(private readonly rng: () => number = Math.random) {}

  private draw(r: { min: number; max: number }): number {
    return r.min + (r.max - r.min) * this.rng();
  }

  private vocalReady(now: number): boolean {
    return now - this.lastVocal >= this.vocalGap;
  }

  private voice(now: number, kind: 'effort' | 'strain' | 'gasp'): ExertAction {
    this.lastVocal = now;
    this.vocalGap = this.draw(VOCAL_GAP);
    if (kind === 'strain') {
      this.lastStrain = now;
      this.strainGap = this.draw(STRAIN_GAP);
    }
    return { vocal: kind, breath: null, breathe: kind === 'gasp' ? 0.35 : 0.5 };
  }

  private exhale(now: number, breathe: number): ExertAction {
    if (now - this.lastBreath < this.breathGap) return breathe > 0 ? { vocal: null, breath: null, breathe } : NONE;
    this.lastBreath = now;
    this.breathGap = this.draw(BREATH_GAP);
    return { vocal: null, breath: 'exhale', breathe };
  }

  /** Breathing harder only (no one-shot). */
  private heavier(amount: number): ExertAction {
    return { vocal: null, breath: null, breathe: amount };
  }

  /**
   * React to a moment at time `now` (seconds, any monotonic clock). `severity` 0..1 grades it
   * (how deep the overload / pump, how far past the comfortable reach).
   */
  decide(now: number, moment: ExertMoment, severity = 0.5): ExertAction {
    const sev = Number.isFinite(severity) ? Math.max(0, Math.min(1, severity)) : 0.5;
    switch (moment) {
      case 'dyno-start':
        if (this.vocalReady(now)) {
          this.lastDynoVoiced = now;
          return this.voice(now, 'effort');
        }
        return this.heavier(0.35);
      case 'dyno-catch':
        // "hup — ngh": a catch right after a voiced launch only breathes out
        if (now - this.lastDynoVoiced < 2.5 || !this.vocalReady(now)) return this.exhale(now, 0.5);
        return this.voice(now, 'effort');
      case 'dyno-miss':
        return this.heavier(0.4); // the fall's own yell follows
      case 'slip':
        if (this.vocalReady(now)) return this.voice(now, 'gasp');
        return this.heavier(0.5);
      case 'move-overload':
      case 'reach-edge': {
        if (!this.vocalReady(now)) return this.heavier(0.3 + 0.3 * sev);
        const strainOk = now - this.lastStrain >= this.strainGap;
        if (strainOk && sev > 0.75 && this.rng() < 0.45) return this.voice(now, 'strain');
        return this.voice(now, 'effort');
      }
      case 'pump-warning':
        // deep pump: heavy breathing, a strain only now and then
        if (sev > 0.85 && this.vocalReady(now) && now - this.lastStrain >= this.strainGap && this.rng() < 0.35) return this.voice(now, 'strain');
        return this.exhale(now, 0.55 + 0.35 * sev);
      case 'overload':
      case 'shake':
        return this.heavier(0.25 + 0.35 * sev);
    }
    return NONE;
  }

  /** Forget the history (new climb). */
  reset(): void {
    this.lastVocal = this.lastStrain = this.lastBreath = this.lastDynoVoiced = -Infinity;
    this.vocalGap = VOCAL_GAP.min;
    this.strainGap = STRAIN_GAP.min;
    this.breathGap = BREATH_GAP.min;
  }
}

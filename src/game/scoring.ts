// Scoring for Send Train (boulders), the Daily Boulder and the Lead Tower (rope).

import type { BoulderDef } from '../core/types';
import type { SendScore, SendScoreInput } from '../core/contracts';
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import { gradeLabel } from './grades';

export const SCORING = {
  /** Base points per send: basePerGrade · (grade + 1). */
  basePerGrade: 100,
  /** Streak multiplier: 1 + streakStep · streak (sends before this one). */
  streakStep: 0.25,
  flashBonus: 0.5,
  /** Up to +50 % for beating par; the full bonus at ≤ fullSpeedFrac · par. */
  speedBonus: 0.5,
  fullSpeedFrac: 0.4,
  /** −25 % per hint, never below zero. */
  hintPenalty: 0.25,
} as const;

const fmtMult = (m: number): string => `×${m.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}`;

/**
 * Points for one send. Breakdown values sum exactly to `points`:
 *   base 100·(grade+1) → + flash 50 % → + speed (up to 50 % vs par) → − hints 25 % each → × streak.
 */
export function scoreSend(p: SendScoreInput): SendScore {
  const grade = clamp(Math.round(p.grade), 0, 12);
  const base = SCORING.basePerGrade * (grade + 1);
  const flash = p.flash ? Math.round(base * SCORING.flashBonus) : 0;
  const par = Math.max(1, p.par);
  const speedFrac = clamp((par - p.time) / (par * (1 - SCORING.fullSpeedFrac)), 0, 1);
  const speed = Math.round(base * SCORING.speedBonus * speedFrac);
  const subtotal = base + flash + speed;
  const hintsFactor = Math.max(0, 1 - SCORING.hintPenalty * Math.max(0, Math.floor(p.hintsUsed)));
  const hints = Math.round(subtotal * hintsFactor) - subtotal;
  const afterHints = subtotal + hints;
  const mult = 1 + SCORING.streakStep * Math.max(0, Math.floor(p.streak));
  const streak = Math.round(afterHints * mult) - afterHints;

  const breakdown: { label: string; value: number }[] = [{ label: `${gradeLabel(grade)} send`, value: base }];
  if (flash) breakdown.push({ label: 'Flash', value: flash });
  if (speed) breakdown.push({ label: 'Speed', value: speed });
  if (hints) breakdown.push({ label: `Hints ×${Math.floor(p.hintsUsed)}`, value: hints });
  if (streak) breakdown.push({ label: `Streak ${fmtMult(mult)}`, value: streak });
  return { points: afterHints + streak, breakdown };
}

/** Par time (s) for a problem: grows with the number of route holds, the grade and the height. */
export function parTime(b: BoulderDef): number {
  let hands = 0;
  let feet = 0;
  for (const h of b.holds) {
    if (h.role === 'deco') continue;
    if (h.role === 'foot') feet++;
    else hands++;
  }
  const moves = hands * 1.6 + feet * 0.6;
  const perMove = 1.5 + 0.12 * clamp(b.grade, 0, 12);
  const base = b.mode === 'rope' ? 30 : 12;
  return Math.round(base + moves * perMove);
}

/**
 * Send Train grade curve: V0–V1 to start, about one grade every 1.5 sends, a little randomness,
 * capped at V12.
 */
export function runGradeFor(streak: number, rng: Rng): number {
  const s = Math.max(0, Math.floor(streak));
  let g = s / 1.5 + (rng.next() < 0.5 ? 0 : 1);
  const r = rng.next();
  if (r < 0.15) g -= 1;
  else if (r > 0.88) g += 1;
  return clamp(Math.floor(g), 0, 12);
}

/** Lead Tower score: height + clips + top bonus − falls (grade-weighted). */
export function scoreRope(p: { heightM: number; clips: number; topped: boolean; falls: number; grade: number }): number {
  const g = clamp(p.grade, 0, 12);
  const gw = 1 + 0.15 * g;
  const height = Math.max(0, p.heightM) * 40 * gw;
  const clips = Math.max(0, p.clips) * 60 * gw;
  const top = p.topped ? 1000 * (1 + 0.2 * g) : 0;
  const falls = Math.max(0, p.falls) * 150;
  return Math.max(0, Math.round(height + clips + top - falls));
}

/** Daily Boulder: points from grade, time vs par and flash (same breakdown as a send, no streak). */
export function scoreDaily(b: BoulderDef, time: number, flash: boolean, hintsUsed = 0): SendScore {
  return scoreSend({ grade: b.grade, time, par: parTime(b), flash, streak: 0, hintsUsed });
}

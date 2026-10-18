// Profile bookkeeping after climbs: lifetime stats, bests and unlocks.

import { bus } from '../core/events';
import type { Profile } from '../core/types';
import { evaluateUnlocks, recordRopeTop, type UnlockedItem } from '../net/profile';

export interface ClimbRecord {
  sent: boolean;
  grade: number;
  flash: boolean;
  /** Height gained on the wall (m). */
  meters: number;
}

/** Count one finished climb (send or fall). */
export function recordClimb(p: Profile, r: ClimbRecord): void {
  const s = p.stats;
  if (r.sent) {
    s.sends += 1;
    s.highestGrade = Math.max(s.highestGrade, Math.round(r.grade));
    if (r.flash) s.flashes += 1;
  } else {
    s.falls += 1;
  }
  s.metersClimbed = Math.round((s.metersClimbed + Math.max(0, r.meters)) * 10) / 10;
}

export function addPoints(p: Profile, points: number): void {
  p.stats.totalScore += Math.max(0, Math.round(points));
}

export function recordStreak(p: Profile, streak: number): void {
  p.stats.longestStreak = Math.max(p.stats.longestStreak, streak);
}

export function recordClip(p: Profile): void {
  p.stats.clips += 1;
}

export function recordTowerTop(p: Profile): void {
  recordRopeTop(p);
}

/** Evaluate unlock rules; announces each new item on the bus and returns them for the results card. */
export function collectUnlocks(p: Profile): UnlockedItem[] {
  const fresh = evaluateUnlocks(p);
  for (const u of fresh) bus.emit('game:unlock', { kind: u.kind, id: u.id, name: u.name });
  return fresh;
}

export const UNLOCK_WORD: Record<UnlockedItem['kind'], string> = { head: 'HEAD', colorway: 'COLOURWAY', chalk: 'CHALK' };

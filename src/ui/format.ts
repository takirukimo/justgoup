// Display formatting shared by the screens (numbers, times, grades, wall angles).

import { fontGrade, gradeColor, gradeLabel } from '../game/grades';

export const fmtInt = (n: number): string => Math.round(Number.isFinite(n) ? n : 0).toLocaleString('en-US');

/** Signed points, e.g. "+1,250" / "−520". */
export const fmtSigned = (n: number): string => (n >= 0 ? '+' : '−') + fmtInt(Math.abs(n));

/** 42.3 → "0:42.3", 65.2 → "1:05.2". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const tenth = Math.floor((r - whole) * 10);
  return `${m}:${whole < 10 ? '0' : ''}${whole}.${tenth}`;
}

/** Coarse duration, e.g. "42.3s", "1:05". */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Relative age of a timestamp: "now", "12m", "3h", "5d", "6w", "1y". */
export function fmtAge(epochMs: number, now = Date.now()): string {
  const d = Math.max(0, now - epochMs) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`;
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 7))}w ago`;
  return `${Math.floor(d / (86400 * 365))}y ago`;
}

/** Wall angle as a spec-sheet value: "25°" + kind. */
export function wallAngle(deg: number): { value: string; kind: string } {
  const a = Math.round(deg);
  if (a > 2) return { value: `${a}°`, kind: 'Overhang' };
  if (a < -2) return { value: `${-a}°`, kind: 'Slab' };
  return { value: '0°', kind: 'Vertical' };
}

export const grade = (g: number): string => gradeLabel(g);
export const fontG = (g: number): string => fontGrade(g);
export const gradeHex = (g: number): string => gradeColor(g);

export const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** "2026-10-18" → "18 OCT 2026". */
export function fmtDateKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key.toUpperCase();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? ''} ${m[1]}`;
}

export function pct(part: number, whole: number): string {
  if (!whole) return '—';
  return `${Math.round((100 * part) / whole)}%`;
}

export const modeTitle: Record<string, string> = {
  tutorial: 'Tutorial',
  boulder: 'Send Train',
  rope: 'Lead Tower',
  daily: 'Daily Boulder',
  community: 'Community',
  test: 'Test Climb',
};

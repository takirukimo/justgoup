// Display formatting shared by the screens (numbers, times, grades, wall angles).

import type { BoulderDef } from '../core/types';
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

/** Walls within ±6° of vertical look vertical, so that is what the label says. */
export const VERTICAL_TOLERANCE_DEG = 6;

export interface WallLabel {
  /** Spec-sheet label: 'WALL' (vertical), 'SLAB', 'OVERHANG' or 'MIXED' (multi-angle profile). */
  kind: string;
  /** Spec-sheet value: 'VERTICAL', '8°', '35°' or '0°→45°'. */
  value: string;
  /** Route style word when the problem has a notable one ('CAVE', 'TRAVERSE', 'DYNO', …). */
  style: string | null;
  /** One-line description, e.g. 'OVERHANG 35°', 'SLAB 8°', 'CAVE · MIXED · 0°→45°'. */
  text: string;
}

const STYLE_WORD: Partial<Record<NonNullable<BoulderDef['style']>, string>> = {
  cave: 'CAVE',
  traverse: 'TRAVERSE',
  dyno: 'DYNO',
  compression: 'COMPRESSION',
};

const deg = (a: number): string => `${a < 0 ? '−' : ''}${Math.abs(Math.round(a))}°`;

/** Kind + value for one flat angle (degrees; + overhang, − slab). */
function flat(angle: number): { kind: string; value: string; text: string } {
  const a = Math.round(angle);
  if (Math.abs(angle) < VERTICAL_TOLERANCE_DEG) return { kind: 'WALL', value: 'VERTICAL', text: 'VERTICAL' };
  if (a < 0) return { kind: 'SLAB', value: `${-a}°`, text: `SLAB ${-a}°` };
  return { kind: 'OVERHANG', value: `${a}°`, text: `OVERHANG ${a}°` };
}

/**
 * What the wall really is, for the route preview and problem cards. A multi-angle profile reads
 * as its first panel → the panel most different from it ("MIXED · 0°→45°"); panels within the
 * vertical tolerance of each other count as one flat wall.
 */
export function wallLabel(b: Pick<BoulderDef, 'wallAngle'> & Partial<Pick<BoulderDef, 'profile' | 'style'>>): WallLabel {
  const style = (b.style && STYLE_WORD[b.style]) ?? null;
  const panels = (b.profile ?? []).filter((p) => Number.isFinite(p.angle));
  let base: { kind: string; value: string; text: string };
  if (panels.length >= 2) {
    const from = panels[0].angle;
    const to = panels.reduce((far, p) => (Math.abs(p.angle - from) > Math.abs(far - from) ? p.angle : far), from);
    if (Math.abs(to - from) < VERTICAL_TOLERANCE_DEG) base = flat((from + to) / 2);
    else {
      const range = `${deg(from)}→${deg(to)}`;
      base = { kind: 'MIXED', value: range, text: `MIXED · ${range}` };
    }
  } else {
    base = flat(panels.length === 1 ? panels[0].angle : b.wallAngle);
  }
  return { ...base, style, text: style ? `${style} · ${base.text}` : base.text };
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

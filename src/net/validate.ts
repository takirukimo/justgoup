// Validation of everything that crosses the network or comes out of storage. Shared backends hold
// data written by OTHER players, so rows are treated as untrusted input: malformed entries are
// dropped, numbers clamped, strings length-capped, before the game ever renders or simulates them.

import type {
  BoulderDef,
  ClimbMode,
  CommunityProblem,
  HeadId,
  HoldDef,
  HoldRole,
  HoldType,
  LeaderboardMode,
  QuickdrawDef,
  ScoreEntry,
} from '../core/types';
import { HEADS } from '../config/skins';
import { cleanRemoteName, isProfane, randomClimberName, sanitizeName } from './names';
import { fnv1a } from './storage';

export const LIMITS = {
  scoreMax: 5_000_000,
  sendsMax: 10_000,
  gradeMax: 12,
  wallAngleMin: -15,
  wallAngleMax: 45,
  problemNameMax: 32,
  holdsMax: 400,
  quickdrawsMax: 60,
  /** Serialized BoulderDef budget (matches the `octet_length(data::text) < 60000` check). */
  boulderBytesMax: 60_000,
} as const;

export const HEAD_IDS: readonly HeadId[] = HEADS.map((h) => h.id);
export const LEADERBOARD_MODES: readonly LeaderboardMode[] = ['boulder', 'rope', 'daily'];
const HOLD_TYPES: readonly HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot', 'volume'];
const HOLD_ROLES: readonly HoldRole[] = ['start', 'hand', 'foot', 'top', 'deco'];
const DAILY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_.:\-]{1,64}$/;
/** Hold / quickdraw ids: any printable string up to 64 chars (editor-generated). */
const PART_ID_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clampInt = (v: unknown, lo: number, hi: number, dflt = lo): number => {
  const n = num(v);
  return n === null ? dflt : Math.round(clamp(n, lo, hi));
};

export function isDailyKey(v: unknown): v is string {
  return typeof v === 'string' && DAILY_RE.test(v);
}

export function isHeadId(v: unknown): v is HeadId {
  return typeof v === 'string' && (HEAD_IDS as readonly string[]).includes(v);
}

export function isLeaderboardMode(v: unknown): v is LeaderboardMode {
  return typeof v === 'string' && (LEADERBOARD_MODES as readonly string[]).includes(v);
}

/** Free-text problem name: printable, single-spaced, 1..32 chars. '' when nothing is left. */
export function sanitizeProblemName(v: unknown): string {
  if (typeof v !== 'string') return '';
  let s = v
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Count code points (Postgres char_length), never split a surrogate pair.
  const cps = Array.from(s);
  if (cps.length > LIMITS.problemNameMax) s = cps.slice(0, LIMITS.problemNameMax).join('').trimEnd();
  if (s && isProfane(s)) return 'Unnamed Project';
  return s;
}

/** Board key: mode, plus the date for the daily board. */
export function boardKey(mode: LeaderboardMode, dailyKey?: string): string {
  return mode === 'daily' ? `daily:${dailyKey ?? ''}` : mode;
}

// ───────────────────────────── scores ─────────────────────────────

/**
 * Normalise a score the local player is about to submit. Never fails: numbers are clamped, the
 * name is sanitised (falling back to a fun stand-in), unknown heads become the ibex. Throws only
 * for a daily score without a valid date key, which no backend could store.
 */
export function normalizeOutgoingScore(e: ScoreEntry): ScoreEntry {
  const mode: LeaderboardMode = isLeaderboardMode(e.mode) ? e.mode : 'boulder';
  const player = sanitizeName(e.player) || randomClimberName(fnv1a(String(e.player ?? '')));
  const out: ScoreEntry = {
    player,
    score: clampInt(e.score, 0, LIMITS.scoreMax),
    mode,
    sends: clampInt(e.sends, 0, LIMITS.sendsMax),
    maxGrade: clampInt(e.maxGrade, 0, LIMITS.gradeMax),
    head: isHeadId(e.head) ? e.head : 'ibex',
  };
  if (e.id !== undefined && typeof e.id === 'string' && ID_RE.test(e.id)) out.id = e.id;
  if (mode === 'daily') {
    if (!isDailyKey(e.dailyKey)) throw new TypeError(`daily score needs a YYYY-MM-DD dailyKey (got ${String(e.dailyKey)})`);
    out.dailyKey = e.dailyKey;
  }
  const t = num(e.createdAt);
  if (t !== null && t > 0) out.createdAt = Math.round(t);
  return out;
}

/** Validate a score row from storage / the network. Returns null for anything malformed. */
export function parseScore(raw: unknown): ScoreEntry | null {
  if (!isObj(raw)) return null;
  const player = cleanRemoteName(raw.player);
  if (!player || !isLeaderboardMode(raw.mode)) return null;
  const score = num(raw.score);
  if (score === null || score < 0 || score > LIMITS.scoreMax) return null;
  const out: ScoreEntry = {
    player,
    score: Math.round(score),
    mode: raw.mode,
    sends: clampInt(raw.sends, 0, LIMITS.sendsMax),
    maxGrade: clampInt(raw.maxGrade, 0, LIMITS.gradeMax),
    head: isHeadId(raw.head) ? raw.head : 'ibex',
  };
  if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 200) out.id = raw.id;
  if (raw.mode === 'daily') {
    if (!isDailyKey(raw.dailyKey)) return null;
    out.dailyKey = raw.dailyKey;
  }
  const t = num(raw.createdAt);
  if (t !== null && t > 0) out.createdAt = Math.round(t);
  return out;
}

/** Leaderboard order: score desc, then earlier first, then id for a stable order. */
export function compareScores(a: ScoreEntry, b: ScoreEntry): number {
  if (b.score !== a.score) return b.score - a.score;
  const ta = a.createdAt ?? Number.MAX_SAFE_INTEGER;
  const tb = b.createdAt ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

// ───────────────────────────── boulders ─────────────────────────────

function parseHold(raw: unknown): HoldDef | null {
  if (!isObj(raw)) return null;
  const x = num(raw.x);
  const y = num(raw.y);
  const size = num(raw.size);
  const angle = num(raw.angle);
  if (typeof raw.id !== 'string' || !PART_ID_RE.test(raw.id) || x === null || y === null || size === null || angle === null) return null;
  if (typeof raw.type !== 'string' || !(HOLD_TYPES as readonly string[]).includes(raw.type)) return null;
  if (typeof raw.role !== 'string' || !(HOLD_ROLES as readonly string[]).includes(raw.role)) return null;
  if (Math.abs(x) > 50 || y < -1 || y > 50) return null;
  return {
    id: raw.id,
    x,
    y,
    type: raw.type as HoldType,
    size: clamp(size, 0.01, 0.6),
    angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
    role: raw.role as HoldRole,
    color: typeof raw.color === 'string' && HEX_RE.test(raw.color) ? raw.color : '#EDEDED',
    seed: clampInt(raw.seed, 0, 0x7fffffff, 1),
  };
}

function parseQuickdraw(raw: unknown): QuickdrawDef | null {
  if (!isObj(raw)) return null;
  const x = num(raw.x);
  const y = num(raw.y);
  if (typeof raw.id !== 'string' || !PART_ID_RE.test(raw.id) || x === null || y === null) return null;
  if (Math.abs(x) > 50 || y < 0 || y > 50) return null;
  return { id: raw.id, x, y };
}

export interface ParseBoulderOptions {
  /** Require ≥ 1 start and ≥ 1 top hold (published problems). Drafts may be incomplete. */
  requireClimbable?: boolean;
}

/** Validate a BoulderDef. Returns a clean deep copy, or null if it is unusable. */
export function parseBoulder(raw: unknown, opts: ParseBoulderOptions = {}): BoulderDef | null {
  if (!isObj(raw) || !Array.isArray(raw.holds)) return null;
  if (raw.holds.length > LIMITS.holdsMax) return null;
  const mode: ClimbMode = raw.mode === 'rope' ? 'rope' : 'boulder';
  const width = num(raw.width);
  const height = num(raw.height);
  if (width === null || height === null || width < 1 || width > 20 || height < 1 || height > 40) return null;
  const holds: HoldDef[] = [];
  const seen = new Set<string>();
  for (const h of raw.holds) {
    const hold = parseHold(h);
    if (!hold || seen.has(hold.id)) return null;
    seen.add(hold.id);
    holds.push(hold);
  }
  if (opts.requireClimbable) {
    if (!holds.some((h) => h.role === 'start') || !holds.some((h) => h.role === 'top')) return null;
  }
  const out: BoulderDef = {
    id: typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64 ? raw.id : `b-${fnv1a(JSON.stringify(holds)).toString(36)}`,
    name: sanitizeProblemName(raw.name) || 'Untitled',
    grade: clampInt(raw.grade, 0, LIMITS.gradeMax),
    mode,
    wallAngle: clamp(num(raw.wallAngle) ?? 0, LIMITS.wallAngleMin, LIMITS.wallAngleMax),
    width,
    height,
    holds,
    color: typeof raw.color === 'string' && HEX_RE.test(raw.color) ? raw.color : holds.find((h) => h.role !== 'deco')?.color ?? '#F2C230',
    seed: clampInt(raw.seed, 0, 0x7fffffff, 1),
  };
  if (Array.isArray(raw.quickdraws)) {
    if (raw.quickdraws.length > LIMITS.quickdrawsMax) return null;
    const qd: QuickdrawDef[] = [];
    for (const q of raw.quickdraws) {
      const d = parseQuickdraw(q);
      if (!d) return null;
      qd.push(d);
    }
    out.quickdraws = qd;
  }
  const author = cleanRemoteName(raw.author);
  if (author) out.author = author;
  const t = num(raw.createdAt);
  if (t !== null && t > 0) out.createdAt = Math.round(t);
  if (isObj(raw.startFeet)) {
    const sf: { LF?: string; RF?: string } = {};
    if (typeof raw.startFeet.LF === 'string' && seen.has(raw.startFeet.LF)) sf.LF = raw.startFeet.LF;
    if (typeof raw.startFeet.RF === 'string' && seen.has(raw.startFeet.RF)) sf.RF = raw.startFeet.RF;
    if (sf.LF || sf.RF) out.startFeet = sf;
  }
  return out;
}

/** UTF-8 byte length of the JSON encoding as Postgres stores it in jsonb (an upper bound). */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? '';
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Postgres renders jsonb::text with a space after every ':' and ',' (the CHECK measures that)
    if (c === 0x3a || c === 0x2c) bytes += 2;
    else if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export interface PublishInput {
  name: string;
  author: string;
  grade: number;
  boulder: BoulderDef;
}

/**
 * Validate a problem the local player wants to publish. Returns the cleaned fields, with the
 * boulder's name/author/grade aligned to the listing. Throws a TypeError describing the problem.
 */
export function normalizePublish(p: PublishInput): PublishInput {
  const name = sanitizeProblemName(p.name) || sanitizeProblemName(p.boulder?.name);
  if (!name) throw new TypeError('problem needs a name (1–32 characters)');
  const author = sanitizeName(p.author);
  if (!author) throw new TypeError('problem needs a valid author name (2–16 characters)');
  const boulder = parseBoulder(p.boulder, { requireClimbable: true });
  if (!boulder) throw new TypeError('problem is not a valid boulder (needs start + top holds and sane geometry)');
  const grade = clampInt(p.grade, 0, LIMITS.gradeMax, boulder.grade);
  boulder.name = name;
  boulder.author = author;
  boulder.grade = grade;
  if (jsonBytes(boulder) >= LIMITS.boulderBytesMax) throw new TypeError('problem is too large to publish');
  return { name, author, grade, boulder };
}

/** Validate a stored / remote community problem. */
export function parseCommunityProblem(raw: unknown): CommunityProblem | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 200) return null;
  const boulder = parseBoulder(raw.boulder, { requireClimbable: true });
  if (!boulder) return null;
  const name = sanitizeProblemName(raw.name) || boulder.name;
  const author = cleanRemoteName(raw.author) ?? boulder.author ?? null;
  if (!author) return null;
  const grade = clampInt(raw.grade, 0, LIMITS.gradeMax, boulder.grade);
  const createdAt = num(raw.createdAt) ?? boulder.createdAt ?? 0;
  const plays = clampInt(raw.plays, 0, 1e9);
  const sends = Math.min(clampInt(raw.sends, 0, 1e9), plays);
  return {
    id: raw.id,
    name,
    author,
    grade,
    boulder: { ...boulder, id: raw.id, name, author, grade, createdAt },
    plays,
    sends,
    createdAt,
  };
}

export function compareProblems(sort: 'new' | 'popular'): (a: CommunityProblem, b: CommunityProblem) => number {
  return (a, b) => {
    if (sort === 'popular' && b.plays !== a.plays) return b.plays - a.plays;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
  };
}

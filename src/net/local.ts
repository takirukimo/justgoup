// OFFLINE backend: leaderboards + community problems kept on this device (localStorage, with an
// in-memory fallback when storage is unavailable). Seeded with clearly-marked ghost entries
// (ids start with `ghost-`) so a fresh install never shows an empty board.

import type { BackendAPI } from '../core/contracts';
import type { CommunityProblem, LeaderboardMode, ScoreEntry } from '../core/types';
import { ghostProblems, ghostScores, isGhostId } from './ghosts';
import { kv, randomId, readJSON, writeJSON, type KVStore } from './storage';
import {
  boardKey,
  compareProblems,
  compareScores,
  isDailyKey,
  normalizeOutgoingScore,
  normalizePublish,
  parseCommunityProblem,
  parseScore,
  type PublishInput,
} from './validate';

export const LOCAL_KEYS = {
  scores: 'jgu.local.scores.v1',
  problems: 'jgu.local.problems.v1',
  stats: 'jgu.local.stats.v1',
} as const;

/** Per-board history kept on device, and how long daily boards are kept. */
const MAX_PER_BOARD = 100;
const DAILY_KEEP_DAYS = 60;
const MAX_LOCAL_PROBLEMS = 100;
const MAX_STATS = 500;

export const DEFAULT_SCORE_LIMIT = 50;
export const DEFAULT_PROBLEM_LIMIT = 30;

/** 'YYYY-MM-DD' for the given time (UTC), matching the daily boulder key. */
export function utcDayKey(t: number = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10);
}

export interface LocalBackendOptions {
  store?: KVStore;
  /** Seed ghost leaderboard entries + Steini's problems (default true). */
  ghosts?: boolean;
  now?: () => number;
}

interface Stat {
  plays: number;
  sends: number;
}

export class LocalBackend implements BackendAPI {
  readonly kind = 'local' as const;
  readonly isGlobal = false;
  readonly label = 'OFFLINE';

  private readonly store: KVStore;
  private readonly ghosts: boolean;
  private readonly now: () => number;

  constructor(opts: LocalBackendOptions = {}) {
    this.store = opts.store ?? kv;
    this.ghosts = opts.ghosts ?? true;
    this.now = opts.now ?? Date.now;
  }

  /** Whether data survives a reload on this device (false = memory-only session). */
  get persistent(): boolean {
    return this.store.persistent;
  }

  async submitScore(e: ScoreEntry): Promise<{ rank: number | null }> {
    const entry = normalizeOutgoingScore(e);
    entry.id = entry.id && !isGhostId(entry.id) ? entry.id : randomId('local-s-');
    const all = this.loadScores().filter((s) => s.id !== entry.id);
    // Strictly increasing timestamps keep "earlier run first" deterministic for ties.
    let latest = 0;
    for (const s of all) if ((s.createdAt ?? 0) > latest) latest = s.createdAt ?? 0;
    entry.createdAt = Math.max(this.now(), latest + 1);
    all.push(entry);
    this.saveScores(all);
    const board = this.board(entry.mode, entry.dailyKey, all);
    return { rank: rankOf(entry.score, board.filter((s) => s.id !== entry.id)) };
  }

  async topScores(mode: LeaderboardMode, opts: { limit?: number; dailyKey?: string } = {}): Promise<ScoreEntry[]> {
    const limit = clampLimit(opts.limit, DEFAULT_SCORE_LIMIT, 500);
    const dailyKey = mode === 'daily' ? (isDailyKey(opts.dailyKey) ? opts.dailyKey : utcDayKey(this.now())) : undefined;
    return this.board(mode, dailyKey, this.loadScores()).slice(0, limit);
  }

  async publishProblem(p: PublishInput): Promise<CommunityProblem> {
    const clean = normalizePublish(p);
    const id = randomId('local-p-');
    const createdAt = this.now();
    const problem: CommunityProblem = {
      id,
      name: clean.name,
      author: clean.author,
      grade: clean.grade,
      boulder: { ...clean.boulder, id, createdAt },
      plays: 0,
      sends: 0,
      createdAt,
    };
    const list = this.loadProblems();
    list.push(problem);
    list.sort(compareProblems('new'));
    writeJSON(LOCAL_KEYS.problems, list.slice(0, MAX_LOCAL_PROBLEMS), this.store);
    return problem;
  }

  async listProblems(opts: { sort?: 'new' | 'popular'; limit?: number } = {}): Promise<CommunityProblem[]> {
    const sort = opts.sort === 'popular' ? 'popular' : 'new';
    const limit = clampLimit(opts.limit, DEFAULT_PROBLEM_LIMIT, 200);
    const stats = this.loadStats();
    const all = [...this.loadProblems(), ...(this.ghosts ? ghostProblems() : [])].map((p) => {
      const s = stats[p.id];
      if (!s) return p;
      const plays = p.plays + s.plays;
      return { ...p, plays, sends: Math.min(plays, p.sends + s.sends) };
    });
    return all.sort(compareProblems(sort)).slice(0, limit);
  }

  async recordAttempt(problemId: string, sent: boolean): Promise<void> {
    if (typeof problemId !== 'string' || problemId.length === 0 || problemId.length > 200) return;
    const stats = this.loadStats();
    const cur = stats[problemId] ?? { plays: 0, sends: 0 };
    delete stats[problemId];
    // Re-inserted last → insertion order doubles as recency for pruning.
    stats[problemId] = { plays: cur.plays + 1, sends: cur.sends + (sent ? 1 : 0) };
    const keys = Object.keys(stats);
    for (let i = 0; i < keys.length - MAX_STATS; i++) delete stats[keys[i]];
    writeJSON(LOCAL_KEYS.stats, stats, this.store);
  }

  // ───────────────────────── internals ─────────────────────────

  private board(mode: LeaderboardMode, dailyKey: string | undefined, all: ScoreEntry[]): ScoreEntry[] {
    const key = boardKey(mode, dailyKey);
    const mine = all.filter((s) => boardKey(s.mode, s.dailyKey) === key);
    const ghosts = this.ghosts ? ghostScores(mode, dailyKey) : [];
    return [...mine, ...ghosts].sort(compareScores);
  }

  private loadScores(): ScoreEntry[] {
    const raw = readJSON<unknown>(LOCAL_KEYS.scores, [], this.store);
    if (!Array.isArray(raw)) return [];
    const out: ScoreEntry[] = [];
    for (const r of raw) {
      const s = parseScore(r);
      if (s && s.id && !isGhostId(s.id)) out.push(s);
    }
    return out;
  }

  private saveScores(all: ScoreEntry[]): void {
    const cutoff = utcDayKey(this.now() - DAILY_KEEP_DAYS * 86_400_000);
    const byBoard = new Map<string, ScoreEntry[]>();
    for (const s of all) {
      if (s.mode === 'daily' && (s.dailyKey ?? '') < cutoff) continue;
      const k = boardKey(s.mode, s.dailyKey);
      let list = byBoard.get(k);
      if (!list) byBoard.set(k, (list = []));
      list.push(s);
    }
    const kept: ScoreEntry[] = [];
    for (const list of byBoard.values()) kept.push(...list.sort(compareScores).slice(0, MAX_PER_BOARD));
    writeJSON(LOCAL_KEYS.scores, kept, this.store);
  }

  private loadProblems(): CommunityProblem[] {
    const raw = readJSON<unknown>(LOCAL_KEYS.problems, [], this.store);
    if (!Array.isArray(raw)) return [];
    const out: CommunityProblem[] = [];
    for (const r of raw) {
      const p = parseCommunityProblem(r);
      if (p && !isGhostId(p.id)) out.push(p);
    }
    return out;
  }

  private loadStats(): Record<string, Stat> {
    const raw = readJSON<unknown>(LOCAL_KEYS.stats, {}, this.store);
    const out: Record<string, Stat> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const plays = Number((v as Stat).plays);
      const sends = Number((v as Stat).sends);
      if (!Number.isFinite(plays) || plays < 0) continue;
      out[id] = { plays: Math.floor(plays), sends: Number.isFinite(sends) ? Math.max(0, Math.min(Math.floor(sends), Math.floor(plays))) : 0 };
    }
    return out;
  }
}

/** 1-based rank of `score` among `others` (ties share the better rank). */
export function rankOf(score: number, others: readonly ScoreEntry[]): number {
  let ahead = 0;
  for (const s of others) if (s.score > score) ahead++;
  return ahead + 1;
}

export function clampLimit(v: number | undefined, dflt: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.max(1, Math.min(max, Math.floor(v)));
}

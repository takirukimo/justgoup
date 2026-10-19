// GLOBAL backend: Supabase via its PostgREST API (plain fetch, no SDK). Tables, policies, the rate
// limit and the RPCs live in supabase/schema.sql.
//
//   POST /rest/v1/scores                 insert a run (client-generated uuid → retries are idempotent)
//   POST /rest/v1/rpc/score_rank         1-based rank of a score on its board
//   GET  /rest/v1/scores?mode=eq.…       leaderboard
//   POST /rest/v1/problems               publish (BoulderDef JSON in `data jsonb`)
//   GET  /rest/v1/problems?order=…       community list (new / popular)
//   POST /rest/v1/rpc/record_attempt     plays/sends counters (security definer)

import type { BackendAPI } from '../core/contracts';
import type { CommunityProblem, LeaderboardMode, ScoreEntry } from '../core/types';
import { BACKEND_TIMEOUTS } from '../config/backend';
import { BackendError, deadline } from './errors';
import { clampLimit, DEFAULT_PROBLEM_LIMIT, DEFAULT_SCORE_LIMIT, utcDayKey } from './local';
import { uuid } from './storage';
import {
  compareScores,
  isDailyKey,
  normalizeOutgoingScore,
  normalizePublish,
  parseCommunityProblem,
  parseScore,
  type PublishInput,
} from './validate';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const SCORE_COLUMNS = 'id,player,mode,score,sends,max_grade,head,daily_key,created_at';
const PROBLEM_COLUMNS = 'id,name,author,grade,wall_angle,data,plays,sends,created_at';

/** Row shapes (snake_case, as stored). */
export interface ScoreRow {
  id: string;
  player: string;
  mode: LeaderboardMode;
  score: number;
  sends: number;
  max_grade: number;
  head: string;
  daily_key: string | null;
  created_at: string;
}

export interface ProblemRow {
  id: string;
  name: string;
  author: string;
  grade: number;
  wall_angle: number;
  data: unknown;
  plays: number;
  sends: number;
  created_at: string;
}

export function scoreFromRow(r: Partial<ScoreRow>): ScoreEntry | null {
  return parseScore({
    id: r.id,
    player: r.player,
    mode: r.mode,
    score: r.score,
    sends: r.sends,
    maxGrade: r.max_grade,
    head: r.head,
    dailyKey: r.daily_key ?? undefined,
    createdAt: typeof r.created_at === 'string' ? Date.parse(r.created_at) : undefined,
  });
}

export function scoreToRow(e: ScoreEntry, id: string): Omit<ScoreRow, 'created_at'> {
  return {
    id,
    player: e.player,
    mode: e.mode,
    score: e.score,
    sends: e.sends,
    max_grade: e.maxGrade,
    head: e.head,
    daily_key: e.mode === 'daily' ? e.dailyKey ?? null : null,
  };
}

export function problemFromRow(r: Partial<ProblemRow>): CommunityProblem | null {
  return parseCommunityProblem({
    id: r.id,
    name: r.name,
    author: r.author,
    grade: r.grade,
    boulder: r.data,
    plays: r.plays,
    sends: r.sends,
    createdAt: typeof r.created_at === 'string' ? Date.parse(r.created_at) : undefined,
  });
}

export interface SupabaseBackendOptions {
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  prefer?: string;
  timeoutMs?: number;
}

export class SupabaseBackend implements BackendAPI {
  readonly kind = 'supabase' as const;
  readonly isGlobal = true;
  readonly label = 'GLOBAL';

  private readonly base: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, anonKey: string, opts: SupabaseBackendOptions = {}) {
    this.base = `${url.replace(/\/+$/, '')}/rest/v1/`;
    this.key = anonKey;
    this.timeoutMs = opts.timeoutMs ?? BACKEND_TIMEOUTS.request;
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    this.fetchFn = f ? (input, init) => f(input, init) : () => Promise.reject(new TypeError('fetch is not available'));
  }

  /** Stable identity for the outbox (scores queued for this project only flush here). */
  get target(): string {
    return `supabase:${this.base}`;
  }

  /** True when the project answers and the schema is installed. Never throws. */
  async health(timeoutMs: number = BACKEND_TIMEOUTS.health): Promise<boolean> {
    try {
      await this.request('GET', 'scores?select=id&limit=1', { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async submitScore(e: ScoreEntry): Promise<{ rank: number | null }> {
    const entry = normalizeOutgoingScore(e);
    const id = isUuid(entry.id) ? entry.id : uuid();
    try {
      await this.insertScore(entry, id);
    } catch (err) {
      // A project still on an older supabase/schema.sql rejects heads added later (the 'human'
      // climber) with its head check: keep the run, filed under the default head.
      if (!isHeadRejected(err) || entry.head === 'ibex') throw err;
      console.warn('[net] this Supabase project predates the', entry.head, 'head (re-run supabase/schema.sql); saved the score as ibex');
      await this.insertScore({ ...entry, head: 'ibex' }, id);
    }
    try {
      const rank = await this.request<unknown>('POST', 'rpc/score_rank', {
        body: { p_mode: entry.mode, p_score: entry.score, p_daily_key: entry.mode === 'daily' ? entry.dailyKey ?? null : null },
      });
      const n = typeof rank === 'number' ? rank : Number(rank);
      return { rank: Number.isInteger(n) && n >= 1 ? n : null };
    } catch {
      return { rank: null }; // the score is saved; a missing rank is cosmetic
    }
  }

  private async insertScore(entry: ScoreEntry, id: string): Promise<void> {
    try {
      await this.request('POST', 'scores', { body: scoreToRow(entry, id), prefer: 'return=minimal' });
    } catch (err) {
      // A retried insert whose first attempt already landed: same id → unique violation. Fine.
      if (!isDuplicate(err)) throw err;
    }
  }

  async topScores(mode: LeaderboardMode, opts: { limit?: number; dailyKey?: string } = {}): Promise<ScoreEntry[]> {
    const limit = clampLimit(opts.limit, DEFAULT_SCORE_LIMIT, 500);
    const q = new URLSearchParams({ select: SCORE_COLUMNS, mode: `eq.${mode}` });
    if (mode === 'daily') q.set('daily_key', `eq.${isDailyKey(opts.dailyKey) ? opts.dailyKey : utcDayKey()}`);
    else q.set('daily_key', 'is.null'); // matches the partial leaderboard index
    q.set('order', 'score.desc,created_at.asc');
    q.set('limit', String(limit));
    const rows = await this.request<unknown>('GET', `scores?${q.toString()}`);
    if (!Array.isArray(rows)) throw new BackendError('Supabase: unexpected leaderboard response', 'http', { retryable: true });
    const out: ScoreEntry[] = [];
    for (const r of rows) {
      const s = scoreFromRow(r as Partial<ScoreRow>);
      if (s && s.mode === mode) out.push(s);
    }
    return out.sort(compareScores);
  }

  async publishProblem(p: PublishInput & { id?: string }): Promise<CommunityProblem> {
    const clean = normalizePublish(p);
    const id = isUuid(p.id) ? p.id : uuid();
    const boulder = { ...clean.boulder, id };
    const row = { id, name: clean.name, author: clean.author, grade: clean.grade, wall_angle: boulder.wallAngle, data: boulder };
    let rows: unknown;
    try {
      rows = await this.request<unknown>('POST', 'problems', { body: row, prefer: 'return=representation' });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      // Retried publish that already landed: return the stored row.
      rows = await this.request<unknown>('GET', `problems?select=${PROBLEM_COLUMNS}&id=eq.${id}`);
    }
    const first = Array.isArray(rows) ? rows[0] : rows;
    const problem = first ? problemFromRow(first as Partial<ProblemRow>) : null;
    if (problem) return problem;
    // Inserted, but the representation was unusable: build it from what we sent.
    const createdAt = Date.now();
    return { id, name: clean.name, author: clean.author, grade: clean.grade, boulder: { ...boulder, createdAt }, plays: 0, sends: 0, createdAt };
  }

  async listProblems(opts: { sort?: 'new' | 'popular'; limit?: number } = {}): Promise<CommunityProblem[]> {
    const limit = clampLimit(opts.limit, DEFAULT_PROBLEM_LIMIT, 200);
    const order = opts.sort === 'popular' ? 'plays.desc,created_at.desc' : 'created_at.desc,id.asc';
    const q = new URLSearchParams({ select: PROBLEM_COLUMNS, order, limit: String(limit) });
    const rows = await this.request<unknown>('GET', `problems?${q.toString()}`);
    if (!Array.isArray(rows)) throw new BackendError('Supabase: unexpected problem list response', 'http', { retryable: true });
    const out: CommunityProblem[] = [];
    for (const r of rows) {
      const p = problemFromRow(r as Partial<ProblemRow>);
      if (p) out.push(p);
    }
    return out;
  }

  async recordAttempt(problemId: string, sent: boolean): Promise<void> {
    if (!isUuid(problemId)) return; // local / ghost problems never reach the server
    await this.request('POST', 'rpc/record_attempt', { body: { p_problem_id: problemId, p_sent: !!sent } });
  }

  // ───────────────────────── HTTP ─────────────────────────

  private async request<T = unknown>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const cancelTimer = deadline(timeoutMs, () => {
      timedOut = true;
      ctrl?.abort();
    });
    const headers: Record<string, string> = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.prefer) headers.Prefer = opts.prefer;
    const what = `${method} ${path.split('?')[0]}`;

    let res: Response;
    try {
      const pending = this.fetchFn(this.base + path, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl?.signal,
        cache: 'no-store',
      });
      // Without AbortController support the timer still bounds the wait.
      res = await new Promise<Response>((resolve, reject) => {
        pending.then(resolve, reject);
        if (!ctrl) setTimeout(() => reject(new DOMException('timeout', 'AbortError')), timeoutMs);
      });
    } catch (err) {
      cancelTimer();
      if (timedOut) throw new BackendError(`Supabase ${what} timed out after ${timeoutMs} ms`, 'timeout', { cause: err });
      throw new BackendError(`Supabase ${what}: network error`, 'network', { cause: err, detail: err instanceof Error ? err.message : String(err) });
    }

    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      cancelTimer();
      if (timedOut) throw new BackendError(`Supabase ${what} timed out after ${timeoutMs} ms`, 'timeout', { cause: err });
      throw new BackendError(`Supabase ${what}: response interrupted`, 'network', { cause: err });
    }
    cancelTimer();

    if (!res.ok) throw httpError(what, res.status, text);
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BackendError(`Supabase ${what}: malformed JSON response`, 'http', { status: res.status, retryable: true });
    }
  }
}

/** Map a PostgREST error response to a BackendError with a clear message. */
function httpError(what: string, status: number, body: string): BackendError {
  let code = '';
  let message = '';
  let hint = '';
  try {
    const j = JSON.parse(body) as { code?: unknown; message?: unknown; hint?: unknown; details?: unknown };
    code = typeof j.code === 'string' ? j.code : '';
    message = typeof j.message === 'string' ? j.message : '';
    hint = typeof j.hint === 'string' ? j.hint : '';
  } catch {
    message = body.slice(0, 200);
  }
  const detail = [code, message, hint].filter(Boolean).join(': ');
  const base = `Supabase ${what} failed (HTTP ${status}${code ? ` ${code}` : ''})${message ? `: ${message}` : ''}`;
  if (status === 429 || code === 'PT429') return new BackendError(base, 'rate_limited', { status, detail, retryable: true });
  if (status === 408 || status >= 500) return new BackendError(base, 'http', { status, detail, retryable: true });
  if (status === 409 || code === '23505') return new BackendError(base, 'invalid', { status: 409, detail, retryable: false });
  if (status === 401 || status === 403) {
    return new BackendError(`${base} — check SUPABASE_ANON_KEY and the RLS policies in supabase/schema.sql`, 'invalid', { status, detail, retryable: false });
  }
  if (status === 404) {
    return new BackendError(`${base} — is supabase/schema.sql installed on this project?`, 'invalid', { status, detail, retryable: false });
  }
  return new BackendError(base, 'invalid', { status, detail, retryable: false });
}

/** The insert broke the scores table's head check (23514 on scores_head_check). */
function isHeadRejected(err: unknown): boolean {
  if (!(err instanceof BackendError)) return false;
  const d = err.detail ?? '';
  return d.startsWith('23514') && /head/i.test(d);
}

function isDuplicate(err: unknown): boolean {
  return err instanceof BackendError && err.status === 409 && (err.detail ?? '').startsWith('23505');
}

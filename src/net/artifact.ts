// CLAUDE SHARED backend: the claude.ai Artifact `db` capability (a shared document store per
// artifact, see the platform's db.d.ts). Used when the single-file build runs inside claude.ai.
//
// Data model (all writes are idempotent `set`s on pre-minted ids, so a retried call never
// duplicates anything):
//   scores/{board}~{playerKey}                 one doc per player per board, holding their BEST run
//   problems/{id}                              { name, author, grade, wallAngle, boulder, createdAt, uid }
//   problem_stats/{problemId}                  { plays, sends } aggregate, read by listProblems
//   problem_stats/{problemId}/players/{key}    { plays, sends } per player — the source of truth
//
// Why this shape: the store is last-writer-wins with no transactions and caps an artifact at 25k
// documents. A shared counter updated by read-modify-write would lose increments under
// concurrency, and one document per attempt / per run grows without bound. Instead every
// document has exactly ONE writer (the player it belongs to), so its read-modify-write is safe,
// and growth is bounded by players × boards and players × problems. The aggregate doc is a
// convergent cache: whoever records an attempt recomputes it from the per-player docs.
//
// Read-only viewers (Viewer / Commenter, or outside visitors) can read but not write shared docs:
// a write rejected with `invalid_argument` (or `user.can('data.write') === false`) switches this
// backend to read-only for the rest of the visit, and writes then land in the local backend.

import type { BackendAPI } from '../core/contracts';
import type { CommunityProblem, LeaderboardMode, ScoreEntry } from '../core/types';
import { BACKEND_TIMEOUTS } from '../config/backend';
import { dbErrorCode, type ArtifactDB, type ArtifactUser, type DocumentSnapshot } from './artifact-types';
import { BackendError, sleep, withTimeout } from './errors';
import { isGhostId } from './ghosts';
import { clampLimit, DEFAULT_PROBLEM_LIMIT, DEFAULT_SCORE_LIMIT, LocalBackend, utcDayKey } from './local';
import { deviceId, fnv1a, kv, type KVStore } from './storage';
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

export const ARTIFACT_COLLECTIONS = {
  scores: 'scores',
  problems: 'problems',
  stats: 'problem_stats',
  statPlayers: 'players',
} as const;

/** Rank window: ranks are computed from the top N of a board. */
const RANK_WINDOW = 500;
const PROBLEM_SCAN = 300;
const STATS_SCAN = 1000;
/** Per-player contribution cap, so one client cannot skew a problem's counters. */
const MAX_PLAYS_PER_PLAYER = 5000;

const SEGMENT_RE = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const isSegment = (s: string): boolean => SEGMENT_RE.test(s) && s !== '.' && s !== '..';

const LIFECYCLE_TERMINAL = new Set(['revoked', 'not_granted', 'capability_disabled', 'capability_removed']);

export interface ArtifactBackendOptions {
  user?: ArtifactUser | null;
  /** Platform user id (already awaited). Undefined = ask `user.id()` lazily. */
  uid?: string | null;
  /** Start read-only (e.g. `user.can('data.write') === false`). */
  readOnly?: boolean;
  /** Where writes go when this viewer cannot write shared data. */
  local?: LocalBackend;
  timeoutMs?: number;
  store?: KVStore;
}

export class ArtifactBackend implements BackendAPI {
  readonly kind = 'artifact' as const;
  readonly isGlobal = true;
  readonly label = 'CLAUDE SHARED';

  private readonly db: ArtifactDB;
  private readonly user: ArtifactUser | null;
  private readonly local: LocalBackend;
  private readonly timeoutMs: number;
  private readonly store: KVStore;
  private uidPromise: Promise<string | null> | null;
  private keyPromise: Promise<string> | null = null;
  private _readOnly: boolean;
  private _dead = false;
  private _notice: string | null = null;
  private readonly ownStats = new Map<string, { plays: number; sends: number }>();
  private readonly statChains = new Map<string, Promise<void>>();

  constructor(db: ArtifactDB, opts: ArtifactBackendOptions = {}) {
    this.db = db;
    this.user = opts.user ?? null;
    this.local = opts.local ?? new LocalBackend({ store: opts.store });
    this.timeoutMs = opts.timeoutMs ?? BACKEND_TIMEOUTS.request;
    this.store = opts.store ?? kv;
    this.uidPromise = opts.uid !== undefined ? Promise.resolve(opts.uid) : null;
    this._readOnly = opts.readOnly ?? false;
  }

  /** Build with the viewer's id and write permission resolved up front (each bounded to 1.5 s). */
  static async create(db: ArtifactDB, user: ArtifactUser | null, opts: Omit<ArtifactBackendOptions, 'user' | 'uid' | 'readOnly'> = {}): Promise<ArtifactBackend> {
    let uid: string | null = null;
    let canWrite: boolean | null = null;
    if (user) {
      [uid, canWrite] = await Promise.all([
        withTimeout(Promise.resolve().then(() => user.id()), 1500, 'user.id').catch(() => null),
        withTimeout(Promise.resolve().then(() => user.can('data.write')), 1500, 'user.can').catch(() => null),
      ]);
    }
    return new ArtifactBackend(db, { ...opts, user, uid: typeof uid === 'string' && uid ? uid : null, readOnly: canWrite === false });
  }

  /** True once this viewer is known not to be able to write shared data. */
  get readOnly(): boolean {
    return this._readOnly;
  }

  /** A message worth surfacing to the player (e.g. the shared board is full), or null. */
  get notice(): string | null {
    return this._notice;
  }

  /** Quick availability probe: a 1-document read. Rejects with a BackendError. */
  async probe(): Promise<void> {
    await this.call('probe', () => this.db.collection(ARTIFACT_COLLECTIONS.scores).limit(1).get());
  }

  // ───────────────────────── scores ─────────────────────────

  async submitScore(e: ScoreEntry): Promise<{ rank: number | null }> {
    const entry = normalizeOutgoingScore(e);
    entry.createdAt = Date.now();
    if (this._readOnly) return this.saveScoreLocally(entry);

    const board = boardKey(entry.mode, entry.dailyKey);
    const pk = await this.playerKey();
    const uid = await this.uid();
    const docId = `${board}~${pk}`;
    try {
      const ref = this.db.collection(ARTIFACT_COLLECTIONS.scores).doc(docId);
      const snap = await this.call('read best score', () => ref.get());
      const prev = snap.exists ? parseScore(snapData(snap)) : null;
      if (!prev || entry.score > prev.score) {
        const body: Record<string, unknown> = {
          board,
          player: entry.player,
          score: entry.score,
          mode: entry.mode,
          sends: entry.sends,
          maxGrade: entry.maxGrade,
          head: entry.head,
          createdAt: entry.createdAt,
          uid,
        };
        if (entry.dailyKey) body.dailyKey = entry.dailyKey;
        await this.call('write score', () => ref.set(body), true);
      } else if (prev.player !== entry.player || prev.head !== entry.head) {
        // Not a new best, but keep the name / head on the board current.
        await this.call('update score', () => ref.update({ player: entry.player, head: entry.head }), true);
      }
    } catch (err) {
      if (this.absorbWriteError(err)) return this.saveScoreLocally(entry);
      throw err;
    }
    try {
      return { rank: await this.rankFor(board, entry.score, docId) };
    } catch {
      return { rank: null };
    }
  }

  async topScores(mode: LeaderboardMode, opts: { limit?: number; dailyKey?: string } = {}): Promise<ScoreEntry[]> {
    const limit = clampLimit(opts.limit, DEFAULT_SCORE_LIMIT, 500);
    const dailyKey = mode === 'daily' ? (isDailyKey(opts.dailyKey) ? opts.dailyKey : utcDayKey()) : undefined;
    const board = boardKey(mode, dailyKey);
    const snap = await this.call('read leaderboard', () =>
      this.db.collection(ARTIFACT_COLLECTIONS.scores).where('board', '==', board).orderBy('score', 'desc').limit(limit).get(),
    );
    const out: ScoreEntry[] = [];
    for (const d of snap.docs) {
      const s = parseScore({ ...snapData(d), id: d.id });
      if (s && s.mode === mode && (mode !== 'daily' || s.dailyKey === dailyKey)) out.push(s);
    }
    return out.sort(compareScores).slice(0, limit);
  }

  private async rankFor(board: string, score: number, ownId: string): Promise<number | null> {
    const snap = await this.call('read rank window', () =>
      this.db.collection(ARTIFACT_COLLECTIONS.scores).where('board', '==', board).orderBy('score', 'desc').limit(RANK_WINDOW).get(),
    );
    let ahead = 0;
    let others = 0;
    for (const d of snap.docs) {
      if (d.id === ownId) continue;
      others++;
      const s = parseScore({ ...snapData(d), id: d.id });
      if (s && s.score > score) ahead++;
    }
    // Every document in a full window outranks us → the true rank is beyond what we can see.
    if (snap.size >= RANK_WINDOW && ahead === others) return null;
    return ahead + 1;
  }

  private async saveScoreLocally(entry: ScoreEntry): Promise<{ rank: number | null }> {
    try {
      await this.local.submitScore(entry);
    } catch {
      /* local persistence is best effort */
    }
    // The run is not on the shared board, so a shared rank would be misleading.
    return { rank: null };
  }

  // ───────────────────────── problems ─────────────────────────

  async publishProblem(p: PublishInput & { id?: string }): Promise<CommunityProblem> {
    const clean = normalizePublish(p);
    if (this._readOnly) return this.local.publishProblem(clean);
    const uid = await this.uid();
    const col = this.db.collection(ARTIFACT_COLLECTIONS.problems);
    // Reuse a caller-supplied id (the outbox retries with the same one) so a retry overwrites, never duplicates.
    const ref = typeof p.id === 'string' && isSegment(p.id) ? col.doc(p.id) : col.doc();
    const createdAt = Date.now();
    const boulder = { ...clean.boulder, id: ref.id, createdAt };
    try {
      await this.call(
        'publish problem',
        () =>
          ref.set({
            name: clean.name,
            author: clean.author,
            grade: clean.grade,
            wallAngle: boulder.wallAngle,
            boulder: JSON.parse(JSON.stringify(boulder)) as Record<string, unknown>,
            createdAt,
            uid,
          }),
        true,
      );
    } catch (err) {
      if (this.absorbWriteError(err)) return this.local.publishProblem(clean);
      throw err;
    }
    return { id: ref.id, name: clean.name, author: clean.author, grade: clean.grade, boulder, plays: 0, sends: 0, createdAt };
  }

  async listProblems(opts: { sort?: 'new' | 'popular'; limit?: number } = {}): Promise<CommunityProblem[]> {
    const sort = opts.sort === 'popular' ? 'popular' : 'new';
    const limit = clampLimit(opts.limit, DEFAULT_PROBLEM_LIMIT, 200);
    const scan = sort === 'popular' ? PROBLEM_SCAN : limit;
    const [problems, stats] = await Promise.all([
      this.call('list problems', () => this.db.collection(ARTIFACT_COLLECTIONS.problems).orderBy('createdAt', 'desc').limit(scan).get()),
      this.call('read problem stats', () => this.db.collection(ARTIFACT_COLLECTIONS.stats).limit(STATS_SCAN).get()).catch(() => null),
    ]);
    const counts = new Map<string, { plays: number; sends: number }>();
    if (stats) for (const d of stats.docs) counts.set(d.id, readCounts(snapData(d), 1e9));
    const out: CommunityProblem[] = [];
    for (const d of problems.docs) {
      const c = counts.get(d.id) ?? { plays: 0, sends: 0 };
      const p = parseCommunityProblem({ ...snapData(d), id: d.id, plays: c.plays, sends: c.sends });
      if (p) out.push(p);
    }
    if (this._readOnly) {
      // Problems this viewer published while unable to write shared data stay visible to them.
      const mine = await this.local.listProblems({ sort, limit }).catch(() => [] as CommunityProblem[]);
      out.push(...mine.filter((p) => !isGhostId(p.id)));
    }
    return out.sort(compareProblems(sort)).slice(0, limit);
  }

  async recordAttempt(problemId: string, sent: boolean): Promise<void> {
    if (typeof problemId !== 'string' || !problemId) return;
    if (isGhostId(problemId) || problemId.startsWith('local-')) return this.local.recordAttempt(problemId, sent);
    if (this._readOnly || !isSegment(problemId)) return;
    const pk = await this.playerKey();
    const uid = await this.uid();
    const ref = this.db.doc(`${ARTIFACT_COLLECTIONS.stats}/${problemId}/${ARTIFACT_COLLECTIONS.statPlayers}/${pk}`);
    try {
      let mine = this.ownStats.get(problemId);
      if (!mine) {
        const snap = await this.call('read own attempts', () => ref.get());
        mine = snap.exists ? readCounts(snapData(snap)) : { plays: 0, sends: 0 };
      }
      const next = { plays: mine.plays + 1, sends: mine.sends + (sent ? 1 : 0) };
      await this.call('record attempt', () => ref.set({ plays: next.plays, sends: next.sends, updatedAt: Date.now(), uid }), true);
      this.ownStats.set(problemId, next);
    } catch (err) {
      if (this.absorbWriteError(err)) return;
      throw err;
    }
    // Refresh the aggregate in the background; the player never waits on it.
    this.queueStatsRefresh(problemId);
  }

  /** Recompute `problem_stats/{id}` from the per-player docs (serialised per problem). */
  private queueStatsRefresh(problemId: string): void {
    const prev = this.statChains.get(problemId) ?? Promise.resolve();
    const next = prev
      .then(() => this.refreshStats(problemId))
      .catch((err: unknown) => {
        this.absorbWriteError(err);
      })
      .finally(() => {
        if (this.statChains.get(problemId) === next) this.statChains.delete(problemId);
      });
    this.statChains.set(problemId, next);
  }

  /** Resolves once pending background aggregate refreshes have settled (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.statChains.values()]);
  }

  private async refreshStats(problemId: string): Promise<void> {
    const players = await this.call('read attempts', () =>
      this.db.collection(`${ARTIFACT_COLLECTIONS.stats}/${problemId}/${ARTIFACT_COLLECTIONS.statPlayers}`).limit(STATS_SCAN).get(),
    );
    let plays = 0;
    let sends = 0;
    for (const d of players.docs) {
      const c = readCounts(snapData(d));
      plays += c.plays;
      sends += c.sends;
    }
    const aggRef = this.db.doc(`${ARTIFACT_COLLECTIONS.stats}/${problemId}`);
    const agg = await this.call('read aggregate', () => aggRef.get());
    const cur = agg.exists ? readCounts(snapData(agg), 1e9) : null;
    if (players.size >= STATS_SCAN && cur) {
      // Truncated scan: never move the aggregate backwards.
      plays = Math.max(plays, cur.plays);
      sends = Math.max(sends, cur.sends);
    }
    if (cur && cur.plays === plays && cur.sends === sends) return;
    await this.call('write aggregate', () => aggRef.set({ plays, sends, updatedAt: Date.now() }), true);
  }

  // ───────────────────────── plumbing ─────────────────────────

  private uid(): Promise<string | null> {
    if (!this.uidPromise) {
      const user = this.user;
      this.uidPromise = user
        ? withTimeout(Promise.resolve().then(() => user.id()), 1500, 'user.id')
            .then((v) => (typeof v === 'string' && v ? v : null))
            .catch(() => null)
        : Promise.resolve(null);
    }
    return this.uidPromise;
  }

  /** Path-safe key for this player: the platform user id when known, else a device id. */
  private playerKey(): Promise<string> {
    if (!this.keyPromise) {
      this.keyPromise = this.uid().then((uid) => {
        if (uid) return isSegment(uid) ? uid : `u${fnv1a(uid).toString(36)}${fnv1a(`${uid}#`).toString(36)}`;
        return deviceId(this.store);
      });
    }
    return this.keyPromise;
  }

  /**
   * Handle a failed write that should NOT bubble up: read-only viewers and full quotas.
   * Returns true when the caller should fall back to the local save.
   */
  private absorbWriteError(err: unknown): boolean {
    if (!(err instanceof BackendError)) return false;
    if (err.code === 'read_only') {
      this._readOnly = true;
      return true;
    }
    if (err.code === 'quota') {
      this._notice = 'The shared board is full — your run was saved on this device instead.';
      return true;
    }
    return false;
  }

  /** Run one db call with a timeout; retry once on `unavailable` (per the platform contract). */
  private async call<T>(what: string, fn: () => Promise<T>, write = false): Promise<T> {
    if (this._dead) throw new BackendError(`Artifact db is no longer available (${what})`, 'terminal', { retryable: false });
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTimeout(Promise.resolve().then(fn), this.timeoutMs, `Artifact db: ${what}`);
      } catch (err) {
        if (err instanceof BackendError) throw err;
        const code = dbErrorCode(err);
        const transient = code === 'unavailable' || (code !== '' && !KNOWN_CODES.has(code));
        if (transient && attempt === 0) {
          await sleep(200 + Math.random() * 400);
          continue;
        }
        throw this.mapError(err, code, what, write);
      }
    }
  }

  private mapError(err: unknown, code: string, what: string, write: boolean): BackendError {
    const msg = `Artifact db: ${what} failed${code ? ` (${code})` : ''}`;
    const detail = err instanceof Error ? err.message : typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : undefined;
    switch (code) {
      case 'invalid_argument':
      case 'transform_error':
        // Payloads are validated before every write, so a rejected write means "may not write here".
        return new BackendError(msg, write ? 'read_only' : 'invalid', { retryable: false, detail, cause: err });
      case 'quota_exceeded':
        return new BackendError(msg, 'quota', { retryable: false, detail, cause: err });
      case 'resource_exhausted':
        return new BackendError(msg, 'rate_limited', { retryable: true, detail, cause: err });
      case '':
        if (err instanceof TypeError) return new BackendError(msg, 'invalid', { retryable: false, detail, cause: err });
        return new BackendError(msg, 'unavailable', { retryable: true, detail, cause: err });
      default:
        if (LIFECYCLE_TERMINAL.has(code)) {
          this._dead = true;
          return new BackendError(msg, 'terminal', { retryable: false, detail, cause: err });
        }
        return new BackendError(msg, 'unavailable', { retryable: true, detail, cause: err });
    }
  }
}

const KNOWN_CODES = new Set([
  'invalid_argument',
  'resource_exhausted',
  'quota_exceeded',
  'unavailable',
  'revoked',
  'not_granted',
  'capability_disabled',
  'capability_removed',
  'transform_error',
]);

function snapData(d: DocumentSnapshot): Record<string, unknown> {
  try {
    return d.data() ?? {};
  } catch {
    return {};
  }
}

function readCounts(v: Record<string, unknown>, cap = MAX_PLAYS_PER_PLAYER): { plays: number; sends: number } {
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  const plays = Math.min(n(v.plays), cap);
  return { plays, sends: Math.min(n(v.sends), plays) };
}

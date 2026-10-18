// Backend selection + resilience.
//
// createBackend() picks, without ever throwing:
//   1. Supabase (GLOBAL)          — configured (src/config/backend.ts / VITE_ env) AND health check ≤ 2.5 s
//   2. Artifact db (CLAUDE SHARED) — inside a claude.ai Artifact: window.claude.use('db') ≤ 3 s, non-null
//   3. LocalBackend (OFFLINE)      — localStorage, ghost-seeded
// The Supabase and Artifact probes run in parallel, so the worst case is ~3 s, not the sum.
//
// A global backend is wrapped by withFallback(): if a call fails at runtime the game keeps
// working — scores are saved locally and queued in a persistent outbox, reads fall back to the
// local board (label/isGlobal then report OFFLINE), and the outbox flushes on the next successful
// call, when the browser comes back 'online', when the tab becomes visible, or on a backoff timer.

import type { BackendAPI } from '../core/contracts';
import type { CommunityProblem, LeaderboardMode, ScoreEntry } from '../core/types';
import { BACKEND_TIMEOUTS, isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/backend';
import { ArtifactBackend } from './artifact';
import { claudeRuntime, type ArtifactDB, type ArtifactUser } from './artifact-types';
import { BackendError, isRetryable, withTimeout } from './errors';
import { isGhostId } from './ghosts';
import { LocalBackend } from './local';
import { Outbox, type OutboxItem } from './outbox';
import { SupabaseBackend } from './supabase';
import { kv, uuid, type KVStore } from './storage';
import { normalizeOutgoingScore, type PublishInput } from './validate';

export { LocalBackend } from './local';
export { SupabaseBackend } from './supabase';
export { ArtifactBackend } from './artifact';
export { BackendError } from './errors';
export { isGhostId } from './ghosts';

export type BackendPreference = 'auto' | 'supabase' | 'artifact' | 'local';

export interface CreateBackendOptions {
  /**
   * Force a backend (QA). Defaults to the `?backend=` URL parameter, else 'auto'.
   * A forced backend that is unavailable still falls back to local.
   */
  prefer?: BackendPreference;
  store?: KVStore;
}

/** A global backend wrapped with local fallback + outbox. */
export interface FallbackBackend extends BackendAPI {
  readonly primary: BackendAPI;
  readonly local: LocalBackend;
  /** True while calls are being served from the local fallback. */
  readonly degraded: boolean;
  /** Writes waiting in the outbox for this backend. */
  readonly pending: number;
  /** Artifact viewers without write access (their writes stay on this device). */
  readonly readOnly: boolean;
  /** A message worth surfacing to the player, or null. */
  readonly notice: string | null;
  /** Try to deliver queued writes now. Resolves with how many were delivered. */
  flush(): Promise<number>;
  /** Remove listeners / timers. */
  dispose(): void;
}

export interface WithFallbackOptions {
  local?: LocalBackend;
  store?: KVStore;
  /** Outbox identity of the primary (defaults to its `target` property, else its kind). */
  target?: string;
  /** After a failure, reads skip the primary for this long (ms). Default 15 s. */
  cooldownMs?: number;
  now?: () => number;
}

const RETRY_DELAYS = [30_000, 60_000, 120_000, 300_000];

function isOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

class FallbackWrapper implements FallbackBackend {
  readonly primary: BackendAPI;
  readonly local: LocalBackend;
  private readonly outbox: Outbox;
  private readonly target: string;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private _degraded = false;
  private skipUntil = 0;
  private permanent = false;
  private flushing: Promise<number> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIndex = 0;
  private readonly unlisten: (() => void)[] = [];

  constructor(primary: BackendAPI, opts: WithFallbackOptions = {}) {
    this.primary = primary;
    this.local = opts.local ?? new LocalBackend({ store: opts.store });
    this.now = opts.now ?? Date.now;
    this.outbox = new Outbox({ store: opts.store ?? kv, now: this.now });
    const t = (primary as { target?: unknown }).target;
    this.target = opts.target ?? (typeof t === 'string' ? t : primary.kind);
    this.cooldownMs = opts.cooldownMs ?? 15_000;
    this.listen();
  }

  get kind(): BackendAPI['kind'] {
    return this.primary.kind;
  }
  get isGlobal(): boolean {
    return this._degraded ? false : this.primary.isGlobal;
  }
  get label(): string {
    return this._degraded ? this.local.label : this.primary.label;
  }
  get degraded(): boolean {
    return this._degraded;
  }
  get pending(): number {
    return this.outbox.forTarget(this.target).length;
  }
  get readOnly(): boolean {
    return (this.primary as { readOnly?: unknown }).readOnly === true;
  }
  get notice(): string | null {
    const n = (this.primary as { notice?: unknown }).notice;
    return typeof n === 'string' && n ? n : null;
  }

  // ───────────────────────── BackendAPI ─────────────────────────

  async submitScore(e: ScoreEntry): Promise<{ rank: number | null }> {
    // A stable id makes the delivery idempotent: a retry of a write that did land is a no-op.
    const entry: ScoreEntry = { ...e, id: e.id ?? uuid() };
    if (this.skipPrimary()) return this.saveScoreOffline(entry, true);
    try {
      const r = await this.primary.submitScore(entry);
      this.succeeded();
      return r;
    } catch (err) {
      if (err instanceof TypeError) {
        // Malformed entry (e.g. a daily score without its date): no backend can store it.
        console.warn('[net] score rejected:', err.message);
        return { rank: null };
      }
      this.failed(err);
      return this.saveScoreOffline(entry, isRetryable(err));
    }
  }

  async topScores(mode: LeaderboardMode, opts?: { limit?: number; dailyKey?: string }): Promise<ScoreEntry[]> {
    if (!this.skipPrimary()) {
      try {
        const r = await this.primary.topScores(mode, opts);
        this.succeeded();
        return r;
      } catch (err) {
        this.failed(err);
      }
    }
    return this.local.topScores(mode, opts);
  }

  async publishProblem(p: PublishInput): Promise<CommunityProblem> {
    const withId: PublishInput & { id: string } = { ...p, id: uuid() };
    if (this.skipPrimary()) return this.publishOffline(withId, true);
    try {
      const r = await this.primary.publishProblem(withId);
      this.succeeded();
      return r;
    } catch (err) {
      // Invalid problems must surface to the editor rather than silently going local.
      if (err instanceof TypeError || (err instanceof BackendError && err.code === 'invalid')) throw err;
      this.failed(err);
      return this.publishOffline(withId, isRetryable(err));
    }
  }

  async listProblems(opts?: { sort?: 'new' | 'popular'; limit?: number }): Promise<CommunityProblem[]> {
    if (!this.skipPrimary()) {
      try {
        const r = await this.primary.listProblems(opts);
        this.succeeded();
        return r;
      } catch (err) {
        this.failed(err);
      }
    }
    return this.local.listProblems(opts);
  }

  async recordAttempt(problemId: string, sent: boolean): Promise<void> {
    if (isGhostId(problemId) || problemId.startsWith('local-')) return this.local.recordAttempt(problemId, sent);
    if (this.skipPrimary()) {
      if (!this.permanent) this.enqueue({ kind: 'attempt', problemId, sent });
      return;
    }
    try {
      await this.primary.recordAttempt(problemId, sent);
      this.succeeded();
    } catch (err) {
      this.failed(err);
      if (isRetryable(err)) this.enqueue({ kind: 'attempt', problemId, sent });
    }
  }

  // ───────────────────────── outbox ─────────────────────────

  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    if (this.permanent || isOffline()) return Promise.resolve(0);
    const run = async (): Promise<number> => {
      let delivered = 0;
      for (;;) {
        const item = this.outbox.forTarget(this.target)[0];
        if (!item) break;
        try {
          await this.deliver(item);
          this.outbox.remove(item.id);
          delivered++;
          this.markHealthy();
        } catch (err) {
          if (isRetryable(err)) {
            this.outbox.bump(item.id);
            this.failed(err, false);
            break;
          }
          // Will never succeed (rejected payload, backend gone): drop it.
          this.outbox.remove(item.id);
          if (err instanceof BackendError && err.code === 'terminal') {
            this.failed(err, false);
            break;
          }
        }
      }
      return delivered;
    };
    this.flushing = run()
      .catch(() => 0)
      .finally(() => {
        this.flushing = null;
        if (this.pending > 0 && !this.permanent) this.scheduleRetry();
        else this.retryIndex = 0;
      });
    return this.flushing;
  }

  dispose(): void {
    for (const off of this.unlisten.splice(0)) off();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private deliver(item: OutboxItem): Promise<unknown> {
    switch (item.kind) {
      case 'score':
        return this.primary.submitScore(item.entry);
      case 'problem':
        return this.primary.publishProblem(item.problem);
      case 'attempt':
        return this.primary.recordAttempt(item.problemId, item.sent);
    }
  }

  private enqueue(payload: Parameters<Outbox['push']>[1]): void {
    try {
      this.outbox.push(this.target, payload);
      this.scheduleRetry();
    } catch {
      /* storage trouble: the local copy is all we can keep */
    }
  }

  private async saveScoreOffline(entry: ScoreEntry, queue: boolean): Promise<{ rank: null }> {
    try {
      await this.local.submitScore(entry);
    } catch {
      /* best effort */
    }
    if (queue && !this.permanent) {
      try {
        // Normalised (keeps the id for idempotent delivery); backends re-validate anyway.
        this.enqueue({ kind: 'score', entry: normalizeOutgoingScore(entry) });
      } catch {
        /* malformed entry cannot be queued */
      }
    }
    // A local rank would be misleading next to a global board.
    return { rank: null };
  }

  private async publishOffline(p: PublishInput & { id: string }, queue: boolean): Promise<CommunityProblem> {
    const local = await this.local.publishProblem(p);
    if (queue && !this.permanent) this.enqueue({ kind: 'problem', problem: p });
    return local;
  }

  // ───────────────────────── health ─────────────────────────

  private skipPrimary(): boolean {
    return this.permanent || isOffline() || this.now() < this.skipUntil;
  }

  private succeeded(): void {
    this.markHealthy();
    if (this.pending > 0) void this.flush();
  }

  private markHealthy(): void {
    this._degraded = false;
    this.skipUntil = 0;
    this.retryIndex = 0;
  }

  private failed(err: unknown, degrade = true): void {
    if (degrade) this._degraded = true;
    if (err instanceof BackendError && err.code === 'terminal') {
      this.permanent = true;
      this._degraded = true;
      return;
    }
    // Back off: transient trouble briefly, configuration-type errors for longer.
    this.skipUntil = this.now() + (isRetryable(err) ? this.cooldownMs : this.cooldownMs * 4);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.permanent) return;
    const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
    this.retryIndex++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.skipUntil = 0;
      void this.flush();
    }, delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private listen(): void {
    try {
      if (typeof addEventListener !== 'function') return;
      const onOnline = () => {
        this.skipUntil = 0;
        void this.flush();
      };
      addEventListener('online', onOnline);
      this.unlisten.push(() => removeEventListener('online', onOnline));
      if (typeof document !== 'undefined') {
        const onVisible = () => {
          if (document.visibilityState === 'visible' && this.pending > 0) void this.flush();
        };
        document.addEventListener('visibilitychange', onVisible);
        this.unlisten.push(() => document.removeEventListener('visibilitychange', onVisible));
      }
    } catch {
      /* non-browser environment */
    }
  }
}

/**
 * Wrap a global backend so runtime failures degrade to the local backend instead of breaking the
 * game: failed score submits are saved locally and queued (outbox in localStorage), reads fall
 * back to the local board, and the queue flushes on the next successful call or on 'online'.
 */
export function withFallback(primary: BackendAPI, opts: WithFallbackOptions = {}): FallbackBackend {
  return new FallbackWrapper(primary, opts);
}

// ───────────────────────────── selection ─────────────────────────────

function urlPreference(): BackendPreference | null {
  try {
    const g = globalThis as { location?: { search?: string }; navigator?: { webdriver?: boolean } };
    const v = g.location?.search ? new URLSearchParams(g.location.search).get('backend') : null;
    if (v === 'supabase' || v === 'artifact' || v === 'local' || v === 'auto') return v;
    // Automated browsers (Playwright/Selenium QA runs) never write to the real global boards
    // unless a test opts in explicitly with ?backend=supabase.
    if (g.navigator?.webdriver) return 'local';
    return null;
  } catch {
    return null;
  }
}

async function trySupabase(): Promise<SupabaseBackend | null> {
  if (!isSupabaseConfigured()) return null;
  const backend = new SupabaseBackend(SUPABASE_URL, SUPABASE_ANON_KEY);
  return (await backend.health(BACKEND_TIMEOUTS.health)) ? backend : null;
}

async function tryArtifact(local: LocalBackend, store: KVStore): Promise<ArtifactBackend | null> {
  const rt = claudeRuntime();
  if (!rt) return null;
  const db = await withTimeout(Promise.resolve().then(() => rt.use('db')), BACKEND_TIMEOUTS.artifactUse, "claude.use('db')").catch(() => null);
  if (!db || typeof (db as ArtifactDB).collection !== 'function') return null;
  const user = await withTimeout(Promise.resolve().then(() => rt.use('user')), 1500, "claude.use('user')").catch(() => null);
  const backend = await ArtifactBackend.create(db as ArtifactDB, (user as ArtifactUser | null) ?? null, { local, store });
  try {
    await withTimeout(backend.probe(), 2500, 'Artifact db probe');
  } catch (err) {
    // Not granted / revoked / disabled: unusable. A slow or transient probe is left to withFallback.
    if (err instanceof BackendError && (err.code === 'terminal' || err.code === 'invalid')) return null;
  }
  return backend;
}

/**
 * Pick the best available backend. Never throws and never takes much longer than ~3 s; on any
 * failure it resolves the OFFLINE LocalBackend. Global backends come wrapped in withFallback().
 */
export async function createBackend(opts: CreateBackendOptions = {}): Promise<BackendAPI> {
  const store = opts.store ?? kv;
  const local = new LocalBackend({ store });
  try {
    const prefer = opts.prefer ?? urlPreference() ?? 'auto';
    if (prefer === 'local') return local;
    const supabaseP = prefer === 'auto' || prefer === 'supabase' ? trySupabase().catch(() => null) : Promise.resolve(null);
    const artifactP = prefer === 'auto' || prefer === 'artifact' ? tryArtifact(local, store).catch(() => null) : Promise.resolve(null);

    const supabase = await supabaseP;
    if (supabase) {
      const wrapped = withFallback(supabase, { local, store, target: supabase.target });
      void wrapped.flush();
      return wrapped;
    }
    const artifact = await artifactP;
    if (artifact) {
      const wrapped = withFallback(artifact, { local, store, target: 'artifact' });
      void wrapped.flush();
      return wrapped;
    }
  } catch {
    /* fall through to local */
  }
  return local;
}

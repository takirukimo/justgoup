import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendAPI } from '../core/contracts';
import type { BoulderDef, CommunityProblem, LeaderboardMode, ScoreEntry } from '../core/types';
import { createBackend, withFallback, type FallbackBackend } from './backend';
import { ArtifactBackend } from './artifact';
import type { ArtifactDB, ArtifactUser, CollectionReference, DocumentReference, DocumentSnapshot, Query } from './artifact-types';
import { BackendError } from './errors';
import { ghostProblems } from './ghosts';
import { LocalBackend } from './local';
import { OUTBOX_KEY } from './outbox';
import { resetMemoryStore } from './storage';
import { SupabaseBackend } from './supabase';

// The shipped config points at the real CHIRAL Supabase project. Tests must never reach it:
// treat Supabase as unconfigured unless a test passes its own URL/key + fake fetch.
vi.mock('../config/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/backend')>();
  return {
    ...actual,
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    isSupabaseConfigured: (url = '', key = '') => actual.isSupabaseConfigured(url, key),
  };
});

// ───────────────────────────── shims + fakes ─────────────────────────────

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

type Body = Record<string, unknown>;

/** In-memory stand-in for the Artifact `db` namespace (subset used by ArtifactBackend). */
class FakeDb implements ArtifactDB {
  readonly docs = new Map<string, Body>();
  /** Reject the next N writes / reads with this code. */
  failWrites: { code: string; times: number } | null = null;
  failReads: { code: string; times: number } | null = null;
  writes = 0;
  private seq = 0;

  private check(kind: 'read' | 'write'): void {
    const f = kind === 'read' ? this.failReads : this.failWrites;
    if (f && f.times > 0) {
      f.times--;
      throw { code: f.code, message: `fake ${kind} failure` };
    }
    if (kind === 'write') this.writes++;
  }

  doc(path: string): DocumentReference {
    if (path.split('/').length % 2 !== 0) throw new TypeError(`document path needs an even segment count: ${path}`);
    return this.ref(path);
  }

  collection(path: string): CollectionReference {
    if (path.split('/').length % 2 !== 1) throw new TypeError(`collection path needs an odd segment count: ${path}`);
    return this.col(path, [], null, 1000);
  }

  private ref(path: string): DocumentReference {
    const db = this;
    const id = path.split('/').pop()!;
    return {
      id,
      path,
      async get() {
        db.check('read');
        return snap(id, db.docs.get(path));
      },
      async set(data) {
        db.check('write');
        db.docs.set(path, JSON.parse(JSON.stringify(data)) as Body);
      },
      async update(data) {
        db.check('write');
        const cur = db.docs.get(path);
        if (!cur) throw { code: 'invalid_argument', message: 'update of a missing document' };
        db.docs.set(path, { ...cur, ...(JSON.parse(JSON.stringify(data)) as Body) });
      },
      async delete() {
        db.check('write');
        db.docs.delete(path);
      },
      collection(sub: string) {
        return db.collection(`${path}/${sub}`);
      },
    };
  }

  private col(path: string, filters: [string, string, unknown][], order: [string, 'asc' | 'desc'] | null, lim: number): CollectionReference {
    const db = this;
    const q: CollectionReference = {
      path,
      where: (f: string, op: string, v: unknown): Query => db.col(path, [...filters, [f, op, v]], order, lim),
      orderBy: (f: string, dir: 'asc' | 'desc' = 'asc'): Query => db.col(path, filters, [f, dir], lim),
      limit: (n: number): Query => db.col(path, filters, order, n),
      async get() {
        db.check('read');
        let rows = [...db.docs.entries()].filter(([p]) => p.slice(0, p.lastIndexOf('/')) === path);
        for (const [f, op, v] of filters) {
          if (op !== '==') throw new Error(`fake db supports == only (${op})`);
          rows = rows.filter(([, d]) => d[f] === v);
        }
        rows.sort(([pa, a], [pb, b]) => {
          if (order) {
            const [f, dir] = order;
            const x = a[f] as number;
            const y = b[f] as number;
            if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
          }
          return pa < pb ? -1 : 1;
        });
        const docs = rows.slice(0, lim).map(([p, d]) => snap(p.split('/').pop()!, d));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      doc: (id?: string) => db.ref(`${path}/${id ?? `auto${(++db.seq).toString().padStart(6, '0')}`}`),
      async add(data) {
        const r = q.doc();
        await r.set(data);
        return r;
      },
    };
    return q;
  }
}

function snap(id: string, d: Body | undefined): DocumentSnapshot {
  return { id, exists: d !== undefined, data: () => (d ? (JSON.parse(JSON.stringify(d)) as Body) : undefined) };
}

const fakeUser = (id: string | null, canWrite: boolean | null = null): ArtifactUser => ({
  id: async () => id,
  can: async () => canWrite,
});

/** Scriptable primary backend for withFallback tests. */
class FlakyBackend implements BackendAPI {
  readonly kind = 'supabase' as const;
  readonly isGlobal = true;
  readonly label = 'GLOBAL';
  readonly target = 'supabase:test';
  state: 'up' | 'down' | 'invalid' = 'up';
  calls = 0;
  scores: ScoreEntry[] = [];
  problems: (Parameters<BackendAPI['publishProblem']>[0] & { id?: string })[] = [];
  attempts: [string, boolean][] = [];

  private gate(): void {
    this.calls++;
    if (this.state === 'down') throw new BackendError('down', 'network');
    if (this.state === 'invalid') throw new BackendError('rejected', 'invalid', { retryable: false });
  }
  async submitScore(e: ScoreEntry) {
    this.gate();
    this.scores.push(e);
    return { rank: 7 };
  }
  async topScores(_mode: LeaderboardMode) {
    this.gate();
    return this.scores.slice();
  }
  async publishProblem(p: Parameters<BackendAPI['publishProblem']>[0]): Promise<CommunityProblem> {
    this.gate();
    this.problems.push(p);
    return { id: 'remote-1', name: p.name, author: p.author, grade: p.grade, boulder: p.boulder, plays: 0, sends: 0, createdAt: 1 };
  }
  async listProblems() {
    this.gate();
    return [];
  }
  async recordAttempt(id: string, sent: boolean) {
    this.gate();
    this.attempts.push([id, sent]);
  }
}

const run = (player: string, score: number, extra: Partial<ScoreEntry> = {}): ScoreEntry => ({
  player,
  score,
  mode: 'boulder',
  sends: 2,
  maxGrade: 3,
  head: 'lynx',
  ...extra,
});

function testBoulder(): BoulderDef {
  const h = (id: string, x: number, y: number, role: 'start' | 'hand' | 'foot' | 'top') => ({
    id,
    x,
    y,
    type: role === 'foot' ? ('foot' as const) : ('jug' as const),
    size: 0.08,
    angle: -Math.PI / 2,
    role,
    color: '#8B5CF6',
    seed: 1,
  });
  return {
    id: 'draft',
    name: 'Draft',
    grade: 3,
    mode: 'boulder',
    wallAngle: 20,
    width: 4.6,
    height: 4.5,
    color: '#8B5CF6',
    seed: 5,
    holds: [h('s', 0, 1.7, 'start'), h('f', 0, 0.5, 'foot'), h('m', 0.2, 2.5, 'hand'), h('t', 0, 4, 'top')],
  };
}

let storage: MemoryStorage;
const wrappers: FallbackBackend[] = [];

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  resetMemoryStore();
});

afterEach(() => {
  for (const w of wrappers.splice(0)) w.dispose();
  delete (globalThis as { localStorage?: Storage }).localStorage;
  delete (globalThis as { claude?: unknown }).claude;
  vi.useRealTimers();
});

function wrap(primary: BackendAPI, clock: { t: number }): FallbackBackend {
  const w = withFallback(primary, { now: () => clock.t, cooldownMs: 1000 });
  wrappers.push(w);
  return w;
}

// ───────────────────────────── withFallback ─────────────────────────────

describe('withFallback', () => {
  it('passes through while the primary is healthy', async () => {
    const p = new FlakyBackend();
    const w = wrap(p, { t: 0 });
    expect(await w.submitScore(run('Livio', 100))).toEqual({ rank: 7 });
    expect(w.label).toBe('GLOBAL');
    expect(w.isGlobal).toBe(true);
    expect(w.kind).toBe('supabase');
    expect(p.scores[0].id).toMatch(/^[0-9a-f-]{36}$/); // stable id for idempotent retries
  });

  it('saves locally + queues when the primary is down, then flushes on recovery', async () => {
    const clock = { t: 0 };
    const p = new FlakyBackend();
    const w = wrap(p, clock);
    p.state = 'down';
    expect(await w.submitScore(run('Livio', 4321))).toEqual({ rank: null });
    expect(w.degraded).toBe(true);
    expect(w.label).toBe('OFFLINE');
    expect(w.isGlobal).toBe(false);
    expect(w.pending).toBe(1);
    // The local board has the run.
    expect((await w.local.topScores('boulder')).some((e) => e.player === 'Livio' && e.score === 4321)).toBe(true);

    // During the cooldown, reads come from local without hitting the primary.
    const before = p.calls;
    const board = await w.topScores('boulder');
    expect(p.calls).toBe(before);
    expect(board.some((e) => e.player === 'Livio')).toBe(true);

    // Primary recovers; after the cooldown the next call succeeds and flushes the outbox.
    p.state = 'up';
    clock.t += 5000;
    await w.topScores('boulder');
    await w.flush();
    expect(w.pending).toBe(0);
    expect(w.label).toBe('GLOBAL');
    expect(p.scores).toHaveLength(1);
    expect(p.scores[0]).toMatchObject({ player: 'Livio', score: 4321 });
    expect(storage.getItem(OUTBOX_KEY)).toBe('[]');
  });

  it('keeps the outbox across sessions', async () => {
    const p = new FlakyBackend();
    p.state = 'down';
    const w1 = wrap(p, { t: 0 });
    await w1.submitScore(run('Livio', 10));
    await w1.recordAttempt('8f8f8f8f-1111-4111-8111-111111111111', true);
    expect(w1.pending).toBe(2);
    p.state = 'up';
    const w2 = wrap(p, { t: 0 });
    expect(w2.pending).toBe(2);
    expect(await w2.flush()).toBe(2);
    expect(p.scores).toHaveLength(1);
    expect(p.attempts).toEqual([['8f8f8f8f-1111-4111-8111-111111111111', true]]);
  });

  it('does not queue writes the server rejected as invalid', async () => {
    const p = new FlakyBackend();
    p.state = 'invalid';
    const w = wrap(p, { t: 0 });
    expect(await w.submitScore(run('Livio', 5))).toEqual({ rank: null });
    expect(w.pending).toBe(0);
    expect((await w.local.topScores('boulder')).some((e) => e.player === 'Livio')).toBe(true);
  });

  it('routes ghost / local problem attempts to the local backend', async () => {
    const p = new FlakyBackend();
    const w = wrap(p, { t: 0 });
    const ghost = ghostProblems()[0];
    await w.recordAttempt(ghost.id, true);
    expect(p.attempts).toEqual([]);
    const g = (await w.local.listProblems({ limit: 50 })).find((q) => q.id === ghost.id)!;
    expect(g.plays).toBe(ghost.plays + 1);
  });

  it('publishes locally and queues when down; surfaces invalid problems', async () => {
    const p = new FlakyBackend();
    const w = wrap(p, { t: 0 });
    p.state = 'down';
    const local = await w.publishProblem({ name: 'Queued Line', author: 'Livio', grade: 3, boulder: testBoulder() });
    expect(local.id.startsWith('local-p-')).toBe(true);
    expect(w.pending).toBe(1);
    p.state = 'up';
    await w.flush();
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0].id).toMatch(/^[0-9a-f-]{36}$/);

    p.state = 'invalid';
    await expect(w.publishProblem({ name: 'Bad', author: 'Livio', grade: 3, boulder: testBoulder() })).rejects.toThrow(BackendError);
  });
});

// ───────────────────────────── ArtifactBackend ─────────────────────────────

describe('ArtifactBackend', () => {
  it('keeps one best-run document per player per board and ranks against the shared board', async () => {
    const db = new FakeDb();
    const alice = await ArtifactBackend.create(db, fakeUser('u_alice'));
    const bob = await ArtifactBackend.create(db, fakeUser('u_bob'));
    expect(alice.label).toBe('CLAUDE SHARED');
    expect(alice.isGlobal).toBe(true);

    expect(await alice.submitScore(run('Alice', 500))).toEqual({ rank: 1 });
    expect(await bob.submitScore(run('Bob', 800))).toEqual({ rank: 1 });
    expect(await alice.submitScore(run('Alice', 300))).toEqual({ rank: 2 }); // not a new best
    expect(await alice.submitScore(run('Alice', 900))).toEqual({ rank: 1 });

    const board = await bob.topScores('boulder');
    expect(board.map((e) => [e.player, e.score])).toEqual([
      ['Alice', 900],
      ['Bob', 800],
    ]);
    expect([...db.docs.keys()].filter((k) => k.startsWith('scores/'))).toHaveLength(2);
    expect(db.docs.get('scores/boulder~u_alice')).toMatchObject({ board: 'boulder', uid: 'u_alice', maxGrade: 3, head: 'lynx' });
    expect(await alice.topScores('rope')).toEqual([]);
  });

  it('keys daily boards by date', async () => {
    const db = new FakeDb();
    const a = await ArtifactBackend.create(db, fakeUser('u_a'));
    await a.submitScore(run('Alice', 50, { mode: 'daily', dailyKey: '2026-10-17' }));
    expect(await a.topScores('daily', { dailyKey: '2026-10-17' })).toHaveLength(1);
    expect(await a.topScores('daily', { dailyKey: '2026-10-16' })).toHaveLength(0);
  });

  it('publishes, lists and aggregates attempts from per-player docs', async () => {
    const db = new FakeDb();
    const a = await ArtifactBackend.create(db, fakeUser('u_a'));
    const b = await ArtifactBackend.create(db, fakeUser('u_b'));
    const p1 = await a.publishProblem({ name: 'First', author: 'Alice', grade: 2, boulder: testBoulder() });
    const p2 = await a.publishProblem({ name: 'Second', author: 'Alice', grade: 5, boulder: testBoulder() });
    expect(p1.boulder.id).toBe(p1.id);

    await a.recordAttempt(p1.id, false);
    await a.recordAttempt(p1.id, true);
    await b.recordAttempt(p1.id, true);
    await a.settle();
    await b.settle();
    expect(db.docs.get(`problem_stats/${p1.id}/players/u_a`)).toMatchObject({ plays: 2, sends: 1 });
    expect(db.docs.get(`problem_stats/${p1.id}`)).toMatchObject({ plays: 3, sends: 2 });

    const popular = await b.listProblems({ sort: 'popular' });
    expect(popular.map((p) => p.id)).toEqual([p1.id, p2.id]);
    expect(popular[0]).toMatchObject({ plays: 3, sends: 2, author: 'Alice', name: 'First' });
    const fresh = await b.listProblems({ sort: 'new' });
    expect(fresh.map((p) => p.name)).toContain('Second');
  });

  it('drops malformed shared documents', async () => {
    const db = new FakeDb();
    db.docs.set('scores/x', { board: 'boulder', player: 'Evil<script>', score: 'lots', mode: 'boulder' });
    db.docs.set('scores/y', { board: 'boulder', player: 'Fine Name', score: 42, mode: 'boulder', head: 'goat', sends: 1, maxGrade: 1 });
    db.docs.set('problems/z', { name: 'Broken', author: 'Bob', grade: 1, boulder: { holds: 'nope' }, createdAt: 5 });
    const a = await ArtifactBackend.create(db, fakeUser('u_a'));
    expect((await a.topScores('boulder')).map((e) => e.player)).toEqual(['Fine Name']);
    expect(await a.listProblems()).toEqual([]);
  });

  it('goes read-only when user.can("data.write") is false', async () => {
    const db = new FakeDb();
    const local = new LocalBackend({ ghosts: false });
    const v = await ArtifactBackend.create(db, fakeUser('u_viewer', false), { local });
    expect(v.readOnly).toBe(true);
    expect(await v.submitScore(run('Viewer', 99))).toEqual({ rank: null });
    expect(db.writes).toBe(0);
    expect((await local.topScores('boulder')).map((e) => e.player)).toEqual(['Viewer']);
  });

  it('goes read-only when a write rejects invalid_argument, still reading shared data', async () => {
    const db = new FakeDb();
    const owner = await ArtifactBackend.create(db, fakeUser('u_owner'));
    await owner.submitScore(run('Owner', 700));
    const local = new LocalBackend({ ghosts: false });
    const viewer = await ArtifactBackend.create(db, fakeUser('u_viewer'), { local });
    db.failWrites = { code: 'invalid_argument', times: 99 };
    expect(await viewer.submitScore(run('Viewer', 900))).toEqual({ rank: null });
    expect(viewer.readOnly).toBe(true);
    expect((await viewer.topScores('boulder')).map((e) => e.player)).toEqual(['Owner']);
    expect((await local.topScores('boulder')).map((e) => e.player)).toEqual(['Viewer']);
    // Publishing also lands locally and stays visible to the viewer.
    const p = await viewer.publishProblem({ name: 'Mine', author: 'Viewer', grade: 1, boulder: testBoulder() });
    expect(p.id.startsWith('local-p-')).toBe(true);
    expect((await viewer.listProblems()).map((q) => q.id)).toContain(p.id);
  });

  it('surfaces quota_exceeded as a notice and saves locally', async () => {
    const db = new FakeDb();
    const local = new LocalBackend({ ghosts: false });
    const a = await ArtifactBackend.create(db, fakeUser('u_a'), { local });
    db.failWrites = { code: 'quota_exceeded', times: 1 };
    expect(await a.submitScore(run('Alice', 10))).toEqual({ rank: null });
    expect(a.notice).toMatch(/full/);
    expect(a.readOnly).toBe(false);
    expect(await local.topScores('boulder')).toHaveLength(1);
  });

  it('retries once on unavailable, and maps revoked to a terminal error', async () => {
    const db = new FakeDb();
    const a = await ArtifactBackend.create(db, fakeUser('u_a'));
    db.failReads = { code: 'unavailable', times: 1 };
    expect(await a.topScores('boulder')).toEqual([]);
    db.failReads = { code: 'revoked', times: 1 };
    await expect(a.topScores('boulder')).rejects.toMatchObject({ code: 'terminal', retryable: false });
    // Dead for the rest of the page load.
    await expect(a.topScores('boulder')).rejects.toMatchObject({ code: 'terminal' });
  });

  it('falls back to a device id when the platform gives no user id', async () => {
    const db = new FakeDb();
    const a = await ArtifactBackend.create(db, null);
    await a.submitScore(run('Anon', 1));
    const key = [...db.docs.keys()].find((k) => k.startsWith('scores/'))!;
    expect(key).toMatch(/^scores\/boulder~d[a-z0-9]{15}$/);
    expect(db.docs.get(key)!.uid).toBeNull();
  });
});

// ───────────────────────────── createBackend ─────────────────────────────

describe('createBackend', () => {
  it('falls back to the OFFLINE local backend with no Supabase config and no Artifact runtime', async () => {
    const b = await createBackend();
    expect(b.kind).toBe('local');
    expect(b.label).toBe('OFFLINE');
    expect(b.isGlobal).toBe(false);
  });

  it('uses the Artifact db when window.claude.use("db") resolves', async () => {
    const db = new FakeDb();
    (globalThis as { claude?: unknown }).claude = { use: async (n: string) => (n === 'db' ? db : n === 'user' ? fakeUser('u_me') : null) };
    const b = await createBackend();
    wrappers.push(b as FallbackBackend);
    expect(b.kind).toBe('artifact');
    expect(b.label).toBe('CLAUDE SHARED');
    expect(b.isGlobal).toBe(true);
    await b.submitScore(run('Me', 77));
    expect(db.docs.get('scores/boulder~u_me')).toMatchObject({ score: 77 });
  });

  it('uses local when the db capability is null or not granted', async () => {
    (globalThis as { claude?: unknown }).claude = { use: async () => null };
    expect((await createBackend()).kind).toBe('local');
    const db = new FakeDb();
    db.failReads = { code: 'not_granted', times: 5 };
    (globalThis as { claude?: unknown }).claude = { use: async (n: string) => (n === 'db' ? db : null) };
    expect((await createBackend()).kind).toBe('local');
  });

  it('gives up on a hanging claude.use after ~3 s', async () => {
    vi.useFakeTimers();
    (globalThis as { claude?: unknown }).claude = { use: () => new Promise(() => {}) };
    const pending = createBackend();
    await vi.advanceTimersByTimeAsync(3100);
    expect((await pending).kind).toBe('local');
  });

  it('honours prefer: "local"', async () => {
    (globalThis as { claude?: unknown }).claude = { use: async () => new FakeDb() };
    expect((await createBackend({ prefer: 'local' })).kind).toBe('local');
  });
});

// ───────────────────────────── SupabaseBackend ─────────────────────────────

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (req: Captured) => { status?: number; body?: unknown } | Promise<never>) {
  const calls: Captured[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const r = handler(req);
    if (r instanceof Promise) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const text = r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const URL_ = 'https://demo.supabase.co';
const KEY = 'sb_publishable_test';

describe('SupabaseBackend', () => {
  it('health-checks the scores table', async () => {
    const ok = mockFetch(() => ({ body: [] }));
    expect(await new SupabaseBackend(URL_, KEY, { fetch: ok.fn }).health()).toBe(true);
    expect(ok.calls[0].url).toBe(`${URL_}/rest/v1/scores?select=id&limit=1`);
    const missing = mockFetch(() => ({ status: 404, body: { code: 'PGRST205', message: 'no table' } }));
    expect(await new SupabaseBackend(URL_, KEY, { fetch: missing.fn }).health()).toBe(false);
    const broken = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(await new SupabaseBackend(URL_, KEY, { fetch: broken }).health()).toBe(false);
  });

  it('inserts snake_case rows with auth headers, then asks score_rank', async () => {
    const m = mockFetch((req) => (req.url.endsWith('/rpc/score_rank') ? { body: 3 } : { status: 201 }));
    const b = new SupabaseBackend(URL_, KEY, { fetch: m.fn });
    expect(await b.submitScore(run('  Mira K. ', 1234))).toEqual({ rank: 3 });
    const [insert, rank] = m.calls;
    expect(insert.method).toBe('POST');
    expect(insert.url).toBe(`${URL_}/rest/v1/scores`);
    expect(insert.headers.apikey).toBe(KEY);
    expect(insert.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(insert.headers.Prefer).toBe('return=minimal');
    expect(insert.body).toMatchObject({ player: 'Mira K.', mode: 'boulder', score: 1234, sends: 2, max_grade: 3, head: 'lynx', daily_key: null });
    expect((insert.body as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rank.body).toEqual({ p_mode: 'boulder', p_score: 1234, p_daily_key: null });
  });

  it('treats a duplicate id (retried insert) as success', async () => {
    const m = mockFetch((req) =>
      req.url.endsWith('/rpc/score_rank') ? { body: 1 } : { status: 409, body: { code: '23505', message: 'duplicate key value' } },
    );
    const b = new SupabaseBackend(URL_, KEY, { fetch: m.fn });
    expect(await b.submitScore(run('Mira K.', 5, { id: '0f0f0f0f-aaaa-4bbb-8ccc-123456789abc' }))).toEqual({ rank: 1 });
    expect((m.calls[0].body as { id: string }).id).toBe('0f0f0f0f-aaaa-4bbb-8ccc-123456789abc');
  });

  it('queries leaderboards and maps rows to camelCase', async () => {
    const rows = [
      { id: 'a', player: 'Föhn', mode: 'daily', score: 900, sends: 1, max_grade: 0, head: 'eagle', daily_key: '2026-10-17', created_at: '2026-10-17T08:00:00Z' },
      { id: 'b', player: '!', mode: 'daily', score: 800, sends: 1, max_grade: 0, head: 'eagle', daily_key: '2026-10-17', created_at: '2026-10-17T08:00:00Z' },
    ];
    const m = mockFetch(() => ({ body: rows }));
    const b = new SupabaseBackend(URL_, KEY, { fetch: m.fn });
    const got = await b.topScores('daily', { dailyKey: '2026-10-17', limit: 10 });
    const u = new URL(m.calls[0].url);
    expect(u.pathname).toBe('/rest/v1/scores');
    expect(u.searchParams.get('mode')).toBe('eq.daily');
    expect(u.searchParams.get('daily_key')).toBe('eq.2026-10-17');
    expect(u.searchParams.get('order')).toBe('score.desc,created_at.asc');
    expect(u.searchParams.get('limit')).toBe('10');
    // Unusable rows (here: a name with nothing valid left) are dropped.
    expect(got).toEqual([
      { id: 'a', player: 'Föhn', mode: 'daily', score: 900, sends: 1, maxGrade: 0, head: 'eagle', dailyKey: '2026-10-17', createdAt: Date.parse('2026-10-17T08:00:00Z') },
    ]);

    await b.topScores('boulder');
    const u2 = new URL(m.calls[1].url);
    expect(u2.searchParams.get('daily_key')).toBe('is.null');
    expect(u2.searchParams.get('limit')).toBe('50');
  });

  it('publishes into data jsonb and lists problems by popularity', async () => {
    const id = '12345678-1234-4234-8234-123456789abc';
    const row = (over: Record<string, unknown> = {}) => ({
      id,
      name: 'Föhnsturm',
      author: 'Steini',
      grade: 4,
      wall_angle: 20,
      data: testBoulder(),
      plays: 12,
      sends: 3,
      created_at: '2026-10-01T10:00:00Z',
      ...over,
    });
    const m = mockFetch((req) => (req.method === 'POST' ? { status: 201, body: [row({ plays: 0, sends: 0 })] } : { body: [row()] }));
    const b = new SupabaseBackend(URL_, KEY, { fetch: m.fn });
    const p = await b.publishProblem({ name: 'Föhnsturm', author: 'Steini', grade: 4, boulder: testBoulder() });
    expect(m.calls[0].headers.Prefer).toBe('return=representation');
    expect(m.calls[0].body).toMatchObject({ name: 'Föhnsturm', author: 'Steini', grade: 4, wall_angle: 20 });
    expect((m.calls[0].body as { data: BoulderDef }).data.holds).toHaveLength(4);
    expect(p).toMatchObject({ id, name: 'Föhnsturm', author: 'Steini', plays: 0 });
    expect(p.boulder.id).toBe(id);

    const list = await b.listProblems({ sort: 'popular', limit: 5 });
    const u = new URL(m.calls[1].url);
    expect(u.searchParams.get('order')).toBe('plays.desc,created_at.desc');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(list[0]).toMatchObject({ id, plays: 12, sends: 3, createdAt: Date.parse('2026-10-01T10:00:00Z') });
  });

  it('records attempts through the RPC (uuids only)', async () => {
    const m = mockFetch(() => ({ status: 204 }));
    const b = new SupabaseBackend(URL_, KEY, { fetch: m.fn });
    await b.recordAttempt('12345678-1234-4234-8234-123456789abc', true);
    expect(m.calls[0].url).toBe(`${URL_}/rest/v1/rpc/record_attempt`);
    expect(m.calls[0].body).toEqual({ p_problem_id: '12345678-1234-4234-8234-123456789abc', p_sent: true });
    await b.recordAttempt('ghost-p-warm-up', true);
    expect(m.calls).toHaveLength(1);
  });

  it('maps errors: 429 retryable, constraint violation not, timeout retryable', async () => {
    const limited = new SupabaseBackend(URL_, KEY, { fetch: mockFetch(() => ({ status: 429, body: { code: 'PT429', message: 'rate limit' } })).fn });
    await expect(limited.topScores('boulder')).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    const bad = new SupabaseBackend(URL_, KEY, { fetch: mockFetch(() => ({ status: 400, body: { code: '23514', message: 'violates check constraint' } })).fn });
    await expect(bad.listProblems()).rejects.toMatchObject({ code: 'invalid', retryable: false });
    const slow = new SupabaseBackend(URL_, KEY, { fetch: mockFetch(() => new Promise<never>(() => {})).fn, timeoutMs: 30 });
    await expect(slow.topScores('rope')).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});

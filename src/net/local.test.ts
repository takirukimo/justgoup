import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoulderDef, ScoreEntry } from '../core/types';
import { LocalBackend, LOCAL_KEYS, utcDayKey } from './local';
import { ghostProblems, ghostScores, isGhostId } from './ghosts';
import { resetMemoryStore } from './storage';
import { parseBoulder } from './validate';

/** In-memory Storage shim (vitest runs in node, which has no localStorage). */
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

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  resetMemoryStore();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

const run = (player: string, score: number, extra: Partial<ScoreEntry> = {}): ScoreEntry => ({
  player,
  score,
  mode: 'boulder',
  sends: 3,
  maxGrade: 2,
  head: 'ibex',
  ...extra,
});

function testBoulder(over: Partial<BoulderDef> = {}): BoulderDef {
  return {
    id: 'editor-draft-1',
    name: 'Draft',
    grade: 3,
    mode: 'boulder',
    wallAngle: 15,
    width: 4.6,
    height: 4.5,
    color: '#2FB36D',
    seed: 99,
    holds: [
      { id: 's1', x: -0.2, y: 1.7, type: 'jug', size: 0.1, angle: -Math.PI / 2, role: 'start', color: '#2FB36D', seed: 1 },
      { id: 'f1', x: 0.1, y: 0.5, type: 'foot', size: 0.03, angle: -Math.PI / 2, role: 'foot', color: '#2FB36D', seed: 2 },
      { id: 'h1', x: 0.2, y: 2.3, type: 'edge', size: 0.07, angle: -Math.PI / 2, role: 'hand', color: '#2FB36D', seed: 3 },
      { id: 't1', x: 0.0, y: 4.0, type: 'jug', size: 0.11, angle: -Math.PI / 2, role: 'top', color: '#2FB36D', seed: 4 },
    ],
    ...over,
  };
}

describe('LocalBackend basics', () => {
  it('identifies as the offline backend', () => {
    const b = new LocalBackend();
    expect(b.kind).toBe('local');
    expect(b.isGlobal).toBe(false);
    expect(b.label).toBe('OFFLINE');
  });
});

describe('leaderboards', () => {
  it('shows ghost entries on a fresh device, best first, clearly marked', async () => {
    const b = new LocalBackend();
    const board = await b.topScores('boulder');
    expect(board.length).toBeGreaterThanOrEqual(5);
    expect(board.every((e) => isGhostId(e.id) && e.id!.startsWith('ghost-'))).toBe(true);
    expect(board[0].player).toBe('Steini');
    for (let i = 1; i < board.length; i++) expect(board[i - 1].score).toBeGreaterThanOrEqual(board[i].score);
    const names = board.map((e) => e.player);
    for (const n of ['Steini', 'Crimpmeister', 'Föhn', 'Mira K.', 'Basalt Bob']) expect(names).toContain(n);
  });

  it('ranks a submitted score against ghosts and orders the board', async () => {
    const b = new LocalBackend();
    const ghosts = ghostScores('boulder').sort((x, y) => y.score - x.score);
    const between = Math.floor((ghosts[1].score + ghosts[2].score) / 2);
    expect(await b.submitScore(run('Livio', between))).toEqual({ rank: 3 });
    expect(await b.submitScore(run('Livio', 1_000_000))).toEqual({ rank: 1 });
    expect(await b.submitScore(run('Livio', 0))).toEqual({ rank: ghosts.length + 3 });

    const board = await b.topScores('boulder', { limit: 100 });
    expect(board[0]).toMatchObject({ player: 'Livio', score: 1_000_000 });
    expect(board[3]).toMatchObject({ player: 'Livio', score: between });
    expect(board[board.length - 1]).toMatchObject({ player: 'Livio', score: 0 });
    for (let i = 1; i < board.length; i++) expect(board[i - 1].score).toBeGreaterThanOrEqual(board[i].score);
    const mine = board.filter((e) => !isGhostId(e.id));
    expect(mine).toHaveLength(3);
    expect(mine.every((e) => typeof e.id === 'string' && typeof e.createdAt === 'number')).toBe(true);
  });

  it('gives tied scores the same (better) rank', async () => {
    const b = new LocalBackend({ ghosts: false });
    await b.submitScore(run('Alpha', 500));
    expect(await b.submitScore(run('Bravo', 500))).toEqual({ rank: 1 });
    expect(await b.submitScore(run('Charlie', 400))).toEqual({ rank: 3 });
    // Earlier run first among ties.
    expect((await b.topScores('boulder')).map((e) => e.player)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('respects the limit and keeps boards separate', async () => {
    const b = new LocalBackend();
    await b.submitScore(run('Livio', 777, { mode: 'rope' }));
    expect(await b.topScores('boulder', { limit: 3 })).toHaveLength(3);
    const rope = await b.topScores('rope');
    expect(rope.some((e) => e.player === 'Livio' && e.score === 777)).toBe(true);
    const boulder = await b.topScores('boulder');
    expect(boulder.some((e) => e.player === 'Livio')).toBe(false);
  });

  it('keys daily boards by date, with deterministic ghosts', async () => {
    const b = new LocalBackend();
    await b.submitScore(run('Livio', 600, { mode: 'daily', dailyKey: '2026-10-17' }));
    const d17 = await b.topScores('daily', { dailyKey: '2026-10-17' });
    const d18 = await b.topScores('daily', { dailyKey: '2026-10-18' });
    expect(d17.some((e) => e.player === 'Livio')).toBe(true);
    expect(d18.some((e) => e.player === 'Livio')).toBe(false);
    expect(d17.every((e) => e.dailyKey === '2026-10-17')).toBe(true);
    expect(ghostScores('daily', '2026-10-18')).toEqual(ghostScores('daily', '2026-10-18'));
    expect(d18.length).toBe(5);
  });

  it("uses today's UTC key when a daily board is requested without one", async () => {
    const now = Date.UTC(2026, 9, 17, 12);
    const b = new LocalBackend({ now: () => now });
    await b.submitScore(run('Livio', 321, { mode: 'daily', dailyKey: utcDayKey(now) }));
    const board = await b.topScores('daily');
    expect(board.some((e) => e.player === 'Livio' && e.dailyKey === '2026-10-17')).toBe(true);
  });

  it('rejects a daily score without a valid date key', async () => {
    const b = new LocalBackend();
    await expect(b.submitScore(run('Livio', 1, { mode: 'daily' }))).rejects.toThrow(TypeError);
  });

  it('sanitises and clamps submitted entries', async () => {
    const b = new LocalBackend({ ghosts: false });
    await b.submitScore({ player: '  Mira   K. ', score: 9e12, mode: 'boulder', sends: -4, maxGrade: 40, head: 'dragon' as never });
    const [e] = await b.topScores('boulder');
    expect(e).toMatchObject({ player: 'Mira K.', score: 5_000_000, sends: 0, maxGrade: 12, head: 'ibex' });
  });

  it('persists across instances and survives corrupted storage', async () => {
    await new LocalBackend().submitScore(run('Livio', 4321));
    const again = await new LocalBackend().topScores('boulder');
    expect(again.some((e) => e.player === 'Livio' && e.score === 4321)).toBe(true);

    storage.setItem(LOCAL_KEYS.scores, '{"broken":');
    storage.setItem(LOCAL_KEYS.problems, '"nope"');
    const b = new LocalBackend();
    expect((await b.topScores('boulder')).every((e) => isGhostId(e.id))).toBe(true);
    expect(await b.listProblems()).toHaveLength(ghostProblems().length);
  });

  it('works in memory when localStorage is unavailable', async () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    const b = new LocalBackend();
    expect(b.persistent).toBe(false);
    await b.submitScore(run('Livio', 2222));
    expect((await b.topScores('boulder')).some((e) => e.player === 'Livio')).toBe(true);
  });

  it('can run without ghosts', async () => {
    const b = new LocalBackend({ ghosts: false });
    expect(await b.topScores('boulder')).toEqual([]);
    expect(await b.listProblems()).toEqual([]);
  });
});

describe('community problems', () => {
  it("lists Steini's ghost problems, all valid and climbable", async () => {
    const b = new LocalBackend();
    const list = await b.listProblems();
    expect(list.length).toBe(4);
    for (const p of list) {
      expect(isGhostId(p.id)).toBe(true);
      expect(p.author).toBe('Steini');
      expect(p.boulder.id).toBe(p.id);
      expect(parseBoulder(p.boulder, { requireClimbable: true })).not.toBeNull();
      expect(p.boulder.holds.filter((h) => h.role === 'start').length).toBeGreaterThanOrEqual(1);
      expect(p.boulder.holds.filter((h) => h.role === 'top')).toHaveLength(1);
      expect(new Set(p.boulder.holds.map((h) => h.id)).size).toBe(p.boulder.holds.length);
      expect(p.sends).toBeLessThanOrEqual(p.plays);
    }
  });

  it('sorts by newest and by popularity', async () => {
    const b = new LocalBackend();
    const fresh = await b.listProblems({ sort: 'new' });
    for (let i = 1; i < fresh.length; i++) expect(fresh[i - 1].createdAt).toBeGreaterThanOrEqual(fresh[i].createdAt);
    const popular = await b.listProblems({ sort: 'popular' });
    for (let i = 1; i < popular.length; i++) expect(popular[i - 1].plays).toBeGreaterThanOrEqual(popular[i].plays);
    expect(await b.listProblems({ limit: 2 })).toHaveLength(2);
  });

  it('publishes a problem that shows up first under "new"', async () => {
    const b = new LocalBackend();
    const p = await b.publishProblem({ name: '  Crimp   Shrimp ', author: 'Livio', grade: 4, boulder: testBoulder() });
    expect(p.id.startsWith('local-p-')).toBe(true);
    expect(p).toMatchObject({ name: 'Crimp Shrimp', author: 'Livio', grade: 4, plays: 0, sends: 0 });
    expect(p.boulder).toMatchObject({ id: p.id, name: 'Crimp Shrimp', author: 'Livio', grade: 4 });
    const list = await b.listProblems({ sort: 'new' });
    expect(list[0].id).toBe(p.id);
    expect(list).toHaveLength(5);
    // Persisted for the next session.
    expect((await new LocalBackend().listProblems()).some((q) => q.id === p.id)).toBe(true);
  });

  it('rejects unplayable or unnamed problems', async () => {
    const b = new LocalBackend();
    const noTop = testBoulder({ holds: testBoulder().holds.filter((h) => h.role !== 'top') });
    await expect(b.publishProblem({ name: 'No Top', author: 'Livio', grade: 1, boulder: noTop })).rejects.toThrow(/start \+ top/);
    await expect(b.publishProblem({ name: '   ', author: 'Livio', grade: 1, boulder: testBoulder({ name: '' }) })).rejects.toThrow(/name/);
    await expect(b.publishProblem({ name: 'Ok', author: 'X', grade: 1, boulder: testBoulder() })).rejects.toThrow(/author/);
  });

  it('records attempts and sends, which drive popularity', async () => {
    const b = new LocalBackend();
    const p = await b.publishProblem({ name: 'Popular One', author: 'Livio', grade: 2, boulder: testBoulder() });
    await b.recordAttempt(p.id, false);
    await b.recordAttempt(p.id, true);
    let got = (await b.listProblems()).find((q) => q.id === p.id)!;
    expect(got).toMatchObject({ plays: 2, sends: 1 });

    const top = Math.max(...ghostProblems().map((g) => g.plays));
    for (let i = 0; i < top; i++) await b.recordAttempt(p.id, false);
    const popular = await b.listProblems({ sort: 'popular' });
    expect(popular[0].id).toBe(p.id);
    got = popular[0];
    expect(got.plays).toBe(top + 2);

    // Ghost problems count local plays on top of their baseline.
    const ghost = ghostProblems()[0];
    await b.recordAttempt(ghost.id, true);
    const g = (await b.listProblems({ limit: 50 })).find((q) => q.id === ghost.id)!;
    expect(g.plays).toBe(ghost.plays + 1);
    expect(g.sends).toBe(ghost.sends + 1);
  });
});

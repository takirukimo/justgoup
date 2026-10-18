// Contract test: every request SupabaseBackend sends must fit supabase/schema.sql. The schema is
// parsed (tables, column-level INSERT grants, RPC signatures, CHECK enums) and each request the
// client makes is checked against it, so a renamed column or changed RPC fails here instead of in
// production. No network: fetch is mocked.

import { describe, expect, it } from 'vitest';
import SCHEMA_SQL from '../../supabase/schema.sql?raw';
import type { BoulderDef, ScoreEntry } from '../core/types';
import { HEADS } from '../config/skins';
import { SupabaseBackend } from './supabase';
import { LEADERBOARD_MODES, LIMITS, jsonBytes } from './validate';

const SQL = SCHEMA_SQL.replace(/--[^\n]*/g, '');

function tableColumns(table: string): Map<string, string> {
  const m = SQL.match(new RegExp(`create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error(`table ${table} not found in schema.sql`);
  const cols = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    const c = line.trim().match(/^([a-z_]+)\s+([a-z]+)/);
    if (c) cols.set(c[1], c[2]);
  }
  return cols;
}

function insertGrant(table: string): Set<string> {
  const m = SQL.match(new RegExp(`grant insert \\(([^)]*)\\) on table public\\.${table} to anon`));
  if (!m) throw new Error(`no column-level insert grant for ${table}`);
  return new Set(m[1].split(',').map((s) => s.trim()));
}

function rpcParams(fn: string): { name: string; type: string; optional: boolean }[] {
  const m = SQL.match(new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`));
  if (!m) throw new Error(`function ${fn} not found`);
  return m[1].split(',').map((p) => {
    const [name, type] = p.trim().split(/\s+/);
    return { name, type, optional: /default/.test(p) };
  });
}

function checkList(constraint: string): string[] {
  const m = SQL.match(new RegExp(`${constraint} check \\([\\s\\S]*? in \\(([^)]*)\\)`));
  if (!m) throw new Error(`constraint ${constraint} not found`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

interface Req {
  method: string;
  url: URL;
  body: unknown;
  prefer?: string;
}

function backend(reply: (r: Req) => { status?: number; body?: unknown }) {
  const calls: Req[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r: Req = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      prefer: headers.Prefer,
    };
    calls.push(r);
    const out = reply(r);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as typeof fetch;
  return { b: new SupabaseBackend('https://demo.supabase.co', 'sb_publishable_test', { fetch: fetchFn }), calls };
}

const route = (r: Req): string => r.url.pathname.replace('/rest/v1/', '');

/** Columns a GET touches: select list, filters and order keys. */
function readColumns(r: Req): string[] {
  const out: string[] = [];
  for (const [k, v] of r.url.searchParams) {
    if (k === 'select') out.push(...v.split(','));
    else if (k === 'order') out.push(...v.split(',').map((o) => o.split('.')[0]));
    else if (k !== 'limit' && k !== 'offset') out.push(k);
  }
  return out;
}

function expectRpcBody(fn: string, body: unknown): void {
  const params = rpcParams(fn);
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) expect(params.map((p) => p.name), `${fn}: unknown argument ${key}`).toContain(key);
  for (const p of params) {
    if (!p.optional) expect(b, `${fn}: missing ${p.name}`).toHaveProperty(p.name);
    const v = b[p.name];
    if (v === undefined || v === null) continue;
    if (p.type === 'text') expect(typeof v).toBe('string');
    else if (p.type === 'integer') expect(Number.isInteger(v)).toBe(true);
    else if (p.type === 'boolean') expect(typeof v).toBe('boolean');
    else if (p.type === 'uuid') expect(String(v)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    else throw new Error(`untested parameter type ${p.type}`);
  }
}

const SCORE_COLS = tableColumns('scores');
const PROBLEM_COLS = tableColumns('problems');

function score(over: Partial<ScoreEntry> = {}): ScoreEntry {
  return { player: 'Mira K.', score: 4321, mode: 'boulder', sends: 3, maxGrade: 4, head: 'lynx', createdAt: Date.now(), ...over };
}

function boulder(): BoulderDef {
  const h = (id: string, x: number, y: number, role: 'start' | 'hand' | 'foot' | 'top', type: 'jug' | 'foot' = 'jug') => ({
    id, x, y, type, role, size: 0.06, angle: Math.PI / 2, color: '#FF4F1F', seed: 7,
  });
  return {
    id: 'draft-1',
    name: 'Föhnsturm',
    grade: 3,
    mode: 'boulder',
    wallAngle: 20,
    width: 4,
    height: 4.2,
    holds: [h('s1', -0.2, 1.5, 'start'), h('s2', 0.2, 1.5, 'start'), h('f1', 0, 0.5, 'foot', 'foot'), h('m1', 0, 2.5, 'hand'), h('t1', 0, 3.6, 'top')],
    color: '#FF4F1F',
    seed: 99,
  };
}

describe('supabase/schema.sql contract', () => {
  it('parses the schema it is checking against', () => {
    expect([...SCORE_COLS.keys()]).toEqual(['id', 'player', 'mode', 'score', 'sends', 'max_grade', 'head', 'daily_key', 'created_at']);
    expect(PROBLEM_COLS.has('data')).toBe(true);
    expect(rpcParams('score_rank').map((p) => p.name)).toEqual(['p_mode', 'p_score', 'p_daily_key']);
    expect(rpcParams('record_attempt').map((p) => `${p.name}:${p.type}`)).toEqual(['p_problem_id:uuid', 'p_sent:boolean']);
  });

  it('client enums and limits match the CHECK constraints', () => {
    expect(new Set(checkList('scores_mode_check'))).toEqual(new Set(LEADERBOARD_MODES));
    expect(new Set(checkList('scores_head_check'))).toEqual(new Set(HEADS.map((h) => h.id)));
    expect(SQL).toContain(`score between 0 and ${LIMITS.scoreMax}`);
    expect(SQL).toContain(`sends between 0 and ${LIMITS.sendsMax}`);
    expect(SQL).toContain(`max_grade between 0 and ${LIMITS.gradeMax}`);
    expect(SQL).toContain(`grade between 0 and ${LIMITS.gradeMax}`);
    expect(SQL).toContain(`wall_angle between ${LIMITS.wallAngleMin} and ${LIMITS.wallAngleMax}`);
    expect(SQL).toContain(`octet_length(data::text) < ${LIMITS.boulderBytesMax}`);
    expect(SQL).toContain(`char_length(name) between 1 and ${LIMITS.problemNameMax}`);
  });

  it('health check and leaderboard reads only touch existing score columns', async () => {
    const { b, calls } = backend(() => ({ body: [] }));
    expect(await b.health()).toBe(true);
    await b.topScores('boulder');
    await b.topScores('daily', { dailyKey: '2026-10-18' });
    for (const r of calls) {
      expect(r.method).toBe('GET');
      expect(route(r)).toBe('scores');
      for (const c of readColumns(r)) expect(SCORE_COLS.has(c), `scores.${c}`).toBe(true);
    }
  });

  it('score inserts send only granted columns, and rank through score_rank(text, integer, text)', async () => {
    const { b, calls } = backend((r) => (route(r) === 'rpc/score_rank' ? { body: 2 } : { status: 201 }));
    expect(await b.submitScore(score())).toEqual({ rank: 2 });
    await b.submitScore(score({ mode: 'daily', dailyKey: '2026-10-18', score: 9_999_999 }));
    const granted = insertGrant('scores');
    const inserts = calls.filter((r) => route(r) === 'scores');
    expect(inserts).toHaveLength(2);
    for (const r of inserts) {
      expect(r.method).toBe('POST');
      expect(r.prefer).toBe('return=minimal'); // anon may not need SELECT on what it inserts
      const row = r.body as Record<string, unknown>;
      for (const k of Object.keys(row)) expect(granted.has(k), `insert scores.${k} is not granted to anon`).toBe(true);
      // daily_key is present exactly for the daily board (scores_daily_key_check)
      expect(row.daily_key === null).toBe(row.mode !== 'daily');
      expect(row.score as number).toBeLessThanOrEqual(LIMITS.scoreMax);
    }
    const ranks = calls.filter((r) => route(r) === 'rpc/score_rank');
    expect(ranks).toHaveLength(2);
    for (const r of ranks) expectRpcBody('score_rank', r.body);
    expect(ranks[1].body).toEqual({ p_mode: 'daily', p_score: LIMITS.scoreMax, p_daily_key: '2026-10-18' });
  });

  it('publishing inserts granted problem columns; listing reads existing ones', async () => {
    const { b, calls } = backend((r) => {
      if (r.method === 'POST') {
        const row = r.body as Record<string, unknown>;
        return { status: 201, body: [{ ...row, plays: 0, sends: 0, created_at: '2026-10-18T10:00:00Z' }] };
      }
      return { body: [] };
    });
    const p = await b.publishProblem({ name: 'Föhnsturm', author: 'Steini', grade: 3, boulder: boulder() });
    expect(p.name).toBe('Föhnsturm');
    await b.listProblems({ sort: 'new' });
    await b.listProblems({ sort: 'popular' });
    const granted = insertGrant('problems');
    const [insert, ...reads] = calls;
    expect(route(insert)).toBe('problems');
    // return=representation needs SELECT on problems for anon
    expect(insert.prefer).toBe('return=representation');
    expect(SQL).toMatch(/grant select on table public\.problems to anon/);
    for (const k of Object.keys(insert.body as object)) expect(granted.has(k), `insert problems.${k} is not granted to anon`).toBe(true);
    for (const r of reads) for (const c of readColumns(r)) expect(PROBLEM_COLS.has(c), `problems.${c}`).toBe(true);
  });

  it('a retried publish that already landed re-reads the row by existing columns', async () => {
    const { b, calls } = backend((r) =>
      r.method === 'POST' ? { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint' } } : { body: [] },
    );
    await b.publishProblem({ id: '12345678-1234-4234-8234-123456789abc', name: 'Föhnsturm', author: 'Steini', grade: 3, boulder: boulder() });
    expect(calls).toHaveLength(2);
    for (const c of readColumns(calls[1])) expect(PROBLEM_COLS.has(c), `problems.${c}`).toBe(true);
  });

  it('attempts go through record_attempt(uuid, boolean)', async () => {
    const { b, calls } = backend(() => ({ status: 204 }));
    await b.recordAttempt('12345678-1234-4234-8234-123456789abc', true);
    await b.recordAttempt('12345678-1234-4234-8234-123456789abc', false);
    expect(calls.map(route)).toEqual(['rpc/record_attempt', 'rpc/record_attempt']);
    for (const r of calls) expectRpcBody('record_attempt', r.body);
  });

  it('the client size check is at least as strict as octet_length(jsonb::text)', () => {
    // jsonb renders `{"a": 1, "b": [1, 2]}`: a space after every ':' and ','
    const b = boulder();
    const jsonbText = JSON.stringify(b).replace(/([:,])/g, '$1 ');
    expect(jsonBytes(b)).toBeGreaterThanOrEqual(new TextEncoder().encode(jsonbText).length);
  });
});

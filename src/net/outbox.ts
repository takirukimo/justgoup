// Persistent retry queue for writes that could not reach the global backend (offline, timeout,
// rate limit, transient outage). Items are tagged with the backend they were meant for, flushed
// in order, and dropped after too many attempts or when they get too old.

import type { ScoreEntry } from '../core/types';
import { kv, randomId, readJSON, writeJSON, type KVStore } from './storage';
import { normalizePublish, parseScore, type PublishInput } from './validate';

export const OUTBOX_KEY = 'jgu.outbox.v1';
const MAX_ITEMS = 100;
const MAX_AGE_MS = 14 * 86_400_000;
export const MAX_TRIES = 20;

export type OutboxPayload =
  | { kind: 'score'; entry: ScoreEntry }
  | { kind: 'problem'; problem: PublishInput & { id: string } }
  | { kind: 'attempt'; problemId: string; sent: boolean };

export type OutboxItem = OutboxPayload & {
  id: string;
  /** Backend identity, e.g. `supabase:https://x.supabase.co/rest/v1/` or `artifact`. */
  target: string;
  tries: number;
  at: number;
};

function parseItem(raw: unknown, now: number): OutboxItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.target !== 'string' || typeof r.at !== 'number' || typeof r.tries !== 'number') return null;
  if (!Number.isFinite(r.at) || now - r.at > MAX_AGE_MS || r.tries >= MAX_TRIES) return null;
  const head = { id: r.id, target: r.target, tries: Math.max(0, Math.floor(r.tries)), at: r.at };
  switch (r.kind) {
    case 'score': {
      const entry = parseScore(r.entry);
      return entry && entry.id ? { ...head, kind: 'score', entry } : null;
    }
    case 'problem': {
      const p = r.problem as (PublishInput & { id?: unknown }) | undefined;
      if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
      try {
        const clean = normalizePublish(p);
        return { ...head, kind: 'problem', problem: { ...clean, id: p.id } };
      } catch {
        return null;
      }
    }
    case 'attempt':
      return typeof r.problemId === 'string' && typeof r.sent === 'boolean' ? { ...head, kind: 'attempt', problemId: r.problemId, sent: r.sent } : null;
    default:
      return null;
  }
}

export class Outbox {
  private readonly store: KVStore;
  private readonly now: () => number;

  constructor(opts: { store?: KVStore; now?: () => number } = {}) {
    this.store = opts.store ?? kv;
    this.now = opts.now ?? Date.now;
  }

  /** All live items (expired / exhausted ones are pruned on read). */
  all(): OutboxItem[] {
    const raw = readJSON<unknown>(OUTBOX_KEY, [], this.store);
    if (!Array.isArray(raw)) return [];
    const now = this.now();
    const out: OutboxItem[] = [];
    for (const r of raw) {
      const item = parseItem(r, now);
      if (item) out.push(item);
    }
    return out;
  }

  /** Items queued for one backend, oldest first. */
  forTarget(target: string): OutboxItem[] {
    return this.all().filter((i) => i.target === target);
  }

  push(target: string, payload: OutboxPayload): OutboxItem {
    const item = { ...payload, id: randomId('ob-'), target, tries: 0, at: this.now() } as OutboxItem;
    const items = this.all();
    items.push(item);
    this.save(items.slice(-MAX_ITEMS));
    return item;
  }

  remove(id: string): void {
    this.save(this.all().filter((i) => i.id !== id));
  }

  /** Count a failed delivery attempt (items are dropped after MAX_TRIES). */
  bump(id: string): void {
    this.save(this.all().map((i) => (i.id === id ? { ...i, tries: i.tries + 1 } : i)));
  }

  private save(items: OutboxItem[]): void {
    writeJSON(OUTBOX_KEY, items, this.store);
  }
}

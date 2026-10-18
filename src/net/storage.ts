// Safe key/value persistence: localStorage when it works, an in-memory map when it doesn't
// (private mode, blocked site data, sandboxed previews, quota exhaustion, Node tests).
// Every access is wrapped in try/catch — persistence must never crash the game.

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
  /** True when values survive a reload (real localStorage that accepted the last write). */
  readonly persistent: boolean;
}

/** Values that could not reach localStorage (unavailable, quota, blocked) live here instead. */
const memory = new Map<string, string>();
/** Keys whose latest write only reached memory: reads must not trust localStorage for them. */
const memoryOnly = new Set<string>();

function nativeStorage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

class SafeStore implements KVStore {
  private lastWriteOk = true;

  get persistent(): boolean {
    return nativeStorage() !== null && this.lastWriteOk;
  }

  get(key: string): string | null {
    const s = nativeStorage();
    if (s && !memoryOnly.has(key)) {
      try {
        return s.getItem(key);
      } catch {
        /* fall through to memory */
      }
    }
    return memory.get(key) ?? null;
  }

  set(key: string, value: string): boolean {
    const s = nativeStorage();
    if (s) {
      try {
        s.setItem(key, value);
        memory.delete(key);
        memoryOnly.delete(key);
        this.lastWriteOk = true;
        return true;
      } catch {
        this.lastWriteOk = false;
      }
    }
    memory.set(key, value);
    memoryOnly.add(key);
    return false;
  }

  remove(key: string): void {
    memory.delete(key);
    memoryOnly.delete(key);
    const s = nativeStorage();
    if (!s) return;
    try {
      s.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Process-wide store (resolves `localStorage` lazily on every call, so tests can swap it). */
export const kv: KVStore = new SafeStore();

/** Read + JSON.parse; returns `fallback` for a missing key or malformed JSON. */
export function readJSON<T>(key: string, fallback: T, store: KVStore = kv): T {
  const raw = store.get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON.stringify + write; returns false if it only reached the memory fallback. */
export function writeJSON(key: string, value: unknown, store: KVStore = kv): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false;
  }
  return store.set(key, raw);
}

/** Test helper: forget everything held in the memory fallback. */
export function resetMemoryStore(): void {
  memory.clear();
  memoryOnly.clear();
}

/** Random id with a prefix, e.g. `local-s-k3j9x2m1q8`. Uses crypto when available. */
export function randomId(prefix: string): string {
  return `${prefix}${randomToken(10)}`;
}

export function randomToken(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(len);
    c.getRandomValues(bytes);
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** RFC 4122 v4 UUID (crypto.randomUUID when available). */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 32-bit FNV-1a hash (deterministic seeds for ghosts, path-safe keys). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable per-device id (used as the player key when the platform gives no user id). */
export function deviceId(store: KVStore = kv): string {
  const key = 'jgu.device.v1';
  const existing = store.get(key);
  if (existing && /^[a-z0-9]{8,40}$/.test(existing)) return existing;
  const id = 'd' + randomToken(15);
  store.set(key, id);
  return id;
}

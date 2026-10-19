import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultProfile, flushProfile, freezeProfileSaves, loadProfile, PROFILE_KEY, saveProfile } from './profile';
import { START_OVER_KEYS, wipeLocalProgress } from './reset';
import { resetMemoryStore } from './storage';
import { OUTBOX_KEY } from './outbox';

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
  freezeProfileSaves(false);
  flushProfile();
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('Start over (wipeLocalProgress)', () => {
  it('wipes the profile, settings, drafts and the offline boards, keeps the device id and the outbox', () => {
    const p = defaultProfile();
    p.playerName = 'Old Ibex';
    p.introSeen = true;
    p.tutorialDone = true;
    p.best.boulder = 4200;
    saveProfile(p);
    flushProfile();
    for (const k of START_OVER_KEYS) if (k !== PROFILE_KEY) storage.setItem(k, '"x"');
    storage.setItem('jgu.device.v1', 'dabcdefgh12345');
    storage.setItem(OUTBOX_KEY, '[]');
    expect(loadProfile().playerName).toBe('Old Ibex');

    wipeLocalProgress();
    for (const k of START_OVER_KEYS) expect(storage.getItem(k), k).toBeNull();
    expect(storage.getItem('jgu.device.v1')).toBe('dabcdefgh12345');
    expect(storage.getItem(OUTBOX_KEY)).toBe('[]');
    // the next launch is a first launch
    const fresh = loadProfile();
    expect(fresh.playerName).toBe('');
    expect(fresh.introSeen).toBe(false);
    expect(fresh.tutorialDone).toBe(false);
    expect(fresh.best.boulder).toBe(0);
  });

  it('a save still pending (or made before the reload) never writes the old profile back', () => {
    const p = defaultProfile();
    p.playerName = 'Old Ibex';
    saveProfile(p); // debounced, not yet written
    wipeLocalProgress();
    flushProfile(); // pagehide / visibility flush
    saveProfile(p); // the app saving its in-memory profile during the reload
    flushProfile();
    expect(storage.getItem(PROFILE_KEY)).toBeNull();
    // restarting in place (no reload): saves work again
    freezeProfileSaves(false);
    saveProfile(defaultProfile());
    flushProfile();
    expect(storage.getItem(PROFILE_KEY)).not.toBeNull();
  });

  it('covers every jgu.* key that holds progress, never the device id or the outbox', () => {
    expect(START_OVER_KEYS).toContain(PROFILE_KEY);
    expect(START_OVER_KEYS).toContain('jgu.editor.draft');
    expect(START_OVER_KEYS).toContain('jgu.local.scores.v1');
    expect(START_OVER_KEYS).not.toContain('jgu.device.v1');
    expect(START_OVER_KEYS).not.toContain(OUTBOX_KEY);
    for (const k of START_OVER_KEYS) expect(k.startsWith('jgu.')).toBe(true);
  });
});

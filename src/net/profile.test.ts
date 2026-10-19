import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '../core/types';
import { CHALKS, COLORWAYS, HEADS } from '../config/skins';
import {
  defaultProfile,
  evaluateUnlocks,
  flushProfile,
  getRopeTops,
  isValidName,
  loadProfile,
  migrateProfile,
  PROFILE_KEY,
  recordRopeTop,
  sanitizeName,
  saveProfile,
  unlockProgress,
} from './profile';
import { FUN_NAMES, isProfane } from './names';
import { GHOST_CLIMBERS } from './ghosts';
import { resetMemoryStore } from './storage';

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
  flushProfile();
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('defaultProfile', () => {
  it('starts with the free items unlocked and equipped', () => {
    const p = defaultProfile();
    expect(p.version).toBe(1);
    expect(p.playerName).toBe('');
    expect(p.head).toBe('ibex');
    expect(p.colorway).toBe('basalt');
    expect(p.chalk).toBe('classic');
    expect(p.unlocked.heads).toEqual(['ibex', 'human']); // the plain human (CHIRAL cap) is free from the start
    expect(p.unlocked.colorways).toEqual(['basalt', 'white', 'pink', 'glacier']); // the three CHIRAL tees + glacier
    expect(p.unlocked.chalks).toEqual(['classic']);
    expect(p.stats.totalScore).toBe(0);
    expect(p.myProblems).toEqual([]);
    expect(p.settings.quality).toBe('auto');
  });

  it('returns independent objects', () => {
    const a = defaultProfile();
    const b = defaultProfile();
    a.unlocked.heads.push('goat');
    a.best.daily['2026-10-17'] = 5;
    expect(b.unlocked.heads).toEqual(['ibex', 'human']);
    expect(b.best.daily).toEqual({});
  });
});

describe('evaluateUnlocks', () => {
  it('reports nothing for a fresh profile', () => {
    const p = defaultProfile();
    expect(evaluateUnlocks(p)).toEqual([]);
  });

  it('unlocks the marmot when the tutorial is done', () => {
    const p = defaultProfile();
    p.tutorialDone = true;
    expect(evaluateUnlocks(p)).toEqual([{ kind: 'head', id: 'marmot', name: 'Marmot' }]);
    expect(p.unlocked.heads).toEqual(['ibex', 'marmot', 'human']);
  });

  it('unlocks by lifetime points across heads, colorways and chalks (heads first)', () => {
    const p = defaultProfile();
    p.stats.totalScore = 1500;
    const got = evaluateUnlocks(p);
    expect(got).toEqual([
      { kind: 'head', id: 'chamois', name: 'Chamois' },
      { kind: 'colorway', id: 'moss', name: 'Moss' },
      { kind: 'chalk', id: 'glacier', name: 'Glacier' },
    ]);
    // Second evaluation reports nothing new.
    expect(evaluateUnlocks(p)).toEqual([]);
    p.stats.totalScore = 25000;
    const more = evaluateUnlocks(p).map((u) => u.id);
    expect(more).toEqual(['goat', 'snowleopard', 'vulture', 'ember', 'dune', 'moss', 'gold']);
  });

  it('keeps unlocked lists in config order', () => {
    const p = defaultProfile();
    p.stats.totalScore = 100000;
    p.tutorialDone = true;
    evaluateUnlocks(p);
    const order = HEADS.map((h) => h.id).filter((id) => p.unlocked.heads.includes(id));
    expect(p.unlocked.heads).toEqual(order);
  });

  it('handles grade, streak, clips and flashes rules', () => {
    const p = defaultProfile();
    p.stats.highestGrade = 5;
    expect(evaluateUnlocks(p).map((u) => u.id)).toEqual(['eagle']);
    p.stats.highestGrade = 8;
    expect(evaluateUnlocks(p).map((u) => u.id)).toEqual(['aurora']);
    p.stats.longestStreak = 5;
    expect(evaluateUnlocks(p).map((u) => u.id)).toEqual(['ember']); // chalk
    p.stats.longestStreak = 8;
    expect(evaluateUnlocks(p).map((u) => u.id)).toEqual(['lynx']);
    p.stats.clips = 29;
    expect(evaluateUnlocks(p)).toEqual([]);
    p.stats.clips = 30;
    expect(evaluateUnlocks(p)).toEqual([{ kind: 'colorway', id: 'alpenglow', name: 'Alpenglow' }]);
    p.stats.flashes = 5;
    expect(evaluateUnlocks(p)).toEqual([{ kind: 'colorway', id: 'lichen', name: 'Lichen' }]);
  });

  it('unlocks the ram after topping the Lead Tower (stats.ropeTops extra)', () => {
    const p = defaultProfile();
    expect(getRopeTops(p)).toBe(0);
    expect(evaluateUnlocks(p)).toEqual([]);
    recordRopeTop(p);
    expect(getRopeTops(p)).toBe(1);
    expect(evaluateUnlocks(p)).toEqual([{ kind: 'head', id: 'ram', name: 'Bighorn Ram' }]);
  });

  it('unlocks everything for a maxed profile', () => {
    const p = defaultProfile();
    Object.assign(p.stats, { totalScore: 1e6, highestGrade: 12, longestStreak: 50, clips: 500, flashes: 99 });
    p.tutorialDone = true;
    recordRopeTop(p);
    evaluateUnlocks(p);
    expect(p.unlocked.heads).toHaveLength(HEADS.length);
    expect(p.unlocked.colorways).toHaveLength(COLORWAYS.length);
    expect(p.unlocked.chalks).toHaveLength(CHALKS.length);
  });

  it('reports progress toward a rule', () => {
    const p = defaultProfile();
    p.stats.totalScore = 600;
    expect(unlockProgress({ kind: 'points', points: 1500 }, p)).toEqual({ current: 600, target: 1500, done: false });
    expect(unlockProgress({ kind: 'free' }, p).done).toBe(true);
    expect(unlockProgress({ kind: 'rope-top' }, p)).toEqual({ current: 0, target: 1, done: false });
  });
});

describe('migrateProfile / loadProfile', () => {
  it('returns defaults for missing or garbage data', () => {
    expect(migrateProfile(null)).toEqual(defaultProfile());
    expect(migrateProfile('nope')).toEqual(defaultProfile());
    expect(migrateProfile([1, 2])).toEqual(defaultProfile());
    storage.setItem(PROFILE_KEY, '{not json');
    expect(loadProfile()).toEqual(defaultProfile());
  });

  it('merges missing fields and keeps valid ones', () => {
    const p = migrateProfile({ playerName: 'Mira K.', stats: { sends: 12, totalScore: 3400 }, tutorialDone: true });
    expect(p.playerName).toBe('Mira K.');
    expect(p.stats.sends).toBe(12);
    expect(p.stats.totalScore).toBe(3400);
    expect(p.stats.falls).toBe(0);
    expect(p.tutorialDone).toBe(true);
    expect(p.introSeen).toBe(false);
    expect(p.settings).toEqual(defaultProfile().settings);
    expect(p.best).toEqual({ boulder: 0, rope: 0, daily: {} });
  });

  it('clamps unknown ids to defaults and never equips a locked item', () => {
    const p = migrateProfile({
      head: 'dragon',
      colorway: 'ember', // valid id but not unlocked
      chalk: 'gold',
      unlocked: { heads: ['ibex', 'dragon', 'eagle'], colorways: ['neon'], chalks: 'gold' },
    });
    expect(p.head).toBe('ibex');
    expect(p.colorway).toBe('basalt');
    expect(p.chalk).toBe('classic');
    expect(p.unlocked.heads).toEqual(['ibex', 'eagle', 'human']);
    expect(p.unlocked.colorways).toEqual(['basalt', 'white', 'pink', 'glacier']);
    expect(p.unlocked.chalks).toEqual(['classic']);
  });

  it('keeps an equipped item that is unlocked', () => {
    const p = migrateProfile({ head: 'eagle', unlocked: { heads: ['eagle'] } });
    expect(p.head).toBe('eagle');
    expect(p.unlocked.heads).toEqual(['ibex', 'eagle', 'human']);
  });

  it('sanitises numbers, settings, daily bests and drafts', () => {
    const p = migrateProfile({
      best: { boulder: -5, rope: 812.7, daily: { '2026-10-17': 640, 'yesterday': 3, '2026-10-16': -1 } },
      stats: { highestGrade: 99, metersClimbed: 12.5, clips: Number.NaN, ropeTops: 2 },
      settings: { sfx: 3, music: -1, haptics: 'yes', quality: 'ultra', assist: false },
      myProblems: [{ junk: true }, { id: 'draft-1', name: 'Draft', grade: 3, mode: 'boulder', wallAngle: 10, width: 4.6, height: 4.5, holds: [], color: '#F2C230', seed: 1 }],
      playerName: '  Föhn   der  Wind ',
    });
    expect(p.best).toEqual({ boulder: 0, rope: 812, daily: { '2026-10-17': 640 } });
    expect(p.stats.highestGrade).toBe(12);
    expect(p.stats.metersClimbed).toBe(12.5);
    expect(p.stats.clips).toBe(0);
    expect(getRopeTops(p)).toBe(2);
    expect(p.settings.sfx).toBe(1);
    expect(p.settings.music).toBe(0);
    expect(p.settings.haptics).toBe(true);
    expect(p.settings.quality).toBe('auto');
    expect(p.settings.assist).toBe(false);
    expect(p.myProblems).toHaveLength(1);
    expect(p.myProblems[0].id).toBe('draft-1');
    expect(p.playerName).toBe('Föhn der Wind');
  });

  it('round-trips through save/flush/load (debounced write)', () => {
    const p = defaultProfile();
    p.playerName = 'Basalt Bob';
    p.stats.totalScore = 4200;
    evaluateUnlocks(p);
    saveProfile(p);
    expect(storage.getItem(PROFILE_KEY)).toBeNull(); // still debounced
    expect(flushProfile()).toBe(true);
    expect(storage.getItem(PROFILE_KEY)).not.toBeNull();
    const back = loadProfile();
    expect(back).toEqual(migrateProfile(JSON.parse(storage.getItem(PROFILE_KEY)!)));
    expect(back.playerName).toBe('Basalt Bob');
    expect(back.unlocked.heads).toContain('goat');
  });

  it('loadProfile flushes a pending save first', () => {
    const p = defaultProfile();
    p.introSeen = true;
    saveProfile(p);
    expect(loadProfile().introSeen).toBe(true);
  });

  it('survives storage being unavailable (memory fallback)', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    const p: Profile = defaultProfile();
    p.playerName = 'Piz Pia';
    saveProfile(p);
    expect(flushProfile()).toBe(false); // memory only
    expect(loadProfile().playerName).toBe('Piz Pia');
  });
});

describe('sanitizeName', () => {
  it('trims, collapses whitespace and strips disallowed characters', () => {
    expect(sanitizeName('  Mira   K.  ')).toBe('Mira K.');
    expect(sanitizeName('Bob\t\nRoss')).toBe('Bob Ross');
    expect(sanitizeName('🧗 Crux<b>King</b>!')).toBe('CruxbKingb');
    expect(sanitizeName('dyno_dani-99')).toBe('dyno_dani-99');
  });

  it('keeps common accented letters and normalises to NFC', () => {
    expect(sanitizeName('Föhn')).toBe('Föhn');
    expect(sanitizeName('Łukasz Šimek')).toBe('Łukasz Šimek');
    expect(sanitizeName('Gämse ß')).toBe('Gämse ß');
    expect(sanitizeName('Rene\u0301')).toBe('René');
  });

  it('enforces 2..16 characters', () => {
    expect(sanitizeName('A')).toBe('');
    expect(sanitizeName('   ')).toBe('');
    expect(sanitizeName('...')).toBe('');
    expect(sanitizeName('-_-')).toBe('');
    expect(sanitizeName('Abcdefghijklmnopqrstuvwxyz')).toBe('Abcdefghijklmnop');
    expect(sanitizeName('Sloper Sloth 99 xyz')).toBe('Sloper Sloth 99'); // trailing space trimmed after the cut
    expect(sanitizeName(42)).toBe('');
  });

  it('swaps profanity for a fun climbing name', () => {
    for (const bad of ['fuck', 'Sh1t Head', 'FUUUCK', 'a s s', 'Arschloch', 'b!tch']) {
      const out = sanitizeName(bad);
      if (out === '') continue; // stripped to nothing is also acceptable
      expect(FUN_NAMES).toContain(out);
    }
    expect(FUN_NAMES).toContain(sanitizeName('Hitler99'));
    // Stable stand-in for the same input.
    expect(sanitizeName('fuck you')).toBe(sanitizeName('fuck you'));
  });

  it('does not flag innocent names', () => {
    for (const ok of ['Classic Climber', 'Dickens', 'Basalt Bob', 'Crimpmeister', 'Sussex Sam', 'Fickle Finn', 'Grape Ape']) {
      expect(isProfane(ok)).toBe(false);
      expect(sanitizeName(ok)).toBe(ok);
    }
  });

  it('isValidName agrees with sanitizeName', () => {
    expect(isValidName('Mira K.')).toBe(true);
    expect(isValidName(' Mira')).toBe(false);
    expect(isValidName('Mira  K')).toBe(false);
    expect(isValidName('x')).toBe(false);
    expect(isValidName('shit')).toBe(false);
  });

  it('fun names and ghost names are themselves valid', () => {
    for (const n of FUN_NAMES) expect(isValidName(n)).toBe(true);
    for (const g of GHOST_CLIMBERS) expect(isValidName(g.name)).toBe(true);
  });
});

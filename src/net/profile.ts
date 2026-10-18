// Player profile persistence (localStorage 'jgu.profile.v1', memory fallback), migration /
// validation of stored data, and unlock evaluation against the rules in src/config/skins.ts.
//
// Rope tops: the shared Profile type has no field for "topped the Lead Tower", so the count lives
// in an optional extra stat, `profile.stats.ropeTops` (see ProfileStatsExt). It is plain JSON,
// optional, and invisible to code that only knows the shared type, so nothing else breaks.
// Call recordRopeTop(profile) when the Lead Tower is topped, then evaluateUnlocks(profile).

import type { ChalkId, ColorwayId, HeadId, Profile, QualityLevel, Settings } from '../core/types';
import { CHALKS, COLORWAYS, HEADS, type Unlock } from '../config/skins';
import { kv, readJSON, type KVStore } from './storage';
import { isDailyKey, parseBoulder } from './validate';
import { sanitizeName } from './names';

export { sanitizeName, isValidName, isProfane, randomClimberName, NAME_MIN, NAME_MAX } from './names';

export const PROFILE_KEY = 'jgu.profile.v1';
const SAVE_DEBOUNCE_MS = 300;
const MAX_DAILY_BESTS = 90;
const MAX_MY_PROBLEMS = 50;

/** Profile stats plus backward-compatible optional extras. */
export type ProfileStatsExt = Profile['stats'] & {
  /** Times the Lead Tower was topped (drives the `rope-top` unlock). */
  ropeTops?: number;
};

export type UnlockedItem =
  | { kind: 'head'; id: HeadId; name: string }
  | { kind: 'colorway'; id: ColorwayId; name: string }
  | { kind: 'chalk'; id: ChalkId; name: string };

const HEAD_IDS = HEADS.map((h) => h.id);
const COLORWAY_IDS = COLORWAYS.map((c) => c.id);
const CHALK_IDS = CHALKS.map((c) => c.id);
const QUALITIES: readonly (QualityLevel | 'auto')[] = ['auto', 'low', 'medium', 'high'];

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function defaultSettings(): Settings {
  return { sfx: 0.8, music: 0.6, haptics: true, quality: 'auto', assist: true, reducedMotion: prefersReducedMotion() };
}

export function defaultProfile(): Profile {
  const stats: ProfileStatsExt = {
    sends: 0,
    falls: 0,
    highestGrade: 0,
    metersClimbed: 0,
    longestStreak: 0,
    clips: 0,
    flashes: 0,
    totalScore: 0,
    ropeTops: 0,
  };
  return {
    version: 1,
    playerName: '',
    head: 'ibex',
    colorway: 'basalt',
    chalk: 'classic',
    unlocked: {
      heads: HEADS.filter((h) => h.unlock.kind === 'free').map((h) => h.id),
      colorways: COLORWAYS.filter((c) => c.unlock.kind === 'free').map((c) => c.id),
      chalks: CHALKS.filter((c) => c.unlock.kind === 'free').map((c) => c.id),
    },
    best: { boulder: 0, rope: 0, daily: {} },
    stats,
    tutorialDone: false,
    introSeen: false,
    settings: defaultSettings(),
    myProblems: [],
  };
}

// ───────────────────────────── migration / validation ─────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown, dflt: number, int = true, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return dflt;
  const n = Math.min(v, max);
  return int ? Math.floor(n) : n;
};
const unit = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

/** Keep known ids (in config order), always including the free ones. */
function idList<T extends string>(raw: unknown, known: readonly T[], free: readonly T[]): T[] {
  const set = new Set<string>(free);
  if (Array.isArray(raw)) for (const v of raw) if (typeof v === 'string') set.add(v);
  return known.filter((id) => set.has(id));
}

/**
 * Turn whatever was stored (possibly from an older or newer build, possibly corrupted) into a
 * valid Profile: unknown ids fall back to defaults, missing fields are filled in, numbers are
 * clamped, and the equipped skin is always an unlocked one.
 */
export function migrateProfile(raw: unknown): Profile {
  const d = defaultProfile();
  if (!isObj(raw)) return d;

  const u = isObj(raw.unlocked) ? raw.unlocked : {};
  const unlocked = {
    heads: idList(u.heads, HEAD_IDS, d.unlocked.heads),
    colorways: idList(u.colorways, COLORWAY_IDS, d.unlocked.colorways),
    chalks: idList(u.chalks, CHALK_IDS, d.unlocked.chalks),
  };
  const pick = <T extends string>(v: unknown, owned: readonly T[], dflt: T): T => (typeof v === 'string' && (owned as readonly string[]).includes(v) ? (v as T) : dflt);

  const b = isObj(raw.best) ? raw.best : {};
  const daily: Record<string, number> = {};
  if (isObj(b.daily)) {
    const keys = Object.keys(b.daily).filter(isDailyKey).sort().slice(-MAX_DAILY_BESTS);
    for (const k of keys) {
      const v = nonNeg(b.daily[k], -1);
      if (v >= 0) daily[k] = v;
    }
  }

  const s = isObj(raw.stats) ? raw.stats : {};
  const ds = d.stats as ProfileStatsExt;
  const stats: ProfileStatsExt = {
    sends: nonNeg(s.sends, ds.sends),
    falls: nonNeg(s.falls, ds.falls),
    highestGrade: nonNeg(s.highestGrade, ds.highestGrade, true, 12),
    metersClimbed: nonNeg(s.metersClimbed, ds.metersClimbed, false),
    longestStreak: nonNeg(s.longestStreak, ds.longestStreak),
    clips: nonNeg(s.clips, ds.clips),
    flashes: nonNeg(s.flashes, ds.flashes),
    totalScore: nonNeg(s.totalScore, ds.totalScore),
    ropeTops: nonNeg(s.ropeTops, 0),
  };

  const st = isObj(raw.settings) ? raw.settings : {};
  const settings: Settings = {
    sfx: unit(st.sfx, d.settings.sfx),
    music: unit(st.music, d.settings.music),
    haptics: bool(st.haptics, d.settings.haptics),
    quality: typeof st.quality === 'string' && (QUALITIES as readonly string[]).includes(st.quality) ? (st.quality as Settings['quality']) : d.settings.quality,
    assist: bool(st.assist, d.settings.assist),
    reducedMotion: bool(st.reducedMotion, d.settings.reducedMotion),
  };

  const myProblems = Array.isArray(raw.myProblems)
    ? raw.myProblems
        .map((p) => parseBoulder(p))
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .slice(-MAX_MY_PROBLEMS)
    : [];

  return {
    version: 1,
    playerName: typeof raw.playerName === 'string' ? sanitizeName(raw.playerName) : '',
    head: pick(raw.head, unlocked.heads, d.head),
    colorway: pick(raw.colorway, unlocked.colorways, d.colorway),
    chalk: pick(raw.chalk, unlocked.chalks, d.chalk),
    unlocked,
    best: { boulder: nonNeg(b.boulder, 0), rope: nonNeg(b.rope, 0), daily },
    stats,
    tutorialDone: bool(raw.tutorialDone, false),
    introSeen: bool(raw.introSeen, false),
    settings,
    myProblems,
  };
}

// ───────────────────────────── persistence ─────────────────────────────

let pending: Profile | null = null;
let pendingStore: KVStore = kv;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWritten: string | null = null;
let lifecycleHooked = false;

function hookLifecycle(): void {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  try {
    if (typeof addEventListener === 'function') addEventListener('pagehide', () => flushProfile());
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushProfile();
      });
    }
  } catch {
    /* non-browser environment */
  }
}

/** Load (and migrate) the stored profile, or a fresh default one. Never throws. */
export function loadProfile(store: KVStore = kv): Profile {
  if (pending) flushProfile();
  const raw = readJSON<unknown>(PROFILE_KEY, null, store);
  const p = migrateProfile(raw);
  return p;
}

/** Persist the profile. Writes are debounced (~300 ms); call flushProfile() to force it now. */
export function saveProfile(p: Profile, store: KVStore = kv): void {
  hookLifecycle();
  if (pending && pendingStore !== store) flushProfile();
  pending = p;
  pendingStore = store;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flushProfile();
  }, SAVE_DEBOUNCE_MS);
}

/** Write any pending profile immediately. Returns false if it could only be kept in memory. */
export function flushProfile(): boolean {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = null;
  if (!p) return true;
  let raw: string;
  try {
    raw = JSON.stringify(p);
  } catch {
    return false;
  }
  if (raw === lastWritten && pendingStore.get(PROFILE_KEY) === raw) return true;
  const ok = pendingStore.set(PROFILE_KEY, raw);
  lastWritten = raw;
  return ok;
}

// ───────────────────────────── unlocks ─────────────────────────────

export function getRopeTops(p: Profile): number {
  return nonNeg((p.stats as ProfileStatsExt).ropeTops, 0);
}

/** Count one topped Lead Tower (call before evaluateUnlocks at the end of a rope run). */
export function recordRopeTop(p: Profile): void {
  (p.stats as ProfileStatsExt).ropeTops = getRopeTops(p) + 1;
}

/** Progress toward an unlock rule (current / target, target 1 for yes/no rules). */
export function unlockProgress(rule: Unlock, p: Profile): { current: number; target: number; done: boolean } {
  const r = (current: number, target: number) => ({ current: Math.min(current, target), target, done: current >= target });
  switch (rule.kind) {
    case 'free':
      return r(1, 1);
    case 'tutorial':
      return r(p.tutorialDone ? 1 : 0, 1);
    case 'points':
      return r(p.stats.totalScore, rule.points);
    case 'grade':
      return r(p.stats.highestGrade, rule.grade);
    case 'streak':
      return r(p.stats.longestStreak, rule.streak);
    case 'rope-top':
      return r(getRopeTops(p) > 0 ? 1 : 0, 1);
    case 'clips':
      return r(p.stats.clips, rule.clips);
    case 'flashes':
      return r(p.stats.flashes, rule.flashes);
  }
}

export function isUnlockMet(rule: Unlock, p: Profile): boolean {
  return unlockProgress(rule, p).done;
}

/**
 * Unlock everything whose rule the profile now meets. Mutates `profile.unlocked` (config order is
 * preserved) and returns only the newly unlocked items: heads, then colorways, then chalks.
 */
export function evaluateUnlocks(profile: Profile): UnlockedItem[] {
  const fresh: UnlockedItem[] = [];
  const u = profile.unlocked;
  if (!Array.isArray(u.heads)) u.heads = [];
  if (!Array.isArray(u.colorways)) u.colorways = [];
  if (!Array.isArray(u.chalks)) u.chalks = [];

  for (const h of HEADS) {
    if (!u.heads.includes(h.id) && isUnlockMet(h.unlock, profile)) {
      fresh.push({ kind: 'head', id: h.id, name: h.name });
      u.heads.push(h.id);
    }
  }
  for (const c of COLORWAYS) {
    if (!u.colorways.includes(c.id) && isUnlockMet(c.unlock, profile)) {
      fresh.push({ kind: 'colorway', id: c.id, name: c.name });
      u.colorways.push(c.id);
    }
  }
  for (const c of CHALKS) {
    if (!u.chalks.includes(c.id) && isUnlockMet(c.unlock, profile)) {
      fresh.push({ kind: 'chalk', id: c.id, name: c.name });
      u.chalks.push(c.id);
    }
  }
  if (fresh.length) {
    u.heads = HEAD_IDS.filter((id) => u.heads.includes(id));
    u.colorways = COLORWAY_IDS.filter((id) => u.colorways.includes(id));
    u.chalks = CHALK_IDS.filter((id) => u.chalks.includes(id));
  }
  return fresh;
}

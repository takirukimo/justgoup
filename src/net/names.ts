// Player / author name rules, shared by the profile, every backend and supabase/schema.sql.
//
// A valid name is 2..16 characters of [A-Za-z0-9 ._-] plus common accented Latin letters
// (Latin-1 Supplement + Latin Extended-A, e.g. ä ö ü é ß ł š), single spaces only, no leading or
// trailing space, at least one letter or digit. Keep NAME_CHARS in sync with the CHECK
// constraints in supabase/schema.sql.

import { fnv1a } from './storage';

export const NAME_MIN = 2;
export const NAME_MAX = 16;

const ACCENTED = '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF\\u0100-\\u017F';
/** Character class body for allowed name characters. */
export const NAME_CHARS = `A-Za-z0-9 ._\\-${ACCENTED}`;
const DISALLOWED = new RegExp(`[^${NAME_CHARS}]`, 'g');
const ALNUM = new RegExp(`[A-Za-z0-9${ACCENTED}]`);
const VALID = new RegExp(`^[${NAME_CHARS}]{${NAME_MIN},${NAME_MAX}}$`);

/** Fun stand-ins used when a name is rejected by the filter (all valid names themselves). */
export const FUN_NAMES: readonly string[] = [
  'Chalk Gremlin',
  'Crux Goblin',
  'Sandbagger',
  'Pebble Wrestler',
  'Jug Hugger',
  'Crimp Shrimp',
  'Sloper Sloth',
  'Smear Campaign',
  'Beta Hoarder',
  'Heel Hook Hero',
  'Chalk Bandit',
  'Mantle Marmot',
];

/** A climbing-pun name; deterministic for a given seed. */
export function randomClimberName(seed: number = Math.floor(Math.random() * 1e9)): string {
  const i = Math.abs(Math.floor(seed)) % FUN_NAMES.length;
  return FUN_NAMES[i];
}

/**
 * Clean up user input into a valid name: NFC-normalise, drop disallowed characters, collapse
 * whitespace, trim, cap at 16 chars. Returns '' when nothing valid (≥ 2 chars) is left, and a fun
 * stand-in (see FUN_NAMES) when the name trips the profanity filter.
 */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFC').replace(/\s+/g, ' ');
  s = s.replace(DISALLOWED, '');
  s = s.replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX).trimEnd();
  if (s.length < NAME_MIN || !ALNUM.test(s)) return '';
  // Check the raw input too: stripped characters may have been leetspeak ('b!tch').
  if (isProfane(s) || isProfane(name)) return randomClimberName(fnv1a(s.toLowerCase()));
  return s;
}

/** True for a name that is already clean: sanitizeName(name) === name. */
export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && VALID.test(name) && name === name.trim() && !/ {2}/.test(name) && ALNUM.test(name) && !isProfane(name);
}

/**
 * Names that come back from a shared backend (written by other players). Returns a displayable
 * name, or null when the value is unusable. Profane names are swapped for a stable stand-in.
 */
export function cleanRemoteName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const s = sanitizeName(name);
  return s === '' ? null : s;
}

// ───────────────────────────── tiny profanity filter ─────────────────────────────
// Deliberately short: catches the obvious stuff (EN/DE/FR/IT, basic leetspeak, stretched letters,
// spacing tricks) without a giant list. Long, unambiguous stems match anywhere; short ones only as
// whole words so "Scunthorpe"-style false positives stay rare ("Classic", "Dickens", "Fickle").

const STEMS = [
  'fuck', 'fck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'bitch', 'hitler',
  'rapist', 'twat', 'dildo', 'penis', 'vagina', 'porn', 'arschloch', 'fotze', 'wichser',
  'hurensohn', 'schlampe', 'ficken', 'scheisse', 'missgeburt', 'merde', 'putain', 'cazzo', 'stronzo',
];
const WORDS = new Set([
  'ass', 'arse', 'dick', 'cock', 'tit', 'tits', 'fag', 'rape', 'pedo', 'nazi', 'fick', 'puta',
  'wank', 'kkk', 'sex', 'cum', 'jizz', 'anal', 'anus', 'piss', 'hure', 'arsch', 'nazis',
]);
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't' };

const collapseRuns = (s: string): string => s.replace(/(.)\1+/g, '$1');

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[0-9@$!+]/g, (c) => LEET[c] ?? c);
}

/** True when the name contains an obvious slur / obscenity. */
export function isProfane(name: string): boolean {
  const folded = fold(name);
  const compact = folded.replace(/[^a-z]/g, '');
  const compactCollapsed = collapseRuns(compact);
  for (const w of STEMS) {
    if (compact.includes(w)) return true;
    if (collapseRuns(w) === w && compactCollapsed.includes(w)) return true;
  }
  const tokens = folded.split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) {
    if (WORDS.has(t) || WORDS.has(collapseRuns(t))) return true;
  }
  // "a s s" / "a.s.s" spelled out with separators.
  if (tokens.length > 1 && tokens.every((t) => t.length === 1) && (WORDS.has(compact) || WORDS.has(compactCollapsed))) return true;
  return false;
}

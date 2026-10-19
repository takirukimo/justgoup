// Start over (Settings): forget everything this device keeps about the player, so the next launch
// is a first launch again (splash → Steini's intro → name → tutorial). Only local data goes: the
// global boards (Supabase / the claude.ai shared board) are never touched, the device id stays (it
// keys the player's rows there), and scores still queued for those boards (the outbox) still go out.

import { LOCAL_KEYS } from './local';
import { freezeProfileSaves, PROFILE_KEY } from './profile';
import { kv, type KVStore } from './storage';

/** Every local key that holds progress, settings, drafts or this device's own boards. */
export const START_OVER_KEYS: readonly string[] = [
  PROFILE_KEY, // name, settings, unlocks, bests, stats, saved problems, intro / tutorial seen
  'jgu.pure.v1', // Pure climbing (fallback copy of the setting)
  'jgu.editor.draft', // the editor's working draft
  'jgu.editor.prefs', // editor snap / sample choices
  'jgu.editor.intro', // the editor's first-open tips
  LOCAL_KEYS.scores, // the offline leaderboards on this device
  LOCAL_KEYS.problems, // problems published offline on this device
  LOCAL_KEYS.stats, // attempts / sends on those problems
];

/**
 * Wipe the device's progress and stop profile saves until the page reloads (call
 * freezeProfileSaves(false) to keep running without a reload). Never throws.
 */
export function wipeLocalProgress(store: KVStore = kv): void {
  freezeProfileSaves(true);
  for (const k of START_OVER_KEYS) {
    try {
      store.remove(k);
    } catch {
      /* storage blocked: nothing to wipe */
    }
  }
}

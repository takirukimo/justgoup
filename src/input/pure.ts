// Pure mode (ROADMAP Phase D) — one app-wide flag. When on, the HUD hides (GameUI) and the limb
// handles stay invisible until a finger lands near a hand or foot, which then shows only a faint ring
// (LimbControls); no reach envelope, labels, reticles or hold highlights. The climber's body is the
// feedback (render/climber.ts reads the cue gain), and the renderer's thin-hold shading takes over
// from the yellow-paint highlights.
//
// The player's choice is `Settings.pure` ("Pure climbing" in Settings; SettingsExt below until the
// shared Settings type carries the field), applied live by the app through setPureMode(). A scripted
// lesson can suspend it (suspendPure) without touching the setting: the tutorial teaches with the
// full HUD and Pure mode comes back the moment it ends. `?pure=1` forces it on for testing.

import type { Settings } from '../core/types';

type Listener = (on: boolean) => void;

/** Settings plus the optional Pure-mode choice (persisted in the profile's settings). */
export type SettingsExt = Settings & { pure?: boolean };

const listeners = new Set<Listener>();

/** Fallback key: the profile's settings validation may drop fields it doesn't know yet. */
const STORE_KEY = 'jgu.pure.v1';

function fromUrl(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('pure') === '1';
  } catch {
    return false;
  }
}

const forced = fromUrl();
/** The player's setting (or the URL override). */
let chosen = forced;
/** Reasons Pure mode is suspended right now (e.g. 'tutorial'). */
const suspended = new Set<string>();
let effective = chosen;

function publish(): void {
  const v = chosen && suspended.size === 0;
  if (v === effective) return;
  effective = v;
  for (const fn of [...listeners]) {
    try {
      fn(v);
    } catch (err) {
      console.error('[pure] listener threw', err);
    }
  }
}

/** Current (effective) Pure-mode flag: chosen and not suspended. */
export function isPureMode(): boolean {
  return effective;
}

/** The player's choice, regardless of a suspension. */
export function pureChosen(): boolean {
  return chosen;
}

/** Turn Pure mode on / off (the player's setting); subscribers (HUD, limb controls, renderer) update at once. */
export function setPureMode(on: boolean): void {
  chosen = !!on || forced;
  publish();
}

/**
 * Suspend Pure mode for a reason (true) or lift that suspension (false). While any suspension is
 * active the effective flag is off; the player's setting is untouched.
 */
export function suspendPure(reason: string, on: boolean): void {
  if (on) suspended.add(reason);
  else suspended.delete(reason);
  publish();
}

/** Subscribe to Pure-mode changes (called with the current value right away). Returns an unsubscribe. */
export function onPureMode(fn: Listener): () => void {
  listeners.add(fn);
  fn(effective);
  return () => listeners.delete(fn);
}

/** The Pure-mode choice carried by a Settings object (false when absent). */
export function pureOf(s: Settings): boolean {
  return (s as SettingsExt).pure === true;
}

/** Last stored choice from the fallback key, or null when nothing was stored (or storage is blocked). */
export function readStoredPure(): boolean | null {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Mirror the choice into the fallback key (best effort). */
export function storePure(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, on ? '1' : '0');
  } catch {
    /* storage blocked: the profile copy is all we have */
  }
}

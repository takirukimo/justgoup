// Pure mode (ROADMAP Phase D) — one app-wide flag. When on, the HUD hides (GameUI) and the limb
// handles stay invisible until a finger lands near a hand or foot, which then shows only a faint ring
// (LimbControls); no reach envelope, labels, reticles or hold highlights. The climber's body is the
// feedback. No settings UI yet: the app (or `?pure=1` for testing) flips it with setPureMode().

type Listener = (on: boolean) => void;

const listeners = new Set<Listener>();

function fromUrl(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('pure') === '1';
  } catch {
    return false;
  }
}

let pure = fromUrl();

/** Current Pure-mode flag. */
export function isPureMode(): boolean {
  return pure;
}

/** Turn Pure mode on / off; subscribers (HUD, limb controls) update at once. */
export function setPureMode(on: boolean): void {
  const v = !!on;
  if (v === pure) return;
  pure = v;
  for (const fn of [...listeners]) {
    try {
      fn(v);
    } catch (err) {
      console.error('[pure] listener threw', err);
    }
  }
}

/** Subscribe to Pure-mode changes (called with the current value right away). Returns an unsubscribe. */
export function onPureMode(fn: Listener): () => void {
  listeners.add(fn);
  fn(pure);
  return () => listeners.delete(fn);
}

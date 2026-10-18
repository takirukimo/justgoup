// Mobile browser glue that belongs to no game module:
//
//   back button   Android's back button (and iOS Safari's edge swipe) pops the session history.
//                 A guard entry turns that pop into the game's own "back" intent, which is exactly
//                 what Escape means everywhere in the UI (close a dialog, pause a live climb,
//                 resume from the pause sheet, leave a menu screen). On the title screen the pop is
//                 let through, so back leaves the game like any Android app.
//   gestures      iOS Safari ignores user-scalable=no: its proprietary pinch events are cancelled
//                 (the editor's own pointer pinch still works), and long-press context menus are
//                 suppressed outside text fields (double-tap zoom is off via touch-action: none).
//
// Only a top-level page arms the history guard: inside an embedding frame (a claude.ai Artifact)
// pushState would add entries to the host page's history and hijack its back button.

import { claudeRuntime } from '../net/artifact-types';

export interface BackButtonOptions {
  /** True where back should leave the game (title screen). */
  atRoot(): boolean;
  /** The game's back intent. */
  onBack(): void;
}

function isTopLevel(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false; // cross-origin parent: we are embedded
  }
}

/** Install the back-button guard. Returns an uninstall function (no-op when not applicable). */
export function installBackButton(opts: BackButtonOptions): () => void {
  if (typeof history === 'undefined' || typeof history.pushState !== 'function') return () => undefined;
  if (!isTopLevel() || claudeRuntime()) return () => undefined;
  let armed = false;
  // Chrome skips history entries a page adds without a user activation, so the guard is (re)armed
  // from activation-granting input (pointerup / touchend / keydown), never from popstate alone.
  const arm = (): void => {
    if (armed) return;
    try {
      history.pushState({ jguBackGuard: true }, '');
      armed = true;
    } catch {
      /* history blocked (sandbox): back simply leaves */
    }
  };
  const onPop = (): void => {
    if (!armed) return;
    armed = false;
    if (opts.atRoot()) return; // let the next back leave the page
    try {
      opts.onBack();
    } catch (err) {
      console.warn('[app] back handler failed', err);
    }
    arm();
  };
  const input = { capture: true, passive: true } as const;
  window.addEventListener('popstate', onPop);
  document.addEventListener('pointerup', arm, input);
  document.addEventListener('touchend', arm, input);
  document.addEventListener('keydown', arm, input);
  return () => {
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('pointerup', arm, input);
    document.removeEventListener('touchend', arm, input);
    document.removeEventListener('keydown', arm, input);
  };
}

/** The UI's universal back: the same path a hardware Escape key takes. */
export function emitBackIntent(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''));
};

/** Cancel browser gestures that fight a full-screen touch game. Returns an uninstall function. */
export function suppressBrowserGestures(doc: Document = document): () => void {
  const cancel = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  const noMenu = (e: Event): void => {
    if (!isEditable(e.target)) cancel(e);
  };
  const active = { passive: false } as const;
  // WebKit-only pinch events (iOS Safari zooms the page despite the viewport meta)
  doc.addEventListener('gesturestart', cancel, active);
  doc.addEventListener('gesturechange', cancel, active);
  // long-press menus ("save image", "copy") on portraits, canvas and buttons
  doc.addEventListener('contextmenu', noMenu, active);
  return () => {
    doc.removeEventListener('gesturestart', cancel);
    doc.removeEventListener('gesturechange', cancel);
    doc.removeEventListener('contextmenu', noMenu);
  };
}

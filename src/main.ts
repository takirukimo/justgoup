// JUST GO UP — entry point. Boots every subsystem, runs the frame loop and hands control to the
// App state machine (src/app/app.ts).

import { GameRenderer } from './render/renderer';
import { LimbControls } from './input/limb-controls';
import { GameUI } from './ui/ui';
import { GameAudio } from './audio/audio';
import { BoulderEditor } from './editor/editor';
import { createBackend } from './net/backend';
import { flushProfile, loadProfile } from './net/profile';
import type { BackendAPI } from './core/contracts';
import { bus } from './core/events';
import type { QualityLevel } from './core/types';
import { App } from './app/app';
import { ProblemFactory } from './app/gen';
import { GraphicsLostCard, HintGhost, showFatalError, Veil } from './app/overlays';
import { emitBackIntent, installBackButton, suppressBrowserGestures } from './app/lifecycle';

declare global {
  interface Window {
    __jgu?: {
      app: App;
      renderer: GameRenderer;
      ui: GameUI;
      audio: GameAudio;
      controls: LimbControls;
      editor: BoulderEditor;
      bus: typeof bus;
      readonly backend: BackendAPI | null;
      /** ms from createBackend() to the chosen backend (QA). */
      readonly backendMs: number | null;
      readonly sim: App['sim'];
      readonly frames: number;
      readonly fps: number;
    };
  }
}

const qs = new URLSearchParams(location.search);
const DEBUG = import.meta.env.DEV || qs.get('debug') === '1';
/** Debug-only simulation time scale (headless QA runs at a few fps). */
const TIME_SCALE = DEBUG ? Math.max(0.25, Math.min(8, Number(qs.get('ts') ?? 1) || 1)) : 1;
const FORCED_Q = DEBUG ? qs.get('q') : null;

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing from index.html`);
  return e as T;
};

async function boot(): Promise<void> {
  const host = $<HTMLDivElement>('app');
  const canvas = $<HTMLCanvasElement>('gl');
  const controlsEl = $<HTMLDivElement>('controls');
  const uiEl = $<HTMLDivElement>('ui');
  const bootEl = document.getElementById('boot');

  const fatal = (err: unknown, ctx?: string): void => {
    console.error('[jgu] fatal', err);
    flushProfile();
    showFatalError(host, err, ctx);
    bootEl?.remove();
  };

  let renderer: GameRenderer;
  const profile = loadProfile();
  if (FORCED_Q === 'low' || FORCED_Q === 'medium' || FORCED_Q === 'high') profile.settings = { ...profile.settings, quality: FORCED_Q as QualityLevel };
  try {
    const q = profile.settings.quality;
    renderer = new GameRenderer(canvas, q === 'auto' ? {} : { quality: q });
  } catch (err) {
    fatal(err, 'This device could not start WebGL, which the CHIRAL wall needs.');
    return;
  }

  // the backend probes (≤ ~3 s) run while the scene builds
  const backendT0 = performance.now();
  const backend = createBackend();

  const ui = new GameUI();
  ui.mount(uiEl);
  stray.ui = ui;
  ui.setPortraitProvider((h) => renderer.portrait(h, 256));
  ui.setSettings(profile.settings);
  const controls = new LimbControls(controlsEl, renderer);
  const audio = new GameAudio();
  // Create + resume the AudioContext synchronously inside the very first gesture (iOS only lets
  // audio start from within a user-gesture handler); app.start() awaits the same unlock later.
  const firstGesture = (): void => {
    for (const t of GESTURES) document.removeEventListener(t, firstGesture, true);
    void audio.unlock();
  };
  for (const t of GESTURES) document.addEventListener(t, firstGesture, true);
  suppressBrowserGestures(document);
  const gen = new ProblemFactory();
  const veil = new Veil(host);
  const ghost = new HintGhost(host, controlsEl);

  try {
    await renderer.init();
  } catch (err) {
    fatal(err, 'The 3D scene could not be built on this device.');
    return;
  }

  const app = new App({
    services: { renderer, controls, ui, audio, gen, veil, ghost, host, timeScale: TIME_SCALE },
    profile,
    backend,
    createEditor: () => new BoulderEditor(uiEl, renderer, ui),
  });
  app.boot();

  // ── frame loop ──
  let last = performance.now();
  let frames = 0;
  let fps = 60;
  let errors = 0;
  let stopped = false;
  const loop = (now: number): void => {
    if (stopped) return;
    requestAnimationFrame(loop);
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.1, Math.max(0, raw));
    if (raw > 0) fps += (Math.min(240, 1 / raw) - fps) * 0.05;
    try {
      app.frame(dt);
      renderer.frame(dt);
      app.postFrame(dt);
      errors = 0;
    } catch (err) {
      console.error('[jgu] frame failed', err);
      if (++errors > 30) {
        stopped = true;
        fatal(err);
      }
    }
    if (++frames === 1 && bootEl) {
      bootEl.style.opacity = '0';
      bootEl.style.pointerEvents = 'none';
      setTimeout(() => bootEl.remove(), 650);
    }
  };
  requestAnimationFrame((t) => {
    last = t;
    loop(t);
  });

  // ── lifecycle ──
  // backgrounded (tab switch, home button, incoming call): pause the climb, silence, save
  const toBackground = (): void => {
    app.onHidden();
    audio.suspend();
    flushProfile();
    // an editor draft edited in the last few hundred ms is still waiting for its debounced autosave
    try {
      app.editor.flush();
    } catch (err) {
      console.warn('[jgu] editor flush failed', err);
    }
  };
  const toForeground = (): void => {
    if (document.hidden) return;
    audio.resume();
    last = performance.now();
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? toBackground() : toForeground()));
  window.addEventListener('pagehide', toBackground);
  // back/forward cache restore: the page comes back without a reload
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) toForeground();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => renderer.resize()).observe(host);
  // a phone turned sideways shows the "turn upright" card (index.html): don't climb blind under it
  const sideways = matchMedia(SIDEWAYS_QUERY);
  sideways.addEventListener?.('change', (e) => {
    if (e.matches) app.onHidden();
  });

  // WebGL context loss (memory pressure, GPU reset, long background stays on iOS)
  const lostCard = new GraphicsLostCard(host);
  renderer.onContextChange((lost) => {
    if (lost) {
      console.warn('[jgu] WebGL context lost; waiting for the browser to restore it');
      app.onHidden();
      flushProfile();
      lostCard.show();
    } else {
      console.info('[jgu] WebGL context restored');
      lostCard.hide();
      last = performance.now();
      // portraits rendered while the context was gone fell back to flat emblems: re-render them
      ui.setPortraitProvider((h) => renderer.portrait(h, 256));
    }
  });

  // Android back button / iOS edge swipe → the game's back (pause, close, leave a screen)
  installBackButton({
    atRoot: () => app.current === 'menu' && ui.current === 'title',
    onBack: () => {
      if (lostCard.shown) return;
      emitBackIntent();
    },
  });

  if (DEBUG) {
    let backendRef: BackendAPI | null = null;
    let backendMs: number | null = null;
    void backend.then((b) => {
      backendRef = b;
      backendMs = performance.now() - backendT0;
    });
    window.__jgu = {
      app,
      renderer,
      ui,
      audio,
      controls,
      editor: app.editor,
      bus,
      get backend() {
        return backendRef;
      },
      get backendMs() {
        return backendMs;
      },
      get sim() {
        return app.sim;
      },
      get frames() {
        return frames;
      },
      get fps() {
        return fps;
      },
    };
  }

  await app.start();
}

const GESTURES = ['touchend', 'pointerup', 'click', 'keydown'] as const;
/** Keep in sync with the #rotate card's media query in index.html. */
const SIDEWAYS_QUERY = '(orientation: landscape) and (pointer: coarse) and (max-height: 540px)';

// Last-resort error reporting: anything that escaped its own catch gets logged and one calm toast
// (rate-limited); the frame loop and boot have their own fatal paths.
let lastErrorToast = 0;
function reportStray(kind: string, reason: unknown): void {
  console.error(`[jgu] ${kind}`, reason);
  const now = performance.now();
  const ui = stray.ui;
  if (!ui || now - lastErrorToast < 8000) return;
  lastErrorToast = now;
  try {
    ui.hud.toast('SOMETHING SLIPPED · KEEP CLIMBING');
  } catch {
    /* the UI itself is gone */
  }
}
const stray: { ui: GameUI | null } = { ui: null };
window.addEventListener('unhandledrejection', (e) => reportStray('unhandled rejection', e.reason));
window.addEventListener('error', (e) => {
  // resource load errors (fonts, icons) arrive here too without an error object: not ours to report
  if (e.error === undefined && !e.message) return;
  reportStray('uncaught error', e.error ?? e.message);
});

boot().catch((err: unknown) => {
  console.error('[jgu] boot failed', err);
  const host = document.getElementById('app');
  if (host) showFatalError(host, err);
  document.getElementById('boot')?.remove();
});

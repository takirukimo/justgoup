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
import { HintGhost, showFatalError, Veil } from './app/overlays';

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
  const backend = createBackend();

  const ui = new GameUI();
  ui.mount(uiEl);
  ui.setPortraitProvider((h) => renderer.portrait(h, 256));
  ui.setSettings(profile.settings);
  const controls = new LimbControls(controlsEl, renderer);
  const audio = new GameAudio();
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      app.onHidden();
      audio.suspend();
      flushProfile();
    } else {
      audio.resume();
      last = performance.now();
    }
  });
  window.addEventListener('pagehide', () => flushProfile());
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => renderer.resize()).observe(host);

  if (DEBUG) {
    let backendRef: BackendAPI | null = null;
    void backend.then((b) => (backendRef = b));
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

window.addEventListener('unhandledrejection', (e) => {
  console.error('[jgu] unhandled rejection', e.reason);
});

boot().catch((err: unknown) => {
  console.error('[jgu] boot failed', err);
  const host = document.getElementById('app');
  if (host) showFatalError(host, err);
  document.getElementById('boot')?.remove();
});

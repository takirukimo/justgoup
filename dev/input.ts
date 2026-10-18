// INPUT dev harness: a playable sandbox with the real GameRenderer + ClimberSim + LimbControls.
// Not part of the shipped build.
//
// URL params:
//   seed=<n> grade=<0..12> mode=boulder|rope|tutorial   angle=<deg> (override)
//   q=low|medium|high   assist=0 (hide labels/arcs)   allow=RH,LF (tutorial gating)   hips=0|1
//   invincible=1   fixed=1 (fixed 1/60 dt)   dev=0 (hide the dev HUD bands)
//   style=<RouteStyle> (generator archetype, e.g. dyno)   pure=1 (Pure mode: invisible handles)

import { GameRenderer } from '../src/render/renderer';
import { LimbControls } from '../src/input/limb-controls';
import { ClimberSim, RopeSystem, generateBoulder, generateRopeRoute, gradeLabel, tutorialBoulder } from '../src/game';
import { bus } from '../src/core/events';
import type { BoulderDef, LimbId, QualityLevel, RouteStyle } from '../src/core/types';
import * as game from '../src/game';
import type { SimEvent } from '../src/core/contracts';

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (qs.has(k) && qs.get(k) !== '' ? Number(qs.get(k)) : d);
const mode = qs.get('mode') ?? 'boulder';
let seed = num('seed', 3);
const grade = num('grade', 2);
const fixed = qs.get('fixed') === '1';
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
if (qs.get('dev') === '0') $('dev').classList.add('hide');

const canvas = $('gl') as HTMLCanvasElement;
const renderer = new GameRenderer(canvas, { quality: (qs.get('q') as QualityLevel | null) ?? 'medium' });
const controls = new LimbControls($('controls'), renderer);
if (qs.get('assist') === '0') controls.setAssist(false);
if (qs.has('allow')) {
  const limbs = (qs.get('allow') as string).split(',').filter(Boolean) as LimbId[];
  controls.setAllowed(limbs, qs.get('hips') === '1');
} else if (qs.get('hips') === '0') controls.setAllowed('all', false);

let sim: ClimberSim;
let rope: RopeSystem | null = null;
let restartAt = -1;
let clock = 0;
let frames = 0;
const log: string[] = [];

function makeBoulder(): BoulderDef {
  let b: BoulderDef;
  if (mode === 'tutorial') b = tutorialBoulder();
  else if (mode === 'rope') b = generateRopeRoute({ seed, grade });
  else b = generateBoulder({ seed, grade, ...(qs.get('style') ? { style: qs.get('style') as RouteStyle } : {}) });
  if (qs.has('angle')) b = { ...b, wallAngle: num('angle', b.wallAngle) };
  return b;
}

function load(): void {
  const b = makeBoulder();
  sim = new ClimberSim(b, { assist: mode === 'tutorial' ? 1 : 0, invincible: qs.get('invincible') === '1' });
  rope = b.mode === 'rope' ? new RopeSystem(b) : null;
  renderer.loadBoulder(b);
  renderer.setRope(null, []);
  renderer.setGuide(rope ? { x: rope.belayer().x, depth: 1.3, pose: 'belay' } : null);
  controls.bind(sim);
  sim.start();
  renderer.setCameraMode('follow', { instant: true });
  restartAt = -1;
  $('name').textContent = `${b.name} · ${gradeLabel(b.grade)}`;
  $('meta').textContent = `CHIRAL HQ · INPUT LAB · ${b.mode === 'rope' ? 'LEAD' : 'BOULDER'} ${b.wallAngle > 0 ? '+' : ''}${b.wallAngle}° · SEED ${seed}`;
}

function pushLog(s: string): void {
  log.unshift(s);
  if (log.length > 3) log.length = 3;
  $('log').textContent = log.join('\n');
}

function describe(e: SimEvent): string {
  switch (e.type) {
    case 'grab':
      return `GRAB ${e.limb} ${e.holdId} q${e.quality.toFixed(2)}`;
    case 'release':
    case 'return':
      return `${e.type.toUpperCase()} ${e.limb}`;
    case 'smear':
    case 'overload':
    case 'top-touch':
      return `${e.type.toUpperCase()} ${e.limb}`;
    case 'slip':
      return `SLIP ${e.limb}`;
    case 'fall':
      return `FALL ${e.reason}`;
    case 'clip':
    case 'clip-done':
      return `${e.type.toUpperCase()} ${e.quickdrawId}`;
    default:
      return e.type.toUpperCase();
  }
}

// The session (app) would normally listen here: audio, fx, scoring, rope bookkeeping.
bus.on('sim:event', (e) => {
  pushLog(describe(e));
  if (e.type === 'clip-done' && rope) rope.clip(e.quickdrawId);
  if (e.type === 'grab') renderer.fx.chalkPuff(sim.getState().limbs[e.limb].pos, 0.6);
  if (e.type === 'fall' || e.type === 'top' || e.type === 'ground-fall') restartAt = clock + (e.type === 'top' ? 2.6 : 2.2);
  if (e.type === 'top') renderer.fx.confetti(sim.getState().com);
});
bus.on('input:blocked', (e) => pushLog(`BLOCKED ${e.limb}`));

// QA: every bus message this harness cares about, in order (read by scripts/input-check.mjs)
const qaEvents: { type: string; payload?: unknown }[] = [];
for (const type of ['sim:event', 'input:drag-start', 'input:drag-move', 'input:drag-end', 'input:hip-start', 'input:hip-end', 'input:blocked', 'input:dyno', 'ui:chalk'] as const) {
  bus.on(type, (payload: unknown) => {
    qaEvents.push({ type, payload });
    if (qaEvents.length > 6000) qaEvents.splice(0, 1000);
  });
}

const tensionBar = $('tension');
const pumpBar = $('pump');
let last = performance.now();

function frame(now: number): void {
  try {
    tick(now);
  } catch (err) {
    console.error('[input-lab] frame failed', err instanceof Error ? err.stack : err);
  }
  requestAnimationFrame(frame);
}

function tick(now: number): void {
  const dt = fixed ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
  last = now;
  clock += dt;
  const events = sim.step(dt);
  for (const e of events) bus.emit('sim:event', e);
  const state = sim.getState();
  if (rope) {
    const c = rope.catchParams(state.pelvis);
    sim.setRope(c.anchor, c.length);
    renderer.setRope(rope.ropePath(state.pelvis), rope.clipped);
  }
  const cam = state.phase === 'falling' || state.phase === 'landed' || state.phase === 'hanging' ? 'fall' : state.phase === 'topped' ? 'celebrate' : 'follow';
  if (renderer.cameraMode !== cam) renderer.setCameraMode(cam);
  renderer.updateClimber(state, dt);
  renderer.frame(dt);
  controls.update(state, dt);
  tensionBar.style.width = `${Math.min(100, (state.tension / 1.2) * 100)}%`;
  tensionBar.style.background = state.tension > 1 ? '#ff4545' : state.tension > 0.7 ? '#ffb23f' : '#4fd18b';
  pumpBar.style.width = `${state.pump * 100}%`;
  pumpBar.style.background = state.pump > 0.75 ? '#ff4545' : '#9ad4de';
  if (++frames === 12) window.__ready = true;
  (window as unknown as { __frames: number }).__frames = frames;
  if (restartAt > 0 && clock > restartAt) {
    if (state.phase === 'hanging' && rope) {
      sim.respawn({});
      renderer.setCameraMode('follow');
      restartAt = -1;
    } else load();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') load();
  if (e.key === 'n' || e.key === 'N') {
    seed++;
    load();
  }
});

declare global {
  interface Window {
    __sim: ClimberSim;
    __ctl: LimbControls;
    __renderer: GameRenderer;
    __ready: boolean;
    __load: (s?: number) => void;
    __events: { type: string; payload?: unknown }[];
  }
}

await renderer.init();
load();
window.__ctl = controls;
(window as unknown as { __bus: typeof bus; __game: typeof game }).__bus = bus;
(window as unknown as { __game: typeof game }).__game = game;
window.__renderer = renderer;
window.__events = qaEvents;
window.__load = (s?: number) => {
  if (typeof s === 'number') seed = s;
  load();
};
Object.defineProperty(window, '__sim', { get: () => sim, configurable: true });
requestAnimationFrame((t) => {
  last = t;
  frame(t);
});

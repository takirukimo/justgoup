// TUTORIAL dev harness: the real GameRenderer, ClimberSim, LimbControls, GameUI and GameAudio,
// wired with a minimal app loop, running Steini's intro and then the tutorial.
// Not part of the shipped build.
//
// URL params:
//   flow=both|intro|tutorial   (default both)      splash=1  wait for a tap on the splash first
//   q=low|medium|high          (default medium)    dev=1     tiny status readout
//   keep=1                     keep Steini on the mats after the tutorial
//   ts=<n>                     time scale: the harness drives the sim AND the script clock with
//                              game dt = frame dt × n (headless QA runs at 1–2 fps; ts=2 halves them)
//
// QA globals (dev/tutorial.check.mjs): __ready, __flow, __result, __status(), __plan(), __skip(),
// __sim, __ctl, __renderer.

import { GameRenderer } from '../src/render/renderer';
import { LimbControls } from '../src/input/limb-controls';
import { GameUI } from '../src/ui/ui';
import { GameAudio } from '../src/audio/audio';
import { ClimberSim } from '../src/game/climber-sim';
import { tutorialBoulder } from '../src/game/generator';
import { contactPoint, LIMB_INDEX } from '../src/game/holds';
import { bus } from '../src/core/events';
import type { SimEvent } from '../src/core/contracts';
import type { LimbId, QualityLevel, RunInfo } from '../src/core/types';
import { runIntro, runTutorial, TUTORIAL_SIM_OPTIONS, tutorialStatus, type TutorialStatus } from '../src/tutorial/tutorial';
import { Clock } from '../src/tutorial/scope';

const qs = new URLSearchParams(location.search);
const flow = qs.get('flow') ?? 'both';
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const devlog = $('devlog');
if (qs.get('dev') === '1') devlog.classList.remove('hide');

const canvas = $('gl') as HTMLCanvasElement;
const renderer = new GameRenderer(canvas, { quality: (qs.get('q') as QualityLevel | null) ?? 'medium' });
const controls = new LimbControls($('controls'), renderer);
const ui = new GameUI();
ui.mount($('ui'));
ui.setPortraitProvider((h) => renderer.portrait(h));
const audio = new GameAudio();
window.addEventListener('pointerdown', () => void audio.unlock(), { once: true, capture: true });

const boulder = tutorialBoulder();
let sim: ClimberSim | null = null;
let run: RunInfo = { mode: 'tutorial', score: 0, streak: 0, boulderName: boulder.name, grade: boulder.grade, hintsLeft: 0 };
let stage: 'splash' | 'intro' | 'tutorial' | 'done' = 'intro';
let result: string | null = null;
let skip: () => void = () => undefined;
let paused = false;
const timeScale = Math.max(0.25, Math.min(4, Number(qs.get('ts') ?? 1) || 1));
/** With a time scale the script runs on the harness loop (lock-step with the sim); otherwise on its own rAF clock. */
const scriptClock = timeScale !== 1 ? new Clock({ manual: true }) : undefined;

// the session's sfx/fx for sim events (what src/app would do), minus the send flow
bus.on('sim:event', (e: SimEvent) => {
  if (!sim) return;
  const st = sim.getState();
  switch (e.type) {
    case 'grab': {
      const hand = e.limb === 'LH' || e.limb === 'RH';
      audio.play(hand ? (e.quality < 0.4 ? 'grab-bad' : 'grab') : 'foot', { pan: Math.max(-1, Math.min(1, st.limbs[e.limb].pos.x / 2)) });
      if (hand) renderer.fx.chalkPuff(st.limbs[e.limb].pos, 0.6);
      break;
    }
    case 'smear':
      audio.play('smear');
      break;
    case 'shake-start':
      audio.play('strain', { volume: 0.6 });
      break;
    case 'top-touch':
      audio.play('top-touch');
      break;
  }
});
// QA trace: every bus message the tutorial reacts to, plus Steini's lines (read by the QA scripts)
const trace: string[] = [];
const T0 = performance.now();
const stamp = (): string => ((performance.now() - T0) / 1000).toFixed(1).padStart(6);
const traced = ['sim:event', 'input:drag-start', 'input:drag-end', 'input:hip-start', 'input:hip-end', 'input:blocked', 'tutorial:done'] as const;
for (const type of traced) {
  bus.on(type, (p: unknown) => {
    trace.push(`${stamp()} ${type} ${p ? JSON.stringify(p) : ''}`);
    if (trace.length > 600) trace.shift();
  });
}
const say = ui.guide.say.bind(ui.guide);
ui.guide.say = (line) => {
  trace.push(`${stamp()} SAY${line.waitForTap ? '[tap]' : ''} ${line.text}`);
  return say(line);
};
bus.on('ui:pause', () => (paused = true));
bus.on('ui:resume', () => (paused = false));

let last = performance.now();
let frames = 0;
let fps = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const gdt = dt * timeScale;
  try {
    if (sim && !paused) {
      for (let left = gdt; left > 1e-6; left -= 0.1) for (const e of sim.step(Math.min(0.1, left))) bus.emit('sim:event', e);
      const st = sim.getState();
      renderer.updateClimber(st, dt);
      controls.update(st, dt);
      ui.hud.update(st, run);
      audio.setIntensity(st.tension, st.pump);
    }
    scriptClock?.tick(gdt);
    renderer.frame(dt);
  } catch (err) {
    console.error('[tutorial-lab] frame failed', err instanceof Error ? err.stack : err);
  }
  if (dt > 0) fps += (1 / dt - fps) * 0.1;
  if (++frames === 8) window.__ready = true;
  if (qs.get('dev') === '1' && frames % 10 === 0) {
    const s = tutorialStatus();
    const st = sim?.getState();
    devlog.textContent = `${fps.toFixed(1)} FPS  ${stage.toUpperCase()}  ${s.phase}  step ${s.step + 1}/${s.total}  ${s.lesson ? `${s.lesson.teach}:${s.lesson.limb}→${s.lesson.holdId}` : ''}\n` +
      (st ? `T ${st.tension.toFixed(2)}  shake ${st.shake.toFixed(2)}  pump ${st.pump.toFixed(2)}  ${st.phase}` : '');
  }
  requestAnimationFrame(frame);
}

async function startTutorial(): Promise<void> {
  stage = 'tutorial';
  renderer.loadBoulder(boulder);
  sim = new ClimberSim(boulder, TUTORIAL_SIM_OPTIONS);
  controls.bind(sim);
  run = { ...run };
  ui.show('hud', { run });
  const skipSignal = new Promise<void>((res) => (skip = res));
  result = await runTutorial({ sim, renderer, controls, ui, audio, skipSignal, keepGuide: qs.get('keep') === '1', clock: scriptClock });
  stage = 'done';
  ui.hud.toast(result === 'done' ? 'TUTORIAL COMPLETE' : 'TUTORIAL SKIPPED');
}

async function main(): Promise<void> {
  await renderer.init();
  renderer.loadBoulder(boulder);
  renderer.setSkin('ibex', 'basalt', 'classic');
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
  if (qs.get('splash') === '1') {
    stage = 'splash';
    renderer.setCameraMode('title', { instant: true });
    ui.show('splash', {});
    await bus.wait('ui:start-intro-done');
    await audio.unlock();
  }
  ui.show('none', {});
  if (flow !== 'tutorial') {
    stage = 'intro';
    await runIntro({ renderer, ui, audio, clock: scriptClock });
  }
  if (flow !== 'intro') await startTutorial();
  else stage = 'done';
}

// ── QA helpers ──

interface Pt {
  x: number;
  y: number;
}
interface Plan {
  status: TutorialStatus;
  limb: LimbId | 'HIP';
  handle: Pt | null;
  /** Where the limb's endpoint (hips: pelvis) is on screen now. */
  from: Pt;
  /** Where it should go. */
  to: Pt;
  holdId: string;
  /** Live drag target of the controls (finger + grab offset) on screen, while this limb is dragged. */
  drag: Pt | null;
  /** Hold the sim would grab if the finger lifted now. */
  candidate: string | null;
}

function plan(): Plan | null {
  const s = tutorialStatus();
  if (!sim || !s.lesson) return null;
  const st = sim.getState();
  const h = sim.boulder.holds.find((x) => x.id === s.lesson!.holdId);
  if (!h) return null;
  const rect = canvas.getBoundingClientRect();
  const scr = (p: { x: number; y: number }, depth = 0): Pt => {
    const q = renderer.wallToScreen(p, depth);
    return { x: q.x + rect.left, y: q.y + rect.top };
  };
  const cr = $('controls').getBoundingClientRect();
  const hp = (l: LimbId | 'HIP'): Pt | null => {
    const p = controls.handlePosition(l);
    return p ? { x: p.x + cr.left, y: p.y + cr.top } : null;
  };
  // QA only: the controls' live wall-space drag target (a private field, read for aiming)
  const target = (controls as unknown as { target: { x: number; y: number } }).target;
  if (s.lesson.teach === 'hips') {
    const drag = controls.dragging === 'HIP' ? scr(target, st.pelvisDepth) : null;
    // weight shift: hips over the foot; stand-up beat: hips straight up
    const goal = s.beat === 'stand-up' ? { x: st.pelvis.x, y: st.pelvis.y + 0.3 } : { x: h.x, y: st.pelvis.y + 0.05 };
    return {
      status: s, limb: 'HIP', handle: hp('HIP'), from: scr(st.pelvis, st.pelvisDepth), to: scr(goal, st.pelvisDepth),
      holdId: h.id, drag, candidate: null,
    };
  }
  const limb = s.lesson.limb;
  const pair: LimbId = limb === 'LH' ? 'RH' : limb === 'RH' ? 'LH' : limb === 'LF' ? 'RF' : 'LF';
  const c = contactPoint(h, LIMB_INDEX[limb], st.limbs[pair].holdId === h.id, { x: 0, y: 0 });
  const dragging = controls.dragging === limb;
  return {
    status: s, limb, handle: hp(limb), from: scr(st.limbs[limb].pos, st.limbs[limb].depth), to: scr(c), holdId: h.id,
    drag: dragging ? scr(target) : null, candidate: dragging ? sim.snapCandidate(limb, target)?.id ?? null : null,
  };
}

declare global {
  interface Window {
    __ready: boolean;
    __flow: () => string;
    __result: () => string | null;
    __status: () => TutorialStatus;
    __plan: () => Plan | null;
    __skip: () => void;
    __sim: ClimberSim | null;
    __ctl: LimbControls;
    __renderer: GameRenderer;
    __bus: typeof bus;
    __trace: string[];
  }
}
window.__flow = () => stage;
window.__result = () => result;
window.__status = tutorialStatus;
window.__plan = plan;
window.__skip = () => skip();
window.__ctl = controls;
window.__renderer = renderer;
window.__bus = bus;
window.__trace = trace;
Object.defineProperty(window, '__sim', { get: () => sim, configurable: true });

main().catch((e) => console.error('[tutorial-lab] failed', e));

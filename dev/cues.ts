// Phase D harness (not shipped): the climber's body as feedback and the thin-hold shading, in the
// real GameRenderer on a real ClimberSim, with the state forced to a chosen moment.
//   ?pure=1          Pure mode (stronger body cues + hold cue)        ?cue=0  no within-reach hold cue
//   ?pump=0.9        both forearms' pump (pumpL / pumpR per hand)      ?fric=0.1 both hands' friction (fricL / fricR)
//   ?stress=1.2      hand stress (stressL / stressR; feet: stressF)    ?shake=0.6 per-foot Elvis leg + body shake
//   ?tension=0.9     overall tension (breathing rate, held breath)      ?t=3 seconds to run before the capture
//   ?cam=follow|hands|feet|holds   ?q=low|medium|high   ?wall=10 (deg)   ?hud=0   ?cueamp=4 (force the cue)
// window.__cues exposes { renderer, sim } for QA scripts; document.title reports the forced state.

import * as THREE from 'three';
import { GameRenderer } from '../src/render/renderer';
import type { BoulderDef, ClimberState, HoldDef, LimbId, QualityLevel } from '../src/core/types';
import { ClimberSim } from '../src/game/climber-sim';
import { HOLD_CUE } from '../src/render/shading';

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (qs.has(k) ? Number(qs.get(k)) : d);
const hudEl = document.getElementById('hud') as HTMLDivElement;
if (qs.get('hud') === '0') hudEl.classList.add('hide');

const C = '#2D9CDB';
let n = 0;
const hold = (x: number, y: number, type: HoldDef['type'], role: HoldDef['role'], extra: Partial<HoldDef> = {}): HoldDef => ({
  id: `h${n++}`,
  x,
  y,
  type,
  size: extra.size ?? (type === 'jug' ? 0.09 : type === 'foot' ? 0.035 : type === 'crimp' ? 0.05 : 0.06),
  angle: -Math.PI / 2,
  role,
  color: role === 'deco' ? '#8A6FD1' : C,
  seed: Math.round(x * 1000 + y * 77),
  ...extra,
});

function boulder(wall: number): BoulderDef {
  n = 0;
  return {
    id: 'cues',
    name: 'Sliver',
    grade: 5,
    mode: 'boulder',
    wallAngle: wall,
    width: 4.6,
    height: 4.5,
    color: C,
    seed: 7,
    holds: [
      hold(-0.26, 2.0, 'edge', 'start', { edgeDepthMm: 20 }),
      hold(0.24, 2.06, 'crimp', 'start', { edgeDepthMm: 12 }),
      hold(-0.2, 0.74, 'foot', 'foot', { shape: 'chip' }),
      hold(0.22, 0.8, 'foot', 'foot'),
      // within reach: the thin stuff the shading has to make readable
      hold(-0.55, 2.42, 'crimp', 'hand', { shape: 'micro', edgeDepthMm: 6 }),
      hold(0.05, 2.62, 'crimp', 'hand', { edgeDepthMm: 9 }),
      hold(0.52, 2.5, 'edge', 'hand', { shape: 'rail', edgeDepthMm: 14 }),
      hold(0.62, 1.92, 'pinch', 'hand', { angle: 0 }),
      hold(-0.7, 1.85, 'crimp', 'hand', { shape: 'micro', edgeDepthMm: 5, angle: -Math.PI }),
      hold(0.0, 1.4, 'sloper', 'hand', { lipAngle: -30 }),
      hold(-0.45, 1.25, 'foot', 'foot', { shape: 'chip' }),
      hold(0.5, 1.15, 'foot', 'foot', { size: 0.028 }),
      hold(-0.1, 1.05, 'crimp', 'foot', { shape: 'micro', edgeDepthMm: 6 }),
      hold(0.3, 3.0, 'pocket', 'hand', { fingers: 2 }),
      // out of reach (no cue): the same kinds higher up
      hold(-0.4, 3.55, 'crimp', 'hand', { shape: 'micro', edgeDepthMm: 6 }),
      hold(0.4, 3.75, 'edge', 'hand', { shape: 'rail', edgeDepthMm: 14 }),
      hold(0.05, 4.1, 'jug', 'top'),
      // another route (deco)
      hold(-1.2, 2.2, 'crimp', 'deco', { edgeDepthMm: 8 }),
      hold(1.15, 2.4, 'edge', 'deco', { edgeDepthMm: 16 }),
      hold(1.0, 1.4, 'jug', 'deco'),
    ],
    startFeet: { LF: 'h2', RF: 'h3' },
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const q = (qs.get('q') ?? 'high') as QualityLevel;
  const r = new GameRenderer(canvas, { quality: q });
  await r.init();
  const b = boulder(num('wall', 10));
  r.loadBoulder(b);
  r.setSkin('ibex', 'basalt', 'classic');
  const pure = qs.get('pure') === '1';
  r.setPure(pure);
  const sim = new ClimberSim(b, { invincible: true });
  sim.reset();
  sim.start();
  r.setCameraMode('follow', { instant: true });
  (window as unknown as { __cues: unknown }).__cues = { renderer: r, sim, HOLD_CUE };

  const pumpL = num('pumpL', num('pump', 0));
  const pumpR = num('pumpR', num('pump', 0));
  const fricL = num('fricL', num('fric', 1));
  const fricR = num('fricR', num('fric', 1));
  const stressL = qs.has('stressL') || qs.has('stress') ? num('stressL', num('stress', 0)) : null;
  const stressR = qs.has('stressR') || qs.has('stress') ? num('stressR', num('stress', 0)) : null;
  const stressF = qs.has('stressF') ? num('stressF', 0) : null;
  const shake = qs.has('shake') ? num('shake', 0) : null;
  const tension = qs.has('tension') ? num('tension', 0) : null;
  const force = (st: ClimberState): ClimberState => {
    const L = { ...st.limbs };
    const set = (id: LimbId, patch: Partial<ClimberState['limbs'][LimbId]>) => (L[id] = { ...L[id], ...patch });
    set('LH', { pump: pumpL, friction: fricL, ...(stressL !== null ? { stress: stressL } : {}) });
    set('RH', { pump: pumpR, friction: fricR, ...(stressR !== null ? { stress: stressR } : {}) });
    if (stressF !== null) {
      set('LF', { stress: stressF });
      set('RF', { stress: stressF });
    }
    if (shake !== null) {
      set('LF', { shake });
      set('RF', { shake: shake * 0.7 });
    }
    return {
      ...st,
      limbs: L,
      pump: Math.max(pumpL, pumpR),
      ...(tension !== null ? { tension } : {}),
      ...(shake !== null ? { shake: shake * 0.5 } : {}),
    };
  };

  const dt = 1 / 60;
  const until = num('t', 2.5);
  let t = 0;
  let k = 0;
  /** One sim step; the renderer draws every `every`-th step (with the time it covered). */
  const step = (every = 1): void => {
    sim.step(dt);
    r.updateClimber(force(sim.getState()), dt);
    t += dt;
    if (++k % every) return;
    if (qs.get('cue') === '0') HOLD_CUE.uCueAmt.value = 0;
    else if (qs.has('cueamp')) HOLD_CUE.uCueAmt.value = num('cueamp', 1);
    r.frame(dt * every);
  };
  // warm up (headless GPUs are slow: draw a frame every 10 steps)
  while (t < until) step(10);

  const cam = qs.get('cam') ?? 'follow';
  if (cam !== 'follow') {
    const st = sim.getState();
    const f = r.wallFrame;
    const at = (x: number, y: number, d: number) => f.toWorld({ x, y }, d);
    if (cam === 'hands') {
      // the right hand and forearm, from out to the right (the head stays out of the way)
      const c = at(st.limbs.RH.pos.x - 0.08, st.limbs.RH.pos.y - 0.12, 0.12);
      r.setDebugView(c.clone().add(new THREE.Vector3(0.55, 0.12, 0.62)), c, 38);
    } else if (cam === 'feet') {
      const c = at(st.pelvis.x, st.limbs.LF.pos.y + 0.15, 0.1);
      r.setDebugView(c.clone().add(new THREE.Vector3(0.3, 0.1, 1.5)), c, 40);
    } else if (cam === 'holds') {
      const c = at(0, 2.3, 0);
      r.setDebugView(c.clone().add(new THREE.Vector3(0.0, -0.35, 3.4)), c, 44);
    }
  }
  const st = sim.getState();
  const info = `pure ${pure} cue ${HOLD_CUE.uCueAmt.value.toFixed(2)} | pump ${pumpL}/${pumpR} fric ${fricL}/${fricR} stress ${stressL ?? '-'}/${stressR ?? '-'} shake ${shake ?? '-'} tension ${tension ?? st.tension.toFixed(2)} | ${q}`;
  document.title = info;
  hudEl.textContent = info;
  (window as unknown as { __cuesReady: boolean }).__cuesReady = true;
  const tick = (): void => {
    step();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

void main();

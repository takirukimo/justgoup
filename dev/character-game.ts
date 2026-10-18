// CHARACTER dev harness — `view=game`: the real GameRenderer + generator + ClimberSim driven by the
// BetaBot, so the climber is posed exactly as in the game.
//   mode=boulder|rope  seed  grade  angle  simt=<s fast-forward>  fall=<s>  cam=<CameraMode>
//   dbg=px,py,pz,lx,ly,lz[,fov]  head  cw  guide=1  hud=0  pause=1 (freeze after fast-forward)
//   profiles=1 (folded multi-angle walls)  style=<RouteStyle> (e.g. cave, overhang)

import * as THREE from 'three';
import { GameRenderer } from '../src/render/renderer';
import type { CameraMode, SimEvent } from '../src/core/contracts';
import type { BoulderDef, ColorwayId, HeadId, RouteStyle } from '../src/core/types';
import { generateBoulder, generateRopeRoute } from '../src/game/generator';
import { ClimberSim } from '../src/game/climber-sim';
import { BetaBot } from '../src/game/bot';
import { RopeSystem } from '../src/game/rope';

export async function runGame(canvas: HTMLCanvasElement, qs: URLSearchParams, hud: HTMLDivElement): Promise<void> {
  const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);
  const mode = (qs.get('mode') ?? 'boulder') as 'boulder' | 'rope';
  const seed = num('seed', 7);
  const grade = num('grade', 3);
  const angle = qs.has('angle') ? num('angle', 10) : undefined;
  const T0 = performance.now();
  const lap = (label: string) => console.log(`[character-game] ${label} ${(performance.now() - T0).toFixed(0)} ms`);
  const r = new GameRenderer(canvas, { quality: 'high' });
  await r.init();
  lap('init');
  const profiles = qs.has('profiles') ? qs.get('profiles') === '1' : undefined;
  const style = (qs.get('style') ?? undefined) as RouteStyle | undefined;
  const b: BoulderDef =
    mode === 'rope' ? generateRopeRoute({ seed, grade, mode, wallAngle: angle, profiles }) : generateBoulder({ seed, grade, mode, wallAngle: angle, profiles, style });
  console.log(`[character-game] wall ${b.wallAngle}° profile ${JSON.stringify(b.profile ?? null)}`);
  lap('generate');
  r.loadBoulder(b);
  lap('loadBoulder');
  r.setSkin((qs.get('head') ?? 'ibex') as HeadId, (qs.get('cw') ?? 'basalt') as ColorwayId, 'classic');
  const sim = new ClimberSim(b, { invincible: qs.get('inv') === '1' });
  sim.reset();
  const rope = mode === 'rope' ? new RopeSystem(b) : null;
  if (qs.get('guide') === '1' || rope) {
    const bl = rope ? rope.belayer() : { x: -1.2, y: 0 };
    r.setGuide({ x: bl.x, depth: 1.25, pose: rope ? 'belay' : 'wave', lookAt: { x: 0, y: 2 } });
  }
  lap('guide');
  const t0 = performance.now();
  const bot = qs.get('bot') === '0' ? null : new BetaBot(sim);
  console.log(`[character-game] bot plan ${(performance.now() - t0).toFixed(0)} ms`);
  sim.start();
  const cam = (qs.get('cam') ?? 'follow') as CameraMode;
  r.setCameraMode(cam, { instant: true });
  if (qs.has('dbg')) {
    const v = (qs.get('dbg') as string).split(',').map(Number);
    r.setDebugView(new THREE.Vector3(v[0], v[1], v[2]), new THREE.Vector3(v[3], v[4], v[5]), v[6] || 45);
  }
  const fallAt = qs.has('fall') ? num('fall', 0) : -1;
  let events: SimEvent[] = [];
  let simTime = 0;
  let celebrated = false;
  const dt = 1 / 60;
  const stepOnce = (render: boolean) => {
    bot?.update(dt, events);
    if (fallAt >= 0 && simTime >= fallAt && sim.getState().phase === 'climbing') sim.forceFall();
    if (rope) {
      const st0 = sim.getState();
      const c = rope.catchParams(st0.pelvis);
      sim.setRope(c.anchor, c.length);
    }
    events = sim.step(dt);
    for (const e of events) {
      if (e.type === 'clip-done' && rope) rope.clip(e.quickdrawId);
      if (e.type === 'top' && !celebrated) {
        celebrated = true;
        console.log(`[character-game] TOP at ${simTime.toFixed(2)} s`);
        if (qs.get('celebcam') === '1') r.setCameraMode('celebrate');
      }
    }
    simTime += dt;
    const st = sim.getState();
    if (qs.get('rest') !== '1') r.updateClimber(st, dt);
    if (rope) r.setRope(rope.ropePath(st.pelvis), rope.clipped);
    if (render) r.frame(dt);
  };
  const ff = num('simt', 0);
  const n = Math.round(ff / dt);
  for (let i = 0; i < n; i++) stepOnce(i > n - 6);
  lap('fast-forward');
  (window as unknown as Record<string, unknown>).__r = r;
  (window as unknown as Record<string, unknown>).__sim = sim;
  const pause = qs.get('pause') === '1';
  const tick = () => {
    if (!pause) stepOnce(true);
    else r.frame(dt);
    const st = sim.getState();
    if (qs.get('hud') !== '0') {
      const s = r.stats();
      hud.textContent = `${mode} ${b.wallAngle}° V${b.grade} t=${simTime.toFixed(1)} ${st.phase}\ncalls ${s.calls} tris ${(s.triangles / 1000).toFixed(0)}k  bot ${!bot ? 'off' : bot.done ? 'done' : bot.failed ? 'failed' : 'climbing'} moves ${bot ? bot.moves : 0}`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

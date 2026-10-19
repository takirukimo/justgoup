// CHARACTER dev harness (not shipped).
//   ?view=heads            lineup of all 9 heads (3×3)          &yaw=<deg> &spin=1
//   ?view=head&id=ibex     single head close-up                  &yaw=<deg> &pitch=<deg> &dist=<m>
//   ?view=portraits        renderPortrait() output grid
//   ?view=limits           anatomy QA: extreme / illegal poses, falls, crossovers (see character-limits.ts)
//   ?view=ref&id=ibex      the head next to assets/reference/ibex-reference.png (same 3/4 view)
//   ?view=tees             CHIRAL SPORTS tees (black / white / pink) front + back
//   ?view=tech&tech=heel   a Phase B technique done by the real sim, posed by the real renderer
//                          (heel toe flag backflag drop smear shake chalk deadpoint dyno pump; cam=follow|side|front|low)
//   ?t=<s>                 freeze the clock at t seconds (deterministic screenshots)

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { HeadId } from '../src/core/types';
import { HEADS } from '../src/config/skins';
import { createHead, setHeadBlink } from '../src/render/heads/index';
import { ClimberModel } from '../src/render/climber';
import { GuideModel } from '../src/render/guide';
import { WallFrame } from '../src/render/wall-frame';
import { renderPortrait } from '../src/render/portrait';
import { POSES, buildPoseScene, type PoseName, type PoseScene } from './character-poses';
import type { GuidePose } from '../src/core/contracts';
import type { ColorwayId, ChalkId } from '../src/core/types';

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);
const view = qs.get('view') ?? 'heads';
const freeze = qs.has('t') ? num('t', 0) : null;
const hud = document.getElementById('hud') as HTMLDivElement;
const labels = document.getElementById('labels') as HTMLDivElement;

const canvas = document.getElementById('gl') as HTMLCanvasElement;
if (view === 'game') void import('./character-game').then((m) => m.runGame(canvas, qs, hud));
else if (view === 'tech') void import('./character-tech').then((m) => m.runTech(canvas, qs, hud));
else if (view === 'limits') void import('./character-limits').then((m) => m.runLimits(canvas, qs, labels, hud));
else studio();

/** Studio views (heads, portraits, body, guide, climber poses) on a plain WebGLRenderer. */
function studio(): void {
const refView = view === 'ref';
if (refView) {
  // reference photo on the left half, the 3D head on the right half
  const img = document.createElement('img');
  img.src = '/assets/reference/ibex-reference.png';
  img.style.cssText = 'position:fixed;left:0;top:0;width:50%;height:100%;object-fit:cover;';
  document.body.appendChild(img);
  canvas.style.left = '50%';
  canvas.style.width = '50%';
}
const W = refView ? window.innerWidth / 2 : window.innerWidth;
const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
gl.setPixelRatio(Math.min(2, window.devicePixelRatio));
gl.setSize(W, window.innerHeight, false);
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.toneMapping = THREE.ACESFilmicToneMapping;
gl.toneMappingExposure = 1.0;
gl.shadowMap.enabled = true;
gl.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#14161a');
const pmrem = new THREE.PMREMGenerator(gl);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(30, W / window.innerHeight, 0.01, 100);

function studioLights(target: THREE.Vector3): void {
  const key = new THREE.DirectionalLight('#ffe2c4', 2.6);
  key.position.set(target.x + 1.2, target.y + 1.6, target.z + 1.6);
  key.target.position.copy(target);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -2;
  key.shadow.camera.right = 2;
  key.shadow.camera.top = 2;
  key.shadow.camera.bottom = -2;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  const fill = new THREE.DirectionalLight('#9cc3d6', 0.7);
  fill.position.set(target.x - 2, target.y + 0.4, target.z + 1);
  const rim = new THREE.DirectionalLight('#d4e8ff', 2.2);
  rim.position.set(target.x - 0.6, target.y + 1.2, target.z - 2);
  const rim2 = new THREE.DirectionalLight('#ffd0a8', 1.2);
  rim2.position.set(target.x + 1.8, target.y + 0.6, target.z - 1.5);
  scene.add(key, key.target, fill, rim, rim2, new THREE.HemisphereLight('#c8d2dc', '#2b2622', 0.35));
}

const heads: THREE.Group[] = [];
(window as unknown as Record<string, unknown>).__heads = heads;

function headsView(single: HeadId | null): void {
  const ids: HeadId[] = single ? [single] : (HEADS.map((h) => h.id) as HeadId[]);
  const cols = single ? 1 : 5;
  const sp = 0.62;
  ids.forEach((id, i) => {
    const h = createHead(id);
    const c = i % cols;
    const r = Math.floor(i / cols);
    h.position.set((c - (cols - 1) / 2) * sp, -r * sp * 1.05, 0);
    h.rotation.y = (num('yaw', 28) * Math.PI) / 180;
    h.rotation.x = (num('pitch', 0) * Math.PI) / 180;
    if (qs.has('hide')) for (const n of (qs.get('hide') as string).split(',')) { const o = h.getObjectByName(n); if (o) o.visible = false; }
    if (qs.get('wire') === '1') h.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.MeshStandardMaterial).wireframe = true; });
    scene.add(h);
    heads.push(h);
    if (!single) {
      const el = document.createElement('div');
      el.textContent = HEADS[i].name;
      labels.appendChild(el);
      (el as HTMLDivElement & { anchor?: THREE.Vector3 }).anchor = h.position.clone().add(new THREE.Vector3(0, -0.04, 0));
    }
  });
  const nRows = Math.ceil(ids.length / cols);
  const center = single ? new THREE.Vector3(0, 0.2, 0) : new THREE.Vector3(0, (-(nRows - 1) / 2) * sp * 1.05 + 0.24, 0);
  studioLights(center);
  if (single) {
    const d = num('dist', 1.2);
    camera.position.set(0, 0.24 + num('cy', 0), d);
    camera.lookAt(0, 0.22 + num('cy', 0), 0);
  } else {
    camera.fov = 30;
    // fit every column and row (heads with horns need ~0.75 m of height per row)
    const vf = Math.tan((camera.fov * Math.PI) / 360);
    const hf = vf * camera.aspect;
    const dist = Math.max((cols * sp) / 2 / hf, (nRows * sp * 1.15) / 2 / vf) + 0.3;
    camera.position.set(0, center.y + 0.05, num('dist', dist));
    camera.lookAt(center.x, center.y, 0);
  }
  camera.updateProjectionMatrix();
}

/** The head (on a neck stub) in the reference photo's 3/4 view, on a dusky backdrop. */
function refHead(id: HeadId): void {
  scene.background = new THREE.Color('#2a3140');
  const h = createHead(id);
  h.rotation.y = (num('yaw', 38) * Math.PI) / 180;
  h.rotation.x = (num('pitch', 6) * Math.PI) / 180;
  scene.add(h);
  heads.push(h);
  studioLights(new THREE.Vector3(0, 0.25, 0));
  applyCam([0.05, 0.42, 1.55, 0, 0.27, -0.05, 30]);
}

/** Free camera from ?cam=px,py,pz,lx,ly,lz[,fov] */
function applyCam(def: number[]): void {
  const v = qs.has('cam') ? (qs.get('cam') as string).split(',').map(Number) : def;
  camera.position.set(v[0], v[1], v[2]);
  camera.lookAt(v[3], v[4], v[5]);
  camera.fov = v[6] || 30;
  camera.updateProjectionMatrix();
}

function floor(): void {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: '#1f2124', roughness: 0.9 }));
  g.rotation.x = -Math.PI / 2;
  g.receiveShadow = true;
  scene.add(g);
}

const climbers: ClimberModel[] = [];
function bodyView(): void {
  floor();
  const c = new ClimberModel({ head: (qs.get('id') ?? 'ibex') as HeadId, colorway: (qs.get('cw') ?? 'basalt') as ColorwayId, chalk: (qs.get('chalk') ?? 'classic') as ChalkId });
  c.rotation.y = 0;
  if (qs.get('harness') === '1') c.setHarness(true);
  c.rotation.y = (num('yaw', 200) * Math.PI) / 180;
  scene.add(c);
  climbers.push(c);
  studioLights(new THREE.Vector3(0, 1, 0));
  applyCam([0, 1.1, 4.2, 0, 0.95, 0, 30]);
}

/** CHIRAL SPORTS tees: black / white / pink, each from the front and from the back. */
function teesView(): void {
  floor();
  const cws: ColorwayId[] = ['basalt', 'white', 'pink'];
  const sp = 0.62;
  const items: { cw: ColorwayId; yaw: number }[] = [];
  for (const cw of cws) items.push({ cw, yaw: 180 }, { cw, yaw: 0 });
  items.forEach((it, i) => {
    const x = (i - (items.length - 1) / 2) * sp;
    const c = new ClimberModel({ head: (qs.get('id') ?? 'ibex') as HeadId, colorway: it.cw, chalk: 'classic' });
    c.position.set(x, 0, 0);
    c.rotation.y = (it.yaw * Math.PI) / 180;
    scene.add(c);
    climbers.push(c);
    const el = document.createElement('div');
    el.textContent = `${it.cw} ${it.yaw === 180 ? 'front' : 'back'}`;
    labels.appendChild(el);
    (el as HTMLDivElement & { anchor?: THREE.Vector3 }).anchor = new THREE.Vector3(x, 0.98, 0.3);
  });
  studioLights(new THREE.Vector3(0, 1.3, 0));
  applyCam([0, 1.32, 5.2, 0, 1.3, 0, 22]);
}

function colorwaysView(): void {
  floor();
  const ids: ColorwayId[] = ['basalt', 'glacier', 'moss', 'ember', 'lichen', 'dune', 'alpenglow', 'aurora'];
  const chalks: ChalkId[] = ['classic', 'glacier', 'moss', 'ember', 'gold', 'classic', 'ember', 'glacier'];
  const heads: HeadId[] = ['ibex', 'marmot', 'chamois', 'goat', 'eagle', 'snowleopard', 'lynx', 'ram'];
  ids.forEach((cw, i) => {
    const c = new ClimberModel({ head: qs.get('mixed') === '1' ? heads[i] : 'ibex', colorway: cw, chalk: chalks[i] });
    c.position.set((i - 3.5) * 0.85, 0, 0);
    c.rotation.y = (num('yaw', 155) * Math.PI) / 180;
    if (qs.get('harness') === '1') c.setHarness(true);
    scene.add(c);
    climbers.push(c);
    const el = document.createElement('div');
    el.textContent = cw;
    labels.appendChild(el);
    (el as HTMLDivElement & { anchor?: THREE.Vector3 }).anchor = new THREE.Vector3((i - 3.5) * 0.85, 0.02, 0.4);
  });
  studioLights(new THREE.Vector3(0, 1, 0));
  applyCam([0, 1.3, 8.6, 0, 1.0, 0, 34]);
}

const guides: { m: GuideModel; pose: GuidePose; x: number; lookAt?: { x: number; y: number }; depth?: number }[] = [];
const gframe = new WallFrame(0);
function guideView(): void {
  floor();
  const poses: GuidePose[] = qs.has('pose') ? [qs.get('pose') as GuidePose] : ['idle', 'wave', 'point', 'clap', 'cheer', 'think', 'belay'];
  const sp = 0.95;
  poses.forEach((pose, i) => {
    const m = new GuideModel();
    const x = (i - (poses.length - 1) / 2) * sp;
    scene.add(m);
    guides.push({ m, pose, x });
    const el = document.createElement('div');
    el.textContent = pose;
    labels.appendChild(el);
    (el as HTMLDivElement & { anchor?: THREE.Vector3 }).anchor = new THREE.Vector3(x, 0.02, 1.6);
  });
  studioLights(new THREE.Vector3(0, 1, 1.5));
  const wide = poses.length > 1;
  applyCam(wide ? [0, 1.3, 9.5, 0, 1.0, 1.5, 34] : [0.3, 1.45, 4.2, 0, 1.15, 1.5, 30]);
}

/** Home screen: the climber steady on holds ~2 m up, Steini on the mats watching his chest. */
function homeView(): void {
  poseScene = buildPoseScene(scene, ['rest'], num('angle', 0));
  const st = poseScene.climbers[0];
  const g = new GuideModel();
  scene.add(g);
  const chest = { x: st.ox + 0.02, y: 2.55 };
  guides.push({ m: g, pose: 'idle', x: num('gx', -1.15), lookAt: chest, depth: num('gd', 1.7) });
  studioLights(new THREE.Vector3(0, 1.6, 0.8));
  applyCam([0.4, 1.25, 6.6, -0.45, 1.45, 0.6, 46]);
}

function portraitsView(): void {
  const host = document.getElementById('portraits') as HTMLDivElement;
  host.style.display = 'flex';
  canvas.style.display = 'none';
  const size = num('size', 256);
  const only = qs.get('only');
  for (const h of HEADS) {
    if (only && h.id !== only) continue;
    const fig = document.createElement('figure');
    if (only) fig.style.width = '100%';
    const img = document.createElement('img');
    const t0 = performance.now();
    img.src = renderPortrait(gl, h.id, size);
    console.log(`[portrait] ${h.id} ${(performance.now() - t0).toFixed(0)} ms`);
    const cap = document.createElement('figcaption');
    cap.textContent = h.name;
    fig.append(img, cap);
    host.appendChild(fig);
  }
  if (!only || only === 'guide') {
    // Steini's speech-bubble card: the white CHIRAL SPORTS INSTRUCTOR tee
    const fig = document.createElement('figure');
    if (only) fig.style.width = '100%';
    const img = document.createElement('img');
    img.src = renderPortrait(gl, 'ibex', size, 'instructor');
    const cap = document.createElement('figcaption');
    cap.textContent = 'Steini (instructor)';
    fig.append(img, cap);
    host.appendChild(fig);
  }
}

let poseScene: PoseScene | null = null;
function climberView(): void {
  const names: PoseName[] = qs.has('pose') ? [qs.get('pose') as PoseName] : POSES;
  poseScene = buildPoseScene(scene, names, num('angle', 0));
  (window as unknown as Record<string, unknown>).__poseScene = poseScene;
  studioLights(new THREE.Vector3(0, 1.6, 0.6));
  names.forEach((n, i) => {
    const el = document.createElement('div');
    el.textContent = n;
    labels.appendChild(el);
    (el as HTMLDivElement & { anchor?: THREE.Vector3 }).anchor = new THREE.Vector3((i - (names.length - 1) / 2) * 1.15, 0.32, 1.0);
  });
  const wide = names.length > 1;
  applyCam(wide ? [0, 1.9, 8.8, 0, 1.55, 0.3, 40] : [0.6, 1.9, 3.6, 0, 1.55, 0.3, 36]);
}

if (view === 'heads') headsView(null);
else if (view === 'climber') climberView();
else if (view === 'portraits') portraitsView();
else if (view === 'body') bodyView();
else if (view === 'guide') guideView();
else if (view === 'colorways') colorwaysView();
else if (view === 'tees') teesView();
else if (view === 'home') homeView();
else if (view === 'head') headsView((qs.get('id') ?? 'ibex') as HeadId);
else if (view === 'ref') refHead((qs.get('id') ?? 'ibex') as HeadId);

let t = 0;
let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t = freeze ?? t + dt;
  if (qs.get('spin') === '1') for (const h of heads) h.rotation.y = t * 0.6;
  const blink = qs.has('blink') ? num('blink', 0) : Math.max(0, 1 - Math.abs(((t % 3.2) - 0.1) / 0.08));
  for (const h of heads) setHeadBlink(h, blink);
  if (poseScene && (freeze === null || qs.get('step') === '1')) poseScene.tick(freeze === null ? dt : 1 / 60, t);
  for (const g of guides) g.m.setState({ x: g.x, depth: g.depth ?? 1.5, pose: g.pose, lookAt: g.lookAt ?? (g.pose === 'belay' ? { x: g.x + 0.3, y: 4 } : { x: g.x + 1.2, y: 2.2 }) }, gframe, freeze !== null ? (t === freeze && !(g.m as unknown as { initialized: boolean }).initialized ? 0 : 1 / 60) : dt);
  gl.render(scene, camera);
  // labels
  for (const el of Array.from(labels.children) as (HTMLDivElement & { anchor?: THREE.Vector3 })[]) {
    if (!el.anchor) continue;
    const p = el.anchor.clone().project(camera);
    el.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
    el.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
  }
  hud.textContent = `${view}  calls ${gl.info.render.calls}  tris ${(gl.info.render.triangles / 1000).toFixed(1)}k`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
}

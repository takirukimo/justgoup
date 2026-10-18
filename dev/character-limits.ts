// CHARACTER dev harness — `view=limits`: anatomy QA. Synthetic ClimberStates for extreme and
// deliberately ILLEGAL inputs (the body must still look anatomical, clamped), phase poses and
// self-collision cases, each rendered in its own viewports from the gameplay camera angle, a side
// camera and (optionally) from behind the wall (the climber's front, wall hidden).
//
//   poses=a,b,c     subset (default: all)          cams=game,side,wall (default game,side)
//   cols=<n>        pose cells per row             angle=<deg> wall angle (overhang +)
//   proxies=1       draw the collision proxies     nocol=1 self-collision off (A/B)
//   t=<s>           freeze the clock               targets=0 hide target markers
//   focus=upper|lower  frame only the upper body (head, arms) or the legs
//   window.__bench(n)  ms / limit evaluations / chain solves / contacts per pose() for each case
//   rig.diagnose(li)   (via window.__limits[i].m.rig) why a limb's target is (un)reachable

import * as THREE from 'three';
import type { ClimberPhase, ClimberState, LimbId, LimbSnapshot, Vec2 } from '../src/core/types';
import { BODY, SIM } from '../src/config/tuning';
import { ClimberModel } from '../src/render/climber';
import { RopeMesh } from '../src/render/rope-mesh';
import { WallFrame } from '../src/render/wall-frame';

export type LimitPose =
  | 'highstep'
  | 'frog'
  | 'dropknee'
  | 'crossover'
  | 'crossunder'
  | 'lowhand'
  | 'face'
  | 'matched'
  | 'feetmatch'
  | 'crouch'
  | 'ill-foot-up'
  | 'ill-hand-low'
  | 'ill-foot-cross'
  | 'falling'
  | 'landed'
  | 'hanging';

export const LIMIT_POSES: LimitPose[] = [
  'highstep', 'frog', 'dropknee', 'crossover', 'crossunder', 'lowhand', 'face', 'matched',
  'feetmatch', 'crouch', 'ill-foot-up', 'ill-hand-low', 'ill-foot-cross', 'falling', 'landed', 'hanging',
];

const LABEL: Record<LimitPose, string> = {
  highstep: 'high step (foot 0.3 m over hip, out)',
  frog: 'wide frog',
  dropknee: 'drop knee (foot crossed in)',
  crossover: 'crossover above head',
  crossunder: 'cross-under (arms cross)',
  lowhand: 'low hand at hip',
  face: 'hand by the face',
  matched: 'matched hands',
  feetmatch: 'both feet on one hold',
  crouch: 'tight crouch / rockover',
  'ill-foot-up': 'ILLEGAL foot above hip',
  'ill-hand-low': 'ILLEGAL hand below feet',
  'ill-foot-cross': 'ILLEGAL foot far across',
  falling: 'falling flail',
  landed: 'landed crouch',
  hanging: 'rope hang',
};

function limb(id: LimbId, pos: Vec2, anchor: Vec2, depth: number, extra: Partial<LimbSnapshot> = {}): LimbSnapshot {
  return {
    id, holdId: 'h', pos, anchor, depth, dragging: false, load: 0.3, stress: 0.4, capacity: 0.8,
    reachRatio: 0.7, smearing: false, shake: 0, busy: false, ...extra,
  };
}

/** Synthetic state for a pose at wall-local x offset `ox`. */
export function limitState(name: LimitPose, ox: number, t: number): ClimberState {
  let phase: ClimberPhase = 'climbing';
  let pelvis: Vec2 = { x: 0, y: 1.25 };
  let chest: Vec2 = { x: 0.02, y: 1.75 };
  let pd = 0.3;
  let lh: Vec2 = { x: -0.28, y: 2.05 };
  let rh: Vec2 = { x: 0.27, y: 2.15 };
  let lf: Vec2 = { x: -0.24, y: 0.72 };
  let rf: Vec2 = { x: 0.27, y: 0.82 };
  const ex: Partial<Record<LimbId, Partial<LimbSnapshot>>> = {};
  let vel: Vec2 = { x: 0, y: 0 };
  let yaw = 0;
  const free = (ids: LimbId[], depth: number) => {
    for (const id of ids) ex[id] = { holdId: null, depth };
  };
  switch (name) {
    case 'highstep':
      pelvis = { x: 0.05, y: 1.22 };
      chest = { x: 0.0, y: 1.72 };
      pd = 0.33;
      rf = { x: 0.52, y: 1.52 };
      lf = { x: -0.22, y: 0.62 };
      lh = { x: -0.3, y: 2.04 };
      rh = { x: 0.3, y: 2.14 };
      break;
    case 'frog':
      pelvis = { x: 0, y: 1.4 };
      chest = { x: 0, y: 1.9 };
      pd = 0.24;
      lf = { x: -0.45, y: 1.18 };
      rf = { x: 0.45, y: 1.2 };
      lh = { x: -0.25, y: 2.2 };
      rh = { x: 0.25, y: 2.25 };
      break;
    case 'dropknee':
      pelvis = { x: 0.05, y: 1.3 };
      chest = { x: 0.0, y: 1.8 };
      rf = { x: -0.12, y: 1.0 };
      lf = { x: -0.38, y: 0.72 };
      lh = { x: -0.25, y: 2.1 };
      rh = { x: 0.32, y: 2.2 };
      yaw = -0.2;
      break;
    case 'crossover':
      lh = { x: -0.12, y: 1.95 };
      rh = { x: -0.24, y: 2.14 };
      lf = { x: -0.2, y: 0.75 };
      rf = { x: 0.25, y: 0.8 };
      break;
    case 'crossunder':
      lh = { x: -0.32, y: 2.0 };
      rh = { x: -0.22, y: 1.82 };
      break;
    case 'lowhand':
      rh = { x: 0.3, y: 1.3 };
      lh = { x: -0.25, y: 2.1 };
      break;
    case 'face':
      rh = { x: 0.0, y: 1.95 };
      lh = { x: -0.3, y: 2.1 };
      break;
    case 'matched':
      lh = { x: 0.02, y: 2.15 };
      rh = { x: 0.02, y: 2.15 };
      break;
    case 'feetmatch':
      lf = { x: 0.05, y: 0.8 };
      rf = { x: 0.05, y: 0.8 };
      break;
    case 'crouch':
      pelvis = { x: 0, y: 1.2 };
      chest = { x: 0.02, y: 1.7 };
      pd = 0.45;
      lf = { x: -0.25, y: 1.05 };
      rf = { x: 0.3, y: 1.1 };
      lh = { x: -0.2, y: 1.95 };
      rh = { x: 0.25, y: 2.0 };
      break;
    case 'ill-foot-up':
      rf = { x: 0.11, y: 1.78 };
      break;
    case 'ill-hand-low':
      lh = { x: -0.3, y: 0.3 };
      break;
    case 'ill-foot-cross':
      rf = { x: -0.62, y: 1.05 };
      break;
    case 'falling':
      phase = 'falling';
      pelvis = { x: 0.1, y: 1.6 };
      chest = { x: -0.15, y: 2.05 };
      pd = 0.6;
      vel = { x: 0.6, y: -4 };
      lh = { x: -0.55, y: 2.25 };
      rh = { x: 0.35, y: 2.45 };
      lf = { x: -0.1, y: 0.85 };
      rf = { x: 0.4, y: 0.95 };
      free(['LH', 'RH', 'LF', 'RF'], 0.5);
      break;
    case 'landed':
      phase = 'landed';
      pelvis = { x: 0, y: 0.75 };
      chest = { x: 0.03, y: 1.21 };
      pd = 0.7;
      lh = { x: -0.25, y: 0.62 };
      rh = { x: 0.25, y: 0.62 };
      lf = { x: -0.23, y: 0.3 };
      rf = { x: 0.23, y: 0.3 };
      free(['LH', 'RH', 'LF', 'RF'], 0.75);
      break;
    case 'hanging':
      phase = 'hanging';
      pelvis = { x: 0, y: 2.2 };
      chest = { x: 0.0, y: 2.7 };
      pd = 0.55;
      lh = { x: -0.2, y: 2.35 };
      rh = { x: 0.2, y: 2.35 };
      lf = { x: -0.12, y: 1.4 };
      rf = { x: 0.12, y: 1.4 };
      free(['LH', 'RH', 'LF', 'RF'], 0.5);
      break;
  }
  const add = (p: Vec2): Vec2 => ({ x: p.x + ox, y: p.y });
  // anchors exactly as the sim: shoulders / hips offset perpendicular to the spine
  const ux = chest.x - pelvis.x;
  const uy = chest.y - pelvis.y;
  const ul = Math.hypot(ux, uy);
  const rx = uy / ul;
  const ry = -ux / ul;
  const sh = BODY.shoulderHalf;
  const hh = BODY.hipHalf;
  // pelvis depth exactly as the sim estimates it from the feet on holds (statics.estimateDepth)
  if (phase === 'climbing') {
    let n = 0;
    let sum = 0;
    const feet: [Vec2, number][] = [
      [lf, -1],
      [rf, 1],
    ];
    for (const [f, sg] of feet) {
      const l = Math.hypot(f.x - (pelvis.x + sg * rx * hh), f.y - (pelvis.y + sg * ry * hh));
      sum += Math.min(0.62, Math.max(0.14, Math.sqrt(Math.max(0, SIM.legDepthLen ** 2 - l * l))));
      n++;
    }
    pd = sum / n;
  }
  return {
    phase,
    pelvis: add(pelvis),
    chest: add(chest),
    com: add({ x: pelvis.x + ux * BODY.comT, y: pelvis.y + uy * BODY.comT }),
    pelvisDepth: pd,
    bodyYaw: yaw,
    velocity: vel,
    limbs: {
      LH: limb('LH', add(lh), add({ x: chest.x - rx * sh, y: chest.y - ry * sh }), 0.03, ex.LH),
      RH: limb('RH', add(rh), add({ x: chest.x + rx * sh, y: chest.y + ry * sh }), 0.03, ex.RH),
      LF: limb('LF', add(lf), add({ x: pelvis.x - rx * hh, y: pelvis.y - ry * hh }), 0.02, ex.LF),
      RF: limb('RF', add(rf), add({ x: pelvis.x + rx * hh, y: pelvis.y + ry * hh }), 0.02, ex.RF),
    },
    tension: 0.35,
    pump: 0.3,
    shake: 0,
    balance: 0,
    topProgress: 0,
    time: t,
    clipped: [],
  };
}

type Cam = 'game' | 'side' | 'wall';

interface Cell {
  name: LimitPose;
  ox: number;
  m: ClimberModel;
  markers: THREE.Object3D[];
}

export function runLimits(canvas: HTMLCanvasElement, qs: URLSearchParams, labels: HTMLDivElement, hud: HTMLDivElement): void {
  const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);
  const names: LimitPose[] = qs.has('poses') ? ((qs.get('poses') as string).split(',') as LimitPose[]) : LIMIT_POSES;
  const cams: Cam[] = qs.has('cams') ? ((qs.get('cams') as string).split(',') as Cam[]) : ['game', 'side'];
  const cols = Math.max(1, num('cols', Math.min(4, names.length)));
  const rows = Math.ceil(names.length / cols);
  const freeze = qs.has('t') ? num('t', 0) : null;
  const showTargets = qs.get('targets') !== '0';

  const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
  gl.setPixelRatio(Math.min(2, window.devicePixelRatio));
  gl.setSize(window.innerWidth, window.innerHeight, false);
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.setScissorTest(true);
  gl.autoClear = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#15171b');
  const key = new THREE.DirectionalLight('#ffe6cc', 2.4);
  key.position.set(1.5, 4, 4);
  const fill = new THREE.DirectionalLight('#a8c8dc', 0.9);
  fill.position.set(-3, 1.5, 2);
  const rim = new THREE.DirectionalLight('#d8e8ff', 1.6);
  rim.position.set(0, 2, -3);
  scene.add(key, fill, rim, new THREE.HemisphereLight('#cfd6de', '#2a2622', 0.7));

  const frame = new WallFrame(num('angle', 0));
  const sp = 2.2;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(names.length * sp + 4, 6), new THREE.MeshStandardMaterial({ color: '#34373d', roughness: 0.9 }));
  wall.quaternion.copy(frame.quaternion);
  wall.position.copy(frame.toWorldXYZ((names.length - 1) * sp * 0.5, 3, 0));
  scene.add(wall);
  // T-nut grid hint so depth reads on the wall
  const grid = new THREE.GridHelper(names.length * sp + 4, (names.length * sp + 4) * 5, '#4a4e56', '#3d4047');
  grid.quaternion.copy(frame.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  grid.position.copy(frame.toWorldXYZ((names.length - 1) * sp * 0.5, 3, 0.002));
  scene.add(grid);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(names.length * sp + 4, 0.3, 3), new THREE.MeshStandardMaterial({ color: '#202226', roughness: 0.95 }));
  floor.position.set((names.length - 1) * sp * 0.5, 0.15, 1.5);
  scene.add(floor);

  const holdGeo = new THREE.SphereGeometry(0.04, 14, 10);
  const holdMat = new THREE.MeshStandardMaterial({ color: '#F2C230', roughness: 0.5 });
  const tgtMat = new THREE.MeshBasicMaterial({ color: '#ff3b30', wireframe: true });
  const cells: Cell[] = names.map((name, i) => {
    const ox = i * sp;
    const m = new ClimberModel({ head: (qs.get('head') ?? 'ibex') as never, colorway: (qs.get('cw') ?? 'basalt') as never, chalk: 'classic' });
    m.rig.collide = qs.get('nocol') !== '1';
    if (name === 'hanging') m.setHarness(true);
    scene.add(m);
    const st = limitState(name, ox, 0);
    const markers: THREE.Object3D[] = [];
    for (const id of ['LH', 'RH', 'LF', 'RF'] as LimbId[]) {
      const L = st.limbs[id];
      if (!L.holdId || st.phase !== 'climbing') continue;
      const h = new THREE.Mesh(holdGeo, holdMat);
      h.scale.set(1, 1, 0.5);
      h.position.copy(frame.toWorld(L.pos, 0.01));
      h.quaternion.copy(frame.quaternion);
      scene.add(h);
      markers.push(h);
      if (showTargets) {
        const tm = new THREE.Mesh(holdGeo, tgtMat);
        tm.scale.setScalar(0.45);
        tm.position.copy(frame.toWorld(L.pos, 0.06));
        scene.add(tm);
        markers.push(tm);
      }
    }
    return { name, ox, m, markers };
  });

  // rope for the hanging pose
  const hang = cells.find((c) => c.name === 'hanging');
  const rope = hang ? new RopeMesh() : null;
  if (rope) scene.add(rope);
  const ropePts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  // collision proxy overlay
  const proxyOn = qs.get('proxies') === '1';
  const proxyGeo = new THREE.SphereGeometry(1, 10, 7);
  const proxyMat = new THREE.MeshBasicMaterial({ color: '#39d0ff', wireframe: true, transparent: true, opacity: 0.55, depthTest: false });
  const proxyPool: THREE.Mesh[] = [];
  const proxyGroup = new THREE.Group();
  proxyGroup.renderOrder = 10;
  scene.add(proxyGroup);
  const tmpV = new THREE.Vector3();
  const showProxies = (c: Cell | null) => {
    let n = 0;
    const put = (p: THREE.Vector3, r: number) => {
      if (n >= proxyPool.length) {
        const m = new THREE.Mesh(proxyGeo, proxyMat);
        m.renderOrder = 10;
        proxyPool.push(m);
        proxyGroup.add(m);
      }
      const m = proxyPool[n++];
      m.visible = true;
      m.position.copy(p);
      m.scale.setScalar(r);
    };
    if (c && proxyOn) {
      c.m.rig.forEachProxy((a, b, ra, rb) => {
        const l = a.distanceTo(b);
        const k = Math.min(4, Math.max(1, Math.ceil(l / Math.max(0.03, Math.min(ra, rb)))));
        for (let i = 0; i <= k; i++) put(tmpV.copy(a).lerp(b, i / k), ra + (rb - ra) * (i / k));
      });
    }
    for (let i = n; i < proxyPool.length; i++) proxyPool[i].visible = false;
  };

  const tick = (dt: number, t: number) => {
    for (const c of cells) c.m.pose(limitState(c.name, c.ox, t), frame, dt);
    if (hang && rope) {
      ropePts[0].set(hang.ox - 0.9, 1.3, 1.4);
      frame.toWorldXYZ(hang.ox + 0.15, 3.1, 0.08, ropePts[1]);
      hang.m.getHarnessWorld(ropePts[2]);
      hang.m.setRopeAnchor(ropePts[1]);
      rope.setPath(ropePts);
      rope.update(dt);
    }
  };
  // pre-roll so phase timers progress (the landed crouch is caught early, before standing up)
  const pre = (name: LimitPose) => (name === 'landed' ? 16 : name === 'falling' ? 40 : 150);
  const maxPre = Math.max(...cells.map((c) => pre(c.name)));
  for (let k = 0; k < maxPre; k++) {
    for (const c of cells) if (k < pre(c.name)) c.m.pose(limitState(c.name, c.ox, k / 60), frame, k === 0 ? 0 : 1 / 60);
    if (hang && rope) tick(0, k / 60);
  }

  // labels per cell
  const cellEls = cells.map((c) => {
    const el = document.createElement('div');
    el.textContent = `${LABEL[c.name]}  ·  ${cams.join(' | ')}`;
    el.style.transform = 'none';
    el.style.color = c.name.startsWith('ill') ? '#ff8a7a' : '#aeb6c0';
    el.style.fontSize = '11px';
    labels.appendChild(el);
    return el;
  });

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const box = new THREE.Box3();
  const ctr = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const right = new THREE.Vector3();
  const aim = (c: Cell, cam: Cam, aspect: number) => {
    // frame the solved body (joints) of this climber
    const J = c.m.rig.joints;
    box.makeEmpty();
    const focus = qs.get('focus');
    const pts =
      focus === 'upper'
        ? [J.head, J.grip[0], J.grip[1], J.elbow[0], J.elbow[1], J.shoulder[0], J.shoulder[1]]
        : focus === 'lower'
          ? [J.hip[0], J.hip[1], J.knee[0], J.knee[1], J.toe[0], J.toe[1], J.ankle[0], J.ankle[1]]
          : [J.head, J.grip[0], J.grip[1], J.toe[0], J.toe[1], J.knee[0], J.knee[1], J.elbow[0], J.elbow[1], J.hip[0], J.hip[1]];
    for (const p of pts) box.expandByPoint(p);
    box.expandByScalar(0.16);
    box.getCenter(ctr);
    const size = box.getSize(tmpV);
    if (cam === 'game') {
      // as the follow camera: wall normal blended toward +Z, 12° yaw, from slightly below
      dir.set(0, 0, 1).lerp(frame.normal, 0.55).normalize();
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 12 * (Math.PI / 180));
      dir.applyQuaternion(q);
      right.crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
      q.setFromAxisAngle(right, 7 * (Math.PI / 180));
      dir.applyQuaternion(q).normalize();
    } else if (cam === 'side') {
      dir.copy(frame.right).multiplyScalar(0.94).addScaledVector(frame.normal, 0.34).normalize();
    } else {
      dir.copy(frame.normal).multiplyScalar(-1).addScaledVector(frame.right, 0.25).addScaledVector(frame.up, 0.1).normalize();
    }
    camera.fov = 30;
    camera.aspect = aspect;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const h = Math.max(size.y, (cam === 'side' ? Math.max(size.z, 0.8) : size.x) / aspect);
    const dist = (h * 0.5) / half + (focus ? 0.35 : 0.6);
    camera.position.copy(ctr).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(ctr);
    camera.updateProjectionMatrix();
  };

  let t = 0;
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (freeze === null) {
      t += dt;
      tick(dt, t);
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cw = W / cols;
    const ch = H / rows;
    const vw = cw / cams.length;
    cells.forEach((c, i) => {
      const cx = (i % cols) * cw;
      const cy = Math.floor(i / cols) * ch;
      cellEls[i].style.left = `${cx + 6}px`;
      cellEls[i].style.top = `${cy + 6}px`;
      for (const o of cells) {
        o.m.visible = o === c;
        for (const mk of o.markers) mk.visible = o === c;
      }
      if (rope) rope.visible = c === hang;
      showProxies(c);
      cams.forEach((cam, k) => {
        wall.visible = cam !== 'wall';
        grid.visible = cam !== 'wall';
        aim(c, cam, vw / ch);
        const x = cx + k * vw;
        const y = H - cy - ch;
        gl.setViewport(x, y, vw - 2, ch - 2);
        gl.setScissor(x, y, vw - 2, ch - 2);
        gl.render(scene, camera);
      });
    });
    const contacts = cells
      .map((c) => `${c.name}:${c.m.rig.contacts}${c.m.rig.fallback.some((f) => f) ? '/fb' + c.m.rig.fallback.map((f) => (f ? 1 : 0)).join('') : ''}`)
      .join(' ');
    hud.textContent = `limits  calls ${gl.info.render.calls}  contacts ${contacts}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as unknown as Record<string, unknown>).__limits = cells;
  // QA: average ms per ClimberModel.pose() (IK + limits + self-collision) for each pose
  (window as unknown as Record<string, unknown>).__bench = (n = 300): string =>
    cells
      .map((c) => {
        const st = limitState(c.name, c.ox, 1);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          st.time = 1 + i / 60;
          c.m.pose(st, frame, 1 / 60);
        }
        return `${c.name} ${((performance.now() - t0) / n).toFixed(3)}ms evals ${c.m.rig.evals} chains ${c.m.rig.chains} contacts ${c.m.rig.contacts}`;
      })
      .join('\n');
}

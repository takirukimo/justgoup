// CHARACTER dev harness — `view=grip`: hands and feet on every hold type, close up, with the REAL
// ClimberSim (reset onto start holds / start feet of the kind under test) posed by the REAL
// GameRenderer. One page load serves many shots: window.__grip.show(kind, limb, cam) rebuilds the
// wall, re-runs the sim and aims the camera; dev/character.grip.mjs walks the whole matrix.
//   ?kind=<kind> &limb=hand|foot &cam=close|side|game|below &angle=<wall deg> &hud=0
//   kinds: jug bucket edge rail crimp micro sloper macro pinch horn pocket1 pocket2 pocket3 foot chip
//          volume onvol fold roof wood dual

import * as THREE from 'three';
import { GameRenderer } from '../src/render/renderer';
import type { BoulderDef, HoldDef, HoldShape, HoldType, LimbId, WallPanel } from '../src/core/types';
import { ClimberSim } from '../src/game/climber-sim';
import { WallFrame } from '../src/render/wall-frame';

export type GripKind =
  | 'jug'
  | 'bucket'
  | 'edge'
  | 'rail'
  | 'crimp'
  | 'micro'
  | 'sloper'
  | 'macro'
  | 'pinch'
  | 'horn'
  | 'pocket1'
  | 'pocket2'
  | 'pocket3'
  | 'foot'
  | 'chip'
  | 'volume'
  | 'onvol'
  | 'fold'
  | 'roof'
  | 'wood'
  | 'dual';

interface KindDef {
  type: HoldType;
  shape?: HoldShape;
  size: number;
  fingers?: 1 | 2 | 3 | 4;
  edgeDepthMm?: number;
}

const KINDS: Record<GripKind, KindDef> = {
  jug: { type: 'jug', size: 0.09 },
  bucket: { type: 'jug', shape: 'bucket', size: 0.09 },
  edge: { type: 'edge', size: 0.06, edgeDepthMm: 22 },
  rail: { type: 'edge', shape: 'rail', size: 0.06, edgeDepthMm: 20 },
  crimp: { type: 'crimp', size: 0.045, edgeDepthMm: 10 },
  micro: { type: 'crimp', shape: 'micro', size: 0.035, edgeDepthMm: 6 },
  sloper: { type: 'sloper', size: 0.1 },
  macro: { type: 'sloper', shape: 'macro', size: 0.16 },
  pinch: { type: 'pinch', size: 0.07 },
  horn: { type: 'pinch', shape: 'horn', size: 0.07 },
  pocket1: { type: 'pocket', size: 0.05, fingers: 1 },
  pocket2: { type: 'pocket', size: 0.055, fingers: 2 },
  pocket3: { type: 'pocket', size: 0.065, fingers: 3 },
  foot: { type: 'foot', size: 0.04 },
  chip: { type: 'foot', shape: 'chip', size: 0.03 },
  volume: { type: 'volume', size: 0.3 },
  onvol: { type: 'edge', size: 0.06, edgeDepthMm: 22 },
  fold: { type: 'edge', size: 0.06, edgeDepthMm: 22 },
  roof: { type: 'jug', size: 0.09 },
  wood: { type: 'edge', shape: 'wood', size: 0.065, edgeDepthMm: 24 },
  dual: { type: 'sloper', shape: 'dual-tex', size: 0.11 },
};

export const GRIP_KINDS = Object.keys(KINDS) as GripKind[];

const mk = (id: string, x: number, y: number, k: KindDef, role: HoldDef['role'], seed: number, angle = -Math.PI / 2): HoldDef => ({
  id,
  x,
  y,
  type: k.type,
  size: k.size,
  angle,
  role,
  color: role === 'deco' ? '#55606E' : '#F2C230',
  seed,
  ...(k.shape ? { shape: k.shape } : {}),
  ...(k.fingers ? { fingers: k.fingers } : {}),
  ...(k.edgeDepthMm ? { edgeDepthMm: k.edgeDepthMm } : {}),
});

const FOOT_DEF: KindDef = { type: 'foot', size: 0.045 };
const JUG_DEF: KindDef = { type: 'jug', size: 0.09 };

/** The test wall: hands on two start holds, feet on two footholds; the kind under test on `limb`. */
export function gripBoulder(kind: GripKind, limb: 'hand' | 'foot', angle: number): BoulderDef {
  const k = KINDS[kind];
  const hk = limb === 'hand' ? k : JUG_DEF;
  const fk = limb === 'foot' ? k : FOOT_DEF;
  const holds: HoldDef[] = [];
  let profile: WallPanel[] | undefined;
  let wallAngle = angle;
  const handY = 2.05;
  const footY = 0.8;
  if (kind === 'onvol') {
    // the holds bolted onto pink volumes
    const vy = limb === 'hand' ? handY - 0.02 : footY + 0.02;
    holds.push(mk('v1', -0.27, vy, { type: 'volume', size: 0.26 }, 'deco', 11));
    holds.push(mk('v2', 0.27, vy + 0.04, { type: 'volume', size: 0.28 }, 'deco', 12));
    holds[0].color = '#E0567A';
    holds[1].color = '#E0567A';
  }
  if (kind === 'fold' || kind === 'roof') {
    // hands on a steep panel above a fold (35°) / a roof lip (75°)
    const a = kind === 'fold' ? 35 : 75;
    profile = limb === 'hand' ? [{ y0: 0, angle: 10 }, { y0: 1.92, angle: a }] : [{ y0: 0, angle: a }, { y0: 0.95, angle: 10 }];
    wallAngle = a;
  }
  const hx = [-0.25, 0.25];
  const fx = [-0.2, 0.21];
  for (let s = 0; s < 2; s++) {
    const h = mk(s ? 's2' : 's1', hx[s], handY + s * 0.05, hk, 'start', 17 + s * 5);
    if (kind === 'onvol' && limb === 'hand') h.onVolume = s ? 'v2' : 'v1';
    if (hk.type === 'pinch') h.angle = s ? Math.PI : 0;
    holds.push(h);
    const f = mk(s ? 'f2' : 'f1', fx[s], footY + s * 0.05, fk, fk.type === 'foot' ? 'foot' : 'hand', 31 + s * 7);
    if (kind === 'onvol' && limb === 'foot') f.onVolume = s ? 'v2' : 'v1';
    holds.push(f);
  }
  holds.push(mk('t', 0.05, 4.1, JUG_DEF, 'top', 3));
  return {
    id: `grip-${kind}-${limb}`,
    name: `Grip ${kind}`,
    grade: 3,
    mode: 'boulder',
    wallAngle,
    width: 4.6,
    height: 4.5,
    color: '#F2C230',
    seed: 1,
    holds,
    startFeet: { LF: 'f1', RF: 'f2' },
    ...(profile ? { profile } : {}),
  };
}

type Cam = 'close' | 'side' | 'game' | 'below' | 'front';

export async function runGrip(canvas: HTMLCanvasElement, qs: URLSearchParams, hud: HTMLDivElement): Promise<void> {
  const r = new GameRenderer(canvas, { quality: 'high' });
  await r.init();
  const ri = r as unknown as { climber: { getLimbWorld(l: LimbId, o: THREE.Vector3): THREE.Vector3 } };
  let st: ReturnType<ClimberSim['getState']> | null = null;
  let info = '';
  const dt = 1 / 60;

  const show = (kind: GripKind, limb: 'hand' | 'foot' = 'hand', cam: Cam = 'close', angle = 5, side: LimbId | null = null, simT = 1.4): string => {
    const b = gripBoulder(kind, limb, angle);
    r.loadBoulder(b);
    const sim = new ClimberSim(b, { invincible: true });
    sim.reset();
    sim.start();
    r.setDebugView(null);
    r.setCameraMode('follow', { instant: true });
    for (let t = 0; t < simT; t += dt) {
      sim.step(dt);
      r.updateClimber(sim.getState(), dt);
    }
    st = sim.getState();
    const id: LimbId = side ?? (limb === 'hand' ? 'RH' : 'RF');
    const L = st.limbs[id];
    const frame = new WallFrame(b.wallAngle);
    frame.setWall(b);
    const P = ri.climber.getLimbWorld(id, new THREE.Vector3());
    const N = frame.normalAt(L.pos.y, new THREE.Vector3());
    const U = frame.upAt(L.pos.y, new THREE.Vector3());
    const R = frame.right;
    const sg = id === 'LH' || id === 'LF' ? -1 : 1;
    if (cam !== 'game') {
      const look = P.clone().addScaledVector(N, limb === 'hand' ? 0.02 : 0.03);
      const d = limb === 'hand' ? 0.42 : 0.55;
      const pos = look.clone();
      if (cam === 'close') pos.addScaledVector(N, d * 0.82).addScaledVector(R, sg * d * 0.35).addScaledVector(U, d * (limb === 'hand' ? 0.42 : 0.38));
      else if (cam === 'side') pos.addScaledVector(R, sg * d * 0.95).addScaledVector(N, d * 0.3).addScaledVector(U, d * 0.12);
      else if (cam === 'below') pos.addScaledVector(N, d * 0.7).addScaledVector(U, -d * 0.6).addScaledVector(R, sg * d * 0.2);
      else pos.addScaledVector(N, d).addScaledVector(U, d * 0.05);
      r.setDebugView(pos, look, limb === 'hand' ? 30 : 34);
    }
    info = `${kind} ${limb} ${id}: hold ${L.holdId ?? '-'} mode ${L.footMode ?? '-'} pos ${L.pos.x.toFixed(3)},${L.pos.y.toFixed(3)} depth ${L.depth.toFixed(3)} | wall ${b.wallAngle}°`;
    document.title = info;
    return info;
  };
  (window as unknown as Record<string, unknown>).__grip = { show, kinds: GRIP_KINDS };
  show(
    (qs.get('kind') ?? 'jug') as GripKind,
    (qs.get('limb') ?? 'hand') as 'hand' | 'foot',
    (qs.get('cam') ?? 'close') as Cam,
    qs.has('angle') ? Number(qs.get('angle')) : 5,
    (qs.get('side') as LimbId | null) ?? null,
  );
  const tick = () => {
    if (st) r.updateClimber(st, dt);
    r.frame(dt);
    if (qs.get('hud') !== '0') hud.textContent = info;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

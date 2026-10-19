// CHARACTER dev harness — `view=tech&tech=<name>`: each Phase B technique performed by the REAL
// ClimberSim through its public API (drags, chalkUp, shakeOut, dyno) and posed by the REAL
// GameRenderer, frozen at the telling moment.
//   tech = heel | toe | flag | backflag | drop | smear | shake | chalk | deadpoint | dyno | pump
//          | highstep | heelhigh | toehigh (v0.3 high feet)
//          | cam (heel-toe cams on a roof) | bat / batin (mid-swing) / batup (sitting back up)
//          | fig4 / fig4in (pressing up) / fig4reach (the free hand up high)   (v0.3 advanced moves)
//   at=<s> capture time after the action (default per technique)   cam=follow|side|front
//   head=<id> cw=<colourway>
// The page title reports the sim's footMode / flags at the capture so a shot can be checked.

import * as THREE from 'three';
import { GameRenderer } from '../src/render/renderer';
import type { BoulderDef, ClimberState, ColorwayId, HeadId, HoldDef, LimbId, Vec2 } from '../src/core/types';
import { ClimberSim } from '../src/game/climber-sim';
import { WallFrame } from '../src/render/wall-frame';

type Tech =
  | 'heel'
  | 'toe'
  | 'flag'
  | 'backflag'
  | 'drop'
  | 'smear'
  | 'shake'
  | 'chalk'
  | 'deadpoint'
  | 'dyno'
  | 'pump'
  | 'highstep'
  | 'heelhigh'
  | 'toehigh'
  | 'cam'
  | 'bat'
  | 'batin'
  | 'batup'
  | 'fig4'
  | 'fig4in'
  | 'fig4reach';

interface Scenario {
  wall: number;
  /** A whole problem of its own instead of base(wall) + extra (advanced moves: a cave, a jug ladder). */
  boulder?: () => BoulderDef;
  /** Extra holds relative to the hip / shoulder anchors found on a first reset. */
  extra: (a: Record<LimbId, Vec2>, p: Vec2) => HoldDef[];
  /** Actions, run once at their time (s after the climb starts). */
  script: { t: number; run: (sim: ClimberSim, ctx: Ctx) => void }[];
  at: number;
}

interface Ctx {
  drag?: { limb: LimbId; from: Vec2; to: Vec2; t0: number; dur: number; release: boolean };
}

const hold = (id: string, x: number, y: number, type: HoldDef['type'], role: HoldDef['role'], angle = -Math.PI / 2, size = 0.07): HoldDef => ({
  id,
  x,
  y,
  type,
  size,
  angle,
  role,
  color: role === 'deco' ? '#55606E' : '#F2C230',
  seed: x * 1000 + y * 77,
});

function base(wall: number): BoulderDef {
  return {
    id: 'tech',
    name: 'Technique',
    grade: 3,
    mode: 'boulder',
    wallAngle: wall,
    width: 4.6,
    height: 4.5,
    color: '#F2C230',
    seed: 1,
    holds: [
      hold('s1', -0.24, 2.05, 'jug', 'start', -Math.PI / 2, 0.09),
      hold('s2', 0.24, 2.12, 'jug', 'start', -Math.PI / 2, 0.09),
      hold('f1', -0.22, 0.78, 'foot', 'foot', -Math.PI / 2, 0.045),
      hold('f2', 0.2, 0.84, 'foot', 'foot', -Math.PI / 2, 0.045),
      hold('t', 0.05, 4.1, 'jug', 'top', -Math.PI / 2, 0.1),
    ],
    startFeet: { LF: 'f1', RF: 'f2' },
  };
}

/** Drag a limb to a point over `dur` seconds, then release it there. */
const dragTo = (limb: LimbId, to: (s: ClimberState) => Vec2, dur = 0.5) => (sim: ClimberSim, ctx: Ctx) => {
  const st = sim.getState();
  if (!sim.beginDrag(limb)) return;
  const L = st.limbs[limb];
  ctx.drag = { limb, from: { x: L.pos.x, y: L.pos.y }, to: to(st), t0: -1, dur, release: true };
};

/** A cave (advanced.test.ts): vertical to 1.3 m, then a flat roof; hands on two roof jugs, feet on two roof edges with opposing edges a foot-length further out (heel-toe cams). */
const H = (id: string, x: number, y: number, type: HoldDef['type'], size: number, role: HoldDef['role'], deg = -90): HoldDef => hold(id, x, y, type, role, (deg * Math.PI) / 180, size);
const ROOF = +(new URLSearchParams(location.search).get('roof') ?? 2.3);
function cave(): BoulderDef {
  // (the test's cave roof is 1.3 m up; a bat hang under it would put the head into the mats: here it is
  // ROOF m up, ?roof= to change)
  const o = ROOF - 1.3;
  return {
    ...base(90),
    holds: [
      H('s1', -0.25, 2.25 + o, 'jug', 0.11, 'start'),
      H('s2', 0.25, 2.25 + o, 'jug', 0.11, 'start'),
      H('a1', -0.3, 1.6 + o, 'edge', 0.07, 'foot', -90),
      H('a2', 0.3, 1.6 + o, 'edge', 0.07, 'foot', -90),
      H('b1', -0.3, 1.84 + o, 'edge', 0.07, 'foot', 90),
      H('b2', 0.3, 1.84 + o, 'edge', 0.07, 'foot', 90),
      H('t', 0, 4.1 + o, 'jug', 0.12, 'top'),
    ],
    height: 4.5 + o,
    profile: [
      { y0: 0, angle: 0 },
      { y0: ROOF, angle: 90 },
    ],
    startFeet: { LF: 'a1', RF: 'a2' },
  };
}
/** A vertical jug ladder for the figure 4 (advanced.test.ts): LH / RH on two jugs at ≈2 m, a jug far above. */
function ladder(): BoulderDef {
  return {
    ...base(0),
    holds: [
      H('s1', -0.2, 2.0, 'jug', 0.11, 'start'),
      H('s2', 0.25, 2.05, 'jug', 0.11, 'start'),
      H('f1', -0.25, 0.75, 'jug', 0.08, 'foot'),
      H('f2', 0.3, 0.8, 'jug', 0.08, 'foot'),
      H('hi', 0.3, 3.0, 'jug', 0.08, 'hand'),
      H('t', 0, 4.1, 'jug', 0.12, 'top'),
    ],
    startFeet: { LF: 'f1', RF: 'f2' },
  };
}
const bat = (at: number, sitUp = false): Scenario => ({
  wall: 90,
  boulder: cave,
  extra: () => [],
  script: [
    { t: 0.8, run: (sim) => void sim.batHang?.() },
    ...(sitUp ? [{ t: 3.0, run: dragTo('RH', () => ({ x: 0.25, y: 2.25 + ROOF - 1.3 }), 0.4) }] : []),
  ],
  at,
});
const fig4 = (at: number, reach = false): Scenario => ({
  wall: 0,
  boulder: ladder,
  extra: () => [],
  script: [
    { t: 0.8, run: (sim) => void sim.figure4?.('RF') },
    ...(reach ? [{ t: 1.6, run: dragTo('RH', () => ({ x: 0.3, y: 3.0 }), 0.45) }] : []),
  ],
  at,
});

const SCENARIOS: Record<Tech, Scenario> = {
  // v0.3 advanced moves (shared spec), done by the real sim
  cam: { wall: 90, boulder: cave, extra: () => [], script: [], at: 2.0 },
  bat: bat(2.6),
  batin: bat(0.45),
  batup: bat(0.45, true),
  fig4: fig4(1.4),
  fig4in: fig4(0.3),
  fig4reach: fig4(0.9, true),
  heel: {
    wall: 25,
    extra: (a) => [hold('x', a.RF.x + 0.46, a.RF.y - 0.07, 'jug', 'hand', Math.PI, 0.08)],
    script: [{ t: 0.6, run: dragTo('RF', () => ({ x: 0, y: 0 })) }],
    at: 1.6,
  },
  toe: {
    wall: 32,
    extra: (a) => [hold('x', a.RF.x + 0.62, a.RF.y - 0.32, 'jug', 'hand', 2.68, 0.09)],
    script: [{ t: 0.6, run: dragTo('RF', () => ({ x: 0, y: 0 })) }],
    at: 1.6,
  },
  flag: {
    wall: 8,
    extra: () => [],
    script: [{ t: 0.6, run: dragTo('LF', (s) => ({ x: s.limbs.LF.anchor.x - 0.66, y: s.limbs.LF.anchor.y + 0.06 })) }],
    at: 1.8,
  },
  backflag: {
    wall: 20,
    extra: () => [],
    script: [{ t: 0.6, run: dragTo('LF', (s) => ({ x: s.limbs.RF.anchor.x + 0.22, y: s.limbs.RF.anchor.y - 0.55 })) }],
    at: 1.8,
  },
  drop: {
    wall: 4,
    extra: (a) => [hold('x', a.RF.x + 0.38, a.RF.y - 0.36, 'edge', 'hand', 0, 0.06)],
    script: [{ t: 0.6, run: dragTo('RF', () => ({ x: 0, y: 0 })) }],
    at: 1.8,
  },
  smear: {
    wall: -4,
    extra: () => [],
    script: [{ t: 0.6, run: dragTo('RF', (s) => ({ x: s.limbs.RF.anchor.x + 0.3, y: s.limbs.RF.anchor.y - 0.26 })) }],
    at: 1.6,
  },
  shake: {
    wall: 5,
    extra: () => [],
    script: [{ t: 0.5, run: (sim) => void sim.shakeOut('LH') }],
    at: 1.7,
  },
  chalk: {
    wall: 5,
    extra: () => [],
    script: [{ t: 0.5, run: (sim) => void sim.chalkUp('RH') }],
    at: 1.0,
  },
  deadpoint: {
    wall: 15,
    extra: (a) => [hold('x', a.RH.x + 0.1, a.RH.y + 0.98, 'jug', 'hand', -Math.PI / 2, 0.09)],
    script: [{ t: 0.6, run: (sim) => void sim.dyno('RH', 'x', 1) }],
    at: 0.82,
  },
  dyno: {
    wall: 12,
    extra: (a, p) => [hold('x', p.x, a.RH.y + 1.15, 'jug', 'hand', -Math.PI / 2, 0.12)],
    script: [{ t: 0.6, run: (sim) => void sim.dyno('both', 'x', 1) }],
    at: 0.86,
  },
  pump: {
    wall: 20,
    extra: () => [],
    script: [],
    at: 2.0,
  },
  // v0.3 high feet (shared spec): a rock-over foot ≈0.25 m above the hip, out to the side, hips in
  highstep: {
    wall: 3,
    extra: (a) => [hold('x', a.RF.x + 0.36, a.RF.y + 0.24, 'edge', 'hand', -Math.PI / 2, 0.065)],
    script: [{ t: 0.6, run: dragTo('RF', () => ({ x: 0, y: 0 }), 0.7) }],
    at: 2.2,
  },
  // a heel hook at chest height out to the side on a steep wall
  heelhigh: {
    wall: 35,
    extra: (a) => [hold('x', a.RF.x + 0.42, a.RF.y + 0.42, 'jug', 'hand', Math.PI, 0.09)],
    script: [{ t: 0.6, run: dragTo('RF', () => ({ x: 0, y: 0 }), 0.7) }],
    at: 2.0,
  },
  // a toe hook high and far out on a steep wall
  toehigh: {
    wall: 40,
    extra: (a) => [hold('x', a.RF.x + 0.58, a.RF.y + 0.3, 'jug', 'hand', 2.6, 0.09)],
    script: [{ t: 0.6, run: dragTo('RF', () => ({ x: 0, y: 0 }), 0.7) }],
    at: 2.0,
  },
};

export async function runTech(canvas: HTMLCanvasElement, qs: URLSearchParams, hud: HTMLDivElement): Promise<void> {
  const tech = (qs.get('tech') ?? 'heel') as Tech;
  const sc = SCENARIOS[tech];
  // first reset: where the anchors are on the start holds
  const b0 = sc.boulder ? sc.boulder() : base(sc.wall);
  const s0 = new ClimberSim(b0);
  s0.reset();
  const st0 = s0.getState();
  const anchors = { LH: { ...st0.limbs.LH.anchor }, RH: { ...st0.limbs.RH.anchor }, LF: { ...st0.limbs.LF.anchor }, RF: { ...st0.limbs.RF.anchor } };
  const b = sc.boulder ? sc.boulder() : base(sc.wall);
  b.holds.push(...sc.extra(anchors, { ...st0.pelvis }));
  const holdX = b.holds.find((h) => h.id === 'x');

  const r = new GameRenderer(canvas, { quality: 'high' });
  await r.init();
  r.loadBoulder(b);
  r.setSkin((qs.get('head') ?? 'ibex') as HeadId, (qs.get('cw') ?? 'basalt') as ColorwayId, 'classic');
  // CHARACTER → fx: the chalk puff off the fingers as a hand comes out of the bag (the renderer
  // integration is the world agent's; the harness wires it the same way)
  const ri = r as unknown as { climber: { onChalkDip: ((p: Vec2, d: number) => void) | null }; fxSys: { chalkPuff(p: Vec2, k: number, d: number): void } };
  ri.climber.onChalkDip = (p, d) => ri.fxSys.chalkPuff(p, 0.7, d);
  const sim = new ClimberSim(b, { invincible: true });
  sim.reset();
  sim.start();
  r.setCameraMode('follow', { instant: true });
  const ctx: Ctx = {};
  const done = new Set<number>();
  const dt = 1 / 60;
  let t = 0;
  const step = () => {
    sc.script.forEach((a, i) => {
      if (!done.has(i) && t >= a.t) {
        done.add(i);
        a.run(sim, ctx);
        if (ctx.drag && holdX && ctx.drag.to.x === 0 && ctx.drag.to.y === 0) ctx.drag.to = { x: holdX.x, y: holdX.y };
      }
    });
    const d = ctx.drag;
    if (d) {
      if (d.t0 < 0) d.t0 = t;
      const k = Math.min(1, (t - d.t0) / d.dur);
      const e = k * k * (3 - 2 * k);
      sim.dragTo(d.limb, { x: d.from.x + (d.to.x - d.from.x) * e, y: d.from.y + (d.to.y - d.from.y) * e });
      if (k >= 1) {
        const lp = sim.getState().limbs[d.limb].pos;
        console.log(`[tech] release ${d.limb} at ${lp.x.toFixed(2)},${lp.y.toFixed(2)} (asked ${d.to.x.toFixed(2)},${d.to.y.toFixed(2)}) snap ${sim.snapCandidate(d.limb, d.to)?.id ?? '-'}`);
        sim.endDrag(d.limb);
        ctx.drag = undefined;
      }
    }
    sim.step(dt);
    let st = sim.getState();
    if (tech === 'pump') {
      // a deep pump on the right forearm (render-side feature: the forearm swells and trembles)
      st = { ...st, pump: 0.95, limbs: { ...st.limbs, RH: { ...st.limbs.RH, pump: 0.95 }, LH: { ...st.limbs.LH, pump: 0.6 } } };
    }
    r.updateClimber(st, dt);
    t += dt;
  };
  const end = sc.script.length ? Math.max(...sc.script.map((a) => a.t)) + (qs.has('at') ? Number(qs.get('at')) : sc.at) : sc.at;
  while (t < end) step();
  // camera
  const st = sim.getState();
  const wf = (r as unknown as { wallFrame: WallFrame }).wallFrame;
  const P = wf.toWorld(st.pelvis, st.pelvisDepth);
  const camMode = qs.get('cam') ?? 'follow';
  if (camMode !== 'follow') {
    const look = P.clone().addScaledVector(wf.up, 0.25);
    const pos =
      camMode === 'side'
        ? look.clone().add(new THREE.Vector3(2.5, 0.45, 2.3))
        : camMode === 'profile'
          ? look.clone().add(new THREE.Vector3(3.4, 0.1, 0.35))
        : camMode === 'left'
          ? look.clone().add(new THREE.Vector3(-2.5, 0.45, 2.3))
          : camMode === 'low'
            ? look.clone().add(new THREE.Vector3(1.0, -0.5, 3.1))
            : look.clone().add(new THREE.Vector3(-0.4, 0.35, 3.4));
    r.setDebugView(pos, look, 42);
  }
  if (qs.has('camat')) {
    // camat=<what>,dx,dy,dz[,fov]: look at the pelvis | chest | mid (pelvis–chest) | feet | hands (the rig's
    // solved joints, world) from that point + (dx, dy, dz) (world axes)
    const v = (qs.get('camat') as string).split(',');
    const rig = (r as unknown as { climber: { rig: { joints: { hip: THREE.Vector3[]; knee: THREE.Vector3[]; ankle: THREE.Vector3[]; wrist: THREE.Vector3[]; shoulder: THREE.Vector3[] } } } }).climber.rig;
    const J = rig.joints;
    const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
    const hips = mid(J.hip[0], J.hip[1]);
    const chest = mid(J.shoulder[0], J.shoulder[1]);
    const look =
      v[0] === 'chest'
        ? chest
        : v[0] === 'mid'
          ? mid(hips, chest)
          : v[0] === 'feet'
            ? mid(J.ankle[0], J.ankle[1])
            : v[0] === 'hands'
              ? mid(J.wrist[0], J.wrist[1])
              : v[0] === 'lknee' || v[0] === 'rknee'
                ? J.knee[v[0] === 'lknee' ? 0 : 1].clone()
                : v[0] === 'lfoot' || v[0] === 'rfoot'
                  ? J.ankle[v[0] === 'lfoot' ? 0 : 1].clone()
                  : hips;
    r.setDebugView(look.clone().add(new THREE.Vector3(+v[1], +v[2], +v[3])), look, v[4] ? +v[4] : 40);
  }
  const L = st.limbs;
  const info = `${tech}: LF ${L.LF.footMode ?? '-'} RF ${L.RF.footMode ?? '-'} | LH ${L.LH.holdId ?? (L.LH.shakingOut ? 'shake' : L.LH.chalking ? 'chalk' : L.LH.flying ? 'fly' : 'free')} RH ${L.RH.holdId ?? (L.RH.shakingOut ? 'shake' : L.RH.chalking ? 'chalk' : L.RH.flying ? 'fly' : 'free')} | airborne ${!!st.airborne} special ${st.special ?? '-'}${st.bat ? ` bat ${st.bat.blend.toFixed(2)} fat ${st.bat.fatigue.toFixed(2)}` : ''}${st.figure4 ? ` f4 ${st.figure4.hand}/${st.figure4.leg} ${st.figure4.blend.toFixed(2)}` : ''} cam ${L.LF.camHoldId ?? '-'}/${L.RF.camHoldId ?? '-'} t=${t.toFixed(2)}`;
  document.title = info;
  console.log(`[tech] ${info}`);
  const tick = () => {
    r.frame(dt);
    if (qs.get('hud') !== '0') hud.textContent = info;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

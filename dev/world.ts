// WORLD dev harness: renders the gym + a problem with the stub climber and exercises every
// renderer feature. Not part of the shipped build.
//
// URL params:
//   mode=boulder|rope   angle=<deg>   seed=<n>   grade=<0..12>
//   cam=title|intro|preview|follow|editor|celebrate|fall
//   q=low|medium|high   tm=aces|agx   hl=1 (highlights demo)   guide=1   fx=1
//   y=<m> (rope: climber height)   sim=0 (force synthetic pose)   hud=0   fixed=1 (fixed dt)
//   head=<HeadId>  colorway=<ColorwayId>

import { GameRenderer } from '../src/render/renderer';
import type { BoulderDef, ClimberState, HeadId, ColorwayId, HoldDef, HoldType, LimbId, LimbSnapshot, QualityLevel, QuickdrawDef, Vec2 } from '../src/core/types';
import type { CameraMode, HoldHighlight } from '../src/core/contracts';
import { ROUTE_COLORS } from '../src/config/brand';
import { BODY, GAME } from '../src/config/tuning';
import { Rng } from '../src/core/rng';

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);
const mode = (qs.get('mode') ?? 'boulder') as 'boulder' | 'rope';
const angle = num('angle', mode === 'rope' ? 8 : 20);
const seed = num('seed', 7);
const grade = num('grade', 4);
const camMode = (qs.get('cam') ?? 'follow') as CameraMode;
const quality = (qs.get('q') ?? 'high') as QualityLevel;
const showHl = qs.get('hl') === '1';
const showGuide = qs.get('guide') === '1';
const fixed = qs.get('fixed') === '1';
const hudEl = document.getElementById('hud') as HTMLDivElement;
if (qs.get('hud') === '0') hudEl.classList.add('hide');

// ───────────────────────────── sample problem ─────────────────────────────

function sampleBoulder(): BoulderDef {
  const rng = new Rng(seed);
  const color = ROUTE_COLORS[seed % ROUTE_COLORS.length].hex;
  const W = mode === 'rope' ? GAME.ropeWall.width : GAME.boulderWall.width;
  const H = mode === 'rope' ? GAME.ropeWall.height : GAME.boulderWall.height;
  const holds: HoldDef[] = [];
  let id = 0;
  const add = (x: number, y: number, type: HoldType, size: number, role: HoldDef['role'], col: string, ang = -Math.PI / 2) =>
    holds.push({ id: `h${id++}`, x, y, type, size, angle: ang, role, color: col, seed: rng.int(0, 1e6) });

  // start: two holds
  add(-0.28, 1.45, 'jug', 0.1, 'start', color);
  add(0.22, 1.38, 'edge', 0.065, 'start', color, -Math.PI / 2 + 0.25);
  add(-0.35, 0.55, 'foot', 0.03, 'foot', color);
  add(0.3, 0.62, 'foot', 0.028, 'foot', color);
  const types: HoldType[] = ['crimp', 'sloper', 'pinch', 'jug', 'edge', 'pocket'];
  let x = 0;
  const top = mode === 'rope' ? H - 0.6 : H - 0.45;
  const steps = mode === 'rope' ? 24 : 6;
  for (let k = 0; k < steps; k++) {
    const y = 1.9 + ((top - 2.2) * (k + 0.5)) / steps;
    x = Math.max(-1.4, Math.min(1.4, x + rng.range(-0.55, 0.55)));
    const type = types[k % types.length];
    const size = type === 'crimp' ? 0.045 : type === 'jug' ? 0.11 : type === 'pocket' ? 0.065 : 0.08;
    add(x, y, type, size, 'hand', color, -Math.PI / 2 + rng.range(-0.7, 0.7));
    if (k % 2 === 0) add(x + rng.range(-0.45, 0.45), y - rng.range(0.6, 0.9), 'foot', 0.03, 'foot', color);
  }
  add(x * 0.6, top, 'jug', 0.12, 'top', color);
  // a route volume
  add(0.9, 2.2, 'volume', 0.36, 'hand', color);
  // deco: other routes
  for (let r = 0; r < 4; r++) {
    const c = ROUTE_COLORS[(seed + 2 + r * 3) % ROUTE_COLORS.length].hex;
    let dx = rng.range(-W / 2 + 0.4, W / 2 - 0.4);
    const n = mode === 'rope' ? 22 : 8;
    for (let k = 0; k < n; k++) {
      const y = 0.6 + ((H - 1.0) * (k + rng.next())) / n;
      dx = Math.max(-W / 2 + 0.25, Math.min(W / 2 - 0.25, dx + rng.range(-0.5, 0.5)));
      add(dx, y, rng.pick(types), rng.range(0.045, 0.1), 'deco', c, -Math.PI / 2 + rng.range(-0.9, 0.9));
    }
  }
  add(-1.5, 3.2, 'volume', 0.42, 'deco', '#E9E5DD');
  add(1.6, 0.95, 'volume', 0.3, 'deco', '#55606E');

  const quickdraws: QuickdrawDef[] | undefined =
    mode === 'rope'
      ? (() => {
          const out: QuickdrawDef[] = [];
          let q = 0;
          for (let y = 2.4; y < H - 0.8; y += 1.35) out.push({ id: `q${q++}`, x: 0.35 * Math.sin(y * 0.7), y });
          out.push({ id: 'anchor', x: 0, y: H - 0.25 });
          return out;
        })()
      : undefined;

  return {
    id: `dev-${seed}`,
    name: mode === 'rope' ? 'Glacier Line' : 'Basalt Shift',
    grade,
    mode,
    wallAngle: angle,
    width: W,
    height: H,
    holds,
    quickdraws,
    color,
    seed,
  };
}

// Prefer SIM's generator + sim when they exist and compile (built in parallel by another agent).
const genMods = import.meta.glob('../src/game/generator.ts');
const simMods = import.meta.glob('../src/game/climber-sim.ts');

interface SimLike {
  reset(): void;
  start(): void;
  step(dt: number): unknown[];
  getState(): ClimberState;
}

async function tryGenerator(): Promise<BoulderDef | null> {
  if (qs.get('gen') === '0') return null;
  const loader = genMods['../src/game/generator.ts'];
  if (!loader) return null;
  try {
    const m = (await loader()) as Record<string, unknown>;
    const fn = (mode === 'rope' ? m.generateRopeRoute : m.generateBoulder) as ((o: object) => BoulderDef) | undefined;
    if (!fn) return null;
    const b = fn({ seed, grade, mode, wallAngle: angle });
    return b && Array.isArray(b.holds) && b.holds.length > 4 ? b : null;
  } catch (e) {
    console.warn('[world] generator unavailable, using inline sample', e);
    return null;
  }
}

async function trySim(b: BoulderDef): Promise<SimLike | null> {
  if (qs.get('sim') === '0') return null;
  const loader = simMods['../src/game/climber-sim.ts'];
  if (!loader) return null;
  try {
    const m = (await loader()) as { ClimberSim?: new (b: BoulderDef, o?: object) => SimLike };
    if (!m.ClimberSim) return null;
    const sim = new m.ClimberSim(b, { invincible: true });
    sim.reset();
    sim.start();
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    const st = sim.getState();
    return st && st.pelvis && isFinite(st.pelvis.x) ? sim : null;
  } catch (e) {
    console.warn('[world] sim unavailable, using synthetic pose', e);
    return null;
  }
}

// ───────────────────────────── synthetic climber ─────────────────────────────

function synthState(b: BoulderDef, t: number): ClimberState {
  const starts = b.holds.filter((h) => h.role === 'start');
  const lift = mode === 'rope' ? num('y', 6) - 1.45 : 0;
  const hold = (i: number) => starts[i] ?? starts[0];
  const L = hold(0);
  const R = hold(1);
  const reach = (Math.sin(t * 0.9) * 0.5 + 0.5) * 0.35;
  const lh = { x: L.x, y: L.y + lift };
  const rh = { x: R.x + reach * 0.4, y: R.y + lift + reach };
  const sway = Math.sin(t * 1.3) * 0.04;
  const pelvis = { x: (lh.x + rh.x) / 2 + sway, y: lh.y - 0.95 };
  const chest = { x: pelvis.x + 0.02, y: pelvis.y + BODY.spine };
  const lf = { x: pelvis.x - 0.3, y: pelvis.y - 0.62 };
  const rf = { x: pelvis.x + 0.32, y: pelvis.y - 0.55 };
  const limb = (id: LimbId, pos: Vec2, anchor: Vec2, depth: number, extra: Partial<LimbSnapshot> = {}): LimbSnapshot => ({
    id, holdId: null, pos, anchor, depth, dragging: false, load: 0.3, stress: 0.4, capacity: 0.7,
    reachRatio: 0.7, smearing: false, shake: 0, busy: false, ...extra,
  });
  return {
    phase: 'climbing',
    pelvis,
    chest,
    com: { x: pelvis.x, y: pelvis.y + BODY.spine * BODY.comT },
    pelvisDepth: 0.3,
    bodyYaw: Math.sin(t * 0.7) * 0.08,
    velocity: { x: 0, y: 0 },
    limbs: {
      LH: limb('LH', lh, { x: chest.x - BODY.shoulderHalf, y: chest.y }, 0.05),
      RH: limb('RH', rh, { x: chest.x + BODY.shoulderHalf, y: chest.y }, 0.05 + reach * 0.3, { dragging: reach > 0.05 }),
      LF: limb('LF', lf, { x: pelvis.x - BODY.hipHalf, y: pelvis.y }, 0.04),
      RF: limb('RF', rf, { x: pelvis.x + BODY.hipHalf, y: pelvis.y }, 0.04),
    },
    tension: 0.3,
    pump: 0.2,
    shake: 0,
    balance: 0,
    topProgress: 0,
    time: t,
    clipped: [],
  };
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const r = new GameRenderer(canvas, { quality, toneMapping: qs.get('tm') === 'agx' ? 'agx' : 'aces' });
  await r.init();
  const b = (await tryGenerator()) ?? sampleBoulder();
  r.loadBoulder(b);
  r.setSkin((qs.get('head') ?? 'ibex') as HeadId, (qs.get('colorway') ?? 'basalt') as ColorwayId, 'classic');
  const sim = await trySim(b);
  const w = window as unknown as Record<string, unknown>;
  w.__r = r;
  w.__b = b;

  if (qs.has('view')) {
    // view=px,py,pz,lx,ly,lz[,fov]
    const v = (qs.get('view') as string).split(',').map(Number);
    const T = (await import('three'));
    r.setDebugView(new T.Vector3(v[0], v[1], v[2]), new T.Vector3(v[3], v[4], v[5]), v[6] || 50);
  }
  if (camMode === 'intro') void r.playIntro().then(() => console.log('[world] intro done'));
  else r.setCameraMode(camMode, { instant: true });
  if (camMode === 'editor') r.setEditorView({ x: 0, y: b.height / 2 }, Math.min(b.height + 0.6, 6));
  if (showGuide) r.setGuide({ x: -1.1, depth: 1.5, pose: mode === 'rope' ? 'belay' : 'wave', lookAt: { x: 0, y: 1.8 } });

  // round-trip check wallToScreen → screenToWall
  const roundTrip = () => {
    let maxErr = 0;
    let n = 0;
    for (let x = -1.5; x <= 1.5; x += 0.5) {
      for (let y = 0.8; y <= Math.min(b.height - 0.2, 4); y += 0.4) {
        const s = r.wallToScreen({ x, y });
        if (!s.visible) continue;
        const p = r.screenToWall(s.x, s.y);
        if (!p) continue;
        maxErr = Math.max(maxErr, Math.hypot(p.x - x, p.y - y));
        n++;
      }
    }
    const ppm = r.pxPerMeter({ x: 0, y: 1.6 });
    console.log(`[world] roundtrip samples=${n} maxErr=${maxErr.toExponential(2)} m  pxPerMeter@(0,1.6)=${ppm.toFixed(1)}`);
    return { n, maxErr, ppm };
  };
  w.__roundTrip = roundTrip;

  let last = performance.now();
  let t = 0;
  let frames = 0;
  let puffT = 0;
  let checked = false;
  const highlightRoute = b.holds.filter((h) => h.role !== 'deco');
  const tick = (now: number) => {
    const dt = fixed ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    frames++;
    let st: ClimberState;
    if (sim) {
      sim.step(dt);
      st = sim.getState();
    } else {
      st = synthState(b, t);
    }
    r.updateClimber(st, dt);
    if (camMode === 'follow') r.setCameraFocusHint(st.limbs.RH.dragging ? st.limbs.RH.pos : null);

    if (showHl && highlightRoute.length > 4) {
      const hs: HoldHighlight[] = [];
      const near = highlightRoute.slice(2, 7);
      near.forEach((h, i) => hs.push({ holdId: h.id, kind: 'reachable' }));
      hs.push({ holdId: near[1].id, kind: 'candidate', quality: 0.5 + 0.5 * Math.sin(t * 0.8) });
      hs.push({ holdId: near[3].id, kind: 'hint' });
      hs.push({ holdId: highlightRoute[highlightRoute.length - 3].id, kind: 'tutorial' });
      if (camMode === 'editor') hs.push({ holdId: highlightRoute[0].id, kind: 'selected' });
      r.setHoldHighlights(hs);
    }
    if (mode === 'rope' && b.quickdraws) {
      const harness = st.pelvis;
      const below = b.quickdraws.filter((q) => q.y < harness.y - 0.1 && q.id !== 'anchor');
      const path: Vec2[] = [{ x: -0.6, y: 0 }, ...below.map((q) => ({ x: q.x, y: q.y })), { x: harness.x, y: harness.y }];
      r.setRope(path, below.map((q) => q.id));
    }
    puffT -= dt;
    if (qs.get('fx') === '1' && puffT <= 0) {
      puffT = 1.4;
      r.fx.chalkPuff(st.limbs.LH.pos, 1);
      if (camMode === 'celebrate') r.fx.confetti(st.limbs.RH.pos);
    }
    r.frame(dt);
    if (!checked && frames === 30) {
      checked = true;
      roundTrip();
    }
    if (frames % 15 === 0) {
      const s = r.stats();
      hudEl.textContent = `${quality.toUpperCase()} ${mode} ${angle}° cam=${r.cameraMode}\ncalls ${s.calls}  tris ${(s.triangles / 1000).toFixed(1)}k  tex ${s.textures}  geo ${s.geometries}\n${sim ? 'sim' : 'synthetic'} pose  ${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((e) => {
  console.error('[world] failed', e);
  hudEl.textContent = String(e?.stack ?? e);
});

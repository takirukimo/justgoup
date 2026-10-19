// CHARACTER offline anatomy QA: the REAL sim (ClimberSim + generator + the planner bot, which also
// chalks up and shakes out) drives the REAL ClimberModel in node — no WebGL — and every frame is
// measured like the in-browser probe (dev/character-probe.ts): limb ↔ limb / torso / head capsule
// overlaps, joints under the crash pads, and per-frame joint jumps (pops). Techniques the sim reports
// (heel / toe hooks, flags, drop knees, smears, chalk dips, shake-outs, dyno flights) are tallied.
//
//   npx vitest run --config dev/character.vitest.config.mjs            (quick sweep)
//   SOAK=1 npx vitest run --config dev/character.vitest.config.mjs     (long sweep)
import './character-stub';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoulderDef, ClimberState, HeadId, LimbId } from '../src/core/types';
import type { SimEvent } from '../src/core/contracts';
import { generateBoulder, generateRopeRoute } from '../src/game/generator';
import { ClimberSim } from '../src/game/climber-sim';
import { BetaBot } from '../src/game/bot';
import { RopeSystem } from '../src/game/rope';
import { BONE, ClimberModel } from '../src/render/climber';
import { WallFrame } from '../src/render/wall-frame';
import { measureRig, PEN_BAD, FLOOR_BAD, type Measure } from './character-probe';

interface Tally {
  frames: number;
  /** Frames with a body capsule (head / horns, torso, elbow, knee…) more than WALL_BAD inside the wall. */
  wallFrames: number;
  wall: { v: number; what: string; tag: string };
  wallBy: Record<string, number>;
  /** ClimberModel.pose() time (ms, summed over frames). */
  poseMs: number;
  wallLog: string[];
  penFrames: number;
  floorFrames: number;
  worst: { v: number; what: string; tag: string };
  floor: { v: number; what: string; tag: string };
  jump: { v: number; what: string; tag: string };
  jumpFrames: number;
  pairs: Record<string, number>;
  byTech: Record<string, { frames: number; pen: number; worst: number; what: string }>;
  phases: Record<string, { frames: number; pen: number }>;
  events: Record<string, number>;
  popLog: string[];
  fbFrames: number;
  pen5Frames: number;
  penLog: string[];
}

const fresh = (): Tally => ({
  frames: 0,
  wallFrames: 0,
  wall: { v: 0, what: '', tag: '' },
  wallBy: {},
  poseMs: 0,
  wallLog: [],
  penFrames: 0,
  floorFrames: 0,
  worst: { v: 0, what: '', tag: '' },
  floor: { v: 0, what: '', tag: '' },
  jump: { v: 0, what: '', tag: '' },
  jumpFrames: 0,
  pairs: {},
  byTech: {},
  phases: {},
  events: {},
  popLog: [],
  fbFrames: 0,
  pen5Frames: 0,
  penLog: [],
});

/** An elbow / knee moving this much more than its limb's ends in one 60 Hz frame reads as a pop. */
const JUMP_BAD = 0.03;
/** A body capsule this far inside the (folded) wall surface counts as a wall penetration. */
const WALL_BAD = 0.02;

const PROXY = ['chest', 'belly', 'pelvis', 'neck'];
const _wa = new THREE.Vector3();
/**
 * Deepest penetration of the rig's collision proxies into the wall, measured with the frame's exact
 * (folded) mapping — independent of the rig's own clearance model. The forearm / shin ends that hold
 * on (wrists, ankles: their hand / foot is ON the wall by design) are left out.
 */
function wallPen(model: ClimberModel, frame: WallFrame): { v: number; what: string } {
  let worst = 0;
  let what = '';
  let i = 0;
  const headN = model.rig.headProxyCount;
  model.rig.forEachProxy((a, b, ra, rb) => {
    const k = i++;
    const limbK = k - 4 - headN;
    const name = k < 4 ? PROXY[k] : k < 4 + headN ? `head${k - 4}` : ['uarmL', 'farmL', 'thighL', 'shinL', 'uarmR', 'farmR', 'thighR', 'shinR'][limbK] ?? `p${k}`;
    const distal = limbK >= 0 && limbK % 2 === 1;
    for (let j = 0; j <= 4; j++) {
      const u = j / 4;
      if (distal && u > 0.6) break;
      _wa.copy(a).lerp(b, u);
      const dep = frame.fromWorld(_wa).depth - (ra + (rb - ra) * u);
      if (-dep > worst) {
        worst = -dep;
        what = name;
      }
    }
  });
  return { v: worst, what };
}

function techTags(st: ClimberState): string[] {
  const out: string[] = [];
  for (const id of ['LF', 'RF'] as LimbId[]) {
    const m = st.limbs[id].footMode;
    if (m && m !== 'edge') out.push(m);
  }
  for (const id of ['LH', 'RH'] as LimbId[]) {
    const L = st.limbs[id];
    if (L.chalking) out.push('chalk');
    if (L.shakingOut) out.push('shakeout');
    if (L.flying) out.push('flying');
    if ((L.pump ?? 0) > 0.6) out.push('pumped');
  }
  if (st.airborne) out.push('airborne');
  return out;
}

function run(b: BoulderDef, T: Tally, opts: { secs: number; fallAt?: number; tag: string }): { topped: boolean; moves: number } {
  const sim = new ClimberSim(b);
  sim.reset();
  const rope = b.mode === 'rope' ? new RopeSystem(b) : null;
  const bot = new BetaBot(sim);
  sim.start();
  const model = new ClimberModel({ head: (process.env.HEAD ?? 'ibex') as HeadId, colorway: 'basalt', chalk: 'classic' });
  model.setHarness(!!rope);
  if (process.env.NOCOLLIDE) model.rig.collide = false;
  // baseline: the rig clears only the single body plane through the wall origin (pre-fold behaviour)
  if (process.env.NOFOLD) model.rig.setWallFolds = () => undefined;
  const holds = new Map(b.holds.map((h) => [h.id, h]));
  model.setHoldLookup((id, out) => {
    const h = holds.get(id);
    if (!h) return false;
    out.type = h.type;
    out.angle = h.angle;
    out.size = h.size;
    out.depth = h.size * 0.5;
    return true;
  });
  const frame = new WallFrame(b.wallAngle);
  frame.setWall(b);
  const dt = 1 / 60;
  let events: SimEvent[] = [];
  const m: Measure = { pen: 0, what: '', floor: 0, floorWhat: '' };
  const prev = [0, 1, 2, 3].map(() => [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
  let havePrev = false;
  let topped = false;
  const n = Math.round(opts.secs / dt);
  for (let i = 0; i < n; i++) {
    bot.update(dt, events);
    if (opts.fallAt !== undefined && i * dt >= opts.fallAt && sim.getState().phase === 'climbing') sim.forceFall();
    if (rope) {
      const c = rope.catchParams(sim.getState().pelvis);
      sim.setRope(c.anchor, c.length);
    }
    events = sim.step(dt);
    for (const e of events) {
      T.events[e.type] = (T.events[e.type] ?? 0) + 1;
      if (e.type === 'technique') T.events[`tech:${e.technique}`] = (T.events[`tech:${e.technique}`] ?? 0) + 1;
      if (e.type === 'clip-done' && rope) rope.clip(e.quickdrawId);
      if (e.type === 'top') topped = true;
    }
    const st = sim.getState();
    frame.setBodyY((st.pelvis.y + st.chest.y) / 2);
    const tp = performance.now();
    model.pose(st, frame, dt);
    T.poseMs += performance.now() - tp;
    measureRig(model.rig, frame.normal, frame.origin, m, T.pairs);
    const tags = techTags(st);
    const where = `${opts.tag} t=${(i * dt).toFixed(2)} ${st.phase}${tags.length ? ' [' + tags.join(',') + ']' : ''}`;
    T.frames++;
    if (st.phase !== 'falling') {
      const w = wallPen(model, frame);
      if (w.v > WALL_BAD) {
        T.wallFrames++;
        const key = w.what.startsWith('head') ? 'head' : w.what;
        T.wallBy[key] = (T.wallBy[key] ?? 0) + 1;
        if (T.wallLog.length < (process.env.WALLLOG ? +process.env.WALLLOG : 0) && i % 20 === 0)
          T.wallLog.push(`${(w.v * 100).toFixed(1)}cm ${w.what} ${where} P=${st.pelvis.x.toFixed(2)},${st.pelvis.y.toFixed(2)} C=${st.chest.x.toFixed(2)},${st.chest.y.toFixed(2)} d=${st.pelvisDepth.toFixed(2)}`);
      }
      if (w.v > T.wall.v) T.wall = { v: w.v, what: w.what, tag: `${where} P=${st.pelvis.x.toFixed(2)},${st.pelvis.y.toFixed(2)} d=${st.pelvisDepth.toFixed(2)}` };
    }
    const ph = (T.phases[st.phase] ??= { frames: 0, pen: 0 });
    ph.frames++;
    if (m.pen > PEN_BAD) {
      T.penFrames++;
      ph.pen++;
      if (/head/.test(m.what) && process.env.HEADLOG) {
        // which head sphere (neck-bone frame: y up the head, z toward the face) and how the arm sits
        const nb = model.rig.bones[BONE.neck];
        const qi = nb.quaternion.clone().invert();
        let k = 0;
        let best = { pen: 0, j: -1, loc: new THREE.Vector3(), r: 0 };
        const headN = model.rig.headProxyCount;
        const heads: { p: THREE.Vector3; r: number }[] = [];
        model.rig.forEachProxy((a, _b, ra) => {
          if (k >= 4 && k < 4 + headN) heads.push({ p: a.clone(), r: ra });
          k++;
        });
        const side = /L$/.test(m.what) ? 0 : 1;
        const J = model.rig.joints;
        for (let j = 0; j < heads.length; j++) {
          for (const [a, b, ra] of [[J.shoulder[side], J.elbow[side], 0.05], [J.elbow[side], J.wrist[side], 0.04]] as const) {
            const ab = b.clone().sub(a);
            const t = Math.max(0, Math.min(1, heads[j].p.clone().sub(a).dot(ab) / ab.lengthSq()));
            const d = heads[j].p.distanceTo(a.clone().addScaledVector(ab, t));
            const pen = heads[j].r + ra - d;
            if (pen > best.pen) best = { pen, j, loc: heads[j].p.clone().sub(nb.position).applyQuaternion(qi), r: heads[j].r };
          }
        }
        const sh = J.shoulder[side];
        const hw = J.wrist[side].clone().sub(sh);
        const key = `headsph${best.j} (${best.loc.x.toFixed(2)},${best.loc.y.toFixed(2)},${best.loc.z.toFixed(2)} r${best.r.toFixed(2)})`;
        T.pairs[key] = (T.pairs[key] ?? 0) + 1;
        if (T.penLog.length < 40 && i % 30 === 0) T.penLog.push(`${(m.pen * 100).toFixed(1)}cm ${m.what} ${key} wrist-shoulder ${hw.x.toFixed(2)},${hw.y.toFixed(2)},${hw.z.toFixed(2)} ${where}`);
      }
      if (/shin|thigh/.test(m.what) && !/belly|chest|head|fore|upper/.test(m.what)) {
        // leg ↔ leg: are the feet crossed (left foot right of the right foot, along the body's right)?
        const lf = st.limbs.LF.pos;
        const rf = st.limbs.RF.pos;
        const dx = (rf.x - lf.x) * model.bodyRight.x + (rf.y - lf.y) * model.bodyRight.y;
        const k = dx < 0 ? 'legs:crossed' : dx < 0.16 ? 'legs:narrow' : 'legs:apart';
        T.pairs[k] = (T.pairs[k] ?? 0) + 1;
      }
      if (T.penLog.length < (process.env.PENLOG ? +process.env.PENLOG : 0) && i % 15 === 0) {
        const lim = (['LH', 'RH', 'LF', 'RF'] as LimbId[]).map((id) => { const L = st.limbs[id]; return `${id}:${L.pos.x.toFixed(2)},${L.pos.y.toFixed(2)}${L.holdId ? '' : L.dragging ? 'd' : 'f'}${L.footMode && L.footMode !== 'edge' ? '/' + L.footMode : ''}${L.layer ? '^' + L.layer : ''}`; }).join(' ');
        T.penLog.push(`${(m.pen * 100).toFixed(1)}cm ${m.what} ${where} P=${st.pelvis.x.toFixed(2)},${st.pelvis.y.toFixed(2)} d=${st.pelvisDepth.toFixed(2)} ${lim}`);
      }
    }
    if (m.pen > 0.05) T.pen5Frames++;
    if (m.floor > FLOOR_BAD) T.floorFrames++;
    if (m.pen > T.worst.v) T.worst = { v: m.pen, what: m.what, tag: where };
    if (m.floor > T.floor.v) T.floor = { v: m.floor, what: m.floorWhat, tag: where };
    for (const tg of tags) {
      const bt = (T.byTech[tg] ??= { frames: 0, pen: 0, worst: 0, what: '' });
      bt.frames++;
      if (m.pen > PEN_BAD) bt.pen++;
      if (m.pen > bt.worst) {
        bt.worst = m.pen;
        bt.what = `${m.what} @ ${where}`;
      }
    }
    // pops: an elbow / knee jumping between frames further than its root and its end moved (a swivel
    // flip); falls and the teleport on reset excluded
    const J = model.rig.joints;
    let jw = 0;
    let jwhat = '';
    for (let li = 0; li < 4; li++) {
      const s2 = li & 1;
      const root = li < 2 ? J.shoulder[s2] : J.hip[s2];
      const mid = li < 2 ? J.elbow[s2] : J.knee[s2];
      const end = li < 2 ? J.wrist[s2] : J.ankle[s2];
      const pv = prev[li];
      if (havePrev) {
        const dd = mid.distanceTo(pv[1]) - Math.max(root.distanceTo(pv[0]), end.distanceTo(pv[2]));
        if (dd > jw) {
          jw = dd;
          jwhat = `${li < 2 ? 'elbow' : 'knee'}${s2 ? 'R' : 'L'}`;
        }
      }
      pv[0].copy(root);
      pv[1].copy(mid);
      pv[2].copy(end);
    }
    havePrev = true;
    const calm = st.phase === 'climbing' || st.phase === 'topped' || st.phase === 'idle';
    if (calm && model.rig.fallback.some(Boolean)) T.fbFrames++;
    if (calm && !st.airborne) {
      if (jw > JUMP_BAD) {
        T.jumpFrames++;
        if (T.popLog.length < (process.env.POPLOG ? +process.env.POPLOG : 0)) {
          const lid = (jwhat.startsWith('elbow') || jwhat.startsWith('wrist') ? (jwhat.endsWith('L') ? 'LH' : 'RH') : jwhat.endsWith('L') ? 'LF' : 'RF') as LimbId;
          const L = st.limbs[lid];
          T.popLog.push(`${(jw * 100).toFixed(1)}cm ${jwhat} ${where} ${lid}: hold=${L.holdId} drag=${L.dragging} smear=${L.smearing} mode=${L.footMode ?? '-'} busy=${L.busy} pos=${L.pos.x.toFixed(2)},${L.pos.y.toFixed(2)} anchor=${L.anchor.x.toFixed(2)},${L.anchor.y.toFixed(2)} layer=${L.layer ?? 0}`);
        }
      }
      if (jw > T.jump.v) T.jump = { v: jw, what: jwhat, tag: where };
    }
    if (st.phase === 'landed' && i * dt > (opts.fallAt ?? 0) + 3) break;
    if (topped && st.phase === 'topped' && i * dt > 2 && bot.done) {
      // a second of the celebration, then stop
      for (let k = 0; k < 60; k++) {
        sim.step(dt);
        const st2 = sim.getState();
        frame.setBodyY((st2.pelvis.y + st2.chest.y) / 2);
        model.pose(st2, frame, dt);
        measureRig(model.rig, frame.normal, frame.origin, m, T.pairs);
        T.frames++;
        if (m.pen > PEN_BAD) T.penFrames++;
        if (m.pen > T.worst.v) T.worst = { v: m.pen, what: m.what, tag: `${opts.tag} celebrate` };
      }
      break;
    }
    if (bot.failed && st.phase === 'climbing' && opts.fallAt === undefined) {
      sim.forceFall();
    }
  }
  model.dispose();
  return { topped, moves: bot.moves };
}

function report(name: string, T: Tally): void {
  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '0') + '%';
  const pairs = Object.entries(T.pairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k}:${v}`)
    .join('  ');
  const tech = Object.entries(T.byTech)
    .map(([k, v]) => `  ${k.padEnd(9)} frames ${String(v.frames).padStart(5)}  pen ${pct(v.pen, v.frames).padStart(6)}  worst ${(v.worst * 100).toFixed(1)} cm ${v.what}`)
    .join('\n');
  const phases = Object.entries(T.phases)
    .map(([k, v]) => `${k} ${v.frames} (${pct(v.pen, v.frames)})`)
    .join('  ');
  process.stderr.write(
    `\n== ${name} ==\nframes ${T.frames}  pen>${PEN_BAD * 100}cm ${pct(T.penFrames, T.frames)}  pen>5cm ${pct(T.pen5Frames, T.frames)}  floor ${pct(T.floorFrames, T.frames)}  wall>${WALL_BAD * 100}cm ${pct(T.wallFrames, T.frames)}  pops ${pct(T.jumpFrames, T.frames)}  ik-fallback ${pct(T.fbFrames, T.frames)}\n` +
      `pose ${(T.poseMs / Math.max(1, T.frames)).toFixed(3)} ms/frame (node)\n` +
      `worst wall ${(T.wall.v * 100).toFixed(1)} cm ${T.wall.what} @ ${T.wall.tag}\nwall by part: ${JSON.stringify(T.wallBy)}\n` +
      (T.wallLog.length ? `walls:\n  ${T.wallLog.join('\n  ')}\n` : '') +
      `worst pen ${(T.worst.v * 100).toFixed(1)} cm ${T.worst.what} @ ${T.worst.tag}\n` +
      `worst floor ${(T.floor.v * 100).toFixed(1)} cm ${T.floor.what} @ ${T.floor.tag}\n` +
      `worst pop ${(T.jump.v * 100).toFixed(1)} cm ${T.jump.what} @ ${T.jump.tag}\n` +
      `phases: ${phases}\npairs: ${pairs}\ntechniques:\n${tech}\nevents: ${JSON.stringify(T.events)}\n` +
      (T.popLog.length ? `pops:\n  ${T.popLog.join('\n  ')}\n` : '') +
      (T.penLog.length ? `pens:\n  ${T.penLog.join('\n  ')}\n` : ''),
  );
}

const SOAK = !!process.env.SOAK;

describe('climber anatomy in real play (offline)', () => {
  it('boulders: send train grades and wall angles', () => {
    const T = fresh();
    const seeds = SOAK ? [3, 7, 11, 19, 23, 31, 42, 57] : [7, 19, 42];
    const grades = SOAK ? [1, 3, 5, 7, 9] : [2, 5, 8];
    let k = 0;
    let tops = 0;
    for (const seed of seeds)
      for (const grade of grades) {
        const b = generateBoulder({ seed: seed * 101 + grade, grade, mode: 'boulder' });
        const r = run(b, T, { secs: 70, tag: `B s${seed} V${grade} ${b.wallAngle}° ${b.style ?? ''}`, fallAt: k % 4 === 3 ? 6 : undefined });
        if (r.topped) tops++;
        k++;
      }
    report(`boulders (${k} problems, ${tops} topped)`, T);
    expect(T.frames).toBeGreaterThan(0);
    if (process.env.STRICT) {
      expect(T.penFrames / T.frames).toBeLessThan(0.02);
      expect(T.floorFrames).toBe(0);
    }
  });

  it('folded walls: caves, steep stacks and kickers (profiles on)', () => {
    const T = fresh();
    const styles = ['cave', 'overhang', 'mixed', 'cave', 'compression', 'dyno'] as const;
    const seeds = SOAK ? [3, 11, 23, 42, 57] : [11, 42];
    let k = 0;
    let tops = 0;
    for (const seed of seeds)
      for (const style of styles) {
        const grade = 2 + ((seed + k) % 5);
        const b = generateBoulder({ seed: seed * 37 + k, grade, mode: 'boulder', profiles: true, style });
        const prof = b.profile ? b.profile.map((p) => Math.round(p.angle)).join('/') : `${b.wallAngle}`;
        const r = run(b, T, { secs: 70, tag: `P s${seed} V${grade} ${style} [${prof}]` });
        if (r.topped) tops++;
        k++;
      }
    report(`folded walls (${k} problems, ${tops} topped)`, T);
    expect(T.frames).toBeGreaterThan(0);
    if (process.env.STRICT) expect(T.wallFrames / T.frames).toBeLessThan(0.02);
  });

  it('lead routes: chalking, shake-outs, clips and a whipper', () => {
    const T = fresh();
    const seeds = SOAK ? [5, 13, 29, 61] : [13];
    for (const seed of seeds) {
      const b = generateRopeRoute({ seed, grade: 3, mode: 'rope' });
      run(b, T, { secs: SOAK ? 240 : 150, tag: `R s${seed} ${b.wallAngle}°` });
    }
    report(`lead (${seeds.length} routes)`, T);
    expect(T.frames).toBeGreaterThan(0);
  });
});

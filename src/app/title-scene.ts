// The living backdrop behind every menu: the climber hangs STEADY on good holds about two metres up
// a CHIRAL demo wall, mid-route (owner: no shaking, no lunging on the floor), idling and making one
// slow, deliberate move every 8–12 s along a band of jugs (a gentle traverse, back and forth, with
// a chalk-up now and then). Steini stands on the mats beside the wall looking up at him. The world
// renderer frames both with the 'title' camera from the live state.
//
// The climb runs on a real ClimberSim (assist 1, invincible, very strong, no sweat), so every pose
// is a pose the body can hold; the backdrop additionally never shows tremor or pump.

import type { GuideState } from '../core/contracts';
import type { BoulderDef, ClimberState, HoldDef, HoldType, LimbId, Vec2 } from '../core/types';
import { hashString, Rng } from '../core/rng';
import { PALETTE, ROUTE_COLORS, WALL } from '../config/brand';
import { ClimberSim } from '../game/climber-sim';
import { contactPoint } from '../game/holds';
import type { Services } from './services';

export type BackdropFraming = 'title' | 'locker';

const FRAMING: Record<BackdropFraming, { lift: number; distance: number }> = {
  title: { lift: 0.3, distance: 7.4 },
  locker: { lift: -1.25, distance: 4.5 },
};

const HALF_PI = Math.PI / 2;
const LIMB_IDX: Record<LimbId, number> = { LH: 0, RH: 1, LF: 2, RF: 3 };
const LIMBS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];

// ─────────────────────────────── the demo wall ───────────────────────────────

/** The band of jugs the climber hangs on (≈3.1 m: pelvis ≈2 m up) and the footholds below it. */
const JUGS: readonly (readonly [string, number, number])[] = [
  ['j1', -0.62, 3.05],
  ['j2', -0.2, 3.1],
  ['j3', 0.22, 3.06],
  ['j4', 0.64, 3.11],
  ['j5', 1.06, 3.05],
];
const FEET: readonly (readonly [string, number, number])[] = [
  ['f1', -0.6, 1.38],
  ['f2', -0.25, 1.42],
  ['f3', 0.15, 1.36],
  ['f4', 0.55, 1.42],
  ['f5', 0.95, 1.37],
];

/** Where the climber rests between moves. */
const HOME: Readonly<Record<LimbId, string>> = { LH: 'j2', RH: 'j3', LF: 'f2', RF: 'f3' };

type IdleMove = { limb: LimbId; to: string } | { chalk: 'LH' | 'RH' };

/** One slow move every 8–12 s: a step right along the band, a chalk-up, a step back, a chalk-up. */
const LOOP: readonly IdleMove[] = [
  { limb: 'RH', to: 'j4' },
  { limb: 'RF', to: 'f4' },
  { limb: 'LH', to: 'j3' },
  { limb: 'LF', to: 'f3' },
  { chalk: 'RH' },
  { limb: 'LH', to: 'j2' },
  { limb: 'LF', to: 'f2' },
  { limb: 'RH', to: 'j3' },
  { limb: 'RF', to: 'f3' },
  { chalk: 'LH' },
];

const WALL_W = 4.6;
const WALL_H = 4.5;

/** A hand-set CHIRAL problem in brand pink, with other routes' holds around it. Deterministic. */
export function titleWall(): BoulderDef {
  const color: string = PALETTE.signal;
  const holds: HoldDef[] = [];
  let seed = 101;
  const add = (id: string, type: HoldType, x: number, y: number, size: number, role: HoldDef['role'], c = color, angle = -HALF_PI): HoldDef => {
    const h: HoldDef = { id, x, y, type, size, angle, role, color: c, seed: seed++ };
    holds.push(h);
    return h;
  };
  // the route: low starts, the jug band the climber idles on, a crux and the top
  add('s1', 'jug', -0.45, 1.05, 0.1, 'start');
  add('s2', 'jug', 0.15, 1.12, 0.095, 'start');
  for (const [id, x, y] of JUGS) add(id, 'jug', x, y, id === 'j3' || id === 'j1' ? 0.1 : 0.11, 'hand');
  for (const [id, x, y] of FEET) add(id, 'edge', x, y, 0.06, 'foot');
  add('h1', 'pinch', 0.62, 3.72, 0.07, 'hand', color, -0.2);
  add('h2', 'edge', -0.05, 3.95, 0.065, 'hand');
  add('t1', 'jug', 0.4, 4.22, 0.1, 'top');

  // other routes: lines of mixed holds in the other tape colours, kept clear of the climber
  const rng = new Rng(hashString('chiral-hq:title-wall:deco'));
  const colors = ROUTE_COLORS.map((c) => c.hex).filter((c) => c.toLowerCase() !== color.toLowerCase());
  rng.shuffle(colors);
  const types: HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket', 'foot'];
  const weights = [3, 3, 2, 2, 2, 1, 2];
  const sizeOf = (t: HoldType): number =>
    ({ jug: 0.09, edge: 0.06, crimp: 0.04, sloper: 0.1, pinch: 0.065, pocket: 0.05, foot: 0.028, volume: 0.3 })[t] * rng.range(0.8, 1.2);
  const clear = (x: number, y: number, size: number, gap: number): boolean => holds.every((h) => Math.hypot(h.x - x, h.y - y) > h.size + size + gap);
  const inBody = (x: number, y: number): boolean => x > -1.2 && x < 1.9 && y > 1.0 && y < 3.7;
  let n = 0;
  for (let r = 0; r < 8; r++) {
    const c = colors[r % colors.length];
    const x0 = -WALL_W / 2 + 0.35 + ((r + rng.range(0.1, 0.9)) / 8) * (WALL_W - 0.7);
    const amp = rng.range(0.1, 0.45);
    const ph = rng.range(0, 6.28);
    for (let k = 0; k < 15; k++) {
      const y = 0.25 + k * 0.29 + rng.range(-0.08, 0.08);
      const x = Math.max(-WALL_W / 2 + 0.15, Math.min(WALL_W / 2 - 0.15, x0 + amp * Math.sin(y * 1.1 + ph) + rng.range(-0.25, 0.25)));
      const type = rng.weighted(types, weights);
      const size = sizeOf(type);
      if (y > WALL_H - 0.15 || (inBody(x, y) && type !== 'foot' && type !== 'crimp')) continue;
      if (inBody(x, y) && rng.chance(0.6)) continue;
      if (!clear(x, y, size, 0.07)) continue;
      add(`d${n++}`, type, x, y, size, 'deco', c, -HALF_PI + rng.gauss() * 0.4);
    }
  }
  // two big volumes out to the sides
  add('v1', 'volume', -1.75, 2.35, 0.36, 'deco', WALL.volumeColors[0], -HALF_PI + 0.2);
  add('v2', 'volume', 1.95, 0.85, 0.3, 'deco', WALL.volumeColors[1], -HALF_PI - 0.3);

  return {
    id: 'title-wall',
    name: 'Steinbock Traverse',
    grade: 2,
    mode: 'boulder',
    wallAngle: 5,
    width: WALL_W,
    height: WALL_H,
    holds,
    color,
    seed: 7,
    startFeet: { LF: 'f1', RF: 'f2' },
    style: 'traverse',
  };
}

// ─────────────────────────────── the scene ───────────────────────────────

interface ActiveMove {
  limb: LimbId;
  holdId: string;
  /** shift: weight onto the side of the move (hands) · reach: the limb travels · settle: hips let go. */
  phase: 'shift' | 'reach' | 'settle';
  from: Vec2;
  to: Vec2;
  hip: Vec2 | null;
  t: number;
  dur: number;
}

/** Seconds of the weight shift before a hand move, and of the settle after it. */
const SHIFT_S = 1.1;
const SETTLE_S = 0.7;

export class TitleScene {
  private readonly svc: Services;
  private readonly boulder: BoulderDef;
  private readonly holds: Map<string, HoldDef>;
  private sim: ClimberSim;
  private active = false;
  private loaded = false;
  private framing: BackdropFraming = 'title';
  private guide: GuideState | null = null;

  // idle choreography
  private step = 0;
  private nextMove = 5;
  private move: ActiveMove | null = null;
  private guideT = 0;
  private readonly lookSent: Vec2 = { x: NaN, y: NaN };
  private readonly tmp: Vec2 = { x: 0, y: 0 };
  /** QA: moves that landed on their hold / that did not. */
  private done = 0;
  private missed = 0;
  private rehomes = 0;

  constructor(svc: Services) {
    this.svc = svc;
    this.boulder = titleWall();
    this.holds = new Map(this.boulder.holds.map((h) => [h.id, h] as const));
    this.sim = this.makeSim();
  }

  get state(): ClimberState {
    return this.sim.getState();
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentSim(): ClimberSim {
    return this.sim;
  }

  /** The demo wall is hand-set (synchronous): always ready. */
  get ready(): boolean {
    return true;
  }

  /** Where Steini stands and what he looks at (null in the locker close-up / while inactive). */
  get guideState(): GuideState | null {
    return this.active && this.framing !== 'locker' ? this.guide : null;
  }

  /** QA: idle moves that landed on their target hold, and ones that did not. */
  get moveStats(): { done: number; missed: number; rehomes: number } {
    return { done: this.done, missed: this.missed, rehomes: this.rehomes };
  }

  /** Kept for the boot sequence: the backdrop needs no background work any more. */
  prepare(): Promise<void> {
    return Promise.resolve();
  }

  /** Show the backdrop (idempotent): wall, climber up on the jugs, Steini, title camera. */
  enter(framing: BackdropFraming = 'title'): void {
    const wasActive = this.active;
    this.active = true;
    this.framing = framing;
    if (!this.loaded || !wasActive) this.load();
    this.applyCamera(!wasActive);
  }

  setFraming(f: BackdropFraming): void {
    if (this.framing === f) return;
    this.framing = f;
    if (this.active) this.applyCamera(false);
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    if (this.move?.phase === 'reach') this.sim.endDrag(this.move.limb);
    this.sim.setHipTarget(null);
    this.move = null;
    this.svc.renderer.setGuide(null);
    this.svc.renderer.setTitleFraming(null);
  }

  frame(dt: number): void {
    if (!this.active) return;
    // game time (the debug time scale speeds up headless QA), stepped in ≤ 0.1 s chunks
    let left = Math.min(Math.max(dt, 0), 0.1) * (this.svc.timeScale || 1);
    const st = this.sim.getState();
    while (left > 1e-6) {
      const d = Math.min(0.1, left);
      left -= d;
      this.choreograph(d);
      this.sim.step(d);
      if (this.lost(st)) {
        this.rehomes++;
        this.home();
      }
    }
    this.calm(st);
    const rd = Math.min(Math.max(dt, 0), 0.1);
    this.svc.renderer.updateClimber(st, rd);
    this.updateGuide(st, rd);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private makeSim(): ClimberSim {
    return new ClimberSim(this.boulder, { assist: 1, invincible: true, strength: 2.4, sweat: 0 });
  }

  private load(): void {
    const { renderer } = this.svc;
    renderer.loadBoulder(this.boulder);
    renderer.setRope(null, []);
    renderer.setHoldHighlights([]);
    renderer.setClimberVisible(true);
    renderer.setCameraFocusHint(null);
    this.sim = this.makeSim();
    this.home();
    this.step = 0;
    this.nextMove = 4 + Math.random() * 3;
    const st = this.sim.getState();
    this.calm(st);
    renderer.updateClimber(st, 0);
    // Steini on the mats left of the climber, so the camera sees him in 3/4 looking up
    const gx = Math.max(-WALL_W / 2 + 0.45, st.pelvis.x - 1.35);
    this.guide = { x: gx, depth: 1.45, pose: 'idle', lookAt: { x: st.chest.x, y: st.chest.y } };
    this.lookSent.x = st.chest.x;
    this.lookSent.y = st.chest.y;
    this.loaded = true;
  }

  /** Put the climber on the home stance (hands on the jug band, feet on the edges below). */
  private home(): void {
    this.move = null;
    this.sim.reset();
    this.sim.start();
    this.sim.respawn({ ...HOME });
    this.sim.step(0.1);
  }

  private applyCamera(instant: boolean): void {
    const { renderer } = this.svc;
    // title: the climber sits between the lockup and the PLAY stack; locker: close-up above the
    // sheet, just the player's climber (Steini steps out of the shot)
    const locker = this.framing === 'locker';
    renderer.setTitleFraming(locker ? FRAMING.locker : FRAMING.title);
    renderer.setGuide(locker ? null : this.guide);
    renderer.setCameraMode('title', instant ? { instant: true } : undefined);
  }

  /** Something went wrong (a limb came off, the phase changed): settle back on the home stance. */
  private lost(st: ClimberState): boolean {
    if (st.phase !== 'climbing') return true;
    if (this.move) return false;
    // both hands are on a hold or dipping into the chalk bag
    const hands = (['LH', 'RH'] as const).filter((l) => st.limbs[l].holdId || st.limbs[l].chalking || st.limbs[l].busy).length;
    return hands < 2;
  }

  /** The backdrop never shows tremor or pump (the sim barely produces any here anyway). */
  private calm(st: ClimberState): void {
    st.shake = 0;
    st.pump = 0;
    for (const l of LIMBS) {
      const L = st.limbs[l];
      L.shake = 0;
      if (L.pump !== undefined) L.pump = 0;
    }
  }

  /**
   * One slow move every 8–12 s: a hand move first shifts the weight toward its side (the way a
   * climber loads the opposite foot before reaching), then the limb travels along a gentle eased
   * arc and is dropped onto the hold, then the hips settle.
   */
  private choreograph(dt: number): void {
    const m = this.move;
    if (m) {
      m.t += dt;
      if (m.phase === 'shift') {
        if (m.t < SHIFT_S) return;
        if (!this.sim.beginDrag(m.limb)) {
          this.finishMove(false);
          return;
        }
        const L = this.sim.getState().limbs[m.limb];
        m.from = { x: L.pos.x, y: L.pos.y };
        m.dur = 0.95 + Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) * 1.1;
        m.phase = 'reach';
        m.t = 0;
        return;
      }
      if (m.phase === 'reach') {
        const k = Math.min(1, m.t / m.dur);
        const e = k * k * k * (k * (k * 6 - 15) + 10); // smootherstep
        const lift = Math.sin(Math.PI * e) * (m.limb === 'LF' || m.limb === 'RF' ? 0.05 : 0.08);
        this.tmp.x = m.from.x + (m.to.x - m.from.x) * e;
        this.tmp.y = m.from.y + (m.to.y - m.from.y) * e + lift;
        this.sim.dragTo(m.limb, this.tmp);
        if (m.t >= m.dur + 0.15) {
          this.sim.endDrag(m.limb);
          if (this.sim.getState().limbs[m.limb].holdId === m.holdId) this.done++;
          else this.missed++;
          m.phase = 'settle';
          m.t = 0;
        }
        return;
      }
      if (m.t >= SETTLE_S) this.finishMove(true);
      return;
    }
    this.nextMove -= dt;
    if (this.nextMove > 0) return;
    const st = this.sim.getState();
    if (st.limbs.LH.chalking || st.limbs.RH.chalking || st.limbs.LH.busy || st.limbs.RH.busy) {
      this.nextMove = 1;
      return;
    }
    const next = LOOP[this.step % LOOP.length];
    this.step++;
    if ('chalk' in next) {
      if (!this.sim.chalkUp(next.chalk)) this.nextMove = 2;
      else this.nextMove = 7.5 + Math.random() * 3.5;
      return;
    }
    const h = this.holds.get(next.to);
    const L = st.limbs[next.limb];
    if (!h || L.holdId === h.id) {
      this.nextMove = 1;
      return;
    }
    const to = contactPoint(h, LIMB_IDX[next.limb], false, { x: 0, y: 0 });
    const hand = next.limb === 'LH' || next.limb === 'RH';
    let hip: Vec2 | null = null;
    if (hand) {
      // weight toward the move: hips under the midpoint of the staying hand and the target
      const other = st.limbs[next.limb === 'LH' ? 'RH' : 'LH'].pos;
      hip = { x: (other.x + to.x) / 2, y: st.pelvis.y };
      this.sim.setHipTarget(hip);
    }
    this.move = { limb: next.limb, holdId: h.id, phase: hand ? 'shift' : 'reach', from: { x: L.pos.x, y: L.pos.y }, to, hip, t: 0, dur: 1 };
    if (!hand) {
      if (!this.sim.beginDrag(next.limb)) {
        this.finishMove(false);
        return;
      }
      this.move.dur = 0.95 + Math.hypot(to.x - L.pos.x, to.y - L.pos.y) * 1.1;
    }
  }

  private finishMove(ok: boolean): void {
    if (this.move?.hip) this.sim.setHipTarget(null);
    this.move = null;
    // the next move starts ~8–12 s after this one started (a move takes ~3 s)
    this.nextMove = ok ? 5.5 + Math.random() * 3.5 : 1.5;
  }

  /** Steini keeps his eyes on the climber's chest (pushed at ~5 Hz, only when it moved). */
  private updateGuide(st: ClimberState, dt: number): void {
    const g = this.guide;
    if (!g || this.framing === 'locker') return;
    this.guideT += dt;
    if (this.guideT < 0.2) return;
    this.guideT = 0;
    if (Math.hypot(st.chest.x - this.lookSent.x, st.chest.y - this.lookSent.y) < 0.02) return;
    this.lookSent.x = st.chest.x;
    this.lookSent.y = st.chest.y;
    g.lookAt = { x: st.chest.x, y: st.chest.y };
    this.svc.renderer.setGuide(g);
  }
}

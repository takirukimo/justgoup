// SimDriver: steps a ClimberSim for the app, re-broadcasts its events on the bus and turns every
// sim event into feel: sound, chalk and dust, camera kicks and haptics. Limb releases from the
// touch controls reach the bus directly (LimbControls emits endDrag's events), so all reactions
// hang off the bus and fire exactly once per event, whoever produced it.
//
// The climber's voice goes through the audio exertion director (GameAudio.exert): it is voiced
// only on genuinely hard moments (an overload while moving, a reach at the anatomical edge, a
// slip, a dyno launch / catch, a deep-pump warning) with randomised cooldowns, and otherwise
// breathes harder. Nothing here repeats a grunt on a timer.

import type { RendererAPI, SimEvent } from '../core/contracts';
import { bus } from '../core/events';
import { clamp } from '../core/math';
import type { ClimberState, HoldDef, LimbId, Vec2 } from '../core/types';
import { isHand } from '../core/types';
import { GAME } from '../config/tuning';
import type { ClimberSim } from '../game/climber-sim';
import { usableByHand } from '../game/holds';
import type { Services } from './services';

export interface DriverOptions {
  /** Aim the follow camera + the climber's gaze at the next hold while no limb is dragged. */
  lookAhead?: boolean;
  /** Session-specific reaction, after the shared feedback. */
  onEvent?: (e: SimEvent, state: ClimberState) => void;
}

const LOOK_REFRESH = 0.3;
/** A dragged hand stretched past this fraction of its reach grabs "at the anatomical edge". */
const REACH_EDGE = 0.95;
/** Seconds after a limb move that an overload still counts as "while moving". */
const MOVE_WINDOW = 1.1;
/** Delay before the chalk-bag puff: the hand has to get to the bag first. */
const CHALK_PUFF_DELAY = 0.42;
const LIMB_INDEX: Record<LimbId, number> = { LH: 0, RH: 1, LF: 2, RF: 3 };

/**
 * Effects the world renderer may offer beyond RendererAPI['fx'] (used when present, otherwise the
 * driver falls back to chalkPuff / cameraShake).
 */
interface FxExtras {
  /** A hand dipping into the chalk bag (p = the bag). */
  chalkDip?(p: Vec2, intensity?: number): void;
  /** The chalk cloud of a hand slapping onto a hold after a dyno. */
  catchBurst?(p: Vec2, intensity?: number): void;
}

export class SimDriver {
  readonly sim: ClimberSim;
  /** While paused the sim is not stepped (the scene keeps rendering). */
  paused = false;
  /** Point the look-ahead prefers (e.g. an active hint), or null. */
  lookOverride: Vec2 | null = null;

  private readonly svc: Services;
  private readonly opts: DriverOptions;
  private readonly off: () => void;
  private readonly holds: Map<string, HoldDef>;
  private readonly handHolds: HoldDef[];
  private disposed = false;

  // feedback state
  private shakePulse = 0;
  private lastMove = -10;
  /** Furthest reach ratio of each limb during its current drag. */
  private readonly dragReach = [0, 0, 0, 0];
  private readonly pendingPuffs: { at: number; limb: LimbId }[] = [];
  private clock = 0;
  private lookT = LOOK_REFRESH;
  private readonly look: Vec2 = { x: 0, y: 0 };
  private lookOn = false;
  private lookSet = false;
  private readonly lookSent: Vec2 = { x: NaN, y: NaN };

  constructor(svc: Services, sim: ClimberSim, opts: DriverOptions = {}) {
    this.svc = svc;
    this.sim = sim;
    this.opts = opts;
    this.holds = new Map(sim.boulder.holds.map((h) => [h.id, h] as const));
    this.handHolds = sim.boulder.holds.filter((h) => usableByHand(h) && h.role !== 'deco');
    this.off = bus.on('sim:event', (e) => this.handle(e));
  }

  get state(): ClimberState {
    return this.sim.getState();
  }

  /** Advance the sim by `dt` (already time-scaled), in ≤ 0.1 s chunks, forwarding its events. */
  step(dt: number): void {
    if (this.paused || this.disposed) return;
    this.clock += dt;
    let left = dt;
    while (left > 1e-6) {
      const d = Math.min(0.1, left);
      left -= d;
      const events = this.sim.step(d);
      for (let i = 0; i < events.length; i++) bus.emit('sim:event', events[i]);
    }
    this.continuous(dt);
  }

  /** Pose the 3D climber + HUD + the effort layer from the sim state. */
  render(dt: number): void {
    if (this.disposed) return;
    const st = this.sim.getState();
    const { renderer, audio } = this.svc;
    if (this.opts.lookAhead) this.updateLook(st, dt);
    renderer.updateClimber(st, dt);
    if (this.paused || st.phase !== 'climbing') audio.setIntensity(0, st.phase === 'climbing' ? st.pump * 0.5 : 0);
    else audio.setIntensity(st.tension, st.pump);
  }

  /** Recompute the look-ahead target now (after a move). */
  refreshLook(): void {
    this.lookT = LOOK_REFRESH;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    if (this.lookSet && !this.svc.controls.dragging) this.svc.renderer.setCameraFocusHint(null);
    this.svc.audio.setIntensity(0, 0);
  }

  // ───────────────────────────── feedback ─────────────────────────────

  /** Camera kick, much calmer with the reduced-motion setting. */
  private kick(amount: number): void {
    this.svc.renderer.fx.cameraShake(this.svc.profile().settings.reducedMotion ? amount * 0.15 : amount);
  }

  private get fx(): RendererAPI['fx'] & FxExtras {
    return this.svc.renderer.fx as RendererAPI['fx'] & FxExtras;
  }

  private pan(x: number): number {
    return clamp(x / 2.4, -1, 1) * 0.7;
  }

  private handle(e: SimEvent): void {
    if (this.disposed) return;
    const st = this.sim.getState();
    const { audio, renderer } = this.svc;
    switch (e.type) {
      case 'grab': {
        const L = st.limbs[e.limb];
        const pan = this.pan(L.pos.x);
        if (isHand(e.limb)) {
          const bad = e.quality < 0.45;
          audio.play(bad ? 'grab-bad' : 'grab', { pan, volume: 0.75 + 0.25 * e.quality });
          renderer.fx.chalkPuff(L.pos, 0.45 + 0.5 * clamp(e.quality, 0, 1));
          audio.haptic(bad ? [8, 40, 8] : 10);
          // a hand that had to stretch to the very edge of its reach for it
          const reach = this.dragReach[LIMB_INDEX[e.limb]];
          if (reach >= REACH_EDGE) audio.exert('reach-edge', clamp((reach - REACH_EDGE) / 0.08, 0, 1) * 0.6 + (1 - clamp(e.quality, 0, 1)) * 0.4, { pan });
        } else {
          audio.play('foot', { pan });
          audio.haptic(6);
        }
        this.moved(e.limb);
        this.lookT = LOOK_REFRESH;
        break;
      }
      case 'release':
        audio.play('release', { pan: this.pan(st.limbs[e.limb].pos.x), volume: 0.45 });
        this.lastMove = this.clock;
        break;
      case 'return':
        audio.play('grab', { pan: this.pan(st.limbs[e.limb].pos.x), volume: 0.4, pitch: 0.92 });
        this.moved(e.limb);
        break;
      case 'smear':
        audio.play('smear', { pan: this.pan(st.limbs[e.limb].pos.x) });
        audio.haptic(6);
        this.moved(e.limb);
        break;
      case 'slip': {
        const pan = this.pan(st.limbs[e.limb].pos.x);
        audio.play('slip', { pan });
        audio.exert('slip', 0.7, { pan });
        this.kick(0.38);
        audio.haptic([22, 30, 22]);
        break;
      }
      case 'overload': {
        const L = st.limbs[e.limb];
        const moving = this.isMoving(st);
        const sev = clamp((L.stress - 1) / 0.6, 0, 1);
        audio.exert(moving ? 'move-overload' : 'overload', sev, { pan: this.pan(L.pos.x) });
        break;
      }
      case 'shake-start':
        audio.exert('shake', clamp((st.tension - 0.7) / 0.6, 0, 1));
        audio.haptic(16);
        break;
      case 'pump-warning':
        audio.exert('pump-warning', clamp((e.pump - 0.7) / 0.3, 0, 1), { pan: this.pan(st.limbs[e.limb].pos.x) });
        audio.haptic([8, 70, 8]);
        break;
      case 'chalk-start': {
        const L = st.limbs[e.limb];
        audio.play('chalk', { pan: this.pan(L.pos.x), volume: 0.85 });
        this.pendingPuffs.push({ at: this.clock + CHALK_PUFF_DELAY, limb: e.limb });
        break;
      }
      case 'chalk-done': {
        const L = st.limbs[e.limb];
        // blow the excess off the fingertips
        audio.play('blow', { pan: this.pan(L.pos.x), volume: 0.55 });
        renderer.fx.chalkPuff(L.pos, 0.28);
        break;
      }
      case 'shake-out-start':
        audio.exhale(0.75);
        break;
      case 'technique':
        audio.play('tick', { pan: this.pan(st.limbs[e.limb].pos.x), volume: 0.45, pitch: e.technique === 'heel' ? 0.85 : e.technique === 'toe' ? 1.1 : 1 });
        break;
      case 'dyno-start':
        audio.play('whoosh', { volume: e.kind === 'dyno' ? 0.4 : 0.26, pitch: 1.35 });
        audio.exert('dyno-start', clamp(e.power, 0, 1.4) / 1.4);
        audio.haptic(12);
        this.kick(e.kind === 'dyno' ? 0.12 : 0.06);
        for (const l of e.limbs) this.dragReach[LIMB_INDEX[l]] = 0;
        this.lastMove = this.clock;
        break;
      case 'dyno-catch': {
        const hand = e.limbs[0] ?? 'RH';
        const L = st.limbs[hand];
        const q = clamp(e.quality, 0, 1);
        audio.play('catch', { pan: this.pan(L.pos.x), volume: 0.75 + 0.25 * (1 - q) });
        if (this.fx.catchBurst) this.fx.catchBurst(L.pos, 0.6 + 0.4 * (1 - q));
        else renderer.fx.chalkPuff(L.pos, 1.0 + 0.3 * (1 - q));
        this.kick(0.24 + 0.3 * (1 - q) + (e.limbs.length > 1 ? 0.1 : 0));
        audio.haptic([18, 24, 34]);
        audio.exert('dyno-catch', 1 - q, { pan: this.pan(L.pos.x) });
        break;
      }
      case 'dyno-miss': {
        const hand = e.limbs[0] ?? 'RH';
        const L = st.limbs[hand];
        audio.play('grab-bad', { pan: this.pan(L.pos.x), volume: 0.9 });
        audio.exert('dyno-miss', 1);
        this.kick(0.22);
        audio.haptic([20, 30, 20]);
        // a miss with no hand left falls: the sim's 'fall' event takes the session into the fall flow
        break;
      }
      case 'fall':
        audio.play('fall');
        audio.haptic(40);
        this.kick(0.2);
        break;
      case 'land': {
        const k = clamp(e.impact / 7, 0.35, 1);
        audio.play('land', { volume: k });
        renderer.fx.dust({ x: st.com.x, y: GAME.padHeight }, 0.5 + k * 0.9);
        this.kick(clamp(e.impact / 9, 0.2, 0.8));
        audio.haptic(Math.round(30 + 40 * k));
        break;
      }
      case 'caught':
        audio.play('rope-catch', { volume: clamp(0.6 + e.fallDistance / 8, 0.6, 1) });
        this.kick(clamp(0.3 + e.fallDistance / 8, 0.3, 0.9));
        audio.haptic([36, 30, 64]);
        break;
      case 'top-touch':
        audio.play('top-touch');
        audio.haptic(14);
        break;
      case 'clip':
        audio.play('release', { volume: 0.3, pitch: 1.2 });
        break;
      case 'clip-done':
        audio.play('clip');
        audio.haptic(16);
        this.lookT = LOOK_REFRESH;
        break;
      default:
        break;
    }
    this.opts.onEvent?.(e, st);
  }

  /** A limb finished a move (grab, smear, return): its drag is over. */
  private moved(limb: LimbId): void {
    this.lastMove = this.clock;
    this.dragReach[LIMB_INDEX[limb]] = 0;
  }

  /** The player is moving: a limb is dragged, or one just moved. */
  private isMoving(st: ClimberState): boolean {
    if (this.clock - this.lastMove < MOVE_WINDOW) return true;
    for (const l of LIMB_ORDER) if (st.limbs[l].dragging) return true;
    return false;
  }

  /** Feedback that depends on state, not on events: tremor haptics, drag reach, the chalk-bag puff. */
  private continuous(dt: number): void {
    const st = this.sim.getState();
    if (this.pendingPuffs.length) {
      for (let i = this.pendingPuffs.length - 1; i >= 0; i--) {
        const p = this.pendingPuffs[i];
        if (this.clock < p.at) continue;
        this.pendingPuffs.splice(i, 1);
        const L = st.limbs[p.limb];
        if (st.phase !== 'climbing') continue;
        if (this.fx.chalkDip) this.fx.chalkDip(L.pos, 0.7);
        else this.svc.renderer.fx.chalkPuff(L.pos, 0.6);
      }
    }
    if (st.phase !== 'climbing') return;
    for (let i = 0; i < 4; i++) {
      const L = st.limbs[LIMB_ORDER[i]];
      if (L.dragging && L.reachRatio > this.dragReach[i]) this.dragReach[i] = L.reachRatio;
    }
    if (st.shake > 0.05) {
      this.shakePulse -= dt;
      if (this.shakePulse <= 0) {
        this.shakePulse = 0.42 - 0.2 * clamp(st.shake, 0, 1);
        this.svc.audio.haptic(Math.round(6 + 10 * clamp(st.shake, 0, 1)));
      }
    } else this.shakePulse = 0;
  }

  // ───────────────────────────── look-ahead ─────────────────────────────

  private updateLook(st: ClimberState, dt: number): void {
    const { controls, renderer } = this.svc;
    if (st.phase !== 'climbing' || controls.dragging) {
      // the controls own the focus hint while a limb is dragged (and clear it on release)
      if (st.phase !== 'climbing' && this.lookSet) renderer.setCameraFocusHint(null);
      this.lookSet = false;
      return;
    }
    this.lookT += dt;
    if (this.lookT >= LOOK_REFRESH) {
      this.lookT = 0;
      this.lookOn = this.nextHold(st, this.look);
    }
    const target = this.lookOverride ?? (this.lookOn ? this.look : null);
    // only push changes: the renderer copies the hint, so an unchanged one would allocate per frame
    if (target && this.lookSet && target.x === this.lookSent.x && target.y === this.lookSent.y) return;
    if (!target && !this.lookSet) return;
    renderer.setCameraFocusHint(target);
    this.lookSet = !!target;
    if (target) {
      this.lookSent.x = target.x;
      this.lookSent.y = target.y;
    }
  }

  /** The next route hand hold above the higher hand, nearest the body line. */
  private nextHold(st: ClimberState, out: Vec2): boolean {
    let handY = -Infinity;
    for (const l of ['LH', 'RH'] as const) {
      const id = st.limbs[l].holdId;
      const h = id ? this.holds.get(id) : undefined;
      handY = Math.max(handY, h ? h.y : st.limbs[l].pos.y);
    }
    let best: HoldDef | null = null;
    let bs = Infinity;
    const cx = st.chest.x;
    for (const h of this.handHolds) {
      const dy = h.y - handY;
      if (dy < 0.12 || dy > 1.6) continue;
      const s = dy + Math.abs(h.x - cx) * 0.6;
      if (s < bs) {
        bs = s;
        best = h;
      }
    }
    if (!best) return false;
    out.x = best.x;
    out.y = best.y;
    return true;
  }
}

const LIMB_ORDER: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];

export const LIMB_WORD: Record<LimbId, string> = { LH: 'LEFT HAND', RH: 'RIGHT HAND', LF: 'LEFT FOOT', RF: 'RIGHT FOOT' };

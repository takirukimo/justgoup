// BetaBot: an autopilot that climbs a planned beta through the sim's public input API, exactly like a
// player would (shift the hips, drag a limb to the hold, release when it snaps). Used by the tests to
// prove that planned betas are executable, and usable as an attract-mode / demo climber.
// It manages its body like a climber (Phase B): before a hand move it chalks that hand when the chalk
// has worn off (lead routes, ≈ every 4–5 moves) and, when a forearm is pumped, it lets go with it and
// shakes it out by the side (the other hand holding) before re-gripping and going on. Thrown moves of the
// beta (BetaMove.dyno: deadpoints and double dynos) are launched from the planned stance with
// ClimberSimAPI.dyno and caught in flight; the following steps put the cut limbs back on.

import type { HoldDef, LimbId, Vec2 } from '../core/types';
import type { BetaMove, ClimberSimAPI, SimEvent } from '../core/contracts';
import { clamp } from '../core/math';
import { contactPoint, LIMB_INDEX } from './holds';
import { planBetaDetailed, SMEAR_ID, type PlanResult, type PlanStep } from './solver';

type BotPhase = 'prep' | 'drag' | 'hold' | 'settle' | 'clip' | 'clipwait' | 'recover' | 'chalk' | 'shake' | 'regrab' | 'fly' | 'done' | 'failed';

/** Body management thresholds of the bot. */
export const BOT = {
  /** Chalk the hand about to move when its friction is below this. */
  chalkBelow: 0.45,
  /** Shake a forearm out when its pump is above this … */
  shakeAbove: 0.55,
  /** … until it is below this (or shakeMax seconds pass, or the stance gets strenuous). */
  shakeUntil: 0.22,
  shakeMax: 20,
  /** Only from a calm stance. */
  calmTension: 0.75,
  /**
   * … where the other hand can take this hand's load too while it is off (chalk dip / shake-out): the
   * other hand's stress with both hands' loads on it must stay under this (a dip on a steep wall from a
   * poor hold is how a lead climber comes off).
   */
  freeHandMax: 0.82,
  /** Launch power of a planned deadpoint / dyno (1 = the ideal throw). */
  throwPower: 1.06,
} as const;

export interface BetaBotOptions {
  /** Seconds to shift the hips before a move (max). */
  prepTime?: number;
  /** Seconds to drag a limb to its target. */
  dragTime?: number;
  /** Seconds to settle after a move. */
  settleTime?: number;
  /** Re-plan from the live stance when a move fails. */
  replan?: boolean;
  /** Use the planner's hip positions (true) or leave the hips to the climber's posture (false). */
  useHips?: boolean;
  /** Chalk up and shake out like a climber (needs ClimberSimAPI.chalkUp / shakeOut). Default true. */
  manageBody?: boolean;
}

export class BetaBot {
  readonly sim: ClimberSimAPI;
  private plan: PlanResult | null;
  private idx = 0;
  private phase: BotPhase = 'prep';
  private t = 0;
  private from: Vec2 = { x: 0, y: 0 };
  private target: Vec2 = { x: 0, y: 0 };
  private hold: HoldDef | null = null;
  private readonly holds: Map<string, HoldDef>;
  private readonly opts: Required<BetaBotOptions>;
  private replans = 0;
  /** Moves completed. */
  moves = 0;
  /** Chalk dips and shake-outs the bot made. */
  chalks = 0;
  shakes = 0;
  /** Deadpoints / dynos thrown. */
  throws = 0;
  /** A throw cut the feet: put them back on at once. */
  private fastFeet = false;
  /** Extra launch power after a short throw (reset on a catch). */
  private throwBoost = 0;
  /** Missed throws (after two, re-plans look for a static beta first). */
  private misses = 0;
  /** Hands that caught the throw in flight so far. */
  private readonly caught: LimbId[] = [];
  readonly log: string[] = [];

  constructor(sim: ClimberSimAPI, plan?: PlanResult | null, opts: BetaBotOptions = {}) {
    this.sim = sim;
    this.holds = new Map(sim.boulder.holds.map((h) => [h.id, h] as const));
    this.plan = plan === undefined ? planBetaDetailed(sim.boulder, { maxNodes: sim.boulder.mode === 'rope' ? 2600 : 900 }) : plan;
    this.opts = {
      prepTime: opts.prepTime ?? 0.55,
      dragTime: opts.dragTime ?? 0.4,
      settleTime: opts.settleTime ?? 0.3,
      replan: opts.replan ?? true,
      useHips: opts.useHips ?? true,
      manageBody: opts.manageBody ?? true,
    };
    if (!this.plan) this.phase = 'failed';
  }

  get done(): boolean {
    return this.phase === 'done';
  }
  get failed(): boolean {
    return this.phase === 'failed';
  }
  /** The move the bot is working on (for highlights), or null. */
  get current(): BetaMove | null {
    return this.plan && this.idx < this.plan.steps.length ? this.plan.steps[this.idx].move : null;
  }

  private step(): PlanStep | null {
    return this.plan && this.idx < this.plan.steps.length ? this.plan.steps[this.idx] : null;
  }

  /** Drive the sim for dt seconds. Call before sim.step(dt) each frame. */
  update(dt: number, events: readonly SimEvent[] = []): void {
    const sim = this.sim;
    const s = sim.getState();
    for (const e of events) if (e.type === 'fall') this.fail('fell: ' + e.reason);
    if (this.phase === 'done' || this.phase === 'failed') return;
    if (s.phase === 'topped') {
      this.finish();
      return;
    }
    if (s.phase !== 'climbing') return;
    const st = this.step();
    if (!st && this.recovering && this.phase === 'prep') {
      // the feet are back on after a throw went wrong: plan the rest from here
      this.recovering = false;
      this.replan();
      return;
    }
    if (!st && this.phase !== 'clip' && this.phase !== 'clipwait') {
      // all moves done: wait on the top (rope: clip the anchor first)
      this.t += dt;
      if (this.t > 4) this.fail('no top after beta');
      return;
    }
    const limb: LimbId = st ? st.move.limb : this.clipLimb;
    this.t += dt;
    if (this.phase === 'recover') {
      // a missed move left a hand busy (it clipped a draw instead of grabbing): wait for the rope
      // to go in and the hand to come back, then re-plan from the stance the climber is really in
      if (!s.limbs.LH.busy && !s.limbs.RH.busy && this.t > 0.1) this.replan();
      else if (this.t > 3) this.fail('stuck after a missed move');
      return;
    }
    if (this.phase === 'chalk' || this.phase === 'shake' || this.phase === 'regrab') {
      this.bodyStep(s);
      return;
    }
    if (!st && this.phase !== 'clip' && this.phase !== 'clipwait') return;
    switch (this.phase) {
      case 'prep': {
        if (!st) break;
        // still flying (a throw's catch settles the body for a moment): wait until the climber is back on
        if (s.airborne) break;
        // right after a caught throw the cut feet go straight back on (no weight shift, a quick placement)
        if (this.fastFeet) {
          if (s.limbs.LF.holdId || s.limbs.LF.smearing) {
            if (s.limbs.RF.holdId || s.limbs.RF.smearing) this.fastFeet = false;
          }
          if (this.fastFeet && (limb === 'LF' || limb === 'RF') && !s.limbs[limb].holdId && !s.limbs[limb].smearing) {
            this.beginMove(st, limb);
            return;
          }
        }
        if (this.t < dt * 1.5 && this.opts.manageBody && this.manage(limb)) return;
        // shift the weight toward the reach position while still on four limbs, then let go
        if (this.opts.useHips) sim.setHipTarget({ x: st.reachPose.px, y: st.reachPose.py });
        if (this.prepTension < 0) this.prepTension = s.tension;
        const d = Math.hypot(s.pelvis.x - st.reachPose.px, s.pelvis.y - st.reachPose.py);
        const v = Math.hypot(s.velocity.x, s.velocity.y);
        // the reach position may not be reachable on four limbs (the moving limb's envelope holds
        // the body back): when the shift starts to hurt, let go and make the move from here
        const strained = this.t > 0.12 && s.tension > Math.max(0.8, this.prepTension + 0.22);
        if (this.t > this.opts.prepTime || strained || (this.t > 0.12 && (d < 0.05 || (v < 0.05 && this.t > 0.3)))) {
          this.prepTension = -1;
          if (st.move.dyno) this.launch(st);
          else this.beginMove(st, limb);
        }
        break;
      }
      case 'fly': {
        if (!st) break;
        // the throw is in the air: wait for the catch (or the miss) of every throwing hand — a double
        // dyno can stick with one hand and come up short with the other
        const throwing: LimbId[] = st.move.dyno === 'both' ? ['LH', 'RH'] : [st.move.dyno === 'RH' ? 'RH' : st.move.dyno === 'LH' ? 'LH' : st.move.limb];
        for (const e of events) {
          if (e.type === 'dyno-catch') for (const l of e.limbs) if (!this.caught.includes(l)) this.caught.push(l);
          if (e.type === 'dyno-miss') {
            this.log.push(`dyno missed ${e.limbs.join('+')}->${st.move.holdId} (${e.reason})`);
            // throw harder after a short one, softer after ripping off; a second miss looks for a static way
            this.throwBoost = clamp(this.throwBoost + (e.reason === 'short' ? 0.1 : -0.05), -0.1, 0.3);
            this.misses++;
            this.caught.length = 0;
            // the throw cut the feet: whatever comes next, they go straight back on
            this.fastFeet = (!s.limbs.LF.holdId && !s.limbs.LF.smearing) || (!s.limbs.RF.holdId && !s.limbs.RF.smearing);
            // a deadpoint that fell back onto its hold (or half a double dyno that stuck) goes on from the
            // live stance
            if (s.phase === 'climbing' && (s.limbs.LH.holdId || s.limbs.RH.holdId)) this.retry();
            else this.fail('dyno missed');
            return;
          }
        }
        if (throwing.every((l) => this.caught.includes(l))) {
          this.caught.length = 0;
          this.moves++;
          this.throwBoost = 0;
          this.fastFeet = !!st.dyno && st.dyno.cut.some((l) => l === 'LF' || l === 'RF');
          if (this.opts.useHips) sim.setHipTarget({ x: st.pose.px, y: st.pose.py });
          this.phase = 'settle';
          this.t = 0;
          return;
        }
        if (this.t > 2.5) this.fail('dyno: no catch');
        break;
      }
      case 'drag': {
        if (!st) break;
        if (this.opts.useHips) sim.setHipTarget({ x: st.reachPose.px, y: st.reachPose.py });
        const k = Math.min(1, this.t / (this.fastFeet ? Math.min(0.22, this.opts.dragTime) : this.opts.dragTime));
        const e = k * k * (3 - 2 * k);
        sim.dragTo(limb, { x: this.from.x + (this.target.x - this.from.x) * e, y: this.from.y + (this.target.y - this.from.y) * e });
        if (k >= 1) {
          this.phase = 'hold';
          this.t = 0;
        }
        break;
      }
      case 'hold': {
        if (!st) break;
        if (this.opts.useHips) {
          // the live body can settle a few cm short of the planned reach pose (its dynamics balance where
          // the static plan doesn't quite): when the hand still comes up short, pull the hips on past
          // the pose by that lag, as a player drags the hip handle further
          const k = clamp((this.t - 0.15) / 0.4, 0, 1) * 1.5;
          const lx = clamp(st.reachPose.px - s.pelvis.x, -0.12, 0.12) * k;
          const ly = clamp(st.reachPose.py - s.pelvis.y, -0.12, 0.12) * k;
          sim.setHipTarget({ x: st.reachPose.px + lx, y: st.reachPose.py + ly });
        }
        sim.dragTo(limb, this.target);
        const ok = this.hold ? sim.snapCandidate(limb, this.target)?.id === this.hold.id : true;
        if (ok || this.t > 1.0) {
          const ev = sim.endDrag(limb);
          const grabbed = ev.some((x) => (x.type === 'grab' && x.holdId === this.hold?.id) || (x.type === 'smear' && !this.hold));
          // a planned smear that landed on a foothold instead is just as good: carry on from the live stance
          if (!grabbed && !this.hold && (limb === 'LF' || limb === 'RF') && ev.some((x) => x.type === 'grab')) {
            this.moves++;
            this.log.push(`smear ${limb} landed on a hold`);
            this.replan();
            return;
          }
          if (!grabbed) {
            this.log.push(`miss ${limb}->${st.move.holdId} (${ev.map((x) => x.type).join(',')})`);
            // the limb went back where it was: from this stance, try another first move
            this.missed.push({ stance: this.stanceKey(), limb, holdId: st.move.holdId });
            this.retry();
            return;
          }
          this.moves++;
          if (this.opts.useHips) sim.setHipTarget({ x: st.pose.px, y: st.pose.py });
          this.phase = 'settle';
          this.t = 0;
        }
        break;
      }
      case 'settle': {
        if (!st) break;
        if (this.t > (this.fastFeet ? 0.04 : this.opts.settleTime)) {
          const clip = st.clip;
          this.idx++;
          this.phase = 'prep';
          this.t = 0;
          if (clip) this.startClip(clip);
        }
        break;
      }
      case 'clip': {
        if (this.clipHip) sim.setHipTarget(this.clipHip);
        const k = Math.min(1, this.t / this.opts.dragTime);
        sim.dragTo(this.clipLimb, { x: this.from.x + (this.target.x - this.from.x) * k, y: this.from.y + (this.target.y - this.from.y) * k });
        // reach for the draw until it can be clipped (the body follows the reaching hand)
        if ((k >= 1 && sim.clipCandidate(this.clipLimb, this.target)) || this.t > 1.6) {
          const ev = sim.endDrag(this.clipLimb);
          if (!ev.some((x) => x.type === 'clip')) {
            this.log.push(`clip missed (${ev.map((x) => x.type).join(',')})`);
            this.phase = 'prep';
            this.t = 0;
            return;
          }
          this.phase = 'clipwait';
          this.t = 0;
        }
        break;
      }
      case 'clipwait': {
        if (this.clipHip) sim.setHipTarget(this.clipHip);
        if (!s.limbs[this.clipLimb].busy && this.t > 0.1) {
          this.clips++;
          this.clipHip = null;
          this.phase = 'prep';
          this.t = 0;
        }
        break;
      }
    }
  }

  /** Tension when the current weight shift began (−1 = not shifting). */
  private prepTension = -1;
  private bodyHand: 'LH' | 'RH' = 'LH';
  private bodyHold: HoldDef | null = null;

  /**
   * At the start of a move: chalk the hand that is about to move when its chalk is worn, or shake out
   * a pumped forearm, from a calm stance with the other hand on. True when it started one.
   */
  private manage(limb: LimbId): boolean {
    const sim = this.sim;
    const s = sim.getState();
    if (s.tension > BOT.calmTension) return false;
    const hand = limb === 'LH' || limb === 'RH' ? limb : null;
    if (hand && sim.chalkUp && (s.limbs[hand].friction ?? 1) < BOT.chalkBelow && s.limbs[hand].holdId && this.canFree(hand, s)) {
      const held = s.limbs[hand].holdId;
      if (sim.chalkUp(hand)) {
        this.bodyHand = hand;
        this.bodyHold = held ? this.holds.get(held) ?? null : null;
        this.chalks++;
        this.phase = 'chalk';
        this.t = 0;
        return true;
      }
    }
    if (sim.shakeOut) {
      // the more pumped forearm first (the other hand holds meanwhile; the move comes after the re-grip)
      const order: ('LH' | 'RH')[] = (s.limbs.LH.pump ?? 0) >= (s.limbs.RH.pump ?? 0) ? ['LH', 'RH'] : ['RH', 'LH'];
      for (const h of order) {
        if ((s.limbs[h].pump ?? 0) < BOT.shakeAbove) continue;
        const held = s.limbs[h].holdId;
        if (!held || !this.canFree(h, s)) continue;
        if (sim.shakeOut(h)) {
          this.bodyHand = h;
          this.bodyHold = this.holds.get(held) ?? null;
          this.shakes++;
          this.phase = 'shake';
          this.t = 0;
          return true;
        }
      }
    }
    return false;
  }

  /** Can the other hand hold this one's load as well while this one is off the wall for a moment? */
  private canFree(hand: 'LH' | 'RH', s: ReturnType<ClimberSimAPI['getState']>): boolean {
    const me = s.limbs[hand];
    const o = s.limbs[hand === 'LH' ? 'RH' : 'LH'];
    if (!o.holdId || o.busy || !(o.capacity > 0)) return false;
    return (o.load + me.load) / o.capacity <= BOT.freeHandMax;
  }

  /** Chalking, shaking out and re-gripping after a shake-out. */
  private bodyStep(s: ReturnType<ClimberSimAPI['getState']>): void {
    const sim = this.sim;
    const hand = this.bodyHand;
    const L = s.limbs[hand];
    switch (this.phase) {
      case 'chalk':
        if (L.busy && this.t < 3) return;
        if (!L.holdId) {
          // the hold drifted out of reach while chalking: plan from where the climber is
          this.replan();
          return;
        }
        this.phase = 'prep';
        this.t = 0;
        return;
      case 'shake': {
        if ((L.pump ?? 0) > BOT.shakeUntil && this.t < BOT.shakeMax && s.tension < 0.95) return;
        const h = this.bodyHold;
        if (!h || !sim.beginDrag(hand)) {
          this.fail('shake-out: could not re-grip');
          return;
        }
        const pair = hand === 'LH' ? 'RH' : 'LH';
        this.from = { x: s.limbs[hand].pos.x, y: s.limbs[hand].pos.y };
        this.target = contactPoint(h, LIMB_INDEX[hand], s.limbs[pair].holdId === h.id, { x: 0, y: 0 });
        this.phase = 'regrab';
        this.t = 0;
        return;
      }
      case 'regrab': {
        const k = Math.min(1, this.t / this.opts.dragTime);
        const e = k * k * (3 - 2 * k);
        sim.dragTo(hand, { x: this.from.x + (this.target.x - this.from.x) * e, y: this.from.y + (this.target.y - this.from.y) * e });
        if (k < 1) return;
        const h = this.bodyHold;
        if (h && sim.snapCandidate(hand, this.target)?.id !== h.id && this.t < this.opts.dragTime + 1) return;
        const ev = sim.endDrag(hand);
        if (!ev.some((x) => x.type === 'grab' && x.holdId === h?.id)) {
          this.log.push(`re-grip missed ${hand} (${ev.map((x) => x.type).join(',')})`);
          this.retry();
          return;
        }
        this.phase = 'prep';
        this.t = 0;
        return;
      }
      default:
        return;
    }
  }
  private clipLimb: LimbId = 'RH';
  /** Quickdraws clipped by the bot. */
  clips = 0;

  private clipHip: { x: number; y: number } | null = null;

  /** Rope: clip a quickdraw from the stance the planner verified for it. */
  private startClip(clip: NonNullable<PlanStep['clip']>): void {
    const sim = this.sim;
    const q = sim.boulder.quickdraws?.find((d) => d.id === clip.quickdrawId);
    if (!q || sim.getState().clipped.includes(q.id)) return;
    this.clipHip = this.opts.useHips ? { x: clip.reachPose.px, y: clip.reachPose.py } : null;
    if (this.clipHip) sim.setHipTarget(this.clipHip);
    if (!sim.beginDrag(clip.limb)) return;
    const s = sim.getState();
    this.clipLimb = clip.limb;
    this.from = { x: s.limbs[clip.limb].pos.x, y: s.limbs[clip.limb].pos.y };
    this.target = { x: q.x, y: q.y - 0.15 };
    this.phase = 'clip';
    this.t = 0;
  }

  private beginMove(st: PlanStep, limb: LimbId): void {
    const sim = this.sim;
    if (!sim.beginDrag(limb)) {
      this.fail(`beginDrag ${limb} refused`);
      return;
    }
    const s = sim.getState();
    this.from = { x: s.limbs[limb].pos.x, y: s.limbs[limb].pos.y };
    if (st.move.holdId === SMEAR_ID) {
      this.hold = null;
      this.target = st.smear ? { ...st.smear } : { x: s.limbs[limb].anchor.x, y: s.limbs[limb].anchor.y - 0.7 };
    } else {
      const h = this.holds.get(st.move.holdId)!;
      this.hold = h;
      const pair = limb === 'LH' ? 'RH' : limb === 'RH' ? 'LH' : limb === 'LF' ? 'RF' : 'LF';
      const matched = s.limbs[pair].holdId === h.id;
      this.target = contactPoint(h, LIMB_INDEX[limb], matched, { x: 0, y: 0 });
    }
    this.phase = 'drag';
    this.t = 0;
  }

  /** Throw the planned deadpoint / dyno from the stance the bot shifted into. */
  private launch(st: PlanStep): void {
    const sim = this.sim;
    const d = st.move.dyno!;
    if (!sim.dyno) {
      this.fail('dyno: the sim cannot throw');
      return;
    }
    sim.setHipTarget(null);
    // commit a little past the ideal throw (research [37]: jumping past the hold is good, short falls)
    const ev = sim.dyno(d, st.move.holdId, BOT.throwPower + this.throwBoost);
    if (!ev.some((e) => e.type === 'dyno-start')) {
      this.log.push(`dyno refused ${d}->${st.move.holdId}`);
      this.retry();
      return;
    }
    this.throws++;
    this.caught.length = 0;
    this.phase = 'fly';
    this.t = 0;
  }

  /** Static moves the climber missed, with the stance (hold ids LH|RH|LF|RF) they were tried from. */
  private readonly missed: { stance: string; limb: LimbId; holdId: string }[] = [];

  private stanceKey(): string {
    const s = this.sim.getState();
    return `${s.limbs.LH.holdId}|${s.limbs.RH.holdId}|${s.limbs.LF.holdId}|${s.limbs.RF.holdId}`;
  }

  private retry(): void {
    if (!this.opts.replan || this.replans >= 4) {
      this.fail('move missed');
      return;
    }
    this.replans++;
    this.sim.setHipTarget(null);
    this.phase = 'recover';
    this.t = 0;
  }

  /** A short recovery plan is running (feet back on after a throw), then a full re-plan. */
  private recovering = false;

  /**
   * Feet dangling after a throw (cut in the flight, or half a double dyno that stuck): the planner only
   * plans from stances that hold the climber, so first put each dangling foot on the best foothold it
   * can reach right now (a quick placement, like a climber who just caught a dyno). False when no foot
   * dangles or none can reach a hold.
   */
  private feetFirst(): boolean {
    const sim = this.sim;
    const s = sim.getState();
    if (!s.limbs.LH.holdId && !s.limbs.RH.holdId) return false;
    const pose = { px: s.pelvis.x, py: s.pelvis.y, cx: s.chest.x, cy: s.chest.y };
    const steps: PlanStep[] = [];
    const taken = new Set<string>();
    for (const foot of ['LF', 'RF'] as const) {
      const L = s.limbs[foot];
      if (L.holdId || L.smearing || L.dragging) continue;
      const ideal = { x: s.pelvis.x + (foot === 'LF' ? -0.2 : 0.2), y: s.pelvis.y - 0.85 };
      let best: string | null = null;
      let bs = -Infinity;
      for (const id of sim.reachableHolds(foot)) {
        const h = this.holds.get(id);
        if (!h || taken.has(id)) continue;
        const sc = sim.predictGrip(foot, id) - Math.hypot(h.x - ideal.x, h.y - ideal.y) * 1.5;
        if (sc > bs) {
          bs = sc;
          best = id;
        }
      }
      if (!best) continue;
      taken.add(best);
      steps.push({ move: { limb: foot, holdId: best }, moveTension: 0, tension: 0, distance: 0, pose, reachPose: pose });
    }
    if (!steps.length) return false;
    this.log.push(`feet back on: ${steps.map((x) => `${x.move.limb}->${x.move.holdId}`).join(', ')}`);
    this.plan = { moves: steps.map((x) => x.move), steps, startTension: s.tension, startPose: pose, nodes: 0, ms: 0 };
    this.idx = 0;
    this.fastFeet = true;
    this.recovering = true;
    this.phase = 'prep';
    this.t = 0;
    return true;
  }

  private replan(): void {
    if (!this.recovering && this.feetFirst()) return;
    const s = this.sim.getState();
    const ids = (['LH', 'RH', 'LF', 'RF'] as const).map((l) => s.limbs[l].holdId);
    const opts = {
      start: ids,
      startPose: { px: s.pelvis.x, py: s.pelvis.y, cx: s.chest.x, cy: s.chest.y },
      maxNodes: this.sim.boulder.mode === 'rope' ? 2600 : 900,
      clipped: s.clipped,
    };
    // a move missed from this very stance is not tried first again (when the beta has another way)
    const key = this.stanceKey();
    const avoid = this.missed.filter((m) => m.stance === key).map((m) => ({ limb: m.limb, holdId: m.holdId }));
    const tries: Parameters<typeof planBetaDetailed>[1][] = [];
    // after two missed throws, a static beta from here is worth more than a third throw
    if (this.misses >= 2) {
      if (avoid.length) tries.push({ ...opts, dynos: false, avoid });
      tries.push({ ...opts, dynos: false });
    }
    if (avoid.length) tries.push({ ...opts, avoid });
    tries.push(opts);
    let plan: PlanResult | null = null;
    for (const o of tries) if ((plan = planBetaDetailed(this.sim.boulder, o))) break;
    if (!plan) {
      this.fail('replan failed');
      return;
    }
    this.plan = plan;
    this.idx = 0;
    this.phase = 'prep';
    this.t = 0;
  }

  private finish(): void {
    this.sim.setHipTarget(null);
    this.phase = 'done';
  }

  private fail(why: string): void {
    this.log.push(why);
    this.sim.setHipTarget(null);
    this.phase = 'failed';
  }
}

/** Run a bot to completion (headless). Returns the outcome and the sim time it took. */
export function autoClimb(sim: ClimberSimAPI, opts: BetaBotOptions & { maxTime?: number; dt?: number } = {}): { sent: boolean; time: number; bot: BetaBot } {
  const bot = new BetaBot(sim, undefined, opts);
  const dt = opts.dt ?? 1 / 60;
  const maxTime = opts.maxTime ?? 240;
  if (sim.getState().phase === 'idle') sim.start();
  let t = 0;
  let events: readonly SimEvent[] = [];
  while (t < maxTime && !bot.done && !bot.failed) {
    bot.update(dt, events);
    events = sim.step(dt);
    t += dt;
    if (sim.getState().phase === 'topped') {
      bot.update(dt, events);
      break;
    }
  }
  return { sent: sim.getState().phase === 'topped', time: sim.getState().time, bot };
}

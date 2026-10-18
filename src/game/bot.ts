// BetaBot: an autopilot that climbs a planned beta through the sim's public input API, exactly like a
// player would (shift the hips, drag a limb to the hold, release when it snaps). Used by the tests to
// prove that planned betas are executable, and usable as an attract-mode / demo climber.

import type { HoldDef, LimbId, Vec2 } from '../core/types';
import type { BetaMove, ClimberSimAPI, SimEvent } from '../core/contracts';
import { contactPoint, LIMB_INDEX } from './holds';
import { planBetaDetailed, SMEAR_ID, type PlanResult, type PlanStep } from './solver';

type BotPhase = 'prep' | 'drag' | 'hold' | 'settle' | 'clip' | 'clipwait' | 'done' | 'failed';

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
    if (!st && this.phase !== 'clip' && this.phase !== 'clipwait') {
      // all moves done: wait on the top (rope: clip the anchor first)
      this.t += dt;
      if (this.t > 4) this.fail('no top after beta');
      return;
    }
    const limb: LimbId = st ? st.move.limb : this.clipLimb;
    this.t += dt;
    if (!st && this.phase !== 'clip' && this.phase !== 'clipwait') return;
    switch (this.phase) {
      case 'prep': {
        if (!st) break;
        // shift the weight toward the reach position while still on four limbs, then let go
        if (this.opts.useHips) sim.setHipTarget({ x: st.reachPose.px, y: st.reachPose.py });
        const d = Math.hypot(s.pelvis.x - st.reachPose.px, s.pelvis.y - st.reachPose.py);
        const v = Math.hypot(s.velocity.x, s.velocity.y);
        if (this.t > this.opts.prepTime || (this.t > 0.12 && (d < 0.05 || (v < 0.05 && this.t > 0.3)))) this.beginMove(st, limb);
        break;
      }
      case 'drag': {
        if (!st) break;
        if (this.opts.useHips) sim.setHipTarget({ x: st.reachPose.px, y: st.reachPose.py });
        const k = Math.min(1, this.t / this.opts.dragTime);
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
        if (this.opts.useHips) sim.setHipTarget({ x: st.reachPose.px, y: st.reachPose.py });
        sim.dragTo(limb, this.target);
        const ok = this.hold ? sim.snapCandidate(limb, this.target)?.id === this.hold.id : true;
        if (ok || this.t > 1.0) {
          const ev = sim.endDrag(limb);
          const grabbed = ev.some((x) => (x.type === 'grab' && x.holdId === this.hold?.id) || (x.type === 'smear' && !this.hold));
          if (!grabbed) {
            this.log.push(`miss ${limb}->${st.move.holdId} (${ev.map((x) => x.type).join(',')})`);
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
        if (this.t > this.opts.settleTime) {
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

  private retry(): void {
    if (!this.opts.replan || this.replans >= 3) {
      this.fail('move missed');
      return;
    }
    this.replans++;
    const s = this.sim.getState();
    const ids = (['LH', 'RH', 'LF', 'RF'] as const).map((l) => s.limbs[l].holdId);
    const plan = planBetaDetailed(this.sim.boulder, {
      start: ids,
      startPose: { px: s.pelvis.x, py: s.pelvis.y, cx: s.chest.x, cy: s.chest.y },
      maxNodes: 900,
    });
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

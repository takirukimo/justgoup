// ClimbSession: one problem, from route reading to the send (or the fall).
//
//   preview    camera pulled back, preview card + Steini's tip, waits for TAP TO START
//   countdown  HUD up, follow camera flies in, 3-2-1-GO (pause works)
//   climbing   sim stepping, controls live, hints, overview, rope bookkeeping
//   hang       rope only: caught by the rope, hanging before the respawn
//   ending     celebrate / fall camera beat before the result resolves
//
// The session never shows results: it resolves a SessionResult and the run decides what's next.

import type { FallReason, SimEvent, SimOptions } from '../core/contracts';
import { bus, type AppEvents } from '../core/events';
import type { BoulderDef, ClimberState, HoldDef, LimbId, QuickdrawDef, RunInfo, Vec2 } from '../core/types';
import { LIMBS } from '../core/types';
import { clamp } from '../core/math';
import { GAME } from '../config/tuning';
import { ClimberSim } from '../game/climber-sim';
import { RopeSystem } from '../game/rope';
import { nextHint } from '../game/solver';
import { clipPoint } from '../game/holds';
import type { HudRunInfo } from '../ui/ui';
import { LIMB_WORD, SimDriver } from './driver';
import type { Services } from './services';
import { Timeline } from './timeline';

export type SessionResult =
  | { kind: 'send'; time: number; flash: boolean; hintsUsed: number; slips: number; maxTension: number; meters: number }
  | { kind: 'fall'; reason: FallReason; time: number; meters: number; hintsUsed: number }
  | {
      kind: 'rope';
      topped: boolean;
      ground: boolean;
      reason: FallReason | null;
      time: number;
      /** Highest harness height reached (m above the floor). */
      heightM: number;
      clips: number;
      falls: number;
      meters: number;
      hintsUsed: number;
      flash: boolean;
    }
  | { kind: 'retry' }
  | { kind: 'quit' };

export interface SessionConfig {
  boulder: BoulderDef;
  /** HUD run info, shared with the run (the session writes the live rope/hint fields). */
  run: HudRunInfo;
  tip?: string;
  /** Hints left in the run (shared, decremented here). */
  hints: { left: number };
  /** Rope: lives left in the tower run (shared, decremented here). */
  lives?: { left: number };
  simOptions?: SimOptions;
  /** Asked before RETRY / QUIT from the pause screen ends the run (null = no question). */
  restartPrompt?: { title: string; body: string; ok: string } | null;
  /** The run already loaded this wall into the renderer (under the transition veil). */
  preloaded?: boolean;
}

type Phase = 'preview' | 'countdown' | 'climbing' | 'hang' | 'ending' | 'done';

const COUNT_STEP = 0.62;
/** Screen fractions covered by the preview card / tip + start button (measured once shown). */
const PREVIEW_INSETS = { top: 0.21, bottom: 0.22 };
/** Screen fractions covered by the HUD bars (route overview while climbing). */
const HUD_INSETS = { top: 0.1, bottom: 0.13 };
const HINT_LIFETIME = 12;

interface Stance {
  place: Record<LimbId, string | null>;
  handY: number;
}

export class ClimbSession {
  readonly boulder: BoulderDef;
  readonly sim: ClimberSim;
  private readonly svc: Services;
  private readonly cfg: SessionConfig;
  private readonly driver: SimDriver;
  private readonly timeline = new Timeline();
  private readonly holds: Map<string, HoldDef>;
  private readonly rope: RopeSystem | null;
  private readonly offs: (() => void)[] = [];

  private phase: Phase = 'preview';
  private paused = false;
  private overview = false;
  private resolveResult: ((r: SessionResult) => void) | null = null;
  private readonly result: Promise<SessionResult>;
  private finished = false;
  private confirming = false;

  // per-climb bookkeeping
  private startPelvisY = 0;
  private hintsUsed = 0;
  private hint: { limb: LimbId; id: string; target: Vec2; radius: number; age: number; draw: boolean } | null = null;
  private fallReason: FallReason | null = null;
  private groundFall = false;
  private ropeFalls = 0;
  private landTimer = false;
  private readonly stances: Stance[] = [];
  private clipStance: Stance | null = null;
  private clipReadyT = 0;
  private pxpm = 120;
  private pxpmT = 1;

  constructor(svc: Services, cfg: SessionConfig) {
    this.svc = svc;
    this.cfg = cfg;
    this.boulder = cfg.boulder;
    this.holds = new Map(cfg.boulder.holds.map((h) => [h.id, h] as const));
    this.sim = new ClimberSim(cfg.boulder, cfg.simOptions ?? {});
    this.rope = cfg.boulder.mode === 'rope' ? new RopeSystem(cfg.boulder) : null;
    this.driver = new SimDriver(svc, this.sim, { lookAhead: true, onEvent: (e, st) => this.onSimEvent(e, st) });
    this.result = new Promise((r) => (this.resolveResult = r));
  }

  get state(): ClimberState {
    return this.sim.getState();
  }

  /** True while the player is actually on the wall (for the quality watchdog). */
  get live(): boolean {
    return this.phase === 'climbing' && !this.paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ═══════════════════════════════ flow ═══════════════════════════════

  async run(): Promise<SessionResult> {
    const { renderer, controls, ui, audio } = this.svc;
    const b = this.boulder;
    const run = this.cfg.run;

    // scene: wall + climber on the start holds
    if (!this.cfg.preloaded) renderer.loadBoulder(b);
    renderer.setClimberVisible(true);
    renderer.setHoldHighlights([]);
    this.startPelvisY = this.sim.getState().pelvis.y;
    renderer.updateClimber(this.sim.getState(), 0);
    if (this.rope) {
      const bel = this.rope.belayer();
      renderer.setGuide({ x: bel.x, depth: 1.05, pose: 'belay', lookAt: { x: this.state.chest.x, y: this.state.chest.y } });
      this.updateRope();
    } else renderer.setGuide(null);
    controls.bind(this.sim);
    controls.setEnabled(false);
    controls.setAllowed('all', true);

    this.listen();
    this.syncRun(true);
    run.hintsLeft = this.cfg.hints.left;
    renderer.setViewInsets(PREVIEW_INSETS.top, PREVIEW_INSETS.bottom);
    renderer.setCameraMode('preview', { instant: true });
    ui.show('preview', { boulder: b, run: { ...run }, tip: this.cfg.tip });
    requestAnimationFrame(() => this.measurePreviewInsets());
    audio.setMusic('climb');
    bus.emit('game:preview', { boulder: b });

    const go = await this.waitBus(['ui:begin-climb', 'ui:back']);
    if (this.finished) return this.result;
    if (go === 'ui:back') {
      this.finish({ kind: 'quit' });
      return this.result;
    }

    // countdown: the follow camera flies in while the numbers run
    this.phase = 'countdown';
    renderer.setViewInsets(HUD_INSETS.top, HUD_INSETS.bottom);
    ui.show('hud', { run });
    renderer.setCameraMode('follow');
    audio.play('whoosh', { volume: 0.5 });
    for (let n = 3; n >= 1; n--) {
      ui.hud.callout(String(n), 'neutral');
      audio.countdownStep(n);
      await this.timeline.wait(COUNT_STEP);
      if (this.finished) return this.result;
    }
    ui.hud.callout('GO!', 'good');
    audio.countdownStep(0);

    this.phase = 'climbing';
    this.sim.start();
    controls.setEnabled(!this.paused);
    bus.emit('game:climb-start', { boulder: b });
    return this.result;
  }

  // ═══════════════════════════════ per frame ═══════════════════════════════

  /** Before renderer.frame: step the sim, rope and HUD. */
  frame(dt: number): void {
    const gdt = dt * this.svc.timeScale;
    if (this.phase === 'done') {
      // results are up: keep the climber alive (landing, celebration) under them
      this.driver.step(gdt);
      if (this.rope) this.updateRope();
      this.driver.render(dt);
      return;
    }
    if (!this.paused) {
      this.timeline.tick(gdt);
      this.driver.step(gdt);
      if (this.rope) this.updateRope();
      this.updateHint(gdt);
    }
    this.driver.render(dt);
    this.syncRun(false, gdt);
    if (this.phase !== 'preview') this.svc.ui.hud.update(this.state, this.cfg.run);
  }

  /** After renderer.frame: handles + hint ghost match the rendered camera. */
  postFrame(dt: number): void {
    this.svc.controls.update(this.state, dt);
    if (this.phase === 'done') return;
    this.drawGhost(dt);
  }

  // ═══════════════════════════════ sim events ═══════════════════════════════

  private onSimEvent(e: SimEvent, st: ClimberState): void {
    if (this.finished) return;
    switch (e.type) {
      case 'grab':
      case 'smear':
        this.recordStance(st);
        if (this.hint && e.type === 'grab' && e.limb === this.hint.limb && e.holdId === this.hint.id) this.clearHint();
        break;
      case 'clip-done':
        this.onClipped(e.quickdrawId);
        break;
      case 'top':
        this.guard(this.rope ? this.onRopeTop() : this.onSend(), 'send');
        break;
      case 'fall':
        this.onFall(e.reason);
        break;
      case 'ground-fall':
        this.groundFall = true;
        this.svc.ui.hud.callout('GROUND FALL', 'bad');
        break;
      case 'caught':
        this.guard(this.onCaught(e.fallDistance), 'rope catch');
        break;
      case 'land':
        this.guard(this.onLand(), 'landing');
        break;
      default:
        break;
    }
  }

  private recordStance(st: ClimberState): void {
    if (!this.rope || st.phase !== 'climbing') return;
    const place = {} as Record<LimbId, string | null>;
    let handY = -Infinity;
    for (const l of LIMBS) {
      const L = st.limbs[l];
      if (!L.holdId || L.dragging || L.busy) return;
      place[l] = L.holdId;
      if (l === 'LH' || l === 'RH') handY = Math.max(handY, this.holds.get(L.holdId)?.y ?? st.chest.y);
    }
    const last = this.stances[this.stances.length - 1];
    if (last && LIMBS.every((l) => last.place[l] === place[l])) return;
    this.stances.push({ place, handY });
    if (this.stances.length > 40) this.stances.shift();
  }

  private onClipped(id: string): void {
    if (!this.rope) return;
    this.rope.clip(id);
    const st = this.state;
    this.recordStance(st);
    const last = this.stances[this.stances.length - 1];
    if (last) this.clipStance = last;
    if (this.hint && this.hint.draw && this.hint.id === id) this.clearHint();
    const anchor = this.rope.quickdraws[this.rope.quickdraws.length - 1];
    if (anchor && anchor.id === id) return; // the 'top' event follows
    this.svc.ui.hud.callout('CLIPPED', 'good');
  }

  private async onSend(): Promise<void> {
    if (this.phase === 'ending' || this.phase === 'done') return;
    const { renderer, ui, audio, controls } = this.svc;
    this.phase = 'ending';
    this.overview = false;
    controls.setEnabled(false);
    this.clearHint();
    const stats = this.sim.getStats();
    const flash = stats.slips === 0 && stats.maxTension <= 1.2;
    const top = this.topPoint();
    ui.show('none', {});
    renderer.setCameraMode('celebrate');
    renderer.fx.confetti(top);
    renderer.fx.chalkPuff(top, 1.4);
    audio.play('send');
    audio.haptic([20, 40, 20, 40, 90]);
    ui.hud.callout(flash ? 'FLASH!' : 'SENT!', 'good');
    const time = this.state.time;
    await this.timeline.wait(2.6);
    this.finish({
      kind: 'send',
      time,
      flash,
      hintsUsed: this.hintsUsed,
      slips: stats.slips,
      maxTension: stats.maxTension,
      meters: this.metersGained(),
    });
  }

  private async onRopeTop(): Promise<void> {
    if (this.phase === 'ending' || this.phase === 'done') return;
    const { renderer, ui, audio, controls } = this.svc;
    this.phase = 'ending';
    this.overview = false;
    controls.setEnabled(false);
    this.clearHint();
    const anchor = this.rope?.quickdraws[this.rope.quickdraws.length - 1];
    const p = anchor ? { x: anchor.x, y: anchor.y } : this.topPoint();
    ui.show('none', {});
    renderer.setCameraMode('celebrate');
    renderer.fx.confetti(p);
    audio.play('send');
    audio.haptic([20, 40, 20, 40, 90]);
    ui.hud.callout('TOPPED!', 'good');
    renderer.setGuide({ x: this.rope!.belayer().x, depth: 1.05, pose: 'cheer', lookAt: { x: p.x, y: p.y } });
    await this.timeline.wait(2.8);
    this.finishRope(true);
  }

  private onFall(reason: FallReason): void {
    if (this.phase === 'ending' || this.phase === 'done') return;
    const { renderer, controls } = this.svc;
    this.fallReason = reason;
    this.overview = false;
    controls.setEnabled(false);
    this.clearHint();
    // On the rope the follow camera keeps tracking the climber down to the catch; the wide, low
    // 'fall' shot would put the belayer between the lens and the climber.
    renderer.setCameraMode(this.rope ? 'follow' : 'fall');
    if (this.rope) {
      this.phase = 'hang';
      return;
    }
    this.phase = 'ending';
    bus.emit('game:fall', { boulder: this.boulder });
    // safety net if the landing never registers
    void this.timeline.wait(4.5).then(() => {
      if (!this.landTimer) this.guard(this.onLand(), 'landing');
    });
  }

  private async onLand(): Promise<void> {
    if (this.landTimer || this.finished) return;
    if (this.rope && !this.groundFall) return;
    this.landTimer = true;
    this.svc.ui.show('none', {});
    if (!this.rope) this.svc.ui.hud.callout(this.fallReason === 'pump' ? 'PUMPED OUT' : 'OFF!', 'bad');
    await this.timeline.wait(1.35);
    if (this.rope) {
      this.ropeFalls++;
      if (this.cfg.lives) this.cfg.lives.left = 0;
      bus.emit('game:fall', { boulder: this.boulder });
      this.finishRope(false);
      return;
    }
    this.finish({ kind: 'fall', reason: this.fallReason ?? 'forced', time: this.state.time, meters: this.metersGained(), hintsUsed: this.hintsUsed });
  }

  private async onCaught(distance: number): Promise<void> {
    if (!this.rope || this.finished) return;
    const { ui, renderer, controls, veil } = this.svc;
    this.ropeFalls++;
    const lives = this.cfg.lives;
    if (lives) lives.left = Math.max(0, lives.left - 1);
    this.cfg.run.lives = lives?.left;
    ui.hud.callout(distance > 2.2 ? 'WHIPPER!' : 'CAUGHT', 'bad');
    bus.emit('game:fall', { boulder: this.boulder });
    renderer.setGuide({ x: this.rope.belayer().x, depth: 1.05, pose: 'belay', lookAt: { x: this.state.chest.x, y: this.state.chest.y } });
    if (lives && lives.left <= 0) {
      this.phase = 'ending';
      await this.timeline.wait(1.8);
      this.finishRope(false);
      return;
    }
    this.phase = 'hang';
    await this.timeline.wait(1.6);
    if (this.finished) return;
    await veil.cover('', '', true);
    if (this.finished) {
      void veil.reveal();
      return;
    }
    this.sim.respawn(this.respawnPlacement());
    this.fallReason = null;
    this.updateRope();
    renderer.updateClimber(this.state, 0);
    renderer.setCameraMode('follow', { instant: true });
    this.phase = 'climbing';
    controls.setEnabled(!this.paused);
    await veil.reveal();
    if (!this.finished) ui.hud.callout(`${lives?.left ?? 0} ${lives?.left === 1 ? 'LIFE' : 'LIVES'} LEFT`, 'neutral');
  }

  /** The highest stance the climber held at or just below the last clip. */
  private respawnPlacement(): Partial<Record<LimbId, string>> {
    const last = this.rope?.lastClip();
    const out: Partial<Record<LimbId, string>> = {};
    let pick: Stance | null = null;
    if (last) {
      for (let i = this.stances.length - 1; i >= 0; i--) {
        const s = this.stances[i];
        if (s.handY <= last.y + 0.35 && s.handY >= last.y - 2.2) {
          pick = s;
          break;
        }
      }
      pick = pick ?? this.clipStance;
    }
    if (!pick) return out;
    for (const l of LIMBS) {
      const id = pick.place[l];
      if (id) out[l] = id;
    }
    return out;
  }

  private finishRope(topped: boolean): void {
    const rope = this.rope;
    const stats = this.sim.getStats();
    this.finish({
      kind: 'rope',
      topped,
      ground: this.groundFall,
      reason: this.fallReason,
      time: this.state.time,
      heightM: topped ? this.boulder.height : clamp(stats.maxHeight, 0, this.boulder.height),
      clips: rope ? rope.clipped.length : 0,
      falls: this.ropeFalls,
      meters: this.metersGained(),
      hintsUsed: this.hintsUsed,
      flash: this.ropeFalls === 0 && stats.slips === 0,
    });
  }

  // ═══════════════════════════════ input intents ═══════════════════════════════

  private listen(): void {
    const on = <K extends keyof AppEvents>(k: K, fn: (p: AppEvents[K]) => void): void => {
      this.offs.push(bus.on(k, fn));
    };
    on('ui:pause', () => this.pause());
    on('ui:resume', () => this.resume());
    on('ui:retry', () => this.guard(this.leave('retry'), 'retry'));
    on('ui:quit', () => this.guard(this.leave('quit'), 'quit'));
    on('ui:hint', () => this.useHint());
    on('ui:toggle-overview', () => this.toggleOverview());
  }

  private pause(): void {
    if (this.paused || this.finished) return;
    if (this.phase !== 'countdown' && this.phase !== 'climbing' && this.phase !== 'hang') return;
    const { controls, ui, audio } = this.svc;
    this.paused = true;
    this.driver.paused = true;
    controls.cancelDrag();
    controls.setEnabled(false);
    audio.setIntensity(0, 0);
    audio.play('ui-swipe', { volume: 0.5 });
    ui.show('pause', { run: { ...this.cfg.run } });
  }

  private resume(): void {
    if (!this.paused || this.finished || this.confirming) return;
    const { controls, ui, renderer } = this.svc;
    this.paused = false;
    this.driver.paused = false;
    this.overview = false;
    ui.show('hud', { run: this.cfg.run });
    if (this.phase === 'climbing' || this.phase === 'countdown') renderer.setCameraMode('follow');
    controls.setEnabled(this.phase === 'climbing');
  }

  private async leave(kind: 'retry' | 'quit'): Promise<void> {
    if (!this.paused || this.finished || this.confirming) return;
    const prompt = this.cfg.restartPrompt;
    if (kind === 'retry' && prompt) {
      this.confirming = true;
      const ok = await this.svc.ui.confirm(prompt.title, prompt.body, prompt.ok, 'KEEP CLIMBING');
      this.confirming = false;
      if (!ok || this.finished) return;
    }
    this.finish({ kind });
  }

  private toggleOverview(): void {
    if (this.phase !== 'climbing' || this.paused) return;
    this.overview = !this.overview;
    this.svc.controls.cancelDrag();
    this.svc.renderer.setCameraMode(this.overview ? 'preview' : 'follow');
    this.svc.audio.play('whoosh', { volume: 0.35 });
  }

  private useHint(): void {
    if (this.phase !== 'climbing' || this.paused) return;
    const { ui, renderer, audio } = this.svc;
    if (this.cfg.hints.left <= 0) {
      ui.hud.toast('NO HINTS LEFT THIS RUN');
      return;
    }
    const m = nextHint(this.sim);
    if (!m) {
      ui.hud.toast('NO CLEAR MOVE · SHIFT YOUR HIPS');
      return;
    }
    const q: QuickdrawDef | undefined = this.boulder.quickdraws?.find((d) => d.id === m.holdId);
    const h = this.holds.get(m.holdId);
    let target: Vec2;
    let radius: number;
    if (q) {
      target = clipPoint(q, { x: 0, y: 0 });
      radius = 0.09;
    } else if (h) {
      target = { x: h.x, y: h.y };
      radius = Math.max(0.06, h.size);
    } else return;
    this.cfg.hints.left--;
    this.hintsUsed++;
    this.cfg.run.hintsLeft = this.cfg.hints.left;
    this.hint = { limb: m.limb, id: m.holdId, target, radius, age: 0, draw: !!q };
    renderer.setHoldHighlights([{ holdId: m.holdId, kind: 'hint' }]);
    this.driver.lookOverride = target;
    audio.play('ui-confirm', { volume: 0.6 });
    ui.hud.toast(q ? `HINT · CLIP WITH YOUR ${LIMB_WORD[m.limb]}` : `HINT · ${LIMB_WORD[m.limb]}`);
  }

  private updateHint(dt: number): void {
    if (!this.hint) return;
    this.hint.age += dt;
    if (this.hint.age > HINT_LIFETIME || this.phase !== 'climbing') this.clearHint();
  }

  private clearHint(): void {
    if (!this.hint) return;
    this.hint = null;
    this.driver.lookOverride = null;
    this.svc.renderer.setHoldHighlights([]);
    this.svc.ghost.hide();
  }

  private drawGhost(dt: number): void {
    const h = this.hint;
    const { ghost, renderer, controls } = this.svc;
    if (!h || this.phase !== 'climbing' || this.overview || this.paused || controls.dragging === h.limb) {
      ghost.hide();
      return;
    }
    const L = this.state.limbs[h.limb];
    const a = renderer.wallToScreen(L.pos, L.depth);
    const b = renderer.wallToScreen(h.target, 0.05);
    if (!b.visible) {
      ghost.hide();
      return;
    }
    this.pxpmT += dt;
    if (this.pxpmT > 0.25) {
      this.pxpmT = 0;
      this.pxpm = renderer.pxPerMeter(h.target);
    }
    ghost.show(a.x, a.y, b.x, b.y, h.radius * this.pxpm + 10, h.draw ? `CLIP · ${LIMB_WORD[h.limb]}` : LIMB_WORD[h.limb]);
  }

  // ═══════════════════════════════ helpers ═══════════════════════════════

  private updateRope(): void {
    const rope = this.rope;
    if (!rope) return;
    const st = this.state;
    if (st.phase === 'climbing' || st.phase === 'idle' || st.phase === 'hanging') {
      const c = rope.catchParams(st.pelvis);
      this.sim.setRope(c.anchor, c.length);
    }
    this.svc.renderer.setRope(rope.ropePath(st.pelvis), rope.clipped);
  }

  private syncRun(initial: boolean, dt = 0): void {
    const run: RunInfo & { clipReady?: boolean } = this.cfg.run;
    run.hintsLeft = this.cfg.hints.left;
    if (!this.rope) return;
    const st = this.state;
    run.lives = this.cfg.lives?.left ?? GAME.ropeLives;
    run.heightM = Math.max(0, st.pelvis.y);
    const next = this.rope.nextClip();
    run.nextClipIn = next ? Math.max(0, next.y - st.pelvis.y) : null;
    this.clipReadyT -= dt;
    if (initial || this.clipReadyT <= 0) {
      this.clipReadyT = 0.16;
      let ready = false;
      if (next && st.phase === 'climbing') {
        const cp = clipPoint(next, { x: 0, y: 0 });
        for (const l of ['LH', 'RH'] as const) {
          if (st.limbs[l].busy) continue;
          if (this.sim.clipCandidate(l, cp)) {
            ready = true;
            break;
          }
        }
      }
      run.clipReady = ready;
    }
  }

  /** Fit the route-reading camera between the preview card and the tip / start button. */
  private measurePreviewInsets(): void {
    if (this.phase !== 'preview') return;
    const host = this.svc.host;
    const H = host.clientHeight || 1;
    const hr = host.getBoundingClientRect();
    const card = host.querySelector<HTMLElement>('.pv-card');
    const bottom = host.querySelector<HTMLElement>('.pv-bottom');
    if (!card || !bottom) return;
    const top = (card.getBoundingClientRect().bottom - hr.top) / H;
    const bot = 1 - (bottom.getBoundingClientRect().top - hr.top) / H;
    if (top > 0 && top < 0.45 && bot > 0 && bot < 0.45) this.svc.renderer.setViewInsets(top + 0.01, bot + 0.01);
  }

  private topPoint(): Vec2 {
    let best: HoldDef | null = null;
    for (const h of this.boulder.holds) if (h.role === 'top' && (!best || h.y > best.y)) best = h;
    return best ? { x: best.x, y: best.y } : { x: this.state.chest.x, y: this.state.chest.y + 0.3 };
  }

  private metersGained(): number {
    return clamp(this.sim.getStats().maxHeight - this.startPelvisY, 0, this.boulder.height);
  }

  private waitBus<K extends keyof AppEvents>(keys: K[]): Promise<K> {
    return new Promise((resolve) => {
      const offs: (() => void)[] = [];
      const done = (k: K): void => {
        for (const o of offs) o();
        resolve(k);
      };
      for (const k of keys) offs.push(bus.on(k, () => done(k)));
      // a finished session must not leave listeners behind
      void this.result.then(() => {
        for (const o of offs) o();
      });
    });
  }

  /**
   * Run one of the async beats (send, landing, catch, leave). A beat that throws must not strand
   * the player on a frozen wall with no result: end the climb and let the run move on.
   */
  private guard(beat: Promise<void>, what: string): void {
    beat.catch((err: unknown) => {
      console.error(`[session] ${what} failed`, err);
      if (this.finished) return;
      this.svc.ui.hud.toast('SOMETHING SLIPPED · BACK TO THE MENU');
      this.finish({ kind: 'quit' });
    });
  }

  private finish(r: SessionResult): void {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'done';
    this.timeline.clear();
    this.resolveResult?.(r);
  }

  /** Tear down listeners + bindings (the next scene takes over the renderer). */
  dispose(): void {
    if (!this.finished) this.finish({ kind: 'quit' });
    for (const o of this.offs) o();
    this.offs.length = 0;
    this.driver.dispose();
    const { controls, renderer, ghost } = this.svc;
    controls.cancelDrag();
    controls.setEnabled(false);
    controls.bind(null);
    ghost.hide();
    renderer.setHoldHighlights([]);
    renderer.setCameraFocusHint(null);
    renderer.setViewInsets(0, 0);
    if (this.rope) renderer.setRope(null, []);
  }
}

// Run flows: what happens between climbs. Each run strings ClimbSessions together, scores them,
// keeps the profile up to date, talks to the backend and shows the results screen.
//
//   SendTrainRun   endless boulders of rising grade; the first fall ends the run → 'boulder' board
//   LeadTowerRun   15 m lead routes; whippers cost lives; a ground fall ends the run → 'rope' board
//   DailyRun       today's seeded boulder; retries allowed, the best score counts → 'daily' board
//   CommunityRun   a player-set problem; attempts and sends are recorded on the backend
//   TestRun        the editor's test climb; resolves whether the problem was sent

import type { BackendAPI, ResultsProps } from '../core/contracts';
import { bus, type AppEvents } from '../core/events';
import { hashString, Rng } from '../core/rng';
import type { BoulderDef, CommunityProblem, LeaderboardMode, Profile, ScoreEntry } from '../core/types';
import { ROUTE_COLORS } from '../config/brand';
import { GAME } from '../config/tuning';
import { todayKey } from '../game/generator';
import { gradeLabel } from '../game/grades';
import { parTime, runGradeFor, scoreDaily, scoreRope, scoreSend } from '../game/scoring';
import type { UnlockedItem } from '../net/profile';
import { randomTip, tipFor } from '../tutorial/tips';
import type { HudRunInfo } from '../ui/ui';
import { addPoints, collectUnlocks, recordClimb, recordStreak, recordTowerTop } from './progress';
import { ClimbSession, type SessionConfig, type SessionResult } from './session';
import type { Services } from './services';

export interface RunHost {
  readonly svc: Services;
  /** The session the frame loop should drive (null = none). */
  attach(session: ClimbSession | null): void;
  /** Toast newly unlocked items. */
  announceUnlocks(items: UnlockedItem[]): void;
}

const HINTS_PER_RUN = 3;
const pad2 = (n: number): string => String(n).padStart(2, '0');

function waitChoice<K extends keyof AppEvents>(keys: K[]): Promise<K> {
  return new Promise((resolve) => {
    const offs = keys.map((k) =>
      bus.on(k, () => {
        for (const o of offs) o();
        resolve(k);
      }),
    );
  });
}

abstract class BaseRun {
  protected readonly host: RunHost;
  protected readonly svc: Services;
  private session: ClimbSession | null = null;
  private resultsToken = 0;

  constructor(host: RunHost) {
    this.host = host;
    this.svc = host.svc;
  }

  protected get profile(): Profile {
    return this.svc.profile();
  }

  /** Cover the screen, build the wall under the veil, then reveal the preview. */
  protected async climb(boulder: BoulderDef, cfg: Omit<SessionConfig, 'boulder' | 'preloaded'>, veil?: { kicker: string; title: string }): Promise<SessionResult> {
    const { renderer, veil: v } = this.svc;
    this.dropSession();
    if (veil) await v.cover(veil.kicker, veil.title);
    renderer.loadBoulder(boulder);
    const s = new ClimbSession(this.svc, { ...cfg, boulder, preloaded: true });
    this.session = s;
    this.host.attach(s);
    const done = s.run();
    if (v.shown) await v.reveal();
    return done;
  }

  /** Release the last session (its climber keeps rendering under the results until then). */
  protected dropSession(): void {
    if (!this.session) return;
    this.session.dispose();
    this.host.attach(null);
    this.session = null;
  }

  protected showResults(p: ResultsProps): number {
    this.svc.ui.show('results', p);
    return ++this.resultsToken;
  }

  /** Late data (rank) for the results screen that is still up. */
  protected patchResults(token: number, p: ResultsProps): void {
    if (token !== this.resultsToken || this.svc.ui.current !== 'results') return;
    this.svc.ui.update('results', p);
  }

  protected unlocks(): UnlockedItem[] {
    const u = collectUnlocks(this.profile);
    if (u.length) this.host.announceUnlocks(u);
    return u;
  }

  protected entry(mode: LeaderboardMode, score: number, sends: number, maxGrade: number, dailyKey?: string): ScoreEntry {
    const p = this.profile;
    return { player: p.playerName || 'Climber', score: Math.round(score), mode, sends, maxGrade, head: p.head, dailyKey, createdAt: Date.now() };
  }

  /** Submit a score; resolves the board rank (null when unknown / offline failure). */
  protected async submit(e: ScoreEntry): Promise<number | null> {
    try {
      const backend: BackendAPI = await this.svc.backendReady();
      const r = await backend.submitScore(e);
      return r.rank;
    } catch (err) {
      console.warn('[app] score submit failed', err);
      return null;
    }
  }

  protected confirmNewRun(score: number): Promise<boolean> {
    if (score <= 0) return Promise.resolve(true);
    return this.svc.ui.confirm('Start a new run?', `This run ends here and its ${score.toLocaleString('en-US')} pts go to the leaderboard.`, 'NEW RUN', 'CANCEL');
  }

  protected baseRun(mode: HudRunInfo['mode'], b: BoulderDef, name = b.name): HudRunInfo {
    return { mode, score: 0, streak: 0, boulderName: name, grade: b.grade, hintsLeft: HINTS_PER_RUN };
  }

  /** Leave the run: release the scene. */
  finish(): void {
    this.dropSession();
  }
}

// ═══════════════════════════════ Send Train ═══════════════════════════════

export class SendTrainRun extends BaseRun {
  private seed = 0;
  private index = 0;
  private streak = 0;
  private score = 0;
  private maxGrade = 0;
  private hints = { left: HINTS_PER_RUN };
  private bestAtStart = 0;
  private lastBoulder: BoulderDef | null = null;

  private reset(): void {
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this.index = 0;
    this.streak = 0;
    this.score = 0;
    this.maxGrade = 0;
    this.hints = { left: HINTS_PER_RUN };
    this.bestAtStart = this.profile.best.boulder;
  }

  private optsFor(i: number): { seed: number; grade: number; colorIndex: number } {
    const rng = new Rng(hashString(`send-train:${this.seed}:${i}`));
    const grade = runGradeFor(i, rng);
    return { seed: rng.int(1, 0x7ffffffe), grade, colorIndex: rng.int(0, ROUTE_COLORS.length - 1) };
  }

  async play(): Promise<void> {
    this.reset();
    for (;;) {
      const o = this.optsFor(this.index);
      const veil = { kicker: `SEND TRAIN · BOULDER ${pad2(this.index + 1)}`, title: `${gradeLabel(o.grade)} · ${this.streak ? `STREAK ×${this.streak}` : 'FIRST UP'}` };
      await this.svc.veil.cover(veil.kicker, veil.title);
      const b = await this.svc.gen.boulder(o);
      this.lastBoulder = b;
      const run: HudRunInfo = { ...this.baseRun('boulder', b), score: this.score, streak: this.streak, hintsLeft: this.hints.left };
      const restart = this.score > 0 ? { title: 'Start a new run?', body: `This run ends here and its ${this.score.toLocaleString('en-US')} pts go to the leaderboard.`, ok: 'NEW RUN' } : null;
      const climbing = this.climb(b, { run, hints: this.hints, tip: randomTip(this.seed + this.index * 7, 'boulder', b), restartPrompt: restart });
      // the next problem generates in the worker while this one is climbed
      void this.svc.gen.boulder(this.optsFor(this.index + 1)).catch(() => undefined);
      const res = await climbing;

      if (res.kind === 'quit') {
        await this.endRun(false);
        return;
      }
      if (res.kind === 'retry') {
        await this.endRun(false);
        this.reset();
        continue;
      }
      if (res.kind === 'send') {
        const sc = scoreSend({ grade: b.grade, time: res.time, par: parTime(b), flash: res.flash, streak: this.streak, hintsUsed: res.hintsUsed });
        this.streak++;
        this.score += sc.points;
        this.maxGrade = Math.max(this.maxGrade, b.grade);
        const p = this.profile;
        recordClimb(p, { sent: true, grade: b.grade, flash: res.flash, meters: res.meters });
        addPoints(p, sc.points);
        recordStreak(p, this.streak);
        if (this.score > p.best.boulder) p.best.boulder = this.score;
        const unlocks = this.unlocks();
        this.svc.save();
        bus.emit('game:send', { boulder: b, points: sc.points, flash: res.flash, time: res.time });
        this.showResults({
          kind: 'send',
          mode: 'boulder',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          points: sc.points,
          breakdown: sc.breakdown,
          runScore: this.score,
          streak: this.streak,
          best: Math.max(this.bestAtStart, this.score),
          newBest: this.score > this.bestAtStart && this.bestAtStart > 0,
          unlocks,
          canContinue: true,
        });
        for (;;) {
          const c = await waitChoice(['ui:next', 'ui:retry', 'ui:quit']);
          if (c === 'ui:next') {
            this.index++;
            break;
          }
          if (c === 'ui:quit') {
            await this.endRun(false);
            return;
          }
          if (await this.confirmNewRun(this.score)) {
            await this.endRun(false);
            this.reset();
            break;
          }
        }
        continue;
      }
      if (res.kind === 'fall') {
        const p = this.profile;
        recordClimb(p, { sent: false, grade: b.grade, flash: false, meters: res.meters });
        const unlocks = this.unlocks();
        this.svc.save();
        const props: ResultsProps = {
          kind: 'run-over',
          mode: 'boulder',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          runScore: this.score,
          streak: this.streak,
          best: Math.max(this.bestAtStart, this.score),
          newBest: this.score > this.bestAtStart && this.score > 0,
          unlocks,
          canContinue: false,
          tip: tipFor(res.reason, this.seed + this.index, 'boulder', b),
          rank: this.score > 0 ? undefined : null,
        };
        const token = this.showResults(props);
        const rank = this.endRun(true);
        void rank.then((r) => this.patchResults(token, { ...props, rank: r }));
        const c = await waitChoice(['ui:retry', 'ui:quit']);
        if (c === 'ui:quit') return;
        this.reset();
      }
    }
  }

  /** Bank the run: best + leaderboard. Resolves the rank (null if not submitted). */
  private endRun(showsResults: boolean): Promise<number | null> {
    const score = this.score;
    const sends = this.streak;
    const maxGrade = this.maxGrade;
    bus.emit('game:run-over', { mode: 'boulder', score });
    const p = this.profile;
    if (score > p.best.boulder) p.best.boulder = score;
    this.svc.save();
    this.score = 0;
    this.streak = 0;
    if (score <= 0) return Promise.resolve(null);
    const r = this.submit(this.entry('boulder', score, sends, maxGrade));
    if (!showsResults) {
      void r.then((rank) => this.svc.ui.hud.toast(rank ? `RUN SAVED · ${score.toLocaleString('en-US')} PTS · RANK #${rank}` : `RUN SAVED · ${score.toLocaleString('en-US')} PTS`));
    }
    return r;
  }

  get boulder(): BoulderDef | null {
    return this.lastBoulder;
  }
}

// ═══════════════════════════════ Lead Tower ═══════════════════════════════

export class LeadTowerRun extends BaseRun {
  private seed = 0;
  private index = 0;
  private total = 0;
  private tops = 0;
  private maxGrade = 0;
  private lives = { left: GAME.ropeLives };
  private hints = { left: HINTS_PER_RUN };
  private bestAtStart = 0;

  private reset(): void {
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this.index = 0;
    this.total = 0;
    this.tops = 0;
    this.maxGrade = 0;
    this.lives = { left: GAME.ropeLives };
    this.hints = { left: HINTS_PER_RUN };
    this.bestAtStart = this.profile.best.rope;
  }

  private gradeFor(i: number): number {
    return Math.min(12, 1 + Math.floor(i * 1.5));
  }

  async play(): Promise<void> {
    this.reset();
    for (;;) {
      const grade = this.gradeFor(this.index);
      const seed = hashString(`lead-tower:${this.seed}:${this.index}`);
      await this.svc.veil.cover(`LEAD TOWER · ROUTE ${pad2(this.index + 1)}`, `${gradeLabel(grade)} · ${GAME.ropeWall.height} M`);
      const b = await this.svc.gen.rope({ seed, grade });
      const run: HudRunInfo = { ...this.baseRun('rope', b), score: this.total, streak: this.tops, lives: this.lives.left, hintsLeft: this.hints.left };
      const restart = this.total > 0 ? { title: 'Start a new run?', body: `This run ends here and its ${this.total.toLocaleString('en-US')} pts go to the leaderboard.`, ok: 'NEW RUN' } : null;
      const res = await this.climb(b, { run, hints: this.hints, lives: this.lives, tip: randomTip(this.seed + this.index * 3 + 1, 'rope', b), restartPrompt: restart });
      if (res.kind === 'quit') {
        await this.endRun(false);
        return;
      }
      if (res.kind === 'retry') {
        await this.endRun(false);
        this.reset();
        continue;
      }
      if (res.kind !== 'rope') continue;

      const pts = scoreRope({ heightM: res.heightM, clips: res.clips, topped: res.topped, falls: res.falls, grade: b.grade });
      const breakdown = ropeBreakdown(res.heightM, res.clips, res.topped, res.falls, b.grade, pts);
      this.total += pts;
      const p = this.profile;
      p.stats.clips += res.clips;
      recordClimb(p, { sent: res.topped, grade: b.grade, flash: res.flash, meters: res.meters });
      addPoints(p, pts);
      if (res.topped) {
        this.tops++;
        this.maxGrade = Math.max(this.maxGrade, b.grade);
        recordTowerTop(p);
        recordStreak(p, this.tops);
      }
      if (this.total > p.best.rope) p.best.rope = this.total;
      const unlocks = this.unlocks();
      this.svc.save();

      if (res.topped) {
        bus.emit('game:send', { boulder: b, points: pts, flash: res.flash, time: res.time });
        this.showResults({
          kind: 'topped-rope',
          mode: 'rope',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          points: pts,
          breakdown,
          runScore: this.total,
          streak: this.tops,
          best: Math.max(this.bestAtStart, this.total),
          newBest: this.total > this.bestAtStart && this.bestAtStart > 0,
          unlocks,
          canContinue: true,
        });
        for (;;) {
          const c = await waitChoice(['ui:next', 'ui:retry', 'ui:quit']);
          if (c === 'ui:next') {
            this.index++;
            break;
          }
          if (c === 'ui:quit') {
            await this.endRun(false);
            return;
          }
          if (await this.confirmNewRun(this.total)) {
            await this.endRun(false);
            this.reset();
            break;
          }
        }
        continue;
      }

      const props: ResultsProps = {
        kind: 'run-over',
        mode: 'rope',
        boulderName: b.name,
        grade: b.grade,
        time: res.time,
        points: pts,
        breakdown,
        runScore: this.total,
        streak: this.tops,
        best: Math.max(this.bestAtStart, this.total),
        newBest: this.total > this.bestAtStart && this.total > 0,
        unlocks,
        canContinue: false,
        tip: tipFor(res.reason ?? 'forced', this.seed + this.index, 'rope', b),
        rank: this.total > 0 ? undefined : null,
      };
      const token = this.showResults(props);
      void this.endRun(true).then((rank) => this.patchResults(token, { ...props, rank }));
      const c = await waitChoice(['ui:retry', 'ui:quit']);
      if (c === 'ui:quit') return;
      this.reset();
    }
  }

  private endRun(showsResults: boolean): Promise<number | null> {
    const score = this.total;
    bus.emit('game:run-over', { mode: 'rope', score });
    const p = this.profile;
    if (score > p.best.rope) p.best.rope = score;
    this.svc.save();
    this.total = 0;
    if (score <= 0) return Promise.resolve(null);
    const r = this.submit(this.entry('rope', score, this.tops, this.maxGrade));
    if (!showsResults) {
      void r.then((rank) => this.svc.ui.hud.toast(rank ? `TOWER SAVED · ${score.toLocaleString('en-US')} PTS · RANK #${rank}` : `TOWER SAVED · ${score.toLocaleString('en-US')} PTS`));
    }
    return r;
  }
}

/** Lead Tower breakdown that sums exactly to scoreRope()'s total. */
function ropeBreakdown(heightM: number, clips: number, topped: boolean, falls: number, grade: number, total: number): { label: string; value: number }[] {
  const g = Math.max(0, Math.min(12, grade));
  const gw = 1 + 0.15 * g;
  const c = Math.round(Math.max(0, clips) * 60 * gw);
  const t = topped ? Math.round(1000 * (1 + 0.2 * g)) : 0;
  const f = Math.max(0, falls) * 150;
  const out: { label: string; value: number }[] = [];
  const h = total - c - t + f;
  out.push({ label: `Height ${heightM.toFixed(1)} m`, value: h });
  if (c) out.push({ label: `Clips ×${clips}`, value: c });
  if (t) out.push({ label: 'Topped out', value: t });
  if (f) out.push({ label: `Falls ×${falls}`, value: -f });
  return out;
}

// ═══════════════════════════════ Daily ═══════════════════════════════

export class DailyRun extends BaseRun {
  async play(): Promise<void> {
    const key = todayKey();
    await this.svc.veil.cover('DAILY BOULDER', key);
    const b = await this.svc.gen.daily(key);
    let first = true;
    for (;;) {
      const run = this.baseRun('daily', b);
      const res = await this.climb(b, { run, hints: { left: HINTS_PER_RUN }, tip: randomTip(hashString(key), 'boulder', b) }, first ? undefined : { kicker: 'DAILY BOULDER', title: 'ANOTHER GO' });
      first = false;
      if (res.kind === 'quit') return;
      if (res.kind === 'retry') continue;
      const p = this.profile;
      const best = p.best.daily[key] ?? 0;
      if (res.kind === 'send') {
        const sc = scoreDaily(b, res.time, res.flash, res.hintsUsed);
        const newBest = sc.points > best;
        recordClimb(p, { sent: true, grade: b.grade, flash: res.flash, meters: res.meters });
        if (newBest) {
          addPoints(p, sc.points - best);
          p.best.daily[key] = sc.points;
        }
        const unlocks = this.unlocks();
        this.svc.save();
        bus.emit('game:send', { boulder: b, points: sc.points, flash: res.flash, time: res.time });
        const props: ResultsProps = {
          kind: 'send',
          mode: 'daily',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          points: sc.points,
          breakdown: sc.breakdown,
          runScore: sc.points,
          streak: 0,
          best: Math.max(best, sc.points),
          newBest: newBest && best > 0,
          unlocks,
          canContinue: false,
          rank: newBest ? undefined : null,
        };
        const token = this.showResults(props);
        if (newBest) {
          void this.submit(this.entry('daily', sc.points, 1, b.grade, key)).then((rank) => this.patchResults(token, { ...props, rank }));
        }
      } else if (res.kind === 'fall') {
        recordClimb(p, { sent: false, grade: b.grade, flash: false, meters: res.meters });
        const unlocks = this.unlocks();
        this.svc.save();
        this.showResults({
          kind: 'fall',
          mode: 'daily',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          runScore: 0,
          streak: 0,
          best,
          newBest: false,
          unlocks,
          canContinue: false,
          tip: tipFor(res.reason, undefined, 'boulder', b),
        });
      }
      const c = await waitChoice(['ui:retry', 'ui:quit']);
      if (c === 'ui:quit') return;
    }
  }
}

// ═══════════════════════════════ Community ═══════════════════════════════

export class CommunityRun extends BaseRun {
  constructor(host: RunHost, private readonly problem: CommunityProblem) {
    super(host);
  }

  async play(): Promise<void> {
    const pr = this.problem;
    const b: BoulderDef = { ...pr.boulder, name: pr.name, grade: pr.grade, author: pr.author || pr.boulder.author };
    let best = 0;
    let veil: { kicker: string; title: string } | undefined = { kicker: `COMMUNITY · BY ${(b.author || 'A CLIMBER').toUpperCase()}`, title: b.name };
    for (;;) {
      const run = this.baseRun('community', b);
      const res = await this.climb(b, { run, hints: { left: HINTS_PER_RUN }, tip: randomTip(hashString(pr.id), 'boulder', b) }, veil);
      veil = { kicker: 'COMMUNITY', title: 'ANOTHER GO' };
      if (res.kind === 'quit') return;
      if (res.kind === 'retry') continue;
      const p = this.profile;
      if (res.kind === 'send') {
        void this.record(true);
        const sc = scoreSend({ grade: b.grade, time: res.time, par: parTime(b), flash: res.flash, streak: 0, hintsUsed: res.hintsUsed });
        recordClimb(p, { sent: true, grade: b.grade, flash: res.flash, meters: res.meters });
        if (sc.points > best) addPoints(p, sc.points - best);
        const newBest = sc.points > best && best > 0;
        best = Math.max(best, sc.points);
        const unlocks = this.unlocks();
        this.svc.save();
        bus.emit('game:send', { boulder: b, points: sc.points, flash: res.flash, time: res.time });
        this.showResults({
          kind: 'send',
          mode: 'community',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          points: sc.points,
          breakdown: sc.breakdown,
          runScore: sc.points,
          streak: 0,
          best,
          newBest,
          unlocks,
          canContinue: false,
        });
      } else if (res.kind === 'fall') {
        void this.record(false);
        recordClimb(p, { sent: false, grade: b.grade, flash: false, meters: res.meters });
        const unlocks = this.unlocks();
        this.svc.save();
        this.showResults({
          kind: 'fall',
          mode: 'community',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          runScore: 0,
          streak: 0,
          best,
          newBest: false,
          unlocks,
          canContinue: false,
          tip: tipFor(res.reason, undefined, 'boulder', b),
        });
      }
      const c = await waitChoice(['ui:retry', 'ui:quit']);
      if (c === 'ui:quit') return;
    }
  }

  private async record(sent: boolean): Promise<void> {
    try {
      const backend = await this.svc.backendReady();
      await backend.recordAttempt(this.problem.id, sent);
    } catch (err) {
      console.warn('[app] recordAttempt failed', err);
    }
  }
}

// ═══════════════════════════════ Editor test ═══════════════════════════════

export class TestRun extends BaseRun {
  constructor(host: RunHost, private readonly boulder: BoulderDef) {
    super(host);
  }

  /** Resolves true when the problem was sent. */
  async play(): Promise<boolean> {
    const b = this.boulder;
    let veil: { kicker: string; title: string } | undefined = { kicker: 'TEST CLIMB', title: b.name || 'Untitled problem' };
    for (;;) {
      const run = this.baseRun('test', b);
      const res = await this.climb(b, { run, hints: { left: HINTS_PER_RUN } }, veil);
      veil = { kicker: 'TEST CLIMB', title: 'ANOTHER GO' };
      if (res.kind === 'quit') return false;
      if (res.kind === 'retry') continue;
      if (res.kind === 'send') {
        recordClimb(this.profile, { sent: true, grade: b.grade, flash: res.flash, meters: res.meters });
        this.svc.save();
        return true;
      }
      if (res.kind === 'fall') {
        this.showResults({
          kind: 'fall',
          mode: 'test',
          boulderName: b.name,
          grade: b.grade,
          time: res.time,
          runScore: 0,
          streak: 0,
          best: 0,
          newBest: false,
          canContinue: false,
          tip: tipFor(res.reason, undefined, 'boulder', b),
        });
        const c = await waitChoice(['ui:retry', 'ui:quit']);
        if (c === 'ui:quit') return false;
      }
    }
  }
}

// App: the state machine that ties every module together.
//
//   boot → splash (tap: audio unlock + music)
//        → first launch: Steini's intro → name → tutorial (SKIP offered) → title
//        → returning players: title
//   title / menus (live 3D backdrop) ⇄ runs (Send Train, Lead Tower, Daily, Community),
//   tutorial replay, editor (+ test climbs, publish), leaderboard, locker, settings, profile.
//
// Navigation between menu screens is a small stack; 'ui:back' pops it everywhere.

import type { BackendAPI } from '../core/contracts';
import { bus, type AppEvents } from '../core/events';
import type { BoulderDef, ChalkId, ColorwayId, CommunityProblem, HeadId, LeaderboardMode, Profile, Settings } from '../core/types';
import { CHALKS, COLORWAYS, HEADS } from '../config/skins';
import type { BoulderEditor } from '../editor/editor';
import { todayKey, tutorialBoulder } from '../game/generator';
import { defaultProfile, randomClimberName, sanitizeName, saveProfile, flushProfile, type UnlockedItem } from '../net/profile';
import { runIntro } from '../tutorial/tutorial';
import { collectUnlocks, UNLOCK_WORD } from './progress';
import { QualityManager } from './quality';
import { CommunityRun, DailyRun, LeadTowerRun, SendTrainRun, TestRun, type RunHost } from './runs';
import type { ClimbSession } from './session';
import type { Services } from './services';
import { TitleScene } from './title-scene';
import { TutorialRun } from './tutorial-run';

type MenuScreen = 'title' | 'modes' | 'leaderboard' | 'locker' | 'settings' | 'community' | 'profile';
type AppState = 'boot' | 'splash' | 'intro' | 'onboarding' | 'menu' | 'run' | 'tutorial' | 'editor';

export interface AppOptions {
  services: Omit<Services, 'profile' | 'save' | 'backend' | 'backendReady'>;
  profile: Profile;
  backend: Promise<BackendAPI>;
  createEditor: (svc: Services) => BoulderEditor;
}

export class App implements RunHost {
  readonly svc: Services;
  readonly quality: QualityManager;
  readonly editor: BoulderEditor;
  readonly title: TitleScene;

  private state: AppState = 'boot';
  private nav: MenuScreen[] = ['title'];
  private prof: Profile;
  private backendRef: BackendAPI | null = null;
  private readonly backendP: Promise<BackendAPI>;
  private session: ClimbSession | null = null;
  private tutorial: TutorialRun | null = null;
  private lbMode: LeaderboardMode = 'boulder';
  private cmSort: 'new' | 'popular' = 'new';
  private fetchToken = 0;
  private backPressed = false;
  private readonly offs: (() => void)[] = [];

  constructor(opts: AppOptions) {
    this.prof = opts.profile;
    this.backendP = opts.backend.then((b) => {
      this.backendRef = b;
      this.onBackend(b);
      return b;
    });
    const base = opts.services;
    this.svc = {
      ...base,
      profile: () => this.prof,
      save: () => saveProfile(this.prof),
      backend: () => this.backendRef,
      backendReady: () => this.backendP,
    };
    this.quality = new QualityManager(base.renderer);
    this.title = new TitleScene(this.svc);
    this.editor = opts.createEditor(this.svc);
    this.svc.ui.onResetProgress = () => this.resetProgress();
  }

  // ═══════════════════════════════ queries (QA / main loop) ═══════════════════════════════

  get current(): AppState {
    return this.state;
  }

  get profile(): Profile {
    return this.prof;
  }

  get activeSession(): ClimbSession | null {
    return this.session;
  }

  /** The sim driving the climber right now (session, tutorial or the title backdrop). */
  get sim() {
    return this.session?.sim ?? this.tutorial?.currentSim ?? (this.title.isActive ? this.title.currentSim : null);
  }

  /** A climb is live (not paused, not in a menu). */
  get playing(): boolean {
    return !!(this.session?.live || this.tutorial?.live);
  }

  // ═══════════════════════════════ boot ═══════════════════════════════

  /** Apply the stored settings + skin and put the backdrop up (behind the splash). */
  boot(): void {
    const p = this.prof;
    this.applySettings(p.settings, false);
    this.svc.renderer.setSkin(p.head, p.colorway, p.chalk);
    this.title.enter('title');
    void this.title.prepare();
    this.wire();
  }

  /** Splash → onboarding → title. */
  async start(): Promise<void> {
    const { ui, audio } = this.svc;
    this.state = 'splash';
    ui.show('splash', {});
    await bus.wait('ui:start-intro-done');
    await Promise.race([audio.unlock(), new Promise((r) => setTimeout(r, 1500))]);
    audio.setAmbience(true);
    audio.setMusic('menu');
    audio.play('ui-confirm', { volume: 0.7 });

    const p = this.prof;
    const firstLaunch = !p.introSeen;
    if (firstLaunch) {
      this.state = 'intro';
      await this.svc.veil.cover('', '', true);
      this.title.leave();
      const { renderer } = this.svc;
      renderer.loadBoulder(tutorialBoulder());
      renderer.setClimberVisible(true);
      renderer.setCameraMode('title', { instant: true });
      ui.show('none', {});
      void this.svc.veil.reveal();
      try {
        await runIntro({ renderer, ui, audio });
      } catch (err) {
        // the cinematic is a nicety: never let it keep a first-time player out of the game
        console.error('[app] intro failed', err);
        ui.guide.hide();
      }
      p.introSeen = true;
      this.svc.save();
    }
    if (!p.playerName.trim()) {
      this.state = 'onboarding';
      ui.show('name', { current: '' });
      const { name } = await bus.wait('ui:set-name');
      p.playerName = sanitizeName(name) || randomClimberName();
      this.svc.save();
    }
    if (firstLaunch && !p.tutorialDone) {
      await this.playTutorial();
      return;
    }
    await this.toMenu('title', true);
    // rules can change between versions: hand out anything this profile already earned
    const late = collectUnlocks(p);
    if (late.length) {
      this.announceUnlocks(late);
      this.svc.save();
    }
  }

  // ═══════════════════════════════ frame ═══════════════════════════════

  frame(dt: number): void {
    this.quality.sample(dt, this.playing);
    if (this.session) this.session.frame(dt);
    else if (this.tutorial) this.tutorial.frame(dt);
    else if (this.title.isActive) this.title.frame(dt);
    if (this.editor.isOpen) this.editor.frame(dt);
  }

  postFrame(dt: number): void {
    if (this.session) this.session.postFrame(dt);
    else if (this.tutorial) this.tutorial.postFrame(dt);
  }

  /** Tab hidden / app backgrounded: pause a live climb. */
  onHidden(): void {
    if (this.playing) bus.emit('ui:pause');
  }

  // ═══════════════════════════════ RunHost ═══════════════════════════════

  attach(session: ClimbSession | null): void {
    this.session = session;
  }

  announceUnlocks(items: UnlockedItem[]): void {
    items.forEach((u, i) => {
      setTimeout(() => {
        this.svc.ui.hud.toast(`UNLOCKED · NEW ${UNLOCK_WORD[u.kind]} · ${u.name.toUpperCase()}`);
        this.svc.audio.play('unlock');
      }, 900 + i * 700);
    });
  }

  // ═══════════════════════════════ wiring ═══════════════════════════════

  private wire(): void {
    const on = <K extends keyof AppEvents>(k: K, fn: (p: AppEvents[K]) => void): void => {
      this.offs.push(bus.on(k, fn));
    };
    const { audio, ui } = this.svc;

    // UI sounds: one tap sound per press, a softer swipe for back
    on('ui:tap', () => {
      queueMicrotask(() => {
        if (!this.backPressed) audio.play('ui-tap');
        this.backPressed = false;
      });
    });
    on('ui:back', () => {
      this.backPressed = true;
      audio.play('ui-back');
      if (this.state === 'menu' && ui.current !== 'name') this.back();
    });

    on('ui:open', ({ screen }) => {
      if (this.state !== 'menu') return;
      if (screen === 'menu') {
        this.nav = ['title'];
        this.show('title');
      } else if (screen === 'editor') this.openEditor();
      else this.push(screen);
    });
    on('ui:play', ({ mode }) => {
      if (this.state !== 'menu') return;
      audio.play('ui-confirm');
      if (mode === 'boulder') void this.runFlow(new SendTrainRun(this));
      else if (mode === 'rope') void this.runFlow(new LeadTowerRun(this));
      else void this.runFlow(new DailyRun(this));
    });
    on('ui:play-problem', ({ problem }) => {
      if (this.state !== 'menu') return;
      audio.play('ui-confirm');
      void this.runFlow(new CommunityRun(this, problem));
    });
    on('ui:tutorial', () => {
      if (this.state !== 'menu') return;
      void this.playTutorial();
    });

    on('ui:select-head', ({ head }) => this.equip('head', head));
    on('ui:select-colorway', ({ colorway }) => this.equip('colorway', colorway));
    on('ui:select-chalk', ({ chalk }) => this.equip('chalk', chalk));
    on('ui:settings-changed', ({ settings }) => this.applySettings(settings, true));
    on('ui:set-name', ({ name }) => {
      const clean = sanitizeName(name);
      if (!clean || this.state === 'onboarding') return;
      this.prof.playerName = clean;
      this.svc.save();
    });
    on('ui:leaderboard-tab', ({ mode }) => {
      this.lbMode = mode;
      void this.fetchLeaderboard();
    });
    on('ui:community-refresh', ({ sort }) => {
      this.cmSort = sort;
      void this.fetchCommunity();
    });

    on('editor:test', ({ boulder }) => void this.testClimb(boulder));
    on('editor:publish', ({ boulder }) => void this.publish(boulder));
    on('editor:close', () => {
      if (this.state !== 'editor') return;
      void this.toMenu(this.top(), false);
    });
  }

  // ═══════════════════════════════ menus ═══════════════════════════════

  private top(): MenuScreen {
    return this.nav[this.nav.length - 1] ?? 'title';
  }

  private push(screen: MenuScreen): void {
    const i = this.nav.indexOf(screen);
    if (i >= 0) this.nav.length = i + 1;
    else this.nav.push(screen);
    this.show(screen);
  }

  private back(): void {
    if (this.nav.length <= 1) {
      if (this.svc.ui.current !== 'title') this.show('title');
      return;
    }
    this.nav.pop();
    this.show(this.top());
  }

  /** Return from a run / the editor / onboarding to a menu screen over the backdrop. */
  private async toMenu(screen: MenuScreen, fromSplash: boolean): Promise<void> {
    const { veil, audio } = this.svc;
    if (!fromSplash || this.svc.renderer.getBoulder()?.id === 'tutorial' || !this.title.isActive) {
      if (!veil.shown) await veil.cover('', '', true);
    }
    this.title.enter(screen === 'locker' ? 'locker' : 'title');
    this.state = 'menu';
    audio.setMusic('menu');
    if (screen === 'title') this.nav = ['title'];
    else if (this.nav[this.nav.length - 1] !== screen) this.nav = ['title', screen];
    this.show(screen);
    if (veil.shown) await veil.reveal();
  }

  private show(screen: MenuScreen): void {
    const { ui } = this.svc;
    const p = this.prof;
    this.title.setFraming(screen === 'locker' ? 'locker' : 'title');
    switch (screen) {
      case 'title':
        ui.show('title', { profile: p, backendLabel: this.backendLabel() });
        break;
      case 'modes': {
        const key = todayKey();
        ui.show('modes', { profile: p, dailyKey: key, dailyBest: p.best.daily[key] });
        break;
      }
      case 'leaderboard':
        ui.show('leaderboard', { mode: this.lbMode, entries: null, me: p.playerName, isGlobal: !!this.backendRef?.isGlobal, dailyKey: todayKey() });
        void this.fetchLeaderboard();
        break;
      case 'locker':
        ui.show('locker', { profile: p });
        break;
      case 'settings':
        ui.show('settings', { profile: p });
        break;
      case 'community':
        ui.show('community', { problems: null, sort: this.cmSort, isGlobal: !!this.backendRef?.isGlobal });
        void this.fetchCommunity();
        break;
      case 'profile':
        ui.show('profile', { profile: p });
        break;
    }
  }

  private backendLabel(): string {
    return this.backendRef ? this.backendRef.label : 'CONNECTING';
  }

  private onBackend(b: BackendAPI): void {
    const { ui } = this.svc;
    ui.setBackendLabel(b.label); // boards badge GLOBAL vs CLAUDE SHARED from this
    if (this.state !== 'menu') return;
    if (ui.current === 'title') ui.update('title', { profile: this.prof, backendLabel: b.label });
  }

  private async fetchLeaderboard(): Promise<void> {
    const token = ++this.fetchToken;
    const mode = this.lbMode;
    const key = todayKey();
    const { ui } = this.svc;
    if (ui.current === 'leaderboard') ui.update('leaderboard', { mode, entries: null, me: this.prof.playerName, isGlobal: !!this.backendRef?.isGlobal, dailyKey: key });
    let entries: Awaited<ReturnType<BackendAPI['topScores']>> = [];
    let isGlobal = false;
    try {
      const b = await this.backendP;
      entries = await b.topScores(mode, { limit: 50, dailyKey: mode === 'daily' ? key : undefined });
      isGlobal = b.isGlobal;
    } catch (err) {
      console.warn('[app] leaderboard fetch failed', err);
      ui.hud.toast('LEADERBOARD UNAVAILABLE · TRY AGAIN SOON');
    }
    if (token !== this.fetchToken || ui.current !== 'leaderboard' || mode !== this.lbMode) return;
    ui.update('leaderboard', { mode, entries, me: this.prof.playerName, isGlobal, dailyKey: key });
  }

  private async fetchCommunity(): Promise<void> {
    const token = ++this.fetchToken;
    const sort = this.cmSort;
    const { ui } = this.svc;
    let problems: CommunityProblem[] = [];
    let isGlobal = false;
    try {
      const b = await this.backendP;
      problems = await b.listProblems({ sort, limit: 30 });
      isGlobal = b.isGlobal;
    } catch (err) {
      console.warn('[app] community fetch failed', err);
      ui.hud.toast('COMMUNITY WALL UNAVAILABLE · TRY AGAIN SOON');
    }
    if (token !== this.fetchToken || ui.current !== 'community' || sort !== this.cmSort) return;
    ui.update('community', { problems, sort, isGlobal });
  }

  // ═══════════════════════════════ locker + settings ═══════════════════════════════

  private equip(kind: 'head', id: HeadId): void;
  private equip(kind: 'colorway', id: ColorwayId): void;
  private equip(kind: 'chalk', id: ChalkId): void;
  private equip(kind: 'head' | 'colorway' | 'chalk', id: string): void {
    const p = this.prof;
    if (kind === 'head') {
      if (!p.unlocked.heads.includes(id as HeadId) || !HEADS.some((h) => h.id === id)) return;
      p.head = id as HeadId;
    } else if (kind === 'colorway') {
      if (!p.unlocked.colorways.includes(id as ColorwayId) || !COLORWAYS.some((c) => c.id === id)) return;
      p.colorway = id as ColorwayId;
    } else {
      if (!p.unlocked.chalks.includes(id as ChalkId) || !CHALKS.some((c) => c.id === id)) return;
      p.chalk = id as ChalkId;
    }
    this.svc.renderer.setSkin(p.head, p.colorway, p.chalk);
    this.svc.audio.play('ui-confirm', { volume: 0.6 });
    if (kind === 'chalk') this.svc.renderer.fx.chalkPuff(this.title.state.limbs.RH.pos, 1.2);
    this.svc.save();
    if (this.svc.ui.current === 'locker') this.svc.ui.update('locker', { profile: p });
  }

  private applySettings(s: Settings, persist: boolean): void {
    const { audio, controls, ui, veil } = this.svc;
    const prev = this.prof.settings;
    const qualityChanged = !persist || prev.quality !== s.quality;
    this.prof.settings = { ...s };
    audio.setVolumes(s.sfx, s.music);
    audio.setHaptics(s.haptics);
    controls.setAssist(s.assist);
    controls.setReducedMotion(s.reducedMotion);
    veil.setReducedMotion(s.reducedMotion);
    ui.setSettings(s);
    if (qualityChanged) this.quality.apply(s.quality);
    if (persist) this.svc.save();
  }

  private resetProgress(): void {
    const old = this.prof;
    const fresh = defaultProfile();
    fresh.playerName = old.playerName;
    fresh.settings = { ...old.settings };
    fresh.introSeen = true;
    this.prof = fresh;
    this.svc.renderer.setSkin(fresh.head, fresh.colorway, fresh.chalk);
    saveProfile(fresh);
    flushProfile();
    try {
      localStorage.removeItem('jgu.editor.draft');
    } catch {
      /* storage blocked */
    }
    if (this.svc.ui.current === 'settings') this.svc.ui.update('settings', { profile: fresh });
  }

  // ═══════════════════════════════ runs ═══════════════════════════════

  private async runFlow(run: { play(): Promise<unknown>; finish(): void }): Promise<void> {
    this.state = 'run';
    this.title.leave();
    try {
      await run.play();
    } catch (err) {
      console.error('[app] run failed', err);
      this.svc.ui.hud.toast('SOMETHING SLIPPED · BACK TO THE MENU');
    } finally {
      run.finish();
      this.session = null;
    }
    await this.toMenu(this.top(), false);
  }

  private async playTutorial(): Promise<void> {
    const { veil, ui, audio } = this.svc;
    this.state = 'tutorial';
    await veil.cover('TUTORIAL · WITH STEINI', 'FIRST STEPS');
    this.title.leave();
    const t = new TutorialRun(this.svc);
    this.tutorial = t;
    const done = t.play();
    await veil.reveal();
    let result: 'done' | 'skipped' = 'skipped';
    try {
      result = await done;
    } catch (err) {
      console.error('[app] tutorial failed', err);
    }
    this.tutorial = null;
    const p = this.prof;
    if (result === 'done') {
      ui.hud.toast('TUTORIAL COMPLETE');
      audio.play('unlock', { volume: 0.7 });
      if (!p.tutorialDone) {
        p.tutorialDone = true;
        this.announceUnlocks(collectUnlocks(p));
      }
      this.svc.save();
    }
    await this.toMenu(this.top(), false);
  }

  // ═══════════════════════════════ editor ═══════════════════════════════

  private openEditor(initial?: BoulderDef): void {
    this.state = 'editor';
    this.title.leave();
    this.editor.author = this.prof.playerName;
    this.editor.open(initial);
  }

  private async testClimb(boulder: BoulderDef): Promise<void> {
    if (this.state !== 'editor') return;
    this.state = 'run';
    const run = new TestRun(this, boulder);
    let sent = false;
    try {
      sent = await run.play();
    } catch (err) {
      console.error('[app] test climb failed', err);
    }
    const { veil } = this.svc;
    await veil.cover('EDITOR', sent ? 'SENT · PUBLISH UNLOCKED' : 'BACK TO THE WALL', true);
    run.finish();
    this.session = null;
    this.state = 'editor';
    this.editor.reportTestResult(sent);
    this.editor.author = this.prof.playerName;
    this.editor.open(boulder);
    this.svc.audio.setMusic('menu');
    await veil.reveal();
  }

  private async publish(boulder: BoulderDef): Promise<void> {
    const p = this.prof;
    const author = boulder.author || p.playerName || 'Climber';
    const b: BoulderDef = { ...boulder, author, createdAt: boulder.createdAt ?? Date.now() };
    const i = p.myProblems.findIndex((x) => x.id === b.id);
    if (i >= 0) p.myProblems[i] = b;
    else p.myProblems.push(b);
    this.svc.save();
    try {
      const backend = await this.backendP;
      await backend.publishProblem({ name: b.name, author, grade: b.grade, boulder: b });
      this.svc.ui.hud.toast(backend.isGlobal ? `“${b.name.toUpperCase()}” IS LIVE · ${backend.label}` : `“${b.name.toUpperCase()}” SAVED · ${backend.label}`);
    } catch (err) {
      console.warn('[app] publish failed', err);
      this.svc.ui.hud.toast('PUBLISH FAILED · SAVED ON THIS DEVICE');
    }
  }
}

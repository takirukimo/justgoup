// Steini's lesson, hosted by the app: the app owns the sim stepping, the HUD and pause; the tutorial
// director owns the camera, the guide, highlights and limb gating while it runs.
// Pure climbing is suspended for the lesson (it teaches with the gauges, handles and target rings
// it points at) and comes back on its own when the lesson ends, however it ends.

import { bus, type AppEvents } from '../core/events';
import type { ClimberState, RunInfo } from '../core/types';
import { ClimberSim } from '../game/climber-sim';
import { tutorialBoulder } from '../game/generator';
import { runTutorial, TUTORIAL_SIM_OPTIONS } from '../tutorial/tutorial';
import { suspendPure } from '../input/pure';
import { SimDriver } from './driver';
import type { Services } from './services';

export class TutorialRun {
  private readonly svc: Services;
  private sim: ClimberSim | null = null;
  private driver: SimDriver | null = null;
  private readonly offs: (() => void)[] = [];
  private paused = false;
  private skip: (() => void) | null = null;
  private restart = false;
  private run: RunInfo;

  constructor(svc: Services) {
    this.svc = svc;
    const b = tutorialBoulder();
    this.run = { mode: 'tutorial', score: 0, streak: 0, boulderName: b.name, grade: b.grade };
  }

  get state(): ClimberState | null {
    return this.sim ? this.sim.getState() : null;
  }

  get live(): boolean {
    return !!this.sim && !this.paused && this.sim.getState().phase === 'climbing';
  }

  get currentSim(): ClimberSim | null {
    return this.sim;
  }

  async play(): Promise<'done' | 'skipped'> {
    const on = <K extends keyof AppEvents>(k: K, fn: (p: AppEvents[K]) => void): void => {
      this.offs.push(bus.on(k, fn));
    };
    on('ui:pause', () => this.pause());
    on('ui:resume', () => this.resume());
    on('ui:retry', () => {
      if (!this.paused) return;
      this.restart = true;
      this.resume();
      this.skip?.();
    });
    on('ui:quit', () => {
      // the director treats 'ui:quit' as a skip on its own; we only drop the pause overlay
      if (this.paused) this.resume();
    });
    let result: 'done' | 'skipped' = 'skipped';
    suspendPure('tutorial', true);
    try {
      do {
        this.restart = false;
        result = await this.attempt();
      } while (this.restart);
    } finally {
      for (const o of this.offs) o();
      this.offs.length = 0;
      this.teardown();
      suspendPure('tutorial', false);
    }
    return result;
  }

  private async attempt(): Promise<'done' | 'skipped'> {
    const { renderer, controls, ui, audio } = this.svc;
    this.teardown();
    const b = tutorialBoulder();
    renderer.loadBoulder(b);
    renderer.setClimberVisible(true);
    const sim = new ClimberSim(b, TUTORIAL_SIM_OPTIONS);
    this.sim = sim;
    this.driver = new SimDriver(this.svc, sim, { lookAhead: false });
    renderer.updateClimber(sim.getState(), 0);
    controls.bind(sim);
    controls.setAllowed('all', true);
    controls.setEnabled(true);
    ui.show('hud', { run: this.run });
    audio.setMusic('climb');
    const skipSignal = new Promise<void>((r) => (this.skip = r));
    return runTutorial({ sim, renderer, controls, ui, audio, skipSignal });
  }

  private pause(): void {
    if (this.paused || !this.sim) return;
    this.paused = true;
    if (this.driver) this.driver.paused = true;
    this.svc.controls.cancelDrag();
    this.svc.controls.setEnabled(false);
    this.svc.ui.show('pause', { run: { ...this.run } });
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.driver) this.driver.paused = false;
    this.svc.controls.setEnabled(true);
    this.svc.ui.show('hud', { run: this.run });
  }

  frame(dt: number): void {
    if (!this.driver) return;
    if (!this.paused) this.driver.step(dt * this.svc.timeScale);
    this.driver.render(dt);
    this.svc.ui.hud.update(this.driver.state, this.run);
  }

  postFrame(dt: number): void {
    if (!this.driver) return;
    this.svc.controls.update(this.driver.state, dt);
  }

  private teardown(): void {
    this.driver?.dispose();
    this.driver = null;
    this.sim = null;
    this.paused = false;
    const { controls } = this.svc;
    controls.cancelDrag();
    controls.setEnabled(false);
    controls.bind(null);
  }
}

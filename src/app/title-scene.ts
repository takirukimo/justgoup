// The living backdrop behind every menu: a CHIRAL problem on the wall, the climber hanging on its
// start holds (breathing, idling) and Steini on the mats keeping an eye on things.

import type { GuideState } from '../core/contracts';
import type { BoulderDef, ClimberState } from '../core/types';
import { hashString } from '../core/rng';
import { ClimberSim } from '../game/climber-sim';
import { tutorialBoulder } from '../game/generator';
import type { Services } from './services';

export type BackdropFraming = 'title' | 'locker';

const FRAMING: Record<BackdropFraming, { lift: number; distance: number }> = {
  title: { lift: 0.3, distance: 7.4 },
  locker: { lift: -1.25, distance: 4.5 },
};

export class TitleScene {
  private readonly svc: Services;
  private boulder: BoulderDef;
  private sim: ClimberSim;
  private active = false;
  private loaded = false;
  private framing: BackdropFraming = 'title';
  private upgrade: Promise<void> | null = null;
  private guide: GuideState | null = null;

  constructor(svc: Services) {
    this.svc = svc;
    // the lesson wall is available synchronously; a showcase problem replaces it once generated
    this.boulder = tutorialBoulder();
    this.sim = new ClimberSim(this.boulder, { invincible: true });
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

  /** Generate the showcase problem in the background (worker). */
  prepare(): Promise<void> {
    if (this.upgrade) return this.upgrade;
    const seed = hashString('chiral-hq:title-wall');
    this.upgrade = this.svc.gen
      .boulder({ seed, grade: 4, wallAngle: 20, colorIndex: 0, name: 'Steinbock Arête' })
      .then((b) => {
        this.boulder = b;
        this.sim = new ClimberSim(b, { invincible: true });
        this.loaded = false;
        if (this.active) {
          this.load();
          this.applyCamera(false);
        }
      })
      .catch((err: unknown) => console.warn('[app] title wall generation failed', err));
    return this.upgrade;
  }

  /** Show the backdrop (idempotent): wall, idle climber, Steini, title camera. */
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
    this.svc.renderer.setGuide(null);
    this.svc.renderer.setTitleFraming(null);
  }

  frame(dt: number): void {
    if (!this.active) return;
    this.sim.step(dt);
    this.svc.renderer.updateClimber(this.sim.getState(), dt);
  }

  private load(): void {
    const { renderer } = this.svc;
    renderer.loadBoulder(this.boulder);
    renderer.setRope(null, []);
    renderer.setHoldHighlights([]);
    renderer.setClimberVisible(true);
    renderer.setCameraFocusHint(null);
    this.sim.reset();
    renderer.updateClimber(this.sim.getState(), 0);
    const starts = this.boulder.holds.filter((h) => h.role === 'start');
    const sx = starts.length ? starts.reduce((a, h) => a + h.x, 0) / starts.length : 0;
    const half = this.boulder.width / 2 - 0.5;
    const gx = Math.max(-half, Math.min(half, sx + (sx > 0 ? -1.05 : 1.05)));
    const chest = this.sim.getState().chest;
    this.guide = { x: gx, depth: 1.5, pose: 'idle', lookAt: { x: chest.x, y: chest.y } };
    this.loaded = true;
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
}

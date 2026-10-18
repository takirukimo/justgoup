// Render quality policy. A fixed setting is applied as is. 'auto' starts from the device guess
// (GPU string, cores, memory, DPR), confirms it with a quick FPS probe over the first 2 s, then keeps
// watching while the player climbs: an average under 45 fps over 4 s steps the level down.

import type { QualityLevel, Settings } from '../core/types';
import { detectQuality } from '../render/quality';
import type { GameRenderer } from '../render/renderer';

const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];
const PROBE_SECONDS = 2;
const PROBE_MIN_FPS = 40;
const PLAY_WINDOW = 4;
const PLAY_MIN_FPS = 45;
const COOLDOWN = 5;

export class QualityManager {
  private mode: Settings['quality'] = 'auto';
  private level: QualityLevel;
  private probeT = 0;
  private probeFrames = 0;
  private probing = false;
  private winT = 0;
  private winFrames = 0;
  private cooldown = 0;
  /** Device ceiling for 'auto' (never auto-raise above it). */
  private readonly ceiling: QualityLevel;

  constructor(private readonly renderer: GameRenderer) {
    this.ceiling = QualityManager.guess(renderer);
    this.level = renderer.getQuality();
  }

  /** Device-based starting level: the renderer's GPU heuristic, tempered by very high DPR screens. */
  static guess(renderer: GameRenderer): QualityLevel {
    let q = detectQuality(renderer.gl);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    // 3× phones push 9× the pixels of 1×: keep them off the most expensive preset unless clearly strong
    if (q === 'high' && dpr >= 3 && cores < 8) q = 'medium';
    return q;
  }

  get current(): QualityLevel {
    return this.level;
  }

  get setting(): Settings['quality'] {
    return this.mode;
  }

  /** Apply the player's setting (called at boot and whenever settings change). */
  apply(setting: Settings['quality']): void {
    this.mode = setting;
    if (setting === 'auto') {
      this.set(this.ceiling);
      this.probing = true;
      this.probeT = 0;
      this.probeFrames = 0;
      this.cooldown = 0.6; // let shaders compile before judging
    } else {
      this.probing = false;
      this.set(setting);
    }
  }

  /** Feed every frame. `playing` = a climb is live (the 4 s watchdog only judges gameplay). */
  sample(dt: number, playing: boolean): void {
    if (this.mode !== 'auto' || dt <= 0 || dt > 0.5) return;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    if (this.probing) {
      this.probeT += dt;
      this.probeFrames++;
      if (this.probeT >= PROBE_SECONDS) {
        this.probing = false;
        if (this.probeFrames / this.probeT < PROBE_MIN_FPS) this.step(-1);
      }
      return;
    }
    if (!playing) {
      this.winT = 0;
      this.winFrames = 0;
      return;
    }
    this.winT += dt;
    this.winFrames++;
    if (this.winT >= PLAY_WINDOW) {
      const fps = this.winFrames / this.winT;
      this.winT = 0;
      this.winFrames = 0;
      if (fps < PLAY_MIN_FPS) this.step(-1);
    }
  }

  private step(dir: -1 | 1): void {
    const i = LEVELS.indexOf(this.level) + dir;
    if (i < 0 || i >= LEVELS.length) return;
    if (dir > 0 && i > LEVELS.indexOf(this.ceiling)) return;
    this.set(LEVELS[i]);
    this.cooldown = COOLDOWN;
  }

  private set(q: QualityLevel): void {
    this.level = q;
    if (this.renderer.getQuality() !== q) this.renderer.setQuality(q);
  }
}

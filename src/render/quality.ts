// Render quality presets + an automatic quality heuristic.
//
// The renderer applies a preset through GameRenderer.setQuality(). `detectQuality()` picks a
// sensible starting level from the device, and `QualityGovernor` watches frame times and
// steps the level down (or back up) when 'auto' quality is enabled.

import * as THREE from 'three';
import type { QualityLevel } from '../core/types';

export interface QualityPreset {
  level: QualityLevel;
  /** Device-pixel-ratio cap for the drawing buffer. */
  maxDpr: number;
  /** Post-processing (bloom + final grade). Off = plain render with tone mapping. */
  post: boolean;
  /** Bloom resolution scale relative to the drawing buffer. */
  bloomScale: number;
  /** MSAA samples for the post-processing scene target (WebGL2). */
  msaa: number;
  grain: boolean;
  chromatic: boolean;
  /** Key-light shadow map. 0 = no shadow map (contact shadows only). */
  shadowMapSize: number;
  /** PCF softness radius for the key-light shadow. */
  shadowRadius: number;
  /** Pixels per meter for the main wall texture (boulder) — rope walls use 75% of this. */
  wallPxPerMeter: number;
  /** Max texture anisotropy to request. */
  anisotropy: number;
  /** Environment detail: 0 = essentials, 1 = + props/ducts, 2 = + light shafts/banners. */
  envDetail: 0 | 1 | 2;
  /** Max particles in the fx pool. */
  particles: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    maxDpr: 1,
    post: false,
    bloomScale: 0,
    msaa: 0,
    grain: false,
    chromatic: false,
    shadowMapSize: 0,
    shadowRadius: 0,
    wallPxPerMeter: 220,
    anisotropy: 2,
    envDetail: 0,
    particles: 240,
  },
  medium: {
    level: 'medium',
    maxDpr: 1.5,
    post: true,
    bloomScale: 0.5,
    msaa: 2,
    grain: true,
    chromatic: false,
    shadowMapSize: 1024,
    shadowRadius: 3,
    wallPxPerMeter: 320,
    anisotropy: 4,
    envDetail: 1,
    particles: 480,
  },
  high: {
    level: 'high',
    maxDpr: 2,
    post: true,
    bloomScale: 1,
    msaa: 4,
    grain: true,
    chromatic: true,
    shadowMapSize: 2048,
    shadowRadius: 4,
    wallPxPerMeter: 420,
    anisotropy: 8,
    envDetail: 2,
    particles: 720,
  },
};

const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];

/**
 * Initial quality guess from the device: GPU renderer string, core count, memory, screen size.
 * Conservative on phones (medium unless clearly high-end), high on desktop GPUs.
 */
export function detectQuality(renderer?: THREE.WebGLRenderer): QualityLevel {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const cores = nav?.hardwareConcurrency ?? 4;
  const mem = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? 4;
  const ua = nav?.userAgent ?? '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

  let gpu = '';
  if (renderer) {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch {
      gpu = '';
    }
  }
  const g = gpu.toLowerCase();

  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return 'low';
  if (/mali-(4|t6|t7)|adreno \(tm\) (3|4|5[0-3])|powervr sgx|intel\(r\) hd graphics [2-5]/.test(g)) return 'low';
  if (cores <= 2 || mem <= 2) return 'low';

  if (mobile) {
    // Apple GPUs of the last few generations and recent Adreno/Mali/Xclipse handle 'high'.
    if (/apple gpu|apple m\d/.test(g) && cores >= 6) return 'high';
    if (/adreno \(tm\) (7[3-9]\d|8\d\d)|mali-g7[1-9]|mali-g[6-9]1\d|immortalis|xclipse/.test(g) && mem >= 6) return 'high';
    return 'medium';
  }
  if (/nvidia|geforce|radeon|rtx|gtx|apple m\d|arc\(tm\)|iris xe/.test(g)) return 'high';
  return cores >= 8 ? 'high' : 'medium';
}

/**
 * Watches frame times and suggests quality changes. Feed it every frame's dt; it returns a
 * new level when a change is warranted (with hysteresis so it never flip-flops).
 */
export class QualityGovernor {
  private acc = 0;
  private frames = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private cooldown = 3; // seconds before the first judgement (shader warm-up)
  /** Never auto-raise above this level (the device's detected ceiling). */
  constructor(private ceiling: QualityLevel = 'high') {}

  setCeiling(level: QualityLevel): void {
    this.ceiling = level;
  }

  /** Returns a new level to switch to, or null to stay. */
  sample(dt: number, current: QualityLevel): QualityLevel | null {
    if (dt <= 0 || dt > 0.5) return null; // tab switches, debugger pauses
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return null;
    }
    this.acc += dt;
    this.frames++;
    if (this.acc < 2) return null;
    const avgMs = (this.acc / this.frames) * 1000;
    this.acc = 0;
    this.frames = 0;

    const idx = LEVELS.indexOf(current);
    if (avgMs > 24) {
      this.slowWindows++;
      this.fastWindows = 0;
    } else if (avgMs < 14.5) {
      this.fastWindows++;
      this.slowWindows = 0;
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }
    if (this.slowWindows >= 2 && idx > 0) {
      this.slowWindows = 0;
      this.cooldown = 4;
      return LEVELS[idx - 1];
    }
    if (this.fastWindows >= 8 && idx < LEVELS.indexOf(this.ceiling)) {
      this.fastWindows = 0;
      this.cooldown = 6;
      return LEVELS[idx + 1];
    }
    return null;
  }
}

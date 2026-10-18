// GPU-cheap particle effects in a single pooled THREE.Points draw:
//   chalkPuff — soft billboards in the player's chalk colour, drift outward + fade
//   dust      — crash-pad landing burst (rolling grey cloud at pad level)
//   confetti  — send celebration: chalk bursts + small tumbling CHIRAL pink / bone flecks
// CPU integrates a ring buffer of particles; attributes are updated in place (no allocation).

import * as THREE from 'three';
import { PALETTE } from '../config/brand';
import type { Vec2 } from '../core/types';
import { GAME } from '../config/tuning';
import { Rng } from '../core/rng';
import type { WallFrame } from './wall-frame';

const VERT = /* glsl */ `
uniform float uScale;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
attribute float aKind;
attribute float aSpin;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSpin;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.05, -mv.z), 0.0, 512.0);
  vColor = aColor;
  vAlpha = aAlpha;
  vKind = aKind;
  vSpin = aSpin;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSpin;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a;
  if (vKind < 0.5) {
    // soft gaussian puff, slightly denser off-centre so overlapping puffs read as a cloud
    vec2 d = c * 2.0;
    float r2 = dot(d, d);
    a = exp(-r2 * 3.2) * (1.0 - smoothstep(0.7, 1.0, r2));
    a *= 0.85 + 0.15 * sin(d.x * 5.0 + vSpin * 3.0) * sin(d.y * 4.0 - vSpin * 2.0);
  } else {
    // tumbling fleck: a thin rotating rectangle whose width flickers with the spin
    float s = sin(vSpin), co = cos(vSpin);
    vec2 q = vec2(co * c.x - s * c.y, s * c.x + co * c.y);
    float w = 0.12 + 0.3 * abs(sin(vSpin * 1.7));
    a = step(abs(q.x), w) * step(abs(q.y), 0.42);
  }
  a *= vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}`;

export class FxSystem {
  readonly points: THREE.Points;
  private n: number;
  private next = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private size: Float32Array;
  private kind: Float32Array;
  private spin: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private alpha0: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private spinV: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private chalk = new THREE.Color(PALETTE.chalk);
  private rng = new Rng(0xf00d);
  private alive = 0;
  private tmp = new THREE.Vector3();
  private up = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private dynAttrs: THREE.BufferAttribute[] = [];

  constructor(
    private frame: WallFrame,
    max = 720,
  ) {
    this.n = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.kind = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.spinV = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    const dyn = (a: Float32Array, size: number) => new THREE.BufferAttribute(a, size).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('aColor', dyn(this.col, 3));
    this.geo.setAttribute('aAlpha', dyn(this.alpha, 1));
    this.geo.setAttribute('aSize', dyn(this.size, 1));
    this.geo.setAttribute('aKind', dyn(this.kind, 1));
    this.geo.setAttribute('aSpin', dyn(this.spin, 1));
    this.geo.setDrawRange(0, max);
    for (const name of ['position', 'aAlpha', 'aSize', 'aSpin']) this.dynAttrs.push(this.geo.getAttribute(name) as THREE.BufferAttribute);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
    this.points.name = 'fx';
  }

  setChalkColor(hex: string): void {
    this.chalk.set(hex);
  }

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, a0: number,
    drag: number, grav: number, color: THREE.Color, kind: number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = s0;
    this.size1[i] = s1;
    this.alpha0[i] = a0;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.kind[i] = kind;
    this.spin[i] = this.rng.range(0, 6.28);
    this.spinV[i] = kind > 0.5 ? this.rng.range(-14, 14) : this.rng.range(-0.6, 0.6);
    this.size[i] = s0;
    this.alpha[i] = 0;
    (this.geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aKind') as THREE.BufferAttribute).needsUpdate = true;
    this.alive = Math.min(this.n, this.alive + 1);
  }

  /** Chalk puff at a wall-local point (hand on a hold). */
  chalkPuff(p: Vec2, intensity = 1, depth = 0.05): void {
    const k = Math.max(0.2, Math.min(2, intensity));
    const count = Math.round(14 * k);
    const f = this.frame;
    const base = f.toWorldXYZ(p.x, p.y, depth, this.tmp);
    const bx = base.x, by = base.y, bz = base.z;
    // the wall's frame where the puff is (a puff under a roof blows down, off the panel)
    const up = f.upAt(p.y, this.up);
    const nrm = f.normalAt(p.y, this.nrm);
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(0.15, 0.65) * k;
      const out = this.rng.range(0.08, 0.38) * k;
      // velocity: in the wall plane (right/up) + out of the wall
      const vx = f.right.x * Math.cos(a) * sp + up.x * Math.sin(a) * sp + nrm.x * out;
      const vy = f.right.y * Math.cos(a) * sp + up.y * Math.sin(a) * sp + nrm.y * out + 0.08;
      const vz = f.right.z * Math.cos(a) * sp + up.z * Math.sin(a) * sp + nrm.z * out;
      this.tmpC.copy(this.chalk).multiplyScalar(this.rng.range(0.9, 1.08));
      this.spawn(
        bx + this.rng.range(-0.03, 0.03), by + this.rng.range(-0.03, 0.03), bz + this.rng.range(-0.01, 0.02),
        vx, vy, vz,
        this.rng.range(0.8, 1.6), this.rng.range(0.025, 0.05), this.rng.range(0.12, 0.22) * Math.sqrt(k),
        this.rng.range(0.35, 0.6), 2.4, -0.12, this.tmpC, 0,
      );
    }
  }

  /**
   * A hand dipping into the chalk bag (world position of the bag mouth / hand): a small dense puff
   * rising out of the bag, a little cloud that lingers, and a few motes sifting down.
   */
  chalkDipAt(w: THREE.Vector3, intensity = 0.7): void {
    const k = Math.max(0.2, Math.min(1.6, intensity));
    const count = Math.round(16 * k);
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(0.05, 0.28) * k;
      this.tmpC.copy(this.chalk).multiplyScalar(this.rng.range(0.92, 1.06));
      this.spawn(
        w.x + this.rng.range(-0.02, 0.02), w.y + this.rng.range(0, 0.03), w.z + this.rng.range(-0.02, 0.02),
        Math.cos(a) * sp, this.rng.range(0.12, 0.45) * k, Math.sin(a) * sp,
        this.rng.range(0.9, 1.9), this.rng.range(0.02, 0.04), this.rng.range(0.09, 0.17) * Math.sqrt(k),
        this.rng.range(0.4, 0.62), 3.2, -0.05, this.tmpC, 0,
      );
    }
    for (let i = 0; i < Math.round(6 * k); i++) {
      this.tmpC.copy(this.chalk);
      this.spawn(
        w.x + this.rng.range(-0.04, 0.04), w.y, w.z + this.rng.range(-0.04, 0.04),
        this.rng.range(-0.08, 0.08), this.rng.range(-0.05, 0.12), this.rng.range(-0.08, 0.08),
        this.rng.range(1.2, 2.0), 0.008, 0.012, 0.8, 1.4, -0.9, this.tmpC, 1,
      );
    }
  }

  /**
   * The slap of a hand catching a hold after a dyno: a sharp ring of chalk thrown out along the wall
   * around the hand, a puff off the wall and a few chalk flecks dropping.
   */
  catchBurst(p: Vec2, intensity = 1): void {
    const k = Math.max(0.3, Math.min(2, intensity));
    const f = this.frame;
    const base = f.toWorldXYZ(p.x, p.y, 0.05, this.tmp);
    const bx = base.x, by = base.y, bz = base.z;
    const up = f.upAt(p.y, this.up);
    const nrm = f.normalAt(p.y, this.nrm);
    const ring = Math.round(22 * k);
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + this.rng.range(-0.1, 0.1);
      const sp = this.rng.range(0.9, 1.6) * k;
      const out = this.rng.range(0.1, 0.35);
      this.tmpC.copy(this.chalk).multiplyScalar(this.rng.range(0.94, 1.06));
      this.spawn(
        bx, by, bz,
        f.right.x * Math.cos(a) * sp + up.x * Math.sin(a) * sp + nrm.x * out,
        f.right.y * Math.cos(a) * sp + up.y * Math.sin(a) * sp + nrm.y * out,
        f.right.z * Math.cos(a) * sp + up.z * Math.sin(a) * sp + nrm.z * out,
        this.rng.range(0.5, 0.95), this.rng.range(0.02, 0.035), this.rng.range(0.1, 0.18),
        this.rng.range(0.45, 0.7), 6.5, -0.1, this.tmpC, 0,
      );
    }
    this.chalkPuff(p, 0.7 * k, 0.07);
    for (let i = 0; i < Math.round(8 * k); i++) {
      this.tmpC.copy(this.chalk);
      this.spawn(
        bx + this.rng.range(-0.04, 0.04), by, bz,
        this.rng.range(-0.3, 0.3) + nrm.x * 0.3, this.rng.range(0, 0.4), this.rng.range(-0.3, 0.3) + nrm.z * 0.4,
        this.rng.range(0.9, 1.6), 0.01, 0.014, 0.9, 1.2, -3.2, this.tmpC, 1,
      );
    }
  }

  /**
   * A missed throw: the fingers skid off the hold — a streak of chalk dust smeared down the wall
   * under it and a pale cloud falling away with the climber.
   */
  missScuff(p: Vec2, intensity = 1): void {
    const k = Math.max(0.3, Math.min(2, intensity));
    const f = this.frame;
    const up = f.upAt(p.y, this.up);
    const nrm = f.normalAt(p.y, this.nrm);
    const dustC = this.tmpC2.set('#c9c4ba');
    const streak = Math.round(20 * k);
    for (let i = 0; i < streak; i++) {
      // a downward streak hugging the wall under the hold
      const t = this.rng.next();
      const base = f.toWorldXYZ(p.x + this.rng.range(-0.05, 0.05), p.y - t * 0.22, 0.03 + this.rng.range(0, 0.03), this.tmp);
      this.tmpC.copy(i % 3 ? this.chalk : dustC).multiplyScalar(this.rng.range(0.85, 1.02));
      this.spawn(
        base.x, base.y, base.z,
        -up.x * this.rng.range(0.2, 0.7) + nrm.x * 0.12, -up.y * this.rng.range(0.2, 0.7) + nrm.y * 0.12 - 0.1, -up.z * this.rng.range(0.2, 0.7) + nrm.z * 0.12,
        this.rng.range(0.7, 1.4), this.rng.range(0.025, 0.045), this.rng.range(0.1, 0.2),
        this.rng.range(0.32, 0.5), 2.6, -0.6, this.tmpC, 0,
      );
    }
    for (let i = 0; i < Math.round(10 * k); i++) {
      const base = f.toWorldXYZ(p.x, p.y, 0.05, this.tmp);
      this.tmpC.copy(this.chalk);
      this.spawn(
        base.x + this.rng.range(-0.05, 0.05), base.y, base.z,
        this.rng.range(-0.35, 0.35) + nrm.x * 0.5, this.rng.range(-0.2, 0.3), this.rng.range(-0.35, 0.35) + nrm.z * 0.5,
        this.rng.range(1.0, 1.8), 0.009, 0.013, 0.9, 1.0, -4, this.tmpC, 1,
      );
    }
  }

  /** Crash-pad landing burst below a wall-local point. */
  dust(p: Vec2, intensity = 1): void {
    const k = Math.max(0.2, Math.min(2, intensity));
    const w = this.frame.toWorldXYZ(p.x, Math.max(p.y, 0.3), 0.55, this.tmp);
    const bx = w.x, bz = w.z;
    const by = GAME.padHeight + 0.04;
    const count = Math.round(30 * k);
    const dustC = new THREE.Color('#9b968d');
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(0.5, 1.9) * k;
      this.tmpC.copy(i % 3 === 0 ? this.chalk : dustC).multiplyScalar(this.rng.range(0.75, 1));
      this.spawn(
        bx + this.rng.range(-0.15, 0.15), by + this.rng.range(0, 0.06), bz + this.rng.range(-0.15, 0.15),
        Math.cos(a) * sp, this.rng.range(0.15, 0.7) * k, Math.sin(a) * sp,
        this.rng.range(1.1, 2.2), this.rng.range(0.06, 0.12), this.rng.range(0.3, 0.55) * Math.sqrt(k),
        this.rng.range(0.16, 0.32), 2.8, -0.35, this.tmpC, 0,
      );
    }
  }

  /** Send celebration at a wall-local point (the top hold). */
  confetti(p: Vec2): void {
    const f = this.frame;
    const w = f.toWorldXYZ(p.x, p.y, 0.12, this.tmp);
    const bx = w.x, by = w.y, bz = w.z;
    const nrm = f.normalAt(p.y, this.nrm);
    const signal = new THREE.Color(PALETTE.signal);
    const bone = new THREE.Color(PALETTE.bone);
    for (let i = 0; i < 46; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const sp = this.rng.range(0.6, 2.2);
      this.tmpC.copy(this.chalk).multiplyScalar(this.rng.range(0.92, 1.05));
      this.spawn(
        bx, by, bz,
        f.right.x * Math.cos(a) * sp + nrm.x * 0.8, Math.abs(Math.sin(a)) * sp * 0.8 + 0.4, f.right.z * Math.cos(a) * sp + nrm.z * this.rng.range(0.4, 1.6),
        this.rng.range(1.2, 2.2), this.rng.range(0.04, 0.07), this.rng.range(0.18, 0.34),
        this.rng.range(0.35, 0.55), 1.9, -0.2, this.tmpC, 0,
      );
    }
    for (let i = 0; i < 40; i++) {
      const a = this.rng.range(-0.3, Math.PI + 0.3);
      const sp = this.rng.range(1.4, 3.4);
      this.spawn(
        bx + this.rng.range(-0.05, 0.05), by, bz,
        f.right.x * Math.cos(a) * sp, Math.sin(a) * sp + 1.2, f.right.z * Math.cos(a) * sp + nrm.z * this.rng.range(0.6, 2.2),
        this.rng.range(1.8, 3.0), this.rng.range(0.022, 0.034), this.rng.range(0.022, 0.034),
        1, 1.1, -2.6, i % 3 === 0 ? bone : signal, 1,
      );
    }
  }

  /** Integrate + upload. `scalePx` = device px per meter at distance 1 (viewportH / (2 tan(fov/2))). */
  update(dt: number, scalePx: number): void {
    this.mat.uniforms.uScale.value = scalePx;
    if (this.alive === 0) return;
    const d = Math.min(dt, 0.05);
    let any = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      any++;
      this.life[i] -= d;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const dr = Math.exp(-this.drag[i] * d);
      this.vel[i * 3] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr + this.grav[i] * d;
      this.vel[i * 3 + 2] *= dr;
      this.pos[i * 3] += this.vel[i * 3] * d;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * d;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * d;
      // flecks settle on the pads
      if (this.kind[i] > 0.5 && this.pos[i * 3 + 1] < GAME.padHeight + 0.01) {
        this.pos[i * 3 + 1] = GAME.padHeight + 0.01;
        this.vel[i * 3] *= 0.5;
        this.vel[i * 3 + 1] = 0;
        this.vel[i * 3 + 2] *= 0.5;
        this.spinV[i] *= 0.8;
      }
      this.spin[i] += this.spinV[i] * d;
      const ease = 1 - (1 - t) * (1 - t);
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * ease;
      const fadeIn = Math.min(1, t * 10);
      const fadeOut = this.kind[i] > 0.5 ? 1 - Math.max(0, (t - 0.75) / 0.25) : (1 - t) * (1 - t);
      this.alpha[i] = this.alpha0[i] * fadeIn * fadeOut;
    }
    this.alive = any;
    for (let k = 0; k < this.dynAttrs.length; k++) this.dynAttrs[k].needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

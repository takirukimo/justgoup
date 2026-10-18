// Camera rig: one PerspectiveCamera driven by per-mode target poses and critically damped
// springs (smooth, overshoot-free transitions between modes), plus layered shake.
//
//  title     slow cinematic orbit, subject low in frame (title UI sits on top)
//  intro     scripted fly-in from the gym entrance (playIntro() → Promise) handing over to title
//  preview   pulled back to frame the whole problem (portrait fit with margins)
//  follow    frames the climber: CoM + lookahead toward the dragged limb, slightly below looking
//            up, ~12° yaw for depth, climber ≈ 60% of the screen height
//  editor    straight-on, narrow FOV, setEditorView(center, metersVisible)
//  celebrate swing around the climber
//  fall      dramatic lagging follow

import * as THREE from 'three';
import type { CameraMode } from '../core/contracts';
import type { BoulderDef, ClimberState, Vec2 } from '../core/types';
import { clamp, DEG, smoothstep } from '../core/math';
import type { WallFrame } from './wall-frame';

export interface CameraContext {
  frame: WallFrame;
  boulder: BoulderDef | null;
  state: ClimberState | null;
  ceiling: number;
}

interface ModeTuning {
  pos: number; // smooth time (s)
  look: number;
  fov: number;
}

const TUNING: Record<CameraMode, ModeTuning> = {
  title: { pos: 1.4, look: 1.1, fov: 1.2 },
  intro: { pos: 0.05, look: 0.05, fov: 0.3 },
  preview: { pos: 0.75, look: 0.6, fov: 0.7 },
  follow: { pos: 0.42, look: 0.26, fov: 0.6 },
  editor: { pos: 0.16, look: 0.12, fov: 0.25 },
  celebrate: { pos: 0.8, look: 0.4, fov: 0.8 },
  fall: { pos: 0.55, look: 0.22, fov: 0.5 },
};

/** Critically damped spring toward a target (Unity-style SmoothDamp), per scalar. */
function smoothDamp(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number): number {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

class SpringVec3 {
  readonly value = new THREE.Vector3();
  private vx = { v: 0 };
  private vy = { v: 0 };
  private vz = { v: 0 };
  step(target: THREE.Vector3, st: number, dt: number): void {
    this.value.x = smoothDamp(this.value.x, target.x, this.vx, st, dt);
    this.value.y = smoothDamp(this.value.y, target.y, this.vy, st, dt);
    this.value.z = smoothDamp(this.value.z, target.z, this.vz, st, dt);
  }
  snap(v: THREE.Vector3): void {
    this.value.copy(v);
    this.vx.v = this.vy.v = this.vz.v = 0;
  }
}

class SpringNum {
  value: number;
  private vel = { v: 0 };
  constructor(v: number) {
    this.value = v;
  }
  step(target: number, st: number, dt: number): void {
    this.value = smoothDamp(this.value, target, this.vel, st, dt);
  }
  snap(v: number): void {
    this.value = v;
    this.vel.v = 0;
  }
}

/** Smooth pseudo-random signal in [-1, 1]. */
function noise1(t: number, seed: number): number {
  return (Math.sin(t * 1.0 + seed) * 0.5 + Math.sin(t * 2.31 + seed * 1.7) * 0.3 + Math.sin(t * 4.77 + seed * 2.3) * 0.2);
}

export class CameraRig {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'title';
  private pos = new SpringVec3();
  private look = new SpringVec3();
  private up = new SpringVec3();
  private fov = new SpringNum(42);
  private roll = new SpringNum(0);
  private span = new SpringNum(3.4); // follow: visible wall height (m)

  private tPos = new THREE.Vector3();
  private tLook = new THREE.Vector3();
  private tUp = new THREE.Vector3(0, 1, 0);
  private tFov = 42;
  private tRoll = 0;

  private modeTime = 0;
  private time = 0;
  private transition = 0;
  private focusHint: Vec2 | null = null;
  private focusOverride: Vec2 | null = null;
  private editorCenter: Vec2 = { x: 0, y: 2.25 };
  private editorMeters = 5;
  private trauma = 0;
  private continuousShake = 0;
  private celebrateSign = 1;
  private intro: { t: number; dur: number; resolve: (() => void) | null; from: THREE.Vector3[]; look0: THREE.Vector3 } | null = null;
  private initialized = false;
  /** Optional (app): fractions of the viewport height covered by UI at the top / bottom; 'preview' fits the route between them. */
  viewInsets: { top: number; bottom: number } = { top: 0, bottom: 0 };
  /** Optional (app menus): title-mode framing — look-point lift above the subject and orbit distance (m). */
  titleFraming: { lift: number; distance: number } | null = null;
  /** Dev/QA override: fixed world pose. */
  debugView: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;

  // scratch
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private shakeOff = new THREE.Vector3();
  private readonly WORLD_UP = new THREE.Vector3(0, 1, 0);
  private bbox = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private introPts: THREE.Vector3[] = [];

  constructor(aspect = 390 / 844) {
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.05, 120);
    this.up.snap(this.WORLD_UP);
  }

  /** 0..1 progress of the intro fly-in (1 when finished or not running). */
  get introProgress(): number {
    return this.intro ? clamp(this.intro.t / this.intro.dur, 0, 1) : 1;
  }

  setMode(mode: CameraMode, opts?: { instant?: boolean; focus?: Vec2 }): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    this.focusOverride = opts?.focus ?? null;
    if (changed) {
      this.modeTime = 0;
      this.transition = mode === 'editor' ? 0.35 : 1.25;
      if (mode === 'celebrate') this.celebrateSign = this.camera.position.x >= 0 ? 1 : -1;
    }
    if (mode === 'intro' && !this.intro) this.startIntro(7.5);
    if (opts?.instant) this.pendingSnap = true;
  }

  private pendingSnap = false;

  /** Starts the scripted fly-in; resolves when it lands. */
  playIntro(duration = 7.5): Promise<void> {
    this.mode = 'intro';
    this.modeTime = 0;
    return new Promise((resolve) => {
      this.startIntro(duration, resolve);
    });
  }

  private startIntro(dur: number, resolve: (() => void) | null = null): void {
    this.intro?.resolve?.();
    this.intro = {
      t: 0,
      dur,
      resolve,
      from: [new THREE.Vector3(-3.6, 2.3, 22), new THREE.Vector3(-2.8, 2.9, 15), new THREE.Vector3(1.8, 2.5, 9.5)],
      look0: new THREE.Vector3(0, 3.2, 0),
    };
    this.pendingSnap = true;
  }

  setFocusHint(p: Vec2 | null): void {
    this.focusHint = p ? { x: p.x, y: p.y } : null;
  }

  setEditorView(center: Vec2, metersVisible: number): void {
    this.editorCenter = { x: center.x, y: center.y };
    this.editorMeters = clamp(metersVisible, 0.8, 30);
  }

  addShake(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // ───────────────────────────── targets ─────────────────────────────

  /**
   * Camera direction (unit, from subject toward camera): horizontal +Z blended toward the wall
   * normal, then yawed about world up and pitched (negative = camera lower, looking up).
   */
  private viewDir(frame: WallFrame, blend: number, yawDeg: number, pitchDeg: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 1).lerp(frame.normal, blend).normalize();
    this.q.setFromAxisAngle(this.WORLD_UP, yawDeg * DEG);
    out.applyQuaternion(this.q);
    this.right.crossVectors(this.WORLD_UP, out).normalize();
    this.q.setFromAxisAngle(this.right, -pitchDeg * DEG);
    out.applyQuaternion(this.q);
    return out.normalize();
  }

  private distanceFor(span: number, fovDeg: number): number {
    return span / 2 / Math.tan((fovDeg * DEG) / 2);
  }

  private climberBox(s: ClimberState): void {
    const b = this.bbox;
    b.minX = Math.min(s.pelvis.x, s.chest.x);
    b.maxX = Math.max(s.pelvis.x, s.chest.x);
    b.minY = Math.min(s.pelvis.y, s.chest.y);
    b.maxY = Math.max(s.pelvis.y, s.chest.y) + 0.32; // head
    for (const id of ['LH', 'RH', 'LF', 'RF'] as const) {
      const p = s.limbs[id].pos;
      if (p.x < b.minX) b.minX = p.x;
      if (p.x > b.maxX) b.maxX = p.x;
      if (p.y < b.minY) b.minY = p.y;
      if (p.y > b.maxY) b.maxY = p.y;
    }
  }

  private routeBox(boulder: BoulderDef): void {
    const b = this.bbox;
    b.minX = Infinity;
    b.maxX = -Infinity;
    b.minY = 0.35;
    b.maxY = -Infinity;
    for (const h of boulder.holds) {
      if (h.role === 'deco') continue;
      b.minX = Math.min(b.minX, h.x - h.size);
      b.maxX = Math.max(b.maxX, h.x + h.size);
      b.maxY = Math.max(b.maxY, h.y + h.size);
    }
    if (!isFinite(b.minX)) {
      b.minX = -boulder.width / 2;
      b.maxX = boulder.width / 2;
      b.maxY = boulder.height;
    }
    b.maxY = Math.min(boulder.height + 0.1, b.maxY + 0.25);
  }

  private computeTarget(ctx: CameraContext): void {
    const { frame, boulder, state } = ctx;
    const aspect = this.camera.aspect || 0.46;
    const t = this.time;
    switch (this.mode) {
      case 'follow': {
        let cx = 0;
        let cy = 1.6;
        let depth = 0.3;
        let bw = 0.8;
        let bh = 1.9;
        if (state) {
          this.climberBox(state);
          const b = this.bbox;
          cx = (b.minX + b.maxX) / 2 * 0.6 + state.com.x * 0.4;
          cy = (b.minY + b.maxY) / 2 * 0.55 + state.com.y * 0.45 + 0.12;
          bw = b.maxX - b.minX;
          bh = b.maxY - b.minY;
          depth = state.pelvisDepth * 0.55;
        }
        const hint = this.focusHint ?? this.focusOverride;
        if (hint) {
          cx += clamp(hint.x - cx, -0.9, 0.9) * 0.32;
          cy += clamp(hint.y - cy, -0.9, 1.1) * 0.32;
        }
        const span = clamp(Math.max(bh / 0.6, (bw + 0.5) / aspect, 3.0), 3.0, 5.2);
        this.span.step(span, 0.9, this.lastDt);
        // never waste the bottom of the frame on crash pads: keep the frame's lower edge near the kicker
        cy = Math.max(cy, this.span.value * 0.5 - 0.15);
        this.tFov = 46;
        const dist = this.distanceFor(this.span.value, this.tFov);
        const yaw = 12 + clamp(state ? state.velocity.x * 2 : 0, -4, 4);
        this.viewDir(frame, 0.55, yaw, -7, this.dir);
        frame.toWorldXYZ(cx, cy, depth, this.tLook);
        this.tPos.copy(this.tLook).addScaledVector(this.dir, dist);
        this.tUp.copy(this.WORLD_UP);
        this.tRoll = 0;
        break;
      }
      case 'fall': {
        const s = state;
        const cx = s ? s.com.x : 0;
        const cy = s ? Math.max(0.9, s.com.y) : 1.2;
        const depth = s ? s.pelvisDepth * 0.6 : 0.4;
        this.tFov = 50;
        const dist = this.distanceFor(4.6, this.tFov);
        this.viewDir(frame, 0.45, 16, -12, this.dir);
        frame.toWorldXYZ(cx, cy, depth, this.tLook);
        this.tPos.copy(this.tLook).addScaledVector(this.dir, dist);
        this.tUp.copy(this.WORLD_UP);
        this.tRoll = s && s.phase === 'falling' ? 2.5 * DEG : 0;
        break;
      }
      case 'preview': {
        if (boulder) this.routeBox(boulder);
        else {
          this.bbox.minX = -2.3;
          this.bbox.maxX = 2.3;
          this.bbox.minY = 0.3;
          this.bbox.maxY = 4.5;
        }
        const b = this.bbox;
        const m = 0.45;
        const w = b.maxX - b.minX + m * 2;
        const h = b.maxY - b.minY + m * 2;
        this.tFov = boulder?.mode === 'rope' ? 48 : 42;
        // fit the route into the band the UI leaves free, and centre it in that band
        const ins = this.viewInsets;
        const vis = clamp(1 - ins.top - ins.bottom, 0.4, 1);
        const span = Math.max(h, w / aspect) / vis;
        const dist = this.distanceFor(span, this.tFov);
        this.viewDir(frame, 0.7, 4, -3, this.dir);
        frame.toWorldXYZ((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2 + ((ins.top - ins.bottom) / 2) * span, 0, this.tLook);
        this.tPos.copy(this.tLook).addScaledVector(this.dir, dist);
        this.tUp.copy(this.WORLD_UP);
        this.tRoll = 0;
        break;
      }
      case 'editor': {
        this.tFov = 24;
        const dist = this.distanceFor(this.editorMeters, this.tFov);
        frame.toWorldXYZ(this.editorCenter.x, this.editorCenter.y, 0, this.tLook);
        this.tPos.copy(this.tLook).addScaledVector(frame.normal, dist);
        this.tUp.copy(frame.up);
        this.tRoll = 0;
        break;
      }
      case 'celebrate': {
        const s = state;
        const cx = s ? s.chest.x : 0;
        const cy = s ? s.chest.y : 3;
        this.tFov = 44;
        const k = smoothstep(0, 3.2, this.modeTime);
        const yaw = this.celebrateSign * (14 + 30 * k);
        this.viewDir(frame, 0.5, yaw, -10 + 6 * k, this.dir);
        frame.toWorldXYZ(cx, cy - 0.1, s ? s.pelvisDepth : 0.3, this.tLook);
        this.tPos.copy(this.tLook).addScaledVector(this.dir, 3.3 - 0.4 * k);
        this.tUp.copy(this.WORLD_UP);
        this.tRoll = 0;
        break;
      }
      case 'title':
      case 'intro': {
        this.titleTarget(ctx, t);
        break;
      }
    }

    // keep the camera inside the hall and above the pads (except straight-on editor views)
    if (this.mode !== 'editor') {
      this.tPos.y = clamp(this.tPos.y, 0.75, ctx.ceiling - 0.6);
      this.tPos.x = clamp(this.tPos.x, -11.5, 11.5);
      this.tPos.z = Math.min(this.tPos.z, 27);
    }
  }

  private titleTarget(ctx: CameraContext, t: number): void {
    const { frame, state, boulder } = ctx;
    let sx = 0;
    let sy = 1.5;
    let depth = 0.4;
    if (state) {
      sx = state.com.x;
      sy = state.com.y;
      depth = state.pelvisDepth;
    } else if (boulder) {
      let n = 0;
      let ax = 0;
      for (const h of boulder.holds) {
        if (h.role !== 'start') continue;
        ax += h.x;
        n++;
      }
      if (n) {
        sx = ax / n;
        sy = 1.4;
      }
    }
    this.tFov = 44;
    const yaw = 12 + 15 * Math.sin(t * 0.085);
    const pitch = -2 + 3 * Math.sin(t * 0.06 + 1);
    this.viewDir(frame, 0.3, yaw, pitch, this.dir);
    // subject sits in the lower part of the frame → look above it
    frame.toWorldXYZ(sx, sy, depth, this.v3);
    const lift = this.titleFraming ? this.titleFraming.lift : 1.0;
    const dist = this.titleFraming ? this.titleFraming.distance : 8.2;
    this.tLook.copy(this.v3).addScaledVector(this.WORLD_UP, lift);
    this.tPos.copy(this.v3).addScaledVector(this.dir, dist + 0.6 * (dist / 8.2) * Math.sin(t * 0.05));
    this.tPos.y += 0.35;
    this.tUp.copy(this.WORLD_UP);
    this.tRoll = 0;
  }

  // ───────────────────────────── update ─────────────────────────────

  private lastDt = 1 / 60;

  update(dt: number, ctx: CameraContext): void {
    const d = Math.min(dt, 0.1);
    this.lastDt = d;
    this.time += d;
    this.modeTime += d;
    this.transition = Math.max(0, this.transition - d);
    this.computeTarget(ctx);

    if (!this.initialized || this.pendingSnap) {
      this.pos.snap(this.tPos);
      this.look.snap(this.tLook);
      this.up.snap(this.tUp);
      this.fov.snap(this.tFov);
      this.roll.snap(this.tRoll);
      this.initialized = true;
      this.pendingSnap = false;
    }

    if (this.intro) {
      const it = this.intro;
      it.t += d;
      const k = clamp(it.t / it.dur, 0, 1);
      const e = k * k * k * (k * (k * 6 - 15) + 10); // smootherstep
      // Catmull-Rom through the scripted points into the live title pose
      const pts = this.introPts;
      pts[0] = it.from[0];
      pts[1] = it.from[0];
      pts[2] = it.from[1];
      pts[3] = it.from[2];
      pts[4] = this.tPos;
      pts[5] = this.tPos;
      const seg = e * 3;
      const i = Math.min(2, Math.floor(seg));
      const f = seg - i;
      catmull(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], f, this.v1);
      this.v2.copy(it.look0).lerp(this.tLook, smoothstep(0.15, 1, e));
      this.pos.snap(this.v1);
      this.look.snap(this.v2);
      this.fov.step(this.tFov + 14 * (1 - e), 0.3, d);
      this.up.snap(this.tUp);
      if (k >= 1) {
        const r = it.resolve;
        this.intro = null;
        if (this.mode === 'intro') this.mode = 'title';
        r?.();
      }
    } else {
      const tune = TUNING[this.mode];
      const tr = this.transition > 0 ? 1 + smoothstep(0, 1.25, this.transition) * 0.9 : 1;
      this.pos.step(this.tPos, tune.pos * tr, d);
      this.look.step(this.tLook, tune.look * tr, d);
      this.up.step(this.tUp, 0.4, d);
      this.fov.step(this.tFov, tune.fov * tr, d);
      this.roll.step(this.tRoll, 0.6, d);
    }

    // shake: transient trauma² + continuous tremor from the climber
    this.trauma = Math.max(0, this.trauma - d * 1.3);
    const shake = this.trauma * this.trauma;
    const cont = this.continuousShake;
    const st = this.time * 22;
    const amp = shake * 0.07 + cont * 0.012;
    this.shakeOff.set(noise1(st, 1.3) * amp, noise1(st, 7.1) * amp, noise1(st, 3.7) * amp * 0.5);

    const cam = this.camera;
    if (this.debugView) {
      cam.fov = this.debugView.fov;
      cam.updateProjectionMatrix();
      cam.position.copy(this.debugView.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.debugView.look);
      cam.updateMatrixWorld();
      return;
    }
    if (Math.abs(cam.fov - this.fov.value) > 1e-3) {
      cam.fov = this.fov.value;
      cam.updateProjectionMatrix();
    }
    cam.position.copy(this.pos.value).add(this.shakeOff);
    cam.up.copy(this.up.value).normalize();
    this.v1.copy(this.look.value).addScaledVector(this.shakeOff, 0.6);
    cam.lookAt(this.v1);
    const rollNoise = noise1(st * 0.8, 9.2) * shake * 1.6 * DEG;
    if (this.roll.value !== 0 || rollNoise !== 0) cam.rotateZ(this.roll.value + rollNoise);
    cam.updateMatrixWorld();
  }

  /** Continuous shake from ClimberState.shake (0..1). */
  setContinuousShake(v: number): void {
    this.continuousShake = clamp(v, 0, 1);
  }
}

type PerspectiveCamera = THREE.PerspectiveCamera;

function catmull(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return out.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

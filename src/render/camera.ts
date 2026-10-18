// Camera rig: one PerspectiveCamera driven by per-mode target poses and critically damped
// springs, plus layered shake.
//
// Every change of shot blends: a mode change (or a title ↔ locker framing change) eases the
// target from the pose the camera had to the new mode's live target with a smootherstep over
// BLEND_S[mode] seconds, and the springs (velocity kept across the change) smooth what is left,
// so nothing snaps or whips. Only an explicit `instant` request cuts (the app does that under its
// transition veil); a cut to 'preview' / 'title' then settles in with a slow push.
//
//  title     slow cinematic drift composing the climber on the wall AND Steini on the mats (from
//            the live climber state + guide position) in the band the title UI leaves free (logo
//            ≈ top 30%, buttons ≈ bottom 32%), seen from the climber's side so Steini is in 3/4
//            looking up at him; with a negative titleFraming.lift (locker close-up) it keeps the
//            classic lifted orbit
//  intro     scripted fly-in from the gym entrance (playIntro() → Promise): a slow establishing
//            glide while the intro card is read, then the flight to the wall, landing on title
//  preview   pulled back to frame the whole problem (portrait fit with margins)
//  follow    decision framing: both feet + the next ~1.1–1.5 m of route above the higher hand
//            (look-ahead toward the next route hold / the dragged limb's target), fitted exactly
//            between the HUD bands, climber ≈ 45–55% of the screen height, slightly below looking
//            up (mild heroic angle), ~12° yaw for depth. While a limb is dragged the framing only
//            grows (never breathes in and out under the finger). Falls / rope catches frame the
//            whole body inside the HUD-safe band.
//  editor    straight-on, narrow FOV, setEditorView(center, metersVisible)
//  celebrate swing around the climber
//  fall      dramatic lagging follow (body kept inside the HUD-safe band)
//
// Framing is solved, not guessed: for a fixed view direction, fitVertical() finds the camera
// distance + height that put a bottom and a top world point exactly on chosen screen rows.

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
  /** Steini on the mats (wall-local x + depth from the wall), or null when hidden. */
  guide?: { x: number; depth: number } | null;
}

/** Screen bands the input layer / HUD reserve in follow mode (fractions of 844 px). */
const HUD_SAFE = { top: 76 / 844, bottom: 98 / 844 };
/** Route the player must see above the higher hand (m): default, and the most a hint can add. */
const LOOK_AHEAD = 1.1;
const LOOK_AHEAD_MAX = 1.55;
/** Lowest camera height (world y): above the crash pads. */
const CAM_MIN_Y = 0.75;
/** Default fly-in length, and the shortest flight after the establishing glide (s). */
const DEFAULT_INTRO_S = 8.5;
const INTRO_FLY_MIN = 4.6;

interface ModeTuning {
  pos: number; // smooth time (s)
  look: number;
  fov: number;
}

const TUNING: Record<CameraMode, ModeTuning> = {
  title: { pos: 1.2, look: 1.0, fov: 1.2 },
  intro: { pos: 0.05, look: 0.05, fov: 0.3 },
  preview: { pos: 0.75, look: 0.6, fov: 0.7 },
  follow: { pos: 0.34, look: 0.24, fov: 0.6 },
  editor: { pos: 0.16, look: 0.12, fov: 0.25 },
  celebrate: { pos: 0.8, look: 0.4, fov: 0.8 },
  fall: { pos: 0.55, look: 0.22, fov: 0.5 },
};

/** Seconds a change INTO each mode takes to ease from the previous shot onto the new target. */
const BLEND_S: Record<CameraMode, number> = {
  title: 1.9,
  intro: 0,
  preview: 1.35,
  follow: 1.15,
  editor: 0.5,
  celebrate: 1.5,
  fall: 0.55,
};
/** Title ↔ locker framing changes (same mode, different shot). */
const FRAMING_BLEND_S = 1.5;
/** While a blend runs the eased target does the work; the springs only round it off. */
const BLEND_SPRING = 0.28;

/** Title band: the logo lockup ends ≈ 30%, the buttons start ≈ 68% (fractions of the height). */
const TITLE_BAND = { top: 0.325, bottom: 0.66 };
/** Steini standing on the mats: shoulders half-width and horn-tip height above the pad (m). */
const GUIDE_HALF_W = 0.3;
const GUIDE_TOP = 2.05;
const PAD_Y = 0.3;

function smootherstep01(k: number): number {
  const t = clamp(k, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Path progress of the intro fly-in at time t: a slow establishing glide while the intro card is
 * up (`hold` s, ≈ 10% of the path), then the flight to the wall, landing with zero velocity at
 * `dur`. Monotonic with a continuous velocity (the glide hands straight into the flight).
 */
export function introProgress(t: number, dur: number, hold: number): number {
  const k = clamp(t / Math.max(0.01, dur), 0, 1);
  const h = clamp(hold / Math.max(0.01, dur), 0, 0.75);
  const glide = 0.1;
  return glide * smoothstep(0, h + (1 - h) * 0.3, k) + (1 - glide) * smootherstep01((k - h * 0.7) / Math.max(0.05, 1 - h * 0.7));
}

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
  /** Carry a velocity (m/s) into the spring, e.g. when a scripted move hands over mid-flight. */
  setVelocity(v: THREE.Vector3): void {
    this.vx.v = v.x;
    this.vy.v = v.y;
    this.vz.v = v.z;
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
  // follow: framed wall-local extents (bottom / top / centre x, m), springing toward the target
  private fBot = new SpringNum(0.2);
  private fTop = new SpringNum(3.2);
  private fX = new SpringNum(0);
  private fYaw = new SpringNum(0);
  private followFresh = true;
  private wasDragging = false;
  /** follow: the climber is in the air (falling on the rope): the rig tracks faster. */
  private followAir = false;

  private tPos = new THREE.Vector3();
  private tLook = new THREE.Vector3();
  private tUp = new THREE.Vector3(0, 1, 0);
  private tFov = 42;
  private tRoll = 0;

  private modeTime = 0;
  private time = 0;
  /** Shot blend: the pose the camera had when the shot changed, eased toward the live target. */
  private blend = { t: 0, dur: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 42 };
  /** After an instant cut to an overview shot, start a hair wide and push in. */
  private settle = false;
  private focusHint: Vec2 | null = null;
  private focusOverride: Vec2 | null = null;
  private editorCenter: Vec2 = { x: 0, y: 2.25 };
  private editorMeters = 5;
  private trauma = 0;
  private continuousShake = 0;
  private celebrateSign = 1;
  private intro: { t: number; dur: number; hold: number; resolve: (() => void) | null; from: THREE.Vector3[]; look0: THREE.Vector3 } | null = null;
  /** Fly-in velocity (m/s) of the camera position / look point, handed to the springs on a skip. */
  private introVel = new THREE.Vector3();
  private introLookVel = new THREE.Vector3();
  private initialized = false;
  /** Optional (app): fractions of the viewport height covered by UI at the top / bottom; 'preview' fits the route between them. */
  viewInsets: { top: number; bottom: number } = { top: 0, bottom: 0 };
  private framing: { lift: number; distance: number } | null = null;
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
  private fwd = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private camRight = new THREE.Vector3();
  private pB = new THREE.Vector3();
  private pT = new THREE.Vector3();
  private fit = { dist: 0, h: 0 };
  private pts: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  private introPts: THREE.Vector3[] = [];

  constructor(aspect = 390 / 844) {
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.05, 120);
    this.up.snap(this.WORLD_UP);
  }

  /** 0..1 progress of the intro fly-in (1 when finished or not running). */
  get introProgress(): number {
    return this.intro ? clamp(this.intro.t / this.intro.dur, 0, 1) : 1;
  }

  /** Optional (app menus): title-mode framing — look-point lift above the subject and orbit distance (m). */
  get titleFraming(): { lift: number; distance: number } | null {
    return this.framing;
  }

  set titleFraming(f: { lift: number; distance: number } | null) {
    const prev = this.framing;
    const same = prev === f || (!!prev && !!f && prev.lift === f.lift && prev.distance === f.distance);
    this.framing = f ? { lift: f.lift, distance: f.distance } : null;
    // title ↔ locker is a change of shot inside 'title': ease it like a mode change
    if (!same && this.mode === 'title' && !this.intro) this.startBlend(FRAMING_BLEND_S);
  }

  setMode(mode: CameraMode, opts?: { instant?: boolean; focus?: Vec2 }): void {
    // A skipped intro must not keep flying over the next scene: any other mode (or an instant
    // 'title' snap) lands the fly-in right away — carrying its velocity into the springs and
    // easing onto the new shot, so a skip never stops the camera dead.
    let aborted = false;
    if (this.intro && mode !== 'intro' && (mode !== 'title' || opts?.instant)) {
      const r = this.intro.resolve;
      this.intro = null;
      aborted = true;
      if (!opts?.instant) {
        this.pos.setVelocity(this.introVel);
        this.look.setVelocity(this.introLookVel);
      }
      r?.();
    }
    const changed = mode !== this.mode;
    this.mode = mode;
    this.focusOverride = opts?.focus ?? null;
    if (changed) {
      this.modeTime = 0;
      if (mode === 'follow') this.followFresh = true;
      if (mode === 'celebrate') this.celebrateSign = this.camera.position.x >= 0 ? 1 : -1;
    }
    if (opts?.instant) {
      this.pendingSnap = true;
      this.settle = mode === 'preview' || mode === 'title';
      this.blend.dur = 0;
    } else if (changed || aborted) {
      this.startBlend(BLEND_S[mode]);
    }
    if (mode === 'intro' && !this.intro) this.startIntro(DEFAULT_INTRO_S);
  }

  private pendingSnap = false;

  /** Start easing from the camera's current pose onto whatever the target becomes. */
  private startBlend(dur: number): void {
    if (!this.initialized || dur <= 0) {
      this.blend.dur = 0;
      return;
    }
    this.blend.t = 0;
    this.blend.dur = dur;
    this.blend.pos.copy(this.pos.value);
    this.blend.look.copy(this.look.value);
    this.blend.fov = this.fov.value;
  }

  /**
   * Starts the scripted fly-in; resolves when it lands. `duration` is the whole flight; the first
   * `opts.hold` seconds (default ≈ half) are a slow establishing glide so an intro card over the
   * shot can be read. The flight after the hold never takes less than INTRO_FLY_MIN seconds (the
   * landing moves later rather than rushing the hall).
   */
  playIntro(duration = DEFAULT_INTRO_S, opts?: { hold?: number }): Promise<void> {
    this.mode = 'intro';
    this.modeTime = 0;
    return new Promise((resolve) => {
      this.startIntro(duration, resolve, opts?.hold);
    });
  }

  private startIntro(duration: number, resolve: (() => void) | null = null, holdS?: number): void {
    this.intro?.resolve?.();
    const hold = clamp(holdS ?? duration * 0.48, 0, 12);
    this.intro = {
      t: 0,
      dur: Math.max(duration, hold + INTRO_FLY_MIN),
      hold,
      resolve,
      from: [new THREE.Vector3(-3.4, 2.2, 22), new THREE.Vector3(-2.6, 2.75, 15), new THREE.Vector3(1.6, 2.45, 9.5)],
      look0: new THREE.Vector3(0, 3.6, 0),
    };
    this.introVel.set(0, 0, 0);
    this.introLookVel.set(0, 0, 0);
    this.blend.dur = 0;
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
        this.followTarget(ctx, aspect);
        break;
      }
      case 'fall': {
        // boulder fall: lagging, lower and wider; the whole body (and the pad once landed) stays
        // inside the HUD-safe band
        this.tFov = 48;
        let bot = 0.0;
        let top = 3.0;
        let cx = 0;
        let depth = 0.4;
        if (state) {
          this.climberBox(state);
          const b = this.bbox;
          cx = (b.minX + b.maxX) / 2;
          depth = state.pelvisDepth * 0.6;
          bot = Math.min(b.minY - 0.45, state.phase === 'landed' ? 0.05 : Infinity);
          top = b.maxY + 0.6;
        }
        const minSpan = 3.0;
        if (top - bot < minSpan) {
          const m = (minSpan - (top - bot)) / 2;
          top += m;
          bot -= m;
        }
        const ins = this.safeInsets();
        frame.toWorldXYZ(cx, bot, depth, this.pB);
        frame.toWorldXYZ(cx, top, depth, this.pT);
        this.solveAboveFloor(frame, 0.45, 16, -10, ins, 1.9, aspect);
        this.tUp.copy(this.WORLD_UP);
        this.tRoll = state && state.phase === 'falling' ? 2.5 * DEG : 0;
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
      this.tPos.y = clamp(this.tPos.y, CAM_MIN_Y, ctx.ceiling - 0.6);
      this.tPos.x = clamp(this.tPos.x, -11.5, 11.5);
      this.tPos.z = Math.min(this.tPos.z, 27);
    }
  }

  /**
   * Follow-mode screen insets: the bands the input layer keeps free of limb handles (the HUD bars
   * live inside them), plus a hair of air. Larger app insets are honoured only up to ~2% more.
   */
  private safeInsets(): { top: number; bottom: number } {
    const v = this.viewInsets;
    return {
      top: clamp(v.top, HUD_SAFE.top, HUD_SAFE.top + 0.02) + 0.01,
      bottom: clamp(v.bottom, HUD_SAFE.bottom, HUD_SAFE.bottom + 0.02) + 0.01,
    };
  }

  /** Camera basis (forward / up / right) for a view direction `dir` (subject → camera), up = world up. */
  private basis(dir: THREE.Vector3): void {
    this.fwd.copy(dir).negate();
    this.camRight.crossVectors(this.fwd, this.WORLD_UP).normalize();
    this.camUp.crossVectors(this.camRight, this.fwd).normalize();
  }

  /**
   * For the current basis, the camera distance (along forward, measured at B) and height offset
   * (along camera up) that put world point B on NDC row nB and T on row nT (nT > nB).
   */
  private fitVertical(B: THREE.Vector3, T: THREE.Vector3, nB: number, nT: number, tanH: number): { dist: number; h: number } {
    this.v1.subVectors(T, B);
    const yT = this.v1.dot(this.camUp);
    const zT = this.v1.dot(this.fwd);
    const dist = Math.max(1.2, (yT - tanH * nT * zT) / (tanH * (nT - nB)));
    this.fit.dist = dist;
    this.fit.h = -nB * tanH * dist;
    return this.fit;
  }

  /**
   * Frames B (bottom) and T (top) between the screen insets with the current basis + tFov, making
   * sure at least `minWidth` m of wall is visible across. Writes tPos / tLook.
   */
  private solveFrame(B: THREE.Vector3, T: THREE.Vector3, ins: { top: number; bottom: number }, minWidth: number, aspect: number): void {
    const tanH = Math.tan((this.tFov * DEG) / 2);
    const nT = 1 - 2 * ins.top;
    const nB = -1 + 2 * ins.bottom;
    const f = this.fitVertical(B, T, nB, nT, tanH);
    let dist = f.dist;
    let h = f.h;
    const dW = minWidth / 2 / (tanH * aspect);
    if (dW > dist) {
      // width-limited: back off and share the spare rows evenly above and below
      this.v1.subVectors(T, B);
      const yT = this.v1.dot(this.camUp);
      const zT = this.v1.dot(this.fwd);
      dist = dW;
      const hB = -nB * tanH * dist;
      const hT = yT - nT * tanH * (zT + dist);
      h = (hB + hT) / 2;
    }
    this.tPos.copy(B).addScaledVector(this.fwd, -dist).addScaledVector(this.camUp, h);
    this.tLook.copy(this.tPos).addScaledVector(this.fwd, dist);
  }

  /**
   * Gameplay framing. Target extents (wall-local): from just below the lower foot to LOOK_AHEAD
   * above the higher hand (more toward a dragged limb's target / the next route hold), centred on
   * the body with a pull toward the focus. The extents spring on their own; while a limb is
   * dragged they only grow, so the wall never slides under the finger.
   */
  private followTarget(ctx: CameraContext, aspect: number): void {
    const { frame, state } = ctx;
    const dt = this.lastDt;
    let bot = 0.2;
    let top = 3.0;
    let cx = 0;
    let minX = -0.45;
    let maxX = 0.45;
    let dragging = false;
    let airborne = false;
    const hint = this.focusHint ?? this.focusOverride;
    if (state) {
      this.climberBox(state);
      const b = this.bbox;
      const L = state.limbs;
      dragging = L.LH.dragging || L.RH.dragging || L.LF.dragging || L.RF.dragging;
      airborne = state.phase === 'falling' || state.phase === 'hanging' || state.phase === 'landed';
      cx = ((b.minX + b.maxX) / 2) * 0.6 + state.com.x * 0.4;
      minX = b.minX;
      maxX = b.maxX;
      if (!airborne) {
        const handTop = Math.max(L.LH.pos.y, L.RH.pos.y);
        // on steep overhangs the route above leans toward the lens and needs fewer meters
        const ahead = LOOK_AHEAD - 0.1 * smoothstep(15, 40, frame.angleDeg);
        bot = Math.min(b.minY, L.LF.pos.y, L.RF.pos.y) - 0.18;
        top = Math.max(b.maxY + 0.2, handTop + ahead);
        if (hint) {
          top = Math.max(top, Math.min(hint.y + 0.42, handTop + LOOK_AHEAD_MAX));
          bot = Math.min(bot, hint.y - 0.32);
          cx += clamp(hint.x - cx, -0.8, 0.8) * 0.3;
          minX = Math.min(minX, hint.x);
          maxX = Math.max(maxX, hint.x);
        }
      } else {
        // falling / caught on the rope / landed: the whole body with air around it, leading the fall
        bot = b.minY - 0.4 + Math.min(0, state.velocity.y) * 0.22;
        top = b.maxY + 0.5;
        if (state.phase === 'landed') bot = Math.min(bot, 0.05);
      }
    }
    // never tighter than ~2.5 m of wall, never wider than ~5.6 m (the climber stays the hero)
    const minExt = 2.5;
    if (top - bot < minExt) {
      const m = minExt - (top - bot);
      top += m * 0.6;
      bot -= m * 0.4;
    }
    if (top - bot > 4.6) bot = top - 4.6;

    if (this.followFresh || this.pendingSnap) {
      this.fBot.snap(bot);
      this.fTop.snap(top);
      this.fX.snap(cx);
      this.followFresh = false;
    } else if (dragging && !airborne) {
      // grow only (and slowly), keep the centre unless the target runs toward the frame edge
      if (!this.wasDragging) this.fX.snap(this.fX.value);
      this.fBot.step(Math.min(bot, this.fBot.value), 0.55, dt);
      this.fTop.step(Math.max(top, this.fTop.value), 0.55, dt);
      const half = (this.fTop.value - this.fBot.value) * 0.5 * aspect;
      const lo = maxX - half * 0.82;
      const hi = minX + half * 0.82;
      const want = lo <= hi ? clamp(this.fX.value, lo, hi) : (minX + maxX) / 2;
      this.fX.step(want, 0.9, dt);
    } else {
      const st = airborne ? 0.16 : 0.42;
      this.fBot.step(bot, st, dt);
      this.fTop.step(top, st, dt);
      this.fX.step(cx, airborne ? 0.3 : 0.5, dt);
    }
    this.wasDragging = dragging;
    this.followAir = !!state && state.phase === 'falling';

    this.tFov = 44;
    // a little yaw toward a swing, damped hard (and none while dragging) so the view never wobbles
    const swing = state && !dragging ? clamp(state.velocity.x * 2, -4, 4) : 0;
    this.fYaw.step(swing, airborne ? 0.4 : 1.1, dt);
    const depthB = state ? clamp(state.pelvisDepth * 0.3, 0.05, 0.3) : 0.1;
    frame.toWorldXYZ(this.fX.value, this.fBot.value, depthB, this.pB);
    frame.toWorldXYZ(this.fX.value, this.fTop.value, 0, this.pT);
    this.solveAboveFloor(frame, 0.55, 12 + this.fYaw.value, -8, this.safeInsets(), Math.max(1.5, maxX - minX + 0.5), aspect);
    this.tUp.copy(this.WORLD_UP);
    this.tRoll = 0;
  }

  /**
   * solveFrame() for a view (blend, yaw, pitch); if that would put the lens below the pads (steep
   * overhangs look up a lot), the view is levelled until the camera clears them — the framing
   * stays exact instead of being shoved by the height clamp afterwards.
   */
  private solveAboveFloor(frame: WallFrame, blend: number, yaw: number, pitch: number, ins: { top: number; bottom: number }, minWidth: number, aspect: number): void {
    let p = pitch;
    for (let i = 0; i < 4; i++) {
      this.viewDir(frame, blend, yaw, p, this.dir);
      this.basis(this.dir);
      this.solveFrame(this.pB, this.pT, ins, minWidth, aspect);
      const lack = CAM_MIN_Y - this.tPos.y;
      if (lack <= 0.005) return;
      const dist = this.tPos.distanceTo(this.tLook);
      p += (Math.asin(clamp(lack / Math.max(1, dist), 0, 0.9)) / DEG) * 1.05 + 0.2;
    }
  }

  private titleTarget(ctx: CameraContext, t: number): void {
    const { frame, state, boulder } = ctx;
    const lift = this.framing ? this.framing.lift : 0.3;
    if (lift < 0) {
      this.classicTitle(ctx, t);
      return;
    }
    // Composition: the climber on the wall and Steini on the mats fill the band between the logo
    // lockup and the button stack. The camera sits on the climber's side of Steini (so Steini is
    // seen in 3/4, looking up at him), a little low (looking up the wall), and drifts slowly:
    // a yaw sway, a breath of pitch and a dolly, on long incommensurate periods.
    const aspect = this.camera.aspect || 0.46;
    // a long lens: the brand wall fills the frame behind the two of them, perspective stays calm
    this.tFov = 32;
    const pts = this.pts;
    let n = 0;
    let cx = 0;
    if (state) {
      const d = state.pelvisDepth;
      cx = state.com.x;
      frame.toWorldXYZ(state.chest.x, state.chest.y + 0.36, d, pts[n++]); // head
      frame.toWorldXYZ(state.pelvis.x, state.pelvis.y, d, pts[n++]);
      for (const id of ['LH', 'RH', 'LF', 'RF'] as const) {
        const L = state.limbs[id];
        frame.toWorldXYZ(L.pos.x, L.pos.y, Math.max(0.05, L.depth), pts[n++]);
      }
    } else {
      if (boulder) {
        const st = boulder.holds.filter((h) => h.role === 'start');
        if (st.length) cx = st.reduce((a, h) => a + h.x, 0) / st.length;
      }
      frame.toWorldXYZ(cx, 1.2, 0.3, pts[n++]);
      frame.toWorldXYZ(cx, 3.2, 0.3, pts[n++]);
    }
    let side = 1;
    if (ctx.guide) {
      const g = ctx.guide;
      side = g.x <= cx ? 1 : -1;
      frame.toWorldXYZ(g.x, 0, g.depth, pts[n]).setY(PAD_Y);
      pts[n + 1].copy(pts[n]).setY(PAD_Y + GUIDE_TOP);
      pts[n].addScaledVector(frame.right, -GUIDE_HALF_W);
      pts[n + 1].addScaledVector(frame.right, GUIDE_HALF_W);
      n += 2;
    }
    const yaw = side * (11 + 6 * Math.sin(t * 0.061)) + 2.5 * Math.sin(t * 0.027 + 2);
    const pitch = -2.5 + 1.2 * Math.sin(t * 0.043 + 1.1);
    this.viewDir(frame, 0.3, yaw, pitch, this.dir);
    this.basis(this.dir);

    // extremes in world height (the camera is level-ish, so these are the top / bottom rows)
    let bi = 0;
    let ti = 0;
    for (let i = 1; i < n; i++) {
      if (pts[i].y < pts[bi].y) bi = i;
      if (pts[i].y > pts[ti].y) ti = i;
    }
    this.pB.copy(pts[bi]).setY(Math.min(pts[bi].y, PAD_Y) - 0.04);
    this.pT.copy(pts[ti]).addScaledVector(this.WORLD_UP, 0.12);
    const tanH = Math.tan((this.tFov * DEG) / 2);
    const nT = 1 - 2 * TITLE_BAND.top;
    const nB = 1 - 2 * TITLE_BAND.bottom;
    const f = this.fitVertical(this.pB, this.pT, nB, nT, tanH);
    let dist = f.dist;
    let h = f.h;
    // horizontal: every subject point inside ±0.78 NDC (relative to B), centred laterally
    let xl = Infinity;
    let xr = -Infinity;
    let zl = 0;
    let zr = 0;
    for (let i = 0; i < n; i++) {
      this.v1.subVectors(pts[i], this.pB);
      const x = this.v1.dot(this.camRight);
      const z = this.v1.dot(this.fwd);
      if (x < xl) {
        xl = x;
        zl = z;
      }
      if (x > xr) {
        xr = x;
        zr = z;
      }
    }
    const m = 0.78 * tanH * aspect;
    const dW = ((xr - xl) / m - (zl + zr)) / 2 + 0.4;
    if (dW > dist) {
      this.v1.subVectors(this.pT, this.pB);
      const yT = this.v1.dot(this.camUp);
      const zT = this.v1.dot(this.fwd);
      dist = dW;
      h = (-nB * tanH * dist + yT - nT * tanH * (zT + dist)) / 2;
    }
    const k = (xl * (zr + dist) + xr * (zl + dist)) / (zl + zr + 2 * dist);
    // the dolly only ever backs off from the solved fit, so the subjects never leave the band
    // (the band is centred on the screen, so backing off shrinks the shot about its own centre)
    const dolly = 0.28 + 0.28 * Math.sin(t * 0.05);
    this.tPos.copy(this.pB).addScaledVector(this.fwd, -(dist + dolly)).addScaledVector(this.camUp, h).addScaledVector(this.camRight, k);
    this.tLook.copy(this.tPos).addScaledVector(this.fwd, dist + dolly);
    this.tUp.copy(this.WORLD_UP);
    this.tRoll = 0;
  }

  /** Locker-style orbit: look-point lifted above the subject at a fixed distance (titleFraming). */
  private classicTitle(ctx: CameraContext, t: number): void {
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
    this.computeTarget(ctx);

    if (!this.initialized || this.pendingSnap) {
      this.pos.snap(this.tPos);
      this.look.snap(this.tLook);
      this.up.snap(this.tUp);
      this.fov.snap(this.tFov);
      this.roll.snap(this.tRoll);
      if (this.settle && this.initialized) {
        // a cut to an overview starts a hair wide and higher, then pushes in on the springs
        this.v1.subVectors(this.tPos, this.tLook);
        this.v2.copy(this.tPos).addScaledVector(this.v1, 0.07).addScaledVector(this.WORLD_UP, 0.12);
        this.pos.snap(this.v2);
        this.v2.copy(this.tLook).addScaledVector(this.WORLD_UP, 0.05);
        this.look.snap(this.v2);
      }
      this.settle = false;
      this.initialized = true;
      this.pendingSnap = false;
    }

    if (this.intro) {
      const it = this.intro;
      it.t += d;
      const k = clamp(it.t / it.dur, 0, 1);
      const e = introProgress(it.t, it.dur, it.hold);
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
      this.v2.copy(it.look0).lerp(this.tLook, smoothstep(0.12, 1, e));
      if (d > 0) {
        this.introVel.subVectors(this.v1, this.pos.value).divideScalar(d);
        this.introLookVel.subVectors(this.v2, this.look.value).divideScalar(d);
      }
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
      const b = this.blend;
      let blending = false;
      if (b.dur > 0) {
        b.t += d;
        const w = smootherstep01(b.t / b.dur);
        this.tPos.lerpVectors(b.pos, this.tPos, w);
        this.tLook.lerpVectors(b.look, this.tLook, w);
        this.tFov = b.fov + (this.tFov - b.fov) * w;
        blending = b.t < b.dur;
        if (!blending) b.dur = 0;
      }
      let sp = blending ? Math.min(tune.pos, BLEND_SPRING) : tune.pos;
      let sl = blending ? Math.min(tune.pos, BLEND_SPRING) : tune.look;
      if (this.mode === 'follow' && this.followAir) {
        sp *= 0.5;
        sl *= 0.5;
      }
      this.pos.step(this.tPos, sp, d);
      this.look.step(this.tLook, sl, d);
      this.up.step(this.tUp, 0.4, d);
      this.fov.step(this.tFov, blending ? BLEND_SPRING : tune.fov, d);
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

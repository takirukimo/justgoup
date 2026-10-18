// Camera framing contracts (headless: CameraRig only needs three's math).
//  follow — both feet and at least the next 1 m of route above the higher hand land inside the HUD-safe
//           band, the climber fills ~45–55% of the screen height, and a drag never shrinks it.
//  follow — a rope catch close to the floor keeps the whole body above the bottom HUD band.
//  title  — the climber and Steini both fit between the logo lockup and the button stack.
//  blends — every shot change eases (bounded speed + acceleration, continuous velocity); the intro
//           fly-in glides slowly while its card is up, then flies and lands without a hitch.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, introProgress, type CameraContext } from './camera';
import type { CameraMode } from '../core/contracts';
import { WallFrame } from './wall-frame';
import type { ClimberPhase, ClimberState, LimbId, LimbSnapshot, Vec2 } from '../core/types';

const W = 390;
const H = 844;

function limb(id: LimbId, pos: Vec2, anchor: Vec2, dragging = false): LimbSnapshot {
  return { id, holdId: dragging ? null : 'h', pos, anchor, depth: 0.03, dragging, load: 0.3, stress: 0.3, capacity: 1, reachRatio: 0.7, smearing: false, shake: 0, busy: false };
}

/** A climber on the wall: pelvis at `py`, hands up, feet below. */
function climber(py: number, phase: ClimberPhase = 'climbing', drag: LimbId | null = null): ClimberState {
  const pelvis = { x: 0, y: py };
  const chest = { x: 0.02, y: py + 0.5 };
  return {
    phase,
    pelvis,
    chest,
    com: { x: 0.01, y: py + 0.2 },
    pelvisDepth: 0.32,
    bodyYaw: 0,
    velocity: { x: 0, y: 0 },
    limbs: {
      LH: limb('LH', { x: -0.3, y: py + 1.15 }, { x: -0.19, y: py + 0.48 }, drag === 'LH'),
      RH: limb('RH', { x: 0.28, y: py + 0.95 }, { x: 0.19, y: py + 0.48 }, drag === 'RH'),
      LF: limb('LF', { x: -0.32, y: py - 0.62 }, { x: -0.1, y: py }, drag === 'LF'),
      RF: limb('RF', { x: 0.3, y: py - 0.5 }, { x: 0.1, y: py }, drag === 'RF'),
    },
    tension: 0.2,
    pump: 0,
    shake: 0,
    balance: 0,
    topProgress: 0,
    time: 1,
    clipped: [],
  };
}

function project(rig: CameraRig, frame: WallFrame, p: Vec2, depth = 0): { x: number; y: number } {
  const v = frame.toWorldXYZ(p.x, p.y, depth, new THREE.Vector3()).project(rig.camera);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

function settle(rig: CameraRig, ctx: CameraContext, sec = 6): void {
  for (let t = 0; t < sec; t += 1 / 60) rig.update(1 / 60, ctx);
}

describe('follow framing', () => {
  for (const angle of [-8, 0, 20, 30, 40]) {
    it(`frames feet + look-ahead inside the HUD-safe band (${angle}° wall)`, () => {
      const frame = new WallFrame(angle);
      const rig = new CameraRig(W / H);
      rig.viewInsets = { top: 0.1, bottom: 0.13 };
      const st = climber(1.6);
      const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: null };
      rig.setMode('follow', { instant: true });
      settle(rig, ctx);
      const handTop = Math.max(st.limbs.LH.pos.y, st.limbs.RH.pos.y);
      const ahead = project(rig, frame, { x: 0, y: handTop + 1.0 });
      const feet = Math.max(project(rig, frame, st.limbs.LF.pos).y, project(rig, frame, st.limbs.RF.pos).y);
      expect(ahead.y).toBeGreaterThan(76);
      expect(feet).toBeLessThan(H - 98);
      // climber height on screen: feet → top of the head (at the pelvis depth)
      const head = project(rig, frame, { x: st.chest.x, y: st.chest.y + 0.32 }, st.pelvisDepth).y;
      const hand = project(rig, frame, st.limbs.LH.pos).y;
      const frac = (feet - Math.min(head, hand)) / H;
      // ~45–55% on everyday walls; steep overhangs give the look-ahead a little more of the screen
      expect(frac).toBeGreaterThan(angle >= 25 ? 0.37 : 0.42);
      expect(frac).toBeLessThan(0.6);
    });
  }

  it('does not breathe in while a limb is dragged', () => {
    const frame = new WallFrame(15);
    const rig = new CameraRig(W / H);
    const ctx: CameraContext = { frame, boulder: null, state: climber(1.8), ceiling: 7.4, guide: null };
    rig.setMode('follow', { instant: true });
    settle(rig, ctx);
    // drag the left hand far up: the frame grows to show the target…
    const dragged = climber(1.8, 'climbing', 'LH');
    dragged.limbs.LH.pos = { x: -0.2, y: 3.4 };
    ctx.state = dragged;
    rig.setFocusHint({ x: -0.2, y: 3.5 });
    settle(rig, ctx, 3);
    const grown = project(rig, frame, { x: -0.2, y: 3.5 }).y;
    expect(grown).toBeGreaterThan(76);
    // …and pulling the finger back down mid-drag does not zoom back in under it
    const span0 = project(rig, frame, { x: 0, y: 0.5 }).y - project(rig, frame, { x: 0, y: 3.0 }).y;
    dragged.limbs.LH.pos = { x: -0.25, y: 3.0 };
    rig.setFocusHint({ x: -0.25, y: 3.0 });
    settle(rig, ctx, 2);
    const span1 = project(rig, frame, { x: 0, y: 0.5 }).y - project(rig, frame, { x: 0, y: 3.0 }).y;
    expect(span1).toBeLessThanOrEqual(span0 + 1);
  });

  it('keeps a low rope catch above the bottom HUD band', () => {
    const frame = new WallFrame(8);
    const rig = new CameraRig(W / H);
    rig.viewInsets = { top: 0.1, bottom: 0.13 };
    const st = climber(1.25, 'hanging');
    st.limbs.LF.pos = { x: -0.2, y: 0.55 };
    st.limbs.RF.pos = { x: 0.2, y: 0.5 };
    st.pelvisDepth = 0.6;
    const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: null };
    rig.setMode('follow', { instant: true });
    settle(rig, ctx);
    const feet = Math.max(project(rig, frame, st.limbs.LF.pos).y, project(rig, frame, st.limbs.RF.pos).y);
    const head = project(rig, frame, { x: 0, y: st.chest.y + 0.32 }, st.pelvisDepth).y;
    expect(feet).toBeLessThan(H - 98);
    expect(head).toBeGreaterThan(76);
  });
});

describe('title composition', () => {
  it('fits the climber and Steini between the logo and the buttons', () => {
    const frame = new WallFrame(20);
    const rig = new CameraRig(W / H);
    rig.titleFraming = { lift: 0.3, distance: 7.4 };
    const st = climber(0.95, 'idle');
    const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: { x: 1.05, depth: 1.5 } };
    rig.setMode('title', { instant: true });
    for (const t of [2, 20, 40]) {
      settle(rig, ctx, t === 2 ? 2 : 18);
      const pts = [st.limbs.LH.pos, st.limbs.RH.pos, st.limbs.LF.pos, st.limbs.RF.pos, { x: st.chest.x, y: st.chest.y + 0.32 }].map((p) => project(rig, frame, p, 0.3));
      const g = new THREE.Vector3();
      for (const [dx, y] of [[-0.3, 0.3], [0.3, 0.3], [-0.3, 2.2], [0.3, 2.2]]) {
        frame.toWorldXYZ(1.05 + dx, 0, 1.5, g).setY(y);
        const v = g.project(rig.camera);
        pts.push({ x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H });
      }
      for (const p of pts) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(W);
        expect(p.y).toBeGreaterThan(H * 0.29);
        expect(p.y).toBeLessThan(H * 0.7);
      }
    }
  });
});

describe('title composition (home scene)', () => {
  /** The home scene: the climber steady on holds ~2 m up the wall, Steini on the mats beside him. */
  function homeScene(angle: number, guideX: number) {
    const frame = new WallFrame(angle);
    const rig = new CameraRig(W / H);
    rig.titleFraming = { lift: 0.3, distance: 7.4 };
    const st = climber(2.1, 'climbing');
    const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: { x: guideX, depth: 1.5 } };
    return { frame, rig, st, ctx };
  }
  for (const [angle, gx] of [[20, 1.05], [0, -1.05], [35, 1.2]] as const) {
    it(`keeps both inside the band through the drift (${angle}° wall, Steini at x=${gx})`, () => {
      const { frame, rig, st, ctx } = homeScene(angle, gx);
      rig.setMode('title', { instant: true });
      settle(rig, ctx, 3);
      for (let k = 0; k < 8; k++) {
        settle(rig, ctx, 11);
        const pts = [st.limbs.LH.pos, st.limbs.RH.pos, st.limbs.LF.pos, st.limbs.RF.pos, { x: st.chest.x, y: st.chest.y + 0.32 }].map((p) => project(rig, frame, p, 0.3));
        const g = new THREE.Vector3();
        for (const [dx, y] of [[-0.3, 0.3], [0.3, 0.3], [-0.3, 2.2], [0.3, 2.2]]) {
          frame.toWorldXYZ(gx + dx, 0, 1.5, g).setY(y);
          const v = g.project(rig.camera);
          pts.push({ x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H });
        }
        for (const p of pts) {
          expect(p.x).toBeGreaterThan(8);
          expect(p.x).toBeLessThan(W - 8);
          expect(p.y).toBeGreaterThan(H * 0.3);
          expect(p.y).toBeLessThan(H * 0.68);
        }
      }
    });
  }
});

/** Camera motion carried between motion() calls (so a measurement can start mid-flight). */
interface Track {
  prev: THREE.Vector3;
  pv: THREE.Vector3;
}

/**
 * Steps the rig at 30 fps and returns the peak camera speed (m/s) and acceleration (m/s²). Pass the
 * same `track` to consecutive calls to measure across a change made between them (otherwise the
 * camera is assumed to start at rest).
 */
function motion(rig: CameraRig, ctx: CameraContext, sec: number, dt = 1 / 30, track?: Track): { vMax: number; aMax: number; jump: number } {
  let prev = track ? track.prev : rig.camera.position.clone();
  let pv = track ? track.pv : new THREE.Vector3();
  let vMax = 0;
  let aMax = 0;
  let jump = 0;
  for (let t = 0; t < sec; t += dt) {
    rig.update(dt, ctx);
    const p = rig.camera.position;
    const v = p.clone().sub(prev).divideScalar(dt);
    vMax = Math.max(vMax, v.length());
    aMax = Math.max(aMax, v.clone().sub(pv).length() / dt);
    jump = Math.max(jump, p.distanceTo(prev));
    prev = p.clone();
    pv = v;
  }
  if (track) {
    track.prev = prev;
    track.pv = pv;
  }
  return { vMax, aMax, jump };
}

describe('shot blends', () => {
  const chain: CameraMode[] = ['title', 'preview', 'follow', 'celebrate', 'follow', 'fall', 'preview', 'title'];
  it('eases every mode change (no jumps, bounded acceleration)', () => {
    const frame = new WallFrame(20);
    const rig = new CameraRig(W / H);
    rig.viewInsets = { top: 0.1, bottom: 0.13 };
    const st = climber(1.6);
    const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: { x: 1.05, depth: 1.5 } };
    rig.setMode('title', { instant: true });
    settle(rig, ctx, 4);
    for (const m of chain.slice(1)) {
      rig.setMode(m);
      const r = motion(rig, ctx, 3);
      // a cut would move metres in one frame; an eased move stays well under 0.5 m per 1/30 s
      expect(r.jump, `${m}: per-frame jump`).toBeLessThan(0.35);
      expect(r.aMax, `${m}: acceleration`).toBeLessThan(40);
    }
  });

  it('eases title ↔ locker framing changes', () => {
    const frame = new WallFrame(15);
    const rig = new CameraRig(W / H);
    const st = climber(2.1);
    const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: { x: -1.05, depth: 1.5 } };
    rig.titleFraming = { lift: 0.3, distance: 7.4 };
    rig.setMode('title', { instant: true });
    settle(rig, ctx, 4);
    for (const f of [{ lift: -1.25, distance: 4.5 }, { lift: 0.3, distance: 7.4 }]) {
      rig.titleFraming = f;
      ctx.guide = f.lift < 0 ? null : { x: -1.05, depth: 1.5 };
      const r = motion(rig, ctx, 3.5);
      expect(r.jump).toBeLessThan(0.3);
      expect(r.aMax).toBeLessThan(30);
    }
  });

  it('an instant request still cuts', () => {
    const frame = new WallFrame(10);
    const rig = new CameraRig(W / H);
    const ctx: CameraContext = { frame, boulder: null, state: climber(1.6), ceiling: 7.4, guide: null };
    rig.setMode('title', { instant: true });
    settle(rig, ctx, 3);
    const before = rig.camera.position.clone();
    rig.setMode('follow', { instant: true });
    rig.update(1 / 60, ctx);
    expect(rig.camera.position.distanceTo(before)).toBeGreaterThan(1);
  });
});

describe('intro fly-in pacing', () => {
  it('glides slowly while the card is up, then flies, monotonic with a continuous velocity', () => {
    const dur = 8.5;
    const hold = 4;
    let prev = 0;
    let prevV = 0;
    let maxDv = 0;
    for (let t = 0.01; t <= dur; t += 0.01) {
      const p = introProgress(t, dur, hold);
      const v = (p - prev) / 0.01;
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      if (t > 0.02) maxDv = Math.max(maxDv, Math.abs(v - prevV));
      prev = p;
      prevV = v;
    }
    expect(introProgress(hold * 0.8, dur, hold)).toBeLessThan(0.14);
    expect(introProgress(dur, dur, hold)).toBeCloseTo(1, 5);
    // velocity changes gradually (no step) at 100 Hz sampling
    expect(maxDv).toBeLessThan(0.02);
  });

  it('lands on the title shot and hands over without a jump', async () => {
    const frame = new WallFrame(20);
    const rig = new CameraRig(W / H);
    const ctx: CameraContext = { frame, boulder: null, state: climber(1.0, 'idle'), ceiling: 7.4, guide: { x: 1.05, depth: 1.5 } };
    rig.setMode('title', { instant: true });
    rig.update(1 / 30, ctx);
    let landed = false;
    void rig.playIntro(8, { hold: 3.5 }).then(() => {
      landed = true;
    });
    // the fly-in starts at the gym entrance: that first frame is a cut by design (under the splash)
    rig.update(1 / 30, ctx);
    const r = motion(rig, ctx, 11);
    await Promise.resolve();
    expect(landed).toBe(true);
    expect(rig.mode).toBe('title');
    expect(r.jump).toBeLessThan(0.45);
  });

  it('a skipped fly-in carries its motion into the next shot', () => {
    const frame = new WallFrame(20);
    const rig = new CameraRig(W / H);
    const ctx: CameraContext = { frame, boulder: null, state: climber(1.0, 'idle'), ceiling: 7.4, guide: null };
    rig.setMode('title', { instant: true });
    rig.update(1 / 30, ctx);
    void rig.playIntro(8, { hold: 2 });
    rig.update(1 / 30, ctx);
    const track: Track = { prev: rig.camera.position.clone(), pv: new THREE.Vector3() };
    motion(rig, ctx, 4.5, 1 / 30, track);
    rig.setMode('preview');
    const r = motion(rig, ctx, 3, 1 / 30, track);
    expect(r.jump).toBeLessThan(0.45);
    expect(r.aMax).toBeLessThan(60);
  });
});

describe('folded walls', () => {
  /** A cave: kicker, 30° wall, an 85° roof and a 20° lip panel (game/wall-profile PROFILE_PRESETS.CAVE). */
  function cave(): WallFrame {
    const frame = new WallFrame(0);
    frame.setWall({ wallAngle: 85, height: 4.7, profile: [{ y0: 0, angle: 0 }, { y0: 0.3, angle: 30 }, { y0: 1.9, angle: 85 }, { y0: 4.1, angle: 20 }] });
    return frame;
  }

  it('frames a climber hanging under the roof: body + the next holds inside the HUD-safe band, lens above the pads', () => {
    const frame = cave();
    const rig = new CameraRig(W / H);
    rig.viewInsets = { top: 0.1, bottom: 0.13 };
    const st = climber(2.7);
    st.pelvisDepth = 0.75;
    const ctx: CameraContext = { frame, boulder: null, state: st, ceiling: 7.4, guide: null };
    rig.setMode('follow', { instant: true });
    settle(rig, ctx);
    expect(rig.camera.position.y).toBeGreaterThan(0.7);
    const handTop = Math.max(st.limbs.LH.pos.y, st.limbs.RH.pos.y);
    const pts = [st.limbs.LH.pos, st.limbs.RH.pos, st.limbs.LF.pos, st.limbs.RF.pos, { x: 0, y: handTop + 0.6 }].map((p) => project(rig, frame, p, 0.03));
    pts.push(project(rig, frame, st.pelvis, st.pelvisDepth));
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(W);
      expect(p.y).toBeGreaterThan(76);
      expect(p.y).toBeLessThan(H - 98);
    }
  });

  it('screen ↔ wall round trip lands on the right panel', () => {
    const frame = cave();
    const rig = new CameraRig(W / H);
    const ctx: CameraContext = { frame, boulder: null, state: climber(2.4), ceiling: 7.4, guide: null };
    rig.setMode('follow', { instant: true });
    settle(rig, ctx, 2);
    const ray = new THREE.Raycaster();
    for (const p of [{ x: -0.4, y: 1.2 }, { x: 0.3, y: 2.6 }, { x: 0.1, y: 3.6 }]) {
      const s = project(rig, frame, p);
      ray.setFromCamera(new THREE.Vector2((s.x / W) * 2 - 1, -((s.y / H) * 2 - 1)), rig.camera);
      const out = { x: 0, y: 0 };
      expect(frame.raycast(ray.ray, out)).toBeGreaterThan(0);
      expect(Math.hypot(out.x - p.x, out.y - p.y)).toBeLessThan(1e-3);
    }
  });
});

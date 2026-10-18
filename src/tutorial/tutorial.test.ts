// Headless tests for the tutorial director: the real ClimberSim on tutorialBoulder(), stub
// renderer/UI/controls/audio, a manual clock, and a scripted "player" that follows the gating +
// highlights exactly like a person would (drag the allowed limb onto the highlighted hold).

import { afterEach, describe, expect, it } from 'vitest';
import type { AudioAPI, GuideLine, GuideState, HoldHighlight, LimbControlsAPI, RendererAPI, UIAPI } from '../core/contracts';
import type { BoulderDef, LimbId, Vec2 } from '../core/types';
import { bus } from '../core/events';
import { ClimberSim } from '../game/climber-sim';
import { tutorialBoulder, TUTORIAL_SEQUENCE } from '../game/generator';
import { contactPoint, LIMB_INDEX } from '../game/holds';
import { Clock } from './scope';
import { abortTutorial, runTutorial, TUTORIAL_SIM_OPTIONS, tutorialStatus } from './tutorial';
import { randomTip, TIPS, tipFor } from './tips';

const DT = 1 / 60;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

interface Rig {
  sim: ClimberSim;
  clock: Clock;
  lines: GuideLine[];
  callouts: string[];
  highlights: HoldHighlight[];
  guide: GuideState | null;
  camera: string;
  allowed: { limbs: readonly LimbId[] | 'all'; hips: boolean };
  skipChip: (() => void) | null;
  renderer: RendererAPI;
  ui: UIAPI;
  controls: LimbControlsAPI;
  audio: AudioAPI;
}

function rig(edit?: (b: BoulderDef) => BoulderDef): Rig {
  const boulder = edit ? edit(tutorialBoulder()) : tutorialBoulder();
  const sim = new ClimberSim(boulder, TUTORIAL_SIM_OPTIONS);
  const r = {
    sim,
    clock: new Clock({ manual: true }),
    lines: [] as GuideLine[],
    callouts: [] as string[],
    highlights: [] as HoldHighlight[],
    guide: null as GuideState | null,
    camera: 'title',
    allowed: { limbs: 'all' as readonly LimbId[] | 'all', hips: true },
    skipChip: null as (() => void) | null,
  } as Rig;
  const noop = (): void => undefined;
  r.renderer = {
    setHoldHighlights: (h: HoldHighlight[]) => {
      r.highlights = h.map((x) => ({ ...x }));
    },
    setGuide: (g: GuideState | null) => {
      r.guide = g ? { ...g } : null;
    },
    setCameraMode: (m: string) => {
      r.camera = m;
    },
    getBoulder: () => boulder,
    fx: { chalkPuff: noop, dust: noop, confetti: noop, cameraShake: noop },
  } as unknown as RendererAPI;
  let pendingTap: (() => void) | null = null;
  let tapIn = 0;
  r.clock.add(() => {
    if (pendingTap && --tapIn <= 0) {
      const f = pendingTap;
      pendingTap = null;
      f();
    }
  });
  r.ui = {
    guide: {
      say: (line: GuideLine) => {
        r.lines.push(line);
        const prev = pendingTap;
        pendingTap = null;
        prev?.();
        if (!line.waitForTap) return Promise.resolve();
        return new Promise<void>((res) => {
          pendingTap = res;
          tapIn = 20; // the player reads, then taps (~0.33 s)
        });
      },
      hide: () => {
        const prev = pendingTap;
        pendingTap = null;
        prev?.();
      },
      setSkip: (fn: (() => void) | null) => {
        r.skipChip = fn;
      },
    },
    hud: {
      update: noop,
      callout: (t: string) => {
        r.callouts.push(t);
      },
      toast: noop,
    },
  } as unknown as UIAPI;
  r.controls = {
    setAllowed: (limbs: readonly LimbId[] | 'all', hips?: boolean) => {
      r.allowed = { limbs: limbs === 'all' ? 'all' : [...limbs], hips: hips ?? limbs === 'all' };
    },
  } as unknown as LimbControlsAPI;
  r.audio = { play: noop, haptic: noop } as unknown as AudioAPI;
  return r;
}

/** A player that does what the tutorial asks (optionally making a few mistakes first). */
class Player {
  private busy = 0;
  private drag: { limb: LimbId; from: Vec2; to: Vec2; t: number; hold: string } | null = null;
  private hip: { t: number; x: number } | null = null;
  mistakes: ('wrong' | 'return')[] = [];

  constructor(private readonly r: Rig) {}

  update(): void {
    const { sim } = this.r;
    const st = sim.getState();
    if (st.phase !== 'climbing') return;
    if (this.drag) return this.stepDrag();
    if (this.hip) return this.stepHip();
    if (this.busy > 0) {
      this.busy--;
      return;
    }
    const hl = this.r.highlights.find((h) => h.kind === 'tutorial');
    const a = this.r.allowed;
    if (!hl || a.limbs === 'all') return;
    if (a.limbs.length === 1) {
      const limb = a.limbs[0];
      if (st.limbs[limb].holdId === hl.holdId) return;
      let holdId = hl.holdId;
      const m = this.mistakes.shift();
      if (m === 'wrong') holdId = sim.reachableHolds(limb).find((id) => id !== hl.holdId && id !== st.limbs[limb].holdId) ?? hl.holdId;
      const h = sim.boulder.holds.find((x) => x.id === holdId)!;
      const pair: LimbId = limb === 'LH' ? 'RH' : limb === 'RH' ? 'LH' : limb === 'LF' ? 'RF' : 'LF';
      let to = contactPoint(h, LIMB_INDEX[limb], st.limbs[pair].holdId === h.id, { x: 0, y: 0 });
      if (m === 'return') to = { x: st.limbs[limb].pos.x + 0.9, y: st.limbs[limb].pos.y + 0.3 }; // blank wall
      if (!sim.beginDrag(limb)) return;
      bus.emit('input:drag-start', { limb });
      const p = sim.getState().limbs[limb].pos;
      this.drag = { limb, from: { x: p.x, y: p.y }, to, t: 0, hold: holdId };
    } else if (a.limbs.length === 0 && a.hips) {
      this.hip = { t: 0, x: sim.boulder.holds.find((x) => x.id === hl.holdId)!.x };
      bus.emit('input:hip-start');
    }
  }

  private stepDrag(): void {
    const d = this.drag!;
    const { sim } = this.r;
    d.t += DT;
    const k = Math.min(1, d.t / 0.45);
    const p = { x: d.from.x + (d.to.x - d.from.x) * k, y: d.from.y + (d.to.y - d.from.y) * k };
    sim.dragTo(d.limb, p);
    const c = sim.snapCandidate(d.limb, p);
    bus.emit('input:drag-move', { limb: d.limb, candidateHoldId: c ? c.id : null, quality: 0.8 });
    if (k < 1) return;
    if (c?.id !== d.hold && d.t < 2.4) return; // hold the finger until it would snap (like a person)
    for (const e of sim.endDrag(d.limb)) bus.emit('sim:event', e);
    bus.emit('input:drag-end', { limb: d.limb });
    this.drag = null;
    this.busy = 20;
  }

  private stepHip(): void {
    const h = this.hip!;
    const { sim } = this.r;
    h.t += DT;
    sim.setHipTarget({ x: h.x, y: sim.getState().pelvis.y + 0.05 });
    if (h.t < 1.1) return;
    sim.setHipTarget(null);
    bus.emit('input:hip-end');
    this.hip = null;
    this.busy = 20;
  }
}

async function drive(r: Rig, p: Player | null, seconds: number, until?: () => boolean): Promise<void> {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    for (const e of r.sim.step(DT)) bus.emit('sim:event', e);
    p?.update();
    r.clock.tick(DT);
    await flush();
    if (until?.()) return;
  }
}

afterEach(() => abortTutorial());

describe('runTutorial', () => {
  it('teaches the full sequence on the real sim and finishes with a send', async () => {
    const r = rig();
    const player = new Player(r);
    let skip: () => void = () => undefined;
    const skipSignal = new Promise<void>((res) => (skip = res));
    let result: string | null = null;
    let doneEvt: { skipped: boolean } | null = null;
    const off = bus.on('tutorial:done', (e) => (doneEvt = e));
    const shakeSeen: boolean[] = [];
    const offShake = bus.on('sim:event', (e) => e.type === 'shake-start' && shakeSeen.push(true));
    const steps = new Set<number>();
    void runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal, clock: r.clock }).then((v) => (result = v));
    await drive(r, player, 240, () => {
      steps.add(tutorialStatus().step);
      return result !== null;
    });
    off();
    offShake();
    skip();
    if (env.TUT_LOG) console.log(r.lines.map((l) => `${l.waitForTap ? '[tap]' : '     '} ${l.position ?? 'bottom'} ${l.mood}: ${l.text}`).join('\n'));
    expect(result).toBe('done');
    expect(doneEvt).toEqual({ skipped: false });
    expect(r.sim.getState().phase).toBe('topped');
    for (let i = 0; i < TUTORIAL_SEQUENCE.length; i++) expect(steps.has(i), `step ${i}`).toBe(true);
    expect(r.callouts).toContain('SENT!');
    expect(shakeSeen.length).toBeGreaterThan(0); // the stretch lesson really shakes with TUTORIAL_SIM_OPTIONS
    expect(r.lines.some((l) => l.text.startsWith('Feel the shaking'))).toBe(true);
    // every lesson line is short enough to read mid-move
    for (const l of r.lines) if (!l.waitForTap) expect(l.text.split(/\s+/).length, l.text).toBeLessThanOrEqual(16);
    // clean exit
    expect(r.highlights).toEqual([]);
    expect(r.allowed.limbs).toBe('all');
    expect(r.skipChip).toBeNull();
    expect(r.guide).toBeNull();
    expect(tutorialStatus().running).toBe(false);
  }, 60000);

  it('corrects a wrong hold and a miss, then carries on', async () => {
    const r = rig();
    const player = new Player(r);
    player.mistakes = ['wrong', 'return'];
    let result: string | null = null;
    void runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal: new Promise(() => undefined), clock: r.clock }).then((v) => (result = v));
    await drive(r, player, 60, () => tutorialStatus().step >= 1);
    const texts = r.lines.map((l) => l.text);
    expect(texts.some((t) => /Wrong hold|Not that one/.test(t))).toBe(true);
    expect(texts.some((t) => /Let go right on the hold|Missed!/.test(t))).toBe(true);
    expect(r.sim.getState().limbs.RH.holdId).toBe('tut-hand-1');
    expect(result).toBeNull();
  }, 60000);

  it('never traps the player: an out-of-reach move gets the feet-first rescue', async () => {
    // push the stretch hold far out of reach
    const r = rig((b) => ({ ...b, holds: b.holds.map((h) => (h.id === 'tut-hand-3' ? { ...h, x: 1.75 } : h)) }));
    const player = new Player(r);
    let result: string | null = null;
    void runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal: new Promise(() => undefined), clock: r.clock }).then((v) => (result = v));
    await drive(r, player, 300, () => result !== null);
    const texts = r.lines.map((l) => l.text);
    if (env.TUT_LOG) console.log(texts.join('\n'));
    expect(result).toBe('done');
    expect(texts.some((t) => t.startsWith('Full stretch'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Too far from down there'))).toBe(true);
    expect(texts.some((t) => /Feel the shaking|Stretched like this/.test(t))).toBe(true);
    expect(r.allowed.limbs).toBe('all');
  }, 90000);

  it('skips cleanly mid-lesson and leaves no listeners behind', async () => {
    const r = rig();
    const player = new Player(r);
    let skip: () => void = () => undefined;
    const skipSignal = new Promise<void>((res) => (skip = res));
    let result: string | null = null;
    const p = runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal, clock: r.clock });
    // idempotent: same sim → same promise
    expect(runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal, clock: r.clock })).toBe(p);
    void p.then((v) => (result = v));
    await drive(r, player, 60, () => tutorialStatus().step >= 2);
    expect(r.highlights.length).toBe(1);
    skip();
    await drive(r, null, 0.2);
    expect(result).toBe('skipped');
    expect(r.highlights).toEqual([]);
    expect(r.allowed).toEqual({ limbs: 'all', hips: true });
    const n = r.lines.length;
    bus.emit('ui:hint');
    bus.emit('input:blocked', { limb: 'LF', reason: 'locked' });
    bus.emit('sim:event', { type: 'return', limb: 'RH', holdId: null });
    await drive(r, null, 6);
    expect(r.lines.length).toBe(n); // nothing reacts any more
  }, 60000);

  it('the SKIP chip and ui:quit both end the run', async () => {
    const r = rig();
    let result: string | null = null;
    void runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal: new Promise(() => undefined), clock: r.clock }).then((v) => (result = v));
    await drive(r, null, 1);
    expect(typeof r.skipChip).toBe('function');
    r.skipChip!();
    await drive(r, null, 0.1);
    expect(result).toBe('skipped');

    const r2 = rig();
    let result2: string | null = null;
    void runTutorial({ sim: r2.sim, renderer: r2.renderer, controls: r2.controls, ui: r2.ui, audio: r2.audio, skipSignal: new Promise(() => undefined), clock: r2.clock }).then((v) => (result2 = v));
    await drive(r2, null, 1);
    bus.emit('ui:quit');
    await drive(r2, null, 0.1);
    expect(result2).toBe('skipped');
  });
});

describe('tips', () => {
  it('has at least 30 short tips and deterministic picks', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(TIPS).size).toBe(TIPS.length);
    for (const t of TIPS) expect(t.split(/\s+/).length, t).toBeLessThanOrEqual(16);
    expect(randomTip(42)).toBe(randomTip(42));
    expect(TIPS).toContain(randomTip());
    const picks = new Set(Array.from({ length: 40 }, (_, i) => randomTip(i)));
    expect(picks.size).toBeGreaterThan(15);
    expect(TIPS).toContain(tipFor('pump', 3));
    expect(tipFor('barn-door', 1)).not.toMatch(/clip/i);
  });
});

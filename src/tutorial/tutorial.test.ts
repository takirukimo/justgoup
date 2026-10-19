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
import { abortTutorial, runIntro, runTutorial, TUTORIAL_SIM_OPTIONS, tutorialStatus } from './tutorial';
import { cardHoldTime, colourWord, FINALE, holdTime, INTRO_CARD, INTRO_LINES, readTime, tOpen } from './script';
import { BRAND, PALETTE } from '../config/brand';
import { randomTip, TIPS, tipFor } from './tips';
import { chalkBagAt, SHAKE_LANE, shakeLanePoint, spineUp } from '../input/release';

/** A spot of `limb`'s shake-out lane where no hold would be grabbed (null if none). */
function clearLanePoint(sim: ClimberSim, limb: LimbId, up: Vec2): Vec2 | null {
  const A = sim.getState().limbs[limb].anchor;
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    for (const g of [0.5, 0.8, 0.2]) {
      const p = shakeLanePoint(limb === 'LH' ? 0 : 1, A, up, SHAKE_LANE.down0 + (SHAKE_LANE.down1 - SHAKE_LANE.down0) * f, SHAKE_LANE.out0 + (SHAKE_LANE.out1 - SHAKE_LANE.out0) * g, { x: 0, y: 0 });
      if (!sim.snapCandidate(limb, p)) return p;
    }
  }
  return null;
}

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
  /** `zone`: a release zone (shake-out lane / chalk bag) rather than a hold: let go once there. */
  private drag: { limb: LimbId; from: Vec2; to: Vec2; t: number; hold: string; zone?: boolean; live?: () => Vec2 | null } | null = null;
  private hip: { t: number; x: number } | null = null;
  mistakes: ('wrong' | 'return' | 'lane' | 'bag')[] = [];

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
    const a = this.r.allowed;
    const { beat, target } = tutorialStatus();
    if ((beat === 'shake-out' || beat === 'chalk') && target && a.limbs !== 'all' && a.limbs.length === 1) {
      // the Phase B beats: let the hand go down by the side (clear of holds), or at the chalk bag
      const limb = a.limbs[0];
      const L = st.limbs[limb];
      if (L.shakingOut || L.chalking || L.busy) return;
      const to = { x: target.x, y: target.y };
      if (!sim.beginDrag(limb)) return;
      bus.emit('input:drag-start', { limb });
      // the zone moves with the body: keep aiming at the live target
      this.drag = { limb, from: { x: L.pos.x, y: L.pos.y }, to, t: 0, hold: '', zone: true, live: () => tutorialStatus().target };
      return;
    }
    const hl = this.r.highlights.find((h) => h.kind === 'tutorial');
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
      const up = spineUp(st.pelvis, st.chest, { x: 0, y: 1 });
      // down by the side, clear of holds (the shake-out lane), or at the hips (the chalk bag)
      if (m === 'lane') to = clearLanePoint(sim, limb, up) ?? to;
      if (m === 'bag') to = chalkBagAt(st.pelvis, up, { x: 0, y: 0 });
      if (!sim.beginDrag(limb)) return;
      bus.emit('input:drag-start', { limb });
      const p = sim.getState().limbs[limb].pos;
      const live = m === 'bag' ? (): Vec2 => { const s = sim.getState(); return chalkBagAt(s.pelvis, spineUp(s.pelvis, s.chest, { x: 0, y: 1 }), { x: 0, y: 0 }); } : undefined;
      this.drag = { limb, from: { x: p.x, y: p.y }, to, t: 0, hold: holdId, zone: m === 'lane' || m === 'bag', live };
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
    const lt = d.live?.();
    if (lt) d.to = { x: lt.x, y: lt.y };
    const p = { x: d.from.x + (d.to.x - d.from.x) * k, y: d.from.y + (d.to.y - d.from.y) * k };
    sim.dragTo(d.limb, p);
    const c = sim.snapCandidate(d.limb, p);
    bus.emit('input:drag-move', { limb: d.limb, candidateHoldId: c ? c.id : null, quality: 0.8 });
    if (k < 1) return;
    if (!d.zone && c?.id !== d.hold && d.t < 2.4) return; // hold the finger until it would snap (like a person)
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
    const phaseB = { shakeOut: 0, chalk: 0, chalkDone: 0 };
    const offShake = bus.on('sim:event', (e) => {
      if (e.type === 'shake-start') shakeSeen.push(true);
      if (e.type === 'shake-out-start') phaseB.shakeOut++;
      if (e.type === 'chalk-start') phaseB.chalk++;
      if (e.type === 'chalk-done') phaseB.chalkDone++;
    });
    const beats = new Set<string>();
    const steps = new Set<number>();
    void runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal, clock: r.clock }).then((v) => (result = v));
    await drive(r, player, 300, () => {
      const s = tutorialStatus();
      steps.add(s.step);
      if (s.beat) beats.add(s.beat);
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
    // Phase B beats: a shake-out on the big jug after the pump lesson, a chalk dip before the TOP
    expect([...beats].sort()).toEqual(['chalk', 'shake-out']);
    expect(phaseB.shakeOut).toBe(1);
    expect(phaseB.chalk).toBe(1);
    expect(phaseB.chalkDone).toBe(1);
    expect(r.lines.some((l) => l.text.startsWith('Shake it out'))).toBe(true);
    expect(r.lines.some((l) => l.text.startsWith('That’s a shake-out. Rest'))).toBe(true);
    expect(r.lines.some((l) => l.text.startsWith('Fresh chalk, better grip'))).toBe(true);
    expect(r.lines.some((l) => /Not quite|Lower, right down/.test(l.text))).toBe(false); // a careful player never misses them
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

  it('coaches a hand let go into the shake-out lane or at the chalk bag mid-lesson, then carries on', async () => {
    const r = rig();
    const player = new Player(r);
    player.mistakes = ['lane', 'bag'];
    const seen: string[] = [];
    const off = bus.on('sim:event', (e) => (e.type === 'shake-out-start' || e.type === 'chalk-start') && seen.push(e.type));
    let result: string | null = null;
    void runTutorial({ sim: r.sim, renderer: r.renderer, controls: r.controls, ui: r.ui, audio: r.audio, skipSignal: new Promise(() => undefined), clock: r.clock }).then((v) => (result = v));
    await drive(r, player, 90, () => tutorialStatus().step >= 1);
    off();
    const texts = r.lines.map((l) => l.text);
    expect(seen).toEqual(['shake-out-start', 'chalk-start']);
    expect(texts.some((t) => t.startsWith('That’s a shake-out: the arm hangs'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Chalking up?'))).toBe(true);
    // the chalk dip's automatic return to the hold is not coached as a miss
    expect(texts.some((t) => /Let go right on the hold|Missed!/.test(t))).toBe(false);
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

describe('pacing (owner: every card and line stays up long enough to read)', () => {
  it('reads at 220 ms per word with a 2.5 s floor, and holds add the reveal + fade', () => {
    expect(readTime('Allez!')).toBe(2.5);
    expect(readTime('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen')).toBeCloseTo(15 * 0.22, 5);
    for (const l of INTRO_LINES) expect(holdTime(l.text)).toBeGreaterThan(readTime(l.text));
    expect(cardHoldTime()).toBeGreaterThanOrEqual(2.5);
  });

  it('the intro keeps the title card and every line up for their reading time when nobody taps', async () => {
    const clock = new Clock({ manual: true });
    let now = 0;
    clock.add((dt) => (now += dt));
    const shown: { text: string; at: number }[] = [];
    const ui = {
      guide: {
        say: (line: GuideLine) => {
          shown.push({ text: line.text, at: now });
          return line.waitForTap ? new Promise<void>(() => undefined) : Promise.resolve();
        },
        hide: () => undefined,
        setSkip: () => undefined,
      },
      hud: { update: () => undefined, callout: () => undefined, toast: () => undefined },
    } as unknown as UIAPI;
    const boulder = tutorialBoulder();
    const renderer = { setGuide: () => undefined, setCameraMode: () => undefined, getBoulder: () => boulder } as unknown as RendererAPI;
    const audio = { play: () => undefined, haptic: () => undefined } as unknown as AudioAPI;
    let done = false;
    void runIntro({ renderer, ui, audio, clock }).then(() => (done = true));
    for (let i = 0; i < 60 * 90 && !done; i++) {
      clock.tick(DT);
      await flush();
    }
    expect(done).toBe(true);
    expect(shown.map((x) => x.text)).toEqual(INTRO_LINES.map((l) => l.text));
    // the title card (shown at 0.55 s) is readable before Steini starts talking
    expect(shown[0].at).toBeGreaterThanOrEqual(0.55 + cardHoldTime());
    for (let i = 0; i + 1 < shown.length; i++) expect(shown[i + 1].at - shown[i].at, shown[i].text).toBeGreaterThanOrEqual(holdTime(shown[i].text));
  }, 30000);

  it('names the tutorial route by its tape colour and calls the game STEIBOCK', () => {
    expect(colourWord('#FF4F1F')).toBe('orange');
    expect(colourWord(PALETTE.signal)).toBe('pink');
    expect(colourWord('#2F6FEB')).toBe('blue');
    expect(colourWord('#F2C230')).toBe('yellow');
    expect(tOpen(tutorialBoulder().color)[0].text).toMatch(/^This is my problem\. [A-Z][a-z]+ holds only\./);
    expect(INTRO_CARD.title).toBe(BRAND.game);
    expect(INTRO_LINES[0].text).toMatch(/instructor/i);
    const all = [...INTRO_LINES, ...FINALE].map((l) => l.text).join(' ') + ' ' + TIPS.join(' ');
    expect(all).not.toMatch(/just go up/i);
    expect(FINALE.some((l) => l.text.includes(BRAND.game))).toBe(true);
  });
});

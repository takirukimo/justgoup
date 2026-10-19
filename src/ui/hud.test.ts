import { describe, expect, it } from 'vitest';
import type { ClimberState, LimbId, LimbSnapshot } from '../core/types';
import { SIM } from '../config/tuning';
import { armState, canChalk, chalkChip, chalkShown } from './screens/hud';

function limb(id: LimbId, extra: Partial<LimbSnapshot> = {}): LimbSnapshot {
  return { id, holdId: 'h', pos: { x: 0, y: 1 }, anchor: { x: 0, y: 1.2 }, depth: 0.03, dragging: false, load: 0.3, stress: 0.5, capacity: 0.6, reachRatio: 0.6, smearing: false, shake: 0, busy: false, ...extra };
}
function state(over: Partial<ClimberState> = {}, limbs: Partial<Record<LimbId, Partial<LimbSnapshot>>> = {}): ClimberState {
  return {
    phase: 'climbing',
    pelvis: { x: 0, y: 1 },
    chest: { x: 0, y: 1.5 },
    com: { x: 0, y: 1.2 },
    pelvisDepth: 0.3,
    bodyYaw: 0,
    velocity: { x: 0, y: 0 },
    limbs: { LH: limb('LH', limbs.LH), RH: limb('RH', limbs.RH), LF: limb('LF', limbs.LF), RF: limb('RF', limbs.RF) },
    tension: 0.3,
    pump: 0.2,
    shake: 0,
    balance: 0,
    topProgress: 0,
    time: 0,
    clipped: [],
    ...over,
  };
}

describe('HUD forearm columns', () => {
  it('pump bands: calm → working → PUMPED at SIM.pumpWarn → critical', () => {
    expect(armState(0.2)).toBe('calm');
    expect(armState(0.65)).toBe('warn');
    expect(armState(SIM.pumpWarn)).toBe('pumped');
    expect(armState(0.95)).toBe('crit');
  });

  it('chalk chip: friction words, CHALK in the bag, SHAKE while shaking out', () => {
    expect(chalkChip(limb('LH', { friction: 1 }))).toEqual({ word: 'FRESH', act: '', fr: 'fresh' });
    expect(chalkChip(limb('LH', { friction: 0.5 })).fr).toBe('worn');
    expect(chalkChip(limb('LH', { friction: 0.2 })).word).toBe('GREASY');
    expect(chalkChip(limb('LH'))).toEqual({ word: 'FRESH', act: '', fr: 'fresh' }); // no friction data = fresh
    expect(chalkChip(limb('LH', { friction: 0.2, chalking: true }))).toEqual({ word: 'CHALK', act: 'chalk', fr: 'greasy' });
    expect(chalkChip(limb('LH', { shakingOut: true })).act).toBe('shake');
  });

  it('CHALK is offered only when the sim would accept it', () => {
    expect(canChalk(state(), 'LH')).toBe(true);
    // the other hand must hold
    expect(canChalk(state({}, { RH: { holdId: null } }), 'LH')).toBe(false);
    expect(canChalk(state({}, { RH: { busy: true } }), 'LH')).toBe(false);
    expect(canChalk(state({}, { RH: { dragging: true } }), 'LH')).toBe(false);
    // a busy / dragged / flying hand can't
    expect(canChalk(state({}, { LH: { busy: true } }), 'LH')).toBe(false);
    expect(canChalk(state({}, { LH: { dragging: true } }), 'LH')).toBe(false);
    // a hand shaking out (off its hold) may chalk
    expect(canChalk(state({}, { LH: { holdId: null, shakingOut: true } }), 'LH')).toBe(true);
    // not in flight, not before / after the climb
    expect(canChalk(state({ airborne: true }), 'LH')).toBe(false);
    expect(canChalk(state({ phase: 'idle' }), 'RH')).toBe(false);
    // a bat hang frees both hands; a figure 4 locks the arm the leg is over
    expect(canChalk(state({ special: 'bat' }, { LH: { holdId: null }, RH: { holdId: null } }), 'LH')).toBe(true);
    expect(canChalk(state({ special: 'figure4', figure4: { hand: 'LH', leg: 'RF', blend: 1 } }), 'LH')).toBe(false);
  });

  it('CHALK buttons and grip chips only where chalk matters: lead yes, every boulder mode no', () => {
    const run = { score: 0, streak: 0, boulderName: 'x', grade: 3 };
    expect(chalkShown({ ...run, mode: 'rope' })).toBe(true);
    for (const mode of ['boulder', 'daily', 'community', 'test', 'tutorial'] as const) expect(chalkShown({ ...run, mode }), mode).toBe(false);
    // the session passes the sim's own answer (ClimberSim.chalkMatters), which wins
    expect(chalkShown({ ...run, mode: 'boulder', chalk: true })).toBe(true);
    expect(chalkShown({ ...run, mode: 'rope', chalk: false })).toBe(false);
  });
});

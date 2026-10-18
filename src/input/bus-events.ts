// Bus messages owned by the INPUT + UI modules, added to the shared AppEvents map by declaration
// merging (additive: src/core/events.ts stays untouched; the typed bus accepts these keys anywhere
// this file is part of the program, which is every build since tsconfig includes src/).

export {};

declare module '../core/events' {
  interface AppEvents {
    /** HUD CHALK button: dip this hand into the chalk bag (LimbControls → sim.chalkUp). */
    'ui:chalk': { hand: 'LH' | 'RH' };
    /** A two-finger flick on the hip handle threw (or tried to throw) a double-hand dyno. */
    'input:dyno': { holdId: string; power: number; thrown: boolean };
  }
}

// Extra UI → app intents, added to the shared AppEvents map by module augmentation (additive: the
// map in src/core/events.ts is untouched; fold these into it when that file is next edited).
//
//   'ui:new-run'  results after a run ends (Send Train / Lead Tower): start a brand-new random run.
//                 'ui:retry' on the same screen replays the problem the run ended on as a fresh run.
//   'ui:menu'     results of a single problem picked from a list (Community): leave to the main menu
//                 instead of the list the problem came from ('ui:quit' goes back to the list).

export {};

declare module '../core/events' {
  interface AppEvents {
    'ui:new-run': void;
    'ui:menu': void;
  }
}

// The INPUT + UI bus messages ('ui:chalk', 'input:dyno') now live in the shared AppEvents map
// (src/core/events.ts). This module only re-exports that map so existing side-effect imports
// (`import './bus-events'`) keep compiling; new code imports from src/core/events directly.

export type { AppEvents } from '../core/events';

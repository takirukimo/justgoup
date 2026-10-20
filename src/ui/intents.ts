// Extra UI → app intents. 'ui:new-run' and 'ui:menu' started here as a module augmentation of AppEvents
// and now live in the shared map in src/core/events.ts (with what each one means); this module stays as
// an empty import target so existing `import '../intents'` lines keep compiling.

export {};

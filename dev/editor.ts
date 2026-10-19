// EDITOR dev harness: GameRenderer + GameUI + BoulderEditor with a stand-in for the app's test climb.
// Not part of the shipped build.
//
// URL params:
//   fresh=1        clear the saved draft first
//   sample=<V>     open with a generated problem of that grade (seed=<n>)
//   intro=1        show Steini's first-visit line
//   q=low|medium|high
//   auto=fell|sent run the test-climb stand-in automatically (QA scripts)
//   photo=stub     a stand-in photo importer (src/photo's signature): shows its own screen, then hands
//                  back a generated problem (photo=cancel: hands back null)

import { GameRenderer } from '../src/render/renderer';
import { GameUI } from '../src/ui/ui';
import { BoulderEditor } from '../src/editor/editor';
import { bus } from '../src/core/events';
import { generateBoulder } from '../src/game/generator';
import type { BoulderDef, QualityLevel } from '../src/core/types';

declare global {
  interface Window {
    __ed?: { editor: BoulderEditor; renderer: GameRenderer; ui: GameUI; events: string[]; lastTest: BoulderDef | null; lastPublish: BoulderDef | null };
  }
}

const qs = new URLSearchParams(location.search);
try {
  if (qs.has('fresh')) localStorage.removeItem('jgu.editor.draft');
  if (qs.has('intro')) localStorage.removeItem('jgu.editor.intro');
  else localStorage.setItem('jgu.editor.intro', '1');
} catch {
  /* storage blocked */
}

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLDivElement;
const testBar = document.getElementById('testclimb') as HTMLDivElement;
const reopen = document.getElementById('reopen') as HTMLButtonElement;

const q = qs.get('q');
const renderer = new GameRenderer(canvas, { quality: q === 'low' || q === 'medium' || q === 'high' ? (q as QualityLevel) : 'medium' });
const ui = new GameUI();
ui.mount(uiRoot);
ui.setPortraitProvider((h) => renderer.portrait(h, 160));
await renderer.init();

const editor = new BoulderEditor(uiRoot, renderer, ui);
const photo = qs.get('photo');
if (photo === 'stub' || photo === 'cancel') {
  editor.photoImporter = ({ root }) =>
    new Promise((resolve) => {
      state.events.push('photo');
      const scr = document.createElement('div');
      scr.style.cssText = 'position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:rgba(13,14,16,.94);color:#F6F4EF;font:700 18px/1.2 "Barlow Condensed",sans-serif;letter-spacing:.14em;pointer-events:auto';
      scr.textContent = 'PHOTO IMPORT · STUB';
      root.appendChild(scr);
      setTimeout(() => {
        scr.remove();
        resolve(photo === 'cancel' ? null : { ...generateBoulder({ seed: 41, grade: 2, style: 'compression', holdsOnVolumes: true }), name: 'From The Photo' });
      }, 900);
    });
}
const state: NonNullable<Window['__ed']> = { editor, renderer, ui, events: [], lastTest: null, lastPublish: null };
window.__ed = state;

let pendingTest: BoulderDef | null = null;
const finishTest = (sent: boolean): void => {
  if (!pendingTest) return;
  const b = pendingTest;
  pendingTest = null;
  testBar.classList.remove('on');
  renderer.setCameraMode('editor');
  editor.reportTestResult(sent);
  editor.open(b);
};

bus.on('editor:test', ({ boulder }) => {
  state.events.push('test');
  state.lastTest = boulder;
  console.log('[dev] editor:test', boulder.name, `V${boulder.grade}`, boulder.holds.length, 'holds');
  pendingTest = boulder;
  renderer.loadBoulder(boulder);
  renderer.setCameraMode('preview');
  testBar.classList.add('on');
  const auto = qs.get('auto');
  if (auto === 'sent' || auto === 'fell') setTimeout(() => finishTest(auto === 'sent'), 900);
});
bus.on('editor:publish', ({ boulder }) => {
  state.events.push('publish');
  state.lastPublish = boulder;
  console.log('[dev] editor:publish', boulder.name, `V${boulder.grade}`, 'author:', JSON.stringify(boulder.author));
});
bus.on('editor:close', () => {
  state.events.push('close');
  renderer.setCameraMode('title');
  reopen.classList.add('on');
});

document.getElementById('sent')?.addEventListener('click', () => finishTest(true));
document.getElementById('fell')?.addEventListener('click', () => finishTest(false));
reopen.addEventListener('click', () => {
  reopen.classList.remove('on');
  editor.open();
});

let initial: BoulderDef | undefined;
if (qs.has('sample')) initial = generateBoulder({ seed: Number(qs.get('seed') ?? 7), grade: Number(qs.get('sample')) });
editor.open(initial);

let last = performance.now();
const tick = (t: number): void => {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  editor.frame(dt);
  renderer.frame(dt);
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

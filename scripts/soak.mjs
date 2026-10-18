// Long-session soak: plays many Send Train boulders in a row, then cycles through every mode and
// menu, sampling GPU resources (renderer.info.memory), the JS heap (after a forced GC), DOM size,
// scene graph size and bus listeners. Resources that keep climbing with every boulder are leaks.
//
// usage: node scripts/soak.mjs [baseUrl] [--boulders 20] [--cycles 4] [--out dir] [--ts 4]
//   baseUrl: a dev server (see scripts/e2e.mjs). Sends use a QA shortcut (the sim respawns the
//   climber matched on the top hold), so a boulder takes seconds instead of a full bot climb.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5207';
const boulders = +opt('boulders', 20);
const cycles = +opt('cycles', 4);
const ts = +opt('ts', 4);
const out = opt('out', '/tmp/claude-0/shots/soak');
mkdirSync(out, { recursive: true });

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
  return cond;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
  ],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await context.addInitScript(() => {
  if (sessionStorage.getItem('soak-seeded')) return;
  sessionStorage.setItem('soak-seeded', '1');
  localStorage.clear();
  localStorage.setItem('jgu.profile.v1', JSON.stringify({ version: 1, playerName: 'Soak Ibex', introSeen: true, tutorialDone: true }));
  // count live window/document listeners (element listeners die with their elements)
  const add = EventTarget.prototype.addEventListener;
  const rem = EventTarget.prototype.removeEventListener;
  const live = new Set();
  const key = (t, a) => `${t === window ? 'w' : 'd'}:${a[0]}:${typeof a[2] === 'object' ? !!a[2]?.capture : !!a[2]}`;
  const ids = new WeakMap();
  let n = 0;
  const idOf = (fn) => (ids.has(fn) ? ids.get(fn) : (ids.set(fn, ++n), n));
  EventTarget.prototype.addEventListener = function (...a) {
    if ((this === window || this === document) && typeof a[1] === 'function') live.add(`${key(this, a)}:${idOf(a[1])}`);
    return add.apply(this, a);
  };
  EventTarget.prototype.removeEventListener = function (...a) {
    if ((this === window || this === document) && typeof a[1] === 'function') live.delete(`${key(this, a)}:${idOf(a[1])}`);
    return rem.apply(this, a);
  };
  Object.defineProperty(window, '__domListeners', { get: () => live.size });
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function waitFor(fn, what, timeout = 180000, arg) {
  const t = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - t > timeout) throw new Error(`timeout: ${what}`);
    await page.waitForTimeout(200);
  }
}
const waitScreen = (s, timeout) => waitFor((s) => document.getElementById('ui')?.dataset.screen === s, `screen ${s}`, timeout, s);
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil', 90000);
async function tap(sel) {
  await page.waitForSelector(sel, { state: 'visible', timeout: 90000 });
  await page.tap(sel);
}
async function tapText(text) {
  const loc = page.locator('#ui button', { hasText: text }).first();
  await loc.waitFor({ state: 'visible', timeout: 90000 });
  await loc.tap();
}

const samples = [];
async function sample(label) {
  const s = await page.evaluate(async () => {
    window.gc?.();
    await new Promise((r) => setTimeout(r, 50));
    window.gc?.();
    const j = window.__jgu;
    const info = j.renderer.gl.info;
    let objects = 0;
    j.renderer.scene.traverse(() => objects++);
    const bus = j.bus.handlers;
    let busListeners = 0;
    if (bus) for (const set of bus.values()) busListeners += set.size;
    return {
      geo: info.memory.geometries,
      tex: info.memory.textures,
      programs: info.programs?.length ?? 0,
      heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
      dom: document.getElementsByTagName('*').length,
      objects,
      busListeners,
      domListeners: window.__domListeners,
      // unlocked skins bring their own cached portrait/material textures (bounded by the catalogue)
      unlocked: Object.values(j.app.profile.unlocked).reduce((a, l) => a + l.length, 0),
    };
  });
  samples.push({ label, ...s });
  log(`${label.padEnd(22)} geo ${String(s.geo).padStart(4)}  tex ${String(s.tex).padStart(3)}  prog ${String(s.programs).padStart(3)}  heap ${String(s.heapMB).padStart(6)} MB  dom ${String(s.dom).padStart(5)}  obj ${String(s.objects).padStart(5)}  bus ${String(s.busListeners).padStart(3)}  domL ${s.domListeners}  unl ${s.unlocked}`);
  return s;
}

try {
  await page.goto(`${base}/?debug=1&q=low&ts=${ts}`, { waitUntil: 'load', timeout: 180000 });
  await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 240000);
  await tap('.splash-hit');
  await waitScreen('title', 120000);
  await veilClear();
  await page.waitForTimeout(1500);
  await sample('title');

  // ── Send Train: N boulders in a row ──
  await tap('.title-play');
  await waitScreen('modes');
  await tap('.mode-featured');
  for (let i = 1; i <= boulders; i++) {
    await waitScreen('preview', 240000);
    await veilClear();
    await tap('.pv-hit');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start');
    // QA shortcut: matched on the top hold → the real send path (celebration, results, scoring)
    await page.evaluate(() => {
      const sim = window.__jgu.sim;
      const top = sim.boulder.holds.filter((h) => h.role === 'top').sort((a, b) => b.y - a.y)[0];
      sim.respawn({ LH: top.id, RH: top.id });
    });
    await waitScreen('results', 240000);
    if (i === 1 || i === boulders) await page.screenshot({ path: `${out}/results-${String(i).padStart(2, '0')}.png`, timeout: 180000 });
    await sample(`send train #${String(i).padStart(2, '0')}`);
    if (i < boulders) await tapText('NEXT BOULDER');
  }
  await tapText('MENU');
  await waitScreen('modes', 120000);
  await veilClear();
  await tap('.btn-back');
  await waitScreen('title');
  await page.waitForTimeout(1000);
  await sample('after send train');

  // ── mode switching: every mode's preview, editor, menus ──
  for (let c = 1; c <= cycles; c++) {
    for (const mode of ['Lead Tower', 'Daily']) {
      await tap('.title-play');
      await waitScreen('modes');
      await page.locator('.mode-card', { hasText: mode }).first().tap();
      await waitScreen('preview', 240000);
      await veilClear();
      await tap('.pv-back');
      await waitScreen('modes', 120000);
      await veilClear();
      await tap('.btn-back');
      await waitScreen('title');
    }
    await tapText('COMMUNITY');
    await waitScreen('community');
    await waitFor(() => !document.querySelector('.skel-card'), 'community cards', 60000);
    await page.locator('#ui .cm-play, #ui .cm-card button').first().tap();
    await waitScreen('preview', 240000);
    await veilClear();
    await tap('.pv-back');
    await waitScreen('community', 120000);
    await veilClear();
    await tap('.btn-back');
    await waitScreen('title');
    await tapText('CREATE');
    await waitFor(() => window.__jgu.app.current === 'editor', 'editor', 60000);
    await page.waitForTimeout(1500);
    await tap('.ed-x');
    await waitFor(() => window.__jgu.app.current === 'menu', 'editor closed', 60000);
    await waitScreen('title');
    await veilClear();
    for (const scr of ['LOCKER', 'LEADERBOARD', 'PROFILE', 'SETTINGS']) {
      await tapText(scr);
      await page.waitForTimeout(600);
      await tap('.btn-back');
      await waitScreen('title');
    }
    await page.waitForTimeout(800);
    await sample(`mode cycle #${c}`);
  }
} catch (err) {
  ok(false, `soak aborted: ${err.message}`);
  await page.screenshot({ path: `${out}/aborted.png`, timeout: 180000 }).catch(() => undefined);
}

writeFileSync(`${out}/samples.json`, JSON.stringify(samples, null, 1));
// growth across the run: compare the 2nd Send Train sample with the last one (caches warm up first)
const trains = samples.filter((s) => s.label.startsWith('send train'));
if (trains.length >= 4) {
  const a = trains[1];
  const b = trains[trains.length - 1];
  const n = trains.length - 2;
  const per = (k) => ((b[k] - a[k]) / n).toFixed(2);
  log(`per-boulder growth over ${n} boulders: geo ${per('geo')}  tex ${per('tex')}  heap ${per('heapMB')} MB  dom ${per('dom')}  obj ${per('objects')}  bus ${per('busListeners')}  domL ${per('domListeners')}`);
  ok(b.tex - a.tex <= 2, `textures stay flat across boulders (${a.tex} → ${b.tex})`);
  ok(b.objects - a.objects <= 4, `scene graph stays flat across boulders (${a.objects} → ${b.objects})`);
  ok(b.busListeners - a.busListeners <= 2, `bus listeners stay flat across boulders (${a.busListeners} → ${b.busListeners})`);
  ok(b.heapMB - a.heapMB < 25, `JS heap stays bounded (${a.heapMB} → ${b.heapMB} MB)`);
  ok(b.geo <= 200, `GPU geometries stay bounded (${a.geo} → ${b.geo})`);
  ok(b.domListeners - a.domListeners <= 2, `window/document listeners stay flat across boulders (${a.domListeners} → ${b.domListeners})`);
}
const cyc = samples.filter((s) => s.label.startsWith('mode cycle'));
if (cyc.length >= 2) {
  const a = cyc[0];
  const b = cyc[cyc.length - 1];
  ok(b.tex - a.tex <= 2 && b.objects - a.objects <= 4, `mode switching stays flat (tex ${a.tex} → ${b.tex}, obj ${a.objects} → ${b.objects})`);
  ok(b.domListeners - a.domListeners <= 2, `window/document listeners stay flat across mode cycles (${a.domListeners} → ${b.domListeners})`);
}
const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
ok(relevant.length === 0, `no console errors${relevant.length ? ':\n  ' + relevant.slice(0, 10).join('\n  ') : ''}`);
log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
await browser.close();
process.exit(failures ? 1 : 0);

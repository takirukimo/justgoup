// Mobile lifecycle QA: the things a phone does to a web game mid-climb.
//
// usage: node scripts/lifecycle-check.mjs [baseUrl] [--out dir]   (a dev server, see scripts/e2e.mjs)
//   1. tab hidden (app switch / call) → the climb pauses, audio suspends, the profile is flushed
//   2. Android back button (history pop) → pause; back again → resume; on the title → leaves
//   3. WebGL context lost → "graphics paused" card, climb paused; restored → scene rebuilt
//   4. phone turned sideways → "turn upright" card, climb paused
//   5. long-press / iOS pinch gestures are cancelled outside text fields
//   6. editor: a hold placed right before the tab is hidden is in the saved draft (autosave flushed)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5207';
const out = opt('out', '/tmp/claude-0/shots/lifecycle');
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
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await context.addInitScript(() => {
  if (sessionStorage.getItem('lc-seeded')) return;
  sessionStorage.setItem('lc-seeded', '1');
  localStorage.clear();
  localStorage.setItem('jgu.profile.v1', JSON.stringify({ version: 1, playerName: 'Lifecycle Ibex', introSeen: true, tutorialDone: true }));
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function waitFor(fn, what, timeout = 120000, arg) {
  const t = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - t > timeout) {
      ok(false, `timed out waiting for ${what}`);
      throw new Error(`timeout: ${what}`);
    }
    await page.waitForTimeout(150);
  }
}
const screen = () => page.evaluate(() => document.getElementById('ui')?.dataset.screen ?? '');
const waitScreen = (s, timeout) => waitFor((s) => document.getElementById('ui')?.dataset.screen === s, `screen ${s}`, timeout, s);
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil to lift', 90000);
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
  log(`shot ${name}.png`);
};
async function tap(sel) {
  await page.waitForSelector(sel, { state: 'visible', timeout: 60000 });
  await page.tap(sel);
  log(`tap ${sel}`);
}
const climbing = () => page.evaluate(() => window.__jgu.sim?.getState().phase === 'climbing' && !window.__jgu.app.activeSession?.isPaused);
async function startClimb() {
  await tap('.title-play');
  await waitScreen('modes');
  await tap('.mode-featured');
  await waitScreen('preview', 180000);
  await veilClear();
  await tap('.pv-hit');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 90000);
  await waitScreen('hud');
}
const setHidden = (hidden) =>
  page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

try {
  await page.goto(`${base}/?debug=1&q=low&ts=3`, { waitUntil: 'load', timeout: 180000 });
  await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 240000);
  await tap('.splash-hit');
  await waitScreen('title', 120000);
  await veilClear();
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => window.__jgu.audio.isUnlocked), 'the splash tap unlocked audio');

  // ── 5. gestures ──
  const gestures = await page.evaluate(() => {
    const ev = (type) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      document.getElementById('gl').dispatchEvent(e);
      return e.defaultPrevented;
    };
    return { menu: ev('contextmenu'), pinch: ev('gesturestart') };
  });
  ok(gestures.menu && gestures.pinch, `long-press menu + iOS pinch cancelled on the game (${JSON.stringify(gestures)})`);

  // ── 1. hidden tab ──
  await startClimb();
  ok(await climbing(), 'climbing');
  await page.evaluate(() => {
    const p = window.__jgu.app.profile;
    p.stats.climbs = (p.stats.climbs ?? 0) + 1000; // a change only memory knows about
    window.__jgu.app.svc.save();
  });
  await setHidden(true);
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => ({
    screen: document.getElementById('ui').dataset.screen,
    paused: window.__jgu.app.activeSession?.isPaused,
    audio: window.__jgu.audio.context?.state,
    saved: JSON.parse(localStorage.getItem('jgu.profile.v1') ?? '{}').stats?.climbs >= 1000,
  }));
  ok(hidden.paused && hidden.screen === 'pause', `hidden tab pauses the climb (${JSON.stringify(hidden)})`);
  ok(hidden.audio !== 'running', `hidden tab suspends audio (${hidden.audio})`);
  ok(hidden.saved, 'hidden tab flushes the profile to storage immediately');
  await setHidden(false);
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => window.__jgu.audio.context?.state === 'running'), 'visible again: audio resumes');
  ok((await screen()) === 'pause', 'visible again: still paused until the player resumes');
  await shot('01-paused-after-hidden');

  // ── 2. back button ──
  await page.evaluate(() => history.back()); // pause sheet → resume
  await waitScreen('hud', 30000);
  ok(await climbing(), 'back on the pause sheet resumes the climb');
  await page.tap('.hud-hint').catch(() => undefined); // a tap re-arms the guard (user activation)
  await page.waitForTimeout(400);
  await page.evaluate(() => history.back()); // climbing → pause
  await waitScreen('pause', 30000);
  ok(true, 'back while climbing opens the pause sheet');
  await shot('02-back-pauses');

  // ── 3. WebGL context loss ──
  await page.tap('#ui .pause-resume, #ui button:has-text("RESUME")').catch(() => undefined);
  await waitScreen('hud', 30000);
  await page.evaluate(() => {
    window.__lose = window.__jgu.renderer.gl.getContext().getExtension('WEBGL_lose_context');
    window.__lose.loseContext();
  });
  await waitFor(() => !!document.querySelector('.jga-lost.on'), 'graphics paused card', 30000);
  const lost = await page.evaluate(() => ({ paused: window.__jgu.app.activeSession?.isPaused, lost: window.__jgu.renderer.contextLost }));
  ok(lost.paused && lost.lost, `context loss pauses the climb behind the "graphics paused" card (${JSON.stringify(lost)})`);
  await page.waitForTimeout(800);
  await shot('03-context-lost');
  await page.evaluate(() => window.__lose.restoreContext());
  await waitFor(() => !document.querySelector('.jga-lost') || document.querySelector('.jga-lost').hidden, 'card hidden after restore', 60000);
  const f0 = await page.evaluate(() => window.__jgu.frames);
  await waitFor((f0) => window.__jgu.frames > f0 + 3, 'frames after restore', 120000, f0);
  await page.waitForTimeout(1500);
  const restored = await page.evaluate(() => {
    const r = window.__jgu.renderer;
    return { lost: r.contextLost, calls: r.stats().calls, env: !!r.scene.environment };
  });
  ok(!restored.lost && restored.calls > 10 && restored.env, `restored: the scene renders again (${JSON.stringify(restored)})`);
  await shot('04-context-restored');

  // ── 4. sideways ──
  await page.tap('#ui button:has-text("RESUME")').catch(() => undefined);
  await waitScreen('hud', 30000).catch(() => undefined);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(800);
  const side = await page.evaluate(() => ({
    card: getComputedStyle(document.getElementById('rotate')).display !== 'none',
    paused: window.__jgu.app.activeSession?.isPaused,
  }));
  ok(side.card && side.paused, `sideways phone: "turn upright" card + paused (${JSON.stringify(side)})`);
  await shot('05-sideways');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display === 'none'), 'upright again: card gone');

  // back from the pause sheet's QUIT path to the title, then back on the title leaves the game
  await page.locator('#ui button', { hasText: 'QUIT' }).first().tap();
  await waitScreen('modes', 90000);
  await veilClear();
  await page.tap('.btn-back');
  await waitScreen('title', 30000);
  await page.waitForTimeout(400);
  const len = await page.evaluate(() => history.length);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(800);
  ok((await screen()) === 'title' && (await page.evaluate(() => window.__jgu.app.current)) === 'menu', `back on the title is not swallowed by the game (history ${len})`);

  // ── 6. editor draft survives an app switch right after an edit ──
  await page.locator('#ui button', { hasText: 'CREATE' }).first().tap();
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor', 60000);
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => window.__jgu.editor.getDraft().holds.length);
  // tap the wall and hide the tab in the same task: the 300 ms debounced autosave has not run yet
  const saved = await page.evaluate(() => {
    const r = window.__jgu.renderer;
    const p = r.wallToScreen({ x: 0.9, y: 1.7 });
    const rect = r.canvas.getBoundingClientRect();
    const s = document.querySelector('.ed-surface');
    const at = { clientX: p.x + rect.left, clientY: p.y + rect.top, pointerId: 7, pointerType: 'touch', bubbles: true, isPrimary: true };
    s.dispatchEvent(new PointerEvent('pointerdown', at));
    s.dispatchEvent(new PointerEvent('pointerup', at));
    const n = window.__jgu.editor.getDraft().holds.length;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const stored = JSON.parse(localStorage.getItem('jgu.editor.draft') ?? 'null');
    return { n, stored: stored?.draft?.holds?.length ?? -1 };
  });
  ok(saved.n === before + 1 && saved.stored === saved.n, `a hold placed just before the app switch is in the saved draft (${before} → ${saved.n}, stored ${saved.stored})`);
  await setHidden(false);
  await page.waitForTimeout(500);
  // Steini's first-visit editor tip sits over the top bar: tap it away, then close the editor
  for (let k = 0; k < 4 && (await page.$('.guide-layer.on')); k++) {
    await page.tap('.gb-card').catch(() => undefined);
    await page.waitForTimeout(700);
  }
  await page.tap('.ed-x');
  await waitFor(() => window.__jgu.app.current === 'menu', 'editor closed', 60000);
} catch (err) {
  ok(false, `lifecycle run aborted: ${err.message}`);
  await shot('aborted').catch(() => undefined);
}

const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
ok(relevant.length === 0, `no console errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
await browser.close();
process.exit(failures ? 1 : 0);

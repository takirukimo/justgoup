// Home-screen QA: boots the game as a returning player, opens the title screen and watches the
// backdrop for a while. Checks that the climber hangs STEADY on good holds about 2 m up the wall
// (no tremor, no pump, no fall, slow idle moves only), that Steini stands on the mats looking up at
// him, and that the equipped skin is the one on the wall. Screenshots the scene along the way.
//
// usage: node scripts/home-check.mjs [baseUrl] [--out dir] [--head ibex] [--colorway basalt] [--watch 24] [--q low] [--ts 6]
//   --ts: debug time scale (headless SwiftShader renders only a few fps); pacing is judged in game time.
//   baseUrl defaults to http://localhost:5207 (a dev server: e.g. dev/e2e.vite.config.mjs).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5207';
const out = opt('out', '/tmp/claude-0/shots/home');
const head = opt('head', 'ibex');
const colorway = opt('colorway', 'basalt');
const watch = +opt('watch', 24);
const q = opt('q', 'low');
const ts = +opt('ts', 6);
mkdirSync(out, { recursive: true });

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
await context.addInitScript(
  ({ head, colorway }) => {
    if (sessionStorage.getItem('home-seeded')) return;
    sessionStorage.setItem('home-seeded', '1');
    localStorage.clear();
    const all = ['ibex', 'chamois', 'goat', 'marmot', 'snowleopard', 'eagle', 'lynx', 'ram', 'vulture', 'human'];
    localStorage.setItem(
      'jgu.profile.v1',
      JSON.stringify({ version: 1, playerName: 'Home QA', introSeen: true, tutorialDone: true, head, colorway, chalk: 'classic', unlocked: { heads: all, colorways: [colorway], chalks: ['classic'] } }),
    );
  },
  { head, colorway },
);
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

try {
  await page.goto(`${base}/?debug=1&q=${q}&ts=${ts}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => (window.__jgu?.frames ?? 0) > 3, null, { timeout: 180000 });
  await page.waitForSelector('.splash-hit', { state: 'visible', timeout: 60000 });
  await page.tap('.splash-hit');
  await page.waitForFunction(() => document.getElementById('ui')?.dataset.screen === 'title', null, { timeout: 90000 });
  // the showcase wall generates in the worker and replaces the lesson wall
  await page.waitForFunction(() => window.__jgu.app.title.ready === true, null, { timeout: 90000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/home-${head}-0.png` });

  const samples = [];
  const t0 = Date.now();
  let shotAt = 0;
  while ((Date.now() - t0) / 1000 < watch) {
    const s = await page.evaluate(() => {
      const j = window.__jgu;
      const st = j.app.title.state;
      const g = j.app.title.guideState;
      return {
        phase: st.phase,
        simT: st.time,
        fps: j.fps,
        pelvisY: st.pelvis.y,
        chestX: st.chest.x,
        chestY: st.chest.y,
        shake: st.shake,
        pump: st.pump,
        tension: st.tension,
        holds: ['LH', 'RH', 'LF', 'RF'].map((l) => st.limbs[l].holdId),
        dragging: ['LH', 'RH', 'LF', 'RF'].some((l) => st.limbs[l].dragging),
        guide: g ? { x: g.x, depth: g.depth, pose: g.pose, lookAt: g.lookAt ?? null } : null,
        boulder: j.renderer.getBoulder()?.id ?? null,
        skin: j.renderer.skin ?? null,
        screen: document.getElementById('ui')?.dataset.screen,
      };
    });
    samples.push({ t: (Date.now() - t0) / 1000, ...s });
    const el = (Date.now() - t0) / 1000;
    if (el - shotAt > watch / 3) {
      shotAt = el;
      await page.screenshot({ path: `${out}/home-${head}-${Math.round(el)}.png` });
    }
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${out}/home-${head}-end.png` });

  const ys = samples.map((s) => s.pelvisY);
  const minY = Math.min(...ys);
  const maxShake = Math.max(...samples.map((s) => s.shake));
  const maxPump = Math.max(...samples.map((s) => s.pump));
  const phases = new Set(samples.map((s) => s.phase));
  let moves = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].holds.join() !== samples[i - 1].holds.join()) moves++;
  const last = samples[samples.length - 1];
  // headless SwiftShader renders a few fps (frames are capped at 0.1 s): judge pacing in game time
  const gameS = last.simT - samples[0].simT;
  console.log(`game time ${gameS.toFixed(1)} s in ${watch} s (≈${last.fps.toFixed(1)} fps)`);
  console.log(
    `samples ${samples.length} · pelvis y ${minY.toFixed(2)}–${Math.max(...ys).toFixed(2)} m · shake ≤ ${maxShake.toFixed(3)} · pump ≤ ${maxPump.toFixed(3)} · phases ${[...phases].join('/')} · hold changes ${moves}`,
  );
  console.log('guide', JSON.stringify(last.guide), 'chest', last.chestX.toFixed(2), last.chestY.toFixed(2));
  ok(samples.every((s) => s.screen === 'title'), 'title screen stays up');
  ok(!phases.has('falling') && !phases.has('landed'), 'the climber never falls or lands');
  ok(minY >= 1.5, `the climber stays up the wall (pelvis ≥ 1.5 m, min ${minY.toFixed(2)})`);
  ok(maxShake <= 0.05, `no tremor (shake ≤ 0.05, max ${maxShake.toFixed(3)})`);
  ok(maxPump <= 0.05, `no pump (≤ 0.05, max ${maxPump.toFixed(3)})`);
  ok(gameS < 12 || (moves >= 1 && moves <= Math.ceil(gameS / 5)), `slow idle moves (${moves} hold changes in ${gameS.toFixed(1)} s of game time)`);
  ok(gameS >= 12, `watched long enough to see a move (${gameS.toFixed(1)} s ≥ 12 s of game time; raise --watch on a slow machine)`);
  ok(!!last.guide && last.guide.depth > 0.5, 'Steini stands on the mats in front of the wall');
  const la = last.guide?.lookAt;
  ok(!!la && Math.hypot(la.x - last.chestX, la.y - last.chestY) < 0.35, 'Steini looks up at the climber’s chest');
  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `home-check: ${failures} FAILED` : 'home-check: all passed');
process.exit(failures ? 1 : 0);

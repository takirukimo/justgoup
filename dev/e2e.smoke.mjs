// Smoke test for a built game served statically (dist/ or dist-single/): boots the page like a
// first-time player, walks splash → intro → name → tutorial skip → title → Send Train → climb start,
// and fails on any console error. No dev-server modules are needed (only window.__jgu via ?debug=1).
//
// usage: node dev/e2e.smoke.mjs http://localhost:5217/ [--out /tmp/claude-0/shots/integration/smoke]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5217/';
const oi = args.indexOf('--out');
const out = oi >= 0 ? args[oi + 1] : '/tmp/claude-0/shots/integration/smoke';
mkdirSync(out, { recursive: true });

let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const screen = (s) => page.waitForFunction((s) => document.getElementById('ui')?.dataset.screen === s, s, { timeout: 120000 });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });

try {
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}debug=1&q=low&ts=3`);
  await page.waitForFunction(() => (window.__jgu?.frames ?? 0) > 3, null, { timeout: 180000 });
  ok(!(await page.$('#boot')), 'boot overlay removed');
  await shot('01-splash');
  await page.tap('.splash-hit');
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 90000 });
  await page.tap('.gb-skip');
  await screen('name');
  await page.fill('.name-input', 'Smoke Ibex');
  await page.locator('#ui button', { hasText: 'CONTINUE' }).first().tap();
  await page.waitForFunction(() => window.__jgu.app.current === 'tutorial', null, { timeout: 60000 });
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 90000 });
  await page.tap('.gb-skip');
  await screen('title');
  await page.waitForTimeout(1500);
  await shot('02-title');
  ok(true, 'onboarding reaches the title');
  await page.tap('.title-play');
  await screen('modes');
  await page.tap('.mode-featured');
  await screen('preview');
  await page.waitForFunction(() => !document.querySelector('.jga-veil.on'), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await shot('03-preview');
  ok((await page.evaluate(() => window.__jgu.sim?.boulder.holds.length ?? 0)) > 8, 'Send Train generated a boulder (worker)');
  await page.tap('.pv-hit');
  await page.waitForFunction(() => window.__jgu.sim?.getState().phase === 'climbing', null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await shot('04-climbing');
  ok(true, 'climb started');
} catch (err) {
  ok(false, `flow: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  await shot('99-failure').catch(() => undefined);
}
const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|net::ERR_/.test(e));
ok(relevant.length === 0, `no console errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'SMOKE PASSED');
process.exit(failures ? 1 : 0);

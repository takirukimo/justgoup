// Screenshot helper for visual QA.
// usage: node scripts/shot.mjs <url> <out.png> [--w 390] [--h 844] [--wait 2500] [--dpr 2] [--eval "js"] [--console]
// Uses the pre-installed Chromium with SwiftShader WebGL so Three.js renders headlessly.
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1] ?? 'shot.png';
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const w = +opt('w', 390), h = +opt('h', 844), wait = +opt('wait', 2500), dpr = +opt('dpr', 2);
const evalJs = opt('eval', null);
const showConsole = args.includes('--console');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForTimeout(wait);
if (evalJs) {
  await page.evaluate(evalJs);
  await page.waitForTimeout(+opt('after', 1200));
}
await page.screenshot({ path: out, timeout: 180000 });
if (showConsole || logs.some((l) => l.includes('error'))) console.log(logs.join('\n'));
await browser.close();
console.log('saved', out);

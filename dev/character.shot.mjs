// CHARACTER QA screenshots (like scripts/shot.mjs, plus long timeouts and multi-shot timelines).
// usage: node dev/character.shot.mjs <url> <out.png> [--w 390] [--h 844] [--wait 3000] [--dpr 2]
//        [--timeout 120000] [--console] [--eval "js"] [--after ms]
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1] ?? 'shot.png';
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const w = +opt('w', 390), h = +opt('h', 844), wait = +opt('wait', 3000), dpr = +opt('dpr', 2), timeout = +opt('timeout', 120000);
const evalJs = opt('eval', null);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
page.setDefaultTimeout(timeout);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout });
await page.waitForTimeout(wait);
if (evalJs) {
  await page.evaluate(evalJs);
  await page.waitForTimeout(+opt('after', 1200));
}
await page.screenshot({ path: out, timeout });
if (args.includes('--console')) console.log(logs.join('\n'));
await browser.close();
console.log('saved', out, ((Date.now() - t0) / 1000).toFixed(1) + 's');

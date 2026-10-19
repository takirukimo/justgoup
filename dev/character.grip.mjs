// CHARACTER QA: hands and feet on every hold type, close up — one browser, many shots.
// usage: node dev/character.grip.mjs <outdir> [--port 5482] [--kinds jug,edge] [--limbs hand,foot]
//        [--cams close,side] [--angle 5] [--w 390] [--h 520] [--prefix ""]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = args[0] ?? '/tmp/grip';
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
fs.mkdirSync(out, { recursive: true });
const port = opt('port', '5482');
const w = +opt('w', 390), h = +opt('h', 520);
const prefix = opt('prefix', '');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: +opt('dpr', 1) });
page.setDefaultTimeout(240000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/dev/character.html?view=grip&hud=1`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction(() => !!window.__grip, null, { timeout: 240000 });
const all = await page.evaluate(() => window.__grip.kinds);
const kinds = opt('kinds', '') ? opt('kinds', '').split(',') : all;
const limbs = opt('limbs', 'hand,foot').split(',');
const cams = opt('cams', 'close').split(',');
const angle = +opt('angle', 5);
const handOnly = new Set(['bucket', 'rail', 'micro', 'macro', 'pinch', 'horn', 'pocket1', 'pocket2', 'pocket3', 'roof', 'wood', 'dual']);
for (const k of kinds) {
  for (const l of limbs) {
    if (l === 'foot' && handOnly.has(k) && !opt('kinds', '')) continue;
    for (const c of cams) {
      const info = await page.evaluate(([k, l, c, a]) => window.__grip.show(k, l, c, a), [k, l, c, angle]);
      await page.waitForTimeout(700);
      const f = `${out}/${prefix}${k}-${l}-${c}.png`;
      await page.screenshot({ path: f });
      console.log(f, '|', info);
    }
  }
}
if (logs.some((x) => x.includes('error'))) console.log(logs.filter((x) => x.includes('error')).join('\n'));
await browser.close();

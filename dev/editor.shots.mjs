// EDITOR screenshot steps: node dev/editor.shots.mjs <url> <outprefix> [steps json] (steps: {eval,tap,tapxy,wait,shot})
import { chromium } from 'playwright-core';
const [url, out, stepsJson] = process.argv.slice(2);
const steps = stepsJson ? JSON.parse(stepsJson) : [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.VW || 390), height: Number(process.env.VH || 844) }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
page.setDefaultTimeout(120000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
try {
  await page.waitForFunction(() => !!window.__ed && !!document.querySelector('.ed'), null, { timeout: 60000 });
} catch (e) {
  console.log(logs.join('\n'));
  await browser.close();
  throw e;
}
await page.evaluate(() => window.__ed.renderer.setCameraMode('editor', { instant: true }));
await page.waitForTimeout(2500);
let i = 0;
for (const s of steps) {
  if (s.eval) { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval:', JSON.stringify(r)); }
  if (s.tap) { const b = await page.locator(s.tap).first().boundingBox(); if (b) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); else console.log('no', s.tap); }
  if (s.tapxy) await page.touchscreen.tap(s.tapxy[0], s.tapxy[1]);
  await page.waitForTimeout(s.wait ?? 1500);
  if (s.shot) { await page.screenshot({ path: `${out}-${s.shot}.png`, timeout: 120000 }); console.log('shot', `${out}-${s.shot}.png`); }
}
if (!steps.length) await page.screenshot({ path: `${out}.png` });
const errs = logs.filter((l) => /error/i.test(l));
if (errs.length) console.log(errs.join('\n'));
await browser.close();

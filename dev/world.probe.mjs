// WORLD dev: print the generated problem (style, profile, hold shapes) for world harness URLs.
// usage: node dev/world.probe.mjs "<world.html url>" ...
import { chromium } from 'playwright-core';
const urls = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
for (const u of urls) {
  await page.goto(u, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__b, null, { timeout: 60000 });
  const r = await page.evaluate(() => ({ style: window.__b.style, angle: window.__b.wallAngle, h: window.__b.height, profile: window.__b.profile, shapes: window.__b.holds.reduce((m, h) => { const k = h.shape || h.type; m[k] = (m[k] || 0) + 1; return m; }, {}), onVol: window.__b.holds.filter(h => h.onVolume).length }));
  console.log(u.split('?')[1], JSON.stringify(r));
}
await browser.close();

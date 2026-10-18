// CHARACTER QA (not shipped): triangle / draw-call share of the climber, Steini and the rope in the
// real game scene. usage: node dev/character.tris.mjs [baseUrl]
import { chromium } from 'playwright-core';
const base = process.argv[2] ?? 'http://127.0.0.1:5401';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`${base}/?debug=1&q=high`, { waitUntil: 'load', timeout: 180000 });
for (let i = 0; i < 400 && !(await page.evaluate(() => (window.__jgu?.frames ?? 0) > 3)); i++) await page.waitForTimeout(300);
const r = await page.evaluate(() => {
  const R = window.__jgu.renderer;
  const count = (o) => {
    let tris = 0;
    let meshes = 0;
    o?.traverse((m) => {
      if (!m.isMesh || !m.visible) return;
      meshes++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    return { tris: Math.round(tris), meshes };
  };
  const out = { climber: count(R.climber), guide: count(R.guide), rope: count(R.rope) };
  for (const k of ['body', 'harness']) out['climber.' + k] = count(R.climber?.rig[k === 'body' ? 'mesh' : 'harness']);
  const head = R.climber?.rig.bones[3].children[0];
  out['climber.head'] = count(head);
  return out;
});
console.log(JSON.stringify(r));
await browser.close();

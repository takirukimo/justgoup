import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5401/dev/character.html?view=heads&t=1', { waitUntil: 'load', timeout: 180000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async () => {
  const { ClimberModel } = await import('/src/render/climber.ts');
  const out = {};
  for (const id of ['ibex', 'human', 'ram', 'goat']) {
    const m = new ClimberModel({ head: id });
    const H = m.rig.headLocal;
    const n = m.rig.headN;
    out[id] = [];
    for (let j = 0; j < n; j++) out[id].push([0, 1, 2, 3, 4, 5, 6].map((k) => +H[j * 8 + k].toFixed(3)));
  }
  return out;
});
console.log(JSON.stringify(r, null, 0).replace(/\],\[/g, '],\n ['));
await browser.close();

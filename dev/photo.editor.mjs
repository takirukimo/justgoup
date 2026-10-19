// PHOTO import inside the editor (the real importer, no stand-in): dev/editor.html → IMPORT FROM PHOTO →
// a generated wall photo through the file input → corners → a tap on the route colour (found in the
// canvas pixels) → holds → start / top → wall → the editor loads the problem as its draft.
// usage: node dev/photo.editor.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5472';
const outDir = process.argv[3] || '/tmp/claude-0/shots/photo';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
page.setDefaultTimeout(120000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
let ok = true;
const check = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`);
  if (!c) ok = false;
};
const shot = async (n) => {
  await page.screenshot({ path: `${outDir}/editor-${n}.png` });
  console.log('shot', `${outDir}/editor-${n}.png`);
};
const tapSel = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};

// a generated photo and its true wall corners, from the photo harness
await page.goto(`${base}/dev/photo.html`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__photo, null, { timeout: 90000 });
const sample = await page.evaluate(async () => {
  const url = await window.__photo.samplePng(1);
  const s = window.__photo.synth;
  return { url, quad: s.quad, w: s.photo.width, h: s.photo.height };
});

await page.goto(`${base}/dev/editor.html?fresh=1&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__ed && !!document.querySelector('.ed'), null, { timeout: 90000 });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('.ed-photo-go').click());
await page.waitForSelector('.ph', { timeout: 30000 });
await page.waitForTimeout(800);
await shot('01-import-open');
await page.setInputFiles('.ph-file >> nth=1', { name: 'wall.png', mimeType: 'image/png', buffer: Buffer.from(sample.url.split(',')[1], 'base64') });
await page.waitForFunction(() => document.querySelector('.ph')?.dataset.step === 'frame');
await page.waitForTimeout(500);

// corners: the FRAME view fits the photo into the stage (28 px padding), centred
const st = await page.locator('.ph-stage').boundingBox();
const fit = Math.min((st.width - 56) / sample.w, (st.height - 56) / sample.h);
const toScr = (p) => ({ x: st.x + st.width / 2 + (p.x - sample.w / 2) * fit, y: st.y + st.height / 2 + (p.y - sample.h / 2) * fit });
for (let i = 0; i < 4; i++) {
  const b = await page.locator('.ph-corner').nth(i).boundingBox();
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const to = toScr(sample.quad[i]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 6, from.y + ((to.y - from.y) * k) / 6);
  await page.mouse.up();
}
await tapSel('.ph-next');
await page.waitForFunction(() => document.querySelector('.ph')?.dataset.step === 'color');
await page.waitForTimeout(800);

// the user taps a yellow hold: the most yellow blob in the canvas
const tap = await page.evaluate(() => {
  const c = document.querySelector('.ph-canvas');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let best = null;
  let bs = 0;
  for (let y = 4; y < c.height - 4; y += 3) {
    for (let x = 4; x < c.width - 4; x += 3) {
      // score a 7×7 neighbourhood of strongly yellow pixels
      let s = 0;
      for (let j = -3; j <= 3; j += 3) for (let i = -3; i <= 3; i += 3) {
        const o = ((y + j) * c.width + x + i) * 4;
        if (d[o] > 170 && d[o + 1] > 120 && d[o + 2] < 90) s++;
      }
      if (s > bs) {
        bs = s;
        best = { x, y };
      }
    }
  }
  const r = c.getBoundingClientRect();
  return best && { x: r.left + best.x / (c.width / r.width), y: r.top + best.y / (c.height / r.height) };
});
check(!!tap, 'found a yellow hold to tap');
await page.touchscreen.tap(tap.x, tap.y);
await page.waitForTimeout(1500);
await tapSel('.ph-next');
await page.waitForFunction(() => document.querySelector('.ph')?.dataset.step === 'holds');
await page.waitForFunction(() => !document.querySelector('.ph').classList.contains('is-detecting') && /holds? found/i.test(document.querySelector('.ph-title')?.textContent ?? ''), null, { timeout: 60000 });
await page.waitForTimeout(500);
const title = await page.evaluate(() => document.querySelector('.ph-title').textContent);
check(/^(1[4-9]|2\d) holds found/i.test(title), `holds found in the editor's importer (${title})`);
await shot('02-holds');
await tapSel('.ph-next');
await page.waitForFunction(() => document.querySelector('.ph')?.dataset.step === 'roles');
await page.waitForTimeout(400);
await tapSel('.ph-next');
await page.waitForFunction(() => document.querySelector('.ph')?.dataset.step === 'wall');
await page.waitForTimeout(3000);
await shot('03-wall');
await tapSel('.ph-make');
await page.waitForFunction(() => !document.querySelector('.ph'), null, { timeout: 30000 });
await page.waitForTimeout(2500);
const draft = await page.evaluate(() => {
  const d = window.__ed.editor['draft'];
  return { name: d.name, holds: d.holds.length, starts: d.holds.filter((h) => h.role === 'start').length, tops: d.holds.filter((h) => h.role === 'top').length, color: d.color, wallAngle: d.wallAngle, profile: d.profile?.length ?? 0 };
});
console.log('draft', JSON.stringify(draft));
check(draft.name === 'Yellow Snapshot' && draft.holds >= 14 && draft.starts >= 1 && draft.tops === 1 && draft.color === '#F2C230', 'the editor loads the photo problem as its draft');
const toast = await page.evaluate(() => [...document.querySelectorAll('.ed-toast, .toast, [class*="toast"]')].map((e) => e.textContent).join(' | '));
console.log('toast:', toast.slice(0, 200));
const status = await page.evaluate(() => document.querySelector('.ed-status, .ed-chip-status, [class*="status"]')?.textContent ?? '');
console.log('status:', status.slice(0, 120));
await shot('04-draft');
// cancel path: open again and back out
await page.evaluate(() => document.querySelector('.ed-photo-go').click());
await page.waitForTimeout(500);
// the editor asks before replacing a draft that has holds
if (await page.locator('.modal-card').count()) {
  await tapSel('.modal-actions .btn-primary');
  await page.waitForTimeout(400);
}
await page.waitForSelector('.ph', { timeout: 30000 });
await page.waitForTimeout(400);
await tapSel('.ph-close');
await page.waitForFunction(() => !document.querySelector('.ph'), null, { timeout: 30000 });
await page.waitForTimeout(800);
const after = await page.evaluate(() => window.__ed.editor['draft'].holds.length);
check(after === draft.holds, `backing out keeps the draft (${after} holds)`);
const errs = logs.filter((l) => /pageerror|\[error\]/i.test(l) && !/favicon|fonts\.g|404/i.test(l));
check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' / ') : ''}`);
await browser.close();
console.log(ok ? 'PHOTO IN EDITOR: ALL PASSED' : 'PHOTO IN EDITOR: FAILED');
process.exit(ok ? 0 : 1);

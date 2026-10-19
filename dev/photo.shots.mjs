// PHOTO importer walkthrough with screenshots of every step (headless Chromium, 390×844 by default).
// usage: node dev/photo.shots.mjs [baseUrl] [outDir]   (VW / VH env: viewport; SAMPLE=1..4; CLAUDE=mock|deny|bad|busy)
// The photo goes in through the real file input; corners are dragged onto the generated photo's true
// wall corners; the colour tap, hold edits, Claude (stand-in), start / top and the wall pick are real taps.
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5472';
const outDir = process.argv[3] || '/tmp/claude-0/shots/photo';
const VW = Number(process.env.VW || 390);
const VH = Number(process.env.VH || 844);
const SAMPLE = Number(process.env.SAMPLE || 1);
const CLAUDE = process.env.CLAUDE || 'mock';
const tag = `${VW}x${VH}-s${SAMPLE}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
page.setDefaultTimeout(120000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('crash', () => console.log('PAGE CRASHED\n' + logs.slice(-20).join('\n')));
page.on('close', () => console.log('page closed'));
const fail = async (msg) => {
  console.log('FAIL:', msg);
  console.log(logs.slice(-30).join('\n'));
  await page.screenshot({ path: `${outDir}/${tag}-FAIL.png` });
  await browser.close();
  process.exit(1);
};
const shot = async (name) => {
  const p = `${outDir}/${tag}-${name}.png`;
  await page.screenshot({ path: p });
  console.log('shot', p);
};
const tapSel = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) return fail(`no ${sel}`);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
const step = () => page.evaluate(() => document.querySelector('.ph')?.dataset.step ?? null);
const waitStep = async (s) => {
  try {
    await page.waitForFunction((x) => document.querySelector('.ph')?.dataset.step === x, s, { timeout: 60000 });
  } catch {
    await fail(`step ${s} (at ${await step()})`);
  }
};

await page.goto(`${base}/dev/photo.html?claude=${CLAUDE}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!window.__photo, null, { timeout: 90000 });
await page.waitForTimeout(1200);

// 1 · PHOTO
await tapSel('#dev .go');
await waitStep('photo');
await page.waitForTimeout(700);
await shot('01-photo');

// the sample photo goes in through the real file input
const dataUrl = await page.evaluate((n) => window.__photo.samplePng(n), SAMPLE);
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
await page.setInputFiles('.ph-file >> nth=1', { name: 'wall.png', mimeType: 'image/png', buffer: buf });
await waitStep('frame');
await page.waitForTimeout(600);
await shot('02-frame');

// 2 · FRAME: drag each corner onto the wall's true corner (the loupe shows while dragging)
const target = await page.evaluate(() => window.__photo.trueCorners());
for (let i = 0; i < 4; i++) {
  const b = await page.locator('.ph-corner').nth(i).boundingBox();
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const n = 8;
  for (let k = 1; k <= n; k++) await page.mouse.move(from.x + ((target[i].x - from.x) * k) / n, from.y + ((target[i].y - from.y) * k) / n);
  if (i === 3) {
    await page.waitForTimeout(150);
    await shot('03-frame-loupe');
  }
  await page.mouse.up();
}
await page.waitForTimeout(300);
await shot('04-frame-set');

// 3 · COLOUR
await tapSel('.ph-next');
await waitStep('color');
await page.waitForTimeout(600);
await shot('05-colour');
const h0 = await page.evaluate(() => window.__photo.holdScreen(0));
await page.touchscreen.tap(h0.x, h0.y);
await page.waitForTimeout(450);
await shot('06-colour-loupe');
const sw = await page.evaluate(() => window.__photo.importer.swatches.map((s) => s.hex));
console.log('swatches', sw.join(' '));
if (!sw.length) await fail('no colour sample');

// 4 · HOLDS
await page.waitForTimeout(1200);
await tapSel('.ph-next');
await waitStep('holds');
await page.waitForFunction(() => !document.querySelector('.ph').classList.contains('is-detecting') && window.__photo.importer.holds.length > 0, null, { timeout: 60000 });
await page.waitForTimeout(500);
const found = await page.evaluate(() => ({ n: window.__photo.importer.included().length, truth: window.__photo.synth.holds.filter((h) => h.route).length }));
console.log('holds', found.n, 'truth', found.truth, 'detect ms', await page.evaluate(() => Math.round(window.__photo.importer['detected'].ms)), 'threaded', await page.evaluate(() => window.__photo.importer['engine'].threaded));
await shot('07-holds');
// drop one hold, add one on blank wall
const h3 = await page.evaluate(() => window.__photo.holdScreen(3));
await page.touchscreen.tap(h3.x, h3.y);
await page.waitForTimeout(400);
const stageBox = await page.locator('.ph-stage').boundingBox();
await page.touchscreen.tap(stageBox.x + stageBox.width * 0.12, stageBox.y + stageBox.height * 0.18);
await page.waitForTimeout(700);
const edited = await page.evaluate(() => window.__photo.importer.included().length);
console.log('after edits', edited);
await shot('08-holds-edit');

// Enhance with Claude (stand-in answering from the generated truth)
if (await page.locator('.ph-claude-go').count()) {
  await tapSel('.ph-claude-go');
  await page.waitForTimeout(500);
  await shot('09-claude-asking');
  await page.waitForFunction(() => !!document.querySelector('.ph-claude-h') || !!document.querySelector('.ph-note.bad'), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  console.log('claude', await page.evaluate(() => ({ mode: window.__photo.importer.visionMode, n: window.__photo.importer.included().length, note: document.querySelector('.ph-note')?.textContent ?? '' })));
  await shot('10-claude');
} else console.log('no Claude button');

// 5 · START / TOP
await tapSel('.ph-next');
await waitStep('roles');
await page.waitForTimeout(500);
await shot('11-roles');

// 6 · WALL (3D preview)
await tapSel('.ph-next');
await waitStep('wall');
await page.waitForTimeout(3500);
await shot('12-wall');
await page.locator('.ph-wall').nth(10).scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await tapSel('.ph-wall >> nth=10');
await page.waitForTimeout(3000);
await shot('13-wall-cave');

await tapSel('.ph-make');
await page.waitForFunction(() => window.__photo.result !== undefined, null, { timeout: 30000 });
await page.waitForTimeout(3000);
const res = await page.evaluate(() => {
  const b = window.__photo.result;
  return b && { name: b.name, holds: b.holds.length, wallAngle: b.wallAngle, profile: b.profile?.length ?? 0, height: b.height, roles: b.holds.map((h) => h.role).join(','), types: [...new Set(b.holds.map((h) => h.type))].join(',') };
});
console.log('result', JSON.stringify(res));
await shot('14-result');
const errs = logs.filter((l) => /error/i.test(l) && !/favicon|fonts\.g/i.test(l));
if (errs.length) console.log(errs.join('\n'));
await browser.close();
console.log(res ? 'PHOTO WALKTHROUGH: PASS' : 'PHOTO WALKTHROUGH: no result');

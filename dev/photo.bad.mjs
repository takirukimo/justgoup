// PHOTO importer on bad input (headless Chromium, 390×844): files that aren't photos, a HEIC the browser
// can't open, a thumbnail, a small photo, a colour tap on the wall itself, a colour that matches one hold,
// a sit start, a wall with no beta, and Claude declining. Every step must say what's wrong and offer a way
// on (never a dead end). Screenshots of each message.
// usage: node dev/photo.bad.mjs [baseUrl] [outDir]   (CLAUDE=deny|busy|bad, default deny; VW / VH: viewport)
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5472';
const outDir = process.argv[3] || '/tmp/claude-0/shots/photo';
const CLAUDE = process.env.CLAUDE || 'deny';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const VW = Number(process.env.VW || 390);
const VH = Number(process.env.VH || 844);
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
page.setDefaultTimeout(60000);
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
let ok = true;
const check = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`);
  if (!c) ok = false;
};
const shot = async (n) => {
  const p = `${outDir}/bad-${VW}x${VH}-${n}.png`;
  await page.screenshot({ path: p });
  console.log('shot', p);
};
const tapSel = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no ${sel}`);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
const step = () => page.evaluate(() => document.querySelector('.ph')?.dataset.step ?? null);
const waitStep = (s) => page.waitForFunction((x) => document.querySelector('.ph')?.dataset.step === x, s);
const text = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].map((e) => e.textContent.trim()).join(' | '), sel);
const disabled = (sel) => page.evaluate((q) => !!document.querySelector(q)?.disabled, sel);
const idle = () => page.waitForFunction(() => !document.querySelector('.ph').classList.contains('is-detecting') && !document.querySelector('.ph-busy.on'));
const file = async (name, mimeType, buffer) => {
  await page.setInputFiles('.ph-file >> nth=1', { name, mimeType, buffer });
  await page.waitForTimeout(700);
};
const png = (url) => Buffer.from(url.split(',')[1], 'base64');
/** Wait until the importer has re-fitted the photo to the stage (the sheet's height changes with its content). */
const settled = async () => {
  await page.waitForFunction(() => {
    const i = window.__photo.importer;
    const r = document.querySelector('.ph-stage').getBoundingClientRect();
    return i && Math.abs(i.sw - r.width) < 0.5 && Math.abs(i.sh - r.height) < 0.5;
  });
  await page.waitForTimeout(150);
};
const SAMPLE1 = { seed: 3, view: 'below', route: '#F2C230', wall: 'charcoal' };
const dragCorners = async () => {
  const target = await page.evaluate(() => window.__photo.trueCorners());
  for (let i = 0; i < 4; i++) {
    const b = await page.locator('.ph-corner').nth(i).boundingBox();
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) await page.mouse.move(from.x + ((target[i].x - from.x) * k) / 6, from.y + ((target[i].y - from.y) * k) / 6);
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
};
const tapWall = async (x, y) => {
  const p = await page.evaluate(([a, b]) => window.__photo.wallScreen(a, b), [x, y]);
  await page.touchscreen.tap(p.x, p.y);
};

await page.goto(`${base}/dev/photo.html?claude=${CLAUDE}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!window.__photo, null, { timeout: 90000 });
await page.waitForTimeout(800);
await tapSel('#dev .go');
await waitStep('photo');
await page.waitForTimeout(500);

// 1 · not a photo, a HEIC, a thumbnail: PHOTO says why and stays ready for another pick
await file('topo.pdf', 'application/pdf', Buffer.from('%PDF-1.4 not an image'));
check((await step()) === 'photo' && /isn’t a photo/.test(await text('.ph-err')), `a PDF stays on PHOTO with a reason (${await text('.ph-err')})`);
await shot('01-not-a-photo');
await file('IMG_0042.HEIC', 'image/heic', Buffer.from('ftypheic....'));
check(/HEIC/.test(await text('.ph-err')), 'a HEIC the browser can’t open says how to get a JPEG');
await shot('02-heic');
await file('thumb.png', 'image/png', png(await page.evaluate((o) => window.__photo.synthPng(o, 0.15), SAMPLE1)));
check((await step()) === 'photo' && /Too small|too little/.test(await text('.ph-err')), `a thumbnail is refused (${await text('.ph-err')})`);
check(!(await disabled('.ph-take')) && !(await disabled('.ph-pick')), 'TAKE / CHOOSE PHOTO stay available');
await shot('03-thumbnail');

// 2 · a small photo: framed with a warning
await file('small.png', 'image/png', png(await page.evaluate((o) => window.__photo.synthPng(o, 0.5), SAMPLE1)));
await waitStep('frame');
await page.waitForTimeout(400);
check(/Small photo/.test(await text('.ph-adv')), `a small photo is framed with a warning (${await text('.ph-adv')})`);
await shot('04-small-photo');

// 3 · a full photo; a colour tap on the bare wall
await file('wall.png', 'image/png', png(await page.evaluate((o) => window.__photo.synthPng(o), SAMPLE1)));
await waitStep('frame');
await page.waitForTimeout(400);
await dragCorners();
await tapSel('.ph-next');
await waitStep('color');
await idle();
await page.waitForTimeout(500);
// a spot of bare wall: ≥ 0.35 m from every hold
const bare = await page.evaluate(() => {
  const s = window.__photo.synth;
  for (let y = 3.6; y > 0.8; y -= 0.1)
    for (let x = -1.8; x < 1.8; x += 0.1) if (s.holds.every((h) => Math.hypot(h.x - x, h.y - y) > h.r + 0.35)) return { x, y };
  return null;
});
await settled();
await tapWall(bare.x, bare.y);
await page.waitForTimeout(900);
check(/looks like the wall/.test(await text('.ph-adv')), `a tap on the wall is called out (${await text('.ph-adv')})`);
await shot('05-colour-wall');

// 4 · find holds with the wall's colour: the detection explains, TAP A HOLD AGAIN goes back
await tapSel('.ph-next');
await waitStep('holds');
await idle();
await page.waitForTimeout(600);
const wallAdv = await text('.ph-adv');
console.log('holds with the wall colour:', await text('.ph-title'), '·', wallAdv);
check(wallAdv.length > 0, 'the detection explains what went wrong');
await shot('06-holds-wall-colour');
const again = page.locator('.ph-adv-b', { hasText: 'TAP A HOLD AGAIN' });
if (await again.count()) {
  await tapSel('.ph-adv-b:has-text("TAP A HOLD AGAIN")');
  await waitStep('color');
  check(true, 'TAP A HOLD AGAIN goes back to the colour');
} else {
  await tapSel('.ph-back');
  await waitStep('color');
}
await page.waitForTimeout(400);
// clear the wall colour
while (await page.locator('.ph-sw').count()) {
  await tapSel('.ph-sw');
  await page.waitForTimeout(250);
}
// the sheet changed height: let the stage re-fit the photo before aiming
await page.waitForTimeout(700);

// 5 · a colour only one hold has: ONLY ONE HOLD, NEXT disabled, FIND MORE offered
const lone = await page.evaluate(() => {
  const s = window.__photo.synth;
  // a visible one: not under the volume (painted over it) nor touching another hold
  const vols = s.holds.filter((h) => h.shape === 'volume');
  const clear = (h) => vols.every((v) => Math.hypot(v.x - h.x, v.y - h.y) > v.r + h.r + 0.1) && s.holds.every((o) => o === h || Math.hypot(o.x - h.x, o.y - h.y) > o.r + h.r + 0.05);
  const others = s.holds.filter((h) => !h.route && h.shape !== 'volume' && h.shape !== 'tape' && h.r > 0.04 && clear(h));
  const count = (c) => s.holds.filter((h) => h.color === c).length;
  const h = others.find((o) => count(o.color) === 1) ?? others[0];
  return h && { x: h.x, y: h.y, color: h.color };
});
console.log('lone hold colour', lone?.color);
await settled();
await tapWall(lone.x, lone.y);
await page.waitForTimeout(900);

await tapSel('.ph-next');
await waitStep('holds');
await idle();
await page.waitForTimeout(600);
const n1 = await page.evaluate(() => window.__photo.importer.included().length);
console.log('lone colour:', await text('.ph-title'), '·', await text('.ph-adv'));
check(n1 === 1 && (await disabled('.ph-next')) && /one hold/i.test(await text('.ph-adv')), `one hold can't go on, and says why (${n1} holds)`);
await shot('07-holds-one');
if (await page.locator('.ph-adv-b:has-text("FIND MORE")').count()) {
  const before = await page.evaluate(() => window.__photo.importer.sensitivity);
  await tapSel('.ph-adv-b:has-text("FIND MORE")');
  await page.waitForTimeout(300);
  await idle();
  const after = await page.evaluate(() => window.__photo.importer.sensitivity);
  check(after > before, `FIND MORE raises the sensitivity (${before.toFixed(2)} → ${after.toFixed(2)})`);
}

// 6 · the problem's own colour; Claude declines
await tapSel('.ph-back');
await waitStep('color');
await page.waitForTimeout(300);
while (await page.locator('.ph-sw').count()) {
  await tapSel('.ph-sw');
  await page.waitForTimeout(250);
}
// the sheet changed height: let the stage re-fit the photo before aiming
await page.waitForTimeout(700);
await settled();
const h0 = await page.evaluate(() => window.__photo.holdScreen(0));
await page.touchscreen.tap(h0.x, h0.y);
await page.waitForTimeout(900);

await tapSel('.ph-next');
await waitStep('holds');
await idle();
await page.waitForTimeout(600);
const n = await page.evaluate(() => window.__photo.importer.included().length);
check(n >= 12 && !(await disabled('.ph-next')), `the route colour finds the problem (${n} holds)`);
if (await page.locator('.ph-claude-go').count()) {
  await tapSel('.ph-claude-go');
  await page.waitForFunction(() => !document.querySelector('.ph-claude-run'), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const note = await text('.ph-note');
  console.log('claude:', note);
  check(note.length > 0 && !(await disabled('.ph-next')), 'Claude declining leaves a note and the local holds');
  await shot('08-claude-' + CLAUDE);
}

// 7 · START · TOP: a sit start warns
await tapSel('.ph-next');
await waitStep('roles');
await page.waitForTimeout(500);
const low = await page.evaluate(() => {
  const imp = window.__photo.importer;
  const inc = imp.included();
  const h = inc[inc.length - 1];
  const p = imp.toScreen({ x: h.x, y: h.y });
  const r = document.querySelector('.ph-stage').getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
});
await page.touchscreen.tap(low.x, low.y);
await page.waitForTimeout(500);
console.log('roles:', await text('.ph-adv'));
check(/sit start|low/i.test(await text('.ph-adv')), 'a start low on the wall warns about a sit start');
await shot('09-sit-start');
await page.touchscreen.tap(low.x, low.y);
await page.waitForTimeout(400);
check(!(await disabled('.ph-next')), 'clearing it lets the problem go on');

// 8 · WALL: a wall with no beta suggests one that has
await tapSel('.ph-next');
await waitStep('wall');
await page.waitForTimeout(2500);
const steep = page.locator('.ph-wall[data-id="steep-45"]');
await steep.scrollIntoViewIfNeeded();
await tapSel('.ph-wall[data-id="steep-45"]');
await page.waitForFunction(() => /CLIMBABLE|NO BETA YET ·|CLIMBABLE ON/.test(document.querySelector('.ph-beta')?.textContent ?? '') && !document.querySelector('.ph-beta .ph-spin'), null, { timeout: 60000 });
await page.waitForTimeout(800);
const beta = await text('.ph-beta');
console.log('steep 45:', beta);
await shot('10-wall-no-beta');
if (await page.locator('.ph-beta-use').count()) {
  await tapSel('.ph-beta-use');
  await page.waitForFunction(() => document.querySelector('.ph-beta')?.classList.contains('is-ok'), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  check(true, `USE <wall> switches to a wall with a beta (${await text('.ph-wall.on')}: ${await text('.ph-beta')})`);
  await shot('11-wall-suggested');
} else check(/NO BETA|CLIMBABLE/.test(beta), 'the beta line says what to do');
await tapSel('.ph-make');
await page.waitForFunction(() => window.__photo.result !== undefined, null, { timeout: 30000 });
const res = await page.evaluate(() => window.__photo.result && { holds: window.__photo.result.holds.length, wall: window.__photo.result.wallAngle });
check(!!res, `a problem comes out (${JSON.stringify(res)})`);
const errs = logs.filter((l) => /pageerror|\[error\]/i.test(l) && !/favicon|fonts\.g|404|Failed to load resource/i.test(l));
check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' / ') : ''}`);
await browser.close();
console.log(ok ? 'PHOTO BAD INPUT: ALL PASSED' : 'PHOTO BAD INPUT: FAILED');
process.exit(ok ? 0 : 1);

// EDITOR QA: drives dev/editor.html in headless Chromium (touch), places holds by tapping the wall,
// checks the draft + status, walks TEST → (auto) SENT → PUBLISH, and saves screenshots per state.
// usage: node dev/editor.check.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5205/dev/editor.html';
const out = process.argv[3] ?? '/tmp/claude-0/shots/editor';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name, settle = 2600) => {
  await wait(settle);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
};
const draft = () => page.evaluate(() => window.__ed.editor.getDraft());
const chip = () => page.evaluate(() => document.querySelector('.ed-chip')?.textContent ?? '');
/** Screen point of a wall-local position. */
const screenOf = (x, y) => page.evaluate(([x, y]) => window.__ed.renderer.wallToScreen({ x, y }), [x, y]);
const tapWall = async (x, y) => {
  const p = await screenOf(x, y);
  await page.touchscreen.tap(p.x, p.y);
  await wait(380); // never a double tap
};
const tapSel = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await wait(250);
};

await page.goto(`${base}?fresh=1&q=low&auto=sent`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__ed && !!document.querySelector('.ed'), null, { timeout: 30000 });
await page.evaluate(() => window.__ed.renderer.setCameraMode('editor', { instant: true }));
await shot('s1-empty', 3000);
check((await draft()).holds.length === 0, 'fresh draft is empty');
check(/tap the wall/i.test(await chip()), 'chip asks to tap the wall');

// two starts (role auto-advances to HAND), four hands
await tapWall(-0.35, 1.5);
await tapWall(0.3, 1.5);
let d = await draft();
check(d.holds.length === 2 && d.holds.every((h) => h.role === 'start'), 'two START holds placed by tapping');
check(d.holds.every((h) => Math.abs(((h.y - 0.1) / 0.2) % 1) < 1e-6 || Math.abs(((h.y - 0.1) / 0.2) % 1) > 1 - 1e-6), 'holds snapped to T-nut rows');
for (const [x, y] of [[-0.2, 2.1], [0.4, 2.5], [-0.3, 3.0], [0.2, 3.5]]) await tapWall(x, y);
d = await draft();
check(d.holds.filter((h) => h.role === 'hand').length === 4, 'role auto-advanced to HAND after two starts');
check(/need a top/i.test(await chip()), 'chip reports the missing top');
await shot('s2-invalid');

// top
await tapSel('.ed-role-top');
await tapWall(0, 4.05);
// feet: pick the foot chip type, tap low on the wall
await tapSel('.ed-tile[aria-label="Foot chip"]');
await tapWall(-0.3, 0.7);
await tapWall(0.35, 0.9);
d = await draft();
const roles = d.holds.reduce((m, h) => ((m[h.role] = (m[h.role] ?? 0) + 1), m), {});
check(roles.start === 2 && roles.hand === 4 && roles.top === 1 && roles.foot === 2, `draft roles ${JSON.stringify(roles)}`);
// overlap guard: tapping right next to an existing hold selects it instead of stacking
await tapWall(-0.33, 1.52);
check((await draft()).holds.length === 9, 'tap on an existing hold does not add a hold');
const selId = await page.evaluate(() => window.__ed.editor['selectedId']);
check(!!selId, 'tap on a hold selects it');
await shot('s3-selected');
// tap empty wall to deselect
await tapWall(1.5, 2.6);
check(!(await page.evaluate(() => window.__ed.editor['selectedId'])), 'tap on empty wall deselects');

// wait for the beta reader
await page.waitForFunction(() => /solvable|no beta/i.test(document.querySelector('.ed-chip')?.textContent ?? ''), null, { timeout: 30000 });
const c1 = await chip();
check(/solvable|no beta/i.test(c1), `analysis finished: "${c1}"`);
await shot('s4-valid', 1800);

// checklist popover
await tapSel('.ed-chip');
await shot('s5-check', 1200);
await tapSel('.ed-chip');

// drag a hold
const h0 = (await draft()).holds.find((h) => h.role === 'hand');
const p0 = await screenOf(h0.x, h0.y);
await page.evaluate(([x, y]) => {
  const s = document.querySelector('.ed-surface');
  const ev = (type, x, y) => s.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
  ev('pointerdown', x, y);
  for (let i = 1; i <= 8; i++) ev('pointermove', x + i * 6, y - i * 2);
  ev('pointerup', x + 48, y - 16);
}, [p0.x, p0.y]);
await wait(300);
const h1 = (await draft()).holds.find((h) => h.id === h0.id);
check(h1 && (h1.x !== h0.x || h1.y !== h0.y), `drag moved the hold (${h0.x},${h0.y}) → (${h1?.x},${h1?.y})`);
// undo restores it
await tapSel('.ed-hist .ed-hbtn');
const h2 = (await draft()).holds.find((h) => h.id === h0.id);
check(h2 && h2.x === h0.x && h2.y === h0.y, 'undo restores the dragged hold');

// gestures with synthetic pointers: pinch zoom, twist-rotate a selected hold, knob, double-tap reset
const ptr = (events) =>
  page.evaluate((events) => {
    const s = document.querySelector('.ed-surface');
    for (const [type, id, x, y] of events) s.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
  }, events);
const view = () => page.evaluate(() => ({ ...window.__ed.editor['view'].center, m: window.__ed.editor['view'].meters, fit: window.__ed.editor['view'].isFit }));
await page.evaluate(() => window.__ed.editor['select'](null));
await wait(300);
const v0 = await view();
await ptr([['pointerdown', 1, 150, 420], ['pointerdown', 2, 240, 420], ['pointermove', 2, 270, 420], ['pointermove', 1, 120, 420], ['pointermove', 2, 300, 420], ['pointermove', 1, 90, 420], ['pointerup', 1, 90, 420], ['pointerup', 2, 300, 420]]);
const v1 = await view();
check(v1.m < v0.m * 0.6 && !v1.fit, `pinch zooms in (${v0.m.toFixed(2)} → ${v1.m.toFixed(2)} m)`);
await ptr([['pointerdown', 1, 150, 420], ['pointerdown', 2, 240, 420], ['pointermove', 1, 170, 470], ['pointermove', 2, 260, 470], ['pointerup', 1, 170, 470], ['pointerup', 2, 260, 470]]);
const v2 = await view();
check(v2.y > v1.y + 0.1, `two-finger pan moves the view (${v1.y.toFixed(2)} → ${v2.y.toFixed(2)})`);
// double tap on empty wall: the first tap's hold is taken back and the view resets
const nBefore = (await draft()).holds.length;
const empty = await page.evaluate(() => {
  const e = window.__ed.editor;
  for (const [x, y] of [[300, 420], [90, 420], [300, 560], [90, 560], [195, 360]]) if (!e['hitHold'](x, y, false) && window.__ed.renderer.screenToWall(x, y)) return { x, y };
  return { x: 300, y: 420 };
});
// (synthetic events: headless frames take ~1 s, so real taps can never land within the double-tap window)
await ptr([['pointerdown', 1, empty.x, empty.y], ['pointerup', 1, empty.x, empty.y], ['pointerdown', 1, empty.x + 3, empty.y + 2], ['pointerup', 1, empty.x + 3, empty.y + 2]]);
await wait(400);
check((await draft()).holds.length === nBefore && (await view()).fit, 'double-tap resets the view without leaving a hold');
// twist: select a hand hold, two fingers on it, rotate ~90° clockwise on screen
await wait(1500);
const ht = (await draft()).holds.find((h) => h.role === 'hand');
await page.evaluate((id) => window.__ed.editor['select'](id), ht.id);
await wait(1500);
const c = await screenOf(ht.x, ht.y);
await ptr([['pointerdown', 1, c.x - 40, c.y], ['pointerdown', 2, c.x + 40, c.y], ['pointermove', 2, c.x + 28, c.y + 28], ['pointermove', 1, c.x - 28, c.y - 28], ['pointermove', 2, c.x, c.y + 40], ['pointermove', 1, c.x, c.y - 40], ['pointerup', 1, c.x, c.y - 40], ['pointerup', 2, c.x, c.y + 40]]);
const ht2 = (await draft()).holds.find((h) => h.id === ht.id);
const dDeg = Math.round(((ht2.angle - ht.angle) * 180) / Math.PI);
check((((dDeg % 360) + 360) % 360) === 270, `twist rotates the selected hold a quarter turn clockwise (Δ ${dDeg}°)`);
// knob: drag the rotate knob a quarter turn back
await wait(1500);
const knob = await page.evaluate(() => window.__ed.editor['overlay'].knob);
const sel = await page.evaluate(() => window.__ed.editor['overlay'].selection);
if (knob && sel) {
  const rr = Math.hypot(knob.x - sel.x, knob.y - sel.y);
  const a0 = Math.atan2(knob.y - sel.y, knob.x - sel.x);
  const steps = [];
  steps.push(['pointerdown', 1, knob.x, knob.y]);
  for (let i = 1; i <= 6; i++) {
    const a = a0 - (i / 6) * (Math.PI / 2);
    steps.push(['pointermove', 1, sel.x + Math.cos(a) * rr, sel.y + Math.sin(a) * rr]);
  }
  steps.push(['pointerup', 1, steps[steps.length - 1][2], steps[steps.length - 1][3]]);
  await ptr(steps);
  const ht3 = (await draft()).holds.find((h) => h.id === ht.id);
  const back = Math.round(((ht3.angle - ht.angle) * 180) / Math.PI);
  check(Math.abs(back) <= 1, `rotate knob turns the hold back (Δ ${back}° from the original)`);
} else check(false, 'rotate knob present');
// undo twice → original angle, then deselect
await tapSel('.ed-hist .ed-hbtn');
await tapSel('.ed-hist .ed-hbtn');
check(Math.abs((await draft()).holds.find((h) => h.id === ht.id).angle - ht.angle) < 1e-6, 'undo restores the rotation');
await page.evaluate(() => window.__ed.editor['select'](null));

// colour + angle drawers
await tapSel('.ed-tool-angle');
await shot('s6-angle', 1500);
await tapSel('.ed-tool-color');
await tapSel('.ed-sw[aria-label="Blue"]');
d = await draft();
check(d.color.toLowerCase() === '#2f6feb' && d.holds.every((h) => h.color.toLowerCase() === '#2f6feb'), 'route colour applied to every hold');
await shot('s7-color', 3000);
await tapSel('.ed-tool-color');

// publish is locked before a test
check(await page.locator('.ed-pub').isDisabled(), 'PUBLISH locked before a test send');
await page.waitForFunction(() => !/reading/i.test(document.querySelector('.ed-chip')?.textContent ?? ''), null, { timeout: 30000 });
// TEST → dev stand-in auto-reports SENT → editor re-opens
await tapSel('.ed-test');
await page.waitForFunction(() => window.__ed.events.includes('test'), null, { timeout: 10000 });
check(true, 'TEST emitted editor:test');
await page.waitForFunction(() => window.__ed.editor.isOpen, null, { timeout: 15000 });
await page.evaluate(() => window.__ed.renderer.setCameraMode('editor', { instant: true }));
check(!(await page.locator('.ed-pub').isDisabled()), 'PUBLISH unlocked after a sent test');
await shot('s8-passed', 2600);
// any edit locks it again; undo of that edit unlocks
await page.evaluate(() => document.querySelector('.ed-tool-snap')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await tapWall(1.2, 1.9);
check(await page.locator('.ed-pub').isDisabled(), 'an edit re-locks PUBLISH');
await tapSel('.ed-hist .ed-hbtn');
check(!(await page.locator('.ed-pub').isDisabled()), 'undo back to the tested revision unlocks PUBLISH');
await page.evaluate(() => document.querySelector('.ed-tool-snap')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

// publish with confirm
await tapSel('.ed-pub');
await page.waitForSelector('.modal-ok', { timeout: 5000 });
await shot('s9-confirm', 900);
await tapSel('.modal-ok');
await page.waitForFunction(() => window.__ed.events.includes('publish'), null, { timeout: 5000 });
const pub = await page.evaluate(() => window.__ed.lastPublish);
check(pub && pub.author === '' && pub.holds.length === 9 && typeof pub.createdAt === 'number', 'editor:publish carries the boulder (author blank, createdAt set)');
await shot('s10-live', 1500);

// persistence
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jgu.editor.draft') ?? 'null'));
check(saved && saved.draft.holds.length === 9 && saved.published, 'draft persisted to localStorage');

// sample
await tapSel('.ed-tool-more');
await shot('s11-menu', 1200);
await tapSel('.ed-sample-go');
await page.waitForSelector('.modal-ok', { timeout: 5000 });
await tapSel('.modal-ok');
await page.waitForFunction(() => window.__ed.editor.getDraft().holds.length > 9 && !document.querySelector('.ed-sample-go.is-busy'), null, { timeout: 30000 });
d = await draft();
check(d.holds.length > 8 && d.holds.every((h) => h.role !== 'deco'), `sample loaded (${d.holds.length} holds, no deco)`);
await shot('s12-sample', 3500);

// folded wall (a multi-angle sample): taps, drags and pinch zoom pick through the renderer's ray
// cast, so they land where the finger is on every panel
await page.evaluate(() => {
  const d = window.__ed.editor.getDraft();
  d.profile = [
    { y0: 0, angle: 0 },
    { y0: 1.8, angle: 30 },
    { y0: 3.0, angle: 60 },
  ];
  d.holds = d.holds.filter((h) => h.y < 2.9 || h.role === 'top');
  window.__ed.editor.open(d);
  window.__ed.renderer.setCameraMode('editor', { instant: true });
});
await wait(2500);
check(await page.evaluate(() => (window.__ed.renderer.getBoulder()?.profile?.length ?? 0) === 3), 'the editor shows the folded wall');
await shot('s13-folded', 1500);
await page.evaluate(() => window.__ed.editor['select'](null));
d = await draft();
const n0 = d.holds.length;
// a free spot on the 60° panel and one on the 30° panel
for (const [x, y] of [[1.35, 3.55], [-1.2, 2.45]]) {
  const sp = await screenOf(x, y);
  await page.touchscreen.tap(sp.x, sp.y);
  await wait(500);
  const nd = await draft();
  const h = nd.holds.find((q) => !d.holds.some((o) => o.id === q.id));
  check(!!h && Math.hypot(h.x - x, h.y - y) < 0.12, `a tap on the folded wall places the hold under the finger (${x}, ${y}) → ${h ? `(${h.x.toFixed(2)}, ${h.y.toFixed(2)})` : 'none'}`);
  d = nd;
  await page.evaluate(() => window.__ed.editor['select'](null));
  await wait(300);
}
check(d.holds.length === n0 + 2, `two holds placed on the folded panels (${n0} → ${d.holds.length})`);
// pinch zoom about a point up on the steep panel: that wall point ends up under the fingers
const anchorWall = { x: 0.6, y: 3.4 };
const mid = await screenOf(anchorWall.x, anchorWall.y);
await ptr([
  ['pointerdown', 1, mid.x - 40, mid.y],
  ['pointerdown', 2, mid.x + 40, mid.y],
  ['pointermove', 1, mid.x - 70, mid.y],
  ['pointermove', 2, mid.x + 70, mid.y],
  ['pointermove', 1, mid.x - 100, mid.y],
  ['pointermove', 2, mid.x + 100, mid.y],
  ['pointerup', 1, mid.x - 100, mid.y],
  ['pointerup', 2, mid.x + 100, mid.y],
]);
await wait(2500); // the editor camera glides to its new framing
const under = await page.evaluate(([x, y]) => window.__ed.renderer.screenToWall(x, y), [mid.x, mid.y]);
const drift = under ? Math.hypot(under.x - anchorWall.x, under.y - anchorWall.y) : 9;
check(drift < 0.15, `pinch zoom on the steep panel keeps that wall point under the fingers (drift ${(drift * 100).toFixed(0)} cm)`);
await shot('s14-folded-zoom', 800);
await ptr([['pointerdown', 1, 60, 300], ['pointerup', 1, 60, 300], ['pointerdown', 1, 62, 302], ['pointerup', 1, 62, 302]]);
await wait(1200);
// the angle slider turns the folded wall into one flat panel; undo brings the folds back
await tapSel('.ed-tool-angle');
await page.evaluate(() => {
  const i = document.querySelector('.ed-angle-in');
  i.value = '20';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new Event('change', { bubbles: true }));
});
await wait(800);
d = await draft();
check(!d.profile && d.wallAngle === 20, `the angle slider makes one flat panel (profile ${d.profile ? d.profile.length : 'none'}, ${d.wallAngle}°)`);
await tapSel('.ed-tool-angle');
await tapSel('.ed-hist .ed-hbtn');
await wait(600);
d = await draft();
check(d.profile?.length === 3, 'undo restores the folded wall');
await wait(1500);
check(await page.evaluate(() => (window.__ed.renderer.getBoulder()?.profile?.length ?? 0) === 3), 'the 3D wall folds again after the undo');

// close
await tapSel('.ed-x');
check(await page.evaluate(() => !window.__ed.editor.isOpen && window.__ed.events.includes('close') && !document.querySelector('.ed')), 'close removes the panel and emits editor:close');

const errs = logs.filter((l) => /pageerror|\[error\]/.test(l) && !/404/.test(l));
check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);

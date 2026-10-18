// Camera smoothness QA in the REAL game: records the camera every frame (position, view direction,
// FOV, mode, veil, screen) through a whole session — intro fly-in → title → locker framing → title
// → preview → follow → route overview and back → fall → results → menu — then reports each shot
// change with its peak speed / acceleration / turn rate and flags any frame that snaps (a jump
// the springs did not smooth) while the transition veil is not covering the screen.
// Sequential screenshots around each transition go to --out.
//
// usage: node dev/world.smooth.mjs [baseUrl] [--out dir] [--q low] [--intro 1] [--shots 1]
//   baseUrl defaults to http://localhost:5403 (VITE_CACHE_DIR=node_modules/.vite-a-world
//   npx vite --config dev/e2e.vite.config.mjs --port 5403 --strictPort). Always the LOCAL backend.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5403';
const out = opt('out', '/tmp/claude-0/shots/a-world/smooth');
const q = opt('q', 'low');
const withIntro = opt('intro', '1') === '1';
const withShots = opt('shots', '1') === '1';
mkdirSync(out, { recursive: true });

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await context.addInitScript((intro) => {
  if (sessionStorage.getItem('smooth-seeded')) return;
  sessionStorage.setItem('smooth-seeded', '1');
  localStorage.clear();
  localStorage.setItem(
    'jgu.profile.v1',
    JSON.stringify({ version: 1, playerName: 'QA Ibex', introSeen: !intro, tutorialDone: true, head: 'ibex', colorway: 'basalt', chalk: 'classic' }),
  );
}, withIntro);
const page = await context.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function waitFor(fn, what, timeout = 120000, arg) {
  const t = Date.now();
  for (;;) {
    let v = false;
    try {
      v = await page.evaluate(fn, arg);
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t > timeout) throw new Error(`timeout: ${what}`);
    await page.waitForTimeout(200);
  }
}
const waitScreen = (s, timeout) => waitFor((s) => document.getElementById('ui')?.dataset.screen === s, `screen ${s}`, timeout, s);
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil', 90000);
async function tap(sel) {
  await page.waitForSelector(sel, { state: 'visible', timeout: 60000 });
  await page.tap(sel);
}
async function tapText(text) {
  const loc = page.locator('button', { hasText: text }).first();
  await loc.waitFor({ state: 'visible', timeout: 60000 });
  await loc.tap();
}
const mark = (label) => page.evaluate((label) => window.__smooth?.marks.push({ i: window.__smooth.rows.length, label }), label);
let shotN = 0;
/** n screenshots ~gap ms apart (SwiftShader: each takes a while, so they follow the motion). */
async function burst(name, n = 4, gap = 350) {
  if (!withShots) return;
  for (let k = 0; k < n; k++) {
    const file = `${out}/${String(++shotN).padStart(2, '0')}-${name}-${k}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    if (k < n - 1) await page.waitForTimeout(gap);
  }
  log(`burst ${name} ×${n}`);
}
/** Wait `sec` seconds of game time (at least a few frames). */
async function hold(sec) {
  await page.waitForTimeout(sec * 1000);
}

// ───────────────────────────── boot + recorder ─────────────────────────────
await page.goto(`${base}/?debug=1&q=${q}&ts=1`, { waitUntil: 'load', timeout: 180000 });
await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
await page.evaluate(() => {
  const r = window.__jgu.renderer;
  const rows = [];
  window.__smooth = { rows, marks: [] };
  const orig = r.frame.bind(r);
  r.frame = (dt) => {
    orig(dt);
    const c = r.camera;
    const e = c.matrixWorld.elements;
    rows.push({
      dt: Math.min(0.1, Math.max(0, dt)),
      x: c.position.x, y: c.position.y, z: c.position.z,
      // view direction = −Z column of the camera's world matrix
      dx: -e[8], dy: -e[9], dz: -e[10],
      fov: c.fov,
      mode: r.cameraMode,
      veil: !!document.querySelector('.jga-veil.on'),
      screen: document.getElementById('ui')?.dataset.screen ?? '',
    });
  };
});
log('recorder on');

await tap('.splash-hit');
if (withIntro) {
  await mark('intro');
  await page.waitForTimeout(2500);
  await burst('intro-card', 3, 900);
  await page.waitForTimeout(3000);
  await burst('intro-fly', 4, 400);
}
await waitScreen('title', 300000);
await veilClear();
await mark('title');
await hold(5);
await burst('title', 2, 1500);

// title → locker framing → title
await tapText('LOCKER');
await waitScreen('locker');
await mark('locker');
await burst('locker', 4, 300);
await hold(4);
await tap('.btn-back');
await waitScreen('title');
await mark('title-again');
await burst('locker-to-title', 4, 300);
await hold(4);

// title → modes → preview (cut under the veil) → follow → overview → follow → fall → results
await tap('.title-play');
await waitScreen('modes');
await mark('modes');
await hold(2);
await tap('.mode-featured');
await waitScreen('preview', 120000);
await veilClear();
await mark('preview');
await burst('preview-settle', 3, 500);
await hold(3);
await tap('.pv-hit');
await mark('follow');
await burst('preview-to-follow', 5, 250);
await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 60000);
await hold(4);
await tap('.hud-eye');
await mark('overview');
await burst('follow-to-overview', 4, 300);
await hold(3);
await tap('.hud-eye');
await mark('overview-off');
await burst('overview-to-follow', 4, 300);
await hold(3);
await page.evaluate(() => window.__jgu.sim.forceFall());
await mark('fall');
await burst('fall', 4, 250);
await waitScreen('results', 90000);
await mark('results');
await hold(3);
await tapText('MENU');
await waitScreen('modes', 90000);
await veilClear();
await mark('menu');
await hold(1.5);
await tap('.btn-back');
await waitScreen('title');
await mark('title-end');
await hold(4);

// ───────────────────────────── analysis ─────────────────────────────
const { rows, marks } = await page.evaluate(() => window.__smooth);
writeFileSync(`${out}/trajectory.json`, JSON.stringify({ rows, marks }));
const V_SNAP = 22; // m/s in one frame: a cut, not a move
const A_SNAP = 80; // m/s² frame-to-frame change of velocity
const W_SNAP = 5; // rad/s turn rate
const flagged = [];
const seg = [];
let cur = null;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1];
  const b = rows[i];
  const dt = Math.max(1 / 240, b.dt);
  const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt, vz = (b.z - a.z) / dt;
  b.v = Math.hypot(vx, vy, vz);
  b.vv = [vx, vy, vz];
  const dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy + a.dz * b.dz));
  b.w = Math.acos(dot) / dt;
  b.acc = a.vv ? Math.hypot(vx - a.vv[0], vy - a.vv[1], vz - a.vv[2]) / dt : 0;
  const covered = b.veil || a.veil;
  if (!covered && (b.v > V_SNAP || b.acc > A_SNAP || b.w > W_SNAP)) flagged.push({ i, mode: b.mode, screen: b.screen, v: +b.v.toFixed(1), acc: +b.acc.toFixed(0), w: +b.w.toFixed(2) });
  if (!cur || cur.mode !== b.mode) {
    cur = { from: i, mode: b.mode, vMax: 0, aMax: 0, wMax: 0, n: 0 };
    seg.push(cur);
  }
  cur.n++;
  if (!covered) {
    cur.vMax = Math.max(cur.vMax, b.v);
    cur.aMax = Math.max(cur.aMax, b.acc);
    cur.wMax = Math.max(cur.wMax, b.w);
  }
}
log(`frames ${rows.length}`);
for (const m of marks) log(`mark ${m.label} @${m.i}`);
for (const s of seg) log(`shot ${s.mode.padEnd(9)} from #${String(s.from).padStart(5)} frames ${String(s.n).padStart(4)}  vMax ${s.vMax.toFixed(2)} m/s  aMax ${s.aMax.toFixed(1)} m/s²  turnMax ${s.wMax.toFixed(2)} rad/s`);
if (flagged.length) {
  log(`FLAGGED ${flagged.length} frame(s):`);
  for (const f of flagged.slice(0, 40)) log(`  #${f.i} ${f.mode}/${f.screen} v=${f.v} acc=${f.acc} turn=${f.w}`);
} else log('no snaps outside the veil');
const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
if (relevant.length) log(`console errors:\n  ${relevant.join('\n  ')}`);
log('done');
await browser.close();

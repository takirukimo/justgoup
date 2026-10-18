// CHARACTER anatomy QA in the REAL game (not shipped): boots index.html?debug=1, plays a mode with
// the planner bot driving the real ClimberSim (window.__jgu), and runs dev/character-probe.ts on
// every frame (limb ↔ limb / torso / head interpenetration, joints under the pads, IK fallbacks)
// for the climber and Steini. Screenshots at an interval and at the key moments.
//
// usage: node dev/character.realplay.mjs <baseUrl> --mode sendtrain|lead|tutorial|title [--out dir]
//        [--ts 3] [--q high] [--secs 150] [--every 9] [--fall 1] [--head ibex]
// start a no-HMR server first:
//   VITE_CACHE_DIR=node_modules/.vite-a-character npx vite --config dev/e2e.vite.config.mjs --port 5401 --strictPort
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:5401';
const mode = opt('mode', 'sendtrain');
const out = opt('out', `/tmp/claude-0/shots/a-character/realplay-${mode}`);
const ts = +opt('ts', 3);
const q = opt('q', 'high');
const secs = +opt('secs', 150);
const every = +opt('every', 9);
const head = opt('head', 'ibex');
const fall = opt('fall', '0') === '1';
mkdirSync(out, { recursive: true });
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await context.addInitScript(
  ({ head, tutorialDone }) => {
    if (sessionStorage.getItem('cq-seeded')) return;
    sessionStorage.setItem('cq-seeded', '1');
    localStorage.clear();
    localStorage.setItem('jgu.profile.v1', JSON.stringify({ version: 1, playerName: 'QA Ibex', introSeen: true, tutorialDone, head, colorway: 'basalt', chalk: 'classic' }));
  },
  { head, tutorialDone: mode !== 'tutorial' },
);
const page = await context.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let shotN = 0;
async function shot(name) {
  const file = `${out}/${String(++shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, timeout: 180000 });
  log(`shot ${file.split('/').pop()}`);
}
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
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil to lift', 90000);
async function tap(selector) {
  await page.waitForSelector(selector, { state: 'visible', timeout: 60000 });
  await page.tap(selector);
  log(`tap ${selector}`);
  await page.waitForTimeout(300);
}

await page.goto(`${base}/?debug=1&q=${q}&ts=${ts}`, { waitUntil: 'load', timeout: 180000 });
await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
// the probe: climber + Steini, every frame
await page.evaluate(async () => {
  const { startProbe } = await import('/dev/character-probe.ts');
  const r = window.__jgu.renderer;
  window.__probe = startProbe(() => {
    const list = [];
    const wf = r.wallFrame;
    if (r.climber && r.climberVisible) list.push({ name: 'climber', rig: r.climber.rig, phase: () => window.__jgu.sim?.getState().phase ?? 'rest', wallN: wf.normal, wallP: wf.origin });
    if (r.guide && r.guide.visible && r.guideState) list.push({ name: 'guide', rig: r.guide.rig, phase: () => r.guideState?.pose ?? 'none', wallN: wf.normal, wallP: wf.origin });
    return list;
  });
});
log('probe running');
await page.waitForTimeout(2500);
// splash → title (the home screen)
if (await page.$('.splash-hit')) {
  await shot('splash');
  await tap('.splash-hit');
  await page.waitForSelector('.title-play', { state: 'visible', timeout: 120000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
}

/** Drive the live sim with the planner bot (sim seconds = real seconds × ts). */
async function startBot() {
  await page.evaluate(async (ts) => {
    const { BetaBot } = await import('/src/game/bot.ts');
    const sim = window.__jgu.sim;
    const bot = new BetaBot(sim);
    const evs = [];
    const off = window.__jgu.bus.on('sim:event', (e) => evs.push(e));
    let last = performance.now();
    const f = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000) * ts;
      last = now;
      if (sim !== window.__jgu.sim) {
        if (typeof off === 'function') off();
        return;
      }
      bot.update(dt, evs.splice(0));
      if (!bot.done && !bot.failed) requestAnimationFrame(f);
      else if (bot.failed) greedy(sim, ts);
    };
    requestAnimationFrame(f);
    window.__bot = bot;
    /**
     * Fallback when the planner gives up: a greedy climber through the public limb API. The lowest
     * limb (relative to its root) moves to the best reachable hold above it; hands and feet take turns.
     */
    function greedy(sim, ts) {
      window.__greedy = { moves: 0 };
      const holds = new Map(sim.boulder.holds.map((h) => [h.id, h]));
      let state = 'pick';
      let limb = null;
      let from = null;
      let to = null;
      let t = 0;
      let wait = 0.4;
      let turn = 0;
      let last = performance.now();
      const order = ['RF', 'RH', 'LF', 'LH'];
      const g = () => {
        if (sim !== window.__jgu.sim) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000) * ts;
        last = now;
        const st = sim.getState();
        if (st.phase !== 'climbing') {
          if (st.phase === 'topped' || st.phase === 'landed') return;
          requestAnimationFrame(g);
          return;
        }
        if (state === 'pick') {
          wait -= dt;
          if (wait <= 0) {
            const used = new Set(Object.values(st.limbs).map((l) => l.holdId));
            for (let k = 0; k < 4 && state === 'pick'; k++) {
              const id = order[(turn + k) % 4];
              const L = st.limbs[id];
              const cur = L.holdId ? holds.get(L.holdId) : null;
              const cy = cur ? cur.y : L.pos.y;
              let best = null;
              let bestS = -1e9;
              for (const hid of sim.reachableHolds(id)) {
                if (used.has(hid)) continue;
                const h = holds.get(hid);
                if (!h || h.y < cy + 0.08) continue;
                const q = sim.predictGrip(id, hid);
                if (q < 0.3) continue;
                const s = h.y + q * 0.6 - 0.35 * Math.abs(h.x - st.pelvis.x);
                if (s > bestS) {
                  bestS = s;
                  best = h;
                }
              }
              if (best && sim.beginDrag(id)) {
                limb = id;
                from = { x: L.pos.x, y: L.pos.y };
                to = { x: best.x, y: best.y };
                t = 0;
                state = 'drag';
              }
            }
            turn = (turn + 1) % 4;
            if (state === 'pick') wait = 0.5;
          }
        } else if (state === 'drag') {
          t += dt / 0.45;
          const k = Math.min(1, t);
          const e = k * k * (3 - 2 * k);
          sim.dragTo(limb, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
          if (k >= 1) {
            sim.endDrag(limb);
            window.__greedy.moves++;
            state = 'pick';
            wait = 0.35;
          }
        }
        requestAnimationFrame(g);
      };
      requestAnimationFrame(g);
    }
  }, ts);
}
const phase = () => page.evaluate(() => window.__jgu.sim?.getState().phase ?? 'none');

async function climbFor(label, maxSecs, stopOn) {
  const t = Date.now();
  let lastShot = 0;
  for (;;) {
    const ph = await phase();
    const el = (Date.now() - t) / 1000;
    if (el - lastShot >= every) {
      lastShot = el;
      await shot(`${label}-${ph}-${el.toFixed(0)}s`);
      const rs = await page.evaluate(() => window.__jgu.renderer.stats?.()).catch(() => null);
      if (rs) log(`  renderer: calls ${rs.calls} tris ${(rs.triangles / 1000).toFixed(0)}k`);
    }
    if (stopOn.includes(ph) || el > maxSecs) return ph;
    await page.waitForTimeout(500);
  }
}

try {
  if (mode === 'title') {
    await shot('title');
    await page.waitForTimeout(8000);
    await shot('title-later');
  } else if (mode === 'sendtrain' || mode === 'lead') {
    await shot('title');
    await tap('.title-play');
    await waitScreen('modes');
    if (mode === 'lead') await page.locator('.mode-card', { hasText: 'Lead Tower' }).first().tap();
    else await tap('.mode-featured');
    await waitScreen('preview', 120000);
    await veilClear();
    await page.waitForTimeout(1500);
    await shot('preview');
    await tap('.pv-hit');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 90000);
    await startBot();
    const b = await page.evaluate(() => ({ name: window.__jgu.sim.boulder.name, grade: window.__jgu.sim.boulder.grade, angle: window.__jgu.sim.boulder.wallAngle }));
    log(`boulder ${b.name} V${b.grade} ${b.angle}°`);
    const end = await climbFor(mode, secs, mode === 'lead' ? ['landed'] : ['topped', 'landed']);
    log(`climb ended in phase ${end}`);
    await shot(`${mode}-end-${end}`);
    if (mode === 'lead' && fall) {
      // QA: a whipper onto the rope (caught → hanging), then back on the wall
      await page.evaluate(() => window.__jgu.sim.forceFall());
      for (let k = 0; k < 6; k++) {
        await page.waitForTimeout(1200);
        await shot(`lead-fall-${await phase()}-${k}`);
      }
    }
    if (mode === 'sendtrain') {
      await page.waitForTimeout(2500);
      await shot('after-top');
      if (fall) {
        // next boulder, then a forced fall → landing + standing up on the pads
        await page.locator('#ui button', { hasText: 'NEXT BOULDER' }).first().tap();
        await waitScreen('preview', 120000);
        await veilClear();
        await tap('.pv-hit');
        await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start 2', 90000);
        await startBot();
        await page.waitForTimeout(6000);
        await page.evaluate(() => window.__jgu.sim.forceFall());
        for (let k = 0; k < 8; k++) {
          await page.waitForTimeout(900);
          await shot(`fall-${await phase()}-${k}`);
        }
      }
    }
  } else if (mode === 'tutorial') {
    await page.evaluate(() => window.__jgu.app.playTutorial());
    await page.waitForTimeout(4000);
    await veilClear();
    const t = Date.now();
    let k = 0;
    while ((Date.now() - t) / 1000 < secs) {
      await shot(`tutorial-${k++}`);
      // advance Steini's lines
      await page.evaluate(() => document.querySelector('.gb-next, .gb-tap, .guide-bubble')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
      if (k === 3 && window) await startBot().catch(() => undefined);
      await page.waitForTimeout(every * 1000);
    }
  }
} catch (e) {
  log(`ERROR ${e.message}`);
  await shot('error').catch(() => undefined);
}
const stats = await page.evaluate(() => JSON.parse(JSON.stringify(window.__probe?.stats ?? {})));
const botInfo = await page.evaluate(() => (window.__bot ? { moves: window.__bot.moves, done: window.__bot.done, failed: window.__bot.failed, log: window.__bot.log.slice(-6), greedyMoves: window.__greedy?.moves ?? 0 } : null));
writeFileSync(`${out}/probe.json`, JSON.stringify({ mode, stats, botInfo, errors }, null, 2));
console.log(JSON.stringify({ mode, stats, botInfo, errors: errors.slice(0, 8) }, null, 2));
await browser.close();

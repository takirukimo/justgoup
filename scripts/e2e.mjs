// End-to-end QA for JUST GO UP: drives the real game page like a player (taps + real touch drags
// through LimbControls) and screenshots every step.
//
// usage: node scripts/e2e.mjs [baseUrl] [--out dir] [--ts 3] [--q low] [--only a,b,c] [--keep]
//   baseUrl defaults to http://localhost:5207 (start the dev server first:
//   VITE_CACHE_DIR=node_modules/.vite-integration npx vite --config dev/e2e.vite.config.mjs --port 5207 --strictPort
//   — that config never reloads the page mid-run; restart it after source changes)
//   steps: onboarding, sendtrain, leaderboard, locker, settings, community, editor, daily, communityplay, lead
//   --only runs a subset (later steps seed a returning-player profile when onboarding is skipped).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5207';
const out = opt('out', '/tmp/claude-0/shots/integration');
const ts = +opt('ts', 3);
const q = opt('q', 'low');
const dpr = +opt('dpr', 1);
const only = opt('only', null)?.split(',') ?? null;
const want = (s) => !only || only.includes(s);
mkdirSync(out, { recursive: true });

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
  return cond;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
const page = await context.newPage();
const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t);
  else if (m.type() === 'warning') warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

if (!want('onboarding')) {
  // a returning player: intro seen, named, tutorial skipped earlier
  await context.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    localStorage.clear();
    localStorage.setItem(
      'jgu.profile.v1',
      JSON.stringify({ version: 1, playerName: 'E2E Ibex', introSeen: true, tutorialDone: false, head: 'ibex', colorway: 'basalt', chalk: 'classic' }),
    );
  });
}

const cdp = await context.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: 0, radiusX: 6, radiusY: 6, force: 1 })) });
const frames = (n = 1) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let k = 0;
        const f = () => (++k >= n ? r() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );
let shotN = 0;
async function shot(name) {
  const file = `${out}/${String(++shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log(`shot ${file.split('/').pop()}`);
}
const screen = () => page.evaluate(() => document.getElementById('ui')?.dataset.screen ?? '');
const appState = () => page.evaluate(() => window.__jgu?.app.current ?? '');
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
    if (Date.now() - t > timeout) {
      ok(false, `timed out waiting for ${what}`);
      throw new Error(`timeout: ${what}`);
    }
    await page.waitForTimeout(150);
  }
}
const waitScreen = (s, timeout) => waitFor((s) => document.getElementById('ui')?.dataset.screen === s, `screen ${s}`, timeout, s);
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil to lift', 60000);
async function tap(selector, what = selector) {
  await page.waitForSelector(selector, { state: 'visible', timeout: 30000 });
  await page.tap(selector);
  log(`tap ${what}`);
  await frames(2);
}
async function tapText(text, scope = '#ui') {
  const loc = page.locator(`${scope} button`, { hasText: text }).first();
  await loc.waitFor({ state: 'visible', timeout: 30000 });
  await loc.tap();
  log(`tap "${text}"`);
  await frames(2);
}

// ───────────────────────────── boot ─────────────────────────────
await page.goto(`${base}/?debug=1&q=${q}&ts=${ts}`, { waitUntil: 'load' });
await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
await page.waitForTimeout(800);
ok(!(await page.$('#boot')), 'boot overlay removed after the first frame');
await shot('splash');

// ───────────────────────────── onboarding ─────────────────────────────
if (want('onboarding')) {
  await tap('.splash-hit', 'splash');
  await waitFor(() => window.__jgu.app.current === 'intro', 'intro', 30000);
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot('intro');
  await tap('.gb-skip', 'SKIP intro');
  await waitScreen('name', 30000);
  await page.waitForTimeout(700);
  await shot('name-empty');
  await page.fill('.name-input', 'E2E Ibex');
  await frames(2);
  await shot('name-filled');
  await tapText('CONTINUE');
  await waitFor(() => window.__jgu.app.current === 'tutorial', 'tutorial start', 30000);
  await veilClear();
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1500);
  await shot('tutorial');
  await tap('.gb-skip', 'SKIP tutorial');
  await waitScreen('title', 60000);
  await veilClear();
  await page.waitForTimeout(1200);
  await shot('title');
  ok((await appState()) === 'menu', 'title menu after onboarding');
} else {
  await tap('.splash-hit', 'splash');
  await waitScreen('title', 60000);
  await page.waitForTimeout(1500);
  await shot('title');
}

// ───────────────────────────── climbing helpers ─────────────────────────────

/** Snapshot of where things are on screen for the climbing bot. */
async function look(holdId, limb) {
  return page.evaluate(
    async ({ holdId, limb }) => {
      const j = window.__jgu;
      const sim = j.sim;
      if (!sim) return null;
      const { contactPoint, clipPoint } = await import('/src/game/holds.ts');
      const st = sim.getState();
      const cr = document.getElementById('controls').getBoundingClientRect();
      const gr = j.renderer.canvas.getBoundingClientRect();
      const scr = (p, d = 0) => {
        const s = j.renderer.wallToScreen(p, d);
        return { x: s.x + gr.left, y: s.y + gr.top, visible: s.visible };
      };
      const hp = j.controls.handlePosition(limb);
      const idx = { LH: 0, RH: 1, LF: 2, RF: 3 }[limb];
      const pair = limb === 'LH' ? 'RH' : limb === 'RH' ? 'LH' : limb === 'LF' ? 'RF' : 'LF';
      const h = sim.boulder.holds.find((x) => x.id === holdId);
      const q = sim.boulder.quickdraws?.find((x) => x.id === holdId);
      let to = null;
      if (h) to = contactPoint(h, idx, st.limbs[pair].holdId === h.id, { x: 0, y: 0 });
      else if (q) to = clipPoint(q, { x: 0, y: 0 });
      const target = j.controls.target;
      const dragging = j.controls.dragging === limb;
      return {
        phase: st.phase,
        handle: hp ? { x: hp.x + cr.left, y: hp.y + cr.top } : null,
        from: scr(st.limbs[limb].pos, st.limbs[limb].depth),
        to: to ? scr(to) : null,
        drag: dragging ? scr(target) : null,
        candidate: dragging ? (q ? sim.clipCandidate(limb, target)?.id ?? null : sim.snapCandidate(limb, target)?.id ?? null) : null,
        on: st.limbs[limb].holdId,
        busy: st.limbs[limb].busy,
        clipped: st.clipped.slice(),
        camera: j.renderer.cameraMode,
      };
    },
    { holdId, limb },
  );
}

/** One move through a real touch drag: grab the handle, steer the live drag target onto the hold. */
/** Wait until the handle stops gliding (the follow camera re-frames after every move). */
async function settleHandle(limb) {
  let prev = null;
  for (let k = 0; k < 14; k++) {
    const p = await page.evaluate((l) => window.__jgu.controls.handlePosition(l), limb);
    if (p && prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 3) return;
    prev = p;
    await frames(1);
  }
}

async function dragMove(limb, holdId) {
  await settleHandle(limb);
  let s = await look(holdId, limb);
  if (!s || s.phase !== 'climbing' || !s.handle || !s.to) return 'skip';
  let finger = { ...s.handle };
  await touch('touchStart', [finger]);
  await frames(1);
  s = await look(holdId, limb);
  if (!s.drag) {
    const why = await page.evaluate(
      ({ x, y, limb }) => {
        const el = document.elementFromPoint(x, y);
        const j = window.__jgu;
        const st = j.sim.getState();
        return `${el?.className || el?.tagName} dragging=${j.controls.dragging} busy=${st.limbs[limb].busy} phase=${st.phase} handle=${JSON.stringify(j.controls.handlePosition(limb))}`;
      },
      { ...finger, limb },
    );
    await touch('touchEnd', []);
    return `missed-handle at ${finger.x.toFixed(0)},${finger.y.toFixed(0)}: ${why}`;
  }
  const moveBy = async (dx, dy, steps = 4) => {
    const s0 = { ...finger };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t * t * (3 - 2 * t);
      finger = { x: s0.x + dx * e, y: s0.y + dy * e };
      await touch('touchMove', [finger]);
    }
    await frames(1);
  };
  await moveBy(s.to.x - s.from.x, s.to.y - s.from.y);
  for (let k = 0; k < 24; k++) {
    s = await look(holdId, limb);
    if (!s || !s.drag || s.phase !== 'climbing') break;
    if (s.candidate === holdId) {
      await frames(1);
      break;
    }
    const ex = s.to.x - s.drag.x;
    const ey = s.to.y - s.drag.y;
    if (Math.hypot(ex, ey) > 2) await moveBy(ex, ey, 2);
    else await frames(1);
  }
  await touch('touchEnd', []);
  await frames(2);
  const after = await look(holdId, limb);
  if (!after) return 'gone';
  if (after.on === holdId || after.busy || after.clipped.includes(holdId)) return 'ok';
  return `miss(${after.on})`;
}

/** Plan from the live stance (planBetaDetailed through the page) and execute it move by move. */
async function autoClimb({ until, maxMoves = 60, label }) {
  let moves = 0;
  let misses = 0;
  for (let replans = 0; replans < 8 && moves < maxMoves; replans++) {
    const plan = await page.evaluate(async () => {
      const j = window.__jgu;
      const sim = j.sim;
      const { planBetaDetailed } = await import('/src/game/solver.ts');
      const st = sim.getState();
      const ids = ['LH', 'RH', 'LF', 'RF'].map((l) => st.limbs[l].holdId);
      const b = sim.boulder;
      const lowHand = Math.min(...['LH', 'RH'].map((l) => b.holds.find((h) => h.id === st.limbs[l].holdId)?.y ?? st.chest.y));
      const r = planBetaDetailed(b, {
        start: ids,
        startPose: { px: st.pelvis.x, py: st.pelvis.y, cx: st.chest.x, cy: st.chest.y },
        maxNodes: b.mode === 'rope' ? 2600 : 900,
        clipped: st.clipped,
        goalY: b.height > 6 ? lowHand + 2.2 : undefined,
      });
      if (!r) return null;
      return r.steps.map((s) => ({ limb: s.move.limb, holdId: s.move.holdId, clip: s.clip ? { limb: s.clip.limb, id: s.clip.quickdrawId } : null }));
    });
    if (!plan || !plan.length) {
      log(`${label}: no plan from here`);
      return false;
    }
    log(`${label}: plan ${plan.length} moves`);
    let replan = false;
    for (const step of plan) {
      if (await until()) return true;
      if (step.holdId === 'smear') continue;
      const r = await dragMove(step.limb, step.holdId);
      moves++;
      if (r !== 'ok' && r !== 'skip') {
        misses++;
        log(`  ${step.limb}→${step.holdId}: ${r}`);
        replan = true;
        break;
      }
      if (step.clip) {
        const c = await dragMove(step.clip.limb, step.clip.id);
        log(`  clip ${step.clip.id} with ${step.clip.limb}: ${c}`);
        if (c === 'ok') await waitFor(() => !Object.values(window.__jgu.sim.getState().limbs).some((l) => l.busy), 'clip to finish', 30000);
      }
      if (await until()) return true;
    }
    if (!replan) {
      for (let k = 0; k < 40 && !(await until()); k++) await frames(1);
      if (await until()) return true;
    }
    if (misses > 12) break;
  }
  return await until();
}

// ───────────────────────────── Send Train: climb + send ─────────────────────────────
if (want('sendtrain')) {
  await tap('.title-play', 'PLAY');
  await waitScreen('modes');
  await page.waitForTimeout(900);
  await shot('modes');
  await tap('.mode-featured', 'Send Train');
  await waitScreen('preview', 90000);
  await veilClear();
  await page.waitForTimeout(1500);
  await shot('preview');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 60000);
  await page.waitForTimeout(600);
  await shot('climbing');
  const b = await page.evaluate(() => ({ name: window.__jgu.sim.boulder.name, grade: window.__jgu.sim.boulder.grade, angle: window.__jgu.sim.boulder.wallAngle }));
  log(`boulder ${b.name} V${b.grade} ${b.angle}°`);
  let midShot = false;
  const sent = await autoClimb({
    label: 'send-train',
    until: async () => {
      const ph = await page.evaluate(() => window.__jgu.sim?.getState().phase);
      if (!midShot && ph === 'climbing') {
        const y = await page.evaluate(() => window.__jgu.sim.getState().pelvis.y);
        if (y > 1.9) {
          midShot = true;
          await shot('climbing-mid');
        }
      }
      return ph === 'topped' || ph === 'falling' || ph === 'landed';
    },
  });
  const phase = await page.evaluate(() => window.__jgu.sim?.getState().phase);
  ok(sent && phase === 'topped', `Send Train boulder sent by touch drags (phase ${phase})`);
  await page.waitForTimeout(400);
  await shot('send-celebrate');
  const jgl = await page.evaluate(() => `${document.querySelector('.jgl')?.className} enabled=${window.__jgu.controls.enabled}`);
  ok(/is-hidden/.test(jgl), `limb handles hidden during the celebration (${jgl})`);
  await waitScreen('results', 60000);
  await page.waitForTimeout(3500);
  await shot('results-send');
  const res = await page.evaluate(() => document.querySelector('.stamp-txt')?.textContent ?? '');
  ok(/SENT/.test(res), `results show a send (${res})`);

  // the run goes on: boulder 02, then the first fall ends the run (forced fall: QA shortcut)
  await tapText('NEXT BOULDER');
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1200);
  const pv2 = await page.evaluate(() => document.querySelector('#ui')?.textContent ?? '');
  ok(/BOULDER 02/.test(pv2), 'NEXT BOULDER opens boulder 02 of the run');
  await shot('preview-boulder-02');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (02)', 60000);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__jgu.sim.forceFall());
  await page.waitForTimeout(700);
  await shot('fall');
  await waitScreen('results', 90000);
  await waitFor(() => /#\d+/.test(document.querySelector('#ui')?.textContent ?? ''), 'leaderboard rank on the results', 30000).catch(() => false);
  await page.waitForTimeout(3000);
  await shot('results-run-over');
  const ro = await page.evaluate(() => ({ stamp: document.querySelector('.stamp-txt')?.textContent ?? '', text: document.querySelector('#ui')?.textContent ?? '' }));
  ok(/RUN OVER|OFF|FALL/i.test(ro.stamp) || /RUN OVER/i.test(ro.text), `results show the run is over (${ro.stamp})`);
  ok(/#\d+/.test(ro.text), 'run-over results show the leaderboard rank');
  const best = await page.evaluate(() => window.__jgu.app.profile.best.boulder);
  ok(best > 0, `profile best updated (${best})`);
  await tapText('MENU');
  await waitScreen('modes', 60000);
  await veilClear();
  await page.waitForTimeout(900);
  await shot('modes-after-run');
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

// ───────────────────────────── menus ─────────────────────────────
if (want('leaderboard')) {
  await tapText('LEADERBOARD');
  await waitScreen('leaderboard');
  await waitFor(() => !document.querySelector('.lb-skel'), 'leaderboard rows', 30000);
  await page.waitForTimeout(900);
  await shot('leaderboard-sendtrain');
  await tapText('LEAD TOWER');
  await waitFor(() => !document.querySelector('.lb-skel'), 'rope rows', 30000);
  await page.waitForTimeout(700);
  await shot('leaderboard-rope');
  await tapText('DAILY');
  await waitFor(() => !document.querySelector('.lb-skel'), 'daily rows', 30000);
  await page.waitForTimeout(700);
  await shot('leaderboard-daily');
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

if (want('locker')) {
  // QA grant: the marmot head (normally earned by finishing the tutorial) so a head can be switched
  await page.evaluate(() => {
    const p = window.__jgu.app.profile;
    if (!p.unlocked.heads.includes('marmot')) p.unlocked.heads.push('marmot');
  });
  await tapText('LOCKER');
  await waitScreen('locker');
  await page.waitForTimeout(1500);
  await shot('locker');
  await page.locator('.lk-card', { hasText: 'Marmot' }).first().tap();
  await page.waitForTimeout(1500);
  await shot('locker-marmot');
  ok((await page.evaluate(() => window.__jgu.app.profile.head)) === 'marmot', 'locker equips the marmot head');
  await tapText('COLOURWAYS');
  await page.locator('.lk-card', { hasText: 'Glacier' }).first().tap();
  await page.waitForTimeout(1200);
  await shot('locker-glacier');
  await tap('.btn-back', 'back');
  await waitScreen('title');
  await page.waitForTimeout(1200);
  await shot('title-marmot');
}

if (want('settings')) {
  await tapText('SETTINGS');
  await waitScreen('settings');
  await page.waitForTimeout(900);
  await shot('settings');
  await tapText('HIGH');
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__jgu.app.profile.settings.quality)) === 'high', 'settings: quality HIGH applied + saved');
  ok((await page.evaluate(() => window.__jgu.renderer.getQuality())) === 'high', 'settings: renderer switched to HIGH');
  await tapText('LOW');
  await page.waitForTimeout(400);
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

if (want('community')) {
  await tapText('COMMUNITY');
  await waitScreen('community');
  await waitFor(() => !document.querySelector('.skel-card'), 'community cards', 30000);
  await page.waitForTimeout(900);
  await shot('community');
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

if (want('editor')) {
  await tapText('CREATE');
  await waitFor(() => window.__jgu.app.current === 'editor', 'editor open', 30000);
  await page.waitForTimeout(2500);
  await shot('editor');
  // place a few holds by tapping the wall
  const spots = [
    [0.4, 0.62],
    [0.6, 0.6],
    [0.5, 0.45],
    [0.35, 0.33],
    [0.55, 0.22],
  ];
  const before = await page.evaluate(() => window.__jgu.editor.getDraft().holds.length);
  for (const [fx, fy] of spots) {
    await page.touchscreen.tap(390 * fx, 844 * fy);
    await page.waitForTimeout(350);
    await frames(2);
  }
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.__jgu.editor.getDraft().holds.length);
  ok(after > before, `editor placed holds by tapping (${before} → ${after})`);
  await shot('editor-holds');

  // remix a generated sample, then TEST it: the app runs a test climb and hands back to the editor
  await tap('.ed-tool-more', 'editor menu');
  await tap('.ed-sample-go', 'LOAD sample');
  await tapText('REPLACE');
  await waitFor(() => {
    const d = window.__jgu.editor.getDraft();
    return d.holds.length > 8 && !document.querySelector('.ed-sample-go.is-busy');
  }, 'sample problem', 120000);
  await page.waitForTimeout(1500);
  await shot('editor-sample');
  await tap('.ed-test', 'TEST');
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1200);
  ok((await page.evaluate(() => window.__jgu.app.activeSession?.sim.boulder.holds.length ?? 0)) > 8, 'editor TEST starts a test climb of the draft');
  await shot('editor-test-preview');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'test climb start', 60000);
  await page.waitForTimeout(800);
  await tap('.hud-pause', 'pause');
  await waitScreen('pause');
  await tapText('QUIT');
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor reopened after the test', 60000);
  await veilClear();
  await page.waitForTimeout(1200);
  await shot('editor-after-test');
  ok(true, 'editor reopened with the draft after quitting the test climb');

  // publish through the app (the PUBLISH button itself unlocks only after a sent test climb)
  const pub = await page.evaluate(async () => {
    const j = window.__jgu;
    const before = j.app.profile.myProblems.length;
    const d = j.editor.getDraft();
    j.bus.emit('editor:publish', { boulder: { ...d, name: 'E2E Line' } });
    for (let i = 0; i < 100 && j.app.profile.myProblems.length === before; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 800));
    const list = await j.backend.listProblems({ sort: 'new', limit: 50 });
    return { mine: j.app.profile.myProblems.length - before, listed: list.some((p) => p.name === 'E2E Line') };
  });
  ok(pub.mine === 1 && pub.listed, `editor:publish saves to the profile and the community wall (${JSON.stringify(pub)})`);
  await page.waitForTimeout(600);
  await shot('editor-published-toast');

  await tap('.ed-x', 'close editor');
  await waitFor(() => window.__jgu.app.current === 'menu', 'editor closed', 30000);
  await waitScreen('title');
  await veilClear();
  await page.waitForTimeout(600);
  await shot('title-after-editor');
}

// ───────────────────────────── Daily + Community: start a climb, read the route, back out ─────────────────────────────
if (want('daily')) {
  await tap('.title-play', 'PLAY');
  await waitScreen('modes');
  await page.locator('.mode-card', { hasText: 'Daily' }).first().tap();
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1500);
  await shot('daily-preview');
  const d = await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id ?? '');
  ok(/daily/i.test(d), `Daily Boulder loads today's problem (${d})`);
  await tap('.pv-back', 'back');
  await waitScreen('modes', 60000);
  await veilClear();
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

if (want('communityplay')) {
  await tapText('COMMUNITY');
  await waitScreen('community');
  await waitFor(() => !document.querySelector('.skel-card'), 'community cards', 30000);
  await page.locator('#ui .cm-play, #ui .cm-card button').first().tap();
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1500);
  await shot('community-preview');
  ok((await page.evaluate(() => window.__jgu.app.activeSession?.boulder.holds.length ?? 0)) > 4, 'community problem loads for a climb');
  await tap('.pv-back', 'back');
  await waitScreen('community', 60000);
  await veilClear();
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

// ───────────────────────────── Lead Tower: clip a quickdraw ─────────────────────────────
if (want('lead')) {
  await page.evaluate(() => {
    window.__e2eClips = [];
    window.__jgu.bus.on('sim:event', (e) => {
      if (e.type === 'clip-done') window.__e2eClips.push(e.quickdrawId);
    });
  });
  await tap('.title-play', 'PLAY');
  await waitScreen('modes');
  await page.locator('.mode-card', { hasText: 'Lead Tower' }).first().tap();
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1500);
  await shot('lead-preview');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'lead climb start', 60000);
  await page.waitForTimeout(600);
  await shot('lead-climbing');
  const clipped = await autoClimb({
    label: 'lead',
    maxMoves: 30,
    until: async () => (await page.evaluate(() => window.__e2eClips.length > 0 || window.__jgu.sim?.getState().phase !== 'climbing')),
  });
  const clips = await page.evaluate(() => window.__e2eClips.slice());
  ok(clipped && clips.length > 0, `Lead Tower: clipped a quickdraw by touch (${clips.join(',') || 'none'})`);
  await page.waitForTimeout(500);
  await shot('lead-clipped');
  await tap('.hud-pause', 'pause');
  await waitScreen('pause');
  await page.waitForTimeout(500);
  await shot('lead-pause');
  await tapText('QUIT');
  await waitScreen('modes', 60000);
  await veilClear();
  await page.waitForTimeout(700);
  await shot('modes-after-lead');
}

// ───────────────────────────── report ─────────────────────────────
const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
ok(relevant.length === 0, `no console errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
if (warnings.length) console.log(`warnings (${warnings.length}):\n  ${[...new Set(warnings)].slice(0, 12).join('\n  ')}`);
log(`${failures ? failures + ' FAILURE(S)' : 'ALL PASSED'}`);
if (!args.includes('--keep')) await browser.close();
process.exit(failures ? 1 : 0);

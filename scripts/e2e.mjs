// End-to-end QA for JUST GO UP: drives the real game page like a player (taps + real touch drags
// through LimbControls) and screenshots every step.
//
// usage: node scripts/e2e.mjs [baseUrl] [--out dir] [--ts 3] [--q low] [--only a,b,c] [--keep]
//   baseUrl defaults to http://localhost:5207 (start the dev server first:
//   VITE_CACHE_DIR=node_modules/.vite-integration npx vite --config dev/e2e.vite.config.mjs --port 5207 --strictPort
//   — that config never reloads the page mid-run; restart it after source changes)
//   steps: onboarding, sendtrain, leaderboard, locker, human, settings, pure, profile, community, editor, editorcave, photo, daily, communityplay, lead, startover
//   (editorcave: a CAVE sample, a volume from the library with a crimp bolted onto it, TEST sent by the
//    sim's climbing bot inside the live session (a V6 roof by touch takes headless frames too long), PUBLISH)
//   (photo: IMPORT FROM PHOTO with a procedurally generated wall photo, the imported problem tested by touch)
//   (startover runs last: Settings → START OVER wipes the profile and reloads into the first-launch flow)
//   (pure: Settings → Pure climbing on, a Send Train problem climbed by touch with no HUD, then off again)
//   --only runs a subset (later steps seed a returning-player profile when onboarding is skipped).
//   --lead-retry forces a ground fall after the first clip (checks the lead step's TRY AGAIN path)
//   --max-min caps the whole run (minutes, default 150)
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
// a run that loses its browser (a container restart, a crashed renderer) fails loudly instead of
// leaving a top-level await unsettled; --max-min caps the whole run (default 150 game-QA minutes)
const maxMin = +opt('max-min', 150);
setTimeout(() => {
  console.log(`FAIL  the run exceeded ${maxMin} min`);
  process.exit(2);
}, maxMin * 60000).unref();
process.on('beforeExit', () => {
  console.log('FAIL  the run ended with work still pending (lost the browser?)');
  process.exitCode = 3;
});
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
// unhandled promise rejections fail the run too (the app reports them itself; this catches any that slip by)
await context.addInitScript(() => {
  window.addEventListener('unhandledrejection', (e) => console.error(`unhandledrejection: ${e.reason?.stack || e.reason}`));
});

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
await page.goto(`${base}/?debug=1&q=${q}&ts=${ts}`, { waitUntil: 'load', timeout: 180000 });
await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
// the last sim events (logged when a bot move misses, to say why)
await page.evaluate(() => {
  window.__e2eEv = [];
  window.__jgu.bus.on('sim:event', (e) => {
    if (e.type === 'overload' || e.type === 'shake-start' || e.type === 'shake-end') return;
    window.__e2eEv.push(JSON.stringify(e));
    if (window.__e2eEv.length > 24) window.__e2eEv.shift();
  });
});
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

/**
 * QA shortcut for a send: put the climber on the TOP hold matched, with the feet where the planned
 * beta ends (a bare respawn lets the sim pick feet, which on a traverse or a roof can't hold the
 * body and falls). The real send path (celebration, results, scoring) follows.
 */
const sendShortcut = () =>
  page.evaluate(async () => {
    const sim = window.__jgu.sim;
    const { planBeta } = await import('/src/game/solver.ts');
    const st = sim.getState();
    const at = { LF: st.limbs.LF.holdId, RF: st.limbs.RF.holdId };
    for (const m of planBeta(sim.boulder, { maxMs: 2000 }) ?? []) if (m.limb === 'LF' || m.limb === 'RF') at[m.limb] = m.holdId;
    const top = sim.boulder.holds.filter((h) => h.role === 'top').sort((a, b) => b.y - a.y)[0];
    sim.respawn({ LH: top.id, RH: top.id, LF: at.LF ?? undefined, RF: at.RF ?? undefined });
  });


/** Snapshot of where things are on screen for the climbing bot. */
async function look(holdId, limb, pt = null) {
  return page.evaluate(
    async ({ holdId, limb, pt }) => {
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
      // Pure climbing has no visible handles: a finger lands on the hand / foot itself
      const hp = j.controls.isPure ? null : j.controls.handlePosition(limb);
      const idx = { LH: 0, RH: 1, LF: 2, RF: 3 }[limb];
      const pair = limb === 'LH' ? 'RH' : limb === 'RH' ? 'LH' : limb === 'LF' ? 'RF' : 'LF';
      const h = sim.boulder.holds.find((x) => x.id === holdId);
      const q = sim.boulder.quickdraws?.find((x) => x.id === holdId);
      let to = null;
      if (h) to = contactPoint(h, idx, st.limbs[pair].holdId === h.id, { x: 0, y: 0 });
      else if (q) to = clipPoint(q, { x: 0, y: 0 });
      else if (pt) to = pt; // a planned smear: a spot on the bare wall
      const target = j.controls.target;
      const dragging = j.controls.dragging === limb;
      return {
        phase: st.phase,
        handle: hp ? { x: hp.x + cr.left, y: hp.y + cr.top } : j.controls.isPure ? scr(st.limbs[limb].pos, st.limbs[limb].depth) : null,
        from: scr(st.limbs[limb].pos, st.limbs[limb].depth),
        to: to ? scr(to) : null,
        drag: dragging ? scr(target) : null,
        candidate: dragging
          ? q
            ? sim.clipCandidate(limb, target)?.id ?? null
            : pt && !h
              ? Math.hypot(target.x - pt.x, target.y - pt.y) < 0.025
                ? holdId
                : null
              : sim.snapCandidate(limb, target)?.id ?? null
          : null,
        on: st.limbs[limb].holdId,
        smearing: !!st.limbs[limb].smearing,
        busy: st.limbs[limb].busy,
        clipped: st.clipped.slice(),
        camera: j.renderer.cameraMode,
      };
    },
    { holdId, limb, pt },
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

/**
 * Headless frames take ~0.7 s each, so a drag that a thumb makes in ~0.3 s spans seconds of game time
 * with that limb off. On hard test climbs (cave, photo) `fastFinger` holds the sim still while the
 * finger travels: the release still goes through LimbControls and the sim decides the grab.
 */
let fastFinger = false;
const holdSim = (on) => page.evaluate((on) => {
  const s = window.__jgu.app.activeSession;
  if (s?.driver) s.driver.paused = on;
}, on);

async function dragMove(limb, holdId, pt = null) {
  await settleHandle(limb);
  let s = await look(holdId, limb, pt);
  if (!s || s.phase !== 'climbing' || !s.handle || !s.to) return 'skip';
  let finger = { ...s.handle };
  if (fastFinger) await holdSim(true);
  try {
    return await dragMoveInner(limb, holdId, s, finger, pt);
  } finally {
    if (fastFinger) await holdSim(false);
  }
}

async function dragMoveInner(limb, holdId, s, finger, pt = null) {
  const startOn = s.on;
  await touch('touchStart', [finger]);
  await frames(1);
  s = await look(holdId, limb, pt);
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
    s = await look(holdId, limb, pt);
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
  const after = await look(holdId, limb, pt);
  if (!after) return 'gone';
  if (after.on === holdId || after.busy || after.clipped.includes(holdId)) return 'ok';
  // a planned smear that smears, or lands on a foothold instead, is just as good (as the sim's bot takes it)
  if (pt && (after.smearing || (after.on && after.on !== startOn))) return 'ok';
  const why = await page.evaluate(([l, id]) => {
    const sim = window.__jgu.sim;
    return sim && sim.getState().phase === 'climbing' ? (sim.reachableHolds(l).includes(id) ? 'in reach' : 'out of reach') : '';
  }, [limb, holdId]);
  return `miss(${after.on}) ${why}${s && s.to && !s.to.visible ? ' off-screen' : ''}`;
}

/**
 * A planned deadpoint (BetaMove.dyno 'LH' / 'RH') thrown like a player: drag the hand toward the
 * hold past its static reach, ease back a little, rest, then flick through and lift while moving.
 * The gesture's touch events carry timestamps from a virtual clock (headless frames take ~1 s, so
 * real dispatch times would turn every flick into a crawl). A double dyno ('both', a two-finger
 * flick on the hip handle) goes through the sim's dyno() as a QA shortcut.
 */
async function throwMove(kind, holdId) {
  const flightOver = () => page.evaluate(() => !window.__jgu.sim?.getState().flight);
  if (kind === 'both') {
    await page.evaluate((id) => {
      const j = window.__jgu;
      for (const e of j.sim.dyno('both', id, 1)) j.bus.emit('sim:event', e);
    }, holdId);
  } else {
    const limb = kind;
    await settleHandle(limb);
    const s = await look(holdId, limb);
    if (!s || s.phase !== 'climbing' || !s.handle || !s.to) return 'skip';
    let t = Date.now() / 1000;
    const tt = (type, pts, dt) => {
      t += dt;
      return cdp.send('Input.dispatchTouchEvent', { type, timestamp: t, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: 0, radiusX: 6, radiusY: 6, force: 1 })) });
    };
    const a = { ...s.handle };
    const b = { x: a.x + (s.to.x - s.from.x), y: a.y + (s.to.y - s.from.y) };
    const lerp = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
    await tt('touchStart', [a], 0);
    await frames(1);
    for (let i = 1; i <= 14; i++) await tt('touchMove', [lerp(a, b, (i / 14) ** 2 * (3 - 2 * (i / 14)))], 0.034);
    await frames(2);
    const back = lerp(a, b, 0.62);
    for (let i = 1; i <= 6; i++) await tt('touchMove', [lerp(b, back, i / 6)], 0.03);
    await frames(1);
    await tt('touchMove', [back], 0.2); // rest
    for (let i = 1; i <= 3; i++) await tt('touchMove', [lerp(back, b, i / 3)], 0.014);
    await tt('touchEnd', [], 0.008);
  }
  for (let k = 0; k < 60 && !(await flightOver()); k++) await frames(1);
  const on = await page.evaluate(([id, kind]) => {
    const st = window.__jgu.sim?.getState();
    if (!st) return false;
    return kind === 'both' ? st.limbs.LH.holdId === id && st.limbs.RH.holdId === id : st.limbs[kind].holdId === id;
  }, [holdId, kind]);
  return on ? 'ok' : 'thrown-miss';
}

/**
 * Weight shift through the hip handle: drag the hips toward a wall-local point (the planned reach
 * pose) and let go; the climber keeps the position. What a player does before a long reach.
 */
async function hipMove(target) {
  await settleHandle('HIP');
  const s = await page.evaluate((t) => {
    const j = window.__jgu;
    const st = j.sim?.getState();
    if (!st || st.phase !== 'climbing') return null;
    const cr = document.getElementById('controls').getBoundingClientRect();
    const gr = j.renderer.canvas.getBoundingClientRect();
    const a = j.renderer.wallToScreen(st.pelvis, st.pelvisDepth);
    const b = j.renderer.wallToScreen(t, st.pelvisDepth);
    // Pure climbing: the finger lands on the pelvis itself
    const hp = j.controls.isPure ? { x: a.x + gr.left - cr.left, y: a.y + gr.top - cr.top } : j.controls.handlePosition('HIP');
    return hp ? { handle: { x: hp.x + cr.left, y: hp.y + cr.top }, dx: b.x - a.x, dy: b.y - a.y, gr } : null;
  }, target);
  if (!s) return false;
  let finger = { ...s.handle };
  await touch('touchStart', [finger]);
  await frames(1);
  if ((await page.evaluate(() => window.__jgu.controls.dragging)) !== 'HIP') {
    await touch('touchEnd', []);
    return false;
  }
  for (let i = 1; i <= 6; i++) {
    finger = { x: s.handle.x + s.dx * 1.15 * (i / 6), y: s.handle.y + s.dy * 1.15 * (i / 6) };
    await touch('touchMove', [finger]);
    await frames(1);
  }
  await frames(6);
  await touch('touchEnd', []);
  await frames(2);
  return true;
}

/**
 * After a move, like a careful player: if a limb is overloaded (it would slip), shift the hips to
 * the stance the plan expects after that move, then give the body a moment to settle before the
 * next limb lets go.
 */
async function settleStance(stance) {
  const worst = () => page.evaluate(() => {
    const st = window.__jgu.sim?.getState();
    if (!st || st.phase !== 'climbing') return 0;
    return Math.max(...Object.values(st.limbs).map((l) => (l.holdId || l.smearing ? l.stress : 0)));
  });
  let w = await worst();
  if (w < 0.95) return;
  if (stance) {
    const far = await page.evaluate((t) => {
      const p = window.__jgu.sim?.getState().pelvis;
      return p ? Math.hypot(p.x - t.x, p.y - t.y) : 0;
    }, stance);
    if (far > 0.04) {
      await hipMove(stance);
      log(`  settle: stress ${w.toFixed(2)} → hips ${(far * 100).toFixed(0)} cm onto the planned stance`);
    }
  }
  for (let k = 0; k < 12 && (w = await worst()) >= 0.95; k++) await frames(2);
}

/** Rope: clip the next quickdraw as soon as a hand can reach it (what a lead climber does). */
async function tryClip() {
  const c = await page.evaluate(async () => {
    const sim = window.__jgu.sim;
    const b = sim?.boulder;
    if (!b || b.mode !== 'rope' || !b.quickdraws) return null;
    const st = sim.getState();
    if (st.phase !== 'climbing') return null;
    const next = b.quickdraws.find((q) => !st.clipped.includes(q.id));
    if (!next) return null;
    const { clipPoint } = await import('/src/game/holds.ts');
    const cp = clipPoint(next, { x: 0, y: 0 });
    for (const l of ['LH', 'RH']) {
      const L = st.limbs[l];
      if (L.busy || !L.holdId) continue;
      if (sim.clipCandidate(l, cp)) return { limb: l, id: next.id };
    }
    return null;
  });
  if (!c) return false;
  const r = await dragMove(c.limb, c.id);
  log(`  clip ${c.id} with ${c.limb}: ${r}`);
  if (r !== 'ok') return false;
  await waitFor(() => !Object.values(window.__jgu.sim.getState().limbs).some((l) => l.busy), 'clip to finish', 30000);
  return true;
}

/** Plan from the live stance (planBetaDetailed through the page) and execute it move by move. */
async function autoClimb({ until, maxMoves = 60, label, careful = false }) {
  let moves = 0;
  let misses = 0;
  /** Moves that missed from the current stance: the replan starts with another one (what the sim's bot does). */
  let avoid = [];
  for (let replans = 0; replans < 8 && moves < maxMoves; replans++) {
    const plan = await page.evaluate(async (avoid) => {
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
        avoid,
      });
      if (!r) return null;
      return r.steps.map((s) => ({
        limb: s.move.limb,
        holdId: s.move.holdId,
        dyno: s.move.dyno ?? null,
        hips: s.reachPose ? { x: s.reachPose.px, y: s.reachPose.py } : null,
        stance: s.pose ? { x: s.pose.px, y: s.pose.py } : null,
        clip: s.clip ? { limb: s.clip.limb, id: s.clip.quickdrawId } : null,
        smear: s.smear ? { x: s.smear.x, y: s.smear.y } : null,
      }));
    }, avoid);
    if (!plan || !plan.length) {
      log(`${label}: no plan from here`);
      return false;
    }
    log(`${label}: plan ${plan.length} moves`);
    let replan = false;
    for (const step of plan) {
      if (await until()) return true;
      if (await tryClip()) {
        if (await until()) return true;
      }
      // a planned smear: the foot onto that spot of bare wall (skipping it left the next reach short)
      if (step.holdId === 'smear' && !step.smear) continue;
      if (careful && !step.dyno && step.hips) {
        // a careful climber sets the hips for the reach first (what the sim's own bot does)
        const far = await page.evaluate((t) => {
          const p = window.__jgu.sim?.getState().pelvis;
          return p ? Math.hypot(p.x - t.x, p.y - t.y) : 0;
        }, step.hips);
        if (far > 0.08) await hipMove(step.hips);
      }
      let r = step.dyno ? await throwMove(step.dyno, step.holdId) : await dragMove(step.limb, step.holdId, step.smear);
      if (!step.dyno && r.startsWith('miss(') && step.hips) {
        // out of reach from where the hips are: shift the weight to the planned reach pose, try again
        const far = await page.evaluate((t) => {
          const p = window.__jgu.sim?.getState().pelvis;
          return p ? Math.hypot(p.x - t.x, p.y - t.y) : 0;
        }, step.hips);
        if (far > 0.04 && (await hipMove(step.hips))) {
          log(`  ${step.limb}→${step.holdId}: ${r}; hips ${(far * 100).toFixed(0)} cm toward the reach pose, again`);
          r = await dragMove(step.limb, step.holdId, step.smear);
        }
      }
      if (step.dyno) log(`  ${step.dyno === 'both' ? 'double dyno' : `deadpoint ${step.dyno}`} → ${step.holdId}: ${r}`);
      if (step.smear) log(`  ${step.limb} smears at ${step.smear.x.toFixed(2)},${step.smear.y.toFixed(2)}: ${r}`);
      moves++;
      if (r === 'ok') avoid = [];
      if (r !== 'ok' && r !== 'skip') {
        misses++;
        if (!avoid.some((m) => m.limb === step.limb && m.holdId === step.holdId)) avoid.push({ limb: step.limb, holdId: step.holdId });
        log(`  ${step.limb}→${step.holdId}: ${r}`);
        log(`    last sim events: ${(await page.evaluate(() => window.__e2eEv.slice(-8).join(' '))) || 'none'}`);
        replan = true;
        break;
      }
      if (r === 'ok' && !step.dyno) await settleStance(step.stance);
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

/** Chalk controls on the HUD right now (owner: boulders have none, lead keeps the chalk mechanic). */
const chalkHud = () =>
  page.evaluate(() => {
    const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.05;
    return {
      chips: [...document.querySelectorAll('.scr-hud .fa-chalk')].filter(vis).length,
      noChalk: !!document.querySelector('.scr-hud .no-chalk, .scr-hud.no-chalk'),
      matters: window.__jgu.sim?.chalkMatters ?? null,
    };
  });

/** Like a player who fell on a test climb: up to `tries` touch climbs, TRY AGAIN in between. */
async function testClimbByTouch(label, tries = 3, { fast = false } = {}) {
  let sent = false;
  let ph = 'gone';
  fastFinger = fast;
  for (let attempt = 1; attempt <= tries; attempt++) {
    sent = await autoClimb({
      label: `${label} #${attempt}`,
      careful: attempt > 1,
      until: async () => {
        const p = await page.evaluate(() => window.__jgu.sim?.getState().phase ?? 'gone');
        return p === 'topped' || p === 'falling' || p === 'landed' || p === 'gone';
      },
    });
    ph = await page.evaluate(() => window.__jgu.sim?.getState().phase ?? 'gone');
    if (ph === 'topped' || attempt === tries) break;
    log(`${label} attempt ${attempt} ended ${ph}: try again`);
    if (ph === 'climbing') await page.evaluate(() => window.__jgu.sim.forceFall());
    await waitScreen('results', 90000);
    await page.waitForTimeout(1200);
    await tapText('TRY AGAIN');
    await waitScreen('preview', 120000);
    await veilClear();
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', `${label} climb start (again)`, 60000);
    await page.waitForTimeout(600);
  }
  fastFinger = false;
  const done = sent && ph === 'topped';
  if (!done) {
    // not sent: back to the editor through the results (a send returns there by itself)
    if (ph === 'climbing') await page.evaluate(() => window.__jgu.sim.forceFall());
    await waitScreen('results', 90000).catch(() => false);
    if (await page.locator('#ui button', { hasText: 'EDITOR' }).count()) await tapText('EDITOR');
  }
  return { sent: done, phase: ph };
}

/**
 * The sim's own climbing bot (src/game/bot.ts BetaBot) drives the live session's sim, in game time
 * (it runs inside sim.step, so the session, HUD, results and editor hand-back are the real ones).
 * Used for the cave test climb: a V6 roof by touch drags takes headless frames far too long.
 */
async function botClimb(label, tries = 2) {
  let ph = 'gone';
  for (let attempt = 1; attempt <= tries; attempt++) {
    const r0 = await page.evaluate(async () => {
      const sim = window.__jgu.sim;
      const { BetaBot } = await import('/src/game/bot.ts');
      const bot = new BetaBot(sim);
      const step = sim.step.bind(sim);
      let ev = [];
      sim.step = (d) => {
        bot.update(d, ev);
        ev = step(d);
        return ev;
      };
      window.__e2eBot = bot;
      return { failed: bot.failed };
    });
    log(`${label} #${attempt}: the climbing bot takes over${r0.failed ? ' (no plan)' : ''}`);
    await waitFor(() => !['climbing', 'idle'].includes(window.__jgu.sim?.getState().phase ?? 'gone'), `${label} climb to end`, 900000).catch(() => false);
    ph = await page.evaluate(() => window.__jgu.sim?.getState().phase ?? 'gone');
    const moves = await page.evaluate(() => window.__e2eBot?.moves ?? 0);
    log(`${label} #${attempt}: ${ph} after ${moves} moves`);
    if (ph === 'topped' || attempt === tries) break;
    await waitScreen('results', 90000);
    await page.waitForTimeout(1200);
    await tapText('TRY AGAIN');
    await waitScreen('preview', 120000);
    await veilClear();
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', `${label} climb start (again)`, 60000);
    await page.waitForTimeout(600);
  }
  if (ph !== 'topped') {
    await waitScreen('results', 90000).catch(() => false);
    if (await page.locator('#ui button', { hasText: 'EDITOR' }).count()) await tapText('EDITOR');
  }
  return { sent: ph === 'topped', phase: ph };
}

/**
 * The sim's climbing bot (as botClimb) drives the live sim until `until()` holds or the climb ends, then
 * hands the climber back (the instance's step wrapper is removed, so the session's sim steps alone again).
 */
async function botUntil(label, until, timeout = 900000) {
  await page.evaluate(async () => {
    const sim = window.__jgu.sim;
    const { BetaBot } = await import('/src/game/bot.ts');
    const bot = new BetaBot(sim);
    const step = Object.getPrototypeOf(sim).step.bind(sim);
    let ev = [];
    sim.step = (d) => {
      bot.update(d, ev);
      ev = step(d);
      return ev;
    };
    window.__e2eBot = bot;
  });
  log(`${label}: the climbing bot takes over`);
  const t = Date.now();
  let done = false;
  while (Date.now() - t < timeout) {
    if ((done = await until())) break;
    if ((await page.evaluate(() => window.__jgu.sim?.getState().phase)) !== 'climbing') break;
    await page.waitForTimeout(400);
  }
  const r = await page.evaluate(() => {
    const sim = window.__jgu.sim;
    if (sim && Object.prototype.hasOwnProperty.call(sim, 'step')) delete sim.step;
    return { moves: window.__e2eBot?.moves ?? 0, phase: sim?.getState().phase ?? 'gone' };
  });
  log(`${label}: ${done ? 'done' : r.phase} after ${r.moves} bot moves; the player has the climber back`);
  return done;
}

/** The editor's problem check (the analyzer's beta reader) once it has settled: 'ok' / 'nobeta' / 'invalid'. */
const editorChip = async () => {
  await waitFor(() => ['ok', 'nobeta', 'invalid'].includes(document.querySelector('.ed-chip')?.dataset.status ?? ''), 'editor problem check', 90000);
  return page.evaluate(() => ({ status: document.querySelector('.ed-chip').dataset.status, text: document.querySelector('.ed-chip').textContent }));
};

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
  const ch = await chalkHud();
  ok(ch.chips === 0 && ch.noChalk && ch.matters === false, `boulder HUD: no CHALK controls, chalk doesn't matter on a boulder (${JSON.stringify(ch)})`);
  const b = await page.evaluate(() => ({ id: window.__jgu.sim.boulder.id, name: window.__jgu.sim.boulder.name, grade: window.__jgu.sim.boulder.grade, angle: window.__jgu.sim.boulder.wallAngle }));
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
  ok(/STREAK ×1/.test(pv2) && (await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id)) !== b.id, 'NEXT BOULDER opens the next problem of the run (streak ×1)');
  await shot('preview-boulder-02');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (02)', 60000);
  await page.waitForTimeout(600);
  // a hint: highlighted hold + ghost leader from the limb
  await tap('.hud-hint', 'HINT');
  await page.waitForTimeout(900);
  const ghost = await page.evaluate(() => !!document.querySelector('.jga-ghost:not(.off)'));
  ok(ghost, 'HINT shows the ghost leader to the suggested hold');
  await shot('hint');
  // route overview toggles the preview camera and back
  await tap('.hud-eye', 'LOOK');
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__jgu.renderer.cameraMode)) === 'preview', 'LOOK switches to the route overview');
  await page.waitForTimeout(6000);
  await shot('overview');
  await tap('.hud-eye', 'LOOK');
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__jgu.renderer.cameraMode)) === 'follow', 'LOOK again returns to the follow camera');
  // pause + resume
  await tap('.hud-pause', 'pause');
  await waitScreen('pause');
  await tapText('RESUME');
  await waitScreen('hud');
  ok((await page.evaluate(() => window.__jgu.controls.enabled)) === true, 'RESUME re-enables the limb controls');
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
  // TRY AGAIN: the boulder the run ended on, as a fresh run (same wall, streak and score back to 0)
  const fellOn = await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id);
  await tapText('TRY AGAIN');
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(900);
  const again = await page.evaluate(() => ({ id: window.__jgu.app.activeSession?.boulder.id, text: document.querySelector('#ui')?.textContent ?? '' }));
  ok(again.id === fellOn && !/STREAK ×[1-9]/.test(again.text), `TRY AGAIN replays the same boulder as a fresh run (${again.id})`);
  await shot('preview-try-again');
  // another fall → NEW RUN: new random problems
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (try again)', 60000);
  await page.evaluate(() => window.__jgu.sim.forceFall());
  await waitScreen('results', 90000);
  await page.waitForTimeout(1500);
  await shot('results-run-over-2');
  await tapText('NEW RUN');
  await waitScreen('preview', 120000);
  await veilClear();
  const fresh = await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id);
  ok(!!fresh && fresh !== fellOn, `NEW RUN starts new random problems (${fresh})`);
  await tap('.pv-back', 'back');
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

// ───────────────────────────── the plain human climber, end to end ─────────────────────────────
if (want('human')) {
  // locker: the human (free) is equippable; its 3D portrait renders; the voice follows the head
  await tapText('LOCKER');
  await waitScreen('locker');
  await page.waitForTimeout(1200);
  await page.locator('.lk-card', { hasText: 'Human' }).first().tap();
  await page.waitForTimeout(1500);
  await shot('locker-human');
  const hl = await page.evaluate(() => ({
    head: window.__jgu.app.profile.head,
    voice: window.__jgu.audio.voiceId,
    portrait: document.querySelector('#ui img[data-head="human"]')?.getAttribute('src')?.slice(0, 22) ?? '',
  }));
  ok(hl.head === 'human', `locker equips the human head (${hl.head})`);
  ok(hl.voice === 'human', `the climber's voice follows the human head (${hl.voice})`);
  ok(hl.portrait.startsWith('data:image/png'), `the human head has a rendered 3D portrait (${hl.portrait})`);
  await tap('.btn-back', 'back');
  await waitScreen('title');
  await page.waitForTimeout(1500);
  await shot('title-human');
  // profile: the hero portrait and the head name
  await tapText('PROFILE');
  await waitScreen('profile');
  await page.waitForTimeout(900);
  const pf = await page.evaluate(() => ({ img: !!document.querySelector('.pf-pt img[data-head="human"]'), text: document.querySelector('#ui')?.textContent ?? '' }));
  ok(pf.img && /HUMAN/i.test(pf.text), 'profile shows the human climber');
  await shot('profile-human');
  await tap('.btn-back', 'back');
  await waitScreen('title');
  // a run as the human: one send (QA shortcut: matched on TOP), then a fall ends it and submits
  await tap('.title-play', 'PLAY');
  await waitScreen('modes');
  await tap('.mode-featured', 'Send Train');
  await waitScreen('preview', 120000);
  await veilClear();
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (human)', 60000);
  await page.waitForTimeout(800);
  await shot('climbing-human');
  await sendShortcut();
  await waitScreen('results', 120000);
  await tapText('NEXT BOULDER');
  await waitScreen('preview', 120000);
  await veilClear();
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (human 2)', 60000);
  await page.evaluate(() => window.__jgu.sim.forceFall());
  await waitScreen('results', 90000);
  await waitFor(() => /#\d+/.test(document.querySelector('#ui')?.textContent ?? ''), 'rank (human run)', 30000).catch(() => false);
  await tapText('MENU');
  await waitScreen('modes', 60000);
  await veilClear();
  await tap('.btn-back', 'back');
  await waitScreen('title');
  // leaderboard: the player's row carries the human icon, next to the ghost climbers (one is human too)
  await tapText('LEADERBOARD');
  await waitScreen('leaderboard');
  await tapText('SEND TRAIN'); // the board remembers the last tab
  await waitFor(() => !document.querySelector('.lb-skel'), 'leaderboard rows (human)', 30000);
  await page.waitForTimeout(900);
  const lb = await page.evaluate(async () => {
    const rows = await window.__jgu.backend.topScores('boulder', { limit: 100 });
    const me = window.__jgu.app.profile.playerName;
    return {
      mine: rows.some((r) => r.player === me && r.head === 'human'),
      ghost: rows.some((r) => r.id?.startsWith('ghost-') && r.head === 'human'),
      icons: document.querySelectorAll('#ui img[data-head="human"]').length,
    };
  });
  ok(lb.mine, 'the run is on the board under the human head');
  ok(lb.ghost, 'a ghost climber wears the human head too');
  ok(lb.icons >= 2, `the Send Train board shows the human icon on the player's row and the ghost's (${lb.icons} rows)`);
  await shot('leaderboard-human');
  await tap('.btn-back', 'back');
  await waitScreen('title');
  // back to the ibex for the rest of the run
  await page.evaluate(() => window.__jgu.bus.emit('ui:select-head', { head: 'ibex' }));
  await page.waitForTimeout(600);
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

// ───────────────────────────── Pure climbing: no HUD, the body is the feedback ─────────────────────────────
if (want('pure')) {
  /** What the overlay canvas still shows (Pure mode should leave it empty): its bounding box + a PNG. */
  const dumpOverlay = async (name) => {
    const o = await page.evaluate(() => window.__e2eOverlay ?? null);
    if (!o) return;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${out}/${name}.png`, Buffer.from(o.url.split(',')[1], 'base64'));
    log(`overlay pixels left in ${JSON.stringify(o.box)} (device px) -> ${name}.png`);
  };
  const hudVisible = () =>
    page.evaluate(() => {
      const vis = (sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.05);
      return {
        meters: vis('.scr-hud .hud-inst') || vis('.scr-hud .hud-route') || vis('.scr-hud .hud-score') || vis('.scr-hud .hud-topprog.on'),
        hint: vis('.scr-hud .hud-hint'),
        look: vis('.scr-hud .hud-eye'),
        pause: vis('.scr-hud .hud-pause'),
        handles: [...document.querySelectorAll('.jgl .jgl-h')].filter((h) => !h.classList.contains('is-drag')).some((h) => +getComputedStyle(h).opacity > 0.02),
        canvas: (() => {
          // the overlay canvas draws nothing in Pure mode (no leaders, reach arcs, grip tags)
          const c = document.querySelector('.jgl canvas');
          if (!c || !c.width) return false;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let box = null;
          for (let i = 3; i < d.length; i += 16)
            if (d[i] > 8) {
              const px = ((i - 3) / 4) % c.width;
              const py = Math.floor((i - 3) / 4 / c.width);
              box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py];
            }
          if (box) window.__e2eOverlay = { box, url: c.toDataURL('image/png') };
          return !!box;
        })(),
      };
    });
  await tapText('SETTINGS');
  await waitScreen('settings');
  await page.waitForTimeout(900);
  await page.locator('#ui .row-pure').scrollIntoViewIfNeeded();
  await shot('settings-pure-off');
  await page.locator('#ui .row-pure').tap();
  await page.waitForTimeout(500);
  await shot('settings-pure-on');
  const ps = await page.evaluate(() => ({
    setting: window.__jgu.app.profile.settings.pure,
    stored: localStorage.getItem('jgu.pure.v1'),
    ui: document.getElementById('ui').classList.contains('is-pure'),
    jgl: !!document.querySelector('.jgl.is-pure'),
    aria: document.querySelector('#ui .row-pure')?.getAttribute('aria-checked'),
  }));
  ok(ps.setting === true && ps.stored === '1' && ps.aria === 'true', `settings: Pure climbing on, saved with the profile (${JSON.stringify(ps)})`);
  ok(ps.ui && ps.jgl, 'Pure climbing applies live (HUD + limb controls)');
  await tap('.btn-back', 'back');
  await waitScreen('title');
  // the tutorial teaches with the HUD: Pure climbing is suspended for the lesson and comes back after
  await page.evaluate(() => window.__jgu.bus.emit('ui:tutorial'));
  await waitFor(() => window.__jgu.app.current === 'tutorial', 'tutorial (pure setting)', 60000);
  await veilClear();
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1500);
  const tut = await page.evaluate(() => ({
    ui: document.getElementById('ui').classList.contains('is-pure'),
    jgl: !!document.querySelector('.jgl.is-pure'),
    hud: !!document.querySelector('.scr-hud .hud-inst')?.getClientRects().length,
    setting: window.__jgu.app.profile.settings.pure,
  }));
  await shot('tutorial-pure-setting');
  ok(!tut.ui && !tut.jgl && tut.hud && tut.setting === true, `tutorial runs with the full HUD while the Pure setting stays on (${JSON.stringify(tut)})`);
  await tap('.gb-skip', 'SKIP tutorial');
  await waitScreen('title', 60000);
  await veilClear();
  ok(await page.evaluate(() => document.getElementById('ui').classList.contains('is-pure') && !!document.querySelector('.jgl.is-pure')), 'Pure climbing is back once the tutorial ends');
  // a fixed, honest first problem for the run: a short vertical / slab line the planner climbs with no
  // throws (the run's own seeding formula, searched in the page; the run class is restored after)
  const pureSeed = await page.evaluate(async () => {
    const { Rng, hashString } = await import('/src/core/rng.ts');
    const { runGradeFor } = await import('/src/game/scoring.ts');
    const { generateBoulder } = await import('/src/game/generator.ts');
    const { planBeta } = await import('/src/game/solver.ts');
    const { ROUTE_COLORS } = await import('/src/config/brand.ts');
    let best = null;
    for (let s = 2000; s < 2060; s++) {
      const rng = new Rng(hashString(`send-train:${s}:0`));
      const grade = runGradeFor(0, rng);
      const b = generateBoulder({ seed: rng.int(1, 0x7ffffffe), grade, colorIndex: rng.int(0, ROUTE_COLORS.length - 1), run: { seed: s, index: 0 } });
      if (b.style !== 'vertical' && b.style !== 'slab') continue;
      const beta = planBeta(b, { maxMs: 400 });
      if (beta && !beta.some((m) => m.dyno) && (!best || beta.length < best.moves)) best = { s, name: b.name, moves: beta.length, style: b.style };
    }
    return best;
  });
  log(`pure: run seed ${JSON.stringify(pureSeed)}`);
  if (pureSeed)
    await page.evaluate(async (seed) => {
      const m = await import('/src/app/runs.ts');
      const C = m.SendTrainRun;
      if (!C.__origReset) C.__origReset = C.prototype.reset;
      C.prototype.reset = function () {
        C.__origReset.call(this);
        this.seed = seed;
      };
    }, pureSeed.s);
  await tap('.title-play', 'PLAY');
  await waitScreen('modes');
  await tap('.mode-featured', 'Send Train');
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1500);
  await shot('preview-pure');
  ok(await page.evaluate(() => !document.querySelector('.scr-preview .pv-legend')?.getClientRects().length && !document.querySelector('.scr-preview .pv-tip-slot')?.getClientRects().length), 'Pure preview: no START / TOP legend, no tip');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (pure)', 60000);
  await page.waitForTimeout(900);
  await shot('climbing-pure');
  let hv = await hudVisible();
  ok(!hv.meters && !hv.hint && !hv.look && hv.pause, `Pure HUD: no meters, no hint, no LOOK, a faint pause stays (${JSON.stringify(hv)})`);
  ok(!hv.handles && !hv.canvas, `Pure controls: no handles, leaders or arcs until a finger lands (${JSON.stringify(hv)})`);
  if (hv.canvas) await dumpOverlay('pure-overlay-left');
  // a finger on the right hand picks it: only a faint ring shows
  const ring = await page.evaluate(() => {
    const j = window.__jgu;
    const st = j.sim.getState();
    const gr = j.renderer.canvas.getBoundingClientRect();
    const s = j.renderer.wallToScreen(st.limbs.RH.pos, st.limbs.RH.depth);
    return { x: s.x + gr.left, y: s.y + gr.top };
  });
  await touch('touchStart', [ring]);
  await frames(2);
  await touch('touchMove', [{ x: ring.x + 4, y: ring.y - 6 }]);
  await frames(3);
  const held = await page.evaluate(() => ({ drag: window.__jgu.controls.dragging, ring: [...document.querySelectorAll('.jgl .jgl-h.is-drag')].length, highlights: window.__jgu.renderer.highlightCount?.() ?? null }));
  await shot('pure-touch-ring');
  ok(held.drag === 'RH' && held.ring === 1, `Pure: a finger on the hand picks it and shows one faint ring (${JSON.stringify(held)})`);
  hv = await hudVisible();
  ok(!hv.canvas, 'Pure drag: no reach arc, leader or grip tag drawn');
  if (hv.canvas) await dumpOverlay('pure-overlay-drag');
  await touch('touchMove', [ring]);
  await frames(1);
  await touch('touchEnd', []);
  await frames(4);
  // climb it by touch, like the Send Train step, with the fingers on the limbs themselves
  let midPure = false;
  const sentPure = await autoClimb({
    label: 'pure',
    until: async () => {
      const ph = await page.evaluate(() => window.__jgu.sim?.getState().phase);
      if (!midPure && ph === 'climbing' && (await page.evaluate(() => window.__jgu.sim.getState().pelvis.y)) > 1.7) {
        midPure = true;
        await shot('climbing-pure-mid');
        const m = await hudVisible();
        ok(!m.meters && !m.hint && !m.handles, 'Pure mid-climb: still no HUD or handles');
      }
      return ph === 'topped' || ph === 'falling' || ph === 'landed';
    },
  });
  const phPure = await page.evaluate(() => window.__jgu.sim?.getState().phase);
  ok(sentPure && phPure === 'topped', `Pure: the problem is climbed by touch without a HUD (phase ${phPure})`);
  await waitScreen('results', 120000);
  await page.waitForTimeout(2500);
  await shot('results-pure');
  // the run ends (forced fall on the next problem: QA shortcut), back to the menu, Pure off again
  if (await page.locator('#ui button', { hasText: 'NEXT BOULDER' }).count()) {
    await tapText('NEXT BOULDER');
    await waitScreen('preview', 120000);
    await veilClear();
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start (pure 2)', 60000);
    await page.evaluate(() => window.__jgu.sim.forceFall());
    await waitScreen('results', 90000);
    await page.waitForTimeout(1500);
  }
  await tapText('MENU');
  await waitScreen('modes', 60000);
  await veilClear();
  await tap('.btn-back', 'back');
  await waitScreen('title');
  await page.evaluate(async () => {
    const C = (await import('/src/app/runs.ts')).SendTrainRun;
    if (C.__origReset) C.prototype.reset = C.__origReset;
  });
  await tapText('SETTINGS');
  await waitScreen('settings');
  await page.locator('#ui .row-pure').tap();
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => ({ setting: window.__jgu.app.profile.settings.pure, stored: localStorage.getItem('jgu.pure.v1'), ui: document.getElementById('ui').classList.contains('is-pure') }));
  ok(off.setting === false && off.stored === '0' && !off.ui, `settings: Pure climbing off again (${JSON.stringify(off)})`);
  await tap('.btn-back', 'back');
  await waitScreen('title');
}

if (want('profile')) {
  await tapText('PROFILE');
  await waitScreen('profile');
  await page.waitForTimeout(1200);
  await shot('profile');
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

  // remix a generated sample (the easiest grade, so the climbing bot sends it reliably), then TEST
  // it: the app runs a test climb and hands back to the editor
  await tap('.ed-tool-more', 'editor menu');
  for (let k = 0; k < 6 && (await page.evaluate(() => document.querySelector('.ed-sample-v')?.textContent)) !== 'V0'; k++) {
    await tap('#ui button[aria-label="Easier"]', 'sample: easier');
  }
  await tap('.ed-sample-go', 'LOAD sample');
  // a fixed sample seed (the editor draws it from Math.random once REPLACE is confirmed), so every
  // run tests and publishes the same problem: "Opposable", V0 vertical, sent 3/3 by the sim's bot
  await page.evaluate(() => {
    window.__e2eRandom = Math.random;
    Math.random = () => 0.4;
  });
  await tapText('REPLACE');
  await waitFor(() => {
    const d = window.__jgu.editor.getDraft();
    return d.holds.length > 8 && !document.querySelector('.ed-sample-go.is-busy');
  }, 'sample problem', 120000);
  await page.evaluate(() => {
    Math.random = window.__e2eRandom;
  });
  log(`sample: ${await page.evaluate(() => window.__jgu.editor.getDraft().name)}`);
  await page.waitForTimeout(1500);
  await shot('editor-sample');
  ok(await page.evaluate(() => document.querySelector('.ed-pub')?.disabled === true), 'PUBLISH is locked before a sent test climb');

  // first TEST: back out from the pause sheet → the editor comes back with the draft
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
  ok(await page.evaluate(() => document.querySelector('.ed-pub')?.disabled === true), 'quitting the test climb keeps PUBLISH locked');

  // second TEST: send it for real (touch drags), which unlocks PUBLISH
  await tap('.ed-test', 'TEST');
  await waitScreen('preview', 120000);
  await veilClear();
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'test climb start (2)', 60000);
  await page.waitForTimeout(600);
  // like a player: a fall on the test climb → TRY AGAIN (a random sample can be awkward for the bot)
  let testSent = false;
  let testPhase = 'gone';
  for (let attempt = 1; attempt <= 3; attempt++) {
    testSent = await autoClimb({
      label: `editor-test #${attempt}`,
      careful: attempt > 1,
      until: async () => {
        const ph = await page.evaluate(() => window.__jgu.sim?.getState().phase ?? 'gone');
        return ph === 'topped' || ph === 'falling' || ph === 'landed' || ph === 'gone';
      },
    });
    testPhase = await page.evaluate(() => window.__jgu.sim?.getState().phase ?? 'gone');
    if (testPhase === 'topped' || attempt === 3) break;
    log(`editor test climb attempt ${attempt} ended ${testPhase}: try again`);
    if (testPhase === 'climbing') {
      await page.evaluate(() => window.__jgu.sim.forceFall());
    }
    await waitScreen('results', 90000);
    await page.waitForTimeout(1200);
    await tapText('TRY AGAIN');
    await waitScreen('preview', 120000);
    await veilClear();
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'test climb start (again)', 60000);
    await page.waitForTimeout(600);
  }
  ok(testSent && testPhase === 'topped', `editor test climb sent by touch drags (phase ${testPhase})`);
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor reopened after the send', 90000);
  await veilClear();
  await waitFor(() => document.querySelector('.ed-pub')?.disabled === false, 'PUBLISH unlocked', 30000).catch(() => false);
  await page.waitForTimeout(900);
  await shot('editor-publish-unlocked');
  ok(await page.evaluate(() => document.querySelector('.ed-pub')?.disabled === false), 'a sent test climb unlocks PUBLISH');

  // publish through the real button + confirm dialog
  const prePub = await page.evaluate(() => window.__jgu.app.profile.myProblems.length);
  await tap('.ed-pub', 'PUBLISH');
  await tap('.modal-ok', 'confirm PUBLISH');
  await waitFor((n) => window.__jgu.app.profile.myProblems.length > n, 'published problem saved', 30000, prePub);
  await page.waitForTimeout(1500);
  const pub = await page.evaluate(async () => {
    const j = window.__jgu;
    const mine = j.app.profile.myProblems;
    const name = mine[mine.length - 1]?.name;
    const list = await j.backend.listProblems({ sort: 'new', limit: 50 });
    return { mine: mine.length, listed: list.some((p) => p.name === name), name };
  });
  ok(pub.mine === prePub + 1 && pub.listed, `PUBLISH saves to the profile and the community wall (${JSON.stringify(pub)})`);
  await shot('editor-published-toast');

  await tap('.ed-x', 'close editor');
  await waitFor(() => window.__jgu.app.current === 'menu', 'editor closed', 30000);
  await waitScreen('title');
  await veilClear();
  await page.waitForTimeout(600);
  await shot('title-after-editor');
}

// ───────────────────────────── Editor: a cave problem with a volume + a hold bolted onto it ─────────────────────────────
/** A fixed CAVE sample for the editor (Math.random drives the sample seed): sent by touch in the e2e. */
const CAVE_RANDOM = +opt('cave-random', 0.11);
const CAVE_GRADE = +opt('cave-grade', 1);
if (want('editorcave')) {
  await tapText('CREATE');
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor open (cave)', 30000);
  await veilClear();
  await page.waitForTimeout(2000);
  // the menu: style CAVE, the sample grade, LOAD (fixed seed), REPLACE when the wall has holds
  await tap('.ed-tool-more', 'editor menu');
  await page.evaluate(() => [...document.querySelectorAll('.ed-style')].find((b) => b.textContent === 'CAVE')?.click());
  await frames(2);
  const gradeNow = () => page.evaluate(() => +(document.querySelector('.ed-sample-v')?.textContent ?? 'V0').replace(/\D/g, ''));
  for (let k = 0; k < 12 && (await gradeNow()) > CAVE_GRADE; k++) await tap('#ui button[aria-label="Easier"]', 'sample: easier');
  for (let k = 0; k < 12 && (await gradeNow()) < CAVE_GRADE; k++) await tap('#ui button[aria-label="Harder"]', 'sample: harder');
  await page.evaluate((r) => {
    window.__e2eRandom = Math.random;
    Math.random = () => r;
  }, CAVE_RANDOM);
  await tap('.ed-sample-go', 'LOAD sample');
  if (await page.locator('.modal-ok').count()) await tap('.modal-ok', 'REPLACE');
  await waitFor(() => window.__jgu.editor.getDraft().style === 'cave' && !document.querySelector('.ed-sample-go.is-busy'), 'cave sample', 120000);
  await page.evaluate(() => {
    Math.random = window.__e2eRandom;
  });
  await page.evaluate(() => [...document.querySelectorAll('.ed-style')].find((b) => b.textContent === 'ANY')?.click());
  if (await page.locator('.ed-tool-more.is-on, .ed-drawer.is-open').count()) await tap('.ed-tool-more', 'close menu');
  const cave = await page.evaluate(() => {
    const d = window.__jgu.editor.getDraft();
    return { name: d.name, style: d.style, panels: d.profile?.map((p) => p.angle) ?? [], holds: d.holds.length };
  });
  log(`cave sample: ${JSON.stringify(cave)}`);
  ok(cave.style === 'cave' && cave.panels.length >= 3 && Math.max(...cave.panels) >= 60, `editor: a CAVE sample on a folded wall (${cave.name}: ${cave.panels.join('/')}°)`);
  await page.waitForTimeout(1500);
  await shot('editor-cave-sample');

  // a clear patch of wall, away from the planned beta, for a volume from the library
  const spot = await page.evaluate(async () => {
    const j = window.__jgu;
    const d = j.editor.getDraft();
    const { planBeta } = await import('/src/game/solver.ts');
    const used = new Set((planBeta(d, { maxMs: 1500 }) ?? []).map((m) => m.holdId));
    let best = null;
    for (let y = 0.7; y < Math.min(d.height - 0.6, 2.6); y += 0.1) {
      for (let x = -d.width / 2 + 0.5; x <= d.width / 2 - 0.5; x += 0.1) {
        const clear = Math.min(...d.holds.map((h) => Math.hypot(h.x - x, h.y - y) - (h.type === 'volume' ? h.size : 0.05)));
        const near = Math.min(9, ...d.holds.filter((h) => used.has(h.id)).map((h) => Math.hypot(h.x - x, h.y - y)));
        const sp = j.renderer.wallToScreen({ x, y }, 0);
        if (!sp.visible || clear < 0.5) continue;
        const score = Math.min(clear, 0.9) + Math.min(near, 1.2) * 0.6;
        if (!best || score > best.score) best = { x: +x.toFixed(2), y: +y.toFixed(2), score };
      }
    }
    return best;
  });
  log(`volume spot: ${JSON.stringify(spot)}`);
  const surfaceTap = async (w, lift = 0) => {
    const sp = await page.evaluate(([w, lift]) => {
      const j = window.__jgu;
      const s = j.renderer.wallToScreen(w, lift);
      const g = j.renderer.canvas.getBoundingClientRect();
      return { x: s.x + g.left, y: s.y + g.top };
    }, [w, lift]);
    await page.touchscreen.tap(sp.x, sp.y);
    await page.waitForTimeout(600);
    await frames(2);
  };
  const nBefore = await page.evaluate(() => window.__jgu.editor.getDraft().holds.length);
  await tap('.ed-pal-tab-volumes', 'palette: VOLUMES');
  await page.evaluate(() => document.querySelector('.ed-tile-v-wedge')?.click());
  await frames(2);
  if (spot) await surfaceTap(spot);
  const vol = await page.evaluate(([n, sp]) => {
    const d = window.__jgu.editor.getDraft();
    const v = sp && d.holds.find((h) => h.type === 'volume' && Math.hypot(h.x - sp.x, h.y - sp.y) < 0.25);
    return v ? { id: v.id, x: v.x, y: v.y, n: d.holds.length - n } : null;
  }, [nBefore, spot]);
  ok(!!vol && vol.n === 1, `editor: a WEDGE from the volume library set on the cave wall (${JSON.stringify(vol)})`);
  // a crimp bolted onto its face
  await page.evaluate(() => window.__jgu.editor['select'](null));
  await tap('.ed-pal-tab-holds', 'palette: HOLDS');
  await page.evaluate(() => document.querySelector('.ed-tile-crimp')?.click());
  await frames(2);
  if (vol) await surfaceTap({ x: vol.x + 0.08, y: vol.y + 0.02 }, 0.06);
  const mount = await page.evaluate((vid) => {
    const h = window.__jgu.editor.getDraft().holds.find((x) => vid && x.onVolume === vid);
    return h ? { id: h.id, type: h.type, onVolume: h.onVolume } : null;
  }, vol?.id ?? null);
  ok(!!mount && mount.type === 'crimp', `editor: a crimp bolted onto the volume (${JSON.stringify(mount)})`);
  await page.evaluate(() => window.__jgu.editor['select'](null));
  await page.waitForTimeout(1200);
  await shot('editor-cave-volume');
  const chip = await editorChip();
  ok(chip.status === 'ok', `editor problem check reads the cave + volume problem (${chip.text})`);

  // TEST, sent by touch (the run carries the volume and its bolted-on crimp), then PUBLISH
  await tap('.ed-test', 'TEST');
  await waitScreen('preview', 120000);
  await veilClear();
  const tb = await page.evaluate((mid) => {
    const b = window.__jgu.app.activeSession?.sim.boulder;
    return { panels: b?.profile?.length ?? 0, mounted: !!b?.holds.some((h) => h.id === mid && h.onVolume) };
  }, mount?.id ?? '');
  ok(tb.panels >= 3 && tb.mounted, `the test climb is the cave with the bolted-on crimp (${JSON.stringify(tb)})`);
  await page.waitForTimeout(1000);
  await shot('editor-cave-test-preview');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'cave test climb start', 60000);
  await page.waitForTimeout(600);
  await page.waitForTimeout(1200);
  await shot('editor-cave-climbing');
  const caveRun = await botClimb('editor-cave-test');
  ok(caveRun.sent, `the cave problem is sent on its test climb (phase ${caveRun.phase})`);
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor back after the cave test', 90000);
  await veilClear();
  await waitFor(() => document.querySelector('.ed-pub')?.disabled === false, 'PUBLISH unlocked (cave)', 30000).catch(() => false);
  await page.waitForTimeout(800);
  if (ok(await page.evaluate(() => document.querySelector('.ed-pub')?.disabled === false), 'the cave test send unlocks PUBLISH')) {
    const pre = await page.evaluate(() => window.__jgu.app.profile.myProblems.length);
    await tap('.ed-pub', 'PUBLISH');
    await tap('.modal-ok', 'confirm PUBLISH');
    await waitFor((n) => window.__jgu.app.profile.myProblems.length > n, 'cave problem published', 30000, pre);
    const pub = await page.evaluate(async () => {
      const j = window.__jgu;
      const mine = j.app.profile.myProblems;
      const last = mine[mine.length - 1];
      const list = await j.backend.listProblems({ sort: 'new', limit: 50 });
      const row = list.find((p) => p.name === last?.name);
      return { name: last?.name, listed: !!row, panels: row?.boulder.profile?.length ?? 0, mounted: !!row?.boulder.holds.some((h) => h.onVolume) };
    });
    ok(pub.listed && pub.panels >= 3 && pub.mounted, `PUBLISH puts the cave problem (folds + bolted-on hold) on the community wall (${JSON.stringify(pub)})`);
    await page.waitForTimeout(1200);
    await shot('editor-cave-published');
  }
  await tap('.ed-x', 'close editor');
  await waitFor(() => window.__jgu.app.current === 'menu', 'editor closed (cave)', 30000);
  await waitScreen('title');
  await veilClear();
}

// ───────────────────────────── Photo → route: a generated wall photo through the editor's importer ─────────────────────────────
if (want('photo')) {
  // a procedurally generated phone photo of a yellow problem (src/photo/synth.ts; no real photos are bundled)
  const sample = await page.evaluate(async () => {
    const { synthPhoto } = await import('/src/photo/synth.ts');
    const s = synthPhoto({ photoW: 900, photoH: 1200, ppm: 200, seed: 3, view: 'below', route: '#F2C230', wall: 'charcoal' });
    const c = document.createElement('canvas');
    c.width = s.photo.width;
    c.height = s.photo.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.photo.data), s.photo.width, s.photo.height), 0, 0);
    return { url: c.toDataURL('image/png'), quad: s.quad, w: s.photo.width, h: s.photo.height, route: s.holds.filter((h) => h.route).length };
  });
  log(`photo: ${sample.w}x${sample.h}, ${sample.route} route holds painted`);
  await tapText('CREATE');
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor open (photo)', 30000);
  await veilClear();
  await page.waitForTimeout(1500);
  const tapBox = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  };
  await page.evaluate(() => document.querySelector('.ed-photo-go').click());
  await page.waitForTimeout(600);
  if (await page.locator('.modal-ok').count()) await tap('.modal-ok', 'IMPORT (replaces the draft)');
  await page.waitForSelector('.ph', { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot('photo-open');
  await page.setInputFiles('.ph-file >> nth=1', { name: 'wall.png', mimeType: 'image/png', buffer: Buffer.from(sample.url.split(',')[1], 'base64') });
  await waitFor(() => document.querySelector('.ph')?.dataset.step === 'frame', 'photo: corners step', 60000);
  await page.waitForTimeout(600);
  // the four corners onto the wall's corners (the FRAME view fits the photo into the stage, 28 px padding)
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
  await shot('photo-corners');
  await tapBox('.ph-next');
  await waitFor(() => document.querySelector('.ph')?.dataset.step === 'color', 'photo: colour step', 60000);
  await page.waitForTimeout(800);
  // tap the route colour: the most yellow patch of the straightened photo
  const pick = await page.evaluate(() => {
    const c = document.querySelector('.ph-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let best = null;
    let bs = 0;
    for (let y = 4; y < c.height - 4; y += 3) {
      for (let x = 4; x < c.width - 4; x += 3) {
        let n = 0;
        for (let j = -3; j <= 3; j += 3) for (let i = -3; i <= 3; i += 3) {
          const o = ((y + j) * c.width + x + i) * 4;
          if (d[o] > 170 && d[o + 1] > 120 && d[o + 2] < 90) n++;
        }
        if (n > bs) {
          bs = n;
          best = { x, y };
        }
      }
    }
    const r = c.getBoundingClientRect();
    return best && { x: r.left + best.x / (c.width / r.width), y: r.top + best.y / (c.height / r.height) };
  });
  ok(!!pick, 'photo: a yellow hold to tap');
  await page.touchscreen.tap(pick.x, pick.y);
  await page.waitForTimeout(1500);
  await tapBox('.ph-next');
  await waitFor(() => document.querySelector('.ph')?.dataset.step === 'holds', 'photo: holds step', 60000);
  await waitFor(() => !document.querySelector('.ph').classList.contains('is-detecting') && /holds? found/i.test(document.querySelector('.ph-title')?.textContent ?? ''), 'photo: holds found', 90000);
  await page.waitForTimeout(600);
  const found = await page.evaluate(() => document.querySelector('.ph-title').textContent);
  ok(/^(1[2-9]|2\d) holds found/i.test(found), `photo: holds detected (${found}; ${sample.route} painted)`);
  await shot('photo-holds');
  await tapBox('.ph-next');
  await waitFor(() => document.querySelector('.ph')?.dataset.step === 'roles', 'photo: start / top step', 30000);
  await page.waitForTimeout(500);
  await shot('photo-roles');
  await tapBox('.ph-next');
  await waitFor(() => document.querySelector('.ph')?.dataset.step === 'wall', 'photo: wall step', 30000);
  await page.waitForTimeout(2500);
  await shot('photo-wall');
  await tapBox('.ph-make');
  await waitFor(() => !document.querySelector('.ph'), 'photo importer closed', 30000);
  await veilClear();
  await page.waitForTimeout(1500);
  const draft = await page.evaluate(() => {
    const d = window.__jgu.editor.getDraft();
    return { name: d.name, holds: d.holds.length, starts: d.holds.filter((h) => h.role === 'start').length, tops: d.holds.filter((h) => h.role === 'top').length, color: d.color };
  });
  ok(draft.holds >= 12 && draft.starts >= 1 && draft.tops === 1, `photo: the imported problem is the editor's draft (${JSON.stringify(draft)})`);
  const pchip = await editorChip();
  ok(pchip.status === 'ok', `photo: the editor's problem check finds a beta (${pchip.text})`);
  await shot('photo-draft');
  // playable: TEST it and climb it by touch
  await tap('.ed-test', 'TEST');
  await waitScreen('preview', 120000);
  await veilClear();
  await page.waitForTimeout(1000);
  await shot('photo-test-preview');
  await tap('.pv-hit', 'TAP TO START');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'photo test climb start', 60000);
  await page.waitForTimeout(600);
  let photoRun = await testClimbByTouch('photo-test', 2);
  if (!photoRun.sent) {
    // the touch driver can miss where a planned hip path can't be followed live (a known sim note:
    // some rock-overs onto a high foot miss and re-plan); the problem is still playable if the sim's
    // own bot sends it in the same live session, so TEST again and let the bot climb it
    log('photo-test: the touch driver did not send it; TEST again with the sim\'s climbing bot');
    await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor back after the photo touch tries', 90000);
    await veilClear();
    await page.waitForTimeout(800);
    await tap('.ed-test', 'TEST');
    await waitScreen('preview', 120000);
    await veilClear();
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'photo test climb start (bot)', 60000);
    await page.waitForTimeout(600);
    photoRun = { ...(await botClimb('photo-test-bot')), bot: true };
  }
  ok(photoRun.sent, `photo: the imported problem is sent ${photoRun.bot ? "by the sim's bot in the live session (the touch driver missed)" : 'by touch'} (phase ${photoRun.phase})`);
  await waitFor(() => window.__jgu.app.current === 'editor' && window.__jgu.editor.isOpen, 'editor back after the photo test', 90000);
  await veilClear();
  await page.waitForTimeout(800);
  await shot('photo-after-test');
  await tap('.ed-x', 'close editor');
  await waitFor(() => window.__jgu.app.current === 'menu', 'editor closed (photo)', 30000);
  await waitScreen('title');
  await veilClear();
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
  // a fall: TRY AGAIN (same problem), PROBLEMS (back to the list) and MENU
  const cid = await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id);
  const fallOnce = async (what) => {
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', `community climb start (${what})`, 60000);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__jgu.sim.forceFall());
    await waitScreen('results', 90000);
    await page.waitForTimeout(1800);
  };
  await fallOnce('1');
  const cmBtns = await page.evaluate(() => [...document.querySelectorAll('#ui .res-actions button')].map((b) => b.getAttribute('aria-label')).join(' / '));
  ok(/TRY AGAIN/.test(cmBtns) && /PROBLEMS/.test(cmBtns) && /MENU/.test(cmBtns), `community results offer TRY AGAIN, PROBLEMS and MENU (${cmBtns})`);
  await shot('community-results-fall');
  await tapText('TRY AGAIN');
  await waitScreen('preview', 120000);
  await veilClear();
  ok((await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id)) === cid, 'community TRY AGAIN climbs the same problem');
  await tap('.pv-back', 'back');
  await waitScreen('community', 60000);
  await veilClear();
  // again, and MENU goes to the main menu instead of the list
  await page.locator('#ui .cm-play, #ui .cm-card button').first().tap();
  await waitScreen('preview', 120000);
  await veilClear();
  await fallOnce('2');
  await tapText('MENU');
  await waitScreen('title', 60000);
  await veilClear();
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
  // climb on until a fall would be caught by the rope, then take a whipper (forced: QA shortcut)
  const safe = () =>
    page.evaluate(async () => {
      const sim = window.__jgu.sim;
      const st = sim?.getState();
      if (!st || st.phase !== 'climbing' || !st.clipped.length) return false;
      const { RopeSystem } = await import('/src/game/rope.ts');
      const r = new RopeSystem(sim.boulder);
      for (const id of st.clipped) r.clip(id);
      return !r.fallOutcome(st.pelvis).groundFall;
    });
  const leadId = await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id ?? '');
  let high = false;
  let leadUpBy = '';
  let clipChecked = false;
  // up to two attempts: the touch driver can miss where a planned hip path can't be followed live
  // and pump out low on the tower (a ground fall ends the run); then TRY AGAIN — the same route as a
  // fresh run — and climb it again, setting the hips first like the sim's own bot
  for (let attempt = 1; attempt <= 2 && !high; attempt++) {
    const tag = attempt > 1 ? ` #${attempt}` : '';
    if (attempt > 1) {
      log(`lead: attempt ${attempt - 1} ended low on the tower; TRY AGAIN`);
      if ((await page.evaluate(() => window.__jgu.sim?.getState().phase)) === 'climbing') await page.evaluate(() => window.__jgu.sim.forceFall());
      await waitScreen('results', 120000);
      await page.waitForTimeout(1500);
      await shot('lead-results-ground-fall');
      await tapText('TRY AGAIN');
      await waitScreen('preview', 120000);
      await veilClear();
      ok((await page.evaluate(() => window.__jgu.app.activeSession?.boulder.id ?? '')) === leadId, `Lead Tower TRY AGAIN climbs the same route (${leadId})`);
      await page.evaluate(() => {
        window.__e2eClips = [];
      });
    }
    // the second go holds the sim still while the finger travels (fastFinger, as on the cave / photo
    // test climbs): a headless drag spans seconds of game time, long enough for the one holding hand
    // to pump off mid-clip on a long route; the release still goes through LimbControls
    fastFinger = attempt > 1;
    await tap('.pv-hit', 'TAP TO START');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', `lead climb start${tag}`, 60000);
    await page.waitForTimeout(600);
    if (attempt === 1) {
      await shot('lead-climbing');
      const lch = await chalkHud();
      ok(lch.chips === 2 && !lch.noChalk && lch.matters === true, `lead HUD keeps the chalk mechanic: a CHALK chip per hand (${JSON.stringify(lch)})`);
    }
    const clipped = await autoClimb({
      label: `lead${tag}`,
      maxMoves: 30,
      careful: attempt > 1,
      until: async () => (await page.evaluate(() => window.__e2eClips.length > 0 || window.__jgu.sim?.getState().phase !== 'climbing')),
    });
    const clips = await page.evaluate(() => window.__e2eClips.slice());
    if (clipped && clips.length > 0 && !clipChecked) {
      clipChecked = ok(true, `Lead Tower: clipped a quickdraw by touch (${clips.join(',')})${tag}`);
      await page.waitForTimeout(500);
      await shot('lead-clipped');
    }
    if (!clips.length) continue;
    if (attempt === 1 && args.includes('--lead-retry')) {
      // QA of this script: a ground fall right after the first clip, so the TRY AGAIN path runs
      await page.evaluate(() => window.__jgu.sim.forceFall());
      continue;
    }
    if (attempt === 1) {
      high = await autoClimb({
        label: `lead-up${tag}`,
        maxMoves: 24,
        until: async () => (await safe()) || (await page.evaluate(() => window.__jgu.sim?.getState().phase !== 'climbing')),
      });
    } else {
      // the single-finger touch driver misses where a reach needs the hips held while the hand moves
      // (a released hip handle settles back); the rope checks below need the climber above a clip, so
      // the sim's own bot (hips and hand together, as with two thumbs) climbs there in the live session
      high = await botUntil(`lead-up${tag}`, safe);
    }
    high = high && (await safe());
    if (high) leadUpBy = attempt === 1 ? 'by touch' : "by the sim's bot after a TRY AGAIN (the touch driver missed)";
  }
  fastFinger = false;
  if (!clipChecked) ok(false, 'Lead Tower: clipped a quickdraw by touch (none)');
  if (ok(high, `Lead Tower: climbed above the clip to where a fall is caught ${leadUpBy}`.trim())) {
    // the touch driver may already have pumped off and been caught on the way up (each catch costs a life)
    const livesBefore = await page.evaluate(() => window.__jgu.app.activeSession?.cfg.lives?.left ?? -1);
    log(`lead: ${livesBefore} lives left before the whipper`);
    await page.evaluate(() => {
      window.__e2eRope = [];
      window.__jgu.bus.on('sim:event', (e) => {
        if (e.type === 'caught' || e.type === 'ground-fall') window.__e2eRope.push(e.type);
      });
      window.__jgu.sim.forceFall();
    });
    await waitFor(() => window.__e2eRope.length > 0, 'rope catch', 60000);
    await page.waitForTimeout(400);
    await shot('lead-whipper');
    const kind = await page.evaluate(() => window.__e2eRope[0]);
    ok(kind === 'caught', `Lead Tower: the rope catches the fall (${kind})`);
    if (livesBefore > 1) {
      await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing' && !document.querySelector('.jga-veil.on'), 'respawn on the wall', 90000);
      await page.waitForTimeout(1200);
      const lives = await page.evaluate(() => window.__jgu.app.activeSession?.cfg.lives?.left ?? -1);
      ok(lives === livesBefore - 1, `Lead Tower: respawned after the catch with one life fewer (${livesBefore} -> ${lives} left)`);
      await shot('lead-respawn');
    } else {
      // that catch took the last life: the run ends on the results instead of a respawn
      await waitScreen('results', 90000);
      await page.waitForTimeout(1500);
      const res = await page.evaluate(() => document.querySelector('#ui .scr-results, #ui [data-screen=results], #ui')?.textContent ?? '');
      ok(/TRY AGAIN/.test(res), 'Lead Tower: a catch on the last life ends the run (results with TRY AGAIN)');
      await shot('lead-last-life-results');
    }
  }
  const leadEnd = await waitFor(
    () => (document.getElementById('ui')?.dataset.screen === 'results' ? 'results' : window.__jgu.sim?.getState().phase === 'climbing' && !document.querySelector('.jga-veil.on') ? 'climbing' : false),
    'lead: results or back on the wall',
    120000,
  );
  if (leadEnd === 'results') {
    // the run is over (a ground fall): back to the modes through the results
    await page.waitForTimeout(1200);
    await tapText('MENU');
    await waitScreen('modes', 60000);
    await veilClear();
    await page.waitForTimeout(700);
    await shot('modes-after-lead');
  } else {
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
}

// ───────────────────────────── Settings → Start over (last: it wipes the profile) ─────────────────────────────
if (want('startover')) {
  // the step before (lead) ends on the modes screen: back to the title first
  if ((await screen()) !== 'title') {
    await tap('.btn-back', 'back');
    await waitScreen('title', 60000);
    await veilClear();
  }
  await tapText('SETTINGS');
  await waitScreen('settings');
  await page.waitForTimeout(900);
  await page.locator('#ui .row-startover').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot('settings-startover');
  await tapText('START OVER');
  await page.waitForSelector('.modal-ok', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(600);
  await shot('startover-confirm');
  await Promise.all([page.waitForEvent('load', { timeout: 120000 }), page.tap('.modal-ok')]);
  log('reloaded after START OVER');
  await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames after start over', 180000);
  const wiped = await page.evaluate(() => {
    const raw = localStorage.getItem('jgu.profile.v1');
    const p = raw ? JSON.parse(raw) : null;
    return { introSeen: !!p?.introSeen, name: p?.playerName ?? '', draft: localStorage.getItem('jgu.editor.draft'), device: !!localStorage.getItem('jgu.device.v1') };
  });
  ok(!wiped.introSeen && !wiped.name && !wiped.draft, `START OVER wiped the profile and drafts (${JSON.stringify(wiped)})`);
  await waitScreen('splash', 60000);
  await tap('.splash-hit', 'splash');
  await waitFor(() => window.__jgu.app.current === 'intro', 'intro after start over', 30000);
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot('startover-intro');
  ok(true, 'START OVER replays Steini’s intro');
  await tap('.gb-skip', 'SKIP intro');
  await waitScreen('name', 30000);
  ok((await page.evaluate(() => document.querySelector('.name-input')?.value ?? '')) === '', 'START OVER asks for a name again');
  await page.fill('.name-input', 'Fresh Ibex');
  await frames(2);
  await tapText('CONTINUE');
  await waitFor(() => window.__jgu.app.current === 'tutorial', 'tutorial after start over', 30000);
  await veilClear();
  await page.waitForSelector('.gb-skip', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1500);
  await shot('startover-tutorial');
  ok(true, 'START OVER runs the tutorial');
  await tap('.gb-skip', 'SKIP tutorial');
  await waitScreen('title', 60000);
  await veilClear();
}

// ───────────────────────────── report ─────────────────────────────
const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
ok(relevant.length === 0, `no console errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
if (warnings.length) console.log(`warnings (${warnings.length}):\n  ${[...new Set(warnings)].slice(0, 12).join('\n  ')}`);
log(`${failures ? failures + ' FAILURE(S)' : 'ALL PASSED'}`);
if (!args.includes('--keep')) await browser.close();
process.exit(failures ? 1 : 0);

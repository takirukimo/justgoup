// TUTORIAL QA: drives dev/tutorial.html like a player (real touch events through LimbControls),
// following Steini's gating and highlights, and screenshots every beat.
// usage: node dev/tutorial.check.mjs [baseUrl] [--out dir] [--dpr 1] [--only intro|skip|tutorial] [--ts 2]
//   baseUrl defaults to http://localhost:5206 (run the harness server first:
//   npx vite --config dev/tutorial.vite.config.mjs --port 5206 --strictPort)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5206';
const out = opt('out', '/tmp/claude-0/shots/tutorial');
const dpr = +opt('dpr', 1);
const only = opt('only', null);
const ts = +opt('ts', 2);
const q = opt('q', 'low');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/dev/tutorial.html?q=${q}&dev=1&${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
  const cdp = await page.context().newCDPSession(page);
  return { page, cdp, errors };
}

const frames = (page, n = 1) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let k = 0;
        const f = () => (++k >= n ? r() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

const touch = (cdp, type, pts) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: 0, radiusX: 6, radiusY: 6, force: 1 })) });

/** Text of the speech bubble once fully typed (null while typing / hidden). */
const bubble = (page) =>
  page.evaluate(() => {
    const layer = document.querySelector('.guide-layer');
    const card = document.querySelector('.gb-card');
    const text = document.querySelector('.gb-text')?.getAttribute('aria-label') ?? '';
    if (!layer || !card || !layer.classList.contains('on')) return null;
    return { text, typed: card.classList.contains('typed'), waiting: layer.classList.contains('waiting') };
  });

async function shot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png` });
  log(`shot ${name}`);
}

// ───────────────────────────── 1. intro (default rAF clock) ─────────────────────────────
if (!only || only === 'intro') {
  const { page, errors } = await open('flow=intro');
  log('intro: started');
  const seen = new Set();
  let n = 0;
  let cardShot = false;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const flow = await page.evaluate(() => window.__flow());
    if (flow === 'done') break;
    if (!cardShot && (await page.$('.jgt.card-on'))) {
      await page.waitForTimeout(1600); // let the staggered reveal finish (CSS runs on wall time)
      await shot(page, 'intro-1-card');
      cardShot = true;
    }
    const b = await bubble(page);
    if (b && b.typed && !seen.has(b.text)) {
      seen.add(b.text);
      await shot(page, `intro-${2 + n++}-line`);
      log(`  "${b.text}"`);
    }
    await frames(page, 1);
  }
  ok((await page.evaluate(() => window.__flow())) === 'done', 'intro finished on its own');
  ok(cardShot, 'title card shown');
  ok(seen.size >= 3, `Steini spoke ${seen.size} lines`);
  await frames(page, 4);
  await page.waitForTimeout(1200);
  ok(!(await page.$('.jgt')), 'cinematic overlay removed');
  ok(!(await page.$('.guide-layer.on')), 'speech bubble hidden');
  await shot(page, 'intro-9-end');
  ok(errors.length === 0, `intro: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await page.close();
}

// ───────────────────────────── 2. intro skip ─────────────────────────────
if (!only || only === 'skip') {
  const { page, errors } = await open('flow=intro');
  await page.waitForSelector('.has-skip .gb-skip, .jgt.has-skip .jgt-skip', { timeout: 120000 });
  const empty = await page.evaluate(() => {
    const c = document.querySelector('.gb-card');
    return !!c && getComputedStyle(c).visibility !== 'hidden' && !document.querySelector('.guide-layer.on');
  });
  ok(!empty, 'no empty speech card while only the SKIP chip is up');
  await shot(page, 'skip-0-chip');
  await page.tap('.gb-skip');
  await frames(page, 3);
  ok((await page.evaluate(() => window.__flow())) === 'done', 'SKIP ends the intro at once');
  await page.waitForTimeout(1000);
  ok(!(await page.$('.jgt')), 'overlay removed after skip');
  ok(errors.length === 0, `skip: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await page.close();
}

// ───────────────────────────── 3. full tutorial with touch input ─────────────────────────────
if (!only || only === 'tutorial') {
  const { page, cdp, errors } = await open(`flow=tutorial&ts=${ts}`);
  log(`tutorial: started (ts=${ts})`);
  const plan = () => page.evaluate(() => window.__plan());
  const seenText = new Set();
  const stepsSeen = new Set();
  const shotsTaken = new Set();
  let missDone = false;
  let lines = 0;
  const deadline = Date.now() + 40 * 60 * 1000;

  /**
   * Drag the active lesson's handle onto its target like a careful player: touch the handle, move
   * toward the hold, then keep correcting with the live drag target (the camera pans during drags)
   * and hold still until the sim's snap candidate is the target hold, then lift the finger.
   */
  async function performLesson(stepIdx, mistake) {
    const p = await plan(); // fresh: the camera may have moved since the last look
    if (!p || !p.handle) return;
    let finger = { x: p.handle.x, y: p.handle.y };
    await touch(cdp, 'touchStart', [finger]);
    await frames(page, 1);
    const grabbed = await page.evaluate((l) => window.__ctl.dragging === l, p.limb);
    if (!grabbed) {
      await touch(cdp, 'touchEnd', []);
      log(`  (missed the ${p.limb} handle, retrying)`);
      return;
    }
    const moveBy = async (dx, dy, steps = 5) => {
      const s0 = { ...finger };
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t * t * (3 - 2 * t);
        finger = { x: s0.x + dx * e, y: s0.y + dy * e };
        await touch(cdp, 'touchMove', [finger]);
      }
      await frames(page, 1);
    };
    if (mistake) {
      // release a hand on blank wall: Steini should coach the miss
      await moveBy(70, 110);
      await frames(page, 2);
      await touch(cdp, 'touchEnd', []);
      return;
    }
    const isHip = p.limb === 'HIP';
    await moveBy((p.to.x - p.from.x) * (isHip ? 1.2 : 1), (p.to.y - p.from.y) * (isHip ? 1.2 : 1));
    let snapped = false;
    for (let k = 0; k < 40; k++) {
      await frames(page, 1);
      if (k === 2 && !shotsTaken.has(`drag-${stepIdx}`)) {
        shotsTaken.add(`drag-${stepIdx}`);
        await shot(page, `tut-step${String(stepIdx + 1).padStart(2, '0')}-b-drag`);
      }
      const r = await plan();
      if (!r || r.status.step !== stepIdx || r.status.phase !== 'lesson' || r.status.beat !== p.status.beat) break; // done (hips)
      if (!r.drag) break;
      if (isHip) {
        const ex = r.to.x - r.from.x;
        const ey = r.to.y - r.from.y;
        if (Math.hypot(ex, ey) > 6 && k % 4 === 3) await moveBy(ex * 1.2, ey * 1.2, 2);
        if (k > 16) break;
        continue;
      }
      if (r.candidate === p.holdId) {
        snapped = true;
        await frames(page, 1);
        break;
      }
      const ex = r.to.x - r.drag.x;
      const ey = r.to.y - r.drag.y;
      if (Math.hypot(ex, ey) > 3) await moveBy(ex, ey, 2);
    }
    await touch(cdp, 'touchEnd', []);
    if (!isHip && !snapped) log(`  (released ${p.limb} before the ring lit up)`);
  }

  while (Date.now() < deadline) {
    const res = await page.evaluate(() => window.__result());
    if (res !== null) break;
    const b = await bubble(page);
    if (b && b.typed && !seenText.has(b.text)) {
      seenText.add(b.text);
      lines++;
      log(`  ${b.waiting ? '[tap] ' : ''}"${b.text}"`);
      await shot(page, `tut-line${String(lines).padStart(2, '0')}`);
    }
    if (b && b.waiting) {
      // a tap-to-continue line: read it (wait for the typewriter), then tap; never touch the wall meanwhile
      if (b.typed) await page.tap('.gb-card');
      await frames(page, 2);
      continue;
    }
    const st = await page.evaluate(() => window.__status());
    if (st.phase === 'lesson' && st.step >= 0) {
      stepsSeen.add(st.step);
      const p = await plan();
      const onHold = await page.evaluate(
        ([limb, holdId]) => limb !== 'HIP' && window.__sim.getState().limbs[limb].holdId === holdId,
        [p?.limb, p?.holdId],
      );
      if (p && p.handle && !onHold) {
        if (!shotsTaken.has(`before-${st.step}-${st.beat}`)) {
          shotsTaken.add(`before-${st.step}-${st.beat}`);
          await frames(page, 2);
          await shot(page, `tut-step${String(st.step + 1).padStart(2, '0')}-a-${st.beat ?? st.lesson.teach}-${st.lesson.limb}`);
        }
        const mistake = st.step === 0 && !missDone;
        if (mistake) missDone = true;
        await performLesson(st.step, mistake);
        await frames(page, 3);
        if (mistake) {
          await frames(page, 2);
          const mb = await bubble(page);
          ok(!!mb && /Let go right on the hold|Missed!/.test(mb.text), `miss coached: "${mb?.text}"`);
          await shot(page, 'tut-step01-miss');
        }
        continue;
      }
    }
    await frames(page, 1);
  }
  const result = await page.evaluate(() => window.__result());
  ok(result === 'done', `tutorial result: ${result}`);
  const total = await page.evaluate(() => window.__status().total);
  ok(stepsSeen.size >= total - 1, `lessons visited: ${stepsSeen.size}/${total}`);
  ok(await page.evaluate(() => window.__sim.getState().phase === 'topped'), 'climber topped out');
  await frames(page, 3);
  await shot(page, 'tut-zz-end');
  writeFileSync(`${out}/tutorial-trace.txt`, (await page.evaluate(() => window.__trace)).join('\n'));
  log(`trace → ${out}/tutorial-trace.txt`);
  ok(errors.length === 0, `tutorial: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await page.close();
}

await browser.close();
log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);

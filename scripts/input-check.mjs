// INPUT QA: drives dev/input.html with real touch (CDP) and mouse input and asserts through the sim.
// usage: node scripts/input-check.mjs [baseUrl] [--out dir] [--seed n] [--grade n] [--only ABF…]
//   baseUrl defaults to http://localhost:5204 (run `npx vite --config dev/input.vite.config.mjs --port 5204` first).
//   --only runs just the listed sections: A hand grab · B foot / second finger / hips · C gating + keys ·
//   D rope clip · E lifecycle · F deadpoint flick · G chalk-up drag + HUD chalk · H shake-out drag ·
//   I double dyno (two fingers on the hips) · J Pure mode.
// Screens: <out>/check-before.png, check-during.png, check-after.png (+ foot/hip/rope/dyno/chalk/shake/duo/pure).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5204';
const out = opt('out', '/tmp/claude-0/shots/input');
const seed = +opt('seed', 3);
const grade = +opt('grade', 2);
const only = opt('only', '');
const run = (k) => !only || only.includes(k);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

let vclock = 0;

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const logs = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  await page.goto(`${base}/dev/input.html?q=low&${query}`, { waitUntil: 'load' });
  // headless SwiftShader can run at ~1 fps while other jobs share the CPU: be patient
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  await page.waitForTimeout(800);
  const cdp = await page.context().newCDPSession(page);
  vclock = 0; // restart the touch clock at "now" for each page (timestamps before its time origin read as 0)
  return { page, cdp, logs };
}

// Touch events carry explicit timestamps from a virtual clock: under headless SwiftShader a frame can
// take seconds and real dispatch times would turn every flick into a crawl. `dt` (s) advances the clock;
// a lift defaults to a finger that rested a moment (no flick) unless the caller says otherwise.
const touch = (cdp, type, pts, dt = type === 'touchEnd' ? 0.3 : 0.034) => {
  vclock = vclock ? vclock + dt : Date.now() / 1000;
  return cdp.send('Input.dispatchTouchEvent', { type, timestamp: vclock, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 6, radiusY: 6, force: 1 })) });
};

/** Touch-drag from a → b in `steps` moves; optional callback at a given step (mid-drag screenshot). */
async function drag(page, cdp, a, b, steps = 14, onStep) {
  await touch(cdp, 'touchStart', [a]);
  await page.waitForTimeout(80);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t * t * (3 - 2 * t);
    await touch(cdp, 'touchMove', [{ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }]);
    await page.waitForTimeout(34);
    if (onStep) await onStep(i);
  }
}

/** Pick a reachable target hold for `limb` (highest above the current one) and its screen geometry. */
const planMove = (page, limb, preferUp = true) =>
  page.evaluate(
    ([limb, preferUp]) => {
      const sim = window.__sim;
      const st = sim.getState();
      const L = st.limbs[limb];
      const holds = new Map(sim.boulder.holds.map((h) => [h.id, h]));
      const taken = new Set(Object.values(st.limbs).map((l) => l.holdId));
      const ids = sim.reachableHolds(limb).filter((id) => !taken.has(id));
      const scored = ids
        .map((id) => ({ h: holds.get(id), q: sim.predictGrip(limb, id) }))
        .filter((c) => c.h && Math.hypot(c.h.x - L.pos.x, c.h.y - L.pos.y) > 0.12)
        .sort((a, b) => (preferUp ? b.h.y - a.h.y : 0) + (b.q - a.q) * 0.6);
      const pick = scored.find((c) => c.q > 0.25) ?? scored[0];
      if (!pick) return null;
      const r = window.__renderer;
      const hs = r.wallToScreen({ x: pick.h.x, y: pick.h.y });
      const ls = r.wallToScreen(L.pos, L.depth);
      const handle = window.__ctl.handlePosition(limb);
      return { holdId: pick.h.id, quality: pick.q, hold: hs, limb: ls, handle, from: L.holdId };
    },
    [limb, preferUp],
  );

const holdOf = (page, limb) => page.evaluate((l) => window.__sim.getState().limbs[l].holdId, limb);
const events = (page) => page.evaluate(() => window.__events.map((e) => ({ type: e.type, p: e.payload })));

// ───────────── A: right hand touch-drag onto a reachable hold ─────────────
if (run('A')) {
  const { page, cdp, logs } = await open(`seed=${seed}&grade=${grade}&invincible=1`);
  const plan = await planMove(page, 'RH');
  ok(!!plan && !!plan.handle, `RH plan: ${plan ? `${plan.from} → ${plan.holdId} (predicted ${plan.quality.toFixed(2)})` : 'none'}`);
  if (plan) {
    await page.screenshot({ path: `${out}/check-before.png` });
    const a = { x: plan.handle.x, y: plan.handle.y };
    const b = { x: a.x + (plan.hold.x - plan.limb.x), y: a.y + (plan.hold.y - plan.limb.y) };
    await drag(page, cdp, a, b, 16);
    await page.waitForTimeout(450); // camera settles toward the focus hint while the finger rests
    await page.screenshot({ path: `${out}/check-during.png` });
    const mid = await page.evaluate(() => ({
      dragging: window.__ctl.dragging,
      simDrag: window.__sim.getState().limbs.RH.dragging,
      handle: window.__ctl.handlePosition('RH'),
    }));
    const target = await page.evaluate((id) => {
      const h = window.__sim.boulder.holds.find((x) => x.id === id);
      return window.__renderer.wallToScreen({ x: h.x, y: h.y });
    }, plan.holdId);
    ok(mid.dragging === 'RH' && mid.simDrag, 'mid-drag: controls + sim report RH dragging');
    const clear = Math.hypot(mid.handle.x - target.x, mid.handle.y - target.y);
    ok(clear > 34 * 1.12 + 14, `dragged handle keeps clear of the target hold (${clear.toFixed(0)} px centre distance)`);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/check-after.png` });
    const held = await holdOf(page, 'RH');
    ok(held === plan.holdId, `RH grabbed ${plan.holdId} (sim says ${held})`);
    const ev = await events(page);
    const types = ev.map((e) => e.type);
    ok(types.includes('input:drag-start') && types.includes('input:drag-end'), 'drag-start / drag-end emitted');
    const moves = ev.filter((e) => e.type === 'input:drag-move');
    ok(moves.length >= 1 && moves.length < 40, `drag-move emitted only on candidate changes (${moves.length}×)`);
    const grab = ev.find((e) => e.type === 'sim:event' && e.p.type === 'grab' && e.p.limb === 'RH');
    ok(!!grab, 'endDrag grab event re-emitted on the bus as sim:event');
    const endIdx = types.lastIndexOf('input:drag-end');
    const grabIdx = ev.indexOf(grab);
    ok(grabIdx >= 0 && grabIdx < endIdx, 'sim events precede input:drag-end');
  }
  ok(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
  await page.close();
}

// ───────────── B: foot drag, a second finger ignored, hip drag ─────────────
if (run('B')) {
  const { page, cdp } = await open(`seed=${seed}&grade=${grade}&invincible=1`);
  const plan = await planMove(page, 'LF', false);
  ok(!!plan, `LF plan: ${plan ? `${plan.from} → ${plan.holdId}` : 'none'}`);
  if (plan) {
    const a = { x: plan.handle.x, y: plan.handle.y };
    const b = { x: a.x + (plan.hold.x - plan.limb.x), y: a.y + (plan.hold.y - plan.limb.y) };
    await drag(page, cdp, a, b, 12, async (i) => {
      if (i !== 6) return;
      // a second finger presses another handle mid-drag (synthetic pointer: CDP multi-touch
      // emulation re-orders touch ids): it must be ignored
      await page.evaluate(() => {
        const root = document.querySelector('.jgl');
        const p = window.__ctl.handlePosition('RH');
        const o = { pointerId: 77, pointerType: 'touch', isPrimary: false, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true };
        root.dispatchEvent(new PointerEvent('pointerdown', o));
        root.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: p.x + 40 }));
        root.dispatchEvent(new PointerEvent('pointerup', o));
      });
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/check-foot-during.png` });
    const still = await page.evaluate(() => window.__ctl.dragging);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);
    const held = await holdOf(page, 'LF');
    ok(held === plan.holdId, `LF placed on ${plan.holdId} (sim says ${held})`);
    const starts = (await events(page)).filter((e) => e.type === 'input:drag-start');
    ok(still === 'LF' && starts.length === 1 && starts[0].p.limb === 'LF', `second finger ignored (still ${still}, ${starts.length} drag-start)`);
  }
  // hips: pull the pelvis to the right
  const hip = await page.evaluate(() => ({ h: window.__ctl.handlePosition('HIP'), p: { ...window.__sim.getState().pelvis } }));
  await drag(page, cdp, hip.h, { x: hip.h.x + 48, y: hip.h.y - 24 }, 10);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/check-hip.png` });
  const mid = await page.evaluate(() => ({ d: window.__ctl.dragging, p: { ...window.__sim.getState().pelvis } }));
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(200);
  const ev = (await events(page)).map((e) => e.type);
  ok(mid.d === 'HIP' && ev.includes('input:hip-start') && ev.includes('input:hip-end'), `hip drag: hip-start / hip-end emitted (dragging ${mid.d})`);
  ok(mid.p.x - hip.p.x > 0.03, `hips shifted toward the finger (Δx ${(mid.p.x - hip.p.x).toFixed(3)} m)`);
  await page.close();
}

// ───────────── C: tutorial gating + keyboard-armed mouse drag ─────────────
if (run('C')) {
  const { page, cdp } = await open(`seed=${seed}&grade=${grade}&invincible=1&allow=LH`);
  const rh = await page.evaluate(() => window.__ctl.handlePosition('RH'));
  await touch(cdp, 'touchStart', [rh]);
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${out}/check-locked.png` });
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(100);
  const ev = await events(page);
  ok(ev.some((e) => e.type === 'input:blocked' && e.p.limb === 'RH'), 'gated limb emits input:blocked');
  ok(!ev.some((e) => e.type === 'input:drag-start'), 'gated limb does not start a drag');
  ok(!(await page.evaluate(() => window.__sim.getState().limbs.RH.dragging)), 'gated limb stays on its hold');

  await page.evaluate(() => window.__ctl.setAllowed('all'));
  await page.keyboard.press('2');
  const lh = await page.evaluate(() => window.__ctl.handlePosition('LH'));
  // press far from any handle: the armed limb (RH) is dragged
  const sx = 200;
  const sy = 420;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy - 20, { steps: 4 });
  const d = await page.evaluate(() => window.__ctl.dragging);
  await page.mouse.up();
  ok(d === 'RH', `key 2 arms RH for a mouse drag anywhere (dragging: ${d})`);
  void lh;
  await page.close();
}

// ───────────── D: rope mode clip label ─────────────
if (run('D')) {
  const { page, cdp } = await open(`mode=rope&seed=${seed}&grade=1&invincible=1`);
  const plan = await page.evaluate(() => {
    const sim = window.__sim;
    const st = sim.getState();
    const q = sim.boulder.quickdraws[0];
    const r = window.__renderer;
    const hand = ['LH', 'RH']
      .map((l) => ({ l, d: Math.hypot(st.limbs[l].anchor.x - q.x, st.limbs[l].anchor.y - (q.y - 0.15)) }))
      .sort((a, b) => a.d - b.d)[0];
    const L = st.limbs[hand.l];
    return {
      limb: hand.l,
      dist: hand.d,
      draw: r.wallToScreen({ x: q.x, y: q.y - 0.15 }),
      limbS: r.wallToScreen(L.pos, L.depth),
      handle: window.__ctl.handlePosition(hand.l),
    };
  });
  const a = plan.handle;
  const b = { x: a.x + (plan.draw.x - plan.limbS.x), y: a.y + (plan.draw.y - plan.limbS.y) };
  await drag(page, cdp, a, b, 14);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/check-rope-clip.png` });
  const clipOn = await page.evaluate(() => !!document.querySelector('.jgl-tag.is-clip.on'));
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(300);
  const ev = (await events(page)).filter((e) => e.type === 'sim:event').map((e) => e.p.type);
  if (plan.dist <= 0.66 + 0.16) {
    ok(clipOn, `CLIP label shown over the first quickdraw (${plan.limb})`);
    ok(ev.includes('clip'), 'releasing on the quickdraw clips (sim:event clip)');
  } else console.log(`SKIP  first quickdraw out of reach from the start (${plan.dist.toFixed(2)} m)`);
  await page.close();
}

// ───────────── E: lifecycle, highlight merging, enable/disable ─────────────
if (run('E')) {
  const { page } = await open(`seed=${seed}&grade=${grade}&invincible=1`);
  const r = await page.evaluate(async () => {
    const ctl = window.__ctl;
    const ren = window.__renderer;
    const sim = window.__sim;
    const prev = () => ren.highlights.prev.map((h) => `${h.holdId}:${h.kind}`);
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const out = {};
    // a tutorial ring set by another module survives a drag and comes back after it
    const tut = sim.boulder.holds.find((h) => h.role === 'top').id;
    ren.setHoldHighlights([{ holdId: tut, kind: 'tutorial' }]);
    out.before = prev();
    const root = document.querySelector('.jgl');
    const p = ctl.handlePosition('RH');
    const o = { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true };
    root.dispatchEvent(new PointerEvent('pointerdown', o));
    root.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: p.x - 4, clientY: p.y - 30 }));
    await frame();
    out.during = prev();
    // disabling mid-drag drops the limb and hides the overlay
    ctl.setEnabled(false);
    out.afterDisable = { drag: ctl.dragging, simDrag: sim.getState().limbs.RH.dragging, pe: document.getElementById('controls').style.pointerEvents, hidden: root.classList.contains('is-hidden') };
    out.after = prev();
    ctl.setEnabled(true);
    await frame();
    out.reenabled = { hidden: root.classList.contains('is-hidden'), pe: document.getElementById('controls').style.pointerEvents };
    out.ends = window.__events.filter((e) => e.type === 'input:drag-end').length;
    // dispose restores the renderer's own setHoldHighlights
    ctl.dispose();
    ren.setHoldHighlights([]);
    out.disposed = { cleared: prev().length === 0, own: Object.prototype.hasOwnProperty.call(ren, 'setHoldHighlights') ? ren.setHoldHighlights.name : 'proto', gone: !document.querySelector('.jgl') };
    return out;
  });
  const tutKey = r.before[0];
  ok(r.before.length === 1 && r.before[0].endsWith(':tutorial'), `external highlight applied (${r.before.join(', ')})`);
  ok(r.during.includes(tutKey) && r.during.some((k) => k.endsWith(':candidate')), `drag highlights merged with the tutorial ring (${r.during.length} entries)`);
  ok(r.after.length === 1 && r.after[0] === tutKey, `tutorial ring restored after the drag (${r.after.join(', ')})`);
  ok(r.afterDisable.drag === null && !r.afterDisable.simDrag && r.afterDisable.pe === 'none' && r.afterDisable.hidden, 'setEnabled(false) ends the drag, hides, and passes pointer events through');
  ok(!r.reenabled.hidden && r.reenabled.pe === '', 'setEnabled(true) shows the handles again');
  ok(r.ends === 1, `exactly one drag-end (${r.ends})`);
  ok(r.disposed.cleared && r.disposed.gone, `dispose() removes the overlay and restores highlights (${r.disposed.own})`);
  await page.close();
}

// ───────────── shared helpers for the Phase B gestures ─────────────

const simEvents = async (page, since = 0) =>
  (await events(page)).slice(since).filter((e) => e.type === 'sim:event').map((e) => e.p);
const eventCount = (page) => page.evaluate(() => window.__events.length);
const preview = (page) => page.evaluate(() => window.__ctl.releasePreview);
/** Wait (≤ ms) until a sim event matching `pred` shows up after index `since`. */
async function waitEvent(page, since, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ev = (await simEvents(page, since)).find(pred);
    if (ev) return ev;
    await page.waitForTimeout(60);
  }
  return null;
}
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Keep the dragging finger (touch id 0, last at `at`) on a wall point that moves with the body:
 * `goal` is evaluated in the page and returns a wall-local point; the finger is nudged by the
 * remaining wall offset (via the renderer's px/m) a few times. Returns the final finger position.
 */
async function steer(page, cdp, at, goal, rounds = 4) {
  let f = { ...at };
  for (let r = 0; r < rounds; r++) {
    const d = await page.evaluate((src) => {
      const g = new Function('return (' + src + ')')()();
      const t = window.__ctl.dragTarget;
      if (!t) return null;
      const ppm = window.__renderer.pxPerMeter(g);
      return { dx: (g.x - t.x) * ppm, dy: -(g.y - t.y) * ppm };
    }, goal.toString());
    if (!d || Math.hypot(d.dx, d.dy) < 3) break;
    const to = { x: f.x + d.dx, y: f.y + d.dy };
    for (let i = 1; i <= 4; i++) {
      await touch(cdp, 'touchMove', [lerp(f, to, i / 4)]);
      await page.waitForTimeout(30);
    }
    f = to;
    await page.waitForTimeout(250);
  }
  return f;
}

/** A hold a hand could throw at from the start (a feasible dyno candidate above it, a long throw). */
const planThrow = (page) =>
  page.evaluate(() => {
    const sim = window.__sim;
    const st = sim.getState();
    const r = window.__renderer;
    let best = null;
    for (const limb of ['RH', 'LH']) {
      const o = st.limbs[limb === 'RH' ? 'LH' : 'RH'];
      const L = st.limbs[limb];
      if (!o.holdId) continue;
      for (const h of sim.boulder.holds) {
        if (h.role === 'deco' || h.type === 'foot' || h.y <= L.pos.y) continue;
        const d = sim.dynoCandidate(limb, h);
        // short throws become static reaches once the drag pulls the body up: aim well past the reach
        if (!d || d.holdId !== h.id || !d.feasible || d.rise < 0.38) continue;
        if (!best || d.rise > best.rise) best = { limb, holdId: h.id, rise: d.rise, kind: d.kind, hold: r.wallToScreen({ x: h.x, y: h.y }), limbS: r.wallToScreen(L.pos, L.depth), handle: window.__ctl.handlePosition(limb) };
      }
    }
    return best;
  });

// ───────────── F: deadpoint — a fast flick toward a hold beyond static reach ─────────────
if (run('F')) {
  const { page, cdp, logs } = await open(`seed=3&grade=4&style=dyno&invincible=1`);
  const plan = await planThrow(page);
  ok(!!plan && !!plan.handle, `throw plan: ${plan ? `${plan.limb} → ${plan.holdId} (${plan.kind}, +${(plan.rise * 100).toFixed(0)} cm)` : 'none'}`);
  if (plan) {
    const a = { x: plan.handle.x, y: plan.handle.y };
    const b = { x: a.x + (plan.hold.x - plan.limbS.x), y: a.y + (plan.hold.y - plan.limbS.y) };
    await drag(page, cdp, a, b, 16);
    await page.waitForTimeout(450);
    const pv = await preview(page);
    // (feasibility can flip mid-drag: the reach pull stands the climber up and spends the leg drive)
    ok(pv && pv.kind === 'throw' && pv.holdId === plan.holdId, `aiming past static reach previews a throw (${JSON.stringify(pv)})`);
    const tag = await page.evaluate(() => document.querySelector('.jgl-tag.on')?.textContent ?? '');
    ok(/DEADPOINT|DYNO|TOO FAR/.test(tag) && /\+\d+ CM|\+\d\.\d M/.test(tag), `throw tag reads "${tag}"`);
    await page.screenshot({ path: `${out}/check-dyno-aim.png` });
    // pull back a little, hold still, then flick through to the hold and lift while moving
    const back = lerp(a, b, 0.62);
    for (let i = 1; i <= 6; i++) {
      await touch(cdp, 'touchMove', [lerp(b, back, i / 6)]);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(200);
    const since = await eventCount(page);
    await touch(cdp, 'touchMove', [back], 0.2); // rest
    for (let i = 1; i <= 3; i++) await touch(cdp, 'touchMove', [lerp(back, b, i / 3)], 0.014);
    await touch(cdp, 'touchEnd', [], 0.008);
    const start = await waitEvent(page, since, (e) => e.type === 'dyno-start', 1500);
    const rv = await page.evaluate(() => window.__ctl.lastVel);
    console.log(`      release velocity ${Math.hypot(rv.x, rv.y).toFixed(2)} m/s (${rv.x.toFixed(2)}, ${rv.y.toFixed(2)})`);
    ok(!!start && start.holdId === plan.holdId && start.limbs.includes(plan.limb), `flick throws: ${start ? `${start.kind} ${start.limbs.join('+')} → ${start.holdId} power ${start.power.toFixed(2)}` : 'no dyno-start'}`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/check-dyno-flight.png` });
    const end = await waitEvent(page, since, (e) => e.type === 'dyno-catch' || e.type === 'dyno-miss', 3000);
    ok(!!end, `throw resolves (${end ? end.type + (end.type === 'dyno-catch' ? ` q${end.quality.toFixed(2)}` : ` ${end.reason}`) : 'none'})`);
    if (end && end.type === 'dyno-catch') ok((await holdOf(page, plan.limb)) === plan.holdId, `${plan.limb} caught ${plan.holdId}`);
    // a slow release on the same kind of target does NOT throw (the hand returns)
    const plan2 = await planThrow(page);
    if (plan2 && plan2.handle) {
      const a2 = { x: plan2.handle.x, y: plan2.handle.y };
      const b2 = { x: a2.x + (plan2.hold.x - plan2.limbS.x), y: a2.y + (plan2.hold.y - plan2.limbS.y) };
      await drag(page, cdp, a2, b2, 14);
      await page.waitForTimeout(350);
      const s2 = await eventCount(page);
      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(300);
      const ev2 = (await simEvents(page, s2)).map((e) => e.type);
      ok(!ev2.includes('dyno-start'), `a still finger at release does not throw (${ev2.join(', ') || 'no events'})`);
    }
  }
  ok(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
  await page.close();
}

// ───────────── G: chalk up — drag a hand to the hips; the HUD CHALK bridge ─────────────
if (run('G')) {
  const { page, cdp, logs } = await open(`seed=${seed}&grade=${grade}&invincible=1`);
  const g = await page.evaluate(() => {
    const st = window.__sim.getState();
    const r = window.__renderer;
    const dx = st.chest.x - st.pelvis.x;
    const dy = st.chest.y - st.pelvis.y;
    const l = Math.hypot(dx, dy) || 1;
    const bag = { x: st.pelvis.x - (dx / l) * 0.1, y: st.pelvis.y - (dy / l) * 0.1 };
    const L = st.limbs.LH;
    return { bag: r.wallToScreen(bag), limbS: r.wallToScreen(L.pos, L.depth), handle: window.__ctl.handlePosition('LH') };
  });
  const a = { x: g.handle.x, y: g.handle.y };
  const b = { x: a.x + (g.bag.x - g.limbS.x), y: a.y + (g.bag.y - g.limbS.y) };
  await drag(page, cdp, a, b, 16);
  await page.waitForTimeout(400);
  // the body sways once the hand lets go: follow the bag
  await steer(page, cdp, b, () => {
    const st = window.__sim.getState();
    const dx = st.chest.x - st.pelvis.x;
    const dy = st.chest.y - st.pelvis.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: st.pelvis.x - (dx / l) * 0.1, y: st.pelvis.y - (dy / l) * 0.1 };
  });
  const pv = await preview(page);
  ok(pv && pv.kind === 'chalk', `hand over the hips previews a chalk dip (${JSON.stringify(pv)})`);
  const tag = await page.evaluate(() => document.querySelector('.jgl-tag.on')?.textContent ?? '');
  ok(/CHALK UP/.test(tag), `chalk tag reads "${tag}"`);
  await page.screenshot({ path: `${out}/check-chalk-aim.png` });
  const since = await eventCount(page);
  await touch(cdp, 'touchEnd', []);
  const cs = await waitEvent(page, since, (e) => e.type === 'chalk-start' && e.limb === 'LH', 15000);
  ok(!!cs, 'releasing at the hips chalks up (chalk-start LH)');
  // the dip lasts SIM.chalkTime of sim time (slow headless frames stretch it a lot in real time)
  const cd = await waitEvent(page, since, (e) => e.type === 'chalk-done' && e.limb === 'LH', 90000);
  ok(!!cd, 'chalk-done LH after the dip');
  await waitEvent(page, since, (e) => e.type === 'return' && e.limb === 'LH', 20000);
  await page.waitForTimeout(400);
  // HUD CHALK button → bus 'ui:chalk' → LimbControls → sim.chalkUp
  const s2 = await eventCount(page);
  await page.evaluate(() => window.__bus.emit('ui:chalk', { hand: 'RH' }));
  const c2 = await waitEvent(page, s2, (e) => e.type === 'chalk-start' && e.limb === 'RH', 15000);
  ok(!!c2, "'ui:chalk' (HUD button) chalks the right hand");
  const busy = await page.evaluate(() => window.__sim.getState().limbs.RH.chalking === true || window.__sim.getState().limbs.RH.busy);
  ok(busy, 'the right hand is busy in the bag');
  await waitEvent(page, s2, (e) => e.type === 'chalk-done' && e.limb === 'RH', 90000);
  // gated hand: blocked, no chalk
  await page.evaluate(() => window.__ctl.setAllowed(['LF'], false));
  const s3 = await eventCount(page);
  await page.evaluate(() => window.__bus.emit('ui:chalk', { hand: 'LH' }));
  await page.waitForTimeout(300);
  const ev3 = (await events(page)).slice(s3);
  ok(ev3.some((e) => e.type === 'input:blocked' && e.p.limb === 'LH') && !ev3.some((e) => e.type === 'sim:event' && e.p.type === 'chalk-start'), 'a gated hand refuses the HUD chalk (input:blocked)');
  ok(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
  await page.close();
}

// ───────────── H: shake out — drop a hand down beside the body ─────────────
if (run('H')) {
  const { page, cdp, logs } = await open(`seed=${seed}&grade=0&invincible=1`);
  const g = await page.evaluate(() => {
    const st = window.__sim.getState();
    const r = window.__renderer;
    const dx = st.chest.x - st.pelvis.x;
    const dy = st.chest.y - st.pelvis.y;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const L = st.limbs.RH;
    // 0.5 m down the spine from the shoulder, 0.15 m out to the right
    const p = { x: L.anchor.x - ux * 0.5 + uy * 0.15, y: L.anchor.y - uy * 0.5 - ux * 0.15 };
    return { p: r.wallToScreen(p), limbS: r.wallToScreen(L.pos, L.depth), handle: window.__ctl.handlePosition('RH') };
  });
  const a = { x: g.handle.x, y: g.handle.y };
  const b = { x: a.x + (g.p.x - g.limbS.x), y: a.y + (g.p.y - g.limbS.y) };
  await drag(page, cdp, a, b, 16);
  await page.waitForTimeout(500);
  const pv = await preview(page);
  await page.screenshot({ path: `${out}/check-shake-aim.png` });
  if (pv && pv.kind === 'shake') {
    ok(true, 'hand down beside the body previews a shake-out');
    const since = await eventCount(page);
    await touch(cdp, 'touchEnd', []);
    const ss = await waitEvent(page, since, (e) => e.type === 'shake-out-start' && e.limb === 'RH', 15000);
    ok(!!ss, 'releasing there shakes out (shake-out-start RH)');
  } else {
    console.log(`SKIP  shake-out not offered from this stance (${JSON.stringify(pv)})`);
    await touch(cdp, 'touchEnd', []);
  }
  ok(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
  await page.close();
}

// ───────────── I: double dyno — two fingers on the hip handle, flick ─────────────
if (run('I')) {
  const { page, cdp, logs } = await open(`seed=1&grade=4&style=dyno&invincible=1`);
  // find a problem whose start offers a double dyno
  let found = null;
  for (let s = 1; s <= 40 && !found; s++) {
    found = await page.evaluate(async (s) => {
      window.__load(s);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      const p = window.__ctl.previewDoubleDyno();
      return p && p.feasible ? { seed: s, ...p } : null;
    }, s);
  }
  ok(!!found, `double-dyno start found: ${found ? `seed ${found.seed} → ${found.holdId} +${(found.rise * 100).toFixed(0)} cm` : 'none'}`);
  if (found) {
    await page.waitForTimeout(600);
    const h = await page.evaluate(() => window.__ctl.handlePosition('HIP'));
    const f1 = { x: h.x - 8, y: h.y, id: 1 };
    const f2 = { x: h.x + 14, y: h.y + 6, id: 2 };
    await touch(cdp, 'touchStart', [f1]);
    await page.waitForTimeout(120);
    await touch(cdp, 'touchStart', [f1, f2], 0.12);
    await page.waitForTimeout(500);
    const pv = await preview(page);
    ok(pv && pv.kind === 'double' && pv.holdId === found.holdId, `two fingers on the hips arm a double dyno (${JSON.stringify(pv)})`);
    const tag = await page
      .waitForFunction(() => [...document.querySelectorAll('.jgl-tag.on')].map((t) => t.textContent).join(' ').match(/DYNO.*/)?.[0], null, { timeout: 4000 })
      .then((h) => h.jsonValue())
      .catch(() => '');
    ok(/DYNO/.test(tag), `double-dyno tag reads "${tag}"`);
    await page.screenshot({ path: `${out}/check-duo-aim.png` });
    const since = await eventCount(page);
    // flick both fingers up the screen, lift one while moving
    await touch(cdp, 'touchMove', [f1, f2], 0.4);
    for (let i = 1; i <= 4; i++) await touch(cdp, 'touchMove', [{ ...f1, y: f1.y - i * 22 }, { ...f2, y: f2.y - i * 22 }], 0.014);
    await touch(cdp, 'touchEnd', [{ ...f1, y: f1.y - 88 }], 0.008);
    await touch(cdp, 'touchEnd', [], 0.03);
    await page.waitForTimeout(150);
    const all = (await events(page)).slice(since);
    const dy = all.find((e) => e.type === 'input:dyno');
    ok(!!dy && dy.p.thrown && dy.p.holdId === found.holdId, `input:dyno ${dy ? JSON.stringify(dy.p) : 'missing'}`);
    const start = all.find((e) => e.type === 'sim:event' && e.p.type === 'dyno-start');
    ok(!!start && start.p.kind === 'dyno' && start.p.limbs.length === 2, `sim threw a double dyno (${start ? `${start.p.kind} ${start.p.limbs.join('+')} power ${start.p.power.toFixed(2)}` : 'none'})`);
    const hipEnd = all.findIndex((e) => e.type === 'input:hip-end');
    ok(!!start && hipEnd > all.indexOf(start), 'hip-end follows the throw events');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/check-duo-flight.png` });
    const end = await waitEvent(page, since, (e) => e.type === 'dyno-catch' || e.type === 'dyno-miss', 3000);
    ok(!!end, `double dyno resolves (${end ? end.type : 'none'})`);
    // a slow two-finger lift cancels: nothing thrown
    await page.waitForTimeout(1200);
    const h2 = await page.evaluate(() => window.__ctl.handlePosition('HIP'));
    if (h2) {
      const s2 = await eventCount(page);
      const g1 = { x: h2.x, y: h2.y, id: 1 };
      const g2 = { x: h2.x + 16, y: h2.y, id: 2 };
      await touch(cdp, 'touchStart', [g1]);
      await page.waitForTimeout(80);
      await touch(cdp, 'touchStart', [g1, g2], 0.08);
      await page.waitForTimeout(300);
      for (let i = 1; i <= 4; i++) await touch(cdp, 'touchMove', [{ ...g1, y: g1.y - i * 4 }, { ...g2, y: g2.y - i * 4 }], 0.12);
      await touch(cdp, 'touchEnd', [g1], 0.3);
      await touch(cdp, 'touchEnd', [], 0.05);
      await page.waitForTimeout(200);
      const ev2 = (await events(page)).slice(s2);
      ok(!ev2.some((e) => e.type === 'sim:event' && e.p.type === 'dyno-start'), 'a slow two-finger lift does not throw');
    }
  }
  ok(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
  await page.close();
}

// ───────────── J: Pure mode — invisible handles, a finger near the hand picks it ─────────────
if (run('J')) {
  const { page, cdp, logs } = await open(`seed=${seed}&grade=${grade}&invincible=1&pure=1`);
  const vis = await page.evaluate(() => ({
    pure: window.__ctl.isPure,
    opacity: getComputedStyle(document.querySelector('.jgl-h[data-limb="RH"]')).opacity,
  }));
  ok(vis.pure && vis.opacity === '0', `pure mode hides the handles (opacity ${vis.opacity})`);
  await page.screenshot({ path: `${out}/check-pure-idle.png` });
  const plan = await planMove(page, 'RH');
  if (plan) {
    const a = { x: plan.limb.x + 6, y: plan.limb.y + 4 };
    const b = { x: a.x + (plan.hold.x - plan.limb.x), y: a.y + (plan.hold.y - plan.limb.y) };
    await drag(page, cdp, a, b, 14);
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ d: window.__ctl.dragging, hl: window.__renderer.highlights.prev.length, tags: document.querySelectorAll('.jgl-tag.on').length }));
    ok(st.d === 'RH', `a finger on the real hand picks it (dragging ${st.d})`);
    ok(st.hl === 0 && st.tags === 0, `no highlights or labels in pure mode (${st.hl} highlights, ${st.tags} tags)`);
    await page.screenshot({ path: `${out}/check-pure-drag.png` });
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    ok((await holdOf(page, 'RH')) === plan.holdId, `pure drag still grabs ${plan.holdId}`);
  }
  ok(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`);
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall input checks passed');
process.exit(failures ? 1 : 0);

// INPUT QA: drives dev/input.html with real touch (CDP) and mouse input and asserts through the sim.
// usage: node scripts/input-check.mjs [baseUrl] [--out dir] [--seed n] [--grade n]
//   baseUrl defaults to http://localhost:5204 (run `npx vite --port 5204` first).
// Screens: <out>/check-before.png, check-during.png, check-after.png (+ foot/hip/rope variants).
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
  return { page, cdp, logs };
}

const touch = (cdp, type, pts) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 6, radiusY: 6, force: 1 })) });

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
{
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
{
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
{
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
{
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
{
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

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall input checks passed');
process.exit(failures ? 1 : 0);

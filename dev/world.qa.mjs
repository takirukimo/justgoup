// 3D-view QA in the REAL game: title composition, follow framing (idle + while dragging), route
// readability per colour, Lead Tower catch framing, head portraits and render stats.
// It drives the app through window.__jgu (?debug=1), always on the LOCAL backend (webdriver).
//
// usage: node dev/world.qa.mjs [baseUrl] [--out dir] [--tag before] [--q high] [--dpr 1]
//          [--only title,follow,drag,colors,fall,lead,portraits,perf] [--colors Red,Black] [--draw 1]
//   baseUrl defaults to http://localhost:5342 (e.g. VITE_CACHE_DIR=node_modules/.vite-3dview
//   npx vite --config dev/e2e.vite.config.mjs --port 5342 --strictPort)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5342';
const out = opt('out', '/tmp/claude-0/shots/3d-view');
const tag = opt('tag', 'qa');
const q = opt('q', 'high');
const dpr = +opt('dpr', 1);
const only = opt('only', null)?.split(',') ?? null;
const want = (s) => !only || only.includes(s);
mkdirSync(out, { recursive: true });

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, hasTouch: true, isMobile: true });
await context.addInitScript(() => {
  if (sessionStorage.getItem('qa-seeded')) return;
  sessionStorage.setItem('qa-seeded', '1');
  localStorage.clear();
  localStorage.setItem(
    'jgu.profile.v1',
    JSON.stringify({ version: 1, playerName: 'QA Ibex', introSeen: true, tutorialDone: true, head: 'ibex', colorway: 'basalt', chalk: 'classic' }),
  );
});
const page = await context.newPage();
page.setDefaultTimeout(180000);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (m.text().startsWith('[qa]')) log(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

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
async function shot(name) {
  const file = `${out}/${tag}-${name}.png`;
  await page.screenshot({ path: file, timeout: 180000 });
  log(`shot ${file}`);
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
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil', 60000);
async function tap(sel) {
  await page.waitForSelector(sel, { state: 'visible', timeout: 60000 });
  await page.tap(sel);
  await frames(2);
}
/** Let the camera springs settle: several real frames (SwiftShader runs at a few fps). */
async function settle(sec = 3) {
  const f0 = await page.evaluate(() => window.__jgu.frames);
  await page.waitForTimeout(sec * 1000);
  await frames(6);
  const f1 = await page.evaluate(() => window.__jgu.frames);
  return f1 - f0;
}
const stats = () =>
  page.evaluate(() => {
    const r = window.__jgu.renderer;
    const s = r.stats();
    return { ...s, quality: r.getQuality?.(), cam: r.cameraMode, fps: window.__jgu.fps };
  });
/** Where the climber + the next holds land on screen (CSS px). */
const framing = () =>
  page.evaluate(() => {
    const j = window.__jgu;
    const sim = j.sim;
    if (!sim) return null;
    const st = sim.getState();
    const r = j.renderer;
    const ys = [];
    const pts = [st.chest, st.pelvis, ...['LH', 'RH', 'LF', 'RF'].map((l) => st.limbs[l].pos)];
    for (const p of pts) ys.push(r.wallToScreen(p).y);
    const head = r.wallToScreen({ x: st.chest.x, y: st.chest.y + 0.42 }, st.pelvisDepth).y;
    const handY = Math.max(st.limbs.LH.pos.y, st.limbs.RH.pos.y);
    const above = sim.boulder.holds.filter((h) => h.role !== 'deco' && h.y > handY + 0.1).sort((a, b) => a.y - b.y);
    const next = above.slice(0, 3).map((h) => ({ id: h.id, dy: +(h.y - handY).toFixed(2), sy: Math.round(r.wallToScreen(h).y) }));
    const hi = r.wallToScreen({ x: st.chest.x, y: handY + 1.25 }).y;
    const feet = Math.max(r.wallToScreen(st.limbs.LF.pos).y, r.wallToScreen(st.limbs.RF.pos).y);
    return {
      phase: st.phase,
      climberTop: Math.round(Math.min(head, ...ys)),
      climberBot: Math.round(Math.max(...ys)),
      climberFrac: +((Math.max(...ys) - Math.min(head, ...ys)) / innerHeight).toFixed(2),
      handPlus125: Math.round(hi),
      feet: Math.round(feet),
      next,
    };
  });

// ───────────────────────────── boot ─────────────────────────────
await page.goto(`${base}/?debug=1&q=${q}&ts=1`, { waitUntil: 'load', timeout: 180000 });
await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
await tap('.splash-hit');
await waitScreen('title', 90000);
await veilClear();

if (want('title')) {
  await settle(5);
  await shot('title');
  log(`title stats ${JSON.stringify(await stats())}`);
}

if (want('portraits')) {
  const urls = await page.evaluate(async () => {
    const { HEADS } = await import('/src/config/skins.ts');
    const r = window.__jgu.renderer;
    return HEADS.map((h) => ({ id: h.id, url: r.portrait(h.id, 256) }));
  });
  // one contact sheet on a checkerboard (shows transparency) + on the UI's dark card colour
  const html = `<html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:840px">${urls
    .map(
      (u) =>
        `<div style="width:200px;text-align:center;font:12px monospace;color:#aaa"><div style="width:200px;height:200px;border-radius:16px;background:repeating-conic-gradient(#2a2c30 0% 25%, #1c1d20 0% 50%) 50% / 20px 20px"><img src="${u.url}" style="width:200px;height:200px"></div>${u.id}</div>`,
    )
    .join('')}</body></html>`;
  const p2 = await context.newPage();
  await p2.setViewportSize({ width: 856, height: 680 });
  await p2.setContent(html);
  await p2.waitForTimeout(500);
  await p2.screenshot({ path: `${out}/${tag}-portraits.png` });
  await p2.close();
  log(`shot ${out}/${tag}-portraits.png`);
}

async function startMode(text) {
  await tap('.title-play');
  await waitScreen('modes');
  if (text === 'Send Train') await tap('.mode-featured');
  else await page.locator('.mode-card', { hasText: text }).first().tap();
  await waitScreen('preview', 120000);
  await veilClear();
}

if (want('follow') || want('drag') || want('colors') || want('perf') || want('fall')) {
  await startMode('Send Train');
  await settle(2);
  await shot('preview');
  await tap('.pv-hit');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 60000);
  await settle(4);
  await shot('follow');
  log(`follow framing ${JSON.stringify(await framing())}`);
  log(`follow stats ${JSON.stringify(await stats())}`);

  if (want('perf')) {
    const perf = await page.evaluate(async () => {
      const r = window.__jgu.renderer;
      const c = r.climber;
      const orig = c.pose.bind(c);
      let n = 0;
      let tot = 0;
      let max = 0;
      c.pose = (s, f, dt) => {
        const t = performance.now();
        orig(s, f, dt);
        const d = performance.now() - t;
        n++;
        tot += d;
        max = Math.max(max, d);
      };
      const fr0 = performance.now();
      let fn = 0;
      let ft = 0;
      const origFrame = r.frame.bind(r);
      r.frame = (dt) => {
        const t = performance.now();
        origFrame(dt);
        ft += performance.now() - t;
        fn++;
      };
      await new Promise((res) => setTimeout(res, 6000));
      c.pose = orig;
      r.frame = origFrame;
      let tris = 0;
      let meshes = 0;
      c.traverse((o) => {
        if (o.isMesh && o.visible) {
          meshes++;
          const g = o.geometry;
          tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        }
      });
      const g = r.guide;
      let gTris = 0;
      let gMeshes = 0;
      g?.traverse((o) => {
        if (o.isMesh && o.visible) {
          gMeshes++;
          const gg = o.geometry;
          gTris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3;
        }
      });
      return { poseCalls: n, poseAvgMs: +(tot / Math.max(1, n)).toFixed(3), poseMaxMs: +max.toFixed(2), frameAvgMs: +(ft / Math.max(1, fn)).toFixed(1), climberMeshes: meshes, climberTris: Math.round(tris), guideMeshes: gMeshes, guideTris: Math.round(gTris), wallMs: performance.now() - fr0 };
    });
    log(`perf ${JSON.stringify(perf)}`);
    // where the triangles go: visible meshes in the camera frustum (+ which of them cast shadows)
    const top = await page.evaluate(() => {
      const r = window.__jgu.renderer;
      const cam = r.camera;
      const THREE_ = cam.constructor;
      const fr = new (Object.getPrototypeOf(cam.projectionMatrix).constructor === Object ? Object : Object)();
      void THREE_;
      void fr;
      const rows = [];
      const vis = (o) => {
        for (let p = o; p; p = p.parent) if (!p.visible) return false;
        return true;
      };
      r.scene.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine) || !vis(o)) return;
        const g = o.geometry;
        const n = g.index ? g.index.count : g.attributes.position.count;
        const tris = o.isMesh ? n / 3 : 0;
        const inst = o.isInstancedMesh ? o.count : 1;
        rows.push({ name: (o.parent?.name ? o.parent.name + '/' : '') + (o.name || o.type), tris: Math.round(tris * inst), shadow: o.castShadow });
      });
      rows.sort((a, b) => b.tris - a.tris);
      const total = rows.reduce((a, r) => a + r.tris, 0);
      const shadow = rows.filter((r) => r.shadow).reduce((a, r) => a + r.tris, 0);
      return { meshes: rows.length, total, shadowCasters: shadow, top: rows.slice(0, 18) };
    });
    log(`scene ${JSON.stringify(top)}`);
    for (const ql of ['high', 'medium', 'low']) {
      await page.evaluate((ql) => window.__jgu.renderer.setQuality(ql), ql);
      await settle(1.5);
      log(`stats@${ql} ${JSON.stringify(await stats())}`);
    }
    await page.evaluate((ql) => window.__jgu.renderer.setQuality(ql), q);
  }

  if (want('drag')) {
    // drag the higher hand toward the next route hold (through the sim, the way LimbControls does)
    const res = await page.evaluate(() => {
      const j = window.__jgu;
      const sim = j.sim;
      const st = sim.getState();
      const limb = st.limbs.LH.pos.y > st.limbs.RH.pos.y ? 'LH' : 'RH';
      const handY = st.limbs[limb].pos.y;
      const h = sim.boulder.holds.filter((h) => h.role !== 'deco' && h.y > handY + 0.15).sort((a, b) => a.y - b.y)[0];
      if (!h || !sim.beginDrag(limb)) return null;
      const anchor = sim.limbAnchor(limb);
      const reach = sim.maxReach(limb);
      const d = Math.hypot(h.x - anchor.x, h.y - anchor.y);
      const k = Math.min(1, (reach * 0.95) / d);
      const tgt = { x: anchor.x + (h.x - anchor.x) * k, y: anchor.y + (h.y - anchor.y) * k };
      window.__qaDrag = { limb, tgt };
      const tick = () => {
        if (!window.__qaDrag) return;
        sim.dragTo(window.__qaDrag.limb, window.__qaDrag.tgt);
        j.renderer.setCameraFocusHint(window.__qaDrag.tgt);
        requestAnimationFrame(tick);
      };
      tick();
      return { limb, hold: h.id, tgt };
    });
    log(`drag ${JSON.stringify(res)}`);
    // jitter probe: camera position spread over ~1.5 s while the drag target holds still
    await settle(3);
    // jitter probe: how far the wall point under the finger slides on screen per frame (px)
    const jit = await page.evaluate(async () => {
      const r = window.__jgu.renderer;
      const p = window.__qaDrag.tgt;
      const xs = [];
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const s = r.wallToScreen(p);
        xs.push([s.x, s.y]);
      }
      let m = 0;
      for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.hypot(xs[i][0] - xs[i - 1][0], xs[i][1] - xs[i - 1][1]));
      return +m.toFixed(2);
    });
    await shot('drag');
    log(`drag framing ${JSON.stringify(await framing())} target-slide-max ${jit} px/frame`);
    await page.evaluate(() => {
      const j = window.__jgu;
      const d = window.__qaDrag;
      window.__qaDrag = null;
      if (d) j.sim.endDrag(d.limb);
      j.renderer.setCameraFocusHint(null);
    });
    await settle(2);
  }

  if (want('colors')) {
    // same problem, recoloured: route in colour X, deco holds keep their (other) colours
    for (const name of opt('colors', 'Red,Black,White,Blue,Yellow').split(',')) {
      await page.evaluate(async (name) => {
        const { ROUTE_COLORS } = await import('/src/config/brand.ts');
        const j = window.__jgu;
        const sim = j.sim;
        const b = sim.boulder;
        const hex = ROUTE_COLORS.find((c) => c.name === name).hex;
        const swap = ROUTE_COLORS.find((c) => c.hex !== hex && c.hex !== b.color).hex;
        const holds = b.holds.map((h) => ({ ...h, color: h.role !== 'deco' ? hex : h.color === hex ? (b.color === hex ? swap : b.color) : h.color }));
        j.renderer.loadBoulder({ ...b, color: hex, holds });
      }, name);
      await settle(2.5);
      await shot(`color-${name.toLowerCase()}`);
    }
  }
}

if (want('fall') && (await page.evaluate(() => window.__jgu.sim?.getState().phase === 'climbing'))) {
  // boulder fall: the 'fall' camera keeps the body (and then the pad) inside the HUD-safe band
  await page.evaluate(() => window.__jgu.sim.forceFall());
  await page.waitForTimeout(350);
  await shot('fall');
  log(`fall framing ${JSON.stringify(await framing())}`);
  await waitFor(() => window.__jgu.sim?.getState().phase === 'landed', 'landed', 30000).catch(() => null);
  await page.waitForTimeout(700);
  await shot('landed');
  log(`landed framing ${JSON.stringify(await framing())}`);
}

if (want('lead')) {
  if (!(await page.evaluate(() => document.getElementById('ui')?.dataset.screen === 'title'))) {
    await page.evaluate(() => sessionStorage.removeItem('qa-seeded'));
    await page.goto(`${base}/?debug=1&q=${q}&ts=1`, { waitUntil: 'load', timeout: 180000 });
    await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
    await tap('.splash-hit');
    await waitScreen('title', 90000);
    await veilClear();
  }
  await startMode('Lead Tower');
  await settle(2);
  await shot('lead-preview');
  await tap('.pv-hit');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'lead climb start', 60000);
  await settle(3);
  await shot('lead-follow');
  log(`lead framing ${JSON.stringify(await framing())}`);
  log(`lead stats ${JSON.stringify(await stats())}`);
  // teleport onto holds just above the first draw, clip it, then fall: a catch close to the floor
  const drawIdx = +opt('draw', 1);
  const set = await page.evaluate((drawIdx) => {
    const j = window.__jgu;
    const sim = j.sim;
    const ses = j.app.activeSession;
    const rope = ses.rope;
    // the second draw: a fall from just above it is caught low, close to the floor
    const qd = rope.quickdraws[Math.min(drawIdx, rope.quickdraws.length - 1)];
    const holds = sim.boulder.holds.filter((h) => h.role !== 'deco');
    const near = (y, x, hand) =>
      holds
        .filter((h) => (hand ? h.type !== 'foot' : true))
        .sort((a, b) => Math.hypot(a.x - x, (a.y - y) * 1.5) - Math.hypot(b.x - x, (b.y - y) * 1.5))[0];
    const hy = qd.y + 0.6;
    const LH = near(hy, qd.x - 0.25, true);
    const RH = near(hy, qd.x + 0.25, true);
    const LF = near(hy - 1.45, qd.x - 0.2, false);
    const RF = near(hy - 1.45, qd.x + 0.25, false);
    sim.respawn({ LH: LH.id, RH: RH.id, LF: LF.id, RF: RF.id });
    for (const d of rope.quickdraws) if (d.y <= qd.y) rope.clip(d.id);
    return { qd: { y: qd.y }, LH: LH.y, RH: RH.y, LF: LF.y, RF: RF.y };
  }, drawIdx);
  log(`lead setup ${JSON.stringify(set)}`);
  await settle(2.5);
  await shot('lead-high');
  await page.evaluate(() => {
    window.__qaRope = [];
    window.__jgu.bus.on('sim:event', (e) => {
      if (e.type === 'caught' || e.type === 'ground-fall') window.__qaRope.push(e.type);
    });
    window.__jgu.sim.forceFall();
  });
  await page.waitForTimeout(150);
  await shot('lead-falling');
  log(`falling ${JSON.stringify(await framing())}`);
  await waitFor(() => window.__qaRope.length > 0, 'rope catch', 60000);
  await page.waitForTimeout(250);
  await shot('lead-caught');
  log(`caught ${JSON.stringify(await page.evaluate(() => window.__qaRope))} ${JSON.stringify(await framing())}`);
  await page.waitForTimeout(900);
  await shot('lead-hang');
  log(`hang ${JSON.stringify(await framing())}`);
}

const relevant = errors.filter((e) => !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(e));
if (relevant.length) log(`console errors:\n  ${relevant.join('\n  ')}`);
writeFileSync(`${out}/${tag}-errors.txt`, relevant.join('\n'));
log('done');
await browser.close();

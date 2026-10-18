// Artifact sandbox rehearsal: serves the claude.ai Artifact page (scripts/artifact.mjs output)
// inside a minimal wrapper whose CSP mimics the Artifact viewer, then boots and plays it headlessly.
//
// usage: npm run build:single && node scripts/artifact.mjs && node scripts/sandbox-check.mjs [artifact.html]
//          [--out dir] [--port 5333] [--no-claude] [--no-storage]
//   default: a fake `window.claude` db is injected (the game must pick CLAUDE SHARED within ~3 s)
//   --no-claude   no Artifact runtime: the game must fall back to OFFLINE (local) quickly
//   --no-storage  localStorage throws (blocked site data): first-launch flow, no crash
// What the sandbox blocks is mimicked too: fetch to other hosts (CSP connect-src 'self'), alert /
// confirm / prompt (no-ops), window.open (returns null). Any request to *.supabase.co is aborted as
// a second safety net, so this never reaches the real project.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const file = args[0] && !args[0].startsWith('--') ? args[0] : new URL('../dist-single/artifact.html', import.meta.url).pathname;
const out = opt('out', '/tmp/claude-0/shots/sandbox');
const port = +opt('port', 5333);
const withClaude = !args.includes('--no-claude');
const withStorage = !args.includes('--no-storage');
mkdirSync(out, { recursive: true });

const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self' 'unsafe-inline' blob: data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  "img-src 'self' data: blob:",
  'worker-src blob: data:',
].join('; ');

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
${readFileSync(file, 'utf8')}
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await context.route(/supabase\.co/, (route) => route.abort());

// ── the sandbox, as seen from inside ──
await context.addInitScript(
  ({ withClaude, withStorage }) => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    window.alert = () => undefined;
    window.confirm = () => false;
    window.prompt = () => null;
    window.open = () => null;
    if (!withStorage) {
      for (const k of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, k, {
          configurable: true,
          get() {
            throw new DOMException('The operation is insecure.', 'SecurityError');
          },
        });
      }
    } else if (!sessionStorage.getItem('sandbox-seeded')) {
      // a returning player (intro seen, named): straight to the title after the splash
      sessionStorage.setItem('sandbox-seeded', '1');
      localStorage.clear();
      localStorage.setItem('jgu.profile.v1', JSON.stringify({ version: 1, playerName: 'Sandbox Ibex', introSeen: true, tutorialDone: true }));
    }
    if (!withClaude) return;
    // In-memory stand-in for the Artifact `db` + `user` capabilities (async, a little latency).
    const docs = new Map();
    let seq = 0;
    const later = (v) => new Promise((r) => setTimeout(() => r(v), 15));
    const snap = (id, d) => ({ id, exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) });
    const ref = (path) => {
      const id = path.split('/').pop();
      return {
        id,
        path,
        get: () => later(snap(id, docs.get(path))),
        set: (data) => later(void docs.set(path, JSON.parse(JSON.stringify(data)))),
        update: (data) =>
          docs.has(path)
            ? later(void docs.set(path, { ...docs.get(path), ...JSON.parse(JSON.stringify(data)) }))
            : Promise.reject({ code: 'invalid_argument', message: 'update of a missing document' }),
        delete: () => later(void docs.delete(path)),
        collection: (sub) => col(`${path}/${sub}`, [], null, 1000),
      };
    };
    const col = (path, filters, order, lim) => {
      const q = {
        path,
        where: (f, op, v) => col(path, [...filters, [f, op, v]], order, lim),
        orderBy: (f, dir = 'asc') => col(path, filters, [f, dir], lim),
        limit: (n) => col(path, filters, order, n),
        get() {
          let rows = [...docs.entries()].filter(([p]) => p.slice(0, p.lastIndexOf('/')) === path);
          for (const [f, , v] of filters) rows = rows.filter(([, d]) => d[f] === v);
          if (order) rows.sort(([, a], [, b]) => (a[order[0]] < b[order[0]] ? -1 : a[order[0]] > b[order[0]] ? 1 : 0) * (order[1] === 'desc' ? -1 : 1));
          const list = rows.slice(0, lim).map(([p, d]) => snap(p.split('/').pop(), d));
          return later({ docs: list, size: list.length, empty: list.length === 0 });
        },
        doc: (id) => ref(`${path}/${id ?? `auto${++seq}`}`),
        add: async (data) => {
          const r = q.doc();
          await r.set(data);
          return r;
        },
      };
      return q;
    };
    const db = { doc: (p) => ref(p), collection: (p) => col(p, [], null, 1000) };
    const user = { id: () => later('user-sandbox'), can: () => later(true) };
    window.__fakeDb = docs;
    window.claude = { use: (name) => later(name === 'db' ? db : name === 'user' ? user : null) };
  },
  { withClaude, withStorage },
);

const tab = await context.newPage();
const errors = [];
tab.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
tab.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const frames = (n = 1) =>
  tab.evaluate((n) => new Promise((r) => {
    let k = 0;
    const f = () => (++k >= n ? r() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }), n);
async function waitFor(fn, what, timeout = 120000, arg) {
  const t = Date.now();
  for (;;) {
    const v = await tab.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - t > timeout) {
      ok(false, `timed out waiting for ${what}`);
      throw new Error(`timeout: ${what}`);
    }
    await tab.waitForTimeout(150);
  }
}
const waitScreen = (s, timeout) => waitFor((s) => document.getElementById('ui')?.dataset.screen === s, `screen ${s}`, timeout, s);
const shot = async (name) => {
  await tab.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
  log(`shot ${name}.png`);
};
async function tap(sel) {
  await tab.waitForSelector(sel, { state: 'visible', timeout: 60000 });
  await tab.tap(sel);
  log(`tap ${sel}`);
  await frames(2);
}
async function tapText(text) {
  const loc = tab.locator('#ui button', { hasText: text }).first();
  await loc.waitFor({ state: 'visible', timeout: 60000 });
  await loc.tap();
  log(`tap "${text}"`);
  await frames(2);
}

try {
  // ?debug=1 exposes window.__jgu; ?backend=auto opts this automated browser out of the
  // local-only QA default so the real selection (Supabase → Artifact db → local) runs.
  await tab.goto(`http://127.0.0.1:${port}/?debug=1&backend=auto&q=low`, { waitUntil: 'load' });
  const sel = await waitFor(
    () => (window.__jgu?.backend ? { label: window.__jgu.backend.label, kind: window.__jgu.backend.kind, ms: window.__jgu.backendMs } : null),
    'backend selection',
    180000,
  );
  log(`backend ${sel.kind} "${sel.label}" chosen ${(sel.ms / 1000).toFixed(2)} s after createBackend()`);
  // headless SwiftShader blocks the main thread for many seconds while the scene builds, so this
  // bound is loose; what matters is that the stall did not make the selection give up
  ok(sel.ms < 60000, `backend selection did not hang (${(sel.ms / 1000).toFixed(1)} s, mostly scene-build stall)`);
  if (withClaude) ok(sel.label === 'CLAUDE SHARED' && sel.kind === 'artifact', `Artifact db picked and labelled CLAUDE SHARED (${sel.label})`);
  else ok(sel.kind === 'local' && sel.label === 'OFFLINE', `no Artifact runtime → OFFLINE local backend (${sel.label})`);
  await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
  ok(!(await tab.$('#boot')), 'booted: first frames rendered, boot overlay gone');
  await shot('01-splash');

  await tap('.splash-hit');
  if (!withStorage) {
    // blocked storage = a first launch every time: intro → name → tutorial → title
    await waitFor(() => window.__jgu.app.current === 'intro', 'intro', 60000);
    await tap('.gb-skip');
    await waitScreen('name', 60000);
    await tab.fill('.name-input', 'Sandbox Ibex');
    await tapText('CONTINUE');
    await waitFor(() => window.__jgu.app.current === 'tutorial', 'tutorial', 60000);
    await waitFor(() => !document.querySelector('.jga-veil.on'), 'veil', 60000);
    await tap('.gb-skip');
  }
  await waitScreen('title', 120000);
  await waitFor(() => !document.querySelector('.jga-veil.on'), 'veil', 60000);
  await tab.waitForTimeout(1200);
  const titleText = await tab.evaluate(() => document.getElementById('ui').textContent);
  ok(titleText.includes(sel.label), `title shows the backend label "${sel.label}"`);
  await shot('02-title');

  // play: Send Train → preview → climb → one real touch move
  await tap('.title-play');
  await waitScreen('modes');
  await tap('.mode-featured');
  await waitScreen('preview', 120000);
  await waitFor(() => !document.querySelector('.jga-veil.on'), 'veil', 60000);
  ok(await tab.evaluate(() => window.__jgu.app.svc.gen.threaded), 'problem generated in the blob: Web Worker (not on the main thread)');
  await tab.waitForTimeout(1000);
  await shot('03-preview');
  await tap('.pv-hit');
  await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 90000);
  for (let k = 0; k < 20; k++) await frames(1);
  const move = await tab.evaluate(() => {
    const j = window.__jgu;
    const sim = j.sim;
    const st = sim.getState();
    for (const limb of ['RH', 'LH', 'RF', 'LF']) {
      const on = st.limbs[limb].holdId;
      const cand = sim.reachableHolds(limb).map((id) => sim.boulder.holds.find((h) => h.id === id)).filter((h) => h && h.id !== on);
      cand.sort((a, b) => b.y - a.y);
      const h = cand.find((x) => j.renderer.wallToScreen({ x: x.x, y: x.y }).visible);
      const hp = j.controls.handlePosition(limb);
      if (!h || !hp) continue;
      const cr = document.getElementById('controls').getBoundingClientRect();
      const gr = j.renderer.canvas.getBoundingClientRect();
      const from = j.renderer.wallToScreen(st.limbs[limb].pos, st.limbs[limb].depth);
      const to = j.renderer.wallToScreen({ x: h.x, y: h.y });
      return { limb, hold: h.id, start: { x: hp.x + cr.left, y: hp.y + cr.top }, dx: to.x - from.x, dy: to.y - from.y, gl: gr.left, gt: gr.top };
    }
    return null;
  });
  if (ok(!!move, 'found a reachable hold for a touch move')) {
    const cdp = await context.newCDPSession(tab);
    const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 0, radiusX: 6, radiusY: 6, force: 1 }] : [] });
    let f = { ...move.start };
    await touch('touchStart', f);
    await frames(1);
    for (let i = 1; i <= 6; i++) {
      f = { x: move.start.x + (move.dx * i) / 6, y: move.start.y + (move.dy * i) / 6 };
      await touch('touchMove', f);
    }
    await frames(2);
    // steer the live drag target onto the hold (the grab offset keeps the finger off it)
    for (let k = 0; k < 16; k++) {
      const s = await tab.evaluate(({ hold, limb }) => {
        const j = window.__jgu;
        const t = j.controls.target;
        if (j.controls.dragging !== limb) return null;
        const h = j.sim.boulder.holds.find((x) => x.id === hold);
        const a = j.renderer.wallToScreen(t);
        const b = j.renderer.wallToScreen({ x: h.x, y: h.y });
        return { ex: b.x - a.x, ey: b.y - a.y, cand: j.sim.snapCandidate(limb, t)?.id ?? null };
      }, move);
      if (!s || s.cand === move.hold) break;
      f = { x: f.x + s.ex, y: f.y + s.ey };
      await touch('touchMove', f);
      await frames(1);
    }
    await touch('touchEnd', null);
    await frames(3);
    const on = await tab.evaluate((l) => window.__jgu.sim.getState().limbs[l].holdId, move.limb);
    ok(on === move.hold, `touch drag moved ${move.limb} onto ${move.hold} (now on ${on})`);
  }
  await shot('04-climbing');

  // the shared store works through the backend (writes land in the Artifact db)
  const shared = await tab.evaluate(async () => {
    const b = window.__jgu.backend;
    const r = await b.submitScore({ player: 'Sandbox Ibex', score: 777, mode: 'boulder', sends: 1, maxGrade: 1, head: 'ibex', createdAt: Date.now() });
    const top = await b.topScores('boulder', { limit: 5 });
    return { rank: r.rank, top: top.map((e) => `${e.player}:${e.score}`), docs: window.__fakeDb ? window.__fakeDb.size : -1, label: b.label };
  });
  if (withClaude) ok(shared.docs > 0 && shared.top.includes('Sandbox Ibex:777') && shared.rank === 1, `score stored in the shared Artifact db (${JSON.stringify(shared)})`);
  else ok(shared.top.includes('Sandbox Ibex:777'), `score kept on the local board (${JSON.stringify(shared)})`);

  await tab.evaluate(() => window.__jgu.sim.forceFall());
  await waitScreen('results', 120000);
  await tab.waitForTimeout(2500);
  await shot('05-results');
} catch (err) {
  ok(false, `sandbox run aborted: ${err.message}`);
}

const csp = await tab.evaluate(() => window.__csp ?? []).catch(() => []);
const expected = (v) => /supabase\.co/.test(v);
log(`CSP violations: ${csp.length ? csp.join(' | ') : 'none'}`);
ok(csp.filter((v) => !expected(v)).length === 0, 'no CSP violations besides the expected Supabase probe');
const relevant = errors.filter((e) => !/supabase\.co|Content Security Policy.*connect-src|net::ERR_FAILED|fonts\.(googleapis|gstatic)/.test(e));
ok(relevant.length === 0, `no console errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);

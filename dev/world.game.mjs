// WORLD dev: the folded walls in the REAL game. Boots the game as a returning player (local backend:
// automated browsers never touch Supabase), shoots the title camera as a sequence, then plays Send
// Train runs whose first problem is a chosen archetype (cave / mixed / overhang / slab: the run seed is
// searched in the page) and a Lead Tower run: preview, start, then the climber is put back on the wall
// high up (sim.respawn, like a rope catch) so the follow camera can be judged on the steep sections.
// Also samples renderer.stats() (draw calls / triangles) at every shot.
//
// usage: node dev/world.game.mjs [baseUrl] [--out dir] [--q low] [--styles cave,mixed,overhang,slab] [--lead 1] [--title 1]
//   baseUrl defaults to http://127.0.0.1:5433 (dev/e2e.vite.config.mjs server: no reloads mid-run)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:5433';
const out = opt('out', '/tmp/claude-0/shots/world/game');
const q = opt('q', 'low');
const styles = opt('styles', 'cave,mixed,overhang,slab').split(',').filter(Boolean);
const doLead = opt('lead', '1') === '1';
const doTitle = opt('title', '1') === '1';
mkdirSync(out, { recursive: true });
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await context.addInitScript(() => {
  if (sessionStorage.getItem('world-seeded')) return;
  sessionStorage.setItem('world-seeded', '1');
  localStorage.clear();
  localStorage.setItem('jgu.profile.v1', JSON.stringify({ version: 1, playerName: 'World QA', introSeen: true, tutorialDone: true, head: 'ibex', colorway: 'basalt', chalk: 'classic' }));
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text());
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
const waitScreen = (s, timeout = 120000) => waitFor((s) => document.getElementById('ui')?.dataset.screen === s, `screen ${s}`, timeout, s);
const veilClear = () => waitFor(() => !document.querySelector('.jga-veil.on'), 'veil to lift', 60000);
/** Wait for n rendered frames (headless SwiftShader runs at a few fps: judge in frames, not seconds). */
async function waitFrames(n) {
  const f0 = await page.evaluate(() => window.__jgu.frames);
  await waitFor((f) => window.__jgu.frames >= f, `${n} frames`, 300000, f0 + n);
}
async function shot(name) {
  const st = await page.evaluate(() => {
    const s = window.__jgu.renderer.stats();
    return `calls ${s.calls} tris ${(s.triangles / 1000).toFixed(1)}k fps ${window.__jgu.fps?.toFixed?.(1) ?? '?'}`;
  });
  await page.screenshot({ path: `${out}/${name}.png` });
  log(`shot ${name}  (${st})`);
}
async function tapSel(sel) {
  await page.waitForSelector(sel, { state: 'visible', timeout: 30000 });
  await page.tap(sel);
}
async function tapText(text) {
  const loc = page.locator('#ui button', { hasText: text }).first();
  await loc.waitFor({ state: 'visible', timeout: 30000 });
  await loc.tap();
}

/** Put the climber back on the wall around fraction `f` of its height (hands on two holds, feet below). */
async function respawnAt(f, steepest = false) {
  return page.evaluate(
    ({ f, steepest }) => {
      const sim = window.__jgu.sim;
      const b = sim.boulder;
      let y0 = b.height * f;
      if (steepest && b.profile && b.profile.length > 1) {
        // the middle of the steepest panel
        let best = -1;
        b.profile.forEach((p, i) => {
          const y1 = i + 1 < b.profile.length ? b.profile[i + 1].y0 : b.height;
          if (p.angle > best) {
            best = p.angle;
            y0 = (p.y0 + y1) / 2 + 0.3;
          }
        });
      }
      const hands = b.holds.filter((h) => h.role !== 'deco' && h.type !== 'foot' && h.type !== 'volume');
      let pair = null;
      let score = Infinity;
      for (const a of hands)
        for (const c of hands) {
          if (a === c || a.x > c.x) continue;
          const dx = c.x - a.x;
          const dy = Math.abs(c.y - a.y);
          if (dx < 0.2 || dx > 0.9 || dy > 0.45) continue;
          const s = Math.abs((a.y + c.y) / 2 - y0) + dy;
          if (s < score) {
            score = s;
            pair = [a, c];
          }
        }
      if (!pair) return null;
      const hy = (pair[0].y + pair[1].y) / 2;
      const hx = (pair[0].x + pair[1].x) / 2;
      const feet = b.holds.filter((h) => h.role !== 'deco' && h.y < hy - 0.7 && h.y > hy - 1.7).sort((p, q2) => Math.abs(p.y - (hy - 1.15)) + Math.abs(p.x - hx) * 0.6 - (Math.abs(q2.y - (hy - 1.15)) + Math.abs(q2.x - hx) * 0.6));
      const lf = feet.find((h) => h.x <= hx) ?? feet[0];
      const rf = feet.find((h) => h.x > hx && h !== lf) ?? feet[1];
      const placement = { LH: pair[0].id, RH: pair[1].id };
      if (lf) placement.LF = lf.id;
      if (rf) placement.RF = rf.id;
      sim.respawn(placement);
      return { hy: +hy.toFixed(2), placement };
    },
    { f, steepest },
  );
}

/** A run seed whose first Send Train problem has `style` (searched with the game's own code). */
async function seedFor(style) {
  return page.evaluate(async (style) => {
    const { Rng, hashString } = await import('/src/core/rng.ts');
    const { runGradeFor } = await import('/src/game/scoring.ts');
    const { generateBoulder } = await import('/src/game/generator.ts');
    for (let s = 1000; s < 1400; s++) {
      const rng = new Rng(hashString(`send-train:${s}:0`));
      const grade = runGradeFor(0, rng);
      const seed = rng.int(1, 0x7ffffffe);
      // cheap pre-check of the archetype the generator picks (same options as the run)
      const b = generateBoulder({ seed, grade, colorIndex: 0 });
      if (b.style === style) return s;
    }
    return null;
  }, style);
}

async function forceRunSeed(cls, seed) {
  await page.evaluate(
    async ({ cls, seed }) => {
      const m = await import('/src/app/runs.ts');
      const C = m[cls];
      if (!C.__origReset) C.__origReset = C.prototype.reset;
      C.prototype.reset = function () {
        C.__origReset.call(this);
        this.seed = seed;
      };
    },
    { cls, seed },
  );
}

try {
  await page.goto(`${base}/?debug=1&q=${q}`, { waitUntil: 'load', timeout: 180000 });
  await waitFor(() => (window.__jgu?.frames ?? 0) > 3, 'first frames', 180000);
  const gen = await page.evaluate(async () => (await import('/src/config/tuning.ts')).GEN);
  log(`GEN ${JSON.stringify(gen)}`);
  await page.waitForTimeout(800);
  if (await page.$('.splash-hit')) await tapSel('.splash-hit');
  await waitScreen('title', 120000);
  await veilClear();
  if (doTitle) {
    // the title camera: a slow drift, sampled as a sequence
    for (let k = 0; k < 4; k++) {
      await page.waitForTimeout(k === 0 ? 2500 : 4000);
      await shot(`title-${k}`);
    }
  }
  for (const style of styles) {
    const s = await seedFor(style);
    if (s === null) {
      log(`no seed found for ${style}`);
      continue;
    }
    await forceRunSeed('SendTrainRun', s);
    await tapSel('.title-play');
    await waitScreen('modes');
    await tapSel('.mode-featured');
    await waitScreen('preview', 120000);
    await veilClear();
    const info = await page.evaluate(() => {
      const b = window.__jgu.app.activeSession?.boulder ?? window.__jgu.renderer.getBoulder();
      return { name: b.name, style: b.style, grade: b.grade, angle: b.wallAngle, profile: b.profile?.map((p) => `${p.y0}@${p.angle}`).join(' ') ?? 'flat' };
    });
    log(`${style}: ${JSON.stringify(info)}`);
    await waitFrames(60);
    await shot(`${style}-preview`);
    await tapSel('.pv-hit');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 60000);
    await waitFrames(60);
    await shot(`${style}-start`);
    const r = await respawnAt(0.62, style === 'cave');
    log(`respawn ${JSON.stringify(r)}`);
    await waitFrames(75);
    const ph = await page.evaluate(() => window.__jgu.sim.getState().phase);
    await shot(`${style}-high-${ph}`);
    await page.evaluate(() => window.__jgu.sim.forceFall());
    await waitScreen('results', 90000);
    await page.waitForTimeout(1200);
    await tapText('MENU');
    await waitScreen('modes', 60000);
    await veilClear();
    await page.tap('.btn-back');
    await waitScreen('title');
    await veilClear();
  }
  if (doLead) {
    await forceRunSeed('LeadTowerRun', 4242);
    await tapSel('.title-play');
    await waitScreen('modes');
    await page.locator('.mode-card', { hasText: /lead/i }).first().tap();
    await waitScreen('preview', 180000);
    await veilClear();
    const info = await page.evaluate(() => {
      const b = window.__jgu.renderer.getBoulder();
      return { name: b.name, grade: b.grade, angle: b.wallAngle, profile: b.profile?.map((p) => `${p.y0}@${p.angle}`).join(' ') ?? 'flat' };
    });
    log(`lead: ${JSON.stringify(info)}`);
    await waitFrames(70);
    await shot('lead-preview');
    await tapSel('.pv-hit');
    await waitFor(() => window.__jgu.sim?.getState().phase === 'climbing', 'climb start', 60000);
    await waitFrames(60);
    await shot('lead-start');
    for (const [f, steep] of [[0.45, false], [0, true]]) {
      const r = await respawnAt(f, steep);
      log(`respawn ${JSON.stringify(r)}`);
      await waitFrames(75);
      const ph = await page.evaluate(() => window.__jgu.sim.getState().phase);
      await shot(`lead-${steep ? 'headwall' : 'mid'}-${ph}`);
    }
  }
} catch (e) {
  log(`ERROR ${e.message}`);
  await page.screenshot({ path: `${out}/error.png` }).catch(() => {});
} finally {
  if (errors.length) console.log('console errors:\n' + errors.slice(0, 10).join('\n'));
  await browser.close();
}

// Audio verification: renders every sound effect, both music tracks, the ambience, the effort
// layer and a dense limited full mix in an OfflineAudioContext (headless Chromium, via the Vite
// dev server) and checks that each is non-silent, peaks ≤ 0.99 and contains no NaN/Inf.
// Also runs a live smoke test of GameAudio (unlock, every sfx, polyphony cap, suspend/resume).
//
// usage: node scripts/audio-check.mjs [--url http://localhost:5208] [--variants 4] [--music 40] [--no-live]
// If no server answers at --url, a Vite dev server is started in-process on that port.
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const base = (opt('url', 'http://localhost:5208') || '').replace(/\/$/, '');
const variants = +opt('variants', 4);
const musicSeconds = +opt('music', 40);
const live = !args.includes('--no-live');

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await reachable(base + '/dev/audio.html'))) {
  const { createServer } = await import('vite');
  const port = +(new URL(base).port || 5208);
  server = await createServer({
    configFile: new URL('../vite.config.ts', import.meta.url).pathname,
    root: new URL('..', import.meta.url).pathname,
    cacheDir: 'node_modules/.vite-audio',
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(base + '/dev/audio.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__audioCheck === 'function', null, { timeout: 30000 });

  const report = await page.evaluate((o) => window.__audioCheck(o), { variants, musicSeconds });

  const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
  console.log(
    pad('sound', 22) + pad('dur s', 7, true) + pad('active', 8, true) + pad('peak', 7, true) + pad('pk max', 8, true) +
      pad('rms dB', 8, true) + pad('loud A', 8, true) + pad('centroid', 10, true) + pad('bands <200|800|2.5k|6k|+', 27, true) + pad('NaN', 5, true) + '  result',
  );
  console.log('─'.repeat(126));
  for (const r of report.rows) {
    const s = r.stats;
    console.log(
      pad(r.name, 22) + pad(r.dur.toFixed(2), 7, true) + pad(s.active.toFixed(2), 8, true) + pad(s.peak.toFixed(3), 7, true) +
        pad(r.peakMax.toFixed(3), 8, true) + pad(s.rmsDb.toFixed(1), 8, true) + pad(s.loud.toFixed(1), 8, true) +
        pad(Math.round(s.centroid) + ' Hz', 10, true) + pad(s.bands.map((b) => String(Math.round(b * 100)).padStart(3)).join(' '), 27, true) +
        pad(s.nan ? 'YES' : 'no', 5, true) + '  ' + (r.ok ? 'PASS' : 'FAIL: ' + r.problems.join(', ')),
    );
  }
  const passed = report.rows.filter((r) => r.ok).length;
  console.log('─'.repeat(126));
  console.log(`offline: ${passed}/${report.rows.length} passed in ${report.ms} ms`);
  if (!report.ok) exitCode = 1;

  if (live) {
    const res = await page.evaluate(() => window.__audioLive());
    console.log('live:', JSON.stringify(res));
    const liveOk =
      res.errors.length === 0 && res.state === 'running' && res.cappedVoices <= 24 && res.suspendedState === 'suspended' && res.resumedState === 'running';
    console.log(`live: ${liveOk ? 'PASS' : 'FAIL'}${res.liveRms > 0 ? '' : ' (no live signal measured — headless output device may be muted)'}`);
    if (!liveOk) exitCode = 1;
  }
  if (logs.length) console.log(logs.join('\n'));
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await browser.close();
  if (server) await server.close();
}
process.exit(exitCode);

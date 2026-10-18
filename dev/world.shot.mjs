// WORLD dev: screenshot the world harness once it has really rendered (waits for N frames of the
// render loop instead of a fixed delay — SwiftShader shader compiles vary a lot).
// usage: node dev/world.shot.mjs "<world.html url>" out.png [--w 390] [--h 844] [--dpr 1] [--frames 40]
//        [--eval "js run after the frames"] [--after 1500] [--seq out2.png@1.5,out3.png@3 (extra shots at +s)]
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const w = +opt('w', 390), h = +opt('h', 844), dpr = +opt('dpr', 1), frames = +opt('frames', 40);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction((n) => window.__traj && window.__traj.length > n, frames, { timeout: 240000, polling: 250 });
  const ev = opt('eval', null);
  if (ev) {
    await page.evaluate(ev);
    await page.waitForTimeout(+opt('after', 1500));
  }
  await page.screenshot({ path: out, timeout: 180000 });
  console.log('saved', out);
  const seq = opt('seq', '');
  let t0 = 0;
  for (const item of seq.split(',').filter(Boolean)) {
    const [file, at] = item.split('@');
    await page.waitForTimeout(Math.max(0, (+at - t0) * 1000));
    t0 = +at;
    await page.screenshot({ path: file, timeout: 180000 });
    console.log('saved', file);
  }
  const errs = logs.filter((l) => /error/i.test(l) && !/404/.test(l));
  if (errs.length) console.log(errs.join('\n'));
} finally {
  await browser.close();
}

// Audio Lab: interactive test bench for src/audio + the hooks used by scripts/audio-check.mjs.
import type { SfxId } from '../src/core/contracts';
import { GameAudio } from '../src/audio/audio';
import { analyze, renderSfx, runAudioCheck, SFX_IDS, type CheckReport } from '../src/audio/offline';

const audio = new GameAudio();
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const CAPTIONS: Record<SfxId, string> = {
  grab: 'palm slap on plastic + chalk puff',
  'grab-bad': 'thin slap + fingertip scrape',
  release: 'skin unsticking',
  chalk: 'bag rustle + dusty puff',
  foot: 'rubber tap / squeak',
  smear: 'rubber squeal + drag',
  slip: 'sharp scrape + gasp',
  effort: 'grunt / exhale (varies)',
  strain: 'long strained breath',
  fall: 'whoosh + "whoa"',
  land: 'crash-pad thump',
  send: 'major stinger ~1.6 s',
  'top-touch': 'subtle chime',
  clip: 'two-stage gate snap',
  'rope-catch': 'rope zing + thud',
  'ui-tap': 'soft precise click',
  'ui-back': 'descending click',
  'ui-confirm': 'two-tone rise',
  'ui-swipe': 'airy swish',
  unlock: 'rewarding shimmer',
  whoosh: 'camera transition',
  countdown: '3 · 2 · 1 · GO',
  guide: "Steini's bleat blip",
  'score-tick': 'count-up tick',
};

let analyser: AnalyserNode | null = null;

async function ensureAudio(): Promise<void> {
  await audio.unlock();
  if (!analyser) analyser = audio.createAnalyser(2048);
  updateStatus();
}

function updateStatus(): void {
  const ctx = audio.context;
  const pill = $('#status');
  const running = !!ctx && ctx.state === 'running';
  pill.classList.toggle('on', running);
  pill.querySelector('span')!.textContent = ctx ? `${ctx.state} · ${(ctx.sampleRate / 1000).toFixed(1)} kHz` : 'Locked · tap anything';
}

document.addEventListener('pointerdown', () => void ensureAudio(), { capture: true });
document.addEventListener('keydown', () => void ensureAudio(), { capture: true });

// ── play options ──
const opt = { volume: 1, pitch: 1, pan: 0 };
function bindRange(id: string, out: string, fn: (v: number) => void): HTMLInputElement {
  const el = $<HTMLInputElement>('#' + id);
  const o = $('#' + out);
  const upd = (): void => {
    const v = parseFloat(el.value);
    o.textContent = v.toFixed(2);
    el.style.setProperty('--v', `${((v - +el.min) / (+el.max - +el.min)) * 100}%`);
    fn(v);
  };
  el.addEventListener('input', upd);
  upd();
  return el;
}
bindRange('pVol', 'o-vol', (v) => (opt.volume = v));
bindRange('pPitch', 'o-pitch', (v) => (opt.pitch = v));
bindRange('pPan', 'o-pan', (v) => (opt.pan = v));
let sfxVol = 0.85, musicVol = 0.6;
bindRange('sfxVol', 'o-sfx', (v) => { sfxVol = v; audio.setVolumes(sfxVol, musicVol); });
bindRange('musicVol', 'o-music', (v) => { musicVol = v; audio.setVolumes(sfxVol, musicVol); });

// ── sfx grid ──
const grid = $('#sfx');
for (const id of SFX_IDS) {
  const b = document.createElement('button');
  b.className = 'sfx';
  b.innerHTML = `<b>${id}</b><small>${CAPTIONS[id]}</small>`;
  b.addEventListener('click', async () => {
    await ensureAudio();
    audio.play(id, { ...opt });
    flash(b);
    if ($<HTMLInputElement>('#renderOnPlay').checked) void preview(id);
  });
  grid.appendChild(b);
}

function flash(b: HTMLElement): void {
  b.classList.add('hit');
  setTimeout(() => b.classList.remove('hit'), 140);
}

// ── offline preview ──
async function preview(id: SfxId): Promise<void> {
  const { buffer, end } = await renderSfx(id, { pitch: opt.pitch });
  const st = analyze(buffer);
  $('#w-name').textContent = `Offline · ${id}`;
  $('#w-dur').textContent = `${end.toFixed(2)} s`;
  $('#w-peak').textContent = `${st.peak.toFixed(3)}`;
  $('#w-rms').textContent = `${st.rmsDb.toFixed(1)} dB · ${(st.centroid / 1000).toFixed(1)}k`;
  drawWave(buffer);
}

function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

function drawWave(buf: AudioBuffer): void {
  const c = $<HTMLCanvasElement>('#wave');
  const g = fitCanvas(c);
  const w = c.clientWidth, h = c.clientHeight;
  g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.06)';
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const per = Math.max(1, Math.floor(L.length / w));
  g.fillStyle = '#FF4F1F';
  for (let x = 0; x < w; x++) {
    let mn = 0, mx = 0;
    for (let i = x * per; i < (x + 1) * per && i < L.length; i++) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    g.fillRect(x, h / 2 - mx * h * 0.48, 1, Math.max(1, (mx - mn) * h * 0.48));
  }
}

// ── scope ──
const scopeData = new Uint8Array(2048);
const specData = new Uint8Array(1024);
function drawScope(): void {
  const c = $<HTMLCanvasElement>('#scope');
  const g = fitCanvas(c);
  const w = c.clientWidth, h = c.clientHeight;
  g.clearRect(0, 0, w, h);
  if (analyser) {
    analyser.getByteFrequencyData(specData);
    const bins = 96;
    for (let i = 0; i < bins; i++) {
      const lo = Math.floor(Math.pow(i / bins, 2) * 900) + 1;
      const v = specData[lo] / 255;
      g.fillStyle = `rgba(154,212,222,${0.12 + v * 0.35})`;
      const bw = w / bins;
      g.fillRect(i * bw + 1, h - v * h * 0.9, bw - 2, v * h * 0.9);
    }
    analyser.getByteTimeDomainData(scopeData);
    g.strokeStyle = '#E9E5DD';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < scopeData.length; i += 2) {
      const x = (i / scopeData.length) * w;
      const y = (scopeData[i] / 255) * h;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  $('#voices').textContent = `Voices ${audio.activeVoices}`;
  requestAnimationFrame(drawScope);
}
requestAnimationFrame(drawScope);

// ── music / ambience ──
const seg = $('#music');
seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.addEventListener('click', async () => {
    await ensureAudio();
    const tr = b.dataset.track as 'menu' | 'climb' | 'none';
    audio.setMusic(tr);
    audio.play('ui-tap');
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
});
$<HTMLInputElement>('#amb').addEventListener('change', async (e) => {
  await ensureAudio();
  audio.setAmbience((e.target as HTMLInputElement).checked);
});
$<HTMLInputElement>('#haptics').addEventListener('change', (e) => audio.setHaptics((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('#suspend').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) audio.suspend();
  else audio.resume();
  setTimeout(updateStatus, 200);
});

// ── intensity ──
let tension = 0, pump = 0;
const tEl = bindRange('tension', 'o-ten', (v) => { tension = v; audio.setIntensity(tension, pump); });
const pEl = bindRange('pump', 'o-pump', (v) => { pump = v; audio.setIntensity(tension, pump); });
let auto: number | null = null;
$<HTMLInputElement>('#autoClimb').addEventListener('change', async (e) => {
  await ensureAudio();
  if ((e.target as HTMLInputElement).checked) {
    const t0 = performance.now();
    auto = window.setInterval(() => {
      const s = (performance.now() - t0) / 1000;
      tension = Math.max(0, Math.min(1.5, 0.35 + 0.45 * Math.sin(s * 0.35) + 0.35 * Math.sin(s * 1.3) ** 2 + s * 0.01));
      pump = Math.min(1, s / 40);
      tEl.value = String(tension);
      pEl.value = String(pump);
      tEl.dispatchEvent(new Event('input'));
      pEl.dispatchEvent(new Event('input'));
    }, 50);
  } else {
    if (auto !== null) clearInterval(auto);
    auto = null;
    tEl.value = '0';
    pEl.value = '0';
    tEl.dispatchEvent(new Event('input'));
    pEl.dispatchEvent(new Event('input'));
  }
});

// ── sequences ──
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
document.querySelectorAll<HTMLButtonElement>('[data-seq]').forEach((b) => {
  b.addEventListener('click', async () => {
    await ensureAudio();
    flash(b);
    const seq = b.dataset.seq;
    if (seq === 'score') {
      for (let i = 0; i < 40; i++) {
        audio.play('score-tick', { pitch: 1 + i * 0.012 });
        await wait(35);
      }
      audio.play('ui-confirm');
    } else if (seq === 'steini') {
      const chunks = 'Hey! I am Steini. Grab the glowing hold, then move your feet up.'.split(/\s+/);
      for (const w of chunks) {
        audio.play('guide');
        await wait(90 + w.length * 22);
      }
    } else if (seq === 'count') {
      for (let n = 3; n >= 0; n--) {
        audio.countdownStep(n);
        await wait(800);
      }
    } else if (seq === 'climb') {
      for (let i = 0; i < 3; i++) {
        audio.play('release', { pan: -0.2 });
        await wait(220);
        audio.play('effort');
        await wait(120);
        audio.play(i === 1 ? 'grab-bad' : 'grab', { pan: 0.2 });
        await wait(420);
        audio.play('foot', { pan: -0.1 });
        await wait(600);
      }
    } else if (seq === 'spam') {
      for (let i = 0; i < 60; i++) {
        audio.play('grab', { volume: 0.5 });
        await wait(16);
      }
    } else if (seq === 'haptic') {
      audio.haptic([30, 40, 30]);
    }
  });
});

// ── offline verification ──
function renderReport(r: CheckReport): void {
  const tb = $('#report tbody');
  tb.innerHTML = '';
  for (const row of r.rows) {
    const tr = document.createElement('tr');
    const s = row.stats;
    tr.innerHTML = `<td>${row.name}</td><td>${row.dur.toFixed(2)}</td><td>${s.active.toFixed(2)}</td><td>${s.peak.toFixed(3)}</td><td>${row.peakMax.toFixed(3)}</td><td>${s.rmsDb.toFixed(1)}</td><td>${Math.round(s.centroid)}</td><td>${(s.low * 100).toFixed(0)}%</td><td>${s.nan ? 'YES' : 'no'}</td><td class="${row.ok ? 'ok' : 'bad'}">${row.ok ? 'PASS' : row.problems.join(', ')}</td>`;
    tb.appendChild(tr);
  }
  $('#summary').textContent = `${r.ok ? 'ALL PASS' : 'FAILURES'} · ${r.rows.filter((x) => x.ok).length}/${r.rows.length} · ${r.ms} ms`;
}

$('#runCheck').addEventListener('click', async () => {
  $('#summary').textContent = 'Rendering…';
  renderReport(await runAudioCheck());
});

// ── hooks for scripts/audio-check.mjs ──
declare global {
  interface Window {
    __audioCheck?: (o?: { variants?: number; musicSeconds?: number }) => Promise<CheckReport>;
    __audioLive?: () => Promise<Record<string, unknown>>;
    __audio?: GameAudio;
  }
}
window.__audio = audio;
window.__audioCheck = async (o) => {
  const r = await runAudioCheck(o);
  renderReport(r);
  return r;
};
window.__audioLive = async () => {
  const errors: string[] = [];
  const onErr = (e: ErrorEvent): void => void errors.push(e.message);
  window.addEventListener('error', onErr);
  // Calls before unlock must be harmless no-ops.
  audio.play('grab');
  audio.setMusic('menu');
  audio.setAmbience(true);
  audio.setIntensity(0.8, 0.5);
  audio.setVolumes(0.9, 0.7);
  await audio.unlock();
  const ctx = audio.context;
  const an = audio.createAnalyser(2048);
  const buf = new Float32Array(2048);
  let maxRms = 0;
  const sample = (): void => {
    if (!an) return;
    an.getFloatTimeDomainData(buf);
    let sq = 0;
    for (const v of buf) sq += v * v;
    maxRms = Math.max(maxRms, Math.sqrt(sq / buf.length));
  };
  for (const id of SFX_IDS) {
    try {
      audio.play(id, { volume: 0.8, pitch: 1, pan: 0 });
    } catch (e) {
      errors.push(`${id}: ${String(e)}`);
    }
    await wait(40);
    sample();
  }
  const peakVoices = audio.activeVoices;
  for (let i = 0; i < 80; i++) audio.play('grab');
  const cappedVoices = audio.activeVoices;
  await wait(1200);
  sample();
  audio.setMusic('climb');
  audio.setIntensity(1.4, 0.9);
  for (let i = 0; i < 10; i++) {
    await wait(150);
    sample();
  }
  audio.suspend();
  await wait(150);
  const suspendedState = ctx?.state;
  audio.resume();
  await wait(250);
  const resumedState = ctx?.state;
  audio.setMusic('none');
  audio.setAmbience(false);
  audio.setIntensity(0, 0);
  await wait(300);
  window.removeEventListener('error', onErr);
  return {
    state: ctx?.state ?? 'none',
    sampleRate: ctx?.sampleRate ?? 0,
    peakVoices,
    cappedVoices,
    liveRms: +maxRms.toFixed(4),
    suspendedState,
    resumedState,
    errors,
  };
};

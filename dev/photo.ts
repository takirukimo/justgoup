// PHOTO dev harness: GameRenderer + GameUI + src/photo's importer, fed procedurally generated wall photos
// (src/photo/synth.ts: no real photos are bundled). Not part of the shipped build.
//
// URL params:
//   sample=1..4    open the importer straight on a generated photo (else the PHOTO step / the sample picker)
//   claude=mock    a stand-in window.claude whose `sample` answers from the generated truth (Set-of-Mark ids
//                  parsed from the prompt); claude=deny | bad | busy | slow exercise the failure paths and
//                  the progress line; claude=noimages declares no images (the button stays hidden)
//   q=low|medium|high

import { GameRenderer } from '../src/render/renderer';
import { GameUI } from '../src/ui/ui';
import { openPhotoImport, type PhotoImporter } from '../src/photo/index';
import { synthPhoto, type SynthOptions, type SynthResult } from '../src/photo/synth';
import type { BoulderDef, QualityLevel } from '../src/core/types';

interface Sample {
  label: string;
  o: SynthOptions;
}

const SAMPLES: Sample[] = [
  { label: 'YELLOW · FROM BELOW', o: { seed: 3, view: 'below', route: '#F2C230', wall: 'charcoal' } },
  { label: 'BLUE · SIDE, VOLUME', o: { seed: 5, view: 'left', route: '#2F6FEB', wall: 'grey', volume: 'route', touching: true, tapeTouch: true } },
  { label: 'WHITE · SQUARE ON', o: { seed: 9, view: 'front', route: '#EDEDED', wall: 'charcoal' } },
  { label: 'GREEN · WARM LEDS', o: { seed: 14, view: 'below', route: '#2FB36D', wall: 'grey', cast: [1.18, 1.0, 0.78], distractors: 22 } },
];

declare global {
  interface Window {
    __photo?: {
      renderer: GameRenderer;
      ui: GameUI;
      importer: PhotoImporter | null;
      synth: SynthResult | null;
      result: BoulderDef | null | undefined;
      open(n?: number): Promise<void>;
      /** PNG data URL of a generated sample photo (for file-input QA; it becomes the truth for holdScreen). */
      samplePng(n: number): Promise<string>;
      /** PNG data URL of a photo generated from these options (bad-photo QA); it becomes the truth. */
      synthPng(o: SynthOptions, scale?: number): Promise<string>;
      /** Screen point (css px, page coords) of a wall point (m: x from the centre, y up) in the current view. */
      wallScreen(x: number, y: number): { x: number; y: number } | null;
      /** Screen point (css px, page coords) of a generated truth hold in the current step's view. */
      holdScreen(i: number): { x: number; y: number } | null;
      /** Screen points of the photo's true wall corners (FRAME step). */
      trueCorners(): { x: number; y: number }[];
      claudeCalls: number;
    };
  }
}

const qs = new URLSearchParams(location.search);
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLDivElement;
const dev = document.getElementById('dev') as HTMLDivElement;

const q = qs.get('q');
const renderer = new GameRenderer(canvas, { quality: q === 'low' || q === 'medium' || q === 'high' ? (q as QualityLevel) : 'medium' });
const ui = new GameUI();
ui.mount(uiRoot);
ui.setPortraitProvider((h) => renderer.portrait(h, 160));
await renderer.init();
ui.show('editor', {});
renderer.setClimberVisible(false);

let last = performance.now();
const loop = (t: number): void => {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  renderer.frame(dt);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// ───────────────────────────── stand-in Claude ─────────────────────────────

const claudeMode = qs.get('claude');
const state: NonNullable<Window['__photo']> = {
  renderer,
  ui,
  importer: null,
  synth: null,
  result: undefined,
  open,
  samplePng,
  synthPng,
  wallScreen,
  holdScreen,
  trueCorners,
  claudeCalls: 0,
};
window.__photo = state;

if (claudeMode) {
  const answer = (prompt: string): unknown => {
    const s = state.synth;
    if (!s) return { holds: [] };
    // markers the page drew: "id: (x, y) size s"
    const marks = [...prompt.matchAll(/^(\d+): \(([\d.]+), ([\d.]+)\) size ([\d.]+)$/gm)].map((m) => ({ id: +m[1], x: +m[2], y: +m[3], size: +m[4] }));
    const W = s.wallW;
    const H = s.wallH;
    const truth = s.holds.filter((h) => h.route);
    const used = new Set<number>();
    const holds = truth.map((t) => {
      const x = (t.x + W / 2) / W;
      const y = (H - t.y) / H;
      let id: number | null = null;
      let bd = 0.035;
      for (const m of marks) {
        const d = Math.hypot(m.x - x, (m.y - y) * (H / W));
        if (d < bd && !used.has(m.id)) {
          bd = d;
          id = m.id;
        }
      }
      if (id !== null) used.add(id);
      const sz = (t.r * 2) / W;
      const type = t.r < 0.035 ? 'foot' : t.shape === 'crescent' ? 'edge' : t.shape === 'pocket' ? 'pocket' : t.shape === 'rail' ? 'rail' : t.r > 0.09 ? 'jug' : 'crimp';
      return { id, x: +x.toFixed(3), y: +y.toFixed(3), size: +sz.toFixed(3), type, role: 'hand', confidence: 0.86 };
    });
    // roles: the lowest hand holds start, the highest tops
    const hands = holds.filter((h) => h.type !== 'foot').sort((a, b) => b.y - a.y);
    if (hands[0]) hands[0].role = 'start';
    const topH = hands[hands.length - 1];
    if (topH) topH.role = 'top';
    const rejected = marks.filter((m) => !used.has(m.id)).map((m) => m.id);
    return { holds, rejected, wallAngleDeg: 25 };
  };
  const fn = Object.assign(
    async (input: string) => ({ text: JSON.stringify(answer(input)), truncated: false }),
    {
      async json(input: string, o?: { signal?: AbortSignal; onText?: (u: { text: string; delta: string }) => void }) {
        state.claudeCalls++;
        const wait = (ms: number) =>
          new Promise<void>((res, rej) => {
            const t = setTimeout(res, ms);
            o?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              rej({ code: 'cancelled', message: 'aborted' });
            });
          });
        if (claudeMode === 'deny') {
          await wait(500);
          throw { code: 'not_granted', message: 'viewer declined' };
        }
        if (claudeMode === 'busy') {
          await wait(500);
          throw { code: 'rate_limited', message: 'slow down' };
        }
        if (claudeMode === 'bad') {
          await wait(500);
          return { holds: [{ x: 0.5, y: 0.5 }] };
        }
        const a = answer(input);
        const text = JSON.stringify(a);
        await wait(claudeMode === 'slow' ? 2500 : 900);
        for (let k = 1; k <= 4; k++) {
          o?.onText?.({ text: text.slice(0, (text.length * k) / 4), delta: '' });
          await wait(claudeMode === 'slow' ? 600 : 120);
        }
        return a;
      },
      async limits() {
        return claudeMode === 'noimages' ? { maxPromptBytes: 262144 } : { maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20_000_000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } };
      },
    },
  );
  (window as unknown as { claude: unknown }).claude = { use: async (n: string) => (n === 'sample' ? fn : null) };
}

// ───────────────────────────── samples ─────────────────────────────

function photoCanvas(s: SynthResult): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = s.photo.width;
  c.height = s.photo.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.photo.data), s.photo.width, s.photo.height), 0, 0);
  return c;
}

function makeSample(n: number): SynthResult {
  const smp = SAMPLES[(n - 1 + SAMPLES.length) % SAMPLES.length];
  return synthPhoto({ photoW: 900, photoH: 1200, ppm: 200, ...smp.o });
}

async function samplePng(n: number): Promise<string> {
  state.synth = makeSample(n);
  return photoCanvas(state.synth).toDataURL('image/png');
}

async function synthPng(o: SynthOptions, scale = 1): Promise<string> {
  state.synth = synthPhoto({ photoW: 900, photoH: 1200, ppm: 200, ...o });
  const c = photoCanvas(state.synth);
  if (scale === 1) return c.toDataURL('image/png');
  // a downscaled copy (a thumbnail); the truth's corners scale with it
  const d = document.createElement('canvas');
  d.width = Math.max(1, Math.round(c.width * scale));
  d.height = Math.max(1, Math.round(c.height * scale));
  d.getContext('2d')!.drawImage(c, 0, 0, d.width, d.height);
  state.synth = { ...state.synth, quad: state.synth.quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as SynthResult['quad'] };
  return d.toDataURL('image/png');
}

function wallScreen(x: number, y: number): { x: number; y: number } | null {
  const imp = state.importer;
  const s = state.synth;
  if (!imp || !s) return null;
  const p = imp.toScreen({ x: ((x + s.wallW / 2) / s.wallW) * imp.rectW, y: ((s.wallH - y) / s.wallH) * imp.rectH });
  const r = (document.querySelector('.ph-stage') as HTMLElement).getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}

function holdScreen(i: number): { x: number; y: number } | null {
  const imp = state.importer;
  const s = state.synth;
  if (!imp || !s) return null;
  const t = s.holds.filter((h) => h.route && h.r > 0.05)[i];
  if (!t) return null;
  const p = imp.toScreen({ x: ((t.x + s.wallW / 2) / s.wallW) * imp.rectW, y: ((s.wallH - t.y) / s.wallH) * imp.rectH });
  const r = (document.querySelector('.ph-stage') as HTMLElement).getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}

function trueCorners(): { x: number; y: number }[] {
  const imp = state.importer;
  const s = state.synth;
  if (!imp || !s) return [];
  const r = (document.querySelector('.ph-stage') as HTMLElement).getBoundingClientRect();
  return s.quad.map((p) => {
    const q2 = imp.toScreen(p);
    return { x: r.left + q2.x, y: r.top + q2.y };
  });
}

async function open(n?: number): Promise<void> {
  dev.classList.remove('on');
  state.result = undefined;
  let file: Blob | undefined;
  if (n) {
    state.synth = makeSample(n);
    file = await new Promise<Blob>((res) => photoCanvas(state.synth!).toBlob((b) => res(b!), 'image/png'));
  }
  const b = await openPhotoImport({ root: uiRoot, renderer, ui, file, onOpen: (imp) => (state.importer = imp) });
  state.importer = null;
  state.result = b;
  showResult(b);
}

function showResult(b: BoulderDef | null): void {
  dev.textContent = '';
  if (b) {
    renderer.loadBoulder(b);
    renderer.setCameraMode('preview');
    const pre = document.createElement('pre');
    const roles = b.holds.reduce<Record<string, number>>((m, h) => ((m[h.role] = (m[h.role] ?? 0) + 1), m), {});
    const types = b.holds.reduce<Record<string, number>>((m, h) => ((m[h.type] = (m[h.type] ?? 0) + 1), m), {});
    pre.textContent = `${b.name} · ${b.holds.length} holds · wall ${b.wallAngle}° ${b.style ?? ''}\nroles ${JSON.stringify(roles)}\ntypes ${JSON.stringify(types)}\nheight ${b.height} m · colour ${b.color}`;
    dev.appendChild(pre);
  }
  const row = document.createElement('div');
  row.className = 'row';
  SAMPLES.forEach((s, i) => {
    const bt = document.createElement('button');
    bt.textContent = s.label;
    bt.onclick = () => void open(i + 1);
    row.appendChild(bt);
  });
  const blank = document.createElement('button');
  blank.className = 'go';
  blank.textContent = 'OPEN IMPORTER';
  blank.onclick = () => void open();
  dev.append(row, blank);
  dev.classList.add('on');
}

const n = Number(qs.get('sample'));
if (n >= 1) void open(n);
else if (qs.has('blank')) void open();
else showResult(null);

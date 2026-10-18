// UI dev harness: renders every screen with realistic mock props over a static wall backdrop
// (or the live renderer with ?bg=gl). Not part of the shipped build.
//
// URL params:
//   screen=splash|title|modes|name|hud|preview|pause|results|leaderboard|locker|settings|community|profile|
//          guide|callout|confirm|toast|icons|portraits|all
//   v=<variant>   results: send|fall|run-over|topped-rope · leaderboard/community: loading|empty|full ·
//                 hud: boulder|rope|shake|top|tutorial|calm|pumped|greasy|air|chalking|shakeout ·
//                 guide: top|bottom|think|warn|cheer · name: new|edit
//   bg=wall|gl|dark     pump=<0..1> tension=<0..1.5> (freeze HUD values)   rm=1 (reduced motion)   q=low
//   pumpL / pumpR / frL / frR=<0..1> (per-forearm pump and per-hand chalk friction)   pure=1 (Pure mode)

import { GameUI } from '../src/ui/ui';
import { bus, type AppEvents } from '../src/core/events';
import type { ResultsProps, ScreenId, ScreenProps } from '../src/core/contracts';
import type { BoulderDef, ClimberState, CommunityProblem, HeadId, LimbId, LimbSnapshot, Profile, RunInfo, ScoreEntry } from '../src/core/types';
import { BRAND, ROUTE_COLORS, WALL } from '../src/config/brand';
import { HEADS } from '../src/config/skins';
import { Rng } from '../src/core/rng';
import { ICONS, icon, type IconName } from '../src/ui/icons';
import { fallbackPortrait } from '../src/ui/portraits';

const qs = new URLSearchParams(location.search);
const screenParam = qs.get('screen') ?? 'title';
const variant = qs.get('v') ?? '';
const bg = qs.get('bg') ?? 'wall';

// ───────────────────────────── mock data ─────────────────────────────

const today = new Date().toISOString().slice(0, 10);

const profile: Profile = {
  version: 1,
  playerName: 'Crimp Ibex 27',
  head: 'ibex',
  colorway: 'basalt',
  chalk: 'classic',
  unlocked: { heads: ['ibex', 'marmot', 'chamois', 'eagle'], colorways: ['basalt', 'glacier', 'moss', 'ember'], chalks: ['classic', 'glacier'] },
  best: { boulder: 4820, rope: 1260, daily: { [today]: 980 } },
  stats: { sends: 86, falls: 41, highestGrade: 6, metersClimbed: 1342, longestStreak: 9, clips: 57, flashes: 23, totalScore: 18450 },
  tutorialDone: true,
  introSeen: true,
  settings: { sfx: 0.8, music: 0.55, haptics: true, quality: 'auto', assist: true, reducedMotion: qs.get('rm') === '1' },
  myProblems: [],
};
if (qs.get('q') === 'low') profile.settings.quality = 'low';

function mockBoulder(seed: number, grade: number, name: string, angle = 20, mode: 'boulder' | 'rope' = 'boulder'): BoulderDef {
  const rng = new Rng(seed);
  const color = ROUTE_COLORS[seed % ROUTE_COLORS.length].hex;
  const W = mode === 'rope' ? 4.4 : 4.6;
  const H = mode === 'rope' ? 15 : 4.5;
  const holds: BoulderDef['holds'] = [];
  let id = 0;
  const add = (x: number, y: number, role: BoulderDef['holds'][number]['role'], size: number, type: BoulderDef['holds'][number]['type'] = 'edge', col = color): void => {
    holds.push({ id: `h${id++}`, x, y, type, size, angle: -Math.PI / 2, role, color: col, seed: rng.int(0, 1e6) });
  };
  add(-0.3, 1.4, 'start', 0.1, 'jug');
  add(0.25, 1.35, 'start', 0.07);
  add(-0.4, 0.5, 'foot', 0.03, 'foot');
  add(0.35, 0.6, 'foot', 0.03, 'foot');
  let x = 0;
  for (let y = 1.9; y < H - 0.5; y += rng.range(0.45, 0.7)) {
    x = Math.max(-W / 2 + 0.4, Math.min(W / 2 - 0.4, x + rng.range(-0.8, 0.8)));
    add(x, y, 'hand', rng.range(0.05, 0.11), rng.pick(['crimp', 'sloper', 'pinch', 'jug', 'edge'] as const));
    if (rng.chance(0.5)) add(x + rng.range(-0.5, 0.5), y - 0.9, 'foot', 0.03, 'foot');
  }
  add(x * 0.5, H - 0.3, 'top', 0.11, 'jug');
  for (let i = 0; i < 26; i++) {
    const c = ROUTE_COLORS[rng.int(0, ROUTE_COLORS.length - 1)].hex;
    if (c === color) continue;
    add(rng.range(-W / 2 + 0.2, W / 2 - 0.2), rng.range(0.4, H - 0.2), 'deco', rng.range(0.04, 0.1), 'edge', c);
  }
  return { id: `b${seed}`, name, grade, mode, wallAngle: angle, width: W, height: H, holds, color, seed, quickdraws: mode === 'rope' ? [1.8, 3.4, 5.2, 7.1, 9.0, 11.0, 13.0, 14.6].map((y, i) => ({ id: `q${i}`, x: i % 2 ? 0.3 : -0.3, y })) : undefined };
}

const NAMES = ['Föhn Lisa', 'Sloper Marmot', 'Heel Hook Ram', 'Chalk Gremlin', 'Pinch Lynx 08', 'Dyno Chamois', 'Beta Hoarder', 'Gaston Eagle', 'Mantle Marmot', 'Jug Hugger', 'Smear Campaign', 'Crux Goblin', 'Pebble Wrestler', 'Undercling Ibex'];
const headIds = HEADS.map((h) => h.id);

function entries(mode: 'boulder' | 'rope' | 'daily'): ScoreEntry[] {
  const rng = new Rng(mode === 'boulder' ? 11 : mode === 'rope' ? 22 : 33);
  const out: ScoreEntry[] = NAMES.map((player, i) => ({
    id: `s${i}`,
    player,
    score: Math.round((mode === 'rope' ? 2200 : 9800) * Math.pow(0.86, i) * rng.range(0.96, 1.04)),
    mode,
    sends: Math.max(1, 24 - i * 2 + rng.int(-1, 1)),
    maxGrade: Math.max(1, 9 - Math.floor(i / 2)),
    head: headIds[(i * 3 + 1) % headIds.length] as HeadId,
    dailyKey: mode === 'daily' ? today : undefined,
  }));
  out.splice(6, 0, { player: profile.playerName, score: Math.round(out[5].score * 0.97), mode, sends: 12, maxGrade: 6, head: 'ibex' });
  return out;
}

const PROBLEM_NAMES: [string, string, number, number][] = [
  ['Salt Lick Traverse', 'Föhn Lisa', 3, 15],
  ['Steinbock Prow', 'Heel Hook Ram', 6, 35],
  ['Glacier Slab', 'Sloper Marmot', 2, -10],
  ['Marmot Hole', 'Pinch Lynx 08', 4, 5],
  ['Bartgeier', 'Dyno Chamois', 8, 40],
  ['Murmeli Mantle', 'Chalk Gremlin', 1, 0],
];
const problems: CommunityProblem[] = PROBLEM_NAMES.map(([name, author, grade, angle], i) => ({
  id: `p${i}`,
  name,
  author,
  grade,
  boulder: mockBoulder(100 + i * 7, grade, name, angle),
  plays: [412, 188, 96, 54, 31, 12][i],
  sends: [260, 41, 72, 19, 2, 11][i],
  createdAt: Date.now() - [3, 26, 70, 300, 1400, 4000][i] * 3600 * 1000,
}));

const boulder = mockBoulder(7, 4, 'Föhn Wind', 25);
const ropeRoute = mockBoulder(9, 5, 'The Dam Wall', 8, 'rope');

const runBoulder: RunInfo = { mode: 'boulder', score: 3240, streak: 4, boulderName: 'Föhn Wind', grade: 4, hintsLeft: 2 };
const runRope: RunInfo & { clipReady?: boolean } = { mode: 'rope', score: 640, streak: 0, boulderName: 'The Dam Wall', grade: 5, lives: 2, heightM: 7.4, nextClipIn: 1.2, hintsLeft: 1 };

const results: Record<string, ResultsProps> = {
  send: {
    kind: 'send',
    mode: 'boulder',
    boulderName: 'Föhn Wind',
    grade: 4,
    time: 38.6,
    points: 1420,
    breakdown: [
      { label: 'V4 send', value: 800 },
      { label: 'Streak ×4', value: 320 },
      { label: 'Flash bonus', value: 200 },
      { label: 'Speed bonus', value: 100 },
    ],
    runScore: 4660,
    streak: 5,
    best: 4660,
    newBest: true,
    rank: 7,
    unlocks: [{ kind: 'head', id: 'chamois', name: 'Chamois' }],
    canContinue: true,
  },
  fall: {
    kind: 'fall',
    mode: 'daily',
    boulderName: 'Daily · Alpenglow',
    grade: 5,
    time: 51.2,
    runScore: 0,
    streak: 0,
    best: 980,
    newBest: false,
    canContinue: false,
    tip: 'Hips close to the wall on overhangs. Your arms are ropes, not springs.',
  },
  'run-over': {
    kind: 'run-over',
    mode: 'boulder',
    boulderName: 'Sloper Garden',
    grade: 6,
    runScore: 5210,
    streak: 6,
    best: 5210,
    newBest: true,
    rank: 5,
    unlocks: [
      { kind: 'colorway', id: 'dune', name: 'Dune' },
      { kind: 'chalk', id: 'ember', name: 'Ember' },
    ],
    canContinue: false,
    tip: 'Slopers want your body right below them. Drop the hips before you move a hand.',
  },
  'topped-rope': {
    kind: 'topped-rope',
    mode: 'rope',
    boulderName: 'The Dam Wall',
    grade: 5,
    time: 212.4,
    points: 1880,
    breakdown: [
      { label: 'Height 15.0 m', value: 1500 },
      { label: 'Clips 8/8', value: 400 },
      { label: 'Top bonus', value: 500 },
      { label: 'Falls ×2', value: -520 },
    ],
    runScore: 1880,
    streak: 0,
    best: 1880,
    newBest: true,
    rank: 2,
    unlocks: [{ kind: 'head', id: 'ram', name: 'Bighorn Ram' }],
    canContinue: false,
  },
};

function propsFor(s: ScreenId): ScreenProps[ScreenId] {
  switch (s) {
    case 'splash':
      return {};
    case 'title':
      return { profile, backendLabel: variant === 'offline' ? 'OFFLINE' : variant === 'shared' ? 'CLAUDE SHARED' : 'GLOBAL' };
    case 'modes':
      return { profile, dailyKey: today, dailyBest: 980 };
    case 'name':
      return { current: variant === 'edit' ? profile.playerName : '' };
    case 'hud':
      return { run: variant === 'rope' ? runRope : variant === 'tutorial' ? { ...runBoulder, mode: 'tutorial', boulderName: 'First Moves', grade: 0, hintsLeft: undefined } : runBoulder };
    case 'preview':
      return variant === 'rope'
        ? { boulder: ropeRoute, run: runRope, tip: 'Clip from a good hold, at waist to chest height. Never clip from a crimp.' }
        : { boulder, run: runBoulder, tip: 'Read the feet first. The hands usually follow where the feet can go.' };
    case 'pause':
      return { run: variant === 'rope' ? runRope : runBoulder };
    case 'results':
      return results[variant] ?? results.send;
    case 'leaderboard': {
      const mode = (qs.get('mode') as 'boulder' | 'rope' | 'daily') ?? 'boulder';
      return { mode, entries: variant === 'loading' ? null : variant === 'empty' ? [] : entries(mode), me: profile.playerName, isGlobal: variant !== 'offline', dailyKey: today };
    }
    case 'locker':
      return { profile };
    case 'settings':
      return { profile };
    case 'community':
      return { problems: variant === 'loading' ? null : variant === 'empty' ? [] : problems, sort: 'new', isGlobal: variant !== 'offline' };
    case 'profile':
      return { profile };
    default:
      return {};
  }
}

// ───────────────────────────── mock climber state (HUD) ─────────────────────────────

function limb(id: LimbId): LimbSnapshot {
  return { id, holdId: 'h0', pos: { x: 0, y: 1 }, anchor: { x: 0, y: 1.2 }, depth: 0.03, dragging: false, load: 0.3, stress: 0.5, capacity: 0.6, reachRatio: 0.6, smearing: false, shake: 0, busy: false };
}
const state: ClimberState = {
  phase: 'climbing',
  pelvis: { x: 0, y: 1 },
  chest: { x: 0, y: 1.5 },
  com: { x: 0, y: 1.2 },
  pelvisDepth: 0.3,
  bodyYaw: 0,
  velocity: { x: 0, y: 0 },
  limbs: { LH: limb('LH'), RH: limb('RH'), LF: limb('LF'), RF: limb('RF') },
  tension: 0.3,
  pump: 0.2,
  shake: 0,
  balance: 0,
  topProgress: 0,
  time: 0,
  clipped: [],
};

// ───────────────────────────── backdrop ─────────────────────────────

function paintWall(): void {
  const c = document.getElementById('wall') as HTMLCanvasElement;
  if (bg === 'dark' || bg === 'gl') {
    c.style.display = 'none';
    return;
  }
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = c.clientWidth;
  const H = c.clientHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const rng = new Rng(42);
  // panels
  g.fillStyle = WALL.panel;
  g.fillRect(0, 0, W, H);
  const P = W / 3.2;
  for (let y = 0; y < H; y += P) for (let x = -P * 0.3; x < W; x += P) {
    g.fillStyle = (Math.floor(x / P) + Math.floor(y / P)) % 2 ? WALL.panel : WALL.panelAlt;
    g.fillRect(x, y, P, P);
  }
  g.strokeStyle = WALL.seam;
  g.lineWidth = 2;
  for (let x = -P * 0.3; x < W; x += P) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += P) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.fillStyle = WALL.tnut;
  for (let y = 10; y < H; y += P / 8) for (let x = 6; x < W; x += P / 8) { g.beginPath(); g.arc(x, y, 1.4, 0, 7); g.fill(); }
  // tone-on-tone logo
  g.save();
  g.translate(W * 0.5, H * 0.42);
  g.fillStyle = WALL.logoTone;
  g.font = `800 ${W * 0.36}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(BRAND.name, 0, 0);
  g.translate(-W * 0.3, -W * 0.44);
  g.scale(W / 260, W / 260);
  for (const d of BRAND.logoPaths) g.fill(new Path2D(d));
  g.restore();
  // holds
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H * 0.86);
    const r = rng.range(5, 17);
    const col = ROUTE_COLORS[rng.int(0, ROUTE_COLORS.length - 1)].hex;
    g.fillStyle = 'rgba(255,255,255,.05)';
    g.beginPath(); g.arc(x + 2, y + 3, r * 1.6, 0, 7); g.fill();
    const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r);
    grd.addColorStop(0, '#ffffff55');
    grd.addColorStop(0.25, col);
    grd.addColorStop(1, '#00000088');
    g.fillStyle = grd;
    g.beginPath(); g.ellipse(x, y, r, r * rng.range(0.6, 1), rng.range(0, 3), 0, 7); g.fill();
  }
  // climber silhouette
  g.save();
  g.translate(W * 0.5, H * 0.56);
  g.strokeStyle = '#1C1E22';
  g.lineCap = 'round';
  g.lineWidth = 14;
  g.beginPath(); g.moveTo(0, -40); g.lineTo(0, 30); g.stroke();
  g.lineWidth = 9;
  g.beginPath(); g.moveTo(-6, -36); g.lineTo(-40, -70); g.lineTo(-52, -112); g.stroke();
  g.beginPath(); g.moveTo(6, -36); g.lineTo(44, -60); g.lineTo(62, -96); g.stroke();
  g.lineWidth = 11;
  g.beginPath(); g.moveTo(-4, 30); g.lineTo(-34, 70); g.lineTo(-40, 120); g.stroke();
  g.beginPath(); g.moveTo(4, 30); g.lineTo(40, 58); g.lineTo(44, 108); g.stroke();
  g.fillStyle = '#8A7458';
  g.beginPath(); g.ellipse(0, -62, 15, 18, 0, 0, 7); g.fill();
  g.strokeStyle = '#C9B79A';
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(-6, -76); g.quadraticCurveTo(-14, -112, -38, -112); g.stroke();
  g.beginPath(); g.moveTo(6, -76); g.quadraticCurveTo(14, -112, 38, -112); g.stroke();
  g.restore();
  // mats
  g.fillStyle = WALL.mat;
  g.fillRect(0, H * 0.9, W, H * 0.1);
  g.fillStyle = WALL.matStripe;
  g.fillRect(0, H * 0.9 + 10, W, 4);
  // light falloff
  const v = g.createRadialGradient(W / 2, H * 0.35, H * 0.1, W / 2, H * 0.4, H * 0.75);
  v.addColorStop(0, 'rgba(255,230,200,.06)');
  v.addColorStop(1, 'rgba(0,0,0,.55)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
}

// ───────────────────────────── harness ─────────────────────────────

const ui = new GameUI();
ui.mount(document.getElementById('ui')!);
ui.setSettings(profile.settings);
ui.onResetProgress = () => console.log('[dev] reset progress');
const w = window as unknown as { ui: GameUI; bus: typeof bus; state: ClimberState };
w.ui = ui;
w.bus = bus;
w.state = state;

const logEvents: (keyof AppEvents)[] = ['ui:tap', 'ui:back', 'ui:start-intro-done', 'ui:play', 'ui:tutorial', 'ui:open', 'ui:play-problem', 'ui:begin-climb', 'ui:pause', 'ui:resume', 'ui:retry', 'ui:next', 'ui:quit', 'ui:hint', 'ui:toggle-overview', 'ui:select-head', 'ui:select-colorway', 'ui:select-chalk', 'ui:settings-changed', 'ui:set-name', 'ui:leaderboard-tab', 'ui:community-refresh'];
for (const e of logEvents) bus.on(e, (p: unknown) => console.log(`[bus] ${e}`, p === undefined ? '' : JSON.stringify(p).slice(0, 160)));

// Simulated app reactions so tabs / sorting feel real in the harness.
bus.on('ui:leaderboard-tab', ({ mode }) => setTimeout(() => ui.update('leaderboard', { mode, entries: entries(mode), me: profile.playerName, isGlobal: true, dailyKey: today }), 700));
bus.on('ui:community-refresh', ({ sort }) =>
  setTimeout(() => ui.update('community', { problems: sort === 'popular' ? [...problems].sort((a, b) => b.plays - a.plays) : problems, sort, isGlobal: true }), 600),
);
bus.on('ui:select-head', ({ head }) => {
  profile.head = head;
  ui.update('locker', { profile });
});

const SCREENS: ScreenId[] = ['splash', 'title', 'modes', 'name', 'preview', 'hud', 'pause', 'results', 'leaderboard', 'locker', 'settings', 'community', 'profile'];

function devbar(): void {
  const bar = document.getElementById('devbar')!;
  for (const s of [...SCREENS, 'guide', 'callout', 'confirm', 'icons', 'portraits']) {
    const a = document.createElement('a');
    a.href = `?screen=${s}&bg=${bg}`;
    a.textContent = s;
    if (s === screenParam) a.className = 'on';
    bar.appendChild(a);
  }
}

function iconSheet(): void {
  const root = document.getElementById('ui')!;
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:absolute;inset:0;padding:20px 14px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px;align-content:start;background:#0D0E10;overflow:auto;pointer-events:auto';
  for (const name of Object.keys(ICONS) as IconName[]) {
    const cell = document.createElement('div');
    cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 2px;border:1px solid rgba(255,255,255,.08);border-radius:10px;color:#E9E5DD;font:500 8px JetBrains Mono,monospace;letter-spacing:.06em';
    const ic = icon(name);
    ic.style.cssText = 'width:26px;height:26px';
    cell.append(ic, name);
    sheet.appendChild(cell);
  }
  root.appendChild(sheet);
}

function portraitSheet(): void {
  const root = document.getElementById('ui')!;
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:absolute;inset:0;padding:20px 14px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-content:start;background:#0D0E10;pointer-events:auto';
  for (const h of HEADS) {
    const cell = document.createElement('div');
    cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;color:#E9E5DD;font:600 10px JetBrains Mono,monospace';
    const pt = document.createElement('span');
    pt.className = 'pt pt-flat';
    pt.style.cssText = 'width:96px;height:96px';
    const img = document.createElement('img');
    img.className = 'pt-img';
    img.src = fallbackPortrait(h.id);
    pt.appendChild(img);
    cell.append(pt, h.name);
    sheet.appendChild(cell);
  }
  root.appendChild(sheet);
}

/** HUD variants for the Phase B instruments (per-forearm pump, per-hand chalk, flight). */
const HUD_VARIANTS: Record<string, { pumpL: number; pumpR: number; frL: number; frR: number; tension?: number }> = {
  calm: { pumpL: 0.18, pumpR: 0.12, frL: 0.95, frR: 0.9, tension: 0.3 },
  pumped: { pumpL: 0.86, pumpR: 0.41, frL: 0.62, frR: 0.8, tension: 0.95 },
  greasy: { pumpL: 0.34, pumpR: 0.52, frL: 0.88, frR: 0.22, tension: 0.48 },
  air: { pumpL: 0.3, pumpR: 0.44, frL: 0.85, frR: 0.7, tension: 0.2 },
  chalking: { pumpL: 0.4, pumpR: 0.36, frL: 0.3, frR: 0.74, tension: 0.4 },
  shakeout: { pumpL: 0.66, pumpR: 0.3, frL: 0.7, frR: 0.8, tension: 0.35 },
};

let hudT = 0;
function hudLoop(): void {
  const freeze = qs.has('pump') || qs.has('tension') || variant in HUD_VARIANTS;
  const fixedPump = Number(qs.get('pump') ?? (variant === 'shake' ? 0.91 : 0.46));
  const fixedTen = Number(qs.get('tension') ?? (variant === 'shake' ? 1.05 : 0.52));
  let last = performance.now();
  const tick = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    hudT += dt;
    state.time = 12.4 + hudT;
    if (freeze || variant === 'shake') {
      state.pump = fixedPump;
      state.tension = fixedTen;
      state.shake = variant === 'shake' ? 0.5 : 0;
      state.balance = variant === 'shake' ? 0.72 : -0.18;
    } else {
      state.pump = 0.35 + 0.3 * Math.sin(hudT * 0.4);
      state.tension = 0.55 + 0.45 * Math.sin(hudT * 0.9);
      state.balance = Math.sin(hudT * 0.7) * 0.6;
    }
    state.topProgress = variant === 'top' ? 0.62 : 0;
    // Phase B per-forearm pump + per-hand chalk, flight
    const V = HUD_VARIANTS[variant] ?? null;
    const num = (k: string, d: number): number => (qs.has(k) ? Number(qs.get(k)) : d);
    const LH = state.limbs.LH;
    const RH = state.limbs.RH;
    if (V || qs.has('pumpL') || qs.has('frL')) {
      LH.pump = num('pumpL', V?.pumpL ?? state.pump);
      RH.pump = num('pumpR', V?.pumpR ?? state.pump * 0.6);
      LH.friction = num('frL', V?.frL ?? 0.92);
      RH.friction = num('frR', V?.frR ?? 0.86);
      state.pump = Math.max(LH.pump, RH.pump);
      if (V?.tension !== undefined) state.tension = V.tension;
    } else {
      LH.pump = state.pump;
      RH.pump = state.pump * 0.62;
      LH.friction = 0.9 - 0.05 * Math.sin(hudT * 0.3);
      RH.friction = 0.55 + 0.2 * Math.sin(hudT * 0.25);
    }
    LH.chalking = variant === 'chalking';
    LH.busy = variant === 'chalking';
    LH.holdId = variant === 'chalking' || variant === 'shakeout' ? null : 'h0';
    LH.shakingOut = variant === 'shakeout';
    state.airborne = variant === 'air';
    state.flight = variant === 'air' ? { kind: 'deadpoint', limbs: ['RH'], holdId: 'h4', t: 0.12, apexIn: 0.08, power: 1.1 } : null;
    RH.flying = variant === 'air';
    RH.holdId = variant === 'air' ? null : 'h1';
    if (ui.current === 'hud') ui.hud.update(state, (propsFor('hud') as ScreenProps['hud']).run);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function startGl(): Promise<void> {
  if (bg !== 'gl') return;
  try {
    const [{ GameRenderer }, gameMod] = await Promise.all([import('../src/render/renderer'), import('../src/game/index')]);
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    const r = new GameRenderer(canvas);
    await r.init();
    const b = gameMod.generateBoulder({ seed: 7, grade: 4 });
    r.loadBoulder(b);
    const sim = new gameMod.ClimberSim(b);
    sim.reset();
    r.setSkin(profile.head, profile.colorway, profile.chalk);
    const cam = screenParam === 'preview' ? 'preview' : screenParam === 'hud' || screenParam === 'pause' ? 'follow' : screenParam === 'results' ? 'celebrate' : 'title';
    r.setCameraMode(cam, { instant: true });
    ui.setPortraitProvider((h) => r.portrait(h, 192));
    let last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      sim.step(dt);
      r.updateClimber(sim.getState(), dt);
      r.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (err) {
    console.warn('[dev] live renderer unavailable, using static wall', err);
    bgFallback();
  }
}
function bgFallback(): void {
  const c = document.getElementById('wall') as HTMLCanvasElement;
  c.style.display = 'block';
}

function show(s: string): void {
  if (s === 'icons') return iconSheet();
  if (s === 'portraits') return portraitSheet();
  if (s === 'guide') {
    ui.show('hud', propsFor('hud') as ScreenProps['hud']);
    hudLoop();
    const pos = variant === 'top' ? 'top' : 'bottom';
    const mood = (['think', 'warn', 'cheer', 'point'] as const).find((m) => m === variant) ?? 'point';
    void ui.guide.say({ text: 'Drag your LEFT HAND up to the glowing hold. Watch the ring: green means a solid grip.', mood, waitForTap: true, position: pos }).then(() =>
      ui.guide.say({ text: 'Nice! Now shift your hips under it before you move again.', mood: 'cheer', waitForTap: true, position: pos }),
    );
    ui.guide.setSkip(() => console.log('[dev] skip tutorial'));
    return;
  }
  if (s === 'callout') {
    ui.show('hud', propsFor('hud') as ScreenProps['hud']);
    hudLoop();
    const seq: [string, 'good' | 'bad' | 'neutral'][] = variant === 'count' ? [['3', 'neutral'], ['2', 'neutral'], ['1', 'neutral'], ['GO', 'good']] : variant === 'bad' ? [['WHIPPER!', 'bad']] : [['SENT!', 'good'], ['FLASH!', 'good'], ['CLIPPED', 'neutral'], ['WHIPPER!', 'bad']];
    let i = 0;
    const next = (): void => {
      const [t, st] = seq[i % seq.length];
      ui.hud.callout(t, st);
      i++;
      setTimeout(next, variant === 'count' ? 1000 : 1900);
    };
    setTimeout(next, 300);
    setTimeout(() => ui.hud.toast('Hint · move your right foot'), 600);
    return;
  }
  if (s === 'confirm') {
    ui.show('settings', propsFor('settings') as ScreenProps['settings']);
    setTimeout(() => void ui.confirm('Reset progress?', 'This wipes your scores, stats, unlocks and saved problems on this device. Leaderboard entries already submitted stay online.', 'RESET', 'KEEP MY PROGRESS').then((v) => console.log('[dev] confirm →', v)), 400);
    return;
  }
  if (s === 'toast') {
    ui.show('title', propsFor('title') as ScreenProps['title']);
    setTimeout(() => ui.hud.toast('Locked · 1,500 lifetime pts'), 300);
    return;
  }
  if (s === 'all') {
    let i = 0;
    const cycle = (): void => {
      const id = SCREENS[i % SCREENS.length];
      ui.show(id, propsFor(id) as never);
      i++;
      setTimeout(cycle, 2600);
    };
    hudLoop();
    cycle();
    return;
  }
  const id = s as ScreenId;
  ui.show(id, propsFor(id) as never);
  if (id === 'hud') hudLoop();
}

devbar();
paintWall();
void startGl();
(document.fonts?.ready ?? Promise.resolve()).then(() => paintWall());
show(screenParam);

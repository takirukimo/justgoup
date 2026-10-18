// Sim Lab — a 2D view of ClimberSim for tuning and visual QA (not part of the shipped build).
// URL params: ?grade=4&seed=12&mode=boulder|rope|tutorial|lab&bot=1&t=6 (pre-simulate t seconds)
//   env=1            draw all four reach envelopes (the dragged limb's is always drawn)
//   steps=5          tutorial: play the first n scripted TUTORIAL_SEQUENCE steps
//   moves=RF:hi,LH:x  play limb moves (limb:holdId) through beginDrag/dragTo/endDrag
//   hip=x,y          hold the hip handle at (x, y)
//   drag=RF:x,y      start dragging a limb and keep the finger at (x, y)
//   pause=1          freeze the sim after the setup

import type { BetaMove, SimEvent } from '../src/core/contracts';
import type { HoldDef, LimbId, Vec2 } from '../src/core/types';
import { PALETTE, WALL } from '../src/config/brand';
import { BODY, GAME } from '../src/config/tuning';
import { BetaBot, ClimberSim, generateBoulder, generateRopeRoute, gradeColor, gradeLabel, fontGrade, nextHint, RopeSystem, tutorialBoulder, TUTORIAL_SEQUENCE } from '../src/game';
import { hold as labHold, makeBoulder, moveLimb, run as runSim } from '../src/game/test-helpers';

const LIMBS: LimbId[] = ['LH', 'RH', 'LF', 'RF'];
const q = new URLSearchParams(location.search);
let grade = Number(q.get('grade') ?? 2);
let seed = Number(q.get('seed') ?? 1);
const mode = q.get('mode') ?? 'boulder';

const cv = document.getElementById('cv') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
const $ = (id: string): HTMLElement => document.getElementById(id)!;

let sim: ClimberSim;
let rope: RopeSystem | null = null;
let bot: BetaBot | null = null;
let hint: BetaMove | null = null;
let lastEvents: string[] = [];
let camY = 2;

/** A small vertical problem for anatomy demos: a high step, a crossover, a low hand hold. */
function labBoulder() {
  return makeBoulder(
    [
      labHold('s1', -0.2, 2.1, 'jug', 0.11, 'start'),
      labHold('s2', 0.25, 2.15, 'jug', 0.11, 'start'),
      labHold('f1', -0.25, 0.75, 'jug', 0.08, 'foot'),
      labHold('f2', 0.3, 0.8, 'jug', 0.08, 'foot'),
      labHold('hi', 0.5, 1.45, 'jug', 0.09, 'foot'),
      labHold('up', 0.12, 1.95, 'jug', 0.09, 'foot'),
      labHold('x', -0.52, 2.62, 'jug', 0.1, 'hand'),
      labHold('low', 0.42, 1.25, 'jug', 0.1, 'hand'),
      labHold('cross', 0.42, 0.62, 'jug', 0.08, 'foot'),
      labHold('t', 0, 4.1, 'jug', 0.12, 'top'),
    ],
    { name: 'Anatomy Lab' },
  );
}

function load(): void {
  const b = mode === 'lab' ? labBoulder() : mode === 'tutorial' ? tutorialBoulder() : mode === 'rope' ? generateRopeRoute({ seed, grade }) : generateBoulder({ seed, grade });
  sim = new ClimberSim(b);
  rope = b.mode === 'rope' ? new RopeSystem(b) : null;
  bot = null;
  hint = null;
  lastEvents = [];
  sim.start();
  $('name').textContent = b.name;
  $('meta').textContent = `CHIRAL HQ · ${b.mode === 'rope' ? 'LEAD TOWER' : 'BOULDER'} · SEED ${b.seed.toString(36).toUpperCase()}`;
  $('angle').textContent = `${b.wallAngle > 0 ? '+' : ''}${b.wallAngle}°`;
  const chip = $('grade');
  chip.textContent = `${gradeLabel(b.grade)} · ${fontGrade(b.grade)}`;
  chip.style.background = gradeColor(b.grade);
  camY = sim.getState().pelvis.y + 0.6;
  $('bot').classList.remove('on');
}

function setBot(on: boolean): void {
  bot = on ? new BetaBot(sim) : null;
  $('bot').classList.toggle('on', on);
}

// ── view transform ──
let W = 0;
let H = 0;
let dpr = 1;
function resize(): void {
  dpr = Math.min(3, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  W = r.width;
  H = r.height;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
}
const zoom = Number(q.get('zoom') ?? 1);
const scale = (): number => Math.min(W / (sim.boulder.width + 0.3), H / 3.6) * zoom;
const camX = (): number => (zoom > 1 ? sim.getState().pelvis.x : 0);
const toScreen = (p: Vec2): Vec2 => ({ x: W / 2 + (p.x - camX()) * scale(), y: H * 0.55 - (p.y - camY) * scale() });
const toWall = (x: number, y: number): Vec2 => ({ x: (x - W / 2) / scale() + camX(), y: camY - (y - H * 0.55) / scale() });

function stressColor(s: number): string {
  if (s < 0.6) return PALETTE.good;
  if (s < 1) return PALETTE.warn;
  return PALETTE.bad;
}

function drawHold(h: HoldDef, alpha: number): void {
  const p = toScreen(h);
  const r = Math.max(2, h.size * scale());
  ctx.globalAlpha = alpha;
  ctx.fillStyle = h.color;
  ctx.beginPath();
  if (h.type === 'volume') {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = h.angle + (i / n) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r;
      const y = p.y - Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else ctx.ellipse(p.x, p.y, r, r * (h.type === 'crimp' || h.type === 'edge' ? 0.55 : 0.85), -h.angle - Math.PI / 2, 0, Math.PI * 2);
  ctx.fill();
  // the incut side
  if (h.role !== 'deco' && h.type !== 'volume') {
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const a = -h.angle;
    ctx.arc(p.x, p.y, r * 0.8, a + Math.PI - 0.9, a + Math.PI + 0.9);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function label(text: string, p: Vec2, color: string): void {
  ctx.font = `600 ${10}px JetBrains Mono, monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, p.x, p.y);
}

function draw(): void {
  const s = sim.getState();
  const b = sim.boulder;
  camY += ((zoom > 1 ? s.pelvis.y + 0.25 : Math.max(1.8, s.pelvis.y + 0.5)) - camY) * 0.06;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PALETTE.basalt;
  ctx.fillRect(0, 0, W, H);
  // wall panel + T-nut grid + panel seams
  const tl = toScreen({ x: -b.width / 2, y: b.height });
  const br = toScreen({ x: b.width / 2, y: 0 });
  ctx.fillStyle = WALL.panel;
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.fillStyle = WALL.tnut;
  for (let y = 0.1; y < b.height; y += 0.2)
    for (let x = -b.width / 2 + 0.1; x < b.width / 2; x += 0.2) {
      const p = toScreen({ x, y });
      if (p.y < -4 || p.y > H + 4) continue;
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }
  ctx.strokeStyle = WALL.seam;
  ctx.lineWidth = 1;
  for (let y = 1.22; y < b.height; y += 1.22) {
    const a = toScreen({ x: -b.width / 2, y });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(br.x, a.y);
    ctx.stroke();
  }
  // pad
  const pad = toScreen({ x: 0, y: GAME.padHeight });
  ctx.fillStyle = WALL.mat;
  ctx.fillRect(tl.x - 10, pad.y, br.x - tl.x + 20, H - pad.y);
  ctx.fillStyle = WALL.matStripe;
  ctx.fillRect(tl.x - 10, pad.y, br.x - tl.x + 20, 3);

  for (const h of b.holds) if (h.role === 'deco') drawHold(h, 0.32);
  for (const h of b.holds) if (h.role !== 'deco') drawHold(h, 1);
  for (const h of b.holds) {
    if (h.role === 'start') label('START', toScreen({ x: h.x, y: h.y - h.size - 0.1 }), PALETTE.bone);
    if (h.role === 'top') label('TOP', toScreen({ x: h.x, y: h.y + h.size + 0.07 }), PALETTE.bone);
  }
  // quickdraws + rope
  if (b.quickdraws) {
    for (const d of b.quickdraws) {
      const p = toScreen(d);
      const c = toScreen({ x: d.x, y: d.y - 0.15 });
      ctx.strokeStyle = s.clipped.includes(d.id) ? PALETTE.signal : PALETTE.mist;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (rope) {
      const path = rope.ropePath(s.pelvis);
      ctx.strokeStyle = 'rgba(255,79,31,.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      path.forEach((p, i) => {
        const sp = toScreen(p);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.stroke();
    }
  }
  // hint
  if (hint) {
    const h = b.holds.find((x) => x.id === hint!.holdId) ?? b.quickdraws?.find((x) => x.id === hint!.holdId);
    if (h) {
      const p = toScreen(h);
      ctx.strokeStyle = PALETTE.glacier;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16 + 3 * Math.sin(performance.now() / 160), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // reach envelopes: all four (env=1) faintly, the dragged limb's strongly
  for (const l of LIMBS) {
    const ls = s.limbs[l];
    if (!ls.dragging && !showEnv) continue;
    drawEnvelope(l, ls.dragging);
  }
  // dragged limb: reachable holds, snap candidate
  for (const l of LIMBS) {
    const ls = s.limbs[l];
    if (!ls.dragging) continue;
    for (const id of sim.reachableHolds(l)) {
      const h = b.holds.find((x) => x.id === id)!;
      const p = toScreen(h);
      ctx.strokeStyle = 'rgba(233,229,221,.35)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, h.size * scale() + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    const tgt = drag.get(l)?.wall;
    if (tgt) {
      const c = sim.snapCandidate(l, tgt);
      if (c) {
        const qy = sim.predictGrip(l, c.id);
        const p = toScreen(c);
        ctx.strokeStyle = qy > 0.66 ? PALETTE.good : qy > 0.4 ? PALETTE.warn : PALETTE.bad;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, c.size * scale() + 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  // climber
  const shake = s.shake * 2.2;
  const jitter = (): number => (Math.random() - 0.5) * shake;
  const P = toScreen(s.pelvis);
  const C = toScreen(s.chest);
  ctx.lineCap = 'round';
  const order = [...LIMBS].sort((p, q) => (s.limbs[p].layer ?? 0) - (s.limbs[q].layer ?? 0));
  for (const l of order) {
    const ls = s.limbs[l];
    const a = toScreen(ls.anchor);
    const e = toScreen(ls.pos);
    const ex = e.x + jitter() * (1 + ls.shake * 3);
    const ey = e.y + jitter() * (1 + ls.shake * 3);
    // two-segment limb with a bent joint
    const len = Math.hypot(ex - a.x, ey - a.y);
    const full = (l === 'LH' || l === 'RH' ? BODY.armMax : BODY.legMax) * scale();
    const bend = Math.sqrt(Math.max(0, (full / 2) ** 2 - (len / 2) ** 2));
    const mx = (a.x + ex) / 2;
    const my = (a.y + ey) / 2;
    const nx = -(ey - a.y) / (len || 1);
    const ny = (ex - a.x) / (len || 1);
    const sgn = l === 'LH' || l === 'LF' ? -1 : 1;
    const kx = mx + nx * bend * sgn * (l === 'LF' || l === 'RF' ? -1 : 1);
    const ky = my + ny * bend * sgn * (l === 'LF' || l === 'RF' ? -1 : 1);
    if (ls.front) {
      // depth hint: this limb crosses in front of another one
      ctx.strokeStyle = 'rgba(13,14,16,.9)';
      ctx.lineWidth = (l === 'LF' || l === 'RF' ? 7 : 6) + 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(kx, ky, ex, ey);
      ctx.stroke();
    }
    ctx.strokeStyle = ls.holdId || ls.smearing ? stressColor(ls.stress) : 'rgba(233,229,221,.55)';
    ctx.lineWidth = l === 'LF' || l === 'RF' ? 7 : 6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(kx, ky, ex, ey);
    ctx.stroke();
    if (ls.front) label('FRONT', { x: (a.x + ex) / 2 + 14, y: (a.y + ey) / 2 }, PALETTE.glacier);
    ctx.fillStyle = ls.busy ? PALETTE.signal : PALETTE.bone;
    ctx.beginPath();
    ctx.arc(ex, ey, l === 'LF' || l === 'RF' ? 6 : 5, 0, Math.PI * 2);
    ctx.fill();
  }
  // torso + head
  const SL = toScreen(s.limbs.LH.anchor);
  const SR = toScreen(s.limbs.RH.anchor);
  const HL = toScreen(s.limbs.LF.anchor);
  const HR = toScreen(s.limbs.RF.anchor);
  ctx.fillStyle = PALETTE.graphite;
  ctx.strokeStyle = PALETTE.signal;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(SL.x, SL.y);
  ctx.lineTo(SR.x, SR.y);
  ctx.lineTo(HR.x, HR.y);
  ctx.lineTo(HL.x, HL.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const ux = (C.x - P.x) / (Math.hypot(C.x - P.x, C.y - P.y) || 1);
  const uy = (C.y - P.y) / (Math.hypot(C.x - P.x, C.y - P.y) || 1);
  const head = { x: C.x + ux * BODY.neck * scale() * 1.6, y: C.y + uy * BODY.neck * scale() * 1.6 };
  ctx.fillStyle = '#8A7458';
  ctx.beginPath();
  ctx.arc(head.x + jitter(), head.y + jitter(), BODY.headRadius * scale(), 0, Math.PI * 2);
  ctx.fill();
  // horns
  ctx.strokeStyle = '#C9B79A';
  ctx.lineWidth = 3;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(head.x + side * 4, head.y - 6);
    ctx.quadraticCurveTo(head.x + side * 16, head.y - 26, head.x + side * 22, head.y - 8);
    ctx.stroke();
  }
  // CoM + hip handle
  const com = toScreen(s.com);
  ctx.fillStyle = PALETTE.glacier;
  ctx.beginPath();
  ctx.arc(com.x, com.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(154,212,222,.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(P.x, P.y, 20, 0, Math.PI * 2);
  ctx.stroke();

  // HUD
  $('tension').textContent = s.tension.toFixed(2);
  $('tension').style.color = s.tension > 1 ? PALETTE.bad : s.tension > 0.7 ? PALETTE.warn : PALETTE.bone;
  ($('tensionBar') as HTMLElement).style.width = `${Math.min(100, (s.tension / 1.5) * 100)}%`;
  ($('tensionBar') as HTMLElement).style.background = stressColor(s.tension);
  $('pump').textContent = `${Math.round(s.pump * 100)}%`;
  ($('pumpBar') as HTMLElement).style.width = `${s.pump * 100}%`;
  ($('pumpBar') as HTMLElement).style.background = s.pump > 0.75 ? PALETTE.bad : s.pump > 0.5 ? PALETTE.warn : PALETTE.good;
  $('time').textContent = s.phase === 'topped' ? 'SENT' : s.phase === 'landed' ? 'FELL' : s.time.toFixed(1);
  ($('topBar') as HTMLElement).style.width = `${s.topProgress * 100}%`;
  $('limbs').innerHTML = LIMBS.map((l) => {
    const ls = s.limbs[l];
    return `<div class="limb">${l} <b style="color:${stressColor(ls.stress)}">${ls.holdId ? (ls.stress * 100).toFixed(0) + '%' : ls.smearing ? 'SMEAR' : '—'}</b><br>${(ls.load * 100).toFixed(0)}% BW · CAP ${(ls.capacity * 100).toFixed(0)}</div>`;
  }).join('');
  $('log').innerHTML = lastEvents.slice(-8).join('<br>');
}

const ENV_COLORS: Record<LimbId, string> = { LH: '154,212,222', RH: '255,178,63', LF: '79,209,139', RF: '255,79,31' };
const showEnv = q.get('env') === '1';
let envBuf: Vec2[] = [];
function drawEnvelope(l: LimbId, strong: boolean): void {
  const poly = sim.reachEnvelope(l, envBuf);
  envBuf = poly;
  const c = ENV_COLORS[l];
  ctx.beginPath();
  poly.forEach((v, i) => {
    const p = toScreen(v);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = `rgba(${c},${strong ? 0.09 : 0.045})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(${c},${strong ? 0.85 : 0.45})`;
  ctx.lineWidth = strong ? 1.6 : 1;
  ctx.setLineDash(strong ? [] : [4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = toScreen(poly[0]);
  ctx.fillStyle = `rgba(${c},0.9)`;
  ctx.fillRect(a.x - 2, a.y - 2, 4, 4);
}

// ── input: drag limbs and the hips ──
const drag = new Map<LimbId | 'hips', { id: number; wall: Vec2; off: Vec2 }>();
function pick(x: number, y: number): LimbId | 'hips' | null {
  const s = sim.getState();
  let best: LimbId | 'hips' | null = null;
  let bd = 34;
  for (const l of LIMBS) {
    if (drag.has(l)) continue;
    const p = toScreen(s.limbs[l].pos);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  const P = toScreen(s.pelvis);
  if (!drag.has('hips') && Math.hypot(P.x - x, P.y - y) < Math.min(bd, 26)) best = 'hips';
  return best;
}
cv.addEventListener('pointerdown', (e) => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const k = pick(x, y);
  if (!k) return;
  cv.setPointerCapture(e.pointerId);
  const s = sim.getState();
  const at = k === 'hips' ? s.pelvis : s.limbs[k].pos;
  const sp = toScreen(at);
  drag.set(k, { id: e.pointerId, wall: { ...at }, off: { x: sp.x - x, y: sp.y - y } });
  if (k === 'hips') sim.setHipTarget(at);
  else if (!sim.beginDrag(k)) drag.delete(k);
});
cv.addEventListener('pointermove', (e) => {
  const r = cv.getBoundingClientRect();
  for (const [k, d] of drag) {
    if (d.id !== e.pointerId) continue;
    d.wall = toWall(e.clientX - r.left + d.off.x, e.clientY - r.top + d.off.y);
    if (k === 'hips') sim.setHipTarget(d.wall);
    else sim.dragTo(k, d.wall);
  }
});
const up = (e: PointerEvent): void => {
  for (const [k, d] of drag) {
    if (d.id !== e.pointerId) continue;
    drag.delete(k);
    if (k === 'hips') sim.setHipTarget(null);
    else note(sim.endDrag(k));
  }
};
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);

function note(ev: readonly SimEvent[]): void {
  for (const e of ev) {
    const extra = 'limb' in e ? ` ${e.limb}` : '';
    const extra2 = 'holdId' in e && e.holdId ? ` → ${e.holdId}` : 'reason' in e ? ` (${e.reason})` : 'fallDistance' in e ? ` ${e.fallDistance.toFixed(1)} m` : '';
    lastEvents.push(`${sim.getState().time.toFixed(1)}  ${e.type.toUpperCase()}${extra}${extra2}`);
    if (e.type === 'clip-done') rope?.clip(e.quickdrawId);
  }
}

function tick(dt: number): void {
  if (bot) bot.update(dt, []);
  const ev = sim.step(dt);
  note(ev);
  if (bot && ev.length) bot.update(0, ev);
  const s = sim.getState();
  if (rope && s.phase === 'climbing') {
    const c = rope.catchParams(s.pelvis);
    sim.setRope(c.anchor, c.length);
  }
  if (s.phase === 'hanging' && s.time > 0) {
    hangT += dt;
    if (hangT > 1.6) {
      hangT = 0;
      sim.respawn({});
      if (bot) setBot(true);
    }
  }
}
let hangT = 0;

$('prev').onclick = () => {
  grade = Math.max(0, grade - 1);
  load();
};
$('next').onclick = () => {
  grade = Math.min(12, grade + 1);
  load();
};
$('new').onclick = () => {
  seed++;
  load();
};
$('bot').onclick = () => setBot(!bot);
$('hint').onclick = () => {
  hint = nextHint(sim);
};

resize();
window.addEventListener('resize', resize);
load();
if (q.get('bot') === '1') setBot(true);
// scripted setup for screenshots / QA
setup();
function setup(): void {
  const nSteps = Number(q.get('steps') ?? 0);
  if (nSteps > 0 && mode === 'tutorial') {
    for (const st of TUTORIAL_SEQUENCE.slice(0, nSteps)) {
      if (st.teach === 'hips') {
        const h = sim.boulder.holds.find((x) => x.id === st.holdId)!;
        sim.setHipTarget({ x: h.x, y: sim.getState().pelvis.y + 0.1 });
        runSim(sim, 1);
        sim.setHipTarget(null);
      } else {
        note(moveLimb(sim, st.limb, st.holdId));
        runSim(sim, 0.6);
      }
    }
  }
  for (const m of (q.get('moves') ?? '').split(',').filter(Boolean)) {
    const [l, id] = m.split(':') as [LimbId, string];
    note(moveLimb(sim, l, id));
    runSim(sim, 0.6);
  }
  const hip = q.get('hip');
  if (hip) {
    const [x, y] = hip.split(',').map(Number);
    sim.setHipTarget({ x, y });
    drag.set('hips', { id: -1, wall: { x, y }, off: { x: 0, y: 0 } });
    runSim(sim, 1.5);
  }
  const dr = q.get('drag');
  if (dr) {
    const [l, xy] = dr.split(':') as [LimbId, string];
    const [x, y] = xy.split(',').map(Number);
    if (sim.beginDrag(l)) {
      drag.set(l, { id: -1, wall: { x, y }, off: { x: 0, y: 0 } });
      for (let k = 0; k < 60; k++) {
        sim.dragTo(l, { x, y });
        runSim(sim, 1 / 60);
      }
    }
  }
  camY = zoom > 1 ? sim.getState().pelvis.y + 0.25 : sim.getState().pelvis.y + 0.5;
}
const pre = Number(q.get('t') ?? 0);
for (let t = 0; t < pre; t += 1 / 60) tick(1 / 60);
if (q.get('hint') === '1') hint = nextHint(sim);
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (q.get('pause') !== '1') tick(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as unknown as { simLab: unknown }).simLab = { get sim() { return sim; }, tick };

// In-climb HUD. `frame()` runs every frame: it only touches text that changed and drives
// meters with transforms / dash offsets (compositor-friendly, no layout reads, no innerHTML).
//
// Bottom instruments mirror the body: LEFT forearm · TENSION · RIGHT forearm. Each forearm column
// shows that arm's pump (segmented bar + %, calm → working → PUMPED with a warning glyph and a pulse;
// a 'pump-warning' sim event flashes it once) and that hand's chalk (FRESH → WORN → GREASY, CHALK
// while it is in the bag, SHAKE while it shakes out). The column is the hand's CHALK button: a tap
// sends 'ui:chalk' (LimbControls → sim.chalkUp); it invites a tap (hairline pill) when the hand is
// greasy and could chalk now. While the body flies through a deadpoint / dyno the instrument glass
// goes pink and the gauge reads AIRBORNE.

import type { ScreenProps, SimEvent } from '../../core/contracts';
import { bus } from '../../core/events';
import type { ClimberState, LimbSnapshot, RunInfo } from '../../core/types';
import '../../input/bus-events';
import { frictionWord } from '../../input/release';
import { GAME, SIM } from '../../config/tuning';
import { button, el, label, setText, toggle } from '../dom';
import { icon } from '../icons';
import { fmtClock, fmtInt, grade, gradeHex, modeTitle } from '../format';
import { screenRoot } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['hud'];

/**
 * RunInfo plus optional HUD-only hints the app may pass.
 * clipReady: a quickdraw is within a free hand's reach right now (shows "CLIP!").
 * chalk: chalk matters on this climb (the sim's ClimberSim.chalkMatters): each forearm column is
 *        its hand's CHALK button with a grip chip (FRESH / WORN / GREASY). Off in every boulder mode
 *        (owner decision: nobody chalks up mid-boulder), where the columns are pump gauges only.
 *        Default: on for lead ('rope'), off otherwise.
 */
export type HudRunInfo = RunInfo & { clipReady?: boolean; chalk?: boolean };

/** The special-stance pill (advanced moves): the stance and how to get out of it. */
export function specialText(sp: 'bat' | 'fig4'): { word: string; sub: string } {
  return sp === 'bat' ? { word: 'BAT HANG', sub: 'GRAB A HOLD TO SIT UP' } : { word: 'FIGURE 4', sub: 'REACH HIGH · A FOOT BACK ON ENDS IT' };
}

/** Does this climb show the CHALK buttons and grip chips? */
export function chalkShown(run: HudRunInfo): boolean {
  return run.chalk ?? run.mode === 'rope';
}

/** Fallback when the app does not pass `clipReady`: harness-relative distance at which a draw is reachable. */
export const CLIP_REACH_M = 1.0;
/** Tension at which the arc is full. */
const TENSION_FULL = 1.2;

const SVGNS = 'http://www.w3.org/2000/svg';

/** Forearm pump bands: working from 0.6, PUMPED from SIM.pumpWarn (deep pump), critical from 0.9. */
const PUMP_WORK = 0.6;
const PUMP_CRIT = 0.9;

type ArmState = 'calm' | 'warn' | 'pumped' | 'crit';

/** One forearm column of the instrument cluster (the hand's CHALK button). */
interface ArmView {
  hand: 'LH' | 'RH';
  btn: HTMLButtonElement;
  fill: HTMLElement;
  pct: HTMLElement;
  word: HTMLElement;
  flash: HTMLElement;
  q: { pump: number; pct: number; st: string; word: string; act: string; can: number; invite: number; aria: string };
}

/** Can this hand go to the chalk bag right now (mirrors ClimberSim.chalkUp's guards)? */
export function canChalk(s: ClimberState, hand: 'LH' | 'RH'): boolean {
  if (s.phase !== 'climbing' || s.airborne) return false;
  const L = s.limbs[hand];
  const o = s.limbs[hand === 'LH' ? 'RH' : 'LH'];
  if (L.busy || L.dragging || L.flying) return false;
  // hanging from the feet in a bat hang both hands are free: either may chalk
  if (s.special === 'bat') return !o.busy;
  if (s.special === 'figure4' && s.figure4?.hand === hand) return false; // the leg is over that arm
  return !!o.holdId && !o.busy && !o.dragging;
}

/** Forearm pump band for the HUD. */
export function armState(pump: number): ArmState {
  return pump >= PUMP_CRIT ? 'crit' : pump >= SIM.pumpWarn ? 'pumped' : pump >= PUMP_WORK ? 'warn' : 'calm';
}

/** What the chalk chip of a hand says: its activity (in the bag / shaking out) or its friction word. */
export function chalkChip(L: LimbSnapshot): { word: string; act: 'chalk' | 'shake' | '' ; fr: 'fresh' | 'worn' | 'greasy' } {
  const w = frictionWord(L.friction ?? 1);
  const fr = w === 'FRESH' ? 'fresh' : w === 'WORN' ? 'worn' : 'greasy';
  if (L.chalking) return { word: 'CHALK', act: 'chalk', fr };
  if (L.shakingOut) return { word: 'SHAKE', act: 'shake', fr };
  return { word: w, act: '', fr };
}

function arcGauge(): { svg: SVGSVGElement; val: SVGPathElement } {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 36');
  svg.setAttribute('class', 'tg-svg');
  svg.setAttribute('aria-hidden', 'true');
  const d = 'M6 32 A26 26 0 0 1 58 32';
  const mk = (cls: string): SVGPathElement => {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('pathLength', '100');
    p.setAttribute('class', cls);
    svg.appendChild(p);
    return p;
  };
  mk('tg-track');
  const val = mk('tg-val');
  mk('tg-ticks');
  // threshold notch where shaking starts
  const t = (SIM.shakeOn / TENSION_FULL) * Math.PI;
  const cx = 32 - Math.cos(t) * 26;
  const cy = 32 - Math.sin(t) * 26;
  const nx = -Math.cos(t);
  const ny = -Math.sin(t);
  const notch = document.createElementNS(SVGNS, 'line');
  notch.setAttribute('x1', String(cx - nx * 5));
  notch.setAttribute('y1', String(cy - ny * 5));
  notch.setAttribute('x2', String(cx + nx * 3.5));
  notch.setAttribute('y2', String(cy + ny * 3.5));
  notch.setAttribute('class', 'tg-notch');
  svg.appendChild(notch);
  return { svg, val };
}

export class HudView implements ScreenView<P> {
  readonly el: HTMLElement;
  readonly reuse = true;
  /** Unsubscribes the per-event HUD reactions (pump-warning flash, airborne). */
  private readonly offSim: () => void;

  // static-ish
  private nameEl = el('span', 'hr-name');
  private gradeEl = el('span', 'grade grade-sm', el('b'));
  private modeEl = el('span', 'hr-mode');
  private timeEl = el('span', 'hr-time t-num', '0:00.0');
  private scoreBox: HTMLElement;
  private scoreEl = el('span', 'hs-val t-num', '0');
  private streakEl = el('span', 'hs-streak', icon('flame'), el('span', 't-num', '×0'));
  private streakNum: HTMLElement;
  // rope
  private ropeRow: HTMLElement;
  private livesEl = el('span', 'hrp-lives');
  private heightEl = el('span', 'hrp-h t-num', '0.0');
  private clipEl = el('span', 'hrp-clip');
  private clipTxt = el('span', 'hrp-clip-txt');
  private alt: HTMLElement;
  private altMarker = el('div', 'alt-marker', el('span', 'alt-val t-num', '0.0'));
  private altVal: HTMLElement;
  // meters
  private arms: [ArmView, ArmView];
  private instBox: HTMLElement;
  private tenLbl: HTMLElement;
  private tenBox: HTMLElement;
  private tenArc: SVGPathElement;
  private tenState = el('span', 'tg-state', 'STEADY');
  private balDot = el('i', 'bal-dot');
  private topBox: HTMLElement;
  private topFill = el('i', 'tp-fill');
  // special stance (advanced moves): BAT HANG (with the core fatigue) / FIGURE 4 and how to get out
  private spBox: HTMLElement;
  private spWord = el('span', 'sp-word');
  private spSub = el('span', 'sp-sub');
  private spFill = el('i', 'sp-fill');
  private vig = el('div', 'hud-vig');
  // buttons
  private hintBtn: HTMLButtonElement;
  private hintCount = el('span', 'hint-count t-num');
  private eyeBtn: HTMLButtonElement;
  private overview = false;
  /** Chalk matters on this climb (lead): the forearm columns are CHALK buttons with grip chips. */
  private chalkOn = true;

  // last-written caches (avoid redundant DOM writes)
  private q = {
    air: '',
    ten: -1,
    tenState: '',
    bal: 999,
    tenths: -1,
    top: -1,
    vig: -1,
    score: NaN,
    streak: -1,
    lives: -1,
    height: -1,
    clip: -3,
    alt: -1,
    hints: -2,
    name: '',
    grade: -1,
    mode: '',
    chalk: -1,
    special: '',
    spf: -1,
  };

  constructor(_ctx: UICtx, props: P) {
    const root = screenRoot('hud');
    this.el = root;

    const pause = button({ icon: 'pause', variant: 'icon', cls: 'hud-pause', aria: 'Pause', onTap: () => bus.emit('ui:pause') });

    this.streakNum = this.streakEl.lastElementChild as HTMLElement;
    this.scoreBox = el('div', 'hud-score hud-glass', label('SCORE'), this.scoreEl, this.streakEl);

    const route = el(
      'div',
      'hud-route hud-glass',
      el('div', 'hr-row', this.nameEl, this.gradeEl),
      el('div', 'hr-sub', icon('stopwatch', 'hr-ic'), this.timeEl, el('i', 'hr-dot'), this.modeEl),
    );

    // rope extras
    this.clipEl.append(icon('carabiner', 'hrp-ic'), this.clipTxt);
    this.ropeRow = el(
      'div',
      'hud-rope',
      el('span', 'hrp-cell hud-glass', this.livesEl),
      el('span', 'hrp-cell hud-glass', icon('height', 'hrp-ic'), this.heightEl, el('small', null, 'M')),
      el('span', 'hrp-cell hud-glass hrp-clipcell', this.clipEl),
    );
    for (let i = 0; i < GAME.ropeLives; i++) this.livesEl.appendChild(icon('rope', 'life'));
    this.altVal = this.altMarker.firstElementChild as HTMLElement;
    const ticks = el('div', 'alt-ticks');
    for (let m = 0; m <= GAME.ropeWall.height; m += 5) {
      const t = el('span', 'alt-lbl t-num', String(m));
      t.style.bottom = `${(m / GAME.ropeWall.height) * 100}%`;
      ticks.appendChild(t);
    }
    this.alt = el('div', 'hud-alt', el('div', 'alt-rail'), ticks, this.altMarker);

    // top-hold progress
    this.topBox = el('div', 'hud-topprog hud-glass', icon('flag', 'tp-ic'), el('span', 'tp-txt', 'MATCH & HOLD'), el('span', 'tp-bar', this.topFill));
    this.spBox = el('div', 'hud-special hud-glass', icon('pure', 'sp-ic'), el('span', 'sp-txt', this.spWord, this.spSub), el('span', 'sp-bar', this.spFill));
    this.spBox.setAttribute('role', 'status');

    // instruments: left forearm · tension · right forearm
    this.arms = [this.buildArm('LH'), this.buildArm('RH')];
    const g = arcGauge();
    this.tenArc = g.val;
    this.tenLbl = label('TENSION', 'tg-lbl');
    this.tenBox = el(
      'div',
      'inst inst-ten',
      this.tenLbl,
      el('div', 'tg-wrap', g.svg, el('div', 'bal', el('i', 'bal-rail'), this.balDot)),
      el('div', 'tg-meta', icon('warn', 'inst-alert'), this.tenState),
    );
    this.instBox = el('div', 'hud-inst hud-glass', this.arms[0].btn, el('i', 'inst-sep'), this.tenBox, el('i', 'inst-sep'), this.arms[1].btn);
    this.offSim = bus.on('sim:event', this.onSimEvent);

    this.hintBtn = button({ icon: 'bulb', variant: 'icon', cls: 'hud-hint', aria: 'Hint', onTap: () => bus.emit('ui:hint') });
    this.hintBtn.appendChild(this.hintCount);
    this.eyeBtn = button({
      icon: 'eye',
      variant: 'icon',
      cls: 'hud-eye',
      aria: 'Route overview',
      onTap: () => {
        this.overview = !this.overview;
        this.eyeBtn.classList.toggle('on', this.overview);
        bus.emit('ui:toggle-overview');
      },
    });

    root.append(
      el('div', 'hud-scrim hud-scrim-top'),
      el('div', 'hud-scrim hud-scrim-bottom'),
      this.vig,
      el('div', 'hud-top', pause, route, this.scoreBox),
      this.ropeRow,
      this.topBox,
      this.spBox,
      this.alt,
      el(
        'div',
        'hud-bottom',
        el('div', 'hb-btn', this.hintBtn, label('HINT')),
        this.instBox,
        el('div', 'hb-btn', this.eyeBtn, label('LOOK')),
      ),
    );
    this.applyRun(props.run);
  }

  update(props: P): void {
    this.applyRun(props.run);
  }

  private buildArm(hand: 'LH' | 'RH'): ArmView {
    const side = hand === 'LH' ? 'L' : 'R';
    const fill = el('i', 'fa-fill');
    const pct = el('span', 'fa-pct t-num', '0%');
    const word = el('span', 'fa-word', 'FRESH');
    const flash = el('i', 'fa-flash');
    const btn = el(
      'button',
      `fa fa-${side.toLowerCase()} st-calm fr-fresh`,
      flash,
      el('span', 'fa-head', el('b', 'fa-side', side), icon('forearm', 'fa-ic'), icon('warn', 'fa-alert'), pct),
      el('span', 'fa-bar', fill, el('i', 'fa-seg')),
      el('span', 'fa-chalk', icon('chalk', 'fa-bag'), word),
    );
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (this.chalkOn) bus.emit('ui:chalk', { hand });
    });
    const v: ArmView = { hand, btn, fill, pct, word, flash, q: { pump: -1, pct: -1, st: 'calm', word: 'FRESH', act: '', can: -1, invite: -1, aria: '' } };
    this.armAria(v, 0, 'FRESH');
    return v;
  }

  private armAria(a: ArmView, pct: number, word: string): void {
    const side = a.hand === 'LH' ? 'Left' : 'Right';
    const aria = this.chalkOn ? `${side} forearm pump ${pct}%, chalk ${word.toLowerCase()}. Tap to chalk up.` : `${side} forearm pump ${pct}%`;
    if (aria !== a.q.aria) {
      a.q.aria = aria;
      a.btn.setAttribute('aria-label', aria);
    }
  }

  /** One forearm column per frame: cached, quantised writes only. */
  private frameArm(a: ArmView, s: ClimberState): void {
    const L = s.limbs[a.hand];
    const q = a.q;
    const pump = Math.min(1, Math.max(0, L.pump ?? s.pump));
    const pq = Math.round(pump * 200);
    if (pq !== q.pump) {
      q.pump = pq;
      a.fill.style.transform = `scaleX(${(pq / 200).toFixed(3)})`;
    }
    const pct = Math.round(pump * 100);
    const chip = chalkChip(L);
    if (pct !== q.pct) {
      q.pct = pct;
      setText(a.pct, `${pct}%`);
      this.armAria(a, pct, chip.word);
    }
    const st = armState(pump);
    if (st !== q.st) {
      a.btn.classList.remove(`st-${q.st}`);
      a.btn.classList.add(`st-${st}`);
      q.st = st;
    }
    const wordKey = chip.word + '|' + chip.fr;
    if (wordKey !== q.word) {
      const prevFr = q.word.split('|')[1];
      if (prevFr) a.btn.classList.remove(`fr-${prevFr}`);
      a.btn.classList.add(`fr-${chip.fr}`);
      q.word = wordKey;
      setText(a.word, chip.word);
      this.armAria(a, pct, chip.word);
    }
    if (chip.act !== q.act) {
      toggle(a.btn, 'is-chalking', chip.act === 'chalk');
      toggle(a.btn, 'is-shaking', chip.act === 'shake');
      q.act = chip.act;
    }
    const can = this.chalkOn && canChalk(s, a.hand) ? 1 : 0;
    if (can !== q.can) {
      q.can = can;
      toggle(a.btn, 'can', can === 1);
    }
    // invite a tap: greasy (or worn and pumped) and free to chalk right now
    const invite = can && !chip.act && (chip.fr === 'greasy' || (chip.fr === 'worn' && st !== 'calm')) ? 1 : 0;
    if (invite !== q.invite) {
      q.invite = invite;
      toggle(a.btn, 'invite', invite === 1);
    }
  }

  private readonly onSimEvent = (e: SimEvent): void => {
    if (e.type !== 'pump-warning' || !this.el.isConnected) return;
    const a = e.limb === 'LH' ? this.arms[0] : e.limb === 'RH' ? this.arms[1] : null;
    if (!a || typeof a.flash.animate !== 'function') return;
    // one tasteful flash (opacity + scale only: compositor work, no layout)
    a.flash.animate(
      [
        { opacity: 0.9, transform: 'scale(0.96)' },
        { opacity: 0, transform: 'scale(1.08)' },
      ],
      { duration: 720, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  };

  /** Static-ish run info (cheap to call every frame: guarded by caches). */
  private applyRun(run: HudRunInfo): void {
    const q = this.q;
    if (run.boulderName !== q.name) {
      q.name = run.boulderName;
      setText(this.nameEl, run.boulderName);
      // Long route names step down a size (and tighten) before they need an ellipsis.
      const n = run.boulderName.length;
      this.nameEl.style.setProperty('--hr-fs', n > 18 ? '13.5px' : n > 15 ? '14.5px' : n > 12 ? '16px' : '18px');
      this.nameEl.style.setProperty('--hr-ls', n > 12 ? '0.025em' : '0.06em');
    }
    if (run.grade !== q.grade) {
      q.grade = run.grade;
      setText(this.gradeEl.firstElementChild!, grade(run.grade));
      this.gradeEl.style.setProperty('--g', gradeHex(run.grade));
    }
    if (run.mode !== q.mode) {
      q.mode = run.mode;
      setText(this.modeEl, (modeTitle[run.mode] ?? run.mode).toUpperCase());
      const rope = run.mode === 'rope';
      toggle(this.el, 'is-rope', rope);
      toggle(this.el, 'is-tutorial', run.mode === 'tutorial');
    }
    const chalk = chalkShown(run) ? 1 : 0;
    if (chalk !== q.chalk) {
      q.chalk = chalk;
      this.chalkOn = chalk === 1;
      // boulders: pump gauges only (no CHALK button, no grip chip); lead keeps the chalk mechanic
      toggle(this.el, 'no-chalk', !this.chalkOn);
      for (const a of this.arms) {
        // a plain gauge: no tap sound, no press state, not focusable
        a.btn.disabled = !this.chalkOn;
        a.q.aria = '';
        this.armAria(a, Math.max(0, a.q.pct), a.q.word.split('|')[0] || 'FRESH');
      }
    }
    if (run.score !== q.score) {
      const up = Number.isFinite(q.score) && run.score > q.score;
      q.score = run.score;
      setText(this.scoreEl, fmtInt(run.score));
      if (up) this.bump(this.scoreBox);
    }
    if (run.streak !== q.streak) {
      q.streak = run.streak;
      setText(this.streakNum, `×${run.streak}`);
      toggle(this.streakEl, 'hot', run.streak >= 3);
      toggle(this.streakEl, 'none', run.streak <= 0);
    }
    const hints = run.hintsLeft === undefined ? -1 : run.hintsLeft;
    if (hints !== q.hints) {
      q.hints = hints;
      toggle(this.hintBtn.parentElement!, 'hidden', hints < 0);
      this.hintBtn.disabled = hints === 0;
      setText(this.hintCount, hints < 0 ? '' : String(hints));
      this.hintBtn.setAttribute('aria-label', hints < 0 ? 'Hint' : hints === 0 ? 'No hints left' : `Hint, ${hints} left`);
    }
    if (run.mode === 'rope') {
      const lives = run.lives ?? GAME.ropeLives;
      if (lives !== q.lives) {
        const lost = q.lives > lives && q.lives >= 0;
        q.lives = lives;
        const kids = this.livesEl.children;
        for (let i = 0; i < kids.length; i++) toggle(kids[i], 'lost', i >= lives);
        if (lost) this.bump(this.livesEl.parentElement!, 'bump-bad');
      }
      const h = Math.round((run.heightM ?? 0) * 10);
      if (h !== q.height) {
        q.height = h;
        const s = (h / 10).toFixed(1);
        setText(this.heightEl, s);
        setText(this.altVal, s);
      }
      const altQ = Math.round(((run.heightM ?? 0) / GAME.ropeWall.height) * 400);
      if (altQ !== q.alt) {
        q.alt = altQ;
        this.altMarker.style.setProperty('--h', String(Math.min(1, Math.max(0, altQ / 400))));
      }
      const next = run.nextClipIn;
      const none = next === null || next === undefined;
      const ready = !none && (run.clipReady ?? next <= CLIP_REACH_M);
      // numeric key: -2 none, -1 ready, else decimetres to the next draw
      const clipKey = none ? -2 : ready ? -1 : Math.max(0, Math.round(next * 10));
      if (clipKey !== q.clip) {
        q.clip = clipKey;
        toggle(this.clipEl, 'ready', clipKey === -1);
        toggle(this.clipEl, 'done', clipKey === -2);
        setText(this.clipTxt, clipKey === -2 ? 'ALL CLIPPED' : clipKey === -1 ? 'CLIP!' : `NEXT CLIP ${(clipKey / 10).toFixed(1)} M`);
      }
    }
  }

  private bump(e: HTMLElement, cls = 'bump'): void {
    e.classList.remove(cls);
    void e.offsetWidth; // restart the animation (only on score changes, not per frame)
    e.classList.add(cls);
  }

  /** Per-frame update. */
  frame(s: ClimberState, run: HudRunInfo): void {
    this.applyRun(run);
    const q = this.q;

    const tenths = Math.floor(Math.max(0, s.time) * 10);
    if (tenths !== q.tenths) {
      q.tenths = tenths;
      setText(this.timeEl, fmtClock(tenths / 10));
    }

    // FOREARMS (pump + chalk per hand)
    const pump = Math.min(1, Math.max(0, s.pump));
    this.frameArm(this.arms[0], s);
    this.frameArm(this.arms[1], s);

    // AIRBORNE: a deadpoint / dyno in flight
    const air = s.airborne && s.flight ? s.flight.kind : s.airborne ? 'dyno' : '';
    if (air !== q.air) {
      q.air = air;
      toggle(this.el, 'is-air', !!air);
      setText(this.tenLbl, air === 'deadpoint' ? 'DEADPOINT' : air ? 'DYNO' : 'TENSION');
      q.tenState = ''; // re-write the state word below
    }

    // TENSION
    const ten = Math.max(0, s.tension);
    const tq = Math.round(Math.min(1, ten / TENSION_FULL) * 200);
    if (tq !== q.ten) {
      q.ten = tq;
      this.tenArc.style.strokeDashoffset = String(100 - tq / 2);
    }
    const shaking = !air && (ten >= SIM.shakeOn || s.shake > 0.18);
    const tst = air ? 'air' : shaking ? 'crit' : ten >= 0.42 ? 'warn' : 'calm';
    if (tst !== q.tenState) {
      this.tenBox.classList.remove('st-calm', 'st-warn', 'st-crit', 'st-air');
      this.tenBox.classList.add(`st-${tst}`);
      toggle(this.el, 'is-shaking', shaking);
      q.tenState = tst;
      setText(this.tenState, air ? 'AIRBORNE' : shaking ? 'SHAKING' : tst === 'warn' ? 'WORKING' : 'STEADY');
    }
    const bq = Math.round(Math.max(-1, Math.min(1, s.balance)) * 40);
    if (bq !== q.bal) {
      q.bal = bq;
      this.balDot.style.transform = `translateX(${(bq / 40) * 15}px)`;
      toggle(this.balDot, 'off', Math.abs(bq) > 26);
    }

    // TOP progress
    const top = s.phase === 'climbing' || s.phase === 'topped' ? Math.round(Math.min(1, Math.max(0, s.topProgress)) * 100) : 0;
    if (top !== q.top) {
      q.top = top;
      toggle(this.topBox, 'on', top > 0);
      this.topFill.style.transform = `scaleX(${top / 100})`;
    }

    // SPECIAL STANCE: what the body is doing and the way out (Pure mode: hidden, the body says it)
    const sp = s.special === 'bat' ? 'bat' : s.special === 'figure4' ? 'fig4' : '';
    if (sp !== q.special) {
      q.special = sp;
      q.spf = -1;
      toggle(this.spBox, 'on', !!sp);
      toggle(this.spBox, 'sp-bat', sp === 'bat');
      toggle(this.spBox, 'sp-fig4', sp === 'fig4');
      if (sp) {
        const t = specialText(sp);
        setText(this.spWord, t.word);
        setText(this.spSub, t.sub);
      }
    }
    if (sp === 'bat') {
      const f = Math.round(Math.min(1, Math.max(0, s.bat?.fatigue ?? 0)) * 100);
      if (f !== q.spf) {
        q.spf = f;
        this.spFill.style.transform = `scaleX(${(1 - f / 100).toFixed(2)})`;
        toggle(this.spFill, 'low', f >= 70);
      }
    }

    // Edge vignette: tension past the shake line or pump near the limit.
    const danger = Math.max((ten - SIM.shakeOn) / 0.5, (pump - 0.8) / 0.2, 0);
    const vq = Math.round(Math.min(1, danger) * 20);
    if (vq !== q.vig) {
      q.vig = vq;
      this.vig.style.opacity = String(vq / 20);
    }
  }

  entered(): void {
    this.overview = false;
    this.eyeBtn.classList.remove('on');
  }

  /** The screen left: stop listening (a fresh HUD is built for the next climb). */
  destroy(): void {
    this.offSim();
  }
}

export function createHud(ctx: UICtx, props: P): HudView {
  return new HudView(ctx, props);
}

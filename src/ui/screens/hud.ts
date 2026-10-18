// In-climb HUD. `frame()` runs every frame: it only touches text that changed and drives
// meters with transforms / dash offsets (compositor-friendly, no layout reads, no innerHTML).

import type { ScreenProps } from '../../core/contracts';
import { bus } from '../../core/events';
import type { ClimberState, RunInfo } from '../../core/types';
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
 */
export type HudRunInfo = RunInfo & { clipReady?: boolean };

/** Fallback when the app does not pass `clipReady`: harness-relative distance at which a draw is reachable. */
export const CLIP_REACH_M = 1.0;
/** Tension at which the arc is full. */
const TENSION_FULL = 1.2;

const SVGNS = 'http://www.w3.org/2000/svg';

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
  private pumpBox: HTMLElement;
  private pumpFill = el('i', 'pump-fill');
  private pumpPct = el('span', 'pump-pct t-num', '0%');
  private tenBox: HTMLElement;
  private tenArc: SVGPathElement;
  private tenState = el('span', 'tg-state', 'STEADY');
  private balDot = el('i', 'bal-dot');
  private topBox: HTMLElement;
  private topFill = el('i', 'tp-fill');
  private vig = el('div', 'hud-vig');
  // buttons
  private hintBtn: HTMLButtonElement;
  private hintCount = el('span', 'hint-count t-num');
  private eyeBtn: HTMLButtonElement;
  private overview = false;

  // last-written caches (avoid redundant DOM writes)
  private q = {
    pump: -1,
    pumpState: '',
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

    // instruments
    this.pumpBox = el(
      'div',
      'inst inst-pump',
      el('div', 'inst-head', icon('forearm', 'inst-ic'), label('PUMP'), this.pumpPct),
      el('div', 'pump-bar', this.pumpFill, el('i', 'pump-seg')),
    );
    const g = arcGauge();
    this.tenArc = g.val;
    this.tenBox = el(
      'div',
      'inst inst-ten',
      label('TENSION', 'tg-lbl'),
      el('div', 'tg-wrap', g.svg, el('div', 'bal', el('i', 'bal-rail'), this.balDot)),
      el('div', 'tg-meta', this.tenState),
    );

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
      this.alt,
      el(
        'div',
        'hud-bottom',
        el('div', 'hb-btn', this.hintBtn, label('HINT')),
        el('div', 'hud-inst hud-glass', this.pumpBox, el('i', 'inst-sep'), this.tenBox),
        el('div', 'hb-btn', this.eyeBtn, label('LOOK')),
      ),
    );
    this.applyRun(props.run);
  }

  update(props: P): void {
    this.applyRun(props.run);
  }

  /** Static-ish run info (cheap to call every frame: guarded by caches). */
  private applyRun(run: HudRunInfo): void {
    const q = this.q;
    if (run.boulderName !== q.name) {
      q.name = run.boulderName;
      setText(this.nameEl, run.boulderName);
      // Long route names step down a size before they need an ellipsis.
      const n = run.boulderName.length;
      this.nameEl.style.setProperty('--hr-fs', n > 18 ? '14px' : n > 13 ? '16px' : '18px');
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

    // PUMP
    const pump = Math.min(1, Math.max(0, s.pump));
    const pq = Math.round(pump * 200);
    if (pq !== q.pump) {
      q.pump = pq;
      this.pumpFill.style.transform = `scaleX(${(pq / 200).toFixed(3)})`;
      const pctTxt = `${Math.round(pump * 100)}%`;
      setText(this.pumpPct, pctTxt);
      const st = pump >= 0.85 ? 'crit' : pump >= 0.6 ? 'warn' : 'calm';
      if (st !== q.pumpState) {
        this.pumpBox.classList.remove(`st-${q.pumpState}`);
        this.pumpBox.classList.add(`st-${st}`);
        q.pumpState = st;
      }
    }

    // TENSION
    const ten = Math.max(0, s.tension);
    const tq = Math.round(Math.min(1, ten / TENSION_FULL) * 200);
    if (tq !== q.ten) {
      q.ten = tq;
      this.tenArc.style.strokeDashoffset = String(100 - tq / 2);
    }
    const shaking = ten >= SIM.shakeOn || s.shake > 0.18;
    const tst = shaking ? 'crit' : ten >= 0.42 ? 'warn' : 'calm';
    if (tst !== q.tenState) {
      this.tenBox.classList.remove(`st-${q.tenState}`);
      this.tenBox.classList.add(`st-${tst}`);
      toggle(this.el, 'is-shaking', shaking);
      q.tenState = tst;
      setText(this.tenState, shaking ? 'SHAKING' : tst === 'warn' ? 'WORKING' : 'STEADY');
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
}

export function createHud(ctx: UICtx, props: P): HudView {
  return new HudView(ctx, props);
}

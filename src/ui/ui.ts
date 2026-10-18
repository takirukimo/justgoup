// GameUI — the DOM/CSS interface layer. Renders screens from props and emits player intents on
// the typed bus. It never contains game logic.

import './styles.css';

import type { GuideLine, ScreenId, ScreenProps, UIAPI } from '../core/contracts';
import { bus } from '../core/events';
import type { ClimberState, HeadId, Profile, RunInfo, Settings } from '../core/types';
import { BRAND, FONTS, PALETTE } from '../config/brand';
import { el } from './dom';
import { FxLayer } from './fx';
import { GuideBubble } from './guide-bubble';
import { Modal } from './modal';
import { Portraits } from './portraits';
import type { ScreenFactory, ScreenView, UICtx } from './screen';
import { backendKind } from './parts';
import { svgUrl, topoSvg } from './topo';
import { createCommunity } from './screens/community';
import { createHud, HudView, type HudRunInfo } from './screens/hud';
import { createLeaderboard } from './screens/leaderboard';
import { createLocker } from './screens/locker';
import { createModes } from './screens/modes';
import { createName } from './screens/name';
import { createPause } from './screens/pause';
import { createPreview } from './screens/preview';
import { createProfile } from './screens/profile';
import { createResults } from './screens/results';
import { createSettings } from './screens/settings';
import { createSplash } from './screens/splash';
import { createTitle } from './screens/title';

export type { HudRunInfo };

const DEFAULT_SETTINGS: Settings = { sfx: 0.8, music: 0.6, haptics: true, quality: 'auto', assist: true, reducedMotion: false };

const FACTORIES: { [K in ScreenId]: ScreenFactory<K> | null } = {
  splash: createSplash,
  title: createTitle,
  modes: createModes,
  name: createName,
  hud: createHud,
  preview: createPreview,
  pause: createPause,
  results: createResults,
  leaderboard: createLeaderboard,
  locker: createLocker,
  settings: createSettings,
  community: createCommunity,
  profile: createProfile,
  editor: null,
  none: null,
};

const LEAVE_MS = 240;

const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

/**
 * UI-only colour roles layered over PALETTE (src/config/brand.ts):
 *  signalInk  CHIRAL pink lifted for small text on near-black (6.4:1 on basalt, AA).
 *  signalHi/Lo  the pink button gradient; white labels stay ≥ 4.5:1 across the label band.
 *  bad / badInk  danger is a hot orange-red so stress and falls never read as brand pink.
 */
export const UI_COLOURS = {
  signalInk: '#EE6B79',
  signalHi: '#D9485A',
  signalLo: '#B83045',
  bad: '#FF5A26',
  badInk: '#FF8A66',
} as const;

/** '#rrggbb' → 'r, g, b' (for rgba(var(--c-x-rgb), a) tints); null for anything else. */
function hexRgb(hex: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export class GameUI implements UIAPI {
  /** Optional app hook for Settings → Reset progress (after the player confirms). */
  onResetProgress: (() => void) | null = null;

  private root: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private fx: FxLayer | null = null;
  private bubble: GuideBubble | null = null;
  private modal: Modal | null = null;
  private view: ScreenView<unknown> | null = null;
  private hudView: HudView | null = null;
  private cur: ScreenId = 'none';
  private readonly portraits = new Portraits();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private nameReturn: ScreenProps['profile'] | null = null;
  private motionQuery: MediaQueryList | null = null;
  private pressed: HTMLElement | null = null;
  /** Last backend label seen (title props or setBackendLabel); boards only receive isGlobal. */
  private backendName = '';
  private readonly ctx: UICtx;

  readonly hud: UIAPI['hud'] = {
    update: (state: ClimberState, run: RunInfo): void => {
      this.hudView?.frame(state, run as HudRunInfo);
    },
    callout: (text: string, style?: 'good' | 'bad' | 'neutral'): void => {
      this.fx?.callout(text, style);
    },
    toast: (text: string): void => {
      this.fx?.toast(text);
    },
  };

  readonly guide: UIAPI['guide'] & { setSkip(fn: (() => void) | null): void } = {
    say: (line: GuideLine): Promise<void> => (this.bubble ? this.bubble.say(line) : Promise.resolve()),
    hide: (): void => this.bubble?.hide(),
    setSkip: (fn: (() => void) | null): void => this.bubble?.setSkip(fn),
  };

  constructor() {
    const self = this;
    this.ctx = {
      portraits: this.portraits,
      get current() {
        return self.cur;
      },
      confirm: (t, b, ok, c) => this.confirm(t, b, ok, c),
      toast: (t) => this.hud.toast(t),
      show: (s, p) => this.show(s, p),
      setReducedMotion: (v) => this.applyReducedMotion(v),
      isReducedMotion: () => this.isReduced(),
      setQualityClass: (q) => this.applyQuality(q),
      resetProgress: () => {
        if (!this.onResetProgress) return false;
        this.onResetProgress();
        return true;
      },
      getSettings: () => this.settings,
      commitSettings: (s) => {
        this.settings = { ...s };
        bus.emit('ui:settings-changed', { settings: { ...s } });
      },
      get backendName() {
        return self.backendName;
      },
      backendLabel: (isGlobal) => {
        if (!isGlobal) return 'OFFLINE';
        return backendKind(this.backendName) === 'shared' ? 'CLAUDE SHARED' : 'GLOBAL';
      },
    };
  }

  get current(): ScreenId {
    return this.cur;
  }

  mount(root: HTMLElement): void {
    if (this.root) return;
    this.root = root;
    root.classList.add('jgu-ui');
    this.applyTokens(root);

    this.layer = el('div', 'screens');
    this.fx = new FxLayer();
    this.bubble = new GuideBubble(this.portraits, () => this.isReduced());
    this.modal = new Modal();
    root.append(this.layer, this.fx.el, this.bubble.el, this.modal.el);

    // Every button press → 'ui:tap' (sfx hook). Capture phase so it fires before handlers navigate.
    root.addEventListener(
      'click',
      (e) => {
        const b = (e.target as Element | null)?.closest('button');
        if (b && !b.disabled && root.contains(b)) bus.emit('ui:tap');
      },
      true,
    );
    // Tactile press state (reliable on iOS, where :active needs a touch listener).
    root.addEventListener(
      'pointerdown',
      (e) => {
        const b = (e.target as Element | null)?.closest<HTMLElement>('button');
        if (!b || (b as HTMLButtonElement).disabled) return;
        this.pressed?.classList.remove('is-pressed');
        this.pressed = b;
        b.classList.add('is-pressed');
      },
      { passive: true },
    );
    const release = (): void => {
      this.pressed?.classList.remove('is-pressed');
      this.pressed = null;
    };
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    root.addEventListener('touchstart', () => undefined, { passive: true });
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

    // Name editor opened from the profile returns to the profile when the app doesn't navigate.
    bus.on('ui:set-name', ({ name }) => {
      const back = this.nameReturn;
      if (!back) return;
      queueMicrotask(() => {
        if (this.cur === 'name' && this.nameReturn === back) this.show('profile', { profile: { ...back.profile, playerName: name } });
      });
    });
    bus.on('ui:back', () => {
      const back = this.nameReturn;
      if (!back) return;
      queueMicrotask(() => {
        if (this.cur === 'name' && this.nameReturn === back) this.show('profile', back);
      });
    });

    this.portraits.onChange(() => {
      if (this.root) this.portraits.refresh(this.root);
      this.bubble?.refresh();
    });
  }

  show<K extends ScreenId>(screen: K, props: ScreenProps[K]): void {
    this.absorbProps(props);
    if (!this.root || !this.layer) return;

    if (screen === this.cur && this.view && this.view.reuse !== false) {
      (this.view as ScreenView<ScreenProps[K]>).update(props);
      return;
    }

    if (screen === 'name' && this.cur === 'profile') {
      this.nameReturn = (this.lastProps as ScreenProps['profile'] | null) ?? null;
    } else if (screen !== 'name') {
      this.nameReturn = null;
    }

    // leave
    const old = this.view;
    if (old) {
      const oldEl = old.el;
      oldEl.classList.remove('scr-enter');
      oldEl.classList.add('scr-leave');
      oldEl.setAttribute('aria-hidden', 'true');
      window.setTimeout(() => {
        old.destroy?.();
        oldEl.remove();
      }, this.isReduced() ? 0 : LEAVE_MS);
    }
    this.view = null;
    this.hudView = null;
    this.cur = screen;
    this.root.dataset.screen = screen;
    this.lastProps = props;

    const factory = FACTORIES[screen] as ScreenFactory<K> | null;
    if (!factory) return;
    const view = factory(this.ctx, props) as ScreenView<ScreenProps[K]>;
    this.view = view as ScreenView<unknown>;
    if (view instanceof HudView) this.hudView = view;
    view.el.classList.add('scr-enter');
    this.layer.appendChild(view.el);
    requestAnimationFrame(() => {
      if (this.view === (view as ScreenView<unknown>)) view.entered?.();
    });
  }

  update<K extends ScreenId>(screen: K, props: ScreenProps[K]): void {
    this.absorbProps(props);
    if (screen !== this.cur || !this.view) return;
    this.lastProps = props;
    (this.view as ScreenView<ScreenProps[K]>).update(props);
  }

  confirm(title: string, body: string, ok?: string, cancel?: string): Promise<boolean> {
    if (!this.modal) return Promise.resolve(false);
    return this.modal.confirm(title, body, ok, cancel);
  }

  setPortraitProvider(fn: (head: HeadId) => string): void {
    this.portraits.setProvider(fn);
  }

  /** Optional: tell the UI which backend is live ('GLOBAL' / 'CLAUDE SHARED' / 'OFFLINE'); boards use it for their badge. */
  setBackendLabel(label: string): void {
    this.backendName = label;
  }

  /** Optional: tell the UI the current settings (used by pause quick toggles + motion/quality classes). */
  setSettings(s: Settings): void {
    this.settings = { ...s };
    this.applyReducedMotion(s.reducedMotion);
    this.applyQuality(s.quality);
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private lastProps: unknown = null;

  private absorbProps(props: unknown): void {
    const p = props as { profile?: Profile; backendLabel?: unknown } | null;
    if (!p || typeof p !== 'object') return;
    if (p.profile && p.profile.settings) this.setSettings(p.profile.settings);
    if (typeof p.backendLabel === 'string' && backendKind(p.backendLabel) !== 'pending') this.backendName = p.backendLabel;
  }

  private isReduced(): boolean {
    return !!this.root?.classList.contains('reduced-motion') || !!this.motionQuery?.matches;
  }

  private applyReducedMotion(v: boolean): void {
    this.root?.classList.toggle('reduced-motion', v);
  }

  private applyQuality(q: string): void {
    this.root?.classList.toggle('q-low', q === 'low');
  }

  private applyTokens(root: HTMLElement): void {
    const colours: Record<string, string> = { ...PALETTE, ...UI_COLOURS };
    for (const [k, v] of Object.entries(colours)) {
      root.style.setProperty(`--c-${kebab(k)}`, v);
      const rgb = hexRgb(v);
      if (rgb) root.style.setProperty(`--c-${kebab(k)}-rgb`, rgb);
    }
    // the CHIRAL mark as a CSS mask (tee prints on outfit swatches)
    root.style.setProperty('--mark-mask', svgUrl(BRAND.logoSvg.replace('fill="currentColor"', 'fill="#000"')));
    root.style.setProperty('--f-display', FONTS.display);
    root.style.setProperty('--f-ui', FONTS.ui);
    root.style.setProperty('--f-mono', FONTS.mono);
    const topo = topoSvg({ width: 780, height: 1700, seed: 4207, cell: 9, levels: 22, majorEvery: 5, scale: 340, stroke: PALETTE.bone, minorWidth: 0.9, majorWidth: 1.5, minorOpacity: 0.55, majorOpacity: 1 });
    root.style.setProperty('--topo', svgUrl(topo));
    const topoFine = topoSvg({ width: 420, height: 420, seed: 913, cell: 6, levels: 16, majorEvery: 4, scale: 150, stroke: PALETTE.bone, minorWidth: 0.8, majorWidth: 1.3, minorOpacity: 0.6, majorOpacity: 1 });
    root.style.setProperty('--topo-fine', svgUrl(topoFine));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !this.root) return;
    if (this.modal?.isOpen) {
      this.modal.close(false);
      return;
    }
    if (this.cur === 'hud') {
      bus.emit('ui:pause');
      return;
    }
    if (this.cur === 'pause') {
      bus.emit('ui:resume');
      return;
    }
    const back = this.view?.el.querySelector<HTMLButtonElement>('button[data-back]');
    back?.click();
  }
}

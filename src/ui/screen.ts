// Screen plumbing shared by GameUI and every screen module.

import type { ScreenId, ScreenProps } from '../core/contracts';
import type { Settings } from '../core/types';
import type { Portraits } from './portraits';

/** What a screen may ask of the UI shell (never game logic). */
export interface UICtx {
  readonly portraits: Portraits;
  readonly current: ScreenId;
  confirm(title: string, body: string, ok?: string, cancel?: string): Promise<boolean>;
  toast(text: string): void;
  /** Internal navigation (e.g. profile → name editor). */
  show<K extends ScreenId>(screen: K, props: ScreenProps[K]): void;
  /** Apply the reduced-motion preference immediately (settings toggle). */
  setReducedMotion(v: boolean): void;
  /** True when motion should be minimal (setting or OS preference). */
  isReducedMotion(): boolean;
  /** Apply the graphics quality to UI effects (backdrop blur off on low). */
  setQualityClass(q: string): void;
  /** Runs GameUI.onResetProgress (app hook). Returns false when no hook is installed. */
  resetProgress(): boolean;
  /** Last known settings (from any props that carry the profile, or GameUI.setSettings). */
  getSettings(): Settings;
  /** Remember + emit 'ui:settings-changed' with the full Settings. */
  commitSettings(s: Settings): void;
}

export interface ScreenView<P> {
  readonly el: HTMLElement;
  /** New props without a transition. */
  update(props: P): void;
  /** Called once the element is in the DOM and the enter animation started. */
  entered?(): void;
  /** Called after the leave animation, right before the element is removed. */
  destroy?(): void;
  /** show() of the same screen id updates in place instead of re-creating (default true). */
  readonly reuse?: boolean;
}

export type ScreenFactory<K extends ScreenId> = (ctx: UICtx, props: ScreenProps[K]) => ScreenView<ScreenProps[K]>;

import type { BoulderDef, ColorwayId, ChalkId, CommunityProblem, HeadId, LeaderboardMode, LimbId, Settings } from './types';
import type { SimEvent } from './contracts';

/**
 * Every cross-module message goes through this typed bus.
 * Naming: `ui:*` = player intent coming from DOM screens, `sim:*` = gameplay events,
 * `input:*` = limb-control gestures, `game:*` = session lifecycle (emitted by the app),
 * `editor:*` = boulder editor, `tutorial:*` = tutorial director.
 */
export interface AppEvents {
  // ── UI intents ──
  'ui:tap': void; // any UI button press (for click sfx)
  'ui:back': void;
  'ui:start-intro-done': void; // player tapped through splash / intro
  'ui:play': { mode: 'boulder' | 'rope' | 'daily' };
  'ui:tutorial': void;
  'ui:open': { screen: 'modes' | 'leaderboard' | 'locker' | 'settings' | 'community' | 'editor' | 'profile' | 'menu' };
  'ui:play-problem': { problem: CommunityProblem };
  'ui:begin-climb': void; // preview → climbing ("Tap to start")
  'ui:pause': void;
  'ui:resume': void;
  'ui:retry': void;
  'ui:next': void; // next boulder in the run after a send
  'ui:quit': void; // back to menu from a run
  'ui:hint': void;
  'ui:toggle-overview': void; // look at the whole route
  'ui:select-head': { head: HeadId };
  'ui:select-colorway': { colorway: ColorwayId };
  'ui:select-chalk': { chalk: ChalkId };
  'ui:settings-changed': { settings: Settings };
  'ui:set-name': { name: string };
  'ui:leaderboard-tab': { mode: LeaderboardMode };
  'ui:community-refresh': { sort: 'new' | 'popular' };

  // ── Input gestures (limb controls) ──
  'input:drag-start': { limb: LimbId };
  'input:drag-move': { limb: LimbId; candidateHoldId: string | null; quality: number };
  'input:drag-end': { limb: LimbId };
  'input:hip-start': void;
  'input:hip-end': void;
  'input:blocked': { limb: LimbId; reason: string }; // tutorial gating etc.

  // ── Sim events re-broadcast by the session each step ──
  'sim:event': SimEvent;

  // ── Session lifecycle (emitted by the app) ──
  'game:preview': { boulder: BoulderDef };
  'game:climb-start': { boulder: BoulderDef };
  'game:send': { boulder: BoulderDef; points: number; flash: boolean; time: number };
  'game:fall': { boulder: BoulderDef };
  'game:run-over': { mode: LeaderboardMode | 'community' | 'test'; score: number };
  'game:unlock': { kind: 'head' | 'colorway' | 'chalk'; id: string; name: string };

  // ── Editor ──
  'editor:test': { boulder: BoulderDef };
  'editor:publish': { boulder: BoulderDef };
  'editor:close': void;

  // ── Tutorial ──
  'tutorial:done': { skipped: boolean };
}

type Handler<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<Handler<any>>>();

  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  once<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  /** Resolve on the next event of this type (optionally matching a predicate). */
  wait<K extends keyof M>(type: K, pred?: (p: M[K]) => boolean): Promise<M[K]> {
    return new Promise((resolve) => {
      const off = this.on(type, (p) => {
        if (pred && !pred(p)) return;
        off();
        resolve(p);
      });
    });
  }

  emit<K extends keyof M>(type: K, ...payload: M[K] extends void ? [] : [M[K]]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload[0] as M[K]);
      } catch (err) {
        console.error(`[bus] handler for ${String(type)} threw`, err);
      }
    }
  }
}

/** The app-wide bus. */
export const bus = new EventBus<AppEvents>();

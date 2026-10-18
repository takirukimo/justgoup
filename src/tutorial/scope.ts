// Async plumbing for scripted sequences (intro + tutorial).
//
//  Clock  — a pausable frame clock (requestAnimationFrame; setTimeout headless). Game time only
//           advances while not paused, so a paused climb never advances the script.
//  Scope  — owns every listener, timer and pending await of a script section. abort() rejects all
//           pending awaits with `Aborted` (so a linear `await` script unwinds at once), and close()
//           / abort() remove every bus listener and timer: nothing dangles after a skip.

import { bus, type AppEvents } from '../core/events';

export type Tick = (dt: number) => void;

/** Thrown into every pending await of an aborted scope. */
export class Aborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'Aborted';
  }
}

export const isAborted = (e: unknown): e is Aborted => e instanceof Aborted;

type FrameFn = (cb: (now: number) => void) => number;
type CancelFn = (id: number) => void;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Frame clock. With `manual: true` nothing is scheduled and the owner calls tick(dt) (tests,
 * headless runs, or an app that wants the script on its own loop).
 */
export class Clock {
  paused = false;
  private readonly subs = new Set<Tick>();
  private running = false;
  private handle = 0;
  private last = 0;
  private readonly manual: boolean;
  private readonly frame: FrameFn;
  private readonly cancel: CancelFn;

  constructor(opts: { manual?: boolean } = {}) {
    this.manual = !!opts.manual;
    if (typeof requestAnimationFrame === 'function') {
      this.frame = (cb) => requestAnimationFrame(cb);
      this.cancel = (id) => cancelAnimationFrame(id);
    } else {
      this.frame = (cb) => setTimeout(() => cb(now()), 16) as unknown as number;
      this.cancel = (id) => clearTimeout(id);
    }
  }

  add(fn: Tick): () => void {
    this.subs.add(fn);
    if (!this.manual && !this.running) {
      this.running = true;
      this.last = now();
      this.handle = this.frame(this.loop);
    }
    return () => {
      this.subs.delete(fn);
    };
  }

  /** Advance game time by dt seconds (manual clocks; also safe to call on automatic ones). */
  tick(dt: number): void {
    if (this.paused || !(dt > 0)) return;
    for (const fn of this.subs) fn(dt);
  }

  stop(): void {
    this.subs.clear();
    if (this.running) this.cancel(this.handle);
    this.running = false;
  }

  private readonly loop = (t: number): void => {
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    this.tick(dt);
    if (this.subs.size) this.handle = this.frame(this.loop);
    else this.running = false;
  };
}

export class Scope {
  private closed = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly pending = new Set<(e: Aborted) => void>();
  private readonly children = new Set<Scope>();

  constructor(
    readonly clock: Clock,
    private readonly parent: Scope | null = null,
  ) {
    parent?.children.add(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** A sub-scope (e.g. one lesson): closed with its parent, or on its own when the section ends. */
  child(): Scope {
    const s = new Scope(this.clock, this);
    if (this.closed) s.close();
    return s;
  }

  /** Run `fn` when this scope ends (immediately if it already has). */
  defer(fn: () => void): void {
    if (this.closed) fn();
    else this.cleanups.push(fn);
  }

  /** Bus subscription that lives as long as this scope. */
  on<K extends keyof AppEvents>(type: K, fn: (payload: AppEvents[K]) => void): void {
    if (this.closed) return;
    this.defer(bus.on(type, fn));
  }

  /** Per-frame callback (game time) for the scope's lifetime. */
  every(fn: Tick): void {
    if (this.closed) return;
    this.defer(this.clock.add(fn));
  }

  /** One-shot game-time timer, cancelled with the scope. Returns a cancel function. */
  timer(sec: number, fn: () => void): () => void {
    if (this.closed) return () => undefined;
    let t = 0;
    let off: (() => void) | null = null;
    const cancel = (): void => {
      off?.();
      off = null;
    };
    off = this.clock.add((dt) => {
      t += dt;
      if (t < sec || !off) return;
      cancel();
      fn();
    });
    this.defer(cancel);
    return cancel;
  }

  /** Race any promise against this scope: rejects with Aborted when the scope ends first. */
  wait<T>(p: Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Aborted());
    return new Promise<T>((resolve, reject) => {
      const fail = (e: Aborted): void => reject(e);
      this.pending.add(fail);
      p.then(
        (v) => {
          if (!this.pending.delete(fail)) return;
          resolve(v);
        },
        (err: unknown) => {
          if (!this.pending.delete(fail)) return;
          reject(err);
        },
      );
    });
  }

  /** Game-time delay. */
  sleep(sec: number): Promise<void> {
    if (this.closed) return Promise.reject(new Aborted());
    if (!(sec > 0)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let t = 0;
      const fail = (e: Aborted): void => {
        off();
        reject(e);
      };
      const off = this.clock.add((dt) => {
        t += dt;
        if (t < sec) return;
        off();
        this.pending.delete(fail);
        resolve();
      });
      this.pending.add(fail);
    });
  }

  /**
   * Resolve true once `pred(dt)` returns true (checked every frame, game time), or false after
   * `timeout` seconds. Rejects with Aborted if the scope ends first.
   */
  until(pred: (dt: number) => boolean, timeout = Infinity): Promise<boolean> {
    if (this.closed) return Promise.reject(new Aborted());
    return new Promise<boolean>((resolve, reject) => {
      let t = 0;
      const fail = (e: Aborted): void => {
        off();
        reject(e);
      };
      const finish = (v: boolean): void => {
        off();
        this.pending.delete(fail);
        resolve(v);
      };
      const off = this.clock.add((dt) => {
        t += dt;
        let ok = false;
        try {
          ok = pred(dt);
        } catch (err) {
          console.error('[tutorial] condition failed', err);
          ok = true;
        }
        if (ok) finish(true);
        else if (t >= timeout) finish(false);
      });
      this.pending.add(fail);
    });
  }

  /** End the scope: reject pending awaits, close children, run cleanups (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Aborted();
    for (const fail of [...this.pending]) fail(err);
    this.pending.clear();
    for (const c of [...this.children]) c.close();
    this.children.clear();
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      try {
        this.cleanups[i]();
      } catch (e) {
        console.error('[tutorial] cleanup failed', e);
      }
    }
    this.cleanups.length = 0;
    this.parent?.children.delete(this);
  }
}

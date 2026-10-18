// Async problem generation. Prefers an inline Web Worker (bundled into the single-file build); when
// workers are unavailable (strict sandboxes) the same code runs on the main thread a frame later so
// the loading state paints first. A worker that goes silent is given up on after a generous
// watchdog, so a climb can never wait forever under the transition veil. Results are memoised per
// request key.

import type { BoulderDef } from '../core/types';
import type { GenerateOptions } from '../core/contracts';
import GenWorker from './gen.worker?worker&inline';
import { handleGen, type GenRequest, type GenResponse } from './gen-core';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Req = DistOmit<GenRequest, 'id'>;

interface Pending {
  req: GenRequest;
  resolve: (b: BoulderDef) => void;
  reject: (e: Error) => void;
  watchdog?: ReturnType<typeof setTimeout>;
}

/** Generation takes well under a second in the worker; this long means it is stuck or dead. */
const WORKER_WATCHDOG_MS = 20000;

const keyOf = (r: Req): string => (r.kind === 'daily' ? `daily:${r.dateKey}` : `${r.kind}:${JSON.stringify(r.opts)}`);

export class ProblemFactory {
  private worker: Worker | null = null;
  private failed = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, Promise<BoulderDef>>();

  boulder(opts: GenerateOptions): Promise<BoulderDef> {
    return this.request({ kind: 'boulder', opts });
  }

  rope(opts: GenerateOptions): Promise<BoulderDef> {
    return this.request({ kind: 'rope', opts });
  }

  daily(dateKey: string): Promise<BoulderDef> {
    return this.request({ kind: 'daily', dateKey });
  }

  /** True while requests go to the worker. */
  get threaded(): boolean {
    return !this.failed;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private request(r: Req): Promise<BoulderDef> {
    const key = keyOf(r);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = new Promise<BoulderDef>((resolve, reject) => {
      const req = { ...r, id: ++this.seq } as GenRequest;
      const job: Pending = { req, resolve, reject };
      const w = this.ensureWorker();
      if (!w) {
        this.inline(job);
        return;
      }
      this.pending.set(req.id, job);
      job.watchdog = setTimeout(() => {
        if (!this.pending.has(req.id)) return;
        console.warn('[gen] worker stopped answering; generating on the main thread');
        this.fail();
      }, WORKER_WATCHDOG_MS);
      try {
        w.postMessage(req);
      } catch {
        this.pending.delete(req.id);
        clearTimeout(job.watchdog);
        this.fail();
        this.inline(job);
      }
    });
    this.cache.set(key, p);
    // keep the cache small and never cache failures
    p.catch(() => this.cache.delete(key));
    if (this.cache.size > 12) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return p;
  }

  private settle(job: Pending, res: GenResponse): void {
    if (res.ok) job.resolve(res.boulder);
    else job.reject(new Error(res.message));
  }

  private ensureWorker(): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      const w = new GenWorker();
      w.onmessage = (e: MessageEvent<GenResponse>) => {
        const job = this.pending.get(e.data.id);
        if (!job) return;
        this.pending.delete(e.data.id);
        clearTimeout(job.watchdog);
        this.settle(job, e.data);
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        this.fail();
      };
      w.onmessageerror = () => this.fail();
      this.worker = w;
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  private fail(): void {
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const job of waiting) {
      clearTimeout(job.watchdog);
      this.inline(job);
    }
  }

  private inline(job: Pending): void {
    // two frames later: the transition is on screen before the main thread blocks
    setTimeout(() => {
      try {
        this.settle(job, handleGen(job.req));
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, 34);
  }
}

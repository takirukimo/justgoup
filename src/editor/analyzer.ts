// Analyzer: async front-end for analysis.ts. Prefers an inline Web Worker (bundled into the single
// HTML file); if workers are unavailable or blocked (strict sandboxes), it falls back to running the
// same code on the main thread in a later task so the UI can paint its "reading" state first.

import type { BetaMove } from '../core/contracts';
import type { BoulderDef, RouteStyle } from '../core/types';
import AnalysisWorker from './analysis.worker?worker&inline';
import { handleRequest, type AnalysisRequest, type AnalysisResponse } from './analysis';

export interface SolveResult {
  moves: BetaMove[] | null;
  grade: number | null;
  ms: number;
}

interface Pending {
  req: AnalysisRequest;
  resolve: (r: AnalysisResponse) => void;
}

/** Main-thread solves get a tighter budget: they block input while they run. */
const MAIN_THREAD_SOLVE_MS = 160;

export class Analyzer {
  private worker: Worker | null = null;
  private workerFailed = false;
  private seq = 0;
  private pending = new Map<number, Pending>();

  /** True while requests go to the worker (false once it failed and we run inline). */
  get threaded(): boolean {
    return !this.workerFailed;
  }

  solve(boulder: BoulderDef, maxMs: number): Promise<SolveResult> {
    return this.send({ kind: 'solve', id: ++this.seq, boulder, maxMs }).then((r) => {
      if (r.kind === 'solve') return { moves: r.moves, grade: r.grade, ms: r.ms };
      if (r.kind === 'error') throw new Error(r.message);
      throw new Error('unexpected analysis response');
    });
  }

  generate(seed: number, grade: number, style?: RouteStyle): Promise<BoulderDef> {
    return this.send({ kind: 'generate', id: ++this.seq, seed, grade, style }).then((r) => {
      if (r.kind === 'generate') return r.boulder;
      if (r.kind === 'error') throw new Error(r.message);
      throw new Error('unexpected analysis response');
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) this.runInline(p);
    this.pending.clear();
  }

  private send(req: AnalysisRequest): Promise<AnalysisResponse> {
    return new Promise<AnalysisResponse>((resolve) => {
      const p: Pending = { req, resolve };
      const w = this.ensureWorker();
      if (!w) {
        this.runInline(p);
        return;
      }
      this.pending.set(req.id, p);
      try {
        w.postMessage(req);
      } catch {
        this.pending.delete(req.id);
        this.failWorker();
        this.runInline(p);
      }
    });
  }

  private ensureWorker(): Worker | null {
    if (this.workerFailed) return null;
    if (this.worker) return this.worker;
    try {
      const w = new AnalysisWorker();
      w.onmessage = (e: MessageEvent<AnalysisResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p.resolve(e.data);
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        this.failWorker();
      };
      w.onmessageerror = () => this.failWorker();
      this.worker = w;
      return w;
    } catch {
      this.workerFailed = true;
      return null;
    }
  }

  private failWorker(): void {
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) this.runInline(p);
  }

  private runInline(p: Pending): void {
    const req: AnalysisRequest = p.req.kind === 'solve' ? { ...p.req, maxMs: Math.min(p.req.maxMs, MAIN_THREAD_SOLVE_MS) } : p.req;
    // two frames later: the "reading the line" state is on screen before we block
    setTimeout(() => p.resolve(handleRequest(req)), 34);
  }
}

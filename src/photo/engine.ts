// Async front-end for the detector. Prefers an inline Web Worker (bundled into the single-file build);
// where workers are blocked (strict sandboxes) the same core runs on the main thread a frame later, so
// the busy state paints first. A worker that stops answering is replaced by the main-thread core (the
// photo is re-sent; the caller re-runs its last step).

import PhotoWorker from './worker?worker&inline';
import { PhotoCore, type CoreRequest, type CoreResponse, type CoreResult } from './core';
import type { DetectResult, Lab, PhotoBlob, Quad, RGBAImage } from './types';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Req = DistOmit<CoreRequest, 'id'>;

const WATCHDOG_MS = 15000;

export class PhotoEngine {
  private worker: Worker | null = null;
  private failed = false;
  private inline: PhotoCore | null = null;
  private seq = 0;
  private pending = new Map<number, { req: Req; resolve: (r: CoreResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Kept to re-seed a fallback core. */
  private photo: RGBAImage | null = null;
  private quad: { quad: Quad; w: number; h: number } | null = null;

  /** True while work runs in the worker. */
  get threaded(): boolean {
    return !this.failed && this.worker !== null;
  }

  async setPhoto(img: RGBAImage): Promise<void> {
    this.photo = img;
    this.quad = null;
    // the worker gets a copy (ours re-seeds a fallback core)
    await this.send({ kind: 'photo', width: img.width, height: img.height, data: img.data.slice() }, true);
  }

  async rectify(quad: Quad, w: number, h: number): Promise<{ image: RGBAImage; wall: Lab }> {
    this.quad = { quad, w, h };
    const r = await this.send({ kind: 'rectify', quad, w, h });
    if (r.kind !== 'rectify') throw new Error('unexpected reply');
    return { image: { width: r.width, height: r.height, data: r.data }, wall: r.wall };
  }

  async sample(x: number, y: number, r = 3): Promise<Lab | null> {
    const res = await this.send({ kind: 'sample', x, y, r });
    if (res.kind !== 'sample') throw new Error('unexpected reply');
    return res.lab;
  }

  async detect(samples: Lab[], negatives: Lab[], sensitivity: number, ppm: number): Promise<DetectResult> {
    const res = await this.send({ kind: 'detect', samples, negatives, sensitivity, ppm });
    if (res.kind !== 'detect') throw new Error('unexpected reply');
    return res.result;
  }

  async region(x: number, y: number, samples: Lab[], negatives: Lab[], sensitivity: number, ppm: number): Promise<PhotoBlob | null> {
    const res = await this.send({ kind: 'region', x, y, samples, negatives, sensitivity, ppm });
    if (res.kind !== 'region') throw new Error('unexpected reply');
    return res.blob;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('disposed'));
    }
    this.pending.clear();
    this.inline = null;
    this.photo = null;
  }

  private send(r: Req, transferData = false): Promise<CoreResult> {
    const w = this.ensureWorker();
    if (!w) return this.runInline(r);
    return new Promise<CoreResult>((resolve, reject) => {
      const id = ++this.seq;
      const req = { ...r, id } as CoreRequest;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        console.warn('[photo] worker stopped answering; running on the main thread');
        this.fail();
        this.runInline(r).then(resolve, reject);
      }, WATCHDOG_MS);
      this.pending.set(id, { req: r, resolve, reject, timer });
      try {
        const transfer = transferData && req.kind === 'photo' ? [req.data.buffer as ArrayBuffer] : [];
        w.postMessage(req, transfer);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        this.fail();
        this.runInline(r).then(resolve, reject);
      }
    });
  }

  private ensureWorker(): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      const w = new PhotoWorker();
      w.onmessage = (e: MessageEvent<CoreResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        clearTimeout(p.timer);
        if (e.data.ok) p.resolve(e.data);
        else p.reject(new Error(e.data.message));
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        this.failOver();
      };
      this.worker = w;
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /** The worker died mid-request: replay the pending requests on the main thread. */
  private failOver(): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.fail();
    for (const p of waiting) {
      clearTimeout(p.timer);
      this.runInline(p.req).then(p.resolve, p.reject);
    }
  }

  private fail(): void {
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
  }

  /** Main-thread core, re-seeded with the photo (and the last rectification) the worker had. */
  private runInline(r: Req): Promise<CoreResult> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          if (!this.inline) {
            this.inline = new PhotoCore();
            if (this.photo && r.kind !== 'photo') this.inline.handle({ id: 0, kind: 'photo', width: this.photo.width, height: this.photo.height, data: this.photo.data });
            if (this.quad && r.kind !== 'photo' && r.kind !== 'rectify') this.inline.handle({ id: 0, kind: 'rectify', ...this.quad });
          }
          const req = { ...r, id: 0 } as CoreRequest;
          if (req.kind === 'photo') req.data = this.photo?.data ?? req.data;
          const { res } = this.inline.handle(req);
          if (res.ok) resolve(res);
          else reject(new Error(res.message));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, 34);
    });
  }
}

// The detector's state machine, shared by the Web Worker and the main-thread fallback: it keeps the
// photo, the straightened wall image, its Lab planes and the last colour-distance map, so a sensitivity
// change only re-runs the cheap mask stages.

import { grayWorldGains, samplePatch, toLab, type LabImage } from './color';
import { detectBlobs, distanceMap, excludeSet, regionAt, wallColor } from './cv';
import { warpQuad } from './geometry';
import type { DetectResult, Lab, PhotoBlob, Quad, RGBAImage } from './types';

export type CoreRequest =
  | { id: number; kind: 'photo'; width: number; height: number; data: Uint8ClampedArray }
  | { id: number; kind: 'rectify'; quad: Quad; w: number; h: number }
  | { id: number; kind: 'sample'; x: number; y: number; r: number }
  | { id: number; kind: 'detect'; samples: Lab[]; negatives: Lab[]; sensitivity: number; ppm: number }
  | { id: number; kind: 'region'; x: number; y: number; samples: Lab[]; negatives: Lab[]; sensitivity: number; ppm: number };

export type CoreResult =
  | { kind: 'photo' }
  | { kind: 'rectify'; width: number; height: number; data: Uint8ClampedArray; wall: Lab }
  | { kind: 'sample'; lab: Lab | null }
  | { kind: 'detect'; result: DetectResult }
  | { kind: 'region'; blob: PhotoBlob | null };

export type CoreResponse = ({ id: number; ok: true } & CoreResult) | { id: number; ok: false; message: string };

export class PhotoCore {
  private photo: RGBAImage | null = null;
  private rect: RGBAImage | null = null;
  private lab: LabImage | null = null;
  private wall: Lab | null = null;
  private distKey = '';
  private dist: Float32Array | null = null;

  /** Handle one request; returns the response and the buffers to transfer. */
  handle(req: CoreRequest): { res: CoreResponse; transfer: ArrayBuffer[] } {
    try {
      const r = this.run(req);
      const transfer: ArrayBuffer[] = [];
      if (r.kind === 'rectify') transfer.push(r.data.buffer as ArrayBuffer);
      if (r.kind === 'detect') transfer.push(r.result.mask.buffer as ArrayBuffer);
      return { res: { id: req.id, ok: true, ...r } as CoreResponse, transfer };
    } catch (e) {
      return { res: { id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) }, transfer: [] };
    }
  }

  private run(req: CoreRequest): CoreResult {
    switch (req.kind) {
      case 'photo':
        this.photo = { width: req.width, height: req.height, data: req.data };
        this.rect = null;
        this.lab = null;
        this.dist = null;
        this.distKey = '';
        return { kind: 'photo' };
      case 'rectify': {
        if (!this.photo) throw new Error('no photo');
        const rect = warpQuad(this.photo, req.quad, req.w, req.h);
        this.rect = rect;
        this.lab = toLab(rect, grayWorldGains(rect));
        this.wall = wallColor(this.lab);
        this.dist = null;
        this.distKey = '';
        // the caller gets its own copy (ours stays for sampling and detection)
        return { kind: 'rectify', width: rect.width, height: rect.height, data: rect.data.slice(), wall: this.wall };
      }
      case 'sample':
        if (!this.lab) throw new Error('not rectified');
        return { kind: 'sample', lab: samplePatch(this.lab, req.x, req.y, req.r) };
      case 'detect':
        return { kind: 'detect', result: detectBlobs(this.needLab(), this.distFor(req.samples, req.negatives), { sensitivity: req.sensitivity, ppm: req.ppm }) };
      case 'region':
        return { kind: 'region', blob: regionAt(this.needLab(), this.distFor(req.samples, req.negatives), req.x, req.y, { sensitivity: req.sensitivity, ppm: req.ppm }) };
    }
  }

  private needLab(): LabImage {
    if (!this.lab) throw new Error('not rectified');
    return this.lab;
  }

  private distFor(samples: Lab[], negatives: Lab[]): Float32Array {
    const lab = this.needLab();
    const key = JSON.stringify([samples, negatives]);
    if (!this.dist || key !== this.distKey) {
      this.dist = distanceMap(lab, samples, excludeSet(this.wall, samples, negatives));
      this.distKey = key;
    }
    return this.dist;
  }
}

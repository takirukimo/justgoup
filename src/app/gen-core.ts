// Problem generation requests shared by the generation worker and its main-thread fallback.

import type { BoulderDef } from '../core/types';
import type { GenerateOptions } from '../core/contracts';
import { dailyBoulder, generateBoulder, generateRopeRoute } from '../game/generator';

export type GenRequest =
  | { id: number; kind: 'boulder'; opts: GenerateOptions }
  | { id: number; kind: 'rope'; opts: GenerateOptions }
  | { id: number; kind: 'daily'; dateKey: string };

export type GenResponse = { id: number; ok: true; boulder: BoulderDef } | { id: number; ok: false; message: string };

export function handleGen(req: GenRequest): GenResponse {
  try {
    const boulder =
      req.kind === 'boulder' ? generateBoulder(req.opts) : req.kind === 'rope' ? generateRopeRoute(req.opts) : dailyBoulder(req.dateKey);
    return { id: req.id, ok: true, boulder };
  } catch (err) {
    return { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Heavy editor computations (beta search, grade estimate, sample generation) behind one message
// protocol. They run in a Web Worker when the platform allows it and on the main thread otherwise.

import type { BetaMove } from '../core/contracts';
import type { BoulderDef } from '../core/types';
import { estimateGrade, planBeta } from '../game/solver';
import { generateBoulder } from '../game/generator';
import { draftFromSample } from './model';

export type AnalysisRequest =
  | { kind: 'solve'; id: number; boulder: BoulderDef; maxMs: number }
  | { kind: 'generate'; id: number; seed: number; grade: number };

export type AnalysisResponse =
  | { kind: 'solve'; id: number; moves: BetaMove[] | null; grade: number | null; ms: number }
  | { kind: 'generate'; id: number; boulder: BoulderDef; ms: number }
  | { kind: 'error'; id: number; message: string };

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Beta (small wall-clock budget) and, when one exists, the estimated V-grade. */
export function solveDraft(boulder: BoulderDef, maxMs: number): { moves: BetaMove[] | null; grade: number | null; ms: number } {
  const t0 = now();
  const moves = planBeta(boulder, { maxMs });
  const grade = moves ? estimateGrade(boulder) : null;
  return { moves, grade, ms: now() - t0 };
}

/** A generated problem at `grade`, stripped to a remixable draft. */
export function generateSample(seed: number, grade: number): { boulder: BoulderDef; ms: number } {
  const t0 = now();
  const b = generateBoulder({ seed, grade, mode: 'boulder' });
  return { boulder: draftFromSample(b), ms: now() - t0 };
}

export function handleRequest(req: AnalysisRequest): AnalysisResponse {
  try {
    if (req.kind === 'solve') {
      const r = solveDraft(req.boulder, req.maxMs);
      return { kind: 'solve', id: req.id, moves: r.moves, grade: r.grade, ms: r.ms };
    }
    const g = generateSample(req.seed, req.grade);
    return { kind: 'generate', id: req.id, boulder: g.boulder, ms: g.ms };
  } catch (err) {
    return { kind: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) };
  }
}

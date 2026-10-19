// Heavy editor computations (beta search, grade estimate, sample generation) behind one message
// protocol. They run in a Web Worker when the platform allows it and on the main thread otherwise.

import type { BetaMove } from '../core/contracts';
import type { BoulderDef, RouteStyle } from '../core/types';
import { estimateGrade, planBeta } from '../game/solver';
import { generateBoulder } from '../game/generator';
import { draftFromSample, validateDraft } from './model';

export type AnalysisRequest =
  | { kind: 'solve'; id: number; boulder: BoulderDef; maxMs: number }
  | { kind: 'generate'; id: number; seed: number; grade: number; style?: RouteStyle };

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

/**
 * A generated problem at `grade`, stripped to a remixable draft. It keeps the generator's wall
 * profile (GEN.profiles) and hold variety. With a `style` (the setter picked a kind of bouldering:
 * slab, cave, dyno, compression…) the generator sets that archetype, holds bolted onto volumes
 * included; without one it is the classic sample (the generator's own pick, holds on the wall).
 */
export function generateSample(seed: number, grade: number, style?: RouteStyle): { boulder: BoulderDef; ms: number } {
  const t0 = now();
  // the editor's rules are stricter than the generator's (hold spacing, one TOP, inside the panel):
  // take the first of a few seeds whose draft passes them, so a sample is always publishable
  let draft: BoulderDef | null = null;
  for (let i = 0; i < SAMPLE_TRIES; i++) {
    const s = i === 0 ? seed : (Math.imul(seed ^ 0x5bd1e995, i + 1) >>> 1) || 1;
    draft = draftFromSample(generateBoulder({ seed: s, grade, mode: 'boulder', style, holdsOnVolumes: !!style }));
    if (validateDraft(draft).ok) break;
  }
  return { boulder: draft!, ms: now() - t0 };
}

const SAMPLE_TRIES = 8;

export function handleRequest(req: AnalysisRequest): AnalysisResponse {
  try {
    if (req.kind === 'solve') {
      const r = solveDraft(req.boulder, req.maxMs);
      return { kind: 'solve', id: req.id, moves: r.moves, grade: r.grade, ms: r.ms };
    }
    const g = generateSample(req.seed, req.grade, req.style);
    return { kind: 'generate', id: req.id, boulder: g.boulder, ms: g.ms };
  } catch (err) {
    return { kind: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) };
  }
}

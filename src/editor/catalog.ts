// The setter's catalogue (Phase C): every hold product and volume the palette offers, their size
// ranges, footprints and the per-hold details (edge depth, lip angle, fingers, finish) the inspector
// edits. Pure data + helpers (no DOM, no three.js): shared by the model, the panel and the worker.
//
// Shapes map onto what the renderer builds (render/holds.ts): a hold is `type` + optional `shape`;
// a volume's geometry is picked by its seed (seed % 6: pyramid, trapezoid, wedge, tri pyramid,
// half-dome, ridge) and its finish by `shape` ('macro' = dual-tex zones, 'wood'; 'dual-tex' turns any
// seed into a dual-tex pyramid of its own).

import type { HoldDef, HoldShape, HoldType } from '../core/types';
import { SIM } from '../config/tuning';

export type PaletteTab = 'holds' | 'volumes';

export interface CatalogEntry {
  id: string;
  tab: PaletteTab;
  /** Tile label (short, uppercase). */
  label: string;
  /** Full name (inspector, aria). */
  name: string;
  type: HoldType;
  shape?: HoldShape;
  fingers?: 1 | 2 | 3 | 4;
  /** Volumes: geometry variant (seed % VOLUME_VARIANTS). Holds: the variant their thumbnail shows. */
  variant: number;
  /** Small finish badge on the tile ('DT' dual-tex, 'WOOD'). */
  badge?: string;
}

/** Geometry variants per hold type in the renderer (render/holds.ts HOLD_VARIANTS). */
export const VARIANTS = 6;

export const CATALOG: readonly CatalogEntry[] = [
  // ── holds ──
  { id: 'jug', tab: 'holds', label: 'JUG', name: 'Jug', type: 'jug', variant: 1 },
  { id: 'bucket', tab: 'holds', label: 'BUCKET', name: 'Bucket', type: 'jug', shape: 'bucket', variant: 2 },
  { id: 'horn', tab: 'holds', label: 'HORN', name: 'Horn', type: 'pinch', shape: 'horn', variant: 0 },
  { id: 'edge', tab: 'holds', label: 'EDGE', name: 'Edge', type: 'edge', variant: 1 },
  { id: 'rail', tab: 'holds', label: 'RAIL', name: 'Rail', type: 'edge', shape: 'rail', variant: 1 },
  { id: 'crimp', tab: 'holds', label: 'CRIMP', name: 'Crimp', type: 'crimp', variant: 2 },
  { id: 'micro', tab: 'holds', label: 'MICRO', name: 'Micro', type: 'crimp', shape: 'micro', variant: 2 },
  { id: 'sloper', tab: 'holds', label: 'SLOPER', name: 'Sloper', type: 'sloper', variant: 1 },
  { id: 'pinch', tab: 'holds', label: 'PINCH', name: 'Pinch', type: 'pinch', variant: 0 },
  { id: 'pocket', tab: 'holds', label: 'POCKET', name: 'Pocket', type: 'pocket', fingers: 3, variant: 1 },
  { id: 'mono', tab: 'holds', label: 'MONO', name: 'Mono pocket', type: 'pocket', fingers: 1, variant: 1 },
  { id: 'foot', tab: 'holds', label: 'FOOT', name: 'Foot hold', type: 'foot', variant: 1 },
  { id: 'chip', tab: 'holds', label: 'CHIP', name: 'Foot chip', type: 'foot', shape: 'chip', variant: 1 },
  { id: 'dualtex', tab: 'holds', label: 'DUAL-TEX', name: 'Dual-tex sloper', type: 'sloper', shape: 'dual-tex', variant: 4, badge: 'DT' },
  { id: 'wood', tab: 'holds', label: 'WOOD', name: 'Wood edge', type: 'edge', shape: 'wood', variant: 3, badge: 'WOOD' },
  // ── volumes ──
  { id: 'v-pyramid', tab: 'volumes', label: 'PYRAMID', name: 'Pyramid', type: 'volume', variant: 0 },
  { id: 'v-tri', tab: 'volumes', label: 'TETRA', name: 'Tri pyramid', type: 'volume', variant: 3 },
  { id: 'v-trapezoid', tab: 'volumes', label: 'TRAPEZOID', name: 'Trapezoid', type: 'volume', variant: 1 },
  { id: 'v-wedge', tab: 'volumes', label: 'WEDGE', name: 'Wedge', type: 'volume', variant: 2 },
  { id: 'v-dome', tab: 'volumes', label: 'DOME', name: 'Half-dome', type: 'volume', variant: 4 },
  { id: 'v-ridge', tab: 'volumes', label: 'RIDGE', name: 'Ridge', type: 'volume', variant: 5 },
  { id: 'v-pyramid-dt', tab: 'volumes', label: 'PYRAMID', name: 'Dual-tex pyramid', type: 'volume', shape: 'dual-tex', variant: 4, badge: 'DT' },
  { id: 'v-fin-dt', tab: 'volumes', label: 'FIN', name: 'Dual-tex fin', type: 'volume', shape: 'dual-tex', variant: 5, badge: 'DT' },
  { id: 'v-wedge-dt', tab: 'volumes', label: 'WEDGE', name: 'Dual-tex wedge', type: 'volume', shape: 'macro', variant: 2, badge: 'DT' },
  { id: 'v-dome-dt', tab: 'volumes', label: 'DOME', name: 'Dual-tex dome', type: 'volume', shape: 'macro', variant: 4, badge: 'DT' },
  { id: 'v-wedge-wood', tab: 'volumes', label: 'WEDGE', name: 'Wood wedge', type: 'volume', shape: 'wood', variant: 2, badge: 'WOOD' },
  { id: 'v-box-wood', tab: 'volumes', label: 'BOX', name: 'Wood box', type: 'volume', shape: 'wood', variant: 1, badge: 'WOOD' },
  { id: 'macro', tab: 'volumes', label: 'MACRO', name: 'Macro', type: 'sloper', shape: 'macro', variant: 1 },
];

export const entryById = (id: string): CatalogEntry | null => CATALOG.find((e) => e.id === id) ?? null;
export const tabEntries = (t: PaletteTab): CatalogEntry[] => CATALOG.filter((e) => e.tab === t);

/** Volume geometry variant of a seed (render/holds.ts: Math.abs(seed) % HOLD_VARIANTS). */
export const variantOf = (seed: number): number => Math.abs(Math.floor(seed)) % VARIANTS;

/** A fresh random seed whose geometry variant is `variant`. */
export function seedForVariant(variant: number, rnd: () => number = Math.random): number {
  const v = ((Math.floor(variant) % VARIANTS) + VARIANTS) % VARIANTS;
  const s = 1 + Math.floor(rnd() * 0x7ffffff0);
  return s - (s % VARIANTS) + v || VARIANTS + v;
}

/** The catalogue entry a hold is (its exact product, else its base type's tile). */
export function entryOf(h: Pick<HoldDef, 'type' | 'shape' | 'fingers' | 'seed'>): CatalogEntry {
  if (h.type === 'volume') {
    const v = variantOf(h.seed);
    const dt = h.shape === 'dual-tex';
    const exact = CATALOG.find((e) => e.type === 'volume' && e.variant === v && (e.shape ?? null) === (h.shape ?? null));
    if (exact) return exact;
    const kind = CATALOG.find((e) => e.type === 'volume' && !e.shape && e.variant === (dt ? 3 : v));
    return kind ?? CATALOG.find((e) => e.id === 'v-pyramid')!;
  }
  if (h.type === 'pocket') return CATALOG.find((e) => e.id === (h.fingers === 1 ? 'mono' : 'pocket'))!;
  const exact = CATALOG.find((e) => e.type === h.type && e.shape !== undefined && e.shape === h.shape);
  return exact ?? CATALOG.find((e) => e.type === h.type && !e.shape && e.tab === 'holds')!;
}

/** Is this a volume (or a macro: the big features live in the VOLUMES tab)? */
export const isVolumeEntry = (e: CatalogEntry): boolean => e.tab === 'volumes';

// ───────────────────────────── sizes ─────────────────────────────

export interface SizeRange {
  min: number;
  max: number;
  def: number;
}

/** Size slider range per type (characteristic radius, m). Mirrors the generator's sizes, a little wider. */
export const SIZE_RANGE: Readonly<Record<HoldType, SizeRange>> = {
  jug: { min: 0.07, max: 0.13, def: 0.1 },
  edge: { min: 0.045, max: 0.09, def: 0.065 },
  crimp: { min: 0.025, max: 0.05, def: 0.038 },
  sloper: { min: 0.07, max: 0.13, def: 0.1 },
  pinch: { min: 0.045, max: 0.09, def: 0.065 },
  pocket: { min: 0.035, max: 0.07, def: 0.05 },
  foot: { min: 0.018, max: 0.04, def: 0.028 },
  volume: { min: 0.18, max: 0.55, def: 0.32 },
};

/** Shapes whose product is a different size from their type's. */
const SHAPE_SIZE: Partial<Record<HoldShape, Partial<Record<HoldType, SizeRange>>>> = {
  bucket: { jug: { min: 0.09, max: 0.14, def: 0.11 } },
  horn: { pinch: { min: 0.05, max: 0.09, def: 0.07 } },
  rail: { edge: { min: 0.05, max: 0.085, def: 0.062 } },
  micro: { crimp: { min: 0.022, max: 0.045, def: 0.032 } },
  chip: { foot: { min: 0.016, max: 0.034, def: 0.024 } },
  macro: { sloper: { min: 0.11, max: 0.2, def: 0.14 } },
};

export function sizeRange(h: Pick<HoldDef, 'type' | 'shape'>): SizeRange {
  return (h.shape && SHAPE_SIZE[h.shape]?.[h.type]) || SIZE_RANGE[h.type];
}

/** Size ring (research §3.3, Trango scale) for a hold's longest dimension. */
export function sizeRing(h: Pick<HoldDef, 'type' | 'shape' | 'size' | 'seed'>): string {
  const e = extentOf(h);
  const mm = 2 * Math.max(e.hx, e.hy) * h.size * 1000;
  if (mm < 50) return 'XXS';
  if (mm < 80) return 'XS';
  if (mm < 130) return 'S';
  if (mm < 210) return 'M';
  if (mm < 340) return 'L';
  if (mm < 890) return 'XL';
  return 'XXXL';
}

// ───────────────────────────── footprints ─────────────────────────────

/**
 * Half extents (× size) of each product's real geometry in its own frame (x along the grip side, y
 * toward it), measured from render/holds.ts holdGeometry (max over its variants).
 */
const EXTENT: Readonly<Record<string, { hx: number; hy: number }>> = {
  jug: { hx: 1.2, hy: 0.97 },
  bucket: { hx: 1.0, hy: 0.9 },
  edge: { hx: 1.95, hy: 0.57 },
  rail: { hx: 3.85, hy: 0.46 },
  crimp: { hx: 2.15, hy: 0.45 },
  micro: { hx: 1.35, hy: 0.37 },
  sloper: { hx: 1.08, hy: 0.98 },
  macro: { hx: 1.62, hy: 0.98 },
  pinch: { hx: 0.65, hy: 1.47 },
  horn: { hx: 0.48, hy: 0.66 },
  pocket: { hx: 1.12, hy: 0.9 },
  foot: { hx: 1.32, hy: 0.8 },
  chip: { hx: 1.17, hy: 0.77 },
};
/** Volumes by geometry variant (plain / macro / wood), and as dual-tex pyramids. */
const VOLUME_EXTENT: readonly { hx: number; hy: number }[] = [
  { hx: 0.82, hy: 0.88 },
  { hx: 0.9, hy: 0.87 },
  { hx: 0.93, hy: 0.6 },
  { hx: 0.91, hy: 0.97 },
  { hx: 1.08, hy: 0.98 },
  { hx: 1.16, hy: 0.49 },
];
const VOLUME_DT_EXTENT: readonly { hx: number; hy: number }[] = [
  { hx: 0.82, hy: 0.88 },
  { hx: 0.9, hy: 0.87 },
  { hx: 0.97, hy: 0.85 },
  { hx: 0.91, hy: 0.97 },
  { hx: 1.07, hy: 0.81 },
  { hx: 0.95, hy: 0.93 },
];

/** Half extents (× size) of a hold's product. */
export function extentOf(h: Pick<HoldDef, 'type' | 'shape' | 'seed'> & { fingers?: HoldDef['fingers'] }): { hx: number; hy: number } {
  if (h.type === 'volume') return (h.shape === 'dual-tex' ? VOLUME_DT_EXTENT : VOLUME_EXTENT)[variantOf(h.seed ?? 0)];
  const s = h.shape;
  const e = (s && s !== 'dual-tex' && s !== 'wood' && EXTENT[s]) || EXTENT[h.type];
  if (h.type === 'pocket' && h.fingers === 4) return { hx: e.hx * 1.15, hy: e.hy };
  return e;
}

// ───────────────────────────── details ─────────────────────────────

export interface DetailRange {
  min: number;
  max: number;
  step: number;
}

/** Edge depth (mm) range the inspector offers per product (research §3.3), or null when it has none. */
export function depthRange(h: Pick<HoldDef, 'type' | 'shape'>): DetailRange | null {
  if (h.type === 'edge') return h.shape === 'rail' ? { min: 15, max: 30, step: 1 } : { min: 12, max: 45, step: 1 };
  if (h.type === 'crimp') return h.shape === 'micro' ? { min: 4, max: 10, step: 1 } : { min: 6, max: 22, step: 1 };
  if (h.type === 'pocket') return { min: 12, max: 35, step: 1 };
  return null;
}

/** Lip angle (°) range: incut edges / crimps, and the slope of a sloper. Null when it has none. */
export function lipRange(h: Pick<HoldDef, 'type' | 'shape'>): DetailRange | null {
  if (h.type === 'edge' || h.type === 'crimp') return { min: -15, max: 30, step: 1 };
  if (h.type === 'sloper') return { min: -45, max: -12, step: 1 };
  return null;
}

/** The edge depth the sim uses when a hold has none (SIM.edgeDepthBySize, as the generator derives it). */
export function derivedDepth(h: Pick<HoldDef, 'type' | 'size'>): number | null {
  const t = h.type === 'edge' || h.type === 'crimp' || h.type === 'pocket' ? h.type : null;
  if (!t) return null;
  const [s0, s1, m0, m1] = SIM.edgeDepthBySize[t];
  const k = Math.max(0, Math.min(1, (h.size - s0) / (s1 - s0)));
  return m0 + (m1 - m0) * k;
}

/** The lip angle the sim uses when a hold has none (slopers −35°, the rest flat). */
export const derivedLip = (h: Pick<HoldDef, 'type'>): number => (h.type === 'sloper' ? -35 : 0);

export type Finish = 'plain' | 'dual' | 'wood';

/**
 * Finishes a hold can take: plain products and their dual-tex / wood versions. Structural shapes
 * (bucket, rail, horn, micro, chip, macro, dual-tex pyramids) keep their own finish.
 */
export function finishesOf(h: Pick<HoldDef, 'type' | 'shape'>): Finish[] | null {
  if (h.type === 'foot') return null;
  if (h.shape && h.shape !== 'dual-tex' && h.shape !== 'wood' && !(h.type === 'volume' && h.shape === 'macro')) return null;
  if (h.type === 'volume' && h.shape === 'dual-tex') return null;
  return ['plain', 'dual', 'wood'];
}

export function finishOf(h: Pick<HoldDef, 'type' | 'shape'>): Finish {
  if (h.shape === 'wood') return 'wood';
  if (h.shape === 'dual-tex' || (h.type === 'volume' && h.shape === 'macro')) return 'dual';
  return 'plain';
}

/** The shape a finish gives a hold (volumes keep their geometry: their dual-tex finish is 'macro'). */
export function shapeForFinish(h: Pick<HoldDef, 'type'>, f: Finish): HoldShape | undefined {
  if (f === 'wood') return 'wood';
  if (f === 'dual') return h.type === 'volume' ? 'macro' : 'dual-tex';
  return undefined;
}

export const FINISH_LABEL: Readonly<Record<Finish, string>> = { plain: 'PLAIN', dual: 'DUAL-TEX', wood: 'WOOD' };

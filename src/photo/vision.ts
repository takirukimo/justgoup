// "Enhance with Claude" (research §5.2): the straightened photo goes to Claude through the Artifact
// `sample` capability (claude.ai only, on the viewer's own account), with the local detector's regions
// drawn on a copy as numbered markers (Set-of-Mark). Claude lists the problem's holds (normalised x / y /
// size, a type and a role) and rejects markers that are not part of it; the strict JSON is validated
// here, then merged with (or replaces) the local result.

import type { HoldShape, HoldType } from '../core/types';
import { asSampleError, type SampleAccess, type SampleError } from './sample';
import type { PhotoHold } from './types';

export type VisionRole = 'start' | 'hand' | 'foot' | 'top';

/** A local region shown to Claude as marker `id` (normalised to the sent image). */
export interface VisionCandidate {
  id: number;
  x: number;
  y: number;
  /** Longest dimension / image width. */
  size: number;
}

export interface VisionContext {
  /** Size of the image sent (px). */
  width: number;
  height: number;
  colorName: string;
  colorHex: string;
  candidates: VisionCandidate[];
  /** Real wall size the image spans (m). */
  wallW: number;
  wallH: number;
  /** 2: clean photo + marked copy; 1: the marked copy only. */
  images: 1 | 2;
}

export interface VisionHold {
  /** Marker number on it, or null (a hold the detector missed). */
  id: number | null;
  /** Normalised centre (0..1 from the top-left). */
  x: number;
  y: number;
  /** Longest dimension / image width. */
  size: number;
  type: HoldType | null;
  shape?: HoldShape;
  role: VisionRole;
  confidence: number;
}

export interface VisionResult {
  holds: VisionHold[];
  /** Marker numbers that are not holds of the problem. */
  rejected: number[];
  /** Claude's read of the wall's steepness (degrees), or null. */
  wallAngle: number | null;
}

export const VISION = {
  minHolds: 3,
  maxHolds: 40,
  /** Holds closer than this (fraction of the image width) are one hold. */
  dedupe: 0.03,
  /** A Claude hold this close to a local region (beyond its radius, fraction of width) is that region. */
  snap: 0.02,
  maxCandidates: 60,
  /** Long edge of the image sent (the platform downsizes to ~1.2 MP anyway). */
  sendLong: 1200,
} as const;

/** A validation failure: Claude answered, but not with a usable list of holds. */
export class VisionError extends Error {
  constructor(
    readonly reason: 'shape' | 'count',
    message: string,
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

const TYPE_WORDS: Readonly<Record<string, { type: HoldType; shape?: HoldShape }>> = {
  jug: { type: 'jug' },
  bucket: { type: 'jug', shape: 'bucket' },
  edge: { type: 'edge' },
  rail: { type: 'edge', shape: 'rail' },
  crimp: { type: 'crimp' },
  micro: { type: 'crimp', shape: 'micro' },
  sloper: { type: 'sloper' },
  macro: { type: 'sloper', shape: 'macro' },
  pinch: { type: 'pinch' },
  horn: { type: 'pinch', shape: 'horn' },
  pocket: { type: 'pocket' },
  foot: { type: 'foot' },
  foothold: { type: 'foot' },
  chip: { type: 'foot', shape: 'chip' },
  volume: { type: 'volume' },
};

/** The prompt: what the images are, the detector's markers, and the exact JSON wanted. */
export function visionPrompt(ctx: VisionContext): string {
  const c = ctx.colorName.toLowerCase();
  const f3 = (v: number): string => v.toFixed(3);
  const cands = ctx.candidates.slice(0, VISION.maxCandidates);
  const imgs =
    ctx.images === 2
      ? 'Image 1 is the clean photo. Image 2 is the same photo with numbered markers (white rings with a number) on the regions an automatic colour detector found.'
      : 'The image carries numbered markers (white rings with a number) on the regions an automatic colour detector found.';
  const list = cands.length
    ? cands.map((k) => `${k.id}: (${f3(k.x)}, ${f3(k.y)}) size ${f3(k.size)}`).join('\n')
    : '(none: the detector found nothing)';
  return [
    `You are looking at a photo of an indoor bouldering wall, straightened so the wall is seen square on. The image is ${ctx.width}×${ctx.height} px and shows the wall from the floor (bottom edge) to its top (top edge), about ${ctx.wallW.toFixed(1)} m wide and ${ctx.wallH.toFixed(1)} m tall.`,
    imgs,
    `The climber picked the problem set in ${c} holds (sampled colour ${ctx.colorHex}). List every ${c} hold of that problem, and check the detector's markers.`,
    `Detector markers (centre x, y as fractions of the image width and height from the top-left corner; size = longest dimension as a fraction of the image width):\n${list}`,
    [
      'Rules:',
      `- Only ${c} holds count. Ignore holds of other colours, tape, the wall's texture, shadows, chalk marks and bolt holes.`,
      `- A ${c} volume (a big geometric feature bolted to the wall) counts only if it is clearly part of the problem: type "volume".`,
      '- Start holds are usually the lowest hand holds, often marked with tape; the top is the highest hold.',
      '- Small holds only the feet would use are type "foot".',
    ].join('\n'),
    'Reply with only JSON, no other text, in exactly this shape:',
    '{"holds":[{"id":3,"x":0.412,"y":0.233,"size":0.031,"type":"jug","role":"start","confidence":0.9}],"rejected":[7],"wallAngleDeg":15}',
    [
      `- holds: every ${c} hold of the problem, bottom to top. "id" is the marker number on it, or null when no marker sits on it (a hold the detector missed).`,
      '- x, y: the hold\'s centre as fractions of the image width and height (0 to 1, from the top-left corner).',
      '- size: the hold\'s longest dimension as a fraction of the image width.',
      '- type: one of "jug", "edge", "crimp", "sloper", "pinch", "pocket", "foot", "volume".',
      '- role: "start" (1 or 2 holds), "top" (exactly 1), "foot" (feet only) or "hand".',
      '- confidence: 0 to 1.',
      '- rejected: marker numbers that are NOT holds of this problem (tape, another colour, part of the wall, a shadow).',
      '- wallAngleDeg: the wall\'s steepness (0 vertical, positive leaning out over the climber, negative a slab), or null if you cannot tell.',
    ].join('\n'),
  ].join('\n\n');
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * Validate Claude's JSON strictly (in bounds, known types, 3–40 holds after merging duplicates within 3 %
 * of the width, at most two starts and one top). Pixel coordinates are tolerated (values past 1.5 are
 * read as pixels of the sent image). Throws VisionError.
 */
export function parseVision(raw: unknown, ctx: Pick<VisionContext, 'width' | 'height' | 'candidates'>): VisionResult {
  let root = raw;
  if (Array.isArray(root)) root = { holds: root };
  if (!root || typeof root !== 'object') throw new VisionError('shape', 'not an object');
  const o = root as Record<string, unknown>;
  const list = o.holds;
  if (!Array.isArray(list)) throw new VisionError('shape', 'no holds array');
  const ids = new Set(ctx.candidates.map((c) => c.id));
  const holds: VisionHold[] = [];
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    let x = num(h.x);
    let y = num(h.y);
    if (x === null || y === null) continue;
    if (x > 1.5) x /= ctx.width;
    if (y > 1.5) y /= ctx.height;
    if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) continue;
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    let size = num(h.size);
    if (size !== null && size > 1.5) size /= ctx.width;
    const word = typeof h.type === 'string' ? TYPE_WORDS[h.type.trim().toLowerCase()] : undefined;
    if (size === null || size <= 0) size = word?.type === 'foot' ? 0.012 : word?.type === 'volume' ? 0.12 : 0.025;
    size = Math.max(0.004, Math.min(0.4, size));
    const idn = num(h.id);
    const id = idn !== null && Number.isInteger(idn) && ids.has(idn) ? idn : null;
    const r = typeof h.role === 'string' ? h.role.trim().toLowerCase() : '';
    const role: VisionRole = r === 'start' || r === 'top' || r === 'foot' ? r : 'hand';
    const conf = num(h.confidence);
    const v: VisionHold = { id, x, y, size, type: word?.type ?? null, role, confidence: conf === null ? 0.6 : Math.max(0, Math.min(1, conf)) };
    if (word?.shape) v.shape = word.shape;
    holds.push(v);
  }
  // one hold per spot: the more confident wins (and a marker id beats none)
  holds.sort((a, b) => b.confidence - a.confidence || (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0));
  const kept: VisionHold[] = [];
  const usedIds = new Set<number>();
  const aspect = ctx.height / Math.max(1, ctx.width);
  for (const h of holds) {
    if (h.id !== null && usedIds.has(h.id)) continue;
    if (kept.some((k) => Math.hypot(k.x - h.x, (k.y - h.y) * aspect) < VISION.dedupe)) continue;
    if (h.id !== null) usedIds.add(h.id);
    kept.push(h);
  }
  if (kept.length < VISION.minHolds || kept.length > VISION.maxHolds) throw new VisionError('count', `${kept.length} holds`);
  // roles: a foot is never a start or the top; one top (the highest named), at most two starts (the lowest)
  for (const h of kept) if (h.type === 'foot' && (h.role === 'start' || h.role === 'top')) h.role = 'foot';
  const tops = kept.filter((h) => h.role === 'top').sort((a, b) => a.y - b.y);
  for (const t of tops.slice(1)) t.role = 'hand';
  const starts = kept.filter((h) => h.role === 'start').sort((a, b) => b.y - a.y);
  for (const s of starts.slice(2)) s.role = 'hand';
  kept.sort((a, b) => b.y - a.y || a.x - b.x);
  const rejected: number[] = [];
  if (Array.isArray(o.rejected)) {
    for (const r of o.rejected) {
      const n = num(r && typeof r === 'object' ? (r as Record<string, unknown>).id : r);
      if (n !== null && Number.isInteger(n) && ids.has(n) && !usedIds.has(n) && !rejected.includes(n)) rejected.push(n);
    }
  }
  const wa = num(o.wallAngleDeg ?? o.wallAngle);
  return { holds: kept, rejected, wallAngle: wa !== null && wa >= -20 && wa <= 90 ? Math.round(wa) : null };
}

/** A round outline (flat px pairs) for a hold that has no detected region. */
export function circleHull(x: number, y: number, r: number, n = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return out;
}

export interface MergeStats {
  /** Local holds Claude confirmed. */
  kept: number;
  /** Local holds Claude rejected (or left out, replacing). */
  dropped: number;
  /** Holds Claude added. */
  added: number;
}

export interface Merged {
  holds: PhotoHold[];
  starts: number[];
  top: number | null;
  stats: MergeStats;
}

/**
 * Combine Claude's answer with the local holds (rectified px; `local[i]` is marker i + 1).
 *  merge  — the local holds stay unless Claude rejected them; Claude's types and roles apply; holds
 *           Claude found that no marker sat on are added.
 *  claude — only Claude's holds (outlines from the local regions it named).
 * Image px are the rectified image's (`w` × `h`), the same frame the normalised answer refers to.
 */
export function mergeVision(local: readonly PhotoHold[], v: VisionResult, mode: 'merge' | 'claude', w: number, h: number): Merged {
  const out: PhotoHold[] = [];
  const roleOf = new Map<PhotoHold, VisionRole>();
  const byId = new Map<number, VisionHold>();
  for (const vh of v.holds) if (vh.id !== null) byId.set(vh.id, vh);
  const rejected = new Set(v.rejected);
  const stats: MergeStats = { kept: 0, dropped: 0, added: 0 };
  const apply = (p: PhotoHold, vh: VisionHold): PhotoHold => {
    const q: PhotoHold = { ...p, source: 'claude', included: true };
    if (vh.type) {
      q.type = vh.type;
      if (vh.shape) q.shape = vh.shape;
      else delete q.shape;
      if (vh.type === 'volume') q.kind = 'volume';
      else if (q.kind === 'volume' || q.kind === 'tape') q.kind = 'hold';
    }
    roleOf.set(q, vh.role);
    return q;
  };
  const used = new Set<number>();
  local.forEach((p, i) => {
    const id = i + 1;
    const vh = byId.get(id);
    if (vh) {
      out.push(apply(p, vh));
      used.add(i);
    } else if (mode === 'merge' && !rejected.has(id) && p.kind === 'hold' && p.included !== false) {
      out.push({ ...p });
      used.add(i);
    }
  });
  stats.kept = byId.size ? [...byId.keys()].filter((id) => id >= 1 && id <= local.length).length : 0;
  // holds Claude found without a marker: snap onto a nearby region (one we have, else — replacing — one
  // the detector found that Claude did not number), else a round hold of its size
  const snapPx = VISION.snap * w;
  for (const vh of v.holds) {
    if (vh.id !== null) continue;
    const px = vh.x * w;
    const py = vh.y * h;
    const near = out.find((p) => Math.hypot(p.x - px, p.y - py) < p.major / 2 + snapPx);
    if (near) {
      if (!roleOf.has(near)) out[out.indexOf(near)] = apply(near, vh);
      continue;
    }
    const li = local.findIndex((p, i) => !used.has(i) && !rejected.has(i + 1) && Math.hypot(p.x - px, p.y - py) < p.major / 2 + snapPx);
    if (li >= 0) {
      out.push(apply(local[li], vh));
      used.add(li);
      stats.kept++;
      continue;
    }
    const major = Math.max(4, vh.size * w);
    const q: PhotoHold = {
      x: px,
      y: py,
      major,
      minor: major * 0.75,
      theta: 0,
      solidity: 1,
      pocket: vh.type === 'pocket',
      kind: vh.type === 'volume' ? 'volume' : 'hold',
      hull: circleHull(px, py, major / 2),
      manual: true,
      source: 'claude',
    };
    if (vh.type) q.type = vh.type;
    if (vh.shape) q.shape = vh.shape;
    out.push(q);
    roleOf.set(q, vh.role);
    stats.added++;
  }
  stats.dropped = local.filter((p, i) => p.kind === 'hold' && p.included !== false && !used.has(i)).length;
  const starts: number[] = [];
  let top: number | null = null;
  out.forEach((p, i) => {
    const r = roleOf.get(p);
    if (r === 'start' && starts.length < 2) starts.push(i);
    else if (r === 'top' && top === null) top = i;
  });
  return { holds: out, starts, top, stats };
}

// ───────────────────────────── errors ─────────────────────────────

export interface VisionErrorCopy {
  /** Short headline. */
  title: string;
  body: string;
  /** Hide "Enhance with Claude" for the rest of this view. */
  hide: boolean;
  /** The viewer may try again (by hand). */
  retry: boolean;
}

/** What the viewer is told for each failure (null: nothing to say, e.g. they pressed Stop). */
export function visionErrorCopy(e: SampleError | VisionError): VisionErrorCopy | null {
  if (e instanceof VisionError) {
    return e.reason === 'count'
      ? { title: 'Claude’s answer didn’t fit', body: 'It found too few or too many holds for one problem. Your own detection stays.', hide: false, retry: true }
      : { title: 'Claude’s answer was unreadable', body: 'Your own detection stays. You can try once more.', hide: false, retry: true };
  }
  switch (e.code) {
    case 'cancelled':
      return null;
    case 'not_granted':
      return { title: 'Claude wasn’t allowed', body: 'This page may not use Claude in this view. Your own detection stays.', hide: true, retry: false };
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
      return { title: 'Claude isn’t available here', body: 'Your own detection stays.', hide: true, retry: false };
    case 'images_unavailable':
      return { title: 'Claude can’t see photos here', body: 'This view can’t send images. Your own detection stays.', hide: true, retry: false };
    case 'rate_limited':
      return { title: 'Claude is busy', body: 'Too many requests for now. Try again in a little while.', hide: false, retry: true };
    case 'session_expired':
      return { title: 'Sign in to Claude again', body: 'Your session ended. Sign in, then try again.', hide: false, retry: true };
    case 'image_rejected':
      return { title: 'Claude couldn’t read this photo', body: 'Try another photo, or keep your own detection.', hide: false, retry: false };
    case 'refused':
      return { title: 'Claude declined this photo', body: 'Your own detection stays.', hide: false, retry: false };
    case 'empty_completion':
    case 'invalid_json':
      return { title: 'Claude’s answer was unreadable', body: 'Your own detection stays. You can try once more.', hide: false, retry: true };
    case 'invalid_request':
    case 'prompt_too_large':
    case 'transform_error':
    case 'queue_overflow':
    case 'tools_unavailable':
      return { title: 'Couldn’t ask Claude', body: 'Something went wrong preparing the request. Your own detection stays.', hide: false, retry: false };
    default:
      return { title: 'Connection hiccup', body: 'Claude couldn’t be reached. Try again.', hide: false, retry: true };
  }
}

// ───────────────────────────── the call (browser) ─────────────────────────────

/** Encode a canvas for Claude (JPEG when accepted). */
function toBlob(c: HTMLCanvasElement, types: readonly string[]): Promise<Blob> {
  const type = types.includes('image/jpeg') ? 'image/jpeg' : types.includes('image/webp') ? 'image/webp' : 'image/png';
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.9));
}

/** The straightened photo at the send size, and a copy with numbered markers on the local regions. */
export function visionImages(rect: HTMLCanvasElement, holds: readonly PhotoHold[]): { clean: HTMLCanvasElement; marked: HTMLCanvasElement; candidates: VisionCandidate[] } {
  const k = Math.min(1, VISION.sendLong / Math.max(rect.width, rect.height));
  const w = Math.round(rect.width * k);
  const h = Math.round(rect.height * k);
  const clean = document.createElement('canvas');
  clean.width = w;
  clean.height = h;
  clean.getContext('2d')!.drawImage(rect, 0, 0, w, h);
  const marked = document.createElement('canvas');
  marked.width = w;
  marked.height = h;
  const g = marked.getContext('2d')!;
  g.drawImage(clean, 0, 0);
  const candidates: VisionCandidate[] = [];
  holds.forEach((p, i) => {
    const id = i + 1;
    const x = p.x * k;
    const y = p.y * k;
    const r = Math.max(9, (p.major * k) / 2 + 4);
    candidates.push({ id, x: x / w, y: y / h, size: (p.major * k) / w });
    g.lineWidth = 3;
    g.strokeStyle = '#000';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1.6;
    g.strokeStyle = '#fff';
    g.stroke();
    // number tag at the ring's upper right
    const label = String(id);
    g.font = '700 15px system-ui, sans-serif';
    const tw = g.measureText(label).width;
    const tx = Math.min(w - tw - 6, x + r * 0.7);
    const ty = Math.max(16, y - r * 0.7);
    g.fillStyle = '#fff';
    g.fillRect(tx - 3, ty - 13, tw + 6, 17);
    g.fillStyle = '#000';
    g.fillText(label, tx, ty);
  });
  return { clean, marked, candidates };
}

export interface AskOptions {
  access: SampleAccess;
  rect: HTMLCanvasElement;
  holds: readonly PhotoHold[];
  colorName: string;
  colorHex: string;
  wallW: number;
  wallH: number;
  signal: AbortSignal;
  /** Fires as the answer streams (characters so far), for a progress line. */
  onProgress?: (chars: number) => void;
}

/** Ask Claude. Resolves the validated answer (normalised to the sent image); rejects SampleError | VisionError. */
export async function askClaude(o: AskOptions): Promise<VisionResult> {
  const { clean, marked, candidates } = visionImages(o.rect, o.holds);
  const types = o.access.images.mediaTypes;
  const two = o.access.images.maxCount >= 2;
  const blobs = two ? [await toBlob(clean, types), await toBlob(marked, types)] : [await toBlob(marked, types)];
  if (blobs.some((b) => b.size > o.access.images.maxInputBytes)) throw { code: 'image_rejected', message: 'image too large' } satisfies SampleError;
  const ctx: VisionContext = {
    width: clean.width,
    height: clean.height,
    colorName: o.colorName,
    colorHex: o.colorHex,
    candidates,
    wallW: o.wallW,
    wallH: o.wallH,
    images: two ? 2 : 1,
  };
  let raw: unknown;
  try {
    raw = await o.access.sample.json(visionPrompt(ctx), {
      images: blobs,
      signal: o.signal,
      modelTier: 'default',
      onText: ({ text }) => o.onProgress?.(text.length),
    });
  } catch (e) {
    throw asSampleError(e);
  }
  return parseVision(raw, ctx);
}

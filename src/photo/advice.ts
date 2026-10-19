// What the importer tells the player when a photo, a frame, a colour tap or a detection looks wrong
// (research §5.1–5.2: helpful messages, a way on from every step, never a dead end). Pure functions over
// plain numbers, so every message is unit-tested; the importer only renders them and wires the actions.

import { colorDistance } from './color';
import { ROUTE } from './route';
import type { Lab } from './types';

/** What a message offers to do (the importer turns each into a button). */
export type AdviceAction = 'more' | 'less' | 'recolor' | 'exclude' | 'reframe' | 'add';

export interface Advice {
  /** 'bad': this step can't go on as it is; 'warn': it can, but the result will likely be off. */
  level: 'warn' | 'bad';
  /** Short headline (sentence case). */
  title: string;
  /** One sentence: what to do about it. */
  body: string;
  actions?: AdviceAction[];
}

export const ADVICE = {
  /** A photo's shorter side below this (px, as picked) is small for the detector… */
  smallPhoto: 640,
  /** …and below this too small to use at all (a thumbnail, a screenshot of a screenshot). */
  tinyPhoto: 240,
  /** Long / short side above this reads as a panorama. */
  panorama: 2.6,
  /** Framed wall area under this fraction of the photo: the wall is far away. */
  smallFrame: 0.06,
  /** Straightened wall wider than tall by more than this: more than one wall section framed. */
  wideFrame: 2.4,
  /** A tapped colour this close (ΔE) to the wall's own colour is the wall. */
  wallDelta: 9,
  /** Fraction of the straightened wall matching the colour above which the colour is too loose. */
  coverage: 0.2,
  /** More holds than this is more than one problem. */
  manyHolds: 36,
  /** Hard cap: the editor keeps 64 holds, start / gap footholds take up to 8 of them. */
  maxHolds: 56,
  /** The median hold should be 8–25 cm (research §5.1): outside these the frame is off. */
  tinyHoldM: 0.045,
  hugeHoldM: 0.32,
  /** Editor rules (editor/model EDITOR.minHands, minRise). */
  minHands: 4,
  minRise: 0.6,
} as const;

/** The photo as picked (before downscaling). */
export function photoAdvice(srcW: number, srcH: number): Advice | null {
  const short = Math.min(srcW, srcH);
  const long = Math.max(srcW, srcH);
  if (short < ADVICE.tinyPhoto) return { level: 'bad', title: 'Too small', body: `At ${srcW} × ${srcH} px there’s too little to find holds in. Pick the original photo, not a thumbnail.` };
  if (short < ADVICE.smallPhoto) return { level: 'warn', title: 'Small photo', body: `At ${srcW} × ${srcH} px small holds blur together. A full-size photo finds more.` };
  if (long / Math.max(1, short) > ADVICE.panorama) return { level: 'warn', title: 'Looks like a panorama', body: 'Panoramas bend the wall. One photo, square on to the wall, works best.' };
  return null;
}

/** Why a picked file could not be opened. */
export function decodeAdvice(type: string, name: string): string {
  const t = type.toLowerCase();
  const n = name.toLowerCase();
  if (/hei[cf]/.test(t) || /\.hei[cf]$/.test(n)) return 'This browser can’t open HEIC photos. Pick a JPEG or PNG, or set the camera to “Most Compatible”.';
  if (t && !t.startsWith('image/')) return 'That file isn’t a photo. Pick a JPEG or PNG of the wall.';
  return 'That photo couldn’t be opened. Try a JPEG or PNG.';
}

/** The framed wall: `areaFrac` of the photo, straightened width / height `aspect`. */
export function frameAdvice(areaFrac: number, aspect: number): Advice | null {
  if (aspect > ADVICE.wideFrame) return { level: 'warn', title: 'Very wide frame', body: 'Frame one wall section, floor to top: a wide frame shrinks every hold.' };
  if (areaFrac < ADVICE.smallFrame) return { level: 'warn', title: 'The wall is small in this photo', body: 'Small holds may be missed. Check the corners, or take the photo closer.' };
  return null;
}

/** A colour tap (`sample`) against the straightened wall's own colour. */
export function colorAdvice(sample: Lab, wall: Lab | null): Advice | null {
  if (!wall) return null;
  if (colorDistance(wall.L, wall.a, wall.b, sample) < ADVICE.wallDelta) {
    return { level: 'warn', title: 'That looks like the wall', body: 'Tap one of your problem’s holds instead. Pinch to zoom in on a small one.', actions: ['recolor'] };
  }
  return null;
}

export interface HoldsInfo {
  /** Holds in the problem (included). */
  n: number;
  /** Fraction of the straightened wall that matched the colour. */
  coverage: number;
  /** Median longest dimension of the detected holds (m on the framed wall), or null with < 4 holds. */
  medianM: number | null;
  /** 0..1. */
  sensitivity: number;
}

/** The detection result. The first message is the most important one. */
export function holdsAdvice(o: HoldsInfo): Advice[] {
  const out: Advice[] = [];
  const canMore = o.sensitivity < 0.95;
  const canLess = o.sensitivity > 0.05;
  if (o.coverage > ADVICE.coverage && o.n <= 1) {
    // the colour matches the wall itself (one huge region, set aside as a volume, or nothing)
    out.push({ level: 'bad', title: 'That colour is the wall', body: 'Most of the wall matches it. Tap one of your problem’s holds instead.', actions: canLess ? ['recolor', 'less'] : ['recolor'] });
    return out;
  }
  if (o.n === 0) {
    out.push({
      level: 'bad',
      title: 'No holds found',
      body: canMore ? 'Nothing of that colour stood out. Raise the sensitivity, or tap a hold of your problem again.' : 'Nothing of that colour stood out. Tap a hold of your problem again, or add holds by tapping them.',
      actions: canMore ? ['more', 'recolor'] : ['recolor'],
    });
    return out;
  }
  if (o.coverage > ADVICE.coverage) {
    out.push({ level: 'warn', title: 'Much of the wall matches', body: 'Lower the sensitivity, or tap the wall with NOT THIS.', actions: canLess ? ['less', 'exclude'] : ['exclude'] });
  } else if (o.n > ADVICE.maxHolds) {
    out.push({ level: 'bad', title: `${o.n} holds is too many`, body: `A problem takes up to ${ADVICE.maxHolds}. Lower the sensitivity, or tap look-alike colours with NOT THIS.`, actions: canLess ? ['less', 'exclude'] : ['exclude'] });
  } else if (o.n > ADVICE.manyHolds) {
    out.push({ level: 'warn', title: 'That’s a lot of holds', body: 'Other routes may match too. Lower the sensitivity, or tap holds to drop them.', actions: canLess ? ['less'] : [] });
  }
  if (o.n === 1) out.push({ level: 'bad', title: 'Only one hold', body: 'A problem needs a start and a top. Tap the others to add them, or raise the sensitivity.', actions: canMore ? ['more', 'add'] : ['add'] });
  else if (o.n < ADVICE.minHands) out.push({ level: 'warn', title: `Only ${o.n} holds`, body: 'Tap missed holds to add them, or raise the sensitivity.', actions: canMore ? ['more', 'add'] : ['add'] });
  if (o.medianM !== null && o.n >= 4) {
    if (o.medianM < ADVICE.tinyHoldM) out.push({ level: 'warn', title: 'Holds look tiny', body: 'Do the corners frame just the wall, floor to top?', actions: ['reframe'] });
    else if (o.medianM > ADVICE.hugeHoldM) out.push({ level: 'warn', title: 'Holds look huge', body: 'Drag the corners out to the whole wall, floor to top.', actions: ['reframe'] });
  }
  return out;
}

/** Can the HOLDS step go on? (a start and a top need two holds; the editor keeps 64) */
export function holdsReady(n: number): boolean {
  return n >= 2 && n <= ADVICE.maxHolds;
}

export interface RolesInfo {
  /** Start holds' heights on the chosen wall (m along the surface). */
  startYs: number[];
  /** The top's height, or null. */
  topY: number | null;
  /** Hand holds in the problem. */
  hands: number;
}

/** Start / top: what's missing or will trouble the game's climber (the editor's rules, sit starts). */
export function rolesAdvice(o: RolesInfo): Advice | null {
  if (!o.startYs.length) return { level: 'bad', title: 'No start yet', body: 'With START on, tap 1 or 2 holds the problem starts on.' };
  if (o.topY === null) return { level: 'bad', title: 'No top yet', body: 'Switch to TOP and tap the hold you finish on.' };
  const hiStart = Math.max(...o.startYs);
  if (o.topY < hiStart + ADVICE.minRise) return { level: 'bad', title: 'The top is too low', body: 'The top must sit well above the start: tap the finishing hold up high.' };
  if (Math.min(...o.startYs) < ROUTE.startMinY) return { level: 'warn', title: 'A sit start', body: 'The game’s climber starts standing: start holds about chest high (1.2–2 m) climb best.' };
  if (o.hands < ADVICE.minHands) return { level: 'warn', title: `Only ${o.hands} hand holds`, body: `The editor needs ${ADVICE.minHands}: go back to HOLDS and tap missed holds to add them.` };
  return null;
}

/** How far a MORE / FEWER action moves the sensitivity. */
export const SENSITIVITY_STEP = 0.15;

// Everything Steini says in the intro and the tutorial. Lesson lines stay short (≤ 16 words) so
// they read at a glance mid-move. Swiss flavour is used sparingly.

import type { GuideLine } from '../core/contracts';
import type { LimbId } from '../core/types';
import type { TutorialStep } from '../game/generator';
import { BRAND, PALETTE } from '../config/brand';

export type Mood = NonNullable<GuideLine['mood']>;

export interface Line {
  text: string;
  mood: Mood;
}

const L = (text: string, mood: Mood = 'happy'): Line => ({ text, mood });

export const LIMB_NAME: Record<LimbId, string> = {
  LH: 'left hand',
  RH: 'right hand',
  LF: 'left foot',
  RF: 'right foot',
};

// ───────────────────────────── intro (first launch) ─────────────────────────────

/** The cinematic title card: game title, brand line, then a spec-sheet row about the gym. */
export const INTRO_CARD = {
  eyebrow: `NOW ENTERING ${BRAND.gym}`,
  title: BRAND.game,
  /** Spec-sheet row: tiny label above each value. */
  specs: [
    ['HALL', 'BOULDER'],
    ['WALL', '01 · 4.5 M'],
    ['INSTRUCTOR', BRAND.guideName.toUpperCase()],
  ],
} as const;

export const INTRO_LINES: readonly Line[] = [
  L(`Grüezi! I’m ${BRAND.guideName}, your instructor here at ${BRAND.gym}. Yes, the horns are real.`, 'happy'),
  L('Here you move every limb yourself. Two hands, two feet, one wobbly body.', 'think'),
  L('Find your balance, climb to the TOP, and please don’t fall off.', 'point'),
];

// ───────────────────────────── tutorial: framing ─────────────────────────────

/** Opening lines on the route-reading shot; the colour word follows the tutorial route's tape. */
export function tOpen(routeHex: string): readonly Line[] {
  const c = colourWord(routeHex);
  return [
    L(`This is my problem. ${c.charAt(0).toUpperCase() + c.slice(1)} holds only. The other colours belong to other routes.`, 'point'),
    L('Hands start on START. Finish with both hands on TOP, and hold it.', 'happy'),
  ];
}

/** Plain colour word for a route hex ('orange', 'pink', …). CHIRAL pink is always 'pink'. */
export function colourWord(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'glowing';
  if (`#${m[1]}`.toLowerCase() === PALETTE.signal.toLowerCase()) return 'pink';
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (l > 0.86 && d < 0.2) return 'white';
  if (l < 0.16) return 'black';
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.18) return 'grey';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 12 || h >= 345) return 'red';
  if (h < 42) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 170) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

export const T_HANDLES = L('Those rings are your hands and feet. Drag one, and only that limb moves.', 'point');

// ───────────────────────────── tutorial: lessons ─────────────────────────────

export interface LessonCopy {
  instruct: Line;
  /** Re-phrased instruction for idle nudges and the hint button. */
  nudge: Line;
  success: Line;
  /** Bubble placement: keep it away from the limb being taught. */
  pos: 'top' | 'bottom';
}

const BY_HOLD: Record<string, Omit<LessonCopy, 'pos'>> = {
  'hand:RH:tut-hand-1': {
    instruct: L('Drag your right hand up onto the glowing jug.', 'point'),
    nudge: L('Grab your right-hand ring and drag it up onto the glowing hold.', 'point'),
    success: L('Allez! That’s your first move.', 'cheer'),
  },
  'foot:RF:tut-foot-2': {
    instruct: L('Now your right foot. Step it up onto the glowing foothold.', 'point'),
    nudge: L('Right-foot ring up onto the glowing foothold. Legs do the work.', 'point'),
    success: L('Nice footwork. Legs are stronger than arms, so use them.', 'cheer'),
  },
  'hand:LH:tut-hand-2': {
    instruct: L('Left hand next. Reach for the jug up and to the left.', 'point'),
    nudge: L('Left-hand ring up to the glowing jug. You’ve got this.', 'point'),
    success: L('Hopp! Smooth as fondue.', 'cheer'),
  },
  'foot:LF:tut-foot-3': {
    instruct: L('Left foot up onto the glowing hold. Small steps are fine.', 'point'),
    nudge: L('Left-foot ring onto the glowing foothold.', 'point'),
    success: L('Good. Three limbs on, one moving. Always.', 'cheer'),
  },
  'shake:RH:tut-hand-3': {
    instruct: L('Big one now. Stretch your right hand out to that far edge.', 'point'),
    nudge: L('Right hand, all the way out to the glowing edge. Reach!', 'point'),
    success: L('Got it! Hold on…', 'warn'),
  },
  'foot:RF:tut-foot-4': {
    instruct: L('Fix it with your feet. Right foot up, under that hand.', 'point'),
    nudge: L('Right-foot ring onto the glowing foothold. Feet calm the shakes.', 'point'),
    success: L('See? Shaking’s gone. Good feet fix almost everything.', 'cheer'),
  },
  'hand:LH:tut-hand-4': {
    instruct: L('Left hand to the big jug in the middle. You’re climbing now!', 'point'),
    nudge: L('Left-hand ring up to the glowing jug.', 'point'),
    success: L('Look at you. A natural. Almost an ibex.', 'cheer'),
  },
  'foot:LF:tut-foot-5': {
    instruct: L('Left foot up. Keep your hips close to the wall.', 'point'),
    nudge: L('Left-foot ring onto the glowing foothold.', 'point'),
    success: L('Hips in, arms long. Perfect.', 'cheer'),
  },
  'foot:RF:tut-foot-6': {
    instruct: L('Right foot high. Then stand up into it.', 'point'),
    nudge: L('Right-foot ring up onto the glowing foothold.', 'point'),
    success: L('Strong legs, easy top. Almost there!', 'cheer'),
  },
  'match:LH:tut-top': {
    instruct: L('There’s the TOP. Left hand up onto the big one!', 'point'),
    nudge: L('Left-hand ring onto the TOP hold.', 'point'),
    success: L('One hand on TOP…', 'cheer'),
  },
  'match:RH:tut-top': {
    instruct: L('Now match it. Right hand on TOP too, and hold it.', 'point'),
    nudge: L('Right-hand ring onto TOP. Both hands on it to finish.', 'point'),
    success: L('Hold it… hold it…', 'cheer'),
  },
};

/** A hand put back on its hold after a beat that didn't happen. */
export const PRAISE_BACK: Line = L('Back on. Good.', 'cheer');
export const backOn = (hand: LimbId): Line => L(`Put your ${LIMB_NAME[hand]} back on the glowing hold.`, 'point');

const PRAISE: readonly Line[] = [L('Allez!', 'cheer'), L('Hopp, nice!', 'cheer'), L('Clean move.', 'cheer'), L('Exactly like that.', 'cheer')];

/** Copy for one lesson step (hand-written for the canonical sequence, generic otherwise). */
export function lessonCopy(step: TutorialStep, index: number, isFinalMatch: boolean): LessonCopy {
  const pos: LessonCopy['pos'] = step.limb === 'LF' || step.limb === 'RF' ? 'top' : 'bottom';
  const own = BY_HOLD[`${step.teach}:${step.limb}:${step.holdId}`];
  if (own) return { ...own, pos };
  const name = LIMB_NAME[step.limb];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  const ring = `${cap.replace(' ', '-')} ring`;
  if (step.teach === 'match') {
    return {
      instruct: L(isFinalMatch ? `Match it: ${name} on TOP too, and hold.` : `${cap} onto the TOP hold!`, 'point'),
      nudge: L(`${ring} onto the TOP hold.`, 'point'),
      success: L(isFinalMatch ? 'Hold it… hold it…' : 'One hand on TOP…', 'cheer'),
      pos,
    };
  }
  return {
    instruct: L(`${cap} next. Move it onto the glowing hold.`, 'point'),
    nudge: L(`${ring} onto the glowing hold.`, 'point'),
    success: PRAISE[index % PRAISE.length],
    pos,
  };
}

// ───────────────────────────── hips ─────────────────────────────

export const HIPS = {
  instruct: (limb: LimbId, dir: 'left' | 'right'): Line =>
    L(`Now the hip ring. Drag your hips ${dir}, over your ${LIMB_NAME[limb]}.`, 'point'),
  nudge: (limb: LimbId, dir: 'left' | 'right'): Line =>
    L(`Grab the ring on your hips and slide it ${dir}, above your ${LIMB_NAME[limb].split(' ')[1]}.`, 'point'),
  further: (dir: 'left' | 'right'): Line => L(`A bit further ${dir}. Hips right over that foot.`, 'think'),
  success: L('Feel that? Weight on your feet, arms relax. That’s the whole secret.', 'cheer'),
} as const;

// ───────────────────────────── shaking / pump ─────────────────────────────

export const SHAKE = {
  felt: L('Feel the shaking? That’s tension. Stretched out like this, you pump out fast.', 'warn'),
  concept: L('The middle gauge at the bottom is your tension. Past the notch, you start to shake.', 'think'),
  pump: L('Shaking pumps your forearms: the bars left and right. Full pump means you fall.', 'warn'),
  calmInstruct: L('Now bring your right foot up, under that hand.', 'point'),
  calmSuccess: L('Solid. Good feet fix almost everything.', 'cheer'),
} as const;

// ───────────────────────────── mistakes ─────────────────────────────

export type MistakeKind = 'wrong' | 'short' | 'return' | 'smear' | 'blocked' | 'struggle' | 'off-top' | 'shake-out' | 'chalk' | 'dyno-miss';

export const MISTAKES: Record<MistakeKind, readonly Line[]> = {
  wrong: [L('Close! Wrong hold, though. Aim for the glowing one.', 'think'), L('Not that one. The glowing hold, please.', 'think')],
  short: [L('Drag it all the way to the glowing hold.', 'think'), L('Further! Right onto the glowing hold.', 'think')],
  return: [L('Let go right on the hold, once it lights up.', 'think'), L('Missed! Let go when the hold lights up green.', 'think')],
  smear: [L('That’s a smear: rubber on blank wall. Handy, but use the hold.', 'think'), L('Smearing works, but this time use the glowing foothold.', 'think')],
  blocked: [L('Not that one yet. Move the bright ring.', 'think'), L('One limb at a time. Just the bright ring for now.', 'think')],
  struggle: [L('Tip: drag onto the glowing hold, pause, and let go when it lights up green.', 'think')],
  'off-top': [L('Both hands on TOP, and keep them there a moment.', 'warn')],
  // a hand let go down by the side (the shake-out lane) or at the hips (the chalk bag) mid-lesson
  'shake-out': [L('That’s a shake-out: the arm hangs and recovers. Now onto the glowing hold.', 'think')],
  chalk: [L('Chalking up? Good habit! Then onto the glowing hold.', 'happy')],
  'dyno-miss': [L('So close! Flick harder, straight at the hold.', 'think'), L('Almost! Aim the flick right at the glowing hold.', 'think')],
};

export const DRAG_TIPS = {
  firstDrag: L('Aim for the glowing hold. Green means a good grip.', 'point'),
  letGo: L('That’s the one. Let go!', 'cheer'),
  stretch: L('Full stretch! Keep holding. Your body leans into the reach.', 'point'),
  /** At full stretch with a throw that would make it (sim.dynoCandidate feasible). */
  deadpoint: L('Just out of reach? Flick toward it as you let go: a deadpoint.', 'point'),
} as const;

// ───────────────────────────── shake-out + chalk (Phase B body) ─────────────────────────────

const side = (hand: LimbId): string => LIMB_NAME[hand].split(' ')[0];
const ringOf = (hand: LimbId): string => `${LIMB_NAME[hand].replace(' ', '-')} ring`;

/** Rest beat on a big jug: drop the pumped hand by the side, shake it out, put it back. */
export const SHAKE_OUT = {
  instruct: (hand: LimbId): Line => L(`Big jug, good feet: rest here. Let your ${side(hand)} arm hang down by your side.`, 'point'),
  nudge: (hand: LimbId): Line => L(`Drag the ${ringOf(hand)} down by your side, clear of the holds, then let go.`, 'point'),
  /** The hand landed on a hold / went back instead of hanging free. */
  free: L('Let it hang free: down by your side, clear of the holds.', 'think'),
  /** `pumped`: that forearm has pump to lose (else the line explains the rest instead). */
  shaking: (hand: LimbId, pumped: boolean): Line =>
    pumped ? L(`Shake it out… Watch your ${side(hand)} forearm gauge drain.`, 'happy') : L('Shake it out… A loose, hanging arm recovers fastest.', 'happy'),
  back: (hand: LimbId): LessonCopy => ({
    instruct: L(`Rested. Now put your ${LIMB_NAME[hand]} back on its hold.`, 'point'),
    nudge: L(`${cap(ringOf(hand))} back onto the glowing hold.`, 'point'),
    success: L('That’s a shake-out. Rest on big holds before the pump gets you.', 'cheer'),
    pos: 'bottom',
  }),
  skip: L('We’ll leave it. Remember: pumped? Shake out on a big hold.', 'happy'),
} as const;

/** Chalk beat before the top: dip a hand into the bag (drag it to the hips, or tap its forearm gauge). */
export const CHALK = {
  /** `word` is what the HUD shows for that hand's chalk (FRESH / WORN / GREASY). */
  instruct: (hand: LimbId, word: 'FRESH' | 'WORN' | 'GREASY'): Line =>
    word === 'FRESH'
      ? L(`Before the top, chalk up. Drag your ${LIMB_NAME[hand]} down to the bag at your hips.`, 'point')
      : L(`Your ${side(hand)} hand reads ${word}. Sweaty skin slips. Drag it to your chalk bag.`, 'warn'),
  nudge: (hand: LimbId): Line => L(`Drag the ${ringOf(hand)} onto the chalk bag at your hips, or tap its forearm gauge.`, 'point'),
  miss: L('Not quite. The chalk bag hangs behind your hips.', 'think'),
  dipping: L('Dip, dip… fresh chalk.', 'happy'),
  success: L('Fresh chalk, better grip. Slopers and crimps feel it most.', 'cheer'),
  skip: L('We’ll leave it. Greasy hand? Tap its forearm gauge to chalk up.', 'happy'),
} as const;

function cap(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ───────────────────────────── rescue (a move that's out of reach from here) ─────────────────────────────

export const RESCUE = {
  feetFirst: (foot: LimbId): Line => L(`Too far from down there. Feet first: ${LIMB_NAME[foot]} up, then reach again.`, 'think'),
  standUp: L('Now stand up on it. Drag the hip ring up.', 'point'),
  standNudge: L('Grab the ring on your hips and push it up. Stand tall.', 'point'),
  higher: L('A bit higher. Stand tall on that foot.', 'think'),
  stood: L('Taller already. Now that reach is on.', 'cheer'),
  retry: L('Better feet, longer reach. Now try that move again.', 'point'),
  letGo: L('Tricky one. We’ll leave it. Real climbers adapt too.', 'happy'),
  almost: L('Close enough! You’ve got the idea. Matching TOP sends it.', 'cheer'),
} as const;

// ───────────────────────────── finale ─────────────────────────────

export const FINALE: readonly Line[] = [
  L(`SENT! Your first ${BRAND.name} problem. I’d high-five you, but… hooves.`, 'cheer'),
  L('Out there, walls get steep. Too far? Flick your hand at the hold: a deadpoint.', 'point'),
  L(`Send as many as you can without falling. That’s your score. Welcome to ${BRAND.game}. Hopp!`, 'point'),
];

// ───────────────────────────── pacing ─────────────────────────────
//
// Owner's rule: every card and line stays up long enough to read, about 220 ms per word with a
// 2.5 s minimum, plus the fade. Tap-to-continue lines can always be advanced early.

/** Seconds per word at a relaxed reading pace. */
export const READ_S_PER_WORD = 0.22;
/** Nothing Steini says is on screen for less than this (s). */
export const READ_MIN_S = 2.5;
/** Enter/leave cross-fade of the speech bubble and the title card (s). */
export const FADE_S = 0.35;
/** The bubble's typewriter reveal (keep in sync with src/ui/guide-bubble.ts). */
const TYPE_S_PER_CHAR = 0.024;
const TYPE_MAX_S = 2.6;

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Pure reading time for a line or card (s): 220 ms per word, at least 2.5 s. */
export function readTime(text: string): number {
  return Math.max(READ_MIN_S, wordCount(text) * READ_S_PER_WORD);
}

/**
 * How long a line stays on screen before the script moves on (s): its reading time, plus half of
 * the typewriter reveal (people read along while it types), plus the fade.
 */
export function holdTime(text: string): number {
  const typing = Math.min(TYPE_MAX_S, text.trim().length * TYPE_S_PER_CHAR);
  return readTime(text) + typing * 0.5 + FADE_S;
}

/** The intro title card's on-screen time (s), from every word it shows. */
export function cardHoldTime(): number {
  const words = [INTRO_CARD.eyebrow, INTRO_CARD.title, `BY ${BRAND.name} ${BRAND.sub}`, ...INTRO_CARD.specs.flat()].join(' ');
  return readTime(words) + FADE_S;
}

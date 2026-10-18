// Everything Steini says in the intro and the tutorial. Lesson lines stay short (≤ 16 words) so
// they read at a glance mid-move. Swiss flavour is used sparingly.

import type { GuideLine } from '../core/contracts';
import type { LimbId } from '../core/types';
import type { TutorialStep } from '../game/generator';
import { BRAND } from '../config/brand';

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

export const INTRO_CARD = {
  eyebrow: 'NOW ENTERING',
  title: BRAND.gym,
  /** Spec-sheet row: tiny label above each value. */
  specs: [
    ['HALL', 'BOULDER'],
    ['WALL', '01 · 4.5 M'],
    ['SETTER ON DUTY', BRAND.guideName.toUpperCase()],
  ],
} as const;

export const INTRO_LINES: readonly Line[] = [
  L(`Grüezi! I’m ${BRAND.guideName}, head setter here at ${BRAND.gym}. Yes, the horns are real.`, 'happy'),
  L('Here you move every limb yourself. Two hands, two feet, one wobbly body.', 'think'),
  L('Find your balance, climb to the TOP, and please don’t fall off.', 'point'),
];

// ───────────────────────────── tutorial: framing ─────────────────────────────

export const T_OPEN: readonly Line[] = [
  L('This is my problem. Orange holds only. The other colours belong to other routes.', 'point'),
  L('Hands start on START. Finish with both hands on TOP, and hold it.', 'happy'),
];

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
    nudge: L('Grab the right-hand ring and pull it up to the pulsing hold.', 'point'),
    success: L('Allez! That’s your first move.', 'cheer'),
  },
  'foot:RF:tut-foot-2': {
    instruct: L('Now your right foot. Step it up onto the glowing foothold.', 'point'),
    nudge: L('Right foot ring, up onto the pulsing foothold. Legs do the work.', 'point'),
    success: L('Nice footwork. Legs are stronger than arms, so use them.', 'cheer'),
  },
  'hand:LH:tut-hand-2': {
    instruct: L('Left hand next. Reach for the jug up and to the left.', 'point'),
    nudge: L('Left hand ring, up to the pulsing jug. You’ve got this.', 'point'),
    success: L('Hopp! Smooth as fondue.', 'cheer'),
  },
  'foot:LF:tut-foot-3': {
    instruct: L('Left foot up onto the glowing hold. Small steps are fine.', 'point'),
    nudge: L('Left foot ring, onto the pulsing foothold.', 'point'),
    success: L('Good. Three limbs on, one moving. Always.', 'cheer'),
  },
  'shake:RH:tut-hand-3': {
    instruct: L('Big one now. Stretch your right hand out to that far edge.', 'point'),
    nudge: L('Right hand, all the way out to the pulsing edge. Reach!', 'point'),
    success: L('Got it! Hold on…', 'warn'),
  },
  'foot:RF:tut-foot-4': {
    instruct: L('Fix it with your feet. Right foot up, under that hand.', 'point'),
    nudge: L('Right foot ring onto the pulsing foothold. Feet calm the shakes.', 'point'),
    success: L('See? Shaking’s gone. Good feet fix almost everything.', 'cheer'),
  },
  'hand:LH:tut-hand-4': {
    instruct: L('Left hand to the big jug in the middle. You’re climbing now!', 'point'),
    nudge: L('Left hand ring, up to the pulsing jug.', 'point'),
    success: L('Look at you. A natural. Almost an ibex.', 'cheer'),
  },
  'foot:LF:tut-foot-5': {
    instruct: L('Left foot up. Keep your hips close to the wall.', 'point'),
    nudge: L('Left foot ring onto the pulsing foothold.', 'point'),
    success: L('Hips in, arms long. Perfect.', 'cheer'),
  },
  'foot:RF:tut-foot-6': {
    instruct: L('Right foot high. Then stand up into it.', 'point'),
    nudge: L('Right foot ring up onto the pulsing foothold.', 'point'),
    success: L('Strong legs, easy top. Almost there!', 'cheer'),
  },
  'match:LH:tut-top': {
    instruct: L('There’s the TOP. Left hand up onto the big one!', 'point'),
    nudge: L('Left hand ring onto the TOP hold.', 'point'),
    success: L('One hand on TOP…', 'cheer'),
  },
  'match:RH:tut-top': {
    instruct: L('Now match it. Right hand on TOP too, and hold it.', 'point'),
    nudge: L('Right hand ring onto TOP. Both hands on it to finish.', 'point'),
    success: L('Hold it… hold it…', 'cheer'),
  },
};

const PRAISE: readonly Line[] = [L('Allez!', 'cheer'), L('Hopp, nice!', 'cheer'), L('Clean move.', 'cheer'), L('Exactly like that.', 'cheer')];

/** Copy for one lesson step (hand-written for the canonical sequence, generic otherwise). */
export function lessonCopy(step: TutorialStep, index: number, isFinalMatch: boolean): LessonCopy {
  const pos: LessonCopy['pos'] = step.limb === 'LF' || step.limb === 'RF' ? 'top' : 'bottom';
  const own = BY_HOLD[`${step.teach}:${step.limb}:${step.holdId}`];
  if (own) return { ...own, pos };
  const name = LIMB_NAME[step.limb];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  if (step.teach === 'match') {
    return {
      instruct: L(isFinalMatch ? `Match it: ${name} on TOP too, and hold.` : `${cap} onto the TOP hold!`, 'point'),
      nudge: L(`${cap} ring onto the TOP hold.`, 'point'),
      success: L(isFinalMatch ? 'Hold it… hold it…' : 'One hand on TOP…', 'cheer'),
      pos,
    };
  }
  return {
    instruct: L(`${cap} next. Move it onto the glowing hold.`, 'point'),
    nudge: L(`${cap} ring onto the pulsing hold.`, 'point'),
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
  concept: L('Stretched like this, tension climbs. Past the notch on the gauge, you start shaking.', 'think'),
  pump: L('Shaking fills your pump bar. Full pump means you fall. So don’t hang around.', 'warn'),
  calmInstruct: L('Now bring your right foot up, under that hand.', 'point'),
  calmSuccess: L('Solid. Good feet fix almost everything.', 'cheer'),
} as const;

// ───────────────────────────── mistakes ─────────────────────────────

export type MistakeKind = 'wrong' | 'short' | 'return' | 'smear' | 'blocked' | 'struggle' | 'off-top';

export const MISTAKES: Record<MistakeKind, readonly Line[]> = {
  wrong: [L('Close! Wrong hold though. Aim for the pulsing ring.', 'think'), L('Not that one. The glowing hold, please.', 'think')],
  short: [L('Drag it all the way to the glowing hold.', 'think'), L('Further! Right onto the pulsing hold.', 'think')],
  return: [L('Let go right on the hold. Wait for the ring to light up.', 'think'), L('Missed! Release when the ring turns green.', 'think')],
  smear: [L('That’s a smear: rubber on blank wall. Handy, but use the hold.', 'think'), L('Smearing works, but this time, the glowing foothold.', 'think')],
  blocked: [L('Not that one yet. Move the glowing ring.', 'think'), L('One limb at a time. Just the glowing one for now.', 'think')],
  struggle: [L('Tip: drag right onto the ring and hold still. Let go when it turns green.', 'think')],
  'off-top': [L('Both hands on TOP, and keep them there a moment.', 'warn')],
};

export const DRAG_TIPS = {
  firstDrag: L('Aim for the ring. Green means a good grip.', 'point'),
  letGo: L('That’s the one. Let go!', 'cheer'),
  stretch: L('Full stretch! Keep holding. Your body leans into the reach.', 'point'),
} as const;

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
  L('SENT! Your first CHIRAL problem. I’d high-five you, but… hooves.', 'cheer'),
  L('Out there, problems are random. Shake too long or rush it, and you fall.', 'warn'),
  L('Send as many as you can without falling. That’s your score. Hopp, just go up!', 'point'),
];

/** Reading time for a line (s): enough to read it once at a relaxed pace. */
export function readTime(text: string, min = 1.6, max = 5.5): number {
  const words = text.trim().split(/\s+/).length;
  return Math.min(max, Math.max(min, 1.0 + words * 0.24));
}

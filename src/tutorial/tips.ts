// Steini's climbing tips: short, genuinely useful technique advice in the voice of the CHIRAL HQ
// head setter. Shown on the route preview, after falls (results screen) and on loading beats.
//
//   TIPS            every tip (string[], stable order)
//   randomTip(seed) one tip; deterministic for a given seed, random without one
//   tipFor(reason)  a tip that fits the way the player just fell (optional extra)

import type { FallReason } from '../core/contracts';

type Topic = 'feet' | 'hips' | 'arms' | 'pump' | 'balance' | 'reading' | 'holds' | 'mind' | 'rope' | 'top';

interface Tip {
  text: string;
  topics: readonly Topic[];
}

const T = (text: string, ...topics: Topic[]): Tip => ({ text, topics });

const TIP_DEFS: readonly Tip[] = [
  T('Hips close to the wall. Your forearms will thank you.', 'hips', 'pump'),
  T('Feet first, hands second. Always.', 'feet'),
  T('Shaking? Shift your hips over your feet before you move.', 'hips', 'balance'),
  T('Straight arms rest, bent arms burn. Hang like wet laundry.', 'arms', 'pump'),
  T('Look at the foothold until your foot is on it. Then look once more.', 'feet'),
  T('Legs push, arms steer. Your thighs are bigger than your biceps.', 'feet', 'arms'),
  T('Read the whole problem before you touch it. The TOP hold can wait.', 'reading'),
  T('Pumped? Find a jug, drop your hips and shake out one arm at a time.', 'pump'),
  T('Slopers only stick with your body right below them. Get under it.', 'holds'),
  T('Crimps hate steep walls. Keep crimp moves short and decisive.', 'holds', 'pump'),
  T('Sidepulls work when you lean the other way. Trust the opposition.', 'holds', 'balance'),
  T('Undercling? Feet high, hips in, then stand up into it.', 'holds', 'hips'),
  T('Barn-dooring? Put a foot out wide to stop the swing.', 'balance', 'feet'),
  T('Three limbs on, one moving. Count them before every move.', 'balance'),
  T('Small steps beat big lunges. An ibex never rushes. Well, rarely.', 'feet', 'balance'),
  T('No foothold? Smear. Rubber on blank wall sticks better than you think.', 'feet'),
  T('Match the TOP hold and keep it. Celebrating early does not count.', 'top'),
  T('Bad hold? Move or rest, never both. Hesitating costs pump.', 'pump', 'mind'),
  T('If a hold feels terrible, fix your body position before you blame the hold.', 'holds', 'hips'),
  T('On overhangs, pull with your toes or your feet will cut loose.', 'feet', 'balance'),
  T('Breathe out on the hard move. Grunting is optional but encouraged.', 'mind'),
  T('Before a long reach, step your feet up. That height is free.', 'feet', 'reading'),
  T('Matching on a small hold? Leave space for the second hand.', 'holds', 'top'),
  T('Hopp! Decide, then commit. Half a move is the hardest move.', 'mind'),
  T('Don’t over-grip. Hold just hard enough not to slip.', 'arms', 'pump'),
  T('Allez! Every fall is beta. Now you know what doesn’t work.', 'mind'),
  T('Rest where your feet are good. That is usually lower than you’d like.', 'pump', 'feet'),
  T('Turn your hip into the wall on steep ground. You reach further, for free.', 'hips'),
  T('Weight over the foot you want to stand on. Then stand.', 'balance', 'hips'),
  T('Tension gauge past the notch? Stop. Fix your feet. Then move.', 'balance', 'pump'),
  T('On slabs, trust your feet and keep your heels low.', 'feet', 'balance'),
  T('Chalk up, calm down, send.', 'mind'),
  T('Stuck? Try the move with the other hand first. Beta is a puzzle.', 'reading', 'mind'),
  T('The crash pad is soft. Your ego is not. Fall anyway, learn faster.', 'mind'),
  T('Sit your hips below a jug before a big move. Load the spring.', 'hips', 'arms'),
  T('Clip from a good hold at waist height, not at full stretch.', 'rope'),
  T('Above your last clip, a fall gets twice as long. Clip early.', 'rope'),
  T('Clipping takes a hand. Feet solid first, then reach for the draw.', 'rope', 'feet'),
  T('Grüezi from the mats: same move, less effort. Hips in, arms long.', 'hips', 'arms'),
  T('Your feet carry the weight only when your body is above them.', 'feet', 'balance'),
] as const;

/** Every tip, in a stable order. */
export const TIPS: readonly string[] = TIP_DEFS.map((t) => t.text);

/** Integer hash for small seeds (so seeds 1, 2, 3 don't give neighbouring tips). */
function mix(seed: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function pickFrom(list: readonly Tip[], seed: number | undefined): string {
  const i = seed === undefined || !Number.isFinite(seed) ? Math.floor(Math.random() * list.length) : mix(Math.floor(seed)) % list.length;
  return list[i].text;
}

const BOULDER_TIPS: readonly Tip[] = TIP_DEFS.filter((t) => !t.topics.includes('rope'));

/**
 * One of Steini's tips. Same seed → same tip on every device; no seed → random.
 * `mode: 'boulder'` leaves out the lead-climbing tips (no rope on a boulder).
 */
export function randomTip(seed?: number, mode?: 'boulder' | 'rope'): string {
  return pickFrom(mode === 'boulder' ? BOULDER_TIPS : TIP_DEFS, seed);
}

const FALL_TOPICS: Record<FallReason, readonly Topic[]> = {
  pump: ['pump', 'arms'],
  slip: ['hips', 'holds', 'balance'],
  'barn-door': ['balance'],
  'no-hands': ['balance', 'mind'],
  'no-contact': ['feet', 'balance'],
  forced: ['mind'],
};

/** Optional extra: a tip that fits how the climber fell (`mode: 'rope'` adds lead tips). */
export function tipFor(reason: FallReason, seed?: number, mode: 'boulder' | 'rope' = 'boulder'): string {
  const topics = FALL_TOPICS[reason] ?? FALL_TOPICS.forced;
  const list = TIP_DEFS.filter((t) => {
    const rope = t.topics.includes('rope');
    if (rope) return mode === 'rope';
    return t.topics.some((x) => topics.includes(x));
  });
  return pickFrom(list.length ? list : TIP_DEFS, seed);
}

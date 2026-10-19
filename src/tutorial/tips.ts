// Steini's climbing tips: short, genuinely useful technique advice in the voice of the CHIRAL SPORTS
// instructor. Shown on the route preview, after falls (results screen) and on loading beats.
//
//   TIPS                  every tip (string[], stable order)
//   randomTip(seed, mode, wall)  one tip; deterministic for a given seed, random without one; with a
//                         wall, only tips that fit it (no overhang advice on a slab, and so on)
//   tipFor(reason)        a tip that fits the way the player just fell (optional extra)

import type { FallReason } from '../core/contracts';
import type { BoulderDef } from '../core/types';

/**
 * Topics. 'steep' / 'slab' / 'dyno' are TERRAIN topics: such a tip only fits a wall that has that
 * terrain (an overhanging panel, a slab panel, a dyno problem), see wallTerrain().
 */
type Topic = 'feet' | 'hips' | 'arms' | 'pump' | 'balance' | 'reading' | 'holds' | 'mind' | 'rope' | 'top' | 'steep' | 'slab' | 'dyno';
type Terrain = 'steep' | 'slab' | 'dyno';
const TERRAIN: readonly Terrain[] = ['steep', 'slab', 'dyno'];

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
  T('Lost the line mid-climb? Tap LOOK to see the whole problem again.', 'reading'),
  T('Pumped? Find a jug, drop your hips and shake out one arm at a time.', 'pump'),
  T('Slopers only stick with your body right below them. Get under it.', 'holds'),
  T('Crimps hate steep walls. Keep crimp moves short and decisive.', 'holds', 'pump', 'steep'),
  T('Sidepulls work when you lean the other way. Trust the opposition.', 'holds', 'balance'),
  T('Undercling? Feet high, hips in, then stand up into it.', 'holds', 'hips'),
  T('Barn-dooring? Put a foot out wide to stop the swing.', 'balance', 'feet'),
  T('Three limbs on, one moving. Count them before every move.', 'balance'),
  T('Small steps beat big lunges. An ibex never rushes. Well, rarely.', 'feet', 'balance'),
  T('No foothold? Smear. Rubber on blank wall sticks better than you think.', 'feet'),
  T('Match the TOP hold and keep it. Celebrating early does not count.', 'top'),
  T('Bad hold? Don’t hover. Move on or find a rest. Dithering costs pump.', 'pump', 'mind'),
  T('If a hold feels terrible, fix your body position before you blame the hold.', 'holds', 'hips'),
  T('On overhangs, pull with your toes or your feet will cut loose.', 'feet', 'balance', 'steep'),
  T('Breathe out on the hard move. Grunting is optional but encouraged.', 'mind'),
  T('Before a long reach, step your feet up. That height is free.', 'feet', 'reading'),
  T('Matching on a small hold? Leave space for the second hand.', 'holds', 'top'),
  T('Hopp! Decide, then commit. Half a move is the hardest move.', 'mind'),
  T('Don’t over-grip. Hold just hard enough not to slip.', 'arms', 'pump'),
  T('Allez! Every fall is beta. Now you know what doesn’t work.', 'mind'),
  T('Rest where your feet are good. That is usually lower than you’d like.', 'pump', 'feet'),
  T('Turn your hip into the wall on steep ground. You reach further, for free.', 'hips', 'steep'),
  T('Weight over the foot you want to stand on. Then stand.', 'balance', 'hips'),
  T('Tension gauge past the notch? Stop. Fix your feet. Then move.', 'balance', 'pump'),
  T('On slabs, trust your feet and keep your heels low.', 'feet', 'balance', 'slab'),
  T('Chalk up, calm down, send.', 'mind'),
  T('Stuck? Try the move with the other hand first. Beta is a puzzle.', 'reading', 'mind'),
  T('Out of ideas? HINT shows my next move, but every hint costs points.', 'reading', 'mind'),
  T('The crash pad is soft. Your ego is not. Fall anyway, learn faster.', 'mind'),
  T('Sit your hips below a jug before a big move. Load the spring.', 'hips', 'arms'),
  T('Clip from a good hold at waist height, not at full stretch.', 'rope'),
  T('Above your last clip, a fall gets twice as long. Clip early.', 'rope'),
  T('Clipping takes a hand. Feet solid first, then reach for the draw.', 'rope', 'feet'),
  T('Grüezi from the mats: same move, less effort. Hips in, arms long.', 'hips', 'arms'),
  T('Your feet carry the weight only when your body is above them.', 'feet', 'balance'),
  // Phase B moves: chalk, shake-outs, hooks, flags, throws. Chalk matters on lead only (a boulder is
  // too short for hands to sweat noticeably), so the chalk tips are lead tips.
  T('Sweaty fingers on a long route? Drag a hand down to your hip to chalk up.', 'rope', 'pump'),
  T('Drop a hand down by your side to shake it out. One arm at a time.', 'pump', 'arms'),
  T('Chalk before the crux, not in the middle of it.', 'rope', 'pump'),
  T('Steep wall? Put a foot high out to the side and hook your heel.', 'feet', 'steep'),
  T('No foothold for the swing? Flag a leg out wide as a counterweight.', 'balance', 'feet'),
  T('Out of reach? Flick the hand toward the hold to throw for it.', 'dyno', 'mind'),
  T('Dyno: legs drive, arms guide. Catch the hold at the top of the throw.', 'dyno', 'feet'),
  T('Slabs are a balance game. Small steps, quiet feet, hips over your toes.', 'slab', 'balance'),
  T('Roofs need tension. Keep your toes pulling or your feet will swing off.', 'steep', 'feet'),
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
const ROPE_TIPS: readonly Tip[] = TIP_DEFS.filter((t) => !t.topics.includes('top'));

/** Panels at least this steep (degrees) make a wall 'steep'; at least this far past vertical, 'slab'. */
const STEEP_DEG = 10;
const SLAB_DEG = -5;

/** The terrain a wall offers the climber: overhanging panels, slab panels, a dyno problem. */
export function wallTerrain(b: Pick<BoulderDef, 'wallAngle'> & Partial<Pick<BoulderDef, 'profile' | 'style'>>): Set<Terrain> {
  const out = new Set<Terrain>();
  const angles = b.profile && b.profile.length ? b.profile.map((p) => p.angle).filter(Number.isFinite) : [b.wallAngle];
  if (!angles.length) angles.push(b.wallAngle);
  if (angles.some((a) => a >= STEEP_DEG) || b.style === 'overhang' || b.style === 'cave') out.add('steep');
  if (angles.some((a) => a <= SLAB_DEG) || b.style === 'slab') out.add('slab');
  if (b.style === 'dyno') out.add('dyno');
  return out;
}

/** True when the tip fits the wall: every terrain topic it has is on this wall. */
function fits(t: Tip, terrain: Set<Terrain> | null): boolean {
  if (!terrain) return true;
  for (const x of TERRAIN) if (t.topics.includes(x) && !terrain.has(x)) return false;
  return true;
}

/**
 * One of Steini's tips. Same seed → same tip on every device; no seed → random.
 * `mode` keeps the tip relevant: 'boulder' leaves out the lead-climbing tips, 'rope' the tips
 * about matching the TOP hold (a lead route tops out at the anchor). `wall` keeps it true to the
 * wall: no overhang tips on a vertical wall or a slab, no slab tips on an overhang, dyno tips only on
 * a dyno problem (BoulderDef.style / profile / wallAngle). Without a wall the terrain tips are left out
 * too (the tip has to be true wherever it shows).
 */
export function randomTip(seed?: number, mode?: 'boulder' | 'rope', wall?: Pick<BoulderDef, 'wallAngle'> & Partial<Pick<BoulderDef, 'profile' | 'style'>>): string {
  const base = mode === 'boulder' ? BOULDER_TIPS : mode === 'rope' ? ROPE_TIPS : TIP_DEFS;
  const terrain = wall ? wallTerrain(wall) : new Set<Terrain>();
  const list = base.filter((t) => fits(t, terrain));
  return pickFrom(list.length ? list : base, seed);
}

const FALL_TOPICS: Record<FallReason, readonly Topic[]> = {
  pump: ['pump', 'arms'],
  slip: ['hips', 'holds', 'balance'],
  'barn-door': ['balance'],
  'no-hands': ['balance', 'mind'],
  'no-contact': ['feet', 'balance'],
  forced: ['mind'],
};

/**
 * Optional extra: a tip that fits how the climber fell (`mode: 'rope'` adds lead tips). With `wall`,
 * only tips true to that wall (see randomTip); without one, no terrain-specific tips.
 */
export function tipFor(
  reason: FallReason,
  seed?: number,
  mode: 'boulder' | 'rope' = 'boulder',
  wall?: Pick<BoulderDef, 'wallAngle'> & Partial<Pick<BoulderDef, 'profile' | 'style'>>,
): string {
  const topics = FALL_TOPICS[reason] ?? FALL_TOPICS.forced;
  const terrain = wall ? wallTerrain(wall) : new Set<Terrain>();
  const list = TIP_DEFS.filter((t) => {
    if (!fits(t, terrain)) return false;
    const rope = t.topics.includes('rope');
    if (rope) return mode === 'rope';
    return t.topics.some((x) => topics.includes(x));
  });
  return pickFrom(list.length ? list : TIP_DEFS.filter((t) => fits(t, terrain)), seed);
}

// Procedural animal heads. Contract: createHead(id) → THREE.Group with origin = neck joint,
// +Y up, facing +Z, oversized ×1.15 for readability on a phone. Each head is ≈3 draw calls
// (fur with blinking lids, keratin, eyes).

import * as THREE from 'three';
import type { HeadId } from '../../core/types';
import { buildIbex } from './ibex';
import { buildChamois } from './chamois';
import { buildGoat } from './goat';
import { buildMarmot } from './marmot';
import { buildSnowLeopard } from './snowleopard';
import { buildEagle } from './eagle';
import { buildLynx } from './lynx';
import { buildRam } from './ram';
import { buildVulture } from './vulture';

export { HEAD_SCALE } from './parts';

const BUILDERS: Record<HeadId, () => THREE.Group> = {
  ibex: () => buildIbex(),
  chamois: buildChamois,
  goat: buildGoat,
  marmot: buildMarmot,
  snowleopard: buildSnowLeopard,
  eagle: buildEagle,
  lynx: buildLynx,
  ram: buildRam,
  vulture: buildVulture,
  // TEMPORARY: replaced by the real human head (with CHIRAL SPORTS cap) in Phase A.
  human: () => buildIbex(),
};

export function createHead(id: HeadId): THREE.Group {
  const build = BUILDERS[id] ?? BUILDERS.ibex;
  const g = build();
  g.userData.headId = id;
  return g;
}

/** Steini's ibex head (slightly grander horns). */
export function createGuideHead(): THREE.Group {
  const g = buildIbex({ horn: 1.06 });
  g.userData.headId = 'ibex';
  return g;
}

/** The blink morph weights of a head (cache it; null if the head has no lids). */
export function headBlinkWeights(head: THREE.Object3D): number[] | null {
  const fur = head.getObjectByName('fur') as THREE.Mesh | undefined;
  const inf = fur?.morphTargetInfluences;
  return inf && inf.length ? inf : null;
}

/** 0 = eyes open (default expression), 1 = closed. */
export function setHeadBlink(head: THREE.Object3D | number[] | null, amount: number): void {
  const inf = Array.isArray(head) ? head : head ? headBlinkWeights(head) : null;
  if (inf) inf[0] = amount < 0 ? 0 : amount > 1 ? 1 : amount;
}

/** Dispose every geometry + material (and owned textures except shared caches) of a head. */
export function disposeHead(head: THREE.Object3D): void {
  head.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat.dispose();
  });
}

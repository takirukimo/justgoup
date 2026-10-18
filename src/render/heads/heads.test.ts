// Geometry checks for the human head (pure math: no canvas / WebGL needed).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EYE_C, EYE_R, crownPoint, humanSdf } from './human';

describe('human head', () => {
  const { sdf } = humanSdf();

  it('the CHIRAL SPORTS cap crown clears the head and hair everywhere', () => {
    const p = new THREE.Vector3();
    let worst = Infinity;
    for (let i = 0; i < 64; i++) {
      for (let j = 1; j <= 20; j++) {
        crownPoint(i / 64, j / 20, p);
        worst = Math.min(worst, sdf(p.x, p.y, p.z));
      }
    }
    // at least 2 mm of clearance over the skull, hair and forehead
    expect(worst).toBeGreaterThan(0.002);
  });

  it('the crown rises to a single button at the top', () => {
    const a = crownPoint(0, 1, new THREE.Vector3());
    const b = crownPoint(0.5, 1, new THREE.Vector3());
    expect(a.distanceTo(b)).toBeLessThan(0.004);
  });

  it('the almond eye openings expose the front of each eyeball', () => {
    for (const side of [1, -1]) {
      const front = [EYE_C[0] * side, EYE_C[1], EYE_C[2] + EYE_R];
      expect(sdf(front[0], front[1], front[2])).toBeGreaterThan(0);
    }
  });
});

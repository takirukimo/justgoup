import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bakeCurvature } from './curvature';
import { holdGeometry } from './holds';

const mean = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
};

describe('bakeCurvature', () => {
  it('reads 1/R on a sphere (convex = positive), welded across the UV seam', () => {
    for (const r of [0.01, 0.03, 0.1]) {
      const g = new THREE.SphereGeometry(r, 48, 32);
      const a = bakeCurvature(g, 1).array as Float32Array;
      // κ = 1/R (away from the poles, where the fan is degenerate)
      const pos = g.getAttribute('position');
      const vals: number[] = [];
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i)) < r * 0.6) vals.push(a[i]);
      // clamped at 1 with scale 1: compare on the unclamped scale instead
      const g2 = new THREE.SphereGeometry(r, 48, 32);
      const b = bakeCurvature(g2, r * 0.5).array as Float32Array;
      const v2: number[] = [];
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i)) < r * 0.6) v2.push(b[i]);
      expect(mean(v2)).toBeCloseTo(0.5, 1);
      expect(vals.length).toBeGreaterThan(100);
    }
  });

  it('is zero on a flat plane and negative inside a bowl', () => {
    const plane = new THREE.PlaneGeometry(1, 1, 8, 8);
    const p = bakeCurvature(plane).array as Float32Array;
    expect(Math.max(...Array.from(p).map(Math.abs))).toBeLessThan(1e-6);
    // the inside of a sphere (normals flipped) is concave
    const bowl = new THREE.SphereGeometry(0.05, 24, 16);
    const nr = bowl.getAttribute('normal');
    for (let i = 0; i < nr.count; i++) nr.setXYZ(i, -nr.getX(i), -nr.getY(i), -nr.getZ(i));
    const c = bakeCurvature(bowl).array as Float32Array;
    expect(mean(c)).toBeLessThan(-0.2);
  });

  it('a sharp convex edge reads as a ridge from both faces (hard-edged box)', () => {
    const box = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const a = bakeCurvature(box).array as Float32Array;
    // every box corner vertex sits on convex edges
    expect(Math.min(...Array.from(a))).toBeGreaterThan(0.05);
  });

  it('every hold geometry carries it: thin crimp lips saturate, jug bodies stay moderate', () => {
    const crimp = holdGeometry('crimp', 3, 0.05, 0, { shape: 'micro', edgeDepthMm: 6 }).geo;
    const jug = holdGeometry('jug', 4, 0.1).geo;
    for (const g of [crimp, jug]) {
      const a = g.getAttribute('aCurv');
      expect(a).toBeTruthy();
      expect(a.count).toBe(g.getAttribute('position').count);
    }
    const ca = crimp.getAttribute('aCurv').array as Float32Array;
    const ja = jug.getAttribute('aCurv').array as Float32Array;
    const frac = (arr: Float32Array, t: number) => Array.from(arr).filter((v) => v > t).length / arr.length;
    // a micro crimp is mostly tight radii; a big jug is mostly broad surfaces
    expect(frac(ca, 0.6)).toBeGreaterThan(frac(ja, 0.6));
    expect(mean(ja)).toBeGreaterThan(0);
  });
});

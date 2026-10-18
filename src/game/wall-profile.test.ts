// Multi-angle wall math (Phase B1): the surface ↔ local-3D mapping the sim, the planner, the generator and
// the renderer share. Round trips, continuity across folds, frames, and the fold-aware reach metric.

import { describe, expect, it } from 'vitest';
import {
  angleAt,
  FOLD,
  local3DToSurface,
  makeProfile,
  normalAt,
  panelAt,
  panelSpans,
  panelsFromLengths,
  PROFILE_PRESETS,
  profileOf,
  reachScale,
  smoothAngleAt,
  steepestAngle,
  surfaceDistance3D,
  surfaceToLocal3D,
  tangentAt,
  wallOverhang,
  wallTopHeight,
  type ProfilePresetId,
} from './wall-profile';

const DEG = Math.PI / 180;
const presets = Object.keys(PROFILE_PRESETS) as ProfilePresetId[];
const build = (id: ProfilePresetId) => {
  const { panels, length } = panelsFromLengths(PROFILE_PRESETS[id]);
  return makeProfile(panels, steepestAngle(panels), length);
};

describe('wall profile — normalisation', () => {
  it('sorts, clamps, merges equal angles, starts at 0 and drops panels past the end', () => {
    const p = makeProfile(
      [
        { y0: 2, angle: 40 },
        { y0: 0.2, angle: 0 },
        { y0: 1, angle: 0 },
        { y0: 3, angle: 120 },
        { y0: 9, angle: 10 },
      ],
      0,
      5,
    );
    expect(p.panels.map((q) => [q.y0, q.angle])).toEqual([
      [0, 0],
      [2, 40],
      [3, FOLD.maxAngle],
    ]);
    expect(p.convex[1]).toBe(0);
    expect(p.flat).toBe(false);
    expect(makeProfile(null, 25).flat).toBe(true);
    expect(makeProfile([], 25).panels[0].angle).toBe(25);
    // a profile with one angle is not a folded wall
    expect(profileOf({ wallAngle: 20, height: 4.5, profile: [{ y0: 0, angle: 20 }, { y0: 2, angle: 20 }] })).toBeNull();
    expect(profileOf({ wallAngle: 20, height: 4.5 })).toBeNull();
  });

  it('presets match the research table (§3.2): panel angles, steepest angle, surface length', () => {
    const cave = build('CAVE');
    expect(cave.panels.map((q) => q.angle)).toEqual([0, 30, 85, 20]);
    expect(cave.length).toBeCloseTo(4.7, 6);
    expect(steepestAngle(cave.panels)).toBe(85);
    expect(angleAt(cave, 0.1)).toBe(0);
    expect(angleAt(cave, 1)).toBe(30);
    expect(panelAt(cave, 3).angle).toBe(85);
    expect(angleAt(cave, 4.5)).toBe(20);
    // a cave is low: its top (the lip) is only ≈2.4 m above the floor
    expect(wallTopHeight(cave)).toBeGreaterThan(2.2);
    expect(wallTopHeight(cave)).toBeLessThan(2.6);
    const lead = build('LEAD_TOWER');
    expect(lead.length).toBeCloseTo(17.5, 6);
    expect(wallTopHeight(lead)).toBeCloseTo(14.8, 0);
    expect(wallOverhang(lead)).toBeCloseTo(8.1, 0);
    // 4.5 m tall at 40° needs ≈5.9 m of panel (research §3.1)
    const b40 = makeProfile([{ y0: 0, angle: 40 }], 40, 5.87);
    expect(wallTopHeight(b40)).toBeCloseTo(4.5, 1);
  });
});

describe('wall profile — surface ↔ local 3D', () => {
  it('a flat wall maps exactly like WallFrame: (x, y, d) → (x, y·cosθ − d·sinθ, y·sinθ + d·cosθ)', () => {
    for (const a of [-12, 0, 20, 45]) {
      const p = makeProfile(null, a);
      for (const [y, d] of [
        [0, 0],
        [1.3, 0.2],
        [4.1, 0.7],
      ]) {
        const q = surfaceToLocal3D(p, 0.4, y, d);
        expect(q.x).toBe(0.4);
        expect(q.y).toBeCloseTo(y * Math.cos(a * DEG) - d * Math.sin(a * DEG), 12);
        expect(q.z).toBeCloseTo(y * Math.sin(a * DEG) + d * Math.cos(a * DEG), 12);
      }
    }
  });

  // unique while the point is nearer the wall than where a concave fold's blended normals meet
  // (≈ 2·blend / Δangle: ≥ 0.6 m on every preset)
  it('round trip surface → 3D → surface on every preset (depth 0–0.45 m)', () => {
    for (const id of presets) {
      const p = build(id);
      let worst = 0;
      for (let k = 0; k <= 400; k++) {
        const y = (p.length * k) / 400;
        for (const d of [0, 0.05, 0.2, 0.32, 0.45]) {
          const q = surfaceToLocal3D(p, -0.7, y, d);
          const s = local3DToSurface(p, q.x, q.y, q.z);
          expect(s.x).toBe(-0.7);
          worst = Math.max(worst, Math.abs(s.y - y), Math.abs(s.depth - d));
        }
      }
      expect(worst, id).toBeLessThan(1e-6);
    }
  });

  it('is continuous across every fold at every depth, and unit speed along the surface itself', () => {
    const eps = 1e-5;
    for (const id of presets) {
      const p = build(id);
      for (let i = 1; i < p.n; i++) {
        const y0 = p.y0[i];
        for (const d of [0, 0.3, 0.6]) {
          for (const at of [y0, y0 - p.blend[i], y0 + p.blend[i]]) {
            const a = surfaceToLocal3D(p, 0, at - eps, d);
            const b = surfaceToLocal3D(p, 0, at + eps, d);
            const jump = Math.hypot(b.y - a.y, b.z - a.z);
            // a smooth curve: the step is ≈ 2·eps·(1 + depth·curvature), never a jump
            expect(jump, `${id} fold ${i} y=${at.toFixed(3)} d=${d}`).toBeLessThan(2 * eps * (1 + d * 4) + 1e-12);
          }
        }
        // on the surface the polyline is parametrised by arc length: |dP/dy| = 1 on both sides of a fold
        for (const at of [y0 - 0.05, y0 + 0.05]) {
          const a = surfaceToLocal3D(p, 0, at - eps, 0);
          const b = surfaceToLocal3D(p, 0, at + eps, 0);
          expect(Math.hypot(b.y - a.y, b.z - a.z) / (2 * eps)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it('normalAt / tangentAt: unit, perpendicular, sharp on the panel or blended across a fold', () => {
    const p = build('CAVE');
    for (let k = 0; k <= 100; k++) {
      const y = (p.length * k) / 100;
      for (const blended of [true, false]) {
        const n = normalAt(p, y, undefined, blended);
        const t = tangentAt(p, y, undefined, blended);
        expect(n.x).toBe(0);
        expect(Math.hypot(n.y, n.z)).toBeCloseTo(1, 12);
        expect(Math.hypot(t.y, t.z)).toBeCloseTo(1, 12);
        expect(n.y * t.y + n.z * t.z).toBeCloseTo(0, 12);
      }
      // the sharp frame is the panel's: tangent = (0, cos φ, sin φ)
      const a = angleAt(p, y) * DEG;
      const t = tangentAt(p, y, undefined, false);
      expect(t.y).toBeCloseTo(Math.cos(a), 9);
      expect(t.z).toBeCloseTo(Math.sin(a), 9);
    }
    // away from folds the blended normal is the panel's; in a band it is in between
    const mid = normalAt(p, 3.0);
    expect(mid.y).toBeCloseTo(-Math.sin(85 * DEG), 9);
    const band = smoothAngleAt(p, p.y0[2]);
    expect(band).toBeGreaterThan(30);
    expect(band).toBeLessThan(85);
    // a point off the wall sits along the blended normal
    const s = surfaceToLocal3D(p, 0, 1.2, 0);
    const o = surfaceToLocal3D(p, 0, 1.2, 0.5);
    const n = normalAt(p, 1.2);
    expect((o.y - s.y) / 0.5).toBeCloseTo(n.y, 9);
    expect((o.z - s.z) / 0.5).toBeCloseTo(n.z, 9);
  });

  it('panelSpans give mesh-ready panels that join edge to edge', () => {
    for (const id of presets) {
      const p = build(id);
      const spans = panelSpans(p);
      expect(spans.length).toBe(p.n);
      expect(spans[0].bottom).toEqual({ y: 0, z: 0 });
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].bottom.y).toBeCloseTo(spans[i - 1].top.y, 9);
        expect(spans[i].bottom.z).toBeCloseTo(spans[i - 1].top.z, 9);
        expect(spans[i].y0).toBe(spans[i - 1].y1);
      }
      expect(spans[spans.length - 1].y1).toBeCloseTo(p.length, 9);
      expect(spans[spans.length - 1].top.y).toBeCloseTo(wallTopHeight(p), 9);
    }
  });
});

describe('wall profile — reach across folds', () => {
  it('reachScale is exactly 1 on a flat wall and on one panel away from folds', () => {
    expect(reachScale(null, 0, 1, 0.3, 1.8)).toBe(1);
    expect(reachScale(makeProfile(null, 30), 0, 1, 0.3, 1.8)).toBe(1);
    const p = build('CAVE');
    expect(reachScale(p, 0, 2.6, 0.2, 3.3)).toBe(1);
  });

  it('closer into a concave corner (steep → roof), further around a convex lip (roof → lip)', () => {
    const p = build('CAVE');
    // shoulder on the 30° panel, hand into the 85° roof: the inside corner shortens the 3D distance
    const k1 = reachScale(p, 0, 1.4, 0, 2.4);
    expect(k1).toBeLessThan(0.97);
    expect(k1).toBeGreaterThanOrEqual(FOLD.minScale);
    // shoulder under the roof, hand over the lip onto the 20° panel: around the outside corner
    const k2 = reachScale(p, 0, 3.7, 0, 4.4);
    expect(k2).toBeGreaterThan(1.03);
    // the 3D distance over the lip is longer than the straight chord through the wall would be
    const a = { x: 0, y: 3.7 };
    const b = { x: 0, y: 4.4 };
    const pa = surfaceToLocal3D(p, 0, a.y, 0);
    const pb = surfaceToLocal3D(p, 0, b.y, 0);
    expect(surfaceDistance3D(p, a, 0, b, 0)).toBeGreaterThan(Math.hypot(pb.y - pa.y, pb.z - pa.z) - 1e-9);
  });
});

describe('wall profile — determinism', () => {
  it('uses no engine-dependent math (the generator makes threshold decisions with it)', () => {
    const banned = ['sin', 'cos', 'tan', 'atan', 'atan2', 'hypot', 'exp', 'pow', 'log'] as const;
    const m = Math as unknown as Record<string, unknown>;
    const saved = banned.map((k) => m[k]);
    for (const k of banned)
      m[k] = () => {
        throw new Error(`Math.${k} used`);
      };
    try {
      for (const id of presets) {
        const { panels, length } = panelsFromLengths(PROFILE_PRESETS[id]);
        const p = makeProfile(panels, 0, length);
        const q = surfaceToLocal3D(p, 0, length * 0.6, 0.3);
        local3DToSurface(p, q.x, q.y, q.z);
        reachScale(p, 0, length * 0.3, 0.2, length * 0.55);
        smoothAngleAt(p, length * 0.5);
        normalAt(p, length * 0.5);
        tangentAt(p, length * 0.5, undefined, false);
        wallTopHeight(p);
      }
    } finally {
      banned.forEach((k, i) => (m[k] = saved[i]));
    }
  });
});

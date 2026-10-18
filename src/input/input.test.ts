import { describe, expect, it } from 'vitest';
import { Homography } from './homography';
import { HandleLayout } from './layout';

describe('Homography', () => {
  // a perspective-ish map: wall metres → screen px
  const M = [180, 22, 195, -14, -240, 700, 0.012, -0.035, 1];
  const project = (x: number, y: number) => {
    const w = M[6] * x + M[7] * y + M[8];
    return { x: (M[0] * x + M[1] * y + M[2]) / w, y: (M[3] * x + M[4] * y + M[5]) / w };
  };

  it('recovers an exact plane projection from four correspondences', () => {
    const src = [-1, 0.5, 1, 0.5, 1, 2.5, -1, 2.5];
    const dst: number[] = [];
    for (let i = 0; i < 4; i++) {
      const p = project(src[i * 2], src[i * 2 + 1]);
      dst.push(p.x, p.y);
    }
    const h = new Homography();
    expect(h.solve(src, dst)).toBe(true);
    const out = { x: 0, y: 0 };
    for (const [x, y] of [
      [0, 1.4],
      [-2.1, 3.3],
      [1.7, 0.1],
      [0.33, 4.2],
    ]) {
      expect(h.map(x, y, out)).toBe(true);
      const e = project(x, y);
      expect(out.x).toBeCloseTo(e.x, 6);
      expect(out.y).toBeCloseTo(e.y, 6);
      // inverse maps back onto the wall
      const back = { x: 0, y: 0 };
      expect(h.unmap(out.x, out.y, back)).toBe(true);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it('rejects degenerate input', () => {
    const h = new Homography();
    expect(h.solve([0, 0, 0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6, 7, 8])).toBe(false);
    expect(h.map(1, 1, { x: 0, y: 0 })).toBe(false);
  });
});

describe('HandleLayout', () => {
  const rect = { left: 0, top: 80, right: 390, bottom: 746 };

  it('separates overlapping handles and keeps them inside the safe rect', () => {
    const lay = new HandleLayout();
    lay.setBody(0, 200, 300, 34, 1);
    lay.setBody(1, 205, 302, 34, 1);
    lay.setBody(2, 10, 760, 34, 1);
    lay.setBody(3, 380, 60, 34, 1);
    lay.solve(rect, 6, 10);
    expect(Math.hypot(lay.x[1] - lay.x[0], lay.y[1] - lay.y[0])).toBeGreaterThanOrEqual(73.5);
    for (let i = 0; i < 4; i++) {
      expect(lay.x[i]).toBeGreaterThanOrEqual(rect.left + 34 - 1e-6);
      expect(lay.x[i]).toBeLessThanOrEqual(rect.right - 34 + 1e-6);
      expect(lay.y[i]).toBeGreaterThanOrEqual(rect.top + 34 - 1e-6);
      expect(lay.y[i]).toBeLessThanOrEqual(rect.bottom - 34 + 1e-6);
    }
  });

  it('never moves a pinned handle (the one under the finger) and pushes others off obstacles', () => {
    const lay = new HandleLayout();
    lay.setBody(0, 150, 400, 38, 0); // dragged
    lay.setBody(1, 170, 410, 34, 1);
    lay.setBody(2, 300, 300, 34, 1);
    lay.addObstacle(300, 310, 30); // reticle
    lay.solve(rect, 6, 8);
    expect(lay.x[0]).toBe(150);
    expect(lay.y[0]).toBe(400);
    expect(Math.hypot(lay.x[1] - 150, lay.y[1] - 400)).toBeGreaterThanOrEqual(77.5);
    expect(Math.hypot(lay.x[2] - 300, lay.y[2] - 310)).toBeGreaterThanOrEqual(64 - 1e-6);
  });

  it('obstacles ignore bodies that opt out (the hip handle sits on the body)', () => {
    const lay = new HandleLayout();
    lay.setBody(0, 200, 400, 24, 0.12, false);
    lay.addObstacle(200, 400, 40);
    lay.solve(rect, 6, 4);
    expect(lay.x[0]).toBe(200);
    expect(lay.y[0]).toBe(400);
  });
});

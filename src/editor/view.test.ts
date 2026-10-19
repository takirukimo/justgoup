import { describe, expect, it } from 'vitest';
import { EditorView } from './view';
import type { Vec2 } from '../core/types';

const RECT = { w: 390, h: 844, top: 60, bottom: 700 };
const WALL = { width: 4.6, height: 4.5 };

/**
 * A folded-wall stand-in: the camera squares up to the panel under the view's centre, and the panel
 * above it tilts away, so the wall above the centre is foreshortened on screen (a pixel there covers
 * 1/0.6 × more wall than the straight-on model says).
 */
function foldedPicker(v: EditorView): (sx: number, sy: number) => Vec2 | null {
  return (sx, sy) => {
    const lin = v.linearToWall(sx, sy);
    const c = v.center;
    return lin.y <= c.y ? lin : { x: lin.x, y: c.y + (lin.y - c.y) / 0.6 };
  };
}

describe('EditorView', () => {
  it('keeps the flat straight-on model without a picker (zoom about a point is exact)', () => {
    const v = new EditorView();
    v.layout(RECT, WALL, true);
    const p = { x: 120, y: 300 };
    const a = v.zoomAnchor(p.x, p.y);
    expect(a.bias).toEqual({ x: 0, y: 0 });
    v.zoomAbout(a, p, v.meters * 0.5);
    const w = v.screenToWall(p.x, p.y);
    expect(w.x).toBeCloseTo(a.wall.x, 9);
    expect(w.y).toBeCloseTo(a.wall.y, 9);
  });

  it('picks through the renderer on a folded wall, falling back to the linear model off the wall', () => {
    const v = new EditorView();
    v.layout(RECT, WALL, true);
    const pick = foldedPicker(v);
    v.setPicker((sx, sy) => (sy < 10 ? null : pick(sx, sy)));
    // a point up on the foreshortened panel: the real wall point, not the linear guess
    const lin = v.linearToWall(200, 200);
    expect(lin.y).toBeGreaterThan(v.center.y);
    expect(v.screenToWall(200, 200).y).toBeCloseTo(v.center.y + (lin.y - v.center.y) / 0.6, 9);
    expect(v.screenToWall(200, 5)).toEqual(v.linearToWall(200, 5));
  });

  it('zooms about the real wall point: no jump when the pinch starts, converging under the fingers', () => {
    const v = new EditorView();
    v.layout(RECT, WALL, true);
    v.setPicker(foldedPicker(v));
    const mid = { x: RECT.w / 2 + 30, y: 330 };
    const a = v.zoomAnchor(mid.x, mid.y);
    expect(Math.hypot(a.bias.x, a.bias.y)).toBeGreaterThan(0.05);
    const c0 = { ...v.center };
    v.zoomAbout(a, mid, v.meters); // the gesture's first move: same scale
    expect(v.center.x).toBeCloseTo(c0.x, 9);
    expect(v.center.y).toBeCloseTo(c0.y, 9);
    // zoomed in, the real anchor point is right under the fingers again
    for (const m of [6, 3, 1.3]) {
      v.zoomAbout(a, mid, m);
      const under = v.screenToWall(mid.x, mid.y);
      expect(Math.hypot(under.x - a.wall.x, under.y - a.wall.y), `${m} m`).toBeLessThan(1e-9);
    }
  });
});

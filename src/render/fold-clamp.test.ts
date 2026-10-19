// Holds next to a fold (a roof lip, an inside corner) are drawn on their own panel: the footprint
// never reaches past the fold (it would hang in the air beyond a lip), the hold slides back instead.
import { describe, expect, it } from 'vitest';
import { foldClampY } from './holds';
import { WallFrame } from './wall-frame';

function frame(): WallFrame {
  const f = new WallFrame(0);
  // vertical 0..2 m, roof (80°) 2..3.2 m, headwall over the lip (15°) 3.2..4.5 m
  f.setWall({ wallAngle: 80, height: 4.5, profile: [{ y0: 0, angle: 0 }, { y0: 2, angle: 80 }, { y0: 3.2, angle: 15 }] });
  return f;
}

describe('foldClampY (render-side lip clamp)', () => {
  it('leaves holds away from folds (and every hold on a flat wall) where they are', () => {
    const f = frame();
    expect(foldClampY({ y: 1.0, angle: -Math.PI / 2 }, 0.06, 0.04, f)).toBe(1.0);
    expect(foldClampY({ y: 2.6, angle: -Math.PI / 2 }, 0.06, 0.04, f)).toBe(2.6);
    expect(foldClampY({ y: 1.98, angle: -Math.PI / 2 }, 0.06, 0.04, new WallFrame(20))).toBe(1.98);
  });

  it('slides a hold on the roof back from the lip so its footprint ends short of it', () => {
    const f = frame();
    const y = foldClampY({ y: 3.18, angle: -Math.PI / 2 }, 0.06, 0.04, f);
    expect(y).toBeLessThan(3.18);
    expect(y + 0.04).toBeLessThanOrEqual(3.2 - 0.005);
    // a rotated hold (sidepull: its long axis up the wall) needs its half length of room
    const ys = foldClampY({ y: 3.15, angle: 0 }, 0.07, 0.03, f);
    expect(ys + 0.07).toBeLessThanOrEqual(3.2 - 0.005);
  });

  it('keeps a hold over the lip (and above an inside corner) clear of the fold below it', () => {
    const f = frame();
    const y = foldClampY({ y: 3.21, angle: -Math.PI / 2 }, 0.05, 0.035, f);
    expect(y - 0.035).toBeGreaterThanOrEqual(3.2 + 0.005);
    const yc = foldClampY({ y: 2.01, angle: -Math.PI / 2 }, 0.05, 0.035, f);
    expect(yc - 0.035).toBeGreaterThanOrEqual(2 + 0.005);
  });

  it('never moves a hold more than 12 cm', () => {
    const f = frame();
    const y = foldClampY({ y: 3.199, angle: -Math.PI / 2 }, 0.3, 0.3, f);
    expect(3.199 - y).toBeLessThanOrEqual(0.12 + 1e-9);
  });
});

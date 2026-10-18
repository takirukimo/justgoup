import { describe, expect, it } from 'vitest';
import { wallLabel } from './format';

describe('wallLabel (the preview must describe the wall the player sees)', () => {
  it('calls anything within 6° of vertical VERTICAL', () => {
    for (const a of [0, 2, 5.9, -3, -5.9]) expect(wallLabel({ wallAngle: a }).text, String(a)).toBe('VERTICAL');
    expect(wallLabel({ wallAngle: 4 })).toMatchObject({ kind: 'WALL', value: 'VERTICAL', style: null });
  });

  it('labels slabs and overhangs with their angle', () => {
    expect(wallLabel({ wallAngle: -8 }).text).toBe('SLAB 8°');
    expect(wallLabel({ wallAngle: -15 })).toMatchObject({ kind: 'SLAB', value: '15°' });
    expect(wallLabel({ wallAngle: 6 }).text).toBe('OVERHANG 6°');
    expect(wallLabel({ wallAngle: 35 })).toMatchObject({ kind: 'OVERHANG', value: '35°', text: 'OVERHANG 35°' });
  });

  it('describes a multi-angle profile from its first panel to the most different one', () => {
    const mixed = wallLabel({ wallAngle: 45, profile: [{ y0: 0, angle: 0 }, { y0: 1.5, angle: 20 }, { y0: 3, angle: 45 }] });
    expect(mixed).toMatchObject({ kind: 'MIXED', value: '0°→45°', text: 'MIXED · 0°→45°' });
    expect(wallLabel({ wallAngle: 30, profile: [{ y0: 0, angle: 30 }, { y0: 2.5, angle: -5 }] }).value).toBe('30°→−5°');
    // panels that all look the same are one flat wall
    expect(wallLabel({ wallAngle: 3, profile: [{ y0: 0, angle: 0 }, { y0: 2, angle: 3 }] }).text).toBe('VERTICAL');
    expect(wallLabel({ wallAngle: 25, profile: [{ y0: 0, angle: 25 }] }).text).toBe('OVERHANG 25°');
  });

  it('adds the route style when it is a notable one', () => {
    const cave = wallLabel({ wallAngle: 60, style: 'cave', profile: [{ y0: 0, angle: 10 }, { y0: 2, angle: 60 }] });
    expect(cave.style).toBe('CAVE');
    expect(cave.text).toBe('CAVE · MIXED · 10°→60°');
    expect(wallLabel({ wallAngle: 0, style: 'traverse' }).text).toBe('TRAVERSE · VERTICAL');
    expect(wallLabel({ wallAngle: 20, style: 'dyno' }).text).toBe('DYNO · OVERHANG 20°');
    expect(wallLabel({ wallAngle: 20, style: 'overhang' }).style).toBeNull();
  });
});

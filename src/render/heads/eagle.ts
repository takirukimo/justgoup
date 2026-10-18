// Golden eagle (Steinadler): a fierce hooked beak with a yellow cere and gape, a heavy brow ridge
// shading golden eyes, dark brown face feathers and layered golden hackles on the nape.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { ellipsoid, lin, mirrorX, mixRGB, smax, smin, sstep, type RGB } from './geo';
import { HeadKit, addBeak, addFeatherRuff, addNeck, addSkull } from './parts';

export function buildEagle(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'eagle')!;
  const brown = lin(def.colors.base);
  const gold = lin(def.colors.secondary);
  const yellow = lin(def.colors.accent);
  const kit = new HeadKit();

  const skull = ellipsoid([0, 0.214, -0.012], [0.066, 0.066, 0.076]);
  const face = ellipsoid([0, 0.2, 0.046], [0.05, 0.05, 0.052]);
  const cheek = mirrorX(ellipsoid([0.04, 0.188, 0.04], [0.03, 0.036, 0.04]));
  const browR = mirrorX(ellipsoid([0.034, 0.238, 0.062], [0.034, 0.013, 0.034], [0.25, 0.3, 0.2]));
  const throat = ellipsoid([0, 0.166, 0.03], [0.04, 0.034, 0.05]);
  const eyeC = [0.039, 0.214, 0.07];
  const sdf = (x: number, y: number, z: number) => {
    let d = skull(x, y, z);
    d = smin(d, face(x, y, z), 0.035);
    d = smin(d, cheek(x, y, z), 0.025);
    d = smin(d, browR(x, y, z), 0.02);
    d = smin(d, throat(x, y, z), 0.03);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.0178), 0.009);
    return d;
  };
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.21, -0.06],
    b: [0, 0.2, 0.07],
    rows: 50,
    cols: 44,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // golden crown + nape, dark brown face; yellow gape at the mouth corners
      const nape = sstep(0.0, -0.06, p.z) * sstep(0.17, 0.24, p.y) + sstep(0.235, 0.27, p.y) * 0.8;
      mixRGB(brown, gold, Math.min(1, nape), tmp);
      const gape = sstep(0.008, 0.0, Math.abs(p.y - 0.188 + (p.z - 0.07) * 0.2)) * sstep(0.03, 0.04, ax) * sstep(0.04, 0.075, p.z);
      mixRGB(tmp, yellow, gape, out.color);
      out.aux[2] = 0.75;
    },
  });
  addNeck(kit, { top: [0, 0.18, -0.02], r0: 0.056, r1: 0.054, color: def.colors.base });
  // hooked beak: cere (yellow) → blue-grey → black hook
  const cBase = lin('#5A6068');
  const cTip = lin('#17181B');
  addBeak(kit, {
    ctrl: [
      [0, 0.207, 0.074],
      [0, 0.206, 0.112],
      [0, 0.198, 0.146],
      [0, 0.182, 0.17],
      [0, 0.162, 0.176],
      [0, 0.15, 0.166],
    ],
    width: (t) => 0.019 * (1 - t * 0.85) + 0.0015,
    height: (t) => 0.024 * (1 - t * 0.8) + 0.002,
    color: (t, out) => {
      if (t < 0.18) mixRGB(yellow, cBase, sstep(0.13, 0.18, t), out);
      else mixRGB(cBase, cTip, sstep(0.25, 0.9, t), out);
    },
    gloss: (t) => 0.35 + 0.45 * t,
  });
  // lower mandible
  addBeak(kit, {
    ctrl: [
      [0, 0.186, 0.074],
      [0, 0.183, 0.11],
      [0, 0.178, 0.142],
    ],
    width: (t) => 0.014 * (1 - t * 0.6),
    height: (t) => 0.009 * (1 - t * 0.5),
    color: (t, out) => mixRGB(yellow, lin('#8A7A50'), sstep(0.1, 0.6, t), out),
    gloss: () => 0.4,
  });
  // layered golden hackles on the nape and neck
  addFeatherRuff(kit, {
    y0: 0.215,
    y1: 0.07,
    rows: 5,
    perRow: 14,
    arc: Math.PI * 1.55,
    zOffset: -0.006,
    radius: (y) => (y > 0.18 ? 0.062 - (0.215 - y) * 0.2 : 0.056),
    length: 0.046,
    width: 0.03,
    color: (row) => (row < 3 ? [def.colors.secondary, '#E8C47A'] : ['#9A6E3A', '#5E4024']),
  });
  kit.addEyes({
    center: [0.039, 0.214, 0.07],
    radius: 0.0168,
    gaze: [0.45, 0.02, 0.89],
    style: { iris: '#E8A417', ring: '#8A5410', pupil: 'round', surround: '#2A1C10', irisR: 0.46 },
    lids: { upper: 10, lower: -32, frown: 12, color: def.colors.base, rim: '#1E140C' },
  });
  return kit.build('eagle', { sheen: '#8A6A44', roughness: 0.82 }, { roughness: 0.32, clearcoat: 0.6 });
}

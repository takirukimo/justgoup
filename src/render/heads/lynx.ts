// Lynx (Luchs): tawny cat with tall black ear tufts, a long barred facial ruff, cream muzzle,
// dark spots, golden eyes and a dark streak from each eye corner.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { createPatternTexture } from '../materials';
import { lin, mixRGB, sstep, type RGB } from './geo';
import { HeadKit, addEars, addLock, addNeck, addSkull, golden, scatterLocks } from './parts';
import { catSdf } from './snowleopard';

export function buildLynx(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'lynx')!;
  const base = lin(def.colors.base);
  const cream = lin(def.colors.secondary);
  const black = lin(def.colors.accent);
  const noseC = lin('#8A5848');
  const kit = new HeadKit();
  const MZ = 0.092;
  const sdf = catSdf({ muzzleZ: MZ, cheekW: 0.04, brow: 1.3 });
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.2, -0.05],
    b: [0, 0.17, 0.104],
    rows: 52,
    cols: 46,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      const muzzleK = sstep(0.074, 0.104, p.z) * sstep(0.2, 0.175, p.y);
      const under = sstep(-0.2, -0.7, n.y) * sstep(0.19, 0.15, p.y);
      mixRGB(base, cream, Math.max(muzzleK, under) * 0.92, tmp);
      // pale eye rings
      const eyeD = Math.hypot(ax - 0.04, p.y - 0.207, p.z - 0.08);
      mixRGB(tmp, cream, sstep(0.034, 0.026, eyeD) * 0.75, tmp);
      // dark streak from the outer eye corner back over the cheek
      const streak = sstep(0.006, 0.0, Math.abs(p.y - (0.2 - (0.06 - p.z) * 0.25))) * sstep(0.05, 0.06, ax) * sstep(0.075, 0.03, p.z);
      mixRGB(tmp, black, streak * 0.85, tmp);
      // forehead lines
      const fl = sstep(0.003, 0.0, Math.abs(ax - 0.012)) * sstep(0.235, 0.26, p.y) * sstep(0.0, 0.05, p.z);
      mixRGB(tmp, black, fl * 0.6, tmp);
      const nk = sstep(MZ + 0.03, MZ + 0.044, p.z) * sstep(0.174, 0.182, p.y) * sstep(0.02, 0.008, ax);
      mixRGB(tmp, noseC, nk, tmp);
      mixRGB(tmp, black, sstep(0.004, 0.0, Math.abs(p.y - 0.149)) * sstep(MZ, MZ + 0.03, p.z) * 0.85, out.color);
      out.aux[1] = nk * 0.6;
      out.aux[2] = 1 - nk;
      out.aux[3] = (1 - muzzleK) * (1 - under) * sstep(0.03, 0.05, eyeD) * 0.85;
    },
  });
  addNeck(kit, {
    top: [0, 0.168, -0.02],
    r0: 0.056,
    r1: 0.062,
    color: def.colors.base,
    paint: (_p, n, out) => {
      mixRGB(base, cream, sstep(0.3, 0.9, n.z) * 0.85, out.color);
      out.aux[3] = 0.8 * (1 - sstep(0.2, 0.7, n.z));
    },
  });
  addEars(kit, {
    base: [0.052, 0.262, -0.014],
    dir: [0.38, 0.92, -0.12],
    open: [0.25, 0.0, 1],
    length: 0.068,
    width: 0.042,
    cup: 0.7,
    point: 0.95,
    outer: '#3A2A1E',
    inner: '#EADBC4',
    rim: '#1F1712',
    tuft: { length: 0.05, color: def.colors.accent },
  });
  // the facial ruff: long barred sideburns hanging from the cheeks
  scatterLocks(kit, sdf, {
    center: [0, 0.17, 0.0],
    count: 84,
    seed: 11,
    sink: 0.007,
    mask: (p) => sstep(0.05, 0.078, Math.abs(p.x)) * sstep(0.2, 0.14, p.y) * sstep(0.085, 0.02, p.z),
    lock: (p, n, i) => {
      const barred = i % 4 === 1 || i % 7 === 3;
      return {
        base: [p.x, p.y, p.z],
        dir: [n.x * 0.75, -1, n.z * 0.3 - 0.25],
        length: 0.05 + 0.03 * golden(i * 3) + (p.y < 0.16 ? 0.012 : 0),
        width: 0.03,
        flat: 0.5,
        color: barred ? '#2A1E16' : def.colors.secondary,
        tipColor: barred ? '#1F1712' : i % 3 ? '#F2E8D8' : '#3A2A1E',
        up: [n.x, n.y, n.z],
        bend: [0, 0, -0.15],
        ao: 0.72,
      };
    },
  });
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      addLock(kit, {
        base: [sx * 0.03, 0.159 + k * 0.005, MZ + 0.02 - k * 0.003],
        dir: [sx, 0.05 - k * 0.1, 0.2],
        length: 0.07,
        width: 0.0024,
        flat: 1,
        color: '#F4EFE6',
        tipColor: '#CFC6B8',
        bend: [0, -0.12, -0.1],
        ao: 1,
      });
    }
  }
  kit.addEyes({
    center: [0.04, 0.207, 0.08],
    radius: 0.0205,
    gaze: [0.32, 0.04, 0.95],
    style: { iris: '#D9AF3A', ring: '#7A5A12', pupil: 'round', surround: '#1A1410', irisR: 0.44 },
    lids: { upper: 18, lower: -30, frown: 9, color: '#2A1E16', rim: '#0F0B08' },
  });
  return kit.build(
    'lynx',
    { sheen: '#B89A78', roughness: 0.86, pattern: createPatternTexture('spots'), patternColor: '#5A3A22', patternScale: 11 },
    { roughness: 0.4, clearcoat: 0.4 },
  );
}

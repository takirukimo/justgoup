// Snow leopard (Schneeleopard): a big fluffy cat face — rounded skull, puffy whisker pads, broad
// cheek ruffs, small round ears with dark backs, pale glacier eyes and smoky rosettes.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { createPatternTexture } from '../materials';
import { ellipsoid, lin, mirrorX, mixRGB, sdEllipsoid, smax, smin, sstep, type RGB, type Sdf } from './geo';
import { HeadKit, addEars, addLock, addNeck, addSkull, golden, scatterLocks } from './parts';

/** Shared big-cat skull (snow leopard / lynx variants tune the proportions). */
export function catSdf(o: { muzzleZ: number; cheekW: number; brow: number }): Sdf {
  const skull = ellipsoid([0, 0.2, -0.012], [0.08, 0.074, 0.08]);
  const dome = ellipsoid([0, 0.224, 0.028], [0.066, 0.052, 0.06]);
  const muzzle = ellipsoid([0, 0.168, o.muzzleZ], [0.044, 0.034, 0.04]);
  const pads = mirrorX(ellipsoid([0.02, 0.163, o.muzzleZ + 0.02], [0.025, 0.021, 0.022]));
  const nose = ellipsoid([0, 0.181, o.muzzleZ + 0.036], [0.019, 0.013, 0.013]);
  const chin = ellipsoid([0, 0.138, o.muzzleZ - 0.002], [0.024, 0.016, 0.022]);
  const cheek = mirrorX(ellipsoid([0.058, 0.176, 0.03], [o.cheekW, 0.046, 0.046]));
  const browR = mirrorX(ellipsoid([0.038, 0.226, 0.07], [0.026, 0.012 * o.brow, 0.02]));
  const eyeC = [0.04, 0.207, 0.08];
  return (x, y, z) => {
    let d = skull(x, y, z);
    d = smin(d, dome(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.035);
    d = smin(d, pads(x, y, z), 0.014);
    d = smin(d, nose(x, y, z), 0.012);
    d = smin(d, chin(x, y, z), 0.02);
    d = smin(d, cheek(x, y, z), 0.04);
    d = smin(d, browR(x, y, z), 0.018);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.019), 0.01);
    // philtrum + mouth line under the pads
    d = smax(d, -sdEllipsoid(x, y - 0.155, z - (o.muzzleZ + 0.038), 0.0025, 0.012, 0.01), 0.004);
    return d;
  };
}

export function buildSnowLeopard(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'snowleopard')!;
  const base = lin(def.colors.base);
  const dark = lin(def.colors.secondary);
  const white = lin(def.colors.accent);
  const noseC = lin('#9C7C7A');
  const kit = new HeadKit();
  const MZ = 0.088;
  const sdf = catSdf({ muzzleZ: MZ, cheekW: 0.044, brow: 1 });
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.2, -0.05],
    b: [0, 0.17, 0.1],
    rows: 52,
    cols: 46,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // white muzzle, chin, throat; dark tear line under the eye
      const muzzleK = sstep(0.07, 0.1, p.z) * sstep(0.2, 0.175, p.y);
      const under = sstep(-0.2, -0.7, n.y) * sstep(0.19, 0.15, p.y);
      mixRGB(base, white, Math.max(muzzleK, under) * 0.9, tmp);
      const nk = sstep(MZ + 0.03, MZ + 0.044, p.z) * sstep(0.174, 0.182, p.y) * sstep(0.02, 0.008, ax);
      mixRGB(tmp, noseC, nk, tmp);
      // lip line
      mixRGB(tmp, dark, sstep(0.004, 0.0, Math.abs(p.y - 0.149)) * sstep(MZ, MZ + 0.03, p.z) * 0.8, out.color);
      out.aux[1] = nk * 0.6;
      out.aux[2] = 1 - nk;
      // rosettes on the crown, back and sides — not on the muzzle, chin or eye area
      const eyeD = Math.hypot(ax - 0.04, p.y - 0.207, p.z - 0.08);
      out.aux[3] = (1 - muzzleK) * (1 - under) * sstep(0.028, 0.045, eyeD);
    },
  });
  addNeck(kit, {
    top: [0, 0.168, -0.02],
    r0: 0.06,
    r1: 0.066,
    color: def.colors.base,
    paint: (_p, n, out) => {
      mixRGB(base, white, sstep(0.3, 0.9, n.z) * 0.8, out.color);
      out.aux[3] = 1 - sstep(0.2, 0.7, n.z);
    },
  });
  addEars(kit, {
    base: [0.062, 0.252, -0.026],
    dir: [0.7, 0.68, -0.2],
    open: [0.45, 0.1, 1],
    length: 0.036,
    width: 0.04,
    cup: 0.75,
    point: 0.45,
    outer: '#2E2D2B',
    inner: '#EDE8E0',
    rim: '#1E1D1C',
  });
  // big fluffy cheek ruff + chin fluff (smoky tips)
  scatterLocks(kit, sdf, {
    center: [0, 0.17, 0.0],
    count: 96,
    seed: 7,
    sink: 0.007,
    mask: (p) => sstep(0.05, 0.085, Math.abs(p.x)) * sstep(0.215, 0.15, p.y) * sstep(0.09, 0.02, p.z),
    lock: (p, n, i) => ({
      base: [p.x, p.y, p.z],
      dir: [n.x * 1.1, n.y * 0.3 - 0.45, n.z * 0.5 - 0.35],
      length: 0.04 + 0.016 * golden(i * 5),
      width: 0.032,
      flat: 0.5,
      color: def.colors.base,
      tipColor: i % 3 === 0 ? '#9C9890' : def.colors.accent,
      up: [n.x, n.y, n.z],
      ao: 0.72,
    }),
  });
  for (let i = 0; i < 10; i++) {
    const a = golden(i) * Math.PI * 2;
    addLock(kit, {
      base: [Math.cos(a) * 0.016, 0.132, MZ - 0.012 + Math.sin(a) * 0.01],
      dir: [Math.cos(a) * 0.4, -1, 0.25],
      length: 0.03,
      width: 0.026,
      color: def.colors.accent,
      tipColor: '#E5E1D8',
      up: [0, 0, 1],
      ao: 0.8,
    });
  }
  // whiskers (white)
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      addLock(kit, {
        base: [sx * 0.03, 0.159 + k * 0.005, MZ + 0.02 - k * 0.003],
        dir: [sx, 0.05 - k * 0.1, 0.2],
        length: 0.075,
        width: 0.0024,
        flat: 1,
        color: '#F7F4EE',
        tipColor: '#CFCAC0',
        bend: [0, -0.12, -0.1],
        ao: 1,
      });
    }
  }
  kit.addEyes({
    center: [0.04, 0.207, 0.08],
    radius: 0.0178,
    gaze: [0.36, 0.04, 0.93],
    style: { iris: '#A9D2C4', ring: '#4E7C70', pupil: 'round', surround: '#22201E', irisR: 0.44 },
    lids: { upper: 19, lower: -29, frown: 7, color: '#3A3836', rim: '#141312' },
  });
  return kit.build(
    'snowleopard',
    { sheen: '#B8B4AC', roughness: 0.86, pattern: createPatternTexture('rosette'), patternColor: '#36332F', patternScale: 5.6 },
    { roughness: 0.4, clearcoat: 0.4 },
  );
}


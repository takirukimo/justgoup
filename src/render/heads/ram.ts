// Bighorn ram (Widder): blunt Roman-nosed sheep face with a white muzzle and massive ridged horns
// that spiral back, down behind the ears and forward under them.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { ellipsoid, lin, mirrorX, mixRGB, roundCone, sdEllipsoid, sdRoundCone, smax, smin, sstep, type RGB } from './geo';
import { HeadKit, addEars, addHorns, addNeck, addSkull } from './parts';

export function buildRam(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'ram')!;
  const base = lin(def.colors.base);
  const white = lin(def.colors.secondary);
  const dark = lin('#4E3F30');
  const noseC = lin('#3A3028');
  const kit = new HeadKit();

  const skull = ellipsoid([0, 0.206, -0.016], [0.074, 0.078, 0.082]);
  const brow = ellipsoid([0, 0.226, 0.034], [0.068, 0.058, 0.058], [-0.25, 0, 0]);
  const muzzle = roundCone([0, 0.186, 0.058], [0, 0.152, 0.15], 0.058, 0.044);
  const ridge = ellipsoid([0, 0.188, 0.1], [0.04, 0.034, 0.062], [0.45, 0, 0]);
  const nosePad = ellipsoid([0, 0.152, 0.168], [0.038, 0.032, 0.026]);
  const jaw = mirrorX(ellipsoid([0.046, 0.15, 0.028], [0.038, 0.048, 0.06], [0.3, 0, 0]));
  const chin = roundCone([0, 0.122, 0.04], [0, 0.126, 0.144], 0.034, 0.028);
  const boss = mirrorX(ellipsoid([0.04, 0.262, 0.03], [0.034, 0.024, 0.034]));
  const eyeC = [0.0576, 0.2122, 0.0682];
  const sdf = (x: number, y: number, z: number) => {
    let d = skull(x, y, z);
    d = smin(d, brow(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.045);
    d = smin(d, ridge(x, y, z), 0.03);
    d = smin(d, nosePad(x, y, z), 0.02);
    d = smin(d, jaw(x, y, z), 0.035);
    d = smin(d, chin(x, y, z), 0.03);
    d = smin(d, boss(x, y, z), 0.025);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.018), 0.01);
    d = smax(d, -sdRoundCone(ax, y, z, 0.033, 0.13, 0.106, 0.014, 0.131, 0.164, 0.003, 0.0035), 0.006);
    d = smax(d, -sdEllipsoid(ax - 0.016, y - 0.158, z - 0.19, 0.007, 0.0045, 0.008), 0.006);
    return d;
  };
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.2, -0.06],
    b: [0, 0.155, 0.152],
    rows: 52,
    cols: 44,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // white muzzle (nose, lips, chin) and a pale eye patch; darker brow
      const muzzleK = sstep(0.11, 0.15, p.z) * sstep(0.2, 0.16, p.y);
      mixRGB(base, white, Math.max(muzzleK, sstep(-0.3, -0.8, n.y) * sstep(0.17, 0.13, p.y)) * 0.95, tmp);
      mixRGB(tmp, dark, sstep(0.23, 0.27, p.y) * 0.4, tmp);
      const nk = sstep(0.162, 0.178, p.z) * sstep(0.138, 0.154, p.y) * sstep(0.034, 0.014, ax);
      mixRGB(tmp, noseC, nk, out.color);
      out.aux[1] = nk * 0.7;
      out.aux[2] = 1 - nk;
    },
  });
  addNeck(kit, {
    top: [0, 0.172, -0.02],
    r0: 0.06,
    r1: 0.062,
    color: def.colors.base,
    paint: (_p, n, out) => mixRGB(base, dark, sstep(-0.3, -0.9, n.z) * 0.35, out.color),
  });
  addEars(kit, {
    base: [0.066, 0.226, -0.03],
    dir: [0.92, -0.25, -0.2],
    open: [0.2, 0.3, 1],
    length: 0.05,
    width: 0.028,
    cup: 0.6,
    point: 0.55,
    outer: def.colors.base,
    inner: '#D9C6AC',
    rim: '#4E3F30',
  });
  // massive spiral horns
  addHorns(kit, {
    ctrl: [
      [0.03, 0.25, 0.034],
      [0.044, 0.3, 0.014],
      [0.064, 0.322, -0.036],
      [0.086, 0.31, -0.088],
      [0.104, 0.262, -0.118],
      [0.116, 0.2, -0.112],
      [0.122, 0.152, -0.072],
      [0.124, 0.14, -0.018],
      [0.12, 0.158, 0.024],
      [0.112, 0.19, 0.04],
    ],
    samples: 70,
    cols: 15,
    radius: (t) => 0.037 * Math.pow(1 - t, 0.78) + 0.0055,
    section: (ang, t) => {
      // rounded triangle that flattens on the inner face
      const c = Math.cos(ang);
      const tri = 1 + 0.12 * Math.cos(3 * ang + 0.4) * (1 - 0.5 * t);
      return tri * (c < -0.6 ? 0.88 + 0.12 * (1 + c) / 0.4 : 1);
    },
    ridges: { count: 9, amp: 0.06, sharp: 2, start: 0.05, end: 0.95 },
    rings: { count: 54, amp: 0.045 },
    twist: 0.4,
    up: [0, 0, 1],
    base: '#9A8668',
    tip: '#D2C2A2',
    ridgeColor: '#6E5C44',
  });
  kit.addEyes({
    center: [0.0576, 0.2122, 0.0682],
    radius: 0.0168,
    gaze: [0.76, 0.06, 0.65],
    style: { iris: '#D19A3A', ring: '#7A4E12', pupil: 'horizontal', surround: def.colors.eye, irisR: 0.44 },
    lids: { upper: 16, lower: -30, frown: 6, color: def.colors.base, rim: '#2A2018' },
  });
  return kit.build('ram', { sheen: '#857058', roughness: 0.86 }, { roughness: 0.62, clearcoat: 0.25 });
}

// Chamois (Gämse): slender goat-antelope face, white mask with dark stripes from the horn base
// through the eye to the muzzle, short black horns that rise straight up and hook back sharply.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { ellipsoid, lin, mirrorX, mixRGB, roundCone, sdEllipsoid, sdRoundCone, smax, smin, sstep, type RGB } from './geo';
import { HeadKit, addEars, addHorns, addNeck, addSkull } from './parts';

function segDist(py: number, pz: number, ay: number, az: number, by: number, bz: number): number {
  const vy = by - ay, vz = bz - az;
  const t = Math.max(0, Math.min(1, ((py - ay) * vy + (pz - az) * vz) / (vy * vy + vz * vz)));
  return Math.hypot(py - (ay + vy * t), pz - (az + vz * t));
}

export function buildChamois(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'chamois')!;
  const body = lin(def.colors.base);
  const face = lin(def.colors.secondary);
  const black = lin(def.colors.accent);
  const nose = lin('#1E1916');
  const kit = new HeadKit();

  const skull = ellipsoid([0, 0.206, -0.016], [0.068, 0.074, 0.078]);
  const brow = ellipsoid([0, 0.222, 0.036], [0.06, 0.05, 0.054], [-0.3, 0, 0]);
  const muzzle = roundCone([0, 0.188, 0.056], [0, 0.156, 0.16], 0.048, 0.032);
  const nosePad = ellipsoid([0, 0.152, 0.176], [0.031, 0.029, 0.025]);
  const jaw = mirrorX(ellipsoid([0.04, 0.152, 0.03], [0.032, 0.044, 0.058], [0.3, 0, 0]));
  const chin = roundCone([0, 0.126, 0.04], [0, 0.128, 0.148], 0.029, 0.022);
  const cheek = mirrorX(ellipsoid([0.05, 0.19, 0.03], [0.02, 0.026, 0.038]));
  const browR = mirrorX(ellipsoid([0.045, 0.242, 0.066], [0.026, 0.012, 0.022], [0, 0, 0.25]));
  const ped = mirrorX(ellipsoid([0.024, 0.266, 0.052], [0.02, 0.017, 0.02]));
  const eyeC = [0.051, 0.214, 0.072];
  const sdf = (x: number, y: number, z: number) => {
    let d = skull(x, y, z);
    d = smin(d, brow(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.045);
    d = smin(d, nosePad(x, y, z), 0.02);
    d = smin(d, jaw(x, y, z), 0.035);
    d = smin(d, chin(x, y, z), 0.03);
    d = smin(d, cheek(x, y, z), 0.025);
    d = smin(d, browR(x, y, z), 0.02);
    d = smin(d, ped(x, y, z), 0.02);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.0225), 0.011);
    d = smax(d, -sdRoundCone(ax, y, z, 0.028, 0.134, 0.11, 0.012, 0.135, 0.17, 0.003, 0.0035), 0.006);
    d = smax(d, -sdEllipsoid(ax - 0.014, y - 0.158, z - 0.198, 0.0065, 0.004, 0.008), 0.006);
    return d;
  };
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.2, -0.055],
    b: [0, 0.158, 0.158],
    rows: 58,
    cols: 50,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // white face, brown crown/back of head + neck
      const faceK = sstep(-0.01, 0.03, p.z + p.y * 0.25 - 0.06) * sstep(0.27, 0.24, p.y + Math.max(0, -p.z) * 0.6);
      mixRGB(body, face, faceK, tmp);
      // the dark stripe: horn base → eye → muzzle side
      const sd = Math.min(segDist(p.y, p.z, 0.262, 0.03, 0.214, 0.074), segDist(p.y, p.z, 0.214, 0.074, 0.168, 0.142));
      const side = sstep(0.02, 0.034, ax);
      mixRGB(tmp, black, sstep(0.025, 0.011, sd) * side * 0.92, tmp);
      // darker nasal bridge line
      mixRGB(tmp, lin('#6E5843'), sstep(0.016, 0.004, ax) * sstep(0.18, 0.21, p.y) * sstep(0.04, 0.1, p.z) * 0.5, tmp);
      const nk = sstep(0.168, 0.186, p.z) * sstep(0.14, 0.156, p.y) * sstep(0.03, 0.012, ax);
      mixRGB(tmp, nose, nk, out.color);
      out.aux[1] = nk * 0.75;
      out.aux[2] = 1 - nk;
    },
  });
  addNeck(kit, {
    top: [0, 0.172, -0.02],
    r0: 0.052,
    r1: 0.056,
    color: def.colors.base,
    paint: (p, n, out) => {
      // cream throat patch
      mixRGB(body, face, sstep(0.4, 0.95, n.z) * sstep(0.05, 0.12, p.y) * 0.85, out.color);
    },
  });
  addEars(kit, {
    base: [0.054, 0.252, -0.008],
    dir: [0.75, 0.6, -0.3],
    open: [0.35, 0.15, 1],
    length: 0.078,
    width: 0.034,
    cup: 0.7,
    point: 0.75,
    outer: def.colors.base,
    inner: '#E9DCC6',
    rim: '#2A2019',
  });
  addHorns(kit, {
    ctrl: [
      [0.024, 0.255, 0.058],
      [0.026, 0.3, 0.06],
      [0.028, 0.345, 0.054],
      [0.03, 0.375, 0.038],
      [0.031, 0.388, 0.012],
      [0.032, 0.38, -0.012],
      [0.032, 0.362, -0.026],
    ],
    samples: 44,
    cols: 12,
    radius: (t) => 0.0128 * Math.pow(1 - t, 0.7) + 0.0018,
    rings: { count: 18, amp: 0.05 },
    up: [0, 0, 1],
    base: '#2A2420',
    tip: '#0F0D0C',
  });
  kit.addEyes({
    center: [0.051, 0.214, 0.072],
    radius: 0.0225,
    gaze: [0.6, 0.05, 0.8],
    style: { iris: '#8C5A26', ring: '#3E220C', pupil: 'horizontal', surround: def.colors.eye, irisR: 0.44 },
    lids: { upper: 26, lower: -36, frown: 3, color: '#1E1714', rim: '#120D0A' },
  });
  return kit.build('chamois', { sheen: '#6E604E', roughness: 0.86 }, { roughness: 0.42, clearcoat: 0.45 });
}

// Bearded vulture (Bartgeier): cream-to-rust head with a black mask through the eye, a red eye ring
// around a pale iris, a long hooked horn-grey beak, the black bristle "beard" and a rust-orange
// neck ruff over dark grey body feathers.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { ellipsoid, lin, mirrorX, mixRGB, smax, smin, sstep, type RGB } from './geo';
import { HeadKit, addBeak, addFeatherRuff, addLock, addNeck, addSkull, golden } from './parts';

function segDist2(py: number, pz: number, ay: number, az: number, by: number, bz: number): number {
  const vy = by - ay, vz = bz - az;
  const t = Math.max(0, Math.min(1, ((py - ay) * vy + (pz - az) * vz) / (vy * vy + vz * vz)));
  return Math.hypot(py - (ay + vy * t), pz - (az + vz * t));
}

export function buildVulture(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'vulture')!;
  const rust = lin(def.colors.secondary);
  const cream = lin('#F0DDB8');
  const black = lin('#141416');
  const kit = new HeadKit();

  const skull = ellipsoid([0, 0.214, -0.01], [0.06, 0.06, 0.068]);
  const face = ellipsoid([0, 0.204, 0.046], [0.042, 0.044, 0.05]);
  const browR = mirrorX(ellipsoid([0.03, 0.234, 0.058], [0.026, 0.01, 0.026], [0.2, 0.3, 0.1]));
  const throat = ellipsoid([0, 0.17, 0.03], [0.038, 0.034, 0.046]);
  const eyeC = [0.034, 0.218, 0.064];
  const sdf = (x: number, y: number, z: number) => {
    let d = skull(x, y, z);
    d = smin(d, face(x, y, z), 0.035);
    d = smin(d, browR(x, y, z), 0.018);
    d = smin(d, throat(x, y, z), 0.03);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.0164), 0.008);
    return d;
  };
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.212, -0.055],
    b: [0, 0.205, 0.064],
    rows: 50,
    cols: 44,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // cream crown → rust cheeks/throat
      mixRGB(cream, rust, sstep(0.22, 0.15, p.y) * 0.85, tmp);
      // black mask: from the eye forward to the beak base (and a thin line back)
      const md = segDist2(p.y, p.z, 0.214, 0.03, 0.205, 0.07);
      mixRGB(tmp, black, sstep(0.012, 0.004, md) * sstep(0.015, 0.03, ax), tmp);
      // red sclerotic ring around the eye
      const eyeD = Math.hypot(ax - 0.034, p.y - 0.218, p.z - 0.064);
      mixRGB(tmp, lin(def.colors.eye), sstep(0.0215, 0.0185, eyeD), out.color);
      out.aux[2] = 0.75;
    },
  });
  addNeck(kit, {
    top: [0, 0.18, -0.02],
    r0: 0.054,
    r1: 0.05,
    color: def.colors.secondary,
  });
  // long hooked beak (horn grey → darker hook)
  addBeak(kit, {
    ctrl: [
      [0, 0.206, 0.068],
      [0, 0.205, 0.11],
      [0, 0.2, 0.15],
      [0, 0.19, 0.178],
      [0, 0.172, 0.19],
      [0, 0.158, 0.184],
    ],
    width: (t) => 0.015 * (1 - t * 0.85) + 0.0014,
    height: (t) => 0.02 * (1 - t * 0.8) + 0.0018,
    color: (t, out) => mixRGB(lin(def.colors.accent), lin('#6E685E'), sstep(0.35, 0.95, t), out),
    gloss: (t) => 0.3 + 0.4 * t,
  });
  addBeak(kit, {
    ctrl: [
      [0, 0.188, 0.07],
      [0, 0.186, 0.11],
      [0, 0.182, 0.148],
    ],
    width: (t) => 0.012 * (1 - t * 0.6),
    height: (t) => 0.0075 * (1 - t * 0.5),
    color: (t, out) => mixRGB(lin('#C9C2B2'), lin('#8A8476'), t, out),
    gloss: () => 0.35,
  });
  // the black bristle beard under the beak base
  for (let i = 0; i < 12; i++) {
    const a = golden(i) * Math.PI * 2;
    addLock(kit, {
      base: [Math.cos(a) * 0.008, 0.18, 0.082 + Math.sin(a) * 0.008],
      dir: [Math.cos(a) * 0.25, -1, 0.45],
      length: 0.045 + 0.012 * golden(i * 3),
      width: 0.009,
      flat: 0.8,
      color: '#1A1A1C',
      tipColor: '#0C0C0D',
      bend: [0, 0.1, 0.2],
      up: [0, 0, 1],
      ao: 0.8,
    });
  }
  // rust-orange neck ruff (layered), dark grey body feathers below
  addFeatherRuff(kit, {
    y0: 0.165,
    y1: 0.04,
    rows: 5,
    perRow: 16,
    radius: (y) => 0.056 + (0.165 - y) * 0.05,
    zOffset: -0.008,
    length: 0.044,
    width: 0.03,
    color: (row) => (row < 4 ? [def.colors.secondary, '#F6CC8C'] : [def.colors.base, '#24242A']),
  });
  kit.addEyes({
    center: [0.034, 0.218, 0.064],
    radius: 0.0155,
    gaze: [0.52, 0.03, 0.85],
    style: { iris: '#F4E3A2', ring: '#C9A85A', pupil: 'round', surround: def.colors.eye, irisR: 0.36 },
    lids: { upper: 16, lower: -36, frown: 8, color: '#E6CFA8', rim: def.colors.eye },
  });
  return kit.build('vulture', { sheen: '#B08A60', roughness: 0.82 }, { roughness: 0.38, clearcoat: 0.5 });
}


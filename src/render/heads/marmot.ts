// Marmot (Murmeli): a round, cute rodent face — puffy cheeks, a short blunt muzzle with a dark
// nose, small round ears, a darker crown, bright buck teeth and fine whiskers.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { MeshBuilder, ellipsoid, lin, loft, mirrorX, mixRGB, sdEllipsoid, smax, smin, sstep, type RGB } from './geo';
import { HeadKit, addEars, addLock, addNeck, addSkull, golden, scatterLocks } from './parts';

function addTooth(b: MeshBuilder, x: number, y: number, z: number): void {
  loft(b, {
    rows: 8,
    cols: 12,
    point: (v, u, out) => {
      // rounded slab: width 9 mm, height 17 mm, depth 5 mm (top hidden in the lip)
      const a = u * Math.PI * 2;
      const t = v;
      const w = 0.0046 * (t > 0.85 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.85) / 0.15, 2))) : 1);
      const d = 0.0026 * (t > 0.85 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.85) / 0.15, 2))) : 1);
      const c = Math.cos(a);
      const s = Math.sin(a);
      out.set(x + Math.sign(c) * Math.pow(Math.abs(c), 0.6) * w, y - t * 0.017, z + Math.sign(s) * Math.pow(Math.abs(s), 0.6) * d);
    },
    attrib: (_p, _n, v, _u, out) => {
      out.color[0] = 0.92;
      out.color[1] = 0.86 - 0.08 * (1 - v);
      out.color[2] = 0.68 - 0.12 * (1 - v);
      out.aux[0] = 0.75 + 0.25 * v;
      out.aux[1] = 0.8;
    },
  });
}

export function buildMarmot(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'marmot')!;
  const base = lin(def.colors.base);
  const light = lin(def.colors.secondary);
  const dark = lin(def.colors.accent);
  const crown = lin('#6A5038');
  const kit = new HeadKit();

  const skull = ellipsoid([0, 0.205, -0.008], [0.086, 0.08, 0.084]);
  const cheek = mirrorX(ellipsoid([0.05, 0.168, 0.048], [0.046, 0.042, 0.046]));
  const muzzle = ellipsoid([0, 0.172, 0.084], [0.042, 0.036, 0.042]);
  const pad = mirrorX(ellipsoid([0.018, 0.166, 0.112], [0.022, 0.02, 0.02]));
  const noseB = ellipsoid([0, 0.184, 0.118], [0.021, 0.016, 0.014]);
  const chin = ellipsoid([0, 0.14, 0.082], [0.026, 0.018, 0.026]);
  const eyeC = [0.052, 0.222, 0.058];
  const sdf = (x: number, y: number, z: number) => {
    let d = skull(x, y, z);
    d = smin(d, cheek(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.035);
    d = smin(d, pad(x, y, z), 0.016);
    d = smin(d, noseB(x, y, z), 0.014);
    d = smin(d, chin(x, y, z), 0.02);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.0152), 0.008);
    // lip split under the nose
    d = smax(d, -sdEllipsoid(x, y - 0.152, z - 0.12, 0.003, 0.012, 0.012), 0.005);
    return d;
  };
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.205, -0.05],
    b: [0, 0.172, 0.1],
    rows: 50,
    cols: 44,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // dark crown cap fading down the nose bridge, pale muzzle + cheeks
      mixRGB(base, crown, sstep(0.215, 0.27, p.y + p.z * 0.25) * 0.9, tmp);
      const muzzleK = sstep(0.06, 0.1, p.z) * sstep(0.2, 0.17, p.y);
      mixRGB(tmp, light, Math.max(muzzleK, sstep(0.17, 0.14, p.y) * sstep(-0.02, 0.04, p.z)) * 0.9, tmp);
      const nk = sstep(0.112, 0.126, p.z) * sstep(0.172, 0.18, p.y) * sstep(0.024, 0.01, ax);
      mixRGB(tmp, dark, nk, out.color);
      out.aux[1] = nk * 0.8;
      out.aux[2] = 1 - nk;
    },
  });
  addNeck(kit, { top: [0, 0.17, -0.015], r0: 0.062, r1: 0.072, color: def.colors.base });
  addEars(kit, {
    base: [0.064, 0.258, -0.02],
    dir: [0.65, 0.75, -0.2],
    open: [0.3, 0.1, 1],
    length: 0.03,
    width: 0.034,
    cup: 0.85,
    point: 0.0,
    outer: '#7A5C40',
    inner: '#C9A98A',
    rim: '#5A4430',
  });
  // fluffy fur on the cheeks and the back of the head
  scatterLocks(kit, sdf, {
    center: [0, 0.18, 0.0],
    count: 46,
    seed: 5,
    sink: 0.006,
    mask: (p) => sstep(0.05, 0.075, Math.abs(p.x)) * sstep(0.22, 0.16, p.y) * sstep(0.1, 0.04, p.z),
    lock: (p, n, i) => ({
      base: [p.x, p.y, p.z],
      dir: [n.x, n.y * 0.4 - 0.5, n.z * 0.6 - 0.3],
      length: 0.024 + 0.01 * golden(i),
      width: 0.026,
      flat: 0.55,
      color: def.colors.base,
      tipColor: def.colors.secondary,
      up: [n.x, n.y, n.z],
      ao: 0.75,
    }),
  });
  // buck teeth
  addTooth(kit.ker, -0.0056, 0.148, 0.122);
  addTooth(kit.ker, 0.0056, 0.148, 0.122);
  // whiskers
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      addLock(kit, {
        base: [sx * 0.03, 0.162 + k * 0.006, 0.112 - k * 0.004],
        dir: [sx * 1, 0.1 - k * 0.12, 0.15],
        length: 0.05 + 0.006 * k,
        width: 0.0028,
        flat: 1,
        color: '#2A2018',
        tipColor: '#6B5848',
        bend: [0, -0.15, -0.1],
        ao: 1,
      });
    }
  }
  kit.addEyes({
    center: [0.052, 0.222, 0.058],
    radius: 0.0142,
    gaze: [0.66, 0.12, 0.74],
    style: { iris: '#2E1E12', ring: '#0C0806', pupil: 'round', surround: '#0C0806', irisR: 0.46 },
    lids: { upper: 28, lower: -36, frown: -2, color: '#5C4632', rim: '#2A1E14' },
  });
  return kit.build('marmot', { sheen: '#8A7058', roughness: 0.88 }, { roughness: 0.3, clearcoat: 0.6 });
}


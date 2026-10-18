// Mountain goat (Schneeziege): white and shaggy — a long beard, fluffy cheeks and neck ruff,
// a forehead tuft, a boxy muzzle and short black dagger horns curving back.

import type * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { ellipsoid, lin, mirrorX, mixRGB, roundCone, sdEllipsoid, sdRoundCone, smax, smin, sstep, type RGB } from './geo';
import { HeadKit, addEars, addHorns, addLock, addNeck, addSkull, golden, scatterLocks } from './parts';

export function buildGoat(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'goat')!;
  const white = lin(def.colors.base);
  const shade = lin(def.colors.secondary);
  const black = lin(def.colors.accent);
  const kit = new HeadKit();

  const skull = ellipsoid([0, 0.206, -0.018], [0.072, 0.076, 0.08]);
  const brow = ellipsoid([0, 0.222, 0.036], [0.064, 0.054, 0.056], [-0.28, 0, 0]);
  const muzzle = roundCone([0, 0.184, 0.056], [0, 0.15, 0.158], 0.054, 0.04);
  const box = ellipsoid([0, 0.16, 0.13], [0.04, 0.036, 0.05]);
  const nosePad = ellipsoid([0, 0.152, 0.172], [0.034, 0.03, 0.026]);
  const jaw = mirrorX(ellipsoid([0.044, 0.15, 0.03], [0.036, 0.048, 0.06], [0.3, 0, 0]));
  const chin = roundCone([0, 0.122, 0.04], [0, 0.124, 0.148], 0.033, 0.026);
  const ped = mirrorX(ellipsoid([0.026, 0.264, 0.04], [0.022, 0.018, 0.022]));
  const eyeC = [0.0555, 0.2141, 0.07];
  const sdf = (x: number, y: number, z: number) => {
    let d = skull(x, y, z);
    d = smin(d, brow(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.045);
    d = smin(d, box(x, y, z), 0.03);
    d = smin(d, nosePad(x, y, z), 0.02);
    d = smin(d, jaw(x, y, z), 0.035);
    d = smin(d, chin(x, y, z), 0.03);
    d = smin(d, ped(x, y, z), 0.02);
    const ax = Math.abs(x);
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.0177), 0.01);
    d = smax(d, -sdRoundCone(ax, y, z, 0.032, 0.13, 0.108, 0.013, 0.131, 0.168, 0.003, 0.0035), 0.006);
    d = smax(d, -sdEllipsoid(ax - 0.015, y - 0.156, z - 0.194, 0.007, 0.0042, 0.008), 0.006);
    return d;
  };
  const tmp: RGB = [0, 0, 0];
  addSkull(kit, {
    sdf,
    a: [0, 0.2, -0.06],
    b: [0, 0.155, 0.156],
    rows: 52,
    cols: 44,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // soft warm-grey shading in creases, black nose pad
      mixRGB(white, shade, sstep(-0.3, -0.9, n.y) * 0.5, tmp);
      const nk = sstep(0.166, 0.182, p.z) * sstep(0.138, 0.154, p.y) * sstep(0.032, 0.012, ax);
      mixRGB(tmp, black, nk, out.color);
      out.aux[1] = nk * 0.75;
      out.aux[2] = 1 - nk;
    },
  });
  addNeck(kit, { top: [0, 0.172, -0.02], r0: 0.056, r1: 0.058, color: def.colors.base });
  addEars(kit, {
    base: [0.058, 0.248, -0.012],
    dir: [0.9, 0.35, -0.35],
    open: [0.3, 0.2, 1],
    length: 0.07,
    width: 0.034,
    cup: 0.65,
    point: 0.6,
    outer: def.colors.base,
    inner: '#E7DCCB',
    rim: def.colors.secondary,
  });
  addHorns(kit, {
    ctrl: [
      [0.026, 0.254, 0.044],
      [0.029, 0.296, 0.032],
      [0.032, 0.33, 0.008],
      [0.035, 0.352, -0.022],
      [0.037, 0.362, -0.05],
    ],
    samples: 36,
    cols: 12,
    radius: (t) => 0.0135 * Math.pow(1 - t, 0.75) + 0.0016,
    rings: { count: 14, amp: 0.06 },
    up: [0, 0, 1],
    base: '#2A2826',
    tip: '#0E0D0C',
  });
  // ── shag: beard, cheek fluff, neck ruff, forehead tuft ──
  for (let i = 0; i < 22; i++) {
    const a = golden(i) * Math.PI * 2;
    const rr = 0.024 * Math.sqrt((i + 0.5) / 22);
    const bx = Math.cos(a) * rr * 1.1;
    const bz = 0.12 + Math.sin(a) * rr;
    addLock(kit, {
      base: [bx, 0.11 + Math.sin(a) * 0.004, bz],
      dir: [bx * 1.2, -1, 0.32 + (bz - 0.12) * 2],
      length: 0.072 + 0.03 * (1 - rr / 0.024) + 0.01 * Math.sin(i * 5.3),
      width: 0.036,
      flat: 0.65,
      color: def.colors.base,
      tipColor: '#DCD5C8',
      bend: [0, 0.04, 0.12],
      up: [0, 0, 1],
      ao: 0.62,
    });
  }
  scatterLocks(kit, sdf, {
    center: [0, 0.17, 0.0],
    count: 96,
    seed: 3,
    sink: 0.006,
    mask: (p, n) => {
      // cheeks / jaw sides / back of the head, not the face front or the crown
      const side = sstep(0.035, 0.06, Math.abs(p.x));
      const low = sstep(0.24, 0.17, p.y);
      const notFace = sstep(0.11, 0.06, p.z);
      return side * low * notFace * 0.95 + sstep(0.02, -0.04, p.z) * sstep(0.26, 0.16, p.y) * 0.6 * (1 - sstep(0.4, 0.9, n.y));
    },
    lock: (p, n, i) => ({
      base: [p.x, p.y, p.z],
      dir: [n.x * 0.75, n.y * 0.3 - 0.8, n.z * 0.55],
      length: 0.044 + 0.02 * golden(i * 3),
      width: 0.036,
      flat: 0.55,
      color: def.colors.base,
      tipColor: '#E2DBCF',
      up: [n.x, n.y, n.z],
      ao: 0.7,
    }),
  });
  // forehead tuft
  for (let i = 0; i < 8; i++) {
    const a = golden(i) * Math.PI * 2;
    addLock(kit, {
      base: [Math.cos(a) * 0.016, 0.262, 0.03 + Math.sin(a) * 0.012],
      dir: [Math.cos(a) * 0.4, 0.7, 0.55],
      length: 0.03,
      width: 0.02,
      color: def.colors.base,
      tipColor: '#EFEAE0',
      bend: [0, -0.3, 0.2],
      up: [0, 0, 1],
      ao: 0.8,
    });
  }
  kit.addEyes({
    center: [0.0555, 0.2141, 0.07],
    radius: 0.0165,
    gaze: [0.74, 0.05, 0.67],
    style: { iris: '#5C4630', ring: '#21170D', pupil: 'horizontal', surround: def.colors.eye, irisR: 0.44 },
    lids: { upper: 18, lower: -30, frown: 3, color: def.colors.base, rim: '#2B2622' },
  });
  return kit.build('goat', { sheen: '#8C8780', roughness: 0.88 }, { roughness: 0.4, clearcoat: 0.45 });
}

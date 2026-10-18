// Alpine ibex (Steinbock) — the hero head. Long Roman-nosed muzzle, short chin beard, big amber
// eyes with horizontal pupils, small ears and huge back-sweeping scimitar horns with the
// characteristic transverse knobs.

import * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { ellipsoid, lin, mirrorX, mixRGB, roundCone, sdEllipsoid, sdRoundCone, smax, smin, sstep, type RGB, type Sdf } from './geo';
import { HeadKit, addEars, addHorns, addLock, addNeck, addSkull, golden } from './parts';

export interface IbexOptions {
  /** Horn length multiplier (Steini's are a touch grander). */
  horn?: number;
}

/** Shared ibex skull field (also used by the chamois/goat variants as a base reference). */
export function ibexSdf(): Sdf {
  const skull = ellipsoid([0, 0.207, -0.016], [0.074, 0.08, 0.083]);
  const brow = ellipsoid([0, 0.226, 0.04], [0.066, 0.056, 0.058], [-0.3, 0, 0]);
  const muzzle = roundCone([0, 0.19, 0.06], [0, 0.152, 0.172], 0.052, 0.035);
  const ridge = ellipsoid([0, 0.186, 0.11], [0.033, 0.03, 0.074], [0.4, 0, 0]);
  const nose = ellipsoid([0, 0.149, 0.19], [0.033, 0.031, 0.027]);
  const jaw = mirrorX(ellipsoid([0.042, 0.152, 0.026], [0.033, 0.045, 0.06], [0.32, 0, 0]));
  const chin = roundCone([0, 0.124, 0.04], [0, 0.125, 0.16], 0.031, 0.023);
  const cheek = mirrorX(ellipsoid([0.056, 0.192, 0.026], [0.022, 0.03, 0.042]));
  const browR = mirrorX(ellipsoid([0.047, 0.243, 0.07], [0.031, 0.016, 0.028], [0, 0, 0.25]));
  const pedicle = mirrorX(ellipsoid([0.031, 0.272, 0.047], [0.029, 0.021, 0.029]));
  const eyeC = [0.055, 0.214, 0.074];
  return (x, y, z) => {
    let d = skull(x, y, z);
    d = smin(d, brow(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.045);
    d = smin(d, ridge(x, y, z), 0.03);
    d = smin(d, nose(x, y, z), 0.02);
    d = smin(d, jaw(x, y, z), 0.035);
    d = smin(d, chin(x, y, z), 0.03);
    d = smin(d, cheek(x, y, z), 0.025);
    d = smin(d, browR(x, y, z), 0.02);
    d = smin(d, pedicle(x, y, z), 0.022);
    const ax = Math.abs(x);
    // eye sockets
    d = smax(d, -(Math.hypot(ax - eyeC[0], y - eyeC[1], z - eyeC[2]) - 0.0228), 0.012);
    // mouth line (a soft groove from the lip corner to the front)
    d = smax(d, -sdRoundCone(ax, y, z, 0.03, 0.132, 0.12, 0.013, 0.131, 0.178, 0.0022, 0.003), 0.004);
    // nostrils
    d = smax(d, -sdEllipsoid(ax - 0.015, y - 0.156, z - 0.215, 0.007, 0.0042, 0.009), 0.006);
    return d;
  };
}

export function buildIbex(opts: IbexOptions = {}): THREE.Group {
  const def = HEADS.find((h) => h.id === 'ibex')!;
  const base = lin(def.colors.base);
  const dark = lin(def.colors.secondary);
  const light = lin(def.colors.accent);
  const cream = lin('#E2D6C0');
  const noseC = lin('#2B231D');
  const kit = new HeadKit();
  const sdf = ibexSdf();
  const tmp: RGB = [0, 0, 0];

  addSkull(kit, {
    sdf,
    a: [0, 0.2, -0.06],
    b: [0, 0.153, 0.18],
    rows: 54,
    cols: 46,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // base coat with a darker nasal stripe + darker crown, lighter muzzle tip, cream throat
      mixRGB(base, dark, sstep(0.034, 0.004, ax) * sstep(0.165, 0.195, p.y) * sstep(0.0, 0.09, p.z) * 0.95, tmp);
      mixRGB(tmp, dark, sstep(0.24, 0.29, p.y) * 0.5, tmp);
      // pale ring around the eye
      const eyeD = Math.hypot(ax - 0.055, p.y - 0.214, p.z - 0.074);
      mixRGB(tmp, light, sstep(0.04, 0.03, eyeD) * 0.35, tmp);
      // muzzle tip + lips
      const lip = sstep(0.15, 0.2, p.z) * sstep(0.16, 0.13, p.y);
      mixRGB(tmp, light, lip * 0.85, tmp);
      // underside (chin, jaw, throat)
      mixRGB(tmp, cream, sstep(-0.2, -0.75, n.y) * sstep(0.18, 0.13, p.y) * 0.7, tmp);
      // nose pad
      const nose = sstep(0.19, 0.207, p.z) * sstep(0.137, 0.151, p.y) * sstep(0.03, 0.012, ax);
      mixRGB(tmp, noseC, nose, out.color);
      out.aux[1] = nose * 0.75;
      out.aux[2] = 1 - nose;
    },
  });

  addNeck(kit, {
    top: [0, 0.175, -0.02],
    r0: 0.054,
    r1: 0.058,
    color: def.colors.base,
    paint: (p, n, out) => {
      // slightly paler throat high up, darker back stripe; uniform near the collar
      mixRGB(base, cream, sstep(0.3, 0.95, n.z) * 0.3 * sstep(0.06, 0.13, p.y), tmp);
      mixRGB(tmp, dark, sstep(-0.4, -0.9, n.z) * 0.45, out.color);
    },
  });

  addEars(kit, {
    base: [0.06, 0.252, -0.012],
    dir: [1, 0.42, -0.42],
    open: [0.25, 0.25, 1],
    length: 0.068,
    width: 0.034,
    cup: 0.65,
    point: 0.55,
    outer: def.colors.secondary,
    inner: '#B99878',
    rim: '#3E3226',
  });

  // chin beard: short pointed goatee (ibex billies) — soft clumped locks
  for (let i = 0; i < 11; i++) {
    const a = golden(i) * Math.PI * 2;
    const rr = 0.013 * Math.sqrt((i + 0.5) / 11);
    const bx = Math.cos(a) * rr;
    const bz = 0.13 + Math.sin(a) * rr;
    addLock(kit, {
      base: [bx, 0.108, bz],
      dir: [bx * 1.6, -1, 0.5 + (bz - 0.13) * 3],
      length: 0.046 + 0.016 * (1 - rr / 0.013) + 0.006 * Math.sin(i * 7.1),
      width: 0.026,
      flat: 0.7,
      color: '#5E4D3A',
      tipColor: '#3B2F24',
      bend: [0, 0.05, 0.22],
      up: [0, 0, 1],
      ao: 0.6,
    });
  }
  // a few longer guard hairs along the throat (subtle shag)
  for (let i = 0; i < 10; i++) {
    const t = i / 9;
    const side = i % 2 ? 1 : -1;
    addLock(kit, {
      base: [side * 0.012 * (1 - t), 0.11 - t * 0.045, 0.085 - t * 0.04],
      dir: [side * 0.25, -1, 0.35],
      length: 0.028,
      width: 0.022,
      color: def.colors.base,
      tipColor: '#6E5C46',
      up: [0, 0, 1],
      ao: 0.8,
    });
  }

  const hornScale = opts.horn ?? 1;
  const H = (x: number, y: number, z: number): [number, number, number] => [x, 0.262 + (y - 0.262) * hornScale, 0.05 + (z - 0.05) * hornScale];
  addHorns(kit, {
    ctrl: [
      H(0.03, 0.246, 0.056),
      H(0.033, 0.31, 0.044),
      H(0.044, 0.364, 0.012),
      H(0.06, 0.405, -0.044),
      H(0.076, 0.428, -0.114),
      H(0.09, 0.425, -0.192),
      H(0.1, 0.402, -0.262),
      H(0.106, 0.368, -0.318),
    ],
    samples: 60,
    cols: 15,
    radius: (t) => 0.0255 * Math.pow(1 - t, 0.72) + 0.0035,
    section: (ang, t) => {
      // D-shaped: broad flat front (knob face), rounded back; flattening fades toward the tip
      const c = Math.cos(ang);
      // round at the root, D-shaped (flat knob face) from ~10% on
      const k = sstep(0.08, 0.22, t);
      const flat = 1.01 - k * (0.22 - 0.15 * t);
      let m = c > flat ? flat / c : 1;
      m *= 1 + 0.1 * Math.abs(Math.sin(ang)) * k * (1 - t);
      return m;
    },
    ridges: { count: 13, amp: 0.34, sharp: 3, mask: (ang) => Math.pow(Math.max(0, Math.cos(ang)), 1.6), start: 0.11, end: 0.84 },
    rings: { count: 46, amp: 0.022 },
    twist: 0.55,
    up: [0, 0, 1],
    base: '#6E604E',
    tip: '#3F362D',
    ridgeColor: def.colors.accent,
  });

  kit.addEyes({
    center: [0.055, 0.214, 0.074],
    radius: 0.0228,
    gaze: [0.56, 0.06, 0.83],
    style: { iris: '#E0A136', ring: '#8A5512', pupil: 'horizontal', surround: def.colors.eye, irisR: 0.44 },
    lids: { upper: 19, lower: -34, frown: 8, color: def.colors.base, rim: '#241B14' },
  });

  return kit.build('ibex', { sheen: '#7A6650', roughness: 0.86 }, { roughness: 0.55, clearcoat: 0.3 });
}

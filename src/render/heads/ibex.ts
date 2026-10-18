// Alpine ibex (Steinbock) — the hero head, modelled on assets/reference/ibex-reference.png: a long,
// straight-profiled face with a slightly Roman nose, a dark grey-brown coat with a lighter muzzle,
// chin and throat, small amber eyes set on the sides of the skull (horizontal pupils, no bulge),
// ears angled out sideways, a short chin beard, a thick shaggy neck, and long, heavy horns that
// rise from the top of the skull and sweep back in a big arc, carrying prominent transverse knobs
// on their front face that shrink toward the smooth, slightly diverging tips.

import * as THREE from 'three';
import { ellipsoid, lin, mirrorX, mixRGB, noise3, roundCone, sdEllipsoid, sdRoundCone, smax, smin, sstep, type RGB, type Sdf } from './geo';
import { HeadKit, addEars, addHorns, addLock, addNeck, addSkull, golden } from './parts';

export interface IbexOptions {
  /** Horn length multiplier (Steini's are a touch grander). */
  horn?: number;
}

/** Natural coat palette (from the reference photo). */
export const IBEX_COLORS = {
  coat: '#453D36',
  dark: '#2F2924',
  warm: '#5A4B3D',
  muzzle: '#9C9183',
  throat: '#867A6C',
  nose: '#2A2521',
  hornBase: '#5B5246',
  hornTip: '#353029',
  hornRidge: '#887B65',
  iris: '#B27A2C',
  irisRing: '#5A360C',
} as const;

const EYE_C: [number, number, number] = [0.0575, 0.224, 0.056];
const EYE_R = 0.0152;

/**
 * The long ibex face: everything in front of the eyes is stretched forward by FACE_S (a smooth
 * piecewise-linear warp of z), so the muzzle reads long and straight like the reference instead of
 * a short, round goat snout. `faceZ` maps a model z to the field's z; `faceZInv` the other way.
 */
const FACE_Z0 = 0.09;
const FACE_S = 1.14;
const faceZ = (z: number): number => {
  if (z <= FACE_Z0 - 0.03) return z;
  const lin1 = FACE_Z0 + (z - FACE_Z0) / FACE_S;
  if (z >= FACE_Z0 + 0.03) return lin1;
  // C1 blend over ±3 cm
  const u = (z - (FACE_Z0 - 0.03)) / 0.06;
  return z + (lin1 - z) * u * u * (3 - 2 * u);
};
const faceZInv = (z: number): number => (z <= FACE_Z0 ? z : FACE_Z0 + (z - FACE_Z0) * FACE_S);

/** Ibex skull field (the chamois / goat / ram share its proportions as a reference). */
export function ibexSdf(): Sdf {
  const cranium = ellipsoid([0, 0.214, -0.014], [0.064, 0.07, 0.07]);
  const brow = ellipsoid([0, 0.232, 0.03], [0.061, 0.05, 0.062], [-0.26, 0, 0]);
  const muzzleC = roundCone([0, 0.2, 0.058], [0, 0.158, 0.182], 0.05, 0.028);
  // narrower across than deep, like a real goat muzzle
  const muzzle: Sdf = (x, y, z) => muzzleC(x * 1.16, y, z);
  const ridge = ellipsoid([0, 0.192, 0.112], [0.029, 0.03, 0.082], [0.36, 0, 0]);
  const nose = ellipsoid([0, 0.157, 0.188], [0.023, 0.023, 0.021]);
  const lip = ellipsoid([0, 0.143, 0.178], [0.024, 0.015, 0.024]);
  const jaw = mirrorX(ellipsoid([0.037, 0.155, 0.018], [0.029, 0.054, 0.064], [0.3, 0, 0]));
  const chin = roundCone([0, 0.128, 0.028], [0, 0.132, 0.163], 0.03, 0.018);
  const cheek = mirrorX(ellipsoid([0.05, 0.196, 0.034], [0.02, 0.027, 0.046]));
  const browR = mirrorX(ellipsoid([0.049, 0.24, 0.056], [0.025, 0.012, 0.026], [0, 0, 0.3]));
  const pedicle = mirrorX(ellipsoid([0.026, 0.266, 0.036], [0.03, 0.022, 0.032]));
  return (x, y, zm) => {
    const z = faceZ(zm);
    let d = cranium(x, y, z);
    d = smin(d, brow(x, y, z), 0.04);
    d = smin(d, muzzle(x, y, z), 0.045);
    d = smin(d, ridge(x, y, z), 0.03);
    d = smin(d, nose(x, y, z), 0.02);
    d = smin(d, lip(x, y, z), 0.016);
    d = smin(d, jaw(x, y, z), 0.035);
    d = smin(d, chin(x, y, z), 0.03);
    d = smin(d, cheek(x, y, z), 0.025);
    d = smin(d, browR(x, y, z), 0.018);
    d = smin(d, pedicle(x, y, z), 0.022);
    const ax = Math.abs(x);
    // eye sockets: a shallow seat so the small eye sits flush under the brow
    d = smax(d, -(Math.hypot(ax - EYE_C[0], y - EYE_C[1], z - EYE_C[2]) - (EYE_R + 0.0012)), 0.01);
    // mouth line (a soft groove from the lip corner to the front)
    d = smax(d, -sdRoundCone(ax, y, z, 0.026, 0.137, 0.11, 0.012, 0.136, 0.178, 0.002, 0.0028), 0.004);
    // nostrils: comma slits angled up and back
    d = smax(d, -sdEllipsoid(ax - 0.0145, y - 0.163, z - 0.211, 0.0062, 0.0042, 0.009), 0.005);
    // the warp shrinks distances in front of the eyes by up to 1/FACE_S: keep the field conservative
    return zm > FACE_Z0 - 0.03 ? d * FACE_S : d;
  };
}

const _pw = new THREE.Vector3();

export function buildIbex(opts: IbexOptions = {}): THREE.Group {
  const C = IBEX_COLORS;
  const coat = lin(C.coat);
  const dark = lin(C.dark);
  const warm = lin(C.warm);
  const muzzle = lin(C.muzzle);
  const throat = lin(C.throat);
  const noseC = lin(C.nose);
  const kit = new HeadKit();
  const sdf = ibexSdf();
  const tmp: RGB = [0, 0, 0];

  addSkull(kit, {
    sdf,
    a: [0, 0.205, -0.06],
    b: [0, 0.16, faceZInv(0.176)],
    rows: 52,
    cols: 44,
    paint: (pm, n, out) => {
      const p = _pw.set(pm.x, pm.y, faceZ(pm.z));
      const ax = Math.abs(p.x);
      // coat with a soft mottled variation (natural, not flat)
      const nz = noise3(p.x * 60, p.y * 60, p.z * 60) * 0.5 + noise3(p.x * 140, p.y * 140, p.z * 140) * 0.25;
      mixRGB(coat, warm, Math.max(0, nz) * 0.6 + sstep(0.04, 0.06, ax) * sstep(0.25, 0.18, p.y) * 0.25, tmp);
      // darker crown + forehead between the horns, and a dark stripe down the front of the face
      mixRGB(tmp, dark, sstep(0.235, 0.275, p.y) * 0.75, tmp);
      mixRGB(tmp, dark, sstep(0.03, 0.006, ax) * sstep(0.15, 0.2, p.y) * sstep(-0.01, 0.06, p.z) * 0.7, tmp);
      // a faintly paler ring around the eye
      const eyeD = Math.hypot(ax - EYE_C[0], p.y - EYE_C[1], p.z - EYE_C[2]);
      mixRGB(tmp, muzzle, sstep(EYE_R + 0.012, EYE_R + 0.004, eyeD) * 0.28, tmp);
      // pale muzzle: lips, the sides of the nose, the chin; grey-beige throat and jaw underside
      const lip = sstep(0.135, 0.18, p.z) * sstep(0.172, 0.142, p.y);
      mixRGB(tmp, muzzle, lip * 0.9, tmp);
      mixRGB(tmp, throat, sstep(-0.15, -0.7, n.y) * sstep(0.19, 0.14, p.y) * 0.85, tmp);
      // nose pad (dark, moist)
      const nose = sstep(0.194, 0.207, p.z) * sstep(0.15, 0.161, p.y) * sstep(0.024, 0.01, ax);
      mixRGB(tmp, noseC, nose, out.color);
      out.aux[1] = nose * 0.7;
      out.aux[2] = 1 - nose * 0.9;
    },
  });

  addNeck(kit, {
    top: [0, 0.18, -0.024],
    r0: 0.055,
    r1: 0.061,
    front: 1.1,
    color: C.coat,
    paint: (p, n, out) => {
      // grey-beige throat high up, dark mane down the back of the neck
      mixRGB(coat, throat, sstep(0.3, 0.95, n.z) * 0.55 * sstep(0.04, 0.13, p.y), tmp);
      mixRGB(tmp, dark, sstep(-0.3, -0.9, n.z) * 0.65, out.color);
    },
  });

  // ears: pointed, angled out to the sides and a little back, pale inside with a dark rim
  addEars(kit, {
    base: [0.05, 0.258, -0.032],
    dir: [1, 0.62, -0.55],
    open: [0.35, 0.1, 1],
    length: 0.086,
    width: 0.04,
    cup: 0.85,
    point: 0.72,
    outer: C.coat,
    inner: '#B8A894',
    rim: '#2E2721',
  });

  // short chin beard (billy goatee): soft clumped locks, darker at the tips
  for (let i = 0; i < 12; i++) {
    const a = golden(i) * Math.PI * 2;
    const rr = 0.012 * Math.sqrt((i + 0.5) / 12);
    const bx = Math.cos(a) * rr;
    const bz = faceZInv(0.135) + Math.sin(a) * rr;
    addLock(kit, {
      base: [bx, 0.114, bz],
      dir: [bx * 1.4, -1, 0.42 + (bz - faceZInv(0.135)) * 3],
      length: 0.034 + 0.012 * (1 - rr / 0.012) + 0.005 * Math.sin(i * 7.1),
      width: 0.024,
      flat: 0.7,
      color: '#4A3F35',
      tipColor: '#2B241F',
      bend: [0, 0.04, 0.18],
      up: [0, 0, 1],
      ao: 0.6,
    });
  }

  // horns: rise from the top of the skull, then a big backward arc; tips diverge slightly
  const hs = opts.horn ?? 1;
  const base: [number, number, number] = [0.023, 0.262, 0.038];
  const H = (x: number, y: number, z: number): [number, number, number] => [
    base[0] + (x - base[0]) * hs,
    base[1] + (y - base[1]) * hs,
    base[2] + (z - base[2]) * hs,
  ];
  addHorns(kit, {
    ctrl: [
      H(0.024, 0.262, 0.038),
      H(0.03, 0.334, 0.031),
      H(0.04, 0.412, 0.004),
      H(0.055, 0.477, -0.048),
      H(0.075, 0.52, -0.123),
      H(0.099, 0.535, -0.207),
      H(0.124, 0.519, -0.288),
      H(0.149, 0.484, -0.354),
      H(0.172, 0.436, -0.4),
    ],
    samples: 76,
    cols: 16,
    // heavy at the root (the two bases nearly touch on the crown), tapering to a slim worn tip
    radius: (t) => 0.0318 * Math.pow(1 - t, 0.82) + 0.0034,
    section: (ang, t) => {
      // round at the root, then D-shaped: a broad flat front (the knob face) and a rounded back
      const c = Math.cos(ang);
      const k = sstep(0.04, 0.16, t);
      const flat = 1.01 - k * (0.24 - 0.16 * t);
      let m = c > flat ? flat / c : 1;
      // slightly wider than deep (the knob face is broad)
      m *= 1 + 0.12 * Math.abs(Math.sin(ang)) * k * (1 - t);
      return m;
    },
    ridges: {
      // knobs only across the broad front face: from the front they read as transverse bars, from
      // the side as a row of teeth along the leading edge; the sides and back of the horn stay smooth
      count: 13,
      amp: 0.66,
      sharp: 4.2,
      mask: (ang) => Math.pow(Math.max(0, Math.cos(ang)), 1.5),
      start: 0.07,
      end: 0.8,
      taper: (t) => 1 - 0.6 * sstep(0.1, 0.8, t),
      crowd: 1.2,
    },
    rings: { count: 54, amp: 0.016 },
    twist: 0.32,
    up: [0, 0, 1],
    base: C.hornBase,
    tip: C.hornTip,
    ridgeColor: C.hornRidge,
  });

  kit.addEyes({
    center: EYE_C,
    radius: EYE_R,
    gaze: [0.8, 0.07, 0.6],
    style: { iris: C.iris, ring: C.irisRing, pupil: 'horizontal', surround: '#1E1812', irisR: 0.47 },
    lids: { upper: 15, lower: -27, frown: 6, color: C.coat, rim: '#1F1914' },
  });

  return kit.build('ibex', { sheen: '#8A7966', roughness: 0.88 }, { roughness: 0.62, clearcoat: 0.2 });
}

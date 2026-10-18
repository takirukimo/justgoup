// Human (Mönsch): a stylised but natural human head — neutral, friendly features, warm skin, short
// dark hair tapered at the nape, natural eyes (sclera, brown iris, blinking lids), sculpted ears —
// wearing the black CHIRAL SPORTS six-panel cap (assets/reference/cap-black.webp) with the wordmark
// embroidered in white across the front panels.
//
// Draw calls: skin + hair + ears + lids (one 'fur' mesh, strand detail only on the hair), eyes, cap.

import * as THREE from 'three';
import { HEADS } from '../../config/skins';
import { MeshBuilder, addEllipsoid, ellipsoid, lin, loft, mirrorX, mixRGB, noise3, sdEllipsoid, sdRoundCone, smax, smin, sstep, type RGB, type Sdf } from './geo';
import { HeadKit, addNeck, addSkull } from './parts';
import { CAP_TEX, createCapMaterial, createCapTexture } from '../materials';

export const EYE_C: [number, number, number] = [0.031, 0.217, 0.0662];
export const EYE_R = 0.0122;

// ── cap geometry (authored head units) ──
/** Band ellipse: centre, half axes (x = sides, z = front/back), front-up slope of the band plane. */
const BAND_C = new THREE.Vector3(0, 0.2332, -0.011);
const BAND_AX = 0.0815;
const BAND_AZ = 0.0975;
const BAND_SLOPE = 0.2;
/** The cranium (with the hair) the crown is shaped over: centre and radii. */
const SKULL_C = new THREE.Vector3(0, 0.232, -0.012);
const SKULL_R = new THREE.Vector3(0.0785, 0.0905, 0.0955);

/** Band point for u (0 = back centre, .5 = front centre; increasing u runs left → right seen from the front). */
function bandPoint(u: number, out: THREE.Vector3): THREE.Vector3 {
  const ph = u * Math.PI * 2;
  const x = -BAND_AX * Math.sin(ph);
  const z = BAND_C.z - BAND_AZ * Math.cos(ph);
  return out.set(x, BAND_C.y + (z - BAND_C.z) * BAND_SLOPE, z);
}

/** Distance from SKULL_C to the skull ellipsoid along a unit direction. */
function skullRadius(d: THREE.Vector3): number {
  return 1 / Math.sqrt((d.x / SKULL_R.x) ** 2 + (d.y / SKULL_R.y) ** 2 + (d.z / SKULL_R.z) ** 2);
}

const UP = new THREE.Vector3(0, 1, 0);
const _bp = new THREE.Vector3();
const _d0 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qv = new THREE.Quaternion();
/** Where the six panels meet (the button), as a direction from the skull centre. */
const APEX_DIR = new THREE.Vector3(0, 1, -0.04).normalize();
/**
 * Crown surface: v = 0 at the band → 1 at the button, a shell over the skull: the direction from
 * the skull centre swings from the band point up to the crown, and the radius eases from the band
 * onto the skull + a clearance that is generous over the structured front panels and snug at the
 * back. Negative v rolls the edge inward (the sweatband lip).
 */
export function crownPoint(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  bandPoint(u, _bp);
  _d0.subVectors(_bp, SKULL_C);
  const r0 = _d0.length();
  _d0.multiplyScalar(1 / r0);
  if (v < 0) {
    const k = -v / 0.06;
    return out.copy(SKULL_C).addScaledVector(_d0, r0 - 0.004 * k).addScaledVector(UP, 0.003 * k);
  }
  // swing the direction toward the button (a touch behind straight up); every meridian meets there
  _q.setFromUnitVectors(_d0, APEX_DIR);
  _qv.identity().slerp(_q, v);
  out.copy(_d0).applyQuaternion(_qv);
  const front = sstep(-0.2, 0.7, -Math.cos(u * Math.PI * 2)); // 1 at the front, 0 at the back
  // structured front: the panels stand off the forehead, most at mid height
  const clear = 0.0055 + 0.012 * front * Math.sin(Math.PI * Math.min(1, v * 1.25)) + 0.002 * (1 - v);
  const rSkull = skullRadius(out) + clear;
  const r = r0 + (rSkull - r0) * sstep(0, 0.3, v);
  return out.multiplyScalar(r).add(SKULL_C);
}

/** Head field: cranium, face, jaw, chin, cheekbones, brow, nose, lips — and the hair shell. */
export function humanSdf(): { sdf: Sdf; hair: (x: number, y: number, z: number) => number } {
  const cranium = ellipsoid([0, 0.232, -0.012], [0.073, 0.085, 0.09]);
  const face = ellipsoid([0, 0.196, 0.03], [0.06, 0.07, 0.056]);
  const lowerFace = ellipsoid([0, 0.158, 0.034], [0.05, 0.048, 0.046]);
  const chin = ellipsoid([0, 0.124, 0.064], [0.018, 0.014, 0.013]);
  const cheek = mirrorX(ellipsoid([0.042, 0.204, 0.056], [0.015, 0.011, 0.014]));
  const brow = ellipsoid([0, 0.237, 0.071], [0.05, 0.011, 0.015]);
  const noseTip = ellipsoid([0, 0.179, 0.097], [0.0098, 0.0092, 0.0092]);
  const upperLip = ellipsoid([0, 0.1572, 0.0795], [0.0175, 0.0036, 0.0046]);
  const lowerLip = ellipsoid([0, 0.1492, 0.0778], [0.0155, 0.0042, 0.0048]);
  /** Hair coverage 0..1 (hairline by angle around the head; tapered at the nape). */
  const hair = (x: number, y: number, z: number): number => {
    const th = Math.abs(Math.atan2(x, z)); // 0 front, π/2 sides, π back
    // hairline height by angle: forehead → temple → above the ear → behind the ear → nape
    let hl: number;
    if (th < 0.7) hl = 0.272;
    else if (th < 1.2) hl = 0.272 + (0.242 - 0.272) * sstep(0.7, 1.2, th);
    else if (th < 1.75) hl = 0.242 + (0.231 - 0.242) * sstep(1.2, 1.75, th);
    else if (th < 2.3) hl = 0.231 + (0.178 - 0.231) * sstep(1.75, 2.3, th);
    else hl = 0.178 + (0.152 - 0.178) * sstep(2.3, 3.0, th);
    // short tapered sideburns just in front of the ear
    const burn = Math.exp(-Math.pow((th - 1.2) / 0.07, 2));
    hl -= burn * (hl - 0.214);
    const soft = 0.0065 + 0.012 * sstep(2.2, 3.0, th) + 0.004 * burn; // the nape fades out (short taper)
    return sstep(hl - soft, hl + soft, y);
  };
  const sdf: Sdf = (x, y, z) => {
    const cr = cranium(x, y, z);
    let d = smin(cr, face(x, y, z), 0.04);
    d = smin(d, lowerFace(x, y, z), 0.03);
    const ax = Math.abs(x);
    d = smin(d, chin(x, y, z), 0.016);
    d = smin(d, cheek(x, y, z), 0.014);
    d = smin(d, brow(x, y, z), 0.016);
    // nose: bridge and a soft tip
    d = smin(d, sdRoundCone(x, y, z, 0, 0.222, 0.08, 0, 0.184, 0.095, 0.0072, 0.0092), 0.012);
    d = smin(d, noseTip(x, y, z), 0.008);
    d = smin(d, upperLip(x, y, z), 0.005);
    d = smin(d, lowerLip(x, y, z), 0.005);
    // eye openings: an almond slit (outer corner a touch higher) in front of each eyeball; the skin
    // around it forms the lids
    {
      const ex = ax - EYE_C[0];
      const ey = y - EYE_C[1] - ex * 0.1;
      const ez = z - (EYE_C[2] + EYE_R * 0.95);
      d = smax(d, -sdEllipsoid(ex, ey, ez, 0.0136, 0.0062, 0.011), 0.003);
    }
    // a shallow mouth line and small nostrils
    // a wide, calm mouth line with corners lifting a touch (friendly), and small nostrils
    d = smax(d, -sdRoundCone(ax, y, z, 0, 0.1532, 0.0852, 0.0195, 0.1552, 0.0775, 0.0008, 0.0006), 0.0016);
    d = smax(d, -ellipsoid([0.0056, 0.1728, 0.097], [0.002, 0.0012, 0.0024])(ax, y, z), 0.0012);
    // hair shell: up to 5.5 mm over the cranium where the hair grows
    const h = hair(x, y, z);
    if (h > 0) d = Math.min(d, cr - 0.0055 * h);
    return d;
  };
  return { sdf, hair };
}

/**
 * One sculpted ear (right side, +x): an outlined disc with a raised helix rim, an antihelix ridge
 * and a recessed concha, standing a little off the skull at the back.
 */
function addEar(kit: HeadKit, skin: RGB, deep: RGB): void {
  const start = kit.fur.vertexCount;
  const centre = new THREE.Vector3(0.0735, 0.205, -0.004);
  const nrm = new THREE.Vector3(1, 0, 0.32).normalize(); // faces out and a little forward
  const up = new THREE.Vector3(0, 1, -0.22);
  up.addScaledVector(nrm, -up.dot(nrm)).normalize();
  const fwd = new THREE.Vector3().crossVectors(up, nrm).normalize(); // toward the face
  const H = 0.029; // half height
  const Wd = 0.0175; // half width
  const T = 0.0034; // half thickness
  const outline = (a: number): [number, number] => {
    // wider at the top (helix), narrow lobe at the bottom
    const s = Math.sin(a);
    const c = Math.cos(a);
    const w = Wd * (1 + 0.18 * s) * (c > 0 ? 0.92 : 1.05);
    return [c * w, s * H * (s < 0 ? 0.95 : 1)];
  };
  const p = new THREE.Vector3();
  const tmp: RGB = [0, 0, 0];
  loft(kit.fur, {
    rows: 16,
    cols: 26,
    point: (v, u, out) => {
      const a = u * Math.PI * 2;
      const [ox, oy] = outline(a);
      // v: 0 front centre → .5 rim → 1 back centre
      const front = v < 0.5;
      const r = front ? v * 2 : (1 - v) * 2;
      let h: number;
      if (front) {
        const helix = 0.0042 * Math.exp(-Math.pow((r - 0.88) / 0.09, 2));
        const anti = 0.0022 * Math.exp(-Math.pow((r - 0.56) / 0.1, 2)) * sstep(-0.6, 0.2, Math.sin(a));
        const concha = -0.0042 * (1 - sstep(0.15, 0.55, r)) * sstep(-0.9, -0.2, Math.cos(a) * 0.6 - Math.sin(a));
        h = T * Math.sqrt(Math.max(0, 1 - Math.pow(r, 8))) + helix + anti + concha;
      } else {
        h = -T * Math.sqrt(Math.max(0, 1 - Math.pow(r, 6)));
      }
      // the back of the ear stands off the skull (the lobe and front edge stay attached)
      const stand = 0.006 * sstep(-0.2, 0.9, -Math.cos(a)) * sstep(-0.6, 0.6, Math.sin(a)) * r;
      out.copy(centre).addScaledVector(fwd, ox * r).addScaledVector(up, oy * r).addScaledVector(nrm, h + stand);
    },
    attrib: (pp, n, v, _u, out) => {
      p.copy(pp);
      // inner ear warmer and shadowed, rim catches light
      const r = v < 0.5 ? v * 2 : (1 - v) * 2;
      const inner = v < 0.5 ? 1 - sstep(0.4, 0.8, r) : 0;
      mixRGB(skin, deep, 0.35 + 0.35 * inner, tmp);
      out.color[0] = tmp[0];
      out.color[1] = tmp[1];
      out.color[2] = tmp[2];
      out.aux[0] = 0.62 + 0.38 * (1 - inner * 0.6) * (0.75 + 0.25 * Math.max(0, n.y));
      out.aux[1] = 0.05;
      out.aux[2] = 0.35;
      out.aux[3] = 0;
    },
  });
  kit.fur.mirrorCopyX(start);
}

/** The CHIRAL SPORTS cap mesh (authored head units): crown with an inner lip, pre-curved brim, button. */
function buildCap(): THREE.Mesh {
  const b = new MeshBuilder();
  b.defaults.color = [1, 1, 1];
  const { h: TH, crownRows: CR } = CAP_TEX;
  const crownV0 = 1 - CR / TH;
  // ── crown ──
  const rows = 22;
  const cols = 48;
  const lip = 2; // rows of the inner lip
  loft(b, {
    rows: rows + lip,
    cols,
    point: (v, u, out) => {
      const r = Math.round(v * (rows + lip - 1));
      const vv = r < lip ? -0.06 * (1 - r / lip) : (r - lip) / (rows - 1);
      crownPoint(u, vv, out);
    },
    uvRect: [0, crownV0, 1, 1],
    attrib: (_p, _n, v, _u, out) => {
      const r = Math.round(v * (rows + lip - 1));
      const k = r < lip ? 0.55 : 0.86 + 0.14 * sstep(0, 0.3, (r - lip) / (rows - 1));
      out.color[0] = out.color[1] = out.color[2] = k;
    },
  });
  // crown UVs: v by crown parameter (the lip rows map onto the band stitching)
  {
    const start = b.vertexCount - (rows + lip) * (cols + 1);
    for (let r = 0; r < rows + lip; r++) {
      const vv = r < lip ? 0 : (r - lip) / (rows - 1);
      for (let c = 0; c <= cols; c++) {
        const i = start + r * (cols + 1) + c;
        b.uv[i * 2] = c / cols;
        b.uv[i * 2 + 1] = crownV0 + (1 - crownV0) * vv;
      }
    }
  }
  // ── brim: a pre-curved D-shaped bill across the front panels ──
  const ua = 0.5 - 0.168;
  const ub = 0.5 + 0.168;
  const depth = 0.074;
  const I = new THREE.Vector3();
  const O = new THREE.Vector3();
  const M = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const brimRows = 28;
  const brimCols = 14;
  const brimStart = b.vertexCount;
  loft(b, {
    rows: brimRows,
    cols: brimCols,
    point: (v, u, out) => {
      const s = v;
      const uu = ua + (ub - ua) * s;
      bandPoint(uu, I);
      radial.set(I.x - BAND_C.x, 0, I.z - BAND_C.z).normalize();
      // the bill's root tucks 4 mm up inside the crown: no gap at the seam
      I.addScaledVector(radial, -0.004);
      I.y += 0.001;
      radial.lerp(new THREE.Vector3(0, 0, 1), 0.45).normalize();
      const sn = Math.sin(Math.PI * s);
      const D = depth * Math.pow(sn, 0.5);
      const side = (2 * s - 1) * (2 * s - 1);
      O.copy(I).addScaledVector(radial, D);
      O.y -= D * 0.2 + 0.016 * side * (D / depth);
      M.copy(I).lerp(O, 0.5);
      e1.subVectors(O, I);
      const half = e1.length() * 0.5;
      if (half > 1e-6) e1.normalize();
      else e1.copy(radial);
      // thickness direction: up, kept perpendicular to the bill
      e2.set(0, 1, 0).addScaledVector(e1, -e1.y).normalize();
      const thick = 0.0026 * Math.min(1, sn * 5);
      const a = u * Math.PI * 2;
      // slightly rounded edge: a squashed superellipse section
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const cx = Math.sign(ca) * Math.pow(Math.abs(ca), 0.6);
      const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 0.6);
      out.copy(M).addScaledVector(e1, cx * half).addScaledVector(e2, sy * thick);
    },
    attrib: (_p, _n, _v, u, out) => {
      const under = Math.sin(u * Math.PI * 2) < 0;
      const k = under ? 0.7 : 1;
      out.color[0] = out.color[1] = out.color[2] = k;
    },
  });
  for (let r = 0; r < brimRows; r++) {
    for (let c = 0; c <= brimCols; c++) {
      const i = brimStart + r * (brimCols + 1) + c;
      const t = 0.5 + 0.5 * Math.cos((c / brimCols) * Math.PI * 2);
      b.uv[i * 2] = r / (brimRows - 1);
      b.uv[i * 2 + 1] = crownV0 * (1 - t);
    }
  }
  // ── button ──
  const apex = crownPoint(0.5, 1, new THREE.Vector3());
  addEllipsoid(b, [0.0085, 0.0042, 0.0085], new THREE.Matrix4().makeTranslation(apex.x, apex.y + 0.0006, apex.z), 6, 12, (_p, _n, _v, _u, out) => {
    out.color[0] = out.color[1] = out.color[2] = 0.9;
  });
  {
    // button UVs: plain fabric area above the band
    const n = 6 * 13;
    for (let i = b.vertexCount - n; i < b.vertexCount; i++) {
      b.uv[i * 2] = 0.25;
      b.uv[i * 2 + 1] = crownV0 + (1 - crownV0) * 0.5;
    }
  }
  // embroidery placement: centre line at crown v = .34, CHIRAL SPORTS across ≈ 0.2 of the
  // circumference, aspect from the local surface derivatives at the front centre
  const v0 = 0.34;
  const pA = crownPoint(0.5, v0, new THREE.Vector3());
  const du = crownPoint(0.501, v0, new THREE.Vector3()).sub(pA).length() / 0.001;
  const dv = crownPoint(0.5, v0 + 0.001, new THREE.Vector3()).sub(pA).length() / 0.001;
  const tex = createCapTexture({ v: v0, widthU: 0.2, vPerU: du / dv });
  const mat = createCapMaterial(tex);
  mat.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(b.build({ color: true }), mat);
  mesh.name = 'cap';
  return mesh;
}

export function buildHuman(): THREE.Group {
  const def = HEADS.find((h) => h.id === 'human')!;
  const skin = lin(def.colors.base);
  const hairC = lin(def.colors.secondary);
  const blush = lin('#C2846A');
  const lipC = lin('#B07466');
  const mouthC = lin('#6E4237');
  const deep = lin('#9C6650');
  const kit = new HeadKit();
  const { sdf, hair } = humanSdf();
  const tmp: RGB = [0, 0, 0];

  addSkull(kit, {
    sdf,
    // vertical axis: the shrink-wrap poles land in the neck and under the cap, never on the face
    a: [0, 0.135, 0.004],
    b: [0, 0.288, -0.012],
    rows: 60,
    cols: 64,
    aoScale: 0.008,
    paint: (p, n, out) => {
      const ax = Math.abs(p.x);
      // skin: warmer over the cheeks, nose and ears; very subtle mottling
      const nz = noise3(p.x * 90, p.y * 90, p.z * 90) * 0.04;
      const warmth = sstep(0.035, 0.0, Math.hypot(ax - 0.042, p.y - 0.19, (p.z - 0.06) * 0.8)) * 0.45 + sstep(0.02, 0.0, Math.hypot(p.x, p.y - 0.178, p.z - 0.1)) * 0.4;
      mixRGB(skin, blush, Math.min(1, warmth + nz), tmp);
      // lips
      const lipM = sstep(0.072, 0.079, p.z) * sstep(0.019, 0.011, ax) * sstep(0.1438, 0.1466, p.y) * sstep(0.1608, 0.1582, p.y);
      mixRGB(tmp, lipC, lipM * 0.62, tmp);
      // mouth line (painted: finer than the mesh can carve), corners lifting a touch
      const mx = ax / 0.0195;
      const mouthY = 0.1533 + 0.0016 * mx * mx;
      const mouthM = sstep(1.05, 0.8, mx) * sstep(0.0026, 0.0008, Math.abs(p.y - mouthY)) * sstep(0.07, 0.078, p.z);
      mixRGB(tmp, mouthC, mouthM * 0.8, tmp);
      // eyebrows: soft arched bands of hair colour on the brow ridge
      const bx = (ax - 0.032) / 0.021;
      const browY = 0.2385 + 0.0035 * (1 - bx * bx) - 0.002 * Math.max(0, bx);
      const browM = sstep(1.08, 0.75, Math.abs(bx)) * sstep(0.0058, 0.0028, Math.abs(p.y - browY)) * sstep(0.058, 0.07, p.z) * (0.9 - 0.3 * Math.max(0, bx));
      mixRGB(tmp, hairC, browM, tmp);
      // hair (short, with a fade at the nape)
      const h = hair(p.x, p.y, p.z);
      mixRGB(tmp, hairC, h, out.color);
      out.aux[1] = lipM * 0.32 + sstep(0.02, 0.0, Math.hypot(p.x, p.y - 0.18, p.z - 0.104)) * 0.12;
      out.aux[2] = 0.35 + 0.65 * h; // sheen: soft on skin, full on hair
      out.aux[3] = Math.max(h, browM * 0.7); // strand detail: hair + brows only
    },
  });
  addNeck(kit, {
    top: [0, 0.172, -0.018],
    r0: 0.05,
    r1: 0.049,
    front: 1.04,
    color: def.colors.base,
    paint: (p, n, out) => {
      // a touch of shadow under the jaw
      mixRGB(skin, deep, sstep(0.12, 0.16, p.y) * sstep(0.2, 0.8, n.z) * 0.3, out.color);
      out.aux[2] = 0.35;
      out.aux[3] = 0;
    },
  });
  addEar(kit, skin, deep);
  kit.addEyes({
    center: EYE_C,
    radius: EYE_R,
    gaze: [0.07, -0.03, 1],
    style: { iris: def.colors.eye, ring: '#1E140D', pupil: 'round', surround: '#E2D9CE', irisR: 0.25 },
    // lids rest hidden under the skin above / below the opening and only sweep down to blink
    lids: { upper: 64, lower: -62, frown: 0, color: def.colors.base, rim: '#8A5A46' },
  });
  const g = kit.build('human', { sheen: '#D9A88C', roughness: 0.68, strandMask: 'w' });
  const inner = g.children[0];
  // a human head reads small on the stylised (broad-shouldered) body next to the animal heads: a
  // touch larger, seated lower on the neck
  inner.scale.multiplyScalar(1.12);
  inner.position.y -= 0.032;
  const cap = buildCap();
  cap.castShadow = true;
  cap.receiveShadow = true;
  inner.add(cap);
  return g;
}

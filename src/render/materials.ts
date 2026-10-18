// CHARACTER materials + procedural canvas textures.
//
//  • createBodyMaterial()  one MeshPhysicalMaterial for the whole skinned climber/guide body.
//    Each vertex carries a region id (aAux.x) that indexes palette uniforms (colour, roughness,
//    sheen, metalness), so a colourway change is a uniform update and the body draws in ONE call.
//    A detail atlas adds seams/stitching (R), prints in the print colour (G) and shoe-accent
//    prints (B). aAux.y = chalk dusting, aAux.z = baked cavity AO.
//  • createFurMaterial()   soft fur with sheen + optional triplanar pattern (rosettes / spots).
//  • createKeratinMaterial() horns, beaks, noses (vertex colour, clearcoat).
//  • createEyeMaterial()   glossy eye with a painted iris + catchlight.
//  • outfit atlas, eye, pattern and rope textures are drawn on canvases at load time.

import * as THREE from 'three';
import { BRAND, PALETTE } from '../config/brand';

// ───────────────────────────── canvas helpers ─────────────────────────────

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
}

function canvasTexture(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ───────────────────────────── rim light (shared) ─────────────────────────────

/** Shared character rim: a soft cool fresnel that separates silhouettes from the dark gym. */
export const CHARACTER_RIM = { value: new THREE.Vector3(0.11, 0.13, 0.15) };

const RIM_DECL = 'uniform vec3 uCharRim;';
const RIM_CODE = `{
  float fres = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  totalEmissiveRadiance += uCharRim * (fres * fres * fres);
}`;

function injectRim(shader: { uniforms: Record<string, { value: unknown }>; fragmentShader: string }, strength = 1): void {
  shader.uniforms.uCharRim = strength === 1 ? CHARACTER_RIM : { value: CHARACTER_RIM.value.clone().multiplyScalar(strength) };
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${RIM_DECL}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${RIM_CODE}`);
}

// ───────────────────────────── brand glyphs (vector, font independent) ─────────────────────────────
//
// Every CHIRAL print is drawn from the official outlined paths in BRAND (never a font): the mark,
// the CHIRAL SPORTS wordmark, and words set from the wordmark's own glyphs (plus N and U drawn to
// the same 13.1-unit stem, 70-unit cap height geometry) such as INSTRUCTOR.

const WM = BRAND.wordmarkPaths;
/** Glyph outlines in wordmark units (cap height 70, baseline 70.9) with their horizontal extent. */
const GLYPHS: Record<string, { d: string; x0: number; x1: number }> = {
  C: { d: WM[0], x0: 0, x1: 61.2 },
  H: { d: WM[1], x0: 69.6, x1: 125.8 },
  I: { d: WM[2], x0: 137.1, x1: 150.2 },
  R: { d: WM[3], x0: 161.4, x1: 215.7 },
  A: { d: WM[4], x0: 220, x1: 288.2 },
  L: { d: WM[5], x0: 295.4, x1: 341.7 },
  S: { d: WM[6], x0: 371.4, x1: 427.7 },
  P: { d: WM[7], x0: 437, x1: 490.7 },
  O: { d: WM[8], x0: 497.39, x1: 563.3 },
  T: { d: WM[10], x0: 630.09, x1: 684.79 },
  N: { d: 'M0,.9h13.4l30.6,48.1V.9h13v70h-13.4L13,22.8v48.1H0V.9Z', x0: 0, x1: 57 },
  U: { d: 'M0,.9h13.1v42.3c0,10.4,5.7,15.6,15.4,15.6s15.4-5.2,15.4-15.6V.9h13.1v43c0,17.7-10.9,28-28.5,28S0,61.6,0,43.9V.9Z', x0: 0, x1: 57 },
};
/** Height of a glyph run (wordmark units, including the round overshoot). */
export const GLYPH_H = 71.9;

/** A word set from the brand glyphs: one Path2D in wordmark units (x from 0), and its width. */
export function glyphRun(text: string, tracking = 11): { path: Path2D; width: number } {
  const p = new Path2D();
  let x = 0;
  for (const ch of text.toUpperCase()) {
    const gl = GLYPHS[ch];
    if (!gl) {
      x += 34;
      continue;
    }
    p.addPath(new Path2D(gl.d), new DOMMatrix([1, 0, 0, 1, x - gl.x0, 0]));
    x += gl.x1 - gl.x0 + tracking;
  }
  return { path: p, width: Math.max(0, x - tracking) };
}

/** The official CHIRAL SPORTS wordmark as one Path2D (viewBox units). */
export function wordmarkPath(): Path2D {
  const p = new Path2D();
  for (const d of BRAND.wordmarkPaths) p.addPath(new Path2D(d));
  return p;
}

/** The official CHIRAL mark as one Path2D (viewBox units). */
export function markPath(): Path2D {
  const p = new Path2D();
  for (const d of BRAND.markPaths) p.addPath(new Path2D(d));
  return p;
}

/** CHIRAL mark at (x, y) top-left, `w` px wide (aspect from the official viewBox). */
export function drawMark(g: CanvasRenderingContext2D, x: number, y: number, w: number, style: string): void {
  g.save();
  g.translate(x, y);
  const s = w / BRAND.markViewBox[0];
  g.scale(s, s);
  g.fillStyle = style;
  g.fill(markPath());
  g.restore();
}

/** Artwork canvas (white on transparent) of w × h px. */
function artwork(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const g = ctx2d(c);
  g.fillStyle = '#fff';
  draw(g);
  return c;
}

/**
 * Vertical text artwork: `path` (width × GLYPH_H units) rotated 90° clockwise, so it reads top to
 * bottom with the letter tops facing right. `px` = pixels per unit.
 */
function verticalArt(path: Path2D, width: number, px: number): HTMLCanvasElement {
  return artwork(GLYPH_H * px, width * px, (g) => {
    g.translate(GLYPH_H * px, 0);
    g.rotate(Math.PI / 2);
    g.scale(px, px);
    g.fill(path);
  });
}

// ───────────────────────────── outfit atlas ─────────────────────────────

/** UV rectangles of the outfit atlas: [u0, v0, u1, v1] (v up, three.js convention). */
export type UvRect = [number, number, number, number];

/** Layout space (rects are authored in a 1024 grid); the canvas itself is painted at RES. */
const LAYOUT = 1024;
const RES = 2048;
function rect(x: number, y: number, w: number, h: number): UvRect {
  return [x / LAYOUT, 1 - (y + h) / LAYOUT, (x + w) / LAYOUT, 1 - y / LAYOUT];
}

/** Atlas layout shared by geometry (uv rects) and the painter. */
export const ATLAS_RECTS = {
  torso: rect(0, 0, 1024, 512),
  sleeve: rect(0, 512, 256, 128),
  thigh: rect(256, 512, 384, 256),
  shin: rect(640, 512, 384, 256),
  shoe: rect(0, 768, 512, 192),
  bag: rect(512, 768, 256, 128),
  webbing: rect(768, 768, 256, 64),
  rope: rect(768, 832, 256, 64),
  collar: rect(0, 704, 256, 64),
  cuff: rect(0, 640, 256, 64),
  blank: rect(1000, 1000, 16, 16),
} as const;

/** 'climber' = CHIRAL SPORTS tee; 'staff' = CHIRAL SPORTS INSTRUCTOR tee (Steini). */
export type OutfitStyle = 'climber' | 'staff';

/** Torso cross-section at a rest height above the pelvis: half width, front and back depth (m). */
export interface TorsoSection {
  hw: number;
  f: number;
  b: number;
}

/**
 * The torso tube the atlas wraps (climber.ts builds it): u = 0 front centre → .25 character left →
 * .5 back centre → .75 right, superellipse sections (exponent TORSO_E) over rest heights
 * TORSO_Y0 … TORSO_Y1. The print painter uses it to place artwork by real surface distance.
 */
export const TORSO_E = 2.35;
export const TORSO_Y0 = -0.14;
export const TORSO_Y1 = 0.56;

interface TorsoPrint {
  art: HTMLCanvasElement;
  /** Centred on the front or the back centre line. */
  centre: 'front' | 'back';
  /** Top edge (rest height above the pelvis, m) and the size on the fabric (m). */
  top: number;
  width: number;
  height: number;
}

/**
 * Paints artwork into the G (print) channel of the torso rect so that it lands on the fabric at its
 * true size and aspect: every atlas texel is mapped back to (arc length from the centre line,
 * height) on the torso surface and the artwork is supersampled there. This undoes the uneven
 * superellipse parameterisation (prints near the centre lines would otherwise stretch) and wraps
 * across the u = 0 seam at the front centre.
 */
function paintTorsoPrints(g: CanvasRenderingContext2D, section: (y: number) => TorsoSection, prints: TorsoPrint[]): void {
  const [u0, v0, u1, v1] = ATLAS_RECTS.torso;
  const X0 = Math.round(u0 * RES);
  const W = Math.round((u1 - u0) * RES);
  const Ytop = Math.round((1 - v1) * RES);
  const H = Math.round((v1 - v0) * RES);
  const img = g.getImageData(X0, Ytop, W, H);
  const data = img.data;
  const N = 720;
  const table = new Float32Array(N + 1);
  const pt = (a: number, s: TorsoSection, out: number[]) => {
    const cz = superCosM(a);
    out[0] = -superSinM(a) * s.hw;
    out[1] = -cz * (cz >= 0 ? s.f : s.b);
  };
  const p0 = [0, 0];
  const p1 = [0, 0];
  const SS = 3; // supersamples per axis
  for (const pr of prints) {
    const ag = ctx2d(pr.art);
    const aw = pr.art.width;
    const ah = pr.art.height;
    const ad = ag.getImageData(0, 0, aw, ah).data;
    const alphaAt = (x: number, y: number): number => {
      // bilinear sample of the artwork alpha (0 outside)
      const fx = x - 0.5;
      const fy = y - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const at = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= aw || cy >= ah ? 0 : ad[(cy * aw + cx) * 4 + 3]);
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
      return (a + (b - a) * ty) / 255;
    };
    for (let py = 0; py < H; py++) {
      // surface heights covered by this texel row
      const yA = TORSO_Y0 + (1 - py / H) * (TORSO_Y1 - TORSO_Y0);
      const yB = TORSO_Y0 + (1 - (py + 1) / H) * (TORSO_Y1 - TORSO_Y0);
      if (yB > pr.top || yA < pr.top - pr.height) continue;
      const sec = section((yA + yB) * 0.5);
      // arc-length table around this section
      pt(0, sec, p0);
      table[0] = 0;
      for (let i = 1; i <= N; i++) {
        pt((i / N) * Math.PI * 2, sec, p1);
        table[i] = table[i - 1] + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        p0[0] = p1[0];
        p0[1] = p1[1];
      }
      const perim = table[N];
      const sBack = table[N / 2];
      const arcAt = (u: number): number => {
        const f = (((u % 1) + 1) % 1) * N;
        const i = Math.min(N - 1, Math.floor(f));
        const s = table[i] + (table[i + 1] - table[i]) * (f - i);
        if (pr.centre === 'back') return s - sBack;
        return s > perim * 0.5 ? s - perim : s;
      };
      // only columns near the centre line can be covered: bound by the arc width
      for (let px = 0; px < W; px++) {
        const uc = (px + 0.5) / W;
        const sc = arcAt(uc);
        if (Math.abs(sc) > pr.width * 0.5 + 0.02) continue;
        let cov = 0;
        for (let j = 0; j < SS; j++) {
          const y = yA + (yB - yA) * ((j + 0.5) / SS);
          const ay = ((pr.top - y) / pr.height) * ah;
          if (ay < -1 || ay > ah + 1) continue;
          for (let i = 0; i < SS; i++) {
            const s = arcAt((px + (i + 0.5) / SS) / W);
            const ax = (s / pr.width + 0.5) * aw;
            cov += alphaAt(ax, ay);
          }
        }
        cov /= SS * SS;
        if (cov <= 0) continue;
        const k = (py * W + px) * 4 + 1;
        data[k] = Math.min(255, data[k] + cov * 255);
      }
    }
  }
  g.putImageData(img, X0, Ytop);
}

function superCosM(a: number): number {
  const c = Math.cos(a);
  return Math.sign(c) * Math.pow(Math.abs(c), 2 / TORSO_E);
}
function superSinM(a: number): number {
  const s = Math.sin(a);
  return Math.sign(s) * Math.pow(Math.abs(s), 2 / TORSO_E);
}

const atlasCache = new Map<OutfitStyle, THREE.CanvasTexture>();

/**
 * Paints the outfit detail atlas (shared per style; never disposed by a rig). Channels: R = seam /
 * stitch darkening, G = print in the print colour (tee prints, chalk-bag mark in its own colour),
 * B = shoe-accent print. Black = plain fabric.
 *
 * Prints (assets/reference/tee-*.webp): the CHIRAL mark small and centred on the chest; CHIRAL SPORTS
 * set vertically down the spine (rotated 90° clockwise, reading top to bottom). The staff tee adds
 * INSTRUCTOR in small caps under the chest mark and under the back wordmark.
 */
export function createOutfitAtlas(style: OutfitStyle, section: (y: number) => TorsoSection): THREE.CanvasTexture {
  const hit = atlasCache.get(style);
  if (hit) return hit;
  const c = makeCanvas(RES, RES);
  const g = ctx2d(c);
  g.fillStyle = '#000';
  g.fillRect(0, 0, RES, RES);
  // everything below is authored in the 1024 layout grid
  g.scale(RES / LAYOUT, RES / LAYOUT);
  g.globalCompositeOperation = 'lighter';
  const R = (a: number) => `rgba(255,0,0,${a})`;
  const G = (a: number) => `rgba(0,255,0,${a})`;
  const B = (a: number) => `rgba(0,0,255,${a})`;

  // helpers in region space: (u, v) ∈ [0,1]², v up
  const region = (r: UvRect) => {
    const x0 = r[0] * LAYOUT;
    const x1 = r[2] * LAYOUT;
    const yTop = (1 - r[3]) * LAYOUT;
    const yBot = (1 - r[1]) * LAYOUT;
    return {
      X: (u: number) => x0 + (x1 - x0) * u,
      Y: (v: number) => yBot + (yTop - yBot) * v,
      w: x1 - x0,
      h: yBot - yTop,
      x0,
      yTop,
    };
  };
  const line = (pts: [number, number][], stroke: string, width: number, dash?: number[]) => {
    g.save();
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    g.restore();
  };
  /** seam = a soft groove + a dashed stitch row beside it */
  const seam = (pts: [number, number][], stitchOffset = 4) => {
    line(pts, R(0.5), 3.2);
    line(pts, R(0.22), 7);
    const off = pts.map(([x, y]) => [x + stitchOffset, y] as [number, number]);
    line(off, R(0.55), 1.4, [4, 3]);
  };
  const hseam = (r: ReturnType<typeof region>, v: number, u0 = 0, u1 = 1, double = true) => {
    const y = r.Y(v);
    line([[r.X(u0), y], [r.X(u1), y]], R(0.45), 3);
    line([[r.X(u0), y - 5], [r.X(u1), y - 5]], R(0.5), 1.3, [4, 3]);
    if (double) line([[r.X(u0), y - 9], [r.X(u1), y - 9]], R(0.5), 1.3, [4, 3]);
  };

  // ── torso (u: 0 front centre → .25 left side → .5 back → .75 right side; v: crotch → neck) ──
  {
    const r = region(ATLAS_RECTS.torso);
    // geometry: torso tube spans y −0.14 … 0.56 (0.70 m); tee hem at y = 0.07, waistband 0.035…0.07
    const vy = (y: number) => (y - TORSO_Y0) / (TORSO_Y1 - TORSO_Y0);
    // side seams of the tee (curving slightly forward toward the armpit)
    for (const us of [0.25, 0.75]) {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 16; k++) {
        const y = 0.075 + (0.43 - 0.075) * (k / 16);
        pts.push([r.X(us + (us < 0.5 ? -1 : 1) * 0.012 * Math.sin((k / 16) * Math.PI)), r.Y(vy(y))]);
      }
      seam(pts);
    }
    // shoulder yoke seam across the upper back (the spine print starts just below it)
    {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 30; k++) {
        const u = 0.3 + (0.4 * k) / 30;
        const d = (u - 0.5) / 0.2;
        pts.push([r.X(u), r.Y(vy(0.462 - 0.012 * (1 - d * d)))]);
      }
      seam(pts, 0);
    }
    // hem: double needle
    hseam(r, vy(0.083), 0, 1, true);
    // collar seam ring (just under the rib collar)
    hseam(r, vy(0.5), 0, 1, false);
    // pants: waistband (elastic) + front fly/gusset + back yoke
    {
      const y0 = r.Y(vy(0.075));
      const y1 = r.Y(vy(0.03));
      line([[r.X(0), y1], [r.X(1), y1]], R(0.5), 3);
      line([[r.X(0), y1 - 4], [r.X(1), y1 - 4]], R(0.4), 1.2, [3, 3]);
      // elastic ribbing
      g.save();
      g.beginPath();
      g.rect(r.X(0), y0, r.w, y1 - y0);
      g.clip();
      for (let x = r.X(0); x < r.X(1); x += 7) line([[x, y0], [x, y1]], R(0.18), 2);
      g.restore();
      // centre seams (front rise + back rise)
      for (const uc of [0, 0.5, 1]) seam([[r.X(uc), r.Y(vy(-0.12))], [r.X(uc), r.Y(vy(0.03))]], 0);
      // back pocket welts
      for (const uc of [0.43, 0.57]) {
        line([[r.X(uc - 0.04), r.Y(vy(-0.005))], [r.X(uc + 0.04), r.Y(vy(-0.005))]], R(0.4), 2.5);
      }
    }
  }

  // ── sleeve (u around, v: shoulder 1 → elbow 0) ──
  {
    const r = region(ATLAS_RECTS.sleeve);
    // underarm seam on the inside of the arm (u = .25 is medial in the limb frame)
    seam([[r.X(0.25), r.Y(0)], [r.X(0.25), r.Y(1)]]);
    // hem (double needle) near the sleeve end
    for (const dv of [0.1, 0.16]) line([[r.X(0), r.Y(dv)], [r.X(1), r.Y(dv)]], R(0.5), 1.3, [4, 3]);
    // set-in sleeve seam near the top
    line([[r.X(0), r.Y(0.86)], [r.X(1), r.Y(0.86)]], R(0.4), 3);
    line([[r.X(0), r.Y(0.82)], [r.X(1), r.Y(0.82)]], R(0.45), 1.2, [4, 3]);
  }

  // ── pants: thigh (v: knee 0 → hip 1) and shin (v: ankle 0 → knee 1); u: 0 front, .25 lateral ──
  {
    const t = region(ATLAS_RECTS.thigh);
    const s = region(ATLAS_RECTS.shin);
    // outseam + inseam
    for (const rr of [t, s]) {
      seam([[rr.X(0.25), rr.Y(0)], [rr.X(0.25), rr.Y(1)]]);
      seam([[rr.X(0.75), rr.Y(0)], [rr.X(0.75), rr.Y(1)]]);
    }
    // knee articulation darts (curved) — at the bottom of the thigh and top of the shin
    for (let k = 0; k < 2; k++) {
      const pts: [number, number][] = [];
      const pts2: [number, number][] = [];
      for (let i = 0; i <= 24; i++) {
        const u = -0.18 + (0.36 * i) / 24;
        const d = u / 0.18;
        pts.push([t.X((u + 1) % 1), t.Y(0.2 + k * 0.1 - 0.08 * (1 - d * d))]);
        pts2.push([s.X((u + 1) % 1), s.Y(0.8 - k * 0.1 + 0.08 * (1 - d * d))]);
      }
      // wrap-around: draw in two pieces (u < 0 portion)
      const draw = (p: [number, number][], rr: ReturnType<typeof region>) => {
        const a = p.filter(([x]) => x >= rr.X(0.5));
        const b = p.filter(([x]) => x < rr.X(0.5));
        if (a.length > 1) seam(a, 0);
        if (b.length > 1) seam(b, 0);
      };
      draw(pts, t);
      draw(pts2, s);
    }
    // reinforced seat seam at the top of the thigh
    line([[t.X(0.5), t.Y(0.95)], [t.X(1), t.Y(0.95)]], R(0.35), 2.5);
  }

  // ── cuffs (gathered elastic ribbing) ──
  {
    const r = region(ATLAS_RECTS.cuff);
    for (let x = r.X(0); x < r.X(1); x += 6) line([[x, r.Y(0)], [x, r.Y(1)]], R(0.3), 2.2);
    line([[r.X(0), r.Y(0.92)], [r.X(1), r.Y(0.92)]], R(0.5), 2);
  }
  // ── rib collar ──
  {
    const r = region(ATLAS_RECTS.collar);
    for (let x = r.X(0); x < r.X(1); x += 5) line([[x, r.Y(0)], [x, r.Y(1)]], R(0.25), 2);
  }

  // ── shoe (u around the foot section: 0 = sole centre, .25 medial…; v: heel 0 → toe 1) ──
  {
    const r = region(ATLAS_RECTS.shoe);
    // stitching around the upper (follows the rand top): u ≈ .2 and .8 bands
    for (const uu of [0.2, 0.8]) line([[r.X(uu), r.Y(0.05)], [r.X(uu), r.Y(0.96)]], R(0.55), 1.4, [4, 3]);
    // vamp seam across the instep
    line([[r.X(0.3), r.Y(0.58)], [r.X(0.7), r.Y(0.58)]], R(0.4), 2.5);
    // heel tab (shoe accent) with the CHIRAL mark
    g.fillStyle = B(1);
    g.fillRect(r.X(0.44), r.Y(0.12), r.X(0.56) - r.X(0.44), r.Y(0.0) - r.Y(0.12));
    drawMark(g, r.X(0.5) - 11, r.Y(0.3) - 6, 22, B(1));
    // clean technical band along the lateral midsole
    line([[r.X(0.12), r.Y(0.2)], [r.X(0.12), r.Y(0.75)]], B(1), 6);
  }

  // ── chalk bag: one CHIRAL mark centred on the outward face (u = 0, across the seam) + seam ──
  {
    const r = region(ATLAS_RECTS.bag);
    seam([[r.X(0.5), r.Y(0)], [r.X(0.5), r.Y(1)]]);
    const mw = 0.2 * r.w;
    const mh = (mw * BRAND.markViewBox[1]) / BRAND.markViewBox[0];
    for (const ux of [0, 1]) {
      g.save();
      g.beginPath();
      g.rect(r.x0, r.yTop, r.w, r.h);
      g.clip();
      drawMark(g, r.X(ux) - mw / 2, r.Y(0.6) - mh / 2, mw, G(1));
      g.restore();
    }
    hseam(r, 0.12, 0, 1, false);
  }
  // ── webbing (harness): bar-tack stitching and edges ──
  {
    const r = region(ATLAS_RECTS.webbing);
    line([[r.X(0), r.Y(0.15)], [r.X(1), r.Y(0.15)]], R(0.5), 1.5, [4, 3]);
    line([[r.X(0), r.Y(0.85)], [r.X(1), r.Y(0.85)]], R(0.5), 1.5, [4, 3]);
    for (let x = r.X(0) + 20; x < r.X(1); x += 70) {
      for (let k = 0; k < 6; k++) line([[x + k * 3, r.Y(0.25)], [x + k * 3, r.Y(0.75)]], R(0.4), 1.3);
    }
  }
  // ── rope (figure-8 knot): twisted kernmantle stripes ──
  {
    const r = region(ATLAS_RECTS.rope);
    g.save();
    g.beginPath();
    g.rect(r.x0, r.yTop, r.w, r.h);
    g.clip();
    for (let x = -r.h; x < r.w + r.h; x += 9) {
      line([[r.x0 + x, r.yTop], [r.x0 + x + r.h, r.yTop + r.h]], R(0.32), 3);
      line([[r.x0 + x + 4, r.yTop], [r.x0 + x + 4 - r.h * 0.5, r.yTop + r.h]], G(0.6), 1.5);
    }
    g.restore();
  }

  // ── tee prints (true size on the fabric) ──
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  const [mvw, mvh] = BRAND.markViewBox;
  const prints: TorsoPrint[] = [];
  // chest: the mark, small and centred (≈ a quarter of the way down from the collar; ≈ 1/6 of the
  // chest width like the reference tees)
  const markW = style === 'staff' ? 0.07 : 0.064;
  const markH = (markW * mvh) / mvw;
  const markTop = style === 'staff' ? 0.425 : 0.41;
  const markArt = artwork(640, (640 * mvh) / mvw, (g2) => {
    g2.scale(640 / mvw, 640 / mvw);
    g2.fill(markPath());
  });
  prints.push({ art: markArt, centre: 'front', top: markTop, width: markW, height: markH });
  // back: CHIRAL SPORTS down the spine, starting a little under the collar (the visible tee runs
  // from ≈ 0.48 at the collar to ≈ 0.12 at the waistband / harness belt; the reference wordmark
  // starts ≈ 1/6 of the way down and covers a bit under half of it)
  const [wvw, wvh] = BRAND.wordmarkViewBox;
  const wmLen = style === 'staff' ? 0.17 : 0.188;
  const wmTop = style === 'staff' ? 0.452 : 0.447;
  const wmW = (wmLen * wvh) / wvw;
  prints.push({ art: verticalArt(wordmarkPath(), wvw, 1200 / wvw), centre: 'back', top: wmTop, width: wmW, height: wmLen });
  if (style === 'staff') {
    // chest: small spaced caps under the mark
    const chestRun = glyphRun('INSTRUCTOR', 26);
    const capH = 0.0098;
    const chestW = (capH * chestRun.width) / GLYPH_H;
    const chestArt = artwork(900, (900 * GLYPH_H) / chestRun.width, (g2) => {
      g2.scale(900 / chestRun.width, 900 / chestRun.width);
      g2.fill(chestRun.path);
    });
    prints.push({ art: chestArt, centre: 'front', top: markTop - markH - 0.016, width: chestW, height: capH });
    // back: continues down the spine under the wordmark at 70 % of its cap height, tighter tracking,
    // ending well above the waistband / harness belt (never cut off)
    const backRun = glyphRun('INSTRUCTOR', 18);
    const backH = wmW * 0.7;
    const backLen = (backH * backRun.width) / GLYPH_H;
    prints.push({ art: verticalArt(backRun.path, backRun.width, 900 / backRun.width), centre: 'back', top: wmTop - wmLen - 0.018, width: backH, height: backLen });
  }
  paintTorsoPrints(g, section, prints);

  const tex = canvasTexture(c, false);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  atlasCache.set(style, tex);
  return tex;
}

// ───────────────────────────── body material ─────────────────────────────

/** Region ids (aAux.x) shared by geometry + palette. */
export const REGION = {
  top: 0,
  bottom: 1,
  skin: 2,
  shoe: 3,
  rubber: 4,
  strap: 5,
  bag: 6,
  bagRim: 7,
  webbing: 8,
  harness: 9,
  metal: 10,
  rope: 11,
  collar: 12,
  cuff: 13,
  top2: 14,
  bottom2: 15,
} as const;
export const REGION_COUNT = 16;

export interface BodyUniforms {
  uPal: { value: THREE.Color[] };
  /** x roughness, y sheen, z metalness, w unused */
  uMat: { value: THREE.Vector4[] };
  uPrint: { value: THREE.Color };
  /** Print colour on the chalk bag (the CHIRAL mark; pink on the black bag by default). */
  uBagPrint: { value: THREE.Color };
  uAccent2: { value: THREE.Color };
  uChalk: { value: THREE.Color };
  uDetail: { value: THREE.Texture | null };
}

export type BodyMaterial = THREE.MeshPhysicalMaterial & { userData: { body: BodyUniforms } };

export function createBodyMaterial(atlas: THREE.Texture): BodyMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0.42, 0.42, 0.45),
    envMapIntensity: 1,
  }) as BodyMaterial;
  const u: BodyUniforms = {
    uPal: { value: Array.from({ length: REGION_COUNT }, () => new THREE.Color(0.5, 0.5, 0.5)) },
    uMat: { value: Array.from({ length: REGION_COUNT }, () => new THREE.Vector4(0.8, 0.6, 0, 0)) },
    uPrint: { value: new THREE.Color(PALETTE.signal) },
    uBagPrint: { value: new THREE.Color(PALETTE.signal) },
    uAccent2: { value: new THREE.Color(PALETTE.signal) },
    uChalk: { value: new THREE.Color(PALETTE.chalk) },
    uDetail: { value: atlas },
  };
  mat.userData.body = u;
  mat.customProgramCacheKey = () => 'jgu-body-v3';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    injectRim(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aAux;
        uniform vec3 uPal[${REGION_COUNT}];
        uniform vec4 uMat[${REGION_COUNT}];
        uniform vec3 uPrint;
        uniform vec3 uBagPrint;
        varying vec3 vRegionColor;
        varying vec3 vPrintColor;
        varying vec4 vMatP;
        varying vec3 vBodyAux;
        varying vec2 vDetailUv;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        int rid = int(aAux.x + 0.5);
        vRegionColor = uPal[rid];
        vPrintColor = (rid == ${REGION.bag} || rid == ${REGION.bagRim}) ? uBagPrint : uPrint;
        vMatP = uMat[rid];
        vBodyAux = aAux.yzw;
        vDetailUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uAccent2;
        uniform vec3 uChalk;
        uniform sampler2D uDetail;
        varying vec3 vRegionColor;
        varying vec3 vPrintColor;
        varying vec4 vMatP;
        varying vec3 vBodyAux;
        varying vec2 vDetailUv;`,
      )
      .replace(
        '#include <color_fragment>',
        `vec4 det = texture2D(uDetail, vDetailUv);
        vec3 bcol = vRegionColor;
        bcol = mix(bcol, vPrintColor, det.g * vBodyAux.z);
        bcol = mix(bcol, uAccent2, det.b);
        bcol *= 1.0 - det.r * 0.55;
        float chalkAmt = vBodyAux.x;
        bcol = mix(bcol, uChalk, chalkAmt);
        bcol *= vBodyAux.y;
        diffuseColor.rgb = bcol;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = clamp(mix(vMatP.x, 0.97, chalkAmt) + det.r * 0.08 - det.g * 0.12, 0.08, 1.0);`,
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMatP.z;')
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_SHEEN
        material.sheenColor *= vMatP.y * (1.0 - chalkAmt) * mix(vec3(1.0), bcol * 2.2 + 0.2, 0.5);
        #endif`,
      );
  };
  return mat;
}

// ───────────────────────────── head materials ─────────────────────────────

export interface FurOptions {
  /** Sheen tint (fur rim light). */
  sheen?: string;
  roughness?: number;
  /** Triplanar pattern texture (R = mask) mixed toward patternColor by aAux.w. */
  pattern?: THREE.Texture | null;
  patternColor?: string;
  /** Pattern scale (repeats per meter). */
  patternScale?: number;
  /**
   * Which aux channel masks the fine strand detail: 'z' (default, with the sheen) or 'w' (skin
   * heads: strands only on hair, sheen still from z; no pattern texture then).
   */
  strandMask?: 'z' | 'w';
}

/**
 * Soft-shaded fur: vertex colours, sheen rim, baked AO (aAux.x), gloss (aAux.y: noses/lips),
 * sheen mask (aAux.z) and an optional triplanar pattern (aAux.w = where it applies).
 */
export function createFurMaterial(o: FurOptions = {}): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: o.roughness ?? 0.82,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(o.sheen ?? '#d9c8b0'),
  });
  const strandW = o.strandMask === 'w';
  const hasPattern = !!o.pattern && !strandW;
  const uniforms = {
    uPattern: { value: o.pattern ?? null },
    uPatternColor: { value: new THREE.Color(o.patternColor ?? '#2a2622') },
    uPatternScale: { value: o.patternScale ?? 9 },
    uStrands: { value: createStrandTexture() },
  };
  mat.customProgramCacheKey = () => `jgu-fur4-${hasPattern ? 1 : 0}${strandW ? 'w' : 'z'}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectRim(shader, 1.2);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aAux;
        varying vec4 vFur;
        varying vec3 vObjPos;
        varying vec3 vObjNrm;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vFur = aAux;
        vObjPos = position;
        vObjNrm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vFur;
        varying vec3 vObjPos;
        varying vec3 vObjNrm;
        uniform sampler2D uStrands;
        ${hasPattern ? 'uniform sampler2D uPattern; uniform vec3 uPatternColor; uniform float uPatternScale;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 an = abs(normalize(vObjNrm));
        an = pow(an, vec3(4.0));
        an /= (an.x + an.y + an.z);
        {
          // fine fur strands: triplanar luminance detail on furry areas (sheen mask)
          vec3 qs = vObjPos * 42.0;
          float st = texture2D(uStrands, qs.zy).r * an.x + texture2D(uStrands, qs.xz).r * an.y + texture2D(uStrands, qs.xy).r * an.z;
          diffuseColor.rgb *= 1.0 + (st - 0.5) * 0.55 * ${strandW ? 'vFur.w' : 'vFur.z'};
          // broad, soft coat variation (the same tile magnified: blurred streaks a few cm long)
          vec3 qm = vObjPos * 3.1;
          float mo = texture2D(uStrands, qm.zy).r * an.x + texture2D(uStrands, qm.xz).r * an.y + texture2D(uStrands, qm.xy).r * an.z;
          diffuseColor.rgb *= 1.0 + (mo - 0.5) * 0.4 * ${strandW ? 'vFur.w' : 'vFur.z'};
        }
        ${
          hasPattern
            ? `{
          vec3 q = vObjPos * uPatternScale;
          float m = texture2D(uPattern, q.zy).r * an.x + texture2D(uPattern, q.xz).r * an.y + texture2D(uPattern, q.xy).r * an.z;
          diffuseColor.rgb = mix(diffuseColor.rgb, uPatternColor, m * vFur.w);
        }`
            : ''
        }
        diffuseColor.rgb *= vFur.x;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(roughness, 0.22, vFur.y);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        material.sheenColor *= vFur.z;`,
      );
  };
  return mat;
}

/** Horns, hooves, beaks, noses: vertex colour with a soft clearcoat; aAux.x = AO, aAux.y = gloss. */
export function createKeratinMaterial(o: { roughness?: number; clearcoat?: number } = {}): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: o.roughness ?? 0.5,
    metalness: 0,
    clearcoat: o.clearcoat ?? 0.35,
    clearcoatRoughness: 0.42,
  });
  mat.customProgramCacheKey = () => 'jgu-keratin2';
  mat.onBeforeCompile = (shader) => {
    injectRim(shader, 0.8);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aAux;\nvarying vec4 vK;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvK = aAux;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vK;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vK.x;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.18, vK.y);');
  };
  return mat;
}

export interface EyeStyle {
  iris: string;
  /** Darker outer iris / limbal ring. */
  ring: string;
  pupil: 'horizontal' | 'round' | 'slit';
  /** Colour around the iris (visible sclera / dark eye surround). */
  surround: string;
  /** Iris radius in UV units (0.5 = full front hemisphere). */
  irisR?: number;
}

const eyeTexCache = new Map<string, THREE.CanvasTexture>();

/** Painted eye: radial iris with fibres, shaped pupil, limbal ring and a crisp catchlight. */
export function createEyeTexture(s: EyeStyle): THREE.CanvasTexture {
  const key = JSON.stringify(s);
  const hit = eyeTexCache.get(key);
  if (hit) return hit;
  const S = 256;
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  const cx = S / 2;
  const cy = S / 2;
  g.fillStyle = s.surround;
  g.fillRect(0, 0, S, S);
  const ir = (s.irisR ?? 0.42) * S;
  // iris gradient
  const grad = g.createRadialGradient(cx, cy, ir * 0.15, cx, cy, ir);
  grad.addColorStop(0, s.iris);
  grad.addColorStop(0.62, s.iris);
  grad.addColorStop(1, s.ring);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, ir, 0, Math.PI * 2);
  g.fill();
  // fibres
  g.save();
  g.globalAlpha = 0.18;
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2 + Math.sin(i * 12.9898) * 0.05;
    g.strokeStyle = i % 2 ? 'rgba(255,240,200,0.9)' : 'rgba(40,20,0,0.9)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * ir * 0.3, cy + Math.sin(a) * ir * 0.3);
    g.lineTo(cx + Math.cos(a) * ir * 0.95, cy + Math.sin(a) * ir * 0.95);
    g.stroke();
  }
  g.restore();
  // limbal ring
  g.strokeStyle = 'rgba(10,6,2,0.55)';
  g.lineWidth = ir * 0.08;
  g.beginPath();
  g.arc(cx, cy, ir * 0.96, 0, Math.PI * 2);
  g.stroke();
  // pupil
  g.fillStyle = '#060504';
  g.beginPath();
  if (s.pupil === 'horizontal') {
    const w = ir * 1.05;
    const h = ir * 0.42;
    g.roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.48);
  } else if (s.pupil === 'slit') {
    g.ellipse(cx, cy, ir * 0.22, ir * 0.72, 0, 0, Math.PI * 2);
  } else {
    g.arc(cx, cy, ir * 0.42, 0, Math.PI * 2);
  }
  g.fill();
  // catchlights (painted so they read under any lighting)
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath();
  g.ellipse(cx - ir * 0.36, cy - ir * 0.38, ir * 0.2, ir * 0.15, -0.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.beginPath();
  g.arc(cx + ir * 0.34, cy + ir * 0.3, ir * 0.07, 0, Math.PI * 2);
  g.fill();
  const t = canvasTexture(c, true);
  eyeTexCache.set(key, t);
  return t;
}

export function createEyeMaterial(s: EyeStyle): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map: createEyeTexture(s),
    roughness: 0.32,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.4,
  });
}

// ───────────────────────────── CHIRAL SPORTS cap ─────────────────────────────

/** Cap texture layout: the crown fills rows 0 … CAP_CROWN_ROWS (v = 1 at the top), the brim the rest. */
export const CAP_TEX = { w: 2048, h: 1024, crownRows: 768 } as const;

export interface CapPrint {
  /** Crown v (0 band → 1 button) of the embroidery's centre line, its width in u, and v-per-u scale (surface aspect). */
  v: number;
  widthU: number;
  vPerU: number;
}

let capTex: THREE.CanvasTexture | null = null;

/**
 * Black six-panel cap (assets/reference/cap-black.webp): cotton twill, six panel seams with top
 * stitching meeting at the button (front centre seam at u = .5), embroidered eyelets, a stitched
 * band, a stitched brim, and CHIRAL SPORTS embroidered in white across the two front panels
 * (official wordmark outlines, satin-stitch shading).
 */
export function createCapTexture(print: CapPrint): THREE.CanvasTexture {
  if (capTex) return capTex;
  const { w: W, h: H, crownRows: CR } = CAP_TEX;
  const c = makeCanvas(W, H);
  const g = ctx2d(c);
  const fabric = '#17181B';
  g.fillStyle = fabric;
  g.fillRect(0, 0, W, H);
  // twill: fine diagonal ribs at very low contrast
  g.save();
  g.globalAlpha = 0.07;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.2;
  for (let x = -H; x < W + H; x += 6) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + H * 0.6, H);
    g.stroke();
  }
  g.restore();
  // soft wear: lighter where the crown is handled (front top) and along the brim edge
  const crownY = (v: number) => CR * (1 - v);
  const uX = (u: number) => u * W;
  const seamLine = (x: number) => {
    g.save();
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(x, crownY(0));
    g.lineTo(x, crownY(1));
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1.6;
    g.setLineDash([7, 5]);
    for (const off of [-11, 11]) {
      g.beginPath();
      g.moveTo(x + off, crownY(0.02));
      g.lineTo(x + off, crownY(0.97));
      g.stroke();
    }
    g.restore();
  };
  for (let k = 0; k <= 6; k++) seamLine(uX(k / 6));
  // canvas rows per canvas column for equal distances on the fabric
  const aspect = (print.vPerU * CR) / W;
  // eyelets: embroidered rings near the top of each panel
  for (let k = 0; k < 6; k++) {
    const x = uX((k + 0.5) / 6);
    const y = crownY(0.8);
    g.fillStyle = 'rgba(0,0,0,0.75)';
    g.beginPath();
    g.ellipse(x, y, 10, 10 * aspect, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(x, y, 12, 12 * aspect, 0, 0, Math.PI * 2);
    g.stroke();
  }
  // band stitching
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 1.6;
  g.setLineDash([7, 5]);
  for (const v of [0.035, 0.06]) {
    g.beginPath();
    g.moveTo(0, crownY(v));
    g.lineTo(W, crownY(v));
    g.stroke();
  }
  // brim: concentric stitch rows following the edge (t = 1 at the outer edge)
  for (let k = 0; k < 7; k++) {
    const y = CR + (H - CR) * (0.42 + k * 0.08);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  g.restore();
  // embroidery: CHIRAL SPORTS centred on the front seam
  {
    const [vw, vh] = BRAND.wordmarkViewBox;
    const tw = print.widthU * W;
    const sx = tw / vw;
    const sy = sx * aspect;
    const th = vh * sy;
    const x0 = uX(0.5) - tw / 2;
    const y0 = crownY(print.v) - th / 2;
    const path = wordmarkPath();
    g.save();
    g.translate(x0, y0);
    g.scale(sx, sy);
    // raised thread shadow, then the satin fill
    g.save();
    g.translate(0, 1.8 / sy);
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fill(path);
    g.restore();
    g.fillStyle = '#F4F2EE';
    g.fill(path);
    // satin stitch direction: fine diagonal shading clipped to the letters
    g.clip(path);
    g.strokeStyle = 'rgba(120,120,128,0.32)';
    g.lineWidth = 0.9 / sx;
    for (let x = -vh; x < vw + vh; x += 3.2 / sx) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + vh * 0.55, vh);
      g.stroke();
    }
    g.restore();
  }
  capTex = canvasTexture(c, true);
  capTex.generateMipmaps = true;
  capTex.minFilter = THREE.LinearMipmapLinearFilter;
  capTex.anisotropy = 8;
  return capTex;
}

/** Cotton-twill cap material (map from createCapTexture), with the shared character rim. */
export function createCapMaterial(map: THREE.Texture): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.94,
    metalness: 0,
    specularIntensity: 0.22,
    sheen: 0.22,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color('#2a2c30'),
    vertexColors: true,
  });
  mat.customProgramCacheKey = () => 'jgu-cap1';
  // a gentle rim only: the flat bill is often seen edge-on, where a full fresnel rim would grey it out
  mat.onBeforeCompile = (shader) => injectRim(shader, 0.3);
  return mat;
}

// ───────────────────────────── pattern textures (triplanar, R = mask) ─────────────────────────────

const patternCache = new Map<string, THREE.CanvasTexture>();

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seamless tile of snow-leopard rosettes (broken rings) or lynx spots. */
export function createPatternTexture(kind: 'rosette' | 'spots'): THREE.CanvasTexture {
  const hit = patternCache.get(kind);
  if (hit) return hit;
  const S = 512;
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const rnd = seeded(kind === 'rosette' ? 911 : 4242);
  const wrapDraw = (x: number, y: number, r: number, fn: (x: number, y: number) => void) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) if (x + dx > -r && x + dx < S + r && y + dy > -r && y + dy < S + r) fn(x + dx, y + dy);
  };
  // jittered grid placement
  const cells = kind === 'rosette' ? 4 : 8;
  const step = S / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x = (i + 0.2 + rnd() * 0.6) * step + (j % 2) * step * 0.5;
      const y = (j + 0.2 + rnd() * 0.6) * step;
      if (kind === 'rosette') {
        const r = step * (0.27 + rnd() * 0.08);
        const blobs = 6 + Math.floor(rnd() * 3);
        const a0 = rnd() * Math.PI * 2;
        wrapDraw(x, y, r * 1.6, (px, py) => {
          g.fillStyle = '#fff';
          for (let k = 0; k < blobs; k++) {
            if (rnd() < 0.18) continue; // broken ring
            const a = a0 + (k / blobs) * Math.PI * 2;
            const bx = px + Math.cos(a) * r;
            const by = py + Math.sin(a) * r;
            g.beginPath();
            g.ellipse(bx, by, r * (0.42 + rnd() * 0.1), r * (0.27 + rnd() * 0.08), a + Math.PI / 2, 0, Math.PI * 2);
            g.fill();
          }
          // faint inner tone
          g.fillStyle = 'rgba(255,255,255,0.3)';
          g.beginPath();
          g.arc(px, py, r * 0.6, 0, Math.PI * 2);
          g.fill();
        });
        // small solid spots between rosettes
        const sx = x + step * 0.5, sy = y + step * 0.45, sr = step * 0.07;
        wrapDraw(sx, sy, sr * 2, (px, py) => {
          g.fillStyle = '#fff';
          g.beginPath();
          g.arc(px, py, sr, 0, Math.PI * 2);
          g.fill();
        });
      } else {
        const r = step * (0.12 + rnd() * 0.1);
        wrapDraw(x, y, r * 2, (px, py) => {
          g.fillStyle = `rgba(255,255,255,${0.75 + rnd() * 0.25})`;
          g.beginPath();
          g.ellipse(px, py, r, r * (0.7 + rnd() * 0.4), rnd() * Math.PI, 0, Math.PI * 2);
          g.fill();
        });
      }
    }
  }
  // soften edges slightly
  const t = canvasTexture(c, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  patternCache.set(kind, t);
  return t;
}

// ───────────────────────────── fur strands (triplanar luminance detail) ─────────────────────────────

let strandTex: THREE.CanvasTexture | null = null;

/** Seamless tile of short soft strands (R = luminance offset around 0.5). */
export function createStrandTexture(): THREE.CanvasTexture {
  if (strandTex) return strandTex;
  const S = 256;
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, S, S);
  const rnd = seeded(77);
  g.lineCap = 'round';
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const len = 6 + rnd() * 12;
    const a = Math.PI * 0.5 + (rnd() - 0.5) * 0.9;
    const light = rnd() > 0.5;
    g.strokeStyle = light ? `rgba(255,255,255,${0.1 + rnd() * 0.16})` : `rgba(0,0,0,${0.1 + rnd() * 0.18})`;
    g.lineWidth = 0.8 + rnd() * 1.4;
    for (const dx of [-S, 0, S]) {
      for (const dy of [-S, 0, S]) {
        g.beginPath();
        g.moveTo(x + dx, y + dy);
        g.quadraticCurveTo(x + dx + Math.cos(a) * len * 0.5 + 2, y + dy + Math.sin(a) * len * 0.5, x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
        g.stroke();
      }
    }
  }
  strandTex = canvasTexture(c, false);
  strandTex.wrapS = strandTex.wrapT = THREE.RepeatWrapping;
  return strandTex;
}

// ───────────────────────────── rope (kernmantle sheath) ─────────────────────────────

const ropeTex = new Map<string, THREE.CanvasTexture>();

/**
 * Twisted bicolour kernmantle sheath: carriers in the main colour (signal orange by default) in a
 * twill with bone flecks and a darker tracer. u wraps around the rope, v runs along it.
 */
export function createRopeTexture(main: string = PALETTE.signal): THREE.CanvasTexture {
  const hit = ropeTex.get(main);
  if (hit) return hit;
  const W = 64;
  const H = 128;
  const c = makeCanvas(W, H);
  const g = ctx2d(c);
  const base = new THREE.Color(main);
  const hi = '#' + base.clone().lerp(new THREE.Color('#ffffff'), 0.18).getHexString();
  const lo = '#' + base.clone().multiplyScalar(0.82).getHexString();
  g.fillStyle = main;
  g.fillRect(0, 0, W, H);
  // braid: two families of diagonal strands crossing (twill), drawn as short slanted lozenges
  const strands = 8;
  for (let fam = 0; fam < 2; fam++) {
    for (let s = 0; s < strands; s++) {
      for (let k = -2; k < 10; k++) {
        const u = ((s / strands) * W + (fam ? -k : k) * (W / strands)) % W;
        const v = k * (H / 8) + (fam ? H / 16 : 0);
        const bone = (s + fam * 3) % 4 === 0;
        const tracer = fam === 1 && s % 8 === 5;
        const col = tracer ? '#3a2a24' : bone ? PALETTE.bone : fam ? hi : lo;
        for (const du of [-W, 0, W]) {
          g.save();
          g.translate(u + du, v);
          g.rotate(fam ? -0.62 : 0.62);
          const grd = g.createLinearGradient(0, -5, 0, 5);
          grd.addColorStop(0, 'rgba(0,0,0,0.35)');
          grd.addColorStop(0.5, col);
          grd.addColorStop(1, 'rgba(0,0,0,0.35)');
          g.fillStyle = grd;
          g.beginPath();
          g.ellipse(0, 0, 9, 3.6, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
      }
    }
  }
  const t = canvasTexture(c, true);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  ropeTex.set(main, t);
  return t;
}

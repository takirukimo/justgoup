// Procedural "photos" of a gym boulder wall, for the detector's tests and the dev harness (no real
// photos are bundled). A wall is painted square-on (plywood grain, panel seams, T-nuts, chalk, soft hold
// shadows, shaded glossy holds of the route colour plus other routes, start tape, a volume), then shot
// through a pinhole camera from below / the side (an exact perspective with a phone's focal length),
// with a colour cast, vignette and sensor noise. Only dev / test code imports this module.

import { Rng } from '../core/rng';
import type { Pt, Quad, RGBAImage } from './types';

export type SynthShape = 'blob' | 'crescent' | 'pocket' | 'disc' | 'rail' | 'tape' | 'volume';

export interface SynthHold {
  /** Wall metres: x from the wall's centre, y up from the floor. */
  x: number;
  y: number;
  /** Half the longest dimension (m). */
  r: number;
  /** Cross / long dimension ratio (≤ 1). */
  aspect: number;
  /** Rotation (radians, wall plane). */
  rot: number;
  color: string;
  /** Part of the route of the tapped colour. */
  route: boolean;
  shape: SynthShape;
  seed: number;
}

export interface SynthOptions {
  seed?: number;
  /** Wall size (m). */
  wallW?: number;
  wallH?: number;
  /** Painting resolution of the square-on wall (px per m). */
  ppm?: number;
  /** Route colour (hex). */
  route?: string;
  routeCount?: number;
  distractors?: number;
  tape?: boolean;
  /** The tape touches the start hold (the detector must peel it off). */
  tapeTouch?: boolean;
  /** A volume: none, another colour, or the route's colour (the shape filter must catch it). */
  volume?: 'none' | 'other' | 'route';
  /** Two route holds touching each other (the split test). */
  touching?: boolean;
  wall?: 'charcoal' | 'grey' | 'white';
  /** Camera: square on, from below, from below-left. */
  view?: 'front' | 'below' | 'left';
  photoW?: number;
  photoH?: number;
  /** Multiplicative colour cast (warm LEDs etc.). */
  cast?: [number, number, number];
  noise?: number;
}

export interface SynthResult {
  /** The wall painted square-on (wallW·ppm × wallH·ppm). */
  wall: RGBAImage;
  /** The photo. */
  photo: RGBAImage;
  /** The wall's corners in the photo (TL, TR, BR, BL). */
  quad: Quad;
  holds: SynthHold[];
  /** Focal length used (px). */
  focal: number;
  wallW: number;
  wallH: number;
}

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Hash-based value noise (0..1). */
function makeNoise(seed: number): (x: number, y: number) => number {
  const h = (i: number, j: number): number => {
    let t = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number): number => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = h(i, j) + (h(i + 1, j) - h(i, j)) * sx;
    const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}

const OTHER_COLORS = ['#2F6FEB', '#2FB36D', '#E5433B', '#8B5CF6', '#FF7A1A', '#F06EA9', '#EDEDED', '#1E1F22', '#21B8B0', '#F2C230'];

/** Lay out a route (bottom → top) and other routes' holds, without overlaps. */
export function synthLayout(o: SynthOptions = {}): SynthHold[] {
  const rng = new Rng(o.seed ?? 7);
  const W = o.wallW ?? 4.6;
  const H = o.wallH ?? 4.5;
  const route = o.route ?? '#F2C230';
  const holds: SynthHold[] = [];
  const free = (x: number, y: number, r: number, pad = 0.06): boolean =>
    Math.abs(x) < W / 2 - r - 0.08 && y > r + 0.25 && y < H - r - 0.08 && holds.every((h) => Math.hypot(h.x - x, h.y - y) > h.r + r + pad);
  const n = o.routeCount ?? 14;
  // the line: zig-zags up the wall from a start at 1.3 m to a top near the wall's top
  const shapes: SynthShape[] = ['blob', 'crescent', 'blob', 'pocket', 'disc', 'rail', 'blob', 'crescent', 'blob', 'disc', 'blob', 'crescent', 'pocket', 'blob'];
  let cx = rng.range(-0.8, 0.8);
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    const y = 1.2 + t * (H - 1.55);
    const shape = shapes[i % shapes.length];
    const r = shape === 'rail' ? rng.range(0.1, 0.13) : shape === 'crescent' ? rng.range(0.045, 0.07) : shape === 'disc' ? rng.range(0.06, 0.09) : rng.range(0.05, 0.11);
    const aspect = shape === 'rail' ? 0.28 : shape === 'crescent' ? 0.5 : rng.range(0.6, 0.95);
    for (let k = 0; k < 40; k++) {
      const x = cx + rng.range(-0.55, 0.55);
      const yy = y + rng.range(-0.12, 0.12);
      if (free(x, yy, r, 0.1)) {
        holds.push({ x, y: yy, r, aspect, rot: rng.range(-0.5, 0.5), color: route, route: true, shape, seed: rng.int(1, 1e9) });
        cx = x;
        break;
      }
    }
  }
  if (o.tape ?? true) {
    // start tape under the lowest big route hold: a little gap, or stuck right against it
    const start = holds.filter((h) => h.route && h.r > 0.04).sort((a, b) => a.y - b.y)[0];
    if (start) {
      const gap = o.tapeTouch ? -0.01 : 0.035;
      holds.push({ x: start.x + 0.02, y: start.y - start.r * start.aspect - gap - 0.075, r: 0.075, aspect: 0.17, rot: 1.45, color: route, route: false, shape: 'tape', seed: 1 });
    }
  }
  // foot chips of the route below the start
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 40; k++) {
      const x = rng.range(-1.2, 1.2);
      const y = rng.range(0.35, 1.0);
      const r = rng.range(0.022, 0.032);
      if (free(x, y, r, 0.1)) {
        holds.push({ x, y, r, aspect: 0.7, rot: rng.range(-0.4, 0.4), color: route, route: true, shape: 'blob', seed: rng.int(1, 1e9) });
        break;
      }
    }
  }
  if (o.touching) {
    // two route holds bolted right next to each other (touching)
    for (let k = 0; k < 80; k++) {
      const x = rng.range(-1.4, 1.4);
      const y = rng.range(1.5, H - 1.2);
      if (free(x, y, 0.2, 0.08)) {
        holds.push({ x: x - 0.065, y, r: 0.07, aspect: 0.95, rot: 0, color: route, route: true, shape: 'disc', seed: rng.int(1, 1e9) });
        holds.push({ x: x + 0.075, y: y + 0.01, r: 0.08, aspect: 0.95, rot: 0, color: route, route: true, shape: 'disc', seed: rng.int(1, 1e9) });
        break;
      }
    }
  }
  const vol = o.volume ?? 'other';
  if (vol !== 'none') {
    for (let k = 0; k < 60; k++) {
      const x = rng.range(-1.4, 1.4);
      const y = rng.range(1.2, H - 1.3);
      if (free(x, y, 0.42, 0.04)) {
        holds.push({ x, y, r: 0.42, aspect: 0.75, rot: rng.range(-0.3, 0.3), color: vol === 'route' ? route : '#E9E5DD', route: false, shape: 'volume', seed: rng.int(1, 1e9) });
        break;
      }
    }
  }
  const others = OTHER_COLORS.filter((c) => c.toLowerCase() !== route.toLowerCase());
  for (let i = 0; i < (o.distractors ?? 14); i++) {
    for (let k = 0; k < 40; k++) {
      const x = rng.range(-W / 2 + 0.2, W / 2 - 0.2);
      const y = rng.range(0.4, H - 0.3);
      const r = rng.range(0.03, 0.1);
      if (free(x, y, r, 0.06)) {
        holds.push({ x, y, r, aspect: rng.range(0.5, 0.95), rot: rng.range(-1, 1), color: rng.pick(others), route: false, shape: rng.pick(['blob', 'crescent', 'disc'] as SynthShape[]), seed: rng.int(1, 1e9) });
        break;
      }
    }
  }
  return holds;
}

/** Paint the wall square-on. */
export function paintWall(holds: readonly SynthHold[], o: SynthOptions = {}): RGBAImage {
  const W = o.wallW ?? 4.6;
  const H = o.wallH ?? 4.5;
  const ppm = o.ppm ?? 200;
  const w = Math.round(W * ppm);
  const h = Math.round(H * ppm);
  const data = new Uint8ClampedArray(w * h * 4);
  const seed = o.seed ?? 7;
  const noise = makeNoise(seed);
  const tone = o.wall ?? 'charcoal';
  const base: [number, number, number] = tone === 'grey' ? [128, 130, 133] : tone === 'white' ? [214, 212, 206] : [47, 49, 53];
  // plywood, seams, T-nuts, chalk haze
  for (let y = 0; y < h; y++) {
    const wy = H - (y + 0.5) / ppm;
    for (let x = 0; x < w; x++) {
      const wx = (x + 0.5) / ppm - W / 2;
      const grain = noise(wx * 3, wy * 40) * 0.5 + noise(wx * 12, wy * 90) * 0.5;
      let k = 0.9 + grain * 0.16 + (noise(wx * 0.7, wy * 0.7) - 0.5) * 0.1;
      // panel seams every 1.22 m across and 1.5 m up
      const sx = Math.abs(((wx + W / 2) % 1.22) - 0.0);
      const sy = Math.abs(wy % 1.5);
      if (sx < 0.004 || sy < 0.004) k *= 0.55;
      // T-nuts on a staggered 0.2 m lattice
      const row = Math.round((wy - 0.1) / 0.2);
      const off = row % 2 ? 0.1 : 0;
      const tx = wx - (Math.round((wx - off) / 0.2) * 0.2 + off);
      const ty = wy - (row * 0.2 + 0.1);
      if (tx * tx + ty * ty < 0.0085 * 0.0085) k *= tone === 'charcoal' ? 0.45 : 0.35;
      const o4 = (y * w + x) * 4;
      data[o4] = base[0] * k;
      data[o4 + 1] = base[1] * k;
      data[o4 + 2] = base[2] * k;
      data[o4 + 3] = 255;
    }
  }
  const px = (wx: number): number => (wx + W / 2) * ppm;
  const py = (wy: number): number => (H - wy) * ppm;
  // chalk smudges around route holds, soft shadows under every hold
  for (const hd of holds) {
    const cx = px(hd.x);
    const cy = py(hd.y);
    const R = hd.r * ppm;
    if (hd.route && hd.shape !== 'tape') {
      const rr = R * 2.2;
      forBox(cx, cy, rr, w, h, (x, y) => {
        const d = Math.hypot(x - cx, (y - cy) * 1.3) / rr;
        if (d >= 1) return;
        const a = (1 - d) * (1 - d) * 0.22 * noise(x * 0.08, y * 0.08);
        const o4 = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) data[o4 + c] += (236 - data[o4 + c]) * a;
      });
    }
    const sR = R * (hd.shape === 'volume' ? 1.15 : 1.25);
    const ox = cx + R * 0.12;
    const oy = cy + R * 0.28;
    forBox(ox, oy, sR, w, h, (x, y) => {
      const d = Math.hypot(x - ox, y - oy) / sR;
      if (d >= 1) return;
      const a = 0.55 * (1 - d * d);
      const o4 = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[o4 + c] *= 1 - a;
    });
  }
  // the holds
  for (const hd of holds) paintHold(data, w, h, ppm, px(hd.x), py(hd.y), hd, noise);
  return { width: w, height: h, data };
}

function forBox(cx: number, cy: number, r: number, w: number, h: number, fn: (x: number, y: number) => void): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(x, y);
}

/** Paint one shaded hold. (cx, cy) in wall-image px. */
function paintHold(data: Uint8ClampedArray, w: number, h: number, ppm: number, cx: number, cy: number, hd: SynthHold, noise: (x: number, y: number) => number): void {
  const [cr, cg, cb] = hexRgb(hd.color);
  const a = hd.r * ppm; // semi-axis along the long direction
  const b = a * hd.aspect;
  const cs = Math.cos(hd.rot);
  const sn = Math.sin(hd.rot);
  const rng = new Rng(hd.seed);
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const p3 = rng.range(0, 6.28);
  const wob = hd.shape === 'disc' || hd.shape === 'tape' ? 0 : 1;
  // light from the top-left, a little in front
  const lx = -0.35;
  const ly = -0.55;
  const lz = 0.76;
  const R = Math.max(a, b) * 1.3 + 2;
  forBox(cx, cy, R, w, h, (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    // hold-local coordinates (u along the long axis)
    const u = dx * cs + dy * sn;
    const v = -dx * sn + dy * cs;
    let rho: number;
    let shade = 1;
    if (hd.shape === 'tape') {
      const qu = Math.abs(u) / a;
      const qv = Math.abs(v) / b;
      if (qu > 1 || qv > 1) return;
      rho = Math.max(qu, qv) * 0.3;
    } else if (hd.shape === 'volume') {
      // a trapezoid-ish volume with flat facets
      const qu = u / a;
      const qv = v / b;
      if (Math.abs(qv) > 1 || Math.abs(qu) > 1 - 0.35 * (qv + 1) * 0.5) return;
      const facet = qu > 0 ? (qv > 0 ? 0.78 : 1.0) : qv > 0 ? 0.62 : 0.88;
      shade = facet;
      rho = 0;
    } else {
      const phi = Math.atan2(v / b, u / a);
      const rf = 1 + wob * (0.1 * Math.cos(2 * phi + p1) + 0.06 * Math.cos(3 * phi + p2) + 0.035 * Math.cos(5 * phi + p3));
      rho = Math.hypot(u / a, v / b) / rf;
      if (rho > 1) return;
      if (hd.shape === 'crescent') {
        // an edge: the top is cut by an offset ellipse (the incut lip)
        const iu = u / (a * 0.95);
        const iv = (v + b * 0.85) / (b * 1.05);
        if (iu * iu + iv * iv < 1) return;
      }
    }
    // dome height field → normal → Lambert + Blinn specular
    const hgt = Math.sqrt(Math.max(0, 1 - rho * rho));
    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (hd.shape !== 'volume' && hd.shape !== 'tape') {
      const g = rho / Math.max(0.05, hgt);
      const len = Math.hypot(dx, dy) || 1;
      nx = (dx / len) * g * 0.8;
      ny = (dy / len) * g * 0.8;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
    const hx = lx;
    const hy = ly;
    const hz = lz + 1;
    const hl = Math.hypot(hx, hy, hz);
    const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 60) * (hd.shape === 'volume' ? 0.15 : 0.75);
    const tex = 0.94 + noise(x * 0.9, y * 0.9) * 0.12;
    let k = (0.36 + 0.78 * diff) * shade * tex;
    // pocket: a dark mouth
    if (hd.shape === 'pocket') {
      const qu = u / (a * 0.42);
      const qv = (v + b * 0.12) / (b * 0.32);
      if (qu * qu + qv * qv < 1) k *= 0.18;
    }
    // edge darkening (ambient occlusion where the hold meets the wall)
    if (rho > 0.82 && hd.shape !== 'volume') k *= 1 - (rho - 0.82) * 1.6;
    const o4 = (y * w + x) * 4;
    let r = cr * k + 255 * spec;
    let g = cg * k + 255 * spec;
    let bb = cb * k + 255 * spec;
    // chalk on the top of route holds
    if (hd.route && hd.shape !== 'tape' && v < -b * 0.25 && noise(x * 0.35, y * 0.35) > 0.62) {
      r += (238 - r) * 0.45;
      g += (236 - g) * 0.45;
      bb += (232 - bb) * 0.45;
    }
    data[o4] = r;
    data[o4 + 1] = g;
    data[o4 + 2] = bb;
  });
}

/** Camera for a view: position, look target, and the focal that frames the wall. */
function camera(view: SynthOptions['view'], W: number, H: number): { pos: [number, number, number]; look: [number, number, number] } {
  if (view === 'front') return { pos: [0, H / 2, 6.2], look: [0, H / 2, 0] };
  if (view === 'left') return { pos: [-1.6, 1.4, 5.2], look: [0.1, H / 2 + 0.1, 0] };
  return { pos: [0.25, 1.35, 5.0], look: [0, H / 2 + 0.1, 0] };
}

/** Shoot the painted wall through a pinhole camera into a photo. */
export function shootPhoto(wall: RGBAImage, o: SynthOptions = {}): { photo: RGBAImage; quad: Quad; focal: number } {
  const W = o.wallW ?? 4.6;
  const H = o.wallH ?? 4.5;
  const PW = o.photoW ?? 900;
  const PH = o.photoH ?? 1200;
  const F = 0.78 * Math.max(PW, PH);
  const cam = camera(o.view ?? 'below', W, H);
  // camera basis
  let [fx, fy, fz] = [cam.look[0] - cam.pos[0], cam.look[1] - cam.pos[1], cam.look[2] - cam.pos[2]];
  let fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = f × up(0,1,0)
  let rx = -fz;
  let ry = 0;
  let rz = fx;
  fl = Math.hypot(rx, ry, rz);
  rx /= fl;
  ry /= fl;
  rz /= fl;
  // up = r × f
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  // pull the camera back until the wall fills ~84% of the frame's height
  let pos = [...cam.pos];
  const project = (X: number, Y: number, Z: number): Pt => {
    const dx = X - pos[0];
    const dy = Y - pos[1];
    const dz = Z - pos[2];
    const xc = dx * rx + dy * ry + dz * rz;
    const yc = dx * ux + dy * uy + dz * uz;
    const zc = dx * fx + dy * fy + dz * fz;
    return { x: PW / 2 + (F * xc) / zc, y: PH / 2 - (F * yc) / zc };
  };
  for (let it = 0; it < 6; it++) {
    const q = [project(-W / 2, H, 0), project(W / 2, H, 0), project(W / 2, 0, 0), project(-W / 2, 0, 0)];
    const ys = q.map((p) => p.y);
    const xs = q.map((p) => p.x);
    const fill = Math.max((Math.max(...ys) - Math.min(...ys)) / (PH * 0.84), (Math.max(...xs) - Math.min(...xs)) / (PW * 0.92));
    pos = [cam.look[0] + (pos[0] - cam.look[0]) * fill, cam.look[1] + (pos[1] - cam.look[1]) * fill, cam.look[2] + (pos[2] - cam.look[2]) * fill];
  }
  const quad: Quad = [project(-W / 2, H, 0), project(W / 2, H, 0), project(W / 2, 0, 0), project(-W / 2, 0, 0)];
  const data = new Uint8ClampedArray(PW * PH * 4);
  const ppmW = wall.width / W;
  const ppmH = wall.height / H;
  const cast = o.cast ?? [1.06, 1.0, 0.9];
  const amp = o.noise ?? 7;
  const rng = new Rng((o.seed ?? 7) * 31 + 5);
  const wd = wall.data;
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      // ray through the pixel
      const cx = (x + 0.5 - PW / 2) / F;
      const cy = -(y + 0.5 - PH / 2) / F;
      const dx = fx + rx * cx + ux * cy;
      const dy = fy + ry * cx + uy * cy;
      const dz = fz + rz * cx + uz * cy;
      let r = 20;
      let g = 21;
      let b = 24;
      if (dz < -1e-6) {
        const t = -pos[2] / dz;
        const X = pos[0] + dx * t;
        const Y = pos[1] + dy * t;
        if (Y < 0) {
          // crash pads: charcoal with a pink stripe
          const tf = -pos[1] / dy;
          const Z = pos[2] + dz * tf;
          const stripe = Math.abs(Z - 1.1) < 0.06;
          [r, g, b] = stripe ? [190, 58, 74] : [33, 35, 38];
        } else if (Y > H) {
          const k = Math.max(0, 1 - (Y - H) / 3);
          [r, g, b] = [14 + 20 * k, 15 + 20 * k, 17 + 22 * k];
        } else if (Math.abs(X) > W / 2) {
          // the neighbouring wall section
          const k = 0.75 + 0.1 * Math.sin(Y * 3);
          [r, g, b] = [70 * k, 72 * k, 78 * k];
        } else {
          const wx = (X + W / 2) * ppmW - 0.5;
          const wy = (H - Y) * ppmH - 0.5;
          const x0 = Math.max(0, Math.min(wall.width - 2, Math.floor(wx)));
          const y0 = Math.max(0, Math.min(wall.height - 2, Math.floor(wy)));
          const ax = Math.max(0, Math.min(1, wx - x0));
          const ay = Math.max(0, Math.min(1, wy - y0));
          const i00 = (y0 * wall.width + x0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + wall.width * 4;
          const i11 = i01 + 4;
          const s = (c: number): number => {
            const t0 = wd[i00 + c] + (wd[i10 + c] - wd[i00 + c]) * ax;
            const t1 = wd[i01 + c] + (wd[i11 + c] - wd[i01 + c]) * ax;
            return t0 + (t1 - t0) * ay;
          };
          r = s(0);
          g = s(1);
          b = s(2);
        }
      }
      // lens vignette, colour cast, noise
      const vx = (x / PW - 0.5) * 2;
      const vy = (y / PH - 0.5) * 2;
      const vig = 1 - 0.22 * (vx * vx + vy * vy) * 0.5;
      const nz = (rng.next() + rng.next() - 1) * amp;
      const o4 = (y * PW + x) * 4;
      data[o4] = r * cast[0] * vig + nz;
      data[o4 + 1] = g * cast[1] * vig + nz;
      data[o4 + 2] = b * cast[2] * vig + nz;
      data[o4 + 3] = 255;
    }
  }
  return { photo: { width: PW, height: PH, data }, quad, focal: F };
}

/** A whole synthetic photo of a problem. */
export function synthPhoto(o: SynthOptions = {}): SynthResult {
  const holds = synthLayout(o);
  const wall = paintWall(holds, o);
  const { photo, quad, focal } = shootPhoto(wall, o);
  return { wall, photo, quad, holds, focal, wallW: o.wallW ?? 4.6, wallH: o.wallH ?? 4.5 };
}

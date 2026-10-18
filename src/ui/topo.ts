// Procedural topographic contour lines (marching squares over a seeded height field), output as
// an SVG string. Generated once at mount and used as CSS background images (cached by the
// browser's image pipeline, so no per-frame cost). Allocation-light: typed arrays throughout.

import { Rng } from '../core/rng';

export interface TopoOptions {
  width: number;
  height: number;
  seed: number;
  /** Grid cell size in px (smaller = smoother lines, bigger SVG). */
  cell?: number;
  /** Number of contour levels between min and max height. */
  levels?: number;
  /** Every n-th level is drawn as an index contour (heavier). */
  majorEvery?: number;
  /** Feature scale of the terrain in px. */
  scale?: number;
  stroke?: string;
  minorWidth?: number;
  majorWidth?: number;
  minorOpacity?: number;
  majorOpacity?: number;
}

function makeNoise(seed: number): (x: number, y: number) => number {
  const rng = new Rng(seed);
  const N = 256;
  const perm = new Uint8Array(N * 2);
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    perm[i] = i;
    const a = rng.next() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < N; i++) perm[i + N] = perm[i];
  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const h00 = perm[perm[X] + Y];
    const h10 = perm[perm[X + 1] + Y];
    const h01 = perm[perm[X] + Y + 1];
    const h11 = perm[perm[X + 1] + Y + 1];
    const n00 = gx[h00] * xf + gy[h00] * yf;
    const n10 = gx[h10] * (xf - 1) + gy[h10] * yf;
    const n01 = gx[h01] * xf + gy[h01] * (yf - 1);
    const n11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    return (n00 + u * (n10 - n00)) * (1 - v) + (n01 + u * (n11 - n01)) * v;
  };
}

/** Build the contour SVG markup. */
export function topoSvg(o: TopoOptions): string {
  const W = o.width;
  const H = o.height;
  const cell = o.cell ?? 8;
  const levels = o.levels ?? 18;
  const majorEvery = o.majorEvery ?? 5;
  const scale = o.scale ?? 260;
  const stroke = o.stroke ?? '#E9E5DD';
  const nx = Math.ceil(W / cell) + 1;
  const ny = Math.ceil(H / cell) + 1;
  const noise = makeNoise(o.seed);
  const rng = new Rng(o.seed ^ 0x5bd1e995);

  // Height field: fBm + a few broad "summits" so the contours form closed rings like real massifs.
  const peaks: { x: number; y: number; r: number; a: number }[] = [];
  for (let i = 0; i < 3; i++) peaks.push({ x: rng.range(0.1, 0.9) * W, y: rng.range(0.1, 0.9) * H, r: rng.range(0.25, 0.5) * Math.max(W, H), a: rng.range(0.5, 1.1) });
  const field = new Float32Array(nx * ny);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const px = i * cell;
      const py = j * cell;
      let v = 0;
      let amp = 1;
      let f = 1 / scale;
      for (let k = 0; k < 4; k++) {
        v += amp * noise(px * f + k * 17.3, py * f - k * 9.1);
        amp *= 0.5;
        f *= 2.03;
      }
      for (let p = 0; p < peaks.length; p++) {
        const pk = peaks[p];
        const dx = (px - pk.x) / pk.r;
        const dy = (py - pk.y) / pk.r;
        v += pk.a * Math.exp(-(dx * dx + dy * dy) * 2.2);
      }
      field[j * nx + i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }

  // Edge keys: horizontal edge (i,j)→(i+1,j) = 2·(j·nx+i); vertical (i,j)→(i,j+1) = 2·(j·nx+i)+1.
  const nEdges = nx * ny * 2;
  const ex = new Float32Array(nEdges);
  const ey = new Float32Array(nEdges);
  const stamp = new Int32Array(nEdges); // level that last computed / linked this edge
  const adjA = new Int32Array(nEdges);
  const adjB = new Int32Array(nEdges);
  let segA = new Int32Array(4096);
  let segB = new Int32Array(4096);
  let used = new Uint8Array(4096);
  const chain: number[] = [];
  const minor: string[] = [];
  const major: string[] = [];

  for (let L = 1; L < levels; L++) {
    const iso = lo + ((hi - lo) * L) / levels;
    let nSeg = 0;

    const point = (key: number): void => {
      if (stamp[key] === L) return;
      stamp[key] = L;
      adjA[key] = -1;
      adjB[key] = -1;
      const base = key >> 1;
      const i = base % nx;
      const j = (base - i) / nx;
      const a = field[base];
      if (key & 1) {
        const t = (iso - a) / (field[base + nx] - a);
        ex[key] = i * cell;
        ey[key] = (j + t) * cell;
      } else {
        const t = (iso - a) / (field[base + 1] - a);
        ex[key] = (i + t) * cell;
        ey[key] = j * cell;
      }
    };
    const link = (key: number, s: number): void => {
      if (adjA[key] < 0) adjA[key] = s;
      else adjB[key] = s;
    };
    const seg = (a: number, b: number): void => {
      if (nSeg >= segA.length) {
        const na = new Int32Array(segA.length * 2);
        na.set(segA);
        segA = na;
        const nb = new Int32Array(segB.length * 2);
        nb.set(segB);
        segB = nb;
        used = new Uint8Array(segA.length);
      }
      point(a);
      point(b);
      segA[nSeg] = a;
      segB[nSeg] = b;
      link(a, nSeg);
      link(b, nSeg);
      nSeg++;
    };

    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const b = j * nx + i;
        const c = (field[b] > iso ? 8 : 0) | (field[b + 1] > iso ? 4 : 0) | (field[b + nx + 1] > iso ? 2 : 0) | (field[b + nx] > iso ? 1 : 0);
        if (c === 0 || c === 15) continue;
        const top = b * 2;
        const bottom = (b + nx) * 2;
        const left = b * 2 + 1;
        const right = (b + 1) * 2 + 1;
        switch (c) {
          case 1: case 14: seg(left, bottom); break;
          case 2: case 13: seg(bottom, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(top, right); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, top); break;
          case 5: seg(left, top); seg(bottom, right); break;
          case 10: seg(left, bottom); seg(top, right); break;
        }
      }
    }

    used.fill(0, 0, nSeg);
    const out = L % majorEvery === 0 ? major : minor;
    for (let s0 = 0; s0 < nSeg; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      chain.length = 0;
      chain.push(segA[s0], segB[s0]);
      // extend from the tail, then from the head
      for (let dir = 0; dir < 2; dir++) {
        for (;;) {
          const end = dir === 0 ? chain[chain.length - 1] : chain[0];
          let next = adjA[end];
          if (next < 0 || used[next]) next = adjB[end];
          if (next < 0 || used[next]) break;
          used[next] = 1;
          const other = segA[next] === end ? segB[next] : segA[next];
          if (dir === 0) chain.push(other);
          else chain.unshift(other);
        }
      }
      if (chain.length < 4) continue;
      // Smooth with quadratic curves through segment midpoints; integer coordinates keep it compact.
      let d = `M${Math.round(ex[chain[0]])} ${Math.round(ey[chain[0]])}`;
      for (let k = 1; k < chain.length - 1; k++) {
        const p = chain[k];
        const q = chain[k + 1];
        d += `Q${Math.round(ex[p])} ${Math.round(ey[p])} ${Math.round((ex[p] + ex[q]) / 2)} ${Math.round((ey[p] + ey[q]) / 2)}`;
      }
      const last = chain[chain.length - 1];
      d += `L${Math.round(ex[last])} ${Math.round(ey[last])}`;
      out.push(d);
    }
  }

  const mw = o.minorWidth ?? 0.75;
  const Mw = o.majorWidth ?? 1.2;
  const mo = o.minorOpacity ?? 0.5;
  const Mo = o.majorOpacity ?? 0.9;
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}' height='${H}' preserveAspectRatio='xMidYMid slice'>` +
    `<g fill='none' stroke='${stroke}' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path stroke-width='${mw}' stroke-opacity='${mo}' d='${minor.join('')}'/>` +
    `<path stroke-width='${Mw}' stroke-opacity='${Mo}' d='${major.join('')}'/>` +
    `</g></svg>`
  );
}

/** CSS url() for an SVG string (minimal escaping: far smaller than encodeURIComponent). */
export function svgUrl(svg: string): string {
  const body = svg.replace(/"/g, "'").replace(/[%#<>{}\n\r]/g, (c) => encodeURIComponent(c));
  return `url("data:image/svg+xml;charset=utf-8,${body}")`;
}

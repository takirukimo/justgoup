// Per-vertex mean curvature for hold meshes (research §4.4: radiance scaling, baked on the CPU, stable
// at every LOD). A thin crimp lip is 3–5 px on a phone, far too small for screen-space tricks, but its
// geometry is a tight convex roll: the curvature finds exactly the edges a finger can use.
//
//   κ_i = −2 · mean_j [ n_i · (p_j − p_i) / |p_j − p_i|² ]   (1/R on a sphere; > 0 convex, < 0 concave)
//   aCurv_i = clamp(κ_i · scale, −1, 1)                      (scale 0.015: a 1.5 cm radius saturates)
//
// Neighbours come from the triangles; vertices that share a position (UV seams, hard edges, faceted
// volumes, merged bolts) are welded first, so a sharp edge between two flat faces still reads as a
// ridge from both sides.

import * as THREE from 'three';

/** Weld tolerance (m): positions closer than this count as one point. */
const WELD = 5e-5;

/**
 * Writes `aCurv` (one float per vertex, −1..1) into `geo` and returns it. `scale` maps 1/R (1/m) to
 * the attribute (0.015 → radii ≤ 1.5 cm saturate).
 */
export function bakeCurvature(geo: THREE.BufferGeometry, scale = 0.015): THREE.BufferAttribute {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const n = pos.count;
  // weld: one id per distinct position
  const weld = new Int32Array(n);
  const ids = new Map<string, number>();
  let groups = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) / WELD)},${Math.round(pos.getY(i) / WELD)},${Math.round(pos.getZ(i) / WELD)}`;
    let g = ids.get(k);
    if (g === undefined) {
      g = groups++;
      ids.set(k, g);
    }
    weld[i] = g;
  }
  // welded position per group (first vertex) + neighbour sets from the triangle edges
  const gp = new Float64Array(groups * 3);
  const seen = new Uint8Array(groups);
  for (let i = 0; i < n; i++) {
    const g = weld[i];
    if (seen[g]) continue;
    seen[g] = 1;
    gp[g * 3] = pos.getX(i);
    gp[g * 3 + 1] = pos.getY(i);
    gp[g * 3 + 2] = pos.getZ(i);
  }
  const nb: Set<number>[] = Array.from({ length: groups }, () => new Set<number>());
  const index = geo.getIndex();
  const tri = index ? index.count : n;
  const at = (k: number): number => (index ? index.getX(k) : k);
  for (let t = 0; t + 2 < tri; t += 3) {
    const a = weld[at(t)];
    const b = weld[at(t + 1)];
    const c = weld[at(t + 2)];
    if (a !== b) {
      nb[a].add(b);
      nb[b].add(a);
    }
    if (b !== c) {
      nb[b].add(c);
      nb[c].add(b);
    }
    if (a !== c) {
      nb[a].add(c);
      nb[c].add(a);
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = weld[i];
    const set = nb[g];
    if (!set.size) continue;
    let nx = nrm.getX(i);
    let ny = nrm.getY(i);
    let nz = nrm.getZ(i);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const px = gp[g * 3];
    const py = gp[g * 3 + 1];
    const pz = gp[g * 3 + 2];
    let sum = 0;
    for (const j of set) {
      const dx = gp[j * 3] - px;
      const dy = gp[j * 3 + 1] - py;
      const dz = gp[j * 3 + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-14) continue;
      sum += (nx * dx + ny * dy + nz * dz) / d2;
    }
    const k = (-2 * sum) / set.size;
    out[i] = Math.max(-1, Math.min(1, k * scale));
  }
  const attr = new THREE.BufferAttribute(out, 1);
  geo.setAttribute('aCurv', attr);
  return attr;
}

// Rope-mode hardware: quickdraws (hanger + dogbone sling + two carabiners) and the top anchor
// (two bolts, chains, lowering rings). Quickdraws sway on a damped pendulum; clipped draws are
// pulled out toward the rope. `basketWorld()` gives the point the rope runs through.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE } from '../config/brand';
import type { QuickdrawDef, Vec2 } from '../core/types';
import { Rng } from '../core/rng';
import type { WallFrame } from './wall-frame';
import { createSurfaceMaterial, type SurfaceMaterial } from './shading';

type Surf = [number, number, number, number];

function tag(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, surf: Surf): THREE.BufferGeometry {
  const geo = g;
  const n = geo.getAttribute('position').count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  const s = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    s.set(surf, i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSurf', new THREE.BufferAttribute(s, 4));
  if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

const STEEL: Surf = [0, 1, 0, 0];
const ANODISED: Surf = [0, -0.8, 0, 0.4];
const FABRIC: Surf = [0, 0, 0, 0];

/** D-shaped carabiner in the local x–y plane, hanging from (0,0) down to (0,-h). */
function carabiner(h: number, w: number, tube: number, color: string, bent: boolean): THREE.BufferGeometry {
  const pts = [
    [0.0, 0.0], [0.3, 0.12], [0.75, 0.06], [1.0, -0.18], [0.9, -0.7], [0.55, -0.98],
    [0.15, -0.95], [-0.05, -0.72], [-0.06, -0.22],
  ].map(([x, y]) => new THREE.Vector3(x * w, y * h, 0));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const body = new THREE.TubeGeometry(curve, 44, tube, 7, true);
  // gate: a slightly thinner rod on the open side (bent gate curves inward)
  const gp = bent
    ? [new THREE.Vector3(0.98 * w, -0.2 * h, 0.002), new THREE.Vector3(0.8 * w, -0.5 * h, 0.004), new THREE.Vector3(0.88 * w, -0.72 * h, 0.002)]
    : [new THREE.Vector3(0.98 * w, -0.2 * h, 0.002), new THREE.Vector3(0.92 * w, -0.5 * h, 0.003), new THREE.Vector3(0.88 * w, -0.72 * h, 0.002)];
  const gate = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(gp), 10, tube * 0.6, 6, false);
  return mergeGeometries([tag(body, color, ANODISED), tag(gate, '#C9CDD2', STEEL)], false) as THREE.BufferGeometry;
}

/** Dogbone sling between the biners: CHIRAL pink webbing with bone bar-tacks and a bone print band. */
function dogbone(len: number, webbing: string, accent: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(0.017, len, 0.0065, 1, 6, 1);
  parts.push(tag(body, webbing, FABRIC));
  for (const y of [len / 2 - 0.012, -len / 2 + 0.012]) {
    const band = new THREE.BoxGeometry(0.0176, 0.006, 0.0072).translate(0, y, 0);
    parts.push(tag(band, accent, FABRIC));
  }
  const print = new THREE.BoxGeometry(0.0178, 0.009, 0.0074).translate(0, 0, 0);
  parts.push(tag(print, accent, FABRIC));
  return mergeGeometries(parts, false) as THREE.BufferGeometry;
}

/** Bent-plate hanger + bolt head; origin at the bolt, wall at z = 0. Eye at (0, EYE_Y, EYE_Z). */
const EYE_Y = -0.032;
const EYE_Z = 0.014;

function hanger(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const plate = new THREE.BoxGeometry(0.026, 0.044, 0.003).translate(0, -0.008, 0.0015);
  parts.push(tag(plate, '#BFC4CA', STEEL));
  const bend = new THREE.BoxGeometry(0.022, 0.003, 0.018).translate(0, -0.029, 0.009);
  parts.push(tag(bend, '#BFC4CA', STEEL));
  const eye = new THREE.TorusGeometry(0.0085, 0.0028, 6, 14).rotateX(Math.PI / 2).translate(0, EYE_Y, EYE_Z);
  parts.push(tag(eye, '#BFC4CA', STEEL));
  const head = new THREE.CylinderGeometry(0.0085, 0.0085, 0.006, 6).rotateX(Math.PI / 2).translate(0, 0, 0.006);
  parts.push(tag(head, '#9EA4AB', STEEL));
  const washer = new THREE.CylinderGeometry(0.011, 0.011, 0.002, 14).rotateX(Math.PI / 2).translate(0, 0, 0.0035);
  parts.push(tag(washer, '#AEB3B9', STEEL));
  return mergeGeometries(parts, false) as THREE.BufferGeometry;
}

const TOP_H = 0.07;
const SLING = 0.056;
const BOT_H = 0.076;
/** Basket (where the rope runs) below the pivot, in the swing frame. */
const BASKET_Y = -(TOP_H - 0.006 + SLING - 0.012 + BOT_H - 0.006);

interface Draw {
  def: QuickdrawDef;
  swing: THREE.Group;
  /** Pendulum angles: theta (in the wall plane), phi (away from the wall) + velocities. */
  th: number;
  thv: number;
  ph: number;
  phv: number;
  clipped: boolean;
  pull: Vec2;
  seed: number;
}

export class QuickdrawSet {
  readonly group = new THREE.Group();
  private draws: Draw[] = [];
  private byId = new Map<string, Draw>();
  private swingGeo: THREE.BufferGeometry | null = null;
  private staticMesh: THREE.Mesh | null = null;
  private anchorMesh: THREE.Mesh | null = null;
  private anchorDef: QuickdrawDef | null = null;
  private mat: SurfaceMaterial;
  private time = 0;
  private tmp = new THREE.Vector3();

  constructor(private frame: WallFrame) {
    this.group.name = 'quickdraws';
    this.mat = createSurfaceMaterial({ roughness: 0.5, metalness: 0 });
  }

  build(defs: readonly QuickdrawDef[] | undefined): void {
    this.clear();
    if (!defs || defs.length === 0) return;
    const draws = defs.slice(0, -1);
    const anchor = defs[defs.length - 1];

    // swing geometry (shared by all draws): top biner (bone), pink sling, bottom biner (graphite)
    const top = carabiner(TOP_H, 0.04, 0.0034, '#D9D4CA', false).rotateY(0.55);
    const sling = dogbone(SLING, PALETTE.signal, PALETTE.bone).translate(0, -TOP_H + 0.006 - SLING / 2 + 0.006, 0.002);
    const bot = carabiner(BOT_H, 0.044, 0.0037, '#4A5059', true)
      .rotateY(-0.5)
      .translate(0, -TOP_H + 0.006 - SLING + 0.012, 0.004);
    this.swingGeo = mergeGeometries([top, sling, bot], false) as THREE.BufferGeometry;
    for (const g of [top, sling, bot]) g.dispose();

    // static hangers (merged)
    const proto = hanger();
    const hangerParts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const pq = new THREE.Quaternion();
    for (const d of draws) {
      this.frame.toWorldXYZ(d.x, d.y, 0, p);
      m.compose(p, this.frame.quaternionAt(d.y, pq), new THREE.Vector3(1, 1, 1));
      hangerParts.push(proto.clone().applyMatrix4(m));
    }
    if (hangerParts.length) {
      const merged = mergeGeometries(hangerParts, false) as THREE.BufferGeometry;
      this.staticMesh = new THREE.Mesh(merged, this.mat);
      this.staticMesh.castShadow = true;
      this.staticMesh.name = 'quickdraws:hangers';
      this.group.add(this.staticMesh);
    }
    for (const h of hangerParts) h.dispose();

    draws.forEach((def, i) => {
      const swing = new THREE.Group();
      const mesh = new THREE.Mesh(this.swingGeo!, this.mat);
      mesh.castShadow = true;
      swing.add(mesh);
      this.group.add(swing);
      const rng = new Rng(i * 7919 + 13);
      const d: Draw = { def, swing, th: rng.range(-0.1, 0.1), thv: 0, ph: 0.05, phv: 0, clipped: false, pull: { x: 0, y: 0 }, seed: rng.range(0, 100) };
      this.draws.push(d);
      this.byId.set(def.id, d);
    });

    this.anchorDef = anchor;
    this.anchorMesh = new THREE.Mesh(this.buildAnchor(anchor), this.mat);
    this.anchorMesh.castShadow = true;
    this.anchorMesh.name = 'quickdraws:anchor';
    this.group.add(this.anchorMesh);
    this.update(0);
  }

  private buildAnchor(a: QuickdrawDef): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const proto = hanger();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    // the anchor is bolted to the panel at its height: everything uses that panel's frame
    const aq = this.frame.quaternionAt(a.y, new THREE.Quaternion());
    for (const side of [-1, 1]) {
      const bx = a.x + side * 0.11;
      this.frame.toWorldXYZ(bx, a.y, 0, p);
      m.compose(p, aq, one);
      parts.push(proto.clone().applyMatrix4(m));
      // chain: links from the eye converging toward the centre
      const links = 5;
      for (let k = 0; k < links; k++) {
        const t = (k + 0.5) / links;
        const lx = bx - side * 0.07 * t;
        const ly = a.y + EYE_Y - 0.012 - k * 0.019;
        const link = new THREE.TorusGeometry(0.0085, 0.0024, 6, 12).scale(1, 1.45, 1);
        q.setFromEuler(new THREE.Euler(0, k % 2 === 0 ? Math.PI / 2 : 0, side * 0.35 * (1 - t)));
        q.premultiply(aq);
        this.frame.toWorldXYZ(lx, ly, EYE_Z, p);
        m.compose(p, q, one);
        parts.push(tag(link, '#B5BAC0', STEEL).applyMatrix4(m));
      }
      // lowering ring
      const ring = new THREE.TorusGeometry(0.021, 0.0042, 8, 22);
      q.setFromEuler(new THREE.Euler(0, 0.45 * side, 0)).premultiply(aq);
      this.frame.toWorldXYZ(a.x + side * 0.026, a.y + EYE_Y - 0.012 - links * 0.019 - 0.012, EYE_Z + 0.004, p);
      m.compose(p, q, one);
      parts.push(tag(ring, '#C8CCD1', STEEL).applyMatrix4(m));
    }
    // CHIRAL pink anchor plate tag between the bolts
    const plate = tag(new THREE.BoxGeometry(0.16, 0.028, 0.002), PALETTE.signal, [0, 0, 0, 0.3]);
    this.frame.toWorldXYZ(a.x, a.y + 0.045, 0.001, p);
    m.compose(p, aq, one);
    parts.push(plate.applyMatrix4(m));
    const merged = mergeGeometries(parts, false) as THREE.BufferGeometry;
    for (const g of parts) g.dispose();
    proto.dispose();
    return merged;
  }

  /** Mark draws as clipped. `pulls`: optional wall-local rope pull directions per draw id. */
  setClipped(ids: readonly string[], pulls?: ReadonlyMap<string, Vec2>): void {
    for (const d of this.draws) {
      const was = d.clipped;
      d.clipped = ids.includes(d.def.id);
      if (d.clipped && !was) {
        d.thv += 2.5;
        d.phv += 3;
      }
      const p = pulls?.get(d.def.id);
      d.pull.x = p ? p.x : 0;
      d.pull.y = p ? p.y : 0;
    }
  }

  /** World point the rope runs through for a draw (lower biner basket) or the anchor rings. */
  basketWorld(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const d = this.byId.get(id);
    if (d) {
      d.swing.updateMatrixWorld(true);
      return out.set(0.008, BASKET_Y + 0.004, 0.004).applyMatrix4(d.swing.matrixWorld);
    }
    if (this.anchorDef && this.anchorDef.id === id) {
      return this.frame.toWorldXYZ(this.anchorDef.x, this.anchorDef.y + EYE_Y - 0.012 - 5 * 0.019 - 0.03, EYE_Z + 0.006, out);
    }
    return null;
  }

  /** Wall-local basket position (for rope path matching). */
  basketLocal(def: QuickdrawDef): Vec2 {
    return { x: def.x, y: def.y + EYE_Y + BASKET_Y };
  }

  update(dt: number): void {
    this.time += dt;
    const q = this.tmp;
    for (const d of this.draws) {
      // equilibrium: hang plumb (out from an overhanging panel by its angle, resting on a slab),
      // pulled out toward the rope when clipped
      const lean = (this.frame.angleAt(d.def.y) * Math.PI) / 180;
      let thT = 0;
      let phT = Math.max(0.05, lean + 0.03);
      if (d.clipped) {
        const px = d.pull.x;
        const py = d.pull.y;
        // angle of (down + pull) relative to straight down
        thT = Math.max(-0.7, Math.min(0.7, -Math.atan2(px, Math.max(0.2, 1 - py))));
        phT = Math.max(phT + 0.12, 0.32);
      }
      const idle = Math.sin(this.time * 0.9 + d.seed) * 0.025 + Math.sin(this.time * 2.3 + d.seed * 2) * 0.01;
      const k = 26;
      const c = 2.6;
      d.thv += (-(d.th - thT - idle) * k - d.thv * c) * dt;
      d.th += d.thv * dt;
      d.phv += (-(d.ph - phT) * k - d.phv * c) * dt;
      d.ph += d.phv * dt;
      d.ph = Math.max(0, d.ph);
      this.frame.toWorldXYZ(d.def.x, d.def.y + EYE_Y, EYE_Z, q);
      d.swing.position.copy(q);
      this.frame.quaternionAt(d.def.y, d.swing.quaternion);
      d.swing.rotateZ(d.th);
      // +ph swings the bottom of the draw OUT of the wall (rotation about local x by −ph)
      d.swing.rotateX(-d.ph);
    }
  }

  clear(): void {
    for (const d of this.draws) this.group.remove(d.swing);
    this.draws = [];
    this.byId.clear();
    this.swingGeo?.dispose();
    this.swingGeo = null;
    for (const mesh of [this.staticMesh, this.anchorMesh]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.staticMesh = this.anchorMesh = null;
    this.anchorDef = null;
  }

  dispose(): void {
    this.clear();
    this.mat.dispose();
  }
}

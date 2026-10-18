// CHIRAL HQ — the gym interior around the main wall.
//
// A dark, moody hall: faceted neighbouring walls at other angles covered in deco routes and big
// branded volumes, thick charcoal crash pads with CHIRAL pink stripes and the CHIRAL SPORTS
// lockup, black ceiling trusses with warm linear light bars, clerestory windows throwing cool
// light shafts through the haze, the backlit CHIRAL HQ sign above the walls, props and banners
// in the three tee colourways. All brand artwork is the official mark / wordmark / lockup. Everything static is merged into a
// handful of meshes with baked vertex lighting; materials are lit by the renderer's light rig.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PALETTE, ROUTE_COLORS, WALL } from '../config/brand';
import type { ClimbMode, HoldDef, HoldType } from '../core/types';
import { Rng } from '../core/rng';
import { clamp, smoothstep } from '../core/math';
import { Batch, beam, tr, type BakeFn } from './batch';
import { holdGeometry, decoColor } from './holds';
import { createSurfaceMaterial, type SurfaceMaterial } from './shading';
import {
  BANNER_ASPECT,
  BANNER_VARIANTS,
  bannerTexture,
  concreteTile,
  decalAtlas,
  padTextures,
  plywoodTile,
  shaftTexture,
  SIGN_ASPECT,
  signTexture,
  windowTexture,
  type AtlasRect,
} from './textures';
import type { QualityPreset } from './quality';

export interface GymLayout {
  mode: ClimbMode;
  wallWidth: number;
  wallHeight: number;
}

interface FaceSpec {
  a: [number, number]; // left end (x, z) at the base
  b: [number, number]; // right end
  tilt: number; // degrees (+ overhang)
  height: number;
  tint: string;
  routes: number;
  volumes: { u: number; y: number; size: number; color: string; logo: boolean; kind: number }[];
  seed: number;
  quickdraws?: boolean;
}

interface Hall {
  key: string;
  group: THREE.Group;
  floorGroup: THREE.Group;
  /** The backlit CHIRAL HQ sign's material (its colour is the backlight level). */
  signMat: THREE.MeshBasicMaterial | null;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
  motes: THREE.Points | null;
  ceiling: number;
}

const FOG_COLOR = '#0d0f12';
/** Warm white backlight of the CHIRAL HQ sign at full level (HDR, feeds the bloom). */
const SIGN_COLOR = new THREE.Color(1.85, 1.74, 1.62);

export class GymEnvironment {
  readonly group = new THREE.Group();
  private hall: Hall | null = null;
  private cache = new Map<string, Hall>();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private moteTime = { value: 0 };
  private detail: 0 | 1 | 2 = 2;
  private floorVisible = true;
  private signLevel = 1;
  private signTarget = 1;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    this.group.name = 'gym';
    scene.add(this.group);
    scene.background = new THREE.Color(FOG_COLOR);
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.028);
    this.buildEnvMap();
    scene.environmentIntensity = 0.17;
  }

  /** PMREM room reflections. GPU-generated, so a lost WebGL context takes them with it. */
  private buildEnvMap(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();
    this.scene.environment = this.envTarget.texture;
  }

  /** After a WebGL context restore: everything re-uploads from its source except the PMREM map. */
  restoreContext(): void {
    // the old target's GL objects died with the context: drop it rather than delete stale handles
    this.envTarget = null;
    this.buildEnvMap();
  }

  get ceiling(): number {
    return this.hall?.ceiling ?? 7.4;
  }

  /** Build (or reuse) the hall for this layout. */
  configure(layout: GymLayout, preset: QualityPreset): void {
    this.detail = preset.envDetail;
    const key = `${layout.mode}:${layout.wallWidth.toFixed(2)}:${preset.envDetail}`;
    if (this.hall?.key === key) return;
    if (this.hall) this.group.remove(this.hall.group);
    let hall = this.cache.get(key);
    if (!hall) {
      hall = this.buildHall(layout, key, preset);
      this.cache.set(key, hall);
    }
    this.hall = hall;
    hall.floorGroup.visible = this.floorVisible;
    this.group.add(hall.group);
  }

  /** Hide pads/floor/props (editor views from below floor level on steep overhangs). */
  setFloorVisible(v: boolean): void {
    this.floorVisible = v;
    if (this.hall) this.hall.floorGroup.visible = v;
  }

  /**
   * Backlight level of the CHIRAL HQ sign (1 = full). The title screen dims it so the lit lockup
   * doesn't compete with the STEIBOCK logo set right over it; it eases over ~1 s.
   */
  setSignLevel(v: number): void {
    this.signTarget = clamp(v, 0, 1);
  }

  update(dt: number): void {
    this.moteTime.value += dt;
    const k = 1 - Math.exp(-dt * 2.2);
    this.signLevel += (this.signTarget - this.signLevel) * k;
    const m = this.hall?.signMat;
    if (m) m.color.copy(SIGN_COLOR).multiplyScalar(this.signLevel);
  }

  // ───────────────────────────── build ─────────────────────────────

  private buildHall(layout: GymLayout, key: string, preset: QualityPreset): Hall {
    const rope = layout.mode === 'rope';
    const Hc = rope ? 18.5 : 7.4;
    const hallX = 12.5;
    const zBack = -3.2;
    const zFront = rope ? 30 : 26;
    const half = layout.wallWidth / 2 + 0.16;
    const group = new THREE.Group();
    group.name = `hall:${layout.mode}`;
    const floorGroup = new THREE.Group();
    floorGroup.name = 'hall:floor';
    group.add(floorGroup);
    const materials: THREE.Material[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const rng = new Rng(rope ? 0x70ce : 0xb01d);

    // ── neighbouring wall faces ──
    const fl: [number, number][] = [[-10.2, 4.3], [-6.5, 1.5], [-half, 0], [half, 0], [6.5, 1.5], [10.2, 4.3]];
    const faces: FaceSpec[] = rope
      ? [
          { a: [-10.2, 4.3], b: [-6.58, 1.56], tilt: 0, height: 15, tint: '#3a3d43', routes: 3, volumes: [{ u: 0.4, y: 6, size: 0.6, color: PALETTE.bone, logo: true, kind: 0 }], seed: 11, quickdraws: true },
          { a: [-6.42, 1.44], b: [-half - 0.1, 0], tilt: 10, height: 15, tint: '#2b2d31', routes: 3, volumes: [{ u: 0.55, y: 9.5, size: 0.7, color: PALETTE.signal, logo: true, kind: 1 }], seed: 12, quickdraws: true },
          { a: [half + 0.1, 0], b: [6.42, 1.44], tilt: 6, height: 15, tint: '#2f3237', routes: 3, volumes: [{ u: 0.35, y: 4.2, size: 0.65, color: '#55606E', logo: false, kind: 3 }], seed: 13, quickdraws: true },
          { a: [6.58, 1.56], b: [10.2, 4.3], tilt: 15, height: 15, tint: '#2b2d31', routes: 3, volumes: [{ u: 0.5, y: 7.5, size: 0.7, color: PALETTE.bone, logo: true, kind: 2 }], seed: 14, quickdraws: true },
        ]
      : [
          {
            a: [-10.2, 4.3], b: [-6.58, 1.56], tilt: -6, height: 4.2, tint: '#3a3d43', routes: 3,
            volumes: [{ u: 0.62, y: 2.2, size: 0.55, color: PALETTE.bone, logo: true, kind: 3 }], seed: 21,
          },
          {
            a: [-6.42, 1.44], b: [-half - 0.1, 0], tilt: 28, height: 4.5, tint: '#2b2d31', routes: 4,
            volumes: [
              { u: 0.3, y: 2.6, size: 0.72, color: PALETTE.signal, logo: true, kind: 0 },
              { u: 0.72, y: 1.3, size: 0.55, color: PALETTE.bone, logo: true, kind: 1 },
              { u: 0.62, y: 3.6, size: 0.42, color: '#2B2D31', logo: false, kind: 2 },
            ],
            seed: 22,
          },
          {
            a: [half + 0.1, 0], b: [6.42, 1.44], tilt: 8, height: 4.5, tint: '#2f3237', routes: 4,
            volumes: [{ u: 0.5, y: 3.0, size: 0.6, color: '#55606E', logo: false, kind: 3 }], seed: 23,
          },
          {
            a: [6.58, 1.56], b: [10.2, 4.3], tilt: 40, height: 4.4, tint: '#2b2d31', routes: 3,
            volumes: [
              { u: 0.4, y: 2.0, size: 0.7, color: PALETTE.bone, logo: true, kind: 0 },
              { u: 0.75, y: 3.2, size: 0.5, color: PALETTE.signal, logo: true, kind: 2 },
            ],
            seed: 24,
          },
        ];

    // light bars (also used for baking)
    const bars: THREE.Vector3[] = [];
    const trussZ: number[] = [];
    for (let z = 0.8; z < zFront - 2; z += 3.4) trussZ.push(z);
    const barY = Hc - 1.9;
    for (const z of trussZ) for (const x of [-8.4, -4.2, 0, 4.2, 8.4]) bars.push(new THREE.Vector3(x, barY, z));

    const bake: BakeFn = (p, n) => {
      let f = 0.3;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const inv = 1 / Math.sqrt(d2 + 1e-6);
        const ndl = Math.max(0, (n.x * dx + n.y * dy + n.z * dz) * inv);
        // linear bars emit downward: points above a bar get only a little spill
        const down = Math.max(0.12, dy * inv);
        f += (1.15 * (0.2 + 0.8 * ndl) * down) / (1 + d2 * 0.11);
      }
      f *= 0.62 + 0.38 * smoothstep(0, 1.4, p.y);
      f *= 1 - 0.45 * smoothstep(Hc - 3, Hc, p.y);
      const r = Math.hypot(p.x, p.z - 3);
      f *= 1 - 0.5 * smoothstep(9, 24, r);
      return clamp(f, 0.14, 1.25);
    };

    const ply = plywoodTile(preset.level === 'high' ? 1024 : 512);
    const plyBatch = new Batch();
    const darkBatch = new Batch();
    const holdBatch = new Batch({ surf: true });
    const decalBatch = new Batch({ alpha: true });
    const emissiveBatch = new Batch();
    const atlas = decalAtlas();

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);

    const decal = (rect: AtlasRect, w: number, h: number, mat: THREE.Matrix4, color: THREE.ColorRepresentation, alpha: number) => {
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, rect.u0 + uv.getX(i) * (rect.u1 - rect.u0), rect.v0 + uv.getY(i) * (rect.v1 - rect.v0));
      }
      decalBatch.add(g, mat, color, { alpha });
    };

    for (const f of faces) {
      const ax = f.a[0], az = f.a[1], bx = f.b[0], bz = f.b[1];
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(-(bz - az), bx - ax);
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;
      const tilt = (f.tilt * Math.PI) / 180;
      // face frame: T(c) · Ry(yaw) · Rx(tilt); local x along the face, y up the face, z out
      const frameQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
      const base = new THREE.Vector3(cx, 0, cz);
      const local = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, y, z).applyQuaternion(frameQ).add(base);
      const localMat = (x: number, y: number, z: number, rz: number, out: THREE.Matrix4) => {
        local(x, y, z, v);
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rz).premultiply(frameQ);
        return out.compose(v, q, one);
      };

      // panel surface
      const segX = Math.max(6, Math.round(len * 2.5));
      const segY = Math.max(6, Math.round(f.height * 2.5));
      const panel = new THREE.PlaneGeometry(len, f.height, segX, segY).translate(0, f.height / 2, 0);
      const uv = panel.getAttribute('uv') as THREE.BufferAttribute;
      const pp = panel.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pp.getX(i) + len / 2 + f.seed * 0.37) / ply.meters, pp.getY(i) / ply.meters);
      const tint = new THREE.Color(f.tint).multiplyScalar(1 / new THREE.Color(WALL.panel).r);
      m4.compose(base, frameQ, one);
      plyBatch.add(panel, m4, tint);

      // shell + trims
      darkBatch.add(new THREE.BoxGeometry(len, f.height, 0.24), localMat(0, f.height / 2, -0.125, 0, m4), '#111215');
      darkBatch.add(new RoundedBoxGeometry(len + 0.1, 0.075, 0.07, 2, 0.02), localMat(0, f.height + 0.025, 0, 0, m4), '#1B1D21');
      darkBatch.add(new THREE.BoxGeometry(len - 0.2, 0.006, 0.004), localMat(0, f.height + 0.0, 0.036, 0, m4), PALETTE.signal);
      for (const side of [-1, 1]) darkBatch.add(new RoundedBoxGeometry(0.07, f.height, 0.065, 2, 0.02), localMat((side * len) / 2, f.height / 2, 0, 0, m4), '#1B1D21');

      // tone-on-tone branding on the panels: the mark or the wordmark (official proportions)
      const frng = new Rng(f.seed * 977);
      if (frng.chance(0.55)) {
        const s = Math.min(1.7, f.height * 0.38);
        decal(atlas.logo, s, s, localMat(frng.range(-len * 0.22, len * 0.22), f.height * 0.6, 0.003, 0, m4), '#ffffff', 0.055);
      } else {
        const w = Math.min(len * 0.82, 3.4);
        decal(atlas.word, w, w / atlas.aspect.word, localMat(0, f.height * 0.72, 0.003, 0, m4), '#ffffff', 0.06);
      }

      // routes
      const hrng = new Rng(f.seed * 131 + 7);
      const types: HoldType[] = ['jug', 'edge', 'crimp', 'sloper', 'pinch', 'pocket'];
      for (let r = 0; r < f.routes; r++) {
        const col = ROUTE_COLORS[hrng.int(0, ROUTE_COLORS.length - 1)].hex;
        let x = hrng.range(-len / 2 + 0.5, len / 2 - 0.5);
        const count = Math.round(f.height * (rope ? 1.4 : 2.4));
        for (let k = 0; k < count; k++) {
          const y = 0.55 + (k + hrng.range(-0.2, 0.2)) * ((f.height - 0.9) / count);
          x = clamp(x + hrng.range(-0.45, 0.45), -len / 2 + 0.25, len / 2 - 0.25);
          const type = hrng.pick(types);
          const h: HoldDef = {
            id: '', x, y, type, size: hrng.range(0.045, 0.11), angle: -Math.PI / 2 + hrng.range(-0.8, 0.8),
            role: 'deco', color: col, seed: hrng.int(0, 1e6),
          };
          addEnvHold(holdBatch, h, localMat, m4);
          if (hrng.chance(0.6)) {
            const fh: HoldDef = { ...h, x: clamp(x + hrng.range(-0.4, 0.4), -len / 2 + 0.2, len / 2 - 0.2), y: Math.max(0.42, y - hrng.range(0.5, 0.9)), type: 'foot', size: hrng.range(0.022, 0.04), seed: h.seed + 1 };
            addEnvHold(holdBatch, fh, localMat, m4);
          }
        }
      }
      // volumes (+ logo decals on their largest face)
      for (const vs of f.volumes) {
        const h: HoldDef = { id: '', x: (vs.u - 0.5) * len, y: vs.y, type: 'volume', size: vs.size, angle: -Math.PI / 2 + hrng.range(-0.4, 0.4), role: 'deco', color: vs.color, seed: vs.kind + hrng.int(0, 50) * 6 };
        const hg = holdGeometry('volume', h.seed, h.size, 1);
        localMat(h.x, h.y, -0.002, h.angle + Math.PI / 2, m4);
        holdBatch.add(hg.geo.clone(), m4, vs.color, { surf: [0, 0, 0, 0] });
        if (vs.logo && hg.face) {
          const fc = hg.face;
          const dq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fc.n);
          // keep the logo upright on the face
          const upOnFace = new THREE.Vector3(1, 0, 0).applyQuaternion(dq);
          const twist = Math.atan2(new THREE.Vector3().crossVectors(upOnFace, fc.ax).dot(fc.n), upOnFace.dot(fc.ax));
          dq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), twist));
          const lm = new THREE.Matrix4().compose(fc.c.clone().addScaledVector(fc.n, 0.004), dq, one);
          const s = fc.r * 1.15;
          const logoCol = vs.color === PALETTE.signal ? PALETTE.bone : vs.color === PALETTE.bone ? PALETTE.signal : PALETTE.bone;
          decal(atlas.logo, s, s, m4.clone().multiply(lm), logoCol, 0.95);
        }
      }
      // static quickdraw hangers on lead walls (just the visual rhythm of lines)
      if (f.quickdraws) {
        for (let line = 0; line < 2; line++) {
          const lx = (line === 0 ? -0.22 : 0.24) * len;
          for (let y = 2.2; y < f.height - 0.5; y += 1.25) {
            darkBatch.add(new THREE.BoxGeometry(0.03, 0.05, 0.012), localMat(lx, y, 0.006, 0, m4), '#9aa0a8');
            darkBatch.add(new THREE.BoxGeometry(0.018, 0.16, 0.008), localMat(lx, y - 0.11, 0.02, 0, m4), line ? PALETTE.signal : PALETTE.bone);
          }
        }
      }
    }

    // structural columns at the far junctions
    for (const [x, z] of [[-6.5, 1.5], [6.5, 1.5], [-10.3, 4.38], [10.3, 4.38]] as const) {
      darkBatch.add(new THREE.BoxGeometry(0.32, Hc, 0.32), tr(x, Hc / 2, z - 0.2), '#0f1012');
      darkBatch.add(new THREE.BoxGeometry(0.34, 0.012, 0.34), tr(x, 2.4, z - 0.2), PALETTE.signal);
    }

    // ── hall shell: back wall, side walls, ceiling ──
    const conc = concreteTile();
    const hallBatch = new Batch();
    const hallW = hallX * 2;
    const backWall = new THREE.PlaneGeometry(hallW, Hc, 24, Math.round(Hc * 2));
    worldUV(backWall, conc.meters, 'xy');
    hallBatch.add(backWall, tr(0, Hc / 2, zBack), new THREE.Color(0.9, 0.9, 0.95));
    for (const side of [-1, 1]) {
      const sw = new THREE.PlaneGeometry(zFront - zBack, Hc, 28, Math.round(Hc * 2));
      worldUV(sw, conc.meters, 'xy');
      hallBatch.add(sw, tr(side * hallX, Hc / 2, (zFront + zBack) / 2, 0, -side * Math.PI / 2, 0), new THREE.Color(0.85, 0.85, 0.9));
    }
    const ceil = new THREE.PlaneGeometry(hallW, zFront - zBack, 12, 14);
    worldUV(ceil, conc.meters, 'xy');
    hallBatch.add(ceil, tr(0, Hc, (zFront + zBack) / 2, Math.PI / 2, 0, 0), new THREE.Color(0.4, 0.4, 0.44));
    const hallGeo = hallBatch.build(bake);
    const hallMat = new THREE.MeshStandardMaterial({
      map: conc.map,
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
      envMapIntensity: 0.25,
    });
    materials.push(hallMat);
    if (hallGeo) {
      geometries.push(hallGeo);
      const mesh = new THREE.Mesh(hallGeo, hallMat);
      mesh.name = 'hall:shell';
      group.add(mesh);
    }

    // ── trusses, ducts, cables, bar housings ──
    const chordA = new THREE.Vector3();
    const chordB = new THREE.Vector3();
    for (const z of trussZ) {
      const yTop = Hc - 0.25;
      const yBot = Hc - 1.05;
      darkBatch.add(new THREE.BoxGeometry(hallW, 0.14, 0.14), tr(0, yTop, z), '#0b0c0d');
      darkBatch.add(new THREE.BoxGeometry(hallW, 0.14, 0.14), tr(0, yBot, z), '#0b0c0d');
      let up = true;
      for (let x = -hallX; x < hallX - 0.1; x += 1.4) {
        const x2 = Math.min(hallX, x + 1.4);
        darkBatch.add(new THREE.BoxGeometry(0.06, 1, 0.06), beam(chordA.set(x, yBot, z), chordB.set(x, yTop, z), m4), '#0b0c0d');
        darkBatch.add(new THREE.BoxGeometry(0.05, 1, 0.05), beam(chordA.set(x, up ? yBot : yTop, z), chordB.set(x2, up ? yTop : yBot, z), m4), '#0b0c0d');
        up = !up;
      }
    }
    for (const b of bars) {
      // housing + diffuser + cables
      darkBatch.add(new THREE.BoxGeometry(2.8, 0.06, 0.12), tr(b.x, b.y + 0.04, b.z), '#141518');
      emissiveBatch.add(new THREE.BoxGeometry(2.74, 0.02, 0.09), tr(b.x, b.y, b.z), new THREE.Color(4.2, 2.9, 1.75));
      for (const s of [-1.2, 1.2]) darkBatch.add(new THREE.CylinderGeometry(0.004, 0.004, Hc - 1.05 - b.y, 4), tr(b.x + s, (b.y + Hc - 1.05) / 2, b.z), '#0b0c0d');
    }
    if (preset.envDetail >= 1) {
      for (const x of [-7.6, 7.6]) {
        darkBatch.add(new THREE.CylinderGeometry(0.4, 0.4, zFront - zBack, 18, 1, true), tr(x, Hc - 0.6, (zFront + zBack) / 2, Math.PI / 2, 0, 0), '#2a2d31');
        for (let z = zBack + 0.5; z < zFront; z += 1.6) darkBatch.add(new THREE.TorusGeometry(0.405, 0.02, 4, 18), tr(x, Hc - 0.6, z), '#1d1f22');
      }
    }

    // ── backlit sign + windows (emissive) ──
    // CHIRAL HQ: the official lockup backlit on a black fascia with a CHIRAL pink light line under it
    const signTex = signTexture();
    const signY = rope ? 16.3 : Hc - 1.3;
    const signW = 6.4;
    const signH = signW / SIGN_ASPECT;
    const signMat = new THREE.MeshBasicMaterial({ map: signTex, transparent: true, depthWrite: false, color: SIGN_COLOR.clone(), fog: true });
    materials.push(signMat);
    const signGeo = new THREE.PlaneGeometry(signW, signH);
    geometries.push(signGeo);
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, signY, zBack + 0.07);
    sign.name = 'hall:sign';
    group.add(sign);
    darkBatch.add(new RoundedBoxGeometry(signW + 0.6, signH + 0.34, 0.08, 2, 0.025), tr(0, signY, zBack + 0.03), '#0f1012');
    emissiveBatch.add(new THREE.BoxGeometry(signW + 0.6, 0.016, 0.02), tr(0, signY - signH / 2 - 0.17, zBack + 0.075), new THREE.Color(PALETTE.signal).multiplyScalar(5.2));

    const winTex = windowTexture();
    const winMat = new THREE.MeshBasicMaterial({ map: winTex, color: new THREE.Color(1.5, 1.7, 1.8), fog: true });
    materials.push(winMat);
    const winBatch = new Batch();
    const winY = Hc - 2.2;
    const winZ: number[] = [];
    for (let z = 3; z < zFront - 2; z += 4.2) winZ.push(z);
    for (const side of [-1, 1]) {
      for (const z of winZ) {
        winBatch.add(new THREE.PlaneGeometry(1.7, 2.6), tr(side * (hallX - 0.02), winY, z, 0, -side * Math.PI / 2, 0));
        // frame: four bars around the opening + a deep sill
        const fx = side * (hallX - 0.06);
        darkBatch.add(new THREE.BoxGeometry(0.1, 0.1, 1.9), tr(fx, winY + 1.35, z), '#0a0b0c');
        darkBatch.add(new THREE.BoxGeometry(0.22, 0.1, 1.9), tr(side * (hallX - 0.12), winY - 1.35, z), '#0a0b0c');
        for (const dz of [-0.9, 0.9]) darkBatch.add(new THREE.BoxGeometry(0.1, 2.8, 0.1), tr(fx, winY, z + dz), '#0a0b0c');
      }
    }
    const winGeo = winBatch.build();
    if (winGeo) {
      geometries.push(winGeo);
      const wm = new THREE.Mesh(winGeo, winMat);
      wm.name = 'hall:windows';
      wm.renderOrder = 1;
      group.add(wm);
    }

    // ── light shafts from the windows (additive, crossed quads) ──
    if (preset.envDetail >= 2) {
      const shaftMat = new THREE.MeshBasicMaterial({
        map: shaftTexture(),
        color: new THREE.Color(PALETTE.glacier).multiplyScalar(0.24),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        vertexColors: true,
      });
      materials.push(shaftMat);
      const shafts = new Batch();
      const dir = new THREE.Vector3();
      for (const side of [-1, 1]) {
        winZ.forEach((z, i) => {
          if (i % 2 === 1 && !rope) return;
          dir.set(-side * 0.62, -0.72, 0.3).normalize();
          const L = rope ? 16 : 9.5;
          const start = new THREE.Vector3(side * (hallX - 0.1), winY + 0.6, z);
          const end = start.clone().addScaledVector(dir, L);
          for (const rot of [0, Math.PI / 2]) {
            const g = new THREE.PlaneGeometry(1.9, 1, 1, 1).translate(0, -0.5, 0);
            // orient: local -Y along the shaft direction, rotated about it
            const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
            qq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot + side * 0.4));
            const mm = new THREE.Matrix4().compose(start, qq, new THREE.Vector3(1, start.distanceTo(end), 1));
            shafts.add(g, mm, new THREE.Color(1, 1, 1).multiplyScalar(0.7 + 0.3 * Math.sin(i * 1.7)));
          }
        });
      }
      const shaftGeo = shafts.build();
      if (shaftGeo) {
        geometries.push(shaftGeo);
        const sm = new THREE.Mesh(shaftGeo, shaftMat);
        sm.renderOrder = 5;
        sm.name = 'hall:shafts';
        group.add(sm);
      }
    }

    // ── banners ──
    if (preset.envDetail >= 1) {
      const banMat = new THREE.MeshStandardMaterial({ map: bannerTexture(), roughness: 0.85, side: THREE.DoubleSide, vertexColors: true });
      materials.push(banMat);
      const banners = new Batch();
      const bh = rope ? 4.6 : 3.3;
      const bw = bh * BANNER_ASPECT;
      // black / white / pink / black: the tee colourways down the hall
      const placements = [[-9.6, 8, 0], [9.6, 8, 2], [-9.6, 15, 1], [9.6, 15, 0]] as const;
      for (const [x, z, variant] of placements) {
        const g = new THREE.PlaneGeometry(bw, bh, 1, 6);
        const p = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getY(i) / bh) * 3) * 0.05);
        const buv = g.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < buv.count; i++) buv.setX(i, (variant + buv.getX(i)) / BANNER_VARIANTS);
        g.computeVertexNormals();
        banners.add(g, tr(x, Hc - 1.15 - bh / 2, z, 0, x < 0 ? Math.PI / 2.6 : -Math.PI / 2.6, 0));
        darkBatch.add(new THREE.CylinderGeometry(0.015, 0.015, bw + 0.15, 6), tr(x, Hc - 1.1, z, 0, x < 0 ? Math.PI / 2.6 : -Math.PI / 2.6, Math.PI / 2), '#0b0c0d');
      }
      const banGeo = banners.build(bake);
      if (banGeo) {
        geometries.push(banGeo);
        group.add(new THREE.Mesh(banGeo, banMat));
      }
    }

    // ── floor: concrete + crash pads + props ──
    const floorGeo = new THREE.PlaneGeometry(hallW, zFront - zBack, 24, 24);
    worldUV(floorGeo, conc.meters, 'xy');
    const floorB = new Batch();
    floorB.add(floorGeo, tr(0, 0, (zFront + zBack) / 2, -Math.PI / 2, 0, 0), '#ffffff');
    const floorBuilt = floorB.build(bake);
    const floorMat = new THREE.MeshStandardMaterial({
      map: conc.map,
      roughnessMap: conc.roughnessMap,
      normalMap: conc.normalMap,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      envMapIntensity: 0.7,
    });
    floorMat.normalScale.set(0.12, 0.12);
    // floor UVs are in plane space: (x, y) of the unrotated plane → repeat matches meters / tile
    materials.push(floorMat);
    if (floorBuilt) {
      geometries.push(floorBuilt);
      const fm = new THREE.Mesh(floorBuilt, floorMat);
      fm.receiveShadow = true;
      fm.name = 'hall:floor';
      floorGroup.add(fm);
    }

    const pads = this.buildPads(fl, materials, geometries, decalBatch, atlas);
    floorGroup.add(pads);

    if (preset.envDetail >= 1) this.buildProps(darkBatch, holdBatch, rng, hallX, zFront);

    // ── assemble batches ──
    const plyGeo = plyBatch.build(bake);
    const plyMat = new THREE.MeshStandardMaterial({
      map: ply.map,
      normalMap: ply.normalMap,
      roughnessMap: ply.roughnessMap,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      envMapIntensity: 0.4,
    });
    plyMat.normalScale.set(0.6, 0.6);
    materials.push(plyMat);
    if (plyGeo) {
      geometries.push(plyGeo);
      const pm = new THREE.Mesh(plyGeo, plyMat);
      pm.name = 'hall:neighbour-walls';
      group.add(pm);
    }
    const darkGeo = darkBatch.build(bake, 0.85);
    const darkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.6 });
    materials.push(darkMat);
    if (darkGeo) {
      geometries.push(darkGeo);
      const dm = new THREE.Mesh(darkGeo, darkMat);
      dm.name = 'hall:structure';
      group.add(dm);
    }
    const holdGeo = holdBatch.build(bake, 0.85);
    const holdMat: SurfaceMaterial = createSurfaceMaterial({ roughness: 0.6, normalMap: null });
    materials.push(holdMat);
    if (holdGeo) {
      geometries.push(holdGeo);
      const hm = new THREE.Mesh(holdGeo, holdMat);
      hm.name = 'hall:holds';
      group.add(hm);
    }
    const decalGeo = decalBatch.build();
    const decalMat = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    materials.push(decalMat);
    if (decalGeo) {
      geometries.push(decalGeo);
      const dm = new THREE.Mesh(decalGeo, decalMat);
      dm.renderOrder = 2;
      dm.name = 'hall:decals';
      group.add(dm);
    }
    const emGeo = emissiveBatch.build();
    const emMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    materials.push(emMat);
    if (emGeo) {
      geometries.push(emGeo);
      const em = new THREE.Mesh(emGeo, emMat);
      em.name = 'hall:lights';
      group.add(em);
    }

    // ── dust motes drifting in the light ──
    let motes: THREE.Points | null = null;
    if (preset.envDetail >= 2) {
      motes = this.buildMotes(rope ? 900 : 380, hallX, Hc, zFront);
      materials.push(motes.material as THREE.Material);
      geometries.push(motes.geometry);
      group.add(motes);
    }

    return { key, group, floorGroup, signMat, materials, geometries, motes, ceiling: Hc };
  }

  private buildPads(
    fl: [number, number][],
    materials: THREE.Material[],
    geometries: THREE.BufferGeometry[],
    decals: Batch,
    atlas: ReturnType<typeof decalAtlas>,
  ): THREE.Group {
    const g = new THREE.Group();
    g.name = 'hall:pads';
    const back = offsetPolyline(fl, -0.9);
    const front = offsetPolyline(fl, 4.8);
    const shape = new THREE.Shape();
    // Shape lives in (x, −z) so that after rotateX(−90°) the extrusion goes up +Y.
    shape.moveTo(back[0][0], -back[0][1]);
    for (let i = 1; i < back.length; i++) shape.lineTo(back[i][0], -back[i][1]);
    for (let i = front.length - 1; i >= 0; i--) shape.lineTo(front[i][0], -front[i][1]);
    shape.closePath();
    const bevel = 0.045;
    const H = 0.3;
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: H - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 3,
      curveSegments: 1,
    });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, bevel, 0);
    // UVs: caps planar in meters, sides along x by height
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (Math.abs(nrm.getY(i)) > 0.7 && y > H * 0.5) uv.setXY(i, x / 2, -z / 2);
      else uv.setXY(i, (x + z * 0.35) / 4, clamp(y / H, 0, 1));
    }
    geometries.push(geo);
    const pt = padTextures();
    const topMat = new THREE.MeshStandardMaterial({
      map: pt.top.map,
      normalMap: pt.top.normalMap,
      roughnessMap: pt.top.roughnessMap,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.25,
    });
    topMat.normalScale.set(0.5, 0.5);
    const sideMat = new THREE.MeshStandardMaterial({ map: pt.band, roughness: 0.8, metalness: 0, envMapIntensity: 0.3 });
    materials.push(topMat, sideMat);
    const mesh = new THREE.Mesh(geo, [topMat, sideMat]);
    mesh.receiveShadow = true;
    mesh.name = 'hall:pads';
    g.add(mesh);

    // seam covers (velcro strips) between pad sections, perpendicular to the front line
    const seamB = new Batch();
    const m4 = new THREE.Matrix4();
    for (let s = 0; s < fl.length - 1; s++) {
      const [ax, az] = fl[s];
      const [bx, bz] = fl[s + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(-(bz - az), bx - ax);
      const nx = -(bz - az) / len;
      const nz = (bx - ax) / len;
      const nSeams = Math.max(1, Math.round(len / 2.2));
      for (let k = 0; k <= nSeams; k++) {
        if ((k === 0 && s > 0) || (k === nSeams && s < fl.length - 2)) continue;
        const t = k / nSeams;
        const x = ax + (bx - ax) * t + nx * 1.95;
        const z = az + (bz - az) * t + nz * 1.95;
        seamB.add(new THREE.BoxGeometry(0.09, 0.008, 5.7), m4.compose(new THREE.Vector3(x, H + 0.002, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1)), '#16171a');
      }
      // seam along the front line (between the inner and outer pad rows)
      const midX = (ax + bx) / 2 + nx * 2.3;
      const midZ = (az + bz) / 2 + nz * 2.3;
      seamB.add(new THREE.BoxGeometry(len, 0.008, 0.08), m4.compose(new THREE.Vector3(midX, H + 0.002, midZ), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1)), '#16171a');
      // big tone-on-tone CHIRAL SPORTS lockup printed on the pad top (outer row)
      if (len > 3) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
        const lx = (ax + bx) / 2 + nx * 3.4;
        const lz = (az + bz) / 2 + nz * 3.4;
        m4.compose(new THREE.Vector3(lx, H + 0.006, lz), q, new THREE.Vector3(1, 1, 1));
        const w = Math.min(len * 0.62, 2.9);
        const lock = new THREE.PlaneGeometry(w, w / atlas.aspect.lockup);
        remapUV(lock, atlas.lockup);
        decals.add(lock, m4, '#ffffff', { alpha: 0.075 });
      }
    }
    // CHIRAL pink stripe inset from the pad's front edge (mitred, so segments meet cleanly), with
    // the mark printed in pink just behind it at the ends of the main wall's pad
    const stripe = offsetPolyline(fl, 4.52);
    for (let i = 0; i < stripe.length - 1; i++) {
      const [ax, az] = stripe[i];
      const [bx, bz] = stripe[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(-(bz - az), bx - ax);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
      m4.compose(new THREE.Vector3((ax + bx) / 2, H + 0.006, (az + bz) / 2), q, new THREE.Vector3(1, 1, 1));
      const g2 = new THREE.PlaneGeometry(len, 0.035);
      remapUV(g2, atlas.solid);
      decals.add(g2, m4, PALETTE.signal, { alpha: 0.95 });
      if (i === 2) {
        // main wall's pad: the mark in pink near both ends, set just behind the stripe
        const nx = -(bz - az) / len;
        const nz = (bx - ax) / len;
        for (const t of [0.1, 0.9]) {
          const mw = 0.34;
          m4.compose(new THREE.Vector3(ax + (bx - ax) * t - nx * 0.2, H + 0.0065, az + (bz - az) * t - nz * 0.2), q, new THREE.Vector3(1, 1, 1));
          const mg = new THREE.PlaneGeometry(mw, mw);
          remapUV(mg, atlas.logo);
          decals.add(mg, m4, PALETTE.signal, { alpha: 0.92 });
        }
      }
    }
    const seamGeo = seamB.build();
    if (seamGeo) {
      geometries.push(seamGeo);
      const seamMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
      materials.push(seamMat);
      const sm = new THREE.Mesh(seamGeo, seamMat);
      sm.receiveShadow = true;
      g.add(sm);
    }
    // painted walkway line on the concrete in front of the pads
    const line = offsetPolyline(fl, 5.35);
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(-(bz - az), bx - ax);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
      m4.compose(new THREE.Vector3((ax + bx) / 2, 0.004, (az + bz) / 2), q, new THREE.Vector3(1, 1, 1));
      const g2 = new THREE.PlaneGeometry(len, 0.06);
      remapUV(g2, atlas.solid);
      decals.add(g2, m4, PALETTE.signalDeep, { alpha: 0.75 });
    }
    return g;
  }

  private buildProps(dark: Batch, holds: Batch, rng: Rng, hallX: number, zFront: number): void {
    // benches
    for (const [x, z, ry] of [[-3.6, 8.6, 0.05], [3.8, 8.9, -0.08], [-7.8, 10.5, 0.6]] as const) {
      dark.add(new RoundedBoxGeometry(2.0, 0.06, 0.42, 2, 0.015), tr(x, 0.44, z, 0, ry, 0), '#5b4630');
      for (const s of [-0.85, 0.85]) dark.add(new THREE.BoxGeometry(0.05, 0.42, 0.38), tr(x + Math.cos(ry) * s, 0.21, z - Math.sin(ry) * s, 0, ry, 0), '#0c0d0e');
    }
    // chalk bucket
    dark.add(new THREE.CylinderGeometry(0.16, 0.13, 0.32, 14), tr(-2.4, 0.16, 8.7), '#d8d4cc');
    dark.add(new THREE.CylinderGeometry(0.14, 0.14, 0.02, 14), tr(-2.4, 0.33, 8.7), '#f2f0eb');
    // spare pads stack
    for (let k = 0; k < 3; k++) {
      dark.add(new RoundedBoxGeometry(1.9, 0.22, 1.2, 2, 0.05), tr(9.6, 0.11 + k * 0.23, 9 + k * 0.04, 0, 0.2 + k * 0.06, 0), k === 1 ? PALETTE.signal : '#1f2124');
    }
    // hold rack on the right side wall
    const rx = hallX - 0.35;
    dark.add(new THREE.BoxGeometry(0.5, 2.2, 3.2), tr(rx, 1.1, 13.5), '#101113');
    for (let s = 0; s < 4; s++) {
      dark.add(new THREE.BoxGeometry(0.55, 0.03, 3.25), tr(rx - 0.02, 0.35 + s * 0.52, 13.5), '#2a2d31');
      for (let k = 0; k < 9; k++) {
        const col = ROUTE_COLORS[rng.int(0, ROUTE_COLORS.length - 1)].hex;
        const type = rng.pick<HoldType>(['jug', 'sloper', 'edge', 'pinch']);
        const hg = holdGeometry(type, rng.int(0, 1000), rng.range(0.05, 0.09), 1);
        holds.add(hg.geo.clone(), tr(rx - 0.05, 0.37 + s * 0.52, 12.1 + k * 0.33, -Math.PI / 2, 0, rng.range(-1, 1)), decoColor(col), { surf: [0, 0, 0, 0] });
      }
    }
    // reception counter near the entrance (seen during the intro fly-in)
    dark.add(new RoundedBoxGeometry(3.4, 1.05, 0.8, 2, 0.04), tr(-6.5, 0.525, zFront - 6, 0, 0.2, 0), '#16171a');
    dark.add(new THREE.BoxGeometry(3.42, 0.02, 0.02), tr(-6.5, 0.98, zFront - 5.6, 0, 0.2, 0), PALETTE.signal);
  }

  private buildMotes(count: number, hallX: number, Hc: number, zFront: number): THREE.Points {
    const rng = new Rng(0xd057);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-hallX + 1, hallX - 1);
      pos[i * 3 + 1] = rng.range(0.6, Hc - 1.5);
      pos[i * 3 + 2] = rng.range(-0.5, Math.min(zFront - 4, 14));
      seed[i] = rng.next();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.moteTime, uScale: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float aSeed;
        varying float vA;
        void main() {
          vec3 p = position;
          float t = uTime * (0.05 + aSeed * 0.07) + aSeed * 40.0;
          p.x += sin(t * 1.3) * 0.6;
          p.y += sin(t * 0.7 + aSeed * 6.0) * 0.5;
          p.z += cos(t * 1.1) * 0.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          gl_PointSize = clamp((2.0 + aSeed * 2.5) * (6.0 / d), 1.0, 6.0);
          vA = (0.25 + 0.75 * fract(aSeed * 13.7)) * smoothstep(0.5, 3.0, d) * (1.0 - smoothstep(10.0, 24.0, d));
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c)) * vA * 0.35;
          gl_FragColor = vec4(vec3(1.0, 0.92, 0.8) * a, a);
        }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.name = 'hall:motes';
    return pts;
  }

  dispose(): void {
    for (const h of this.cache.values()) {
      for (const m of h.materials) m.dispose();
      for (const g of h.geometries) g.dispose();
    }
    this.cache.clear();
    this.hall = null;
    this.scene.remove(this.group);
    this.envTarget?.dispose();
    this.envTarget = null;
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function addEnvHold(
  batch: Batch,
  h: HoldDef,
  localMat: (x: number, y: number, z: number, rz: number, out: THREE.Matrix4) => THREE.Matrix4,
  m4: THREE.Matrix4,
): void {
  const hg = holdGeometry(h.type, h.seed, h.size, 1);
  localMat(h.x, h.y, -0.0015, h.angle + Math.PI / 2, m4);
  const c = new THREE.Color(h.color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s * 0.82, hsl.l * 0.82);
  batch.add(hg.geo.clone(), m4, c, { surf: [0, 0, 0, 0] });
}

/** UVs in meters from the plane's own (x, y) → repeat every `meters`. */
function worldUV(g: THREE.BufferGeometry, meters: number, _plane: 'xy'): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / meters, p.getY(i) / meters);
}

function remapUV(g: THREE.BufferGeometry, r: AtlasRect): void {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
}

/** Offsets a polyline (x, z) toward the room (+normal) with mitred joints. */
function offsetPolyline(pts: [number, number][], d: number): [number, number][] {
  const out: [number, number][] = [];
  const n = pts.length;
  const segN = (i: number): [number, number] => {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    return [-(bz - az) / l, (bx - ax) / l];
  };
  for (let i = 0; i < n; i++) {
    let nx: number, nz: number;
    if (i === 0) [nx, nz] = segN(0);
    else if (i === n - 1) [nx, nz] = segN(n - 2);
    else {
      const [ax, az] = segN(i - 1);
      const [bx, bz] = segN(i);
      nx = ax + bx;
      nz = az + bz;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      const cosHalf = nx * bx + nz * bz;
      nx /= Math.max(0.5, cosHalf);
      nz /= Math.max(0.5, cosHalf);
    }
    out.push([pts[i][0] + nx * d, pts[i][1] + nz * d]);
  }
  return out;
}

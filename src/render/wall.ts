// The main climbing panel for a BoulderDef: textured plywood segments (split vertically for tall
// rope walls so textures stay ≤ 2048²), the structural box behind them, padded edge trims with a
// signal hairline, and the hold + quickdraw sets placed through the WallFrame.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PALETTE } from '../config/brand';
import type { BoulderDef, HoldDef } from '../core/types';
import { WallFrame } from './wall-frame';
import { HoldSet, type HoldSetOptions } from './holds';
import { QuickdrawSet } from './quickdraws';
import { createWallTextures, type WallTextureSet } from './textures';
import type { QualityPreset } from './quality';

interface Segment {
  mesh: THREE.Mesh;
  tex: WallTextureSet;
  mat: THREE.MeshStandardMaterial;
}

/** Max segment height for rope walls (m). */
const SEGMENT_MAX = 5.2;
const THICKNESS = 0.22;

export class WallView {
  readonly group = new THREE.Group();
  readonly holds: HoldSet;
  readonly quickdraws: QuickdrawSet;
  private segments: Segment[] = [];
  private shell: THREE.Mesh | null = null;
  private trim: THREE.Mesh | null = null;
  private shellMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.92, metalness: 0 });
  private trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
  private boulder: BoulderDef | null = null;

  constructor(readonly frame: WallFrame) {
    this.group.name = 'wall';
    this.holds = new HoldSet(frame);
    this.quickdraws = new QuickdrawSet(frame);
    this.group.add(this.holds.group, this.quickdraws.group);
  }

  build(b: BoulderDef, preset: QualityPreset, holdOpts: HoldSetOptions = {}): void {
    this.clearPanel();
    this.boulder = b;
    this.frame.setAngle(b.wallAngle);
    const segCount = Math.max(1, Math.ceil(b.height / SEGMENT_MAX));
    const segH = b.height / segCount;
    const ppm = b.mode === 'rope' ? preset.wallPxPerMeter * 0.72 : preset.wallPxPerMeter;
    for (let i = 0; i < segCount; i++) {
      const y0 = i * segH;
      const y1 = (i + 1) * segH;
      const tex = createWallTextures({
        width: b.width,
        y0,
        y1,
        wallHeight: b.height,
        angleDeg: b.wallAngle,
        mode: b.mode,
        holds: b.holds,
        seed: b.seed,
        pxPerMeter: ppm,
        anisotropy: preset.anisotropy,
        wallNo: (Math.abs(b.seed) % 12) + 1,
      });
      const mat = new THREE.MeshStandardMaterial({
        map: tex.map,
        normalMap: tex.normalMap,
        roughnessMap: tex.roughnessMap,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.55,
      });
      mat.normalScale.set(0.75, 0.75);
      const geo = new THREE.PlaneGeometry(b.width, y1 - y0);
      const mesh = new THREE.Mesh(geo, mat);
      this.frame.toWorldXYZ(0, (y0 + y1) / 2, 0, mesh.position);
      mesh.quaternion.copy(this.frame.quaternion);
      mesh.receiveShadow = true;
      mesh.name = `wall:segment${i}`;
      this.group.add(mesh);
      this.segments.push({ mesh, tex, mat });
    }

    // structural shell behind the panel (visible on the sides of overhangs)
    const shellGeo = new THREE.BoxGeometry(b.width + 0.02, b.height + 0.02, THICKNESS);
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.frame.toWorldXYZ(0, b.height / 2, -THICKNESS / 2 - 0.003, this.shell.position);
    this.shell.quaternion.copy(this.frame.quaternion);
    this.shell.receiveShadow = true;
    this.shell.name = 'wall:shell';
    this.group.add(this.shell);

    this.trim = new THREE.Mesh(this.buildTrim(b), this.trimMat);
    this.trim.castShadow = true;
    this.trim.receiveShadow = true;
    this.trim.name = 'wall:trim';
    this.group.add(this.trim);

    // below 'high' the small deco holds keep only their contact AO (saves a full shadow pass of them)
    this.holds.build(b, b.holds, { decoShadows: preset.shadowMapSize >= 2048, ...holdOpts });
    this.quickdraws.build(b.mode === 'rope' ? b.quickdraws : undefined);
  }

  /** Padded edge trims (left, right, top) with a signal hairline on their inner face. */
  private buildTrim(b: BoulderDef): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const w = 0.075;
    const d = 0.07;
    const color = (g: THREE.BufferGeometry, hex: string) => {
      const n = g.getAttribute('position').count;
      const c = new THREE.Color(hex);
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g.index ? g.toNonIndexed() : g;
    };
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const place = (g: THREE.BufferGeometry, x: number, y: number, z: number) => {
      this.frame.toWorldXYZ(x, y, z, p);
      m.compose(p, this.frame.quaternion, one);
      return g.applyMatrix4(m);
    };
    const hx = b.width / 2;
    const H = b.height;
    for (const side of [-1, 1]) {
      const bar = new RoundedBoxGeometry(w, H + w, d, 3, 0.022);
      parts.push(place(color(bar, '#1B1D21'), side * (hx + w / 2 - 0.012), H / 2 + 0.01, d / 2 - 0.035));
      const line = new THREE.BoxGeometry(0.005, H - 0.3, 0.004);
      parts.push(place(color(line, PALETTE.signal), side * (hx + 0.016), H / 2 + 0.15, d - 0.034));
    }
    const topBar = new RoundedBoxGeometry(b.width + 2 * w - 0.02, w, d, 3, 0.022);
    parts.push(place(color(topBar, '#1B1D21'), 0, H + w / 2 - 0.012, d / 2 - 0.035));
    // kicker strip where the panel meets the pads
    const kick = new RoundedBoxGeometry(b.width, 0.1, 0.05, 2, 0.015);
    parts.push(place(color(kick, '#15171A'), 0, 0.33, 0.012));
    const kickLine = new THREE.BoxGeometry(b.width - 0.1, 0.006, 0.003);
    parts.push(place(color(kickLine, PALETTE.signal), 0, 0.372, 0.038));
    const merged = mergeGeometries(parts, false) as THREE.BufferGeometry;
    for (const g of parts) g.dispose();
    return merged;
  }

  /** Rebuild only the holds (editor). Every hold becomes its own mesh so all can be selected. */
  updateHolds(holds: readonly HoldDef[]): void {
    if (!this.boulder) return;
    this.holds.build(this.boulder, holds, { separateAll: true });
  }

  update(dt: number): void {
    this.quickdraws.update(dt);
  }

  private clearPanel(): void {
    for (const s of this.segments) {
      this.group.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mat.dispose();
      s.tex.dispose();
    }
    this.segments = [];
    for (const mesh of [this.shell, this.trim]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.shell = this.trim = null;
  }

  dispose(): void {
    this.clearPanel();
    this.holds.dispose();
    this.quickdraws.dispose();
    this.shellMat.dispose();
    this.trimMat.dispose();
  }
}

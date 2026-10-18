// The main climbing wall for a BoulderDef: textured plywood segments (split along the surface for
// tall rope walls so textures stay ≤ 2048²) that FOLD with a multi-angle profile (one flat strip
// per panel, sharp creases at the folds), the structure around them (side cheeks closing the
// folded shape down to a vertical back, a top cap), padded edge trims with a CHIRAL pink hairline
// following every panel, and the hold + quickdraw sets placed through the WallFrame.
//
// The wall material also draws the climber's contact shadows (ContactShadows' uniform list,
// evaluated in wall-surface coordinates), so they wrap over lips and into inside corners.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PALETTE } from '../config/brand';
import type { BoulderDef, HoldDef } from '../core/types';
import type { PanelSpan } from '../game/wall-profile';
import { WallFrame, panelQuaternion } from './wall-frame';
import { HoldSet, type HoldSetOptions } from './holds';
import { QuickdrawSet } from './quickdraws';
import { createWallTextures, type WallTextureSet } from './textures';
import { WALL_CONTACT_DECL, type ContactUniforms } from './contact-shadows';
import type { QualityPreset } from './quality';

interface Segment {
  mesh: THREE.Mesh;
  tex: WallTextureSet;
  mat: THREE.MeshStandardMaterial;
}

/** Max segment length along the surface for rope walls (m). */
const SEGMENT_MAX = 5.2;
const THICKNESS = 0.22;

/**
 * A strip of the wall surface between surface heights y0 and y1, folded at every panel boundary
 * in between: sharp per-panel normals, UVs spanning the strip (u across, v up the surface) and an
 * `aWall` attribute with the surface coordinates (contact shadows).
 */
export function foldedStrip(frame: WallFrame, width: number, y0: number, y1: number, spans: readonly PanelSpan[]): THREE.BufferGeometry {
  const rows: { y: number; panel: number }[] = [];
  for (const s of spans) {
    const a = Math.max(y0, s.y0);
    const b = Math.min(y1, s.y1);
    if (b - a < 1e-5) continue;
    rows.push({ y: a, panel: s.index }, { y: b, panel: s.index });
  }
  if (!rows.length) rows.push({ y: y0, panel: 0 }, { y: y1, panel: 0 });
  const quads = rows.length / 2;
  const pos = new Float32Array(quads * 4 * 3);
  const nrm = new Float32Array(quads * 4 * 3);
  const uv = new Float32Array(quads * 4 * 2);
  const wall = new Float32Array(quads * 4 * 2);
  const idx: number[] = [];
  const hw = width / 2;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const len = Math.max(1e-6, y1 - y0);
  for (let q = 0; q < quads; q++) {
    const ra = rows[q * 2];
    const rb = rows[q * 2 + 1];
    frame.normalAt((ra.y + rb.y) / 2, n, false);
    const corners: [number, number][] = [[-hw, ra.y], [hw, ra.y], [hw, rb.y], [-hw, rb.y]];
    for (let k = 0; k < 4; k++) {
      const [x, y] = corners[k];
      frame.toWorldXYZ(x, y, 0, p);
      const i = q * 4 + k;
      pos.set([p.x, p.y, p.z], i * 3);
      nrm.set([n.x, n.y, n.z], i * 3);
      uv.set([(x + hw) / width, (y - y0) / len], i * 2);
      wall.set([x, y], i * 2);
    }
    const b = q * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aWall', new THREE.BufferAttribute(wall, 2));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export class WallView {
  readonly group = new THREE.Group();
  readonly holds: HoldSet;
  readonly quickdraws: QuickdrawSet;
  private segments: Segment[] = [];
  private shell: THREE.Mesh | null = null;
  private trim: THREE.Mesh | null = null;
  private shellMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  private trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
  private boulder: BoulderDef | null = null;

  constructor(
    readonly frame: WallFrame,
    private contact: ContactUniforms | null = null,
  ) {
    this.group.name = 'wall';
    this.holds = new HoldSet(frame);
    this.quickdraws = new QuickdrawSet(frame);
    this.group.add(this.holds.group, this.quickdraws.group);
  }

  build(b: BoulderDef, preset: QualityPreset, holdOpts: HoldSetOptions = {}): void {
    this.clearPanel();
    this.boulder = b;
    this.frame.setWall(b);
    const spans = this.frame.spans();
    const segCount = Math.max(1, Math.ceil(b.height / SEGMENT_MAX));
    const segH = b.height / segCount;
    const ppm = b.mode === 'rope' ? preset.wallPxPerMeter * 0.72 : preset.wallPxPerMeter;
    const panels = this.frame.folded ? spans.map((s) => ({ y0: s.y0, angle: s.angle })) : undefined;
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
        panels,
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
      this.patchContact(mat);
      const mesh = new THREE.Mesh(foldedStrip(this.frame, b.width, y0, y1, spans), mat);
      mesh.receiveShadow = true;
      mesh.name = `wall:segment${i}`;
      this.group.add(mesh);
      this.segments.push({ mesh, tex, mat });
    }

    // structure around the panels: side cheeks (visible on overhangs, roofs and slabs), top cap, back
    this.shell = new THREE.Mesh(this.buildShell(b, spans), this.shellMat);
    this.shell.receiveShadow = true;
    this.shell.castShadow = true;
    this.shell.name = 'wall:shell';
    this.group.add(this.shell);

    this.trim = new THREE.Mesh(this.buildTrim(b, spans), this.trimMat);
    this.trim.castShadow = true;
    this.trim.receiveShadow = true;
    this.trim.name = 'wall:trim';
    this.group.add(this.trim);

    // below 'high' the small deco holds keep only their contact AO (saves a full shadow pass of them)
    this.holds.build(b, b.holds, { decoShadows: preset.shadowMapSize >= 2048, ...holdOpts });
    this.quickdraws.build(b.mode === 'rope' ? b.quickdraws : undefined);
  }

  /** Contact shadows in the wall shader (wall-surface coordinates from the `aWall` attribute). */
  private patchContact(mat: THREE.MeshStandardMaterial): void {
    const c = this.contact;
    if (!c) return;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uContact = c.uContact;
      shader.uniforms.uContactN = c.uContactN;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aWall;\nvarying vec2 vWall;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvWall = aWall;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vWall;\n${WALL_CONTACT_DECL}`)
        .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb *= 1.0 - contactShade(vWall);');
    };
    mat.customProgramCacheKey = () => 'wall-contact';
  }

  /**
   * The structure the panels are bolted to: a side cheek on each side closing the folded surface
   * down to a vertical back (a solid block under a slab, behind an overhang, above a cave roof), the
   * top cap and the back face.
   */
  private buildShell(b: BoulderDef, spans: readonly PanelSpan[]): THREE.BufferGeometry {
    const hw = b.width / 2 + 0.012;
    let minZ = 0;
    for (const s of spans) minZ = Math.min(minZ, s.top.z, s.bottom.z);
    const zBack = minZ - THICKNESS;
    const last = spans[spans.length - 1];
    const topH = last.top.y;
    const topZ = last.top.z;
    // side profile (shape x = world z, shape y = world height), counter-clockwise
    const contour: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
    for (const s of spans) contour.push(new THREE.Vector2(s.top.z, s.top.y));
    contour.push(new THREE.Vector2(zBack, topH), new THREE.Vector2(zBack, 0));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const o = this.frame.origin;
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const pos: number[] = [];
      for (const v of contour) pos.push(o.x + side * hw, o.y + v.y, o.z + v.x);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const idx: number[] = [];
      for (const t of tris) {
        if (side > 0) idx.push(t[0], t[2], t[1]);
        else idx.push(t[0], t[1], t[2]);
      }
      g.setIndex(idx);
      parts.push(g.toNonIndexed());
      g.dispose();
    }
    // top cap (from the wall's top edge back to the back face) and the back face
    const quad = (a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, bb.x, bb.y, bb.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z], 3));
      return g;
    };
    const V = (x: number, h: number, z: number) => new THREE.Vector3(o.x + x, o.y + h, o.z + z);
    parts.push(quad(V(-hw, topH, topZ), V(hw, topH, topZ), V(hw, topH, zBack), V(-hw, topH, zBack)));
    parts.push(quad(V(-hw, 0, zBack), V(-hw, topH, zBack), V(hw, topH, zBack), V(hw, 0, zBack)));
    const merged = mergeGeometries(parts, false) as THREE.BufferGeometry;
    for (const g of parts) g.dispose();
    merged.computeVertexNormals();
    return merged;
  }

  /** Padded edge trims (left, right along every panel, top) with a CHIRAL pink hairline on their inner face. */
  private buildTrim(b: BoulderDef, spans: readonly PanelSpan[]): THREE.BufferGeometry {
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
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const place = (g: THREE.BufferGeometry, x: number, y: number, z: number, angle: number) => {
      this.frame.toWorldXYZ(x, y, 0, p);
      panelQuaternion(angle, q);
      // the offset out of the wall follows the panel's own (sharp) normal
      p.add(new THREE.Vector3(0, 0, z).applyQuaternion(q));
      m.compose(p, q, one);
      return g.applyMatrix4(m);
    };
    const hx = b.width / 2;
    const H = b.height;
    const n = spans.length;
    for (const s of spans) {
      const first = s.index === 0;
      const lastSpan = s.index === n - 1;
      // each panel's bars reach a little past its folds so the joints stay closed
      const a0 = first ? -w / 2 + 0.01 : s.y0 - w * 0.5;
      const a1 = lastSpan ? H + w / 2 + 0.01 : s.y1 + w * 0.5;
      const len = a1 - a0;
      const mid = (a0 + a1) / 2;
      for (const side of [-1, 1]) {
        const bar = new RoundedBoxGeometry(w, len, d, 3, 0.022);
        parts.push(place(color(bar, '#1B1D21'), side * (hx + w / 2 - 0.012), mid, d / 2 - 0.035, s.angle));
        const l0 = Math.max(first ? 0.3 : s.y0 + 0.04, 0);
        const l1 = lastSpan ? H : s.y1 - 0.04;
        if (l1 - l0 > 0.05) {
          const line = new THREE.BoxGeometry(0.005, l1 - l0, 0.004);
          parts.push(place(color(line, PALETTE.signal), side * (hx + 0.016), (l0 + l1) / 2, d - 0.034, s.angle));
        }
      }
    }
    const top = spans[n - 1];
    const topBar = new RoundedBoxGeometry(b.width + 2 * w - 0.02, w, d, 3, 0.022);
    parts.push(place(color(topBar, '#1B1D21'), 0, H + w / 2 - 0.012, d / 2 - 0.035, top.angle));
    // kicker strip where the panel meets the pads
    const kickA = this.frame.angleAt(0.33);
    const kick = new RoundedBoxGeometry(b.width, 0.1, 0.05, 2, 0.015);
    parts.push(place(color(kick, '#15171A'), 0, 0.33, 0.012, kickA));
    const kickLine = new THREE.BoxGeometry(b.width - 0.1, 0.006, 0.003);
    parts.push(place(color(kickLine, PALETTE.signal), 0, 0.372, 0.038, kickA));
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

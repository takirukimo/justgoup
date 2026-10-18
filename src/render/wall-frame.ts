import * as THREE from 'three';
import type { BoulderDef, Vec2, WallPanel } from '../core/types';
import {
  angleAt as profAngleAt,
  local3DToSurface,
  normalAt as profNormalAt,
  panelIndexAt,
  panelSpans,
  profileOf,
  smoothAngleAt,
  surfaceToLocal3D,
  wallOverhang,
  wallTopHeight,
  type PanelSpan,
  type SurfacePoint,
  type Vec3,
  type WallProfile,
} from '../game/wall-profile';

const DEG = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Maps wall-local 2D coordinates (meters; x right, y = distance ALONG the wall surface from the
 * floor, origin bottom-centre at floor level) plus a depth (distance out from the wall surface) to
 * world space.
 *
 * World convention: +Y up, camera generally on +Z looking toward −Z, wall surface faces +Z.
 *
 * FLAT walls (one panel at `angleDeg`) pivot about their bottom edge: a positive angle (overhang)
 * tilts the top TOWARD the camera: surface point = (x, y·cosθ, y·sinθ), normal (toward the
 * climber) = (0, −sinθ, cosθ). This is the exact math of the original single-plane frame.
 *
 * FOLDED walls (BoulderDef.profile, game/wall-profile.ts) stack flat panels along the surface:
 * toWorld / fromWorld follow the folds (holds sit exactly on their panel; points off the wall use
 * the normal that turns smoothly across each fold, so the mapping is continuous at every depth).
 * The per-y frame is normalAt / upAt / quaternionAt: `blended = false` (the default for quaternionAt)
 * is the sharp panel frame for things bolted ON the wall (holds, tapes, hangers, decals),
 * `blended = true` the smooth frame for things OFF it (the body, a dangling limb, the camera).
 *
 * `up`, `normal`, `quaternion` and `angleDeg` are the BODY frame: the wall frame where the climber
 * is (setBodyY, the blended frame at that surface height). On a flat wall they are simply the
 * wall's frame, so callers written for one plane keep working.
 */
export class WallFrame {
  /** Body-frame wall angle (degrees): the flat wall's angle, or the smooth angle at the body. */
  angleDeg: number;
  readonly normal = new THREE.Vector3();
  readonly up = new THREE.Vector3(); // wall-local +y direction in world (body frame)
  readonly right = new THREE.Vector3(1, 0, 0);
  /** World-space offset of the wall origin (for scenes with several walls). */
  readonly origin = new THREE.Vector3();
  /** Rotation that takes a wall-local object (x right, y up, z = out of wall) into world (body frame). */
  readonly quaternion = new THREE.Quaternion();

  private prof: WallProfile | null = null;
  private flatAngle = 0;
  private len = Infinity;
  private bodyY = 1.2;
  private spanCache: PanelSpan[] | null = null;
  private s3: Vec3 = { x: 0, y: 0, z: 0 };
  private sp: SurfacePoint = { x: 0, y: 0, depth: 0 };
  private tv = new THREE.Vector3();
  private tv2 = new THREE.Vector3();

  constructor(angleDeg = 0, origin?: THREE.Vector3) {
    this.angleDeg = angleDeg;
    if (origin) this.origin.copy(origin);
    this.setAngle(angleDeg);
  }

  /** A flat one-panel wall at `angleDeg` (clears any profile). */
  setAngle(angleDeg: number): void {
    this.prof = null;
    this.spanCache = null;
    this.flatAngle = angleDeg;
    this.applyBodyAngle(angleDeg);
  }

  /**
   * The wall of a boulder: folded when it has a real multi-angle `profile`, else flat at
   * `wallAngle`. `height` is the surface length.
   */
  setWall(b: Pick<BoulderDef, 'wallAngle' | 'height'> & { profile?: WallPanel[] }): void {
    const p = profileOf(b);
    this.len = b.height;
    if (!p) {
      this.setAngle(b.wallAngle);
      return;
    }
    this.prof = p;
    this.spanCache = null;
    this.flatAngle = b.wallAngle;
    this.setBodyY(this.bodyY);
  }

  /** The folded profile, or null for a flat wall. */
  get profile(): WallProfile | null {
    return this.prof;
  }

  /** True when the wall really folds (≥ 2 panels at different angles). */
  get folded(): boolean {
    return this.prof !== null;
  }

  /** Surface length of the wall (its y extent, = BoulderDef.height). */
  get length(): number {
    return this.len;
  }

  /** Point the body frame (up / normal / quaternion / angleDeg) at surface height y (blended frame). */
  setBodyY(y: number): void {
    this.bodyY = Number.isFinite(y) ? y : this.bodyY;
    if (!this.prof) return;
    this.applyBodyAngle(smoothAngleAt(this.prof, this.bodyY));
  }

  private applyBodyAngle(angleDeg: number): void {
    this.angleDeg = angleDeg;
    const t = angleDeg * DEG;
    this.up.set(0, Math.cos(t), Math.sin(t));
    this.normal.set(0, -Math.sin(t), Math.cos(t));
    // Rotation about X by +t maps (0,1,0)→(0,cos t, sin t) and (0,0,1)→(0,−sin t, cos t).
    this.quaternion.setFromAxisAngle(X_AXIS, t);
  }

  // ───────────────────────────── per-y frame ─────────────────────────────

  /** Panel angle (degrees) at surface height y: sharp (the panel a hold is bolted to) or smooth. */
  angleAt(y: number, blended = false): number {
    if (!this.prof) return this.flatAngle;
    return blended ? smoothAngleAt(this.prof, y) : profAngleAt(this.prof, y);
  }

  /** Outward unit normal at surface height y (blended across folds by default). */
  normalAt(y: number, out = new THREE.Vector3(), blended = true): THREE.Vector3 {
    if (!this.prof) return out.copy(this.normalFlat());
    profNormalAt(this.prof, y, this.s3, blended);
    return out.set(0, this.s3.y, this.s3.z);
  }

  /** Unit direction up the surface (toward larger y) at surface height y. */
  upAt(y: number, out = new THREE.Vector3(), blended = true): THREE.Vector3 {
    if (!this.prof) return out.copy(this.upFlat());
    profNormalAt(this.prof, y, this.s3, blended);
    return out.set(0, this.s3.z, -this.s3.y);
  }

  /** Rotation of the wall frame at surface height y (sharp panel frame by default: things bolted on). */
  quaternionAt(y: number, out = new THREE.Quaternion(), blended = false): THREE.Quaternion {
    return out.setFromAxisAngle(X_AXIS, this.angleAt(y, blended) * DEG);
  }

  private normalFlat(): THREE.Vector3 {
    const t = this.flatAngle * DEG;
    return this.tv2.set(0, -Math.sin(t), Math.cos(t));
  }

  private upFlat(): THREE.Vector3 {
    const t = this.flatAngle * DEG;
    return this.tv2.set(0, Math.cos(t), Math.sin(t));
  }

  /** Index of the panel at surface height y (0 on a flat wall). */
  panelIndex(y: number): number {
    return this.prof ? panelIndexAt(this.prof, y) : 0;
  }

  /** Panels as mesh-ready spans over [0, length] (one span on a flat wall). */
  spans(): PanelSpan[] {
    if (this.spanCache) return this.spanCache;
    if (this.prof) this.spanCache = panelSpans(this.prof, this.len);
    else {
      const t = this.flatAngle * DEG;
      const L = Number.isFinite(this.len) ? this.len : 4.5;
      this.spanCache = [
        {
          index: 0,
          y0: 0,
          y1: L,
          angle: this.flatAngle,
          bottom: { y: 0, z: 0 },
          top: { y: L * Math.cos(t), z: L * Math.sin(t) },
          normal: { y: -Math.sin(t), z: Math.cos(t) },
        },
      ];
    }
    return this.spanCache;
  }

  /** World height (above the frame origin) of the top of the wall. */
  topHeight(): number {
    if (this.prof) return wallTopHeight(this.prof, this.len);
    return this.len * Math.cos(this.flatAngle * DEG);
  }

  /** How far (m) the top of the wall leans out over its base (negative for a slab). */
  topOut(): number {
    if (this.prof) return wallOverhang(this.prof, this.len);
    return this.len * Math.sin(this.flatAngle * DEG);
  }

  // ───────────────────────────── mapping ─────────────────────────────

  /** Wall-local (x, y) at `depth` m out from the surface → world position. */
  toWorld(p: Vec2, depth = 0, out = new THREE.Vector3()): THREE.Vector3 {
    return this.toWorldXYZ(p.x, p.y, depth, out);
  }

  toWorldXYZ(x: number, y: number, depth = 0, out = new THREE.Vector3()): THREE.Vector3 {
    if (this.prof) {
      surfaceToLocal3D(this.prof, x, y, depth, this.s3);
      return out.set(this.origin.x + this.s3.x, this.origin.y + this.s3.y, this.origin.z + this.s3.z);
    }
    const t = this.flatAngle * DEG;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return out.set(this.origin.x + x, this.origin.y + y * c - depth * s, this.origin.z + y * s + depth * c);
  }

  /** World position → wall-local {x, y} and depth. */
  fromWorld(w: THREE.Vector3): { p: Vec2; depth: number } {
    const dx = w.x - this.origin.x;
    const dy = w.y - this.origin.y;
    const dz = w.z - this.origin.z;
    if (this.prof) {
      local3DToSurface(this.prof, dx, dy, dz, this.sp);
      return { p: { x: this.sp.x, y: this.sp.y }, depth: this.sp.depth };
    }
    const t = this.flatAngle * DEG;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return { p: { x: dx, y: dy * c + dz * s }, depth: -dy * s + dz * c };
  }

  /** The wall surface at the body (a flat wall's plane) as a THREE.Plane. */
  plane(out = new THREE.Plane()): THREE.Plane {
    if (!this.prof) return out.setFromNormalAndCoplanarPoint(this.normalFlat(), this.origin);
    this.toWorldXYZ(0, this.bodyY, 0, this.tv);
    return out.setFromNormalAndCoplanarPoint(this.normal, this.tv);
  }

  /**
   * Ray-cast onto the (folded) wall surface: the nearest hit in front of the ray origin on any
   * panel within its surface range (the first panel extends below the floor, the last past the
   * top, so a finger just off the wall still lands somewhere sensible). Writes the wall-local
   * point into `out` and returns the world hit distance, or −1 for no hit.
   */
  raycast(ray: THREE.Ray, out: Vec2, worldOut?: THREE.Vector3): number {
    const spans = this.spans();
    let best = -1;
    const o = ray.origin;
    const d = ray.direction;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      // panel plane: point B = origin + (0, bottom.y, bottom.z), normal N = (0, ny, nz)
      const ny = s.normal.y;
      const nz = s.normal.z;
      const denom = d.y * ny + d.z * nz;
      if (Math.abs(denom) < 1e-6) continue;
      const by = this.origin.y + s.bottom.y;
      const bz = this.origin.z + s.bottom.z;
      const t = ((by - o.y) * ny + (bz - o.z) * nz) / denom;
      if (!(t > 1e-4)) continue;
      if (best >= 0 && t >= best) continue;
      const hy = o.y + d.y * t - by;
      const hz = o.z + d.z * t - bz;
      // distance along the panel from its bottom edge: tangent = (nz, −ny)
      const along = hy * nz - hz * ny;
      const y = s.y0 + along;
      const lo = i === 0 ? -Infinity : s.y0 - 1e-6;
      const hi = i === spans.length - 1 ? Infinity : s.y1 + 1e-6;
      if (y < lo || y > hi) continue;
      best = t;
      out.x = o.x + d.x * t - this.origin.x;
      out.y = y;
      if (worldOut) worldOut.copy(o).addScaledVector(d, t);
    }
    return best;
  }
}

/** Rotation about the wall-local x axis by `angleDeg` (a panel's frame), into `out`. */
export function panelQuaternion(angleDeg: number, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromAxisAngle(X_AXIS, angleDeg * DEG);
}

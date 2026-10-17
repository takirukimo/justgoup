import * as THREE from 'three';
import type { Vec2 } from '../core/types';

/**
 * Maps wall-local 2D coordinates (meters; x right, y up, origin bottom-centre at floor level)
 * plus a depth (distance out from the wall surface) to world space.
 *
 * World convention: +Y up, camera generally on +Z looking toward −Z, wall surface faces +Z.
 * The wall pivots about its bottom edge (the X axis at the origin). A positive wallAngle
 * (overhang) tilts the top TOWARD the camera:  surface point = (x, y·cosθ, y·sinθ).
 * Normal (pointing away from the wall, toward the climber) = (0, −sinθ, cosθ).
 */
export class WallFrame {
  angleDeg: number;
  readonly normal = new THREE.Vector3();
  readonly up = new THREE.Vector3(); // wall-local +y direction in world
  readonly right = new THREE.Vector3(1, 0, 0);
  /** World-space offset of the wall origin (for scenes with several walls). */
  readonly origin = new THREE.Vector3();
  /** Rotation that takes a wall-local object (x right, y up, z = out of wall) into world. */
  readonly quaternion = new THREE.Quaternion();

  constructor(angleDeg = 0, origin?: THREE.Vector3) {
    this.angleDeg = angleDeg;
    if (origin) this.origin.copy(origin);
    this.setAngle(angleDeg);
  }

  setAngle(angleDeg: number): void {
    this.angleDeg = angleDeg;
    const t = (angleDeg * Math.PI) / 180;
    this.up.set(0, Math.cos(t), Math.sin(t));
    this.normal.set(0, -Math.sin(t), Math.cos(t));
    // Rotation about X by +t maps (0,1,0)→(0,cos t, sin t) and (0,0,1)→(0,−sin t, cos t).
    this.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), t);
  }

  /** Wall-local (x, y) at `depth` m out from the surface → world position. */
  toWorld(p: Vec2, depth = 0, out = new THREE.Vector3()): THREE.Vector3 {
    return out
      .copy(this.origin)
      .addScaledVector(this.right, p.x)
      .addScaledVector(this.up, p.y)
      .addScaledVector(this.normal, depth);
  }

  toWorldXYZ(x: number, y: number, depth = 0, out = new THREE.Vector3()): THREE.Vector3 {
    return out
      .copy(this.origin)
      .addScaledVector(this.right, x)
      .addScaledVector(this.up, y)
      .addScaledVector(this.normal, depth);
  }

  /** World position → wall-local {x, y} and depth. */
  fromWorld(w: THREE.Vector3): { p: Vec2; depth: number } {
    const d = w.clone().sub(this.origin);
    return { p: { x: d.dot(this.right), y: d.dot(this.up) }, depth: d.dot(this.normal) };
  }

  /** The wall surface as a THREE.Plane (for ray casting). */
  plane(out = new THREE.Plane()): THREE.Plane {
    return out.setFromNormalAndCoplanarPoint(this.normal, this.origin);
  }
}

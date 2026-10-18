// Contact shadows: soft dark blobs where the climber's body is close to the wall (torso, head,
// hands, feet, elbows, knees) plus one on the crash pads below the climber. They fade and spread
// with distance from the surface, which sells the 3D placement even without a shadow map.
//
// The wall blobs are not geometry: they are a small uniform list (surface x, y, radius, opacity)
// that the main wall's material evaluates per fragment in wall-surface coordinates (wallShadeChunk),
// so a blob follows a folded wall exactly — over a roof lip, into an inside corner — instead of
// a flat decal floating off a convex fold. The pad blob is one instanced quad.

import * as THREE from 'three';
import type { ClimberState, LimbId } from '../core/types';
import { GAME } from '../config/tuning';
import { smoothstep } from '../core/math';
import type { WallFrame } from './wall-frame';

/** Wall blobs the wall shader evaluates (keep in sync with wallShadeChunk's loop bound). */
export const CONTACT_MAX = 14;
const LIMBS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];

/** Uniforms shared with the wall material (see wallShadeChunk). */
export interface ContactUniforms {
  uContact: { value: THREE.Vector4[] };
  uContactN: { value: number };
}

/**
 * GLSL for the wall material: declarations (uniforms) and a function `contactShade(vec2 wallXY)` →
 * 0..1 darkening. wallXY is the fragment's wall-surface position (x, y along the surface, m).
 */
export const WALL_CONTACT_DECL = /* glsl */ `
uniform vec4 uContact[${CONTACT_MAX}];
uniform int uContactN;
float contactShade(vec2 p) {
  float s = 0.0;
  for (int i = 0; i < ${CONTACT_MAX}; i++) {
    if (i >= uContactN) break;
    vec4 b = uContact[i];
    float r = length(p - b.xy) / max(b.z, 1e-3);
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.6) * b.w;
    s = 1.0 - (1.0 - s) * (1.0 - a);
  }
  return s;
}
`;

export class ContactShadows {
  /** The pad blob (instanced so its matrix updates without reallocating). */
  readonly mesh: THREE.InstancedMesh;
  readonly uniforms: ContactUniforms;
  private opacity: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private qFloor = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private count = 0;
  /** Overall strength (higher when there is no shadow map). */
  strength = 1;

  constructor(private frame: WallFrame) {
    const blobs: THREE.Vector4[] = [];
    for (let i = 0; i < CONTACT_MAX; i++) blobs.push(new THREE.Vector4(0, -100, 0.1, 0));
    this.uniforms = { uContact: { value: blobs }, uContactN: { value: 0 } };
    const geo = new THREE.PlaneGeometry(1, 1);
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(1), 1);
    this.opacity.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOpacity', this.opacity);
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aOpacity;
        varying vec2 vUv;
        varying float vO;
        void main() {
          vUv = uv;
          vO = aOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vO;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.6) * vO;
          if (a < 0.002) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, 1);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'contact-shadows';
    this.mesh.count = 0;
  }

  private wallBlob(x: number, y: number, depth: number, r0: number, a0: number): void {
    if (this.count >= CONTACT_MAX) return;
    const d = Math.max(0, depth);
    const a = a0 * (1 - smoothstep(0.015, 0.75, d)) * this.strength;
    if (a <= 0.01) return;
    const r = r0 + d * 0.55;
    // the key light sits above-right of the camera → shadows drift down-left with distance
    this.uniforms.uContact.value[this.count].set(x - d * 0.12, y - d * 0.22, r, Math.min(0.85, a));
    this.count++;
  }

  update(state: ClimberState | null, visible: boolean): void {
    this.count = 0;
    let floor = 0;
    if (state && visible) {
      const pd = state.pelvisDepth;
      // torso: three blobs along the spine, head above the chest
      for (let k = 0; k < 3; k++) {
        const t = k / 2;
        this.wallBlob(state.pelvis.x + (state.chest.x - state.pelvis.x) * t, state.pelvis.y + (state.chest.y - state.pelvis.y) * t, pd + 0.06 - t * 0.04, 0.15, 0.42);
      }
      const sx = state.chest.x - state.pelvis.x;
      const sy = state.chest.y - state.pelvis.y;
      const sl = Math.hypot(sx, sy) || 1;
      this.wallBlob(state.chest.x + (sx / sl) * 0.22, state.chest.y + (sy / sl) * 0.22, pd + 0.02, 0.11, 0.32);
      for (const id of LIMBS) {
        const l = state.limbs[id];
        const hand = id === 'LH' || id === 'RH';
        this.wallBlob(l.pos.x, l.pos.y, l.depth, hand ? 0.045 : 0.06, hand ? 0.55 : 0.5);
        // elbow / knee: between the root and the end, bowed away from the wall
        this.wallBlob((l.anchor.x + l.pos.x) / 2, (l.anchor.y + l.pos.y) / 2, (pd + l.depth) / 2 + 0.07, hand ? 0.06 : 0.08, 0.3);
      }
      // floor blob on the pads, fades with height
      this.frame.toWorldXYZ(state.com.x, state.com.y, pd, this.p);
      const h = this.p.y - this.frame.origin.y - GAME.padHeight;
      const a = 0.55 * (1 - smoothstep(0.2, 2.6, h)) * this.strength;
      if (a > 0.01) {
        const r = 0.32 + Math.max(0, h) * 0.18;
        this.p.y = this.frame.origin.y + GAME.padHeight + 0.006;
        this.m.compose(this.p, this.qFloor, this.s.set(r * 2.2, r * 2, 1));
        this.mesh.setMatrixAt(0, this.m);
        this.opacity.setX(0, a);
        floor = 1;
      }
    }
    this.uniforms.uContactN.value = this.count;
    this.mesh.count = floor;
    this.mesh.visible = floor > 0;
    if (floor > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.opacity.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

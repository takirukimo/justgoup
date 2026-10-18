// Contact shadows: soft dark blobs where the climber's body is close to the wall (torso, head,
// hands, feet, elbows, knees) plus one on the crash pads below the climber. They fade and spread
// with distance from the surface, which sells the 3D placement even without a shadow map.
// One instanced draw; instance data is rewritten in place every frame.

import * as THREE from 'three';
import type { ClimberState, LimbId } from '../core/types';
import { GAME } from '../config/tuning';
import { smoothstep } from '../core/math';
import type { WallFrame } from './wall-frame';

const MAX = 14;
const LIMBS: readonly LimbId[] = ['LH', 'RH', 'LF', 'RF'];

export class ContactShadows {
  readonly mesh: THREE.InstancedMesh;
  private opacity: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qFloor = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private count = 0;
  /** Overall strength (higher when there is no shadow map). */
  strength = 1;

  constructor(private frame: WallFrame) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
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
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'contact-shadows';
    this.mesh.count = 0;
  }

  private wallBlob(x: number, y: number, depth: number, r0: number, a0: number): void {
    if (this.count >= MAX - 1) return;
    const d = Math.max(0, depth);
    const a = a0 * (1 - smoothstep(0.015, 0.75, d)) * this.strength;
    if (a <= 0.01) return;
    const r = r0 + d * 0.55;
    // the key light sits above-right of the camera → shadows drift down-left with distance
    this.frame.toWorldXYZ(x - d * 0.12, y - d * 0.22, 0.0035, this.p);
    this.q.copy(this.frame.quaternion);
    this.m.compose(this.p, this.q, this.s.set(r * 2, r * 2, 1));
    this.mesh.setMatrixAt(this.count, this.m);
    this.opacity.setX(this.count, Math.min(0.85, a));
    this.count++;
  }

  update(state: ClimberState | null, visible: boolean): void {
    this.count = 0;
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
      if (this.count < MAX) {
        this.frame.toWorldXYZ(state.com.x, state.com.y, pd, this.p);
        const h = this.p.y - GAME.padHeight;
        const a = 0.55 * (1 - smoothstep(0.2, 2.6, h)) * this.strength;
        if (a > 0.01) {
          const r = 0.32 + Math.max(0, h) * 0.18;
          this.p.y = GAME.padHeight + 0.006;
          this.m.compose(this.p, this.qFloor, this.s.set(r * 2.2, r * 2, 1));
          this.mesh.setMatrixAt(this.count, this.m);
          this.opacity.setX(this.count, a);
          this.count++;
        }
      }
    }
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.opacity.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

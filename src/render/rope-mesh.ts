// CHARACTER: dynamic 10 mm lead rope.
//
// A verlet chain runs through the world anchor points (belayer hand → clipped draws → harness).
// Each span between anchors owns a number of particles proportional to its length, with a little
// slack so the rope sags naturally (more on the climber's span, almost none between draws). When
// the anchor set changes (a new clip) the old chain is resampled by arc length, so nothing pops.
// From the belayer's hand the rope's slack falls to the floor into a loose pile.
//
// Rendering: one tube mesh (Catmull-Rom smoothed, parallel-transport frames) with a twisted
// bicolour kernmantle sheath texture + matching bump. All buffers are preallocated: setPath() and
// update() never allocate.

import * as THREE from 'three';
import { GAME } from '../config/tuning';
import { PALETTE } from '../config/brand';
import { createRopeTexture } from './materials';

const MAX_ANCHORS = 40;
const MAX_PARTICLES = 260;
const LINK = 0.11; // target link length (m)
const SUB = 2; // render samples per link (Catmull-Rom between particles 11 cm apart)
const TAIL_SAMPLES = 120;
const MAX_SAMPLES = MAX_PARTICLES * SUB + TAIL_SAMPLES + 4;
const RADIAL = 6;
const RADIUS = 0.005;
const ITER = 12;
const GRAVITY = -9.81;
const V_REPEAT = 0.034; // metres per texture repeat along the rope

export class RopeMesh extends THREE.Object3D {
  private mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private posA: Float32Array;
  private nrmA: Float32Array;
  private uvA: Float32Array;

  // anchors (world)
  private anchors: THREE.Vector3[] = [];
  private anchorCount = 0;
  private structCount = -1;
  private hasPath = false;

  // particles
  private p: THREE.Vector3[] = [];
  private pp: THREE.Vector3[] = [];
  private pinned: Int8Array = new Int8Array(MAX_PARTICLES);
  private rest: Float32Array = new Float32Array(MAX_PARTICLES);
  private pCount = 0;
  /** First particle index of each span (span i = anchors i → i+1); spanStart[span count] = count − 1. */
  private spanStart: Int32Array = new Int32Array(MAX_ANCHORS + 1);
  private settle = 0;

  // samples for the tube
  private s: THREE.Vector3[] = [];
  private sArc: Float32Array = new Float32Array(MAX_SAMPLES);
  private sCount = 0;
  // scratch
  private t = new THREE.Vector3();
  private n = new THREE.Vector3();
  private b = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private old: THREE.Vector3[] = [];
  private oldArc: Float32Array = new Float32Array(MAX_PARTICLES);
  private tailEnd = new THREE.Vector3();
  private pileC = new THREE.Vector3();

  constructor(color?: string) {
    super();
    this.name = 'rope';
    for (let i = 0; i < MAX_ANCHORS; i++) this.anchors.push(new THREE.Vector3());
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.p.push(new THREE.Vector3());
      this.pp.push(new THREE.Vector3());
      this.old.push(new THREE.Vector3());
    }
    for (let i = 0; i < MAX_SAMPLES; i++) this.s.push(new THREE.Vector3());
    const nv = MAX_SAMPLES * (RADIAL + 1);
    this.posA = new Float32Array(nv * 3);
    this.nrmA = new Float32Array(nv * 3);
    this.uvA = new Float32Array(nv * 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posA, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrmA, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uvA, 2).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array((MAX_SAMPLES - 1) * RADIAL * 6);
    let k = 0;
    for (let i = 0; i < MAX_SAMPLES - 1; i++) {
      for (let r = 0; r < RADIAL; r++) {
        const a = i * (RADIAL + 1) + r;
        const b = a + 1;
        const c = a + RADIAL + 1;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    const tex = createRopeTexture(color ?? PALETTE.signal);
    this.mat = new THREE.MeshStandardMaterial({
      map: tex,
      bumpMap: tex,
      bumpScale: 1.4,
      roughness: 0.72,
      metalness: 0,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'rope-tube';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.add(this.mesh);
    this.visible = false;
  }

  setPath(points: THREE.Vector3[] | null): void {
    if (!points || points.length < 2) {
      this.visible = false;
      this.hasPath = false;
      this.structCount = -1;
      return;
    }
    const n = Math.min(points.length, MAX_ANCHORS);
    for (let i = 0; i < n; i++) this.anchors[i].copy(points[i]);
    this.anchorCount = n;
    this.visible = true;
    this.hasPath = true;
  }

  // ───────────────────────────── simulation ─────────────────────────────

  /** (Re)distribute particles over the spans, resampling the previous chain by arc length. */
  private rebuild(): void {
    const A = this.anchors;
    const na = this.anchorCount;
    // previous chain as a polyline (if any)
    const hadOld = this.pCount > 1;
    let oldN = 0;
    if (hadOld) {
      oldN = this.pCount;
      let acc = 0;
      for (let i = 0; i < oldN; i++) {
        this.old[i].copy(this.p[i]);
        if (i > 0) acc += this.p[i].distanceTo(this.p[i - 1]);
        this.oldArc[i] = acc;
      }
    }
    // particle budget per span
    let total = 0;
    for (let i = 0; i < na - 1; i++) total += A[i].distanceTo(A[i + 1]);
    const budget = MAX_PARTICLES - 1;
    let idx = 0;
    let arcSoFar = 0;
    for (let sIdx = 0; sIdx < na - 1; sIdx++) {
      const len = A[sIdx].distanceTo(A[sIdx + 1]);
      let k = Math.max(2, Math.round((len * 1.04) / LINK));
      const remainingSpans = na - 2 - sIdx;
      k = Math.min(k, budget - idx - remainingSpans * 2);
      k = Math.max(2, k);
      this.spanStart[sIdx] = idx;
      for (let j = 0; j < k; j++) {
        const u = j / k;
        const P = this.p[idx];
        if (hadOld && total > 1e-6) {
          // sample the old chain at the same fraction of the total rope
          const f = (arcSoFar + len * u) / total;
          this.sampleOld(f * this.oldArc[oldN - 1], oldN, P);
        } else {
          P.lerpVectors(A[sIdx], A[sIdx + 1], u);
          P.y -= Math.sin(u * Math.PI) * len * 0.04;
        }
        this.pp[idx].copy(P);
        this.pinned[idx] = j === 0 ? 1 : 0;
        idx++;
      }
      arcSoFar += len;
    }
    // last anchor
    this.p[idx].copy(A[na - 1]);
    this.pp[idx].copy(A[na - 1]);
    this.pinned[idx] = 1;
    this.spanStart[na - 1] = idx;
    this.pCount = idx + 1;
    this.structCount = na;
    this.settle = hadOld ? 0 : 0.6;
  }

  private sampleOld(arc: number, n: number, out: THREE.Vector3): void {
    if (arc <= 0) {
      out.copy(this.old[0]);
      return;
    }
    for (let i = 1; i < n; i++) {
      if (this.oldArc[i] >= arc) {
        const a = this.oldArc[i - 1];
        const t = (arc - a) / Math.max(1e-9, this.oldArc[i] - a);
        out.lerpVectors(this.old[i - 1], this.old[i], t);
        return;
      }
    }
    out.copy(this.old[n - 1]);
  }

  private simulate(dt: number): void {
    const A = this.anchors;
    const na = this.anchorCount;
    // rest lengths from the current chords (spans keep a little slack)
    for (let sIdx = 0; sIdx < na - 1; sIdx++) {
      const i0 = this.spanStart[sIdx];
      const i1 = this.spanStart[sIdx + 1];
      const k = i1 - i0;
      const len = A[sIdx].distanceTo(A[sIdx + 1]);
      const last = sIdx === na - 2;
      const first = sIdx === 0;
      const slack = last ? 1.006 : first ? 1.015 : 1.004;
      const r = (len * slack) / Math.max(1, k);
      for (let i = i0; i < i1; i++) this.rest[i] = r;
      // pin span start to its anchor
      this.p[i0].copy(A[sIdx]);
      this.pp[i0].copy(A[sIdx]);
    }
    const end = this.pCount - 1;
    this.p[end].copy(A[na - 1]);
    this.pp[end].copy(A[na - 1]);
    // verlet
    const steps = dt > 1 / 45 ? 2 : 1;
    const h = dt / steps;
    const damp = Math.exp(-2.2 * h);
    const g = GRAVITY * h * h;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.pCount; i++) {
        if (this.pinned[i]) continue;
        const P = this.p[i];
        const Q = this.pp[i];
        const vx = (P.x - Q.x) * damp;
        const vy = (P.y - Q.y) * damp;
        const vz = (P.z - Q.z) * damp;
        Q.copy(P);
        P.x += vx;
        P.y += vy + g;
        P.z += vz;
      }
      for (let it = 0; it < ITER; it++) {
        for (let i = 0; i < this.pCount - 1; i++) {
          const a = this.p[i];
          const b = this.p[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
          const diff = (d - this.rest[i]) / d;
          const pa = this.pinned[i];
          const pb = this.pinned[i + 1];
          if (pa && pb) continue;
          const wa = pa ? 0 : pb ? 1 : 0.5;
          const wb = pb ? 0 : pa ? 1 : 0.5;
          a.x += dx * diff * wa;
          a.y += dy * diff * wa;
          a.z += dz * diff * wa;
          b.x -= dx * diff * wb;
          b.y -= dy * diff * wb;
          b.z -= dz * diff * wb;
        }
      }
    }
  }

  // ───────────────────────────── geometry ─────────────────────────────

  private pushSample(x: number, y: number, z: number): void {
    if (this.sCount >= MAX_SAMPLES) return;
    const S = this.s[this.sCount];
    S.set(x, y, z);
    this.sArc[this.sCount] = this.sCount > 0 ? this.sArc[this.sCount - 1] + S.distanceTo(this.s[this.sCount - 1]) : 0;
    this.sCount++;
  }

  /** Catmull-Rom through the particles (reversed: the tail is added first, from the floor up). */
  private buildSamples(): void {
    this.sCount = 0;
    this.buildTail();
    const n = this.pCount;
    const P = this.p;
    for (let i = 0; i < n - 1; i++) {
      const p0 = P[Math.max(0, i - 1)];
      const p1 = P[i];
      const p2 = P[i + 1];
      const p3 = P[Math.min(n - 1, i + 2)];
      for (let k = i === 0 ? 1 : 0; k < SUB; k++) {
        const t = k / SUB;
        const t2 = t * t;
        const t3 = t2 * t;
        const c0 = -0.5 * t3 + t2 - 0.5 * t;
        const c1 = 1.5 * t3 - 2.5 * t2 + 1;
        const c2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
        const c3 = 0.5 * t3 - 0.5 * t2;
        this.pushSample(
          p0.x * c0 + p1.x * c1 + p2.x * c2 + p3.x * c3,
          p0.y * c0 + p1.y * c1 + p2.y * c2 + p3.y * c3,
          p0.z * c0 + p1.z * c1 + p2.z * c2 + p3.z * c3,
        );
      }
    }
    const last = P[n - 1];
    this.pushSample(last.x, last.y, last.z);
  }

  /** Slack from the belayer's hand down to the floor + a loose pile (static, follows the hand). */
  private buildTail(): void {
    const hand = this.anchors[0];
    const floorY = GAME.padHeight + RADIUS;
    // pile sits a little behind/beside the belayer
    this.pileC.set(hand.x - 0.22, floorY, hand.z + 0.28);
    // pile: three loose loops, outermost first so the rope ends at the drop point
    const loops = 3.2;
    const N = Math.floor(TAIL_SAMPLES * 0.7);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const a = u * loops * Math.PI * 2 + 0.6;
      const r = 0.2 - 0.07 * u + 0.025 * Math.sin(a * 2.3);
      const lift = RADIUS * 2.1 * Math.floor(u * loops) + 0.004 * Math.sin(a * 3.1);
      this.pushSample(this.pileC.x + Math.cos(a) * r * 1.25, floorY + lift, this.pileC.z + Math.sin(a) * r);
    }
    // drop from the pile up to the hand (a soft hanging curve)
    const from = this.s[this.sCount - 1];
    this.tailEnd.copy(from);
    const M = TAIL_SAMPLES - N;
    for (let i = 1; i <= M; i++) {
      const u = i / M;
      // quadratic Bézier with the control point low and toward the body
      const cx = (this.tailEnd.x + hand.x) * 0.5 + 0.05;
      const cy = floorY + 0.05;
      const cz = (this.tailEnd.z + hand.z) * 0.5;
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const c = u * u;
      if (i === M) break; // the hand itself is the first particle
      this.pushSample(a * this.tailEnd.x + b * cx + c * hand.x, a * this.tailEnd.y + b * cy + c * hand.y, a * this.tailEnd.z + b * cz + c * hand.z);
    }
  }

  private writeTube(): void {
    const n = this.sCount;
    if (n < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const S = this.s;
    // initial normal: perpendicular to the first tangent
    this.t.subVectors(S[1], S[0]).normalize();
    this.n.set(0, 1, 0);
    if (Math.abs(this.t.dot(this.n)) > 0.9) this.n.set(1, 0, 0);
    this.n.addScaledVector(this.t, -this.n.dot(this.t)).normalize();
    for (let i = 0; i < n; i++) {
      const a = S[Math.max(0, i - 1)];
      const c = S[Math.min(n - 1, i + 1)];
      this.tmp.subVectors(c, a);
      if (this.tmp.lengthSq() > 1e-12) this.t.copy(this.tmp).normalize();
      // parallel transport: remove the tangent component from the previous normal
      this.n.addScaledVector(this.t, -this.n.dot(this.t));
      if (this.n.lengthSq() < 1e-10) {
        this.n.set(0, 1, 0).addScaledVector(this.t, -this.t.y);
        if (this.n.lengthSq() < 1e-10) this.n.set(1, 0, 0);
      }
      this.n.normalize();
      this.b.crossVectors(this.t, this.n);
      const P = S[i];
      const v = this.sArc[i] / V_REPEAT;
      for (let r = 0; r <= RADIAL; r++) {
        const ang = (r / RADIAL) * Math.PI * 2;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const nx = this.n.x * cs + this.b.x * sn;
        const ny = this.n.y * cs + this.b.y * sn;
        const nz = this.n.z * cs + this.b.z * sn;
        const j = i * (RADIAL + 1) + r;
        this.posA[j * 3] = P.x + nx * RADIUS;
        this.posA[j * 3 + 1] = P.y + ny * RADIUS;
        this.posA[j * 3 + 2] = P.z + nz * RADIUS;
        this.nrmA[j * 3] = nx;
        this.nrmA[j * 3 + 1] = ny;
        this.nrmA[j * 3 + 2] = nz;
        this.uvA[j * 2] = r / RADIAL;
        this.uvA[j * 2 + 1] = v;
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * RADIAL * 6);
  }

  update(dt: number): void {
    if (!this.visible || !this.hasPath) return;
    if (this.structCount !== this.anchorCount) this.rebuild();
    const d = Math.min(Math.max(dt, 0), 1 / 20);
    // fresh chains settle quickly (a few extra steps the first frames)
    if (this.settle > 0) {
      for (let k = 0; k < 6; k++) this.simulate(1 / 60);
      this.settle = Math.max(0, this.settle - 1 / 60);
    }
    if (d > 0) this.simulate(d);
    this.buildSamples();
    this.writeTube();
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

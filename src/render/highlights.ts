// Hold highlights. One entry per highlighted hold; the strongest kind decides the ring style:
//   reachable — soft fresnel rim on the hold
//   candidate — crisp reticle ring (red → amber → green by grip quality) with a gentle pulse
//   hint      — pulsing glow + a small floating chevron
//   tutorial  — bright pulsing ring with a "ping" wave + a bouncing arrow
//   selected  — white dashed ring + inverted-hull outline (editor)
// Rings are wall-aligned decals with a pixel-constant line width (fwidth), so they stay crisp
// and readable at phone scale; arrows/chevrons are camera-facing sprites sized in screen px.
// set() can be called every frame: unchanged lists early-out without allocating.

import * as THREE from 'three';
import { PALETTE } from '../config/brand';
import type { HighlightKind, HoldHighlight } from '../core/contracts';
import type { WallFrame } from './wall-frame';
import type { HoldMount, HoldSet } from './holds';
import { makeCanvas } from './textures';

const KIND_BIT: Record<HighlightKind, number> = { reachable: 1, hint: 2, selected: 4, candidate: 8, tutorial: 16 };

const C_BAD = new THREE.Color(PALETTE.bad);
const C_WARN = new THREE.Color(PALETTE.warn);
const C_GOOD = new THREE.Color(PALETTE.good);
const C_WHITE = new THREE.Color(0xffffff);
const C_REACH = new THREE.Color('#FFE6C4');
const C_HINT = new THREE.Color(PALETTE.glacier);
const C_SIGNAL = new THREE.Color(PALETTE.signal);

export function qualityColor(q: number, out: THREE.Color): THREE.Color {
  const t = Math.max(0, Math.min(1, q));
  if (t < 0.5) return out.copy(C_BAD).lerp(C_WARN, t / 0.5);
  return out.copy(C_WARN).lerp(C_GOOD, (t - 0.5) / 0.5);
}

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uThick;   // line width in device px
uniform float uOpacity;
uniform float uStyle;   // 0 candidate, 1 tutorial, 2 hint, 3 selected
varying vec2 vUv;

float ringMask(float r, float R, float w, float aa) {
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + aa * 1.25, abs(r - R));
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float aa = max(fwidth(r), 1e-4);
  float R = 0.62;
  float w = uThick * aa;
  float a = 0.0;
  float ang = atan(p.y, p.x);

  if (uStyle < 0.5) {
    // candidate: crisp ring + diagonal reticle ticks + soft halo + faint fill
    a += ringMask(r, R, w, aa);
    float tickR = smoothstep(R + 0.07, R + 0.08, r) * (1.0 - smoothstep(R + 0.2, R + 0.21, r));
    float tickA = 1.0 - smoothstep(0.035, 0.06, abs(sin(2.0 * (ang - 0.7853982))) * r);
    a += tickR * tickA;
    a += exp(-pow(max(0.0, r - R) / 0.16, 2.0)) * 0.35 * step(R, r);
    a += (1.0 - smoothstep(R - 0.05, R, r)) * 0.08;
  } else if (uStyle < 1.5) {
    // tutorial: bright double ring + expanding ping
    a += ringMask(r, R, w * 1.2, aa);
    a += ringMask(r, R - 0.1, w * 0.5, aa) * 0.6;
    float ph = fract(uTime * 0.8);
    float pr = mix(R, 0.98, ph);
    a += ringMask(r, pr, w * (1.0 - ph) + aa, aa) * (1.0 - ph) * 0.9;
    a += exp(-pow(max(0.0, r - R) / 0.2, 2.0)) * 0.4 * step(R, r);
  } else if (uStyle < 2.5) {
    // hint: soft pulsing glow + dashed thin ring
    float pulse = 0.55 + 0.45 * sin(uTime * 4.0);
    a += exp(-pow(r / 0.75, 2.0)) * 0.42 * pulse;
    float dash = step(0.5, fract(ang / 6.2831853 * 18.0 + uTime * 0.3));
    a += ringMask(r, R + 0.04, w * 0.7, aa) * dash * 0.9;
  } else {
    // selected: rotating dashed white ring
    float dash = step(0.42, fract(ang / 6.2831853 * 24.0 - uTime * 0.25));
    a += ringMask(r, R, w, aa) * dash;
    a += ringMask(r, R + 0.12, w * 0.45, aa) * 0.5;
  }
  a *= uOpacity * (1.0 - smoothstep(0.96, 1.0, r));
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * (1.25 + a * 1.1), clamp(a, 0.0, 1.0));
}`;

interface RingSlot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

interface Active {
  holdId: string;
  kinds: number;
  quality: number;
  seen: boolean;
  ring: RingSlot | null;
  sprite: THREE.Sprite | null;
  spriteKind: 'arrow' | 'chevron' | null;
  outline: THREE.Mesh | null;
  pos: THREE.Vector3;
  radius: number;
  phase: number;
  /** Surface y of the highlighted thing (its panel frame orients the ring). */
  wallY: number;
  /** A hold bolted onto a volume: the ring sits on the volume face instead. */
  mount: HoldMount | null;
}

function arrowTexture(kind: 'arrow' | 'chevron'): THREE.CanvasTexture {
  const S = 128;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(64, 116);
    ctx.lineTo(108, 62);
    ctx.lineTo(80, 62);
    ctx.lineTo(80, 12);
    ctx.lineTo(48, 12);
    ctx.lineTo(48, 62);
    ctx.lineTo(20, 62);
    ctx.closePath();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = PALETTE.signal;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  } else {
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 13;
    for (const y of [30, 66]) {
      ctx.beginPath();
      ctx.moveTo(28, y);
      ctx.lineTo(64, y + 30);
      ctx.lineTo(100, y);
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Highlights {
  readonly group = new THREE.Group();
  private actives: Active[] = [];
  private pool: Active[] = [];
  private ringPool: RingSlot[] = [];
  private spritePool: { arrow: THREE.Sprite[]; chevron: THREE.Sprite[] } = { arrow: [], chevron: [] };
  private outlinePool: THREE.Mesh[] = [];
  private prev: { holdId: string; kind: HighlightKind; quality: number }[] = [];
  private time = 0;
  private ringGeo = new THREE.PlaneGeometry(1, 1);
  private arrowMat: THREE.SpriteMaterial;
  private chevronMat: THREE.SpriteMaterial;
  private outlineMat: THREE.ShaderMaterial;
  private tmpColor = new THREE.Color();
  private tmpV = new THREE.Vector3();
  private tmpN = new THREE.Vector3();

  /**
   * `resolveExtra` lets non-hold targets be highlighted with the same API (e.g. quickdraw ids
   * in rope mode): returns a wall-local centre + ring radius, or null.
   */
  constructor(
    private frame: WallFrame,
    private holds: HoldSet,
    private resolveExtra: (id: string) => { x: number; y: number; radius: number } | null = () => null,
  ) {
    this.group.name = 'highlights';
    this.arrowMat = new THREE.SpriteMaterial({ map: arrowTexture('arrow'), depthTest: false, depthWrite: false, transparent: true });
    this.chevronMat = new THREE.SpriteMaterial({ map: arrowTexture('chevron'), depthTest: false, depthWrite: false, transparent: true, color: C_HINT });
    this.outlineMat = new THREE.ShaderMaterial({
      uniforms: { uWidth: { value: 0.006 }, uColor: { value: new THREE.Color(0xffffff) }, uOpacity: { value: 0.95 } },
      vertexShader: /* glsl */ `
        uniform float uWidth;
        void main() {
          vec3 p = position + normalize(normal) * uWidth;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() { gl_FragColor = vec4(uColor, uOpacity); }`,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
  }

  /** Apply a highlight list (cheap when unchanged). */
  set(list: readonly HoldHighlight[]): void {
    // fast path: identical to last call (only candidate quality may differ)
    if (list.length === this.prev.length) {
      let same = true;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const b = this.prev[i];
        if (a.holdId !== b.holdId || a.kind !== b.kind) {
          same = false;
          break;
        }
      }
      if (same) {
        for (let i = 0; i < list.length; i++) {
          const q = list[i].quality ?? 0;
          if (q !== this.prev[i].quality) {
            this.prev[i].quality = q;
            const act = this.find(list[i].holdId);
            if (act && list[i].kind === 'candidate') act.quality = q;
          }
        }
        return;
      }
    }
    this.prev.length = 0;
    for (const h of list) this.prev.push({ holdId: h.holdId, kind: h.kind, quality: h.quality ?? 0 });

    for (const a of this.actives) {
      a.kinds = 0;
      a.seen = false;
    }
    for (const h of list) {
      if (!this.holds.holds.has(h.holdId) && !this.resolveExtra(h.holdId)) continue;
      let a = this.find(h.holdId);
      if (!a) {
        a = this.pool.pop() ?? this.newActive();
        a.holdId = h.holdId;
        a.kinds = 0;
        a.quality = 0;
        a.phase = Math.random() * 6.28;
        this.place(a);
        this.actives.push(a);
      }
      a.seen = true;
      a.kinds |= KIND_BIT[h.kind];
      if (h.kind === 'candidate') a.quality = h.quality ?? 0;
    }
    for (let i = this.actives.length - 1; i >= 0; i--) {
      const a = this.actives[i];
      if (!a.seen || a.kinds === 0) {
        this.release(a);
        this.actives.splice(i, 1);
        this.pool.push(a);
      } else {
        this.assign(a);
      }
    }
  }

  clear(): void {
    this.set([]);
  }

  /** Hold set was rebuilt: re-place everything. */
  refresh(): void {
    const list = this.prev.slice() as HoldHighlight[];
    this.prev.length = 0;
    for (const a of this.actives) {
      this.release(a);
      this.pool.push(a);
    }
    this.actives.length = 0;
    this.set(list);
  }

  private find(id: string): Active | undefined {
    for (const a of this.actives) if (a.holdId === id) return a;
    return undefined;
  }

  private newActive(): Active {
    return { holdId: '', kinds: 0, quality: 0, seen: false, ring: null, sprite: null, spriteKind: null, outline: null, pos: new THREE.Vector3(), radius: 0.1, phase: 0, wallY: 0, mount: null };
  }

  private place(a: Active): void {
    const h = this.holds.holds.get(a.holdId);
    const g = this.holds.geoms.get(a.holdId);
    if (!h) {
      const e = this.resolveExtra(a.holdId);
      if (e) {
        this.frame.toWorldXYZ(e.x, e.y, 0.03, a.pos);
        a.radius = e.radius;
        a.wallY = e.y;
        a.mount = null;
      }
      return;
    }
    a.wallY = h.y;
    a.mount = this.holds.mounts.get(a.holdId) ?? null;
    if (a.mount) a.pos.copy(a.mount.pos).addScaledVector(this.tmpN.set(0, 0, 1).applyQuaternion(a.mount.quat), 0.006);
    else this.frame.toWorldXYZ(h.x, h.y, 0, a.pos).addScaledVector(this.frame.normalAt(h.y, this.tmpN, false), 0.006);
    a.radius = g ? Math.max(g.halfX, g.halfY) * (h.type === 'volume' ? 0.85 : 1.12) + 0.035 : h.size + 0.04;
  }

  private assign(a: Active): void {
    const k = a.kinds;
    const style = k & 16 ? 1 : k & 8 ? 0 : k & 4 ? 3 : k & 2 ? 2 : -1;
    if (style >= 0) {
      if (!a.ring) {
        a.ring = this.ringPool.pop() ?? this.newRing();
        this.group.add(a.ring.mesh);
      }
      a.ring.mat.uniforms.uStyle.value = style;
      a.ring.mesh.position.copy(a.pos);
      if (a.mount) a.ring.mesh.quaternion.copy(a.mount.quat);
      else this.frame.quaternionAt(a.wallY, a.ring.mesh.quaternion);
    } else if (a.ring) {
      this.group.remove(a.ring.mesh);
      this.ringPool.push(a.ring);
      a.ring = null;
    }
    const want: 'arrow' | 'chevron' | null = k & 16 ? 'arrow' : k & 2 ? 'chevron' : null;
    if (a.spriteKind !== want) {
      if (a.sprite && a.spriteKind) {
        this.group.remove(a.sprite);
        this.spritePool[a.spriteKind].push(a.sprite);
      }
      a.sprite = null;
      a.spriteKind = want;
      if (want) {
        a.sprite = this.spritePool[want].pop() ?? this.newSprite(want);
        this.group.add(a.sprite);
      }
    }
    const wantOutline = (k & 4) !== 0;
    const mesh = this.holds.meshes.get(a.holdId);
    if (wantOutline && mesh && !a.outline) {
      a.outline = this.outlinePool.pop() ?? new THREE.Mesh(mesh.geometry, this.outlineMat);
      a.outline.geometry = mesh.geometry;
      a.outline.renderOrder = 3;
      mesh.add(a.outline);
    } else if (!wantOutline && a.outline) {
      a.outline.removeFromParent();
      this.outlinePool.push(a.outline);
      a.outline = null;
    }
  }

  private release(a: Active): void {
    if (a.ring) {
      this.group.remove(a.ring.mesh);
      this.ringPool.push(a.ring);
      a.ring = null;
    }
    if (a.sprite && a.spriteKind) {
      this.group.remove(a.sprite);
      this.spritePool[a.spriteKind].push(a.sprite);
    }
    a.sprite = null;
    a.spriteKind = null;
    if (a.outline) {
      a.outline.removeFromParent();
      this.outlinePool.push(a.outline);
      a.outline = null;
    }
    this.holds.setRim(a.holdId, C_WHITE, 0);
  }

  private newRing(): RingSlot {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
        uTime: { value: 0 },
        uThick: { value: 3 },
        uOpacity: { value: 1 },
        uStyle: { value: 0 },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    return { mesh, mat };
  }

  private newSprite(kind: 'arrow' | 'chevron'): THREE.Sprite {
    const s = new THREE.Sprite(kind === 'arrow' ? this.arrowMat : this.chevronMat);
    s.renderOrder = 20;
    s.center.set(0.5, 0);
    return s;
  }

  /**
   * Animate. `viewportCssH` (CSS px) sizes rings/sprites in screen space; `dpr` converts CSS px
   * line widths to device px.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, viewportCssH: number, dpr: number): void {
    this.time += dt;
    const t = this.time;
    for (const a of this.actives) {
      const k = a.kinds;
      // CSS px per meter at the hold
      const dist = Math.max(0.1, camera.position.distanceTo(a.pos));
      const ppm = viewportCssH / 2 / (dist * Math.tan((camera.fov * Math.PI) / 360));
      const minR = 15 / ppm;
      const R = Math.max(a.radius, minR);

      // rim on the hold itself
      let rimC = C_WHITE;
      let rimS = 0;
      let rimP = 2.2;
      if (k & 16) {
        rimC = C_WHITE;
        rimS = 0.55 + 0.35 * Math.sin(t * 5 + a.phase);
      } else if (k & 8) {
        rimC = qualityColor(a.quality, this.tmpColor);
        rimS = 0.85;
        rimP = 1.8;
      } else if (k & 4) {
        rimS = 0.32;
      } else if (k & 2) {
        rimC = C_HINT;
        rimS = 0.32 + 0.28 * Math.sin(t * 4 + a.phase);
      } else if (k & 1) {
        rimC = C_REACH;
        rimS = 0.3;
        rimP = 2.8;
      }
      this.holds.setRim(a.holdId, rimC, rimS, rimP);

      if (a.ring) {
        const u = a.ring.mat.uniforms;
        const style = u.uStyle.value as number;
        u.uTime.value = t + a.phase;
        let scale = R / 0.62;
        if (style === 0) {
          qualityColor(a.quality, u.uColor.value as THREE.Color);
          scale *= 1 + 0.05 * Math.sin(t * 6.5);
          u.uThick.value = 3.4 * dpr;
          u.uOpacity.value = 1;
        } else if (style === 1) {
          (u.uColor.value as THREE.Color).copy(C_WHITE).lerp(C_SIGNAL, 0.25 + 0.25 * Math.sin(t * 3));
          scale *= 1 + 0.07 * Math.sin(t * 4);
          u.uThick.value = 3.6 * dpr;
          u.uOpacity.value = 1;
        } else if (style === 2) {
          (u.uColor.value as THREE.Color).copy(C_HINT);
          u.uThick.value = 2.2 * dpr;
          u.uOpacity.value = 0.95;
        } else {
          (u.uColor.value as THREE.Color).copy(C_WHITE);
          u.uThick.value = 2.4 * dpr;
          u.uOpacity.value = 1;
        }
        a.ring.mesh.scale.set(scale * 2, scale * 2, 1);
      }

      if (a.sprite) {
        const arrow = a.spriteKind === 'arrow';
        const px = arrow ? 40 : 24;
        const s = px / ppm;
        const bounce = arrow ? Math.abs(Math.sin(t * 3.4 + a.phase)) * 14 : (0.5 + 0.5 * Math.sin(t * 4 + a.phase)) * 6;
        const lift = R + (bounce + 6) / ppm;
        // above the hold along the wall, off the panel it is bolted to (lifts straight down under a roof)
        this.frame.upAt(a.wallY, this.tmpV, false).multiplyScalar(lift).add(a.pos).addScaledVector(this.frame.normalAt(a.wallY, this.tmpN, false), 0.08);
        a.sprite.position.copy(this.tmpV);
        a.sprite.scale.set(s, s, 1);
        a.sprite.material.opacity = arrow ? 1 : 0.65 + 0.35 * Math.sin(t * 4 + a.phase);
      }
      if (a.outline) {
        this.outlineMat.uniforms.uWidth.value = Math.max(0.004, 2.2 / ppm);
      }
    }
  }

  dispose(): void {
    this.clear();
    for (const r of this.ringPool) r.mat.dispose();
    this.ringGeo.dispose();
    this.arrowMat.map?.dispose();
    this.arrowMat.dispose();
    this.chevronMat.map?.dispose();
    this.chevronMat.dispose();
    this.outlineMat.dispose();
  }
}

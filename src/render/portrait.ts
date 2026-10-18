// CHARACTER: offscreen collectible-card portrait of an animal head (PNG data URL, transparent
// background), cached per (head, size).
//
// Every head is shot the same way: on the climber's own body (basalt tee, so the card shows a
// little shoulder instead of a bare neck tube), from the same 3/4 view, framed from the shoulder
// line to the top of the silhouette (horns, ears, crest) and centred on the head — so all nine
// cards share one scale feel. Studio rig: warm key, cool fill, two coloured rim lights (signal +
// glacier) that separate the silhouette from a dark card, plus a small room environment for glossy
// eyes and horns. HDR (half float, MSAA) → ACES + sRGB in a resolve pass → straight alpha → 2×
// supersampled.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { HeadId } from '../core/types';
import { ClimberModel, createBodyGoal, type BodyGoal } from './climber';

const cache = new Map<string, string>();
let envTex: THREE.Texture | null = null;
let envOwner: THREE.WebGLRenderer | null = null;

/** Per-head framing tweaks: view yaw (rad, face toward the card's right), zoom (> 1 = closer). */
const FRAMING: Partial<Record<HeadId, { yaw?: number; zoom?: number }>> = {};
/** Shared view: 3/4 from the front-right, a touch above eye level. */
const VIEW_YAW = 0.62;
const VIEW_PITCH = 0.1;
/** Card layout (fractions of the card): the shoulder line sits this far up, the silhouette top this far down. */
const SHOULDER_ROW = 0.075;
const HEADROOM = 0.07;

/** One shared bust (body + head) per renderer: the body is built once, heads swap in. */
let bust: { model: ClimberModel; goal: BodyGoal; owner: THREE.WebGLRenderer } | null = null;

function bustFor(renderer: THREE.WebGLRenderer, head: HeadId): { model: ClimberModel; goal: BodyGoal } {
  if (!bust || bust.owner !== renderer) {
    bust?.model.dispose();
    bust = { model: new ClimberModel({ head, colorway: 'basalt', chalk: 'classic' }), goal: createBodyGoal(), owner: renderer };
  } else bust.model.setSkin(head, 'basalt', 'classic');
  return bust;
}

const RESOLVE_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const RESOLVE_FS = /* glsl */ `
uniform sampler2D tSrc;
uniform float uExposure;
varying vec2 vUv;
vec3 aces(vec3 color) {
  // ACES fitted (Stephen Hill), matching three's ACESFilmicToneMapping
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = a / b;
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec4 s = texture2D(tSrc, vUv);
  float a = clamp(s.a, 0.0, 1.0);
  vec3 c = a > 1e-4 ? s.rgb / a : vec3(0.0);
  gl_FragColor = vec4(toSRGB(aces(c)), a);
}`;

/** The studio environment is GPU-generated: drop it after a WebGL context loss so it is rebuilt. */
export function resetPortraitEnvironment(): void {
  envTex = null;
  envOwner = null;
}

function environment(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (envTex && envOwner === renderer) return envTex;
  const pm = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  envTex = pm.fromScene(room, 0.03).texture;
  envOwner = renderer;
  room.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  });
  pm.dispose();
  return envTex;
}

export function renderPortrait(renderer: THREE.WebGLRenderer, head: HeadId, size = 256): string {
  const key = `${head}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = Math.min(2048, Math.round(size * 2));

  // ── scene ──
  const scene = new THREE.Scene();
  scene.environment = environment(renderer);
  scene.environmentIntensity = 0.42;
  const key1 = new THREE.DirectionalLight('#ffe6cc', 3.0);
  key1.position.set(1.6, 2.2, 2.4);
  const fill = new THREE.DirectionalLight('#a8c8dc', 0.55);
  fill.position.set(-2.2, 0.4, 1.4);
  const rimA = new THREE.DirectionalLight('#ff8a5c', 3.4);
  rimA.position.set(-1.8, 1.2, -1.6);
  const rimB = new THREE.DirectionalLight('#b8e6f0', 3.0);
  rimB.position.set(1.9, 0.9, -1.7);
  const top = new THREE.DirectionalLight('#ffffff', 0.8);
  top.position.set(0, 3, 0.2);
  scene.add(key1, fill, rimA, rimB, top, new THREE.HemisphereLight('#d7dde4', '#2a2420', 0.22));

  const f = FRAMING[head] ?? {};
  const { model, goal } = bustFor(renderer, head);
  const yaw = f.yaw ?? VIEW_YAW;
  // the body faces −Z: view from (sin yaw, ·, −cos yaw) so the face turns toward the card's right
  const viewDir = new THREE.Vector3(Math.sin(yaw), Math.sin(VIEW_PITCH), -Math.cos(yaw)).normalize();
  // the studio lights were authored for a camera on +Z: turn them with the view
  const lightRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - yaw);
  for (const l of [key1, fill, rimA, rimB, top]) l.position.applyQuaternion(lightRot);
  model.rig.restGoal(goal);
  // relaxed shoulders, head turned a little toward the viewer
  for (let s = 0; s < 2; s++) goal.hands[s].target.x *= 0.72;
  goal.look.set(0, 1.62, -3).addScaledVector(viewDir, 1.2);
  model.rig.solve(goal, 0);
  scene.add(model);
  model.updateMatrixWorld(true);

  // ── framing: the head silhouette (projected) from the shoulder line up ──
  const headObj = model.rig.bones[3].children.find((c) => (c as THREE.Group).isGroup) ?? model;
  const neck = new THREE.Vector3();
  headObj.getWorldPosition(neck);
  const cam = new THREE.PerspectiveCamera(24, 1, 0.01, 20);
  const aim = neck.clone().add(new THREE.Vector3(0, 0.12, 0));
  cam.position.copy(aim).addScaledVector(viewDir, 2.4);
  cam.lookAt(aim);
  cam.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  headObj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y < neck.y + 0.06) continue; // the neck below the jaw belongs to the shoulders' row
      v.applyMatrix4(cam.matrixWorldInverse);
      const px = v.x / -v.z;
      const py = v.y / -v.z;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  });
  // shoulder line: the top of the trapezius, just below the neck joint (collar + shoulder caps show)
  v.copy(neck).add(new THREE.Vector3(0, -0.035, 0)).applyMatrix4(cam.matrixWorldInverse);
  const shoulderY = v.y / -v.z;
  // vertical: shoulder row → silhouette top with headroom; horizontal: the head fits with margin
  const spanY = (maxY - shoulderY) / (1 - SHOULDER_ROW - HEADROOM);
  const spanX = (maxX - minX) / 0.86;
  const half = Math.max(spanY, spanX) / 2 / (f.zoom ?? 1);
  const cx = (minX + maxX) / 2;
  const cy = maxY + HEADROOM * 2 * half - half;
  cam.fov = (2 * Math.atan(half) * 180) / Math.PI;
  cam.updateProjectionMatrix();
  cam.setViewOffset(S, S, ((cx / half) * S) / 2, ((-cy / half) * S) / 2, S, S);

  // ── render (HDR, MSAA) → resolve (ACES, sRGB, straight alpha) ──
  const hdr = new THREE.WebGLRenderTarget(S, S, { type: THREE.HalfFloatType, samples: 4 });
  const ldr = new THREE.WebGLRenderTarget(S, S, { type: THREE.UnsignedByteType });
  const quadMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: hdr.texture }, uExposure: { value: 0.88 } },
    vertexShader: RESOLVE_VS,
    fragmentShader: RESOLVE_FS,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    blending: THREE.NoBlending,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;
  renderer.autoClear = true;
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(hdr);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(ldr);
  renderer.clear();
  renderer.render(quadScene, quadCam);
  const buf = new Uint8Array(S * S * 4);
  renderer.readRenderTargetPixels(ldr, 0, 0, S, S, buf);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.enabled = prevShadow;

  // ── 2D: flip, downscale with high-quality smoothing ──
  const big = document.createElement('canvas');
  big.width = big.height = S;
  const bctx = big.getContext('2d') as CanvasRenderingContext2D;
  const img = bctx.createImageData(S, S);
  for (let y = 0; y < S; y++) img.data.set(buf.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
  bctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const octx = out.getContext('2d') as CanvasRenderingContext2D;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(big, 0, 0, size, size);
  const url = out.toDataURL('image/png');

  hdr.dispose();
  ldr.dispose();
  quad.geometry.dispose();
  quadMat.dispose();
  scene.remove(model);
  cache.set(key, url);
  return url;
}

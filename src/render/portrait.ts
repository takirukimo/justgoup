// CHARACTER: offscreen collectible-card portrait of an animal head (PNG data URL, transparent
// background), cached per (head, size).
//
// Studio rig: warm key from the upper left, cool fill, two coloured rim lights (signal + glacier)
// that separate the silhouette from a dark card, plus a small room environment for glossy eyes
// and horns. The head is framed from a 3/4 view by fitting its projected vertices. Rendering is
// HDR (half float, MSAA) → ACES + sRGB in a resolve pass → straight alpha → 2× supersampled.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { HeadId } from '../core/types';
import { createHead, disposeHead } from './heads/index';

const cache = new Map<string, string>();
let envTex: THREE.Texture | null = null;
let envOwner: THREE.WebGLRenderer | null = null;

/** Per-head framing tweaks (yaw toward the viewer's left, extra zoom). */
const FRAMING: Partial<Record<HeadId, { yaw?: number; zoom?: number; pitch?: number }>> = {
  ibex: { yaw: 0.5, zoom: 1.0 },
  chamois: { yaw: 0.45 },
  goat: { yaw: 0.45 },
  ram: { yaw: 0.5, zoom: 1.0 },
  eagle: { yaw: 0.6 },
  vulture: { yaw: 0.6 },
  marmot: { yaw: 0.4, zoom: 0.96 },
  snowleopard: { yaw: 0.38 },
  lynx: { yaw: 0.38 },
};
/** Vertices below this height (head-local, m) belong to the neck: they may leave the card. */
const NECK_CUT = 0.085;

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

  const g = createHead(head);
  const f = FRAMING[head] ?? {};
  g.rotation.set(f.pitch ?? 0.06, f.yaw ?? 0.58, 0);
  scene.add(g);
  g.updateMatrixWorld(true);

  // ── framing: fit projected vertices ──
  const cam = new THREE.PerspectiveCamera(24, 1, 0.01, 20);
  const center = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3());
  cam.position.set(center.x, center.y + 0.04, center.z + 2.2);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y < NECK_CUT) continue;
      v.applyMatrix4(cam.matrixWorldInverse);
      const px = v.x / -v.z;
      const py = v.y / -v.z;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  });
  // re-centre and zoom so the silhouette fills ~88% of the card; the neck runs off the bottom
  const cx = (minX + maxX) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 / 0.82 / (f.zoom ?? 1);
  // anchor to the top with a little headroom so the neck exits the bottom edge
  const cy = maxY - half * 0.94;
  cam.fov = (2 * Math.atan(half) * 180) / Math.PI;
  cam.updateProjectionMatrix();
  // shift the view so the silhouette centre lands in the middle (slightly low, card-style headroom)
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
  disposeHead(g);
  cache.set(key, url);
  return url;
}

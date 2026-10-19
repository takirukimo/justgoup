// Post-processing: RenderPass (multisampled HDR target) → UnrealBloomPass (subtle, high
// threshold so only lights, signage and highlights bloom) → OutputPass (tone mapping + sRGB) →
// final grade pass (vignette, animated film grain, very subtle chromatic aberration, gentle
// split-tone). 'low' quality bypasses the composer entirely (plain tone-mapped render).

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { QualityPreset } from './quality';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uGrain: { value: 0.035 },
    uVignette: { value: 0.42 },
    uCA: { value: 0.0 },
    uDesat: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uRes;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uCA;
    uniform float uDesat;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);
      vec3 col;
      if (uCA > 0.0) {
        // confined to the corners (r2²): thin holds near the bottom / side edges keep clean
        // silhouettes instead of red / cyan fringes
        vec2 off = d * r2 * r2 * uCA;
        col.r = texture2D(tDiffuse, uv + off).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - off).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // Pure mode strain: the world drains of colour a little at the crux (≤ 25 %)
      col = mix(col, vec3(luma), uDesat);
      // gentle split-tone: cool shadows, warm highlights
      col += vec3(-0.006, 0.0, 0.010) * (1.0 - smoothstep(0.0, 0.35, luma));
      col *= mix(vec3(1.0), vec3(1.025, 1.0, 0.97), smoothstep(0.45, 1.0, luma));
      // vignette (slightly oval for portrait)
      vec2 dv = d * vec2(1.0, uRes.y / max(uRes.x, 1.0) * 0.62);
      float vig = smoothstep(0.95, 0.2, length(dv));
      col *= mix(1.0 - uVignette, 1.0, vig);
      // film grain, strongest in the mid-tones
      float g = hash(floor(uv * uRes) + fract(uTime * 7.31) * 517.0) - 0.5;
      col += g * uGrain * (0.35 + 0.65 * (1.0 - abs(luma * 2.0 - 1.0)));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export class PostFX {
  enabled = true;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private final: ShaderPass;
  private rtPlain: THREE.WebGLRenderTarget;
  private rtMsaa: THREE.WebGLRenderTarget;
  private bloomScale = 1;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private time = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: true } as const;
    this.rtPlain = new THREE.WebGLRenderTarget(2, 2, opts);
    this.rtPlain.texture.name = 'post.plain';
    this.rtMsaa = new THREE.WebGLRenderTarget(2, 2, { ...opts, samples: 4 });
    this.rtMsaa.texture.name = 'post.scene';
    this.composer = new EffectComposer(renderer, this.rtPlain);
    // the scene renders into the multisampled target; later passes ping-pong with the plain one
    this.composer.renderTarget2.dispose();
    this.composer.renderTarget2 = this.rtMsaa;
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.36, 0.5, 1.6);
    this.output = new OutputPass();
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.final);
  }

  apply(p: QualityPreset): void {
    this.enabled = p.post;
    this.bloomScale = p.bloomScale;
    this.bloom.enabled = p.bloomScale > 0;
    const samples = p.msaa;
    if (this.rtMsaa.samples !== samples) {
      this.rtMsaa.samples = samples;
      this.rtMsaa.dispose();
    }
    this.final.uniforms.uGrain.value = p.grain ? 0.032 : 0;
    this.final.uniforms.uCA.value = p.chromatic ? 0.016 : 0;
    this.setSize(this.w, this.h, this.dpr);
  }

  /** Bloom look tuning (strength, radius, threshold). */
  setBloom(strength: number, radius: number, threshold: number): void {
    this.bloom.strength = strength;
    this.bloom.radius = radius;
    this.bloom.threshold = threshold;
  }

  /** Strain desaturation (Pure mode, research §4.2): 0..0.25. */
  setDesaturation(v: number): void {
    this.final.uniforms.uDesat.value = Math.max(0, Math.min(0.25, v));
  }

  setVignette(v: number): void {
    this.final.uniforms.uVignette.value = v;
  }

  setSize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.dpr = dpr;
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(cssW, cssH);
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (this.bloomScale > 0 && this.bloomScale < 1) this.bloom.setSize(Math.round(W * this.bloomScale), Math.round(H * this.bloomScale));
    (this.final.uniforms.uRes.value as THREE.Vector2).set(W, H);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.time += dt;
    this.final.uniforms.uTime.value = this.time;
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.composer.readBuffer = this.rtMsaa;
    this.composer.writeBuffer = this.rtPlain;
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.final.dispose();
    this.renderPass.dispose();
  }
}

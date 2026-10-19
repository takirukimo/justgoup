// GameRenderer — the WORLD module's implementation of RendererAPI.
//
// Owns the WebGLRenderer, the scene (CHIRAL HQ gym, main wall, holds, quickdraws), the light
// rig (shadow-casting key spot that follows the climber + wash/fill/rim), the camera rig, fx,
// highlights, contact shadows and post-processing. The app owns requestAnimationFrame and calls
// frame(dt). Character pieces (climber, guide, rope, portraits) are used only through the
// CHARACTER contract (src/core/contracts.ts).

import * as THREE from 'three';
import type { CameraMode, GuideState, HoldHighlight, RendererAPI, ScreenPoint } from '../core/contracts';
import type { BoulderDef, ChalkId, ClimberState, ColorwayId, HeadId, HoldDef, LimbSnapshot, QualityLevel, Vec2 } from '../core/types';
import { PALETTE } from '../config/brand';
import { CHALKS } from '../config/skins';
import { GAME } from '../config/tuning';
import { clamp, smoothstep } from '../core/math';
import { WallFrame } from './wall-frame';
import { WallView } from './wall';
import { GymEnvironment } from './environment';
import { Highlights } from './highlights';
import { CameraRig, type CameraContext } from './camera';
import { FxSystem } from './fx';
import { PostFX } from './post';
import { ContactShadows } from './contact-shadows';
import { QUALITY_PRESETS, QualityGovernor, detectQuality, type QualityPreset } from './quality';
import { ClimberModel } from './climber';
import { GuideModel } from './guide';
import { RopeMesh } from './rope-mesh';
import { renderPortrait, resetPortraitEnvironment } from './portrait';
import { disposeHoldCache } from './holds';

/** Optional fx beyond RendererAPI['fx'] (the app calls them when present). */
export interface GameRendererFx {
  /** A hand dipping into the chalk bag (p = the chalking hand / bag, wall-local). */
  chalkDip(p: Vec2, intensity?: number): void;
  /** The chalk slap of a hand catching a hold after a dyno (+ a weighted camera sag). */
  catchBurst(p: Vec2, intensity?: number): void;
  /** Fingers skidding off a missed throw's target hold (the renderer also detects misses itself). */
  missScuff(p: Vec2, intensity?: number): void;
}

export interface RendererOptions {
  /** Initial quality (default: detectQuality()). */
  quality?: QualityLevel;
  /** Tone mapping operator (default 'aces'). */
  toneMapping?: 'aces' | 'agx';
}

const OFF_WALL_MARGIN = 0.6;
/** Tower flood intensity (cd): ~11 m from the upper tower, about the key's level on the lower wall. */
const TOWER_FLOOD = 500;

/** An empty showcase wall shown until the app loads a problem. */
function showcaseBoulder(): BoulderDef {
  return {
    id: 'showcase',
    name: 'CHIRAL HQ',
    grade: 0,
    mode: 'boulder',
    wallAngle: 15,
    width: GAME.boulderWall.width,
    height: GAME.boulderWall.height,
    holds: [],
    color: PALETTE.signal,
    seed: 1,
  };
}

export class GameRenderer implements RendererAPI {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Wall-local ↔ world mapping for the current problem (read-only for other modules). */
  readonly wallFrame = new WallFrame(0);

  private rig: CameraRig;
  private env!: GymEnvironment;
  private wall: WallView;
  private highlights: Highlights;
  private fxSys: FxSystem;
  private contact: ContactShadows;
  private post!: PostFX;
  private climber: ClimberModel | null = null;
  private guide: GuideModel | null = null;
  private guideState: GuideState | null = null;
  private rope: RopeMesh | null = null;

  private hemi = new THREE.HemisphereLight('#c8d2dc', '#2b2622', 0.16);
  private key = new THREE.SpotLight('#ffd3a6', 128, 0, 0.46, 0.72, 2);
  private keyTarget = new THREE.Object3D();
  private wash = new THREE.DirectionalLight('#ffe2c2', 0.4);
  private fill = new THREE.DirectionalLight('#9cc3d6', 0.24);
  private rim = new THREE.DirectionalLight('#d4e8ff', 1.3);
  private keyPos = new THREE.Vector3(1.5, 5.5, 5);
  private keyAim = new THREE.Vector3(0, 1.8, 0);
  private keyReach = 1;
  /**
   * Folded walls: roofs and caves face the floor, so the rig's top-down key barely reaches them.
   * A floodlight low in front aims up into the steep section (like the cave floods in a real gym)
   * and a soft warm bounce lights every down-facing surface from below. Both always exist (a fixed
   * light count keeps every shader program stable) and sit at intensity 0 on flat walls.
   */
  private caveFlood = new THREE.SpotLight('#ffe0bd', 0, 0, 0.62, 0.85, 2);
  private caveTarget = new THREE.Object3D();
  private bounce = new THREE.DirectionalLight('#d9c8b4', 0);
  private roofness = 0;
  /**
   * Lead towers: the same flood becomes the tower flood — mounted far out in front at mezzanine
   * height (like the floods across a real lead hall) and aimed up at the upper tower, where the
   * rig's top-down key fades out and overhanging headwalls face away from every ceiling light.
   * It lights the headwall from in front and below, so holds up there keep their modelling.
   */
  private tower = false;
  private caveAim = new THREE.Vector3(0, 2, 1);
  private caveHome = new THREE.Vector3(0, 2, 1);

  private preset: QualityPreset;
  private autoQuality = false;
  private governor: QualityGovernor;
  private boulder: BoulderDef | null = null;
  private state: ClimberState | null = null;
  private rest: ClimberState | null = null;
  private climberVisible = true;
  private ropePath: Vec2[] | null = null;
  private clipped: string[] = [];
  private ropeWorld: THREE.Vector3[] = [];
  private pulls = new Map<string, Vec2>();
  private skin: { head: HeadId; colorway: ColorwayId; chalk: ChalkId } = { head: 'ibex', colorway: 'basalt', chalk: 'classic' };
  private focusHint: Vec2 | null = null;
  /** Smoothed cost of ClimberModel.pose() (ms) for QA. */
  private poseMs = 0;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private time = 0;
  private initialized = false;
  private disposed = false;
  private resizeObs: ResizeObserver | null = null;
  private onWinResize = () => this.resize();
  private lost = false;
  private readonly contextListeners = new Set<(lost: boolean) => void>();
  // three.js' own listeners (registered first) preventDefault the loss and re-init its state on
  // restore; these run after them and rebuild what only lived on the GPU.
  private onContextLost = (): void => {
    this.lost = true;
    for (const fn of this.contextListeners) fn(true);
  };
  private onContextRestored = (): void => {
    this.lost = false;
    resetPortraitEnvironment();
    this.env?.restoreContext();
    this.cssW = this.cssH = 0; // force resize() to re-apply the drawing-buffer size
    this.resize();
    for (const fn of this.contextListeners) fn(false);
  };

  // scratch
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private ndc = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane();
  private ndc2 = new THREE.Vector2();

  readonly fx: RendererAPI['fx'] & GameRendererFx;
  /** Flight being watched for a miss (dyno / deadpoint limbs + target hold), and the last miss puff time. */
  private watchFlight: { limbs: LimbSnapshot['id'][]; holdId: string } | null = null;
  private lastMissAt = -10;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = opts.toneMapping === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = opts.toneMapping === 'agx' ? 1.2 : 0.95;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.info.autoReset = false; // the composer renders several passes per frame
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    const level = opts.quality ?? detectQuality(this.gl);
    this.preset = QUALITY_PRESETS[level];
    this.governor = new QualityGovernor(level === 'low' ? 'medium' : level);

    this.rig = new CameraRig(390 / 844);
    this.contact = new ContactShadows(this.wallFrame);
    this.wall = new WallView(this.wallFrame, this.contact.uniforms);
    this.highlights = new Highlights(this.wallFrame, this.wall.holds, (id) => {
      const q = this.boulder?.quickdraws?.find((d) => d.id === id);
      return q ? { ...this.wall.quickdraws.basketLocal(q), radius: 0.085 } : null;
    });
    this.fxSys = new FxSystem(this.wallFrame, QUALITY_PRESETS.high.particles);

    this.scene.add(this.wall.group, this.highlights.group, this.fxSys.points, this.contact.mesh);
    this.setupLights();

    const fx: RendererAPI['fx'] & GameRendererFx = {
      chalkPuff: (p, intensity) => this.fxSys.chalkPuff(p, intensity ?? 1),
      dust: (p, intensity) => this.fxSys.dust(p, intensity ?? 1),
      confetti: (p) => this.fxSys.confetti(p),
      cameraShake: (amount) => this.rig.addShake(clamp(amount, 0, 1)),
      chalkDip: (p, intensity) => this.chalkDip(p, intensity ?? 0.7),
      catchBurst: (p, intensity) => {
        const k = intensity ?? 1;
        this.fxSys.catchBurst(p, k);
        // the arms take the body's weight: the view sags and springs back
        this.rig.addSag(0.35 + 0.45 * clamp(k, 0, 1.5));
      },
      missScuff: (p, intensity) => {
        this.lastMissAt = this.time;
        this.fxSys.missScuff(p, intensity ?? 1);
      },
    };
    this.fx = fx;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;
    // Spec labels use the mono UI font when it's available; never block for long.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) {
      try {
        await Promise.race([
          Promise.all([fonts.load("500 20px 'JetBrains Mono'"), fonts.ready]),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } catch {
        /* offline: fall back to system mono */
      }
    }
    this.env = new GymEnvironment(this.gl, this.scene);
    this.post = new PostFX(this.gl, this.scene, this.rig.camera);
    this.climber = new ClimberModel({ head: this.skin.head, colorway: this.skin.colorway, chalk: this.skin.chalk });
    // CHARACTER integration: hand shapes + contact depth come from the hold set
    this.climber.setHoldLookup((id, out) => {
      const h = this.wall.holds.holds.get(id);
      if (!h) return false;
      out.type = h.type;
      out.angle = h.angle;
      out.size = h.size;
      // a hold bolted onto a volume stands off the wall by the volume's face height there
      out.depth = (this.wall.holds.geoms.get(id)?.depth ?? h.size * 0.5) + (this.wall.holds.mounts.get(id)?.lift ?? 0);
      return true;
    });
    this.scene.add(this.climber);
    this.rope = new RopeMesh();
    this.scene.add(this.rope);
    this.applyQuality();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(this.canvas);
    }
    window.addEventListener('resize', this.onWinResize);
    this.initialized = true;
    if (this.boulder) {
      // loadBoulder() was called before init(): finish what needed the environment/climber
      this.env.configure(this.layoutFor(this.boulder), this.preset);
      this.climber.setHarness(this.boulder.mode === 'rope');
      if (this.rest) this.climber.pose(this.rest, this.wallFrame, 0);
      this.prewarm();
    }
  }

  /** Compile every material variant up front so the first highlight / puff doesn't hitch. */
  private prewarm(): void {
    const ids = [...this.wall.holds.meshes.keys()];
    if (ids.length) {
      this.highlights.set([
        { holdId: ids[0], kind: 'candidate', quality: 0.8 },
        { holdId: ids[Math.min(1, ids.length - 1)], kind: 'tutorial' },
      ]);
    }
    this.contact.mesh.visible = true;
    this.fxSys.chalkPuff({ x: 0, y: -50 }, 0.2);
    this.rig.update(0.016, this.cameraContext());
    try {
      this.gl.compile(this.scene, this.rig.camera);
    } catch {
      /* compile is an optimisation only */
    }
    this.highlights.clear();
  }

  setQuality(q: QualityLevel): void {
    this.autoQuality = false;
    this.setQualityInternal(q);
  }

  /** Optional: let the renderer step quality down/up from measured frame times. */
  setAutoQuality(on: boolean): void {
    this.autoQuality = on;
  }

  getQuality(): QualityLevel {
    return this.preset.level;
  }

  private setQualityInternal(q: QualityLevel): void {
    if (this.preset.level === q) return;
    this.preset = QUALITY_PRESETS[q];
    this.applyQuality();
    this.resize();
  }

  private applyQuality(): void {
    const p = this.preset;
    const shadows = p.shadowMapSize > 0;
    this.gl.shadowMap.enabled = shadows;
    this.key.castShadow = shadows;
    if (shadows && this.key.shadow.mapSize.x !== p.shadowMapSize) {
      this.key.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.key.shadow.radius = p.shadowRadius;
    this.contact.strength = shadows ? 1 : 1.35;
    this.wall.holds.setDecoShadows(p.shadowMapSize >= 2048);
    if (this.post) this.post.apply(p);
    if (this.env && this.boulder) this.env.configure(this.layoutFor(this.boulder), p);
  }

  resize(): void {
    if (this.disposed) return;
    const parent = this.canvas.parentElement;
    const w = this.canvas.clientWidth || parent?.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || parent?.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.maxDpr);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr && this.initialized) return;
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = dpr;
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(this.cssW, this.cssH, false);
    this.rig.setAspect(this.cssW / this.cssH);
    this.post?.setSize(this.cssW, this.cssH, dpr);
  }

  // ───────────────────────────── lights ─────────────────────────────

  private setupLights(): void {
    this.scene.add(this.hemi);
    this.key.position.copy(this.keyPos);
    this.key.target = this.keyTarget;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 1.5;
    this.key.shadow.camera.far = 16;
    this.key.shadow.bias = -0.00025;
    this.key.shadow.normalBias = 0.018;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.keyTarget);
    this.wash.position.set(0.5, 4, 0.95);
    this.fill.position.set(-4, 1.6, 3.2);
    this.rim.position.set(1.2, 3.2, -2.6);
    this.scene.add(this.wash, this.fill, this.rim);
    this.caveFlood.target = this.caveTarget;
    this.bounce.position.set(0.4, -1, 0.9);
    this.scene.add(this.caveFlood, this.caveTarget, this.bounce);
  }

  private updateLights(dt: number, st: ClimberState | null): void {
    // Key spot: above-right on the camera side. Gameplay modes keep it tight on the climber
    // (strong modelling + crisp shadows); overview modes widen and pull it back over the route.
    const b = this.boulder;
    const mode = this.rig.mode;
    const overview = mode === 'preview' || mode === 'editor' || mode === 'title' || mode === 'intro';
    let sx = 0;
    let sy = b ? Math.min(b.height * 0.45, 2.2) : 2;
    let sd = 0.3;
    if (st && this.climberVisible) {
      sx = st.com.x;
      sy = st.com.y;
      sd = st.pelvisDepth;
    }
    let reach = 1;
    if (overview && b) {
      const ropeWall = b.mode === 'rope';
      sx *= 0.4;
      sy = ropeWall && mode !== 'title' && mode !== 'intro' ? b.height * 0.5 : Math.max(sy, Math.min(b.height * 0.5, 2.4));
      reach = ropeWall && mode !== 'title' && mode !== 'intro' ? 2.4 : 1.45;
    }
    this.keyReach += (reach - this.keyReach) * (1 - Math.exp(-dt * 2.5));
    const k = this.keyReach;
    this.key.angle = 0.46 + (k - 1) * 0.14;
    this.key.intensity = 128 * k * k;
    this.wash.intensity = 0.4 + (k - 1) * 0.16;
    this.wallFrame.toWorldXYZ(sx, sy, sd, this.v);
    const ceil = this.env ? this.env.ceiling : 7.4;
    const aimL = this.initialized ? 1 - Math.exp(-dt * 3.5) : 1;
    this.keyAim.lerp(this.v, aimL);
    this.v2.set(this.keyAim.x + 1.4 * k, Math.min(this.keyAim.y + 3.6 * k, ceil - 0.6), this.keyAim.z + 4.4 * k);
    this.keyPos.lerp(this.v2, aimL);
    this.key.position.copy(this.keyPos);
    this.keyTarget.position.copy(this.keyAim);
    this.keyTarget.updateMatrixWorld();

    // cave flood + floor bounce (folded walls with steep sections)
    const r = this.roofness;
    this.bounce.intensity = 0.5 * r;
    if (this.tower) {
      // tower flood: fixed on the upper tower, a touch stronger while the whole route is on show
      this.caveFlood.intensity = TOWER_FLOOD * (0.8 + 0.2 * clamp((k - 1) / 1.4, 0, 1));
      this.caveAim.lerp(this.caveHome, aimL * 0.6);
      this.caveTarget.position.copy(this.caveAim);
      this.caveTarget.updateMatrixWorld();
      this.caveFlood.position.set(this.caveAim.x + 1.7, this.wallFrame.origin.y + 5.6, this.wallFrame.origin.z + Math.max(0, this.caveAim.z - this.wallFrame.origin.z) + 10.5);
    } else this.caveFlood.intensity = 70 * r * (0.85 + 0.15 * k);
    if (r > 0 && !this.tower) {
      // aim at the steep section, drifting toward the climber while they are under it
      this.v.copy(this.caveHome);
      if (st && this.climberVisible && !overview) {
        const steep = smoothstep(35, 70, this.wallFrame.angleAt(st.com.y, true));
        this.wallFrame.toWorldXYZ(st.com.x, st.com.y, 0, this.v2);
        this.v.lerp(this.v2, steep * 0.7);
      }
      this.caveAim.lerp(this.v, aimL * 0.6);
      this.caveTarget.position.copy(this.caveAim);
      this.caveTarget.updateMatrixWorld();
      // low in front of the cave, a little to the camera's right
      this.caveFlood.position.set(this.caveAim.x + 1.3, this.wallFrame.origin.y + 0.9, this.caveAim.z + 3.6);
    }
  }

  /** Steepness of the wall's steepest section (0 flat walls … 1 roofs) + the flood's home aim point. */
  private configureCaveLights(b: BoulderDef): void {
    const f = this.wallFrame;
    let best = -Infinity;
    let y = 1.5;
    if (f.folded) {
      for (const sp of f.spans()) {
        if (sp.angle > best) {
          best = sp.angle;
          y = (sp.y0 + sp.y1) / 2;
        }
      }
    }
    this.roofness = f.folded ? smoothstep(38, 80, best) : 0;
    this.tower = b.mode === 'rope';
    if (this.tower) {
      // the upper tower (its steep headwall when that sits up there)
      const yAim = f.folded && y > b.height * 0.55 ? Math.min(y, b.height * 0.82) : b.height * 0.72;
      f.toWorldXYZ(0, yAim, 0, this.caveHome);
      this.caveFlood.color.set('#f4efe6');
      this.caveFlood.angle = 0.4;
      this.caveFlood.penumbra = 0.9;
    } else {
      f.toWorldXYZ(0, f.folded ? y : Math.min(b.height * 0.5, 2.4), 0, this.caveHome);
      this.caveFlood.color.set('#ffe0bd');
      this.caveFlood.angle = 0.62;
      this.caveFlood.penumbra = 0.85;
    }
    this.caveAim.copy(this.caveHome);
  }

  // ───────────────────────────── content ─────────────────────────────

  private layoutFor(b: BoulderDef) {
    return { mode: b.mode, wallWidth: b.mode === 'rope' ? GAME.ropeWall.width : GAME.boulderWall.width, wallHeight: b.height };
  }

  loadBoulder(b: BoulderDef): void {
    const first = !this.boulder;
    this.boulder = { ...b, holds: b.holds.slice() };
    this.highlights.clear();
    this.wall.build(this.boulder, this.preset, { gradeText: `V${b.grade}`, name: b.name });
    this.configureCaveLights(this.boulder);
    this.env?.configure(this.layoutFor(b), this.preset);
    this.state = null;
    this.rest = this.makeRestState(this.boulder);
    this.ropePath = null;
    this.clipped = [];
    this.rope?.setPath(null);
    this.climber?.setHarness(b.mode === 'rope');
    if (this.climber && this.rest) this.climber.pose(this.rest, this.wallFrame, 0);
    this.updateLights(1, this.rest);
    if (first && this.initialized) this.prewarm();
  }

  updateHolds(holds: HoldDef[]): void {
    if (!this.boulder) return;
    this.boulder = { ...this.boulder, holds: holds.slice() };
    this.wall.updateHolds(this.boulder.holds);
    this.highlights.refresh();
  }

  getBoulder(): BoulderDef | null {
    return this.boulder;
  }

  setClimberVisible(v: boolean): void {
    this.climberVisible = v;
    if (this.climber) this.climber.visible = v;
  }

  /** Chalk dip puff out of the bag at the chalking hand (world), else at p in front of the hips. */
  private chalkDip(p: Vec2, intensity: number): void {
    const st = this.state;
    if (this.climber && st) {
      for (const id of ['LH', 'RH'] as const) {
        if (!st.limbs[id].chalking) continue;
        this.climber.getLimbWorld(id, this.v);
        this.fxSys.chalkDipAt(this.v, intensity);
        return;
      }
    }
    this.wallFrame.toWorldXYZ(p.x, p.y, st ? st.pelvisDepth + 0.05 : 0.35, this.v);
    this.fxSys.chalkDipAt(this.v, intensity);
  }

  /** Dyno / deadpoint misses: when a flight ends with a thrown hand not on its target, scuff the hold. */
  private watchMisses(state: ClimberState): void {
    const f = state.flight;
    if (f && f.limbs.length) {
      this.watchFlight = { limbs: f.limbs.slice(), holdId: f.holdId };
      return;
    }
    const w = this.watchFlight;
    if (!w) return;
    this.watchFlight = null;
    const missed = w.limbs.some((l) => (l === 'LH' || l === 'RH') && state.limbs[l].holdId !== w.holdId);
    const h = this.wall.holds.holds.get(w.holdId);
    if (missed && h && this.time - this.lastMissAt > 0.4) {
      this.lastMissAt = this.time;
      this.fxSys.missScuff({ x: h.x, y: h.y }, 1);
    }
  }

  updateClimber(state: ClimberState, dt: number): void {
    if (this.state !== state || dt > 0) this.watchMisses(state);
    this.state = state;
    // folded walls: the body frame (wall up / normal the climber poses against) is the wall where the climber is
    this.wallFrame.setBodyY((state.pelvis.y + state.chest.y) / 2);
    if (!this.climber) return;
    this.climber.setLookTarget(this.focusHint);
    const t0 = performance.now();
    this.climber.pose(state, this.wallFrame, dt);
    this.poseMs += (performance.now() - t0 - this.poseMs) * 0.1;
  }

  setSkin(head: HeadId, colorway: ColorwayId, chalk: ChalkId): void {
    this.skin = { head, colorway, chalk };
    this.climber?.setSkin(head, colorway, chalk);
    const c = CHALKS.find((x) => x.id === chalk);
    if (c) this.fxSys.setChalkColor(c.color);
  }

  setRope(path: Vec2[] | null, clippedIds: string[]): void {
    this.ropePath = path ? path.map((p) => ({ x: p.x, y: p.y })) : null;
    this.clipped = clippedIds.slice();
    if (!path) this.rope?.setPath(null);
  }

  setHoldHighlights(h: HoldHighlight[]): void {
    this.highlights.set(h);
  }

  setGuide(g: GuideState | null): void {
    this.guideState = g ? { ...g, lookAt: g.lookAt ? { ...g.lookAt } : undefined } : null;
    if (g && !this.guide) {
      this.guide = new GuideModel();
      this.scene.add(this.guide);
    }
    if (this.guide) this.guide.visible = !!g;
  }

  // ───────────────────────────── camera ─────────────────────────────

  setCameraMode(mode: CameraMode, opts?: { instant?: boolean; focus?: Vec2 }): void {
    this.rig.setMode(mode, opts);
  }

  /** Optional (app): fractions of the screen height covered by UI (top, bottom); the 'preview' camera fits the route between them. */
  setViewInsets(top: number, bottom: number): void {
    this.rig.viewInsets = { top: clamp(top, 0, 0.45), bottom: clamp(bottom, 0, 0.45) };
  }

  /** Optional (app menus): 'title' camera framing — look-point lift above the climber and orbit distance (m); null = default. */
  setTitleFraming(f: { lift: number; distance: number } | null): void {
    this.rig.titleFraming = f ? { lift: f.lift, distance: f.distance } : null;
  }

  /** Optional: scripted gym-entrance fly-in; resolves when the camera lands (then holds 'title'). */
  playIntro(duration?: number): Promise<void> {
    return this.rig.playIntro(duration);
  }

  /** Optional: 0..1 progress of the intro fly-in. */
  get introProgress(): number {
    return this.rig.introProgress;
  }

  get cameraMode(): CameraMode {
    return this.rig.mode;
  }

  /** The live camera (read-only use: editors/tools may raycast against it). */
  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  /** Dev/QA only: pin the camera to a world pose (null returns control to the rig). */
  setDebugView(pos: THREE.Vector3 | null, look?: THREE.Vector3, fov?: number): void {
    this.rig.debugView = pos ? { pos: pos.clone(), look: (look ?? new THREE.Vector3(0, 2, 0)).clone(), fov: fov ?? 50 } : null;
  }

  setCameraFocusHint(p: Vec2 | null): void {
    this.focusHint = p ? { x: p.x, y: p.y } : null;
    this.rig.setFocusHint(p);
  }

  setEditorView(center: Vec2, metersVisible: number): void {
    this.rig.setEditorView(center, metersVisible);
  }

  portrait(head: HeadId, size?: number): string {
    // a lost context renders nothing: '' lets the UI use its flat emblem (and nothing is cached)
    if (this.lost) return '';
    return renderPortrait(this.gl, head, size);
  }

  /** True between 'webglcontextlost' and 'webglcontextrestored'. */
  get contextLost(): boolean {
    return this.lost;
  }

  /** Optional (app): hear about WebGL context loss (true) and restore (false). Returns an unsubscribe. */
  onContextChange(fn: (lost: boolean) => void): () => void {
    this.contextListeners.add(fn);
    return () => this.contextListeners.delete(fn);
  }

  // ───────────────────────────── projection ─────────────────────────────

  wallToScreen(p: Vec2, depth = 0): ScreenPoint {
    const cam = this.rig.camera;
    this.wallFrame.toWorldXYZ(p.x, p.y, depth, this.ndc);
    this.v.copy(this.ndc).applyMatrix4(cam.matrixWorldInverse);
    const inFront = this.v.z < 0;
    this.ndc.project(cam);
    const x = ((this.ndc.x + 1) / 2) * this.cssW;
    const y = ((1 - this.ndc.y) / 2) * this.cssH;
    const visible = inFront && this.ndc.z <= 1 && x >= 0 && x <= this.cssW && y >= 0 && y <= this.cssH;
    return { x, y, visible };
  }

  screenToWall(x: number, y: number): Vec2 | null {
    const cam = this.rig.camera;
    this.ndc2.set((x / this.cssW) * 2 - 1, -((y / this.cssH) * 2 - 1));
    this.ray.setFromCamera(this.ndc2, cam);
    // across every panel of a folded wall: the nearest panel the ray hits within its own range
    const p = { x: 0, y: 0 };
    if (this.wallFrame.raycast(this.ray.ray, p) < 0) return null;
    const b = this.boulder;
    if (b) {
      const m = OFF_WALL_MARGIN;
      if (p.x < -b.width / 2 - m || p.x > b.width / 2 + m || p.y < -m || p.y > b.height + m) return null;
    }
    return p;
  }

  pxPerMeter(p: Vec2): number {
    const a = this.wallToScreen(p);
    const bx = this.wallToScreen({ x: p.x + 0.25, y: p.y });
    const by = this.wallToScreen({ x: p.x, y: p.y + 0.25 });
    const dx = Math.hypot(bx.x - a.x, bx.y - a.y);
    const dy = Math.hypot(by.x - a.x, by.y - a.y);
    return ((dx + dy) / 2) / 0.25;
  }

  // ───────────────────────────── frame ─────────────────────────────

  private camCtx: CameraContext = { frame: this.wallFrame, boulder: null, state: null, ceiling: 7.4, guide: null };
  private camGuide = { x: 0, depth: 1.5 };

  private cameraContext(): CameraContext {
    const c = this.camCtx;
    c.boulder = this.boulder;
    c.state = this.climberVisible ? this.state ?? this.rest : null;
    c.ceiling = this.env ? this.env.ceiling : 7.4;
    const g = this.guideState;
    if (g && this.guide?.visible) {
      this.camGuide.x = g.x;
      this.camGuide.depth = g.depth;
      c.guide = this.camGuide;
    } else c.guide = null;
    return c;
  }

  frame(dt: number): void {
    if (!this.initialized || this.disposed || this.lost) return;
    // never show an empty gym: an unbranded hole would sit where the wall goes
    if (!this.boulder) this.loadBoulder(showcaseBoulder());
    const d = clamp(dt, 0, 0.1);
    this.time += d;
    const st = this.state ?? this.rest;

    if (!this.state && this.rest && this.climber && this.climberVisible) {
      this.wallFrame.setBodyY((this.rest.pelvis.y + this.rest.chest.y) / 2);
      this.climber.pose(this.rest, this.wallFrame, d);
    }

    this.rig.setContinuousShake(this.state ? this.state.shake : 0);
    this.rig.update(d, this.cameraContext());
    const cam = this.rig.camera;
    // straight-on editor views of steep overhangs (and transitions out of them) sit below pad level
    this.env.setFloorVisible(cam.position.y > GAME.padHeight + 0.05);
    // the title screen sets the STEIBOCK lockup right over the lit CHIRAL HQ sign: dim it there
    this.env.setSignLevel(this.rig.mode === 'title' && this.rig.introProgress >= 1 ? 0.3 : 1);

    this.updateLights(d, st);
    this.wall.update(d);
    this.updateRope(d);
    if (this.guide && this.guideState) this.guide.setState(this.guideState, this.wallFrame, d);
    this.highlights.update(d, cam, this.cssH, this.dpr);
    this.fxSys.update(d, (this.cssH * this.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360)));
    this.contact.update(st, this.climberVisible && !!this.climber);
    this.env.update(d);

    this.gl.info.reset();
    this.post.render(this.scene, cam, d);

    if (this.autoQuality) {
      const next = this.governor.sample(dt, this.preset.level);
      if (next) this.setQualityInternal(next);
    }
  }

  private updateRope(dt: number): void {
    const rope = this.rope;
    if (!rope) return;
    const path = this.ropePath;
    const b = this.boulder;
    if (!path || path.length < 2 || !b) {
      this.wall.quickdraws.setClipped(this.clipped);
      this.climber?.setRopeAnchor(null);
      rope.setPath(null);
      rope.update(dt);
      return;
    }
    while (this.ropeWorld.length < path.length) this.ropeWorld.push(new THREE.Vector3());
    this.ropeWorld.length = path.length;
    const pts = this.ropeWorld;
    const n = path.length;
    // belayer end
    if (this.guide && this.guide.visible && this.guideState?.pose === 'belay') this.guide.getHandWorld('R', pts[0]);
    else this.wallFrame.toWorldXYZ(path[0].x, 0, 0, pts[0]).setY(GAME.padHeight + 1.0).setZ(Math.max(pts[0].z, 0) + 1.3);
    // draws (snap to the carabiner basket)
    this.pulls.clear();
    const qds = b.quickdraws ?? [];
    for (let i = 1; i < n - 1; i++) {
      const p = path[i];
      let matched = false;
      for (const q of qds) {
        const bl = this.wall.quickdraws.basketLocal(q);
        if (Math.hypot(p.x - q.x, p.y - q.y) < 0.3 || Math.hypot(p.x - bl.x, p.y - bl.y) < 0.12) {
          if (this.wall.quickdraws.basketWorld(q.id, pts[i])) {
            matched = true;
            const prev = path[i - 1];
            const next = path[i + 1];
            const px = prev.x - p.x + (next.x - p.x);
            const py = prev.y - p.y + (next.y - p.y);
            const l = Math.hypot(px, py) || 1;
            this.pulls.set(q.id, { x: px / l, y: py / l });
          }
          break;
        }
      }
      if (!matched) this.wallFrame.toWorldXYZ(p.x, p.y, 0.04, pts[i]);
    }
    // harness end
    if (this.climber && this.climberVisible) this.climber.getHarnessWorld(pts[n - 1]);
    else this.wallFrame.toWorldXYZ(path[n - 1].x, path[n - 1].y, 0.3, pts[n - 1]);
    // CHARACTER integration: the hanging climber grabs the rope toward the last clipped draw
    this.climber?.setRopeAnchor(n > 2 ? pts[n - 2] : null);
    this.wall.quickdraws.setClipped(this.clipped, this.pulls);
    rope.setPath(pts);
    rope.update(dt);
  }

  // ───────────────────────────── rest pose ─────────────────────────────

  /** Climber standing on the pads in front of the start holds (until the app drives a sim). */
  private makeRestState(b: BoulderDef): ClimberState {
    const starts = b.holds.filter((h) => h.role === 'start');
    const sx = starts.length ? starts.reduce((a, h) => a + h.x, 0) / starts.length : 0;
    const sy = starts.length ? Math.min(...starts.map((h) => h.y)) : 1.4;
    const sw = this.wallFrame.toWorldXYZ(sx, sy, 0, new THREE.Vector3());
    // stand clear of the wall at every height of the body (under a cave roof: out past its lip)
    let out = sw.z - this.wallFrame.origin.z;
    for (const sp of this.wallFrame.spans()) {
      const lo = Math.min(sp.bottom.y, sp.top.y);
      if (lo > GAME.padHeight + 1.95) continue;
      // the highest point of this panel the body could touch
      const hi = Math.max(sp.bottom.y, sp.top.y);
      const t = hi > lo + 1e-6 ? clamp((GAME.padHeight + 1.95 - sp.bottom.y) / (sp.top.y - sp.bottom.y), 0, 1) : 1;
      out = Math.max(out, sp.bottom.z + (sp.top.z - sp.bottom.z) * t, sp.bottom.z);
    }
    const z = this.wallFrame.origin.z + Math.max(1.0, out + 0.6);
    const pad = GAME.padHeight;
    const toLocal = (x: number, y: number, zz: number) => {
      const r = this.wallFrame.fromWorld(new THREE.Vector3(x, y, zz));
      return r;
    };
    const pelvis = toLocal(sx, pad + 0.95, z);
    const chest = toLocal(sx, pad + 1.44, z - 0.02);
    const limb = (id: LimbSnapshot['id'], x: number, y: number, zz: number, ax: number, ay: number): LimbSnapshot => {
      const e = toLocal(x, y, zz);
      const an = toLocal(ax, ay, z);
      return {
        id, holdId: null, pos: e.p, anchor: an.p, depth: e.depth, dragging: false, load: 0.25, stress: 0, capacity: 1,
        reachRatio: 0.6, smearing: false, shake: 0, busy: false,
      };
    };
    const com = {
      x: pelvis.p.x + (chest.p.x - pelvis.p.x) * 0.38,
      y: pelvis.p.y + (chest.p.y - pelvis.p.y) * 0.38,
    };
    return {
      phase: 'landed',
      pelvis: pelvis.p,
      chest: chest.p,
      com,
      pelvisDepth: pelvis.depth,
      bodyYaw: 0,
      velocity: { x: 0, y: 0 },
      limbs: {
        LH: limb('LH', sx - 0.27, pad + 0.72, z + 0.04, sx - 0.19, pad + 1.4),
        RH: limb('RH', sx + 0.27, pad + 0.72, z + 0.04, sx + 0.19, pad + 1.4),
        LF: limb('LF', sx - 0.14, pad + 0.03, z, sx - 0.11, pad + 0.95),
        RF: limb('RF', sx + 0.14, pad + 0.03, z, sx + 0.11, pad + 0.95),
      },
      tension: 0,
      pump: 0,
      shake: 0,
      balance: 0,
      topProgress: 0,
      time: 0,
      clipped: [],
    };
  }

  // ───────────────────────────── diagnostics ─────────────────────────────

  /** Optional: last frame's render stats (draw calls, triangles; poseMs = smoothed climber IK cost) for QA. */
  stats(): { calls: number; triangles: number; textures: number; geometries: number; poseMs: number } {
    const i = this.gl.info;
    return { calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries, poseMs: Math.round(this.poseMs * 1000) / 1000 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onWinResize);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    this.contextListeners.clear();
    this.resizeObs?.disconnect();
    this.highlights.dispose();
    this.wall.dispose();
    this.fxSys.dispose();
    this.contact.dispose();
    this.climber?.dispose();
    this.guide?.dispose();
    this.rope?.dispose();
    this.env?.dispose();
    this.post?.dispose();
    disposeHoldCache();
    this.key.shadow.map?.dispose();
    this.gl.dispose();
  }
}

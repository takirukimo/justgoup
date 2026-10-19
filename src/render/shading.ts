// Shared shader patches for WORLD materials.
//
// `createSurfaceMaterial` is a MeshStandardMaterial that reads a per-vertex `aSurf` vec4:
//   x = chalk dusting (0..1)   → mixes toward the chalk colour, rougher
//   y = metal mask (−1..1)     → +: bare steel (grey, metallic: bolts, hangers, chains)
//                                −: anodised metal that keeps the vertex/material colour (carabiners)
//   z = cavity AO (0..1)       → darkens (incuts, pocket interiors, wall contact)
//   w = gloss (0..1)           → smoother (dual-tex volume faces, anodised parts)
// plus, in the `rim` variant (route holds), a fresnel rim used for hold highlights and an always-on
// edge light + self-lift (`uEdge*`, `uLift`) that make the current route read against the dark wall
// and the dimmer deco holds without looking gamey.
// All instances share one compiled program per (rim on/off) variant.
//
// Thin-hold shading (research §4.4, no extra passes), on hold materials:
//   `curv` — radiance scaling from the baked per-vertex curvature `aCurv` (render/curvature.ts): convex
//            lips and thin edges lift, cavities sink, so a crimp's roll reads at phone scale. Always on.
//   `cue`  — within reach of the climber only (HOLD_CUE.uCueC: shoulders + hips with their reach): a rim
//            from the hold's grip side, TF2 style (1 − n·v)⁴ · max(0, n·grip), and a tight glint on the
//            ridges whose half-vector uses the grip direction. Usable lips catch a little light as the
//            climber gets near them; nothing is outlined. HOLD_CUE.uCueAmt fades it in / out (renderer).

import * as THREE from 'three';

/**
 * Shared uniforms of the within-reach hold cue (one update per frame for every hold material).
 * uCueC: four reach spheres in world space (xyz = shoulder / hip, w = radius in m).
 * uCueAmt: overall strength (0 = off; the renderer eases it: ≈1 normal, stronger in Pure mode).
 * uCueRim / uCueGlint: rim + glint gains (quality tiers). uCurvGain: x ridge lift, y cavity darkening.
 */
export const HOLD_CUE = {
  uCueC: { value: [new THREE.Vector4(0, -50, 0, 0), new THREE.Vector4(0, -50, 0, 0), new THREE.Vector4(0, -50, 0, 0), new THREE.Vector4(0, -50, 0, 0)] },
  uCueAmt: { value: 0 },
  uCueRim: { value: 0.55 },
  uCueGlint: { value: 1.4 },
  uCurvGain: { value: new THREE.Vector2(0.35, 0.25) },
};

export interface SurfaceUniforms {
  uChalk: { value: THREE.Color };
  uRimColor: { value: THREE.Color };
  uRimStrength: { value: number };
  uRimPower: { value: number };
  /** Route-hold edge light (fresnel, thin) — always on, independent of highlights. */
  uEdgeColor: { value: THREE.Color };
  uEdgeStrength: { value: number };
  uEdgePower: { value: number };
  /** Self-illumination as a fraction of the albedo (reads in the key light's shadow). */
  uLift: { value: number };
}

export type SurfaceMaterial = THREE.MeshStandardMaterial & { userData: { surf: SurfaceUniforms } };

export interface SurfaceOpts {
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  normalMap?: THREE.Texture | null;
  normalScale?: number;
  /** UV repeat for the normal map (UVs are generated in meters). */
  normalRepeat?: number;
  chalk?: THREE.ColorRepresentation;
  rim?: boolean;
  envMapIntensity?: number;
  /** Radiance scaling from the geometry's baked `aCurv` (holds). */
  curv?: boolean;
  /** Within-reach rim + glint cue (usable route holds; needs `curv`). */
  cue?: boolean;
  /**
   * Merged route holds (one mesh for many holds): per-hold highlight rims come from this texture
   * (column = the vertex's `aHold`; row 0 rgb colour + a strength, row 1 r power) instead of the
   * uRim* uniforms, and the cue's grip direction from the per-vertex `aGrip` (world space).
   */
  rimTex?: THREE.DataTexture | null;
}

const VERT_DECL = /* glsl */ `
attribute vec4 aSurf;
varying vec4 vSurf;
#ifdef SURF_CURV
attribute float aCurv;
varying float vCurv;
#endif
#ifdef SURF_CUE
varying vec3 vCueW;
varying vec3 vGripV;
#endif
#ifdef SURF_RIM_TEX
attribute float aHold;
attribute vec3 aGrip;
uniform sampler2D uRimTex;
varying vec4 vRimT;
varying float vRimP;
#endif
`;

const VERT_RIM_TEX = /* glsl */ `
#ifdef SURF_RIM_TEX
	{
		ivec2 ri = ivec2(int(aHold + 0.5), 0);
		vRimT = texelFetch(uRimTex, ri, 0);
		vRimP = texelFetch(uRimTex, ri + ivec2(0, 1), 0).r;
	}
#endif`;

const VERT_CUE = /* glsl */ `
#ifdef SURF_CUE
	{
		vec4 cueP = vec4(transformed, 1.0);
		vec3 grip = vec3(0.0, 1.0, 0.0);
		#ifdef SURF_RIM_TEX
			grip = aGrip;
		#endif
		#ifdef USE_INSTANCING
			cueP = instanceMatrix * cueP;
			grip = mat3(instanceMatrix) * grip;
		#endif
		vCueW = (modelMatrix * cueP).xyz;
		// the hold's grip side (hold-local +y) in view space: the lip a finger pulls on
		vGripV = normalize(normalMatrix * grip);
	}
#endif`;

const FRAG_DECL = /* glsl */ `
varying vec4 vSurf;
uniform vec3 uChalk;
#ifdef SURF_RIM
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimPower;
uniform vec3 uEdgeColor;
uniform float uEdgeStrength;
uniform float uEdgePower;
uniform float uLift;
#endif
#ifdef SURF_RIM_TEX
varying vec4 vRimT;
varying float vRimP;
#endif
#ifdef SURF_CURV
varying float vCurv;
uniform vec2 uCurvGain;
#endif
#ifdef SURF_CUE
varying vec3 vCueW;
varying vec3 vGripV;
uniform vec4 uCueC[4];
uniform float uCueAmt;
uniform float uCueRim;
uniform float uCueGlint;
#endif
`;

const FRAG_CURV = /* glsl */ `
#ifdef SURF_CURV
	{
		// radiance scaling: lips and thin edges lift, cavities sink (bolts and hangers excluded)
		float ridge = clamp(vCurv, 0.0, 1.0) * (1.0 - surfMetal);
		float cavity = clamp(-vCurv, 0.0, 1.0);
		outgoingLight *= 1.0 + uCurvGain.x * ridge - uCurvGain.y * cavity;
	#ifdef SURF_CUE
		if (uCueAmt > 0.001) {
			float reach = 0.0;
			for (int i = 0; i < 4; i++) {
				reach = max(reach, 1.0 - smoothstep(uCueC[i].w, uCueC[i].w + 0.35, distance(vCueW, uCueC[i].xyz)));
			}
			if (reach > 0.0) {
				vec3 N = normalize(nonPerturbedNormal);
				vec3 V = normalize(vViewPosition);
				vec3 G = normalize(vGripV);
				float upF = max(dot(N, G), 0.0);
				float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
				float glint = pow(max(dot(N, normalize(V + G)), 0.0), 48.0) * ridge * upF;
				// warm off-white, a touch of the hold's own colour: light catching an edge, not paint
				vec3 cueCol = mix(vec3(1.0, 0.95, 0.88), diffuseColor.rgb, 0.2);
				outgoingLight += cueCol * (uCueAmt * reach) * (uCueRim * fres * upF * (0.35 + 0.65 * ridge) + uCueGlint * glint) * (1.0 - surfMetal);
			}
		}
	#endif
	}
#endif`;

export function createSurfaceMaterial(o: SurfaceOpts = {}): SurfaceMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xffffff,
    roughness: o.roughness ?? 0.55,
    metalness: o.metalness ?? 0,
    vertexColors: true,
    envMapIntensity: o.envMapIntensity ?? 1,
  });
  if (o.normalMap) {
    mat.normalMap = o.normalMap;
    const s = o.normalScale ?? 0.35;
    mat.normalScale.set(s, s);
  }
  const surf: SurfaceUniforms = {
    uChalk: { value: new THREE.Color(o.chalk ?? 0xf3f1ec) },
    uRimColor: { value: new THREE.Color(0xffffff) },
    uRimStrength: { value: 0 },
    uRimPower: { value: 2.2 },
    uEdgeColor: { value: new THREE.Color(0xffffff) },
    uEdgeStrength: { value: 0 },
    uEdgePower: { value: 3 },
    uLift: { value: 0 },
  };
  mat.userData.surf = surf;
  const rim = !!o.rim;
  const curv = !!o.curv;
  const cue = curv && !!o.cue;
  const rimTex = rim && o.rimTex ? o.rimTex : null;
  const repeat = o.normalRepeat ?? 1;
  if (rim) mat.defines = { ...(mat.defines ?? {}), SURF_RIM: '' };
  if (curv) mat.defines = { ...(mat.defines ?? {}), SURF_CURV: '' };
  if (cue) mat.defines = { ...(mat.defines ?? {}), SURF_CUE: '' };
  if (rimTex) mat.defines = { ...(mat.defines ?? {}), SURF_RIM_TEX: '' };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uChalk = surf.uChalk;
    if (rim) {
      shader.uniforms.uRimColor = surf.uRimColor;
      shader.uniforms.uRimStrength = surf.uRimStrength;
      shader.uniforms.uRimPower = surf.uRimPower;
      shader.uniforms.uEdgeColor = surf.uEdgeColor;
      shader.uniforms.uEdgeStrength = surf.uEdgeStrength;
      shader.uniforms.uEdgePower = surf.uEdgePower;
      shader.uniforms.uLift = surf.uLift;
    }
    if (curv) shader.uniforms.uCurvGain = HOLD_CUE.uCurvGain;
    if (rimTex) shader.uniforms.uRimTex = { value: rimTex };
    if (cue) {
      shader.uniforms.uCueC = HOLD_CUE.uCueC;
      shader.uniforms.uCueAmt = HOLD_CUE.uCueAmt;
      shader.uniforms.uCueRim = HOLD_CUE.uCueRim;
      shader.uniforms.uCueGlint = HOLD_CUE.uCueGlint;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvSurf = aSurf;${curv ? '\n#ifdef SURF_CURV\n\tvCurv = aCurv;\n#endif' : ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>${VERT_RIM_TEX}${VERT_CUE}`);
    if (repeat !== 1) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>\n#ifdef USE_NORMALMAP\n\tvNormalMapUv *= ${repeat.toFixed(3)};\n#endif`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
	diffuseColor.rgb = mix(diffuseColor.rgb, uChalk, clamp(vSurf.x, 0.0, 1.0));
	diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.31, 0.33), clamp(vSurf.y, 0.0, 1.0));
	float surfMetal = clamp(abs(vSurf.y), 0.0, 1.0);
	diffuseColor.rgb *= 1.0 - clamp(vSurf.z, 0.0, 1.0);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
	roughnessFactor = mix(roughnessFactor, 0.92, clamp(vSurf.x, 0.0, 1.0) * 0.8);
	roughnessFactor = mix(roughnessFactor, 0.28, clamp(vSurf.w, 0.0, 1.0));
	roughnessFactor = mix(roughnessFactor, 0.32, surfMetal);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
	// glossy (smooth, dual-tex) zones lose most of the grain of the speckle normal map
	normal = normalize(mix(normal, nonPerturbedNormal, clamp(vSurf.w, 0.0, 1.0) * 0.8));`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
	metalnessFactor = mix(metalnessFactor, 0.9, surfMetal);`,
      );
    if (curv) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `${FRAG_CURV}\n#include <opaque_fragment>`);
    if (rim) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
	{
		float ndv = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
#ifdef SURF_RIM_TEX
		vec3 rimC = vRimT.rgb;
		float rimS = vRimT.a;
		float rimP = max(vRimP, 0.5);
#else
		vec3 rimC = uRimColor;
		float rimS = uRimStrength;
		float rimP = uRimPower;
#endif
		float fres = pow(ndv, rimP);
		totalEmissiveRadiance += rimC * (fres * rimS + rimS * 0.12);
		// edge light fades into cavities (AO) so incuts stay dark and the silhouette stays crisp
		float cav = 1.0 - clamp(vSurf.z, 0.0, 1.0);
		totalEmissiveRadiance += uEdgeColor * (pow(ndv, uEdgePower) * uEdgeStrength * cav);
		totalEmissiveRadiance += diffuseColor.rgb * uLift * cav;
	}`,
      );
    }
  };
  mat.customProgramCacheKey = () => `surf:${rim ? 1 : 0}:${repeat}:${curv ? 1 : 0}${cue ? 1 : 0}${rimTex ? 1 : 0}`;
  return mat as SurfaceMaterial;
}

/** Adds a default aSurf (0,0,0,0) and white vertex colour to a geometry if missing. */
export function ensureSurfaceAttributes(g: THREE.BufferGeometry, surf: [number, number, number, number] = [0, 0, 0, 0]): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  if (!g.getAttribute('aSurf')) {
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) a.set(surf, i * 4);
    g.setAttribute('aSurf', new THREE.BufferAttribute(a, 4));
  }
  if (!g.getAttribute('color')) {
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/** Writes a constant colour into a geometry's colour attribute. */
export function paintGeometry(g: THREE.BufferGeometry, color: THREE.Color): void {
  const c = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < c.count; i++) c.setXYZ(i, color.r, color.g, color.b);
  c.needsUpdate = true;
}

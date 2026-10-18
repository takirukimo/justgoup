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

import * as THREE from 'three';

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
}

const VERT_DECL = /* glsl */ `
attribute vec4 aSurf;
varying vec4 vSurf;
`;

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
`;

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
  const repeat = o.normalRepeat ?? 1;
  if (rim) mat.defines = { ...(mat.defines ?? {}), SURF_RIM: '' };

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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvSurf = aSurf;');
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
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
	metalnessFactor = mix(metalnessFactor, 0.9, surfMetal);`,
      );
    if (rim) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
	{
		float ndv = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
		float fres = pow(ndv, uRimPower);
		totalEmissiveRadiance += uRimColor * (fres * uRimStrength + uRimStrength * 0.12);
		// edge light fades into cavities (AO) so incuts stay dark and the silhouette stays crisp
		float cav = 1.0 - clamp(vSurf.z, 0.0, 1.0);
		totalEmissiveRadiance += uEdgeColor * (pow(ndv, uEdgePower) * uEdgeStrength * cav);
		totalEmissiveRadiance += diffuseColor.rgb * uLift * cav;
	}`,
      );
    }
  };
  mat.customProgramCacheKey = () => `surf:${rim ? 1 : 0}:${repeat}`;
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

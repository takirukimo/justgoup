// Multi-angle walls (Phase B, docs/ROADMAP.md B1): pure, deterministic math for a wall made of flat
// panels stacked along its surface. Shared by the sim (statics, ClimberSim), the planner, the generator
// and — later — the renderer, so every layer folds the wall the same way.
//
// ── Coordinates ──────────────────────────────────────────────────────────────────────────────────
//   SURFACE (what the sim works in): x right, y = distance ALONG the wall surface from the floor (m),
//     depth = distance out from the surface toward the climber. BoulderDef holds / quickdraws use it.
//   LOCAL 3D (what the renderer needs): x right, y = height above the floor, z = out from the wall's
//     base line toward the climber. It is WallFrame.toWorld (src/render/wall-frame.ts) minus the frame
//     origin: a one-panel wall at angle θ maps (x, y, d) → (x, y·cosθ − d·sinθ, y·sinθ + d·cosθ),
//     exactly what WallFrame does today, so flat walls render unchanged.
//   SIDE VIEW (internal): the (height, out) plane — the folds are lines parallel to x, so all the fold
//     geometry is 2D in this plane. Panel i runs from base point Bᵢ along Tᵢ = (cosθᵢ, sinθᵢ); its
//     outward normal is Nᵢ = (−sinθᵢ, cosθᵢ).
//   Angles are degrees past vertical: 0 vertical, + overhang (top toward the climber), − slab,
//   90 a horizontal roof (the climber hangs under it).
//
// ── Folds ────────────────────────────────────────────────────────────────────────────────────────
// The surface itself is the sharp polyline (holds sit exactly on their panel). Points OFF the surface
// (the body, limbs in the air) use a normal that turns smoothly across a band of ±blend around every
// fold, so surfaceToLocal3D is continuous in y at every depth and local3DToSurface inverts it. A fold
// where the angle grows (vertical → roof) is CONCAVE seen from the climber: an inside corner, distances
// across it are shorter in 3D than along the surface. A fold where it shrinks (roof → lip) is CONVEX:
// an outside corner the body has to wrap around, distances are longer.
//
// ── Reach across folds ───────────────────────────────────────────────────────────────────────────
// The anatomy envelopes (anatomy.ts) are calibrated in-plane, on a flat wall. reachScale() gives the
// factor k that turns a surface vector anchor → target into the in-plane vector the envelopes should
// see: k = D / D_flat, with D the free-space distance in 3D from the anchor (FOLD.anchorDepth off the
// wall: shoulders and hips sit 0.2–0.5 m out) to the target, around convex lips (a taut string over the
// lip), straight across concave corners — and D_flat the same distance on an unfolded flat wall. On a
// flat stretch k = 1 exactly. So a hand reaching from a steep wall into a roof gets closer (k < 1), and
// a hand can't reach around a roof lip just because the surface distance is short (k > 1).
//
// Everything here uses IEEE basic arithmetic, Math.sqrt and dmath.ts only (bit-identical on every
// device: the generator makes threshold decisions with it).

import type { BoulderDef, Vec2, WallPanel } from '../core/types';
import { datan2, dcos, dsin } from './dmath';

/** A point / vector in wall-local 3D (x right, y up, z out toward the climber). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Surface coordinates of a 3D point. */
export interface SurfacePoint {
  x: number;
  /** Distance along the surface (m). */
  y: number;
  /** Signed distance out from the surface (negative = behind it). */
  depth: number;
}

export const FOLD = {
  /** Half-width (m) of the band around a fold over which the off-surface normal turns. */
  blend: 0.3,
  /** …at most this fraction of a neighbouring panel's length when that panel has a fold at both ends. */
  blendFrac: 0.45,
  /** Anchor (shoulder / hip) distance off the wall the fold-aware reach metric assumes (m). */
  anchorDepth: 0.3,
  /** Smallest reach scale (a target almost at the anchor in 3D). */
  minScale: 0.2,
  /** Angle range a panel may take (degrees). */
  minAngle: -30,
  maxAngle: 90,
} as const;

const DEG = 0.017453292519943295;

/**
 * A normalised multi-angle wall. Build it with makeProfile / wallProfile; treat it as immutable.
 * Arrays are per panel, bottom → top.
 */
export interface WallProfile {
  readonly panels: readonly WallPanel[];
  readonly n: number;
  /** Panel start along the surface (y0[0] = 0). */
  readonly y0: Float64Array;
  /** Panel angle (degrees), its cos and sin. */
  readonly ang: Float64Array;
  readonly c: Float64Array;
  readonly s: Float64Array;
  /** Side-view base point of each panel: height (local3D y) and out (local3D z). */
  readonly bh: Float64Array;
  readonly bz: Float64Array;
  /** Half-width of the normal blend band at the fold where panel i starts (index 0 unused, 0). */
  readonly blend: Float64Array;
  /** Surface length of the wall (its y extent): holds live in [0, length]. */
  readonly length: number;
  readonly minAngle: number;
  readonly maxAngle: number;
  /** One panel (or every panel at the same angle): a classic flat wall. */
  readonly flat: boolean;
  /** Convex folds (outside corners) by panel index: 1 when the angle drops at the start of panel i. */
  readonly convex: Uint8Array;
}

/**
 * Normalise panels into a WallProfile. Panels are sorted by y0, the first starts at 0, angles are
 * clamped to [FOLD.minAngle, FOLD.maxAngle], and neighbours at the same angle merge. Missing / empty
 * panels give one flat panel at `wallAngle`. `length` is the surface length (Infinity = unbounded).
 */
export function makeProfile(panels: readonly WallPanel[] | null | undefined, wallAngle = 0, length = Infinity): WallProfile {
  const raw: WallPanel[] = [];
  if (panels) for (const p of panels) if (p && Number.isFinite(p.y0) && Number.isFinite(p.angle)) raw.push({ y0: Math.max(0, p.y0), angle: p.angle });
  raw.sort((a, b) => a.y0 - b.y0);
  const clean: WallPanel[] = [];
  for (const p of raw) {
    const angle = Math.min(FOLD.maxAngle, Math.max(FOLD.minAngle, p.angle));
    const last = clean[clean.length - 1];
    if (last && p.y0 - last.y0 < 1e-6) {
      last.angle = angle; // the later of two panels at the same height wins
      continue;
    }
    if (last && Math.abs(last.angle - angle) < 1e-6) continue; // same angle: one panel
    clean.push({ y0: p.y0, angle });
  }
  if (!clean.length) clean.push({ y0: 0, angle: Math.min(FOLD.maxAngle, Math.max(FOLD.minAngle, Number.isFinite(wallAngle) ? wallAngle : 0)) });
  clean[0].y0 = 0;
  // a panel that starts beyond the end of the wall does not exist
  while (clean.length > 1 && clean[clean.length - 1].y0 >= length - 1e-6) clean.pop();
  const n = clean.length;
  const y0 = new Float64Array(n);
  const ang = new Float64Array(n);
  const c = new Float64Array(n);
  const s = new Float64Array(n);
  const bh = new Float64Array(n);
  const bz = new Float64Array(n);
  const blend = new Float64Array(n);
  const convex = new Uint8Array(n);
  let minA = Infinity;
  let maxA = -Infinity;
  for (let i = 0; i < n; i++) {
    y0[i] = clean[i].y0;
    ang[i] = clean[i].angle;
    c[i] = dcos(ang[i] * DEG);
    s[i] = dsin(ang[i] * DEG);
    if (i > 0) {
      const len = y0[i] - y0[i - 1];
      bh[i] = bh[i - 1] + len * c[i - 1];
      bz[i] = bz[i - 1] + len * s[i - 1];
      convex[i] = ang[i] < ang[i - 1] ? 1 : 0;
    }
    if (ang[i] < minA) minA = ang[i];
    if (ang[i] > maxA) maxA = ang[i];
  }
  for (let i = 1; i < n; i++) {
    // a band shares a panel with the next fold's band; the first and the last panel have only one fold, so
    // a short kicker can give its fold nearly its whole length (a wider band keeps local3DToSurface unique
    // deeper into the concave corner: the blended normals meet ≈ 2·blend / Δangle off the wall)
    const before = (y0[i] - y0[i - 1]) * (i === 1 ? 0.98 : FOLD.blendFrac);
    const after = ((i + 1 < n ? y0[i + 1] : length) - y0[i]) * (i === n - 1 ? 0.98 : FOLD.blendFrac);
    blend[i] = Math.max(0.02, Math.min(FOLD.blend, before, after));
  }
  return { panels: clean, n, y0, ang, c, s, bh, bz, blend, length, minAngle: minA, maxAngle: maxA, flat: n === 1, convex };
}

const CACHE = new WeakMap<object, { angle: number; height: number; prof: WallProfile }>();

/** The boulder's wall as a WallProfile (a flat one-panel profile when it has no `profile`). Cached. */
export function wallProfile(b: Pick<BoulderDef, 'wallAngle' | 'height'> & { profile?: WallPanel[] }): WallProfile {
  const key = (b.profile ?? null) as object | null;
  if (key) {
    const hit = CACHE.get(key);
    if (hit && hit.angle === b.wallAngle && hit.height === b.height) return hit.prof;
    const prof = makeProfile(b.profile, b.wallAngle, b.height);
    CACHE.set(key, { angle: b.wallAngle, height: b.height, prof });
    return prof;
  }
  return makeProfile(null, b.wallAngle, b.height);
}

/** The boulder's profile when it really folds (≥ 2 panels at different angles), else null (a flat wall). */
export function profileOf(b: Pick<BoulderDef, 'wallAngle' | 'height'> & { profile?: WallPanel[] }): WallProfile | null {
  if (!b.profile || b.profile.length < 2) return null;
  const p = wallProfile(b);
  return p.flat ? null : p;
}

/** Steepest panel angle a list of panels reaches (BoulderDef.wallAngle of a profiled wall). */
export function steepestAngle(panels: readonly WallPanel[]): number {
  let a = -Infinity;
  for (const p of panels) if (Number.isFinite(p.angle) && p.angle > a) a = p.angle;
  return Number.isFinite(a) ? a : 0;
}

// ═══════════════════════════════ lookups ═══════════════════════════════

/** Index of the panel containing surface height y (clamped: below 0 the first, above the top the last). */
export function panelIndexAt(p: WallProfile, y: number): number {
  const y0 = p.y0;
  let i = p.n - 1;
  while (i > 0 && y < y0[i]) i--;
  return i;
}

/**
 * Holds next to a convex fold (a roof lip, the top of a steep section easing off, a slab bulge): the same
 * rule as the renderer's foldClampY (render/holds.ts) — folds of at least `minDelta` degrees, `gap` (m) of
 * clearance, at most `maxShift` (m) of correction.
 */
export const FOLD_CLEAR = { minDelta: 8, gap: 0.006, maxShift: 0.12 } as const;

/**
 * Surface height for a hold centred at y whose drawn footprint reaches `e` (m) up and down the surface
 * (holds.drawnHalfAlong): slid back along its own panel until the footprint ends FOLD_CLEAR.gap short of a
 * convex fold above or below it (at most FOLD_CLEAR.maxShift; a panel shorter than the hold keeps it
 * centred). Inside corners are left alone. The renderer draws a hold by exactly this rule, so a hold placed
 * at foldClearY(…) is drawn where the sim holds it (no render-side shift, HoldInfo.dy ≈ 0).
 */
export function foldClearY(p: WallProfile | null, y: number, e: number): number {
  if (!p || p.flat) return y;
  const i = panelIndexAt(p, y);
  const y0 = p.y0[i];
  const y1 = i + 1 < p.n ? p.y0[i + 1] : p.length;
  const lo = i > 0 && p.ang[i - 1] - p.ang[i] >= FOLD_CLEAR.minDelta ? y0 + FOLD_CLEAR.gap + e : -Infinity;
  const hi = i + 1 < p.n && p.ang[i] - p.ang[i + 1] >= FOLD_CLEAR.minDelta ? y1 - FOLD_CLEAR.gap - e : Infinity;
  const t = lo > hi ? (y0 + y1) / 2 : Math.min(hi, Math.max(lo, y));
  const d = t - y;
  return y + (d > FOLD_CLEAR.maxShift ? FOLD_CLEAR.maxShift : d < -FOLD_CLEAR.maxShift ? -FOLD_CLEAR.maxShift : d);
}

/** The panel containing surface height y. */
export function panelAt(p: WallProfile, y: number): WallPanel {
  return p.panels[panelIndexAt(p, y)];
}

/** Panel angle (degrees) at surface height y: the sharp angle of the panel there. */
export function angleAt(p: WallProfile, y: number): number {
  return p.ang[panelIndexAt(p, y)];
}

/** Side-view scratch (height h, out z). */
export interface Side {
  h: number;
  z: number;
}

/**
 * Where y sits relative to the folds: the fold index whose blend band contains y (−1 for none) and
 * the blend parameter t ∈ [0, 1] across that band. The off-surface normal there is the normalised
 * linear blend of the two panel normals (no trigonometry: cheap and deterministic).
 */
const BAND = { fold: -1, t: 0, panel: 0 };
function bandAt(p: WallProfile, y: number): typeof BAND {
  const i = panelIndexAt(p, y);
  BAND.panel = i;
  BAND.fold = -1;
  BAND.t = 0;
  if (i > 0 && y < p.y0[i] + p.blend[i]) {
    const w = p.blend[i];
    BAND.fold = i;
    BAND.t = (y - (p.y0[i] - w)) / (2 * w);
  } else if (i + 1 < p.n && y > p.y0[i + 1] - p.blend[i + 1]) {
    const w = p.blend[i + 1];
    BAND.fold = i + 1;
    BAND.t = (y - (p.y0[i + 1] - w)) / (2 * w);
  }
  return BAND;
}

/** Off-surface unit normal for a band position (fold f, parameter t) or a plain panel (f < 0). */
function bandNormal(p: WallProfile, f: number, t: number, panel: number, out: Side): Side {
  if (f < 0) {
    out.h = -p.s[panel];
    out.z = p.c[panel];
    return out;
  }
  const u = 1 - t;
  const nh = -(u * p.s[f - 1] + t * p.s[f]);
  const nz = u * p.c[f - 1] + t * p.c[f];
  const l = Math.sqrt(nh * nh + nz * nz);
  out.h = nh / l;
  out.z = nz / l;
  return out;
}

const SN: Side = { h: 0, z: 0 };

/**
 * Smooth wall angle at y (degrees): the panel angle away from folds and the angle of the turning
 * off-surface normal across ±blend of each fold. Use it for what the BODY feels (gravity's split under
 * the centre of mass); use angleAt for what a CONTACT feels (the panel its hold is bolted to).
 */
export function smoothAngleAt(p: WallProfile, y: number): number {
  const b = bandAt(p, y);
  if (b.fold < 0) return p.ang[b.panel];
  bandNormal(p, b.fold, b.t, b.panel, SN);
  // N = (−sin φ, cos φ)
  return datan2(-SN.h, SN.z) / DEG;
}

/** True when y lies in a fold's blend band (the off-surface normal is turning there). */
export function inFoldBand(p: WallProfile, y: number): boolean {
  return bandAt(p, y).fold >= 0;
}

/** The surface point at y in the side view (on the sharp polyline; extrapolated past both ends). */
export function surfaceSide(p: WallProfile, y: number, out: Side): Side {
  const i = panelIndexAt(p, y);
  const t = y - p.y0[i];
  out.h = p.bh[i] + t * p.c[i];
  out.z = p.bz[i] + t * p.s[i];
  return out;
}

/** Unit off-surface normal at y in the side view (blended across folds): (nh, nz) into out (h, z). */
export function normalSide(p: WallProfile, y: number, out: Side): Side {
  const b = bandAt(p, y);
  return bandNormal(p, b.fold, b.t, b.panel, out);
}

/** Side-view point at surface height y, `depth` off the wall (blended normal). */
export function offsetSide(p: WallProfile, y: number, depth: number, out: Side): Side {
  const b = bandAt(p, y);
  const i = b.panel;
  const t = y - p.y0[i];
  const h = p.bh[i] + t * p.c[i];
  const z = p.bz[i] + t * p.s[i];
  if (depth === 0) {
    out.h = h;
    out.z = z;
    return out;
  }
  bandNormal(p, b.fold, b.t, i, out);
  out.h = h + depth * out.h;
  out.z = z + depth * out.z;
  return out;
}

const SA: Side = { h: 0, z: 0 };
const SB: Side = { h: 0, z: 0 };

/**
 * Wall-local 3D position of surface point (x, y) at `depth` off the wall (the renderer's mapping;
 * WallFrame.toWorld minus its origin on a flat wall). Continuous in y at every depth.
 */
export function surfaceToLocal3D(p: WallProfile, x: number, y: number, depth = 0, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  offsetSide(p, y, depth, SA);
  out.x = x;
  out.y = SA.h;
  out.z = SA.z;
  return out;
}

/** World height (m above the floor) of surface point y at `depth` off the wall. */
export function worldHeight(p: WallProfile, y: number, depth = 0): number {
  return offsetSide(p, y, depth, SA).h;
}

/**
 * Outward unit normal of the wall at surface height y, in wall-local 3D (x = 0). `blended` (default)
 * turns it smoothly across each fold band — the frame for things OFF the wall (the body, a dangling
 * limb, the camera); `blended = false` is the sharp normal of the panel at y — the frame for things ON
 * it (a hold, a volume, a quickdraw bolted to that panel).
 */
export function normalAt(p: WallProfile, y: number, out: Vec3 = { x: 0, y: 0, z: 0 }, blended = true): Vec3 {
  if (blended) normalSide(p, y, SN);
  else {
    const i = panelIndexAt(p, y);
    SN.h = -p.s[i];
    SN.z = p.c[i];
  }
  out.x = 0;
  out.y = SN.h;
  out.z = SN.z;
  return out;
}

/**
 * Unit tangent pointing UP the surface (toward larger y) at surface height y, in wall-local 3D (x = 0):
 * (0, cos φ, sin φ) for the panel angle φ. Perpendicular to normalAt with the same `blended` flag, so
 * (x̂, tangentAt, normalAt) is a right-handed frame for orienting meshes on the folded wall.
 */
export function tangentAt(p: WallProfile, y: number, out: Vec3 = { x: 0, y: 0, z: 0 }, blended = true): Vec3 {
  normalAt(p, y, out, blended);
  const nh = out.y;
  const nz = out.z;
  out.y = nz;
  out.z = -nh;
  return out;
}

/** g(y) = T_b(y) · (Q − S(y)): zero where Q lies on the blended normal through S(y). */
function bandG(p: WallProfile, y: number, qh: number, qz: number): number {
  surfaceSide(p, y, SB);
  normalSide(p, y, SN);
  return SN.z * (qh - SB.h) - SN.h * (qz - SB.z);
}

/**
 * Surface coordinates (x, y, depth) of a wall-local 3D point: the inverse of surfaceToLocal3D. Where a
 * point has several descriptions (far from the wall, or deep inside a concave corner) the one closest
 * to the wall (smallest non-negative depth) wins; behind the wall, the one least behind it.
 */
export function local3DToSurface(p: WallProfile, x: number, h: number, z: number, out: SurfacePoint = { x: 0, y: 0, depth: 0 }): SurfacePoint {
  out.x = x;
  let bestY = 0;
  let bestD = Infinity;
  let found = false;
  const consider = (y: number, d: number): void => {
    if (!found) {
      found = true;
      bestY = y;
      bestD = d;
      return;
    }
    const okNew = d >= -1e-9;
    const okOld = bestD >= -1e-9;
    if ((okNew && !okOld) || (okNew === okOld && (okNew ? d < bestD : d > bestD))) {
      bestY = y;
      bestD = d;
    }
  };
  const n = p.n;
  // straight parts of the panels (closed form)
  for (let i = 0; i < n; i++) {
    const lo = i === 0 ? -Infinity : p.y0[i] + p.blend[i];
    const hi = i + 1 < n ? p.y0[i + 1] - p.blend[i + 1] : Infinity;
    if (!(hi >= lo)) continue;
    const dh = h - p.bh[i];
    const dz = z - p.bz[i];
    const y = p.y0[i] + dh * p.c[i] + dz * p.s[i];
    if (y < lo - 1e-12 || y > hi + 1e-12) continue;
    consider(y, -dh * p.s[i] + dz * p.c[i]);
  }
  // fold bands: bisect g on each half (the polyline is straight on either side of the fold)
  for (let i = 1; i < n; i++) {
    const w = p.blend[i];
    const knots = [p.y0[i] - w, p.y0[i], p.y0[i] + w];
    for (let k = 0; k < 2; k++) {
      let a = knots[k];
      let b = knots[k + 1];
      let ga = bandG(p, a, h, z);
      const gb = bandG(p, b, h, z);
      if (ga === 0) {
        consider(a, depthAt(p, a, h, z));
        continue;
      }
      if (ga * gb > 0) continue;
      for (let it = 0; it < 48; it++) {
        const m = (a + b) * 0.5;
        const gm = bandG(p, m, h, z);
        if (gm === 0) {
          a = b = m;
          break;
        }
        if (ga * gm < 0) b = m;
        else {
          a = m;
          ga = gm;
        }
      }
      const y = (a + b) * 0.5;
      consider(y, depthAt(p, y, h, z));
    }
  }
  out.y = bestY;
  out.depth = found ? bestD : 0;
  return out;
}

/** N_b(y) · (Q − S(y)). */
function depthAt(p: WallProfile, y: number, h: number, z: number): number {
  surfaceSide(p, y, SB);
  normalSide(p, y, SA);
  return SA.h * (h - SB.h) + SA.z * (z - SB.z);
}

// ═══════════════════════════════ distances across folds ═══════════════════════════════

const HH = new Float64Array(16);
const HZ = new Float64Array(16);

/**
 * Free-space distance in the side view between surface height ay at depth ad and ty at depth td: the
 * straight chord when it stays in front of the wall (across concave corners), else the taut string over
 * the convex fold edges in between (the upper hull of the endpoints and those edges).
 */
export function sideDistance(p: WallProfile, ay: number, ad: number, ty: number, td: number): number {
  offsetSide(p, ay, ad, SA);
  let h0 = SA.h;
  let z0 = SA.z;
  offsetSide(p, ty, td, SA);
  let h1 = SA.h;
  let z1 = SA.z;
  if (h1 < h0) {
    const th = h0;
    const tz = z0;
    h0 = h1;
    z0 = z1;
    h1 = th;
    z1 = tz;
  }
  // monotone chain (upper hull: the free side is +z)
  let m = 0;
  const push = (h: number, z: number): void => {
    while (m >= 2) {
      const oh = HH[m - 2];
      const oz = HZ[m - 2];
      const cr = (HH[m - 1] - oh) * (z - oz) - (HZ[m - 1] - oz) * (h - oh);
      if (cr >= 0) m--;
      else break;
    }
    HH[m] = h;
    HZ[m] = z;
    m++;
  };
  push(h0, z0);
  for (let i = 1; i < p.n && m < 15; i++) {
    if (!p.convex[i]) continue;
    const vh = p.bh[i];
    if (vh <= h0 || vh >= h1) continue;
    push(vh, p.bz[i]);
  }
  push(h1, z1);
  let d = 0;
  for (let k = 1; k < m; k++) {
    const dh = HH[k] - HH[k - 1];
    const dz = HZ[k] - HZ[k - 1];
    d += Math.sqrt(dh * dh + dz * dz);
  }
  return d;
}

/**
 * Reach scale k for a limb anchored at surface point (ax, ay) reaching for (tx, ty): the in-plane
 * vector the anatomy envelopes should judge is (target − anchor)·k. 1 on a flat stretch (no fold
 * between the two and the anchor's normal not turning), < 1 across a concave corner, > 1 around a
 * convex lip. Never below FOLD.minScale.
 */
export function reachScale(p: WallProfile | null, ax: number, ay: number, tx: number, ty: number): number {
  if (p === null || p.flat) return 1;
  const ia = panelIndexAt(p, ay);
  if (ia === panelIndexAt(p, ty)) {
    // same panel: only an anchor inside a fold band (turning normal) changes anything
    const lo = ia > 0 ? p.y0[ia] + p.blend[ia] : -Infinity;
    const hi = ia + 1 < p.n ? p.y0[ia + 1] - p.blend[ia + 1] : Infinity;
    if (ay >= lo && ay <= hi) return 1;
  }
  const dA = FOLD.anchorDepth;
  const dx = tx - ax;
  const dy = ty - ay;
  const side = sideDistance(p, ay, dA, ty, 0);
  const d3 = Math.sqrt(dx * dx + side * side);
  const flat = Math.sqrt(dx * dx + dy * dy + dA * dA);
  if (!(flat > 1e-9)) return 1;
  const k = d3 / flat;
  return k < FOLD.minScale ? FOLD.minScale : k;
}

/** 3D distance (m) between two surface points at the given depths, through free space (around lips). */
export function surfaceDistance3D(p: WallProfile, a: Vec2, aDepth: number, b: Vec2, bDepth: number): number {
  const side = sideDistance(p, a.y, aDepth, b.y, bDepth);
  const dx = b.x - a.x;
  return Math.sqrt(dx * dx + side * side);
}

// ═══════════════════════════════ geometry for the renderer / editor ═══════════════════════════════

/** One panel of the folded wall, ready to be built as a mesh. */
export interface PanelSpan {
  index: number;
  /** Surface y range [y0, y1). */
  y0: number;
  y1: number;
  angle: number;
  /** Wall-local 3D bottom-edge and top-edge heights / outs (x spans the wall width). */
  bottom: { y: number; z: number };
  top: { y: number; z: number };
  /** Outward unit normal (wall-local 3D, x = 0). */
  normal: { y: number; z: number };
}

/** The panels of a profile as mesh-ready spans over [0, length] (length = the boulder's height). */
export function panelSpans(p: WallProfile, length = p.length): PanelSpan[] {
  const out: PanelSpan[] = [];
  const end = Number.isFinite(length) ? length : p.y0[p.n - 1] + 5;
  for (let i = 0; i < p.n; i++) {
    const y0 = p.y0[i];
    const y1 = i + 1 < p.n ? Math.min(p.y0[i + 1], end) : end;
    if (y1 <= y0) break;
    const len = y1 - y0;
    out.push({
      index: i,
      y0,
      y1,
      angle: p.ang[i],
      bottom: { y: p.bh[i], z: p.bz[i] },
      top: { y: p.bh[i] + len * p.c[i], z: p.bz[i] + len * p.s[i] },
      normal: { y: -p.s[i], z: p.c[i] },
    });
  }
  return out;
}

/** World height (m) of the top of the wall (its surface end). */
export function wallTopHeight(p: WallProfile, length = p.length): number {
  return worldHeight(p, Number.isFinite(length) ? length : p.y0[p.n - 1]);
}

/** How far (m, horizontally) the top of the wall leans out over its base (overhang distance). */
export function wallOverhang(p: WallProfile, length = p.length): number {
  return offsetSide(p, Number.isFinite(length) ? length : p.y0[p.n - 1], 0, SA).z;
}

/** Surface length (m) a stack of [length, angle] panels needs, and the panels (y0, angle) it makes. */
export function panelsFromLengths(spec: readonly (readonly [len: number, angle: number])[]): { panels: WallPanel[]; length: number } {
  const panels: WallPanel[] = [];
  let y = 0;
  for (const [len, angle] of spec) {
    panels.push({ y0: Math.round(y * 1000) / 1000, angle });
    y += len;
  }
  return { panels, length: Math.round(y * 1000) / 1000 };
}

/**
 * Profile presets from docs/climbing-research.md §3.2 ([surface length m, angle°] per panel, bottom →
 * top). The editor (Phase C) and the generator draw on them.
 */
export const PROFILE_PRESETS = {
  SLAB: [[4.5, -8]],
  SLAB_STEEP: [[4.6, -15]],
  VERTICAL: [[4.5, 0]],
  GENTLE: [[0.3, 0], [4.3, 15]],
  OVERHANG_25: [[0.3, 0], [4.5, 25]],
  BOARD_40: [[0.37, 0], [3.66, 40]],
  STEEP_45: [[0.3, 0], [5.6, 45]],
  WAVE_20_40: [[0.3, 0], [2.2, 20], [2.8, 40]],
  KICK_30_60: [[0.3, 0], [2.0, 30], [3.0, 60]],
  CAVE: [[0.3, 0], [1.6, 30], [2.2, 85], [0.6, 20]],
  BULGE: [[1.6, 0], [1.2, 35], [1.8, -5]],
  LEAD_TOWER: [[2.5, 5], [4.5, 20], [5.5, 35], [2.0, 60], [3.0, 30]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

export type ProfilePresetId = keyof typeof PROFILE_PRESETS;

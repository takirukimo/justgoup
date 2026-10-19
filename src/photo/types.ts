// Photo → route (Phase E): shared data types of the importer. Pure data, no DOM.
//
// Coordinates: the PHOTO is the picked image (pixels, y down) after decoding and downscaling. The
// RECTIFIED image is the wall seen square on, after the 4-corner perspective correction (pixels, y down;
// u = x / width and v = y / height are its normalised coordinates, v = 0 at the top of the wall).

/** An RGBA image: ImageData-compatible, so canvas ImageData and plain buffers (tests, worker) both fit. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Pt {
  x: number;
  y: number;
}

/** The wall's four corners in the photo: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** CIELAB colour (D65). */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** What a detected region is. */
export type BlobKind = 'hold' | 'tape' | 'volume';

/** One detected region of the tapped colour, in rectified-image pixels. */
export interface PhotoBlob {
  /** Stable for one detection run only (re-detection renumbers). */
  id: number;
  kind: BlobKind;
  /** Centroid. */
  x: number;
  y: number;
  /** Pixel area (holes filled). */
  area: number;
  /** Full axis lengths of the equivalent ellipse (px). */
  major: number;
  minor: number;
  /** Major axis direction (radians, image coordinates: x right, y down). */
  theta: number;
  /** area / convex hull area. */
  solidity: number;
  /** Convex hull, flat [x0, y0, x1, y1, …] (px, pixel corners). */
  hull: number[];
  /** Fraction of the blob that was a filled hole (a pocket's dark mouth, a chalked or glossy patch). */
  holeFrac: number;
  /** The filled hole is clearly darker than the hold: a pocket. */
  pocket: boolean;
  /** 0..1: how well the region matches the colour (mean distance against the threshold). */
  conf: number;
  /** Added by hand (or by Claude) rather than found by the detector. */
  manual?: boolean;
}

/** Detector knobs. */
export interface DetectParams {
  /** 0..1 (UI sensitivity): maps onto the colour distance threshold. */
  sensitivity: number;
  /** Pixels per metre of the rectified image (sizes for the metric filters). */
  ppm: number;
}

export interface DetectResult {
  blobs: PhotoBlob[];
  /** Rectified-size mask: 1 = matching pixel after cleaning (for the overlay). */
  mask: Uint8Array;
  width: number;
  height: number;
  /** Colour distance threshold used (ΔE units). */
  threshold: number;
  ms: number;
}

/** A hold the user will get: a detected blob plus the importer's (or Claude's) reading of it. */
export interface PhotoHold {
  /** Rectified-image pixels. */
  x: number;
  y: number;
  /** Longest dimension (px) and the cross dimension (px). */
  major: number;
  minor: number;
  theta: number;
  solidity: number;
  pocket: boolean;
  kind: BlobKind;
  /** Outline (flat px pairs) for drawing / hit testing. */
  hull: number[];
  /** Overrides from Claude (or the user). */
  type?: import('../core/types').HoldType;
  shape?: import('../core/types').HoldShape;
  /** Size override: longest dimension in metres. */
  sizeM?: number;
  manual?: boolean;
  source?: 'cv' | 'claude' | 'user';
  /** False: the user (or the tape / volume default) left it out of the problem. */
  included?: boolean;
}

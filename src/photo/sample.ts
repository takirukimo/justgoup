// The claude.ai Artifact `sample` capability (docs/vendor/artifact-sample.d.ts), typed locally for the
// members the photo importer uses. Deliberately no global `Window` augmentation, so it never clashes with
// another module's typings. A page that passes images must declare `capabilities: {sample: {images: true}}`
// in its manifest; without it `limits()` reports no `images` and the importer hides "Enhance with Claude".

export type SampleErrorCode =
  | 'invalid_request'
  | 'prompt_too_large'
  | 'images_unavailable'
  | 'tools_unavailable'
  | 'image_rejected'
  | 'cancelled'
  | 'not_granted'
  | 'session_expired'
  | 'sampling_disabled'
  | 'not_declared'
  | 'rate_limited'
  | 'refused'
  | 'empty_completion'
  | 'invalid_json'
  | 'upstream_error'
  | 'capability_disabled'
  | 'capability_removed'
  | 'transform_error'
  | 'queue_overflow';

/** The one failure shape (a plain object, not an Error). */
export interface SampleError {
  code: SampleErrorCode | string;
  message: string;
  text?: string;
}

export interface SampleImageLimits {
  maxCount: number;
  maxInputBytes: number;
  mediaTypes: string[];
}

export interface SampleLimits {
  maxPromptBytes: number;
  images?: SampleImageLimits;
}

export interface SampleOptions {
  onText?: (u: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  images?: Blob | Blob[];
  modelTier?: 'default' | 'complex' | 'quick';
  cache?: boolean | { gcTime?: number; refresh?: boolean };
}

export interface SampleFn {
  (input: string, options?: SampleOptions): Promise<{ text: string; truncated: boolean }>;
  json<T = unknown>(input: string, options?: SampleOptions): Promise<T>;
  limits(): Promise<SampleLimits>;
}

export interface SampleAccess {
  sample: SampleFn;
  images: SampleImageLimits;
}

/**
 * The capability when this view can send images to Claude, else null (not inside a Claude viewer, the
 * artifact does not declare images, or the runtime is too old). Never throws. Inside a viewer it
 * resolves as soon as the runtime starts; framed by another host, `use()` gives up after about 10 s.
 */
export async function resolveSample(): Promise<SampleAccess | null> {
  try {
    const rt = (globalThis as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
    if (!rt || typeof rt.use !== 'function') return null;
    const s = (await rt.use('sample')) as SampleFn | null;
    if (!s || typeof s !== 'function' || typeof s.json !== 'function' || typeof s.limits !== 'function') return null;
    const lim = await s.limits().catch(() => null);
    if (!lim?.images || !(lim.images.maxCount >= 1)) return null;
    return { sample: s, images: lim.images };
  } catch {
    return null;
  }
}

/** Normalise anything a sample call rejected with into the SampleError shape. */
export function asSampleError(e: unknown): SampleError {
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
    const o = e as { code: string; message?: unknown; text?: unknown };
    return { code: o.code, message: typeof o.message === 'string' ? o.message : '', text: typeof o.text === 'string' ? o.text : undefined };
  }
  if (e instanceof DOMException && e.name === 'AbortError') return { code: 'cancelled', message: 'aborted' };
  return { code: 'upstream_error', message: e instanceof Error ? e.message : String(e) };
}

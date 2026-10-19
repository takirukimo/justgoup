// "Import from photo" entry point (Phase E). The importer lives in src/photo (another module):
//   openPhotoImport(opts: { root: HTMLElement; renderer: RendererAPI; ui: UIAPI }): Promise<BoulderDef | null>
// It is found through a build-time glob, so the editor builds and runs whether or not that module is
// in this build yet, and loads it lazily (its own chunk) the first time the setter asks for it.

import type { RendererAPI, UIAPI } from '../core/contracts';
import type { BoulderDef } from '../core/types';

export type OpenPhotoImport = (opts: { root: HTMLElement; renderer: RendererAPI; ui: UIAPI }) => Promise<BoulderDef | null>;

const loaders = import.meta.glob<{ openPhotoImport?: OpenPhotoImport }>('../photo/index.ts');

/** Is a photo importer part of this build? */
export function photoImportAvailable(): boolean {
  return Object.keys(loaders).length > 0;
}

/** The importer, or null when it is not in this build (or failed to load). */
export async function loadPhotoImport(): Promise<OpenPhotoImport | null> {
  const load = Object.values(loaders)[0];
  if (!load) return null;
  try {
    const m = await load();
    return typeof m.openPhotoImport === 'function' ? m.openPhotoImport : null;
  } catch {
    return null;
  }
}

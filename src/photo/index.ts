// Photo → route (Phase E). The editor's "Import from photo" action calls openPhotoImport and loads the
// returned problem as a draft (src/editor/photo.ts finds this module through a build-time glob).
//
// Local colour detection always runs (no network); inside claude.ai the importer also offers "Enhance
// with Claude" through the Artifact `sample` capability, which needs the page's manifest to declare
// `capabilities: {sample: {images: true}}`.

import type { RendererAPI, UIAPI } from '../core/contracts';
import type { BoulderDef } from '../core/types';
import { PhotoImporter } from './importer';

export interface PhotoImportOptions {
  root: HTMLElement;
  renderer: RendererAPI;
  ui: UIAPI;
  /** Optional: start with this image instead of asking for one (QA harness, drag & drop). */
  file?: Blob;
  /** Optional: hands the live importer to a QA harness. */
  onOpen?: (importer: PhotoImporter) => void;
}

/** Run the importer over `root`. Resolves the new problem, or null when the player backs out. */
export async function openPhotoImport(opts: PhotoImportOptions): Promise<BoulderDef | null> {
  const imp = new PhotoImporter(opts);
  const done = imp.open();
  opts.onOpen?.(imp);
  return done;
}

export type { PhotoImporter };

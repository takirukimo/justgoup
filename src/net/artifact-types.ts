// Minimal typings for the claude.ai Artifact runtime (`window.claude.use('db' | 'user')`), mirroring
// the platform's db.d.ts / user.d.ts / claude.d.ts contracts for the members this module uses.
// Deliberately local (no global `Window` augmentation) so it can never clash with other modules.

export type DbErrorCode =
  | 'invalid_argument'
  | 'resource_exhausted'
  | 'quota_exceeded'
  | 'unavailable'
  | 'revoked'
  | 'not_granted'
  | 'capability_disabled'
  | 'capability_removed'
  | 'transform_error';

export interface DbError {
  code: DbErrorCode | string;
  message: string;
}

export interface SnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface DocumentSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  metadata?: SnapshotMetadata;
}

export interface QuerySnapshot {
  docs: DocumentSnapshot[];
  size: number;
  empty: boolean;
}

export interface DocumentReference {
  id: string;
  path: string;
  get(): Promise<DocumentSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  collection(path: string): CollectionReference;
}

export interface Query {
  where(field: string, op: string, value: unknown): Query;
  orderBy(field: string, dir?: 'asc' | 'desc'): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnapshot>;
}

export interface CollectionReference extends Query {
  path: string;
  doc(id?: string): DocumentReference;
  add(data: Record<string, unknown>): Promise<DocumentReference>;
}

export interface ArtifactDB {
  doc(path: string): DocumentReference;
  collection(path: string): CollectionReference;
}

export interface ArtifactUser {
  id(): Promise<string | null>;
  can(capability: string): Promise<boolean | null>;
}

export interface ClaudeRuntime {
  use(name: 'db'): Promise<ArtifactDB | null>;
  use(name: 'user'): Promise<ArtifactUser | null>;
  use(name: string): Promise<unknown>;
}

/** The page's `window.claude`, if this page runs inside a claude.ai Artifact viewer. */
export function claudeRuntime(): ClaudeRuntime | null {
  try {
    const c = (globalThis as { claude?: unknown }).claude;
    if (c && typeof c === 'object' && typeof (c as { use?: unknown }).use === 'function') return c as ClaudeRuntime;
  } catch {
    /* ignore */
  }
  return null;
}

/** Extract a DbError code from anything a db call rejected with ('' when it isn't one). */
export function dbErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return '';
}

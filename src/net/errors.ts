// Backend error type shared by the Supabase and Artifact implementations and the fallback wrapper.

export type BackendErrorCode =
  | 'timeout' // request took longer than the budget
  | 'network' // fetch failed / offline / CSP blocked
  | 'http' // non-2xx response from the server
  | 'rate_limited' // too many writes, try later
  | 'invalid' // payload rejected (constraint, validation) — retrying cannot succeed
  | 'read_only' // this viewer cannot write shared data
  | 'quota' // storage cap reached
  | 'unavailable' // transient platform condition
  | 'terminal'; // backend gone for this page load (revoked, not granted)

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  /** True when the same call may succeed later (queue it). */
  readonly retryable: boolean;
  readonly status?: number;
  readonly detail?: string;

  constructor(message: string, code: BackendErrorCode, opts: { retryable?: boolean; status?: number; detail?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.retryable = opts.retryable ?? (code === 'timeout' || code === 'network' || code === 'rate_limited' || code === 'unavailable');
    this.status = opts.status;
    this.detail = opts.detail;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Whether a failed call should be queued for a later retry. Unknown errors count as transient. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof BackendError) return err.retryable;
  return true;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** A timer this late means the page itself was busy (boot, a long frame), not the other side. */
const STALL_MS = 200;
/** Extra turn granted after such a stall, so an answer already queued behind it gets processed. */
const GRACE_MS = 400;
const MAX_GRACES = 3;

/**
 * Call `onExpire` after `ms`, measuring the remote side's latency rather than this page's own
 * main-thread stalls: when the timer fires overdue (the page was blocked, e.g. building the scene
 * at boot on a slow phone), the reply may already be waiting in the task queue, so a short grace
 * period is granted first. Returns a cancel function.
 */
export function deadline(ms: number, onExpire: () => void): () => void {
  let due = Date.now() + ms;
  let graces = 0;
  let timer: ReturnType<typeof setTimeout>;
  const check = (): void => {
    if (Date.now() - due > STALL_MS && graces < MAX_GRACES) {
      graces++;
      due = Date.now() + GRACE_MS;
      timer = setTimeout(check, GRACE_MS);
      return;
    }
    onExpire();
  };
  timer = setTimeout(check, ms);
  return () => clearTimeout(timer);
}

/** Resolve `p`, or reject with a `timeout` BackendError after `ms` (see deadline()). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = deadline(ms, () => reject(new BackendError(`${what} timed out after ${ms} ms`, 'timeout')));
    p.then(
      (v) => {
        cancel();
        resolve(v);
      },
      (e: unknown) => {
        cancel();
        reject(e);
      },
    );
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

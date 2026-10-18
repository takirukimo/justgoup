// Backend configuration (global leaderboards + community problems).
//
// The game talks to Supabase through its PostgREST API (see supabase/README.md for the
// one-time project setup). Values come from the build environment first:
//
//   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY=<anon / publishable key>
//
// and fall back to the constant pair below, which is what a single-file build
// (claude.ai Artifact) uses. The anon/publishable key is public by design: every
// table is protected by row-level security, constraints and rate limits in
// supabase/schema.sql. NEVER put a service_role / secret key here.
//
// Leave both strings empty to run without Supabase (Artifact db or OFFLINE fallback).

// ┌──────────────────────── SUPABASE PROJECT ────────────────────────┐
// │ CHIRAL / justgoup project (eu-central-2). Publishable key only.  │
const FALLBACK_SUPABASE_URL = 'https://frgffdkpxmxrfcmazmnk.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_uCfF0NXWLgnVYSFjp4iawA_WoyMWLIP';
// └──────────────────────────────────────────────────────────────────┘

function envString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  try {
    return envString(import.meta.env?.[name]);
  } catch {
    return '';
  }
}

/** Project URL without a trailing slash, e.g. `https://abcd1234.supabase.co`. '' = not configured. */
export const SUPABASE_URL: string = (readEnv('VITE_SUPABASE_URL') || FALLBACK_SUPABASE_URL.trim()).replace(/\/+$/, '');

/** Public anon (legacy JWT) or publishable (`sb_publishable_…`) key. '' = not configured. */
export const SUPABASE_ANON_KEY: string = readEnv('VITE_SUPABASE_ANON_KEY') || FALLBACK_SUPABASE_ANON_KEY.trim();

/** True when both values are present and the URL is a plausible http(s) origin. */
export function isSupabaseConfigured(url: string = SUPABASE_URL, key: string = SUPABASE_ANON_KEY): boolean {
  if (!url || !key) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Timeouts (ms) used by the backend selection and REST calls. */
export const BACKEND_TIMEOUTS = {
  /** Supabase health check at startup. */
  health: 2500,
  /** `window.claude.use('db')` race at startup. */
  artifactUse: 3000,
  /** Every REST / db call at runtime. */
  request: 6000,
} as const;

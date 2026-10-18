# JUST GO UP: Supabase setup

Supabase hosts the **GLOBAL** leaderboards (`scores`) and the community problems (`problems`).
Without it, the game falls back to the claude.ai Artifact db (**CLAUDE SHARED**) or to
localStorage (**OFFLINE**), so this setup is optional.

## Setup in 5 steps

1. **Create a project.** Go to [supabase.com](https://supabase.com) → *New project*. The free tier is enough.
2. **Install the schema.** In the dashboard, open *SQL Editor* → *New query*, paste all of
   [`schema.sql`](./schema.sql) and click *Run*. The script is idempotent, so you can run it again after
   pulling changes.
3. **Copy the public credentials.** Under *Project Settings → API Keys* (or *Data API*), copy the
   **Project URL** (`https://<ref>.supabase.co`) and the **anon** or **publishable** (`sb_publishable_…`) key.
   Never use the `service_role` or secret key in the game.
4. **Configure the game.** Pick one:
   - Environment (dev server and multi-file builds): create `.env.local` in the repo root:
     ```
     VITE_SUPABASE_URL=https://<ref>.supabase.co
     VITE_SUPABASE_ANON_KEY=<anon or publishable key>
     ```
   - Constants (single-file / Artifact builds): paste both values into the marked pair at the top of
     [`src/config/backend.ts`](../src/config/backend.ts) (`FALLBACK_SUPABASE_URL`, `FALLBACK_SUPABASE_ANON_KEY`).

   Then rebuild (`npm run build` or `npm run build:single`).
5. **Verify.**
   ```sh
   curl "https://<ref>.supabase.co/rest/v1/scores?select=id&limit=1" \
     -H "apikey: <key>" -H "Authorization: Bearer <key>"
   ```
   This should return `[]`, not an error. In the game, the title screen badge should read **GLOBAL**.
   Add `?backend=local` (or `artifact`) to the URL to force another backend while testing.

## What the schema enforces

| | `scores` | `problems` |
|---|---|---|
| anon can | `SELECT`, `INSERT` | `SELECT`, `INSERT` |
| anon cannot | `UPDATE`, `DELETE`, set `created_at` | `UPDATE`, `DELETE`, set `created_at` / `plays` / `sends` |
| checks | name 2–16 allowed chars, mode ∈ boulder/rope/daily, score 0–5,000,000, sends 0–10,000, max_grade 0–12, head ∈ the 9 heads, `daily_key` = `YYYY-MM-DD` exactly for daily runs (today ±1 day, or up to 14 days late) | name 1–32, author 2–16, grade 0–12, wall_angle −15…45, `data` is a JSON object with a `holds` array and < 60,000 bytes |
| rate limit | 30 inserts / minute per player name (case-insensitive), HTTP 429 | 10 inserts / hour per author name, HTTP 429 |

The RPCs are `SECURITY DEFINER` with a fixed `search_path`, and anon may execute them:

- `score_rank(p_mode text, p_score int, p_daily_key text)` returns the 1-based rank on that board.
  Ties share the better rank.
- `record_attempt(p_problem_id uuid, p_sent boolean)` adds one play, plus one send when `p_sent` is true.

## Notes

- **Retries are idempotent.** The client generates row ids (uuid), so when it re-sends a write from its
  offline outbox after a timeout, the duplicate is detected (409) instead of being stored twice.
- **Moderation.** Delete a bad row in *Table Editor* (you are the owner there, so RLS does not apply), or run
  `delete from public.scores where player = '…';` in the SQL Editor.
- **claude.ai Artifacts.** The Artifact sandbox may block requests to outside domains. In that case the
  health check fails quickly and the game uses the Artifact db instead, with no configuration change.

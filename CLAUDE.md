# STEIBOCK by CHIRAL SPORTS

A handheld, portrait 3D climbing game: bouldering, lead with clipping, a daily problem, a boulder editor,
community problems, photo-to-route, a global leaderboard and animal-head skins. The player moves each
limb (2 hands, 2 feet, plus the hips) on a CHIRAL SPORTS wall. Steini the ibex is the instructor.

Stack:
- TypeScript (strict) with three.js 0.186.1, Vite 8 and vitest.
- playwright-core for headless QA.
- A Capacitor 8 iOS shell in `ios/`.

The repo and package are still called `justgoup`, and storage keys use the `jgu.*` prefix. That is
legacy naming; never rename them, because existing players' saves would be orphaned.

## Read first

| File | What it is |
|---|---|
| `docs/HANDOFF.md` | Current status, backup branches, what is in progress, what comes next |
| `docs/ROADMAP.md` | The owner's decisions (DECIDED) and the items to ASK FIRST |
| `docs/climbing-research.md` | The physics and route-setting research; `tuning.ts` and `src/game` cite it as §x.y |
| `docs/IOS.md` | Running the native app on an iPhone with Xcode |
| `ARCHITECTURE.md` | Module ownership and rules |

`ARCHITECTURE.md` is partly stale. It still says "JUST GO UP", signal orange, 9 heads and a global pump
meter. `src/config/brand.ts`, `src/config/tuning.ts` and the ROADMAP decisions are current.

## Owner rules

- **Name and brand:**
  - The game is STEIBOCK, shown as "STEIBOCK by CHIRAL SPORTS". The gym is "CHIRAL SPORTS" (no "HQ").
  - CHIRAL pink `#D54051` is the accent everywhere.
  - Brand art comes only from the official paths in `assets/brand/` (via `BRAND` / `drawMark` /
    `drawWordmark` / `drawLockup`). No third-party logos.
  - No CHIRAL SPORTS lettering on the climbing wall itself. A subtle tone-on-tone mark is fine.
- **Start screen:** the key art `assets/art/steibock-key-art.webp`, with only the mark, STEIBOCK · BY
  CHIRAL SPORTS and TAP TO START.
- **Ask first:** ask the owner before starting the CHIRAL training board or mountain / real-rock mode.
  Never import MoonBoard or Kilter data.
- **Backups:** before big changes, back up the current version as a `backup/*` branch. Never rewrite or
  delete existing `backup/*` branches.
- **Keys:** only the Supabase publishable (anon) key may appear in client code. Never a `service_role`
  or secret key.
- **Supabase in QA:** automated browsers (`navigator.webdriver`) always use the local backend. Never
  point QA at the real Supabase boards. `?backend=supabase` is opt-in.

## Commands

```sh
npm install                 # Node 22+
npm run dev                 # Vite dev server (DEBUG on: window.__jgu, ?ts=, ?q=)
npm run typecheck           # tsc --noEmit (src only; dev/*.ts is not typechecked)
npm test                    # vitest over src/**/*.test.ts; slow (src/game tests take 30-120 s each)
npx vitest run src/game/solver.test.ts -t "<name>"   # prefer single files
npm run build               # dist/ (web hosting + iOS webDir)
npm run build:single && node scripts/artifact.mjs    # dist-single/artifact.html for claude.ai
npm run ios:sync            # build + copy into ios/ (run after web changes), then Run in Xcode
npm run ios:open            # open ios/App/App.xcodeproj
npm run ios:assets          # re-render the app icon + launch splash
```

CI (`.github/workflows/deploy.yml`) runs the typecheck, `vitest run src/net src/input src/editor
src/tutorial` and the build, then deploys `dist/` to GitHub Pages. Pages has to be enabled with
*Source: GitHub Actions*.

### Headless QA (Playwright)

- **Browser:** the scripts launch the browser at `CHROMIUM_PATH`. The default is
  `/opt/pw-browsers/chromium`, the cloud container's path. On a Mac, use:
  `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/...`.
  `dev/character.proxies.mjs`, `dev/world.probe.mjs` and `dev/editor.shots.mjs` hard-code the path.
- **Speed:** they force SwiftShader WebGL (slow, a few fps), so they pass `?ts=2..6` and `?q=low`, use
  long timeouts and judge pacing in game time.
- **Dev server:** the long scripts expect a no-reload server, which you restart after edits:
  `VITE_CACHE_DIR=node_modules/.vite-integration npx vite --config dev/e2e.vite.config.mjs --port 5207 --strictPort`.
  Give every parallel Vite server its own `VITE_CACHE_DIR`.

| Script | Checks |
|---|---|
| `scripts/e2e.mjs [base] [--only onboarding,sendtrain,leaderboard,locker,human,settings,pure,profile,community,editor,daily,communityplay,lead]` | the full player run |
| `scripts/soak.mjs` | leaks |
| `scripts/lifecycle-check.mjs` | mobile lifecycle |
| `scripts/home-check.mjs` | title backdrop |
| `scripts/input-check.mjs` | `dev/input.html` |
| `scripts/audio-check.mjs` | audio |
| `scripts/sandbox-check.mjs` | claude.ai artifact sandbox |
| `scripts/shot.mjs <url> <out.png>` | one screenshot |

- **Harness pages:**
  - `dev/world.html`: the gym and wall. Params: `mode, seed, grade, cam, style, profiles, view=px,py,pz,lx,ly,lz,fov, hud=0, env=0`. Screenshot with `dev/world.shot.mjs`.
  - `dev/character.html?view=heads|tees|guide|game|tech|limits|grip`
  - `dev/sim.html` (2D sim lab)
  - `dev/ui.html?screen=<id>`
  - `dev/editor.html`, `dev/photo.html`, `dev/cues.html`, `dev/input.html`, `dev/tutorial.html`
- Debug-only flags, active under `vite dev` or with `?debug=1`:
  - `window.__jgu` (app, renderer, sim, ui, audio, …)
  - `?ts=` (time scale, 0.25-8)
  - `?q=low|medium|high`
- Flags that work in every build: `?backend=local|artifact|supabase|auto` and `?pure=1`.

## Layout

| Path | What lives there |
|---|---|
| `src/core/` | **Contracts.** `types.ts` (all data types), `contracts.ts` (every module interface: ClimberSimAPI, RendererAPI, UIAPI, LimbControlsAPI, AudioAPI, BackendAPI, EditorAPI, …), `events.ts` (typed `bus`, AppEvents), `rng.ts` (seeded mulberry32), `math.ts` |
| `src/config/` | `brand.ts` (BRAND, PALETTE, WALL, FONTS), `skins.ts` (10 heads incl. human, colourways, chalks, unlocks), `tuning.ts` (BODY skeleton, GAME, SIM physics, GEN flags), `backend.ts` (Supabase URL + publishable key, timeouts) |
| `src/game/` | **The sim.** Pure TS: no DOM, no three.js. `climber-sim.ts` (deterministic 120 Hz PBD body), `statics.ts` (force/torque balance), `anatomy.ts` (reach envelopes), `holds.ts` (grip capacity, contact frames), `forearm.ts` (pump), `wall-profile.ts` (folded walls), `archetypes.ts` + `generator.ts` (procedural problems, every one verified by the planner), `solver.ts` (A* beta planner, hints, grades), `bot.ts`, `rope.ts`, `scoring.ts`, `grades.ts`, `dmath.ts` (deterministic trig) |
| `src/render/` | **3D.** `renderer.ts` (GameRenderer), `wall-frame.ts` (wall-local ↔ world), `wall.ts`, `holds.ts` (procedural holds/volumes), `grip.ts` (hands/feet on hold geometry), `climber.ts` (skinned BodyRig, joint-limited IK, self-collision, ClimberModel), `heads/*`, `guide.ts` (Steini), `rope-mesh.ts`, `camera.ts`, `environment.ts` (gym, sign, pads, banners), `textures.ts` + `glyphs.ts`, `shading.ts` + `curvature.ts` (thin-hold shading), `post.ts`, `quality.ts`, `fx.ts`, `highlights.ts`, `contact-shadows.ts`, `portrait.ts` |
| `src/app/` | **Flow.** `app.ts` (state machine), `session.ts` (one climb), `driver.ts` (sim events → feedback), `runs.ts` (Send Train, Lead, Daily, Community, Test), `gen*.ts` (generation in a worker), `title-scene.ts`, `tutorial-run.ts`, `progress.ts`, `quality.ts`, `overlays.ts`, `lifecycle.ts` |
| `src/ui/` | **DOM UI.** `ui.ts` (GameUI), `screens/*` (splash, title, modes, hud, preview, pause, results, leaderboard, locker, settings, community, profile, name), `styles.css` (the whole design system, scoped `.jgu-ui`), `logo.ts`, `parts.ts`, `dom.ts` (text-only el()) |
| `src/input/` | `limb-controls.ts` (drag handles, reach envelope, dyno/chalk/shake gestures), `pure.ts` (Pure-mode flag), release/velocity/homography helpers |
| `src/audio/` | Procedural Web Audio (no files): sfx, music, ambience, per-head voices, exertion director, haptics via `navigator.vibrate` |
| `src/tutorial/` | Steini's intro and tutorial director, script (all lines + pacing), overlay, tips |
| `src/net/` | `backend.ts`: picks Supabase REST, then claude.ai Artifact db, then localStorage, behind an outbox and fallback. Also `supabase.ts`, `artifact.ts`, `local.ts`, `validate.ts` (all remote rows are untrusted), `profile.ts` (`jgu.profile.v1`), `names.ts`, `ghosts.ts` |
| `src/editor/` | Boulder editor: model (worker-safe), wall types and presets, catalog, analyzer worker, overlay, panel, photo entry |
| `src/photo/` | Photo-to-route: rectification, Lab colour, CV detector, route builder, the "Enhance with Claude" vision step (only inside claude.ai, `sample` capability), importer UI |
| `src/native/native.ts` | Capacitor-only glue: Taptic haptics, status bar, launch splash. Game code never imports Capacitor. |
| `supabase/schema.sql` | RLS, CHECKs, rate-limit triggers, RPCs. No migration runner: re-run it by hand in the SQL editor |
| `ios/` | Xcode project (SPM). `App/App/public` and the generated config are gitignored; run `npm run ios:sync` |

## Invariants: don't break these

- **Coordinates:** gameplay uses wall-local 2D metres (x right, y up, origin at bottom centre, floor
  level).
  - On folded walls, y is the distance **along** the surface. Convert only through `wall-profile.ts` /
    `WallFrame`.
  - `HoldDef.angle` is in radians. Wall and panel angles are in degrees (+ overhang, − slab, 90 roof).
- **Contracts are additive only:** never change or remove a signature in `src/core/contracts.ts` or a
  shared type.
- **Module boundaries:** modules talk only through contracts, constructor parameters and the typed `bus`.
  A new cross-module event goes in `AppEvents`.
- **`src/game` is pure:** no DOM, no three.js, no imports from render/ui/app.
- **Determinism:** generation is bit-identical on every device. It uses only `dmath.ts` + arithmetic +
  `Math.sqrt`, and `generator.test.ts` stubs `Math.sin` and friends to enforce that.
  - Planner budgets are node counts, never wall-clock.
  - Every generated problem must pass `planBetaDetailed`.
- **Shared tables:**
  - `anatomy.ts` is the single reach table, and `BODY` in `tuning.ts` is the single skeleton, for both
    sim and render.
  - `src/game/holds.ts` contact insets mirror the drawn hold profiles in `src/render/holds.ts`. Change
    the pairs together.
- **Owner decisions in tuning:** no chalk wear in boulder modes (`SIM.sweatBoulder` = 0); lead keeps it.
  `GEN.profiles` and `GEN.holdsOnVolumes` ship on.
- **Perf budget in gameplay:** ≤150 draw calls, ≤250k triangles, textures ≤2048², no per-frame
  allocations in hot loops.
  - The body is one skinned mesh / one draw call (+ harness); heads are about 3 calls each.
  - Fixed light count, so shader programs stay stable.
- **Frame order:** `app.frame` → `renderer.frame` → `app.postFrame`.
  - Sim time is stepped in ≤0.1 s chunks.
  - Session beats wait on `Timeline` (game time), never on `setTimeout`.
- **Audio:** Web Audio starts only from `unlock()` inside a user gesture (iOS).
- **Backend:**
  - `createBackend()` never throws and falls back to local within about 3 s.
  - Supabase writes may use only the columns and RPCs granted in `schema.sql`; `schema.test.ts` checks
    this.
  - Writes are idempotent through client-minted ids.
- **iOS splash:** `native.ts` watches the `#boot` element in `index.html` and its first-frame
  `opacity: 0`, so keep both.

## Gotchas

- **Shared sim state:** `ClimberSim.getState()` returns one object that is mutated every step. Copy what
  you keep.
- **Drag before start:** `beginDrag` is refused while the phase is `idle`, so call `start()` first.
- **Generation runs in a worker:** problems are generated in a Web Worker, so mutating `GEN` on the main
  thread doesn't reach it.
- **Drawn holds can be offset:** near convex lips a drawn hold can sit off the sim's hold
  (`foldClampY`). Use `HoldSet.holds` / `HoldInfo.dy` for drawn positions.
- **Headless quality:** headless runs detect `low` quality on SwiftShader (no post-processing). Pass
  `?debug=1&q=high` for representative real-game shots.
- **Node tests of render pieces:** tests that build `ClimberModel`, `GuideModel` or heads must import
  `dev/character-stub` first.
- **Timing-sensitive tests:** `solver.test.ts` has CPU-time guards, and generator variety tests can
  flake on a busy machine. Rerun single files before concluding something broke.
- **Scratch tests:** agent scratch tests (`src/**/zz-*.test.ts`, `src/**/__*.test.ts`,
  `dev/**/*.debug*.test.ts`) are gitignored.

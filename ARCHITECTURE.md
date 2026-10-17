# JUST GO UP — architecture & design spec

A premium, handheld (portrait, touch-first) 3D bouldering game. The player controls each of the
climber's four limbs separately and solves randomized problems on a **CHIRAL**-branded gym wall
(CHIRAL Sports is the owner's brand). The climber is a human body with an **animal head**: the
default is an Alpine ibex. **Steini the Ibex** is the guide who runs the intro and tutorial.

Stack: TypeScript (strict) + Three.js 0.186 + Vite 8. No other runtime deps. Everything is
procedural: geometry, textures (canvas), audio (WebAudio), so the whole game can ship as one HTML file.

- `npm run dev` runs the dev server. `npm run build` → `dist/` (hosting). `npm run build:single` → `dist-single/index.html` (one file, published as a claude.ai Artifact).
- `npm test` runs vitest (headless sim/generator/scoring tests).

---

## 1. Art direction: "alpine technical"

The references are Arc'teryx-style outdoor technical apparel design and a premium indoor bouldering gym.
**Do not use any real third-party logo, wordmark or product name.** Only CHIRAL branding (src/config/brand.ts) is allowed.

- **Mood.** Quiet confidence. A dark, matte, minimal look, with precise engineering details. Think product spec sheets, topo maps, hairline rules, generous negative space, one hot signal colour (`#FF4F1F`) used sparingly.
- **Palette.** See `PALETTE` in `src/config/brand.ts`: basalt/graphite/slate darks, bone/chalk whites, signal orange, glacier blue. Route holds use `ROUTE_COLORS`.
- **Type.** Display: *Barlow Condensed* 600–800, UPPERCASE, wide tracking (0.08–0.2em). UI: *Inter*. Data/labels: *JetBrains Mono*, tiny uppercase labels above big numbers (spec-sheet style). Fallback stacks are in `FONTS`.
- **UI surfaces.** Dark translucent panels (`rgba(13,14,16,.72)` + `backdrop-filter: blur(18px) saturate(1.2)`), 1px hairline borders `rgba(255,255,255,.08)`, radius 14–20px, subtle inner highlight. Buttons are big (≥ 52px tall), use clear verbs, and give a tactile press (scale .97 plus a highlight). Topographic contour-line SVG patterns serve as subtle backgrounds. Motion is quick and springy (180–320ms, `cubic-bezier(.2,.8,.2,1)`). Respect `prefers-reduced-motion` and the reducedMotion setting.
- **3D scene.** A moody gym interior. The CHIRAL wall is charcoal plywood panels with a T-nut grid, panel seams, chalk smudges near holds, and a huge tone-on-tone CHIRAL wordmark plus logo mark on the panels. Above it are black ceiling trusses with warm linear lights. Around it sit thick charcoal crash pads with orange CHIRAL stripes. Neighbouring wall sections at other angles carry other colourful routes and big geometric volumes (some signal-orange or bone with the logo mark), and atmospheric haze adds depth.
- **Lighting.** Use ACES/AgX tone mapping, a PMREM environment (RoomEnvironment), a warm key spot from above (soft shadows on the wall), a cool fill and rim light on the climber, plus subtle bloom, vignette and film grain. Holds read clearly: route holds are saturated and slightly glossy, deco holds are dimmer.
- **Character.** A stylized, soft-shaded human climber (vinyl-figure proportions, about 1.75 m) in technical climbing apparel: a fitted tee or crew with seam lines, tapered pants with cuffs, aggressive downturned climbing shoes, a chalk bag on the hip, and a harness plus belay loop in rope mode. The animal head is the hero: the ibex has huge back-curving ridged horns, a short beard, amber eyes and ears. Heads are listed in `HEADS` in `src/config/skins.ts`; colourways are in `COLORWAYS`.

## 2. Core mechanic: four limbs, balance, pump

All gameplay is in **wall-local 2D meters** (`src/core/types.ts`). The 3D view is a projection of it.

**Controls (portrait touch):**
- Four big circular **limb handles** (LH, RH, LF, RF) float over the climber's hands and feet. Drag a handle and that limb lets go, then follows your finger. A grab offset keeps the finger from covering the target, and the target is clamped to the limb's reach. The reach boundary arc is drawn on the wall. Reachable holds glow softly. The **snap candidate** under the reticle gets a ring coloured by predicted grip quality (red → amber → green).
- Release over a hold to **grab** it. Releasing a foot on blank wall **smears** (weak friction). Releasing a hand on blank wall returns the hand to its previous hold.
- A **hip handle** at the pelvis lets the player shift weight: drag it to pull the hips toward the finger, within the reach constraints.
- Handles repel each other in screen space so they never overlap. Each has a leader line to its real limb, and handles are at least 56px.

**Body model (src/game/climber-sim.ts).** A 2D spring/PBD skeleton with pelvis and chest nodes (spine length fixed). Shoulders and hips are offset perpendicular to the spine. Limbs are constraints: arms are ropes (max length), legs are springs (rest ≈ 85% of legMax) and can push, with hard min and max lengths. Gravity acts on the CoM, and its in-plane component scales with the wall angle. Each frame the body relaxes toward equilibrium with damping, so it sways naturally when a limb lets go and swings during falls.

**Loads and stress.** Limb force magnitudes from the solve give `load` as a fraction of bodyweight. `capacity` = hold grip × pull-angle quality × limb factor × wall-angle factor:
- Hand capacity per type: jug .75, edge .55, pinch .45, pocket .45, crimp .38, sloper .32, volume .3, foot chip .05. Size scales capacity by ±15%.
- Angle quality compares the hold's `angle` (its good direction) with the direction from the hold to the limb's anchor. Each type has a tolerance cone (jug wide, sloper narrow). Feet want the body above them.
- Feet carry most of the weight when the CoM is above them. On overhangs feet carry less (and cutting feet is possible); on slabs feet carry more.

**Tension, shaking, pump and falling.**
- `tension` = worst limb stress, plus a balance penalty (CoM outside the support base horizontally), plus a barn-door penalty (contacts nearly collinear vertically with the CoM off to one side), plus an overstretch penalty.
- Tension > ~0.7 starts shaking: the per-limb tremor shows as "Elvis leg" on overloaded feet and as body shake. The camera shakes slightly and haptics pulse.
- `pump` rises slowly over time, faster with tension and when hanging on bad holds or campusing. It recovers slowly in a good rest (tension < 0.4, on jugs). **Pump = 1 means a fall.** This makes taking too long or sitting in a bad position deadly.
- A limb with stress > ~1.3 for > 0.5 s **slips**. With no hands left on (or fewer than 2 contacts) the climber **falls**.
- **Send:** match both hands on the `top` hold for `GAME.topHold` seconds.

**Rope mode (Lead Tower, 15 m).** Quickdraws sit on the wall. To clip, drag a free hand onto the next quickdraw and release. The hand is then busy for `GAME.clipTime` while the other three limbs hold you, and the rope clips in. The rope runs from the belayer (an ibex NPC at the base) through the clipped draws to the harness. A fall above the last clip goes 2 × (height above clip) + slack. The climber is caught and swings, loses a life, and respawns on holds near the last clip. Falling before the first clip, or a fall that would reach the floor, is a ground fall and ends the run. Clipping the anchor at the top tops the route.

**Modes.**
- **Send Train** (endless boulders). Randomized problems of rising grade. Each send scores grade points × streak multiplier, plus flash and speed bonuses. The first fall ends the run, and the score goes to the global leaderboard (`boulder`).
- **Lead Tower** (rope). Score = height + clips + top bonus − falls. Leaderboard `rope`.
- **Daily Boulder.** One seeded problem per UTC day, the same for everyone. Score is based on time and flash. Leaderboard `daily` keyed by date.
- **Community.** Problems made in the editor by players, playable by anyone, with attempts and sends tracked.
- **Tutorial.** Steini teaches the controls on a hand-authored problem.
- **Editor test.** Climb your own problem. Sending it unlocks Publish.

**Route reading.** Every climb starts in `preview`: the camera pulls back to show the whole problem, start holds are marked "START" and the top hold "TOP", and the player taps to start. During a climb, an overview toggle shows the whole route again.

## 3. Module map & ownership

| Path | Owner | What |
|---|---|---|
| `src/core/*` | foundation | types, contracts, math, rng, event bus. **Shared, read-only for module builders.** |
| `src/config/*` | foundation | brand tokens, skins, tuning (sim builder may tune values in `tuning.ts`). |
| `src/game/*` | SIM | climber-sim, generator, solver (beta/hints/grade), scoring, rope system, grades + tests. Pure TS, no DOM/three. |
| `src/render/*` (except climber/heads/rope/guide) | WORLD | renderer (implements `RendererAPI`), gym environment, wall + textures, holds, volumes, quickdraws, camera rig, fx, post-processing, quality scaling. |
| `src/render/climber.ts`, `src/render/heads/*`, `src/render/rope-mesh.ts`, `src/render/guide.ts`, `src/render/materials.ts` | CHARACTER | climber model + IK posing from `ClimberState`, 9 animal heads, colourways, harness, chalk bag, rope mesh, Steini guide NPC. |
| `src/ui/*` | UI | screens (implements `UIAPI`), HUD, design-system CSS, guide speech bubble, icons. |
| `src/input/*` | INPUT | `LimbControlsAPI`: touch/mouse limb handles, hip handle, reticle, reach arc, highlights. |
| `src/audio/*` | AUDIO | `AudioAPI`: procedural WebAudio sfx, breathing/heartbeat layer, generative ambient music, haptics. |
| `src/tutorial/*` | TUTORIAL | `runIntro`, `runTutorial`: Steini's scripted lines + step logic. |
| `src/net/*`, `supabase/*` | NET | `BackendAPI` (Supabase REST → Artifact db → localStorage fallback), profile persistence + unlock evaluation. |
| `src/editor/*` | EDITOR | `EditorAPI`: problem editor with its own DOM panel + touch placement on the wall. |
| `src/app/*`, `src/main.ts` | INTEGRATION | app state machine, game sessions (sim stepping, scoring, run flow), wiring everything. |

**Rules for module builders:**
1. Implement exactly the interfaces in `src/core/contracts.ts`. If you need more, add *optional* members to your own implementation. Never break a shared signature.
2. Communicate across modules only through constructor parameters, the contracts, and the typed `bus` (`src/core/events.ts`).
3. Every module exports a factory or class that the integrator can construct with no hidden globals. The factory signatures are in §4.
4. Stay inside your own files. To typecheck only your area, run `npx tsc --noEmit -p . 2>&1 | grep -E "src/(game)/"` (substitute your directory).
5. Performance budget (mid-range phone, 60fps): ≤ 150 draw calls in gameplay, ≤ 250k triangles, no per-frame allocations in hot loops where avoidable, and textures ≤ 2048².
6. Quality bar: production-grade, premium, polished. No placeholder art, no TODO stubs, no lorem ipsum.

## 4. Factory signatures (what the integrator imports)

```ts
// src/game
import { ClimberSim } from './game/climber-sim';                 // new ClimberSim(boulder, opts?: SimOptions) implements ClimberSimAPI
import { generateBoulder, generateRopeRoute, tutorialBoulder, dailyBoulder, todayKey, TUTORIAL_SEQUENCE } from './game/generator';
// TUTORIAL_SEQUENCE: { limb: LimbId; holdId: string; teach: 'hand'|'foot'|'hips'|'shake'|'match' }[] — scripted moves on tutorialBoulder()
import { planBeta, nextHint, estimateGrade } from './game/solver';
import { scoreSend, parTime, runGradeFor, scoreRope } from './game/scoring';
import { RopeSystem } from './game/rope';                         // new RopeSystem(boulder)
import { gradeLabel, fontGrade } from './game/grades';
// src/render
import { GameRenderer } from './render/renderer';                // new GameRenderer(canvas) implements RendererAPI
// src/input
import { LimbControls } from './input/limb-controls';            // new LimbControls(overlayEl, renderer) implements LimbControlsAPI
// src/ui
import { GameUI } from './ui/ui';                                 // new GameUI() implements UIAPI ; ui.mount(#ui)
// src/audio
import { GameAudio } from './audio/audio';                        // new GameAudio() implements AudioAPI
// src/tutorial
import { runIntro, runTutorial } from './tutorial/tutorial';
import { TIPS, randomTip } from './tutorial/tips';                  // Steini's climbing tips (string[])
// src/net
import { createBackend } from './net/backend';                    // Promise<BackendAPI>
import { loadProfile, saveProfile, evaluateUnlocks } from './net/profile';
// src/editor
import { BoulderEditor } from './editor/editor';                  // new BoulderEditor(rootEl, renderer, ui) implements EditorAPI
```

`evaluateUnlocks(profile): { kind; id; name }[]` returns newly unlocked items and mutates `profile.unlocked`.
`scoreRope(p: { heightM: number; clips: number; topped: boolean; falls: number; grade: number }): number`.

## 5. DOM layout

```
#app (portrait container; phone-shaped on desktop)
 ├─ canvas#gl        — Three.js
 ├─ div#controls     — LimbControls overlay (pointer events only while climbing)
 └─ div#ui           — GameUI screens (pointer-events:none on the root; each interactive element re-enables)
```
Safe areas: use `env(safe-area-inset-*)`. Design for a 390×844 viewport first, and make sure it also works from 360×740 up to 430×932.

## 6. Backend

Selection order at runtime: **Supabase** if `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are configured (or `src/config/backend.ts`) and a health check passes. Otherwise **Artifact db** if `window.claude?.use('db')` resolves (inside claude.ai). Otherwise **local** (localStorage, clearly labelled OFFLINE).
Supabase tables are `scores` and `problems`, created with RLS by `supabase/schema.sql`. Inserts are rate-limited and sanity-checked by constraints. Play and send counters go through a `record_attempt` RPC (security definer).
Artifact db collections: `scores/{id}`, `problems/{id}`, `problems_stats/{problemId}`.

# STEIBOCK — roadmap (v0.2 → v1)

This is the owner's feedback on the v0.1 playtest (2026-10-18), turned into a plan. Decisions
already made by the owner are marked **DECIDED**. Ask before starting anything marked **ASK FIRST**.

Backups: branch `backup/v0.1-playtest` (exactly the build that was played, with a standalone
`backups/just-go-up-v0.1-playtest.html`) and branch `backup/2026-10-18-latest`.

## Decisions

- **Name — DECIDED:** **STEIBOCK** (Swiss German for ibex). Shown as "STEIBOCK by CHIRAL SPORTS". The
  repo stays `justgoup`.
- **Brand colour — DECIDED:** CHIRAL pink `#D54051` replaces signal orange everywhere: UI accents, wall
  stripes, crash pads, tees and highlights. Keep near-black and bone/white neutrals.
- **Logo — DECIDED:** use the official assets in `assets/brand/`:
  - `chiral-mark.svg`: the two-swoosh mark. It reads like a pair of ibex horns.
  - `chiral-wordmark.svg`: CHIRAL SPORTS as outlined paths.
  - The lockup is mark + wordmark with the spacing from `chiral-lockup-livetext.svg`. That file uses
    the Articulat CF font as live text, so never render it directly; rebuild the lockup from the two
    outlined files.
  - `chiral-sports-logo.pdf` has the black, white, pink and outline variants.
- **Apparel — DECIDED** (references in `assets/reference/`):
  - Black tee: small white mark centred on the chest. On the back, CHIRAL SPORTS in white runs
    vertically down the spine (letters rotated 90°, reading top to bottom).
  - White tee: pink mark on the chest, and the same vertical CHIRAL SPORTS on the back in pink.
  - Pink tee: white mark and white back text (owner's request).
  - Cap: black, with CHIRAL SPORTS embroidered in white on the front.
  - Steini (instructor): a CHIRAL SPORTS tee plus "INSTRUCTOR" (small, on the back under the wordmark
    or on the sleeve/chest).
  - Chalk bag: carries the CHIRAL mark.
- **Gym, sign and wall — DECIDED (2026-10-19):** the gym is called CHIRAL SPORTS (no "HQ"). The
  backlit sign is the official lockup lit in CHIRAL pink. The climbing wall itself carries no CHIRAL
  SPORTS lettering; a subtle tone-on-tone mark is fine. Pads and banners keep the wordmark.
- **Start screen — DECIDED (2026-10-19):** the owner's key art (`assets/art/steibock-key-art.webp`,
  a climber in the black CHIRAL SPORTS tee) full-bleed, with only the CHIRAL mark, STEIBOCK · BY
  CHIRAL SPORTS and TAP TO START.
- **Imports — DECIDED:** photo-to-route first. **ASK FIRST** before building the CHIRAL training board
  (our own steep board in the spirit of MoonBoard/Kilter). Do not import MoonBoard/Kilter data: it is
  proprietary and has no public API.
- **Mountain / real-rock mode — ASK FIRST:** only after everything else is done. Come back with a plan
  before starting.

## Phase A — Brand, characters, bugs the owner saw

A1. **Brand rollout.**
- New name and lockup on the splash, title, intro, results, favicon/app icon and manifest.
- Pink palette.
- Branding on the wall, pads and volumes with the new mark.
- Tees, chalk bag, cap and the instructor tee as above.
- Colourways become CHIRAL tee variants: black, white, pink, and a few tasteful seasonal ones.

A2. **Ibex remodel.** Match `assets/reference/ibex-reference.png`:
- Dark brown/grey-brown coat with a lighter belly and muzzle.
- Long, thick horns rising from the top of the skull and sweeping back in a big arc, with prominent
  transverse ridges (knobs) on the front face, tapering to the tips.
- Small amber eyes set at the sides, a short beard, ears angled sideways.
- A natural, not cartoony, look. The other heads get the same quality pass.

A3. **New skin: a plain human** (no animal head) wearing the black CHIRAL SPORTS cap. Pick a neutral
skin and hair style.

A4. **Per-head voices.** Effort sounds, grunts and the guide blips follow the equipped head: ibex
bleat, marmot whistle/chirp, eagle screech, lynx/snow-leopard chuff, goat bleat, ram grunt, vulture
hiss, and a human exhale/grunt.

A5. **Exhaustion audio.** Less frequent and more varied. Heavy breathing only on genuinely exhausting
or bad moves, with cooldowns. No looping grunt spam.

A6. **Home screen.**
- The climber hangs steady up on the wall, mid-route, holding a good position (no shaking, no
  lunging on the floor).
- Steini stands on the mats looking up at him, in the INSTRUCTOR tee.
- Slow cinematic camera.

A7. **Smoothness.**
- Intro text pacing: cards stay long enough to read, roughly 220 ms per word with a minimum of 2.5 s.
- No jerky animations: blend every pose change and camera cut.
- Fix legs going into the floor (landed and standing poses, the guide).

A8. **Anatomy verification in real play.** No limb through a limb, the torso, head/horns or the floor,
and no arm crossing that a body can't do. Check against the screenshots in the v0.1 feedback (leg
folded into the chest, arm wrapped behind the head).

## Phase B — Climbing depth (realistic, research-based)

Read `docs/climbing-research.md` first; it is the reference for every number below.

B1. **Wall profiles.** Walls are no longer one flat plane. A wall is a vertical stack of panels, each
with its own angle:
- Profiles: kicker → slab → vertical → overhang → roof/cave (up to ~80–90°), plus corners/dihedrals
  and arêtes where feasible.
- The sim stays 2D in "wall surface" coordinates (y = distance along the surface). Gravity's in-plane
  and out-of-plane components follow the panel angle under the body, so footholds lose effectiveness
  as the wall steepens. Roofs need hooks and body tension.
- The renderer folds the panels in 3D.
- Generated problems pick a profile by style.
- The daily problem and the preview label must describe the real wall ("SLAB −8°", "OVERHANG 35°",
  "CAVE").

B2. **Techniques as real moves:**
- Heel hooks and toe hooks (pull with the foot, needed on steep walls).
- Flagging: a leg out with no hold, for counterbalance.
- Drop knee.
- Foot swaps and foot matching.
- Deadpoints and dynos: a timed flick throws the body; there is a catch window, and missing it falls.
- Mantle top-outs for problems that finish on top of the wall.
- Shake-out: hang straight-armed on a good hold and shake out one arm to recover pump.
- Strong players can still brute-force: campusing and big moves are possible but cost pump fast.

B3. **Chalk and grip.**
- A per-hand grip/friction value ("sweat") fades with time on the wall and with the number of hand
  moves.
  - On lead it fades steadily over a route.
  - In bouldering it fades only after many hand moves or a long time.
- **Chalk-up action:** take one hand off and dip it into the chalk bag (about 1 s, during which the
  other three limbs hold you). This restores that hand's friction, with a chalk puff.
- Bad friction lowers capacity on slopers and crimps most, and on jugs least.

B4. **Hold variety.** Many clearly different shapes per type, with sizes from micro to macro:
- jugs, buckets, horns, edges, rails, crimps, micros, slopers, pinches, pockets (1–3 finger), foot
  chips, screw-ons
- dual-tex holds, macros, wood holds
- volumes with holds mounted on them

Holds keep readable silhouettes and distinct materials.

B5. **Route variety.** Problems aren't always straight up:
- traverses, zigzags, rising diagonals
- dyno problems, compression problems on volumes
- slab balance problems, cave problems
- comp-style coordination moves

Lead Tower gets varied profiles (a vertical start with overhanging headwalls, roofs, cruxes) and
varied hold sets.

## Phase C — Editor

- Wall type presets (slab / vertical / overhang / cave / mixed profile, editable per panel).
- Many volume shapes: pyramids, wedges, half-domes, dual-tex, ridges. Holds can be placed on volumes.
- Hold palette with visually distinct icons and real previews.
- Fix the wall angle change clipping through the neighbouring wall: the neighbours must move or fold
  so the main wall never intersects them.

## Phase D — "Pure" mode (setting, all modes)

- No HUD, no stress rings, no hints and no route-reading overlays.
- The climber's body is the feedback: breathing, shaking, forearm flex, chalky hands, slipping
  fingers, and the voice.
- Limb handles stay invisible until a finger lands near a hand or foot. Then only a faint ring
  appears.
- A shading method that highlights even sliver-thin usable holds near the climber without "yellow
  paint": curvature/rim-light emphasis plus a subtle specular glint on positive edges within reach.
- The default HUD stays exactly as is. Pure mode is opt-in.

## Phase E — Photo to route

- Upload or take a photo of a real boulder problem, then tap the problem's hold colour.
- The game detects the holds of that colour, estimates their positions on a standard wall, guesses
  type and size from the blob shape, and lets you mark start and top. Then you play it or remix it in
  the editor.
- Inside claude.ai, use Claude vision through the Artifact `sample` capability (images). On the web
  build, use an in-browser colour-segmentation detector.

## Later — ASK FIRST

- CHIRAL training board.
- Mountain / real-rock mode (longer sends, multi-pitch).

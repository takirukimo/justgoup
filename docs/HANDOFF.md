# STEIBOCK: handoff (cloud session → your Mac)

Snapshot of where the project stands, so work can continue in a Claude Code session on the owner's
Mac. Read `CLAUDE.md` first for how the code is laid out and how to run things. `docs/ROADMAP.md` has
the owner's decisions; `docs/IOS.md` covers running the app on an iPhone.

## Versions and backups

All of these are branches on GitHub (`takirukimo/justgoup`), never rewritten:

| Branch | What it is |
|---|---|
| `backup/v0.1-playtest` | the first playtest build, exactly as published as the first claude.ai artifact (also `backups/just-go-up-v0.1-playtest.html` on that branch) |
| `backup/2026-10-18-latest` | end of day 1: anatomy limits, self-collision, before the v0.1 feedback round |
| `backup/v0.2-phone-link` | **v0.2**, the build published to the claude.ai artifact link the owner plays on the phone: STEIBOCK rebrand, CHIRAL pink, new ibex, human + cap, wall profiles, chalk, dynos, foot techniques |
| `backup/v0.2-ios-app` | **v0.2 + editor upgrades + Pure mode + photo-to-route + the native iPhone app**, verified green (`tsc`, 410/410 unit tests, build). The safest branch to put on a phone with Xcode today |
| `main` | current work. While the v0.3 round runs it can be mid-change; take a backup branch for a phone build until v0.3 is pushed |

To try an old version: `git switch backup/v0.2-phone-link && npm install && npm run dev`, then
`npm run ios:sync` for the phone. Switch back with `git switch main`.

## Continue this conversation locally

The cloud session can be pulled into the terminal on the Mac, with its full history:

```sh
git clone https://github.com/takirukimo/justgoup.git
cd justgoup
claude --teleport            # pick the STEIBOCK session, or pass its session id
```

On claude.ai/code the session menu has **Open in → Terminal**, which copies the exact command.
Requirements:
- Run it from a clone of this repo, not a fork.
- The working tree must be clean; teleport offers to stash.
- Log in to Claude Code with the same claude.ai account (`/login`).

Teleport is one-way. The terminal gets its own copy of the conversation, and from then on the cloud
and local sessions diverge. Only git carries work between them. Don't let both sessions push to `main`
at the same time: let the cloud round finish and push first, or stop it.

`claude remote-control`, or `/remote-control` inside a session, lets the Claude app on the phone drive
a session that runs on the Mac. That combines with Xcode and an attached iPhone.

## Done since v0.2 (on `main`)

- **Gym and sign:** the gym is CHIRAL SPORTS (no "HQ"). The sign is lit in CHIRAL pink and no longer
  flickers. The flicker was z-fighting: the logo plane sat exactly on its box's front face.
- **Wall:** no CHIRAL SPORTS lettering on the climbing wall.
- **Start screen:** the owner's key art, with only the mark, STEIBOCK · BY CHIRAL SPORTS and TAP TO
  START.
- **iPhone app:** the native app in `ios/` (see `docs/IOS.md`).

## Where v0.3 stands (the owner's v0.2 feedback)

Being built when this was written; the items land on `main` as they finish:

- **Sticky contact:** hands and feet sit on the real hold geometry, not slapped on or floating.
  Contact points have normals and grip directions, and there are grab animations.
- **High feet:** feet above the hip when balance allows. Edging high steps, heel and toe hooks, hips
  in, strain.
- **Advanced moves (owner request):** heel-toe cam, bat hang, figure 4. Each has sim, poses, gestures
  and HUD.
- **Legs and harness:** natural splays, leg loops, belay loop, tie-in, rope running off the body.
- **Steini:** always the white instructor tee; in the tutorial he stands on the far side from the
  start and teleports instead of zooming across the wall.
- **After a fall:** TRY AGAIN (same problem) or NEW RUN. Lead and generated problems were always new
  before.
- **Settings → Start over:** wipes the profile to replay the intro and tutorial from scratch.
- **Chalk:** no chalk-up in bouldering (no sweat decay there). The chalk bag stays as gear; lead keeps
  chalking.
- **Pure mode:** a Settings toggle that covers all modes, checked again.
- **Lead and sim polish:** themed lead hold sets, hold clearance at convex folds, the planner matching
  the live body, the deadpoint preview agreeing with flight.
- **Photo import:** finish and polish the flow.
- **QA:** full end-to-end and build checks.

When v0.3 is done: publish it to the same claude.ai artifact link (capabilities `db`, `user`,
`sample: {images: true}`), and the iPhone app picks it up with `git pull && npm run ios:sync`.

## Next: v0.4 moves (owner asked for "any other moves you can think of")

The plan, after v0.3:

- **Knee bar:** a no-hands rest in roofs and caves; forearms recover.
- **Back-step / hip turn:** outside edge, hip to the wall, longer reach on steep walls.
- **Bicycle:** toe hook plus toe push on the same hold, for roofs.
- **Palming and compression:** pushing on slabs and volumes, squeezing opposing volumes.
- **Rose move and cross-through:** controlled crossed-arm moves. The anatomy currently blocks
  crossings, so these need explicit, legal versions.
- **Cut loose and campus:** feet swing off on overhangs, then core control to re-catch them.
- **Hand-foot match and rock-over.**
- **Lock-off and iron cross:** strength moves that pump faster.
- **Mantle top-out.**
- **Later:** stemming and bridging need corner (dihedral) walls, which the wall model doesn't have yet.

## Ask the owner first

- CHIRAL training board (our own steep board; never import MoonBoard/Kilter data).
- Mountain / real-rock mode: only after everything else, with a plan first.

## Housekeeping

- The Supabase project (CHIRAL org) holds the global leaderboard and community problems. A test score
  "Steini 1234" is still in `scores`; delete it when convenient.
- Only the publishable key is in the client (`src/config/backend.ts`). Never put a `service_role` or
  secret key in client code.

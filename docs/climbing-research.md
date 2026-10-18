# STEIBOCK climbing research reference

This is the source of truth for Phase B–E of `docs/ROADMAP.md`. It merges three research reports
(biomechanics; walls, holds and setting; feedback and photo import), checked against the code at
`2c55f06`.

**Tags:** [M] measured · [S] standard, rule or manufacturer spec · [C] coaching consensus ·
[D] derived (physics or a fit; a model) · [H] heuristic or design estimate · (?) uncertain.
`[n]` points to §7. Angles are degrees past vertical (− slab, + overhang). Loads are in body weight
(BW). MVC is the maximum force a hand can produce on that hold.

---

## 1. Summary of key facts

1. **Wall angle moves load from the feet to the hands.** On good holds the hands carry 0.1–0.4 BW at
   vertical [M 1,3]. Each 5° steeper moves 0.05–0.10 BW to the hands [M 1]. A 10° overhang means
   hands +47 % and feet −34 % [M 3]. On steep walls the feet stay on only by toe-pull or hooks.
2. **Our out-of-plane model is right.** `statics.ts` already implements the physics
   (`Nh = (d·cosθ + sinθ·(y_com − y_feet))/lever`, `Nf = Nh − sinθ`) [D].
3. **Finger strength sets the grade.** One-hand MVC on a 20–23 mm edge runs from 0.45–0.55 BW
   (beginner) to 0.9–1.05 BW (V9–11) [M 23,24]. A 10 mm edge gives 0.65–0.75× a 20 mm edge [M 22].
   Full crimp gives no strength bonus [M 21] but about 36× the A2 pulley load [M 30].
4. **Pump is per forearm and has a threshold.** Below the critical force (CF ≈ 41 % MVC with
   releases [M 45]) climbing is near-sustainable; above it, a W′ reserve drains. A pumped hand
   bottoms out at 50–65 % of fresh force [M 49]. Recovery half-time is 8–16 s (elite) to 60–90 s
   (recreational) [M 50].
5. **Chalk matters, but modestly:** about +20 % friction on rock [M 55], hangs 28 % longer [M 27].
   Slopers are the most friction-sensitive. In IFSC lead, about 1 reach in 5 includes a chalk dip
   [M 40].
6. **Dynos:** the catch comes just before the apex, finger force peaks at 1.1–1.6 BW, and the feet
   push about 1.8× the hands at launch [M 37]. A 0.5 m rise means about 0.3 s with no hands on [D].
7. **Walls and setting:** boulders ≤4.5 m; IFSC boulder −5° to 45°; lead ≥15 m at 15–60° (about
   30° average) [S 64,65]. Hard board problems are mostly V8 moves plus 1–2 crux moves [M 95]. Lead:
   first bolt ≤3.1 m, ≤1 m apart up to 5 m [S 64,102].
8. **No-HUD feedback works only if cues are graded and consistent.** Cairn was criticised for
   opacity [121,125], so give one sanctioned way to learn the grip model.
9. **Biggest mismatches in our sim** (§6):
    - one global pump, not per forearm;
    - pumps out too fast near CF and in a true dead hang;
    - capacity barely depends on edge depth;
    - generated walls stop at 40° (boulder) and 20° (lead);
    - bolts too sparse low on the route;
    - `noHandsGrace` 0.28 s is shorter than dyno airtime;
    - steep-wall hand load about 0.07 BW below the band.

---

## 2. Biomechanics

### 2.1 Load sharing

**Measured data [M]**

| Study | Finding |
|---|---|
| Bonelli 2024 [1]: 1 hand + 2 feet, +5° slab / 0° / 5° overhang | Bent arm: hand 0.02 / 0.10 / 0.20 BW. Straight arm: 0.34 / 0.39 / 0.44 BW. |
| Bonelli 2025 [2] | Straight arms add 23–32 % BW to the hand but spare the elbow flexors; finger-flexor activity is *higher* |
| Noé 2001 [3,4] (abstract) | 10° overhang vs vertical: feet −34 %, hands +47 % |
| Baláš 2014 [4] | Foot load changes about 1 %/° between 85° and 98°; intermediates load their feet 26 % more than novices |
| Quaine & Martin 1999 [5] | One foot off: vertical force spreads over the other 3 contacts; horizontal force goes to the diagonal pair |
| Pandurevic 2020 [6] | Hand:foot ratio < 1 when efficient; it rises as the CoM moves off the wall |

**Planar model [D]** (this is what `statics.ts` implements)

- **Symbols.** θ is the wall angle, d the distance of the CoM from the wall, L the hand–foot
  distance, and s the CoM height as a fraction of L, measured from the feet.
- **Hands pull in:** `Az = W·(s·sinθ + (d/L)·cosθ)`.
- **Feet push:** `Bz = W·((d/L)·cosθ − (1−s)·sinθ)`. Bz < 0 means the feet must toe-pull or hook.
- **Feet cut** when `tanθ > d/((1−s)L)`. With L = 1.3 m and s = 0.55 that is about 23° with the hips
  in (d = 0.25 m) and about 34° with the hips out (d = 0.40 m).
- **Hips in** (small d) lowers the hand pull-in and foot pressure alike, so steep walls need
  toe-pull (body tension).

**Reference band vs our sim**

The reference band is [D], anchored to [1,3]; the steep values are extrapolated. The sim columns
come from a scratch `ClimberSim` probe: hands on jugs at 2.0 m, feet 1.25 m lower and 0.4–0.5 m
apart, settled for 3 s.

| Wall | Both hands, reference (BW) | Sim, jug feet | Sim, edge feet | Verdict |
|---|---|---|---|---|
| −10° slab | 0.05–0.25 | 0.09 | 0.13 | OK |
| 0° | 0.25–0.40 | 0.14 | 0.44 | Bimodal; probably the posture search picks different hip depths (?) |
| 15° | 0.45–0.60 | 0.42 | 0.46 | Low edge of the band |
| 30° | 0.55–0.70 | 0.47 | 0.50 | 0.05–0.08 low |
| 45° | 0.65–0.80 | 0.58 | 0.59 | 0.06–0.07 low |
| 60° | (≈0.75–0.9, extrapolated) | 0.61 | 0.62 | Low; the feet still carry 0.3 BW |
| Roof, no hook / with hook | 0.95–1.0 / 0.55–0.70 | — | — | No roofs or hooks in the sim yet |

Loads are vector magnitudes, including the keep-in pull, so hands + feet can exceed 1.

### 2.2 Balance, flagging, drop knee

- **Barn-door** is a torque about the line through the contacts; the opposite foot cancels it
  [M 2]. The sim's `barn` term is the right concept.
- **Flagging [C 7,8,9]** moves the CoM back across the contact line. Use an inside flag for a low
  foothold, an outside flag for a high one, and a back flag on overhangs with both hands to one
  side. On overhangs the flag also presses on the wall.
- **Drop knee [C 11,12]:** hip internal rotation turns the hip into the wall, so d and Az fall. Hip
  range of motion is IR ≈42°, ER ≈44°, flexion ≈128°, abduction ≈33° [M 13]. Twisting under load
  risks the meniscus, so render knee and foot pointing the same way.

### 2.3 Feet

- **Rubber μ:** ≈0.68 on granite, ≈1.14 on plastic holds (tilt test, low load); brands differ by only
  about 6.5° [M 14]. Softer is not reliably grippier [M 15]. The limit is along-wall load ≤ μ·N.
- **Smear vs edge [C 16,17].** Smear with the heel low and hips out, mostly below vertical. Edge
  with the shoe aligned to the edge, perpendicular on micros. At vertical N ≈ 0.2–0.3 W, so smears
  hold 0.15–0.3 W [D]. The sim gives about 0.15 BW per foot there: consistent.
- **Heel hook:** the hamstrings pull the hips in. On a roof it takes the feet's share, up to
  (1−s)·W ≈ 0.45 W [D]. No force measurement exists (?). High heel hooks plus a reaching arm injure
  the proximal hamstring [M 18].
- **Toe hook / bicycle:** ankle dorsiflexion pull; the only foot "pull" on roofs [C]. No numbers.
- **High step:** standing 23 cm from the wall, the toe reaches 97.3 ± 8.8 cm for a leg length of
  91.5 ± 4.3 cm, i.e. hip height −0.15 to +0.22 m (mean +0.06 m) with hips in [M 19]. This
  correlates with grade (r = 0.65) [M 20]. A rock-over with hips out reaches about +0.35 m [D].

### 2.4 Hands and grips

**One-hand MVC on a 20–23 mm edge, by level** [M 23,24; bands D]

| Level | One hand (BW) | Supporting data |
|---|---|---|
| Beginner (≤V2) | 0.45–0.55 | ≈6a climbers: 0.54 [23] |
| V3–V5 | 0.55–0.70 | Lattice V1–4: +19 kg two-hand [24] |
| V6–V8 | 0.75–0.90 | ≈7c+ sport: 0.81; V5–7: +24 kg [23,24] |
| V9–V11 | 0.90–1.05 | ≈7C boulder: 0.94; V8–11: +38 kg [23,24] |
| Elite | 1.05–1.3 | V12+: +53 kg two-hand [24] |

Other anchors: elite four-finger maximum ≈420 N, the same open and crimped [M 21]; 351–576 N over
1–4 cm edges [M 22]; 33–57 % BW actually used per hold on an easy treadwall [M 28].

**Grip multipliers relative to a 20 mm half crimp (= 1.0)**

| Grip | Multiplier | Tag | Note |
|---|---|---|---|
| 10 mm edge | 0.65–0.75 | M 22 | |
| 40 mm edge | ≈1.15 | M 22 | |
| Jug / bucket | 1.3–1.6 | D | Cap the one-arm hang at the arm and shoulder limit |
| Full crimp | 1.0 | M 21,30 | No bonus; add a pulley-strain counter |
| Sloper, slope ≤20–30° | ≈0.9 | M 29 | 3–4 cm holds drop past 30° of slope; 1–2 cm holds past 20° |
| Sloper, slope 40° | 0.55–0.75 | M 29 | Steeper drop on shallow holds |
| Pocket, 3 fingers | 0.75–0.85 | D/U | Middle finger carries the most load; ring finger in 3-finger grips [32] |
| Pocket, 2 fingers | 0.5–0.6 | D/U | |
| Mono | 0.25–0.35 | D/U | |
| Pinch | 0.5–0.8 | U | Pinch strength correlates r = 0.48 with grade [M 23] |

**Effective sloper slope [D]** = lip angle + wall angle + pull deviation; apply the [29] curve to it.
This is why slopers die on steep walls, and it can replace `overhangLoss` for slopers.

**Direction holds [C 33,34]:** an undercling works best at waist to chest height with high feet; a
gaston (thumb down, push out) and a sidepull need lean-off or an opposing foot.

### 2.5 Reach, dynos, impossible moves

- **Body:** arm span ≈ stature × 1.00–1.04, higher in climbers [M 35]. Standing overhead grip reach
  ≈ 1.22 × stature; fingertips add about 0.11 m [M 36].
- **Dynos [M 37,38]:** successful climbers jump higher than needed and grab while still rising.
  Grabbing nearer the apex raises the finger force peak (1.1–1.63 BW; measured in a two-hand dyno,
  probably the total on the catch hold (?)). On a 15° wall, aiming past the hold worked best.
- **Timing [D]:** the CoM spends `2√(2Δh/g)` within Δh of the apex: 90 / 128 / 202 ms for
  1 / 2 / 5 cm. Rising h takes `√(2h/g)`: 0.20 / 0.32 / 0.45 s for 0.2 / 0.5 / 1.0 m.
- **Distances:** the record is 2.85 m on a 20° wall [M 39]; recreational 0.4–0.8 m, strong 1.0–1.5 m
  [D]. IFSC median grab reach 0.43–0.47 s, 91 % ≤1 s [M 40]. Campus readiness: V4+ to V7–8
  [C 41,42].
- **Impossible [M 43,44; D]:** shoulder flexion 180°, extension ≈60°, horizontal adduction 110–140°,
  so a crossover ends at about the opposite shoulder line. No hand behind the head while facing the
  wall. A foot well above the hip needs hips out or a hook. A hand below the feet only in mantles.

### 2.6 Fatigue and pump

**Data [M]**

| Quantity | Value | Src |
|---|---|---|
| CF (intermittent) / W′ | 41.0 ± 6.2 % MVC / 30,882 N·s (≈30 MVC·s normalised, D (?)) | [45] |
| CF and grade | CF/body mass explains 61 % of sport grade, 26 % of boulder grade | [46] |
| Continuous 60 % MVC | 48–66 s; intermittent 8:2 s lasts 25–102 % longer | Baláš 2016 (URL not captured) |
| 40 % MVC, 5:2 s | 853 s (climbers) vs 420 s (sedentary) | [48] |
| 80 % MVC, 5:5 s | fails at ≈3 min (elite) / 1.5 min (non-climbers); force plateaus at 63 % / 50 % MVC | [49] |
| Two-hand dead hang, 25 mm | 6.5 / 23 / 42 / 59 s (non / low / intermediate / advanced) | [26] |
| Occlusion at ≈64 % MVC | 51.5 % (strong) to 75.5 % (weak) | [47] |
| Reoxygenation half-time | 7–16 s elite; 47–83 s intermediate; 30–97 s controls | [50] |
| Shake beside the body | +32 % reoxygenation, +22 % time to failure | Baláš 2016 |
| Lactate | still elevated more than 20 min after a route | [51] |
| Work:rest; contact per hold | lead 6.3:1.5 s, boulder 7.9:0.6 s; 5.6–8.0 s per hold | [53,40] |
| IFSC lead; boulder attempt | ≈4 min and ≈30 hand moves; 27–39 s | [40] |
| Heart rate | 74–85 % of max, higher on steeper walls | [54] |

**Recommended pump model [D]** (fitted so that it reproduces every [M] anchor above)

For each hand, take `f = load / MVC_hold`.

```
release-aware CF:  CF = 0.41, k = 1.0       while the hand has been on this hold < 8 s
sustained CF:      CF = 0.30, k = 1.8       after 8 s on the same hold without release (occlusion)
drain:             W′ -= k·(f − CF)·dt       when f > CF   (W′₀ ≈ 30 MVC·s)
recover:           W′ → W′₀ with half-time t½(level), ×1.3 when shaking out beside the body
capacity:          × (1 − 0.4·(1 − W′/W′₀))  → floor 0.6 (measured 0.50–0.65)
```

The fit reproduces (the first 8 s of each hold use the intermittent values):
- **Dead hang** (load 0.5 BW per hand): low-grade climber (MVC 0.5) ≈ 28 s; intermediate (0.65)
  ≈ 40 s; advanced (0.85) ≈ 63 s. Measured: 23 / 42 / 59 s.
- **Continuous 60 % MVC:** ≈ 61 s (measured 48–66 s).
- **Intermittent 80 % MVC (5 s on / 5 s off):** about 2.5–3 min, depending on recovery in the off
  phases (measured 1.5–3 min).
- **Intermittent 40 % MVC:** below CF, so near-sustainable (measured 7–14 min). Add a baseline creep
  of about 1/(10–14 min) to cap it.

Add a slow residual pump on lead that decays over more than 10 min [D, from 51].

### 2.7 Chalk, sweat, friction

- **Chalk on rock:** +18.7 % friction on limestone, +21.6 % on sandstone [M 55]; hand–rock μ ≈
  0.64–0.74 [M 56].
- **Conflict (?):** chalk lowered μ in [M 57]; μ was unchanged but hangs lasted 28 % longer (49 → 63 s)
  in [M 27]; chalk helps dry fingers more than wet ones and makes friction consistent [M 58].
  *Resolution:* model chalk as a moisture and consistency reset, at most ×1.2.
- **Moisture:** skin friction is bell-shaped over moisture (very dry is bad too), and μ falls as
  normal force rises [M 59]. Humidity above 70 % wets holds within a couple of attempts [C 60].
  Temperature effects conflict (?) [61]: leave them out.
- **Re-chalk:** 19.5 % of IFSC lead reaches include chalking, most taking more than 5 s [M 40].
  Boulderers chalk before each 30–40 s attempt [C].
- **Sensitivity [D]:** sloper 1.0, edge/crimp/pinch ≈0.6, pocket ≈0.4, jug ≈0.2.
- **Visible strain [C 62,63]:** Elvis leg (drop the heel to stop it), chicken-winging elbows,
  heavier breathing, re-gripping (crimp opens to open hand), hips sagging off the wall.

---

## 3. Wall, holds, route setting

### 3.1 Walls (standards and specs)

| Item | Value | Tag / source |
|---|---|---|
| Boulder wall height | at most 4.5 m (4.0 m if people can stand on top) | S [64]; IFSC 4.5 m to the TOP sign [65] |
| IFSC boulder | 30 m wide for 10 boulders (about 3 m each); 4–5 profiles from −5° to 45°; uniform, low-friction panels | S [65] |
| Mats | about 0.40 m thick; 1.5 m at the sides, 2.5 m behind | S [65,66] |
| IFSC lead wall | at least 15 m high; 3–3.75 m per lane; 15°–60°; 8–9 m total overhang (about 30° on average, about 17 m of surface) | S [65], D |
| Walltopia modules | 0°–60° in 5° steps, plus −3°; 4.5 × 1.5 m. Two-angle modules: 15/35, 20/40, 20/50, 25/45, 30/60. 21 mm birch plywood, **32 T-nuts/m²** | S [68] |
| Adjustable board | 15°–70° (Walltopia); Kilter 0–70° | S [69,109] |
| Kicker | 0.3 m (Walltopia drawing (?)); MoonBoard 370 mm; Kilter 1–3 ft | S [68,70,110] |
| MoonBoard | 11 × 18 grid at about 20 cm pitch, 2.44 m wide, 25° or 40°, 3.17 m tall at 40° | S [70,107], D |
| Surface length | height / cos(angle): 4.5 m tall at 40° → about 5.9 m of panel | D |

**Profile vocabulary [C 67,71]**
- Slab −3° to −20°; vertical; gentle overhang 5–20°; steep 25–45°; roof/cave 60–90°.
- Dihedral (inside corner), arête (outside corner), prow (overhanging arête), bulge, lip/top-out.

### 3.2 Profile presets [H]

Panels are `[surface length m, angle°]`. A boulder is at most 4.5 m tall and 3 m wide per lane.

| Preset | Panels | Label |
|---|---|---|
| SLAB | [4.5, −8] | SLAB −8° |
| SLAB_STEEP | [4.6, −15] | SLAB −15° |
| VERTICAL | [4.5, 0] | VERTICAL |
| GENTLE | [0.3, 0] [4.3, 15] | OVERHANG 15° |
| OVERHANG_25 | [0.3, 0] [4.5, 25] | OVERHANG 25° |
| BOARD_40 | [0.37, 0] [3.66, 40] | BOARD 40° |
| STEEP_45 | [0.3, 0] [5.6, 45] | OVERHANG 45° |
| WAVE_20_40 | [0.3, 0] [2.2, 20] [2.8, 40] | WAVE 20/40 |
| KICK_30_60 | [0.3, 0] [2.0, 30] [3.0, 60] | STEEP 30/60 |
| CAVE | [0.3, 0] [1.6, 30] [2.2, 85] [0.6, 20] | CAVE (ends in a mantle lip) |
| BULGE | [1.6, 0] [1.2, 35] [1.8, −5] | BULGE |
| TOPOUT_VERT | [4.0, 0] + horizontal platform | TOP-OUT |
| Lead tower | [2.5, 5] [4.5, 20] [5.5, 35] [2.0, 60] [3.0, 30] | 14.8 m tall, 8.1 m overhang, 17.5 m of surface (D) |
| Training board | one panel, 0–70° in 5° steps | — |

Corners and arêtes, where feasible: a second plane at ±45–90° yaw sharing a panel edge. Sim y is
the distance along the surface, so a 15 m tall lead wall at a 30° average needs about 17.5 m of
surface; check what `GAME.ropeWall.height` means once panels exist [D].

### 3.3 Hold catalogue

**Size rings** (Trango's cross-brand scale, longest dimension) [S 72]

| Ring | 1 XXS | 2 XS | 3 S | 4 M | 5 L | 6–7 XL–XXL | 8–9 XXXL+ |
|---|---|---|---|---|---|---|---|
| mm | <50 | 50–80 | 80–130 | 130–210 | 210–340 | 340–890 | >890 |
| Use [H] | chips, micros | crimps, small pockets | edges, mini-jugs, pinches | jugs, slopers, rails | buckets, horns | macros | volumes |

**Real dimensions (w × h × standoff):** jug 11.4 × 7.6 × 5.7 cm [74]; crimp 7.6 × 5 × **1.3** cm
[75]; XXL crescent 19.7 × 12.7 × 10 cm [76]; wide pinch 7–7.6 cm [77]; macros 39 × 39 × 8 up to
100 × 100 × 30 cm [78,79]; hangboard edges 45 / **20 (benchmark)** / 10 mm, micros 4–14 mm [81,82].

**Type defaults [H, calibrated to S]**

Grip = the §2.4 multiplier. Pull cones stay as in the code (§6.3).

| Type | Rings | Edge depth / feature | Grip | Notes |
|---|---|---|---|---|
| bucket | 4–5 | 50–80 mm, closed lip | 1.5 | Two hands |
| jug | 3–4 | 35–60 mm | 1.35 | |
| horn | 3–4 | post | 1.2 | Very wide cone (wrap or pinch) |
| rail | 5–6 | 15–30 mm | 0.9–1.1 | Can be shuffled along |
| edge | 2–3 | 20–35 mm | 1.0–1.1 | |
| crimp | 2 | 10–20 mm | 0.7–1.0 | |
| micro | 1 | 4–10 mm | 0.45–0.7 | |
| sloper | 3–5 | lip −20° to −40° | Amca curve | Most friction-sensitive |
| pinch | 3–4 | 4–12 cm wide | 0.5–0.8 | Narrow or tapered is harder |
| pocket 1/2/3 | 1–3 | 15–30 mm deep | 0.3 / 0.55 / 0.8 | |
| foot chip | 1 | 10–20 mm | feet only | Screw-on |
| macro | 6–7 | 39–70 cm, standoff 7–16 cm | per face | Dual-tex |

**Per-hold fields [H]:** type, sizeRing, w/h/standoff, **edgeDepthMm** (separate from size),
**lipAngle** (−40 slopey … +30 incut), pullCone, thumbCatch (pinch width), pocketFingers, texture
(high / med / low / dual with a zone mask), material, mount (bolt / screw / volume face), roleFlags,
and **angleRange**. The angle range is a real product property: roof holds must not go on slabs
[S 85].

**Materials [S 86–89]:** PU is light and saturated but can polish. PE is grainy, resists polish and
is heavier. GRP is thin and glossy (macros). Wood is low friction (about ×0.8 (?)). Dual-tex has a
smooth "no-go" zone, sometimes a finer thumb zone [73,89].

**Mounting [S 84,85]:** bolt-ons take an M10 (3/8-16 in the US) bolt into a T-nut, at 20 Nm (S–L) or
25 Nm (XL). Screw-ons take 2 or more wood screws.

**Volumes [S 89–93]:** pyramids with a 26–140 cm base and 9–20 cm standoff; wedges with a 10–30°
face; blocks, half-domes, fins, hedrons. Each takes 3–9 T-nuts. Dual-tex volumes run 0.6–2.4 m.

### 3.4 Setting principles

- **Raising difficulty [C 94]:**
  - Rotate holds a few degrees; reduce positivity; require two holds together.
  - Use shallower or further-out feet.
  - Set targets higher and closer to the body to force dynamic moves; add blockers.
  - Cruxes lead from poor holds to a "reward" hold. Remove the reward, or use holds that look
    positive but aren't.
- **Grade = base + crux.** On the MoonBoard (about 25k problems), problems above V8 have only 1–2
  crux moves; the rest sit around V8 [M 95].
- **Comp section styles [C 71]:** physical, technical, coordination (≥3 linked limb moves),
  electric. Dynamic types: hands-only, feet-only, hand+foot, jump. Volumes enable run-and-jump.
- **Rules [S 96–98]:**
  - Start: 4 marked contacts. Top: matched and stable, or a top-out. Zones are optional.
  - IFSC 2025 scoring: top 25, zone 10, −0.1 per attempt.
  - MoonBoard holds the finish for **2 s**.
- **Slab [C 100,101]:** weight over the feet; arms balance; smears are real footholds; difficulty
  comes from hip placement, not strength.

**Grade bands [H, anchored to 20 mm / 10 mm benchmark edges]**

| Band | Angle | Hand holds | Edge depth | Hand move | Feet | Moves |
|---|---|---|---|---|---|---|
| V0–2 | −10° to 20° | jugs, big edges | ≥30–45 mm | 0.4–0.6 m, static | Many and large | 6–10 |
| V3–5 | 0–35° | edges, slopers, pinches, pockets | 20–30 mm | 0.5–0.9 m, first deadpoints | Fewer, S/XS | 5–8, 1 crux |
| V6–8 | 20–50° | crimps, poor slopers, gastons | 12–20 mm | 0.7–1.2 m | Chips and smears; feet cut | 4–8, 1–2 cruxes |
| V9+ | 30–60°, roofs | micros, slopey pinches | 6–12 mm | span limit; dynos 1–2 m | Poor; hooks essential | 3–8 |

**Route archetypes [H]**

| Archetype | Wall | Key parameters |
|---|---|---|
| ladder | VERTICAL / GENTLE | moveLen 0.3 span, many feet |
| traverse | any | horizontal bias 0.8 |
| zigzag | any | headings alternate ±35° |
| diagonal | any | rising heading of 30–50° |
| slab balance | SLAB | smears and chips, few hands |
| compression | 20–45° | opposing volumes or pinches |
| dyno | any | gap ≥1.0 m to a good target |
| coordination | volumes | ≥3 linked limb moves |
| cave/roof | ≥60° | hooks required, mantle at the lip |
| crimp board | 40° | crimps and micros |
| power | 35–50° | big slopers and pinches; campusable but costly in pump |

### 3.5 Lead routes

| Item | Value | Tag |
|---|---|---|
| First bolt | ≤3.10 m (EN 12572-1) | S [102,66] |
| Spacing | ≤1 m up to 5 m, then ≤2 m (EN 2007); a 2015 draft had 1.5 m above 8 m (?). Gyms: 1–1.5 m | S [64], C [104] |
| Draws on 15 m | 10–14 plus the anchor | D |
| Ground-fall zone | up to bolt 6–7; 53 of 123 indoor accidents between bolts 1 and 7 | S [102,103] |
| Fall length | 2 × height above the last bolt + slack + braking distance | S [102] |
| Clip window | hip to forehead, within about 2× shoulder width, from a stable stance; an overhead clip roughly doubles the fall | S [102], D |
| Z-clip / back-clip | rope taken from below the previous draw (IFSC counts it as unclipped) / climber's strand on the wall side | C/S [105,106,96] |
| IFSC rules | an out-of-sequence clip ends the attempt; top = clip the anchor | S [96] |

**Template [H]:**
- start at 0–15°;
- a rest jug or kneebar before the steep part;
- the crux at 55–75 % of height;
- shake-out, pump section, anchor;
- a positive clip hold at chest height below every draw;
- no hard moves or blind clips before bolt 3–4.

### 3.6 Boards (format reference only; never import their data)

- **MoonBoard** [70,107,108]: 198 LED positions; starts at row ≤6; column F is the axis.
- **Kilter** [109,110]: 0–70°. Colours: green start, blue hand, yellow feet-only, purple finish.
- **Tension Board 2** [111]: mirror or spray layout, 4 hold-difficulty levels, 11 foothold shapes.
- **Foot modes:** marked holds only; plus screw-ons; screw-ons only; footless + kicker; footless.

### 3.7 Grades [S 112,113, indicative]

| V | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Font (reference) | 4 | 5 | 5+ | 6A | 6B | 6C | 7A | 7A+ | 7B | 7C | 7C+ | 8A | 8A+ | 8B | 8B+ |
| Font (`grades.ts`) | 4 | 5 | 5+ | **6A+** | **6B+** | **6C+** | 7A | 7A+ | **7B+** | 7C | 7C+ | 8A | 8A+ | — | — |

Half grades: 6A+ ≈ V3/4, 6B+ ≈ V4/5, 6C+ ≈ V5/6, 7B+ ≈ V8/9. Our mapping consistently picks the
upper half grade. That is defensible, but it disagrees with the reference.

**Route grades:**
- 5.10a = 6a = VI+
- 5.11d = 7a = VIII
- 5.12d = 7c = IX
- 5.13b = 8a = IX+/X−
- 5.14b = 8c = X+
- 5.15a = 9a+ = XI+

---

## 4. Immersive feedback (Pure mode) and hold shading

### 4.1 Lessons from other games

- **Cairn (2026)** has no UI feedback: breathing, voice, limb shake, rumble, and a vignette, desaturation and
  slow zoom as stamina falls [117,118,123,124].
  - A flat palm means "bracing, not gripping". Chalk makes the next 12 handholds grippier; a
    shake-out gives partial recovery [118].
  - Criticised for hidden stamina and unpredictable hold quality [121,125], auto-picking the wrong
    limb [125] and impossible contortions [122,123] (this validates A8).
  - It ships opt-in "hold feedback" and "breathing feedback" assists [127].
- **The Climb:** a per-hand stamina bar; chalking costs a hand [133].
- **Jusant:** arms only [129]. **New Heights:** physics-based, with hold directions [131,132].
- **Mobile** (Crux, Clim) has no realistic per-limb sim [136,137]. **The niche is open.**

### 4.2 Signal → cue table [H]

The sim provides the thresholds; the amplitudes are design values for phone pixels.

| Sim signal | Cue |
|---|---|
| effort = max(tension, pump), smoothed 1 s | **Breathing** 15 → 30 → 45 /min (rest → working → crux). Hold the breath above tension 0.8, sharp exhale on the next grab. Per-head samples (A4), ±3 % pitch, ≥2.5 s between breaths, heavy loop only above pump 0.7 (A5) |
| limb stress ≥ `shakeOn` 0.7, stops < 0.6 | **Tremor** at 8–12 Hz (fatigue tremor is 8–14 Hz [157]), 6 mm at stress 0.7 → 15 mm at 1.3, on forearm and hand. Legs: Elvis leg with the heel lifting [158] |
| slip clock running (stress > 1.05) | Fingers uncurl and the hand creeps 5–15 mm along the pull, with a scrape and a chalk puff. Feet squeak and the toe skates |
| capacity at grab | **Hand pose shows the grip:** wrapped (jug), half crimp (edge), open (sloper), flat palm (useless). Foley per type; Android haptics 20 ms good / 6 ms poor |
| pump ≥ 0.5 | Forearm swells 4–8 %, elbow chicken-wings 10–25°, grunts, the free hand flutters |
| barn-door > 0.3 | Torso yaw starts, the opposite hand clenches, a sharp breath in |
| tension > 0.85 or slip clock > 50 % | Vignette 0.42 → 0.6, ≤25 % desaturation, 3–5 % dolly-in (none with reducedMotion), ambience low-pass. Ease in 0.8 s, out 1.5 s |
| slip, fall, catch | Android vibration [15, 60, 15]; 40 ms on landing or rope catch |

**Opt-in assists:** a faint 120 ms ring on a good grab; a chest-pulse breath visual; the roadmap's
faint handle ring on touch-down.

### 4.3 Touch notes

- **iOS has no `navigator.vibrate`** [138]. On iPhone, audio and animation must carry every critical
  cue.
- **Invisible handles:** pick radius at least 48 CSS px (about 9 mm). Pick the nearest limb at
  touch-down, with hysteresis.
- **Finger occlusion:** draw the dragged limb's target 40–60 px above the fingertip, or use a loupe.
- **Scale [D]:** with 3 m of wall over 800 px, 1 cm ≈ 2.7 px. A crimp lip is 3–5 px, so shading cues
  must target small-radius convex edges.

### 4.4 Hold-highlight shading (three.js r186, no new passes)

- **Always on:** baked per-vertex curvature `aCurv` (radiance scaling [139]; stable at every LOD),
  plus cavity AO from the existing `aSurf.z`.
- **Within reach, Pure mode:** a rim from above in TF2 style, `(1−n·v)^4 · max(0, n·up)` [142], and
  an edge glint whose half-vector uses the *wall-up* vector, × ridge × up.
- **Holds under 2 cm within reach:** an inverted hull, 1–1.5 px, warm off-white (4–8 draws).
- **Diegetic:** chalk on used lips, rubber on foothold tops.
- **Avoid on phones:** SSAO/GTAO, `OutlinePass`, and screen-space curvature, which is noisy [140,143].

**Curvature bake** (CPU, after `mergeVertices`):

```ts
κ = −2·mean_j[ n_i·(p_j−p_i) / |p_j−p_i|² ]   // 1/R on a sphere; positive = convex
aCurv[i] = clamp(κ * 0.015, -1, 1);          // a 1.5 cm radius saturates: thin lips get the most emphasis
```

**Fragment injection** (into `src/render/shading.ts`'s `onBeforeCompile`, after `outgoingLight`):

```glsl
float reach = max(1.-smoothstep(uReachR,uReachR+.35,distance(vWPos,uReachC[0])),
                  1.-smoothstep(uReachR,uReachR+.35,distance(vWPos,uReachC[1])));
vec3 N = normalize(normal), V = normalize(vViewPosition);
float ridge = max(vCurv,0.), cav = max(-vCurv,0.), up = max(dot(N,uWallUpV),0.);
float fres  = pow(1.-max(dot(N,V),0.), 4.);
float glint = pow(max(dot(N, normalize(V+uWallUpV)),0.), 48.) * ridge * up;
outgoingLight *= 1. + .35*ridge - .25*cav;                          // always on: shape reads
outgoingLight += uCue * (.5*fres*up + 1.4*glint) * reach * uPure;   // only within reach
```

- **Reach mask:** drive `uReachC` from the shoulders, with the radius from
  `anatomy.reachEnvelope` (not a fixed sphere). Fade over about 0.25 s.
- **Quality tiers:** low = curvature only; medium = + rim; high = + glint and hull.
- **Contrast:** keep about 3:1 luminance between route holds and the wall within reach.
- **Pure mode** replaces the `highlights.ts` decals with these steps.

---

## 5. Photo-to-route pipeline

### 5.1 Local CV (web build; also stage 1 on claude.ai)

Plain TypeScript in a Worker on `OffscreenCanvas`, about 300 lines and no download. OpenCV.js would
add 6–8 MB [144,145].

1. **Load and downscale.** `createImageBitmap` (EXIF orientation), long edge 1600 px.
2. **Rectify.** The user drags 4 wall corners; a DLT homography maps to the wall plane. Ask for the
   wall angle; height defaults to 4.5 m [S 64]; the floor line gives px/m. Sanity check: median hold
   8–25 cm.
3. **Colour model.** Gray-world white balance, or a wall-neutral tap. Take the median 7×7 CIELAB
   patch per tap (1–3 taps). Use ΔE weighted to (a, b), starting threshold 12–18 (JND ≈ 2.3 [150]).
   Low-chroma holds (C* < 10) use an L* test. HSV fails on gloss and red hue wrap [151].
4. **Mask.** Median 3×3 → open (r 2 px) → close (r 4 px) → fill holes → 8-connected components →
   moments.
5. **Filter.** Drop blobs < 0.02 % of the image. Aspect > 6 is tape (low tape = start marker).
   Blobs > 0.5 m are volumes: ask. Merge fragments < 1.5 % of the width apart. Split solidity < 0.7
   by watershed.
6. **Type guess [H].** < 4 cm micro; 4–10 cm with aspect > 2.5 edge or rail; 4–10 cm compact crimp;
   10–25 cm solid jug; 25–60 cm macro. Pull is perpendicular to the major axis, pointing down.
   **Sloper vs jug is undecidable in 2D:** default to a conservative capacity.
7. **Build.** Lowest blobs → start, highest → top. Run the solver/bot reachability check. Defaults:
   edge, medium, any feet.

**Fix-ups:** MediaPipe Interactive Segmenter turns a tap into a mask in about 208 ms [146]. Lazy-load
it. ClimbNet and the Roboflow models are too narrow to rely on [148,149].

### 5.2 Claude vision (claude.ai build only, Artifact `sample`)

- Ask for **absolute pixel** coordinates; they are approximate [154]. `sample` downsizes to about
  1.2 MP, so pre-resize to about 1200×1000 yourself.
- **Set-of-Mark [156]:** draw numbered markers from the local CV on the rectified image and send the
  clean crop too. Ask Claude to *classify the IDs* —
  `{id, keep, type∈{jug,edge,crimp,sloper,pinch,pocket,foot,volume,tape,not_route}, size_cm, edgeDirDeg, role, confidence}` —
  and to list missed holds as `[x, y]`, which are then snapped to blobs. End with "Reply with only
  JSON".
- **Validate:** in bounds, 4–30 holds, dedupe within 3 % of the width.
- Call only on a tap, with one manual retry. Say in the UI that the image goes to the viewer's own
  account.

### 5.3 Mobile flow and pitfalls

**Flow:** capture (square to the wall, 1× lens, floor and top in frame) → corner crop with a loupe →
tap the colour (plus "not this" and neutral taps) → live mask with a tolerance slider (< 100 ms at
1 MP) → review numbered outlines (toggle, drag, long-press type, merge or split) → start, top and
feet rule → wall angle → reachability check → Play or Remix.

**Pitfalls and fixes**

| Pitfall | Fix |
|---|---|
| LED casts, shadows | Wall white balance; weight (a, b) over L |
| Gloss | Drop high-V/low-S pixels when sampling; the close step fills them |
| Chalked tops | Close and fill holes |
| Red/pink, purple/blue, black/shadow | Tight (a, b) tolerance plus negative taps |
| Touching holds | Watershed split |
| Same-colour tape or volumes | Shape filters |
| Shot from below | Homography plus a parallax warning (holds stand 5–15 cm off the wall) |
| Ultrawide lens | Advise the 1× lens |

---

## 6. TUNING TABLE

**Status:** OK = matches; LOW / HIGH / FAST = mismatch in that direction; MISSING = not modelled.
Code is `src/config/tuning.ts` plus `src/game/{statics,holds,anatomy,generator,grades}.ts`. Probe
values come from an uncommitted scratch `ClimberSim` run. Pump times are computed from
`updatePump` (pump = 1 is a fall). Untested design values (`shakeOn` 0.7 / `shakeOff` 0.6,
`matchFactor` 0.88, `clipTime` 0.75 s: no measurement found) are left out.

### 6.1 Body and reach

| Parameter | Recommended | Tag / src | Code now | Status |
|---|---|---|---|---|
| Shoulder → grip | ≈0.64–0.68 m (span ≈ stature) | M/D [35,36] | `armMax` 0.66 | OK |
| Hip → toe | 0.915 m mean (0.77–1.13) | M [19] | `legMax` 0.93 | OK |
| High step, hips in | toe at hip −0.15 to +0.22 m (mean +0.06) | M [19] | `LEG_ENVELOPE` peaks ≈ +0.17 m | OK (the anatomy.ts and climber-sim.ts headers say 0.33: stale) |
| High step, rock-over / hips out | up to +0.35 m | D | — | MISSING (B2) |
| Crossover | to the opposite shoulder line (≈0.2 m past midline) | D [44] | `ARM_ENVELOPE` −90°: 0.40 m → 0.21 m past midline | OK |
| Hand down (mantle press) | to the hips and below while pressing | C | 0.42 m straight down | MISSING (mantles, B2) |

### 6.2 Statics and feet

| Parameter | Recommended | Tag / src | Code now | Status |
|---|---|---|---|---|
| Keep-in pull | `W(s·sinθ + (d/L)cosθ)` | D | `statics.ts` identical | OK |
| Hip depth d | 0.25 m (in) to 0.40 m (out) | D | `estimateDepth` 0.14–0.62 | OK |
| Hands' share, good feet | §2.1 band (0°: 0.25–0.40; 30°: 0.55–0.70; 45°: 0.65–0.80) | D [1,3] | probe: 0.14–0.44 / 0.47–0.50 / 0.58–0.59 | LOW by about 0.07 on steep walls (the refs are derived; low priority) |
| Smear | along-wall load ≤ μ·N; μ 1.1 (plastic), 0.7 (rock) | M [14] | `smearCap` 0.5 × angle factor × (0.8 + 1.4n) | OK at vertical (≈0.15 BW per foot); make it μ·N |
| Smear max angle | ≈ +10° | D | `smearMaxAngle` 10 | OK |
| Toe-pull capacity | 0.10–0.25 BW per foot | U | `toeScale` 0.2–0.36, `toeMin` 0.12 | OK (?) |
| Heel-hook pull | up to ≈0.45 BW | D/U | — | MISSING (B2) |
| Foot weighting | feet carry more than hands at least to 5–10° overhang | M [1,3] | probe: feet ≥ hands to about 45° | OK |

### 6.3 Hand capacity

| Parameter | Recommended | Tag / src | Code now | Status |
|---|---|---|---|---|
| Edge (20–30 mm), one hand | 0.55–0.70 BW (V3–V5 climber) | M [23,24] | `handCap.edge` 0.55 | OK (bottom of the band) |
| Climber strength level | 0.5 (beginner) → 1.2 (elite) BW | M [23,24] | none (only `assist`) | MISSING; needed for "brute force" |
| Crimp / edge | 0.65–0.75 | M [22] | 0.38 / 0.55 = 0.69 | OK |
| Jug / edge | 1.3–1.6 | D | 0.75 / 0.55 = 1.36 | OK |
| Sloper / edge | 0.9 up to 20–30° slope; 0.55–0.75 at 40° | M [29] | 0.58 fixed, plus `overhangLoss` 0.55·sinθ | PARTIAL: drive it from effective slope (§2.4) |
| Pinch / edge | 0.5–0.8 | U | 0.82 | HIGH end |
| Pocket / edge | 3-finger 0.8, 2-finger 0.55, mono 0.3 | D/U | one type, 0.82 | MISSING split |
| Edge-depth effect | 1 cm = 0.61× of 4 cm (≈0.7× per halving) | M [22] | `sizeEffect` ±15 % on radius | MISMATCH: add `edgeDepthMm` |
| Full-crimp bonus | none | M [21] | none | OK |
| `overhangLoss` per type | no measured basis | U | 0.08–0.55 | Keep as a proxy; for slopers replace with effective slope |
| Pull cones | narrow for slopers and crimps, wide for jugs, pinches and horns | C | `handCone` (jug 70/155, edge 45/120, crimp 35/100, sloper 26/82, pinch 85/175, pocket 50/130) | OK. Keep these over the report's ±25–50° heuristics. Add horn (≈110 inner), bucket (≈80), micro (≈25) |
| Hold size | jug 11–13 cm wide (radius ≈0.06); crimp 7.6 cm; chips <5 cm | S [74,75,72] | `SIZE` jug radius 0.08–0.12, crimp 0.028–0.045, foot 0.02–0.035 | Jugs 1.4–2× large (fine for readability) |

### 6.4 Pump, recovery, slips

| Parameter | Recommended | Tag / src | Code now | Status |
|---|---|---|---|---|
| Pump state | **per forearm** (W′ per hand) | M [45,50] | one global `pump` | MISMATCH (needed for one-arm shake-outs) |
| CF | 0.41 MVC (intermittent); 0.30 for unbroken holds over 8 s | M [45] / D | onset ramps from stress 0.25 (`smoothstep(0.25, 1.1)`) | FAST near CF |
| W′, drain | ≈30 MVC·s; k = 1.0 intermittent, 1.8 sustained | D (fit, §2.6) | `pumpStrain` 0.036 | — |
| Stress 0.4, feet on | near-sustainable (7–14 min) | M [48] | ≈140 s to fall (lead ≈230 s) | FAST about 3–5× |
| Stress 0.6, continuous | 48–66 s | M | ≈41 s | Slightly FAST |
| True dead hang, 25 mm | 23 / 42 / 59 s (low / intermediate / advanced) | M [26] | edge at stress ≈0.9 + `pumpCampus` → ≈12 s | FAST about 3× |
| Base creep | ≈1/(10–14 min) | D [48] | `pumpBase` 1/320 s (lead ×0.6 → 1/533 s) | FAST about 2× |
| Pumped capacity floor | 0.50–0.65 of fresh | M [49] | 1 − 0.32·pump² → 0.68, and pump = 1 → fall | CLOSE. Prefer falling when capacity < load |
| Recovery half-time | rec. 60–90 s, int. 45–60, adv. 15–30, elite 8–16 | M [50] | linear `pumpRecover` 0.022/s (≈23 s half-equivalent); lead ×1.4 | OK for "advanced"; make it exponential and tie it to level |
| Shake-out bonus | ×1.3 | M (Baláš 2016) | `pumpShakeOut` 0.032 vs 0.022 (×1.45) | OK |
| Residual pump on lead | slow part, decays over more than 10 min | D [51] | — | MISSING |
| Campus extra | from the load (hands carry 1 BW), not a flat add | D | `pumpCampus` +0.02/s | Keep while the strength level is missing |
| Slip warning | 1–2 s visible before a slip | H | `slipStart` 1.05, `slipFull` 1.6, `slipTime` 0.5 s (≈1.2 s at 1.3) | OK |
| Hang until slip (friction) | 49 s without chalk, 63 s with | M [27] | — | Test anchor for B3 |

### 6.5 Chalk and sweat (B3; all MISSING today)

| Parameter | Recommended | Tag / src |
|---|---|---|
| Friction factor φ per hand | 1.0 baseline, 1.2 just after chalking, about 0.8 when sweaty or over-dry | M [55] / D |
| Effect on capacity | `cap × (1 + w_type·(φ − 1))`; w: sloper 1.0, edge/crimp/pinch 0.6, pocket 0.4, jug 0.2 | D |
| Fade on lead | φ 1.2 → 0.8 over about 5 hand moves or 30–45 s | M [40] / D |
| Fade when bouldering | noticeable only after 40–60 s or about 10+ hand moves | D |
| Chalk-up | 1–2 s with the hand off (ROADMAP says about 1 s); a chalk-and-shake takes more than 5 s | M [40] |
| Humidity above 70 % | fade ×1.5 | C [60] / D |

### 6.6 Dynamics and dynos (B2)

| Parameter | Recommended | Tag / src | Code now | Status |
|---|---|---|---|---|
| Catch window | −150 to +50 ms around the apex (hand within 2–5 cm of the apex) | D [37] | — | MISSING |
| Catch load | 1.1–1.6 BW on the catching hold(s) | M [37] | — | MISSING |
| Launch force split | feet ≈1.8× hands | M [37] | — | MISSING |
| Airtime | 0.20 / 0.32 / 0.45 s for a 0.2 / 0.5 / 1.0 m CoM rise | D | `noHandsGrace` 0.28 s | CONFLICT: suspend the grace during a dyno flight |
| Dyno distance | rec. 0.4–0.8 m; strong 1.0–1.5 m; record 2.85 m | M [39] / D | — | — |

### 6.7 Walls, generator, lead, rules

| Parameter | Recommended | Tag / src | Code now | Status |
|---|---|---|---|---|
| Boulder wall height | 4.5 m | S [64,65] | `boulderWall.height` 4.5 | OK |
| Mats | about 0.40 m | S [65] | `padHeight` 0.3 | Slightly LOW (cosmetic) |
| Boulder angles | −5° to 45° (IFSC); modules −3° to 60°; caves to about 85° | S [65,68] | `ANGLES` −8…40, one plane | PARTIAL (B1 panel stacks) |
| Angle by grade | V0–2: −10 to 20; V3–5: 0–35; V6–8: 20–50; V9+: 30–60 and roofs | H | `pickAngle`: V6–8 mostly 10–30; V9+ 20–40 | Too shallow at V6+ |
| Lead angles | 15–60°, average about 30° | S [65] | rope: 0–20° | MISMATCH |
| Lead wall height | ≥15 m | S [65] | `ropeWall.height` 15 | OK |
| Hand gain per move | hand travel V0–2 0.4–0.6 m → V6–8 0.7–1.2 m | H | `gain` 0.36 → 0.62 per leapfrog (travel ≈ 2×) | OK (D) |
| Crux structure | base difficulty + 1–2 crux spikes | M [95] | `awkward` 0 → 0.45 spread over the route | PARTIAL |
| First bolt | ≤3.1 m | S [102] | 1.9–2.2 m | OK |
| Bolt spacing | ≤1 m up to 5 m, 1.2–1.5 m to 8 m, ≤2 m above | S [64,104] | 1.4–2.0 m everywhere (≈8 draws + anchor vs 10–14) | MISMATCH low on the route |
| Clip quality | clip window hip to forehead, ≤2× shoulder width; z-clip and back-clip detection | S/C [102,105,106] | `clipRadius` 0.16 m reach test | MISSING scoring |
| Top hold | 2 s (MoonBoard); IFSC "stable position" | S [98,96] | `topHold` 0.7 s | SHORT (design choice; 1–2 s recommended) |
| T-nut grid; kicker | 32/m² staggered or a 20 cm grid; kicker 0.3–0.37 m | S [68,70] | — | For B1/C |
| Font labels | §3.7 reference row | S [112,113] | upper half grade at V3–V5 and V8 | MINOR |

**Priority fixes for Phase B**
1. Per-hand W′ pump with CF (§2.6).
2. Add `edgeDepthMm` and `lipAngle` to `HoldDef` and drive capacity from them.
3. Climber strength level, so brute force is possible.
4. Panel stacks with angles up to 60–85°, plus hooks.
5. Dyno flight state.
6. EN bolt spacing.
7. Chalk and sweat φ.

---

## 7. Sources

**Biomechanics, physiology, friction**

1. Bonelli 2024, contact forces in rest positions — https://air.unimi.it/retrieve/79215363-103a-411c-ba5f-3e8e4b92af43/Bonelli%202024%20Distribution_of_contact_forces_of_a_climber_in_typical_rest_positions.pdf
2. Bonelli 2025, Eur J Appl Physiol — https://link.springer.com/article/10.1007/s00421-025-06047-y
3. Noé 2001, Gait & Posture (abstract) — https://pubmed.ncbi.nlm.nih.gov/11240356/
4. Review citing Noé and Baláš 2014 — https://pmc.ncbi.nlm.nih.gov/articles/PMC4327382
5. Quaine & Martin 1999 — https://pubmed.ncbi.nlm.nih.gov/10567755/
6. Pandurevic 2020 — https://www.scitepress.org/Papers/2020/100100/100100.pdf
7. Flagging guide — https://climbinghouse.com/flagging-technique-guide/
8. Flagging — https://www.climbing.com/skills/flagging?scope=anon
9. MacLeod on flagging — https://gripped.com/?p=48051
10. Dech & Kittel 2026 — https://www.mdpi.com/2411-5142/11/1/103
11. Knee pain and drop knee — https://lafabriqueverticale.com/en/knee-pain-climbing-injury-prevention
12. Drop knee — https://physicaltherapyfirst.com/?p=8185
13. Joint range-of-motion norms (AAOS) — https://pmc.ncbi.nlm.nih.gov/articles/PMC8167346/table/table1-1941738120953418
14. Shoe rubber friction — https://www.european-rubber-journal.com/article/2082793/testing-for-the-grippiest-climbing-shoes
15. Rubber hardness vs grip — https://eprints.whiterose.ac.uk/id/eprint/217285
16. Smearing — https://climbinghouse.com/smearing-technique-what-how/
17. Footwork — https://www.ukclimbing.com/articles/page.php?id=10957
18. Hamstring injuries — https://www.germanjournalsportsmedicine.com/archive/archive-2022/issue-2/severe-injuries-of-proximal-hamstrings-in-high-performance-sport-climbers/
19. Grant foot raise — https://pmc.ncbi.nlm.nih.gov/articles/PMC7178254
20. Flexibility vs ability — https://eprints.chi.ac.uk/id/eprint/243/
21. Slope vs crimp grip force — https://www.thieme-connect.com/products/ejournals/html/10.1055/s-2004-821117
22. Edge depth vs force (Amca 2012) — https://pubmed.ncbi.nlm.nih.gov/22339482/
23. One-arm force on 23 mm by group — https://eprints.glos.ac.uk/3089/
24. Lattice finger strength vs grade — https://latticetraining.com/blog/lattice_data_finger_strength_grades
25. Community one-arm estimate (?) — https://ukbouldering.com/board/index.php/topic,33968.msg691070.html
26. Dead-hang times — https://periodicos.ufsc.br/index.php/rbcdh/article/download/96422/61228/435920
27. Chalk and hang time (Kilgas 2016) — https://pubmed.ncbi.nlm.nih.gov/27619723/
28. Treadwall forces and fatigue — https://www.medrxiv.org/content/10.1101/2020.04.27.20077560v1
29. Slopers (Amca & Arıtan 2015) — https://ojs.ub.uni-konstanz.de/cpa/article/view/6511
30. Pulley loads by grip — https://pubmed.ncbi.nlm.nih.gov/16225880/
32. Finger load distribution — https://sportrxiv.org/index.php/server/preprint/view/91
33. Undercling — https://www.climbing.com/skills/climbing-techniques-how-to-undercling/?scope=anon
34. Gaston — https://earthtreksclimbing.com/what-is-a-gaston-in-climbing/
35. Arm span in climbers — https://pubmed.ncbi.nlm.nih.gov/14514533/
36. ANSUR summary tables — https://www.ergocenter.ncsu.edu/wp-content/uploads/sites/18/2017/09/Anthropometric-Summary-Data-Tables.pdf
37. Two-handed dyno biomechanics (Fuss & Niegl) — https://www.researchgate.net/publication/225113929_Biomechanics_of_the_two-handed_dyno_technique_for_sport_climbing
38. Dyno thesis — https://dc.ewu.edu/theses/719/
39. Dyno record — https://www.guinnessworldrecords.com/world-records/farthest-dyno-move-in-wall-climbing-male
40. Winkler 2022, IFSC lead timing — https://pmc.ncbi.nlm.nih.gov/articles/PMC8980921/
41. Campusing guide — https://www.scarpa.co.uk/blogs/blog/campusing-101-guide
42. Campusing readiness — https://www.trainingbeta.com/?p=13982
43. Shoulder range of motion — https://www.enlyte.com/insights/article/adjuster/understanding-normal-range-motion-joint-functionality
44. Horizontal adduction — https://www.physiotutors.com/?p=8915
45. Critical force (Giles 2019) — https://eprints.glos.ac.uk/6380/
46. Critical force vs grade — https://pubmed.ncbi.nlm.nih.gov/33647876/
47. Occlusion in handgrip — https://informahealthcare.com/doi/abs/10.1080/00140138008924748
48. Rhythmic 40 % MVC — https://pubmed.ncbi.nlm.nih.gov/9272777/
49. Vigouroux & Quaine 2006 — https://pubmed.ncbi.nlm.nih.gov/16368628/
50. Reoxygenation (Fryer 2015) — https://pubmed.ncbi.nlm.nih.gov/25536538/
51. Lactate after a route — https://pubmed.ncbi.nlm.nih.gov/14985990/
53. Work:rest ratios — https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1410636
54. Heart rate vs steepness — https://pubmed.ncbi.nlm.nih.gov/9298558/
55. Chalk on rock — https://hal.archives-ouvertes.fr/hal-01454843
56. Friction science — https://www.climbing.com/skills/science-friction-the-truth-behind-perfect-climbing-conditions?scope=anon
57. Li 2001 — https://pubmed.ncbi.nlm.nih.gov/11411778/
58. Chalk and moisture — https://eprints.whiterose.ac.uk/214893
59. Skin moisture and friction — https://pubmed.ncbi.nlm.nih.gov/19428531/
60. Humidity — https://gripped.com/?p=38685
61. Temperature and friction — https://www.climbing.com/skill/learn-this-friction-science/?scope=anon
62. Elvis leg — https://sportsocratic.com/2018/08/01/what-is-elvis-leg/
63. Chicken wing — https://www.mendcolorado.com/physical-therapy-blog/2022/6/7/why-do-we-chicken-wing-in-rock-climbing/

**Walls, holds, setting, rules**

64. Künstliche Kletteranlage (EN 12572 summary) — https://de.wikipedia.org/wiki/K%C3%BCnstliche_Kletteranlage
65. IFSC wall requirements — https://images.ifsc-climbing.org/ifsc/image/private/t_q_good/prd/zyoowsp9iiywlszflw99.pdf
66. Unfallkasse NRW — https://www.unfallkasse-nrw.de/fileadmin/server/download/Regeln_und_Schriften/Informationen_Schueler-UV/202-018.pdf
67. Bouldering walls explained — https://www.boulderingproject.com/blog/bouldering-walls-explained/
68. Walltopia Boulder Fundamentals — https://cdn.walltopia.com/wp-content/uploads/20251123161016/Brochure-Boulder-Fundamentals-1.pdf
69. Walltopia adjustable frame — https://cdn.walltopia.com/wp-content/uploads/20251210143429/Walltopia_Adjustable_Board_Frame_12x12_EUR-1.pdf
70. MoonBoard build guide — https://moonclimbing.com/media/moonboard-pdf/How-to-build-a-MoonBoard_v2.2.pdf
71. Boulder styles — https://www.inside-climbing.com/2025/08/06/breaking-down-boulder-styles-part-1/
72. Trango hold technology — https://trango.com/pages/hold-technology
73. Xcult technical info — https://www.xcultclimbing.com/en/holds_technical_info
74. Atomik jugs — https://www.atomikclimbingholds.com/12-pack-large-simple-jugs-climbing-holds
75. Atomik crimps — https://atomikclimbingholds.com/10-small-oval-crimps
76. Atomik XXL crescent — https://atomikclimbingholds.com/xxl-crescent-moon-single-climbing-hold
77. So iLL pinches — https://soillholds.com/products/pinches-wide-hard
78. EP macros — https://epclimbing.com/en/news/macros-ep-climbing-florent-bonvarlet-holds-2
79. EP Barchan — https://epclimbing.com/en/news/barchan-new-climbing-macros-holds
81. Lattice Triple Twins — https://latticetraining.com/product/lattice-triple-twins/
82. Lattice Micros — https://needlesports.com/Catalogue/Climbing/Bouldering-Training-Sport/Training-Equipment/Lattice-Micros-LAT-MICROS
84. Big Red — https://www.bigredclimbing.com.au/useful-info/
85. Euroholds user guide — https://euroholds.com/en/content/12-user-guide
86. UKC hold review — https://www.ukclimbing.com/gear/review.php?id=1221
87. Moon School holds set F — https://moonclimbing.com/new-school-holds-set-f.html
88. Expression PE vs PU — https://www.expression-holds.com/en/holds/2049-74783-tripod-mini-volume-3-pe.html
89. Rockcity dual-tex volumes — https://b2b-v2.rockcityclimbingholds.com/volumes/dual-texture/
90. Atomik high-profile triangle — https://atomikclimbingholds.com/volumes-1-high-profile-triangle-
91. Atomik low-profile triangle — https://atomikclimbingholds.com/volumes-3-low-profile-triangle-
92. Anatomic Rock M — https://shop.anatomic.sk/en/produkt/rock-size-m/
93. Anatomic Triangle M — https://shop.anatomic.sk/en/produkt/triangle-size-m/
94. Ask a Setter — https://climbingbusinessjournal.com/ask-a-setter-tricks-for-setting-harder-climbs/
95. Duh & Chang 2021, MoonBoard — https://arxiv.org/abs/2102.01788
96. IFSC 2025 Rules — https://climbingcanada.ca/wp-content/uploads/2026/02/2025-IFSC-Rules.pdf
97. 2025 scoring — https://gripped.com/indoor-climbing/this-years-world-cup-will-feature-new-rules/
98. Using your MoonBoard — https://moonclimbing.com/using-your-moonboard
100. REI techniques — https://www.rei.com/learn/expert-advice/climbing-techniques.html
101. Slab climbing — https://www.climbing.com/skills/face-climbing-techniques-slab-climbing
102. DAV ground-near belaying — https://www.alpenverein.de/artikel/bodennah-sichern-und-klettern_18f4cde9-301a-42e7-a85f-8a5061e1a86b
103. DAV accident statistics 2022 (?) — https://magazin.alpenverein.de/files/kh-unfallstatistik_2022-1695712655.pdf
104. Lead climbing — https://climbernews.com/what-is-lead-climbing/
105. Z-clipping — https://climbinghouse.com/z-clipping-why-how-to-avoid/
106. Back-clipping — https://climbinghouse.com/back-clipping-mistake-lead/
107. Choose your MoonBoard — https://eu.moonclimbing.com/choose-your-moonboard
108. Every MoonBoard problem (Lattice) — https://eutrade.moonclimbing.com/News/post/every-moonboard-problem-ever-by-lattice-training
109. Kilter Board — https://gripped.com/indoor-climbing/how-to-use-a-kilter-board/
110. Kilter sizes — https://settercloset.com/pages/kb-board-sizes
111. Tension Board 2 — https://tensionclimbing.com/product/tension-board-2/
112. International grades — https://www.mountainproject.com/international-climbing-grades
113. Bouldering grades — https://en.wikipedia.org/wiki/Grade_(bouldering)

**Games, rendering, photo import**

117. Cairn gameplay presentation — https://www.thegamebakers.com/cairn-in-depth-gameplay-presentation/
118. PlayStation Blog — https://blog.playstation.com/?p=414558
121. Quarter to Three — https://www.quartertothree.com/fp/2026/02/06/in-cairn-you-will-get-into-the-groove-or-you-will-die-trying/
122. FingerGuns review — https://fingerguns.net/reviews/2026/01/29/cairn-review-ps5-bold-new-heights/
123. TheSixthAxis review — https://www.thesixthaxis.com/2026/01/29/cairn-review/
124. Xbox Tavern review — https://www.xboxtavern.com/cairn-pc-review/
125. Seasoned Gaming review — https://seasonedgaming.com/2026/02/17/review-cairn-survive-the-climb/
127. Cairn accessibility — https://caniplaythat.com/2026/01/26/accessibility-options-in-climbing-game-cairn-shared-before-launch/
129. Jusant — https://www.gamedeveloper.com/design/unlocking-the-catharsis-of-climbing-in-meditative-puzzler-jusant
131. New Heights (Steam) — https://store.steampowered.com/app/2179440/New_Heights
132. New Heights (80.lv) — https://80.lv/articles/an-upcoming-unity-powered-game-with-lifelike-climbing-mechanics
133. The Climb review — https://hardcoregamer.com/reviews/review-the-climb/211257/
136. Crux (mobile) — https://gripped.com/?p=38543
137. Clim — https://gyachungkang.itch.io/clim
138. WebKit `vibrate` removal — https://lists.w3.org/Archives/Public/public-device-apis-log/2024Jun/0061.html
139. Radiance scaling (Vergne 2010) — https://artis.inrialpes.fr/~Romain.Vergne/blog/2010/02/19/radiance-scaling.html
140. Screen-space curvature — http://madebyevan.com/shaders/curvature/
142. TF2 shading (Mitchell) — https://www.cs.princeton.edu/courses/archive/fall07/cos597B/papers/mitchell-team-fortress.pdf
143. N8AO — https://github.com/N8python/n8ao
144. OpenCV.js size — https://answers.opencv.org/question/209264/opencvjs-smaller-package
145. OpenCV.js wasm size — https://answers.opencv.org/question/229032/opencv_jswasm-is-too-large
146. MediaPipe Interactive Segmenter — https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter
148. ClimbNet — https://github.com/cydivision/climbnet
149. Roboflow hold detector — https://universe.roboflow.com/climb-ai/hold-detector-rnvkl
150. CIE76 JND — https://colour.readthedocs.io/en/latest/generated/colour.difference.JND_CIE1976.html
151. HSV pitfalls — https://www.chiefdelphi.com/t/very-basic-boulder-detection/152380
154. Claude vision coordinates — https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
156. Set-of-Mark prompting — https://arxiv.org/abs/2310.11441
157. Fatigue tremor 8–14 Hz — https://lida.sport-iat.de/ta/Record/4094230
158. Leg tremor while climbing — https://www.straightdope.com/21342996/why-do-your-legs-tremble-uncontrollably-sometimes-when-rock-climbing

Numbering has gaps on purpose: the IDs match the research notes.

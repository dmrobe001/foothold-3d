# Plants: design for a branched, rooted, breakable plant model

Status: **steps 1 and 2 built**, with eighteen species in three regions and three seasons (§8e, §8f); **step 3 mostly built** (branch obstacles, breaking, branches on fallen trees; pushing through foliage by branch is not yet); step 4 is design. This replaces the "Trees: forks, branch hierarchy, stubs" sketch in
`extensibility.md` and folds in five requirements:

1. leaf placement differs by plant;
2. every plant keeps a branching structure, used later for branch fall and stubs, load-induced breaks,
   deliberate breaking, pushing through foliage, and branches surviving on fallen trees;
3. roots, some crossing above ground, which shape root wads and leave a pit when a tree uproots;
4. stumps;
5. vines;
6. edible parts.

Labels used below: **[known]** is standard botany or mechanics with a citation-grade source; **[choice]** is a design
decision; **[guess]** is a number to tune in play.

## 1. The one idea: a plant is a graph of segments

Today a tree is one bent tube plus a cloud of foliage cards. That shape can't hold any of the five requirements,
because none of them has anything to attach to. The rebuild gives every woody plant (tree, shrub, vine, root
system) the same representation: a **rooted tree graph of segments**, with foliage and roots hung off it.

```text
Plant
  rec        the stand-simulation record (species, dbh, height, status, light history, events, seed)
  nodes      struct-of-arrays, one entry per segment, in a fixed generation order (index = stable id)
    parent     index of the parent segment (-1 for the collar, where stem meets roots)
    p0, p1     start and end points (metres, plant-local)
    r0, r1     radius at each end
    order      0 stem, 1 limb, 2 branch, 3 shoot; roots use negative orders (-1 structural, -2 fine, -3 sinker)
    born       year the segment grew
    state      live | dead | broken | buried
    load       derived: mass carried beyond this segment and its moment arm (see 4)
  leaves     foliage units: { node, u (position along it), kind, size, facing }
  events     history replayed into the graph: leader loss, self-pruning, release, storm damage
  delta      what the player and the game changed since generation: broken node ids, added loads
```

Why this shape:
- **Stable ids from generation order** [choice]. Regenerating from the seed gives the same node indices, so a
  broken branch is stored as a small `delta` (a list of ids) rather than a saved mesh. This is how the forest
  stays reproducible while still remembering what the player did.
- **One graph for shoots and roots**, joined at the collar. A falling tree rotates the whole graph about a hinge.
  An uprooting carries the root nodes inside the plate radius with it, and the rest tear (`broken`). A snap
  splits the graph at a stem node, and the lower part becomes a stump.
- **Mechanics read the same arrays.** Every segment has a radius, a length and a parent, which is everything a
  cantilever beam calculation needs.

## 2. Growing the skeleton

The traits come from the Hallé–Oldeman architecture vocabulary in `extensibility.md`, moved into the species
table [choice]:

| Trait | Fir | Pine | Maple | Birch |
|---|---|---|---|---|
| apical dominance (1 = single leader) | 0.95 | 0.7 | 0.35 | 0.55 |
| growth: monopodial or sympodial | mono | mono | sympodial-ish (decurrent) | mono, weak |
| branching pattern (phyllotaxis) | whorls of 4–6 | whorls of 3–5 | opposite pairs | alternate spiral |
| branch angle from the stem | 70–90° | 50–70° | 35–55° | 40–60°, tips droop |
| self-pruning in shade | slow: dead branches persist | fast: clean bole | stubs, occluded | fast |
| leaf display | 3a | 3b | 3c | 3d |

**Algorithm** [choice]. Growth runs in units of 2–5 years rather than every year:
1. The leader extends toward sky light (the stand simulation already gives the light gradient). Apical dominance
   damps the turn, and so damps phototropism.
2. Buds at nodes put out laterals according to phyllotaxis, with vigour proportional to local light. This is
   *space colonisation lite*: a coarse crown-light field instead of thousands of attractor points.
3. A branch whose light stays under its compensation point for several growth units dies. A dead branch hangs on
   for a species-dependent time, then breaks, leaving a stub. Under that a **dead-branch zone** forms, and lower
   down the **clear bole**. Both come straight from the light history and need no extra rule.
4. Radii come from the **pipe model** [known] (Shinozaki et al. 1964, "da Vinci's rule"): a parent's
   cross-section is about the sum of its children's, r_parent^2.5 ≈ Σ r_child^2.5 (measured exponents run about
   2–3). Leaves set the tip radii, and the stem's radius at breast height is scaled to match dbh, the diameter at
   breast height (1.3 m), from the simulation.
5. Shape comes from events: a leader lost in a storm or to snow is replaced by one or two upturned laterals, which
   gives a fork or a crook (**reiteration** [known]). Release after a neighbour falls gives epicormic shoots and a
   crown that shifts toward the gap. The existing sweep, lean and sinuosity become the stem's starting curve.
6. Sag: after growth, each branch bends under its own load (section 4) by a small static deflection. This gives
   the droop of old long limbs and of birch tips without a special rule.

**Budget** [guess]. Keep explicit segments down to order 2 (about 150–600 per mature tree). Order-3 shoots are not
segments: they are folded into the foliage units at order-2 tips. Skeletons are generated lazily for trees within
about 60 m and cached, roughly 300 trees × 400 segments, which is small in typed arrays. Far trees use baked
variants: about 8 skeletons × 3 size classes per species, as `extensibility.md` proposed, then today's card
clouds at long range.

**More bent and branched trees** come from, in order of visual payoff:
- low apical dominance (decurrent broadleaves);
- sympodial zig-zag;
- reiteration forks from history;
- gap-seeking crowns;
- load sag.

Adding a species with an open, crooked habit, such as an oak, becomes a new table row rather than new code.

## 3. Leaves: a foliage unit per kind

A **foliage unit** is a small mesh (a spray, a tuft or a leaf cluster) attached at a parameter `u` along a node,
with an orientation rule. Kinds [choice]:

| Kind | Placement | Orientation | Example |
|---|---|---|---|
| 3a planar sprays | along all shoots younger than about 7 years (needles persist) | flattened, facing up (plagiotropic) | fir |
| 3b terminal brushes | tufts at shoot tips only, inner crown bare | radial around the shoot axis | pine |
| 3c shell | leaves at the tips of the outer shell, dense | faces outward toward light | maple |
| 3d pendulous clumps | clustered at tips, hanging | droops with gravity, see-through | birch |
| 3e along the stem | at nodes along a climbing stem | faces away from the host surface | vines |

Leaves only reference a node, so when a branch breaks or a log turns over, its foliage goes with it. A dead
branch keeps its foliage for a season (needles redden), then drops it. That rule also makes branches on fallen
trees fade in a believable way.

## 3b. Edible parts

Two kinds of entry, both in the species table (`ARCH[sp].edible` and `.organ`):
- **Organs**: discrete objects placed on the graph when the plant grows, such as cones, samaras, catkins, and later
  berries and nuts. Each is `{node, u, part, mass, months}`. Because an organ sits on a node, it falls with its
  branch, adds its mass to the load, and can be picked by reaching that point. Placement depends on the species,
  size (a minimum dbh for bearing), crown zone (fir cones only in the top fifth, upright; pine cones mid crown,
  hanging) and, for shoot-tip organs, the tips only.
- **Tissues**: parts of a segment rather than objects, such as inner bark, sap and needle tips. They are listed with
  the segments they live on (stem, shoot tips) and the months they are good, so a later gathering mechanic reads them
  from the graph: inner bark from any stem segment, sap from the stem in spring, tea from live shoot tips.

Months are northern temperate. The uses listed are traditional and are not advice. Roots will carry edible tissues
the same way, and vines (wild grape) will carry fruit as organs.

## 4. Mechanics the graph enables (designed for, built later)

All of these are **cantilever beam** calculations [known] on the segment chain. The section modulus of a round
segment is Z = πr³/4, so the bending stress at a joint is σ = M/Z, where M is the bending moment about that joint.

- **Load.** For each segment, sum the mass beyond it (wood plus leaves plus vine plus snow plus the player) and the
  moment arm about its base. That is one pass from the tips to the root over the graph.
- **Break** when σ > MOR × health. MOR (modulus of rupture) is the bending stress at which green wood fails, from
  the USDA Wood Handbook [known, approximate]: about 38 MPa for balsam fir, 38 MPa for lodgepole pine, 65 MPa for
  sugar maple and 44 MPa for paper birch. Health is below 1 for dead or decayed wood.

  *Sanity check:* an 80 kg person hanging 1 m out on a birch limb breaks it if r ≤ (4M / πσ)^⅓ ≈ 2.8 cm, i.e. a
  branch thinner than about 6 cm across. That matches intuition, so no hand-tuned threshold is needed.

- **Deliberate breaking.** The player grabs a point and applies a force (pull, or hang plus bounce). Every joint
  between the grab point and the stem gets M = F × arm, and the first joint over its limit breaks. Dead branches
  snap at the collar. Live ones tear, and a live branch too stout to break simply bends.
- **Break results.** The part beyond the break becomes a fallen branch item, the debris the near field already
  draws, now with real provenance. A stub stays: its length depends on where the break was, and it is `broken`
  in the delta.
- **Pushing through foliage.** Each joint is a damped angular spring with k = 3EI/L, where E is the stiffness
  (Young's modulus), I = πr⁴/4 and L is the segment length. The body's capsule pushes segment capsules near the
  player, and children ride on their parents (forward kinematics, as in the skeleton). Only a few dozen joints
  near the player are live at once. This generalises today's tall-shrub springs (`updatePlants`).
- **Branches as terrain for the body.** Segments thicker than about 3 cm [guess] that pass within body height
  become stems for the locomotion system: low limbs to duck under, step over, grab or stand on. They feed the
  same `supportAt` and `ceilingAt` queries the gym already tests. Thinner ones are pushed aside.
- **Branches on fallen trees.** When a tree falls, its whole graph rotates. Segments driven into the ground are
  `broken` (the crushed side). The rest stay and **prop the log**, a real effect: fresh logs ride on their limbs
  for years. Live branches on the up side may keep growing upward, a slow candelabra on old logs.

## 5. Roots

Built from the same graph with negative orders. Traits per species [known in outline, numbers are guesses]:

| | Fir | Pine | Maple | Birch |
|---|---|---|---|---|
| structural laterals | 5–8, shallow | 4–6 plus a taproot | 6–10, heart-shaped mass | 5–8, shallow |
| zone of rapid taper | 1–1.5 m | 1 m | 1.5–2 m | 1 m |
| depth to rock | follows `soil` from geology | | | |

Above-ground exposure is decided per root segment [choice]: exposed where depth to the soil surface is below
zero. That happens on shallow soil over rock (roots run across bedrock and around boulders, using `rockSupport`),
on the downhill side of slopes (erosion), on stream banks, and on wet ground (shallow rooting). Exposed roots are
collision stems for the body: trip lines, steps, and handholds on rocky slopes.

**Buttress and collar flare** come from the first root segments, replacing the fixed `BUTT_PROFILE`.

**Root wad.** When a tree uproots, the plate is the set of root nodes within the plate radius. That radius comes
from the root graph (from soil depth and the laterals), and the same set rotates up with the stem. The wad mesh
is those roots plus a soil-and-rock clump hull around their bases. Outside it, broken root ends stick out. Plate
size, the shape of the wall and the shallow-rooted-on-rock look all come from one model.

**The pit (divot).** Pits are already written into the heightmap, but on the 2 m terrain grid with a radius of
about 1 m, so they are barely resolved. That is likely why uprooted trees don't leave a visible divot. The pit
will be sized from the actual plate (same radius, depth ≈ plate thickness) and written into the 0.5 m near-field
terrain as well. Over centuries it fills and the mound slumps, as now.

## 6. Stumps

A stump is a graph split at a stem node, with a top shape from the cause [choice]:

| Cause (already in the stand simulation) | Height | Top |
|---|---|---|
| storm snap of a live stem | 1.5–6 m | jagged splinter fan, torn fibres |
| a snag rotting and breaking low | 0.3–2 m | soft, rounded, often hollow |
| snag top breaking | stays a tall snag | broken top |

Old stumps:
- decay inside first (hollow), and moss covers them;
- sometimes carry **nurse seedlings**, a recruitment rule the simulation can use;
- keep their root graph, so exposed roots still show.

Uprooting leaves no stump, only the pit.

## 7. Vines

A vine is a plant whose segments grow **along hosts** [choice]. Strategies [known]:
- **twining**: a helix around a stem or branch segment, which needs host radius under about 10 cm for most twiners;
- **tendril or hook scrambling**: drapes over shrubs and low branches;
- **root climbing**: hugs bark, e.g. ivy;
- **woody lianas**: climb to the canopy, then hang in loops between crowns. Temperate examples are wild grape and
  Virginia creeper.

Generation walks the host graph: it follows host segments upward, picks the next host where crowns touch, and
spans gaps with a sagging curve (a catenary). The vine's mass adds to its hosts' `load`, so a heavy vine can tip a
weak branch over its limit, the climber-induced break from requirement 2. Thick lianas are later candidates for
climbing and swinging. Leaves are kind 3e.

## 8. Rendering

- **Near (under about 40 m).** Tapered tubes per segment, merged per plant, with a joint-index attribute on each
  vertex so the few live joints near the player can deflect (GPU skinning from a small joint texture). Foliage
  units are instanced per kind.
- **Mid.** Baked variants, instanced and scaled, with the existing shader bend.
- **Far.** Today's card crowns.

The existing near/far level-of-detail switch, tiles and batches stay as they are.

## 8b. What step 1 actually does

**Generator** (`src/plants.js`, built):
- architecture after Weber and Penn (1995): axes grown by per-species rules, filling the crown envelope from the stand
  simulation;
- pipe-model radii, with the exponent fitted to dbh;
- dead branches and stubs below the live crown;
- decurrent leaders for maple and some birch, and forked variants after leader loss;
- foliage units of four kinds, and organs.

Generation takes 0.3–16 ms per plant in node. A mature fir has about 900 segments.

**Rendering** (`src/game.js`):
- Live trees and saplings within 45 m use a library of grown plants. Per species there are 6 size classes, and per
  class shaded, open and forked crowns with 2 seeds each, normalised to unit height and instanced.
- Each tree picks a variant by dbh class and crown length, then is scaled and turned, with the existing lean, sweep and
  sinuosity applied in the shader.
- Further out, the existing card crowns draw the trees, and they hide the trees inside the 45 m ring, so each tree is
  drawn once.

What is not built yet:
- Per-tree skeletons. A tree uses its variant's graph, so a delta for a single tree comes with steps 2 and 3, which
  grow trees near the player individually from their own seed and history.
- Light-driven growth. Crown length stands in for it.

**Cost:** in the default forest, about 1.9 million triangles and about 400 draw calls near the player (roots included),
against 1.5 million and about 360 before the rebuild. What brought it down from the first build's 3 million:
- grown trees within 32 m instead of 45 m;
- no bark on live twigs thinner than 1.2 cm, which are hidden in the foliage;
- fewer tube sides.

**Forks** (revised after play): a decurrent trunk carries on as one dominant leader, and the other leaders leave it one
after another at staggered heights, each curving and kinking. The trunk keeps its girth into the fork; the pipe model
had tapered it to a point there.

## 8c. What step 2 actually does

- **Roots** (`growRoots`). Each tree's root graph is grown from its own site: soil depth, slope, wetness and rock. Roots
  are stored relative to the local ground surface, so the game drapes them over its terrain and over outcrop rock.
  - The structure has 4–9 structural laterals, depending on species, with a zone of rapid taper, side roots and
    sinkers; pine also has a taproot.
  - Exposure follows two rules [model choice; numbers are guesses]:
    - The buttress: every lateral leaves the stem above ground and sinks over 0.6 + 0.03·dbh metres. It forms the
      trunk flare.
    - A site term: shallow soil, wet ground, rock and the downhill side of a slope keep a root at the surface for longer.
  - Roots are generated the first time a tree comes within 24 m of you, and kept.
  - Exposed segments that stand more than 3.5 cm proud and are thicker than 2 cm become low solids your feet step on.
- **Root wads.** The plate is the root graph within the plate radius, turned up with the stem. Laterals snap off at the
  rim, and fine roots rot away first. A smaller soil clump sits round the collar.
- **Pits** are carved into the 0.5 m ground. The bowl is the size and depth of the root plate (`plateRadius`,
  `plateThickness`, shared with the wad), slightly upwind of the base. A mound forms where the plate stood and slumps
  as it rots. Pits fill over centuries.
  - Measured in the default world, 75-year-old pits are 0.4–0.6 m deep relative to the ground around them.
- **Stumps.** A snag broken below 70 % of its live height gets a splintered top over a root flare. Those under about
  1.5 m are solid you can step or climb onto, and they keep their roots.

What is not built yet:
- Stumps from snags that fell whole. The deadfall step drops the whole stem from its base, so a stump there would
  overlap the log's butt. It needs the fall to start from the break height.
- Hollow, rotted stumps and nurse seedlings.
- Roots on logs that weren't uprooted.


## 8d. What step 3 actually does

- **A tree's graph in the world.** Each tree near you uses its variant's graph seen through its own placement: the
  instance transform and the stem bend the shader applies (`bendLocal` is its CPU twin). The world segments are cached
  per tree.
- **Limbs as obstacles.** These limbs become tapered solids:
  - live limbs from 2.5 cm radius, or dead ones from 3.5 cm;
  - any part lower than 2.4 m above the ground.

  The movement rules already treat solids like these as hung stems, so you duck under them, step or vault over them,
  or stand on them. Thinner limbs are foliage you pass through. Pushing them aside branch by branch is not built yet;
  saplings still bend as a whole.
- **Breaking** (`PL.breakCheck`). A load is applied at a point on a segment. Every joint between there and the stem is
  a cantilever root: its moment is |r × F| and its stress is σ = 4M / (π r³). The joint fails when σ exceeds the green
  wood's modulus of rupture times its health:
  - live wood: 1;
  - dead wood: 0.45;
  - a dead limb at its collar, where it rots first: a further 0.6.

  Tested in node: 80 kg hung 1 m out breaks a live birch limb of 2.8 cm radius or less (the design's sanity number),
  and a dead one up to about 4 cm. Loads come from two places:
  - **Deliberately.** Look at a branch within 2.1 m and press B or the Break button. The load is a hang-and-bounce of
    1.4 body weights. If it holds, a message says what fraction of the breaking load you reached.
  - **Under you.** Standing on a limb loads it with 1.25 body weights, checked four times a second.
- **What a break leaves.**
  - The tree's delta records the broken segment. The tree is then drawn by its own mesh, the variant's buffers without
    the triangles of that subtree. A stub remains up to the joint.
  - The piece that broke off is turned roughly level about the joint and dropped onto the ground, keeping its leaves.
    Its thick parts become solids.
  - Deltas live in memory for the session; they are not saved yet.
- **Branches on fallen trees.** For whole logs under 30 years old and at least 12 cm dbh, near you:
  - A graph of the tree's size is turned with the stem, including the co-dominant leaders of forked crowns.
  - Limbs driven more than 0.35 m into the ground are crushed.
  - The rest are shed over the years: shoots first (about 4 years), then thin limbs (7), mid limbs (14) and thick
    limbs (30). They leave one-segment stubs.
  - Fallen trees show all their twigs. Their foliage is green in the first year and rust-brown until about the third.
  - Limbs thicker than 3 cm are solid.
  - Like roots, they are grown a few per frame within a time budget, and drawn from one reusable buffer.

  Lodged (hung-up) trees keep their crowns too, in the air.

**Brush** (revised after play). Every branch segment of a fallen tree, and the low limbs of standing trees, that
crosses your body's path from shin to chest holds you back:
- **Weights:** twigs under 1.2 cm radius count 0.8, branches under 2.5 cm count 1.5, thicker ones 3. Fresh foliage
  (under 3 years) up to doubles the twig weight.
- **Slowing:** walking speed is divided by (1 + 0.32 · total), and never falls below 30 %. Your head is jostled in
  proportion.
- **Snapping:** dead twigs in the way snap as you push, a few every 0.4 s.
- **Solids:** fallen-tree limbs from 2 cm radius are solid, down from 3 cm.

Tested in the gym: walking 5 s across the crown of the 2-year fallen fir covers 6.8 m against 8.0 m on open ground,
and snaps 15 twig segments.

**Breaking** also works on fallen trees' branches, which count as dead wood. The aim is forgiving for touch screens:
the button picks the nearest branch roughly in front of you within 2.4 m, and shows its diameter. World-space foliage
(fallen trees and broken-off pieces) no longer sways in the wind; the wind term scaled with absolute height.

The gym gains two stations, "Fallen fir, 2 years" and "Fallen maple, 12 years". Both are for looking; nothing is
scored.

## 8e. More species and more variety (built)

Seven species now, up from four. Following §2, each new species is a table row, not new code: a row in `SPECIES`
(stand simulation, `worldgen.js`), `ARCH` (architecture, `plants.js`) and `ROOTS`, plus colours in the game.

| | Spruce | Oak | Aspen |
|---|---|---|---|
| niche (stand simulation) | wetter, cooler, poorer ground than fir; very shade tolerant | drier, fertile ground and upper slopes; mid tolerance; long-lived | a short-lived pioneer that seeds in from afar; intolerant of shade |
| crown | a narrow spire (`spire` envelope) | wide, low and open (`spread`), splitting low into 3–4 leaders | short and round, high on a clean pale bole (`column`) |
| habit | limbs droop from the stem and turn up at the tips; branchlets hang in curtains from the long limbs | sympodial: limbs and leaders zig-zag, and long level limbs sag | short upswept limbs, sparse small leaves |
| roots | a thin, shallow plate | deep, with a taproot and many sinkers | shallow, wide-running laterals |
| wood (USDA Wood Handbook, green) | white spruce: E 7.4 GPa, MOR 39 MPa | northern red oak: E 9.3 GPa, MOR 69 MPa | quaking aspen: E 5.9 GPa, MOR 35 MPa |
| edible or useful | new tips, inner bark, gum | acorns (leached), bark tannin | inner bark, catkins |

Other stand traits: storm-kill multiplier `wind` (spruce 1.3, oak 0.7, the rest 0.85–1.05); log decay (oak 1.6×,
aspen 0.55×).

**Traits instead of switches** [choice] (the "practical structure change" in `extensibility.md`). Code that branched on a
species' `kind` now reads row traits:
- `crownA`: the crown radius coefficient;
- `crownF`: the live crown share in a stand;
- `keepLow`: how far a young open-grown tree keeps live limbs low;
- `pale`: white bark;
- `isConifer(sp)`: needles versus leaves.

`kind` now only picks the far-crown card archetype.

**New growth rules**, each a field on an `ARCH` row. A row without the field grows exactly as before: the four original
species give identical node lists, checked by hash at six sizes each.
- `zig` (degrees): **sympodial** growth. At each node the shoot tip aborts and a side bud carries on, so the axis turns
  to alternate sides. Used for oak limbs, branches (`sub.zig`) and, at 60 %, its leaders.
- `sag`: long, level limbs bow under their own weight. The far-half curve drops by sag × (length / 3 m) × sin(angle).
  This is a growth-time stand-in for the static deflection in §2, step 6.
- `sub.hang` (radians): branchlets turn toward the ground, scaled by the length of their limb, so long lower limbs carry
  curtains and short top limbs don't (spruce).
- `split.curve`: how co-dominant leaders bend; the old fixed range is the default.

**One-sided crowns** (gap-seeking, §2). The stand simulation already leans a stem toward the light gradient across its
crown. It now also keeps that gradient's direction and strength (`form.gx`, `gz`, `pull`). A broadleaf or pine with
normalised pull above 0.8 (about the most lopsided 15 % of candidates) uses a fourth library shape, `one-sided`
(`growPlant({ side: 0.75 })`):
- limbs toward the light grow up to 55 % longer;
- those on the far side are shorter or missing;
- leaders swing toward the light.

The tree is turned so that side faces the gradient. Fir and spruce keep their shape (strong apical control).

**Measured** (seed 1, `standStats`, basal area share of stems ≥ 10 cm):

| world | Fir | Pine | Maple | Birch | Spruce | Oak | Aspen |
|---|---|---|---|---|---|---|---|
| mesic granite (default) | 27 % | 14 % | 11 % | 11 % | 9 % | 17 % | 12 % |
| dry sandstone | 1 % | 79 % | 2 % | 4 % | 0 % | 8 % | 6 % |
| wet basalt | 32 % | 0 % | 44 % | 5 % | 12 % | 4 % | 4 % |
| mesic basalt | 14 % | 0 % | 60 % | 3 % | 3 % | 15 % | 5 % |

Before, the default world was fir 40 %, pine 22 %, maple 19 % and birch 19 %.

Other measurements, default world:
- One-sided crowns: 1,007 trees. The mean cosine between each crown's offset and its light direction is 0.93.
- Grown variants in the library: 253, against at most 144 before.
- Load time and frame time are unchanged within run-to-run noise: about 6 s and 16–22 ms in software rendering, both
  builds.
- Generation takes 0.4–14 ms per plant for the new species. A mature oak has about 1,300 segments.

## 8f. Regions, seasons, and trees that aren't the "normal tree" (built)

Eighteen species now. A **region** (a world setting: cool temperate, the default; Mediterranean; mountain) picks the
species pool and shifts the climate:
- Mediterranean: site moisture −0.12, snow ×0.15.
- Mountain: moisture +0.04, snow ×1.6.

Within a region, the stand simulation sorts species by site as before (moisture, fertility, elevation), plus two new
niche traits:
- `riparian`: favours stream banks and wet hollows instead of avoiding them. Streams alone cover only 0.2 % of cells,
  so wet hollows (the wetness index) count too.
- `rocky`: tolerates rock and thin soil that keep other trees out.

| species | region | what makes it look different | bark |
|---|---|---|---|
| willow | temperate (riparian) | weeping: long whips hang from every limb; short, often divided trunk | furrowed |
| juniper | temperate, Mediterranean, mountain (rocky, dry) | several leaning, twisting stems; fluted, lumpy base; blue berries all year | shaggy strips |
| wild cherry | temperate | tiered pseudo-whorls; white blossom (Apr–May), dark red cherries (Jun–Aug), red in autumn | glossy, banded lenticels |
| rowan | temperate, mountain (rocky uplands) | small, often two-stemmed; cream flower heads (May–Jun), orange-red berries (Aug–Nov) | smooth grey |
| plane | temperate, Mediterranean (riverside) | massive lumpy base, low spreading split | flaking camouflage plates |
| olive | Mediterranean | many-stemmed, spiralled, burled and fluted trunk; silvery leaves; olives (Sep–Dec) | fissured grey |
| cork oak | Mediterranean | low, broad, crooked crown | thick cork in a net of red fissures |
| stone pine | Mediterranean | a clean stem under a flat-topped umbrella | orange scaly plates |
| strawberry tree | Mediterranean | crooked, many-stemmed; flowers and red fruit together in autumn | thin red bark peeling to green |
| larch | mountain | drooping branchlets; needles turn gold in autumn | scaly |
| bristlecone | mountain (rocky ridges) | rope-twisted, lumpy stems; a third of its limbs dead; foxtail needles | silver deadwood with narrow live strips |

**Generator** (`plants.js`, each an optional `ARCH` field; the original four species still grow identical graphs, checked
by hash):
- `upright`: gravitropism of the stem (default 0.6). Low values let stems wander.
- `stemZig`: sympodial zig-zag of the stem.
- `stems`: extra stems from the base. They hang off the first stem segment, so the pipe model fuses them into one
  swollen bole.
- `dieback`: a share of live limbs grown dead.
- `sub.hangAll`, `maxK`, `seg`: weeping whips.
- `umbrella`: a crown envelope, flat-topped and widest high up.

**Trunks** (`barkMesh`):
- `lumps`: burls, as a few interfering waves round and along the stem.
- `flute`: ridges.
- `twist`: spiral grain, turning the flutes and the bark pattern.
- `swell`: a bottle-like base.

Rough stems get 12 sides and rings about every 0.18 m. Normals are recomputed from the bumped surface, so the lumps
shade. Collision still uses the plain radius.

**Bark patterns** (`bark`, drawn in the near-tree bark shader from the bark's own coordinates):
- smooth;
- plates;
- shaggy;
- peeling;
- cork;
- banded;
- papery (now on birch);
- strip;
- scaly (now on pine and spruce too);
- fissured.

Each pattern is a colour multiplier around the texture mean, so the species' bark tint still sets the hue. Far trunks
and fallen logs keep the plain texture.

**Seasons** (a world setting: spring = May, summer = July, autumn = October):
- **Flowers and fruit:** `ARCH.show` lists them with their months and colours. In season they are tinted cards at the
  shoot tips, berries hanging in bunches and flower heads all over the crown. Month ranges may wrap the new year.
- **Autumn colour:** deciduous species turn in autumn: maple red, birch yellow, aspen and larch gold, oak russet, cherry
  and rowan red, plane brown-yellow.
- **Spring:** spring leaves are fresher.
- **Colour without a new shader:** the game measures the leaf texture's mean colour once. Autumn tints and flower or
  fruit cards are set so texture × tint averages to the named colour.

**Wind flagging.** On exposed ridges (exposure > 0.45) a tree of any species uses the one-sided crown turned downwind
(`W.windDir`). Its windward limbs are short or missing, as on real timberline trees.

**Measured** (seed 1, basal area share of stems ≥ 10 cm):

| world | composition |
|---|---|
| temperate, mesic granite (default) | fir 15, oak 13, pine 12, plane 10, aspen 9, willow 9, maple 8, birch 8, cherry 5, spruce 4, juniper 4, rowan 2 % |
| temperate, wet basalt | plane 25, maple 24, willow 19, fir 15 % … |
| temperate, dry sandstone | pine 69, juniper 10, oak 7 % … |
| Mediterranean, mesic granite | stone pine 21, pine 20, oak 19, plane 14, olive 11, cork oak 11, juniper 2, strawberry tree 2 % |
| Mediterranean, dry sandstone | pine 55, stone pine 25, juniper 7, olive 6 % … |
| mountain, mesic granite | fir 26, larch 22, spruce 12, birch 11, aspen 11, pine 8, bristlecone 5 % … |

Other measurements:
- Wind-flagged trees: 300–560 per world, about 3 %.
- Load time: 7.0 s against 6.4 s before (software rendering), from more variants and finer trunk meshes.
- Frame time: unchanged within noise.
- Movement gym: still 31/33.

The species' niche numbers are guesses tuned for a plausible mix. The wood values for willow, juniper, cherry, plane and
larch are from the USDA Wood Handbook (black willow, eastern redcedar, black cherry, American sycamore, western larch).
Those for rowan, olive, cork oak, stone pine, strawberry tree and bristlecone are guesses.

Not built yet:
- Ground cover doesn't know the region: the Mediterranean floor is as lush as the temperate one.
- Far card crowns use three shapes for every species.
- Winter (leaf-off) is not a season option.

## 9. How we check it (the plant gym)

Each item is a plant-gym station: a fixed configuration with an expected outcome.

- **Specimens.** A row of each species at three ages, open-grown and shade-grown, side by side. The check is by
  eye, plus numbers:
  - crown radius against `crownRadius()`;
  - height to the lowest live branch against light history;
  - the pipe-model exponent measured over the graph.
- **Determinism.** The same seed gives an identical node list (hashed), and a delta replays to the same result.
- **Load.** Hang 80 kg at given points; branches thinner than the critical radius break at the predicted joint.
- **Uprooting.** Plate radius equals pit radius, and the root wad's bounding shape equals the hole.
- **Locomotion.** A low limb you duck under, a limb you step over, a log propped on its branches, exposed roots on
  a rocky slope. These go into the existing gym.

## 10. Order of work

1. **Skeleton and leaves.** The graph, generator and leaf kinds for the four species, near rendering plus baked
   variants, and the specimen gym. Visual payoff first, no mechanics yet.
2. **Roots, stumps and pits.** The root graph, exposed roots as body obstacles, wads from roots, pits in the near
   terrain, stump tops.
3. **Branches in the world.** Low limbs as obstacles and holds, pushing, load and breaking (deliberate and
   load-driven), stubs and fallen pieces, branches kept on fallen trees.
4. **Vines.** Host-walking generation, load on hosts, leaves.

Steps 3 and 4 need no change to the data structure from step 1, which is the point of settling it now.

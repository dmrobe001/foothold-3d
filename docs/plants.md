# Plants: design for a branched, rooted, breakable plant model

Status: **steps 1 and 2 built** (skeletons, leaves, edible organs as data, near rendering, specimen stations; roots, wads, pits, stumps); steps 3–4 are design. This replaces the "Trees: forks, branch hierarchy, stubs" sketch in
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

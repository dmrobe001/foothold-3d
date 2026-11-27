# Physics of what the body touches (prototype)

Goal: walking past anything is a physical interaction. Things bend, break, or make you duck, climb, lean, shimmy or go
round. There is no "brush slows you down" factor. Only what the body is close to is simulated, plus what is falling.

## What is built

- **Solver** (`src/physics.js`): plant branches as elastic rods, solved with XPBD (extended position-based dynamics).
  - Particles sit at segment ends.
  - Bend constraints pull each segment toward its rest direction as carried by its parent's current rotation. The
    stiffness is a cantilever's, k = 3EI/L³, and the parent shares the correction, so bending spreads toward the root.
  - Segments do not stretch.
  - The body is six kinematic capsules: two legs, torso, head and two arms.
  - Each step is 4 substeps × 2 iterations. Gravity is omitted for attached branches, because their rest shape already
    includes their sag.
- **Breaking:** a joint snaps when its bending strain r·θ/L exceeds the wood's limit. The limit is MOR/E from the
  species table, × 4 for live wood and × 1.2 for dead [guess]. A snap goes through the same path as a deliberate break:
  the subtree is removed, and the piece drops and becomes solid.
- **Push-back:** each touching segment pushes back with the branch's stiffness out to the contact point,
  k_eff = 3EI/ℓ³, times its deflection. Walking cannot push harder than about 250 N, so you slow and stop as the force
  rises from 60 to 250 N. You stop only when the branch genuinely won't bend or break.
  - In node, a torso walking through a 1.5 m horizontal birch branch at its middle gives these results:

    | Branch | Result |
    |---|---|
    | 6 mm, live | bends, pushes back about 1 N, springs back |
    | 6 mm, dead | snaps |
    | 15 mm, live | snaps at about 50 N |
    | 30 mm, live | pushes back about 800 N, a wall |

  - Brushing past a branch's tip, every one of them slides off and recovers.
- **Waking and sleeping.** Every 0.2 s, each limb subtree is woken if any of its segment ends lies within 1.7 m of the
  body (vertical distance weighted 0.6). For saplings the whole plant is woken. This covers standing trees and the
  branches of fallen trees, capped at 1,500 segments.
  - A group sleeps once it has been untouched for 1.5 s and has come to rest. Its object then returns to shared
    instanced drawing.
- **Threading.** The solver runs in a Web Worker created from a Blob URL. Results come back one frame later as a
  displacement per segment end. Where workers are not allowed, it falls back to the main thread.
  - The performance panel shows physics milliseconds, the thread, the number of segments and the push-back force.
- **Drawing.** A simulated object gets its own mesh and a small float texture, one texel per segment. Its vertex shader
  adds the displacement of the segment each vertex belongs to (`aNode`).
- **Cost:** 1,000 segments, all in contact, take 3.6 ms per frame on the development machine. A phone core is perhaps
  2–4× slower, and this runs off the main thread.

## Falling pieces (rigid bodies)

A piece that breaks off (deliberately, under load, or snapped by the physics) becomes a free rigid body, simulated in
the same worker step as the rods.
- **Shape and mass.** It is made of capsules, the thickest 40 of its segments. Each segment counts as a thin rod for
  the inertia tensor about the centre of mass (parallel axis plus L²/12), with green wood at 800 kg/m³ and a little
  mass for foliage.
- **Motion.** Gravity, slight air drag, and a quaternion integrated in 4 substeps per frame.
- **Ground and trunks.** It collides with a 16 m heightfield of the top surface under it (ground, logs, rocks, stumps,
  fallen branches) and with standing trunks as vertical cylinders.
  - Contact uses impulses at spheres along each capsule, with restitution 0.25 for hard hits (0 when slow) and Coulomb
    friction 0.6.
  - Rolling resistance and rest damping let it settle. It is baked in place once it has been still for 0.4 s, or after
    15 s.
- **Branches it falls through.** Every limb with a segment inside the column it falls through is woken as a rod
  group. A woken branch is simulated only while a capsule can reach it.
  - The rods are pushed aside like the body pushes them.
  - They push back on the piece with impulses: their cantilever force times the substep, capped at 4 kN.
  - They snap when strained past their limit, and what snaps becomes another falling piece, so a heavy limb cascades
    through a crown.
  - Live wood's limit is now 2.5 × MOR/E; green wood fails at roughly 1–2 % strain. Dead wood's is 1 × MOR/E.

Measured in node:
- A 1.6 m, 3 cm limb (3 kg) dropped from 6 m snaps a thin dead branch it falls through, bends past a thin live one,
  and is deflected 4 m sideways by a thick live one. It settles flat after 3.6–9 s.

Measured in the gym (main thread, the development container):
- A 15 m limb broken from the big open maple rattles down through the crown with about 2,400 contacts over 3–4 s. It
  snaps five more limbs from its own tree and branches from a neighbour, and had up to 10 pieces falling at once, all
  settled.
- Physics cost peaked at about 6 ms per step with 1,450 woken segments, mostly asleep.

Up to 12 pieces fall at once; beyond that a piece is placed directly on the ground as before.

Pieces do not collide with each other, and log sides are only a heightfield, so a piece cannot slip under a hung
log.

## The body pushed back

The body is ten capsules for the branch solver: thigh, shin, upper arm and forearm on each side (from the last solved
skeleton, so knees and elbows stick out where they are), torso and head. The solver reports the force each capsule
takes, time-averaged over its substeps (contacts come and go between substeps, so a single pass misses most of them).
`bodyFeedback` in game.js low-passes those forces (60 ms) and turns them into displacements, each against a stiffness
of its own and capped:

| part | moves | stiffness | cap |
|---|---|---|---|
| arm (forearm + half the upper arm) | hand target | 650 N/m | 0.35 m |
| torso + head, sideways | head sway | 2600 N/m | 0.14 m |
| torso and head, front/back | torso lean | 380 N·m/rad (lever 0.45 m torso, 0.75 m head) | 0.4 rad |
| head and torso, downward | crouch | 3200 N/m | 0.22 m |
| swinging leg (shin + half the thigh) | foot sideways, and up when pushed back | 1400 N/m; 500 N per metre of extra lift | 0.18 m; 0.35 m |

The give lowers the overlap, which lowers the force, so branch and body settle where they push equally. The stiffnesses
are guesses chosen so that the 250 N a walk can push gives a visible but bounded shove. Measured forces are small for
most of what is near the ground: twigs on a sapling push back under 0.01 N, a 12 mm live fir limb about 5 N on the head
before it snaps. So the effect shows mainly against thick limbs, which is the intent.

## Stepping on branches

A foot comes down on the highest branch segment under it, up to 0.45 m above where you stand, then weight goes on
and everything under it that cannot hold you gives way in turn, top down (`crunchFoot`):
- **snaps**: `PL.breakCheck` with 1.15 body weights at that point. The node that fails may be further in (a whole limb).
  It breaks 50–100 ms after the foot lands, quicker the more overloaded it is.
- **bends away**: it would hold, but its sag under your weight (moment-area method along the branch back to the stem:
  each segment turns by M·len/(E·I)) exceeds 0.25 m, so it slides out from under the foot after 120 ms.
- **holds**: the foot stays on it, sunk by its sag (up to 0.12 m); the shin capsule presses the rod down to match.

Between them the foot drops under gravity, and the pelvis follows the stance feet, so the eye takes the crunch. Candidates
are the rest-pose segments of standing and fallen trees within 3.2 m, at least 4 mm in radius and not upright.

Crown length now depends on light for small trees (`crownFrac`): an open-grown tree under 25 cm keeps live limbs nearer
the ground, by species shade tolerance (fir 1, maple 0.8, birch 0.4, pine 0.3). Before this, a 10 cm open-grown fir's
live crown started 2.4 m up, so there was little in reach to push through or step on.

## Everything near the body

**What is simulated.** Every plant segment within 0.4 m of a body capsule, plus its path back to whatever rigid thing
carries it (a trunk or fallen stem; for a sapling, the ground) and, for a twig cluster of 12 segments or fewer, the rest
of it (`wakeNodes`). One group per plant. When the set grows, the group is rebuilt with the state of the nodes it keeps
(the solver's `carry`), so nothing pops back to rest. An awake group lets go of nodes that are back at rest (under
1.5 cm displaced); a sleeping one shrinks to what is near. A break rebuilds the group without the lost subtree, keeping
the rest's state (`physRegroup`); before, the whole plant was dropped and went rigid for a few frames. Segments not
simulated that hang off simulated ones move with their parent (`inheritDisp`).

**Small plants.** Shrubs, tall shrubs, herbs, ferns and seedlings had no graph. Each geometry now gets a proxy skeleton
fitted once (`proxyTemplate`): k-means clusters of its vertices, a three-segment stem from the base out to each cluster
and on to its farthest vertex (seedlings: a central stem with side shoots). Each vertex is bound to its nearest proxy
segment and moves with that segment's displacement, interpolated along it. Near the body a plant is drawn as its own mesh
and its instance is hidden. Stem stiffness: shrubs E 6 GPa, ferns 0.8 GPa, herbs 1 GPa, with stem radii from plant
height [rough]. Their stems kink (the joint frees) rather than break off.

**Grass, sedges and leaves** are too soft to push back. Every foliage material pushes any vertex inside a body capsule
out to its surface, less near the plant's rooted base (`bodyGuard` in the shader, the ten capsules as uniforms).

**Rigid things.** Standing stems (their own leaning, tapering segments), fallen stems and roots are capsules for the
limbs (`staticPush`). An overlapping limb is moved out by the whole overlap: a hand onto the surface, a swinging foot
over or round, the chest and head bodily. The push relaxes over 0.25 s, so a hand put on a trunk stays there. Feet are
never placed inside a trunk.

**No tunnelling.** The solver sweeps the body capsules from where they were last step to where they are now across its
four substeps. A final contact-only pass ends each substep with nothing inside the body.

**Contacts.** `body.contacts` holds, for each hand and foot, the point, normal, what it touches (branch, trunk, log,
root, ground, rock) and the force in newtons (from the solver for branches; body weight shared between planted feet).
With the body shown, a dot marks each contact, coloured by what it touches.

**Measured** (`physics.clipScan()`: body capsule vs plant segment overlaps deeper than 1 cm, sampled every third frame,
main-thread solver, the development container):

| walk | before | after |
|---|---|---|
| forest, 60 s | 704 (702 shrubs, ferns, seedlings) | 8 |
| fallen fir, 2 years | 61 | 0 |
| sapling in the way | 35 | 4 |
| sapling thicket | 101 | 19 |

What remains is 3 mm twigs touching the body near their base, where the contact can only move the far end, and (on the
worker) a frame of latency. Cost: about 50 simulated nodes in ordinary forest (under 2 ms per step); the thicket wakes
about 800 and costs 4 ms on the main thread here, 10–20 ms on the worker with the renderer competing for the same CPU.

## One contact rule for everything

Before this, roots, wad roots and loose wood followed different rules from branches. Roots were a static mesh; only those
over 2 cm thick and 3.5 cm proud of the ground were registered at all, and then only as walking surfaces. Wad roots
were baked into the terrain tiles and had no collision. Sticks on the ground were walking surfaces only. And even for
branches the body never gave way: contact always moved the rod by the whole overlap, however stiff.

Now every object near the body is one of three things, and contact with the body follows one rule for all three:

| object | what it is | the overlap is shared by |
|---|---|---|
| anything attached: branches, saplings, shrub and fern stems (proxy skeletons), roots out of the soil, wad roots | a rod (`PhysicsCore` group) | stiffness: the rod takes kb / (kb + k_eff), the body part the rest |
| anything loose: sticks, twigs and limbs on the ground, broken-off pieces | a free rigid body (woken when touched) | mass: the piece takes m_b / (m_b + m); pressed into the ground it lies on, the ground refuses and the body takes that part |
| anything fixed: standing and fallen stems, rocks, stumps | rigid | nothing moves it: the body part takes it all (the same rule with k = ∞) |

k_eff is the rod's cantilever stiffness at the contact, 3EI/ℓ³ with ℓ from its anchor. kb is how readily the body part
gives way (N/m): arm 650–900, chest and head 2600, swinging leg 1400, planted leg 30000. m_b is the mass behind it
(kg): arm 2–3, swinging leg 8, planted leg 60, trunk 45. These are guesses.

The body part gives way inside the solver step, as each contact is resolved, so later substeps see it moved and the
rod only ever takes its share. Before this, four substeps against a body that moved once per frame handed the rod the
whole overlap anyway. The body's share (`capD`) then moves the posture directly, with no spring: hands, chest lean and
sway, crouch, the swinging foot (over more than round), and a planted leg's knee. Rigid contacts are checked again
against the freshly solved pose in the same frame.

**Roots.** A root system is a graph like a crown (`treeRoots`, for standing trees and for wads, which are now built as
root graphs near you and hidden in the tile mesh within 24 m). Buried segments are held by the soil. An exposed run that
dives back in is pinned where it enters, so an arch is held at both ends. Exposed roots are footing too: the same beam
check as a branch, with the anchor wherever the soil (or the plate) holds it, not the stem.

**Breaking is the same everywhere.** A joint past its strain limit separates and what it carried falls as a piece:
branches, roots, wad roots, shrub stems. Before this, a broken root or shrub stem stayed on with its joint free.
Segments no body could bend measurably (tip stiffness above 2 MN/m) are held where they are, as soil holds a root,
because two solver iterations cannot make a chain that stiff. Without that, a millimetre of numerical give at a 17 cm
joint read as breaking strain.

**Measured** (`clipScan`, now covering roots, wad roots, loose wood and rocks too, main-thread solver):
- Exposed root 14 cm thick: the feet step up onto it; it moves 2 mm; no overlaps.
- Exposed root 1.2 cm thick, held at both ends: it moves 0 mm; the swinging foot is lifted 19 cm over it; no overlaps.
- Wad, climbing over: the thick roots do not move; thinner ones bend past their limit, snap and fall as pieces. Before
  the in-step give, an 8 cm root moved 68 cm.
- Standing stem against the arm: 0 overlaps (5 before the same-frame check).
- Forest, 60 s: 13 overlaps in 1200 samples across all eight categories, mostly the first frame after touching a
  stick, before the solver has it.

## Free objects: rigid bodies joined where the wood bends

Anything not attached is a free object: a piece that broke off, loose wood once touched, a root or shrub stem that
snapped, and every fallen stem within 12 m (asleep until something wakes it). Before this, a free piece was one rigid
body: a bent or branched piece could only tumble whole, and fallen stems were scenery.

**Model** (`PhysicsCore.addFree`, built by `makeFree`): rigid bodies joined at the points where segments meet, solved
with XPBD for rigid bodies (Müller et al. 2020: positions and orientations move, then each constraint corrects them
through the generalized inverse mass 1/m + (r×n)·I⁻¹(r×n), and velocities follow from the change). Segments are fused
into one body where the wood is too stiff for any load here to bend it measurably (joint stiffness κ = EI/L above
5×10⁴ N·m/rad) or the child is a twig under 4 mm. A joint holds its two bodies together at a point and resists turning
from their rest relative orientation with compliance 1/κ; it breaks when the torque it carried over the step (the vector
sum of its angular impulses, divided by the step) exceeds MOR · health · πr³/4.

**Contacts** act at the contact point, with friction: ground (soil stiffness per contact point 4×10⁵ · r · length N/m,
so about 50 kN/m under a 0.8 m section of a 30 cm log and a few hundred under a twig), fixed scenery, each other, the
body (shared by mass), and branch rods (shared by mass, as momentum). Contacts with the ground and fixed things keep 20 %
of a rebound, and resist rolling (spin about axes along the ground decays at 4/s). A cylinder therefore rolls because
friction turns it; a bent or branched shape cannot, and flops. Joints damp their own vibration (relative spin decays at
25/s). Thin segments' inertia about their own axis is floored at a tenth of that across them; without that, a twig's
million-to-one ratio made the solver unstable.

**Forces at points.** A planted foot on a free object presses it with its share of your weight, and rides on it: held
where it was planted in the body's own frame, carried as it moves, and you with it. A push presses at the hands.

**Sleep.** An object sleeps once no part has moved more than 2 cm (or turned about 6°) in a second, or after 20 s. Asleep,
it is solid to everything else; a touch, a load or a hit wakes it. Fallen stems near you start asleep; the first time one
wakes it gets its own mesh, its instance in the tile is hidden, and its fixed walking surface is replaced by one that
moves with it. Fresh fallen trees that still carry their branches (as rods anchored to the stem) stay put for now.

**Measured** (Node unless noted):
- A 30 cm log dropped 1 m: lands, no breaks, asleep within a second.
- An L-shaped branch dropped 1.5 m: flops onto its flat side keeping its shape; peak joint torques 0.1–0.6 of their limits.
- A log across a log, 1 m short arm: 785 N on it does nothing (the log's own moment about the pivot is about 1070 N·m);
  1400 N tips it.
- In the gym ('Seesaw: a log across a log'): standing on the raised end, it tips; your end goes from 1.04 m to the ground,
  the far end rises to 1.27 m, and you ride it down.
- A maple limb broken 6 m up: 22 bodies, lands, lies flat, some joints snap.

### Calibration (second pass)

- **Friction:** sliding μ 0.8 on soil and litter, 0.7 bark on bark.
- **Rolling resistance** as soil deformation does it: each contact applies a torque Crr · r · N against the roll (N
  the contact's normal force from the solver), Crr 0.25 on the forest floor and 0.08 bark on bark. A big log nudged
  on the ground rolls a little and stops; it no longer rolls like a can on concrete.
- **Beds:** where an object already rests in the ground when it is made, its own copy of the ground is shaped to it
  (its underside carved in, at least one grid cell wide). A log half sunk into the soil lies in its trough: touching it
  wakes it without lifting it (measured: 0.0 cm rise, 1.8 cm shift walking over a log sunk 15 cm), and rolling it means
  lifting it out.
- **Decay:** a log's wood follows its decay fraction fd (years down over the time a stem that size takes to rot):
  density 550 · (1 − 0.45 fd) kg/m³, MOR × (1 − 0.8 fd), E × (1 − 0.6 fd) [rough: rots take most of the strength
  before most of the mass].
- **Overlap slop:** objects tolerate 8 mm of overlap before pushing apart (logs in a pile were placed slightly into
  each other), and one wakes another only by pushing it 2 cm. Before this, waking one log woke its whole pile.
- **Every fallen stem 3 cm and up** near you is an object, including fresh ones that still carry branches: those are one
  object with their branches (branches under 1.5 cm ride rigidly on their parent). While asleep its branches stay rods,
  so walking through its twigs is as before; it comes alive from your weight, a push, or a hit on a part 1 cm or thicker.
- **No mesh swap:** a log is drawn by its own instance in the terrain tile, which follows the stem's pose.
- **Force at the right part:** a thin pole is several jointed bodies; your weight is now applied to the body under your
  foot. It used to go to the first body whatever the foot stood on, which threw a pole into the air.

### Breaks that hang on, quick sleep, no size thresholds (third pass)

**What breaks off.** A joint past its limit snaps clean off only if it is dry (dead wood) and under 1.5 cm in radius
(`BREAK_R`). Anything green or thicker gives way like a greenstick fracture and hangs on by a splinter:
- branch rods: the joint keeps a hundredth of its bending stiffness, and everything beyond it now feels gravity
  (attached rods otherwise carry their sag in their rest shape), so it droops and hangs;
- free objects: the joint's correction is split into twist about the branch, kept at a fifth of its stiffness, and
  bend, which keeps 1/10,000 (nearly free).
Dry wood is stiffer (E × 1.25), stronger (MOR × 1.3) and brittle (fails at 1.0 × MOR/E, green at 2.5 ×), before decay.

**Sleep, aggressively.** Branch rods untouched for half a second and still (under 5 cm/s) stop being simulated, keeping
their displacement. One that has a joint hanging on is never dropped or shrunk (it would spring back to its unbroken
shape). A free object sleeps after half a second without moving 2 cm; more than 2 m from your body and slower than
0.3 m/s, after 0.3 s; after 8 s regardless; never while a force (a foot, a push) acts on it.

**No thickness thresholds for contact.** Every part of a free object meets the ground, fixed things, other objects, its
own other parts (candidates from a 0.5 m grid of their boxes) and your body. Fresh fallen trees keep their branches as
jointed bodies down to 4 mm, as broken-off pieces do. (Thresholds that remain: twigs under 4 mm ride rigidly on their
parent, and the walking surface only counts parts 1.2 cm and thicker.)

**Rebounds** are damped only after an impact (approach faster than 0.3 m/s); lifting off is free. Before this, a lever's
end could hardly leave the ground.

**Measured:**
- A green maple limb broken 6 m up: one object, 0 clean breaks, 5 of 9 joints hanging on, asleep after 7 s.
- Walking through the gym's sapling and thicket stations: 0–4 small dry pieces snapped off each, 1–5 plants left with a
  joint hanging on; physics at most 10 ms.
- Forest walk: 0–4 free objects awake at a time, 3–9 ms of physics (main thread, the development container).
- Lever (Node): 785 N on the short end does nothing, 1400 N tips it to the ground.

## Meshes that follow what breaks (fourth pass)

Thin lines after breaks had three causes, each measured on a forest walk (25 s, scripted, main thread):

**Broken-off pieces were thrown by the solver.** A position-based solver turns every correction into velocity: an
overlap of 5 cm removed in one 1/240 s substep is a 12 m/s throw. Pieces that broke off inside other branches, the
ground or their own tree were flung (one dry 6 kg piece: 33 m/s nine frames after it broke; thousands of vertices
ended more than 60 m away). Objects put to sleep with joints still stretched (a gap of 16 cm on a hanging limb) were
thrown the same way when they woke. Now a contact may cancel an approach in full, but pushes apart only from a budget
of DEP = 2 m/s × h per body per substep, shared by all its contacts (a long piece sampled at many points along the
ground gets no more than a short one). Joints may close a gap that is opening in full, but an old gap only at DEP; a
bend left from before is undone at no more than 20 rad/s beyond the bodies' own relative turning. A joint that gave
way (a splinter) damps the swing across it more strongly (80/s, others 25/s). As a last guard nothing moves faster
than 20 m/s or turns faster than 40 rad/s. The cap is on how far a contact moves things, not on the overlap: soil is a
spring here, and capping the overlap let heavy logs sink through it.

**A joint that snapped inside a free object never split its mesh.** The triangles that bridged its two parts stretched
after them however far they went. They are now removed when the joint breaks.

**Shrubs and seedlings sent broken-off vertices 100 km down**, so any triangle shared between a kept and a broken part
drew a line to the horizon. Their meshes now drop those triangles, as trees and roots already did.

**Every segment is drawn as a rigid piece.** Before, each vertex was shifted by its segment's end displacement, so a
limb that turned through a large angle tore away from its parent. Now each segment's base is carried by its parent's
motion (rotation about the parent's base) and the segment turns by the least rotation that takes its carried axis onto
where the solver has its end: a vertex p goes to a' + q(p − a), and its normal turns with it. A piece that breaks off
starts where it was drawn, not at its rest shape.

Two more sources of throws, found by replaying a fresh fallen tree that was thrown as it woke: the allowance to cancel
an approach was given again to every sample of one overlap (now one budget per body), and friction was bounded by the
overlap's depth rather than the push it got (a 42 cm overlap allowed large slides). Every rod touching a free body now
shares one budget of DEP per step (sixty twig contacts from all sides had added up to 13–20 m/s). A fresh log's branch
rods never meet that log's own parts (they are the same wood, drawn twice until it wakes). A body already deep in a
free object (a log waking around your legs) pushes it out at walking pace.

**One connected piece of a shrub's mesh stays on one chain of its segments.** Vertices were bound to the nearest proxy
segment, so a leaf or frond could straddle two sibling segments and tear when they parted.

**Measured (forest walk, 1500 frames sampled every 6, scripted, main thread):**

| | before | after |
|---|---|---|
| plant triangle edges stretched > 15 cm (all samples) | 1,269 (up to 1.3 m) | 2 (up to 0.23 m); a second walk 17 (up to 0.40 m) |
| free-piece triangle edges > 15 cm longer than when it broke | 94,076 (up to 93 m) | 0 (up to 0.04 m) |
| free-piece vertices more than 60 m from you | 3,854 | 0 |
| fastest part of a fresh fallen tree as it wakes | 13–24 m/s | 1–5 m/s |

Lever, drop and roll tests unchanged (785 N does not move the lever, 1400 N tips it); gym 40/40; thicket stations at
most 12 ms of physics.

## Weight (fifth pass)

Loose wood read as toothpicks. Measured on a forest walk (every loose piece: its peak speed, the speed of its centre
of mass upward, and its peak spin against sqrt(g/L), the rate at which a stick of its length tips under gravity):
pieces resting still left the ground at 1–2 m/s; a 526 kg, 7.3 m log rose at 5.3 m/s and bounced; small sticks spun
3–17 × sqrt(g/L). None was given an initial velocity: the solver put the speed in.

We judge size by time scale: a thing that moves or turns faster than sqrt(g/L) for its size reads as smaller (the
reason film miniatures are shot at high frame rates, slowed by about the square root of their scale).

- **The push-out cap was a distance per substep, not a speed**: an overlap that took several substeps to clear added
  speed in each. It is now a speed (no push once the contact parts at DEP), and DEP is 0.5 m/s, not 2.
- **Split impulse** (as Box2D and Bullet do): only the part of a contact's correction that cancels an approach changes
  velocity; clearing the overlap that remains moves the body and its previous pose together, so it adds no speed. Under
  a spinning stick's end an overlap kept coming back and fed it a little speed every substep (one 1.6 kg stick reached
  11 m/s on flat ground).
- **Your body** gives a loose piece at most a walking pace (1.5 m/s) as speed; the rest of an overlap moves it aside.

Measured after (same walk): the 526 kg log rises at 0.2 m/s at most and does not bounce; a 31 kg piece 0.03 m/s;
nothing faster than 1.1 m/s; sticks of one body spin under 2 × sqrt(g/L). Thin jointed sticks still reach 5–9 ×
sqrt(g/L) in a single segment: their joints flex quickly (open). Lever and drop tests unchanged; gym 40/40.

## Energy audit (sixth pass)

`foothold.physics.audit()` (main thread) turns on an energy account for every awake free object: kinetic (from the
velocity, or between stages from the motion since the substep began, which is what the velocity will become), gravity,
bent joints (½θ²/α with the solver's own compliance) and pressed soil (½d²/α per ground sample, as the ground model has
it); stiff wood-on-wood contact energy is not counted. Each stage's change is added to `f.au` (integrate, joints,
ground, static, body, pair, vel, rods, ext); the stages telescope to the whole change, so in a dissipative system any
positive total not paid for from outside (your body, feet and pushes, plants) is a solver error, and the stage says
where.

**Found:** a fresh fallen tree left alone loses energy every second and sleeps (Node replay: −4936, −741, −156, −36,
−7 J in successive seconds). On a forest walk the jiggling tree was being fed **4–6 kJ every second by living plants**
under it: a branch or root touching a free object handed it a burst of velocity, and roots in the soil and stems too
stiff to bend counted as immovable, so they gave the full budget every step in whatever direction the overlap pointed.
The ground and joints burned it off as fast, so it never settled.

**Fixed:** a branch or root now meets a free object as any contact does (split impulse): an impulse only stops the
object moving into it (against a root, fully inelastic), and the overlap left is cleared by moving the object without
speed. The jiggling tree's peak kinetic energy fell from 10–23 J to 2 J, then 0.1 J. The speed, spin and bend-recovery
limits are gone (fresh tree waking: at most 2 m/s without them).

**Your body is a force-limited actuator, not a kinematic pusher.** Stepped-on logs jittered and carried on. The audit
put nearly all of it on the body stage, not your weight (feet: 12–56 J; legs: 1,750 then 9,100 J in half a second
climbing onto a 538 kg log, which reached 1.2 m/s). The body is driven by input, so a shin that met a log came back
into it at walking pace every frame, and the overlap was pushed out of the log however heavy it was. Now a body part
(mass as before: 60 kg for a planted leg, 8 kg swinging, 45 kg trunk) meets a free object in an inelastic impulse from
its swept velocity, all parts together delivering at most 400 N over the step; the reaction is added to the push-back
that already stops you against a stiff branch (60 N slows you, 250 N stops you). The overlap left is shared by mass:
the object's part moves it without speed, the rest you yield. Measured on the same climb: 9 and 3 J from you, peak
kinetic energy 22 J (was 415), asleep a second after you step off; on a forest walk the body's input to the fresh fallen
tree fell from 43 kJ to 2 kJ in a second. Seesaw still tips under you; gym 40/40.

**Still seen (open):** your foot pressing a branch into the soil puts energy into the soil spring (up to 40 kJ in a
second, burned off by the ground, no visible motion): the body's share of a contact uses the object's mass, not whether
the ground holds it. Two logs generated overlapping are pushed apart by the overlap clearing (potential energy without
motion, about 1–3 kJ a second between a 1.5 t and a 0.5 t log). A settled object's energy creeps by under 2 J a second
(the overlap clearing lifts it slightly).

## Modal plants (replacing the branch rods)

Every plant near you (trees, saplings, fresh fallen trees' branches, exposed roots, shrubs and seedlings) is now a set
of **branches**, each one bending mode of a cantilever (src/modal.js). A branch is a chain of segments of one branching
order. Its tip stiffness is k = 3EI/L³ (E of its wood, dry ×1.25; I from a radius two-thirds of the way from tip to base);
its effective mass is its own and everything it carries weighted by the deflection shape squared, plus leaves on end
branches; ω = √(k/m), at most 8 Hz (a faster ring is flicker at 60 frames per second), damping ratio 0.1 (shrubs 0.15).

- **Shape and pose.** Deflection φ(s) = s²(3 − s)/2 (a tip-loaded cantilever). Each segment turns by the slope where it sits
  (at most 1.5 rad), carried by whatever carries its branch, so a large bend turns segments rather than stretching them.
  Drawn with the same per-segment turn texture as before.
- **Motion.** Each branch is a damped oscillator with an exact update about the equilibrium its loads set: it cannot blow
  up or gain energy on its own. A deflected child pulls its parent (k·u at its base, as a generalized force), so a touched
  twig shakes the bough. Asleep after half a second still.
- **Contact.** A body part overlapping a segment moves it out, the point giving way through every branch from there to the
  anchor as springs in series (compliance φ(s)²/k each); the push is shared by compliance, the force is displacement over
  the summed compliance, at most 200 N per body part (beyond that the body yields, and the push-back slows or stops you
  as before). Two passes, so a large bend's shortfall is caught. Falling pieces push branches aside too (they feel
  nothing back yet).
- **Breaks.** A branch base fails when the moment on it (a contact's force times its arm, or the tip load its bend holds)
  beats the wood: MOR·πr³/4, dry ×1.3 and it snaps clean off when under 1.5 cm radius; green ×2.5, rising to ×10 for
  stems under 1 cm radius [rough: thin green stems bend into far tighter curves]; shrub stems ×6. Otherwise it gives way:
  stiffness ×0.01, it hangs under its own weight (at most folded back 1.5 lengths).

**Measured against the rods (scripted, main thread, the development container, per whole game step):**

| | rods | modal |
|---|---|---|
| forest walk, mean / worst step | 8.8 / 85 ms | 6.2 / 33 ms |
| sapling thicket, mean | 2.7 ms | 1.2 ms |
| single sapling, mean | 1.1 ms | 0.6 ms |
| clips over 1 cm per scan, thicket / single sapling | 0.23 / 0.04 | 0.90 / 0.19 |
| thicket: pieces off / joints hanging | 1 / 0 | 4 / 5 |

A single branch in Node: 15 Hz before the cap against 16 Hz from Euler–Bernoulli for the bare uniform beam; a static
20 N tip load deflects it exactly F/k; the drawn tip lands at the deflection. Gym 40/40.

**Not yet:** clipping in dense saplings is worse than with the rods (stems pushed near their base are stiff, so the body
takes the overlap; this is what the movement planner is for). One mode per branch overstates how far a tip swings when
pushed near the base (by about 2× from beam theory). No wind. The rod solver and its worker code are still in the source,
unused.

## Solid by default: plants read before the body gets there

`planScan` (game.js) looks along the next 1.6 m of your path, every frame you move, for plant segments the body would pass
through (a body column 0.26 m in radius, 0.3–1.7 m above the feet). Each is asked, through the modal model, how hard it
would have to be pushed to clear the body: the compliance at that point through every branch to its anchor
(`MD.compliance`). Under 150 N it is walked through and bends; otherwise it is an obstacle: overhead (above 1.2 m) it joins
the stems you duck under (`ceilingAt`), lower it joins the stems you step round (`steerAround`). If nothing works, the
push-back stops you. Plants are made live 1.8 m around you so the scan can ask them.

Contact changes that came with it:
- the whole body pushes with at most 300 N in a frame (each part at most 200 N; a light contact always gets 30 N, so
  a twig is not left unmoved because a stem used the budget);
- a branch at its limit passes its share of a push to the others in the chain;
- each segment can also bend at its own base (a local bend, springing back over about 0.3 s without ringing) for what one
  bend of the whole branch cannot clear;
- four contact passes a frame: moving a parent turns what hangs off it, so the linear share is only close.

**Measured (gym, five parallel walks each, scripted, main thread):**

| | rods | modal + planner |
|---|---|---|
| sapling thicket: clips over 1 cm per scan | 0.21 | 0.33 |
| single sapling: clips per scan | 0.04 | 0.05 |
| distance made, thicket / sapling | 11.1 / 11.2 m | 10.9 / 11.2 m |
| whole step, thicket / sapling | 3.2 / 1.1 ms | 1.7 / 1.0 ms |
| per walk: joints hanging, pieces off (thicket / sapling) | — | 7, 1 / 1, 1 |

Forest walk: 7.3 ms a step on average (rods 8.8), worst 39 ms (rods 85). Gym 40/40.

What remains is almost all thin side twigs (under 6 mm) against the torso and arms, by one to two centimetres: the
contact is solved before the next frame's motion, and the chain's shares converge over a few passes. Ducking and
stepping round come only from stiff stems; nothing yet chooses to push a stiff stem with the hands.

## Push

The Break button is now Push. Held, it presses on whatever your hands reach in the direction you look, ramping to 300 N
along your view: a branch, root or shrub stem (a point force on the rod), a free object (a point force on its body), or
something fixed (nothing moves). The same force acts back on you: hands on the contact point, the trunk shifted and
leaned back by F/2600 N/m and 0.45 m · F / 380 N·m. It lets go when the contact leaves your reach. Measured in the gym:
a sapling's branch moved 13 cm under 300 N; a log rolled 49 cm away and out of reach; a standing trunk did not move and
the body leaned back 0.28 rad.

## Not yet

- Small pieces resting on springy branches can fidget for a while before they sleep (two integrators meeting).
- Plants with a joint hanging on keep their simulation group for as long as you are in the area (they would otherwise spring back whole).
- A planted leg still yields only at the knee, so a shin can stay a few centimetres into a log that rolls against it.
- The body's share of a rod contact arrives one frame late (the solver runs on a worker).
- Twigs touching near their base can stay a few centimetres inside the body.
- A planted leg takes its share at the knee only; it does not step aside.
- Shadows of a bending branch stay at its rest pose.
- The movement planner does not yet choose between pushing, ducking and going round from stiffness.

## Which parts of a moving object collide (simplified)

The body meets every part of everything. A free object (a log that came alive, a piece broken off, loose wood) meets
everything else only through its **colliding parts**. A part collides if its radius is at least 8 cm, or at least half
the object's thickest part. Everything else counts as not there. "Everything else" here means the ground, fixed scenery,
other objects, the object's own other parts, and branches on standing plants.

So a moving fallen tree meets things with its trunk and its very large limbs. A branch that breaks off meets them with
its thick section as it falls, and the smaller branches on it pass through. Mass and stiffness still count every part,
so the pieces swing and turn as before. Only their contacts are dropped.

Measured in the forest: four of the thickest low limbs broken off nearby trees and left 6 s to settle (`physics.useMain`):

| | before | now |
|---|---|---|
| parts in total (18 free objects) | 356 | 356 |
| parts that collide | 356 | 60 |
| deepest a small branch ends up in the ground | 5 cm | 144 cm |

The small branches end up in the ground because nothing stops them. Step time didn't change measurably (7.8–9.7 ms
across runs either way).

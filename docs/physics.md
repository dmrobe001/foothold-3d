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

## Push

The Break button is now Push. Held, it presses on whatever your hands reach in the direction you look, ramping to 300 N
along your view: a branch, root or shrub stem (a point force on the rod), a free object (a point force on its body), or
something fixed (nothing moves). The same force acts back on you: hands on the contact point, the trunk shifted and
leaned back by F/2600 N/m and 0.45 m · F / 380 N·m. It lets go when the contact leaves your reach. Measured in the gym:
a sapling's branch moved 13 cm under 300 N; a log rolled 49 cm away and out of reach; a standing trunk did not move and
the body leaned back 0.28 rad.

## Not yet

- Small pieces resting on springy branches can fidget for a while before they sleep (two integrators meeting).
- An awake fresh fallen tree's twigs under 1 cm do not meet the body (its branch rods are retired when it comes alive).
- A planted leg still yields only at the knee, so a shin can stay a few centimetres into a log that rolls against it.
- The body's share of a rod contact arrives one frame late (the solver runs on a worker).
- Twigs touching near their base can stay a few centimetres inside the body.
- A planted leg takes its share at the knee only; it does not step aside.
- Shadows of a bending branch stay at its rest pose.
- The movement planner does not yet choose between pushing, ducking and going round from stiffness.

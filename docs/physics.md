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

## Not yet

- Twigs touching near their base can stay a few centimetres inside the body (see above).
- Rocks do not push the limbs.
- Shadows of a bending branch stay at its rest pose.
- The movement planner does not yet choose between pushing, ducking and going round from stiffness. Feedback shoves
  the body but does not steer it.
- Stepping uses rest-pose branch positions, not where the simulated rod currently is.

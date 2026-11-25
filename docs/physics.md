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

## Not yet

- Shrubs, grass, leaves and roots. Shrubs need graphs; they still use the old spring. Grass still bends in the shader
  around the feet only.
- Shadows of a bending branch stay at its rest pose.
- The base ring of a side branch follows its parent's end, not the exact attachment point, which shows as a slight kink
  under large bends.
- The movement planner does not yet choose between pushing, ducking and going round from stiffness. The body walks its
  path, and either bends what is in the way or is stopped by it.
- Falling pieces as dynamic bodies. They are still placed on the ground.

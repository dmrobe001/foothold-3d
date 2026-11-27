# sim: the game's body in a physics engine

A 3D simulation of the game's body (same bones, same collision capsules) in MuJoCo, with a sampling planner that
finds motions by minimizing effort under physics. The aim is to find movement (crossing barriers, crawling, climbing)
from physics and effort instead of hand-written keyframes, and later to feed what it finds back to the game as templates.

## Running it

```
pip install mujoco numpy          # MuJoCo 3.x or later; tested here with 4.0.1
node sim/export_gym.mjs           # the gym's stations (src/gym.js) -> sim/stations.json
python3 sim/body.py               # build the body model; prints its size
python3 sim/drop_test.py          # milestone 1: limp drop, held stance, throughput
python3 sim/mpc.py stand          # planner holds the body standing (3 s)
python3 sim/mpc.py walk           # walk 2 m to a point and stop (records viewer/runs/walk.json)
python3 sim/mpc.py wall 19 [seed] # station 19 (1.1 m wall), unseeded
node sim/export_script.cjs 19 vault          # the game's own vault at station 19 -> sim/refs/vault-19.json
python3 sim/retarget.py vault-19             # ... as joint angles of this body -> sim/refs/vault-19-q.npz
python3 sim/mpc.py seeded vault-19 [seed] [tracking weight]   # the planner, seeded by it
```

The viewer (`sim/viewer/index.html`) replays recorded runs (`sim/viewer/runs/*.json`) in the browser. It loads them by
relative URL, so serve the folder (`python3 -m http.server -d sim/viewer`) rather than opening the file directly.

## The parts

- **`body.py`**: the model.
  - Bone lengths and capsule radii are the game's (`src/skeleton.js`, `bodyCapsules` in game.js).
  - Segment masses are de Leva (1996) fractions of 70 kg.
  - 37 degrees of freedom: a free root; three spine joints of 3 axes each, as the game spreads a bend; neck 2; shoulders
    3; elbows 1; hips 3; knees 1; ankles 2.
  - Each joint is a position servo (a target angle and a stiffness) with its torque capped at a rough human peak. These
    are ballpark figures to tune, not measurements. With servos, a pose is directly a set of controls.
  - Each hand has an adhesion grip of up to 400 N.
  - Every capsule can touch the world, friction 0.8. Pieces of the trunk don't collide with each other (in the game it
    is one torso), and neither do the arms with the trunk.
- **`mpc.py`**: the planner. Sampling-based model predictive control:
  - The plan is a spline of servo targets, with knots every 0.1 s over a 0.8–1.2 s horizon.
  - Each round, 96–128 noisy copies of it are rolled out in parallel from the true state (`mujoco.rollout`, all cores).
    The new plan is the mean of the 8 cheapest, and the current plan is always one of the candidates.
  - The body moves 0.04 s under that plan, then the round repeats.
  - The tasks are costs:
    - `Stand`;
    - `Reach` (walk to a point): walking speed toward it rather than distance to it, which pays for falling; the
      capture point over the feet; head height; effort as squared torque over each joint's peak; smoothness;
    - `Over` (`Reach` plus a waypoint above the barrier's top until the hips are past it). The task knows where the
      barrier is, as the game's `barrierAt` does, but not how to cross it;
    - `Track` (`Over` seeded by a reference motion: a prior on the plan and a tracking cost while the reference runs).
- **`retarget.py`**: a game script as joint angles of this body. Damped least-squares inverse kinematics, frame by
  frame, fitted to the game's joint positions. A joint at its limit is held there and the others take up the motion
  (active set).
- **`export_gym.mjs`, `export_script.cjs`**: the stations, and any way over as the game solves it, exported for the
  simulator. `export_script.cjs` drives the built game headless and needs Playwright.

## What it found (measured on 4 CPU cores)

| test | result |
|---|---|
| limp drop | folds to the floor (centre of mass 0.20 m after 3 s), deepest contact 3.8 mm |
| held stance, servos at standing angles | stands 5 s, centre of mass wanders 2.5 cm, ankles use about 11 N·m |
| throughput | about 80,000 simulation steps a second (320 s simulated per second of computing) |
| planner, standing | holds for 3 s; planning runs about 7× slower than real time |
| planner, walk 2 m | **walks**: alternating steps, arms swinging a little, stops at the goal in 5 s; head never below 1.64 m. Unscripted. Stiff and slightly hunched |
| 1.1 m wall, unseeded | walks up to the wall, rises onto its toes, stays there for 10 s (local minimum) |
| 0.7 m wall, unseeded (with a waypoint over the top) | leans its hips onto the top and stays propped there; around 7 s it swings a leg up behind, the start of a belly-over it never completes |
| 1.1 m wall, seeded by the game's vault | collapses in the first half second: the script is not physically possible for this body (below) |

Findings about the game, from this:
- **The game's bones make a 1.88 m body straight-legged.** It reads as 1.75 m only because it stands knee-bent (pelvis
  0.84 m above the feet on a 0.90 m leg).
- **The game's scripts pass through the body's own limbs.** They were checked only against world solids, never limb
  against limb. In the vault:
  - in its first frame the right hand hangs inside the hip;
  - at 0.3 s the legs are 5.7 cm inside each other;
  - at 0.6 s, with the legs swung over together, they overlap by up to 15 cm, and an arm passes through the pelvis.
- **The scripts ask for more joint range than a person has.** Fitting the vault to this body's joint limits holds the
  right ankle at its limit for 107 of 121 frames. The game's foot bends up about 55°, against roughly 20° of human
  dorsiflexion. Hip abduction and shoulder rotation also bind. Fit error with limits enforced: median 3.1 cm, worst
  11.5 cm (a knee mid-swing).

## Status

Parked. The game uses its hand-built pose sequences (`overScript` in src/game.js). `stances.py` was a first try at
chaining moves between stable stances over the 0.7 m wall (results in `sim/out/stances.json`). Move chaining isn't a
good fit for the game right now.

## Why the walls failed, and what to try next

Unseeded random search around a standing pose doesn't stumble on "hands on the top and spring": that needs many joints
to move together, and on a short horizon every way over looks worse than standing still. In order of promise:

1. **Fix the seed first.** Make the game's scripts free of limb-on-limb overlap (add self-collision to the game's
   `overCheck`, or repair the retargeted poses with a self-collision term in the inverse kinematics), then seed again.
   The seed tells the planner which basin to look in; physics then decides what survives.
2. **Curriculum**: low barriers first (0.5, 0.6, 0.7 m), each solution seeding the next height.
3. **Longer horizons with fewer, coarser knots**, or a gradient polish (iLQG, iterative linear-quadratic Gaussian
   control) on the best sampled plan.
4. **More compute.** MuJoCo's GPU version (MJX, on JAX) would allow thousands of samples per round instead of 128.
   That matters most for unseeded discovery.

Costs are stand-ins. Effort is squared torque as a share of each joint's peak, and recorded runs also report mechanical
work (summed |torque × joint speed|). Neither is metabolic cost. For energy in physiological units, MyoSuite
(muscle-driven models in MuJoCo) or OpenSim Moco are the next step.

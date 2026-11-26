# Movement: traversal by the shape of space

The step planner does not know what things are (stems, rocks, branches). It knows **solids**, how strong they are, and
whether a hand can grip them. Each way of getting through is a **template**: the volume the body sweeps doing it, what it
must bear weight on, and the height change it allows. The planner fits templates to the space ahead and takes the cheapest
that fits. Leaning is the same fit tried at a tilt. Feet never pass through each other in any template.

Body: 1.75 m tall. Landmarks (rough adult proportions): knee 0.50 m, crotch 0.83, hip 0.92, waist 1.05, chest 1.30,
shoulder 1.45, overhead reach 2.2; shoulder width 0.45, chest depth 0.25.

## Gaps (headroom and width)

Every gap must be at least 0.5 m wide unless stated.

| mode | headroom at least | width |
|---|---|---|
| walk | 1.7 m (upright from about 1.8; 1.6–1.8 a stoop) | 0.5 (0.6 natural) |
| shimmy (sideways, legs perhaps bowed) | 1.3 | 0.4 |
| crouch | 1.0 | 0.5 |
| monkey crawl | 0.9 | 0.5 |
| bear crawl | 0.8 | 0.5 |
| hands and knees | 0.6 | 0.5 |
| army crawl | 0.4 | 0.5 (elbows out: 0.55–0.6 comfortable) |

Leaning in any mode is possible where the gap exists at an angle.

## Barriers with nothing to stand on at the top

A barrier too narrow on top to stand or kneel on (a rail, a thin wall, a log), too high to step over, with too little
room under it to crouch through. Its numbers: top height H above your footing, depth D along your way, clearance U under
it, clearance C above its top, the far side's footing relative to yours (Δ), the usable span along the barrier (W),
whether its top can be gripped or pressed, and what load it holds (a hand, sitting, the whole body).

Under:
1. **Crawl under** in the tallest mode U allows (the gap table).
2. **Lean or tilt under**, where a tilt fits and upright does not.

Over, by rising H:

| mode | H up to | needs |
|---|---|---|
| step over | knee height or so (0.5) | — |
| high step over | about 0.7 | D under about 0.4; weight stays on the near foot |
| straddle over (sit astride, swing over) | about 0.9 | W more than shoulder width: chest depth plus bent legs (start at 0.8 m); the top holds sitting weight |
| vault (hands on top) | about 1.15 | top grippable or pressable, holds a hand load; C at least 0.5 |
| roll over (belly on top) | about 1.3 | W at least the body's length (1.75 m); top holds the whole body; C at least 0.4 |
| straddle-mount (climb astride, swing over) | about 1.4 | W at least 0.8; a top to sit on and something to pull on |
| climb over on holds | higher | footholds within a step of each other on its face |
| window (slide through over the top) | — | C 0.4–0.5 between the top and something above; top holds the body |
| none of these | | go round; stop if there is no way round |

The far side matters only to a step over (Δ within a step). Every other way over slides off whatever lies beyond.
(In life you would turn to face the barrier, hang and drop; here the body slides off.)

A width under 0.5 m allows a sideways version of a mode (a sideways step over, a shimmy); under 0.4 m nothing fits.

## The gym

`src/gym.js`: 30 stations of plain boxes and rails, side walls closing each lane so the opening is the only way. Each
names the mode its numbers call for and scores crossing (or stopping, where nothing fits) with no body capsule more than
2 cm inside any solid (exact box distance, `gymPen` in game.js).

Baseline, the movement as it stands (2/30):
- Every headroom tunnel stops you at its mouth, even at 1.85 m: the movement reads the world as surfaces seen from above,
  so a roof over a gap is a 2.6 m wall; it ducks only under round stems.
- Every wall and block has legs 4–28 cm inside it while stepping, vaulting or climbing.
- The narrow gaps let the arms swing 3–10 cm into the walls (nothing turns you sideways).
- The wall in a narrow opening is vaulted although nothing should fit.
- Passing: the rail at 0.5 m (stepped over) and the rail at 1.0 m (vaulted).

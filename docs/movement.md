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

## Step 1: the free-space query and the upright modes (12/30)

- **Exact boxes.** A gym box is a solid that fills one span of height at any (x, z) (`boxSolid`, `boxSpan`): its top is
  footing, its underside is headroom, and what is under a roof is free space, not the inside of a wall. Rocks are solid to
  the ground; fallen stems have their undersides, as before.
- **Ducking under anything.** The headroom overhead (`ceilingAt`) counts the undersides of boxes as of stems.
- **The whole body must fit.** A move is refused if any of ten points across the shoulders and out to where the knees
  reach (0.45 m ahead, 0.28 m either side) has a solid between a step up and the lowest headroom a crawl passes
  (`bodyBlocked`); a top you can climb onto and stand up on (a ledge) is not a wall. A foothold counts only if the leg
  has room above it, every 10 cm back to the body, from knee height to the hip (`legRoom`).
- **The body yields to boxes.** Every body capsule is pushed out of any box through the nearest face, as out of stems.
- **The crouch as the skeleton bends.** The head's height for a forward lean is computed the way the skeleton spreads a
  bend over its three spine segments (it had been treated as one straight rod, so a deep lean left the head 0.4 m too
  high); the back bends up to 1.3 rad; the hips go no lower than 0.45 m on foot; deep down the head follows the back
  instead of craning up; the knees point forward and a little up (with the foot ahead of a low hip they had splayed out).
  Lowest crouch: 1.0 m of headroom.

Passing: walk (1.85 m), stoop (1.65), crouch walk (1.25), deep crouch (1.0), leaning under a sloped roof, a 0.6 m gap, and
stopping cleanly at 0.35 m of headroom, a 0.35 m gap and a 1.8 m wall; the 0.4 m wall and both rails.

Not yet: the crawls (on hands it goes, but in one posture, with thighs 13–17 cm in the roof); the sideways shimmy; every
way over a barrier (the old vault puts legs 15–18 cm inside walls); climbing onto the block works but a shin passes 26 cm
into it; held against a wall, the body still sidles and steps in place, so a shin can touch the mouth of a narrow gap
(3–5 cm). Forest walk unchanged (37.6 m in 25 s).

## Step 2: the shimmy (14/30)

When facing the way does not fit (the shoulders) but a body turned side-on does (0.4 m deep, the hips; from behind the
shoulder to 0.7 m ahead, so it is a gap to go through and not a wall to face; with 1.3 m of headroom), the body turns to
face across the way, first, then side-steps at under half pace: the hips lie along the way, the lead foot steps and the
trailing foot closes up to 0.16 m behind it (the feet never pass), the knees bow out along the way rather than into the
wall in front, and the arms hang from the turned shoulders. (The body's facing had a second owner, the on-hands surface
frame, which pulled it back toward the view every frame; the shimmy now holds it while sideways or turning back.)

Passing now, besides step 1's: the 0.45 m gap (shimmied), and the 0.45 m gap under 1.2 m stops cleanly. Forest walk
unchanged (37.9 m).

## Step 3: the crawls (17/30)

On hands the posture is one crawl scaled to the headroom: the hips from 0.5 m down to 0.13 m; the knees forward under the
body in the monkey and bear crawls (0.8–0.9 m), down onto the ground below about 0.65 m (hands and knees); the elbows back
along the body, tucked and pointing down when flat (the army crawl). Knees and elbows had pointed up, into the roof. The
lowest crawl is 0.42 m of headroom (was 0.55); on hands the body's footprint is 0.48 m wide, so a 0.5 m gap is crawled.
A hand is put down, or reaches up to what is overhead while ducking, only where the line from its shoulder is clear.

Passing now: monkey crawl (0.9 m), bear crawl (0.8), hands and knees (0.65), army crawl (0.45), besides steps 1–2.

Not yet: dropping onto the hands at the mouth of the 0.55 m × 0.5 m gap dips the head 7 cm into the roof's face (the
crawl through it is clean); the 0.4 m wall is stepped over with a thigh 3 cm into it (the limit is 2); every way over a
barrier. Forest walk unchanged (37.5 m).

## Fixes from play (17/30)

- **Feet crossed walking backwards or sideways** (in the wrong order a third to half of the time, legs 15 cm into each
  other): the feet were placed either side of the way you go, not of the body. Now either side of the body, each at
  least 0.16 m on its own side of the other in every mode; a swinging foot keeps 0.2 m out to its side round the standing
  one; a planted foot left on the wrong side (the body turned over it) steps back at once. Measured over 3–4 s each:
  forward, backward, sideways right, back-and-right and walking while turning, no crossing and no overlap; turning on the
  spot 2 cm; sideways left 7 cm (open).
- **The bunny hop over the 0.4 m wall**: the body's height took the top of the 0.2 m wall as footing (its foot-sized
  ring reaches it from 0.24 m away), stood on it, then fell off the far side, and falling parks both feet together. A top
  under 0.5 m deep with footing within a step either side is now stepped over (`stepOverAt`): neither the body's height
  nor a foothold takes it. A step-over swing rises first, holds while it crosses and drops last; a foot left behind
  something the hips have passed comes over at once, the body slows to 0.3 and rises 0.13 m onto the leading leg
  meanwhile. Left: the trailing shin grazes the top by 4 cm.
- **The shimmy refused unless you came at the gap dead straight and centred**, and dithered at the mouth. It is now a
  committed plan (`gapPlan`): measured once (the gap's centre line from narrow free runs across the way, solid both
  sides; its mouth where a side-on body's flanks meet solid), then: walk to a point on the centre line 0.7 m short of the
  mouth, turn side-on in place, side-step along the axis until the body facing the way fits behind and before it, turn
  back. Steering away cancels it. Also: a wall at the edge of the foot-sized ring is beside you, not footing (one
  centimetre off centre in a 0.45 m gap, the ring read the 2.6 m wall as a climb). From seven approaches (straight,
  ±0.15 rad, off centre by 0.1 and 0.2 m, both together): six through, five within 1 cm, one 8 cm before the plan starts;
  at 0.3 rad it does not find the gap (open).
- **Fidgeting at a gap you cannot use** (station 12): the angled moves that take you round a stem were edging you into
  the mouth. With both shoulders blocked ahead (a wall, or a gap too narrow to face) you now stop. Five of seven
  approaches stop clean; off centre by 0.1 and 0.2 m, a leg is 3 and 16 cm into the mouth's corner (open).
- **The rail at 0.5 m** had become a 0.4 m roof (its underside) once the body's height stayed on the ground beside it;
  anything lower than the lowest crawl is now something to go over, not under.

## Leaning and squaring up (from play)

- **Leaning picks a side only if it helps.** Upright, and leaning 0.15 or 0.3 m either way, are each scored by how much
  ducking they still need (a lean costs a little); a lean counts only if the head can go there (no wall at shoulder-to-head
  height on that side), and upright wins unless leaning saves more than 2 cm. Before, it leaned the same way everywhere,
  into the wall when you hugged the high side (a wall reads as no ceiling). Sloped roof, measured: hugging the high side
  0.20 rad (it steps to 0.32 m, as close as the body fits, with a little room left that way), 0.2 m in 0.21, middle and
  low side 0.43 toward the high side.
- **Step across rather than shimmy.** Where facing the way fits a little to one side (up to 0.4 m), the body steps across
  to it; it shimmies only when nothing facing the way fits nearby. (Hugging a wall into a tunnel had set off a shimmy that
  scraped the roof's corner.) Held at an angle against a wall, this slides you along it, round its end if it has one.
- **Squaring up to a barrier you step over** (`crossPlan`): within a metre of a thin top ahead, its near edge is found where
  two lines 0.3 m either side of yours meet it, and the way across is square to that edge; the body turns to face it and
  crosses along it (the legs lift forward over it), letting go 0.5 m beyond. A foothold keeps 0.18 m of toe room before a
  raised edge, so the foot can lift over it. From 0, 0.3, −0.5 and 0.7 rad: facing within 0.01 rad of square over the top;
  a shin within 2–4 cm of the wall, 12 cm at 0.7 rad (the leading foot comes down onto the top: open).

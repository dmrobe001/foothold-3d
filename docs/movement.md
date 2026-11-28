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

## Over or under: steps, mantles and windows

The rule since step 6. Ahead of you there may be several **windows**: places the body could be, each with a floor (the
highest solid under it) and a ceiling. The floor of the window is where the feet go: each foot, when it moves, takes the
highest footing under the window near where it wants to land. Windows are ranked by the effort of getting into them, by
**tier**, lowest first:

| tier | way | where |
|---|---|---|
| 0 | walk, step (up to 0.55 m), stoop | headroom 1.0 m or more, floor within a step |
| 1 | hop; **any mantle** | a top up to 1.7 m |
| 2 | knees | headroom 0.6–1.0 m |
| 3 | crawl | headroom 0.42–0.6 m |
| 4 | climb | the wall climb on holds (rock faces, steep stems): anything higher than a mantle |

Looking down at your feet (pitch below −0.3) takes the way under whenever one fits. The choice is made once per obstacle and
held (step 8).

**The step** is the gait: a foot lifts as high as the rise it is stepping onto needs, up to 0.55 m (`STEP`). A thin top
no higher than that is stepped over (`stepOverAt`), or onto when walking slowly.

**The mantle** is the one way up anything higher, from a knee-high wall to a chest-high root wad, and onto the top of a
climb. `ledgeAhead` measures it along the way you are going (up to 1.6 m ahead): the near edge and the normal square to
it, the top at the edge (H), the depth (D), a foothold for each foot side by side on the top (up to 0.3 m in, or the
middle of a thin top; since step 10, the nearest pair out to 0.8 m past the edge that stands on a window's floor), and
the headroom over them (C, at least 0.42). Only solids count: the ground's own rise is
walked or climbed on hands. The script (in the ledge's frame, from the pose you are in):

1. the hands rise past the edge and come down on it;
2. the **dip**, 0.55 × (H − 1.0), from nothing at the waist to 0.35 m at 1.65 m;
3. up onto straight arms: the pelvis just above the top, the trunk over the hands;
4. the lead knee up, its foot onto the top (the lead side alternates);
5. weight onto it, the trailing foot comes up beside it;
6. the pose the window allows: standing, stooped under what is above, or crouched with the hands down (C under 1.0 m:
   the crawl takes over from there). Under a low window (C under 1.3 m) the trunk goes in near level, head first, and
   the pelvis stays 0.3 m under what is above.

It takes 1.0 s at a knee-high wall and 1.9 s at 1.7 m. Off the far side is ordinary walking: a step down, or a drop.

**The body is soft.** Nothing checks the body's capsules against solids any more (that check, 72 solved poses for each
candidate way over, was most of the cost of walking through fallen crowns). Only the **camera** is kept out: an eye inside
a solid (a 0.12 m ball, a little larger than the near plane) is moved the least distance out of it, down, back, sideways
or up, up to 0.4 m (`guardEye`).

## Barriers with nothing to stand on at the top (before step 6)

The original table, kept for its numbers. Step 6 replaced every way over in it with the mantle.

| mode | H up to | needs |
|---|---|---|
| step over | knee height or so (0.5) | — |
| high step over | about 0.7 | D under about 0.4; weight stays on the near foot |
| straddle over | about 0.9 | W more than shoulder width; the top holds sitting weight |
| vault (hands on top) | about 1.15 | top grippable or pressable; C at least 0.5 |
| roll over (belly on top) | about 1.3 | W at least the body's length; top holds the whole body; C at least 0.4 |
| straddle-mount | about 1.4 | W at least 0.8; a top to sit on and something to pull on |
| window (slide through over the top) | — | C 0.4–0.5 between the top and something above |

## The gym

`src/gym.js`: 30 stations of plain boxes and rails, side walls closing each lane so the opening is the only way. Each
names the mode its numbers call for and scores crossing (or stopping, where nothing fits). Since step 6 it scores the
camera never inside a solid (a 0.1 m ball at the eye, exact box distance); before, it scored no body capsule more than
2 cm inside any solid (`gymPen` in game.js).

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
- **Side-steps are short.** Moving across the way you face (not a shimmy), the stride shortens to 0.4 of a walking one.
  A full stride left each foot 0.7 m behind, so the trailing foot ended up on the wrong side and the no-crossing rule then
  shoved the other foot out, into a wall's corner (sliding along station 12's face and round its end: 8–11 cm, now 0–2);
  sideways left, legs 7 cm into each other, now 0.
- **Swings clear what they pass over, all the way.** A swing in the air is re-aimed every frame to follow the body, but
  its lift was set once at the start: a step begun short of a wall was carried over it at 10 cm. The lift is now recomputed
  on re-aiming (it never drops mid-swing), from the footing every 6 cm along the path (five samples had missed a 0.2 m wall
  on a long step). A foothold also needs room behind the heel when it lands beyond a raised edge, and toe room is now a
  shin-height test against solids across the foot's width (the single line had read a tall wall as no edge and slipped
  past a corner by 5 mm). The 0.4 m wall from 0, 0.3, −0.5, 0.7 rad: 3, 4, 4, 0 cm (was 4, 14, 5, 15).
- Station 12 approached at an angle: you slide along its face and walk round the end of the station's walls (5.7 m out),
  which the rules allow (go round). Stopping in front of it 0.2 m off centre still puts a thigh 6 cm into the mouth (open).
  Gym 18/30.

## Step 4: ways over a barrier (28/30)

(Replaced in step 6 by the mantle; the scripts below are gone.)

Each way over is a **template**: a script of key poses in the barrier's own frame (along its normal from the near face,
up from your footing, along it), giving the pelvis and its frame, the spine's bend, and where the feet, hands, knees and
elbows go. The barrier is measured first (`barrierAt`): its normal (square to the near edge, as for stepping over), top H,
depth D (a top 0.5 m deep or more is a ledge to climb, not a barrier), the footing beyond L, clearance above the top C, and
the span along it W at the top's height with nothing above. The rules of the table above pick which ways may apply; each is
then built from where you stand, solved pose by pose (72 poses over the script; 24 missed clips between them) and kept only
if no body capsule goes more than 2 cm into a solid and the feet reach the ground at the end. The first that fits, in order
of effort, is played: it owns the pose and the eye (in the head) until it ends. Every script is also tried mirrored. A way
over that fits claims a barrier as soon as it is in view (up to 1.7 m), so you don't duck under its overhead part first.

| way | rule | script |
|---|---|---|
| high step | H ≤ 0.75, D ≤ 0.4, \|L\| ≤ 0.4 | lead knee up and out to its side, foot over the top; a small hop carries the hips over while the trailing leg lifts out to the side (a hurdler's trail leg); lead foot lands beyond |
| straddle | H ≤ 0.95, W ≥ 0.8 | side-on, hands on the top; far leg over, sit astride; near leg swings over in front, turn to face across, slide forward off the edge |
| vault | H ≤ 1.15, C ≥ 0.5 | hands on the top, spring, legs together swung over out to one side, land beyond |
| roll over | H ≤ 1.3, W ≥ 1.75, C ≥ 0.4 | press up, belly onto the top lying along it, legs off the far side, slide down facing it (then turn round) |
| straddle-mount | H ≤ 1.45, W ≥ 0.8, C ≥ 0.9 | side-on, hands on the lip; pull up, hook the far leg over, sit astride; then as the straddle |
| window | H ≤ 1.2, 0.38 ≤ C < 0.6 | head first through the gap, level, belly on the top; over the far edge on the belly, hands down, legs over |

What the body's sizes say (measured in the scripts, not assumed): with 0.9 m legs and these capsule thicknesses, the lead
foot of a high step can take weight only once the hips are nearly over the wall's far face, and the trailing knee meets the
near face once the hips come within 0.1 m of it, so between them neither foot can bear weight: hence the hop. The trailing
foot is on its toes as the hips rise. At 0.7 m this is right at the body's limit, as your table has it; 0.6 m with ground
0.3 m lower beyond cannot be stepped (the lead leg cannot reach down past the wall), so it is straddled and slid off.
A hand on a top above the shoulders grips its lip (a forearm from below cannot reach further onto it without crossing the
edge); everywhere else hands rise above a top before reaching onto it, and leave it upward.

Passing now: high step (0.7 m), straddle (0.85), vault (1.1, and the 1.0 m rail), roll over (1.25), straddle-mount (1.4,
and 1.25 in a 1.2 m opening), window (1.0 under a slab), straddle and slide off (0.6 with ground 0.3 and 0.8 m lower), and
stopping at the 1.8 m wall and at 0.85 m in a 0.6 m opening (the vault's swung legs would be 17 cm into its sides). In the
forest the same planner high-steps and vaults logs (75 s of walking: one of each; 6.1 ms a step).

Not yet: climbing over on holds (no station has holds; the 1.8 m wall stops you); the old vault remains only for what
`barrierAt` does not measure. The roll ends facing the wall and turns round as you walk on. Still open from before: the head
dip at station 14's mouth (7 cm) and the forearm climbing onto the block (22 cm).

## Step 5: slowly, a foot goes on it (31/33)

(The step-on way over is replaced in step 6 by the low mantle; standing on a thin top below a step's height remains.)

Two rules from play:
- **Planning assumes every branch holds your weight.** Any branch at least 1 cm thick within 1 m of the ground is now
  solid, on standing trees and fallen ones alike. Before, the cut-off was 2.5 cm live and 3.5 cm dead on standing trees,
  and 2 cm on fallen ones. So the planner steps on these branches, over them, or ducks under them, as it does for logs.
  It never predicts whether one will break.
- **Your weight finds out.** The first time you stand on a branch, it gets the same beam check as a foot coming down on
  one (`branchLoad`). If it snaps, it breaks off. If it bends away, it stops being solid (its physics rod still pushes
  back). Either way it is no longer under you, and you drop.

**Walking slowly** means a careful walk below 1 m/s: hold Q, or push the stick only a little (under about 60%). Walking
slowly toward a barrier puts at least one foot on it instead of over it:
- **Below a step's height (0.55 m):** the gait no longer steps over a thin top (`stepOverAt` is off). It stands on it,
  then steps down beyond.
- **From 0.55 to 0.8 m:** a new way over, **step on**, comes first in the table when slow (rule: H ≤ 0.8 and C ≥ 1.1).
  The lead knee lifts out to its side and the foot goes onto the top. Above 0.55 m the hands go on the top too. Weight
  comes onto the lead foot and the body rises over it. The trailing leg lifts out to the side, passes over the top and
  reaches down beyond, then the lead foot comes off.
- **Higher:** the other ways over already put weight on the top (hands, sitting, belly) and are unchanged.

**Weight during any way over.** A hand or foot the script puts on something carries a share of your weight: a foot
counts 1, a hand ½. As that weight comes on:
- a branch gets the beam check above;
- a loose object (a log near you, loose wood) is pressed through the physics (`freeForces`), so it can roll or slide.

If what a planted hand or foot rests on breaks, or moves more than 5 cm from under it, the script ends there and you
drop ("It gave way under you").

**Measured:**
- Gym: 31/33. The three new stations pass: wall 0.4 m slowly (stood on), rail 0.5 m slowly (stood on), wall 0.7 m
  slowly (step on, deepest 1 cm). The two failures are the old ones: station 14's head dip and the forearm on the block.
- In the forest, walking slowly up to thin fallen-tree branches:
  - a 1.8 cm branch with its top at 0.64 m: step on, and the branch broke under the foot;
  - 1.0 and 2.1 cm branches at about 0.25 m: stood on, and both broke.
- Cost: 6.9 ms a step against 6.5 ms before, over 75 s of forest walking, with 960 branch solids loaded.

## Step 6: one step, one mantle (33/33)

Removed: the seven scripted ways over (step on, high step, straddle, vault, roll over, straddle-mount, window), the
older hurdle vault, the ledge pull-up, and the capsule check on every candidate. In their place: the step (the gait, as
before), the mantle, and the tiers above.

The gym now scores the camera, not the body: `camera` (default on every station) fails if the eye's 0.1 m ball is ever
inside a solid. Stations whose old way over is gone now expect a mantle (`mantle: true`). The 0.85 m wall in a 0.6 m
opening, which stopped you before (the straddle's legs did not fit), is now mantled.

**Measured:**
- Gym: 33/33. Before the camera guard, the crawls at 0.45 m and 0.5 m headroom put the camera 3 and 10 cm into the
  roof, the 1.4 m mantle 5 cm into the wall's face, and the window 36 cm into the slab.
- Forest (seed 1, 40 s of walking in an arc, collisions on): mantles onto a 0.6–0.7 m log and a 1.6–1.7 m top.
  - Plant collisions off: median step 0.6 ms against 0.5 before; 95th percentile 1.4 against 1.5.
  - Plant collisions on: median 1.9 against 1.7; 95th percentile 3.8 against 5.8; 99th 6.7 against 9.8.
  - Frames standing still while trying to move: 1 and 28, against 0 and 79.
- Root wads (walking straight at six of them): three mantled. Tops at the footholds were 0.97, 1.32 and 1.40 m; the
  edges were 0.97, 1.18 and 1.39 m, so the dips were none, 0.10 and 0.21 m. The other three were not taken. Why is not
  yet known: too high, no footholds, or the angle of approach.

## Step 7: every mantle before crawling; steering that commits

From play: any jump up that does not need the wall climb should come before going under on knees or crawling (the tier
table above now has every mantle in tier 1), and pushing through crowns jittered.

**Where the jitter came from (measured).** At one crown the path ran in a 23-frame cycle: walk forward, then thrown 25 cm
backwards by the push-out round a stem (`stemPushOut`: saplings, tall plants and trunks push a candidate point out of
a ring round them), then forward again. Elsewhere the candidate chosen could change every frame: straight on, then a veer
one way, then the other, then a slide along a world axis.

**The rules now (walking; on hands and in a gap plan they are as before):**
- The way taken is an angle off the way you push. Candidates are straight on and veers of 0.35, 0.6 and 0.87 rad either
  way (the slides along world axes are gone). They are tried nearest first to the angle taken last.
- The body turns toward a new angle at most 3 rad/s (`STEER_TURN`). While the angle it has turned to so far does not
  fit, it stands still. Turning the view still changes the way you push at once.
- A push-out round a stem may slide you along it but never throw you backwards, or further than the step. If that is
  all it can do, the candidate fails. Already standing inside a ring, you are eased out at 2 cm a step at most.
- If nothing fits, nothing happens: no search back and forth, and the remembered veer side is not changed.

**Measured** (24 crossings of 8 fallen crowns, 10 s each, plant collisions on, foliage off; same walk on each build):

| | build before step 6 | step 6 (the one played) | step 7 |
|---|---|---|---|
| turning of the path, rad per metre walked | 4.79 | 6.27 | 0.49 |
| reversals (a frame moving against the last) | 477 | 603 | 25 |
| distance walked (m) | 345 | 333 | 312 |
| frames standing still while pushing | 207 | 249 | 448 |
| stop-go switches | 113 | 91 | 113 |

Gym: 33/33. The cost of committing is a little less ground covered (6%) and more time standing still where the way
ahead is closed.

## Step 8: decide once, step down instead of falling

From play: approaching a branch you could go over or under, the body ducked, then changed its mind and went over.

**What the measure showed** (24 crossings of 8 fallen crowns): 10 of 16 mantles began with a duck (up to 0.95 of a full
duck). Two causes:
- **Falling between branches.** Walking on crown clutter, every gap of more than a few centimetres between branches
  was a free fall and a landing (479 frames falling faster than 1 m/s). While falling, no over-or-under decision was made,
  so the body ducked under whatever was overhead.
- **Deciding late and changing its mind.** The ledge was measured only 1.6 m ahead, inside the 1.0–1.6 m the duck looks
  ahead, and the way under was judged only over the next 1.8 m, not across the obstacle.

**The rules now:**
- Over or under is decided as soon as the ledge is within 2.2 m (`DECIDE_AHEAD`), judging the way under across the whole
  obstacle. The decision is held for that ledge. It changes only after the other choice has won for 0.4 s
  (`DECIDE_HOLD`), or at once if the way under closes. A decision to go over survives the ledge dropping out of the
  measure for up to 0.4 s, and falling. While it stands, the body does not duck.
- Walking on your feet, a drop of up to 0.45 m (`STEP_DOWN`) is a step down (the knees give a little), not a fall.
- Edging past something that fits a little to one side is now a diagonal step (forward and across together), not a
  sideways shuffle between forward steps.

**Measured** against the build of step 7:

| | step 7 | step 8 |
|---|---|---|
| mantles that began with a duck | 10 of 16 | 5 of 18 |
| frames falling faster than 1 m/s | 479 | 229 |
| eye height jerk (sum of second differences, m) | 53.2 | 51.7 |
| path turning (rad/m); reversals (steering measure, step 7) | 0.49; 25 | 0.64; 31 |

The eye's jerk barely changed. The routes differ between builds (a small change sends the walk across different
branches), so this total is a rough guide. With the step down but without the diagonal, it was 40.1 (reversals 75).
Without the knees giving on a step down, it was 61.0.

## Step 9: thin branches yield; a steadier head on hands; captures keep the crown

From play (a captured crown, now gym station 34): a branch across the way, top at 1.0 m with 0.84 m under it, branches
underneath. Going over felt right; the body crawled under, ducking fully, then mantled from underneath. While crawling
the head whipped about.

**Why it crawled.** The branch was measured as a ledge 1.4 m out, but the mantle was refused: the window over its top
was 0.14 m, closed by a 5.7 cm branch 1.15 m up, 0.4 m beyond the edge. A body pushes a branch that thin aside. Now
any stem or branch under 8 cm thick (`YIELD_R`, radius 0.04 m) does not close the window over a mantle. (Withdrawn in step 10: every branch is an obstacle again; the window was being measured in the wrong place.)

**Why the head whipped.** On hands, the body turned to face up the slope under it, and the slope was read from whatever
was underfoot. In branch clutter that swings from one branch to the next, and the head, well ahead of the hips, swung
with it. Now on hands the body faces up a slope only if it is the ground's own, or a log at least 0.2 m thick that you
are climbing along; otherwise the way you are going. It turns at most 1.5 rad/s (`QUAD_TURN`). The camera's horizontal
position follows the head through a low-pass (0.18 s, `EYE_LAG`), blended in as the hands come down.

**Captures now include a crown's branches** (the branch solids that exist while plant collisions are on), as logs.
Captured stations kept as tests live in `src/captured.js`.

**Measured:**
- The captured spot, in the forest (plant collisions on): looking ahead it now mantles over the branch; it never goes on
  hands. Looking down (forcing the way under), crawling turned the body 1.06 rad in all (2.17 before), and the camera
  moved 0.64 m sideways (2.09 before).
- Gym: 34/34. Station 34 expects a mantle with no hands. The build before this step crawled, ducked fully, then mantled.
- Crowns (the step 7 and 8 measures): reversals 31 → 12; path turning 0.64 → 0.44 rad/m; mantles that began with a
  duck 5 of 18 → 3 of 19; eye height jerk 51.7 → 42.2.

## Step 10: every branch an obstacle; footholds on windows' floors

The rule asked for: every branch reads as an obstacle, with no exception for thin ones. Then the way over should read
as a series of steps, and the way under as a crawl space that gets shorter as the clutter under it rises. Neither is
forced; both should come out of the general rules.

- **The way under** already worked this way. Its headroom is the ceiling minus the highest footing under it, so it
  shrinks as branches pile up beneath, and it is closed where the floor rises more than a step.
- **The way over** looked for footholds only on the first thing to rise more than a step, at its middle (or 0.3 m in).
  It then required room above a span from 0.3 m before the edge to 0.4 m past the footholds. A branch just beyond, at
  shin height once you stand on the first, counted as a roof.
- **Now** a column of space is read as **windows** (`windowsAt`). Each floor is the ground or a solid's top, not inside
  another solid, with the room above it up to the next underside. A foothold is the highest floor at that spot that is
  raised (more than a third of a step), reachable (up to 1.7 m), and has at least crawling room (0.42 m) above it. The
  pair is searched first at the middle of a thin top (or 0.3 m in), then on out to 0.8 m past the edge, then back
  toward it. The room that counts is above the footholds and the ground just past them, where the body ends up.
  Whatever lies further on is the next step.
- `YIELD_R` (thin branches yield) is gone.

**At the captured crown** (station 34), with every branch solid, the footholds are on the 1.0 m branch itself, with
nothing above them. The 5.7 cm branch that closed the window before is 0.3–0.4 m further on and 0.15 m above that
footing: the next step, not a roof. It still mantles, on its feet.

**Measured:**
- Gym: 34/34.
- Crowns (step 7 and 8 measures), against step 9:
  - reversals 12 and 12; path turning 0.44 and 0.45 rad/m;
  - mantles that began with a duck: 3 of 19 against 4 of 20;
  - eye height jerk 42.2 against 33.6;
  - frames standing still while pushing: 286 against 469. With every branch an obstacle again, more of the way is
    closed.

## Step 11: plausible forces

The request: the skeleton moves only as plausible forces and torques could move it. A little "magic" may hold it up or
track where the player wants to be, but no larger than plausible, so the skeleton does not rattle.

**What it is.** The gait, the crawl and the scripts still produce a target pose each frame. The skeleton shown follows
it, each part accelerating no faster than a plausible force or torque could drive it (`BIO`, `bioPose`, `bioSolve`).
- **The follower, per channel:** it closes the gap toward the target, with the target's own velocity fed forward so a
  steady motion is not lagged. Its acceleration is clamped, and it brakes in time not to overshoot (a clamped spring
  overshoots, and did, pushing the head into the slab of gym station 25).
- **Limits:** acceleration = torque / the inertia it turns, or force / mass. These are rough adult numbers: 70 kg,
  segment masses after Winter's tables, peak joint torques from isometric strength data.

  | channel | limit | from |
  |---|---|---|
  | pelvis (the whole body) | 8 m/s² sideways; 15 up; 10 down | friction 0.8 g; ground reaction up to 2.5 body weights; no faster than falling |
  | trunk about the hips | 40 rad/s² | ~200 N·m over ~5 kg·m² |
  | spine bend | 60 rad/s² | ~150 N·m over ~2.5 kg·m² |
  | head | 300 rad/s² | ~40 N·m over ~0.13 kg·m² |
  | foot (and knee) | 60 m/s² | hip ~120 N·m over ~1.9 kg·m², at 0.9 m |
  | hand (and elbow) | 100 m/s² | shoulder ~70 N·m over ~0.4 kg·m², at 0.6 m |
  | the walking camera | as the pelvis | it rides the body |

  The limits are on acceleration beyond what holds a part against gravity: the support is the allowed magic.
- **Not forward dynamics.** The channels are limited one by one, not solved as one coupled body. Reaction forces
  (a swung leg pushing back on the trunk) are not modelled.
- **Knees and elbows** are limited as joints. After solving, each follows under its limb's limit, and the limb is
  solved again bending toward where it got to (bone lengths exact).
- **Two fixes in the solver** (`skeleton.js`), for both settings:
  - The last 4 cm of a limb's reach is eased in ("soft IK"). Near full extension the middle joint swings fastest for
    the least change in reach.
  - A pole within about 17° of the limb's line blends toward a fallback side: knees forward, elbows back and out.
- **Scripts are timed to the limits** (`bioTime`). Between keys a pose eases with peak acceleration 6·d/t². Each stretch
  of the mantle is lengthened until the pelvis, feet and hands fit. Asked to rise faster than it could, the pelvis
  lagged while the planted foot did not, and the leg folded to 0.15 m between hip and ankle, where the knee flails.
  A 1.4 m mantle now takes about twice as long.
- **The low-window mantle** ends with the trunk level (it ended upright, the head 0.6 m into the slab). The camera guard
  searches up to 0.8 m.
- The knee push from body collisions (applied after the pose is solved) is skipped with plausible forces.

Settings → **Body forces**: Plausible (default) or Unlimited (the target pose as is, as before).

**Measured** (24 crossings of 8 fallen crowns, plant collisions on; the shown skeleton's joint accelerations from
frame-to-frame second differences, m/s²: median / 99th percentile / maximum):

| joint | Unlimited | Plausible |
|---|---|---|
| pelvis | 5 / 117 / 3755 | 9 / 17 / 17 |
| chest | 6 / 128 / 3755 | 10 / 22 / 36 |
| head | 6 / 137 / 3755 | 10 / 33 / 85 |
| hand | 7 / 129 / 744 | 7 / 58 / 117 |
| ankle | 8 / 441 / 2758 | 10 / 112 / 4089 |
| knee | 16 / 875 / 4822 | 17 / 269 / 3484 |
| camera | 3 / 320 / 7010 | 6 / 33 / 1993 |

- The medians rise a little: motion that was jagged is now spread over more frames.
- **Remaining spikes:** the joint maxima for knee and ankle, and the camera maximum (the camera guard moves the eye out
  of a solid in one step). Their 99th percentiles are within or near the limits, not at them.
- **The asked-for pose exceeded a limit** in about a quarter of frames for the pelvis and feet (2374 and 2959 of 14800
  frames, the busiest channels). The gait and controller often ask for more than a body could do; the limits absorb it.
- **Crown measures** against step 10:
  - eye height jerk 33.6 → 20.2;
  - mantles that began with a duck 4 of 20 → 6 of 22;
  - reversals 12 → 31; distance 306 → 273 m (mantles take twice as long: 3077 frames against 1437).
- Gym 34/34. Frame cost unchanged: median 0.6 ms (plant collisions off), 1.9 ms (on).

## Step 12: the body stays with the controller

From play: with plausible forces the body got far from where the controller was. When the controller stopped, the body
flew on what felt like several feet and swung back.

**Why (measured, gym lane 1):** the pelvis and camera followed the controller's position under their clamps. The
controller changed speed at once (stopping from a run asks for 250 m/s² in one frame), so the body lagged and then
overshot. Running then stopping: the pelvis fell 1.09 m behind, and the camera ran 1.06 m past the stop and came 1.12 m
back. Walking: 0.15 m and 0.16 m.

**The rules now:**
- **The controller itself** speeds up, slows and turns no harder than friction allows: 8 m/s² (`CTRL_ACC`).
  - Stopping takes 0.15 m from a walk (1.6 m/s) and 1.07 m from a run (4.2 m/s).
  - Held up by something, the commanded speed bleeds off at the same rate, so a moment's wait while steering turns
    does not make it stutter.
  - A gap plan and the crawl on hands pace themselves and are exempt.
- **The pelvis and camera** follow under their clamps on a 10 cm leash (`LEASH`, `EYE_LEASH`). They are never further
  than that, sideways, from where the controller puts them, with no speed outward past it. A 20 cm leash for the camera
  measured slightly smoother (camera 99th percentile 98 against 108 m/s²) but swung back 11 cm after a run stopped.
- **On hands along a stem:** the stem you are on is kept while it is still under you, and the pull onto its axis is at
  most half the step.
- **A restart** (a new gym station, a teleport) clears the plan state: an unfinished gap plan, the remembered steering
  angle, the held over-or-under decision. These used to carry over, which failed station 14 after 13.

**Measured:**
- Gym lane 1 (camera after the controller stops; pelvis behind the controller while moving):

  | | before | now |
  |---|---|---|
  | walk: pelvis behind / camera past the stop / camera back | 0.15 / 0.15 / 0.16 m | 0.05 / 0.16 / 0.03 m |
  | run: the same | 1.09 / 1.06 / 1.12 m | 0.10 / 1.04 / 0.04 m |

  The camera still travels about a metre after a run is let go of: the controller itself is now stopping at 8 m/s².
- Crowns, joint accelerations (99th percentile, m/s²), against step 11:
  - pelvis 17 and 17; head 33 and 33; chest 22 and 23; knee 269 and 294; camera 33 and 97.
  - The camera is jerkier than in step 11 because the leash cuts; it is still well under unlimited's 320.
- Crowns, steering and ducking, against step 11:
  - reversals 31 → 44; one crossing has 22 reversals on hands. They depend on the order the test runs crossings in, and
    I could not reproduce them in a single crossing.
  - mantles that began with a duck 6 of 22 → 2 of 19; eye height jerk 20.2 → 17.3.
- Gym 34/34.

## Step 13: a continuous mantle, and walking on from it

From play: the mantle stopped at a few poses. With the stick still pushing toward the ledge, it should flow on: one
foot hikes up to one side, the other slips over and plants ahead. Otherwise, the current ending, smoother, standing on
whatever was climbed.

**Why it stopped.** Between two keys each part eased in and out (smoothstep), so every part came to rest at every key.
Timing the script to the force limits (step 11) lengthened those rests. Some keys also held the pelvis exactly where the
previous key had it, while the hands reached or the lead foot planted.

**The rules now:**
- **Keys are waypoints on one curve** (`overPose`). Each number moves through the keys on a monotone cubic
  (Fritsch–Carlson). Its speed carries on through a key unless it turns there or holds still on either side, so a
  planted foot stays planted and nothing overshoots a key.
- **The pelvis never holds still for long.** It settles into the dip while the hands reach and come down on the edge,
  and starts rising over the lead foot as it plants.
- **Two endings, chosen when the lead foot is on the top.**
  - **Still pushing toward the ledge** (the stick or keys within 60° of its normal), and the window over the top is not
    low, and there is a floor ahead (0.42 m past the footholds) with room to stand, from 0.3 m up to 1.2 m down
    (`fwd`): the lead foot is placed up to one side (0.17 m). The weight goes over it and the trailing knee comes
    through. The trailing foot plants ahead, and the script ends mid-stride, with the controller leaving at walking
    pace (1.2 m/s).
  - **Otherwise:** as before, both feet on the top, then the pose the window allows.
  - Both endings share every key up to the lead foot's plant, and are timed to the limits separately (the shared part
    gets the same seconds), so the switch is seamless.

**Measured** (gym walls of 0.7, 1.1 and 1.4 m and the captured crown, station 34; holding forward throughout, or
letting go once the mantle starts). "Stalled frames" means the pelvis below 0.05 m/s during the mantle (after its first
0.1 s).

| | stalled frames, step 12 | stalled frames, now | seconds, now (step 12) | walks on |
|---|---|---|---|---|
| 0.7 m, holding | 11 | 1 | 2.97 (2.50) | yes |
| 0.7 m, let go | 11 | 1 | 2.53 (2.50) | no |
| 1.1 m, holding | 12 | 0 | 3.38 (2.73) | yes |
| 1.1 m, let go | 12 | 0 | 2.77 (2.73) | no |
| 1.4 m, holding | 12 | 0 | 3.12 (3.13) | no: 1.4 m down beyond the wall is more than 1.2 |
| crown, holding | 11 | 1 | 3.90 (2.55) | yes |
| crown, let go | 13 | 1 | 2.58 (2.55) | no |

- The walk-on ending takes longer because it carries the body another 0.36 m forward and down.
- The second after a walk-on covers 1.59 m on the walls, against 1.45 m before (when the body stood, then set off).
  At the crown it covers 0.41 m: the branches beyond close the way.
- Gym 34/34.

## Step 14: the swing (a mantle arrived at a pace)

From play: pushing forward, the legs and torso should swing up to the side. The hands should grab the surface before
you stop, with a bob on the way in and a hop up, not "walk, stop, push up, step over". Leaning in on the approach, you
should almost never stop moving forward, like a parkour move, even onto a high ledge.

**When it applies:** arriving faster than 0.5 m/s (`SWING_V`), pushing on toward the ledge, not walking slowly, and
with at least 1.3 m of room over the top. Otherwise the mantle is as before.
- It starts further out the faster you come: at 0.75 m plus 0.45 m per 1.6 m/s, up to 1.45 m.
- The approach carries on into it: the pelvis enters the script at your speed (`keys[0].vel`, the curve's starting
  slope), not from rest.

**The script** (`overScript('swing')`; keys in seconds, then timed to the limits):
1. lean in, hands coming up, the last step landing (if you start further than 0.62 m out);
2. **the bob**: the knees give and the hands land on the edge, 0.06–0.38 m deep, scaled by height (0.5 × (H − 0.9));
3. **the spring**: up over the hands, the hips swinging out to one side (sides alternate);
4. the legs up level with the top, out to that side;
5. the outer foot down on the top, to one side. Then the ending, chosen here as in step 13: still pushing, the
   trailing foot slips over and plants ahead and you walk on; otherwise both feet up and stand.

**Timing to the limits, revised** (`bioTime`). The step 11 rule assumed every stretch starts and ends at rest (peak
6·d/t²). With motion carrying through keys (step 13) that is far too cautious. Now each stretch's acceleration is taken
from the cubic itself: at its ends, (±6Δ ∓ 4m₀T ∓ 2m₁T)/T², with m the speeds at the keys and the starting speed.
Stretches asking too much are lengthened and the speeds worked out again, until the pelvis, feet and hands all fit.

**Measured** (seconds from the start of the move, which now includes the approach from up to 1.2 m out; holding forward
/ letting go once it starts):

| | step 13 | now |
|---|---|---|
| 0.7 m wall | 2.97 / 2.53 | 2.65 / 2.18 |
| 1.1 m wall | 3.38 / 2.77 | 3.00 / 2.32 |
| 1.4 m wall | 3.12 / 3.12 | 2.65 / 2.63 |
| crown (station 34) | 3.90 / 2.58 | 3.53 / 2.25 |

- Stalled frames: 0–1 per move.
- On the 0.7 m wall the stretches are: approach 0.59 s, bob 0.28, spring 0.26, legs up 0.29, foot down 0.29. Then
  standing 0.2 + 0.3, or walking on 0.31 + 0.61 (the second is the drop down the far side of a thin wall). From bob to
  foot down is about 1.1 s; a practised vault is nearer 0.6–0.8 s.
- What sets the pace is the whole-body limits: 15 m/s² up and 8 m/s² sideways. Raising those is the knob for a
  snappier move.
- Gym 34/34. The gym counts a swing as a mantle.

## Step 15: the swing goes to the lower side; a stiffer landing

From play: the legs should swing toward the lower (more open) side of the barrier, and the landing should be stiffer.

- **Side** (`swingSide`). Each side of the line you take is scored at 0.35 and 0.55 m out, at the near edge and at
  the footholds. The score adds the top's height there, 0.8 for something solid within 0.6 m above that top, and 2 for
  a standing trunk. The legs go to the lower score. Within 0.1 of each other, sides alternate as before. The plain
  mantle still alternates.
- **Landing.** The knees give about half as much: when the outer foot lands, 0.15 m below standing height instead of
  0.3; standing up, 0.09 instead of 0.2; walking on, 0.06 and 0.02 instead of 0.12 and 0.04. The trunk bends less.

**Measured:** two new gym stations, a 1.0 m wall that is 1.3 m on its right half (station 34) and on its left half
(station 35). The legs went left and right respectively. Gym 36/36.

## Step 16: hopping down off a shallow top

From play: walking on over a shallow ledge, the free foot should not step down. Once it is through and dangling off the
far side, push off the ledge and hop down.

- **When:** the swing's walk-on ending, over a top under 0.5 m deep (`HOP_DEPTH`) with the floor beyond more than
  0.3 m lower (`HOP_DROP`), and no more than 2.0 m lower. Deeper tops, or a smaller drop, still step on; stepping
  down is allowed to 1.2 m, as before.
- **The tail:** the free foot slips through and dangles 0.3 m below the top, past the far edge. Then the push: the
  pelvis rises a little, and moves forward until the body (and its foot-sized footing check) is clear of the far edge.
- **Then airborne:** the script ends with the feet at the top's height, rising at 1.4 m/s (`HOP_VY`), and the controller
  carrying on at 1.8 m/s (`HOP_V`). The ordinary fall takes over and lands you, the knees taking the impact.

**Measured** (gym): wall 0.7 m, peak 0.09 m above the top, landing 0.88 m on; wall 1.1 m, 0.09 m, 1.01 m on;
rail at 1.0 m, 0.08 m, 0.99 m on; wall 1.4 m, 0.09 m, 1.12 m on. The 1.0 m block (1.2 m deep) walks on, as it should.
Gym 36/36.

## Step 17: the hop wherever the free foot can get past

From play: in the forest the push-off would not happen, and it should have no maximum height.

**Why not.** Two conditions. A fallen log's top is often more than 0.5 m deep where it stands more than a step high,
so the depth limit failed. And the floor was looked for 0.42 m past the footholds, which on a wide log is still on the
log.

**Now** (`canHop`): the hop happens if the far edge is within 0.7 m of the footholds (`HOP_REACH`: the free foot can
reach past it), and the floor just past the far edge (0.35 m beyond it, `beyond`) is more than 0.3 m lower. There is no
lower limit. The plain mantle's walk-on ending, used when arriving slowly or with little room overhead, now hops on
the same terms.

**Measured** (14 fallen trees, two crossings each, walking at them; plant collisions on):

| | published (step 16) | now |
|---|---|---|
| mantles (swing) | 9 (7) | 9 (6) |
| walk-on endings | 6 | 6 |
| ... that hopped | 3 | 5 |

The one walk-on that stepped had the floor beyond only 0.27 m lower. Gym 36/36.

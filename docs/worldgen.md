# World generation: strategy notes

Goal: terrain and vegetation that read as *earthy*, meaning a real forest floor with realistic densities of
trees, snags, deadfall and understory. We are not aiming for photorealism. The bet in this prototype is that
the "cartoon" feel of most procedural worlds comes less from polygon count than from **spatial statistics**:
uniform scatter, every tree the same age, no dead wood, and ground cover that ignores light and water.
Real forests are records of their own history. So we generate that history.

## The layers, and the strategy for each

| Layer | Strategy used here | Cheaper alternative | Richer alternative |
|---|---|---|---|
| Landform | Domain-warped fractional Brownian motion (fBm) + ridged noise | Plain fBm | Tectonic uplift + stream-power erosion |
| Valleys, drainage | Droplet hydraulic erosion (~90k droplets on a 257² grid) | None (noise only) | Grid-based shallow-water erosion on the GPU |
| Wetness | Multiple-flow-direction (MFD) flow accumulation → topographic wetness index, TWI = ln(a / tan β) | Height-based moisture | Water-balance model with soil depth |
| Tree positions, sizes, species | **Individual-based stand simulation** (below) | Poisson-disk sampling thresholded by noise | Offline-simulated stand library (below) |
| Dead wood | Falls out of the simulation: mortality → snag → log → decay | Random logs at a target density | Same, plus log decay chemistry and moss succession |
| Microtopography | Pits and mounds written back into the heightmap where trees uprooted | None | Higher-resolution near-field terrain |
| Understory, debris, rocks | Deterministic per-8 m-cell scatter of tall shrubs, low shrubs, tree seedlings, ferns, forbs, grasses, sedges, leaf litter, crooked branches and rocks, driven by canopy light, wetness, soil depth, conifer share, rockiness and nearby fresh logs | Uniform noise scatter | Its own light-competition model |

## The stand simulation

The core idea is borrowed from forest "gap models" and spatially explicit simulators such as SORTIE.
If you have done Brownian or molecular dynamics, it will feel familiar. It is a polydisperse 2D particle
system with an asymmetric soft interaction (shading) and birth and death processes, run with periodic boundaries.

State per stem: position, species, diameter at breast height (dbh), status (live, snag, log), time in status,
fall direction.

Each 5-year step:

1. **Light.** For each tree, sum the basal area of *taller* neighbours within 10 m, weighted by `1 − d/10`.
   Light is `L = exp(−7.5 · Σ)`. Under a closed canopy that gives L ≈ 0.03–0.05.
2. **Growth.** `Δdbh = G · site · L/(L + h) · (1 − dbh/dbh_max) · Δt`. The half-saturation `h` encodes shade tolerance:
   fir and maple grow in shade, while pine and birch need gaps.
3. **Mortality.** Background rate ≈ 1/lifespan, rising as trees near max size, plus a suppression term when growth
   stalls, which shade-tolerant species resist. Large trees sometimes die by uprooting. The rest stand as snags.
4. **Windstorms.** A Poisson process. Each storm knocks down a patch 20–75 m across, with falls aligned to the wind.
   Some stems snap and leave a tall jagged stump.
5. **Snags fall, logs decay.** A snag's residence time grows with diameter. Log residence ≈ (15 + 1.3 · dbh) years,
   scaled by species, and decay class 1–5 drives colour, slump and sinking.
6. **Recruitment.** Seeds disperse from parents with an exponential kernel, plus background seed rain.
   A seedling establishes with probability ∝ site suitability × its light response at ground level.

Every world starts from a stand-replacing fire at t = 0, with seedlings flushing in and fire-killed legacy trees
left as snags and logs. Run it for 40 years and you get a dense pole stand among old charred logs.
Run it for 300 and you get a multi-cohort stand with big logs and gaps.

### Is it realistic? What we can check

`node tools/sim-report.mjs <seed> <age> <dry|mesic|wet> <none|occasional|frequent>` prints the stand inventory.
With the current calibration (seed 1, mesic, occasional storms, granite):

| | 40 yr | 160 yr | 300 yr (seed 2) | Rough temperate range |
|---|---|---|---|---|
| Live stems ≥ 10 cm /ha | ~376 | ~407 | ~329 | 300–700 (mature) |
| Basal area m²/ha | ~8 | ~32 | ~39 | 25–50 (mature) |
| Snags ≥ 10 cm /ha | ~22 | ~37 | ~30 | 10–60 |
| Down log volume m³/ha | ~47 | ~55 | ~123 | 5–30 managed, 50–200+ old growth |

These reference ranges are order-of-magnitude orientation from the forest-ecology literature
(e.g. Harmon et al. 1986, *Advances in Ecological Research* 15, on coarse woody debris). They are not a
calibration target for any specific forest type. To claim realism for a particular region, compare against that
region's inventory plots.

Two emergent patterns are worth knowing because they come out of the dynamics rather than being painted on:

* **Dead wood vs stand age is roughly U-shaped.** It is high right after disturbance (legacy wood),
  lowest in mid-succession, and rises again in old growth. This is a documented pattern in real forests.
* **The pair correlation g(r) dips below 1 at short range in mature stands.** That is self-thinning through competition,
  the same signature as the first coordination shell in a radial distribution function. Young stands sit near 1
  (random). The Stand panel plots this live.

Steady-state dead-wood stock is a residence-time problem (Little's law): stock ≈ input rate × mean residence time.
At about 1 % annual mortality of a 35 m²/ha stand and a residence time of ~60–100 years, a stock of tens to low
hundreds of m³/ha is what you should expect. The simulation lands there without being told to.

## Stem form: why trees are not straight

Every stem gets three offsets, computed from its simulated life and site and applied by bending the trunk mesh
in the vertex shader. Each is a mechanism foresters recognise:

| Form | Mechanism | Drivers in the model |
|---|---|---|
| Lean | Phototropism: crowns grow toward the brightest sky. Conifers resist, because a strong leader keeps them upright (apical control). | Light gradient across the crown (from the stand simulation) × species phototropism (birch > maple > pine > fir); plus downwind lean on exposed ridges. |
| Basal sweep ("pistol butt") | Soil and snow creep push young stems downslope; the tree then recovers vertical growth, leaving a curved base. | Slope × snowpack (wetter climate = more) × soil depth; stronger in conifers (snow load). |
| Sinuosity | Damage, leader loss and stress produce wandering stems; broadleaves have weaker apical control than conifers. | Species × shallow or rocky soil. |

Slenderness is dynamic. Each step a tree's height-to-diameter allocation relaxes toward a target set by its light
(shade → tall and thin), soil depth and wind exposure (exposed or shallow → short and stout, i.e. thigmomorphogenesis).

On the thin-tree question: in a 160-year world the top 10 % of stems average ~50 cm dbh and ~26 m tall
(height/diameter ≈ 52), which is a normal proportion. The median stem is ~27 cm because a dense even-aged stand is mostly
poles at that age. The 300-year setting gives the big-tree look.

## Bedrock

Bedrock is a world setting (granite, sandstone, basalt). It changes:

* **Soil fertility.** Species have a fertility preference, so basalt (rich) favours maple, sandstone (poor, well drained)
  favours pine, and granite sits between. Fertility also scales growth.
* **Drainage.** Sandstone sites are drier.
* **Soil depth.** Shallow soil means more uprooting (and fewer snapped stems), more stem sinuosity and shorter trees.
* **Rock appearance.** Granite gives rounded core-stones and jointed blocks, sandstone gives bedded slabs with layering,
  and basalt gives sharp, dark, angular blocks. Stream-bed cobbles are always water-rounded.

## Ground surface

The heightmap is upsampled to 0.5 m with bicubic interpolation plus micro-relief (soil texture, moss hummocks on wet
ground, rock knobs on rocky ground). A 96 m patch of 0.5 m terrain follows the player and is displaced on the GPU
from that heightmap. It blends into the 2 m world mesh at its rim, so there is no seam. Ecological fields are read
from smoothly filtered textures, not per-vertex attributes, so there are no triangle-shaped colour blotches. Per-pixel
bump and speckle add grit up close. Steep stone uses triplanar projection so it does not smear.

## Rendering choices that matter more than polygon count

* **Card foliage with volumetric normals.** Crowns are 40–70 alpha-tested quads whose normals radiate from
  the crown centre, so a crown shades like a soft blob instead of a set of flat planes. A vertex-colour
  ambient-occlusion gradient darkens the inside and bottom of each crown.
* **Ground colour from ecology, not from height.** The terrain shader mixes leaf litter, needle duff, moss,
  grass, mud and rock using wetness, canopy openness, conifer share and slope, with several octaves of
  value noise so it never tiles.
* **Fog and a low sun.** Exponential fog matched to the sky horizon hides the draw distance and gives depth.
  Shadows are only rendered within ~50 m of the player and updated every other frame.
* **Muted palette.** Desaturated greens and browns. Saturated greens are the fastest route to "cartoon".

## Scaling to a large or endless world (not built yet)

The simulation costs about 3–5 s for 26 ha on a laptop, so it cannot run live for an endless world. Options:

1. **Stand library.** Run the simulation offline (or in a Web Worker at startup) for a grid of
   (site quality × age × disturbance) conditions on periodic tiles. At runtime, place tiles chosen by
   the local site fields. Because tiles are periodic, they abut without seams in the *point pattern*. Wang-tile
   variants break up repetition. This is texture synthesis applied to point processes.
2. **Statistical emulation.** Fit a marked point-process model (e.g. a Strauss or Gibbs process with
   size marks) to simulation output and sample it per chunk. That is cheap and local, but loses history
   such as aligned windthrow.
3. **Chunked simulation with halos.** Simulate each chunk with a margin borrowed from neighbours.
   It is deterministic per seed, but costs more.

Option 1 is the most promising for a mobile survival game.

# How far does the current generator extend?

Short answer: the **process layers** (terrain → water → site → stand dynamics → form) are general, and most of
what makes a region distinct can be added as *data plus a few new processes*. The **appearance layer** is where
the prototype is narrow: four hard-wired species "kinds", two crown archetypes, three rock shapes. That is where
the next real engineering goes.

## What the pipeline is made of today

| Layer | What it does | How data-driven it is |
|---|---|---|
| Landform | noise + erosion → heightmap | Parameters are inline constants. A region could set relief, ridge character and erosion intensity. |
| Hydrology | flow accumulation → wetness, streams | General. Works for any heightmap. |
| Site fields | moisture, elevation, rock, soil depth, exposure | Driven by `MOISTURE` and `GEOLOGY` tables (fertility, drainage, soil depth, rock bias). |
| Stand dynamics | establishment, light competition, growth, mortality, windstorms, snag fall, log decay | Driven by the `SPECIES` trait table. Disturbance is windthrow only. Fire, drought and insects are missing. |
| Stem form | lean (phototropism, wind), basal sweep (creep), sinuosity | Per-species traits × site. Single stem only: no forks, no branch hierarchy. |
| Ground cover | per-cell scatter of shrubs, seedlings, forbs, grasses, sedges, litter, debris, rocks, scree | Rules are written in code, keyed to light, wetness, soil and rock. Not yet a table of plant types. |
| Appearance | crown card clouds, cone crowns, bent trunks, rock shapes by lithology, weathering by climate | Archetypes are hard-coded (`kind === 'conifer'` etc.). |

## Regions: what a region descriptor would contain

```text
Region
  climate:   temperature, precipitation + seasonality, snow, wind regime, fire regime (interval, intensity)
  geology:   lithology units (a map, not one value), joint spacing, weathering mode, soil depth model
  flora:     species pool, each with traits (below)
  ground:    plant functional types for understory, litter types, decomposers (fungi vs termites)
```

Climate and geology change **processes**, not just colours:

* **Weathering mode** sets rock shape. Cold or dry climates break rock physically along joints, giving angular blocks and
  frost-shattered scree. Warm, wet climates weather it chemically: corners rot back and you get rounded core-stones,
  tors and deep red soils. This is already a parameter (`rounding`, from climate and lithology). More lithologies are
  new rows plus a shape rule: limestone pavement and karst, shale crumbling into flaggy scree, quartzite ridges.
* **Fire regime** is the big missing disturbance. In southern Australia it, not windthrow, is the main architect of
  forests. It needs partial mortality by bark thickness, epicormic resprouting along stems and limbs, lignotuber
  resprouting (multi-stemmed mallee forms), fire scars and hollows, and charcoal on trunks.
* **Decomposers** set dead-wood residence time. Termites in warm dry country remove wood very differently from
  fungi in cool wet country. That is one rate parameter in the log decay model.

## Trees: forks, branch hierarchy, stubs

Superseded by the fuller design in [`plants.md`](plants.md).

The current stem is one bent tube with a cloud of foliage cards. To get forked trunks, real limbs and branch
stubs, each tree needs a **skeleton**: a small graph of segments, grown by rules that depend on species traits and
on the tree's simulated history.

Botany already has a vocabulary for this. **Hallé–Oldeman architectural models** (1970s) classify tree growth into
about two dozen models by a few properties. The useful ones for us:

| Trait | Effect on form |
|---|---|
| Apical dominance (strong → weak) | A single straight leader with a conical crown (fir) versus a decurrent crown that splits into several big limbs (maple, oak, eucalypt) |
| Monopodial vs sympodial growth | Sympodial trees replace their leader with a side shoot each cycle, giving zig-zag crooked limbs. Most eucalypts look like this. |
| Branch angle, phyllotaxis | Whorls (pines, firs) versus spirals versus alternating pairs |
| Self-pruning in shade | Lower branches die, leaving **dead branches** (conifers) or **stubs** that bark later grows over (broadleaves) |
| Reiteration after damage | A broken leader is replaced by one or more upturned branches, giving **forks** and candelabra tops |
| Epicormic shoots | Shoots sprouting along trunk and limbs after fire or release; a hallmark of eucalypts |
| Foliage display | Dense shell (maple), whorled sprays (fir), **clumped at branch tips with pendulous leaves** (eucalypt: open, see-through crowns) |

How history drives it: the stand simulation already records each tree's light environment. Adding a few events per
tree makes the skeleton history-dependent:
- leader loss (storm, snow) → fork;
- shading history → height to the lowest live branch, and dead-branch or stub zones;
- release after a neighbour falls → epicormic shoots and a crown that grows toward the gap.

**Generating the skeleton.** Two standard algorithms:
- *L-systems*: rule-based, compact, good for whorled or regular species.
- *Space colonisation*: branches grow toward light "attractor" points in the crown volume. This gives natural
  irregular forms and responds directly to the light gradient we already compute.

**Rendering it cheaply.** Bake a small library per species: about 8 skeleton variants × 3 size classes, each a merged mesh
of tapered tubes plus foliage clusters at the branch tips. Instances pick a variant and are scaled, rotated and bent.
Distant trees keep today's card clouds. A few hundred kilobytes of geometry covers a forest, and it fits the
instanced, tiled renderer we have.

What exists already that this builds on: per-tree random seed, light history, species traits, stem bending in the
shader, crooked tube geometry (used for fallen branches and shrub stems), and the near/far level-of-detail switch.

## Rocks

Now: three shape rules (jointed blocks, bedded slabs, rounded) × a weathering state from climate × lithology colour,
several shape variants per world, crisp joint faces, per-pixel grain, vesicles (basalt) or laminae (sandstone),
lichen, moss, soil staining, and scree below rocky slopes.

Next steps, in order of payoff:
1. **A lithology map** instead of one bedrock per world, so a valley can cut through two units with a contact.
2. **Cliffs as geometry**: steep rock faces as separate meshes with ledges and overhangs. A heightmap cannot overhang.
3. **Talus physics**: scree size sorting, with big blocks rolling furthest, and rockfall from cliffs.
4. **Tors and pavements**: granite tors from deep weathering plus stripping; limestone pavement clints and grikes.

## Practical structure change when this grows

Move the hard-coded `kind` switches into tables: species → architecture model + foliage type + bark type;
lithology → shape rule + colour + weathering response; region → climate + disturbance regime + species pool.
The simulation and rendering code then reads traits instead of names, and a new region is mostly a new data file.

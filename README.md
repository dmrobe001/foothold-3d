# Foothold

A feasibility prototype for a browser-based, phone-friendly 3D survival game set in a believable temperate forest.
Right now it is a walkable world-generation test bed. There are no survival mechanics yet.

The world is grown rather than scattered. Terrain is eroded, water is routed, and then an individual-based
forest simulation runs 40–300 years of establishment, competition, mortality, windstorms, snag fall and
log decay. Trees, snags, deadfall, pit-and-mound ground and understory densities all come out of that history.
See [`docs/worldgen.md`](docs/worldgen.md) for the strategy and the numbers.

## Run it

Static files only, with no build step needed for development:

```bash
python3 -m http.server 8000      # from the repository root
# open http://localhost:8000
```

Three.js 0.160.0 loads from the jsDelivr content delivery network (CDN), so you need a network connection.

Controls: **phone**, left thumb walks (push to the rim to run) and drag elsewhere to look.
**Desktop**, WASD or arrow keys, Shift to run, drag to look, M for the map.
Panels: **Map** (tap to teleport), **Stand** (inventory, diameter distribution, pair correlation),
**World** (seed, stand age, climate, windstorms, bedrock, graphics quality).

## Movement and collision

**Where you can go** (the collision body): you stand on the highest solid surface under your feet. Rock tops are
sampled from each rock's geometry. Rises up to 0.55 m are steps. Pushing into something up to 1.35 m high with a
standable top scrambles onto it. Trunks and woody stems taller than a leg (tall shrubs, saplings) are walked around.
Low plants are waded through.

**How you move there** (a procedural body, mostly unrendered):
- **Feet** plant one at a time on the real surface, in a gait cycle driven by distance (walk: always one foot down; run: brief flight).
- **Pelvis** sits as high as the planted legs can reach.
- **Torso** leans into slopes, heaves forward on each uphill push-off, and folds over ledges when scrambling.
- **Arms** swing; one reaches out to push a tall shrub aside or plant on a ledge or low barrier.
- **Shrubs** are springs: they bend from the base under the hand and sway back after you pass. Low plants part around your legs.
- **Camera** is the eye. Like your vestibulo-ocular reflex, it passes about 20% of the rhythmic gait bounce but all
  of the terrain-driven and posture-driven motion.

World panel: **Camera motion** (Full, Reduced, Off), **View** (first person, or third person for debugging; V toggles),
**Body** (show the skeleton in first person). Tuning knobs are in `RIG` in `src/game.js`.

## Reproduce stand statistics without a browser

```bash
node tools/sim-report.mjs 1 160 mesic occasional granite
```

The same seed and settings always give the same world.

## Layout

| Path | What it is |
|---|---|
| `src/worldgen.js` | Terrain, erosion, hydrology, stand simulation, statistics. Pure JS, no DOM, runs in Node. |
| `src/game.js` | Three.js rendering, procedural textures, controls, user interface (UI). |
| `index.html` | Page shell and styles. |
| `tools/sim-report.mjs` | Command-line stand inventory for a seed. |
| `tools/build.mjs` | Bundles everything into a single file, `dist/foothold.html`, for sharing. |
| `docs/worldgen.md` | Design notes: strategies, calibration, scaling plan. |
| `docs/extensibility.md` | What it would take to support other regions, tree architectures and rock types. |

## Status

Prototype. The world is 512 m × 512 m (26 ha). Generation takes 3–5 s on a laptop and longer on phones.
Next steps under consideration are in `docs/worldgen.md`.

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

- **Body:** you stand on the highest solid surface under your feet, which is the ground or the top of a rock, log or root wad.
  Rock tops are sampled from each rock's actual geometry, so ledges hold you.
- **Steps:** rises up to 0.55 m are taken in stride.
- **Scramble:** pushing forward into something up to 1.35 m high with a standable top climbs onto it in a short animation.
- **Blocks:** trunks, taller steep-sided things, and natural ground steeper than about 49°.
- **No slowdowns.** Instead the camera shows effort with damped springs: it dips and catches up on step-ups, compresses on
  landings, pitches and rolls during scrambles, shifts side to side in stride on steep climbs, and dodges sideways past
  shrubs. Sway and dodge are pure translation, so the horizon stays level; only scrambles tilt it. Flat ground has no head bob. **World → Camera motion** sets Full, Reduced or Off.

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

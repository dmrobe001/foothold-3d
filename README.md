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

Movement is three layers, with no special modes (after David Rosen's Overgrowth approach: coarse rules decide where
you go; the body is fitted to whatever is there).

**Surfaces**: you stand on the highest solid surface under your feet. Rock tops are sampled from each rock's geometry.
Each surface has a material (soil, rock, wood) that sets the steepest path a foot holds alone (about 49°, 44°, 35°).
A stem, a sapling or a slim trunk is something a hand can close round; any other surface within reach can be pressed on.

**Where the body goes** (coarse, forgiving rules, judged on each attempted move):
- Rises up to 0.55 m are steps. A ledge up to 1.35 m is pulled up onto, hands on its lip, if there is something to hold.
- Trunks and woody stems taller than a leg are walked around; low plants are waded through.
- The hands are needed when the path stays steeper than the footing's traction (one bump is a step, not a slope),
  when there is a ledge, or when the headroom is under 1.1 m (down to 0.55 m, crawling low). Then the best hold
  in reach sets how steep you can go: up to 68° with a hand closed round something, 56° pressing on a surface.
  On hands you move slowly, and only as fast as the hands and feet can keep hold.
- A stem hung overhead with at least 1.1 m under it is ducked under; with 0.55 to 1.1 m, crawled under.

**How the body is placed**:
- **Feet**, walking, plant one at a time on the real surface, in a gait cycle driven by distance (walk: always one foot
  down; run: brief flight). The **pelvis** sits as high as the planted legs can reach; the **torso** leans into slopes.
- **On hands**, every hand and foot is a contact with a home position along the surface (ahead for hands, behind for
  feet). The one furthest behind steps a stride ahead, one at a time, so three always hold; before it lifts, the body
  sways sideways until its centre of mass is over the other three. The trunk lies along the surface, low under
  whatever is overhead, and faces up the fall line when the slope is what needs the hands.
- **Arms**, walking, swing; one reaches out to push a tall shrub aside, plant on a low barrier or touch a stem overhead.
- **Shrubs** are springs: they bend from the base under the hand and sway back after you pass.
- **Skeleton**: one joint hierarchy (pelvis, three spine segments, neck, collarbones, two-segment arms and legs) solved
  each frame from the posture and the four hand and foot targets (`src/skeleton.js`). The walking posture and the
  posture on hands are mixed by how much the hands are needed, so there is no switch between them.
- **Camera** is the eye. Walking, like your vestibulo-ocular reflex, it passes about 20% of the rhythmic gait bounce but
  all of the terrain-driven and posture-driven motion. On hands it is in the head, and the view tips along the slope.

World panel: **Camera motion** (Full, Reduced, Off), **View** (first person, or third person for debugging; V toggles),
**Body** (show the skeleton in first person). Tuning knobs are in `RIG`, `TRACTION` and `GAIT4` in `src/game.js`.

## Testing gym

World panel → **Place: Testing gym** (or open the page with `#gym` on the address) loads a level clearing with
fixed obstacle stations: hung stems at several clearances, a sloped overhang, level and tilted hurdles, stems
at 30–75°, ledges, a wall, rock slabs and a gap between trunks. Each station states its intended outcome. Change station
with `[` and `]` (or ◀ ▶), restart with `R` (or ↺). Stations live in `src/gym.js` as plain data.

**Copy this spot** (World panel, or `C`) records the obstacles within 5 m of you in the forest, in the frame of where
you stand and look, as a new station: it joins your own gym on that device, and its text can be added to `src/gym.js`.
Captured rocks use the gym's granite shapes, so a spot from sandstone or basalt is only approximate.

`window.foothold.gym.run(i)` walks station `i` straight ahead and scores it; a headless browser runs all of them
in a few seconds.

## Reproduce stand statistics without a browser

```bash
node tools/sim-report.mjs 1 160 mesic occasional granite
```

The same seed and settings always give the same world.

## Layout

| Path | What it is |
|---|---|
| `src/worldgen.js` | Terrain, erosion, hydrology, stand simulation, statistics. Pure JS, no DOM, runs in Node. |
| `src/gym.js` | Testing gym stations and the world record built from them. |
| `src/game.js` | Three.js rendering, procedural textures, controls, user interface (UI). |
| `index.html` | Page shell and styles. |
| `tools/sim-report.mjs` | Command-line stand inventory for a seed. |
| `tools/build.mjs` | Bundles everything into a single file, `dist/foothold.html`, for sharing. |
| `docs/worldgen.md` | Design notes: strategies, calibration, scaling plan. |
| `docs/extensibility.md` | What it would take to support other regions, tree architectures and rock types. |

## Status

Prototype. The world is 512 m × 512 m (26 ha). Generation takes 3–5 s on a laptop and longer on phones.
Next steps under consideration are in `docs/worldgen.md`.

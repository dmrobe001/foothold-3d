// Testing gym: a level clearing with fixed obstacle stations, each stating the outcome the movement rules should give.
// It is an ordinary world record (the same shape generateWorld returns), so the game builds, draws and collides with it
// exactly as it does a forest; only the content is placed by hand instead of grown.
//
// Station frame: x is to your right, f is forward, y is up from the lane's ground (0). You start at f = -4 facing
// forward; the feature sits around f = 0; the goal line is f = +4. Feature kinds:
//   log:   [x0, f0, under0, x1, f1, under1], r      a straight stem of radius r; `under` is its underside height at each end
//   stem:  [x, f], ang, len, r, yaw = 0, prop       a stem resting on the ground at its foot, rising at `ang` degrees
//                                                  (yaw in degrees, 0 = rising straight ahead); prop: a trunk holds its top
//   block: [x, f], size [w, h, l], y = 0, pitch, roll, yaw   a rock box standing on its bottom face centre; pitch raises
//                                                  its far edge, roll its right edge, yaw turns it (all degrees)
//   trunk: [x, f], d                               a standing tree of diameter d (cm); d < 8 is a sapling you brush past
//   tree:  [x, f], sp, d, L                       a grown specimen: species index, dbh (cm), light 0..1 (crown length)
//   fallen: [x0, f0, x1, f1], sp, d, t            a whole fallen tree from butt to top, t years down: it keeps branches
//   ramp:  [f0, f1], rise, w                       soil rising from f0 to f1 by `rise` over a width w, then level
//   wad:   [x, f, y], a [ax, ay, af], u [ux, uz]   a root wad (soil ellipsoid; u: its long axis, gym-world x/z)
//   rock:  [x, f, y], i, e [16]                   a captured outcrop: big rock shape i with its turn and scale (matrix e)
//   grid:  { step, n, h: [...] }                   a captured patch of ground heights, n × n samples centred on the start
//   near:  [[type, x, f, yaw, a, b, c, v], ...]    captured near-field items (rocks, fallen branches) as the forest makes them
// Angles of captured things (yaw of rocks and near items, wad axes) are in the gym world's own frame: the capture
// turns the world so the way you were looking becomes the lane's forward.
// expect (what a station scores):
//   cross: reach the goal line          stop: never get past f = 1         height: the feet reach at least this high
//   clean: no head, neck or chest in a stem, camera 0.12 m clear of it      hands: true (must go on hands) / false (must not)
//   lean:  'left' or 'right' (the torso leans that way, more than 0.15 rad, to get the head under)
//   mantle: true (gets up onto it with a mantle) / false (must not)
//   plan:  the intended way through, in words; mode: the traversal the station's numbers call for (reported, not scored yet)
//   camera: the camera (a 0.1 m ball at the eye) never inside any solid, all the way (the body itself is soft)
// pitch: where you look while walking it (radians, + up; default -0.12). Over-or-under choices follow the gaze.
import { N, NF, WORLD, HALF, GEOLOGY, SPECIES, standStats, treeHeight, clamp } from './worldgen.js';
import { trunkProfile } from './deadfall.js';
import { CAPTURED } from './captured.js';

// Every station is plain solids (boxes, and round rails), so what it tests is spatial: the size of a gap, the height of a
// barrier, what lies beyond. Side walls close the lane, so the opening is the only way through. Each station names the
// traversal its numbers call for (a body 1.75 m tall; see docs/movement.md), and scores crossing (or stopping, where
// nothing fits) with the camera never inside a solid.
const WALL_H = 2.6, SIDE = 5.5, LANE = 12;
const box = (x, f, w, h, l, y = 0, more = {}) => ({ block: [x, f], size: [w, h, l], y, ...more });
const sides = (w, l, f = 0, h = WALL_H) => [box(-(w / 2 + SIDE / 2), f, SIDE, h, l), box(w / 2 + SIDE / 2, f, SIDE, h, l)]; // an opening w wide
const tunnel = (w, c, l = 1.5) => [...sides(w, l), box(0, 0, w + 0.02, WALL_H - c, l, c)]; // w wide, c of headroom, l long
const wall = (h, d = 0.2, f = 0, y = 0) => box(0, f, LANE, h, d, y); // across the whole lane
const rail = (top, r = 0.05) => ({ log: [-LANE / 2, 0, top - 2 * r, LANE / 2, 0, top - 2 * r], r });
const st = (name, mode, features, expect, more = {}) => ({ name, plan: mode, mode, features, expect: { camera: true, ...expect }, ...more });
export const STATIONS = [
  // headroom (0.9 m wide, 1.5 m long)
  st('Headroom 1.85 m', 'walk', tunnel(0.9, 1.85), { cross: true, hands: false }),
  st('Headroom 1.65 m', 'stooped walk', tunnel(0.9, 1.65), { cross: true, hands: false }),
  st('Headroom 1.25 m', 'crouch walk', tunnel(0.9, 1.25), { cross: true, hands: false }),
  st('Headroom 1.0 m', 'deep crouch', tunnel(0.9, 1.0), { cross: true, hands: false }),
  st('Headroom 0.9 m', 'monkey crawl', tunnel(0.9, 0.9), { cross: true, hands: true }),
  st('Headroom 0.8 m', 'bear crawl', tunnel(0.9, 0.8), { cross: true, hands: true }),
  st('Headroom 0.65 m', 'hands and knees', tunnel(0.9, 0.65), { cross: true, hands: true }),
  st('Headroom 0.45 m', 'army crawl', tunnel(0.9, 0.45), { cross: true, hands: true }),
  st('Headroom 0.35 m', 'nothing fits: stop', tunnel(0.9, 0.35), { stop: true }),
  // width (open above unless stated)
  st('Gap 0.6 m wide', 'walk', sides(0.6, 1.5), { cross: true, hands: false }),
  st('Gap 0.45 m wide', 'shimmy sideways', sides(0.45, 1.5), { cross: true, hands: false }),
  st('Gap 0.45 m wide, 1.2 m tall', 'nothing fits (too low to shimmy, too narrow to crouch): stop', tunnel(0.45, 1.2), { stop: true }),
  st('Gap 0.35 m wide', 'nothing fits: stop', sides(0.35, 1.5), { stop: true }),
  st('Gap 0.55 m wide, 0.5 m tall', 'army crawl', tunnel(0.55, 0.5), { cross: true, hands: true }),
  // a gap at an angle
  st('Sloped roof', 'stooped walk, leaning right (the roof is higher on the right)', [...sides(1.2, 1.5), box(0, 0, 1.22, 1.2, 1.5, 1.55, { roll: 15 })], { cross: true, lean: 'right' }),
  // barriers across the lane: anything more than a step high (0.55 m) is mantled, up onto its top, and stepped or dropped off
  st('Wall 0.4 m', 'step over', [wall(0.4)], { cross: true, hands: false }),
  st('Wall 0.7 m', 'low mantle (no dip), down off it', [wall(0.7)], { cross: true, mantle: true }),
  st('Wall 0.85 m', 'low mantle, down off it', [wall(0.85)], { cross: true, mantle: true }),
  st('Wall 1.1 m', 'mantle (a small dip), down off it', [wall(1.1)], { cross: true, mantle: true }),
  st('Wall 1.25 m', 'mantle, down off it', [wall(1.25)], { cross: true, mantle: true }),
  st('Wall 1.4 m', 'mantle (a deep dip), down off it', [wall(1.4)], { cross: true, mantle: true }),
  st('Wall 1.8 m', 'too high to mantle, no holds to climb: stop', [wall(1.8)], { stop: true }),
  st('Wall 1.25 m in a 1.2 m opening', 'mantle', [wall(1.25), ...sides(1.2, 0.2, 0, WALL_H)], { cross: true, mantle: true }),
  st('Wall 0.85 m in a 0.6 m opening', 'low mantle (the body is narrower than the opening)', [wall(0.85), ...sides(0.6, 0.2, 0, WALL_H)], { cross: true, mantle: true }),
  st('Wall 1.0 m under a slab, 0.45 m between', 'low mantle into the window, crouched with hands down, then off', [wall(1.0), box(0, 0, LANE, WALL_H, 0.6, 1.45)], { cross: true, mantle: true }),
  // rails
  st('Rail at 0.5 m', 'step over', [rail(0.5)], { cross: true, hands: false }),
  st('Rail at 1.0 m (0.9 m under)', 'low mantle (tier 1 beats crawling under, tier 2)', [rail(1.0)], { cross: true, mantle: true }),
  // footing on top
  st('Block 1.0 m high, 1.2 m deep', 'low mantle onto it, walk off', [box(0, 0.6, LANE, 1.0, 1.2)], { cross: true, height: 0.95, mantle: true }),
  // what lies beyond (only a step-over cares: anything else slides off)
  st('Wall 0.6 m, ground 0.3 m lower beyond', 'step over (and down)', [box(0, -3.5, LANE, 0.3, 7), wall(0.6, 0.2, -0.1, 0.3)], { cross: true }),
  st('Wall 0.6 m, ground 0.8 m lower beyond', 'low mantle, then drop off the far side', [box(0, -3.5, LANE, 0.8, 7), wall(0.6, 0.2, -0.1, 0.8)], { cross: true, mantle: true }),
  // approached slowly (a careful walk): a foot goes onto the top instead of over it; higher than a step it is a mantle anyway
  st('Wall 0.4 m, slowly', 'step onto it, then down', [wall(0.4)], { cross: true, hands: false, stepOn: 0.4 }, { slow: true }),
  st('Rail at 0.5 m, slowly', 'step onto it, then down', [rail(0.5)], { cross: true, hands: false, stepOn: 0.5 }, { slow: true }),
  st('Wall 0.7 m, slowly', 'low mantle, then down', [wall(0.7)], { cross: true, stepOn: 0.7, mantle: true }, { slow: true }),
  ...CAPTURED,
];

const COLS = 6, DX = 14, DZ = 18;
// station i's origin in the world, and its frame: forward is world -z, right is world +x
export function stationOrigin(i) { return [(i % COLS - (COLS - 1) / 2) * DX, (Math.floor(i / COLS) - 1) * DZ]; }
export const gymToWorld = (i, x, f) => { const [ox, oz] = stationOrigin(i); return [ox + x, oz - f]; };

// The world record. Trees use the same fields the forest's do; the deadfall step is skipped (stems lie where placed).
export function buildGymWorld(extra = []) {
  const stations = [...STATIONS, ...extra];
  const H = new Float32Array(N * N), HF = new Float32Array(NF * NF);
  const fine = (WORLD / (NF - 1));
  const raise = (fn, x0, x1, z0, z1) => { // apply a height function over a world box to the fine grid
    for (let J = Math.max(0, Math.floor((z0 + HALF) / fine)); J <= Math.min(NF - 1, Math.ceil((z1 + HALF) / fine)); J++)
      for (let I = Math.max(0, Math.floor((x0 + HALF) / fine)); I <= Math.min(NF - 1, Math.ceil((x1 + HALF) / fine)); I++) {
        const k = J * NF + I, v = fn(I * fine - HALF, J * fine - HALF); if (v !== null) HF[k] = v;
      }
  };
  const trees = [], blocks = [], nearItems = [], wads = [], rocks = [];
  const log = (x0, z0, y0, x1, z1, y1, r) => { // centre heights at each end
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const k = r / trunkProfile(0.5); // a broken piece is drawn at the stem's taper for its middle: undo it so the radius is r
    trees.push({ st: 2, sp: 0, x: x0, z: z0, d: r * 200, h: L, t: 1, gym: true, rest: { a: Math.atan2(z1 - z0, x1 - x0), sx: k, sz: k, L, fd: 0, pieces: [{ x0, y0, z0, x1, y1, z1, u0: 0.2, u1: 0.8, rx0: r, rx1: r, rz0: r, rz1: r, r }] } });
  };
  const trunk = (x, z, d) => trees.push({ st: 0, sp: 2, x, z, d, h: d < 8 ? 2 + d * 0.5 : 18 + d * 0.1, t: 0, gym: true });
  stations.forEach((s, i) => {
    const W2 = (x, f) => gymToWorld(i, x, f);
    for (const ft of s.features || []) {
      if (ft.log) { const [x0, f0, u0, x1, f1, u1] = ft.log, a = W2(x0, f0), b = W2(x1, f1); log(a[0], a[1], u0 + ft.r, b[0], b[1], u1 + ft.r, ft.r); }
      if (ft.stem) {
        const a = W2(...ft.stem), A = (ft.ang * Math.PI) / 180, yw = ((ft.yaw || 0) * Math.PI) / 180, hl = ft.len * Math.cos(A);
        const b = W2(ft.stem[0] + Math.sin(yw) * hl, ft.stem[1] + Math.cos(yw) * hl), top = ft.r + ft.len * Math.sin(A);
        log(a[0], a[1], ft.r, b[0], b[1], top, ft.r);
        if (ft.prop) { const p = W2(ft.stem[0] + Math.sin(yw) * (hl + ft.r + 0.25), ft.stem[1] + Math.cos(yw) * (hl + ft.r + 0.25)); trunk(p[0], p[1], 50); }
      }
      if (ft.trunk) { const a = W2(...ft.trunk); trunk(a[0], a[1], ft.d); }
      if (ft.fallen) {
        const [x0, f0, x1, f1] = ft.fallen, a = W2(x0, f0), b = W2(x1, f1), r = ft.d / 200, L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = (ft.d / 100) / trunkProfile(0.5) * trunkProfile(0.5);
        trees.push({ st: 2, sp: ft.sp, x: a[0], z: a[1], d: ft.d, h: L, len: L, t: ft.t, gym: true, rest: { a: Math.atan2(b[1] - a[1], b[0] - a[0]), sx: ft.d / 100, sz: ft.d / 100, L, fd: 0, pieces: [{ x0: a[0], y0: r, z0: a[1], x1: b[0], y1: r * 0.4, z1: b[1], u0: 0, u1: 1 }] } });
      }
      if (ft.tree) { const a = W2(...ft.tree); trees.push({ st: 0, sp: ft.sp, x: a[0], z: a[1], d: ft.d, h: treeHeight(ft.sp, ft.d), L: ft.L, t: 0, gym: true }); }
      if (ft.block) { const a = W2(...ft.block); blocks.push({ x: a[0], z: a[1], y: ft.y || 0, size: ft.size, pitch: ft.pitch || 0, roll: ft.roll || 0, yaw: ft.yaw || 0 }); }
      if (ft.wad) { const a = W2(ft.wad[0], ft.wad[1]); wads.push({ x: a[0], y: ft.wad[2], z: a[1], ax: ft.a[0], ay: ft.a[1], az: ft.a[2], ux: ft.u?.[0] ?? 1, uz: ft.u?.[1] ?? 0 }); }
      if (ft.rock) { const a = W2(ft.rock[0], ft.rock[1]); rocks.push({ x: a[0], y: ft.rock[2], z: a[1], i: ft.i, e: ft.e }); }
      if (ft.ramp) {
        const [f0, f1] = ft.ramp, w = ft.w || 5, [ox, oz] = stationOrigin(i);
        raise((x, z) => { const f = oz - z; if (Math.abs(x - ox) > w / 2) return null; return Math.max(HF[0], ft.rise * clamp((f - f0) / (f1 - f0), 0, 1)); }, ox - w / 2, ox + w / 2, oz - 6, oz + 6);
      }
      if (ft.grid) {
        const { step, n, h } = ft.grid, [ox, oz] = stationOrigin(i), c = (n - 1) / 2, sx = ox, sz = oz + 4; // centred on the start
        raise((x, z) => {
          const gx = (x - sx) / step + c, gf = (sz - z) / step + c; if (gx < 0 || gf < 0 || gx > n - 1 || gf > n - 1) return null;
          const a = Math.min(n - 2, Math.floor(gx)), b = Math.min(n - 2, Math.floor(gf)), u = gx - a, v = gf - b;
          return h[b * n + a] * (1 - u) * (1 - v) + h[b * n + a + 1] * u * (1 - v) + h[(b + 1) * n + a] * (1 - u) * v + h[(b + 1) * n + a + 1] * u * v;
        }, sx - c * step, sx + c * step, sz - c * step, sz + c * step);
      }
      if (ft.near) for (const it of ft.near) { const a = W2(it[1], it[2]); nearItems.push([it[0], a[0], a[1], ...it.slice(3)]); }
    }
  });
  // the coarse 2 m grid (far terrain) follows the fine one
  const ratio = (NF - 1) / (N - 1);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = HF[j * ratio * NF + i * ratio];
  const fill = (n, v) => new Float32Array(n * n).fill(v);
  const LN = 129;
  const world = {
    gym: { stations, blocks, nearItems, wads, rocks }, seed: 1, age: 0, opt: { geology: 'granite', moisture: 'mesic', storms: 'none' }, geology: GEOLOGY.granite,
    H, HF, hmax: 2, slope: fill(N, 0), wet: fill(N, 0.3), stream: fill(N, 0), moist: fill(N, 0.5), rock: fill(N, 0), north: fill(N, 0), soil: fill(N, 0.6),
    light: fill(LN, 0.7), conShare: fill(LN, 0), LN, trees, pits: [], windDir: [1, 0], stats: null, genMs: 0, deadfall: { gym: true, ms: 0 },
  };
  world.stats = standStats(world); world.stats.storms = 0;
  return world;
}

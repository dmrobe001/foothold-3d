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
//   ramp:  [f0, f1], rise, w                       soil rising from f0 to f1 by `rise` over a width w, then level
//   wad:   [x, f, y], a [ax, ay, af], u [ux, uz]   a root wad (soil ellipsoid; u: its long axis, gym-world x/z)
//   rock:  [x, f, y], i, e [16]                   a captured outcrop: big rock shape i with its turn and scale (matrix e)
//   grid:  { step, n, h: [...] }                   a captured patch of ground heights, n × n samples centred on the start
//   near:  [[type, x, f, yaw, a, b, c, v], ...]    captured near-field items (rocks, fallen branches) as the forest makes them
// Angles of captured things (yaw of rocks and near items, wad axes) are in the gym world's own frame: the capture
// turns the world so the way you were looking becomes the lane's forward.
// expect (what a station scores):
//   cross: reach the goal line          stop: never get past f = 1         height: the feet reach at least this high
//   clean: no head, neck or chest in a stem       hands: true (must go on hands) / false (must not)
//   lean:  'left' or 'right' (the torso leans that way, more than 0.15 rad, to get the head under)
//   vault: true (goes over with a vault) / 'left' or 'right' (and its legs pass that side)
//   plan:  the intended way through, in words (not scored yet)
import { N, NF, WORLD, HALF, GEOLOGY, standStats, clamp } from './worldgen.js';

const hurdle = (top, r = 0.25) => ({ log: [-2.5, 0, top - 2 * r, 2.5, 0, top - 2 * r], r });
export const STATIONS = [
  { name: 'Hung stem, 1.4 m under', features: [{ log: [-3, 0, 1.4, 3, 0, 1.4], r: 0.2 }], expect: { cross: true, clean: true, hands: false }, plan: 'duck under, staying on your feet' },
  { name: 'Hung stem, 0.9 m under', features: [{ log: [-3, 0, 0.9, 3, 0, 0.9], r: 0.2 }], expect: { cross: true, clean: true, hands: true }, plan: 'drop to hands and knees and crawl under' },
  { name: 'Hung stem, 0.6 m under', features: [{ log: [-3, 0, 0.6, 3, 0, 0.6], r: 0.2 }], expect: { cross: true, clean: true, hands: true }, plan: 'crawl under, flat and low' },
  { name: 'Sloped overhang', features: [{ log: [-3, 0, 0.5, 3, 0, 2.3], r: 0.2 }], expect: { cross: true, clean: true, lean: 'right' }, plan: 'lean toward the high (right) side and duck through' },
  { name: 'Hurdle, 0.5 m', features: [hurdle(0.5)], expect: { cross: true, hands: false }, plan: 'step over' },
  { name: 'Hurdle, 0.85 m', features: [hurdle(0.85)], expect: { cross: true, vault: true }, plan: 'hands on the stem and swing the legs over (not a pull-up onto it)' },
  { name: 'Tilted hurdle', features: [{ log: [-2.5, 0, 0, 2.5, 0, 0.6], r: 0.25 }], expect: { cross: true, vault: 'left' }, plan: 'swing the legs over the low (left) end' },
  { name: 'Stone wall, 1.0 m', features: [{ block: [0, 0], size: [5, 1.0, 0.4] }], expect: { cross: true, vault: true }, plan: 'hands on top, legs over' },
  { name: 'Hurdle, 1.2 m', features: [hurdle(1.2, 0.3)], expect: { cross: true }, plan: 'crawl under it (0.6 m below), or climb over' },
  { name: 'Stem at 30°', features: [{ stem: [0, -1], ang: 30, len: 9, r: 0.2, prop: true }], expect: { height: 3, hands: false }, plan: 'walk up it' },
  { name: 'Stem at 50°', features: [{ stem: [0, -1], ang: 50, len: 8, r: 0.2, prop: true }], expect: { height: 3, hands: true }, plan: 'climb it on hands and feet' },
  { name: 'Stem at 65°', features: [{ stem: [0, -1], ang: 65, len: 7, r: 0.2, prop: true }], expect: { height: 2.5, hands: true }, plan: 'climb it hand over hand' },
  { name: 'Stem at 75°', features: [{ stem: [0, -1], ang: 75, len: 7, r: 0.2, prop: true }], expect: { hands: true }, plan: 'too steep: get on it, but no higher than a reach (expect under 1.5 m)', maxHeight: 1.5 },
  { name: 'Ledge, 0.5 m', features: [{ block: [0, 3], size: [5, 0.5, 6] }], expect: { cross: true, height: 0.45, hands: false }, plan: 'step up' },
  { name: 'Ledge, 1.2 m', features: [{ block: [0, 3], size: [5, 1.2, 6] }], expect: { cross: true, height: 1.15 }, plan: 'pull up onto it' },
  { name: 'Wall, 1.8 m', features: [{ block: [0, 1], size: [5, 1.8, 1.2] }], expect: { stop: true }, plan: 'too high: stopped' },
  { name: 'Rock slab, 40°', features: [{ block: [0, 3], size: [4, 0.6, 9], pitch: 40, y: -0.4 }], expect: { height: 1.8, hands: false }, plan: 'walk up' },
  { name: 'Rock slab, 55°', features: [{ block: [0, 3], size: [4, 0.6, 9], pitch: 55, y: -0.4 }], expect: { height: 2.5, hands: true }, plan: 'scramble up, hands pressed on the rock' },
  { name: 'Trunks 1.3 m apart', features: [{ trunk: [-0.85, 0], d: 40 }, { trunk: [0.85, 0], d: 40 }], expect: { cross: true }, plan: 'walk between' },
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
    trees.push({ st: 2, sp: 0, x: x0, z: z0, d: r * 200, h: L, t: 1, gym: true, rest: { a: Math.atan2(z1 - z0, x1 - x0), sx: r, sz: r, L, fd: 0, pieces: [{ x0, y0, z0, x1, y1, z1, u0: 0.2, u1: 0.8, rx0: r, rx1: r, rz0: r, rz1: r, r }] } });
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

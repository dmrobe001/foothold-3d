// Foothold world generation: terrain + hydrology + an individual-based forest stand simulation.
//
// Pure JavaScript, no dependencies, no DOM: runs in the browser and in Node (see tools/sim-report.mjs).
// Same seed + same options => same world (all randomness flows from seeded PRNGs).
//
// Pipeline
//   1. Terrain: domain-warped fractional Brownian motion (fBm) + ridged noise, then droplet hydraulic erosion.
//   2. Hydrology: multiple-flow-direction (MFD) flow accumulation -> topographic wetness index (TWI), streams.
//   3. Site fields: moisture, elevation, rockiness, aspect.
//   4. Stand simulation: trees establish, compete for light, grow, die, stand as snags, fall as logs, decay.
//      Windstorms knock down patches. Uprooted trees leave pit-and-mound microtopography.
//   5. Microtopography is written back into the heightmap; derived light/debris fields are exported.

export const WORLD = 512;          // metres per side
export const N = 257;              // heightmap vertices per side
export const CELL = WORLD / (N - 1); // 2 m
export const HALF = WORLD / 2;

// ---------------------------------------------------------------- randomness
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash3(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

export function makeNoise2D(rand) {
  const grad = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  return function (x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { g = grad[perm[ii + perm[jj]] & 7]; tt *= tt; n += tt * tt * (g[0] * x0 + g[1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { g = grad[perm[ii + i1 + perm[jj + j1]] & 7]; tt *= tt; n += tt * tt * (g[0] * x1 + g[1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { g = grad[perm[ii + 1 + perm[jj + 1]] & 7]; tt *= tt; n += tt * tt * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  };
}
function fbm(nz, x, y, oct, lac = 2, gain = 0.5) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) { s += a * nz(x * f, y * f); n += a; a *= gain; f *= lac; }
  return s / n;
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Bilinear sample of an n×n grid spanning the world (origin at -HALF).
export function sampleGrid(G, n, x, z) {
  const c = WORLD / (n - 1);
  const gx = (x + HALF) / c, gz = (z + HALF) / c;
  const i = clamp(Math.floor(gx), 0, n - 2), j = clamp(Math.floor(gz), 0, n - 2);
  const fx = clamp(gx - i, 0, 1), fz = clamp(gz - j, 0, 1);
  const k = j * n + i;
  return G[k] * (1 - fx) * (1 - fz) + G[k + 1] * fx * (1 - fz) + G[k + n] * (1 - fx) * fz + G[k + n + 1] * fx * fz;
}

// ---------------------------------------------------------------- species
// Traits are loosely modelled on a northern mixed forest. Units: dbh (diameter at breast height) in cm,
// growth G in cm of diameter per year at full light on an ideal site, lifespan in years, Hmax in metres.
// mOpt/mW: moisture niche (gaussian centre/width), eBias: preference for high (+) or low (-) ground,
// tol: shade tolerance 0..1, half: light level giving half-maximal growth, disp: seed dispersal length (m),
// decay: multiplier on log residence time.
export const SPECIES = [
  { name: 'Fir',   kind: 'conifer', mOpt: 0.68, mW: 0.26, eBias: 0.35,  tol: 0.9,  half: 0.05, G: 0.58, dmax: 90, life: 300, Hmax: 36, disp: 14, decay: 1.3,  fPref: 0.5,  phot: 0.25, sinu: 0.02 },
  { name: 'Pine',  kind: 'pine',    mOpt: 0.22, mW: 0.22, eBias: 0.15,  tol: 0.15, half: 0.35, G: 0.75, dmax: 85, life: 260, Hmax: 31, disp: 28, decay: 1.25, fPref: 0.15, phot: 0.6,  sinu: 0.07 },
  { name: 'Maple', kind: 'broad',   mOpt: 0.50, mW: 0.24, eBias: -0.35, tol: 0.75, half: 0.09, G: 0.66, dmax: 95, life: 240, Hmax: 29, disp: 11, decay: 0.8,  fPref: 0.85, phot: 1.0,  sinu: 0.08 },
  { name: 'Birch', kind: 'birch',   mOpt: 0.55, mW: 0.34, eBias: 0.0,   tol: 0.1,  half: 0.4,  G: 0.95, dmax: 50, life: 110, Hmax: 23, disp: 40, decay: 0.6,  fPref: 0.5,  phot: 1.3,  sinu: 0.1 },
];
// fPref: preferred soil fertility; phot: phototropic lean strength (conifers keep a straight leader through apical control);
// sinu: typical stem sinuosity amplitude in metres.

// Bedrock sets soil fertility, drainage, depth on slopes, and how rocks look.
// fert 0..1 shifts species composition and growth; drain shifts site moisture; soil scales soil depth, which controls
// windthrow and uprooting (shallow roots), stem form (stress, damage) and how much rock breaks the surface.
export const GEOLOGY = {
  granite:   { name: 'Granite',   fert: 0.4,  drain: 0.0,   soil: 0.55, rockBias: 0.12 },
  sandstone: { name: 'Sandstone', fert: 0.25, drain: -0.09, soil: 0.85, rockBias: 0.0 },
  basalt:    { name: 'Basalt',    fert: 0.85, drain: 0.03,  soil: 0.65, rockBias: 0.08 },
};
export const NF = 1025;              // fine heightmap vertices per side (0.5 m)
export function treeHeight(sp, d) { return 1.3 + SPECIES[sp].Hmax * Math.pow(1 - Math.exp(-0.035 * d), 1.15); }
export function crownRadius(sp, d) {
  const k = SPECIES[sp].kind;
  const a = k === 'conifer' ? 0.12 : k === 'pine' ? 0.11 : k === 'birch' ? 0.12 : 0.16;
  return 0.35 + a * Math.pow(d, 0.85);
}
// root plate radius (m) for dbh d (cm) and soil depth index 0..1: what tears out when the tree tips over. Shared by the
// pits written here, the root wads the game draws, and the root graphs in plants.js.
export function plateRadius(d, soil = 0.6) { return 0.45 + 0.025 * d * (0.75 + 0.5 * soil); }
export const plateThickness = (d, soil = 0.6) => Math.min(0.2 + 0.01 * d, 0.25 + 0.7 * soil);
export function crownFraction(sp) {
  const k = SPECIES[sp].kind;
  return k === 'conifer' ? 0.7 : k === 'pine' ? 0.3 : k === 'birch' ? 0.45 : 0.48;
}

// ---------------------------------------------------------------- terrain
function erode(H, rand, droplets) {
  // Droplet erosion (after Hans Theobald Beyer, 2015). Operates on heights normalised to ~0..1.
  const inertia = 0.05, capF = 4, minCap = 0.01, erS = 0.3, depS = 0.3, evap = 0.012, grav = 4, life = 32, R = 2;
  const brush = [];
  let wsum = 0;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    const d = Math.hypot(di, dj); if (d > R) continue; const w = 1 - d / R; brush.push([di, dj, w]); wsum += w;
  }
  for (const b of brush) b[2] /= wsum;
  const bil = (x, y) => {
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, k = iy * N + ix;
    return H[k] * (1 - fx) * (1 - fy) + H[k + 1] * fx * (1 - fy) + H[k + N] * (1 - fx) * fy + H[k + N + 1] * fx * fy;
  };
  for (let it = 0; it < droplets; it++) {
    let x = 2 + rand() * (N - 5), y = 2 + rand() * (N - 5), dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let l = 0; l < life; l++) {
      const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, k = iy * N + ix;
      const h00 = H[k], h10 = H[k + 1], h01 = H[k + N], h11 = H[k + N + 1];
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy, gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
      dx = dx * inertia - gx * (1 - inertia); dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) break;
      dx /= len; dy /= len; x += dx; y += dy;
      if (x < 2 || y < 2 || x >= N - 3 || y >= N - 3) break;
      const dh = bil(x, y) - h;
      const cap = Math.max(-dh * speed * water * capF, minCap);
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depS;
        sed -= amt;
        H[k] += amt * (1 - fx) * (1 - fy); H[k + 1] += amt * fx * (1 - fy); H[k + N] += amt * (1 - fx) * fy; H[k + N + 1] += amt * fx * fy;
      } else {
        const amt = Math.min((cap - sed) * erS, -dh);
        for (const [di, dj, w] of brush) { const kk = (iy + dj) * N + ix + di; H[kk] -= amt * w; }
        sed += amt;
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * grav));
      water *= 1 - evap;
    }
  }
}
function blur(G, n, passes, mix = 1) {
  const T = new Float32Array(G.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= n || b >= n) continue; s += G[b * n + a]; c++;
      }
      T[j * n + i] = G[j * n + i] * (1 - mix) + (s / c) * mix;
    }
    G.set(T);
  }
}

// ---------------------------------------------------------------- the generator
export const MOISTURE = { dry: -0.2, mesic: 0, wet: 0.2 };
export const STORMS = { none: 0, occasional: 1 / 30, frequent: 1 / 10 }; // windthrow events per year per 26 ha

export async function generateWorld(opt = {}, progress = async () => {}) {
  const seed = opt.seed ?? 1, age = opt.age ?? 160;
  const moist = MOISTURE[opt.moisture ?? 'mesic'] ?? 0;
  const stormRate = STORMS[opt.storms ?? 'occasional'] ?? STORMS.occasional;
  const geo = GEOLOGY[opt.geology ?? 'granite'] ?? GEOLOGY.granite;
  const snow = clamp(0.6 + moist * 2.5, 0.1, 1.2); // wetter climate: deeper snowpack, more soil and snow creep on slopes
  const t0 = Date.now();
  const R = (k) => mulberry32((seed * 2654435761 + k * 40503) >>> 0);
  const rand = R(1);

  // 1. terrain -------------------------------------------------------------
  const nzA = makeNoise2D(R(2)), nzB = makeNoise2D(R(3)), nzW = makeNoise2D(R(4)), nzC = makeNoise2D(R(5)), nzD = makeNoise2D(R(6));
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i * CELL - HALF, z = j * CELL - HALF;
    const wx = x + 50 * fbm(nzW, x / 350, z / 350, 3), wz = z + 50 * fbm(nzW, x / 350 + 31.7, z / 350 - 12.3, 3);
    const base = fbm(nzA, wx / 520, wz / 520, 5) * 36;
    const rmask = 0.45 + 0.55 * smoothstep(-0.4, 0.5, fbm(nzC, x / 700, z / 700, 2));
    const r = 1 - Math.abs(fbm(nzB, wx / 230, wz / 230, 4));
    const det = fbm(nzD, x / 45, z / 45, 3) * 1.4;
    H[j * N + i] = base + r * r * 20 * rmask + det;
  }
  await progress('Shaping terrain', 0.04);
  const S = 50;
  for (let k = 0; k < H.length; k++) H[k] /= S;
  erode(H, R(7), 90000);
  for (let k = 0; k < H.length; k++) H[k] *= S;
  blur(H, N, 1, 0.35);
  let hmin = Infinity, hmax = -Infinity;
  for (const h of H) { if (h < hmin) hmin = h; if (h > hmax) hmax = h; }
  for (let k = 0; k < H.length; k++) H[k] -= hmin;
  hmax -= hmin;
  await progress('Eroding valleys', 0.14);

  // 2. hydrology -----------------------------------------------------------
  const slope = new Float32Array(N * N), north = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const gx = (H[j * N + Math.min(i + 1, N - 1)] - H[j * N + Math.max(i - 1, 0)]) / (2 * CELL);
    const gz = (H[Math.min(j + 1, N - 1) * N + i] - H[Math.max(j - 1, 0) * N + i]) / (2 * CELL);
    const g = Math.hypot(gx, gz);
    slope[k] = g;
    north[k] = (gz / (g + 1e-6)) * smoothstep(0, 0.3, g); // north is -z; a north-facing slope rises toward +z
  }
  const order = new Uint32Array(N * N).map((_, k) => k).sort((a, b) => H[b] - H[a]);
  const acc = new Float32Array(N * N).fill(1);
  const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  const wts = new Float32Array(8);
  for (const k of order) {
    const i = k % N, j = (k / N) | 0;
    let sum = 0;
    for (let q = 0; q < 8; q++) {
      const a = i + nb[q][0], b = j + nb[q][1]; wts[q] = 0;
      if (a < 0 || b < 0 || a >= N || b >= N) continue;
      const dh = H[k] - H[b * N + a];
      if (dh > 0) { wts[q] = Math.pow(dh / nb[q][2], 1.1); sum += wts[q]; }
    }
    if (sum <= 0) continue;
    for (let q = 0; q < 8; q++) if (wts[q] > 0) acc[(j + nb[q][1]) * N + i + nb[q][0]] += (acc[k] * wts[q]) / sum;
  }
  const twi = new Float32Array(N * N);
  for (let k = 0; k < twi.length; k++) twi[k] = Math.log((acc[k] * CELL) / Math.max(slope[k], 0.02));
  const sorted = Float32Array.from(twi).sort();
  const lo = sorted[(0.05 * sorted.length) | 0], hi = sorted[(0.97 * sorted.length) | 0];
  const wet = new Float32Array(N * N), stream = new Float32Array(N * N);
  for (let k = 0; k < wet.length; k++) {
    wet[k] = clamp((twi[k] - lo) / (hi - lo), 0, 1);
    stream[k] = smoothstep(900, 4000, acc[k]); // ~0.4–1.6 ha catchment: channel head
  }
  blur(wet, N, 2);
  // carve stream beds slightly
  for (let k = 0; k < H.length; k++) if (stream[k] > 0) H[k] -= stream[k] * (0.35 + 0.25 * Math.log10(acc[k] / 900 + 1));
  const streamSoft = Float32Array.from(stream); blur(streamSoft, N, 1);
  await progress('Routing water', 0.2);

  // 3. site fields ---------------------------------------------------------
  const moistF = new Float32Array(N * N), rock = new Float32Array(N * N), elev = new Float32Array(N * N);
  const soil = new Float32Array(N * N), expo = new Float32Array(N * N);
  const nzR = makeNoise2D(R(8));
  for (let k = 0; k < moistF.length; k++) {
    const i = k % N, j = (k / N) | 0, x = i * CELL - HALF, z = j * CELL - HALF;
    moistF[k] = clamp(0.14 + 0.72 * wet[k] + 0.12 * north[k] + moist + geo.drain + 0.06 * fbm(nzR, x / 90, z / 90, 2), 0, 1);
    elev[k] = H[k] / hmax;
    rock[k] = clamp(smoothstep(0.5, 0.95, slope[k]) + geo.rockBias * smoothstep(0.25, 0.7, slope[k]) + 0.5 * smoothstep(0.25, 0.7, fbm(nzR, x / 35 + 9, z / 35, 3)) * smoothstep(0.65, 0.95, elev[k]), 0, 1);
    soil[k] = clamp(geo.soil * (1 - rock[k]) * (1 - 0.6 * smoothstep(0.3, 0.9, slope[k])) + 0.25 * wet[k], 0.05, 1);
    expo[k] = smoothstep(0.55, 0.95, elev[k]) * (1 - wet[k]);   // ridge-top wind exposure
  }
  const site = (x, z) => ({
    m: sampleGrid(moistF, N, x, z), e: sampleGrid(elev, N, x, z),
    r: sampleGrid(rock, N, x, z), s: sampleGrid(streamSoft, N, x, z),
    soil: sampleGrid(soil, N, x, z), ex: sampleGrid(expo, N, x, z),
  });
  const suit = (sp, st) => {
    const P = SPECIES[sp];
    const dm = (st.m - P.mOpt) / P.mW;
    const df = (geo.fert - P.fPref) / 0.6;
    return Math.exp(-dm * dm - df * df) * Math.exp(P.eBias * (st.e - 0.5) * 2) * (1 - 0.85 * st.r) * (1 - 0.95 * st.s);
  };

  // 4. stand simulation ----------------------------------------------------
  // Periodic boundaries for neighbour interactions, so the domain edge is not an artificial forest edge.
  const areaHa = (WORLD * WORLD) / 1e4;
  const GC = 10, NG = Math.ceil(WORLD / GC), RAD = 10, RAD2 = RAD * RAD, K = 7.5;
  const buckets = Array.from({ length: NG * NG }, () => []);
  const wrap = (d) => (d > HALF ? d - WORLD : d < -HALF ? d + WORLD : d);
  const cellOf = (x, z) => [clamp(Math.floor((x + HALF) / GC), 0, NG - 1), clamp(Math.floor((z + HALF) / GC), 0, NG - 1)];
  const trees = []; // {x,z,sp,d,h,st:0 live|1 snag|2 log, t, ang, up, sh, len, s, bornAt, diedAt}
  const pits = [];  // pit-and-mound records {x,z,ang,r,year}
  const live = () => trees.filter((t) => t.st === 0);
  function rebuild() {
    for (const b of buckets) b.length = 0;
    for (const t of trees) if (t.st === 0) { const [ci, cj] = cellOf(t.x, t.z); buckets[cj * NG + ci].push(t); }
  }
  function shade(x, z, href, ex) {
    const [ci, cj] = cellOf(x, z);
    let s = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const b = buckets[((cj + dj + NG) % NG) * NG + ((ci + di + NG) % NG)];
      for (let q = 0; q < b.length; q++) {
        const o = b[q];
        if (o === ex || o.h <= href) continue;
        const dx = wrap(o.x - x), dz = wrap(o.z - z), d2 = dx * dx + dz * dz;
        if (d2 > RAD2) continue;
        s += o.ba * (1 - Math.sqrt(d2) / RAD);
      }
    }
    return Math.exp(-K * s);
  }
  const addTree = (x, z, sp, d, year) => {
    const st = site(x, z);
    const t = { x, z, sp, d, h: treeHeight(sp, d), hf: 1, ba: Math.PI * (d / 200) ** 2, st: 0, t: 0, ang: 0, up: false, sh: 0, len: 0, s: suit(sp, st), soil: st.soil, ex: st.ex, bornAt: year };
    trees.push(t); return t;
  };
  const windDir = rand() * Math.PI * 2;
  const pickSpecies = (st, pioneerBoost) => {
    const w = SPECIES.map((P, i) => suit(i, st) * (P.tol < 0.3 ? pioneerBoost : 1));
    let tot = w.reduce((a, b) => a + b, 0) * rand();
    for (let i = 0; i < w.length; i++) { tot -= w[i]; if (tot <= 0) return i; }
    return 0;
  };
  const uniformXZ = () => [rand() * WORLD - HALF, rand() * WORLD - HALF];

  // t = 0: a stand-replacing fire. Seedlings flush in; fire-killed legacy trees stand as snags or lie as logs.
  for (let n = 0; n < areaHa * 600; n++) {
    const [x, z] = uniformXZ(); const st = site(x, z); const sp = pickSpecies(st, 3);
    if (rand() < suit(sp, st)) addTree(x, z, sp, 0.5 + rand() * 1.5, 0);
  }
  for (let n = 0; n < areaHa * 45; n++) {
    const [x, z] = uniformXZ(); const st = site(x, z); const sp = pickSpecies(st, 0.5);
    if (rand() > suit(sp, st) + 0.15) continue;
    const t = addTree(x, z, sp, 30 + rand() * 50, -200);
    if (rand() < 0.55) { t.st = 1; t.sh = t.h * (0.35 + 0.6 * rand()); t.t = 0; }
    else { t.st = 2; t.ang = rand() * Math.PI * 2; t.len = t.h * (0.5 + 0.4 * rand()); t.t = rand() * 15; t.up = rand() < 0.3; }
    t.diedAt = 0;
  }

  const dt = 5, steps = Math.max(1, Math.round(age / dt));
  const stats = { deaths: 0, storms: 0 };
  for (let step = 0; step < steps; step++) {
    const year = (step + 1) * dt;
    rebuild();
    // growth + mortality of live trees
    for (const t of trees) {
      if (t.st !== 0) continue;
      const P = SPECIES[t.sp];
      const L = shade(t.x, t.z, t.h, t);
      const g = P.G * Math.min(1, 0.25 + t.s) * (0.8 + 0.4 * geo.fert) * (0.7 + 0.3 * t.soil) * (L / (L + P.half)) * Math.max(0, 1 - t.d / P.dmax);
      t.L = L;
      let rate = (1 / P.life) * (1 + 3 * Math.pow(t.d / P.dmax, 4));
      if (g < 0.08) rate += 0.07 * (1 - g / 0.08) * (1 - 0.8 * P.tol);
      if (t.d < 3) rate += 0.02;
      // Height-diameter allocation: shaded stems put growth into height (slender); open-grown, shallow-soiled
      // or wind-exposed stems stay shorter and stouter (thigmomorphogenesis).
      const hfT = (0.86 + 0.24 * (1 - L)) * (0.82 + 0.18 * t.soil) * (1 - 0.15 * t.ex);
      t.hf += (hfT - t.hf) * 0.35;
      t.d += g * dt; t.h = treeHeight(t.sp, t.d) * t.hf; t.ba = Math.PI * (t.d / 200) ** 2;
      if (rand() < 1 - Math.exp(-dt * rate)) killTree(t, year, false);
    }
    // windstorms
    let events = 0; const lam = stormRate * dt * (areaHa / 26);
    { let L = Math.exp(-lam), p = 1; do { p *= rand(); events++; } while (p > L); events--; }
    for (let e = 0; e < events; e++) {
      stats.storms++;
      const [cx, cz] = uniformXZ(); const r = 20 + rand() * 55; const dir = windDir + (rand() - 0.5) * 0.7;
      for (const t of trees) {
        if (t.st !== 0 || t.h < 8) continue;
        const dx = wrap(t.x - cx), dz = wrap(t.z - cz), q = (dx * dx + dz * dz) / (r * r);
        if (q > 1) continue;
        if (rand() < (1 - q) * Math.pow(clamp(t.h / 26, 0, 1), 1.5) * (1.25 - 0.45 * t.soil) * (0.8 + 0.4 * t.ex)) killTree(t, year, true, dir + (rand() - 0.5) * 0.5);
      }
    }
    // snags fall, logs decay
    for (const t of trees) {
      if (t.st === 1) {
        t.t += dt;
        if (rand() < 0.15) t.sh *= 0.75 + 0.2 * rand(); // tops break off
        if (rand() < 1 - Math.exp(-dt / (6 + 0.35 * t.d * SPECIES[t.sp].decay))) {
          t.st = 2; t.t = 0; t.len = t.sh * (0.8 + 0.2 * rand());
          t.ang = rand() < 0.5 ? windDir + (rand() - 0.5) * 1.4 : rand() * Math.PI * 2;
        }
      } else if (t.st === 2) {
        t.t += dt;
        if (t.t > (15 + 1.3 * t.d) * SPECIES[t.sp].decay) t.st = 3;
      }
    }
    // recruitment: seeds from parents (dispersal kernel) plus background seed rain; establishment needs light
    rebuild();
    const adults = trees.filter((t) => t.st === 0 && t.d > 12);
    const tries = Math.round(areaHa * 40 * dt);
    for (let n = 0; n < tries; n++) {
      let x, z, sp;
      if (adults.length && rand() < 0.75) {
        const p = adults[(rand() * adults.length) | 0]; sp = p.sp;
        const r = -SPECIES[sp].disp * Math.log(1 - rand()), a = rand() * Math.PI * 2;
        x = p.x + r * Math.cos(a); z = p.z + r * Math.sin(a);
        x = ((x + HALF) % WORLD + WORLD) % WORLD - HALF; z = ((z + HALF) % WORLD + WORLD) % WORLD - HALF;
      } else { [x, z] = uniformXZ(); sp = pickSpecies(site(x, z), 1.5); }
      const P = SPECIES[sp];
      const Lg = shade(x, z, 0.3, null);
      const pEst = suit(sp, site(x, z)) * (Lg / (Lg + P.half)) * 0.55;
      if (rand() < pEst) addTree(x, z, sp, 0.5 + rand(), year);
    }
    // purge fully decayed material
    if (step % 4 === 3) { let w = 0; for (const t of trees) if (t.st !== 3) trees[w++] = t; trees.length = w; }
    await progress(`Growing forest: year ${year} of ${steps * dt}`, 0.2 + 0.7 * (step + 1) / steps);
  }
  { let w = 0; for (const t of trees) if (t.st !== 3) trees[w++] = t; trees.length = w; }

  function killTree(t, year, storm, dir) {
    stats.deaths++;
    t.diedAt = year;
    if (t.d < 5) { t.st = 3; return; } // small stems vanish quickly
    if (storm || (t.h > 15 && rand() < 0.2 * (t.h / 30) * (1.6 - t.soil))) {
      const snapped = storm && rand() < 0.55 * t.soil; // deep-rooted trees snap; shallow-rooted ones tip over
      t.st = 2; t.t = 0; t.ang = dir ?? windDir + (rand() - 0.5) * 2; t.len = t.h * (0.85 + 0.15 * rand());
      if (snapped) { // snapped stem: log plus a jagged high stump
        const stub = addTree(t.x, t.z, t.sp, t.d, t.bornAt); stub.st = 1; stub.sh = 1.5 + rand() * 5; stub.diedAt = year;
        t.len -= stub.sh; t.snapBase = stub.sh;
      } else {
        t.up = true;
        pits.push({ x: t.x, z: t.z, ang: t.ang, r: plateRadius(t.d, t.soil), th: plateThickness(t.d, t.soil), year });
      }
    } else { t.st = 1; t.t = 0; t.sh = t.h * (0.6 + 0.4 * rand()); }
  }

  // 5. microtopography: pits where root plates tore out and mounds where they rot down. Written into the 0.5 m
  //    ground (step 8): on the 2 m grid a pit the size of a root plate barely shows.

  // 6. derived fields for rendering ------------------------------------------------------------------
  rebuild();
  const LN = 129; // 4 m grid
  const light = new Float32Array(LN * LN);
  for (let j = 0; j < LN; j++) for (let i = 0; i < LN; i++) {
    const x = (i * WORLD) / (LN - 1) - HALF, z = (j * WORLD) / (LN - 1) - HALF;
    light[j * LN + i] = shade(x, z, 1.0, null);
  }
  blur(light, LN, 1, 0.5);
  // conifer share of overhead canopy -> needle duff vs leaf litter
  const conShare = new Float32Array(LN * LN);
  {
    const cAcc = new Float32Array(LN * LN), tAcc = new Float32Array(LN * LN);
    for (const t of trees) if (t.st === 0 && t.d > 5) {
      const i = Math.round(((t.x + HALF) / WORLD) * (LN - 1)), j = Math.round(((t.z + HALF) / WORLD) * (LN - 1));
      const k = j * LN + i, k2 = SPECIES[t.sp].kind;
      tAcc[k] += t.ba; if (k2 === 'conifer' || k2 === 'pine') cAcc[k] += t.ba;
    }
    blur(cAcc, LN, 3); blur(tAcc, LN, 3);
    for (let k = 0; k < conShare.length; k++) conShare[k] = tAcc[k] > 1e-5 ? cAcc[k] / tAcc[k] : 0.5;
  }

  // 7. stem form: lean toward light, basal sweep from slope creep, sinuosity -------------------------------
  // Offsets are in metres. lean*: displacement of the top of the stem; sweep*: pistol-butt offset reached a
  // couple of metres up; A, k, ph: sinuosity amplitude, wavenumber (rad/m) and phase in the stem's local frame.
  {
    const fr = R(11);
    const gH = (x, z) => sampleGrid(H, N, x, z);
    for (const t of trees) {
      const P = SPECIES[t.sp], soilT = t.soil ?? 0.6;
      const f = { lx: 0, lz: 0, sx: 0, sz: 0, A: 0, k: 1, ph: fr() * 6.283 };
      if (t.st === 0 && t.h > 3) {
        const y = t.h * 0.6, e = 4;
        const gx = shade(t.x + e, t.z, y, t) - shade(t.x - e, t.z, y, t), gz = shade(t.x, t.z + e, y, t) - shade(t.x, t.z - e, y, t);
        const gm = Math.hypot(gx, gz) + 1e-6, pull = clamp(gm * 4, 0, 1) * (1 - 0.6 * (t.L ?? 0.5)) * P.phot;
        f.lx = (gx / gm) * pull * t.h * 0.09; f.lz = (gz / gm) * pull * t.h * 0.09;
        const wl = t.ex * t.h * 0.03; f.lx += Math.cos(windDir) * wl; f.lz += Math.sin(windDir) * wl;
        f.lx += (fr() - 0.5) * t.h * 0.02; f.lz += (fr() - 0.5) * t.h * 0.02;
      }
      {
        const hx = gH(t.x + 2, t.z) - gH(t.x - 2, t.z), hz = gH(t.x, t.z + 2) - gH(t.x, t.z - 2), gm = Math.hypot(hx, hz) / 4;
        const sw = Math.min(1.2, gm * 1.6 * snow * (0.5 + 0.8 * soilT) * (P.kind === 'conifer' ? 1.2 : 1)) * (0.5 + fr()) * clamp(t.d / 30, 0.2, 1);
        if (gm > 0.01) { f.sx = (-hx / (gm * 4)) * sw; f.sz = (-hz / (gm * 4)) * sw; }
      }
      f.A = P.sinu * (1 + 1.0 * (1 - soilT)) * (0.4 + 0.8 * fr() * fr()) * clamp(t.d / 25, 0.3, 1);
      f.k = 6.283 / (5 + 8 * fr());
      t.form = f;
    }
  }

  // 8. fine heightmap: bicubic upsampling to 0.5 m plus micro-relief (soil texture, hummocks, rock knobs) --------
  await progress('Detailing ground', 0.93);
  const HF = new Float32Array(NF * NF);
  {
    const n1 = makeNoise2D(R(12)), n2 = makeNoise2D(R(13)), n3 = makeNoise2D(R(14));
    const at = (i, j) => H[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
    const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    const ratio = (NF - 1) / (N - 1);
    const col = new Float64Array(4);
    for (let J = 0; J < NF; J++) {
      const gz = J / ratio, j = Math.min(N - 2, Math.floor(gz)), tz = gz - j;
      for (let I = 0; I < NF; I++) {
        const gx = I / ratio, i = Math.min(N - 2, Math.floor(gx)), tx = gx - i;
        for (let q = 0; q < 4; q++) col[q] = cr(at(i - 1, j - 1 + q), at(i, j - 1 + q), at(i + 1, j - 1 + q), at(i + 2, j - 1 + q), tx);
        let h = cr(col[0], col[1], col[2], col[3], tz);
        const x = I * 0.5 - HALF, z = J * 0.5 - HALF, k = j * N + i;
        const rk = rock[k], st = streamSoft[k], wt = wet[k];
        h += 0.09 * n1(x / 3.1, z / 3.1) + 0.035 * n2(x / 1.15, z / 1.15);
        if (rk > 0.05) { const r = 1 - Math.abs(n3(x / 4.5, z / 4.5)); h += rk * (0.45 * r * r - 0.15); }
        if (wt > 0.5 && st < 0.3) h += (wt - 0.5) * 0.25 * Math.max(0, n3(x / 1.4 + 50, z / 1.4));
        h -= st * 0.06;
        HF[J * NF + I] = h;
      }
    }
    // pit and mound: the plate tore out of a bowl at the stem base (slightly upwind: it hinges on the fall side);
    // it stood up over the base and, as it rots, slumps into a mound there. Pits fill over centuries.
    for (const p of pits) {
      const ageY = age - p.year, fill = Math.exp(-ageY / 300), slump = 1 - Math.exp(-ageY / 25);
      const ca = Math.cos(p.ang), sa = Math.sin(p.ang), R = p.r, Rr = R * 2.4;
      for (let J = Math.max(0, Math.floor((p.z - Rr + HALF) / 0.5)); J <= Math.min(NF - 1, Math.ceil((p.z + Rr + HALF) / 0.5)); J++)
        for (let I = Math.max(0, Math.floor((p.x - Rr + HALF) / 0.5)); I <= Math.min(NF - 1, Math.ceil((p.x + Rr + HALF) / 0.5)); I++) {
          const dx = I * 0.5 - HALF - p.x, dz = J * 0.5 - HALF - p.z, a = dx * ca + dz * sa, b = -dx * sa + dz * ca; // a: along the fall
          const qp = ((a + R * 0.25) / (R * 0.8)) ** 2 + (b / R) ** 2, qm = ((a - R * 0.45) / (R * 0.55)) ** 2 + (b / (R * 0.9)) ** 2;
          const bowl = qp < 1.6 ? -p.th * fill * Math.pow(Math.max(0, 1 - qp / 1.6), 1.6) * 1.35 : 0;
          HF[J * NF + I] += bowl + 0.6 * p.th * slump * fill * Math.exp(-qm * 2);
        }
    }
  }

  const world = {
    seed, age: steps * dt, opt: { ...opt }, geology: geo, H, HF, hmax, slope, wet, stream: streamSoft, moist: moistF, rock, north, soil,
    light, conShare, LN, trees, pits, windDir, stats: null, genMs: 0,
  };
  world.stats = standStats(world);
  world.stats.storms = stats.storms;
  world.genMs = Date.now() - t0;
  await progress('Planting', 0.97);
  return world;
}

// ---------------------------------------------------------------- stand statistics
// Conventions follow forest inventory practice: "trees" are live stems with dbh >= 10 cm,
// coarse woody debris (CWD) is dead wood >= 10 cm diameter. Volumes use a 0.5 form factor (tapered cone-ish).
export function standStats(world) {
  const areaHa = (WORLD * WORLD) / 1e4;
  const s = { areaHa, stems: 0, saplings: 0, ba: 0, snags: 0, logs: 0, logVol: 0, snagVol: 0, uprooted: 0, bySpeciesBA: SPECIES.map(() => 0) };
  const dbhBins = new Array(20).fill(0); // 5 cm bins, live stems >= 5 cm
  const pts = [];
  for (const t of world.trees) {
    const r = t.d / 200;
    if (t.st === 0) {
      if (t.d >= 10) { s.stems++; s.ba += Math.PI * r * r; s.bySpeciesBA[t.sp] += Math.PI * r * r; pts.push(t); }
      else s.saplings++;
      if (t.d >= 5) dbhBins[Math.min(19, Math.floor(t.d / 5))]++;
    } else if (t.st === 1 && t.d >= 10) { s.snags++; s.snagVol += 0.5 * Math.PI * r * r * t.sh; }
    else if (t.st === 2 && t.d >= 10) {
      s.logs++; if (t.up) s.uprooted++;
      const T = (15 + 1.3 * t.d) * SPECIES[t.sp].decay, shrink = 1 - 0.5 * (t.t / T); // decayed wood slumps
      s.logVol += 0.5 * Math.PI * r * r * t.len * shrink;
    }
  }
  for (const k of ['stems', 'saplings', 'ba', 'snags', 'logs', 'logVol', 'snagVol', 'uprooted']) s[k] /= areaHa;
  s.bySpeciesBA = s.bySpeciesBA.map((v) => v / areaHa);
  s.dbhBins = dbhBins.map((v) => v / areaHa);
  // pair correlation function g(r) of live stems >= 10 cm, periodic minimum-image distances
  const dr = 1, rmax = 25, nb = rmax / dr, cnt = new Float64Array(nb);
  const lam = pts.length / (WORLD * WORLD);
  const GC = 25, NG = Math.ceil(WORLD / GC), grid = Array.from({ length: NG * NG }, () => []);
  for (const p of pts) grid[clamp(Math.floor((p.z + HALF) / GC), 0, NG - 1) * NG + clamp(Math.floor((p.x + HALF) / GC), 0, NG - 1)].push(p);
  for (let cj = 0; cj < NG; cj++) for (let ci = 0; ci < NG; ci++) for (const p of grid[cj * NG + ci]) {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      for (const q of grid[((cj + dj + NG) % NG) * NG + ((ci + di + NG) % NG)]) {
        if (q === p) continue;
        let dx = q.x - p.x, dz = q.z - p.z;
        if (dx > HALF) dx -= WORLD; else if (dx < -HALF) dx += WORLD;
        if (dz > HALF) dz -= WORLD; else if (dz < -HALF) dz += WORLD;
        const d = Math.hypot(dx, dz); if (d < rmax) cnt[(d / dr) | 0]++;
      }
    }
  }
  s.gr = Array.from(cnt, (c, b) => (pts.length ? c / (pts.length * lam * Math.PI * (((b + 1) * dr) ** 2 - (b * dr) ** 2)) : 0));
  s.grDr = dr;
  return s;
}

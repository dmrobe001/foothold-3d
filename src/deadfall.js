// ---------------------------------------------------------------- deadfall settling
// A low-fidelity history of how each fallen stem came to rest, replayed oldest fall first after the stand simulation.
//
//   1. fall:   the stem rotates down about its base. Stems standing at that time in its path are met in the order the
//              falling stem reaches them. Small ones are crushed. A sturdy one either catches it (a "hung-up" tree,
//              which the holder leans away from), or the stem glances off its trunk and turns aside.
//              A hung-up tree only persists if the holder still stands and the fall is recent.
//   2. rest:   a rigid stem on the ground lies along the edge of the upper convex hull of the support profile under
//              it that spans its centre of mass: it bridges dips and rocks, and sits on the crest of a hump.
//              Support is terrain, outcrop rock and logs that came to rest earlier.
//   3. slide:  where the ground across the stem is steeper than it can grip, each end creeps downhill (so stems pivot)
//              until the slope eases, something holds it, or a standing trunk is in the way.
//   4. decay:  old logs break into pieces, preferentially where they hang unsupported, and each piece rests and
//              slides again on its own.
//   5. tidy:   whatever still overlaps a standing stem resolves by history: a stem that grew up after the log fell
//              established beside it (it is moved clear); a small stem that stood before it was crushed.
//
// Everything here is decided once per world and stored on the tree records (t.rest, t.lean, t.crushed, t.x/t.z).
import { SPECIES, crownRadius, crownFraction, treeHeight, clamp, mulberry32, hash3, HALF } from './worldgen.js';
const lerpD = (a, b, t) => a + (b - a) * t;

// lathe profile of the trunk geometry: radius as a fraction of the instance's horizontal scale, by axial fraction
export const TRUNK_PROFILE = [[0, 0.8], [0.025, 0.66], [0.07, 0.55], [0.14, 0.5], [0.24, 0.48], [0.34, 0.46], [0.45, 0.44], [0.56, 0.42], [0.67, 0.39], [0.78, 0.36], [0.89, 0.33], [1, 0.3]];
export function trunkProfile(u) {
  for (let i = 1; i < TRUNK_PROFILE.length; i++) if (u <= TRUNK_PROFILE[i][0]) { const [a, ra] = TRUNK_PROFILE[i - 1], [b, rb] = TRUNK_PROFILE[i]; return lerpD(ra, rb, (u - a) / (b - a)); }
  return 0.3;
}
export const DECAY_T = (t) => (15 + 1.3 * t.d) * SPECIES[t.sp].decay; // years a log takes to rot away (matches the stand sim)

const MU_FRESH = 0.7, MU_ROTTEN = 0.5; // steepest cross-slope (rise/run) a log grips: branch stubs pin fresh ones
const SLIDE_STEP = 0.25, SLIDE_MAX = 80;
const MIN_PIECE = 1.5;

export function settleDeadfall(W, support) {
  const age = W.age, trees = W.trees, stats = { logs: 0, lodged: 0, glanced: 0, crushed: 0, slid: 0, slidM: 0, broken: 0, pieces: 0, nudged: 0, leaned: 0 };
  const fallYear = (t) => age - t.t;
  const standingAt = (n, yr) => !n.crushed && n.bornAt <= yr && (n.st === 0 || n.st === 1 || (n.st === 2 && fallYear(n) > yr));
  const sizeAt = (n, yr) => clamp((yr - n.bornAt) / Math.max(1, (n.st === 0 ? age : n.diedAt ?? age) - n.bornAt), 0.05, 1);
  const dThen = (n, yr) => n.d * sizeAt(n, yr);
  const hThen = (n, yr) => (n.st === 1 ? n.sh : n.st === 2 ? n.h : treeHeight(n.sp, dThen(n, yr)) * (n.hf ?? 1));

  // 8 m hash of every stem record, for neighbour queries along a fall line
  const G = 8, grid = new Map(), gk = (i, j) => i * 4096 + j;
  for (const t of trees) { const k = gk(Math.floor((t.x + HALF) / G), Math.floor((t.z + HALF) / G)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(t); }
  const stemsNear = (x0, z0, x1, z1, pad, fn) => {
    for (let i = Math.floor((Math.min(x0, x1) - pad + HALF) / G); i <= Math.floor((Math.max(x0, x1) + pad + HALF) / G); i++)
      for (let j = Math.floor((Math.min(z0, z1) - pad + HALF) / G); j <= Math.floor((Math.max(z0, z1) + pad + HALF) / G); j++) { const a = grid.get(gk(i, j)); if (a) for (const n of a) fn(n); }
  };

  // 4 m hash of rested pieces, so later logs can lie on earlier ones
  const PG = 4, pgrid = new Map(), placed = [];
  const addPiece = (p) => {
    placed.push(p);
    const n = Math.ceil(Math.hypot(p.x1 - p.x0, p.z1 - p.z0) / 2) + 1, seen = new Set();
    for (let s = 0; s <= n; s++) for (const [ox, oz] of [[0, 0], [p.r, 0], [-p.r, 0], [0, p.r], [0, -p.r]]) {
      const x = lerpD(p.x0, p.x1, s / n) + ox, z = lerpD(p.z0, p.z1, s / n) + oz, k = gk(Math.floor((x + HALF) / PG), Math.floor((z + HALF) / PG));
      if (seen.has(k)) continue; seen.add(k); let a = pgrid.get(k); if (!a) pgrid.set(k, (a = [])); a.push(p);
    }
  };
  const pieceTop = (p, x, z) => {
    const vx = p.x1 - p.x0, vz = p.z1 - p.z0, L2 = vx * vx + vz * vz || 1, u = clamp(((x - p.x0) * vx + (z - p.z0) * vz) / L2, 0, 1);
    const d = Math.hypot(x - p.x0 - vx * u, z - p.z0 - vz * u), rx = lerpD(p.rx0, p.rx1, u);
    return d < rx ? lerpD(p.y0, p.y1, u) + lerpD(p.rz0, p.rz1, u) * Math.sqrt(1 - (d / rx) ** 2) : -Infinity;
  };
  const S = (x, z) => {
    let y = support(x, z); const a = pgrid.get(gk(Math.floor((x + HALF) / PG), Math.floor((z + HALF) / PG)));
    if (a) for (const p of a) { const h = pieceTop(p, x, z); if (h > y) y = h; }
    return y;
  };

  // Rest a straight stem section on the support: the hull edge under its centre of mass.
  //   sec: { x, z (start), dx, dz (unit horizontal heading), len (3D length), rx(u), rz(u) (radii at section fraction u),
  //          anchor (start xz fixed, else centre fixed), lift (minimum centre height above support at the start) }
  function rest(sec) {
    let x0 = sec.x, z0 = sec.z, hl = sec.len, y0 = 0, y1 = 0;
    const px = -sec.dz, pz = sec.dx;
    for (let it = 0; it < 3; it++) {
      const m = Math.max(4, Math.ceil(hl / 0.3)), hs = [], cs = [], ws = [];
      for (let i = 0; i <= m; i++) {
        const u = i / m, x = x0 + sec.dx * hl * u, z = z0 + sec.dz * hl * u, rx = sec.rx(u), rz = sec.rz(u), w = rx * 0.6;
        let c = Math.max(S(x, z) + rz, S(x + px * w, z + pz * w) + rz * 0.8, S(x - px * w, z - pz * w) + rz * 0.8);
        if (i === 0 && sec.lift) c = Math.max(c, support(x, z) + sec.lift);
        hs.push(hl * u); cs.push(c); ws.push(rx * rz);
      }
      // upper convex hull (monotone chain), then the edge spanning the centre of mass
      const H = [];
      for (let i = 0; i <= m; i++) {
        while (H.length >= 2) { const a = H[H.length - 2], b = H[H.length - 1]; if ((hs[b] - hs[a]) * (cs[i] - cs[a]) - (cs[b] - cs[a]) * (hs[i] - hs[a]) >= 0) H.pop(); else break; }
        H.push(i);
      }
      let sw = 0, sc = 0; for (let i = 0; i <= m; i++) { sw += ws[i]; sc += ws[i] * hs[i]; }
      const sCom = sc / sw;
      let e = 0; while (e < H.length - 2 && hs[H[e + 1]] < sCom) e++;
      const a = H[e], b = H[Math.min(e + 1, H.length - 1)], slope = b === a ? 0 : (cs[b] - cs[a]) / (hs[b] - hs[a]);
      y0 = cs[a] - slope * hs[a]; y1 = y0 + slope * hl;
      const hn = Math.sqrt(Math.max(0.25 * sec.len * sec.len, sec.len * sec.len - (y1 - y0) ** 2));
      if (!sec.anchor) { x0 += sec.dx * (hl - hn) / 2; z0 += sec.dz * (hl - hn) / 2; }
      if (Math.abs(hn - hl) < 0.01) { hl = hn; break; }
      hl = hn;
    }
    sec.x = x0; sec.z = z0;
    return { x0, y0, z0, x1: x0 + sec.dx * hl, y1, z1: z0 + sec.dz * hl, hl };
  }

  // standing stems that block a horizontal segment (for sliding); small ones are crushed instead
  function blocker(x0, z0, x1, z1, r, yr, self, crushOK) {
    let hit = null;
    stemsNear(x0, z0, x1, z1, r + 1, (n) => {
      if (hit || n === self || !standingAt(n, yr) || Math.hypot(n.x - self.x, n.z - self.z) < 0.1) return;
      const vx = x1 - x0, vz = z1 - z0, L2 = vx * vx + vz * vz || 1, u = clamp(((n.x - x0) * vx + (n.z - z0) * vz) / L2, 0, 1);
      const d = Math.hypot(n.x - x0 - vx * u, n.z - z0 - vz * u), dn = dThen(n, yr);
      if (d > r + dn / 200 + 0.03) return;
      if (dn < 6 && crushOK && n.st === 0) { n.crushed = true; stats.crushed++; return; }
      hit = n;
    });
    return hit;
  }

  // creep down a side slope steeper than the stem can grip; each end moves on its own, so stems pivot about obstacles
  function slide(sec, mu, yr, self, anchored) {
    let moved = 0, stuck0 = anchored, stuck1 = false;
    const L = sec.len;
    for (let it = 0; it < SLIDE_MAX && !(stuck0 && stuck1); it++) {
      const px = -sec.dz, pz = sec.dx, w = Math.max(0.5, sec.rx(0.5) + 0.3);
      const ends = [[sec.x, sec.z], [sec.x + sec.dx * L, sec.z + sec.dz * L]];
      const st = [0.15, 0.85].map((u) => {
        const x = sec.x + sec.dx * L * u, z = sec.z + sec.dz * L * u;
        return (S(x + px * w, z + pz * w) - S(x - px * w, z - pz * w)) / (2 * w);
      });
      let any = false;
      for (let e = 0; e < 2; e++) {
        if ((e === 0 ? stuck0 : stuck1) || Math.abs(st[e]) <= mu) continue;
        const sg = st[e] > 0 ? -1 : 1, nx = ends[e][0] + px * sg * SLIDE_STEP, nz = ends[e][1] + pz * sg * SLIDE_STEP;
        const o = ends[1 - e];
        // re-form the stem from the moved end and the other end, keeping its length about the midpoint
        const mx = (nx + o[0]) / 2, mz = (nz + o[1]) / 2, ux = (e === 0 ? o[0] - nx : nx - o[0]), uz = (e === 0 ? o[1] - nz : nz - o[1]), ul = Math.hypot(ux, uz) || 1;
        const dx = ux / ul, dz = uz / ul, sx = anchored ? sec.x : mx - dx * L / 2, sz = anchored ? sec.z : mz - dz * L / 2;
        const ex = sx + dx * L, ez = sz + dz * L;
        if (blocker(sx, sz, ex, ez, sec.rx(0.5), yr, self, true)) { if (e === 0) stuck0 = true; else stuck1 = true; continue; }
        sec.x = sx; sec.z = sz; sec.dx = dx; sec.dz = dz; moved += SLIDE_STEP; any = true;
      }
      if (!any) break;
    }
    return moved;
  }

  const logs = trees.filter((t) => t.st === 2).sort((a, b) => fallYear(a) - fallYear(b));
  for (const t of logs) {
    stats.logs++;
    const r = mulberry32(hash3(Math.round(t.x * 10), Math.round(t.z * 10), 91)), yr = fallYear(t);
    const T = DECAY_T(t), fd = clamp(t.t / T, 0, 1), rad = t.d / 100;
    const sxL = rad * (1 - 0.15 * fd), szL = rad * (1 - 0.35 * fd), rr = (t.d / 200) * (1 - 0.15 * fd), sink = rr * (0.1 + 0.9 * fd);
    const Lfall = Math.max(1, t.len), Lnow = Math.max(1, t.len * (1 - 0.3 * fd));
    const off = t.snapBase ? 0.3 : 0.2, raised = t.up && t.t < 25 ? rr * 2.2 * (1 - t.t / 25) : 0, plate = t.up && t.t < 70;
    let a = t.ang, lodged = null;
    const hang = 4 + 16 * r();

    // 1. the fall
    for (let attempt = 0; attempt < 5; attempt++) {
      const dx = Math.cos(a), dz = Math.sin(a), bx = t.x + dx * off, bz = t.z + dz * off, hits = [];
      stemsNear(bx, bz, bx + dx * Lfall, bz + dz * Lfall, 6, (n) => {
        if (n === t || !standingAt(n, yr)) return;
        const vx = n.x - bx, vz = n.z - bz, s = vx * dx + vz * dz, e = dx * vz - dz * vx;
        if (s <= 0.3 || s >= Lfall || Math.hypot(n.x - t.x, n.z - t.z) < 0.1) return;
        const dn = dThen(n, yr), rn = dn / 200, hn = hThen(n, yr), rA = sxL * trunkProfile(s / Lfall);
        const trunk = Math.abs(e) < rA + rn + 0.02, crown = !trunk && n.st === 0 && dn >= 8 && Math.abs(e) < rA + 0.35 * crownRadius(n.sp, dn);
        if (!trunk && !crown) return;
        const th = Math.max(Math.asin(Math.min(1, s / Lfall)), Math.atan2(s, hn));
        if (crown && Math.sqrt(Lfall * Lfall - s * s) < hn * (1 - crownFraction(n.sp))) return; // passes under the crown
        hits.push({ n, s, e, dn, rn, hn, rA, trunk, th });
      });
      hits.sort((p, q) => p.th - q.th);
      let turned = false;
      for (const h of hits) {
        const { n } = h;
        if (h.dn < Math.max(6, 0.3 * t.d)) { if (h.trunk && n.st === 0) { n.crushed = true; stats.crushed++; } continue; }
        const holds = (n.st === 0 || n.st === 1) && t.t < hang && !t.snapBase;
        if (holds && r() < clamp(0.15 + 0.45 * (h.dn / t.d), 0.15, 0.7) * (h.trunk ? 1 : 0.6)) {
          const sd = Math.hypot(n.x - bx, n.z - bz);
          const hc = Math.min(hThen(n, yr) * (1 - crownFraction(n.sp)) * (0.7 + 0.5 * r()), Math.sqrt(Math.max(0, (0.88 * Lfall) ** 2 - sd * sd)), 2.1 * sd);
          if (hc >= 1.6) { lodged = { n, hc, bx, bz }; break; }
        }
        if (h.trunk) { // glance off: turn so the trunk passes just beside the falling stem
          const sg = h.e === 0 ? (r() < 0.5 ? 1 : -1) : Math.sign(h.e), dist = Math.hypot(h.s, h.e);
          a = Math.atan2(n.z - bz, n.x - bx) - Math.asin(clamp((sg * (h.rA + h.rn + 0.08)) / dist, -1, 1));
          stats.glanced++; turned = true; break;
        }
      }
      if (!turned) break;
    }

    const pieces = [];
    const dx = Math.cos(a), dz = Math.sin(a), bx = t.x + dx * off, bz = t.z + dz * off;
    if (lodged) {
      // hung up: butt on the ground (or its root plate), stem resting on the holder at the contact height
      const { n, hc } = lodged, f = n.form || { lx: 0, lz: 0, sx: 0, sz: 0 };
      const ux = (n.x - bx) / Math.hypot(n.x - bx, n.z - bz), uz = (n.z - bz) / Math.hypot(n.x - bx, n.z - bz);
      const lean = n.h * clamp(0.015 + 0.05 * (t.d / n.d) ** 2, 0.015, 0.08);
      n.lean = [(n.lean?.[0] || 0) + ux * lean, (n.lean?.[1] || 0) + uz * lean]; stats.leaned++;
      const q = hc / Math.max(n.h, 1), sw = 1 - Math.exp(-hc / 1.8);
      const cx = n.x + (f.lx + n.lean[0]) * q + f.sx * sw, cz = n.z + (f.lz + n.lean[1]) * q + f.sz * sw;
      const clear = (n.d / 200) * 0.95 + sxL * 0.42, px = cx - ux * clear, pz = cz - uz * clear, py = support(n.x, n.z) + hc;
      const y0 = support(bx, bz) + rr + raised, vx = px - bx, vy = py - y0, vz = pz - bz, vl = Math.hypot(vx, vy, vz);
      pieces.push({ x0: bx, y0, z0: bz, x1: bx + vx / vl * Lnow, y1: y0 + vy / vl * Lnow, z1: bz + vz / vl * Lnow, u0: 0, u1: 1 });
      t.holder = n; stats.lodged++;
    } else {
      // 2. rest the whole stem, 3. slide it, 4. break it
      const prof = (u0, u1) => (u) => trunkProfile(lerpD(u0, u1, u));
      const sec = { x: bx, z: bz, dx, dz, len: Lnow, rx: (u) => sxL * prof(0, 1)(u), rz: (u) => szL * prof(0, 1)(u), anchor: plate, lift: raised ? rr + raised : 0 };
      const mv = slide(sec, fd < 0.3 ? MU_FRESH : MU_ROTTEN, yr, t, plate);
      if (mv > 0) { stats.slid++; stats.slidM += mv; t.slid = mv; }
      let whole = rest(sec);
      const cuts = [];
      if (fd > 0.2 && Lnow > 2 * MIN_PIECE) {
        // clearance under the stem: where it hangs, it breaks first
        const m = Math.ceil(Lnow / 0.5), cl = [];
        for (let i = 1; i < m; i++) {
          const u = i / m, x = lerpD(whole.x0, whole.x1, u), z = lerpD(whole.z0, whole.z1, u);
          cl.push([u, lerpD(whole.y0, whole.y1, u) - szL * trunkProfile(u) - S(x, z)]);
        }
        let nb = Math.floor(((fd - 0.3) / 0.7) * (Lnow / 5) + r());
        const span = cl.reduce((p, c) => (c[1] > p[1] ? c : p), [0.5, -1]);
        if (span[1] > 0.35) nb = Math.max(nb, 1);
        for (let k = 0, tries = 0; k < nb && tries < 40; tries++) {
          let tot = 0; for (const c of cl) tot += 0.25 + Math.max(0, c[1]) * 4;
          let pick = r() * tot, u = 0.5; for (const c of cl) { pick -= 0.25 + Math.max(0, c[1]) * 4; if (pick <= 0) { u = c[0]; break; } }
          if (k === 0 && span[1] > 0.35) u = span[0];
          if (u * Lnow < MIN_PIECE || (1 - u) * Lnow < MIN_PIECE || cuts.some((c) => Math.abs(c - u) * Lnow < MIN_PIECE)) continue;
          cuts.push(u); k++;
        }
      }
      cuts.sort((p, q) => p - q);
      if (!cuts.length) pieces.push({ ...whole, u0: 0, u1: 1 });
      else {
        stats.broken++;
        const bounds = [0, ...cuts, 1], jit = 0.12 * fd;
        for (let k = 0; k < bounds.length - 1; k++) {
          const u0 = bounds[k], u1 = bounds[k + 1], gap = 0.06 + 0.1 * r();
          const ua = u0 + (k ? gap / 2 / Lnow : 0), ub = u1 - (k < bounds.length - 2 ? gap / 2 / Lnow : 0);
          const cxm = lerpD(whole.x0, whole.x1, (ua + ub) / 2), czm = lerpD(whole.z0, whole.z1, (ua + ub) / 2);
          const aa = Math.atan2(whole.z1 - whole.z0, whole.x1 - whole.x0) + (k === 0 && plate ? 0 : (r() - 0.5) * 2 * jit);
          const pdx = Math.cos(aa), pdz = Math.sin(aa), plen = Lnow * (ub - ua);
          const butt = k === 0;
          const ps = {
            x: butt ? whole.x0 : cxm - pdx * plen / 2, z: butt ? whole.z0 : czm - pdz * plen / 2, dx: pdx, dz: pdz, len: plen,
            rx: (u) => sxL * trunkProfile(lerpD(ua, ub, u)), rz: (u) => szL * trunkProfile(lerpD(ua, ub, u)), anchor: butt && plate, lift: butt && raised ? rr + raised : 0,
          };
          rest(ps);
          const mv2 = slide(ps, MU_ROTTEN, yr, t, butt && plate);
          if (mv2 > 0) { stats.slid++; stats.slidM += mv2; t.slid = (t.slid || 0) + mv2; }
          pieces.push({ ...rest(ps), u0: ua, u1: ub });
        }
      }
      for (const p of pieces) { p.y0 -= sink; p.y1 -= sink; }
    }
    for (const p of pieces) {
      p.rx0 = sxL * trunkProfile(p.u0); p.rx1 = sxL * trunkProfile(p.u1); p.rz0 = szL * trunkProfile(p.u0); p.rz1 = szL * trunkProfile(p.u1);
      p.r = Math.max(p.rx0, p.rx1); p.t = t; p.yr = yr; addPiece(p);
    }
    stats.pieces += pieces.length;
    t.rest = { a, pieces, sx: sxL, sz: szL, L: Lnow, fd };
  }

  // 5. no stem stands inside a log: later growth sits beside it, earlier small stems were crushed under it
  const holders = new Set(logs.map((t) => t.holder).filter(Boolean));
  let work = trees;
  for (let pass = 0; pass < 9; pass++) {
    const last = pass === 8; // a stem still wedged between logs after that many nudges never made it
    const next = new Set();
    for (const n of work) {
      if ((n.st !== 0 && n.st !== 1) || n.crushed) continue;
      const k0 = Math.floor((n.x + HALF) / PG), k1 = Math.floor((n.z + HALF) / PG), rn = n.d / 200, seen = new Set();
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const a = pgrid.get(gk(k0 + di, k1 + dj)); if (!a) continue;
        for (const p of a) {
          if (seen.has(p) || n.crushed) continue; seen.add(p);
          if (p.t.holder === n || Math.hypot(n.x - p.t.x, n.z - p.t.z) < 0.1) continue; // its holder, or its own stump
          const vx = p.x1 - p.x0, vz = p.z1 - p.z0, L2 = vx * vx + vz * vz || 1, u = clamp(((n.x - p.x0) * vx + (n.z - p.z0) * vz) / L2, 0, 1);
          const qx = p.x0 + vx * u, qz = p.z0 + vz * u, d = Math.hypot(n.x - qx, n.z - qz), rp = lerpD(p.rx0, p.rx1, u);
          if (d >= rn + rp + 0.03) continue;
          if (lerpD(p.y0, p.y1, u) - lerpD(p.rz0, p.rz1, u) > support(n.x, n.z) + (n.st === 1 ? n.sh : n.h)) continue; // passes overhead
          if ((last && !holders.has(n)) || (n.d < 6 && n.bornAt <= p.yr && n.st === 0)) { n.crushed = true; stats.crushed++; continue; }
          let ox = n.x - qx, oz = n.z - qz, ol = Math.hypot(ox, oz);
          if (ol < 1e-3) { ox = -vz; oz = vx; ol = Math.hypot(ox, oz) || 1; }
          if (u <= 0 || u >= 1) { ol = ol || 1; } // past an end: push straight away from it
          const push = rn + rp + 0.06 - d;
          if (holders.has(n) && !p.t.holder) { // a holder keeps its place (a stem rests on it): the log lies beside it instead
            const ddx = p.x1 - p.x0, ddz = p.z1 - p.z0, hl = Math.hypot(ddx, ddz) || 1, len = Math.hypot(ddx, p.y1 - p.y0, ddz), R = p.t.rest;
            const sec = { x: p.x0 - (ox / ol) * push, z: p.z0 - (oz / ol) * push, dx: ddx / hl, dz: ddz / hl, len,
              rx: (q) => R.sx * trunkProfile(lerpD(p.u0, p.u1, q)), rz: (q) => R.sz * trunkProfile(lerpD(p.u0, p.u1, q)), anchor: true };
            const sink = (p.t.d / 200) * (1 - 0.15 * R.fd) * (0.1 + 0.9 * R.fd), q = rest(sec);
            Object.assign(p, { x0: q.x0, y0: q.y0 - sink, z0: q.z0, x1: q.x1, y1: q.y1 - sink, z1: q.z1 });
            stemsNear(p.x0, p.z0, p.x1, p.z1, 2, (m) => next.add(m)); next.add(n);
          } else { n.x += (ox / ol) * push; n.z += (oz / ol) * push; next.add(n); }
          stats.nudged++;
        }
      }
    }
    if (!next.size) break;
    work = next;
  }
  return stats;
}

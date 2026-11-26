// Modal plants: every branch of a plant is a cantilever beam with one bending mode, a damped oscillator with an exact
// update (it cannot blow up, and it cannot gain energy on its own). A branch is a chain of segments of one branching
// order; its children ride on it (carried by its turn) and pull on it (a deflected child's spring force loads its
// parent), so pushing a twig shakes the bough it grows from. The pose is a rotation of each segment: the slope of the
// beam's deflection curve where the segment sits, so large bends turn segments rather than stretch them.
//
// Deflection shape (a cantilever under a tip load, normalised to 1 at the tip, s = arc position / length):
//   φ(s) = s²(3 − s)/2,  slope φ'(s)/L with φ'(s) = 3s(2 − s)/2.
// Tip stiffness k = 3EI/L³; effective mass m = Σ (segment and carried mass) · φ(s)²; ω = √(k/m).
// A point force F at s acts on the mode as F·φ(s); the stiffness felt at s is k/φ(s)².
export const phi = (s) => s * s * (3 - s) / 2, dphi = (s) => 1.5 * s * (2 - s);

export function parentsFirst(P) {
  if (P._pf) return P._pf;
  const kids = Array.from({ length: P.n }, () => []); for (let i = 0; i < P.n; i++) if (P.par[i] >= 0) kids[P.par[i]].push(i);
  const out = [], st = []; for (let i = 0; i < P.n; i++) if (!(P.par[i] >= 0)) st.push(i);
  while (st.length) { const i = st.pop(); out.push(i); for (const c of kids[i]) st.push(c); }
  return (P._pf = Int32Array.from(out));
}

// P: graph { n, par, ord }; ws: world segments [ax,ay,az,bx,by,bz,r] per node; o: { valid(i), fixed(i), E (Pa), MOR (Pa),
// rho, dry(i), leafy (extra mass on end branches, as a fraction), zeta }
export function build(P, ws, o) {
  const n = P.n, order = parentsFirst(P), nodeB = new Int32Array(n).fill(-1), cont = new Int32Array(n).fill(-1), br = [];
  const live = (i) => i >= 0 && i < n && o.valid(i) && !o.fixed(i) && ws[i * 7 + 6] > 0;
  for (const i of order) {
    if (!live(i)) continue;
    const p = P.par[i];
    if (live(p) && P.ord[p] === P.ord[i] && cont[p] < 0 && nodeB[p] >= 0) { cont[p] = i; nodeB[i] = nodeB[p]; br[nodeB[p]].nodes.push(i); }
    else { nodeB[i] = br.length; br.push({ nodes: [i], att: live(p) ? p : -1 }); }
  }
  const nb = br.length, s0 = new Float32Array(n), s1 = new Float32Array(n);
  const M = { n, nb, nodeB, s0, s1, att: new Int32Array(nb), first: new Int32Array(nb), last: new Int32Array(nb), L: new Float32Array(nb), k: new Float32Array(nb), m: new Float32Array(nb),
    mOwn: new Float32Array(nb), mTot: new Float32Array(nb), mG: new Float32Array(nb), w: new Float32Array(nb), z: new Float32Array(nb), rB: new Float32Array(nb), lim: new Float32Array(nb), dry: new Uint8Array(nb),
    d0: new Float32Array(nb * 3), u: new Float32Array(nb * 3), v: new Float32Array(nb * 3), Q: new Float32Array(nb * 3), hinge: new Uint8Array(nb), mom: new Float32Array(nb), rho: new Float32Array(n * 3), rhoT: new Uint8Array(n), rhoOn: 0, lq: new Float32Array(n * 4), gone: new Uint8Array(nb), awake: new Uint8Array(nb), quiet: new Float32Array(nb), touched: new Uint8Array(nb), kids: [] };
  const rho = o.rho ?? 800;
  br.forEach((B, b) => {
    const f = B.nodes[0], l = B.nodes[B.nodes.length - 1]; M.first[b] = f; M.last[b] = l; M.att[b] = B.att;
    let L = 0; const len = B.nodes.map((i) => { const k = i * 7, d = Math.hypot(ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2]); L += d; return d; }); L = Math.max(L, 1e-3);
    let acc = 0; B.nodes.forEach((i, j) => { s0[i] = acc / L; acc += len[j]; s1[i] = acc / L; });
    const dx = ws[l * 7 + 3] - ws[f * 7], dy = ws[l * 7 + 4] - ws[f * 7 + 1], dz = ws[l * 7 + 5] - ws[f * 7 + 2], dl = Math.hypot(dx, dy, dz) || 1;
    M.d0.set([dx / dl, dy / dl, dz / dl], b * 3);
    const rb = Math.max(0.001, ws[f * 7 + 6]), rt = Math.max(0.0007, ws[l * 7 + 6]), re = (2 * rb + rt) / 3, dry = o.dry(f);
    const E = o.E * (dry ? 1.25 : 1), I = Math.PI * re ** 4 / 4;
    M.L[b] = L; M.rB[b] = rb; M.dry[b] = dry ? 1 : 0; M.k[b] = 3 * E * I / L ** 3;
    M.lim[b] = o.MOR * (dry ? 1.3 : (o.give ?? 2.5) * Math.min(4, Math.max(1, 0.01 / rb))) * Math.PI * rb ** 3 / 4; // (thin green stems bend into far tighter curves before they fail: up to 4x more below 1 cm radius [rough]) // the bending moment its base can carry: dry wood is stronger but snaps at it; green wood
    // bends on to about 2.5x the strain of its proportional limit before it fails (soft stems far further: give) [rough, as the rods had it]
    let m = 0, mo = 0, mg = 0; B.nodes.forEach((i, j) => { const r = Math.max(0.0007, ws[i * 7 + 6]), mi = rho * Math.PI * r * r * len[j], sm = (s0[i] + s1[i]) / 2; mo += mi; m += mi * phi(sm) ** 2; mg += mi * phi(sm); });
    M.mOwn[b] = mo; M.m[b] = m; M.mG[b] = mg; M.z[b] = o.zeta ?? 0.1;
  });
  for (let b = 0; b < nb; b++) M.kids.push([]);
  for (let b = 0; b < nb; b++) { const a = M.att[b]; if (a >= 0) M.kids[nodeB[a]].push(b); }
  for (let b = nb - 1; b >= 0; b--) { M.mTot[b] += M.mOwn[b]; const a = M.att[b]; if (a >= 0) M.mTot[nodeB[a]] += M.mTot[b]; } // (children come after parents)
  for (let b = 0; b < nb; b++) {
    if (!M.kids[b].length) { M.m[b] *= 1 + (o.leafy ?? 0); M.mG[b] *= 1 + (o.leafy ?? 0); } // leaves and needles on the twigs
    for (const c of M.kids[b]) { const sa = s1[M.att[c]]; M.m[b] += M.mTot[c] * phi(sa) ** 2; M.mG[b] += M.mTot[c] * phi(sa); }
    M.w[b] = Math.min(2 * Math.PI * 8, Math.max(2 * Math.PI * 0.35, Math.sqrt(M.k[b] / Math.max(1e-6, M.m[b]))));
  }
  return M;
}

const _t = [0, 0, 0];
function qrot(q, j, x, y, z, out) { const qx = q[j], qy = q[j + 1], qz = q[j + 2], qw = q[j + 3], tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x); out[0] = x + qw * tx + qy * tz - qz * ty; out[1] = y + qw * ty + qz * tx - qx * tz; out[2] = z + qw * tz + qx * ty - qy * tx; return out; }
function qinv(q, j, x, y, z, out) { const qx = -q[j], qy = -q[j + 1], qz = -q[j + 2], qw = q[j + 3], tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x); out[0] = x + qw * tx + qy * tz - qz * ty; out[1] = y + qw * ty + qz * tx - qx * tz; out[2] = z + qw * tz + qx * ty - qy * tx; return out; }

// one step of every branch that moves: children's pull on their parents first (as generalized forces), then the exact damped
// update about the equilibrium those forces set. Returns the number of branches awake.
export function step(M, dt) {
  const { nb, u, v, Q, k, m, w, z, d0 } = M;
  for (let b = nb - 1; b >= 0; b--) { // a deflected child pulls its parent where it grows (k·u at its base), deepest first
    if (M.gone[b]) continue; const a = M.att[b]; if (a < 0) continue; const pb = M.nodeB[a]; if (pb < 0) continue;
    const ku = M.hinge[b] ? 0.01 : 1, f = phi(M.s1[a]) * k[b] * ku, o = b * 3, ux = u[o] * f, uy = u[o + 1] * f, uz = u[o + 2] * f;
    if (ux * ux + uy * uy + uz * uz < 1e-12) continue;
    Q[pb * 3] += ux; Q[pb * 3 + 1] += uy; Q[pb * 3 + 2] += uz;
  }
  if (M.rhoOn) { // local bends spring back (overdamped: the branch's own mode carries the ringing)
    const f = Math.exp(-dt / 0.3); let on = 0;
    for (let i = 0; i < M.n; i++) { const o = i * 3; if (!M.rho[o] && !M.rho[o + 1] && !M.rho[o + 2]) continue; if (!M.rhoT[i]) { M.rho[o] *= f; M.rho[o + 1] *= f; M.rho[o + 2] *= f; if (Math.abs(M.rho[o]) + Math.abs(M.rho[o + 1]) + Math.abs(M.rho[o + 2]) < 1e-3) M.rho[o] = M.rho[o + 1] = M.rho[o + 2] = 0; } M.rhoT[i] = 0; on++; }
    M.rhoOn = on;
  }
  let awake = M.rhoOn ? 1 : 0;
  for (let b = 0; b < nb; b++) {
    const o = b * 3;
    if (M.gone[b]) { Q[o] = Q[o + 1] = Q[o + 2] = 0; continue; }
    if (M.hinge[b]) M.Q[o + 1] -= 9.81 * M.mG[b]; // a branch that gave way hangs under its own weight
    const kk = k[b] * (M.hinge[b] ? 0.01 : 1), ww = w[b] * (M.hinge[b] ? 0.1 : 1), zz = M.hinge[b] ? 0.35 : z[b], dx = d0[o], dy = d0[o + 1], dz = d0[o + 2];
    let qx = Q[o], qy = Q[o + 1], qz = Q[o + 2]; const qa = qx * dx + qy * dy + qz * dz; qx -= qa * dx; qy -= qa * dy; qz -= qa * dz; // only across the branch
    const ex = qx / kk, ey = qy / kk, ez = qz / kk; // the deflection those forces hold it at (a hanging child's weight, a push)
    if (!M.awake[b]) { if (Math.abs(u[o] - ex) + Math.abs(u[o + 1] - ey) + Math.abs(u[o + 2] - ez) > 2e-4) { M.awake[b] = 1; M.quiet[b] = 0; } else { Q[o] = Q[o + 1] = Q[o + 2] = 0; continue; } } // asleep unless its load moved
    awake++;
    const wd = ww * Math.sqrt(1 - zz * zz), e = Math.exp(-zz * ww * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt), A = c + zz * ww / wd * s, Bv = s / wd, C = -ww * ww / wd * s, D = c - zz * ww / wd * s;
    let en = 0;
    for (let d = 0; d < 3; d++) { const x = u[o + d] - [ex, ey, ez][d], vv = v[o + d]; u[o + d] = e * (A * x + Bv * vv) + [ex, ey, ez][d]; v[o + d] = e * (C * x + D * vv); }
    if (M.hinge[b]) { const ul = Math.hypot(u[o], u[o + 1], u[o + 2]), um = 1.5 * M.L[b]; if (ul > um) { const f = um / ul; for (let d = 0; d < 3; d++) { u[o + d] *= f; v[o + d] *= f; } } } // (hanging: as far as it can fold, no further)
    const ua = u[o] * dx + u[o + 1] * dy + u[o + 2] * dz, va = v[o] * dx + v[o + 1] * dy + v[o + 2] * dz; for (let d = 0; d < 3; d++) { u[o + d] -= ua * d0[o + d]; v[o + d] -= va * d0[o + d]; }
    for (let d = 0; d < 3; d++) { const x = u[o + d] - [ex, ey, ez][d]; en += 0.5 * m[b] * v[o + d] ** 2 + 0.5 * kk * x * x; }
    Q[o] = Q[o + 1] = Q[o + 2] = 0;
    M.quiet[b] = en < 1e-6 && !M.touched[b] ? M.quiet[b] + dt : 0;
    if (M.quiet[b] > 0.5) { M.awake[b] = 0; for (let d = 0; d < 3; d++) v[o + d] = 0; } // still for half a second: asleep where it is (at rest, or held by its load)
    M.touched[b] = 0;
  }
  return awake;
}

// the pose: per node the turn q and where its base is drawn (a2); D: end displacement (xyz) and flag (w: 1 moved, 2 gone)
export function pose(M, P, ws, X, gone) {
  const n = Math.min(P.n, M.n), A2 = X.a2, Q = X.q, D = X.D, ax = [0, 0, 0];
  for (const i of parentsFirst(P)) {
    if (i >= n) continue;
    const k = i * 7, p = P.par[i], b = M.nodeB[i];
    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (p >= 0 && p < n) { qx = Q[p * 4]; qy = Q[p * 4 + 1]; qz = Q[p * 4 + 2]; qw = Q[p * 4 + 3]; qrot(Q, p * 4, ws[k] - ws[p * 7], ws[k + 1] - ws[p * 7 + 1], ws[k + 2] - ws[p * 7 + 2], _t); A2[i * 3] = A2[p * 3] + _t[0]; A2[i * 3 + 1] = A2[p * 3 + 1] + _t[1]; A2[i * 3 + 2] = A2[p * 3 + 2] + _t[2]; }
    else { A2[i * 3] = ws[k]; A2[i * 3 + 1] = ws[k + 1]; A2[i * 3 + 2] = ws[k + 2]; }
    let lx = 0, ly = 0, lz = 0, lw = 1; // the local bends of this branch up to here (each segment's own, carried along the branch)
    if (b >= 0 && !M.gone[b]) { const pp = P.par[i], LQ = M.lq; if (pp >= 0 && pp < n && M.nodeB[pp] === b) { lx = LQ[pp * 4]; ly = LQ[pp * 4 + 1]; lz = LQ[pp * 4 + 2]; lw = LQ[pp * 4 + 3]; }
      const ro = i * 3, rx = M.rho[ro], ry = M.rho[ro + 1], rz = M.rho[ro + 2], ra = Math.hypot(rx, ry, rz);
      if (ra > 1e-6) { const sh = Math.sin(ra / 2) / ra, ax2 = rx * sh, ay2 = ry * sh, az2 = rz * sh, aw2 = Math.cos(ra / 2); const nx2 = lw * ax2 + lx * aw2 + ly * az2 - lz * ay2, ny2 = lw * ay2 - lx * az2 + ly * aw2 + lz * ax2, nz2 = lw * az2 + lx * ay2 - ly * ax2 + lz * aw2, nw2 = lw * aw2 - lx * ax2 - ly * ay2 - lz * az2; lx = nx2; ly = ny2; lz = nz2; lw = nw2; }
      LQ[i * 4] = lx; LQ[i * 4 + 1] = ly; LQ[i * 4 + 2] = lz; LQ[i * 4 + 3] = lw; }
    if (b >= 0 && !M.gone[b]) { // its own bend: the slope of the branch's deflection where it sits, turned with whatever carries the branch
      const o = b * 3, ux = M.u[o], uy = M.u[o + 1], uz = M.u[o + 2], ul = Math.hypot(ux, uy, uz);
      if (ul > 1e-7) {
        const a = M.att[b]; let bx = 0, by = 0, bz = 0, bw = 1; if (a >= 0) { bx = Q[a * 4]; by = Q[a * 4 + 1]; bz = Q[a * 4 + 2]; bw = Q[a * 4 + 3]; }
        const th = Math.min(1.5, ul / M.L[b] * dphi((M.s0[i] + M.s1[i]) / 2)), dx = M.d0[o], dy = M.d0[o + 1], dz = M.d0[o + 2];
        ax[0] = dy * uz - dz * uy; ax[1] = dz * ux - dx * uz; ax[2] = dx * uy - dy * ux; const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
        const sh = Math.sin(th / 2) / al; let rx = ax[0] * sh, ry = ax[1] * sh, rz = ax[2] * sh, rw = Math.cos(th / 2); // the bend, in rest axes
        { const tx = lw * rx + lx * rw + ly * rz - lz * ry, ty = lw * ry - lx * rz + ly * rw + lz * rx, tz = lw * rz + lx * ry - ly * rx + lz * rw, tw = lw * rw - lx * rx - ly * ry - lz * rz; rx = tx; ry = ty; rz = tz; rw = tw; } // after the local bends
        qx = bw * rx + bx * rw + by * rz - bz * ry; qy = bw * ry - bx * rz + by * rw + bz * rx; qz = bw * rz + bx * ry - by * rx + bz * rw; qw = bw * rw - bx * rx - by * ry - bz * rz; // carried: q_att · local · r
      } else { let bx = 0, by = 0, bz = 0, bw = 1; if (M.att[b] >= 0) { const a = M.att[b]; bx = Q[a * 4]; by = Q[a * 4 + 1]; bz = Q[a * 4 + 2]; bw = Q[a * 4 + 3]; }
        qx = bw * lx + bx * lw + by * lz - bz * ly; qy = bw * ly - bx * lz + by * lw + bz * lx; qz = bw * lz + bx * ly - by * lx + bz * lw; qw = bw * lw - bx * lx - by * ly - bz * lz; }
    }
    Q[i * 4] = qx; Q[i * 4 + 1] = qy; Q[i * 4 + 2] = qz; Q[i * 4 + 3] = qw;
    qrot(Q, i * 4, ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2], _t);
    D[i * 4] = A2[i * 3] + _t[0] - ws[k + 3]; D[i * 4 + 1] = A2[i * 3 + 1] + _t[1] - ws[k + 4]; D[i * 4 + 2] = A2[i * 3 + 2] + _t[2] - ws[k + 5];
    D[i * 4 + 3] = gone && gone[i] ? 2 : (Math.abs(D[i * 4]) + Math.abs(D[i * 4 + 1]) + Math.abs(D[i * 4 + 2]) > 1e-5 ? 1 : 0);
  }
}

// closest points of segments p0-p1 and q0-q1: returns [distance, s on p, t on q]
function segSeg(p0x, p0y, p0z, p1x, p1y, p1z, q0x, q0y, q0z, q1x, q1y, q1z) {
  const d1x = p1x - p0x, d1y = p1y - p0y, d1z = p1z - p0z, d2x = q1x - q0x, d2y = q1y - q0y, d2z = q1z - q0z, rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a < 1e-12 && e < 1e-12) { s = t = 0; } else if (a < 1e-12) { t = Math.min(1, Math.max(0, f / e)); } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e < 1e-12) s = Math.min(1, Math.max(0, -c / a)); else { const bb = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - bb * bb; s = den > 1e-12 ? Math.min(1, Math.max(0, (bb * f - c * e) / den)) : 0; t = (bb * s + f) / e; if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (bb - c) / a)); } }
  }
  const dx = p0x + d1x * s - q0x - d2x * t, dy = p0y + d1y * s - q0y - d2y * t, dz = p0z + d1z * s - q0z - d2z * t;
  return [Math.hypot(dx, dy, dz), s, t, dx, dy, dz];
}

// Capsules pushing on the branches (the body, or anything else): a branch overlapped by a capsule is moved out of it, as far as
// a push of at most Fm can bend it (the stiffness felt at that point is k/φ²); whatever overlap is left is the capsule's to
// take (outD: per capsule xyz, and its length in w). The force on each capsule (outF xyz) and the hardest contact point
// (outP: point, normal, force) are what the body feels. capV: each capsule's velocity (it carries the branch at that pace).
export function contact(M, P, ws, X, caps, capV, Fm, outF, outP, outD, box, budget) { // budget: { left } newtons shared by every contact this pass (a body pushes with so much in all)
  const n = Math.min(P.n, M.n), A2 = X.a2, Q = X.q;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const b = M.nodeB[i]; if (b < 0 || M.gone[b]) continue;
    const k = i * 7, r = ws[k + 6]; qrot(Q, i * 4, ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2], _t);
    const ax = A2[i * 3], ay = A2[i * 3 + 1], az = A2[i * 3 + 2], bx = ax + _t[0], by = ay + _t[1], bz = az + _t[2];
    if (Math.max(ax, bx) + r < box[0] || Math.min(ax, bx) - r > box[1] || Math.max(ay, by) + r < box[2] || Math.min(ay, by) - r > box[3] || Math.max(az, bz) + r < box[4] || Math.min(az, bz) - r > box[5]) continue;
    for (let c = 0; c < caps.length; c += 7) {
      const R = caps[c + 6], h = segSeg(ax, ay, az, bx, by, bz, caps[c], caps[c + 1], caps[c + 2], caps[c + 3], caps[c + 4], caps[c + 5]), pen = R + r - h[0];
      if (pen <= 0) continue;
      const dl = h[0] || 1e-6, nx = h[0] > 1e-6 ? h[3] / dl : 0, ny = h[0] > 1e-6 ? h[4] / dl : 1, nz = h[0] > 1e-6 ? h[5] / dl : 0; // push direction on the branch
      // the point gives way through every branch from here to the anchor, springs in series: compliance φ(s)²/k for this branch at
      // the contact and for each ancestor where its child grows. The push is shared by compliance; the force is displacement over the
      // summed compliance, at most Fm (beyond that the capsule yields). Each branch's base feels the force times its arm.
      const ch = M._ch || (M._ch = []); ch.length = 0; let C = 0;
      for (let bb = b, ss = M.s0[i] + (M.s1[i] - M.s0[i]) * h[1], d = 0; bb >= 0 && d < 8; d++) {
        if (M.gone[bb]) break; const kk = M.k[bb] * (M.hinge[bb] ? 0.01 : 1), sq = Math.max(0.02, ss), c2 = phi(sq) ** 2 / kk; ch.push(bb, sq, c2); C += c2;
        const a = M.att[bb]; if (a < 0) break; ss = M.s1[a]; bb = M.nodeB[a];
      }
      if (!(C > 0)) continue;
      let xNow = 0; // how far this point is already held out along the push, by all of them
      for (let q = 0; q < ch.length; q += 3) { const bb = ch[q], o = bb * 3, at = M.att[bb]; if (at >= 0) qinv(Q, at * 4, nx, ny, nz, _t); else { _t[0] = nx; _t[1] = ny; _t[2] = nz; } xNow += phi(ch[q + 1]) * Math.max(0, M.u[o] * _t[0] + M.u[o + 1] * _t[1] + M.u[o + 2] * _t[2]); }
      const Fc = budget ? Math.min(Fm, Math.max(30, budget.left)) : Fm, xNew = Math.min(xNow + pen, Math.max(xNow, Fc * C)), dX = xNew - xNow, F = Math.min(Fc, xNew / C), ci = c / 7; if (budget) budget.left -= F;
      let done = 0;
      for (let pass = 0, Cp = C, want = dX; pass < 2 && want > 1e-5 && Cp > 0; pass++) { // a branch at its limit passes its share on to the rest
        let Cn = 0, got = 0;
        for (let q = 0; q < ch.length; q += 3) {
          const bb = ch[q], sq = ch[q + 1], o = bb * 3, at = M.att[bb], ph = phi(sq); if (ch[q + 2] <= 0) continue; if (at >= 0) qinv(Q, at * 4, nx, ny, nz, _t); else { _t[0] = nx; _t[1] = ny; _t[2] = nz; }
          const dx = M.d0[o], dy = M.d0[o + 1], dz = M.d0[o + 2], al = _t[0] * dx + _t[1] * dy + _t[2] * dz; let ex = _t[0] - al * dx, ey = _t[1] - al * dy, ez = _t[2] - al * dz; const el = Math.hypot(ex, ey, ez); if (el < 1e-6) continue; ex /= el; ey /= el; ez /= el;
          const du = want * ch[q + 2] / Cp / ph, ub = M.u[o] * ex + M.u[o + 1] * ey + M.u[o + 2] * ez; M.u[o] += ex * du; M.u[o + 1] += ey * du; M.u[o + 2] += ez * du;
          const um = M.L[bb] * (M.hinge[bb] ? 1.5 : 1), ul = Math.hypot(M.u[o], M.u[o + 1], M.u[o + 2]); let capped = false; if (ul > um) { const f = um / ul; M.u[o] *= f; M.u[o + 1] *= f; M.u[o + 2] *= f; capped = true; }
          const moved = ph * Math.max(0, M.u[o] * ex + M.u[o + 1] * ey + M.u[o + 2] * ez - ub); got += moved; // what it actually moved (a branch at its limit moves no further)
          if (capped) ch[q + 2] = -ch[q + 2]; else Cn += ch[q + 2];
          M.awake[bb] = 1; M.touched[bb] = 1; M.quiet[bb] = 0; M.mom[bb] = Math.max(M.mom[bb], F * sq * M.L[bb]);
          if (capV && pass === 0) { const cv = (capV[ci * 3] * -nx + capV[ci * 3 + 1] * -ny + capV[ci * 3 + 2] * -nz) * ch[q + 2] / Cp / ph, vn = M.v[o] * ex + M.v[o + 1] * ey + M.v[o + 2] * ez; if (cv > vn) { M.v[o] += (cv - vn) * ex; M.v[o + 1] += (cv - vn) * ey; M.v[o + 2] += (cv - vn) * ez; } } // it moves at the capsule's pace (no faster)
        }
        done += got; want -= got; Cp = Cn;
      }
      if (outF) { outF[ci * 3] -= nx * F; outF[ci * 3 + 1] -= ny * F; outF[ci * 3 + 2] -= nz * F; }
      if (outP && F >= outP[ci * 7 + 6]) { outP.set([caps[c] + (caps[c + 3] - caps[c]) * h[2] + nx * R, caps[c + 1] + (caps[c + 4] - caps[c + 1]) * h[2] + ny * R, caps[c + 2] + (caps[c + 5] - caps[c + 2]) * h[2] + nz * R, -nx, -ny, -nz, F], ci * 7); }
      let loc = 0; const short = pen - Math.min(dX, done);
      if (short > 2e-3 && dX > 0) { // what one bend of the whole branch could not clear: this segment bends at its own base (a thin branch wraps round you)
        const seg = Math.hypot(ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2]), arm = Math.max(0.04, h[1] * seg), at = M.att[b];
        qinv(Q, i * 4, nx, ny, nz, _t); const n0 = _t[0], n1 = _t[1], n2 = _t[2]; // the push in this segment's own (current) frame
        const sx = (ws[k + 3] - ws[k]) / (seg || 1), sy = (ws[k + 4] - ws[k + 1]) / (seg || 1), sz = (ws[k + 5] - ws[k + 2]) / (seg || 1);
        let axx = sy * n2 - sz * n1, axy = sz * n0 - sx * n2, axz = sx * n1 - sy * n0; const axl = Math.hypot(axx, axy, axz);
        if (axl > 1e-4) { const ang = Math.min(0.6, short / arm); axx /= axl; axy /= axl; axz /= axl;
          // into the branch's rest axes (where rho lives): the segment's current turn relative to the branch's carrier, approximately the local frame
          let cx = axx * ang, cy = axy * ang, cz = axz * ang; if (at >= 0) { qrot(Q, i * 4, cx, cy, cz, _t); qinv(Q, at * 4, _t[0], _t[1], _t[2], _t); cx = _t[0]; cy = _t[1]; cz = _t[2]; }
          const ro = i * 3; M.rho[ro] += cx; M.rho[ro + 1] += cy; M.rho[ro + 2] += cz; const ra = Math.hypot(M.rho[ro], M.rho[ro + 1], M.rho[ro + 2]); if (ra > 1.2) { M.rho[ro] *= 1.2 / ra; M.rho[ro + 1] *= 1.2 / ra; M.rho[ro + 2] *= 1.2 / ra; }
          M.rhoT[i] = 1; M.rhoOn = Math.max(M.rhoOn, 1); loc = Math.min(short, ang * arm); }
      }
      const left = pen - Math.min(dX, done) - loc; if (outD && left > 1e-5) { outD[ci * 4] -= nx * left; outD[ci * 4 + 1] -= ny * left; outD[ci * 4 + 2] -= nz * left; outD[ci * 4 + 3] = Math.hypot(outD[ci * 4], outD[ci * 4 + 1], outD[ci * 4 + 2]); }
      hits++;
    }
  }
  return hits;
}

// a point force F (world) at node i, over dt: a generalized force on its branch
export function force(M, X, i, F) {
  const b = M.nodeB[i]; if (b < 0 || M.gone[b]) return;
  const at = M.att[b]; if (at >= 0) qinv(X.q, at * 4, F[0], F[1], F[2], _t); else { _t[0] = F[0]; _t[1] = F[1]; _t[2] = F[2]; }
  const f = phi(M.s1[i]), o = b * 3; M.Q[o] += _t[0] * f; M.Q[o + 1] += _t[1] * f; M.Q[o + 2] += _t[2] * f; M.awake[b] = 1; M.quiet[b] = 0;
}

// which branches the load now breaks: the moment at the base (tip-equivalent force k·u times the length) against what the wood
// carries. Returns [{ b, node: first node, clean }]: clean when small and dry (it snaps off); otherwise it gives way and hangs.
export function breaks(M, breakR) {
  const out = [];
  for (let b = 0; b < M.nb; b++) {
    const mc = M.mom[b]; M.mom[b] = 0;
    if (M.gone[b] || M.hinge[b] || !M.awake[b]) continue;
    const o = b * 3, Mb = Math.max(mc, M.k[b] * Math.hypot(M.u[o], M.u[o + 1], M.u[o + 2]) * M.L[b]); // a contact's own moment (force times its arm), or the tip load the bend holds
    if (Mb > M.lim[b]) { (M.why || (M.why = []))[b] = [mc, M.k[b] * Math.hypot(M.u[o], M.u[o + 1], M.u[o + 2]) * M.L[b], M.lim[b]]; const clean = M.dry[b] && M.rB[b] < breakR; if (!clean) M.hinge[b] = 1; out.push({ b, node: M.first[b], clean }); }
  }
  return out;
}
// a node and everything it carries gone: those segments are no longer simulated (a branch cut part way keeps the rest)
export function remove(M, P, node) {
  for (let i = 0; i < M.n; i++) { let q = i, cut = false; while (q >= 0) { if (q === node) { cut = true; break; } q = P.par[q]; } if (!cut) continue; const b = M.nodeB[i]; if (b >= 0 && M.first[b] === i) { M.gone[b] = 1; M.awake[b] = 0; } M.nodeB[i] = -1; }
}

// how soft a point is: the compliance (m/N) felt at node i's segment, at fraction t along it, through every branch from there
// to the anchor (springs in series, φ(s)²/k each); 0 for a node that is not simulated (rigid)
export function compliance(M, i, t) {
  let b = M.nodeB[i]; if (b < 0) return 0;
  let C = 0, ss = M.s0[i] + (M.s1[i] - M.s0[i]) * t;
  for (let d = 0; b >= 0 && d < 8; d++) {
    if (M.gone[b]) break; C += phi(Math.max(0.02, ss)) ** 2 / (M.k[b] * (M.hinge[b] ? 0.01 : 1));
    const a = M.att[b]; if (a < 0) break; ss = M.s1[a]; b = M.nodeB[a];
  }
  return C;
}

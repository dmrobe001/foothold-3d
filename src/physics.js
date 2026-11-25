// Physics for things the body touches: plant branches as elastic rods, solved with XPBD (extended position-based
// dynamics, Macklin et al. 2016). Pure data, no three.js; the same class runs in a Web Worker (its source is sent as a
// string) or, where workers are unavailable, on the main thread. Written without allocation in the inner loops.
//
// A "group" is one branch subtree (or a whole sapling) woken because the body came near. Particles sit at the end of
// each segment; a segment starts where it is attached on its parent (fraction u along the parent segment) or, for
// the group's root, at a fixed anchor on whatever rigid thing carries it (a trunk, a log, the ground). Each substep:
//   bend:    the segment's end is pulled toward its rest direction carried along by the parent's current rotation,
//            with compliance 1 / k, k = 3 E I / L^3 (a cantilever's tip stiffness; I = π r^4 / 4). The parent's end
//            takes its share of the correction (weighted by inverse mass), so bending spreads back toward the root;
//   contact: capsules of the body (legs, torso, head, arms) push segments out, the push shared between the
//            segment's two ends by where it touches; the body is kinematic;
//   length:  segments do not stretch (a hard projection).
// After the step a joint whose bending strain r·θ/L exceeds the wood's limit snaps (reported; the game removes it).
// Gravity is left out for attached branches: their rest shape already includes their sag.
// Reaction on the body: each touching segment pushes back with the branch's cantilever stiffness out to the contact
// point, k_eff = 3 E I / ℓ³ (ℓ: arc length from the group's anchor), times how far that point is from rest.
export class PhysicsCore {
  constructor() { this.groups = new Map(); }
  add(g) { // g: { id, n, par Int32, u, s0 (n*3), x0 (n*3), r, L, k, w, lim }
    const n = g.n;
    g.x = Float32Array.from(g.x0); g.xp = Float32Array.from(g.x0); g.v = new Float32Array(n * 3); g.S = new Float32Array(n * 3); g.T = new Float32Array(n * 3);
    g.broken = new Uint8Array(n); g.quiet = 0; g.touch = new Uint8Array(n); g.ell = new Float32Array(n);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = g.par[i]; g.ell[i] = (p >= 0 ? g.ell[p] - g.L[p] * (1 - g.u[i]) : 0) + g.L[i];
      for (const q of [g.x0, g.s0]) { x0 = Math.min(x0, q[i * 3]); x1 = Math.max(x1, q[i * 3]); y0 = Math.min(y0, q[i * 3 + 1]); y1 = Math.max(y1, q[i * 3 + 1]); z0 = Math.min(z0, q[i * 3 + 2]); z1 = Math.max(z1, q[i * 3 + 2]); }
    }
    let span = 0; for (let i = 0; i < n; i++) span = Math.max(span, g.ell[i]);
    g.box = [x0, x1, y0, y1, z0, z1]; g.span = span; // the branch can swing up to its own length beyond its rest box
    this.groups.set(g.id, g);
  }
  remove(id) { this.groups.delete(id); }
  step(dt, caps) {
    const now = () => (typeof performance !== 'undefined' ? performance : Date).now(), t0 = now();
    const out = [], F = [0, 0, 0], SUB = 4, ITER = 2, h = Math.min(dt, 1 / 30) / SUB;
    let nodes = 0;
    for (const g of this.groups.values()) {
      nodes += g.n; g.touch.fill(0);
      // capsules that could reach this group at all
      const near = [];
      for (let c = 0; c < caps.length; c += 7) {
        const R = caps[c + 6] + g.span * 0.5, b = g.box;
        if (Math.max(caps[c], caps[c + 3]) + R < b[0] || Math.min(caps[c], caps[c + 3]) - R > b[1] || Math.max(caps[c + 1], caps[c + 4]) + R < b[2] || Math.min(caps[c + 1], caps[c + 4]) - R > b[3] || Math.max(caps[c + 2], caps[c + 5]) + R < b[4] || Math.min(caps[c + 2], caps[c + 5]) - R > b[5]) continue;
        near.push(c);
      }
      const moving = g.quiet < 1.5 || near.length;
      if (moving) for (let s = 0; s < SUB; s++) {
        for (let i = 0; i < g.n * 3; i++) { g.xp[i] = g.x[i]; g.x[i] += g.v[i] * h; }
        for (let it = 0; it < ITER; it++) this.solve(g, h, caps, near, it === ITER - 1 && s === SUB - 1 ? F : null);
        for (let i = 0; i < g.n * 3; i++) g.v[i] = (g.x[i] - g.xp[i]) / h * 0.985;
      }
      const breaks = [];
      let maxD = 0, maxV = 0, touched = false;
      for (let i = 0; i < g.n; i++) {
        if (g.touch[i]) touched = true;
        if (!g.broken[i] && this.strain(g, i) > g.lim[i]) { g.broken[i] = 1; breaks.push(i); }
        const k = i * 3;
        maxD = Math.max(maxD, Math.abs(g.x[k] - g.x0[k]) + Math.abs(g.x[k + 1] - g.x0[k + 1]) + Math.abs(g.x[k + 2] - g.x0[k + 2]));
        maxV = Math.max(maxV, Math.abs(g.v[k]) + Math.abs(g.v[k + 1]) + Math.abs(g.v[k + 2]));
      }
      g.quiet = touched ? 0 : g.quiet + dt;
      const disp = new Float32Array(g.n * 3); for (let i = 0; i < g.n * 3; i++) disp[i] = g.x[i] - g.x0[i];
      out.push({ id: g.id, disp, breaks, touched, sleep: g.quiet > 1.5 && maxD < 0.006 && maxV < 0.02 });
    }
    return { groups: out, force: F, nodes, ms: now() - t0 };
  }
  // S_i: where segment i starts now; T_i: its rest vector turned by the parent's current rotation, added to S_i
  frame(g, i) {
    const p = g.par[i], x = g.x, S = g.S, T = g.T, x0 = g.x0, s0 = g.s0, k = i * 3;
    let sx, sy, sz;
    if (p < 0) { sx = s0[k]; sy = s0[k + 1]; sz = s0[k + 2]; }
    else { const u = g.u[i], q = p * 3; sx = S[q] + (x[q] - S[q]) * u; sy = S[q + 1] + (x[q + 1] - S[q + 1]) * u; sz = S[q + 2] + (x[q + 2] - S[q + 2]) * u; }
    S[k] = sx; S[k + 1] = sy; S[k + 2] = sz;
    let dx = x0[k] - s0[k], dy = x0[k + 1] - s0[k + 1], dz = x0[k + 2] - s0[k + 2];
    if (p >= 0) { // minimal rotation taking the parent's rest direction a to its current direction b, applied to d
      const q = p * 3;
      let ax = x0[q] - s0[q], ay = x0[q + 1] - s0[q + 1], az = x0[q + 2] - s0[q + 2], bx = x[q] - S[q], by = x[q + 1] - S[q + 1], bz = x[q + 2] - S[q + 2];
      const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1; ax /= la; ay /= la; az /= la; bx /= lb; by /= lb; bz /= lb;
      let qx = ay * bz - az * by, qy = az * bx - ax * bz, qz = ax * by - ay * bx, qw = 1 + ax * bx + ay * by + az * bz;
      if (qw > 1e-6) {
        const ql = Math.hypot(qx, qy, qz, qw); qx /= ql; qy /= ql; qz /= ql; qw /= ql;
        const tx = 2 * (qy * dz - qz * dy), ty = 2 * (qz * dx - qx * dz), tz = 2 * (qx * dy - qy * dx);
        const rx = dx + qw * tx + (qy * tz - qz * ty), ry = dy + qw * ty + (qz * tx - qx * tz), rz = dz + qw * tz + (qx * ty - qy * tx);
        dx = rx; dy = ry; dz = rz;
      } else { dx = -dx; dy = -dy; dz = -dz; }
    }
    T[k] = sx + dx; T[k + 1] = sy + dy; T[k + 2] = sz + dz;
  }
  solve(g, h, caps, near, F) {
    const x = g.x, S = g.S, T = g.T;
    for (let i = 0; i < g.n; i++) { // parents come before children
      this.frame(g, i);
      const k = i * 3, p = g.par[i], q = p * 3;
      if (!g.broken[i]) {
        const ex = x[k] - T[k], ey = x[k + 1] - T[k + 1], ez = x[k + 2] - T[k + 2], C = Math.hypot(ex, ey, ez);
        if (C > 1e-7) { // XPBD bend: Δλ = -C / (Σ w + α/h²), α = 1/k
          const u = p >= 0 ? g.u[i] : 0, w = g.w[i], wp = p >= 0 ? g.w[p] * u * u : 0, dl = C / (w + wp + 1 / (g.k[i] * h * h)), f = w * dl / C;
          x[k] -= ex * f; x[k + 1] -= ey * f; x[k + 2] -= ez * f;
          if (p >= 0) { const fp = g.w[p] * u * dl / C; x[q] += ex * fp; x[q + 1] += ey * fp; x[q + 2] += ez * fp; }
        }
      }
      for (const c of near) {
        if (!this.segCap(S[k], S[k + 1], S[k + 2], x[k], x[k + 1], x[k + 2], caps, c, g.r[i])) continue;
        const hit = this.hit, b1 = hit.t, b0 = p >= 0 ? (1 - hit.t) * g.u[i] : 0, den = b0 * b0 + b1 * b1 || 1;
        const k1 = Math.min(hit.pen * b1 / den, 0.3), k0 = Math.min(hit.pen * b0 / den, 0.3);
        x[k] += hit.nx * k1; x[k + 1] += hit.ny * k1; x[k + 2] += hit.nz * k1; g.touch[i] = 1;
        if (p >= 0) { x[q] += hit.nx * k0; x[q + 1] += hit.ny * k0; x[q + 2] += hit.nz * k0; }
        if (F) {
          const ell = Math.max(0.05, g.ell[i] - g.L[i] * (1 - hit.t)), keff = g.k[i] * g.L[i] ** 3 / ell ** 3;
          const dev = Math.hypot(x[k] - T[k], x[k + 1] - T[k + 1], x[k + 2] - T[k + 2]) * hit.t, f = keff * dev;
          F[0] -= hit.nx * f; F[1] -= hit.ny * f; F[2] -= hit.nz * f;
        }
      }
      const dx = x[k] - S[k], dy = x[k + 1] - S[k + 1], dz = x[k + 2] - S[k + 2], l = Math.hypot(dx, dy, dz) || 1, s = g.L[i] / l;
      x[k] = S[k] + dx * s; x[k + 1] = S[k + 1] + dy * s; x[k + 2] = S[k + 2] + dz * s;
    }
  }
  strain(g, i) { // bending strain at the joint: r × curvature, curvature ≈ angle from rest / length
    this.frame(g, i);
    const k = i * 3, S = g.S, T = g.T, x = g.x;
    const ax = x[k] - S[k], ay = x[k + 1] - S[k + 1], az = x[k + 2] - S[k + 2], bx = T[k] - S[k], by = T[k + 1] - S[k + 1], bz = T[k + 2] - S[k + 2];
    const c = (ax * bx + ay * by + az * bz) / ((Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)) || 1);
    return Math.acos(Math.max(-1, Math.min(1, c))) / g.L[i] * g.r[i];
  }
  // closest approach of segment (a → b, radius r) and capsule c; fills this.hit { pen, nx, ny, nz, t } and returns true
  segCap(ax, ay, az, bx, by, bz, caps, c, r) {
    const d1x = bx - ax, d1y = by - ay, d1z = bz - az, q0x = caps[c], q0y = caps[c + 1], q0z = caps[c + 2];
    const d2x = caps[c + 3] - q0x, d2y = caps[c + 4] - q0y, d2z = caps[c + 5] - q0z, R = caps[c + 6], rx = ax - q0x, ry = ay - q0y, rz = az - q0z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz, cc = d1x * rx + d1y * ry + d1z * rz;
    let s, t;
    if (e < 1e-9) { t = 0; s = a > 1e-9 ? Math.max(0, Math.min(1, -cc / a)) : 0; }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-9 ? Math.max(0, Math.min(1, (b * f - cc * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = a > 1e-9 ? Math.max(0, Math.min(1, -cc / a)) : 0; } else if (t > 1) { t = 1; s = a > 1e-9 ? Math.max(0, Math.min(1, (b - cc) / a)) : 0; }
    }
    const nx = ax + d1x * s - q0x - d2x * t, ny = ay + d1y * s - q0y - d2y * t, nz = az + d1z * s - q0z - d2z * t, dist = Math.hypot(nx, ny, nz), pen = r + R - dist;
    if (pen <= 0) return false;
    const H = this.hit || (this.hit = {});
    H.pen = pen; H.t = s;
    if (dist < 1e-6) { H.nx = 0; H.ny = 1; H.nz = 0; } else { H.nx = nx / dist; H.ny = ny / dist; H.nz = nz / dist; }
    return true;
  }
}
// the worker's program: the class above plus a message loop
export function workerSource() {
  return `${PhysicsCore.toString()}
const core = new PhysicsCore();
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'add') core.add(m.g);
  else if (m.type === 'remove') core.remove(m.id);
  else if (m.type === 'reset') core.groups.clear();
  else if (m.type === 'step') { const r = core.step(m.dt, m.caps); postMessage({ type: 'state', ...r }, r.groups.map((g) => g.disp.buffer)); }
};`;
}

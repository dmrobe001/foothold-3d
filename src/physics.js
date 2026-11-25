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
  constructor() { this.groups = new Map(); this.bodies = new Map(); }
  add(g) { // g: { id, n, par Int32, u, s0 (n*3), x0 (n*3), r, L, k, w, lim }
    const n = g.n;
    g.x = Float32Array.from(g.x0); g.xp = Float32Array.from(g.x0); g.v = new Float32Array(n * 3); g.S = new Float32Array(n * 3); g.T = new Float32Array(n * 3);
    g.broken = new Uint8Array(n); g.quiet = 2; g.touch = new Uint8Array(n); g.ell = new Float32Array(n); // quiet: starts at rest, simulated only once something can reach it
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = g.par[i]; g.ell[i] = (p >= 0 ? g.ell[p] - g.L[p] * (1 - g.u[i]) : 0) + g.L[i];
      for (const q of [g.x0, g.s0]) { x0 = Math.min(x0, q[i * 3]); x1 = Math.max(x1, q[i * 3]); y0 = Math.min(y0, q[i * 3 + 1]); y1 = Math.max(y1, q[i * 3 + 1]); z0 = Math.min(z0, q[i * 3 + 2]); z1 = Math.max(z1, q[i * 3 + 2]); }
    }
    let span = 0; for (let i = 0; i < n; i++) span = Math.max(span, g.ell[i]);
    g.box = [x0, x1, y0, y1, z0, z1]; g.span = span; // the branch can swing up to its own length beyond its rest box
    const old = g.carry !== undefined ? this.groups.get(g.carry) : null;
    if (old && old.ids && g.ids) { // the same plant's group, regrown or shrunk: keep the state of the nodes both share
      const at = new Map(); for (let j = 0; j < old.n; j++) at.set(old.ids[j], j);
      for (let i = 0; i < n; i++) {
        const j = at.get(g.ids[i]), k = i * 3;
        if (j !== undefined) { for (let c = 0; c < 3; c++) { g.x[k + c] = old.x[j * 3 + c]; g.xp[k + c] = old.x[j * 3 + c]; g.v[k + c] = old.v[j * 3 + c]; } g.broken[i] = old.broken[j]; }
        else { const p = g.par[i]; if (p >= 0) for (let c = 0; c < 3; c++) { g.x[k + c] = g.x0[k + c] + g.x[p * 3 + c] - g.x0[p * 3 + c]; g.xp[k + c] = g.x[k + c]; } } // new: carried along by its parent
      }
      g.quiet = old.quiet; this.groups.delete(old.id);
    }
    this.groups.set(g.id, g);
  }
  remove(id) { this.groups.delete(id); }
  // ---- rigid bodies: pieces that broke off. b: { id, m, Iinv (local 3x3, row-major), caps (local: ax,ay,az,bx,by,bz,r),
  // p (centre of mass), q (x,y,z,w), v, w, hf: { x0, z0, step, n, h } (top surface under it), trunks [x, z, r ...] }
  addBody(b) {
    b.v = b.v || [0, 0, 0]; b.w = b.w || [0, 0, 0]; b.wc = new Float32Array(b.caps.length); b.J = [0, 0, 0]; b.Tq = [0, 0, 0];
    b.still = 0; b.age = 0; b.settled = false; b.Iw = new Float32Array(9); b.R = new Float32Array(9);
    this.frameBody(b); this.bodies.set(b.id, b);
  }
  removeBody(id) { this.bodies.delete(id); }
  step(dt, caps, prev) { // caps: the body now; prev: where it was last step (swept over the substeps, so nothing tunnels)
    const now = () => (typeof performance !== 'undefined' ? performance : Date).now(), t0 = now();
    const F = [0, 0, 0], CF = new Float32Array(caps.length / 7 * 3), CP = new Float32Array(caps.length / 7 * 7), SUB = 4, ITER = 2, h = Math.min(dt, 1 / 30) / SUB;
    const groups = [...this.groups.values()], bodies = [...this.bodies.values()].filter((b) => !b.settled);
    let nodes = 0;
    for (const g of groups) { nodes += g.n; g.touch.fill(0); g.nearP = this.nearCaps(g, caps, 0); }
    for (let s = 0; s < SUB; s++) {
      // bodies: gravity and motion, then their capsules in the world
      let nb = 0;
      for (const b of bodies) { this.integrate(b, h); this.worldCaps(b); nb += b.wc.length; }
      const all = new Float32Array(caps.length + nb), owner = new Int32Array(all.length / 7).fill(-1);
      if (prev && prev.length === caps.length) { const f = (s + 1) / SUB; for (let k = 0; k < caps.length; k++) all[k] = prev[k] + (caps[k] - prev[k]) * f; } else all.set(caps, 0);
      let off = caps.length;
      bodies.forEach((b, k) => { all.set(b.wc, off); owner.fill(k, off / 7, (off + b.wc.length) / 7); off += b.wc.length; b.J[0] = b.J[1] = b.J[2] = 0; b.Tq[0] = b.Tq[1] = b.Tq[2] = 0; });
      for (const g of groups) {
        const near = bodies.length ? g.nearP.concat(this.nearCaps(g, all, caps.length)) : g.nearP;
        if (!(g.quiet < 1.5 || near.length)) continue;
        for (let i = 0; i < g.n * 3; i++) { g.xp[i] = g.x[i]; g.x[i] += g.v[i] * h; }
        for (let it = 0; it < ITER; it++) this.solve(g, h, all, near, it === 0 ? F : null, owner, bodies, it === ITER - 1, CF, CP);
        this.clear(g, all, near, owner); // last word to contact: nothing ends a substep inside the body
        for (let i = 0; i < g.n * 3; i++) g.v[i] = (g.x[i] - g.xp[i]) / h * 0.985;
      }
      for (const b of bodies) { this.applyImpulse(b); this.contactEnv(b, h); }
    }
    for (let k = 0; k < 3; k++) F[k] /= SUB; for (let k = 0; k < CF.length; k++) CF[k] /= SUB; // summed over substeps: the time-averaged push
    const out = [];
    for (const g of groups) {
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
    const bout = [];
    for (const b of [...this.bodies.values()]) {
      if (!b.settled) { // at rest for half a second, or given up on after 15 s
        b.age += dt; const sp = Math.hypot(...b.v), sw = Math.hypot(...b.w);
        b.still = sp < 0.12 && sw < 0.3 ? b.still + dt : 0;
        if (b.still > 0.4 || b.age > 15) b.settled = true;
      }
      bout.push({ id: b.id, p: [...b.p], q: [...b.q], settled: b.settled });
      if (b.settled) this.bodies.delete(b.id);
    }
    const hits = this.bodyHits || 0; this.bodyHits = 0;
    return { groups: out, bodies: bout, force: F, capF: CF, capP: CP, nodes, hits, ms: now() - t0 };
  }
  nearCaps(g, caps, from) { // capsule offsets that could reach this group
    const near = [], b = g.box;
    for (let c = from; c < caps.length; c += 7) {
      const R = caps[c + 6] + (g.quiet < 1.5 ? g.span * 0.5 : 0.15); // a branch at rest is where it was; a moving one may swing up to its length
      if (Math.max(caps[c], caps[c + 3]) + R < b[0] || Math.min(caps[c], caps[c + 3]) - R > b[1] || Math.max(caps[c + 1], caps[c + 4]) + R < b[2] || Math.min(caps[c + 1], caps[c + 4]) - R > b[3] || Math.max(caps[c + 2], caps[c + 5]) + R < b[4] || Math.min(caps[c + 2], caps[c + 5]) - R > b[5]) continue;
      near.push(c);
    }
    return near;
  }
  // body frame: rotation matrix from the quaternion; world inverse inertia R I⁻¹ Rᵀ
  frameBody(b) {
    const [x, y, z, w] = b.q, R = b.R;
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
    R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
    R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
    const I = b.Iinv, T = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let a = 0; for (let k = 0; k < 3; k++) a += R[r * 3 + k] * I[k * 3 + c]; T[r * 3 + c] = a; }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let a = 0; for (let k = 0; k < 3; k++) a += T[r * 3 + k] * R[c * 3 + k]; b.Iw[r * 3 + c] = a; }
  }
  integrate(b, h) {
    b.v[1] -= 9.81 * h;
    const air = 1 - 0.05 * h; b.v[0] *= air; b.v[1] *= air; b.v[2] *= air; const spin = 1 - 0.4 * h; b.w[0] *= spin; b.w[1] *= spin; b.w[2] *= spin;
    b.p[0] += b.v[0] * h; b.p[1] += b.v[1] * h; b.p[2] += b.v[2] * h;
    const qx = b.q[0], qy = b.q[1], qz = b.q[2], qw = b.q[3], wx = b.w[0], wy = b.w[1], wz = b.w[2]; // q += ½ h (ω, 0) ⊗ q
    b.q[0] += 0.5 * h * (wx * qw + wy * qz - wz * qy); b.q[1] += 0.5 * h * (wy * qw + wz * qx - wx * qz);
    b.q[2] += 0.5 * h * (wz * qw + wx * qy - wy * qx); b.q[3] += 0.5 * h * (-wx * qx - wy * qy - wz * qz);
    const l = Math.hypot(b.q[0], b.q[1], b.q[2], b.q[3]) || 1; for (let k = 0; k < 4; k++) b.q[k] /= l;
    this.frameBody(b);
  }
  worldCaps(b) {
    const R = b.R, c = b.caps, o = b.wc;
    for (let k = 0; k < c.length; k += 7) {
      for (const e of [0, 3]) {
        const x = c[k + e], y = c[k + e + 1], z = c[k + e + 2];
        o[k + e] = b.p[0] + R[0] * x + R[1] * y + R[2] * z; o[k + e + 1] = b.p[1] + R[3] * x + R[4] * y + R[5] * z; o[k + e + 2] = b.p[2] + R[6] * x + R[7] * y + R[8] * z;
      }
      o[k + 6] = c[k + 6];
    }
  }
  applyImpulse(b) { // what the branches it pushed through did to it this substep
    b.v[0] += b.J[0] / b.m; b.v[1] += b.J[1] / b.m; b.v[2] += b.J[2] / b.m;
    const I = b.Iw, T = b.Tq;
    b.w[0] += I[0] * T[0] + I[1] * T[1] + I[2] * T[2]; b.w[1] += I[3] * T[0] + I[4] * T[1] + I[5] * T[2]; b.w[2] += I[6] * T[0] + I[7] * T[1] + I[8] * T[2];
  }
  hfAt(hf, x, z) { // bilinear top surface: [height, dh/dx, dh/dz]
    const gx = (x - hf.x0) / hf.step, gz = (z - hf.z0) / hf.step, n = hf.n;
    if (gx < 0 || gz < 0 || gx > n - 1 || gz > n - 1) return null;
    const i = Math.min(n - 2, Math.floor(gx)), j = Math.min(n - 2, Math.floor(gz)), fx = gx - i, fz = gz - j, H = hf.h;
    const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
    return [a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz, ((b - a) * (1 - fz) + (d - c) * fz) / hf.step, ((c - a) * (1 - fx) + (d - b) * fx) / hf.step];
  }
  // contacts with the world under it: the top surface (ground, logs, rocks) and standing trunks; impulses with
  // restitution and Coulomb friction at spheres along each capsule, plus a positional push out of penetration
  contactEnv(b, h) {
    const wc = b.wc;
    for (let k = 0; k < wc.length; k += 7) for (const t of [0, 0.5, 1]) {
      const px = wc[k] + (wc[k + 3] - wc[k]) * t, py = wc[k + 1] + (wc[k + 4] - wc[k + 1]) * t, pz = wc[k + 2] + (wc[k + 5] - wc[k + 2]) * t, r = wc[k + 6];
      const H = this.hfAt(b.hf, px, pz);
      if (H) { const pen = H[0] + r - py; if (pen > 0) { const nl = Math.hypot(H[1], 1, H[2]); this.resolve(b, px, py - r, pz, -H[1] / nl, 1 / nl, -H[2] / nl, pen, h); } }
      for (let q = 0; q < b.trunks.length; q += 3) {
        const dx = px - b.trunks[q], dz = pz - b.trunks[q + 1], d = Math.hypot(dx, dz) || 1e-6, pen = b.trunks[q + 2] + r - d;
        if (pen > 0) this.resolve(b, px - dx / d * r, py, pz - dz / d * r, dx / d, 0, dz / d, pen, h);
      }
    }
  }
  resolve(b, cx, cy, cz, nx, ny, nz, pen, h) {
    const rx = cx - b.p[0], ry = cy - b.p[1], rz = cz - b.p[2], I = b.Iw;
    const vel = () => [b.v[0] + b.w[1] * rz - b.w[2] * ry, b.v[1] + b.w[2] * rx - b.w[0] * rz, b.v[2] + b.w[0] * ry - b.w[1] * rx];
    const kOf = (ax, ay, az) => { // 1/m + a · ((I⁻¹ (r × a)) × r)
      const cx2 = ry * az - rz * ay, cy2 = rz * ax - rx * az, cz2 = rx * ay - ry * ax;
      const ix = I[0] * cx2 + I[1] * cy2 + I[2] * cz2, iy = I[3] * cx2 + I[4] * cy2 + I[5] * cz2, iz = I[6] * cx2 + I[7] * cy2 + I[8] * cz2;
      return 1 / b.m + ax * (iy * rz - iz * ry) + ay * (iz * rx - ix * rz) + az * (ix * ry - iy * rx);
    };
    const push = (jx, jy, jz) => {
      b.v[0] += jx / b.m; b.v[1] += jy / b.m; b.v[2] += jz / b.m;
      const tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
      b.w[0] += I[0] * tx + I[1] * ty + I[2] * tz; b.w[1] += I[3] * tx + I[4] * ty + I[5] * tz; b.w[2] += I[6] * tx + I[7] * ty + I[8] * tz;
    };
    let v = vel(); const vn = v[0] * nx + v[1] * ny + v[2] * nz;
    let jn = 0;
    if (vn < 0) { const e = vn < -1.2 ? 0.25 : 0; jn = -(1 + e) * vn / kOf(nx, ny, nz); push(jn * nx, jn * ny, jn * nz); }
    v = vel(); const vn2 = v[0] * nx + v[1] * ny + v[2] * nz, tx = v[0] - vn2 * nx, ty = v[1] - vn2 * ny, tz = v[2] - vn2 * nz, vt = Math.hypot(tx, ty, tz);
    if (vt > 1e-5) { // friction, bounded by μ times the normal impulse (resting contact counts its weight this substep)
      const ux = tx / vt, uy = ty / vt, uz = tz / vt, jt = Math.min(vt / kOf(ux, uy, uz), 0.6 * Math.max(jn, b.m * 9.81 * h * Math.max(0, ny) * 0.5));
      push(-jt * ux, -jt * uy, -jt * uz);
    }
    const c = Math.min(pen, 0.05) * 0.6; b.p[0] += nx * c; b.p[1] += ny * c; b.p[2] += nz * c;
    b.w[0] *= 0.995; b.w[1] *= 0.995; b.w[2] *= 0.995; // rolling resistance: it settles instead of rocking forever
    if (Math.hypot(b.v[0], b.v[1], b.v[2]) < 0.25 && Math.hypot(b.w[0], b.w[1], b.w[2]) < 0.6) { // slow and touching: rest damping kills contact jitter
      b.v[0] *= 0.92; b.v[1] *= 0.92; b.v[2] *= 0.92; b.w[0] *= 0.92; b.w[1] *= 0.92; b.w[2] *= 0.92;
    }
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
  solve(g, h, caps, near, F, owner, bodies, last, CF, CP) {
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
      const r = g.r[i], lx = Math.min(S[k], x[k]) - r, hx = Math.max(S[k], x[k]) + r, ly = Math.min(S[k + 1], x[k + 1]) - r, hy = Math.max(S[k + 1], x[k + 1]) + r, lz = Math.min(S[k + 2], x[k + 2]) - r, hz = Math.max(S[k + 2], x[k + 2]) + r;
      for (const c of near) {
        const R = caps[c + 6]; // boxes first: most segments are nowhere near most capsules
        if (Math.min(caps[c], caps[c + 3]) - R > hx || Math.max(caps[c], caps[c + 3]) + R < lx || Math.min(caps[c + 1], caps[c + 4]) - R > hy || Math.max(caps[c + 1], caps[c + 4]) + R < ly || Math.min(caps[c + 2], caps[c + 5]) - R > hz || Math.max(caps[c + 2], caps[c + 5]) + R < lz) continue;
        if (!this.segCap(S[k], S[k + 1], S[k + 2], x[k], x[k + 1], x[k + 2], caps, c, r)) continue;
        const hit = this.hit, b1 = hit.t, b0 = p >= 0 ? (1 - hit.t) * g.u[i] : 0, den = b0 * b0 + b1 * b1 || 1;
        const k1 = Math.min(hit.pen * b1 / den, 0.3), k0 = Math.min(hit.pen * b0 / den, 0.3);
        x[k] += hit.nx * k1; x[k + 1] += hit.ny * k1; x[k + 2] += hit.nz * k1; g.touch[i] = 1;
        if (p >= 0) { x[q] += hit.nx * k0; x[q + 1] += hit.ny * k0; x[q + 2] += hit.nz * k0; }
        const ob = owner ? owner[c / 7] : -1;
        if ((ob < 0 && F) || (ob >= 0 && last)) { // the branch pushes back with its stiffness out to the contact point
          const ell = Math.max(0.05, g.ell[i] - g.L[i] * (1 - hit.t)), keff = g.k[i] * g.L[i] ** 3 / ell ** 3;
          const dev = Math.hypot(x[k] - T[k], x[k + 1] - T[k + 1], x[k + 2] - T[k + 2]) * hit.t, f = keff * dev;
          if (ob < 0) { F[0] -= hit.nx * f; F[1] -= hit.ny * f; F[2] -= hit.nz * f; const cc = c / 7 * 3; CF[cc] -= hit.nx * f; CF[cc + 1] -= hit.ny * f; CF[cc + 2] -= hit.nz * f; // and on which part of the body
            const cp = c; if (f >= CP[cp + 6]) { CP[cp] = hit.px; CP[cp + 1] = hit.py; CP[cp + 2] = hit.pz; CP[cp + 3] = -hit.nx; CP[cp + 4] = -hit.ny; CP[cp + 5] = -hit.nz; CP[cp + 6] = f; } } // where it touches hardest: point on the branch, push on the body
          else { this.bodyHits = (this.bodyHits || 0) + 1; // on a falling piece: an impulse at the contact (capped: a branch cannot push harder than it takes to break it)
            const b = bodies[ob], j = Math.min(f, 4000) * h, jx = -hit.nx * j, jy = -hit.ny * j, jz = -hit.nz * j, rx = hit.qx - b.p[0], ry = hit.qy - b.p[1], rz = hit.qz - b.p[2];
            b.J[0] += jx; b.J[1] += jy; b.J[2] += jz; b.Tq[0] += ry * jz - rz * jy; b.Tq[1] += rz * jx - rx * jz; b.Tq[2] += rx * jy - ry * jx;
          }
        }
      }
      const dx = x[k] - S[k], dy = x[k + 1] - S[k + 1], dz = x[k + 2] - S[k + 2], l = Math.hypot(dx, dy, dz) || 1, s = g.L[i] / l;
      x[k] = S[k] + dx * s; x[k + 1] = S[k + 1] + dy * s; x[k + 2] = S[k + 2] + dz * s;
    }
  }
  clear(g, caps, near, owner) { // contact only, twice over, for segments touching the body (bend and length had their turn)
    const x = g.x, S = g.S;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < g.n; i++) {
      if (!g.touch[i]) continue;
      const k = i * 3, p = g.par[i], q = p * 3;
      this.frame(g, i);
      for (const c of near) {
        if (owner && owner[c / 7] >= 0) continue;
        if (!this.segCap(S[k], S[k + 1], S[k + 2], x[k], x[k + 1], x[k + 2], caps, c, g.r[i])) continue;
        const hit = this.hit, b1 = hit.t, b0 = p >= 0 ? (1 - hit.t) * g.u[i] : 0, den = b0 * b0 + b1 * b1 || 1;
        const k1 = hit.pen * b1 / den, k0 = hit.pen * b0 / den;
        x[k] += hit.nx * k1; x[k + 1] += hit.ny * k1; x[k + 2] += hit.nz * k1;
        if (p >= 0) { x[q] += hit.nx * k0; x[q + 1] += hit.ny * k0; x[q + 2] += hit.nz * k0; g.touch[p] = 1; }
      }
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
    H.pen = pen; H.t = s; H.px = ax + d1x * s; H.py = ay + d1y * s; H.pz = az + d1z * s; H.qx = q0x + d2x * t; H.qy = q0y + d2y * t; H.qz = q0z + d2z * t;
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
  else if (m.type === 'reset') { core.groups.clear(); core.bodies.clear(); }
  else if (m.type === 'body') core.addBody(m.b);
  else if (m.type === 'step') { const r = core.step(m.dt, m.caps, m.prev); postMessage({ type: 'state', ...r }, r.groups.map((g) => g.disp.buffer)); }
};`;
}

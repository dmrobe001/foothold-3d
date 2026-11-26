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
// a joint snaps clean off only if dry and under BREAK_R (m); rolling resistance coefficients (soft forest floor; bark on bark) and sliding friction; soil and litter under a segment: stiffness per contact point SOIL · r · length (N/m: 50 kN/m under a 0.8 m section of a 30 cm log, a few hundred under a twig); bark on bark: compliance WOOD (m/N)
const BREAK_R = 0.015, SOIL = 4e5, WOOD = 2e-6, CRR_SOIL = 0.25, CRR_WOOD = 0.08, MU_SOIL = 0.8, MU_WOOD = 0.7, SLOP = 0.008, DEP = 0.5, VMAX = Infinity, WMAX = Infinity, WDEP = Infinity; // (no speed, spin or bend-recovery limits: the energy audit found the sources instead) // DEP: the fastest an overlap is pushed out (m/s); deeper ones take a few substeps, not one kick
export class PhysicsCore {
  constructor() { this.groups = new Map(); this.free = new Map(); }
  add(g) { // g: { id, n, par Int32, u, s0 (n*3), x0 (n*3), r, L, k, w, lim }
    const n = g.n;
    g.x = Float32Array.from(g.x0); g.xp = Float32Array.from(g.x0); g.v = new Float32Array(n * 3); g.S = new Float32Array(n * 3); g.T = new Float32Array(n * 3);
    g.broken = new Uint8Array(n); g.hinge = new Uint8Array(n); g.grav = new Uint8Array(n); g.maxV = 0; if (!g.pin) g.pin = new Uint8Array(n); if (!g.dry) g.dry = new Uint8Array(n); g.quiet = 2; g.touch = new Uint8Array(n); g.ell = new Float32Array(n); // quiet: starts at rest, simulated only once something can reach it
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
        if (j !== undefined) { for (let c = 0; c < 3; c++) { g.x[k + c] = old.x[j * 3 + c]; g.xp[k + c] = old.x[j * 3 + c]; g.v[k + c] = old.v[j * 3 + c]; } g.broken[i] = old.broken[j]; g.hinge[i] = old.hinge[j]; g.grav[i] = old.grav[j]; }
        else { const p = g.par[i]; if (p >= 0) for (let c = 0; c < 3; c++) { g.x[k + c] = g.x0[k + c] + g.x[p * 3 + c] - g.x0[p * 3 + c]; g.xp[k + c] = g.x[k + c]; } } // new: carried along by its parent
      }
      g.quiet = old.quiet; g.hingedAny = old.hingedAny; this.groups.delete(old.id);
    }
    this.groups.set(g.id, g);
  }
  remove(id) { this.groups.delete(id); }
  step(dt, caps, prev, kb, mb, forces) { // caps: the body now; prev: where it was last step (swept over the substeps, so nothing tunnels)
    const now = () => (typeof performance !== 'undefined' ? performance : Date).now(), t0 = now();
    this.kb = kb && kb.length === caps.length / 7 ? kb : null; this.mb = mb && mb.length === caps.length / 7 ? mb : null; const CD = (this.CD = new Float32Array(caps.length / 7 * 4));
    const F = [0, 0, 0], CF = new Float32Array(caps.length / 7 * 3), CP = new Float32Array(caps.length / 7 * 7), SUB = 4, ITER = 2, FSUB = 4, h = Math.min(dt, 1 / 30) / SUB;
    const groups = [...this.groups.values()], frees = [...this.free.values()];
    const gf = [];
    for (const q of forces || []) { if (q.gid !== undefined) { gf.push(q); continue; } const f = this.free.get(q.id); if (f) { f.ext.push(q); if (f.sleep) this.wake(f); } }
    for (const g of groups) { g.touch.fill(0); g.nearP = this.nearCaps(g, caps, 0); }
    let nodes = 0; for (const g of groups) nodes += g.n;
    for (const f of frees) { if (!f.rk) f.rk = new Float32Array(f.nb); f.rk.fill(DEP * dt); } // how far branches may move each part this step (moves, not speed)
    for (let s = 0; s < SUB; s++) {
      for (const f of frees) this.fCaps(f);
      const awake = frees.filter((f) => !f.sleep);
      // the body, swept, where it has already given way; then every awake free capsule, for the rods to meet
      let nf = 0; for (const f of awake) nf += f.nc;
      const all = new Float32Array(caps.length + nf * 7), owner = new Int32Array(all.length / 7).fill(-1), fref = (this.fref = []);
      if (prev && prev.length === caps.length) { const k = (s + 1) / SUB; for (let c = 0; c < caps.length; c++) all[c] = prev[c] + (caps[c] - prev[c]) * k; } else all.set(caps, 0);
      for (let c = 0; c < caps.length; c += 7) { const j = c / 7 * 4; for (let e = 0; e < 6; e++) all[c + e] += CD[j + e % 3]; }
      this.all = all;
      let off = caps.length;
      for (const f of awake) for (let c = 0; c < f.nc; c++) { all.set(f.wc.subarray(c * 7, c * 7 + 7), off); owner[off / 7] = fref.length / 2; fref.push(f, c); off += 7; } // fref: (free, capsule) pairs
      const AU = this.audit ? awake.map((f) => this.energy(f, 0)) : null;
      for (const g of groups) {
        const near = nf ? g.nearP.concat(this.nearCaps(g, all, caps.length)) : g.nearP;
        if (!(g.quiet < 0.5 || g.maxV > 0.05 || near.length || gf.some((q) => q.gid === g.id))) continue; // asleep: untouched for half a second and still
        for (const q of gf) if (q.gid === g.id && q.j < g.n) { for (let d = 0; d < 3; d++) g.v[q.j * 3 + d] += q.F[d] * h * g.w[q.j]; g.quiet = 0; } // a point force on a branch (a push)
        for (let i = 0; i < g.n; i++) if (g.grav[i]) g.v[i * 3 + 1] -= 9.81 * h; // beyond a joint that gave way, the branch hangs under its own weight
        for (let i = 0; i < g.n * 3; i++) { g.xp[i] = g.x[i]; g.x[i] += g.v[i] * h; }
        for (let it = 0; it < ITER; it++) this.solve(g, h, all, near, it === 0 ? F : null, owner, null, it === ITER - 1, CF, CP);
        this.clear(g, all, near, owner);
        for (let i = 0; i < g.n * 3; i++) g.v[i] = (g.x[i] - g.xp[i]) / h * 0.985;
      }
      if (AU) awake.forEach((f, i) => { this.au(f).rods += this.energy(f, 0) - AU[i]; });
      // free objects: XPBD wants many small substeps and one pass each
      const hf = h / FSUB;
      for (const f of awake) this.fSelfPairs(f);
      for (let fs = 0; fs < FSUB; fs++) {
        if (!fs) for (const f of frees) if (f.sleep) this.fBody(f, all, caps.length, hf); // the body bumping a sleeping thing wakes it
        if (!this.audit) {
          for (const f of awake) this.fIntegrate(f, hf);
          for (const f of awake) { this.fJoints(f, hf); this.fGround(f, hf); this.fStatic(f, hf); this.fBody(f, all, caps.length, hf); }
          for (let a = 0; a < frees.length; a++) for (let b = a; b < frees.length; b++) { const f = frees[a], g = frees[b]; if (f.sleep && g.sleep) continue; this.fPair(f, g, hf); }
          for (const f of awake) this.fVel(f, hf);
        } else { // the same, with the energy each stage adds or takes (positions-derived velocity between stages: the stages telescope to the whole change)
          for (const f of awake) { const e0 = this.energy(f, 0); this.fIntegrate(f, hf); this.au(f).integrate += this.energy(f, hf) - e0; }
          for (const f of awake) for (const [k, fn] of [['joints', () => this.fJoints(f, hf)], ['ground', () => this.fGround(f, hf)], ['static', () => this.fStatic(f, hf)], ['body', () => this.fBody(f, all, caps.length, hf)]]) { const e0 = this.energy(f, hf); fn(); this.au(f)[k] += this.energy(f, hf) - e0; }
          const ep = awake.map((f) => this.energy(f, hf));
          for (let a = 0; a < frees.length; a++) for (let b = a; b < frees.length; b++) { const f = frees[a], g = frees[b]; if (f.sleep && g.sleep) continue; this.fPair(f, g, hf); }
          awake.forEach((f, i) => { this.au(f).pair += this.energy(f, hf) - ep[i]; });
          for (const f of awake) { const e0 = this.energy(f, hf); this.fVel(f, hf); this.au(f).vel += this.energy(f, 0) - e0; }
        }
      }
      for (const f of awake) this.fBreak(f, h);
    }
    for (let k = 0; k < 3; k++) F[k] /= SUB; for (let k = 0; k < CF.length; k++) CF[k] /= SUB; // summed over substeps: the time-averaged push
    const out = [];
    for (const g of groups) {
      const breaks = []; let hinged = false;
      let maxD = 0, maxV = 0, touched = false;
      for (let i = 0; i < g.n; i++) {
        if (g.touch[i]) touched = true;
        if (!g.broken[i] && !g.pin[i] && !g.hinge[i] && this.strain(g, i) > g.lim[i]) {
          if (g.dry[i] && g.r[i] < BREAK_R) { g.broken[i] = 1; breaks.push(i); } // small and dry: snaps clean off
          else { g.hinge[i] = 1; hinged = true; const sub = new Uint8Array(g.n); sub[i] = 1; g.grav[i] = 1; for (let j = i + 1; j < g.n; j++) if (g.par[j] >= 0 && sub[g.par[j]]) { sub[j] = 1; g.grav[j] = 1; } } // green or thick: it gives way but hangs on
        }
        const k = i * 3;
        maxD = Math.max(maxD, Math.abs(g.x[k] - g.x0[k]) + Math.abs(g.x[k + 1] - g.x0[k + 1]) + Math.abs(g.x[k + 2] - g.x0[k + 2]));
        maxV = Math.max(maxV, Math.abs(g.v[k]) + Math.abs(g.v[k + 1]) + Math.abs(g.v[k + 2]));
      }
      g.quiet = touched ? 0 : g.quiet + dt;
      const disp = new Float32Array(g.n * 3); for (let i = 0; i < g.n * 3; i++) disp[i] = g.x[i] - g.x0[i];
      g.maxV = maxV; if (!g.hingedAny && hinged) g.hingedAny = true;
      out.push({ id: g.id, disp, breaks, touched, hinged: !!g.hingedAny, sleep: g.quiet > 0.5 && maxV < 0.05 && (maxD < 0.006 || g.hingedAny) });
    }
    const fout = [], BB = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]; // the body's box
    for (let c = 0; c < caps.length; c += 7) for (const e of [0, 3]) for (let d = 0; d < 3; d++) { BB[d * 2] = Math.min(BB[d * 2], caps[c + e + d]); BB[d * 2 + 1] = Math.max(BB[d * 2 + 1], caps[c + e + d]); }
    for (const f of frees) {
      const pushed = f.ext.length > 0; f.ext.length = 0;
      if (f.sleep && !f.report) continue;
      if (!f.sleep) { // asleep once no part has gone anywhere for half a second (it may fidget in place); away from you, sooner; after 8 s regardless
        f.age += dt; f.still += dt;
        const B = f.box, far = caps.length > 0 && !pushed && (B[0] > BB[1] + 2 || B[1] < BB[0] - 2 || B[2] > BB[3] + 2 || B[3] < BB[2] - 2 || B[4] > BB[5] + 2 || B[5] < BB[4] - 2);
        let mv = 0; for (let i = 0; i < f.nb * 3; i++) mv = Math.max(mv, Math.abs(f.v[i]));
        if (far && mv < 0.3) f.farStill = (f.farStill || 0) + dt; else f.farStill = 0;
        if (!f.snap) { f.snap = Float32Array.from(f.bx); f.snapq = Float32Array.from(f.bq); f.still = 0; }
        let moved = 0; for (let b = 0; b < f.nb; b++) { moved = Math.max(moved, Math.hypot(f.bx[b * 3] - f.snap[b * 3], f.bx[b * 3 + 1] - f.snap[b * 3 + 1], f.bx[b * 3 + 2] - f.snap[b * 3 + 2]), 0.25 * (1 - Math.abs(f.bq[b * 4] * f.snapq[b * 4] + f.bq[b * 4 + 1] * f.snapq[b * 4 + 1] + f.bq[b * 4 + 2] * f.snapq[b * 4 + 2] + f.bq[b * 4 + 3] * f.snapq[b * 4 + 3])) * 100); }
        if (pushed || (moved > 0.02 && f.farStill < 0.3)) { if (moved > 0.02 || pushed) f.snap = null; } // still going (or something presses on it): look again from here
        else if (f.still > 0.5 || f.farStill >= 0.3 || f.age > 8) { f.sleep = true; f.snap = null; f.v.fill(0); f.w.fill(0); f.report = true; }
      }
      fout.push({ id: f.id, x: Float32Array.from(f.bx), q: Float32Array.from(f.bq), sleep: f.sleep, breaks: f.breaks.splice(0) });
      if (f.sleep) f.report = false;
    }
    const hits = this.bodyHits || 0; this.bodyHits = 0;
    return { groups: out, free: fout, force: F, capF: CF, capP: CP, capD: CD, nodes, hits, ms: now() - t0 };
  }
  // ---- free objects: anything not attached (broken-off pieces, loose wood, logs) is a set of rigid bodies joined where
  // the wood can bend, solved with XPBD for rigid bodies (Müller et al. 2020): positions and orientations move, then
  // constraints correct them through each body's generalized inverse mass (1/m + (r×n)·I⁻¹(r×n)), velocities follow.
  // Joints hold the two bodies together at a point (stiff) and resist turning from their rest relative orientation
  // with compliance 1/κ (κ = EI/L of the wood there); a joint breaks when the torque it carries exceeds the wood's
  // strength (MOR · πr³/4). Contacts (ground, rigid scenery, each other, the body) act at the contact point with
  // friction, so a cylinder rolls because friction turns it, and a bent or branched shape cannot roll and flops. Point
  // forces (a foot's weight, a hand's push) act where they are applied. At rest an object sleeps and is solid to others.
  // f: { id, nb, bx (nb*3 centre of mass), bq (nb*4), bm (nb), bI (nb*9 local inverse inertia), nc, cb (body of each
  //      capsule), cl (nc*6 local ends), cr (nc), nj, ja, jb, jra, jrb (nj*3 local anchors), jal (compliance), jtm (torque
  //      limit), mu, hf, statics }
  addFree(f) {
    const nb = f.nb; f.v = new Float32Array(nb * 3); f.w = new Float32Array(nb * 3); f.xp = new Float32Array(nb * 3); f.qp = new Float32Array(nb * 4);
    f.jbr = new Uint8Array(f.nj); f.jh = new Uint8Array(f.nj); f.jl = new Float32Array(f.nj * 3); f.still = 0; f.age = 0; f.sleep = !!f.sleep; f.ext = []; f.breaks = []; f.dep = new Float32Array(nb); f.app = new Float32Array(nb); f.wc = new Float32Array(f.nc * 7); f.box = [0, 0, 0, 0, 0, 0]; f.Iw = new Float32Array(nb * 9);
    if (f.v0) for (let b = 0; b < nb; b++) for (let k = 0; k < 3; k++) f.v[b * 3 + k] = f.v0[k];
    this.fFrames(f); this.fCaps(f);
    f.cts = []; f.noPair = new Set(); // parts of one object that touch in its rest shape (a fork's two branches at their base) never collide with each other
    f.thick = []; f.solid = []; for (let c = 0; c < f.nc; c++) { f.thick.push(c); f.solid.push(c); } // every part meets everything (self-contact candidates come from a grid: fSelfPairs) // only these meet each other within one object (twigs do not jam visibly)
    const W = f.wc, T = f.thick;
    for (let x = 0; x < T.length; x++) for (let y = x + 1; y < T.length; y++) { const c = T[x], d = T[y]; if (f.cb[c] === f.cb[d]) continue;
      const a = c * 7, k = d * 7, R = W[a + 6] + W[k + 6] + 0.01; // box first
      if (Math.min(W[a], W[a + 3]) - R > Math.max(W[k], W[k + 3]) || Math.max(W[a], W[a + 3]) + R < Math.min(W[k], W[k + 3]) || Math.min(W[a + 1], W[a + 4]) - R > Math.max(W[k + 1], W[k + 4]) || Math.max(W[a + 1], W[a + 4]) + R < Math.min(W[k + 1], W[k + 4]) || Math.min(W[a + 2], W[a + 5]) - R > Math.max(W[k + 2], W[k + 5]) || Math.max(W[a + 2], W[a + 5]) + R < Math.min(W[k + 2], W[k + 5])) continue;
      if (this.segCap(W[a], W[a + 1], W[a + 2], W[a + 3], W[a + 4], W[a + 5], W, k, W[a + 6] + 0.01)) f.noPair.add(c * f.nc + d); }
    this.free.set(f.id, f);
  }
  // ---- energy audit (this.audit): every awake free object's energy, and the stage that changed it ----
  // E = kinetic (from f.v, f.w when h = 0; from the motion since the substep began, (x − xp)/h, when h > 0, which is what the
  // velocity will be if nothing else acts) + gravity + bent joints (½θ²/α, the solver's own compliance) + pressed soil (½d²/α
  // per ground sample, as fGround models it). Stiff wood-on-wood contact energy is not counted.
  au(f) { return f.au || (f.au = { rods: 0, ext: 0, integrate: 0, joints: 0, ground: 0, static: 0, body: 0, pair: 0, vel: 0 }); }
  kinetic(f, h) {
    if (!f.bIn) { f.bIn = new Float32Array(f.nb * 9); for (let b = 0; b < f.nb; b++) { const [a, b1, c, d, e, g, p, q, i] = f.bI.subarray(b * 9, b * 9 + 9), A = e * i - g * q, B = -(d * i - g * p), C = d * q - e * p, det = a * A + b1 * B + c * C || 1e-12; f.bIn.set([A / det, -(b1 * i - c * q) / det, (b1 * g - c * e) / det, B / det, (a * i - c * p) / det, -(a * g - c * d) / det, C / det, -(a * q - b1 * p) / det, (a * e - b1 * d) / det], b * 9); } }
    let E = 0; const t = this._ta || (this._ta = [0, 0, 0]);
    for (let b = 0; b < f.nb; b++) {
      const o = b * 3, j = b * 4, q = f.bq; let vx, vy, vz, wx, wy, wz;
      if (h > 0) { vx = (f.bx[o] - f.xp[o]) / h; vy = (f.bx[o + 1] - f.xp[o + 1]) / h; vz = (f.bx[o + 2] - f.xp[o + 2]) / h;
        const p = f.qp, ax = q[j], ay = q[j + 1], az = q[j + 2], aw = q[j + 3], bx = -p[j], by = -p[j + 1], bz = -p[j + 2], bw = p[j + 3];
        let dx = aw * bx + ax * bw + ay * bz - az * by, dy = aw * by - ax * bz + ay * bw + az * bx, dz = aw * bz + ax * by - ay * bx + az * bw; const dw = aw * bw - ax * bx - ay * by - az * bz;
        if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; } wx = 2 * dx / h; wy = 2 * dy / h; wz = 2 * dz / h; }
      else { vx = f.v[o]; vy = f.v[o + 1]; vz = f.v[o + 2]; wx = f.w[o]; wy = f.w[o + 1]; wz = f.w[o + 2]; }
      const cq = [-q[j], -q[j + 1], -q[j + 2], q[j + 3]]; this.rot(cq, 0, wx, wy, wz, t); const I = f.bIn, i9 = b * 9; // spin in the body's own frame
      E += 0.5 * f.bm[b] * (vx * vx + vy * vy + vz * vz) + 0.5 * (t[0] * (I[i9] * t[0] + I[i9 + 1] * t[1] + I[i9 + 2] * t[2]) + t[1] * (I[i9 + 3] * t[0] + I[i9 + 4] * t[1] + I[i9 + 5] * t[2]) + t[2] * (I[i9 + 6] * t[0] + I[i9 + 7] * t[1] + I[i9 + 8] * t[2]));
    }
    return E;
  }
  energy(f, h) {
    let E = this.kinetic(f, h);
    for (let b = 0; b < f.nb; b++) E += f.bm[b] * 9.81 * f.bx[b * 3 + 1];
    const t = [0, 0, 0];
    for (let j = 0; j < f.nj; j++) { if (f.jbr[j]) continue; const a = f.ja[j], b = f.jb[j], qa = f.bq, ia = a * 4, ib = b * 4, ax = qa[ia], ay = qa[ia + 1], az = qa[ia + 2], aw = qa[ia + 3], bx = qa[ib], by = qa[ib + 1], bz = qa[ib + 2], bw = qa[ib + 3];
      let ex = aw * -bx + ax * bw + ay * -bz - az * -by, ey = aw * -by - ax * -bz + ay * bw + az * -bx, ez = aw * -bz + ax * -by - ay * -bx + az * bw; const ew = aw * bw + ax * bx + ay * by + az * bz; if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; }
      const rx = 2 * ex, ry = 2 * ey, rz = 2 * ez;
      if (!f.jh[j]) E += 0.5 * (rx * rx + ry * ry + rz * rz) / f.jal[j];
      else { this.rot(f.bq, ib, f.jax[j * 3], f.jax[j * 3 + 1], f.jax[j * 3 + 2], t); const tw = rx * t[0] + ry * t[1] + rz * t[2], b2 = rx * rx + ry * ry + rz * rz - tw * tw; E += 0.5 * tw * tw / (f.jal[j] * 5) + 0.5 * Math.max(0, b2) / (f.jal[j] * 1e4); } }
    if (f.hf) { this.fCaps(f); const wc = f.wc;
      for (let c = 0; c < f.nc; c++) { const k = c * 7, ln = Math.hypot(wc[k + 3] - wc[k], wc[k + 4] - wc[k + 1], wc[k + 5] - wc[k + 2]), ns = Math.max(2, Math.ceil(ln / 0.5)), r = wc[k + 6];
        for (let si = 0; si <= ns; si++) { const u = si / ns, px = wc[k] + (wc[k + 3] - wc[k]) * u, py = wc[k + 1] + (wc[k + 4] - wc[k + 1]) * u, pz = wc[k + 2] + (wc[k + 5] - wc[k + 2]) * u, H = this.hfAt(f.hf, px, pz); if (!H) continue;
          const pen = H[0] + r - py; if (pen > 0) E += 0.5 * pen * pen * SOIL * Math.max(0.003, r) * Math.max(0.1, ln / ns * 2); } } }
    return E;
  }
  wake(f) { f.sleep = false; f.still = 0; f.age = 0; f.snap = null; }
  rot(q, j, vx, vy, vz, out) { // rotate (vx,vy,vz) by quaternion q[j..j+3]
    const x = q[j], y = q[j + 1], z = q[j + 2], w = q[j + 3], tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    out[0] = vx + w * tx + y * tz - z * ty; out[1] = vy + w * ty + z * tx - x * tz; out[2] = vz + w * tz + x * ty - y * tx; return out;
  }
  fFrames(f) { // world inverse inertia R I⁻¹ Rᵀ per body
    for (let b = 0; b < f.nb; b++) {
      const j = b * 4, x = f.bq[j], y = f.bq[j + 1], z = f.bq[j + 2], w = f.bq[j + 3];
      const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
      const I = f.bI, o = b * 9, T = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let a = 0; for (let k = 0; k < 3; k++) a += R[r * 3 + k] * I[o + k * 3 + c]; T[r * 3 + c] = a; }
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let a = 0; for (let k = 0; k < 3; k++) a += T[r * 3 + k] * R[c * 3 + k]; f.Iw[o + r * 3 + c] = a; }
    }
  }
  fCaps(f) { // world capsules and the box
    const wc = f.wc, B = f.box, t = this._t || (this._t = [0, 0, 0]); B[0] = B[2] = B[4] = Infinity; B[1] = B[3] = B[5] = -Infinity;
    for (let c = 0; c < f.nc; c++) {
      const b = f.cb[c], k = c * 7, r = f.cr[c];
      for (const e of [0, 3]) { this.rot(f.bq, b * 4, f.cl[c * 6 + e], f.cl[c * 6 + e + 1], f.cl[c * 6 + e + 2], t); for (let d = 0; d < 3; d++) { const v = f.bx[b * 3 + d] + t[d]; wc[k + e + d] = v; B[d * 2] = Math.min(B[d * 2], v - r); B[d * 2 + 1] = Math.max(B[d * 2 + 1], v + r); } }
      wc[k + 6] = r;
    }
  }
  fIntegrate(f, h) {
    const ke0 = this.audit && f.ext.length ? this.kinetic(f, 0) : 0;
    for (const q of f.ext) { // point forces: linear and angular velocity at once
      const b = q.b, m = f.bm[b], o = b * 3, rx = q.p[0] - f.bx[o], ry = q.p[1] - f.bx[o + 1], rz = q.p[2] - f.bx[o + 2], Fx = q.F[0], Fy = q.F[1], Fz = q.F[2];
      f.v[o] += Fx * h / m; f.v[o + 1] += Fy * h / m; f.v[o + 2] += Fz * h / m;
      const tx = (ry * Fz - rz * Fy) * h, ty = (rz * Fx - rx * Fz) * h, tz = (rx * Fy - ry * Fx) * h, I = f.Iw, i9 = b * 9;
      f.w[o] += I[i9] * tx + I[i9 + 1] * ty + I[i9 + 2] * tz; f.w[o + 1] += I[i9 + 3] * tx + I[i9 + 4] * ty + I[i9 + 5] * tz; f.w[o + 2] += I[i9 + 6] * tx + I[i9 + 7] * ty + I[i9 + 8] * tz;
    }
    if (this.audit && f.ext.length) { const d = this.kinetic(f, 0) - ke0; this.au(f).ext += d; this.au(f).integrate -= d; } // (pushes and feet: work done on it from outside)
    for (let b = 0; b < f.nb; b++) {
      const o = b * 3, j = b * 4;
      f.v[o + 1] -= 9.81 * h; f.dep[b] = DEP * h; f.app[b] = Math.hypot(f.v[o], f.v[o + 1], f.v[o + 2]) * h + 1e-4;
      for (let d = 0; d < 3; d++) { f.xp[o + d] = f.bx[o + d]; f.bx[o + d] += f.v[o + d] * h; }
      for (let d = 0; d < 4; d++) f.qp[j + d] = f.bq[j + d];
      const q = f.bq, wx = f.w[o], wy = f.w[o + 1], wz = f.w[o + 2], qx = q[j], qy = q[j + 1], qz = q[j + 2], qw = q[j + 3];
      q[j] += 0.5 * h * (wx * qw + wy * qz - wz * qy); q[j + 1] += 0.5 * h * (wy * qw + wz * qx - wx * qz); q[j + 2] += 0.5 * h * (wz * qw + wx * qy - wy * qx); q[j + 3] += 0.5 * h * (-wx * qx - wy * qy - wz * qz);
      this.qn(q, j);
    }
    this.fFrames(f);
  }
  qn(q, j) { const l = Math.hypot(q[j], q[j + 1], q[j + 2], q[j + 3]) || 1; q[j] /= l; q[j + 1] /= l; q[j + 2] /= l; q[j + 3] /= l; }
  wGen(f, b, rx, ry, rz, nx, ny, nz) { // generalized inverse mass of body b at offset r along n (0 for a fixed thing: b < 0)
    if (!f || b < 0 || f.sleep) return 0;
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx, I = f.Iw, o = b * 9;
    return 1 / f.bm[b] + cx * (I[o] * cx + I[o + 1] * cy + I[o + 2] * cz) + cy * (I[o + 3] * cx + I[o + 4] * cy + I[o + 5] * cz) + cz * (I[o + 6] * cx + I[o + 7] * cy + I[o + 8] * cz);
  }
  vkick(f, b, P, nx, ny, nz, j) { // an impulse j along n at point P: velocity and spin (only an approaching contact)
    if (!f || b < 0 || f.sleep) return;
    const o = b * 3, m = f.bm[b], rx = P[0] - f.bx[o], ry = P[1] - f.bx[o + 1], rz = P[2] - f.bx[o + 2], w = f.w;
    const vn = (f.v[o] + w[o + 1] * rz - w[o + 2] * ry) * nx + (f.v[o + 1] + w[o + 2] * rx - w[o] * rz) * ny + (f.v[o + 2] + w[o] * ry - w[o + 1] * rx) * nz;
    const need = j * this.wGen(f, b, rx, ry, rz, nx, ny, nz) * (this.hstep || 1 / 240); // the push this would give, as a speed, compared with how fast it already leaves
    if (vn * (this.hstep || 1 / 240) >= need) return;
    let jj = j * Math.min(1, Math.max(0, 1 - vn * (this.hstep || 1 / 240) / need));
    const wg = this.wGen(f, b, rx, ry, rz, nx, ny, nz), R = f.rk; // every rod touching it shares one budget of DEP a step (many twigs from many sides do not add up to a throw)
    if (R) { if (jj * wg > R[b]) jj = R[b] / wg; R[b] -= jj * wg; if (jj <= 0) return; }
    f.v[o] += nx * jj / m; f.v[o + 1] += ny * jj / m; f.v[o + 2] += nz * jj / m;
    const tx = (ry * nz - rz * ny) * jj, ty = (rz * nx - rx * nz) * jj, tz = (rx * ny - ry * nx) * jj, I = f.Iw, i9 = b * 9;
    w[o] += I[i9] * tx + I[i9 + 1] * ty + I[i9 + 2] * tz; w[o + 1] += I[i9 + 3] * tx + I[i9 + 4] * ty + I[i9 + 5] * tz; w[o + 2] += I[i9 + 6] * tx + I[i9 + 7] * ty + I[i9 + 8] * tz;
  }
  imp(f, b, P, nx, ny, nz, j) { // an impulse j along n at point P: velocity and spin
    const o = b * 3, m = f.bm[b], rx = P[0] - f.bx[o], ry = P[1] - f.bx[o + 1], rz = P[2] - f.bx[o + 2], w = f.w;
    f.v[o] += nx * j / m; f.v[o + 1] += ny * j / m; f.v[o + 2] += nz * j / m;
    const tx = (ry * nz - rz * ny) * j, ty = (rz * nx - rx * nz) * j, tz = (rx * ny - ry * nx) * j, I = f.Iw, i9 = b * 9;
    w[o] += I[i9] * tx + I[i9 + 1] * ty + I[i9 + 2] * tz; w[o + 1] += I[i9 + 3] * tx + I[i9 + 4] * ty + I[i9 + 5] * tz; w[o + 2] += I[i9 + 6] * tx + I[i9 + 7] * ty + I[i9 + 8] * tz;
  }
  gkick(f, b, rx, ry, rz, px, py, pz) { // a kick that moves and turns the body without giving it speed (its previous pose moves with it)
    if (!f || b < 0 || f.sleep) return;
    const o = b * 3, j = b * 4, x0 = f.bx[o], y0 = f.bx[o + 1], z0 = f.bx[o + 2], q = f.bq, ax = -q[j], ay = -q[j + 1], az = -q[j + 2], aw = q[j + 3];
    this.kick(f, b, rx, ry, rz, px, py, pz);
    f.xp[o] += f.bx[o] - x0; f.xp[o + 1] += f.bx[o + 1] - y0; f.xp[o + 2] += f.bx[o + 2] - z0;
    const bx = q[j], by = q[j + 1], bz = q[j + 2], bw = q[j + 3]; // turn d = q_new · conj(q_old), applied to the previous orientation too
    const dx = bw * ax + bx * aw + by * az - bz * ay, dy = bw * ay - bx * az + by * aw + bz * ax, dz = bw * az + bx * ay - by * ax + bz * aw, dw = bw * aw - bx * ax - by * ay - bz * az;
    const p = f.qp, px2 = p[j], py2 = p[j + 1], pz2 = p[j + 2], pw2 = p[j + 3];
    p[j] = dw * px2 + dx * pw2 + dy * pz2 - dz * py2; p[j + 1] = dw * py2 - dx * pz2 + dy * pw2 + dz * px2; p[j + 2] = dw * pz2 + dx * py2 - dy * px2 + dz * pw2; p[j + 3] = dw * pw2 - dx * px2 - dy * py2 - dz * pz2; this.qn(p, j);
  }
  kick(f, b, rx, ry, rz, px, py, pz) { // apply a positional impulse p at offset r: moves and turns the body
    if (!f || b < 0 || f.sleep) return;
    const o = b * 3, m = f.bm[b]; f.bx[o] += px / m; f.bx[o + 1] += py / m; f.bx[o + 2] += pz / m;
    const tx = ry * pz - rz * py, ty = rz * px - rx * pz, tz = rx * py - ry * px, I = f.Iw, i9 = b * 9;
    const ax = I[i9] * tx + I[i9 + 1] * ty + I[i9 + 2] * tz, ay = I[i9 + 3] * tx + I[i9 + 4] * ty + I[i9 + 5] * tz, az = I[i9 + 6] * tx + I[i9 + 7] * ty + I[i9 + 8] * tz;
    const q = f.bq, j = b * 4, qx = q[j], qy = q[j + 1], qz = q[j + 2], qw = q[j + 3];
    q[j] += 0.5 * (ax * qw + ay * qz - az * qy); q[j + 1] += 0.5 * (ay * qw + az * qx - ax * qz); q[j + 2] += 0.5 * (az * qw + ax * qy - ay * qx); q[j + 3] += 0.5 * (-ax * qx - ay * qy - az * qz); this.qn(q, j);
  }
  // one positional constraint between point P1 on (f1, b1) and P2 on (f2, b2) (b < 0: fixed): separate them by d along n
  cpos(f1, b1, P1, f2, b2, P2, nx, ny, nz, d, alpha, h, vn) { // a contact: it may cancel their approach (vn < 0), and beyond that push
    // apart from a budget of DEP·h per body per substep shared by all its contacts (a long piece sampled at many points gets no more)
    // (both budgets are per body per substep and spent by every contact on it, so many samples of one overlap get them once: the
    // approach part, |v|·h, only ever cancels approach; the push part is DEP·h)
    const a1 = !f1.sleep, a2 = f2 && b2 >= 0 && !f2.sleep, B1 = f1.dep, B2 = a2 ? f2.dep : null, A1 = f1.app, A2 = a2 ? f2.app : null;
    const bud = Math.min(a1 ? B1[b1] : Infinity, B2 ? B2[b2] : Infinity, Math.max(0, DEP - Math.max(0, vn)) * h), ap = Math.min(Math.max(0, -vn) * h, a1 ? A1[b1] : Infinity, A2 ? A2[b2] : Infinity); // (no push at all once they already part at DEP: the cap is a speed, not a per-substep distance that adds up)
    // only the approach part changes velocity; the overlap they still have is cleared by moving them alone (split impulse, as Box2D and
    // Bullet do): an overlap that keeps coming back, under a spinning stick's end, must not add speed every substep
    const l = this.pos(f1, b1, P1, f2, b2, P2, nx, ny, nz, d, alpha, h, ap + bud, ap), ua = Math.min(this.lastMove, ap), ub = this.lastMove - ua;
    if (a1) { A1[b1] -= ua; B1[b1] = Math.max(0, B1[b1] - ub); } if (A2) { A2[b2] -= ua; B2[b2] = Math.max(0, B2[b2] - ub); }
    return l;
  }
  pos(f1, b1, P1, f2, b2, P2, nx, ny, nz, d, alpha, h, cap = Infinity, vpart = Infinity) { // vpart: the part of the move that is motion (the rest moves without becoming speed) // cap: the most a contact may move them apart in one substep
    // (beyond cancelling their approach): a deep overlap is pushed out at DEP, not in one kick that becomes its speed
    const r1x = P1[0] - (b1 >= 0 ? f1.bx[b1 * 3] : 0), r1y = P1[1] - (b1 >= 0 ? f1.bx[b1 * 3 + 1] : 0), r1z = P1[2] - (b1 >= 0 ? f1.bx[b1 * 3 + 2] : 0);
    const r2x = P2[0] - (b2 >= 0 ? f2.bx[b2 * 3] : 0), r2y = P2[1] - (b2 >= 0 ? f2.bx[b2 * 3 + 1] : 0), r2z = P2[2] - (b2 >= 0 ? f2.bx[b2 * 3 + 2] : 0);
    const w1 = this.wGen(f1, b1, r1x, r1y, r1z, nx, ny, nz), w2 = this.wGen(f2, b2, r2x, r2y, r2z, nx, ny, nz), den = w1 + w2 + alpha / (h * h); if (den <= 0) return 0;
    let l = d / den; if (l * (w1 + w2) > cap) l = cap / (w1 + w2); this.lastMove = l * (w1 + w2);
    const lv = Math.min(l, vpart / (w1 + w2)), lg = l - lv;
    this.kick(f1, b1, r1x, r1y, r1z, nx * lv, ny * lv, nz * lv); this.kick(f2, b2, r2x, r2y, r2z, -nx * lv, -ny * lv, -nz * lv);
    if (lg > 0) { this.gkick(f1, b1, r1x, r1y, r1z, nx * lg, ny * lg, nz * lg); this.gkick(f2, b2, r2x, r2y, r2z, -nx * lg, -ny * lg, -nz * lg); }
    return l;
  }
  // friction at a contact: undo the tangential slip of P1 relative to P2 this substep, up to μ times the normal correction
  fric(f1, b1, P1, f2, b2, P2, nx, ny, nz, dn, mu, h) {
    const s1 = this.slip(f1, b1, P1), s2 = this.slip(f2, b2, P2);
    let rx = s1[0] - s2[0], ry = s1[1] - s2[1], rz = s1[2] - s2[2]; const rn = rx * nx + ry * ny + rz * nz; rx -= rn * nx; ry -= rn * ny; rz -= rn * nz;
    const rl = Math.hypot(rx, ry, rz); if (rl < 1e-7) return;
    const lim = mu * dn; this.pos(f1, b1, P1, f2, b2, P2, -rx / rl, -ry / rl, -rz / rl, Math.min(rl, lim), 0, h);
  }
  slip(f, b, P) { // how far the body point now at P moved this substep
    if (!f || b < 0 || f.sleep) return [0, 0, 0];
    const o = b * 3, j = b * 4, t = [0, 0, 0], u = [0, 0, 0];
    const lx = P[0] - f.bx[o], ly = P[1] - f.bx[o + 1], lz = P[2] - f.bx[o + 2];
    // local coordinates of P under the current pose, then where that local point was under the previous pose
    const q = f.bq, cq = [-q[j], -q[j + 1], -q[j + 2], q[j + 3]]; this.rot(cq, 0, lx, ly, lz, t); this.rot(f.qp, j, t[0], t[1], t[2], u);
    return [P[0] - (f.xp[o] + u[0]), P[1] - (f.xp[o + 1] + u[1]), P[2] - (f.xp[o + 2] + u[2])];
  }
  fJoints(f, h) { // stiff point joints; bend-twist toward the rest relative orientation with the wood's compliance
    const t = [0, 0, 0], u = [0, 0, 0];
    for (let j = 0; j < f.nj; j++) {
      if (f.jbr[j]) continue;
      const a = f.ja[j], b = f.jb[j];
      this.rot(f.bq, a * 4, f.jra[j * 3], f.jra[j * 3 + 1], f.jra[j * 3 + 2], t); this.rot(f.bq, b * 4, f.jrb[j * 3], f.jrb[j * 3 + 1], f.jrb[j * 3 + 2], u);
      const P1 = [f.bx[a * 3] + t[0], f.bx[a * 3 + 1] + t[1], f.bx[a * 3 + 2] + t[2]], P2 = [f.bx[b * 3] + u[0], f.bx[b * 3 + 1] + u[1], f.bx[b * 3 + 2] + u[2]];
      const dx = P2[0] - P1[0], dy = P2[1] - P1[1], dz = P2[2] - P1[2], dl = Math.hypot(dx, dy, dz);
      if (dl > 1e-7) { // held as it opens; a gap left from before (it slept so, or a contact forced it) closes at DEP, not in one throw
        const nx = dx / dl, ny = dy / dl, nz = dz / dl, grow = this.vAt(f, b, P2, nx, ny, nz) - this.vAt(f, a, P1, nx, ny, nz);
        this.pos(f, a, P1, f, b, P2, nx, ny, nz, dl, 0, h, (DEP + Math.max(0, grow)) * h);
      }
      // angular: rotation taking b's orientation back to a's (rest relative orientation is identity: both built in world axes)
      const qa = f.bq, ia = a * 4, ib = b * 4, ax = qa[ia], ay = qa[ia + 1], az = qa[ia + 2], aw = qa[ia + 3], bx = qa[ib], by = qa[ib + 1], bz = qa[ib + 2], bw = qa[ib + 3];
      let ex = aw * -bx + ax * bw + ay * -bz - az * -by, ey = aw * -by - ax * -bz + ay * bw + az * -bx, ez = aw * -bz + ax * -by - ay * -bx + az * bw; const ew = aw * bw + ax * bx + ay * by + az * bz; // qa ⊗ conj(qb)
      if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; }
      const th = 2 * Math.hypot(ex, ey, ez); if (th < 1e-7) continue;
      const rx = ex * 2, ry = ey * 2, rz = ez * 2; // the rotation still to make, as a vector
      if (!f.jh[j]) { const l = this.ang(f, a, b, rx / th, ry / th, rz / th, th, f.jal[j], h); f.jl[j * 3] += rx / th * l / h; f.jl[j * 3 + 1] += ry / th * l / h; f.jl[j * 3 + 2] += rz / th * l / h; continue; } // angular impulse (a vector): summed over the step, the torque the joint carried (fBreak)
      // a joint that gave way: the splinter still resists twisting about the branch (a fifth as stiff) but hardly bending
      this.rot(f.bq, b * 4, f.jax[j * 3], f.jax[j * 3 + 1], f.jax[j * 3 + 2], t); const tw = rx * t[0] + ry * t[1] + rz * t[2];
      if (Math.abs(tw) > 1e-7) this.ang(f, a, b, t[0] * Math.sign(tw), t[1] * Math.sign(tw), t[2] * Math.sign(tw), Math.abs(tw), f.jal[j] * 5, h);
      const bx2 = rx - tw * t[0], by2 = ry - tw * t[1], bz2 = rz - tw * t[2], bl = Math.hypot(bx2, by2, bz2);
      if (bl > 1e-7) this.ang(f, a, b, bx2 / bl, by2 / bl, bz2 / bl, bl, f.jal[j] * 1e4, h);
    }
  }
  ang(f, a, b, nx, ny, nz, th, alpha, h) { // turn b toward a (and a toward b) about n by th, against compliance alpha; returns λ
    // (no faster than WDEP beyond their own relative turning: a bend left from before is undone over a few substeps, not thrown)
    const I = f.Iw;
    const wA = nx * (I[a * 9] * nx + I[a * 9 + 1] * ny + I[a * 9 + 2] * nz) + ny * (I[a * 9 + 3] * nx + I[a * 9 + 4] * ny + I[a * 9 + 5] * nz) + nz * (I[a * 9 + 6] * nx + I[a * 9 + 7] * ny + I[a * 9 + 8] * nz);
    const wB = nx * (I[b * 9] * nx + I[b * 9 + 1] * ny + I[b * 9 + 2] * nz) + ny * (I[b * 9 + 3] * nx + I[b * 9 + 4] * ny + I[b * 9 + 5] * nz) + nz * (I[b * 9 + 6] * nx + I[b * 9 + 7] * ny + I[b * 9 + 8] * nz);
    let l = th / (wA + wB + alpha / (h * h));
    const w = f.w, rel = Math.abs((w[b * 3] - w[a * 3]) * nx + (w[b * 3 + 1] - w[a * 3 + 1]) * ny + (w[b * 3 + 2] - w[a * 3 + 2]) * nz), cap = (WDEP + rel) * h;
    if (l * (wA + wB) > cap) l = cap / (wA + wB);
    this.turn(f, b, nx * l, ny * l, nz * l); this.turn(f, a, -nx * l, -ny * l, -nz * l);
    return l;
  }
  vAt(f, b, P, nx, ny, nz) { // normal velocity of body b's point P
    const o = b * 3, rx = P[0] - f.bx[o], ry = P[1] - f.bx[o + 1], rz = P[2] - f.bx[o + 2], w = f.w;
    return (f.v[o] + w[o + 1] * rz - w[o + 2] * ry) * nx + (f.v[o + 1] + w[o + 2] * rx - w[o] * rz) * ny + (f.v[o + 2] + w[o] * ry - w[o + 1] * rx) * nz;
  }
  fBreak(f, T) { // a joint whose mean torque over the step (T long) exceeded what the wood can carry snaps
    for (let j = 0; j < f.nj; j++) {
      const t = Math.hypot(f.jl[j * 3], f.jl[j * 3 + 1], f.jl[j * 3 + 2]) / T;
      if (!f.jbr[j] && !f.jh[j] && t > f.jtm[j]) { if (f.dry && f.jr[j] < BREAK_R) { f.jbr[j] = 1; f.breaks.push(j); } else f.jh[j] = 1; } // small and dry snaps clean off; anything else gives way and hangs on
      f.jl[j * 3] = f.jl[j * 3 + 1] = f.jl[j * 3 + 2] = 0;
    }
  }
  turn(f, b, px, py, pz) { // an angular impulse: q += ½ (I⁻¹ p) ⊗ q
    const I = f.Iw, o = b * 9, ax = I[o] * px + I[o + 1] * py + I[o + 2] * pz, ay = I[o + 3] * px + I[o + 4] * py + I[o + 5] * pz, az = I[o + 6] * px + I[o + 7] * py + I[o + 8] * pz;
    const q = f.bq, j = b * 4, qx = q[j], qy = q[j + 1], qz = q[j + 2], qw = q[j + 3];
    q[j] += 0.5 * (ax * qw + ay * qz - az * qy); q[j + 1] += 0.5 * (ay * qw + az * qx - ax * qz); q[j + 2] += 0.5 * (az * qw + ax * qy - ay * qx); q[j + 3] += 0.5 * (-ax * qx - ay * qy - az * qz); this.qn(q, j);
  }
  fGround(f, h) {
    this.fCaps(f);
    const wc = f.wc, mu = MU_SOIL;
    for (let c = 0; c < f.nc; c++) { const k0 = c * 7, ln = Math.hypot(wc[k0 + 3] - wc[k0], wc[k0 + 4] - wc[k0 + 1], wc[k0 + 5] - wc[k0 + 2]), ns = Math.max(2, Math.ceil(ln / 0.5)); for (let si = 0; si <= ns; si++) { const t = si / ns; // a sample every half metre at most: a long log follows the ground's shape
      const k = c * 7, r = wc[k + 6], px = wc[k] + (wc[k + 3] - wc[k]) * t, py = wc[k + 1] + (wc[k + 4] - wc[k + 1]) * t, pz = wc[k + 2] + (wc[k + 5] - wc[k + 2]) * t;
      const H = f.hf && this.hfAt(f.hf, px, pz); if (!H) continue;
      const pen = H[0] + r - py; if (pen <= 0) continue;
      const nl = Math.hypot(H[1], 1, H[2]), nx = -H[1] / nl, ny = 1 / nl, nz = -H[2] / nl, P = [px - nx * r, py - ny * r, pz - nz * r];
      const alpha = 1 / (SOIL * Math.max(0.003, r) * Math.max(0.1, ln / ns * 2)); // (per sample: the ground under its share of the length) // soil bears on the area under it: stiffer under a thick, long log than a twig
      f.touch = true; const vn0 = this.vAt(f, f.cb[c], P, nx, ny, nz), jn = this.cpos(f, f.cb[c], P, null, -1, P, nx, ny, nz, pen, alpha, h, vn0); f.cts.push(f.cb[c], P[0], P[1], P[2], nx, ny, nz, jn / h, CRR_SOIL * r, vn0);
      this.fric(f, f.cb[c], P, null, -1, P, nx, ny, nz, Math.min(pen, this.lastMove + DEP * h), mu, h); // (friction bounded by the push it actually got)
    } }
  }
  fStatic(f, h) {
    const S = f.statics; if (!S || !S.length) return;
    this.fCaps(f); const wc = f.wc;
    for (let c = 0; c < f.nc; c++) { const k = c * 7; for (let s = 0; s < S.length; s += 7) {
      if (!this.segCap(wc[k], wc[k + 1], wc[k + 2], wc[k + 3], wc[k + 4], wc[k + 5], S, s, wc[k + 6])) continue;
      const H = this.hit, P = [H.px - H.nx * wc[k + 6], H.py - H.ny * wc[k + 6], H.pz - H.nz * wc[k + 6]];
      f.touch = true; const vn0 = this.vAt(f, f.cb[c], P, H.nx, H.ny, H.nz), ln = this.cpos(f, f.cb[c], P, null, -1, P, H.nx, H.ny, H.nz, H.pen, WOOD, h, vn0); f.cts.push(f.cb[c], P[0], P[1], P[2], H.nx, H.ny, H.nz, ln / h, CRR_WOOD * wc[k + 6], vn0); this.fric(f, f.cb[c], P, null, -1, P, H.nx, H.ny, H.nz, Math.min(H.pen, this.lastMove + DEP * h), MU_WOOD, h);
    } }
  }
  fBody(f, all, nc, h) { // the body: shared by mass (the body's share moves it now, within the step)
    const B = f.box; this.fCaps(f); const wc = f.wc;
    for (let c = 0; c < nc; c += 7) {
      const R = all[c + 6]; if (Math.min(all[c], all[c + 3]) - R > B[1] || Math.max(all[c], all[c + 3]) + R < B[0] || Math.min(all[c + 1], all[c + 4]) - R > B[3] || Math.max(all[c + 1], all[c + 4]) + R < B[2] || Math.min(all[c + 2], all[c + 5]) - R > B[5] || Math.max(all[c + 2], all[c + 5]) + R < B[4]) continue;
      for (let s = 0; s < f.nc; s++) {
        const k = s * 7; if (!this.segCap(wc[k], wc[k + 1], wc[k + 2], wc[k + 3], wc[k + 4], wc[k + 5], all, c, wc[k + 6])) continue;
        const H = this.hit, b = f.cb[s], P = [H.px - H.nx * wc[k + 6], H.py - H.ny * wc[k + 6], H.pz - H.nz * wc[k + 6]];
        if (f.sleep) this.wake(f);
        const wo = this.wGen(f, b, P[0] - f.bx[b * 3], P[1] - f.bx[b * 3 + 1], P[2] - f.bx[b * 3 + 2], H.nx, H.ny, H.nz), wbd = this.mb ? 1 / this.mb[c / 7] : 0, so = wo / (wo + wbd || 1);
        { const vo = Math.max(0, this.vAt(f, b, P, H.nx, H.ny, H.nz)); this.pos(f, b, P, null, -1, P, H.nx, H.ny, H.nz, H.pen * so, 0, h, Math.max(0, DEP + 3 - vo) * h, Math.max(0, 1.5 - vo) * h); } // (it gets at most a walking pace from you as speed; the rest of the overlap just moves it) // (a body already deep in it, as when a log wakes around your legs, pushes it out at walking pace, not in one throw)
        const need = H.pen * (1 - so), D = this.CD, j4 = c / 7 * 4;
        if (D && need > 1e-6) { D[j4] -= H.nx * need; D[j4 + 1] -= H.ny * need; D[j4 + 2] -= H.nz * need; D[j4 + 3] = Math.hypot(D[j4], D[j4 + 1], D[j4 + 2]); for (const e of [0, 3]) { all[c + e] -= H.nx * need; all[c + e + 1] -= H.ny * need; all[c + e + 2] -= H.nz * need; } }
        this.fCaps(f);
      }
    }
  }
  fPair(f, g, h) { // two objects (or two parts of one, not joined to each other): at the contact point, with friction
    const A = f.box, B = g.box; if (A[0] > B[1] || A[1] < B[0] || A[2] > B[3] || A[3] < B[2] || A[4] > B[5] || A[5] < B[4]) return;
    this.fCaps(f); this.fCaps(g); const fw = f.wc, gw = g.wc, mu = MU_WOOD, self = f === g;
    if (self) { const P = f.pairs || []; for (let q = 0; q < P.length; q += 2) this.fContact(f, P[q], g, P[q + 1], fw, gw, mu, h); return; }
    const LA = f.solid, LB = g.solid, na = LA.length, nb2 = LB.length;
    for (let ia = 0; ia < na; ia++) { const c = LA[ia], k = c * 7;
      if (!self && (Math.min(fw[k], fw[k + 3]) - fw[k + 6] > B[1] || Math.max(fw[k], fw[k + 3]) + fw[k + 6] < B[0] || Math.min(fw[k + 1], fw[k + 4]) - fw[k + 6] > B[3] || Math.max(fw[k + 1], fw[k + 4]) + fw[k + 6] < B[2] || Math.min(fw[k + 2], fw[k + 5]) - fw[k + 6] > B[5] || Math.max(fw[k + 2], fw[k + 5]) + fw[k + 6] < B[4])) continue; // outside the other's box
      for (let ib = 0; ib < nb2; ib++) this.fContact(f, c, g, LB[ib], fw, gw, mu, h);
    }
  }
  fSelfPairs(f) { // parts of one object that could meet: a 0.5 m grid of their boxes (not joined, not touching at rest)
    const W = f.wc, cell = new Map(), out = [], seen = new Set(), C = 0.5;
    for (let c = 0; c < f.nc; c++) { const k = c * 7, r = W[k + 6];
      const x0 = Math.floor((Math.min(W[k], W[k + 3]) - r) / C), x1 = Math.floor((Math.max(W[k], W[k + 3]) + r) / C), y0 = Math.floor((Math.min(W[k + 1], W[k + 4]) - r) / C), y1 = Math.floor((Math.max(W[k + 1], W[k + 4]) + r) / C), z0 = Math.floor((Math.min(W[k + 2], W[k + 5]) - r) / C), z1 = Math.floor((Math.max(W[k + 2], W[k + 5]) + r) / C);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const key = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791); let a = cell.get(key); if (!a) cell.set(key, (a = [])); for (const d of a) { const id = d * f.nc + c; if (seen.has(id)) continue; seen.add(id); if (f.cb[c] === f.cb[d] || f.noPair.has(id) || this.joined(f, f.cb[c], f.cb[d])) continue; out.push(d, c); } a.push(c); }
    }
    f.pairs = out;
  }
  fContact(f, c, g, d, fw, gw, mu, h) {
    { const k = c * 7;
      const l = d * 7; if (!this.segCap(fw[k], fw[k + 1], fw[k + 2], fw[k + 3], fw[k + 4], fw[k + 5], gw, l, fw[k + 6])) return;
      const H = this.hit, P1 = [H.px - H.nx * fw[k + 6], H.py - H.ny * fw[k + 6], H.pz - H.nz * fw[k + 6]], P2 = [H.qx + H.nx * gw[l + 6], H.qy + H.ny * gw[l + 6], H.qz + H.nz * gw[l + 6]];
      if (H.pen <= SLOP) return; H.pen -= SLOP; // a little overlap is tolerated (logs in a pile rest slightly into each other)
      if (g.sleep && !f.sleep && H.pen > 0.02) this.wake(g); // woken only by a real push
      if (f.sleep && !g.sleep && H.pen > 0.02) this.wake(f);
      f.touch = g.touch = true; const vr = this.vAt(f, f.cb[c], P1, H.nx, H.ny, H.nz) - this.vAt(g, g.cb[d], P2, H.nx, H.ny, H.nz), ln = this.cpos(f, f.cb[c], P1, g, g.cb[d], P2, H.nx, H.ny, H.nz, H.pen, WOOD, h, vr); // bark on bark
      if (!f.sleep) f.cts.push(f.cb[c], P1[0], P1[1], P1[2], H.nx, H.ny, H.nz, ln / h, CRR_WOOD * fw[k + 6], 0); if (g !== f && !g.sleep) g.cts.push(g.cb[d], P2[0], P2[1], P2[2], -H.nx, -H.ny, -H.nz, ln / h, CRR_WOOD * gw[l + 6], 0);
      this.fric(f, f.cb[c], P1, g, g.cb[d], P2, H.nx, H.ny, H.nz, Math.min(H.pen, this.lastMove + DEP * h), mu, h);
    }
  }
  joined(f, a, b) { if (!f.jmap) { f.jmap = new Map(); for (let j = 0; j < f.nj; j++) { f.jmap.set(f.ja[j] * f.nb + f.jb[j], j); f.jmap.set(f.jb[j] * f.nb + f.ja[j], j); } } const j = f.jmap.get(a * f.nb + b); return j !== undefined && !f.jbr[j]; }
  fVel(f, h) {
    let fast = false;
    for (let b = 0; b < f.nb; b++) {
      const o = b * 3, j = b * 4;
      for (let d = 0; d < 3; d++) f.v[o + d] = (f.bx[o + d] - f.xp[o + d]) / h;
      const q = f.bq, p = f.qp, ax = q[j], ay = q[j + 1], az = q[j + 2], aw = q[j + 3], bx = -p[j], by = -p[j + 1], bz = -p[j + 2], bw = p[j + 3];
      let dx = aw * bx + ax * bw + ay * bz - az * by, dy = aw * by - ax * bz + ay * bw + az * bx, dz = aw * bz + ax * by - ay * bx + az * bw; const dw = aw * bw - ax * bx - ay * by - az * bz;
      if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; }
      f.w[o] = 2 * dx / h; f.w[o + 1] = 2 * dy / h; f.w[o + 2] = 2 * dz / h;
      const damp = 1 - 0.4 * h; for (let d = 0; d < 3; d++) f.w[o + d] *= damp;
      if (Math.hypot(f.v[o], f.v[o + 1], f.v[o + 2]) > 0.3 || Math.hypot(f.w[o], f.w[o + 1], f.w[o + 2]) > 1) fast = true;
    }
    { const k = 1 - Math.exp(-25 * h), kh = 1 - Math.exp(-80 * h), I = f.Iw, w = f.w; // wood damps its own vibration: each joint takes out part of the two bodies' relative spin
      for (let j = 0; j < f.nj; j++) { if (f.jbr[j]) continue; const a = f.ja[j], b = f.jb[j], ia = (I[a * 9] + I[a * 9 + 4] + I[a * 9 + 8]), ib = (I[b * 9] + I[b * 9 + 4] + I[b * 9 + 8]), s = ia + ib || 1;
        const kk = f.jh[j] ? kh : k; // a splinter rubs: a joint that gave way damps the swing across it harder still
        for (let d = 0; d < 3; d++) { const rel = (w[b * 3 + d] - w[a * 3 + d]) * kk; w[b * 3 + d] -= rel * ib / s; w[a * 3 + d] += rel * ia / s; } } }
    for (let b = 0; b < f.nb; b++) { // nothing in a wood is thrown faster than this; a light part caught between constraints can be (the solver's error, not physics)
      const o = b * 3, v = Math.hypot(f.v[o], f.v[o + 1], f.v[o + 2]), w = Math.hypot(f.w[o], f.w[o + 1], f.w[o + 2]);
      if (v > VMAX) for (let d = 0; d < 3; d++) f.v[o + d] *= VMAX / v;
      if (w > WMAX) for (let d = 0; d < 3; d++) f.w[o + d] *= WMAX / w;
    }
    for (let i = 0; i < f.cts.length; i += 10) { // an impact (approaching faster than 0.3 m/s) on the ground or a fixed thing rebounds with at most 20 % of that speed; lifting off is free
      const b = f.cts[i], o = b * 3, rx = f.cts[i + 1] - f.bx[o], ry = f.cts[i + 2] - f.bx[o + 1], rz = f.cts[i + 3] - f.bx[o + 2], nx = f.cts[i + 4], ny = f.cts[i + 5], nz = f.cts[i + 6], w = f.w;
      const vn = (f.v[o] + w[o + 1] * rz - w[o + 2] * ry) * nx + (f.v[o + 1] + w[o + 2] * rx - w[o] * rz) * ny + (f.v[o + 2] + w[o] * ry - w[o + 1] * rx) * nz;
      const vn0 = f.cts[i + 9]; if (vn <= 0 || !(vn0 < -0.3) || vn <= -0.2 * vn0) continue;
      const j = -(vn + 0.2 * vn0) / this.wGen(f, b, rx, ry, rz, nx, ny, nz), m = f.bm[b]; f.v[o] += j * nx / m; f.v[o + 1] += j * ny / m; f.v[o + 2] += j * nz / m;
      const tx = (ry * nz - rz * ny) * j, ty = (rz * nx - rx * nz) * j, tz = (rx * ny - ry * nx) * j, I = f.Iw, i9 = b * 9;
      w[o] += I[i9] * tx + I[i9 + 1] * ty + I[i9 + 2] * tz; w[o + 1] += I[i9 + 3] * tx + I[i9 + 4] * ty + I[i9 + 5] * tz; w[o + 2] += I[i9 + 6] * tx + I[i9 + 7] * ty + I[i9 + 8] * tz;
    }
    for (let i = 0; i < f.cts.length; i += 10) { // rolling resistance: the surface deforms under a rolling thing, a torque Crr·r·N against the roll
      const b = f.cts[i], o = b * 3, nx = f.cts[i + 4], ny = f.cts[i + 5], nz = f.cts[i + 6], N = f.cts[i + 7], cr = f.cts[i + 8], w = f.w, I = f.Iw, i9 = b * 9;
      const wn = w[o] * nx + w[o + 1] * ny + w[o + 2] * nz, tx = w[o] - wn * nx, ty = w[o + 1] - wn * ny, tz = w[o + 2] - wn * nz, wt = Math.hypot(tx, ty, tz);
      if (wt < 1e-6 || !(N > 0)) continue;
      const J = cr * N, ux = tx / wt, uy = ty / wt, uz = tz / wt; // angular impulse against the roll this substep
      const ax = I[i9] * ux + I[i9 + 1] * uy + I[i9 + 2] * uz, ay = I[i9 + 3] * ux + I[i9 + 4] * uy + I[i9 + 5] * uz, az = I[i9 + 6] * ux + I[i9 + 7] * uy + I[i9 + 8] * uz, dw = Math.min(wt, J * Math.hypot(ax, ay, az));
      const al = Math.hypot(ax, ay, az) || 1; w[o] -= ax / al * dw; w[o + 1] -= ay / al * dw; w[o + 2] -= az / al * dw;
    }
    f.cts.length = 0;
    if (!fast && f.touch) { const k = Math.exp(-1 * h); for (let i = 0; i < f.nb * 3; i++) { f.v[i] *= k; f.w[i] *= k; } } // slow and touching something: contact jitter dies
    f.touch = false;
  }
  freePush(k, hit, j) { // a rod pushed a free piece: the reaction at the contact point
    const f = this.fref[k * 2], c = this.fref[k * 2 + 1]; if (!f) return;
    const b = f.cb[c], P = [hit.qx, hit.qy, hit.qz], d = j * (this.hstep || 1 / 240);
    const wo = this.wGen(f, b, P[0] - f.bx[b * 3], P[1] - f.bx[b * 3 + 1], P[2] - f.bx[b * 3 + 2], -hit.nx, -hit.ny, -hit.nz);
    this.pos(f, b, P, null, -1, P, -hit.nx, -hit.ny, -hit.nz, d * wo, 0, this.hstep || 1 / 240);
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
  hfAt(hf, x, z) { // bilinear top surface: [height, dh/dx, dh/dz]; beyond the patch, its edge carries on
    const n = hf.n, gx = Math.max(0, Math.min(n - 1, (x - hf.x0) / hf.step)), gz = Math.max(0, Math.min(n - 1, (z - hf.z0) / hf.step));
    const i = Math.min(n - 2, Math.floor(gx)), j = Math.min(n - 2, Math.floor(gz)), fx = gx - i, fz = gz - j, H = hf.h;
    const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
    return [a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz, ((b - a) * (1 - fz) + (d - c) * fz) / hf.step, ((c - a) * (1 - fx) + (d - b) * fx) / hf.step];
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
    const x = g.x, S = g.S, T = g.T; this.hstep = h;
    for (let i = 0; i < g.n; i++) { // parents come before children
      this.frame(g, i);
      const k = i * 3, p = g.par[i], q = p * 3;
      if (!g.broken[i]) {
        const ex = x[k] - T[k], ey = x[k + 1] - T[k + 1], ez = x[k + 2] - T[k + 2], C = Math.hypot(ex, ey, ez);
        if (C > 1e-7) { // XPBD bend: Δλ = -C / (Σ w + α/h²), α = 1/k (a joint that gave way keeps a hundredth: a splinter)
          const u = p >= 0 ? g.u[i] : 0, w = g.w[i], wp = p >= 0 ? g.w[p] * u * u : 0, dl = C / (w + wp + 1 / (g.k[i] * (g.hinge[i] ? 0.01 : 1) * h * h)), f = w * dl / C;
          x[k] -= ex * f; x[k + 1] -= ey * f; x[k + 2] -= ez * f;
          if (p >= 0) { const fp = g.w[p] * u * dl / C; x[q] += ex * fp; x[q + 1] += ey * fp; x[q + 2] += ez * fp; }
        }
      }
      const r = g.r[i], lx = Math.min(S[k], x[k]) - r, hx = Math.max(S[k], x[k]) + r, ly = Math.min(S[k + 1], x[k + 1]) - r, hy = Math.max(S[k + 1], x[k + 1]) + r, lz = Math.min(S[k + 2], x[k + 2]) - r, hz = Math.max(S[k + 2], x[k + 2]) + r;
      for (const c of near) {
        const R = caps[c + 6]; // boxes first: most segments are nowhere near most capsules
        if (Math.min(caps[c], caps[c + 3]) - R > hx || Math.max(caps[c], caps[c + 3]) + R < lx || Math.min(caps[c + 1], caps[c + 4]) - R > hy || Math.max(caps[c + 1], caps[c + 4]) + R < ly || Math.min(caps[c + 2], caps[c + 5]) - R > hz || Math.max(caps[c + 2], caps[c + 5]) + R < lz) continue;
        if (g.skipFree !== undefined && owner && owner[c / 7] >= 0 && this.fref[owner[c / 7] * 2].id === g.skipFree) continue;
        if (!this.segCap(S[k], S[k + 1], S[k + 2], x[k], x[k + 1], x[k + 2], caps, c, r)) continue;
        const hit = this.hit, b1 = g.pin[i] ? 0 : hit.t, b0 = p >= 0 ? (1 - hit.t) * g.u[i] : 0, den = b0 * b0 + b1 * b1 || 1;
        const sh = this.share(g, i, hit, c, owner), shp = p >= 0 ? this.shareAt(g, p, c, owner) : 0, k1 = Math.min(hit.pen * sh * b1 / den, 0.3), k0 = Math.min(hit.pen * shp * b0 / den, 0.3);
        x[k] += hit.nx * k1; x[k + 1] += hit.ny * k1; x[k + 2] += hit.nz * k1; g.touch[i] = 1;
        if (p >= 0) { x[q] += hit.nx * k0; x[q + 1] += hit.ny * k0; x[q + 2] += hit.nz * k0; }
        const ob = owner ? owner[c / 7] : -1;
        if ((ob < 0 && F) || (ob >= 0 && last)) { // the branch pushes back with its stiffness out to the contact point
          const ell = Math.max(0.05, g.ell[i] - g.L[i] * (1 - hit.t)), keff = g.k[i] * g.L[i] ** 3 / ell ** 3;
          const dev = Math.hypot(x[k] - T[k], x[k + 1] - T[k + 1], x[k + 2] - T[k + 2]) * hit.t, f = keff * dev;
          if (ob < 0) { F[0] -= hit.nx * f; F[1] -= hit.ny * f; F[2] -= hit.nz * f; const cc = c / 7 * 3; CF[cc] -= hit.nx * f; CF[cc + 1] -= hit.ny * f; CF[cc + 2] -= hit.nz * f; // and on which part of the body
            const cp = c; if (f >= CP[cp + 6]) { CP[cp] = hit.px; CP[cp + 1] = hit.py; CP[cp + 2] = hit.pz; CP[cp + 3] = -hit.nx; CP[cp + 4] = -hit.ny; CP[cp + 5] = -hit.nz; CP[cp + 6] = f; } } // where it touches hardest: point on the branch, push on the body
          else this.bodyHits = (this.bodyHits || 0) + 1; // a free piece: already shared by mass (share)
        }
      }
      if (g.pin[i]) { x[k] = g.x0[k]; x[k + 1] = g.x0[k + 1]; x[k + 2] = g.x0[k + 2]; continue; } // held in the soil
      const dx = x[k] - S[k], dy = x[k + 1] - S[k + 1], dz = x[k + 2] - S[k + 2], l = Math.hypot(dx, dy, dz) || 1, s = g.L[i] / l;
      x[k] = S[k] + dx * s; x[k + 1] = S[k + 1] + dy * s; x[k + 2] = S[k + 2] + dz * s;
    }
  }
  // One rule for every contact between the body and a rod: the overlap is shared by stiffness. The rod at the contact
  // point is a cantilever, k_eff = 3EI/ℓ³ (ℓ from its anchor); the body part has its own stiffness (kb, per capsule:
  // an arm gives easily, a planted leg hardly). The rod takes kb / (kb + k_eff) of the overlap and the body the rest,
  // which is recorded (CD) as how far that body part must move. A twig moves; a thick root or limb moves the leg.
  shareAt(g, p, c, owner) { // the parent's own share at its end (a contact on a child also pushes the parent's end)
    if (owner && owner[c / 7] >= 0) return 1;
    if (g.pin[p]) return 0;
    const keff = g.k[p] * g.L[p] ** 3 / Math.max(0.05, g.ell[p]) ** 3, kb = this.kb ? this.kb[c / 7] : 1e9;
    return kb / (kb + keff);
  }
  share(g, i, hit, c, owner) {
    if (owner && owner[c / 7] >= 0) { // a free object: the overlap shared by inverse mass at the contact, the object's part moved now
      const k = owner[c / 7], f = this.fref[k * 2], cc = this.fref[k * 2 + 1]; if (!f) return 1;
      const b = f.cb[cc], P = [hit.qx, hit.qy, hit.qz], wo = this.wGen(f, b, P[0] - f.bx[b * 3], P[1] - f.bx[b * 3 + 1], P[2] - f.bx[b * 3 + 2], -hit.nx, -hit.ny, -hit.nz), wr = g.pin[i] ? 0 : g.w[i] * hit.t * hit.t;
      if (wo + wr <= 0) return 0;
      if (wo > 0) f.cts.push(b, P[0], P[1], P[2], -hit.nx, -hit.ny, -hit.nz, 0, 0, 0), f.touch = true; // the same contact treatment as anything else (rebound damping, rolling resistance)
      if (wo > 0 && !f.sleep) { // a contact like any other (split impulse): an impulse only stops it moving into the branch (against a root or a
        // stem too stiff to bend, a fully inelastic stop), and the overlap left is cleared by moving it, which gives it no speed
        const mx = -hit.nx, my = -hit.ny, mz = -hit.nz, vr = (g.v[i * 3] * mx + g.v[i * 3 + 1] * my + g.v[i * 3 + 2] * mz) * hit.t, vf = this.vAt(f, b, P, mx, my, mz);
        if (vf < vr) this.imp(f, b, P, mx, my, mz, (vr - vf) / (wo + wr));
        const R = f.rk, dg = Math.min(hit.pen * wo / (wo + wr), R ? R[b] : Infinity);
        if (dg > 0) { if (R) R[b] -= dg; this.gkick(f, b, P[0] - f.bx[b * 3], P[1] - f.bx[b * 3 + 1], P[2] - f.bx[b * 3 + 2], mx * dg / wo, my * dg / wo, mz * dg / wo); const A = this.all; if (A) for (const e of [0, 3]) { A[c + e] += mx * dg; A[c + e + 1] += my * dg; A[c + e + 2] += mz * dg; } }
      }
      return wr / (wo + wr);
    }
    const ell = Math.max(0.05, g.ell[i] - g.L[i] * (1 - hit.t)), keff = g.pin[i] ? 1e9 : g.k[i] * g.L[i] ** 3 / ell ** 3, kb = this.kb ? this.kb[c / 7] : 1e9;
    const sh = kb / (kb + keff), need = (1 - sh) * hit.pen, D = this.CD, j = c / 7 * 4, A = this.all;
    if (D && need > 1e-6) { // the body part gives way now, within the step: later contacts see it moved, so the rod only ever takes its share
      const mx = -hit.nx * need, my = -hit.ny * need, mz = -hit.nz * need;
      D[j] += mx; D[j + 1] += my; D[j + 2] += mz; D[j + 3] = Math.hypot(D[j], D[j + 1], D[j + 2]);
      if (A) for (const e of [0, 3]) { A[c + e] += mx; A[c + e + 1] += my; A[c + e + 2] += mz; }
    }
    return sh;
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
        const hit = this.hit, b1 = g.pin[i] ? 0 : hit.t, b0 = p >= 0 ? (1 - hit.t) * g.u[i] : 0, den = b0 * b0 + b1 * b1 || 1;
        const sh = this.share(g, i, hit, c, owner), shp = p >= 0 ? this.shareAt(g, p, c, owner) : 0, k1 = hit.pen * sh * b1 / den, k0 = hit.pen * shp * b0 / den;
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
// Build a free object (PhysicsCore.addFree) from a tree of segments. pts: [x,y,z][]; edges: { a, b, r, par } (particle
// indices, radius, parent edge or -1; a child starts at a particle of its parent; parents listed first).
// Where the wood is too stiff for any load here to bend it measurably (joint stiffness κ = EI/L above K_RIGID), or the
// child is a twig too thin to matter, segments are fused into one rigid body; elsewhere a joint joins two bodies with
// compliance 1/κ and breaks past the torque the wood can carry (MOR · health · πr³/4). Bodies are built in world axes
// (orientation identity), so every joint's rest relative orientation is identity.
// wood: { E (GPa), MOR (MPa), rho (kg/m³), dead }. Returns the object, plus seg2body (which body each edge is in).
export const K_RIGID_F = 5e4, TWIG_F = 0.004;
export function makeFree(id, pts, edges, wood, extra = {}) {
  const m = edges.length, E = wood.E * 1e9, MOR = wood.MOR * 1e6, rho = wood.rho ?? 800, health = wood.dead ? 0.45 : 1;
  const L = edges.map((g) => Math.max(1e-4, Math.hypot(pts[g.b][0] - pts[g.a][0], pts[g.b][1] - pts[g.a][1], pts[g.b][2] - pts[g.a][2])));
  const root = edges.map((_, e) => e), find = (e) => (root[e] === e ? e : (root[e] = find(root[e])));
  const kap = edges.map((g, e) => { const p = g.par ?? -1; if (p < 0) return 0; const rr = Math.min(edges[p].r, g.r); return E * Math.PI * rr ** 4 / 4 / ((L[p] + L[e]) / 2); });
  const twig = extra.twig ?? TWIG_F; edges.forEach((g, e) => { const p = g.par ?? -1; if (p >= 0 && (kap[e] > K_RIGID_F || g.r < twig)) root[find(e)] = find(p); });
  const ids = new Map(), seg2body = edges.map((_, e) => { const r = find(e); if (!ids.has(r)) ids.set(r, ids.size); return ids.get(r); });
  const nb = ids.size, bm = new Float32Array(nb), bx = new Float32Array(nb * 3), bq = new Float32Array(nb * 4), bI = new Float32Array(nb * 9);
  const em = edges.map((g, e) => rho * Math.PI * g.r * g.r * L[e] + 0.002);
  edges.forEach((g, e) => { const b = seg2body[e]; bm[b] += em[e]; for (let d = 0; d < 3; d++) bx[b * 3 + d] += em[e] * (pts[g.a][d] + pts[g.b][d]) / 2; });
  for (let b = 0; b < nb; b++) { for (let d = 0; d < 3; d++) bx[b * 3 + d] /= bm[b]; bq[b * 4 + 3] = 1; }
  const I = Array.from({ length: nb }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  edges.forEach((g, e) => { // each segment a solid rod: parallel axis plus its own inertia across and along it
    // (inertia about a thin segment's own axis is floored at a tenth of that across it: a round twig's spin about its axis is
    // invisible, and a million-to-one ratio is more than an iterative solver can hold)
    const b = seg2body[e], A = pts[g.a], B = pts[g.b], c = [0, 1, 2].map((d) => (A[d] + B[d]) / 2 - bx[b * 3 + d]), u = [0, 1, 2].map((d) => (B[d] - A[d]) / L[e]), c2 = c[0] ** 2 + c[1] ** 2 + c[2] ** 2, l2 = L[e] ** 2 / 12, rr = Math.max(g.r * g.r / 4, l2 * 0.05);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[b][i * 3 + j] += em[e] * ((i === j ? c2 + l2 + rr : 0) - c[i] * c[j] - (l2 - rr) * u[i] * u[j]);
  });
  I.forEach((M, b) => { // invert (3x3)
    const [a, b1, c, d, e, f, g, h, i] = M, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b1 * B + c * C || 1e-12;
    bI.set([A / det, -(b1 * i - c * h) / det, (b1 * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b1 * g) / det, (a * e - b1 * d) / det], b * 9);
  });
  const nc = m, cb = Int32Array.from(seg2body), cl = new Float32Array(nc * 6), cr = new Float32Array(nc);
  edges.forEach((g, e) => { const b = seg2body[e]; for (let d = 0; d < 3; d++) { cl[e * 6 + d] = pts[g.a][d] - bx[b * 3 + d]; cl[e * 6 + 3 + d] = pts[g.b][d] - bx[b * 3 + d]; } cr[e] = Math.max(0.004, g.r); });
  const J = []; edges.forEach((g, e) => { const p = g.par ?? -1; if (p >= 0 && seg2body[p] !== seg2body[e]) J.push([seg2body[p], seg2body[e], pts[g.a], kap[e], Math.min(edges[p].r, g.r), [0, 1, 2].map((d) => (pts[g.b][d] - pts[g.a][d]) / L[e])]); });
  const nj = J.length, ja = new Int32Array(nj), jb = new Int32Array(nj), jra = new Float32Array(nj * 3), jrb = new Float32Array(nj * 3), jal = new Float32Array(nj), jtm = new Float32Array(nj);
  const jax = new Float32Array(nj * 3), jr = new Float32Array(nj);
  J.forEach(([a, b, P, k, rr, ax], j) => { ja[j] = a; jb[j] = b; for (let d = 0; d < 3; d++) { jra[j * 3 + d] = P[d] - bx[a * 3 + d]; jrb[j * 3 + d] = P[d] - bx[b * 3 + d]; } jal[j] = 1 / Math.max(k, 1e-6); jtm[j] = MOR * health * Math.PI * rr ** 3 / 4; jax.set(ax, j * 3); jr[j] = rr; });
  return { id, nb, bx, bq, bm, bI, nc, cb, cl, cr, nj, ja, jb, jra, jrb, jal, jtm, jax, jr, dry: wood.dead ? 1 : 0, mu: 0.6, mass: bm.reduce((a, b) => a + b, 0), seg2body, ...extra };
}

// the worker's program: the class above plus a message loop
export function workerSource() {
  return `const BREAK_R = ${BREAK_R}, SOIL = ${SOIL}, WOOD = ${WOOD}, CRR_SOIL = ${CRR_SOIL}, CRR_WOOD = ${CRR_WOOD}, MU_SOIL = ${MU_SOIL}, MU_WOOD = ${MU_WOOD}, SLOP = ${SLOP}, DEP = ${DEP}, VMAX = ${VMAX}, WMAX = ${WMAX}, WDEP = ${WDEP};
${PhysicsCore.toString()}
const core = new PhysicsCore();
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'add') core.add(m.g);
  else if (m.type === 'remove') core.remove(m.id);
  else if (m.type === 'reset') { core.groups.clear(); core.free.clear(); }
  else if (m.type === 'free') core.addFree(m.f);
  else if (m.type === 'freeRemove') core.free.delete(m.id);
  else if (m.type === 'freeWorld') { const f = core.free.get(m.id); if (f) { f.hf = m.hf; f.statics = m.statics; } }
  else if (m.type === 'step') { const r = core.step(m.dt, m.caps, m.prev, m.kb, m.mb, m.forces); postMessage({ type: 'state', ...r }, [...r.groups.map((g) => g.disp.buffer), ...r.free.flatMap((f) => [f.x.buffer, f.q.buffer])]); }
};`;
}

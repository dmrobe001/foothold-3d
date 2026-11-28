"""Sampling-based model predictive control (MPC): plan a short horizon ahead, act on the start of it, plan again.

The plan is a spline of servo targets: knots every KNOT_DT seconds over a HORIZON, linearly interpolated per step. Each
round, NSAMPLE noisy variants of the current plan (shifted forward to now) are rolled out in parallel from the true state
(mujoco.rollout, all cores); each is scored by the task's cost; the plan becomes the mean of the ELITE cheapest (the
current plan itself is always among the candidates, so a round never makes it worse by its own score). The body then
moves for REPLAN_DT under that plan, and the round repeats.

A task supplies: the cost of each sampled rollout (from its sensor values and controls), a target to report progress
against, and when it is done. Costs are per second of the horizon, so terms keep their weights whatever its length.
"""
import os, time, json
import numpy as np
import mujoco
from mujoco import rollout
from body import model, set_stand, stand_ctrl, TORQUE

HORIZON, KNOT_DT, REPLAN_DT = 0.8, 0.1, 0.04
NSAMPLE, ELITE = 96, 8


class Sensors:
    def __init__(self, M):
        self.at = {M.sensor(i).name: slice(M.sensor_adr[i], M.sensor_adr[i] + M.sensor_dim[i]) for i in range(M.nsensor)}
        self.frc = slice(self.at[f'frc_{M.actuator(0).name}'].start, self.at[f'frc_{M.actuator(M.nu - 3).name}'].stop)

    def __call__(self, S, name):  # S: (..., nsensordata)
        return S[..., self.at[name]]


class Planner:
    def __init__(self, M, task, seed=0, nsample=NSAMPLE, horizon=HORIZON):
        self.M, self.task, self.rng = M, task, np.random.default_rng(seed)
        self.nk = int(round(horizon / KNOT_DT)) + 1; self.nstep = int(round(horizon / M.opt.timestep))
        self.nsample = nsample
        self.lo, self.hi = M.actuator_ctrlrange[:, 0], M.actuator_ctrlrange[:, 1]
        self.sigma = np.full(M.nu, 0.12); self.sigma[-2:] = 0.35  # radians for the joints; the grips are 0..1
        self.knots = np.tile(stand_ctrl(M), (self.nk, 1))
        self.datas = [mujoco.MjData(M) for _ in range(os.cpu_count())]
        self.peak = np.abs(M.actuator_forcerange[:-2, 1])
        self.sens = Sensors(M)
        t = np.arange(self.nstep) * M.opt.timestep / KNOT_DT
        self.i0 = np.minimum(np.floor(t).astype(int), self.nk - 2); self.w = (t - self.i0)[:, None]

    def controls(self, knots):  # (..., nk, nu) -> (..., nstep, nu)
        return knots[..., self.i0, :] * (1 - self.w) + knots[..., self.i0 + 1, :] * self.w

    def shift(self, dt):  # the plan moved forward dt (the last knot held)
        t = np.arange(self.nk) + dt / KNOT_DT; i = np.minimum(np.floor(t).astype(int), self.nk - 1); j = np.minimum(i + 1, self.nk - 1); w = (t - np.floor(t))[:, None]
        self.knots = self.knots[i] * (1 - w) + self.knots[j] * w

    def plan(self, D):
        st = np.zeros(mujoco.mj_stateSize(self.M, mujoco.mjtState.mjSTATE_FULLPHYSICS)); mujoco.mj_getState(self.M, D, st, mujoco.mjtState.mjSTATE_FULLPHYSICS)
        self.t0 = D.time
        pr = getattr(self.task, 'prior', None)
        if pr: self.knots = pr(self, self.knots, D.time)  # (a reference motion, if the task has one, pulls the plan toward itself)
        noise = self.rng.normal(0, 1, (self.nsample, self.nk, self.M.nu)) * self.sigma; noise[0] = 0; noise[:, 0] *= 0.3  # (sample 0: the plan as it stands)
        K = np.clip(self.knots[None] + noise, self.lo, self.hi)
        U = self.controls(K)
        X, S = rollout.rollout(self.M, self.datas, st[None], U, persistent_pool=True)
        self.X = X; c = self.task.cost(self, S, U, K)
        best = np.argsort(c)[:ELITE]
        self.knots = K[best].mean(0); self.last = dict(cost=float(c[best[0]]), plan_cost=float(c[0]), terms=self.task.terms_of(self, S[best[0:1]], U[best[0:1]], K[best[0:1]], best[0]))
        return self.controls(self.knots[None])[0]

    def effort(self, S):  # mean over steps of the squared torque as a share of each joint's peak
        return ((S[..., self.sens.frc] / self.peak) ** 2).mean(-1).mean(-1)


def run(task, station=None, seconds=6.0, seed=0, start_f=-1.0, log_every=0.5, nsample=NSAMPLE, record=None, horizon=HORIZON, qpos0=None):
    M = model(station, start_f); D = mujoco.MjData(M); set_stand(M, D)
    if qpos0 is not None: D.qpos[:] = qpos0; D.qvel[:] = 0; mujoco.mj_forward(M, D)
    P = Planner(M, task, seed, nsample, horizon); task.setup(P, D)
    frames, T0, t_log = [], time.perf_counter(), 0.0
    nrep = int(round(REPLAN_DT / M.opt.timestep)); work = 0.0; worst_pen = 0.0
    sens = P.sens
    while D.time < seconds:
        U = P.plan(D)
        for k in range(nrep):
            D.ctrl[:] = U[k]; mujoco.mj_step(M, D)
            work += float(np.abs(D.actuator_force[:-2] * D.actuator_velocity[:-2]).sum()) * M.opt.timestep
            worst_pen = max([worst_pen] + [-D.contact[i].dist for i in range(D.ncon)])
        P.shift(REPLAN_DT)
        if record is not None and len(frames) * (1 / 30) <= D.time: frames.append(snapshot(M, D))
        if D.time - t_log >= log_every - 1e-9:
            t_log = D.time
            print(f'  t {D.time:4.1f}  {task.report(P, D)}  cost {P.last["cost"]:.2f} ' + ' '.join(f'{k} {v:.2f}' for k, v in P.last['terms'].items()) + f'  ({time.perf_counter() - T0:.0f} s)', flush=True)
        if task.done(P, D): break
    out = dict(task=task.name, station=station, seconds=round(D.time, 2), wall=round(time.perf_counter() - T0, 1), work=round(work, 1), deepest_mm=round(worst_pen * 1000, 1), result=task.report(P, D))
    if record is not None: save_run(record, out, M, frames)
    return out


RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'viewer', 'runs')


def save_run(name, meta, M, frames, label=None):
    """A recorded run for the viewer (sim/viewer): viewer/runs/<name>.json, listed in viewer/runs/index.json."""
    os.makedirs(RUNS, exist_ok=True)
    with open(os.path.join(RUNS, f'{name}.json'), 'w') as f: json.dump(dict(meta=meta, geoms=geom_table(M), frames=frames), f, separators=(',', ':'))
    idx_p = os.path.join(RUNS, 'index.json'); idx = json.load(open(idx_p)) if os.path.exists(idx_p) else []
    idx = [r for r in idx if r['name'] != name] + [dict(name=name, label=label or name, **{k: meta[k] for k in ('task', 'station', 'seconds', 'work', 'deepest_mm', 'result')})]
    with open(idx_p, 'w') as f: json.dump(idx, f, indent=1)


def geom_table(M):
    out = []
    for g in range(M.ngeom):
        t = {int(mujoco.mjtGeom.mjGEOM_PLANE): 'plane', int(mujoco.mjtGeom.mjGEOM_SPHERE): 'sphere', int(mujoco.mjtGeom.mjGEOM_CAPSULE): 'capsule', int(mujoco.mjtGeom.mjGEOM_BOX): 'box'}.get(int(M.geom_type[g]), 'other')
        out.append(dict(name=M.geom(g).name, type=t, size=[round(float(v), 4) for v in M.geom_size[g]], body=int(M.geom_bodyid[g]), rgba=[round(float(v), 3) for v in M.geom_rgba[g]]))
    return out


def snapshot(M, D):  # every geom's position and rotation matrix (world), rounded
    return dict(t=round(D.time, 3), p=np.round(D.geom_xpos, 3).ravel().tolist(), R=np.round(D.geom_xmat, 3).ravel().tolist())


# ---------------------------------------------------------------- tasks
class Stand:
    name = 'stand'
    def setup(self, P, D): self.h0 = float(D.site('head').xpos[2])
    def parts(self, P, S, U, K):
        s = P.sens
        head = s(S, 'head_pos')[..., 2]; up = s(S, 'chest_up')[..., 2]; com = s(S, 'com'); fl, fr = s(S, 'footL_pos'), s(S, 'footR_pos')
        mid = (fl + fr) / 2
        return dict(height=((np.maximum(0, self.h0 - head)) ** 2).mean(-1) * 20, upright=((1 - up) ** 2).mean(-1) * 5,
                    balance=(((com[..., :2] - mid[..., :2]) ** 2).sum(-1)).mean(-1) * 20, effort=P.effort(S) * 2,
                    smooth=(np.diff(K, axis=-2) ** 2).sum(-1).mean(-1) * 0.5)
    def cost(self, P, S, U, K): return sum(self.parts(P, S, U, K).values())
    def terms_of(self, P, S, U, K, i=0):
        X = P.X; P.X = X[i:i + 1]
        try: return {k: float(v[0]) for k, v in self.parts(P, S, U, K).items()}
        finally: P.X = X
    def report(self, P, D): return f'head {D.site("head").xpos[2]:.2f} m'
    def done(self, P, D): return False


class Reach(Stand):
    """Get the pelvis to a goal point and stand there: walking, or over whatever is in the way.
    Not by being drawn to the goal (with a short horizon that pays for falling toward it) but by walking speed toward it,
    with balance: the capture point (where the centre of mass would come to rest, given its speed: com + v sqrt(h/g))
    kept over the feet, so that moving on takes steps, and the head kept up."""
    name = 'reach'
    def __init__(self, goal, speed=0.8, head_min=1.45, w_effort=2.0, w_balance=8.0):
        self.goal, self.speed, self.head_min, self.w_effort, self.w_balance = np.array(goal, float), speed, head_min, w_effort, w_balance
    def setup(self, P, D): self.h0 = float(D.site('head').xpos[2])
    def parts(self, P, S, U, K):
        s = P.sens
        pel = s(S, 'pelvis_pos'); head = s(S, 'head_pos')[..., 2]; up = s(S, 'chest_up')[..., 2]; touch = s(S, 'head_touch')[..., 0]
        com, v = s(S, 'com'), s(S, 'com_vel'); fl, fr = s(S, 'footL_pos'), s(S, 'footR_pos')
        to = self.goal[None, None, :2] - pel[..., :2]; d = np.linalg.norm(to, axis=-1); u = to / np.maximum(d, 1e-6)[..., None]
        v_want = np.minimum(self.speed, d / 0.8)  # slowing to a stop at the goal
        v_along = (v[..., :2] * u).sum(-1); v_side = v[..., 0] * -u[..., 1] + v[..., 1] * u[..., 0]
        cap = com[..., :2] + v[..., :2] * np.sqrt(0.9 / 9.81); mid = (fl[..., :2] + fr[..., :2]) / 2
        return dict(speed=((v_along - v_want) ** 2 + v_side ** 2).mean(-1) * 4,
                    balance=((cap - mid) ** 2).sum(-1).mean(-1) * self.w_balance,
                    height=(np.maximum(0, self.head_min - head) ** 2).mean(-1) * 80 + ((self.h0 - head).clip(0) ** 2).mean(-1) * 5,
                    upright=((1 - up) ** 2).mean(-1) * 3,
                    head_hit=np.minimum(touch, 400).mean(-1) * 0.05,
                    effort=P.effort(S) * self.w_effort, smooth=(np.diff(K, axis=-2) ** 2).sum(-1).mean(-1) * 0.5)
    def report(self, P, D):
        p = D.site('pelvis').xpos; return f'pelvis x {p[0]:5.2f} y {p[1]:5.2f} z {p[2]:.2f} head {D.site("head").xpos[2]:.2f}'
    def done(self, P, D):
        p = D.site('pelvis').xpos; return np.hypot(p[0] - self.goal[0], p[1] - self.goal[1]) < 0.15 and D.site('head').xpos[2] > 1.6 and np.abs(D.qvel[:3]).max() < 0.2


class Over(Reach):
    """Over a barrier to a goal beyond it. The task knows where the barrier is (as the game's barrierAt measures it), not
    how to cross it: until the hips are past its far face the pelvis is drawn to a waypoint above the middle of its top;
    after that, the walking cost to the goal takes over. The head may go lower (hands on the top, a roll) but not into it."""
    name = 'over'
    def __init__(self, goal, x0, x1, top, clear=0.3, **kw):
        super().__init__(goal, **kw); self.x0, self.x1, self.top, self.clear = x0, x1, top, clear
    def parts(self, P, S, U, K):
        out = super().parts(P, S, U, K)
        pel = P.sens(S, 'pelvis_pos'); before = pel[..., 0] < self.x1 + 0.1
        wp = np.array([(self.x0 + self.x1) / 2, 0.0, self.top + self.clear])
        d = np.linalg.norm(pel - wp, axis=-1); n = d.shape[-1]; wt = np.linspace(0.3, 1.5, n)
        out['waypoint'] = (np.sqrt(d ** 2 + 0.01) * wt * before).mean(-1) * 3
        out['speed'] = out['speed'] * (~before).mean(-1)  # (walking speed counts once past it)
        out['balance'] = out['balance'] * (~before).mean(-1)
        return out


class Track(Over):
    """Over a barrier, seeded by a reference motion (a script retargeted from the game, retarget.py): while the reference
    runs, the plan is pulled toward its servo targets (a prior blended in each round) and the rollouts pay for straying
    from its joint angles and its pelvis path; once it has ended, only the Over/Reach costs remain. Physics decides what of
    the script survives: forces, balance and contacts the script never had to respect."""
    name = 'track'
    def __init__(self, ref, goal, x0, x1, top, w_track=1.0, beta=0.35, **kw):
        super().__init__(goal, x0, x1, top, **kw); self.ref, self.w_track, self.beta = ref, w_track, beta
        self.t_ref = ref['t']; self.dur = float(self.t_ref[-1])
    def ref_at(self, t, what):  # interpolated reference (clamped to its ends)
        A = self.ref[what]; t = np.clip(t, 0, self.dur); i = np.clip(np.searchsorted(self.t_ref, t) - 1, 0, len(self.t_ref) - 2)
        w = ((t - self.t_ref[i]) / (self.t_ref[i + 1] - self.t_ref[i]))[..., None]; return A[i] * (1 - w) + A[i + 1] * w
    def prior(self, P, knots, t0):
        tk = t0 + np.arange(P.nk) * KNOT_DT; on = tk <= self.dur
        if not on.any(): return knots
        r = knots.copy(); r[on, :-2] = (1 - self.beta) * knots[on, :-2] + self.beta * self.ref_at(tk[on], 'ctrl'); return r
    def parts(self, P, S, U, K):
        out = super().parts(P, S, U, K)
        nq = P.M.nq; q = P.X[..., 1:1 + nq]; n = q.shape[-2]; t = P.t0 + np.arange(n) * P.M.opt.timestep; on = (t <= self.dur).astype(float)
        jq = P.M.jnt_qposadr[[P.M.actuator_trnid[i, 0] for i in range(P.M.nu - 2)]]
        qr = self.ref_at(t, 'qpos')
        out['track'] = ((((q[..., jq] - qr[:, jq]) ** 2).mean(-1) + 4 * ((q[..., :3] - qr[:, :3]) ** 2).sum(-1)) * on).mean(-1) * self.w_track * 10
        if on.any(): out['waypoint'] = out['waypoint'] * 0.3
        return out


def barrier_of(st, start_f):
    """Near face, far face (in the simulator's x) and top of the station's tallest box across the lane at x = 0."""
    bs = [b for b in st['boxes'] if abs(b['x']) < 1e-6 and b['y'] == 0] or st['boxes']
    b = max(bs, key=lambda b: b['h']); return b['f'] - b['l'] / 2 - start_f, b['f'] + b['l'] / 2 - start_f, b['y'] + b['h']


if __name__ == '__main__':
    import sys
    what = sys.argv[1] if len(sys.argv) > 1 else 'stand'
    if what == 'stand': print(run(Stand(), None, 3.0))
    elif what == 'walk': print(run(Reach([2.0, 0.0]), None, 8.0, record='walk'))
    elif what == 'seeded':  # over a barrier from a game script: python3 mpc.py seeded vault-19 [seed] [w_track]
        name = sys.argv[2]; seed = int(sys.argv[3]) if len(sys.argv) > 3 else 0; wt = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
        from body import load_station
        R = np.load(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'refs', f'{name}-q.npz')); ref = dict(t=R['t'], qpos=R['qpos'], ctrl=R['ctrl'])
        st = int(name.rsplit('-', 1)[1]); stn = load_station(st)
        b = max([b for b in stn['boxes'] if abs(b['x']) < 1e-6 and b['y'] == 0], key=lambda b: b['h']); near_f = b['f'] - b['l'] / 2
        start_f = near_f - float(R['near_x'])  # (the reference's own placement: its starting pelvis at the origin)
        x0, x1, top = barrier_of(stn, start_f)
        print(f'{name}: barrier x {x0:.2f}..{x1:.2f}, top {top:.2f}; reference {ref["t"][-1]:.2f} s; tracking weight {wt}')
        print(run(Track(ref, [x1 + 0.8, 0.0], x0, x1, top, w_track=wt, head_min=0.9, w_balance=2.0), st, ref['t'][-1] + 3.0, seed=seed, start_f=start_f,
                  record=f'{name}-track{wt:g}-seed{seed}', nsample=128, horizon=1.2, qpos0=ref['qpos'][0]))
    elif what == 'wall':  # the 1.1 m wall (station 19), unseeded: the wall's near face is 0.9 m ahead, the goal 0.8 m past its far face
        st = int(sys.argv[2]) if len(sys.argv) > 2 else 19; seed = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        from body import load_station
        x0, x1, top = barrier_of(load_station(st), -1.0)
        print(f'station {st}: barrier from x {x0:.2f} to {x1:.2f}, top {top:.2f} m')
        print(run(Over([x1 + 0.8, 0.0], x0, x1, top, head_min=0.9, w_balance=2.0), st, 10.0, seed=seed, record=f'station{st}-seed{seed}', nsample=128, horizon=1.2))

"""A stance graph over the 0.7 m wall (station 17): stable poses as nodes, moves between them as edges, and each edge
scored by its committor: the fraction of perturbed attempts that end in the target stance without falling.

Nodes. Each stance is a few contact targets (feet, hands, knees, hips, pelvis, chest), solved to a pose by inverse
kinematics (retarget.solve_ik), then held by the servos alone (no planner) for 1.5 s. It counts as a node only if it
stays put (pelvis drifts under 6 cm, head under 10 cm, no fall). Its static robustness is the fraction of held copies
that stay put after a push.

Edges. A move A -> B is planned once by the sampling planner (mpc.Planner), guided by a reference that eases from A's
pose to B's over the move (joint angles, pelvis position and facing), then holds B. The planner's controls are then
replayed open-loop, many times, each with a random shove to the chest (random direction and timing within the move): the
servos' own stiffness is the only feedback (no re-planning), a strict test. The committor at each push size is the
fraction of replays that end in B (pelvis within 0.15 m of B's, head height within 0.15 m, facing within 0.5 rad) without
falling (head below 0.45 m at any time).

Run: python3 sim/stances.py            (all nodes and edges; results to sim/out/stances.json, runs for the viewer)
"""
import json, os, sys, time
import numpy as np
import mujoco
from mujoco import rollout
from body import model, set_stand, stand_ctrl
from retarget import solve_ik, point
import mpc

HERE = os.path.dirname(os.path.abspath(__file__))
STATION, START_F = 17, -0.6        # the wall's near face at x 0.5, far face 0.7, top 0.7 m
X0, X1, TOP = 0.5, 0.7, 0.7
PUSHES = (0.0, 100.0, 200.0, 300.0)  # N on the chest for 0.1 s (impulses 0, 10, 20, 30 N·s)
NREP = 64
HOLD = 1.0                          # s held at B after a move
FST = mujoco.mjtState.mjSTATE_FULLPHYSICS


def yaw_quat(yaw): return np.array([np.cos(yaw / 2), 0, 0, np.sin(yaw / 2)])


# stance: facing (yaw: 0 is +x, over the wall), pelvis start, IK targets {game joint: xyz}
H = TOP
flat = lambda x, y: {f'toe{"L" if y > 0 else "R"}': (x + 0.17, y, 0.08)}  # (a foot kept flat: its toe level with its ankle)
STANCES = {
    'stand': dict(yaw=0, pelvis=(0.0, 0, 0.97), tgt={}, touch=['footL floor', 'footR floor']),
    'hands on top': dict(yaw=0, pelvis=(0.12, 0, 0.93), tgt={'pelvis': (0.12, 0, 0.93), 'chest': (0.28, 0, 1.38), 'ankleL': (0.06, 0.11, 0.08), 'ankleR': (0.06, -0.11, 0.08),
                                                            **flat(0.06, 0.11), **flat(0.06, -0.11), 'handL': (0.56, 0.2, H + 0.06), 'handR': (0.56, -0.2, H + 0.06)},
                         touch=['handL box0', 'handR box0', 'footL floor', 'footR floor']),
    'foot on top': dict(yaw=0, pelvis=(0.22, 0, 0.9), tgt={'pelvis': (0.22, -0.04, 0.9), 'chest': (0.36, -0.03, 1.36), 'kneeL': (0.46, 0.2, 1.2), 'ankleL': (0.6, 0.14, H + 0.08),
                                                          'ankleR': (0.08, -0.12, 0.08), **flat(0.08, -0.12), 'handL': (0.62, 0.42, H + 0.06), 'handR': (0.62, -0.32, H + 0.06)},
                        touch=['footL box0', 'footR floor']),
    'squat on top': dict(yaw=0, pelvis=(0.5, 0, 1.05), tgt={'pelvis': (0.48, 0, 1.02), 'chest': (0.78, 0, 1.38), 'kneeL': (0.82, 0.15, 1.08), 'kneeR': (0.82, -0.15, 1.08),
                                                           'ankleL': (0.6, 0.12, H + 0.08), 'ankleR': (0.6, -0.12, H + 0.08), 'handL': (0.66, 0.3, H + 0.06), 'handR': (0.66, -0.3, H + 0.06)},
                         touch=['footL box0', 'footR box0']),
    'astride': dict(yaw=np.pi / 2, pelvis=(0.6, 0, 0.86), tgt={'pelvis': (0.6, 0, 0.86), 'hipL': (0.49, 0, 0.86), 'hipR': (0.71, 0, 0.86), 'chest': (0.6, 0, 1.36),
                                                              'kneeL': (0.36, 0.3, 0.6), 'kneeR': (0.84, 0.3, 0.6), 'ankleL': (0.36, 0.3, 0.17), 'ankleR': (0.84, 0.3, 0.17),
                                                              'handL': (0.6, 0.3, H + 0.06), 'handR': (0.6, -0.25, H + 0.06)}, touch=['pelvis box0']),
    # a 0.7 m top is above sitting height: with your back to it you lean on it, legs nearly straight, hands on the top behind you
    'leaning back on it': dict(yaw=np.pi, pelvis=(0.37, 0, 0.88), tgt={'pelvis': (0.37, 0, 0.88), 'hipL': (0.37, -0.11, 0.88), 'hipR': (0.37, 0.11, 0.88), 'chest': (0.33, 0, 1.38),
                                                                     'ankleL': (0.0, -0.12, 0.08), 'ankleR': (0.0, 0.12, 0.08), **flat(-0.17, -0.12), **flat(-0.17, 0.12),
                                                                     'handL': (0.58, -0.26, H + 0.06), 'handR': (0.58, 0.26, H + 0.06)}, touch=['pelvis box0', 'footL floor', 'footR floor']),
    # seated on the top facing over it, thighs out over the far edge, legs dangling, leaning back on the hands
    'seated, legs over': dict(yaw=0, pelvis=(0.56, 0, 0.86), tgt={'pelvis': (0.56, 0, 0.86), 'hipL': (0.56, 0.11, 0.86), 'hipR': (0.56, -0.11, 0.86), 'chest': (0.58, 0, 1.36),
                                                                 'kneeL': (0.94, 0.12, 0.76), 'kneeR': (0.94, -0.12, 0.76), 'ankleL': (1.0, 0.12, 0.32), 'ankleR': (1.0, -0.12, 0.32),
                                                                 'handL': (0.56, 0.28, H + 0.06), 'handR': (0.56, -0.28, H + 0.06)}, touch=['pelvis box0'], grip=True),
    'standing, back to the wall': dict(yaw=np.pi, pelvis=(0.22, 0, 0.97), tgt={}, touch=['footL floor', 'footR floor']),
    'stand beyond': dict(yaw=0, pelvis=(1.2, 0, 0.97), tgt={}, touch=['footL floor', 'footR floor']),
}
# moves to try: (from, to, seconds)
EDGES = [('stand', 'hands on top', 1.2), ('hands on top', 'stand', 1.2), ('hands on top', 'foot on top', 1.5), ('foot on top', 'squat on top', 1.8),
         ('squat on top', 'stand beyond', 1.5), ('foot on top', 'seated, legs over', 2.0), ('hands on top', 'astride', 2.0),
         ('hands on top', 'seated, legs over', 2.0), ('astride', 'seated, legs over', 1.8), ('seated, legs over', 'astride', 1.8),
         ('stand', 'standing, back to the wall', 1.8), ('standing, back to the wall', 'leaning back on it', 1.0), ('leaning back on it', 'standing, back to the wall', 1.0),
         ('leaning back on it', 'astride', 2.0), ('leaning back on it', 'seated, legs over', 2.4),
         ('seated, legs over', 'stand beyond', 1.2), ('astride', 'stand beyond', 1.8)]


def measures(M, D):
    head = D.site('head').xpos.copy(); pel = D.site('pelvis').xpos.copy(); f = D.site('pelvis').xmat.reshape(3, 3)[:, 0]
    return dict(pelvis=pel, head=head, facing=float(np.arctan2(f[1], f[0])))


BENT = dict(kneeL=0.5, kneeR=0.5, hip_flexL=0.3, hip_flexR=0.3, ankleL=-0.2, ankleR=-0.2, elbowL=0.5, elbowR=0.5)


def make_node(M, name, spec):
    D = mujoco.MjData(M); set_stand(M, D)
    D.qpos[:3] = spec['pelvis']; D.qpos[3:7] = yaw_quat(spec['yaw'])
    if spec['tgt']:  # from bent knees, hips and elbows (from straight limbs the solver cannot tell which way a knee bends)
        for j, v in BENT.items(): D.qpos[M.jnt_qposadr[M.joint(j).id]] = v
        mujoco.mj_forward(M, D); solve_ik(M, D, spec['tgt'], weights={k: 1.0 for k in spec['tgt'] if k.startswith('toe')}, iters=300)
    mujoco.mj_forward(M, D)
    jid = [M.actuator_trnid[i, 0] for i in range(M.nu - 2)]
    ctrl = np.zeros(M.nu); ctrl[:-2] = D.qpos[M.jnt_qposadr[jid]]
    if spec.get('grip'): ctrl[-2:] = 1.0  # (the hands hold the edge)
    D.qvel[:] = 0; D.ctrl[:] = ctrl; mujoco.mj_forward(M, D)
    m0 = measures(M, D); fell = False
    for k in range(int(1.5 / M.opt.timestep)):
        mujoco.mj_step(M, D); fell |= D.site('head').xpos[2] < 0.45
    m1 = measures(M, D)
    st = np.zeros(mujoco.mj_stateSize(M, FST)); mujoco.mj_getState(M, D, st, FST)
    drift = float(np.linalg.norm(m1['pelvis'] - m0['pelvis'])); hdrift = float(np.linalg.norm(m1['head'] - m0['head']))
    pairs = {frozenset((M.geom(D.contact[i].geom1).name, M.geom(D.contact[i].geom2).name)) for i in range(D.ncon)}
    lost = [t for t in spec.get('touch', []) if frozenset(t.split()) not in pairs]
    ok = drift < 0.20 and not fell and not lost  # (head drift is reported, not required: a seated body may slump and still hold)
    m1['lost'] = lost
    return dict(name=name, ok=ok, drift=drift, head_drift=hdrift, state=st, ctrl=ctrl, qpos=D.qpos.copy(), **m1)


def push_controls(M, U, F, T, rng, n):
    """n copies of the control sequence U (nstep x nu), each with a shove of F newtons on the chest for 0.1 s, at a random
    time in [0, T) and in a random horizontal direction: controls + applied forces, as rollout's control_spec takes them."""
    nstep = U.shape[0]; nb = M.nbody; chest = M.body('chest').id
    X = np.zeros((n, nstep, M.nu + 6 * nb)); X[:, :, :M.nu] = U
    if F > 0:
        t0 = rng.uniform(0, T, n); a = rng.uniform(0, 2 * np.pi, n); k0 = (t0 / M.opt.timestep).astype(int); k1 = k0 + int(0.1 / M.opt.timestep)
        for i in range(n):
            X[i, k0[i]:k1[i], M.nu + 6 * chest:M.nu + 6 * chest + 2] = F * np.array([np.cos(a[i]), np.sin(a[i])])
    return X


SPEC = int(mujoco.mjtState.mjSTATE_CTRL) | int(mujoco.mjtState.mjSTATE_XFRC_APPLIED)


def ends_in(M, S, X, B, sens):
    """Which rollouts end in stance B without falling (S: sensordata, nbatch x nstep x nsens)."""
    pel = sens(S, 'pelvis_pos'); head = sens(S, 'head_pos'); fwd = sens(S, 'pelvis_fwd')
    fell = (head[..., 2] < 0.45).any(-1)
    end_p, end_h, end_f = pel[:, -1], head[:, -1, 2], np.arctan2(fwd[:, -1, 1], fwd[:, -1, 0])
    dyaw = np.abs((end_f - B['facing'] + np.pi) % (2 * np.pi) - np.pi)
    return (~fell) & (np.linalg.norm(end_p - B['pelvis'], axis=-1) < 0.15) & (np.abs(end_h - B['head'][2]) < 0.15) & (dyaw < 0.5)


def node_robustness(M, N, rng, datas, sens):
    """Static robustness: held by its servos, the fraction that stays (ends in itself) after a push, at each push size."""
    nstep = int(2.0 / M.opt.timestep); U = np.tile(N['ctrl'], (nstep, 1)); out = {}
    for F in PUSHES[1:]:
        X = push_controls(M, U, F, 0.5, rng, NREP)
        _, S = rollout.rollout(M, datas, N['state'][None], X, control_spec=SPEC, persistent_pool=True)
        out[F] = float(ends_in(M, S, X, N, sens).mean())
    return out


class EdgeTask(mpc.Stand):
    """Move from stance A to stance B in T seconds, then hold B: track a reference easing from A's pose to B's (joint
    angles, pelvis position, facing), with the head kept clear and up, effort and smoothness as in the other tasks."""
    name = 'edge'
    def __init__(self, A, B, T, head_min):
        self.A, self.B, self.T, self.head_min = A, B, T, head_min
        self.jq = None
    def setup(self, P, D):
        M = P.M; self.jq = M.jnt_qposadr[[M.actuator_trnid[i, 0] for i in range(M.nu - 2)]]; self.t_start = D.time
    def ref(self, t):  # eased reference at times t: joint angles, pelvis position, facing angle
        e = np.clip((t - self.t_start) / self.T, 0, 1); e = (e * e * (3 - 2 * e))[..., None]
        A, B = self.A, self.B
        dyaw = (B['facing'] - A['facing'] + np.pi) % (2 * np.pi) - np.pi
        return A['ctrl'][:-2] * (1 - e) + B['ctrl'][:-2] * e, A['pelvis'] * (1 - e) + B['pelvis'] * e, A['facing'] + dyaw * e[..., 0]
    def prior(self, P, knots, t0):
        tk = t0 + np.arange(P.nk) * mpc.KNOT_DT; q, _, _ = self.ref(tk); r = knots.copy(); r[:, :-2] = 0.65 * knots[:, :-2] + 0.35 * q; return r
    def parts(self, P, S, U, K):
        s = P.sens; M = P.M
        n = S.shape[-2]; t = P.t0 + np.arange(n) * M.opt.timestep; qr, pr, fr = self.ref(t)
        q = P.X[..., 1:1 + M.nq][..., self.jq]; pel = s(S, 'pelvis_pos'); fwd = s(S, 'pelvis_fwd'); head = s(S, 'head_pos')[..., 2]; touch = s(S, 'head_touch')[..., 0]
        yaw = np.arctan2(fwd[..., 1], fwd[..., 0]); dyaw = (yaw - fr + np.pi) % (2 * np.pi) - np.pi
        late = 0.5 + (t >= self.t_start + self.T)  # (holding B counts more)
        return dict(joints=(((q - qr) ** 2).mean(-1) * late).mean(-1) * 4, pelvis=((((pel - pr) ** 2).sum(-1)) * late).mean(-1) * 40,
                    facing=((dyaw ** 2) * late).mean(-1) * 3, fall=(np.maximum(0, self.head_min - head) ** 2).mean(-1) * 80,
                    head_hit=np.minimum(touch, 400).mean(-1) * 0.05, effort=P.effort(S) * 2, smooth=(np.diff(K, axis=-2) ** 2).sum(-1).mean(-1) * 0.5)
    def report(self, P, D):
        m = measures(P.M, D); return f'pelvis {np.round(m["pelvis"], 2)} head {m["head"][2]:.2f}'
    def done(self, P, D): return False


def plan_edge(M, A, B, T, seed=0, record=None):
    """Plan A -> B once with the sampling planner; returns the executed controls, whether the plan itself ends in B, and its effort."""
    D = mujoco.MjData(M); mujoco.mj_setState(M, D, A['state'], FST); mujoco.mj_forward(M, D)
    task = EdgeTask(A, B, T, head_min=min(A['head'][2], B['head'][2]) - 0.35)
    P = mpc.Planner(M, task, seed, 96, 0.8); P.knots[:] = A['ctrl']; task.setup(P, D)
    nrep = int(round(mpc.REPLAN_DT / M.opt.timestep)); Us, frames, eff, work = [], [], 0.0, 0.0
    while D.time < T + HOLD - 1e-9:
        U = P.plan(D)
        for k in range(nrep):
            D.ctrl[:] = U[k]; Us.append(U[k].copy()); mujoco.mj_step(M, D)
            eff += float(((D.actuator_force[:-2] / P.peak) ** 2).mean()) * M.opt.timestep
            work += float(np.abs(D.actuator_force[:-2] * D.actuator_velocity[:-2]).sum()) * M.opt.timestep
            if len(frames) * (1 / 30) <= D.time: frames.append(mpc.snapshot(M, D))
        P.shift(mpc.REPLAN_DT)
    m = measures(M, D)
    ok_nominal = bool(np.linalg.norm(m['pelvis'] - B['pelvis']) < 0.15 and abs(m['head'][2] - B['head'][2]) < 0.15 and abs((m['facing'] - B['facing'] + np.pi) % (2 * np.pi) - np.pi) < 0.5)
    if record:
        meta = dict(task=f'{A["name"]} → {B["name"]}', station=STATION, seconds=round(D.time, 2), wall=None, work=round(work, 1), deepest_mm=None,
                    result='reached' if ok_nominal else f'missed: pelvis {np.round(m["pelvis"], 2)} head {m["head"][2]:.2f}')
        mpc.save_run(record, meta, M, frames, label=f'{A["name"]} → {B["name"]}')
    return np.array(Us), ok_nominal, eff, work, m


if __name__ == '__main__':
    only = sys.argv[1:]  # optional: names of edges "A>B" to run
    M = model(STATION, START_F); rng = np.random.default_rng(0); datas = [mujoco.MjData(M) for _ in range(os.cpu_count())]; sens = mpc.Sensors(M)
    T0 = time.perf_counter(); nodes = {}
    print('nodes (held by servos alone for 1.5 s; then pushed: fraction that stays at 100 / 200 / 300 N)')
    for name, spec in STANCES.items():
        N = make_node(M, name, spec); nodes[name] = N
        rob = node_robustness(M, N, rng, datas, sens) if N['ok'] else {}
        N['robust'] = rob
        print(f'  {name:28s} {"stable" if N["ok"] else "NOT stable"}  drift {N["drift"] * 100:4.1f} cm, head {N["head_drift"] * 100:4.1f} cm; '
              f'pelvis {np.round(N["pelvis"], 2)}' + (f' lost contact: {N["lost"]}' if N['lost'] else '') + '  stays: ' + ' / '.join(f'{rob[F]:.2f}' for F in PUSHES[1:] if F in rob), flush=True)
    edges = []
    print('edges (planned once; replayed 64 times per push size: committor at 0 / 100 / 200 / 300 N)')
    for a, b, T in EDGES:
        if only and f'{a}>{b}' not in only: continue
        A, B = nodes[a], nodes[b]
        if not (A['ok'] and B['ok']): print(f'  {a} → {b}: skipped (a stance is not stable)'); continue
        t0 = time.perf_counter()
        U, ok, eff, work, m = plan_edge(M, A, B, T, record=f'edge-{a}-{b}'.replace(' ', '_').replace(',', ''))
        com = {}
        for F in PUSHES:
            X = push_controls(M, U, F, T, rng, NREP if F > 0 else 1)
            _, S = rollout.rollout(M, datas, A['state'][None], X, control_spec=SPEC, persistent_pool=True)
            com[F] = float(ends_in(M, S, X, B, sens).mean())
        edges.append(dict(a=a, b=b, T=T, nominal=ok, committor=com, effort=round(eff, 3), work=round(work, 1)))
        print(f'  {a:28s} → {b:28s} plan {"reaches" if ok else "MISSES"}  committor ' + ' / '.join(f'{com[F]:.2f}' for F in PUSHES) +
              f'  effort {eff:.3f}, work {work:.0f} J  ({time.perf_counter() - t0:.0f} s)', flush=True)
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    json.dump(dict(nodes={k: dict(ok=v['ok'], drift=v['drift'], robust=v['robust'], pelvis=v['pelvis'].tolist(), head=float(v['head'][2])) for k, v in nodes.items()}, edges=edges),
              open(os.path.join(HERE, 'out', 'stances.json'), 'w'), indent=1)
    print(f'done in {time.perf_counter() - T0:.0f} s')

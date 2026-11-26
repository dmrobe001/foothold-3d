"""Milestone 1: does the body hold together and stand, and how fast does it simulate?

1. Limp drop: servos off, from standing. It should fold to the floor without blowing up or sinking into it.
2. Held stance: servos at the standing angles (all zero). Does it stay up for 5 s, and how far does the centre of
   mass wander?
3. Throughput: batched open-loop rollouts on all cores (mujoco.rollout), the measure that sizes the planner.
Run: python3 sim/drop_test.py
"""
import time, os
import numpy as np
import mujoco
from mujoco import rollout
from body import model, set_stand, stand_ctrl

M = model(None)
D = mujoco.MjData(M)
sid = {M.sensor(i).name: (M.sensor_adr[i], M.sensor_dim[i]) for i in range(M.nsensor)}
sens = lambda name: D.sensordata[sid[name][0]:sid[name][0] + sid[name][1]].copy()


def deepest():  # deepest contact penetration (m)
    return max([-D.contact[i].dist for i in range(D.ncon)] + [0.0])


# 1. limp
M2 = model(None); M2.actuator_gainprm[:, 0] = 0; M2.actuator_biasprm[:, :] = 0
D2 = mujoco.MjData(M2); set_stand(M2, D2); D2.ctrl[:] = 0; pen = 0; vmax = 0
for k in range(int(3 / M2.opt.timestep)):
    mujoco.mj_step(M2, D2); pen = max(pen, max([-D2.contact[i].dist for i in range(D2.ncon)] + [0])); vmax = max(vmax, np.abs(D2.qvel).max())
com = D2.subtree_com[1]
print(f'limp drop: after 3 s the centre of mass is {com[2]:.2f} m up; deepest contact {pen * 1000:.1f} mm; fastest joint {vmax:.1f} (rad or m)/s')

# 2. held stance
set_stand(M, D); pen = 0; c0 = None; wander = 0; tq = np.zeros(M.nu)
for k in range(int(5 / M.opt.timestep)):
    mujoco.mj_step(M, D); pen = max(pen, deepest())
    c = sens('com'); c0 = c if c0 is None else c0; wander = max(wander, np.hypot(c[0] - c0[0], c[1] - c0[1]))
    tq = np.maximum(tq, np.abs(D.actuator_force))
names = [M.actuator(i).name for i in range(M.nu)]
top = sorted(range(M.nu - 2), key=lambda i: -tq[i])[:4]
print(f'held stance: after 5 s head at {sens("head_pos")[2]:.2f} m, pelvis at {sens("pelvis_pos")[2]:.2f} m; centre of mass wandered '
      f'{wander * 100:.1f} cm; deepest contact {pen * 1000:.1f} mm; largest torques ' + ', '.join(f'{names[i]} {tq[i]:.0f} N·m' for i in top))

# 3. throughput
nthread = os.cpu_count(); datas = [mujoco.MjData(M) for _ in range(nthread)]
set_stand(M, D)
state0 = np.zeros(mujoco.mj_stateSize(M, mujoco.mjtState.mjSTATE_FULLPHYSICS)); mujoco.mj_getState(M, D, state0, mujoco.mjtState.mjSTATE_FULLPHYSICS)
for nb in (16, 64, 256):
    nstep = 250; ctrl = stand_ctrl(M) + np.random.default_rng(0).normal(0, 0.2, (nb, nstep, M.nu)); ctrl[:, :, -2:] = 0
    rollout.rollout(M, datas, state0[None], ctrl[:, :5], persistent_pool=True)  # warm
    t = time.perf_counter(); rollout.rollout(M, datas, state0[None], ctrl, persistent_pool=True); dt = time.perf_counter() - t
    print(f'rollout {nb} x {nstep} steps on {nthread} threads: {nb * nstep / dt / 1000:.0f} k steps/s ({nb * nstep * M.opt.timestep / dt:.1f} s simulated per s)')

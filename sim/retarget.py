"""A way over from the game (sim/refs/<mode>-<station>.json, exported by export_script.cjs) as a joint-angle trajectory
of the simulated body: damped least-squares inverse kinematics, frame by frame, fitting the body's joints to the game's
joint positions (both skeletons have the same bones, so each game joint has a point on this body).

The barrier frame [a, y, s] (a along its normal from the near face, y up, s to the right) maps to the simulator's
X = near_x + a, Y = -s, Z = y. Output: sim/refs/<name>-q.npz with times, qpos per frame, the servo targets per frame
(each actuator's joint angle: with position servos a pose IS a set of targets) and the fit error per frame.
Run: python3 sim/retarget.py vault-19
"""
import json, os, sys
import numpy as np
import mujoco
from body import model, set_stand, ANKLE_H

HERE = os.path.dirname(os.path.abspath(__file__))
# game joint -> (simulator body, point in that body's frame)
POINTS = {'pelvis': ('pelvis', (0, 0, 0)), 'spine1': ('spine2', (0, 0, 0)), 'spine2': ('chest', (0, 0, 0)), 'chest': ('head', (0, 0, 0)),
          'head': ('head', (0.0, 0, 0.30)),
          **{f'{j}{s}': (b + s, p) for s in 'LR' for j, b, p in (('hip', 'thigh', (0, 0, 0)), ('knee', 'shin', (0, 0, 0)), ('ankle', 'foot', (0, 0, 0)),
                                                                    ('toe', 'foot', (0.17, 0, 0)), ('shoulder', 'upperarm', (0, 0, 0)),
                                                                    ('elbow', 'forearm', (0, 0, 0)), ('hand', 'hand', (0, 0, 0)))}}
WEIGHT = dict(pelvis=3, head=1.5, chest=2, hand=1.5, ankle=2, toe=0.15, knee=1, elbow=0.2, hip=1, shoulder=1, spine1=1, spine2=1)
KEY = ('pelvis', 'chest', 'head', 'handL', 'handR', 'kneeL', 'kneeR', 'ankleL', 'ankleR')  # the fit error counts these (the game's elbows and toes are set by hand-picked directions)


def fit(name, near_x, iters=60, lam=1e-2):
    ref = json.load(open(os.path.join(HERE, 'refs', f'{name}.json')))
    M = model(None); D = mujoco.MjData(M); set_stand(M, D)
    to_sim = lambda p: np.array([near_x + p[0], -p[2], p[1] + ANKLE_H - 0.06])  # (the game's ankle is 6 cm above its footing, this body's 7)
    pel0 = to_sim(ref['frames'][0]['J']['pelvis']); D.qpos[:3] = pel0; mujoco.mj_forward(M, D)
    jid = [M.actuator_trnid[i, 0] for i in range(M.nu - 2)]  # the servos' joints
    lo, hi = M.jnt_range[jid, 0], M.jnt_range[jid, 1]; qadr = M.jnt_qposadr[jid]
    dadr = M.jnt_dofadr[jid]
    jacp = np.zeros((3, M.nv)); Q, U, ERR = [], [], []; global LIM, WORST; LIM, WORST = {}, []
    for fr in ref['frames']:
        tgt = {k: to_sim(v) for k, v in fr['J'].items() if k in POINTS}
        frozen = np.zeros(M.nv, bool)  # active set: a joint at its limit, pushed further, is held there and the others take up the motion
        for it in range(iters):
            mujoco.mj_kinematics(M, D); mujoco.mj_comPos(M, D)
            rows, errs = [], []
            for k, x in tgt.items():
                b, off = POINTS[k]; bid = M.body(b).id; R = D.xmat[bid].reshape(3, 3); p = D.xpos[bid] + R @ np.array(off)
                mujoco.mj_jac(M, D, jacp, None, p, bid); w = WEIGHT.get(k.rstrip('LR'), 1.0)
                rows.append(jacp * w); errs.append((x - p) * w)
            J = np.vstack(rows); J[:, frozen] = 0; e = np.concatenate(errs)
            dq = J.T @ np.linalg.solve(J @ J.T + lam * np.eye(J.shape[0]), e)
            mujoco.mj_integratePos(M, D.qpos, dq, 0.7)
            q = D.qpos[qadr]; at = (q < lo) | (q > hi); frozen[dadr[at]] = True; D.qpos[qadr] = np.clip(q, lo, hi)
            if np.linalg.norm(dq) < 1e-5: break
        mujoco.mj_kinematics(M, D)
        err = max(np.linalg.norm(tgt[k] - (D.xpos[M.body(POINTS[k][0]).id] + D.xmat[M.body(POINTS[k][0]).id].reshape(3, 3) @ np.array(POINTS[k][1]))) for k in KEY)
        Q.append(D.qpos.copy()); U.append(D.qpos[qadr].copy()); ERR.append(err)
        for j, d in zip(jid, dadr):
            if frozen[d]: LIM[M.joint(j).name] = LIM.get(M.joint(j).name, 0) + 1
        WORST.append(max(KEY, key=lambda k: np.linalg.norm(tgt[k] - (D.xpos[M.body(POINTS[k][0]).id] + D.xmat[M.body(POINTS[k][0]).id].reshape(3, 3) @ np.array(POINTS[k][1])))))
    t = np.array([f['t'] for f in ref['frames']])
    out = os.path.join(HERE, 'refs', f'{name}-q.npz')
    np.savez(out, t=t, qpos=np.array(Q), ctrl=np.array(U), err=np.array(ERR), near_x=near_x, barrier=json.dumps(ref['barrier']))
    return t, np.array(Q), np.array(ERR)


if __name__ == '__main__':
    name = sys.argv[1] if len(sys.argv) > 1 else 'vault-19'
    ref = json.load(open(os.path.join(HERE, 'refs', f'{name}.json')))
    near_x = -ref['frames'][0]['J']['pelvis'][0]  # place the body's starting pelvis at the origin
    t, Q, E = fit(name, near_x)
    from collections import Counter
    print('held at a limit (frames):', dict(sorted(LIM.items(), key=lambda kv: -kv[1])[:10]), '| worst-fitting joint (frames):', dict(Counter(WORST).most_common(5)))
    print(f'{name}: {len(t)} poses over {t[-1]:.2f} s; the wall\'s near face at x {near_x:.2f}; fit error (worst joint) median {np.median(E) * 100:.1f} cm, max {E.max() * 100:.1f} cm at t {t[E.argmax()]:.2f} s')

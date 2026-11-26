"""The game's body (src/skeleton.js) as a MuJoCo model, and the gym's stations as scenes.

Frame: X forward (the station's f), Y left (minus the station's x), Z up. The body starts standing at the origin facing +X.

Bone lengths are the game's (thigh and shin 0.45 m, spine segments 0.17/0.17/0.16, neck 0.22, upper arm 0.30, forearm
0.32, hips 0.11 either side of the pelvis, shoulders 0.19 either side of the chest, 0.05 below its top), so a motion found
here maps joint for joint onto the game's skeleton. Capsule radii are the game's collision capsules (thigh 0.08, shin
0.06, torso 0.16, head 0.11, upper arm 0.05, forearm 0.045). Note: straight-legged, these lengths make a body 1.88 m tall;
the game reads as 1.75 m because it stands knee-bent (pelvis 0.84 m above the feet on a 0.90 m leg).

Segment masses: de Leva (1996) fractions of a 70 kg body. Each joint is driven by a position servo (a target angle, a
stiffness) whose torque is capped at a rough human peak (TORQUE below: ballpark literature values, to be tuned, not
measurements). Hands can grip: an adhesion actuator per hand, up to GRIP newtons of pull on what it touches.
"""
import json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MASS = 70.0
FRAC = dict(pelvis=0.1117, abdomen=0.1633, thorax=0.1596, head=0.0694, upperarm=0.0271, forearm=0.0162, hand=0.0061,
            thigh=0.1416, shank=0.0433, foot=0.0137)  # de Leva 1996 (male); sums to 1 with both sides
ANKLE_H = 0.07  # ankle above the sole
GRIP = 400.0  # N per hand
# joint: (axis, range rad, servo stiffness N·m/rad, peak torque N·m)
TORQUE = dict(spine_pitch=250, spine_roll=150, spine_twist=80, neck=30, sh_flex=90, sh_abd=80, sh_rot=50, elbow=70,
              hip_flex=220, hip_abd=150, hip_rot=80, knee=250, ankle=150, ankle_inv=60)


def _j(name, axis, rng, kp, tq, damp=None):
    return dict(name=name, axis=axis, range=rng, kp=kp, tq=tq, damp=damp if damp is not None else 0.03 * kp)


def body_xml():
    m = {k: v * MASS for k, v in FRAC.items()}
    hip_z = ANKLE_H + 0.90
    joints = []  # collected for the actuator list

    def joint_xml(js):
        out = ''
        for j in js:
            joints.append(j)
            out += f'<joint name="{j["name"]}" type="hinge" axis="{j["axis"]}" range="{j["range"][0]} {j["range"][1]}" damping="{j["damp"]:.1f}" armature="0.02"/>'
        return out

    def spine(i):  # three segments, each turning on the one below (as the game spreads a bend over them)
        return [_j(f'spine{i}_pitch', '0 1 0', (-0.35, 0.75), 500, TORQUE['spine_pitch']),
                _j(f'spine{i}_roll', '1 0 0', (-0.3, 0.3), 400, TORQUE['spine_roll']),
                _j(f'spine{i}_twist', '0 0 1', (-0.35, 0.35), 200, TORQUE['spine_twist'])]

    def arm(s):
        y, sg = (0.19, 1) if s == 'L' else (-0.19, -1)
        return f'''
        <body name="upperarm{s}" pos="0 {y} 0.11">
          {joint_xml([_j(f'sh_flex{s}', '0 -1 0', (-1.0, 3.0), 120, TORQUE['sh_flex']),
                      _j(f'sh_abd{s}', f'{sg} 0 0', (-0.3, 3.0), 120, TORQUE['sh_abd']),
                      _j(f'sh_rot{s}', '0 0 1', (-1.5, 1.5), 60, TORQUE['sh_rot'])])}
          <geom name="upperarm{s}" type="capsule" fromto="0 0 0 0 0 -0.30" size="0.05" mass="{m['upperarm']:.3f}"/>
          <body name="forearm{s}" pos="0 0 -0.30">
            {joint_xml([_j(f'elbow{s}', '0 -1 0', (0.0, 2.6), 80, TORQUE['elbow'])])}
            <geom name="forearm{s}" type="capsule" fromto="0 0 0 0 0 -0.30" size="0.045" mass="{m['forearm']:.3f}"/>
            <body name="hand{s}" pos="0 0 -0.32">
              <geom name="hand{s}" type="sphere" size="0.05" mass="{m['hand']:.3f}"/>
              <site name="hand{s}" size="0.02"/>
            </body>
          </body>
        </body>'''

    def leg(s):
        y, sg = (0.11, 1) if s == 'L' else (-0.11, -1)
        return f'''
      <body name="thigh{s}" pos="0 {y} 0">
        {joint_xml([_j(f'hip_flex{s}', '0 -1 0', (-0.5, 2.2), 700, TORQUE['hip_flex']),
                    _j(f'hip_abd{s}', f'{sg} 0 0', (-0.4, 1.0), 500, TORQUE['hip_abd']),
                    _j(f'hip_rot{s}', '0 0 1', (-0.8, 0.8), 200, TORQUE['hip_rot'])])}
        <geom name="thigh{s}" type="capsule" fromto="0 0 0 0 0 -0.45" size="0.08" mass="{m['thigh']:.3f}"/>
        <body name="shin{s}" pos="0 0 -0.45">
          {joint_xml([_j(f'knee{s}', '0 1 0', (0.0, 2.6), 700, TORQUE['knee'])])}
          <geom name="shin{s}" type="capsule" fromto="0 0 0 0 0 -0.43" size="0.06" mass="{m['shank']:.3f}"/>
          <body name="foot{s}" pos="0 0 -0.45">
            {joint_xml([_j(f'ankle{s}', '0 1 0', (-0.6, 0.8), 500, TORQUE['ankle']),
                        _j(f'ankle_inv{s}', '1 0 0', (-0.4, 0.4), 150, TORQUE['ankle_inv'])])}
            <geom name="foot{s}" type="box" pos="0.05 0 -0.04" size="0.12 0.05 0.03" mass="{m['foot']:.3f}"/>
            <site name="foot{s}" pos="0.05 0 -0.07" size="0.02"/>
          </body>
        </body>
      </body>'''

    body = f'''
    <body name="pelvis" pos="0 0 {hip_z}">
      <freejoint name="root"/>
      <geom name="pelvis" type="capsule" fromto="0 -0.09 -0.03 0 0.09 -0.03" size="0.12" mass="{m['pelvis']:.3f}"/>
      <site name="pelvis" size="0.02"/>
      {leg('L')}{leg('R')}
      <body name="spine1" pos="0 0 0">
        {joint_xml(spine(1))}
        <geom name="spine1" type="capsule" fromto="0 0 0.02 0 0 0.17" size="0.14" mass="{m['abdomen'] / 2:.3f}"/>
        <body name="spine2" pos="0 0 0.17">
          {joint_xml(spine(2))}
          <geom name="spine2" type="capsule" fromto="0 0 0 0 0 0.17" size="0.15" mass="{m['abdomen'] / 2:.3f}"/>
          <body name="chest" pos="0 0 0.17">
            {joint_xml(spine(3))}
            <geom name="chest" type="capsule" fromto="0 0 0 0 0 0.16" size="0.16" mass="{m['thorax']:.3f}"/>
            <site name="chest" pos="0 0 0.16" size="0.02"/>
            <body name="head" pos="0 0 0.16">
              {joint_xml([_j('neck_pitch', '0 1 0', (-0.9, 0.9), 60, TORQUE['neck']), _j('neck_yaw', '0 0 1', (-1.2, 1.2), 30, TORQUE['neck'])])}
              <geom name="neck" type="capsule" fromto="0 0 0.02 0 0 0.2" size="0.05" mass="{m['head'] * 0.2:.3f}"/>
              <geom name="head" type="sphere" pos="0.02 0 0.30" size="0.11" mass="{m['head'] * 0.8:.3f}"/>
              <site name="head" pos="0.02 0 0.30" size="0.115" type="sphere"/>
            </body>
            {arm('L')}{arm('R')}
          </body>
        </body>
      </body>
    </body>'''
    acts = ''.join(f'<position name="{j["name"]}" joint="{j["name"]}" kp="{j["kp"]}" ctrlrange="{j["range"][0]} {j["range"][1]}" '
                   f'forcerange="{-j["tq"]} {j["tq"]}"/>' for j in joints)
    acts += ''.join(f'<adhesion name="grip{s}" body="hand{s}" ctrlrange="0 1" gain="{GRIP}"/>' for s in 'LR')
    # the arms lie against the torso and the thighs meet the lower spine at the hips: no contact between them
    excl = ''.join(f'<exclude body1="{a}{s}" body2="{b}"/>' for s in 'LR' for a in ('upperarm', 'forearm') for b in ('spine1', 'spine2', 'chest'))
    trunk = ['pelvis', 'spine1', 'spine2', 'chest', 'head']  # one torso in the game: its pieces overlap where they bend
    excl += ''.join(f'<exclude body1="{a}" body2="{b}"/>' for i, a in enumerate(trunk) for b in trunk[i + 1:])
    excl += ''.join(f'<exclude body1="thigh{s}" body2="{b}"/>' for s in 'LR' for b in ('spine1', 'spine2'))
    sensors = ''.join(f'<actuatorfrc name="frc_{j["name"]}" actuator="{j["name"]}"/>' for j in joints)
    sensors += ('<framepos name="pelvis_pos" objtype="site" objname="pelvis"/><framepos name="head_pos" objtype="site" objname="head"/>'
                '<framezaxis name="chest_up" objtype="site" objname="chest"/><framexaxis name="pelvis_fwd" objtype="site" objname="pelvis"/>'
                '<subtreecom name="com" body="pelvis"/><subtreelinvel name="com_vel" body="pelvis"/>'
                '<framepos name="footL_pos" objtype="site" objname="footL"/><framepos name="footR_pos" objtype="site" objname="footR"/>'
                '<framepos name="handL_pos" objtype="site" objname="handL"/><framepos name="handR_pos" objtype="site" objname="handR"/>'
                '<touch name="head_touch" site="head"/>')
    return body, acts, excl, sensors, joints


def station_xml(st, start_f=-1.0):
    """The station's boxes and rails, shifted so the body (at the origin) starts at f = start_f."""
    out = ''
    for k, b in enumerate(st['boxes']):
        cx, cy, cz = b['f'] - start_f, -b['x'], b['y'] + b['h'] / 2
        out += (f'<geom name="box{k}" type="box" pos="{cx} {cy} {cz}" size="{b["l"] / 2} {b["w"] / 2} {b["h"] / 2}" '
                f'euler="{-b["roll"]} {-b["pitch"]} {b["yaw"]}" rgba="0.55 0.5 0.45 1"/>')
    for k, r in enumerate(st['rails']):
        (x0, f0, z0), (x1, f1, z1) = r['a'], r['b']
        out += f'<geom name="rail{k}" type="capsule" fromto="{f0 - start_f} {-x0} {z0} {f1 - start_f} {-x1} {z1}" size="{r["r"]}" rgba="0.5 0.4 0.3 1"/>'
    return out


def load_station(i):
    with open(os.path.join(HERE, 'stations.json')) as f:
        return json.load(f)[i - 1]


STAND = dict(sh_abdL=0.2, sh_abdR=0.2, elbowL=0.15, elbowR=0.15)  # standing: arms a little out from the hips, elbows soft


def stand_ctrl(M):
    """Servo targets (and joint angles) of the standing pose."""
    import numpy as np
    u = np.zeros(M.nu)
    for k, v in STAND.items(): u[M.actuator(k).id] = v
    return u


def set_stand(M, D):
    import mujoco
    mujoco.mj_resetData(M, D)
    for k, v in STAND.items(): D.qpos[M.jnt_qposadr[M.joint(k).id]] = v
    D.ctrl[:] = stand_ctrl(M); mujoco.mj_forward(M, D)


def scene_xml(station=None, start_f=-1.0, timestep=0.004):
    body, acts, excl, sensors, _ = body_xml()
    world = station_xml(load_station(station), start_f) if station else ''
    return f'''<mujoco model="foothold body">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="{timestep}" integrator="implicitfast" cone="elliptic"/>
  <default><geom friction="0.8 0.02 0.002" condim="3" solref="0.008 1" solimp="0.95 0.99 0.001" rgba="0.79 0.72 0.6 1"/></default>
  <worldbody>
    <light pos="0 0 4" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="30 30 0.1" rgba="0.35 0.33 0.3 1"/>
    {world}{body}
  </worldbody>
  <actuator>{acts}</actuator>
  <contact>{excl}</contact>
  <sensor>{sensors}</sensor>
</mujoco>'''


def model(station=None, start_f=-1.0, timestep=0.004):
    import mujoco
    return mujoco.MjModel.from_xml_string(scene_xml(station, start_f, timestep))


if __name__ == '__main__':
    import mujoco
    M = model(19)
    print(f'{M.nq} qpos, {M.nv} dof, {M.nu} actuators ({M.nu - 2} joints + 2 grips), {M.nsensordata} sensor values, '
          f'mass {sum(M.body_mass):.1f} kg, {M.ngeom} geoms')

// A small articulated skeleton: one hierarchy of joints, solved each frame from a few posture variables and four
// end-effector targets (two hands, two feet). Nothing here knows about the world: callers decide where the pelvis
// is, how the spine bends and where each hand and foot should be; solvePose turns that into joint positions and
// reports how far each limb fell short of its target (the honest measure of whether a planted contact can hold).
//
// Frames are { R, U, F }: right, up and forward unit vectors. For the pelvis, U points along the spine and F out of
// the belly, so a standing body has U = world up, and a body crawling up a stem has U along the stem, F into it.
// Vectors are plain [x, y, z] arrays.

export const BONES = {
  thigh: 0.45, shin: 0.45, foot: 0.17, hipW: 0.11,
  spine: [0.17, 0.17, 0.16], spineW: [0.3, 0.35, 0.35], // segment lengths (sum 0.5) and the share of a bend each takes
  neck: 0.22, clav: 0.19, shoulderDrop: 0.05, upperArm: 0.3, foreArm: 0.32,
};
// Joint ranges (radians) for each spine segment relative to its parent: pitch (+ = toward the belly), roll, twist.
export const LIMITS = { pitch: [-0.35, 0.75], roll: [-0.3, 0.3], twist: [-0.35, 0.35], neckPitch: [-0.9, 0.9] };

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clampv = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));
export const vec = { add, sub, dot, len, nrm, cross };

// rotate a frame: pitch about R (U tips toward F), then roll about F (U tips toward R), then twist about U
function turn(fr, pitch, roll, twist) {
  let { R, U, F } = fr, c = Math.cos(pitch), s = Math.sin(pitch);
  [U, F] = [add(U.map((v) => v * c), F, s), add(F.map((v) => v * c), U, -s)];
  c = Math.cos(roll); s = Math.sin(roll);
  [U, R] = [add(U.map((v) => v * c), R, s), add(R.map((v) => v * c), U, -s)];
  c = Math.cos(twist); s = Math.sin(twist);
  [F, R] = [add(F.map((v) => v * c), R, s), add(R.map((v) => v * c), F, -s)];
  return { R, U, F };
}
// A frame from an up (spine) direction and a rough forward (belly) direction.
export function frameFrom(U, Fhint) {
  U = nrm(U); let F = sub(Fhint, U.map((v) => v * dot(Fhint, U)));
  if (len(F) < 1e-6) F = Math.abs(U[1]) < 0.9 ? [0, 1, 0] : [0, 0, -1], F = sub(F, U.map((v) => v * dot(F, U)));
  F = nrm(F); return { R: cross(F, U), U, F };
}

// Two-bone inverse kinematics: root a, target c, lengths l1 and l2, middle joint bent toward `pole`.
// Returns the middle joint, the reached end point and the shortfall (0 when the target is within reach).
export function twoBone(a, c, l1, l2, pole) {
  const d = sub(c, a), D = len(d), L = Math.min(Math.max(D, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3), dir = D > 1e-6 ? d.map((v) => v / D) : [0, -1, 0];
  const x = (l1 * l1 - l2 * l2 + L * L) / (2 * L), y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  let perp = sub(pole, dir.map((v) => v * dot(pole, dir))); if (len(perp) < 1e-6) perp = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  perp = nrm(sub(perp, dir.map((v) => v * dot(perp, dir))));
  const mid = add(add(a, dir, x), perp, y), end = add(a, dir, L);
  return { mid, end, short: Math.max(0, D - L) };
}

// pose: {
//   pelvis: [x,y,z], frame: {R,U,F} (pelvis frame), bend: [pitch, roll, twist] summed over the spine,
//   neckPitch, feet: [[x,y,z] x2] ankle targets (left, right), toes: [[x,y,z] x2] directions the feet point,
//   hands: [[x,y,z] x2] wrist targets, kneePole / elbowPole: [[x,y,z] x2] directions the knees / elbows point,
// }
// Returns joints by name, the chest and head frames, bone segments for drawing and each limb's shortfall.
export function solvePose(pose) {
  const B = BONES, J = {}, short = {};
  J.pelvis = pose.pelvis;
  let fr = pose.frame, p = pose.pelvis;
  const [bp, br, bt] = pose.bend || [0, 0, 0];
  B.spine.forEach((l, i) => {
    const w = B.spineW[i];
    fr = turn(fr, clampv(bp * w, LIMITS.pitch), clampv(br * w, LIMITS.roll), clampv(bt * w, LIMITS.twist));
    p = add(p, fr.U, l); J['spine' + (i + 1)] = p;
  });
  J.chest = p; const chest = fr;
  const head = turn(chest, clampv(pose.neckPitch || 0, LIMITS.neckPitch), 0, 0);
  J.neck = add(J.chest, head.U, B.neck); J.head = add(J.neck, head.U, 0.08);
  const pf = pose.frame, segs = [[J.pelvis, J.spine1, 0.07], [J.spine1, J.spine2, 0.065], [J.spine2, J.chest, 0.06], [J.chest, J.neck, 0.045]];
  ['L', 'R'].forEach((s, i) => {
    const side = i ? 1 : -1;
    // legs: hip -> knee -> ankle -> toe
    const hip = add(J.pelvis, pf.R, side * B.hipW), leg = twoBone(hip, pose.feet[i], B.thigh, B.shin, pose.kneePole[i]);
    J['hip' + s] = hip; J['knee' + s] = leg.mid; J['ankle' + s] = leg.end; short['foot' + s] = leg.short;
    J['toe' + s] = add(leg.end, nrm(pose.toes ? pose.toes[i] : pf.F), B.foot);
    // arms: collarbone -> shoulder -> elbow -> wrist
    const clav = add(J.chest, chest.U, -B.shoulderDrop), sh = add(clav, chest.R, side * B.clav);
    const arm = twoBone(sh, pose.hands[i], B.upperArm, B.foreArm, pose.elbowPole[i]);
    J['shoulder' + s] = sh; J['elbow' + s] = arm.mid; J['hand' + s] = arm.end; short['hand' + s] = arm.short;
    segs.push([hip, leg.mid, 0.06], [leg.mid, leg.end, 0.05], [leg.end, J['toe' + s], 0.035], [sh, arm.mid, 0.045], [arm.mid, arm.end, 0.04]);
  });
  segs.push([J.hipL, J.hipR, 0.06], [J.shoulderL, J.shoulderR, 0.05]);
  return { J, chest, head, segs, short };
}

// Shoulder position for a pose's chest frame without solving the arms (for reach checks before committing a hand).
export function shoulderOf(chestP, chest, side) { return add(add(chestP, chest.U, -BONES.shoulderDrop), chest.R, side * BONES.clav); }

// Plants as graphs of segments (docs/plants.md). Pure data and geometry arrays: no three.js, so it runs in node too.
//
// A plant is a rooted tree graph. Each segment (node) runs p0 -> p1, has radii r0, r1, a parent, a branch order
// (0 stem or co-dominant leader, 1 limb, 2 branch, 3 shoot), the axis it belongs to (a run of segments grown as one
// shoot), a state, and an approximate birth year. Segments are created parent-first in a fixed order from the seed,
// so an index is a stable id: the game can store what happened to a plant as a short list of ids.
//
// Growth here is architectural, in the spirit of Weber & Penn (1995, "Creation and rendering of realistic trees"):
// axes grow from per-species rules (phyllotaxis, branch angles, curvature, splitting) and their lengths fill a crown
// envelope set by the stand simulation's crown length and radius. Radii then follow the pipe model (Shinozaki et al.
// 1964): r_parent^a = sum r_child^a, with the exponent fitted so the stem matches the simulated dbh.
// Roots, vines and mechanics are designed for (docs/plants.md) but not grown yet.
// Variety comes from the species rows (ARCH): crown envelope, phyllotaxis, branch angles and curves, sympodial zig-zag
// (zig), limb sag (sag), hanging branchlets (sub.hang), co-dominant splits; and per tree from a one-sided crown (side).
import { mulberry32, clamp, plateRadius } from './worldgen.js';

export const LIVE = 0;
export const DEAD = 1;
export const STUB = 2;
export const BURIED = 3; // segment states (roots and logs will use BURIED)
const D2R = Math.PI / 180, PHI = 2.39996; // golden angle (rad)

// ---- per-species architecture. Angles in degrees; curve: total bend over a limb [near half, far half] in radians
// (+ toward the sky, - drooping); kink: random turn per segment (deg); step: stem node spacing at full size (m).
// wood: green-wood stiffness E (GPa), modulus of rupture MOR (MPa) and specific gravity, after the USDA Wood Handbook
// (balsam fir, lodgepole pine, sugar maple, paper birch); approximate, for later load and breaking.
// edible: which parts can be eaten or used, where they are on the plant, and when (months, northern temperate).
// organs: the edible or reproductive parts placed on the graph as objects (cones, samaras, catkins).
export const ARCH = [
  { name: 'Fir', shape: 'cone', phyllo: 'whorl', per: [4, 6], step: 0.42, maxSteps: 22, ang: [98, 58], curve: [-0.35, 0.4], kink: 3, stemKink: 0.5,
    sub: { n: 6, ang: 58, ratio: 0.42, plane: true, kink: 6 }, sub2: null, split: null, fork: 0.04, leaf: 'spray', leafSize: 0.6, reachK: 1.15, rTip: 0.005,
    dead: 0.9, deadLen: 0.55, wood: { E: 8.6, MOR: 38, sg: 0.33 },
    edible: [
      { part: 'inner bark', where: 'stem', months: [1, 12], use: 'famine food: dried and ground' },
      { part: 'needle tips', where: 'shoot tips', months: [5, 6], use: 'tea; vitamin C' },
      { part: 'resin', where: 'bark blisters', months: [1, 12], use: 'chewed, wound dressing' },
    ],
    organ: { part: 'cone', minD: 14, zone: [0.8, 1], per: 0.5, len: 0.09, r: 0.022, hang: false, months: [8, 9], mass: 0.03 } },
  { name: 'Pine', shape: 'pine', phyllo: 'whorl', per: [3, 5], step: 0.6, maxSteps: 14, ang: [82, 48], curve: [0.25, 0.7], kink: 7, stemKink: 1.6,
    sub: { n: 4, ang: 48, ratio: 0.38, plane: false, kink: 10 }, sub2: null, split: null, fork: 0.1, leaf: 'brush', leafSize: 0.5, reachK: 1.1, rTip: 0.006,
    dead: 0.15, deadLen: 0.4, wood: { E: 7.4, MOR: 38, sg: 0.38 },
    edible: [
      { part: 'seeds', where: 'cones', months: [8, 10], use: 'small nuts, roasted' },
      { part: 'inner bark', where: 'stem', months: [4, 6], use: 'sweet when the sap runs; raw or dried' },
      { part: 'needles', where: 'shoots', months: [1, 12], use: 'tea' },
      { part: 'pollen', where: 'male cones', months: [5, 6], use: 'flour additive' },
    ],
    organ: { part: 'cone', minD: 10, zone: [0.3, 0.95], per: 0.35, len: 0.05, r: 0.022, hang: true, months: [1, 12], mass: 0.02 } },
  { name: 'Maple', shape: 'dome', phyllo: 'opposite', step: 0.75, maxSteps: 11, ang: [62, 38], curve: [0.45, 0.05], kink: 13, stemKink: 3,
    sub: { n: 5, ang: 50, ratio: 0.5, plane: false, kink: 14 }, sub2: { n: 3, ang: 46, ratio: 0.55 },
    split: { at: 0.42, n: [2, 4], spread: [22, 38], again: 0.55, p: 1 }, fork: 0, leaf: 'shell', leafSize: 0.65, reachK: 1.0, rTip: 0.005,
    dead: 0.3, deadLen: 0.6, wood: { E: 10.7, MOR: 65, sg: 0.56 },
    edible: [
      { part: 'sap', where: 'stem', months: [2, 4], use: 'drunk fresh or boiled to syrup' },
      { part: 'seeds', where: 'samaras', months: [6, 9], use: 'peeled and boiled or roasted' },
      { part: 'young leaves', where: 'shoot tips', months: [4, 5], use: 'cooked green' },
      { part: 'inner bark', where: 'stem', months: [1, 12], use: 'famine food' },
    ],
    organ: { part: 'samaras', minD: 14, zone: [0.35, 1], per: 0.25, len: 0.05, r: 0.03, hang: true, months: [6, 9], mass: 0.01, tip: true } },
  { name: 'Birch', shape: 'ovoid', phyllo: 'spiral', step: 0.55, maxSteps: 16, ang: [66, 40], curve: [0.6, -1.7], kink: 9, stemKink: 1.8,
    sub: { n: 5, ang: 45, ratio: 0.55, plane: false, kink: 11 }, sub2: { n: 3, ang: 40, ratio: 0.6 },
    split: { at: 0.72, n: [2, 2], spread: [10, 18], again: 0, p: 0.3 }, fork: 0.2, leaf: 'pend', leafSize: 0.55, reachK: 1.4, rTip: 0.004,
    dead: 0.2, deadLen: 0.35, wood: { E: 8.1, MOR: 44, sg: 0.48 },
    edible: [
      { part: 'sap', where: 'stem', months: [3, 5], use: 'drunk fresh, light syrup' },
      { part: 'inner bark', where: 'stem', months: [4, 6], use: 'dried and ground to flour' },
      { part: 'young leaves and catkins', where: 'shoot tips', months: [4, 5], use: 'tea, cooked' },
    ],
    organ: { part: 'catkins', minD: 8, zone: [0.3, 1], per: 0.3, len: 0.04, r: 0.008, hang: true, months: [4, 9], mass: 0.003, tip: true } },
  // Spruce: a narrow spire; limbs droop from the stem and turn up at the tips, and the branchlets on them hang in curtains
  // (hang: how far side branches are turned toward the ground, radians). Wood after white spruce.
  { name: 'Spruce', shape: 'spire', phyllo: 'whorl', per: [4, 6], step: 0.36, maxSteps: 26, ang: [104, 76], curve: [-0.6, 0.42], kink: 3, stemKink: 0.4,
    sub: { n: 7, ang: 64, ratio: 0.46, plane: false, kink: 7, hang: 0.85 }, sub2: null, split: null, fork: 0.03, leaf: 'spray', leafSize: 0.5, reachK: 1.1, rTip: 0.005,
    dead: 0.85, deadLen: 0.5, wood: { E: 7.4, MOR: 39, sg: 0.33 },
    edible: [
      { part: 'new tips', where: 'shoot tips', months: [5, 6], use: 'raw, tea or syrup; vitamin C' },
      { part: 'inner bark', where: 'stem', months: [4, 6], use: 'famine food: dried and ground' },
      { part: 'gum', where: 'bark wounds', months: [1, 12], use: 'chewed; pitch for glue' },
    ],
    organ: { part: 'cone', minD: 12, zone: [0.75, 1], per: 0.55, len: 0.05, r: 0.016, hang: true, months: [8, 10], mass: 0.015 } },
  // Oak: low apical dominance and sympodial limbs. Each shoot's tip aborts and a side bud carries on, so limbs zig-zag
  // (zig: the turn at each node, degrees); long limbs reach out nearly level and sag under their weight (sag). The trunk
  // breaks up low into several crooked leaders, and the crown is wide and open. Wood after northern red oak.
  { name: 'Oak', shape: 'spread', phyllo: 'spiral', step: 0.8, maxSteps: 10, ang: [82, 56], curve: [0.2, -0.05], kink: 16, stemKink: 3.5, zig: 28, sag: 0.45,
    sub: { n: 5, ang: 55, ratio: 0.55, plane: false, kink: 18, zig: 20 }, sub2: { n: 3, ang: 50, ratio: 0.55 },
    split: { at: 0.34, n: [3, 4], spread: [30, 46], again: 0.7, p: 0.85, curve: [-0.05, 0.2, 0.1, 0.4] }, fork: 0, leaf: 'shell', leafSize: 0.6, reachK: 1.05, rTip: 0.005,
    dead: 0.35, deadLen: 0.7, wood: { E: 9.3, MOR: 69, sg: 0.56 },
    edible: [
      { part: 'acorns', where: 'shoot tips', months: [9, 10], use: 'shelled, leached of tannin in water, then roasted or ground to flour' },
      { part: 'bark', where: 'stem', months: [1, 12], use: 'tannin: tanning hides, an astringent wash (not food)' },
    ],
    organ: { part: 'acorns', minD: 20, zone: [0.3, 1], per: 0.3, len: 0.025, r: 0.012, hang: true, months: [9, 10], mass: 0.005, tip: true } },
  // Aspen: a pioneer that sheds its lower limbs early, leaving a clean pale bole under a small, high, round crown of short
  // upswept limbs; small leaves, sparse enough to see sky through. Wood after quaking aspen.
  { name: 'Aspen', shape: 'column', phyllo: 'spiral', step: 0.55, maxSteps: 12, ang: [56, 36], curve: [0.5, 0.15], kink: 10, stemKink: 1.1,
    sub: { n: 4, ang: 44, ratio: 0.45, plane: false, kink: 10 }, sub2: null,
    split: { at: 0.82, n: [2, 2], spread: [8, 14], again: 0, p: 0.15 }, fork: 0.08, leaf: 'shell', leafSize: 0.42, reachK: 0.95, rTip: 0.004,
    dead: 0.08, deadLen: 0.3, wood: { E: 5.9, MOR: 35, sg: 0.35 },
    edible: [
      { part: 'inner bark', where: 'stem', months: [4, 6], use: 'raw or dried; sweet in spring' },
      { part: 'catkins', where: 'shoot tips', months: [3, 4], use: 'raw or cooked' },
    ],
    organ: { part: 'catkins', minD: 10, zone: [0.4, 1], per: 0.25, len: 0.05, r: 0.008, hang: true, months: [3, 5], mass: 0.003, tip: true } },
  // ---- beyond the "normal tree". New fields (all optional; a row without them grows as before):
  //   upright: gravitropism of the stem (default 0.6; low lets a stem wander and twist); stemZig: sympodial zig-zag of
  //   the stem (deg); stems: extra stems from the base {n, lean (deg), len (share of height), p}; dieback: share of live
  //   limbs that are dead (strip-bark and drought-killed crowns); sub.hangAll, sub.maxK, sub.seg: whips that hang from
  //   every limb, longer and in more segments (weeping); bark: the bark pattern drawn by the game (0 furrowed, 1 smooth,
  //   2 plates, 3 shaggy strips, 4 peeling, 5 cork, 6 banded, 7 papery, 8 strip bark, 9 scaly plates, 10 fissured);
  //   twist: spiral grain (rad/m, turns the bark pattern and flutes); lumps: burls and bosses on the stem (share of
  //   radius); flute: [ridges, depth] round the stem; swell: a swollen, bottle-like base; show: flowers and fruit drawn
  //   in their months, {part, months, color (sRGB), size (x leaf), per (chance per foliage unit at a tip)}.
  // Willow (weeping): arching limbs from a short, often divided trunk; long whips hang to the ground from every limb.
  { name: 'Willow', shape: 'dome', phyllo: 'spiral', step: 0.7, maxSteps: 10, ang: [55, 32], curve: [0.75, -0.5], kink: 10, stemKink: 4, upright: 0.4,
    stems: { n: [1, 3], lean: [15, 35], len: [0.6, 0.9], p: 0.5 }, lumps: 0.12, swell: 0.2,
    sub: { n: 8, ang: 38, ratio: 1.5, plane: false, kink: 6, hang: 1.5, hangAll: true, maxK: 2.2, seg: 4 }, sub2: null,
    split: { at: 0.3, n: [2, 4], spread: [25, 42], again: 0.5, p: 0.8, curve: [0, 0.35, -0.2, 0.1] }, fork: 0, leaf: 'spray', leafSize: 0.34, reachK: 1.1, rTip: 0.003,
    dead: 0.3, deadLen: 0.6, wood: { E: 5.4, MOR: 33, sg: 0.36 }, bark: 0,
    edible: [
      { part: 'inner bark', where: 'stem', months: [4, 6], use: 'famine food' },
      { part: 'bark', where: 'twigs', months: [1, 12], use: 'salicin: a bitter tea for pain and fever (not food)' },
      { part: 'young shoots', where: 'whips', months: [3, 6], use: 'basketry and bindings' },
    ],
    organ: { part: 'catkins', minD: 6, zone: [0.3, 1], per: 0.2, len: 0.04, r: 0.008, hang: false, months: [3, 4], mass: 0.002, tip: true } },
  // Juniper (twisted): a slow, long-lived tree of dry rocky ground; several leaning, twisting stems with shaggy strip
  // bark, fluted and lumpy at the base; dense tufts of scale leaves; frosted blue berries (fleshy cones) all year.
  { name: 'Juniper', shape: 'ovoid', phyllo: 'spiral', step: 0.35, maxSteps: 14, ang: [70, 45], curve: [0.3, 0.2], kink: 22, stemKink: 14, upright: 0.2, stemZig: 16, zig: 15,
    stems: { n: [1, 3], lean: [20, 50], len: [0.5, 0.85], p: 0.7 }, bark: 3, twist: 0.25, lumps: 0.2, flute: [5, 0.15], swell: 0.3,
    sub: { n: 5, ang: 50, ratio: 0.5, plane: false, kink: 20 }, sub2: { n: 3, ang: 45, ratio: 0.5 },
    split: { at: 0.35, n: [2, 3], spread: [20, 40], again: 0.6, p: 0.6, curve: [-0.1, 0.3, 0, 0.4] }, fork: 0.2, leaf: 'brush', leafSize: 0.42, reachK: 1.1, rTip: 0.004,
    dead: 0.7, deadLen: 0.6, dieback: 0.12, wood: { E: 4.5, MOR: 48, sg: 0.44 },
    edible: [{ part: 'berries', where: 'shoot tips', months: [1, 12], use: 'seasoning, a few at a time (gin); not in pregnancy' }],
    organ: { part: 'berries', minD: 4, zone: [0.2, 1], per: 0.4, len: 0.008, r: 0.004, hang: false, months: [1, 12], mass: 0.0005, tip: true },
    show: [{ part: 'berries', months: [1, 12], color: [0.42, 0.52, 0.72], size: 0.24, per: 0.45 }] },
  // Wild cherry (flowering, fruiting): a cone of horizontal tiers on a straight stem with glossy, banded, peeling bark;
  // white blossom in spring, dark red cherries in summer, red leaves in autumn.
  { name: 'Cherry', shape: 'ovoid', phyllo: 'whorl', per: [3, 4], step: 1.0, maxSteps: 8, ang: [78, 52], curve: [0.3, 0.05], kink: 9, stemKink: 1.5,
    sub: { n: 4, ang: 45, ratio: 0.5, plane: false, kink: 10 }, sub2: { n: 3, ang: 40, ratio: 0.5 },
    split: { at: 0.6, n: [2, 3], spread: [12, 25], again: 0.2, p: 0.4 }, fork: 0.1, leaf: 'shell', leafSize: 0.5, reachK: 1.0, rTip: 0.004,
    dead: 0.25, deadLen: 0.4, wood: { E: 9.0, MOR: 55, sg: 0.47 }, bark: 6,
    edible: [{ part: 'cherries', where: 'shoot tips', months: [6, 8], use: 'raw, small and tart; the stones, wilted leaves and bark are poisonous (cyanogenic)' }],
    organ: { part: 'cherries', minD: 8, zone: [0.3, 1], per: 0.5, len: 0.012, r: 0.006, hang: true, months: [6, 8], mass: 0.004, tip: true },
    show: [{ part: 'blossom', months: [4, 5], color: [1.0, 0.95, 0.97], size: 1.0, per: 1.0 }, { part: 'blossom', months: [4, 5], color: [1.0, 0.9, 0.94], size: 0.8, per: 0.7 }, { part: 'cherries', months: [6, 8], color: [0.55, 0.04, 0.08], size: 0.22, per: 0.6 }] },
  // Rowan (mountain ash): a small, often two-stemmed tree of rocky uplands; smooth grey bark, feathery leaves, flat heads
  // of cream flowers in early summer and heavy orange-red berry clusters from late summer.
  { name: 'Rowan', shape: 'ovoid', phyllo: 'spiral', step: 0.5, maxSteps: 10, ang: [50, 34], curve: [0.5, 0.1], kink: 10, stemKink: 2,
    stems: { n: [1, 2], lean: [8, 20], len: [0.7, 0.95], p: 0.35 },
    sub: { n: 4, ang: 40, ratio: 0.5, plane: false, kink: 10 }, sub2: null,
    split: { at: 0.45, n: [2, 3], spread: [12, 25], again: 0.3, p: 0.6 }, fork: 0.1, leaf: 'shell', leafSize: 0.45, reachK: 1.0, rTip: 0.004,
    dead: 0.2, deadLen: 0.3, wood: { E: 8, MOR: 50, sg: 0.5 }, bark: 1,
    edible: [{ part: 'berries', where: 'shoot tips', months: [8, 11], use: 'cooked or frozen first (raw ones upset the gut); jelly' }],
    organ: { part: 'berries', minD: 5, zone: [0.3, 1], per: 0.6, len: 0.01, r: 0.005, hang: true, months: [8, 11], mass: 0.05, tip: true },
    show: [{ part: 'flowers', months: [5, 6], color: [1.0, 0.97, 0.86], size: 0.6, per: 0.6 }, { part: 'berries', months: [8, 11], color: [0.92, 0.25, 0.04], size: 0.38, per: 0.75 }] },
  // Plane (sycamore): a massive, lumpy-based riverside tree whose bark flakes off in plates, leaving a camouflage of
  // cream, olive and grey; huge leaves; hanging seed balls into winter.
  { name: 'Plane', shape: 'dome', phyllo: 'spiral', step: 0.85, maxSteps: 11, ang: [72, 50], curve: [0.35, -0.15], kink: 14, stemKink: 3, zig: 12, sag: 0.3,
    bark: 2, lumps: 0.15, swell: 0.35,
    sub: { n: 5, ang: 50, ratio: 0.55, plane: false, kink: 14 }, sub2: { n: 3, ang: 45, ratio: 0.55 },
    split: { at: 0.32, n: [2, 4], spread: [24, 44], again: 0.6, p: 0.8, curve: [-0.05, 0.25, 0, 0.3] }, fork: 0, leaf: 'shell', leafSize: 0.75, reachK: 1.05, rTip: 0.005,
    dead: 0.3, deadLen: 0.6, wood: { E: 7.3, MOR: 45, sg: 0.46 },
    edible: [{ part: 'sap', where: 'stem', months: [2, 3], use: 'drunk or boiled to syrup, thinner than maple' }],
    organ: { part: 'seed balls', minD: 20, zone: [0.3, 1], per: 0.2, len: 0.03, r: 0.015, hang: true, months: [9, 3], mass: 0.01, tip: true },
    show: [{ part: 'seed balls', months: [8, 12], color: [0.5, 0.38, 0.22], size: 0.2, per: 0.3 }] },
  // Olive (contorted, lumpy): a short, hollowing, many-stemmed trunk, fluted and spiralled and bulging with burls,
  // splitting low into crooked limbs; dense small silvery leaves; olives darkening through autumn.
  { name: 'Olive', shape: 'spread', phyllo: 'opposite', step: 0.4, maxSteps: 12, ang: [66, 46], curve: [0.3, -0.1], kink: 18, stemKink: 16, upright: 0.15, stemZig: 18, zig: 16,
    stems: { n: [1, 3], lean: [15, 40], len: [0.5, 0.8], p: 0.6 }, bark: 10, twist: 0.35, lumps: 0.55, flute: [4, 0.25], swell: 0.6,
    sub: { n: 6, ang: 50, ratio: 0.55, plane: false, kink: 18, zig: 12 }, sub2: { n: 3, ang: 45, ratio: 0.5 },
    split: { at: 0.3, n: [2, 4], spread: [25, 45], again: 0.6, p: 0.9, curve: [-0.05, 0.25, 0, 0.3] }, fork: 0, leaf: 'shell', leafSize: 0.42, reachK: 1.05, rTip: 0.004,
    dead: 0.3, deadLen: 0.4, dieback: 0.05, wood: { E: 10, MOR: 90, sg: 0.85 },
    edible: [{ part: 'olives', where: 'shoot tips', months: [9, 12], use: 'bitter raw: cured in brine or lye first; pressed for oil' }, { part: 'leaves', where: 'shoots', months: [1, 12], use: 'tea' }],
    organ: { part: 'olives', minD: 8, zone: [0.2, 1], per: 0.5, len: 0.02, r: 0.009, hang: true, months: [9, 12], mass: 0.004, tip: true },
    show: [{ part: 'flowers', months: [5, 6], color: [0.96, 0.94, 0.78], size: 0.35, per: 0.4 }, { part: 'olives', months: [9, 12], color: [0.2, 0.16, 0.22], size: 0.2, per: 0.7 }] },
  // Cork oak: a low, broad, crooked crown on a trunk clad in thick, deeply fissured pale cork.
  { name: 'Cork oak', shape: 'spread', phyllo: 'spiral', step: 0.7, maxSteps: 10, ang: [78, 55], curve: [0.2, -0.1], kink: 16, stemKink: 6, upright: 0.35, zig: 22, sag: 0.35,
    bark: 5, lumps: 0.2, swell: 0.15,
    sub: { n: 5, ang: 55, ratio: 0.55, plane: false, kink: 18, zig: 18 }, sub2: { n: 3, ang: 50, ratio: 0.5 },
    split: { at: 0.3, n: [2, 4], spread: [30, 50], again: 0.6, p: 0.9, curve: [-0.05, 0.2, 0, 0.35] }, fork: 0, leaf: 'shell', leafSize: 0.45, reachK: 1.05, rTip: 0.005,
    dead: 0.3, deadLen: 0.6, wood: { E: 9, MOR: 60, sg: 0.7 },
    edible: [{ part: 'acorns', where: 'shoot tips', months: [10, 1], use: 'sweeter than most: roasted, or leached and ground' }, { part: 'cork', where: 'stem', months: [6, 8], use: 'floats, stoppers, insulation (not food); regrows after stripping' }],
    organ: { part: 'acorns', minD: 20, zone: [0.3, 1], per: 0.3, len: 0.03, r: 0.012, hang: true, months: [10, 1], mass: 0.006, tip: true },
    show: [{ part: 'acorns', months: [10, 12], color: [0.45, 0.33, 0.18], size: 0.18, per: 0.35 }] },
  // Stone pine (umbrella pine): a clean, plated stem that breaks into several leaders, carrying a flat-topped umbrella.
  { name: 'Stone pine', shape: 'umbrella', phyllo: 'whorl', per: [3, 5], step: 0.7, maxSteps: 10, ang: [82, 76], curve: [0.25, -0.15], kink: 8, stemKink: 2.5,
    bark: 9,
    sub: { n: 4, ang: 45, ratio: 0.42, plane: false, kink: 10 }, sub2: null,
    split: { at: 0.55, n: [3, 5], spread: [32, 48], again: 0.8, p: 0.95, curve: [0.05, 0.3, -0.45, -0.15] }, fork: 0, leaf: 'brush', leafSize: 0.6, reachK: 1.15, rTip: 0.006,
    dead: 0.1, deadLen: 0.4, wood: { E: 7, MOR: 40, sg: 0.5 },
    edible: [{ part: 'pine nuts', where: 'cones', months: [9, 4], use: 'the best of the pine nuts: raw or roasted' }],
    organ: { part: 'cone', minD: 15, zone: [0.5, 1], per: 0.3, len: 0.1, r: 0.045, hang: false, months: [1, 12], mass: 0.3 } },
  // Strawberry tree (madrone kin): a crooked, many-stemmed small tree whose thin red bark peels in curls; white bell
  // flowers and red, warty fruit together in autumn (the fruit takes a year to ripen).
  { name: 'Strawberry tree', shape: 'ovoid', phyllo: 'spiral', step: 0.35, maxSteps: 12, ang: [55, 40], curve: [0.4, 0.1], kink: 18, stemKink: 14, upright: 0.3, stemZig: 16, zig: 14,
    stems: { n: [2, 4], lean: [15, 40], len: [0.6, 0.9], p: 0.85 }, bark: 4, twist: 0.2, lumps: 0.12,
    sub: { n: 5, ang: 45, ratio: 0.5, plane: false, kink: 16 }, sub2: { n: 3, ang: 40, ratio: 0.5 },
    split: { at: 0.4, n: [2, 3], spread: [18, 35], again: 0.5, p: 0.7 }, fork: 0, leaf: 'shell', leafSize: 0.45, reachK: 1.0, rTip: 0.004,
    dead: 0.25, deadLen: 0.4, wood: { E: 8, MOR: 60, sg: 0.7 },
    edible: [{ part: 'fruit', where: 'shoot tips', months: [10, 12], use: 'sweet and mealy when deep red; jam (eaten in excess, mildly intoxicating)' }],
    organ: { part: 'fruit', minD: 5, zone: [0.3, 1], per: 0.5, len: 0.02, r: 0.01, hang: true, months: [10, 12], mass: 0.006, tip: true },
    show: [{ part: 'flowers', months: [10, 12], color: [1.0, 0.96, 0.9], size: 0.35, per: 0.4 }, { part: 'fruit', months: [10, 12], color: [0.92, 0.18, 0.06], size: 0.3, per: 0.6 }] },
  // Larch (drooping, deciduous conifer): a narrow open spire; limbs sweep down and up again, and their branchlets hang;
  // soft tufts of needles that turn gold and fall in autumn.
  { name: 'Larch', shape: 'cone', phyllo: 'spiral', step: 0.5, maxSteps: 18, ang: [96, 70], curve: [-0.5, 0.4], kink: 6, stemKink: 1,
    bark: 9,
    sub: { n: 7, ang: 60, ratio: 0.5, plane: false, kink: 6, hang: 1.0 }, sub2: null, split: null, fork: 0.05, leaf: 'brush', leafSize: 0.42, reachK: 1.05, rTip: 0.005,
    dead: 0.4, deadLen: 0.5, wood: { E: 9.7, MOR: 53, sg: 0.48 },
    edible: [{ part: 'inner bark', where: 'stem', months: [4, 6], use: 'famine food' }, { part: 'gum', where: 'bark wounds', months: [1, 12], use: 'chewed' }],
    organ: { part: 'cone', minD: 10, zone: [0.3, 1], per: 0.4, len: 0.03, r: 0.012, hang: false, months: [9, 12], mass: 0.005 } },
  // Bristlecone (contorted, ancient): a squat, many-limbed tree whose stems twist like rope; most of the trunk is bare,
  // polished deadwood, with living bark in narrow strips; dense foxtails of needles on the live limbs.
  { name: 'Bristlecone', shape: 'ovoid', phyllo: 'spiral', step: 0.3, maxSteps: 12, ang: [72, 50], curve: [0.3, 0.4], kink: 25, stemKink: 20, upright: 0.1, stemZig: 22, zig: 20,
    stems: { n: [1, 2], lean: [25, 55], len: [0.4, 0.8], p: 0.6 }, bark: 8, twist: 0.6, lumps: 0.35, flute: [3, 0.3], swell: 0.45,
    sub: { n: 4, ang: 45, ratio: 0.45, plane: false, kink: 20 }, sub2: null,
    split: { at: 0.3, n: [2, 3], spread: [30, 55], again: 0.5, p: 0.8, curve: [-0.2, 0.2, 0, 0.3] }, fork: 0.3, leaf: 'spray', leafSize: 0.4, reachK: 1.1, rTip: 0.005,
    dead: 0.9, deadLen: 1.0, dieback: 0.35, wood: { E: 7, MOR: 40, sg: 0.5 },
    edible: [{ part: 'seeds', where: 'cones', months: [9, 10], use: 'small pine nuts' }],
    organ: { part: 'cone', minD: 10, zone: [0.3, 1], per: 0.3, len: 0.07, r: 0.025, hang: false, months: [1, 12], mass: 0.02 } },
];
// bark patterns for the original rows (a later addition): birch papery, aspen smooth, pine and spruce scaly plates
ARCH[1].bark = 9; ARCH[3].bark = 7; ARCH[4].bark = 9; ARCH[6].bark = 1;

// relative crown radius at fraction f of the live crown (0 crown base, 1 top)
function envelope(shape, f, d) {
  f = clamp(f, 0, 1);
  switch (shape) {
    case 'cone': return 0.08 + 0.92 * Math.pow(1 - f, 0.95);
    case 'pine': return d < 25 ? 0.1 + 0.9 * Math.pow(1 - f, 0.9) : Math.sqrt(Math.max(0, 1 - ((f - 0.55) / 0.62) ** 2)) * 0.95 + 0.05;
    case 'dome': return Math.sqrt(Math.max(0, 1 - ((f - 0.42) / 0.64) ** 2)) * 0.92 + 0.08;
    case 'ovoid': return Math.pow(Math.max(0, Math.sin(Math.PI * (0.06 + 0.9 * f))), 0.75) * (1 - 0.2 * f) + 0.06;
    case 'spire': return 0.06 + 0.94 * Math.pow(1 - f, 1.3); // narrower toward the top than a fir's cone
    case 'spread': return Math.sqrt(Math.max(0, 1 - ((f - 0.3) / 0.76) ** 2)) * 0.95 + 0.05; // widest low, flat-topped
    case 'umbrella': return f < 0.45 ? 0.15 + 0.85 * Math.pow(f / 0.45, 0.6) : f < 0.8 ? 1 : 0.35 + 0.65 * Math.sqrt(Math.max(0, 1 - ((f - 0.8) / 0.2) ** 2)); // flat-topped, widest high up
    case 'column': return Math.pow(Math.max(0, Math.sin(Math.PI * (0.04 + 0.92 * f))), 0.55) * 0.9 + 0.08; // short and round
  }
  return 1 - f;
}

// ---- small vector helpers
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function rotate(v, k, th) { // Rodrigues: v about unit axis k by th
  const c = Math.cos(th), s = Math.sin(th), kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}
const UP = [0, 1, 0];
function perp(d) { const a = Math.abs(d[1]) < 0.9 ? UP : [1, 0, 0]; return norm(cross(d, a)); }
function bendToward(d, target, th) { // turn d toward target by th (negative: away), never past it
  const k = cross(d, target), s = len3(k); if (s < 1e-6) return d;
  const between = Math.atan2(s, dot(d, target));
  return norm(rotate(d, [k[0] / s, k[1] / s, k[2] / s], th > 0 ? Math.min(th, between) : Math.max(th, between - Math.PI)));
}

// ---- growing
// spec: { sp, d (dbh, cm), h (m), crownLen (m), cr (crown radius, m), seed, forked, age (years, optional) }
export function growPlant(spec) {
  const { sp, d, h, crownLen, cr, seed = 1, forked = false, side = 0 } = spec; // side 0..1: a one-sided crown, reaching toward +x (a gap's light)
  const A = ARCH[sp], rnd = mulberry32(seed >>> 0 || 1);
  const R = (a, b) => a + (b - a) * rnd(), gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.15;
  const age = spec.age ?? Math.max(5, d * 3);
  const hb = Math.max(0.3, h - crownLen), sz = clamp(h / 20, 0.18, 1.5);
  const nodes = [], axes = [];
  const node = (par, p0, p1, ord, axis, st, born) => { nodes.push({ par, p0, p1, ord, axis, st, born, kids: [] }); const i = nodes.length - 1; if (par >= 0) nodes[par].kids.push(i); return i; };

  // grow one axis: n segments from `start` along `dir`, bending by `curve` (total, over the axis) and kinking at random
  function growAxis(par, start, dir, L, ord, st, { curve = [0, 0], kink = 0, maxSeg = 6, segLen = 0.7, born = 0, upright = false, zig = 0 } = {}) {
    const n = clamp(Math.ceil(L / segLen), 1, maxSeg), sl = L / n, ax = { nodes: [], ord, st, L, sl };
    axes.push(ax); const ai = axes.length - 1;
    let p = start, dv = norm(dir), prev = par;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, c = (t < 0.5 ? curve[0] : curve[1]) * 2 / n;
      if (i > 0 || ord > 0) dv = bendToward(dv, UP, c);
      if (kink) { const k = norm(rotate(perp(dv), dv, rnd() * 6.283)); dv = norm(rotate(dv, k, gauss() * kink * D2R)); }
      if (zig && i > 0) { // sympodial: the tip aborts and a side bud takes over, turning the axis to alternate sides
        const sd = cross(dv, UP); if (len3(sd) > 1e-3) dv = norm(rotate(dv, norm(cross(sd, dv)), (i % 2 ? 1 : -1) * zig * R(0.6, 1.25) * D2R));
      }
      if (upright) dv = bendToward(dv, UP, (A.upright ?? 0.6) * Math.acos(clamp(dv[1], -1, 1))); // gravitropism: the leader recovers vertical (weakly in twisted species)
      const q = add(p, dv, sl);
      prev = node(prev, p, q, ord, ai, st, born + (age - born) * (i / n));
      ax.nodes.push(prev); p = q;
    }
    return ai;
  }
  const at = (ai, s) => { // node and point at arclength s along an axis
    const ax = axes[ai], k = clamp(Math.floor(s / ax.sl), 0, ax.nodes.length - 1), nd = nodes[ax.nodes[k]], u = clamp(s / ax.sl - k, 0, 1);
    return { id: ax.nodes[k], p: add(nd.p0, [nd.p1[0] - nd.p0[0], nd.p1[1] - nd.p0[1], nd.p1[2] - nd.p0[2]], u), dir: norm([nd.p1[0] - nd.p0[0], nd.p1[1] - nd.p0[1], nd.p1[2] - nd.p0[2]]) };
  };

  // 1. stem, and co-dominant leaders where the trunk dissolves (decurrent crowns) or forked after leader loss
  const stemSeg = Math.max(0.5, h / 22);
  const split = forked ? { at: R(0.35, 0.7), n: [2, 2], spread: [9, 16], again: 0 } : A.split && rnd() < A.split.p ? A.split : null;
  const ySplit = split ? Math.max(Math.min(hb * 0.95, h * 0.8), h * split.at * R(0.85, 1.15)) : h;
  const stemAxes = [growAxis(-1, [0, 0, 0], UP, split ? ySplit : h, 0, LIVE, { kink: A.stemKink, maxSeg: 40, segLen: stemSeg, upright: true, zig: A.stemZig || 0 })];
  if (split) {
    // a decurrent crown: the trunk carries on as one dominant leader, and the others leave it one after another at
    // staggered heights (sympodial forks), each at its own angle, curving up and kinking; one in a few forks again
    const segL = Math.max(0.4, stemSeg * 0.55), horiz = (az) => [Math.cos(az), 0, Math.sin(az)];
    const top = axes[stemAxes[0]], last = top.nodes[top.nodes.length - 1], p0 = nodes[last].p1;
    const domDir = norm([gauss() * 0.12, 1, gauss() * 0.12]);
    const dom = growAxis(last, p0, domDir, Math.max(0.6, (h * 0.99 - p0[1]) / domDir[1]), 0, LIVE, { curve: [R(-0.1, 0.25), R(0.1, 0.4)], kink: A.kink * 0.6, maxSeg: 24, segLen: segL });
    stemAxes.push(dom);
    const n = Math.round(R(split.n[0], split.n[1] + 0.99) - 0.49), axL = (ai) => axes[ai].sl * axes[ai].nodes.length;
    let s = R(0, 0.3), az = rnd() * 6.283;
    for (let k = 1; k < n; k++) {
      const m = at(dom, Math.min(s, axL(dom) * 0.6)); az += 6.283 / n + gauss() * 0.7;
      if (side) az = Math.atan2(Math.sin(az), Math.cos(az) + side * 1.2); // leaders swing toward the light
      const sp = R(split.spread[0], split.spread[1]) * D2R, dir = norm(add(m.dir.map((q) => q * Math.cos(sp)), horiz(az), Math.sin(sp)));
      const L = (h * R(0.8, 0.96) - m.p[1]) / Math.cos(sp * 0.6);
      if (L > 0.6) {
        const lc = split.curve || [0, 0.35, 0.1, 0.55]; // how the leader bends: [near half min, max, far half min, max] (radians, + up)
        const ai = growAxis(m.id, m.p, dir, L, 0, LIVE, { curve: [R(lc[0], lc[1]), R(lc[2], lc[3])], kink: A.kink * 0.8, maxSeg: 22, segLen: segL, zig: (A.zig || 0) * 0.6 });
        stemAxes.push(ai);
        if (rnd() < split.again) { // a second, smaller fork part way up this leader
          const q = at(ai, L * R(0.3, 0.6)), sp2 = R(14, 28) * D2R, d2 = norm(add(q.dir.map((v) => v * Math.cos(sp2)), horiz(az + R(-1.6, 1.6)), Math.sin(sp2)));
          const L2 = (h * R(0.78, 0.92) - q.p[1]) / Math.cos(sp2 * 0.6);
          if (L2 > 0.6) stemAxes.push(growAxis(q.id, q.p, d2, L2, 0, LIVE, { curve: [R(0, 0.3), R(0.1, 0.5)], kink: A.kink * 0.8, maxSeg: 16, segLen: segL }));
        }
      }
      s += R(0.4, 1.8) * Math.sqrt(sz);
    }
  }

  // 1b. more stems from the base (juniper, olive, willow, strawberry tree): each leans out and wanders like the first.
  // They hang off the first stem segment, so the pipe model fattens the shared base into one swollen bole.
  if (A.stems && rnd() < A.stems.p) {
    const nS = Math.round(R(A.stems.n[0], A.stems.n[1] + 0.99) - 0.49), az0 = rnd() * 6.283;
    for (let k = 0; k < nS; k++) {
      const az = az0 + (k + 0.5) / nS * 6.283 + gauss() * 0.5, lean = R(A.stems.lean[0], A.stems.lean[1]) * D2R;
      const dir = [Math.sin(lean) * Math.cos(az), Math.cos(lean), Math.sin(lean) * Math.sin(az)], L = h * R(A.stems.len[0], A.stems.len[1]);
      const p0 = [Math.cos(az) * 0.04, 0.05, Math.sin(az) * 0.04];
      stemAxes.push(growAxis(axes[stemAxes[0]].nodes[0], p0, dir, L, 0, LIVE, { kink: A.stemKink, maxSeg: 30, segLen: stemSeg, upright: true, zig: A.stemZig || 0 }));
    }
  }
  // 2. limbs on each stem axis: live in the crown, dead (or broken-off stubs) below it
  const yDead = Math.max(0.4, hb * (1 - A.dead));
  const stepY = Math.max(A.step * Math.sqrt(sz), crownLen / A.maxSteps, 0.12);
  const spiral = A.phyllo === 'spiral', limbs = [];
  for (const ai of stemAxes) {
    const ax = axes[ai], L = ax.sl * ax.nodes.length, isMain = ai === stemAxes[0];
    let az = rnd() * 6.283;
    for (let s = (isMain ? Math.min(yDead, hb) : 0.3); s < L - 0.15; s += spiral ? stepY * 0.45 : stepY * R(0.8, 1.2)) {
      const m = at(ai, s), y = m.p[1];
      if (y > h - 0.1) break;
      let count = A.phyllo === 'whorl' ? Math.round(R(A.per[0], A.per[1])) : A.phyllo === 'opposite' ? 2 : 1;
      az += A.phyllo === 'opposite' ? Math.PI / 2 : spiral ? PHI : rnd() * 6.283;
      const live = y >= hb, f = (y - hb) / Math.max(0.5, h - hb);
      if (!live) { // below the live crown: shed in shade, some kept dead, some broken to stubs
        const keep = A.dead * Math.sqrt(clamp((y - yDead) / Math.max(0.3, hb - yDead), 0, 1));
        if (!isMain || y < yDead) continue;
        count = Math.max(1, Math.round(count * (rnd() < keep ? 1 : 0.5)));
        for (let k = 0; k < count; k++) {
          const a = az + (k / count) * 6.283 + gauss() * 0.3, ang = R(85, 105) * D2R;
          const dir = [Math.sin(ang) * Math.cos(a), Math.cos(ang), Math.sin(ang) * Math.sin(a)];
          if (rnd() < keep) limbs.push(growAxis(m.id, m.p, dir, A.deadLen * sz * R(0.5, 1.2) * (0.5 + 0.5 * clamp(y / hb, 0, 1)) + 0.1, 1, DEAD, { kink: A.kink, maxSeg: 2, segLen: 0.6, born: age * (y / h) }));
          else if (rnd() < 0.35) growAxis(m.id, m.p, dir, R(0.04, 0.12) * Math.sqrt(sz) + 0.03, 1, STUB, { maxSeg: 1, born: age * (y / h) });
        }
        continue;
      }
      const reachTo = cr * envelope(A.shape, f, d);
      for (let k = 0; k < count; k++) {
        const a = az + (k / count) * 6.283 + gauss() * 0.25;
        const ang = (A.ang[0] + (A.ang[1] - A.ang[0]) * f + gauss() * 7) * D2R;
        let dir = [Math.sin(ang) * Math.cos(a), Math.cos(ang), Math.sin(ang) * Math.sin(a)];
        const rad = Math.hypot(m.p[0], m.p[2]);
        if (rad > 0.25 && (dir[0] * m.p[0] + dir[2] * m.p[2]) / rad < -0.25 * Math.sin(ang)) continue; // don't grow back into the crown
        const toLight = side ? Math.cos(a) : 0; // a one-sided crown: limbs toward the gap grow long, those on the shaded side short or not at all
        if (side && toLight < 0 && rnd() < side * 0.55 * -toLight) continue;
        const reach = Math.max(0.12, reachTo * (1 + side * 0.55 * toLight) - rad * 0.8);
        const Lb = Math.min(reach / Math.max(0.35, Math.sin(ang)) * R(0.85, 1.12) * A.reachK, cr * 1.8 * (1 + 0.4 * side));
        if (Lb < 0.12) continue;
        const sag = (A.sag || 0) * clamp(Lb / 3, 0, 2) * Math.sin(ang); // long, level limbs bow under their own weight
        const lst = A.dieback && rnd() < A.dieback ? DEAD : LIVE; // dieback: limbs killed by drought or cambium loss, kept bare in the crown
        limbs.push(growAxis(m.id, m.p, dir, Lb, 1, lst, { curve: [A.curve[0] * (0.6 + 0.4 * Lb / 3), A.curve[1] - sag], kink: A.kink, zig: A.zig || 0, maxSeg: 6, segLen: Math.max(0.35, 0.75 * sz), born: age * (y / h) }));
      }
    }
  }
  // 3. branches on limbs, and shoots on branches (where the species has them)
  const sideBranches = (parentAxes, B, ord, maxL) => {
    const out = [];
    for (const ai of parentAxes) {
      const ax = axes[ai], L = ax.L; if (L < 0.3) continue;
      const n = clamp(Math.round(L / (0.42 * Math.sqrt(sz) + 0.12)), 1, B.n), st = ax.st;
      if (ax.st === STUB) continue;
      for (let k = 0; k < n; k++) {
        const s = L * (0.18 + 0.75 * (k + R(0.2, 0.8)) / n), m = at(ai, s);
        const rr = R(0.7, 1.3), Lc = B.hangAll && st === LIVE ? maxL * (rr - 0.25) * clamp(L / 2, 0.4, 1) // weeping whips: long wherever they start
          : Math.min((B.ratio * (L - s) * rr + 0.12) * (st === DEAD ? 0.5 : 1), maxL);
        if (Lc < 0.1) continue;
        const pd = m.dir, side = norm(cross(pd, UP).every((q) => Math.abs(q) < 1e-6) ? [1, 0, 0] : cross(pd, UP));
        let pp;
        if (B.plane) pp = add(side, UP, 0.12 * (k % 2 ? 1 : -1)).map((q) => q * (k % 2 ? 1 : -1));
        else { const up2 = norm(cross(side, pd)), a = k * PHI + rnd() * 0.8; pp = add(side.map((q) => q * Math.cos(a)), up2, Math.sin(a)); if (pp[1] < -0.55) pp = pp.map((q) => -q); }
        const ang = (B.ang + gauss() * 8) * D2R; let dir = norm(add(pd.map((q) => q * Math.cos(ang)), pp, Math.sin(ang)));
        const hang = B.hang && st === LIVE ? B.hang * (B.hangAll ? 1 : clamp((L - 0.6) / 1.8, 0, 1)) : 0; // curtains hang from long limbs; short ones near the top keep theirs level
        if (hang) dir = bendToward(dir, [0, -1, 0], hang * R(0.7, 1.2));
        const curve = hang ? [-0.15 * hang, -0.1 * hang] : [A.curve[0] * 0.5, A.curve[1] * 0.6];
        out.push(growAxis(m.id, m.p, dir, Lc, ord, st, { curve, kink: (B.kink ?? A.kink), zig: B.zig || 0, maxSeg: B.seg || (ord === 2 ? 2 : 1), segLen: 0.5, born: nodes[m.id].born + 1 }));
      }
    }
    return out;
  };
  const branches = sideBranches(limbs, A.sub, 2, 2.6 * Math.sqrt(sz) * (A.sub.maxK || 1));
  const shoots = A.sub2 ? sideBranches(branches.filter((ai) => axes[ai].st === LIVE), A.sub2, 3, 1.0) : [];

  // 4. radii from the pipe model, the exponent fitted so the stem at breast height matches dbh
  const n = nodes.length, W = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { const nd = nodes[i]; W[i] += nd.kids.length ? 0 : nd.st === LIVE ? 1 : nd.st === DEAD ? 0.35 : 0.15; if (nd.par >= 0) W[nd.par] += W[i]; }
  const sAx = axes[stemAxes[0]], bh = sAx.nodes[clamp(Math.floor(Math.min(1.3, h * 0.3) / sAx.sl), 0, sAx.nodes.length - 1)];
  const rbh = d / 200, rTip = A.rTip * clamp(Math.sqrt(sz), 0.6, 1.2);
  const a = clamp(Math.log(Math.max(2, W[bh])) / Math.log(Math.max(1.5, rbh / rTip)), 1.8, 3.2);
  const k = rbh / (rTip * Math.pow(W[bh], 1 / a));
  const r0 = new Float32Array(n), r1 = new Float32Array(n);
  for (let i = 0; i < n; i++) r0[i] = rTip * k * Math.pow(W[i], 1 / a);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i], cont = nd.kids.find((c) => nodes[c].axis === nd.axis);
    r1[i] = cont !== undefined ? r0[cont] : nd.kids.length ? r0[i] * 0.97 : nd.st === STUB ? r0[i] * 0.9 : Math.max(0.0015, rTip * k * 0.6); // a fork: the stem keeps its girth into the leaders
  }

  // 5. foliage units and organs, on live shoots
  const leaves = [], organs = [];
  const unit = (id, u, size) => leaves.push({ node: id, u, kind: A.leaf, size });
  const tipOrder = A.sub2 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]; if (nd.st !== LIVE || nd.ord === 0 && nd.p1[1] < h - 0.8) continue;
    const L = len3([nd.p1[0] - nd.p0[0], nd.p1[1] - nd.p0[1], nd.p1[2] - nd.p0[2]]), terminal = !nd.kids.some((c) => nodes[c].axis === nd.axis);
    const s = A.leafSize * clamp(0.65 + 0.35 * sz, 0.55, 1.2);
    if (A.leaf === 'spray') { // flat sprays all along young shoots: on branches, and on the outer part of limbs
      if (nd.ord >= 2 || (nd.ord === 1 && (terminal || rnd() < 0.6)) || nd.ord === 0) for (let u = 0.5 / Math.ceil(L / s); u < 1; u += 1 / Math.ceil(L / s)) unit(i, u, s * R(0.85, 1.2));
    } else if (A.leaf === 'brush') { // tufts at the ends of shoots; the inner crown is bare
      if (terminal && nd.ord >= 1) { unit(i, 1, s * R(0.9, 1.2)); unit(i, 0.45, s * R(0.8, 1.0)); }
      else if (nd.ord === 0) unit(i, 1, s);
    } else if (A.leaf === 'shell' || A.leaf === 'pend') { // leaves clustered at shoot tips and along the outer shoots
      if (nd.ord >= tipOrder - 1 && terminal) { unit(i, 1, s * R(0.9, 1.25)); if (L > s * 0.8) unit(i, 0.45, s * R(0.75, 1.05)); }
      else if (nd.ord === tipOrder - 1 && rnd() < 0.5) unit(i, R(0.3, 0.9), s * R(0.7, 1));
      else if (nd.ord === 0 && terminal) unit(i, 1, s);
    }
    const O = A.organ, fy = (nd.p1[1] - hb) / Math.max(0.5, h - hb);
    if (O && d >= O.minD && nd.ord >= 1 && fy >= O.zone[0] && fy <= O.zone[1] && (!O.tip || terminal) && rnd() < O.per * (A.leaf === 'spray' && !terminal ? 0.4 : 1))
      organs.push({ node: i, u: O.tip ? 1 : R(0.6, 1), part: O.part, len: O.len, r: O.r, hang: O.hang, months: O.months, mass: O.mass });
  }

  // 6. pack: struct of arrays
  const P = {
    sp, d, h, crownLen, cr, hb, seed, n, a, age,
    par: new Int32Array(n), p0: new Float32Array(n * 3), p1: new Float32Array(n * 3), r0, r1,
    ord: new Int8Array(n), axis: new Int32Array(n), st: new Uint8Array(n), born: new Float32Array(n),
    axes: axes.map((ax) => ({ nodes: Int32Array.from(ax.nodes), ord: ax.ord, st: ax.st })), leaves, organs,
  };
  nodes.forEach((nd, i) => { P.par[i] = nd.par; P.p0.set(nd.p0, i * 3); P.p1.set(nd.p1, i * 3); P.ord[i] = nd.ord; P.axis[i] = nd.axis; P.st[i] = nd.st; P.born[i] = nd.born; });
  return P;
}

// ---- summary numbers, for the specimen gym and tests
export function plantStats(P) {
  let live = 0, dead = 0, stubs = 0, lowLive = Infinity, maxR = 0, top = 0;
  for (let i = 0; i < P.n; i++) {
    const y = Math.min(P.p0[i * 3 + 1], P.p1[i * 3 + 1]);
    if (P.st[i] === LIVE) live++; else if (P.st[i] === DEAD) dead++; else if (P.st[i] === STUB) stubs++;
    if (P.st[i] === LIVE && P.ord[i] === 1 && y < lowLive) lowLive = y;
    maxR = Math.max(maxR, Math.hypot(P.p1[i * 3], P.p1[i * 3 + 2])); top = Math.max(top, P.p1[i * 3 + 1]);
  }
  let hash = 2166136261; for (let i = 0; i < P.n * 3; i++) hash = Math.imul(hash ^ Math.round(P.p1[i] * 1000), 16777619) >>> 0;
  return { segments: P.n, live, dead, stubs, leaves: P.leaves.length, organs: P.organs.length, pipeExp: +P.a.toFixed(2), lowestLiveLimb: +lowLive.toFixed(2), crownR: +maxR.toFixed(2), top: +top.toFixed(2), hash };
}

// ---- geometry: plain arrays (positions in metres, plant-local); the game wraps them in buffers and scales them
// Bark: a tapered tube per axis, rings at each node; the stem flares at the collar.
export function barkMesh(P, { minR = 0 } = {}) {
  const pos = [], nor = [], uv = [], idx = [], node = []; // node: the segment each vertex belongs to (a break removes a subtree's vertices)
  // rough stems (ARCH lumps, flute, twist, swell): the radius is modulated round and along the stem, burls as a few
  // interfering waves, flutes as ridges, both turning with the spiral grain; the base swells like a bottle
  const AR = ARCH[P.sp], lumps = AR.lumps || 0, fl = AR.flute, tw = AR.twist || 0, swell = AR.swell || 0;
  const ph1 = (P.seed * 1.618) % 6.283, ph2 = (P.seed * 2.414) % 6.283, ph3 = (P.seed * 0.577) % 6.283;
  let axi = 0;
  for (const ax of P.axes) {
    const ids = ax.nodes, i0 = ids[0]; axi++;
    if (ax.st === LIVE && ax.ord >= 2 && P.r0[i0] < minR) continue; // thin live twigs: hidden in the foliage
    const rb = P.r0[i0], rough = (lumps || fl || swell) && (ax.ord === 0 || (ax.ord === 1 && rb > 0.05)) ? (ax.ord === 0 ? 1 : 0.45) : 0;
    const sides = rough && ax.ord === 0 && rb > 0.04 ? 12 : rough && rb > 0.06 ? 8 : rb > 0.12 ? 7 : rb > 0.04 ? 5 : 3;
    const pts = [], rad = [], rn = []; let skipTo = -1;
    const p = (i, e) => (e ? [P.p1[i * 3], P.p1[i * 3 + 1], P.p1[i * 3 + 2]] : [P.p0[i * 3], P.p0[i * 3 + 1], P.p0[i * 3 + 2]]);
    if (ax.ord === 0 && P.par[i0] < 0) { // the collar: extra rings for the root flare
      const a = p(i0, 0), b = p(i0, 1), L = len3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      for (const y of [0, 0.08, 0.22, 0.45]) if (y < L * 0.8) { const t = y / L; skipTo = y; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); rad.push((P.r0[i0] + (P.r1[i0] - P.r0[i0]) * t) * (1 + 0.3 * Math.exp(-y / 0.25))); rn.push(i0); } // modest: the buttress roots make the rest of the flare
    } else { pts.push(p(i0, 0)); rad.push(P.r0[i0]); rn.push(i0); }
    for (const i of ids) {
      if (rough) { // rough stems: extra rings within each segment, so burls along the stem are resolved (about every 0.18 m)
        const a = p(i, 0), b = p(i, 1), L = len3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), k = clamp(Math.ceil(L / 0.18), 1, ax.ord === 0 ? 8 : 3);
        for (let q = 1; q < k; q++) { const t = q / k; if (i === i0 && t * L <= skipTo + 0.05) continue; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); rad.push(P.r0[i] + (P.r1[i] - P.r0[i]) * t); rn.push(i); }
      }
      pts.push(p(i, 1)); rad.push(P.r1[i]); rn.push(i);
    }
    const base = pos.length / 3;
    let nPrev = null, vacc = 0, sacc = 0;
    for (let j = 0; j < pts.length; j++) {
      const t = norm(j < pts.length - 1 ? [pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1], pts[j + 1][2] - pts[j][2]] : [pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1], pts[j][2] - pts[j - 1][2]]);
      let nv = nPrev ? norm(add(nPrev, t, -dot(nPrev, t))) : perp(t); if (len3(nv) < 0.5) nv = perp(t);
      const bv = cross(t, nv); nPrev = nv;
      if (j > 0) { const dl = len3([pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1], pts[j][2] - pts[j - 1][2]]); vacc += dl / Math.max(0.3, rad[0] * 6.283) * 0.5; sacc += dl; }
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * 6.283, c = Math.cos(a), sn = Math.sin(a), dn = [nv[0] * c + bv[0] * sn, nv[1] * c + bv[1] * sn, nv[2] * c + bv[2] * sn];
        let rr = rad[j];
        if (rough) {
          const g = a + tw * sacc, big = Math.min(1, rad[j] / 0.05);
          let m = 1 + rough * big * (lumps * (0.55 * Math.sin(3 * g + 1.9 * sacc + ph1) * Math.sin(1.3 * sacc + ph2 + axi) + 0.45 * Math.sin(5 * g - 2.7 * sacc + ph3 + axi))
            + (fl ? fl[1] * Math.cos(fl[0] * g) : 0));
          if (ax.ord === 0) m *= 1 + swell * Math.exp(-Math.max(0, pts[j][1]) / 1.0);
          rr *= Math.max(0.5, m);
        }
        pos.push(pts[j][0] + dn[0] * rr, pts[j][1] + dn[1] * rr, pts[j][2] + dn[2] * rr); nor.push(...dn); uv.push(s / sides + tw * sacc / 6.283, vacc); node.push(rn[j]);
      }
    }
    if (rough) for (let j = 0; j < pts.length; j++) for (let s = 0; s <= sides; s++) { // normals from the bumped surface
      const V = (jj, ss) => (base + clamp(jj, 0, pts.length - 1) * (sides + 1) + ((ss + sides) % sides)) * 3;
      const a0 = V(j, s - 1), a1 = V(j, s + 1), b0 = V(j - 1, s), b1 = V(j + 1, s), q = V(j, s);
      const T = [pos[a1] - pos[a0], pos[a1 + 1] - pos[a0 + 1], pos[a1 + 2] - pos[a0 + 2]], B = [pos[b1] - pos[b0], pos[b1 + 1] - pos[b0 + 1], pos[b1 + 2] - pos[b0 + 2]];
      let nn = norm(cross(T, B)); const o = base * 3 + (j * (sides + 1) + s) * 3;
      if (dot(nn, [nor[o], nor[o + 1], nor[o + 2]]) < 0) nn = nn.map((v) => -v);
      if (len3(nn) > 0.5) { nor[o] = nn[0]; nor[o + 1] = nn[1]; nor[o + 2] = nn[2]; }
      void q;
    }
    for (let j = 0; j < pts.length - 1; j++) for (let s = 0; s < sides; s++) {
      const a = base + j * (sides + 1) + s, b = a + sides + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // organs that are woody enough to draw with the bark: cones
  for (const o of P.organs) {
    if (o.part !== 'cone') continue;
    const i = o.node, q = [P.p0[i * 3] + (P.p1[i * 3] - P.p0[i * 3]) * o.u, P.p0[i * 3 + 1] + (P.p1[i * 3 + 1] - P.p0[i * 3 + 1]) * o.u, P.p0[i * 3 + 2] + (P.p1[i * 3 + 2] - P.p0[i * 3 + 2]) * o.u];
    const dir = o.hang ? [0, -1, 0] : [0, 1, 0], b0 = pos.length / 3, nv = [1, 0, 0], bv = [0, 0, 1];
    for (const [t, rr] of [[0, o.r * 0.6], [0.5, o.r], [1, o.r * 0.4]]) for (let s = 0; s <= 4; s++) {
      const a = (s / 4) * 6.283, dn = [nv[0] * Math.cos(a) + bv[0] * Math.sin(a), 0, nv[2] * Math.cos(a) + bv[2] * Math.sin(a)];
      pos.push(q[0] + dn[0] * rr, q[1] + dir[1] * o.len * 2 * t, q[2] + dn[2] * rr); nor.push(...dn); uv.push(s / 4, t); node.push(i);
    }
    for (let j = 0; j < 2; j++) for (let s = 0; s < 4; s++) { const a = b0 + j * 5 + s, b = a + 5; if (o.hang) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  return { pos, nor, uv, idx, node, tris: idx.length / 3 };
}

// Foliage: cards ({c, u, v, n, ao0, ao1}; u, v half-extent vectors) from the foliage units, oriented by leaf kind.
// Normals radiate from the crown's axis so the crown shades as a volume; a crown-depth gradient darkens the inside.
export const inMonths = (m, [a, b]) => (a <= b ? m >= a && m <= b : m >= a || m <= b); // ranges may wrap the new year
// month (1-12): flowers and fruit (ARCH.show) in season are added as tinted cards ({tint: sRGB colour, part}).
export function foliageCards(P, seed = 7, { month = 0 } = {}) {
  const rnd = mulberry32(seed), cards = [], A = ARCH[P.sp];
  const shows = month ? (A.show || []).filter((q) => inMonths(month, q.months) && P.d >= 3) : [];
  for (const L of P.leaves) {
    const i = L.node, u = L.u, c0 = cards.length;
    const a = [P.p0[i * 3], P.p0[i * 3 + 1], P.p0[i * 3 + 2]], b = [P.p1[i * 3], P.p1[i * 3 + 1], P.p1[i * 3 + 2]];
    const t = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), c = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    const rad = Math.hypot(c[0], c[2]), f = clamp((c[1] - P.hb) / Math.max(0.5, P.h - P.hb), 0, 1);
    const env = Math.max(0.3, P.cr * envelope(A.shape, f, P.d));
    const out = rad > 1e-3 ? [c[0] / rad, 0, c[2] / rad] : [1, 0, 0];
    const nC = norm([out[0], 0.55 + 0.4 * f, out[2]]);
    const ao = clamp(0.42 + 0.45 * Math.min(1, rad / env) + 0.25 * f, 0.35, 1.05);
    const s = L.size;
    const side = norm(Math.abs(t[1]) > 0.97 ? [1, 0, 0] : cross(t, UP));
    if (L.kind === 'spray') { // a flat spray in the shoot's plane, centred a little out along it
      const cc = add(c, t, s * 0.35), fl = norm(add(side, UP, (rnd() - 0.5) * 0.25));
      cards.push({ c: cc, u: t.map((q) => q * s * 0.6), v: fl.map((q) => q * s * 0.42), n: nC, ao0: ao * 0.85, ao1: ao });
      if (rnd() < 0.5) { const tl = norm(add(t, UP, 0.5)); cards.push({ c: add(cc, UP, 0.03), u: tl.map((q) => q * s * 0.45), v: fl.map((q) => q * s * 0.35), n: nC, ao0: ao * 0.8, ao1: ao }); }
    } else if (L.kind === 'brush') { // crossed cards around the shoot axis, the tuft curving up
      const ax = norm(add(t, UP, 0.6)), cc = add(c, ax, s * 0.2), p0 = side, p1 = norm(cross(ax, p0));
      for (const w of [p0, p1, norm(add(p0, p1))]) cards.push({ c: cc, u: w.map((q) => q * s * 0.55), v: ax.map((q) => q * s * 0.55), n: nC, ao0: ao * 0.8, ao1: ao });
    } else if (L.kind === 'pend') { // a hanging clump: the card's long axis droops from the shoot tip
      const hang = norm(add(add(t, UP, -1.8), side, (rnd() - 0.5) * 0.6)), cc = add(c, hang, s * 0.45);
      const w = norm(cross(hang, out[0] || out[2] ? out : [1, 0, 0]));
      cards.push({ c: cc, u: w.map((q) => q * s * 0.42), v: hang.map((q) => q * s * 0.55), n: nC, ao0: ao * 0.8, ao1: ao });
      if (rnd() < 0.6) { const w2 = norm(add(w, out, 1)); cards.push({ c: add(cc, out, 0.04), u: w2.map((q) => q * s * 0.36), v: hang.map((q) => q * s * 0.5), n: nC, ao0: ao * 0.8, ao1: ao }); }
    } else { // shell: leaf clusters facing out toward the light
      const face = norm([out[0] + (rnd() - 0.5) * 0.9, 0.6 + rnd() * 0.5, out[2] + (rnd() - 0.5) * 0.9]);
      for (let k = 0; k < 2; k++) {
        const p0 = norm(cross(face, Math.abs(face[1]) > 0.95 ? [1, 0, 0] : UP)), p1 = cross(face, p0), an = rnd() * Math.PI;
        const U = add(p0.map((q) => q * Math.cos(an)), p1, Math.sin(an)), V = add(p0.map((q) => q * -Math.sin(an)), p1, Math.cos(an));
        cards.push({ c: add(add(c, t, s * 0.2), face, k * 0.06), u: U.map((q) => q * s * 0.5), v: V.map((q) => q * s * 0.5), n: nC, ao0: ao * 0.85, ao1: ao });
      }
    }
    if (shows.length) for (const q of shows) {
      const z = s * q.size, small = q.size < 0.45;
      if (!(L.u >= 0.9 || L.kind === 'spray' || L.kind === 'brush' || !small) || rnd() > q.per) continue; // flower heads all over the crown; fruit at the tips // small: berries and fruit hang in a bunch; large: flower heads face out
      const cc = add(add(c, out, s * (small ? 0.15 : 0.3)), UP, small ? -s * 0.12 : s * 0.1);
      for (let k = 0; k < 2; k++) {
        const face = small ? norm([out[0] + (rnd() - 0.5) * 1.5, (rnd() - 0.5) * 0.6, out[2] + (rnd() - 0.5) * 1.5]) : norm([out[0] + (rnd() - 0.5) * 0.8, 0.7 + rnd() * 0.5, out[2] + (rnd() - 0.5) * 0.8]);
        const p0 = norm(cross(face, Math.abs(face[1]) > 0.95 ? [1, 0, 0] : UP)), p1 = cross(face, p0), an = rnd() * Math.PI;
        const U = add(p0.map((v) => v * Math.cos(an)), p1, Math.sin(an)), V = add(p0.map((v) => v * -Math.sin(an)), p1, Math.cos(an));
        cards.push({ c: add(cc, face, k * 0.03), u: U.map((v) => v * z * 0.5), v: V.map((v) => v * z * 0.5), n: nC, ao0: ao, ao1: Math.min(1.1, ao * 1.1), tint: q.color, part: q.part });
      }
    }
    for (let k = c0; k < cards.length; k++) cards[k].node = i;
  }
  return cards;
}

// ---- roots
// Structural roots in surface-relative coordinates: x, z from the stem centre (world-aligned), y = height of the root's
// axis above the local ground surface (negative: buried). The game drapes them over its own terrain and rock, so a
// root follows the ground the way real lateral roots do. Shape rules [known in outline]: a few structural laterals
// radiate from the collar, taper fast within the "zone of rapid taper" (about 1-2 m) and then run on as thin ropes;
// sinker roots drop from them; pine adds a taproot. Exposure [model choice, numbers are guesses]: every root is out of
// the ground at the collar (the flare), and how far it stays out depends on the site: shallow soil over rock, wet
// ground (shallow rooting) and the downhill side of a slope (erosion) keep roots at the surface for longer.
export const ROOTS = [
  { n: [5, 8], depthRate: 0.1, tap: 0, sinkers: 0.35, expose: 0.0 },  // fir: a shallow plate
  { n: [4, 6], depthRate: 0.16, tap: 1, sinkers: 0.5, expose: -0.1 }, // pine: deeper, with a taproot
  { n: [6, 9], depthRate: 0.14, tap: 0, sinkers: 0.6, expose: 0.0 },  // maple: a heart-shaped mass
  { n: [5, 8], depthRate: 0.08, tap: 0, sinkers: 0.2, expose: 0.1 },  // birch: shallow, spreading
  { n: [5, 8], depthRate: 0.06, tap: 0, sinkers: 0.15, expose: 0.18 }, // spruce: a thin, shallow plate (why spruce blows over)
  { n: [5, 7], depthRate: 0.2, tap: 1, sinkers: 0.7, expose: -0.15 }, // oak: deep, a taproot and many sinkers
  { n: [4, 6], depthRate: 0.09, tap: 0, sinkers: 0.3, expose: 0.05 },  // aspen: shallow, wide-running laterals
  { n: [6, 9], depthRate: 0.06, tap: 0, sinkers: 0.3, expose: 0.25 },  // willow: a mat of shallow roots along wet banks
  { n: [5, 8], depthRate: 0.12, tap: 1, sinkers: 0.6, expose: 0.35 },  // juniper: gripping rock, deep where cracks allow
  { n: [4, 6], depthRate: 0.12, tap: 0, sinkers: 0.4, expose: 0.0 },   // cherry
  { n: [4, 7], depthRate: 0.1, tap: 0, sinkers: 0.4, expose: 0.2 },    // rowan: wedged among rocks
  { n: [6, 9], depthRate: 0.1, tap: 0, sinkers: 0.5, expose: 0.25 },   // plane: big buttress roots along streams
  { n: [5, 8], depthRate: 0.14, tap: 1, sinkers: 0.5, expose: 0.3 },   // olive: a knotted stool of surface roots
  { n: [5, 7], depthRate: 0.2, tap: 1, sinkers: 0.6, expose: 0.0 },    // cork oak: deep
  { n: [4, 6], depthRate: 0.18, tap: 1, sinkers: 0.5, expose: 0.05 },  // stone pine: a taproot in sand
  { n: [5, 8], depthRate: 0.1, tap: 0, sinkers: 0.4, expose: 0.15 },   // strawberry tree
  { n: [4, 6], depthRate: 0.14, tap: 1, sinkers: 0.5, expose: 0.0 },   // larch: deeper than spruce
  { n: [4, 7], depthRate: 0.1, tap: 1, sinkers: 0.4, expose: 0.45 },   // bristlecone: roots crawling over bare rock
];
// spec: { sp, d, seed, soil 0..1, slope [dh/dx, dh/dz], wet 0..1, rocky 0..1 }
export function growRoots(spec) {
  const { sp, d, seed = 1, soil = 0.6, slope = [0, 0], wet = 0.3, rocky = 0 } = spec;
  const T = ROOTS[sp], rnd = mulberry32((seed ^ 0x5bd1e995) >>> 0 || 1), R = (a, b) => a + (b - a) * rnd(), gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.15;
  const rStem = d / 200, rp = plateRadius(d, soil), zrt = 0.5 + 0.015 * d;
  const site = clamp(0.3 + 0.5 * (1 - soil) + 0.3 * wet + 0.4 * rocky + T.expose, 0, 1), buttress = 0.6 + 0.03 * d;
  const Lexp = 0.5 + 2.0 * (1 - soil) + 1.5 * rocky + 0.8 * wet;
  const nodes = [], axes = [];
  const seg = (par, p0, p1, r0, r1, ord, axis) => { nodes.push({ par, p0, p1, r0, r1, ord, axis }); return nodes.length - 1; };
  // one root: a wandering path; y follows the exposure law; returns its axis id
  function root(par, start, az, L, r0, ord, e0, depth0) {
    const ax = { nodes: [], ord }; axes.push(ax); const ai = axes.length - 1;
    let s = 0, p = start, prev = par, i = 0;
    const yAt = (s, r) => { const e = Math.max(e0 * Math.exp(-s / Lexp), ord === -1 ? Math.sqrt(Math.max(0, 1 - s / buttress)) : 0); return r * e - (1 - e) * (r + Math.min(0.3, depth0 + s * T.depthRate * (0.5 + soil))); };
    const rAt = (s) => r0 * (0.18 + 0.82 * Math.exp(-s / zrt)) * (1 - 0.6 * s / L);
    while (s < L - 1e-3) {
      const sl = Math.min(L - s, Math.min(0.8, 0.2 * Math.pow(1.3, i))); az += gauss() * 0.16;
      const s1 = s + sl, ra = rAt(s), rb = rAt(s1);
      const q = [p[0] + Math.cos(az) * sl, 0, p[2] + Math.sin(az) * sl]; q[1] = yAt(s1, rb);
      const p0 = [p[0], i === 0 && ord === -1 ? Math.max(p[1], rStem * 0.35) : yAt(s, ra), p[2]]; // laterals leave the stem above the ground: the buttress
      prev = seg(prev, p0, q, ra, rb, ord, ai); ax.nodes.push(prev);
      if (ord === -1 && s > 0.4 && rnd() < 0.3) branches.push([prev, q, az + (rnd() < 0.5 ? -1 : 1) * R(0.5, 1.2), Math.min(L - s1, R(0.4, 1.4)), rb * R(0.4, 0.6), e0 * 0.5, Math.max(0, -q[1] - rb)]);
      if (ord === -1 && Math.abs(s - rp * 0.7) < sl / 2 + 0.01 && rnd() < T.sinkers) sinkers.push([prev, q, rb * 0.6]);
      p = q; s = s1; i++;
    }
    return ai;
  }
  const branches = [], sinkers = [];
  const n = Math.round(R(T.n[0], T.n[1] + 0.99) - 0.49), az0 = rnd() * 6.283;
  for (let k = 0; k < n; k++) {
    const az = az0 + (k / n) * 6.283 + gauss() * 0.3, dir = [Math.cos(az), Math.sin(az)];
    const downhill = -(slope[0] * dir[0] + slope[1] * dir[1]); // > 0 when the ground falls away along this root
    const e0 = clamp(site + 1.1 * downhill - 0.5 * Math.max(0, -downhill) + gauss() * 0.15, 0, 1);
    root(-1, [dir[0] * rStem * 0.55, 0, dir[1] * rStem * 0.55], az, rp * R(1.2, 2.3) + 0.3, rStem * R(0.55, 0.8) * Math.sqrt(6 / n), -1, e0, 0.02);
  }
  for (const [par, q, az, L, r0, e0, dep] of branches) if (L > 0.25) root(par, q, az, L, r0, -2, e0, dep);
  const down = (par, top, r, depth) => { const ax = { nodes: [], ord: -3 }; axes.push(ax); ax.nodes.push(seg(par, top, [top[0] + gauss() * 0.1, top[1] - depth, top[2] + gauss() * 0.1], r, r * 0.4, -3, axes.length - 1)); };
  for (const [par, q, r] of sinkers) down(par, q, r, R(0.3, 0.9) * (0.4 + soil));
  if (T.tap) down(-1, [0, -0.1, 0], rStem * 0.45, (0.6 + 0.9 * soil) * R(0.8, 1.2));
  const N = nodes.length, P = { sp, d, rp, n: N, par: new Int32Array(N), p0: new Float32Array(N * 3), p1: new Float32Array(N * 3), r0: new Float32Array(N), r1: new Float32Array(N), ord: new Int8Array(N), axis: new Int32Array(N), st: new Uint8Array(N), axes: axes.map((a) => ({ nodes: Int32Array.from(a.nodes), ord: a.ord })) };
  nodes.forEach((s, i) => { P.par[i] = s.par; P.p0.set(s.p0, i * 3); P.p1.set(s.p1, i * 3); P.r0[i] = s.r0; P.r1[i] = s.r1; P.ord[i] = s.ord; P.axis[i] = s.axis; P.st[i] = s.p0[1] + s.r0 > 0 || s.p1[1] + s.r1 > 0 ? LIVE : BURIED; });
  return P;
}

// Tubes for roots. place(x, y, z, r) -> [wx, wy, wz, gy]: where a root point ends up in the world and the ground height
// there (the game drapes roots over terrain and rock). Only runs that break the surface are built, plus one buried
// segment at each end so they dive into the soil. keep(i) can drop segments (a root wad keeps what tore out with it).
// Root sections are flattened (wider than tall), as surface roots are. col: soil staining, darker near the ground.
export function rootMesh(P, place, { keep = null, all = false, flat = 0.72 } = {}) {
  const pos = [], nor = [], uv = [], col = [], idx = [], solids = [], node = []; // node: the segment whose end each ring sits at (P.n: a fixed point)
  for (const ax of P.axes) {
    const ids = Array.from(ax.nodes).filter((i) => !keep || keep(i)); if (!ids.length) continue;
    const W = ids.map((i) => [place(P.p0[i * 3], P.p0[i * 3 + 1], P.p0[i * 3 + 2], P.r0[i]), place(P.p1[i * 3], P.p1[i * 3 + 1], P.p1[i * 3 + 2], P.r1[i])]);
    const out = ids.map((i, k) => all || W[k][0][1] + P.r0[i] > W[k][0][3] + 0.005 || W[k][1][1] + P.r1[i] > W[k][1][3] + 0.005);
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k], [a, b] = W[k], prot = Math.max(a[1] + P.r0[i] - a[3], b[1] + P.r1[i] - b[3]);
      if (out[k] && !all && prot > 0.035 && P.r0[i] > 0.02) solids.push({ x0: a[0], y0: a[1], z0: a[2], x1: b[0], y1: b[1], z1: b[2], r: (P.r0[i] + P.r1[i]) / 2 });
    }
    let k = 0;
    while (k < ids.length) {
      if (!out[k]) { k++; continue; }
      let e = k; while (e + 1 < ids.length && out[e + 1]) e++;
      const s0 = Math.max(0, k - 1), s1 = Math.min(ids.length - 1, e + 1); // one buried segment either side
      const pts = [W[s0][0]], rad = [P.r0[ids[s0]]], rn = [P.par[ids[s0]] >= 0 && (!keep || keep(P.par[ids[s0]])) ? P.par[ids[s0]] : P.n];
      for (let j = s0; j <= s1; j++) { pts.push(W[j][1]); rad.push(P.r1[ids[j]]); rn.push(ids[j]); }
      const sides = rad[0] > 0.06 ? 6 : rad[0] > 0.025 ? 4 : 3, base = pos.length / 3;
      for (let j = 0; j < pts.length; j++) {
        const A = pts[Math.max(0, j - 1)], B = pts[Math.min(pts.length - 1, j + 1)];
        const t = norm([B[0] - A[0], B[1] - A[1], B[2] - A[2]]), hz = norm(cross(t, UP)), vt = cross(hz, t);
        for (let s = 0; s <= sides; s++) {
          const an = (s / sides) * 6.283, c = Math.cos(an), sn = Math.sin(an);
          const dn = [hz[0] * c + vt[0] * sn * flat, hz[1] * c + vt[1] * sn * flat, hz[2] * c + vt[2] * sn * flat];
          const nn = norm([hz[0] * c + vt[0] * sn / flat, hz[1] * c + vt[1] * sn / flat, hz[2] * c + vt[2] * sn / flat]);
          const y = pts[j][1] + dn[1] * rad[j];
          pos.push(pts[j][0] + dn[0] * rad[j], y, pts[j][2] + dn[2] * rad[j]); nor.push(...nn); uv.push(s / sides, j * 0.35); node.push(rn[j]);
          const stain = clamp((y - pts[j][3]) / 0.12, 0, 1); col.push(0.62 + 0.38 * stain, 0.6 + 0.4 * stain, 0.58 + 0.42 * stain);
        }
      }
      for (let j = 0; j < pts.length - 1; j++) for (let s = 0; s < sides; s++) { const a = base + j * (sides + 1) + s, b = a + sides + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
      k = e + 1;
    }
  }
  return { pos, nor, uv, col, idx, solids, node };
}

// ---- mechanics: what breaks, and where
// The nodes removed when segment k breaks off: k and everything it carries (children always follow their parent).
export function subtree(P, k) {
  const out = new Uint8Array(P.n); out[k] = 1;
  for (let i = k + 1; i < P.n; i++) if (P.par[i] >= 0 && out[P.par[i]]) out[i] = 1;
  return out;
}
// A force F (newtons, a vector) applied at fraction u along segment i, on a plant drawn at scale s (world metres per
// plant metre). Each joint from there back to the stem is a cantilever root: its bending moment is |r × F|, r from the
// joint to the load; the stress at its surface is σ = M / Z with section modulus Z = π r³ / 4. A joint fails when σ
// exceeds the green wood's modulus of rupture (ARCH.wood.MOR), scaled by its health: dead wood is weak, and a dead
// limb is weakest at its collar, where it rots first. Returns the joint most over its limit (or the closest to it).
// Ignores the limb's own weight and dynamic loads, which the caller folds into F.
const HEALTH = [1, 0.45, 0.3, 0.2]; // LIVE, DEAD, STUB, BURIED
export function breakCheck(P, i, u, F, s = 1, dead = false, held = null) { // dead: treat all of it as dead wood (a fallen tree's branches); held(j): j is anchored (default: the stem, ord 0)
  const MOR = ARCH[P.sp].wood.MOR * 1e6;
  const q = [0, 1, 2].map((k) => (P.p0[i * 3 + k] + (P.p1[i * 3 + k] - P.p0[i * 3 + k]) * u) * s);
  let best = { node: -1, ratio: 0 }, j = i;
  while (j >= 0 && (held ? !held(j) : P.ord[j] >= 1)) {
    const r = [0, 1, 2].map((k) => q[k] - P.p0[j * 3 + k] * s), M = len3(cross(r, F)), rad = P.r0[j] * s;
    const collar = P.st[j] === DEAD && (P.par[j] < 0 || P.ord[P.par[j]] < P.ord[j]) ? 0.6 : 1;
    const st = dead ? Math.max(DEAD, P.st[j]) : P.st[j], ratio = M / ((Math.PI * rad ** 3) / 4) / (MOR * HEALTH[st] * (dead && (P.par[j] < 0 || P.ord[P.par[j]] < P.ord[j]) ? 0.6 : collar));
    if (ratio > best.ratio) best = { node: j, ratio };
    j = P.par[j];
  }
  return best;
}

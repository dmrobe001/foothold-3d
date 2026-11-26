// Export the gym's stations (src/gym.js) as plain JSON for the simulator: each station's boxes and rails in its own
// frame (x right, f forward, y up from the lane's ground; you start at f = -4 facing +f). Run: node sim/export_gym.mjs
import { STATIONS } from '../src/gym.js';
import { writeFileSync } from 'node:fs';
const out = STATIONS.map((s, i) => ({
  i: i + 1, name: s.name, mode: s.mode, expect: s.expect,
  boxes: s.features.filter((f) => f.block).map((f) => ({ x: f.block[0], f: f.block[1], w: f.size[0], h: f.size[1], l: f.size[2], y: f.y || 0, roll: f.roll || 0, pitch: f.pitch || 0, yaw: f.yaw || 0 })),
  rails: s.features.filter((f) => f.log).map((f) => ({ a: [f.log[0], f.log[1], f.log[2] + f.r], b: [f.log[3], f.log[4], f.log[5] + f.r], r: f.r })),
}));
writeFileSync(new URL('./stations.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`${out.length} stations -> sim/stations.json`);

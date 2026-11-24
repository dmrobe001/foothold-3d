// Print stand statistics for one or more worlds, so results can be reproduced and compared without a browser.
// Usage: node tools/sim-report.mjs [seed] [age] [moisture: dry|mesic|wet] [storms: none|occasional|frequent] [geology: granite|sandstone|basalt]
import { generateWorld, SPECIES } from '../src/worldgen.js';

const [seed = '1', age = '160', moisture = 'mesic', storms = 'occasional', geology = 'granite'] = process.argv.slice(2);
const w = await generateWorld({ seed: +seed, age: +age, moisture, storms, geology });
const s = w.stats, f = (v, d = 0) => v.toFixed(d);
console.log(`seed ${seed}  age ${w.age} yr  moisture ${moisture}  storms ${storms}  bedrock ${geology}   (${w.genMs} ms, relief ${f(w.hmax, 1)} m)`);
console.log(`live stems >=10 cm   ${f(s.stems)} /ha     saplings <10 cm ${f(s.saplings)} /ha`);
console.log(`basal area           ${f(s.ba, 1)} m2/ha`);
console.log(`snags >=10 cm        ${f(s.snags)} /ha     snag volume ${f(s.snagVol, 1)} m3/ha`);
console.log(`logs >=10 cm         ${f(s.logs)} /ha     log volume  ${f(s.logVol, 1)} m3/ha   (uprooted ${f(s.uprooted)} /ha)`);
console.log(`windstorms           ${s.storms}`);
console.log('basal area by species: ' + SPECIES.map((p, i) => `${p.name} ${f(s.bySpeciesBA[i], 1)}`).join('  '));
console.log('dbh distribution (stems/ha per 5 cm bin from 5 cm): ' + s.dbhBins.map((v) => f(v)).join(' '));
console.log('g(r), 1 m bins:  ' + s.gr.map((v) => f(v, 2)).join(' '));

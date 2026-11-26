// Bundle index.html + src/*.js into one self-contained page fragment: dist/foothold.html.
// The fragment omits <!doctype>/<html>/<head>/<body> because the artifact host wraps the page itself;
// browsers also open it fine directly. Run: node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const worldgen = read('src/worldgen.js').replace(/^export (const|function|async function|let|class) /gm, '$1 ');
const gym = read('src/gym.js').replace(/^import \{[^}]*\} from '\.\/(worldgen|deadfall)\.js';\n/gm, '').replace(/^export (const|function) /gm, '$1 ');
const deadfall = read('src/deadfall.js').replace(/^import \{[^}]*\} from '\.\/worldgen\.js';\n/m, '').replace(/^export (const|function) /gm, '$1 ');
// the skeleton module keeps its short helper names (add, dot, ...) private: it becomes one namespace object, SK
const skelSrc = read('src/skeleton.js'), skelNames = [...skelSrc.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const skeleton = `const SK = (() => {\n${skelSrc.replace(/^export (const|function) /gm, '$1 ')}\nreturn { ${skelNames.join(', ')} };\n})();`;
// the physics module too: PH (its class source also goes to the worker as a string)
const phSrc = read('src/physics.js'), phNames = [...phSrc.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]);
const physics = `const PH = (() => {\n${phSrc.replace(/^export (const|function|class) /gm, '$1 ')}\nreturn { ${phNames.join(', ')} };\n})();`;
// the modal plants module: MD
const mdSrc = read('src/modal.js'), mdNames = [...mdSrc.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]);
const modal = `const MD = (() => {\n${mdSrc.replace(/^export (const|function|class) /gm, '$1 ')}\nreturn { ${mdNames.join(', ')} };\n})();`;
// the plants module likewise becomes a namespace, PL (its worldgen import is satisfied by the inlined worldgen)
const plSrc = read('src/plants.js').replace(/^import \{[^}]*\} from '\.\/worldgen\.js';\n/m, ''), plNames = [...plSrc.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const plants = `const PL = (() => {\n${plSrc.replace(/^export (const|function) /gm, '$1 ')}\nreturn { ${plNames.join(', ')} };\n})();`;
const game = read('src/game.js').replace(/^import \{[^}]*\} from '\.\/(worldgen|deadfall|gym)\.js';\n/gm, '').replace(/^import \* as SK from '\.\/skeleton\.js';\n/m, '').replace(/^import \* as PL from '\.\/plants\.js';\n/m, '').replace(/^import \* as PH from '\.\/physics\.js';\n/m, '').replace(/^import \* as MD from '\.\/modal\.js';\n/m, '');
if (/^export /m.test(worldgen + game + deadfall + gym + plants + skeleton + physics + modal)) throw new Error('an export line was not stripped');
if (/from '\.\/(worldgen|deadfall|skeleton|gym|plants)\.js'/.test(game + deadfall + gym + plants)) throw new Error('module import not stripped');
let html = read('index.html')
  .replace(/<!doctype html>\n?/i, '').replace(/<\/?html[^>]*>\n?/g, '').replace(/<\/?head>\n?/g, '').replace(/<\/?body>\n?/g, '')
  .replace(/<meta charset[^>]*>\n?/, '').replace(/<meta name="viewport"[^>]*>\n?/, '');
html = html.replace('<script type="module" src="./src/game.js"></script>', () => `<script type="module">\n${worldgen}\n// ---- deadfall ----\n${deadfall}\n// ---- gym ----\n${gym}\n// ---- skeleton ----\n${skeleton}\n// ---- plants ----\n${plants}\n// ---- physics ----\n${physics}\n// ---- modal ----\n${modal}\n// ---- game ----\n${game}\n</script>`);
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/foothold.html', root), html);
console.log(`dist/foothold.html  ${(html.length / 1024).toFixed(0)} KB`);

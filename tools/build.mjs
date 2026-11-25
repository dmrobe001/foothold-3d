// Bundle index.html + src/*.js into one self-contained page fragment: dist/foothold.html.
// The fragment omits <!doctype>/<html>/<head>/<body> because the artifact host wraps the page itself;
// browsers also open it fine directly. Run: node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const worldgen = read('src/worldgen.js').replace(/^export (const|function|async function|let|class) /gm, '$1 ');
const deadfall = read('src/deadfall.js').replace(/^import \{[^}]*\} from '\.\/worldgen\.js';\n/m, '').replace(/^export (const|function) /gm, '$1 ');
const game = read('src/game.js').replace(/^import \{[^}]*\} from '\.\/(worldgen|deadfall)\.js';\n/gm, '');
if (/from '\.\/(worldgen|deadfall)\.js'/.test(game + deadfall)) throw new Error('worldgen import not stripped');
let html = read('index.html')
  .replace(/<!doctype html>\n?/i, '').replace(/<\/?html[^>]*>\n?/g, '').replace(/<\/?head>\n?/g, '').replace(/<\/?body>\n?/g, '')
  .replace(/<meta charset[^>]*>\n?/, '').replace(/<meta name="viewport"[^>]*>\n?/, '');
html = html.replace('<script type="module" src="./src/game.js"></script>', () => `<script type="module">\n${worldgen}\n// ---- deadfall ----\n${deadfall}\n// ---- game ----\n${game}\n</script>`);
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/foothold.html', root), html);
console.log(`dist/foothold.html  ${(html.length / 1024).toFixed(0)} KB`);

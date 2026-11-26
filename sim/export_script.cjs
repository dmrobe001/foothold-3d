const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await b.newPage({ viewport: { width: 300, height: 200 } }); page.setDefaultTimeout(900000);
  page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
  await page.route('**/three.module.js', (r) => r.fulfill({ path: '/home/user/foothold-3d/node_modules/three/build/three.module.js', contentType: 'text/javascript' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('http://local/', (r) => r.fulfill({ body: '<!doctype html><meta charset=utf-8>' + fs.readFileSync('/home/user/foothold-3d/dist/foothold.html', 'utf8'), contentType: 'text/html' }));
  await page.goto('http://local/#gym'); await page.waitForFunction(() => document.getElementById('loading').hidden);
  // usage: node sim/export_script.cjs <station 1-30> <mode> [side -1|1]  ->  sim/refs/<mode>-<station>.json
  const [st, mode, side] = [+process.argv[2], process.argv[3], +(process.argv[4] || -1)];
  const out = await page.evaluate(([st, mode, side]) => { const F = window.foothold; F.pause(); F.gym.go(st - 1); F.resetRig();
    for (let k = 0; k < 400 && !F.debug.barrier(); k++) { F.input.keys.clear(); F.input.keys.add('KeyW'); F.step(1 / 60); }
    return F.debug.overTrack(mode, side); }, [st, mode, side]);
  require('fs').writeFileSync(`/home/user/foothold-3d/sim/refs/${mode.replace(/ /g, '-')}-${st}.json`, JSON.stringify(out));
  console.log(`${mode} at station ${st}: ${out.frames.length} poses over ${out.dur} s; barrier`, out.barrier);
  await b.close(); })();

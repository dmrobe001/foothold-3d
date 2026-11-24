// Foothold renderer, controls and UI. World data comes from ./worldgen.js.
import * as THREE from 'three';
import { generateWorld, sampleGrid, SPECIES, crownRadius, crownFraction, WORLD, N, HALF, hash3, mulberry32, makeNoise2D, clamp, smoothstep } from './worldgen.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------------------------------------------------------------- settings
const settings = { seed: 1, age: 160, moisture: 'mesic', storms: 'occasional', quality: isTouch ? 'low' : 'high' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('foothold.settings') || '{}')); } catch (e) { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem('foothold.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

// ---------------------------------------------------------------- renderer, scene, lights
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'high', powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1400);
camera.rotation.order = 'YXZ';

const HORIZON = new THREE.Color().setRGB(0.70, 0.73, 0.70, THREE.SRGBColorSpace);
const ZENITH = new THREE.Color().setRGB(0.42, 0.55, 0.68, THREE.SRGBColorSpace);
scene.fog = new THREE.FogExp2(HORIZON.clone(), 0.0105);
scene.background = HORIZON.clone();

const sunDir = new THREE.Vector3(0.55, 0.52, 0.42).normalize(); // morning, low-ish sun from the south-east
const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(0.72, 0.80, 0.86, THREE.SRGBColorSpace), new THREE.Color().setRGB(0.42, 0.36, 0.26, THREE.SRGBColorSpace), 2.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(1.0, 0.93, 0.80, THREE.SRGBColorSpace), 3.0);
sun.shadow.camera.left = -48; sun.shadow.camera.right = 48; sun.shadow.camera.top = 48; sun.shadow.camera.bottom = -48;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 320;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// sky dome
const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uH: { value: HORIZON }, uZ: { value: ZENITH }, uSun: { value: sunDir } },
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }',
  fragmentShader: 'uniform vec3 uH; uniform vec3 uZ; uniform vec3 uSun; varying vec3 vD; void main(){ float y = max(vD.y, 0.0); vec3 c = mix(uH, uZ, pow(y, 0.55)); float s = max(dot(normalize(vD), uSun), 0.0); c += vec3(1.0,0.85,0.6) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.18); gl_FragColor = vec4(c, 1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
}));
sky.renderOrder = -1;
scene.add(sky);

// ---------------------------------------------------------------- procedural textures
const lin = (c) => Math.pow(c, 2.2);
const lerp = (a, b, t) => a + (b - a) * t;
function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h, mulberry32(w * 31 + h));
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
function drawLeafy(g, w, h, r, { twigs = 16, leaves = 22, size = 7, hue = [62, 98], sat = [18, 38], light = [24, 50], brown = 0.05 }) {
  for (let t = 0; t < twigs; t++) {
    let x = w * (0.15 + 0.7 * r()), y = h * (0.15 + 0.7 * r());
    const a0 = r() * Math.PI * 2, len = w * (0.18 + 0.2 * r());
    g.strokeStyle = hsl(30, 25, 22, 0.9); g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(x, y);
    const ex = x + Math.cos(a0) * len, ey = y + Math.sin(a0) * len; g.lineTo(ex, ey); g.stroke();
    for (let l = 0; l < leaves; l++) {
      const f = r(), px = x + (ex - x) * f + (r() - 0.5) * size * 2.5, py = y + (ey - y) * f + (r() - 0.5) * size * 2.5;
      const isBrown = r() < brown;
      g.fillStyle = isBrown ? hsl(30 + r() * 15, 40, 30 + r() * 15) : hsl(hue[0] + r() * (hue[1] - hue[0]), sat[0] + r() * (sat[1] - sat[0]), light[0] + r() * (light[1] - light[0]));
      g.save(); g.translate(px, py); g.rotate(r() * Math.PI * 2);
      const s = size * (0.7 + 0.6 * r());
      g.beginPath(); g.ellipse(0, 0, s, s * 0.52, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }
}
const tex = {
  leaf: canvasTex(256, 256, (g, w, h, r) => drawLeafy(g, w, h, r, { twigs: 18, leaves: 26, size: 8 })),
  shrub: canvasTex(256, 256, (g, w, h, r) => drawLeafy(g, w, h, r, { twigs: 34, leaves: 24, size: 4.6, hue: [55, 100], sat: [14, 32], light: [22, 46], brown: 0.12 })),
  needle: canvasTex(256, 128, (g, w, h, r) => {
    // a drooping conifer spray: main axis along u, side shoots, dense needles
    for (let k = 0; k < 3; k++) {
      const y0 = h * (0.35 + 0.3 * r());
      g.strokeStyle = hsl(28, 30, 20, 1); g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, y0); g.quadraticCurveTo(w * 0.5, y0 + (r() - 0.5) * 20, w, y0 + (r() - 0.3) * 24); g.stroke();
      for (let s = 0; s < 26; s++) {
        const sx = w * (0.05 + 0.9 * (s / 26)), sy = y0 + (r() - 0.5) * 8, side = s % 2 ? 1 : -1;
        const len = (h * 0.42) * (1 - 0.6 * (s / 26)) * (0.6 + 0.4 * r());
        const ang = side * (0.75 + 0.3 * r());
        const ex = sx + Math.cos(ang) * len * 0.45 + len * 0.25, ey = sy + Math.sin(ang) * len;
        for (let n = 0; n < 22; n++) {
          const f = n / 22, nx = sx + (ex - sx) * f, ny = sy + (ey - sy) * f;
          g.strokeStyle = hsl(95 + r() * 45, 14 + r() * 18, 18 + r() * 22, 0.95);
          g.lineWidth = 1.6; g.beginPath(); g.moveTo(nx, ny);
          const na = ang + (r() - 0.5) * 2.2; g.lineTo(nx + Math.cos(na) * 7, ny + Math.sin(na) * 7); g.stroke();
        }
      }
    }
  }),
  fern: canvasTex(128, 256, (g, w, h, r) => {
    const cx = w / 2;
    g.strokeStyle = hsl(85, 40, 22); g.lineWidth = 2; g.beginPath(); g.moveTo(cx, h); g.lineTo(cx, 4); g.stroke();
    for (let y = h - 8; y > 6; y -= 5) {
      const f = 1 - y / h, len = w * 0.46 * Math.sin(Math.PI * Math.min(1, (1 - f) * 1.1)) * (0.85 + 0.2 * r());
      for (const side of [-1, 1]) {
        g.fillStyle = hsl(70 + r() * 25, 22 + r() * 16, 26 + r() * 18);
        g.beginPath(); g.moveTo(cx, y); g.quadraticCurveTo(cx + side * len * 0.6, y - 6, cx + side * len, y - 9); g.quadraticCurveTo(cx + side * len * 0.5, y + 1, cx, y + 2.5); g.fill();
      }
    }
  }),
  grass: canvasTex(128, 128, (g, w, h, r) => {
    for (let b = 0; b < 46; b++) {
      const x = w * (0.1 + 0.8 * r()), hh = h * (0.35 + 0.62 * r()), lean = (r() - 0.5) * 30;
      g.strokeStyle = r() < 0.3 ? hsl(45 + r() * 10, 35, 45 + r() * 15) : hsl(70 + r() * 25, 30 + r() * 20, 28 + r() * 20);
      g.lineWidth = 1.2 + r() * 1.3; g.beginPath(); g.moveTo(x, h); g.quadraticCurveTo(x + lean * 0.3, h - hh * 0.6, x + lean, h - hh); g.stroke();
    }
  }),
  bark: canvasTex(64, 256, (g, w, h, r) => {
    g.fillStyle = '#8a8580'; g.fillRect(0, 0, w, h);
    for (let n = 0; n < 900; n++) { const v = 90 + r() * 80; g.fillStyle = `rgba(${v},${v * 0.97},${v * 0.93},0.35)`; g.fillRect(r() * w, r() * h, 1 + r() * 3, 2 + r() * 10); }
    for (let f = 0; f < 14; f++) { // vertical fissures
      let x = r() * w; g.strokeStyle = 'rgba(40,36,32,0.7)'; g.lineWidth = 1 + r() * 2; g.beginPath(); g.moveTo(x, 0);
      for (let y = 0; y <= h; y += 16) { x += (r() - 0.5) * 6; g.lineTo(x, y); } g.stroke();
    }
  }, { repeat: true }),
  soil: canvasTex(128, 128, (g, w, h, r) => {
    g.fillStyle = '#5a4532'; g.fillRect(0, 0, w, h);
    for (let n = 0; n < 1400; n++) { const v = 50 + r() * 60; g.fillStyle = `rgba(${v + 20},${v},${v * 0.7},0.5)`; g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3); }
    g.strokeStyle = 'rgba(70,52,36,0.9)';
    for (let k = 0; k < 18; k++) { g.lineWidth = 1 + r() * 4; g.beginPath(); g.moveTo(w / 2, h / 2); g.lineTo(r() * w, r() * h); g.stroke(); }
  }, { repeat: true }),
};
tex.bark.repeat.set(1, 6);

// ---------------------------------------------------------------- materials
const uTime = { value: 0 };
function foliageMaterial(map, { wind = 0.012, alphaTest = 0.42 } = {}) {
  const m = new THREE.MeshLambertMaterial({ map, alphaTest, side: THREE.DoubleSide, vertexColors: true });
  const uWind = { value: wind };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime; sh.uniforms.uWind = uWind;
    sh.vertexShader = 'uniform float uTime; uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float ph = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
      #else
        float ph = 0.0;
      #endif
      float sway = sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.4;
      transformed.x += sway * uWind * position.y;
      transformed.z += sway * uWind * 0.5 * position.y;
      transformed += normal * sin(uTime * 4.0 + dot(position, vec3(17.0, 11.0, 13.0))) * uWind * 0.25;`);
    // Keep the shared "crown" normals on both faces of each card, so foliage shades as a volume, not as flat planes.
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replaceAll('normal *= faceDirection;', ''));
  };
  return m;
}
const mats = {
  leaf: foliageMaterial(tex.leaf),
  needle: foliageMaterial(tex.needle, { alphaTest: 0.38 }),
  shrub: foliageMaterial(tex.shrub, { wind: 0.04 }),
  fern: foliageMaterial(tex.fern, { wind: 0.06, alphaTest: 0.4 }),
  grass: foliageMaterial(tex.grass, { wind: 0.09, alphaTest: 0.35 }),
  bark: new THREE.MeshLambertMaterial({ map: tex.bark }),
  soil: new THREE.MeshLambertMaterial({ map: tex.soil }),
  wood: new THREE.MeshLambertMaterial({ map: tex.bark }),
  rock: new THREE.MeshLambertMaterial({ color: 0xffffff }),
  water: new THREE.MeshPhongMaterial({ color: new THREE.Color().setRGB(0.10, 0.13, 0.11, THREE.SRGBColorSpace), specular: 0x9aa4a0, shininess: 90, transparent: true, opacity: 0.82 }),
};

// terrain material: colours are computed per fragment from ecological fields
const terrainMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
terrainMat.onBeforeCompile = (sh) => {
  sh.vertexShader = 'attribute vec4 aEco; attribute float aStream; varying vec4 vEco; varying float vStream; varying vec3 vW; varying vec3 vNw;\n' +
    sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vEco = aEco; vStream = aStream; vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vNw = normal;');
  sh.fragmentShader = `varying vec4 vEco; varying float vStream; varying vec3 vW; varying vec3 vNw;
    float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
    ` + sh.fragmentShader.replace('#include <color_fragment>', `
    vec2 P = vW.xz;
    float n1 = vn(P * 1.9), n2 = vn(P * 0.42 + 7.0), n3 = vn(P * 0.07 + 3.0), n4 = vn(P * 7.0), n5 = vn(P * 0.9 + 11.0);
    float wet = vEco.x, li = vEco.y, con = vEco.z, rk = vEco.w;
    vec3 litter = mix(vec3(0.36, 0.27, 0.17), vec3(0.47, 0.35, 0.21), n1 * 0.7 + n4 * 0.3);
    vec3 duff = mix(vec3(0.29, 0.20, 0.13), vec3(0.38, 0.26, 0.16), n1);
    vec3 moss = mix(vec3(0.22, 0.26, 0.12), vec3(0.32, 0.34, 0.17), n2 * 0.6 + n4 * 0.4);
    vec3 grass = mix(vec3(0.38, 0.38, 0.20), vec3(0.55, 0.49, 0.30), n2 * 0.6 + n1 * 0.4);
    vec3 mud = vec3(0.17, 0.14, 0.10);
    vec3 stone = mix(vec3(0.38, 0.37, 0.34), vec3(0.55, 0.53, 0.49), n4 * 0.6 + n1 * 0.4);
    vec3 c = mix(litter, duff, clamp(con * 1.2 - 0.1, 0.0, 1.0));
    float g = smoothstep(0.38, 0.85, li + (n2 - 0.5) * 0.4 + (n5 - 0.5) * 0.15);
    c = mix(c, grass, g);
    float m = smoothstep(0.62, 1.0, wet + (n2 - 0.5) * 0.55 + (n1 - 0.5) * 0.2) * (1.0 - 0.5 * g);
    c = mix(c, moss, m * 0.75);
    c = mix(c, mud, smoothstep(0.25, 0.8, vStream + (n1 - 0.5) * 0.3));
    float steep = 1.0 - normalize(vNw).y;
    float r = clamp(smoothstep(0.32, 0.55, steep + (n1 - 0.5) * 0.25) + rk * smoothstep(0.45, 0.62, n3 * 0.6 + n5 * 0.4), 0.0, 1.0);
    c = mix(c, stone, r);
    c *= 0.78 + 0.42 * n4 * (0.6 + 0.4 * n1);
    c *= 0.88 + 0.24 * n3;
    c *= mix(0.84, 1.0, li);
    diffuseColor.rgb = pow(c, vec3(2.2));
    `);
};

// ---------------------------------------------------------------- geometry builders
function cardGeometry(cards) {
  // cards: [{c:[x,y,z], u:[x,y,z], v:[x,y,z], n:[x,y,z], ao0, ao1, uv?}] ; u, v are half-extent vectors
  const pos = [], nor = [], uv = [], col = [], idx = [];
  for (const k of cards) {
    const b = pos.length / 3;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [a, c] of corners) {
      pos.push(k.c[0] + a * k.u[0] + c * k.v[0], k.c[1] + a * k.u[1] + c * k.v[1], k.c[2] + a * k.u[2] + c * k.v[2]);
      const nn = k.nFor ? k.nFor(a, c) : k.n; nor.push(nn[0], nn[1], nn[2]);
      uv.push((a + 1) / 2, (c + 1) / 2);
      const ao = c < 0 ? k.ao0 : k.ao1; col.push(ao, ao, ao);
      uv[uv.length - 1] = lerp(k.v0 ?? 0, k.v1 ?? 1, (c + 1) / 2);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function randomPlane(r, n) { // two orthonormal vectors spanning a plane loosely facing n
  const t = norm3([n[0] + (r() - 0.5) * 1.6, n[1] + (r() - 0.5) * 1.6, n[2] + (r() - 0.5) * 1.6]);
  let u = cross3(t, [0, 1, 0]); if (Math.hypot(...u) < 0.1) u = [1, 0, 0];
  u = norm3(u); const v = norm3(cross3(t, u));
  const a = r() * Math.PI; const ca = Math.cos(a), sa = Math.sin(a);
  return [[u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa], [-u[0] * sa + v[0] * ca, -u[1] * sa + v[1] * ca, -u[2] * sa + v[2] * ca]];
}
// Broadleaf crown: unit ellipsoid occupying y in [0,1], radius 1. Cards favour the outer shell; normals radiate from the crown centre.
function broadCrownGeo(seed, count = 44, size = 0.5) {
  const r = mulberry32(seed), cards = [];
  while (cards.length < count) {
    const x = r() * 2 - 1, y = r() * 2 - 1, z = r() * 2 - 1, d = Math.hypot(x, y, z);
    if (d > 1 || d < 0.35) continue;
    const c = [x * 0.95, 0.5 + y * 0.48, z * 0.95];
    const nC = norm3([x, y * 0.8 + 0.35, z]);
    const [u, v] = randomPlane(r, nC);
    const s = size * (0.75 + 0.5 * r());
    const ao = clamp(0.45 + 0.4 * d + 0.25 * y, 0.35, 1.05);
    cards.push({ c, u: u.map((q) => q * s), v: v.map((q) => q * s), n: nC, ao0: ao * 0.85, ao1: ao });
  }
  return cardGeometry(cards);
}
// Conifer crown: unit cone, base radius 1 at y=0, tip at y=1. Whorls of drooping sprays.
function coneCrownGeo(seed, whorls = 15, per = 5) {
  const r = mulberry32(seed), cards = [];
  for (let w = 0; w < whorls; w++) {
    const y = 0.03 + 0.9 * (w / whorls) + (r() - 0.5) * 0.03, rad = Math.pow(1 - y, 0.95) * (0.9 + 0.2 * r()) + 0.04;
    const n = Math.max(3, Math.round(per * (0.5 + rad)));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r() * 0.8, dir = [Math.cos(a), 0, Math.sin(a)];
      const droop = 0.08 + 0.22 * r() + 0.25 * (1 - y);
      const along = norm3([dir[0], -droop, dir[2]]);
      const side = [-dir[2], 0, dir[0]];
      const half = rad * 0.55;
      const c = [along[0] * half, y + along[1] * half, along[2] * half];
      const tilt = (r() - 0.5) * 0.35, width = 0.2 + 0.14 * rad;
      const v = norm3([side[0], tilt + 0.12, side[2]]).map((q) => q * width);
      const nC = norm3([dir[0], 0.55, dir[2]]);
      const ao = clamp(0.45 + 0.55 * y + 0.2 * rad, 0.4, 1.05);
      cards.push({ c, u: along.map((q) => q * half), v, n: nC, ao0: ao * 0.8, ao1: ao });
    }
  }
  for (let k = 0; k < 2; k++) { // leader
    const a = k * Math.PI / 2;
    cards.push({ c: [0, 0.95, 0], u: [0, 0.07, 0], v: [Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08], n: [0, 1, 0], ao0: 1, ao1: 1 });
  }
  return cardGeometry(cards);
}
function shrubGeo(seed) {
  const r = mulberry32(seed), cards = [];
  for (let k = 0; k < 9; k++) {
    const a = r() * Math.PI * 2, d = r() * 0.55, c = [Math.cos(a) * d, 0.35 + r() * 0.35, Math.sin(a) * d];
    const nC = norm3([c[0], 0.6, c[2]]), [u, v] = randomPlane(r, nC), s = 0.45 + 0.2 * r();
    cards.push({ c, u: u.map((q) => q * s), v: v.map((q) => q * s), n: nC, ao0: 0.6, ao1: 0.95 });
  }
  return cardGeometry(cards);
}
function fernGeo(seed) {
  // Each frond is two cards: a rising inner half and an arching, drooping outer half.
  const r = mulberry32(seed), cards = [];
  const fronds = 7 + Math.floor(r() * 3);
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + r() * 0.6, dir = [Math.cos(a), 0, Math.sin(a)], side = [-dir[2], 0, dir[0]];
    const L = 0.75 + 0.35 * r(), rise = 1.1 + 0.6 * r(), w = 0.17 + 0.05 * r();
    const a1 = norm3([dir[0], rise, dir[2]]), a2 = norm3([dir[0], -0.15 - 0.3 * r(), dir[2]]);
    const h1 = L * 0.27, h2 = L * 0.25;
    const p1 = a1.map((q) => q * h1), e1 = a1.map((q) => q * h1 * 2);
    const p2 = [e1[0] + a2[0] * h2, e1[1] + a2[1] * h2, e1[2] + a2[2] * h2];
    const nF = () => norm3([dir[0] * 0.5, 1, dir[2] * 0.5]);
    cards.push({ c: p1, u: side.map((q) => q * w), v: p1, nFor: nF, ao0: 0.5, ao1: 0.85, v0: 0, v1: 0.55 });
    cards.push({ c: p2, u: side.map((q) => q * w * 0.85), v: a2.map((q) => q * h2), nFor: nF, ao0: 0.85, ao1: 1.0, v0: 0.55, v1: 1 });
  }
  return cardGeometry(cards);
}
function grassGeo() {
  const cards = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    cards.push({ c: [0, 0.5, 0], u: [Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5], v: [0, 0.5, 0], n: [0, 1, 0], ao0: 0.55, ao1: 1.0 });
  }
  return cardGeometry(cards);
}
function trunkGeo() {
  // Lathe profile with a root flare at the base and a closed top; 7 sides keeps it cheap.
  const prof = [[0, 0], [0.8, 0], [0.66, 0.025], [0.55, 0.07], [0.5, 0.14], [0.42, 0.5], [0.3, 1], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(prof, 7);
  const p = g.attributes.position, r = mulberry32(5);
  const bumps = Array.from({ length: 8 }, () => 0.92 + 0.16 * r());
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
    const ang = Math.atan2(z, x), k = Math.round(((ang + Math.PI) / (Math.PI * 2)) * 7) % 7;
    const b = 1 + (bumps[k] - 1) * (y < 0.1 ? 2 : 1);
    p.setX(i, x * b); p.setZ(i, z * b);
  }
  g.computeVertexNormals();
  return g;
}
function rootPlateGeo() {
  const g = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false);
  const p = g.attributes.position, r = mulberry32(9);
  const rr = Array.from({ length: 15 }, () => 0.7 + 0.5 * r());
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), ang = Math.atan2(z, x), k = Math.round(((ang + Math.PI) / (Math.PI * 2)) * 14) % 14;
    p.setX(i, x * rr[k]); p.setZ(i, z * rr[k]);
  }
  g.computeVertexNormals();
  return g;
}
function rockGeo(seed) {
  const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position, nz = makeNoise2D(mulberry32(seed));
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    const d = 1 + 0.28 * nz(v.x * 1.3 + v.z, v.y * 1.3 + seed) + 0.1 * nz(v.x * 3.5, v.z * 3.5 + v.y);
    v.multiplyScalar(d); v.y = v.y * 0.6;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // merge seams so normals are smooth
  g.deleteAttribute('uv');
  const merged = mergeVerts(g);
  merged.computeVertexNormals();
  return merged;
}
function mergeVerts(g) {
  const p = g.attributes.position, map = new Map(), pos = [], idx = [];
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let k = map.get(key);
    if (k === undefined) { k = pos.length / 3; map.set(key, k); pos.push(p.getX(i), p.getY(i), p.getZ(i)); }
    idx.push(k);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setIndex(idx);
  return out;
}
const geos = {
  trunk: trunkGeo(), plate: rootPlateGeo(),
  trunkLo: (() => { const g = new THREE.LatheGeometry([[0.62, 0], [0.45, 0.12], [0.3, 1], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y)), 5); g.computeVertexNormals(); return g; })(),
  broad: broadCrownGeo(11), cone: coneCrownGeo(12),
  broadLo: broadCrownGeo(21, 13, 0.85), coneLo: coneCrownGeo(22, 7, 3),
  shrub: shrubGeo(13), fern: fernGeo(14), grass: grassGeo(),
  branch: (() => { const g = new THREE.CylinderGeometry(0.35, 0.5, 1, 5, 1); g.translate(0, 0.5, 0); return g; })(),
  rock: rockGeo(15),
};

// ---------------------------------------------------------------- instancing helpers
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
function trs(x, y, z, yaw, sx, sy, sz, tx = 0, tz = 0) { _e.set(tx, yaw, tz, 'YXZ'); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz); return _m.compose(_p, _q, _s); }
function along(px, py, pz, dx, dy, dz, sx, len, sz) { // local Y along (dx,dy,dz), local Z roughly up
  _Y.set(dx, dy, dz).normalize(); _X.crossVectors(_Y, UP); if (_X.lengthSq() < 1e-6) _X.set(1, 0, 0); _X.normalize(); _Z.crossVectors(_X, _Y);
  _m.makeBasis(_X.multiplyScalar(sx), _Y.multiplyScalar(len), _Z.multiplyScalar(sz)); _m.setPosition(px, py, pz); return _m;
}
class Batch {
  // Instances carry an importance value; they are sorted so the reduced (distant) mesh can draw only the important prefix.
  constructor() { this.items = []; }
  add(mat, r, g, b, imp = 1) { this.items.push([mat.elements.slice(), lin(r), lin(g), lin(b), imp]); }
  build(geo, mat, { cast = true, receive = true, farMin = 0 } = {}) {
    const n = this.items.length; if (!n) return null;
    this.items.sort((a, b) => b[4] - a[4]);
    const mesh = new THREE.InstancedMesh(geo, mat, n), M = mesh.instanceMatrix.array, C = new Float32Array(n * 3);
    let nFar = 0;
    this.items.forEach((it, i) => { M.set(it[0], i * 16); C[i * 3] = it[1]; C[i * 3 + 1] = it[2]; C[i * 3 + 2] = it[3]; if (it[4] >= farMin) nFar = i + 1; });
    mesh.instanceColor = new THREE.InstancedBufferAttribute(C, 3);
    mesh.castShadow = cast; mesh.receiveShadow = receive;
    mesh.computeBoundingSphere();
    mesh.userData.nFar = nFar;
    return mesh;
  }
}
class NearBatch { // fixed-capacity instanced mesh refilled as the player moves
  constructor(geo, mat, cap, { cast = false } = {}) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap); this.cap = cap; this.n = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.castShadow = cast; this.mesh.receiveShadow = true; this.mesh.count = 0;
  }
  reset() { this.n = 0; }
  add(mat, r, g, b) {
    if (this.n >= this.cap) return;
    mat.toArray(this.mesh.instanceMatrix.array, this.n * 16);
    const c = this.mesh.instanceColor.array; c[this.n * 3] = lin(r); c[this.n * 3 + 1] = lin(g); c[this.n * 3 + 2] = lin(b);
    this.n++;
  }
  commit() { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
}

// ---------------------------------------------------------------- world build
let W = null;          // world data from worldgen
let worldGroup = null; // all meshes for the current world
let tiles = [];        // {group, cx, cz}
let near = null;       // near-field scatter batches
let colTrunks = null, colLogs = null, logCells = null;
const ground = (x, z) => sampleGrid(W.H, N, x, z);

const TINT = {
  leaf: [[0.80, 0.86, 0.70], [0.86, 0.90, 0.62], [0.78, 0.92, 0.66], [0.98, 1.0, 0.70]],   // per species (fir, pine, maple, birch)
  bark: [[0.48, 0.40, 0.35], [0.62, 0.44, 0.33], [0.55, 0.52, 0.48], [0.96, 0.94, 0.90]],
};
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function buildWorld() {
  if (worldGroup) { scene.remove(worldGroup); worldGroup.traverse((o) => { if (o.isMesh && o.geometry && !Object.values(geos).includes(o.geometry)) o.geometry.dispose(); }); }
  worldGroup = new THREE.Group(); scene.add(worldGroup);
  tiles = [];

  // terrain mesh
  const pos = new Float32Array(N * N * 3), eco = new Float32Array(N * N * 4), strm = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = (i * WORLD) / (N - 1) - HALF, z = (j * WORLD) / (N - 1) - HALF;
    pos[k * 3] = x; pos[k * 3 + 1] = W.H[k]; pos[k * 3 + 2] = z;
    eco[k * 4] = W.wet[k]; eco[k * 4 + 1] = sampleGrid(W.light, W.LN, x, z); eco[k * 4 + 2] = sampleGrid(W.conShare, W.LN, x, z); eco[k * 4 + 3] = W.rock[k];
    strm[k] = W.stream[k];
  }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6); let q = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('aEco', new THREE.BufferAttribute(eco, 4));
  tg.setAttribute('aStream', new THREE.BufferAttribute(strm, 1));
  tg.setIndex(new THREE.BufferAttribute(idx, 1));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, terrainMat); terrain.receiveShadow = true;
  worldGroup.add(terrain);
  worldGroup.add(buildSkirt());

  // streams: a thin water sheet over channel cells
  {
    const wp = [], wi = [], map = new Int32Array(N * N).fill(-1);
    for (let k = 0; k < N * N; k++) if (W.stream[k] > 0.3) { map[k] = wp.length / 3; wp.push(pos[k * 3], W.H[k] + 0.12 + 0.12 * W.stream[k], pos[k * 3 + 2]); }
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      if (map[a] >= 0 && map[b] >= 0 && map[c] >= 0) wi.push(map[a], map[c], map[b]);
      if (map[b] >= 0 && map[c] >= 0 && map[d] >= 0) wi.push(map[b], map[c], map[d]);
    }
    if (wi.length) {
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3)); wg.setIndex(wi); wg.computeVertexNormals();
      const water = new THREE.Mesh(wg, mats.water); water.receiveShadow = true; worldGroup.add(water);
    }
  }

  // trees, snags, logs, root plates — batched into 128 m tiles so whole tiles can be culled
  const TILE = 64, NT = WORLD / TILE;
  const B = Array.from({ length: NT * NT }, () => ({ trunk: new Batch(), broad: new Batch(), cone: new Batch(), pine: new Batch(), plate: new Batch() }));
  const tileOf = (x, z) => clamp(Math.floor((z + HALF) / TILE), 0, NT - 1) * NT + clamp(Math.floor((x + HALF) / TILE), 0, NT - 1);
  colTrunks = new Map(); colLogs = []; logCells = new Map();
  const ckey = (ci, cj) => ci * 4096 + cj;
  const pushCol = (map, x, z, item, cs = 8) => { const k = ckey(Math.floor((x + HALF) / cs), Math.floor((z + HALF) / cs)); let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(item); };
  for (const t of W.trees) {
    const r = mulberry32(hash3(Math.round(t.x * 10), Math.round(t.z * 10), 77)), b = B[tileOf(t.x, t.z)], P = SPECIES[t.sp];
    const gy = ground(t.x, t.z), kind = P.kind, yaw = r() * Math.PI * 2, rad = t.d / 100;
    const vari = 0.88 + 0.24 * r();
    if (t.st === 0) {
      const h = t.h, cf = crownFraction(t.sp) * (t.L !== undefined ? 0.75 + 0.25 * clamp(t.L * 2, 0, 1) : 1) * (t.d < 6 ? 1.15 : 1);
      const crownLen = Math.min(h * 0.95, h * cf), cr = crownRadius(t.sp, t.d) * (0.85 + 0.3 * r());
      const lean = [(r() - 0.5) * 0.06, (r() - 0.5) * 0.06];
      const bt = TINT.bark[t.sp];
      b.trunk.add(trs(t.x, gy - 0.15, t.z, yaw, rad, kind === 'conifer' ? h * 0.97 : h * 0.86, rad, lean[0], lean[1]), bt[0] * vari, bt[1] * vari, bt[2] * vari, t.d);
      const lt = TINT.leaf[t.sp], shadeDull = t.L !== undefined ? 0.82 + 0.18 * clamp(t.L * 3, 0, 1) : 1, cv = vari * shadeDull;
      const cy = gy + h - crownLen;
      const dx = Math.sin(lean[1]) * -h * 0.6, dz = Math.sin(lean[0]) * h * 0.6;
      if (kind === 'conifer') b.cone.add(trs(t.x + dx, cy, t.z + dz, yaw, cr, crownLen * 1.04, cr), lt[0] * cv, lt[1] * cv, lt[2] * cv, t.d);
      else (kind === 'pine' ? b.pine : b.broad).add(trs(t.x + dx, cy, t.z + dz, yaw, cr, crownLen, cr * (0.85 + 0.3 * r())), lt[0] * cv, lt[1] * cv, lt[2] * cv, t.d);
      if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
    } else if (t.st === 1) {
      const grey = mix3(TINT.bark[t.sp], [0.62, 0.60, 0.56], clamp(t.t / 20, 0, 0.8));
      b.trunk.add(trs(t.x, gy - 0.15, t.z, yaw, rad, t.sh, rad, (r() - 0.5) * 0.08, (r() - 0.5) * 0.08), grey[0] * vari, grey[1] * vari, grey[2] * vari, t.d * 0.7);
      if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
    } else if (t.st === 2) {
      const T = (15 + 1.3 * t.d) * P.decay, f = clamp(t.t / T, 0, 1), cls = 1 + Math.floor(f * 4.999);
      const dirx = Math.cos(t.ang), dirz = Math.sin(t.ang), len = Math.max(1, t.len * (1 - 0.3 * f));
      const bx = t.x + dirx * (t.snapBase ? 0.3 : 0.2), bz = t.z + dirz * (t.snapBase ? 0.3 : 0.2);
      const tx = bx + dirx * len, tz = bz + dirz * len;
      const rr = (t.d / 200) * (1 - 0.15 * f), sink = rr * (0.1 + 0.9 * f);
      const raised = t.up && t.t < 25 ? rr * 2.2 * (1 - t.t / 25) : 0;
      const y0 = ground(bx, bz) + rr - sink + raised, y1 = ground(tx, tz) + rr * 0.6 - sink;
      const col = cls <= 2 ? mix3(TINT.bark[t.sp], [0.42, 0.34, 0.27], t.sp === 3 ? 0.3 : 0.6) : mix3([0.44, 0.36, 0.28], [0.34, 0.37, 0.21], (cls - 3) / 2);
      b.trunk.add(along(bx, y0, bz, tx - bx, y1 - y0, tz - bz, rad * (1 - 0.15 * f), Math.hypot(tx - bx, y1 - y0, tz - bz), rad * (1 - 0.35 * f)), col[0] * vari, col[1] * vari, col[2] * vari, t.d * 0.4);
      if (t.up && t.t < 70) {
        const pr = 0.7 + t.d * 0.028, pf = 1 - t.t / 70;
        b.plate.add(along(t.x - dirx * 0.15, ground(t.x, t.z) + pr * 0.55 * pf + 0.1, t.z - dirz * 0.15, dirx, 0, dirz, pr * (0.7 + 0.3 * pf), 0.35 + 0.25 * pf, pr * (0.5 + 0.5 * pf)), 0.62 * vari, 0.52 * vari, 0.42 * vari);
      }
      if (t.d >= 12) {
        const log = { x0: bx, z0: bz, x1: tx, z1: tz, y0: y0 + rr * 0.8, y1: y1 + rr * 0.8, r: rr, cls };
        colLogs.push(log);
        const steps = Math.ceil(len / 8);
        for (let s = 0; s <= steps; s++) { const f2 = s / steps; pushCol(logCells, bx + (tx - bx) * f2, bz + (tz - bz) * f2, log); }
      }
    }
  }
  for (let ti = 0; ti < B.length; ti++) {
    const g = new THREE.Group(), b = B[ti];
    { const m = b.plate.build(geos.plate, mats.soil); if (m) g.add(m); }
    g.userData.hi = []; g.userData.lo = [];
    {
      const hi = b.trunk.build(geos.trunk, mats.bark, { farMin: 9 });
      if (hi) {
        const lo = new THREE.InstancedMesh(geos.trunkLo, mats.bark, hi.count);
        lo.instanceMatrix = hi.instanceMatrix; lo.instanceColor = hi.instanceColor; lo.count = hi.userData.nFar; lo.castShadow = true; lo.receiveShadow = true; lo.boundingSphere = hi.boundingSphere;
        g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo);
      }
    }
    // crowns get a full and a reduced geometry sharing one instance buffer; the loop picks one by distance
    for (const [batch, hiG, loG, mat] of [[b.broad, geos.broad, geos.broadLo, mats.leaf], [b.cone, geos.cone, geos.coneLo, mats.needle], [b.pine, geos.broad, geos.broadLo, mats.needle]]) {
      const hi = batch.build(hiG, mat, { farMin: 4 }); if (!hi) continue;
      const lo = new THREE.InstancedMesh(loG, mat, hi.count);
      lo.instanceMatrix = hi.instanceMatrix; lo.instanceColor = hi.instanceColor; lo.count = hi.userData.nFar; lo.castShadow = false; lo.receiveShadow = true;
      lo.boundingSphere = hi.boundingSphere;
      g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo);
    }
    g.userData.cx = (ti % NT) * TILE - HALF + TILE / 2; g.userData.cz = Math.floor(ti / NT) * TILE - HALF + TILE / 2;
    worldGroup.add(g); tiles.push(g);
  }
  // dedupe log entries per collision cell
  for (const [k, a] of logCells) logCells.set(k, [...new Set(a)]);

  // near-field scatter
  if (near) for (const nb of Object.values(near.b)) nb.mesh.dispose?.();
  const Q = settings.quality === 'high';
  near = {
    cells: new Map(), cx: Infinity, cz: Infinity,
    nz: makeNoise2D(mulberry32(W.seed * 7 + 3)),
    b: {
      shrub: new NearBatch(geos.shrub, mats.shrub, 9000), fern: new NearBatch(geos.fern, mats.fern, 9000),
      grass: new NearBatch(geos.grass, mats.grass, Q ? 16000 : 9000), branch: new NearBatch(geos.branch, mats.wood, 7000, { cast: true }),
      rock: new NearBatch(geos.rock, mats.rock, 4000, { cast: true }),
    },
  };
  for (const nb of Object.values(near.b)) worldGroup.add(nb.mesh);
}

function buildSkirt() {
  // Low-resolution land beyond the simulated square, so the world edge dissolves into haze instead of ending at a cliff.
  const R0 = HALF, R1 = 1100, rings = 22, seg = 96, nz = makeNoise2D(mulberry32(W.seed + 404));
  const pos = [], eco = [], st = [], idx = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2, f = r / rings, rad = R0 * 1.0 + (R1 - R0) * f * f;
    const sq = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
    const rr = r === 0 ? R0 - 2 : rad, x = (Math.cos(a) / sq) * rr, z = (Math.sin(a) / sq) * rr;
    const ex = clamp(x, -HALF, HALF), ez = clamp(z, -HALF, HALF);
    const h0 = ground(ex, ez), far = clamp((Math.hypot(x - ex, z - ez)) / 300, 0, 1);
    const y = lerp(h0, W.hmax * 0.4, far * 0.6) + nz(x / 260, z / 260) * 30 * far + nz(x / 70, z / 70) * 4 * Math.min(1, far * 3) - (r === 0 ? 0.3 : 0);
    pos.push(x, y, z); eco.push(0.4, 0.15, 0.5, 0); st.push(0);
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
    const a = r * seg + s, b = r * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aEco', new THREE.Float32BufferAttribute(eco, 4)); g.setAttribute('aStream', new THREE.Float32BufferAttribute(st, 1));
  g.setIndex(idx); g.computeVertexNormals();
  // the ring winds clockwise when seen from above for this parametrisation; flip if normals point down
  if (g.attributes.normal.getY(seg * 2) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  return new THREE.Mesh(g, terrainMat);
}

// ---------------------------------------------------------------- near-field ground cover (deterministic per 8 m cell)
const NC = 8;
function fieldAt(x, z) {
  return {
    L: sampleGrid(W.light, W.LN, x, z), wet: sampleGrid(W.wet, N, x, z), m: sampleGrid(W.moist, N, x, z),
    s: sampleGrid(W.stream, N, x, z), rk: sampleGrid(W.rock, N, x, z), sl: sampleGrid(W.slope, N, x, z),
  };
}
function genCell(ci, cj) {
  const r = mulberry32(hash3(ci, cj, W.seed * 13 + 5)), items = [];
  const x0 = ci * NC - HALF, z0 = cj * NC - HALF;
  const f = fieldAt(x0 + NC / 2, z0 + NC / 2);
  const clump = 0.5 + 0.5 * near.nz((x0 + 4) / 30, (z0 + 4) / 30);           // clonal / patchy understorey
  const dry = 1 - f.m;
  const pois = (lam) => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };
  const rnd = () => [x0 + r() * NC, z0 + r() * NC];
  // shrubs: light-limited, patchy
  const nShrub = pois((0.6 + 9 * Math.pow(f.L, 0.8)) * clump * clump * 1.6 * (0.4 + 0.8 * f.m) * (1 - 0.9 * f.s) * (1 - 0.8 * f.rk));
  for (let k = 0; k < nShrub; k++) { const [x, z] = rnd(), L = sampleGrid(W.light, W.LN, x, z); const s = (0.45 + 1.1 * r()) * (0.55 + 0.7 * L); items.push(['shrub', x, z, r() * 6.28, s * (1 + 0.4 * r()), s, 0.75 + 0.3 * r(), r()]); }
  // ferns: moist, shade-tolerant
  const nFern = pois((14 * smoothstep(0.35, 0.85, f.wet + 0.2 * f.m) + 1.2) * (1.1 - 0.6 * f.L) * (1 - 0.6 * f.s) * (0.5 + clump) * (1 - f.rk));
  for (let k = 0; k < nFern; k++) { const [x, z] = rnd(); const s = 0.45 + 0.65 * r(); items.push(['fern', x, z, r() * 6.28, s, s * (0.8 + 0.4 * r()), 0.85 + 0.25 * r(), r()]); }
  // grass and sedge tufts: open ground and stream banks
  const nGrass = pois(42 * smoothstep(0.18, 0.75, f.L) * (1 - 0.8 * f.rk) * (0.6 + 0.6 * dry) + 18 * smoothstep(0.2, 0.6, f.s) * (1 - smoothstep(0.7, 1, f.s)) + 2);
  for (let k = 0; k < nGrass; k++) { const [x, z] = rnd(); const s = 0.25 + 0.4 * r(); items.push(['grass', x, z, r() * 6.28, s * 1.6, s, 0.8 + 0.3 * r(), r()]); }
  // fine woody debris: falls from the canopy, so scales with canopy closure; fresh logs shed many branches
  const nBr = pois(3 + 10 * (1 - f.L));
  for (let k = 0; k < nBr; k++) { const [x, z] = rnd(); items.push(['branch', x, z, r() * 6.28, 0.015 + 0.04 * r() * r(), 0.6 + 2.6 * r(), 0, r()]); }
  const logs = logCells.get((ci) * 4096 + cj) || [];
  for (const lg of logs) if (lg.cls <= 2) {
    const n = 3 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) {
      const t = 0.3 + 0.7 * r(), x = lg.x0 + (lg.x1 - lg.x0) * t + (r() - 0.5) * 3.5, z = lg.z0 + (lg.z1 - lg.z0) * t + (r() - 0.5) * 3.5;
      if (x < x0 || x >= x0 + NC || z < z0 || z >= z0 + NC) continue;
      items.push(['branch', x, z, r() * 6.28, 0.025 + 0.05 * r(), 1 + 3 * r(), lg.cls === 1 ? 1 : 0, r()]);
    }
  }
  // rocks: steep ground, rocky knolls, stream beds
  const nRock = pois(0.25 + 7 * f.rk + 5 * smoothstep(0.4, 0.9, f.s) + 2 * smoothstep(0.4, 0.8, f.sl));
  for (let k = 0; k < nRock; k++) { const [x, z] = rnd(); const big = r() < 0.06 + 0.15 * f.rk; const s = big ? 0.7 + 1.8 * r() : 0.08 + 0.35 * r() * r(); items.push(['rock', x, z, r() * 6.28, s, s, 0.85 + 0.25 * r(), r()]); }
  return items;
}
function refreshNear(px, pz, force = false) {
  if (!force && Math.hypot(px - near.cx, pz - near.cz) < 6) return;
  near.cx = px; near.cz = pz;
  for (const nb of Object.values(near.b)) nb.reset();
  const Q = settings.quality === 'high';
  const RAD = { shrub: 75, fern: 60, grass: Q ? 42 : 30, branch: 45, rock: 90 };
  const maxR = 90, c0 = Math.floor((px - maxR + HALF) / NC), c1 = Math.floor((px + maxR + HALF) / NC), r0 = Math.floor((pz - maxR + HALF) / NC), r1 = Math.floor((pz + maxR + HALF) / NC);
  const keep = new Set();
  for (let cj = Math.max(0, r0); cj <= Math.min(WORLD / NC - 1, r1); cj++) for (let ci = Math.max(0, c0); ci <= Math.min(WORLD / NC - 1, c1); ci++) {
    const cx = ci * NC - HALF + NC / 2, cz = cj * NC - HALF + NC / 2, d = Math.hypot(cx - px, cz - pz);
    if (d > maxR + 6) continue;
    const key = ci * 4096 + cj; keep.add(key);
    let items = near.cells.get(key); if (!items) { items = genCell(ci, cj); near.cells.set(key, items); }
    for (const it of items) {
      const [type, x, z, yaw, a, b, c, v] = it;
      const dd = Math.hypot(x - px, z - pz); if (dd > RAD[type]) continue;
      const gy = ground(x, z);
      if (type === 'shrub') near.b.shrub.add(trs(x, gy - 0.08, z, yaw, a, b, a * 0.9), 0.9 * c, 0.95 * c, 0.78 * c);
      else if (type === 'fern') near.b.fern.add(trs(x, gy - 0.03, z, yaw, a, b, a), 0.85 * c, 0.95 * c, 0.7 * c);
      else if (type === 'grass') near.b.grass.add(trs(x, gy - 0.05, z, yaw, a, b, a), 0.95 * c, 0.95 * c, 0.85 * c);
      else if (type === 'branch') {
        const dx = Math.cos(yaw) * b, dz = Math.sin(yaw) * b;
        const col = c ? [0.50, 0.40, 0.32] : [0.52 + 0.1 * v, 0.47 + 0.08 * v, 0.40];
        near.b.branch.add(along(x, gy + a * 0.6, z, dx, ground(x + dx, z + dz) - gy + (v - 0.5) * 0.15, dz, a * 2, Math.hypot(dx, dz), a * 2), ...col);
      } else if (type === 'rock') {
        const mossy = clamp(sampleGrid(W.wet, N, x, z) * 1.2 - 0.2, 0, 0.8) * (1 - sampleGrid(W.light, W.LN, x, z));
        const col = mix3([0.55, 0.53, 0.50], [0.34, 0.40, 0.24], mossy);
        near.b.rock.add(trs(x, gy - a * 0.22, z, yaw, a * (0.8 + 0.5 * v), a, a * (1.2 - 0.4 * v), (v - 0.5) * 0.3, 0), col[0] * c, col[1] * c, col[2] * c);
      }
    }
  }
  for (const k of near.cells.keys()) if (!keep.has(k) && near.cells.size > 1200) near.cells.delete(k);
  for (const nb of Object.values(near.b)) nb.commit();
}

// ---------------------------------------------------------------- player
const player = { x: 0, z: 0, yaw: 0, pitch: -0.05, eye: 0 };
const input = { f: 0, s: 0, run: false, keys: new Set(), stick: null, look: null };
function spawn() {
  const r = mulberry32(W.seed + 1);
  let best = null, bestScore = -1e9;
  for (let k = 0; k < 300; k++) {
    const x = (r() - 0.5) * 160, z = (r() - 0.5) * 160;
    const f = fieldAt(x, z);
    const score = -f.sl * 5 - f.s * 8 - Math.hypot(x, z) / 80 + (f.L > 0.05 && f.L < 0.5 ? 0.5 : 0);
    if (score > bestScore && !blockedAt(x, z)) { bestScore = score; best = [x, z]; }
  }
  [player.x, player.z] = best || [0, 0];
  // look downhill, toward the most open view
  const gx = ground(player.x + 2, player.z) - ground(player.x - 2, player.z), gz = ground(player.x, player.z + 2) - ground(player.x, player.z - 2);
  player.yaw = Math.atan2(gx, gz);
  player.eye = feetAt(player.x, player.z) + 1.65;
}
function blockedAt(x, z) {
  for (const t of nearbyTrunks(x, z)) if (Math.hypot(t.x - x, t.z - z) < t.r + 0.2) return true;
  return false;
}
function nearbyTrunks(x, z) {
  const ci = Math.floor((x + HALF) / 8), cj = Math.floor((z + HALF) / 8), out = [];
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = colTrunks.get((ci + di) * 4096 + cj + dj); if (a) out.push(...a); }
  return out;
}
function nearbyLogs(x, z) {
  const ci = Math.floor((x + HALF) / 8), cj = Math.floor((z + HALF) / 8), out = new Set();
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = logCells.get((ci + di) * 4096 + cj + dj); if (a) for (const l of a) out.add(l); }
  return out;
}
function segInfo(l, x, z) {
  const vx = l.x1 - l.x0, vz = l.z1 - l.z0, L2 = vx * vx + vz * vz || 1;
  const t = clamp(((x - l.x0) * vx + (z - l.z0) * vz) / L2, 0, 1);
  const px = l.x0 + vx * t, pz = l.z0 + vz * t;
  return { t, d: Math.hypot(x - px, z - pz), px, pz, top: lerp(l.y0, l.y1, t) };
}
function feetAt(x, z) {
  let y = ground(x, z);
  for (const l of nearbyLogs(x, z)) { const s = segInfo(l, x, z); if (s.d < l.r * 0.9 && s.top > y) y = Math.max(y, s.top); }
  return y;
}
function movePlayer(dt) {
  let f = input.f, s = input.s, run = input.run;
  if (input.keys.has('KeyW') || input.keys.has('ArrowUp')) f += 1;
  if (input.keys.has('KeyS') || input.keys.has('ArrowDown')) f -= 1;
  if (input.keys.has('KeyD')) s += 1;
  if (input.keys.has('KeyA')) s -= 1;
  if (input.keys.has('ArrowLeft')) player.yaw += dt * 1.8;
  if (input.keys.has('ArrowRight')) player.yaw -= dt * 1.8;
  if (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight')) run = true;
  const mag = Math.hypot(f, s); if (mag > 1) { f /= mag; s /= mag; }
  const speed = run ? 4.2 : 1.6;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let dx = (-sy * f + cy * s) * speed * dt, dz = (-cy * f - sy * s) * speed * dt;
  if (dx || dz) {
    const feet = feetAt(player.x, player.z);
    const upSlope = (ground(player.x + dx * 5, player.z + dz * 5) - ground(player.x, player.z)) / (Math.hypot(dx, dz) * 5 + 1e-6);
    const k = clamp(1 - Math.max(0, upSlope) * 0.9, 0.25, 1); dx *= k; dz *= k;
    let nx = clamp(player.x + dx, -HALF + 6, HALF - 6), nz = clamp(player.z + dz, -HALF + 6, HALF - 6);
    for (const t of nearbyTrunks(nx, nz)) {
      const ex = nx - t.x, ez = nz - t.z, d = Math.hypot(ex, ez);
      if (d < t.r) { nx = t.x + (ex / (d || 1)) * t.r; nz = t.z + (ez / (d || 1)) * t.r; }
    }
    for (const l of nearbyLogs(nx, nz)) {
      const sInfo = segInfo(l, nx, nz), lim = l.r + 0.25;
      if (sInfo.d < lim && sInfo.top - feet > 0.6 && sInfo.t > 0.001 && sInfo.t < 0.999) {
        const ex = nx - sInfo.px, ez = nz - sInfo.pz, d = sInfo.d || 1e-3;
        nx = sInfo.px + (ex / d) * lim; nz = sInfo.pz + (ez / d) * lim;
      }
    }
    player.x = nx; player.z = nz;
  }
  const target = feetAt(player.x, player.z) + 1.65;
  player.eye = lerp(player.eye, target, 1 - Math.exp(-dt * (target > player.eye ? 10 : 6)));
}

// ---------------------------------------------------------------- input
const keyTarget = (e) => e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
addEventListener('keydown', (e) => { if (keyTarget(e)) return; input.keys.add(e.code); if (e.code === 'KeyM') toggle('pMap'); });
addEventListener('keyup', (e) => input.keys.delete(e.code));
addEventListener('blur', () => input.keys.clear());
const stickEl = $('stick'), knob = $('knob');
if (isTouch) { stickEl.hidden = false; $('hint').textContent = 'Left thumb to walk · drag right side to look'; }
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const isStick = e.pointerType !== 'mouse' && e.clientX < innerWidth * 0.45 && e.clientY > innerHeight * 0.4;
  if (isStick && !input.stick) {
    input.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stickEl.style.left = `${e.clientX - 60}px`; stickEl.style.top = `${e.clientY - 60}px`; stickEl.style.bottom = 'auto'; stickEl.style.opacity = 1;
  } else if (!input.look) input.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  hideHint();
});
canvas.addEventListener('pointermove', (e) => {
  if (input.stick && e.pointerId === input.stick.id) {
    let dx = e.clientX - input.stick.x, dy = e.clientY - input.stick.y; const d = Math.hypot(dx, dy), R = 55;
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.f = -dy / R; input.s = dx / R; input.run = d > R * 0.95;
  } else if (input.look && e.pointerId === input.look.id) {
    const k = e.pointerType === 'mouse' ? 0.0042 : 0.0058;
    player.yaw -= (e.clientX - input.look.x) * k; player.pitch = clamp(player.pitch - (e.clientY - input.look.y) * k, -1.35, 1.35);
    input.look.x = e.clientX; input.look.y = e.clientY;
  }
});
const endPointer = (e) => {
  if (input.stick && e.pointerId === input.stick.id) {
    input.stick = null; input.f = input.s = 0; input.run = false; knob.style.transform = '';
    stickEl.style.left = ''; stickEl.style.top = ''; stickEl.style.bottom = ''; stickEl.style.opacity = '';
  }
  if (input.look && e.pointerId === input.look.id) input.look = null;
};
canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
let hintTimer = setTimeout(hideHint, 9000);
function hideHint() { clearTimeout(hintTimer); $('hint').style.opacity = 0; }

// ---------------------------------------------------------------- panels
const panels = { pMap: 'bMap', pStand: 'bStand', pWorld: 'bWorld' };
function toggle(id, force) {
  for (const [p, b] of Object.entries(panels)) {
    const show = p === id ? (force ?? $(p).hidden) : false;
    $(p).hidden = !show; $(b).setAttribute('aria-pressed', String(show));
  }
  if (id === 'pMap' && !$('pMap').hidden) drawMapTop();
  if (id === 'pStand' && !$('pStand').hidden) drawFigures();
}
for (const [p, b] of Object.entries(panels)) $(b).addEventListener('click', () => toggle(p));
document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => toggle(null)));

const SPECIES_COLOR = ['#4f9fc0', '#d4ad3a', '#d0674a', '#e6e1d3']; // map identity colours: fir, pine, maple, birch
$('mapLegend').innerHTML = SPECIES.map((s, i) => `<span><i style="background:${SPECIES_COLOR[i]}"></i>${s.name}</span>`).join('') +
  '<span><i class="line" style="background:#a0784e"></i>Log</span><span><i style="background:#8d8a84"></i>Snag</span><span><i class="line" style="background:#6fa3c9"></i>Stream</span>';

function drawMapBase() {
  const c = $('mapBase'), g = c.getContext('2d'), S = c.width, img = g.createImageData(S, S), k = S / WORLD;
  const L = new THREE.Vector3(-0.5, 0.8, -0.6).normalize();
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const x = px / k - HALF, z = py / k - HALF;
    const hx = (ground(x + 2, z) - ground(x - 2, z)) / 4, hz = (ground(x, z + 2) - ground(x, z - 2)) / 4;
    const nl = (-hx * L.x + L.y - hz * L.z) / Math.sqrt(hx * hx + 1 + hz * hz);
    const li = sampleGrid(W.light, W.LN, x, z), st = sampleGrid(W.stream, N, x, z);
    let col = mix3([0.20, 0.27, 0.18], [0.66, 0.60, 0.44], clamp(li * 1.6, 0, 1));
    col = mix3(col, [0.42, 0.62, 0.76], smoothstep(0.35, 0.7, st));
    const sh = 0.55 + 0.6 * clamp(nl, 0, 1);
    const o = (py * S + px) * 4; img.data[o] = col[0] * sh * 255; img.data[o + 1] = col[1] * sh * 255; img.data[o + 2] = col[2] * sh * 255; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // contours every 5 m
  g.fillStyle = 'rgba(30,24,16,0.28)';
  for (let py = 0; py < S; py += 1) for (let px = 0; px < S; px += 1) {
    const x = px / k - HALF, z = py / k - HALF, h = Math.floor(ground(x, z) / 5);
    if (Math.floor(ground(x + 1 / k, z) / 5) !== h || Math.floor(ground(x, z + 1 / k) / 5) !== h) g.fillRect(px, py, 1, 1);
  }
  for (const t of W.trees) {
    const x = (t.x + HALF) * k, y = (t.z + HALF) * k;
    if (t.st === 2 && t.d >= 10) {
      g.strokeStyle = 'rgba(160,120,78,0.95)'; g.lineWidth = Math.max(1, (t.d / 100) * k * 2.5);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(t.ang) * t.len * k, y + Math.sin(t.ang) * t.len * k); g.stroke();
    }
  }
  for (const t of W.trees) {
    const x = (t.x + HALF) * k, y = (t.z + HALF) * k;
    if (t.st === 0 && t.d >= 10) { g.fillStyle = SPECIES_COLOR[t.sp] + '90'; g.beginPath(); g.arc(x, y, Math.max(1.1, crownRadius(t.sp, t.d) * k * 0.32), 0, 6.283); g.fill(); }
    else if (t.st === 1 && t.d >= 10) { g.fillStyle = '#8d8a84'; g.fillRect(x - 1.5, y - 1.5, 3, 3); }
  }
}
function drawMapTop() {
  const c = $('mapTop'), g = c.getContext('2d'), S = c.width, k = S / WORLD;
  g.clearRect(0, 0, S, S);
  const x = (player.x + HALF) * k, y = (player.z + HALF) * k;
  g.save(); g.translate(x, y); g.rotate(-player.yaw);
  g.fillStyle = '#d9a25b'; g.strokeStyle = '#1c1914'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, -14); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath(); g.stroke(); g.fill();
  g.restore();
  g.fillStyle = 'rgba(236,230,216,0.85)'; g.font = '500 20px "IBM Plex Mono", monospace';
  g.fillText('N ↑', 12, 28);
  g.fillRect(S - 12 - 100 * k, S - 20, 100 * k, 3); g.fillText('100 m', S - 12 - 100 * k, S - 28);
}
$('mapTop').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * WORLD - HALF, z = ((e.clientY - r.top) / r.height) * WORLD - HALF;
  if (Math.abs(x) > HALF - 8 || Math.abs(z) > HALF - 8) return;
  let tx = x, tz = z;
  for (let k = 0; k < 20 && blockedAt(tx, tz); k++) { tx += Math.cos(k) * 0.8; tz += Math.sin(k) * 0.8; }
  player.x = tx; player.z = tz; player.eye = feetAt(tx, tz) + 1.65; refreshNear(tx, tz, true); drawMapTop();
});

// stand panel
const REF = { stems: '300–700', ba: '25–50', snags: '10–60', logs: '50–400', logVol: '5–200', saplings: '—' };
function fillStand() {
  const s = W.stats, f0 = (v) => Math.round(v).toLocaleString(), f1 = (v) => v.toFixed(1);
  const comp = SPECIES.map((p, i) => [p.name, s.bySpeciesBA[i] / (s.ba || 1)]).sort((a, b) => b[1] - a[1]).filter((a) => a[1] > 0.05).map(([n, v]) => `${n} ${Math.round(v * 100)}%`).join(' · ');
  $('standSub').textContent = `${W.age} years after a stand-replacing fire, ${W.opt.moisture} climate, ${W.stats.storms} windstorm${W.stats.storms === 1 ? '' : 's'}. Basal area: ${comp}.`;
  const rows = [
    ['Live trees ≥ 10 cm', `${f0(s.stems)} /ha`, REF.stems],
    ['Saplings < 10 cm', `${f0(s.saplings)} /ha`, REF.saplings],
    ['Basal area', `${f1(s.ba)} m²/ha`, REF.ba],
    ['Standing dead (snags)', `${f0(s.snags)} /ha`, REF.snags],
    ['Down logs ≥ 10 cm', `${f0(s.logs)} /ha`, REF.logs],
    ['  of which uprooted', `${f0(s.uprooted)} /ha`, ''],
    ['Down log volume', `${f1(s.logVol)} m³/ha`, REF.logVol],
    ['Snag volume', `${f1(s.snagVol)} m³/ha`, ''],
  ];
  $('standTable').innerHTML = '<tr><th>Measure</th><th>This world</th><th>Typical</th></tr>' + rows.map(([a, b, c]) => `<tr><td>${a}</td><td class="v">${b}</td><td class="r">${c}</td></tr>`).join('');
}
function setupFig(canvasEl) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = canvasEl.clientWidth || 380, h = canvasEl.clientHeight || 150;
  canvasEl.width = w * dpr; canvasEl.height = h * dpr;
  const g = canvasEl.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const FIG = { ink2: '#b9b09c', ink3: '#8a8270', grid: 'rgba(236,230,216,0.10)', mark: '#d9a25b' };
function axes(g, w, h, pad, xmax, ymax, xlab, ylab, xticks, yticks) {
  g.font = '11px "IBM Plex Mono", monospace'; g.fillStyle = FIG.ink3; g.strokeStyle = FIG.grid; g.lineWidth = 1;
  const X = (v) => pad.l + (v / xmax) * (w - pad.l - pad.r), Y = (v) => h - pad.b - (v / ymax) * (h - pad.t - pad.b);
  for (const t of yticks) { g.beginPath(); g.moveTo(pad.l, Y(t)); g.lineTo(w - pad.r, Y(t)); g.stroke(); g.textAlign = 'right'; g.fillText(String(t), pad.l - 5, Y(t) + 4); }
  g.textAlign = 'center'; for (const t of xticks) g.fillText(String(t), X(t), h - pad.b + 14);
  g.textAlign = 'right'; g.fillText(xlab, w - pad.r, h - 2); g.textAlign = 'left'; g.fillText(ylab, 2, 10);
  return { X, Y };
}
const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / p / 2) * 2 * p; };
function drawFigures() {
  const s = W.stats, pad = { l: 34, r: 8, t: 16, b: 30 };
  { // DBH histogram
    const el = $('figDbh'), { g, w, h } = setupFig(el), bins = s.dbhBins.slice(1), last = Math.max(4, bins.reduce((m, v, i) => (v > 0.05 ? i : m), 0) + 2);
    const ymax = niceMax(Math.max(...bins)), xmax = (last + 2) * 5;
    const { X, Y } = axes(g, w, h, pad, xmax, ymax, 'dbh, cm', 'stems/ha', Array.from({ length: Math.floor(xmax / 20) + 1 }, (_, i) => i * 20), [0, ymax / 2, ymax]);
    g.fillStyle = FIG.mark;
    const bars = [];
    for (let i = 0; i < last; i++) {
      const x0 = X(i * 5 + 5) + 1, x1 = X(i * 5 + 10) - 1, y = Y(bins[i] || 0);
      const hh = h - pad.b - y; if (hh > 0.5) { roundTop(g, x0, y, x1 - x0, hh, Math.min(3, (x1 - x0) / 2)); }
      bars.push([x0, x1, i]);
    }
    el.onpointermove = (e) => { const r = el.getBoundingClientRect(), mx = e.clientX - r.left; const b = bars.find(([a, c]) => mx >= a - 1 && mx <= c + 1); $('roDbh').textContent = b ? `${(b[2] + 1) * 5}–${(b[2] + 2) * 5} cm: ${Math.round(bins[b[2]])} stems/ha` : ''; };
    el.onpointerleave = () => ($('roDbh').textContent = '');
  }
  { // g(r)
    const el = $('figGr'), { g, w, h } = setupFig(el), gr = s.gr, dr = s.grDr, xmax = gr.length * dr, ymax = Math.max(1.6, Math.ceil(Math.max(...gr) * 5) / 5);
    const { X, Y } = axes(g, w, h, pad, xmax, ymax, 'r, m', 'g(r)', [0, 5, 10, 15, 20, 25], [0, 1, ymax > 1.6 ? +ymax.toFixed(1) : 1.6]);
    g.strokeStyle = 'rgba(236,230,216,0.35)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(0), Y(1)); g.lineTo(X(xmax), Y(1)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = FIG.mark; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
    gr.forEach((v, i) => { const x = X((i + 0.5) * dr), y = Y(v); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    const cross = (mx) => { const i = clamp(Math.floor((((mx - pad.l) / (w - pad.l - pad.r)) * xmax) / dr), 0, gr.length - 1); return i; };
    el.onpointermove = (e) => { const r = el.getBoundingClientRect(); const i = cross(e.clientX - r.left); $('roGr').textContent = `r = ${(i * dr).toFixed(0)}–${((i + 1) * dr).toFixed(0)} m: g = ${gr[i].toFixed(2)}`; };
    el.onpointerleave = () => ($('roGr').textContent = '');
  }
}
function roundTop(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h); g.closePath(); g.fill(); }

// world panel
const fSeed = $('fSeed'), fAge = $('fAge'), fMoist = $('fMoist'), fStorm = $('fStorm'), fQual = $('fQual');
function syncForm() { fSeed.value = settings.seed; fAge.value = String(settings.age); fMoist.value = settings.moisture; fStorm.value = settings.storms; fQual.value = settings.quality; }
syncForm();
$('bDice').addEventListener('click', () => { fSeed.value = 1 + Math.floor(Math.random() * 99999); });
$('bRegen').addEventListener('click', () => {
  const q = fQual.value !== settings.quality;
  Object.assign(settings, { seed: clamp(parseInt(fSeed.value, 10) || 1, 1, 999999), age: +fAge.value, moisture: fMoist.value, storms: fStorm.value, quality: fQual.value });
  saveSettings(); toggle(null);
  if (q && renderer.capabilities) { location.reload(); return; } // antialiasing is fixed at context creation
  start();
});

// ---------------------------------------------------------------- quality, resize, loop
function applyQuality() {
  const high = settings.quality === 'high';
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, high ? 2 : 1.25));
  renderer.shadowMap.enabled = true;
  sun.castShadow = true;
  sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
  sun.shadow.map?.dispose(); sun.shadow.map = null;
  resize();
}
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);

let last = performance.now(), frames = 0, fpsT = 0, frameNo = 0, running = false;
function loop(now) {
  requestAnimationFrame(loop);
  if (!running) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  uTime.value = now / 1000;
  movePlayer(dt);
  refreshNear(player.x, player.z);
  camera.position.set(player.x, player.eye, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  sky.position.copy(camera.position);
  // shadow camera follows the player, snapped to texels to avoid shimmering
  const texel = 96 / sun.shadow.mapSize.x, sx = Math.round(player.x / texel) * texel, sz = Math.round(player.z / texel) * texel;
  sun.target.position.set(sx, player.eye - 1.6, sz); sun.position.copy(sun.target.position).addScaledVector(sunDir, 150);
  renderer.shadowMap.needsUpdate = frameNo % 2 === 0;
  updateTiles();
  renderer.render(scene, camera);
  frameNo++; frames++; fpsT += dt;
  if (fpsT > 0.5) {
    $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0;
    const f = fieldAt(player.x, player.z);
    $('hudHere').textContent = `elev ${ground(player.x, player.z).toFixed(0)} m · slope ${Math.round(Math.atan(f.sl) * 57.3)}° · sky ${Math.round(f.L * 100)}% · wet ${f.wet.toFixed(2)}`;
    if (!$('pMap').hidden) drawMapTop();
  }
}
renderer.shadowMap.autoUpdate = false;

function updateTiles() {
  for (const t of tiles) {
    const dx = Math.max(0, Math.abs(t.userData.cx - player.x) - 32), dz = Math.max(0, Math.abs(t.userData.cz - player.z) - 32);
    const d = Math.hypot(dx, dz);
    t.visible = d < 330;
    const nearTile = d < 30;
    for (const m of t.userData.hi) m.visible = nearTile;
    for (const m of t.userData.lo) m.visible = !nearTile;
  }
}

async function start() {
  running = false;
  $('loading').hidden = false; $('err').textContent = '';
  const fill = $('loadFill'), stage = $('loadStage');
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    applyQuality();
    W = await generateWorld({ seed: settings.seed, age: settings.age, moisture: settings.moisture, storms: settings.storms }, async (msg, p) => {
      stage.textContent = msg; fill.style.width = `${Math.round(p * 100)}%`; await nextFrame();
    });
    stage.textContent = 'Building meshes'; await nextFrame();
    buildWorld(); spawn(); refreshNear(player.x, player.z, true);
    drawMapBase(); fillStand();
    const s = W.stats;
    $('hudWorld').textContent = `seed ${W.seed} · ${W.age} yr · ${Math.round(s.stems)} trees/ha · ${s.logVol.toFixed(0)} m³/ha down wood`;
    $('genNote').textContent = `Last generation took ${(W.genMs / 1000).toFixed(1)} s on this device for ${W.trees.length.toLocaleString()} stems, snags and logs.`;
    fill.style.width = '100%';
    renderer.shadowMap.needsUpdate = true;
    renderer.compile(scene, camera);
    $('loading').hidden = true;
    last = performance.now(); running = true;
  } catch (err) {
    console.error(err); $('err').textContent = `Could not build the world: ${err.message}. Reload the page to try again.`;
  }
}
requestAnimationFrame(loop);
start();

// Small debugging handle for automated screenshots and console poking.
window.foothold = {
  get world() { return W; }, player, settings,
  pause() { running = false; },
  info() { return { near: Object.fromEntries(Object.entries(near.b).map(([k, v]) => [k, v.n])), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries }; },
  renderOnce() { refreshNear(player.x, player.z, true); camera.position.set(player.x, player.eye, player.z); camera.rotation.set(player.pitch, player.yaw, 0); sky.position.copy(camera.position); renderer.shadowMap.needsUpdate = true; uTime.value = 0; updateTiles(); renderer.render(scene, camera); },
};

// Foothold renderer, controls and UI. World data comes from ./worldgen.js.
import * as THREE from 'three';
import { generateWorld, sampleGrid, SPECIES, REGIONS, isConifer, GEOLOGY, crownRadius, crownFraction, treeHeight, plateRadius, plateThickness, WORLD, N, NF, CELL, HALF, hash3, mulberry32, makeNoise2D, clamp, smoothstep } from './worldgen.js';
import { settleDeadfall, trunkProfile } from './deadfall.js';
import { buildGymWorld, gymToWorld, stationOrigin, STATIONS } from './gym.js';
import * as SK from './skeleton.js';
import * as PL from './plants.js';
import * as PH from './physics.js';
import * as MD from './modal.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------------------------------------------------------------- settings
const settings = { seed: 1, age: 160, moisture: 'mesic', storms: 'occasional', geology: 'granite', region: 'temperate', season: 'summer', quality: isTouch ? 'low' : 'high', motion: 'full', view: 'first', body: 'hidden', place: 'forest' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('foothold.settings') || '{}')); } catch (e) { /* storage unavailable */ }
try { if (/(^|[?#&])gym\b/.test(location.search.slice(1) + '&' + location.hash.slice(1))) settings.place = 'gym'; } catch (e) { /* no location */ }
try { // world settings in the link, e.g. #region=mediterranean&season=autumn&seed=4 (shareable, and used by tests)
  const q = new URLSearchParams(location.hash.slice(1));
  for (const k of ['region', 'season', 'moisture', 'geology', 'storms']) if (q.get(k)) settings[k] = q.get(k);
  if (q.get('seed')) settings.seed = +q.get('seed'); if (q.get('age')) settings.age = +q.get('age');
} catch (e) { /* no location */ }
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
  litter: canvasTex(256, 256, (g, w, h, r) => {
    for (let k = 0; k < 90; k++) {
      const x = w * (0.08 + 0.84 * r()), y = h * (0.08 + 0.84 * r()), s = 5 + r() * 9;
      const yel = r() < 0.15;
      g.fillStyle = yel ? hsl(42 + r() * 10, 55, 42 + r() * 10) : hsl(18 + r() * 22, 30 + r() * 30, 20 + r() * 22);
      g.save(); g.translate(x, y); g.rotate(r() * 6.283);
      g.beginPath(); g.moveTo(-s, 0); g.quadraticCurveTo(0, -s * 0.6, s, 0); g.quadraticCurveTo(0, s * 0.6, -s, 0); g.fill();
      g.strokeStyle = 'rgba(30,20,12,0.5)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.stroke();
      g.restore();
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
    g.fillStyle = '#4a3828'; g.fillRect(0, 0, w, h);
    for (let n = 0; n < 500; n++) { const v = 40 + r() * 55; g.fillStyle = `rgba(${v + 18},${v + 4},${v * 0.7},0.75)`; g.beginPath(); g.arc(r() * w, r() * h, 1 + r() * 4, 0, 6.283); g.fill(); }
    for (let n = 0; n < 60; n++) { const v = 110 + r() * 50; g.fillStyle = `rgba(${v},${v * 0.97},${v * 0.92},0.8)`; g.fillRect(r() * w, r() * h, 2 + r() * 3, 2 + r() * 3); } // stones in the plate
    for (let k = 0; k < 26; k++) { // tangled roots
      let x = r() * w, y = r() * h, a = r() * 6.283; g.strokeStyle = `rgba(${95 + r() * 40},${72 + r() * 25},${52 + r() * 15},0.95)`; g.lineWidth = 1 + r() * 2.5;
      g.beginPath(); g.moveTo(x, y); for (let s = 0; s < 8; s++) { a += (r() - 0.5) * 1.2; x += Math.cos(a) * 6; y += Math.sin(a) * 6; g.lineTo(x, y); } g.stroke();
    }
  }, { repeat: true }),
};
tex.bark.repeat.set(1, 6);


// ---------------------------------------------------------------- materials
const uTime = { value: 0 };
// Vegetation the body touches: up to 4 shrubs being pushed (base position + height, displacement + radius) and two feet.
const PUSH = {
  uPA: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uPB: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
  uFeet: { value: Array.from({ length: 2 }, () => new THREE.Vector4()) },
};
// The body as ten capsules (bodyCapsules), for foliage that is not simulated or not exactly where its proxy says:
// any vertex inside a capsule is pushed out to its surface (plus 2.5 cm), less near the plant's base, which is rooted.
// Grass, sedges and leaves are too soft to push back; this is how they respond. uCapBound: the body's bounding sphere.
const BODYCAP = {
  uCapA: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, -1e6, 0, 0)) }, uCapB: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, -1e6, 0, 0)) },
  uCapBound: { value: new THREE.Vector4(0, -1e6, 0, 0) },
};
const BODYCAP_GLSL = `uniform vec4 uCapA[10]; uniform vec4 uCapB[10]; uniform vec4 uCapBound;
  vec3 bodyGuard(vec3 wp, float baseY) {
    vec3 d = vec3(0.0);
    if (length(wp - uCapBound.xyz) > uCapBound.w) return d;
    float root = clamp((wp.y - baseY) / 0.15, 0.0, 1.0);
    for (int i = 0; i < 10; i++) {
      vec3 a = uCapA[i].xyz, ab = uCapB[i].xyz - a, q = wp + d; float R = uCapA[i].w + 0.025;
      float t = clamp(dot(q - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0); vec3 o = q - (a + ab * t); float r = length(o);
      if (r < R) d += (r > 1e-4 ? o / r : vec3(1.0, 0.0, 0.0)) * (R - r) * root;
    }
    return d;
  }
`;
function setBodyCaps(C) {
  let cx = 0, cy = 0, cz = 0; const n = C.length / 7;
  for (let i = 0; i < 10; i++) { if (i < n) { const c = i * 7; BODYCAP.uCapA.value[i].set(C[c], C[c + 1], C[c + 2], C[c + 6]); BODYCAP.uCapB.value[i].set(C[c + 3], C[c + 4], C[c + 5], 0); cx += C[c] + C[c + 3]; cy += C[c + 1] + C[c + 4]; cz += C[c + 2] + C[c + 5]; } else { BODYCAP.uCapA.value[i].set(0, -1e6, 0, 0); BODYCAP.uCapB.value[i].set(0, -1e6, 0, 0); } }
  BODYCAP.uCapBound.value.set(cx / (2 * n), cy / (2 * n), cz / (2 * n), 1.6);
}
// A pushed plant bends like a pole loaded at one point: the hand (or body) at height h above its base, displaced by
// s = uPB.xy there. Below h the stem takes the cantilever's point-load deflection, s * u^2 (3 - u) / 2 with u = y / h,
// tilting with the local slope. Above h nothing bends: the rest of the plant is carried rigidly, rotated by the stem's
// angle at the load point, atan(1.5 |s| / h). Stems don't stretch: the load point drops by 0.6 |s|^2 / h (the arc
// length of that curve), points below drop in proportion.
// uPA: base x, y, z, load height h. uPB: s.x, s.z, tolerance for recognising the plant's own instances, active flag.
function pushPatch(sh, footR) {
  Object.assign(sh.uniforms, PUSH, BODYCAP, { uFootR: { value: footR } });
  sh.vertexShader = BODYCAP_GLSL + `uniform vec4 uPA[4]; uniform vec4 uPB[4]; uniform vec4 uFeet[2]; uniform float uFootR;
    // io: this instance's origin (world), up: how upright its local Y axis is. Only the pushed plant's own upright
    // instances follow the push; logs, fallen branches and neighbouring plants stay put.
    vec3 pushDisp(vec3 wp, vec3 io, float up){
      vec3 d = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        vec4 a = uPA[i], b = uPB[i]; if (b.w <= 0.0 || up < 0.8 || length(io.xz - a.xz) > b.z) continue;
        float sa = length(b.xy), y = wp.y - a.y; if (sa < 1e-5 || y <= 0.0) continue;
        vec2 D = b.xy / sa; float h = max(a.w, 0.2), vd = dot(wp.xz - a.xz, D);
        if (y < h) {
          float u = y / h, s = sa * u * u * (3.0 - u) * 0.5, th = atan(1.5 * sa * (2.0 * u - u * u) / h);
          d.xz += D * (s + vd * (cos(th) - 1.0)); d.y -= 0.6 * s * s / max(y, 0.05) + vd * sin(th);
        } else {
          float th = atan(1.5 * sa / h), c = cos(th), sn = sin(th), vu = y - h;
          d.xz += D * (sa + vu * sn + vd * c - vd); d.y += h - 0.6 * sa * sa / h + vu * c - vd * sn - y;
        }
      }
      for (int i = 0; i < 0; i++) {           // (legs: now bodyGuard)
        vec4 f = uFeet[i]; if (f.w <= 0.0 || uFootR <= 0.0) continue;
        vec2 o = wp.xz - f.xz; float r = length(o), h = wp.y - f.y;
        float w = (1.0 - smoothstep(0.0, uFootR, r)) * clamp(h / 0.2, 0.0, 1.0) * (1.0 - smoothstep(0.8, 1.2, h));
        d.xz += (o / max(r, 1e-3)) * w * uFootR * 0.6; d.y -= w * 0.06;
      }
      return d;
    }
  ` + sh.vertexShader.replace('#include <project_vertex>', `
    vec4 mvPosition = vec4(transformed, 1.0);
    vec3 pushIO = vec3(1e6); float pushUp = 0.0;
    #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
      pushIO = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
      pushUp = normalize(instanceMatrix[1].xyz).y;
    #endif
    mvPosition = modelMatrix * mvPosition;
    mvPosition.xyz += pushDisp(mvPosition.xyz, pushIO, pushUp);
    mvPosition.xyz += bodyGuard(mvPosition.xyz, pushIO.y < 1e5 ? pushIO.y : -1e6);
    mvPosition = viewMatrix * mvPosition;
    gl_Position = projectionMatrix * mvPosition;`);
}
function foliageMaterial(map, { wind = 0.012, alphaTest = 0.42, footR = null } = {}) {
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
    if (footR !== null) pushPatch(sh, footR);
  };
  if (footR !== null) m.customProgramCacheKey = () => `push${footR}`;
  return m;
}
const mats = {
  leaf: foliageMaterial(tex.leaf, { footR: 0 }),
  needle: foliageMaterial(tex.needle, { alphaTest: 0.38, footR: 0 }),
  needleStill: foliageMaterial(tex.needle, { alphaTest: 0.38, wind: 0 }), leafStill: foliageMaterial(tex.leaf, { wind: 0 }), // meshes built in world coordinates: the wind term scales with y
  shrub: foliageMaterial(tex.shrub, { wind: 0.04, footR: 0.5 }),
  fern: foliageMaterial(tex.fern, { wind: 0.06, alphaTest: 0.4, footR: 0.45 }),
  grass: foliageMaterial(tex.grass, { wind: 0.09, alphaTest: 0.35, footR: 0.32 }),
  bark: new THREE.MeshLambertMaterial({ map: tex.bark }),
  root: new THREE.MeshLambertMaterial({ map: tex.bark, vertexColors: true }),
  soil: new THREE.MeshLambertMaterial({ map: tex.soil }),
  wood: new THREE.MeshLambertMaterial({ map: tex.bark }),
  litter: new THREE.MeshLambertMaterial({ map: null, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  water: new THREE.MeshPhongMaterial({ color: new THREE.Color().setRGB(0.10, 0.13, 0.11, THREE.SRGBColorSpace), specular: 0x9aa4a0, shininess: 90, transparent: true, opacity: 0.82 }),
};

// terrain: a 2 m mesh for the whole world plus a 0.5 m patch that follows the player.
// Both read ecological fields from textures (smooth bilinear, no triangle-shaped colour blotches) and add
// per-pixel grit: albedo speckle and a bump-mapped micro-normal that fades with distance.
const terrainU = {
  uHF: { value: null }, uHC: { value: null }, uEcoA: { value: null }, uEcoB: { value: null },
  uCenter: { value: new THREE.Vector2(0, 0) }, uPatchHalf: { value: 48 }, uStone: { value: new THREE.Color(0.5, 0.48, 0.45) },
};
const NOISE_GLSL = `
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
  // two value-noise lattices rotated against each other: no visible grid at close range
  float vr(vec2 p){ return 0.5 * (vn(p) + vn(mat2(0.8, -0.6, 0.6, 0.8) * p * 1.13 + 17.3)); }`;
const TERRAIN_FRAG_HEAD = `varying vec3 vW; varying vec3 vNw;
  uniform sampler2D uEcoA; uniform sampler2D uEcoB; uniform vec2 uCenter; uniform float uPatchHalf; uniform float uDiscard; uniform vec3 uStone;
  ${NOISE_GLSL}
  vec2 ecoUV(vec2 xz){ return ((xz + ${HALF.toFixed(1)}) / ${CELL.toFixed(1)} + 0.5) / ${N.toFixed(1)}; }
  float bumpH(vec2 P, float rough){ return (0.012 * vr(P * 8.0) + 0.006 * vr(P * 21.0 + 3.1)) * rough + 0.02 * smoothstep(0.72, 0.9, vr(P * 4.3)) * rough; }
  float triN(vec3 p, vec3 w, float s){ return vr(p.zy * s) * w.x + vr(p.xz * s + 5.0) * w.y + vr(p.xy * s + 9.0) * w.z; }
`;
const TERRAIN_COLOR = `
  #include <color_fragment>
  if (uDiscard > 0.5 && abs(vW.x - uCenter.x) < uPatchHalf - 0.25 && abs(vW.z - uCenter.y) < uPatchHalf - 0.25) discard;
  vec2 P = vW.xz;
  vec4 eA = texture2D(uEcoA, ecoUV(P)); vec4 eB = texture2D(uEcoB, ecoUV(P));
  float wet = eA.r, li = eA.g, con = eA.b, rk = eA.a, strm = eB.r;
  float dist = length(vViewPosition), near = 1.0 - smoothstep(8.0, 45.0, dist);
  float n1 = vn(P * 1.9), n2 = vn(P * 0.42 + 7.0), n3 = vn(P * 0.07 + 3.0), n4 = vn(P * 7.0), n5 = vn(P * 0.9 + 11.0);
  float n6 = vr(P * 17.0 + 1.7), n7 = vr(P * 41.0);
  vec3 litter = mix(vec3(0.36, 0.27, 0.17), vec3(0.48, 0.36, 0.22), n1 * 0.6 + n4 * 0.4);
  vec3 duff = mix(vec3(0.28, 0.19, 0.12), vec3(0.39, 0.27, 0.17), n1 * 0.6 + n6 * 0.4);
  vec3 moss = mix(vec3(0.21, 0.25, 0.11), vec3(0.33, 0.35, 0.17), n2 * 0.6 + n4 * 0.4);
  vec3 grass = mix(vec3(0.38, 0.38, 0.20), vec3(0.56, 0.50, 0.31), n2 * 0.6 + n1 * 0.4);
  vec3 mud = mix(vec3(0.15, 0.12, 0.09), vec3(0.24, 0.20, 0.15), n4);
  vec3 an = abs(normalize(vNw)); vec3 tw = pow(an, vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
  float s1 = triN(vW, tw, 0.6), s2 = triN(vW, tw, 2.7), s3 = triN(vW, tw, 11.0), s4 = triN(vW, tw, 37.0) * near;
  vec3 stone = uStone * (0.55 + 0.35 * s1 + 0.25 * s2 + 0.26 * (s3 - 0.5) + 0.2 * (s4 - 0.5 * near));
  stone *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.025, abs(triN(vW * vec3(1.0, 2.2, 1.0) + (s2 - 0.5) * 0.7, tw, 0.9) - 0.5))) * smoothstep(0.4, 0.6, s1);
  vec3 c = mix(litter, duff, clamp(con * 1.2 - 0.1, 0.0, 1.0));
  float g = smoothstep(0.38, 0.85, li + (n2 - 0.5) * 0.4 + (n5 - 0.5) * 0.15);
  c = mix(c, grass, g);
  float m = smoothstep(0.62, 1.0, wet + (n2 - 0.5) * 0.55 + (n1 - 0.5) * 0.2) * (1.0 - 0.5 * g);
  c = mix(c, moss, m * 0.75);
  float s = smoothstep(0.25, 0.8, strm + (n1 - 0.5) * 0.3);
  c = mix(c, mud, s);
  float steep = 1.0 - normalize(vNw).y;
  float r = clamp(smoothstep(0.30, 0.52, steep + (n1 - 0.5) * 0.25) + rk * smoothstep(0.42, 0.6, n3 * 0.5 + n5 * 0.3 + n4 * 0.2), 0.0, 1.0);
  c = mix(c, stone, r);
  // grit: gravel and pebble speckle, stronger on rock, stream beds and bare soil; fades with distance to avoid shimmer
  float peb = smoothstep(0.7, 0.85, n6) * (0.25 + 0.75 * max(r, s));
  c = mix(c, uStone * (0.8 + 0.4 * n7), peb * 0.6 * near);
  c *= mix(1.0, 0.85 + 0.3 * n7, near * (0.5 + 0.3 * r));
  c *= 0.82 + 0.36 * n4 * (0.6 + 0.4 * n1);
  c *= 0.88 + 0.24 * n3;
  c *= mix(0.84, 1.0, li);
  diffuseColor.rgb = pow(c, vec3(2.2));
  float roughK = (0.6 + 1.4 * max(r, s)) * near;`;
const TERRAIN_NORMAL = `
  #include <normal_fragment_maps>
  {
    float e = 0.035, b0 = bumpH(P, roughK), bx = bumpH(P + vec2(e, 0.0), roughK), bz = bumpH(P + vec2(0.0, e), roughK);
    vec3 gw = vec3((bx - b0) / e, 0.0, (bz - b0) / e);
    normal = normalize(normal - (viewMatrix * vec4(gw, 0.0)).xyz);
  }`;
function terrainFragment(sh) {
  sh.fragmentShader = TERRAIN_FRAG_HEAD + sh.fragmentShader.replace('#include <color_fragment>', TERRAIN_COLOR).replace('#include <normal_fragment_maps>', TERRAIN_NORMAL);
}
// far mesh: positions from attributes, cut away under the near patch
const terrainMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
terrainMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, terrainU, { uDiscard: { value: 1 } });
  sh.vertexShader = 'varying vec3 vW; varying vec3 vNw;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vNw = normal;');
  terrainFragment(sh);
};
// near patch: a fixed grid displaced on the GPU from the 0.5 m heightmap; blends to the coarse surface at its rim
const nearTerrainMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
nearTerrainMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, terrainU, { uDiscard: { value: 0 } });
  sh.vertexShader = `varying vec3 vW; varying vec3 vNw;
    uniform sampler2D uHF; uniform sampler2D uHC; uniform vec2 uCenter; uniform float uPatchHalf;
    float hfAt(ivec2 c){ return texelFetch(uHF, clamp(c, ivec2(0), ivec2(${NF - 1})), 0).r; }
    float hcAt(ivec2 c){ return texelFetch(uHC, clamp(c, ivec2(0), ivec2(${N - 1})), 0).r; }
    float coarseH(vec2 w){
      vec2 g = (w + ${HALF.toFixed(1)}) / ${CELL.toFixed(1)}; ivec2 i = clamp(ivec2(floor(g)), ivec2(0), ivec2(${N - 2})); vec2 f = g - vec2(i);
      float h00 = hcAt(i), h10 = hcAt(i + ivec2(1, 0)), h01 = hcAt(i + ivec2(0, 1)), h11 = hcAt(i + ivec2(1, 1));
      return (f.x + f.y < 1.0) ? h00 + f.x * (h10 - h00) + f.y * (h01 - h00) : h11 + (1.0 - f.x) * (h01 - h11) + (1.0 - f.y) * (h10 - h11);
    }
  ` + sh.vertexShader.replace('#include <beginnormal_vertex>', `
    vec2 wxz = uCenter + position.xz;
    ivec2 cc = ivec2(floor((wxz + ${HALF.toFixed(1)}) * 2.0 + 0.5));
    float hF = hfAt(cc);
    vec3 nF = normalize(vec3(hfAt(cc - ivec2(1, 0)) - hfAt(cc + ivec2(1, 0)), 1.0, hfAt(cc - ivec2(0, 1)) - hfAt(cc + ivec2(0, 1))));
    float wB = smoothstep(0.0, 6.0, uPatchHalf - max(abs(position.x), abs(position.z)));
    float hC = coarseH(wxz);
    vec3 nC = normalize(vec3(coarseH(wxz - vec2(1.0, 0.0)) - coarseH(wxz + vec2(1.0, 0.0)), 2.0, coarseH(wxz - vec2(0.0, 1.0)) - coarseH(wxz + vec2(0.0, 1.0))));
    vec3 objectNormal = normalize(mix(nC, nF, wB));
  `).replace('#include <begin_vertex>', 'vec3 transformed = vec3(wxz.x, mix(hC, hF, wB), wxz.y); vW = transformed; vNw = objectNormal;');
  terrainFragment(sh);
};
function nearPatchGeo(half = 48, step = 0.5) {
  const n = Math.round((half * 2) / step) + 1, pos = new Float32Array(n * n * 3), idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = (j * n + i) * 3; pos[k] = -half + i * step; pos[k + 2] = -half + j * step; }
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
  return g;
}

mats.bark.onBeforeCompile = (sh) => { bendPatch(sh); pushPatch(sh, 0); };
mats.wood.onBeforeCompile = (sh) => pushPatch(sh, 0); // tall-shrub stems bend with their foliage
mats.litter.map = tex.litter;

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
      const ao = c < 0 ? k.ao0 : k.ao1, mu = k.mul || [1, 1, 1]; col.push(ao * mu[0], ao * mu[1], ao * mu[2]);
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
  const prof = [[0, 0], [0.8, 0], [0.66, 0.025], [0.55, 0.07], [0.5, 0.14], [0.48, 0.24], [0.46, 0.34], [0.44, 0.45], [0.42, 0.56], [0.39, 0.67], [0.36, 0.78], [0.33, 0.89], [0.3, 1], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y));
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
// A broken length of log: radius 1 along local Y in [0, 1], ragged ends. The butt piece keeps the root flare.
const BUTT_PROFILE = [[0, 1.7], [0.025, 1.4], [0.07, 1.17], [0.14, 1.06], [0.24, 1.02], [1, 1]];
const buttProfile = (u) => { for (let i = 1; i < BUTT_PROFILE.length; i++) if (u <= BUTT_PROFILE[i][0]) { const [a, ra] = BUTT_PROFILE[i - 1], [b, rb] = BUTT_PROFILE[i]; return lerp(ra, rb, (u - a) / (b - a)); } return 1; };
function pieceGeo(butt, sides) {
  const prof = butt ? [[0, 0], ...BUTT_PROFILE.map(([y, x]) => [x, y]), [0.6, 1.0], [0, 0.985]] : [[0, 0.015], [0.6, 0], [1, 0.02], [1, 0.98], [0.6, 1.0], [0, 0.985]];
  const g = new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), sides), p = g.attributes.position, r = mulberry32(butt ? 17 : 23);
  const bumps = Array.from({ length: sides + 1 }, () => 0.92 + 0.16 * r()), jag = Array.from({ length: sides + 1 }, () => (r() - 0.5) * 0.05);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i), k = Math.round(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * sides) % sides;
    p.setX(i, x * bumps[k]); p.setZ(i, z * bumps[k]);
    if (y > 0.95 || (!butt && y < 0.05)) p.setY(i, y + jag[k] * (y > 0.5 ? 1 : -1)); // splintered break faces
  }
  g.computeVertexNormals();
  return g;
}
// A broken stem standing: root flare at the foot, splintered top (local Y in [0, 1], radius 1 = the stem's).
// Low stumps (under ~2.5 m) keep the flare over the bottom third; tall snapped stems compress it to the first metre.
function stumpGeo(tall) {
  const prof = tall ? [[0, 0], [1.55, 0], [1.3, 0.008], [1.12, 0.02], [1.04, 0.04], [1, 0.08], [0.9, 1], [0.5, 0.985], [0, 0.96]]
    : [[0, 0], [1.55, 0], [1.3, 0.04], [1.12, 0.1], [1.04, 0.2], [1, 0.35], [0.96, 1], [0.5, 0.985], [0, 0.95]];
  const g = new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 8), p = g.attributes.position, r = mulberry32(tall ? 41 : 43);
  const bumps = Array.from({ length: 9 }, () => 0.92 + 0.16 * r()), spike = Array.from({ length: 9 }, () => (r() - 0.35) * (tall ? 0.12 : 0.16));
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i), k = Math.round(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 8) % 8;
    p.setX(i, x * bumps[k]); p.setZ(i, z * bumps[k]);
    if (y > 0.9) p.setY(i, y + spike[k] * (Math.hypot(x, z) > 0.7 ? 1 : 0.4)); // splinters round the rim, a lower broken core
  }
  g.computeVertexNormals();
  return g;
}
function rootPlateGeo() {
  // A torn-up root wad: a lumpy lens of soil, thick in the middle and ragged at the rim (local Y is its thin axis).
  const g = mergeVerts(new THREE.IcosahedronGeometry(1, 2)), p = g.attributes.position, nz = makeNoise2D(mulberry32(9)), uv = [];
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x), rim = 0.75 + 0.35 * nz(Math.cos(a) * 1.7, Math.sin(a) * 1.7) + 0.12 * nz(x * 4, z * 4 + y);
    x *= rim; z *= rim; y *= 0.45 * (0.6 + 0.5 * Math.hypot(p.getX(i), p.getZ(i)) < 0.5 ? 1 : 0.7);
    p.setXYZ(i, x, y, z); uv.push(a / 6.283 + 0.5, y + 0.5);
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
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
// ---------------------------------------------------------------- stems that bend
// Per-instance stem form, applied in the vertex shader in metres: lean of the top (aBend.xy), basal "pistol-butt"
// sweep from slope creep (aBend.zw), and sinuosity (aWob: amplitude, wavenumber, phase, vertical scale).
// The offset is converted into the instance's local frame so lighting, shadows and depth all see the same shape.
const BEND_GLSL = `attribute vec4 aBend; attribute vec4 aWob;
  vec2 bendXZ(float yu, float H){
    float y = yu * H, env = smoothstep(0.0, 2.0, y);
    vec2 o = aBend.xy * yu + aBend.zw * (1.0 - exp(-y / 1.8));
    return o + aWob.x * env * vec2(sin(aWob.y * y + aWob.z), aWob.w * sin(0.73 * aWob.y * y + 1.3 * aWob.z));
  }
`;
function bendPatch(sh) {
  sh.vertexShader = BEND_GLSL + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    #ifdef USE_INSTANCING
    { float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz), sz = length(instanceMatrix[2].xyz);
      vec2 b = bendXZ(clamp(position.y, 0.0, 1.0), sy); transformed.x += b.x / sx; transformed.z += b.y / sz; }
    #endif`);
}
// Bark patterns (ARCH.bark, per vertex as aBark): drawn over the shared bark texture in the fragment shader, from the
// bark's own coordinates (u round the stem, turned by the spiral grain; v along it, in half-circumferences). Each style
// is a colour multiplier around the texture's mean, so the tree's instance colour (TINT.bark) still sets the hue.
const BARK_GLSL = `varying float vBark;
float bH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bN(vec2 p, float per) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); float i0 = mod(i.x, per), i1 = mod(i.x + 1.0, per);
  return mix(mix(bH(vec2(i0, i.y)), bH(vec2(i1, i.y)), f.x), mix(bH(vec2(i0, i.y + 1.0)), bH(vec2(i1, i.y + 1.0)), f.x), f.y); }
vec3 barkStyle(float s, vec2 uv, vec3 tex) {
  if (s < 0.5) return tex;
  float g = 0.25, t = dot(tex, vec3(0.333)) / g, u = uv.x, v = uv.y;
  if (s < 1.5) return vec3(g) * (0.92 + 0.12 * bN(vec2(u * 8.0, v * 16.0), 8.0)) * mix(1.0, t, 0.2); // smooth, faintly mottled
  if (s < 2.5) { // plates: flakes falling away, a camouflage of cream, olive and grey
    float n = bN(vec2(u * 5.0, v * 7.7), 5.0) * 0.65 + bN(vec2(u * 11.0, v * 17.0), 11.0) * 0.35;
    vec3 c = mix(vec3(0.62, 0.66, 0.52), vec3(1.0, 0.98, 0.9), smoothstep(0.42, 0.46, n)); c = mix(c, vec3(1.5, 1.42, 1.18), smoothstep(0.6, 0.64, n));
    return vec3(g) * c * (0.94 + 0.1 * bN(vec2(u * 30.0, v * 46.0), 30.0)); }
  if (s < 3.5) { // shaggy: long fibrous strips, weathering grey
    float f = u * 16.0 + 1.2 * bN(vec2(u * 4.0, v * 1.5), 4.0), r = abs(fract(f) - 0.5) * 2.0;
    vec3 c = mix(vec3(0.45, 0.38, 0.34), vec3(1.15, 1.0, 0.92), smoothstep(0.25, 0.7, r)) * (0.8 + 0.35 * bN(vec2(u * 48.0, v * 6.0), 48.0));
    return vec3(g) * mix(c, vec3(1.25, 1.22, 1.18), smoothstep(0.62, 0.75, bN(vec2(u * 3.0, v * 2.0), 3.0)) * 0.6); }
  if (s < 4.5) { // peeling: thin red bark curling off fresh green-cream underbark
    float n = bN(vec2(u * 4.0, v * 5.3), 4.0) * 0.7 + bN(vec2(u * 9.0, v * 12.0), 9.0) * 0.3;
    vec3 c = mix(vec3(1.0), vec3(1.15, 2.1, 1.9), smoothstep(0.57, 0.6, n)) * (1.0 - 0.45 * smoothstep(0.025, 0.0, abs(n - 0.565)));
    return vec3(g) * c * (0.96 + 0.06 * bN(vec2(u * 20.0, v * 40.0), 20.0)); }
  if (s < 5.5) { // cork: thick pale ridges in a net of deep, red-brown fissures
    float n = bN(vec2(u * 7.0, v * 5.6), 7.0) * 0.6 + bN(vec2(u * 15.0, v * 12.0), 15.0) * 0.4;
    return vec3(g) * mix(vec3(0.42, 0.26, 0.2), vec3(1.12, 1.06, 0.98) * (0.85 + 0.3 * bN(vec2(u * 40.0, v * 60.0), 40.0)), smoothstep(0.38, 0.5, n)); }
  if (s < 6.5) { // banded: glossy, with rows of lenticels and peeling rings
    float b = smoothstep(0.8, 0.9, fract(v * 14.0 + 0.4 * bN(vec2(u * 3.0, v * 4.0), 3.0))) * step(0.35, bN(vec2(u * 14.0, v * 14.0), 14.0));
    vec3 c = mix(vec3(0.97 + 0.08 * bN(vec2(u * 10.0, v * 60.0), 10.0)), vec3(0.45, 0.38, 0.36), b);
    return vec3(g) * mix(c, vec3(1.3, 1.15, 1.0), smoothstep(0.88, 0.94, bN(vec2(u * 2.0, v * 3.0), 2.0))); }
  if (s < 7.5) { // papery: white, with dark lenticel dashes and black patches
    float dash = smoothstep(0.86, 0.94, fract(v * 20.0 + 0.3 * bN(vec2(u * 5.0, v * 2.0), 5.0))) * step(0.45, bN(vec2(u * 10.0, v * 20.0), 10.0));
    float pt = smoothstep(0.7, 0.78, bN(vec2(u * 3.0, v * 4.0), 3.0));
    return vec3(g) * mix(vec3(0.97 + 0.06 * bN(vec2(u * 20.0, v * 80.0), 20.0)), vec3(0.22), max(dash * 0.8, pt * 0.85)); }
  if (s < 8.5) { // strip bark: polished silver deadwood, live red-brown bark in a narrow twisting strip
    float strip = smoothstep(0.2, 0.15, abs(fract(u + 0.15 * bN(vec2(u * 2.0, v), 2.0)) - 0.3));
    float grain = 0.88 + 0.16 * sin(u * 140.0 + 4.0 * bN(vec2(u * 6.0, v * 4.0), 6.0));
    return vec3(g) * mix(vec3(grain), vec3(0.5, 0.32, 0.25) * mix(1.0, t, 0.5), strip); }
  if (s < 9.5) { // scaly: orange-red plates between dark fissures
    vec2 q = vec2(u * 7.0, v * 7.0); q.x += 0.5 * floor(q.y); vec2 f = fract(q), i = floor(q);
    float e = min(min(f.x, 1.0 - f.x) * 1.6, min(f.y, 1.0 - f.y)) + 0.06 * bN(vec2(u * 30.0, v * 30.0), 30.0);
    return vec3(g) * mix(vec3(0.32, 0.27, 0.27), vec3(1.12, 1.0, 0.92) * (0.8 + 0.4 * bH(vec2(mod(i.x, 7.0), i.y))), smoothstep(0.05, 0.13, e)); }
  float n = bN(vec2(u * 9.0, v * 6.0), 9.0) * 0.6 + bN(vec2(u * 20.0, v * 13.0), 20.0) * 0.4; // fissured: grey, deep wandering furrows
  return vec3(g) * mix(vec3(0.4), vec3(1.1), smoothstep(0.35, 0.5, n)) * mix(1.0, t, 0.3);
}
`;
function barkStylePatch(sh) {
  sh.vertexShader = 'attribute float aBark;\nvarying float vBark;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vBark = aBark;');
  sh.fragmentShader = BARK_GLSL + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
    #ifdef USE_MAP
    diffuseColor.rgb = barkStyle(vBark, vec2(vMapUv.x, vMapUv.y / 6.0), diffuseColor.rgb);
    #endif`);
}
function bendLocal(f, yu, H, zs = 1) {
  const y = yu * H, env = smoothstep(0, 2, y), sw = 1 - Math.exp(-y / 1.8);
  return [f.bl[0] * yu + f.bl[2] * sw + f.A * env * Math.sin(f.k * y + f.ph), f.bl[1] * yu + f.bl[3] * sw + zs * f.A * env * Math.sin(0.73 * f.k * y + 1.3 * f.ph)];
}
const bendDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
bendDepthMat.onBeforeCompile = bendPatch;

// ---------------------------------------------------------------- crooked wood
// A tube along a random walk, with forks. Built at true proportions (length 1) and scaled uniformly, so kinks survive.
function tubeAlong(pts, r0, r1, sides, out) {
  const base = out.pos.length / 3;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
    const t = norm3([q[0] - o[0], q[1] - o[1], q[2] - o[2]]);
    let u = cross3(t, [0, 0, 1]); if (Math.hypot(...u) < 0.1) u = cross3(t, [1, 0, 0]); u = norm3(u);
    const v = cross3(t, u), r = lerp(r0, r1, i / (pts.length - 1));
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      out.pos.push(p[0] + (u[0] * ca + v[0] * sa) * r, p[1] + (u[1] * ca + v[1] * sa) * r, p[2] + (u[2] * ca + v[2] * sa) * r);
      out.uv.push(s / sides, i / (pts.length - 1) * 4);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let s = 0; s < sides; s++) {
    const a = base + i * sides + s, b = base + i * sides + ((s + 1) % sides), c = a + sides, d = b + sides;
    out.idx.push(a, c, b, b, c, d);
  }
}
function walk(r, start, dir, len, segs, kink, zk = 0.35) {
  const pts = [start.slice()]; let d = norm3(dir), p = start.slice();
  for (let i = 0; i < segs; i++) {
    d = norm3([d[0] + (r() - 0.5) * kink * 2, d[1], d[2] + (r() - 0.5) * kink * 2 * zk]);
    p = [p[0] + d[0] * len / segs, p[1] + d[1] * len / segs, p[2] + d[2] * len / segs]; pts.push(p);
  }
  return pts;
}
function crookedGeo(seed, { r0 = 0.02, kink = 0.35, forks = 1, segs = 6, sides = 5 } = {}) {
  const r = mulberry32(seed), out = { pos: [], uv: [], idx: [] };
  const main = walk(r, [0, 0, 0], [0, 1, 0], 1, segs, kink);
  tubeAlong(main, r0, r0 * 0.3, sides, out);
  for (let f = 0; f < forks; f++) {
    const i = 1 + Math.floor(r() * (segs - 2)), p = main[i], side = r() < 0.5 ? -1 : 1;
    const fork = walk(r, p, [side * (0.5 + 0.5 * r()), 1, (r() - 0.5) * 0.3], 0.25 + 0.3 * r(), 3, kink);
    tubeAlong(fork, r0 * 0.5, r0 * 0.15, 4, out);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2)); g.setIndex(out.idx);
  g.computeVertexNormals();
  return g;
}
// multi-stemmed tall shrub (hazel, alder, hobblebush): crooked stems fanning out, leaf cards in the upper part
function tallShrubStemGeo(seed) {
  const r = mulberry32(seed), out = { pos: [], uv: [], idx: [] };
  const n = 4 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const a = r() * 6.283, sp = 0.15 + 0.35 * r();
    tubeAlong(walk(r, [0, 0, 0], [Math.cos(a) * sp, 1, Math.sin(a) * sp], 0.75 + 0.25 * r(), 4, 0.25, 1), 0.018, 0.006, 4, out);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2)); g.setIndex(out.idx);
  g.computeVertexNormals();
  return g;
}
function tallShrubLeafGeo(seed) {
  const r = mulberry32(seed), cards = [];
  for (let k = 0; k < 16; k++) {
    const a = r() * 6.283, d = Math.sqrt(r()) * 0.75, y = 0.35 + 0.6 * r();
    const c = [Math.cos(a) * d * (0.4 + y), y, Math.sin(a) * d * (0.4 + y)];
    const nC = norm3([c[0], 0.5 + (y - 0.6), c[2]]), [u, v] = randomPlane(r, nC), s = 0.22 + 0.12 * r();
    cards.push({ c, u: u.map((q) => q * s), v: v.map((q) => q * s), n: nC, ao0: 0.5 + 0.3 * y, ao1: 0.7 + 0.35 * y });
  }
  return cardGeometry(cards);
}
function litterGeo() { // one flat card lying in the local XZ plane, facing up
  return cardGeometry([{ c: [0, 0, 0], u: [0.5, 0, 0], v: [0, 0, 0.5], n: [0, 1, 0], ao0: 1, ao1: 1 }]);
}

// ---------------------------------------------------------------- rocks
// Shape follows lithology: granite weathers to rounded core-stones and some jointed blocks; sandstone splits along
// bedding into slabs; basalt fractures into sharp, angular blocks. Stones in stream beds are always water-rounded.
// `round` is the weathering state: 0 = fresh, sharp joint faces (dry or cold climate, hard rock), 2+ = edges eaten back
// (wet climate, granite's spheroidal weathering). Rounding is literal Laplacian smoothing of the joint-cut shape.
function rockShape(seed, kind, detail, round = 0) {
  const g = mergeVerts(new THREE.IcosahedronGeometry(1, detail)), p = g.attributes.position;
  const r = mulberry32(seed), nz = makeNoise2D(r);
  const planes = [];
  const nPl = kind === 'round' ? 0 : kind === 'slab' ? 7 + Math.floor(r() * 3) : 9 + Math.floor(r() * 8);
  for (let k = 0; k < nPl; k++) {
    const n = norm3([r() - 0.5, (r() - 0.5) * (kind === 'slab' ? 0.4 : 1), r() - 0.5]);
    planes.push([n, kind === 'slab' ? 0.55 + 0.3 * r() : 0.38 + 0.4 * r()]);
  }
  if (kind === 'slab') planes.push([[0, 1, 0], 0.3 + 0.2 * r()], [[0, -1, 0], 0.45]);
  const elong = [0.8 + 0.5 * r(), 1, 0.75 + 0.5 * r()];
  for (let i = 0; i < p.count; i++) {
    let v = [p.getX(i) * elong[0], p.getY(i), p.getZ(i) * elong[2]];
    const n3 = (sc, o) => nz(v[0] * sc + v[2] * sc * 0.7 + o, v[1] * sc - v[2] * sc * 0.4 + o * 1.3);
    const bump = kind === 'round' ? 1 + 0.16 * n3(1.1, 0) + 0.05 * n3(3.2, 7) : 1 + 0.06 * n3(2.2, 3);
    v = v.map((c) => c * bump);
    for (const [n, d] of planes) { const t = v[0] * n[0] + v[1] * n[1] + v[2] * n[2] - d; if (t > 0) { v[0] -= n[0] * t; v[1] -= n[1] * t; v[2] -= n[2] * t; } }
    // surface roughness at a finer scale than the joints (fresh rock is rough; weathered rock less so)
    const rough = (kind === 'round' ? 0.025 : 0.04) / (1 + round);
    v = v.map((c, q) => c + rough * n3(7.5, 11 + q * 5));
    const sy = kind === 'round' ? 0.62 : kind === 'slab' ? 1 : 0.8;
    if (kind === 'slab') v[1] += 0.025 * Math.sin(v[1] * 34);
    p.setXYZ(i, v[0], v[1] * sy, v[2]);
  }
  if (round > 0) laplace(g, round, 0.45);
  return kind === 'round' || round > 1 ? (g.computeVertexNormals(), g) : creased(g, round ? 0.5 : 0.62);
}
function laplace(g, iters, k) {
  const p = g.attributes.position, idx = g.index.array, nbr = Array.from({ length: p.count }, () => new Set());
  for (let i = 0; i < idx.length; i += 3) for (let a = 0; a < 3; a++) { nbr[idx[i + a]].add(idx[i + (a + 1) % 3]); nbr[idx[i + a]].add(idx[i + (a + 2) % 3]); }
  for (let it = 0; it < iters; it++) {
    const P = Float32Array.from(p.array);
    for (let v = 0; v < p.count; v++) {
      let sx = 0, sy = 0, sz = 0; for (const n of nbr[v]) { sx += P[n * 3]; sy += P[n * 3 + 1]; sz += P[n * 3 + 2]; }
      const c = nbr[v].size; p.setXYZ(v, lerp(P[v * 3], sx / c, k), lerp(P[v * 3 + 1], sy / c, k), lerp(P[v * 3 + 2], sz / c, k));
    }
  }
}
function creased(g, cosLimit) {
  // Split normals where faces meet at a sharp angle, so joint faces stay flat and edges stay crisp.
  const ng = g.toNonIndexed(), p = ng.attributes.position, n = p.count, fn = new Float32Array(n * 3);
  const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    A.fromBufferAttribute(p, i); Bv.fromBufferAttribute(p, i + 1); C.fromBufferAttribute(p, i + 2);
    const f = C.sub(Bv).cross(A.sub(Bv)); // area-weighted face normal
    for (let q = 0; q < 3; q++) { fn[(i + q) * 3] = f.x; fn[(i + q) * 3 + 1] = f.y; fn[(i + q) * 3 + 2] = f.z; }
  }
  const byPos = new Map();
  for (let i = 0; i < n; i++) { const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`; let a = byPos.get(key); if (!a) byPos.set(key, (a = [])); a.push(i); }
  const out = new Float32Array(n * 3);
  for (const list of byPos.values()) for (const i of list) {
    const fi = [fn[i * 3], fn[i * 3 + 1], fn[i * 3 + 2]], li = Math.hypot(...fi) || 1;
    let sx = 0, sy = 0, sz = 0;
    for (const j of list) {
      const lj = Math.hypot(fn[j * 3], fn[j * 3 + 1], fn[j * 3 + 2]) || 1;
      if ((fi[0] * fn[j * 3] + fi[1] * fn[j * 3 + 1] + fi[2] * fn[j * 3 + 2]) / (li * lj) > cosLimit) { sx += fn[j * 3]; sy += fn[j * 3 + 1]; sz += fn[j * 3 + 2]; }
    }
    const l = Math.hypot(sx, sy, sz) || 1; out[i * 3] = sx / l; out[i * 3 + 1] = sy / l; out[i * 3 + 2] = sz / l;
  }
  ng.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return ng;
}
const rockU = { uBedding: { value: 0 }, uPits: { value: 0 }, uLichen: { value: new THREE.Color(0.62, 0.64, 0.52) } };
const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
rockMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, rockU, { uEcoA: terrainU.uEcoA });
  sh.vertexShader = 'varying vec3 vRW; varying vec3 vRN; varying float vRBase;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    #ifdef USE_INSTANCING
      mat4 rIM = modelMatrix * instanceMatrix;
    #else
      mat4 rIM = modelMatrix;
    #endif
    vRW = (rIM * vec4(transformed, 1.0)).xyz; vRN = normalize(mat3(rIM) * normal); vRBase = rIM[3].y;`);
  sh.fragmentShader = `varying vec3 vRW; varying vec3 vRN; varying float vRBase; uniform float uBedding; uniform float uPits; uniform vec3 uLichen; uniform sampler2D uEcoA;
    ${NOISE_GLSL}
    float tri(vec3 p, vec3 w, float s){ return vr(p.zy * s) * w.x + vr(p.xz * s + 5.0) * w.y + vr(p.xy * s + 9.0) * w.z; }
  ` + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    vec3 an = abs(vRN); vec3 tw = an / (an.x + an.y + an.z + 1e-4);
    float g1 = tri(vRW, tw, 1.3), g2 = tri(vRW, tw, 5.0), g3 = tri(vRW, tw, 19.0), g4 = tri(vRW, tw, 47.0);
    vec3 c = diffuseColor.rgb;
    c *= 0.78 + 0.3 * g1 + 0.18 * (g2 - 0.5);
    c *= 0.86 + 0.28 * smoothstep(0.35, 0.8, g4) * (0.5 + g3);           // mineral grain and flecks
    vec3 wq = vRW * vec3(1.0, 2.6, 1.0) + (g2 - 0.5) * 0.6;           // stretched + warped: joints read as lines, not rings
    float crack = (1.0 - smoothstep(0.0, 0.018, abs(tri(wq, tw, 1.6) - 0.5))) * smoothstep(0.45, 0.6, g1);
    c *= 1.0 - 0.45 * crack;
    c *= 1.0 - uBedding * 0.16 * smoothstep(0.45, 0.55, fract(vRW.y * 2.6 + g1 * 0.4));
    vec4 eA = texture2D(uEcoA, ((vRW.xz + ${HALF.toFixed(1)}) / ${CELL.toFixed(1)} + 0.5) / ${N.toFixed(1)});
    float up = clamp(vRN.y, 0.0, 1.0);
    float lich = smoothstep(0.64, 0.7, tri(vRW + 13.0, tw, 3.1)) * (0.35 + 0.65 * up) * (0.5 + 0.5 * eA.g);
    c = mix(c, pow(uLichen, vec3(2.2)) * (0.85 + 0.3 * g3), lich * 0.85);
    float moss = smoothstep(0.45, 0.85, up + (g1 - 0.5) * 0.7) * smoothstep(0.35, 0.8, eA.r) * (1.0 - 0.7 * eA.g);
    c = mix(c, pow(vec3(0.27, 0.32, 0.14), vec3(2.2)) * (0.8 + 0.4 * g2), moss);
    float hb = vRW.y - vRBase;
    c = mix(pow(vec3(0.22, 0.17, 0.12), vec3(2.2)), c, smoothstep(-0.15, 0.35, hb));  // soil stain and contact shadow
    diffuseColor.rgb = c;
  `).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    { // per-pixel relief (bump mapping from screen-space derivatives): grain, basalt vesicles, sandstone laminae
      float near = 1.0 - smoothstep(10.0, 40.0, length(vViewPosition));
      float hb = g2 * 0.5 + g3 * 0.35 + g4 * 0.15 * near - uPits * 1.4 * smoothstep(0.74, 0.86, tri(vRW + 3.0, tw, 8.0)) + uBedding * 0.35 * sin(vRW.y * 38.0 + g1 * 3.0) + crack * 0.8;
      vec3 vp = -vViewPosition, dpx = dFdx(vp), dpy = dFdy(vp); float dhx = dFdx(hb), dhy = dFdy(hb);
      vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx); float det = dot(dpx, r1);
      normal = normalize(abs(det) * normal - sign(det) * (dhx * r1 + dhy * r2) * 0.035 * (0.4 + 0.6 * near));
    }
  `);
};

const geos = {
  trunk: trunkGeo(), plate: rootPlateGeo(), stumpLo: stumpGeo(false), stumpHi: stumpGeo(true), piece: pieceGeo(false, 7), butt: pieceGeo(true, 7), pieceLo: pieceGeo(false, 5), buttLo: pieceGeo(true, 5),
  trunkLo: (() => { const g = new THREE.LatheGeometry([[0.62, 0], [0.45, 0.12], [0.4, 0.4], [0.35, 0.7], [0.3, 1], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y)), 5); g.computeVertexNormals(); return g; })(),
  broad: broadCrownGeo(11), cone: coneCrownGeo(12),
  broadLo: broadCrownGeo(21, 13, 0.85), coneLo: coneCrownGeo(22, 7, 3),
  shrub: shrubGeo(13), fern: fernGeo(14), grass: grassGeo(),
  twig: crookedGeo(31, { r0: 0.012, kink: 0.45, forks: 2, segs: 6, sides: 4 }),
  stick: crookedGeo(32, { r0: 0.022, kink: 0.35, forks: 1, segs: 6 }),
  limb: crookedGeo(33, { r0: 0.032, kink: 0.25, forks: 2, segs: 7 }),
  tstem: tallShrubStemGeo(34), tleaf: tallShrubLeafGeo(35), herb: shrubGeo(36), litter: litterGeo(),
};
const rockGeos = {}; // per lithology, filled when a world is built
function rockSet(kind, round) {
  const key = `${kind}:${round}`; if (rockGeos[key]) return rockGeos[key];
  return (rockGeos[key] = {
    small: [0, 1, 2].map((i) => rockShape(50 + i, kind, 1, round)),
    big: [0, 1, 2, 3].map((i) => rockShape(60 + i, kind, 3, round)),
    bigLo: [0, 1, 2, 3].map((i) => rockShape(60 + i, kind, 1, round)),
    roundS: rockShape(44, 'round', 1, 1), roundB: rockShape(45, 'round', 2, 1),
  });
}

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
  // Optional per-instance stem form (aBend, aWob) lives on a per-tile clone of the geometry.
  constructor() { this.items = []; }
  add(mat, r, g, b, imp = 1, bend = null, wob = null, ref = null) { this.items.push([mat.elements.slice(), lin(r), lin(g), lin(b), imp, bend, wob, ref]); }
  build(geo, mat, { cast = true, receive = true, farMin = 0, form = false } = {}) {
    const n = this.items.length; if (!n) return null;
    this.items.sort((a, b) => b[4] - a[4]);
    const g = form ? geo.clone() : geo;
    const mesh = new THREE.InstancedMesh(g, mat, n), M = mesh.instanceMatrix.array, C = new Float32Array(n * 3);
    const BE = form ? new Float32Array(n * 4) : null, WO = form ? new Float32Array(n * 4) : null;
    let nFar = 0;
    this.items.forEach((it, i) => {
      M.set(it[0], i * 16); C[i * 3] = it[1]; C[i * 3 + 1] = it[2]; C[i * 3 + 2] = it[3]; if (it[4] >= farMin) nFar = i + 1;
      if (form) { BE.set(it[5] || [0, 0, 0, 0], i * 4); WO.set(it[6] || [0, 1, 0, 1], i * 4); }
    });
    mesh.instanceColor = new THREE.InstancedBufferAttribute(C, 3);
    this.items.forEach((it, i) => { if (it[7]) it[7]._inst = { mesh, i }; }); // (a log that comes alive hides its instance)
    if (form) {
      mesh.userData.form = [new THREE.InstancedBufferAttribute(BE, 4), new THREE.InstancedBufferAttribute(WO, 4)];
      g.setAttribute('aBend', mesh.userData.form[0]); g.setAttribute('aWob', mesh.userData.form[1]);
      mesh.customDepthMaterial = bendDepthMat;
    }
    mesh.castShadow = cast; mesh.receiveShadow = receive;
    mesh.computeBoundingSphere();
    mesh.boundingSphere.radius += 2;
    mesh.userData.nFar = nFar;
    return mesh;
  }
}
function lodTwin(hi, loGeo, cast) { // reduced-geometry mesh sharing the instance buffers of `hi`
  const g = hi.userData.form ? loGeo.clone() : loGeo;
  if (hi.userData.form) { g.setAttribute('aBend', hi.userData.form[0]); g.setAttribute('aWob', hi.userData.form[1]); }
  const lo = new THREE.InstancedMesh(g, hi.material, hi.count);
  lo.instanceMatrix = hi.instanceMatrix; lo.instanceColor = hi.instanceColor; lo.count = hi.userData.nFar;
  lo.castShadow = cast; lo.receiveShadow = true; lo.boundingSphere = hi.boundingSphere;
  if (hi.userData.form) lo.customDepthMaterial = bendDepthMat;
  return lo;
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
  hide(i) { this.mesh.instanceMatrix.array.fill(0, i * 16, i * 16 + 16); this.mesh.instanceMatrix.needsUpdate = true; } // degenerate: draws nothing
  show(i, m) { m.toArray(this.mesh.instanceMatrix.array, i * 16); this.mesh.instanceMatrix.needsUpdate = true; }
}

// ---------------------------------------------------------------- plants near the player: grown skeletons
// Live trees and saplings within PLANT_R of the player are drawn from a library of grown plants (src/plants.js): per
// species, size class and crown shape, two seeded skeletons (plus a forked one), normalised to unit height and instanced.
// Beyond the ring, the tiles' card crowns draw them, and those hide the trees inside it (uNear), so each tree is drawn once.
let PLANT_R = 32; const PCLASS = [1.5, 4, 10, 20, 35, 60], PSHAPE = ['shaded', 'open', 'forked', 'one-sided'];
const uNear = { value: new THREE.Vector3(1e9, 1e9, 0) };
function hidePatch(sh, origin, declare = false) {
  sh.uniforms.uNear = uNear;
  sh.vertexShader = `uniform vec3 uNear;\n${declare ? 'attribute vec4 aBend;\n' : ''}` + sh.vertexShader.replace('#include <clipping_planes_vertex>', `#include <clipping_planes_vertex>
    #ifdef USE_INSTANCING
    if (distance(${origin}, uNear.xy) < uNear.z) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    #endif`);
}
function treeFoliage(map, alphaTest, near) {
  const m = foliageMaterial(map, { alphaTest, footR: near ? 0 : null }), base = m.onBeforeCompile;
  m.onBeforeCompile = (sh) => { base(sh); if (near) bendPatch(sh); else hidePatch(sh, 'aBend.xy', true); };
  m.customProgramCacheKey = () => (near ? 'treeNearFol' : 'treeFarFol');
  return m;
}
function treeDepth(bend, hide) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => { if (bend) bendPatch(sh); if (hide) hidePatch(sh, hide, hide === 'aBend.xy'); };
  m.customProgramCacheKey = () => `treeDepth${bend}${hide}`;
  return m;
}
const treeMats = {
  bark: (() => { const m = new THREE.MeshLambertMaterial({ map: tex.bark }); m.onBeforeCompile = (sh) => { bendPatch(sh); pushPatch(sh, 0); barkStylePatch(sh); }; m.customProgramCacheKey = () => 'treeNearBark'; return m; })(),
  farBark: (() => { const m = new THREE.MeshLambertMaterial({ map: tex.bark }); m.onBeforeCompile = (sh) => { bendPatch(sh); hidePatch(sh, 'instanceMatrix[3].xz'); }; m.customProgramCacheKey = () => 'treeFarBark'; return m; })(),
  leaf: treeFoliage(tex.leaf, 0.42, true), needle: treeFoliage(tex.needle, 0.38, true),
  farLeaf: treeFoliage(tex.leaf, 0.42, false), farNeedle: treeFoliage(tex.needle, 0.38, false),
  nearFolDepth: treeDepth(true, null), farBarkDepth: treeDepth(true, 'instanceMatrix[3].xz'), farFolDepth: treeDepth(false, 'aBend.xy'),
};
const plantLib = new Map(); // key -> { P, hRep, crRep, barkGeo, leafGeo, bark, leaf, cap, n }
let plantCells = new Map(), plantGroup = null;
const plantNear = { cx: 1e9, cz: 1e9 };
function plantClass(d) { let best = 0; for (let i = 1; i < PCLASS.length; i++) if (Math.abs(Math.log(d / PCLASS[i])) < Math.abs(Math.log(d / PCLASS[best]))) best = i; return best; }
// Live crown length as a share of height. Grown in a stand, a tree sheds its shaded lower limbs (the species
// fraction from worldgen); a young one in the open keeps live limbs nearly to the ground, how nearly depending on
// shade tolerance (fir and spruce keep them, maple mostly, birch and pine shed them anyway).
function crownFrac(sp, d, light = 1) {
  const f = crownFraction(sp), young = clamp((25 - d) / 20, 0, 1);
  return f + (0.93 - f) * young * SPECIES[sp].keepLow * clamp(light, 0, 1);
}
// ---- seasons: leaf colour, and the flowers and fruit each species shows in its months (ARCH.show)
const SEASON_MONTH = { spring: 5, summer: 7, autumn: 10 };
const AUTUMN = { 2: [0.95, 0.28, 0.12], 3: [0.98, 0.82, 0.28], 5: [0.70, 0.40, 0.18], 6: [1.0, 0.76, 0.16], 7: [0.86, 0.82, 0.36], 9: [0.92, 0.34, 0.16], 10: [0.95, 0.30, 0.12], 11: [0.78, 0.58, 0.28], 16: [0.95, 0.74, 0.24] }; // deciduous species: maple red, birch yellow, oak russet, aspen gold, willow, cherry, rowan, plane, larch gold
const month = () => SEASON_MONTH[W?.opt?.season] || 7;
let texAvg = null; // mean linear colour of the leaf and needle textures (opaque texels): the colour a tint multiplies
function textureMeans() {
  if (texAvg) return texAvg; texAvg = {};
  for (const [k, t] of [['leaf', tex.leaf], ['needle', tex.needle]]) {
    const c = t.image, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, a = [0, 0, 0]; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { a[0] += lin(d[i] / 255); a[1] += lin(d[i + 1] / 255); a[2] += lin(d[i + 2] / 255); n++; }
    texAvg[k] = a.map((v) => v / Math.max(1, n));
  }
  return texAvg;
}
// a species' leaf tint (sRGB-ish, as TINT.leaf) in this world's season: autumn colours are set so texture x tint averages
// to the named colour; spring leaves are fresher and yellower
function leafTint(sp) {
  const base = TINT.leaf[sp], m = month();
  if (m >= 9 && AUTUMN[sp]) { const avg = textureMeans()[isConifer(sp) ? 'needle' : 'leaf'], A = AUTUMN[sp]; return [0, 1, 2].map((k) => Math.pow(lin(A[k]) / avg[k], 1 / 2.2)); }
  if (m <= 5 && AUTUMN[sp]) return [base[0] * 1.06, base[1] * 1.1, base[2] * 0.9];
  return base;
}
// flower and fruit cards: a vertex colour that, times the texture and the tree's leaf tint, averages to their own colour
function showMul(sp, tint) { const avg = textureMeans()[isConifer(sp) ? 'needle' : 'leaf'], lt = leafTint(sp); return [0, 1, 2].map((k) => lin(tint[k]) / (avg[k] * lin(lt[k]))); }
function plantVariant(sp, ci, shape, si) {
  const key = `${sp}:${ci}:${shape}:${si}:${month()}`; let v = plantLib.get(key); if (v) return v;
  const dRep = Math.min(PCLASS[ci], SPECIES[sp].dmax * 0.75), hRep = treeHeight(sp, dRep), crRep = crownRadius(sp, dRep);
  const cf = crownFrac(sp, dRep, shape === 0 ? 0.3 : 1) * (shape === 0 ? 0.8 : 1) * (dRep < 6 ? 1.15 : 1), crownLen = Math.min(hRep * 0.95, hRep * cf);
  const seed = 1009 + sp * 7919 + ci * 613 + shape * 97 + si * 31;
  const P = PL.growPlant({ sp, d: dRep, h: hRep, crownLen, cr: crRep, seed, forked: shape === 2, side: shape === 3 ? 0.75 : 0 });
  const B = PL.barkMesh(P, { minR: Math.max(0.005, 0.012 * Math.min(1, dRep / 20)) }), barkGeo = new THREE.BufferGeometry();
  barkGeo.setAttribute('position', new THREE.Float32BufferAttribute(B.pos.map((q) => q / hRep), 3));
  barkGeo.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3)); barkGeo.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2)); barkGeo.setIndex(B.idx);
  barkGeo.setAttribute('aNode', new THREE.Float32BufferAttribute(B.node, 1)); // which segment each vertex belongs to: breaks leave out subtrees
  barkGeo.setAttribute('aBark', new THREE.Float32BufferAttribute(new Float32Array(B.node.length).fill(PL.ARCH[sp].bark || 0), 1)); // the bark pattern
  const sc = (a) => a.map((q) => q / hRep);
  const cards = PL.foliageCards(P, seed + 1, { month: month() }), leafGeo = cardGeometry(cards.map((k) => ({ ...k, c: sc(k.c), u: sc(k.u), v: sc(k.v), mul: k.tint ? showMul(sp, k.tint) : null })));
  leafGeo.setAttribute('aNode', new THREE.Float32BufferAttribute(cards.flatMap((k) => [k.node, k.node, k.node, k.node]), 1));
  v = { key, sp, P, hRep, crRep, barkGeo, leafGeo, bark: null, leaf: null, cap: 0, n: 0, cast: ci >= 2 }; // saplings cast no shadow: small, and each caster is a draw call in the shadow pass
  plantLib.set(key, v); return v;
}
function plantMeshes(v, need) { // (re)allocate a variant's instanced meshes to hold `need` trees
  if (v.cap >= need) return;
  if (v.bark) { plantGroup.remove(v.bark, v.leaf); v.bark.dispose(); v.leaf.dispose(); }
  const cap = Math.max(16, 1 << Math.ceil(Math.log2(need)));
  const bend = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4), wob = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  for (const g of [v.barkGeo, v.leafGeo]) { g.setAttribute('aBend', bend); g.setAttribute('aWob', wob); }
  const conifer = isConifer(v.sp);
  v.bark = new THREE.InstancedMesh(v.barkGeo, treeMats.bark, cap); v.leaf = new THREE.InstancedMesh(v.leafGeo, conifer ? treeMats.needle : treeMats.leaf, cap);
  v.leaf.instanceMatrix = v.bark.instanceMatrix;
  v.bark.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); v.leaf.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  v.bark.customDepthMaterial = bendDepthMat; v.leaf.customDepthMaterial = treeMats.nearFolDepth;
  for (const m of [v.bark, v.leaf]) { m.frustumCulled = false; m.castShadow = v.cast; m.receiveShadow = true; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
  v.cap = cap; v.bendA = bend; v.wobA = wob; plantGroup.add(v.bark, v.leaf);
}
function refreshPlants(px, pz, force) {
  if (!force && Math.hypot(px - plantNear.cx, pz - plantNear.cz) < 5) return;
  plantNear.cx = px; plantNear.cz = pz;
  if (PLANT_R <= 0) { for (const v of plantLib.values()) if (v.bark) v.bark.visible = v.leaf.visible = false; uNear.value.set(px, pz, 0); refreshRoots(px, pz); return; }
  const pick = [], R2 = PLANT_R * PLANT_R, c0 = Math.floor((px - PLANT_R + HALF) / 16), c1 = Math.floor((px + PLANT_R + HALF) / 16), d0 = Math.floor((pz - PLANT_R + HALF) / 16), d1 = Math.floor((pz + PLANT_R + HALF) / 16);
  for (let ci = c0; ci <= c1; ci++) for (let cj = d0; cj <= d1; cj++) for (const r of plantCells.get(ci * 4096 + cj) || []) if ((r.x - px) ** 2 + (r.z - pz) ** 2 < R2 && !r.custom) pick.push(r);
  for (const r of brokenTrees) { const on = (r.x - px) ** 2 + (r.z - pz) ** 2 < R2; r.custom.bark.visible = r.custom.leaf.visible = on; }
  for (const v of plantLib.values()) v.n = 0;
  for (const r of pick) r.v.n++;
  for (const v of plantLib.values()) { if (v.n) plantMeshes(v, v.n); v.fill = 0; }
  for (const r of pick) {
    const v = r.v, i = v.fill++;
    v.bark.instanceMatrix.array.set(r.m, i * 16); v.bark.instanceColor.array.set(r.bc, i * 3); v.leaf.instanceColor.array.set(r.lc, i * 3);
    v.bendA.array.set(r.bend, i * 4); v.wobA.array.set(r.wob, i * 4);
  }
  for (const v of plantLib.values()) if (v.bark) {
    v.bark.count = v.leaf.count = v.n; v.bark.visible = v.leaf.visible = v.n > 0;
    if (v.n) { v.bark.instanceMatrix.needsUpdate = true; v.bark.instanceColor.needsUpdate = true; v.leaf.instanceColor.needsUpdate = true; v.bendA.needsUpdate = true; v.wobA.needsUpdate = true; }
  }
  uNear.value.set(px, pz, PLANT_R);
  refreshRoots(px, pz);
}

// ---- roots: grown per tree from its own site (soil, slope, wetness, rock), so they follow the ground it stands on.
// Generated the first time a tree comes within ROOT_R of the player and kept on its record; exposed roots become
// low solids your feet step on. All roots near the player are merged into one mesh.
const ROOT_R = 24;
let rootCells = new Map(), rootMeshObj = null;
const ROOT_TINT = [[0.56, 0.50, 0.44], [0.60, 0.50, 0.42], [0.58, 0.54, 0.48], [0.58, 0.50, 0.44], [0.55, 0.49, 0.43], [0.54, 0.48, 0.42], [0.60, 0.56, 0.50], [0.52, 0.47, 0.42], [0.62, 0.52, 0.44], [0.56, 0.46, 0.40], [0.58, 0.54, 0.48], [0.62, 0.58, 0.50], [0.56, 0.54, 0.50], [0.58, 0.50, 0.42], [0.62, 0.54, 0.46], [0.62, 0.46, 0.38], [0.58, 0.50, 0.44], [0.72, 0.66, 0.58]]; // weathered grey-brown, lighter than the soil
function outcropTop(x, z) { let y = -Infinity; for (const o of solids.get(ckey8(x, z)) || []) if (o.kind === 'mesh' && o.big !== undefined) y = Math.max(y, topOf(o, x, z)); return y; }
function rootSite(t) {
  const g = (x, z) => ground(x, z), gx = (g(t.x + 1.5, t.z) - g(t.x - 1.5, t.z)) / 3, gz = (g(t.x, t.z + 1.5) - g(t.x, t.z - 1.5)) / 3;
  return { soil: t.soil ?? 0.6, slope: [gx, gz], wet: sampleGrid(W.wet, N, t.x, t.z), rocky: sampleGrid(W.rock, N, t.x, t.z) };
}
// A root system as the same kind of object as a crown: a graph of segments with wood properties. Built for a standing
// tree (draped over the ground: buried segments are held by the soil, exposed ones are rods, and an exposed run that
// dives back in is pinned where it enters) or for a fallen tree's wad (turned up with the plate: every root it kept
// hangs from the plate and is a rod). r.m: the mesh arrays plus P (the graph), ws (world segments), fixed and pin.
function treeRoots(r) {
  const t = r.t, wd = r.wad, R = PL.growRoots({ sp: t.sp, d: t.d, seed: hash3(Math.round(t.x * 10), Math.round(t.z * 10), 57), ...rootSite(t) });
  let place, keep = null;
  if (wd) {
    const k = [wd.dz, 0, -wd.dx], rot = (x, y, z) => { const kv = [k[1] * z - k[2] * y, k[2] * x - k[0] * z, k[0] * y - k[1] * x], kd = k[0] * x + k[1] * y + k[2] * z; return [kv[0] + k[0] * kd, kv[1] + k[1] * kd, kv[2] + k[2] * kd]; };
    place = (x, y, z) => { const q = rot(x, y - 0.1, z); return [wd.cx + q[0], wd.cy + q[1], wd.cz + q[2], -Infinity]; };
    keep = (i) => Math.hypot(R.p0[i * 3], R.p0[i * 3 + 2]) < wd.pr * (0.9 + 0.3 * wd.pf) && (R.ord[i] !== -2 || wd.pf > 0.5);
  } else place = (x, y, z, rr) => {
    const wx = t.x + x, wz = t.z + z, g = ground(wx, wz), rk = outcropTop(wx, wz);
    return rk > g + 0.02 ? [wx, Math.max(g + y, rk + rr * 0.45), wz, rk] : [wx, g + y, wz, g]; // over rock, roots run on the rock
  };
  const M = PL.rootMesh(R, place, wd ? { keep, all: true, flat: 0.85 } : {});
  if (!wd) for (const q of M.solids) addSolid({ kind: 'log', root: true, x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2, x0: q.x0, z0: q.z0, x1: q.x1, z1: q.z1, ya0: q.y0, ya1: q.y1, r: q.r }, Math.hypot(q.x1 - q.x0, q.z1 - q.z0) / 2 + q.r);
  const tint = ROOT_TINT[t.sp]; for (let i = 0; i < M.col.length; i++) M.col[i] *= tint[i % 3] * (wd ? 1.2 : 1.6);
  const n = R.n, ws = new Float32Array(n * 7), fixed = new Uint8Array(n), pin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = place(R.p0[i * 3], R.p0[i * 3 + 1], R.p0[i * 3 + 2], R.r0[i]), b = place(R.p1[i * 3], R.p1[i * 3 + 1], R.p1[i * 3 + 2], R.r1[i]);
    ws.set([a[0], a[1], a[2], b[0], b[1], b[2], R.r0[i]], i * 7);
    if (wd) { fixed[i] = keep(i) ? 0 : 1; continue; }
    const outA = a[1] + R.r0[i] > a[3] + 0.005, outB = b[1] + R.r1[i] > b[3] + 0.005;
    fixed[i] = outA || outB ? 0 : 1; pin[i] = !fixed[i] && !outB ? 1 : 0; // its end is in the soil: held there
  }
  Object.assign(M, { P: R, ws, fixed, pin, wad: !!wd });
  return M;
}
function arraysGeo(A) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(A.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(A.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(A.col, 3)); g.setIndex(A.idx);
  return g;
}
// Wads baked into the terrain tiles are drawn only beyond the root ring; inside it each is its root graph (above).
const uRootNear = { value: new THREE.Vector3(1e9, 1e9, 0) };
const wadFarMat = new THREE.MeshLambertMaterial({ map: tex.bark, vertexColors: true });
wadFarMat.onBeforeCompile = (sh) => { sh.uniforms.uRootNear = uRootNear; sh.vertexShader = 'uniform vec3 uRootNear; attribute vec2 aBase;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n if (length(aBase - uRootNear.xy) < uRootNear.z) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);'); };
wadFarMat.customProgramCacheKey = () => 'wadFar';
// Root graphs are grown a few at a time (nearest first, within a time budget per frame) so walking into new ground
// never stalls a frame; the merged mesh lives in one reusable buffer that only grows.
let rootPick = [], rootQueue = [], rootDirty = false, rootBuf = null;
function refreshRoots(px, pz) {
  const R2 = ROOT_R * ROOT_R; rootPick = []; uRootNear.value.set(px, pz, ROOT_R);
  for (let ci = Math.floor((px - ROOT_R + HALF) / 16); ci <= Math.floor((px + ROOT_R + HALF) / 16); ci++)
    for (let cj = Math.floor((pz - ROOT_R + HALF) / 16); cj <= Math.floor((pz + ROOT_R + HALF) / 16); cj++)
      for (const r of rootCells.get(ci * 4096 + cj) || []) { const d2 = (r.x - px) ** 2 + (r.z - pz) ** 2; if (d2 <= R2) { rootPick.push(r); r.d2 = d2; } }
  rootQueue = rootPick.filter((r) => !r.m).sort((a, b) => a.d2 - b.d2);
  rootDirty = true;
  const L2 = (ROOT_R + 8) ** 2; logPick = [];
  for (let ci = Math.floor((px - ROOT_R - 8 + HALF) / 16); ci <= Math.floor((px + ROOT_R + 8 + HALF) / 16); ci++)
    for (let cj = Math.floor((pz - ROOT_R - 8 + HALF) / 16); cj <= Math.floor((pz + ROOT_R + 8 + HALF) / 16); cj++)
      for (const r of branchLogCells.get(ci * 4096 + cj) || []) { const d2 = (r.x - px) ** 2 + (r.z - pz) ** 2; if (d2 <= L2) { logPick.push(r); r.d2 = d2; } }
  logQueue = logPick.filter((r) => !r.m).sort((a, b) => a.d2 - b.d2); logDirty = true;
}
function rootWork(budget) {
  const t0 = performance.now();
  while (rootQueue.length && performance.now() - t0 < budget) { const r = rootQueue.shift(); if (!r.m) { r.m = treeRoots(r); if (r.t._prec && !r.wad) limbSolids(r.t._prec); rootDirty = true; } }
  while (logQueue.length && performance.now() - t0 < budget) { const r = logQueue.shift(); if (!r.m) { r.m = logBranches(r.t, r.gone); for (const o of r.m.solids) { o.lrec = r; addSolid(o, o.reach); } logDirty = true; } }
  if (logDirty && (!logQueue.length || budget === Infinity)) {
    logDirty = false; logAssemble();
  }
  if (rootDirty && (!rootQueue.length || budget === Infinity)) { rootDirty = false; assembleRoots(); }
}
function assembleRoots() {
  let nv = 0, ni = 0; for (const r of rootPick) if (r.m && !r.ph) { nv += r.m.pos.length / 3; ni += r.m.idx.length; }
  if (!rootBuf || rootBuf.capV < nv || rootBuf.capI < ni) {
    const capV = Math.max(4096, 1 << Math.ceil(Math.log2(nv + 1))), capI = Math.max(8192, 1 << Math.ceil(Math.log2(ni + 1)));
    if (rootBuf) { plantGroup.remove(rootBuf.mesh); rootBuf.mesh.geometry.dispose(); }
    const g = new THREE.BufferGeometry(), A = (n, k) => new THREE.BufferAttribute(new Float32Array(n * k), k).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', A(capV, 3)); g.setAttribute('normal', A(capV, 3)); g.setAttribute('uv', A(capV, 2)); g.setAttribute('color', A(capV, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(capI), 1).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.Mesh(g, mats.root); mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = false;
    rootBuf = { capV, capI, mesh }; rootMeshObj = mesh; plantGroup.add(mesh);
  }
  const g = rootBuf.mesh.geometry, P = g.attributes.position.array, Nn = g.attributes.normal.array, U = g.attributes.uv.array, C = g.attributes.color.array, I = g.index.array;
  let v = 0, k = 0;
  for (const r of rootPick) {
    const M = r.m; if (!M || r.ph) continue; // a root system being simulated draws its own deforming mesh
    P.set(M.pos, v * 3); Nn.set(M.nor, v * 3); U.set(M.uv, v * 2); C.set(M.col, v * 3);
    for (let q = 0; q < M.idx.length; q++) I[k + q] = M.idx[q] + v;
    v += M.pos.length / 3; k += M.idx.length;
  }
  for (const at of [g.attributes.position, g.attributes.normal, g.attributes.uv, g.attributes.color]) { at.clearUpdateRanges(); at.addUpdateRange(0, v * at.itemSize); at.needsUpdate = true; }
  g.index.clearUpdateRanges(); g.index.addUpdateRange(0, k); g.index.needsUpdate = true;
  g.setDrawRange(0, k); rootBuf.mesh.visible = perfOpt.roots && k > 0;
}
// ---------------------------------------------------------------- branches in the world (docs/plants.md, step 3)
// A live tree near the player is its library variant's graph seen through the tree's own placement: the instance
// transform (position, turn, scale) and the stem bend the shader applies (bendLocal is its CPU twin). What happens to a
// tree is kept per tree as a delta, the set of segments broken off; a tree with a delta is drawn by its own mesh, the
// variant's buffers with those subtrees' triangles left out.
const LIVE_LIMB_R = 0.025, DEAD_LIMB_R = 0.035, LIMB_LOW = 2.4; // limbs this thick and this low are solid to the body
const BRANCH_R_MIN = 0.01, BRANCH_LOW = 1.0; // and any branch at least this thick within this height of the ground: planned on as if it held your weight (it may not)
let brokenTrees = [], branchLogCells = new Map(), logPick = [], logQueue = [], logDirty = false;
const _tv = new THREE.Vector3();
function treeXf(rec) {
  if (rec.xf) return rec.xf;
  const v = rec.v, M = new THREE.Matrix4().fromArray(rec.m), sx = new THREE.Vector3().setFromMatrixColumn(M, 0).length(), sy = new THREE.Vector3().setFromMatrixColumn(M, 1).length();
  const f = { bl: rec.bend, A: rec.wob[0], k: rec.wob[1], ph: rec.wob[2] }, zs = rec.wob[3];
  const toW = (x, y, z) => { // plant metres -> world
    const qx = x / v.hRep, qy = y / v.hRep, qz = z / v.hRep, b = bendLocal(f, clamp(qy, 0, 1), sy, zs);
    _tv.set(qx + b[0] / sx, qy, qz + b[1] / sx).applyMatrix4(M); return [_tv.x, _tv.y, _tv.z];
  };
  return (rec.xf = { toW, s: sx / v.hRep });
}
function treeSegs(rec) { // world segments of the tree's graph, cached: [x0,y0,z0,x1,y1,z1,r] per node
  if (rec.ws) return rec.ws;
  const P = rec.v.P, X = treeXf(rec), ws = new Float32Array(P.n * 7);
  for (let i = 0; i < P.n; i++) {
    ws.set(X.toW(P.p0[i * 3], P.p0[i * 3 + 1], P.p0[i * 3 + 2]), i * 7); ws.set(X.toW(P.p1[i * 3], P.p1[i * 3 + 1], P.p1[i * 3 + 2]), i * 7 + 3); ws[i * 7 + 6] = P.r0[i] * X.s;
  }
  return (rec.ws = ws);
}
function removeSolid(o) { for (const a of solids.values()) { const k = a.indexOf(o); if (k >= 0) a.splice(k, 1); } }
// thick low limbs become solids, tapered like logs, so the body ducks under, steps over or stands on them
function limbSolids(rec) {
  if (rec.solids) return;
  const P = rec.v.P, X = treeXf(rec), ws = treeSegs(rec); rec.solids = [];
  for (let i = 0; i < P.n; i++) {
    if (P.ord[i] < 1 || P.st[i] === PL.STUB || rec.gone?.[i]) continue;
    const r0 = P.r0[i] * X.s, r1 = Math.max(0.01, P.r1[i] * X.s), k = i * 7, mx = (ws[k] + ws[k + 3]) / 2, mz = (ws[k + 2] + ws[k + 5]) / 2, lo = Math.min(ws[k + 1], ws[k + 4]) - ground(mx, mz);
    if (r0 < (lo <= BRANCH_LOW ? BRANCH_R_MIN : P.st[i] === PL.LIVE ? LIVE_LIMB_R : DEAD_LIMB_R) || lo > LIMB_LOW) continue;
    const o = { kind: 'log', limb: true, rec, node: i, x: mx, z: mz, x0: ws[k], z0: ws[k + 2], x1: ws[k + 3], z1: ws[k + 5], ya0: ws[k + 1], ya1: ws[k + 4], r: Math.max(r0, r1), r0, r1, rz0: r0, rz1: r1 };
    addSolid(o, Math.hypot(ws[k + 3] - ws[k], ws[k + 5] - ws[k + 2]) / 2 + o.r); rec.solids.push(o);
  }
}
// Push: what your hands can reach in the direction you look, whatever it is: a branch, root or shrub stem (a rod), a
// free object (a piece, loose wood, a log that came alive), or something fixed (a standing stem, a fallen log). Held,
// it presses there with up to PUSH_N along your view, and the same force acts back on your hands: the arms give, the
// body leans back, and against something fixed you take all of it. Forgiving aim (a touch screen aims coarsely).
let breakTargetAt = null; // (the push target; the name is kept for the debug handle)
const REACH = 1.5, PUSH_N = 300;
const pushState = { on: false, t: 0, tgt: null, p: null, F: [0, 0, 0], free: null, rod: null };
function breakTarget() {
  if (pushState.on) return;
  breakTargetAt = null;
  if (!running || !W || body.four) { $('bBreak').hidden = true; return; }
  const e = camera.position, d = camera.getWorldDirection(_tv).clone();
  let best = null;
  const consider = (kind, rec, ws, i, minR, extra) => {
    const r = ws[i * 7 + 6]; if (!(r >= minR)) return;
    const h = closestRaySeg(e, d, ws, i * 7, REACH), miss = h.dist - r;
    if (miss > 0.25 + 0.12 * h.t) return;
    const score = miss + 0.1 * h.t; if (!best || score < best.score) best = { kind, rec, node: i, u: h.u, t: h.t, r, score, ws, ...extra };
  };
  const ci = Math.floor((player.x + HALF) / 16), cj = Math.floor((player.z + HALF) / 16);
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((ci + di) * 4096 + cj + dj) || []) {
    if ((rec.x - player.x) ** 2 + (rec.z - player.z) ** 2 > 64) continue;
    const P = rec.v.P, ws = treeSegs(rec), sap = rec.t && rec.t.d < 8;
    for (let i = 0; i < P.n; i++) if (!rec.gone?.[i]) consider(P.ord[i] >= 1 || sap ? 'tree' : 'fixed', rec, ws, i, 0.004);
  }
  for (const r of logPick) { const M = r.m; if (!M || player.x < M.box[0] - 3 || player.x > M.box[1] + 3 || player.z < M.box[2] - 3 || player.z > M.box[3] + 3) continue; const P = M.v.P; for (let i = 0; i < P.n; i++) if (M.segs[i * 7 + 6] > 0 && !r.gone?.[i]) consider(P.ord[i] >= 1 ? 'log' : 'fixed', r, M.segs, i, 0.004); }
  for (const r of rootPick) { const M = r.m; if (!M || (r.x - player.x) ** 2 + (r.z - player.z) ** 2 > 100) continue; for (let i = 0; i < M.P.n; i++) if (!M.fixed[i]) consider('root', r, M.ws, i, 0.003); }
  for (const it of plantItemsNear(player.x, player.z, 2)) { const T = plantProxy(it); for (let i = 0; i < T.P.n; i++) if (!it.gone?.[i]) consider('plant', it, T.ws, i, 0.002); }
  for (const o of falls.values()) { if ((o.x - player.x) ** 2 + (o.z - player.z) ** 2 > 100) continue; const C = freeCaps(o); for (let c = 0; c < C.length / 7; c++) consider('free', o, C, c, 0.004, { b: o.f.cb[c] }); }
  { const S = staticCaps(player.x, player.z), ws = new Float32Array(S.length * 7); S.forEach((q, k) => ws.set([...q.a, ...q.b, q.r], k * 7)); for (let k = 0; k < S.length; k++) consider('fixed', null, ws, k, 0); }
  breakTargetAt = best; $('bBreak').hidden = !best;
  if (best) { const t = best.kind === 'fixed' ? 'Push (it will not move)' : `Push · ${Math.max(1, Math.round(best.r * 200))} cm`; if ($('bBreak').textContent !== t) $('bBreak').textContent = t; }
}
function pushStart() { if (!breakTargetAt) { flash('Nothing within reach'); return; } Object.assign(pushState, { on: true, t: 0, tgt: breakTargetAt }); }
function pushStop() { pushState.on = false; pushState.free = pushState.rod = null; pushState.tgt = null; pushState.F = [0, 0, 0]; }
// each frame while pushing: where the hands are on it now, and the force (both ways)
function pushUpdate(dt) {
  if (!pushState.on) return;
  const g = pushState.tgt; pushState.t += dt;
  let p = null, ws = g.ws, k = g.node * 7;
  if (g.kind === 'free') { const o = falls.get(g.rec.id); if (!o) return pushStop(); ws = freeCaps(o); }
  p = [0, 1, 2].map((d) => ws[k + d] + (ws[k + 3 + d] - ws[k + d]) * g.u);
  if (g.rec?.ph && g.kind !== 'free' && g.kind !== 'fixed') { const D = g.rec.ph.data, i = g.node; for (let d = 0; d < 3; d++) p[d] += D[i * 4 + d] * g.u; } // where the simulated rod is
  const dir = camera.getWorldDirection(_tv), mag = Math.min(PUSH_N, PUSH_N * pushState.t / 0.3);
  const sh = body.sol?.J ? [0, 1, 2].map((d) => (body.sol.J.shoulderL[d] + body.sol.J.shoulderR[d]) / 2) : [player.x, player.eye - 0.25, player.z];
  if (Math.hypot(p[0] - sh[0], p[1] - sh[1], p[2] - sh[2]) > 1.0) { flash('Lost your hold'); return pushStop(); }
  pushState.p = p; pushState.F = [dir.x * mag, dir.y * mag, dir.z * mag];
  pushState.free = g.kind === 'free' ? { id: g.rec.id, b: g.b } : null;
  pushState.rod = g.kind === 'tree' || g.kind === 'log' || g.kind === 'root' || g.kind === 'plant' ? { owner: g.rec, node: g.node, kind: g.kind } : null;
}
function closestRaySeg(e, d, ws, k, maxT) { // closest approach of the ray e + t d (0..maxT) and a segment
  const ax = ws[k], ay = ws[k + 1], az = ws[k + 2], ux = ws[k + 3] - ax, uy = ws[k + 4] - ay, uz = ws[k + 5] - az;
  const wx = e.x - ax, wy = e.y - ay, wz = e.z - az, a = d.x * d.x + d.y * d.y + d.z * d.z, b = d.x * ux + d.y * uy + d.z * uz, c = ux * ux + uy * uy + uz * uz;
  const dd = d.x * wx + d.y * wy + d.z * wz, ee = ux * wx + uy * wy + uz * wz, den = a * c - b * b;
  let t = den > 1e-9 ? (b * ee - c * dd) / den : 0, u = c > 1e-9 ? (ee + b * t) / c : 0;
  u = clamp(u, 0, 1); t = clamp((b * u - dd) / a, 0, maxT);
  const px = e.x + d.x * t - ax - ux * u, py = e.y + d.y * t - ay - uy * u, pz = e.z + d.z * t - az - uz * u;
  return { t, u, dist: Math.hypot(px, py, pz) };
}
const BODY_N = 785; // your weight, newtons
const bBreak = $('bBreak');
bBreak.addEventListener('pointerdown', (e) => { e.preventDefault(); pushStart(); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bBreak.addEventListener(ev, () => pushStop());
function flash(msg) { $('hint').textContent = msg; $('hint').style.opacity = 1; clearTimeout(hintTimer); hintTimer = setTimeout(hideHint, 2500); }
// standing on a branch loads it with your weight (plus a little for stepping): the first time you stand on it, it is
// checked as one is underfoot (branchLoad). One that snaps or bends away is no longer under you, and you drop.
const tested = new WeakSet();
function standLoad() {
  for (let k = 0; k < 7; k++) {
    const a = (k / 6) * 6.283, x = player.x + (k ? Math.cos(a) * FOOT : 0), z = player.z + (k ? Math.sin(a) * FOOT : 0);
    for (const o of solids.get(ckey8(x, z)) || []) {
      if (!(o.limb || o.branch) || tested.has(o) || Math.abs(topOf(o, x, z) - rig.feet) > 0.05) continue;
      tested.add(o); const b = branchOf(o); if (!b) continue;
      const w = b.ws, q = b.i * 7, vx = w[q + 3] - w[q], vz = w[q + 5] - w[q + 2], u = clamp(((x - w[q]) * vx + (z - w[q + 2]) * vz) / (vx * vx + vz * vz || 1), 0, 1), r = branchLoad(b, u);
      if (r.fate === 'hold') continue;
      if (r.fate === 'break') { if (b.kind === 'tree') breakBranch(b.rec, r.node); else logBreak(b.rec, r.node, w[r.node * 7 + 6] > 0.015); crunchList = null; body.crunch = (body.crunch || 0) + 1; }
      else removeSolid(o); // bent away: no longer something to stand on (its rod still pushes back)
      body.gaveWay = (body.gaveWay || 0) + 1; body.lastGaveWay = r.fate === 'break' ? 'The branch broke under you' : 'The branch bent away under you'; flash(body.lastGaveWay);
      return;
    }
  }
}
// a fallen tree's branch breaks: its graph loses the subtree, the merged mesh is rebuilt, and (unless it was a twig
// crushed underfoot) the piece drops to the ground
const xfSnap = (o) => o.ph?.xf ? { a2: o.ph.xf.a2.slice(), q: o.ph.xf.q.slice() } : null; // where its segments are drawn now
function logBreak(r, node, drop) {
  const xf = xfSnap(r), M = r.m, P = M.v.P, g = PL.subtree(P, node);
  if (!r.gone) r.gone = new Uint8Array(P.n);
  const fresh = Array.from(g, (x, i) => x && !r.gone[i] && M.segs[i * 7 + 6] > 0);
  for (let i = 0; i < P.n; i++) if (g[i]) r.gone[i] = 1;
  for (const o of M.solids) removeSolid(o);
  if (drop) fallOrDrop({ trunkR: 0, src: logSources(M), toW: (x, y, z) => M.W3(x, y, z), nrm: (x, y, z) => [x * M.X.x + y * M.a.x + z * M.Z.x, x * M.X.y + y * M.a.y + z * M.Z.y, x * M.X.z + y * M.a.z + z * M.Z.z], ws: M.segs, xf, P, s: M.s, gone: fresh, node, tint: mix3(TINT.bark[r.t.sp], [0.55, 0.50, 0.44], 0.6).map(lin), conifer: isConifer(r.t.sp), leaves: M.T < 3 });
  r.m = logBranches(r.t, r.gone); for (const o of r.m.solids) { o.lrec = r; addSolid(o, o.reach); }
  if (r.ph) { physRegroup(r, r.m.segs, (i) => r.m.segs[i * 7 + 6] > 0 && !r.gone[i]); logMesh(r); } // the rest keep moving where they are
  logDirty = true; rootWork(0);
}
// A root or a small plant's stem snaps: as for a branch, what it carried comes away and falls as a piece, the rest
// keeps moving, and the plant is drawn without it from now on.
function breakOff(o, kind, node) {
  const xf = xfSnap(o), P = kind === 'root' ? o.m.P : plantProxy(o).P, ws = kind === 'root' ? o.m.ws : plantProxy(o).ws, g = PL.subtree(P, node);
  if (!o.gone) o.gone = new Uint8Array(P.n);
  const fresh = Array.from(g, (x, i) => !!x && !o.gone[i]); for (let i = 0; i < P.n; i++) if (g[i]) o.gone[i] = 1;
  if (kind === 'root') {
    const M = o.m, src = { bark: { pos: M.pos, nor: M.nor, uv: M.uv, idx: M.idx, node: M.node, ps: 1 } };
    fallOrDrop({ trunkR: 0, src, toW: (x, y, z) => [x, y, z], nrm: (x, y, z) => [x, y, z], ws, xf, P, s: 1, gone: fresh, node, tint: ROOT_TINT[o.t.sp], conifer: false, leaves: false });
    const keep = []; for (let t = 0; t < M.idx.length; t += 3) { const a = M.node[M.idx[t]], b = M.node[M.idx[t + 1]], c = M.node[M.idx[t + 2]]; if (!o.gone[a] && !o.gone[b] && !o.gone[c]) keep.push(M.idx[t], M.idx[t + 1], M.idx[t + 2]); }
    M.idx = keep; for (const i of fresh.keys()) if (fresh[i]) M.fixed[i] = 1; // gone: no longer part of the graph
    if (o.mesh) o.mesh[0].geometry.setIndex(keep); rootDirty = true;
  } else {
    const T = proxyTemplate(o[0]), Mx = plantProxy(o).M, nm3 = new THREE.Matrix3().getNormalMatrix(Mx), v = new THREE.Vector3(), geoArr = (G2) => ({ pos: G2.attributes.position.array, nor: G2.attributes.normal.array, uv: G2.attributes.uv.array, col: G2.attributes.color?.array, idx: G2.index.array, node: G2.attributes.aNode.array, ps: 1 });
    const names = PROXY[o[0]].batches, bi = names.indexOf('tstem'), li = names.findIndex((n2) => n2 !== 'tstem');
    fallOrDrop({ trunkR: 0, src: { bark: bi >= 0 ? geoArr(T.binds[bi]) : { pos: [], nor: [], uv: [], idx: [], node: [], ps: 1 }, leaf: li >= 0 ? geoArr(T.binds[li]) : null }, toW: (x, y, z) => { v.set(x, y, z).applyMatrix4(Mx); return [v.x, v.y, v.z]; }, nrm: (x, y, z) => { v.set(x, y, z).applyMatrix3(nm3).normalize(); return [v.x, v.y, v.z]; }, ws, xf, P, s: 1, gone: fresh, node, tint: [0.5, 0.44, 0.38], conifer: o[0] === 'seedC', leaves: li >= 0 });
    o.mesh?.forEach((m, k) => { const g = keptGeo(T.binds[k], o.gone); if (m.geometry !== T.binds[k]) m.geometry.dispose(); m.geometry = g; });
  }
  if (o.ph) physRegroup(o, ws, (i) => !o.gone[i] && (kind !== 'root' || !o.m.fixed[i]));
  crunchList = null;
}
function logSources(M) { const v = M.v, F = fullBark(v), L = v.leafGeo; return { bark: { pos: F.pos, nor: F.nor, uv: F.uv, idx: F.idx, node: F.node, ps: 1 }, leaf: { pos: L.attributes.position.array, nor: L.attributes.normal.array, uv: L.attributes.uv.array, col: L.attributes.color.array, idx: L.index.array, node: L.attributes.aNode.array, ps: v.hRep } }; }
function breakBranch(rec, node) {
  const xf = xfSnap(rec), P = rec.v.P, gone = PL.subtree(P, node);
  if (!rec.gone) rec.gone = new Uint8Array(P.n);
  const fresh = Array.from(gone).map((g, i) => g && !rec.gone[i]); for (let i = 0; i < P.n; i++) if (gone[i]) rec.gone[i] = 1;
  (rec.breaks || (rec.breaks = [])).push(node);
  if (rec.ph) physRegroup(rec, treeSegs(rec), (i) => !rec.gone[i]);
  for (const o of rec.solids || []) if (rec.gone[o.node]) removeSolid(o);
  rec.solids = (rec.solids || []).filter((o) => !rec.gone[o.node]);
  const v = rec.v, X = treeXf(rec), M3 = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().fromArray(rec.m)), nv = new THREE.Vector3();
  fallOrDrop({ trunkR: rec.t ? rec.t.d / 200 : 0, src: { bark: { pos: v.barkGeo.attributes.position.array, nor: v.barkGeo.attributes.normal.array, uv: v.barkGeo.attributes.uv.array, idx: v.barkGeo.index.array, node: v.barkGeo.attributes.aNode.array, ps: v.hRep },
    leaf: { pos: v.leafGeo.attributes.position.array, nor: v.leafGeo.attributes.normal.array, uv: v.leafGeo.attributes.uv.array, col: v.leafGeo.attributes.color.array, idx: v.leafGeo.index.array, node: v.leafGeo.attributes.aNode.array, ps: v.hRep } },
    toW: X.toW, nrm: (x, y, z) => { nv.set(x, y, z).applyMatrix3(M3).normalize(); return [nv.x, nv.y, nv.z]; }, ws: treeSegs(rec), xf, P, s: X.s, gone: fresh, node, tint: rec.bc, conifer: isConifer(v.sp), leaves: true });
  customTree(rec);
  plantNear.cx = 1e9; refreshPlants(player.x, player.z, true);
}
function customTree(rec) { // this tree's own mesh: the variant's buffers minus what broke off
  const v = rec.v, keep = (g) => { const I = g.index.array, N = g.attributes.aNode.array, out = []; if (!rec.gone) return Array.from(I); for (let t = 0; t < I.length; t += 3) if (!rec.gone[N[I[t]]] && !rec.gone[N[I[t + 1]]] && !rec.gone[N[I[t + 2]]]) out.push(I[t], I[t + 1], I[t + 2]); return out; };
  const conifer = isConifer(v.sp);
  const make = (src, mat, col, depth) => {
    const g = new THREE.BufferGeometry(); for (const k of ['position', 'normal', 'uv', 'color', 'aNode', 'aBark']) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]);
    g.setIndex(keep(src)); g.setAttribute('aBend', new THREE.InstancedBufferAttribute(Float32Array.from(rec.bend), 4)); g.setAttribute('aWob', new THREE.InstancedBufferAttribute(Float32Array.from(rec.wob), 4));
    const m = new THREE.InstancedMesh(g, mat, 1); m.instanceMatrix.array.set(rec.m); m.instanceColor = new THREE.InstancedBufferAttribute(Float32Array.from(col), 3);
    m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.customDepthMaterial = depth; return m;
  };
  if (rec.custom) { plantGroup.remove(rec.custom.bark, rec.custom.leaf); rec.custom.bark.geometry.dispose(); rec.custom.leaf.geometry.dispose(); }
  else brokenTrees.push(rec);
  const am = ownerMats(rec, true, conifer);
  rec.custom = { bark: make(v.barkGeo, am.bark, rec.bc, bendDepthMat), leaf: make(v.leafGeo, am.leaf, rec.lc, treeMats.nearFolDepth) };
  plantGroup.add(rec.custom.bark, rec.custom.leaf);
}
// what broke off falls: turned so it lies roughly level, about the joint where it broke, and dropped onto the ground.
// o: { src: {bark, leaf} buffers with a node per vertex and positions in plant metres times ps, toW(plant metres) ->
// world, nrm(local normal) -> world normal, ws: world segments, P, s: world scale, gone, node, tint, conifer, leaves }
function fallOrDrop(o) { return [...falls.values()].filter((f) => f.awake).length < 12 && (phys.worker || phys.core) ? spawnFall(o) : dropPiece(o); }
// the broken-off part's triangles in the world, where they were when it broke (place: an optional extra transform)
function pieceGeometry(o, place = (p) => _pg.set(p[0], p[1], p[2])) {
  const { gone } = o, tmp = new THREE.Vector3();
  const piece = { pos: [], nor: [], uv: [], idx: [], node: [] }, leaf = { pos: [], nor: [], uv: [], col: [], idx: [], node: [] };
  const take = (S, out, withCol, q) => {
    const map = new Map();
    for (let t = 0; t < S.idx.length; t += 3) {
      if (!(gone[S.node[S.idx[t]]] && gone[S.node[S.idx[t + 1]]] && gone[S.node[S.idx[t + 2]]])) continue;
      for (let c = 0; c < 3; c++) {
        const vi = S.idx[t + c]; let k = map.get(vi);
        if (k === undefined) {
          k = out.pos.length / 3; map.set(vi, k); out.node.push(S.node[vi]);
          const nd = S.node[vi], w = place(xfPoint(o, nd, o.toW(S.pos[vi * 3] * S.ps, S.pos[vi * 3 + 1] * S.ps, S.pos[vi * 3 + 2] * S.ps), false)); out.pos.push(w.x, w.y, w.z);
          const nn = xfPoint(o, nd, o.nrm(S.nor[vi * 3], S.nor[vi * 3 + 1], S.nor[vi * 3 + 2]), true); tmp.set(nn[0], nn[1] + (withCol ? 1.2 : 0), nn[2]).normalize(); if (q) tmp.applyQuaternion(q); out.nor.push(tmp.x, tmp.y, tmp.z);
          out.uv.push(S.uv[vi * 2], S.uv[vi * 2 + 1]); if (withCol) out.col.push(S.col[vi * 3], S.col[vi * 3 + 1], S.col[vi * 3 + 2]);
        }
        out.idx.push(k);
      }
    }
  };
  take(o.src.bark, piece, false, o.q); if (o.leaves) take(o.src.leaf, leaf, true, o.q);
  return { piece, leaf };
}
const _pg = new THREE.Vector3(), _xq = new THREE.Quaternion(), _xv = new THREE.Vector3();
function xfPoint(o, nd, p, dir) { // a rest point (or direction) of segment nd, where that segment is drawn now
  const X = o.xf; if (!X || !(nd < o.P.n)) return p;
  _xq.set(X.q[nd * 4], X.q[nd * 4 + 1], X.q[nd * 4 + 2], X.q[nd * 4 + 3]);
  if (dir) { _xv.set(p[0], p[1], p[2]).applyQuaternion(_xq); return [_xv.x, _xv.y, _xv.z]; }
  const k = nd * 7; _xv.set(p[0] - o.ws[k], p[1] - o.ws[k + 1], p[2] - o.ws[k + 2]).applyQuaternion(_xq);
  return [X.a2[nd * 3] + _xv.x, X.a2[nd * 3 + 1] + _xv.y, X.a2[nd * 3 + 2] + _xv.z];
}
function pieceMeshes(o, G, parent) {
  const mk = (b, mat) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)); if (b.col) g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3)); g.setIndex(b.idx); const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const barkMat = new THREE.MeshLambertMaterial({ map: tex.bark }); barkMat.color.setRGB(o.tint[0] * 1.6, o.tint[1] * 1.6, o.tint[2] * 1.6);
  if (G.piece.idx.length) mk(G.piece, barkMat);
  if (G.leaf.idx.length) mk(G.leaf, o.conifer ? mats.needleStill : mats.leafStill);
}
// ---- falling pieces: a rigid body of capsules (one per segment) simulated with the branches it falls through
// ---- free objects: anything not attached (a piece that broke off, loose wood, a root or stem that snapped, a log) is a
// set of rigid bodies joined where the wood bends (PhysicsCore.addFree, built by PH.makeFree). Its mesh is bound to its
// bodies: each vertex stored in its body's frame, drawn at x_b + q_b · v from a per-body transform texture. At rest it
// is solid to walk on where it lies; a foot on it presses it with your weight.
const falls = new Map(); let fallId = 1; // every free object, by id (awake ones have .awake)
const WOOD_FREE = { green: (sp) => ({ E: PL.ARCH[sp].wood.E, MOR: PL.ARCH[sp].wood.MOR, rho: 800, dead: false }), dead: (sp) => ({ E: PL.ARCH[sp].wood.E * 1.25, MOR: PL.ARCH[sp].wood.MOR * 1.3, rho: 550, dead: true }), // dry: stiffer, stronger, brittle
  // decay fd 0..1 (years down over the time a stem that size takes to rot): lighter, weaker, softer [rough: brown and white
  // rots take most of the strength well before most of the mass]
  rotted: (sp, fd) => ({ E: PL.ARCH[sp].wood.E * 1.25 * (1 - 0.6 * fd), MOR: PL.ARCH[sp].wood.MOR * 1.3 * (1 - 0.8 * fd), rho: 550 * (1 - 0.45 * fd), dead: true }) };
function freePatch(sh, o) {
  sh.uniforms.uFreeTex = { value: o.tex };
  sh.vertexShader = 'uniform highp sampler2D uFreeTex; attribute float aBody;\n' + sh.vertexShader
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      int fbI = int(aBody + 0.5); vec3 fbX = texelFetch(uFreeTex, ivec2(fbI * 2, 0), 0).xyz; vec4 fbQ = texelFetch(uFreeTex, ivec2(fbI * 2 + 1, 0), 0);
      objectNormal += 2.0 * cross(fbQ.xyz, cross(fbQ.xyz, objectNormal) + fbQ.w * objectNormal);`)
    .replace('#include <project_vertex>', `vec4 mvPosition = vec4(fbX + transformed + 2.0 * cross(fbQ.xyz, cross(fbQ.xyz, transformed) + fbQ.w * transformed), 1.0);
      mvPosition = viewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition;`);
}
function freeMat(base, o, key) { const m = base.clone(), prev = base.onBeforeCompile; m.onBeforeCompile = (sh) => { if (prev) prev.call(m, sh); freePatch(sh, o); }; m.customProgramCacheKey = () => 'free' + key; return m; }
// the world a free object moves in: the ground's top surface, standing trunks and fixed solids as capsules
function freeWorld(cx, cz, bed = null) {
  const { hf } = bodyWorld(cx, cz), st = [];
  if (bed) { // where it already rests in the ground, the ground is shaped to it: a sunk log lies in its own trough
    const n = hf.n, step = hf.step;
    for (const g of bed) {
      const ax = g.a[0], az = g.a[2], vx = g.b[0] - ax, vz = g.b[2] - az, l2 = vx * vx + vz * vz || 1e-9, re = Math.max(g.r, step * 0.75);
      const i0 = Math.max(0, Math.floor((Math.min(ax, g.b[0]) - re - hf.x0) / step)), i1 = Math.min(n - 1, Math.ceil((Math.max(ax, g.b[0]) + re - hf.x0) / step));
      const j0 = Math.max(0, Math.floor((Math.min(az, g.b[2]) - re - hf.z0) / step)), j1 = Math.min(n - 1, Math.ceil((Math.max(az, g.b[2]) + re - hf.z0) / step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = hf.x0 + i * step, z = hf.z0 + j * step, t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1), dh = Math.hypot(x - ax - vx * t, z - az - vz * t); if (dh >= re) continue;
        const low = g.a[1] + (g.b[1] - g.a[1]) * t - g.r * Math.sqrt(1 - (dh / re) ** 2) - 0.004, k = j * n + i; // its underside here (widened to at least one grid cell)
        if (low < hf.h[k]) hf.h[k] = low;
      }
    }
  }
  for (const t of nearbyTrunks(cx, cz)) { if ((t.x - cx) ** 2 + (t.z - cz) ** 2 > 400) continue; const g = ground(t.x, t.z); st.push(t.x, g - 1, t.z, t.x, g + 20, t.z, Math.max(0.03, t.r - 0.25)); }
  return { hf, statics: Float32Array.from(st) };
}
// segs: [{ a:[x,y,z], b:[x,y,z], r, par }] (par: index of the segment it hangs from, or -1), parents first. mesh: arrays
// in world coordinates with seg (which segment each vertex belongs to). Returns the free object.
function spawnFree(segs, wood, meshes, extra = {}) {
  const pts = [], edges = [];
  segs.forEach((g) => { pts.push(g.a, g.b); edges.push({ a: pts.length - 2, b: pts.length - 1, r: g.r, par: g.par }); });
  if (!edges.length) return null;
  let cx = 0, cz = 0; for (const g of segs) { cx += g.a[0] + g.b[0]; cz += g.a[2] + g.b[2]; } cx /= 2 * segs.length; cz /= 2 * segs.length;
  const id = fallId++, f = PH.makeFree(id, pts, edges, wood, { ...freeWorld(cx, cz, segs), sleep: !!extra.sleep, twig: extra.twig }); // (physics data only: it goes to the worker)
  const nb = f.nb, data = new Float32Array(nb * 8); for (let b = 0; b < nb; b++) { data.set([f.bx[b * 3], f.bx[b * 3 + 1], f.bx[b * 3 + 2], 0, 0, 0, 0, 1], b * 8); }
  const tex = new THREE.DataTexture(data, nb * 2, 1, THREE.RGBAFormat, THREE.FloatType); tex.needsUpdate = true;
  const o = { id, f: { nb, cb: f.cb, cl: f.cl, cr: f.cr, ja: Int32Array.from(f.ja), jb: Int32Array.from(f.jb), bx: Float32Array.from(f.bx), bq: Float32Array.from(f.bq) }, tex, data, group: new THREE.Group(), awake: true, solids: [], x: cx, z: cz, top: 0, rad: 1, ...extra.tag };
  o.seg2body = f.seg2body; freeMeshes(o, meshes);
  worldGroup.add(o.group); freeBounds(o); o.wx = cx; o.wz = cz; falls.set(id, o);
  delete f.seg2body; // (the worker does not need it)
  if (phys.worker) phys.worker.postMessage({ type: 'free', f }); else if (phys.core) phys.core.addFree(f);
  phys.t = 1; return o;
}
function freeMeshes(o, meshes) { // its meshes, each vertex in its body's frame (at the body's pose now)
  const F = o.f, q = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const M of meshes) {
    if (!M.idx.length) continue;
    const n = M.pos.length / 3, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), body = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const b = o.seg2body[M.seg[k]] ?? 0; body[k] = b; q.set(F.bq[b * 4], F.bq[b * 4 + 1], F.bq[b * 4 + 2], F.bq[b * 4 + 3]).invert();
      v.set(M.pos[k * 3] - F.bx[b * 3], M.pos[k * 3 + 1] - F.bx[b * 3 + 1], M.pos[k * 3 + 2] - F.bx[b * 3 + 2]).applyQuaternion(q); pos.set([v.x, v.y, v.z], k * 3);
      v.set(M.nor[k * 3], M.nor[k * 3 + 1], M.nor[k * 3 + 2]).applyQuaternion(q); nor.set([v.x, v.y, v.z], k * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(M.uv, 2));
    if (M.col) g.setAttribute('color', new THREE.Float32BufferAttribute(M.col, 3)); g.setAttribute('aBody', new THREE.BufferAttribute(body, 1)); g.setIndex(Array.from(M.idx));
    const mesh = new THREE.Mesh(g, freeMat(M.mat, o, M.key)); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; o.group.add(mesh);
  }
}
function freeCut(o, joints) { // joints snapped inside it: the triangles that bridged the two parts go (else they stretch after them)
  const cut = o.cut || (o.cut = new Set()), nb = o.f.nb;
  for (const j of joints) { const a = o.f.ja[j], b = o.f.jb[j]; cut.add(a * nb + b); cut.add(b * nb + a); }
  for (const m of o.group.children) {
    const g = m.geometry, B = g.attributes.aBody?.array; if (!B) continue;
    const I0 = m.userData.idx0 || (m.userData.idx0 = Array.from(g.index.array)), out = [];
    for (let t = 0; t < I0.length; t += 3) { const a = B[I0[t]], b = B[I0[t + 1]], c = B[I0[t + 2]]; if (cut.has(a * nb + b) || cut.has(b * nb + c) || cut.has(c * nb + a)) continue; out.push(I0[t], I0[t + 1], I0[t + 2]); }
    g.setIndex(out);
  }
}
function freeBounds(o) { const F = o.f; let x = 0, z = 0, top = -Infinity; for (let b = 0; b < F.nb; b++) { x += F.bx[b * 3]; z += F.bx[b * 3 + 2]; top = Math.max(top, F.bx[b * 3 + 1]); } o.x = x / F.nb; o.z = z / F.nb; o.top = top + 1; o.rad = 3; }
function freeCaps(o) { // its capsules in the world now (main thread copy): [ax,ay,az,bx,by,bz,r] per capsule
  const F = o.f, out = new Float32Array(F.cb.length * 7), q = new THREE.Quaternion(), v = new THREE.Vector3();
  for (let c = 0; c < F.cb.length; c++) { const b = F.cb[c]; q.set(F.bq[b * 4], F.bq[b * 4 + 1], F.bq[b * 4 + 2], F.bq[b * 4 + 3]);
    for (const e of [0, 3]) { v.set(F.cl[c * 6 + e], F.cl[c * 6 + e + 1], F.cl[c * 6 + e + 2]).applyQuaternion(q); out[c * 7 + e] = F.bx[b * 3] + v.x; out[c * 7 + e + 1] = F.bx[b * 3 + 1] + v.y; out[c * 7 + e + 2] = F.bx[b * 3 + 2] + v.z; }
    out[c * 7 + 6] = F.cr[c]; }
  return out;
}
function freeSolids(o) { // what you can stand on: its thicker capsules where they are now
  for (const so of o.solids) removeSolid(so); o.solids = [];
  const C = freeCaps(o);
  for (let c = 0; c < o.f.cb.length; c++) { const k = c * 7, r = C[k + 6]; if (r < 0.012) continue;
    const so = { kind: 'log', free: o.id, fb: o.f.cb[c], x: (C[k] + C[k + 3]) / 2, z: (C[k + 2] + C[k + 5]) / 2, x0: C[k], z0: C[k + 2], x1: C[k + 3], z1: C[k + 5], ya0: C[k + 1], ya1: C[k + 4], r, r0: r, r1: r, rz0: r, rz1: r };
    addSolid(so, Math.hypot(C[k + 3] - C[k], C[k + 5] - C[k + 2]) / 2 + r); o.solids.push(so); }
}
// a broken-off part of a graph (a tree's limb, a fallen tree's branch, a root, a shrub's stem) becomes a free object
function spawnFall(o) {
  const { P, ws, gone, node } = o, idx = new Map(), segs = [];
  for (let i = 0; i < P.n; i++) {
    if (!gone[i]) continue;
    const k = i * 7, r = ws[k + 6]; if (!(r > 0)) continue;
    let a = xfPoint(o, i, [ws[k], ws[k + 1], ws[k + 2]], false); const b = xfPoint(o, i, [ws[k + 3], ws[k + 4], ws[k + 5]], false), L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); if (L < 1e-4) continue;
    if (i === node && o.trunkR) { const cut = Math.min(L * 0.5, o.trunkR + r); a = a.map((v, d) => v + (b[d] - v) * cut / L); } // start at the bark, not the stem's axis
    const p = P.par[i]; idx.set(i, segs.length); segs.push({ a, b, r: Math.max(0.003, r), par: idx.get(p) ?? -1 });
  }
  if (!segs.length) return;
  const G = pieceGeometry(o), segOf = (nd) => { for (let q = nd; q >= 0; q = P.par[q]) if (idx.has(q)) return idx.get(q); return 0; };
  const barkMat = new THREE.MeshLambertMaterial({ map: tex.bark }); barkMat.color.setRGB(o.tint[0] * 1.6, o.tint[1] * 1.6, o.tint[2] * 1.6);
  const meshes = [{ ...G.piece, seg: G.piece.node.map(segOf), mat: barkMat, key: 'B' }];
  if (o.leaves && G.leaf.idx.length) meshes.push({ ...G.leaf, seg: G.leaf.node.map(segOf), mat: o.conifer ? mats.needleStill : mats.leafStill, key: o.conifer ? 'N' : 'L' });
  let dead = 0; for (let i = 0; i < P.n; i++) if (gone[i] && P.st[i] !== PL.LIVE) dead++;
  spawnFree(segs, o.wood || (dead * 2 > segs.length ? WOOD_FREE.dead(o.sp ?? 0) : WOOD_FREE.green(o.sp ?? 0)), meshes);
}
// Fallen stems near you are free objects, asleep: drawn and stood on as before, solid to other objects. Whatever wakes
// one (your weight on it, a push, a hit, your legs) brings it alive: it gets its own moving mesh, its instance in the
// tile is hidden, and its fixed walking surface is replaced by one that moves with it.
let logT = 0;
function logWake(dt) {
  if ((logT += dt) < 0.5) return; logT = 0; logForget();
  const ci = Math.floor((player.x + HALF) / 16), cj = Math.floor((player.z + HALF) / 16);
  const todo = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const p of pieceCells.get((ci + di) * 4096 + cj + dj) || []) {
    if (p._free !== undefined) continue;
    const mx = (p.x0 + p.x1) / 2, mz = (p.z0 + p.z1) / 2, L = Math.hypot(p.x1 - p.x0, p.z1 - p.z0); if ((mx - player.x) ** 2 + (mz - player.z) ** 2 > (12 + L / 2) ** 2) continue;
    todo.push([p, (mx - player.x) ** 2 + (mz - player.z) ** 2]);
  }
  todo.sort((a, b) => a[1] - b[1]); todo.length = Math.min(todo.length, 2); // nearest first, two at a time: each builds the ground under it
  for (const [p] of todo) p._free = -1; // marked before any is built: none is ground under another (they meet as objects)
  for (const [p] of todo) {
    const A = [p.x0, p.y0, p.z0], B = [p.x1, p.y1, p.z1], n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) / 3)), P = (t) => A.map((v, d) => v + (B[d] - v) * t);
    const segs = Array.from({ length: n }, (_, k) => ({ a: P(k / n), b: P((k + 1) / n), r: p._r, par: k - 1 }));
    const rb = p._t._blog, bmap = new Map();
    if (rb) { // a fresh fallen tree: its branches are part of it (each joined where it leaves the stem or its parent branch)
      const M = rb.m; if (!M) { p._free = undefined; continue; } // (its branches are not built yet: next time)
      const PP = M.v.P, sx = B[0] - A[0], sz = B[2] - A[2], sl = sx * sx + sz * sz || 1;
      for (let i = 0; i < PP.n; i++) {
        const k = i * 7, rr = M.segs[k + 6]; if (!(rr > 0) || rb.gone?.[i]) continue;
        const a = [M.segs[k], M.segs[k + 1], M.segs[k + 2]], b2 = [M.segs[k + 3], M.segs[k + 4], M.segs[k + 5]];
        let par = bmap.get(PP.par[i]); if (par === undefined) par = Math.min(n - 1, Math.max(0, Math.floor(clamp(((a[0] - A[0]) * sx + (a[2] - A[2]) * sz) / sl, 0, 0.999) * n)));
        bmap.set(i, segs.length); segs.push({ a, b: b2, r: rr, par });
      }
    }
    const o = spawnFree(segs, WOOD_FREE.rotted(p._t.sp, p._fd || 0), [], { sleep: true, tag: { piece: p, blog: rb, bmap } }); if (!o) { p._free = undefined; continue; }
    p._free = o.id; o.awake = false;
    if (rb?.ph) physDropOwner(rb, true); // its branch rods are rebuilt knowing they are this object's wood
    for (const so of p._solids) { // stood on: your weight presses the part of it under your foot
      const vx = p.x1 - p.x0, vz = p.z1 - p.z0, t = clamp(((so.x - p.x0) * vx + (so.z - p.z0) * vz) / (vx * vx + vz * vz || 1), 0, 0.999);
      so.free = o.id; so.fb = o.seg2body[Math.floor(t * segs.length)];
    }
  }
}
function logForget() { // dormant logs (never woken) far behind you: back to being scenery only
  for (const o of [...falls.values()]) {
    if (!o.piece || o.live || o.awake || (o.x - player.x) ** 2 + (o.z - player.z) ** 2 < 900) continue;
    for (const so of o.piece._solids) { delete so.free; delete so.fb; } o.piece._free = undefined;
    worldGroup.remove(o.group); falls.delete(o.id);
    if (phys.worker) phys.worker.postMessage({ type: 'freeRemove', id: o.id }); else phys.core?.free.delete(o.id);
  }
}
function logAlive(o) { // first woken: its fixed solids gone, its branches (if any) part of it from now on; its instance follows it
  const p = o.piece; o.live = true;
  for (const so of p._solids) removeSolid(so); p._solids = [];
  const rb = o.blog;
  if (rb && rb.m) { // its branches stop being rods hanging on a fixed stem: they are this object's now
    const M = rb.m;
    if (rb.ph) physDropOwner(rb); for (const so of M.solids) removeSolid(so);
    logPick = logPick.filter((r) => r !== rb); for (const a of branchLogCells.values()) { const k = a.indexOf(rb); if (k >= 0) a.splice(k, 1); }
    logDirty = true; rootWork(0);
    const segOf = (nd) => { for (let q = nd; q >= 0; q = M.v.P.par[q]) if (o.bmap.has(q)) return o.bmap.get(q); return 0; };
    const meshes = [{ pos: M.pos, nor: M.nor, uv: M.uv, col: M.col, idx: M.idx, seg: M.node.map(segOf), mat: mats.root, key: 'LB' }];
    if (M.leaves && M.leaves.idx.length) meshes.push({ ...M.leaves, seg: M.leaves.node.map(segOf), mat: M.leafKind === 'needle' ? mats.needleStill : mats.leafStill, key: M.leafKind === 'needle' ? 'N' : 'L' });
    freeMeshes(o, meshes);
  }
  const sb = o.seg2body[Math.floor(o.seg2body.length / 2)]; // the pose its instance was drawn in (the middle of the stem carries it)
  o.rest = { x: Array.from(o.f.bx.slice(sb * 3, sb * 3 + 3)), q: Array.from(o.f.bq.slice(sb * 4, sb * 4 + 4)), sb };
  return;
  const G = new THREE.CylinderGeometry(1, 1, 1, 10, 3, false); G.translate(0, 0.5, 0); // unit stem along +y, as along() lays it
  const M = new THREE.Matrix4().fromArray(p._mat), nm3 = new THREE.Matrix3().getNormalMatrix(M), v = new THREE.Vector3(), Pa = G.attributes.position.array, Na = G.attributes.normal.array;
  const pos = [], nor = [], seg = [], n = o.f.nb ? 1 : 1;
  for (let k = 0; k < Pa.length; k += 3) { v.set(Pa[k], Pa[k + 1], Pa[k + 2]).applyMatrix4(M); pos.push(v.x, v.y, v.z); seg.push(0); v.set(Na[k], Na[k + 1], Na[k + 2]).applyMatrix3(nm3).normalize(); nor.push(v.x, v.y, v.z); }
  const mat = new THREE.MeshLambertMaterial({ map: tex.bark }), c = p._col.map(lin); mat.color.setRGB(c[0] * 1.6, c[1] * 1.6, c[2] * 1.6);
  // its vertices into body 0's frame at the pose it was built with (the stem is one rigid body)
  const bx = o.rest || o.f.bx, q0 = new THREE.Quaternion(o.f.bq[0], o.f.bq[1], o.f.bq[2], o.f.bq[3]).invert(), ps = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k += 3) { v.set(pos[k] - o.f.bx[0], pos[k + 1] - o.f.bx[1], pos[k + 2] - o.f.bx[2]).applyQuaternion(q0); ps[k] = v.x; ps[k + 1] = v.y; ps[k + 2] = v.z; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(ps, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor.map((x, k) => x), 3)); g.setAttribute('uv', G.attributes.uv); g.setAttribute('aBody', new THREE.BufferAttribute(new Float32Array(ps.length / 3), 1)); g.setIndex(G.index);
  // normals too into the body frame
  const N = g.attributes.normal.array; for (let k = 0; k < N.length; k += 3) { v.set(N[k], N[k + 1], N[k + 2]).applyQuaternion(q0); N[k] = v.x; N[k + 1] = v.y; N[k + 2] = v.z; }
  const mesh = new THREE.Mesh(g, freeMat(mat, o, 'Log')); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; o.group.add(mesh);
}
function freeUpdate(st) { // poses from the solver
  for (const q of st.free || []) {
    const o = falls.get(q.id); if (!o) continue;
    if (o.piece && !o.live && !q.sleep) logAlive(o); // (before taking the new pose: the mesh is built in the pose it slept in)
    if (q.breaks?.length) freeCut(o, q.breaks);
    o.f.bx = q.x; o.f.bq = q.q;
    for (let b = 0; b < o.f.nb; b++) { o.data.set([q.x[b * 3], q.x[b * 3 + 1], q.x[b * 3 + 2], 0, q.q[b * 4], q.q[b * 4 + 1], q.q[b * 4 + 2], q.q[b * 4 + 3]], b * 8); }
    o.tex.needsUpdate = true; freeBounds(o);
    if (o.piece && o.live && o.rest && o.piece._inst) { // a log is drawn by its own tile instance (nothing swaps), moved with its stem
      const b = o.rest.sb, R0 = new THREE.Matrix4().compose(new THREE.Vector3(...o.rest.x), new THREE.Quaternion(...o.rest.q), new THREE.Vector3(1, 1, 1)).invert();
      const T = new THREE.Matrix4().compose(new THREE.Vector3(q.x[b * 3], q.x[b * 3 + 1], q.x[b * 3 + 2]), new THREE.Quaternion(q.q[b * 4], q.q[b * 4 + 1], q.q[b * 4 + 2], q.q[b * 4 + 3]), new THREE.Vector3(1, 1, 1));
      const M = T.multiply(R0).multiply(new THREE.Matrix4().fromArray(o.piece._mat)), I = o.piece._inst; M.toArray(I.mesh.instanceMatrix.array, I.i * 16); I.mesh.instanceMatrix.needsUpdate = true; I.mesh.frustumCulled = false;
    }
    if (!q.sleep && Math.hypot(o.x - o.wx, o.z - o.wz) > 5) { // moved off the world patch it carries: a fresh one under it
      o.wx = o.x; o.wz = o.z; const w = freeWorld(o.x, o.z);
      if (phys.worker) phys.worker.postMessage({ type: 'freeWorld', id: o.id, ...w }); else { const f = phys.core?.free.get(o.id); if (f) Object.assign(f, w); }
    }
    o.awake = !q.sleep; freeSolids(o); // stood on where it is now (asleep: where it came to rest)
  }
}
function topSurface(x, z) { // ground and the static solids on it (logs, rocks, stumps, fallen branches), not standing trees' limbs
  let y = ground(x, z);
  for (const o of solids.get(ckey8(x, z)) || []) if (!o.limb && o.free === undefined && o.logPiece?._free === undefined) y = Math.max(y, topOf(o, x, z)); // (logs near you are objects: they meet each other as objects)
  return y;
}
function dropPiece(o) {
  const { P, ws, gone, node } = o;
  const pivot = [ws[node * 7], ws[node * 7 + 1], ws[node * 7 + 2]];
  let cx = 0, cy = 0, cz = 0, n = 0; for (let i = 0; i < P.n; i++) if (gone[i]) { cx += ws[i * 7 + 3]; cy += ws[i * 7 + 4]; cz += ws[i * 7 + 5]; n++; }
  if (!n) return;
  const dir = new THREE.Vector3(cx / n - pivot[0], cy / n - pivot[1], cz / n - pivot[2]).normalize();
  const axis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)); const al = axis.length();
  const q = new THREE.Quaternion(); if (al > 1e-4) q.setFromAxisAngle(axis.divideScalar(al), -Math.asin(clamp(dir.y, -1, 1)) + (Math.random() - 0.5) * 0.2);
  const pv = new THREE.Vector3(...pivot), tmp = new THREE.Vector3();
  const place = (p) => tmp.set(p[0], p[1], p[2]).sub(pv).applyQuaternion(q).add(pv);
  const piece = { pos: [], nor: [], uv: [], idx: [] }, leaf = { pos: [], nor: [], uv: [], col: [], idx: [] };
  const take = (S, out, withCol) => {
    const map = new Map();
    for (let t = 0; t < S.idx.length; t += 3) {
      if (!(gone[S.node[S.idx[t]]] && gone[S.node[S.idx[t + 1]]] && gone[S.node[S.idx[t + 2]]])) continue;
      for (let c = 0; c < 3; c++) {
        const vi = S.idx[t + c]; let k = map.get(vi);
        if (k === undefined) {
          k = out.pos.length / 3; map.set(vi, k);
          const nd = S.node[vi], w = place(xfPoint(o, nd, o.toW(S.pos[vi * 3] * S.ps, S.pos[vi * 3 + 1] * S.ps, S.pos[vi * 3 + 2] * S.ps), false)); out.pos.push(w.x, w.y, w.z);
          const nn = xfPoint(o, nd, o.nrm(S.nor[vi * 3], S.nor[vi * 3 + 1], S.nor[vi * 3 + 2]), true); tmp.set(nn[0], nn[1] + (withCol ? 1.2 : 0), nn[2]).normalize().applyQuaternion(q); out.nor.push(tmp.x, tmp.y, tmp.z);
          out.uv.push(S.uv[vi * 2], S.uv[vi * 2 + 1]); if (withCol) out.col.push(S.col[vi * 3], S.col[vi * 3 + 1], S.col[vi * 3 + 2]);
        }
        out.idx.push(k);
      }
    }
  };
  take(o.src.bark, piece, false); if (o.leaves) take(o.src.leaf, leaf, true);
  let dy = -Infinity; for (let i = 0; i < piece.pos.length; i += 3) dy = Math.max(dy, ground(piece.pos[i], piece.pos[i + 2]) + 0.01 - piece.pos[i + 1]);
  if (!Number.isFinite(dy)) dy = 0;
  for (const b of [piece, leaf]) for (let i = 1; i < b.pos.length; i += 3) b.pos[i] += dy;
  const mk = (b, mat) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)); if (b.col) g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3)); g.setIndex(b.idx); const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; worldGroup.add(m); return m; };
  const barkMat = new THREE.MeshLambertMaterial({ map: tex.bark }); barkMat.color.setRGB(o.tint[0] * 1.6, o.tint[1] * 1.6, o.tint[2] * 1.6);
  if (piece.idx.length) mk(piece, barkMat);
  if (leaf.idx.length) mk(leaf, o.conifer ? mats.needleStill : mats.leafStill);
  for (let i = 0; i < P.n; i++) { // its thick parts are solid where it lies
    const r = ws[i * 7 + 6]; if (!gone[i] || r < 0.02) continue;
    const a = place(ws.subarray(i * 7, i * 7 + 3)).clone(), b = place(ws.subarray(i * 7 + 3, i * 7 + 6)).clone(); a.y += dy; b.y += dy;
    addSolid({ kind: 'log', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, x0: a.x, z0: a.z, x1: b.x, z1: b.z, ya0: a.y, ya1: b.y, r }, a.distanceTo(b) / 2 + r);
  }
}
// ---------------------------------------------------------------- physics of what the body touches (src/physics.js)
// Branch subtrees near the body are woken and simulated as elastic rods on a worker thread (or the main thread where
// workers are unavailable). Results come back a frame later as a displacement per segment end, written into a small
// texture per tree or fallen tree; that object is drawn by its own mesh whose vertex shader adds the displacement of the
// segment each vertex belongs to. Joints strained past the wood's limit snap and go through the same break path as
// a deliberate break. Groups sleep when untouched and still, and the object returns to shared drawing.
const PHYS_R = 1.7, PHYS_MAX = 1500;
const phys = { worker: null, core: null, mode: 'worker', pending: false, acc: 0, groups: new Map(), owners: new Set(), nextId: 1, force: [0, 0, 0], ms: 0, nodes: 0, t: 0 };
function physReset(mode) {
  if (mode) phys.mode = mode;
  if (phys.worker && (phys.mode !== 'worker')) { phys.worker.terminate(); phys.worker = null; }
  for (const o of phys.owners) physOwnerOff(o, true);
  phys.groups.clear(); phys.owners.clear(); phys.pending = false; phys.t = 1; phys.force = [0, 0, 0]; phys.capF = null; phys.core = null; for (const o of falls.values()) { worldGroup?.remove(o.group); for (const so of o.solids) removeSolid(so); if (o.item) { delete o.item._free; o.item.solid = undefined; } } falls.clear();
  if (phys.mode === 'worker' && !phys.worker) {
    try {
      phys.worker = new Worker(URL.createObjectURL(new Blob([PH.workerSource()], { type: 'text/javascript' })));
      phys.worker.onmessage = (e) => physState(e.data);
      phys.worker.onerror = () => { phys.worker = null; phys.mode = 'main'; physReset(); };
    } catch (e) { phys.worker = null; phys.mode = 'main'; }
  }
  if (phys.worker) phys.worker.postMessage({ type: 'reset' });
  else phys.core = new PH.PhysicsCore();
}
function physSend(m) { if (phys.worker) phys.worker.postMessage(m); else if (m.type === 'add') phys.core.add(m.g); else if (m.type === 'remove') phys.core.remove(m.id); }
// the body as capsules: two legs, torso, head, two arms (from the rig's feet, pelvis, eye and hands)
// The body as capsules for the branch solver: thigh and shin, upper arm and forearm (from last frame's solved joints,
// so knees and elbows stick out where they really are), torso and head. CAP names their order; the solver reports the
// force on each (phys.capF), which pushes the matching part of the skeleton back (bodyFeedback).
const CAP = { thighL: 0, shinL: 1, thighR: 2, shinR: 3, torso: 4, head: 5, upperL: 6, foreL: 7, upperR: 8, foreR: 9, n: 10 };
function bodyCapsules() {
  const Y = player.yaw, rx = Math.cos(Y), rz = -Math.sin(Y), pv = body.pelvis, ey = player.eye, cx = player.x, cz = player.z, out = [];
  const cap = (a, b, r) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], r);
  const J = body.sol?.J;
  if (J) {
    for (const s of ['L', 'R']) { cap(J['hip' + s], J['knee' + s], 0.08); cap(J['knee' + s], [J['ankle' + s][0], J['ankle' + s][1] + 0.02, J['ankle' + s][2]], 0.06); }
    cap(J.pelvis, J.chest, 0.16); cap(J.neck, J.head, 0.11);
    for (const s of ['L', 'R']) { cap(J['shoulder' + s], J['elbow' + s], 0.05); cap(J['elbow' + s], J['hand' + s], 0.045); }
    return new Float32Array(out);
  }
  for (const ft of body.feet) { const sd = ft.side, a = [ft.x ?? cx, (ft.y ?? rig.feet) + 0.06, ft.z ?? cz], b = [pv.x + rx * sd * 0.1, pv.y, pv.z + rz * sd * 0.1], m = a.map((v, k) => (v + b[k]) / 2); cap(b, m, 0.08); cap(m, a, 0.06); }
  const nx = cx + (pv.x - cx) * 0.3, nz = cz + (pv.z - cz) * 0.3;
  cap([pv.x, pv.y - 0.05, pv.z], [nx, ey - 0.18, nz], 0.16);
  cap([nx, ey - 0.02, nz], [nx, ey + 0.08, nz], 0.11);
  for (const hd of body.hands) { const a = [nx + rx * hd.side * 0.18, ey - 0.22, nz + rz * hd.side * 0.18], b = [hd.p.x, hd.p.y, hd.p.z], m = a.map((v, k) => (v + b[k]) / 2); cap(a, m, 0.05); cap(m, b, 0.045); }
  return new Float32Array(out);
}
// which branch subtrees to wake: each limb (for a sapling, the whole plant) with any segment end within PHYS_R
function limbRoots(P, kept) { // segments that start a limb: first-order axes on the stem (or on a leader)
  const out = []; for (let i = 0; i < P.n; i++) if (P.ord[i] === 1 && P.par[i] >= 0 && P.ord[P.par[i]] === 0 && (!kept || kept(i))) out.push(i);
  return out;
}
function subtreeNodes(P, root, kept) { const m = PL.subtree(P, root), out = []; for (let i = 0; i < P.n; i++) if (m[i] && (!kept || kept(i))) out.push(i); return out; }
// ---- small plants as stem skeletons. Shrubs, tall shrubs, herbs, ferns and seedlings are instanced card meshes with
// no graph of their own; each geometry gets a proxy skeleton fitted to it once (k-means clusters of its vertices, a
// stem from the base out to each cluster and on to its farthest vertex; seedlings a central stem with side shoots),
// and every vertex is bound to its nearest proxy segment (which segment, its parent, how far along). Near the body a
// plant is drawn as its own mesh that follows the proxy's simulated displacement, and its instance is hidden.
// stem wood for the small plants (no species table): shrubs and seedlings woody, fern fronds soft
const PLANT_WOOD = { herb: { E: 1, MOR: 15 }, shrub: { E: 6, MOR: 45 }, tall: { E: 7, MOR: 50 }, seedB: { E: 7, MOR: 50 }, seedC: { E: 7, MOR: 45 }, fern: { E: 0.8, MOR: 12 } };
const PROXY = {
  shrub: { batches: ['shrub'], K: 6, r: (b) => 0.004 + 0.003 * b },
  herb: { batches: ['herb'], K: 4, r: () => 0.0025 },
  fern: { batches: ['fern'], K: 8, r: () => 0.0035 },
  tall: { batches: ['tstem', 'tleaf'], K: 6, r: (b) => 0.006 + 0.003 * b },
  seedB: { batches: ['seedB'], K: 5, central: true, r: (b) => 0.004 + 0.008 * b },
  seedC: { batches: ['seedC'], K: 6, central: true, r: (b) => 0.004 + 0.008 * b },
};
function itemMatrix(it) {
  const [type, x, z, yaw, a, b, , v] = it, gy = ground(x, z);
  const M = type === 'tall' ? trs(x, gy - 0.05, z, yaw, a, b, a * (0.8 + 0.4 * v)) : type === 'shrub' ? trs(x, gy - 0.08, z, yaw, a, b, a * 0.9)
    : type === 'fern' ? trs(x, gy - 0.03, z, yaw, a, b, a) : trs(x, gy - 0.02, z, yaw, a, b, a);
  return M.clone();
}
const ITEM_COL = { tall: [0.88, 0.95, 0.76], shrub: [0.9, 0.95, 0.78], seedB: [0.82, 0.92, 0.66], seedC: [0.78, 0.86, 0.70], fern: [0.85, 0.95, 0.7], herb: [0.95, 1.0, 0.72] };
function itemColor(it, nm) { const c = it[6]; return (nm === 'tstem' ? [0.5, 0.44, 0.38] : ITEM_COL[it[0]]).map((k) => k * c); }
const proxyTpl = {};
function proxyTemplate(type) { // fitted once per geometry type
  if (proxyTpl[type]) return proxyTpl[type];
  const S = PROXY[type], geos2 = S.batches.map((nm) => near.b[nm].mesh.geometry), pts = [];
  for (const g of geos2) { const A = g.attributes.position.array; for (let i = 0; i < A.length; i += 3) pts.push([A[i], A[i + 1], A[i + 2]]); }
  const rnd = mulberry32(hash3(type.length, S.K, 5)), K = Math.min(S.K, pts.length);
  let cen = []; for (let k = 0; k < K; k++) cen.push(pts[Math.floor(rnd() * pts.length)].slice());
  const lab = new Int32Array(pts.length), w = (p) => [p[0], p[1] * 0.6, p[2]]; // clusters by direction more than height
  for (let it = 0; it < 10; it++) {
    pts.forEach((p, i) => { let bd = Infinity; const q = w(p); cen.forEach((c, k) => { const cc = w(c), d = (q[0] - cc[0]) ** 2 + (q[1] - cc[1]) ** 2 + (q[2] - cc[2]) ** 2; if (d < bd) { bd = d; lab[i] = k; } }); });
    cen = cen.map((c, k) => { const m = [0, 0, 0]; let n = 0; pts.forEach((p, i) => { if (lab[i] === k) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; n++; } }); return n ? m.map((v) => v / n) : c; });
  }
  const p0 = [], p1 = [], par = [], lvl = [], node = (a, b, pr, l) => { p0.push(a); p1.push(b); par.push(pr); lvl.push(l); return p0.length - 1; };
  let top = 0; for (const p of pts) top = Math.max(top, p[1]);
  const stem = [];
  if (S.central) { let prev = -1, y0 = 0; for (const f of [0.35, 0.7, 1]) { stem.push(prev = node([0, y0, 0], [0, top * f, 0], prev, 0)); y0 = top * f; } }
  cen.forEach((c, k) => {
    let tip = c, td = 0; pts.forEach((p, i) => { if (lab[i] !== k) return; const d = Math.hypot(p[0], p[1] - (S.central ? c[1] : 0), p[2]); if (d > td) { td = d; tip = p; } });
    if (S.central) { const j = stem[Math.min(2, Math.floor(clamp(c[1] / top, 0, 0.999) * 3))], a = p1[j]; const n1 = node(a, c, j, 1); node(c, tip, n1, 2); }
    else { const m = [c[0] * 0.35, c[1] * 0.5, c[2] * 0.35], n0 = node([0, 0, 0], m, -1, 0), n1 = node(m, c, n0, 1); node(c, tip, n1, 2); }
  });
  const n = p0.length, P = { n, par: Int32Array.from(par), st: new Uint8Array(n), ord: Int32Array.from(lvl.map((l) => l + 1)), p0, p1, lvl };
  const binds = geos2.map((g) => { // nearest proxy segment for each vertex
    const A = g.attributes.position.array, nv = A.length / 3, aN = new Float32Array(nv), aB = new Float32Array(nv), aT = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      const q = [A[v * 3], A[v * 3 + 1], A[v * 3 + 2]]; let bd = Infinity, bj = 0, bt = 1;
      for (let j = 0; j < n; j++) { const a = p0[j], b = p1[j], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1, t = clamp(((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / l2, 0, 1), e = Math.hypot(a[0] + d[0] * t - q[0], a[1] + d[1] * t - q[1], a[2] + d[2] * t - q[2]); if (e < bd) { bd = e; bj = j; bt = t; } }
      aN[v] = bj; aB[v] = par[bj]; aT[v] = bt;
    }
    { // one connected piece (a leaf, a frond) stays on one chain of segments: a triangle between two sibling segments tore when they moved apart
      const I = g.index.array, root = Int32Array.from({ length: nv }, (_, i) => i), find = (i) => { while (root[i] !== i) i = root[i] = root[root[i]]; return i; };
      for (let t = 0; t < I.length; t += 3) { const a = find(I[t]), b2 = find(I[t + 1]), c = find(I[t + 2]); root[b2] = a; root[c] = a; }
      const votes = new Map(); for (let v = 0; v < nv; v++) { const r = find(v); let m = votes.get(r); if (!m) votes.set(r, (m = new Map())); m.set(aN[v], (m.get(aN[v]) || 0) + 1); }
      const major = new Map(); for (const [r, m] of votes) { let bj = 0, bc = -1; for (const [j, c] of m) if (c > bc) { bc = c; bj = j; } major.set(r, bj); }
      const onChain = (j, M) => { for (let q = M; q >= 0; q = par[q]) if (q === j) return true; for (let q = j; q >= 0; q = par[q]) if (q === M) return true; return false; };
      for (let v = 0; v < nv; v++) { const M = major.get(find(v)); if (onChain(aN[v], M)) continue;
        const q = [A[v * 3], A[v * 3 + 1], A[v * 3 + 2]], a = p0[M], b2 = p1[M], d = [b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]], l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
        aN[v] = M; aB[v] = par[M]; aT[v] = clamp(((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / l2, 0, 1); }
    }
    const G = new THREE.BufferGeometry(); for (const k in g.attributes) G.setAttribute(k, g.attributes[k]); G.setIndex(g.index);
    G.setAttribute('aNode', new THREE.BufferAttribute(aN, 1)); G.setAttribute('aNodeB', new THREE.BufferAttribute(aB, 1)); G.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    return G;
  });
  return (proxyTpl[type] = { P, binds });
}
function plantProxy(it) { // the item's proxy in the world: segments [x0,y0,z0,x1,y1,z1,r] like a tree's
  if (it._px) return it._px;
  const T = proxyTemplate(it[0]), P = T.P, M = itemMatrix(it), ws = new Float32Array(P.n * 7), r0 = PROXY[it[0]].r(it[5]), v = new THREE.Vector3();
  for (let i = 0; i < P.n; i++) {
    v.set(...P.p0[i]).applyMatrix4(M); ws[i * 7] = v.x; ws[i * 7 + 1] = v.y; ws[i * 7 + 2] = v.z;
    v.set(...P.p1[i]).applyMatrix4(M); ws[i * 7 + 3] = v.x; ws[i * 7 + 4] = v.y; ws[i * 7 + 5] = v.z;
    ws[i * 7 + 6] = r0 * 0.6 ** P.lvl[i];
  }
  return (it._px = { P, ws, M });
}
function plantItemsNear(x, z, R) {
  const out = []; if (!near?.cells) return out;
  const ci = Math.floor((x + HALF) / NC), cj = Math.floor((z + HALF) / NC);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) for (const it of near.cells.get((ci + di) * 4096 + cj + dj) || []) {
    if (!PROXY[it[0]] || !it._bi) continue; const d = Math.hypot(it[1] - x, it[2] - z); if (d < R + it[4]) out.push(it);
  }
  return out;
}
function keptGeo(src, gone) { // the template's buffers, without the triangles of anything gone
  const g = new THREE.BufferGeometry(), I = src.index.array, N = src.attributes.aNode.array, out = [];
  for (const k in src.attributes) g.setAttribute(k, src.attributes[k]);
  for (let t = 0; t < I.length; t += 3) if (!gone[N[I[t]]] && !gone[N[I[t + 1]]] && !gone[N[I[t + 2]]]) out.push(I[t], I[t + 1], I[t + 2]);
  g.setIndex(out); return g;
}
function plantOwnerMeshes(it) { // its own deforming meshes, instead of the instance
  const T = proxyTemplate(it[0]), M = it._px.M, out = [];
  PROXY[it[0]].batches.forEach((nm, k) => {
    const col = itemColor(it, nm).map(lin);
    const base = near.b[nm].mesh.material, wood = nm === 'tstem';
    const m = wood ? new THREE.MeshLambertMaterial({ map: tex.bark }) : foliageMaterial(base.map, { wind: 0, alphaTest: base.alphaTest });
    const prev = m.onBeforeCompile; m.onBeforeCompile = (sh) => { if (prev) prev(sh); nodePatch2(sh, it.ph, !wood); }; m.customProgramCacheKey = () => `proxy${wood ? 'W' : 'F'}`;
    m.color.setRGB(col[0], col[1], col[2]);
    const mesh = new THREE.Mesh(it.gone ? keptGeo(T.binds[k], it.gone) : T.binds[k], m); mesh.matrixAutoUpdate = false; mesh.matrix.copy(M); mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
    worldGroup.add(mesh); out.push(mesh);
  });
  for (const [nm, k] of it._bi || []) near.b[nm].hide(k);
  return out;
}
// What to simulate: every plant segment within PHYS_PAD of a body capsule, plus its path back to whatever rigid thing
// carries it (a trunk, a log, the ground) and, for a small twig cluster, the rest of it. One group per plant; when
// the set grows the group is rebuilt with the state of the nodes it keeps (no pop back to rest); it shrinks only once
// at rest. Segments not simulated but hanging off simulated ones follow their parent (physState).
const PHYS_PAD = 0.4, TWIG_SUB = 12, K_RIGID = 2e6;
function plantKids(P) { if (P._kids) return P._kids; const k = Array.from({ length: P.n }, () => []); for (let i = 0; i < P.n; i++) if (P.par[i] >= 0) k[P.par[i]].push(i); return (P._kids = k); }
function subtreeSize(P) { if (P._size) return P._size; const s = new Int32Array(P.n).fill(1); for (let i = P.n - 1; i >= 0; i--) if (P.par[i] >= 0) s[P.par[i]] += s[i]; return (P._size = s); } // ids are parents-first
function capList(C) { const L = []; for (let c = 0; c < C.length; c += 7) L.push([[C[c], C[c + 1], C[c + 2]], [C[c + 3], C[c + 4], C[c + 5]], C[c + 6]]); return L; }
function capBox(C, pad) { const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]; for (let c = 0; c < C.length; c += 7) for (const e of [0, 3]) for (let a = 0; a < 3; a++) { b[a * 2] = Math.min(b[a * 2], C[c + e + a] - C[c + 6] - pad); b[a * 2 + 1] = Math.max(b[a * 2 + 1], C[c + e + a] + C[c + 6] + pad); } return b; }
function wakeNodes(ws, P, valid, fixed, caps, box, set, pad = PHYS_PAD) {
  const size = subtreeSize(P), kids = plantKids(P); let dmin = Infinity;
  for (let i = 0; i < P.n; i++) {
    if (fixed(i) || !valid(i)) continue;
    const k = i * 7, r = ws[k + 6];
    if (Math.max(ws[k], ws[k + 3]) < box[0] - r || Math.min(ws[k], ws[k + 3]) > box[1] + r || Math.max(ws[k + 1], ws[k + 4]) < box[2] - r || Math.min(ws[k + 1], ws[k + 4]) > box[3] + r || Math.max(ws[k + 2], ws[k + 5]) < box[4] - r || Math.min(ws[k + 2], ws[k + 5]) > box[5] + r) continue;
    const a0 = [ws[k], ws[k + 1], ws[k + 2]], a1 = [ws[k + 3], ws[k + 4], ws[k + 5]];
    let near = false; for (const c of caps) { const d = segSeg(c[0], c[1], a0, a1).d - c[2] - r; if (d < dmin) dmin = d; if (d < pad) { near = true; break; } }
    if (!near) continue;
    for (let q = i; q >= 0 && !fixed(q) && !set.has(q); q = P.par[q]) set.add(q);
    if (size[i] <= TWIG_SUB) { const st = [...kids[i]]; while (st.length) { const q = st.pop(); if (!valid(q) || set.has(q)) continue; set.add(q); st.push(...kids[q]); } }
  }
  return dmin;
}
function physActivate(dt) {
  if ((phys.t += dt) < 0.15) return; phys.t = 0;
  const C = bodyCapsules(), caps = capList(C), box = capBox(C, PHYS_PAD), want = new Map(), bx = player.x, bz = player.z;
  const ask = (owner, kind, ws, P, valid, fixed, extra) => {
    let w = want.get(owner); const set = w ? w.set : new Set();
    const d = wakeNodes(ws, P, valid, fixed, caps, box, set);
    if (extra) extra(set);
    if (set.size && !w) want.set(owner, (w = { owner, kind, ws, P, set, d }));
    if (w) w.d = Math.min(w.d, d);
  };
  const ci = Math.floor((bx + HALF) / 16), cj = Math.floor((bz + HALF) / 16);
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((ci + di) * 4096 + cj + dj) || []) {
    const sap = rec.t && rec.t.d < 8, reach = sap ? 4 : rec.v.crRep * (rec.m[0] ** 2 + rec.m[2] ** 2) ** 0.5 / rec.v.hRep + 3;
    if ((rec.x - bx) ** 2 + (rec.z - bz) ** 2 > reach * reach) continue;
    const P = rec.v.P;
    ask(rec, 'tree', treeSegs(rec), P, (i) => !rec.gone?.[i], sap ? () => false : (i) => P.ord[i] === 0);
  }
  for (const r of logPick) {
    const M = r.m; if (!M || bx < M.box[0] - 3 || bx > M.box[1] + 3 || bz < M.box[2] - 3 || bz > M.box[3] + 3) continue;
    const P = M.v.P; ask(r, 'log', M.segs, P, (i) => M.segs[i * 7 + 6] > 0 && !r.gone?.[i], (i) => P.ord[i] === 0);
  }
  for (const it of plantItemsNear(bx, bz, 2.5)) { const T = plantProxy(it); ask(it, 'plant', T.ws, T.P, (i) => !it.gone?.[i], () => false); }
  for (const r of rootPick) { // roots: what is out of the soil (or hanging from a wad) is a rod like any branch
    const M = r.m; if (!M || (r.x - bx) ** 2 + (r.z - bz) ** 2 > (M.P.rp * 2.5 + 4) ** 2) continue;
    ask(r, 'root', M.ws, M.P, (i) => !M.fixed[i], (i) => !!M.fixed[i]);
  }
  if (pushState.on && pushState.rod) { // what you push is simulated, with its path back to its anchor
    const { owner: o, kind, node } = pushState.rod;
    const spec = kind === 'tree' ? { ws: treeSegs(o), P: o.v.P, valid: (i) => !o.gone?.[i], fixed: o.t && o.t.d < 8 ? () => false : (i) => o.v.P.ord[i] === 0 }
      : kind === 'log' ? { ws: o.m.segs, P: o.m.v.P, valid: (i) => o.m.segs[i * 7 + 6] > 0 && !o.gone?.[i], fixed: (i) => o.m.v.P.ord[i] === 0 }
      : kind === 'root' ? { ws: o.m.ws, P: o.m.P, valid: (i) => !o.m.fixed[i], fixed: (i) => !!o.m.fixed[i] }
      : { ws: plantProxy(o).ws, P: plantProxy(o).P, valid: (i) => !o.gone?.[i], fixed: () => false };
    ask(o, kind, spec.ws, spec.P, spec.valid, spec.fixed, (set) => { for (let q = node; q >= 0 && !spec.fixed(q) && !set.has(q); q = spec.P.par[q]) set.add(q); });
  }
  // branches under a falling piece wake too: whole limbs inside the column it falls through
  for (const f of falls.values()) {
    if (!f.awake) continue;
    const R2f = (f.rad + 0.6) ** 2, inCol = (ws, nodes) => { for (const i of nodes) { const k = i * 7; for (const e of [0, 3]) if ((ws[k + e] - f.x) ** 2 + (ws[k + e + 2] - f.z) ** 2 < R2f && ws[k + e + 1] < f.top + 0.5) return true; } return false; };
    const limbs = (P, ws, valid, sap, cache) => (set) => { for (const root of sap ? [0] : cache) { if (!valid(root)) continue; const nodes = subtreeNodes(P, root, valid); if (inCol(ws, nodes)) for (const q of nodes) set.add(q); } };
    const fi = Math.floor((f.x + HALF) / 16), fj = Math.floor((f.z + HALF) / 16);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((fi + di) * 4096 + fj + dj) || []) {
      if ((rec.x - f.x) ** 2 + (rec.z - f.z) ** 2 > (f.rad + 8) ** 2) continue;
      const P = rec.v.P, ws = treeSegs(rec), sap = rec.t && rec.t.d < 8, valid = (i) => !rec.gone?.[i];
      ask(rec, 'tree', ws, P, valid, sap ? () => false : (i) => P.ord[i] === 0, limbs(P, ws, valid, sap, rec.v.limbRoots || (rec.v.limbRoots = limbRoots(P))));
    }
    for (const r of logPick) {
      const M = r.m; if (!M || f.x < M.box[0] - 3 || f.x > M.box[1] + 3 || f.z < M.box[2] - 3 || f.z > M.box[3] + 3) continue;
      const P = M.v.P, valid = (i) => M.segs[i * 7 + 6] > 0 && !r.gone?.[i];
      ask(r, 'log', M.segs, P, valid, (i) => P.ord[i] === 0, limbs(P, M.segs, valid, false, M.roots || (M.roots = limbRoots(P, valid))));
    }
  }
  const list = [...want.values()].sort((a, b) => a.d - b.d), cap = PHYS_MAX + ([...falls.values()].some((f) => f.awake) ? 1500 : 0), keep = new Set();
  let total = 0;
  for (const w of list) {
    const G = phys.groups.get(physKey(w.owner));
    let nodes = w.set;
    if (G && G.hinged) { nodes = new Set(w.set); for (const i of G.nodes) nodes.add(i); } // something in it gave way and hangs: it keeps its shape (and its nodes) from now on
    else if (G && !G.asleep && w.owner.ph) { // still moving: keep what is displaced (and its path back), let go of what is back at rest
      nodes = new Set(w.set); const D = w.owner.ph.data;
      for (const i of G.nodes) {
        if (nodes.has(i) || Math.abs(D[i * 4]) + Math.abs(D[i * 4 + 1]) + Math.abs(D[i * 4 + 2]) < 0.015) continue;
        for (let q = i; q >= 0 && G.nodeSet.has(q) && !nodes.has(q); q = w.P.par[q]) nodes.add(q);
      }
    }
    if (total + nodes.size > cap && !G?.hinged) continue; total += nodes.size; keep.add(physKey(w.owner));
    const arr = [...nodes].filter((i) => !w.owner.gone?.[i]).sort((a, b) => a - b);
    if (G && G.nodes.length === arr.length && G.nodes.every((v, k) => v === arr[k])) continue; // unchanged
    physAddGroup({ owner: w.owner, kind: w.kind, nodes: arr, ws: w.ws, P: w.P, key: physKey(w.owner), carry: G ? G.id : undefined });
  }
  for (const [key, g] of phys.groups) if (!keep.has(key) && g.asleep && !g.hinged) physRemoveGroup(key);
}
let ownerIds = 0;
const physKey = (o) => 'o' + (o._pid || (o._pid = ++ownerIds));
function physAddGroup(w) {
  const { owner, kind, nodes, ws, P } = w, n = nodes.length;
  const wood = kind === 'plant' ? PLANT_WOOD[owner[0]] : PL.ARCH[kind === 'tree' ? owner.v.sp : owner.t.sp].wood;
  const pins = kind === 'root' ? owner.m.pin : null;
  const E = wood.E * 1e9, MOR = wood.MOR * 1e6, local = new Map(nodes.map((i, j) => [i, j]));
  const g = { id: phys.nextId++, n, ids: Int32Array.from(nodes), carry: w.carry, pin: Uint8Array.from(nodes, (i) => pins ? pins[i] : 0), dry: new Uint8Array(n), par: new Int32Array(n), u: new Float32Array(n), s0: new Float32Array(n * 3), x0: new Float32Array(n * 3), r: new Float32Array(n), L: new Float32Array(n), k: new Float32Array(n), w: new Float32Array(n), lim: new Float32Array(n) };
  const deadAll = kind === 'log' && owner.m.T > 1;
  nodes.forEach((i, j) => {
    const k = i * 7; g.s0.set([ws[k], ws[k + 1], ws[k + 2]], j * 3); g.x0.set([ws[k + 3], ws[k + 4], ws[k + 5]], j * 3);
    const L = Math.max(1e-3, Math.hypot(ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2])), r = Math.max(0.002, ws[k + 6] * 0.85); // its true rest length (a floor here would pull the node off its rest point at once)
    const pj = local.get(P.par[i]) ?? -1; g.par[j] = pj;
    if (P.par[i] >= 0) { // where it sits along its parent (also when the parent is the rigid anchor: its start is then fixed there)
      const q = P.par[i] * 7, vx = ws[q + 3] - ws[q], vy = ws[q + 4] - ws[q + 1], vz = ws[q + 5] - ws[q + 2];
      g.u[j] = clamp(((ws[k] - ws[q]) * vx + (ws[k + 1] - ws[q + 1]) * vy + (ws[k + 2] - ws[q + 2]) * vz) / (vx * vx + vy * vy + vz * vz || 1), 0, 1);
    }
    const dead = (deadAll || P.st[i] !== PL.LIVE) && kind !== 'root' && kind !== 'plant', I = Math.PI * r ** 4 / 4, Ed = dead ? E * 1.25 : E; // dry wood is stiffer, stronger and more brittle than green
    g.dry[j] = dead ? 1 : 0;
    g.r[j] = r; g.L[j] = L; g.k[j] = 3 * Ed * I / L ** 3; g.w[j] = 1 / (800 * Math.PI * r * r * L + (P.ord[i] >= 2 ? 0.02 : 0.005));
    g.lim[j] = MOR * (dead ? 1.3 : 1) / Ed * (dead ? 1.0 : kind === 'plant' ? 6 : 2.5); // green wood fails at roughly 1-2 % strain, about 2.5x its proportional limit MOR/E [rough]; soft stems bend much further
  });
  // Segments no body could bend measurably (tip stiffness 3EI/ℓ³ from the group's anchor above K_RIGID) are held where
  // they are, as soil holds a root: a few solver iterations cannot make a chain that stiff, and a millimetre of numerical
  // give at a 15 cm joint reads as breaking strain. Their children still bend.
  const ell = new Float32Array(n);
  for (let j = 0; j < n; j++) { const pj = g.par[j]; ell[j] = (pj >= 0 ? ell[pj] - g.L[pj] * (1 - g.u[j]) : 0) + g.L[j]; if (3 * E * Math.PI * g.r[j] ** 4 / 4 / ell[j] ** 3 > K_RIGID) g.pin[j] = 1; }
  const old = phys.groups.get(w.key);
  const G = { ...w, id: g.id, asleep: false, nodeSet: new Set(nodes) };
  phys.groups.set(w.key, G); physOwnerOn(owner, kind);
  const ph = owner.ph; (ph.groups || (ph.groups = new Set())).add(w.key);
  if (old) for (const i of old.nodes) if (!G.nodeSet.has(i)) ph.sim[i] = 0;
  for (const i of nodes) ph.sim[i] = 1;
  if (kind === 'log') for (const o of falls.values()) if (o.blog === owner) g.skipFree = o.id; // a fresh log's branches: the same wood as that free object's parts (they must not meet)
  physSend({ type: 'add', g });
}
function physRemoveGroup(key) {
  const G = phys.groups.get(key); if (!G) return;
  phys.groups.delete(key); physSend({ type: 'remove', id: G.id });
  const o = G.owner; if (o.ph) { o.ph.groups.delete(key); for (const i of G.nodes) o.ph.sim[i] = 0; o.ph.data.fill(0); ownerUpload(o); if (!o.ph.groups.size) physOwnerOff(o); }
}
function physRegroup(o, ws, valid) { // after a break: the owner's groups lose what broke off and keep the state of the rest
  for (const key of [...(o.ph?.groups || [])]) {
    const G = phys.groups.get(key); if (!G) continue;
    const nodes = G.nodes.filter(valid);
    for (const i of G.nodes) if (!valid(i)) o.ph.sim[i] = 0;
    if (!nodes.length) { physRemoveGroup(key); continue; }
    physAddGroup({ owner: o, kind: G.kind, nodes, ws, P: G.P, key, carry: G.id });
  }
  phys.t = 1; // look again next frame for what is now near
}
function physDropOwner(o, keepMesh) { // its graph changed (a break): forget its groups; they are rebuilt next round
  for (const key of [...(o.ph?.groups || [])]) { const G = phys.groups.get(key); if (G) { phys.groups.delete(key); physSend({ type: 'remove', id: G.id }); } }
  if (o.ph) { o.ph.groups.clear(); o.ph.sim.fill(0); o.ph.data.fill(0); ownerUpload(o); if (!keepMesh) physOwnerOff(o); }
}
// an object being simulated gets a displacement texture (one texel per segment) and its own deforming mesh
function ownerTex(o, kind) { // the displacement texture alone (a broken tree has one even when nothing moves it)
  if (o.ph) return o.ph;
  const n = kind === 'tree' ? o.v.P.n : kind === 'log' ? o.m.v.P.n : kind === 'root' ? o.m.P.n + 1 : plantProxy(o).P.n, W = Math.min(n, 1024), H = Math.ceil(n / W), data = new Float32Array(n * 4);
  const gdata = new Float32Array(W * 3 * H * 4), tex = new THREE.DataTexture(gdata, W * 3, H, THREE.RGBAFormat, THREE.FloatType);
  o.ph = { kind, tex, data, gdata, W, n, groups: new Set(), sim: new Uint8Array(n) }; ownerUpload(o);
  return o.ph;
}
function physOwnerOn(o, kind) {
  if (phys.owners.has(o)) return;
  const had = !!o.custom; ownerTex(o, kind); phys.owners.add(o);
  if (kind === 'tree') { if (!had) { customTree(o); plantNear.cx = 1e9; refreshPlants(player.x, player.z, true); } }
  else if (kind === 'plant') { if (!o.mesh) o.mesh = plantOwnerMeshes(o); }
  else if (kind === 'root') { // its own deforming mesh; the merged root buffer leaves it out
    const g = arraysGeo(o.m); g.setAttribute('aNode', new THREE.Float32BufferAttribute(o.m.node, 1));
    const m = new THREE.MeshLambertMaterial({ map: tex.bark, vertexColors: true }); m.onBeforeCompile = (sh) => nodePatch(sh, o.ph); m.customProgramCacheKey = () => 'actRoot';
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.castShadow = false; mesh.frustumCulled = false; plantGroup.add(mesh); o.mesh = [mesh]; rootDirty = true;
  }
  else { logMesh(o); logDirty = true; rootWork(0); }
}
function physOwnerOff(o, quiet) {
  if (o.md) { modal.owners.delete(o); o.md = null; } // (no longer modal either)
  if (!o.ph) return;
  phys.owners.delete(o);
  if (o.ph.kind === 'tree') {
    if (o.gone) { o.ph.groups.clear(); o.ph.sim.fill(0); o.ph.data.fill(0); ownerUpload(o); return; } // a broken tree keeps its own mesh
    if (o.custom) { plantGroup.remove(o.custom.bark, o.custom.leaf); o.custom.bark.geometry.dispose(); o.custom.leaf.geometry.dispose(); o.custom = null; }
    brokenTrees = brokenTrees.filter((r) => r !== o); o.ph = null;
    if (!quiet) { plantNear.cx = 1e9; refreshPlants(player.x, player.z, true); }
  } else if (o.ph.kind === 'root') {
    for (const m of o.mesh || []) { plantGroup.remove(m); m.geometry.dispose(); m.material.dispose(); } o.mesh = null; o.ph = null; rootDirty = true;
  } else if (o.ph.kind === 'plant') {
    if (o.gone) { o.ph.groups.clear(); o.ph.sim.fill(0); inheritDisp(o); ownerUpload(o); return; } // drawn without what broke off, for good
    for (const m of o.mesh || []) { worldGroup.remove(m); m.material.dispose(); } o.mesh = null; o.ph = null;
    const M = o._px?.M; if (M) for (const [nm, k] of o._bi || []) near.b[nm].show(k, M);
  } else {
    if (o.mesh) { for (const m of o.mesh) { plantGroup.remove(m); m.geometry.dispose(); } o.mesh = null; }
    o.ph = null; if (!quiet) { logDirty = true; rootWork(0); }
  }
}
// Each segment of a simulated plant is drawn as a rigid piece: its rest base a goes to a', and it turns by q (from its
// parent's turn, then the least turn that takes its axis to where the solver has it). One texel triple per node: (a,
// flag), (a', 0), q. A vertex p (world) goes to a' + q(p - a); its normal turns with it. Nothing stretches across a
// joint however far a limb droops (a displacement alone left long slivers between pieces that turned).
const ROD_GLSL = `uniform highp sampler2D uNodeTex; uniform float uNodeW; attribute float aNode;
  vec3 rodQ(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
  void rodXf(out vec3 ra, out vec3 rb, out vec4 rq, out float rf) {
    int nd = int(aNode + 0.5), wd = int(uNodeW), x = (nd - (nd / wd) * wd) * 3, y = nd / wd;
    vec4 t0 = texelFetch(uNodeTex, ivec2(x, y), 0); ra = t0.xyz; rf = t0.w; rb = texelFetch(uNodeTex, ivec2(x + 1, y), 0).xyz; rq = texelFetch(uNodeTex, ivec2(x + 2, y), 0);
  }
`;
function rodPatch(sh, o, inst) {
  sh.uniforms.uNodeTex = { value: o.tex }; sh.uniforms.uNodeW = { value: o.W };
  const M = inst ? `mat3 rM = mat3(modelMatrix);
#ifdef USE_INSTANCING
      rM = rM * mat3(instanceMatrix);
#endif
` : 'mat3 rM = mat3(modelMatrix);\n';
  sh.vertexShader = ROD_GLSL + sh.vertexShader
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      { vec3 ra, rb; vec4 rq; float rf; rodXf(ra, rb, rq, rf);
      ${M}      objectNormal = inverse(rM) * rodQ(rq, rM * objectNormal); }
`)
    .replace('#include <project_vertex>', `
    vec4 mvPosition = vec4(transformed, 1.0);
${inst ? `#ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
#endif
` : ''}
    mvPosition = modelMatrix * mvPosition;
    { vec3 ra, rb; vec4 rq; float rf; rodXf(ra, rb, rq, rf); mvPosition.xyz = rf > 1.5 ? rb : rb + rodQ(rq, mvPosition.xyz - ra); }
    __GUARD__
    mvPosition = viewMatrix * mvPosition;
    gl_Position = projectionMatrix * mvPosition;`);
}
function nodePatch(sh, o) { rodPatch(sh, o, true); sh.vertexShader = sh.vertexShader.replace('__GUARD__', ''); }
function nodePatch2(sh, o, guard) { // proxy plants (their instance matrix is the mesh's own); leaves keep clear of the body
  if (guard) Object.assign(sh.uniforms, BODYCAP);
  rodPatch(sh, o, false);
  sh.vertexShader = (guard ? BODYCAP_GLSL : '') + sh.vertexShader.replace('__GUARD__', guard ? 'mvPosition.xyz += bodyGuard(mvPosition.xyz, modelMatrix[3].y);' : '');
}
// the rigid placement of every segment from the solver's displacements (D: end displacement per node, w: 1 carried, 2 gone)
const _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _rv = new THREE.Vector3(), _rv2 = new THREE.Vector3();
function ownerUpload(o) {
  const ph = o.ph, D = ph.data, G = ph.gdata, P = ownerP(o), ws = ownerWs(o), n = Math.min(P.n, ws.length / 7);
  const X = ph.xf || (ph.xf = { a2: new Float32Array(P.n * 3), q: new Float32Array(P.n * 4) }), A2 = X.a2, Q = X.q;
  for (const i of parentsFirst(P)) {
    if (i >= n) continue;
    const k = i * 7, p = P.par[i], f = D[i * 4 + 3], moved = ph.sim[i] || f === 1 || f === 2;
    if (p >= 0 && p < n) { // carried by the parent: its turn about the parent's base
      _rq.set(Q[p * 4], Q[p * 4 + 1], Q[p * 4 + 2], Q[p * 4 + 3]);
      _rv.set(ws[k] - ws[p * 7], ws[k + 1] - ws[p * 7 + 1], ws[k + 2] - ws[p * 7 + 2]).applyQuaternion(_rq);
      A2[i * 3] = A2[p * 3] + _rv.x; A2[i * 3 + 1] = A2[p * 3 + 1] + _rv.y; A2[i * 3 + 2] = A2[p * 3 + 2] + _rv.z;
    } else { _rq.set(0, 0, 0, 1); A2[i * 3] = ws[k]; A2[i * 3 + 1] = ws[k + 1]; A2[i * 3 + 2] = ws[k + 2]; }
    if (ph.sim[i] || (f === 1 && !(p >= 0 && p < n))) { // the solver has its end: turn the carried axis onto it
      _rv.set(ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2]).applyQuaternion(_rq);
      _rv2.set(ws[k + 3] + D[i * 4] - A2[i * 3], ws[k + 4] + D[i * 4 + 1] - A2[i * 3 + 1], ws[k + 5] + D[i * 4 + 2] - A2[i * 3 + 2]);
      const l1 = _rv.length(), l2 = _rv2.length();
      if (l1 > 1e-6 && l2 > 1e-6) { _rq2.setFromUnitVectors(_rv.divideScalar(l1), _rv2.divideScalar(l2)); _rq.premultiply(_rq2); }
    }
    Q[i * 4] = _rq.x; Q[i * 4 + 1] = _rq.y; Q[i * 4 + 2] = _rq.z; Q[i * 4 + 3] = _rq.w;
    const g = (Math.floor(i / ph.W) * ph.W * 3 + (i % ph.W) * 3) * 4;
    G[g] = ws[k]; G[g + 1] = ws[k + 1]; G[g + 2] = ws[k + 2]; G[g + 3] = f === 2 ? 2 : moved ? 1 : 0;
    G[g + 4] = A2[i * 3]; G[g + 5] = A2[i * 3 + 1]; G[g + 6] = A2[i * 3 + 2]; G[g + 7] = 0;
    G[g + 8] = _rq.x; G[g + 9] = _rq.y; G[g + 10] = _rq.z; G[g + 11] = _rq.w;
  }
  for (let i = n; i < ph.n; i++) { const g = (Math.floor(i / ph.W) * ph.W * 3 + (i % ph.W) * 3) * 4; G.fill(0, g, g + 12); G[g + 11] = 1; } // (a root's sentinel: unmoved)
  ph.tex.needsUpdate = true;
}
function parentsFirst(P) { // node ids in an order where every parent comes before its children (not every graph is stored so)
  if (P._pf) return P._pf;
  const kids = plantKids(P), out = [], st = []; for (let i = 0; i < P.n; i++) if (!(P.par[i] >= 0)) st.push(i);
  while (st.length) { const i = st.pop(); out.push(i); for (const c of kids[i]) st.push(c); }
  return (P._pf = Int32Array.from(out));
}
const ownerWs = (o) => o.ph.kind === 'tree' ? treeSegs(o) : o.ph.kind === 'log' ? o.m.segs : o.ph.kind === 'root' ? o.m.ws : plantProxy(o).ws;
function ownerMats(o, tree, conifer) { // per object: the same programs, its own displacement texture
  ownerTex(o, tree ? 'tree' : 'log');
  if (o.ph.mats) return o.ph.mats;
  const bark = new THREE.MeshLambertMaterial({ map: tex.bark, vertexColors: !tree });
  bark.onBeforeCompile = (sh) => { if (tree) { bendPatch(sh); barkStylePatch(sh); } nodePatch(sh, o.ph); }; bark.customProgramCacheKey = () => `actBark${tree ? 1 : 0}`;
  const leaf = foliageMaterial(conifer ? tex.needle : tex.leaf, { alphaTest: conifer ? 0.38 : 0.42, wind: tree ? 0.012 : 0 }), base = leaf.onBeforeCompile;
  leaf.onBeforeCompile = (sh) => { base(sh); if (tree) bendPatch(sh); nodePatch(sh, o.ph); }; leaf.customProgramCacheKey = () => `actFol${tree ? 1 : 0}`;
  return (o.ph.mats = { bark, leaf });
}
function logMesh(r) { // a fallen tree's branches drawn on their own, deforming, while simulated
  if (r.mesh) for (const m of r.mesh) { plantGroup.remove(m); m.geometry.dispose(); }
  const M = r.m, conifer = M.leafKind === 'needle', am = ownerMats(r, false, conifer), out = [];
  const mk = (A, mat) => { const g = arraysGeo(A); g.setAttribute('aNode', new THREE.Float32BufferAttribute(A.node, 1)); const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; plantGroup.add(m); out.push(m); };
  if (M.idx.length) mk(M, am.bark);
  if (M.leaves && M.leaves.idx.length) mk(M.leaves, am.leaf);
  r.mesh = out;
}
function logAssemble() { // the shared buffers hold every fallen tree near you that is not being simulated
  const L = logPick.filter((r) => !r.ph);
  logBuf.assemble(L.map((r) => r.m));
  for (const kind of ['needle', 'leaf']) { const F = L.map((r) => r.m?.leafKind === kind ? r.m.leaves : null); if (F.some(Boolean) || logLeafBuf[kind]) logLeaves(kind).assemble(F); }
}
// closest distance between segments a0-a1 and b0-b1 (arrays of 3), with the parameters
function segSeg(a0, a1, b0, b1) {
  const d1 = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]], d2 = [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]], r = [a0[0] - b0[0], a0[1] - b0[1], a0[2] - b0[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2], e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2], f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let s = 0, t = 0;
  if (a < 1e-9 && e < 1e-9) { s = t = 0; } else if (a < 1e-9) { t = clamp(f / e, 0, 1); } else {
    const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
    if (e < 1e-9) s = clamp(-c / a, 0, 1); else { const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2], den = a * e - b * b; s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0; t = (b * s + f) / e; if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); } }
  }
  const px = a0[0] + d1[0] * s - b0[0] - d2[0] * t, py = a0[1] + d1[1] * s - b0[1] - d2[1] * t, pz = a0[2] + d1[2] * s - b0[2] - d2[2] * t;
  return { d: Math.hypot(px, py, pz), s, t };
}
// How much of the plant world near you is inside the body right now: every body capsule against every plant segment
// within reach, simulated (where the solver has it) or not (rest pose), plus shrubs and seedlings as their volumes.
// A clip is an overlap deeper than 1 cm. This is the measure the physics is meant to drive to zero.
const CAPN = ['thighL', 'shinL', 'thighR', 'shinR', 'torso', 'head', 'upperL', 'foreL', 'upperR', 'foreR'];
function clipScan(depth = 0.01) {
  const C = bodyCapsules(), caps = [];
  for (let c = 0; c < C.length; c += 7) caps.push({ a: [C[c], C[c + 1], C[c + 2]], b: [C[c + 3], C[c + 4], C[c + 5]], r: C[c + 6], name: CAPN[c / 7] });
  const out = { sim: 0, rest: 0, stem: 0, log: 0, plant: 0, root: 0, wood: 0, rock: 0, list: [] }, bx = player.x, bz = player.z;
  let whyNot = '';
  const test = (cat, a0, a1, r, what) => {
    for (const c of caps) { const q = segSeg(c.a, c.b, a0, a1), pen = c.r + r - q.d; if (pen > depth) { out[cat]++; if (out.list.length < 40) out.list.push({ cat, cap: c.name, pen: +pen.toFixed(3), r: +r.toFixed(3), what, why: whyNot }); } }
  };
  const simulated = new Map(); // owner -> Set of nodes
  for (const G of phys.groups.values()) { let s = simulated.get(G.owner); if (!s) simulated.set(G.owner, (s = new Set())); for (const i of G.nodes) s.add(i); }
  const close = (ws, k) => Math.min((ws[k] - bx) ** 2 + (ws[k + 2] - bz) ** 2, (ws[k + 3] - bx) ** 2 + (ws[k + 5] - bz) ** 2) < 9 || ((ws[k] + ws[k + 3]) / 2 - bx) ** 2 + ((ws[k + 2] + ws[k + 5]) / 2 - bz) ** 2 < 9;
  const seg = (o, ws, P, i) => { // current segment: rest plus the solver's displacement where simulated
    if (o.md && o.ph?.xf) { const k = i * 7, X = o.ph.xf, q = new THREE.Quaternion(X.q[i * 4], X.q[i * 4 + 1], X.q[i * 4 + 2], X.q[i * 4 + 3]), v = new THREE.Vector3(ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2]).applyQuaternion(q), a = [X.a2[i * 3], X.a2[i * 3 + 1], X.a2[i * 3 + 2]]; return [a, [a[0] + v.x, a[1] + v.y, a[2] + v.z], o.md.M.nodeB[i] >= 0]; } // modal: where it is drawn
    const k = i * 7, D = o.ph?.data, sim = simulated.get(o)?.has(i), p = P.par[i];
    const e = D ? [D[i * 4], D[i * 4 + 1], D[i * 4 + 2]] : [0, 0, 0], b = D && p >= 0 ? [D[p * 4], D[p * 4 + 1], D[p * 4 + 2]] : [0, 0, 0]; // simulated, or carried by a simulated parent
    return [[ws[k] + b[0], ws[k + 1] + b[1], ws[k + 2] + b[2]], [ws[k + 3] + e[0], ws[k + 4] + e[1], ws[k + 5] + e[2]], sim];
  };
  const ci = Math.floor((bx + HALF) / 16), cj = Math.floor((bz + HALF) / 16);
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((ci + di) * 4096 + cj + dj) || []) {
    if ((rec.x - bx) ** 2 + (rec.z - bz) ** 2 > 225) continue;
    const P = rec.v.P, ws = treeSegs(rec);
    for (let i = 0; i < P.n; i++) { if (rec.gone?.[i] || !close(ws, i * 7)) continue; const [a0, a1, sim] = seg(rec, ws, P, i); whyNot = sim ? '' : `owner ${rec.ph ? 'on' : 'off'} group ${phys.groups.get(physKey(rec))?.nodes.length ?? '-'} total ${phys.nodes} inh ${rec.ph?.data[i * 4 + 3] ?? '-'}`; test(sim ? 'sim' : P.ord[i] === 0 && !(rec.t && rec.t.d < 8) ? 'stem' : 'rest', a0, a1, ws[i * 7 + 6], `tree ${P.ord[i] === 0 ? 'stem' : 'ord' + P.ord[i]} n${i}`); }
  }
  for (const r of logPick) {
    const M = r.m; if (!M || bx < M.box[0] - 3 || bx > M.box[1] + 3 || bz < M.box[2] - 3 || bz > M.box[3] + 3) continue;
    const P = M.v.P;
    for (let i = 0; i < P.n; i++) { if (!(M.segs[i * 7 + 6] > 0) || r.gone?.[i] || !close(M.segs, i * 7)) continue; const [a0, a1, sim] = seg(r, M.segs, P, i); whyNot = sim ? '' : `owner ${r.ph ? 'on' : 'off'} group ${phys.groups.get(physKey(r))?.nodes.length ?? '-'} total ${phys.nodes} ord ${P.ord[i]}`; test(sim ? 'sim' : 'log', a0, a1, M.segs[i * 7 + 6], `fallen n${i}`); }
  }
  for (const it of plantItemsNear(bx, bz, 2.5)) { // shrubs, tall shrubs, herbs, ferns and seedlings: their proxy stems
    const T = plantProxy(it);
    for (let i = 0; i < T.P.n; i++) { if (!close(T.ws, i * 7)) continue; const [a0, a1, sim] = seg(it, T.ws, T.P, i); test(sim ? 'sim' : 'plant', a0, a1, T.ws[i * 7 + 6], it[0] + ' n' + i); }
  }
  for (const r of rootPick) { // roots out of the soil, and wad roots
    const M = r.m; if (!M || (r.x - bx) ** 2 + (r.z - bz) ** 2 > (M.P.rp * 2.5 + 4) ** 2) continue;
    for (let i = 0; i < M.P.n; i++) { if (M.fixed[i] || !close(M.ws, i * 7)) continue; const [a0, a1, sim] = seg(r, M.ws, M.P, i); whyNot = sim ? '' : `owner ${r.ph ? 'on' : 'off'} wad ${M.wad}`; test(sim ? 'sim' : 'root', a0, a1, M.ws[i * 7 + 6], `root${M.wad ? ' (wad)' : ''} n${i}`); }
  }
  if (near?.cells) { // loose wood on the ground: where it lies, or where its body is now
    const ci2 = Math.floor((bx + HALF) / NC), cj2 = Math.floor((bz + HALF) / NC), A = new THREE.Vector3(), B = new THREE.Vector3();
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) for (const it of near.cells.get((ci2 + di) * 4096 + cj2 + dj) || []) {
      if (!BRANCH_R[it[0]] || (it[1] - bx) ** 2 + (it[2] - bz) ** 2 > (it[4] + 2) ** 2) continue;
      if (it._free !== undefined) continue; // a free object now: counted below
      const seg2 = woodSeg(it); whyNot = 'resting'; test('wood', seg2[0], seg2[1], seg2[2], it[0]);
    }
  }
  for (const o of falls.values()) { // free objects (pieces, wood that was moved, logs that came alive): where they are now
    if ((o.x - bx) ** 2 + (o.z - bz) ** 2 > 100) continue; const C = freeCaps(o);
    for (let c = 0; c < C.length; c += 7) { whyNot = o.awake ? 'moving' : 'resting'; test('wood', [C[c], C[c + 1], C[c + 2]], [C[c + 3], C[c + 4], C[c + 5]], C[c + 6], 'free ' + o.id); }
  }
  for (const c of caps) for (const f of [0, 0.5, 1]) { // rocks and stumps: below their top surface
    const px = c.a[0] + (c.b[0] - c.a[0]) * f, py = c.a[1] + (c.b[1] - c.a[1]) * f, pz = c.a[2] + (c.b[2] - c.a[2]) * f;
    for (const so of solids.get(ckey8(px, pz)) || []) {
      if (so.kind !== 'mesh' || px < so.x0 || px > so.x1 || pz < so.z0 || pz > so.z1) continue;
      const top = topOf(so, px, pz), pen = top - (py - c.r); if (top === -Infinity || pen <= depth || pen > 0.6) continue;
      out.rock++; if (out.list.length < 40) out.list.push({ cat: 'rock', cap: c.name, pen: +pen.toFixed(3), what: so.big !== undefined ? 'outcrop' : 'rock/stump' });
    }
  }
  return out;
}
// ---- modal plants (MD): every plant segment near you is a branch of a cantilever mode (see modal.js). Drawn with the same
// per-segment turn texture as before; its push-back on the body goes where the rods' did (force, per capsule force, contact
// point, the overlap the body takes). Plants with a branch hanging or broken off stay modal for good.
const modal = { owners: new Set(), t: 1, ms: 0, out: null };
function modalSpec(o, kind) {
  if (kind === 'tree') { const P = o.v.P, sap = o.t && o.t.d < 8, w = PL.ARCH[o.v.sp].wood; return { P, ws: treeSegs(o), valid: (i) => !o.gone?.[i], fixed: sap ? () => false : (i) => P.ord[i] === 0, E: w.E, MOR: w.MOR, dry: (i) => P.st[i] !== PL.LIVE, leafy: 1 }; }
  if (kind === 'log') { const M = o.m, P = M.v.P, w = PL.ARCH[o.t.sp].wood; return { P, ws: M.segs, valid: (i) => M.segs[i * 7 + 6] > 0 && !o.gone?.[i], fixed: (i) => P.ord[i] === 0, E: w.E, MOR: w.MOR, dry: (i) => M.T > 1 || P.st[i] !== PL.LIVE, leafy: M.T < 3 ? 0.5 : 0 }; }
  if (kind === 'root') { const M = o.m, w = PL.ARCH[o.t.sp].wood; return { P: M.P, ws: M.ws, valid: (i) => !M.fixed[i], fixed: (i) => !!M.fixed[i] || !!M.pin?.[i], E: w.E, MOR: w.MOR, dry: () => false, leafy: 0 }; }
  const T = plantProxy(o), w = PLANT_WOOD[o[0]]; return { P: T.P, ws: T.ws, valid: (i) => !o.gone?.[i], fixed: () => false, E: w.E, MOR: w.MOR, dry: () => false, leafy: 1.5, give: 6 };
}
function modalOn(o, kind) {
  if (o.md) return o.md;
  const sp = modalSpec(o, kind);
  const M = MD.build(sp.P, sp.ws, { valid: sp.valid, fixed: sp.fixed, E: sp.E * 1e9, MOR: sp.MOR * 1e6, rho: 800, dry: sp.dry, leafy: sp.leafy, give: sp.give, zeta: kind === 'plant' ? 0.15 : 0.1 });
  physOwnerOn(o, kind); const ph = o.ph; ph.xf = ph.xf || { a2: new Float32Array(sp.P.n * 3), q: new Float32Array(sp.P.n * 4) };
  o.md = { M, kind, X: { a2: ph.xf.a2, q: ph.xf.q, D: ph.data }, near: 0 }; modal.owners.add(o);
  MD.pose(M, sp.P, sp.ws, o.md.X, o.gone); modalUpload(o);
  return o.md;
}
function modalOff(o) { modal.owners.delete(o); o.md = null; if (o.ph) physOwnerOff(o); }
function modalLost(o) { modal.owners.delete(o); o.md = null; }
function modalUpload(o) { // the per-segment turn texture (layout as in rodPatch: base, flag; carried base; turn)
  const ph = o.ph, X = o.md.X, G = ph.gdata, ws = ownerWs(o), P = ownerP(o), n = Math.min(P.n, ws.length / 7);
  for (let i = 0; i < ph.n; i++) { const g = (Math.floor(i / ph.W) * ph.W * 3 + (i % ph.W) * 3) * 4;
    if (i >= n) { G.fill(0, g, g + 12); G[g + 11] = 1; continue; }
    G[g] = ws[i * 7]; G[g + 1] = ws[i * 7 + 1]; G[g + 2] = ws[i * 7 + 2]; G[g + 3] = X.D[i * 4 + 3];
    G[g + 4] = X.a2[i * 3]; G[g + 5] = X.a2[i * 3 + 1]; G[g + 6] = X.a2[i * 3 + 2]; G[g + 7] = 0;
    G[g + 8] = X.q[i * 4]; G[g + 9] = X.q[i * 4 + 1]; G[g + 10] = X.q[i * 4 + 2]; G[g + 11] = X.q[i * 4 + 3]; }
  ph.tex.needsUpdate = true;
}
function modalActivate(dt) { // every plant with a segment within reach of the body (or of a falling piece) becomes modal; quiet ones far off stop
  if ((modal.t += dt) < 0.2) return; modal.t = 0;
  const C = bodyCapsules(), box = capBox(C, 1.8), bx = player.x, bz = player.z, now = performance.now();
  const near = (ws) => { for (let k = 0; k < ws.length; k += 7) { const r = ws[k + 6]; if (Math.max(ws[k], ws[k + 3]) + r >= box[0] && Math.min(ws[k], ws[k + 3]) - r <= box[1] && Math.max(ws[k + 1], ws[k + 4]) + r >= box[2] && Math.min(ws[k + 1], ws[k + 4]) - r <= box[3] && Math.max(ws[k + 2], ws[k + 5]) + r >= box[4] && Math.min(ws[k + 2], ws[k + 5]) - r <= box[5]) return true; } return false; };
  const want = (o, kind, ws) => { if (!near(ws)) return; modalOn(o, kind).near = now; };
  const ci = Math.floor((bx + HALF) / 16), cj = Math.floor((bz + HALF) / 16);
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((ci + di) * 4096 + cj + dj) || []) {
    const sap = rec.t && rec.t.d < 8, reach = sap ? 4 : rec.v.crRep * (rec.m[0] ** 2 + rec.m[2] ** 2) ** 0.5 / rec.v.hRep + 3;
    if ((rec.x - bx) ** 2 + (rec.z - bz) ** 2 > reach * reach) continue; want(rec, 'tree', treeSegs(rec));
  }
  for (const r of logPick) { const M = r.m; if (!M || bx < M.box[0] - 3 || bx > M.box[1] + 3 || bz < M.box[2] - 3 || bz > M.box[3] + 3) continue; want(r, 'log', M.segs); }
  for (const it of plantItemsNear(bx, bz, 2.5)) want(it, 'plant', plantProxy(it).ws);
  for (const r of rootPick) { const M = r.m; if (!M || (r.x - bx) ** 2 + (r.z - bz) ** 2 > (M.P.rp * 2.5 + 4) ** 2) continue; want(r, 'root', M.ws); }
  if (pushState.on && pushState.rod && !pushState.rod.owner.md) modalOn(pushState.rod.owner, pushState.rod.kind);
  for (const o of [...modal.owners]) { const M = o.md.M; if (now - o.md.near < 3000 || M.awake.some((a) => a) || M.hinge.some((h) => h) || o.gone) continue; modalOff(o); }
}
const BODY_PUSH = 200, BODY_TOTAL = 300; // the most a body part can push a branch aside with (N); beyond that it is you that yields
function modalStep(dt, caps) {
  const n = caps.length / 7, F = [0, 0, 0], CF = new Float32Array(n * 3), CP = new Float32Array(n * 7), CD = new Float32Array(n * 4), prev = phys.prevCaps && phys.prevCaps.length === caps.length ? phys.prevCaps : caps;
  const capV = new Float32Array(n * 3); for (let c = 0; c < n; c++) for (let d = 0; d < 3; d++) capV[c * 3 + d] = (caps[c * 7 + d] + caps[c * 7 + 3 + d] - prev[c * 7 + d] - prev[c * 7 + 3 + d]) / 2 / Math.max(dt, 1e-3);
  const box = capBox(caps, 0.05), pieces = [];
  for (const f of falls.values()) if (f.awake && (f.x - player.x) ** 2 + (f.z - player.z) ** 2 < 900) pieces.push(freeCaps(f)); // falling pieces push branches aside too (they feel nothing back yet)
  let awake = 0, hits = 0; const bud1 = { left: BODY_TOTAL }, bud2 = { left: BODY_TOTAL }; // the whole body pushes with at most BODY_TOTAL
  for (const o of [...modal.owners]) {
    if (!o.md || !o.ph) { modalLost(o); continue; }
    const md = o.md, M = md.M, P = ownerP(o), ws = ownerWs(o), X = md.X;
    if (pushState.on && pushState.rod && pushState.rod.owner === o) MD.force(M, X, pushState.rod.node, pushState.F);
    const aw = MD.step(M, dt); awake += aw;
    let moved = aw > 0;
    if (moved) MD.pose(M, P, ws, X, o.gone);
    let h = MD.contact(M, P, ws, X, caps, capV, BODY_PUSH, null, null, null, box, bud1); // passes until the branches clear: moving a parent turns what hangs off it, so the
    for (let pass = 0; h && pass < 2; pass++) { MD.pose(M, P, ws, X, o.gone); h = MD.contact(M, P, ws, X, caps, capV, BODY_PUSH, null, null, null, box, { left: BODY_TOTAL }); } // linear share is only close
    if (h) { MD.pose(M, P, ws, X, o.gone); h = MD.contact(M, P, ws, X, caps, capV, BODY_PUSH, CF, CP, CD, box, bud2); } hits += h; // the last pass: what the body feels and must take
    for (const pc of pieces) if (MD.contact(M, P, ws, X, pc, null, 150, null, null, null, capBox(pc, 0.05))) moved = true;
    if (h) moved = true;
    for (const br of MD.breaks(M, PH.BREAK_R ?? 0.015)) { // the load at a branch's base beat its wood: small and dry snaps off, anything else gives way and hangs
      if (!br.clean) { moved = true; continue; }
      MD.remove(M, P, br.node);
      if (md.kind === 'tree') breakBranch(o, br.node); else if (md.kind === 'log') logBreak(o, br.node, true); else breakOff(o, md.kind, br.node);
      moved = true; if (!o.md) break;
    }
    if (!o.md || !o.ph) continue;
    if (moved) { MD.pose(M, P, ws, X, o.gone); modalUpload(o); }
  }
  for (let c = 0; c < n; c++) { F[0] += CF[c * 3]; F[1] += CF[c * 3 + 1]; F[2] += CF[c * 3 + 2]; }
  modal.out = { force: F, capF: CF, capP: CP, capD: CD }; modal.awake = awake; modal.hits = hits; phys.nodes = awake;
}
function modalCombine() { // the plants' push-back plus the free objects' (from the worker's last step)
  const a = modal.out, b = phys.freeOut;
  if (!a && !b) { phys.force = [0, 0, 0]; phys.capF = null; phys.capP = null; return; }
  if (!b) { phys.force = a.force; phys.capF = a.capF; phys.capP = a.capP; phys.capD = a.capD; phys.capDnew = true; return; }
  if (!a) { phys.force = b.force; phys.capF = b.capF; phys.capP = b.capP; phys.capD = b.capD; phys.capDnew = true; return; }
  phys.force = [0, 1, 2].map((d) => a.force[d] + b.force[d]); phys.capF = a.capF.map((v, i) => v + (b.capF[i] || 0));
  phys.capP = Float32Array.from(a.capP); for (let c = 0; c < phys.capP.length / 7; c++) if ((b.capP[c * 7 + 6] || 0) > phys.capP[c * 7 + 6]) phys.capP.set(b.capP.subarray(c * 7, c * 7 + 7), c * 7);
  phys.capD = a.capD.map((v, i) => v + (b.capD?.[i] || 0)); for (let c = 0; c < phys.capD.length / 4; c++) phys.capD[c * 4 + 3] = Math.hypot(phys.capD[c * 4], phys.capD[c * 4 + 1], phys.capD[c * 4 + 2]); phys.capDnew = true;
}
function physStep(dt) {
  if (!phys.core && !phys.worker) physReset();
  const caps = bodyCapsules(); setBodyCaps(caps);
  woodWake(caps); logWake(dt);
  const t0 = performance.now(); modalActivate(dt); modalStep(dt, caps); modal.ms = performance.now() - t0;
  if (![...falls.values()].some((o) => o.awake || (o.x - player.x) ** 2 + (o.z - player.z) ** 2 < 100)) { phys.freeOut = null; modalCombine(); phys.ms = 0; phys.prevCaps = caps; return; }
  const prev = phys.prevCaps && phys.prevCaps.length === caps.length ? phys.prevCaps : caps, forces = freeForces();
  if (phys.worker) {
    if (phys.pending) { phys.acc += dt; return; } // the sweep then covers every frame since the last step
    phys.pending = true; phys.worker.postMessage({ type: 'step', dt: dt + phys.acc, caps, prev, kb: bodyKb(), mb: bodyMb(), forces }); phys.acc = 0;
  } else physState(phys.core.step(dt, caps, prev, bodyKb(), bodyMb(), forces));
  phys.prevCaps = caps;
}
// Point forces on free objects this step: each planted foot standing on one presses it with its share of your weight
// (the foot then rides on it), and a push (pushState) acts at the hands' contact.
function freeForces() {
  const out = [], stance = rig.over ? [] : body.feet.filter((f) => f.t >= 1), carry = [0, 0, 0];
  if (rig.over) for (const c of body.overContacts || []) if (c.o !== 'ground' && c.o.free !== undefined) out.push({ id: c.o.free, b: c.o.fb, p: c.p, F: [0, -c.F, 0] }); // (a way over: its planted hands and feet press what they rest on)
  for (const ft of stance) {
    let best = null, bd = Infinity; const was = ft.onFree;
    for (const so of solids.get(ckey8(ft.x, ft.z)) || []) {
      if (so.free === undefined) continue; const t = topOf(so, ft.x, ft.z); if (t === -Infinity) continue;
      const same = was && so.free === was.free && so.fb === was.fb, d = Math.abs(t - ft.y);
      if (same ? d < 0.6 : t < ft.y + 0.08 && t > ft.y - 0.3) { const sc = same ? d - 1 : d; if (sc < bd) { bd = sc; best = so; } } // a foot stays on what it stands on as that moves
    }
    ft.onFree = best;
    if (best) {
      const o = falls.get(best.free), b = best.fb;
      if (o) { // the foot rides on it: held where it was planted in the body's own frame (static friction), carried as it moves
        const X = o.f.bx, Q = o.f.bq, q = new THREE.Quaternion(Q[b * 4], Q[b * 4 + 1], Q[b * 4 + 2], Q[b * 4 + 3]);
        if (!ft.ride || ft.ride.id !== o.id || ft.ride.b !== b) { const l = new THREE.Vector3(ft.x - X[b * 3], ft.y - X[b * 3 + 1], ft.z - X[b * 3 + 2]).applyQuaternion(q.clone().invert()); ft.ride = { id: o.id, b, l }; }
        const w = ft.ride.l.clone().applyQuaternion(q), nx = X[b * 3] + w.x, ny = X[b * 3 + 1] + w.y, nz = X[b * 3 + 2] + w.z;
        carry[0] += nx - ft.x; carry[1] += nz - ft.z; carry[2]++;
        ft.x = ft.tx = nx; ft.y = ft.ty = ny; ft.z = ft.tz = nz;
      }
      out.push({ id: best.free, b: best.fb, p: [ft.x, ft.y, ft.z], F: [0, -BODY_N / stance.length, 0] });
    } else ft.ride = null;
  }
  for (const ft of body.feet) if (ft.t < 1) ft.ride = null;
  if (carry[2]) { player.x += carry[0] / carry[2]; player.z += carry[1] / carry[2]; } // you go where your planted feet are carried
  if (pushState.on && pushState.p) {
    if (pushState.free) out.push({ id: pushState.free.id, b: pushState.free.b, p: pushState.p, F: pushState.F });
    else if (pushState.rod) { const G = phys.groups.get(physKey(pushState.rod.owner)), j = G ? G.nodes.indexOf(pushState.rod.node) : -1; if (j >= 0) out.push({ gid: G.id, j, F: pushState.F }); }
  }
  return out;
}
function physState(st) {
  phys.pending = false; phys.freeOut = st.capF && st.capF.length >= CAP.n * 3 ? { force: st.force, capF: st.capF, capP: st.capP, capD: st.capD } : null; modalCombine(); phys.ms = st.ms; phys.nodes = st.nodes; phys.hits = (phys.hits || 0) + (st.hits || 0);
  freeUpdate(st);
  const byId = new Map(); for (const [key, G] of phys.groups) byId.set(G.id, [key, G]);
  const breaks = [];
  for (const res of st.groups) {
    const e = byId.get(res.id); if (!e) continue;
    const [key, G] = e, o = G.owner; if (!o.ph) continue;
    const D = o.ph.data;
    G.nodes.forEach((i, j) => { D[i * 4] = res.disp[j * 3]; D[i * 4 + 1] = res.disp[j * 3 + 1]; D[i * 4 + 2] = res.disp[j * 3 + 2]; });
    inheritDisp(o); ownerUpload(o); G.asleep = res.sleep; G.hinged = res.hinged;
    for (const j of res.breaks) breaks.push([G, G.nodes[j]]);
  }
  for (const [G, node] of breaks) { // overstrained: snapped
    if (!phys.groups.has(G.key)) continue;
    if (G.kind === 'plant' || G.kind === 'root') { if (!G.owner.gone?.[node]) breakOff(G.owner, G.kind, node); }
    else if (G.kind === 'tree') { if (!G.owner.gone?.[node]) breakBranch(G.owner, node); }
    else if (!G.owner.gone?.[node]) logBreak(G.owner, node, G.owner.m.segs[node * 7 + 6] > 0.01);
  }
}
// segments that are not simulated but hang off simulated ones move with their parent; the rest stay at rest
const ownerP = (o) => o.ph.kind === 'tree' ? o.v.P : o.ph.kind === 'log' ? o.m.v.P : o.ph.kind === 'root' ? o.m.P : plantProxy(o).P;
function inheritDisp(o) {
  const P = ownerP(o), D = o.ph.data, sim = o.ph.sim;
  for (let i = 0; i < P.n; i++) {
    if (o.gone?.[i]) { D[i * 4 + 3] = 2; continue; } // broken off: not drawn
    if (sim[i]) continue; const p = P.par[i];
    if (p >= 0 && (sim[p] || sim[p] === 2 || D[p * 4 + 3] === 1)) { D[i * 4] = D[p * 4]; D[i * 4 + 1] = D[p * 4 + 1]; D[i * 4 + 2] = D[p * 4 + 2]; D[i * 4 + 3] = 1; }
    else { D[i * 4] = D[i * 4 + 1] = D[i * 4 + 2] = 0; D[i * 4 + 3] = 0; }
  }
}
// a branch pushes back on the body; walking cannot push harder than about 250 N, so a branch that resists more than
// that, before it bends far enough or breaks, stops you (you go round, duck, or climb instead)
function physResist(f, s) {
  const F = phys.force; if (!F || (Math.abs(f) + Math.abs(s)) < 0.05) return 1;
  const Y = player.yaw, dx = -Math.sin(Y) * f + Math.cos(Y) * s, dz = -Math.cos(Y) * f - Math.sin(Y) * s, l = Math.hypot(dx, dz) || 1;
  const back = -(F[0] * dx + F[2] * dz) / l;
  return back < 60 ? 1 : clamp(1 - (back - 60) / 190, 0, 1);
}
// ---- fallen trees keep their branches for a while. The graph of a tree this size turns with the stem; limbs driven
// into the ground are crushed (cut where they meet it, leaving the part above); the rest are dead and shed over
// years: shoots first, thin limbs next, thick limbs last, leaving stubs. Thick ones are solid.
class MergeBuf { // one reusable, growing buffer for many small meshes near the player (roots, log branches)
  constructor(mat) { this.mat = mat; this.capV = 0; this.capI = 0; this.mesh = null; }
  assemble(list) {
    let nv = 0, ni = 0; for (const M of list) if (M) { nv += M.pos.length / 3; ni += M.idx.length; }
    if (!this.mesh || this.capV < nv || this.capI < ni) {
      this.capV = Math.max(4096, 1 << Math.ceil(Math.log2(nv + 1))); this.capI = Math.max(8192, 1 << Math.ceil(Math.log2(ni + 1)));
      if (this.mesh) { plantGroup.remove(this.mesh); this.mesh.geometry.dispose(); }
      const g = new THREE.BufferGeometry(), A = (n, k) => new THREE.BufferAttribute(new Float32Array(n * k), k).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', A(this.capV, 3)); g.setAttribute('normal', A(this.capV, 3)); g.setAttribute('uv', A(this.capV, 2)); g.setAttribute('color', A(this.capV, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.capI), 1).setUsage(THREE.DynamicDrawUsage));
      this.mesh = new THREE.Mesh(g, this.mat); this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false; plantGroup.add(this.mesh);
    }
    const g = this.mesh.geometry, P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv.array, C = g.attributes.color.array, I = g.index.array;
    let v = 0, k = 0;
    for (const M of list) { if (!M) continue; P.set(M.pos, v * 3); N.set(M.nor, v * 3); U.set(M.uv, v * 2); C.set(M.col, v * 3); for (let q = 0; q < M.idx.length; q++) I[k + q] = M.idx[q] + v; v += M.pos.length / 3; k += M.idx.length; }
    for (const at of [g.attributes.position, g.attributes.normal, g.attributes.uv, g.attributes.color]) { at.clearUpdateRanges(); at.addUpdateRange(0, v * at.itemSize); at.needsUpdate = true; }
    g.index.clearUpdateRanges(); g.index.addUpdateRange(0, k); g.index.needsUpdate = true; g.setDrawRange(0, k); this.mesh.visible = k > 0;
  }
}
const logBuf = new MergeBuf(mats.root), logLeafBuf = { needle: null, leaf: null };
function logLeaves(kind) { // dead foliage on fresh fallen trees: one buffer per foliage texture, created on first use
  return logLeafBuf[kind] || (logLeafBuf[kind] = new MergeBuf(kind === 'needle' ? mats.needleStill : mats.leafStill));
}
function fullBark(v) { // a fallen tree shows all its twigs (standing trees hide the thinnest in their foliage)
  if (v.full) return v.full;
  const B = PL.barkMesh(v.P, { minR: 0 }), idx = B.idx, node = B.node;
  return (v.full = { pos: B.pos, nor: B.nor, uv: B.uv, idx, node });
}
function logBranches(t, gone = null) {
  const q = t.rest.pieces[0], L = Math.hypot(q.x1 - q.x0, q.y1 - q.y0, q.z1 - q.z0), rnd = mulberry32(hash3(Math.round(t.x * 10), Math.round(t.z * 10), 113));
  const v = plantVariant(t.sp, plantClass(Math.max(1, t.d)), 1, rnd() < 0.5 ? 0 : 1), P = v.P, s = L / v.hRep, T = t.t;
  const a = new THREE.Vector3(q.x1 - q.x0, q.y1 - q.y0, q.z1 - q.z0).normalize(), e1 = new THREE.Vector3().crossVectors(a, new THREE.Vector3(0, 1, 0)).normalize(), e2 = new THREE.Vector3().crossVectors(e1, a);
  const ph = rnd() * 6.283, X = e1.clone().multiplyScalar(Math.cos(ph)).addScaledVector(e2, Math.sin(ph)), Z = e1.clone().multiplyScalar(-Math.sin(ph)).addScaledVector(e2, Math.cos(ph));
  const W3 = (x, y, z) => [q.x0 + s * (x * X.x + y * a.x + z * Z.x), q.y0 + s * (x * X.y + y * a.y + z * Z.y), q.z0 + s * (x * X.z + y * a.z + z * Z.z)];
  const keep = new Uint8Array(P.n);
  for (let i = 0; i < P.n; i++) {
    const leader = P.ord[i] === 0 && P.axis[i] !== 0; // co-dominant leaders above a fork are part of the crown that fell
    if (P.ord[i] < 1 && !leader) continue;
    const par = P.par[i]; if (par >= 0 && (P.ord[par] >= 1 || P.axis[par] !== 0) && !keep[par]) continue; // its parent is gone
    const first = par < 0 || P.ord[par] < P.ord[i] || P.axis[par] !== P.axis[i];
    const r = P.r0[i] * s, b = W3(P.p1[i * 3], P.p1[i * 3 + 1], P.p1[i * 3 + 2]);
    if (b[1] < ground(b[0], b[2]) - 0.35) continue; // driven into the ground: crushed (a limb lying along the ground dips in a little)
    if (first && !leader) { // does this branch survive the years since the fall?
      const life = P.ord[i] >= 2 ? 4 : r < 0.02 ? 7 : r < 0.05 ? 14 : 30, alive = T < life * (0.6 + 0.8 * rnd());
      if (!alive) { if (r > 0.02 && rnd() < 0.7) keep[i] = 2; continue; } // shed: a stub, its first segment, may remain
    } else if (keep[par] === 2) continue; // stubs are one segment long
    keep[i] = keep[par] === 2 ? 0 : 1;
  }
  if (gone) for (let i = 0; i < P.n; i++) if (gone[i]) keep[i] = 0; // broken off or snapped since
  const out = { pos: [], nor: [], uv: [], col: [], idx: [], node: [], solids: [], segs: new Float32Array(P.n * 7), v, s, W3, X, a, Z, T }, src = fullBark(v), I = src.idx, N = src.node, Ps = src.pos, Ns = src.nor, U = src.uv, map = new Map();
  const tint = mix3(TINT.bark[t.sp], [0.55, 0.50, 0.44], clamp(T / 15, 0.3, 0.8));
  for (let k = 0; k < I.length; k += 3) {
    if (!keep[N[I[k]]] || !keep[N[I[k + 1]]] || !keep[N[I[k + 2]]]) continue;
    for (let c = 0; c < 3; c++) {
      const vi = I[k + c]; let o = map.get(vi);
      if (o === undefined) {
        o = out.pos.length / 3; map.set(vi, o);
        const w = W3(Ps[vi * 3], Ps[vi * 3 + 1], Ps[vi * 3 + 2]); out.pos.push(...w); out.node.push(N[vi]); // full bark is in plant metres
        const nx = Ns[vi * 3], ny = Ns[vi * 3 + 1], nz = Ns[vi * 3 + 2]; out.nor.push(nx * X.x + ny * a.x + nz * Z.x, nx * X.y + ny * a.y + nz * Z.y, nx * X.z + ny * a.z + nz * Z.z);
        out.uv.push(U[vi * 2], U[vi * 2 + 1]); out.col.push(lin(tint[0]) * 2, lin(tint[1]) * 2, lin(tint[2]) * 2);
      }
      out.idx.push(o);
    }
  }
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let i = 0; i < P.n; i++) { // world segments (for aiming and brush) and, for the thicker ones, solids
    if (!keep[i]) continue;
    const r0 = P.r0[i] * s, r1 = Math.max(0.006, P.r1[i] * s);
    const A0 = W3(P.p0[i * 3], P.p0[i * 3 + 1], P.p0[i * 3 + 2]), B0 = W3(P.p1[i * 3], P.p1[i * 3 + 1], P.p1[i * 3 + 2]);
    out.segs.set([...A0, ...B0, r0], i * 7);
    bx0 = Math.min(bx0, A0[0], B0[0]); bx1 = Math.max(bx1, A0[0], B0[0]); bz0 = Math.min(bz0, A0[2], B0[2]); bz1 = Math.max(bz1, A0[2], B0[2]);
    if (r0 >= 0.02 || (r0 >= BRANCH_R_MIN && Math.min(A0[1], B0[1]) - ground((A0[0] + B0[0]) / 2, (A0[2] + B0[2]) / 2) <= BRANCH_LOW)) out.solids.push({ kind: 'log', branch: true, node: i, x: (A0[0] + B0[0]) / 2, z: (A0[2] + B0[2]) / 2, x0: A0[0], z0: A0[2], x1: B0[0], z1: B0[2], ya0: A0[1], ya1: B0[1], r: Math.max(r0, r1), r0, r1, rz0: r0, rz1: r1, reach: Math.hypot(B0[0] - A0[0], B0[2] - A0[2]) / 2 + r0 });
  }
  out.box = [bx0, bx1, bz0, bz1];
  // foliage while it lasts: green in the first year, rust-brown to about the third, then gone
  if (T < 3) {
    const lf = { pos: [], nor: [], uv: [], col: [], idx: [], node: [] }, G = v.leafGeo, LI = G.index.array, LN = G.attributes.aNode.array, LP = G.attributes.position.array, LNr = G.attributes.normal.array, LU = G.attributes.uv.array, LC = G.attributes.color.array, lmap = new Map();
    const green = TINT.leaf[t.sp], brown = !isConifer(t.sp) ? [0.62, 0.45, 0.28] : [0.66, 0.40, 0.24], tt = clamp((T - 0.5) / 1.5, 0, 1);
    const tc = mix3(green, [brown[0] * 2.6, brown[1] * 2.2, brown[2] * 2.1], tt); // relative to the green texture: rust needs red pushed up, not everything pushed down
    for (let k = 0; k < LI.length; k += 3) {
      if (!keep[LN[LI[k]]] || !keep[LN[LI[k + 1]]] || !keep[LN[LI[k + 2]]] || keep[LN[LI[k]]] === 2 || (T > 1.5 && hash3(k, LN[LI[k]], 7) % 1000 < (T - 1.5) * 500)) continue; // thinning as it drops (hashed, so a rebuild after a break keeps the same leaves)
      for (let c = 0; c < 3; c++) {
        const vi = LI[k + c]; let o = lmap.get(vi);
        if (o === undefined) {
          o = lf.pos.length / 3; lmap.set(vi, o);
          lf.pos.push(...W3(LP[vi * 3] * v.hRep, LP[vi * 3 + 1] * v.hRep, LP[vi * 3 + 2] * v.hRep)); lf.node.push(LN[vi]);
          const nx = LNr[vi * 3], ny = LNr[vi * 3 + 1], nz = LNr[vi * 3 + 2], wx = nx * X.x + ny * a.x + nz * Z.x, wy = nx * X.y + ny * a.y + nz * Z.y + 1.4, wz = nx * X.z + ny * a.z + nz * Z.z, wl = Math.hypot(wx, wy, wz); lf.nor.push(wx / wl, wy / wl, wz / wl); // the crown's soft normals, re-aimed at the sky now it lies on its side
          lf.uv.push(LU[vi * 2], LU[vi * 2 + 1]); lf.col.push(LC[vi * 3] * tc[0], LC[vi * 3 + 1] * tc[1], LC[vi * 3 + 2] * tc[2]);
        }
        lf.idx.push(o);
      }
    }
    out.leaves = lf; out.leafKind = isConifer(t.sp) ? 'needle' : 'leaf';
  }
  out.keep = keep;
  return out;
}
// the roots that tore out with a fallen tree's plate: its root graph, turned up about the plate's hinge so the stem's
// axis lies along the fall; laterals snap off at the plate rim; fine roots rot away first
function wadRoots(out, t, cx, cy, cz, dx, dz, pr, pf) {
  const R = PL.growRoots({ sp: t.sp, d: t.d, seed: hash3(Math.round(t.x * 10), Math.round(t.z * 10), 57), ...rootSite(t) });
  const k = [dz, 0, -dx]; // rotation axis: horizontal, across the fall; turns up (0,1,0) onto (dx, 0, dz)
  const rot = (x, y, z) => { const c = 0, s = 1, kv = [k[1] * z - k[2] * y, k[2] * x - k[0] * z, k[0] * y - k[1] * x], kd = (k[0] * x + k[1] * y + k[2] * z) * (1 - c); return [x * c + kv[0] * s + k[0] * kd, y * c + kv[1] * s + k[1] * kd, z * c + kv[2] * s + k[2] * kd]; };
  const keep = (i) => Math.hypot(R.p0[i * 3], R.p0[i * 3 + 2]) < pr * (0.9 + 0.3 * pf) && (R.ord[i] !== -2 || pf > 0.5);
  const M = PL.rootMesh(R, (x, y, z) => { const q = rot(x, y - 0.1, z); return [cx + q[0], cy + q[1], cz + q[2], -Infinity]; }, { keep, all: true, flat: 0.85 });
  const base = out.pos.length / 3, tint = ROOT_TINT[t.sp];
  for (const v of M.pos) out.pos.push(v); for (const v of M.nor) out.nor.push(v); for (const v of M.uv) out.uv.push(v);
  for (let i = 0; i < M.col.length; i++) out.col.push(0.75 * tint[i % 3] * 1.6);
  for (const i of M.idx) out.idx.push(i + base);
  (out.base || (out.base = [])); for (let v = 0; v < M.pos.length / 3; v++) out.base.push(cx, cz);
}

// ---------------------------------------------------------------- world build
let W = null;          // world data from worldgen
let worldGroup = null; // all meshes for the current world
let tiles = [];        // {group, cx, cz}
let near = null;       // near-field scatter batches
let colTrunks = null, colLogs = null, logCells = null, pieceCells = new Map(), solidSink = null;
const ground = (x, z) => sampleGrid(W.HF, NF, x, z);
const LITH = { granite: { kind: 'angular', round: 0.5, col: [0.50, 0.48, 0.46], bed: 0, lichen: [0.66, 0.68, 0.56] }, sandstone: { kind: 'slab', round: 0.2, col: [0.58, 0.48, 0.37], bed: 1, lichen: [0.70, 0.66, 0.50] }, basalt: { kind: 'angular', round: 0.08, col: [0.30, 0.30, 0.29], bed: 0, lichen: [0.62, 0.66, 0.52] } };
let hfTex = null, hcTex = null, ecoATex = null, ecoBTex = null, nearTerrain = null;

const TINT = {
  leaf: [[0.80, 0.86, 0.70], [0.86, 0.90, 0.62], [0.78, 0.92, 0.66], [0.98, 1.0, 0.70], [0.66, 0.78, 0.74], [0.74, 0.80, 0.52], [0.94, 1.02, 0.62],
    [1.02, 1.06, 0.62], [0.62, 0.74, 0.70], [0.80, 0.90, 0.62], [0.84, 0.94, 0.66], [0.84, 0.92, 0.62], [0.86, 0.94, 0.92], [0.66, 0.76, 0.58], [0.74, 0.86, 0.60], [0.72, 0.84, 0.60], [0.96, 1.04, 0.70], [0.62, 0.72, 0.66]], // willow, juniper, cherry, rowan, plane, olive (silvery), cork oak, stone pine, strawberry tree, larch, bristlecone   // per species (fir, pine, maple, birch, spruce: blue-green, oak: dark, aspen: bright yellow-green)
  bark: [[0.48, 0.40, 0.35], [0.62, 0.44, 0.33], [0.55, 0.52, 0.48], [0.96, 0.94, 0.90], [0.50, 0.38, 0.32], [0.40, 0.38, 0.35], [0.84, 0.86, 0.76],
    [0.46, 0.42, 0.37], [0.62, 0.46, 0.38], [0.56, 0.34, 0.30], [0.62, 0.62, 0.60], [0.76, 0.74, 0.62], [0.56, 0.55, 0.52], [0.78, 0.68, 0.56], [0.66, 0.44, 0.34], [0.80, 0.36, 0.24], [0.60, 0.42, 0.34], [0.86, 0.80, 0.70]], // ... bristlecone: silver deadwood // spruce: scaly red-brown, oak: dark furrowed grey, aspen: greenish white
};
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function dataTex(data, n, format, type, filter) {
  const t = new THREE.DataTexture(data, n, n, format, type);
  t.minFilter = t.magFilter = filter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
function buildTextures() {
  for (const t of [hfTex, hcTex, ecoATex, ecoBTex]) t?.dispose();
  hfTex = dataTex(W.HF, NF, THREE.RedFormat, THREE.FloatType, THREE.NearestFilter);
  hcTex = dataTex(W.H, N, THREE.RedFormat, THREE.FloatType, THREE.NearestFilter);
  const A = new Uint8Array(N * N * 4), B = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = i * CELL - HALF, z = j * CELL - HALF, q = (n) => Math.round(clamp(n, 0, 1) * 255);
    A[k * 4] = q(W.wet[k]); A[k * 4 + 1] = q(sampleGrid(W.light, W.LN, x, z)); A[k * 4 + 2] = q(sampleGrid(W.conShare, W.LN, x, z)); A[k * 4 + 3] = q(W.rock[k]);
    B[k * 4] = q(W.stream[k]); B[k * 4 + 1] = q(W.soil[k]); B[k * 4 + 3] = 255;
  }
  ecoATex = dataTex(A, N, THREE.RGBAFormat, THREE.UnsignedByteType, THREE.LinearFilter);
  ecoBTex = dataTex(B, N, THREE.RGBAFormat, THREE.UnsignedByteType, THREE.LinearFilter);
  Object.assign(terrainU, {}); terrainU.uHF.value = hfTex; terrainU.uHC.value = hcTex; terrainU.uEcoA.value = ecoATex; terrainU.uEcoB.value = ecoBTex;
  const L = LITH[W.opt.geology] || LITH.granite;
  terrainU.uStone.value.setRGB(L.col[0], L.col[1], L.col[2]);
  rockU.uBedding.value = L.bed; rockU.uPits.value = W.opt.geology === 'basalt' ? 1 : 0; rockU.uLichen.value.setRGB(...L.lichen);
}

function buildWorld() {
  if (worldGroup) { scene.remove(worldGroup); worldGroup.traverse((o) => { if (o.isMesh && o.geometry && !Object.values(geos).includes(o.geometry) && !Object.values(rockGeos).some((s) => Object.values(s).includes(o.geometry))) o.geometry.dispose(); }); }
  worldGroup = new THREE.Group(); scene.add(worldGroup);
  tiles = [];
  buildTextures();
  const lith = LITH[W.opt.geology] || LITH.granite;
  // weathering: wet climates and granite round rock edges; dry climates keep fresh, sharp joint faces
  const rounding = clamp(({ dry: 0, mesic: 1, wet: 2 }[W.opt.moisture] ?? 1) - (W.opt.geology === 'basalt' ? 1 : 0), 0, 3);
  const rocks = rockSet(lith.kind, rounding);

  // far terrain mesh (2 m); the near patch covers the ground around the player at 0.5 m
  const pos = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i; pos[k * 3] = i * CELL - HALF; pos[k * 3 + 1] = W.H[k]; pos[k * 3 + 2] = j * CELL - HALF;
  }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6); let q = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setIndex(new THREE.BufferAttribute(idx, 1)); tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, terrainMat); terrain.receiveShadow = true;
  worldGroup.add(terrain, buildSkirt());
  if (!nearTerrain) { nearTerrain = new THREE.Mesh(nearPatchGeo(48, 0.5), nearTerrainMat); nearTerrain.frustumCulled = false; nearTerrain.receiveShadow = true; }
  worldGroup.add(nearTerrain);

  // streams: a thin water sheet over channel cells
  {
    const wp = [], wi = [], map = new Int32Array(N * N).fill(-1);
    for (let k = 0; k < N * N; k++) if (W.stream[k] > 0.3) { map[k] = wp.length / 3; wp.push(pos[k * 3], W.H[k] + 0.1 + 0.12 * W.stream[k], pos[k * 3 + 2]); }
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

  // trees, snags, logs, root plates, outcrops — batched into 64 m tiles so whole tiles can be culled
  const TILE = 64, NT = WORLD / TILE;
  const B = Array.from({ length: NT * NT }, () => ({ live: new Batch(), trunk: new Batch(), piece: new Batch(), butt: new Batch(), broad: new Batch(), cone: new Batch(), pine: new Batch(), plate: new Batch(), stumpLo: new Batch(), stumpHi: new Batch(), wad: { pos: [], nor: [], uv: [], col: [], idx: [] }, rk: [new Batch(), new Batch(), new Batch(), new Batch()] }));
  const tileOf = (x, z) => clamp(Math.floor((z + HALF) / TILE), 0, NT - 1) * NT + clamp(Math.floor((x + HALF) / TILE), 0, NT - 1);
  colTrunks = new Map(); colLogs = []; logCells = new Map(); solids = new Map(); pieceCells = new Map(); saplingCells = new Map(); plantCells = new Map(); rootCells = new Map(); branchLogCells = new Map();
  for (const r of brokenTrees) { plantGroup.remove(r.custom.bark, r.custom.leaf); } brokenTrees = []; logPick = []; logQueue = []; physReset();
  if (!plantGroup) { plantGroup = new THREE.Group(); scene.add(plantGroup); }
  const ckey = (ci, cj) => ci * 4096 + cj;
  const pushCol = (map, x, z, item, cs = 8) => { const k = ckey(Math.floor((x + HALF) / cs), Math.floor((z + HALF) / cs)); let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(item); };
  // bedrock outcrops: large, partly buried blocks on steep rocky ground, aligned with the slope
  {
    const r = mulberry32(W.seed * 31 + 9);
    for (let j = 1; j < N - 1; j += 2) for (let i = 1; i < N - 1; i += 2) {
      const k = j * N + i, rk = W.rock[k];
      if (rk < 0.35 || r() > rk * 0.55) continue;
      const x = i * CELL - HALF + (r() - 0.5) * 3, z = j * CELL - HALF + (r() - 0.5) * 3;
      if (sampleGrid(W.stream, N, x, z) > 0.3) continue;
      const s = 1.2 + 3.5 * r() * rk, gy = ground(x, z);
      const hx = ground(x + 1, z) - ground(x - 1, z), hz = ground(x, z + 1) - ground(x, z - 1);
      const tilt = Math.min(0.5, Math.hypot(hx, hz) / 2);
      const col = mix3(lith.col, [0.5, 0.5, 0.48], 0.15 * r()), v = 0.85 + 0.25 * r();
      const vi = Math.floor(r() * 4), yaw = r() * 6.283, sx = s * (0.9 + 0.5 * r()), sy = s * (0.75 + 0.5 * r()), sz = s * (0.8 + 0.5 * r()), sink = s * (0.08 + 0.15 * r());
      B[tileOf(x, z)].rk[vi].add(trs(x, gy - sink, z, yaw, sx, sy, sz, Math.atan2(hz, 2) * 0.8 * (tilt > 0 ? 1 : 0), -Math.atan2(hx, 2) * 0.8), col[0] * v, col[1] * v, col[2] * v, s);
      addSolid(Object.assign(meshSolid(rocks.big[vi], trs(x, gy - sink, z, yaw, sx, sy, sz, Math.atan2(hz, 2) * 0.8 * (tilt > 0 ? 1 : 0), -Math.atan2(hx, 2) * 0.8), x, z), { big: vi }), s * 1.6);
    }
  }
  W.rockStyle = [lith.kind, rounding];
  if (W.gym) buildGymExtras(rocks);
  // deadfall: how each fallen stem came to rest among the standing ones, on terrain and rock (decided once per world)
  if (!W.deadfall) { const t0 = performance.now(); W.deadfall = settleDeadfall(W, rockSupport); W.deadfall.ms = Math.round(performance.now() - t0); }
  for (const t of W.trees) {
    if (t.crushed) continue;
    const r = mulberry32(hash3(Math.round(t.x * 10), Math.round(t.z * 10), 77)), b = B[tileOf(t.x, t.z)], P = SPECIES[t.sp];
    const gy = ground(t.x, t.z), kind = P.kind, rad = t.d / 100, f0 = t.form;
    // a tree at the edge of a gap, with a strong light gradient across it, grows a one-sided crown reaching into the light;
    // the variant reaches toward its +x, so turn the tree that way (broadleaves and pine: fir and spruce hold their shape)
    // wind-flagged: on an exposed ridge, any species loses the limbs on its windward side and its crown streams downwind
    const flagged = t.st === 0 && t.d >= 6 && (t.ex ?? 0) > 0.45;
    const oneSided = flagged || (t.st === 0 && t.d >= 6 && P.phot >= 0.6 && (f0?.pull ?? 0) / P.phot > 0.8); // about the most lopsided 15 %
    let yaw = r() * Math.PI * 2; if (oneSided) yaw = (flagged ? -W.windDir : Math.atan2(-f0.gz, f0.gx)) + (yaw - Math.PI) * 0.08;
    const vari = 0.88 + 0.24 * r();
    const f = t.form || { lx: 0, lz: 0, sx: 0, sz: 0, A: 0, k: 1, ph: 0 };
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw);
    const toL = (wx, wz) => [wx * cy0 - wz * sy0, wx * sy0 + wz * cy0];
    const toW = (lx, lz) => [lx * cy0 + lz * sy0, -lx * sy0 + lz * cy0];
    f.bl = [...toL(f.lx + (t.lean?.[0] || 0), f.lz + (t.lean?.[1] || 0)), ...toL(f.sx, f.sz)];
    const bendAttr = f.bl, wobAttr = [f.A, f.k, f.ph, 1];
    if (t.st === 0) {
      const light = t.L !== undefined ? clamp(t.L * 2, 0, 1) : 1, shadeK = 0.75 + 0.25 * light, h = t.h, cf = Math.min(0.95, crownFrac(t.sp, t.d, light) * shadeK * (t.d < 6 ? 1.15 : 1));
      const crownLen = Math.min(h * 0.95, h * cf), cr = crownRadius(t.sp, t.d) * (0.85 + 0.3 * r());
      const bt = TINT.bark[t.sp], H = kind === 'conifer' ? h * 0.97 : h * 0.86;
      b.live.add(trs(t.x, gy - 0.15, t.z, yaw, rad, H, rad), bt[0] * vari, bt[1] * vari, bt[2] * vari, t.d, bendAttr, wobAttr);
      const lt = leafTint(t.sp), shadeDull = t.L !== undefined ? 0.82 + 0.18 * clamp(t.L * 3, 0, 1) : 1, cv = vari * shadeDull;
      const cy = gy + h - crownLen;
      // the crown sits on the bent stem: offset by the stem displacement at crown base (and a bit toward the top)
      const ub = clamp((h - crownLen) / H, 0, 1), um = clamp((h - crownLen * 0.5) / H, 0, 1);
      const o1 = toW(...bendLocal(f, ub, H)), o2 = toW(...bendLocal(f, um, H));
      const dx = (o1[0] + o2[0]) / 2, dz = (o1[1] + o2[1]) / 2;
      const base = [t.x, t.z, 0, 0]; // far crowns carry their tree's base, so the near ring can hide them
      if (kind === 'conifer') b.cone.add(trs(t.x + dx, cy, t.z + dz, yaw, cr, crownLen * 1.04, cr), lt[0] * cv, lt[1] * cv, lt[2] * cv, t.d, base);
      else (kind === 'pine' ? b.pine : b.broad).add(trs(t.x + dx, cy, t.z + dz, yaw, cr, crownLen, cr * (0.85 + 0.3 * r())), lt[0] * cv, lt[1] * cv, lt[2] * cv, t.d, base);
      { // the grown plant drawn near the player: a library variant by size class and crown shape, scaled to this tree
        const r2 = mulberry32(hash3(Math.round(t.x * 10), Math.round(t.z * 10), 91)), A = PL.ARCH[t.sp];
        const shape = r2() < A.fork ? 2 : oneSided ? 3 : shadeK < 0.9 ? 0 : 1;
        const v = plantVariant(t.sp, plantClass(Math.max(1, t.d)), shape, r2() < 0.5 ? 0 : 1), sx = v.hRep * (cr / v.crRep);
        const rec = { x: t.x, z: t.z, v, m: trs(t.x, gy - 0.15, t.z, yaw, sx, h, sx).elements.slice(), bc: [lin(bt[0] * vari), lin(bt[1] * vari), lin(bt[2] * vari)], lc: [lin(lt[0] * cv), lin(lt[1] * cv), lin(lt[2] * cv)], bend: bendAttr, wob: wobAttr };
        pushCol(plantCells, t.x, t.z, rec, 16); rec.t = t; t._prec = rec;
      }
      if (t.d >= 3) pushCol(rootCells, t.x, t.z, { t, x: t.x, z: t.z }, 16);
      if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
      else if (h > 1.3) pushCol(saplingCells, t.x, t.z, { sap: true, tx: t.x, tz: t.z, tol: Math.hypot(dx, dz) + 0.05, x: t.x + dx * 0.3, z: t.z + dz * 0.3, r: 0.04 + t.d / 200, h, R: cr * 0.9, base: h - crownLen });
    } else if (t.st === 1) {
      const grey = mix3(TINT.bark[t.sp], [0.62, 0.60, 0.56], clamp(t.t / 20, 0, 0.8));
      if (t.d >= 3) pushCol(rootCells, t.x, t.z, { t, x: t.x, z: t.z }, 16);
      if (t.sh < (t.h || treeHeight(t.sp, t.d)) * 0.7) { // a broken stem: a stump with a splintered top
        const low = t.sh < 2.5, m = trs(t.x, gy - 0.15, t.z, yaw, rad * 0.5, t.sh + 0.15, rad * 0.5);
        (low ? b.stumpLo : b.stumpHi).add(m, grey[0] * vari, grey[1] * vari, grey[2] * vari, t.d * 0.7, [0, 0, f.bl[2], f.bl[3]], wobAttr);
        if (t.sh + 0.15 < SCRAMBLE + 0.2) addSolid(meshSolid(geos.stumpLo, m.clone(), t.x, t.z), rad * 0.8); // low enough to step or climb onto
        else if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
      } else {
        b.trunk.add(trs(t.x, gy - 0.15, t.z, yaw, rad, t.sh, rad), grey[0] * vari, grey[1] * vari, grey[2] * vari, t.d * 0.7, [0, 0, f.bl[2], f.bl[3]], wobAttr);
        if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
      }
    } else if (t.st === 2) {
      const T = (15 + 1.3 * t.d) * P.decay, fd = clamp(t.t / T, 0, 1), cls = 1 + Math.floor(fd * 4.999), R = t.rest;
      const dirx = Math.cos(R.a), dirz = Math.sin(R.a), rr = (t.d / 200) * (1 - 0.15 * fd);
      const col = cls <= 2 ? mix3(TINT.bark[t.sp], [0.42, 0.34, 0.27], SPECIES[t.sp].pale ? 0.3 : 0.6) : mix3([0.44, 0.36, 0.28], [0.34, 0.37, 0.21], (cls - 3) / 2);
      for (const p of R.pieces) {
        const whole = p.u0 === 0 && p.u1 === 1, len = Math.hypot(p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0);
        const wob = [f.A * (1 - 0.4 * fd), f.k, f.ph + f.k * p.u0 * R.L, 0.25];
        // a piece's instance scale is its own mean radius; the butt geometry carries the flare on top of that
        const um = (Math.max(p.u0, 0.14) + p.u1) / 2, ks = whole ? 1 : trunkProfile(um);
        const batch = whole ? b.trunk : p.u0 === 0 ? b.butt : b.piece;
        const lm = along(p.x0, p.y0, p.z0, p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0, R.sx * ks, len, R.sz * ks);
        Object.assign(p, { _mat: lm.elements.slice(), _col: [col[0] * vari, col[1] * vari, col[2] * vari], _r: (R.sx + R.sz) / 2 * ks, _t: t, _fd: fd, _geo: whole ? 'trunk' : p.u0 === 0 ? 'butt' : 'piece', _free: undefined });
        batch.add(lm, col[0] * vari, col[1] * vari, col[2] * vari, t.d * 0.4 * (p.u1 - p.u0), [0, 0, 0, 0], wob, p);
        solidSink = []; if (t.d >= 5) logSolids(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, R.sx * ks, R.sz * ks, wob, whole ? trunkProfile : p.u0 === 0 ? buttProfile : () => 1); p._solids = solidSink; solidSink = null;
        for (const so of p._solids) so.logPiece = p;
        if (t.d >= 3) pushCol(pieceCells, (p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, p, 16);
        if (t.d >= 12) {
          const log = { x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, y0: p.y0 + rr * 0.8, y1: p.y1 + rr * 0.8, r: rr, cls };
          colLogs.push(log);
          const steps = Math.ceil(Math.hypot(p.x1 - p.x0, p.z1 - p.z0) / 8);
          for (let s2 = 0; s2 <= steps; s2++) { const f2 = s2 / steps; pushCol(logCells, p.x0 + (p.x1 - p.x0) * f2, p.z0 + (p.z1 - p.z0) * f2, log); }
        }
      }
      if (t.d >= 12 && t.t < 30 && R.pieces.length === 1 && R.pieces[0].u0 === 0 && R.pieces[0].u1 === 1) { const q = R.pieces[0], rb = { t, x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2 }; t._blog = rb; pushCol(branchLogCells, rb.x, rb.z, rb, 16); }
      if (t.up && t.t < 70) {
        // the plate is what the root graph had inside the plate radius (the same radius as the pit it left), turned up with
        // the stem: a soil clump round the collar with the roots that tore out with it, broken off at its rim
        const soilI = t.soil ?? 0.6, pr = plateRadius(t.d, soilI) * 1.1, pf = 1 - t.t / 70, cyP = ground(t.x, t.z) + pr * 0.55 * pf + 0.1, th = plateThickness(t.d, soilI) * (0.7 + 0.5 * pf);
        b.plate.add(along(t.x - dirx * 0.15, cyP, t.z - dirz * 0.15, dirx, 0, dirz, pr * (0.55 + 0.25 * pf), th, pr * (0.4 + 0.4 * pf)), 0.62 * vari, 0.52 * vari, 0.42 * vari);
        wadRoots(b.wad, t, t.x - dirx * 0.1, cyP, t.z - dirz * 0.1, dirx, dirz, pr, pf);
        pushCol(rootCells, t.x, t.z, { t, x: t.x, z: t.z, wad: { cx: t.x - dirx * 0.1, cy: cyP, cz: t.z - dirz * 0.1, dx: dirx, dz: dirz, pr, pf } }, 16); // near you, the same roots as a physical graph
        // the wad is a near-vertical soil wall: ellipsoid thin along the fall direction
        addSolid(ellipsoid(t.x - dirx * 0.15, cyP, t.z - dirz * 0.15, pr * (0.7 + 0.3 * pf), pr * (0.5 + 0.5 * pf), th * 0.5, -dirz, dirx), pr);
      }
    }
  }
  for (let ti = 0; ti < B.length; ti++) {
    const g = new THREE.Group(), b = B[ti];
    { const m = b.plate.build(geos.plate, mats.soil); if (m) g.add(m); }
    g.userData.hi = []; g.userData.lo = [];
    if (b.wad.idx.length) { const gw = arraysGeo(b.wad); gw.setAttribute('aBase', new THREE.Float32BufferAttribute(b.wad.base, 2)); const m = new THREE.Mesh(gw, wadFarMat); m.castShadow = true; m.receiveShadow = true; g.add(m); g.userData.hi.push(m); }
    for (const [batch, geo] of [[b.stumpLo, geos.stumpLo], [b.stumpHi, geos.stumpHi]]) { const m = batch.build(geo, mats.bark, { farMin: 12, form: true }); if (m) { g.add(m); g.userData.hi.push(m); } }
    b.rk.forEach((rb, i) => { const hi = rb.build(rocks.big[i], rockMat); if (!hi) return; const lo = lodTwin(hi, rocks.bigLo[i], true); g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); });
    {
      for (const [batch, hiG, loG] of [[b.trunk, geos.trunk, geos.trunkLo], [b.piece, geos.piece, geos.pieceLo], [b.butt, geos.butt, geos.buttLo]]) {
        const hi = batch.build(hiG, mats.bark, { farMin: 9, form: true });
        if (hi) { const lo = lodTwin(hi, loG, true); g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); }
      }
    }
    // crowns get a full and a reduced geometry sharing one instance buffer; the loop picks one by distance
    {
      const hi = b.live.build(geos.trunk, treeMats.farBark, { farMin: 9, form: true });
      if (hi) { const lo = lodTwin(hi, geos.trunkLo, true); hi.customDepthMaterial = lo.customDepthMaterial = treeMats.farBarkDepth; g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); }
    }
    for (const [batch, hiG, loG, mat] of [[b.broad, geos.broad, geos.broadLo, treeMats.farLeaf], [b.cone, geos.cone, geos.coneLo, treeMats.farNeedle], [b.pine, geos.broad, geos.broadLo, treeMats.farNeedle]]) {
      const hi = batch.build(hiG, mat, { farMin: 4, form: true }); if (!hi) continue;
      const lo = lodTwin(hi, loG, false); hi.customDepthMaterial = lo.customDepthMaterial = treeMats.farFolDepth;
      g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo);
    }
    g.userData.cx = (ti % NT) * TILE - HALF + TILE / 2; g.userData.cz = Math.floor(ti / NT) * TILE - HALF + TILE / 2;
    worldGroup.add(g); tiles.push(g);
  }
  for (const [k, a] of logCells) logCells.set(k, [...new Set(a)]);

  // near-field scatter
  if (near) for (const nb of Object.values(near.b)) nb.mesh.dispose?.();
  const Q = settings.quality === 'high';
  near = {
    cells: new Map(), cx: Infinity, cz: Infinity,
    nz: makeNoise2D(mulberry32(W.seed * 7 + 3)), nz2: makeNoise2D(mulberry32(W.seed * 7 + 4)),
    b: {
      shrub: new NearBatch(geos.shrub, mats.shrub, 9000), fern: new NearBatch(geos.fern, mats.fern, 9000),
      grass: new NearBatch(geos.grass, mats.grass, Q ? 18000 : 11000), sedge: new NearBatch(geos.grass, mats.grass, 7000),
      herb: new NearBatch(geos.herb, mats.shrub, 7000), litter: new NearBatch(geos.litter, mats.litter, 7000),
      tleaf: new NearBatch(geos.tleaf, mats.shrub, 3000), tstem: new NearBatch(geos.tstem, mats.wood, 3000),
      seedB: new NearBatch(geos.broadLo, mats.leaf, 4000), seedC: new NearBatch(geos.coneLo, mats.needle, 4000),
      twig: new NearBatch(geos.twig, mats.wood, 5000), stick: new NearBatch(geos.stick, mats.wood, 4000), limb: new NearBatch(geos.limb, mats.wood, 2000, { cast: true }),
      ...Object.fromEntries(rocks.small.map((gm, i) => [`rockS${i}`, new NearBatch(gm, rockMat, 2000)])),
      ...Object.fromEntries(rocks.big.map((gm, i) => [`rockB${i}`, new NearBatch(gm, rockMat, 300, { cast: true })])),
      roundS: new NearBatch(rocks.roundS, rockMat, 3000), roundB: new NearBatch(rocks.roundB, rockMat, 500, { cast: true }),
    },
  };
  for (const nb of Object.values(near.b)) worldGroup.add(nb.mesh);
}

function buildSkirt() {
  // Low-resolution land beyond the simulated square, so the world edge dissolves into haze instead of ending at a cliff.
  const R0 = HALF, R1 = 1100, rings = 22, seg = 96, nz = makeNoise2D(mulberry32(W.seed + 404));
  const pos = [], idx = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2, f = r / rings, rad = R0 * 1.0 + (R1 - R0) * f * f;
    const sq = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
    const rr = r === 0 ? R0 - 2 : rad, x = (Math.cos(a) / sq) * rr, z = (Math.sin(a) / sq) * rr;
    const ex = clamp(x, -HALF, HALF), ez = clamp(z, -HALF, HALF);
    const h0 = sampleGrid(W.H, N, ex, ez), far = clamp((Math.hypot(x - ex, z - ez)) / 300, 0, 1);
    const y = lerp(h0, W.hmax * 0.4, far * 0.6) + nz(x / 260, z / 260) * 30 * far + nz(x / 70, z / 70) * 4 * Math.min(1, far * 3) - (r === 0 ? 0.3 : 0);
    pos.push(x, y, z);
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
    const a = r * seg + s, b = r * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  if (g.attributes.normal.getY(seg * 2) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  return new THREE.Mesh(g, terrainMat);
}

// ---------------------------------------------------------------- near-field ground cover (deterministic per 8 m cell)
function rockBatch(type, v) { if (type === 'rockS') return near.b[`rockS${Math.floor(v * 2.999)}`]; if (type === 'rockB') return near.b[`rockB${Math.floor(v * 3.999)}`]; return near.b[type]; }
const NC = 8;
function fieldAt(x, z) {
  return {
    L: sampleGrid(W.light, W.LN, x, z), wet: sampleGrid(W.wet, N, x, z), m: sampleGrid(W.moist, N, x, z),
    s: sampleGrid(W.stream, N, x, z), rk: sampleGrid(W.rock, N, x, z), sl: sampleGrid(W.slope, N, x, z),
    con: sampleGrid(W.conShare, W.LN, x, z), soil: sampleGrid(W.soil, N, x, z),
  };
}
function genCell(ci, cj) {
  if (W.gym) return gymCell(ci, cj);
  const r = mulberry32(hash3(ci, cj, W.seed * 13 + 5)), items = [];
  const x0 = ci * NC - HALF, z0 = cj * NC - HALF;
  const f = fieldAt(x0 + NC / 2, z0 + NC / 2);
  const clump = 0.5 + 0.5 * near.nz((x0 + 4) / 30, (z0 + 4) / 30);           // clonal / patchy understorey
  const clump2 = 0.5 + 0.5 * near.nz2((x0 + 4) / 45, (z0 + 4) / 45);
  const dry = 1 - f.m, open = 1 - f.s;
  const pois = (lam) => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };
  const rnd = () => [x0 + r() * NC, z0 + r() * NC];
  const Lat = (x, z) => sampleGrid(W.light, W.LN, x, z);
  // tall shrubs (1.5–4 m): gap edges and moderately open ground, clonal patches; a few shade-tolerant ones under canopy
  const nTall = pois((0.25 + 4.5 * smoothstep(0.06, 0.45, f.L)) * clump2 * clump2 * 1.8 * (0.4 + 0.9 * f.m) * open * (1 - 0.85 * f.rk));
  for (let k = 0; k < nTall; k++) { const [x, z] = rnd(); const h = 1.5 + 2.5 * r() * (0.5 + Lat(x, z)); items.push(['tall', x, z, r() * 6.28, h * (0.55 + 0.3 * r()), h, 0.8 + 0.3 * r(), r()]); }
  // low shrubs (blueberry, young growth): light-limited, patchy
  const nShrub = pois((1.4 + 9 * Math.pow(f.L, 0.8)) * clump * clump * 1.6 * (0.4 + 0.8 * f.m) * (1 - 0.9 * f.s) * (1 - 0.8 * f.rk));
  for (let k = 0; k < nShrub; k++) { const [x, z] = rnd(), L = Lat(x, z); const s = (0.45 + 1.1 * r()) * (0.55 + 0.7 * L); items.push(['shrub', x, z, r() * 6.28, s * (1 + 0.4 * r()), s, 0.75 + 0.3 * r(), r()]); }
  // tree seedlings and small saplings: the advance regeneration waiting for a gap
  const nSeed = pois((1.5 + 7 * f.L) * open * (1 - 0.8 * f.rk) * (0.6 + 0.6 * f.soil));
  for (let k = 0; k < nSeed; k++) { const [x, z] = rnd(); const h = 0.2 + 1.1 * r() * r(); items.push([r() < f.con ? 'seedC' : 'seedB', x, z, r() * 6.28, h * 0.35, h, 0.85 + 0.25 * r(), r()]); }
  // ferns: moist, shade-tolerant
  const nFern = pois((14 * smoothstep(0.35, 0.85, f.wet + 0.2 * f.m) + 1.2) * (1.1 - 0.6 * f.L) * (1 - 0.6 * f.s) * (0.5 + clump) * (1 - f.rk));
  for (let k = 0; k < nFern; k++) { const [x, z] = rnd(); const s = 0.45 + 0.65 * r(); items.push(['fern', x, z, r() * 6.28, s, s * (0.8 + 0.4 * r()), 0.85 + 0.25 * r(), r()]); }
  // forbs (wood sorrel, bunchberry, trillium-like): ubiquitous low herbs, more on moist fertile soil
  const nHerb = pois((4 + 14 * f.m * (0.3 + f.L)) * (0.6 + 0.6 * f.soil) * (1 - 0.8 * f.rk) * (1 - 0.7 * f.s) * (0.6 + 0.8 * clump2));
  for (let k = 0; k < nHerb; k++) { const [x, z] = rnd(); const s = 0.12 + 0.25 * r(); items.push(['herb', x, z, r() * 6.28, s * 1.3, s, 0.85 + 0.3 * r(), r()]); }
  // grasses in openings, sedges in shade and along streams
  const nGrass = pois(60 * smoothstep(0.12, 0.55, f.L) * (1 - 0.8 * f.rk) * (0.6 + 0.6 * dry) + 18 * smoothstep(0.2, 0.6, f.s) * (1 - smoothstep(0.7, 1, f.s)) + 2);
  for (let k = 0; k < nGrass; k++) { const [x, z] = rnd(); const s = 0.25 + 0.4 * r(); items.push(['grass', x, z, r() * 6.28, s * 1.6, s, 0.8 + 0.3 * r(), r()]); }
  const nSedge = pois((3 + 9 * f.wet) * (1 - f.rk) * (1 - 0.4 * f.L));
  for (let k = 0; k < nSedge; k++) { const [x, z] = rnd(); const s = 0.2 + 0.25 * r(); items.push(['sedge', x, z, r() * 6.28, s * 1.4, s, 0.8 + 0.3 * r(), r()]); }
  // leaf litter drifts under broadleaf canopy (the shader carries the needle duff under conifers)
  const nLit = pois((5 + 26 * (1 - f.con) * (1 - 0.6 * f.L)) * (1 - f.s) * (1 - 0.7 * f.rk));
  for (let k = 0; k < nLit; k++) { const [x, z] = rnd(); const s = 0.35 + 0.6 * r(); items.push(['litter', x, z, r() * 6.28, s, s, 0.8 + 0.35 * r(), r()]); }
  // fine woody debris falls from the canopy, so it scales with canopy closure; fresh logs shed many branches
  const nBr = pois(4 + 12 * (1 - f.L));
  for (let k = 0; k < nBr; k++) { const [x, z] = rnd(); const v = r(); items.push([v < 0.55 ? 'twig' : v < 0.9 ? 'stick' : 'limb', x, z, r() * 6.28, 0.4 + 2.2 * r(), 0, 0, r()]); }
  const logs = logCells.get(ci * 4096 + cj) || [];
  for (const lg of logs) if (lg.cls <= 2) {
    const n = 4 + Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const t = 0.3 + 0.7 * r(), x = lg.x0 + (lg.x1 - lg.x0) * t + (r() - 0.5) * 3.5, z = lg.z0 + (lg.z1 - lg.z0) * t + (r() - 0.5) * 3.5;
      if (x < x0 || x >= x0 + NC || z < z0 || z >= z0 + NC) continue;
      const v = r(); items.push([v < 0.4 ? 'stick' : v < 0.75 ? 'limb' : 'twig', x, z, r() * 6.28, 1 + 3 * r(), 0, lg.cls === 1 ? 1 : 0, r()]);
    }
  }
  // rocks: steep ground, rocky knolls; stream beds hold water-rounded cobbles
  const nRock = pois(0.25 + 7 * f.rk + 2 * smoothstep(0.4, 0.8, f.sl) * (1 - f.soil));
  for (let k = 0; k < nRock; k++) { const [x, z] = rnd(); const big = r() < 0.06 + 0.15 * f.rk; const s = big ? 0.6 + 1.6 * r() : 0.07 + 0.3 * r() * r(); items.push([big ? 'rockB' : 'rockS', x, z, r() * 6.28, s, s, 0.85 + 0.25 * r(), r()]); }
  // scree: frost- and gravity-shed fragments collect below rocky ground, on moderate slopes
  {
    const hx = sampleGrid(W.H, N, x0 + 6, z0 + 4) - sampleGrid(W.H, N, x0 + 2, z0 + 4), hz = sampleGrid(W.H, N, x0 + 4, z0 + 6) - sampleGrid(W.H, N, x0 + 4, z0 + 2);
    const gm = Math.hypot(hx, hz) + 1e-6, upRock = Math.max(sampleGrid(W.rock, N, x0 + 4 + (hx / gm) * 10, z0 + 4 + (hz / gm) * 10), sampleGrid(W.rock, N, x0 + 4 + (hx / gm) * 20, z0 + 4 + (hz / gm) * 20));
    const nScree = pois(14 * smoothstep(0.3, 0.8, upRock) * smoothstep(0.12, 0.35, f.sl) * (1 - 0.5 * f.rk) * (1 - f.s));
    for (let k = 0; k < nScree; k++) { const [x, z] = rnd(); const s = 0.08 + 0.45 * r() * r(); items.push(['rockS', x, z, r() * 6.28, s, s, 0.8 + 0.3 * r(), r()]); }
  }
  const nCob = pois(9 * smoothstep(0.35, 0.85, f.s));
  for (let k = 0; k < nCob; k++) { const [x, z] = rnd(); if (sampleGrid(W.stream, N, x, z) < 0.3) continue; const big = r() < 0.08; const s = big ? 0.4 + 0.6 * r() : 0.06 + 0.18 * r(); items.push([big ? 'roundB' : 'roundS', x, z, r() * 6.28, s, s, 0.85 + 0.25 * r(), r()]); }
  return items;
}
const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
function onGround(x, y, z, yaw, s) { // a flat item lying on the local slope
  const hx = ground(x + 0.3, z) - ground(x - 0.3, z), hz = ground(x, z + 0.3) - ground(x, z - 0.3);
  _n.set(-hx / 0.6, 1, -hz / 0.6).normalize(); _t.set(Math.cos(yaw), 0, Math.sin(yaw)); _t.addScaledVector(_n, -_t.dot(_n)).normalize(); _b.crossVectors(_t, _n);
  _m.makeBasis(_t.multiplyScalar(s), _n.multiplyScalar(s), _b.multiplyScalar(s)); _m.setPosition(x, y, z); return _m;
}
function refreshNear(px, pz, force = false) {
  const due = force || Math.hypot(px - near.cx, pz - near.cz) >= 6;
  if (force || !due) refreshPlants(px, pz, force); // never both refreshes in one frame: the trees catch up next frame
  rootWork(force ? Infinity : 1.5);
  if (!due) return;
  near.cx = px; near.cz = pz;
  for (const nb of Object.values(near.b)) nb.reset();
  const Q = settings.quality === 'high', lith = LITH[W.opt.geology] || LITH.granite;
  const RAD = { tall: 85, scree: 70, shrub: 75, fern: 60, grass: Q ? 45 : 32, sedge: 34, herb: 30, litter: 26, seedB: 40, seedC: 40, twig: 30, stick: 45, limb: 60, rockS: 70, rockB: 110, roundS: 60, roundB: 90 };
  const maxR = 110, c0 = Math.floor((px - maxR + HALF) / NC), c1 = Math.floor((px + maxR + HALF) / NC), r0 = Math.floor((pz - maxR + HALF) / NC), r1 = Math.floor((pz + maxR + HALF) / NC);
  const keep = new Set();
  for (let cj = Math.max(0, r0); cj <= Math.min(WORLD / NC - 1, r1); cj++) for (let ci = Math.max(0, c0); ci <= Math.min(WORLD / NC - 1, c1); ci++) {
    const cx = ci * NC - HALF + NC / 2, cz = cj * NC - HALF + NC / 2, d = Math.hypot(cx - px, cz - pz);
    if (d > maxR + 6) continue;
    const key = ci * 4096 + cj; keep.add(key);
    let items = near.cells.get(key); if (!items) { items = genCell(ci, cj); near.cells.set(key, items); }
    for (const it of items) {
      const [type, x, z, yaw, a, b, c, v] = it;
      const dd = Math.hypot(x - px, z - pz); if (dd > RAD[type]) continue;
      const gy = ground(x, z), nb = /^rock/.test(type) ? rockBatch(type, v) : near.b[type];
      if (PROXY[type]) { // plants with a stem skeleton: remember where each is drawn, so a simulated one can be hidden
        const m = itemMatrix(it); it._bi = [];
        for (const nm of PROXY[type].batches) { const B = near.b[nm]; if (B.n < B.cap) { it._bi.push([nm, B.n]); B.add(m, ...itemColor(it, nm)); } }
        if (it.ph) for (const [nm, k] of it._bi) near.b[nm].hide(k);
        continue;
      }
      switch (type) {
        case 'tall': {
          const m = trs(x, gy - 0.05, z, yaw, a, b, a * (0.8 + 0.4 * v));
          near.b.tleaf.add(m, 0.88 * c, 0.95 * c, 0.76 * c); near.b.tstem.add(m, 0.5 * c, 0.44 * c, 0.38 * c); break;
        }
        case 'shrub': nb.add(trs(x, gy - 0.08, z, yaw, a, b, a * 0.9), 0.9 * c, 0.95 * c, 0.78 * c); break;
        case 'seedB': nb.add(trs(x, gy - 0.02, z, yaw, a, b, a), 0.82 * c, 0.92 * c, 0.66 * c); break;
        case 'seedC': nb.add(trs(x, gy - 0.02, z, yaw, a, b, a), 0.78 * c, 0.86 * c, 0.70 * c); break;
        case 'fern': nb.add(trs(x, gy - 0.03, z, yaw, a, b, a), 0.85 * c, 0.95 * c, 0.7 * c); break;
        case 'herb': nb.add(trs(x, gy - 0.02, z, yaw, a, b, a), 0.95 * c, 1.0 * c, 0.72 * c); break;
        case 'grass': nb.add(trs(x, gy - 0.05, z, yaw, a, b, a), 0.95 * c, 0.95 * c, 0.85 * c); break;
        case 'sedge': nb.add(trs(x, gy - 0.04, z, yaw, a, b, a), 0.62 * c, 0.74 * c, 0.58 * c); break;
        case 'litter': nb.add(onGround(x, gy + 0.015, z, yaw, a), 1.0 * c, 0.95 * c, 0.88 * c); break;
        case 'twig': case 'stick': case 'limb': {
          const col = woodColor(it); it._bi = nb.n < nb.cap ? [[type, nb.n]] : [];
          nb.add(woodMatrix(it), ...col); if (it._free !== undefined) nb.hide(nb.n - 1); break;
        }
        default: { // rocks
          const mossy = 0; const col = type.startsWith('round') ? mix3(lith.col, [0.48, 0.47, 0.44], 0.3) : lith.col;
          nb.add(trs(x, gy - a * 0.25, z, yaw, a * (0.8 + 0.5 * v), a, a * (1.2 - 0.4 * v), (v - 0.5) * 0.3, 0), col[0] * c, col[1] * c, col[2] * c);
        }
      }
    }
  }
  for (const k of near.cells.keys()) if (!keep.has(k) && near.cells.size > 1600) near.cells.delete(k);
  for (const nb of Object.values(near.b)) nb.commit();
}

// ---------------------------------------------------------------- testing gym
// Stations from src/gym.js, plus spots captured in the forest on this device (stored locally). See gym.js for the format.
let gymAt = 0;
const DEG = Math.PI / 180;
function loadCaptures() { try { return JSON.parse(localStorage.getItem('foothold.captures') || '[]'); } catch (e) { return []; } }
function buildGymExtras(rocks) {
  const G = W.gym, stone = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(0.5, 0.48, 0.45, THREE.SRGBColorSpace) });
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const put = (geo, mat, M) => { const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; m.matrix.copy(M); m.castShadow = m.receiveShadow = true; worldGroup.add(m); };
  for (const b of G.blocks) {
    const M = trs(b.x, b.y, b.z, b.yaw * DEG, b.size[0], b.size[1], b.size[2], b.pitch * DEG, b.roll * DEG).clone();
    put(box, stone, M); addSolid(boxSolid(b), 0);
    b._inv = trs(b.x, b.y, b.z, b.yaw * DEG, 1, 1, 1, b.pitch * DEG, b.roll * DEG).clone().invert(); // (for exact depth into it: gymPen)
  }
  for (const r of G.rocks) { // captured outcrops: the same big-rock shapes the forest uses (this gym's bedrock style)
    const M = new THREE.Matrix4().fromArray(r.e); M.elements[12] += r.x; M.elements[13] += r.y; M.elements[14] += r.z;
    const geo = rocks.big[r.i % rocks.big.length]; put(geo, stone, M); addSolid(meshSolid(geo, M, r.x, r.z), 0);
  }
  const sphere = new THREE.SphereGeometry(1, 18, 12);
  for (const w of G.wads) {
    const M = new THREE.Matrix4().makeBasis(new THREE.Vector3(w.ux * w.ax, 0, w.uz * w.ax), new THREE.Vector3(0, w.ay, 0), new THREE.Vector3(-w.uz * w.az, 0, w.ux * w.az)).setPosition(w.x, w.y, w.z);
    put(sphere, mats.soil, M); addSolid(ellipsoid(w.x, w.y, w.z, w.ax, w.ay, w.az, w.ux, w.uz), Math.max(w.ax, w.az));
  }
  // lane marks (start and goal lines) and a sign naming each station
  const line = new THREE.PlaneGeometry(3, 0.07).rotateX(-Math.PI / 2);
  const startMat = new THREE.MeshBasicMaterial({ color: 0xd9d2c0 }), goalMat = new THREE.MeshBasicMaterial({ color: 0xd4ad3a });
  G.stations.forEach((s, i) => {
    for (const [f, mat] of [[-4, startMat], [4, goalMat]]) { const [x, z] = gymToWorld(i, 0, f), m = new THREE.Mesh(line, mat); m.position.set(x, ground(x, z) + 0.03, z); worldGroup.add(m); }
    const t = canvasTex(512, 128, (g, w, h) => {
      g.fillStyle = 'rgba(28,30,26,0.82)'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d4ad3a'; g.font = 'bold 54px sans-serif'; g.fillText(String(i + 1), 18, 64);
      g.fillStyle = '#ece6d6'; g.font = '34px sans-serif'; g.fillText(s.name.slice(0, 26), 96, 58);
      g.fillStyle = '#b9b3a3'; g.font = '22px sans-serif'; g.fillText((s.plan || '').slice(0, 40), 96, 100);
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t })); const [x, z] = gymToWorld(i, -2.4, -4.5);
    sp.position.set(x, ground(x, z) + 2.1, z); sp.scale.set(2.4, 0.6, 1); worldGroup.add(sp);
  });
}
function gymCell(ci, cj) { // a little grass and litter, plus captured near-field items in this cell
  const r = mulberry32(hash3(ci, cj, 5)), items = [], x0 = ci * NC - HALF, z0 = cj * NC - HALF;
  for (let k = 0; k < 26; k++) { const s = 0.2 + 0.3 * r(); items.push(['grass', x0 + r() * NC, z0 + r() * NC, r() * 6.28, s * 1.6, s, 0.8 + 0.3 * r(), r()]); }
  for (let k = 0; k < 8; k++) { const s = 0.35 + 0.5 * r(); items.push(['litter', x0 + r() * NC, z0 + r() * NC, r() * 6.28, s, s, 0.8 + 0.35 * r(), r()]); }
  for (const it of W.gym.nearItems) if (it[1] >= x0 && it[1] < x0 + NC && it[2] >= z0 && it[2] < z0 + NC) items.push([...it]);
  return items;
}
function goStation(i) {
  const n = W.gym.stations.length; gymAt = ((i % n) + n) % n;
  const [x, z] = gymToWorld(gymAt, 0, -4);
  player.x = x; player.z = z; player.yaw = 0; player.pitch = W.gym.stations[gymAt].pitch ?? -0.12;
  refreshNear(x, z, true); resetRig(); showStation();
}
function showStation() { const s = W.gym.stations[gymAt]; $('hudWorld').textContent = `Gym ${gymAt + 1}/${W.gym.stations.length} · ${s.name}`; $('hudHere').textContent = gymStatus(); }
const gymProgress = () => { const [, oz] = stationOrigin(gymAt); return oz - player.z; };
function gymStatus() { const s = W.gym.stations[gymAt]; return `intended: ${s.plan || '—'} · [ ] or ◀ ▶ to change, R or ↺ to restart`; }
// How deep the body is in any gym solid: each of its capsules (sampled along) against the exact boxes and the rails.
const _gp = new THREE.Vector3();
function gymPen() {
  const C = bodyCapsules(), S = staticCaps(player.x, player.z); let worst = 0, what = '';
  for (let c = 0; c < C.length; c += 7) {
    const R = C[c + 6], a = [C[c], C[c + 1], C[c + 2]], b = [C[c + 3], C[c + 4], C[c + 5]];
    for (const bl of W.gym.blocks) {
      if (!bl._inv || Math.hypot(bl.x - player.x, bl.z - player.z) > 9) continue;
      const hw = bl.size[0] / 2, hh = bl.size[1] / 2, hl = bl.size[2] / 2;
      for (let t = 0; t <= 1.0001; t += 0.125) {
        _gp.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t).applyMatrix4(bl._inv);
        const qx = Math.abs(_gp.x) - hw, qy = Math.abs(_gp.y - hh) - hh, qz = Math.abs(_gp.z) - hl;
        const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0), pen = R - sdf;
        if (pen > worst) { worst = pen; what = `${CAPN[c / 7]} in a box`; }
      }
    }
    for (const q of S) { const h = segSeg(a, b, q.a, q.b), pen = R + q.r - h.d; if (pen > worst) { worst = pen; what = `${CAPN[c / 7]} in a ${q.kind || 'stem'}`; } }
  }
  return { pen: worst, what };
}
// Walk a station straight ahead for `secs` simulated seconds and score it against its intended outcome.
function gymRun(i, secs = 16) {
  goStation(i); const s = W.gym.stations[gymAt], e = s.expect || {}; body.lastVault = null; let vaults = 0, wasV = false, rollMax = 0, cam = 9; const overs = []; let wasO = false;
  const [ox, oz] = stationOrigin(gymAt), pieces = W.trees.filter((t) => t.st === 2 && Math.abs(t.x - ox) < 7 && Math.abs(t.z - oz) < 9).flatMap((t) => t.rest.pieces);
  const toStem = (p) => Math.min(9, ...pieces.map((q) => { // camera to stem surface
    const vx = q.x1 - q.x0, vy = q.y1 - q.y0, vz = q.z1 - q.z0, t = clamp(((p.x - q.x0) * vx + (p.y - q.y0) * vy + (p.z - q.z0) * vz) / (vx * vx + vy * vy + vz * vz), 0, 1);
    return Math.hypot(p.x - q.x0 - vx * t, p.y - q.y0 - vy * t, p.z - q.z0 - vz * t) - q.r;
  }));
  const g0 = ground(player.x, player.z);
  let maxF = -9, maxH = 0, hands = false, lifts = 0, worst = 9, worstAt = '', lifting = false, eyeJump = 0, lastEye = null, pen = 0, penAt = '', duckMax = 0;
  for (let k = 0; k < secs * 60; k++) {
    input.keys.clear(); input.keys.add('KeyW'); if (s.slow) input.keys.add('KeyQ'); movePlayer(1 / 60); physStep(1 / 60); refreshNear(player.x, player.z);
    const f = gymProgress(); maxF = Math.max(maxF, f); maxH = Math.max(maxH, rig.feet - g0);
    if (body.four) hands = true; if (rig.lift && !lifting) lifts++; lifting = !!rig.lift; if (rig.vault && !wasV) vaults++; wasV = !!rig.vault; if (rig.over && !wasO) overs.push(rig.over.mode); wasO = !!rig.over; if (Math.abs(body.roll) > Math.abs(rollMax)) rollMax = body.roll;
    cam = Math.min(cam, toStem(body.eye)); duckMax = Math.max(duckMax, body.duck || 0);
    if (e.solid) { const g = gymPen(); if (g.pen > pen) { pen = g.pen; penAt = `${g.what} at f ${gymProgress().toFixed(1)}`; } }
    if (f >= 5) break; // past the goal: stop before reaching the next row of stations
    if (lastEye !== null) eyeJump = Math.max(eyeJump, Math.abs(player.eye - lastEye)); lastEye = player.eye;
    const J = !rig.vault && !rig.over && body.sol?.J; if (J) for (const nm of ['head', 'neck', 'chest']) { const j = J[nm], c = ceilingAt(j[0], j[2], rig.feet, [0, -1]), gap = c - (j[1] + (nm === 'head' ? 0.11 : 0.06)); if (gap < worst) { worst = gap; worstAt = nm; } }
  }
  input.keys.clear();
  const checks = [];
  if (e.cross) checks.push(['cross', maxF >= 4]);
  if (e.stop) checks.push(['stop', maxF < 1]);
  if (e.stepOn !== undefined) checks.push([`a foot on the top (${e.stepOn} m)`, overs.includes('step on') || maxH >= e.stepOn - 0.05]);
  if (e.height !== undefined) checks.push([`height ≥ ${e.height}`, maxH >= e.height]);
  if (s.maxHeight !== undefined) checks.push([`height ≤ ${s.maxHeight}`, maxH <= s.maxHeight]);
  if (e.solid) checks.push([`solid (deepest ${(pen * 100).toFixed(0)} cm${pen > 0.02 ? ': ' + penAt : ''})`, pen <= 0.02]);
  if (e.clean) checks.push(['clean', worst >= -0.02 && cam >= 0.12]); // no body in a stem; the camera (near plane 0.1 m) keeps clear
  if (e.hands !== undefined) checks.push([e.hands ? 'on hands' : 'on feet', hands === e.hands]);
  if (e.lean) checks.push([`lean ${e.lean}`, e.lean === 'right' ? rollMax > 0.15 : rollMax < -0.15]);
  if (e.vault) checks.push([typeof e.vault === 'string' ? `vault ${e.vault}` : 'vault', (vaults > 0 || overs.includes('vault')) && (typeof e.vault !== 'string' || (body.lastVault?.side < 0 ? 'left' : 'right') === e.vault)]);
  const used = [maxF < 1 ? 'stopped' : 'crossed', ...overs, vaults ? 'old vault' : '', lifts ? 'climbed up' : '', hands ? 'on hands' : '', duckMax > 0.15 ? `ducked ${duckMax.toFixed(2)}` : '', Math.abs(rollMax) > 0.15 ? `leaned ${rollMax > 0 ? 'right' : 'left'}` : ''].filter(Boolean).join(', ');
  return { i: gymAt + 1, name: s.name, mode: s.mode, used, pass: checks.every((c) => c[1]), checks: checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' '),
    reached: +maxF.toFixed(2), height: +maxH.toFixed(2), hands, pullups: lifts, vaults, vaultSide: body.lastVault ? (body.lastVault.side < 0 ? 'left' : 'right') + ` at ${body.lastVault.s}` : '', roll: +rollMax.toFixed(2), clearance: +worst.toFixed(2), clearanceAt: worstAt, camera: +cam.toFixed(2), eyeJump: +eyeJump.toFixed(3), plan: s.plan };
}
$('gPrev').addEventListener('click', () => goStation(gymAt - 1));
$('gNext').addEventListener('click', () => goStation(gymAt + 1));
$('gAgain').addEventListener('click', () => goStation(gymAt));
// Record the obstacles within R m as a gym station, in the frame of where you stand (the start) and look (forward).
function captureSpot(R = 5) {
  if (!W) return;
  const Y = player.yaw, F = [-Math.sin(Y), -Math.cos(Y)], Rt = [Math.cos(Y), -Math.sin(Y)], px = player.x, pz = player.z, g0 = ground(px, pz);
  const q = (v) => Math.round(v * 100) / 100;
  const loc = (x, z) => { const dx = x - px, dz = z - pz; return [q(dx * Rt[0] + dz * Rt[1]), q(dx * F[0] + dz * F[1] - 4)]; };
  const near2 = (x, z, pad = 0) => Math.hypot(x - px, z - pz) < R + pad;
  const feats = [], seen = new Set();
  // ground, as heights relative to where you stand
  const n = 2 * Math.round(R / 0.5) + 1, h = [];
  for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) { const x = (a - (n - 1) / 2) * 0.5, f = (b - (n - 1) / 2) * 0.5; h.push(q(ground(px + x * Rt[0] + f * F[0], pz + x * Rt[1] + f * F[1]) - g0)); }
  feats.push({ grid: { step: 0.5, n, h } });
  for (const t of W.trees) {
    if (t.st === 2 && t.rest) for (const p of t.rest.pieces) {
      if (W.gym && t.gym === undefined) continue;
      // keep the part of the piece within R + 2 m of you
      const vx = p.x1 - p.x0, vz = p.z1 - p.z0, L2 = vx * vx + vz * vz || 1, u = clamp(((px - p.x0) * vx + (pz - p.z0) * vz) / L2, 0, 1);
      if (!near2(p.x0 + vx * u, p.z0 + vz * u, 1)) continue;
      const half = (R + 2) / Math.sqrt(L2), ua = clamp(u - half, 0, 1), ub = clamp(u + half, 0, 1);
      const at = (k) => [p.x0 + vx * k, p.y0 + (p.y1 - p.y0) * k, p.z0 + vz * k], A = at(ua), B = at(ub);
      const r = q((p.rx0 + p.rx1) / 2), rz = (p.rz0 + p.rz1) / 2;
      feats.push({ log: [...loc(A[0], A[2]), q(A[1] - rz - g0), ...loc(B[0], B[2]), q(B[1] - rz - g0)], r });
    }
  }
  for (const map of [colTrunks, saplingCells]) for (const a of map.values()) for (const t of a) {
    const x = t.sap ? t.tx : t.x, z = t.sap ? t.tz : t.z; if (!near2(x, z) || seen.has(t)) continue; seen.add(t);
    feats.push({ trunk: loc(x, z), d: Math.round((t.r - (t.sap ? 0.04 : 0.25)) * 200) });
  }
  const turn = new THREE.Matrix4().makeRotationY(-Y);
  for (const a of solids.values()) for (const o of a) {
    if (seen.has(o)) continue; seen.add(o);
    if (o.kind === 'ell' && near2(o.x, o.z, 1)) { const [x, f] = loc(o.x, o.z), ux = o.ux * Math.cos(Y) - o.uz * Math.sin(Y), uz = o.ux * Math.sin(Y) + o.uz * Math.cos(Y); feats.push({ wad: [x, f, q(o.y - g0)], a: [q(o.ax), q(o.ay), q(o.az)], u: [q(ux), q(uz)] }); }
    if (o.kind === 'mesh' && o.big !== undefined && near2(o.x, o.z, 3)) {
      const M = new THREE.Matrix4().fromArray(o.e); M.elements[12] -= px; M.elements[13] -= g0; M.elements[14] -= pz; M.premultiply(turn);
      const m = M.elements; feats.push({ rock: [q(m[12]), q(-m[14] - 4), q(m[13])], i: o.big, e: m.map((v, k) => (k >= 12 && k <= 14 ? 0 : Math.round(v * 1000) / 1000)) });
    }
  }
  const items = [];
  for (const a of near.cells.values()) for (const it of a) {
    if (!/^(rock|round|twig|stick|limb|tall|shrub)/.test(it[0]) || !near2(it[1], it[2])) continue;
    const [x, f] = loc(it[1], it[2]), yaw = /^(rock|round|tall|shrub)/.test(it[0]) ? it[3] - Y : it[3] + Y;
    items.push([it[0], x, f, q(yaw), ...it.slice(4).map(q)]);
  }
  if (items.length) feats.push({ near: items });
  const st = { name: `Captured ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, features: feats, expect: { cross: true }, plan: '(describe what should happen)',
    from: W.gym ? 'gym' : { seed: W.seed, age: settings.age, moisture: settings.moisture, storms: settings.storms, geology: settings.geology, x: q(px), z: q(pz), yaw: q(Y), rockStyle: W.rockStyle } };
  const txt = JSON.stringify(st);
  const caps = loadCaptures(); caps.push(st); try { localStorage.setItem('foothold.captures', JSON.stringify(caps)); } catch (e) { /* storage unavailable */ }
  const out = $('capOut'); out.hidden = false; out.value = txt;
  try { navigator.clipboard?.writeText(txt).catch(() => {}); } catch (e) { /* no clipboard */ }
  $('hint').textContent = `Spot captured: gym station ${STATIONS.length + caps.length} (the World panel shows its text)`; $('hint').style.opacity = 1; clearTimeout(hintTimer); hintTimer = setTimeout(hideHint, 4000);
  return st;
}
$('bCapture').addEventListener('click', () => captureSpot());

// ---------------------------------------------------------------- player
const player = { x: 0, z: 0, yaw: 0, pitch: -0.05, eye: 0 };
const input = { f: 0, s: 0, run: false, keys: new Set(), stick: null, look: null };
function spawn() {
  if (W.gym) { goStation(gymAt); return; }
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
  resetRig();
}
// ---------------------------------------------------------------- collision
// The body is a small foot (radius FOOT) standing on a "support surface": max(ground, tops of solid things).
//  * walk:     rises up to STEP are taken in stride
//  * scramble: rises up to SCRAMBLE onto a surface flat enough to stand on become a short mantle animation
//  * block:    anything taller with steep sides, natural ground steeper than MAX_SLOPE, and trunks
// Rock tops are sampled from the rock's own geometry (a precomputed top-surface heightfield per mesh), so ledges and
// flat tops hold you where they visibly are. Root wads are ellipsoids, logs are lying cylinders.
// Shrubs, ferns, grass and twigs never block or slow you; the camera rig expresses them instead (see "camera rig").
const SLOW = 1.0, CAREFUL = 0.45; // below SLOW m/s you step onto what is in the way (Q, or a small push of the stick: CAREFUL of a walk)
const STEP = 0.55, SCRAMBLE = 1.35, MAX_SLOPE = 0.95, MAX_GROUND_SLOPE = 1.15, FOOT = 0.22;
let solids = null; // 8 m hash of static solids
let saplingCells = null; // small simulated trees (dbh < 8 cm): stems to walk around, crowns to push
const ckey8 = (x, z) => Math.floor((x + HALF) / 8) * 4096 + Math.floor((z + HALF) / 8);
// A fallen stem as collision: a chain of short segments following exactly what the bark shader draws for it
// (straight axis + sinuosity wobble, lathe-profile taper, vertically slumped cross-section). Short segments also
// register in every grid cell the log crosses.
function logSolids(bx, y0, bz, tx, y1, tz, sx, sz, wob, prof = trunkProfile) {
  const ax = tx - bx, ay = y1 - y0, az = tz - bz, L = Math.hypot(ax, ay, az) || 1, Y = [ax / L, ay / L, az / L];
  let X = [Y[1] * 0 - Y[2] * 1, Y[2] * 0 - Y[0] * 0, Y[0] * 1 - Y[1] * 0]; // Y x UP, as along() builds it
  const lx = Math.hypot(...X); X = lx < 1e-6 ? [1, 0, 0] : X.map((c) => c / lx);
  const Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
  const at = (u) => { // centre of the drawn stem at axial fraction u, and its horizontal / vertical radius
    const y = u * L, env = smoothstep(0, 2, y), bxw = wob[0] * env * Math.sin(wob[1] * y + wob[2]), bzw = wob[0] * env * wob[3] * Math.sin(0.73 * wob[1] * y + 1.3 * wob[2]);
    const pr = prof(u);
    return [bx + ax * u + X[0] * bxw + Z[0] * bzw, y0 + ay * u + X[1] * bxw + Z[1] * bzw, bz + az * u + X[2] * bxw + Z[2] * bzw, sx * pr, sz * pr];
  };
  const n = Math.max(2, Math.ceil(L / 0.8));
  let p = at(0);
  for (let i = 1; i <= n; i++) {
    const q = at(i / n), r = Math.max(p[3], q[3]);
    if (r >= 0.02) addSolid({ kind: 'log', x: (p[0] + q[0]) / 2, z: (p[2] + q[2]) / 2, x0: p[0], z0: p[2], x1: q[0], z1: q[2], ya0: p[1], ya1: q[1], r, r0: p[3], r1: q[3], rz0: p[4], rz1: q[4] }, Math.hypot(q[0] - p[0], q[2] - p[2]) / 2 + r);
    p = q;
  }
}
// A box as an exact solid (the gym's): at any (x, z) it fills one span of height, [lo, hi] (topOf returns hi and leaves lo in
// logUnder/logBottom, as a stem's underside), so what is under a roof is free space, not the inside of a wall.
function boxSolid(b) {
  const R = trs(b.x, b.y, b.z, b.yaw * DEG, 1, 1, 1, b.pitch * DEG, b.roll * DEG).clone(), inv = R.clone().invert(), hw = b.size[0] / 2, h = b.size[1], hl = b.size[2] / 2;
  const o = { kind: 'box', x: b.x, z: b.z, e: Float64Array.from(inv.elements), r: Float64Array.from(R.elements), hw, h, hl, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
  const v = new THREE.Vector3();
  for (const sx of [-hw, hw]) for (const sy of [0, h]) for (const sz of [-hl, hl]) { v.set(sx, sy, sz).applyMatrix4(R); o.x0 = Math.min(o.x0, v.x); o.x1 = Math.max(o.x1, v.x); o.z0 = Math.min(o.z0, v.z); o.z1 = Math.max(o.z1, v.z); o.y0 = Math.min(o.y0, v.y); o.y1 = Math.max(o.y1, v.y); }
  return o;
}
function boxSpan(o, x, z) { // the vertical line at (x, z) through the box: [lo, hi], or null
  const e = o.e, ax = e[0] * x + e[8] * z + e[12], ay = e[1] * x + e[9] * z + e[13], az = e[2] * x + e[10] * z + e[14], bx = e[4], by = e[5], bz = e[6];
  let t0 = -1e9, t1 = 1e9;
  for (const [a, b, lo, hi] of [[ax, bx, -o.hw, o.hw], [ay, by, 0, o.h], [az, bz, -o.hl, o.hl]]) {
    if (Math.abs(b) < 1e-9) { if (a < lo || a > hi) return null; continue; }
    let u = (lo - a) / b, w = (hi - a) / b; if (u > w) [u, w] = [w, u]; t0 = Math.max(t0, u); t1 = Math.min(t1, w); if (t0 > t1) return null;
  }
  return [t0, t1];
}
function addSolid(o, r) {
  if (solidSink) solidSink.push(o);
  if (o.kind === 'mesh' || o.kind === 'box') { // every 8 m cell the world box touches
    for (let ci = Math.floor((o.x0 + HALF) / 8); ci <= Math.floor((o.x1 + HALF) / 8); ci++)
      for (let cj = Math.floor((o.z0 + HALF) / 8); cj <= Math.floor((o.z1 + HALF) / 8); cj++) {
        const k = ci * 4096 + cj; let a = solids.get(k); if (!a) solids.set(k, (a = [])); a.push(o);
      }
    return;
  }
  const seen = new Set();
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
    const k = ckey8(o.x + ox, o.z + oz); if (seen.has(k)) continue; seen.add(k);
    let a = solids.get(k); if (!a) solids.set(k, (a = [])); a.push(o);
  }
}
function ellipsoid(x, y, z, ax, ay, az, ux, uz) { return { kind: 'ell', x, y, z, ax, ay, az, ux, uz }; }

// Top-surface heightfield of a placed mesh, in the WORLD frame: for each cell of a grid over its world x/z footprint,
// the highest point of the transformed surface above it. Rasterising after the transform keeps tilted and
// non-uniformly scaled rocks exact (a local-frame field would shear under tilt). Built lazily, on first contact.
function topField(geo, e, cellSize = 0.08, maxRes = 128) {
  const p = geo.attributes.position, n = p.count, W = new Float32Array(n * 3);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    W[i * 3] = wx; W[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; W[i * 3 + 2] = wz;
    if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
  }
  const res = Math.max(16, Math.min(maxRes, Math.ceil(Math.max(x1 - x0, z1 - z0) / cellSize) + 1));
  const dx = (x1 - x0) / (res - 1), dz = (z1 - z0) / (res - 1), ix = geo.index ? geo.index.array : null, nt = ix ? ix.length : n;
  const H = new Float32Array(res * res).fill(-Infinity);
  for (let t = 0; t < nt; t += 3) {
    const a = (ix ? ix[t] : t) * 3, b = (ix ? ix[t + 1] : t + 1) * 3, c = (ix ? ix[t + 2] : t + 2) * 3;
    const ax = W[a], ay = W[a + 1], az = W[a + 2], bx = W[b], by = W[b + 1], bz = W[b + 2], cx = W[c], cy = W[c + 1], cz = W[c + 2];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(det) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / dx)), i1 = Math.min(res - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / dx));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / dz)), j1 = Math.min(res - 1, Math.ceil((Math.max(az, bz, cz) - z0) / dz));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + i * dx, z = z0 + j * dz;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * ay + l2 * by + l3 * cy, k = j * res + i; if (y > H[k]) H[k] = y;
    }
  }
  return { res, x0, z0, dx, dz, H };
}
function sampleTop(tf, x, z) {
  const gx = (x - tf.x0) / tf.dx, gz = (z - tf.z0) / tf.dz;
  if (gx < 0 || gz < 0 || gx > tf.res - 1 || gz > tf.res - 1) return -Infinity;
  const i = Math.min(tf.res - 2, Math.floor(gx)), j = Math.min(tf.res - 2, Math.floor(gz)), fx = gx - i, fz = gz - j, H = tf.H, r = tf.res;
  const h00 = H[j * r + i], h10 = H[j * r + i + 1], h01 = H[(j + 1) * r + i], h11 = H[(j + 1) * r + i + 1];
  if (h00 > -1e9 && h10 > -1e9 && h01 > -1e9 && h11 > -1e9) return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
  // at the rim, hold the nearest real sample (within half a cell) so edges don't crumble or overhang
  const near = [[h00, (1 - fx) * (1 - fz)], [h10, fx * (1 - fz)], [h01, (1 - fx) * fz], [h11, fx * fz]].filter(([h, w]) => h > -1e9 && w > 0.25);
  return near.length ? Math.max(...near.map(([h]) => h)) : -Infinity;
}
const _bb = new THREE.Box3();
function meshSolid(geo, matrix, x, z) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = _bb.copy(geo.boundingBox).applyMatrix4(matrix); // conservative world box, for cell registration and quick rejects
  return { kind: 'mesh', x, z, geo, e: matrix.elements.slice(), tf: null, x0: bb.min.x, x1: bb.max.x, z0: bb.min.z, z1: bb.max.z };
}
function topOf(o, x, z) {
  if (o.kind === 'box') { if (x < o.x0 || x > o.x1 || z < o.z0 || z > o.z1) return -Infinity; const sp = boxSpan(o, x, z); if (!sp) return -Infinity; logUnder = logBottom = sp[0]; return sp[1]; }
  if (o.kind === 'mesh') {
    if (x < o.x0 || x > o.x1 || z < o.z0 || z > o.z1) return -Infinity;
    return sampleTop(o.tf || (o.tf = topField(o.geo, o.e)), x, z);
  }
  if (o.kind === 'ell') {
    const dx = x - o.x, dz = z - o.z, a = dx * o.ux + dz * o.uz, b = -dx * o.uz + dz * o.ux;
    const q = (a / o.ax) ** 2 + (b / o.az) ** 2;
    return q < 1 ? o.y + o.ay * Math.sqrt(1 - q) : -Infinity;
  }
  const vx = o.x1 - o.x0, vz = o.z1 - o.z0, L2 = vx * vx + vz * vz || 1;
  const t = clamp(((x - o.x0) * vx + (z - o.z0) * vz) / L2, 0, 1);
  const d = Math.hypot(x - (o.x0 + vx * t), z - (o.z0 + vz * t));
  if (o.r0 === undefined) return d < o.r ? lerp(o.ya0, o.ya1, t) + Math.sqrt(o.r * o.r - d * d) : -Infinity;
  const rx = lerp(o.r0, o.r1, t); if (d >= rx) return -Infinity; // tapered, slumped (elliptical) section
  const yc = lerp(o.ya0, o.ya1, t), dz = lerp(o.rz0, o.rz1, t) * Math.sqrt(1 - (d / rx) ** 2);
  logUnder = yc - dz; logBottom = yc - lerp(o.rz0, o.rz1, t);
  return yc + dz;
}
const BRANCH_R = { twig: 0.012, stick: 0.022, limb: 0.032 }; // radius as a fraction of length (matches crookedGeo)
function branchSolid(it) { // fallen branch -> a thin lying cylinder, placed exactly as refreshNear draws it
  const [type, , , , a] = it, r = BRANCH_R[type] * a; if (r < 0.012) return null;
  const [A, B] = woodSeg(it);
  return { kind: 'log', x0: A[0], z0: A[2], x1: B[0], z1: B[2], ya0: A[1], ya1: B[1], r };
}
// Loose dead wood on the ground (twigs, sticks, limbs) is a free rigid body: nothing holds it, so its only resistance is
// its weight. Where it lies: as generated, or (it._mat, it._seg) where it last came to rest after being moved.
function woodMatrix(it) {
  if (it._mat) return _m.copy(it._mat);
  const [type, x, z, yaw, a] = it, gy = ground(x, z), dx = Math.cos(yaw) * a, dz = Math.sin(yaw) * a, dy = ground(x + dx, z + dz) - gy, rr = BRANCH_R[type];
  return along(x, gy + rr * a * 0.8, z, dx, dy, dz, a, a, a);
}
function woodSeg(it) { // its axis (start, end) and radius
  if (it._seg) return it._seg;
  const [type, x, z, yaw, a] = it, r = BRANCH_R[type] * a, gy = ground(x, z), dx = Math.cos(yaw) * a, dz = Math.sin(yaw) * a, gy1 = ground(x + dx, z + dz);
  return [[x, gy + r * 0.8, z], [x + dx * 0.85, gy1 + r * 0.3, z + dz * 0.85], r];
}
function woodColor(it) { const [, , , , , , c, v] = it; return c ? [0.50, 0.40, 0.32] : [0.52 + 0.1 * v, 0.47 + 0.08 * v, 0.40]; }
function bodyWorld(cx, cz) { // the world a free body moves in: a 16 m top surface and the standing trunks
  const n = 33, step = 0.5, x0 = cx - 8, z0 = cz - 8, h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = topSurface(x0 + i * step, z0 + j * step);
  const trunks = [];
  for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) for (const t of colTrunks.get(ckey8(cx + di * 8, cz + dj * 8)) || []) if (!trunks.includes(t)) trunks.push(t);
  const tr = new Float32Array(trunks.length * 3); trunks.forEach((t, k) => tr.set([t.x, t.z, t.r - 0.25], k * 3));
  return { hf: { x0, z0, step, n, h }, trunks: tr };
}
function spawnWood(it) { // the body touched it: loose wood becomes a free object (three segments, so it can bend and snap)
  const [type] = it, [A, B, r] = woodSeg(it), L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]); if (L < 0.02) return;
  const P = (t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t], segs = [0, 1, 2].map((k) => ({ a: P(k / 3), b: P((k + 1) / 3), r, par: k - 1 }));
  const G = near.b[type].mesh.geometry, Mx = woodMatrix(it).clone(), nm3 = new THREE.Matrix3().getNormalMatrix(Mx), v = new THREE.Vector3(), Pa = G.attributes.position.array, Na = G.attributes.normal.array;
  const pos = [], nor = [], seg = [], ax = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], l2 = L * L;
  for (let k = 0; k < Pa.length; k += 3) { v.set(Pa[k], Pa[k + 1], Pa[k + 2]).applyMatrix4(Mx); pos.push(v.x, v.y, v.z); const t = ((v.x - A[0]) * ax[0] + (v.y - A[1]) * ax[1] + (v.z - A[2]) * ax[2]) / l2; seg.push(Math.min(2, Math.max(0, Math.floor(t * 3)))); v.set(Na[k], Na[k + 1], Na[k + 2]).applyMatrix3(nm3).normalize(); nor.push(v.x, v.y, v.z); }
  const col = woodColor(it).map(lin), mat = new THREE.MeshLambertMaterial({ map: tex.bark }); mat.color.setRGB(col[0] * 1.6, col[1] * 1.6, col[2] * 1.6);
  const o = spawnFree(segs, WOOD_FREE.dead(1), [{ pos, nor, uv: Array.from(G.attributes.uv.array), idx: Array.from(G.index.array), seg, mat, key: 'W' }], { tag: { item: it } });
  if (!o) return;
  it._free = o.id; it.solid = null; for (const [nm, k] of it._bi || []) near.b[nm].hide(k);
}
function woodWake(C) { // ground wood the legs (or a low hand) reach is woken as a rigid body
  if (!near?.cells) return;
  const caps = capList(C), ci = Math.floor((player.x + HALF) / NC), cj = Math.floor((player.z + HALF) / NC);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) for (const it of near.cells.get((ci + di) * 4096 + cj + dj) || []) {
    if (!BRANCH_R[it[0]] || it._free !== undefined || (it[1] - player.x) ** 2 + (it[2] - player.z) ** 2 > (it[4] + 1.5) ** 2) continue;
    const [A, B, r] = woodSeg(it);
    for (const c of caps) if (segSeg(c[0], c[1], A, B).d < c[2] + r + 0.01) { spawnWood(it); break; }
  }
}
function nearRockSolid(it) { // near-field rock item -> mesh solid, using exactly the transform refreshNear draws with
  const [type, x, z, yaw, a, , , v] = it, nb = rockBatch(type, v), gy = ground(x, z);
  return meshSolid(nb.mesh.geometry, trs(x, gy - a * 0.25, z, yaw, a * (0.8 + 0.5 * v), a, a * (1.2 - 0.4 * v), (v - 0.5) * 0.3, 0), x, z);
}
function rockSupport(x, z) { // ground and the static solids registered so far (outcrops, when deadfall settles)
  let y = ground(x, z);
  const list = solids.get(ckey8(x, z));
  if (list) for (const o of list) { const t = topOf(o, x, z); if (t > y) y = t; }
  return y;
}
// A stem hung up in a neighbour's crown can pass overhead: where its underside clears a ducking head, you walk
// beneath it (the body stoops and bends its knees to fit, see duckPosture).
// `supportRef` is the height of the feet the query is for (set once per movement step); a stem resting near the ground
// always counts, so lookups a little uphill of the feet still see logs lying there.
const DUCK_MIN = 1.0; // lowest head-top height (above the feet) a stooped, knee-bent walk reaches; below it, hands and knees
let supportRef = Infinity, logUnder = 0, logBottom = 0; // logUnder: a stem's underside at the point asked; logBottom: its lowest, under its axis
let supKind = 'soil', footKind = 'soil'; // what the last supportAt / footSupport stood on: soil, rock or wood
function supportAt(x, z) {
  let y = ground(x, z), kind = 'soil';
  const list = solids.get(ckey8(x, z));
  const clear = Math.max(supportRef, y) + CLEAR4; // y is the ground here; a stem with more headroom under it than that is passed beneath
  if (list) for (const o of list) { logUnder = -Infinity; const t = topOf(o, x, z); if (t > y && logUnder < clear) { y = t; kind = o.kind === 'log' ? 'wood' : o.kind === 'ell' ? 'soil' : 'rock'; } }
  const ci = Math.floor((x + HALF) / NC), cj = Math.floor((z + HALF) / NC);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { // big near-field rocks can overhang their cell
    const items = near?.cells.get((ci + di) * 4096 + cj + dj); if (!items) continue;
    for (const it of items) {
      if (it.solid === undefined) it.solid = /^(rock|round)/.test(it[0]) && it[4] >= 0.18 ? nearRockSolid(it) : BRANCH_R[it[0]] ? branchSolid(it) : null;
      if (!it.solid) continue; // (meshes reject by world box inside topOf, so overhangs into this cell count)
      const t = topOf(it.solid, x, z); if (t > y) { y = t; kind = it.solid.kind === 'log' ? 'wood' : 'rock'; }
    }
  }
  supKind = kind;
  return y;
}
// lowest underside of a stem passing overhead that a duck could get under. With `along` (a heading), a stem rising
// along that heading is the one being climbed, not something overhead, and is skipped.
function ceilingAt(x, z, feet, along) {
  let c = Infinity; const list = solids.get(ckey8(x, z)); if (!list) return c;
  for (const o of list) {
    if (!(o.kind === 'log' && o.r0 !== undefined) && o.kind !== 'box') continue;
    if (along && o.kind === 'log') { const vx = o.x1 - o.x0, vz = o.z1 - o.z0, l = Math.hypot(vx, vz) || 1; if (Math.abs(vx * along[0] + vz * along[1]) / l > 0.85 && Math.abs(o.ya1 - o.ya0) / l > 0.3) continue; }
    logUnder = -Infinity; if (topOf(o, x, z) === -Infinity) continue;
    if (logBottom > feet + CLEAR4 && logUnder < c) c = logUnder; // a stem lower than crawling height is something to go over
  }
  if (body.plan) for (const g of body.plan.ceil) { // stiff plant segments overhead (planScan): their underside where they pass over (x, z)
    const vx = g.B[0] - g.A[0], vz = g.B[2] - g.A[2], l2 = vx * vx + vz * vz, t = l2 > 1e-8 ? clamp(((x - g.A[0]) * vx + (z - g.A[2]) * vz) / l2, 0, 1) : 0;
    if (Math.hypot(g.A[0] + vx * t - x, g.A[2] + vz * t - z) > g.r + 0.12) continue;
    const y = g.A[1] + (g.B[1] - g.A[1]) * t - g.r; if (y > feet + CLEAR4 && y < c) c = y;
  }
  return c;
}
// a top too narrow to stand on (under 0.5 m along the way) with footing within a step either side: stepped over, so neither the
// body's height nor a foothold takes it (a thin wall, a rail). Returns the footing either side instead, or null.
function stepOverAt(x, z, s0, ux, uz) {
  if (!(ux || uz) || body.slow) return null; // (slowly, a foot goes onto it instead: it is assumed to hold you, until it doesn't)
  const a = supportAt(x + ux * 0.47, z + uz * 0.47), b = supportAt(x - ux * 0.47, z - uz * 0.47), lo = Math.max(a, b); // (beyond the foot ring, 0.22, and half a narrow top)
  if (s0 - lo < 0.12 || s0 - lo > STEP) return null; // (it is level ground, or a ledge to climb)
  if (s0 - a < 0.12 || s0 - b < 0.12) return null; // a step up onto something deeper: stood on
  return lo;
}
function footSupport(x, z) { // the highest footing under a foot-sized ring (and what it is: footKind)
  let y = supportAt(x, z), kind = supKind;
  const c = y; for (let k = 0; k < 6; k++) { const a = (k / 6) * 6.283, t = supportAt(x + Math.cos(a) * FOOT, z + Math.sin(a) * FOOT); if (t > y && t - c <= SCRAMBLE) { y = t; kind = supKind; } } // (a wall at the ring's edge is beside you, not under you)
  footKind = kind;
  return y;
}
const feetAt = (x, z) => footSupport(x, z);
const slopeAt = (x, z) => Math.hypot(sampleGrid(W.H, N, x + 1, z) - sampleGrid(W.H, N, x - 1, z), sampleGrid(W.H, N, x, z + 1) - sampleGrid(W.H, N, x, z - 1)) / 2;
const supportGrad = (x, z, e = 0.15) => Math.hypot(supportAt(x + e, z) - supportAt(x - e, z), supportAt(x, z + e) - supportAt(x, z - e)) / (2 * e);
function trunkHit(x, z) { for (const t of nearbyTrunks(x, z)) if (Math.hypot(t.x - x, t.z - z) < t.r) return true; return false; }
function blockedAt(x, z) { return trunkHit(x, z) || footSupport(x, z) - ground(x, z) > SCRAMBLE; }
function nearbyTrunks(x, z) {
  const ci = Math.floor((x + HALF) / 8), cj = Math.floor((z + HALF) / 8), out = [];
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = colTrunks.get((ci + di) * 4096 + cj + dj); if (a) out.push(...a); }
  return out;
}

// ---------------------------------------------------------------- body
// A procedural, mostly unrendered skeleton (after the "drive a few physical variables" approach of David Rosen's
// Overgrowth talk). The collision body above decides where you are; this decides how you are standing there.
//   feet:   plant one at a time on the real support surface; swing on an arc that clears what is underfoot
//   pelvis: as high as both planted legs can reach (leg-length constraint), plus a crouch spring (landings, scrambles)
//   torso:  leans with slope, acceleration, each uphill push-off, reaches and scrambles
//   arms:   swing opposite the legs; reach to push tall shrubs aside, plant on ledges and low barriers
//   head:   rides the torso. The camera is the eye. Like the vestibulo-ocular reflex, it passes only a fraction of the
//           rhythmic gait bounce but all of the terrain-driven motion.
// Everything is in metres and radians. Tuning lives in RIG.
const MOTION = { full: 1, reduced: 0.4, off: 0 };
const RIG = {
  leg: 0.88, hipW: 0.11, spine: 0.5, neck: 0.22, eyeFwd: 0.08, shoulderW: 0.19, upperArm: 0.3, foreArm: 0.32,
  stepWalk: 0.68, stepRun: 1.2, lift: 0.1,
  gaitPass: 0.2,          // share of the rhythmic pelvis bounce and weight shift that reaches the eye
  leanSlope: 0.32, leanPush: 0.55, leanAccel: 0.05, gazeFollow: 0.3, // torso lean per unit uphill gradient, per push-off; camera follows 30% of lean in pitch
  kPelvis: 320, kBase: 160, kLean: 140, kCrouch: 260, kLat: 260, kHand: 160,
  plantK: 55, plantZeta: 0.6, pushReact: 0.08, // shrub stiffness (1/s²) and damping; head shift per metre of unyielded push
};
const body = {
  feet: [{ side: -1 }, { side: 1 }], next: 0, pelvis: new THREE.Vector3(), pvy: 0, base: 0, vbase: 0,
  lean: 0, vlean: 0, crouch: 0, vcrouch: 0, lat: 0, vlat: 0, react: 0, vreact: 0, roll: 0, vroll: 0,
  hands: [{ side: -1, p: new THREE.Vector3(), v: new THREE.Vector3(), target: null }, { side: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), target: null }],
  plants: [], duck: 0, duckLean: 0, duckHold: null, fwd: [0, -1], speed: 0, phase: 0, stems: new Map(), lastVx: 0, lastVz: 0, airborne: false,
  need: 0, needT: 0, four: false, yaw: 0, head: 2, q: null, sol: null, // need: how much the hands are needed (0 walking, 1 on hands); q: the surface frame and limb stepping
};
const newQuad = () => ({ y: undefined, a: [0, 0, -1], R: [1, 0, 0], n: null, S0: [0, 0, 0], dir: 1, sway: 0, vsway: 0, last: -1, wait: 0, comU: 0.2, stats: { lifts: 0, forced: 0, minM: Infinity, short: 0, steps: 0 } });
body.q = newQuad();
const rig = { feet: 0, vy: 0, lift: null, vault: null, over: null }; // lift: pulling up onto a ledge; vault: going over a hurdle
body.veer = 1;
function spring(x, v, target, k, dt, zeta = 1.1) {
  const c = 2 * zeta * Math.sqrt(k), n = Math.ceil(dt / 0.008), h = dt / n;
  for (let i = 0; i < n; i++) { v += (-k * (x - target) - c * v) * h; x += v * h; }
  return [x, v];
}
function resetRig(feetY) { // stand at the player's x, z: on the ground (not a stem hung overhead), or at a given support height
  supportRef = feetY ?? ground(player.x, player.z);
  rig.feet = feetY ?? footSupport(player.x, player.z); rig.vy = 0; rig.lift = null; rig.vault = null; rig.over = null; body.want = null; body.barrier = null; body.overTried = null; overCache = null;
  Object.assign(body, { need: 0, needT: 0, four: false, mix: 0, yaw: player.yaw, head: 2, q: newQuad() }); body.q.n = [0, 1, 0];
  for (const h of body.hands) { h.hold = null; h.sw = null; }
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  for (const f of body.feet) {
    f.x = player.x + rx * f.side * RIG.hipW; f.z = player.z + rz * f.side * RIG.hipW; f.y = supportAt(f.x, f.z);
    Object.assign(f, { sx: f.x, sz: f.z, sy: f.y, tx: f.x, tz: f.z, ty: f.y, t: 1, dur: 0.3, lift: 0, ln: null });
  }
  body.pelvis.set(player.x, rig.feet + RIG.leg - 0.03, player.z); body.pvy = 0;
  body.base = body.pelvis.y; Object.assign(body, { vbase: 0, lean: 0, vlean: 0, crouch: 0, vcrouch: 0, lat: 0, vlat: 0, react: 0, vreact: 0, roll: 0, vroll: 0, plants: [], airborne: false, duck: 0, duckLean: 0, duckHold: null });
  body.stems.clear(); body.cross = null; body.gap = null; body.shimmy = 0; body.shimYaw = undefined; body.shimOn = false; body.shimDir = null;
  for (const h of body.hands) { h.p.set(player.x, rig.feet + 0.9, player.z); h.v.set(0, 0, 0); h.target = null; }
  player.eye = rig.feet + 1.65;
  body.eye = { x: player.x, y: player.eye, z: player.z };
}

// ---- woody stems: anything rooted taller than a leg is something your feet walk around, not through
// ---- solid by default: the plants in your path, read before the body gets there. Every plant segment the body would pass
// through in the next 1.6 m is asked how hard it would have to be pushed to clear the body (the modal model's compliance at
// that point, through every branch to its anchor). What gives under an easy push (PUSH_OK) is walked through and bends;
// what does not is an obstacle: overhead (its underside above 1.2 m) it is ducked under, otherwise it is stepped round.
// Nothing found: the push-back stops you, as before.
const PUSH_OK = 150, PLAN_R = 0.26, PLAN_AHEAD = 1.6;
function planScan(px, pz, ux, uz) {
  const feet = rig.feet, out = { ceil: [], side: [], push: 0, stiff: 0 }, ex = ux * PLAN_AHEAD, ez = uz * PLAN_AHEAD;
  const bx0 = Math.min(px, px + ex) - 0.6, bx1 = Math.max(px, px + ex) + 0.6, bz0 = Math.min(pz, pz + ez) - 0.6, bz1 = Math.max(pz, pz + ez) + 0.6, y0 = feet + 0.1, y1 = feet + 2.0;
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const o of modal.owners) {
    const md = o.md; if (!md || !o.ph) continue; const M = md.M, X = md.X, ws = ownerWs(o), n = Math.min(M.n, ws.length / 7);
    for (let i = 0; i < n; i++) {
      if (M.nodeB[i] < 0) continue; const k = i * 7, r = ws[k + 6];
      const A = [X.a2[i * 3], X.a2[i * 3 + 1], X.a2[i * 3 + 2]];
      q.set(X.q[i * 4], X.q[i * 4 + 1], X.q[i * 4 + 2], X.q[i * 4 + 3]); v.set(ws[k + 3] - ws[k], ws[k + 4] - ws[k + 1], ws[k + 5] - ws[k + 2]).applyQuaternion(q);
      const B = [A[0] + v.x, A[1] + v.y, A[2] + v.z];
      if (Math.max(A[0], B[0]) < bx0 || Math.min(A[0], B[0]) > bx1 || Math.max(A[2], B[2]) < bz0 || Math.min(A[2], B[2]) > bz1 || Math.max(A[1], B[1]) < y0 || Math.min(A[1], B[1]) > y1) continue;
      for (let d = 0.25; d <= PLAN_AHEAD + 1e-6; d += 0.15) {
        const cx = px + ux * d, cz = pz + uz * d, h = segSeg(A, B, [cx, feet + 0.3, cz], [cx, feet + 1.7, cz]);
        if (h.d >= PLAN_R + r) continue;
        const C = MD.compliance(M, i, h.s), need = PLAN_R + r - h.d + 0.05, F = C > 0 ? need / C : Infinity;
        if (F <= PUSH_OK) { out.push++; break; }
        const P = [A[0] + (B[0] - A[0]) * h.s, A[1] + (B[1] - A[1]) * h.s, A[2] + (B[2] - A[2]) * h.s]; out.stiff++;
        const key = (md.keys || (md.keys = new Map())).get(i) || md.keys.set(i, {}).get(i);
        if (P[1] - feet > 1.2) out.ceil.push({ A, B, r }); else out.side.push({ it: key, x: P[0], z: P[2], r: r + 0.04 });
        break;
      }
    }
  }
  return out;
}
function stemObstacles(x, z) {
  const out = [], ci = Math.floor((x + HALF) / NC), cj = Math.floor((z + HALF) / NC);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const items = near?.cells.get((ci + di) * 4096 + cj + dj); if (!items) continue;
    for (const it of items) {
      if (it[0] === 'tall' && it[5] >= 1.2) out.push({ it, x: it[1], z: it[2], r: 0.16 + 0.1 * it[4], h: it[5], R: it[4] * 0.75 });
      else if ((it[0] === 'seedB' || it[0] === 'seedC') && it[5] >= 0.95) out.push({ it, x: it[1], z: it[2], r: 0.07, h: it[5], R: it[4] });
    }
  }
  const si = Math.floor((x + HALF) / 8), sj = Math.floor((z + HALF) / 8);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const a = saplingCells?.get((si + di) * 4096 + sj + dj); if (a) for (const sp of a) out.push({ it: sp, x: sp.x, z: sp.z, r: sp.r, h: sp.h, R: sp.R });
  }
  return out;
}
function steerAround(px, pz, dx, dz) { // bend the step around stems ahead; the side is chosen once per stem
  const step = Math.hypot(dx, dz); if (!step) return [dx, dz];
  const ux = dx / step, uz = dz / step, rx = -uz, rz = ux;
  let lat = 0;
  const obs = stemObstacles(px, pz);
  for (const t of nearbyTrunks(px, pz)) obs.push({ it: t, x: t.x, z: t.z, r: t.r - 0.22 }); // tree trunks: start sidestepping early
  if (body.plan) for (const o of body.plan.side) obs.push(o); // plant segments too stiff to push aside (planScan)
  for (const o of obs) {
    const ox = o.x - px, oz = o.z - pz, f = ox * ux + oz * uz, s = ox * rx + oz * rz, clear = o.r + 0.28;
    if (f < -0.1 || f > 1.8 || Math.abs(s) > clear + 0.25) { body.stems.delete(o.it); continue; }
    let side = body.stems.get(o.it); if (!side) { side = s >= 0 ? -1 : 1; body.stems.set(o.it, side); }
    const need = clear - side * -s; // how far we still have to get past it on the chosen side
    if (need > 0) lat += side * Math.min(1, need / clear) * (1 - Math.max(0, f) / 1.8) * 1.4;
  }
  lat = clamp(lat, -1.2, 1.2);
  const nx = ux + rx * lat, nz = uz + rz * lat, nl = Math.hypot(nx, nz);
  return [(nx / nl) * step, (nz / nl) * step];
}
function stemPushOut(x, z) { // trunks and woody stems: slide around them rather than stopping dead
  for (const t of nearbyTrunks(x, z)) {
    const ex = x - t.x, ez = z - t.z, d = Math.hypot(ex, ez);
    if (d < t.r) { x = t.x + (ex / (d || 1)) * t.r; z = t.z + (ez / (d || 1)) * t.r; }
  }
  for (const o of stemObstacles(x, z)) {
    const ex = x - o.x, ez = z - o.z, d = Math.hypot(ex, ez), r = o.r + 0.2;
    if (d < r) { x = o.x + (ex / (d || 1)) * r; z = o.z + (ez / (d || 1)) * r; }
  }
  return [x, z];
}

// ---------------------------------------------------------------- locomotion
// Three layers, no modes. Surfaces: what a hand or foot can use. The controller: where the body may go, from coarse
// rules about footing, slope, headroom and holds. The body: hands and feet as contacts that step, and the skeleton
// solved over them. Walking, ducking, pulling up onto a ledge, scrambling with hands and crawling along a stem all
// come out of the same rules.
// ---- surfaces: what a hand or foot can use
// The highest surface under a point is the footing; supportAt also reports what it is made of (supKind), which sets
// how steep a path a foot can hold on its own. A stem (fallen or hung up) is also something a hand can close round.
const TRACTION = { soil: MAX_GROUND_SLOPE, rock: MAX_SLOPE, wood: 0.7 }; // steepest path a foot holds without hands
const GRIP_SLOPE = 2.5, PRESS_SLOPE = 1.5; // steepest path with a hand closed round a hold / pressed flat on a surface
const V = SK.vec;
// the stem axis under (x, z) whose centre is nearest height y: axis point, radii, uphill direction and slope
function stemAt(x, z, y, maxDy = 0.9) {
  const list = solids?.get(ckey8(x, z)); if (!list) return null;
  let best = null, bd = maxDy;
  for (const o of list) {
    if (o.kind !== 'log' || o.r0 === undefined) continue;
    const vx = o.x1 - o.x0, vz = o.z1 - o.z0, L2 = vx * vx + vz * vz || 1, tr = ((x - o.x0) * vx + (z - o.z0) * vz) / L2, t = clamp(tr, 0, 1);
    if (tr < -0.05 || tr > 1.05) continue; // past the end of this piece (the stem's end, or the next piece's job)
    const cx = o.x0 + vx * t, cz = o.z0 + vz * t, rx = lerp(o.r0, o.r1, t);
    const d = Math.hypot(x - cx, z - cz); if (d >= rx) continue;
    const cy = lerp(o.ya0, o.ya1, t), e = Math.abs(cy - y) + (t !== tr ? 0.3 : 0); // prefer the piece the point is truly along
    if (e < bd) { const rz = lerp(o.rz0, o.rz1, t); bd = e; best = { o, end: t !== tr, cx, cy, cz, rx, rz, surf: cy + rz * Math.sqrt(1 - (d / rx) ** 2) }; }
  }
  if (!best) return null;
  const o = best.o; let a = [o.x1 - o.x0, o.ya1 - o.ya0, o.z1 - o.z0]; if (a[1] < 0) a = a.map((v) => -v);
  const h = Math.hypot(a[0], a[2]) || 1e-6;
  best.slope = a[1] / h; best.a = V.nrm(a); best.ah = [a[0] / h, a[2] / h];
  best.C = [best.cx, best.cy, best.cz]; best.top = best.cy + best.rz;
  return best;
}
// frame of a stem: a uphill along the axis, R horizontal across it, n away from it (upward)
function stemFrame(st) {
  const a = st.a, R = V.nrm([-st.ah[1], 0, st.ah[0]]), n = V.cross(R, a);
  return n[1] >= 0 ? { a, R, n } : { a, R: R.map((v) => -v), n: n.map((v) => -v) };
}
function stemUnder(x, z, sup) { // the stem whose surface is the footing at height sup under the footprint at (x, z), if any
  for (let k = -1; k < 6; k++) {
    const a = (k / 6) * 6.283, px = k < 0 ? x : x + Math.cos(a) * FOOT, pz = k < 0 ? z : z + Math.sin(a) * FOOT, st = stemAt(px, pz, sup, 0.6);
    if (st && Math.abs(st.surf - sup) < 0.03) return st;
  }
  return null;
}
// How steeply the footing keeps rising (+) or falling (-) along (ux, uz) from (x, z). One bump is a step, not a slope:
// the grade counts only if both halves of the next metre rise (or both fall). Along a stem it is the stem's own slope.
function grade(x, z, sup, ux, uz) {
  let st = stemUnder(x, z, sup);
  if (!st) { const c = stemAt(x, z, sup - 0.15, 0.5); if (c && Math.abs(c.top - sup) < 0.25) st = c; } // on its crown, off the footprint's exact centre
  const gs = st ? st.slope * (ux * st.ah[0] + uz * st.ah[1]) : 0;
  // samples ahead look for footing up to the steepest climbable grade above you (a stem rising ahead is footing,
  // not something overhead to pass under)
  const s0 = supportAt(x, z); supportRef = sup + 0.5 * GRIP_SLOPE;
  const s1 = supportAt(x + ux * 0.5, z + uz * 0.5); supportRef = sup + GRIP_SLOPE;
  const s2 = supportAt(x + ux, z + uz); supportRef = sup;
  const a = (s1 - s0) / 0.5, b = (s2 - s1) / 0.5, g = a > 0 && b > 0 ? Math.min(a, b) : a < 0 && b < 0 ? Math.max(a, b) : 0;
  return Math.abs(gs) > Math.abs(g) ? gs : g; // the stem's own slope, or the sampled one if steeper (both can miss)
}
// The best hand hold within reach: 2 = something to close a hand round (a stem, a sapling, a slim trunk),
// 1 = a surface ahead to press on, 0 = nothing.
function holdsNear(x, z, sup, ux, uz) {
  if (stemUnder(x, z, sup) || stemAt(x, z, sup - 0.15, 0.5)) return 2; // the stem you are on
  for (const d of [0, 0.3, 0.55, 0.8]) for (const w of [0, -0.15, 0.15, -0.3, 0.3]) for (const h of [-0.1, 0.3, 0.7, 1.1]) { // stems are narrow: search across as well as ahead
    const st = stemAt(x + ux * d - uz * w, z + uz * d + ux * w, sup + h, 0.35); if (st && st.rx >= 0.03) return 2;
  }
  for (const t of nearbyTrunks(x, z)) if (t.r < 0.2 && Math.hypot(t.x - x, t.z - z) - t.r < 0.75) return 2;
  for (const o of stemObstacles(x, z)) if (Math.hypot(o.x - x, o.z - z) < 0.75) return 2;
  for (const d of [0.4, 0.7]) { const y = supportAt(x + ux * d, z + uz * d) - sup; if (y > -0.3 && y < 1.4) return 1; }
  return 0;
}

// ---- where the body goes: coarse, forgiving rules from the footing ahead
// Each attempted move is judged on what holding on along it would take. Hands are needed (need = 1) when:
//   the headroom is too low to stoop under (below DUCK_MIN, down to CLEAR4 on hands and knees),
//   a ledge rises more than a step (you pull up onto it, hands on the lip),
//   the path stays steeper than the footing's traction (TRACTION).
// Then the best hold within reach sets how steep you may go: a hand closed round something (GRIP_SLOPE) or pressed
// flat (PRESS_SLOPE). With the hands needed you move slowly, and only as fast as the limbs can keep hold (quadAllows).
const CLEAR4 = 0.42; // lowest headroom (above the feet) crawling, hips and head low
const GAIT4 = { stride: 0.5, swing: 0.13, speed: 1.0, climb: 1.5, homes: [0.72, 0.72, -0.3, -0.3] }; // limbs LH RH LF RF
const LIMB = [{ hand: true, side: -1 }, { hand: true, side: 1 }, { hand: false, side: -1 }, { hand: false, side: 1 }];
// The body's footprint must fit, not just its centre: points across the shoulders, and ahead where the legs and arms
// reach, must have no solid between a step up and the lowest headroom the body can pass under (crawling). A wall at the
// side stops you before an arm is in it; a roof too low to crawl under stops you before the legs are under it.
let colWhy = ''; // (what blocked the last column asked: for tests)
function colBlocked(px, pz, lo, hi) { // is any solid in the column at (px, pz) between heights lo and hi?
  for (const t of nearbyTrunks(px, pz)) if (Math.hypot(t.x - px, t.z - pz) < t.r - 0.25) { colWhy = 'trunk'; return true; } // (the bark itself: t.r carries the body's own 0.25 m, for its centre)
  for (const o of solids.get(ckey8(px, pz)) || []) {
    logUnder = -Infinity; const t = topOf(o, px, pz); if (t === -Infinity) continue;
    const b = o.kind === 'box' || (o.kind === 'log' && o.r0 !== undefined) ? logUnder : -Infinity; // meshes (rocks) are solid to the ground
    if (t > lo && b < hi) { colWhy = `${o.kind} top ${(t - lo).toFixed(2)} above the band's foot, bottom ${b === -Infinity ? 'ground' : (b - lo).toFixed(2)}`; return true; }
  }
  return false;
}
const BODY_PROBES = [[0, -0.24], [0, 0.24], [0.15, -0.28], [0.15, 0.28], [0.3, 0], [0.3, -0.28], [0.3, 0.28], [0.45, 0], [0.45, -0.28], [0.45, 0.28]]; // the shoulders, and where the knees reach
function ledgeAt(px, pz, ux, uz, feet) { // a top you can climb onto (and stand up on): it is not a wall to the body coming at it
  const t = supportAt(px, pz); if (t - feet <= STEP || t - feet > SCRAMBLE) return false;
  if (Math.abs(supportAt(px + ux * 0.35, pz + uz * 0.35) - t) > 0.1) return false;
  return !colBlocked(px, pz, t + 0.05, t + CLEAR4);
}
// Sideways (a shimmy): the shoulders lie along the way, the body 0.28 m deep across it; it needs 1.3 m of headroom
const SHIMMY_PROBES = [-0.26, -0.13, 0, 0.13, 0.26, 0.4, 0.55, 0.7].flatMap((a) => [-0.19, 0, 0.19].map((l) => [a, l])); // the body sideways, 0.4 m deep (the hips), from behind the shoulder to past the lead knee: a gap to go through, not a wall to face
// A narrow gap steers you: scanned across the way at 0.5, 0.8 and 1.1 m ahead, the free run (at least 0.38 m wide, up to 1.3 m
// of headroom) nearest the line you are on gives the gap's centre there; two or more give its axis. Returns { dir, at } or null.
function gapAhead(px, pz, ux, uz, feet) {
  const rx = -uz, rz = ux, lo = feet + STEP + 0.02, hi = feet + 1.3, cs = [];
  for (const d of [0.5, 0.8, 1.1]) {
    let best = null, run = null;
    for (let l = -0.9; l <= 0.9001; l += 0.05) {
      const free = !colBlocked(px + ux * d + rx * l, pz + uz * d + rz * l, lo, hi);
      if (free) { if (!run) run = [l, l]; else run[1] = l; }
      if ((!free || l > 0.9) && run) { const w = run[1] - run[0]; if (w >= 0.33 && w <= 0.6 && run[0] > -0.9 && l <= 0.9) { const c = (run[0] + run[1]) / 2; if (best === null || Math.abs(c) < Math.abs(best)) best = c; } run = null; } // (a gap: solid both sides, open ground is not one)
    }
    if (best !== null) cs.push([px + ux * d + rx * best, pz + uz * d + rz * best]);
  }
  if (cs.length < 2) return null;
  const a = cs[0], b = cs[cs.length - 1], gx = b[0] - a[0], gz = b[1] - a[1], gl = Math.hypot(gx, gz) || 1;
  return { dir: [gx / gl, gz / gl], at: a };
}
// The gap plan. Started when the body facing the way would not fit 0.35 m on but a narrow gap lies ahead; it measures the gap once
// (its centre line, and its mouth: the first point along that line where the side-on body's flanks meet solid) and then runs:
// 'approach' (walk to a point on the centre line 0.7 m before the mouth), 'turn' (side-on, in place), 'through' (side-step along
// the axis until the body facing the way fits again), then lets go. Letting go of the stick, or steering away, cancels it.
function gapPlan(px, pz, dx, dz, dt) {
  const l = Math.hypot(dx, dz); if (!l || body.four) { endGap(); return []; }
  const ux = dx / l, uz = dz / l; let G = body.gap;
  if (G && ux * G.dir[0] + uz * G.dir[1] < 0.3) { endGap(); G = null; } // steering away
  if (!G) {
    if (!bodyBlocked(px + ux * 0.35, pz + uz * 0.35, ux, uz, rig.feet)) return [];
    const g = gapAhead(px, pz, ux, uz, rig.feet); if (!g || g.dir[0] * ux + g.dir[1] * uz < 0.6) return [];
    const [gx, gz] = g.dir, nx = -gz, nz = gx, lo = rig.feet + STEP + 0.02, hi = rig.feet + 1.3; let mouth = null;
    for (let s = -1.2; s <= 0.4; s += 0.05) { const cx = g.at[0] + gx * s, cz = g.at[1] + gz * s; if (colBlocked(cx + nx * 0.3, cz + nz * 0.3, lo, hi) || colBlocked(cx - nx * 0.3, cz - nz * 0.3, lo, hi)) { mouth = [cx, cz]; break; } }
    if (!mouth || !shimmyFits(mouth[0] + gx * 0.1, mouth[1] + gz * 0.1, gx, gz, rig.feet)) return [];
    G = body.gap = { dir: g.dir, entry: [mouth[0] - gx * 0.7, mouth[1] - gz * 0.7], phase: 'approach', clear: 0 }; // (0.7 m short of it: room to turn and re-step clear of its corners)
  }
  const [gx, gz] = G.dir;
  if (G.phase === 'approach') {
    const tx = G.entry[0] - px, tz = G.entry[1] - pz, d = Math.hypot(tx, tz);
    if (d < 0.03) G.phase = 'turn'; else { const k = Math.min(l, d) / d; return [[tx * k, tz * k, 0]]; }
  }
  body.shimmy = (body.shimmy || 0) + dt; body.shimDir = [gx, gz]; // side-on from here
  if (G.phase === 'turn') { if ((body.shimTurn ?? 1) < 0.12) G.phase = 'through'; else return [[0, 0, 0]]; }
  // through: along the axis at a side-step's pace; done once the body facing the way fits again
  G.clear = !bodyBlocked(px, pz, gx, gz, rig.feet) && !bodyBlocked(px - gx * 0.4, pz - gz * 0.4, gx, gz, rig.feet) ? G.clear + dt : 0; // (the trailing side out too: it turns back to the view only once wholly clear)
  if (G.clear > 0.3) { endGap(); return []; }
  return [[gx * l * 0.45, gz * l * 0.45, 0]];
}
// Squaring up to a barrier you step over: within a metre of a thin top ahead, the way across it is found (the direction, within
// 70 degrees of yours, in which the raised part is thinnest: its normal) and held: the body turns to face along it and crosses
// along it, so the legs lift forward over it, then lets go 0.5 m beyond. Steering well away cancels it.
function crossPlan(px, pz, dx, dz) {
  const l = Math.hypot(dx, dz); let C = body.cross; if (!l || body.four || body.gap) { body.cross = null; return null; }
  const ux = dx / l, uz = dz / l;
  if (C) { const beyond = (px - C.at[0]) * C.dir[0] + (pz - C.at[1]) * C.dir[1]; if (beyond > 0.5 || ux * C.dir[0] + uz * C.dir[1] < 0.2) { body.cross = null; C = null; } }
  if (!C) {
    let at = null; for (let d = 0.2; d <= 1.0; d += 0.05) { const x = px + ux * d, z = pz + uz * d, s0 = supportAt(x, z); if (s0 - rig.feet > 0.12) { if (stepOverAt(x, z, s0, ux, uz) !== null) at = [x, z]; break; } }
    if (!at) return null;
    // its near edge where two lines 0.3 m either side of yours first meet it; the way across is square to that edge
    const rx = -uz, rz = ux, edge = (q) => { for (let t = -0.3; t <= 1.3; t += 0.01) if (supportAt(px + rx * q + ux * t, pz + rz * q + uz * t) - rig.feet > 0.12) return t; return null; };
    const t1 = edge(-0.3), t2 = edge(0.3); if (t1 === null || t2 === null) return null;
    const ex = rx * 0.6 + ux * (t2 - t1), ez = rz * 0.6 + uz * (t2 - t1), el = Math.hypot(ex, ez); let nx = ez / el, nz = -ex / el; if (nx * ux + nz * uz < 0) { nx = -nx; nz = -nz; }
    if (nx * ux + nz * uz < Math.cos(1.2)) return null;
    C = body.cross = { dir: [nx, nz], at };
  }
  return [C.dir[0] * l, C.dir[1] * l];
}
function endGap() { if (body.gap) { body.gap = null; body.shimmy = 0; } }
function shimmyFits(x, z, ux, uz, feet) {
  const lo = feet + STEP + 0.02, hi = feet + 1.3, rx = -uz, rz = ux;
  for (const [a, l] of SHIMMY_PROBES) if (colBlocked(x + ux * a + rx * l, z + uz * a + rz * l, lo, hi)) return false;
  return true;
}
function bodyBlocked(x, z, ux, uz, feet) {
  const lo = feet + STEP + 0.02, hi = feet + CLEAR4, rx = -uz, rz = ux, wk = body.four ? 0.24 / 0.28 : 1; // (on hands, 0.48 m wide: a 0.5 m gap)
  for (const [f, l0] of BODY_PROBES) { const l = l0 * wk, px = x + ux * f + rx * l, pz = z + uz * f + rz * l; if (colBlocked(px, pz, lo, hi) && !(f > 0 && ledgeAt(px, pz, ux, uz, feet))) return true; }
  return false;
}
// a foothold the leg can reach: nothing solid over it, or halfway back to the body, from just above the foot to the hip
function legRoom(x, z, s) { // (every 10 cm from the body to the foothold: a thin wall between them is in the way)
  const lo = s + 0.55, hi = s + 0.85, n = Math.max(1, Math.ceil(Math.hypot(x - player.x, z - player.z) / 0.1));
  for (let k = 1; k <= n; k++) if (colBlocked(lerp(player.x, x, k / n), lerp(player.z, z, k / n), lo, hi)) return false;
  return true;
}
function assess(x, z, px, pz) {
  let sup = footSupport(x, z); const kind = footKind; { const mx = x - px, mz = z - pz, ml = Math.hypot(mx, mz); if (ml > 1e-6) { const so = stepOverAt(x, z, sup, mx / ml, mz / ml); if (so !== null) sup = so; } }
  const rise = sup - rig.feet;
  if (rise > SCRAMBLE || trunkHit(x, z)) return null;
  const mx = x - px, mz = z - pz, ml = Math.hypot(mx, mz) || 1, ux = mx / ml, uz = mz / ml;
  const U = [ux, uz], head = Math.min(ceilingAt(x, z, sup, U), ceilingAt(x + ux * 0.45, z + uz * 0.45, sup, U), body.four ? ceilingAt(x + ux * 0.9, z + uz * 0.9, sup, U) : Infinity) - sup;
  if (head < CLEAR4) return null; // on hands, the head and chest are well ahead of the hips
  let headAhead = head; // the hands come down before the head gets there
  for (const d of [0.7, 0.95, 1.2]) headAhead = Math.min(headAhead, ceilingAt(x + ux * d, z + uz * d, sup, U) - sup);
  if (body.four && rise < -1.0) return null; // holding on, you don't let go over a drop
  supportRef = sup; const g = grade(x, z, sup, ux, uz); supportRef = rig.feet;
  const tf = TRACTION[kind] ?? MAX_SLOPE;
  let need = (headAhead < DUCK_MIN && !overPlan) || rise > STEP || g > tf ? 1 : 0, hold = 0;
  if (g < -tf) { hold = holdsNear(x, z, sup, ux, uz); if (hold === 2) need = 1; } // steep going down: face in if there is a hold, else step down as best you can
  if (need) {
    hold = hold || holdsNear(x, z, sup, ux, uz);
    if (g > (hold === 2 ? GRIP_SLOPE : hold === 1 ? PRESS_SLOPE : tf)) return null;
    if (rise > STEP && !hold) return null;
  }
  return { sup, rise, need, g, head, hold };
}
// A hurdle: something too high to step over but thin, with footing beyond near your level. Its top is read along
// several lines across the body's width; you go over where it is lowest, hands on the top and legs swung over that
// side (a "lazy vault"). Deeper things are ledges (pulled up onto); taller ones are climbed or crawled under.
const VAULT_MAX = 1.15, VAULT_DEPTH = 0.9;
function hurdleAhead(px, pz, ux, uz, reach = 0.75) {
  // read as solid: a stem overhead counts as part of the obstacle (going over it is the question here); the footing
  // under it (a lower stem, a rock) can carry a step on the way over: the top is judged from the highest such step
  const rx = -uz, rz = ux, feet = rig.feet, ref = supportRef; let best = null;
  const solidAt = (x, z) => { supportRef = feet + 2; const y = supportAt(x, z); supportRef = feet; return y; };
  for (const s of [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6]) {
    let d0 = -1, d1 = -1, top = 0, foot = 0, ok = true;
    for (let d = 0.1; d <= reach + VAULT_DEPTH + 0.4; d += 0.06) {
      const x = px + ux * d + rx * s, z = pz + uz * d + rz * s;
      if (trunkHit(x, z)) { ok = false; break; }
      const r = solidAt(x, z) - feet;
      if (d0 < 0) { if (r > STEP) { d0 = d; top = r; } else if (d > reach) { ok = false; break; } }
      else if (r > STEP) { top = Math.max(top, r); if (d - d0 > VAULT_DEPTH) { ok = false; break; } }
      else { d1 = d; break; }
      if (d0 >= 0) { const f = supportAt(x, z) - feet; if (f <= STEP && f > foot) foot = f; } // a step within the obstacle
    }
    if (!ok || d1 < 0 || top - foot > VAULT_MAX || top > VAULT_MAX + STEP || stemAlong(px + ux * (d0 + d1) / 2 + rx * s, pz + uz * (d0 + d1) / 2 + rz * s, ux, uz)) continue;
    const dl = d1 + 0.4, lx = px + ux * dl + rx * s, lz = pz + uz * dl + rz * s;
    if (trunkHit(lx, lz)) continue;
    const land = footSupport(lx, lz) - feet; if (land > STEP || land < -1.2) continue;
    if (ceilingAt((px + lx) / 2, (pz + lz) / 2, feet + top - 0.3) < feet + top + 0.9) continue; // no room above the top
    const score = top - 0.5 * foot + 0.05 * Math.abs(s);
    if (!best || score < best.score) {
      const dm = (d0 + d1) / 2;
      best = { s, top, foot, d0, score, lx, lz, ly: feet + land, cx: px + ux * dm + rx * s, cz: pz + uz * dm + rz * s, rx, rz };
    }
  }
  supportRef = ref;
  return best;
}
// Can you get under what is overhead ahead? Crawling height between the floor and the stem all the way through, and
// no rise along the floor too big to step.
function underOK(px, pz, ux, uz) {
  const feet = rig.feet, U = [ux, uz];
  for (let d = 0.2; d <= 1.8; d += 0.1) {
    const x = px + ux * d, z = pz + uz * d, c = ceilingAt(x, z, feet, U); if (c === Infinity) continue;
    const fl = supportAt(x, z);
    if (fl - feet > STEP || c - fl < CLEAR4) return false;
  }
  return true;
}
let overPlan = null; // going over something ahead: its overhead part is not ducked under
function stemAlong(x, z, ux, uz) { // a stem under (x, z) running within ~50° of the way you go: climbed, not vaulted
  const list = solids.get(ckey8(x, z)); if (!list) return false;
  for (const o of list) {
    if (o.kind !== 'log' || topOf(o, x, z) === -Infinity) continue;
    const vx = o.x1 - o.x0, vz = o.z1 - o.z0, l = Math.hypot(vx, vz) || 1;
    if (Math.abs(vx * ux + vz * uz) / l > 0.65) return true;
  }
  return false;
}
function startVault(px, pz, h) {
  const side = h.s > 0 ? 1 : h.s < 0 ? -1 : (body.veer || 1), topY = rig.feet + h.top, dur = 0.55 + 0.45 * h.top + 0.3 * h.foot;
  // with a step on the way (h.foot), the body rises onto it and over the rest
  rig.vault = { x0: px, z0: pz, y0: rig.feet, cx: h.cx, cz: h.cz, lx: h.lx, lz: h.lz, ly: h.ly, topY, side, rx: h.rx, rz: h.rz, arc: h.foot + Math.max(0, h.top - h.foot - 0.45) * 0.55, t: 0, dur };
  body.q.stats.vaults = (body.q.stats.vaults || 0) + 1; body.lastVault = { side, s: h.s, top: h.top };
  const n = V.nrm([h.rx * side * 0.8, 1, h.rz * side * 0.8]); // the legs swing over, out to that side
  for (const ft of body.feet) {
    const lead = ft.side === side;
    startSwing(ft, h.lx + h.rx * ft.side * RIG.hipW, h.lz + h.rz * ft.side * RIG.hipW, dur * (lead ? 0.8 : 0.95));
    ft.ln = n; ft.lift = Math.max(0.2, topY + 0.12 - Math.max(ft.sy, ft.ty));
  }
}
// ---- ways over a barrier (docs/movement.md): templates fitted to the barrier's numbers, then checked in full
// A barrier is measured along its normal from your side: its top H above your footing, its depth D, the footing beyond
// (L, relative to yours), the clearance C above its top and the span W along it at that height. Each way over is a
// script of key poses in the barrier's frame (a: along the normal from its near face, y: up from your footing, s: along
// it, to the right): the pelvis and its frame, the spine's bend, where the feet, hands, knees and elbows go. A way is
// tried only where the numbers allow it (the rules), and then taken only if the whole script, solved pose by pose,
// keeps every body capsule out of every solid (a template that fits). The first that fits, in order of effort, is done.
const OVER_S = RIG.leg - 0.04, OVER_A = 0.06; // pelvis above the feet standing; an ankle above its footing
function colSpans(x, z) { // the solids in the column at (x, z): [bottom, top] of each (rocks reach the ground)
  const out = [];
  for (const o of solids.get(ckey8(x, z)) || []) { logUnder = -Infinity; const t = topOf(o, x, z); if (t === -Infinity) continue; out.push([o.kind === 'box' || (o.kind === 'log' && o.r0 !== undefined) ? logUnder : -Infinity, t]); }
  return out;
}
function barrierTop(x, z, feet) { // the top of what rises from your footing here (not something overhead), above the feet
  let y = supportAt(x, z); for (const [lo, hi] of colSpans(x, z)) if (lo < feet + 1.2 && hi > y) y = hi; return y - feet;
}
function barrierAt(px, pz, ux, uz, reach = 1.1) {
  const feet = rig.feet, h = (x, z) => barrierTop(x, z, feet), rx = -uz, rz = ux;
  const edge = (q, x0 = px, z0 = pz, vx = ux, vz = uz) => { const wx = -vz, wz = vx; for (let t = 0; t <= reach; t += 0.02) if (h(x0 + wx * q + vx * t, z0 + wz * q + vz * t) > STEP) return t; return null; };
  if (edge(0) === null) return null;
  // the normal: square to the near edge where lines 0.25 m either side of yours meet it
  const t1 = edge(-0.25), t2 = edge(0.25); let nx = ux, nz = uz;
  if (t1 !== null && t2 !== null) { const ex = rx * 0.5 + ux * (t2 - t1), ez = rz * 0.5 + uz * (t2 - t1), el = Math.hypot(ex, ez); nx = ez / el; nz = -ex / el; if (nx * ux + nz * uz < 0) { nx = -nx; nz = -nz; } }
  if (nx * ux + nz * uz < 0.5) return null;
  const sx = -nz, sz = nx, dist = edge(0, px, pz, nx, nz); if (dist === null) return null;
  const O = [px + nx * dist, pz + nz * dist], at = (a, s) => [O[0] + nx * a + sx * s, O[1] + nz * a + sz * s];
  let H = 0, D = 0;
  for (const s of [-0.2, 0, 0.2]) { let a = 0; for (; a < 0.6; a += 0.02) { const v = h(...at(a + 0.01, s)); if (v <= 0.3) break; H = Math.max(H, v); } D = Math.max(D, a); }
  if (D >= 0.5) return null; // something deep enough to stand on: a ledge to climb onto, not a barrier
  const L = Math.min(footSupport(...at(D + 0.35, 0)), footSupport(...at(D + 0.5, 0))) - feet;
  let C = Infinity; // headroom above the top, over it and a little either side
  for (let a = -0.3; a <= D + 0.3; a += 0.05) for (const [lo] of colSpans(...at(a, 0))) if (lo > feet + H - 0.02) C = Math.min(C, lo - feet - H);
  let W = 0; // the span along it at that height, open above
  for (const sd of [-1, 1]) { let s = 0.05; for (; s <= 1.0; s += 0.05) { const [x, z] = at(D / 2, s * sd); if (Math.abs(h(x, z) - H) > 0.12 || colBlocked(x, z, feet + H + 0.06, feet + H + 0.9)) break; } W += s - 0.05; }
  return { O, n: [nx, nz], r: [sx, sz], H, D, L, C, W, dist, y0: feet };
}
// mirrored scripts: s flips sign, left and right limbs swap, roll and twist reverse
const OV_UP = [0, 1, 0], OV_N = [1, 0, 0], OV_S = [0, 0, 1];
function overScript(mode, B) {
  const { H, D, L } = B, S = OVER_S, A = OVER_A, ks = [];
  const k = (t, o) => ks.push({ t, ...o });
  const stand = (a, y, fy, F = OV_N) => ({ pel: [a, y + S, 0], U: OV_UP, F, bend: [0, 0, 0], ft: F === OV_N ? [[a, fy + A, -0.11], [a, fy + A, 0.11]] : [[a + 0.11 * (F[0] === 0 ? F[2] : 1), fy + A, 0], [a - 0.11 * (F[0] === 0 ? F[2] : 1), fy + A, 0]] });
  const hang = (p, F = OV_N) => F === OV_N ? [[p[0] + 0.04, p[1] - 0.05, -0.23], [p[0] + 0.04, p[1] - 0.05, 0.23]] : [[p[0] + 0.23, p[1] - 0.05, p[2]], [p[0] - 0.23, p[1] - 0.05, p[2]]];
  const kF = [[1, 0.6, 0], [1, 0.6, 0]], eB = [[-1, -0.6, -0.5], [-1, -0.6, 0.5]], eUp = [[-0.6, 0.8, -0.4], [-0.6, 0.8, 0.4]], kS = [[0, 0.6, 1], [0, 0.6, 1]], eS = [[0.5, -0.6, -1], [-0.5, -0.6, -1]];
  const far = (y) => Math.max(L + A, y); // a foot hanging beyond, no lower than the footing there
  if (mode === 'high step') { // the lead knee lifts the foot over the top; a small hop carries the hips over it while the trailing leg lifts out to the side (a hurdler's trail leg), and the lead foot lands beyond
    const s0 = stand(-0.36, 0, 0), up = [0.1, 0.7, -0.7], out = [0.15, 0.25, 1]; k(0.12, { ...s0, hd: hang(s0.pel), kp: [[0.6, 0.5, -0.5], kF[1]], ep: eB }); // (up: the lead knee rises out to its side, not forward into the face)
    k(0.22, { pel: [-0.35, S - 0.02, 0.02], ft: [[-0.34, 0.4, -0.12], s0.ft[1]], kp: [up, kF[1]] });
    k(0.32, { ft: [[-0.12, H + 0.17, -0.12], s0.ft[1]] });
    k(0.42, { pel: [-0.18, S + 0.04, 0.02], bend: [0.12, 0, 0], ft: [[D / 2, H + 0.2, -0.12], [-0.36, A + 0.08, 0.11]], kp: [up, out] });
    k(0.47, { pel: [-0.06, H + 0.21, 0.01], bend: [0.16, 0, 0], ft: [[D + 0.16, H + 0.13, -0.12], [-0.2, H - 0.2, 0.25]], kp: [[0.6, 0.6, -0.4], out] });
    k(0.53, { pel: [D - 0.03, H + 0.22, 0], bend: [0.2, 0, 0], ft: [[D + 0.22, L + A + 0.1, -0.12], [-0.08, H + 0.1, 0.32]], kp: [kF[0], out] });
    k(0.6, { pel: [D + 0.03, Math.max(H + 0.2, L + S + 0.04), 0], ft: [[D + 0.25, L + A, -0.12], [D / 2, H + 0.2, 0.3]] });
    k(0.67, { ft: [[D + 0.25, L + A, -0.12], [D + 0.17, H + 0.13, 0.26]] });
    k(0.74, { pel: [D + 0.12, L + S, 0], bend: [0.08, 0, 0], ft: [[D + 0.25, L + A, -0.12], [D + 0.32, L + A + 0.06, 0.13]], kp: kF });
    const s1 = stand(D + 0.3, L, L); k(1, { ...s1, hd: hang(s1.pel) });
    return { ks, dur: 1.6 };
  }
  if (mode === 'step on') { // approached slowly: the lead foot onto the top, weight onto it (hands on the top too if it is high), the trailing leg over and down beyond, then the lead foot off
    const s0 = stand(-0.36, 0, 0), hands = H > 0.55, up = [0.1, 0.7, -0.7], top = [[0.04, H + 0.05, -0.24], [0.04, H + 0.05, 0.24]], ride = Math.min(H + 0.5, L + S + 0.1);
    k(0.1, { ...s0, bend: [hands ? 0.25 : 0.1, 0, 0], hd: hands ? [[-0.12, H + 0.15, -0.24], [-0.12, H + 0.15, 0.24]] : hang(s0.pel), kp: kF, ep: hands ? eUp : eB }); // (the hands rise above the top before reaching onto it)
    k(0.2, { ft: [[-0.34, Math.min(0.4, H * 0.55), -0.12], s0.ft[1]], kp: [up, kF[1]], ...(hands ? { hd: top } : {}) }); // the lead knee lifts, out to its side (not forward into the face)
    k(0.32, { pel: [-0.35, S - 0.02, 0.02], ft: [[-0.12, H + 0.17, -0.12], s0.ft[1]] }); // clear of the face, up to the top
    k(0.36, { ft: [[Math.min(D / 2, 0.08), H + 0.14, -0.1], s0.ft[1]], kp: [[0.6, 0.6, -0.4], kF[1]] }); // over it
    k(0.4, { ft: [[Math.min(D / 2, 0.1), H + A, -0.1], s0.ft[1]] }); // planted on it
    const out = [0.15, 0.25, 1], fx = Math.min(D / 2, 0.1); // (out: the trailing knee lifts out to its side, a hurdler's trail leg, clear of the near face)
    k(0.52, { pel: [fx - 0.2, Math.min(ride, H + 0.35), 0.03], bend: [0.3, 0, 0], ft: [[fx, H + A, -0.1], [-0.3, A + 0.1, 0.12]], kp: [kF[0], out] }); // weight on it: up over the foot, the trailing foot on its toes
    k(0.6, { pel: [fx - 0.08, ride, 0.03], ft: [[fx, H + A, -0.1], [-0.26, H - 0.15, 0.3]] }); // the trailing foot off the ground, lifted out to the side
    k(0.68, { pel: [D / 2, ride, 0.02], ft: [[fx, H + A, -0.1], [D / 2, H + 0.25, 0.3]], kp: [[0.3, 1, -0.3], out], ...(hands ? { hd: [[D / 2, H + 0.22, -0.26], [D / 2, H + 0.22, 0.26]] } : {}) }); // the trailing foot over the top beside it (the hands leave the top upward)
    k(0.78, { pel: [D + 0.08, Math.max(L + S - 0.04, ride - 0.12), 0], bend: [0.2, 0, 0], ft: [[fx, H + A, -0.1], [D + 0.34, far(L + A + 0.08), 0.14]], kp: [[0.3, 1, -0.3], kF[1]], ...(hands ? { hd: hang([D + 0.08, ride, 0]) } : {}) }); // reaching down beyond
    k(0.86, { pel: [D + 0.18, L + S - 0.02, 0], ft: [[D / 2 + 0.1, H + 0.12, -0.1], [D + 0.3, L + A, 0.12]] }); // down beyond, the lead foot leaves the top
    k(0.9, { ft: [[D + 0.2, H + 0.08, -0.11], [D + 0.3, L + A, 0.12]] }); // (forward off the far edge before down)
    k(0.95, { ft: [[D + 0.28, Math.max(L + A + 0.08, H * 0.4), -0.11], [D + 0.3, L + A, 0.12]] });
    const s1 = stand(D + 0.32, L, L); k(1, { ...s1, hd: hang(s1.pel), ep: eB });
    return { ks, dur: 2.2, onTop: [0.4, 0.86] };
  }
  if (mode === 'vault') { // the hands on the top, a spring, and the legs together swung up and over out to one side (left, unmirrored)
    const s0 = stand(-0.42, 0, 0), top = [[D / 2, H + 0.05, -0.1], [D / 2, H + 0.05, 0.22]], sideK = [[0, 0.4, -1], [0, 0.4, -1]];
    k(0.08, { ...s0, bend: [0.2, 0, 0], hd: [[-0.14, H + 0.14, -0.18], [-0.14, H + 0.14, 0.2]], kp: kF, ep: eUp }); // (the hands rise above the top before reaching onto it)
    k(0.16, { pel: [-0.42, S - 0.05, 0], bend: [0.45, 0, 0], hd: [[0.06, H + 0.05, -0.16], [0.06, H + 0.05, 0.18]] });
    k(0.26, { pel: [-0.34, S + 0.08, -0.08], U: [0.1, 1, 0.3], bend: [0.3, 0, 0], ft: [[-0.4, 0.4, -0.45], [-0.42, 0.32, -0.3]], hd: top, kp: sideK });
    k(0.38, { pel: [-0.2, H + 0.1, -0.15], U: [0.15, 1, 0.45], bend: [0.2, 0, 0], ft: [[-0.1, H + 0.15, -0.8], [-0.2, H + 0.08, -0.7]], kp: [[0.3, 1, 0], [0.3, 1, 0]] });
    k(0.58, { pel: [D / 2, H + 0.22, -0.2], U: [0, 1, 0.5], ft: [[D / 2 + 0.18, H + 0.22, -0.95], [D / 2 - 0.02, H + 0.17, -0.88]] });
    k(0.78, { pel: [D + 0.17, Math.max(H + 0.1, L + S - 0.1), -0.1], U: [0, 1, 0.25], bend: [0.1, 0, 0], ft: [[D + 0.36, far(H - 0.2), -0.42], [D + 0.3, far(H - 0.28), -0.24]], kp: kF });
    k(0.86, { hd: [[D + 0.22, H + 0.2, -0.15], [D + 0.22, H + 0.2, 0.2]] });
    const s1 = stand(D + 0.34, L, L); k(1, { ...s1, hd: hang(s1.pel), ep: eB });
    return { ks, dur: 1.4 };
  }
  // sitting astride: side-on (facing along the barrier, +s), the leg on the far side (the left) goes over first
  const sitAndOff = (t0) => { // from sitting astride facing +s: the near leg swings over in front, the body turns to face across, and slides off
    const ty = H + 0.17, dy = (t) => t0 + (1 - t0) * t;
    k(dy(0.3), { pel: [D / 2, ty, 0], U: OV_UP, F: OV_S, bend: [0.1, 0, 0], ft: [[D + 0.2, far(H - 0.5), 0.2], [-0.05, H + 0.3, 0.32]], kp: [kS[0], [0, 1, 0.3]] });
    k(dy(0.45), { ft: [[D + 0.2, far(H - 0.5), 0.2], [D + 0.16, H + 0.26, 0.3]] });
    k(dy(0.62), { pel: [D * 0.55, ty, 0], F: OV_N, bend: [0.05, 0, 0], ft: [[D + 0.22, far(H - 0.45), -0.12], [D + 0.22, far(H - 0.45), 0.12]], hd: [[D * 0.4, H + 0.05, -0.25], [D * 0.4, H + 0.05, 0.25]], kp: kF, ep: eB });
    k(dy(0.8), { pel: [D + 0.17, ty - 0.03, 0], hd: [[D * 0.5, H + 0.05, -0.25], [D * 0.5, H + 0.05, 0.25]] }); // sliding forward off the edge before dropping
    k(dy(0.88), { hd: [[D + 0.25, H + 0.12, -0.25], [D + 0.25, H + 0.12, 0.25]] }); // (the hands leave the top upward)
    const s1 = stand(D + 0.32, L, L); k(1, { ...s1, hd: hang(s1.pel), ep: eB, kp: kF });
  };
  if (mode === 'straddle') {
    const s0 = stand(-0.22, 0, 0, OV_S);
    k(0.12, { ...s0, bend: [0.15, -0.25, 0], hd: [[D / 2, H + 0.05, 0.2], [0.02, H + 0.05, -0.18]], kp: kS, ep: eS });
    k(0.22, { pel: [-0.21, S, 0], ft: [[-0.16, H + 0.12, 0.1], s0.ft[1]], kp: [[-0.4, 0.7, 0.6], kS[1]] }); // (the foot rises clear of the face before going over)
    k(0.3, { pel: [-0.2, S + 0.02, 0], ft: [[D / 2, H + 0.18, 0.12], s0.ft[1]] });
    k(0.36, { ft: [[D + 0.14, H + 0.12, 0.1], s0.ft[1]], kp: [[0.3, 0.7, 0.6], kS[1]] });
    k(0.42, { pel: [-0.14, H + 0.19, 0], ft: [[D + 0.17, H - 0.2, 0.1], [-0.33, Math.max(A, H + 0.19 - 0.86), 0]] });
    k(0.52, { pel: [D / 2, H + 0.17, 0], bend: [0.1, 0, 0], ft: [[D + 0.2, far(H - 0.5), 0.2], [-0.2, Math.max(A, H - 0.5), 0.2]], hd: [[D / 2, H + 0.05, 0.3], [D / 2, H + 0.05, -0.25]], kp: kS });
    sitAndOff(0.52);
    return { ks, dur: 2.6 };
  }
  if (mode === 'straddle-mount') { // side-on, hands on the top: pull up, hook the far-side leg over, sit astride, then as a straddle
    const s0 = stand(-0.34, 0, 0, OV_S), eOff = [[-0.7, -0.5, 0], [-0.7, -0.5, 0]], hip = H - 0.35;
    k(0.08, { ...s0, bend: [0.1, -0.15, 0], hd: [[-0.16, H + 0.14, 0.22], [-0.2, H + 0.14, -0.22]], kp: kS, ep: eOff }); // (the hands rise above the top before reaching onto it)
    k(0.15, { hd: [[0.03, H + 0.05, 0.22], [0.03, H + 0.05, -0.22]], ep: [[-1, -0.3, 0], [-1, -0.3, 0]] }); // gripping the lip (a forearm from below cannot reach further onto it)
    k(0.28, { pel: [-0.3, hip, 0], bend: [0.1, -0.25, 0], ft: [[-0.2, Math.max(A, hip - 0.35), 0.2], [-0.4, Math.max(A, hip - 0.86), 0]], kp: [[-0.4, 0.6, 0.7], kS[1]] });
    k(0.36, { ft: [[-0.16, H + 0.16, 0.25], [-0.4, Math.max(A, hip - 0.86), 0]] });
    k(0.42, { ft: [[D / 2 - 0.02, H + 0.17, 0.25], [-0.4, Math.max(A, hip - 0.86), 0]] });
    k(0.5, { pel: [-0.18, H + 0.19, 0], ft: [[D + 0.14, H + 0.1, 0.22], [-0.3, Math.max(A, H + 0.19 - 0.86), 0]], hd: [[D / 2, H + 0.05, 0.25], [D / 2, H + 0.05, -0.22]], ep: eOff });
    k(0.58, { pel: [D / 2, H + 0.17, 0], bend: [0.1, 0, 0], ft: [[D + 0.2, far(H - 0.5), 0.2], [-0.2, Math.max(A, H - 0.5), 0.2]], hd: [[D / 2, H + 0.05, 0.3], [D / 2, H + 0.05, -0.25]], kp: kS });
    sitAndOff(0.58);
    return { ks, dur: 3.0 };
  }
  if (mode === 'roll over') { // belly onto the top, lying along it; the legs go off the far side and you slide down facing it
    const s0 = stand(-0.42, 0, 0), U2 = [0.874, 0.486, 0], F2 = [0.486, -0.874, 0], back = [[0.4, 1, 0.3], [0.4, 1, -0.3]];
    k(0.08, { ...s0, bend: [0.2, 0, 0], hd: [[-0.14, H + 0.14, -0.22], [-0.14, H + 0.14, 0.22]], kp: kF, ep: eUp });
    k(0.15, { pel: [-0.42, S - 0.06, 0], bend: [0.4, 0, 0], hd: [[0.05, H + 0.05, -0.22], [0.05, H + 0.05, 0.22]] });
    k(0.24, { pel: [-0.36, H - 0.28, 0], U: [0.12, 1, 0], bend: [0.25, 0, 0], ft: [[-0.4, Math.max(A, H - 1.1), -0.1], [-0.4, Math.max(A, H - 1.1), 0.1]] }); // pressed up beside it, upright
    k(0.32, { pel: [-0.27, H + 0.06, 0], U: U2, F: F2, bend: [0, 0, 0], ft: [[-0.4, Math.max(A, H - 0.82), -0.14], [-0.4, Math.max(A, H - 0.82), 0.06]], kp: [[-0.2, 0.3, -1], [-0.2, 0.3, -1]] }); // (the knees out to the side the legs go, not into the face)
    k(0.37, { ft: [[-0.36, H - 0.3, -0.6], [-0.36, H - 0.35, -0.45]] });
    k(0.42, { pel: [-0.05, H + 0.16, -0.2], U: [0.5, 0.2, 0.8], F: [0.3, -0.95, 0], ft: [[-0.24, H + 0.17, -0.92], [-0.14, H + 0.17, -0.88]], kp: [[0, 1, 0], [0, 1, 0]] });
    k(0.52, { pel: [D / 2, H + 0.17, -0.35], U: OV_S, F: [0, -1, 0], ft: [[D / 2 + 0.05, H + 0.12, -1.2], [D / 2 - 0.05, H + 0.12, -1.2]], hd: [[D / 2, H + 0.05, 0.45], [D / 2, H + 0.05, 0.6]], ep: [[0, 1, 0], [0, 1, 0]] });
    k(0.64, { pel: [D / 2 + 0.05, H + 0.17, -0.25], ft: [[D + 0.32, H - 0.25, -0.5], [D + 0.32, H - 0.15, -0.3]], kp: [[1, 0, 0], [1, 0, 0]] });
    k(0.74, { pel: [D + 0.24, H + 0.06, -0.12], U: [0, 0.6, 0.8], F: [-1, 0, 0], ft: [[D + 0.34, far(H - 0.75), -0.2], [D + 0.34, far(H - 0.7), -0.02]], hd: [[D / 2, H + 0.05, 0.25], [D / 2, H + 0.05, 0.05]], kp: [[-0.2, -1, 0], [-0.2, -1, 0]], ep: back });
    k(0.84, { pel: [D + 0.27, Math.max(L + S - 0.1, H - 0.25), 0], U: OV_UP, ft: [[D + 0.3, far(H - 1.1), 0.11], [D + 0.3, far(H - 1.1), -0.11]], hd: [[D / 2, H + 0.05, 0.22], [D / 2, H + 0.05, -0.22]], kp: [[-0.3, -1, 0], [-0.3, -1, 0]] });
    k(0.92, { hd: [[D + 0.3, H + 0.12, 0.22], [D + 0.3, H + 0.12, -0.22]] }); // (the hands leave the top upward)
    k(1, { pel: [D + 0.32, L + S, 0], ft: [[D + 0.32, L + A, 0.11], [D + 0.32, L + A, -0.11]], hd: [[D + 0.27, L + S - 0.05, 0.23], [D + 0.27, L + S - 0.05, -0.23]], kp: [[-1, 0.6, 0], [-1, 0.6, 0]], ep: [[1, -0.6, 0.5], [1, -0.6, -0.5]] });
    return { ks, dur: 2.6, faceBack: true };
  }
  if (mode === 'window') { // head first through the gap over the top, straight and level, belly on it; then down the far side
    const s0 = stand(-0.6, 0, 0), lvl = H + 0.18, legsUp = [[0, 1, 0], [0, 1, 0]];
    k(0.07, { ...s0, pel: [-0.74, S - 0.14, 0], bend: [0.35, 0, 0], neck: 0, hd: [[-0.36, H + 0.12, -0.18], [-0.36, H + 0.12, 0.18]], kp: kF, ep: eUp }); // (stepping back and down, the head low, the hands up to the top's height)
    k(0.15, { pel: [-0.68, S - 0.1, 0], bend: [1.0, 0, 0], neck: 0.3, hd: [[D / 2 + 0.05, H + 0.05, -0.18], [D / 2 + 0.05, H + 0.05, 0.18]] });
    k(0.26, { pel: [-0.44, H + 0.1, 0], U: [0.95, 0.3, 0], F: [0.3, -0.95, 0], bend: [0, 0, 0], neck: 0.2, ft: [[-0.95, H - 0.3, -0.1], [-0.95, H - 0.3, 0.1]], kp: legsUp });
    k(0.36, { pel: [-0.3, lvl, 0], U: OV_N, F: [0, -1, 0], ft: [[-1.05, H + 0.05, -0.1], [-1.05, H + 0.05, 0.1]], hd: [[D + 0.1, H + 0.05, -0.18], [D + 0.1, H + 0.05, 0.18]], ep: [[0, 1, -0.5], [0, 1, 0.5]] });
    k(0.6, { pel: [D - 0.02, lvl, 0], ft: [[D - 0.8, H + 0.12, -0.1], [D - 0.8, H + 0.12, 0.1]], hd: [[D + 0.55, L + 0.05, -0.2], [D + 0.55, L + 0.05, 0.2]] });
    k(0.68, { pel: [D + 0.18, H + 0.08, 0], U: [0.6, -0.8, 0], F: [-0.8, -0.6, 0], ft: [[D - 0.7, H + 0.12, -0.1], [D - 0.7, H + 0.12, 0.1]] }); // (over the far edge on the belly)
    k(0.78, { pel: [D + 0.2, H - 0.1, 0], U: [0.3, -0.95, 0], F: [-0.95, -0.3, 0], ft: [[-0.1, H + 0.12, -0.1], [-0.1, H + 0.12, 0.1]], hd: [[D + 0.45, L + 0.05, -0.2], [D + 0.45, L + 0.05, 0.2]] });
    k(0.9, { pel: [D + 0.4, L + 0.5, 0], U: [0.6, 0.8, 0], F: [0.8, -0.6, 0], ft: [[D + 0.15, H + 0.15, -0.1], [D + 0.15, H + 0.15, 0.1]], kp: kF });
    const s1 = stand(D + 0.5, L, L); k(1, { ...s1, hd: hang(s1.pel), ep: eB });
    return { ks, dur: 2.8 };
  }
  return null;
}
// the rules (docs/movement.md, "Barriers with nothing to stand on at the top"), in order of effort
const OVER_MODES = [
  ['step on', (B) => body.slow && B.H <= 0.8 && B.C >= 1.1], // approached slowly: a foot goes on it (it is taken to hold you)
  ['high step', (B) => B.H <= 0.75 && B.D <= 0.4 && Math.abs(B.L) <= 0.4],
  ['straddle', (B) => B.H <= 0.95 && B.W >= 0.8],
  ['vault', (B) => B.H <= VAULT_MAX && B.C >= 0.5],
  ['roll over', (B) => B.H <= 1.3 && B.W >= 1.75 && B.C >= 0.4],
  ['straddle-mount', (B) => B.H <= 1.45 && B.W >= 0.8 && B.C >= 0.9],
  ['window', (B) => B.H <= 1.2 && B.C >= 0.38 && B.C < 0.6],
];
// the script in world terms, mirrored to one side, starting from the pose you are in
function overWorld(B, sc, side, P0) {
  const [nx, nz] = B.n, [sx, sz] = B.r, m = side > 0 ? -1 : 1; // (side -1: as written; +1: mirrored)
  const pt = (p) => [B.O[0] + nx * p[0] + sx * p[2] * m, B.y0 + p[1], B.O[1] + nz * p[0] + sz * p[2] * m];
  const dir = (p) => [nx * p[0] + sx * p[2] * m, p[1], nz * p[0] + sz * p[2] * m];
  const pair = (a, f) => (m < 0 ? [a[1], a[0]] : a).map(f); // mirrored: the right limb does what the left did
  const keys = [{ t: 0, P: P0 }]; let last = { U: OV_UP, F: OV_N, bend: [0, 0, 0], neck: 0 };
  for (const kk of sc.ks) {
    const c = last = { ...last, ...kk };
    const prev = keys[keys.length - 1].P;
    const U = V.nrm(dir(c.U)), F = dir(c.F), fr = SK.frameFrom(U, F);
    const fh = [fr.F[0], 0, fr.F[2]], fl = Math.hypot(fh[0], fh[2]) > 0.2 ? V.nrm(fh) : [nx, 0, nz];
    keys.push({ t: kk.t, P: {
      pelvis: pt(c.pel), frame: fr, bend: [c.bend[0], c.bend[1] * m, c.bend[2] * m], neckPitch: c.neck || 0,
      feet: c.ft ? pair(c.ft, pt) : prev.feet, toes: [fl, fl], hands: c.hd ? pair(c.hd, pt) : prev.hands,
      kneePole: c.kp ? pair(c.kp, dir) : prev.kneePole, elbowPole: c.ep ? pair(c.ep, dir) : prev.elbowPole,
    } });
  }
  return keys;
}
function overPose(keys, t) {
  let i = 1; while (i < keys.length - 1 && keys[i].t < t) i++;
  const a = keys[i - 1], b = keys[i], u = clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1), e = u * u * (3 - 2 * u), A = a.P, Bp = b.P;
  const mix = (p, q) => [lerp(p[0], q[0], e), lerp(p[1], q[1], e), lerp(p[2], q[2], e)];
  return {
    pelvis: mix(A.pelvis, Bp.pelvis), frame: SK.frameFrom(V.nrm(mix(A.frame.U, Bp.frame.U)), mix(A.frame.F, Bp.frame.F)),
    bend: mix(A.bend, Bp.bend), neckPitch: lerp(A.neckPitch || 0, Bp.neckPitch || 0, e),
    feet: A.feet.map((f, k) => mix(f, Bp.feet[k])), toes: A.toes.map((f, k) => V.nrm(mix(f, Bp.toes[k]))), hands: A.hands.map((f, k) => mix(f, Bp.hands[k])),
    kneePole: A.kneePole.map((f, k) => mix(f, Bp.kneePole[k])), elbowPole: A.elbowPole.map((f, k) => mix(f, Bp.elbowPole[k])),
  };
}
function capsOf(J) { // the body's ten capsules from solved joints (as bodyCapsules)
  const out = [], cap = (a, b, r) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], r);
  for (const s of ['L', 'R']) { cap(J['hip' + s], J['knee' + s], 0.08); cap(J['knee' + s], [J['ankle' + s][0], J['ankle' + s][1] + 0.02, J['ankle' + s][2]], 0.06); }
  cap(J.pelvis, J.chest, 0.16); cap(J.neck, J.head, 0.11);
  for (const s of ['L', 'R']) { cap(J['shoulder' + s], J['elbow' + s], 0.05); cap(J['elbow' + s], J['hand' + s], 0.045); }
  return out;
}
function capsPen(C, x, z) { // the deepest any capsule is inside a solid: gym boxes exactly, stems and logs as capsules, other solids by column
  const S = staticCaps(x, z); let worst = 0, what = '';
  for (let c = 0; c < C.length; c += 7) {
    const R = C[c + 6], a = [C[c], C[c + 1], C[c + 2]], b = [C[c + 3], C[c + 4], C[c + 5]];
    for (const bl of W.gym?.blocks || []) {
      if (!bl._inv || Math.hypot(bl.x - x, bl.z - z) > 9) continue;
      const hw = bl.size[0] / 2, hh = bl.size[1] / 2, hl = bl.size[2] / 2;
      for (let t = 0; t <= 1.0001; t += 0.125) {
        _gp.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t).applyMatrix4(bl._inv);
        const qx = Math.abs(_gp.x) - hw, qy = Math.abs(_gp.y - hh) - hh, qz = Math.abs(_gp.z) - hl;
        const pen = R - (Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0));
        if (pen > worst) { worst = pen; what = `${CAPN[c / 7]} in a box`; }
      }
    }
    for (const q of S) { const h = segSeg(a, b, q.a, q.b), pen = R + q.r - h.d; if (pen > worst) { worst = pen; what = `${CAPN[c / 7]} in a ${q.kind || 'stem'}`; } }
    if (!W.gym) for (let t = 0; t <= 1.0001; t += 0.25) { const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t, pz = a[2] + (b[2] - a[2]) * t; if (colBlocked(px, pz, py - R + 0.03, py + R - 0.03) && worst < 0.03) { worst = 0.03; what = `${CAPN[c / 7]} in a ${colWhy.split(' ')[0]}`; } }
  }
  return { pen: worst, what };
}
function overCheck(keys, n = 72) { // the script solved pose by pose: how deep any capsule goes, how short a planted foot falls
  let pen = 0, what = '', at = 0, short = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n, sol = SK.solvePose(overPose(keys, t)), g = capsPen(capsOf(sol.J), sol.J.pelvis[0], sol.J.pelvis[2]);
    if (g.pen > pen) { pen = g.pen; what = g.what; at = t; }
    short = Math.max(short, sol.short.footL, sol.short.footR) * (t > 0.9 ? 1 : 0); // (at the end the feet must be down)
  }
  return { pen, what, at, short };
}
let overCache = null, overClock = 0; // (simulated seconds, for how long a plan is kept)
function planOver(B, P0) {
  const key = `${B.O[0].toFixed(1)},${B.O[1].toFixed(1)},${B.n[0].toFixed(1)},${B.n[1].toFixed(1)},${body.slow ? 1 : 0}`;
  if (overCache && overCache.key === key && overClock - overCache.time < 1) { // the same barrier: the choice stands, rebuilt from where you are now (and checked again)
    const r = overCache.res; if (!r) return null;
    const keys = overWorld(B, overScript(r.mode, B), r.side, P0), c = overCheck(keys);
    if (c.pen <= 0.02 && c.short <= 0.03) return { ...r, keys, B };
  }
  const tried = []; let res = null;
  for (const [mode, ok] of OVER_MODES) {
    if (!ok(B)) { tried.push(`${mode}: no`); continue; }
    const sc = overScript(mode, B); if (!sc) continue;
    for (const side of mode === 'vault' ? [body.veer || -1, -(body.veer || -1)] : [-1, 1]) {
      const keys = overWorld(B, sc, side, P0), c = overCheck(keys);
      tried.push(`${mode}${side > 0 ? ' (mirrored)' : ''}: ${(c.pen * 100).toFixed(0)} cm ${c.what} at ${c.at.toFixed(2)}${c.short > 0.03 ? `, foot short ${(c.short * 100).toFixed(0)} cm` : ''}`);
      if (c.pen <= 0.02 && c.short <= 0.03) { res = { mode, side, keys, dur: sc.dur, B, faceBack: sc.faceBack }; break; }
    }
    if (res) break;
  }
  overCache = { key, time: overClock, res, tried }; body.overTried = tried;
  return res;
}
// ---- your weight during a way over. Each hand and foot the script puts on something carries a share of your weight
// (a foot a whole share, a hand half). What it rests on was taken to hold you (the way over was chosen as if it would);
// as the weight comes on, a branch is checked as one is underfoot (branchLoad: it may snap, or bend away), and a loose
// object is pressed (freeForces). If what a planted hand or foot rests on breaks or moves out from under it, the
// script ends there and you drop.
function restTop(x, z, y) { // the highest footing at (x, z) no higher than just above y: the ground or a solid's top
  let t = ground(x, z); for (const o of solids.get(ckey8(x, z)) || []) { const v = topOf(o, x, z); if (v > t && v < y + 0.1) t = v; }
  return t;
}
function restOn(x, z, y) { // what a hand or foot at height y rests on: a solid, 'ground', or nothing (in the air)
  if (Math.abs(ground(x, z) - y) < 0.04) return 'ground';
  for (const o of solids.get(ckey8(x, z)) || []) if (Math.abs(topOf(o, x, z) - y) < 0.04) return o;
  return null;
}
function branchOf(o) { // a solid that is a branch, as the foot-stack check describes one (crunchSegs)
  if (o.limb) { const rec = o.rec; return { kind: 'tree', rec, ws: treeSegs(rec), i: o.node, P: rec.v.P, s: treeXf(rec).s, dead: false, gdn: [0, -1, 0] }; }
  const r = o.lrec, M = r?.m; if (!M) return null;
  return { kind: 'log', rec: r, ws: M.segs, i: o.node, P: M.v.P, s: M.s, dead: M.T > 1, gdn: [-M.X.y, -M.a.y, -M.Z.y] };
}
function overLoad(O, P) { // true if something gave way (the script has ended)
  const pts = [...P.feet.map((f) => [f[0], f[1] - OVER_A, f[2], 1]), ...P.hands.map((h) => [h[0], h[1] - 0.05, h[2], 0.5])];
  const L = O.load || (O.load = pts.map(() => null)), on = [];
  pts.forEach((p, k) => {
    const c = L[k]; if (c && Math.hypot(p[0] - c.x, p[1] - c.y, p[2] - c.z) < 0.03) { on.push(c); return; } // still where it was put
    const o = restOn(p[0], p[2], p[1]); L[k] = o ? { x: p[0], y: p[1], z: p[2], o, w: p[3], tested: 0 } : null; if (o) on.push(L[k]);
  });
  const W = on.reduce((a, c) => a + c.w, 0);
  body.overContacts = on.map((c) => ({ p: [c.x, c.y, c.z], o: c.o, F: BODY_N * c.w / W }));
  for (const c of on) {
    if (c.o === 'ground') continue;
    const F = BODY_N * CRUNCH.load * c.w / W;
    if ((c.o.limb || c.o.branch) && F > c.tested * 1.1) { // weight coming onto a branch (checked again as more of it comes on)
      c.tested = F; const b = branchOf(c.o);
      if (b) {
        const k = b.i * 7, w = b.ws, vx = w[k + 3] - w[k], vz = w[k + 5] - w[k + 2], u = clamp(((c.x - w[k]) * vx + (c.z - w[k + 2]) * vz) / (vx * vx + vz * vz || 1), 0, 1), r = branchLoad(b, u, F);
        if (r.fate === 'break') { if (b.kind === 'tree') breakBranch(b.rec, r.node); else logBreak(b.rec, r.node, b.ws[r.node * 7 + 6] > 0.015); crunchList = null; body.crunch = (body.crunch || 0) + 1; }
        if (r.fate !== 'hold') return giveWay(r.fate === 'break' ? 'The branch broke under you' : 'The branch bent away under you');
      }
    }
    if (restTop(c.x, c.z, c.y) < c.y - 0.05) return giveWay('It gave way under you'); // broken, rolled or slid out from under the hand or foot
  }
  return false;
}
function giveWay(msg) { // the script ends where it is: the body drops from here
  const P = overPose(rig.over.keys, rig.over.t); rig.over = null; body.overContacts = null;
  rig.feet = Math.min(P.feet[0][1], P.feet[1][1]) - OVER_A; rig.vy = 0; body.gaveWay = (body.gaveWay || 0) + 1; body.lastGaveWay = msg;
  plantBothFeet(); flash(msg); return true;
}
function startOver(o) { rig.over = { ...o, t: 0 }; body.q.stats.overs = (body.q.stats.overs || 0) + 1; body.lastOver = o.mode; endGap(); body.cross = null; }
function overBody(dt) { // the script owns the body: its pose, the eye in its head, the feet and hands where it put them
  const O = rig.over, P = overPose(O.keys, O.t), sol = SK.solvePose(P); body.sol = sol;
  const J = sol.J, F = sol.head ? sol.head.F : P.frame.F;
  body.feet.forEach((ft, i) => { const a = J[i ? 'ankleR' : 'ankleL']; ft.x = ft.tx = ft.sx = a[0]; ft.y = ft.ty = ft.sy = a[1] - OVER_A; ft.z = ft.tz = ft.sz = a[2]; ft.t = 1; ft.ln = null; });
  body.hands.forEach((h, i) => { const a = J[i ? 'handR' : 'handL']; h.p.set(a[0], a[1], a[2]); h.v.set(0, 0, 0); h.hold = null; h.sw = null; });
  body.pelvis.y = J.pelvis[1]; body.base = J.pelvis[1]; body.pvy = body.vbase = 0; body.lean = body.roll = body.crouch = body.duck = body.duckLean = 0; body.vlean = body.vroll = body.vcrouch = 0;
  const fh = Math.hypot(P.frame.F[0], P.frame.F[2]); if (fh > 0.3) body.yaw = body.shimYaw = Math.atan2(-P.frame.F[0], -P.frame.F[2]);
  body.eye = { x: J.head[0] + F[0] * 0.08, y: J.head[1] + 0.02, z: J.head[2] + F[2] * 0.08 }; player.eye = body.eye.y;
  body.speed = 0; body.moving = false; body.straddle = false; body.mix = 0; body.four = false; body.need = 0;
}
// on hands: does a move leave every planted hand and foot within reach (not more than half a stride behind home)?
function quadAllows(nx, nz, px, pz) {
  if (!body.four) return true;
  const q = body.q, a = q.a, S = [nx, q.S0[1], nz], al = (nx - px) * a[0] + (nz - pz) * a[2], dir = al >= 0 ? 1 : -1;
  for (let i = 0; i < 4; i++) { const p = limbAt(i); if (p && (V.dot(V.sub(p, S), a) - GAIT4.homes[i]) * dir < -GAIT4.stride * 0.5 - 0.12) return false; }
  return true;
}
// standing still: do the hands stay needed where you are?
function needHere() {
  const x = player.x, z = player.z, head = ceilingAt(x, z, rig.feet, [-Math.sin(player.yaw), -Math.cos(player.yaw)]) - rig.feet;
  if (head < DUCK_MIN) return 1;
  const st = stemUnder(x, z, rig.feet), tf = TRACTION[footKind] ?? MAX_SLOPE;
  supportRef = rig.feet; const steep = st ? st.slope : supportGrad(x, z, 0.3);
  return steep > tf && holdsNear(x, z, rig.feet, -Math.sin(body.yaw), -Math.cos(body.yaw)) ? 1 : 0;
}
function movePlayer(dt) {
  supportRef = rig.feet;
  let f = input.f, s = input.s, run = input.run;
  if (input.keys.has('KeyW') || input.keys.has('ArrowUp')) f += 1;
  if (input.keys.has('KeyS') || input.keys.has('ArrowDown')) f -= 1;
  if (input.keys.has('KeyD')) s += 1;
  if (input.keys.has('KeyA')) s -= 1;
  if (input.keys.has('ArrowLeft')) player.yaw += dt * 1.8;
  if (input.keys.has('ArrowRight')) player.yaw -= dt * 1.8;
  if (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight')) run = true;
  const mag = Math.hypot(f, s); if (mag > 1) { f /= mag; s /= mag; }
  if (input.keys.has('KeyQ') && !run) { f *= CAREFUL; s *= CAREFUL; } // a careful walk (the stick: a small push)
  const speed = lerp((run ? 4.2 : 1.6) * (1 - 0.55 * body.duck), GAIT4.speed * (run ? 1.4 : 1), body.need) * physResist(f, s) * (body.straddle ? 0.3 : 1); // (straddling something: slow until the trailing leg is over) // a stooped duck-walk is slow; on hands slower; a branch you cannot bend stops you
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const px = player.x, pz = player.z;
  body.slow = !run && speed * Math.min(1, Math.hypot(f, s)) < SLOW; // approaching slowly: a barrier is stepped onto, not over
  if (!rig.lift && !rig.vault && !rig.over && rig.vy === 0) { const here = footSupport(px, pz); if (here - rig.feet > STEP) rig.feet = here; } // embedded (e.g. a rock streamed in around you): climb out
  let needT = body.needT; overClock += dt;
  if (rig.over) { // a way over: the script carries the body; the controller follows its pelvis
    const O = rig.over; O.t = Math.min(1, O.t + dt / O.dur); const P = overPose(O.keys, O.t);
    player.x = P.pelvis[0]; player.z = P.pelvis[2]; rig.feet = Math.min(P.feet[0][1], P.feet[1][1]) - OVER_A; needT = 0;
    if (overLoad(O, P)) { /* something gave way: you drop from here */ }
    else if (O.t >= 1) { rig.over = null; body.overContacts = null; rig.feet = footSupport(player.x, player.z); rig.vy = 0; supportRef = rig.feet; }
  } else if (rig.vault) { // over a hurdle: the body follows an arc through the crossing point, low over the top
    const H = rig.vault; H.t = Math.min(1, H.t + dt / H.dur); const t = H.t, e = t * t * (3 - 2 * t), a = (1 - e) * (1 - e), b = 2 * e * (1 - e), c = e * e;
    player.x = a * H.x0 + b * H.cx + c * H.lx; player.z = a * H.z0 + b * H.cz + c * H.lz;
    rig.feet = lerp(H.y0, H.ly, e) + H.arc * Math.sin(Math.PI * t); needT = 0;
    if (t >= 1) { rig.vault = null; rig.feet = H.ly; }
  } else if (rig.lift) { // pulling up onto a ledge: rise in place with the hands on its lip, then step onto it
    const L = rig.lift; rig.feet = Math.min(L.y, rig.feet + GAIT4.climb * dt); needT = 1;
    if (rig.feet >= L.y - STEP * 0.5) { player.x = L.x; player.z = L.z; rig.feet = Math.max(rig.feet, footSupport(L.x, L.z)); rig.lift = null; }
  } else {
    let dx = (-sy * f + cy * s) * speed * dt, dz = (-cy * f - sy * s) * speed * dt;
    // a narrow hold steers you along it: on a stem, a move mostly along it follows its axis, and the body settles
    // over the axis (a stem is narrower than the footprint; off its crown the hands and feet would find nothing)
    if (body.four) {
      const st = stemUnder(px, pz, rig.feet) || stemAt(px, pz, rig.feet - 0.15, 0.5), l = Math.hypot(dx, dz);
      if (st) {
        const al = dx * st.ah[0] + dz * st.ah[1];
        if (l === 0 || Math.abs(al) > 0.5 * l) {
          const t = (px - st.cx) * st.ah[0] + (pz - st.cz) * st.ah[1], ox = px - st.cx - st.ah[0] * t, oz = pz - st.cz - st.ah[1] * t, pull = Math.min(1, dt * 10);
          dx = st.ah[0] * Math.sign(al) * l - ox * pull; dz = st.ah[1] * Math.sign(al) * l - oz * pull;
        }
      }
    }
    const step = Math.hypot(dx, dz); body.want = step > 0 ? [dx, dz] : null;
    body.plan = step > 0 ? planScan(px, pz, dx / step, dz / step) : null; // what is in the way, and what to do about each
    let vault = null;
    overPlan = null;
    if (step > 0 && rig.vy === 0) { // something low and thin ahead, or overhead within reach: over it, or under?
      const ux = dx / step, uz = dz / step, U = [ux, uz];
      const blocked = footSupport(px + ux * 0.3, pz + uz * 0.3) - rig.feet > STEP || barrierTop(px + ux * 0.52, pz + uz * 0.52, rig.feet) > STEP; // (a wall too high to scramble is still in the way: the foot ring reaches 0.52 m)
      let over = null, measured = false;
      const tryOver = () => { // a barrier measured ahead: the first way over that fits, or none (you stop, or go round)
        const B = barrierAt(px, pz, ux, uz); if (!B) return false; body.barrier = B;
        const o = B.dist <= 0.75 ? planOver(B, bodyPose()) : null; if (o) { startOver(o); vault = o; needT = 0; }
        return true;
      };
      if (blocked && !body.four) measured = tryOver();
      if (blocked && !measured) over = hurdleAhead(px, pz, ux, uz);
      else if (!blocked) {
        let c = Infinity; for (let d = 0.3; d <= 1.6; d += 0.1) c = Math.min(c, ceilingAt(px + ux * d, pz + uz * d, rig.feet, U));
        if (c < rig.feet + 1.9) { // you would have to duck or crawl: going over is the other way, and the gaze picks
          const under = player.pitch < -0.3 && underOK(px, pz, ux, uz);
          const B = !under && !body.four ? barrierAt(px, pz, ux, uz, 1.7) : null;
          if (B) { // a barrier ahead: a way over it that fits claims it (you don't duck under its overhead part on the way in)
            measured = true; body.barrier = B; const o = planOver(B, bodyPose());
            if (o && B.dist <= 0.95) { startOver(o); vault = o; needT = 0; } else if (o) overPlan = { over: o.mode };
          } else {
            over = hurdleAhead(px, pz, ux, uz, 1.6);
            if (over && under) over = null;
          }
        }
      }
      if (over && over.d0 <= 0.75 && !(blocked || body.four ? false : tryOver())) { vault = over; startVault(px, pz, over); needT = 0; }
      else if (over) overPlan = over;
    }
    if (step > 0 && !vault) {
      [dx, dz] = steerAround(px, pz, dx, dz);
      const lim = (v) => clamp(v, -HALF + 6, HALF - 6);
      let ok = false;
      // try straight on, then veer up to ~50° either way (favouring the side that worked last), then axis slides.
      // Head-on into a wall nothing fits and you stop; at an edge or round a boulder you sidestep.
      const veer = [];
      for (const a of [0.35, 0.6, 0.87]) for (const sd of [body.veer || 1, -(body.veer || 1)]) {
        const c = Math.cos(a * sd), sn = Math.sin(a * sd), k = Math.cos(a) * 0.9;
        veer.push([(dx * c - dz * sn) * k, (dx * sn + dz * c) * k, sd]);
      }
      const gapC = gapPlan(px, pz, dx, dz, dt); // a narrow gap only a side-on body fits: a committed plan (to its mouth, turn, through)
      { const cr = crossPlan(px, pz, dx, dz); if (cr) { dx = cr[0]; dz = cr[1]; } } // squared up to a barrier being stepped over
      let wide = false; { const l = Math.hypot(dx, dz) || 1, ux0 = dx / l, uz0 = dz / l, lo = rig.feet + STEP + 0.02, hi = rig.feet + CLEAR4; // a wall across the way (blocked at both shoulders and the middle): you stop, not slide along it
        wide = [-0.3, 0.3].every((q) => colBlocked(px + ux0 * 0.45 - uz0 * q, pz + uz0 * 0.45 + ux0 * q, lo, hi)); } // (both shoulders: a wall, or a gap too narrow to face; you stop rather than edge in by angles)
      for (const [mx, mz, sd, tag] of body.four ? [[dx, dz, 0]] : body.gap ? gapC.map((c) => [...c, 'gap']) : [[dx, dz, 0], ...(wide ? [] : veer), [dx, 0, 0], [0, dz, 0]]) { // on hands, you go where the holds lead or not at all
        if (!mx && !mz) continue;
        if (sd) body.veer = sd;
        const [nx, nz] = stemPushOut(lim(px + mx), lim(pz + mz));
        const st = assess(nx, nz, px, pz);
        if (st === null) continue;
        let sx = nx, sz = nz, shim = false;
        if (tag !== 'gap') { const ml = Math.hypot(mx, mz) || 1, ux2 = mx / ml, uz2 = mz / ml, fe = Math.max(rig.feet, st.sup); // the whole body must fit: facing the way, or else turned sideways (a shimmy)
          if (bodyBlocked(nx, nz, ux2, uz2, fe)) {
            let room = null; if (!sd) for (const q of [0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]) if (!bodyBlocked(nx - uz2 * q, nz + ux2 * q, ux2, uz2, fe)) { room = q; break; } // facing the way fits a little to one side: step across to it (not a shimmy)
            if (room !== null) { const k = Math.sign(room) * Math.min(Math.abs(room), Math.hypot(mx, mz) * 0.8); sx = px - uz2 * k; sz = pz + ux2 * k; }
            else { if (sd || body.four || !shimmyFits(nx, nz, ux2, uz2, fe)) continue; shim = true; const k = (body.shimTurn ?? 1) < 0.3 ? 0.45 : 0; sx = lerp(px, nx, k); sz = lerp(pz, nz, k); } } } // (turned side-on first, then side-stepping)
        if (tag !== 'gap') { body.shimmy = shim ? (body.shimmy || 0) + dt : 0; if (shim) body.shimDir = [mx, mz]; }
        if (!quadAllows(nx, nz, px, pz)) { if (!st.need) needT = 0; continue; } // held back by the limbs where hands aren't needed: stand up
        needT = st.need;
        if (st.rise > STEP) rig.lift = { x: nx, z: nz, y: st.sup }; else { player.x = sx; player.z = sz; }
        ok = true; break;
      }
    } else if (!vault) needT = needHere();
    if (!rig.lift && !rig.vault && !rig.over) {
      let sup = footSupport(player.x, player.z); { const w = body.want, wl = w ? Math.hypot(w[0], w[1]) : 0; if (wl) { const so = stepOverAt(player.x, player.z, sup, w[0] / wl, w[1] / wl); if (so !== null) sup = Math.max(so, Math.min(sup, rig.feet)); } } // (over a thin top, the body stays at the footing either side)
      if (sup >= rig.feet) { rig.feet = sup; rig.vy = 0; body.airborne = false; standLoad(); }
      else {
        const drop = rig.feet - sup, snap = body.four ? 0.3 : 0.06 + speed * dt * MAX_GROUND_SLOPE; // holding on, a slip off a stem's crown is not a fall
        if (drop <= snap && rig.vy === 0) rig.feet = sup;
        else {
          rig.vy -= 9.8 * dt; rig.feet += rig.vy * dt; body.airborne = true; needT = 0;
          if (rig.feet <= sup) { const impact = -rig.vy; rig.feet = sup; rig.vy = 0; body.airborne = false; body.vcrouch -= impact * 0.3; plantBothFeet(); }
        }
      }
    }
  }
  body.needT = needT;
  body.need = clamp(body.need + clamp(needT - body.need, -dt * 2.5, dt * 4), 0, 1);
  body.four = body.four ? body.need > 0.25 : body.need > 0.6; // hands down / hands free, with hysteresis
  body.mix = clamp((body.mix || 0) + (body.four ? dt * 3 : -dt * 3), 0, 1); // the posture eases between walking and on hands
  { // headroom over the body's length (on hands the head and chest are well ahead of the hips)
    const fx = body.four ? body.q.a[0] : -Math.sin(player.yaw), fz = body.four ? body.q.a[2] : -Math.cos(player.yaw), fl = Math.hypot(fx, fz) || 1;
    let c = Infinity; for (let d = -0.2; d <= 0.95; d += 0.1) c = Math.min(c, ceilingAt(player.x + fx / fl * d, player.z + fz / fl * d, rig.feet, [fx / fl, fz / fl]));
    body.head = c === Infinity ? 2 : c - rig.feet;
  }
  const moved = Math.hypot(player.x - px, player.z - pz);
  updateBody(dt, moved, run, player.x - px, player.z - pz, f);
}

// ---- the body on its hands: limbs as contacts
// Every hand and foot has a home position along the surface frame (a: the body's forward along the surface, R: its
// right, n: away from the surface). A planted limb falls behind home as the body moves; the one furthest behind
// steps a stride ahead, one at a time, so three hold. Before a limb lifts, the body sways sideways until its centre of
// mass is over the other three (on a stem, sideways is how you fall off; along it, the hands' grip holds you).
const limbAt = (i) => { // where limb i is planted, or null while it swings or (a hand) holds nothing
  if (i < 2) { const h = body.hands[i]; return h.sw ? null : h.hold; }
  const ft = body.feet[i - 2]; return ft.t >= 1 ? [ft.x, ft.y, ft.z] : null;
};
// the surface frame under the body, smoothed (collision pieces meet at angles), and the body's heading:
// walking, where you look; on hands, up the fall line if the slope is what needs them, else where you are going
function surfaceFrame(dt, ux, uz, moving) {
  const q = body.q, x = player.x, z = player.z, st = stemUnder(x, z, rig.feet) || (body.four ? stemAt(x, z, rig.feet - 0.15, 0.5) : null);
  let n;
  if (st) n = stemFrame(st).n;
  else { supportRef = rig.feet; const e = 0.3, gx = (supportAt(x + e, z) - supportAt(x - e, z)) / (2 * e), gz = (supportAt(x, z + e) - supportAt(x, z - e)) / (2 * e); n = V.nrm([-gx, 1, -gz]); }
  let yawT = player.yaw;
  if (body.need > 0.3) {
    const hh = Math.hypot(n[0], n[2]);
    if (st && st.slope > 0.3) yawT = Math.atan2(-st.ah[0], -st.ah[1]);
    else if (hh > 0.3) yawT = Math.atan2(n[0], n[2]); // uphill is against the normal's lean
    else if (moving) yawT = Math.atan2(-ux, -uz);
    else yawT = body.yaw;
  }
  let dy = yawT - body.yaw; dy -= Math.round(dy / 6.2832) * 6.2832; body.yaw += dy * Math.min(1, dt * 5);
  q.n = q.n ? V.nrm(V.add(q.n, V.sub(n, q.n), Math.min(1, dt * 6))) : n;
  const F = [-Math.sin(body.yaw), 0, -Math.cos(body.yaw)], a = V.nrm(V.sub(F, q.n.map((v) => v * V.dot(F, q.n))));
  let R = V.nrm(V.cross(a, q.n)); if (R[0] * Math.cos(body.yaw) - R[2] * Math.sin(body.yaw) < 0) R = R.map((v) => -v);
  // the surface under the body's centre (the footprint may be on an edge, e.g. half on a stem's foot), smoothed so the
  // body doesn't jump as that switches between two surfaces
  supportRef = rig.feet; const yc = supportAt(x, z), yT = Math.abs(yc - rig.feet) < 0.7 ? yc : rig.feet;
  q.y = q.y === undefined || Math.abs(q.y - yT) > 2 ? yT : q.y + (yT - q.y) * Math.min(1, dt * 8);
  q.a = a; q.R = R; q.S0 = [x, q.y, z];
}
// a hold for limb i at offset s along the surface frame from the body: the side of a stem there, else the surface
// a hand put down here must not reach through a solid on the way: the line from the shoulders (above the hips, at the
// height the headroom lets them be) to the hand, sampled every 10 cm, has no solid at its height
function reachClear(x, y, z, side = 0) {
  const yw = body.yaw ?? player.yaw, ox = player.x + Math.cos(yw) * side * 0.19, oz = player.z - Math.sin(yw) * side * 0.19; // from that shoulder
  const sh = rig.feet + Math.min(1.35, Math.max(0.35, (body.head ?? 2) - 0.2)), n = Math.max(1, Math.ceil(Math.hypot(x - ox, z - oz) / 0.1));
  for (let k = 1; k <= n; k++) { const t = k / n, px = lerp(ox, x, t), pz = lerp(oz, z, t), py = lerp(sh, y + 0.08, t); if (colBlocked(px, pz, py - 0.06, py + 0.06)) return false; }
  return true;
}
function placeContact(i, s) {
  const q = body.q, L = LIMB[i], Q = V.add(q.S0, q.a, s);
  const st = stemAt(Q[0], Q[2], Q[1] - 0.15, 0.5);
  if (st && st.rx >= 0.05) {
    const phi = L.hand ? 1.05 : 0.8, d = L.side * st.rx * Math.sin(phi); let R = stemFrame(st).R; if (V.dot(R, q.R) < 0) R = R.map((v) => -v);
    return { p: [st.cx + R[0] * d, st.cy + st.rz * Math.cos(phi), st.cz + R[2] * d], grip: true };
  }
  for (const w of [L.hand ? 0.17 : 0.12, 0.04]) {
    const x = Q[0] + q.R[0] * L.side * w, z = Q[2] + q.R[2] * L.side * w; supportRef = rig.feet; const y = supportAt(x, z), dy = y - Q[1];
    if (dy > (L.hand ? -0.6 : -0.9) && dy < (L.hand ? 1.2 : 0.6) && !trunkHit(x, z) && (!L.hand || reachClear(x, y, z, L.side))) return { p: [x, y, z], grip: false };
  }
  return null;
}
// signed distance of (u, v) inside the convex polygon pts (negative outside)
function hullMargin(pts, u, v) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && crossz(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.slice().reverse()) { while (hi.length >= 2 && crossz(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  const H = lo.slice(0, -1).concat(hi.slice(0, -1)); if (H.length < 3) return -1;
  let m = Infinity;
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length], ex = b[0] - a[0], ev = b[1] - a[1], l = Math.hypot(ex, ev) || 1;
    m = Math.min(m, (ex * (v - a[1]) - ev * (u - a[0])) / l); // counter-clockwise hull: inside is to the left of each edge
  }
  return m;
}
// sideways stability with limb `skip` lifted: margin of the centre of mass inside the other planted contacts, and the
// sway that would put it in the middle of them
function stability(skip) {
  const q = body.q, pts = []; let u0 = Infinity, u1 = -Infinity;
  for (let i = 0; i < 4; i++) { if (i === skip) continue; const p = limbAt(i); if (!p) continue; const d = V.sub(p, q.S0), u = V.dot(d, q.a); pts.push([u, V.dot(d, q.R)]); u0 = Math.min(u0, u); u1 = Math.max(u1, u); }
  if (pts.length < 3) return { m: 1, need: q.sway, few: true }; // gaining holds only adds support
  const u = clamp(q.comU, u0 + 0.05, u1 - 0.05), m = hullMargin(pts, u, q.sway);
  let vlo = Infinity, vhi = -Infinity;
  for (let k = -0.3; k <= 0.3001; k += 0.005) if (hullMargin(pts, u, k) >= 0) { vlo = Math.min(vlo, k); vhi = Math.max(vhi, k); }
  return { m, need: vlo <= vhi ? (vlo + vhi) / 2 : q.sway };
}
function quadStep(dt, dx, dz) {
  const q = body.q, a = q.a, ml = Math.hypot(dx, dz), moving = ml > 1e-5;
  if (moving) { const al = dx * a[0] + dz * a[2]; if (Math.abs(al) > 0.3 * ml) q.dir = Math.sign(al); }
  for (const h of body.hands) if (h.sw) { h.sw.t = Math.min(1, h.sw.t + dt / h.sw.dur); if (h.sw.t >= 1) { h.hold = h.sw.to; h.sw = null; q.stats.steps++; } }
  const swinging = body.hands.findIndex((h) => h.sw) >= 0 ? body.hands.findIndex((h) => h.sw) : body.feet.findIndex((ft) => ft.t < 1) >= 0 ? 2 + body.feet.findIndex((ft) => ft.t < 1) : -1;
  let swayT = q.sway;
  if (swinging < 0) {
    // the limb furthest behind its home steps next (a hand holding nothing counts as furthest); standing still, only
    // a hand still to place or a limb far out of place moves
    const due = [];
    for (let j = 0; j < 4; j++) {
      const p = limbAt(j), e = p ? (V.dot(V.sub(p, q.S0), a) - GAIT4.homes[j]) * q.dir - (j === q.last ? 0.05 : 0) : -9;
      if (e < (moving ? -GAIT4.stride * 0.25 : -GAIT4.stride)) due.push([e, j]);
    }
    due.sort((x, y) => x[0] - y[0]);
    let i = -1, ct = null; // the furthest-behind limb that has somewhere to go
    for (const [, j] of due) {
      const s1 = GAIT4.homes[j] + q.dir * (GAIT4.stride * 0.5 + (moving ? GAIT4.speed * GAIT4.swing * 0.5 : 0));
      for (const ds of [0, -0.08, -0.16, 0.1]) { ct = placeContact(j, s1 + ds * q.dir); if (ct) break; }
      if (!ct && j < 2) for (const back of [0.25, 0.4, 0.55, 0.7]) { ct = placeContact(j, s1 - back); if (ct) break; } // nothing out there (a stem's tip): hold nearer
      if (ct) { i = j; break; }
    }
    if (i >= 0) {
      const st = stability(i); swayT = st.need;
      if (st.m >= 0.01 || q.wait > 0.6) {
        {
          if (i < 2) { const h = body.hands[i]; h.sw = { from: h.hold || [h.p.x, h.p.y, h.p.z], to: ct.p, t: 0, dur: GAIT4.swing }; }
          else { const ft = body.feet[i - 2]; Object.assign(ft, { sx: ft.x, sy: ft.y, sz: ft.z, tx: ct.p[0], ty: ct.p[1], tz: ct.p[2], t: 0, dur: GAIT4.swing, lift: 0.1, rise: 0, ln: q.n }); }
          q.stats.lifts++; if (!st.few && st.m < 0.01) q.stats.forced++; if (!st.few) q.stats.minM = Math.min(q.stats.minM, st.m);
          q.last = i; q.wait = 0;
        }
      } else q.wait += dt;
    }
  } else swayT = stability(swinging).need;
  [q.sway, q.vsway] = spring(q.sway, q.vsway, clamp(swayT, -0.15, 0.15), 260, dt);
}
// the posture on hands: hips low over the surface (lower when steep, and under whatever is overhead), spine along it
function quadPose() {
  const q = body.q, ah = Math.hypot(q.a[0], q.a[2]), steepK = smoothstep(0.3, 1.5, Math.abs(q.a[1]) / Math.max(0.05, ah));
  const low = clamp((body.head - CLEAR4) / 0.45, 0, 1); // 0 squeezed flat under something, 1 room to spare
  // the crawl the headroom allows, as one posture scaled to it (see docs/movement.md): monkey and bear crawls (0.8-0.9 m: hips
  // up to 0.5 m, knees forward under the body), hands and knees (0.6 m: knees down on the ground), the army crawl (0.4 m: hips
  // 0.13 m, flat, elbows out and down). Knees and elbows never point up into what is overhead.
  const H = body.head, hipH = clamp(Math.min(lerp(0.5, 0.22, steepK), H - 0.4), 0.13, 0.5);
  const kneeDown = smoothstep(0.8, 0.6, H), flat = smoothstep(0.62, 0.45, H);
  const pel = V.add(V.add(V.add(q.S0, q.n, hipH), q.R, q.sway), q.a, -0.05);
  const U = V.nrm(V.add(q.a, q.n, 0.15 * low)), out = (side, k) => V.nrm(V.add(q.R.map((v) => v * side), q.a, k));
  const knee = (side) => V.nrm(V.add(V.add(out(side * 0.35, 1), q.n, -0.25 - 0.6 * kneeDown), q.a, -0.4 * kneeDown));
  const elbow = (side) => V.add(V.nrm(V.add(q.R.map((v) => v * side * lerp(0.3, 0.08, flat)), q.a, -0.6)), q.n, lerp(0.4 * clamp((H - 0.7) / 0.25, 0, 1), -0.8, flat)); // back along the body, a little out; flat, tucked and down
  return {
    pelvis: pel, frame: SK.frameFrom(U, q.n.map((v) => -v)), bend: [0.12 * low, 0, 0], neckPitch: (-0.5 - 0.3 * steepK) * low,
    feet: body.feet.map((ft) => V.add([ft.x, ft.y, ft.z], q.n, 0.07)), toes: [out(-0.4, 1), out(0.4, 1)],
    hands: body.hands.map((h) => V.add([h.p.x, h.p.y, h.p.z], q.n, 0.04)),
    kneePole: [knee(-1), knee(1)],
    elbowPole: [elbow(-1), elbow(1)],
  };
}
// the whole body: the walking posture and the posture on hands, mixed by how much the hands are needed
function bodyPose() {
  const w = smoothstep(0, 1, body.mix || 0), P = walkPose();
  if (w <= 0) return P;
  const Q = quadPose(), mix = (a, b) => [lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)];
  return {
    pelvis: mix(P.pelvis, Q.pelvis), frame: SK.frameFrom(V.nrm(mix(P.frame.U, Q.frame.U)), mix(P.frame.F, Q.frame.F)),
    bend: [lerp(P.bend[0], Q.bend[0], w), 0, 0], neckPitch: lerp(P.neckPitch, Q.neckPitch, w),
    feet: P.feet.map((f, i) => mix(f, Q.feet[i])), toes: P.toes.map((t, i) => mix(t, Q.toes[i])), hands: P.hands.map((h, i) => mix(h, Q.hands[i])),
    kneePole: P.kneePole.map((k, i) => mix(k, Q.kneePole[i])), elbowPole: P.elbowPole.map((k, i) => mix(k, Q.elbowPole[i])),
  };
}

// ---- gait and posture: how the body stands on what the controller chose
function plantBothFeet() {
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  for (const ft of body.feet) { ft.x = ft.tx = player.x + rx * ft.side * RIG.hipW; ft.z = ft.tz = player.z + rz * ft.side * RIG.hipW; ft.y = ft.ty = supportAt(ft.x, ft.z); ft.t = 1; ft.ln = null; }
}
// ---- stepping on branches. A foot comes down on the highest thing under it, whatever it is. Weight goes on, and
// each branch under the foot that cannot hold it gives way in turn, top down: a dead or thin one snaps (a beam check
// of your weight at that point, PL.breakCheck), a long flexible live one bends out from under the foot, and the foot
// drops to the next, until something holds (sagging a little, by its bending stiffness) or the ground does.
// Candidates are the branch segments of standing and fallen trees near you, in their rest pose.
const CRUNCH = { foot: 0.06, minR: 0.002, step: 0.45, sagMax: 0.12, bendAway: 0.25, load: 1.15 };
let crunchList = null;
function crunchSegs() {
  const L = crunchList;
  if (L && Math.hypot(player.x - L.x, player.z - L.z) < 1 && performance.now() - L.t < 1500) return L.segs;
  const segs = [], R = 3.2, top = rig.feet + 0.8;
  const add = (kind, rec, ws, i, P, s, dead, gdn, held) => {
    const k = i * 7, r = ws[k + 6]; if (r < CRUNCH.minR) return;
    if (Math.min(ws[k + 1], ws[k + 4]) > top) return;
    const mx = (ws[k] + ws[k + 3]) / 2, mz = (ws[k + 2] + ws[k + 5]) / 2, hl = Math.hypot(ws[k + 3] - ws[k], ws[k + 5] - ws[k + 2]);
    if (Math.abs(ws[k + 4] - ws[k + 1]) > 1.2 * hl) return; // upright: stepped beside, not on
    if ((mx - player.x) ** 2 + (mz - player.z) ** 2 > (R + hl / 2) ** 2) return;
    segs.push({ kind, rec, ws, i, P, s, dead, gdn, held });
  };
  const ci = Math.floor((player.x + HALF) / 16), cj = Math.floor((player.z + HALF) / 16);
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((ci + di) * 4096 + cj + dj) || []) {
    if ((rec.x - player.x) ** 2 + (rec.z - player.z) ** 2 > 400) continue;
    const P = rec.v.P, ws = treeSegs(rec), sc = treeXf(rec).s;
    for (let i = 0; i < P.n; i++) if (P.ord[i] >= 1 && !rec.gone?.[i]) add('tree', rec, ws, i, P, sc, false, [0, -1, 0]);
  }
  for (const r of logPick) {
    const M = r.m; if (!M || player.x < M.box[0] - R || player.x > M.box[1] + R || player.z < M.box[2] - R || player.z > M.box[3] + R) continue;
    const P = M.v.P, gdn = [-M.X.y, -M.a.y, -M.Z.y]; // world down in the plant's frame
    for (let i = 0; i < P.n; i++) if (M.segs[i * 7 + 6] > 0 && !r.gone?.[i]) add('log', r, M.segs, i, P, M.s, M.T > 1, gdn);
  }
  for (const r of rootPick) { // exposed roots: held in the soil, they take your weight (the beam check finds no free span)
    const M = r.m; if (!M || (r.x - player.x) ** 2 + (r.z - player.z) ** 2 > (M.P.rp * 2.5 + R) ** 2) continue;
    for (let i = 0; i < M.P.n; i++) if (!M.fixed[i]) add('root', r, M.ws, i, wsGraph(M), 1, false, [0, -1, 0], (j) => !!M.fixed[j]);
  }
  crunchList = { x: player.x, z: player.z, t: performance.now(), segs };
  return segs;
}
// how a branch takes your weight at a point: 'break' (and which node fails), 'bend' (too flexible to stand on) or
// 'hold' with a sag. Sag by the moment-area method: each segment from the load back to the stem rotates by
// M·len/(E·I) and lifts the load point by that angle times its lever arm.
// a graph whose p0/p1 are its world segments (roots are laid out in surface-relative coordinates, then draped)
function wsGraph(M) {
  if (M.Pw) return M.Pw; const P = M.P, ws = M.ws, p0 = new Float32Array(P.n * 3), p1 = new Float32Array(P.n * 3);
  for (let i = 0; i < P.n; i++) { p0.set([ws[i * 7], ws[i * 7 + 1], ws[i * 7 + 2]], i * 3); p1.set([ws[i * 7 + 3], ws[i * 7 + 4], ws[i * 7 + 5]], i * 3); }
  return (M.Pw = { ...P, p0, p1 });
}
function branchLoad(c, u, F = BODY_N * CRUNCH.load) {
  const P = c.P, s = c.s, g = c.gdn, Fv = g.map((v) => v * F), held = c.held || ((j) => P.ord[j] < 1);
  const b = PL.breakCheck(P, c.i, u, Fv, s, c.dead, held);
  if (b.ratio >= 1) return { fate: 'break', node: b.node, ratio: b.ratio };
  const E = PL.ARCH[P.sp].wood.E * 1e9 * (c.dead ? 0.8 : 1), q = [0, 1, 2].map((k) => (P.p0[c.i * 3 + k] + (P.p1[c.i * 3 + k] - P.p0[c.i * 3 + k]) * u) * s);
  let sag = 0, j = c.i, first = true;
  while (j >= 0 && !held(j)) {
    const a = [0, 1, 2].map((k) => P.p0[j * 3 + k] * s), e = first ? q : [0, 1, 2].map((k) => P.p1[j * 3 + k] * s);
    const m = [0, 1, 2].map((k) => (a[k] + e[k]) / 2 - q[k]), cr = [m[1] * g[2] - m[2] * g[1], m[2] * g[0] - m[0] * g[2], m[0] * g[1] - m[1] * g[0]], d = Math.hypot(...cr);
    const len = Math.hypot(e[0] - a[0], e[1] - a[1], e[2] - a[2]), rr = P.r0[j] * s, I = Math.PI * rr ** 4 / 4;
    sag += F * d * len / (E * I) * d; first = false; j = P.par[j];
  }
  return sag > CRUNCH.bendAway ? { fate: 'bend', sag } : { fate: 'hold', sag: Math.min(sag, CRUNCH.sagMax) };
}
// everything under a foot at (x, z) above the support `base`, top down, each with what it will do under your weight
function crunchStack(x, z, base) {
  const out = [], hi = rig.feet + CRUNCH.step;
  for (const c of crunchSegs()) {
    const w = c.ws, k = c.i * 7, ax = w[k], az = w[k + 2], vx = w[k + 3] - ax, vz = w[k + 5] - az, l2 = vx * vx + vz * vz;
    const u = l2 > 1e-8 ? clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1) : 0, px = ax + vx * u - x, pz = az + vz * u - z;
    const r = w[k + 6]; if (px * px + pz * pz > (CRUNCH.foot + r) ** 2) continue;
    const y = w[k + 1] + (w[k + 4] - w[k + 1]) * u + r;
    if (y <= base + 0.01 || y > hi) continue;
    out.push({ c, u, y, r });
  }
  out.sort((a, b) => b.y - a.y);
  return out.slice(0, 8);
}
let lastStack = null; // what foothold found under the foot it placed
function footStack(x, z, base) {
  const st = crunchStack(x, z, base); lastStack = st.length ? { list: st, base } : null;
  return st.length ? st[0].y : base;
}
// a planted foot works down through its stack (updateBody calls this for each foot in stance)
function crunchFoot(ft, dt) {
  const S = ft.stack; if (!S) return;
  let e = S.list[0];
  while (e && e.c.rec.gone?.[e.c.i]) { S.list.shift(); e = S.list[0]; } // gone already (snapped by something else)
  const target = e ? e.y - (e.res?.sag || 0) : S.base;
  if (ft.y > target + 1e-3) { ft.dv = (ft.dv || 0) + 9.8 * dt; ft.y = Math.max(target, ft.y - ft.dv * dt); return; } // dropping onto the next
  ft.dv = 0; ft.y = target; ft.ty = target;
  if (!e) { ft.stack = null; return; }
  if (!e.res) { e.res = branchLoad(e.c, e.u); e.t = 0; }
  if (e.res.fate === 'hold') { if (ft.y < e.y - e.res.sag + 1e-3) ft.stack = null; return; }
  if ((e.t += dt) < (e.res.fate === 'break' ? 0.05 + 0.05 * Math.min(1, 1 / e.res.ratio) : 0.12)) return; // weight coming on
  if (e.res.fate === 'break') {
    const c = e.c;
    if (c.kind === 'tree') breakBranch(c.rec, e.res.node); else if (c.kind === 'root') breakOff(c.rec, 'root', e.res.node); else logBreak(c.rec, e.res.node, c.ws[e.res.node * 7 + 6] > 0.015);
    crunchList = null; body.crunch = (body.crunch || 0) + 1;
  }
  S.list.shift();
}
// A foot lands at the aimed spot unless that is far below or above where you stand (off the side of a narrow stem or
// ledge): then it comes in toward your centreline, which the controller has already found standable.
function foothold(tx, tz) {
  for (const t of nearbyTrunks(tx, tz)) { // never inside a trunk: out to its bark (the stem's real radius, plus the foot)
    const r = t.r - 0.25 + 0.09, d = Math.hypot(tx - t.x, tz - t.z);
    if (d < r) { const k = r / Math.max(d, 1e-3); tx = t.x + (d > 1e-3 ? (tx - t.x) * k : r); tz = t.z + (d > 1e-3 ? (tz - t.z) * k : 0); }
  }
  const [x, z, y] = footholdBase(tx, tz);
  return [x, z, footStack(x, z, y)];
}
function footholdBase(tx, tz) {
  const s0 = supportAt(tx, tz), w = body.want, wl = w ? Math.hypot(w[0], w[1]) : 0, narrowTop = (x, z, s) => wl && stepOverAt(x, z, s, w[0] / wl, w[1] / wl) !== null;
  const toeRoom = (x, z, s) => { if (!wl) return true; const fx = w[0] / wl, fz = w[1] / wl; // room before an edge or a face to lift the foot (and the knee ahead of it): nothing solid at shin height across the foot's width
    for (const d of [0.06, 0.12, 0.18, 0.24]) for (const e of [-0.06, 0, 0.06]) if (colBlocked(x + fx * d - fz * e, z + fz * d + fx * e, s + 0.12, s + 0.55)) return false; return true; };
  const heelRoom = (x, z, s) => { if (!wl) return true; const fx = w[0] / wl, fz = w[1] / wl; // and behind the heel, landing beyond something stepped over (the shin comes down past it)
    for (const d of [0.06, 0.12, 0.18]) for (const e of [-0.06, 0.06]) if (colBlocked(x - fx * d - fz * e, z - fz * d + fx * e, s + 0.12, s + 0.55)) return false; return true; };
  const narrow = (x, z, s) => narrowTop(x, z, s) || !toeRoom(x, z, s) || !heelRoom(x, z, s);
  if (Math.abs(s0 - rig.feet) < 0.45 && legRoom(tx, tz, s0) && !narrow(tx, tz, s0)) return [tx, tz, s0];
  const c = [];
  for (const r of [0.12, 0.25]) for (let k = 0; k < 8; k++) { const a = k * 0.785; c.push([tx + Math.cos(a) * r, tz + Math.sin(a) * r]); }
  for (const k of [0.3, 0.55, 0.8, 1]) c.push([lerp(tx, player.x, k), lerp(tz, player.z, k)]);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * 6.283; c.push([player.x + Math.cos(a) * FOOT, player.z + Math.sin(a) * FOOT]); }
  let best = null, bd = Infinity, room = null, bd2 = Infinity, fb = [tx, tz, s0], fe = Math.abs(s0 - rig.feet);
  for (const [x, z] of c) {
    const s = supportAt(x, z), e = Math.abs(s - rig.feet), d = Math.hypot(x - tx, z - tz);
    if (e < 0.45 && d < bd && legRoom(x, z, s) && !narrow(x, z, s)) { bd = d; best = [x, z, s]; }
    if (e < 0.45 && d < bd2 && legRoom(x, z, s) && !narrowTop(x, z, s)) { bd2 = d; room = [x, z, s]; } // second best: room for the leg, if not before an edge
    if (e < fe) { fe = e; fb = [x, z, s]; }
  }
  return best || room || fb;
}
function startSwing(ft, tx0, tz0, dur) {
  const [tx, tz, ty] = foothold(tx0, tz0);
  Object.assign(ft, { sx: ft.x, sz: ft.z, sy: ft.y, tx, tz, ty, t: 0, dur, ln: null, stack: lastStack, dv: 0, onKind: supKind === 'soil' ? 'ground' : supKind });
  swingLift(ft);
}
function swingLift(ft) { // lift enough to clear what lies between the old and new footholds, sampled every 6 cm (a thin wall is 0.2 m)
  let top = Math.max(ft.sy, ft.ty); const n = Math.max(5, Math.ceil(Math.hypot(ft.tx - ft.sx, ft.tz - ft.sz) / 0.06));
  for (let k = 1; k < n; k++) top = Math.max(top, supportAt(lerp(ft.sx, ft.tx, k / n), lerp(ft.sz, ft.tz, k / n)));
  ft.lift = Math.max(ft.t > 0 ? ft.lift : 0, RIG.lift + (top - Math.max(ft.sy, ft.ty))); ft.rise = ft.ty - ft.sy;
}
// Head height for ducking. Head top above the feet = pelvis + crouch + (spine + neck)·cos(lean) + 0.17 (head above the
// neck joint). Given the lowest stem underside over where the head is and is about to be, the deficit is shared: the
// knees take about half (pelvis down to ~0.45 m lower), the back stoops for the rest (up to 1 rad), then the knees again.
// Below DUCK_MIN this can't fit, and the hands come down (the controller's `need`).
const neckBack = (lean) => lean <= 0.6 ? lean * 0.5 : Math.max(0, 0.3 * (1 - (lean - 0.6) / 0.5)); // how far the head tips back to look ahead
function headTop(lean) { const L = SK.BONES.spine, W = SK.BONES.spineW; let h = 0, cw = 0; for (let i = 0; i < L.length; i++) { cw += W[i]; h += L[i] * Math.cos(lean * cw); } return h + (RIG.neck + 0.08) * Math.cos(lean - neckBack(lean)) + 0.11; }
function duckPosture(ux, uz, spd) {
  const feet = rig.feet, fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), ahead = 1.0 + Math.min(0.6, spd * 0.3); // a fixed lead: the duck-walk slows you, which must not shrink the warning
  // the head can lean sideways (torso roll, up to ~0.3 m): read the stem's underside across the body's width and
  // put the head where it is highest. A level stem gives no reason to lean; a sloped one leans you to its high side.
  const lowest = (lat) => {
    let c = Infinity, cx = 0, cz = 0;
    const pts = [[0, 0, lat + 0.18], [0, 0, lat - 0.18]]; // stems are narrow: sample every 0.1 m where the head goes and reaches
    for (let a = 0; a <= ahead + 1e-6; a += 0.1) pts.push([a, 0, lat]);
    for (let b = 0.1; b <= 0.8; b += 0.1) pts.push([0, b, lat], [0.25, b, lat]);
    for (const [a, b, s] of pts) {
      const x = player.x + ux * a + fx * b - uz * s, z = player.z + uz * a + fz * b + ux * s, y = ceilingAt(x, z, feet, [ux, uz]); // a stem rising the way you go is climbed, not ducked
      if (y < c) { c = y; cx = x; cz = z; }
    }
    return { c, cx, cz };
  };
  // upright, or leaning either way: each lean counts only if the head can go there (not into a wall at the side), and the one
  // needing the least ducking wins, a lean costing a little; upright wins unless leaning really helps
  const need0 = Math.max(body.base - feet, RIG.leg - 0.03) + headTop(0), duckNeed = (o) => Math.max(0, need0 - (o.c - feet - 0.05));
  const headFree = (l) => { const sx = -uz, sz = ux, e = l + Math.sign(l) * 0.12; for (const a of [0, 0.2]) if (colBlocked(player.x + ux * a + sx * e, player.z + uz * a + sz * e, feet + 0.9, feet + 1.25)) return false; return true; }; // (a wall there, below the roof)
  let best = lowest(0), lat = 0, bestS = duckNeed(best);
  if (best.c < Infinity && bestS > 0) for (const l of [-0.3, -0.15, 0.15, 0.3]) { if (!headFree(l)) continue; const o = lowest(l), sc = duckNeed(o) + 0.05 * Math.abs(l); if (sc < bestS - 0.02) { best = o; lat = l; bestS = sc; } }
  const { c, cx, cz } = best;
  if (c === Infinity) return null;
  // the head's top above the pelvis for a forward lean, as the skeleton bends: spread over three spine segments, then the
  // neck and head (which tip back to look ahead only while the lean is moderate: deep down, the head follows the back)
  const pel0 = Math.max(body.base - feet, RIG.leg - 0.03), top = c - feet - 0.05, D = pel0 + headTop(0) - top;
  if (D <= 0) return null;
  const cmin = -Math.max(0, Math.min(0.45, body.base - feet - 0.45)); // the hips go no lower than 0.45 m on foot
  let crouch = Math.max(cmin, -Math.min(0.38, D * 0.55)), lean = 0;
  if (pel0 + crouch + headTop(1.3) > top) crouch = Math.max(cmin, top - headTop(1.3) - pel0); // the knees take the rest
  if (pel0 + crouch + headTop(0) > top) { let lo = 0, hi = 1.3; for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (pel0 + crouch + headTop(m) > top) lo = m; else hi = m; } lean = hi; } // just enough lean (up to 1.3 rad)
  const side = (cx - player.x) * Math.cos(player.yaw) - (cz - player.z) * Math.sin(player.yaw) >= 0 ? 1 : -1;
  // lat is right of travel; the roll is about the facing direction (they agree walking forward)
  const latR = lat * ((-uz) * Math.cos(player.yaw) + ux * -Math.sin(player.yaw) >= 0 ? 1 : -1);
  return { lean, crouch, amt: clamp(D / 0.6, 0, 1), x: cx, y: c, z: cz, side, roll: clamp(Math.asin(clamp(latR / (RIG.spine + RIG.neck), -0.5, 0.5)), -0.45, 0.45) };
}
// Rigid things the limbs meet: standing and fallen stems (branches and roots are rods, handled by the solver). Each as a
// capsule; a limb capsule inside one is pushed out. The push is kept and relaxes over a quarter second, so a hand that
// was put on the surface stays there rather than bouncing in and out.
function staticCaps(x, z) {
  const out = [], seen = new Set();
  const ci = Math.floor((x + HALF) / 16), cj = Math.floor((z + HALF) / 16), y = rig.feet; // standing stems as their own segments (they lean and taper)
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const rec of plantCells.get((ci + di) * 4096 + cj + dj) || []) {
    if ((rec.x - x) ** 2 + (rec.z - z) ** 2 > 16 || (rec.t && rec.t.d < 8)) continue; // saplings bend: the solver has them
    const P = rec.v.P, ws = treeSegs(rec);
    for (let i = 0; i < P.n; i++) { if (P.ord[i] !== 0) continue; const k = i * 7; if (Math.min(ws[k + 1], ws[k + 4]) > y + 2.6) continue; out.push({ a: [ws[k], ws[k + 1], ws[k + 2]], b: [ws[k + 3], ws[k + 4], ws[k + 5]], r: ws[k + 6], kind: 'trunk' }); }
  }
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const o of solids.get(ckey8(x + di * 8, z + dj * 8)) || []) {
    if (seen.has(o) || o.kind !== 'log' || o.node !== undefined || o.limb || o.root || o.free !== undefined || o.logPiece?._free !== undefined) continue; seen.add(o); // branches and roots are rods, logs near you objects: the solver has them
    if (Math.min((o.x0 - x) ** 2 + (o.z0 - z) ** 2, (o.x1 - x) ** 2 + (o.z1 - z) ** 2, (o.x - x) ** 2 + (o.z - z) ** 2) > 36 && Math.hypot(o.x1 - o.x0, o.z1 - o.z0) < 4) continue;
    out.push({ a: [o.x0, o.ya0, o.z0], b: [o.x1, o.ya1, o.z1], r: o.r0 !== undefined ? (o.r0 + o.r1) / 2 : o.r, kind: o.root ? 'root' : 'log' });
  }
  return out;
}
// How readily each body part gives way (N/m): an arm swings aside, the trunk and head shift, a swinging leg is
// easily lifted or turned, a planted one carries your weight and hardly moves.
function bodyKb() {
  const kb = new Float32Array(CAP.n);
  for (const ft of body.feet) { const s = ft.side < 0 ? 'L' : 'R', k = ft.t >= 1 ? 30000 : 1400; kb[CAP['thigh' + s]] = k; kb[CAP['shin' + s]] = k; }
  kb[CAP.torso] = 2600; kb[CAP.head] = 2600; kb[CAP.upperL] = kb[CAP.upperR] = 900; kb[CAP.foreL] = kb[CAP.foreR] = 650;
  return kb;
}
// How much mass stands behind each body part when it meets something loose (kg): a swinging leg or an arm is light,
// a planted leg has your weight on it.
function bodyMb() {
  const mb = new Float32Array(CAP.n);
  for (const ft of body.feet) { const s = ft.side < 0 ? 'L' : 'R', m = ft.t >= 1 ? 60 : 8; mb[CAP['thigh' + s]] = m; mb[CAP['shin' + s]] = m; }
  mb[CAP.torso] = 45; mb[CAP.head] = 45; mb[CAP.upperL] = mb[CAP.upperR] = 3; mb[CAP.foreL] = mb[CAP.foreR] = 2;
  return mb;
}
// Each body part's offset from where the posture wants it. Fed by the one contact rule: the solver's share of each
// rod contact that the body must take (phys.capD), and rigid things (stems, logs, roots in the soil, rocks), which are
// the same rule with an infinitely stiff object, so the body takes all of it. The offset relaxes over a quarter
// second, so a hand put on a trunk stays there rather than bouncing in and out.
function contactPush(dt) {
  const st = body.st || (body.st = { off: Array.from({ length: CAP.n }, () => [0, 0, 0]), hit: Array(CAP.n).fill(null) });
  const C = bodyCapsules(), S = staticCaps(player.x, player.z), decay = Math.exp(-dt / 0.25), D = phys.capDnew ? phys.capD : null; phys.capDnew = false;
  for (let i = 0; i < CAP.n; i++) {
    const c = i * 7, a = [C[c], C[c + 1], C[c + 2]], b = [C[c + 3], C[c + 4], C[c + 5]], R = C[c + 6], o = st.off[i];
    if (!st.hit[i] && !(D && D[i * 4 + 3] > 1e-4) && !(phys.capP && phys.capP[i * 7 + 6] > 0)) for (let k = 0; k < 3; k++) o[k] *= decay; // relaxes once nothing is pressing
    if (D && D[i * 4 + 3] > 0) for (let k = 0; k < 3; k++) o[k] += D[i * 4 + k];
    st.hit[i] = null;
  }
  staticResolve(st, C, S);
  return st;
}
function staticResolve(st, C, S) { // rigid things: the body part takes the whole overlap. Returns how much it moved anything.
  let moved = 0;
  for (let i = 0; i < CAP.n; i++) {
    const c = i * 7, a = [C[c], C[c + 1], C[c + 2]], b = [C[c + 3], C[c + 4], C[c + 5]], R = C[c + 6], o = st.off[i];
    for (const q of S) {
      const h = segSeg(a, b, q.a, q.b), pen = R + q.r - h.d; if (pen <= 0) continue;
      const pa = [a[0] + (b[0] - a[0]) * h.s, a[1] + (b[1] - a[1]) * h.s, a[2] + (b[2] - a[2]) * h.s], pq = [q.a[0] + (q.b[0] - q.a[0]) * h.t, q.a[1] + (q.b[1] - q.a[1]) * h.t, q.a[2] + (q.b[2] - q.a[2]) * h.t];
      const n = h.d > 1e-5 ? [(pa[0] - pq[0]) / h.d, (pa[1] - pq[1]) / h.d, (pa[2] - pq[2]) / h.d] : [0, 1, 0];
      for (let k = 0; k < 3; k++) o[k] += n[k] * pen; moved += pen;
      st.hit[i] = { p: pq.map((v, k) => v + n[k] * q.r), n, kind: q.kind };
    }
    for (let f = 0; f <= 1.0001; f += 0.25) { // boxes: out through the nearest face (a wall at the side, a roof above)
      const px = a[0] + (b[0] - a[0]) * f, py = a[1] + (b[1] - a[1]) * f, pz = a[2] + (b[2] - a[2]) * f;
      for (const so of solids.get(ckey8(px, pz)) || []) {
        if (so.kind !== 'box' || px < so.x0 - R || px > so.x1 + R || pz < so.z0 - R || pz > so.z1 + R || py < so.y0 - R || py > so.y1 + R) continue;
        const e = so.e, lx = e[0] * px + e[4] * py + e[8] * pz + e[12], ly = e[1] * px + e[5] * py + e[9] * pz + e[13], lz = e[2] * px + e[6] * py + e[10] * pz + e[14];
        const cx = clamp(lx, -so.hw, so.hw), cy = clamp(ly, 0, so.h), cz = clamp(lz, -so.hl, so.hl), dx = lx - cx, dy = ly - cy, dz = lz - cz, d = Math.hypot(dx, dy, dz);
        let nx, ny, nz, pen;
        if (d > 1e-6) { if (d >= R) continue; nx = dx / d; ny = dy / d; nz = dz / d; pen = R - d; }
        else { const fx = so.hw - Math.abs(lx), fy = Math.min(ly, so.h - ly), fz = so.hl - Math.abs(lz); // inside: out by the nearest face
          if (fx <= fy && fx <= fz) { nx = Math.sign(lx) || 1; ny = nz = 0; pen = R + fx; } else if (fy <= fz) { ny = ly < so.h / 2 ? -1 : 1; nx = nz = 0; pen = R + fy; } else { nz = Math.sign(lz) || 1; nx = ny = 0; pen = R + fz; } }
        const m = so.r, wx = m[0] * nx + m[4] * ny + m[8] * nz, wy = m[1] * nx + m[5] * ny + m[9] * nz, wz = m[2] * nx + m[6] * ny + m[10] * nz; // the normal back in the world
        o[0] += wx * pen; o[1] += wy * pen; o[2] += wz * pen; moved += pen; st.hit[i] = { p: [px - wx * R, py - wy * R, pz - wz * R], n: [wx, wy, wz], kind: 'rock' };
      }
    }
    for (const f of [0, 0.5, 1]) { // rocks and stumps (mesh solids): a limb below their top is pushed out of it, as a falling piece is
      const px = a[0] + (b[0] - a[0]) * f, py = a[1] + (b[1] - a[1]) * f, pz = a[2] + (b[2] - a[2]) * f;
      for (const so of solids.get(ckey8(px, pz)) || []) {
        if (so.kind !== 'mesh' || px < so.x0 || px > so.x1 || pz < so.z0 || pz > so.z1) continue;
        const top = topOf(so, px, pz), pen = top - (py - R); if (top === -Infinity || pen <= 0 || pen > 0.6) continue;
        o[1] += pen * (f === 0.5 ? 1 : 0.5); moved += pen; st.hit[i] = { p: [px, top, pz], n: [0, 1, 0], kind: 'rock' };
      }
    }
  }
  return moved;
}
function bodyFeedback(dt, ux, uz) {
  const st = contactPush(dt), fb = feedbackMap(st, ux, uz);
  bodyContacts(st);
  return fb;
}
function feedbackMap(st, ux, uz) { // per-capsule offsets -> hands, chest, head, swinging feet
  const fb = body.fb || (body.fb = { hand: [[0, 0, 0], [0, 0, 0]], lat: 0, lean: 0, crouch: 0 });
  const so = st.off, cap = (v, m) => { const l = Math.hypot(...v); return l > m ? v.map((x) => x * m / l) : v; };
  ['L', 'R'].forEach((s, k) => { const su = so[CAP['upper' + s]], sw = so[CAP['fore' + s]]; fb.hand[k] = cap([0, 1, 2].map((j) => sw[j] + su[j] * 0.5), 0.5); });
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw), ts = so[CAP.torso], hs = so[CAP.head];
  fb.lat = clamp((ts[0] + hs[0]) * rx + (ts[2] + hs[2]) * rz, -0.3, 0.3);
  fb.lean = clamp((ts[0] * fx + ts[2] * fz) / 0.45 + (hs[0] * fx + hs[2] * fz) / 0.75, -0.6, 0.6);
  fb.crouch = clamp(Math.min(0, hs[1] + 0.5 * ts[1]), -0.35, 0);
  if (pushState.on && pushState.p) { // the push acts back on you: through the arms into the trunk, against its stiffness
    const F = pushState.F, kb = 2600; fb.lat += clamp(-(F[0] * rx + F[2] * rz) / kb, -0.15, 0.15); fb.lean += clamp(-(F[0] * fx + F[2] * fz) * 0.45 / 380, -0.4, 0.4);
  }
  for (const ft of body.feet) {
    const s = ft.side < 0 ? 'L' : 'R', sa = so[CAP['thigh' + s]], sb = so[CAP['shin' + s]];
    if (ft.t >= 1) { ft.fb = null; continue; }
    const o = [sb[0] + sa[0] * 0.5, sb[1] + sa[1] * 0.5, sb[2] + sa[2] * 0.5], hz = Math.hypot(o[0], o[2]);
    o[1] = Math.max(0, o[1]) + hz * 1.5; // something across the shin: the foot goes over it more than round it
    ft.fb = cap(o, 0.45);
  }
  return fb;
}
// Where each hand and foot touches the world, and what: { p, n, kind, F (newtons, from the solver; 0 for rigid) }.
// Hands: a rigid surface the forearm rests on, else the branch pushing hardest on it. Feet: what the planted foot
// stands on (a branch from its crunch stack, or the support underneath); a swinging foot only what it brushes.
function bodyContacts(st) {
  const K = body.contacts || (body.contacts = { handL: null, handR: null, footL: null, footR: null }), CPs = phys.capP, CF = phys.capF;
  const fromCap = (i) => {
    if (st.hit[i]) return { ...st.hit[i], F: 0 };
    if (CPs && CPs[i * 7 + 6] > 0.5) return { p: [CPs[i * 7], CPs[i * 7 + 1], CPs[i * 7 + 2]], n: [CPs[i * 7 + 3], CPs[i * 7 + 4], CPs[i * 7 + 5]], kind: 'branch', F: Math.hypot(CF[i * 3], CF[i * 3 + 1], CF[i * 3 + 2]) };
    return null;
  };
  K.handL = fromCap(CAP.foreL); K.handR = fromCap(CAP.foreR);
  if (pushState.on && pushState.p) { const F = pushState.F, m = Math.hypot(...F) || 1, kind = pushState.tgt.kind === 'free' ? 'wood' : pushState.tgt.kind === 'fixed' ? 'trunk' : 'branch'; for (const [nm, side] of [['handL', -1], ['handR', 1]]) K[nm] = { p: [pushState.p[0] + Math.cos(player.yaw) * side * 0.09, pushState.p[1], pushState.p[2] - Math.sin(player.yaw) * side * 0.09], n: F.map((v) => -v / m), kind, F: m / 2 }; }
  body.feet.forEach((ft) => {
    const nm = ft.side < 0 ? 'footL' : 'footR';
    if (ft.t < 1) { K[nm] = fromCap(ft.side < 0 ? CAP.shinL : CAP.shinR); return; }
    const e = ft.stack?.list[0], on = e && e.res?.fate === 'hold' ? 'branch' : ft.onKind || 'ground';
    K[nm] = { p: [ft.x, ft.y, ft.z], n: [0, 1, 0], kind: on, F: BODY_N / Math.max(1, body.feet.filter((f) => f.t >= 1).length) };
  });
}
function updateBody(dt, moved, run, dx, dz, fwdInput) {
  if (rig.over) { overBody(dt); return; }
  const M = MOTION[settings.motion] ?? 1;
  const vx = dx / Math.max(dt, 1e-4), vz = dz / Math.max(dt, 1e-4), spd = Math.hypot(vx, vz);
  const accel = (spd - body.speed) / Math.max(dt, 1e-4); body.speed = lerp(body.speed, spd, 0.3);
  if (spd > 0.05) body.fwd = [vx / spd, vz / spd];
  const [ux, uz] = moved > 0 ? [dx / moved, dz / moved] : [-Math.sin(player.yaw), -Math.cos(player.yaw)];
  const rx = -uz, rz = ux; // right of travel
  { // the body's facing: the view, or turned to face across the way while shimmying
    const sh = body.shimmy > 0 && body.shimDir, d = sh ? Math.hypot(...body.shimDir) || 1 : 1, cr = !sh && body.cross;
    const yawT = sh ? Math.atan2(body.shimDir[1] / d, -body.shimDir[0] / d) : cr ? Math.atan2(-cr.dir[0], -cr.dir[1]) : player.yaw; // shimmy: facing the right of the way (fx = -sin(yaw) = -uz, fz = -cos(yaw) = ux); crossing: facing along it
    const cur = body.shimYaw ?? body.yaw ?? player.yaw, dy = Math.atan2(Math.sin(yawT - cur), Math.cos(yawT - cur));
    body.shimYaw = cur + dy * Math.min(1, dt * 8); body.shimTurn = sh ? Math.abs(dy) : 1; body.shimOn = sh || !!cr || Math.abs(dy) > 0.05; // (it holds the facing while sideways or turning back)
  }
  const uphill = moved > 0 ? (sampleGrid(W.H, N, player.x + ux, player.z + uz) - sampleGrid(W.H, N, player.x - ux, player.z - uz)) / 2 : 0;
  const steep = smoothstep(0.1, 0.8, uphill);
  const m = rig.lift || rig.vault, four = body.four, vlt = rig.vault;
  surfaceFrame(dt, ux, uz, moved > 0);
  if (body.shimOn) body.yaw = body.shimYaw; else body.shimYaw = body.yaw;

  // feet. Walking: a gait cycle driven by distance travelled. One cycle = two steps. Each foot swings for a fraction
  // `duty` of the cycle (walk 0.4: always one foot down; run 0.62: brief flight). A swing aims the foot so its stance
  // is centred under the hip: it lands (1 - duty) * stepLen ahead of the hip. On hands: quadStep.
  const runK = clamp((spd - 1.6) / 2.6, 0, 1);
  let stepLen = lerp(RIG.stepWalk, RIG.stepRun, runK) * (1 - 0.5 * steep) * (1 - 0.4 * body.duck), duty = lerp(0.4, 0.62, runK);
  const byaw = body.yaw ?? player.yaw, hx = Math.cos(byaw), hz = -Math.sin(byaw); // the body's own right (sideways, it lies along the way)
  const shim = body.shimmy > 0;
  // stepping sideways (not a shimmy, which sets its own): a side-step is short, about the hips' width past closed feet
  const lat = shim ? 0 : Math.abs(ux * hx + uz * hz); stepLen *= lerp(1, 0.4, smoothstep(0.3, 0.9, lat));
  // each foot either side of the body itself (not of the way it is going: walking backwards or sideways, those differ)
  const ideal = (ft) => [player.x + hx * ft.side * (shim ? 0.14 : RIG.hipW), player.z + hz * ft.side * (shim ? 0.14 : RIG.hipW)];
  const landAhead = (1 - duty) * stepLen;
  const aim = (ft, tLeft) => { const [ix, iz] = ideal(ft), a = landAhead * (shim ? 0.5 : 0.8) + spd * tLeft; let x = ix + ux * a, z = iz + uz * a;
    // the feet never pass each other: across the body, each stays at least 0.16 m on its own side of the other foot
    const o = body.feet[ft === body.feet[0] ? 1 : 0], oL = (o.x - player.x) * hx + (o.z - player.z) * hz, mL = (x - player.x) * hx + (z - player.z) * hz;
    const lim = ft.side > 0 ? Math.max(mL, oL + 0.16) : Math.min(mL, oL - 0.16); x += hx * (lim - mL); z += hz * (lim - mL);
    return [x, z]; };
  if (four) { const w = body.want || [0, 0]; quadStep(dt, w[0], w[1]); body.moving = false; }
  else {
    for (const h of body.hands) { h.hold = null; h.sw = null; }
    if (vlt) { /* the legs are already swinging over (startVault) */ } else if (body.airborne) {
      for (const ft of body.feet) { const [ix, iz] = ideal(ft); ft.x = ix; ft.z = iz; ft.y = rig.feet + 0.05; ft.t = 1; }
    } else if (spd > 0.05) {
      if (!body.moving) { // starting off: the foot furthest behind steps first, right away
        const [i0x, i0z] = ideal(body.feet[0]), [i1x, i1z] = ideal(body.feet[1]);
        const b0 = (body.feet[0].x - i0x) * ux + (body.feet[0].z - i0z) * uz, b1 = (body.feet[1].x - i1x) * ux + (body.feet[1].z - i1z) * uz;
        body.phase = (b0 <= b1 ? 1 : 1.5) - 1e-4; body.moving = true;
      }
      const c0 = body.phase, c1 = c0 + moved / (2 * stepLen); body.phase = c1;
      const cycleTime = (2 * stepLen) / spd;
      body.feet.forEach((ft, i) => {
        const start = i * 0.5; // window start within the cycle
        if (Math.floor(c1 - start) > Math.floor(c0 - start) && ft.t >= 1) {
          const dur = clamp(duty * cycleTime, 0.14, 0.5), [tx, tz] = aim(ft, dur);
          startSwing(ft, tx, tz, dur);
          if (steep > 0.2) body.vlean += RIG.leanPush * steep * (run ? 1.3 : 1); // push off into the slope
        }
      });
    } else if ((body.moving = false) || !body.feet.some((ft) => ft.t < 1)) { // standing: tidy up feet that ended up out of place
      let worst = null, worstD = 0.12;
      for (const ft of body.feet) { const [ix, iz] = ideal(ft), d = Math.hypot(ft.x - ix, ft.z - iz); if (d > worstD) { worstD = d; worst = ft; } }
      if (worst) { const [ix, iz] = ideal(worst); startSwing(worst, ix, iz, 0.3); }
    }
    body.straddle = false; body.strK = body.strK || 0;
    if (!vlt && !body.airborne && spd > 0.05) for (const ft of body.feet) { // straddling something (a foot planted behind it, the hips past it): that foot comes over now, and the body slows
      if (ft.t < 1) continue; const n = Math.max(1, Math.ceil(Math.hypot(player.x - ft.x, player.z - ft.z) / 0.08)); let between = false;
      for (let k = 1; k < n && !between; k++) { const x = lerp(ft.x, player.x, k / n), z = lerp(ft.z, player.z, k / n); between = colBlocked(x, z, ft.y + 0.12, ft.y + 0.6); }
      if (!between) continue; body.straddle = true;
      if (!body.feet.some((f) => f.t < 1)) { const [tx, tz] = aim(ft, 0.4); startSwing(ft, tx, tz, 0.4); }
    }
    body.strK += ((body.straddle ? 1 : 0) - body.strK) * Math.min(1, dt * 10);
    if (!vlt && !body.airborne && !body.feet.some((ft) => ft.t < 1)) { // planted crossed (the body turned over them): the one further out of place steps back to its side at once
      const [L, R] = body.feet[0].side < 0 ? body.feet : [body.feet[1], body.feet[0]];
      if ((R.x - L.x) * hx + (R.z - L.z) * hz < 0.08) { const far = (ft) => { const [ix, iz] = ideal(ft); return Math.hypot(ft.x - ix, ft.z - iz); }, ft = far(L) > far(R) ? L : R, [tx, tz] = aim(ft, 0.25); startSwing(ft, tx, tz, 0.25); }
    }
  }
  for (const ft of body.feet) if (ft.t < 1) {
    if (!four && !ft.ln && ft.t < 0.7 && spd > 0.05) { [ft.tx, ft.tz, ft.ty] = foothold(...aim(ft, ft.dur * (1 - ft.t))); ft.stack = lastStack; swingLift(ft); } // re-aimed: the lift is for the new path (it never drops mid-swing)
    ft.t = Math.min(1, ft.t + dt / ft.dur);
    const over = !four && ft.lift > RIG.lift + 0.15, tt = over ? clamp((ft.t - 0.3) / 0.7, 0, 1) : ft.t; // a step over something: the foot rises first, then goes over it
    const e = tt * tt * (3 - 2 * tt), l = (over ? smoothstep(0, 0.3, ft.t) * (1 - smoothstep(0.8, 1, ft.t)) : Math.sin(Math.PI * ft.t)) * ft.lift, n = ft.ln || [0, 1, 0]; // (over: up, held while it crosses, down)
    ft.x = lerp(ft.sx, ft.tx, e) + n[0] * l; ft.z = lerp(ft.sz, ft.tz, e) + n[2] * l; ft.y = lerp(ft.sy, ft.ty, e) + n[1] * l;
    if (!four) { // around the standing leg, not through it: the swinging foot keeps 0.2 m out to its own side of the other foot
      const o = body.feet[ft === body.feet[0] ? 1 : 0], by = body.yaw ?? player.yaw, hx = Math.cos(by), hz = -Math.sin(by), m = (ft.x - o.x) * hx + (ft.z - o.z) * hz, want = 0.2 * Math.sin(Math.PI * ft.t);
      const gap = ft.side > 0 ? want - m : m + want; if (gap > 0) { ft.x += hx * ft.side * gap; ft.z += hz * ft.side * gap; } }
    if (!four && ft.fb) { const q = Math.sin(Math.PI * ft.t); ft.x += ft.fb[0] * q; ft.y += ft.fb[1] * q; ft.z += ft.fb[2] * q; } // a branch across the shin pushes the swinging foot aside and up
    if (ft.t >= 1) { ft.x = ft.tx; ft.y = ft.ty; ft.z = ft.tz; if (ft.ln) body.q.stats.steps++; if (!four && ft.ty < ft.sy - 0.15) body.vcrouch -= (ft.sy - ft.ty) * 0.6; } // big step down: knees take it
  }

  for (const ft of body.feet) if (four) ft.stack = null; else if (ft.t >= 1 && ft.stack) crunchFoot(ft, dt);
  // pelvis: highest point both planted legs can reach; a swinging leg doesn't hold you up
  const stance = body.feet.filter((ft) => ft.t >= 1);
  let pTarget;
  if (m || body.airborne || !stance.length) pTarget = rig.feet + RIG.leg - 0.04;
  else {
    pTarget = Infinity;
    for (const ft of stance) {
      // a foot behind the hip rises onto its toes at push-off, so it reaches a little further
      const behind = (ft.x - player.x) * ux + (ft.z - player.z) * uz < 0, L = RIG.leg + (behind ? 0.1 : 0);
      const hd = Math.min(L * 0.98, Math.hypot(ft.x - player.x, ft.z - player.z));
      pTarget = Math.min(pTarget, ft.y + Math.sqrt(L * L - hd * hd) - 0.03);
    }
    pTarget = Math.max(pTarget, rig.feet + 0.68); // walking never folds into a squat; landings use the crouch spring
  }
  // ducking under a stem overhead: stoop and bend the knees just enough to keep the head below it
  const dk = (body.mix || 0) < 1 && !overPlan && !vlt ? duckPosture(ux, uz, spd) : null; // going over something, you don't duck under it // until the hands are fully down, the walking posture still ducks (the eye is a blend of both)
  body.duck += ((dk ? dk.amt : 0) - body.duck) * Math.min(1, dt * 8);
  body.duckLean += ((dk ? dk.lean : 0) - body.duckLean) * Math.min(1, dt * 10);
  body.duckHold = dk && dk.amt > 0.25 && !body.four && reachClear(dk.x, dk.y - 0.05, dk.z) ? dk : null; // a hand up on what is overhead, if it can reach it without going through something
  [body.crouch, body.vcrouch] = spring(body.crouch, body.vcrouch, dk ? dk.crouch : 0, RIG.kCrouch, dt);
  [body.pelvis.y, body.pvy] = spring(body.pelvis.y, body.pvy, pTarget, RIG.kPelvis, dt);
  // the slowly varying part of pelvis height (terrain) vs the rhythmic part (gait), split by a low-pass "baseline"
  const baseT = stance.length && !m && !body.airborne ? stance.reduce((a, ft) => a + ft.y, 0) / stance.length + RIG.leg - 0.03 : pTarget;
  [body.base, body.vbase] = spring(body.base, body.vbase, baseT, RIG.kBase, dt);
  const sf = stance.length === 1 ? stance[0].side : 0; // weight shifts over the stance foot
  [body.lat, body.vlat] = spring(body.lat, body.vlat, sf * 0.03, RIG.kLat, dt);

  const fb = bodyFeedback(dt, ux, uz);
  // torso lean: slope, acceleration
  let leanT = RIG.leanSlope * clamp(uphill, 0, 1.2) * (spd > 0.05 ? 1 : 0.3) + RIG.leanAccel * clamp(accel, -2, 4) * 0.25;
  let crouchT = 0;
  // low barrier: when the swinging foot is stepping up onto something, lean in and put a hand on it
  const sw = body.feet.find((ft) => ft.t < 1);
  const barrier = !four && sw && sw.rise > 0.3 ? sw : null;
  if (barrier) { const q = Math.sin(Math.PI * barrier.t); leanT += 0.3 * q; crouchT -= 0.08 * q; }
  if (dk) { leanT = Math.max(leanT, dk.lean); crouchT = Math.min(crouchT, dk.crouch); }

  let rollT = dk ? dk.roll : 0;
  if (vlt) { const q = Math.sin(Math.PI * vlt.t); leanT += 0.35 * q; rollT = -vlt.side * 0.3 * q; }
  [body.lean, body.vlean] = spring(body.lean, body.vlean, leanT, RIG.kLean, dt);
  body.crouch += (crouchT - body.crouch) * Math.min(1, dt * 12);
  [body.roll, body.vroll] = spring(body.roll, body.vroll, rollT, RIG.kLean, dt);

  // arms: on hands, the hands are where quadStep put them; otherwise they swing, or reach for a shrub / barrier / stem
  const chestY = body.pelvis.y + body.crouch + RIG.spine * Math.cos(body.lean);
  const ayaw = body.yaw ?? player.yaw, fwdX = -Math.sin(ayaw), fwdZ = -Math.cos(ayaw), cRx = Math.cos(ayaw), cRz = -Math.sin(ayaw); // (the body's facing: sideways in a shimmy)
  const chestX = player.x + fwdX * RIG.spine * Math.sin(body.lean), chestZ = player.z + fwdZ * RIG.spine * Math.sin(body.lean);
  updatePlants(dt, ux, uz, rx, rz, spd, four);
  let react = 0;
  for (const hnd of body.hands) {
    if (four && (hnd.sw || hnd.hold)) {
      let p = hnd.hold;
      if (hnd.sw) { const e = hnd.sw.t * hnd.sw.t * (3 - 2 * hnd.sw.t); p = V.add([0, 1, 2].map((k) => lerp(hnd.sw.from[k], hnd.sw.to[k], e)), body.q.n, Math.sin(Math.PI * hnd.sw.t) * 0.12); }
      hnd.p.set(p[0], p[1], p[2]); hnd.v.set(0, 0, 0); continue;
    }
    const shX = chestX + cRx * hnd.side * RIG.shoulderW, shZ = chestZ + cRz * hnd.side * RIG.shoulderW, shY = chestY - 0.05;
    const other = body.feet[hnd.side < 0 ? 1 : 0], swingAmt = spd > 0.05 ? clamp((other.x - player.x) * ux + (other.z - player.z) * uz, -0.4, 0.4) * 0.6 : 0;
    let tx = shX + fwdX * (0.08 + swingAmt), tz = shZ + fwdZ * (0.08 + swingAmt), ty = shY - 0.58, k = RIG.kHand;
    const pl = body.plants.find((p) => p.contact && p.side === hnd.side);
    if (pushState.on && pushState.p && !four) { // pushing: both palms on it, a hand's width apart across your view
      const p = pushState.p; tx = p[0] + cRx * hnd.side * 0.09; ty = p[1]; tz = p[2] + cRz * hnd.side * 0.09; k = 420;
    } else if (vlt && vlt.t < 0.75) { // both hands on the top: the lead hand at the crossing, the other further back across it
      const off = hnd.side === vlt.side ? -0.05 : -0.4;
      tx = vlt.cx + vlt.rx * vlt.side * off; tz = vlt.cz + vlt.rz * vlt.side * off; ty = vlt.topY + 0.03; k = 400;
    } else if (barrier && barrier.side === hnd.side) {
      tx = barrier.tx + cRx * hnd.side * 0.15; tz = barrier.tz + cRz * hnd.side * 0.15; ty = barrier.ty + 0.03; k = 300;
    } else if (body.duckHold && body.duckHold.side === hnd.side) { // a hand on the stem passing overhead
      const d = body.duckHold; tx = d.x; tz = d.z; ty = d.y - 0.03; k = 260;
    } else if (pl) { // palm on the near face of the shrub, which moves away as it yields
      const dl = Math.hypot(pl.dx, pl.dz), sgn = pl.side;
      tx = pl.x - rx * sgn * Math.max(0.05, pl.R - dl) + ux * 0.1; tz = pl.z - rz * sgn * Math.max(0.05, pl.R - dl) + uz * 0.1; ty = Math.min(chestY, groundAt(pl.x, pl.z) + pl.ph);
      k = 220; react += -sgn * pl.force;
    }
    const ax = tx - shX, ay = ty - shY, az = tz - shZ, al = Math.hypot(ax, ay, az), reach = RIG.upperArm + RIG.foreArm - 0.02; // within arm's reach
    if (al > reach) { tx = shX + (ax / al) * reach; ty = shY + (ay / al) * reach; tz = shZ + (az / al) * reach; }
    for (const [c, t] of [['x', tx], ['y', ty], ['z', tz]]) [hnd.p[c], hnd.v[c]] = spring(hnd.p[c], hnd.v[c], t, k, dt);
  }
  [body.react, body.vreact] = spring(body.react, body.vreact, clamp(react * RIG.pushReact, -0.12, 0.12), RIG.kLat, dt); // pushing: the head gives, then recovers // pushing: the head gives, then recovers

  // eye. Walking: rhythmic gait passes through at gaitPass; terrain and posture pass fully. On hands: in the head, the
  // face turned along the surface. Mixed as the hands are needed.
  const gait = (body.pelvis.y - body.base) * RIG.gaitPass;
  const cf = body.fb || { lat: 0, lean: 0, crouch: 0 }; // what contacts push the body by: applied at once (no spring), as the solver assumed
  const pelvisEye = body.base + gait + body.crouch + cf.crouch;
  const latEye = body.lat * RIG.gaitPass + body.react + cf.lat;
  const sl = RIG.spine + RIG.neck, lean = (body.lean + cf.lean) * M;
  let eye = {
    x: player.x + fwdX * (sl * Math.sin(lean) + RIG.eyeFwd) + cRx * (latEye + sl * Math.sin(body.roll)) * M,
    y: (M ? pelvisEye : rig.feet + RIG.leg - 0.04) + sl * Math.cos(lean),
    z: player.z + fwdZ * (sl * Math.sin(lean) + RIG.eyeFwd) + cRz * (latEye + sl * Math.sin(body.roll)) * M,
  };
  if (!M) { eye.x = player.x; eye.z = player.z; } // motion off: steady eye at standing height above the controller
  if (!four && !vlt && !overPlan) { // the head is solid: if the posture springs lag a sudden rise (a step up under a stem), the knees give at once (going over, the head is above the stem)
    const c = ceilingAt(eye.x, eye.z, rig.feet, [-Math.sin(player.yaw), -Math.cos(player.yaw)]), over = eye.y + 0.17 - (c - 0.03);
    if (over > 0) { body.crouch -= over; eye.y -= over; }
  }
  let sol = SK.solvePose(bodyPose()); body.sol = sol;
  if (body.st && !four) for (let pass = 0; pass < 2; pass++) { // rigid things, checked against this frame's pose: no frame of lag
    if (staticResolve(body.st, bodyCapsules(), staticCaps(player.x, player.z)) < 1e-3) break;
    feedbackMap(body.st, ux, uz); // (a swinging foot picks its share up next frame, with its arc)
    sol = SK.solvePose(bodyPose()); body.sol = sol;
  }
  if (body.st && !four) for (const ft of body.feet) if (ft.t >= 1) { // a planted leg takes its share at the knee (the foot stays put)
    const s = ft.side < 0 ? 'L' : 'R', a = body.st.off[CAP['thigh' + s]], b = body.st.off[CAP['shin' + s]], k = sol.J['knee' + s];
    const o = [a[0] * 0.5 + b[0] * 0.75, a[1] * 0.5 + b[1] * 0.75, a[2] * 0.5 + b[2] * 0.75], l = Math.hypot(...o), m = l > 0.2 ? 0.2 / l : 1;
    k[0] += o[0] * m; k[1] += o[1] * m; k[2] += o[2] * m;
  }
  const w = smoothstep(0, 1, body.mix || 0);
  if (w > 0) {
    const q = body.q, h = sol.J.head, e4 = V.add(V.add(h, q.n, 0.08), q.a, 0.04);
    q.eye = q.eye && w < 1.01 && V.len(V.sub(q.eye, e4)) < 1.5 ? V.add(q.eye, V.sub(e4, q.eye), Math.min(1, dt * 12)) : e4; // the head steadies the eye
    const eq = q.eye;
    eye = { x: lerp(eye.x, eq[0], w), y: lerp(eye.y, eq[1], w), z: lerp(eye.z, eq[2], w) };
    q.comU = V.dot(V.sub(V.add(sol.J.pelvis, sol.J.chest).map((v) => v / 2), q.S0), q.a);
    if (four) q.stats.short = Math.max(q.stats.short, ...[0, 1, 2, 3].map((i) => limbAt(i) ? sol.short[['handL', 'handR', 'footL', 'footR'][i]] : 0));
  } else body.q.eye = null;
  body.eye = eye; player.eye = eye.y;
}

const groundAt = (x, z) => ground(x, z);

// ---- shrubs as springs the hands push against
function updatePlants(dt, ux, uz, rx, rz, spd, four) {
  const pelX = player.x, pelZ = player.z;
  // find tall shrubs whose crown is in the upper-body corridor ahead
  const seen = new Set();
  if (!four && near) {
    const ci = Math.floor((pelX + HALF) / NC), cj = Math.floor((pelZ + HALF) / NC);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const items = near.cells.get((ci + di) * 4096 + cj + dj); if (!items) continue;
      for (const it of items) {
        const t = it[0];
        if (t === 'tall' && it[5] >= 1.1) consider(it, it[1], it[2], it[4] * 0.78, it[5], it[5] * 0.6);
        else if (t === 'shrub' && it[5] >= 0.55) consider(it, it[1], it[2], it[4] * 0.6, it[5], it[5] * 0.65);       // waist-high: the hand goes low
        else if ((t === 'seedB' || t === 'seedC') && it[5] >= 0.6) consider(it, it[1], it[2], it[4] * 1.1, it[5], it[5] * 0.7);
      }
    }
    const si = Math.floor((pelX + HALF) / 8), sj = Math.floor((pelZ + HALF) / 8);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = saplingCells?.get((si + di) * 4096 + sj + dj); if (!a) continue;
      // saplings are bent by the physics now (their branches are rods), not by this spring
    }
  }
  function consider(it, x, z, R, h, ph) {
    const ox = x - pelX, oz = z - pelZ, f = ox * ux + oz * uz, s = ox * rx + oz * rz;
    const pen = R + 0.32 - Math.abs(s);
    if (f < -0.5 || f > 1.1 || pen <= 0) return;
    seen.add(it);
    let p = body.plants.find((q) => q.it === it);
    if (!p) { if (body.plants.length >= 4) return; p = { it, x, z, h, R, ph, dx: 0, dz: 0, vx: 0, vz: 0, side: s >= 0 ? 1 : -1, force: 0 }; body.plants.push(p); }
    p.contact = f > -0.35 && spd > 0.05;
    p.pen = Math.min(pen, 0.5, R * 0.9);
    p.ax = rx * p.side; p.az = rz * p.side; // push direction: away from your path
  }
  for (const p of body.plants) {
    if (!seen.has(p.it)) p.contact = false;
    const tgt = p.contact ? p.pen : 0;
    const cur = p.dx * (p.ax ?? 0) + p.dz * (p.az ?? 0);
    p.force = p.contact ? Math.max(0, p.pen - cur) : 0;
    let tx = p.contact ? p.ax * tgt : 0, tz = p.contact ? p.az * tgt : 0;
    [p.dx, p.vx] = spring(p.dx, p.vx, tx, RIG.plantK, dt, RIG.plantZeta);
    [p.dz, p.vz] = spring(p.dz, p.vz, tz, RIG.plantK, dt, RIG.plantZeta);
  }
  body.plants = body.plants.filter((p) => p.contact || Math.hypot(p.dx, p.dz) > 0.003 || Math.hypot(p.vx, p.vz) > 0.01);
  // hand the plant displacements and footfalls to the vegetation shaders
  for (let i = 0; i < 4; i++) {
    const p = body.plants[i];
    if (p) { // the plant's own base (a sapling's trunk; its crown sits off-axis by its lean) and the load height
      const bx = p.it.tx ?? p.x, bz = p.it.tz ?? p.z;
      PUSH.uPA.value[i].set(bx, groundAt(bx, bz), bz, p.ph); PUSH.uPB.value[i].set(p.dx, p.dz, p.it.tol ?? 0.05, 1);
    }
    else PUSH.uPB.value[i].set(0, 0, 0, 0);
  }
  body.feet.forEach((ft, i) => PUSH.uFeet.value[i].set(ft.x, ft.y, ft.z, four ? 0 : 1));
}

// ---- camera
function applyCamera() {
  const e = body.eye || { x: player.x, y: player.eye, z: player.z };
  const M = MOTION[settings.motion] ?? 1;
  if (settings.view === 'third') {
    const cyaw = player.yaw + (body.orbit || 0), fx = -Math.sin(cyaw), fz = -Math.cos(cyaw);
    camera.position.set(player.x - fx * 3.2, (body.sol ? body.sol.J.pelvis[1] : body.pelvis.y) + 1.4, player.z - fz * 3.2);
    camera.rotation.set(-0.28 + player.pitch * 0.3, cyaw, 0);
  } else {
    camera.position.set(e.x, e.y, e.z);
    // crawling, the gaze tips up (or down) the stem by part of its slope, depending on which way you look along it
    // on hands, the gaze tips up (or down) the surface by part of its slope, depending on which way you look along it
    const q = body.q, ah = Math.hypot(q.a[0], q.a[2]) || 1e-6, cpT = smoothstep(0, 1, body.mix || 0) * 0.55 * Math.atan(q.a[1] / ah) * (-Math.sin(player.yaw) * q.a[0] - Math.cos(player.yaw) * q.a[2]) / ah;
    body.crawlPitch = lerp(body.crawlPitch || 0, cpT, 0.08);
    camera.rotation.set(clamp(player.pitch - (body.lean - 0.85 * body.duckLean) * RIG.gazeFollow * M + body.crawlPitch, -1.45, 1.45), player.yaw, -body.roll * 0.5 * M);
  }
  updateSkeleton();
}

// ---- the skeleton (Settings → Body: shown, or the third-person view)
// Walking: the gait above already decides where the feet and hands are and how the trunk leans; walkPose hands that to
// the shared solver. On hands, quadPose; bodyPose mixes the two by how much the hands are needed.
function walkPose() {
  const cf = body.fb && !body.four ? body.fb : { lat: 0, lean: 0, crouch: 0, hand: [[0, 0, 0], [0, 0, 0]] }; // contact offsets, at once
  const yaw = body.yaw ?? player.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rX = Math.cos(yaw), rZ = -Math.sin(yaw);
  return {
    pelvis: [player.x + rX * (body.lat + cf.lat), Math.max(rig.feet + 0.45, body.pelvis.y + body.crouch + cf.crouch) + 0.13 * (body.strK || 0), player.z + rZ * (body.lat + cf.lat)], // (straddling: up on the leading leg) // (a crouch-walk keeps the hips above 0.45 m: lower than that is on hands)
    frame: { R: [rX, 0, rZ], U: [0, 1, 0], F: [fx, 0, fz] }, bend: [body.lean + cf.lean, body.roll, 0], neckPitch: -neckBack(body.lean),
    feet: body.feet.map((ft) => [ft.x, ft.y + 0.06, ft.z]), toes: [[fx, 0, fz], [fx, 0, fz]],
    hands: body.hands.map((h, k) => [h.p.x + cf.hand[k][0], h.p.y + cf.hand[k][1], h.p.z + cf.hand[k][2]]),
    kneePole: body.shimmy > 0 ? [[-rX, 0.4, -rZ], [rX, 0.4, rZ]] : [[fx, 0.6, fz], [fx, 0.6, fz]], // forward and a little up (with the foot ahead of a low hip, a deep crouch, the knee rises rather than splaying); sideways in a gap, bowed out along the way
    elbowPole: [-1, 1].map((side) => [-fx + rX * side * 0.5, -0.6, -fz + rZ * side * 0.5]),
  };
}
let skel = null;
function updateSkeleton() {
  const sol = body.sol || (body.sol = SK.solvePose(walkPose()));
  const show = settings.view === 'third' || settings.body === 'shown';
  if (!skel) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xc9b79a }), g = new THREE.CylinderGeometry(1, 1, 1, 6); g.translate(0, 0.5, 0);
    skel = { group: new THREE.Group(), bones: Array.from({ length: 20 }, () => new THREE.Mesh(g, mat)), head: new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), mat) };
    skel.bones.forEach((b) => skel.group.add(b)); skel.group.add(skel.head); scene.add(skel.group);
  }
  skel.group.visible = show; if (!show || !body.eye) return;
  skel.bones.forEach((b, i) => {
    const s = sol.segs[i]; if (!s) { b.visible = false; return; }
    b.visible = true; const [a, c, r] = s, d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    b.matrixAutoUpdate = false; b.matrix.copy(along(a[0], a[1], a[2], d[0], d[1], d[2], r, Math.hypot(...d), r));
  });
  const h = sol.J.head; skel.head.position.set(h[0], h[1], h[2]);
  skel.head.visible = settings.view === 'third';
  if (!skel.marks) { // contact points of hands and feet: a dot, coloured by what it touches
    skel.marks = ['handL', 'handR', 'footL', 'footR'].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })));
    skel.marks.forEach((m) => { m.renderOrder = 10; skel.group.add(m); });
  }
  const KC = { branch: 0x9be06a, trunk: 0xe0a050, log: 0xd08a3a, root: 0xb07040, ground: 0x8a7a66, wood: 0xd08a3a, rock: 0xa0a8b0 };
  ['handL', 'handR', 'footL', 'footR'].forEach((nm, i) => { const c = body.contacts?.[nm], m = skel.marks[i]; m.visible = !!c; if (c) { m.position.set(...c.p); m.material.color.setHex(KC[c.kind] ?? 0xffffff); } });
}

// ---------------------------------------------------------------- input
const keyTarget = (e) => e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
addEventListener('keydown', (e) => { if (keyTarget(e)) return; input.keys.add(e.code); if (e.code === 'KeyM') toggle('pMap'); if (e.code === 'KeyC') captureSpot(); if (e.code === 'KeyB' && !e.repeat) pushStart(); if (W?.gym && e.code === 'BracketRight') goStation(gymAt + 1); if (W?.gym && e.code === 'BracketLeft') goStation(gymAt - 1); if (W?.gym && e.code === 'KeyR') goStation(gymAt); if (e.code === 'KeyV') { settings.view = settings.view === 'third' ? 'first' : 'third'; fView.value = settings.view; } });
addEventListener('keyup', (e) => { input.keys.delete(e.code); if (e.code === 'KeyB') pushStop(); });
addEventListener('blur', () => input.keys.clear());
const stickEl = $('stick'), knob = $('knob');
if (isTouch) { stickEl.hidden = false; $('hint').textContent = 'Left thumb to walk (a small push steps carefully) · drag right side to look'; }
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

const SPECIES_COLOR = ['#4f9fc0', '#d4ad3a', '#d0674a', '#e6e1d3', '#5a7fd6', '#8f6a3c', '#a8d05a', '#b7d36b', '#5f8f80', '#e05a7a', '#f08a30', '#c8c08a', '#9aa6a0', '#b4835a', '#3f8a4a', '#d0402a', '#e8c040', '#f0ece0']; // map identity colours, in SPECIES order
function mapLegend() { // the species this world grows
  const has = SPECIES.map(() => false); for (const t of W.trees) if (t.st === 0 && t.d >= 10) has[t.sp] = true;
  $('mapLegend').innerHTML = SPECIES.map((s, i) => has[i] ? `<span><i style="background:${SPECIES_COLOR[i]}"></i>${s.name}</span>` : '').join('') +
    '<span><i class="line" style="background:#a0784e"></i>Log</span><span><i style="background:#8d8a84"></i>Snag</span><span><i class="line" style="background:#6fa3c9"></i>Stream</span>';
}

function drawMapBase() {
  mapLegend();
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
      for (const p of t.rest?.pieces || []) { g.beginPath(); g.moveTo(x + (p.x0 - t.x) * k, y + (p.z0 - t.z) * k); g.lineTo(x + (p.x1 - t.x) * k, y + (p.z1 - t.z) * k); g.stroke(); }
    }
  }
  for (const t of W.trees) {
    const x = (t.x + HALF) * k, y = (t.z + HALF) * k;
    if (t.crushed) continue;
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
  player.x = tx; player.z = tz; refreshNear(tx, tz, true); resetRig(); drawMapTop();
});

// stand panel
const REF = { stems: '300–700', ba: '25–50', snags: '10–60', logs: '50–400', logVol: '5–200', saplings: '—' };
function fillStand() {
  const s = W.stats, f0 = (v) => Math.round(v).toLocaleString(), f1 = (v) => v.toFixed(1);
  const comp = SPECIES.map((p, i) => [p.name, s.bySpeciesBA[i] / (s.ba || 1)]).sort((a, b) => b[1] - a[1]).filter((a) => a[1] > 0.05).map(([n, v]) => `${n} ${Math.round(v * 100)}%`).join(' · ');
  $('standSub').textContent = `${W.age} years after a stand-replacing fire, ${W.geology.name.toLowerCase()} bedrock, ${REGIONS[W.region || 'temperate'].name.toLowerCase()} region, ${W.opt.moisture} moisture, ${W.opt.season || 'summer'}, ${W.stats.storms} windstorm${W.stats.storms === 1 ? '' : 's'}. Basal area: ${comp}.`;
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
const fRegion = $('fRegion'), fSeason = $('fSeason');
const fSeed = $('fSeed'), fAge = $('fAge'), fMoist = $('fMoist'), fStorm = $('fStorm'), fQual = $('fQual'), fGeo = $('fGeo'), fMotion = $('fMotion'), fView = $('fView'), fBody = $('fBody');
const fPlace = $('fPlace');
function syncForm() { fPlace.value = settings.place || 'forest'; fSeed.value = settings.seed; fAge.value = String(settings.age); fMoist.value = settings.moisture; fStorm.value = settings.storms; fQual.value = settings.quality; fGeo.value = settings.geology; fMotion.value = settings.motion || 'full'; fRegion.value = settings.region || 'temperate'; fSeason.value = settings.season || 'summer'; }
fMotion.addEventListener('change', () => { settings.motion = fMotion.value; saveSettings(); });
fView.value = settings.view || 'first'; fBody.value = settings.body || 'hidden';
fView.addEventListener('change', () => { settings.view = fView.value; saveSettings(); });
fBody.addEventListener('change', () => { settings.body = fBody.value; saveSettings(); });
syncForm();
$('bDice').addEventListener('click', () => { fSeed.value = 1 + Math.floor(Math.random() * 99999); });
$('bRegen').addEventListener('click', () => {
  const q = fQual.value !== settings.quality;
  Object.assign(settings, { place: fPlace.value, seed: clamp(parseInt(fSeed.value, 10) || 1, 1, 999999), age: +fAge.value, moisture: fMoist.value, storms: fStorm.value, geology: fGeo.value, quality: fQual.value, region: fRegion.value, season: fSeason.value });
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
  const dt = Math.min(0.1, (now - last) / 1000), interval = now - last; last = now;
  uTime.value = now / 1000;
  if (bench.walk) { input.f = 1; input.run = true; player.yaw += dt * 0.12; player.pitch = bench.pitch; } // the benchmark walks a wide arc
  const c0 = performance.now();
  movePlayer(dt);
  physStep(dt);
  const c1 = performance.now();
  refreshNear(player.x, player.z);
  const c2 = performance.now();
  applyCamera();
  breakTarget(); pushUpdate(dt);
  sky.position.copy(camera.position);
  // shadow camera follows the player, snapped to texels to avoid shimmering
  const texel = 96 / sun.shadow.mapSize.x, sx = Math.round(player.x / texel) * texel, sz = Math.round(player.z / texel) * texel;
  sun.target.position.set(sx, player.eye - 1.6, sz); sun.position.copy(sun.target.position).addScaledVector(sunDir, 150);
  const shadowNow = perfOpt.shadow > 0 && frameNo % perfOpt.shadow === 0;
  renderer.shadowMap.needsUpdate = shadowNow;
  updateTiles();
  terrainU.uCenter.value.set(Math.round(player.x / 8) * 8, Math.round(player.z / 8) * 8);
  const c3 = performance.now();
  gpuBegin();
  renderer.render(scene, camera);
  gpuEnd(shadowNow);
  perfFrame(interval, c1 - c0, c2 - c1, c3 - c2, performance.now() - c3, shadowNow);
  frameNo++; frames++; fpsT += dt;
  if (fpsT > 0.5) {
    $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0;
    const f = fieldAt(player.x, player.z);
    if (W.gym) $('hudHere').textContent = gymStatus(); else $('hudHere').textContent = `elev ${ground(player.x, player.z).toFixed(0)} m · slope ${Math.round(Math.atan(f.sl) * 57.3)}° · sky ${Math.round(f.L * 100)}% · wet ${f.wet.toFixed(2)}`;
    if (!$('pMap').hidden) drawMapTop();
    if (!$('pPerf').hidden) $('perfLive').textContent = perfSummary(120);
  }
}

// ---------------------------------------------------------------- performance: live profiling and an on-device benchmark
// Per frame: the interval between frames (what you feel), CPU time in each stage (movement and body; near-field and
// plant refresh; camera, tiles and shadow set-up; submitting the render), GPU time where the browser exposes a timer
// (EXT_disjoint_timer_query_webgl2), draw calls and triangles (shadow pass included). Frames that redraw the shadow map
// are kept apart, since shadows update every other frame by default and an uneven pair of frames reads as judder.
// Note: a 60 Hz display rounds frame intervals to 16.7 ms steps, so the CPU and GPU times say more than fps does.
const perfOpt = { shadow: 2, roots: true, ground: true, pr: 'auto' };
const perf = { n: 600, i: 0, count: 0, spikes: [], label: 'live', rows: new Float32Array(600 * 10), gpuQ: [], gpuPool: [], gpu: null };
{
  const gl = renderer.getContext();
  const ext = gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
  perf.gpu = ext ? { gl, ext } : null;
  const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
  perf.device = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}
let gpuOpen = null, lastGpu = NaN, lastGpuShadow = 0;
function gpuBegin() {
  if (!perf.gpu) return; const { gl, ext } = perf.gpu;
  const q = perf.gpuPool.pop() || gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); gpuOpen = q;
}
function gpuEnd(shadow) {
  if (!perf.gpu || !gpuOpen) return; const { gl, ext } = perf.gpu;
  gl.endQuery(ext.TIME_ELAPSED_EXT); perf.gpuQ.push([gpuOpen, shadow]); gpuOpen = null;
  while (perf.gpuQ.length) { // results arrive a few frames late
    const [q, sh] = perf.gpuQ[0]; if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    const bad = gl.getParameter(ext.GPU_DISJOINT_EXT), ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    perf.gpuQ.shift(); perf.gpuPool.push(q);
    if (!bad) { lastGpu = ns / 1e6; lastGpuShadow = sh ? 1 : 0; }
  }
}
function perfFrame(interval, move, nearT, setup, submit, shadow) {
  const r = perf.rows, k = perf.i * 10, info = renderer.info.render;
  r[k] = interval; r[k + 1] = move; r[k + 2] = nearT; r[k + 3] = setup; r[k + 4] = submit; r[k + 5] = shadow ? 1 : 0;
  r[k + 6] = info.calls; r[k + 7] = info.triangles; r[k + 8] = lastGpu; r[k + 9] = lastGpuShadow; lastGpu = NaN; // GPU results arrive late: col 9 says whether that frame drew shadows
  perf.i = (perf.i + 1) % perf.n; perf.count++;
  if (interval > 24 && perf.count > 30) { // a dropped frame: keep what the CPU was doing in it and the frame before
    const pk = ((perf.i - 2 + perf.n) % perf.n) * 10;
    perf.spikes.push({ at: perf.label, interval, move, near: nearT, setup, submit, shadow, prevSubmit: r[pk + 4], prevNear: r[pk + 2], prevShadow: r[pk + 5] });
    if (perf.spikes.length > 200) perf.spikes.shift();
  }
}
function perfStats(frames) { // over the last `frames` frames
  const m = Math.min(frames, perf.count, perf.n), r = perf.rows, cols = Array.from({ length: 10 }, () => []);
  for (let j = 1; j <= m; j++) { const k = ((perf.i - j + perf.n) % perf.n) * 10; for (let c = 0; c < 10; c++) cols[c].push(r[k + c]); }
  const q = (a, p) => { const b = a.filter((v) => !Number.isNaN(v)).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
  const sh = (c, want) => cols[c].filter((_, j) => cols[5][j] === want);
  const gS = cols[8].filter((_, j) => cols[9][j] === 1), gN = cols[8].filter((_, j) => cols[9][j] === 0);
  return { m, med: q(cols[0], 0.5), p95: q(cols[0], 0.95), max: q(cols[0], 1), move: q(cols[1], 0.5), near: q(cols[2], 0.5), nearMax: q(cols[2], 1), setup: q(cols[3], 0.5),
    submit: q(cols[4], 0.5), submitShadow: q(sh(4, 1), 0.5), submitPlain: q(sh(4, 0), 0.5), calls: q(cols[6], 0.5), tris: q(cols[7], 0.5),
    gpu: q(cols[8], 0.5), gpuShadow: q(gS, 0.5), gpuPlain: q(gN, 0.5) };
}
const f1 = (v) => (Number.isNaN(v) ? '—' : v.toFixed(1));
function perfSummary(frames) {
  const s = perfStats(frames);
  return `frame   median ${f1(s.med)} ms (${Math.round(1000 / s.med)} fps) · 95% ${f1(s.p95)} · worst ${f1(s.max)}
cpu     body ${f1(s.move)} · near refresh ${f1(s.near)} (worst ${f1(s.nearMax)}) · set-up ${f1(s.setup)} · render submit ${f1(s.submit)} (shadow frames ${f1(s.submitShadow)}, others ${f1(s.submitPlain)})
gpu     ${perf.gpu ? `${f1(s.gpu)} ms (shadow frames ${f1(s.gpuShadow)}, others ${f1(s.gpuPlain)})` : 'no timer in this browser'}
scene   ${Math.round(s.calls)} draw calls · ${(s.tris / 1e6).toFixed(2)} M triangles (shadow pass included)
physics ${f1(phys.ms)} ms on the ${phys.worker ? 'worker thread' : 'main thread'} · ${phys.nodes} branch segments in ${phys.groups.size} groups · push-back ${Math.round(Math.hypot(...phys.force))} N`;
}
function applyPerfOpt() {
  PLANT_R = +$('qRing').value; perfOpt.shadow = +$('qShadow').value; perfOpt.roots = $('qRoots').value === '1'; perfOpt.ground = $('qGround').value === '1'; perfOpt.pr = $('qPR').value;
  sun.castShadow = perfOpt.shadow > 0; if (!sun.castShadow) renderer.shadowMap.needsUpdate = true;
  if (rootMeshObj) rootMeshObj.visible = perfOpt.roots;
  if (near) for (const nb of Object.values(near.b)) nb.mesh.visible = perfOpt.ground;
  renderer.setPixelRatio(perfOpt.pr === 'auto' ? Math.min(devicePixelRatio || 1, settings.quality === 'high' ? 2 : 1.25) : +perfOpt.pr); // numbers: device pixels per CSS pixel
  resize(); plantNear.cx = 1e9; refreshPlants(player.x, player.z, true);
}
for (const id of ['qShadow', 'qRing', 'qRoots', 'qGround', 'qPR']) $(id).addEventListener('change', applyPerfOpt);
function perfPanel(show) { $('pPerf').hidden = !(show ?? $('pPerf').hidden); if (!$('pPerf').hidden) { toggle(null); $('perfLive').textContent = perfSummary(120); } }
$('fps').addEventListener('click', () => perfPanel());
$('perfClose').addEventListener('click', () => perfPanel(false));
addEventListener('keydown', (e) => { if (e.code === 'KeyP' && !keyTarget(e)) perfPanel(); });
function perfHeader() {
  const c = renderer.domElement;
  return `Foothold performance report
device   ${perf.device} · ${navigator.userAgent.replace(/\s+/g, ' ').slice(0, 140)}
screen   ${innerWidth}×${innerHeight} css px · devicePixelRatio ${devicePixelRatio} · canvas ${c.width}×${c.height} · graphics ${settings.quality}
world    ${W.gym ? 'gym' : `seed ${W.seed} · ${W.age} yr · ${W.opt.moisture} · ${W.opt.storms} · ${W.opt.geology}`} · at ${player.x.toFixed(0)}, ${player.z.toFixed(0)}`;
}
$('bPerfCopy').addEventListener('click', async () => {
  const txt = $('perfOut').value || `${perfHeader()}\n\nlive, last 4 s\n${perfSummary(240)}`;
  $('perfOut').value = txt;
  try { await navigator.clipboard.writeText(txt); $('bPerfCopy').textContent = 'Copied'; } catch (e) { $('perfOut').select(); $('bPerfCopy').textContent = 'Select and copy'; }
  setTimeout(() => { $('bPerfCopy').textContent = 'Copy report'; }, 2000);
});
// The benchmark: stand still, then for each configuration settle for 1.5 s (shader compiles, refills) and measure 3 s.
const BENCH = [
  ['baseline (your settings)', {}],
  ['shadows off', { qShadow: '0' }],
  ['shadows every frame', { qShadow: '1' }],
  ['shadows every 4th frame', { qShadow: '4' }],
  ['no grown trees (cards only)', { qRing: '0' }],
  ['grown trees within 20 m', { qRing: '20' }],
  ['grown trees within 40 m', { qRing: '40' }],
  ['roots hidden', { qRoots: '0' }],
  ['ground cover hidden', { qGround: '0' }],
  ['1× pixels', { qPR: '1' }],
  ['0.5× pixels', { qPR: '0.5' }],
];
let benching = false;
const bench = { walk: false, pitch: 0 };
$('bBench').addEventListener('click', async () => {
  if (benching) return; benching = true; $('bBench').disabled = true;
  const keep = Object.fromEntries(['qShadow', 'qRing', 'qRoots', 'qGround', 'qPR'].map((id) => [id, $(id).value]));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [], start = { x: player.x, z: player.z, yaw: player.yaw, pitch: player.pitch }, walk = $('qWalk').checked;
  input.keys.clear?.(); perf.spikes = [];
  const home = () => { player.x = start.x; player.z = start.z; player.yaw = start.yaw; player.pitch = start.pitch; resetRig(); refreshNear(player.x, player.z, true); };
  for (const [name, set] of BENCH) {
    for (const [id, v] of Object.entries(keep)) $(id).value = set[id] ?? v;
    applyPerfOpt(); home(); bench.pitch = start.pitch;
    $('perfLive').textContent = `measuring: ${name} …`;
    perf.label = 'settle'; await wait(1500);
    bench.walk = walk; perf.label = name; const c0 = perf.count; await wait(walk ? 4500 : 3000); bench.walk = false; input.f = 0; input.run = false;
    const s = perfStats(perf.count - c0); s.drops = perf.spikes.filter((k) => k.at === name).length; rows.push([name, s]);
  }
  for (const [id, v] of Object.entries(keep)) $(id).value = v;
  applyPerfOpt(); home(); perf.label = 'live';
  const b = rows[0][1];
  const pad = (t, n) => (t + ' '.repeat(n)).slice(0, n);
  const table = rows.map(([n, s]) => `${pad(n, 30)} ${pad(f1(s.med), 6)} ${pad(f1(s.p95), 6)} ${pad(String(s.drops) + '/' + s.m, 8)} ${pad(f1(s.submit), 7)} ${pad(f1(s.near), 5)} ${pad(f1(s.gpu), 7)} ${pad(String(Math.round(s.calls)), 6)} ${(s.tris / 1e6).toFixed(2)}M${s === b ? '' : `   gpu ${Number.isNaN(s.gpu) ? '—' : (s.gpu - b.gpu >= 0 ? '+' : '') + f1(s.gpu - b.gpu)} · frame ${(s.med - b.med >= 0 ? '+' : '') + f1(s.med - b.med)}`}`).join('\n');
  $('perfOut').value = `${perfHeader()}

benchmark, ${walk ? 'walking an arc' : 'standing still'} (ms; frame = time between frames, median and 95th percentile; drops = frames over 24 ms / frames;
submit = CPU to issue the render; near = CPU for near-field, tree and root refresh; gpu = GPU time)
${pad('configuration', 30)} ${pad('frame', 6)} ${pad('p95', 6)} ${pad('drops', 8)} ${pad('submit', 7)} ${pad('near', 5)} ${pad('gpu', 7)} ${pad('calls', 6)} tris
${table}

slowest frames (ms: interval · body · near · set-up · submit, shadow map redrawn?; then the frame before)
${perf.spikes.filter((k) => k.at !== 'settle').sort((a, b) => b.interval - a.interval).slice(0, 8).map((k) => `${pad(k.at, 30)} ${f1(k.interval)} · ${f1(k.move)} · ${f1(k.near)} · ${f1(k.setup)} · ${f1(k.submit)}${k.shadow ? ' shadow' : ''}   before: near ${f1(k.prevNear)} submit ${f1(k.prevSubmit)}${k.prevShadow ? ' shadow' : ''}`).join('\n') || 'none'}

live before the benchmark
${perfSummary(240)}`;
  $('perfLive').textContent = perfSummary(120);
  benching = false; $('bBench').disabled = false;
});
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
    if (settings.place === 'gym') W = buildGymWorld(loadCaptures());
    else W = await generateWorld({ seed: settings.seed, age: settings.age, moisture: settings.moisture, storms: settings.storms, geology: settings.geology, region: settings.region, season: settings.season }, async (msg, p) => {
      stage.textContent = msg; fill.style.width = `${Math.round(p * 100)}%`; await nextFrame();
    });
    $('gymNav').hidden = !W.gym;
    stage.textContent = 'Building meshes'; await nextFrame();
    buildWorld(); spawn(); refreshNear(player.x, player.z, true);
    drawMapBase(); fillStand();
    const s = W.stats;
    if (W.gym) showStation(); else $('hudWorld').textContent = `seed ${W.seed} · ${W.age} yr · ${Math.round(s.stems)} trees/ha · ${s.logVol.toFixed(0)} m³/ha down wood`;
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
  get world() { return W; }, get supportRef() { return supportRef; }, mats, player, settings, ground: (x, z) => ground(x, z), resetRig, input, RIG, body, applyCam: () => applyCamera(), nearCells: () => near.cells, step(dt) { movePlayer(dt); physStep(dt); refreshNear(player.x, player.z); },
  physics: { MD, modal: () => modal, clipScan, contacts: () => body.contacts, falls: () => falls, state: () => phys, useMain() { physReset('main'); }, audit(on = true) { if (!phys.core) physReset('main'); phys.core.audit = on; return phys.core; }, /* energy per stage on every free object (main thread): core.free.get(id).au */ useWorker() { physReset('worker'); }, capsules: () => bodyCapsules() },
  branches: { crunchSegs, crunchStack, branchLoad, get crunchList() { return crunchList; }, logBuf: () => logBuf, logLeafBuf: () => logLeafBuf, logBranches, plantVariant, target: () => breakTargetAt, pick() { const r = running; running = true; breakTarget(); running = r; return breakTargetAt; }, push: pushState, pushStart, pushStop, pushUpdate, breakBranch, treeSegs, plantCells: () => plantCells, brokenTrees: () => brokenTrees, limbSolids, logBranchCells: () => branchLogCells },
  plants: { lib: plantLib, roots: () => rootMeshObj, rootQueue: () => rootQueue, rootCells: () => rootCells, PL },
  debug: { branchSolids: () => [...new Set([...solids.values()].flat())].filter((o) => o.limb || o.branch), overTrack: (mode, side = -1, n = 120) => { // a way over, solved pose by pose, as joint positions in the barrier's frame [a along its normal from the near face, y up, s to the right] (for sim/)
      const B = body.barrier || barrierAt(player.x, player.z, -Math.sin(player.yaw), -Math.cos(player.yaw)); if (!B) return null; const sc = overScript(mode, B), keys = overWorld(B, sc, side, bodyPose());
      const loc = (p) => { const dx = p[0] - B.O[0], dz = p[2] - B.O[1]; return [+(dx * B.n[0] + dz * B.n[1]).toFixed(4), +(p[1] - B.y0).toFixed(4), +(dx * B.r[0] + dz * B.r[1]).toFixed(4)]; };
      const frames = []; for (let i = 0; i <= n; i++) { const t = i / n, sol = SK.solvePose(overPose(keys, t)); frames.push({ t: +(t * sc.dur).toFixed(4), J: Object.fromEntries(Object.entries(sol.J).map(([k, v]) => [k, loc(v)])) }); }
      return { mode, side, dur: sc.dur, barrier: { H: B.H, D: B.D, L: B.L, C: B.C === Infinity ? null : B.C, W: B.W }, frames }; },
    overDiag: (mode, side = -1, n = 96) => { const B = body.barrier || barrierAt(player.x, player.z, -Math.sin(player.yaw), -Math.cos(player.yaw)); if (!B) return 'no barrier'; const sc = overScript(mode, B), keys = overWorld(B, sc, side, bodyPose()), out = [];
      const loc = (p) => { const dx = p[0] - B.O[0], dz = p[2] - B.O[1]; return `${(dx * B.n[0] + dz * B.n[1]).toFixed(2)},${(p[1] - B.y0).toFixed(2)},${(dx * B.r[0] + dz * B.r[1]).toFixed(2)}`; };
      for (let i = 1; i <= n; i++) { const t = i / n, sol = SK.solvePose(overPose(keys, t)), J = sol.J, g = capsPen(capsOf(J), J.pelvis[0], J.pelvis[2]);
        out.push(`t ${t.toFixed(2)} ${(g.pen * 100).toFixed(0)}cm ${g.what} | pel ${loc(J.pelvis)} chest ${loc(J.chest)} head ${loc(J.head)} | kneeL ${loc(J.kneeL)} ankL ${loc(J.ankleL)} kneeR ${loc(J.kneeR)} ankR ${loc(J.ankleR)} | hL ${loc(J.handL)} hR ${loc(J.handR)} short ${['footL','footR','handL','handR'].map((k) => (sol.short[k] * 100).toFixed(0)).join('/')}`); }
      return `H ${B.H.toFixed(2)} D ${B.D.toFixed(2)} L ${B.L.toFixed(2)}\n` + out.join('\n'); }, barrier: () => body.barrier, overTried: () => body.overTried, measure: () => barrierAt(player.x, player.z, -Math.sin(player.yaw), -Math.cos(player.yaw)), supportAt: (x, z) => supportAt(x, z), gapAhead: (x, z, ux, uz) => gapAhead(x, z, ux, uz, rig.feet), shimmyFits: (x, z, ux, uz) => shimmyFits(x, z, ux, uz, rig.feet), rig: () => rig, stepOverAt: (x, z, s, ux, uz) => stepOverAt(x, z, s, ux, uz), footSupport: (x, z) => footSupport(x, z), bodyBlocked: (x, z, ux, uz) => { const r = bodyBlocked(x, z, ux, uz, rig.feet); return r ? colWhy : ''; } },
  gym: { pen: () => gymPen(), progress: () => gymProgress(), get at() { return gymAt; }, go: (i) => goStation(i), run: (i, secs) => gymRun(i, secs), capture: () => captureSpot(), stationOrigin },
  loco: { stemAt, stemUnder, assess, grade, holdsNear, placeContact, stability, quadAllows, limbAt, GAIT4, TRACTION, get need() { return body.need; }, get q() { return body.q; } }, col: { topOf, supportAt, ceilingAt, duckPosture, saplings: () => saplingCells, steerAround, stemPushOut, stemObstacles, footSupport, supportGrad, slopeAt, trunkHit, solids: () => solids }, rig,
  pause() { running = false; },
  info() { return { near: Object.fromEntries(Object.entries(near.b).map(([k, v]) => [k, v.n])), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries }; },
  view(x, y, z, tx, ty, tz) { // free camera for inspection: player stands at the target so near detail loads there
    player.x = tx; player.z = tz; this.renderOnce(); camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); sky.position.copy(camera.position); renderer.shadowMap.needsUpdate = true; renderer.render(scene, camera);
  },
  renderOnce() { refreshNear(player.x, player.z, true); applyCamera(); sky.position.copy(camera.position); renderer.shadowMap.needsUpdate = true; uTime.value = 0; updateTiles(); terrainU.uCenter.value.set(Math.round(player.x / 8) * 8, Math.round(player.z / 8) * 8); renderer.render(scene, camera); },
};

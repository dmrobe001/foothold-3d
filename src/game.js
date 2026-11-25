// Foothold renderer, controls and UI. World data comes from ./worldgen.js.
import * as THREE from 'three';
import { generateWorld, sampleGrid, SPECIES, GEOLOGY, crownRadius, crownFraction, WORLD, N, NF, CELL, HALF, hash3, mulberry32, makeNoise2D, clamp, smoothstep } from './worldgen.js';
import { settleDeadfall, trunkProfile } from './deadfall.js';
import { buildGymWorld, gymToWorld, stationOrigin, STATIONS } from './gym.js';
import * as SK from './skeleton.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------------------------------------------------------------- settings
const settings = { seed: 1, age: 160, moisture: 'mesic', storms: 'occasional', geology: 'granite', quality: isTouch ? 'low' : 'high', motion: 'full', view: 'first', body: 'hidden', place: 'forest' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('foothold.settings') || '{}')); } catch (e) { /* storage unavailable */ }
try { if (/(^|[?#&])gym\b/.test(location.search.slice(1) + '&' + location.hash.slice(1))) settings.place = 'gym'; } catch (e) { /* no location */ }
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
// A pushed plant bends like a pole loaded at one point: the hand (or body) at height h above its base, displaced by
// s = uPB.xy there. Below h the stem takes the cantilever's point-load deflection, s * u^2 (3 - u) / 2 with u = y / h,
// tilting with the local slope. Above h nothing bends: the rest of the plant is carried rigidly, rotated by the stem's
// angle at the load point, atan(1.5 |s| / h). Stems don't stretch: the load point drops by 0.6 |s|^2 / h (the arc
// length of that curve), points below drop in proportion.
// uPA: base x, y, z, load height h. uPB: s.x, s.z, tolerance for recognising the plant's own instances, active flag.
function pushPatch(sh, footR) {
  Object.assign(sh.uniforms, PUSH, { uFootR: { value: footR } });
  sh.vertexShader = `uniform vec4 uPA[4]; uniform vec4 uPB[4]; uniform vec4 uFeet[2]; uniform float uFootR;
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
      for (int i = 0; i < 2; i++) {           // legs part low plants radially
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
  shrub: foliageMaterial(tex.shrub, { wind: 0.04, footR: 0.5 }),
  fern: foliageMaterial(tex.fern, { wind: 0.06, alphaTest: 0.4, footR: 0.45 }),
  grass: foliageMaterial(tex.grass, { wind: 0.09, alphaTest: 0.35, footR: 0.32 }),
  bark: new THREE.MeshLambertMaterial({ map: tex.bark }),
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
  trunk: trunkGeo(), plate: rootPlateGeo(), piece: pieceGeo(false, 7), butt: pieceGeo(true, 7), pieceLo: pieceGeo(false, 5), buttLo: pieceGeo(true, 5),
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
  add(mat, r, g, b, imp = 1, bend = null, wob = null) { this.items.push([mat.elements.slice(), lin(r), lin(g), lin(b), imp, bend, wob]); }
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
}

// ---------------------------------------------------------------- world build
let W = null;          // world data from worldgen
let worldGroup = null; // all meshes for the current world
let tiles = [];        // {group, cx, cz}
let near = null;       // near-field scatter batches
let colTrunks = null, colLogs = null, logCells = null;
const ground = (x, z) => sampleGrid(W.HF, NF, x, z);
const LITH = { granite: { kind: 'angular', round: 0.5, col: [0.50, 0.48, 0.46], bed: 0, lichen: [0.66, 0.68, 0.56] }, sandstone: { kind: 'slab', round: 0.2, col: [0.58, 0.48, 0.37], bed: 1, lichen: [0.70, 0.66, 0.50] }, basalt: { kind: 'angular', round: 0.08, col: [0.30, 0.30, 0.29], bed: 0, lichen: [0.62, 0.66, 0.52] } };
let hfTex = null, hcTex = null, ecoATex = null, ecoBTex = null, nearTerrain = null;

const TINT = {
  leaf: [[0.80, 0.86, 0.70], [0.86, 0.90, 0.62], [0.78, 0.92, 0.66], [0.98, 1.0, 0.70]],   // per species (fir, pine, maple, birch)
  bark: [[0.48, 0.40, 0.35], [0.62, 0.44, 0.33], [0.55, 0.52, 0.48], [0.96, 0.94, 0.90]],
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
  const B = Array.from({ length: NT * NT }, () => ({ trunk: new Batch(), piece: new Batch(), butt: new Batch(), broad: new Batch(), cone: new Batch(), pine: new Batch(), plate: new Batch(), rk: [new Batch(), new Batch(), new Batch(), new Batch()] }));
  const tileOf = (x, z) => clamp(Math.floor((z + HALF) / TILE), 0, NT - 1) * NT + clamp(Math.floor((x + HALF) / TILE), 0, NT - 1);
  colTrunks = new Map(); colLogs = []; logCells = new Map(); solids = new Map(); saplingCells = new Map();
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
    const gy = ground(t.x, t.z), kind = P.kind, yaw = r() * Math.PI * 2, rad = t.d / 100;
    const vari = 0.88 + 0.24 * r();
    const f = t.form || { lx: 0, lz: 0, sx: 0, sz: 0, A: 0, k: 1, ph: 0 };
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw);
    const toL = (wx, wz) => [wx * cy0 - wz * sy0, wx * sy0 + wz * cy0];
    const toW = (lx, lz) => [lx * cy0 + lz * sy0, -lx * sy0 + lz * cy0];
    f.bl = [...toL(f.lx + (t.lean?.[0] || 0), f.lz + (t.lean?.[1] || 0)), ...toL(f.sx, f.sz)];
    const bendAttr = f.bl, wobAttr = [f.A, f.k, f.ph, 1];
    if (t.st === 0) {
      const h = t.h, cf = crownFraction(t.sp) * (t.L !== undefined ? 0.75 + 0.25 * clamp(t.L * 2, 0, 1) : 1) * (t.d < 6 ? 1.15 : 1);
      const crownLen = Math.min(h * 0.95, h * cf), cr = crownRadius(t.sp, t.d) * (0.85 + 0.3 * r());
      const bt = TINT.bark[t.sp], H = kind === 'conifer' ? h * 0.97 : h * 0.86;
      b.trunk.add(trs(t.x, gy - 0.15, t.z, yaw, rad, H, rad), bt[0] * vari, bt[1] * vari, bt[2] * vari, t.d, bendAttr, wobAttr);
      const lt = TINT.leaf[t.sp], shadeDull = t.L !== undefined ? 0.82 + 0.18 * clamp(t.L * 3, 0, 1) : 1, cv = vari * shadeDull;
      const cy = gy + h - crownLen;
      // the crown sits on the bent stem: offset by the stem displacement at crown base (and a bit toward the top)
      const ub = clamp((h - crownLen) / H, 0, 1), um = clamp((h - crownLen * 0.5) / H, 0, 1);
      const o1 = toW(...bendLocal(f, ub, H)), o2 = toW(...bendLocal(f, um, H));
      const dx = (o1[0] + o2[0]) / 2, dz = (o1[1] + o2[1]) / 2;
      if (kind === 'conifer') b.cone.add(trs(t.x + dx, cy, t.z + dz, yaw, cr, crownLen * 1.04, cr), lt[0] * cv, lt[1] * cv, lt[2] * cv, t.d);
      else (kind === 'pine' ? b.pine : b.broad).add(trs(t.x + dx, cy, t.z + dz, yaw, cr, crownLen, cr * (0.85 + 0.3 * r())), lt[0] * cv, lt[1] * cv, lt[2] * cv, t.d);
      if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
      else if (h > 1.3) pushCol(saplingCells, t.x, t.z, { sap: true, tx: t.x, tz: t.z, tol: Math.hypot(dx, dz) + 0.05, x: t.x + dx * 0.3, z: t.z + dz * 0.3, r: 0.04 + t.d / 200, h, R: cr * 0.9, base: h - crownLen });
    } else if (t.st === 1) {
      const grey = mix3(TINT.bark[t.sp], [0.62, 0.60, 0.56], clamp(t.t / 20, 0, 0.8));
      b.trunk.add(trs(t.x, gy - 0.15, t.z, yaw, rad, t.sh, rad), grey[0] * vari, grey[1] * vari, grey[2] * vari, t.d * 0.7, [0, 0, f.bl[2], f.bl[3]], wobAttr);
      if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
    } else if (t.st === 2) {
      const T = (15 + 1.3 * t.d) * P.decay, fd = clamp(t.t / T, 0, 1), cls = 1 + Math.floor(fd * 4.999), R = t.rest;
      const dirx = Math.cos(R.a), dirz = Math.sin(R.a), rr = (t.d / 200) * (1 - 0.15 * fd);
      const col = cls <= 2 ? mix3(TINT.bark[t.sp], [0.42, 0.34, 0.27], t.sp === 3 ? 0.3 : 0.6) : mix3([0.44, 0.36, 0.28], [0.34, 0.37, 0.21], (cls - 3) / 2);
      for (const p of R.pieces) {
        const whole = p.u0 === 0 && p.u1 === 1, len = Math.hypot(p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0);
        const wob = [f.A * (1 - 0.4 * fd), f.k, f.ph + f.k * p.u0 * R.L, 0.25];
        // a piece's instance scale is its own mean radius; the butt geometry carries the flare on top of that
        const um = (Math.max(p.u0, 0.14) + p.u1) / 2, ks = whole ? 1 : trunkProfile(um);
        const batch = whole ? b.trunk : p.u0 === 0 ? b.butt : b.piece;
        batch.add(along(p.x0, p.y0, p.z0, p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0, R.sx * ks, len, R.sz * ks), col[0] * vari, col[1] * vari, col[2] * vari, t.d * 0.4 * (p.u1 - p.u0), [0, 0, 0, 0], wob);
        if (t.d >= 5) logSolids(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, R.sx * ks, R.sz * ks, wob, whole ? trunkProfile : p.u0 === 0 ? buttProfile : () => 1);
        if (t.d >= 12) {
          const log = { x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, y0: p.y0 + rr * 0.8, y1: p.y1 + rr * 0.8, r: rr, cls };
          colLogs.push(log);
          const steps = Math.ceil(Math.hypot(p.x1 - p.x0, p.z1 - p.z0) / 8);
          for (let s2 = 0; s2 <= steps; s2++) { const f2 = s2 / steps; pushCol(logCells, p.x0 + (p.x1 - p.x0) * f2, p.z0 + (p.z1 - p.z0) * f2, log); }
        }
      }
      if (t.up && t.t < 70) {
        const pr = 0.7 + t.d * 0.028, pf = 1 - t.t / 70, cyP = ground(t.x, t.z) + pr * 0.55 * pf + 0.1, th = 0.35 + 0.25 * pf;
        b.plate.add(along(t.x - dirx * 0.15, cyP, t.z - dirz * 0.15, dirx, 0, dirz, pr * (0.7 + 0.3 * pf), th, pr * (0.5 + 0.5 * pf)), 0.62 * vari, 0.52 * vari, 0.42 * vari);
        // the wad is a near-vertical soil wall: ellipsoid thin along the fall direction
        addSolid(ellipsoid(t.x - dirx * 0.15, cyP, t.z - dirz * 0.15, pr * (0.7 + 0.3 * pf), pr * (0.5 + 0.5 * pf), th * 0.5, -dirz, dirx), pr);
      }
    }
  }
  for (let ti = 0; ti < B.length; ti++) {
    const g = new THREE.Group(), b = B[ti];
    { const m = b.plate.build(geos.plate, mats.soil); if (m) g.add(m); }
    g.userData.hi = []; g.userData.lo = [];
    b.rk.forEach((rb, i) => { const hi = rb.build(rocks.big[i], rockMat); if (!hi) return; const lo = lodTwin(hi, rocks.bigLo[i], true); g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); });
    {
      for (const [batch, hiG, loG] of [[b.trunk, geos.trunk, geos.trunkLo], [b.piece, geos.piece, geos.pieceLo], [b.butt, geos.butt, geos.buttLo]]) {
        const hi = batch.build(hiG, mats.bark, { farMin: 9, form: true });
        if (hi) { const lo = lodTwin(hi, loG, true); g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); }
      }
    }
    // crowns get a full and a reduced geometry sharing one instance buffer; the loop picks one by distance
    for (const [batch, hiG, loG, mat] of [[b.broad, geos.broad, geos.broadLo, mats.leaf], [b.cone, geos.cone, geos.coneLo, mats.needle], [b.pine, geos.broad, geos.broadLo, mats.needle]]) {
      const hi = batch.build(hiG, mat, { farMin: 4 }); if (!hi) continue;
      const lo = lodTwin(hi, loG, false);
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
      tleaf: new NearBatch(geos.tleaf, mats.shrub, 3000), tstem: new NearBatch(geos.tstem, mats.wood, 3000, { cast: true }),
      seedB: new NearBatch(geos.broadLo, mats.leaf, 4000), seedC: new NearBatch(geos.coneLo, mats.needle, 4000),
      twig: new NearBatch(geos.twig, mats.wood, 5000), stick: new NearBatch(geos.stick, mats.wood, 4000, { cast: true }), limb: new NearBatch(geos.limb, mats.wood, 2000, { cast: true }),
      ...Object.fromEntries(rocks.small.map((gm, i) => [`rockS${i}`, new NearBatch(gm, rockMat, 2000, { cast: true })])),
      ...Object.fromEntries(rocks.big.map((gm, i) => [`rockB${i}`, new NearBatch(gm, rockMat, 300, { cast: true })])),
      roundS: new NearBatch(rocks.roundS, rockMat, 3000, { cast: true }), roundB: new NearBatch(rocks.roundB, rockMat, 500, { cast: true }),
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
  if (!force && Math.hypot(px - near.cx, pz - near.cz) < 6) return;
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
          const dx = Math.cos(yaw) * a, dz = Math.sin(yaw) * a, dy = ground(x + dx, z + dz) - gy;
          const col = c ? [0.50, 0.40, 0.32] : [0.52 + 0.1 * v, 0.47 + 0.08 * v, 0.40];
          const rr = type === 'twig' ? 0.012 : type === 'stick' ? 0.022 : 0.032;
          nb.add(along(x, gy + rr * a * 0.8, z, dx, dy, dz, a, a, a), ...col); break;
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
    put(box, stone, M); addSolid(meshSolid(box, M, b.x, b.z), 0);
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
// Walk a station straight ahead for `secs` simulated seconds and score it against its intended outcome.
function gymRun(i, secs = 16) {
  goStation(i); const s = W.gym.stations[gymAt], e = s.expect || {}; body.lastVault = null; let vaults = 0, wasV = false, rollMax = 0, cam = 9;
  const [ox, oz] = stationOrigin(gymAt), pieces = W.trees.filter((t) => t.st === 2 && Math.abs(t.x - ox) < 7 && Math.abs(t.z - oz) < 9).flatMap((t) => t.rest.pieces);
  const toStem = (p) => Math.min(9, ...pieces.map((q) => { // camera to stem surface
    const vx = q.x1 - q.x0, vy = q.y1 - q.y0, vz = q.z1 - q.z0, t = clamp(((p.x - q.x0) * vx + (p.y - q.y0) * vy + (p.z - q.z0) * vz) / (vx * vx + vy * vy + vz * vz), 0, 1);
    return Math.hypot(p.x - q.x0 - vx * t, p.y - q.y0 - vy * t, p.z - q.z0 - vz * t) - q.r;
  }));
  const g0 = ground(player.x, player.z);
  let maxF = -9, maxH = 0, hands = false, lifts = 0, worst = 9, worstAt = '', lifting = false, eyeJump = 0, lastEye = null;
  for (let k = 0; k < secs * 60; k++) {
    input.keys.clear(); input.keys.add('KeyW'); movePlayer(1 / 60); refreshNear(player.x, player.z);
    const f = gymProgress(); maxF = Math.max(maxF, f); maxH = Math.max(maxH, rig.feet - g0);
    if (body.four) hands = true; if (rig.lift && !lifting) lifts++; lifting = !!rig.lift; if (rig.vault && !wasV) vaults++; wasV = !!rig.vault; if (Math.abs(body.roll) > Math.abs(rollMax)) rollMax = body.roll;
    cam = Math.min(cam, toStem(body.eye));
    if (f >= 5) break; // past the goal: stop before reaching the next row of stations
    if (lastEye !== null) eyeJump = Math.max(eyeJump, Math.abs(player.eye - lastEye)); lastEye = player.eye;
    const J = !rig.vault && body.sol?.J; if (J) for (const nm of ['head', 'neck', 'chest']) { const j = J[nm], c = ceilingAt(j[0], j[2], rig.feet, [0, -1]), gap = c - (j[1] + (nm === 'head' ? 0.11 : 0.06)); if (gap < worst) { worst = gap; worstAt = nm; } }
  }
  input.keys.clear();
  const checks = [];
  if (e.cross) checks.push(['cross', maxF >= 4]);
  if (e.stop) checks.push(['stop', maxF < 1]);
  if (e.height !== undefined) checks.push([`height ≥ ${e.height}`, maxH >= e.height]);
  if (s.maxHeight !== undefined) checks.push([`height ≤ ${s.maxHeight}`, maxH <= s.maxHeight]);
  if (e.clean) checks.push(['clean', worst >= -0.02 && cam >= 0.12]); // no body in a stem; the camera (near plane 0.1 m) keeps clear
  if (e.hands !== undefined) checks.push([e.hands ? 'on hands' : 'on feet', hands === e.hands]);
  if (e.lean) checks.push([`lean ${e.lean}`, e.lean === 'right' ? rollMax > 0.15 : rollMax < -0.15]);
  if (e.vault) checks.push([typeof e.vault === 'string' ? `vault ${e.vault}` : 'vault', vaults > 0 && (typeof e.vault !== 'string' || (body.lastVault?.side < 0 ? 'left' : 'right') === e.vault)]);
  return { i: gymAt + 1, name: s.name, pass: checks.every((c) => c[1]), checks: checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' '),
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
function addSolid(o, r) {
  if (o.kind === 'mesh') { // every 8 m cell the world box touches
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
  const [type, x, z, yaw, a] = it, r = BRANCH_R[type] * a; if (r < 0.012) return null;
  const gy = ground(x, z), dx = Math.cos(yaw) * a, dz = Math.sin(yaw) * a, gy1 = ground(x + dx, z + dz);
  return { kind: 'log', x0: x, z0: z, x1: x + dx * 0.85, z1: z + dz * 0.85, ya0: gy + r * 0.8, ya1: gy1 + r * 0.3, r };
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
const DUCK_MIN = 1.1; // lowest head-top height (above the feet) a stooped, knee-bent walk reaches; below it, hands and knees
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
    if (o.kind !== 'log' || o.r0 === undefined) continue;
    if (along) { const vx = o.x1 - o.x0, vz = o.z1 - o.z0, l = Math.hypot(vx, vz) || 1; if (Math.abs(vx * along[0] + vz * along[1]) / l > 0.85 && Math.abs(o.ya1 - o.ya0) / l > 0.3) continue; }
    logUnder = -Infinity; if (topOf(o, x, z) === -Infinity) continue;
    if (logBottom > feet + CLEAR4 - 0.05 && logUnder < c) c = logUnder; // a stem lower than crawling height is something to go over
  }
  return c;
}
function footSupport(x, z) { // the highest footing under a foot-sized ring (and what it is: footKind)
  let y = supportAt(x, z), kind = supKind;
  for (let k = 0; k < 6; k++) { const a = (k / 6) * 6.283, t = supportAt(x + Math.cos(a) * FOOT, z + Math.sin(a) * FOOT); if (t > y) { y = t; kind = supKind; } }
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
const rig = { feet: 0, vy: 0, lift: null, vault: null }; // lift: pulling up onto a ledge; vault: going over a hurdle
body.veer = 1;
function spring(x, v, target, k, dt, zeta = 1.1) {
  const c = 2 * zeta * Math.sqrt(k), n = Math.ceil(dt / 0.008), h = dt / n;
  for (let i = 0; i < n; i++) { v += (-k * (x - target) - c * v) * h; x += v * h; }
  return [x, v];
}
function resetRig(feetY) { // stand at the player's x, z: on the ground (not a stem hung overhead), or at a given support height
  supportRef = feetY ?? ground(player.x, player.z);
  rig.feet = feetY ?? footSupport(player.x, player.z); rig.vy = 0; rig.lift = null; rig.vault = null; body.want = null;
  Object.assign(body, { need: 0, needT: 0, four: false, mix: 0, yaw: player.yaw, head: 2, q: newQuad() }); body.q.n = [0, 1, 0];
  for (const h of body.hands) { h.hold = null; h.sw = null; }
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  for (const f of body.feet) {
    f.x = player.x + rx * f.side * RIG.hipW; f.z = player.z + rz * f.side * RIG.hipW; f.y = supportAt(f.x, f.z);
    Object.assign(f, { sx: f.x, sz: f.z, sy: f.y, tx: f.x, tz: f.z, ty: f.y, t: 1, dur: 0.3, lift: 0, ln: null });
  }
  body.pelvis.set(player.x, rig.feet + RIG.leg - 0.03, player.z); body.pvy = 0;
  body.base = body.pelvis.y; Object.assign(body, { vbase: 0, lean: 0, vlean: 0, crouch: 0, vcrouch: 0, lat: 0, vlat: 0, react: 0, vreact: 0, roll: 0, vroll: 0, plants: [], airborne: false, duck: 0, duckLean: 0, duckHold: null });
  body.stems.clear();
  for (const h of body.hands) { h.p.set(player.x, rig.feet + 0.9, player.z); h.v.set(0, 0, 0); h.target = null; }
  player.eye = rig.feet + 1.65;
  body.eye = { x: player.x, y: player.eye, z: player.z };
}

// ---- woody stems: anything rooted taller than a leg is something your feet walk around, not through
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
const CLEAR4 = 0.55; // lowest headroom (above the feet) crawling, hips and head low
const GAIT4 = { stride: 0.5, swing: 0.13, speed: 1.0, climb: 1.5, homes: [0.72, 0.72, -0.3, -0.3] }; // limbs LH RH LF RF
const LIMB = [{ hand: true, side: -1 }, { hand: true, side: 1 }, { hand: false, side: -1 }, { hand: false, side: 1 }];
function assess(x, z, px, pz) {
  const sup = footSupport(x, z), kind = footKind, rise = sup - rig.feet;
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
  const speed = lerp((run ? 4.2 : 1.6) * (1 - 0.55 * body.duck), GAIT4.speed * (run ? 1.4 : 1), body.need); // a stooped duck-walk is slow; on hands slower
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const px = player.x, pz = player.z;
  if (!rig.lift && !rig.vault && rig.vy === 0) { const here = footSupport(px, pz); if (here - rig.feet > STEP) rig.feet = here; } // embedded (e.g. a rock streamed in around you): climb out
  let needT = body.needT;
  if (rig.vault) { // over a hurdle: the body follows an arc through the crossing point, low over the top
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
    let vault = null;
    overPlan = null;
    if (step > 0 && rig.vy === 0) { // something low and thin ahead, or overhead within reach: over it, or under?
      const ux = dx / step, uz = dz / step, U = [ux, uz];
      const blocked = footSupport(px + ux * 0.3, pz + uz * 0.3) - rig.feet > STEP;
      let over = null;
      if (blocked) over = hurdleAhead(px, pz, ux, uz);
      else {
        let c = Infinity; for (let d = 0.3; d <= 1.6; d += 0.1) c = Math.min(c, ceilingAt(px + ux * d, pz + uz * d, rig.feet, U));
        if (c < rig.feet + 1.9) { // you would have to duck or crawl: going over is the other way, and the gaze picks
          over = hurdleAhead(px, pz, ux, uz, 1.6);
          if (over && player.pitch < -0.3 && underOK(px, pz, ux, uz)) over = null;
        }
      }
      if (over && over.d0 <= 0.75) { vault = over; startVault(px, pz, over); needT = 0; }
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
      for (const [mx, mz, sd] of body.four ? [[dx, dz, 0]] : [[dx, dz, 0], ...veer, [dx, 0, 0], [0, dz, 0]]) { // on hands, you go where the holds lead or not at all
        if (!mx && !mz) continue;
        if (sd) body.veer = sd;
        const [nx, nz] = stemPushOut(lim(px + mx), lim(pz + mz));
        const st = assess(nx, nz, px, pz);
        if (st === null) continue;
        if (!quadAllows(nx, nz, px, pz)) { if (!st.need) needT = 0; continue; } // held back by the limbs where hands aren't needed: stand up
        needT = st.need;
        if (st.rise > STEP) rig.lift = { x: nx, z: nz, y: st.sup }; else { player.x = nx; player.z = nz; }
        ok = true; break;
      }
    } else if (!vault) needT = needHere();
    if (!rig.lift && !rig.vault) {
      const sup = footSupport(player.x, player.z);
      if (sup >= rig.feet) { rig.feet = sup; rig.vy = 0; body.airborne = false; }
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
function placeContact(i, s) {
  const q = body.q, L = LIMB[i], Q = V.add(q.S0, q.a, s);
  const st = stemAt(Q[0], Q[2], Q[1] - 0.15, 0.5);
  if (st && st.rx >= 0.05) {
    const phi = L.hand ? 1.05 : 0.8, d = L.side * st.rx * Math.sin(phi); let R = stemFrame(st).R; if (V.dot(R, q.R) < 0) R = R.map((v) => -v);
    return { p: [st.cx + R[0] * d, st.cy + st.rz * Math.cos(phi), st.cz + R[2] * d], grip: true };
  }
  for (const w of [L.hand ? 0.17 : 0.12, 0.04]) {
    const x = Q[0] + q.R[0] * L.side * w, z = Q[2] + q.R[2] * L.side * w; supportRef = rig.feet; const y = supportAt(x, z), dy = y - Q[1];
    if (dy > (L.hand ? -0.6 : -0.9) && dy < (L.hand ? 1.2 : 0.6) && !trunkHit(x, z)) return { p: [x, y, z], grip: false };
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
  const hipH = Math.min(lerp(0.5, 0.22, steepK), Math.max(0.2, body.head - 0.36));
  const pel = V.add(V.add(V.add(q.S0, q.n, hipH), q.R, q.sway), q.a, -0.05);
  const U = V.nrm(V.add(q.a, q.n, 0.15 * low)), out = (side, k) => V.nrm(V.add(q.R.map((v) => v * side), q.a, k));
  return {
    pelvis: pel, frame: SK.frameFrom(U, q.n.map((v) => -v)), bend: [0.12 * low, 0, 0], neckPitch: (-0.5 - 0.3 * steepK) * low,
    feet: body.feet.map((ft) => V.add([ft.x, ft.y, ft.z], q.n, 0.07)), toes: [out(-0.4, 1), out(0.4, 1)],
    hands: body.hands.map((h) => V.add([h.p.x, h.p.y, h.p.z], q.n, 0.04)),
    kneePole: [V.add(out(-1, 0.6), q.n, 0.15), V.add(out(1, 0.6), q.n, 0.15)],
    elbowPole: [V.add(out(-1, -0.5), q.n, 0.4), V.add(out(1, -0.5), q.n, 0.4)],
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
// A foot lands at the aimed spot unless that is far below or above where you stand (off the side of a narrow stem or
// ledge): then it comes in toward your centreline, which the controller has already found standable.
function foothold(tx, tz) {
  const s0 = supportAt(tx, tz);
  if (Math.abs(s0 - rig.feet) < 0.45) return [tx, tz, s0];
  const c = [];
  for (const r of [0.12, 0.25]) for (let k = 0; k < 8; k++) { const a = k * 0.785; c.push([tx + Math.cos(a) * r, tz + Math.sin(a) * r]); }
  for (const k of [0.3, 0.55, 0.8, 1]) c.push([lerp(tx, player.x, k), lerp(tz, player.z, k)]);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * 6.283; c.push([player.x + Math.cos(a) * FOOT, player.z + Math.sin(a) * FOOT]); }
  let best = null, bd = Infinity, fb = [tx, tz, s0], fe = Math.abs(s0 - rig.feet);
  for (const [x, z] of c) {
    const s = supportAt(x, z), e = Math.abs(s - rig.feet), d = Math.hypot(x - tx, z - tz);
    if (e < 0.45 && d < bd) { bd = d; best = [x, z, s]; }
    if (e < fe) { fe = e; fb = [x, z, s]; }
  }
  return best || fb;
}
function startSwing(ft, tx0, tz0, dur) {
  const [tx, tz, ty] = foothold(tx0, tz0);
  Object.assign(ft, { sx: ft.x, sz: ft.z, sy: ft.y, tx, tz, ty, t: 0, dur, ln: null });
  let top = Math.max(ft.sy, ft.ty); // lift enough to clear what lies between the old and new footholds
  for (const q of [0.2, 0.35, 0.5, 0.65, 0.8]) top = Math.max(top, supportAt(lerp(ft.sx, tx, q), lerp(ft.sz, tz, q)));
  ft.lift = RIG.lift + (top - Math.max(ft.sy, ft.ty));
  ft.rise = ft.ty - ft.sy;
}
// Head height for ducking. Head top above the feet = pelvis + crouch + (spine + neck)·cos(lean) + 0.17 (head above the
// neck joint). Given the lowest stem underside over where the head is and is about to be, the deficit is shared: the
// knees take about half (pelvis down to ~0.45 m lower), the back stoops for the rest (up to 1 rad), then the knees again.
// Below DUCK_MIN this can't fit, and the hands come down (the controller's `need`).
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
  let best = lowest(0), lat = 0;
  if (best.c < Infinity) for (const l of [-0.3, -0.15, 0.15, 0.3]) { const o = lowest(l); if (o.c - 0.1 * Math.abs(l) > best.c - 0.1 * Math.abs(lat) + 0.02) { best = o; lat = l; } }
  const { c, cx, cz } = best;
  if (c === Infinity) return null;
  const sl = RIG.spine + RIG.neck, head0 = Math.max(body.base - feet, RIG.leg - 0.03) + sl + 0.17, D = head0 - (c - feet - 0.18);
  if (D <= 0) return null;
  let crouch = -Math.min(0.38, D * 0.55);
  const D2 = D + crouch, lean = Math.acos(clamp(1 - D2 / sl, Math.cos(1.0), 1));
  const D3 = D2 - sl * (1 - Math.cos(lean)); if (D3 > 0) crouch = Math.max(-0.45, crouch - D3);
  const side = (cx - player.x) * Math.cos(player.yaw) - (cz - player.z) * Math.sin(player.yaw) >= 0 ? 1 : -1;
  // lat is right of travel; the roll is about the facing direction (they agree walking forward)
  const latR = lat * ((-uz) * Math.cos(player.yaw) + ux * -Math.sin(player.yaw) >= 0 ? 1 : -1);
  return { lean, crouch, amt: clamp(D / 0.6, 0, 1), x: cx, y: c, z: cz, side, roll: clamp(Math.asin(clamp(latR / sl, -0.5, 0.5)), -0.45, 0.45) };
}
function updateBody(dt, moved, run, dx, dz, fwdInput) {
  const M = MOTION[settings.motion] ?? 1;
  const vx = dx / Math.max(dt, 1e-4), vz = dz / Math.max(dt, 1e-4), spd = Math.hypot(vx, vz);
  const accel = (spd - body.speed) / Math.max(dt, 1e-4); body.speed = lerp(body.speed, spd, 0.3);
  if (spd > 0.05) body.fwd = [vx / spd, vz / spd];
  const [ux, uz] = moved > 0 ? [dx / moved, dz / moved] : [-Math.sin(player.yaw), -Math.cos(player.yaw)];
  const rx = -uz, rz = ux; // right of travel
  const uphill = moved > 0 ? (sampleGrid(W.H, N, player.x + ux, player.z + uz) - sampleGrid(W.H, N, player.x - ux, player.z - uz)) / 2 : 0;
  const steep = smoothstep(0.1, 0.8, uphill);
  const m = rig.lift || rig.vault, four = body.four, vlt = rig.vault;
  surfaceFrame(dt, ux, uz, moved > 0);

  // feet. Walking: a gait cycle driven by distance travelled. One cycle = two steps. Each foot swings for a fraction
  // `duty` of the cycle (walk 0.4: always one foot down; run 0.62: brief flight). A swing aims the foot so its stance
  // is centred under the hip: it lands (1 - duty) * stepLen ahead of the hip. On hands: quadStep.
  const runK = clamp((spd - 1.6) / 2.6, 0, 1);
  const stepLen = lerp(RIG.stepWalk, RIG.stepRun, runK) * (1 - 0.5 * steep) * (1 - 0.4 * body.duck), duty = lerp(0.4, 0.62, runK);
  const ideal = (ft) => [player.x + rx * ft.side * RIG.hipW, player.z + rz * ft.side * RIG.hipW];
  const landAhead = (1 - duty) * stepLen;
  const aim = (ft, tLeft) => { const [ix, iz] = ideal(ft), a = landAhead * 0.8 + spd * tLeft; return [ix + ux * a, iz + uz * a]; };
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
  }
  for (const ft of body.feet) if (ft.t < 1) {
    if (!four && !ft.ln && ft.t < 0.7 && spd > 0.05) [ft.tx, ft.tz, ft.ty] = foothold(...aim(ft, ft.dur * (1 - ft.t)));
    ft.t = Math.min(1, ft.t + dt / ft.dur);
    const e = ft.t * ft.t * (3 - 2 * ft.t), l = Math.sin(Math.PI * ft.t) * ft.lift, n = ft.ln || [0, 1, 0];
    ft.x = lerp(ft.sx, ft.tx, e) + n[0] * l; ft.z = lerp(ft.sz, ft.tz, e) + n[2] * l; ft.y = lerp(ft.sy, ft.ty, e) + n[1] * l;
    if (ft.t >= 1) { ft.x = ft.tx; ft.y = ft.ty; ft.z = ft.tz; if (ft.ln) body.q.stats.steps++; if (!four && ft.ty < ft.sy - 0.15) body.vcrouch -= (ft.sy - ft.ty) * 0.6; } // big step down: knees take it
  }

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
  body.duckHold = dk && dk.amt > 0.25 ? dk : null;
  [body.crouch, body.vcrouch] = spring(body.crouch, body.vcrouch, dk ? dk.crouch : 0, RIG.kCrouch, dt);
  [body.pelvis.y, body.pvy] = spring(body.pelvis.y, body.pvy, pTarget, RIG.kPelvis, dt);
  // the slowly varying part of pelvis height (terrain) vs the rhythmic part (gait), split by a low-pass "baseline"
  const baseT = stance.length && !m && !body.airborne ? stance.reduce((a, ft) => a + ft.y, 0) / stance.length + RIG.leg - 0.03 : pTarget;
  [body.base, body.vbase] = spring(body.base, body.vbase, baseT, RIG.kBase, dt);
  const sf = stance.length === 1 ? stance[0].side : 0; // weight shifts over the stance foot
  [body.lat, body.vlat] = spring(body.lat, body.vlat, sf * 0.03, RIG.kLat, dt);

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
  const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw), cRx = Math.cos(player.yaw), cRz = -Math.sin(player.yaw);
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
    if (vlt && vlt.t < 0.75) { // both hands on the top: the lead hand at the crossing, the other further back across it
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
  [body.react, body.vreact] = spring(body.react, body.vreact, clamp(react * RIG.pushReact, -0.12, 0.12), RIG.kLat, dt); // pushing: the head gives, then recovers

  // eye. Walking: rhythmic gait passes through at gaitPass; terrain and posture pass fully. On hands: in the head, the
  // face turned along the surface. Mixed as the hands are needed.
  const gait = (body.pelvis.y - body.base) * RIG.gaitPass;
  const pelvisEye = body.base + gait + body.crouch;
  const latEye = body.lat * RIG.gaitPass + body.react;
  const sl = RIG.spine + RIG.neck, lean = body.lean * M;
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
  const sol = SK.solvePose(bodyPose()); body.sol = sol;
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
      for (const sp of a) if (sp.base < 1.8) consider(sp, sp.x, sp.z, sp.R, sp.h, Math.min(1.3, Math.max(sp.base + 0.2, sp.h * 0.5)));
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
  const yaw = body.yaw ?? player.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rX = Math.cos(yaw), rZ = -Math.sin(yaw);
  return {
    pelvis: [player.x + rX * body.lat, body.pelvis.y + body.crouch, player.z + rZ * body.lat],
    frame: { R: [rX, 0, rZ], U: [0, 1, 0], F: [fx, 0, fz] }, bend: [body.lean, body.roll, 0], neckPitch: -body.lean * 0.5,
    feet: body.feet.map((ft) => [ft.x, ft.y + 0.06, ft.z]), toes: [[fx, 0, fz], [fx, 0, fz]],
    hands: body.hands.map((h) => [h.p.x, h.p.y, h.p.z]),
    kneePole: [[fx, 0, fz], [fx, 0, fz]],
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
}

// ---------------------------------------------------------------- input
const keyTarget = (e) => e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
addEventListener('keydown', (e) => { if (keyTarget(e)) return; input.keys.add(e.code); if (e.code === 'KeyM') toggle('pMap'); if (e.code === 'KeyC') captureSpot(); if (W?.gym && e.code === 'BracketRight') goStation(gymAt + 1); if (W?.gym && e.code === 'BracketLeft') goStation(gymAt - 1); if (W?.gym && e.code === 'KeyR') goStation(gymAt); if (e.code === 'KeyV') { settings.view = settings.view === 'third' ? 'first' : 'third'; fView.value = settings.view; } });
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
  $('standSub').textContent = `${W.age} years after a stand-replacing fire, ${W.geology.name.toLowerCase()} bedrock, ${W.opt.moisture} climate, ${W.stats.storms} windstorm${W.stats.storms === 1 ? '' : 's'}. Basal area: ${comp}.`;
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
const fSeed = $('fSeed'), fAge = $('fAge'), fMoist = $('fMoist'), fStorm = $('fStorm'), fQual = $('fQual'), fGeo = $('fGeo'), fMotion = $('fMotion'), fView = $('fView'), fBody = $('fBody');
const fPlace = $('fPlace');
function syncForm() { fPlace.value = settings.place || 'forest'; fSeed.value = settings.seed; fAge.value = String(settings.age); fMoist.value = settings.moisture; fStorm.value = settings.storms; fQual.value = settings.quality; fGeo.value = settings.geology; fMotion.value = settings.motion || 'full'; }
fMotion.addEventListener('change', () => { settings.motion = fMotion.value; saveSettings(); });
fView.value = settings.view || 'first'; fBody.value = settings.body || 'hidden';
fView.addEventListener('change', () => { settings.view = fView.value; saveSettings(); });
fBody.addEventListener('change', () => { settings.body = fBody.value; saveSettings(); });
syncForm();
$('bDice').addEventListener('click', () => { fSeed.value = 1 + Math.floor(Math.random() * 99999); });
$('bRegen').addEventListener('click', () => {
  const q = fQual.value !== settings.quality;
  Object.assign(settings, { place: fPlace.value, seed: clamp(parseInt(fSeed.value, 10) || 1, 1, 999999), age: +fAge.value, moisture: fMoist.value, storms: fStorm.value, geology: fGeo.value, quality: fQual.value });
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
  applyCamera();
  sky.position.copy(camera.position);
  // shadow camera follows the player, snapped to texels to avoid shimmering
  const texel = 96 / sun.shadow.mapSize.x, sx = Math.round(player.x / texel) * texel, sz = Math.round(player.z / texel) * texel;
  sun.target.position.set(sx, player.eye - 1.6, sz); sun.position.copy(sun.target.position).addScaledVector(sunDir, 150);
  renderer.shadowMap.needsUpdate = frameNo % 2 === 0;
  updateTiles();
  terrainU.uCenter.value.set(Math.round(player.x / 8) * 8, Math.round(player.z / 8) * 8);
  renderer.render(scene, camera);
  frameNo++; frames++; fpsT += dt;
  if (fpsT > 0.5) {
    $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0;
    const f = fieldAt(player.x, player.z);
    if (W.gym) $('hudHere').textContent = gymStatus(); else $('hudHere').textContent = `elev ${ground(player.x, player.z).toFixed(0)} m · slope ${Math.round(Math.atan(f.sl) * 57.3)}° · sky ${Math.round(f.L * 100)}% · wet ${f.wet.toFixed(2)}`;
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
    if (settings.place === 'gym') W = buildGymWorld(loadCaptures());
    else W = await generateWorld({ seed: settings.seed, age: settings.age, moisture: settings.moisture, storms: settings.storms, geology: settings.geology }, async (msg, p) => {
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
  get world() { return W; }, get supportRef() { return supportRef; }, mats, player, settings, ground: (x, z) => ground(x, z), resetRig, input, RIG, body, applyCam: () => applyCamera(), nearCells: () => near.cells, step(dt) { movePlayer(dt); refreshNear(player.x, player.z); },
  gym: { get at() { return gymAt; }, go: (i) => goStation(i), run: (i, secs) => gymRun(i, secs), capture: () => captureSpot(), stationOrigin },
  loco: { stemAt, stemUnder, assess, grade, holdsNear, placeContact, stability, quadAllows, limbAt, GAIT4, TRACTION, get need() { return body.need; }, get q() { return body.q; } }, col: { topOf, supportAt, ceilingAt, duckPosture, saplings: () => saplingCells, steerAround, stemPushOut, stemObstacles, footSupport, supportGrad, slopeAt, trunkHit, solids: () => solids }, rig,
  pause() { running = false; },
  info() { return { near: Object.fromEntries(Object.entries(near.b).map(([k, v]) => [k, v.n])), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries }; },
  view(x, y, z, tx, ty, tz) { // free camera for inspection: player stands at the target so near detail loads there
    player.x = tx; player.z = tz; this.renderOnce(); camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); sky.position.copy(camera.position); renderer.shadowMap.needsUpdate = true; renderer.render(scene, camera);
  },
  renderOnce() { refreshNear(player.x, player.z, true); applyCamera(); sky.position.copy(camera.position); renderer.shadowMap.needsUpdate = true; uTime.value = 0; updateTiles(); terrainU.uCenter.value.set(Math.round(player.x / 8) * 8, Math.round(player.z / 8) * 8); renderer.render(scene, camera); },
};

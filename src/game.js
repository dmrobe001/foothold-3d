// Foothold renderer, controls and UI. World data comes from ./worldgen.js.
import * as THREE from 'three';
import { generateWorld, sampleGrid, SPECIES, GEOLOGY, crownRadius, crownFraction, WORLD, N, NF, CELL, HALF, hash3, mulberry32, makeNoise2D, clamp, smoothstep } from './worldgen.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------------------------------------------------------------- settings
const settings = { seed: 1, age: 160, moisture: 'mesic', storms: 'occasional', geology: 'granite', quality: isTouch ? 'low' : 'high', motion: 'full' };
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

mats.bark.onBeforeCompile = bendPatch;
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
  trunk: trunkGeo(), plate: rootPlateGeo(),
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
  const B = Array.from({ length: NT * NT }, () => ({ trunk: new Batch(), broad: new Batch(), cone: new Batch(), pine: new Batch(), plate: new Batch(), rk: [new Batch(), new Batch(), new Batch(), new Batch()] }));
  const tileOf = (x, z) => clamp(Math.floor((z + HALF) / TILE), 0, NT - 1) * NT + clamp(Math.floor((x + HALF) / TILE), 0, NT - 1);
  colTrunks = new Map(); colLogs = []; logCells = new Map(); solids = new Map();
  const ckey = (ci, cj) => ci * 4096 + cj;
  const pushCol = (map, x, z, item, cs = 8) => { const k = ckey(Math.floor((x + HALF) / cs), Math.floor((z + HALF) / cs)); let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(item); };
  for (const t of W.trees) {
    const r = mulberry32(hash3(Math.round(t.x * 10), Math.round(t.z * 10), 77)), b = B[tileOf(t.x, t.z)], P = SPECIES[t.sp];
    const gy = ground(t.x, t.z), kind = P.kind, yaw = r() * Math.PI * 2, rad = t.d / 100;
    const vari = 0.88 + 0.24 * r();
    const f = t.form || { lx: 0, lz: 0, sx: 0, sz: 0, A: 0, k: 1, ph: 0 };
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw);
    const toL = (wx, wz) => [wx * cy0 - wz * sy0, wx * sy0 + wz * cy0];
    const toW = (lx, lz) => [lx * cy0 + lz * sy0, -lx * sy0 + lz * cy0];
    f.bl = [...toL(f.lx, f.lz), ...toL(f.sx, f.sz)];
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
    } else if (t.st === 1) {
      const grey = mix3(TINT.bark[t.sp], [0.62, 0.60, 0.56], clamp(t.t / 20, 0, 0.8));
      b.trunk.add(trs(t.x, gy - 0.15, t.z, yaw, rad, t.sh, rad), grey[0] * vari, grey[1] * vari, grey[2] * vari, t.d * 0.7, [0, 0, f.bl[2], f.bl[3]], wobAttr);
      if (t.d >= 8) pushCol(colTrunks, t.x, t.z, { x: t.x, z: t.z, r: t.d / 200 + 0.25 });
    } else if (t.st === 2) {
      const T = (15 + 1.3 * t.d) * P.decay, fd = clamp(t.t / T, 0, 1), cls = 1 + Math.floor(fd * 4.999);
      const dirx = Math.cos(t.ang), dirz = Math.sin(t.ang), len = Math.max(1, t.len * (1 - 0.3 * fd));
      const bx = t.x + dirx * (t.snapBase ? 0.3 : 0.2), bz = t.z + dirz * (t.snapBase ? 0.3 : 0.2);
      const tx = bx + dirx * len, tz = bz + dirz * len;
      const rr = (t.d / 200) * (1 - 0.15 * fd), sink = rr * (0.1 + 0.9 * fd);
      const raised = t.up && t.t < 25 ? rr * 2.2 * (1 - t.t / 25) : 0;
      const y0 = ground(bx, bz) + rr - sink + raised, y1 = ground(tx, tz) + rr * 0.6 - sink;
      const col = cls <= 2 ? mix3(TINT.bark[t.sp], [0.42, 0.34, 0.27], t.sp === 3 ? 0.3 : 0.6) : mix3([0.44, 0.36, 0.28], [0.34, 0.37, 0.21], (cls - 3) / 2);
      b.trunk.add(along(bx, y0, bz, tx - bx, y1 - y0, tz - bz, rad * (1 - 0.15 * fd), Math.hypot(tx - bx, y1 - y0, tz - bz), rad * (1 - 0.35 * fd)), col[0] * vari, col[1] * vari, col[2] * vari, t.d * 0.4, [0, 0, 0, 0], [f.A * (1 - 0.4 * fd), f.k, f.ph, 0.25]);
      if (t.up && t.t < 70) {
        const pr = 0.7 + t.d * 0.028, pf = 1 - t.t / 70, cyP = ground(t.x, t.z) + pr * 0.55 * pf + 0.1, th = 0.35 + 0.25 * pf;
        b.plate.add(along(t.x - dirx * 0.15, cyP, t.z - dirz * 0.15, dirx, 0, dirz, pr * (0.7 + 0.3 * pf), th, pr * (0.5 + 0.5 * pf)), 0.62 * vari, 0.52 * vari, 0.42 * vari);
        // the wad is a near-vertical soil wall: ellipsoid thin along the fall direction
        addSolid(ellipsoid(t.x - dirx * 0.15, cyP, t.z - dirz * 0.15, pr * (0.7 + 0.3 * pf), pr * (0.5 + 0.5 * pf), th * 0.5, -dirz, dirx), pr);
      }
      if (t.d >= 10) addSolid({ kind: 'log', x: (bx + tx) / 2, z: (bz + tz) / 2, x0: bx, z0: bz, x1: tx, z1: tz, ya0: y0, ya1: y1, r: rr }, len / 2 + rr);
      if (t.d >= 12) {
        const log = { x0: bx, z0: bz, x1: tx, z1: tz, y0: y0 + rr * 0.8, y1: y1 + rr * 0.8, r: rr, cls };
        colLogs.push(log);
        const steps = Math.ceil(len / 8);
        for (let s2 = 0; s2 <= steps; s2++) { const f2 = s2 / steps; pushCol(logCells, bx + (tx - bx) * f2, bz + (tz - bz) * f2, log); }
      }
    }
  }
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
      addSolid(meshSolid(rocks.big[vi], trs(x, gy - sink, z, yaw, sx, sy, sz, Math.atan2(hz, 2) * 0.8 * (tilt > 0 ? 1 : 0), -Math.atan2(hx, 2) * 0.8), x, z), s * 1.6);
    }
  }
  for (let ti = 0; ti < B.length; ti++) {
    const g = new THREE.Group(), b = B[ti];
    { const m = b.plate.build(geos.plate, mats.soil); if (m) g.add(m); }
    g.userData.hi = []; g.userData.lo = [];
    b.rk.forEach((rb, i) => { const hi = rb.build(rocks.big[i], rockMat); if (!hi) return; const lo = lodTwin(hi, rocks.bigLo[i], true); g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); });
    {
      const hi = b.trunk.build(geos.trunk, mats.bark, { farMin: 9, form: true });
      if (hi) { const lo = lodTwin(hi, geos.trunkLo, true); g.add(hi, lo); g.userData.hi.push(hi); g.userData.lo.push(lo); }
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
const ckey8 = (x, z) => Math.floor((x + HALF) / 8) * 4096 + Math.floor((z + HALF) / 8);
function addSolid(o, r) {
  const seen = new Set();
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
    const k = ckey8(o.x + ox, o.z + oz); if (seen.has(k)) continue; seen.add(k);
    let a = solids.get(k); if (!a) solids.set(k, (a = [])); a.push(o);
  }
}
function ellipsoid(x, y, z, ax, ay, az, ux, uz) { return { kind: 'ell', x, y, z, ax, ay, az, ux, uz }; }

// Top-surface heightfield of a mesh in its local frame: for each cell of a grid over the x/z footprint, the highest
// point of the surface above it. Built once per geometry by rasterising triangles.
const topFields = new Map();
function topField(geo, res = 48) {
  let tf = topFields.get(geo); if (tf) return tf;
  geo.computeBoundingBox();
  const bb = geo.boundingBox, p = geo.attributes.position, ix = geo.index ? geo.index.array : null;
  const x0 = bb.min.x, z0 = bb.min.z, dx = (bb.max.x - x0) / (res - 1), dz = (bb.max.z - z0) / (res - 1);
  const H = new Float32Array(res * res).fill(-Infinity), n = ix ? ix.length : p.count;
  for (let t = 0; t < n; t += 3) {
    const a = ix ? ix[t] : t, b = ix ? ix[t + 1] : t + 1, c = ix ? ix[t + 2] : t + 2;
    const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a), bx = p.getX(b), by = p.getY(b), bz = p.getZ(b), cx = p.getX(c), cy = p.getY(c), cz = p.getZ(c);
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(det) < 1e-9) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / dx)), i1 = Math.min(res - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / dx));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / dz)), j1 = Math.min(res - 1, Math.ceil((Math.max(az, bz, cz) - z0) / dz));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + i * dx, z = z0 + j * dz;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * ay + l2 * by + l3 * cy, k = j * res + i; if (y > H[k]) H[k] = y;
    }
  }
  tf = { res, x0, z0, dx, dz, H };
  topFields.set(geo, tf);
  return tf;
}
function sampleTop(tf, lx, lz) {
  const gx = (lx - tf.x0) / tf.dx, gz = (lz - tf.z0) / tf.dz;
  if (gx < 0 || gz < 0 || gx > tf.res - 1 || gz > tf.res - 1) return -Infinity;
  const i = Math.min(tf.res - 2, Math.floor(gx)), j = Math.min(tf.res - 2, Math.floor(gz)), fx = gx - i, fz = gz - j, H = tf.H, r = tf.res;
  const h00 = H[j * r + i], h10 = H[j * r + i + 1], h01 = H[(j + 1) * r + i], h11 = H[(j + 1) * r + i + 1];
  if (h00 > -1e9 && h10 > -1e9 && h01 > -1e9 && h11 > -1e9) return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
  // at the rim, hold the nearest real sample so edges don't crumble
  const near = [[h00, (1 - fx) * (1 - fz)], [h10, fx * (1 - fz)], [h01, (1 - fx) * fz], [h11, fx * fz]].filter(([h, w]) => h > -1e9 && w > 0.2);
  return near.length ? Math.max(...near.map(([h]) => h)) : -Infinity;
}
const _inv = new THREE.Matrix4(), _v3 = new THREE.Vector3();
function meshSolid(geo, matrix, x, z) {
  const m = matrix.clone();
  return { kind: 'mesh', x, z, tf: topField(geo), m, inv: m.clone().invert() };
}
function topOf(o, x, z) {
  if (o.kind === 'mesh') {
    _v3.set(x, o.m.elements[13], z).applyMatrix4(o.inv);
    const h = sampleTop(o.tf, _v3.x, _v3.z); if (h === -Infinity) return -Infinity;
    _v3.y = h; return _v3.applyMatrix4(o.m).y;
  }
  if (o.kind === 'ell') {
    const dx = x - o.x, dz = z - o.z, a = dx * o.ux + dz * o.uz, b = -dx * o.uz + dz * o.ux;
    const q = (a / o.ax) ** 2 + (b / o.az) ** 2;
    return q < 1 ? o.y + o.ay * Math.sqrt(1 - q) : -Infinity;
  }
  const vx = o.x1 - o.x0, vz = o.z1 - o.z0, L2 = vx * vx + vz * vz || 1;
  const t = clamp(((x - o.x0) * vx + (z - o.z0) * vz) / L2, 0, 1);
  const d = Math.hypot(x - (o.x0 + vx * t), z - (o.z0 + vz * t));
  return d < o.r ? lerp(o.ya0, o.ya1, t) + Math.sqrt(o.r * o.r - d * d) : -Infinity;
}
function nearRockSolid(it) { // near-field rock item -> mesh solid, using exactly the transform refreshNear draws with
  const [type, x, z, yaw, a, , , v] = it, nb = rockBatch(type, v), gy = ground(x, z);
  return meshSolid(nb.mesh.geometry, trs(x, gy - a * 0.25, z, yaw, a * (0.8 + 0.5 * v), a, a * (1.2 - 0.4 * v), (v - 0.5) * 0.3, 0), x, z);
}
function supportAt(x, z) {
  let y = ground(x, z);
  const list = solids.get(ckey8(x, z));
  if (list) for (const o of list) { const t = topOf(o, x, z); if (t > y) y = t; }
  const ci = Math.floor((x + HALF) / NC), cj = Math.floor((z + HALF) / NC);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { // big near-field rocks can overhang their cell
    const items = near?.cells.get((ci + di) * 4096 + cj + dj); if (!items) continue;
    for (const it of items) {
      if (it.solid === undefined) it.solid = /^(rock|round)/.test(it[0]) && it[4] >= 0.18 ? nearRockSolid(it) : null;
      if (!it.solid || ((di || dj) && it[4] < 0.8)) continue;
      const t = topOf(it.solid, x, z); if (t > y) y = t;
    }
  }
  return y;
}
function footSupport(x, z) {
  let y = supportAt(x, z);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * 6.283; y = Math.max(y, supportAt(x + Math.cos(a) * FOOT, z + Math.sin(a) * FOOT)); }
  return y;
}
const feetAt = (x, z) => footSupport(x, z);
const slopeAt = (x, z) => Math.hypot(sampleGrid(W.H, N, x + 1, z) - sampleGrid(W.H, N, x - 1, z), sampleGrid(W.H, N, x, z + 1) - sampleGrid(W.H, N, x, z - 1)) / 2;
const supportGrad = (x, z, e = 0.15) => Math.hypot(supportAt(x + e, z) - supportAt(x - e, z), supportAt(x, z + e) - supportAt(x, z - e)) / (2 * e);
function trunkHit(x, z) { for (const t of nearbyTrunks(x, z)) if (Math.hypot(t.x - x, t.z - z) < t.r) return true; return false; }
// `climb` is how much height has been gained on steep rock since the last flat-enough footing. Steep bumps are fine
// until they add up to more than a step, so you can cross uneven rock but can't creep up a tall smooth face.
function standable(x, z, feet, fromX, fromZ, climb = 0) {
  const sup = footSupport(x, z), rise = sup - feet;
  if (rise > STEP) return null;
  const g = ground(x, z);
  let steep = 0;
  if (rise > 0.005 && sup - g > 0.25 && supportGrad(x, z) > MAX_SLOPE) { steep = rise; if (climb + steep > STEP) return null; }
  if (sup <= g + 0.05 && slopeAt(x, z) > MAX_GROUND_SLOPE && g > ground(fromX, fromZ) + 1e-3) return null;
  if (trunkHit(x, z)) return null;
  return { sup, steep };
}
function scrambleTarget(px, pz, feet, ux, uz) { // a ledge within reach ahead that is flat enough to stand on
  for (const d of [0.35, 0.6, 0.85, 1.1]) {
    const x = px + ux * d, z = pz + uz * d, sup = footSupport(x, z);
    if (sup - feet <= STEP || sup - feet > SCRAMBLE) continue;
    if (supportGrad(x, z) > 1.3 || trunkHit(x, z)) continue; // scrambles may land on rougher, steeper tops than you could walk onto
    return { x, z, y: sup };
  }
  return null;
}
function blockedAt(x, z) { return trunkHit(x, z) || footSupport(x, z) - ground(x, z) > SCRAMBLE; }
function nearbyTrunks(x, z) {
  const ci = Math.floor((x + HALF) / 8), cj = Math.floor((z + HALF) / 8), out = [];
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = colTrunks.get((ci + di) * 4096 + cj + dj); if (a) out.push(...a); }
  return out;
}

// ---------------------------------------------------------------- body and camera rig
// The body moves smoothly and never slows for slopes or shrubs. Effort is shown by the camera instead, through damped
// springs: a dip-and-catch on step-ups, knee compression on landing, a pitch-and-roll "vault" when scrambling, a
// stride-locked side-to-side sway that grows with uphill steepness, and a sideways dodge around shrubs. Flat-ground walking
// has no bob. Motion strength: settings.motion = full | reduced | off.
const rig = { dodgeDir: 0, vSway: 0, lx: 0, lz: 0, climb: 0, feet: 0, vy: 0, oy: 0, voy: 0, lat: 0, vlat: 0, roll: 0, vroll: 0, pit: 0, vpit: 0, phase: 0, mantle: null, swayAmp: 0 };
const MOTION = { full: 1, reduced: 0.4, off: 0 };
// Tuning knobs. k values are spring stiffness (1/s²); damping ratio 1.1, settle time ≈ 5/√k seconds.
const RIG = {
  kLat: 220, kRoll: 200, kPitch: 150, kUp: 260, kDown: 420, // shrub dodge return / roll / scramble pitch / step catch-up / step-down
  dipStep: 5,                         // extra downward head velocity per metre of step-up
  swayFrom: 0.12, swayFull: 0.7,      // uphill gradient (rise/run) where stride sway starts and reaches full strength
  swayLat: 0.2, swayBob: 0.07,     // full-strength sway: metres sideways, metres of bob (no roll: translation only)
};
function resetRig() { Object.assign(rig, { lx: player.x, lz: player.z, feet: footSupport(player.x, player.z), vy: 0, oy: 0, voy: 0, lat: 0, vlat: 0, roll: 0, vroll: 0, pit: 0, vpit: 0, mantle: null, swayAmp: 0, vSway: 0, dodgeDir: 0 }); player.eye = rig.feet + 1.65; }
function spring(x, v, target, k, dt) { // slightly overdamped, sub-stepped for stability
  const c = 2.2 * Math.sqrt(k), n = Math.ceil(dt / 0.008), h = dt / n; // damping ratio 1.1: no overshoot
  for (let i = 0; i < n; i++) { v += (-k * (x - target) - c * v) * h; x += v * h; }
  return [x, v];
}
// Sideways nudge past shrubs. The dodge side is chosen once, when the first shrub comes within reach (away from the
// nearest stem), and held until every shrub is behind you, so walking through the middle of a bush or between two
// bushes never flips the target back and forth. Strength is the strongest single shrub, easing in quadratically.
function shrubPush(x, z, rx, rz) {
  let w = 0, nearest = Infinity, nearestSide = 0;
  const ci = Math.floor((x + HALF) / NC), cj = Math.floor((z + HALF) / NC);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const items = near?.cells.get((ci + di) * 4096 + cj + dj); if (!items) continue;
    for (const it of items) {
      const t = it[0]; if (t !== 'tall' && t !== 'shrub' && t !== 'seedB' && t !== 'seedC') continue;
      const r = t === 'tall' ? it[4] * 0.9 + 0.3 : it[4] * 0.8 + 0.2, d = Math.hypot(it[1] - x, it[2] - z);
      if (d >= r) continue;
      const u = 1 - d / r;
      w = Math.max(w, u * u * (t === 'tall' ? 0.5 : t === 'shrub' ? 0.26 : 0.14));
      if (d < nearest) { nearest = d; nearestSide = (x - it[1]) * rx + (z - it[2]) * rz; }
    }
  }
  if (w === 0) { rig.dodgeDir = 0; return 0; }
  if (!rig.dodgeDir) rig.dodgeDir = nearestSide >= 0 ? 1 : -1;
  return rig.dodgeDir * Math.min(w, 0.5);
}
function movePlayer(dt) {
  const M = MOTION[settings.motion] ?? 1;
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
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw), rx = cy, rz = -sy; // camera right vector
  let moved = 0, uphill = 0;

  if (rig.mantle) { // scripted scramble: up first, then over the lip
    const m = rig.mantle; m.t += dt / m.dur;
    const u = Math.min(1, m.t), up = 1 - (1 - Math.min(1, u * 1.6)) ** 2, over = u < 0.35 ? 0 : (u - 0.35) / 0.65;
    player.x = lerp(m.x0, m.x1, over * over * (3 - 2 * over)); player.z = lerp(m.z0, m.z1, over * over * (3 - 2 * over));
    rig.feet = lerp(m.y0, m.y1, up);
    if (u >= 1) rig.mantle = null;
  } else {
    let dx = (-sy * f + cy * s) * speed * dt, dz = (-cy * f - sy * s) * speed * dt;
    const step = Math.hypot(dx, dz);
    if (step > 0) {
      const px = player.x, pz = player.z, lim = (v) => clamp(v, -HALF + 6, HALF - 6);
      let ok = false;
      for (const [mx, mz] of [[dx, dz], [dx, 0], [0, dz]]) {
        if (!mx && !mz) continue;
        const nx = lim(px + mx), nz = lim(pz + mz), st = standable(nx, nz, rig.feet, px, pz, rig.climb);
        if (st !== null) { player.x = nx; player.z = nz; rig.climb = st.steep > 0 ? rig.climb + st.steep : 0; ok = true; break; }
      }
      if (!ok && f > 0.3) { // blocked while pushing forward: look for something to scramble onto
        const tgt = scrambleTarget(px, pz, rig.feet, dx / step, dz / step);
        if (tgt) {
          const h = tgt.y - rig.feet;
          rig.climb = 0; rig.mantle = { t: 0, dur: 0.35 + 0.3 * (h / SCRAMBLE), x0: px, z0: pz, y0: rig.feet, x1: tgt.x, z1: tgt.z, y1: tgt.y };
          rig.voy -= (0.8 + h) * 1.6 * M;                         // crouch into it
          rig.vpit -= (0.6 + h * 0.6) * M;                        // eyes drop to the ledge
          rig.vroll += (Math.random() < 0.5 ? -1 : 1) * (0.25 + 0.25 * h) * M; // shoulder leads
        }
      }
      moved = Math.hypot(player.x - px, player.z - pz);
      if (moved > 0) uphill = (ground(player.x, player.z) - ground(px, pz)) / moved;
    }
    // vertical: step up instantly (camera compensates), snap down gentle descents, fall off ledges
    const sup = footSupport(player.x, player.z);
    if (sup >= rig.feet) {
      const d = sup - rig.feet;
      if (d > 0.08) { rig.oy -= d; rig.voy -= d * RIG.dipStep * M; }     // the head lags, dips, then catches up
      else rig.oy -= d;
      rig.feet = sup; rig.vy = 0;
    } else {
      const drop = rig.feet - sup, snap = 0.06 + speed * dt * MAX_GROUND_SLOPE;
      if (drop <= snap && rig.vy === 0) { rig.oy += drop; rig.feet = sup; } // stay glued to the ground going downhill
      else {
        rig.vy -= 9.8 * dt; rig.feet += rig.vy * dt;
        if (rig.feet <= sup) { const impact = -rig.vy; rig.feet = sup; rig.vy = 0; rig.voy -= impact * 0.55 * M; rig.vpit -= impact * 0.08 * M; }
      }
    }
  }

  // stride-locked sway on steep climbs; amplitude follows steepness through a spring so it swells and fades
  // uphill steepness along the direction of travel, from the smooth 2 m terrain (not frame-to-frame jitter)
  if (moved > 0) {
    const ux = (player.x - rig.lx) / moved, uz = (player.z - rig.lz) / moved;
    uphill = (sampleGrid(W.H, N, player.x + ux, player.z + uz) - sampleGrid(W.H, N, player.x - ux, player.z - uz)) / 2;
  }
  rig.lx = player.x; rig.lz = player.z;
  rig.phase += (moved / (run ? 1.3 : 0.75)) * Math.PI;
  const steep = smoothstep(RIG.swayFrom, RIG.swayFull, uphill) * (moved > 0 ? 1 : 0);
  [rig.swayAmp, rig.vSway] = spring(rig.swayAmp, rig.vSway, steep, 8, dt);
  const sway = Math.sin(rig.phase) * rig.swayAmp, bob = -Math.abs(Math.sin(rig.phase)) * rig.swayAmp;
  const dodge = shrubPush(player.x, player.z, rx, rz);
  [rig.lat, rig.vlat] = spring(rig.lat, rig.vlat, (sway * RIG.swayLat + dodge) * M, RIG.kLat, dt);
  [rig.roll, rig.vroll] = spring(rig.roll, rig.vroll, 0, RIG.kRoll, dt); // roll only from scramble impulses
  [rig.pit, rig.vpit] = spring(rig.pit, rig.vpit, 0, RIG.kPitch, dt);
  // vertical: stiffer when the head is above where it should be, so stepping down off a log doesn't float
  [rig.oy, rig.voy] = spring(rig.oy, rig.voy, bob * RIG.swayBob * M, rig.oy > 0 ? RIG.kDown : RIG.kUp, dt);
  player.eye = rig.feet + 1.65 + rig.oy;
}
function applyCamera() {
  const cy = Math.cos(player.yaw), sy = Math.sin(player.yaw);
  camera.position.set(player.x + cy * rig.lat, player.eye, player.z - sy * rig.lat);
  camera.rotation.set(clamp(player.pitch + rig.pit, -1.45, 1.45), player.yaw, rig.roll);
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
const fSeed = $('fSeed'), fAge = $('fAge'), fMoist = $('fMoist'), fStorm = $('fStorm'), fQual = $('fQual'), fGeo = $('fGeo'), fMotion = $('fMotion');
function syncForm() { fSeed.value = settings.seed; fAge.value = String(settings.age); fMoist.value = settings.moisture; fStorm.value = settings.storms; fQual.value = settings.quality; fGeo.value = settings.geology; fMotion.value = settings.motion || 'full'; }
fMotion.addEventListener('change', () => { settings.motion = fMotion.value; saveSettings(); });
syncForm();
$('bDice').addEventListener('click', () => { fSeed.value = 1 + Math.floor(Math.random() * 99999); });
$('bRegen').addEventListener('click', () => {
  const q = fQual.value !== settings.quality;
  Object.assign(settings, { seed: clamp(parseInt(fSeed.value, 10) || 1, 1, 999999), age: +fAge.value, moisture: fMoist.value, storms: fStorm.value, geology: fGeo.value, quality: fQual.value });
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
    W = await generateWorld({ seed: settings.seed, age: settings.age, moisture: settings.moisture, storms: settings.storms, geology: settings.geology }, async (msg, p) => {
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
  get world() { return W; }, player, settings, ground: (x, z) => ground(x, z), resetRig, input, RIG, nearCells: () => near.cells, step(dt) { movePlayer(dt); refreshNear(player.x, player.z); },
  col: { footSupport, standable, scrambleTarget, supportGrad, slopeAt, trunkHit, solids: () => solids }, rig,
  pause() { running = false; },
  info() { return { near: Object.fromEntries(Object.entries(near.b).map(([k, v]) => [k, v.n])), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries }; },
  renderOnce() { refreshNear(player.x, player.z, true); applyCamera(); sky.position.copy(camera.position); renderer.shadowMap.needsUpdate = true; uTime.value = 0; updateTiles(); terrainU.uCenter.value.set(Math.round(player.x / 8) * 8, Math.round(player.z / 8) * 8); renderer.render(scene, camera); },
};

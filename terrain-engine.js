// ============================================================================
// ASKIIES GPU HYBRID TERRAIN ENGINE (v1.0)
// Drop-in external module: 3D WebGL LOD terrain, dynamic ocean & underwater
// reefs, instanced 3D cities, Proving Ground, 3D instanced vegetation, and
// GPU volumetric sky/clouds/orbital Earth — with Hybrid 3D+ASCII overlay,
// Stylized 3D, and Classic ASCII fallback modes.
//
// Designed to stay completely decoupled from ASKIIES.html so future upstream
// game updates only need a single <script src="terrain-engine.js"></script>.
// ============================================================================
(function () {
  'use strict';

  if (typeof THREE === 'undefined' || typeof S === 'undefined' || typeof C === 'undefined' || typeof R === 'undefined') {
    console.warn('[terrain-engine] ASKIIES globals not found; skipping GPU terrain init.');
    return;
  }

  // ---------- Options & Quality Tiers ----------
  // OPT.tmode: 0 = HYBRID 3D+ASCII, 1 = STYLIZED 3D, 2 = CLASSIC ASCII
  // OPT.tqual: 0 = AUTO, 1 = LOW, 2 = MED, 3 = HIGH, 4 = ULTRA
  if (OPT.tmode == null) OPT.tmode = 0;
  if (OPT.tqual == null) OPT.tqual = 0;
  LISTS.tmode = () => ['HYBRID 3D+ASCII', 'STYLIZED 3D', 'CLASSIC ASCII'];
  LISTS.tqual = () => ['AUTO', 'LOW', 'MEDIUM', 'HIGH', 'ULTRA'];

  const IS_MOBILE = (() => {
    try { return (navigator.maxTouchPoints || 0) > 0 && matchMedia('(pointer:coarse)').matches; }
    catch (e) { return false; }
  })();

  const CAPS_OK = (() => {
    try {
      return !!(R && R.capabilities && R.capabilities.maxVertexTextures > 0);
    } catch (e) { return false; }
  })();

  const TIERS = [
    // 0: LOW (phones / low-end GPUs)
    { tSeg: 96,  wSeg: 64,  cSteps: 4, cityRad: 2850, cityMax: 2200, vegMax: 520,  vegRad: 420, drawDist: 18000 },
    // 1: MED (tablets / integrated GPUs)
    { tSeg: 144, wSeg: 88,  cSteps: 6, cityRad: 3450, cityMax: 3200, vegMax: 850,  vegRad: 520, drawDist: 22000 },
    // 2: HIGH (desktop default)
    { tSeg: 192, wSeg: 112, cSteps: 8, cityRad: 4050, cityMax: 4400, vegMax: 1200, vegRad: 600, drawDist: 28000 },
    // 3: ULTRA (high-end desktop)
    { tSeg: 240, wSeg: 128, cSteps: 10, cityRad: 4650, cityMax: 5600, vegMax: 1600, vegRad: 680, drawDist: 34000 }
  ];

  function pickTierIndex() {
    const q = OPT.tqual | 0;
    if (q >= 1 && q <= 4) return q - 1;
    // AUTO: adapt to mobile, adaptive quality PQ, and TERRAIN PIXELS setting
    let idx = IS_MOBILE ? 0 : 2;
    const pq = typeof PQ !== 'undefined' ? PQ : 0;
    if (pq >= 3) idx = 0;
    else if (pq >= 2) idx = Math.min(idx, 1);
    else if (!IS_MOBILE && (OPT.tres | 0) >= 5 && pq === 0) idx = 3;
    return idx;
  }

  let gpuFailed = !CAPS_OK;
  let curTierIdx = -1;
  let hmDirty = 1;
  let pgDirty = 1;
  let bgCleared = 0;

  const isGpuActive = () => !gpuFailed && (OPT.tmode | 0) !== 2;
  const asciiStrength = () => (OPT.tmode | 0) === 0 ? 1.0 : 0.0;

  // ---------- Shared State & Root Group ----------
  const ROOT = new THREE.Group();
  ROOT.name = 'GPU_TERRAIN_ROOT';
  ROOT.visible = false;
  S.add(ROOT);

  // Height range for 16-bit RGBA8 packing: [-450, +2600] => 3050 m span (~0.046 m precision)
  const H_MIN = -450.0;
  const H_SPAN = 3050.0;

  // Biome mapping matching ASKIIES MAP.hm / MAP.ty
  const BIOME_ID = {
    archi: 0, canyon: 1, fjord: 2, dunes: 3, steppe: 4,
    reef: 5, delta: 6, strait: 7, open: 8, sound: 9
  };

  function getBiomeId() {
    if (!MAP) return 0;
    const k = MAP.hm || MAP.ty || 'archi';
    return BIOME_ID[k] != null ? BIOME_ID[k] : 0;
  }

  // ---------- Texture 1: Noise LUT (exact match to JS NT / nz) ----------
  const ntData = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < 65536; i++) {
    const v = Math.max(0, Math.min(255, Math.round((NT[i] || 0) * 255)));
    const o = i * 4;
    ntData[o] = v;
    ntData[o + 1] = v;
    ntData[o + 2] = v;
    ntData[o + 3] = 255;
  }
  const uNT = new THREE.DataTexture(ntData, 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  uNT.wrapS = uNT.wrapT = THREE.RepeatWrapping;
  uNT.minFilter = uNT.magFilter = THREE.LinearFilter;
  uNT.generateMipmaps = false;
  uNT.needsUpdate = true;

  // ---------- Texture 2: 5x7 ASCII Glyph Atlas (16 glyphs x 1 row in 128x8) ----------
  // Index order:
  // 0: ' '  1: '.'  2: ','  3: '-'  4: '~'  5: ':'  6: '='  7: '*'
  // 8: '+'  9: '^' 10: '#' 11: '%' 12: 'T' 13: 'A' 14: '░' 15: '▒'
  const ATLAS_CHARS = [' ', '.', ',', '-', '~', ':', '=', '*', '+', '^', '#', '%', 'T', 'A', '░', '▒'];
  const uGlyph = (() => {
    const cw = 8, ch = 8, count = ATLAS_CHARS.length;
    const data = new Uint8Array(cw * count * ch * 4);
    for (let gi = 0; gi < count; gi++) {
      const key = ATLAS_CHARS[gi];
      const rows = (typeof GL !== 'undefined' && GL[key]) ? GL[key] : null;
      if (!rows) continue;
      for (let ry = 0; ry < 7; ry++) {
        const line = rows[ry] || '';
        for (let rx = 0; rx < 5; rx++) {
          if (line[rx] === '#') {
            const px = gi * cw + rx + 1;
            const py = (7 - (ry + 1)); // flip Y for WebGL tex coords
            const idx = (py * (cw * count) + px) * 4;
            data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
          }
        }
      }
    }
    const tex = new THREE.DataTexture(data, cw * count, ch, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  })();

  // ---------- Texture 3: Heightmap + Baked Cavity AO + Baked Directional Sun Shadow ----------
  const hmRGBA = new Uint8Array(256 * 256 * 4);
  const uHM = new THREE.DataTexture(hmRGBA, 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  uHM.wrapS = uHM.wrapT = THREE.RepeatWrapping;
  uHM.minFilter = uHM.magFilter = THREE.NearestFilter; // manual 4-tap bilinear in shader for exact 16-bit decode
  uHM.generateMipmaps = false;
  uHM.needsUpdate = true;

  let lastSunKey = '';

  function bakeHeightmapTexture() {
    hmDirty = 0;
    const sx = SUN.x, sy = SUN.y, sz = SUN.z;
    const hLen = Math.hypot(sx, sz) || 1;
    const dx = sx / hLen, dz = sz / hLen;
    const tanEl = Math.max(0.035, sy / hLen);
    const doShadow = sy > 0.015;
    lastSunKey = sx.toFixed(2) + ',' + sy.toFixed(2) + ',' + sz.toFixed(2);

    for (let j = 0; j < 256; j++) {
      const row = j << 8;
      for (let i = 0; i < 256; i++) {
        const idx = row | i;
        const h = HM[idx];

        // 16-bit height encoding into R (hi) and G (lo)
        const hn = Math.max(0, Math.min(1, (h - H_MIN) / H_SPAN));
        const q16 = Math.round(hn * 65535);
        const hi = (q16 >> 8) & 255;
        const lo = q16 & 255;

        // Cavity / ambient occlusion (multi-radius ring comparison)
        const hL1 = HM[row | ((i - 1) & 255)], hR1 = HM[row | ((i + 1) & 255)];
        const hD1 = HM[(((j - 1) & 255) << 8) | i], hU1 = HM[(((j + 1) & 255) << 8) | i];
        const hL2 = HM[row | ((i - 3) & 255)], hR2 = HM[row | ((i + 3) & 255)];
        const hD2 = HM[(((j - 3) & 255) << 8) | i], hU2 = HM[(((j + 3) & 255) << 8) | i];
        const avg = ((hL1 + hR1 + hD1 + hU1) * 0.6 + (hL2 + hR2 + hD2 + hU2) * 0.4) * 0.25;
        const cav = Math.max(-1, Math.min(1, (avg - h) / 110));
        const ao = Math.max(0.35, Math.min(1.15, 1.0 - Math.max(0, cav) * 0.52 + Math.max(0, -cav) * 0.14));
        const aoB = Math.max(0, Math.min(255, Math.round((ao / 1.2) * 255)));

        // Precomputed soft directional sun shadow along (dx, dz)
        let sh = 1.0;
        if (doShadow && h > -6) {
          let maxOver = 0.0;
          // 12 non-linear horizon march steps up to ~3.4 km toward the sun
          for (let s = 1; s <= 12; s++) {
            const distCells = s * (0.75 + s * 0.2);
            const si = Math.round(i + dx * distCells) & 255;
            const sj = Math.round(j + dz * distCells) & 255;
            const shH = HM[(sj << 8) | si];
            const rayH = h + distCells * HSZ * tanEl;
            const over = (shH - rayH) / (46.0 + distCells * 12.0);
            if (over > maxOver) maxOver = over;
            if (maxOver >= 1.0) { maxOver = 1.0; break; }
          }
          sh = 1.0 - maxOver * 0.52;
        }
        const shA = Math.max(0, Math.min(255, Math.round(sh * 255)));

        const o = idx * 4;
        hmRGBA[o] = hi;
        hmRGBA[o + 1] = lo;
        hmRGBA[o + 2] = aoB;
        hmRGBA[o + 3] = shA;
      }
    }
    uHM.needsUpdate = true;
  }

  // ---------- Common GLSL Snippets (WebGL1 compatible) ----------
  // Vertex-safe common chunk (uses only uNT & uHM = 2 vertex texture units max)
  const GLSL_VERT_COMMON = `
    uniform sampler2D uNT;
    uniform sampler2D uHM;
    uniform vec3 uCamPos;
    uniform vec2 uWind;
    uniform float uTime;
    uniform float uRealTime;
    uniform float uMicro;

    float nzTex(vec2 p) {
      return texture2D(uNT, (p + 0.5) / 256.0).r;
    }

    vec4 hmTexel(vec2 ij) {
      vec2 uv = (mod(ij, 256.0) + 0.5) / 256.0;
      return texture2D(uHM, uv);
    }

    float decodeH(vec4 t) {
      float q = (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0;
      return ${H_MIN.toFixed(1)} + q * ${H_SPAN.toFixed(1)};
    }

    vec3 sampleHM3(vec2 wxz) {
      vec2 f = wxz / 100.0 + 128.0;
      vec2 i0 = floor(f);
      vec2 fr = f - i0;
      vec4 t00 = hmTexel(i0);
      vec4 t10 = hmTexel(i0 + vec2(1.0, 0.0));
      vec4 t01 = hmTexel(i0 + vec2(0.0, 1.0));
      vec4 t11 = hmTexel(i0 + vec2(1.0, 1.0));

      float h00 = decodeH(t00), h10 = decodeH(t10);
      float h01 = decodeH(t01), h11 = decodeH(t11);
      float h = mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);

      float ao = mix(mix(t00.b, t10.b, fr.x), mix(t01.b, t11.b, fr.x), fr.y) * 1.2;
      float sh = mix(mix(t00.a, t10.a, fr.x), mix(t01.a, t11.a, fr.x), fr.y);
      return vec3(h, ao, sh);
    }
  `;

  const GLSL_COMMON = `
    ${GLSL_VERT_COMMON}
    uniform sampler2D uGlyph;
    uniform vec3 uSunDir;
    uniform vec3 uSkyHor;
    uniform vec3 uSkyZen;
    uniform vec3 uHazeCol;
    uniform vec3 uGlowCol;
    uniform vec3 uLightCol;
    uniform float uVis;
    uniform float uCov;
    uniform float uRain;
    uniform float uStorm;
    uniform float uSunA;
    uniform float uAmb;
    uniform float uAscii;
    uniform float uSpaceK;
    uniform float uInCloud;
    uniform float uBolt;
    uniform float uDpr;

    float hash12(vec2 p) {
      float s = sin(dot(p, vec2(127.1, 311.7))) * 43758.5453;
      return fract(s);
    }

    float fbm2(vec2 p) {
      float s = 0.0;
      s += nzTex(p) * 0.54;
      s += nzTex(p * 2.03 + vec2(17.3, 9.1)) * 0.29;
      s += nzTex(p * 4.11 + vec2(3.7, 29.4)) * 0.17;
      return s;
    }

    float sampleTerrainH(vec2 wxz) {
      vec3 s = sampleHM3(wxz);
      float h = s.x;
      if (uMicro > 0.001 && h > 3.0) {
        float m = uMicro * smoothstep(3.0, 60.0, h);
        float micro = (nzTex(wxz / 41.0) - 0.5) + (nzTex(wxz / 13.0 + vec2(7.0, 0.0)) - 0.5) * 0.4;
        h += micro * m * 2.0;
      }
      return h;
    }

    // Sample 5x7 ASCII glyph from atlas (glyphIdx in 0..15)
    float sampleGlyph(float glyphIdx, vec2 fragPx) {
      float cellScale = max(1.0, floor(uDpr + 0.5));
      vec2 cellSz = vec2(6.0, 9.0) * cellScale;
      vec2 inCell = mod(fragPx, cellSz) / cellSz;
      // Map cell UV into the 5x7 pixel box inside each 8x8 atlas slot
      vec2 sub = floor(inCell * vec2(6.0, 8.0));
      if (sub.x >= 5.0 || sub.y >= 7.0) return 0.0;
      float u = (glyphIdx * 8.0 + sub.x + 1.5) / ${(ATLAS_CHARS.length * 8).toFixed(1)};
      float v = (sub.y + 0.5) / 8.0;
      return texture2D(uGlyph, vec2(u, v)).r;
    }

    vec3 applyAerialFog(vec3 col, vec3 rayDir, float dist) {
      float f = clamp(dist / (uVis * 2.15), 0.0, 1.0);
      float fe = pow(f, 0.92) * 0.93 * (1.0 - uCov * 0.16) + uCov * 0.12 * f;
      // Mie forward-scattering solar glow in the haze
      float sunAmt = max(0.0, dot(rayDir, uSunDir));
      vec3 fogCol = mix(uHazeCol, uGlowCol, pow(sunAmt, 6.0) * 0.45 * uSunA);
      // Blend slightly toward horizon sky at extreme range for seamless horizon
      float farK = smoothstep(0.65, 1.0, f);
      fogCol = mix(fogCol, uSkyHor, farK * 0.55);
      vec3 outCol = mix(col, fogCol, clamp(fe, 0.0, 1.0));
      if (uInCloud > 0.5) {
        float cf = clamp(dist / 240.0, 0.0, 0.92);
        vec3 cc = vec3(0.76, 0.79, 0.84) * (1.0 - uStorm * 0.42) * uLightCol;
        outCol = mix(outCol, cc, cf);
      }
      return outCol;
    }
  `;

  // ---------- Shared Uniform Registry ----------
  const SHARED = {
    uNT: { value: uNT },
    uHM: { value: uHM },
    uGlyph: { value: uGlyph },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0.45, 0.4, -0.8).normalize() },
    uSkyHor: { value: new THREE.Vector3(0.55, 0.8, 0.9) },
    uSkyZen: { value: new THREE.Vector3(0.12, 0.3, 0.7) },
    uHazeCol: { value: new THREE.Vector3(0.65, 0.82, 0.9) },
    uGlowCol: { value: new THREE.Vector3(1.0, 0.94, 0.78) },
    uLightCol: { value: new THREE.Vector3(1, 1, 1) },
    uWind: { value: new THREE.Vector2(8, 4) },
    uTime: { value: 0 },
    uRealTime: { value: 0 },
    uVis: { value: 6000 },
    uCov: { value: 0 },
    uRain: { value: 0 },
    uStorm: { value: 0 },
    uSunA: { value: 1 },
    uAmb: { value: 0.42 },
    uAscii: { value: 1.0 },
    uMicro: { value: 8.0 },
    uSpaceK: { value: 0.0 },
    uInCloud: { value: 0.0 },
    uBolt: { value: 0.0 },
    uDpr: { value: 1.0 }
  };

  // Helper to build 6 nested world-snapped concentric clipmap rings in ONE single BufferGeometry
  // Vertex position encodes (ix, ringIndex, iz) where ix, iz are integers in [-halfM, +halfM].
  // Because each ring snaps independently to 2 * step in world space, vertices NEVER slide across hills!
  function buildClipmapGeometry(halfM, numRings) {
    numRings = numRings || 6;
    const side = halfM * 2 + 1;
    const hole = Math.max(2, (halfM >> 1) - 1);
    const pos = [];
    const idx = [];
    let vOff = 0;

    for (let r = 0; r < numRings; r++) {
      for (let j = -halfM; j <= halfM; j++) {
        for (let i = -halfM; i <= halfM; i++) {
          pos.push(i, r, j);
        }
      }
      for (let j = 0; j < halfM * 2; j++) {
        const iz = j - halfM;
        for (let i = 0; i < halfM * 2; i++) {
          const ix = i - halfM;
          if (r > 0 && ix >= -hole && ix < hole && iz >= -hole && iz < hole) continue;
          const a = vOff + j * side + i;
          const b = a + 1;
          const c = a + side;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      vOff += side * side;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
  }

  // Helper to build a radial-warped camera-centered grid in [-1, 1]^2 (used for flat water / city ground)
  function buildRadialGridGeometry(seg) {
    const verts = (seg + 1) * (seg + 1);
    const pos = new Float32Array(verts * 3);
    const idx = new (verts > 65535 ? Uint32Array : Uint16Array)(seg * seg * 6);
    let p = 0;
    for (let j = 0; j <= seg; j++) {
      const v = (j / seg) * 2 - 1;
      for (let i = 0; i <= seg; i++) {
        const u = (i / seg) * 2 - 1;
        pos[p++] = u;
        pos[p++] = 0;
        pos[p++] = v;
      }
    }
    let k = 0;
    const row = seg + 1;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * row + i;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  // ==========================================================================
  // 1. GPU SKY DOME + VOLUMETRIC CLOUDS + TYPHOON + ORBITAL EARTH
  // ==========================================================================
  const SKY_UNIFORMS = Object.assign({}, SHARED, {
    uStars: { value: 0.0 },
    uCloudA: { value: new THREE.Vector2(1750, 2300) },
    uCloudB: { value: new THREE.Vector2(3100, 3600) },
    uCloudSteps: { value: 8 },
    uTyph: { value: new THREE.Vector4(0, 0, 0, 0) }, // x, z, R (>0 active), spin
    uIsSpaceMap: { value: 0.0 }
  });

  const skyMat = new THREE.ShaderMaterial({
    uniforms: SKY_UNIFORMS,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      uniform float uStars;
      uniform vec2 uCloudA;
      uniform vec2 uCloudB;
      uniform int uCloudSteps;
      uniform vec4 uTyph;
      uniform float uIsSpaceMap;
      varying vec3 vDir;

      void marchSlab(vec3 cam, vec3 rd, vec2 deck, float mthr, float mdk, inout vec3 accC, inout float accA, float jit) {
        float b = deck.x, tp = deck.y;
        float Hh = max(1.0, tp - b);
        float t0 = 0.0, t1 = uVis * 1.45;
        if (abs(rd.y) < 0.0002) {
          if (cam.y < b || cam.y > tp) return;
        } else {
          float x1 = (b - cam.y) / rd.y;
          float x2 = (tp - cam.y) / rd.y;
          t0 = min(x1, x2);
          t1 = max(x1, x2);
          if (t1 < 0.0) return;
          if (t0 < 0.0) t0 = 0.0;
        }
        if (t0 > uVis * 1.3) return;
        float span = min(t1, min(t0 + 6200.0, uVis * 1.45)) - t0;
        if (span <= 1.0) return;

        float fSteps = float(uCloudSteps);
        float sp = span / fSteps;
        vec2 wOff = uWind * uTime * 0.6;
        float fs = max(0.0, dot(rd, uSunDir));
        float sil = pow(fs, 8.0) * uSunA * 1.35;
        float lf = uBolt > 0.5 ? 1.55 : 1.0;

        for (int i = 0; i < 10; i++) {
          if (i >= uCloudSteps || accA > 0.96) break;
          float rt_ = t0 + (float(i) + jit) * sp;
          if (rt_ > uVis * 1.45) break;
          float hy = cam.y + rd.y * rt_;
          float hh = (hy - b) / Hh;
          if (hh < 0.0 || hh > 1.0) continue;

          vec2 g = cam.xz + rd.xz * rt_ + wOff;
          float wq = nzTex(g / 1400.0 + vec2(uTime * 0.01, 0.0)) * 1.2;
          float base = nzTex(g / 760.0 + vec2(wq, hh * 0.4)) * 0.60
                     + nzTex(g / 210.0 + vec2(0.0, hh * 1.3)) * 0.28
                     + nzTex(g / 70.0 + vec2(hh, 0.0)) * 0.12;

          // Typhoon eye-wall spiral (Narumaiki Typhoon / Kairo Island)
          if (uTyph.z > 1.0) {
            vec2 ep = (g - wOff) - uTyph.xy;
            float rr = length(ep) / uTyph.z;
            if (rr < 1.0) base -= (1.0 - rr) * 1.3 + 0.2;
            else if (rr < 1.8) base += 0.34 * (1.0 - abs(rr - 1.35) / 0.45);
            else base += 0.17 * sin(atan(ep.y, ep.x) * 2.0 - log(rr) * 5.5 + uTyph.w) - 0.05;
          }

          float prof = hh < 0.14 ? (hh / 0.14) : (1.0 - pow(max(0.0, (hh - 0.35) / 0.65), 1.4) * 0.88);
          float d = (base - mthr) * prof * (1.0 + uStorm * 0.45) - hh * 0.11;
          if (d <= 0.001) continue;

          // Sunward self-shadow sample
          vec2 gs = g + uSunDir.xz * 180.0;
          float ld = max(0.0,
            nzTex(gs / 760.0 + vec2(wq, (hh + uSunDir.y * 0.2) * 0.4)) * 0.60
            + nzTex(gs / 210.0 + vec2(0.0, hh * 1.3)) * 0.28 - mthr);
          float sh = exp(-ld * 5.0);
          float pw = 1.0 - exp(-d * 4.2);

          float a = min(1.0, d * 10.5 * sp / 300.0);
          float lt = clamp((0.34 + 0.56 * sh * pw + 0.28 * pow(hh, 0.6)) * lf + sil * (1.0 - d) + uSunA * fs * fs * 0.25, 0.0, 1.25);
          float tf = min(1.0, rt_ / (uVis * 1.45));
          float ff = tf * tf;
          float dk = mdk * (1.0 - uStorm * 0.28 * (1.0 - hh));
          vec3 cCol = (vec3(0.30, 0.34, 0.41) + vec3(0.70, 0.66, 0.59) * lt) * dk * uLightCol;
          cCol = mix(cCol, uHazeCol, ff * 0.88);

          float w = a * (1.0 - accA);
          accC += cCol * w;
          accA += w;
        }
      }

      vec3 renderSpace(vec3 rd, out float spaceGlyph) {
        spaceGlyph = 0.0;
        vec3 res = vec3(0.012, 0.016, 0.038);
        float h = max(1000.0, uCamPos.y);
        float Re = 6371000.0;
        float oy = Re + h;
        float b = oy * rd.y;
        float cc = oy * oy - Re * Re;
        float disc = b * b - cc;
        float dr = uRealTime * 1.4;

        if (disc > 0.0 && (-b - sqrt(disc)) > 0.0) {
          float tt = -b - sqrt(disc);
          vec3 hp = vec3(rd.x * tt, oy + rd.y * tt, rd.z * tt);
          vec3 N = normalize(hp);
          vec2 X = hp.xz + uCamPos.xz;
          float lit = dot(N, uSunDir);
          float day = smoothstep(-0.12, 0.20, lit);

          float s1 = 1.0 / 2.2e6;
          float cont = nzTex(X * s1 + vec2(15.6, 13.6)) * 0.60
                     + nzTex(X * s1 * 2.3 + vec2(3.0, 1.0)) * 0.27
                     + nzTex(X * s1 * 6.0 + vec2(9.0, 4.0)) * 0.13;
          bool isLand = cont > 0.60;
          bool isHi = cont > 0.72;
          bool isIce = abs(N.z) > 0.925;

          // Swirling clouds + cast cloud shadows
          float covN = nzTex(X / 1.4e6 + vec2(31.0, 17.0));
          vec2 cw = X / 2.4e5 + vec2(
            1.6 * nzTex(X / 6.0e5 + vec2(dr * 0.01, 0.0)) + dr * 0.003,
            1.6 * nzTex(X / 6.0e5 + vec2(5.0, 3.0))
          );
          float cd = nzTex(cw) * 0.55 + nzTex(cw * 2.1 + vec2(4.0, 1.0)) * 0.30 + nzTex(cw * 4.3 + vec2(9.0, 2.0)) * 0.15;
          float th0 = 0.60 - 0.24 * covN;
          float dens = smoothstep(th0, th0 + 0.14, cd);
          vec2 csh = cw - uSunDir.xz * 0.085;
          float cshD = smoothstep(th0, th0 + 0.15, nzTex(csh) * 0.55 + nzTex(csh * 2.1 + vec2(4.0, 1.0)) * 0.45);

          vec3 col;
          if (isLand) {
            float dry = smoothstep(0.45, 0.68, nzTex(X / 4.5e5 + vec2(20.0, 0.0)));
            float fo = nzTex(X / 1.2e5);
            float shore = smoothstep(0.60, 0.64, cont);
            vec3 veg = mix(vec3(0.14, 0.34, 0.16), vec3(0.26, 0.46, 0.20), fo);
            vec3 des = vec3(0.72, 0.58, 0.36);
            col = isHi ? vec3(0.48, 0.45, 0.41) : mix(veg, des, dry);
            col = mix(vec3(0.80, 0.76, 0.58), col, shore);
          } else {
            float dp = smoothstep(0.60, 0.38, cont);
            float sh2 = smoothstep(0.52, 0.60, cont);
            col = mix(vec3(0.09, 0.38, 0.56), vec3(0.03, 0.14, 0.36), dp);
            col = mix(col, vec3(0.18, 0.60, 0.68), sh2 * 0.58);
          }
          if (isIce) col = vec3(0.92, 0.95, 0.98);

          float k0 = (0.04 + 0.96 * day) * (1.0 - 0.35 * cshD * day);
          col *= k0;

          // City lights on the night side
          if (isLand && day < 0.35) {
            float city = smoothstep(0.66, 0.78, nzTex(X / 8.5e4)) * (1.0 - day / 0.35);
            col += vec3(1.0, 0.76, 0.36) * city * 0.85 * (1.0 - dens * 0.7);
          }

          // Ocean sun specular glint
          if (!isLand && day > 0.15) {
            vec3 refl = reflect(rd, N);
            float sp = pow(max(0.0, dot(refl, uSunDir)), 52.0) * day;
            col += vec3(0.85, 0.80, 0.68) * sp * (1.0 - dens * 0.8);
          }

          // Cloud deck + blue limb atmospheric scatter
          float cwL = 0.08 + 0.92 * day;
          col = mix(col, vec3(0.95, 0.97, 1.0) * cwL, dens * 0.92);
          float mu = max(0.0, -dot(rd, N));
          float limb = exp(-mu * 6.5) * (0.25 + 0.75 * day);
          col = mix(col, vec3(0.42, 0.70, 1.0), limb * 0.82);
          if (dens > 0.65) spaceGlyph = 14.0;
          else if (isHi && day > 0.3) spaceGlyph = 9.0;
          res = col;
        } else {
          // Deep space background + glowing atmospheric limb halo + sun + crisp pinpoint stars
          vec3 col = vec3(0.010, 0.014, 0.034);
          if (b < 0.0) {
            float dmin = sqrt(max(0.0, oy * oy - b * b));
            float alt = dmin - Re;
            if (alt < 190000.0) {
              float tt = -b;
              vec3 q = normalize(vec3(rd.x * tt, oy + rd.y * tt, rd.z * tt));
              float g = exp(-max(0.0, alt) / 38000.0);
              float dd = smoothstep(-0.25, 0.30, dot(q, uSunDir));
              col += g * (vec3(0.14, 0.30, 0.54) + vec3(0.34, 0.54, 0.64) * dd);
            }
          }
          float sd = dot(rd, uSunDir);
          if (sd > 0.9988) col = vec3(1.0, 0.99, 0.92);
          else if (sd > 0.95) {
            float q = (sd - 0.95) / 0.05;
            col += vec3(0.95, 0.86, 0.66) * q * q;
          }
          // Crisp pinpoint starfield
          vec3 stP = rd * 180.0;
          vec3 stCell = floor(stP);
          vec3 stF = fract(stP) - 0.5;
          float hs = hash12(stCell.xy + stCell.z * 37.3);
          if (hs > 0.972) {
            float dotStar = smoothstep(0.16, 0.03, length(stF));
            float tw = 0.72 + 0.28 * sin(uRealTime * 2.8 + hs * 90.0);
            col += mix(vec3(0.75, 0.86, 1.0), vec3(1.0, 0.92, 0.78), fract(hs * 41.0)) * dotStar * tw * 1.15;
          }
          res = col;
        }
        return res;
      }

      void main() {
        vec3 rd = normalize(vDir);
        float atmDark = smoothstep(9000.0, 58000.0, uCamPos.y);
        float spaceBlend = max(uSpaceK, uIsSpaceMap > 0.5 ? 1.0 : 0.0);

        // Atmospheric sky gradient
        float uy = max(0.0, rd.y);
        float grad = pow(uy, 0.52);
        vec3 hor = mix(uSkyHor, vec3(0.06, 0.14, 0.30), atmDark * 0.85);
        vec3 zen = mix(uSkyZen, vec3(0.012, 0.016, 0.042), atmDark);
        vec3 sky = mix(hor, zen, grad);
        if (rd.y < 0.0) {
          sky = mix(hor, uHazeCol * 0.85, clamp(-rd.y * 4.0, 0.0, 1.0));
        }

        // Sun disc + Mie solar corona
        float sd = dot(rd, uSunDir);
        if (uSunA > 0.1) {
          float corona = pow(max(0.0, (sd - 0.90) / 0.10), 2.4) * uSunA;
          sky = mix(sky, uGlowCol, clamp(corona * 0.78, 0.0, 0.9));
          if (sd > 0.9986) sky = mix(uGlowCol, vec3(1.0, 1.0, 0.94), 0.7);
        }

        // Dusk / high-altitude pinpoint stars
        float starAmt = max(uStars * (1.0 - uCov * 0.9), atmDark);
        if (starAmt > 0.05 && rd.y > 0.05) {
          vec3 stP = rd * 165.0;
          vec3 sc = floor(stP);
          vec3 sf = fract(stP) - 0.5;
          float hs = hash12(sc.xy + sc.z * 19.7);
          if (hs > 0.976) {
            float dotStar = smoothstep(0.16, 0.03, length(sf));
            float tw = 0.68 + 0.32 * sin(uRealTime * 3.0 + hs * 100.0);
            sky += vec3(0.92, 0.95, 1.0) * dotStar * tw * starAmt * smoothstep(0.05, 0.26, rd.y) * 1.1;
          }
        }

        // High-altitude wispy cirrus clouds (~9000 m)
        if (rd.y > 0.015 && uCamPos.y < 9000.0 && uInCloud < 0.5 && spaceBlend < 0.95) {
          float tq = (9000.0 - uCamPos.y) / rd.y;
          if (tq < 70000.0) {
            vec2 gp = uCamPos.xz + rd.xz * tq;
            vec2 wn = length(uWind) > 0.01 ? normalize(uWind) : vec2(1.0, 0.35);
            vec2 rotP = vec2(gp.x * wn.x + gp.y * wn.y + uTime * 7.0, -gp.x * wn.y + gp.y * wn.x);
            float cn = nzTex(rotP / vec2(7000.0, 720.0) + vec2(11.0, 0.0)) * 0.55
                     + nzTex(rotP / vec2(2000.0, 320.0) + vec2(0.0, 5.0)) * 0.30
                     + nzTex(rotP / 600.0 + vec2(3.0, 0.0)) * 0.15;
            float dn = smoothstep(0.60, 0.82, cn) * (1.0 - tq / 70000.0) * (0.3 + 0.7 * (1.0 - uCov)) * 0.65;
            if (dn > 0.01) {
              float sb = uSunDir.y < -0.05 ? 0.32 : clamp(uSunDir.y * 2.0 + 0.55, 0.45, 1.0);
              float lt = (0.82 + 0.42 * pow(max(0.0, sd), 6.0)) * sb * (1.0 - uStorm * 0.45);
              vec3 cirCol = mix(uGlowCol, vec3(0.95, 0.96, 0.99), clamp(uSunDir.y * 4.0, 0.0, 1.0)) * lt;
              sky = mix(sky, cirCol, dn);
            }
          }
        }

        // Volumetric cumulus decks (2 layers)
        float cloudAlpha = 0.0;
        if (spaceBlend < 0.95 && uCloudSteps > 0) {
          vec3 accC = vec3(0.0);
          float accA = 0.0;
          if (uInCloud > 0.5) {
            accA = 0.55;
            accC = vec3(0.80, 0.83, 0.88) * (1.0 - uStorm * 0.45) * uLightCol * 0.55;
          }
          float mthr = 0.58 - uCov * 0.30;
          float mdk = 1.0 - uStorm * 0.45 - uCov * 0.12;
          // Interleaved gradient noise eliminates diagonal banding in volumetric clouds
          float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          // Order slabs nearest-first along ray
          if (rd.y >= 0.0) {
            marchSlab(uCamPos, rd, uCloudA, mthr, mdk, accC, accA, jit);
            marchSlab(uCamPos, rd, uCloudB, mthr, mdk, accC, accA, jit);
          } else {
            marchSlab(uCamPos, rd, uCloudB, mthr, mdk, accC, accA, jit);
            marchSlab(uCamPos, rd, uCloudA, mthr, mdk, accC, accA, jit);
          }
          if (accA > 0.005) {
            sky = accC + sky * (1.0 - accA);
            cloudAlpha = accA;
          }
        }

        // Crossfade into orbital Earth sphere above 20 km or on space maps
        float spGlyph = 0.0;
        if (spaceBlend > 0.002) {
          vec3 spCol = renderSpace(rd, spGlyph);
          sky = mix(sky, spCol, spaceBlend);
        }

        // Subtle Hybrid ASCII cloud rim accent (keeps clouds soft & volumetric)
        if (uAscii > 0.5) {
          float gIdx = 0.0;
          float gAmt = 0.0;
          if (spaceBlend > 0.5 && spGlyph > 0.5) {
            gIdx = spGlyph; gAmt = 0.18;
          } else if (cloudAlpha > 0.25 && cloudAlpha < 0.72) {
            gIdx = 1.0; // subtle '.' dither on cloud edges only
            gAmt = 0.14;
          }
          if (gIdx > 0.5) {
            float g = sampleGlyph(gIdx, gl_FragCoord.xy);
            sky = mix(sky, sky * 1.15 + vec3(0.05), g * gAmt);
          }
        }

        gl_FragColor = vec4(clamp(sky, 0.0, 1.0), 1.0);
      }
    `
  });

  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 28, 16), skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -100;
  ROOT.add(skyMesh);

  // ==========================================================================
  // 2. ZERO-WARP WORLD-SNAPPED CLIPMAP TERRAIN (ALL 10 BIOMES + PER-PIXEL SHADOWS)
  // ==========================================================================
  const TERR_UNIFORMS = Object.assign({}, SHARED, {
    uGridOrigin: { value: new THREE.Vector2(0, 0) },
    uGridRadius: { value: 28000.0 },
    uBaseStep: { value: 24.0 },
    uHalfM: { value: 40.0 },
    uBiome: { value: 0 },
    uMaxH: { value: 1200.0 },
    uSnow: { value: 0.0 },
    uVolcano: { value: new THREE.Vector2(6200, -2300) },
    uHasVolcano: { value: 0.0 }
  });

  const terrMat = new THREE.ShaderMaterial({
    uniforms: TERR_UNIFORMS,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: `
      precision highp float;
      ${GLSL_VERT_COMMON}
      uniform float uBaseStep;
      uniform float uHalfM;
      uniform float uGridRadius;

      varying vec3 vWorldPos;

      void main() {
        // World-snapped nested clipmap: every vertex stays locked to a fixed world lattice!
        float r = position.y;
        float stepSz = uBaseStep * pow(2.0, r);
        float snap = stepSz * 2.0;
        vec2 origin = floor(uCamPos.xz / snap + 0.5) * snap;
        vec2 wxz = origin + vec2(position.x, position.z) * stepSz;

        // Smooth CDLOD morph on outer 4 cells of each ring onto the parent ring's exact 2x lattice
        float edgeM = max(abs(position.x), abs(position.z));
        if (r < 4.9) {
          float morph = clamp((edgeM - (uHalfM - 4.0)) / 4.0, 0.0, 1.0);
          if (morph > 0.001) {
            vec2 odd = mod(abs(position.xz), 2.0);
            vec2 sgn = vec2(position.x >= 0.0 ? 1.0 : -1.0, position.z >= 0.0 ? 1.0 : -1.0);
            wxz -= odd * sgn * stepSz * morph;
          }
        }

        vec3 hm = sampleHM3(wxz);
        float h = hm.x;
        // Micro-relief only on near/mid rings so distant peaks never shimmer
        if (uMicro > 0.001 && h > 3.0 && r < 2.5) {
          float mFade = 1.0 - smoothstep(1.0, 2.5, r);
          float m = uMicro * smoothstep(3.0, 60.0, h) * mFade;
          float micro = (nzTex(wxz / 41.0) - 0.5) + (nzTex(wxz / 13.0 + vec2(7.0, 0.0)) - 0.5) * 0.4;
          h += micro * m * 2.0;
        }

        // Recess the 1-cell inner overlap skirt slightly so the finer inner ring always wins depth cleanly
        if (r > 0.5) {
          float inStep = stepSz * 0.5;
          vec2 inOrigin = floor(uCamPos.xz / stepSz + 0.5) * stepSz;
          float inHalf = uHalfM * inStep;
          float inD = max(abs(wxz.x - inOrigin.x), abs(wxz.y - inOrigin.y));
          if (inD < inHalf - 0.15 * stepSz) {
            h -= 0.14 * stepSz;
          }
        }

        // Gentle horizon drop only at the extreme outer edge of ring 5
        if (r > 4.5 && edgeM > uHalfM - 3.0) {
          h -= (edgeM - (uHalfM - 3.0)) * 220.0;
        }

        vWorldPos = vec3(wxz.x, h, wxz.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      uniform int uBiome;
      uniform float uMaxH;
      uniform float uSnow;
      uniform vec2 uVolcano;
      uniform float uHasVolcano;

      varying vec3 vWorldPos;

      void main() {
        vec2 wxz = vWorldPos.xz;
        float h = vWorldPos.y;
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);

        // World-locked per-pixel height, AO & baked cast sun shadow (ZERO lighting/shadow warping!)
        vec3 hmPix = sampleHM3(wxz);
        float aoPix = hmPix.y;
        float sunShPix = hmPix.z;

        // Fixed world-space normal epsilon so normals never shift with camera distance
        float eps = 18.0;
        float hR = sampleTerrainH(wxz + vec2(eps, 0.0));
        float hL = sampleTerrainH(wxz - vec2(eps, 0.0));
        float hU = sampleTerrainH(wxz + vec2(0.0, eps));
        float hD = sampleTerrainH(wxz - vec2(0.0, eps));
        vec3 N = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));

        // Subtle high-frequency rocky normal perturbation close up
        float detailFade = 1.0 - smoothstep(1200.0, 5200.0, dist);
        if (detailFade > 0.02) {
          float n1 = nzTex(wxz * 0.065) - 0.5;
          float n2 = nzTex(wxz * 0.19 + vec2(13.1, 7.4)) - 0.5;
          N = normalize(N + vec3(n1 + n2 * 0.5, 0.0, n2 - n1 * 0.5) * 0.22 * detailFade);
        }

        float slope = 1.0 - N.y;
        float patchN = fbm2(wxz / 180.0);
        float microN = nzTex(wxz / 26.0);
        float fineN = nzTex(wxz / 7.5);
        float forestN = nzTex(wxz / 480.0 + vec2(8.0, -3.0));

        // Per-biome rich material palette + ASCII glyph selection
        vec3 baseCol = vec3(0.35, 0.52, 0.28);
        vec3 emissive = vec3(0.0);
        float glyphIdx = 1.0; // '.'

        if (uBiome == 0 || uBiome == 9) {
          // ARCHIPELAGO / IRONCLAD SOUND: beaches -> lush jungle -> volcanic rock peaks
          vec3 sand = vec3(0.86, 0.80, 0.60);
          vec3 lowVeg = mix(vec3(0.16, 0.46, 0.21), vec3(0.28, 0.54, 0.24), patchN);
          vec3 hiVeg = mix(vec3(0.30, 0.44, 0.25), vec3(0.38, 0.50, 0.28), patchN);
          vec3 rock = mix(vec3(0.42, 0.39, 0.35), vec3(0.28, 0.25, 0.24), smoothstep(560.0, 920.0, h));

          float sandK = smoothstep(3.0, 16.0, h);
          float hiK = smoothstep(320.0, 520.0, h);
          float rockK = max(smoothstep(0.24, 0.38, slope), smoothstep(520.0, 680.0, h));
          baseCol = mix(sand, mix(lowVeg, hiVeg, hiK), sandK);
          baseCol = mix(baseCol, rock, rockK);
          glyphIdx = rockK > 0.5 ? (h > 820.0 ? 11.0 : 9.0) : (sandK < 0.4 ? 1.0 : (forestN > 0.55 ? 12.0 : 2.0));
        } else if (uBiome == 1) {
          // RED CANYON: desert floor -> sedimentary red sandstone strata -> mesa tops
          vec3 floorCol = vec3(0.80, 0.62, 0.40);
          vec3 mesaCol = mix(vec3(0.76, 0.50, 0.32), vec3(0.68, 0.42, 0.28), patchN);
          float band = sin(h * 0.145 + nzTex(wxz / 120.0) * 5.0) * 0.5 + 0.5;
          vec3 strata = mix(vec3(0.56, 0.24, 0.16), vec3(0.84, 0.48, 0.25), band);
          float cliffK = smoothstep(0.18, 0.34, slope);
          baseCol = mix(floorCol, mesaCol, smoothstep(8.0, 45.0, h));
          baseCol = mix(baseCol, strata, cliffK);
          glyphIdx = cliffK > 0.45 ? 6.0 : (h < 18.0 ? 1.0 : 2.0);
        } else if (uBiome == 2) {
          // GLACIER FJORDS: dark slate shore -> pine taiga -> granite cliffs -> snow peaks
          vec3 shore = vec3(0.34, 0.37, 0.41);
          vec3 taiga = mix(vec3(0.14, 0.29, 0.22), vec3(0.20, 0.36, 0.26), patchN);
          vec3 granite = mix(vec3(0.36, 0.38, 0.44), vec3(0.48, 0.50, 0.55), microN);
          vec3 snow = mix(vec3(0.88, 0.92, 0.97), vec3(0.96, 0.98, 1.0), microN);
          float vegK = smoothstep(18.0, 42.0, h) * (1.0 - smoothstep(380.0, 520.0, h)) * (1.0 - smoothstep(0.22, 0.35, slope));
          float snowK = smoothstep(460.0, 760.0, h) * smoothstep(0.18, 0.42, N.y - 0.52 + h * 0.00028);
          baseCol = mix(shore, granite, smoothstep(15.0, 60.0, h));
          baseCol = mix(baseCol, taiga, vegK);
          baseCol = mix(baseCol, snow, snowK);
          glyphIdx = snowK > 0.5 ? 7.0 : (vegK > 0.45 ? 13.0 : 9.0);
        } else if (uBiome == 3) {
          // DUNE SEA: golden wind-rippled sand + ochre rock outcrops
          float rip = sin(wxz.x * 0.14 + wxz.y * 0.06 + patchN * 6.0) * 0.5 + 0.5;
          vec3 sand = mix(vec3(0.82, 0.64, 0.42), vec3(0.93, 0.78, 0.54), rip * 0.5 + microN * 0.5);
          vec3 slip = vec3(0.62, 0.40, 0.26);
          vec3 rock = vec3(0.46, 0.34, 0.25);
          float slipK = smoothstep(0.14, 0.28, slope);
          float rockK = smoothstep(135.0, 175.0, h);
          baseCol = mix(sand, slip, slipK);
          baseCol = mix(baseCol, rock, rockK);
          glyphIdx = rockK > 0.5 ? 9.0 : (slipK > 0.4 ? 6.0 : 4.0);
        } else if (uBiome == 4) {
          // IRON STEPPE: golden-olive grassland + ironstone ridges
          vec3 mud = vec3(0.50, 0.48, 0.38);
          vec3 grass = mix(vec3(0.45, 0.54, 0.27), vec3(0.60, 0.58, 0.31), patchN);
          vec3 iron = mix(vec3(0.42, 0.39, 0.36), vec3(0.52, 0.42, 0.35), microN);
          float rockK = max(smoothstep(0.18, 0.32, slope), smoothstep(230.0, 310.0, h));
          baseCol = mix(mud, grass, smoothstep(2.0, 12.0, h));
          baseCol = mix(baseCol, iron, rockK);
          glyphIdx = rockK > 0.5 ? 9.0 : 2.0;
        } else if (uBiome == 5) {
          // CORAL ATOLLS: bright white coral sand + bright palm greenery
          vec3 sand = vec3(0.95, 0.90, 0.72);
          vec3 palm = mix(vec3(0.15, 0.55, 0.28), vec3(0.24, 0.64, 0.32), patchN);
          float vegK = smoothstep(4.5, 11.0, h);
          baseCol = mix(sand, palm, vegK);
          glyphIdx = vegK > 0.45 ? 12.0 : 1.0;
        } else if (uBiome == 6) {
          // RIVER DELTA: wet silt banks -> reeds & marsh islands
          vec3 silt = vec3(0.39, 0.36, 0.25);
          vec3 marsh = mix(vec3(0.25, 0.43, 0.23), vec3(0.36, 0.48, 0.25), patchN);
          float vegK = smoothstep(2.5, 9.0, h);
          baseCol = mix(silt, marsh, vegK);
          glyphIdx = vegK > 0.45 ? 2.0 : 4.0;
        } else if (uBiome == 7) {
          // BASALT STRAIT: dark columnar basalt cliffs + highland moss/snow
          vec3 shore = vec3(0.20, 0.21, 0.24);
          vec3 basalt = mix(vec3(0.13, 0.14, 0.17), vec3(0.22, 0.23, 0.27), fineN);
          vec3 moss = mix(vec3(0.26, 0.34, 0.26), vec3(0.32, 0.40, 0.30), patchN);
          float cliffK = smoothstep(0.22, 0.36, slope);
          baseCol = mix(shore, mix(moss, basalt, cliffK), smoothstep(14.0, 38.0, h));
          glyphIdx = cliffK > 0.45 ? 10.0 : 12.0;
        } else {
          // KAIRO ISLAND OPEN WORLD (8): beaches, lush hills, volcanic caldera & glowing lava
          vec3 sand = vec3(0.88, 0.82, 0.63);
          vec3 meadow = mix(vec3(0.27, 0.52, 0.23), vec3(0.36, 0.58, 0.26), patchN);
          vec3 rock = vec3(0.45, 0.42, 0.38);
          float sandK = smoothstep(3.0, 12.0, h);
          float rockK = smoothstep(0.25, 0.38, slope);
          baseCol = mix(sand, meadow, sandK);
          baseCol = mix(baseCol, rock, rockK);
          glyphIdx = rockK > 0.5 ? 9.0 : (forestN > 0.58 ? 12.0 : 2.0);

          if (uHasVolcano > 0.5) {
            float dv = length(wxz - uVolcano);
            float ashK = smoothstep(3200.0, 1300.0, dv) * smoothstep(100.0, 260.0, h);
            vec3 ash = mix(vec3(0.25, 0.22, 0.22), vec3(0.36, 0.33, 0.29), microN);
            baseCol = mix(baseCol, ash, ashK);
            if (dv < 650.0 && h > 1150.0) {
              float lava = smoothstep(650.0, 280.0, dv) * smoothstep(0.45, 0.78, microN + 0.15 * sin(uRealTime * 2.0 + fineN * 6.0));
              emissive += vec3(1.0, 0.38, 0.08) * lava * 1.4;
              glyphIdx = 7.0;
            }
          }
        }

        // Rock strata accent on steep cliffs across all biomes
        if (slope > 0.32 && h > 25.0) {
          float strataB = sin(h * 0.14 + nzTex(wxz / 90.0) * 4.0) * 0.5 + 0.5;
          baseCol *= (0.82 + strataB * 0.28);
          glyphIdx = strataB > 0.72 ? 6.0 : (slope > 0.55 ? 11.0 : 10.0);
        }

        // High-altitude snow cap on snowy maps (Fjord, Strait, Kairo peaks)
        if (uSnow > 0.5) {
          float snLine = uMaxH * 0.68;
          float snK = smoothstep(snLine, snLine + 160.0, h) * smoothstep(0.62, 0.78, N.y);
          baseCol = mix(baseCol, vec3(0.92, 0.95, 0.99), snK);
          if (snK > 0.55) glyphIdx = 7.0;
        }

        // Subtle macro terrain variation
        baseCol *= (0.88 + 0.24 * patchN);

        // Lighting: vibrant sunlit diffuse + world-locked per-pixel cast shadows & AO + cel shoulder
        float ndl = max(0.0, dot(N, uSunDir));
        // Soft cel-shading tone shoulder matching ASKIIES's CEL aircraft shading
        float cel = mix(ndl, floor(ndl * 4.0 + 0.35) / 4.0, 0.28);
        float lit = cel * sunShPix * (1.0 - uCov * 0.40);
        vec3 skyBounce = mix(uSkyHor * 0.90, uSkyZen * 0.95, max(0.0, N.y)) * (uAmb * 1.25);
        vec3 direct = uLightCol * lit * 1.28;
        vec3 col = baseCol * (skyBounce + direct) * aoPix + emissive;

        // Grazing Fresnel rim light from sun/sky on mountain ridges
        float rim = pow(1.0 - max(0.0, dot(N, -rd)), 3.0) * 0.20 * uSunA;
        col += uGlowCol * rim * max(0.18, dot(N, uSunDir) + 0.35);

        // Hybrid 3D+ASCII overlay: crisp tactical contour lines + distinct 5x7 biome glyph accents
        if (uAscii > 0.5) {
          float midFade = smoothstep(20.0, 110.0, dist) * (1.0 - smoothstep(3800.0, 10500.0, dist));
          // Topographic elevation contours every 80 m
          float c80 = abs(fract(h / 80.0 + 0.5) - 0.5) * 80.0;
          float cLine = (1.0 - smoothstep(0.6, 2.4, c80)) * (1.0 - smoothstep(1600.0, 7200.0, dist)) * 0.26;
          col = mix(col, col * 1.45 + vec3(0.09, 0.14, 0.12), cLine * smoothstep(2.0, 18.0, h));

          // Crisp 5x7 ASCII glyph detail from ASKIIES bitmap font
          float g = sampleGlyph(glyphIdx, gl_FragCoord.xy);
          vec2 cellPx = vec2(6.0, 9.0) * max(1.0, floor(uDpr + 0.5));
          float gMask = step(0.24, hash12(floor(gl_FragCoord.xy / cellPx)));
          vec3 gCol = col * 1.55 + vec3(0.11);
          col = mix(col, gCol, g * gMask * 0.52 * (0.45 + 0.55 * midFade));
        }

        // Storm darkening + atmospheric aerial perspective
        col *= (1.0 - uStorm * 0.38);
        col = applyAerialFog(col, rd, dist);

        // Fade smoothly into orbital Earth when climbing above 20 km
        if (uSpaceK > 0.002) {
          col = mix(col, uHazeCol, uSpaceK * 0.85);
        }

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  });

  let terrMesh = null;

  // ==========================================================================
  // 3. DYNAMIC OCEAN + SHORELINE FOAM + UNDERWATER REEFS & WRECKS
  // ==========================================================================
  const MAX_WRECKS = 8;
  const wreckArr = [];
  for (let i = 0; i < MAX_WRECKS; i++) wreckArr.push(new THREE.Vector4(0, 0, 0, 0));

  const WATER_UNIFORMS = Object.assign({}, SHARED, {
    uGridOrigin: { value: new THREE.Vector2(0, 0) },
    uGridRadius: { value: 16500.0 },
    uSeaTint: { value: 1.0 },
    uShalCol: { value: new THREE.Vector3(0.24, 0.80, 0.77) },
    uWaveAmp: { value: 1.0 },
    uWaterMode: { value: 0 }, // 0 = open sea, 1 = heightmap land, 2 = city river, 3 = coastal city bay
    uHasUW: { value: 0.0 },
    uWrecks: { value: wreckArr } // xy = pos, z = angle, w = half-length
  });

  const waterMat = new THREE.ShaderMaterial({
    uniforms: WATER_UNIFORMS,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: `
      precision highp float;
      ${GLSL_VERT_COMMON}
      uniform vec2 uGridOrigin;
      uniform float uGridRadius;
      uniform float uWaveAmp;
      uniform int uWaterMode;

      varying vec3 vWorldPos;
      varying float vWaveH;

      float waveDisp(vec2 p) {
        vec2 wn = length(uWind) > 0.01 ? normalize(uWind) : vec2(0.89, 0.45);
        float a = dot(p, wn);
        float b = p.x * (-wn.y) + p.y * wn.x;
        float w1 = sin(a * 0.036 - uTime * 1.45 + sin(b * 0.015) * 1.8);
        float w2 = sin(a * 0.072 + b * 0.028 - uTime * 2.1) * 0.48;
        float w3 = sin(b * 0.055 - a * 0.022 - uTime * 1.1) * 0.25;
        return (w1 + w2 + w3) * uWaveAmp;
      }

      void main() {
        vec2 uv = position.xz;
        vec2 wOff = sign(uv) * pow(abs(uv), vec2(2.35)) * uGridRadius;
        vec2 wxz = uGridOrigin + wOff;

        float dist = length(wxz - uCamPos.xz);
        float atten = 1.0 - smoothstep(1800.0, 9000.0, dist);
        float wy = waveDisp(wxz) * atten;

        // Damp waves cleanly in very shallow water on heightmap maps or city canal
        if (uWaterMode == 1) {
          float th = sampleHM3(wxz).x;
          float dep = max(0.0, -th);
          wy *= smoothstep(0.0, 12.0, dep);
        } else if (uWaterMode == 2) {
          wy = wy * 0.25 - 0.8;
        }

        // Subtle horizon drop at very edge
        float rNorm = length(wOff) / uGridRadius;
        if (rNorm > 0.90) wy -= (rNorm - 0.90) * 400.0;

        vWorldPos = vec3(wxz.x, wy, wxz.y);
        vWaveH = wy;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      uniform float uSeaTint;
      uniform vec3 uShalCol;
      uniform float uWaveAmp;
      uniform int uWaterMode;
      uniform float uHasUW;
      uniform vec4 uWrecks[${MAX_WRECKS}];

      varying vec3 vWorldPos;
      varying float vWaveH;

      float coastX(float z) {
        return 500.0 + 380.0 * sin(z / 2300.0) + 150.0 * sin(z / 700.0 + 1.3);
      }

      void main() {
        vec2 wxz = vWorldPos.xz;
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);

        // Compute depth depending on map type; discard where dry land rises above sea level
        float dep = 200.0;
        if (uWaterMode == 1) {
          float th = sampleTerrainH(wxz);
          dep = vWorldPos.y - th;
          if (dep < -0.15) discard;
          dep = max(0.0, dep);
        } else if (uWaterMode == 2) {
          // Dusk Metropolis winding river
          float rv = wxz.y + 1400.0 * sin(wxz.x / 2600.0);
          float rm = mod(rv, 7000.0);
          if (rm >= 260.0) discard;
          float edge = min(rm, 260.0 - rm);
          dep = min(22.0, edge * 0.45);
        } else if (uWaterMode == 3) {
          // Ashfront Coast bay
          float dx = wxz.x - coastX(wxz.y);
          if (dx <= 0.0) discard;
          float pz = mod(wxz.y, 420.0);
          if (dx < 300.0 && pz < 24.0) discard; // pier deck
          dep = min(90.0, 5.0 + dx * 0.06);
        }

        // Animated multi-band wave height + analytical perturbation normal
        vec2 wn = length(uWind) > 0.01 ? normalize(uWind) : vec2(0.89, 0.45);
        float a = dot(wxz, wn);
        float b = wxz.x * (-wn.y) + wxz.y * wn.x;
        float st_ = 0.65 + uCov * 0.35 + uStorm * 0.45;

        float ph1 = a * 0.048 - uTime * 1.4 + sin(b * 0.02) * 2.1;
        float ph2 = a * 0.095 + b * 0.032 - uTime * 2.15;
        float ph3 = b * 0.072 - a * 0.024 - uTime * 0.95;
        float wNoise = nzTex(wxz / 44.0 + wn * uTime * 0.35);
        float ripple = nzTex(wxz / 12.0 - wn * uTime * 0.7);
        float wVal = (sin(ph1) * 0.42 + sin(ph2) * 0.24 + sin(ph3) * 0.14) * 0.5 + 0.5;
        wVal = clamp(mix(wVal, wNoise, 0.28) * st_, 0.0, 1.0);

        float normFade = 1.0 - smoothstep(1400.0, 10000.0, dist);
        vec2 grad = wn * (cos(ph1) * 0.048 + cos(ph2) * 0.065)
                  + vec2(-wn.y, wn.x) * (cos(ph3) * 0.035)
                  + vec2(ripple - 0.5, wNoise - 0.5) * 0.11;
        vec3 N = normalize(vec3(-grad.x * 0.92 * normFade, 1.0, -grad.y * 0.92 * normFade));

        // Base deep ocean vs shallow lagoon water color
        vec3 deepCol = vec3(0.03, 0.13, 0.28) * (0.45 + 0.55 * uSeaTint);
        vec3 midCol  = vec3(0.05, 0.28, 0.46) * (0.45 + 0.55 * uSeaTint);
        vec3 waterCol = mix(deepCol, midCol, clamp(wVal * 0.9, 0.0, 1.0));
        waterCol = mix(waterCol, vec3(dot(waterCol, vec3(0.333))), uCov * 0.42);

        // Shallow water turquoise tint & underwater Ironclad Sound reefs/wrecks
        float fDist = clamp(dist / (uVis * 2.2), 0.0, 1.0);
        if (uHasUW > 0.5 && dep < 240.0 && fDist < 0.85) {
          float visUW = pow(max(0.0, 1.0 - dep / 240.0), 1.35) * (1.0 - fDist * 0.92);
          float n1 = nzTex(wxz / 38.0);
          float n2 = nzTex(wxz / 9.0 + vec2(50.0, -20.0));
          vec3 bed;
          if (dep < 4.0) bed = vec3(0.88, 0.82, 0.64);
          else if (dep < 18.0 && nzTex(wxz / 45.0 + vec2(9.0, 0.0)) > 0.62) {
            bed = n2 > 0.66 ? vec3(0.84, 0.45, 0.50) : (n2 > 0.40 ? vec3(0.86, 0.62, 0.38) : vec3(0.62, 0.45, 0.74));
          } else if (dep < 48.0) {
            bed = n1 > 0.62 ? vec3(0.20, 0.58, 0.34) : vec3(0.82, 0.75, 0.54);
          } else if (dep < 130.0) {
            bed = n1 > 0.66 ? vec3(0.16, 0.44, 0.26) : vec3(0.38, 0.44, 0.46);
          } else {
            bed = vec3(0.06, 0.14, 0.28);
          }
          // Sunken wrecks on the sandbank
          for (int i = 0; i < ${MAX_WRECKS}; i++) {
            vec4 wr = uWrecks[i];
            if (wr.w > 1.0) {
              vec2 d = wxz - wr.xy;
              if (abs(d.x) < wr.w && abs(d.y) < wr.w) {
                float ca = cos(wr.z), sa = sin(wr.z);
                float lx = d.x * ca + d.y * sa;
                float lz = -d.x * sa + d.y * ca;
                float hw = wr.w * 0.16 * (1.0 - pow(min(1.0, abs(lz) / wr.w), 4.0));
                if (abs(lz) < wr.w && abs(lx) < hw) bed = vec3(0.56, 0.33, 0.22);
              }
            }
          }
          // Animated shallow-water solar caustics
          if (dep < 32.0) {
            float caust = 1.0 + 0.22 * sin(wxz.x * 0.07 + uTime * 2.2) * sin(wxz.y * 0.08 - uTime * 1.8) * uSunA;
            bed *= caust;
          }
          float absK = clamp(dep / 68.0, 0.0, 0.82);
          bed = mix(bed, vec3(0.13, 0.50, 0.58), absK);
          waterCol = mix(waterCol, bed * uLightCol, visUW * 0.78);
        } else if (uWaterMode == 1 && dep < 85.0) {
          float shK = (1.0 - dep / 85.0) * 0.72 * (1.0 - fDist);
          waterCol = mix(waterCol, uShalCol * (0.6 + 0.4 * uSeaTint), shK);
        }

        // Fresnel sky reflection
        float cosV = max(0.0, dot(N, -rd));
        float fresnel = 0.04 + 0.96 * pow(1.0 - cosV, 4.2);
        vec3 reflDir = reflect(rd, N);
        vec3 reflSky = mix(uSkyHor, uSkyZen, pow(max(0.0, reflDir.y), 0.55));
        waterCol = mix(waterCol, reflSky, clamp(fresnel * 0.78, 0.0, 0.82));

        // Crisp sun specular glitter path (silky, controlled glare)
        if (uSunA > 0.15) {
          vec3 H = normalize(uSunDir - rd);
          float specBroad = pow(max(0.0, dot(N, H)), 64.0) * 0.28 * uSunA;
          float specSharp = pow(max(0.0, dot(N, H)), 380.0) * 0.95 * uSunA;
          waterCol += uGlowCol * (specBroad + specSharp);
        }

        // Animated shoreline surf foam + storm whitecaps
        float foam = 0.0;
        if (uWaterMode != 0 && dep < 10.0) {
          float waveSurf = sin(dep * 1.3 - uTime * 2.8 + wNoise * 5.0) * 0.5 + 0.5;
          float edgeFoam = (1.0 - smoothstep(0.0, 3.2, dep)) + smoothstep(0.65, 0.95, waveSurf) * (1.0 - dep / 10.0) * 0.65;
          foam = max(foam, clamp(edgeFoam, 0.0, 1.0) * (1.0 - fDist * 0.85));
        }
        float crestFoam = smoothstep(0.82 - uStorm * 0.14, 0.98, wVal) * (1.0 - fDist * 0.85) * (0.35 + uStorm * 0.55);
        foam = clamp(max(foam, crestFoam), 0.0, 1.0);
        waterCol = mix(waterCol, vec3(0.92, 0.96, 1.0) * uLightCol * (1.0 - uStorm * 0.25), foam * 0.82);

        // Hybrid ASCII wave crest / shimmer accents
        if (uAscii > 0.5) {
          float gIdx = foam > 0.28 ? 4.0 : (wVal > 0.58 ? 3.0 : 0.0);
          if (gIdx > 0.5) {
            float g = sampleGlyph(gIdx, gl_FragCoord.xy);
            float gFade = 1.0 - smoothstep(1400.0, 8200.0, dist);
            waterCol = mix(waterCol, waterCol * 1.38 + vec3(0.16, 0.20, 0.22), g * 0.42 * gFade);
          }
        }

        waterCol *= (1.0 - uStorm * 0.35);
        waterCol = applyAerialFog(waterCol, rd, dist);

        gl_FragColor = vec4(clamp(waterCol, 0.0, 1.0), 1.0);
      }
    `
  });

  let waterMesh = null;

  // ==========================================================================
  // 4. 3D INSTANCED CITIES (DUSK METROPOLIS & ASHFRONT COAST)
  // ==========================================================================
  const CITY_GROUND_UNIFORMS = Object.assign({}, SHARED, {
    uGridOrigin: { value: new THREE.Vector2(0, 0) },
    uIsCoast: { value: 0.0 },
    uHasRunway: { value: 0.0 },
    uRwCenter: { value: new THREE.Vector2(0, 0) },
    uRwDir: { value: new THREE.Vector2(0, -1) },
    uRwSize: { value: new THREE.Vector2(600, 30) }
  });

  const cityGroundMat = new THREE.ShaderMaterial({
    uniforms: CITY_GROUND_UNIFORMS,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: `
      precision highp float;
      uniform vec2 uGridOrigin;
      varying vec3 vWorldPos;
      void main() {
        vec2 uv = position.xz;
        vec2 wOff = sign(uv) * pow(abs(uv), vec2(2.1)) * 30000.0;
        vec2 wxz = uGridOrigin + wOff;
        vWorldPos = vec3(wxz.x, 0.0, wxz.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      uniform float uIsCoast;
      uniform float uHasRunway;
      uniform vec2 uRwCenter;
      uniform vec2 uRwDir;
      uniform vec2 uRwSize;
      varying vec3 vWorldPos;

      float coastX(float z) {
        return 500.0 + 380.0 * sin(z / 2300.0) + 150.0 * sin(z / 700.0 + 1.3);
      }

      void main() {
        vec2 wxz = vWorldPos.xz;
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);

        // Discard open water so the dynamic water shader renders the river & bay cleanly
        if (uIsCoast > 0.5) {
          float dx = wxz.x - coastX(wxz.y);
          if (dx > 0.0) {
            float pz = mod(wxz.y, 420.0);
            if (!(dx < 300.0 && pz < 24.0)) discard;
            // Concrete pier deck
            vec3 pier = vec3(0.32, 0.34, 0.38) * (uAmb + max(0.0, uSunDir.y) * 0.8);
            gl_FragColor = vec4(applyAerialFog(pier, rd, dist), 1.0);
            return;
          }
        } else {
          float rv = wxz.y + 1400.0 * sin(wxz.x / 2600.0);
          float rm = mod(rv, 7000.0);
          if (rm < 260.0) discard;
        }

        // Runway apron cutout
        bool onRunway = false;
        if (uHasRunway > 0.5) {
          vec2 d = wxz - uRwCenter;
          float along = abs(dot(d, uRwDir));
          float across = abs(dot(d, vec2(-uRwDir.y, uRwDir.x)));
          if (along < uRwSize.x + 260.0 && across < uRwSize.y + 90.0) onRunway = true;
        }

        float Bk = 150.0;
        vec2 blk = floor(wxz / Bk);
        vec2 loc = wxz - blk * Bk;
        bool isStreet = onRunway || loc.x < 34.0 || loc.y < 34.0 || (loc.x > 88.0 && loc.x < 95.0) || (loc.y > 88.0 && loc.y < 95.0);
        float sx = loc.x < 92.0 ? 0.0 : 1.0;
        float sz = loc.y < 92.0 ? 0.0 : 1.0;
        float hh = hash12(vec2(blk.x * 2.0 + sx, blk.y * 2.0 + sz));
        bool isPark = !isStreet && hh > 0.93;

        vec3 col;
        float glyphIdx = 0.0;
        if (onRunway) {
          col = vec3(0.24, 0.26, 0.29);
        } else if (isPark) {
          float pn = nzTex(wxz / 18.0);
          col = mix(vec3(0.14, 0.34, 0.18), vec3(0.22, 0.44, 0.24), pn);
          glyphIdx = 12.0;
        } else if (isStreet) {
          col = vec3(0.18, 0.19, 0.24);
          // Dashed road centerline markings
          float roadDash = step(0.45, fract((loc.x < 34.0 ? wxz.y : wxz.x) / 24.0));
          bool midX = abs(loc.x - 17.0) < 1.1;
          bool midZ = abs(loc.y - 17.0) < 1.1;
          if ((midX || midZ) && roadDash > 0.5) col = vec3(0.55, 0.52, 0.42);
          // Warm glowing streetlamp pools at dusk/night
          vec2 lpCell = mod(wxz, 30.0) - 15.0;
          float lamp = exp(-dot(lpCell, lpCell) / 48.0);
          col += vec3(1.0, 0.72, 0.32) * lamp * 0.42 * (1.0 - max(0.0, uSunDir.y) * 1.4);
          glyphIdx = 3.0;
        } else {
          col = vec3(0.22, 0.24, 0.30);
        }

        float sh = uAmb + (1.0 - uAmb) * max(0.0, uSunDir.y) * 1.05;
        col *= sh * uLightCol * (1.0 - uStorm * 0.35);

        if (uAscii > 0.5 && glyphIdx > 0.5) {
          float g = sampleGlyph(glyphIdx, gl_FragCoord.xy);
          float gf = 1.0 - smoothstep(1000.0, 5000.0, dist);
          col = mix(col, col * 1.3 + vec3(0.06), g * 0.24 * gf);
        }

        col = applyAerialFog(col, rd, dist);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  });

  let cityGroundMesh = null;

  // Instanced 3D City Buildings
  const CITY_BLD_UNIFORMS = Object.assign({}, SHARED, {
    uIsCoast: { value: 0.0 }
  });

  const cityBldMat = new THREE.ShaderMaterial({
    uniforms: CITY_BLD_UNIFORMS,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: `
      precision highp float;
      attribute vec4 aInfo; // x = height, y = seed, z = burnFlag, w = width
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec4 vInfo;
      varying vec3 vLocal;

      void main() {
        vLocal = position;
        vInfo = aInfo;
        vec4 wp = instanceMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        // Axis-aligned boxes: normal is unchanged by scale/translate instanceMatrix
        vNorm = normalize(normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      uniform float uIsCoast;
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec4 vInfo;
      varying vec3 vLocal;

      void main() {
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);
        vec3 N = normalize(vNorm);

        float bHeight = vInfo.x;
        float seed = vInfo.y;
        float isBurning = vInfo.z;
        bool isRoof = N.y > 0.5;

        float ndl = max(0.0, dot(N, uSunDir));
        float sh = uAmb + (1.0 - uAmb) * ndl * 1.15;

        // Facade tint varies subtly per building
        vec3 baseTint = mix(vec3(0.24, 0.27, 0.36), vec3(0.36, 0.38, 0.44), fract(seed * 13.7));
        vec3 col = baseTint * sh * uLightCol;
        float glyphIdx = 0.0;

        if (isRoof) {
          col = mix(vec3(0.30, 0.32, 0.38), vec3(0.42, 0.44, 0.50), fract(seed * 7.3)) * sh * uLightCol;
          // Rooftop perimeter lip + mechanical penthouse detail
          float edge = max(abs(vLocal.x), abs(vLocal.z));
          if (edge > 0.44) col *= 1.25;
          else if (abs(vLocal.x) < 0.22 && abs(vLocal.z) < 0.22 && seed > 0.4) col *= 0.72;
          // Red blinking aviation beacon on tall roofs
          if (bHeight > 180.0 && length(vLocal.xz) < 0.08) {
            float blink = step(0.45, fract(uRealTime * 0.8 + seed * 5.0));
            col += vec3(1.0, 0.14, 0.12) * (0.4 + 1.4 * blink);
          }
          // Ashfront Coast rooftop fire glow
          if (isBurning > 0.5) {
            float fl = 0.7 + 0.3 * sin(uRealTime * 9.0 + seed * 40.0);
            col = mix(col, vec3(1.0, 0.42, 0.12) * fl, 0.8);
          }
          glyphIdx = 10.0;
        } else {
          // Procedural multi-story glass & lit office windows
          float flr = floor(vWorldPos.y / 6.5);
          float horiz = abs(N.x) > 0.5 ? vWorldPos.z : vWorldPos.x;
          float colIdx = floor(horiz / 5.5);
          float inWinY = fract(vWorldPos.y / 6.5);
          float inWinX = fract(horiz / 5.5);
          bool winMask = inWinY > 0.25 && inWinY < 0.78 && inWinX > 0.18 && inWinX < 0.82 && vWorldPos.y > 5.0 && vWorldPos.y < bHeight - 3.0;

          if (winMask) {
            float wh = hash12(vec2(colIdx * 3.1 + flr + seed * 19.0, flr * 7.7 + colIdx));
            float duskBoost = 1.0 - clamp(uSunDir.y * 2.2, 0.0, 0.65);
            if (wh > 0.48) {
              vec3 warm = mix(vec3(1.0, 0.78, 0.38), vec3(0.68, 0.88, 1.0), step(0.84, wh));
              col = mix(col, warm * (0.65 + 0.55 * duskBoost), 0.85);
              glyphIdx = 5.0; // ':'
            } else {
              // Dark reflective glass catching sky/sunset
              vec3 refl = reflect(rd, N);
              vec3 glass = mix(uSkyHor, uSkyZen, max(0.0, refl.y)) * 0.45;
              col = mix(col, glass, 0.55);
              glyphIdx = 1.0;
            }
          }
          // Vertical edge accent for crisp architectural silhouettes
          float hEdge = abs(N.x) > 0.5 ? abs(vLocal.z) : abs(vLocal.x);
          if (hEdge > 0.46) col *= 0.75;
        }

        // Ground-level ambient occlusion near street base
        col *= (0.65 + 0.35 * smoothstep(0.0, 28.0, vWorldPos.y));

        if (uAscii > 0.5 && glyphIdx > 0.5) {
          float g = sampleGlyph(glyphIdx, gl_FragCoord.xy);
          float gf = 1.0 - smoothstep(1000.0, 4800.0, dist);
          col = mix(col, col * 1.28 + vec3(0.05), g * 0.25 * gf);
        }

        col *= (1.0 - uStorm * 0.35);
        col = applyAerialFog(col, rd, dist);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  });

  let cityBldMesh = null;
  let cityInfoAttr = null;
  let cityMaxCount = 0;
  let cityRingOffsets = [];
  let cityRingRad = -1;
  let lastCityBlockX = 1e9, lastCityBlockZ = 1e9, lastCityMap = '';
  const _m4 = new THREE.Matrix4();
  const _vPos = new THREE.Vector3();
  const _vScale = new THREE.Vector3();
  const _qId = new THREE.Quaternion();

  function getCityOffsets(rBlk) {
    if (cityRingRad === rBlk) return cityRingOffsets;
    cityRingRad = rBlk;
    const arr = [];
    const r2 = rBlk * rBlk + 4;
    for (let dz = -rBlk; dz <= rBlk; dz++) {
      for (let dx = -rBlk; dx <= rBlk; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= r2) arr.push([dx, dz, d2]);
      }
    }
    // Sort closest-first so buildings ALWAYS radiate evenly 360 deg around the camera
    arr.sort((a, b) => a[2] - b[2]);
    cityRingOffsets = arr;
    return arr;
  }

  // City draw radius follows the device / TERRAIN QUALITY setting only, NOT the adaptive
  // frame-rate governor (PQ). Buildings are 12-triangle boxes; letting PQ shrink the radius
  // made whole districts vanish every time the governor stepped (v1.0.1 fix).
  function cityRadius() {
    const q = OPT.tqual | 0;
    if (q >= 1 && q <= 4) return TIERS[q - 1].cityRad;
    if (IS_MOBILE) return TIERS[0].cityRad;
    return ((OPT.tres | 0) >= 5 ? TIERS[3] : TIERS[2]).cityRad;
  }

  // (Re)allocate the building InstancedMesh so it can hold `cap` buildings.
  function ensureCityCap(cap) {
    if (cityBldMesh && cityMaxCount >= cap) return;
    if (cityBldMesh) { ROOT.remove(cityBldMesh); cityBldMesh.geometry.dispose(); }
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    cityMaxCount = cap;
    cityInfoAttr = new THREE.InstancedBufferAttribute(new Float32Array(cityMaxCount * 4), 4);
    bGeo.setAttribute('aInfo', cityInfoAttr);
    cityBldMesh = new THREE.InstancedMesh(bGeo, cityBldMat, cityMaxCount);
    cityBldMesh.frustumCulled = false;
    cityBldMesh.renderOrder = -40;
    cityBldMesh.count = 0;
    ROOT.add(cityBldMesh);
    lastCityBlockX = 1e9;
  }

  function buildCityInstances(force) {
    if (!MAP || !MAP.city || !cityBldMesh) return;
    const Bk = 150;
    const bCx = Math.floor(C.position.x / Bk);
    const bCz = Math.floor(C.position.z / Bk);
    const rBlk = Math.ceil(cityRadius() / Bk);
    const mapKey = MAP.n + '|' + (BASE && BASE.ty === 'rw' ? Math.round(BASE.c.x) : '0') + '|' + rBlk;
    if (!force && bCx === lastCityBlockX && bCz === lastCityBlockZ && mapKey === lastCityMap) return;
    lastCityBlockX = bCx; lastCityBlockZ = bCz; lastCityMap = mapKey;

    const offsets = getCityOffsets(rBlk);
    // Every sub-block in the ring must fit, otherwise the outer ring silently drops out
    ensureCityCap(offsets.length * 4);
    const infoArr = cityInfoAttr.array;
    let count = 0;
    const isCoast = MAP.ty === 'coast';

    // Sub-block local centers & footprints matching cityH ([34..88] = 54 m, [95..150] = 55 m)
    const subX = [61, 122.5], subW = [54, 55];

    for (let oi = 0; oi < offsets.length && count < cityMaxCount; oi++) {
      const bx = bCx + offsets[oi][0];
      const bz = bCz + offsets[oi][1];
      for (let sz = 0; sz < 2 && count < cityMaxCount; sz++) {
        const wz = bz * Bk + subX[sz];
        for (let sx = 0; sx < 2 && count < cityMaxCount; sx++) {
          const wx = bx * Bk + subX[sx];
          const h = cityH(wx, wz);
          if (CTY !== 1 || h <= 2) continue;

          const w = subW[sx], d = subW[sz];
          _vPos.set(wx, h * 0.5, wz);
          _vScale.set(w, h, d);
          _m4.compose(_vPos, _qId, _vScale);
          cityBldMesh.setMatrixAt(count, _m4);

          const seed = h2i(bx * 2 + sx, bz * 2 + sz);
          const burn = (isCoast && h2i(Math.floor(wx / 23), Math.floor(wz / 23)) > 0.90) ? 1.0 : 0.0;
          const o = count * 4;
          infoArr[o] = h;
          infoArr[o + 1] = seed;
          infoArr[o + 2] = burn;
          infoArr[o + 3] = w;
          count++;
        }
      }
    }
    cityBldMesh.count = count;
    cityBldMesh.instanceMatrix.needsUpdate = true;
    cityInfoAttr.needsUpdate = true;
  }

  // ==========================================================================
  // 5. PROVING GROUND HIGH-RES 3D MESH
  // ==========================================================================
  const pgMat = new THREE.ShaderMaterial({
    uniforms: SHARED,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: `
      precision highp float;
      attribute vec3 aColor;
      attribute vec2 aFlags; // x = isConcreteGrid, y = isHazardRamp
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec3 vCol;
      varying vec2 vFlags;
      void main() {
        vWorldPos = position;
        vNorm = normal;
        vCol = aColor;
        vFlags = aFlags;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec3 vCol;
      varying vec2 vFlags;

      void main() {
        vec2 wxz = vWorldPos.xz;
        float h = vWorldPos.y;
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);
        vec3 N = normalize(vNorm);

        float ndl = max(0.0, dot(N, uSunDir));
        float sh = uAmb * 1.15 + (1.0 - uAmb) * ndl * 1.15;

        vec3 col = vCol;
        float glyphIdx = 1.0;

        if (vFlags.x > 0.5) {
          // Concrete baseplate with crisp 50 m & 200 m grid markings
          float gx = abs(mod(wxz.x, 50.0) - 25.0);
          float gz = abs(mod(wxz.y, 50.0) - 25.0);
          float bx = abs(mod(wxz.x, 200.0) - 100.0);
          float bz = abs(mod(wxz.y, 200.0) - 100.0);
          bool minor = gx > 24.2 || gz > 24.2;
          bool major = bx > 98.8 || bz > 98.8;
          vec3 gridC = major ? vec3(0.78, 0.78, 0.70) : (minor ? vec3(0.62, 0.63, 0.60) : col);
          col = mix(col, gridC, vFlags.x) * (0.94 + 0.12 * nzTex(wxz / 18.0));
          glyphIdx = minor ? 8.0 : 1.0;
        }
        if (vFlags.y > 0.5) {
          // Ramps: yellow/black chevron hazard stripes (zero bleeding into pits!)
          float stripe = step(0.5, fract((wxz.x + wxz.y * 0.6) / 10.0));
          vec3 rampC = mix(vec3(0.18, 0.18, 0.20), vec3(0.88, 0.72, 0.16), stripe);
          col = mix(col, rampC, smoothstep(0.5, 0.85, vFlags.y));
          glyphIdx = 6.0;
        }

        col *= sh * uLightCol * (1.0 - uStorm * 0.35);
        if (uAscii > 0.5 && glyphIdx > 0.5) {
          float g = sampleGlyph(glyphIdx, gl_FragCoord.xy);
          float gf = 1.0 - smoothstep(600.0, 3200.0, dist);
          col = mix(col, col * 1.32 + vec3(0.06), g * 0.30 * gf);
        }
        col = applyAerialFog(col, rd, dist);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  });

  let pgMesh = null;

  // Infinite camera-centered radial-LOD hills surrounding Proving Ground (exact pgTerr match for r > 2200)
  const PG_FAR_UNIFORMS = Object.assign({}, SHARED, {
    uGridOrigin: { value: new THREE.Vector2(0, 0) },
    uGridRadius: { value: 28000.0 }
  });

  const pgFarMat = new THREE.ShaderMaterial({
    uniforms: PG_FAR_UNIFORMS,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: `
      precision highp float;
      uniform vec2 uGridOrigin;
      uniform float uGridRadius;
      varying vec3 vWorldPos;
      varying float vR;

      float pgFarH(vec2 p) {
        float r = length(p);
        float k = smoothstep(2200.0, 3200.0, r);
        return k * (230.0 + 40.0 * sin(p.x * 0.004) * cos(p.y * 0.005) + 18.0 * sin(p.x * 0.013 + p.y * 0.009));
      }

      void main() {
        vec2 uv = position.xz;
        vec2 wOff = sign(uv) * pow(abs(uv), vec2(2.25)) * uGridRadius;
        vec2 wxz = uGridOrigin + wOff;
        float r = length(wxz);
        float h = pgFarH(wxz);
        // Recess slightly inside the static baseplate radius so pgMesh sits cleanly on top with zero seam
        if (r < 2500.0) h -= 0.6;
        vWorldPos = vec3(wxz.x, h, wxz.y);
        vR = r;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      varying vec3 vWorldPos;
      varying float vR;

      float pgFarH(vec2 p) {
        float r = length(p);
        float k = smoothstep(2200.0, 3200.0, r);
        return k * (230.0 + 40.0 * sin(p.x * 0.004) * cos(p.y * 0.005) + 18.0 * sin(p.x * 0.013 + p.y * 0.009));
      }

      void main() {
        if (vR < 2180.0) discard;
        vec2 wxz = vWorldPos.xz;
        float h = vWorldPos.y;
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);

        float e = clamp(dist * 0.01, 10.0, 40.0);
        float hx = pgFarH(wxz + vec2(e, 0.0)) - pgFarH(wxz - vec2(e, 0.0));
        float hz = pgFarH(wxz + vec2(0.0, e)) - pgFarH(wxz - vec2(0.0, e));
        vec3 N = normalize(vec3(-hx, 2.0 * e, -hz));

        float pN = fbm2(wxz / 160.0);
        vec3 grass = mix(vec3(0.20, 0.44, 0.22), vec3(0.30, 0.50, 0.24), pN);
        vec3 ridge = vec3(0.38, 0.42, 0.34);
        vec3 col = mix(grass, ridge, smoothstep(140.0, 230.0, h));

        float ndl = max(0.0, dot(N, uSunDir));
        float cel = mix(ndl, floor(ndl * 4.0 + 0.35) / 4.0, 0.28);
        vec3 skyBounce = mix(uSkyHor * 0.90, uSkyZen * 0.95, max(0.0, N.y)) * (uAmb * 1.25);
        col = col * (skyBounce + uLightCol * cel * 1.22);

        if (uAscii > 0.5) {
          float gIdx = h > 165.0 ? 9.0 : 12.0;
          float g = sampleGlyph(gIdx, gl_FragCoord.xy);
          float gf = 1.0 - smoothstep(2500.0, 9500.0, dist);
          col = mix(col, col * 1.4 + vec3(0.08), g * 0.38 * gf);
        }
        col *= (1.0 - uStorm * 0.35);
        col = applyAerialFog(col, rd, dist);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  });

  let pgFarMesh = null;

  function buildProvingGroundMesh() {
    if (pgMesh) { ROOT.remove(pgMesh); pgMesh.geometry.dispose(); pgMesh = null; }
    if (typeof pgTerr !== 'function') return;

    const patches = [
      { x0: -460, x1: 560, z0: -840, z1: -50, nx: 170, nz: 140, skipInner: false },
      { x0: -4600, x1: 4600, z0: -4600, z1: 4600, nx: 110, nz: 110, skipInner: true }
    ];

    const posArr = [], nrmArr = [], colArr = [], flgArr = [], idxArr = [];
    let vOff = 0;

    for (const P_ of patches) {
      const cols = P_.nx + 1, rows = P_.nz + 1;
      for (let j = 0; j < rows; j++) {
        const z = P_.z0 + (P_.z1 - P_.z0) * (j / P_.nz);
        for (let i = 0; i < cols; i++) {
          const x = P_.x0 + (P_.x1 - P_.x0) * (i / P_.nx);
          let h = pgTerr(x, z);
          if (P_.skipInner && x > -480 && x < 580 && z > -860 && z < -30) h -= 0.12;
          const k = typeof PGK !== 'undefined' ? PGK : 0;
          const e = 3.0;
          const hx = pgTerr(x + e, z) - pgTerr(x - e, z);
          const hz = pgTerr(x, z + e) - pgTerr(x, z - e);
          const l = Math.hypot(hx, 2 * e, hz) || 1;
          posArr.push(x, h, z);
          nrmArr.push(-hx / l, (2 * e) / l, -hz / l);

          let r = 0.50, g = 0.51, b = 0.49;
          if (k === 7) { r = 0.80; g = 0.38; b = 0.16; }
          else if (k === 2) { r = h < -4 ? 0.30 : 0.43; g = h < -4 ? 0.25 : 0.38; b = h < -4 ? 0.21 : 0.31; }
          else if (k === 3) { r = 0.35; g = 0.32; b = 0.27; }
          else if (k === 4) { r = 0.50; g = 0.45; b = 0.36; }
          else if (k === 6) { r = 0.62; g = 0.53; b = 0.37; }
          else if (k === 5) {
            const hi = cl((h - 110) / 60, 0, 1);
            r = lp(0.24, 0.40, hi); g = lp(0.47, 0.43, hi); b = lp(0.26, 0.37, hi);
          }
          colArr.push(r, g, b);
          flgArr.push(k === 0 ? 1.0 : 0.0, k === 1 ? 1.0 : 0.0);
        }
      }
      for (let j = 0; j < P_.nz; j++) {
        const za = P_.z0 + (P_.z1 - P_.z0) * (j / P_.nz);
        const zb = P_.z0 + (P_.z1 - P_.z0) * ((j + 1) / P_.nz);
        for (let i = 0; i < P_.nx; i++) {
          if (P_.skipInner) {
            const xa = P_.x0 + (P_.x1 - P_.x0) * (i / P_.nx);
            const xb = P_.x0 + (P_.x1 - P_.x0) * ((i + 1) / P_.nx);
            if (xa > -445 && xb < 545 && za > -825 && zb < -65) continue;
          }
          const a = vOff + j * cols + i, b = a + 1, c = a + cols, d = c + 1;
          idxArr.push(a, c, b, b, c, d);
        }
      }
      vOff += cols * rows;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrmArr, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colArr, 3));
    geo.setAttribute('aFlags', new THREE.Float32BufferAttribute(flgArr, 2));
    geo.setIndex(idxArr);
    pgMesh = new THREE.Mesh(geo, pgMat);
    pgMesh.frustumCulled = false;
    pgMesh.renderOrder = -45;
    pgMesh.visible = false;
    ROOT.add(pgMesh);
    pgDirty = 0;
  }

  // ==========================================================================
  // 6. 3D INSTANCED NEAR-FIELD VEGETATION (REPLACES 2D #fx SPRITES IN GPU MODE)
  // ==========================================================================
  // Stylized low-poly canopy + trunk geometry with vertex color mask (trunk vs foliage)
  function buildVegPrototypeGeo() {
    const pos = [], nrm = [], part = [];
    const pushTri = (a, b, c, pVal) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      pos.push(...a, ...b, ...c);
      nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      part.push(pVal, pVal, pVal);
    };
    const addCone = (r0, r1, y0, y1, seg, pVal) => {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const p00 = [c0 * r0, y0, s0 * r0], p10 = [c1 * r0, y0, s1 * r0];
        const p01 = [c0 * r1, y1, s0 * r1], p11 = [c1 * r1, y1, s1 * r1];
        pushTri(p00, p01, p10, pVal);
        if (r1 > 0.001) pushTri(p10, p01, p11, pVal);
      }
    };
    // Trunk (part = 0)
    addCone(0.45, 0.28, 0.0, 3.2, 5, 0.0);
    // Two stylized foliage tiers (part = 1)
    addCone(2.8, 0.9, 2.4, 6.2, 6, 1.0);
    addCone(2.1, 0.0, 5.0, 9.2, 6, 1.0);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
    return geo;
  }

  const vegMat = new THREE.ShaderMaterial({
    uniforms: SHARED,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: `
      precision highp float;
      ${GLSL_VERT_COMMON}
      attribute float aPart;
      attribute vec4 aCol; // rgb = foliage color, a = phase/sway
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec3 vCol;
      varying float vPart;

      void main() {
        vec3 lp = position;
        // Wind sway scaled by height above base
        float sway = sin(uRealTime * 1.9 + aCol.a) * (0.14 + length(uWind) * 0.025) * max(0.0, lp.y / 9.0);
        lp.x += sway;
        lp.z += sway * 0.45;
        vec4 wp = instanceMatrix * vec4(lp, 1.0);
        vWorldPos = wp.xyz;
        vNorm = normalize(mat3(instanceMatrix) * normal);
        vCol = aCol.rgb;
        vPart = aPart;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON}
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec3 vCol;
      varying float vPart;

      void main() {
        vec3 toCam = vWorldPos - uCamPos;
        float dist = length(toCam);
        vec3 rd = toCam / max(dist, 0.001);
        vec3 N = normalize(vNorm);

        vec3 base = vPart < 0.5 ? vec3(0.36, 0.25, 0.15) : vCol;
        float ndl = max(0.0, dot(N, uSunDir));
        float cel = mix(ndl, floor(ndl * 3.0 + 0.4) / 3.0, 0.35);
        vec3 col = base * (uAmb * 0.9 + (1.0 - uAmb) * cel * 1.15) * uLightCol;
        col *= (1.0 - uStorm * 0.35);
        col = applyAerialFog(col, rd, dist);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  });

  let vegMesh = null;
  let vegColAttr = null;
  let vegMaxCount = 0;
  let lastVegX = 1e9, lastVegZ = 1e9, lastVegMap = '';

  const VEG_RGB = {
    pine:   [0.14, 0.36, 0.22],
    snow:   [0.78, 0.86, 0.90],
    tree:   [0.20, 0.48, 0.22],
    bush:   [0.24, 0.50, 0.20],
    palm:   [0.22, 0.56, 0.24],
    cactus: [0.30, 0.52, 0.24],
    rock:   [0.46, 0.44, 0.42],
    grass:  [0.42, 0.54, 0.24],
    reed:   [0.34, 0.48, 0.24]
  };

  function updateVegInstances(force) {
    if (!vegMesh || !MAP) return;
    if (OPT.envd || MAP.city || MAP.pg || MAP.ty === 'sea' || MAP.space) {
      vegMesh.visible = false;
      return;
    }
    const cx = C.position.x, cz = C.position.z;
    const agl = C.position.y - Math.max(0, terr(cx, cz));
    if (agl > 900) {
      vegMesh.visible = false;
      return;
    }
    vegMesh.visible = true;
    if (!force && Math.hypot(cx - lastVegX, cz - lastVegZ) < 65 && lastVegMap === MAP.n) return;
    lastVegX = cx; lastVegZ = cz; lastVegMap = MAP.n;

    const bio = typeof vegBiome === 'function' ? vegBiome() : null;
    if (!bio) { vegMesh.count = 0; return; }

    const tier = TIERS[curTierIdx] || TIERS[2];
    const R_ = tier.vegRad * (typeof VEHM !== 'undefined' && VEHM ? 0.9 : 1.0);
    const G = 26;
    const i0 = Math.floor((cx - R_) / G), i1 = Math.floor((cx + R_) / G);
    const j0 = Math.floor((cz - R_) / G), j1 = Math.floor((cz + R_) / G);
    const colArr = vegColAttr.array;
    const qRot = new THREE.Quaternion();
    let count = 0;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (count >= vegMaxCount) break;
        const r = VH(i, j, 7);
        let acc = 0, m = null;
        for (const [k, p] of bio) { acc += p; if (r < acc) { m = k; break; } }
        if (!m || m === 'grass') continue; // dense tiny grass handled by terrain shader
        const x = (i + VH(i, j, 3)) * G;
        const z = (j + VH(i, j, 5)) * G;
        if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R_ * R_) continue;
        const h = terr(x, z);
        if (h < 3.5) continue;
        const sl = Math.abs(terr(x + 8, z) - h) + Math.abs(terr(x, z + 8) - h);
        if (sl > 9 && m !== 'rock') m = 'rock';
        if (m === 'palm' && h > 70) m = 'bush';

        const sc = 0.75 + VH(i, j, 11) * 0.75;
        const sy = m === 'rock' ? sc * 0.35 : m === 'bush' ? sc * 0.45 : m === 'cactus' ? sc * 0.65 : sc;
        const sx = m === 'cactus' ? sc * 0.35 : m === 'rock' ? sc * 0.85 : sc;
        _vPos.set(x, h - 0.3, z);
        _vScale.set(sx, sy, sx);
        qRot.setFromAxisAngle(YU, VH(i, j, 13) * Math.PI * 2);
        _m4.compose(_vPos, qRot, _vScale);
        vegMesh.setMatrixAt(count, _m4);

        const rgb = VEG_RGB[m] || VEG_RGB.tree;
        const tint = 0.85 + VH(i, j, 17) * 0.30;
        const o = count * 4;
        colArr[o] = rgb[0] * tint;
        colArr[o + 1] = rgb[1] * tint;
        colArr[o + 2] = rgb[2] * tint;
        colArr[o + 3] = VH(i, j, 19) * Math.PI * 2;
        count++;
      }
    }
    vegMesh.count = count;
    vegMesh.instanceMatrix.needsUpdate = true;
    vegColAttr.needsUpdate = true;
  }

  // ==========================================================================
  // 7. TIER BUILD / REBUILD (DYNAMIC QUALITY SCALING)
  // ==========================================================================
  function rebuildTier(idx) {
    if (idx === curTierIdx) return;
    curTierIdx = idx;
    const T = TIERS[idx];

    const clipHalfM = [24, 32, 40, 48][idx] || 40;
    if (terrMesh) { ROOT.remove(terrMesh); terrMesh.geometry.dispose(); }
    terrMesh = new THREE.Mesh(buildClipmapGeometry(clipHalfM, 6), terrMat);
    terrMesh.frustumCulled = false;
    terrMesh.renderOrder = -50;
    ROOT.add(terrMesh);
    TERR_UNIFORMS.uHalfM.value = clipHalfM;

    if (waterMesh) { ROOT.remove(waterMesh); waterMesh.geometry.dispose(); }
    waterMesh = new THREE.Mesh(buildRadialGridGeometry(T.wSeg), waterMat);
    waterMesh.frustumCulled = false;
    waterMesh.renderOrder = -20;
    ROOT.add(waterMesh);

    if (cityGroundMesh) { ROOT.remove(cityGroundMesh); cityGroundMesh.geometry.dispose(); }
    cityGroundMesh = new THREE.Mesh(buildRadialGridGeometry(Math.max(48, Math.floor(T.wSeg * 0.7))), cityGroundMat);
    cityGroundMesh.frustumCulled = false;
    cityGroundMesh.renderOrder = -48;
    ROOT.add(cityGroundMesh);

    // City buildings are NOT rebuilt per tier any more (see cityRadius / ensureCityCap);
    // they keep their buffer across tier changes so nothing blinks out.
    ensureCityCap(T.cityMax);

    if (vegMesh) { ROOT.remove(vegMesh); vegMesh.geometry.dispose(); }
    const vGeo = buildVegPrototypeGeo();
    vegMaxCount = T.vegMax;
    vegColAttr = new THREE.InstancedBufferAttribute(new Float32Array(vegMaxCount * 4), 4);
    vGeo.setAttribute('aCol', vegColAttr);
    vegMesh = new THREE.InstancedMesh(vGeo, vegMat, vegMaxCount);
    vegMesh.frustumCulled = false;
    vegMesh.renderOrder = -35;
    vegMesh.count = 0;
    ROOT.add(vegMesh);
    lastVegX = 1e9;

    if (pgFarMesh) { ROOT.remove(pgFarMesh); pgFarMesh.geometry.dispose(); }
    pgFarMesh = new THREE.Mesh(buildRadialGridGeometry(T.wSeg), pgFarMat);
    pgFarMesh.frustumCulled = false;
    pgFarMesh.renderOrder = -46;
    pgFarMesh.visible = false;
    ROOT.add(pgFarMesh);

    TERR_UNIFORMS.uGridRadius.value = T.drawDist;
    WATER_UNIFORMS.uGridRadius.value = T.drawDist + 1000;
    PG_FAR_UNIFORMS.uGridRadius.value = T.drawDist;
    SKY_UNIFORMS.uCloudSteps.value = T.cSteps;
  }

  // ==========================================================================
  // 8. PER-FRAME SYNC & CAMERA FAR PLANE MANAGEMENT
  // ==========================================================================
  // Tier hysteresis: the game's adaptive governor can flip PQ every ~12 s on a machine
  // hovering near 60 FPS. Rebuilding every terrain mesh on each flip caused hitches and
  // popping, so a new AUTO tier must hold for a few seconds first (manual picks apply at once).
  let tierWant = -1, tierSince = 0;
  function syncFrame() {
    const tierIdx = pickTierIndex();
    if (tierIdx !== curTierIdx) {
      const now = performance.now();
      if (tierIdx !== tierWant) { tierWant = tierIdx; tierSince = now; }
      const manual = (OPT.tqual | 0) >= 1;
      const hold = tierIdx < curTierIdx ? 4000 : 15000; // step down soon, step up only when clearly stable
      if (curTierIdx < 0 || manual || now - tierSince > hold) rebuildTier(tierIdx);
    } else tierWant = -1;

    const sunKey = SUN.x.toFixed(2) + ',' + SUN.y.toFixed(2) + ',' + SUN.z.toFixed(2);
    if (hmDirty || sunKey !== lastSunKey) bakeHeightmapTexture();
    if (MAP && MAP.pg && (pgDirty || !pgMesh)) buildProvingGroundMesh();

    // Expand Three.js camera far plane & radial grid with altitude so terrain never disappears when flying far or high
    const T = TIERS[curTierIdx] || TIERS[2];
    const dynRad = Math.min(72000, Math.max(T.drawDist, C.position.y * 3.8 + 16000));
    const isVeh = typeof VEHM !== 'undefined' && !!VEHM;
    const wantNear = isVeh ? 0.5 : 1.0;
    const wantFar = Math.min(260000, Math.max(38000, dynRad * 1.45, C.position.y * 2.4 + 22000));
    if (Math.abs(C.far - wantFar) > 500 || Math.abs(C.near - wantNear) > 0.05) {
      C.near = wantNear;
      C.far = wantFar;
      C.updateProjectionMatrix();
    }

    // Center sky dome on camera inside the far plane
    skyMesh.position.copy(C.position);
    skyMesh.scale.setScalar(C.far * 0.85);

    // Compute sky & weather uniforms matching ASKIIES's exact palette
    const baseVis = cl(6000 - cov * 2600 - rain * 1800 - storm * 800, 700, 6000);
    const vis = baseVis + cl((C.position.y - 1200) * 1.6, 0, 12000) * (1 - cov * 0.7);
    const k = 1 - storm * 0.5, gs = cov * 0.6;
    const grey = c => {
      const l = (c[0] + c[1] + c[2]) / 3;
      return [lp(c[0], l, gs) * k / 255, lp(c[1], l, gs) * k / 255, lp(c[2], l, gs) * k / 255];
    };
    const ho = grey(h2r(...SKY.hor));
    const ze = grey(h2r(...SKY.zen));
    const hz_ = hzRGB();

    SHARED.uCamPos.value.copy(C.position);
    SHARED.uSunDir.value.copy(SUN).normalize();
    SHARED.uSkyHor.value.set(ho[0], ho[1], ho[2]);
    SHARED.uSkyZen.value.set(ze[0], ze[1], ze[2]);
    SHARED.uHazeCol.value.set(hz_[0] / 255, hz_[1] / 255, hz_[2] / 255);
    SHARED.uGlowCol.value.set(SKY.glow[0] / 255, SKY.glow[1] / 255, SKY.glow[2] / 255);
    SHARED.uLightCol.value.set(SKY.lc[0], SKY.lc[1], SKY.lc[2]);
    SHARED.uWind.value.set(wind.x, wind.z);
    SHARED.uTime.value = t;
    SHARED.uRealTime.value = rt;
    SHARED.uVis.value = vis;
    SHARED.uCov.value = cov;
    SHARED.uRain.value = rain;
    SHARED.uStorm.value = storm;
    SHARED.uSunA.value = 1 - cov * 0.9;
    SHARED.uAmb.value = SKY.ai;
    SHARED.uAscii.value = asciiStrength();
    SHARED.uMicro.value = (OPT.terr2 === 0 || !TPR) ? 0.0 : (TPR.micro || 0.0);
    SHARED.uSpaceK.value = (typeof planetK === 'function') ? planetK(C.position.y) : smo(20000, 70000, C.position.y);
    SHARED.uInCloud.value = inC ? 1.0 : 0.0;
    SHARED.uBolt.value = bolt ? 1.0 : 0.0;
    // Scale ASCII cell size relative to actual WebGL canvas height H so glyphs stay crisp from 360p to 4K
    SHARED.uDpr.value = Math.max(1.0, Math.round((typeof H !== 'undefined' ? H : 360) / 420));

    // Sky/cloud specific uniforms
    SKY_UNIFORMS.uStars.value = SKY.stars ? 1.0 : 0.0;
    SKY_UNIFORMS.uIsSpaceMap.value = (MAP && MAP.space) ? 1.0 : 0.0;
    if (SL && SL.length >= 2) {
      SKY_UNIFORMS.uCloudA.value.set(SL[0][0], SL[0][1]);
      SKY_UNIFORMS.uCloudB.value.set(SL[1][0], SL[1][1]);
    }
    if (typeof TYPH !== 'undefined' && TYPH) {
      SKY_UNIFORMS.uTyph.value.set(TYPH.x, TYPH.z, TYPH.R, TYPH.sp || 0);
    } else {
      SKY_UNIFORMS.uTyph.value.set(0, 0, 0, 0);
    }

    const spK = SHARED.uSpaceK.value;
    const inSpace = (MAP && MAP.space && spK > 0.98) || spK >= 0.995;

    // Snap radial-LOD origin to coarse world increments to stop vertex swimming
    const snap = Math.max(8, Math.min(80, Math.pow(2, Math.floor(Math.log2(Math.max(8, C.position.y * 0.04))))));
    const gx = Math.round(C.position.x / snap) * snap;
    const gz = Math.round(C.position.z / snap) * snap;

    // 1. Heightmap terrain visibility & uniforms (world-snapped nested clipmap)
    const showHM = !inSpace && MAP && !MAP.city && !MAP.pg && MAP.ty !== 'sea' && !MAP.space;
    terrMesh.visible = !!showHM;
    if (showHM) {
      // Scale base ring step only in exact powers of 2 at high altitude so world lattice never shifts!
      const baseStep = C.position.y > 7500 ? 80.0 : (C.position.y > 3400 ? 40.0 : 20.0);
      TERR_UNIFORMS.uBaseStep.value = baseStep;
      TERR_UNIFORMS.uGridOrigin.value.set(gx, gz);
      TERR_UNIFORMS.uGridRadius.value = dynRad;
      TERR_UNIFORMS.uBiome.value = getBiomeId();
      TERR_UNIFORMS.uMaxH.value = (TPR && TPR.max) || MAP.max || 1200;
      TERR_UNIFORMS.uSnow.value = (TPR && TPR.snow) ? 1.0 : 0.0;
      TERR_UNIFORMS.uHasVolcano.value = (MAP.hm === 'open' && typeof OW !== 'undefined') ? 1.0 : 0.0;
      if (MAP.hm === 'open' && typeof OW !== 'undefined') {
        TERR_UNIFORMS.uVolcano.value.set(OW.vol.x, OW.vol.z);
      }
    }

    // 2. Water visibility & uniforms
    const showWater = !inSpace && MAP && MAP.water && !MAP.space;
    waterMesh.visible = !!showWater;
    if (showWater) {
      WATER_UNIFORMS.uGridOrigin.value.set(gx, gz);
      WATER_UNIFORMS.uGridRadius.value = dynRad + 1000;
      WATER_UNIFORMS.uSeaTint.value = SKY.sea;
      const shC = MAP.ty === 'archi' ? [60, 205, 196] : MAP.ty === 'fjord' ? [40, 66, 78] : [30, 50, 76];
      WATER_UNIFORMS.uShalCol.value.set(shC[0] / 255, shC[1] / 255, shC[2] / 255);
      WATER_UNIFORMS.uWaveAmp.value = (0.55 + wx * 0.65) * (MAP.ty === 'sea' ? 1.45 : 0.85);
      WATER_UNIFORMS.uWaterMode.value = MAP.ty === 'sea' ? 0 : MAP.ty === 'coast' ? 3 : MAP.city ? 2 : 1;
      WATER_UNIFORMS.uHasUW.value = MAP.uw ? 1.0 : 0.0;
      if (MAP.uw && typeof SOUND !== 'undefined' && SOUND.wr) {
        for (let i = 0; i < MAX_WRECKS; i++) {
          const w = SOUND.wr[i];
          if (w) wreckArr[i].set(w.x, w.z, w.a, w.l);
          else wreckArr[i].set(0, 0, 0, 0);
        }
      }
    }

    // 3. City visibility & instancing
    const showCity = !inSpace && MAP && !!MAP.city;
    cityGroundMesh.visible = !!showCity;
    cityBldMesh.visible = !!showCity;
    if (showCity) {
      CITY_GROUND_UNIFORMS.uGridOrigin.value.set(gx, gz);
      CITY_GROUND_UNIFORMS.uIsCoast.value = MAP.ty === 'coast' ? 1.0 : 0.0;
      CITY_BLD_UNIFORMS.uIsCoast.value = MAP.ty === 'coast' ? 1.0 : 0.0;
      if (typeof BASE !== 'undefined' && BASE && BASE.ty === 'rw') {
        CITY_GROUND_UNIFORMS.uHasRunway.value = 1.0;
        CITY_GROUND_UNIFORMS.uRwCenter.value.set(BASE.c.x, BASE.c.z);
        CITY_GROUND_UNIFORMS.uRwDir.value.set(BASE.d.x, BASE.d.z);
        CITY_GROUND_UNIFORMS.uRwSize.value.set(BASE.L, BASE.W);
      } else {
        CITY_GROUND_UNIFORMS.uHasRunway.value = 0.0;
      }
      buildCityInstances(false);
    }

    // 4. Proving Ground (inner high-res test zone + infinite camera-centered perimeter hills)
    const showPG = !inSpace && !!(MAP && MAP.pg);
    if (pgMesh) pgMesh.visible = showPG;
    if (pgFarMesh) {
      pgFarMesh.visible = showPG;
      if (showPG) {
        PG_FAR_UNIFORMS.uGridOrigin.value.set(gx, gz);
        PG_FAR_UNIFORMS.uGridRadius.value = dynRad;
      }
    }

    // 5. 3D Instanced Vegetation
    if (!inSpace && showHM) updateVegInstances(false);
    else if (vegMesh) vegMesh.visible = false;
  }

  // ==========================================================================
  // 9. HOOKS INTO ASKIIES (ZERO CORE MODIFICATION, FULL FALLBACK SAFETY)
  // ==========================================================================

  // Mark heightmap dirty whenever terrain data is generated or modified
  const wrapDirty = (getFn, setFn) => {
    const orig = getFn();
    if (typeof orig !== 'function') return;
    setFn(function () {
      const r = orig.apply(this, arguments);
      hmDirty = 1;
      lastVegMap = '';
      lastCityMap = '';
      return r;
    });
  };
  wrapDirty(() => setMap, f => { setMap = f; });
  wrapDirty(() => genHM, f => { genHM = f; });
  if (typeof flatten === 'function') wrapDirty(() => flatten, f => { flatten = f; });
  if (typeof hmSmooth === 'function') wrapDirty(() => hmSmooth, f => { hmSmooth = f; });
  if (typeof trnBuild === 'function') wrapDirty(() => trnBuild, f => { trnBuild = f; });

  // Track genPhoto so update-log photos also render cleanly with GPU terrain
  let inPhoto = 0;
  if (typeof genPhoto === 'function') {
    const origGenPhoto = genPhoto;
    genPhoto = function () {
      inPhoto++;
      try { return origGenPhoto.apply(this, arguments); }
      finally {
        inPhoto--;
        if (!inPhoto && st === 0) {
          ROOT.visible = false;
          cvBG.style.visibility = '';
          bgCleared = 0;
        }
      }
    };
  }

  // Hook drawBG: replace CPU raymarch with GPU sync when active; keep hangar/classic untouched
  const origDrawBG = drawBG;
  drawBG = function () {
    const active = isGpuActive() && (st !== 0 || !!window.PHSP || inPhoto > 0);
    if (!active) {
      ROOT.visible = false;
      if (cvBG.style.visibility === 'hidden') cvBG.style.visibility = '';
      bgCleared = 0;
      if (C.far > 5001) { C.near = 0.5; C.far = 5000; C.updateProjectionMatrix(); }
      return origDrawBG.apply(this, arguments);
    }
    try {
      ROOT.visible = true;
      // Clear #bg transparently once so pfxBlit (heat haze/shockwaves) and genPhoto composite cleanly
      if (!bgCleared || window.PHSP || inPhoto > 0) {
        B.clearRect(0, 0, TW, TH);
        bgCleared = 1;
      }
      if (!window.PHSP && !inPhoto && cvBG.style.visibility !== 'hidden') cvBG.style.visibility = 'hidden';
      syncFrame();
    } catch (e) {
      console.error('[terrain-engine] GPU terrain error, falling back to CLASSIC ASCII:', e);
      gpuFailed = true;
      ROOT.visible = false;
      cvBG.style.visibility = '';
      return origDrawBG.apply(this, arguments);
    }
  };

  // Restore #bg canvas visibility when returning to Hangar (drawHangar)
  if (typeof drawHangar === 'function') {
    const origDrawHangar = drawHangar;
    drawHangar = function () {
      ROOT.visible = false;
      cvBG.style.visibility = '';
      bgCleared = 0;
      return origDrawHangar.apply(this, arguments);
    };
  }

  // Suppress redundant 2D #fx vegetation sprites when 3D instanced vegetation is active
  if (typeof vegDraw === 'function') {
    const origVegDraw = vegDraw;
    vegDraw = function () {
      if (isGpuActive() && (st === 1 || st === 4)) return;
      return origVegDraw.apply(this, arguments);
    };
  }

  // Keep OBJECT PIXELS (OPT.ores) working directly & independently of TERRAIN PIXELS (OPT.tres)
  if (typeof rs === 'function') {
    const origRs = rs;
    rs = function () {
      const r = origRs.apply(this, arguments);
      bgCleared = 0;
      return r;
    };
  }
  if (typeof chg === 'function') {
    const origChg = chg;
    chg = function (k, d) {
      const r = origChg.apply(this, arguments);
      if (k === 'tmode' || k === 'tqual') { curTierIdx = -1; bgCleared = 0; rs(); }
      return r;
    };
  }

  // Validate shaders eagerly with a hidden warm-up compile so broken WebGL drivers fall back immediately
  try {
    const testCam = new THREE.PerspectiveCamera(60, 1, 1, 20000);
    rebuildTier(pickTierIndex());
    bakeHeightmapTexture();
    ROOT.visible = true;
    R.compile(S, testCam);
    ROOT.visible = false;
  } catch (e) {
    console.warn('[terrain-engine] Shader warm-up failed, using CLASSIC ASCII:', e);
    gpuFailed = true;
    ROOT.visible = false;
  }

  // ---------- Options Menu Rows ----------
  try {
    const rows = PAGES && PAGES.opt && PAGES.opt.rows;
    if (Array.isArray(rows) && !rows.some(r => r.k === 'tmode')) {
      const idx = Math.max(1, rows.findIndex(r => r.k === 'tres'));
      rows.splice(idx, 0,
        {
          l: 'TERRAIN ENGINE',
          k: 'tmode',
          d: 'HYBRID 3D+ASCII: GPU 3D terrain, cast shadows, reflections, real Z-occlusion & ASCII overlay. STYLIZED 3D: clean cel-shaded 3D. CLASSIC ASCII: original CPU renderer.'
        },
        {
          l: 'TERRAIN QUALITY',
          k: 'tqual',
          d: 'GPU terrain mesh density, cloud steps & city draw distance. AUTO scales cleanly for phones, laptops and desktops.'
        }
      );
    }
  } catch (e) {
    console.warn('[terrain-engine] Could not inject options rows:', e);
  }

  // Re-run rs() immediately when user toggles TERRAIN ENGINE or TERRAIN QUALITY in Options
  if (typeof chg === 'function') {
    const origChg = chg;
    chg = function (k, d) {
      const r = origChg.apply(this, arguments);
      if (k === 'tmode' || k === 'tqual') {
        if (k === 'tqual') curTierIdx = -1;
        try { rs(); } catch (e) {}
      }
      return r;
    };
  }

  // Expose debug/inspection handle on window
  window.ASKIIES_TERRAIN = {
    version: '1.0.1',
    isActive: isGpuActive,
    getTier: () => curTierIdx,
    setMode: m => { OPT.tmode = m | 0; save(); },
    setQuality: q => { OPT.tqual = q | 0; curTierIdx = -1; save(); },
    rebake: () => { hmDirty = 1; pgDirty = 1; lastCityBlockX = 1e9; lastVegX = 1e9; }
  };

  console.log('[terrain-engine] GPU Hybrid 3D+ASCII terrain ready (tier ' + curTierIdx + ', mobile=' + IS_MOBILE + ')');
})();

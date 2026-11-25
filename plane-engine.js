// ============================================================================
// ASKIIES NEXT-GEN AIRCRAFT ENGINE (next-gen 3D models, real rails, mouse aim)
// Drop-in external module:
//  - Smooth crease-angle normal shading (sleek fuselages & canopies, sharp fins)
//  - PBR-inspired metallic/clearcoat shader with object-space panel lines, rivets,
//    leading-edge wear, exhaust soot, and glossy reflective canopy glass
//  - Volumetric animated Mach-diamond afterburner shader (soft Fresnel edges)
//  - Additive glowing wingtip nav & anti-collision strobe light sprites
//  - Tapered wingtip vortex ribbons & next-gen battle-damage smoke/fire
//  - Toggleable in OPTIONS: NEXT-GEN 3D / HYBRID OUTLINED / CLASSIC CEL
// ============================================================================
(function () {
  'use strict';

  if (typeof THREE === 'undefined' || typeof CELU === 'undefined' || typeof mkMesh !== 'function' || typeof buildJet !== 'function') {
    console.warn('[plane-engine] ASKIIES globals not found; skipping aircraft upgrade.');
    return;
  }

  // ---------- Options ----------
  // OPT.pmode: 0 = STYLIZED CEL 3D (default: bold ink outlines + punchy cel bands + panel lines + Mach-diamond AB)
  //            1 = REALISTIC 3D (smooth PBR, no outlines)
  //            2 = CLASSIC CEL (original ASKIIES cel shader)
  if (OPT.pmode == null) OPT.pmode = 0;
  LISTS.pmode = () => ['NEXT-GEN CEL 3D', 'NEXT-GEN REALISTIC 3D', 'CLASSIC CEL'];

  const WTU = {
    uWtMode: { value: 0.0 },    // 0 = Stylized Cel 3D, 1 = Realistic 3D (no outlines), 2 = Classic Cel
    uWtTime: { value: 0.0 }
  };

  function syncModeUniforms() {
    const m = OPT.pmode | 0;
    WTU.uWtMode.value = m;
    // Keep bold black ink outlines ON in Stylized Cel 3D (0) and Classic Cel (2); hide in Realistic 3D (1)
    if (typeof ink !== 'undefined' && ink) {
      ink.visible = (m !== 1);
      if (m === 0) ink.color.setHex(0x060810);
      else if (m === 2) ink.color.setHex(0x05060f);
    }
    if (CELU && CELU.uBand) {
      CELU.uBand.value = (m === 1) ? 0.0 : 1.0;
    }
  }

  // ---------- 1. Upgraded PBR Aircraft Shader (WebGL1 compatible) ----------
  const WT_VS = `
    attribute float mt;
    varying vec3 vN;
    varying vec3 vW;
    varying vec3 vC;
    varying vec2 vUv;
    varying float vMt;
    varying float vFd;
    varying vec3 vLPos;
    varying vec3 vLNrm;

    void main() {
      vLPos = position;
      vLNrm = normalize(normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vW = wp.xyz;
      vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
      #ifdef USE_COLOR
        vC = color;
      #else
        vC = vec3(1.0);
      #endif
      vUv = uv;
      vMt = mt;
      vec4 mv = viewMatrix * wp;
      vFd = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `;

  const WT_FS = `
    precision highp float;
    uniform vec3 uSun;
    uniform vec3 uSunC;
    uniform vec3 uSky;
    uniform vec3 uGnd;
    uniform vec3 uZen;
    uniform vec3 uHor;
    uniform vec3 uEnvG;
    uniform vec3 uRim;
    uniform vec3 uFogC;
    uniform float uFogN;
    uniform float uFogF;
    uniform float uExpo;
    uniform float uBand;
    uniform float uOpacity;
    uniform float uHasMap;
    uniform sampler2D tMap;
    uniform float uWtMode;

    varying vec3 vN;
    varying vec3 vW;
    varying vec3 vC;
    varying vec2 vUv;
    varying float vMt;
    varying float vFd;
    varying vec3 vLPos;
    varying vec3 vLNrm;

    float h12(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    // Object-space procedural aircraft panel seams, subtle panel tone shifts & micro-rivets
    void airframePanels(vec3 lp, vec3 ln, out float seamDark, out float panelTint, out float rivet) {
      vec3 an = abs(ln);
      // Triplanar projection in model units (clean seams on wings, fuselage & fins)
      vec2 p = an.y >= an.x && an.y >= an.z ? lp.xz
             : (an.x >= an.z ? vec2(lp.z, lp.y) : lp.xy);

      // Panel grid (~0.85 m x 1.15 m military airframe sheets)
      vec2 grid = p * vec2(1.18, 0.88);
      vec2 cell = floor(grid);
      vec2 f = fract(grid);
      vec2 edge = min(f, 1.0 - f);
      float dLine = min(edge.x, edge.y);

      // Crisp hairline panel groove (bolder in Stylized Cel mode to harmonize with ink outlines)
      float seamAmt = uWtMode < 0.5 ? 0.30 : 0.22;
      seamDark = 1.0 - (1.0 - smoothstep(0.012, 0.040, dLine)) * seamAmt;

      // Subtle per-panel sheet metal tone variation (gives that authentic next-gen skin look)
      float pid = h12(cell + vec2(3.1, 7.7));
      panelTint = 0.965 + pid * 0.07;

      // Tiny flush rivets along panel borders
      float nearBorder = step(0.035, dLine) * (1.0 - step(0.085, dLine));
      vec2 rf = fract(grid * 10.0) - 0.5;
      float rDot = 1.0 - smoothstep(0.14, 0.24, length(rf));
      rivet = nearBorder * rDot * 0.075;
    }

    // Smooth glossy studio/sky reflection environment
    vec3 envGloss(vec3 r, float rough) {
      vec3 sky = r.y > 0.0
        ? mix(uHor, uZen, pow(clamp(r.y, 0.0, 1.0), 0.55))
        : mix(uHor * 0.78, uEnvG, pow(clamp(-r.y, 0.0, 1.0), 0.42));
      // Horizon reflection band (classic sleek next-gen aircraft sheen)
      float horBand = exp(-abs(r.y) * mix(16.0, 4.5, rough));
      sky = mix(sky, uHor * 1.18, horBand * (1.0 - rough * 0.65) * 0.45);
      // Crisp specular sun reflection
      float sunRef = pow(max(0.0, dot(r, uSun)), mix(140.0, 14.0, rough));
      sky += uSunC * sunRef * mix(2.4, 0.45, rough);
      return sky;
    }

    // Classic ASKIIES cel shading path (when OPT.pmode == 2)
    vec4 renderClassicCel(vec3 base, float tl, vec3 N, vec3 V, float ndv) {
      vec4 M = vMt < 0.5 ? vec4(0.12, 0.5, 48.0, 0.55)
             : vMt < 1.5 ? vec4(0.5, 0.85, 80.0, 0.7)
             : vMt < 2.5 ? vec4(0.8, 1.0, 180.0, 0.9)
             : vMt < 3.5 ? vec4(0.07, 0.3, 24.0, 0.35)
             : vMt < 4.5 ? vec4(0.035, 0.12, 10.0, 0.3)
             : vMt < 5.5 ? vec4(0.02, 0.05, 6.0, 0.2)
             : vec4(0.0);
      float ndl = dot(N, uSun);
      float lit = mix(clamp(ndl * 0.5 + 0.5, 0.0, 1.0), smoothstep(-0.03, 0.05, ndl) * 0.6 + smoothstep(0.4, 0.48, ndl) * 0.4, uBand);
      vec3 hemi = mix(uGnd, uSky, N.y * 0.5 + 0.5);
      vec3 col = base * (hemi + uSunC * lit);
      if (vMt > 5.5) return vec4(base, uOpacity);
      vec3 H = normalize(uSun + V);
      float sp = pow(max(dot(N, H), 0.0), M.z);
      col += uSunC * M.y * mix(sp, smoothstep(0.45, 0.55, sp), uBand) * step(0.0, ndl);
      float fr = pow(1.0 - ndv, 4.0);
      float k = clamp(M.x * (0.4 + 0.6 * fr) + fr * 0.1 * step(M.x, 0.2), 0.0, 0.85);
      vec3 r = reflect(-V, N);
      vec3 E = r.y > 0.0 ? mix(uHor, uZen, pow(clamp(r.y, 0.0, 1.0), 0.55)) : mix(uHor, uEnvG, pow(clamp(-r.y, 0.0, 1.0), 0.35));
      float l = dot(E, vec3(0.3, 0.59, 0.11)), q = floor(l * 4.0 + 0.5) / 4.0;
      E *= mix(1.0, q / max(l, 0.001), 0.65 * uBand);
      E += uSunC * smoothstep(0.93, 0.95, dot(r, uSun)) * 1.6;
      if (vMt > 0.5 && vMt < 1.5) E *= mix(vec3(1.0), base * 1.5, 0.55);
      col = mix(col, E * (0.55 + 0.45 * lit), k);
      col += uRim * smoothstep(0.55, 0.62, pow(1.0 - ndv, 2.0)) * M.w * (0.4 + 0.6 * lit);
      col *= uExpo;
      vec3 kk = max(col - 0.8, 0.0);
      col = min(col, 0.8) + kk / (1.0 + kk * 2.4);
      col = mix(col, uFogC, smoothstep(uFogN, uFogF, vFd));
      return vec4(col, uOpacity);
    }

    void main() {
      vec3 base = vC;
      float tl = 1.0;
      if (uHasMap > 0.5) {
        vec3 tx = texture2D(tMap, vUv).rgb;
        base *= tx;
        tl = dot(tx, vec3(0.3, 0.59, 0.11));
      }

      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vW);
      float ndv = dot(N, V);
      if (ndv < 0.0) { N = -N; ndv = -ndv; }

      if (uWtMode > 1.5) {
        gl_FragColor = renderClassicCel(base, tl, N, V, ndv);
        return;
      }

      // Emissive glow tags stay bright & crisp
      if (vMt > 5.5) {
        gl_FragColor = vec4(base * 1.25, uOpacity);
        return;
      }

      // Distance fade for fine panel lines & rivets so distant jets stay clean with zero moire
      float detailFade = 1.0 - smoothstep(45.0, 260.0, vFd);
      float seamDark = 1.0, panelTint = 1.0, rivet = 0.0;
      if (vMt < 1.5 && detailFade > 0.02) {
        airframePanels(vLPos, vLNrm, seamDark, panelTint, rivet);
        base *= mix(1.0, seamDark * panelTint, detailFade);
        base -= vec3(rivet * detailFade);
        // Subtle exhaust soot darkening near tail nozzles (+z)
        float soot = smoothstep(2.8, 4.9, vLPos.z) * (1.0 - smoothstep(0.35, 1.3, abs(vLPos.x))) * 0.18;
        base *= (1.0 - soot);
      }

      // Material PBR parameters: rough, metallic, specStrength, f0
      float rough = 0.34, metal = 0.18, specS = 0.72, f0 = 0.06;
      if (vMt < 0.5) {
        // Military painted aluminum clearcoat (next-gen sheen)
        rough = mix(0.30, 0.38, uHasMap * (1.0 - tl * 0.4));
        metal = 0.20;
        specS = 0.85;
        f0 = 0.07;
      } else if (vMt < 1.5) {
        // Bare metal / titanium nozzles / gun barrels / pylons
        rough = 0.22;
        metal = 0.82;
        specS = 1.25;
        f0 = 0.55;
      } else if (vMt < 2.5) {
        // Fighter bubble canopy glass: high Fresnel sky/gold reflection, crisp sun glint
        rough = 0.07;
        metal = 0.15;
        specS = 1.85;
        f0 = 0.24;
      } else if (vMt < 3.5) {
        // Dark matte rubber / intakes / gun housing
        rough = 0.68;
        metal = 0.06;
        specS = 0.28;
        f0 = 0.03;
      } else if (vMt < 4.5) {
        // Composite radome / wood / deck
        rough = 0.56;
        metal = 0.04;
        specS = 0.34;
        f0 = 0.04;
      } else {
        // Pilot suit
        rough = 0.78;
        metal = 0.0;
        specS = 0.15;
        f0 = 0.02;
      }

      // Lighting: Stylized Cel 3D (mode 0) vs Smooth Realistic 3D (mode 1)
      bool isStylized = uWtMode < 0.5;
      float ndl = dot(N, uSun);
      float diff = max(0.0, ndl);
      float wrapDiff = clamp((ndl + 0.18) / 1.18, 0.0, 1.0);
      float sunKey = mix(diff, wrapDiff, 0.32);

      // Stylized 3-step cel ramp (crisp shadow/mid/lit bands with smooth anti-aliased transitions)
      if (isStylized) {
        float celBand = 0.08 + smoothstep(-0.08, 0.04, ndl) * 0.48 + smoothstep(0.38, 0.48, ndl) * 0.44;
        sunKey = mix(sunKey, celBand, 0.82);
        // Slightly boost color vibrancy for punchy cartoon military feel
        float lum = dot(base, vec3(0.299, 0.587, 0.114));
        base = mix(vec3(lum), base, 1.14);
      }

      // Hemisphere ambient (brighter sky above, warm ground bounce underneath)
      vec3 hemi = mix(uGnd * 1.15, uSky * 1.25, N.y * 0.5 + 0.5);
      // Subtle ambient occlusion near belly
      float bellyAO = mix(0.84, 1.0, smoothstep(-0.85, 0.25, N.y));

      vec3 diffuseCol = base * (1.0 - metal * 0.50) * (hemi * bellyAO + uSunC * sunKey * (isStylized ? 1.38 : 1.48));

      // Specular highlight: crisp cartoon-banded glint in Stylized mode, smooth GGX-like in Realistic mode
      vec3 H = normalize(uSun + V);
      float ndh = max(0.0, dot(N, H));
      float shininess = mix(180.0, 12.0, rough * rough);
      float specRaw = pow(ndh, shininess);
      float specMain = (isStylized ? mix(specRaw, smoothstep(0.32, 0.44, specRaw), 0.72) : specRaw) * specS * smoothstep(-0.05, 0.15, ndl);
      float specBroad = pow(ndh, 18.0) * (isStylized ? 0.10 : 0.16) * (1.0 - rough) * smoothstep(-0.05, 0.2, ndl);
      vec3 specTint = mix(vec3(1.0), base * 1.35 + vec3(0.15), metal);
      vec3 specCol = uSunC * specTint * (specMain + specBroad);

      // Fresnel environment reflection (quantized glossy bands in Stylized mode for sleek comic shine!)
      float fres = f0 + (1.0 - f0) * pow(1.0 - ndv, 4.0);
      vec3 reflDir = reflect(-V, N);
      vec3 env = envGloss(reflDir, rough);
      if (isStylized) {
        float el = dot(env, vec3(0.3, 0.59, 0.11));
        float eq = floor(el * 4.0 + 0.5) / 4.0;
        env *= mix(1.0, eq / max(el, 0.001), 0.48);
      }
      env *= mix(vec3(1.0), base * 1.45 + vec3(0.1), metal * 0.85);

      float envMix = clamp(fres * mix(0.85, 0.22, rough), 0.0, 0.88);
      vec3 col = mix(diffuseCol, env * (0.65 + 0.45 * sunKey), envMix) + specCol;

      // Bold cartoon silhouette rim highlight in Stylized mode; softer atmospheric rim in Realistic mode
      float rimPow = pow(1.0 - ndv, isStylized ? 2.2 : 3.0);
      float rim = isStylized
        ? smoothstep(0.46, 0.58, rimPow) * (0.34 + 0.46 * sunKey) * (1.0 - rough * 0.4)
        : rimPow * (0.22 + 0.35 * sunKey) * (1.0 - rough * 0.5);
      col += mix(uRim, uHor * 0.72, 0.5) * rim;

      // Canopy glass transparency modulated by Fresnel (clear straight-on, reflective at grazing angle)
      float outAlpha = uOpacity;
      if (vMt > 1.5 && vMt < 2.5) {
        outAlpha = clamp(mix(uOpacity * 0.85, 0.92, pow(1.0 - ndv, 2.2)), 0.32, 0.95);
      }

      // Soft ACES-like filmic tone shoulder so sunlit white/silver jets never blow out
      col *= uExpo * 1.06;
      col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);

      // Fog blend
      col = mix(col, uFogC, smoothstep(uFogN, uFogF, vFd));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), outAlpha);
    }
  `;

  function makeWtMat(o) {
    o = o || {};
    const u = {
      tMap: { value: o.map || null },
      uHasMap: { value: o.map ? 1 : 0 },
      uOpacity: { value: o.opacity == null ? 1 : o.opacity }
    };
    for (const k in CELU) u[k] = CELU[k];
    u.uWtMode = WTU.uWtMode;
    const m = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: WT_VS,
      fragmentShader: WT_FS,
      vertexColors: true,
      transparent: !!o.transparent,
      depthWrite: o.depthWrite !== false
    });
    m.isCel = 1;
    m.isWt = 1;
    return m;
  }

  // Upgrade existing cel materials (JM, GM, JMT cache) and override celMat() for all future builds
  function upgradeMaterialInPlace(mat) {
    if (!mat || !mat.isShaderMaterial || mat.isWt) return;
    mat.vertexShader = WT_VS;
    mat.fragmentShader = WT_FS;
    mat.uniforms.uWtMode = WTU.uWtMode;
    mat.isWt = 1;
    mat.needsUpdate = true;
  }

  if (typeof JM !== 'undefined') upgradeMaterialInPlace(JM);
  if (typeof GM !== 'undefined') upgradeMaterialInPlace(GM);
  if (typeof JMT !== 'undefined' && JMT && JMT.forEach) {
    JMT.forEach(m => upgradeMaterialInPlace(m));
  }
  celMat = makeWtMat;

  // ---------- 2. Smart Crease-Angle Normal Smoothing ----------
  // Smooths curved fuselages, radomes, engines, missiles & bubble canopies while keeping
  // sharp wing edges, stealth chines, fins & intakes razor crisp (~46 deg threshold).
  const CREASE_COS = Math.cos(46 * Math.PI / 180);

  function smoothGeometryCrease(geo) {
    if (!geo || geo.userData._wtSmoothed) return;
    const pos = geo.attributes && geo.attributes.position;
    const nrm = geo.attributes && geo.attributes.normal;
    if (!pos || !nrm || pos.count < 6 || pos.count > 45000) return;
    geo.userData._wtSmoothed = 1;

    const count = pos.count;
    const pArr = pos.array;
    const nArr = nrm.array;
    const buckets = new Map();

    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const key = Math.round(pArr[o] * 400) + ',' + Math.round(pArr[o + 1] * 400) + ',' + Math.round(pArr[o + 2] * 400);
      let list = buckets.get(key);
      if (!list) { list = []; buckets.set(key, list); }
      list.push(i);
    }

    const out = new Float32Array(nArr.length);
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const nx = nArr[o], ny = nArr[o + 1], nz = nArr[o + 2];
      const key = Math.round(pArr[o] * 400) + ',' + Math.round(pArr[o + 1] * 400) + ',' + Math.round(pArr[o + 2] * 400);
      const list = buckets.get(key);
      if (!list || list.length <= 1) {
        out[o] = nx; out[o + 1] = ny; out[o + 2] = nz;
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < list.length; k++) {
        const j = list[k] * 3;
        const jx = nArr[j], jy = nArr[j + 1], jz = nArr[j + 2];
        if (nx * jx + ny * jy + nz * jz >= CREASE_COS) {
          sx += jx; sy += jy; sz += jz;
        }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      out[o] = sx / l; out[o + 1] = sy / l; out[o + 2] = sz / l;
    }

    nrm.array.set(out);
    nrm.needsUpdate = true;
  }

  function smoothObjectMeshes(root) {
    if (!root || !root.traverse) return;
    root.traverse(o => {
      if (o.isMesh && o.material && o.material !== ink) {
        if (o.material.isShaderMaterial) upgradeMaterialInPlace(o.material);
        smoothGeometryCrease(o.geometry);
      }
    });
  }

  // Hook mkMesh so every newly built jet, missile, store, tank & ship gets smooth curves automatically
  const origMkMesh = mkMesh;
  mkMesh = function (c, mat) {
    const m = origMkMesh.apply(this, arguments);
    try {
      if (m && m.geometry) smoothGeometryCrease(m.geometry);
      if (m && m.material && m.material.isShaderMaterial) upgradeMaterialInPlace(m.material);
    } catch (e) {}
    return m;
  };

  // ---------- 3. Volumetric Mach-Diamond Afterburner & Nav Light Halos ----------
  const AB_VS = `
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
      vV = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const AB_FS = `
    precision highp float;
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uCore;
    uniform float uOpacity;
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vV;

    void main() {
      // Three.js ConeGeometry: vUv.y = 0 at wide nozzle base, 1 at pointed exhaust tip
      float along = clamp(vUv.y, 0.0, 1.0);
      // Soft Fresnel edge fade so cone never looks like hard geometric triangles
      float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.25);
      // Smooth envelope: hot & bright right out of the nozzle, tapering cleanly to the tip
      float lengthFade = smoothstep(0.0, 0.04, along) * pow(1.0 - along, 1.25);
      // Animated supersonic Mach shock-diamond rings pulsing down the plume
      float diamond = pow(max(0.0, sin(along * 30.0 - uTime * 42.0) * 0.5 + 0.5), 3.6);
      float diamondEnv = smoothstep(0.03, 0.15, along) * (1.0 - smoothstep(0.55, 0.92, along));
      float flicker = 0.88 + 0.12 * sin(uTime * 59.0 + along * 16.0) * cos(uTime * 33.0);

      vec3 hotWhite = vec3(1.0, 0.96, 0.88);
      vec3 warmCore = mix(uColor, vec3(1.0, 0.72, 0.34), 0.35);
      vec3 col = mix(warmCore, uColor, smoothstep(0.05, 0.55, along));
      // White-hot Mach shock diamonds along the jet core
      col = mix(col, hotWhite, diamond * diamondEnv * uCore * 0.92);
      // Intense white-amber glow right at nozzle exit
      col += hotWhite * exp(-along * 8.0) * (0.55 + 0.45 * uCore);

      float alpha = edge * lengthFade * (0.78 + 0.55 * diamond * diamondEnv * uCore) * flicker * uOpacity;
      gl_FragColor = vec4(col * 1.4, clamp(alpha, 0.0, 1.0));
    }
  `;

  function makeAbMat(hexColor, isInner) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(hexColor) },
        uTime: WTU.uWtTime,
        uCore: { value: isInner ? 1.0 : 0.45 },
        uOpacity: { value: isInner ? 0.95 : 0.62 }
      },
      vertexShader: AB_VS,
      fragmentShader: AB_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
  }

  // Soft radial glow sprite texture for wingtip nav & anti-collision strobe lights
  const glowTex = (() => {
    const N = 64, cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(N / 2, N / 2, 1, N / 2, N / 2, N / 2);
    gr.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    gr.addColorStop(0.22, 'rgba(255,255,255,0.75)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    gr.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, N, N);
    const t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  })();

  // Sprites can only be ray-cast with a camera; the game's own ray casts (decals, LOS) have none, so skip sprites there
  // instead of logging "Raycaster.camera needs to be set" and failing (this also covers halos copied by .clone()).
  if (THREE.Sprite && !THREE.Sprite.prototype._peGuard) {
    const _spRay = THREE.Sprite.prototype.raycast;
    THREE.Sprite.prototype.raycast = function (rc, hits) { if (!rc || !rc.camera) return; return _spRay.call(this, rc, hits); };
    THREE.Sprite.prototype._peGuard = 1;
  }

  function addLightHalo(mesh, colorHex, scale) {
    if (!mesh || mesh.userData._hasHalo) return;
    mesh.userData._hasHalo = 1;
    const sm = new THREE.SpriteMaterial({
      map: glowTex,
      color: colorHex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sp = new THREE.Sprite(sm);
    sp.scale.set(scale, scale, 1);
    sp.raycast = function () {}; // glow only: the game's ray casts (camera, LOS, hits) must not hit it ("Raycaster.camera" error)
    mesh.add(sp);
  }

  function upgradeJetVisuals(jetGroup, pt) {
    if (!jetGroup) return;
    smoothObjectMeshes(jetGroup);

    const abColorHex = (pt && typeof ABC !== 'undefined' && ABC[pt.ab]) ? ABC[pt.ab].c : 0xaef0ff;
    const innerAbMat = makeAbMat(abColorHex, true);
    const outerAbMat = makeAbMat(abColorHex, false);
    const baseFlMat = makeAbMat(0xff9838, false);

    jetGroup.traverse(o => {
      if (o.name === 'ab' && o.children && o.children.length >= 2) {
        // Replace flat inner & outer afterburner cones with animated Mach-diamond plasma shader
        if (o.children[0] && o.children[0].isMesh) o.children[0].material = innerAbMat;
        if (o.children[1] && o.children[1].isMesh) o.children[1].material = outerAbMat;
        // Hide the blocky static octahedron shock diamonds so the volumetric shader diamonds shine cleanly
        for (let i = 2; i < o.children.length; i++) {
          if (o.children[i]) o.children[i].visible = false;
        }
      } else if (o.name === 'fl' && o.children && o.children[0] && o.children[0].isMesh) {
        o.children[0].material = baseFlMat;
      } else if (o.name === 'nav' && o.isMesh) {
        const col = o.position.x > 0 ? 0x30ff70 : 0xff3838;
        addLightHalo(o, col, 0.72);
      } else if (o.name === 'stb' && o.isMesh) {
        addLightHalo(o, 0xffffff, 0.85);
      }
    });
  }

  const origBuildJet = buildJet;
  buildJet = function (di, pt, sp) {
    const g = origBuildJet.apply(this, arguments);
    try { upgradeJetVisuals(g, pt); } catch (e) {}
    return g;
  };

  // ---------- 4. Hangar Studio Lighting Boost (next-gen Hangar Feel) ----------
  if (typeof celCtx === 'function') {
    const origCelCtx = celCtx;
    celCtx = function (sc) {
      origCelCtx.apply(this, arguments);
      syncModeUniforms();
      if ((OPT.pmode | 0) === 2 || !CELU) return;
      if (sc === HS) {
        // Crisp warm key + cool sky bounce + teal hangar floor reflection
        CELU.uSun.value.set(5, 10, 7).normalize();
        CELU.uSunC.value.setRGB(0.95, 0.92, 0.86);
        CELU.uSky.value.setRGB(0.46, 0.56, 0.66);
        CELU.uGnd.value.setRGB(0.16, 0.24, 0.28);
        CELU.uZen.value.setRGB(0.08, 0.20, 0.30);
        CELU.uHor.value.setRGB(0.32, 0.72, 0.72);
        CELU.uEnvG.value.setRGB(0.07, 0.14, 0.16);
        CELU.uRim.value.setRGB(0.28, 0.72, 0.70);
      } else if (sc === S) {
        // Slightly richer sunlight & sky reflection in flight to match the 3D GPU terrain
        CELU.uSunC.value.multiplyScalar(1.22);
        CELU.uSky.value.multiplyScalar(1.18);
      }
    };
  }

  // ---------- 5. Smoother Tapered Wingtip Trails & Contrails ----------
  if (typeof drawTrails === 'function') {
    const origDrawTrails = drawTrails;
    drawTrails = function (o) {
      if ((OPT.pmode | 0) === 2) return origDrawTrails.apply(this, arguments);
      const T = o && o.trl;
      if (!T) return;
      const spec = [
        ['l', 2.4, '240,248,255', 1.8],
        ['r', 2.4, '240,248,255', 1.8],
        ['e', 5.2, '232,238,246', 2.6]
      ];
      F.lineCap = 'round';
      for (let s = 0; s < spec.length; s++) {
        const k = spec[s][0], L = spec[s][1], rgb = spec[s][2], baseW = spec[s][3];
        const A = T[k];
        if (!A || A.length < 2) continue;
        let px = 0, py = 0, pv = 0;
        for (let i = 0; i < A.length; i++) {
          const q = A[i];
          if (!q) { pv = 0; continue; }
          const on = pjf(q);
          if (on && pv) {
            const life = 1 - (rt - q.t) / L;
            const al = q.a * life;
            if (al > 0.025) {
              const d = Math.max(25, Math.hypot(q.x - C.position.x, q.y - C.position.y, q.z - C.position.z));
              const w = Math.max(1.0, Math.min(5.0, baseW * (120 / d) * (0.4 + 0.6 * life)));
              F.lineWidth = w;
              F.strokeStyle = `rgba(${rgb},${(al * 0.75).toFixed(2)})`;
              F.beginPath();
              F.moveTo(px, py);
              F.lineTo(sx, sy);
              F.stroke();
            }
          }
          pv = on; px = sx; py = sy;
        }
      }
    };
  }

  // ---------- 6. next-gen Battle Damage Smoke & Engine Fire + Animation Clock ----------
  if (typeof update === 'function') {
    const origUpdate = update;
    update = function (dt) {
      WTU.uWtTime.value = rt;
      syncModeUniforms();
      origUpdate.apply(this, arguments);
      if ((OPT.pmode | 0) === 2 || st !== 1 || (typeof VEHM !== 'undefined' && VEHM)) return;
      try {
        // Player aircraft damage smoke / fire when hurt
        if (P && !P.dead && !P.gone && P.hp < 65 && !(MAP && MAP.space)) {
          const sev = cl((65 - P.hp) / 65, 0, 1);
          if (Math.random() < dt * (12 + sev * 26)) {
            const tail = tv.copy(P.p).addScaledVector(P.f, -8.5);
            puff(tail, 1.3 + sev * 1.4, sev > 0.55 ? ['#45454a', '#2c2c30', '#1c1c20'] : ['#9aa0a8', '#686d75', '#42464c'], 1.1 + sev * 0.9, 'o:.');
          }
          if (P.hp < 32 && Math.random() < dt * 18) {
            const tail = tv.copy(P.p).addScaledVector(P.f, -7.5);
            puff(tail, 1.4, FIRE, 0.45, '*+.');
          }
        }
        // Damaged enemy fighters trail dark smoke & flame
        if (typeof en !== 'undefined' && !(MAP && MAP.space)) {
          for (let i = 0; i < en.length; i++) {
            const e = en[i];
            if (!e || e.ty !== 'air' || !e.mhp || e.hp >= e.mhp * 0.55) continue;
            const d2 = e.p.distanceToSquared(C.position);
            if (d2 > 4000 * 4000) continue;
            const sev = cl(1 - e.hp / (e.mhp * 0.55), 0, 1);
            if (Math.random() < dt * (8 + sev * 18)) {
              puff(e.p, 1.4 + sev * 1.5, ['#38383d', '#242428', '#525258'], 1.3, 'o:.');
            }
            if (sev > 0.55 && Math.random() < dt * 14) {
              puff(e.p, 1.3, FIRE, 0.4, '*+.');
            }
          }
        }
      } catch (e) {}
    };
  }

  // ---------- 7. RAIL-ACCURATE MISSILES & LOADOUTS (OPT.rrail: 1 = REAL RAILS, 0 = STOCK) ----------
  if (OPT.rrail == null) OPT.rrail = 1;
  LISTS.rrail = () => ['STOCK', 'REAL RAILS'];

  // Split each hardpoint into permanent wing pylon/rack + individual detachable store meshes
  function buildSplitStoresForHardpoint(h, sp, m, pal) {
    const x = h.x * m, y = h.y, z = h.z, o = [x, y, z];
    const pylonParts = [];
    const stores = []; // each item: { parts, offset, isPod, isBomb }

    if (h.cu) {
      // Custom Workshop/Armory hardpoint
      if (!h.rail && !h.bay) {
        pylonParts.push(plate([x, y + 0.42, z - 0.62], [x, y + 0.42, z + 0.55], [x, y + 0.12, z + 0.35], [x, y + 0.12, z - 0.4], 0.1, [1, 0, 0], 'metal', 1));
      } else if (h.rail && !h.bay) {
        pylonParts.push(box([x, y + 0.06, z], [0.04, 0.05, 0.7], 'metal'));
      }
      if (h.md && typeof cmslGeo === 'function') {
        const r = Math.max(0.05, h.md.dia * 0.75);
        stores.push({ parts: cmslGeo(h.md, x, y - (h.rail ? r * 0.6 : r + 0.05), z), offset: [0, 0, 0], isPod: false, isBomb: false });
      }
      return { o, pylonParts, stores };
    }

    const effK = (sp < 0 && h.k === 'sp') ? 'std' : h.k;
    if (!h.rail && !h.bay) {
      pylonParts.push(plate([x, y + 0.42, z - 0.62], [x, y + 0.42, z + 0.55], [x, y + 0.12, z + 0.35], [x, y + 0.12, z - 0.4], 0.1, [1, 0, 0], 'metal', 1));
    }

    const q = h.q || (sp >= 3 ? 1.15 : 1);
    if (effK === 'std') {
      stores.push({ parts: missile([x, y, z], 1), offset: [0, 0, 0], isPod: false, isBomb: false });
    } else if (sp === 0) {
      stores.push({ parts: missile([x, y - 0.03, z], 1.12 * q, 'acc', 1), offset: [0, -0.03, 0], isPod: false, isBomb: false });
    } else if (sp === 1) {
      // 4AAM dual rack: rack stays on pylon, 2 separate detachable missiles!
      pylonParts.push(box([x, y + 0.07, z], [0.36 * q, 0.05, 0.9 * q], 'metal'));
      for (const ox of [-0.21, 0.21]) {
        stores.push({ parts: missile([x + ox * q, y - 0.08, z], 0.84 * q), offset: [ox * q, -0.08, 0], isPod: false, isBomb: false });
      }
    } else if (sp === 2) {
      stores.push({ parts: missile([x, y - 0.08, z + 0.2], 1.5 * q, 'acc'), offset: [0, -0.08, 0.2], isPod: false, isBomb: false });
    } else if (sp === 3 && typeof missile === 'function') {
      stores.push({ parts: missile([x, y - 0.05, z + 0.1], 1.15 * q, 'acc', 1), offset: [0, -0.05, 0.1], isPod: false, isBomb: false });
    } else if (sp === 4 && typeof agm === 'function') {
      // 4AGM dual rack: rack stays on pylon, 2 separate detachable AGMs!
      pylonParts.push(box([x, y + 0.07, z], [0.32 * q, 0.05, 0.85 * q], 'metal'));
      for (const ox of [-0.21, 0.21]) {
        stores.push({ parts: agm([x + ox * q, y - 0.14, z], 0.72 * q), offset: [ox * q, -0.14, 0], isPod: false, isBomb: false });
      }
    } else if (sp === 5 && typeof bomb === 'function') {
      // UGB dual rack: rack stays on pylon, 2 separate detachable bombs!
      pylonParts.push(box([x, y + 0.07, z], [0.3 * q, 0.05, 0.85 * q], 'metal'));
      for (const oz of [-0.62, 0.62]) {
        stores.push({ parts: bomb([x, y - 0.22 * q, z + oz * q], 0.62 * q), offset: [0, -0.22 * q, oz * q], isPod: false, isBomb: true });
      }
    } else if (sp === 6 && typeof rpod === 'function') {
      // Rocket pod stays permanently mounted on the pylon
      stores.push({ parts: rpod([x, y - 0.2 * q, z], q), offset: [0, -0.2 * q, 0], isPod: true, isBomb: false });
    } else if (sp === 7 && typeof lasm === 'function') {
      stores.push({ parts: lasm([x, y - 0.14 * q, z + 0.1], 1.05 * q), offset: [0, -0.14 * q, 0.1], isPod: false, isBomb: false });
    } else if (sp === 8 && typeof railp === 'function') {
      // EML railgun pod stays permanently mounted
      stores.push({ parts: railp([x, y - 0.18 * q, z], q), offset: [0, -0.18 * q, 0], isPod: true, isBomb: false });
    } else {
      stores.push({ parts: missile([x, y - 0.05, z + 0.1], 1.15 * q, 'acc', 1), offset: [0, -0.05, 0.1], isPod: false, isBomb: false });
    }
    return { o, pylonParts, stores };
  }

  function splitJetRails(jetGroup, di, pt, sp) {
    if (!jetGroup || !DES[di] || typeof spHP !== 'function') return;
    let d;
    try { d = DES[di](); } catch (e) { return; }
    if (!d || !d.hp || !d.hp.length) return;
    const pal = mkPal(pt || FACT[0]);
    const hps = spHP(d.hp, sp);

    // Collect existing combined 'ld' groups (preserving their parent so swing-wing mounts stay intact!)
    const existing = [];
    jetGroup.traverse(o => { if (o.name === 'ld') existing.push(o); });
    if (!existing.length) return;

    const specs = [];
    for (const h of hps) {
      for (const m of (h.solo ? [1] : [1, -1])) {
        specs.push({ h, m });
      }
    }
    if (specs.length !== existing.length) return;

    for (let i = 0; i < specs.length; i++) {
      const oldLg = existing[i];
      const par = oldLg.parent || jetGroup;
      const { h, m } = specs[i];
      const built = buildSplitStoresForHardpoint(h, sp, m, pal);

      // Permanent pylon / rack group (remains visible when missiles fire!)
      if (built.pylonParts.length) {
        const py = new THREE.Group();
        py.name = 'pylon';
        py.position.copy(oldLg.position);
        py.quaternion.copy(oldLg.quaternion);
        if (oldLg.userData && oldLg.userData.swc) py.userData.swc = 1;
        py.add(mkMesh(compile(built.pylonParts, pal, built.o)));
        par.add(py);
      }

      // Individual detachable missile/bomb store groups
      built.stores.forEach((stItem, si) => {
        if (!stItem.parts.length) return;
        const sg = new THREE.Group();
        sg.name = 'ld';
        // Preserve swing-wing relative position by adding local store offset to oldLg.position
        sg.position.set(
          oldLg.position.x + stItem.offset[0],
          oldLg.position.y + stItem.offset[1],
          oldLg.position.z + stItem.offset[2]
        );
        sg.quaternion.copy(oldLg.quaternion);
        const storeCenter = [
          built.o[0] + stItem.offset[0],
          built.o[1] + stItem.offset[1],
          built.o[2] + stItem.offset[2]
        ];
        sg.userData = {
          k: h.k,
          s: m,
          g: h.g,
          rail: h.rail ? 1 : 0,
          bay: h.bay ? 1 : 0,
          pod: stItem.isPod ? 1 : 0,
          bomb: stItem.isBomb ? 1 : 0,
          swc: (oldLg.userData && oldLg.userData.swc) ? 1 : 0,
          slot: si
        };
        sg.add(mkMesh(compile(stItem.parts, pal, storeCenter)));
        par.add(sg);
      });

      par.remove(oldLg);
    }
  }

  // ---------- 7b. LOADOUT STATIONS (v1.2): every loaded missile hangs on the jet, and nothing ever grows back ----------
  // The game's own loadout (ldOf / OPT.real) decides how many IR, radar and SP rounds you carry; this section never changes those counts.
  // Missiles that have no hardpoint on the model get a launcher station on the real underside of the airframe (found by ray casting the
  // belly / wing roots, mirrored left-right, clear of other stores, gear and nozzles). IR rounds go on the wingtip rails first, radar
  // rounds use a longer missile with an accent band. Rule everywhere: the jet never shows more of a kind than you have left; a shot
  // leaves from a visible station only when more are showing than remain, otherwise it comes from inside (bombers, bays, big magazines).
  const PE_STA = { need: null, cache: new Map(), MAXNEW: 8 };
  const PE_SKIP = new Set(['ld', 'pylon', 'ab', 'fl', 'nav', 'stb', 'vap', 'shk', 'gear']);

  function peNeedNow() {
    try {
      if (!OPT.rrail || OPT.ac === 11 || (typeof VEHM !== 'undefined' && VEHM)) return null;
      const a = (typeof effAC === 'function') ? effAC() : A;
      return ldOf(OPT.ac, a, 1);
    } catch (e) { return null; }
  }

  function peKindOf(o) {
    const u = o.userData || {};
    if (u.pod) return null;
    if (u.k === 'sp') return 'sp';
    if (u.k === 'std') return u.sk === 'arh' ? 'arh' : 'ir';
    return null;
  }

  // Stations of one kind in their keep order (first ones stay longest; shots always take the last visible one)
  function peStations(kind) {
    if (!pp || !pp.ld) return [];
    return pp.ld.filter(o => peKindOf(o) === kind).sort((a, b) => (a.userData.ord | 0) - (b.userData.ord | 0));
  }

  function peLeft(kind) { return kind === 'sp' ? (P.sp | 0) : kind === 'arh' ? (P.rd | 0) : (P.ir | 0); }

  // Make the model show exactly what is left (never more), for stock jets and custom Workshop jets
  function peSyncAmmoToStations() {
    if (!OPT.rrail || !P || !PJ || !pp || !pp.ld || (typeof VEHM !== 'undefined' && VEHM)) return;
    if (OPT.ac === 11) return; // Custom Workshop/Armory aircraft already track exact mounted stores in P.cg

    const isBay = !!(PJ.userData && PJ.userData.bay);
    const nIR = peStations('ir').length;
    const nRD = peStations('arh').length;
    const nSP = peStations('sp').length;
    const Wp = (typeof SPW !== 'undefined') ? SPW[OPT.sp] : null;
    const isPodSp = !!(Wp && (Wp.k === 'rkt' || Wp.k === 'eml' || Wp.k === 'mmsl'));

    // Exact 1:1 rail parity: never carry more external missiles than physical stations hanging on the jet
    if (!isBay && (nIR + nRD) > 0) {
      P.ir = Math.min(P.ir | 0, nIR);
      P.rd = Math.min(P.rd | 0, nRD);
      P.ms = P.ir + P.rd;
    }
    if (!isPodSp && nSP > 0) {
      P.sp = Math.min(P.sp | 0, nSP);
    }
    if (P.ld) {
      if (!isBay && (nIR + nRD) > 0) {
        P.ld.ir = P.ir;
        P.ld.rd = P.rd;
      }
      if (!isPodSp && nSP > 0) {
        P.ld.sp = P.sp;
      }
    }
    if (P.rl) P.rl.length = 0;
  }

  function peApplyVisibility() {
    if (!OPT.rrail || !P || !pp || !pp.ld) return;
    if (OPT.ac === 11) {
      if (!P.cg) return;
      for (const g of P.cg) {
        const list = pp.ld.filter(o => o.userData.g === g.id);
        list.forEach((o, i) => { o.visible = i < (g.n | 0); });
      }
      if (P.rl) P.rl.length = 0;
      return;
    }
    for (const kind of ['ir', 'arh', 'sp']) {
      const n = peLeft(kind);
      peStations(kind).forEach((o, i) => { o.visible = i < n; });
    }
    if (P.rl) P.rl.length = 0;
  }

  // ----- station placement on the real airframe -----
  function peLocalBox(o, invG) {
    const bx = new THREE.Box3();
    o.updateMatrixWorld(true);
    o.traverse(q => {
      if (!q.isMesh || !q.geometry) return;
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox();
      const m = new THREE.Matrix4().multiplyMatrices(invG, q.matrixWorld);
      bx.union(q.geometry.boundingBox.clone().applyMatrix4(m));
    });
    return bx;
  }

  function peSkipped(o, g) {
    for (let q = o; q && q !== g; q = q.parent) {
      if (PE_SKIP.has(q.name)) return true;
      const u = q.userData;
      if (u && (u.ag || u.n)) return true; // gear legs and moving control surfaces / pivots
    }
    return false;
  }

  function pePlan(g, di, need) {
    const key = di + '|' + need.ir + '|' + need.rd;
    if (PE_STA.cache.has(key)) return PE_STA.cache.get(key);
    g.updateMatrixWorld(true);
    const invG = new THREE.Matrix4().copy(g.matrixWorld).invert();
    const hull = [], solid = [], blockers = [];
    const bb = new THREE.Box3();
    const FX = new Set(['nav', 'stb', 'vap', 'shk', 'ab', 'fl']);
    const isFx = o => { for (let q = o; q && q !== g; q = q.parent) if (FX.has(q.name)) return true; return false; };
    g.traverse(o => {
      if (o === g) return;
      if (o.isMesh && !isFx(o)) solid.push(o); // everything a ray can physically hit (incl. moving surfaces, stores, gear)
      if (o.isMesh && !peSkipped(o, g)) { hull.push(o); bb.union(peLocalBox(o, invG)); }
      if (o.name === 'ld' || o.name === 'pylon' || o.name === 'ab' || o.name === 'fl' || o.name === 'gear' || (o.userData && (o.userData.ag || o.userData.n === 'gear' || o.userData.n === 'dtk'))) {
        const b = peLocalBox(o, invG);
        if (!b.isEmpty()) blockers.push(b.expandByScalar(0.08));
      }
    });
    const plan = [];
    PE_STA.cache.set(key, plan);
    if (!hull.length || bb.isEmpty()) return plan;
    const hullSet = new Set(hull);
    // each ray only tests the meshes that are actually above that spot (much faster than testing the whole jet)
    const solidBoxes = solid.map(m => ({ m, b: peLocalBox(m, invG) })).filter(e => !e.b.isEmpty());
    const memo = new Map();

    const existing = [];
    g.traverse(o => { if (o.name === 'ld' && o.userData && o.userData.k === 'std' && !o.userData.pod) existing.push(o); });
    let extra = Math.min(PE_STA.MAXNEW, (need.ir | 0) + (need.rd | 0) - existing.length);
    if (extra <= 0) return plan;
    const wantIr = Math.max(0, (need.ir | 0) - existing.length);
    const irLeft = (need.rd | 0) > 0 ? Math.min(wantIr, Math.floor(extra / 2)) : wantIr;

    const rc = new THREE.Raycaster();
    const up = new THREE.Vector3(0, 1, 0).transformDirection(g.matrixWorld);
    const under = (x, z) => {
      const k = x.toFixed(3) + ',' + z.toFixed(3);
      if (memo.has(k)) return memo.get(k);
      const ms = [];
      for (const e of solidBoxes) if (x >= e.b.min.x && x <= e.b.max.x && z >= e.b.min.z && z <= e.b.max.z) ms.push(e.m);
      let y = null;
      if (ms.length) {
        const o = g.localToWorld(new THREE.Vector3(x, bb.min.y - 3, z));
        rc.set(o, up); rc.far = Infinity;
        const h = rc.intersectObjects(ms, false);
        // the first thing above the spot must be fixed airframe (not a moving tailplane, flap, gear leg or another store)
        if (h.length && hullSet.has(h[0].object)) y = g.worldToLocal(h[0].point.clone()).y;
      }
      memo.set(k, y);
      return y;
    };
    const half = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)), len = bb.max.z - bb.min.z, zc = (bb.min.z + bb.max.z) / 2;
    const cands = [];
    for (const fx of [0.06, 0.08, 0.1, 0.12, 0.15, 0.18, 0.21, 0.25, 0.29, 0.34, 0.39, 0.45, 0.52, 0.6])
      for (const fz of [0, -0.05, 0.05, -0.1, 0.1, -0.15, 0.15, -0.2, 0.2, -0.25, 0.25, -0.3, 0.3, -0.35, 0.35])
        cands.push({ x: fx * half, z: zc + fz * len, score: fx * 1.0 + Math.abs(fz) * 1.6 });
    cands.sort((a, b) => a.score - b.score);

    const fits = (x, z, s) => {
      const L = 1.6 * s, ys = [];
      // cheap footprint check first: skip spots whose plan-view footprint overlaps a store, gear leg or nozzle
      for (const b of blockers) if (x + 0.3 * s > b.min.x && x - 0.3 * s < b.max.x && z + L + 0.1 > b.min.z && z - L - 0.1 < b.max.z) return null;
      for (const dz of [-0.85 * L, 0, 0.85 * L]) { const y = under(x, z + dz); if (y == null) return null; ys.push(y); }
      if (Math.max(...ys) - Math.min(...ys) > 0.5 * s) return null;
      const y = Math.min(...ys);
      const box = new THREE.Box3(new THREE.Vector3(x - 0.3 * s, y - 0.48 * s, z - L - 0.1), new THREE.Vector3(x + 0.3 * s, y + 0.02, z + L + 0.1));
      for (const b of blockers) if (b.intersectsBox(box)) return null;
      return { y, box };
    };

    let ir = irLeft, ord = 100;
    for (const c of cands) {
      if (extra <= 0) break;
      const sk = ir > 0 ? 'ir' : 'arh';
      if (extra >= 2) {
        // radar rounds are longer; where the long body does not fit, a compact one may
        let s = sk === 'arh' ? 1.2 : 1, r = fits(c.x, c.z, s), l = r && fits(-c.x, c.z, s);
        if ((!r || !l) && s > 1) { s = 1; r = fits(c.x, c.z, s); l = r && fits(-c.x, c.z, s); }
        if (!r || !l) continue;
        const y = Math.min(r.y, l.y);
        for (const m of [1, -1]) plan.push({ x: c.x * m, y, z: c.z, s, sk, side: m, ord: ord++ });
        blockers.push(r.box, l.box);
        extra -= 2; if (sk === 'ir') ir = Math.max(0, ir - 2);
      }
    }
    if (extra === 1) { // one odd round: try the centreline
      const sk = ir > 0 ? 'ir' : 'arh', s = sk === 'arh' ? 1.2 : 1;
      for (const c of cands) { const r = fits(0, c.z, s); if (r) { plan.push({ x: 0, y: r.y, z: c.z, s, sk, side: 1, ord: ord++ }); blockers.push(r.box); break; } }
    }
    return plan;
  }

  function addLoadoutStations(g, di, pt, need) {
    if (!g || !need || !DES[di]) return;
    // Seekers on the model's own std stations: IR on the wingtip rails / outermost first, radar on the rest
    const existing = [];
    g.traverse(o => { if (o.name === 'ld' && o.userData && o.userData.k === 'std' && !o.userData.pod) existing.push(o); });
    existing.sort((a, b) => ((b.userData.rail | 0) - (a.userData.rail | 0)) || (Math.abs(b.position.x) - Math.abs(a.position.x)));
    existing.forEach((o, i) => { o.userData.sk = i < (need.ir | 0) ? 'ir' : 'arh'; o.userData.ord = i; });
    let spOrd = 0;
    g.traverse(o => { if (o.name === 'ld' && o.userData && o.userData.k === 'sp') o.userData.ord = spOrd++; });

    const plan = pePlan(g, di, need);
    if (!plan.length) return;
    const pal = mkPal(pt || FACT[0]);
    for (const q of plan) {
      const r = 0.14 * q.s, my = q.y - r - 0.07;
      const py = new THREE.Group();
      py.name = 'pylon';
      py.position.set(q.x, q.y, q.z);
      py.add(mkMesh(compile([box([q.x, q.y - 0.035, q.z], [0.045, 0.04, 0.62 * q.s], 'metal')], pal, [q.x, q.y, q.z])));
      g.add(py);
      const sg = new THREE.Group();
      sg.name = 'ld';
      sg.position.set(q.x, my, q.z);
      sg.userData = { k: 'std', s: q.side, sk: q.sk, rail: 0, bay: 0, pod: 0, bomb: 0, extra: 1, ord: q.ord };
      sg.add(mkMesh(compile(missile([q.x, my, q.z], q.s, q.sk === 'arh' ? 'acc' : undefined), pal, [q.x, my, q.z])));
      g.add(sg);
    }
  }

  // Wrap buildJet again so splitJetRails (and, for your own jet, the loadout stations) run after stock buildJet + swing-wing reparenting
  {
    const _bj2 = buildJet;
    buildJet = function (di, pt, sp) {
      const g = _bj2.apply(this, arguments);
      try { splitJetRails(g, di, pt, sp); } catch (e) {}
      if (PE_STA.need) { try { addLoadoutStations(g, di, pt, PE_STA.need); } catch (e) { console.warn('[plane-engine] stations', e); } }
      return g;
    };
  }

  // Your jet in a sortie and in the hangar gets the full loadout on the model
  if (typeof buildPJ === 'function') {
    const _bpj = buildPJ;
    buildPJ = function () {
      PE_STA.need = peNeedNow();
      try { return _bpj.apply(this, arguments); }
      finally {
        PE_STA.need = null;
        // A rebuild in the middle of a sortie (stage separation, phase change) must not bring fired missiles back
        try { if (st === 1) peApplyVisibility(); } catch (e) {}
      }
    };
  }
  if (typeof buildHJ === 'function') {
    const _bhj = buildHJ;
    buildHJ = function () {
      PE_STA.need = peNeedNow();
      try { return _bhj.apply(this, arguments); } finally { PE_STA.need = null; }
    };
  }

  if (typeof start === 'function') {
    const origStart = start;
    start = function () {
      const r = origStart.apply(this, arguments);
      try {
        peSyncAmmoToStations();
        peApplyVisibility();
      } catch (e) {}
      return r;
    };
  }

  // Ensure the on-screen MSL button (#bMsl) always invokes the latest wrapped fireMsl() (ASKIIES bound the old ref at boot)
  try {
    const bMslEl = document.getElementById('bMsl');
    if (bMslEl) {
      bMslEl.addEventListener('pointerdown', e => {
        if (!OPT.rrail || (typeof VEHM !== 'undefined' && VEHM) || st !== 1) return;
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (typeof au === 'function') au();
        if (typeof fireMsl === 'function') fireMsl();
      }, true);
    }
  } catch (e) {}

  // Clone actual store mesh off the rail with an active glowing exhaust flame for launched missiles
  function cloneRailProjectileMesh(railGroup, isBomb) {
    const g = new THREE.Group();
    const copy = railGroup.clone(true);
    copy.position.set(0, 0, 0);
    copy.quaternion.identity();
    copy.scale.set(1, 1, 1);
    copy.visible = true;
    g.add(copy);
    if (!isBomb && typeof FLG !== 'undefined' && typeof FLM !== 'undefined') {
      const f = new THREE.Mesh(FLG, makeAbMat(0xff9a38, true));
      f.name = 'mf';
      f.rotation.x = PI / 2;
      f.position.z = 1.65;
      f.scale.set(0.6, 1.1, 0.6);
      f.visible = true;
      g.add(f);
    }
    g.scale.setScalar(1.8);
    g.userData.isRailProjectile = true;
    return g;
  }

  // Which visible station this shot leaves from (null = it comes from inside the jet)
  function peTakeStation(kind) {
    const vis = peStations(kind).filter(o => o.visible);
    if (vis.length <= peLeft(kind)) return null; // counts were already lowered by the caller, so more showing than left = this one goes
    return vis[vis.length - 1];
  }

  // Run the stock launcher with every station of that weight class hidden, so it never picks or regrows one itself
  function peRunHidden(want, fn, self, args) {
    const prevVis = [];
    for (const o of pp.ld) { if (o.visible && o.userData.k === want) { prevVis.push(o); o.visible = false; } }
    try { return fn.apply(self, args); }
    finally {
      for (const o of prevVis) o.visible = true;
      if (P.rl) P.rl.length = 0;
    }
  }

  function peDressShot(railObj, railPos, railMesh, nBefore, isBomb) {
    if (!railObj || mi.length <= nBefore) return;
    const m = mi[mi.length - 1];
    if (railPos) m.p.copy(railPos);
    if (railMesh) {
      if (m.m) S.remove(m.m);
      m.m = railMesh;
      m.m.position.copy(m.p);
      m.m.quaternion.copy(P.q);
      S.add(m.m);
    }
    if (!isBomb && typeof pt === 'function' && railPos) {
      for (let i = 0; i < 4; i++) {
        pt(railPos.x, railPos.y, railPos.z, P.v.x * 0.7 + rnd(-6, 6), P.v.y * 0.7 + rnd(-4, 4), P.v.z * 0.7 + rnd(-6, 6), 0.55, 1.8, 'o:.', ['#ffffff', '#dde4ec', '#aab4c0'], 0, 2.2);
      }
    }
  }

  // Wrap launch(): the missile leaves its own station (its real 3D model flies away) and the station stays empty until you rearm
  if (typeof launch === 'function') {
    const origLaunch = launch;
    launch = function (tg, Wp, sp) {
      if (!OPT.rrail || !pp || !pp.ld || OPT.ac === 11) return origLaunch.apply(this, arguments);
      const kind = sp ? 'sp' : (Wp && Wp.sk === 'ir' ? 'ir' : 'arh');
      const railObj = peTakeStation(kind);
      let railPos = null, railMesh = null;
      if (railObj) {
        PJ.updateMatrixWorld(true);
        railPos = railObj.getWorldPosition(new Vv());
        railMesh = cloneRailProjectileMesh(railObj, !!railObj.userData.bomb);
        railObj.visible = false;
      }
      const nBefore = mi.length;
      peRunHidden(sp ? 'sp' : 'std', origLaunch, this, arguments);
      peDressShot(railObj, railPos, railMesh, nBefore, false);
    };
  }

  // Wrap dropBomb() the same way: bombs fall off their own rack and stay gone until RTB rearm
  if (typeof dropBomb === 'function') {
    const origDropBomb = dropBomb;
    dropBomb = function () {
      if (!OPT.rrail || !pp || !pp.ld || OPT.ac === 11) return origDropBomb.apply(this, arguments);
      const railObj = peTakeStation('sp');
      let railPos = null, railMesh = null;
      if (railObj) {
        PJ.updateMatrixWorld(true);
        railPos = railObj.getWorldPosition(new Vv());
        railMesh = cloneRailProjectileMesh(railObj, true);
        railObj.visible = false;
      }
      const nBefore = mi.length;
      peRunHidden('sp', origDropBomb, this, arguments);
      peDressShot(railObj, railPos, railMesh, nBefore, true);
    };
  }

  // Wrap fireMsl() so multi-lock SP salvos (4AAM / 4AGM) never fire more rounds than you have
  if (typeof fireMsl === 'function') {
    const origFireMsl = fireMsl;
    fireMsl = function () {
      if (!OPT.rrail || st !== 1 || !P || P.dead || P.mcd > 0 || CIN) return origFireMsl.apply(this, arguments);
      if (P.wp) {
        const Wp = (typeof SPW !== 'undefined') ? SPW[OPT.sp] : null;
        if (Wp && Wp.lk > 1) {
          if (P.sp <= 0) { msg('NO SP WEAPON · RTB TO REARM', HR); return; }
          const locked = (P.cands || []).filter(e => e.lk >= 1);
          const count = Math.min(P.sp, Math.max(1, locked.length));
          P.sp -= count;
          P.mcd = Wp.cd * (A.scd || 1);
          if (!locked.length) launch(null, Wp, 1);
          else for (let i = 0; i < count; i++) launch(locked[i], Wp, 1);
          if (!P.ms && !P.sp) msg('WINCHESTER · RTB TO REARM', HY, 1);
          return;
        }
      }
      const r = origFireMsl.apply(this, arguments);
      if (!P.ms && !P.sp && !P.wp) msg('WINCHESTER · RTB TO REARM', HY, 1);
      return r;
    };
  }

  // Stores come back ONLY when you actually rearm at your HOME base/carrier
  if (typeof rearmTick === 'function') {
    const origRearm = rearmTick;
    rearmTick = function (dt) {
      const before = P ? P.rrT : -99;
      origRearm.apply(this, arguments);
      if (OPT.rrail && P && P.rrT !== before && pp && pp.ld) {
        peSyncAmmoToStations();
        peApplyVisibility();
      }
    };
  }

  // Keep swing-wing pylons aligned with airflow alongside their stores
  if (typeof swcFix === 'function') {
    const origSwcFix = swcFix;
    swcFix = function (root) {
      origSwcFix.apply(this, arguments);
      if (!root) return;
      root.traverse(o => {
        if (o.userData && o.userData.swc && o.name === 'pylon' && o.parent) {
          o.quaternion.copy(o.parent.quaternion).invert();
        }
      });
    };
  }

  // ---------- 8. OPTIONAL MOUSE CONTROL MODE (OPT.mctrl: 0 = OFF, 1 = MOUSE AIM, 2 = VIRTUAL STICK) ----------
  if (OPT.mctrl == null) OPT.mctrl = 0;
  LISTS.mctrl = () => ['OFF', 'MOUSE AIM', 'VIRTUAL STICK'];

  const MC = {
    x: 0, y: 0, init: 0,
    lmb: 0,
    jx: 0, jy: 0,
    aimV: new THREE.Vector3(),
    hRight: new THREE.Vector3(),
    projV: new THREE.Vector3()
  };

  function isMouseFlightOn() {
    return (OPT.mctrl | 0) > 0 && st === 1 && !CIN && P && !P.dead && !(typeof VEHM !== 'undefined' && VEHM);
  }

  // ---- MOUSE AIM v2 (v1.7.0): captured mouse steering a direction in the world ----
  // The old MOUSE AIM steered toward the cursor's spot on the screen, so the hardest turn you could
  // ask for was wherever the screen ended. Now the first click in flight captures the mouse (pointer
  // lock; ESC frees it) and moving the mouse swings an aim direction in the world, War Thunder style:
  // keep moving the mouse and the jet keeps turning. With CAMERA HORIZON = LEVEL the camera looks along
  // the aim too (9b), so the aim circle stays near the middle and the jet flies into it.
  // Without the capture (ESC pressed, or the browser refused) the old cursor steering still works.
  if (OPT.msens == null) OPT.msens = 1;
  LISTS.msens = () => ['SLOW', 'NORMAL', 'FAST', 'VERY FAST'];
  const MSENS = [.0013, .002, .003, .0044];          // radians of aim per mouse count
  Object.assign(MC, {
    aim: new THREE.Vector3(0, 0, -1), rt: new THREE.Vector3(1, 0, 0), tmp: new THREE.Vector3(),
    q: new THREE.Quaternion(), Y: new THREE.Vector3(0, 1, 0), sx: 0, sy: 0, want: 0
  });
  const hudCanvas = () => document.getElementById('hud') || document.querySelector('canvas') || document.body;
  const aimCaptured = () => (OPT.mctrl | 0) === 1 && !!document.pointerLockElement && isMouseFlightOn();
  function aimReset() { if (P && P.f) MC.aim.copy(P.f); }
  const aimLim = () => ((OPT.camh | 0) === 1 ? .8 : .42);      // cone around the nose (radians): ~46° / ~24°
  function aimClamp(slack) {
    // keep the aim inside a cone around the nose: wide when the camera follows the aim (LEVEL),
    // otherwise small enough to stay on screen. Never quite vertical (no flip over the top).
    const lim = aimLim() + (slack || 0), c = Math.cos(lim), d = MC.aim.dot(P.f);
    if (d < c) {
      MC.tmp.copy(MC.aim).addScaledVector(P.f, -d);
      if (MC.tmp.lengthSq() < 1e-8) MC.tmp.copy(P.u);
      MC.tmp.normalize();
      MC.aim.copy(P.f).multiplyScalar(c).addScaledVector(MC.tmp, Math.sin(lim));
    }
    if (Math.abs(MC.aim.y) > .985) {
      let hx = MC.aim.x, hz = MC.aim.z, hl = Math.hypot(hx, hz);
      if (hl < 1e-4) { hx = P.f.x; hz = P.f.z; hl = Math.hypot(hx, hz) || 1; }
      const k = Math.sqrt(1 - .985 * .985) / hl;
      MC.aim.set(hx * k, Math.sign(MC.aim.y) * .985, hz * k);
    }
    MC.aim.normalize();
  }
  function aimTurn(dx, dy) {
    const s = MSENS[OPT.msens | 0] || MSENS[1], cosLim = Math.cos(aimLim());
    // each axis on its own: a move that would push the aim past the cone edge is dropped (the aim
    // waits there while the jet catches up) instead of dragging the aim toward the nose, which made
    // it creep up or down during hard turns
    const d0 = MC.aim.dot(P.f);
    MC.q.setFromAxisAngle(MC.Y, -dx * s); MC.aim.applyQuaternion(MC.q);         // mouse right = aim right
    let d1 = MC.aim.dot(P.f);
    if (d1 < cosLim && d1 < d0) MC.aim.applyQuaternion(MC.q.invert());
    const d2 = MC.aim.dot(P.f);
    MC.tmp.crossVectors(MC.aim, MC.Y);
    if (MC.tmp.lengthSq() > 1e-4) MC.rt.copy(MC.tmp).normalize();
    MC.q.setFromAxisAngle(MC.rt, -dy * s); MC.aim.applyQuaternion(MC.q);        // mouse up = aim up
    d1 = MC.aim.dot(P.f);
    if (d1 < cosLim && d1 < d2) MC.aim.applyQuaternion(MC.q.invert());
    aimClamp(.15);                                                              // only the vertical limit + big slips
  }
  function aimGrab() {
    const el = hudCanvas();
    if (!el || !el.requestPointerLock || document.pointerLockElement) return;
    try { const r = el.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
  }
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) aimReset(); });
  window.__peAimCam = () => aimCaptured() && !window.__ampLook;   // LEVEL camera looks along the aim (9b)

  // Intercept desktop mouse events ONLY when Mouse Control is turned ON (keeps default controls 100% untouched when OFF!)
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    if (document.pointerLockElement) {
      // captured: the cursor is frozen; relative movement swings the aim (not while right-drag looking)
      if (aimCaptured() && !window.__ampLook) aimTurn(e.movementX || 0, e.movementY || 0);
      return;
    }
    MC.x = e.clientX;
    MC.y = e.clientY;
    MC.init = 1;
  }, true);

  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || !isMouseFlightOn()) return;
    if (e.target && e.target.closest && e.target.closest('.b,#pz')) return;
    if (!document.pointerLockElement) { MC.x = e.clientX; MC.y = e.clientY; MC.init = 1; }
    if (e.button === 0 && (OPT.mctrl | 0) === 1 && !document.pointerLockElement) aimGrab();   // click = capture the mouse
    if (e.button === 0) {
      // Left-click fires guns; stop propagation so touch-joystick drag doesn't hijack it
      au();
      MC.lmb = 1;
      keys.Gun = 1;
      e.stopImmediatePropagation();
    }
    // Middle-click = target lock (the game's __alk); right-button drag = look around (mp-client.js).
    // Missiles stay on X / the missile key.
  }, true);

  addEventListener('pointerup', e => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0 && MC.lmb) {
      MC.lmb = 0;
      keys.Gun = 0;
    }
  }, true);

  addEventListener('blur', () => {
    if (MC.lmb) { MC.lmb = 0; keys.Gun = 0; }
    MC.jx = 0; MC.jy = 0;
  });

  // Scroll wheel controls throttle in Mouse Mode (like most flight games)
  addEventListener('wheel', e => {
    if (!isMouseFlightOn()) return;
    P.thr = cl(P.thr + (e.deltaY < 0 ? 0.06 : -0.06), 0, 1);
  }, { passive: true });

  // v1.3: the old F2 hotkey is gone. F2 is the game's FULLSCREEN key, so going fullscreen also
  // switched mouse steering on and the jet started chasing the cursor ("camera comes loose").
  // Mouse control is now set only in OPTIONS > MOUSE CONTROL. Anyone the old hotkey flipped
  // on gets it reset once.
  if (!OPT.mctrlV) { OPT.mctrlV = 1; if (OPT.mctrl) { OPT.mctrl = 0; try { save(); } catch (e) {} } }

  // Compute mouse-aim instructor or Virtual Stick steering into jx / jy right before update()
  if (typeof update === 'function') {
    const _uM = update;
    update = function (dt) {
      if (OPT.rrail && P && P.rl && P.rl.length) P.rl.length = 0;
      const wasSvcd = P ? !!P.svcd : false;

      // leaving flight (hangar, pause, death, cutscene, ground vehicle) gives the mouse back
      if (document.pointerLockElement && !((OPT.mctrl | 0) === 1 && isMouseFlightOn())) { try { document.exitPointerLock(); } catch (e) {} }
      // right-drag look-around pauses cursor steering; a captured aim keeps flying toward where it was left
      if (isMouseFlightOn() && js === null && (!window.__ampLook || aimCaptured())) {
        if (!MC.init) { MC.x = CW_ * 0.5; MC.y = CH_ * 0.5; MC.init = 1; }
        const kbManual = !!(keys.ArrowLeft || keys.ArrowRight || keys.ArrowUp || keys.ArrowDown || keys.KeyA || keys.KeyD || keys.KeyW || keys.KeyS);
        if (kbManual) {
          // Keyboard always overrides cleanly whenever pressed (a captured aim rides along with the
          // nose, so letting go of the keys after a keyboard loop does not snap the jet back)
          if (aimCaptured()) aimReset();
          MC.jx = lp(MC.jx, 0, Math.min(1, dt * 10));
          MC.jy = lp(MC.jy, 0, Math.min(1, dt * 10));
        } else if ((OPT.mctrl | 0) === 1) {
          // MOUSE AIM INSTRUCTOR: unproject cursor ray -> smooth bank & pitch onto aim circle
          if (aimCaptured()) {
            aimClamp(.15);
            MC.aimV.copy(MC.aim);
          } else {
            const ndcX = (MC.x / Math.max(1, CW_)) * 2 - 1;
            const ndcY = -(MC.y / Math.max(1, CH_)) * 2 + 1;
            MC.aimV.set(ndcX, ndcY, 0.5).unproject(C).sub(C.position).normalize();
          }

          // INSTRUCTOR (v1.7): body-frame "roll the aim into the lift line, then pull", blended into
          // "wings level + small nudges" near the aim. The old one banked by the world-horizontal error,
          // which oscillated (bank swinging 10° <-> 110°) in climbs and big turns and never settled.
          const lx = MC.aimV.dot(P.r);
          const ly = MC.aimV.dot(P.u);
          const lz = MC.aimV.dot(P.f);
          const err = Math.acos(cl(lz, -1, 1));                        // radians off the nose
          // roll rate (for damping), from how P.r turned about the nose since last frame
          if (!MC.pr) MC.pr = P.r.clone();
          const rRate = dt > 0 ? Math.asin(cl(MC.tmp.crossVectors(MC.pr, P.r).dot(P.f), -1, 1)) / dt : 0;
          MC.pr.copy(P.r);
          const b = cl((err - 0.05) / 0.16, 0, 1);                      // 0 near the aim (~3°), 1 beyond ~12°
          // far: roll so the aim sits straight "above" the canopy (into the lift line), pull once lined up
          const rollTo = Math.atan2(lx, ly);                            // + = roll right
          const farRoll = cl(rollTo * 1.7, -1, 1);
          const farPitch = cl(err * 3, 0, 1) * Math.max(0, Math.cos(rollTo)) + (lz < 0.2 ? 0.35 : 0);
          // near: level the wings, bank a little toward a side error, pitch straight onto the aim
          const nearRoll = cl(P.r.y * 1.4 + lx * 7, -0.6, 0.6);
          const nearPitch = cl(ly * 6, -0.6, 0.8);
          const rollCmd = cl(lp(nearRoll, farRoll, b) - rRate * 0.12, -1, 1);
          let pitchCmd = cl(lp(nearPitch, farPitch, b), -0.85, 1.0);
          // stall protection: ease the pull as the wing nears the stall (P.sf), like a real instructor
          if (pitchCmd > 0 && (P.sf || 0) > 0.12) pitchCmd *= 1 - cl(((P.sf || 0) - 0.12) / 0.3, 0, 0.75);
          const sm = Math.min(1, dt * 11);
          MC.jx = lp(MC.jx, rollCmd, sm);
          MC.jy = lp(MC.jy, pitchCmd, sm);
        } else {
          // VIRTUAL STICK: analog stick from screen center with crisp deadzone
          const rad = Math.min(CW_, CH_) * 0.34;
          const dx = (MC.x - CW_ * 0.5) / Math.max(40, rad);
          const dy = -(MC.y - CH_ * 0.5) / Math.max(40, rad);
          const mag = Math.hypot(dx, dy);
          const dz = 0.06;
          if (mag <= dz) {
            MC.jx = lp(MC.jx, 0, Math.min(1, dt * 12));
            MC.jy = lp(MC.jy, 0, Math.min(1, dt * 12));
          } else {
            const sc = cl((mag - dz) / (1 - dz), 0, 1) / mag;
            const inv = OPT.pinv ? -1 : 1;
            MC.jx = lp(MC.jx, cl(dx * sc, -1, 1), Math.min(1, dt * 14));
            MC.jy = lp(MC.jy, cl(dy * sc * inv, -1, 1), Math.min(1, dt * 14));
          }
        }
        jx = MC.jx;
        jy = MC.jy;
      } else if (js === null && (MC.jx !== 0 || MC.jy !== 0)) {
        MC.jx = 0; MC.jy = 0;
        jx = 0; jy = 0;
        if (MC.lmb) { MC.lmb = 0; keys.Gun = 0; }
      }
      const res = _uM.apply(this, arguments);
      if (OPT.rrail && P) {
        if (P.rl && P.rl.length) P.rl.length = 0;
        if (!wasSvcd && P.svcd && pp && pp.ld) {
          try { peSyncAmmoToStations(); peApplyVisibility(); } catch (e) {}
        }
      }
      return res;
    };
  }

  // Draw crisp Mouse Aim Circle + Boresight Cross on HUD when Mouse Mode is ON
  if (typeof flightHUD === 'function') {
    const origFlightHUD = flightHUD;
    flightHUD = function () {
      origFlightHUD.apply(this, arguments);
      if (!isMouseFlightOn() || HUDOFF) return;
      try {
        U.save();
        U.shadowBlur = 0;
        const m = OPT.mctrl | 0;
        if (m === 1) {
          // Project jet's current boresight nose vector onto screen
          MC.projV.copy(P.p).addScaledVector(P.f, 600).project(C);
          const nx = (MC.projV.x * 0.5 + 0.5) * CW_;
          const ny = (-MC.projV.y * 0.5 + 0.5) * CH_;
          let mx = MC.x, my = MC.y;
          if (aimCaptured()) {
            // captured: the circle sits where the world aim direction lands on screen (kept on screen)
            MC.tmp.copy(P.p).addScaledVector(MC.aim, 600).project(C);
            const bh = MC.tmp.z > 1 ? -1 : 1;
            mx = cl((MC.tmp.x * bh * 0.5 + 0.5) * CW_, 20 * UF, CW_ - 20 * UF);
            my = cl((-MC.tmp.y * bh * 0.5 + 0.5) * CH_, 20 * UF, CH_ - 20 * UF);
          }
          MC.sx = mx; MC.sy = my;

          // Subtle dashed guide line from nose to mouse aim circle when turning
          if (MC.projV.z < 1 && Math.hypot(mx - nx, my - ny) > 22 * UF) {
            U.strokeStyle = 'rgba(116, 255, 184, 0.35)';
            U.lineWidth = 1.2;
            U.setLineDash([4, 4]);
            U.beginPath();
            U.moveTo(nx, ny);
            U.lineTo(mx, my);
            U.stroke();
            U.setLineDash([]);
          }

          // Small nose boresight '+' indicator
          if (MC.projV.z < 1) {
            const s = 6 * UF;
            U.strokeStyle = 'rgba(242, 255, 248, 0.78)';
            U.lineWidth = 1.5;
            U.beginPath();
            U.moveTo(nx - s, ny); U.lineTo(nx + s, ny);
            U.moveTo(nx, ny - s); U.lineTo(nx, ny + s);
            U.stroke();
          }

          // mouse aim circle at cursor
          const r = 17 * UF;
          U.strokeStyle = MC.lmb ? '#ffe45e' : 'rgba(116, 255, 184, 0.92)';
          U.lineWidth = 1.8;
          U.beginPath();
          U.arc(mx, my, r, 0, PI * 2);
          U.stroke();
          // 4 crisp outer ticks + center pip
          U.beginPath();
          U.moveTo(mx - r - 4, my); U.lineTo(mx - r + 2, my);
          U.moveTo(mx + r - 2, my); U.lineTo(mx + r + 4, my);
          U.moveTo(mx, my - r - 4); U.lineTo(mx, my - r + 2);
          U.moveTo(mx, my + r - 2); U.lineTo(mx, my + r + 4);
          U.stroke();
          U.fillStyle = MC.lmb ? '#ffe45e' : '#74ffb8';
          U.fillRect(mx - 1.5, my - 1.5, 3, 3);
        } else if (m === 2) {
          // Virtual stick center deadzone ring + stick line
          const cx = CW_ * 0.5, cy = CH_ * 0.5;
          const r0 = Math.min(CW_, CH_) * 0.34 * 0.06;
          U.strokeStyle = 'rgba(116, 255, 184, 0.38)';
          U.lineWidth = 1.2;
          U.beginPath(); U.arc(cx, cy, r0, 0, PI * 2); U.stroke();
          U.beginPath(); U.moveTo(cx, cy); U.lineTo(MC.x, MC.y); U.stroke();
          U.fillStyle = '#74ffb8';
          U.beginPath(); U.arc(MC.x, MC.y, 4 * UF, 0, PI * 2); U.fill();
        }

        // Compact bottom hint
        const hint = (m === 1 ? 'MOUSE AIM' : 'VIRTUAL STICK') + '  ·  LMB GUN  ·  WHEEL THR  ·  X MSL  ·  MIDDLE-CLICK LOCK  ·  RIGHT-DRAG LOOK';
        tx(hint, CW_ * 0.5, CH_ - SA.b - (rcur ? 94 : 26) * UF, 'rgba(116, 255, 184, 0.85)', 'center', 8);
        if (m === 1 && !document.pointerLockElement && document.body.classList.contains('desk'))
          tx('CLICK TO CAPTURE THE MOUSE  ·  ESC GIVES IT BACK', CW_ * 0.5, CH_ - SA.b - (rcur ? 108 : 40) * UF, Math.sin(rt * 5) > 0 ? '#ffe45e' : 'rgba(255, 228, 94, 0.6)', 'center', 9);
        U.restore();
      } catch (e) {}
    };
  }

  // MIDDLE-CLICK lock while the mouse is captured: the cursor is frozen, so lock what is under the aim circle
  if (typeof window.__alk === 'function') {
    const _alk = window.__alk;
    window.__alk = function (ev) {
      if (aimCaptured() && ev) ev = { button: ev.button, clientX: MC.sx || CW_ / 2, clientY: MC.sy || CH_ / 2, preventDefault() {}, stopPropagation() {} };
      return _alk.call(this, ev);
    };
  }

  // ---------- 9. Upgrade Already-Built Aircraft on Boot (HJ, PJ, EJT) ----------
  try {
    syncModeUniforms();
    if (typeof EJT !== 'undefined' && Array.isArray(EJT)) {
      EJT.forEach(j => upgradeJetVisuals(j, null));
    }
    if (typeof HJ !== 'undefined' && HJ) {
      splitJetRails(HJ, ACS[OPT.ac].d, OPT.paint && OPT.paint[OPT.ac], OPT.sp);
      upgradeJetVisuals(HJ, OPT.paint && OPT.paint[OPT.ac]);
      addLoadoutStations(HJ, ACS[OPT.ac].d, OPT.paint && OPT.paint[OPT.ac], peNeedNow());
    }
    if (typeof PJ !== 'undefined' && PJ) {
      splitJetRails(PJ, A.d, OPT.paint && OPT.paint[OPT.ac], OPT.sp);
      upgradeJetVisuals(PJ, OPT.paint && OPT.paint[OPT.ac]);
    }
    if (typeof HS !== 'undefined' && HS) smoothObjectMeshes(HS);
  } catch (e) {
    console.warn('[plane-engine] Initial mesh upgrade warning:', e);
  }

  try {
    if (typeof ULOG !== 'undefined' && Array.isArray(ULOG)) for (const u of ULOG) {
      if (u && Array.isArray(u.notes)) u.notes = u.notes.map(t => typeof t === 'string' ? t.replace(/War Thunder[ -]style/gi, 'next-gen').replace(/War Thunder/gi, 'next-gen') : t);
    }
  } catch (e) {}

  // ---------- 9b. CAMERA ----------
  // The camera no longer frames / locks onto targets: always the plain chase view (the game's
  // CAMERA = CLASSIC). The ENGAGE option is removed from OPTIONS (hangar-menu.js). Look around
  // with the right mouse button instead (mp-client.js), or J/L/I/K.
  OPT.cam = 1;
  if (LISTS.cam) LISTS.cam = () => ['ENGAGE', 'CLASSIC'];
  // (kept for anyone who turns ENGAGE back on in code) sticky ENGAGE lock + CAMERA DISTANCE
  // ENGAGE (OPTIONS > CAMERA) frames your jet and your target. In the game it follows the auto-target
  // (P.tg), which re-scores every frame by angle-off-nose, so an enemy swinging behind you lost the
  // camera to whoever was in front. It also dropped the framing inside 140 m, right in the knife fight.
  // Now the camera keeps the enemy it is framing until that enemy dies, stays out of range for 2 s,
  // or you pick another target yourself (T / right-click lock). Weapon targeting is unchanged.
  if (typeof camFocus === 'function' && typeof CAMF !== 'undefined') {
    camFocus = function (dt) {   // eslint-disable-line no-global-assign
      const ok = e => !!e && en.includes(e);
      const T_ = ok(P.tg) ? P.tg : null;
      const man = ok(P.mtg) && P.mtT > 0 ? P.mtg : null;          // a target the player picked by hand
      let E = ok(CAMF.e) ? CAMF.e : null;
      if (E) {
        const rng = E.ty === 'air' ? 3200 : (E.ty === 'part' || E.boss ? 2600 : 3600);
        CAMF.far = (E.d || 0) > rng ? (CAMF.far || 0) + dt : 0;
        if (CAMF.far > 2) { E = null; CAMF.far = 0; }
      }
      if (man && man !== E) E = man;                                   // manual pick wins at once
      else if (!E) {                                                   // nothing framed: take the auto-target once it settles
        if (T_ && T_ === CAMF.c) CAMF.h += dt; else { CAMF.c = T_; CAMF.h = 0; }
        if (T_ && CAMF.h > .35) E = T_;
      } else if (T_ && T_ !== E) {                                     // auto-target moved on: stay, unless ours is far away
        CAMF.sw = (CAMF.sw || 0) + dt;                                 // and the new one is much closer for a while
        if (CAMF.sw > 4 && (E.d || 0) > 1500 && (T_.d || 0) < (E.d || 0) * .6) { E = T_; CAMF.sw = 0; }
      } else CAMF.sw = 0;
      if (E !== CAMF.e) { const was = CAMF.e; CAMF.e = E; if (E && !was) CAMF.p.copy(E.p); }
      if (!E) { CAMF.e = null; return; }
      CAMF.p.lerp(E.p, Math.min(1, dt * (E.ty === 'air' ? 4 : 2.2)));
      CAMF.d = Math.max(141, CAMF.p.distanceTo(P.p));               // keep framing in close fights (game cut-off is 140 m)
    };
  }
  // CAMERA DISTANCE: scales the chase camera's offset (plain chase and ENGAGE framing alike).
  // The game's camera sat only ~32 m behind the jet; NORMAL is now 35% further back.
  if (OPT.camd == null) OPT.camd = 1;
  LISTS.camd = () => ['CLOSE', 'NORMAL', 'FAR', 'WIDE'];
  const CAMD = [1, 1.35, 1.7, 2.1];
  // CAMERA HORIZON = LEVEL: a horizon-locked chase camera, the way War Thunder's mouse-aim camera
  // behaves: the camera rig's "up" is always the world's up, it follows your heading and climb
  // (smoothed), and the jet rolls, loops and flies inverted inside a view that never tilts.
  // Camera pitch is capped at ~72 deg so it never flips; over the top of a loop it swings round
  // to the new heading smoothly instead. ENGAGE target framing still works on top of it.
  if (OPT.camh == null) OPT.camh = 1;
  LISTS.camh = () => ['ROLLS WITH JET', 'LEVEL'];
  const HZ = { init: 0, yaw: 0, pitch: 0, d: new THREE.Vector3(), fw: new THREE.Vector3(), rt: new THREE.Vector3(), up: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), Y: new THREE.Vector3(0, 1, 0) };
  const hzOn = () => (OPT.camh | 0) === 1 && st === 1 && P && !P.dead && !P.gone && OPT.view !== 1
    && !(typeof VEHM !== 'undefined' && VEHM) && !(typeof CIN !== 'undefined' && CIN);
  function hzStep(dt) {
    // MOUSE AIM with a captured mouse: the camera looks along the aim (snappy), not the nose
    const fa = !!(window.__peAimCam && window.__peAimCam()), f = fa ? MC.aim : P.f;
    if (!HZ.init || !(dt > 0) || dt > .5) { HZ.d.copy(f); HZ.yaw = Math.atan2(f.x, f.z); HZ.pitch = Math.max(-1.25, Math.min(1.25, Math.asin(Math.max(-1, Math.min(1, f.y))))); HZ.init = 1; }
    HZ.d.lerp(f, 1 - Math.exp(-(fa ? 16 : 5) * dt)).normalize();
    const h = Math.hypot(HZ.d.x, HZ.d.z);
    const pT = Math.max(-1.25, Math.min(1.25, Math.atan2(HZ.d.y, h)));       // cap ~72 deg
    if (h > .12) {                                                             // near vertical: hold heading
      let dy = Math.atan2(HZ.d.x, HZ.d.z) - HZ.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      HZ.yaw += Math.sign(dy) * Math.min(Math.abs(dy), (fa ? 6 + 6 * Math.abs(dy) : 1.5 + 2 * Math.abs(dy)) * dt);   // smooth swing over the top
    }
    HZ.pitch += (pT - HZ.pitch) * Math.min(1, dt * (fa ? 16 : 8));
    const cp = Math.cos(HZ.pitch);
    HZ.fw.set(Math.sin(HZ.yaw) * cp, Math.sin(HZ.pitch), Math.cos(HZ.yaw) * cp);
    HZ.rt.crossVectors(HZ.fw, HZ.Y).normalize();
    HZ.up.crossVectors(HZ.rt, HZ.fw).normalize();
  }
  if (typeof camSpring === 'function' && typeof CAMF !== 'undefined') {
    const _cs = camSpring;
    camSpring = function (x, v, goal, dt, w) {   // eslint-disable-line no-global-assign
      const flight = goal && st !== 3 && !(typeof VEHM !== 'undefined' && VEHM);
      const lvl = flight && (v === CAMF.cv || v === CAMF.lv) && hzOn();
      if (!lvl && v === CAMF.cv) HZ.init = 0;
      if (lvl) {
        const CK = window.CAMK || 1, ps = P.psm || 0;
        if (v === CAMF.cv) {
          hzStep(dt);
          // keep whatever ENGAGE added on top of the plain chase offset, swap the rolling chase for the level one
          HZ.a.set(0, (7 + ps * 5) * CK, (32 + ps * 20) * CK).applyQuaternion(cq);
          goal.sub(HZ.a).addScaledVector(HZ.fw, -(32 + ps * 20) * CK).addScaledVector(HZ.up, (7 + ps * 5) * CK);
          try { cu.copy(HZ.Y); } catch (e) {}                                  // camera up = world up
        } else {
          HZ.b.set(0, 5, -80).applyQuaternion(cq);
          goal.sub(HZ.b).addScaledVector(HZ.fw, 80).addScaledVector(HZ.up, 5);
        }
      }
      // CAMERA DISTANCE: only the flight chase camera's position spring (its velocity vector is CAMF.cv)
      if (v === CAMF.cv && flight) {
        const f = CAMD[OPT.camd | 0] || 1;
        if (f !== 1) goal.multiplyScalar(f);
      }
      return _cs.apply(this, arguments);
    };
  }

  // ---------- 10. Inject Options Rows (AIRCRAFT STYLE, RAIL STORES, MOUSE CONTROL) ----------
  try {
    const rows = PAGES && PAGES.opt && PAGES.opt.rows;
    if (Array.isArray(rows) && !rows.some(r => r.k === 'pmode')) {
      const idx = Math.max(1, rows.findIndex(r => r.k === 'tmode' || r.k === 'tres'));
      rows.splice(idx, 0,
        {
          l: 'AIRCRAFT MODELS',
          k: 'pmode',
          d: 'NEXT-GEN CEL 3D: bold ink outlines, punchy cel shading, panel lines, rivets & Mach-diamond afterburners. NEXT-GEN REALISTIC 3D: smooth shading, no outlines. CLASSIC CEL: original flat look.'
        },
        {
          l: 'RAIL STORES',
          k: 'rrail',
          d: 'REAL RAILS: every missile in your loadout hangs on the jet (IR on the rails, radar on extra stations), each one leaves its own station when fired and stays gone until you RTB to rearm. Big magazines fire from inside first. STOCK: original look, missiles regrow on the rails.'
        },
        {
          l: 'CAMERA DISTANCE',
          k: 'camd',
          d: 'How far behind your jet the chase camera sits. CLOSE is the original tight view; NORMAL, FAR and WIDE pull back for a less crowded screen. Works with both CAMERA modes.'
        },
        {
          l: 'CAMERA HORIZON',
          k: 'camh',
          d: 'LEVEL: the chase camera stays level with the horizon (like War Thunder\'s mouse-aim camera) while your jet rolls, loops and flies inverted. ROLLS WITH JET: the original camera that banks with the aircraft.'
        },
        {
          l: 'MOUSE CONTROL',
          k: 'mctrl',
          d: 'OFF: keep current controls. MOUSE AIM: click once in flight to capture the mouse (ESC gives it back), then move the mouse to swing the aim circle and the jet flies to it; there is no screen edge, keep moving to keep turning. Left button guns, wheel throttle, X missile, middle-click lock, hold right button to look around. VIRTUAL STICK: mouse acts as analog stick.'
        },
        {
          l: 'MOUSE AIM SPEED',
          k: 'msens',
          d: 'How far the MOUSE AIM circle swings per inch of mouse movement. Slower is steadier for gunnery, faster turns with less arm movement.'
        }
      );
    }
  } catch (e) {
    console.warn('[plane-engine] Could not inject options row:', e);
  }

  window.ASKIIES_PLANES = {
    version: '1.7.0',
    setMode: m => { OPT.pmode = m | 0; syncModeUniforms(); save(); },
    getMode: () => OPT.pmode | 0,
    setMouseMode: m => { OPT.mctrl = m | 0; save(); },
    aim: () => ({ captured: aimCaptured(), dir: MC.aim.clone(), screen: [MC.sx, MC.sy] }),
    setRailStores: on => { OPT.rrail = on ? 1 : 0; save(); },
    upgradeJet: upgradeJetVisuals
  };

  console.log('[plane-engine] Next-gen 3D + Real Rails + Mouse Aim engine ready');
})();

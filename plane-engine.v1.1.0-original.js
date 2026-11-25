// ============================================================================
// ASKIIES WAR THUNDER / ROBLOX-STYLE AIRCRAFT ENGINE (v1.0)
// Drop-in external module:
//  - Smooth crease-angle normal shading (sleek fuselages & canopies, sharp fins)
//  - PBR-inspired metallic/clearcoat shader with object-space panel lines, rivets,
//    leading-edge wear, exhaust soot, and glossy reflective canopy glass
//  - Volumetric animated Mach-diamond afterburner shader (soft Fresnel edges)
//  - Additive glowing wingtip nav & anti-collision strobe light sprites
//  - Tapered wingtip vortex ribbons & War Thunder battle-damage smoke/fire
//  - Toggleable in OPTIONS: WAR THUNDER 3D / HYBRID OUTLINED / CLASSIC CEL
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
  LISTS.pmode = () => ['STYLIZED CEL 3D', 'REALISTIC 3D', 'CLASSIC CEL'];

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

      // Subtle per-panel sheet metal tone variation (gives that authentic War Thunder skin look)
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
      // Horizon reflection band (classic sleek Roblox / War Thunder aircraft sheen)
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
        // Military painted aluminum clearcoat (War Thunder / Roblox sheen)
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
        // Slightly boost color vibrancy for punchy cartoon/Roblox military feel
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

      // Fresnel environment reflection (quantized glossy bands in Stylized mode for sleek comic/Roblox shine!)
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

  // ---------- 4. Hangar Studio Lighting Boost (War Thunder Hangar Feel) ----------
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

  // ---------- 6. War Thunder Battle Damage Smoke & Engine Fire + Animation Clock ----------
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
          slot: si
        };
        sg.add(mkMesh(compile(stItem.parts, pal, storeCenter)));
        par.add(sg);
      });

      par.remove(oldLg);
    }
  }

  // Wrap buildJet again so splitJetRails runs after stock buildJet + swing-wing reparenting
  {
    const _bj2 = buildJet;
    buildJet = function (di, pt, sp) {
      const g = _bj2.apply(this, arguments);
      try { splitJetRails(g, di, pt, sp); } catch (e) {}
      return g;
    };
  }

  // Sync sortie missile & SP counts directly to physical missiles hanging on the rails
  function syncAmmoToRails() {
    if (!OPT.rrail || !P || !PJ || !pp || (typeof VEHM !== 'undefined' && VEHM)) return;
    if (OPT.ac === 11) return; // Custom Workshop/Armory aircraft already track exact mounted stores in P.cg

    const stdRails = pp.ld.filter(o => o.userData.k === 'std' && !o.userData.pod);
    const spRails = pp.ld.filter(o => o.userData.k === 'sp' && !o.userData.pod);
    const Wp = (typeof SPW !== 'undefined') ? SPW[OPT.sp] : null;
    const isPodSp = Wp && (Wp.k === 'rkt' || Wp.k === 'eml' || Wp.k === 'mmsl');

    if (stdRails.length > 0) {
      const tipRails = stdRails.filter(o => o.userData.rail);
      const wingRails = stdRails.filter(o => !o.userData.rail);
      if (tipRails.length > 0 && wingRails.length > 0) {
        tipRails.forEach(o => { o.userData.sk = 'ir'; });
        wingRails.forEach(o => { o.userData.sk = 'arh'; });
        P.ir = tipRails.length;
        P.rd = wingRails.length;
      } else {
        // All rails are same type: split half IR / half Radar (or all IR if <= 2)
        const nIR = stdRails.length <= 2 ? stdRails.length : Math.ceil(stdRails.length / 2);
        stdRails.forEach((o, idx) => { o.userData.sk = idx < nIR ? 'ir' : 'arh'; });
        P.ir = nIR;
        P.rd = stdRails.length - nIR;
      }
      P.ms = P.ir + P.rd;
    } else if (PJ.userData && PJ.userData.bay) {
      // Stealth internal bay jets (SV-50 Wraith, XF-0 Null): exact internal bay loadout
      P.ir = 2; P.rd = 2; P.ms = 4;
    }

    if (!isPodSp) {
      if (spRails.length > 0) P.sp = spRails.length;
      else if (PJ.userData && PJ.userData.bay) P.sp = 2;
    }

    if (P.ld) {
      P.ld.ir = P.ir;
      P.ld.rd = P.rd;
      P.ld.sp = P.sp;
    }
    if (P.rl) P.rl.length = 0;
  }

  if (typeof start === 'function') {
    const origStart = start;
    start = function () {
      const r = origStart.apply(this, arguments);
      try { syncAmmoToRails(); } catch (e) {}
      return r;
    };
  }

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

  function pickRailStore(want, skHint) {
    if (!pp || !pp.ld) return null;
    const avail = pp.ld.filter(o => o.visible && o.userData.k === want && !o.userData.pod);
    if (!avail.length) return null;
    const side = -P.side; // launch() flips P.side first
    if (skHint) {
      const bySkSide = avail.find(o => o.userData.sk === skHint && o.userData.s === side);
      if (bySkSide) return bySkSide;
      const bySk = avail.find(o => o.userData.sk === skHint);
      if (bySk) return bySk;
    }
    return avail.find(o => o.userData.s === side) || avail[0];
  }

  // Wrap launch() so missiles detach permanently from the exact rail using that rail's actual 3D model
  if (typeof launch === 'function') {
    const origLaunch = launch;
    launch = function (tg, Wp, sp) {
      if (!OPT.rrail || !pp || !pp.ld) return origLaunch.apply(this, arguments);
      const want = sp ? 'sp' : 'std';
      const railObj = pickRailStore(want, !sp && Wp ? Wp.sk : null);
      let railPos = null, railMesh = null;
      if (railObj) {
        PJ.updateMatrixWorld(true);
        railPos = railObj.getWorldPosition(new Vv());
        railMesh = cloneRailProjectileMesh(railObj, !!railObj.userData.bomb);
        // Hide it right now so origLaunch won't pick a different rail or re-queue P.rl
        railObj.visible = false;
      }
      const nBefore = mi.length;
      // Temporarily mark other rails hidden if we already claimed railObj so origLaunch doesn't double-consume a second rail!
      const prevVis = [];
      if (railObj) {
        for (const o of pp.ld) {
          if (o.visible && o.userData.k === want) { prevVis.push(o); o.visible = false; }
        }
      }
      try {
        origLaunch.apply(this, arguments);
      } finally {
        for (const o of prevVis) o.visible = true;
        if (P.rl) P.rl.length = 0; // NEVER regrow missiles back onto empty rails!
      }
      if (railObj && mi.length > nBefore) {
        const m = mi[mi.length - 1];
        if (railPos) m.p.copy(railPos);
        if (railMesh) {
          if (m.m) S.remove(m.m);
          m.m = railMesh;
          m.m.position.copy(m.p);
          m.m.quaternion.copy(P.q);
          S.add(m.m);
        }
        // Crisp rail-ignition smoke puff right at the wing pylon
        if (typeof puff === 'function' && railPos) {
          for (let i = 0; i < 4; i++) {
            pt(railPos.x, railPos.y, railPos.z, P.v.x * 0.7 + rnd(-6, 6), P.v.y * 0.7 + rnd(-4, 4), P.v.z * 0.7 + rnd(-6, 6), 0.55, 1.8, 'o:.', ['#ffffff', '#dde4ec', '#aab4c0'], 0, 2.2);
          }
        }
      }
    };
  }

  // Wrap dropBomb() so bombs also drop off their exact rack and stay gone until RTB rearm
  if (typeof dropBomb === 'function') {
    const origDropBomb = dropBomb;
    dropBomb = function () {
      if (!OPT.rrail || !pp || !pp.ld) return origDropBomb.apply(this, arguments);
      const railObj = pickRailStore('sp', null);
      let railPos = null, railMesh = null;
      if (railObj) {
        PJ.updateMatrixWorld(true);
        railPos = railObj.getWorldPosition(new Vv());
        railMesh = cloneRailProjectileMesh(railObj, true);
        railObj.visible = false;
      }
      const nBefore = mi.length;
      const prevVis = [];
      if (railObj) {
        for (const o of pp.ld) {
          if (o.visible && o.userData.k === 'sp') { prevVis.push(o); o.visible = false; }
        }
      }
      try {
        origDropBomb.apply(this, arguments);
      } finally {
        for (const o of prevVis) o.visible = true;
        if (P.rl) P.rl.length = 0;
      }
      if (railObj && mi.length > nBefore) {
        const m = mi[mi.length - 1];
        if (railPos) m.p.copy(railPos);
        if (railMesh) {
          if (m.m) S.remove(m.m);
          m.m = railMesh;
          m.m.position.copy(m.p);
          m.m.quaternion.copy(P.q);
          S.add(m.m);
        }
      }
    };
  }

  // Wrap fireMsl() so multi-lock SP salvos (4AAM / 4AGM) never fire more missiles than are on the rails
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

  // Restore empty rails cleanly ONLY when player actually rearms at HOME base/carrier
  if (typeof rearmTick === 'function') {
    const origRearm = rearmTick;
    rearmTick = function (dt) {
      const before = P ? P.rrT : -99;
      origRearm.apply(this, arguments);
      if (OPT.rrail && P && P.rrT !== before && pp && pp.ld) {
        for (const o of pp.ld) o.visible = true;
        syncAmmoToRails();
      }
    };
  }

  // ---------- 8. OPTIONAL MOUSE CONTROL MODE (OPT.mctrl: 0 = OFF, 1 = WAR THUNDER AIM, 2 = VIRTUAL STICK) ----------
  if (OPT.mctrl == null) OPT.mctrl = 0;
  LISTS.mctrl = () => ['OFF', 'WAR THUNDER AIM', 'VIRTUAL STICK'];

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

  // Intercept desktop mouse events ONLY when Mouse Control is turned ON (keeps default controls 100% untouched when OFF!)
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    MC.x = e.clientX;
    MC.y = e.clientY;
    MC.init = 1;
  }, true);

  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || !isMouseFlightOn()) return;
    if (e.target && e.target.closest && e.target.closest('.b,#pz')) return;
    MC.x = e.clientX; MC.y = e.clientY; MC.init = 1;
    if (e.button === 0) {
      // Left-click fires guns; stop propagation so touch-joystick drag doesn't hijack it
      au();
      MC.lmb = 1;
      keys.Gun = 1;
      e.stopImmediatePropagation();
    } else if (e.button === 1) {
      // Middle-click fires missile
      au();
      e.preventDefault();
      e.stopImmediatePropagation();
      if (typeof fireMsl === 'function') fireMsl();
    }
    // Right-click (button === 2) still passes through to ASKIIES's target lock (__alk)
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

  // Scroll wheel controls throttle in Mouse Mode (classic War Thunder!)
  addEventListener('wheel', e => {
    if (!isMouseFlightOn()) return;
    P.thr = cl(P.thr + (e.deltaY < 0 ? 0.06 : -0.06), 0, 1);
  }, { passive: true });

  // Quick hotkey F2 to toggle Mouse Control ON/OFF mid-flight
  addEventListener('keydown', e => {
    if (e.code === 'F2' && !e.repeat) {
      e.preventDefault();
      OPT.mctrl = ((OPT.mctrl | 0) + 1) % 3;
      MC.jx = 0; MC.jy = 0;
      if (!OPT.mctrl && MC.lmb) { MC.lmb = 0; keys.Gun = 0; }
      save();
      if (typeof snd === 'function') snd('ui');
      if (typeof msg === 'function') msg('MOUSE CONTROL: ' + LISTS.mctrl()[OPT.mctrl], HB, 1);
    }
  });

  // Compute War Thunder Instructor or Virtual Stick steering into jx / jy right before update()
  if (typeof update === 'function') {
    const _uM = update;
    update = function (dt) {
      if (OPT.rrail && P && P.rl && P.rl.length) P.rl.length = 0;

      if (isMouseFlightOn() && js === null) {
        if (!MC.init) { MC.x = CW_ * 0.5; MC.y = CH_ * 0.5; MC.init = 1; }
        const kbManual = !!(keys.ArrowLeft || keys.ArrowRight || keys.ArrowUp || keys.ArrowDown || keys.KeyA || keys.KeyD || keys.KeyW || keys.KeyS);
        if (kbManual) {
          // Keyboard always overrides cleanly whenever pressed
          MC.jx = lp(MC.jx, 0, Math.min(1, dt * 10));
          MC.jy = lp(MC.jy, 0, Math.min(1, dt * 10));
        } else if ((OPT.mctrl | 0) === 1) {
          // WAR THUNDER MOUSE AIM INSTRUCTOR: unproject cursor ray -> smooth bank & pitch onto aim circle
          const ndcX = (MC.x / Math.max(1, CW_)) * 2 - 1;
          const ndcY = -(MC.y / Math.max(1, CH_)) * 2 + 1;
          MC.aimV.set(ndcX, ndcY, 0.5).unproject(C).sub(C.position).normalize();

          const lx = MC.aimV.dot(P.r);
          const ly = MC.aimV.dot(P.u);
          const lz = MC.aimV.dot(P.f);
          const err = Math.hypot(lx, ly);

          // World-horizontal right vector relative to aircraft heading for smooth bank-to-turn
          MC.hRight.set(-P.f.z, 0, P.f.x);
          if (MC.hRight.lengthSq() < 1e-4) MC.hRight.copy(P.r).setY(0);
          MC.hRight.normalize();
          const sideErr = MC.aimV.dot(MC.hRight);

          let rollCmd = 0, pitchCmd = 0;
          if (err < 0.015 && lz > 0.9) {
            // Centered: gently auto-level wings & hold nose steady
            rollCmd = cl(P.r.y * 1.4, -0.45, 0.45);
            pitchCmd = cl(ly * 2.8, -0.3, 0.3);
          } else {
            // Bank smoothly toward turn direction, pull pitch onto the aim circle
            const wantBank = cl(sideErr * 3.0, -1.35, 1.35);
            const curBank = Math.atan2(-P.r.y, P.u.y);
            let bankErr = wantBank - curBank;
            while (bankErr > PI) bankErr -= PI * 2;
            while (bankErr < -PI) bankErr += PI * 2;
            rollCmd = cl(bankErr * 1.35, -1, 1);
            pitchCmd = cl(ly * 3.8 + (lz < 0.25 ? 0.65 : 0), -0.85, 1.0);
          }
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
      return _uM.apply(this, arguments);
    };
  }

  // Draw crisp War Thunder Mouse Aim Circle + Boresight Cross on HUD when Mouse Mode is ON
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
          const mx = MC.x, my = MC.y;

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

          // War Thunder mouse aim circle at cursor
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
        const hint = (m === 1 ? 'MOUSE AIM' : 'VIRTUAL STICK') + ' [F2]  ·  LMB GUN  ·  WHEEL THR  ·  MMB/X MSL  ·  RMB LOCK';
        tx(hint, CW_ * 0.5, CH_ - SA.b - (rcur ? 94 : 26) * UF, 'rgba(116, 255, 184, 0.85)', 'center', 8);
        U.restore();
      } catch (e) {}
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
    }
    if (typeof PJ !== 'undefined' && PJ) {
      splitJetRails(PJ, A.d, OPT.paint && OPT.paint[OPT.ac], OPT.sp);
      upgradeJetVisuals(PJ, OPT.paint && OPT.paint[OPT.ac]);
    }
    if (typeof HS !== 'undefined' && HS) smoothObjectMeshes(HS);
  } catch (e) {
    console.warn('[plane-engine] Initial mesh upgrade warning:', e);
  }

  // ---------- 10. Inject Options Rows (AIRCRAFT STYLE, RAIL STORES, MOUSE CONTROL) ----------
  try {
    const rows = PAGES && PAGES.opt && PAGES.opt.rows;
    if (Array.isArray(rows) && !rows.some(r => r.k === 'pmode')) {
      const idx = Math.max(1, rows.findIndex(r => r.k === 'tmode' || r.k === 'tres'));
      rows.splice(idx, 0,
        {
          l: 'AIRCRAFT STYLE',
          k: 'pmode',
          d: 'STYLIZED CEL 3D: bold black ink outlines, punchy cel shading, panel lines, rivets & Mach-diamond afterburners. REALISTIC 3D: smooth PBR, no outlines. CLASSIC CEL: original flat look.'
        },
        {
          l: 'RAIL STORES',
          k: 'rrail',
          d: 'REAL RAILS: ammo matches the actual missiles on your wing rails/racks, missiles detach off the rails leaving empty pylons, and when you are out you are out (RTB to rearm). STOCK: original refills.'
        },
        {
          l: 'MOUSE CONTROL',
          k: 'mctrl',
          d: 'OFF: keep current controls. WAR THUNDER AIM: steer by pointing the mouse cursor (LMB guns, Wheel throttle, MMB/X missile, RMB lock, F2 toggle). VIRTUAL STICK: mouse acts as analog stick.'
        }
      );
    }
  } catch (e) {
    console.warn('[plane-engine] Could not inject options row:', e);
  }

  window.ASKIIES_PLANES = {
    version: '1.1.0',
    setMode: m => { OPT.pmode = m | 0; syncModeUniforms(); save(); },
    getMode: () => OPT.pmode | 0,
    setMouseMode: m => { OPT.mctrl = m | 0; save(); },
    setRailStores: on => { OPT.rrail = on ? 1 : 0; save(); },
    upgradeJet: upgradeJetVisuals
  };

  console.log('[plane-engine] Stylized 3D + Real Rails + Mouse Aim engine ready');
})();

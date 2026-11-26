/* ASKIIES game fixes (game-fixes.js v1.12.0)
 *
 * Small corrections to bugs in the upstream game (ASKIIES.html is never edited by hand).
 * Loaded after the game, before </body>. Each fix names the bug-board report it closes.
 *
 * 1. ONLINE BATTLES · other players' jets are air targets (bug #6)
 *    In battles, other pilots' jets are created with cls 'j' (the battle code for "jet",
 *    next to 'g' ground and 's' sea), which overwrites the game's own target class 'a' (air).
 *    Everything outside the battle code then sees a jet that is not an air target:
 *      - air-to-air missiles (target class 'a') never lock on to it; only weapons that
 *        accept any target (or anti-radiation ones) work;
 *      - a missile that does hit uses its ground-attack damage (dmgG) instead of its
 *        air-to-air damage, so player-vs-player damage is wrong.
 *    Fix: those jets answer 'j' while the battle code runs (caNet, caZones, caRemote, caHUD,
 *    caSetup) and 'a' everywhere else, so the battle code keeps working unchanged.
 *
 * 2. ONLINE BATTLES · one score and one ending for everyone (bug #11)
 *    Each player's game ran its own ticket count, so a battle could end for one player and go on
 *    for another. The lowest peer id keeps the score for everyone, and the first result ends the
 *    battle on every screen.
 *
 * 3. ONLINE BATTLES · no squadron intro cutscenes (bug #14)
 *
 * 4. WORKSHOP · a design keeps its own paint, camo and decals (bug #13 / #17)
 *
 * 5. ONLINE BATTLES · everyone sees nukes and plasma blasts (bug #12)
 *
 * 6. ONLINE BATTLES · other pilots' Workshop jets look like their real design (bug #9)
 *
 * 7. PHONES · save and craft files load and download from the game's buttons (bug #19)
 *
 * 8. CLOUD SAVE · never silently overwrites better progress; one tab saves at a time (bug #24)
 *
 * 9. HUD · a radio message without a speaker no longer crashes the HUD (bug #27)
 *
 * 10. HUD · no STALL / departure / AOA warnings in near space where there is no air (bug #20)
 */
(function () {
  'use strict';
  const g = window;
  if (typeof g.caRemote !== 'function') { console.warn('[game-fixes] battle code not found; skipping'); return; }

  // ---- 1. battle jets are air targets outside the battle code
  let caCtx = 0;
  const inCa = name => {
    const f = g[name];
    if (typeof f !== 'function' || f.__gfx) return;
    const w = function () { caCtx++; try { return f.apply(this, arguments); } finally { caCtx--; } };
    w.__gfx = 1;
    g[name] = w;
  };
  ['caNet', 'caZones', 'caHUD', 'caSetup'].forEach(inCa);
  const _cr = g.caRemote;
  g.caRemote = function (peer, pr) {
    caCtx++;
    let E;
    try { E = _cr.apply(this, arguments); } finally { caCtx--; }
    try {
      if (E && E.cls === 'j' && !Object.getOwnPropertyDescriptor(E, 'cls').get) {
        let raw = 'j';
        Object.defineProperty(E, 'cls', {
          configurable: true, enumerable: true,
          get() { return caCtx ? raw : 'a'; },
          set(v) { raw = v; },
        });
      }
    } catch (e) {}
    return E;
  };
  g.caRemote.__gfx = 1;

  // ---- 2. one score and one ending for everyone in a battle (bug #11)
  // Every player's game runs its own AI and its own ticket count (CA.tk), so the counts drift apart
  // and the battle ended for one player while it went on for the other. Now the player with the
  // lowest peer id keeps the score: their tickets and clock ride along in battle presence and the
  // others adopt them. Whoever's game ends the battle first sends the result, and everyone else's
  // battle ends with it.
  const G_ = f => { try { return f(); } catch (e) { return undefined; } };
  const myPeer = () => G_(() => CA.meR || MP_.me);                                                    // eslint-disable-line no-undef
  const inBattle = () => !!G_(() => CA.on && CA.mr);                                                  // eslint-disable-line no-undef
  const peersNow = () => (G_(() => CA.np) || []).filter(p => p && !p.sameTab && p.presence && p.presence.u);   // eslint-disable-line no-undef
  const absTk = () => { const t = [0, 0], tm = CA.team | 0; t[tm] = Math.round(CA.tk[0] * 10) / 10; t[1 - tm] = Math.round(CA.tk[1] * 10) / 10; return t; };   // eslint-disable-line no-undef
  // Bug #22: a result must belong to THIS battle. Each player sends when their battle started (bs);
  // players in one battle start within seconds of each other, a leftover result from the previous
  // battle (a rematch can reuse the room name) started minutes earlier and is ignored.
  let lastPres = null, endW = null, battleStart = 0;
  const BS_WINDOW = 45e3;
  const prevPres = g.__ampPres;
  g.__ampPres = o => {
    if (typeof prevPres === 'function') try { o = prevPres(o) || o; } catch (e) {}
    try {
      if (!o || !o.u || !inBattle()) return o;
      o.tk = absTk();
      o.el = Math.round((mT - CA.t0) * 10) / 10;                                                       // eslint-disable-line no-undef
      if (battleStart) o.bs = battleStart;
      if (endW != null) o.end = endW;
      lastPres = o;
    } catch (e) {}
    return o;
  };
  if (typeof g.caEnd === 'function') {
    const _end = g.caEnd;
    g.caEnd = function (won) {
      if (endW == null) {
        const tm = G_(() => CA.team | 0) || 0;                                                         // eslint-disable-line no-undef
        endW = won ? tm : 1 - tm;                                                                       // the winning team, the same number on every screen
        try { if (lastPres && G_(() => CA.mr)) CA.mr.presence(Object.assign({}, lastPres, { end: endW, tk: absTk() })).catch(() => {}); } catch (e) {}   // eslint-disable-line no-undef
      }
      return _end.apply(this, arguments);
    };
  }
  if (typeof g.caSetup === 'function') {                                                             // a new battle: no result yet
    const _setup = g.caSetup;
    g.caSetup = function () { endW = null; lastPres = null; battleStart = Date.now(); return _setup.apply(this, arguments); };
  }
  if (typeof g.caTick === 'function') {
    const _tick = g.caTick;
    g.caTick = function (dt) {
      try {
        if (inBattle() && G_(() => st) === 1 && !CA.end) {                                             // eslint-disable-line no-undef
          endW = null;                                                                                  // a battle still running has no result yet
          const me = String(myPeer() || ''), ps = peersNow();
          // a result from anyone ends it here too
          const fin = ps.find(p => (p.presence.end === 0 || p.presence.end === 1) && battleStart && Math.abs((+p.presence.bs || 0) - battleStart) < BS_WINDOW);
          if (fin) {
            const w = fin.presence.end, t = fin.presence.tk, tm = CA.team | 0;                          // eslint-disable-line no-undef
            if (Array.isArray(t) && isFinite(t[0]) && isFinite(t[1])) { CA.tk[0] = +t[tm]; CA.tk[1] = +t[1 - tm]; }   // eslint-disable-line no-undef
            endW = w; return g.caEnd(w === tm);
          }
          // the score keeper: lowest peer id among the players in the battle
          const host = ps.filter(p => Array.isArray(p.presence.tk) && battleStart && Math.abs((+p.presence.bs || 0) - battleStart) < BS_WINDOW).sort((a, b) => String(a.peer) < String(b.peer) ? -1 : 1)[0];
          if (host && me && String(host.peer) < me) {
            const t = host.presence.tk, tm = CA.team | 0;                                               // eslint-disable-line no-undef
            if (isFinite(t[0]) && isFinite(t[1])) { CA.tk[0] = +t[tm]; CA.tk[1] = +t[1 - tm]; }        // eslint-disable-line no-undef
            const el = +host.presence.el;
            if (isFinite(el) && Math.abs((mT - CA.t0) - el) > 1.5) CA.t0 = mT - el;                    // eslint-disable-line no-undef
          }
        }
      } catch (e) {}
      return _tick.apply(this, arguments);
    };
  }

  // ---- 3. no squadron intro cutscenes in online battles (bug #14)
  // The squadron intro (and the enemy / fly-by cutscenes it starts) played at the start of 1v1 duels,
  // where there is no squadron, and in team battles the other players are already flying meanwhile.
  // Bug #21: the intro runs at battle start, before the battle room is connected (CA.mr), so the
  // inviting player still got it: any battle (MODE 'ca' with CA.on) counts.
  if (typeof g.sqIntro === 'function') {
    const _sq = g.sqIntro;
    g.sqIntro = function () {
      if (inBattle() || (G_(() => MODE) === 'ca' && G_(() => CA.on))) return;                         // eslint-disable-line no-undef
      return _sq.apply(this, arguments);
    };
  }

  // ---- 4. a design keeps its own paint, camo and decals (bug #13 / #17)
  // Jet and spaceship paint lives in one shared slot (OPT.paint[11]) and decal parts only point at
  // insignia / decal editor slots ('s' = squadron insignia, 'i2', 'd1'...). So loading a design from the
  // library, the history or a craft file showed it in whatever paint and decals you had now.
  // Now every design carries its look (d.look: paint + copies of the images it uses). Loading a design
  // brings its paint back, and points its decals at a slot holding the same image, adding one if
  // needed (never overwriting your own slots). Older designs without a look are left as they are.
  const clone = o => JSON.parse(JSON.stringify(o));
  const SRC_RE = /^(s|i\d+|d\d+)$/;
  const imgKey = (k, v) => JSON.stringify(k === 'i' ? [v.N || 16, v.px, v.ch] : [v.L]);
  function imgFor(src) {
    if (src === 's') src = 'i' + (OPT.sqi | 0);                                                        // eslint-disable-line no-undef
    const k = src[0], L = k === 'i' ? OPT.ins : OPT.dcl, v = L && L[+src.slice(1)];                   // eslint-disable-line no-undef
    return v ? { k, v } : null;
  }
  function lookOf(d) {
    const look = {};
    if (!d.kind && G_(() => OPT.paint[11])) look.paint = clone(OPT.paint[11]);                         // eslint-disable-line no-undef
    const img = {};
    for (const q of d.parts || []) if (q && q.t === 'dcal') {
      const s = String(q.src || 's');
      if (SRC_RE.test(s) && !img[s]) { const x = imgFor(s); if (x) img[s] = { k: x.k, v: clone(x.v) }; }
    }
    if (Object.keys(img).length) look.img = img;
    return look;
  }
  function slotFor(want, d) {
    const L = want.k === 'i' ? OPT.ins : OPT.dcl, key = imgKey(want.k, want.v);                       // eslint-disable-line no-undef
    let i = L.findIndex(x => x && imgKey(want.k, x) === key);
    if (i >= 0) return want.k + i;
    const used = new Set((d.parts || []).filter(q => q && q.t === 'dcal').map(q => String(q.src || 's')));
    const item = Object.assign(clone(want.v), { n: String(want.v.n || 'SAVED').slice(0, 14), imp: 1 });
    if (L.length >= 8) {                                                                               // full: reuse the oldest slot this fix added
      i = L.findIndex((x, j) => x && x.imp && !used.has(want.k + j));
      if (i >= 0) { L[i] = item; return want.k + i; }
    }
    L.push(item);
    return want.k + (L.length - 1);
  }
  let lastD = null, applying = 0;
  function applyLook(d) {
    applying++;
    try {
      const L = d.look || {};
      if (L.paint && !d.kind) OPT.paint[11] = clone(L.paint);                                          // eslint-disable-line no-undef
      if (L.img) for (const q of d.parts || []) if (q && q.t === 'dcal') {
        const s = String(q.src || 's'), want = L.img[s];
        if (!want || !want.v) continue;
        const cur = imgFor(s);
        if (cur && cur.k === want.k && imgKey(cur.k, cur.v) === imgKey(want.k, want.v)) continue;    // same picture already
        q.src = slotFor(want, d);
      }
      G_(() => cuChanged()); G_(() => buildHJ()); G_(() => save());                                     // eslint-disable-line no-undef
    } finally { applying--; }
  }
  function syncLook() {
    if (applying) return;
    const d = G_(() => CD());                                                                          // eslint-disable-line no-undef
    if (!d || !Array.isArray(d.parts)) return;
    if (d !== lastD) {                                                                                 // a different design was loaded
      const first = lastD === null;
      lastD = d;
      if (!first && d.look) applyLook(d);
    }
    d.look = lookOf(d);                                                                                // the live design always carries its current look
  }
  if (typeof g.custSync === 'function') {
    const _sync = g.custSync;
    g.custSync = function () { const r = _sync.apply(this, arguments); try { syncLook(); } catch (e) {} return r; };
  }
  for (const n of ['cuSave', 'libSave', 'crCur', 'crExportAll']) {                                     // stamp the look right before a copy is made
    const f = g[n];
    if (typeof f === 'function') g[n] = function () { try { syncLook(); } catch (e) {} return f.apply(this, arguments); };
  }
  setInterval(() => { if (G_(() => st) === 0) try { syncLook(); } catch (e) {} }, 400);              // eslint-disable-line no-undef

  // ---- 5. everyone in a battle sees nukes and plasma blasts (bug #12)
  // Battles only share positions, health and hits, so a nuke or plasma warhead went off on the
  // shooter's screen only. The shooter's game now lists its big explosions in battle presence for a few
  // seconds and the others replay them: the look and sound only. The damage still comes from the
  // shooter's game alone (their splash damage already reaches other pilots as hits), so nobody is hurt
  // twice, and a replayed plasma blast does not EMP anyone's enemies or missiles.
  const FXK = new Set(['nuke', 'plasma', 'nukelet', 'plasmalet']);
  const FXQ = [], fxSeen = new Set();
  let fxId = 0, echoing = 0;
  const fxNote = (k, p, R) => {
    if (echoing || !p || !inBattle()) return;
    FXQ.push([++fxId, k, Math.round(p.x), Math.round(p.y), Math.round(p.z), R | 0, Date.now()]);
    while (FXQ.length > 8) FXQ.shift();
  };
  if (typeof g.xplo === 'function') {
    const _xp = g.xplo;
    g.xplo = function (k, p, d, s, water, f) {
      if (FXK.has(k) && !(f && f !== G_(() => pt))) fxNote(k, p, 0);                                  // eslint-disable-line no-undef
      return _xp.apply(this, arguments);
    };
  }
  if (typeof g.nukeAt === 'function') {                                                                // nuclear tank / cannon shells
    const _na = g.nukeAt;
    g.nukeAt = function (p, W) { fxNote('nukeshell', p, (W && W.spl) || 200); return _na.apply(this, arguments); };
  }
  const prevPres2 = g.__ampPres;
  g.__ampPres = o => {
    o = prevPres2(o) || o;
    try { if (o && o.u && inBattle()) { const now = Date.now(), fx = FXQ.filter(e => now - e[6] < 6000).map(e => e.slice(0, 6)); if (fx.length) o.fx = fx; } } catch (e) {}
    return o;
  };
  function quietly(fn) {                                                                                // no EMP on anyone, no "EMP" message
    const E = en.splice(0), M = mi.splice(0), m0 = g.msg;                                              // eslint-disable-line no-undef
    g.msg = () => {};
    try { fn(); } finally { en.push(...E); mi.push(...M); g.msg = m0; }                                 // eslint-disable-line no-undef
  }
  function fxPlay(e) {
    const k = e[1], R = +e[5] || 0, p = new THREE.Vector3(+e[2], +e[3], +e[4]);                          // eslint-disable-line no-undef
    if (![p.x, p.y, p.z].every(isFinite)) return;
    echoing++;
    try {
      if (k === 'nuke' || (k === 'nukeshell' && R >= 150)) {
        NKY.skipDmg = 1;                                                                                  // eslint-disable-line no-undef
        try { nukeFX(p, k === 'nukeshell' ? 1 : 0, k === 'nukeshell' ? R * 3.5 : 1100); } finally { NKY.skipDmg = 0; }   // eslint-disable-line no-undef
      } else if (k === 'nukeshell') miniNuke(p, R);                                                     // eslint-disable-line no-undef
      else if (k === 'nukelet') miniNuke(p, 26);                                                        // eslint-disable-line no-undef
      else if (k === 'plasma') quietly(() => plasmaFX(p));                                              // eslint-disable-line no-undef
      else if (k === 'plasmalet') quietly(() => plasmaLet(p));                                          // eslint-disable-line no-undef
    } catch (x) {} finally { echoing--; }
  }
  setInterval(() => {
    if (!inBattle()) { fxSeen.clear(); FXQ.length = 0; return; }
    for (const pe of peersNow()) {
      const fx = pe.presence.fx;
      if (!Array.isArray(fx)) continue;
      for (const e of fx) {
        if (!Array.isArray(e) || !FXK.has(e[1]) && e[1] !== 'nukeshell') continue;
        const key = pe.peer + ':' + e[0];
        if (fxSeen.has(key)) continue;
        fxSeen.add(key);
        fxPlay(e);
      }
    }
    if (fxSeen.size > 400) fxSeen.clear();
  }, 100);

  // ---- 6. other pilots' Workshop jets look like their real design in battles (bug #9)
  // The game shows other pilots in their real stock jet, but a Workshop jet (ac 11) was never sent, so
  // everyone else saw a stand-in. The design (with its paint and decal pictures, see fix 4) now rides in
  // battle presence in small pieces, about 2 a second; the other games put it together and build the
  // real model once. (Custom-built missiles are not sent, so pylons show empty.)
  const JD_CHUNK = 6000;
  let jdText = null, jdHash = null, jdAt = 0, jdTick = 0, jdI = 0;
  const hashStr = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + t.length.toString(36); };
  function jdRefresh() {
    if (Date.now() - jdAt < 2000 && jdText) return;
    jdAt = Date.now();
    const d = G_(() => CD());                                                                           // eslint-disable-line no-undef
    if (!d || !Array.isArray(d.parts)) { jdText = null; return; }
    try { syncLook(); } catch (e) {}
    const t = JSON.stringify({ d: JSON.parse(JSON.stringify(d, (k, v) => k[0] === '_' ? undefined : v)), p: G_(() => OPT.paint[11]) || null });   // eslint-disable-line no-undef
    if (t !== jdText) { jdText = t; jdHash = hashStr(t); jdI = 0; }
  }
  const prevPres3 = g.__ampPres;
  g.__ampPres = o => {
    o = prevPres3(o) || o;
    try {
      if (o && o.u && inBattle() && (o.ac | 0) === 11) {
        jdRefresh();
        if (jdText && (++jdTick % 5) === 0) {                                                           // every 5th update ≈ 2 pieces a second
          const n = Math.ceil(jdText.length / JD_CHUNK), i = jdI++ % n;
          o.jd = [jdHash, i, n, jdText.slice(i * JD_CHUNK, (i + 1) * JD_CHUNK)];
        }
      }
    } catch (e) {}
    return o;
  };
  const JB = {};                                                                                        // peer -> { h, n, ch[], mesh, E }
  function buildRemoteJet(o) {
    const d = o.d, paint = o.p || G_(() => ALPAINT);                                                    // eslint-disable-line no-undef
    const ins0 = OPT.ins, dcl0 = OPT.dcl, ov0 = G_(() => CUOVR);                                        // eslint-disable-line no-undef
    try {
      // their decal pictures, in the slots their parts point at, just for this build
      const img = (d.look && d.look.img) || {};
      const ti = ins0.slice(), td = dcl0.slice();
      for (const s in img) {
        const x = img[s]; if (!x || !x.v) continue;
        if (s === 's') ti[OPT.sqi | 0] = x.v; else if (s[0] === 'i') ti[+s.slice(1)] = x.v; else if (s[0] === 'd') td[+s.slice(1)] = x.v;   // eslint-disable-line no-undef
      }
      OPT.ins = ti; OPT.dcl = td;                                                                        // eslint-disable-line no-undef
      CUOVR = d;                                                                                          // eslint-disable-line no-undef
      // the Workshop design's DES slot is ACS[11].d; DES[11] is a stock jet, which made every Workshop
      // jet show up as that preset plane (bug #23)
      return buildJet(G_(() => ACS[11].d), paint, 0);                                                   // eslint-disable-line no-undef
    } finally { CUOVR = ov0 === undefined ? null : ov0; OPT.ins = ins0; OPT.dcl = dcl0; }              // eslint-disable-line no-undef
  }
  function wearJet(E, mesh) {
    try {
      const m = mesh.clone(); m.scale.setScalar(1.8);
      S.remove(E.m); S.add(m); E.m = m; E.pr = parts(m);                                                 // eslint-disable-line no-undef
      m.position.copy(E.p); m.quaternion.copy(E.q); m.visible = !E.dead;
      m.userData.wsj = 1;
    } catch (e) {}
  }
  setInterval(() => {
    if (!inBattle()) { for (const k in JB) delete JB[k]; return; }
    for (const pe of peersNow()) {
      const pr = pe.presence, jd = pr.jd, E = G_(() => CA.rem[pe.peer]);                                 // eslint-disable-line no-undef
      if ((pr.ac | 0) !== 11) continue;
      let B = JB[pe.peer];
      if (Array.isArray(jd) && typeof jd[3] === 'string' && jd[2] > 0 && jd[2] < 60) {
        if (!B || B.h !== jd[0]) B = JB[pe.peer] = { h: jd[0], n: jd[2], ch: new Array(jd[2]), mesh: B && B.mesh, E: null };
        B.ch[jd[1]] = jd[3];
        if (!B.done && B.ch.filter(x => typeof x === 'string').length === B.n) {
          B.done = 1;
          try { const o = JSON.parse(B.ch.join('')); if (o && o.d && Array.isArray(o.d.parts)) { B.mesh = buildRemoteJet(o); B.E = null; } } catch (e) { console.warn('[game-fixes] could not build a workshop jet', e); }
        }
      }
      if (B && B.mesh && E && E.net && E.ty === 'air' && B.E !== E) { wearJet(E, B.mesh); B.E = E; }   // new design, or they respawned / rejoined
    }
  }, 250);

  // ---- 7. phones: save / craft files open and download from the game's buttons (bug #19)
  // The game runs its on-screen buttons on pointerdown. With a mouse that counts as a click, but a finger
  // touching the screen does not ("user activation" only comes when the finger lifts), so on phones the
  // browser silently refused the file picker (LOAD SAVE / LOAD CRAFT FILE / music) and the downloads.
  // Now a file picker or download asked for without that permission waits for the finger to lift
  // (pointerup / touchend / click), which grants it, and happens then. Desktop is unchanged.
  if (typeof HTMLInputElement !== 'undefined' && navigator.userActivation) {
    const needTap = () => !navigator.userActivation.isActive;
    let waiting = [];
    const run = () => { const q = waiting; waiting = []; for (const f of q) try { f(); } catch (e) {} };
    for (const ev of ['pointerup', 'touchend', 'click']) addEventListener(ev, () => { if (waiting.length) run(); }, true);
    const _ic = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file' && needTap()) { const el = this; waiting.push(() => _ic.call(el)); return; }
      return _ic.apply(this, arguments);
    };
    const _ac = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download') && needTap()) {
        const el = this;
        waiting.push(() => { const tmp = !el.isConnected; if (tmp) document.body.appendChild(el); _ac.call(el); if (tmp) el.remove(); });
        return;
      }
      return _ac.apply(this, arguments);
    };
  }

  // ---- 9. a radio message without a speaker no longer crashes the HUD (bug #27)
  // Some radio lines are queued as {w: a.nm} / {w, s} with no name, and radioHUD / cockpitUI call
  // rcur.w.startsWith(...) every frame: "can't access property startsWith, rcur.w is undefined", and
  // the game reported a failing HUD. Messages now always have a speaker and text.
  const fixMsg = m => { if (m && typeof m === 'object') { if (typeof m.w !== 'string') m.w = m.w == null ? 'RADIO' : String(m.w); if (typeof m.s !== 'string') m.s = m.s == null ? '' : String(m.s); } return m; };
  try {
    if (typeof rq !== 'undefined' && Array.isArray(rq)) {                                               // eslint-disable-line no-undef
      const _rp = rq.push;                                                                              // eslint-disable-line no-undef
      rq.push = function () { for (const m of arguments) fixMsg(m); return _rp.apply(this, arguments); };   // eslint-disable-line no-undef
    }
  } catch (e) {}
  for (const n of ['radioHUD', 'cockpitUI']) {
    const f = g[n];
    if (typeof f === 'function') g[n] = function () { try { if (typeof rcur !== 'undefined' && rcur) fixMsg(rcur); } catch (e) {} return f.apply(this, arguments); };   // eslint-disable-line no-undef
  }

  // ---- 10. no STALL warning in near space (bug #20)
  // The HUD says STALL (and the cockpit voice "Stall. Stall.") whenever the flight model's stall
  // amount P.sf is up, even at 200 km with "AIR 0%" where there is no air to stall in. Above that,
  // with almost no air left (P.rho < 3%), the HUD and the voice warnings now ignore stall, post-stall,
  // departure and AOA limit. The flight model itself is untouched.
  const quietAero = fn => function () {
    let saved = null;
    try {
      if (typeof P !== 'undefined' && P && P.rho != null && P.rho < 0.03) {                            // eslint-disable-line no-undef
        saved = [P.sf, P.psm, P.dp, P.ns]; P.sf = 0; P.psm = 0; P.dp = 0; P.ns = 0;                    // eslint-disable-line no-undef
      }
    } catch (e) {}
    try { return fn.apply(this, arguments); }
    finally { if (saved) { [P.sf, P.psm, P.dp, P.ns] = saved; } }                                       // eslint-disable-line no-undef
  };
  for (const n of ['flightHUD', 'warnTick']) if (typeof g[n] === 'function') g[n] = quietAero(g[n]);

  // ---- 8. the cloud save never silently overwrites better progress (bug #24)
  // The game uploads the local save every 20 s and when you leave, and at sign-in it only downloads the
  // cloud save if the cloud is newer than this browser's "last synced" time. Whatever this browser has
  // otherwise wins, so a stale tab or device, a reset local save, or a different pilot's save on the
  // same browser could replace someone's progress. Now, before an automatic upload:
  //  - the cloud changed since this browser last synced (another device / tab), or this save is much
  //    smaller than the cloud one: nothing is uploaded and the player chooses which save to keep (the
  //    other one is kept on the server first: ACCOUNT ▸ OLDER SAVES);
  //  - the local save belongs to another pilot: this pilot's own cloud save is loaded instead.
  // Plus: when the game is opened in a second tab, the older tab stops saving.
  const OWN = 'askiies-cloud-uid', LSK_ = 'ascii-strike';
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const uidNow = () => G_(() => ASKIIES_MP.me().id) || null;                                          // eslint-disable-line no-undef
  const syncedTs = () => { try { return +JSON.parse(lsGet('askiies-cloud') || '{}').ts || 0; } catch (e) { return 0; } };
  const mpCall = async (p, body) => {
    const t = lsGet('askiies-mp-token');
    const r = await fetch(new URL('mp/api/' + p, document.baseURI).href, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const TAB = { id: Math.random().toString(36).slice(2), born: Date.now(), paused: false };
  let cHold = 0, cBox = null;
  async function keepDeviceCopy() {                                                                    // this device's save, to the server's OLDER SAVES
    const s = lsGet(LSK_); if (!s) return;
    const z = typeof zip === 'function' ? await zip(s) : { z: 0, d: s };                                // eslint-disable-line no-undef
    const parts = []; for (let i = 0; i < z.d.length; i += 180000) parts.push(z.d.slice(i, i + 180000));
    await mpCall('saves/keep', { from: 'device', meta: { ts: syncedTs() || Date.now(), n: parts.length, z: z.z, len: s.length, v: G_(() => ULOG[0].v) }, parts });   // eslint-disable-line no-undef
  }
  function cloudChoice(M, s, newer) {
    if (cBox) return;
    const show = () => {
      if (G_(() => st) === 1 && !G_(() => P.dead)) { setTimeout(show, 1500); return; }                // not in the middle of a flight
      const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
      const kb = n => Math.max(1, Math.round((n || 0) / 1024)) + ' KB';
      cBox = document.createElement('div'); cBox.id = 'amp-bug';
      cBox.innerHTML = `<div class="bx"><h2>WHICH SAVE DO YOU WANT TO KEEP?</h2>
        <p style="color:#f2fff8;font-size:12px">${newer
          ? `Your account was saved from another device or tab ${ago(M.ts)} (${kb(M.len)}). This device has different progress (${kb(s.length)}).`
          : `This device's save (${kb(s.length)}) is much smaller than the one in your account (${kb(M.len)}, saved ${ago(M.ts)}). Uploading it could wipe your progress.`}</p>
        <p>Nothing has been overwritten. Whichever you choose, the other one is kept: ACCOUNT &amp; SAVES ▸ OLDER SAVES.</p>
        <div class="err"></div>
        <div class="row"><button type="button" class="alt" data-k="dev">KEEP THIS DEVICE'S</button><button type="button" data-k="acc">LOAD MY ACCOUNT'S SAVE</button></div></div>`;
      for (const t of ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel']) cBox.addEventListener(t, e => e.stopPropagation());
      cBox.addEventListener('click', async e => {
        const k = e.target && e.target.getAttribute('data-k'); if (!k) return;
        cBox.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
          if (k === 'acc') {
            try { await keepDeviceCopy(); } catch (x) {}
            const got = await _pull.call(null, 1);
            if (got) { g.cloudApply(); return; }
            cHold = 0;
          } else {
            try { await mpCall('saves/keep', { from: 'account' }); } catch (x) {}
            cHold = 0; await g.cloudPush(1);
          }
          cBox.remove(); cBox = null;
        } catch (x) { const er = cBox.querySelector('.err'); if (er) er.textContent = 'SOMETHING WENT WRONG · TRY AGAIN'; cBox.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
      });
      document.body.appendChild(cBox);
    };
    show();
  }
  const _push = g.cloudPush, _pull = g.cloudPull;
  if (typeof _push === 'function' && typeof _pull === 'function') {
    g.cloudPush = async function (force) {
      const C = G_(() => CLD);                                                                          // eslint-disable-line no-undef
      if (TAB.paused) return;                                                                           // an older tab never uploads
      if (!C || !C.col) return _push.apply(this, arguments);
      if (!force) {
        if (cHold) return;
        const s = lsGet(LSK_);
        if (!s || s === C.last || C.busy) return _push.apply(this, arguments);                         // nothing new: the game does nothing
        let M = null;
        try { const m = await C.col.doc('savemeta').get(); M = m.exists ? m.data() : null; } catch (e) { return; }   // offline: try again later
        if (M) {
          const owner = lsGet(OWN), uid = uidNow();
          if (owner && uid && owner !== uid) {                                                          // another pilot's save on this browser
            cHold = 1;
            if (await _pull.call(null, 1)) { lsSet(OWN, uid); g.cloudApply(); }
            return;
          }
          const newer = M.ts > syncedTs() + 500, shrink = (M.len | 0) > 6000 && s.length < M.len * 0.6;
          if (newer || shrink) { cHold = 1; cloudChoice(M, s, newer); return; }
        }
      }
      const r = await _push.apply(this, arguments);
      if (!C.err && uidNow()) lsSet(OWN, uidNow());
      return r;
    };
    g.cloudPull = async function (force) {
      const owner = lsGet(OWN), uid = uidNow();
      if (!force && owner && uid && owner !== uid) force = 1;                                           // load this pilot's own save
      const r = await _pull.call(this, force);
      if (uid && (r || !owner)) lsSet(OWN, uid);
      return r;
    };
  }
  // Loading a cloud save (sign-in, RESTORE FROM CLOUD, OLDER SAVES) writes it to this browser and reloads.
  // But while the page unloads the game saves again, writing the OLD in-memory progress over the save it
  // just loaded; after the reload this browser then counted as up to date and uploaded that old save to
  // the cloud. On a fresh browser that was a default save: signing in wiped the account (bug #24). Same
  // block hangar-menu.js uses for save-file imports: no more writes of the save until the reload.
  if (typeof g.cloudApply === 'function') {
    const _apply = g.cloudApply;
    g.cloudApply = function () {
      g.__svLock = 1;
      try { sessionStorage.setItem('askiies-healed', String(Date.now())); } catch (e) {}
      try { const s = lsGet(LSK_); if (s && typeof g.svIdbPut === 'function') { g.svIdbPut('healedAt', Date.now()); g.svIdbPut('save', s); g.svIdbPut('save.ts', Date.now()); } } catch (e) {}
      return _apply.apply(this, arguments);
    };
  }
  // the game in two tabs: both save to the same place and overwrite each other, so the older one stops
  try {
    const bc = new BroadcastChannel('askiies-tabs');
    const pauseTab = () => {
      if (TAB.paused) return;
      TAB.paused = true; g.__svLock = 1;                                                                // hangar-menu.js: no more writes of the save
      try { if (typeof g.svIdbPut === 'function') g.svIdbPut = () => Promise.resolve(); } catch (e) {}
      const d = document.createElement('div'); d.id = 'amp-bug';
      d.innerHTML = '<div class="bx"><h2>ASKIIES IS OPEN IN ANOTHER TAB</h2><p style="color:#f2fff8;font-size:12px">This tab has stopped saving so the two tabs can\'t overwrite each other\'s progress. Carry on in the other tab, or use this one instead.</p><div class="row"><button type="button">USE THIS TAB INSTEAD</button></div></div>';
      for (const t of ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel']) d.addEventListener(t, e => e.stopPropagation());
      d.querySelector('button').addEventListener('click', () => location.reload());
      try { G_(() => pause()); } catch (e) {}                                                             // eslint-disable-line no-undef
      (document.body || document.documentElement).appendChild(d);
    };
    bc.onmessage = e => { const m = e.data || {}; if (m.t === 'hello' && m.id !== TAB.id && m.born > TAB.born) pauseTab(); };
    bc.postMessage({ t: 'hello', id: TAB.id, born: TAB.born });
  } catch (e) {}

  g.ASKIIES_FIXES = { version: '1.12.0', tab: () => TAB, cloudHold: () => cHold, fxPlay, jb: () => Object.fromEntries(Object.entries(JB).map(([k, b]) => [k, { h: b.h, n: b.n, got: b.ch.filter(Boolean).length, built: !!b.mesh, worn: !!b.E }])), fixes: ['#6 battle jets are air targets (lock + damage)', '#11 one score and one ending per battle', '#14 no squadron cutscenes in online battles', '#13 designs keep their paint, camo and decals', '#12 everyone sees nukes and plasma blasts', '#9 other pilots wear their real Workshop jet', '#19 phones can load and download saves', '#24 cloud save never silently overwrites better progress', '#22 a battle only ends on its own result', '#27 radio lines without a speaker no longer crash the HUD', '#21 no squadron intro in any battle', '#23 Workshop jets built from their real design slot', '#20 no stall warnings in near space'], caCtx: () => caCtx, endW: () => endW, look: () => G_(() => CD().look) };   // eslint-disable-line no-undef
})();

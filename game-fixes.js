/* ASKIIES game fixes (game-fixes.js v1.4.0)
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
  let lastPres = null, endW = null;
  const prevPres = g.__ampPres;
  g.__ampPres = o => {
    if (typeof prevPres === 'function') try { o = prevPres(o) || o; } catch (e) {}
    try {
      if (!o || !o.u || !inBattle()) return o;
      o.tk = absTk();
      o.el = Math.round((mT - CA.t0) * 10) / 10;                                                       // eslint-disable-line no-undef
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
  if (typeof g.caTick === 'function') {
    const _tick = g.caTick;
    g.caTick = function (dt) {
      try {
        if (inBattle() && G_(() => st) === 1 && !CA.end) {                                             // eslint-disable-line no-undef
          endW = null;                                                                                  // a battle still running has no result yet
          const me = String(myPeer() || ''), ps = peersNow();
          // a result from anyone ends it here too
          const fin = ps.find(p => p.presence.end === 0 || p.presence.end === 1);
          if (fin) {
            const w = fin.presence.end, t = fin.presence.tk, tm = CA.team | 0;                          // eslint-disable-line no-undef
            if (Array.isArray(t) && isFinite(t[0]) && isFinite(t[1])) { CA.tk[0] = +t[tm]; CA.tk[1] = +t[1 - tm]; }   // eslint-disable-line no-undef
            endW = w; return g.caEnd(w === tm);
          }
          // the score keeper: lowest peer id among the players in the battle
          const host = ps.filter(p => Array.isArray(p.presence.tk)).sort((a, b) => String(a.peer) < String(b.peer) ? -1 : 1)[0];
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
  if (typeof g.sqIntro === 'function') {
    const _sq = g.sqIntro;
    g.sqIntro = function () {
      if (inBattle()) return;
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

  g.ASKIIES_FIXES = { version: '1.4.0', fxPlay, fixes: ['#6 battle jets are air targets (lock + damage)', '#11 one score and one ending per battle', '#14 no squadron cutscenes in online battles', '#13 designs keep their paint, camo and decals', '#12 everyone sees nukes and plasma blasts'], caCtx: () => caCtx, endW: () => endW, look: () => G_(() => CD().look) };   // eslint-disable-line no-undef
})();

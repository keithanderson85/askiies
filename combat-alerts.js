/* ASKIIES combat alerts (combat-alerts.js v1.1.0)
 *
 * Loaded after the game (and plane-engine.js), before </body>. Adds:
 *
 * 1. THREAT WARNING: who is locking you up and which missiles are coming, for AI enemies and for other
 *    pilots in online battles: a bracket on each threat that is on screen ("LOCKED ON YOU", "MISSILE
 *    1.2 KM"), an arrow on a clock ring round the reticle for each locker that is not, and a pulsing red
 *    frame while a missile is inbound. Online threats also get the game's own warnings (MISSILE ALERT,
 *    "MISSILE 7 O'CLOCK", lock tones), which it only ever gave for AI enemies.
 *
 * 2. HIT FEEDBACK: a red wedge pointing at whoever hit you, a red vignette that scales with the hit, a
 *    line under the reticle ("GUN HITS ×4 −9 · HULL 81% · ★ VIPER", "MISSILE HIT −35 …") and a metallic
 *    tick (guns) or heavy thump (missiles).
 *
 * 3. VOICE + LOCK TONES: "Bitchin' Betty" clips (betty/*.wav) for the game's spoken warnings, and a lock
 *    tone for every lock on you (fast double beep = locked, slow beep = locking) plus "Enemy lock.".
 *
 * 4. ONLINE PLUMBING: in a battle the game only sent "you took X damage" to the other pilot; their
 *    missiles existed only on the shooter's screen, so the target got no lock tone, no missile warning
 *    and flares could not work. Battle presence (through mp-client.js's window.__ampPres hook) now also
 *    carries your lock, your missiles in flight and your flare count. The target sees and hears the lock,
 *    sees the missile coming (drawn in their world) and can flare it: the shooter's missile is decoyed
 *    by the game's own flare/chaff roll when the target pops countermeasures in time.
 */
(function () {
  'use strict';
  if (typeof THREE === 'undefined' || typeof flightHUD !== 'function' || typeof update !== 'function') return;

  const G = f => { try { return f(); } catch (e) { return undefined; } };
  const RED = '#ff4a3d', AMB = '#ffb030', V3 = () => new THREE.Vector3();
  const A = {
    thr: [], hits: [], ev: [], vig: 0, txt: null, lastHp: null, sndT: 0,
    ghosts: new Map(), lockT: 0, mslT: 0, mslC: 0, launchAt: -99,
    cm: 0, cmSum: null, cmAt: -99, nid: 0
  };
  const t1 = V3(), t2 = V3(), cF = V3();
  const r1 = x => Math.round(x * 10) / 10;

  const flying = () => st === 1 && !!P && !P.dead && !G(() => CIN);
  const inJet = () => flying() && !G(() => VEHM);
  const myPos = () => (G(() => VEHM) && G(() => VS) ? VS.p : P.p);
  const myPeer = () => G(() => CA.meR || MP_.me);
  const inBattle = () => !!G(() => CA.on && CA.mr);

  // ------------------------------------------------------------------ online: what we tell the others
  window.__ampPres = o => {
    if (!o || !Array.isArray(o.u) || o.tm === undefined || !inBattle()) return o;   // battle presence only
    o.cm = A.cm;                                                                         // flare / chaff pops
    if (!inJet()) return o;
    let best = null;                                                                     // our strongest lock on a pilot
    for (const e of en) if (e && e.net && !e.dead && e.peer && (e.lk || 0) > .05 && (!best || e.lk > best.lk)) best = e;
    if (best) o.lk = [best.peer, Math.round(Math.min(1, best.lk) * 100) / 100];
    const ms = [];                                                                       // our missiles chasing a pilot
    for (const m of mi) {
      if (!m || m.hos || m.dd || !m.p || !m.tg || !m.tg.net || !m.tg.peer) continue;
      if (!m.__nid) m.__nid = ++A.nid;
      const d = m.d || t1.set(0, 0, 0), sp = m.sp || 0;
      ms.push([m.__nid, m.tg.peer, r1(m.p.x), r1(m.p.y), r1(m.p.z), r1(d.x * sp), r1(d.y * sp), r1(d.z * sp), m.sk || '']);
      if (ms.length >= 6) break;
    }
    if (ms.length) o.ms = ms;
    return o;
  };

  // ------------------------------------------------------------------ online: what the others tell us
  function flareFX(E) {
    for (let j = 0; j < 12; j++) G(() => pt(E.p.x, E.p.y - 3, E.p.z, E.v.x * .5 + rnd(-25, 25), rnd(-30, -5), E.v.z * .5 + rnd(-25, 25), 2, 1.2, '*+.', ['#ffffff', '#fff2a0', '#ff8a40'], 6, .8));
  }
  function ghostDrop(key, g) {
    if (g.m) G(() => S.remove(g.m));
    A.ghosts.delete(key);
    // it vanished away from us right after we popped flares: tell the pilot it worked
    if (flying() && rt - A.cmAt < 4 && g.p.distanceTo(myPos()) > 150) G(() => msg('MISSILE DECOYED', HB));
  }
  function pvpTick() {
    const np = G(() => CA.np) || [], mine = myPeer();
    for (const p of np) {
      if (!p || p.sameTab || !p.presence) continue;
      const pr = p.presence, E = G(() => CA.rem[p.peer]);
      if (!E) continue;
      // their countermeasures vs our missiles: arm the game's own flare/chaff roll for 3 s
      if (typeof pr.cm === 'number') {
        if (E.__cm != null && pr.cm > E.__cm) { E.fl = 1; E.chf = 1; E.__cmT = rt + 3; if (!E.dead) flareFX(E); }
        E.__cm = pr.cm;
      }
      if (E.__cmT && rt > E.__cmT) { E.fl = 0; E.chf = 0; E.__cmT = 0; }
      if (!inJet() || E.dead || !mine) continue;
      if (Array.isArray(pr.lk) && pr.lk[0] === mine) A.thr.push({ p: E.p, k: pr.lk[1] >= 1 ? 'lock' : 'trk', nm: E.nm || 'PILOT', pvp: 1 });
      if (!Array.isArray(pr.ms)) continue;
      for (const m of pr.ms) {
        if (!Array.isArray(m) || m.length < 8 || m[1] !== mine || !m.slice(2, 8).every(isFinite)) continue;
        const key = p.peer + ':' + m[0];
        let g = A.ghosts.get(key);
        if (!g) {
          g = { p: V3(), p0: V3(), v: V3(), t0: rt, raw: null, seen: rt, m: G(() => mslMesh(1)) || null };
          if (g.m) G(() => S.add(g.m));
          A.ghosts.set(key, g);
          A.launchAt = rt;
          G(() => rwrLaunch()); G(() => vox('launch'));
        }
        if (g.raw !== m) { g.raw = m; g.p0.set(m[2], m[3], m[4]); g.v.set(m[5], m[6], m[7]); g.t0 = rt; }
        g.seen = rt; g.sk = m[8] || ''; g.nm = E.nm || 'PILOT';
      }
    }
    for (const [key, g] of A.ghosts) {
      if (rt - g.seen > .4 || !inJet()) { ghostDrop(key, g); continue; }
      g.p.copy(g.p0).addScaledVector(g.v, Math.min(.35, rt - g.t0));                     // 10 Hz updates, extrapolated
      if (g.m) {
        g.m.position.copy(g.p);
        if (g.v.lengthSq() > 1) G(() => g.m.quaternion.setFromUnitVectors(FWD, t1.copy(g.v).normalize()));
      }
      if (Math.random() < .8) G(() => pt(g.p.x, g.p.y, g.p.z, rnd(-2, 2), rnd(-2, 2), rnd(-2, 2), .9, .9, 'o:.', SMK, 0, 1.4));
      A.thr.push({ p: g.p, k: 'msl', nm: g.nm, pvp: 1 });
    }
  }
  // lock tones for EVERY lock on you (AI radar, AI heat-seeker, other pilots): the game only clicked
  // faintly for radar locks. Locked = fast insistent double beep; locking = slow single beep.
  // A fresh lock also gets the voice: "Enemy lock."
  function lockSounds(dt) {
    let lock = null, trk = null;
    for (const T of A.thr) { if (T.k === 'lock') lock = lock || T; else if (T.k === 'trk') trk = trk || T; }
    A.lockT -= dt;
    if (A.lockT <= 0 && (lock || trk) && G(() => aOK())) {
      G(() => {
        const t = AX.currentTime, d = aCh(.6, 0, 0);
        if (lock) { aOs(d, t, { ty: 'square', f: 1900, d: .05, v: .055 }); aOs(d, t + .08, { ty: 'square', f: 1900, d: .05, v: .055 }); }
        else aOs(d, t, { ty: 'square', f: 1250, d: .07, v: .04 });
      });
      A.lockT = lock ? .3 : .8;
    }
    if (lock && !A.wasLock) G(() => vox('lock'));
    A.wasLock = !!lock;
  }
  function pvpSounds(dt) {
    let near = null, nd = 1e9;
    for (const T of A.thr) {
      if (!T.pvp || T.k !== 'msl') continue;
      const d = T.p.distanceTo(myPos()); if (d < nd) { nd = d; near = T; }
    }
    A.mslT -= dt;
    if (near) {
      if (A.mslT <= 0) { G(() => tone(A.mslC ? 760 : 560, .11, .035, 'sawtooth')); A.mslC = !A.mslC; A.mslT = .18; }
      if (nd < 2400) G(() => vox('msl', clockOf(near.p)));
    }
  }

  // ------------------------------------------------------------------ AI threats (the game's own rules)
  function aiThreats() {
    for (const e of en) {
      if (!e || e.net || e.dead || e.ty !== 'air' || !e.p) continue;
      const k = e.lkp || 0;                                         // the bandit's lock-on time on you
      if (k > .3) A.thr.push({ p: e.p, k: k >= .8 ? 'lock' : 'trk', nm: e.nm || 'BANDIT' });
    }
    for (const r of G(() => RWL) || []) {                            // SAM / radar sites locked on (RWR)
      if (r && r.lk && r.e && r.e.ty !== 'air' && !r.e.dead && r.e.p) A.thr.push({ p: r.e.p, k: 'lock', nm: r.e.nm || 'SAM SITE' });
    }
    const mp = myPos();
    for (const m of mi) {
      if (!m || !m.hos || m.dd || m.at || m.nod || (m.ign || 0) > 0 || !m.p) continue;
      if (m.sk === 'ir' && m.p.distanceTo(mp) > 2400) continue;     // IR launches stay quiet until close (game rule)
      A.thr.push({ p: m.p, k: 'msl', nm: '' });
    }
  }

  // ------------------------------------------------------------------ hits
  function hitEvent(kind, p, src, who) {
    if (st !== 1 || !P || P.dead) return;
    const mp = myPos();
    let pos = null;
    if (src && src.p) pos = null;
    else if (kind === 'blt') {
      // the shooter: nearest enemy jet within 1.6 km with its nose on us
      let best = null, bd = 1600;
      for (const e of en) {
        if (!e || e.dead || e.ty !== 'air' || !e.p) continue;
        const d = e.p.distanceTo(mp);
        if (d > bd || !e.v || e.v.lengthSq() < 1) continue;
        if (t1.copy(e.v).normalize().dot(t2.copy(mp).sub(e.p).normalize()) < .9) continue;
        best = e; bd = d;
      }
      if (best) { src = best; who = who || best.nm || ''; }
    }
    if (!src && p) pos = t1.copy(p).sub(mp).multiplyScalar(60).add(mp).clone();          // the side the hit landed on
    A.hits.push({ k: kind, t: rt, src: src && src.p ? src : null, pos });
    if (A.hits.length > 8) A.hits.shift();
    A.ev.push({ k: kind, who: who || '' });
    const big = kind === 'msl' || kind === 'shl';
    A.vig = Math.min(1, A.vig + (big ? 1 : kind === 'flak' ? .5 : .3));
    if (big) { G(() => tone(52, .5, .09, 'sine')); G(() => nois(.35, .22, 260)); }
    else if (rt - A.sndT > .05) { A.sndT = rt; G(() => tone(1650 + Math.random() * 500, .025, .045, 'square')); G(() => nois(.045, .16, 4200, 1)); }
  }
  if (typeof dmgHit === 'function') {
    const _dh = dmgHit;
    dmgHit = function (p, amt, kind) {                                // eslint-disable-line no-global-assign
      try { hitEvent(kind === 'msl' || kind === 'shl' || kind === 'flak' ? kind : 'blt', p, null, ''); } catch (e) {}
      return _dh.apply(this, arguments);
    };
  }
  if (typeof caNetHit === 'function') {
    const _nh = caNetHit;
    caNetHit = function (dm, peer, nm) {                              // eslint-disable-line no-global-assign
      try {
        if (!P.dead && st === 1) {
          const E = G(() => CA.rem[peer]);
          let msl = dm >= 18;                                            // one gun round never does this much
          for (const g of A.ghosts.values()) if (g.p.distanceTo(myPos()) < 160) msl = true;
          hitEvent(msl ? 'msl' : 'blt', null, E && E.p ? E : null, nm || '');
          if (msl) { G(() => boom(myPos().clone(), .9)); G(() => snd('boom')); G(() => { sk = Math.max(sk, 1.2); }); }
        }
      } catch (e) {}
      return _nh.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------------ "Bitchin' Betty" voice
  // The game speaks its cockpit warnings (VOICE WARNINGS option) through the browser's text-to-speech,
  // which sounds different on every device, is often quiet and is missing on some phones. These are
  // recorded clips (betty/*.wav, one consistent female voice) played through a cockpit-radio filter
  // in the game's own audio mix (SFX volume applies). The game's speech calls are routed here; until
  // the clips have loaded, or for anything without a clip, the browser voice is used as before.
  const BASE = new URL('betty/', (document.currentScript && document.currentScript.src) || location.href);
  const BKEYS = ['pull', 'msl', 'launch', 'fire', 'stall', 'alt', 'bank', 'warn', 'over', 'g', 'bingo', 'lock'];
  for (let i = 1; i <= 12; i++) BKEYS.push('c' + i);
  const BETTY = { buf: {}, real: {}, loading: 0, chain: null, srcs: [], pri: 0, end: 0, endT: 0, onend: null };
  G(() => { if (!VW.lock) VW.lock = { t: 'Enemy lock.', s: 'ENEMY LOCK', p: 7, cd: 6 }; });
  // betty/real/<name>.mp3|.wav|.ogg (your own recordings) win over the generated betty/<name>.wav,
  // and play untouched (no radio filter: real cockpit recordings already sound like the cockpit)
  function bettyLoad() {
    const ax = G(() => AX); if (!ax) return;                          // after the first tap/click (audio unlocked)
    BETTY.loading = 1;
    const get = u => fetch(u, { cache: 'no-cache' }).then(r => (r.ok && !/text\/html/.test(r.headers.get('content-type') || '') ? r.arrayBuffer() : null)).catch(() => null);
    const dec = ab => new Promise(res => { try { ax.decodeAudioData(ab, b => res(b), () => res(null)); } catch (e) { res(null); } });
    for (const k of BKEYS) {
      (async () => {
        for (const ext of ['mp3', 'wav', 'ogg']) {
          const ab = await get(new URL('real/' + k + '.' + ext, BASE));
          const b = ab && await dec(ab);
          if (b) { BETTY.buf[k] = b; BETTY.real[k] = 1; return; }
        }
        const ab = await get(new URL(k + '.wav?v=1', BASE));
        const b = ab && await dec(ab);
        if (b) BETTY.buf[k] = b;
      })();
    }
  }
  function bettyChain() {
    if (BETTY.chain) return BETTY.chain;
    const ax = AX, hp = ax.createBiquadFilter(), pk = ax.createBiquadFilter(), lpf = ax.createBiquadFilter(), ws = ax.createWaveShaper(), g = ax.createGain();
    hp.type = 'highpass'; hp.frequency.value = 330;
    pk.type = 'peaking'; pk.frequency.value = 2200; pk.Q.value = 1; pk.gain.value = 5;
    lpf.type = 'lowpass'; lpf.frequency.value = 3600;
    const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(x * 1.8) / Math.tanh(1.8); }
    ws.curve = c; g.gain.value = 1.15;
    hp.connect(pk); pk.connect(lpf); lpf.connect(ws); ws.connect(g);
    return (BETTY.chain = { in: hp, out: g });
  }
  function bettyStop() {
    for (const s of BETTY.srcs) { try { s.stop(); } catch (e) {} }
    BETTY.srcs = []; clearTimeout(BETTY.endT);
    const f = BETTY.onend; BETTY.onend = null; BETTY.end = 0;
    if (f) try { f(); } catch (e) {}
  }
  function bettyPlay(keys, pri, onend) {
    keys = keys.filter((k, i) => i === 0 || BETTY.buf[k]);          // a missing clock clip is just skipped
    if (!BETTY.buf[keys[0]] || !G(() => aOK())) return false;
    if (BETTY.end > AX.currentTime && pri <= BETTY.pri) { if (onend) setTimeout(onend, 0); return true; }   // busy with something as urgent
    bettyStop();
    const ch = bettyChain(), out = aCh(1, 0, 0);
    ch.out.disconnect(); ch.out.connect(out);
    let t = AX.currentTime + .02;
    for (const k of keys) {
      const s = AX.createBufferSource(); s.buffer = BETTY.buf[k]; s.connect(BETTY.real[k] ? out : ch.in); s.start(t);
      BETTY.srcs.push(s); t += BETTY.buf[k].duration + .07;
    }
    BETTY.pri = pri; BETTY.end = t; BETTY.onend = onend || null;
    BETTY.endT = setTimeout(() => { BETTY.srcs = []; const f = BETTY.onend; BETTY.onend = null; if (f) try { f(); } catch (e) {} }, (t - AX.currentTime) * 1000);
    return true;
  }
  function bettySay(u) {
    const text = String((u && u.text) || '');
    const vw = G(() => VW) || {};
    let k = null;
    for (const key in vw) if (vw[key] && vw[key].t && text.indexOf(vw[key].t) === 0) { if (!k || vw[key].t.length > vw[k].t.length) k = key; }
    if (!k || !BKEYS.includes(k)) return false;
    const keys = [k], m = /(\d+)\s*o'clock/i.exec(text.slice(vw[k].t.length));
    if (m && +m[1] >= 1 && +m[1] <= 12) keys.push('c' + (+m[1]));
    return bettyPlay(keys, vw[k].p || 1, () => { try { u.onend && u.onend(); } catch (e) {} });
  }
  // route the game's speech through Betty (and give devices without text-to-speech a stand-in)
  if (!window.SpeechSynthesisUtterance) window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  if (window.speechSynthesis && window.speechSynthesis.speak) {
    const ss = window.speechSynthesis, sp = ss.speak.bind(ss), cn = ss.cancel.bind(ss);
    try {
      ss.speak = u => { if (!bettySay(u)) sp(u); };
      ss.cancel = () => { bettyStop(); cn(); };
    } catch (e) {}
  } else {
    try {
      window.speechSynthesis = { speaking: false, pending: false, paused: false, speak: u => { bettySay(u); }, cancel: bettyStop, pause() {}, resume() {}, getVoices: () => [] };
    } catch (e) {}
  }

  // ------------------------------------------------------------------ per frame
  const _up = update;
  update = function (dt) {                                            // eslint-disable-line no-global-assign
    const r = _up.apply(this, arguments);
    try { tick(dt || 0); } catch (e) {}
    return r;
  };
  function tick(dt) {
    if (!BETTY.loading) bettyLoad();
    A.thr.length = 0;
    A.vig = Math.max(0, A.vig - dt * 1.3);
    if (st !== 1 || !P) {
      A.lastHp = null; A.cmSum = null; A.txt = null; A.hits.length = 0; A.ev.length = 0;
      for (const [k, g] of A.ghosts) ghostDrop(k, g);
      if (inBattle()) G(() => pvpTick());                              // keep reading flares while in menus
      return;
    }
    // our own flare / chaff pops (counted from the stock, so every way of firing them counts)
    const cs = (P.fl || 0) + (P.chf || 0);
    if (A.cmSum != null && cs < A.cmSum) { A.cm++; A.cmAt = rt; }
    A.cmSum = cs;
    if (inJet()) aiThreats();
    if (inBattle()) pvpTick();
    if (inJet()) { pvpSounds(dt); lockSounds(dt); } else A.wasLock = false;
    // damage this frame -> the hit line
    const hp = P.hp;
    if (A.lastHp == null || hp > A.lastHp + .01) A.lastHp = hp;           // new sortie / repairs
    const drop = Math.max(0, A.lastHp - hp); A.lastHp = hp;
    if (A.ev.length) {
      const big = A.ev.some(e => e.k === 'msl' || e.k === 'shl'), who = (A.ev.find(e => e.who) || {}).who || '';
      const k = big ? 'msl' : A.ev.some(e => e.k === 'flak') ? 'flak' : 'blt', T = A.txt;
      if (T && !big && T.k === k && rt - T.t < 1.1) { T.n += A.ev.length; T.dm += drop; T.t = rt; if (who) T.who = who; }
      else A.txt = { k, n: A.ev.length, dm: drop, t: rt, who };
      A.ev.length = 0;
    } else if (A.txt && rt - A.txt.t < .25) A.txt.dm += drop;
  }

  // ------------------------------------------------------------------ drawing
  // Markers use a top-down "clock" bearing around the reticle: ahead = up, right = right, behind = down
  // (the same clock the voice warnings use). The game already shows AI lock/missile warnings and arrows
  // for AI missiles; online threats are fed into those same warnings (ann / vox) so they look the same.
  function bearing(p) {
    const fl = Math.hypot(cF.x, cF.z) || 1, hx = cF.x / fl, hz = cF.z / fl, o = myPos();
    const dx = p.x - o.x, dz = p.z - o.z, ahead = dx * hx + dz * hz, right = -dx * hz + dz * hx;
    return Math.atan2(-ahead, right);
  }
  function onScreen(p) {
    t1.copy(p).sub(C.position);
    if (t1.dot(cF) <= 0) return null;
    t2.copy(p).project(C);
    if (Math.abs(t2.x) > .9 || Math.abs(t2.y) > .86) return null;
    return { x: (t2.x * .5 + .5) * CW_, y: (-t2.y * .5 + .5) * CH_ };
  }
  const km = d => (d < 1000 ? Math.round(d / 10) * 10 + ' M' : (d / 1000).toFixed(1) + ' KM');

  function pvpWarnings() {                                            // queued BEFORE the game's HUD draws them
    let msl = 0, lock = null, trk = null;
    for (const T of A.thr) {
      if (!T.pvp) continue;
      if (T.k === 'msl') msl = 1; else if (T.k === 'lock') lock = lock || T; else trk = trk || T;
    }
    if (msl) G(() => ann('MISSILE ALERT', HR, 8, 17, 0, 1));
    if (lock) G(() => ann('LOCKED · ' + lock.nm, HR, 7, 15, 1, 1));
    else if (trk) G(() => ann('WARNING · ' + trk.nm + ' LOCKING ON', '#ffb050', 5, 13));
  }
  function drawThreats(cx, cy) {
    if (!A.thr.length) return;
    const R = Math.min(CW_, CH_) * .27, bl = Math.sin(rt * 14) > 0, mp = myPos();   // same ring as the hit wedges
    let msl = 0;
    U.lineWidth = 2 * UF;
    for (const T of A.thr) {
      const s = onScreen(T.p), col = T.k === 'trk' ? AMB : RED, d = T.p.distanceTo(mp);
      if (T.k === 'msl') msl = 1;
      U.globalAlpha = T.k === 'trk' || bl ? 1 : .55;
      U.strokeStyle = col; U.fillStyle = col;
      if (s) {                                                         // on screen: bracket it
        const r = (T.k === 'msl' ? 11 : 17) * UF;
        U.beginPath();
        if (T.k === 'msl') { U.moveTo(s.x, s.y - r); U.lineTo(s.x + r, s.y); U.lineTo(s.x, s.y + r); U.lineTo(s.x - r, s.y); U.closePath(); }
        else for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          U.moveTo(s.x + sx * r, s.y + sy * r * .45); U.lineTo(s.x + sx * r, s.y + sy * r); U.lineTo(s.x + sx * r * .45, s.y + sy * r);
        }
        U.stroke();
        tx(T.k === 'msl' ? 'MISSILE ' + km(d) : (T.k === 'lock' ? 'LOCKED ON YOU' : 'LOCKING'), s.x, s.y - r - 6 * UF, col, 'center', 8, 1);
      } else if (T.k === 'msl') {                                      // off screen, online missile: the game's own arrow style
        if (!T.pvp) continue;
        const c = G(() => cdir(T.p)); if (!c) continue;
        const a = Math.atan2(-c.y, c.x), R_ = 74 * UF;
        G(() => tri(cx + Math.cos(a) * R_, cy + Math.sin(a) * R_, a + Math.PI, 10 * UF, bl ? HR : 'rgba(255,82,82,.45)'));
      } else {                                                         // off screen locker: arrow on the clock ring
        const a = bearing(T.p), x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        G(() => tri(x, y, a, 12 * UF, col));
        tx(T.k === 'lock' ? 'LOCK' : 'TRK', x - Math.cos(a) * 18 * UF, y - Math.sin(a) * 18 * UF + 3 * UF, col, 'center', 8, 1);
        if (T.pvp) tx(T.nm, x - Math.cos(a) * 18 * UF, y - Math.sin(a) * 18 * UF + 14 * UF, col, 'center', 7);
      }
    }
    U.globalAlpha = 1;
    if (msl) {                                                         // pulsing red frame while a missile is inbound
      U.strokeStyle = `rgba(255,40,30,${(.3 + .25 * Math.sin(rt * 14)).toFixed(3)})`;
      U.lineWidth = 7 * UF;
      U.strokeRect(3.5 * UF, 3.5 * UF, CW_ - 7 * UF, CH_ - 7 * UF);
    }
  }
  function drawHits(cx, cy) {
    const w = CW_, h = CH_, R = Math.min(w, h) * .27;
    if (A.vig > .02) {
      const g = U.createRadialGradient(cx, cy, Math.min(w, h) * .3, cx, cy, Math.hypot(cx, cy));
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,25,15,${(.6 * A.vig).toFixed(3)})`);
      U.fillStyle = g; U.fillRect(0, 0, w, h);
    }
    U.lineCap = 'butt';
    for (const H of A.hits) {
      const big = H.k === 'msl' || H.k === 'shl', life = big ? 2.6 : 1.6, age = rt - H.t;
      const pos = H.src && H.src.p ? H.src.p : H.pos;
      if (age > life || !pos) continue;
      const a = bearing(pos), k = 1 - age / life, sp = big ? .42 : .26;
      U.strokeStyle = `rgba(255,${big ? 40 : 70},${big ? 30 : 50},${(.9 * k).toFixed(3)})`;
      U.lineWidth = (big ? 16 : 9) * UF;
      U.beginPath(); U.arc(cx, cy, R, a - sp, a + sp); U.stroke();
      if (age < .15) {
        U.strokeStyle = 'rgba(255,240,220,.9)'; U.lineWidth = 3 * UF;
        U.beginPath(); U.arc(cx, cy, R - (big ? 10 : 7) * UF, a - sp * .8, a + sp * .8); U.stroke();
      }
    }
    const T = A.txt;
    if (T && rt - T.t < 1.8 && P) {
      const big = T.k === 'msl';
      const name = big ? 'MISSILE HIT' : T.k === 'flak' ? 'FLAK HIT' : T.n > 1 ? 'GUN HITS ×' + T.n : 'GUN HIT';
      const s = name + '  −' + Math.max(1, Math.round(T.dm)) + '  ·  HULL ' + Math.max(0, Math.round(P.hp)) + '%' + (T.who ? '  ·  ' + T.who : '');
      U.globalAlpha = Math.max(0, Math.min(1, 1 - (rt - T.t - 1.1) / .7));
      const pop = rt - T.t < .12 ? 1.25 : 1;
      tx(s, cx, cy + R + 30 * UF, big ? RED : '#ff8a6a', 'center', (big ? 14 : 11) * pop, 1);
      U.globalAlpha = 1;
    }
  }
  const hudOK = () => st === 1 && !!P && !G(() => HUDOFF) && !G(() => CIN) && !!C;
  function draw(jet) {
    if (!hudOK()) return;
    const cx = CW_ / 2, cy = CH_ / 2;
    U.save(); U.shadowBlur = 0;
    try {
      C.updateMatrixWorld();
      cF.setFromMatrixColumn(C.matrixWorld, 2).negate();
      drawHits(cx, cy);
      if (jet && !P.dead) drawThreats(cx, cy);
    } finally { U.restore(); }
  }
  // flightHUD empties the warning queue (ANN) near its top and draws it right after radioHUD(), so online
  // warnings are queued from a radioHUD wrapper while the flight HUD is drawing
  let inFH = 0;
  if (typeof radioHUD === 'function') {
    const _rh = radioHUD;
    radioHUD = function () {                                          // eslint-disable-line no-global-assign
      const r = _rh.apply(this, arguments);
      try { if (inFH && hudOK() && !P.dead) pvpWarnings(); } catch (e) {}
      return r;
    };
  }
  const _fh = flightHUD;
  flightHUD = function () {                                           // eslint-disable-line no-global-assign
    inFH = 1;
    let r;
    try { r = _fh.apply(this, arguments); } finally { inFH = 0; }
    try { draw(1); } catch (e) {}
    return r;
  };
  if (typeof vehHUD === 'function') {
    const _vh = vehHUD;
    vehHUD = function () {                                            // eslint-disable-line no-global-assign
      const r = _vh.apply(this, arguments);
      try { draw(0); } catch (e) {}
      return r;
    };
  }

  window.ASKIIES_ALERTS = {
    version: '1.1.0',
    betty: () => Object.keys(BETTY.buf).length + '/' + BKEYS.length + ' loaded, ' + Object.keys(BETTY.real).length + ' real',
    say: (k, clock) => bettyPlay(clock ? [k, 'c' + clock] : [k], 99),
    talking: () => !!(G(() => AX) && BETTY.end > AX.currentTime),
    state: () => ({ threats: A.thr.map(t => t.k + (t.pvp ? ':pvp' : '') + ':' + t.nm), ghosts: A.ghosts.size, cm: A.cm, hit: A.txt && A.txt.k })
  };
  console.log('[combat-alerts] threat warnings + hit feedback ready');
})();

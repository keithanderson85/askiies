/* ASKIIES game fixes (game-fixes.js v1.1.0)
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

  g.ASKIIES_FIXES = { version: '1.1.0', fixes: ['#6 battle jets are air targets (lock + damage)', '#11 one score and one ending per battle'], caCtx: () => caCtx, endW: () => endW };
})();

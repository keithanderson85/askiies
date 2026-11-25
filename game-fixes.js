/* ASKIIES game fixes (game-fixes.js v1.0.0)
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

  g.ASKIIES_FIXES = { version: '1.0.0', fixes: ['#6 battle jets are air targets (lock + damage)'], caCtx: () => caCtx };
})();

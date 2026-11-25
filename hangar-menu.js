/* ASKIIES hangar menu reorganisation (hangar-menu.js v1.0.0)
 *
 * Loaded after the game (end of <body>). Pure data changes on the game's own menu system
 * (PAGES / HUB / MENUOWN), so every page keeps the game's look, keys and BACK behaviour:
 *
 *   MAIN    BATTLE · SOLO OPS · ONLINE · VEHICLE < > · QUICK SORTIE · MY JET · WORKSHOP · COMMAND · OPTIONS · INFO
 *   OPTIONS GRAPHICS · CONTROLS & CAMERA · GAMEPLAY · STORY & RADIO · SOUND & MUSIC · ACCOUNT & SAVES · CHEATS & RESET
 *   INFO    FIELD GUIDE · ARCHIVE · UPDATE LOG · ACHIEVEMENTS
 *
 * Also replaces the leftover claude.ai wording (this build saves to the ASKIIES server).
 * Rows are moved by reference, never copied, so dynamic labels and actions keep working.
 * Anything the game adds later that this file does not know lands in a MORE group, not lost.
 */
(function () {
  'use strict';
  const G = f => { try { return f(); } catch (e) { return undefined; } };

  // ------------------------------------------------------------------ wording: no claude.ai left over
  const WORDS = [
    [/saved to your Claude account/g, 'saved to your ASKIIES account'],
    [/synced to your Claude account/g, 'synced to your ASKIIES account'],
    [/Claude account/g, 'ASKIIES account'],
    [/send it to Claude/g, 'send it to the developer'],
    [/Uses Claude when the page (?:can|has access), otherwise a keyword generator\.?/g, 'Built by the keyword generator.'],
    [/Sign in to Claude[^.]*\./g, 'Sign in from the ONLINE page to save to your account.'],
    [/OPEN THE GAME FROM ITS SHARED LINK/g, 'SIGN IN FROM THE ONLINE PAGE'],
    [/ON THIS PAGE NOW/g, 'ONLINE NOW'],
    [/ON THIS PAGE/g, 'ONLINE'],
    [/OPTIONS ▸ SAVE TRANSFER/g, 'OPTIONS ▸ ACCOUNT & SAVES'],
    [/BATTLE ▸ MULTIPLAYER TO JOIN/g, 'PICK THE SAME MODE IN BATTLE TO JOIN'],
    [/ and some app views do not offer it\.?/g, '.'],
    [/\bClaude\b/g, 'ASKIIES']
  ];
  const fix = s => { if (typeof s !== 'string' || s.length < 8) return s; for (const [a, b] of WORDS) s = s.replace(a, b); return s; };
  const quick = s => typeof s === 'string' && s.length > 10 && (s.indexOf('Claude') >= 0 || s.indexOf('MULTIPLAYER TO JOIN') >= 0 || s.indexOf('THIS PAGE') >= 0 || s.indexOf('SHARED LINK') >= 0 || s.indexOf('SAVE TRANSFER') >= 0);
  try { if (typeof ULOG !== 'undefined') for (const u of ULOG) if (u && Array.isArray(u.notes)) u.notes = u.notes.map(fix); } catch (e) {}
  // HUD text, toasts and text-box hints are drawn from string literals inside the game: rewrite on the way out
  try { const _tx = tx; tx = function (s) { if (quick(s)) arguments[0] = fix(s); return _tx.apply(this, arguments); }; } catch (e) {}   // eslint-disable-line no-global-assign
  try { const _t = toastS; toastS = function (s) { if (quick(s)) arguments[0] = fix(s); return _t.apply(this, arguments); }; } catch (e) {}   // eslint-disable-line no-global-assign
  try { const _w = wrapT; wrapT = function (s) { if (quick(s)) arguments[0] = fix(s); return _w.apply(this, arguments); }; } catch (e) {}   // eslint-disable-line no-global-assign
  try { const _a = askText; askText = function (q, d, cb, o) { if (o && quick(o.hint)) o.hint = fix(o.hint); return _a.apply(this, arguments); }; } catch (e) {}   // eslint-disable-line no-global-assign

  // ------------------------------------------------------------------ menu structure
  function setup() {
    if (typeof PAGES === 'undefined' || typeof HUB === 'undefined' || !Array.isArray(HUB) || typeof MENUOWN === 'undefined') return;
    if (PAGES.main && PAGES.main._hm) return;
    const BK = { l: '< BACK', go: 'main', d: 'Back.' };
    const byGo = (R, g) => R.find(r => r && r.go === g);
    const byL = (R, re) => R.find(r => r && typeof r.l === 'string' && re.test(r.l));

    // ---- OPTIONS: one flat 46-row list -> groups
    const O = PAGES.opt && PAGES.opt.rows;
    if (Array.isArray(O)) {
      const GROUPS = [
        ['og_gfx', 'GRAPHICS', 'Aircraft models, terrain engine and quality, pixels, effects, fullscreen and performance.',
          r => ['pmode', 'tmode', 'tqual', 'tres', 'ores', 'terr2', 'envd', 'pfx', 'dof', 'plx', 'lzs', 'perf'].includes(r.k) || /FULLSCREEN|PERFORMANCE OVERLAY/.test(r.l)],
        ['og_ctl', 'CONTROLS & CAMERA', 'Keybinds, mouse control, pitch keys, on-screen buttons, camera and aim assists.',
          r => ['mctrl', 'pinv', 'obtn', 'cam', 'aim', 'gas'].includes(r.k) || r.go === 'keys'],
        ['og_play', 'GAMEPLAY', 'Difficulty, loadout, missile rails, fuel, mission start, hit camera and warnings.',
          r => ['dif', 'real', 'rrail', 'fuelx', 'tko', 'xr', 'peni', 'vox'].includes(r.k)],
        ['og_story', 'STORY & RADIO', 'Briefings, squadron intros, cutscenes and radio portraits / voices.',
          r => ['brf', 'sqin', 'cine', 'intro', 'pv', 'babl'].includes(r.k)],
        ['og_snd', 'SOUND & MUSIC', 'Sound on/off, volumes, the music library and mixing with other apps.',
          r => ['snd', 'mvolv', 'sfxv', 'musv'].includes(r.k) || r.go === 'mlib' || /MIX WITH OTHER/.test(r.l)],
        ['acct', 'ACCOUNT & SAVES', 'Your pilot account, cloud save, and save files: export, import, copy or paste a save code.',
          r => r.go === 'acct' || r.go === 'svt'],
        ['og_dev', 'CHEATS & RESET', 'Unlock everything, infinite resources and resetting your progress.',
          r => /UNLOCK|INFINITE|RESET PROGRESS|ERASE EVERYTHING/.test(r.l)]
      ];
      const rest = O.filter(r => !(typeof r.l === 'string' && r.l[0] === '<'));
      const used = new Set(), groupRows = [];
      for (const [id, title, d, test] of GROUPS) {
        const rows = rest.filter(r => !used.has(r) && G(() => test(r)));
        rows.forEach(r => used.add(r));
        if (id === 'acct') { groupRows.push({ l: title, go: 'acct', d }); continue; }   // the account page is built by mp-client.js / the game
        if (!rows.length) continue;
        PAGES[id] = { t: title, rows: [BK, ...rows] };
        MENUOWN[id] = 'opt';
        groupRows.push({ l: title, go: id, d });
      }
      const more = rest.filter(r => !used.has(r));
      if (more.length) { PAGES.og_more = { t: 'MORE', rows: [BK, ...more] }; MENUOWN.og_more = 'opt'; groupRows.splice(groupRows.length - 1, 0, { l: 'MORE', go: 'og_more', d: 'Other settings.' }); }
      O.length = 0; O.push({ l: '< BACK', go: 'main', d: 'Back to the hangar.' }, ...groupRows);
      PAGES.opt.t = 'OPTIONS';
      delete MENUOWN.opt;                        // OPTIONS now lives on the main menu
      try { CAMP.opt = CAMP.main; for (const g of GROUPS) CAMP[g[0]] = CAMP.main; } catch (e) {}
    }

    // ---- INFO: guide / archive / log / achievements (options moved out)
    if (PAGES.minfo) {
      PAGES.minfo.t = 'INFO';
      PAGES.minfo.rows = PAGES.minfo.rows.filter(r => r.go !== 'opt' && r.go !== 'acct');
      try { MENUG.minfo.d = 'Field guide, archive, update log and achievements.'; } catch (e) {}
    }

    // ---- save transfer lives under ACCOUNT & SAVES; its BACK returns there
    MENUOWN.svt = 'acct';

    // ---- MAIN: play · your ride · build · manage
    const old = HUB.slice(), take = [];
    const pick = r => { if (r && !take.includes(r)) take.push(r); return r; };
    pick(byGo(old, 'modes'));
    pick(byGo(old, 'mfly'));
    pick(old.find(r => r.amp));                                        // ONLINE (mp-client.js)
    pick(old.find(r => r.k === 'mv' || r.k === 'ac'));                 // vehicle selector
    const qs = pick(byL(old, /^QUICK SORTIE/));
    pick(byGo(old, 'mjet'));
    pick(byGo(old, 'mshop'));
    pick(byGo(old, 'mcmd'));
    const extra = old.filter(r => !take.includes(r) && r.go !== 'acct' && r.go !== 'minfo');   // anything new upstream adds
    take.push(...extra);
    take.push({ l: 'OPTIONS', go: 'opt', d: 'Graphics, controls & camera, gameplay, story, sound, your account & saves.' });
    const info = byGo(old, 'minfo');
    if (info) { info.l = 'INFO'; info.d = 'Field guide, archive, update log and achievements.'; take.push(info); }
    HUB.length = 0; HUB.push(...take.filter(Boolean));
    PAGES.main._hm = 1;
  }

  // ------------------------------------------------------------------ save import / undo actually stick
  // Game bugs (also on claude.ai): the reload after IMPORT / UNDO LAST IMPORT hides the page, and the
  // game's visibilitychange handler calls save(), writing the OLD in-memory save over the imported one.
  // On the next boot its IndexedDB "heal" can also bring the old copy back when it scores higher.
  // Once an import / undo has written the new save, ignore every later write of the save slot until
  // the reload (save is a const in the game, so this is done at the storage layer), keep the backup
  // copy in step, and mark this reload as a deliberate restore so the "heal" leaves it alone.
  const SAVEKEY = (() => { try { return LSK; } catch (e) { return 'ascii-strike'; } })();
  function svLock(newSave) {
    window.__svLock = 1;
    try { sessionStorage.setItem('askiies-healed', String(Date.now())); } catch (e) {}
    try { if (typeof svIdbPut === 'function') { svIdbPut('healedAt', Date.now()); if (newSave) { svIdbPut('save', newSave); svIdbPut('save.ts', Date.now()); } } } catch (e) {}
  }
  try {
    const _set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (window.__svLock && this === window.localStorage && k === SAVEKEY) return;   // import reload in progress
      return _set.apply(this, arguments);
    };
  } catch (e) {}
  try {
    const _ap = svApply;
    svApply = function () {   // eslint-disable-line no-global-assign
      let before = null; try { before = localStorage.getItem(SAVEKEY); } catch (e) {}
      const r = _ap.apply(this, arguments);
      let after = null; try { after = localStorage.getItem(SAVEKEY); } catch (e) {}
      if (after && after !== before) svLock(after);                  // not a save file: nothing changed, keep saving
      return r;
    };
  } catch (e) {}
  try {
    const d = Object.getOwnPropertyDescriptor(PAGES.svt, 'rows');
    if (d && d.get) Object.defineProperty(PAGES.svt, 'rows', {
      configurable: true,
      get() {
        return d.get.call(this).map(r => {
          if (!r || !/^UNDO LAST IMPORT/.test(r.l) || r._fx) return r;
          const a = r.a;
          return Object.assign({}, r, {
            _fx: 1, a: () => {
              let p = null; try { p = localStorage.getItem('ascii-strike.preimport'); } catch (e) {}
              const r = a();
              if (p) svLock(p);
              return r;
            }
          });
        });
      }
    });
  } catch (e) {}

  // ESC / BACKSPACE on a sub-page returns to that page's parent (what its own < BACK row does),
  // instead of always jumping to the hangar. The game's goPage('main') already resolves parents.
  try {
    const _mk = menuKey;
    menuKey = function (k) {   // eslint-disable-line no-global-assign
      if ((k === 'Escape' || k === 'Backspace') && typeof hpg !== 'undefined' && hpg !== 'main' && PAGES[hpg]) {
        const R = PAGES[hpg].rows, b = R && R[0];
        if (b && typeof b.l === 'string' && b.l[0] === '<' && b.go) { try { snd('ui'); } catch (e) {} goPage(b.go); return; }
      }
      return _mk.apply(this, arguments);
    };
  } catch (e) {}

  if (document.readyState === 'complete') setup(); else addEventListener('load', setup);
  window.ASKIIES_MENU = { version: '1.0.0' };
})();

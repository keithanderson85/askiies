/* ASKIIES self-hosted online services (mp-client.js v1.6.0)
 *
 * The game was written for claude.ai artifacts and already contains its own online code:
 * matchmaking lobby, battles, co-op workshop (window.claude.use('room')), cloud saves and the
 * leaderboard (window.claude.use('db') + 'user'). This file provides those same three services,
 * backed by our own server (mp-server, reached at ./mp/), so the game's code runs unchanged.
 *
 * Load it in <head>, BEFORE the game script. It does nothing when a real window.claude exists
 * (i.e. when the game is opened as a claude.ai artifact).
 */
(function () {
  'use strict';
  if (window.claude && window.claude.use) return;

  const BASE = new URL('mp/', document.baseURI);
  const API = p => new URL('api/' + p, BASE).href;
  const WS_URL = (() => { const u = new URL('ws', BASE); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u.href; })();
  const TK = 'askiies-mp-token', SKIP = 'askiies-mp-offline';
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  };

  // ------------------------------------------------------------------ flight mouse buttons
  // Registered here in <head> so it runs BEFORE the game's own right/middle-click guard (which
  // swallows those buttons for everything registered after it).
  //   RIGHT button, hold + move = look around the jet (drives the game's own camera-look stick);
  //                               let go and the camera swings back behind the jet
  //   MIDDLE click              = lock the target under the cursor / release on empty sky (the game's lock)
  const LOOK = { on: 0, x0: 0, y0: 0, dx: 0, dy: 0 };
  const GG = f => { try { return f(); } catch (e) { return undefined; } };
  const flyingNow = () => GG(() => st) === 1 && !GG(() => CIN) && !GG(() => VEHM) && !!GG(() => P) && !GG(() => P.dead);
  function lookEnd() { if (!LOOK.on) return; LOOK.on = 0; window.__ampLook = 0; try { cs = null; cjx = 0; cjy = 0; } catch (e) {} }   // eslint-disable-line no-undef
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 2 || !flyingNow()) return;
    LOOK.on = 1; LOOK.x0 = e.clientX; LOOK.y0 = e.clientY; LOOK.dx = 0; LOOK.dy = 0; window.__ampLook = 1;
    try { cs = 'rmb'; cjx = 0; cjy = 0; } catch (x) {}                                         // eslint-disable-line no-undef
    e.stopImmediatePropagation(); e.preventDefault();                                          // right-click no longer locks
  }, true);
  addEventListener('pointermove', e => {
    if (!LOOK.on) return;
    if (!(e.buttons & 2) || !flyingNow()) { lookEnd(); return; }
    const w = GG(() => CW_) || innerWidth, h = GG(() => CH_) || innerHeight;
    // MOUSE AIM captures the mouse (pointer lock): the cursor stays put, so add up the movement instead
    if (document.pointerLockElement) { LOOK.dx += e.movementX || 0; LOOK.dy += e.movementY || 0; }
    else { LOOK.dx = e.clientX - LOOK.x0; LOOK.dy = e.clientY - LOOK.y0; }
    LOOK.dx = Math.max(-w * .3, Math.min(w * .3, LOOK.dx)); LOOK.dy = Math.max(-h * .35, Math.min(h * .35, LOOK.dy));
    try {
      cjx = LOOK.dx / (w * .3);                                                                // eslint-disable-line no-undef
      cjy = LOOK.dy / (h * .35);                                                               // eslint-disable-line no-undef
    } catch (x) {}
  }, true);
  addEventListener('pointerup', e => { if (e.button === 2) lookEnd(); }, true);
  addEventListener('blur', lookEnd);

  // ------------------------------------------------------------------ session
  let token = ls.get(TK), me = null, uiState = 'boot';   // boot | online | offline | down
  let readyRes; const ready = new Promise(r => { readyRes = r; });

  function mkErr(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
  async function call(path, body, method) {
    let r;
    try {
      r = await fetch(API(path), {
        method: method || (body ? 'POST' : 'GET'),
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
      });
    } catch (e) { throw mkErr('unavailable', 'server unreachable'); }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const e = mkErr((j && j.error) || 'http_' + r.status, (j && j.message) || ('HTTP ' + r.status));
      if (r.status === 401 && token && path !== 'login') signedOut();
      throw e;
    }
    return j;
  }
  function signedIn(j) {
    if (j.token) { token = j.token; ls.set(TK, token); }
    me = { id: j.id, callsign: j.callsign, display: j.display || j.callsign };
    csSynced = null;   // push the account's display callsign into the game
    ls.set(SKIP, null);
    uiState = 'online'; uiChanged();
    readyRes(me);
    net.connect();
  }
  function signedOut() {
    // session revoked / expired: stay playable offline, ask again
    token = null; ls.set(TK, null);
    if (me) { location.reload(); return; }      // services were live: cleanest is a fresh page
    uiState = 'offline'; uiChanged(); showLogin('Your session ended. Sign in again.');
  }
  async function boot() {
    if (!token) { uiState = 'offline'; uiChanged(); if (!ls.get(SKIP)) setTimeout(() => showLogin(), 1800); return; }
    for (let i = 0; ; i++) {
      try { const j = await call('me'); signedIn(j); return; }
      catch (e) {
        if (e.code === 'unauthenticated') return;          // signedOut() already ran
        uiState = 'down'; uiChanged();
        await new Promise(r => setTimeout(r, Math.min(30000, 3000 * (i + 1))));
      }
    }
  }

  // ------------------------------------------------------------------ rooms (presence over WebSocket)
  const net = {
    ws: null, peer: null, open: false, wait: 1000, rooms: new Map(),   // name -> RoomState
    meta: new Map(),   // peer -> { uid, d }: account id + display name (lets the drawer match friends)
    connect() {
      if (this.ws || !token) return;
      const ws = this.ws = new WebSocket(WS_URL);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token }));
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.recv(m); };
      ws.onclose = ev => {
        this.ws = null; this.open = false; this.peer = null;
        for (const R of this.rooms.values()) { R.peers.clear(); R.notify(); }
        if (ev.code === 4001) { signedOut(); return; }
        if (!token) return;
        setTimeout(() => this.connect(), this.wait);
        this.wait = Math.min(15000, this.wait * 1.7);
        uiState = 'down'; uiChanged();
      };
      ws.onerror = () => {};
    },
    send(m) { if (this.open && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); },
    recv(m) {
      if (m.t === 'hello') {
        this.open = true; this.peer = m.peer; this.wait = 1000;
        uiState = 'online'; uiChanged();
        for (const R of this.rooms.values()) R.sync();   // (re)join every room, resend presence
        return;
      }
      const R = this.rooms.get(m.room); if (!R) return;
      if (m.t === 'peers') { R.peers.clear(); for (const p of m.peers) { R.peers.set(p.peer, p.presence || null); if (p.uid) this.meta.set(p.peer, { uid: p.uid, d: p.d }); } R.joined(); }
      else if (m.t === 'pj') { R.peers.set(m.peer, null); if (m.uid) this.meta.set(m.peer, { uid: m.uid, d: m.d }); }
      else if (m.t === 'pp') R.peers.set(m.peer, m.p || null);
      else if (m.t === 'pl') R.peers.delete(m.peer);
      else if (m.t === 'err') { R.fail(m.error); return; }
      R.notify();
    }
  };

  class RoomState {
    constructor(name) {
      this.name = name; this.peers = new Map(); this.mine = null; this.cbs = []; this.alive = true;
      this.pend = 0; this.waiters = [];
    }
    sync() {
      net.send({ t: 'join', room: this.name });
      if (this.mine) net.send({ t: 'pres', room: this.name, p: this.mine });
    }
    joined() { const w = this.waiters; this.waiters = []; w.forEach(f => f.ok()); }
    fail(err) { const w = this.waiters; this.waiters = []; w.forEach(f => f.no(mkErr('unavailable', err))); }
    list() {
      const out = [];
      for (const [peer, presence] of this.peers) {
        const self = peer === net.peer;
        out.push({ peer, sameTab: self, guest: false, presence: self ? this.mine : presence });
      }
      if (net.peer && !this.peers.has(net.peer) && this.mine) out.push({ peer: net.peer, sameTab: true, guest: false, presence: this.mine });
      return out;
    }
    notify() {
      // coalesce bursts (battle presence arrives at ~10 Hz per pilot) into one callback per ~frame
      if (this.pend || !this.alive) return;
      this.pend = setTimeout(() => {
        this.pend = 0; if (!this.alive) return;
        const ch = { peers: this.list() };
        for (const c of this.cbs) { try { c.ok(ch); } catch (e) { console.error('[mp] onPeers callback', e); } }
      }, 16);
    }
  }

  function roomApi(R) {
    return {
      onPeers(cb, errCb) {
        if (typeof cb !== 'function') return () => {};
        const e = { ok: cb, err: errCb };
        R.cbs.push(e); R.notify();
        return () => { R.cbs = R.cbs.filter(x => x !== e); };
      },
      presence(obj) {
        // combat-alerts.js adds lock / missile / flare data to battle presence through this hook
        if (obj && typeof obj === 'object' && typeof window.__ampPres === 'function') { try { obj = window.__ampPres(obj) || obj; } catch (e) {} }
        R.mine = (obj && typeof obj === 'object') ? JSON.parse(JSON.stringify(obj)) : null;
        net.send({ t: 'pres', room: R.name, p: R.mine });
        R.notify();
        return Promise.resolve();
      },
      join(name) { return openRoom(String(name)); },
      leave() {
        if (!R.alive) return Promise.resolve();
        R.alive = false; net.send({ t: 'leave', room: R.name }); net.rooms.delete(R.name);
        for (const c of R.cbs) { try { c.err && c.err(mkErr('left', 'left room')); } catch (e) {} }
        R.cbs = [];
        return Promise.resolve();
      }
    };
  }
  async function openRoom(name) {
    await ready;
    let R = net.rooms.get(name);
    if (!R) {
      R = new RoomState(name); net.rooms.set(name, R);
      if (net.open) {
        await new Promise((ok, no) => { R.waiters.push({ ok, no }); R.sync(); setTimeout(ok, 5000); })
          .catch(e => { net.rooms.delete(name); throw e; });
      }
    }
    return roomApi(R);
  }

  // ------------------------------------------------------------------ db (Firestore-like subset the game uses)
  const snap = (id, r) => ({ id, exists: !!r.exists, data: () => (r.exists ? r.data : undefined) });
  function docRef(path) {
    const id = path.split('/').pop();
    return {
      id, path,
      get: async () => snap(id, await call('db', { op: 'get', path })),
      set: async data => { await call('db', { op: 'set', path, data }); },
      delete: async () => { await call('db', { op: 'delete', path }); }
    };
  }
  function colRef(path) {
    return {
      id: path.split('/').pop(), path,
      doc: id => docRef(path + '/' + id),
      get: async () => {
        const r = await call('db', { op: 'list', path });
        const docs = (r.docs || []).map(d => snap(d.id, { exists: true, data: d.data }));
        return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) };
      }
    };
  }
  const dbApi = { collection: colRef, doc: docRef };
  const userApi = { id: async () => me && me.id, me: async () => me && { id: me.id, name: me.display, callsign: me.callsign } };

  window.claude = {
    selfHosted: true,
    use(name) {
      if (name === 'user') return ready.then(() => userApi);
      if (name === 'db') return ready.then(() => dbApi);
      if (name === 'room') return openRoom('lobby');
      return Promise.resolve(null);   // downloads / sample etc.: the game falls back on its own
    }
  };
  window.ASKIIES_MP = { version: '1.6.0', state: () => uiState, me: () => me, signIn: () => showLogin(), signOut };

  // ================================================================== UI
  // Sign-in box, invite prompt (both styled like the game's own text box), display callsign sync,
  // and the native ONLINE / FRIENDS / pilot / ACCOUNT & SAVES pages in the hangar menu.
  function G(f) { try { return f(); } catch (e) { return undefined; } }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function el(h) { const d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; }
  function shield(node) {
    // keep typing/clicks inside our UI from reaching the game's window-level controls
    for (const t of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'contextmenu'])
      node.addEventListener(t, e => e.stopPropagation());
  }
  function toast(t, c) { try { toastS(t, c || '#7dffa8'); } catch (e) {} }
  function setLobby(o) { try { lobbySet(o); } catch (e) {} }

  const CSS = `
  #amp-ov{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,8,6,.72);
    padding:max(6vh,env(safe-area-inset-top)) 12px 12px;box-sizing:border-box;font-family:"Share Tech Mono",ui-monospace,monospace;color:#f2fff8}
  #amp-ov .bx{width:min(520px,88vw);background:rgba(4,22,20,.96);border:1px solid #74ffb8;box-shadow:0 0 24px rgba(116,255,184,.25);padding:14px 16px 12px;box-sizing:border-box}
  #amp-ov h2{margin:0 0 6px;color:#74ffb8;font-size:13px;letter-spacing:2px;font-weight:normal}
  #amp-ov p{margin:0 0 8px;font-size:11px;color:rgba(242,255,248,.55)}
  #amp-ov label{display:block;font-size:11px;letter-spacing:2px;color:#74ffb8;margin:10px 0 4px}
  #amp-ov label span{color:rgba(242,255,248,.45);letter-spacing:0}
  #amp-ov input{width:100%;box-sizing:border-box;background:#02100d;color:#f2fff8;border:1px solid rgba(116,255,184,.6);font:inherit;font-size:18px;padding:8px;outline:none;letter-spacing:1px}
  #amp-ov input:focus{border-color:#74ffb8}
  #amp-ov .row{display:flex;gap:10px;margin-top:12px;justify-content:flex-end;flex-wrap:wrap}
  #amp-ov button{font:inherit;font-size:14px;padding:8px 22px;cursor:pointer;background:#2f9f5a;color:#fff;border:1px solid #74ffb8}
  #amp-ov button.alt{background:#122a2a;color:#cfe;border:1px solid rgba(116,255,184,.35);padding:8px 16px}
  #amp-ov button:disabled{opacity:.5;cursor:wait}
  #amp-ov .err{color:#ff8a7a;font-size:12px;min-height:15px;margin-top:8px}
  #amp-ov .sw{font-size:11px;color:rgba(242,255,248,.55);margin-top:10px}#amp-ov .sw a{color:#74ffb8;cursor:pointer;text-decoration:underline}
  #amp-iv{position:fixed;left:50%;top:max(14px,env(safe-area-inset-top));transform:translateX(-50%);z-index:99999;width:min(520px,88vw);box-sizing:border-box;
    background:rgba(4,22,20,.96);border:1px solid #74ffb8;box-shadow:0 0 24px rgba(116,255,184,.25);padding:12px 16px 10px;font-family:"Share Tech Mono",ui-monospace,monospace;color:#f2fff8}
  #amp-iv b{color:#74ffb8;font-size:13px;letter-spacing:2px;font-weight:normal}#amp-iv p{margin:6px 0 10px;color:rgba(242,255,248,.6);font-size:11px}
  #amp-iv .row{display:flex;gap:10px;justify-content:flex-end}
  #amp-iv button{font:inherit;font-size:14px;padding:8px 22px;cursor:pointer;background:#2f9f5a;color:#fff;border:1px solid #74ffb8}
  #amp-iv button.alt{background:#122a2a;color:#cfe;border:1px solid rgba(116,255,184,.35);padding:8px 16px}
  #amp-iv .bar{height:2px;background:#74ffb8;margin-top:10px;transition:width .3s linear}`;
  function addCss() { if (!document.getElementById('amp-css')) { const s = document.createElement('style'); s.id = 'amp-css'; s.textContent = CSS; document.head.appendChild(s); } }

  // ------------------------------------------------------------------ sign-in overlay
  let ov = null;
  function closeLogin() { if (ov) { ov.remove(); ov = null; } uiChanged(); }
  function showLogin(note, mode) {
    if (!document.body) { addEventListener('DOMContentLoaded', () => showLogin(note, mode), { once: true }); return; }
    addCss(); if (ov) { ov.remove(); ov = null; }
    if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) {}
    const reg = mode === 'register';
    ov = el(`<div id="amp-ov"><form class="bx" autocomplete="on">
      <h2>${reg ? 'CREATE A PILOT' : 'SIGN IN'}</h2>
      <p>${note || (reg ? 'Create your pilot: pick a login callsign and a password you will remember.' : 'Sign in to fly with friends and keep your jets, missiles and campaign in the cloud.')}</p>
      <label>LOGIN CALLSIGN</label><input name="cs" maxlength="14" autocomplete="username" autocapitalize="characters" spellcheck="false" required>
      <label>PASSWORD</label><input name="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      ${reg ? '<label>DISPLAY CALLSIGN <span style="color:#577">(what others see · optional, change any time)</span></label><input name="disp" maxlength="14" autocomplete="nickname" spellcheck="false">' : ''}
      <div class="err"></div>
      <div class="row"><button type="button" class="alt" data-k="off">PLAY OFFLINE</button><button type="submit">${reg ? 'CREATE PILOT' : 'SIGN IN'}</button></div>
      <div class="sw">${reg ? 'Already a pilot? <a data-k="login">Sign in</a>' : 'New here? <a data-k="reg">Create a pilot</a>'}</div>
    </form></div>`);
    shield(ov);
    const f = ov.querySelector('form'), errEl = ov.querySelector('.err'), btn = f.querySelector('button[type=submit]');
    ov.addEventListener('click', e => {
      const k = e.target && e.target.getAttribute('data-k');
      if (k === 'off') { ls.set(SKIP, '1'); closeLogin(); }
      else if (k === 'reg') showLogin(null, 'register');
      else if (k === 'login') showLogin(null, 'login');
      else if (e.target === ov) { ls.set(SKIP, '1'); closeLogin(); }
    });
    f.addEventListener('submit', async e => {
      e.preventDefault(); errEl.textContent = ''; btn.disabled = true;
      try {
        const body = { callsign: f.cs.value, password: f.pw.value };
        if (reg) body.display = f.disp.value;
        const j = await call(reg ? 'register' : 'login', body);
        closeLogin(); signedIn(j);
        toast('ONLINE AS ' + (j.display || j.callsign));
      } catch (x) {
        errEl.textContent = (x.code === 'unavailable' ? 'Server unreachable. Try again shortly.' : x.message || 'Failed').toUpperCase();
      } finally { btn.disabled = false; }
    });
    document.body.appendChild(ov);
    uiChanged();
    setTimeout(() => { try { f.cs.focus(); } catch (e) {} }, 30);
  }
  async function signOut() {
    try { await call('logout', {}); } catch (e) {}
    token = null; ls.set(TK, null); ls.set(SKIP, '1');
    location.reload();
  }

  // ------------------------------------------------------------------ who is online (from the game's own lobby presence)
  function gamePeers() { const M = G(() => MP_); return (M && M.on && M.peers) || []; }
  function myPeer() { return G(() => MP_.me) || net.peer; }
  function pilots() {
    const seen = new Set(), out = [];
    for (const p of gamePeers()) {
      if (p.sameTab) continue;
      const pr = p.presence || {}, l = pr.lb || {}, mt = net.meta.get(p.peer) || {};
      if (mt.uid) { if (seen.has(mt.uid) || (me && mt.uid === me.id)) continue; seen.add(mt.uid); }   // same pilot in two tabs: list once
      out.push({ peer: p.peer, uid: mt.uid || null, cs: String(l.cs || mt.d || (pr.mm && pr.mm.cs) || 'PILOT').slice(0, 14), l });
    }
    return out.sort((a, b) => a.cs.localeCompare(b.cs));
  }
  function doing(l) {
    const mode = k => G(() => CAMN[k]) || String(k || '').toUpperCase();
    const mapN = i => G(() => MAPS[i].n) || '';
    if (!l || !l.st) return { t: 'ONLINE', c: '' };
    if (l.st === 'battle') return { t: 'IN BATTLE · ' + mode(l.k) + (mapN(l.map) ? ' · ' + mapN(l.map) : ''), c: 'bt' };
    if (l.st === 'q') return { t: 'SEARCHING · ' + mode(l.k), c: 'q' };
    if (l.st === 'solo') return { t: 'FLYING SOLO', c: '' };
    return { t: 'IN THE HANGAR', c: '' };
  }
  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    return s < 3600 ? 'SEEN RECENTLY' : s < 86400 ? 'SEEN ' + Math.round(s / 3600) + ' H AGO' : 'SEEN ' + Math.round(s / 86400) + ' D AGO';
  }

  // ------------------------------------------------------------------ friends
  const FR = { list: [], addedMe: [], ids: new Set(), t: 0, busy: 0 };
  async function frLoad() {
    if (!me || FR.busy) return;
    FR.busy = 1;
    try { const r = await call('friends'); FR.list = r.friends || []; FR.addedMe = r.addedMe || []; FR.ids = new Set(FR.list.map(f => f.id)); FR.t = Date.now(); }
    catch (e) {} finally { FR.busy = 0; }
  }
  async function frAdd(q) {
    try { await call('friends/add', q); toast('FRIEND ADDED'); await frLoad(); NAV.cache = {}; return true; }
    catch (e) { toast(String(e.message || 'could not add').toUpperCase(), '#ff7a6a'); return false; }
  }
  async function frRemove(id, name) {
    if (!confirm('Remove ' + name + ' from your friends?')) return;
    try { await call('friends/remove', { id }); } catch (e) {}
    await frLoad(); NAV.cache = {};
  }

  // ------------------------------------------------------------------ invites (game's lobby presence + its own match launcher)
  const MODES = {
    d1: { name: '1V1 DUEL', d: 'Jets. You against them, first out of tickets loses.' },
    air: { name: 'TEAM UP · AIR BATTLE', d: 'Same side, against AI squadrons.' },
    sq: { name: 'SQUADRON ATTACK', d: 'Co-op: the two of you against an AI strike wing.' }
  };
  const INV = { out: null, seen: {}, banner: null, bannerKey: null };
  const ROOM_OK = /^ask-(d1|air|sq)-\d{1,6}-inv$/;
  function makeMatch(k, them) {
    const cs = String(G(() => OPT.cs) || (me && me.display) || 'PILOT').slice(0, 14);
    const seed = (Math.random() * 1e9) | 0;
    const maps = G(() => CAMAP.air) || [0];       // invites are jet matches on an air-battle map
    const a = { p: myPeer(), cs, cls: 'j' }, b = { p: them.peer, cs: them.cs, cls: 'j' };
    // team = roster index % 2, so a spacer puts both pilots on the same side for TEAM UP
    const roster = k === 'air' ? [a, { p: '_slot', cs: '', cls: 'j' }, b] : [a, b];
    return { st: 'host', k, room: 'ask-' + k + '-' + (seed % 1e6) + '-inv', seed, map: maps[seed % maps.length], roster, wall: Date.now() };
  }
  function launch(m) {
    try {
      if (G(() => CA.on)) { try { caLeave(); } catch (e) {} }
      if (G(() => MM)) { try { MM = null; } catch (e) {} setLobby({ mm: null }); }   // eslint-disable-line no-global-assign
      const s = G(() => st);
      if (s !== 0) { try { toHangar(); } catch (e) {} }
      setTimeout(() => {
        try { caLaunch(m); } catch (e) { console.error('[mp] invite launch failed', e); toast('COULD NOT START THE MATCH', '#ff7a6a'); }
      }, s !== 0 ? 800 : 0);
    } catch (e) { console.error('[mp] invite', e); }
  }
  function sendInvite(them, k) {
    if (INV.out) { toast('STILL WAITING FOR ' + INV.out.cs + ' TO ANSWER', '#ffd36a'); return; }
    const m = makeMatch(k, them), id = Math.random().toString(36).slice(2, 10);
    INV.out = { id, to: them.peer, cs: them.cs, k, m, t: Date.now() };
    setLobby({ inv: { id, to: them.peer, k, cs: m.roster[0].cs, m } });
    toast('INVITE SENT TO ' + them.cs + ' · ' + MODES[k].name);
    NAV.cache = {};
  }
  function answer(peer, v, ok) {
    closeBanner();
    setLobby({ invr: { id: v.id, to: peer, ok: ok ? 1 : 0 } });
    setTimeout(() => setLobby({ invr: null }), 8000);
    if (ok) { toast('JOINING ' + v.cs + ' · ' + MODES[v.k].name); setTimeout(() => launch(v.m), 2500); }
  }
  setInterval(() => {
    if (!me) return;
    const ps = gamePeers(), o = INV.out;
    if (o) {
      const p = ps.find(x => x.peer === o.to), r = p && p.presence && p.presence.invr;
      if (r && r.id === o.id) {
        INV.out = null; setLobby({ inv: null });
        if (r.ok) { toast(o.cs + ' ACCEPTED · ' + MODES[o.k].name); setTimeout(() => launch(o.m), 2300); }
        else toast(o.cs + ' DECLINED', '#ffd36a');
        NAV.cache = {};
      } else if (!p || Date.now() - o.t > 30000) {
        INV.out = null; setLobby({ inv: null });
        toast(p ? o.cs + ' DID NOT ANSWER' : o.cs + ' WENT OFFLINE', '#ffd36a');
        NAV.cache = {};
      }
    }
    const mine = myPeer();
    if (INV.banner) {
      const [bp, bid] = INV.bannerKey, p = ps.find(x => x.peer === bp), v = p && p.presence && p.presence.inv;
      if (!v || v.id !== bid) { closeBanner(); toast('INVITE WITHDRAWN', '#ffd36a'); }
      return;
    }
    for (const p of ps) {
      const v = p.presence && p.presence.inv;
      if (p.sameTab || !v || v.to !== mine || INV.seen[v.id]) continue;
      INV.seen[v.id] = 1;
      const m = v.m;
      if (!MODES[v.k] || !m || m.k !== v.k || !ROOM_OK.test(String(m.room)) || !Array.isArray(m.roster) || m.roster.length > 3 || !m.roster.some(r => r && r.p === mine)) continue;
      showInvite(p.peer, v);
      break;
    }
  }, 300);
  function closeBanner() {
    if (!INV.banner) return;
    clearInterval(INV.banner.t);
    INV.banner.el.remove(); INV.banner = null; INV.bannerKey = null;
  }
  // Registered while this file loads in <head>, i.e. BEFORE the game's own key handlers,
  // so Y / N reach an open invite even when the game swallows keys (menus, flight).
  addEventListener('keydown', e => { if (INV.banner) INV.banner.key(e); }, true);
  function showInvite(peer, v) {
    addCss(); closeBanner();
    const fr = FR.ids.has((net.meta.get(peer) || {}).uid);
    const elb = el(`<div id="amp-iv"><b>★ ${fr ? 'YOUR FRIEND ' : ''}${esc(String(v.cs || 'A PILOT').slice(0, 14))} INVITES YOU</b>
      <p>${esc(MODES[v.k].name)} · ${esc(MODES[v.k].d)}</p>
      <div class="row"><button class="alt" data-a="n">DECLINE (N)</button><button data-a="y">ACCEPT (Y)</button></div><div class="bar"></div></div>`);
    shield(elb);
    const t0 = Date.now(), bar = elb.querySelector('.bar');
    const key = e => {
      // the game remaps e.code (e.g. 'MenuKeyY'), so match the end of the code or the key itself
      const c = String(e.code || ''), k = String(e.key || '').toLowerCase();
      const y = /KeyY$/.test(c) || k === 'y', n = /KeyN$/.test(c) || k === 'n';
      if (y || n) { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); if (!e.repeat) answer(peer, v, y); }
    };
    elb.addEventListener('click', e => { const a = e.target.closest('[data-a]'); if (a) answer(peer, v, a.getAttribute('data-a') === 'y'); });
    document.body.appendChild(elb);
    INV.banner = { el: elb, key, t: setInterval(() => { const f = 1 - (Date.now() - t0) / 28000; bar.style.width = Math.max(0, f * 100) + '%'; if (f <= 0) answer(peer, v, false); }, 300) };
    INV.bannerKey = [peer, v.id];
    try { snd('ok'); } catch (e) {}
  }

  // ------------------------------------------------------------------ display callsign
  // The account's display callsign is the truth: it is pushed into the game at sign-in, and
  // renaming in-game (✎ CALLSIGN) or in the drawer saves it back to the account.
  let csSynced = null;
  function setDisplay(v) {
    const d = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 14);
    if (!d || !me) return;
    me.display = d; csSynced = d;
    try { OPT.cs = d; save(); } catch (e) {}
    call('profile', { display: d }).then(() => toast('CALLSIGN SAVED · ' + d)).catch(() => toast('COULD NOT SAVE CALLSIGN', '#ff7a6a'));
    NAV.cache = {};
  }
  setInterval(() => {
    if (!me) return;
    const cur = G(() => OPT.cs);
    if (typeof cur !== 'string') return;
    if (csSynced === null) {
      if (cur !== me.display) { try { OPT.cs = me.display; save(); } catch (e) {} }
      csSynced = me.display; return;
    }
    if (cur !== csSynced) setDisplay(cur);
  }, 1000);

  // ------------------------------------------------------------------ ONE pilots list
  // A small docked window under the hangar menu with ONLINE and FRIENDS tabs (see DOCK below).
  // The BATTLE page's bottom-left box and the game's old lobby page open the same window.
  // Account & saves stay on the game's own ACCOUNT & SAVES page (OPTIONS ▸ ACCOUNT & SAVES).
  const NAV = { cache: {} };
  function uiChanged() {
    // signed out / offline: the game's cloud-save status would wait on 'boot' forever; show it as local.
    // (Its pending cloudBoot resumes by itself the moment the player signs in.)
    if (!me) { const C = G(() => CLD); if (C && C.st === 'boot') { C.st = 'local'; C.err = ''; } }
  }
  setInterval(uiChanged, 700);
  setInterval(() => { try { DOCK.tick(); } catch (e) {} }, 250);
  setInterval(() => { if (me && DOCK.el && DOCK.el.style.display !== 'none' && Date.now() - FR.t > 8000) frLoad(); }, 2000);

  function cached(key, fn) {
    const c = NAV.cache[key], now = Date.now();
    if (c && now - c.t < 400) return c.rows;
    const rows = fn(); NAV.cache[key] = { t: now, rows }; return rows;
  }
  function addFriendPrompt() {
    try { askText('Add a friend', '', v => frAdd({ callsign: v }), { max: 14, keep: 1, hint: 'Their login callsign or display callsign · ENTER to add' }); } catch (e) {}
  }
  function editDisplay() {
    try { askText('Your display callsign', me ? me.display : '', v => setDisplay(v), { max: 14, keep: 1, hint: 'What other pilots see in lobbies, battles and on the leaderboard' }); } catch (e) {}
  }
  const BACK = d => ({ l: '< BACK', go: 'main', d: d || 'Back.' });
  const shortDoing = l => {
    if (!l || !l.st) return { t: 'ONLINE', c: '' };
    const mode = G(() => CAMN[l.k]) || '';
    if (l.st === 'battle') return { t: 'BATTLE' + (mode ? ' · ' + mode.replace(/ BATTLES?$/, '') : ''), c: 'bt' };
    if (l.st === 'q') return { t: 'SEARCHING', c: 'q' };
    if (l.st === 'solo') return { t: 'FLYING SOLO', c: '' };
    return { t: 'HANGAR', c: '' };
  };
  function battleOf(o) {
    if (!o || !o.l || o.l.st !== 'battle' || !o.l.room) return null;
    return (G(() => mpBattles()) || []).find(b => b.room === o.l.room) || null;
  }
  function joinBattle(o) {
    const b = battleOf(o);
    if (!b) { toast('THAT BATTLE IS NOT OPEN TO JOIN', HY); return; }
    try { if (G(() => st) !== 0) toHangar(); mpJoin(b); } catch (e) { toast('COULD NOT JOIN', HR); }
  }

  // ---------------------------------------------------------------- the PILOTS window, docked under the main menu
  // A small window in the game's text-box style, placed under the hangar menu (below INFO), with
  // ONLINE and FRIENDS tabs. Click a pilot to open their actions inline: INVITE (duel / team up /
  // squadron), JOIN THEIR BATTLE, ADD or REMOVE FRIEND. The FRIENDS tab has an add-friend box.
  // On the BATTLE page the bottom-left box opens the same window above it.
  const DK_CSS = `
  #amp-dk{position:fixed;z-index:9000;display:flex;flex-direction:column;box-sizing:border-box;background:rgb(4,20,18);border:1px solid rgba(116,255,184,.75);
    box-shadow:0 0 18px rgba(116,255,184,.18);font-family:"Share Tech Mono",ui-monospace,monospace;color:#f2fff8;font-size:13px}
  #amp-dk .tb{display:flex;align-items:stretch;border-bottom:1px solid rgba(116,255,184,.3);flex:none}
  #amp-dk .tab{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;border:0;border-bottom:2px solid transparent;color:rgba(242,255,248,.55);font:inherit;font-size:12px;letter-spacing:2px;padding:8px 4px 6px;cursor:pointer;touch-action:manipulation}
  #amp-dk.sheet{box-shadow:0 0 0 100vmax rgba(0,6,5,.45),0 0 24px rgba(116,255,184,.25)}
  #amp-dk .ls{-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  #amp-dk button{touch-action:manipulation}
  @media (max-height:500px){#amp-dk .tab{letter-spacing:1px;font-size:11px;padding:7px 3px 5px}}
  #amp-dk .tab.on{color:#74ffb8;border-bottom-color:#74ffb8;background:rgba(116,255,184,.08)}
  #amp-dk .tab:hover{color:#f2fff8}
  #amp-dk .mn{flex:none;width:30px;background:transparent;border:0;border-left:1px solid rgba(116,255,184,.2);color:#74ffb8;font:inherit;font-size:13px;cursor:pointer}
  #amp-dk .add{display:flex;gap:6px;padding:7px 8px;border-bottom:1px solid rgba(116,255,184,.15);flex:none}
  #amp-dk .add input{flex:1;min-width:0;background:#02100d;color:#f2fff8;border:1px solid rgba(116,255,184,.5);font:inherit;font-size:14px;padding:5px 7px;outline:none}
  #amp-dk .add input:focus{border-color:#74ffb8}
  #amp-dk .add button,#amp-dk .bt2{background:#2f9f5a;color:#fff;border:1px solid #74ffb8;font:inherit;font-size:12px;padding:5px 10px;cursor:pointer;letter-spacing:1px}
  #amp-dk .ls{flex:1;overflow:auto;min-height:0;padding:2px 0 4px}
  #amp-dk .sec{color:rgba(116,255,184,.65);font-size:10px;letter-spacing:2px;padding:7px 10px 2px}
  #amp-dk .r{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;background:transparent;border:0;border-left:2px solid transparent;color:#f2fff8;font:inherit;font-size:13px;padding:5px 10px;cursor:pointer;text-align:left}
  #amp-dk .r:hover{background:rgba(116,255,184,.1)}
  #amp-dk .r.op{background:rgba(116,255,184,.14);border-left-color:#74ffb8}
  #amp-dk .r .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:1px}
  #amp-dk .r .s{font-size:10.5px;color:#7dffa8;white-space:nowrap}
  #amp-dk .r .s.bt{color:#ffb36a}#amp-dk .r .s.q{color:#ffd36a}#amp-dk .r .s.off{color:rgba(242,255,248,.35)}
  #amp-dk .r.dim .n{color:rgba(242,255,248,.5)}
  #amp-dk .acts{display:flex;flex-wrap:wrap;gap:5px;padding:4px 10px 8px 12px;background:rgba(116,255,184,.06)}
  #amp-dk .acts button{flex:1 1 46%;background:#122a2a;color:#dff;border:1px solid rgba(116,255,184,.4);font:inherit;font-size:11.5px;padding:6px 6px;cursor:pointer;letter-spacing:1px}
  #amp-dk .acts button.go{background:#2f9f5a;color:#fff;border-color:#74ffb8}
  #amp-dk .acts button:hover{border-color:#74ffb8;filter:brightness(1.15)}
  #amp-dk .acts .note{flex:1 1 100%;font-size:10.5px;color:rgba(242,255,248,.55)}
  #amp-dk .em{color:rgba(242,255,248,.55);font-size:11.5px;padding:8px 10px}
  #amp-dk .ft{flex:none;border-top:1px solid rgba(116,255,184,.2);padding:5px 10px;font-size:10.5px;color:rgba(242,255,248,.5);display:flex;justify-content:space-between;gap:8px}
  #amp-dk.min .add,#amp-dk.min .ls,#amp-dk.min .ft{display:none}`;
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const DOCK = {
    el: null, tab: lsGet('amp-dk-tab') || 'online', min: lsGet('amp-dk-min') === '1', open: null, modes: false, geo: null, last: '',
    build() {
      if (this.el || !document.body) return;
      if (!document.getElementById('amp-dkcss')) { const s = document.createElement('style'); s.id = 'amp-dkcss'; s.textContent = DK_CSS; document.head.appendChild(s); }
      this.el = el(`<div id="amp-dk" style="display:none">
        <div class="tb"><button class="tab" data-t="online"></button><button class="tab" data-t="friends"></button><button class="mn" data-a="min" title="Collapse"></button></div>
        <form class="add" autocomplete="off"><input name="q" maxlength="14" placeholder="Add friend by callsign" spellcheck="false"><button>ADD</button></form>
        <div class="ls"></div><div class="ft"></div></div>`);
      shield(this.el);
      this.el.addEventListener('click', e => this.click(e));
      this.el.querySelector('.add').addEventListener('submit', async e => {
        e.preventDefault(); const i = e.target.q, v = i.value.trim(); if (!v) return;
        if (await frAdd({ callsign: v })) i.value = '';
        this.render(true);
      });
      document.body.appendChild(this.el);
      // phone sheet: a tap anywhere outside closes it
      document.addEventListener('pointerdown', e => { if (this.sheet && this.compact && this.el && !this.el.contains(e.target)) { this.sheet = false; this.tick(); } }, true);
    },
    show(where) { if (where === 'modes') this.modes = true; if (this.min) { this.min = false; lsSet('amp-dk-min', '0'); } this.sheet = true; this.tick(); },
    click(e) {
      const tb = e.target.closest('[data-t]');
      if (tb) { this.tab = tb.getAttribute('data-t'); lsSet('amp-dk-tab', this.tab); this.open = null; if (this.compact) this.sheet = true; else if (this.min) { this.min = false; lsSet('amp-dk-min', '0'); } if (this.tab === 'friends' && me) frLoad(); this.render(true); this.blur(); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      const act = a.getAttribute('data-a'), id = a.getAttribute('data-id');
      if (act === 'min') { if (this.compact) this.sheet = !this.sheet; else { this.min = !this.min; lsSet('amp-dk-min', this.min ? '1' : '0'); if (this.min) this.modes = false; } }
      else if (act === 'row') this.open = this.open === id ? null : id;
      else if (act === 'inv') { const o = this.live(id); if (o) sendInvite(o, a.getAttribute('data-k')); }
      else if (act === 'join') { const o = this.live(id); if (o) joinBattle(o); }
      else if (act === 'fadd') { frAdd({ id }).then(() => this.render(true)); }
      else if (act === 'frem') { const f = FR.list.find(x => x.id === id); frRemove(id, f ? f.display : 'this pilot').then(() => { this.open = null; this.render(true); }); }
      else if (act === 'signin') showLogin();
      else if (act === 'reg') showLogin(null, 'register');
      else if (act === 'acct') { try { goPage('acct'); } catch (x) {} }
      this.render(true); this.blur();
      try { snd('ui'); } catch (x) {}
    },
    blur() { setTimeout(() => { const f = document.activeElement; if (f && this.el && this.el.contains(f) && f.tagName === 'BUTTON') f.blur(); }, 0); },   // menu keys keep working
    live(id) { return pilots().find(p => p.uid === id || p.peer === id) || null; },
    // where to draw: measured from the game's own menu each frame (see the hangarUI hook below)
    place() {
      const g = this.geo, cv = G(() => U.canvas); if (!g || !cv) return false;
      const r = cv.getBoundingClientRect(), k = r.width / CW_;
      const s = this.el.style;
      s.left = Math.round(r.left + g.x * k) + 'px'; s.width = Math.round(g.w * k) + 'px';
      this.compact = !g.bottomUp && g.h * k < 100;
      if (this.compact && this.sheet) {
        const top = Math.max(6, r.top + 6), w = Math.max(g.w * k, Math.min(400, window.innerWidth * .52));
        s.top = Math.round(top) + 'px'; s.bottom = ''; s.height = Math.round(Math.min(window.innerHeight, r.bottom) - top - 6) + 'px'; s.maxHeight = ''; s.width = Math.round(w) + 'px';
        return true;
      }
      if (this.compact) { s.bottom = ''; s.top = Math.round(r.top + g.y * k) + 'px'; s.height = ''; s.maxHeight = ''; return true; }
      if (g.bottomUp) { s.top = ''; s.bottom = Math.round(window.innerHeight - (r.top + g.y * k)) + 'px'; s.maxHeight = Math.round(g.h * k) + 'px'; s.height = ''; }
      else { s.bottom = ''; s.top = Math.round(r.top + g.y * k) + 'px'; s.height = this.min ? '' : Math.round(g.h * k) + 'px'; s.maxHeight = ''; }
      return true;
    },
    tick() {
      this.build(); if (!this.el) return;
      const S = G(() => st), P = G(() => hpg), tbx = !!G(() => TBX);
      if (P !== 'modes') this.modes = false;
      if (P !== this.lastPage) { if (this.lastPage) this.sheet = false; this.lastPage = P; }
      const want = S === 0 && !ov && !tbx && !G(() => INTRO.on) && (P === 'main' || (P === 'modes' && this.modes));
      if (!want || !this.place()) { this.el.style.display = 'none'; return; }
      this.el.style.display = '';
      this.el.classList.toggle('min', this.compact ? !this.sheet : this.min);
      this.el.classList.toggle('sheet', !!(this.compact && this.sheet));
      this.render();
    },
    render(force) {
      if (!this.el) return;
      if (!force && document.activeElement && document.activeElement.name === 'q' && this.el.contains(document.activeElement) && this.last) { /* typing: only the list below changes */ }
      const L = me ? pilots() : [], fset = FR.ids;
      const onF = L.filter(o => o.uid && fset.has(o.uid)).length;
      const T = this.el.querySelectorAll('.tab');
      T[0].className = 'tab' + (this.tab === 'online' ? ' on' : ''); T[0].textContent = 'ONLINE · ' + L.length;
      T[1].className = 'tab' + (this.tab === 'friends' ? ' on' : ''); T[1].textContent = 'FRIENDS · ' + onF + '/' + FR.list.length;
      this.el.querySelector('.mn').textContent = (this.compact ? !this.sheet : this.min) ? '▴' : '▾';
      this.el.querySelector('.add').style.display = me && this.tab === 'friends' && !(this.compact ? !this.sheet : this.min) ? '' : 'none';
      let h = '', ft = '';
      const acts = (o, fr) => {
        if (this.open !== (o.uid || o.peer)) return '';
        const id = esc(o.uid || o.peer), pend = INV.out && INV.out.to === o.peer, b = battleOf(o);
        let x = '<div class="acts">';
        if (b) x += `<button class="go" data-a="join" data-id="${id}">JOIN THEIR BATTLE</button>`;
        else if (o.l && o.l.st === 'battle') x += '<span class="note">In a battle that is full or private. Accepting an invite takes them out of it.</span>';
        if (pend) x += '<span class="note">Invite sent · waiting for an answer…</span>';
        else x += `<button class="${b ? '' : 'go'}" data-a="inv" data-k="d1" data-id="${id}">INVITE · 1V1 DUEL</button><button data-a="inv" data-k="air" data-id="${id}">INVITE · TEAM UP</button><button data-a="inv" data-k="sq" data-id="${id}">INVITE · SQUADRON</button>`;
        if (o.uid) x += fr ? `<button data-a="frem" data-id="${id}">REMOVE FRIEND</button>` : `<button data-a="fadd" data-id="${id}">+ ADD FRIEND</button>`;
        return x + '</div>';
      };
      const row = (o, fr) => { const d = shortDoing(o.l), id = esc(o.uid || o.peer), op = this.open === (o.uid || o.peer);
        return `<button class="r${op ? ' op' : ''}" data-a="row" data-id="${id}"><span class="n">${fr ? '★ ' : '● '}${esc(o.cs)}</span><span class="s ${d.c}">${esc(d.t)}</span></button>` + acts(o, fr); };
      if (!me) {
        h = '<div class="em">Sign in to see who is online, add friends, invite pilots to matches and join their battles.</div>'
          + '<div class="acts" style="background:none"><button class="go" data-a="signin">SIGN IN</button><button data-a="reg">CREATE A PILOT</button></div>';
      } else if (uiState !== 'online') {
        h = '<div class="em">Reconnecting to the server…</div>';
      } else if (this.tab === 'online') {
        if (!L.length) h = '<div class="em">Nobody else is online right now.</div>';
        L.slice().sort((a, b) => (fset.has(b.uid) ? 1 : 0) - (fset.has(a.uid) ? 1 : 0)).forEach(o => h += row(o, o.uid && fset.has(o.uid)));
      } else {
        const live = new Map(L.filter(o => o.uid).map(o => [o.uid, o]));
        const on = FR.list.filter(f => live.has(f.id)), off = FR.list.filter(f => !live.has(f.id)), am = FR.addedMe.filter(f => !fset.has(f.id));
        if (!FR.list.length && !am.length) h = '<div class="em">No friends yet. Type a callsign above, or pick someone on the ONLINE tab and choose + ADD FRIEND.</div>';
        if (am.length) { h += '<div class="sec">ADDED YOU</div>'; am.forEach(f => { const o = live.get(f.id); h += `<button class="r" data-a="fadd" data-id="${esc(f.id)}"><span class="n">+ ${esc(f.display)}</span><span class="s">ADD BACK</span></button>`; void o; }); }
        if (on.length) { h += '<div class="sec">ONLINE</div>'; on.forEach(f => h += row(live.get(f.id), 1)); }
        if (off.length) {
          h += '<div class="sec">OFFLINE</div>';
          off.forEach(f => {
            const op = this.open === f.id;
            h += `<button class="r dim${op ? ' op' : ''}" data-a="row" data-id="${esc(f.id)}"><span class="n">○ ${esc(f.display)}</span><span class="s off">${esc(f.last ? ago(f.last).replace('SEEN ', '') : 'OFFLINE')}</span></button>`;
            if (op) h += `<div class="acts"><span class="note">Offline. Invites need them online.</span><button data-a="frem" data-id="${esc(f.id)}">REMOVE FRIEND</button></div>`;
          });
        }
      }
      if (me) ft = `<span>${esc(me.display)}</span><span style="cursor:pointer;color:#74ffb8" data-a="acct">ACCOUNT ›</span>`;
      const key = this.tab + '|' + h + '|' + ft;
      if (!force && key === this.last) return;
      this.last = key;
      this.el.querySelector('.ls').innerHTML = h;
      this.el.querySelector('.ft').innerHTML = ft;
    }
  };

  // ACCOUNT & SAVES: replaces the claude.ai account page; save transfer folded in
  function acctRows() {
    const R = [BACK('Back.')];
    const sv = G(() => PAGES.svt.rows) || [];
    const svRow = re => sv.find(r => r && re.test(r.l));
    if (me) {
      R.push({ l: 'CALLSIGN: ' + me.display + '  ✎', a: editDisplay, d: 'Your display callsign, shown to other pilots. Your login stays ' + me.callsign + '.' },
        { l: 'SYNC NOW', a: () => { try { save(); } catch (e) {} if (typeof cloudPush !== 'function' || !G(() => CLD.col)) { toast('CLOUD SAVE IS STILL CONNECTING', HY); return; } cloudPush(1).then(() => toast(CLD.err ? 'SYNC FAILED · ' + CLD.err : 'SAVED TO YOUR ACCOUNT', CLD.err ? HR : HG)); }, d: 'Upload your progress, builds and settings now. It also happens every 20 seconds and when you leave.' },
        { l: 'RESTORE FROM CLOUD', a: async () => { if (!G(() => CLD.col)) { toast('CLOUD SAVE IS STILL CONNECTING', HY); return; } try { const got = await cloudPull(1); if (got) cloudApply(); else toast('NO CLOUD SAVE YET', HY); } catch (e) { toast('RESTORE FAILED', HR); } }, d: 'Replace this device\'s progress with the copy saved to your account.' });
    } else {
      R.push({ l: 'SIGN IN', a: () => showLogin(), d: 'Sign in to keep your progress in the cloud and play online.' },
        { l: 'CREATE A PILOT', a: () => showLogin(null, 'register'), d: 'New here? Make a pilot: just a callsign and a password.' });
    }
    for (const re of [/^EXPORT SAVE FILE/, /^IMPORT SAVE FILE/, /^COPY SAVE CODE/, /^PASTE SAVE CODE/, /^UNDO LAST IMPORT/]) { const r = svRow(re); if (r) R.push(r); }
    if (me) R.push({ l: 'SIGN OUT', a: () => { if (confirm('Sign out of ' + me.callsign + ' on this browser?')) signOut(); }, d: 'Sign out on this browser. Your progress stays saved to your account.' });
    return R;
  }

  function acctPanel2(px, T) {
    const pw = rpanel(px, T); let y = T + 24 * UF;
    const L = (a, b, c) => { tx(a, px, y, HGd, 'left', 10, 1); tx(String(b), px + pw, y, c || HW, 'right', 11, 1); y += 18 * UF; };
    tx('[ ACCOUNT & SAVES ]', px, y, HG, 'left', 14, 1); y += 24 * UF;
    const C = G(() => CLD) || {};
    if (me) { L('LOGIN', me.callsign); L('SHOWN AS', me.display, HG); }
    else L('ACCOUNT', 'NOT SIGNED IN', HY);
    L('CLOUD SAVE', C.st === 'sync' ? 'ON' : C.st === 'boot' ? 'CONNECTING…' : 'THIS DEVICE ONLY', C.st === 'sync' ? HG : HY);
    if (C.ts) L('LAST UPLOAD', ago(C.ts).replace('SEEN ', ''));
    let sz = 0; try { sz = (localStorage.getItem(LSK) || '').length; } catch (e) {}
    L('SAVE SIZE', Math.round(sz / 1024) + ' KB');
    L('SAVED BUILDS', String(G(() => OPT.lib.sl.length) || 0));
    y += 8 * UF;
    wrapT(me ? 'Your progress, money, research, unlocks, settings, workshop designs and build library are saved to your ASKIIES account every 20 seconds and when you leave, and follow you to any device you sign in on. Save files are a manual backup you can keep or move anywhere.'
      : 'Progress is saved on this device. Sign in to keep it in the cloud, or use EXPORT SAVE FILE to back it up and IMPORT SAVE FILE to load it elsewhere.', pw, 10).forEach(l => { tx(l, px, y, HW, 'left', 10); y += 13 * UF; });
  }


  addEventListener('load', () => {
    try {
      PAGES.acct = { t: 'ACCOUNT & SAVES', get rows() { return cached('acct', acctRows); } };
      PGX.acct = 1;
      // parents that depend on where you came from
      const _g = goPage;
      goPage = function (p) {   // eslint-disable-line no-global-assign
        const from = G(() => hpg);
        if (p === 'mpl') { if (from === 'modes') DOCK.show('modes'); else { if (from !== 'main') _g('main'); DOCK.show(); } return; }   // one lobby: the PILOTS window
        if (p === 'acct' && from && from !== 'svt' && from !== 'acct') MENUOWN.acct = from === 'main' ? undefined : from;
        NAV.cache = {};
        return _g.apply(this, arguments);
      };
      const _lp = logPanel;
      logPanel = function (px, T) {   // eslint-disable-line no-global-assign
        if (hpg === 'acct') return acctPanel2(px, T);
        return _lp.apply(this, arguments);
      };
      // Measure the game's own hangar menu every frame so the PILOTS window sits right under it
      // (below INFO, under the row description when there is room). BATTLE page: the bottom-left
      // box opens the same window just above it.
      const _hu = hangarUI;
      let geoKey = '';
      hangarUI = function () {   // eslint-disable-line no-global-assign
        const r = _hu.apply(this, arguments);
        try {
          let g = null;
          if (G(() => st) === 0 && hpg === 'main') {
            const R = hits.filter(q => q.x < CW_ * .45 && q.w > 90 * UF && q.h >= 14 * UF && q.h <= 36 * UF);
            if (R.length >= 3) {
              const x = SA.l + 26 * UF, right = Math.max(...R.map(q => q.x + q.w)), ylast = Math.max(...R.map(q => q.y + q.h));
              const lim = CH_ - SA.b - 28 * UF;
              let nd = 0;
              try { const rd = PAGES.main.rows[hsel], d = rd && (typeof rd.d === 'function' ? rd.d() : rd.d); if (d) nd = Math.min(wrapT(d, right - x + 8 * UF, 11).length, cl(Math.floor((CH_ - SA.b - 50 * UF - ylast) / (13 * UF)), 2, 4)); } catch (e) {}
              let y = ylast + 14 * UF + nd * 13 * UF;
              if (lim - y < 88 * UF) y = ylast + 3 * UF;          // short screen: sit over the description
              g = { x, w: Math.max(right - x, 230 * UF), y, h: Math.max(56 * UF, lim - y) };
            }
          } else if (G(() => st) === 0 && hpg === 'modes') {
            const Lx = SA.l + 16, by = CH_ - SA.b - 38 * UF, bw = 150 * UF, bh = 26 * UF;
            const q = hits.find(q => Math.abs(q.x - Lx) < 2 && Math.abs(q.y - by) < 2 && Math.abs(q.w - bw) < 2);
            if (q) {
              q.fn = () => { try { snd('ui'); } catch (e) {} if (DOCK.modes) DOCK.modes = false; else DOCK.show('modes'); DOCK.tick(); };
              const n = me ? pilots().length : 0;
              U.shadowBlur = 0; U.fillStyle = 'rgb(16,58,42)'; U.fillRect(Lx, by, bw, bh); U.strokeStyle = '#7dffa8'; U.strokeRect(Lx + .5, by + .5, bw - 1, bh - 1);
              tx(me ? 'PILOTS ONLINE · ' + n : 'PILOTS · SIGN IN', Lx + bw / 2, by + 12 * UF, '#eafff2', 'center', 9, 1);
              tx(me ? 'ONLINE · FRIENDS' : 'TO PLAY WITH FRIENDS', Lx + bw / 2, by + 22 * UF, '#a8d8c0', 'center', 7, 1);
            }
            g = { x: Lx, w: Math.max(300 * UF, bw), y: by - 6 * UF, h: Math.min(340 * UF, by - SA.t - 60 * UF), bottomUp: true };
          }
          if (g) {
            DOCK.geo = g;
            const k = Math.round(g.x) + ',' + Math.round(g.y) + ',' + Math.round(g.w) + ',' + Math.round(g.h) + (g.bottomUp ? 'b' : '') + (DOCK.min ? 'm' : '');
            if (k !== geoKey && DOCK.el && DOCK.el.style.display !== 'none') { geoKey = k; DOCK.place(); }
          }
        } catch (e) {}
        return r;
      };
    } catch (e) { console.warn('[mp] could not hook the hangar', e); }
  });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => boot(), { once: true });
  else boot();
})();

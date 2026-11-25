/* ASKIIES self-hosted online services (mp-client.js v1.3.0)
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
  window.ASKIIES_MP = { version: '1.3.0', state: () => uiState, me: () => me, signIn: () => showLogin(), signOut };

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
      <p>${note || (reg ? 'Create your pilot. You need the invite code from whoever runs this server.' : 'Sign in to fly with friends and keep your jets, missiles and campaign in the cloud.')}</p>
      <label>LOGIN CALLSIGN</label><input name="cs" maxlength="14" autocomplete="username" autocapitalize="characters" spellcheck="false" required>
      <label>PASSWORD</label><input name="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      ${reg ? '<label>DISPLAY CALLSIGN <span style="color:#577">(what others see · optional, change any time)</span></label><input name="disp" maxlength="14" autocomplete="nickname" spellcheck="false">' : ''}
      ${reg ? '<label>INVITE CODE</label><input name="inv" autocomplete="off" spellcheck="false" required>' : ''}
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
        if (reg) { body.invite = f.inv.value; body.display = f.disp.value; }
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

  // ------------------------------------------------------------------ native game pages: ONLINE · FRIENDS · pilot · ACCOUNT & SAVES
  // Built on the game's own menu system (PAGES / goPage / MENUOWN / logPanel), so they look and
  // behave like every other hangar page: arrow keys + Enter, < BACK and Esc, the right-hand panel.
  const NAV = { psel: null, cache: {}, landed: false };
  const isMine = p => p === 'online' || p === 'friends' || p === 'pilot';
  function uiChanged() {
    // signed out / offline: the game's cloud-save status would wait on 'boot' forever; show it as local.
    // (Its pending cloudBoot resumes by itself the moment the player signs in.)
    if (!me) { const C = G(() => CLD); if (C && C.st === 'boot') { C.st = 'local'; C.err = ''; } }
    // after signing in, land on the ONLINE page once per visit
    if (!me || NAV.landed || ov) return;
    if (G(() => st) !== 0 || G(() => hpg) !== 'main' || G(() => INTRO.on)) return;
    NAV.landed = true;
    try { goPage('online'); } catch (e) {}
  }
  setInterval(uiChanged, 700);
  setInterval(() => { if (me && isMine(G(() => hpg)) && Date.now() - FR.t > 8000) frLoad(); }, 2000);

  function cached(key, fn) {
    const c = NAV.cache[key], now = Date.now();
    if (c && now - c.t < 400) return c.rows;
    const rows = fn(); NAV.cache[key] = { t: now, rows }; return rows;
  }
  function openPilot(o) { NAV.psel = o; try { snd('ok'); } catch (e) {} goPage('pilot'); }
  function addFriendPrompt() {
    try { askText('Add a friend', '', v => frAdd({ callsign: v }), { max: 14, keep: 1, hint: 'Their login callsign or display callsign · ENTER to add' }); } catch (e) {}
  }
  function editDisplay() {
    try { askText('Your display callsign', me ? me.display : '', v => setDisplay(v), { max: 14, keep: 1, hint: 'What other pilots see in lobbies, battles and on the leaderboard' }); } catch (e) {}
  }
  const BACK = d => ({ l: '< BACK', go: 'main', d: d || 'Back.' });
  const pilotRow = (o, from) => {
    const fr = o.uid && FR.ids.has(o.uid);
    return { l: (fr ? '★ ' : '● ') + o.cs, a: () => openPilot(Object.assign({ from }, o)), d: () => doing(o.l).t + (fr ? ' · FRIEND' : '') + '. ENTER: invite to a match' + (o.uid && !fr ? ' or add as a friend.' : '.') };
  };

  function onlineRows() {
    const R = [BACK('Back to the hangar.')];
    if (!me) {
      R.push({ l: 'SIGN IN', a: () => showLogin(), d: 'Sign in with your login callsign and password to see who is online, keep a friends list and invite people to matches.' },
        { l: 'CREATE A PILOT', a: () => showLogin(null, 'register'), d: 'New here? You need the invite code from whoever runs this server.' },
        { l: 'ACCOUNT & SAVES', go: 'acct', d: 'Save files: export, import, copy or paste a save code. Works without an account.' });
      return R;
    }
    const L = pilots(), onF = L.filter(o => o.uid && FR.ids.has(o.uid)).length;
    R.push({ l: 'FRIENDS · ' + onF + ' / ' + FR.list.length + ' ONLINE', go: 'friends', d: 'Your friends list: who is online, what they are doing, and invites.' + (FR.addedMe.filter(f => !FR.ids.has(f.id)).length ? ' Someone added you: add them back there.' : '') },
      { l: 'ADD A FRIEND', a: addFriendPrompt, d: 'Type a pilot\'s callsign to add them to your friends list.' },
      { l: 'ACCOUNT & SAVES', go: 'acct', d: 'Your callsign, cloud save, save files, sign out.' });
    if (uiState !== 'online') R.push({ l: 'RECONNECTING…', a: () => toast('RECONNECTING TO THE SERVER…', HY), d: 'Lost the connection to the server. Retrying automatically.' });
    else if (!L.length) R.push({ l: 'NOBODY ELSE ONLINE', a: () => toast('NOBODY ELSE IS ONLINE RIGHT NOW', HY), d: 'Pilots appear here the moment they open the game and sign in.' });
    for (const o of L) R.push(pilotRow(o, 'online'));
    return R;
  }
  function friendRows() {
    const R = [{ l: '< BACK', go: 'main', d: 'Back to ONLINE.' }, { l: 'ADD A FRIEND', a: addFriendPrompt, d: 'Type a pilot\'s callsign to add them to your friends list.' }];
    const live = new Map(pilots().filter(o => o.uid).map(o => [o.uid, o]));
    for (const f of FR.list) {
      const o = live.get(f.id);
      if (o) R.push(pilotRow(o, 'friends'));
      else R.push({ l: '○ ' + f.display, a: () => openPilot({ from: 'friends', off: 1, uid: f.id, cs: f.display, last: f.last }), d: 'OFFLINE' + (f.last ? ' · ' + ago(f.last) : '') + '. ENTER: options.' });
    }
    for (const f of FR.addedMe.filter(f => !FR.ids.has(f.id)))
      R.push({ l: '+ ' + f.display + ' · ADDED YOU', a: () => frAdd({ id: f.id }), d: f.display + ' added you as a friend. ENTER: add them back.' });
    if (!FR.list.length && R.length === 2) R.push({ l: 'NO FRIENDS YET', a: addFriendPrompt, d: 'Add pilots from the ONLINE page, or type their callsign with ADD A FRIEND.' });
    return R;
  }
  function pilotRows() {
    const o0 = NAV.psel, R = [BACK('Back.')];
    if (!o0) return R;
    // follow the pilot if they reconnect (new peer id) or go offline
    const o = (o0.uid && pilots().find(p => p.uid === o0.uid)) || pilots().find(p => p.peer === o0.peer) || null;
    const fr = o0.uid && FR.ids.has(o0.uid);
    if (o) {
      const pend = INV.out && INV.out.to === o.peer;
      for (const k of ['d1', 'air', 'sq'])
        R.push({ l: (pend ? '… ' : 'INVITE · ') + MODES[k].name, a: () => pend ? toast('WAITING FOR ' + o.cs + ' TO ANSWER', HY) : sendInvite(o, k), d: MODES[k].d + (o.l && o.l.st === 'battle' ? ' They are in a battle: accepting takes them out of it.' : '') });
    }
    if (o0.uid) {
      if (fr) R.push({ l: 'REMOVE FRIEND', a: () => frRemove(o0.uid, o0.cs), d: 'Take ' + o0.cs + ' off your friends list.' });
      else R.push({ l: 'ADD FRIEND', a: () => frAdd({ id: o0.uid }), d: 'Add ' + o0.cs + ' to your friends list.' });
    }
    if (!o) R.push({ l: 'OFFLINE', a: () => toast(o0.cs + ' IS OFFLINE', HY), d: o0.cs + ' is not online right now' + (o0.last ? ' (' + ago(o0.last).toLowerCase() + ')' : '') + '. Invites need them online.' });
    return R;
  }

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
        { l: 'CREATE A PILOT', a: () => showLogin(null, 'register'), d: 'New here? You need the invite code from whoever runs this server.' });
    }
    for (const re of [/^EXPORT SAVE FILE/, /^IMPORT SAVE FILE/, /^COPY SAVE CODE/, /^PASTE SAVE CODE/, /^UNDO LAST IMPORT/]) { const r = svRow(re); if (r) R.push(r); }
    if (me) R.push({ l: 'SIGN OUT', a: () => { if (confirm('Sign out of ' + me.callsign + ' on this browser?')) signOut(); }, d: 'Sign out on this browser. Your progress stays saved to your account.' });
    return R;
  }

  // right-hand panels (same drawing kit as the game's own account / update-log panels)
  function sidePanel(px, T) {
    const pw = rpanel(px, T); let y = T + 24 * UF;
    const head = t => { tx(t, px, y, HG, 'left', 14, 1); y += 24 * UF; };
    const row = (a, b, c, d) => { tx(a, px, y, c || HW, 'left', 11, 1); if (b) { y += 13 * UF; tx(b, px + 10 * UF, y, d || HGd, 'left', 9.5); } y += 18 * UF; };
    const para = s => { wrapT(s, pw, 10).forEach(l => { tx(l, px, y, HW, 'left', 10); y += 13 * UF; }); y += 6 * UF; };
    const maxY = CH_ - SA.b - 48 * UF;
    if (!me) { head('[ ONLINE ]'); para('Sign in to see who is online, keep a friends list and invite pilots to duels, team-ups and squadron attacks. Your progress also syncs to your account.'); return; }
    if (hpg === 'pilot' && NAV.psel) {
      const o0 = NAV.psel, o = (o0.uid && pilots().find(p => p.uid === o0.uid)) || null, fr = o0.uid && FR.ids.has(o0.uid);
      head('[ ' + o0.cs + ' ]');
      const d = o ? doing(o.l) : { t: 'OFFLINE' + (o0.last ? ' · ' + ago(o0.last) : ''), c: 'off' };
      row('STATUS', d.t, HGd, d.c === 'bt' ? HR : d.c === 'q' ? HY : o ? HG : HGd);
      row('FRIEND', fr ? 'ON YOUR FRIENDS LIST' : 'NOT ON YOUR LIST', HGd, fr ? HG : HGd);
      if (INV.out && o && INV.out.to === o.peer) row('INVITE', 'SENT · WAITING FOR AN ANSWER', HGd, HY);
      y += 6 * UF; para('Invites are jet matches on an air-battle map. They get a pop-up with ACCEPT (Y) and DECLINE (N) and 30 seconds to answer.');
      return;
    }
    const L = pilots();
    if (hpg === 'friends') {
      const live = new Set(L.map(o => o.uid));
      head('[ FRIENDS · ' + FR.list.filter(f => live.has(f.id)).length + ' / ' + FR.list.length + ' ONLINE ]');
      if (!FR.list.length) para('No friends yet. Pick a pilot on the ONLINE page and choose ADD FRIEND, or use ADD A FRIEND with their callsign.');
      for (const f of FR.list) {
        if (y > maxY) break;
        const o = L.find(p => p.uid === f.id), d = o ? doing(o.l) : null;
        row((o ? '● ' : '○ ') + f.display, o ? d.t : 'OFFLINE' + (f.last ? ' · ' + ago(f.last) : ''), o ? HW : HGd, o ? (d.c === 'bt' ? HR : d.c === 'q' ? HY : HG) : HGd);
      }
      return;
    }
    head('[ PILOTS ONLINE · ' + L.length + ' ]');
    if (uiState !== 'online') { para('Reconnecting to the server…'); return; }
    if (!L.length) para('Nobody else is online right now. Pilots appear here the moment they open the game and sign in.');
    for (const o of L) {
      if (y > maxY) break;
      const d = doing(o.l), fr = o.uid && FR.ids.has(o.uid);
      row((fr ? '★ ' : '● ') + o.cs, d.t, HW, d.c === 'bt' ? HR : d.c === 'q' ? HY : HG);
    }
    y += 6 * UF;
    if (y < maxY) para('SIGNED IN AS ' + me.display + '. Pick a pilot to invite them or add them as a friend.');
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
      PAGES.online = { t: 'ONLINE', get rows() { return cached('online', onlineRows); } };
      PAGES.friends = { t: 'FRIENDS', get rows() { return cached('friends', friendRows); } };
      PAGES.pilot = { get t() { return NAV.psel ? NAV.psel.cs : 'PILOT'; }, get rows() { return cached('pilot', pilotRows); } };
      PAGES.acct = { t: 'ACCOUNT & SAVES', get rows() { return cached('acct', acctRows); } };
      MENUOWN.friends = 'online';
      for (const p of ['online', 'friends', 'pilot', 'acct']) { PGX[p] = 1; try { CAMP[p] = CAMP.log || CAMP.main; } catch (e) {} }
      // parents that depend on where you came from
      const _g = goPage;
      goPage = function (p) {   // eslint-disable-line no-global-assign
        const from = G(() => hpg);
        if (p === 'acct' && from && from !== 'svt' && from !== 'acct') MENUOWN.acct = from === 'main' ? undefined : from;
        if (p === 'pilot' && from && from !== 'pilot') MENUOWN.pilot = from === 'main' ? undefined : from;
        NAV.cache = {};
        if (me && (isMine(p) || p === 'acct') && Date.now() - FR.t > 3000) frLoad();
        return _g.apply(this, arguments);
      };
      const _lp = logPanel;
      logPanel = function (px, T) {   // eslint-disable-line no-global-assign
        if (isMine(hpg)) return sidePanel(px, T);
        if (hpg === 'acct') return acctPanel2(px, T);
        return _lp.apply(this, arguments);
      };
      // ONLINE row on the hangar menu (hangar-menu.js puts it in place)
      const R = PAGES.main.rows;
      if (Array.isArray(R) && !R.some(r => r.amp)) {
        R.splice(2, 0, {
          amp: 1, go: 'online',
          get l() { return !me ? 'ONLINE · SIGN IN' : 'ONLINE · ' + pilots().length + (FR.list.length ? ' · ★ ' + pilots().filter(o => o.uid && FR.ids.has(o.uid)).length : ''); },
          d: () => !me ? 'Sign in to see who is online, keep a friends list and invite pilots to matches.'
            : 'Who is online and what they are doing, your friends list, invites, and your account & saves.'
        });
      }
    } catch (e) { console.warn('[mp] could not build the online pages', e); }
    // INVITE buttons on BATTLE ▸ MULTIPLAYER's own player list open the pilot page
    const orig = G(() => mplUI);
    if (typeof orig !== 'function') return;
    try {
      mplUI = function () {   // eslint-disable-line no-global-assign
        const r = orig.apply(this, arguments);
        try {
          if (!me || !MP_.on) return r;
          const w = CW_, h = CH_, L = SA.l + 14 * UF, Rr = w - SA.r - 14 * UF, T = SA.t + 10 * UF, y0 = T + 34 * UF, y1 = h - SA.b - 44 * UF, cw = (Rr - L) * .42;
          const list = mpPeers(); list.sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0));
          const rows = Math.max(1, Math.floor((y1 - y0 - 24 * UF) / (26 * UF)));
          list.slice(0, rows).forEach((p, i) => {
            if (p.me) return;
            const y = y0 + 24 * UF + i * 26 * UF, bw = 46 * UF, bh = 15 * UF, bx = L + cw - 12 * UF - bw, by = y + 4 * UF;
            const pend = INV.out && INV.out.to === p.peer;
            U.fillStyle = pend ? 'rgba(160,130,40,.75)' : 'rgba(47,159,90,.9)'; U.fillRect(bx, by, bw, bh);
            tx(pend ? 'INVITED' : 'INVITE', bx + bw / 2, by + 10.5 * UF, '#fff', 'center', 7, 1);
            if (!pend) hits.push({ x: bx, y: by, w: bw, h: bh, fn: () => { const o = pilots().find(q => q.peer === p.peer); if (o) openPilot(Object.assign({ from: 'mpl' }, o)); } });
          });
        } catch (e) {}
        return r;
      };
    } catch (e) {}
  });

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => boot(), { once: true });
  else boot();
})();

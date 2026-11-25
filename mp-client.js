/* ASKIIES self-hosted online services (mp-client.js v1.2.0)
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
  window.ASKIIES_MP = { version: '1.2.0', state: () => uiState, me: () => me, signIn: () => showLogin(), signOut };

  // ================================================================== UI
  // Sign-in overlay, the left ONLINE / FRIENDS drawer, invite prompts, display callsign sync.
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
  #amp-ov{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);
    font:14px/1.4 ui-monospace,Consolas,monospace;color:#bdf5d0;padding:16px;box-sizing:border-box}
  #amp-ov .bx{width:100%;max-width:360px;background:#06110d;border:1px solid #2d6;box-shadow:0 0 24px rgba(40,220,110,.18);padding:18px}
  #amp-ov h2{margin:0 0 4px;font-size:16px;letter-spacing:.14em;color:#5f9}
  #amp-ov p{margin:0 0 12px;font-size:12px;color:#8bb}
  #amp-ov label{display:block;font-size:11px;letter-spacing:.1em;color:#7c9;margin:10px 0 4px}
  #amp-ov input{width:100%;box-sizing:border-box;background:#020806;border:1px solid #275;color:#dfe;padding:9px;font:inherit;font-size:16px;text-transform:none}
  #amp-ov input:focus{outline:none;border-color:#5f9}
  #amp-ov .row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  #amp-ov button{flex:1;min-width:120px;padding:10px;font:inherit;font-size:13px;letter-spacing:.1em;cursor:pointer;background:#0d2b1d;color:#bfffd5;border:1px solid #2d6}
  #amp-ov button.alt{background:transparent;color:#8bb;border-color:#355}
  #amp-ov button:disabled{opacity:.5;cursor:wait}
  #amp-ov .err{color:#ff8a7a;font-size:12px;min-height:16px;margin-top:10px}
  #amp-ov .sw{font-size:12px;color:#7c9;margin-top:12px;text-align:center}#amp-ov .sw a{color:#5f9;cursor:pointer;text-decoration:underline}

  #amp-hdl{position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:99996;writing-mode:vertical-rl;transform-origin:center;
    font:11px/1 ui-monospace,Consolas,monospace;letter-spacing:.16em;padding:12px 6px;cursor:pointer;user-select:none;
    background:rgba(5,14,11,.9);border:1px solid #2d6;border-left:0;color:#8fe9b0;box-shadow:0 0 14px rgba(40,220,110,.15)}
  #amp-hdl.off{border-color:#a83;color:#e9c08f}#amp-hdl:hover{background:rgba(12,36,26,.96)}
  #amp-hdl b{color:#fff;font-weight:600}
  #amp-side{position:fixed;left:0;top:8px;bottom:8px;z-index:99997;width:320px;max-width:88vw;display:flex;flex-direction:column;box-sizing:border-box;
    background:rgba(4,11,9,.965);border:1px solid #2d6;border-left:0;box-shadow:0 0 30px rgba(0,0,0,.6),0 0 18px rgba(40,220,110,.12);
    font:12px/1.35 ui-monospace,Consolas,monospace;color:#cfe}
  #amp-side .hd{display:flex;align-items:center;justify-content:space-between;padding:11px 12px 8px;letter-spacing:.16em;color:#5f9;font-size:13px}
  #amp-side .hd .x{cursor:pointer;color:#8bb;padding:2px 6px;letter-spacing:0;border:1px solid #355}
  #amp-side .tabs{display:flex;border-bottom:1px solid #1f4a35;padding:0 8px}
  #amp-side .tab{flex:1;text-align:center;padding:8px 4px;cursor:pointer;letter-spacing:.12em;color:#7a9;border-bottom:2px solid transparent;font-size:11.5px}
  #amp-side .tab.on{color:#eef;border-bottom-color:#5f9}
  #amp-side .add{display:flex;gap:6px;padding:9px 10px;border-bottom:1px solid rgba(80,160,120,.15)}
  #amp-side .add input{flex:1;min-width:0;background:#020806;border:1px solid #275;color:#eef;padding:6px 7px;font:inherit;font-size:13px}
  #amp-side .add input:focus{outline:none;border-color:#5f9}
  #amp-side .amsg{padding:0 10px;font-size:10.5px;min-height:0;color:#ffb36a}
  #amp-side .body{flex:1;overflow:auto;min-height:60px}
  #amp-side .sec{padding:9px 12px 3px;font-size:10px;letter-spacing:.16em;color:#6a9}
  #amp-side .r{display:flex;align-items:center;gap:6px;padding:7px 10px 7px 12px;border-bottom:1px solid rgba(80,160,120,.08)}
  #amp-side .r .dot{width:7px;height:7px;border-radius:50%;background:#3d5;flex:none;box-shadow:0 0 6px #3d5}
  #amp-side .r .dot.bt{background:#ffa64d;box-shadow:0 0 6px #ffa64d}#amp-side .r .dot.q{background:#ffd36a;box-shadow:0 0 6px #ffd36a}
  #amp-side .r .dot.off{background:#3a4a44;box-shadow:none}
  #amp-side .r .n{flex:1;min-width:0}
  #amp-side .r .n b{display:block;color:#eef;font-weight:600;letter-spacing:.05em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #amp-side .r .n i{display:block;font-style:normal;font-size:10.5px;color:#8ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #amp-side .r .n i.bt{color:#ffb36a}#amp-side .r .n i.q{color:#ffd36a}#amp-side .r .n i.off{color:#5a6f68}
  #amp-side button{font:inherit;font-size:10.5px;letter-spacing:.1em;cursor:pointer;background:#0d2b1d;color:#bfffd5;border:1px solid #2d6;padding:5px 8px;flex:none}
  #amp-side button:hover{background:#174a31}#amp-side button.alt{background:transparent;color:#8bb;border-color:#355}
  #amp-side button.ic{padding:5px 7px}
  #amp-side .pend{font-size:10px;color:#ffd36a;flex:none}
  #amp-side .em{padding:14px 12px;color:#8ab;font-size:11.5px}
  #amp-side .mode{display:block;width:calc(100% - 24px);margin:8px 12px 0;text-align:left;padding:9px 10px}
  #amp-side .mode small{display:block;color:#8ab;letter-spacing:0;font-size:10.5px;margin-top:2px}
  #amp-side .ft{border-top:1px solid #1f4a35;padding:8px 12px;color:#8ab;font-size:11px;display:flex;flex-direction:column;gap:6px}
  #amp-side .ft .l{display:flex;justify-content:space-between;align-items:center;gap:6px}
  #amp-side .ft a{color:#5f9;cursor:pointer;text-decoration:underline}
  #amp-side .ft input{flex:1;min-width:0;background:#020806;border:1px solid #2d6;color:#eef;padding:5px;font:inherit;font-size:13px}
  #amp-iv{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99999;width:380px;max-width:calc(100vw - 20px);box-sizing:border-box;
    background:rgba(5,16,12,.97);border:1px solid #5f9;box-shadow:0 0 30px rgba(60,255,140,.25);padding:12px 14px;font:13px/1.35 ui-monospace,Consolas,monospace;color:#dfe}
  #amp-iv b{color:#7dffa8;letter-spacing:.08em}#amp-iv p{margin:4px 0 10px;color:#9bc;font-size:11.5px}
  #amp-iv .row{display:flex;gap:8px}#amp-iv button{flex:1;font:inherit;font-size:12px;letter-spacing:.1em;cursor:pointer;padding:9px;background:#0d2b1d;color:#bfffd5;border:1px solid #2d6}
  #amp-iv button.alt{background:transparent;color:#9bb;border-color:#355}#amp-iv .bar{height:2px;background:#5f9;margin-top:10px;transition:width .3s linear}`;
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
      <h2>${reg ? 'NEW PILOT' : 'ASKIIES ONLINE'}</h2>
      <p>${note || (reg ? 'Create your pilot. You need the invite code from whoever runs this server.' : 'Sign in to fly with friends and keep your jets, missiles and campaign in the cloud.')}</p>
      <label>LOGIN CALLSIGN</label><input name="cs" maxlength="14" autocomplete="username" autocapitalize="characters" spellcheck="false" required>
      <label>PASSWORD</label><input name="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      ${reg ? '<label>DISPLAY CALLSIGN <span style="color:#577">(what others see · optional, change any time)</span></label><input name="disp" maxlength="14" autocomplete="nickname" spellcheck="false">' : ''}
      ${reg ? '<label>INVITE CODE</label><input name="inv" autocomplete="off" spellcheck="false" required>' : ''}
      <div class="err"></div>
      <div class="row"><button type="submit">${reg ? 'CREATE PILOT' : 'SIGN IN'}</button><button type="button" class="alt" data-k="off">PLAY OFFLINE</button></div>
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
    side.render();
  }
  async function frAdd(q) {
    try { await call('friends/add', q); side.flash(''); toast('FRIEND ADDED'); await frLoad(); return true; }
    catch (e) { side.flash(String(e.message || 'could not add').toUpperCase()); return false; }
  }
  async function frRemove(id, name) {
    if (!confirm('Remove ' + name + ' from your friends?')) return;
    try { await call('friends/remove', { id }); } catch (e) {}
    await frLoad();
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
      side.close(true);
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
    side.pick = null; side.render();
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
        side.render();
      } else if (!p || Date.now() - o.t > 30000) {
        INV.out = null; setLobby({ inv: null });
        toast(p ? o.cs + ' DID NOT ANSWER' : o.cs + ' WENT OFFLINE', '#ffd36a');
        side.render();
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
      <div class="row"><button data-a="y">ACCEPT (Y)</button><button class="alt" data-a="n">DECLINE (N)</button></div><div class="bar"></div></div>`);
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
    side.render();
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

  // ------------------------------------------------------------------ the left drawer: ONLINE | FRIENDS
  const SS = { get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} } };
  const side = {
    el: null, hdl: null, isOpen: false, tab: SS.get('amp-tab') || 'online', pick: null, edit: 0, auto: false, lastH: '',
    build() {
      if (this.el || !document.body) return;
      addCss();
      this.hdl = el('<div id="amp-hdl"></div>'); shield(this.hdl);
      this.hdl.addEventListener('click', () => { if (me) this.open(); else showLogin(); });
      this.el = el(`<div id="amp-side" style="display:none">
        <div class="hd"><span>ASKIIES ONLINE</span><span class="x" data-a="close" title="Collapse">◂</span></div>
        <div class="tabs"><div class="tab" data-t="online"></div><div class="tab" data-t="friends"></div></div>
        <form class="add" autocomplete="off"><input name="q" maxlength="14" placeholder="Add friend by callsign" spellcheck="false"><button>ADD</button></form>
        <div class="amsg"></div>
        <div class="body"></div>
        <div class="ft"></div></div>`);
      shield(this.el);
      this.el.addEventListener('click', e => this.click(e));
      this.el.querySelector('.add').addEventListener('submit', async e => {
        e.preventDefault();
        const i = e.target.q, v = i.value.trim(); if (!v) return;
        if (await frAdd({ callsign: v })) i.value = '';
      });
      this.el.addEventListener('keydown', e => {
        if (e.target.name === 'dn') { if (e.key === 'Enter') { setDisplay(e.target.value); this.edit = 0; this.render(); } else if (e.key === 'Escape') { this.edit = 0; this.render(); } }
      });
      document.body.appendChild(this.hdl); document.body.appendChild(this.el);
    },
    open(pickPeer, tab) {
      this.build(); this.isOpen = true; SS.set('amp-side', 'open');
      if (tab) this.tab = tab;
      this.pick = pickPeer || null;
      if (Date.now() - FR.t > 10000) frLoad();
      this.lastH = ''; this.render(); uiChanged();
    },
    close(silent) {
      this.isOpen = false; this.pick = null; this.edit = 0;
      if (!silent) SS.set('amp-side', 'closed');
      uiChanged();
    },
    toggle() { this.isOpen ? this.close() : this.open(); },
    flash(t) { if (this.el) this.el.querySelector('.amsg').textContent = t; },
    click(e) {
      const tb = e.target.closest('[data-t]');
      if (tb) { this.tab = tb.getAttribute('data-t'); SS.set('amp-tab', this.tab); this.pick = null; this.flash(''); if (this.tab === 'friends') frLoad(); this.render(); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      const act = a.getAttribute('data-a'), id = a.getAttribute('data-id'), peer = a.getAttribute('data-p');
      if (act === 'close') this.close();
      else if (act === 'out') signOut();
      else if (act === 'inv') { this.pick = peer; this.render(); }
      else if (act === 'back') { this.pick = null; this.render(); }
      else if (act === 'mode') {
        const t = pilots().find(o => o.peer === this.pick);
        if (t) sendInvite(t, a.getAttribute('data-k')); else { toast('THAT PILOT WENT OFFLINE', '#ffd36a'); this.pick = null; this.render(); }
      }
      else if (act === 'fadd') frAdd({ id });
      else if (act === 'frem') frRemove(id, a.getAttribute('data-n') || 'this pilot');
      else if (act === 'ed') { this.edit = 1; this.render(); setTimeout(() => { const i = this.el.querySelector('input[name=dn]'); if (i) { i.focus(); i.select(); } }, 20); }
      else if (act === 'edx') { this.edit = 0; this.render(); }
      else if (act === 'eds') { const i = this.el.querySelector('input[name=dn]'); setDisplay(i ? i.value : ''); this.edit = 0; this.render(); }
    },
    row(o, extra) {
      const d = doing(o.l), pend = INV.out && INV.out.to === o.peer, fr = o.uid && FR.ids.has(o.uid);
      const btns = (pend ? '<span class="pend">INVITED…</span>' : `<button data-a="inv" data-p="${esc(o.peer)}">INVITE</button>`)
        + (extra !== 'friends' && o.uid && !fr ? `<button class="alt ic" data-a="fadd" data-id="${esc(o.uid)}" title="Add friend">+</button>` : '');
      return `<div class="r"><span class="dot ${d.c}"></span><div class="n"><b>${fr && extra !== 'friends' ? '★ ' : ''}${esc(o.cs)}</b><i class="${d.c}">${esc(d.t)}</i></div>${btns}</div>`;
    },
    render() {
      if (!this.el) return;
      // handle (collapsed state)
      const L = me ? pilots() : [];
      const onF = L.filter(o => o.uid && FR.ids.has(o.uid)).length;
      this.hdl.className = me && uiState === 'online' ? '' : 'off';
      this.hdl.innerHTML = !me ? '▸ SIGN IN · ONLINE' : uiState !== 'online' ? '▸ RECONNECTING…'
        : `▸ ONLINE <b>${L.length}</b> · FRIENDS <b>${onF}</b>`;
      if (!this.isOpen) return;
      if (this.edit && this.el.contains(document.activeElement) && document.activeElement.name === 'dn') return;
      const T = this.el.querySelectorAll('.tab');
      T[0].className = 'tab' + (this.tab === 'online' ? ' on' : ''); T[0].textContent = 'ONLINE · ' + L.length;
      T[1].className = 'tab' + (this.tab === 'friends' ? ' on' : ''); T[1].textContent = 'FRIENDS · ' + onF + '/' + FR.list.length;
      this.el.querySelector('.add').style.display = this.tab === 'friends' && !this.pick ? '' : 'none';
      let h = '';
      const t = this.pick && L.find(o => o.peer === this.pick);
      if (this.pick && !t) this.pick = null;
      if (t) {
        h += `<div class="em">Invite <b style="color:#eef">${esc(t.cs)}</b> to:${t.l && t.l.st === 'battle' ? '<br><span style="color:#ffb36a">They are in a battle right now; accepting takes them out of it.</span>' : ''}</div>`;
        for (const k of ['d1', 'air', 'sq']) h += `<button class="mode" data-a="mode" data-k="${k}">${MODES[k].name}<small>${MODES[k].d}</small></button>`;
        h += `<div style="padding:10px 12px"><button class="alt" data-a="back">‹ BACK</button></div>`;
      } else if (uiState !== 'online') {
        h += `<div class="em">${uiState === 'down' ? 'Reconnecting to the server…' : 'Connecting…'}</div>`;
      } else if (this.tab === 'online') {
        if (!L.length) h += '<div class="em">Nobody else is online right now. Pilots show up here the moment they open the game and sign in.</div>';
        for (const o of L) h += this.row(o, 'online');
      } else {
        const live = new Map(L.filter(o => o.uid).map(o => [o.uid, o]));
        const on = FR.list.filter(f => live.has(f.id)), off = FR.list.filter(f => !live.has(f.id));
        if (!FR.list.length) h += '<div class="em">No friends yet. Add pilots with + on the ONLINE tab, or type their callsign above.</div>';
        if (on.length) { h += `<div class="sec">ONLINE · ${on.length}</div>`; for (const f of on) h += this.row(live.get(f.id), 'friends'); }
        if (off.length) {
          h += `<div class="sec">OFFLINE · ${off.length}</div>`;
          for (const f of off) h += `<div class="r"><span class="dot off"></span><div class="n"><b>${esc(f.display)}</b><i class="off">OFFLINE${f.last ? ' · ' + ago(f.last) : ''}</i></div><button class="alt ic" data-a="frem" data-id="${esc(f.id)}" data-n="${esc(f.display)}" title="Remove friend">✕</button></div>`;
        }
        const am = FR.addedMe.filter(f => !FR.ids.has(f.id));
        if (am.length) {
          h += `<div class="sec">ADDED YOU</div>`;
          for (const f of am) h += `<div class="r"><span class="dot ${live.has(f.id) ? '' : 'off'}"></span><div class="n"><b>${esc(f.display)}</b><i class="${live.has(f.id) ? '' : 'off'}">${live.has(f.id) ? esc(doing(live.get(f.id).l).t) : 'OFFLINE'}</i></div><button data-a="fadd" data-id="${esc(f.id)}">ADD BACK</button></div>`;
        }
      }
      const ft = !me ? '' : (this.edit
        ? `<div class="l"><input name="dn" maxlength="14" value="${esc(me.display)}"><button data-a="eds">SAVE</button><button class="alt" data-a="edx">✕</button></div>`
        : `<div class="l"><span>SHOWN AS <b style="color:#eef">${esc(me.display)}</b> <a data-a="ed">EDIT</a></span></div>`)
        + (me ? `<div class="l"><span>LOGIN: ${esc(me.callsign)}</span><button class="alt" data-a="out">SIGN OUT</button></div>` : '');
      const key = h + '|' + ft;
      if (key === this.lastH) return;
      this.lastH = key;
      this.el.querySelector('.body').innerHTML = h;
      this.el.querySelector('.ft').innerHTML = ft;
    }
  };
  // Visible only in the hangar menus (st 0), never in flight; opens by itself after sign-in.
  function uiChanged() {
    side.build(); if (!side.el) return;
    const inMenus = G(() => st) === 0, show = inMenus && !ov;
    if (show && me && uiState === 'online' && !side.auto && G(() => hpg) === 'main') {
      side.auto = true;
      if (SS.get('amp-side') !== 'closed') { side.isOpen = true; frLoad(); }
    }
    side.hdl.style.display = show && !side.isOpen ? '' : 'none';
    side.el.style.display = show && side.isOpen ? '' : 'none';
    side.render();
  }
  setInterval(uiChanged, 700);
  setInterval(() => { if (me && side.isOpen && side.tab === 'friends' && Date.now() - FR.t > 20000) frLoad(); }, 5000);

  // Hooks into the game once it has loaded: an ONLINE · FRIENDS row in the main hangar menu,
  // and INVITE buttons on BATTLE ▸ MULTIPLAYER's own player list.
  addEventListener('load', () => {
    try {
      const R = PAGES.main.rows;
      if (Array.isArray(R) && !R.some(r => r.amp)) {
        R.splice(1, 0, {
          amp: 1, l: 'ONLINE · FRIENDS',
          a: () => { try { snd('ui'); } catch (e) {} if (me) side.toggle(); else showLogin(); },
          d: () => !me ? 'Sign in to see who is online, add friends and invite them to a match.'
            : 'Who is online right now, your friends list and what everyone is doing. Invite anyone to a duel, a team-up or a squadron attack.'
        });
      }
    } catch (e) { console.warn('[mp] could not add the ONLINE menu row', e); }
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
            if (!pend) hits.push({ x: bx, y: by, w: bw, h: bh, fn: () => { try { snd('ui'); } catch (e) {} side.open(p.peer); } });
          });
        } catch (e) {}
        return r;
      };
    } catch (e) {}
  });

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => { uiChanged(); boot(); }, { once: true });
  else { uiChanged(); boot(); }
})();

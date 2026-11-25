'use strict';
// ASKIIES multiplayer + cloud-save server.
// Emulates the three claude.ai artifact services the game already uses
// (window.claude.use('room' | 'db' | 'user')) so the game's own online code runs unchanged.
//
//   HTTP  /api/register  /api/login  /api/logout  /api/me  /api/password  /api/db  /health
//   WS    /ws            (presence rooms: lobby, battles, co-op workshop)
//
// Runs behind the askiies nginx container at /mp/ (nginx strips the prefix).

const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || '/data/askiies.db';
const INVITE = String(process.env.INVITE_CODE || '').trim();
const SESSION_DAYS = 180;
const MAX_DOC = 1 << 20;          // 1 MB per document (game saves are chunked at 180 KB)
const MAX_LB_DOC = 64 << 10;      // leaderboard rows are small
const USER_QUOTA = 32 << 20;      // 32 MB of documents per account
const MAX_BODY = 2 << 20;
const MAX_WS_MSG = 512 << 10;     // co-op workshop presence carries a whole jet design
const MAX_ROOMS_PER_CONN = 8;
const MAX_PEERS_PER_ROOM = 64;

if (!INVITE) console.warn('[mp] INVITE_CODE is not set: registration is CLOSED until it is.');

// ---------------------------------------------------------------- database
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    callsign TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw TEXT NOT NULL,
    created INTEGER NOT NULL,
    last INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    th TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    created INTEGER NOT NULL,
    last INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS docs_uid ON docs(uid);
  CREATE TABLE IF NOT EXISTS friends (
    uid TEXT NOT NULL,
    fid TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (uid, fid)
  );
  CREATE INDEX IF NOT EXISTS friends_fid ON friends(fid);
`);
// v1.1: display callsign (shown in game) separate from the login callsign
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'display')) db.exec('ALTER TABLE users ADD COLUMN display TEXT');
const Q = {
  userByCs: db.prepare('SELECT * FROM users WHERE callsign = ?'),
  userById: db.prepare('SELECT id, callsign, display FROM users WHERE id = ?'),
  userDisp: db.prepare('UPDATE users SET display = ? WHERE id = ?'),
  userIns: db.prepare('INSERT INTO users (id, callsign, pw, created, last, display) VALUES (?, ?, ?, ?, ?, ?)'),
  userPw: db.prepare('UPDATE users SET pw = ? WHERE id = ?'),
  userSeen: db.prepare('UPDATE users SET last = ? WHERE id = ?'),
  sesIns: db.prepare('INSERT INTO sessions (th, uid, created, last) VALUES (?, ?, ?, ?)'),
  sesGet: db.prepare('SELECT * FROM sessions WHERE th = ?'),
  sesTouch: db.prepare('UPDATE sessions SET last = ? WHERE th = ?'),
  sesDel: db.prepare('DELETE FROM sessions WHERE th = ?'),
  sesDelUser: db.prepare('DELETE FROM sessions WHERE uid = ? AND th <> ?'),
  sesExpire: db.prepare('DELETE FROM sessions WHERE last < ?'),
  docGet: db.prepare('SELECT data, updated FROM docs WHERE path = ?'),
  docOwner: db.prepare('SELECT uid, length(data) AS n FROM docs WHERE path = ?'),
  docSet: db.prepare('INSERT INTO docs (path, uid, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET uid = excluded.uid, data = excluded.data, updated = excluded.updated'),
  docDel: db.prepare('DELETE FROM docs WHERE path = ?'),
  docList: db.prepare("SELECT path, data, updated FROM docs WHERE substr(path, 1, length(?1) + 1) = ?1 || '/' AND instr(substr(path, length(?1) + 2), '/') = 0 ORDER BY updated DESC LIMIT 500"),
  frList: db.prepare('SELECT u.id, u.callsign, coalesce(u.display, u.callsign) AS display, u.last FROM friends f JOIN users u ON u.id = f.fid WHERE f.uid = ? ORDER BY display COLLATE NOCASE'),
  frAddedMe: db.prepare('SELECT u.id, u.callsign, coalesce(u.display, u.callsign) AS display, u.last FROM friends f JOIN users u ON u.id = f.uid WHERE f.fid = ?1 AND NOT EXISTS (SELECT 1 FROM friends g WHERE g.uid = ?1 AND g.fid = f.uid) ORDER BY f.created DESC LIMIT 50'),
  frCount: db.prepare('SELECT count(*) AS n FROM friends WHERE uid = ?'),
  frAdd: db.prepare('INSERT OR IGNORE INTO friends (uid, fid, created) VALUES (?, ?, ?)'),
  frDel: db.prepare('DELETE FROM friends WHERE uid = ? AND fid = ?'),
  userByDisp: db.prepare('SELECT id, callsign FROM users WHERE display = ? COLLATE NOCASE LIMIT 2'),
  quota: db.prepare('SELECT coalesce(sum(length(data)), 0) AS n FROM docs WHERE uid = ?'),
};
setInterval(() => { try { Q.sesExpire.run(Date.now() - SESSION_DAYS * 864e5) } catch (e) {} }, 3600e3).unref();

// ---------------------------------------------------------------- auth helpers
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 << 20 }, (e, k) => e ? rej(e) : res(k)));
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex');
}
async function checkPw(pw, stored) {
  const [v, salt, hex] = String(stored).split('$');
  if (v !== 's1' || !salt || !hex) return false;
  const k = await scrypt(pw, Buffer.from(salt, 'hex'));
  const want = Buffer.from(hex, 'hex');
  return want.length === k.length && crypto.timingSafeEqual(want, k);
}
const sameSecret = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'));
const CS_RE = /^[A-Z0-9][A-Z0-9 _-]{1,13}$/;   // the game shows callsigns up to 14 chars
const normCs = s => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
// display callsign: what other pilots see (game limit 14 chars, printable, no markup)
const normDisp = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 14);

function newSession(uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  Q.sesIns.run(sha(token), uid, now, now);
  return token;
}
function sessionUser(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const th = sha(token);
  const s = Q.sesGet.get(th);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > SESSION_DAYS * 864e5) { Q.sesDel.run(th); return null; }
  if (now - s.last > 3600e3) { Q.sesTouch.run(now, th); Q.userSeen.run(now, s.uid); }
  const u = Q.userById.get(s.uid);
  return u ? { id: u.id, cs: u.callsign, disp: u.display || u.callsign, th } : null;
}

// Simple per-IP limiter for login / register / password attempts
const tries = new Map();
function limited(ip) {
  const now = Date.now(), r = tries.get(ip) || { n: 0, t: now };
  if (now - r.t > 10 * 60e3) { r.n = 0; r.t = now; }
  return r.n >= 12;
}
function failed(ip) {
  const now = Date.now(), r = tries.get(ip) || { n: 0, t: now };
  if (now - r.t > 10 * 60e3) { r.n = 0; r.t = now; }
  r.n++; tries.set(ip, r);
}
setInterval(() => { const cut = Date.now() - 10 * 60e3; for (const [k, r] of tries) if (r.t < cut) tries.delete(k); }, 60e3).unref();

// ---------------------------------------------------------------- document permissions
// The game uses:  data/users/<uid>/savemeta, data/users/<uid>/save<N>   (private cloud save)
//                 lb/<uid>  and  collection('lb')                       (public leaderboard)
const SEG_RE = /^[A-Za-z0-9_.-]{1,96}$/;
function cleanPath(p) {
  if (typeof p !== 'string' || p.length > 300) return null;
  const s = p.replace(/^\/+|\/+$/g, '').split('/');
  if (!s.length || !s.every(x => SEG_RE.test(x) && x !== '.' && x !== '..')) return null;
  return s.join('/');
}
const own = (uid, p) => p === 'data/users/' + uid || p.startsWith('data/users/' + uid + '/');
const canRead = (uid, p) => own(uid, p) || p === 'lb' || /^lb\/[^/]+$/.test(p);
const canWrite = (uid, p) => (own(uid, p) && p.split('/').length >= 4) || p === 'lb/' + uid;

class HttpErr extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

function dbOp(user, body) {
  const op = body && body.op;
  const p = cleanPath(body && body.path);
  if (!p) throw new HttpErr('invalid_argument', 'bad path');
  if (op === 'get') {
    if (!canRead(user.id, p)) throw new HttpErr('permission_denied');
    const r = Q.docGet.get(p);
    return r ? { exists: true, data: JSON.parse(r.data), updated: r.updated } : { exists: false };
  }
  if (op === 'list') {
    if (!canRead(user.id, p)) throw new HttpErr('permission_denied');
    return { docs: Q.docList.all(p).map(r => ({ id: r.path.slice(p.length + 1), data: JSON.parse(r.data), updated: r.updated })) };
  }
  if (op === 'set' || op === 'delete') {
    if (!canWrite(user.id, p)) throw new HttpErr('permission_denied');
    if (op === 'delete') { Q.docDel.run(p); return { ok: true }; }
    const data = body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpErr('invalid_argument', 'data must be an object');
    const s = JSON.stringify(data);
    if (s.length > (p.startsWith('lb/') ? MAX_LB_DOC : MAX_DOC)) throw new HttpErr('resource_exhausted', 'document too large');
    const prev = Q.docOwner.get(p);
    if (Q.quota.get(user.id).n - (prev ? prev.n : 0) + s.length > USER_QUOTA) throw new HttpErr('resource_exhausted', 'storage quota full');
    Q.docSet.run(p, user.id, s, Date.now());
    return { ok: true };
  }
  throw new HttpErr('invalid_argument', 'bad op');
}

// ---------------------------------------------------------------- HTTP
const clientIp = req => String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '');
const bearer = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : null; };
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((res, rej) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { rej(new HttpErr('resource_exhausted', 'body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(n ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { rej(new HttpErr('invalid_argument', 'bad json')); } });
    req.on('error', rej);
  });
}
const STATUS = { invalid_argument: 400, unauthenticated: 401, permission_denied: 403, not_found: 404, already_exists: 409, resource_exhausted: 413, rate_limited: 429 };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = req.method + ' ' + url.pathname;
  try {
    if (route === 'GET /health') return send(res, 200, { ok: true, online: conns.size, registration: !!INVITE });

    if (route === 'POST /api/register' || route === 'POST /api/login') {
      const ip = clientIp(req);
      if (limited(ip)) throw new HttpErr('rate_limited', 'too many attempts, wait 10 minutes');
      const b = await readBody(req);
      const cs = normCs(b.callsign), pw = String(b.password || '');
      if (route === 'POST /api/register') {
        if (!INVITE) throw new HttpErr('permission_denied', 'registration is closed');
        if (!sameSecret(String(b.invite || '').trim(), INVITE)) { failed(ip); throw new HttpErr('permission_denied', 'wrong invite code'); }
        if (!CS_RE.test(cs)) throw new HttpErr('invalid_argument', 'callsign: 2-14 letters, numbers, space, - or _');
        if (pw.length < 6 || pw.length > 200) throw new HttpErr('invalid_argument', 'password must be at least 6 characters');
        if (Q.userByCs.get(cs)) throw new HttpErr('already_exists', 'that callsign is taken');
        const id = 'u' + crypto.randomBytes(9).toString('hex');
        const now = Date.now();
        const disp = normDisp(b.display) || cs;
        Q.userIns.run(id, cs, await hashPw(pw), now, now, disp);
        console.log('[mp] new pilot', cs);
        return send(res, 200, { token: newSession(id), id, callsign: cs, display: disp });
      }
      const u = Q.userByCs.get(cs);
      if (!u || !(await checkPw(pw, u.pw))) { failed(ip); throw new HttpErr('unauthenticated', 'wrong callsign or password'); }
      Q.userSeen.run(Date.now(), u.id);
      return send(res, 200, { token: newSession(u.id), id: u.id, callsign: u.callsign, display: u.display || u.callsign });
    }

    const user = sessionUser(bearer(req));
    if (!user) throw new HttpErr('unauthenticated', 'signed out');

    if (route === 'GET /api/me') return send(res, 200, { id: user.id, callsign: user.cs, display: user.disp });
    if (route === 'POST /api/profile') {
      const d = normDisp((await readBody(req)).display);
      if (!d) throw new HttpErr('invalid_argument', 'display callsign cannot be empty');
      Q.userDisp.run(d, user.id);
      for (const c of conns) if (c.user.id === user.id) c.user.disp = d;
      return send(res, 200, { ok: true, display: d });
    }
    if (route === 'POST /api/logout') {
      Q.sesDel.run(user.th);
      for (const c of conns) if (c.th === user.th) c.ws.close(4001, 'signed out');
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/password') {
      const ip = clientIp(req);
      if (limited(ip)) throw new HttpErr('rate_limited', 'too many attempts, wait 10 minutes');
      const b = await readBody(req);
      const u = Q.userByCs.get(user.cs);
      if (!u || !(await checkPw(String(b.old || ''), u.pw))) { failed(ip); throw new HttpErr('unauthenticated', 'current password is wrong'); }
      const pw = String(b.password || '');
      if (pw.length < 6 || pw.length > 200) throw new HttpErr('invalid_argument', 'password must be at least 6 characters');
      Q.userPw.run(await hashPw(pw), user.id);
      Q.sesDelUser.run(user.id, user.th);   // sign out every other device
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/db') return send(res, 200, dbOp(user, await readBody(req)));

    // ---- friends (one-way list, like a contact list; "addedMe" lets people add each other back)
    if (route === 'GET /api/friends') {
      const on = new Set([...conns].map(c => c.user.id));
      const row = r => ({ id: r.id, callsign: r.callsign, display: r.display, last: r.last, online: on.has(r.id) });
      return send(res, 200, { friends: Q.frList.all(user.id).map(row), addedMe: Q.frAddedMe.all(user.id).map(row) });
    }
    if (route === 'POST /api/friends/add') {
      const b = await readBody(req);
      let target = null;
      if (b.id) target = Q.userById.get(String(b.id));
      else if (b.callsign) {
        const want = String(b.callsign).trim();
        target = Q.userByCs.get(normCs(want));                  // login callsign first
        if (!target) {                                           // then a unique display callsign
          const m = Q.userByDisp.all(want.replace(/\s+/g, ' '));
          if (m.length > 1) throw new HttpErr('invalid_argument', 'more than one pilot uses that name; use their login callsign');
          target = m[0] || null;
        }
      }
      if (!target) throw new HttpErr('not_found', 'no pilot with that callsign');
      if (target.id === user.id) throw new HttpErr('invalid_argument', "that's you");
      if (Q.frCount.get(user.id).n >= 300) throw new HttpErr('resource_exhausted', 'friends list is full');
      Q.frAdd.run(user.id, target.id, Date.now());
      return send(res, 200, { ok: true, id: target.id });
    }
    if (route === 'POST /api/friends/remove') {
      Q.frDel.run(user.id, String((await readBody(req)).id || ''));
      return send(res, 200, { ok: true });
    }

    throw new HttpErr('not_found');
  } catch (e) {
    const code = e instanceof HttpErr ? e.code : 'internal';
    if (!(e instanceof HttpErr)) console.error('[mp]', route, e);
    send(res, STATUS[code] || 500, { error: code, message: e instanceof HttpErr ? e.message : 'server error' });
  }
});

// ---------------------------------------------------------------- presence rooms (WebSocket)
// Protocol (JSON):
//  C->S {t:'auth', token}            S->C {t:'hello', peer, id, callsign} | close 4001
//  C->S {t:'join', room}             S->C {t:'peers', room, peers:[{peer, presence}]}  others get {t:'pj', room, peer}
//  C->S {t:'pres', room, p}          others get {t:'pp', room, peer, p}
//  C->S {t:'leave', room}            others get {t:'pl', room, peer}
const ROOM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const rooms = new Map();   // name -> Map(peer -> conn)
const conns = new Set();
let peerSeq = 0;

function bcast(room, msg, except) {
  const m = rooms.get(room); if (!m) return;
  const s = JSON.stringify(msg);
  for (const c of m.values()) if (c !== except && c.ws.readyState === 1) {
    if (c.ws.bufferedAmount > 4 << 20) continue;   // slow client: skip rather than pile up memory
    c.ws.send(s);
  }
}
function leaveRoom(c, room) {
  const m = rooms.get(room);
  if (!m || !m.has(c.peer)) return;
  m.delete(c.peer); c.rooms.delete(room);
  if (!m.size) rooms.delete(room); else bcast(room, { t: 'pl', room, peer: c.peer });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MSG, perMessageDeflate: { threshold: 2048 } });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return sock.destroy();
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  const c = { ws, peer: null, user: null, th: null, rooms: new Map(), tok: 120, tokT: Date.now(), alive: true };
  const authTimer = setTimeout(() => { if (!c.user) ws.close(4001, 'auth timeout'); }, 10e3);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf, isBin) => {
    if (isBin) return;
    let m; try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!c.user) {
      if (m.t !== 'auth') return;
      const u = sessionUser(m.token);
      if (!u) return ws.close(4001, 'signed out');
      clearTimeout(authTimer);
      c.user = u; c.th = u.th; c.peer = 'p' + (++peerSeq).toString(36) + crypto.randomBytes(3).toString('hex');
      conns.add(c);
      return ws.send(JSON.stringify({ t: 'hello', peer: c.peer, id: u.id, callsign: u.cs, display: u.disp }));
    }
    // token bucket: 40 msg/s sustained, 120 burst (game sends ~10-20/s)
    const now = Date.now();
    c.tok = Math.min(120, c.tok + (now - c.tokT) * 0.04); c.tokT = now;
    if (c.tok < 1) return; c.tok--;
    const room = m.room;
    if (typeof room !== 'string' || !ROOM_RE.test(room)) return;
    if (m.t === 'join') {
      let r = rooms.get(room);
      if (!c.rooms.has(room)) {
        if (c.rooms.size >= MAX_ROOMS_PER_CONN) return ws.send(JSON.stringify({ t: 'err', room, error: 'too many rooms' }));
        if (r && r.size >= MAX_PEERS_PER_ROOM) return ws.send(JSON.stringify({ t: 'err', room, error: 'room full' }));
        if (!r) rooms.set(room, r = new Map());
        r.set(c.peer, c); c.rooms.set(room, null);
        bcast(room, { t: 'pj', room, peer: c.peer, uid: c.user.id, d: c.user.disp }, c);
      }
      const peers = [];
      for (const o of r.values()) peers.push({ peer: o.peer, uid: o.user.id, d: o.user.disp, presence: o.rooms.get(room) });
      return ws.send(JSON.stringify({ t: 'peers', room, peers }));
    }
    if (!c.rooms.has(room)) return;
    if (m.t === 'pres') {
      const p = (m.p && typeof m.p === 'object' && !Array.isArray(m.p)) ? m.p : null;
      c.rooms.set(room, p);
      return bcast(room, { t: 'pp', room, peer: c.peer, p }, c);
    }
    if (m.t === 'leave') return leaveRoom(c, room);
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    for (const room of [...c.rooms.keys()]) leaveRoom(c, room);
    conns.delete(c);
  });
  ws.on('error', () => {});
});

// heartbeat: drop dead sockets so ghosts leave the lobby within ~30 s
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 15e3).unref();

server.listen(PORT, () => console.log(`[mp] ASKIIES multiplayer server on :${PORT} (db ${DB_PATH}, registration ${INVITE ? 'open with invite code' : 'CLOSED'})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { db.close(); } catch (e) {} process.exit(0); });

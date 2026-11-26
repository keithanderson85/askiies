'use strict';
// ASKIIES multiplayer + cloud-save server.
// Emulates the three claude.ai artifact services the game already uses
// (window.claude.use('room' | 'db' | 'user')) so the game's own online code runs unchanged.
//
//   HTTP  /api/register  /api/login  /api/logout  /api/me  /api/password  /api/db  /health
//   WS    /ws            (presence rooms: lobby, battles, co-op workshop)
//   ADMIN /admin         (server page, password = ADMIN_PASSWORD) + /admin/api/*
//
// Runs behind the askiies nginx container at /mp/ (nginx strips the prefix).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const VERSION = '1.5.0';
const STARTED = Date.now();
const PORT = +process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || '/data/askiies.db';
const ADMIN_PW = String(process.env.ADMIN_PASSWORD || '').trim();
const SIGNUPS_PER_NET_DAY = 5;    // registration is open to anyone; this stops one network making piles of accounts
const SESSION_DAYS = 180;
const MAX_DOC = 1 << 20;          // 1 MB per document (game saves are chunked at 180 KB)
const MAX_LB_DOC = 64 << 10;      // leaderboard rows are small
const USER_QUOTA = 32 << 20;      // 32 MB of documents per account
const MAX_BODY = 2 << 20;
const MAX_WS_MSG = 512 << 10;     // co-op workshop presence carries a whole jet design
const MAX_ROOMS_PER_CONN = 8;
const MAX_PEERS_PER_ROOM = 64;

if (ADMIN_PW && ADMIN_PW.length < 10) console.warn('[mp] ADMIN_PASSWORD is shorter than 10 characters: use a long one.');
if (!ADMIN_PW) console.warn('[mp] ADMIN_PASSWORD is not set: the admin page is OFF.');

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
  -- v1.2: activity for the admin page (sign-ups, sign-ins, password changes, admin actions)
  CREATE TABLE IF NOT EXISTS events (
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    uid TEXT,
    info TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  -- v1.3: bug reports from players (status: open, progress, fixed, wontfix, notbug)
  CREATE TABLE IF NOT EXISTS bugs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    uid TEXT,
    who TEXT,
    net TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    ver TEXT,
    ctx TEXT,
    shot TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    rel TEXT,
    links TEXT,
    note TEXT,
    updated INTEGER NOT NULL,
    closed INTEGER
  );
  CREATE INDEX IF NOT EXISTS bugs_status ON bugs(status, ts);
  -- v1.5: earlier copies of each pilot's cloud save (bug #24), restorable by the pilot or the admin
  CREATE TABLE IF NOT EXISTS save_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    taken INTEGER NOT NULL,
    ts INTEGER,
    len INTEGER,
    ver TEXT,
    why TEXT,
    meta TEXT NOT NULL,
    parts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS save_history_uid ON save_history(uid, taken);
  -- v1.2: players online, sampled once a minute
  CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER PRIMARY KEY,
    users INTEGER NOT NULL,
    conns INTEGER NOT NULL
  );
`);
// v1.1: display callsign (shown in game) separate from the login callsign
// v1.2: total time online (ms) and sign-in count
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('display')) db.exec('ALTER TABLE users ADD COLUMN display TEXT');
  if (!cols.includes('play')) db.exec('ALTER TABLE users ADD COLUMN play INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('logins')) db.exec('ALTER TABLE users ADD COLUMN logins INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('visits')) db.exec('ALTER TABLE users ADD COLUMN visits INTEGER NOT NULL DEFAULT 0');
  // v1.4: F8 snapshots are saved at once (draft = 1) and the player adds the details later with the edit key
  const bc = db.prepare('PRAGMA table_info(bugs)').all().map(c => c.name);
  if (!bc.includes('draft')) db.exec('ALTER TABLE bugs ADD COLUMN draft INTEGER NOT NULL DEFAULT 0');
  if (!bc.includes('ekey')) db.exec('ALTER TABLE bugs ADD COLUMN ekey TEXT');
}
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
  evIns: db.prepare('INSERT INTO events (ts, kind, uid, info) VALUES (?, ?, ?, ?)'),
  evPrune: db.prepare('DELETE FROM events WHERE ts < ?'),
  smpIns: db.prepare('INSERT OR REPLACE INTO samples (ts, users, conns) VALUES (?, ?, ?)'),
  smpPrune: db.prepare('DELETE FROM samples WHERE ts < ?'),
  userLogin: db.prepare('UPDATE users SET last = ?, logins = logins + 1 WHERE id = ?'),
  userPlay: db.prepare('UPDATE users SET play = play + ?, last = ? WHERE id = ?'),
  userVisit: db.prepare('UPDATE users SET last = ?, visits = visits + 1 WHERE id = ?'),
};
setInterval(() => {
  try {
    const now = Date.now();
    Q.sesExpire.run(now - SESSION_DAYS * 864e5);
    Q.evPrune.run(now - 180 * 864e5);
    Q.smpPrune.run(now - 60 * 864e5);
  } catch (e) {}
}, 3600e3).unref();

// a short tag per network (salted hash of the IP, never the IP itself), so the admin page can
// spot several accounts made from one place without storing anyone's address
const NET_SALT = (() => {
  const f = path.join(path.dirname(DB_PATH), 'net-salt');   // kept next to the database so tags stay the same after restarts
  try { const s = fs.readFileSync(f); if (s.length >= 16) return s; } catch (e) {}
  const s = crypto.randomBytes(32);
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch (e) {}
  return s;
})();
const netTag = ip => crypto.createHmac('sha256', NET_SALT).update(String(ip)).digest('hex').slice(0, 6);
function logEv(kind, uid, info) { try { Q.evIns.run(Date.now(), kind, uid || null, info == null ? null : String(info).slice(0, 200)); } catch (e) {} }

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

// ---------------------------------------------------------------- bug reports
// Players send them from the game (signed in or not); the admin page and `bugs` (bugs.js, for
// working through them from a terminal / an AI assistant) read and close them.
const BUG_KINDS = ['crash', 'controls', 'graphics', 'online', 'sound', 'gameplay', 'menus', 'other'];
const BUG_STATUS = ['open', 'progress', 'fixed', 'wontfix', 'notbug'];
const BUG_PRIO = ['low', 'normal', 'high', 'critical'];
const MAX_SHOT = 400 << 10;
const B = {
  ins: db.prepare('INSERT INTO bugs (ts, uid, who, net, kind, title, body, ver, ctx, shot, status, updated, draft, ekey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  byKey: db.prepare('SELECT id, uid, ekey, draft, ts FROM bugs WHERE id = ?'),
  fill: db.prepare('UPDATE bugs SET kind = ?, title = ?, body = ?, who = coalesce(?, who), draft = 0, updated = ? WHERE id = ?'),
  mine: db.prepare("SELECT id, ts, title, status, rel, note, updated, draft FROM bugs WHERE uid = ? ORDER BY id DESC LIMIT 10"),
  list: db.prepare('SELECT id, ts, uid, who, net, kind, title, body, ver, ctx, status, priority, rel, links, note, updated, closed, draft, shot IS NOT NULL AS hasShot FROM bugs ORDER BY id DESC LIMIT 1000'),
  shot: db.prepare('SELECT shot FROM bugs WHERE id = ?'),
  get: db.prepare('SELECT id, status, note, priority, rel, links, kind, closed FROM bugs WHERE id = ?'),
  set: db.prepare('UPDATE bugs SET status = ?, note = ?, priority = ?, rel = ?, links = ?, kind = ?, updated = ?, closed = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM bugs WHERE id = ?'),
  counts: db.prepare('SELECT status, count(*) AS n FROM bugs GROUP BY status'),
};
const bugReports = new Map();   // net -> [timestamps]
function bugBlocked(ip) {
  const now = Date.now(), a = (bugReports.get(ip) || []).filter(t => t > now - 864e5);
  bugReports.set(ip, a);
  return a.filter(t => t > now - 3600e3).length >= 10 || a.length >= 40;
}
setInterval(() => { const cut = Date.now() - 864e5; for (const [k, a] of bugReports) if (!a.some(t => t > cut)) bugReports.delete(k); }, 3600e3).unref();
const clip = (s, n) => String(s == null ? '' : s).replace(/\u0000/g, '').slice(0, n);
function bugSubmit(ip, user, b) {
  if (bugBlocked(ip)) throw new HttpErr('rate_limited', 'too many reports from this network, try again later');
  const draft = !!b.draft;
  let title = clip(b.title, 120).trim(), body = clip(b.body, 4000).trim();
  if (draft && !title) title = 'F8 snapshot (no details yet)';
  if (title.length < 3) throw new HttpErr('invalid_argument', 'give the bug a short title');
  const kind = BUG_KINDS.includes(b.kind) ? b.kind : 'other';
  let ctx = null;
  if (b.ctx && typeof b.ctx === 'object') { ctx = JSON.stringify(b.ctx); if (ctx.length > 48 << 10) ctx = JSON.stringify({ truncated: true, head: ctx.slice(0, 40 << 10) }); }
  let shot = null;
  if (typeof b.shot === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.shot) && b.shot.length <= MAX_SHOT) shot = b.shot;
  const now = Date.now();
  const key = crypto.randomBytes(18).toString('base64url');   // lets this browser add the details later
  const r = B.ins.run(now, user ? user.id : null, user ? user.disp : clip(b.who, 14).trim() || null, netTag(ip), kind, title, body, clip(b.ver, 20), ctx, shot, 'open', now, draft ? 1 : 0, sha(key));
  bugReports.get(ip).push(now);
  logEv('bug', user ? user.id : null, '#' + r.lastInsertRowid + ' ' + (draft ? '(F8 snapshot) ' : '') + title.slice(0, 80));
  console.log('[mp] bug #' + r.lastInsertRowid, draft ? 'snapshot' : kind, title.slice(0, 80));
  return { ok: true, id: Number(r.lastInsertRowid), key };
}
// the player adds the details to their F8 snapshot (or throws it away) with the key from bugSubmit
function bugOwn(b) {
  const cur = B.byKey.get(+b.id || 0);
  if (!cur || !cur.ekey || typeof b.key !== 'string' || b.key.length > 60 || !sameSecret(sha(b.key), cur.ekey)) throw new HttpErr('permission_denied', 'not your report');
  if (!cur.draft) throw new HttpErr('already_exists', 'details were already added');
  if (Date.now() - cur.ts > 14 * 864e5) throw new HttpErr('permission_denied', 'too old to change');
  return cur;
}
function bugFill(user, b) {
  const cur = bugOwn(b);
  const title = clip(b.title, 120).trim(), body = clip(b.body, 4000).trim();
  if (title.length < 3) throw new HttpErr('invalid_argument', 'give the bug a short title');
  const kind = BUG_KINDS.includes(b.kind) ? b.kind : 'other';
  B.fill.run(kind, title, body, user ? null : (clip(b.who, 14).trim() || null), Date.now(), cur.id);
  logEv('bug', user ? user.id : cur.uid, '#' + cur.id + ' details added: ' + title.slice(0, 80));
  return { ok: true, id: cur.id };
}
function bugDiscard(b) {
  const cur = bugOwn(b);
  B.del.run(cur.id);
  logEv('bug_delete', cur.uid, '#' + cur.id + ' snapshot discarded by the player');
  return { ok: true };
}

// Open registration: at most SIGNUPS_PER_NET_DAY new pilots per network per day
const signups = new Map();   // ip -> [timestamps]
function signupBlocked(ip) {
  const cut = Date.now() - 864e5;
  const a = (signups.get(ip) || []).filter(t => t > cut);
  signups.set(ip, a);
  return a.length >= SIGNUPS_PER_NET_DAY;
}
setInterval(() => { const cut = Date.now() - 864e5; for (const [k, a] of signups) if (!a.some(t => t > cut)) signups.delete(k); }, 3600e3).unref();

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

// ---------------------------------------------------------------- cloud save history (bug #24)
// The game uploads save0..saveN, then savemeta. Before the first part of an upload overwrites the
// current cloud save, that save is copied into save_history: at most one copy per 10 minutes, but
// always when the new save is much smaller than the old one (the "progress wiped" case). 30 kept.
const SH_KEEP = 30, SH_GAP = 10 * 60e3;
const H = {
  last: db.prepare('SELECT taken FROM save_history WHERE uid = ? ORDER BY taken DESC LIMIT 1'),
  ins: db.prepare('INSERT INTO save_history (uid, taken, ts, len, ver, why, meta, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  trim: db.prepare('DELETE FROM save_history WHERE uid = ?1 AND id NOT IN (SELECT id FROM save_history WHERE uid = ?1 ORDER BY taken DESC LIMIT ' + SH_KEEP + ')'),
  list: db.prepare('SELECT id, taken, ts, len, ver, why FROM save_history WHERE uid = ? ORDER BY taken DESC'),
  get: db.prepare('SELECT * FROM save_history WHERE id = ? AND uid = ?'),
  count: db.prepare('SELECT uid, count(*) AS n FROM save_history GROUP BY uid'),
};
const SAVE_RE = /^data\/users\/([^/]+)\/save(\d+|meta)$/;
const keepRate = new Map();   // uid -> recent /api/saves/keep times
function saveSnapshot(uid, why) {
  const base = 'data/users/' + uid + '/';
  const m = Q.docGet.get(base + 'savemeta');
  if (!m) return false;
  let meta; try { meta = JSON.parse(m.data); } catch (e) { return false; }
  const parts = [];
  for (let i = 0; i < (meta.n | 0); i++) { const d = Q.docGet.get(base + 'save' + i); if (!d) return false; parts.push(d.data); }
  H.ins.run(uid, Date.now(), meta.ts || null, meta.len || null, String(meta.v || ''), why, m.data, JSON.stringify(parts));
  H.trim.run(uid);
  return true;
}
function beforeSaveWrite(uid, p, s) {
  const k = SAVE_RE.exec(p);
  if (!k || k[1] !== uid || k[2] === 'meta') return;
  const old = Q.docGet.get(p);
  if (!old) return;
  if (old.data === s) return;
  const last = H.last.get(uid), shrink = s.length < old.data.length * 0.6 && old.data.length > 2000;
  if (k[2] === '0' && (!last || Date.now() - last.taken > SH_GAP)) saveSnapshot(uid, 'auto');
  else if (shrink) saveSnapshot(uid, 'shrink');   // much smaller than before: always keep the old one
}
function saveRestore(uid, hid, by) {
  const h = H.get.get(hid, uid);
  if (!h) throw new HttpErr('not_found', 'no such saved copy');
  saveSnapshot(uid, 'before restore');                                   // the current save stays restorable too
  const base = 'data/users/' + uid + '/', parts = JSON.parse(h.parts), meta = JSON.parse(h.meta), now = Date.now();
  db.exec('BEGIN');
  try {
    parts.forEach((d, i) => Q.docSet.run(base + 'save' + i, uid, d, now));
    for (let i = parts.length; i < parts.length + 20; i++) Q.docDel.run(base + 'save' + i);
    meta.ts = now; meta.n = parts.length; meta.restored = h.taken;           // newer than every device: they all load it
    Q.docSet.run(base + 'savemeta', uid, JSON.stringify(meta), now);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logEv('save_restore', uid, 'cloud save from ' + new Date(h.taken).toISOString().slice(0, 16).replace('T', ' ') + ' UTC restored by ' + by);
  return { ok: true, ts: now };
}

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
    try { beforeSaveWrite(user.id, p, s); } catch (e) { console.error('[mp] save history', e); }
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
    if (route === 'GET /health') return send(res, 200, { ok: true, online: conns.size, registration: true });

    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/api/')) return await adminRoute(req, res, url, route);

    if (route === 'POST /api/register' || route === 'POST /api/login') {
      const ip = clientIp(req);
      if (limited(ip)) throw new HttpErr('rate_limited', 'too many attempts, wait 10 minutes');
      const b = await readBody(req);
      const cs = normCs(b.callsign), pw = String(b.password || '');
      if (route === 'POST /api/register') {
        if (!CS_RE.test(cs)) throw new HttpErr('invalid_argument', 'callsign: 2-14 letters, numbers, space, - or _');
        if (pw.length < 6 || pw.length > 200) throw new HttpErr('invalid_argument', 'password must be at least 6 characters');
        if (Q.userByCs.get(cs)) throw new HttpErr('already_exists', 'that callsign is taken');
        if (signupBlocked(ip)) throw new HttpErr('rate_limited', 'too many new pilots from this network today, try again tomorrow');
        const id = 'u' + crypto.randomBytes(9).toString('hex');
        const now = Date.now();
        const disp = normDisp(b.display) || cs;
        Q.userIns.run(id, cs, await hashPw(pw), now, now, disp);
        signups.get(ip).push(now);
        Q.userLogin.run(now, id);
        logEv('register', id, 'net ' + netTag(ip));
        console.log('[mp] new pilot', cs);
        return send(res, 200, { token: newSession(id), id, callsign: cs, display: disp });
      }
      const u = Q.userByCs.get(cs);
      if (!u || !(await checkPw(pw, u.pw))) { failed(ip); logEv('login_fail', u ? u.id : null, (u ? '' : 'unknown callsign ' + cs.slice(0, 14) + ' · ') + 'net ' + netTag(ip)); throw new HttpErr('unauthenticated', 'wrong callsign or password'); }
      Q.userLogin.run(Date.now(), u.id);
      logEv('login', u.id, 'net ' + netTag(ip));
      return send(res, 200, { token: newSession(u.id), id: u.id, callsign: u.callsign, display: u.display || u.callsign });
    }

    // bug reports work signed in or not (offline players find bugs too)
    if (route === 'POST /api/bug') return send(res, 200, bugSubmit(clientIp(req), sessionUser(bearer(req)), await readBody(req)));
    if (route === 'POST /api/bug/fill') return send(res, 200, bugFill(sessionUser(bearer(req)), await readBody(req)));
    if (route === 'POST /api/bug/discard') return send(res, 200, bugDiscard(await readBody(req)));

    const user = sessionUser(bearer(req));
    if (!user) throw new HttpErr('unauthenticated', 'signed out');

    if (route === 'GET /api/bugs/mine') return send(res, 200, { bugs: B.mine.all(user.id) });
    if (route === 'GET /api/saves') return send(res, 200, { saves: H.list.all(user.id) });
    if (route === 'POST /api/saves/restore') return send(res, 200, saveRestore(user.id, +(await readBody(req)).id || 0, 'the pilot'));
    // keep a copy before the game replaces one save with the other (the "which save?" choice)
    if (route === 'POST /api/saves/keep') {
      const b = await readBody(req), now = Date.now();
      const recent = (keepRate.get(user.id) || []).filter(t => t > now - 60e3);
      if (recent.length >= 6) throw new HttpErr('rate_limited', 'too many copies, wait a minute');
      recent.push(now); keepRate.set(user.id, recent);
      if (b.from === 'device') {                                                        // this device's save, sent by the game
        const parts = Array.isArray(b.parts) ? b.parts.filter(x => typeof x === 'string') : [];
        const meta = b.meta && typeof b.meta === 'object' ? b.meta : null;
        if (!parts.length || !meta || JSON.stringify(parts).length > MAX_DOC * 2) throw new HttpErr('invalid_argument', 'bad save');
        H.ins.run(user.id, now, +meta.ts || null, +meta.len || null, String(meta.v || ''), 'this device', JSON.stringify(meta), JSON.stringify(parts.map(d => JSON.stringify({ d }))));
        H.trim.run(user.id);
      } else saveSnapshot(user.id, 'before a choice');                                  // the account's save
      return send(res, 200, { ok: true });
    }

    if (route === 'GET /api/me') return send(res, 200, { id: user.id, callsign: user.cs, display: user.disp });
    if (route === 'POST /api/profile') {
      const d = normDisp((await readBody(req)).display);
      if (!d) throw new HttpErr('invalid_argument', 'display callsign cannot be empty');
      if (d !== user.disp) logEv('display', user.id, user.disp + ' → ' + d);
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
      logEv('password', user.id, 'changed by the player');
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
      c.since = Date.now();
      conns.add(c);
      cameOnline(u.id);
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
    if (conns.delete(c)) wentOffline(c.user.id);
  });
  ws.on('error', () => {});
});

// time online per player: counted from their first open tab to their last closed one
// A "visit" is a pilot coming online; a reload or a short drop (under 10 minutes) is the same visit.
const onlineSince = new Map();   // uid -> { n: open connections, since }
const offAt = new Map();         // uid -> when they last went offline
function cameOnline(uid) {
  const o = onlineSince.get(uid);
  if (o) { o.n++; return; }
  const now = Date.now();
  onlineSince.set(uid, { n: 1, since: now });
  if (now - (offAt.get(uid) || 0) > 10 * 60e3) { try { Q.userVisit.run(now, uid); } catch (e) {} logEv('visit', uid, null); }
  offAt.delete(uid);
}
function wentOffline(uid) {
  const o = onlineSince.get(uid); if (!o) return;
  if (--o.n > 0) return;
  onlineSince.delete(uid);
  const now = Date.now();
  offAt.set(uid, now);
  try { Q.userPlay.run(now - o.since, now, uid); } catch (e) {}
}
setInterval(() => { const cut = Date.now() - 10 * 60e3; for (const [k, t] of offAt) if (t < cut) offAt.delete(k); }, 600e3).unref();
function flushPlay() {   // on shutdown: bank the time of everyone still online
  const now = Date.now();
  for (const [uid, o] of onlineSince) { try { Q.userPlay.run(now - o.since, now, uid); } catch (e) {} o.since = now; }
}

// players online, once a minute (for the admin page's chart)
setInterval(() => {
  try { Q.smpIns.run(Math.floor(Date.now() / 60e3) * 60e3, onlineSince.size, conns.size); } catch (e) {}
}, 60e3).unref();

// ---------------------------------------------------------------- admin page + API
// The page is served by this server at /admin (players reach it as /mp/admin through nginx).
// One password (ADMIN_PASSWORD in .env) gives a 12-hour admin token kept only in memory.
const ADMIN_HTML = path.join(__dirname, 'admin.html');
const ADMIN_TTL = 12 * 3600e3;
const adminTokens = new Map();   // sha(token) -> expiry
setInterval(() => { const now = Date.now(); for (const [k, t] of adminTokens) if (t < now) adminTokens.delete(k); }, 600e3).unref();

const A = {
  users: db.prepare(`SELECT u.id, u.callsign, coalesce(u.display, u.callsign) AS display, u.created, u.last, u.play, u.logins, u.visits,
      (SELECT coalesce(sum(length(d.data)), 0) FROM docs d WHERE d.uid = u.id) AS bytes,
      (SELECT count(*) FROM friends f WHERE f.uid = u.id) AS friends,
      (SELECT count(*) FROM sessions s WHERE s.uid = u.id) AS sessions
    FROM users u ORDER BY u.last DESC`),
  lb: db.prepare("SELECT path, data FROM docs WHERE path LIKE 'lb/%'"),
  meta: db.prepare("SELECT uid, data FROM docs WHERE path LIKE 'data/users/%/savemeta'"),
  events: db.prepare(`SELECT e.ts, e.kind, e.uid, e.info, coalesce(u.display, u.callsign) AS who
    FROM events e LEFT JOIN users u ON u.id = e.uid ORDER BY e.ts DESC LIMIT 300`),
  visitTs: db.prepare("SELECT ts FROM events WHERE kind = 'visit' AND ts >= ? ORDER BY ts"),
  smp5: db.prepare('SELECT (ts / 300000) * 300000 AS t, max(users) AS u FROM samples WHERE ts >= ? GROUP BY ts / 300000 ORDER BY t'),
  smpHr: db.prepare('SELECT (ts / 3600000) * 3600000 AS t, max(users) AS u FROM samples WHERE ts >= ? GROUP BY ts / 3600000 ORDER BY t'),
  counts: db.prepare('SELECT (SELECT count(*) FROM docs) AS docs, (SELECT coalesce(sum(length(data)), 0) FROM docs) AS docBytes, (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM friends) AS friends'),
  delDocs: db.prepare("DELETE FROM docs WHERE uid = ?1 OR path = 'lb/' || ?1 OR substr(path, 1, length(?1) + 12) = 'data/users/' || ?1 || '/'"),
  delFriends: db.prepare('DELETE FROM friends WHERE uid = ?1 OR fid = ?1'),
  delSessions: db.prepare('DELETE FROM sessions WHERE uid = ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  full: db.prepare('SELECT id, callsign, coalesce(display, callsign) AS display FROM users WHERE id = ?'),
};
const fileSize = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
const kickUser = (uid, why) => { for (const c of [...conns]) if (c.user.id === uid) try { c.ws.close(4001, why); } catch (e) {} };
const tempPassword = () => { const w = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const b of crypto.randomBytes(10)) s += w[b % w.length]; return s.slice(0, 5) + '-' + s.slice(5); };

function adminOverview() {
  const now = Date.now();
  const lb = new Map(), meta = new Map(), saves = new Map(H.count.all().map(r => [r.uid, r.n]));
  for (const r of A.lb.all()) { try { lb.set(r.path.slice(3), JSON.parse(r.data)); } catch (e) {} }
  for (const r of A.meta.all()) { try { meta.set(r.uid, JSON.parse(r.data)); } catch (e) {} }
  const where = new Map();   // uid -> { rooms:Set, since }
  for (const c of conns) {
    const w = where.get(c.user.id) || { rooms: new Set(), since: c.since, tabs: 0 };
    for (const r of c.rooms.keys()) w.rooms.add(r);
    w.since = Math.min(w.since, c.since); w.tabs++;
    where.set(c.user.id, w);
  }
  const users = A.users.all().map(u => {
    const l = lb.get(u.id), m = meta.get(u.id), w = where.get(u.id), o = onlineSince.get(u.id);
    const rec = {};
    if (l && l.r && typeof l.r === 'object') for (const [k, v] of Object.entries(l.r)) if (v && typeof v === 'object' && typeof v.v === 'number') rec[k] = { v: v.v, ac: String(v.ac || '').slice(0, 24) };
    return {
      id: u.id, callsign: u.callsign, display: u.display, created: u.created,
      last: o ? now : u.last, play: u.play + (o ? now - o.since : 0), logins: u.logins, visits: u.visits,
      bytes: u.bytes, friends: u.friends, sessions: u.sessions,
      online: !!w, tabs: w ? w.tabs : 0, rooms: w ? [...w.rooms] : [], onlineSince: w ? w.since : null,
      save: m ? m.ts || null : null, saveCopies: saves.get(u.id) || 0, version: String((m && m.v) || (l && l.v) || ''), records: rec,
    };
  });
  const roomList = [...rooms_list()];
  const c = A.counts.get();
  const day = 864e5;
  return {
    now, server: {
      version: VERSION, started: STARTED, node: process.version, rss: process.memoryUsage().rss,
      dbBytes: fileSize(DB_PATH) + fileSize(DB_PATH + '-wal'), registration: 'open', signupsPerNetDay: SIGNUPS_PER_NET_DAY,
    },
    totals: {
      users: users.length, online: onlineSince.size, conns: conns.size, rooms: roomList.length,
      new1: users.filter(u => u.created > now - day).length, new7: users.filter(u => u.created > now - 7 * day).length,
      act1: users.filter(u => u.last > now - day).length, act7: users.filter(u => u.last > now - 7 * day).length,
      docs: c.docs, docBytes: c.docBytes, sessions: c.sessions, friends: c.friends,
      bugs: Object.fromEntries(B.counts.all().map(r => [r.status, r.n])),
    },
    users, rooms: roomList,
    events: A.events.all(),
    charts: {
      online24: A.smp5.all(now - day),
      online30: A.smpHr.all(now - 30 * day),
      signups: users.map(u => u.created).filter(t => t > now - 30 * day).sort((a, b) => a - b),
      visits: A.visitTs.all(now - 30 * day).map(r => r.ts),
    },
  };
}
function* rooms_list() {
  for (const [name, m] of rooms) yield { name, peers: [...m.values()].map(c => ({ id: c.user.id, display: c.user.disp })) };
}

async function adminRoute(req, res, url, route) {
  if (!ADMIN_PW) throw new HttpErr('not_found', 'the admin page is off (set ADMIN_PASSWORD)');
  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
    const html = fs.readFileSync(ADMIN_HTML);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': html.length,
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(html);
  }
  const ip = clientIp(req);
  if (route === 'POST /admin/api/login') {
    if (limited(ip)) throw new HttpErr('rate_limited', 'too many attempts, wait 10 minutes');
    const b = await readBody(req);
    if (!sameSecret(String(b.password || ''), ADMIN_PW)) { failed(ip); logEv('admin_fail', null, 'net ' + netTag(ip)); throw new HttpErr('unauthenticated', 'wrong admin password'); }
    const token = crypto.randomBytes(32).toString('base64url');
    adminTokens.set(sha(token), Date.now() + ADMIN_TTL);
    logEv('admin_login', null, 'net ' + netTag(ip));
    return send(res, 200, { token, ttl: ADMIN_TTL });
  }
  const t = bearer(req), exp = t && adminTokens.get(sha(t));
  if (!exp || exp < Date.now()) throw new HttpErr('unauthenticated', 'admin sign-in needed');
  if (route === 'GET /admin/api/overview') return send(res, 200, adminOverview());
  if (route === 'POST /admin/api/logout') { adminTokens.delete(sha(t)); return send(res, 200, { ok: true }); }
  if (route === 'GET /admin/api/bugs') {
    return send(res, 200, { bugs: B.list.all().map(b => { let ctx = null; try { ctx = b.ctx ? JSON.parse(b.ctx) : null; } catch (e) {} return Object.assign(b, { ctx, hasShot: !!b.hasShot, draft: !!b.draft }); }) });
  }
  if (route === 'GET /admin/api/bugshot') {
    const r = B.shot.get(+url.searchParams.get('id') || 0);
    if (!r || !r.shot) throw new HttpErr('not_found', 'no screenshot');
    return send(res, 200, { shot: r.shot });
  }
  if (route === 'POST /admin/api/bug') {
    const b = await readBody(req), cur = B.get.get(+b.id || 0);
    if (!cur) throw new HttpErr('not_found', 'no such bug');
    if (b.action === 'delete') { B.del.run(cur.id); logEv('bug_delete', null, '#' + cur.id); return send(res, 200, { ok: true }); }
    const status = b.status == null ? cur.status : String(b.status);
    if (!BUG_STATUS.includes(status)) throw new HttpErr('invalid_argument', 'bad status');
    const note = b.note == null ? cur.note : clip(b.note, 4000);
    const priority = b.priority == null ? cur.priority : String(b.priority);
    if (!BUG_PRIO.includes(priority)) throw new HttpErr('invalid_argument', 'bad priority');
    const kind = b.kind == null ? cur.kind : String(b.kind);
    if (!BUG_KINDS.includes(kind)) throw new HttpErr('invalid_argument', 'bad area');
    const rel = b.rel == null ? cur.rel : (clip(b.rel, 40).trim() || null);
    const links = b.links == null ? cur.links : (clip(b.links, 2000).split(/\s+/).filter(u => /^https?:\/\/\S+$/.test(u)).join('\n') || null);
    const now = Date.now();
    const isOpen = s => s === 'open' || s === 'progress';
    const closed = isOpen(status) ? null : (!isOpen(cur.status) && cur.closed ? cur.closed : now);   // keep the first close time
    B.set.run(status, note, priority, rel, links, kind, now, closed, cur.id);
    if (status !== cur.status) logEv('bug_status', null, '#' + cur.id + ' ' + cur.status + ' → ' + status + ' (admin page)');
    return send(res, 200, { ok: true });
  }
  if (route === 'GET /admin/api/saves') return send(res, 200, { saves: H.list.all(String(url.searchParams.get('uid') || '')) });
  if (route === 'POST /admin/api/saves/restore') { const b = await readBody(req); return send(res, 200, saveRestore(String(b.uid || ''), +b.id || 0, 'the admin')); }
  if (route === 'POST /admin/api/user') {
    const b = await readBody(req);
    const u = A.full.get(String(b.id || ''));
    if (!u) throw new HttpErr('not_found', 'no such pilot');
    if (b.action === 'signout') {
      A.delSessions.run(u.id); kickUser(u.id, 'signed out');
      logEv('admin_signout', u.id, 'signed out everywhere by admin');
      return send(res, 200, { ok: true });
    }
    if (b.action === 'resetpw') {
      const pw = tempPassword();
      Q.userPw.run(await hashPw(pw), u.id);
      A.delSessions.run(u.id); kickUser(u.id, 'signed out');
      logEv('admin_resetpw', u.id, 'password reset by admin');
      return send(res, 200, { ok: true, password: pw });
    }
    if (b.action === 'display') {
      const d = normDisp(b.display);
      if (!d) throw new HttpErr('invalid_argument', 'name cannot be empty');
      Q.userDisp.run(d, u.id);
      for (const c of conns) if (c.user.id === u.id) c.user.disp = d;
      logEv('admin_display', u.id, u.display + ' → ' + d);
      return send(res, 200, { ok: true, display: d });
    }
    if (b.action === 'delete') {
      if (normCs(b.confirm) !== u.callsign) throw new HttpErr('invalid_argument', 'type the login callsign to confirm');
      kickUser(u.id, 'account deleted');
      db.exec('BEGIN');
      try { A.delDocs.run(u.id); db.prepare('DELETE FROM save_history WHERE uid = ?').run(u.id); A.delFriends.run(u.id); A.delSessions.run(u.id); A.delUser.run(u.id); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      logEv('admin_delete', null, 'deleted ' + u.callsign + ' (' + u.display + ')');
      return send(res, 200, { ok: true });
    }
    throw new HttpErr('invalid_argument', 'bad action');
  }
  throw new HttpErr('not_found');
}

// heartbeat: drop dead sockets so ghosts leave the lobby within ~30 s
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 15e3).unref();

server.listen(PORT, () => console.log(`[mp] ASKIIES multiplayer server v${VERSION} on :${PORT} (db ${DB_PATH}, registration open, admin page ${ADMIN_PW ? 'on' : 'OFF'})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { flushPlay(); db.close(); } catch (e) {} process.exit(0); });

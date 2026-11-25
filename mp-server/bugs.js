'use strict';
// ASKIIES bug board from a terminal (made for working through bugs with an AI assistant).
// Installed in the askiies-mp container as the `bugs` command:
//
//   docker exec askiies-mp bugs                       open + in-progress bugs, highest priority first
//   docker exec askiies-mp bugs list [status|all]     status: open, progress, fixed, wontfix, notbug, closed
//   docker exec askiies-mp bugs show <id>             everything about one bug (description, game state, errors)
//   docker exec askiies-mp bugs md [status|all]       the list + details as Markdown
//   docker exec askiies-mp bugs set <id> [status] [--release v17.23] [--link https://github.com/...]
//                                  [--priority low|normal|high|critical] [--area graphics] [--note "text"]
//        e.g. bugs set 12 fixed --release mp-1.3.1 --link https://github.com/OWNER/REPO/commit/abc123 --note "radar fixed"
//   docker exec askiies-mp bugs note <id> "text"       replace the note (players see it on their own reports)
//   docker exec askiies-mp bugs release <name>         release notes (Markdown) for every bug fixed in that release
//   docker exec askiies-mp bugs shot <id>              the screenshot bytes on stdout:  bugs shot 12 > bug-12.jpg
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || '/data/askiies.db');
db.exec('PRAGMA busy_timeout = 5000');

const STATUS = { open: 'OPEN', progress: 'IN PROGRESS', fixed: 'FIXED', wontfix: "WON'T FIX", notbug: 'NOT A BUG' };
const PRIO = ['critical', 'high', 'normal', 'low'];
const KINDS = ['crash', 'controls', 'graphics', 'online', 'sound', 'gameplay', 'menus', 'other'];
const CLOSED = ['fixed', 'wontfix', 'notbug'];
const out = s => process.stdout.write(s + '\n');
const die = s => { process.stderr.write(s + '\n'); process.exit(1); };
const day = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '-';

// split "--flag value" options from positional arguments
const argv = process.argv.slice(2), pos = [], flag = {};
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { pos.push(argv[i]); continue; }
  flag[m[1]] = m[2] != null ? m[2] : argv[++i];
}
const [cmd = 'list', a1, ...rest] = pos;

function all() { return db.prepare('SELECT id, ts, who, kind, title, body, ver, status, priority, rel, links, note, updated, closed, shot IS NOT NULL AS hasShot, ctx FROM bugs ORDER BY id').all(); }
function rows(which) {
  const w = which || 'active';
  return all().filter(b => w === 'all' || (w === 'active' && !CLOSED.includes(b.status)) || (w === 'closed' && CLOSED.includes(b.status)) || b.status === w)
    .sort((a, b) => (PRIO.indexOf(a.priority) - PRIO.indexOf(b.priority)) || a.id - b.id);
}
function ctxText(c) {
  if (!c) return '(none)';
  let o; try { o = JSON.parse(c); } catch (e) { return c; }
  const errs = o.errors || []; delete o.errors;
  const L = ['```json', JSON.stringify(o, null, 2), '```'];
  L.push(errs.length ? 'Recent errors in the browser (newest last):' : 'No browser errors were recorded before the report.');
  for (const e of errs) L.push('- [' + (e.t != null ? e.t + ' s' : '?') + '] ' + e.m + (e.n > 1 ? ' (×' + e.n + ')' : '') + (e.at ? ' @ ' + e.at : '') + (e.stack ? '\n    ' + String(e.stack).split('\n').slice(0, 6).join('\n    ') : ''));
  return L.join('\n');
}
function detail(b) {
  return [
    `## #${b.id} · ${b.title}`,
    `- **Status:** ${STATUS[b.status] || b.status}${b.closed ? ' (closed ' + day(b.closed) + ')' : ''} · **Priority:** ${b.priority} · **Area:** ${b.kind}`,
    `- **Release:** ${b.rel || '-'} · **Game version when reported:** ${b.ver || '?'} · **From:** ${b.who || 'anonymous'} · **Reported:** ${day(b.ts)}`,
    b.links ? `- **Links:** ${b.links.split('\n').join(' · ')}` : null,
    `- **Screenshot:** ${b.hasShot ? 'yes (`docker exec askiies-mp bugs shot ' + b.id + ' > bug-' + b.id + '.jpg`)' : 'no'}`,
    b.note ? `- **Note:** ${b.note}` : null,
    '', '### What the player wrote', '', b.body || '(nothing)', '', '### Game state when reported', '', ctxText(b.ctx), '',
  ].filter(x => x != null).join('\n');
}
function line(b) {
  return `#${String(b.id).padEnd(4)} ${(STATUS[b.status] || b.status).padEnd(11)} ${b.priority.padEnd(8)} ${b.kind.padEnd(9)} ${day(b.ts).slice(0, 10)}  ${String(b.who || 'anon').padEnd(14)} ${b.title}${b.rel ? '  [' + b.rel + ']' : ''}${b.hasShot ? '  [shot]' : ''}`;
}
const STMAP = { open: 'open', reopen: 'open', todo: 'open', progress: 'progress', inprogress: 'progress', working: 'progress', doing: 'progress',
  fixed: 'fixed', done: 'fixed', wontfix: 'wontfix', notbug: 'notbug', notabug: 'notbug' };
function update(id, ch) {
  const cur = db.prepare('SELECT * FROM bugs WHERE id = ?').get(id) || die('no bug #' + id);
  const n = Object.assign({}, cur);
  if (ch.status) n.status = STMAP[String(ch.status).toLowerCase().replace(/[^a-z]/g, '')] || die('status must be one of: open, progress, fixed, wontfix, notbug');
  if (ch.priority) n.priority = PRIO.includes(ch.priority) ? ch.priority : die('priority must be one of: ' + PRIO.join(', '));
  if (ch.area) n.kind = KINDS.includes(ch.area) ? ch.area : die('area must be one of: ' + KINDS.join(', '));
  if (ch.release != null) n.rel = String(ch.release).trim().slice(0, 40) || null;
  if (ch.link) { const l = String(ch.link).trim(); if (!/^https?:\/\/\S+$/.test(l)) die('--link must be a full https:// URL'); const s = new Set((cur.links || '').split('\n').filter(Boolean)); s.add(l); n.links = [...s].join('\n'); }
  if (ch.note != null) n.note = String(ch.note).slice(0, 4000);
  const now = Date.now();
  const open = s => !CLOSED.includes(s);
  n.closed = open(n.status) ? null : (!open(cur.status) && cur.closed ? cur.closed : now);
  db.prepare('UPDATE bugs SET status = ?, priority = ?, kind = ?, rel = ?, links = ?, note = ?, closed = ?, updated = ? WHERE id = ?')
    .run(n.status, n.priority, n.kind, n.rel, n.links, n.note, n.closed, now, id);
  if (n.status !== cur.status) db.prepare('INSERT INTO events (ts, kind, uid, info) VALUES (?, ?, NULL, ?)').run(now, 'bug_status', '#' + id + ' ' + cur.status + ' → ' + n.status + ' (bugs command)');
  const ch2 = [];
  for (const [k, l] of [['status', 'status'], ['priority', 'priority'], ['kind', 'area'], ['rel', 'release'], ['links', 'links'], ['note', 'note']])
    if (n[k] !== cur[k]) ch2.push(l + ': ' + (k === 'status' ? STATUS[cur[k]] + ' → ' + STATUS[n[k]] : k === 'note' || k === 'links' ? 'updated' : (cur[k] || '-') + ' → ' + (n[k] || '-')));
  out(`#${id} ${cur.title}\n  ` + (ch2.join('\n  ') || 'no changes'));
}

if (cmd === 'list' || cmd === 'ls') {
  const r = rows(a1);
  out(r.length ? r.map(line).join('\n') : 'No bugs (' + (a1 || 'open or in progress') + ').');
  const c = db.prepare('SELECT status, count(*) n FROM bugs GROUP BY status').all().map(x => (STATUS[x.status] || x.status).toLowerCase() + ' ' + x.n).join(' · ');
  out('\n' + (c || 'no bugs at all'));
} else if (cmd === 'show') {
  const id = +a1 || die('usage: bugs show <id>');
  out(detail(all().find(x => x.id === id) || die('no bug #' + id)));
} else if (cmd === 'md') {
  const r = rows(a1);
  out(`# ASKIIES bugs (${a1 || 'open + in progress'}) · ${day(Date.now())}\n`);
  out(r.map(b => `- [${CLOSED.includes(b.status) ? 'x' : ' '}] #${b.id} ${b.title} (${b.priority}, ${b.kind}, ${STATUS[b.status]})`).join('\n') + '\n');
  out(r.map(detail).join('\n'));
} else if (cmd === 'set') {
  const id = +a1 || die('usage: bugs set <id> [status] [--release x] [--link url] [--priority p] [--area a] [--note "text"]');
  const ch = { release: flag.release, link: flag.link, priority: flag.priority, area: flag.area, note: flag.note };
  if (rest[0]) ch.status = rest[0];
  if (ch.note == null && rest.length > 1) ch.note = rest.slice(1).join(' ');   // old form: bugs set 12 fixed "note"
  update(id, ch);
} else if (cmd === 'note') {
  const id = +a1 || die('usage: bugs note <id> "text"');
  update(id, { note: rest.join(' ') });
} else if (cmd === 'release' || cmd === 'notes') {
  const name = a1 || die('usage: bugs release <name>');
  const r = all().filter(b => b.rel === name);
  if (!r.length) die('no bugs are marked with release ' + name);
  const fixed = r.filter(b => b.status === 'fixed'), other = r.filter(b => b.status !== 'fixed');
  out(`## ${name}\n`);
  if (fixed.length) out('### Fixed\n\n' + fixed.map(b => `- ${b.title} (bug #${b.id}${b.who ? ', reported by ' + b.who : ''})${b.note ? ': ' + b.note : ''}`).join('\n') + '\n');
  if (other.length) out('### Also planned for this release\n\n' + other.map(b => `- ${b.title} (bug #${b.id}, ${STATUS[b.status].toLowerCase()})`).join('\n') + '\n');
} else if (cmd === 'shot') {
  const id = +a1 || die('usage: bugs shot <id> > file.jpg');
  const r = db.prepare('SELECT shot FROM bugs WHERE id = ?').get(id);
  if (!r || !r.shot) die('bug #' + id + ' has no screenshot');
  process.stdout.write(Buffer.from(r.shot.slice(r.shot.indexOf(',') + 1), 'base64'));
} else {
  die('commands: list [status|all] · show <id> · md [status|all] · set <id> [status] [--release x] [--link url] [--priority p] [--area a] [--note "t"] · note <id> "text" · release <name> · shot <id>');
}

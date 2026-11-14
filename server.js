'use strict';
/**
 * Gatekeeper – multi-unit gate entry / exit system
 * Guards raise IN requests (person / material) -> admin approves (green) or rejects (red)
 * -> guard is notified -> guard marks OUT later -> time inside is recorded.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const webpush = require('web-push');
const { DatabaseSync } = require('node:sqlite');
const createFcm = require('./fcm');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'gatekeeper.db'));

// ---------------------------------------------------------------- schema
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','guard')),
  unit_id INTEGER REFERENCES units(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('PERSON','MATERIAL')),
  visitor_name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  purpose TEXT,
  whom_to_meet TEXT,
  vehicle_no TEXT,
  id_proof TEXT,
  persons_count INTEGER DEFAULT 1,
  material_desc TEXT,
  material_qty TEXT,
  challan_no TEXT,
  photo TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXITED')),
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  admin_remark TEXT,
  in_time TEXT,
  out_time TEXT,
  out_by INTEGER REFERENCES users(id),
  out_remark TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_unit_status ON entries(unit_id, status);
CREATE INDEX IF NOT EXISTS idx_entries_requested ON entries(requested_at);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fcm_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
// upgrades for databases created by older versions
for (const [col, def] of [['reminder_count', 'INTEGER NOT NULL DEFAULT 0'], ['last_reminded_at', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(entries)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE entries ADD COLUMN ${col} ${def}`);
}

// ---------------------------------------------------------------- helpers
const now = () => new Date().toISOString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

// ---------------------------------------------------------------- first-run seed
if (!db.prepare('SELECT COUNT(*) AS c FROM users').get().c) {
  const unit = db.prepare('INSERT INTO units(name, code) VALUES (?, ?)').run('Unit 1', 'U1');
  db.prepare('INSERT INTO users(username,name,password_hash,role,unit_id) VALUES (?,?,?,?,?)')
    .run('admin', 'Main Admin', hashPassword('admin123'), 'admin', null);
  db.prepare('INSERT INTO users(username,name,password_hash,role,unit_id) VALUES (?,?,?,?,?)')
    .run('guard1', 'Unit 1 Guard', hashPassword('guard123'), 'guard', unit.lastInsertRowid);
  console.log('First run: created admin/admin123 and guard1/guard123 (Unit 1). Change these passwords!');
}

// ---------------------------------------------------------------- web push (VAPID)
let vapid = getSetting('vapid');
if (!vapid) {
  vapid = JSON.stringify(webpush.generateVAPIDKeys());
  setSetting('vapid', vapid);
}
vapid = JSON.parse(vapid);
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

// Send a push to every phone/browser of these users. Temporary failures are retried;
// dead subscriptions (phone uninstalled app / blocked notifications) are removed.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function sendPush(sub, payload, attempt = 1) {
  const { entry: _omit, ...small } = payload; // web push has a ~4KB limit – details are fetched by the app
  return webpush.sendNotification(JSON.parse(sub.data), JSON.stringify(small), { TTL: 6 * 3600, urgency: 'high' })
    .then(() => true)
    .catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
        return false;
      }
      if (attempt < 3) return wait(attempt * 5000).then(() => sendPush(sub, payload, attempt + 1));
      console.error('push failed', err.statusCode || '', err.body || err.message);
      return false;
    });
}
// ---- Android app alerts (Firebase Cloud Messaging)
const fcm = createFcm({ dataDir: DATA_DIR, androidPackage: process.env.ANDROID_PACKAGE || 'com.wellworth.gatekeeper' });
console.log(`Android app alerts (Firebase): ${fcm.enabled ? 'ON' : 'not set up yet'}${fcm.clientConfig ? '' : ' – google-services.json missing'}`);
function sendFcm(token, data, attempt = 1) {
  if (!fcm.enabled) return Promise.resolve(false);
  return fcm.send(token, data)
    .then((r) => {
      if (r === 'invalid') { db.prepare('DELETE FROM fcm_tokens WHERE token = ?').run(token); return false; }
      return true;
    })
    .catch((err) => {
      const retry = !err.status || err.status >= 500 || err.status === 429 || err.status === 401;
      if (retry && attempt < 3) return wait(attempt * 5000).then(() => sendFcm(token, data, attempt + 1));
      console.error('android push failed', err.message);
      return false;
    });
}

// Notify users on all their devices: browsers/PWA (web push) and the Android app (FCM).
function pushToUsers(userIds, payload, { web = true } = {}) {
  if (!userIds.length) return Promise.resolve([]);
  const ph = userIds.map(() => '?').join(',');
  const jobs = [];
  if (web) {
    for (const s of db.prepare(`SELECT endpoint, data FROM push_subs WHERE user_id IN (${ph})`).all(...userIds)) jobs.push(sendPush(s, payload));
  }
  const data = Object.fromEntries(Object.entries(payload).filter(([, v]) => v != null)
    .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  for (const t of db.prepare(`SELECT token FROM fcm_tokens WHERE user_id IN (${ph})`).all(...userIds)) jobs.push(sendFcm(t.token, data));
  return Promise.all(jobs);
}
// admins who can see a unit: global admins + admins of that unit
const adminIdsForUnit = (unitId) =>
  db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND (unit_id IS NULL OR unit_id = ?)")
    .all(unitId).map((r) => r.id);
const guardIdsForUnit = (unitId) =>
  db.prepare("SELECT id FROM users WHERE role='guard' AND active=1 AND unit_id = ?").all(unitId).map((r) => r.id);

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const publicUser = (u) => u && ({
  id: u.id, username: u.username, name: u.name, phone: u.phone, role: u.role,
  unit_id: u.unit_id, unit_name: u.unit_name ?? null, active: !!u.active,
});
const USER_SELECT = `SELECT users.*, units.name AS unit_name FROM users LEFT JOIN units ON units.id = users.unit_id`;

function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`${USER_SELECT} JOIN sessions s ON s.user_id = users.id WHERE s.token = ? AND users.active = 1`).get(token);
  return row || null;
}
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  // <img> tags cannot send headers, so photo URLs carry the token as ?t=
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.method === 'GET' && req.query.t ? String(req.query.t) : null);
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  req.token = token;
  next();
}
const requireRole = (role) => (req, res, next) =>
  req.user.role === role ? next() : res.status(403).json({ error: 'Not allowed' });
const requireSuperAdmin = (req, res, next) =>
  req.user.role === 'admin' && req.user.unit_id == null ? next() : res.status(403).json({ error: 'Only the main admin can do this' });

// unit scope: null = all units
const scopeUnit = (user) => (user.role === 'admin' && user.unit_id == null ? null : user.unit_id);
function canAccessUnit(user, unitId) {
  const s = scopeUnit(user);
  return s == null || Number(s) === Number(unitId);
}
const clean = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);

// ---- auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare(`${USER_SELECT} WHERE users.username = ?`).get(String(username || '').trim());
  if (!user || !user.active || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: publicUser(user), vapidPublicKey: vapid.publicKey });
});
app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), vapidPublicKey: vapid.publicKey }));
app.post('/api/me/password', auth, (req, res) => {
  const { current, next: newPw } = req.body || {};
  if (!verifyPassword(current || '', req.user.password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!newPw || String(newPw).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPw), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
  res.json({ ok: true });
});

// ---- push subscriptions
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Bad subscription' });
  db.prepare(`INSERT INTO push_subs(endpoint,user_id,data) VALUES (?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, data=excluded.data`)
    .run(sub.endpoint, req.user.id, JSON.stringify(sub));
  res.json({ ok: true });
});
// called by the service worker when the browser renews a subscription (no login token there)
app.post('/api/push/resubscribe', (req, res) => {
  const { oldEndpoint, subscription } = req.body || {};
  const old = oldEndpoint && db.prepare('SELECT user_id FROM push_subs WHERE endpoint = ?').get(oldEndpoint);
  if (!old || !subscription?.endpoint) return res.status(404).json({ error: 'Unknown subscription' });
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(oldEndpoint);
  db.prepare(`INSERT INTO push_subs(endpoint,user_id,data) VALUES (?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, data=excluded.data`)
    .run(subscription.endpoint, old.user_id, JSON.stringify(subscription));
  res.json({ ok: true });
});
app.get('/api/push/key', (req, res) => res.type('text').send(vapid.publicKey));
app.get('/api/push/status', auth, (req, res) => {
  const web = db.prepare('SELECT COUNT(*) c FROM push_subs WHERE user_id = ?').get(req.user.id).c;
  const android = db.prepare('SELECT COUNT(*) c FROM fcm_tokens WHERE user_id = ?').get(req.user.id).c;
  res.json({ devices: web + android, web, android, androidEnabled: fcm.enabled });
});
// Android app: register / remove this phone for alerts
app.post('/api/push/fcm', auth, (req, res) => {
  const token = clean(req.body?.token, 4096);
  if (!token) return res.status(400).json({ error: 'Missing token' });
  db.prepare(`INSERT INTO fcm_tokens(token, user_id) VALUES (?, ?)
              ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at`)
    .run(token, req.user.id);
  res.json({ ok: true, enabled: fcm.enabled });
});
app.post('/api/push/fcm/remove', auth, (req, res) => {
  if (req.body?.token) db.prepare('DELETE FROM fcm_tokens WHERE token = ?').run(String(req.body.token));
  res.json({ ok: true });
});
// Android app reads its Firebase settings from here, so the APK works with whatever Firebase project the server uses
app.get('/api/android/config', (req, res) => {
  if (!fcm.clientConfig) return res.status(404).json({ error: 'Android alerts are not set up on the server yet (google-services.json missing)' });
  res.json(fcm.clientConfig);
});
// short link to download the latest Android app
app.get('/app', (req, res) => res.redirect(process.env.ANDROID_APK_URL || 'https://github.com/abrai2134/gatekeeperapp/releases/latest/download/gatekeeper.apk'));
app.post('/api/push/test', auth, async (req, res) => {
  const delay = Math.min(10, Math.max(0, Number(req.body?.delay) || 0));
  if (delay) await wait(delay * 1000); // gives time to lock the phone before the test arrives
  const results = await pushToUsers([req.user.id], {
    title: '🔔 Test notification', body: `Notifications are working for ${req.user.name} ✔`, tag: 'test', kind: 'test',
  });
  res.json({ devices: results.length, delivered: results.filter(Boolean).length });
});
app.post('/api/push/unsubscribe', auth, (req, res) => {
  if (req.body?.endpoint) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(req.body.endpoint);
  res.json({ ok: true });
});

// ---- units
app.get('/api/units', auth, (req, res) => {
  const s = scopeUnit(req.user);
  const rows = s == null
    ? db.prepare('SELECT * FROM units ORDER BY name').all()
    : db.prepare('SELECT * FROM units WHERE id = ?').all(s);
  res.json(rows);
});
app.post('/api/units', auth, requireSuperAdmin, (req, res) => {
  const name = clean(req.body?.name, 100);
  if (!name) return res.status(400).json({ error: 'Unit name is required' });
  const r = db.prepare('INSERT INTO units(name, code, address) VALUES (?,?,?)')
    .run(name, clean(req.body.code, 30), clean(req.body.address, 300));
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/units/:id', auth, requireSuperAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Unit not found' });
  const name = clean(req.body?.name, 100) || u.name;
  const active = req.body?.active == null ? u.active : (req.body.active ? 1 : 0);
  db.prepare('UPDATE units SET name=?, code=?, address=?, active=? WHERE id=?')
    .run(name, clean(req.body?.code, 30), clean(req.body?.address, 300), active, u.id);
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(u.id));
});

// ---- users
app.get('/api/users', auth, requireSuperAdmin, (req, res) => {
  res.json(db.prepare(`${USER_SELECT} ORDER BY users.role, units.name, users.name`).all().map(publicUser));
});
app.post('/api/users', auth, requireSuperAdmin, (req, res) => {
  const b = req.body || {};
  const username = clean(b.username, 50);
  const name = clean(b.name, 100);
  const role = b.role === 'admin' ? 'admin' : 'guard';
  const unitId = b.unit_id ? Number(b.unit_id) : null;
  if (!username || !name) return res.status(400).json({ error: 'Name and username are required' });
  if (!b.password || String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role === 'guard' && !unitId) return res.status(400).json({ error: 'A guard must belong to a unit' });
  if (unitId && !db.prepare('SELECT 1 FROM units WHERE id = ?').get(unitId)) return res.status(400).json({ error: 'Unit not found' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'Username already taken' });
  const r = db.prepare('INSERT INTO users(username,name,phone,password_hash,role,unit_id) VALUES (?,?,?,?,?,?)')
    .run(username, name, clean(b.phone, 20), hashPassword(b.password), role, unitId);
  res.json(publicUser(db.prepare(`${USER_SELECT} WHERE users.id = ?`).get(r.lastInsertRowid)));
});
app.put('/api/users/:id', auth, requireSuperAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  const role = b.role ? (b.role === 'admin' ? 'admin' : 'guard') : u.role;
  const unitId = 'unit_id' in b ? (b.unit_id ? Number(b.unit_id) : null) : u.unit_id;
  if (role === 'guard' && !unitId) return res.status(400).json({ error: 'A guard must belong to a unit' });
  const active = b.active == null ? u.active : (b.active ? 1 : 0);
  if (b.password && String(b.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (u.id === req.user.id && (!active || role !== 'admin' || unitId != null)) {
    return res.status(400).json({ error: 'You cannot disable or demote your own account' });
  }
  db.prepare('UPDATE users SET name=?, phone=?, role=?, unit_id=?, active=? WHERE id=?')
    .run(clean(b.name, 100) || u.name, 'phone' in b ? clean(b.phone, 20) : u.phone, role, unitId, active, u.id);
  if (b.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
  }
  if (b.password || !active || role !== u.role || unitId !== u.unit_id) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, req.token); // force re-login
  }
  res.json(publicUser(db.prepare(`${USER_SELECT} WHERE users.id = ?`).get(u.id)));
});

// ---- entries
const ENTRY_SELECT = `
  SELECT e.id, e.unit_id, un.name AS unit_name, e.entry_type, e.visitor_name, e.phone, e.company, e.purpose,
         e.whom_to_meet, e.vehicle_no, e.id_proof, e.persons_count, e.material_desc, e.material_qty, e.challan_no,
         (e.photo IS NOT NULL) AS has_photo, e.status, e.requested_at, e.decided_at, e.admin_remark,
         e.in_time, e.out_time, e.out_remark,
         rq.name AS requested_by_name, dc.name AS decided_by_name, ob.name AS out_by_name
  FROM entries e
  JOIN units un ON un.id = e.unit_id
  LEFT JOIN users rq ON rq.id = e.requested_by
  LEFT JOIN users dc ON dc.id = e.decided_by
  LEFT JOIN users ob ON ob.id = e.out_by`;
const getEntry = (id) => db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(id);

function broadcastEntry(event, entry) {
  io.to(`unit:${entry.unit_id}`).to('admins:all').emit(event, entry);
}

app.post('/api/entries', auth, (req, res) => {
  const b = req.body || {};
  let unitId = req.user.role === 'guard' ? req.user.unit_id : Number(b.unit_id || req.user.unit_id);
  if (!unitId || !canAccessUnit(req.user, unitId)) return res.status(400).json({ error: 'Select a valid unit' });
  const type = b.entry_type === 'MATERIAL' ? 'MATERIAL' : 'PERSON';
  const name = clean(b.visitor_name, 100);
  if (!name) return res.status(400).json({ error: type === 'PERSON' ? 'Visitor name is required' : 'Party / driver name is required' });
  if (type === 'MATERIAL' && !clean(b.material_desc)) return res.status(400).json({ error: 'Material description is required' });
  let photo = null;
  if (typeof b.photo === 'string' && b.photo.startsWith('data:image/') && b.photo.length < 4_000_000) photo = b.photo;
  const r = db.prepare(`INSERT INTO entries(unit_id, entry_type, visitor_name, phone, company, purpose, whom_to_meet,
      vehicle_no, id_proof, persons_count, material_desc, material_qty, challan_no, photo, requested_by, requested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(unitId, type, name, clean(b.phone, 20), clean(b.company, 100), clean(b.purpose, 300), clean(b.whom_to_meet, 100),
      clean(b.vehicle_no, 30), clean(b.id_proof, 100), Math.max(1, parseInt(b.persons_count, 10) || 1),
      clean(b.material_desc, 500), clean(b.material_qty, 100), clean(b.challan_no, 50), photo, req.user.id, now());
  const entry = getEntry(r.lastInsertRowid);
  broadcastEntry('entry:new', entry);
  pushToUsers(adminIdsForUnit(unitId), {
    title: `🔔 Entry request – ${entry.unit_name}`,
    body: `${type === 'PERSON' ? '👤' : '📦'} ${entry.visitor_name}${entry.company ? ' (' + entry.company + ')' : ''}` +
      `${entry.purpose ? ' – ' + entry.purpose : ''}${entry.material_desc ? ' – ' + entry.material_desc : ''}\nTap to approve or reject`,
    tag: `entry-${entry.id}`, entryId: entry.id, kind: 'request', entry,
  });
  res.json(entry);
});

app.get('/api/entries', auth, (req, res) => {
  const where = [];
  const args = [];
  const s = scopeUnit(req.user);
  if (s != null) { where.push('e.unit_id = ?'); args.push(s); }
  else if (req.query.unit_id) { where.push('e.unit_id = ?'); args.push(Number(req.query.unit_id)); }
  if (req.query.status) {
    const st = String(req.query.status).split(',').filter((x) => ['PENDING', 'APPROVED', 'REJECTED', 'EXITED'].includes(x));
    if (st.length) { where.push(`e.status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
  }
  if (req.query.type === 'PERSON' || req.query.type === 'MATERIAL') { where.push('e.entry_type = ?'); args.push(req.query.type); }
  if (req.query.from) { where.push('e.requested_at >= ?'); args.push(new Date(req.query.from).toISOString()); }
  if (req.query.to) { where.push('e.requested_at < ?'); args.push(new Date(req.query.to).toISOString()); }
  if (req.query.q) {
    where.push('(e.visitor_name LIKE ? OR e.phone LIKE ? OR e.company LIKE ? OR e.vehicle_no LIKE ? OR e.material_desc LIKE ? OR e.whom_to_meet LIKE ?)');
    const q = `%${String(req.query.q).trim()}%`;
    args.push(q, q, q, q, q, q);
  }
  const limit = Math.min(5000, parseInt(req.query.limit, 10) || 500);
  const sql = `${ENTRY_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.requested_at DESC LIMIT ${limit}`;
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/entries/:id/photo', auth, (req, res) => {
  const e = db.prepare('SELECT unit_id, photo FROM entries WHERE id = ?').get(req.params.id);
  if (!e || !canAccessUnit(req.user, e.unit_id) || !e.photo) return res.status(404).end();
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(e.photo);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(m[2], 'base64'));
});

app.post('/api/entries/:id/decision', auth, requireRole('admin'), (req, res) => {
  const e = getEntry(req.params.id);
  if (!e || !canAccessUnit(req.user, e.unit_id)) return res.status(404).json({ error: 'Request not found' });
  if (e.status !== 'PENDING') return res.status(409).json({ error: `Already ${e.status.toLowerCase()} by ${e.decided_by_name || 'someone'}` });
  const decision = req.body?.decision === 'APPROVED' ? 'APPROVED' : req.body?.decision === 'REJECTED' ? 'REJECTED' : null;
  if (!decision) return res.status(400).json({ error: 'Decision must be APPROVED or REJECTED' });
  const t = now();
  const r = db.prepare(`UPDATE entries SET status=?, decided_by=?, decided_at=?, admin_remark=?, in_time=?
                        WHERE id=? AND status='PENDING'`)
    .run(decision, req.user.id, t, clean(req.body.remark, 300), decision === 'APPROVED' ? t : null, e.id);
  if (!r.changes) return res.status(409).json({ error: 'Already decided' });
  const updated = getEntry(e.id);
  broadcastEntry('entry:updated', updated);
  const ok = decision === 'APPROVED';
  pushToUsers(guardIdsForUnit(updated.unit_id), {
    title: ok ? `✅ APPROVED – allow entry` : `❌ REJECTED – do not allow`,
    body: `${updated.visitor_name}${updated.admin_remark ? '\nRemark: ' + updated.admin_remark : ''}\nBy ${req.user.name}`,
    tag: `entry-${updated.id}`, entryId: updated.id, kind: ok ? 'approved' : 'rejected', entry: updated,
  });
  // close the alert on other admins' Android phones
  pushToUsers(adminIdsForUnit(updated.unit_id), { kind: 'closed', entryId: updated.id, by: req.user.name, status: decision }, { web: false });
  res.json(updated);
});

app.post('/api/entries/:id/exit', auth, (req, res) => {
  const e = getEntry(req.params.id);
  if (!e || !canAccessUnit(req.user, e.unit_id)) return res.status(404).json({ error: 'Entry not found' });
  if (e.status !== 'APPROVED') return res.status(409).json({ error: e.status === 'EXITED' ? 'Already marked OUT' : 'Only approved (inside) entries can be marked OUT' });
  const r = db.prepare(`UPDATE entries SET status='EXITED', out_time=?, out_by=?, out_remark=? WHERE id=? AND status='APPROVED'`)
    .run(now(), req.user.id, clean(req.body?.remark, 300), e.id);
  if (!r.changes) return res.status(409).json({ error: 'Already marked OUT' });
  const updated = getEntry(e.id);
  broadcastEntry('entry:updated', updated);
  res.json(updated);
});

app.get('/api/stats', auth, (req, res) => {
  const s = scopeUnit(req.user) ?? (req.query.unit_id ? Number(req.query.unit_id) : null);
  const since = req.query.since ? new Date(req.query.since).toISOString() : new Date(Date.now() - 864e5).toISOString();
  const w = s == null ? '' : 'AND unit_id = ?';
  const a = s == null ? [] : [s];
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  res.json({
    pending: one(`SELECT COUNT(*) c FROM entries WHERE status='PENDING' ${w}`, ...a),
    inside: one(`SELECT COUNT(*) c FROM entries WHERE status='APPROVED' ${w}`, ...a),
    today: one(`SELECT COUNT(*) c FROM entries WHERE requested_at >= ? ${w}`, since, ...a),
    rejected: one(`SELECT COUNT(*) c FROM entries WHERE status='REJECTED' AND requested_at >= ? ${w}`, since, ...a),
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------- reminders
// If a request is still waiting, remind the admins again every REMIND_EVERY_MIN minutes (max REMIND_MAX times)
const REMIND_EVERY_MIN = Number(process.env.REMIND_EVERY_MIN || 2);
const REMIND_MAX = Number(process.env.REMIND_MAX || 5);
function sendReminders() {
  const cutoff = new Date(Date.now() - REMIND_EVERY_MIN * 60000).toISOString();
  const due = db.prepare(`SELECT id FROM entries WHERE status='PENDING' AND reminder_count < ?
                          AND COALESCE(last_reminded_at, requested_at) <= ?`).all(REMIND_MAX, cutoff);
  for (const { id } of due) {
    db.prepare('UPDATE entries SET reminder_count = reminder_count + 1, last_reminded_at = ? WHERE id = ?').run(now(), id);
    const e = getEntry(id);
    const mins = Math.round((Date.now() - new Date(e.requested_at)) / 60000);
    pushToUsers(adminIdsForUnit(e.unit_id), {
      title: `⏰ Still waiting ${mins} min – ${e.unit_name}`,
      body: `${e.entry_type === 'PERSON' ? '👤' : '📦'} ${e.visitor_name} is waiting at the gate. Tap to approve or reject`,
      tag: `entry-${e.id}`, entryId: e.id, kind: 'request', entry: e,
    });
    io.to(`unit:${e.unit_id}`).to('admins:all').emit('entry:reminder', e);
  }
}
if (REMIND_MAX > 0) setInterval(() => { try { sendReminders(); } catch (err) { console.error(err); } }, 30000).unref();

// ---------------------------------------------------------------- realtime
const server = http.createServer(app);
const io = new Server(server);
io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});
io.on('connection', (socket) => {
  const u = socket.data.user;
  socket.join(`user:${u.id}`);
  if (u.role === 'admin' && u.unit_id == null) socket.join('admins:all');
  else if (u.unit_id) socket.join(`unit:${u.unit_id}`);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Gatekeeper running on http://localhost:${PORT}`));
}
module.exports = { server, db, sendReminders };

'use strict';
// End-to-end smoke test: run with `npm test` (uses a throw-away database and a fake Firebase server)
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-test-'));

// ---- fake Google OAuth + FCM server
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const fcmSent = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/token') {
      const jwt = new URLSearchParams(body).get('assertion').split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url'));
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok ? { access_token: 'AT', expires_in: 3600 } : { error: 'bad sig' }));
    }
    const msg = JSON.parse(body).message;
    if (req.headers.authorization !== 'Bearer AT') { res.writeHead(401); return res.end('{}'); }
    if (msg.token === 'dead-token') { res.writeHead(404); return res.end('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}'); }
    fcmSent.push(msg);
    res.writeHead(200); res.end('{"name":"x"}');
  });
});

let base;
mock.listen(0, () => {
  const mp = mock.address().port;
  process.env.FCM_API_BASE = `http://127.0.0.1:${mp}`;
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: 'demo', client_email: 'x@demo.iam.gserviceaccount.com', token_uri: `http://127.0.0.1:${mp}/token`,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  process.env.GOOGLE_SERVICES_JSON = JSON.stringify({
    project_info: { project_number: '123', project_id: 'demo' },
    client: [{ client_info: { mobilesdk_app_id: '1:123:android:abc', android_client_info: { package_name: 'com.wellworth.gatekeeper' } }, api_key: [{ current_key: 'KEY' }] }],
  });
  run();
});

function run() {
const { server, db, sendReminders } = require('../server');
const { io } = require('socket.io-client');

const call = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const waitFor = (sock, ev) => new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error('timeout ' + ev)), 3000); sock.once(ev, (d) => { clearTimeout(t); ok(d); }); });
const connect = (token) => new Promise((ok, bad) => { const s = io(base, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => ok(s)); s.on('connect_error', bad); });

server.listen(0, async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  try {
    assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'bad' })).status, 401);
    const admin = (await call(null, 'POST', '/api/login', { username: 'admin', password: 'admin123' })).data.token;
    const g1 = (await call(null, 'POST', '/api/login', { username: 'guard1', password: 'guard123' })).data.token;

    const u2 = (await call(admin, 'POST', '/api/units', { name: 'Unit 2', code: 'U2' })).data;
    assert.equal((await call(admin, 'POST', '/api/users', { username: 'guard2', name: 'G2', password: 'secret2', role: 'guard', unit_id: u2.id })).status, 200);
    assert.equal((await call(admin, 'POST', '/api/users', { username: 'admin2', name: 'Unit2 Admin', password: 'secret2', role: 'admin', unit_id: u2.id })).status, 200);
    const g2 = (await call(null, 'POST', '/api/login', { username: 'guard2', password: 'secret2' })).data.token;
    const a2 = (await call(null, 'POST', '/api/login', { username: 'admin2', password: 'secret2' })).data.token;
    assert.equal((await call(g1, 'POST', '/api/units', { name: 'x' })).status, 403, 'guard cannot add units');

    const sAdmin = await connect(admin), sG1 = await connect(g1), sG2 = await connect(g2), sA2 = await connect(a2);
    sockets.push(sAdmin, sG1, sG2, sA2);
    let g2Got = false, a2Got = false;
    sG2.on('entry:new', (e) => { if (e.unit_id !== u2.id) g2Got = true; });
    sA2.on('entry:new', () => { a2Got = true; });

    // guard1 raises a request -> main admin is notified live
    const pAdmin = waitFor(sAdmin, 'entry:new');
    const req = (await call(g1, 'POST', '/api/entries', { entry_type: 'PERSON', visitor_name: 'Ramesh', phone: '9999', purpose: 'Meeting', unit_id: u2.id })).data;
    assert.equal(req.status, 'PENDING');
    assert.equal(req.unit_name, 'Unit 1', 'guard is locked to own unit');
    assert.equal((await pAdmin).id, req.id);

    // other unit's guard & unit admin cannot see it
    assert.equal((await call(g2, 'GET', '/api/entries')).data.length, 0);
    assert.equal((await call(a2, 'POST', `/api/entries/${req.id}/decision`, { decision: 'APPROVED' })).status, 404);
    assert.equal((await call(g1, 'POST', `/api/entries/${req.id}/decision`, { decision: 'APPROVED' })).status, 403, 'guard cannot approve');
    assert.equal((await call(g1, 'POST', `/api/entries/${req.id}/exit`)).status, 409, 'cannot exit before approval');

    // admin approves -> guard1 notified live
    const pG1 = waitFor(sG1, 'entry:updated');
    const ok = (await call(admin, 'POST', `/api/entries/${req.id}/decision`, { decision: 'APPROVED', remark: 'Send to office' })).data;
    assert.equal(ok.status, 'APPROVED'); assert.ok(ok.in_time);
    const upd = await pG1; assert.equal(upd.status, 'APPROVED'); assert.equal(upd.admin_remark, 'Send to office');
    assert.equal((await call(admin, 'POST', `/api/entries/${req.id}/decision`, { decision: 'REJECTED' })).status, 409, 'no double decision');

    // guard marks OUT -> duration stored
    await new Promise((r) => setTimeout(r, 50));
    const out = (await call(g1, 'POST', `/api/entries/${req.id}/exit`, { remark: 'pass returned' })).data;
    assert.equal(out.status, 'EXITED'); assert.ok(new Date(out.out_time) > new Date(out.in_time));
    assert.equal((await call(g1, 'POST', `/api/entries/${req.id}/exit`)).status, 409);

    // material request at unit 2 -> unit-2 admin notified, rejected -> guard2 notified
    const pA2 = waitFor(sA2, 'entry:new');
    assert.equal((await call(g2, 'POST', '/api/entries', { entry_type: 'MATERIAL', visitor_name: 'Truck' })).status, 400, 'material needs description');
    const m = (await call(g2, 'POST', '/api/entries', { entry_type: 'MATERIAL', visitor_name: 'Truck', material_desc: 'Steel pipes', material_qty: '20' })).data;
    await pA2;
    const pG2 = waitFor(sG2, 'entry:updated');
    await call(a2, 'POST', `/api/entries/${m.id}/decision`, { decision: 'REJECTED', remark: 'No PO' });
    assert.equal((await pG2).status, 'REJECTED');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(g2Got, false, 'guard2 must not get unit-1 events'); assert.equal(a2Got, true);

    // reminder for a request still waiting
    const late = (await call(g1, 'POST', '/api/entries', { entry_type: 'PERSON', visitor_name: 'Late visitor' })).data;
    db.prepare('UPDATE entries SET requested_at = ? WHERE id = ?').run(new Date(Date.now() - 10 * 60000).toISOString(), late.id);
    const pRem = waitFor(sAdmin, 'entry:reminder');
    sendReminders();
    assert.equal((await pRem).id, late.id);
    sendReminders(); // not due again yet
    assert.equal(db.prepare('SELECT reminder_count c FROM entries WHERE id = ?').get(late.id).c, 1);
    await call(admin, 'POST', `/api/entries/${late.id}/decision`, { decision: 'REJECTED' });

    // push helpers
    assert.equal((await call(admin, 'GET', '/api/push/status')).data.devices, 0);
    assert.deepEqual((await call(admin, 'POST', '/api/push/test', {})).data, { devices: 0, delivered: 0 });
    assert.equal((await call(null, 'POST', '/api/push/resubscribe', { oldEndpoint: 'x', subscription: { endpoint: 'y' } })).status, 404);

    // ---- Android app (FCM) alerts
    assert.deepEqual((await call(null, 'GET', '/api/android/config')).data, { appId: '1:123:android:abc', apiKey: 'KEY', projectId: 'demo', senderId: '123' });
    await call(admin, 'POST', '/api/push/fcm', { token: 'admin-phone' });
    await call(admin, 'POST', '/api/push/fcm', { token: 'dead-token' });
    await call(g1, 'POST', '/api/push/fcm', { token: 'guard-phone' });
    const fe = (await call(g1, 'POST', '/api/entries', { entry_type: 'PERSON', visitor_name: 'Android test' })).data;
    await new Promise((r) => setTimeout(r, 300));
    const toAdmin = fcmSent.find((m) => m.token === 'admin-phone' && m.data.kind === 'request');
    assert.ok(toAdmin, 'admin phone got FCM request');
    assert.equal(toAdmin.android.priority, 'HIGH');
    assert.equal(JSON.parse(toAdmin.data.entry).visitor_name, 'Android test');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM fcm_tokens WHERE token='dead-token'").get().c, 0, 'dead token removed');
    await call(admin, 'POST', `/api/entries/${fe.id}/decision`, { decision: 'APPROVED' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(fcmSent.find((m) => m.token === 'guard-phone' && m.data.kind === 'approved' && m.data.entryId === String(fe.id)), 'guard phone got approval');
    assert.ok(fcmSent.find((m) => m.token === 'admin-phone' && m.data.kind === 'closed'), 'admin alert closed');
    assert.deepEqual((await call(g1, 'POST', '/api/push/test', {})).data, { devices: 1, delivered: 1 });
    await call(g1, 'POST', '/api/push/fcm/remove', { token: 'guard-phone' });
    assert.equal((await call(g1, 'GET', '/api/push/status')).data.android, 0);

    const stats = (await call(admin, 'GET', '/api/stats')).data;
    assert.deepEqual([stats.pending, stats.inside, stats.today, stats.rejected], [0, 1, 4, 2]);
    console.log('✔ all smoke tests passed');
  } catch (e) {
    console.error('✖', e); process.exitCode = 1;
  } finally {
    sockets.forEach((s) => s.close()); server.close(); mock.close(); setTimeout(() => process.exit(), 100);
  }
});
}

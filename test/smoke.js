'use strict';
// End-to-end smoke test: run with `npm test` (uses a throw-away database)
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-test-'));
const { server, db, sendReminders } = require('../server');
const { io } = require('socket.io-client');

let base;
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
    assert.deepEqual((await call(admin, 'GET', '/api/push/status')).data, { devices: 0 });
    assert.deepEqual((await call(admin, 'POST', '/api/push/test', {})).data, { devices: 0, delivered: 0 });
    assert.equal((await call(null, 'POST', '/api/push/resubscribe', { oldEndpoint: 'x', subscription: { endpoint: 'y' } })).status, 404);

    const stats = (await call(admin, 'GET', '/api/stats')).data;
    assert.deepEqual([stats.pending, stats.inside, stats.today, stats.rejected], [0, 0, 3, 2]);
    console.log('✔ all smoke tests passed');
  } catch (e) {
    console.error('✖', e); process.exitCode = 1;
  } finally {
    sockets.forEach((s) => s.close()); server.close(); setTimeout(() => process.exit(), 100);
  }
});

/* Gatekeeper front-end (vanilla JS, no build step) */
'use strict';

const S = {
  token: localStorage.getItem('gk_token'),
  user: null,
  vapidKey: null,
  units: [],
  tab: null,
  entries: {},          // id -> entry (live cache)
  stats: null,
  report: { rows: [], filters: null },
  users: [],
  socket: null,
  connected: false,
  draft: { entry_type: 'PERSON', photo: null },
  decisionQueue: [],    // admin: pending request ids to pop up
  pushOn: false,
};

// ------------------------------------------------------------ utils
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isAdmin = () => S.user?.role === 'admin';
const isSuper = () => isAdmin() && S.user.unit_id == null;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${t}`;
}
function fmtFull(iso) { return iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
function fmtDur(ms) {
  if (ms == null || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`;
}
const insideMs = (e) => e.in_time ? (e.out_time ? new Date(e.out_time) : new Date()) - new Date(e.in_time) : null;
const dayStart = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/api/login') { logout(true); throw new Error('Session expired, please log in again'); }
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---- sound (unlocked on first tap, browsers block audio before that)
let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } }
  audioCtx?.resume?.();
}, { capture: true });
function beep(pattern) {
  if (!audioCtx) return;
  let t = audioCtx.currentTime;
  for (const [freq, dur] of pattern) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur + 0.02);
    t += dur + 0.08;
  }
}
const SOUND = {
  request: [[880, 0.18], [1100, 0.18], [880, 0.18], [1100, 0.25]],
  approved: [[660, 0.15], [990, 0.3]],
  rejected: [[400, 0.25], [260, 0.4]],
};
function vibrate(p) { try { navigator.vibrate?.(p); } catch { /* ignore */ } }

// local notification when the tab is in the background and push is not set up
async function localNotify(title, body, tag) {
  if (S.pushOn || !document.hidden || Notification?.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(title, { body, tag, icon: '/icon.svg', renotify: true });
  else new Notification(title, { body, tag });
}

// ------------------------------------------------------------ push notifications
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function checkPush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  S.pushOn = !!sub && Notification.permission === 'granted';
  if (sub && S.pushOn) api('/api/push/subscribe', { body: sub.toJSON() }).catch(() => {}); // re-link to current user
}
async function enablePush() {
  if (!pushSupported()) { toast('This browser does not support notifications. On iPhone, add the app to Home Screen first.', 'err'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications are blocked. Allow them in browser settings.', 'err'); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(S.vapidKey) });
    await api('/api/push/subscribe', { body: sub.toJSON() });
    S.pushOn = true;
    toast('Notifications enabled ✔', 'ok');
  } catch (e) {
    console.error(e);
    toast('Could not enable push (needs HTTPS). In-app alerts will still work while the app is open.', 'err');
  }
  render();
}

// ------------------------------------------------------------ session
async function login(username, password) {
  const r = await api('/api/login', { body: { username, password } });
  S.token = r.token; localStorage.setItem('gk_token', r.token);
  S.user = r.user; S.vapidKey = r.vapidPublicKey;
  await start();
}
async function logout(silent) {
  if (!silent && S.token) {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) { await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
      await api('/api/logout', { body: {} });
    } catch { /* ignore */ }
  }
  S.token = null; S.user = null; S.entries = {}; S.decisionQueue = []; S.pushOn = false;
  localStorage.removeItem('gk_token');
  S.socket?.disconnect(); S.socket = null;
  closeModal();
  render();
}

async function start() {
  S.tab = isAdmin() ? 'requests' : 'new';
  S.units = await api('/api/units');
  connectSocket();
  await refreshLive();
  checkPush().then(render);
  render();
  const id = new URLSearchParams(location.search).get('entry');
  if (id) { history.replaceState(null, '', '/'); openEntry(Number(id)); }
  else if (isAdmin()) { S.decisionQueue = liveList('PENDING').map((e) => e.id).reverse(); showNextDecision(); }
}

// live data = pending + inside + last 24h
async function refreshLive() {
  const since = new Date(Date.now() - 864e5).toISOString();
  const [open, recent, stats] = await Promise.all([
    api('/api/entries?status=PENDING,APPROVED&limit=2000'),
    api(`/api/entries?from=${encodeURIComponent(since)}&limit=2000`),
    api(`/api/stats?since=${encodeURIComponent(dayStart().toISOString())}`),
  ]);
  S.entries = {};
  for (const e of [...recent, ...open]) S.entries[e.id] = e;
  S.stats = stats;
}
const liveList = (...statuses) => Object.values(S.entries)
  .filter((e) => !statuses.length || statuses.includes(e.status))
  .sort((a, b) => b.requested_at.localeCompare(a.requested_at));

function connectSocket() {
  S.socket?.disconnect();
  const sock = io({ auth: { token: S.token } });
  S.socket = sock;
  sock.on('connect', async () => { S.connected = true; try { await refreshLive(); } catch { /* ignore */ } render(); });
  sock.on('disconnect', () => { S.connected = false; render(); });
  sock.on('connect_error', (err) => { S.connected = false; if (err.message === 'unauthorized') logout(true); render(); });
  sock.on('entry:new', onEntryNew);
  sock.on('entry:updated', onEntryUpdated);
}
async function refreshStats() {
  try { S.stats = await api(`/api/stats?since=${encodeURIComponent(dayStart().toISOString())}`); } catch { /* ignore */ }
}

function onEntryNew(e) {
  S.entries[e.id] = e;
  refreshStats().then(render);
  if (isAdmin()) {
    beep(SOUND.request); vibrate([300, 100, 300, 100, 300]);
    localNotify(`🔔 Entry request – ${e.unit_name}`, `${e.visitor_name} ${e.purpose ? '– ' + e.purpose : ''}`, `entry-${e.id}`);
    if (!S.decisionQueue.includes(e.id)) S.decisionQueue.push(e.id);
    showNextDecision();
  }
  render();
}
function onEntryUpdated(e) {
  const prev = S.entries[e.id];
  S.entries[e.id] = e;
  refreshStats().then(render);
  const decidedNow = prev?.status === 'PENDING' || (!prev && e.status !== 'EXITED');
  if (S.user.role === 'guard' && decidedNow && (e.status === 'APPROVED' || e.status === 'REJECTED')) {
    const ok = e.status === 'APPROVED';
    beep(ok ? SOUND.approved : SOUND.rejected); vibrate(ok ? [200, 100, 200] : [600, 200, 600]);
    localNotify(ok ? '✅ APPROVED – allow entry' : '❌ REJECTED – do not allow', e.visitor_name, `entry-${e.id}`);
    showResult(e);
  }
  if (isAdmin() && e.status !== 'PENDING') {
    S.decisionQueue = S.decisionQueue.filter((id) => id !== e.id);
    if (currentModal?.type === 'decision' && currentModal.id === e.id) {
      closeModal();
      if (e.decided_by_name !== S.user.name) toast(`${e.visitor_name}: ${e.status.toLowerCase()} by ${e.decided_by_name}`);
      showNextDecision();
    }
  }
  if (currentModal?.type === 'detail' && currentModal.id === e.id) openEntry(e.id);
  render();
}

// ------------------------------------------------------------ modals
let currentModal = null;
function openModal(html, meta = {}) {
  currentModal = meta;
  $('#modal-root').innerHTML = `<div class="overlay" data-action="overlay"><div class="modal" role="dialog">${html}</div></div>`;
}
function closeModal() { currentModal = null; $('#modal-root').innerHTML = ''; }

function entryDetailsHTML(e) {
  const rows = [
    ['Unit', e.unit_name],
    ['Type', e.entry_type === 'PERSON' ? '👤 Person / Visitor' : '📦 Material'],
    [e.entry_type === 'PERSON' ? 'Name' : 'Party / Driver', e.visitor_name],
    ['Persons', e.entry_type === 'PERSON' && e.persons_count > 1 ? e.persons_count : null],
    ['Mobile', e.phone ? `<a href="tel:${esc(e.phone)}">${esc(e.phone)}</a>` : null, true],
    ['Company / From', e.company],
    ['Purpose', e.purpose],
    ['To meet', e.whom_to_meet],
    ['Material', e.material_desc],
    ['Quantity', e.material_qty],
    ['Challan / Invoice', e.challan_no],
    ['Vehicle no.', e.vehicle_no],
    ['ID proof', e.id_proof],
    ['Requested', `${fmtFull(e.requested_at)} by ${esc(e.requested_by_name || '')}`, true],
    ['Decision', e.decided_at ? `${e.status === 'REJECTED' ? 'Rejected' : 'Approved'} ${fmtFull(e.decided_at)} by ${esc(e.decided_by_name || '')}` : null, true],
    ['Admin remark', e.admin_remark],
    ['IN time', e.in_time ? fmtFull(e.in_time) : null],
    ['OUT time', e.out_time ? `${fmtFull(e.out_time)} by ${esc(e.out_by_name || '')}` : null, true],
    ['Time inside', e.in_time ? `<span class="timer" data-since="${esc(e.in_time)}" ${e.out_time ? `data-until="${esc(e.out_time)}"` : ''}>${fmtDur(insideMs(e))}</span>` : null, true],
    ['Out remark', e.out_remark],
  ];
  return `
    ${e.has_photo ? `<img class="photo" src="/api/entries/${e.id}/photo?t=${encodeURIComponent(S.token)}" alt="photo" data-photo="${e.id}">` : ''}
    <dl class="kv">${rows.filter((r) => r[1] != null && r[1] !== '').map(([k, v, raw]) => `<dt>${k}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>`;
}

// admin popup: approve (green) / reject (red)
function showNextDecision() {
  if (!isAdmin() || currentModal) return;
  while (S.decisionQueue.length) {
    const id = S.decisionQueue[0];
    const e = S.entries[id];
    if (e && e.status === 'PENDING') { openDecision(e); return; }
    S.decisionQueue.shift();
  }
}
function openDecision(e) {
  const more = S.decisionQueue.filter((id) => id !== e.id && S.entries[id]?.status === 'PENDING').length;
  openModal(`
    <div class="alert-head pulse">🔔 New ${e.entry_type === 'PERSON' ? 'visitor' : 'material'} at gate – ${esc(e.unit_name)}</div>
    <h3>${esc(e.visitor_name)}</h3>
    <div class="muted small">Waiting since ${fmtTime(e.requested_at)}${more ? ` · ${more} more waiting` : ''}</div>
    ${entryDetailsHTML(e)}
    <label for="remark">Remark (optional)</label>
    <input id="remark" placeholder="e.g. Send to HR office / Wrong challan">
    <div class="row" style="margin-top:14px">
      <button class="btn red big" data-action="decide" data-id="${e.id}" data-decision="REJECTED">✖ Reject</button>
      <button class="btn green big" data-action="decide" data-id="${e.id}" data-decision="APPROVED">✔ Approve</button>
    </div>
    <button class="btn block" style="margin-top:10px" data-action="later">Decide later</button>`, { type: 'decision', id: e.id });
}
async function decide(id, decision, btn) {
  const remark = $('#remark')?.value || '';
  btn && (btn.disabled = true);
  try {
    const e = await api(`/api/entries/${id}/decision`, { body: { decision, remark } });
    S.entries[e.id] = e;
    S.decisionQueue = S.decisionQueue.filter((x) => x !== id);
    closeModal();
    toast(decision === 'APPROVED' ? `✔ ${e.visitor_name} approved – guard notified` : `✖ ${e.visitor_name} rejected – guard notified`, decision === 'APPROVED' ? 'ok' : 'err');
    await refreshStats();
    render();
    showNextDecision();
  } catch (err) {
    toast(err.message, 'err');
    btn && (btn.disabled = false);
    if (/already/i.test(err.message)) { closeModal(); await refreshLive(); render(); showNextDecision(); }
  }
}

// guard popup: big green / red result
function showResult(e) {
  const ok = e.status === 'APPROVED';
  openModal(`
    <div class="result ${ok ? 'ok' : 'no'}">
      <div class="icon">${ok ? '✅' : '⛔'}</div>
      <div class="big">${ok ? 'APPROVED' : 'REJECTED'}</div>
      <div>${ok ? 'Allow entry' : 'Do NOT allow entry'}</div>
    </div>
    <h3>${esc(e.visitor_name)}</h3>
    <div class="muted small">${ok ? 'Approved' : 'Rejected'} by ${esc(e.decided_by_name || 'admin')} at ${fmtTime(e.decided_at)}</div>
    ${e.admin_remark ? `<div class="banner" style="margin-top:10px">💬 ${esc(e.admin_remark)}</div>` : ''}
    <button class="btn ${ok ? 'green' : 'red'} block big" style="margin-top:14px" data-action="close">OK</button>`, { type: 'result', id: e.id });
}

async function openEntry(id) {
  let e = S.entries[id];
  if (!e) {
    try {
      const rows = await api(`/api/entries?limit=5000`);
      e = rows.find((r) => r.id === id);
    } catch { /* ignore */ }
  }
  if (!e) { toast('Entry not found', 'err'); return; }
  if (isAdmin() && e.status === 'PENDING') { closeModal(); openDecision(e); return; }
  openModal(`
    <div class="row"><h3 class="grow">${esc(e.visitor_name)}</h3><span class="pill ${e.status}">${statusLabel(e.status)}</span></div>
    ${entryDetailsHTML(e)}
    ${e.status === 'APPROVED' ? `
      <label for="outremark">Out remark (optional)</label>
      <input id="outremark" placeholder="e.g. Returned visitor pass / material checked">
      <button class="btn dark block big" style="margin-top:12px" data-action="exit" data-id="${e.id}">🚪 Mark OUT now</button>` : ''}
    <button class="btn block" style="margin-top:10px" data-action="close">Close</button>`, { type: 'detail', id: e.id });
}
async function markExit(id, btn) {
  const e0 = S.entries[id];
  const remark = $('#outremark')?.value || '';
  if (!$('#outremark') && !confirm(`Mark ${e0?.visitor_name || 'this entry'} as OUT now?`)) return;
  btn && (btn.disabled = true);
  try {
    const e = await api(`/api/entries/${id}/exit`, { body: { remark } });
    S.entries[e.id] = e;
    closeModal();
    toast(`🚪 ${e.visitor_name} OUT – was inside ${fmtDur(insideMs(e))}`, 'ok');
    await refreshStats();
    render();
  } catch (err) { toast(err.message, 'err'); btn && (btn.disabled = false); }
}

// ------------------------------------------------------------ rendering
const statusLabel = (s) => ({ PENDING: 'WAITING', APPROVED: 'INSIDE', REJECTED: 'REJECTED', EXITED: 'OUT' }[s] || s);

function entryCard(e, { actions = true } = {}) {
  const icon = e.entry_type === 'PERSON' ? '👤' : '📦';
  const img = e.has_photo
    ? `<img class="ph" loading="lazy" src="/api/entries/${e.id}/photo?t=${encodeURIComponent(S.token)}" alt="">`
    : `<div class="ph">${icon}</div>`;
  const line2 = [e.company, e.purpose, e.whom_to_meet && `meet ${e.whom_to_meet}`].filter(Boolean).map(esc).join(' · ');
  const line3 = [e.material_desc && `${e.material_desc}${e.material_qty ? ' × ' + e.material_qty : ''}`, e.vehicle_no && `🚚 ${e.vehicle_no}`, e.phone && `📞 ${e.phone}`].filter(Boolean).map(esc).join(' · ');
  let timeLine = `Req ${fmtTime(e.requested_at)}`;
  if (e.in_time) timeLine = `IN ${fmtTime(e.in_time)}`;
  if (e.out_time) timeLine += ` → OUT ${fmtTime(e.out_time)}`;
  let acts = '';
  if (actions) {
    if (e.status === 'PENDING' && isAdmin()) {
      acts = `<div class="actions">
        <button class="btn red sm" data-action="quick-decide" data-id="${e.id}" data-decision="REJECTED">✖ Reject</button>
        <button class="btn green sm" data-action="quick-decide" data-id="${e.id}" data-decision="APPROVED">✔ Approve</button></div>`;
    } else if (e.status === 'APPROVED') {
      acts = `<div class="actions"><button class="btn dark sm" data-action="exit" data-id="${e.id}">🚪 Mark OUT</button></div>`;
    }
  }
  return `<div class="card entry ${e.status}" data-action="open" data-id="${e.id}">
    ${img}
    <div class="body">
      <div class="row" style="gap:6px"><span class="name grow">${esc(e.visitor_name)}${e.persons_count > 1 ? ` <span class="muted small">+${e.persons_count - 1}</span>` : ''}</span>
        <span class="pill ${e.status}">${statusLabel(e.status)}</span></div>
      ${isSuper() ? `<div class="meta">🏭 ${esc(e.unit_name)}</div>` : ''}
      ${line2 ? `<div class="meta">${line2}</div>` : ''}
      ${line3 ? `<div class="meta">${line3}</div>` : ''}
      <div class="meta">${timeLine}${e.in_time ? ` · <span class="timer" data-since="${esc(e.in_time)}" ${e.out_time ? `data-until="${esc(e.out_time)}"` : ''}>${fmtDur(insideMs(e))}</span>` : ''}
        ${e.status === 'REJECTED' && e.admin_remark ? ` · 💬 ${esc(e.admin_remark)}` : ''}</div>
      ${acts}
    </div>
  </div>`;
}
const listOrEmpty = (list, emptyIcon, emptyText) => list.length
  ? `<div class="grid">${list.map((e) => entryCard(e)).join('')}</div>`
  : `<div class="empty"><div class="i">${emptyIcon}</div>${emptyText}</div>`;

function statsHTML() {
  const s = S.stats || {};
  return `<div class="stats">
    <div class="stat"><b style="color:var(--amber)">${s.pending ?? 0}</b><span>Waiting approval</span></div>
    <div class="stat"><b style="color:var(--green)">${s.inside ?? 0}</b><span>Inside now</span></div>
    <div class="stat"><b>${s.today ?? 0}</b><span>Requests today</span></div>
    <div class="stat"><b style="color:var(--red)">${s.rejected ?? 0}</b><span>Rejected today</span></div>
  </div>`;
}
function pushBanner() {
  if (S.pushOn || !pushSupported() || localStorage.getItem('gk_push_dismiss') === '1') return '';
  return `<div class="banner"><span class="grow">🔔 Turn on notifications so you get ${isAdmin() ? 'entry requests' : 'approvals'} even when the app is closed.</span>
    <button class="btn primary sm" data-action="enable-push">Enable</button>
    <button class="btn sm" data-action="dismiss-push">Later</button></div>`;
}

function tabsFor() {
  const pending = liveList('PENDING').length;
  const inside = liveList('APPROVED').length;
  if (isAdmin()) {
    const t = [['requests', 'Requests', pending], ['inside', 'Inside', inside], ['today', 'Last 24h'], ['reports', 'Reports']];
    if (isSuper()) t.push(['units', 'Units'], ['users', 'Users']);
    t.push(['account', 'Account']);
    return t;
  }
  return [['new', '+ New Entry'], ['waiting', 'Waiting', pending], ['inside', 'Inside', inside], ['today', 'Last 24h'], ['account', 'Account']];
}

function render() {
  const app = $('#app');
  if (!S.user) { app.innerHTML = loginHTML(); return; }
  const tabs = tabsFor();
  if (!tabs.some((t) => t[0] === S.tab)) S.tab = tabs[0][0];
  const unitLabel = S.user.unit_name || (isAdmin() ? 'All units' : '');
  // keep form inputs while re-rendering the "new entry" tab
  const keep = S.tab === 'new' ? captureForm() : null;
  app.innerHTML = `
    <header class="topbar">
      <img class="logo" src="/icon.svg" alt="">
      <div class="grow"><div class="title">Gatekeeper<span class="conn ${S.connected ? 'on' : ''}" title="${S.connected ? 'Live' : 'Offline'}"></span></div>
        <div class="sub">${esc(S.user.name)} · ${isAdmin() ? 'Admin' : 'Gate guard'} · ${esc(unitLabel)}</div></div>
      <button data-action="logout">Logout</button>
    </header>
    <nav class="tabs">${tabs.map(([k, label, n]) => `<button class="tab ${S.tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}">${label}${n ? `<span class="badge">${n}</span>` : ''}</button>`).join('')}</nav>
    <main>${pushBanner()}${viewHTML()}</main>`;
  if (keep) restoreForm(keep);
  if (S.tab === 'reports' && !S.report.filters) runReport();
  if ((S.tab === 'users') && !S.users.length) loadUsers();
}

function viewHTML() {
  switch (S.tab) {
    case 'new': return newEntryHTML();
    case 'waiting': return `<h2>Waiting for admin approval</h2>${listOrEmpty(liveList('PENDING'), '⏳', 'No requests waiting')}`;
    case 'requests': return `${statsHTML()}<h2>Pending requests</h2>${listOrEmpty(liveList('PENDING'), '✅', 'No pending requests. New requests will pop up here with a sound.')}`;
    case 'inside': return `${isAdmin() ? statsHTML() : ''}<h2>Inside now <span class="muted small">(tap Mark OUT when they leave)</span></h2>${listOrEmpty(liveList('APPROVED'), '🏭', 'Nobody is inside right now')}`;
    case 'today': return `<h2>Last 24 hours</h2>${listOrEmpty(liveList(), '📋', 'No entries in the last 24 hours')}`;
    case 'reports': return reportsHTML();
    case 'units': return unitsHTML();
    case 'users': return usersHTML();
    case 'account': return accountHTML();
    default: return '';
  }
}

function loginHTML() {
  return `<div class="login"><form class="card" id="login-form">
    <img class="logo" src="/icon.svg" alt="">
    <h1>Gatekeeper</h1>
    <p class="muted small" style="text-align:center;margin:4px 0 10px">Gate entry · approval · exit register</p>
    <label for="lu">Username</label><input id="lu" name="username" autocomplete="username" autocapitalize="none" required>
    <label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required>
    <button class="btn primary block big" style="margin-top:16px">Log in</button>
  </form></div>`;
}

// ---- guard: new entry form
const FIELDS = ['visitor_name', 'phone', 'persons_count', 'company', 'purpose', 'whom_to_meet', 'vehicle_no', 'id_proof', 'material_desc', 'material_qty', 'challan_no', 'unit_id'];
function captureForm() {
  const f = $('#entry-form');
  if (!f) return null;
  const o = {};
  for (const k of FIELDS) if (f.elements[k]) o[k] = f.elements[k].value;
  return o;
}
function restoreForm(o) {
  const f = $('#entry-form');
  if (!f) return;
  for (const k of FIELDS) if (f.elements[k] && o[k] != null) f.elements[k].value = o[k];
}
function newEntryHTML() {
  const t = S.draft.entry_type;
  const P = t === 'PERSON';
  return `<form id="entry-form" class="card" autocomplete="off">
    <div class="seg">
      <button type="button" class="${P ? 'on' : ''}" data-action="etype" data-type="PERSON">👤 Person</button>
      <button type="button" class="${!P ? 'on' : ''}" data-action="etype" data-type="MATERIAL">📦 Material</button>
    </div>
    ${S.user.role !== 'guard' ? `<label>Unit</label><select name="unit_id">${S.units.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>` : ''}
    <div class="two">
      <div><label>${P ? 'Visitor name *' : 'Party / driver name *'}</label><input name="visitor_name" required></div>
      <div><label>Mobile no.</label><input name="phone" type="tel" inputmode="tel"></div>
    </div>
    ${P ? `
    <div class="two">
      <div><label>Company / coming from</label><input name="company"></div>
      <div><label>Whom to meet</label><input name="whom_to_meet"></div>
    </div>
    <label>Purpose of visit</label><input name="purpose" placeholder="Meeting, interview, service, delivery…">
    <div class="two">
      <div><label>No. of persons</label><input name="persons_count" type="number" min="1" value="1"></div>
      <div><label>ID proof (type / no.)</label><input name="id_proof" placeholder="Aadhaar / DL …"></div>
    </div>
    <label>Vehicle no.</label><input name="vehicle_no" style="text-transform:uppercase">` : `
    <label>Material description *</label><textarea name="material_desc" required placeholder="e.g. Steel pipes 2 inch, compressor spares…"></textarea>
    <div class="two">
      <div><label>Quantity</label><input name="material_qty" placeholder="e.g. 20 nos / 2 boxes"></div>
      <div><label>Challan / invoice no.</label><input name="challan_no"></div>
    </div>
    <div class="two">
      <div><label>Supplier / company</label><input name="company"></div>
      <div><label>Vehicle no.</label><input name="vehicle_no" style="text-transform:uppercase"></div>
    </div>
    <div class="two">
      <div><label>For department / person</label><input name="whom_to_meet"></div>
      <div><label>Purpose / remark</label><input name="purpose"></div>
    </div>`}
    <label>Photo</label>
    <div class="photo-box">
      ${S.draft.photo ? `<img src="${S.draft.photo}" alt="photo"><button type="button" class="btn sm" data-action="clear-photo">Remove</button>` : ''}
      <label class="btn" style="margin:0;display:inline-block">📷 ${S.draft.photo ? 'Retake' : 'Take photo'}
        <input type="file" accept="image/*" capture="environment" id="photo-input" class="hidden"></label>
    </div>
    <button class="btn primary block big" style="margin-top:18px" id="send-btn">Send for approval ➜</button>
  </form>`;
}
async function resizeImage(file, max = 900) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  } finally { URL.revokeObjectURL(url); }
}
async function submitEntry(form) {
  const body = { entry_type: S.draft.entry_type, photo: S.draft.photo };
  for (const k of FIELDS) if (form.elements[k]) body[k] = form.elements[k].value;
  if (body.vehicle_no) body.vehicle_no = body.vehicle_no.toUpperCase();
  const btn = $('#send-btn'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const e = await api('/api/entries', { body });
    S.entries[e.id] = e;
    S.draft = { entry_type: S.draft.entry_type, photo: null };
    form.reset();
    toast(`Sent to admin ✔ – ${e.visitor_name}. You will be notified.`, 'ok');
    S.tab = 'waiting';
    await refreshStats();
    render();
  } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'Send for approval ➜'; }
}

// ---- reports
function reportsHTML() {
  const f = S.report.filters || defaultFilters();
  const rows = S.report.rows;
  const done = rows.filter((r) => r.in_time);
  const exited = rows.filter((r) => r.out_time);
  const avg = exited.length ? exited.reduce((a, r) => a + insideMs(r), 0) / exited.length : null;
  return `<h2>Entry / exit register</h2>
  <form id="report-form" class="card filters">
    ${isSuper() ? `<div><label>Unit</label><select name="unit_id"><option value="">All units</option>${S.units.map((u) => `<option value="${u.id}" ${String(f.unit_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>` : ''}
    <div><label>From</label><input type="date" name="from" value="${f.from}"></div>
    <div><label>To</label><input type="date" name="to" value="${f.to}"></div>
    <div><label>Type</label><select name="type"><option value="">All</option><option value="PERSON" ${f.type === 'PERSON' ? 'selected' : ''}>Person</option><option value="MATERIAL" ${f.type === 'MATERIAL' ? 'selected' : ''}>Material</option></select></div>
    <div><label>Status</label><select name="status"><option value="">All</option>${['PENDING', 'APPROVED', 'REJECTED', 'EXITED'].map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}</select></div>
    <div><label>Search</label><input name="q" value="${esc(f.q)}" placeholder="name, phone, vehicle…"></div>
    <div class="row" style="flex-wrap:nowrap;grid-column:span 2"><button class="btn primary grow">Show</button><button type="button" class="btn" data-action="csv">⬇ Excel/CSV</button></div>
  </form>
  <p class="muted small">${rows.length} entries · ${done.length} went inside · ${exited.length} exited · average time inside: <b>${fmtDur(avg)}</b></p>
  ${rows.length ? `<div class="table-wrap"><table><thead><tr>
    <th>#</th>${isSuper() ? '<th>Unit</th>' : ''}<th>Type</th><th>Name</th><th>Mobile</th><th>Company</th><th>Purpose / Material</th><th>Vehicle</th>
    <th>Requested</th><th>Status</th><th>Decided by</th><th>IN</th><th>OUT</th><th>Time inside</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-action="open" data-id="${r.id}"><td>${r.id}</td>${isSuper() ? `<td>${esc(r.unit_name)}</td>` : ''}
      <td>${r.entry_type === 'PERSON' ? '👤' : '📦'}</td><td>${esc(r.visitor_name)}</td><td>${esc(r.phone)}</td><td>${esc(r.company)}</td>
      <td>${esc(r.entry_type === 'PERSON' ? r.purpose : `${r.material_desc || ''}${r.material_qty ? ' × ' + r.material_qty : ''}`)}</td><td>${esc(r.vehicle_no)}</td>
      <td>${fmtFull(r.requested_at)}</td><td><span class="pill ${r.status}">${statusLabel(r.status)}</span></td><td>${esc(r.decided_by_name)}</td>
      <td>${fmtFull(r.in_time)}</td><td>${fmtFull(r.out_time)}</td><td>${r.in_time ? fmtDur(insideMs(r)) : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty"><div class="i">🔍</div>No entries for these filters</div>'}`;
}
function defaultFilters() {
  const d = new Date();
  return { unit_id: '', from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(d), type: '', status: '', q: '' };
}
async function runReport(form) {
  const f = form ? Object.fromEntries(new FormData(form)) : (S.report.filters || defaultFilters());
  f.unit_id ??= ''; f.q ??= '';
  S.report.filters = f;
  const p = new URLSearchParams({ limit: '5000' });
  if (f.unit_id) p.set('unit_id', f.unit_id);
  if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) { const t = new Date(`${f.to}T00:00:00`); t.setDate(t.getDate() + 1); p.set('to', t.toISOString()); }
  if (f.type) p.set('type', f.type);
  if (f.status) p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  try { S.report.rows = await api(`/api/entries?${p}`); } catch (e) { toast(e.message, 'err'); }
  if (S.tab === 'reports') render();
}
function downloadCSV() {
  const rows = S.report.rows;
  const head = ['ID', 'Unit', 'Type', 'Name', 'Mobile', 'Company', 'Persons', 'Purpose', 'Whom to meet', 'Material', 'Qty', 'Challan', 'Vehicle', 'ID proof',
    'Requested at', 'Requested by', 'Status', 'Decided at', 'Decided by', 'Admin remark', 'IN time', 'OUT time', 'Out by', 'Out remark', 'Minutes inside', 'Time inside'];
  const t = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const lines = rows.map((r) => [r.id, r.unit_name, r.entry_type, r.visitor_name, r.phone, r.company, r.persons_count, r.purpose, r.whom_to_meet,
    r.material_desc, r.material_qty, r.challan_no, r.vehicle_no, r.id_proof, t(r.requested_at), r.requested_by_name, statusLabel(r.status), t(r.decided_at),
    r.decided_by_name, r.admin_remark, t(r.in_time), t(r.out_time), r.out_by_name, r.out_remark,
    r.in_time ? Math.round(insideMs(r) / 60000) : '', r.in_time ? fmtDur(insideMs(r)) : '']);
  const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  const f = S.report.filters || {};
  a.download = `gate-register_${f.from || ''}_to_${f.to || ''}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- units & users (main admin)
function unitsHTML() {
  return `<h2>Units / plants</h2>
  <form id="unit-form" class="card" style="margin-bottom:14px">
    <div class="two"><div><label>Unit name *</label><input name="name" required placeholder="e.g. Unit 2 – Bhiwandi"></div>
    <div><label>Short code</label><input name="code" placeholder="U2"></div></div>
    <label>Address</label><input name="address">
    <button class="btn primary" style="margin-top:12px">+ Add unit</button>
  </form>
  <div class="grid">${S.units.map((u) => `<div class="card">
    <div class="row"><b class="grow">${esc(u.name)}</b>${u.code ? `<span class="pill type">${esc(u.code)}</span>` : ''}${u.active ? '' : '<span class="pill REJECTED">INACTIVE</span>'}</div>
    <div class="muted small">${esc(u.address || '')}</div>
    <div class="muted small">${S.users.filter((x) => x.unit_id === u.id && x.role === 'guard').length} guard login(s)</div>
    <div class="actions row" style="margin-top:8px"><button class="btn sm" data-action="edit-unit" data-id="${u.id}">Rename</button>
    <button class="btn sm" data-action="toggle-unit" data-id="${u.id}">${u.active ? 'Deactivate' : 'Activate'}</button></div>
  </div>`).join('')}</div>`;
}
async function loadUsers() {
  try { S.users = await api('/api/users'); if (['users', 'units'].includes(S.tab)) render(); } catch (e) { toast(e.message, 'err'); }
}
function usersHTML() {
  const unitOpts = (sel) => S.units.map((u) => `<option value="${u.id}" ${String(sel) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  return `<h2>Logins (guards &amp; admins)</h2>
  <form id="user-form" class="card" style="margin-bottom:14px" autocomplete="off">
    <div class="two">
      <div><label>Role</label><select name="role"><option value="guard">Gate guard (one unit)</option><option value="admin">Admin</option></select></div>
      <div><label>Unit</label><select name="unit_id"><option value="">— All units (admin only) —</option>${unitOpts('')}</select></div>
    </div>
    <div class="two">
      <div><label>Full name *</label><input name="name" required></div>
      <div><label>Mobile</label><input name="phone" type="tel"></div>
    </div>
    <div class="two">
      <div><label>Username *</label><input name="username" required autocapitalize="none"></div>
      <div><label>Password * (min 6)</label><input name="password" required minlength="6"></div>
    </div>
    <button class="btn primary" style="margin-top:12px">+ Create login</button>
  </form>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Unit</th><th>Mobile</th><th>Status</th><th></th></tr></thead><tbody>
  ${S.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'Admin' : 'Guard'}</td>
    <td><select data-action="user-unit" data-id="${u.id}" style="padding:4px 6px;min-width:120px">${u.role === 'admin' ? '<option value="">All units</option>' : ''}${unitOpts(u.unit_id)}</select></td>
    <td>${esc(u.phone)}</td><td>${u.active ? '<span class="pill APPROVED">ACTIVE</span>' : '<span class="pill REJECTED">DISABLED</span>'}</td>
    <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-action="reset-pw" data-id="${u.id}">Reset password</button>
    <button class="btn sm" data-action="toggle-user" data-id="${u.id}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}
  </tbody></table></div>
  <p class="muted small">Tip: admins with a unit selected can only see and approve that unit. "All units" admin is the main admin.</p>`;
}

function accountHTML() {
  return `<h2>My account</h2>
  <div class="card" style="margin-bottom:14px">
    <dl class="kv"><dt>Name</dt><dd>${esc(S.user.name)}</dd><dt>Username</dt><dd>${esc(S.user.username)}</dd>
    <dt>Role</dt><dd>${isAdmin() ? 'Admin' : 'Gate guard'}</dd><dt>Unit</dt><dd>${esc(S.user.unit_name || 'All units')}</dd>
    <dt>Notifications</dt><dd>${S.pushOn ? '✅ On' : '❌ Off'} <button class="btn sm" data-action="enable-push">${S.pushOn ? 'Re-check' : 'Enable'}</button></dd></dl>
  </div>
  <form id="pw-form" class="card">
    <b>Change password</b>
    <label>Current password</label><input type="password" name="current" required autocomplete="current-password">
    <label>New password (min 6)</label><input type="password" name="next" required minlength="6" autocomplete="new-password">
    <button class="btn primary" style="margin-top:12px">Change password</button>
  </form>`;
}

// ------------------------------------------------------------ events
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id ? Number(el.dataset.id) : null;
  if (a === 'overlay') { if (ev.target === el && currentModal?.type !== 'decision') closeModal(); return; }
  if (['quick-decide', 'exit'].includes(a) || (a === 'open' && ev.target.closest('button'))) ev.stopPropagation();
  switch (a) {
    case 'tab': S.tab = el.dataset.tab; if (S.tab === 'units') loadUsers(); render(); window.scrollTo(0, 0); break;
    case 'logout': if (confirm('Log out?')) logout(); break;
    case 'open': if (!ev.target.closest('button')) openEntry(id); break;
    case 'close': closeModal(); if (isAdmin()) showNextDecision(); break;
    case 'later': S.decisionQueue = S.decisionQueue.filter((x) => x !== currentModal?.id); closeModal(); showNextDecision(); break;
    case 'decide': decide(id, el.dataset.decision, el); break;
    case 'quick-decide': {
      const e = S.entries[id];
      if (el.dataset.decision === 'REJECTED') { closeModal(); openDecision(e); setTimeout(() => $('#remark')?.focus(), 50); }
      else decide(id, 'APPROVED', el);
      break;
    }
    case 'exit': markExit(id, el); break;
    case 'etype': { const keep = captureForm(); S.draft.entry_type = el.dataset.type; render(); if (keep) restoreForm(keep); break; }
    case 'clear-photo': S.draft.photo = null; render(); break;
    case 'enable-push': enablePush(); break;
    case 'dismiss-push': localStorage.setItem('gk_push_dismiss', '1'); render(); break;
    case 'csv': downloadCSV(); break;
    case 'edit-unit': {
      const u = S.units.find((x) => x.id === id);
      const name = prompt('Unit name', u.name); if (!name) return;
      const code = prompt('Short code', u.code || '') ?? u.code;
      const address = prompt('Address', u.address || '') ?? u.address;
      try { await api(`/api/units/${id}`, { method: 'PUT', body: { name, code, address } }); S.units = await api('/api/units'); render(); } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'toggle-unit': {
      const u = S.units.find((x) => x.id === id);
      try { await api(`/api/units/${id}`, { method: 'PUT', body: { ...u, active: !u.active } }); S.units = await api('/api/units'); render(); } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'reset-pw': {
      const u = S.users.find((x) => x.id === id);
      const pw = prompt(`New password for ${u.name} (min 6 characters)`); if (!pw) return;
      try { await api(`/api/users/${id}`, { method: 'PUT', body: { password: pw } }); toast('Password changed. They must log in again.', 'ok'); } catch (e) { toast(e.message, 'err'); }
      break;
    }
    case 'toggle-user': {
      const u = S.users.find((x) => x.id === id);
      try { await api(`/api/users/${id}`, { method: 'PUT', body: { active: !u.active } }); await loadUsers(); } catch (e) { toast(e.message, 'err'); }
      break;
    }
    default: break;
  }
});
document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'photo-input' && ev.target.files[0]) {
    try { const keep = captureForm(); S.draft.photo = await resizeImage(ev.target.files[0]); render(); if (keep) restoreForm(keep); } catch { toast('Could not read photo', 'err'); }
  }
  if (ev.target.dataset.action === 'user-unit') {
    const id = Number(ev.target.dataset.id);
    try { await api(`/api/users/${id}`, { method: 'PUT', body: { unit_id: ev.target.value || null } }); toast('Unit updated', 'ok'); await loadUsers(); }
    catch (e) { toast(e.message, 'err'); await loadUsers(); }
  }
});
document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    if (f.id === 'login-form') {
      const btn = f.querySelector('button'); btn.disabled = true;
      try { await login(f.username.value, f.password.value); } finally { btn.disabled = false; }
    } else if (f.id === 'entry-form') {
      await submitEntry(f);
    } else if (f.id === 'report-form') {
      await runReport(f);
    } else if (f.id === 'unit-form') {
      await api('/api/units', { body: Object.fromEntries(new FormData(f)) });
      S.units = await api('/api/units'); toast('Unit added ✔', 'ok'); render();
    } else if (f.id === 'user-form') {
      const body = Object.fromEntries(new FormData(f));
      await api('/api/users', { body }); toast(`Login created for ${body.name} ✔`, 'ok'); await loadUsers();
    } else if (f.id === 'pw-form') {
      await api('/api/me/password', { body: Object.fromEntries(new FormData(f)) }); f.reset(); toast('Password changed ✔', 'ok');
    }
  } catch (e) { toast(e.message, 'err'); }
});

// live "time inside" counters
setInterval(() => {
  document.querySelectorAll('.timer[data-since]').forEach((el) => {
    if (el.dataset.until) return;
    el.textContent = fmtDur(Date.now() - new Date(el.dataset.since));
  });
}, 30000);

// ------------------------------------------------------------ boot
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'open') {
      const id = Number(new URL(ev.data.url, location.origin).searchParams.get('entry'));
      if (id && S.user) refreshLive().then(() => { render(); openEntry(id); });
    }
  });
}
(async () => {
  if (S.token) {
    try {
      const r = await api('/api/me');
      S.user = r.user; S.vapidKey = r.vapidPublicKey;
      await start();
      return;
    } catch { /* fall through to login */ }
  }
  render();
})();

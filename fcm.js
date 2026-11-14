'use strict';
/**
 * Firebase Cloud Messaging (FCM) sender for the Android app – no extra npm packages needed.
 *
 * Two files from your Firebase project are needed on the server (Render → Secret Files):
 *   firebase-service-account.json  (Project settings → Service accounts → Generate new private key)
 *   google-services.json           (Project settings → Your apps → Android app → download)
 * They are looked for in /etc/secrets/ (Render secret files) and in DATA_DIR,
 * or can be given as JSON text in env vars FIREBASE_SERVICE_ACCOUNT / GOOGLE_SERVICES_JSON.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(envName, fileNames) {
  const raw = process.env[envName];
  if (raw && raw.trim()) {
    try { return JSON.parse(raw); } catch { console.error(`${envName} is not valid JSON – ignored`); }
  }
  for (const f of fileNames) {
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error(`Cannot read ${f}: ${e.message}`); }
  }
  return null;
}

module.exports = function createFcm({ dataDir, androidPackage }) {
  const places = (name) => [path.join('/etc/secrets', name), path.join(dataDir, name)];
  const sa = readJson('FIREBASE_SERVICE_ACCOUNT', places('firebase-service-account.json'));
  const gs = readJson('GOOGLE_SERVICES_JSON', places('google-services.json'));

  // public settings the Android app needs to start Firebase (these are not secret – they are inside every APK)
  let clientConfig = null;
  if (gs) {
    try {
      const clients = gs.client || [];
      const client = clients.find((c) => c.client_info?.android_client_info?.package_name === androidPackage) || clients[0];
      clientConfig = {
        appId: client.client_info.mobilesdk_app_id,
        apiKey: client.api_key[0].current_key,
        projectId: gs.project_info.project_id,
        senderId: gs.project_info.project_number,
      };
    } catch { console.error('google-services.json format not recognised'); }
  }

  const enabled = !!(sa && sa.private_key && sa.client_email && sa.project_id);
  const tokenUri = sa?.token_uri || 'https://oauth2.googleapis.com/token';
  const apiBase = process.env.FCM_API_BASE || 'https://fcm.googleapis.com';
  let cached = null;

  async function accessToken() {
    if (cached && cached.exp > Date.now() + 60000) return cached.token;
    const iat = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat, exp: iat + 3600,
    })}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
    const r = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw Object.assign(new Error(`Google auth failed: ${r.status} ${j.error_description || j.error || ''}`), { status: 500 });
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return cached.token;
  }

  /** Send a data message. Resolves 'ok' or 'invalid' (token no longer valid); throws on other errors. */
  async function send(token, data) {
    const at = await accessToken();
    const r = await fetch(`${apiBase}/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '21600s' } } }),
    });
    if (r.ok) return 'ok';
    const body = await r.text();
    if (r.status === 404 || /UNREGISTERED/.test(body) || (r.status === 400 && /registration token/i.test(body))) return 'invalid';
    if (r.status === 401) cached = null;
    throw Object.assign(new Error(`FCM ${r.status}: ${body.slice(0, 300)}`), { status: r.status });
  }

  return { enabled, clientConfig, send };
};

/* Service worker: shows push notifications even when the app is closed */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Gatekeeper', body: event.data && event.data.text() }; }
  const urgent = data.kind === 'request' || data.kind === 'rejected';
  event.waitUntil(self.registration.showNotification(data.title || 'Gatekeeper', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,             // sound + pop again even if an older one with the same tag is showing
    requireInteraction: true,   // stays on screen until the guard / admin taps it
    silent: false,
    vibrate: urgent ? [400, 150, 400, 150, 400, 150, 400] : [250, 100, 250],
    icon: '/icon.svg',
    badge: '/icon.svg',
    timestamp: Date.now(),
    data: { url: data.entryId ? `/?entry=${data.entryId}` : '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open', url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

// The browser sometimes renews the push subscription; re-register it so notifications don't silently stop
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const sub = event.newSubscription || await self.registration.pushManager.subscribe(
      old?.options || { userVisibleOnly: true, applicationServerKey: await (await fetch('/api/push/key')).text() });
    if (old) {
      await fetch('/api/push/resubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: sub.toJSON() }),
      });
    }
  })());
});

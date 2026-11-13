/* Service worker: shows push notifications even when the app is closed */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Gatekeeper', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Gatekeeper', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    requireInteraction: data.kind === 'request',
    vibrate: data.kind === 'request' ? [300, 100, 300, 100, 300] : [200, 100, 200],
    icon: '/icon.svg',
    badge: '/icon.svg',
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

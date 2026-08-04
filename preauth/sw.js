// Service worker for the L&L Pre-Authorisations staff dashboard.
//
// Scope: /preauth/ (the file must be served from this path — GitHub Pages /
// Vercel serves it as-is; no rewrite needed).
//
// Responsibilities:
//   - Handle Web Push events and show a notification
//   - Bring the dashboard tab forward (or open one) when a notification is
//     clicked, and — if the payload carries a requestId — deep-link to it
//
// No offline caching is attempted here on purpose: the dashboard is live-data
// only, and stale caches would be misleading (mistakenly presenting stale hold
// statuses would be worse than a plain "no connection" state).

const SCOPE_URL = new URL('./', self.location).toString();

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    // Fall back to plain text if the payload is not JSON.
    try { data = { title: 'Liquid & Larder', body: event.data ? event.data.text() : '' }; }
    catch (_) { data = { title: 'Liquid & Larder', body: '' }; }
  }
  const title = data.title || 'Liquid & Larder';
  const opts = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: data.tag || undefined,
    // Chrome collapses same-tag notifications; renotify=true still buzzes.
    renotify: !!data.tag,
    data: {
      url: data.url || SCOPE_URL,
      requestId: data.requestId,
    },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || SCOPE_URL;
  const requestId = event.notification.data && event.notification.data.requestId;
  const finalUrl = requestId ? `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}request=${encodeURIComponent(requestId)}` : targetUrl;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // If the dashboard is already open, focus it and hand it the URL.
      if (c.url.startsWith(SCOPE_URL)) {
        try { await c.focus(); c.postMessage({ type: 'push-navigate', url: finalUrl }); return; }
        catch (_) { /* fall through to open */ }
      }
    }
    await self.clients.openWindow(finalUrl);
  })());
});

/**
 * DorkOS service worker — the only thing that runs when DorkOS is closed.
 *
 * It exists for exactly one job: draw the notification a blocked agent's
 * escalation pushes, and take you to it when you tap (spec `notification-system`
 * task 4.3, ADR 260819-234829). It is NOT an offline cache and does not
 * intercept a single request — the cockpit talks to a server on your own
 * machine, so there is nothing a cache here could make faster and plenty it
 * could make wrong.
 *
 * Plain JavaScript in `public/`, served at the origin root so its scope covers
 * every route. It is deliberately tiny: a service worker updates on its own
 * schedule and can outlive several app versions, so anything clever in here is a
 * thing that keeps running after it stops being true.
 *
 * The payload it receives is the server's `WebPushPayload` and nothing else:
 * a title, a short body, a route, an id and a tier.
 */

/* global self, clients, URL */

/** Take over as soon as installed rather than waiting for every tab to close. */
self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  if (!payload) return;

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body ?? '',
      // The id is the tag, so a second push about the same thing REPLACES the
      // first rather than stacking a second banner for one condition.
      tag: payload.notificationId,
      data: { deepLink: payload.deepLink },
      // This is the leg that reaches a pocket, so a blocking condition is
      // allowed to make a sound — that is the entire point of it. Everything
      // else arrives quietly: it can wait until the phone is looked at anyway.
      silent: payload.tier !== 'blocking',
      // Blocking notifications stay until they are dealt with. A phone that
      // auto-dismisses the one message that needed an answer is the failure this
      // whole ladder exists to prevent.
      requireInteraction: payload.tier === 'blocking',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const deepLink = event.notification.data?.deepLink;
  if (typeof deepLink !== 'string' || deepLink === '') return;

  event.waitUntil(openDeepLink(deepLink));
});

/**
 * Read a push's payload, tolerating anything that is not one.
 *
 * A push with no data, or with data that is not JSON, is ignored rather than
 * drawn: a banner with no title is worse than no banner, and there is nobody
 * here to tell about it.
 */
function readPayload(event) {
  if (!event.data) return null;
  let parsed;
  try {
    parsed = event.data.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.title !== 'string' || parsed.title === '') return null;
  if (typeof parsed.notificationId !== 'string' || parsed.notificationId === '') return null;
  return parsed;
}

/**
 * Focus a DorkOS window on the route, or open one.
 *
 * An already-open window is reused and navigated rather than a second one being
 * opened — somebody tapping a notification wants the thing, not another copy of
 * the app. `navigate()` is not available in every browser that supports push, so
 * a focus that cannot navigate still brings the app forward.
 */
async function openDeepLink(deepLink) {
  const url = new URL(deepLink, self.location.origin).href;
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of windows) {
    if (!client.url.startsWith(self.location.origin)) continue;
    if (typeof client.navigate === 'function') {
      const navigated = await client.navigate(url).catch(() => null);
      await (navigated ?? client).focus();
      return;
    }
    await client.focus();
    return;
  }

  await clients.openWindow(url);
}

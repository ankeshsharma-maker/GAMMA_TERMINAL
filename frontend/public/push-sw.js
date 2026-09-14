// Bolted onto the Workbox-generated service worker via workbox.importScripts
// (see vite.config.ts) -- classic-script scope, so plain self.addEventListener,
// no imports/exports. Precaching and the app-shell fallback stay entirely
// Workbox's job; this file only adds push + notification-click handling.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "GammaTerminal", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "GammaTerminal";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "gt-alert",
      renotify: true,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

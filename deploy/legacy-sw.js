self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("studio-shell-")).map(k => caches.delete(k)))).then(() => self.registration.unregister()));
});

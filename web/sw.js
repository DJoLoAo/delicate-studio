const SHELL = "studio-shell-v1";
const SHELL_FILES = ["/studio/", "/studio/index.html", "/studio/studio.css", "/studio/app.js", "/studio/dialog.js", "/studio/i18n.js", "/studio/favicon.svg", "/studio/manifest.webmanifest", "/studio/fonts/fonts.css", "/studio/fonts/JetBrainsMono.woff2", "/studio/fonts/InstrumentSerif-Regular.woff2", "/studio/fonts/InstrumentSerif-Italic.woff2", "/studio/worldpicker/lang-picker.js", "/studio/worldpicker/countries.js", "/studio/worldpicker/world.js", "/studio/worldpicker/flags-meta.js", "/studio/worldpicker/flags.webp", "/studio/i18n/de.json", "/studio/i18n/fr.json", "/studio/i18n/es.json", "/studio/i18n/it.json", "/studio/i18n/pt.json", "/studio/i18n/hi.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => Promise.allSettled(SHELL_FILES.map(f => c.add(f)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("studio-shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") { const shell = await cache.match("/studio/"); if (shell) return shell; }
    throw err;
  }
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (!url.pathname.startsWith("/studio/") || url.pathname.startsWith("/studio/api/")) return;
  e.respondWith(networkFirst(e.request));
});

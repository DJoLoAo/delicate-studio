const SHELL = "studio-shell-v10";
const SHELL_FILES = ["/", "/index.html", "/studio.css", "/app.js", "/editor.js", "/edit.js", "/commands.js", "/export.js", "/repair.js", "/nr.js", "/hum.js", "/worker.js", "/player-worklet.js", "/studio-dsp.wasm", "/dialog.js", "/i18n.js", "/favicon.svg", "/manifest.webmanifest", "/fonts/fonts.css", "/fonts/JetBrainsMono.woff2", "/fonts/InstrumentSerif-Regular.woff2", "/fonts/InstrumentSerif-Italic.woff2", "/worldpicker/lang-picker.js", "/worldpicker/countries.js", "/worldpicker/world.js", "/worldpicker/flags-meta.js", "/worldpicker/flags.webp", "/i18n/de.json", "/i18n/fr.json", "/i18n/es.json", "/i18n/it.json", "/i18n/pt.json", "/i18n/hi.json"];

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
    if (req.mode === "navigate") { const shell = await cache.match("/"); if (shell) return shell; }
    throw err;
  }
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(networkFirst(e.request));
});

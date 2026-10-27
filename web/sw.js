const SHELL = "studio-shell-v42";
const SHELL_FILES = ["/", "/index.html", "/studio.css", "/app.js", "/editor.js", "/edit.js", "/commands.js", "/export.js", "/publish.js", "/repair.js", "/nr.js", "/hum.js", "/spec.js", "/ld.js", "/fx.js", "/scope.js", "/batch.js", "/report.js", "/nulltest.js", "/streamprev.js", "/md.js", "/trcore.js", "/tr.js", "/px.js", "/pen.js", "/onset.js", "/tn.js", "/sesmath.js", "/session.js", "/djrec.js", "/tags.js", "/ft.js", "/album.js", "/rec.js", "/ext.js", "/tour.js", "/rec-worker.js", "/rec-worklet.js", "/worker.js", "/player-worklet.js", "/studio-dsp.wasm", "/dialog.js", "/i18n.js", "/themes.js", "/favicon.svg", "/manifest.webmanifest", "/fonts/fonts.css", "/fonts/phimonic/Phimonic-Regular.woff2", "/fonts/phimonic/Phimonic-Bold.woff2", "/fonts/phimonic/PhimonicStraightened-Regular.woff2", "/fonts/phimonic/PhimonicStraightened-Bold.woff2", "/fonts/JetBrainsMono.woff2", "/fonts/InstrumentSerif-Regular.woff2", "/fonts/InstrumentSerif-Italic.woff2", "/worldpicker/lang-picker.js", "/worldpicker/countries.js", "/worldpicker/world.js", "/worldpicker/flags-meta.js", "/worldpicker/flags.webp", "/i18n/de.json", "/i18n/fr.json", "/i18n/es.json", "/i18n/it.json", "/i18n/pt.json", "/i18n/hi.json"];

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

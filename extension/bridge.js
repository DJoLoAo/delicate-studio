(() => {
  const ORIGIN = location.origin;
  const post = m => window.postMessage(Object.assign({ from: "dsx-ext" }, m), ORIGIN);
  const send = m => { try { return chrome.runtime.sendMessage(m); } catch (e) { return Promise.reject(e); } };

  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const m = e.data;
    if (!m || m.from !== "dsx-page" || typeof m.t !== "string") return;
    const rid = m.rid;
    send({ t: "page", m: { t: m.t, st: m.st } }).then(
      r => { if (rid) post({ t: "reply", rid, r: r || null }); },
      () => { if (rid) post({ t: "reply", rid, r: { error: "extension" } }); }
    );
  });

  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !m) return false;
    if (m.t === "alive") { reply(true); return false; }
    if (m.t === "toPage" && m.m) { post(m.m); reply(true); }
    return false;
  });

  send({ t: "here" }).catch(() => {});
})();

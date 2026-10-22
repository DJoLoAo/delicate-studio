const ex = { on: false, v: "", keys: {}, rid: 0, wait: new Map(), last: "" };

function extSend(m) {
  window.postMessage(Object.assign({}, m, { from: "dsx-page" }), location.origin);
}

function extCall(m, ms) {
  return new Promise(res => {
    const rid = ++ex.rid;
    const to = setTimeout(() => { ex.wait.delete(rid); res(null); }, ms || 4000);
    ex.wait.set(rid, r => { clearTimeout(to); res(r); });
    extSend(Object.assign({}, m, { rid }));
  });
}

function extMsg(e) {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.from !== "dsx-ext" || typeof m.t !== "string") return;
  if (m.t === "reply") { const f = ex.wait.get(m.rid); if (f) { ex.wait.delete(m.rid); f(m.r); } return; }
  ex.on = true;
  if (m.t === "tab") extTab(m);
  else if (m.t === "cmd") extCmd(String(m.cmd));
}

function extStatus() {
  if (!ex.on) return;
  const st = { phase: rc.phase, secs: rc.sr ? Math.floor(rc.frames / rc.sr) : 0, marks: rc.marks, name: recBusy() ? rc.take : "", kind: rc.src ? rc.src.kind : "dev", err: rc.err || "" };
  const k = JSON.stringify(st);
  if (k === ex.last) return;
  ex.last = k;
  extSend({ t: "status", st });
}

async function extKeys() {
  if (!ex.on) return;
  const r = await extCall({ t: "keys" }, 2000);
  if (r && r.keys && typeof r.keys === "object") { ex.keys = r.keys; recRender(); }
}

function extCanRun() {
  if (rc.ctx && rc.ctx.state === "running") return true;
  if (navigator.userActivation && navigator.userActivation.hasBeenActive) return true;
  try { const c = new AudioContext(), ok = c.state === "running"; c.close(); return ok; } catch { return false; }
}

async function extTab(m) {
  if (recBusy()) { extSend({ t: "focus" }); flash(t("A recording is running.")); return; }
  rc.src = { kind: "ext", title: String(m.title || "").replace(/\s+/g, " ").trim().slice(0, 200), pending: true };
  rc.extMon = true;
  rc.err = null;
  rc.note = null;
  await recOpen(true);
  if (!extCanRun()) { recRender(); extSend({ t: "focus" }); return; }
  await recInput("ext");
  if (rc.ctx && m.start !== false) await recGo();
}

async function extCmd(cmd) {
  if (cmd === "marker") { recMark(); return; }
  if (cmd !== "toggle") return;
  if (recBusy()) { recGo(); return; }
  if (!extCanRun() || (!rc.ctx && !recPending() && !(await recGranted()))) { await recOpen(); extSend({ t: "focus" }); return; }
  await recGo();
}

async function extInit() {
  window.addEventListener("message", extMsg);
  const r = await extCall({ t: "ping" }, 2000);
  if (!r || r.error) return;
  ex.on = true;
  ex.v = String(r.v || "");
  ex.keys = r.keys && typeof r.keys === "object" ? r.keys : {};
  recRender();
  extStatus();
}

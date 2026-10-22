const TN_LEVELS = [{ v: "low", label: "Strong only" }, { v: "normal", label: "Normal" }, { v: "high", label: "Sensitive" }, { v: "max", label: "Very sensitive" }];
const TN_SNAP = 6;

const tn = { on: false, level: "normal", pos: [], key: "", want: "", docId: null, stale: false, rev: 0, seq: 0, job: null, timer: 0 };

function tnLoad() {
  try {
    tn.on = localStorage.getItem("studioTransients") === "1";
    const v = localStorage.getItem("studioTnLevel");
    if (TN_LEVELS.some(l => l.v === v)) tn.level = v;
  } catch {}
}

function tnKey() { return ed.doc ? ed.doc.id + ":" + audioKey() + ":" + tn.level : ""; }

function tnDrawKey() { return tn.on ? tn.rev + (tn.stale ? "s" : "") : ""; }

function tnStatus() {
  const j = tn.job;
  if (!j || !(j.frac > 0)) return;
  clearTimeout(ed.flashT);
  j.text = t("Finding transients") + " · " + Math.round(j.frac * 100) + " %";
  $("stMsg").textContent = j.text;
}

function tnProg(m) {
  if (!tn.job || m.id !== tn.job.id) return;
  tn.job.frac = m.frac;
  tnStatus();
}

function tnSay() {
  const n = tn.pos.length, k = cmdKeyText("nextTransient");
  flash(n ? (n === 1 ? t("1 transient") : t("{n} transients").replace("{n}", n.toLocaleString())) + (k ? " · " + t("{key} goes to the next one").replace("{key}", k) : "") : t("No transients found. Settings → Editing → Transients can be more sensitive."));
}

async function tnRefresh(say) {
  if (!tn.on || !ed.doc) return;
  const key = tnKey();
  if (key === tn.key) { if (say) tnSay(); return; }
  if (key === tn.want) return;
  tn.want = key;
  const id = "n" + (++tn.seq);
  tn.job = { id, frac: 0 };
  let ok = false;
  try {
    const r = await call({ t: "tnscan", id: ed.doc.id, jobId: id, level: tn.level });
    if (tnKey() === key) {
      tn.pos = r.pos;
      tn.key = key;
      tn.stale = false;
      tn.rev++;
      ok = true;
    }
  } catch (e) {
    const m = e && e.message || String(e);
    if (m !== "stale" && m !== "cancelled" && tnKey() === key) flash(t("Could not find transients") + ": " + m);
  } finally {
    const j = tn.job;
    if (j && j.id === id) {
      tn.job = null;
      if (j.text && $("stMsg").textContent === j.text) $("stMsg").textContent = "";
    }
    if (tn.want === key) tn.want = "";
  }
  redraw();
  if (ok && say) tnSay();
  if (tn.on && ed.doc && tnKey() !== tn.key && !tn.want) tnSoon(say);
}

function tnSoon(say) {
  clearTimeout(tn.timer);
  tn.timer = setTimeout(() => tnRefresh(say), 400);
}

function tnSet(on) {
  tn.on = !!on;
  try { localStorage.setItem("studioTransients", tn.on ? "1" : "0"); } catch {}
  $("tnBtn").classList.toggle("on", tn.on);
  if (!tn.on) {
    clearTimeout(tn.timer);
    if (tn.job) call({ t: "tncancel" }).catch(() => {});
    flash(t("Transient markers off"));
  } else tnRefresh(true);
  tn.rev++;
  redraw();
}

function tnToggle() { tnSet(!tn.on); }

function tnLevel(v) {
  if (!TN_LEVELS.some(l => l.v === v)) return;
  tn.level = v;
  try { localStorage.setItem("studioTnLevel", v); } catch {}
  if (tn.on) tnRefresh(true);
}

function tnMap(h) {
  const d = h.b - h.a, out = [];
  for (const p of tn.pos) {
    if (h.op === "crop") { if (p >= h.a && p < h.b) out.push(p - h.a); continue; }
    if (p < h.a) { out.push(p); continue; }
    if (h.op === "delete" || h.op === "cut") { if (p >= h.b) out.push(p - d); continue; }
    if (h.op === "insert") { out.push(p + h.n); continue; }
    if (h.op === "paste") { if (p >= h.b) out.push(p - d + h.n); continue; }
    out.push(p);
  }
  return out;
}

function tnAfterEdit(prevIdx) {
  if (!ed.doc) return;
  if (ed.doc.id !== tn.docId) {
    tn.docId = ed.doc.id;
    tn.pos = [];
    tn.key = "";
    tn.stale = false;
    tn.rev++;
    if (tn.on) tnSoon(false);
    return;
  }
  if (tnKey() === tn.key) return;
  if (!tn.on) { tn.stale = true; return; }
  const h = ed.hist[ed.histIdx];
  if (ed.histIdx === prevIdx + 1 && h && !h.ch && ["delete", "cut", "insert", "paste", "crop"].includes(h.op)) tn.pos = tnMap(h);
  else if (!h || !["heal", "pencil", "repair", "declip", "spot", "spheal", "spdel"].includes(h.op)) tn.stale = true;
  tn.rev++;
  tnSoon(false);
}

function tnClose() {
  clearTimeout(tn.timer);
  tn.pos = [];
  tn.key = "";
  tn.docId = null;
  tn.stale = false;
  tn.rev++;
}

function tnFirstAfter(f) {
  const P = tn.pos;
  let lo = 0, hi = P.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (P[m] <= f) lo = m + 1; else hi = m; }
  return lo;
}

function tnSnap(f, free) {
  if (!tn.on || free || !tn.pos.length) return f;
  const i = tnFirstAfter(f), tol = TN_SNAP * ed.view.spp;
  let best = f, bd = tol + 1;
  for (const k of [i - 1, i]) {
    if (k < 0 || k >= tn.pos.length) continue;
    const d = Math.abs(tn.pos[k] - f);
    if (d < bd) { bd = d; best = tn.pos[k]; }
  }
  return bd <= tol ? best : f;
}

function tnStep(dir, extend) {
  if (!ed.doc || !tn.on) return;
  if (!tn.pos.length) { if (tn.job || tn.want) flash(t("Still finding transients…")); else tnSay(); return; }
  const sel = selOn();
  const here = extend && sel ? (dir > 0 ? ed.sel.b : ed.sel.a) : ed.play.on ? Math.floor(playhead()) : ed.cursor;
  const i = tnFirstAfter(here + 0.5);
  let p = null;
  if (dir > 0) { if (i < tn.pos.length) p = tn.pos[i]; }
  else { let k = i - 1; while (k >= 0 && tn.pos[k] >= here - 0.5) k--; if (k >= 0) p = tn.pos[k]; }
  if (p === null) { flash(t(dir > 0 ? "No more transients after this point." : "No more transients before this point.")); return; }
  if (!extend) { jumpTo(p); return; }
  const anchor = sel ? (dir > 0 ? ed.sel.a : ed.sel.b) : ed.cursor;
  const a = Math.min(anchor, p), b = Math.max(anchor, p);
  ed.sel = b > a ? { a, b } : { a: 0, b: 0 };
  ed.cursor = a;
  ensureVisible(p);
  redraw();
}

function tnDraw(g, W, H, dpr) {
  if (!tn.on || !tn.pos.length) return;
  const P = tn.pos, end = ed.view.start + W / dpr * ed.view.spp;
  let i = tnFirstAfter(ed.view.start - 1);
  const ch = ed.doc.channels, lh = H / ch, tick = Math.min(lh / 4, 9 * dpr);
  let n = 0;
  for (let k = i; k < P.length && P[k] <= end; k++) n++;
  const lines = n < W / dpr / 4, a = tn.stale ? 0.4 : 1;
  for (; i < P.length && P[i] <= end; i++) {
    const x = Math.round(xOf(P[i]) * dpr);
    if (x < 0 || x > W) continue;
    if (lines) { g.fillStyle = tc("pink", 0.16 * a); g.fillRect(x, 0, Math.max(1, dpr), H); }
    g.fillStyle = tc("pink", 0.75 * a);
    for (let c = 0; c < ch; c++) {
      g.fillRect(x, c * lh, Math.max(1, dpr), tick);
      g.fillRect(x, (c + 1) * lh - tick, Math.max(1, dpr), tick);
    }
  }
}

function wireTn() {
  tnLoad();
  $("tnBtn").classList.toggle("on", tn.on);
  ddInit($("tnDd"), TN_LEVELS, tn.level, v => tnLevel(v));
}

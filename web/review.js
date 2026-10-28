const RV_DAYS = [{ v: "7", label: "Link works for 7 days" }, { v: "30", label: "Link works for 30 days" }, { v: "90", label: "Link works for 90 days" }, { v: "0", label: "Link works until deleted" }];
const RV_BINS = 2000;
const rv = { open: false, doc: "", list: null, sel: "", job: null, days: "30", timer: 0, seen: {}, loading: false };

function rvUrl(r) { return location.origin + "/r/" + r.token; }

function rvSecs(s) { const v = Math.max(0, Math.round(s)), h = Math.floor(v / 3600), m = Math.floor(v / 60) % 60; return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(v % 60).padStart(2, "0"); }

function rvDate(sec) { try { return new Date(sec * 1000).toLocaleDateString(i18n.lang || undefined, { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } }

async function rvFetch(path, opts) {
  const r = await fetch("/api/studio" + path, Object.assign({ cache: "no-store" }, opts || {}));
  let j = null;
  try { j = r.status === 204 ? {} : await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || String(r.status)); e.status = r.status; throw e; }
  return j || {};
}

function rvErr(e) {
  const m = e && e.message;
  if (e && e.status === 401) return t("Log in again to share for review.");
  if (m === "full") return t("Your review storage is full. Delete older review links first.");
  if (m === "too-many") return t("You have too many review links. Delete some first.");
  if (m === "size") return t("Too long for a review link. Share a shorter selection.");
  return t("Could not create the review link") + " (" + (m || "?") + ")";
}

async function rvLoad(force) {
  if (!ed.doc || rv.loading) return;
  const id = ed.doc.id;
  if (!force && rv.doc === id && rv.list) return;
  rv.loading = true;
  try {
    const j = await rvFetch("/reviews?doc=" + encodeURIComponent(id));
    if (ed.doc && ed.doc.id === id) {
      const fresh = rv.doc === id && rv.list;
      let added = 0;
      for (const r of j.reviews) {
        const n = r.comments.length;
        if (fresh && rv.seen[r.id] !== undefined && n > rv.seen[r.id]) added += n - rv.seen[r.id];
        rv.seen[r.id] = n;
      }
      rv.doc = id;
      rv.list = j.reviews.sort((a, b) => b.created - a.created);
      if (!rv.list.some(r => r.id === rv.sel)) rv.sel = rv.list.length ? rv.list[0].id : "";
      if (added) flash(added === 1 ? t("1 new review comment") : t("{n} new review comments").replace("{n}", added));
    }
  } catch (e) { if (rv.doc !== id) { rv.doc = id; rv.list = []; } }
  finally { rv.loading = false; }
}

async function rvShow() {
  rv.open = true;
  await rvLoad(true);
  rvRender();
  clearInterval(rv.timer);
  rv.timer = setInterval(rvTick, 30000);
}

function rvHide() {
  rv.open = false;
  clearInterval(rv.timer);
  rv.timer = 0;
}

async function rvTick() {
  if (!rv.open || !ed.doc || rv.job) return;
  await rvLoad(true);
  rvRender();
}

async function rvPeaks(d, a, b) {
  const n = b - a, bins = Math.min(RV_BINS, Math.max(1, n)), out = new Float32Array(bins), STEP = 1 << 20;
  for (let s = a; s < b; s += STEP) {
    const k = Math.min(STEP, b - s), r = await call({ t: "read", id: d.id, start: s, count: k }), g = r.count;
    for (let c = 0; c < d.channels; c++) {
      const base = c * g;
      for (let i = 0; i < g; i++) {
        const v = Math.abs(r.data[base + i]), bi = Math.min(bins - 1, Math.floor((s - a + i) / n * bins));
        if (v > out[bi]) out[bi] = v;
      }
    }
  }
  return Array.from(out, v => Math.round(Math.min(1, v) * 1000) / 1000);
}

function rvJob(m) {
  const J = rv.job;
  if (!J || m.id !== J.xid) return false;
  if (m.state === "rendering" || m.state === "hashing") { J.frac = (m.state === "rendering" ? 0.5 : 0.1) * (m.frac || 0) + (m.state === "hashing" ? 0.5 : 0); rvProg(); }
  if (m.state === "done") J.res(m);
  if (m.state === "failed" || m.state === "cancelled") J.rej(new Error(m.error || m.state));
  return true;
}

function rvProg() {
  const bar = $("rvBar");
  if (!bar) return;
  bar.classList.toggle("hidden", !rv.job);
  bar.firstElementChild.style.width = rv.job ? Math.round(rv.job.frac * 100) + "%" : "0";
}

async function rvCreate() {
  if (!ed.doc || rv.job) return;
  const d = ed.doc, on = ed.sel.b > ed.sel.a, a = on ? Math.floor(ed.sel.a) : 0, b = on ? Math.floor(ed.sel.b) : d.frames;
  if (b - a < d.sampleRate) { flash(t("Too short for a review link.")); return; }
  const xid = "rv" + Date.now().toString(36);
  const J = { xid, frac: 0 };
  J.done = new Promise((res, rej) => { J.res = res; J.rej = rej; });
  rv.job = J;
  rvRender();
  const name = d.name.replace(/\.[^.]+$/, "") + (on ? " (" + fmtTime(a) + "–" + fmtTime(b) + ")" : "");
  try {
    const peaks = await rvPeaks(d, a, b);
    await call({ t: "export", id: d.id, jobId: xid, a, b, name: name + ".flac", fmt: { type: "flac", bits: d.bits === 16 ? 16 : 24, rate: 0 }, master: { gain: 0, dither: "tpdf", shaping: "off" }, dest: { kind: "review" }, tags: [["TITLE", name]], marks: [] });
    const m = await J.done;
    const root = await navigator.storage.getDirectory(), dir = await (await root.getDirectoryHandle("studio")).getDirectoryHandle("exports");
    const file = await (await dir.getFileHandle(m.file)).getFile();
    const R = await rvFetch("/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, doc: d.id, a, sr: d.sampleRate, ch: d.channels, frames: b - a, size: file.size, days: Number(rv.days), peaks }) });
    const part = R.part || 900 << 10;
    for (let off = 0; off < file.size;) {
      const blob = file.slice(off, Math.min(file.size, off + part));
      const r = await rvFetch("/reviews/" + R.id + "/data?off=" + off, { method: "PUT", body: blob });
      off = r.got;
      J.frac = 0.6 + 0.4 * off / file.size;
      rvProg();
    }
    await rvFetch("/reviews/" + R.id + "/done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha256: m.sha }) });
    try { await dir.removeEntry(m.file); } catch {}
    rv.sel = R.id;
    await rvLoad(true);
    const url = location.origin + "/r/" + R.token;
    try { await navigator.clipboard.writeText(url); flash(t("Review link copied")); } catch { flash(t("Review link ready")); }
  } catch (e) { tell(rvErr(e), t("Share for review")); }
  finally { rv.job = null; rvRender(); }
}

function rvSeek(r, at) {
  if (!ed.doc || ed.doc.id !== r.doc) return;
  const f = Math.min(ed.doc.frames, r.a + Math.round(at * r.sr));
  if (ed.play.on) startPlay(f);
  else { ed.cursor = f; ensureVisible(f); redraw(); }
}

async function rvResolve(r, c) {
  try {
    await rvFetch("/reviews/" + r.id + "/comments/" + c.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: !c.done }) });
    c.done = !c.done;
    rvRender();
  } catch (e) { tell(String(e.message || e), t("Could not change the comment")); }
}

async function rvMarks(r) {
  const open = r.comments.filter(c => !c.done);
  if (!open.length || !ed.doc) return;
  const res = await runEdit({ t: "edit", op: "markpoints", points: open.map(c => ({ a: Math.min(ed.doc.frames, r.a + Math.round(c.at * r.sr)), name: c.name + ": " + c.text })) }, false, true);
  if (res) flash(open.length === 1 ? t("1 marker from the review") : t("{n} markers from the review").replace("{n}", open.length));
}

async function rvDelete(r) {
  if (!(await ask(t("Delete this review link?"), t("The link stops working and its comments are deleted."), { ok: t("delete") }))) return;
  try { await rvFetch("/reviews/" + r.id, { method: "DELETE" }); } catch (e) { tell(String(e.message || e), t("Could not delete the review link")); return; }
  await rvLoad(true);
  rvRender();
}

function rvEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function rvBtn(label, fn, cls, title) { const b = rvEl("button", cls || "outbtn", label); b.type = "button"; if (title) b.title = title; b.addEventListener("click", fn); return b; }

function rvRender() {
  if (!rv.open || !$("rvBody")) return;
  const d = ed.doc;
  if (d && rv.doc !== d.id && !rv.loading) { rvLoad().then(() => { if (rv.open) rvRender(); }); }
  $("rvRangeT").textContent = d ? (ed.sel.b > ed.sel.a ? t("Selection") + " · " + fmtDur((ed.sel.b - ed.sel.a) / d.sampleRate) : t("Whole file") + " · " + fmtDur(d.frames / d.sampleRate)) : "";
  $("rvGo").disabled = !!rv.job || !d;
  rvProg();
  const box = $("rvList");
  box.textContent = "";
  const L = d && rv.doc === d.id ? rv.list || [] : [];
  $("rvNote").textContent = rv.job ? t("Preparing the review link…") : L.length ? "" : t("A review link plays this file in any browser, without an account. Listeners leave comments at a time, and they come back here.");
  for (const r of L) {
    const open = r.comments.filter(c => !c.done).length;
    const row = rvEl("div", "rvrow" + (r.id === rv.sel ? " on" : ""));
    const head = rvEl("button", "rvhead");
    head.type = "button";
    head.append(rvEl("b", "", r.name), rvEl("span", "snote", rvDate(r.created) + " · " + (r.expires ? t("until {d}").replace("{d}", rvDate(r.expires)) : t("no expiry")) + " · " + (r.comments.length === 1 ? t("1 comment") : t("{n} comments").replace("{n}", r.comments.length)) + (open && open !== r.comments.length ? " · " + t("{n} open").replace("{n}", open) : "")));
    head.addEventListener("click", () => { rv.sel = r.id; rvRender(); });
    const acts = rvEl("span", "rvacts");
    acts.append(rvBtn(t("copy link"), async () => { try { await navigator.clipboard.writeText(rvUrl(r)); flash(t("Review link copied")); } catch { tell(rvUrl(r), t("Review link")); } }), rvBtn(t("open"), () => window.open(rvUrl(r), "_blank", "noopener")), rvBtn("×", () => rvDelete(r), "x", t("Delete this review link")));
    row.append(head, acts);
    box.appendChild(row);
    if (r.id !== rv.sel) continue;
    const cl = rvEl("div", "rvcomments");
    if (!r.comments.length) cl.appendChild(rvEl("div", "snote", t("No comments yet.")));
    for (const c of r.comments) {
      const line = rvEl("div", "rvc" + (c.done ? " done" : ""));
      const tb = rvBtn(rvSecs(c.at), () => rvSeek(r, c.at), "txt", t("Go there"));
      const ok = rvBtn(c.done ? "✓" : "○", () => rvResolve(r, c), "rvok", c.done ? t("Mark as open") : t("Mark as done"));
      const tx = rvEl("span", "rvct");
      tx.append(rvEl("b", "", c.name + " "), document.createTextNode(c.text));
      line.append(ok, tb, tx);
      cl.appendChild(line);
    }
    if (r.comments.some(c => !c.done)) cl.appendChild(rvBtn(t("open comments as markers"), () => rvMarks(r)));
    box.appendChild(cl);
  }
}

function rvInit() {
  ddInit($("rvDays"), RV_DAYS, rv.days, v => { rv.days = v; });
  $("rvGo").addEventListener("click", rvCreate);
}

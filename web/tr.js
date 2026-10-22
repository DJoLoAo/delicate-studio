const TR_DEF = { minGap: 1, thrAuto: true, thr: -45, count: "auto", n: 4 };
const TR_GAPS = [0.5, 1, 2, 3];
const TR_EYE = `<button type="button" class="eye" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><line class="slash" x1="4" y1="4" x2="20" y2="20"/></svg></button>`;
const tr = { cfg: null, env: null, an: null, plan: null, job: null, prog: 0, err: null, note: null, seq: 0, rel: null, opts: [], side: 0, want: null, results: null, busy: false, dc: null, made: null };

function trLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioTracks") || "null"); } catch {}
  tr.cfg = Object.assign({}, TR_DEF, v && typeof v === "object" ? v : {});
  if (!TR_GAPS.includes(tr.cfg.minGap)) tr.cfg.minGap = TR_DEF.minGap;
  tr.cfg.thr = Math.max(-80, Math.min(-20, Math.round(Number(tr.cfg.thr) || TR_DEF.thr)));
  tr.cfg.n = trCount(tr.cfg.n);
  if (!["auto", "n"].includes(tr.cfg.count)) tr.cfg.count = "auto";
}

function trSave() {
  try { localStorage.setItem("studioTracks", JSON.stringify(tr.cfg)); } catch {}
}

function trCount(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(99, n)) : TR_DEF.n;
}

function trRange() {
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function trLive() {
  const e = tr.env;
  return e && ed.doc && e.doc === ed.doc.id && e.key === audioKey() ? e : null;
}

function trErrText(m) {
  if (m === "short") return t("Select at least a second of audio.");
  if (m === "stale") return t("The file changed. Find the tracks again.");
  return m;
}

function trProg(m) {
  if (!tr.job || m.id !== tr.job.id) return;
  tr.prog = m.frac || 0;
  const bar = $("trBar");
  if (bar) bar.querySelector("i").style.width = Math.round(tr.prog * 100) + "%";
  $("trSum").textContent = t("Listening for the gaps…") + " " + Math.round(tr.prog * 100) + " %";
}

function trSpan() {
  const an = tr.an;
  return an && an.start >= 0 ? (an.end - an.start) * an.hop : 0;
}

async function trScan() {
  if (!ed.doc || tr.job) return;
  const r = trRange();
  if (r.b - r.a < ed.doc.sampleRate) { tr.err = trErrText("short"); trRender(); return; }
  const id = "tr" + (++tr.seq), key = audioKey();
  tr.job = { id };
  tr.prog = 0;
  tr.err = null;
  tr.made = null;
  trRender();
  try {
    const res = await call({ t: "trscan", id: ed.doc.id, a: r.a, b: r.b, jobId: id });
    tr.env = { doc: ed.doc.id, key, a: res.a, b: res.b, hop: res.hop, sr: res.sr, env: res.env, sel: r.sel };
    trAnalyzeNow();
    if (tr.rel) tr.side = trWant();
    trCompute();
  } catch (e) {
    const m = String(e.message || e);
    if (m !== "cancelled") tr.err = trErrText(m);
  } finally {
    tr.job = null;
    trRender();
    redraw();
  }
}

function trWant() {
  const k = tr.want ? tr.opts.findIndex(o => o.v === tr.want) : -1;
  return k >= 0 ? k : trGuess(tr.opts, trSpan());
}

function trAnalyzeNow() {
  const e = trLive(), c = tr.cfg;
  tr.an = e ? trAnalyze(e.env, { hop: e.hop / e.sr, minGap: c.minGap, thr: c.thrAuto ? NaN : c.thr }) : null;
}

function trCompute() {
  const e = trLive(), an = tr.an;
  tr.plan = null;
  tr.note = null;
  if (!e || !an) return;
  if (an.start < 0) { tr.note = t("No music found above the threshold."); return; }
  const side = tr.rel ? (tr.opts[tr.side] || tr.opts[0] || { tracks: [] }).tracks : null;
  const want = side ? side.length : tr.cfg.count === "n" ? tr.cfg.n : 0;
  let p = trPlan(an, { want, durs: side ? side.map(x => trDur(x.duration)) : [] });
  if (!p && want) {
    p = trPlan(an, {});
    tr.note = t("Only {k} tracks could be told apart, not {n}.").replace("{k}", p ? p.bounds.length - 1 : 0).replace("{n}", want);
  }
  if (!p) return;
  const nT = p.bounds.length - 1, named = side && side.length === nT, at = i => Math.min(e.b, e.a + p.bounds[i] * e.hop);
  tr.plan = { tracks: [] };
  for (let k = 0; k < nT; k++) {
    const s = named ? side[k] : null;
    tr.plan.tracks.push({ a: at(k), b: at(k + 1), pos: s ? String(s.position || "") : "", title: s ? String(s.title || "") : "", artist: s ? String(s.artist || "") : "", d: s ? trDur(s.duration) : 0, kind: k ? p.kinds[k - 1] : "start" });
  }
}

function trName(x, i) {
  const s = [x.pos, x.title].filter(Boolean).join(" ").trim();
  return s || t("Track") + " " + (i + 1);
}

function trTag(x, i) {
  const r = tr.rel;
  if (!r) return null;
  return { name: trName(x, i), pos: x.pos, title: x.title, artist: x.artist || r.artist || "", album: r.title || "", albumArtist: r.artist || "", year: r.year || "", label: r.label || "", catno: r.catno || "", country: r.country || "", genre: r.genre || "", style: r.style || "", format: r.format || "", release: r.id || "", cover: r.cover || "" };
}

function trMadeNow() {
  const m = tr.made;
  return !!m && !!ed.doc && m.doc === ed.doc.id && m.key === audioKey() && (ed.marks || []).filter(x => x.kind === "range").length === m.n;
}

async function trMake() {
  if (!tr.plan || !ed.doc || tr.job) return false;
  const old = (ed.marks || []).filter(m => m.kind === "range").length;
  if (old && !trMadeNow()) {
    const msg = old === 1 ? t("This file has 1 range. The tracks replace it.") : t("This file has {n} ranges. The tracks replace them.").replace("{n}", old);
    if (!(await ask(t("Replace the ranges?"), msg, { ok: t("Replace") }))) return false;
  }
  const tracks = tr.plan.tracks.map((x, i) => ({ a: x.a, b: x.b, name: trName(x, i), tag: trTag(x, i) }));
  const r = await runEdit({ t: "edit", op: "marktracks", tracks }, false, true);
  if (!r) return false;
  tr.made = { doc: ed.doc.id, key: audioKey(), n: tracks.length };
  flash(tracks.length === 1 ? t("1 track as a range") : t("{n} tracks as ranges").replace("{n}", tracks.length));
  trRender();
  return true;
}

async function trExport() {
  if (tr.plan && !trMadeNow() && !(await trMake())) return;
  if (!xpRanges().length) return;
  xp.cfg.range = "ranges";
  if (xp.cfg.tplRange === XP_DEFAULT.tplRange) xp.cfg.tplRange = "$range";
  const r = tr.rel;
  if (r) { const f = xpClean([r.artist, r.title].filter(Boolean).join(" - ")); if (f) xp.cfg.folder = f; }
  xpSave();
  openExport();
}

async function trDiscogs(force) {
  if (!force && tr.dc && Date.now() - tr.dc.t < 60000) return tr.dc;
  let dc = { t: Date.now(), connected: false, status: 0 };
  try {
    const r = await fetch("/api/locker/discogs", { cache: "no-store" });
    dc.status = r.status;
    if (r.ok) dc.connected = !!(await r.json()).connected;
  } catch {}
  tr.dc = dc;
  trRender();
  return dc;
}

async function trConnect() {
  const html = `<div class="dnote">${esc(t("Studio looks up releases with your own Discogs token, the same one the Locker uses. Open"))} <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">discogs.com/settings/developers</a>, ${esc(t("press “Generate new token”, copy it and paste it here. It is stored on your account only."))}</div><div class="pw"><input name="token" type="password" placeholder="${esc(t("personal access token"))}" autocomplete="off" spellcheck="false">${TR_EYE}</div>`;
  const out = await askForm(t("Connect Discogs"), html, {
    ok: t("connect"),
    setup(form) {
      const b = form.querySelector(".eye"), i = form.querySelector("input");
      b.addEventListener("click", () => { const show = i.type === "password"; i.type = show ? "text" : "password"; b.classList.toggle("on", show); b.setAttribute("aria-label", show ? t("Hide password") : t("Show password")); });
    }
  });
  const token = out && String(out.token || "").trim();
  if (!token) return false;
  const r = await fetch("/api/locker/discogs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => null);
  if (!r || !r.ok) { tell(t("Discogs rejected the token") + (r ? ": " + (await r.text()).slice(0, 120) : "")); return false; }
  return (await trDiscogs(true)).connected;
}

async function trFetch(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 412) { await trDiscogs(true); throw new Error("token"); }
  if (r.status === 401) throw new Error(t("Your session has ended. Log in again."));
  if (!r.ok) throw new Error(((await r.text()) || "").slice(0, 120) || String(r.status));
  return r.json();
}

async function trSearch() {
  const q = $("trQ").value.trim();
  if (!q || tr.busy) return;
  if (!(await trDiscogs()).connected && !(await trConnect())) return;
  tr.busy = true;
  tr.err = null;
  tr.results = null;
  trRender();
  try {
    const j = await trFetch("/api/locker/discogs/search?q=" + encodeURIComponent(q));
    const res = Array.isArray(j.results) ? j.results : [];
    if (res.length === 1 && Array.isArray(res[0].tracks)) trUse(res[0]);
    else tr.results = res;
  } catch (e) {
    if (e.message !== "token") tr.err = t("Discogs search failed") + ": " + e.message;
  } finally {
    tr.busy = false;
    trRender();
  }
}

async function trPick(id) {
  if (tr.busy) return;
  tr.busy = true;
  tr.err = null;
  trRender();
  try { trUse(await trFetch("/api/locker/discogs/release/" + encodeURIComponent(id))); }
  catch (e) { if (e.message !== "token") tr.err = t("Discogs search failed") + ": " + e.message; }
  finally { tr.busy = false; trRender(); }
}

function trSideLabel(k, tracks) {
  const d = tracks.map(x => trDur(x.duration)), tot = d.every(v => v > 0) ? d.reduce((p, q) => p + q, 0) : 0;
  const n = tracks.length === 1 ? t("1 track") : t("{n} tracks").replace("{n}", tracks.length);
  return (k ? t("Side") + " " + k : t("All tracks")) + " · " + n + (tot ? " · " + fmtDur(tot) : "");
}

function trUse(rel) {
  tr.rel = rel && typeof rel === "object" ? rel : null;
  tr.want = null;
  tr.results = null;
  const list = tr.rel && Array.isArray(tr.rel.tracks) ? tr.rel.tracks : [];
  const sides = trSides(list).filter(s => s.k);
  tr.opts = (sides.length > 1 ? sides.map(s => ({ v: s.k, tracks: s.tracks })) : []).concat([{ v: "*", tracks: list }]);
  tr.side = trGuess(tr.opts, trSpan());
  trCompute();
  trRender();
  redraw();
}

function trClear() {
  tr.rel = null;
  tr.opts = [];
  tr.side = 0;
  trCompute();
  trRender();
  redraw();
}

function trImg(u) {
  return "/api/locker/discogs/img?u=" + encodeURIComponent(u);
}

function trRenderHits() {
  const box = $("trRes"), res = tr.results;
  box.classList.toggle("hidden", !res);
  box.textContent = "";
  if (!res) return;
  if (!res.length) {
    const p = document.createElement("div");
    p.className = "snote";
    p.textContent = t("No release found. Try artist - title, the catalog number or a Discogs link.");
    box.appendChild(p);
    return;
  }
  for (const h of res.slice(0, 15)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "trhit";
    row.dataset.id = h.id;
    const img = document.createElement(h.cover ? "img" : "span");
    img.className = "trthumb";
    if (h.cover) { img.src = trImg(h.cover); img.alt = ""; img.loading = "lazy"; }
    const txt = document.createElement("span");
    txt.className = "trht";
    const b = document.createElement("b");
    b.textContent = h.title || "";
    const s = document.createElement("span");
    s.textContent = [h.year || "", h.label, h.catno, h.country, h.format].filter(Boolean).join(" · ");
    txt.append(b, s);
    row.append(img, txt);
    box.appendChild(row);
  }
}

function trRenderList() {
  const box = $("trList"), p = tr.plan;
  box.textContent = "";
  box.classList.toggle("hidden", !p);
  if (!p) return;
  p.tracks.forEach((x, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "trrow";
    row.dataset.i = i;
    const len = (x.b - x.a) / ed.doc.sampleRate, off = x.d > 0 && Math.abs(len - x.d) > Math.max(4, 0.04 * x.d);
    const cells = [[x.pos || String(i + 1), "trp"], [x.title || trName(x, i), "trt"], [fmtTime(x.a), "trs"], [fmtDur(len), "trl"], [x.d > 0 ? fmtDur(x.d) : "", "trd" + (off ? " off" : "")]];
    for (const [v, cls] of cells) { const s = document.createElement("span"); s.className = cls; s.textContent = v; row.appendChild(s); }
    if (x.kind === "dip" || x.kind === "est") row.title = t(x.kind === "dip" ? "Split where the level dips: the tracks run into each other" : "Split at the length from Discogs: no gap or dip here");
    box.appendChild(row);
  });
}

function trSummary() {
  if (tr.job) return t("Listening for the gaps…") + " " + Math.round(tr.prog * 100) + " %";
  if (tr.err) return tr.err;
  const e = trLive(), an = tr.an;
  if (!e) return tr.env ? t("The file changed. Find the tracks again.") : t("Find tracks looks for the gaps between the tracks of a side.");
  if (tr.note && !tr.plan) return tr.note;
  if (!tr.plan) return "";
  const n = tr.plan.tracks.length, parts = [n === 1 ? t("1 track") : t("{n} tracks").replace("{n}", n)];
  parts.push(t("noise floor {f} dB, music {m} dB").replace("{f}", Math.round(an.floor)).replace("{m}", Math.round(an.music)));
  if (tr.note) parts.push(tr.note);
  if (trMadeNow()) parts.push(t("ranges created"));
  return parts.join(" · ");
}

function trRender() {
  if (!$("trBody") || !tr.cfg) return;
  const c = tr.cfg, e = trLive(), rel = tr.rel, dc = tr.dc, an = tr.an;
  const r = e || trRange();
  $("trRangeT").textContent = (r.sel ? t("Selection") + " " + fmtTime(r.a) + "–" + fmtTime(r.b) : t("Whole file")) + (ed.doc ? " · " + fmtDur((r.b - r.a) / ed.doc.sampleRate) : "");
  $("trFind").textContent = t(e ? "Find again" : "Find tracks");
  $("trFind").disabled = !!tr.job;
  $("trQRow").classList.toggle("hidden", !!rel);
  $("trQ").disabled = tr.busy;
  $("trSearch").disabled = tr.busy;
  $("trDc").classList.toggle("hidden", !dc || dc.connected || dc.status === 401 || !!rel);
  trRenderHits();
  $("trRel").classList.toggle("hidden", !rel);
  if (rel) {
    const img = $("trCover");
    img.classList.toggle("hidden", !rel.cover);
    if (rel.cover && img.dataset.u !== rel.cover) { img.dataset.u = rel.cover; img.src = trImg(rel.cover); }
    $("trRelT").textContent = [rel.artist, rel.title].filter(Boolean).join(" – ");
    $("trRelI").textContent = [rel.year || "", rel.label, rel.catno, rel.country, rel.format].filter(Boolean).join(" · ");
    recDd($("trSide"), tr.opts.map((o, i) => ({ v: String(i), label: trSideLabel(o.v === "*" ? "" : o.v, o.tracks) })), String(tr.side), v => { tr.side = Number(v); trCompute(); trRender(); redraw(); });
  }
  document.querySelectorAll("#trBody .trside").forEach(el => el.classList.toggle("hidden", !rel || tr.opts.length < 2));
  document.querySelectorAll("#trBody .trnum").forEach(el => el.classList.toggle("hidden", !!rel));
  const on = (id, v) => document.querySelectorAll("#" + id + " button").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
  on("trCount", c.count);
  $("trN").classList.toggle("hidden", c.count !== "n");
  if (document.activeElement !== $("trN")) $("trN").value = c.n;
  on("trGap", c.minGap);
  on("trThrMode", c.thrAuto ? "auto" : "set");
  $("trThr").classList.toggle("hidden", c.thrAuto);
  $("trThr").value = c.thr;
  $("trThrV").textContent = (c.thrAuto ? (an ? Math.round(an.auto) : "—") : c.thr) + " dB";
  $("trSum").textContent = trSummary();
  $("trBar").classList.toggle("hidden", !tr.job);
  $("trCancel").classList.toggle("hidden", !tr.job);
  trRenderList();
  $("trMake").disabled = !tr.plan || !!tr.job;
  $("trExp").disabled = (!tr.plan && !xpRanges().length) || !!tr.job;
  $("trAlb").classList.toggle("hidden", !alOf(ed.doc && ed.doc.id));
}

function trShow() {
  trDiscogs();
  if (!trLive() && !tr.job && ed.doc) trScan(); else trRender();
}

function trHide() {}

function trDoc() {
  if (tr.job) ed.worker.postMessage({ t: "trcancel" });
  tr.env = null;
  tr.an = null;
  tr.plan = null;
  tr.err = null;
  tr.note = null;
  tr.made = null;
  tr.results = null;
  if (rp.open && rp.tab === "tr") trShow();
}

function trAfterEdit() {
  if (rp.open && rp.tab === "tr") trRender();
}

function toggleTracks() { if (rp.open && rp.tab === "tr") closeDiag(); else openRepair("tr"); }

function trPick1(i) {
  const x = tr.plan && tr.plan.tracks[i];
  if (!x) return;
  ed.sel = { a: x.a, b: x.b };
  ed.cursor = x.a;
  ensureVisible(x.a);
  clampView();
  updatePanel();
  redraw();
}

function drawTr(g, W, H, dpr) {
  if (!tr.plan || !trLive()) return;
  const v0 = ed.view.start, v1 = v0 + viewWidth() * ed.view.spp, T = tr.plan.tracks;
  g.save();
  g.font = thFont(9, dpr);
  g.textBaseline = "top";
  T.forEach((x, i) => {
    if (x.b < v0 || x.a > v1) return;
    const xa = Math.round(xOf(x.a) * dpr), xb = Math.round(xOf(x.b) * dpr), l = Math.max(0, xa), r = Math.min(W, xb);
    g.fillStyle = i % 2 ? tc("gold", 0.06) : tc("blue", 0.06);
    if (r > l) g.fillRect(l, 0, r - l, H);
    g.fillStyle = TH.gold;
    if (xa >= 0 && xa <= W) g.fillRect(xa, 0, Math.max(1, Math.round(dpr)), H);
    g.fillText(x.pos || String(i + 1), Math.max(l, xa) + 4 * dpr, 4 * dpr);
  });
  const last = T[T.length - 1];
  if (last) { const xb = Math.round(xOf(last.b) * dpr); if (xb >= 0 && xb <= W) { g.fillStyle = TH.gold; g.fillRect(xb, 0, Math.max(1, Math.round(dpr)), H); } }
  g.restore();
}

function wireTracks() {
  trLoad();
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); trSave(); trAnalyzeNow(); trCompute(); trRender(); redraw(); });
  seg("trCount", v => { tr.cfg.count = v === "n" ? "n" : "auto"; });
  seg("trGap", v => { tr.cfg.minGap = Number(v); });
  seg("trThrMode", v => { tr.cfg.thrAuto = v !== "set"; if (!tr.cfg.thrAuto && tr.an) tr.cfg.thr = Math.round(tr.an.auto); });
  $("trN").addEventListener("change", () => { tr.cfg.n = trCount($("trN").value); trSave(); trCompute(); trRender(); redraw(); });
  $("trN").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") $("trN").blur(); });
  const thr = $("trThr");
  thr.addEventListener("input", () => { tr.cfg.thr = Number(thr.value); trSave(); trAnalyzeNow(); trCompute(); trRender(); redraw(); });
  thr.addEventListener("change", () => thr.blur());
  $("trFind").addEventListener("click", trScan);
  $("trCancel").addEventListener("click", () => ed.worker.postMessage({ t: "trcancel" }));
  $("trQ").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); trSearch(); } });
  $("trSearch").addEventListener("click", trSearch);
  $("trDcBtn").addEventListener("click", trConnect);
  $("trRes").addEventListener("click", e => { const b = e.target.closest(".trhit"); if (b) trPick(b.dataset.id); });
  $("trRelX").addEventListener("click", trClear);
  $("trList").addEventListener("click", e => { const b = e.target.closest(".trrow"); if (b) trPick1(Number(b.dataset.i)); });
  $("trMake").addEventListener("click", trMake);
  $("trExp").addEventListener("click", trExport);
  $("trDefaults").addEventListener("click", () => { tr.cfg = Object.assign({}, TR_DEF); trSave(); trAnalyzeNow(); trCompute(); trRender(); redraw(); });
  document.addEventListener("i18n", () => { if (rp.open && rp.tab === "tr") trRender(); });
}

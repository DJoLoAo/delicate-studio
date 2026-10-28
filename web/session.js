const SS_HEADH = 15, SS_EDGE = 6, SS_SNAP = 8, SS_FBOX = 9, SS_PTR = 4, SS_COLORS = ["gold", "blue", "pink", "ggreen"];

const ses = { open: false, s: null, docs: new Map(), view: { start: 0, spp: 256 }, cursor: 0, sel: { a: 0, b: 0 }, clip: null, track: null, hist: [], idx: 0, drag: null, play: { on: false, start: 0, end: 0, loop: false, off: 0, t0: 0 }, loop: false, saveT: 0, mixT: 0, list: [], dirty: false, mark: null, mdrag: null, apt: null, touch: null, trim: null };

function ssLane() { return Math.round(84 * thFs()); }

function ssLin(db) { return db <= -96 ? 0 : Math.pow(10, db / 20); }
function ssAuto(tr) { if (!tr.auto || typeof tr.auto !== "object") tr.auto = { vol: [], pan: [] }; if (!Array.isArray(tr.auto.vol)) tr.auto.vol = []; if (!Array.isArray(tr.auto.pan)) tr.auto.pan = []; return tr.auto; }
function ssAutoRange(kind) { return kind === "pan" ? [-1, 1] : [SM_FLOOR, SM_TOP]; }
function ssAutoY(kind, v, r) {
  const L = ssLane(), y0 = r * L + 6, h = L - 12, [lo, hi] = ssAutoRange(kind), u = (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo);
  return kind === "pan" ? y0 + u * h : y0 + (1 - u) * h;
}
function ssAutoV(kind, y, r) {
  const L = ssLane(), y0 = r * L + 6, h = L - 12, [lo, hi] = ssAutoRange(kind), u = Math.max(0, Math.min(1, (y - y0) / h));
  const v = kind === "pan" ? lo + u * (hi - lo) : lo + (1 - u) * (hi - lo);
  return kind === "pan" ? Math.round(v * 100) / 100 : Math.round(v * 2) / 2;
}
function ssAutoBase(tr, kind) { return kind === "pan" ? tr.pan : Math.max(SM_FLOOR, tr.gain); }
function ssAutoVal(tr, kind, f) { const v = smAt(ssAuto(tr)[kind], f); return v === null ? ssAutoBase(tr, kind) : v; }
function ssRate() { return ses.s && ses.s.sr ? ses.s.sr : 48000; }
function ssLen() {
  let n = 0;
  if (ses.s) for (const tr of ses.s.tracks) for (const k of tr.clips) n = Math.max(n, k.at + k.len);
  return n;
}
function ssTotal() { return Math.max(ssLen() + ssRate() * 30, ssRate() * 60); }
function ssWidth() { return $("sesCv").clientWidth || 1; }
function ssX(f) { return (f - ses.view.start) / ses.view.spp; }
function ssF(x) { return ses.view.start + x * ses.view.spp; }

function ssClamp() {
  const W = ssWidth(), T = ssTotal();
  ses.view.spp = Math.min(Math.max(ses.view.spp, 1 / 32), Math.max(T / W, 1 / 32));
  ses.view.start = Math.min(Math.max(ses.view.start, 0), Math.max(0, T - W * ses.view.spp));
}

function ssZoomAt(factor, anchor) {
  const W = ssWidth();
  if (anchor === undefined) anchor = ses.cursor >= ses.view.start && ses.cursor <= ses.view.start + W * ses.view.spp ? ses.cursor : ses.view.start + W * ses.view.spp / 2;
  const ax = ssX(anchor);
  ses.view.spp *= factor;
  ssClamp();
  ses.view.start = anchor - ax * ses.view.spp;
  ssClamp();
  ssDraw();
}

function ssZoomFit() {
  const len = ssLen() || ssRate() * 60;
  ses.view.spp = len * 1.05 / ssWidth();
  ses.view.start = 0;
  ssClamp();
  ssDraw();
}

function ssModel(p) {
  if (!p || p.missing) return null;
  const srcs = [{ levels: poolPyr(p.meta, p.peaks, p.bands) }];
  for (const a of p.allocs) srcs[a.id] = { levels: allocPyr(a) };
  return { meta: p.meta, len: p.len, srcs, clip: { lists: p.lists, cum: p.lists.map(cumOf), edges: p.edges, len: p.len } };
}

function ssUse(p) { ses.docs.set(p.id, ssModel(p) || { missing: true, id: p.id }); }

function ssTrackOf(clipId) {
  for (const tr of ses.s.tracks) { const k = tr.clips.find(c => c.id === clipId); if (k) return { tr, k }; }
  return null;
}

function ssNewId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

function ssSnap() { return JSON.stringify(ses.s); }

function ssCommit() {
  ses.hist.length = ses.idx + 1;
  ses.hist.push(ssSnap());
  if (ses.hist.length > 200) ses.hist.shift();
  ses.idx = ses.hist.length - 1;
  ssSaveSoon();
  ssMix();
  ssHeads();
  ssButtons();
  ssDraw();
}

function ssRestore(i) {
  if (i < 0 || i >= ses.hist.length || i === ses.idx) return;
  ses.idx = i;
  ses.s = JSON.parse(ses.hist[i]);
  if (ses.clip && !ssTrackOf(ses.clip)) ses.clip = null;
  ssSaveSoon();
  ssMix();
  ssHeads();
  ssButtons();
  ssDraw();
  fxSesSync();
}

function ssDeselect() { ses.sel = { a: 0, b: 0 }; ses.clip = null; ssButtons(); ssDraw(); }

function ssUndo() { ssRestore(ses.idx - 1); }
function ssRedo() { ssRestore(ses.idx + 1); }

function ssSaveSoon() {
  clearTimeout(ses.saveT);
  ses.dirty = true;
  ses.saveT = setTimeout(ssSave, 300);
}

async function ssSave() {
  clearTimeout(ses.saveT);
  if (!ses.s || !ses.dirty) return;
  ses.dirty = false;
  try { const r = await call({ t: "sesput", s: ses.s }); if (ses.s && r.s && r.s.id === ses.s.id) ses.s.modified = r.s.modified; }
  catch (e) { tell(String(e.message || e), t("Could not save the session")); }
}

function ssMix() {
  clearTimeout(ses.mixT);
  ses.mixT = setTimeout(() => { if (ses.s) ed.worker.postMessage({ t: "sesmix", s: ses.s }); }, 30);
}

async function ssLoadList() {
  try { ses.list = (await call({ t: "seslist" })).sessions || []; } catch { ses.list = []; }
  return ses.list;
}

async function ssNew(name) {
  const r = await call({ t: "sesnew", name: name || t("New session") });
  await ssOpen(r.s.id);
  return r.s;
}

async function ssNewDlg() {
  const v = await askForm(t("New session"), `<label class="dfield"><span>${esc(t("Name"))}</span><input name="name" value="${esc(t("New session"))}" spellcheck="false" autocomplete="off"></label><div class="dnote">${esc(t("A session lays out Studio files on tracks to mix them together. The files themselves stay as they are."))}</div>`, { ok: t("create"), setup: f => requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }) });
  if (!v) return;
  await ssNew(String(v.name || "").trim() || t("New session"));
}

async function ssOpen(id) {
  if (ses.open && ses.s && ses.s.id === id) return;
  if (ses.open) await ssClose(true);
  if (ed.doc) closeDoc();
  closeFiles();
  let r;
  try { r = await call({ t: "sesopen", id }); }
  catch (e) { tell(String(e.message || e), t("Could not open the session")); return; }
  ses.s = r.s;
  ses.docs = new Map();
  for (const p of r.docs) ssUse(p);
  ses.hist = [ssSnap()];
  ses.idx = 0;
  ses.clip = null;
  ses.mark = null;
  ses.mdrag = null;
  ses.track = ses.s.tracks[0] ? ses.s.tracks[0].id : null;
  ses.sel = { a: 0, b: 0 };
  ses.cursor = 0;
  ses.open = true;
  $("empty").classList.add("hidden");
  $("ed").classList.add("hidden");
  $("ses").classList.remove("hidden");
  $("sesName").textContent = ses.s.name;
  try { localStorage.setItem("studioLastSession", id); localStorage.removeItem("studioLastDoc"); } catch {}
  ssInfo();
  ssHeads();
  ssButtons();
  requestAnimationFrame(() => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("studioSesView:" + id) || "null"); } catch {}
    if (saved && Number.isFinite(saved.spp)) { ses.view = { start: saved.start || 0, spp: saved.spp }; ses.cursor = saved.cursor || 0; ssClamp(); ssDraw(); }
    else ssZoomFit();
  });
  ed.worker.postMessage({ t: "sesmix", s: ses.s });
  const miss = r.docs.filter(p => p.missing).length;
  if (miss) flash(miss === 1 ? t("1 file of this session is no longer in Studio.") : t("{n} files of this session are no longer in Studio.").replace("{n}", miss));
}

async function ssClose(quiet) {
  if (!ses.open) return;
  fxSesClose();
  ssStop();
  pcDisarm();
  await ssSave();
  ses.open = false;
  ses.s = null;
  ses.docs = new Map();
  ses.hist = [];
  $("ses").classList.add("hidden");
  try { localStorage.removeItem("studioLastSession"); } catch {}
  call({ t: "sesclose" }).catch(() => {});
  if (!quiet && !ed.doc) $("empty").classList.remove("hidden");
}

function ssInfo() {
  const s = ses.s, n = s.tracks.length;
  const parts = [s.sr ? (s.sr / 1000).toLocaleString() + " kHz" : "", n === 1 ? t("1 track") : t("{n} tracks").replace("{n}", n), fmtDur(ssLen() / ssRate())];
  $("sesInfo").textContent = parts.filter(Boolean).join(" · ");
}

function ssButtons() {
  if (!ses.open) return;
  const set = (id, on) => { const b = $(id); if (b) b.disabled = !on; };
  set("sesUndo", ses.idx > 0);
  set("sesRedo", ses.idx < ses.hist.length - 1);
  const k = ses.clip && ssTrackOf(ses.clip);
  set("sesSplit", !!k && ses.cursor > k.k.at && ses.cursor < k.k.at + k.k.len);
  set("sesDel", !!k);
  set("sesBounce", ssLen() > 0);
  set("sesExport", ssLen() > 0);
  $("sesPlay").classList.toggle("on", ses.play.on);
  $("sesRec").classList.toggle("on", !!pc.rec);
  $("sesRec").classList.toggle("armed", !!pc.arm);
  $("sesLoop").classList.toggle("on", ses.loop);
  ssInfo();
}

function ssPlayhead() {
  if (!ses.play.on || !ed.ring) return ses.cursor;
  const sr = ssRate(), lat = ed.ctx ? Math.round(((ed.ctx.outputLatency || 0) + (ed.ctx.baseLatency || 0)) * sr) : 0;
  const r = Math.max(0, Atomics.load(ed.ring.ctrl, 2) - lat), len = ses.play.end - ses.play.start;
  return ses.play.loop ? ses.play.start + ((r + ses.play.off) % len) : Math.min(ses.play.end, ses.play.start + r);
}

async function ssPlay(from) {
  if (!ses.open || !ses.s.sr || pc.rec || pc.busy) return;
  const L = ssLen();
  if (!L) return;
  await ensureAudioFor(ses.s.sr, 2);
  const sel = ses.sel.b > ses.sel.a;
  let pos = Math.floor(from !== undefined ? from : sel ? ses.sel.a : ses.cursor), rs = 0, re = L, loop = ses.loop;
  if (sel && pos >= ses.sel.a && pos < ses.sel.b) { rs = ses.sel.a; re = ses.sel.b; } else if (sel) loop = false;
  if (pos >= re - 1) pos = rs;
  if (!loop) rs = pos;
  if (re - rs < 1) return;
  Atomics.store(ed.ring.ctrl, 0, 0);
  ses.play = { on: true, start: rs, end: re, loop, off: loop ? pos - rs : 0, t0: performance.now() };
  ed.worker.postMessage({ t: "sesplay", start: rs, end: re, loop, off: ses.play.off });
  ssButtons();
  if (!ses.ticking) { ses.ticking = true; ssTick(); }
}

function ssStop(keep) {
  if (!ses.play.on) return;
  const pos = ssPlayhead();
  pcEnd(pos);
  ses.play.on = false;
  if (ed.ring) Atomics.store(ed.ring.ctrl, 0, 0);
  ed.worker.postMessage({ t: "stop" });
  if (keep === "here") ses.cursor = Math.floor(pos);
  ssButtons();
  ssDraw();
}

function ssToggle() { if (ses.play.on) ssStop(); else ssPlay(); }

function ssTick() {
  if (!ses.play.on || !ses.open) { ses.ticking = false; ssDraw(); return; }
  const st = Atomics.load(ed.ring.ctrl, 0);
  if (st === 1) ses.play.seen = true;
  if (st === 2 || (st === 0 && ses.play.seen)) { ses.ticking = false; ssStop(); return; }
  if (st === 0 && performance.now() - ses.play.t0 > 2000) { ses.ticking = false; ssStop(); tell(t("Playback did not start.")); return; }
  const ph = ssPlayhead(), W = ssWidth(), vis = W * ses.view.spp;
  pcTick(ph);
  if (!ses.drag && (ph > ses.view.start + vis * 0.98 || ph < ses.view.start)) { ses.view.start = ph - vis * 0.02; ssClamp(); }
  ssDraw();
  ssFollow(ph);
  $("sesNow").textContent = fmtTime(ph);
  requestAnimationFrame(ssTick);
}

function ssHome() { ses.cursor = 0; ses.view.start = 0; ssClamp(); if (ses.play.on) ssPlay(0); ssDraw(); }
function ssEnd() { ses.cursor = ssLen(); ssStop(); ssEnsure(ses.cursor); ssDraw(); }
function ssLoopToggle() { ses.loop = !ses.loop; if (ses.play.on) ssPlay(); ssButtons(); }

function ssEnsure(f) {
  const vis = ssWidth() * ses.view.spp;
  if (f < ses.view.start || f > ses.view.start + vis) { ses.view.start = f - vis * 0.25; ssClamp(); }
}

let ssRaf = 0;
function ssDraw() {
  if (ssRaf || !ses.open) return;
  ssRaf = requestAnimationFrame(() => { ssRaf = 0; if (ses.open) ssRender(); });
}

function ssRender() {
  ssButtons();
  ssRuler();
  ssLanes();
  if (!ses.play.on) { $("sesNow").textContent = fmtTime(ses.cursor); ssFollow(ses.cursor); }
  $("sesLen").textContent = "/ " + fmtTime(ssLen());
  try { localStorage.setItem("studioSesView:" + ses.s.id, JSON.stringify({ start: ses.view.start, spp: ses.view.spp, cursor: ses.cursor })); } catch {}
}

function ssRuler() {
  const cv = $("sesRu"), dpr = canvasFit(cv), g = cv.getContext("2d"), k = dpr * thFs(), W = cv.width, H = cv.height, T = H - MARK_LANE * k;
  g.fillStyle = TH.panel;
  g.fillRect(0, 0, W, H);
  g.fillStyle = TH.canvas;
  g.fillRect(0, T, W, H - T);
  if (ses.sel.b > ses.sel.a) {
    const a = ssX(ses.sel.a) * dpr, b = ssX(ses.sel.b) * dpr;
    g.fillStyle = tc("gold", 0.22);
    g.fillRect(a, 0, Math.max(1, b - a), T);
  }
  const st = tickStepFor(ses.view.spp, ssRate()), a0 = ses.view.start, a1 = a0 + cv.clientWidth * ses.view.spp;
  g.fillStyle = TH.tick;
  for (let f = Math.ceil(a0 / st.minor) * st.minor; f <= a1; f += st.minor) g.fillRect(Math.round(ssX(f) * dpr), T - 5 * k, Math.max(1, dpr), 5 * k);
  g.font = thFont(9.5, dpr);
  g.textBaseline = "top";
  g.textAlign = "left";
  for (let f = Math.ceil(a0 / st.major) * st.major; f <= a1; f += st.major) {
    const x = Math.round(ssX(f) * dpr);
    g.fillStyle = TH.label2;
    g.fillRect(x, T - 10 * k, Math.max(1, dpr), 10 * k);
    g.fillStyle = TH.muted;
    g.fillText(fmtTime(f, ed.fmt, st.sec), x + 3 * k, 3 * k);
  }
  g.fillStyle = TH.line;
  g.fillRect(0, T - dpr, W, dpr);
  g.fillRect(0, H - dpr, W, dpr);
  ssMarkLane(g, W, T, H, dpr);
  const cx = ssX(ses.cursor) * dpr;
  g.fillStyle = TH.gold;
  g.beginPath(); g.moveTo(cx - 5 * k, 0); g.lineTo(cx + 5 * k, 0); g.lineTo(cx, 7 * k); g.fill();
}

function ssMarks() {
  const d = ses.mdrag;
  return ((ses.s && ses.s.marks) || []).map((m, i) => ({ m, n: i + 1, at: d && d.id === m.id ? d.at : m.at }));
}

function ssMarkText(b) { return b.m.name ? b.n + "  " + b.m.name : String(b.n); }

function ssMarkBoxes(g, dpr) {
  g.font = thFont(8.5, dpr);
  const L = ssMarks().map(b => Object.assign(b, { x: ssX(b.at) * dpr })).sort((a, b) => a.x - b.x), pad = 6 * dpr * thFs();
  return L.map((b, i) => {
    const nw = g.measureText(String(b.n)).width + pad, room = i + 1 < L.length ? L[i + 1].x - b.x - 2 * dpr : Infinity;
    return Object.assign(b, { w: Math.max(nw, Math.min(g.measureText(ssMarkText(b)).width + pad, room)) });
  });
}

function ssMarkLane(g, W, T, H, dpr) {
  for (const b of ssMarkBoxes(g, dpr)) {
    if (b.x > W || b.x + b.w < 0) continue;
    g.fillStyle = ses.mark === b.m.id ? TH.ink : TH.blue;
    g.fillRect(Math.round(b.x), T, Math.max(1, dpr), H - T);
    g.fillRect(Math.round(b.x), T + dpr, b.w, H - T - 2 * dpr);
    g.save();
    g.beginPath();
    g.rect(b.x, T, b.w, H - T);
    g.clip();
    g.fillStyle = TH.dark;
    g.textBaseline = "middle";
    g.textAlign = "left";
    g.fillText(ssMarkText(b), b.x + 3 * dpr, T + (H - T) / 2 + 0.5 * dpr);
    g.restore();
  }
}

function ssMarkAt(x, y) {
  const cv = $("sesRu");
  if (y < cv.clientHeight - MARK_LANE * thFs() - 2) return null;
  for (const b of ssMarkBoxes(cv.getContext("2d"), 1).reverse()) if (x >= b.x - 4 && x <= b.x + b.w) return b;
  return null;
}

function ssMarkAdd() {
  if (!ses.open) return;
  const at = Math.max(0, Math.round(ses.play.on ? ssPlayhead() : ses.cursor));
  if (!ses.s.marks) ses.s.marks = [];
  if (ses.s.marks.some(k => k.at === at)) return;
  const m = { id: ssNewId(), at, name: "" };
  ses.s.marks.push(m);
  ses.s.marks.sort((a, b) => a.at - b.at);
  ses.mark = m.id;
  ssCommit();
}

async function ssMarkRename(id) {
  const i = (ses.s.marks || []).findIndex(k => k.id === id);
  if (i < 0) return;
  const v = await askText(t("Rename location") + " " + (i + 1), ses.s.marks[i].name || "");
  if (v === null || v === undefined || !ses.open) return;
  const m = (ses.s.marks || []).find(k => k.id === id);
  if (!m) return;
  m.name = String(v).trim().slice(0, 160);
  ssCommit();
}

function ssMarkDel(id) {
  if (!ses.open || !(ses.s.marks || []).some(k => k.id === id)) return;
  ses.s.marks = ses.s.marks.filter(k => k.id !== id);
  if (ses.mark === id) ses.mark = null;
  ssCommit();
}

function ssMarkStep(dir) {
  if (!ses.open) return;
  const pos = ses.play.on ? ssPlayhead() : ses.cursor, L = (ses.s.marks || []).map(k => k.at);
  const to = dir > 0 ? L.find(a => a > pos + 0.5) : L.filter(a => a < pos - ssRate() * (ses.play.on ? 0.5 : 0) - 0.5).pop();
  if (to === undefined) return;
  ses.cursor = to;
  ssEnsure(to);
  if (ses.play.on) ssPlay(to);
  ssDraw();
}

function ssFade(k, q) {
  let f = 1;
  if (k.fin > 0 && q < k.fin) f *= fadeGain(q / Math.max(1, k.fin - 1), "lin", 0);
  if (k.fout > 0 && q >= k.len - k.fout) f *= fadeGain((k.len - 1 - q) / Math.max(1, k.fout - 1), "lin", 0);
  return f;
}

function ssShown(tr, k) {
  const d = ses.drag;
  if (d && d.id === k.id && d.cur) return d.cur;
  return k;
}

function ssLanes() {
  const s = ses.s, cv = $("sesCv"), rows = Math.max(1, s.tracks.length);
  cv.style.height = rows * ssLane() + "px";
  const dpr = canvasFit(cv), g = cv.getContext("2d"), W = cv.width, H = cv.height, L = ssLane() * dpr;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  s.tracks.forEach((tr, r) => {
    g.fillStyle = r % 2 ? TH.laneA : TH.laneB;
    g.fillRect(0, r * L, W, L);
    if (tr.id === ses.track) { g.fillStyle = tw(0.03); g.fillRect(0, r * L, W, L); }
    g.fillStyle = tw(0.1);
    g.fillRect(0, (r + 1) * L - dpr, W, dpr);
  });
  if (ses.sel.b > ses.sel.a) {
    const a = Math.max(0, ssX(ses.sel.a) * dpr), b = Math.min(W, ssX(ses.sel.b) * dpr);
    g.fillStyle = tw(0.07);
    g.fillRect(a, 0, Math.max(1, b - a), H);
  }
  const d = ses.drag;
  s.tracks.forEach((tr, r) => {
    const shown = [];
    for (const k0 of tr.clips) {
      if (d && d.id === k0.id && d.row !== undefined && d.row !== r) continue;
      shown.push([ssShown(tr, k0), r]);
    }
    if (d && d.cur && d.row === r && !tr.clips.some(k => k.id === d.id)) shown.push([d.cur, d.srcRow]);
    const xf = smXfades(shown.map(x => x[0]));
    for (const [k, cr] of shown) ssClip(g, k, r, dpr, W, cr, xf.get(k.id));
    if (tr.view) ssAutoDraw(g, tr, r, dpr, W);
  });
  if (!s.tracks.length) {
    g.fillStyle = TH.muted;
    g.font = thFont(11, dpr);
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(t("Add files to start: each file becomes a track."), 14 * dpr, L / 2);
  }
  g.fillStyle = tc("blue", 0.4);
  for (const b of ssMarks()) { const x = Math.round(ssX(b.at) * dpr); if (x >= 0 && x <= W) g.fillRect(x, 0, Math.max(1, dpr), H); }
  pcDraw(g, dpr, W, H);
  const cx = Math.round(ssX(ses.cursor) * dpr);
  if (cx >= 0 && cx <= W) { g.fillStyle = TH.gold; g.fillRect(cx, 0, Math.max(1, dpr), H); }
  if (ses.play.on) {
    const px = Math.round(ssX(ssPlayhead()) * dpr);
    if (px >= 0 && px <= W) { g.fillStyle = TH.ink; g.fillRect(px, 0, Math.max(1, dpr), H); }
  }
}

function ssAutoDraw(g, tr, r, dpr, W) {
  const kind = tr.view, pts = ssAuto(tr)[kind], L = ssLane() * dpr, top = r * L;
  g.save();
  g.globalAlpha = 0.55;
  g.fillStyle = TH.canvas;
  g.fillRect(0, top, W, L - dpr);
  g.globalAlpha = 1;
  const ref = ssAutoY(kind, 0, r) * dpr;
  g.fillStyle = tw(0.14);
  for (let x = 0; x < W; x += 6 * dpr) g.fillRect(x, Math.round(ref), 3 * dpr, Math.max(1, dpr));
  const col = kind === "pan" ? tc("blue", 0.95) : tc("pink", 0.95);
  g.strokeStyle = col;
  g.lineWidth = Math.max(1.5, 1.5 * dpr);
  if (!pts.length) g.setLineDash([5 * dpr, 4 * dpr]);
  g.beginPath();
  for (let x = 0; x <= W; x += 2 * dpr) {
    const y = ssAutoY(kind, ssAutoVal(tr, kind, ssF(x / dpr)), r) * dpr;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.setLineDash([]);
  const P = SS_PTR * dpr;
  pts.forEach((q, i) => {
    const x = ssX(q[0]) * dpr;
    if (x < -P || x > W + P) return;
    const y = ssAutoY(kind, q[1], r) * dpr, on = ses.apt && ses.apt.tr === tr.id && ses.apt.i === i;
    g.fillStyle = on ? TH.gold : col;
    g.fillRect(x - P, y - P, P * 2, P * 2);
  });
  g.fillStyle = col;
  g.font = thFont(9, dpr);
  g.textAlign = "left";
  g.textBaseline = "bottom";
  g.fillText((kind === "pan" ? t("Pan automation") + " · L ↑ R ↓" : t("Volume automation")) + (pts.length ? "" : " · " + t("click to add a point")), 6 * dpr, top + L - 5 * dpr);
  g.restore();
}

function ssClip(g, k, r, dpr, W, colorRow, x) {
  x = x || { xi: 0, xo: 0 };
  const L = ssLane() * dpr, y0 = r * L + 2 * dpr, h = L - 4 * dpr;
  const x0 = ssX(k.at) * dpr, x1 = ssX(k.at + k.len) * dpr;
  if (x1 < 0 || x0 > W) return;
  const col = SS_COLORS[colorRow % SS_COLORS.length], sel = ses.clip === k.id, M = ses.docs.get(k.doc);
  const a = Math.max(0, x0), b = Math.min(W, x1);
  g.fillStyle = tc(col, sel ? 0.2 : 0.11);
  g.fillRect(a, y0, Math.max(1, b - a), h);
  const hh = SS_HEADH * dpr;
  g.fillStyle = tc(col, sel ? 0.42 : 0.26);
  g.fillRect(a, y0, Math.max(1, b - a), hh);
  if (M && !M.missing) {
    const mid = y0 + hh + (h - hh) / 2, A = (h - hh) / 2 - 3 * dpr, ch = M.meta.channels, gk = ssLin(k.gain), acc = accNew();
    g.fillStyle = tc(col, 0.85);
    for (let px = Math.floor(a); px < b; px++) {
      const s0 = Math.max(k.at, ssF(px / dpr)), s1 = Math.min(k.at + k.len, ssF((px + 1) / dpr));
      if (s1 <= s0) continue;
      const u0 = k.from + (s0 - k.at), u1 = Math.min(M.len, k.from + (s1 - k.at));
      if (u1 <= u0) continue;
      accReset(acc);
      for (let c = 0; c < ch; c++) colPeakOf(M, c, u0, Math.max(u0 + 1, u1), acc);
      if (acc.mx === -Infinity) continue;
      const q = Math.round((s0 + s1) / 2 - k.at), f = gk * ssFade(k, q) * smXin(q, x.xi) * smXout(q, k.len, x.xo);
      let y1 = mid - Math.max(-1, Math.min(1, acc.mx * f)) * A, y2 = mid - Math.max(-1, Math.min(1, acc.mn * f)) * A;
      if (y2 - y1 < 1) { const ym = (y1 + y2) / 2; y1 = ym - 0.5; y2 = ym + 0.5; }
      g.fillRect(px, y1, 1, y2 - y1);
    }
  } else {
    g.fillStyle = tc("peak", 0.3);
    for (let x = Math.floor(a / (8 * dpr)) * 8 * dpr; x < b; x += 8 * dpr) g.fillRect(x, y0 + hh, Math.max(1, dpr), h - hh);
  }
  g.strokeStyle = tc(col, 0.95);
  g.lineWidth = Math.max(1, dpr);
  if (k.fin > 0) { const xf = ssX(k.at + k.fin) * dpr; g.beginPath(); g.moveTo(x0, y0 + h); g.lineTo(xf, y0 + hh); g.stroke(); }
  if (k.fout > 0) { const xf = ssX(k.at + k.len - k.fout) * dpr; g.beginPath(); g.moveTo(xf, y0 + hh); g.lineTo(x1, y0 + h); g.stroke(); }
  const curve = (f0, n, fn) => { g.beginPath(); for (let i = 0; i <= 24; i++) { const q = i / 24, xx = ssX(f0 + q * n) * dpr, yy = y0 + h - fn(q) * (h - hh); if (i) g.lineTo(xx, yy); else g.moveTo(xx, yy); } g.stroke(); };
  if (x.xi) curve(k.at, x.xi, q => Math.sin(q * Math.PI / 2));
  if (x.xo) curve(k.at + k.len - x.xo, x.xo, q => Math.cos(q * Math.PI / 2));
  g.strokeStyle = sel ? TH.gold : tc(col, 0.5);
  g.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, x1 - x0 - 1), h - 1);
  g.save();
  g.beginPath();
  g.rect(a, y0, Math.max(1, b - a), hh);
  g.clip();
  g.fillStyle = TH.ink;
  g.font = thFont(9.5, dpr);
  g.textAlign = "left";
  g.textBaseline = "middle";
  const gain = Math.abs(k.gain) >= 0.05 ? "  " + (k.gain > 0 ? "+" : "−") + Math.abs(k.gain).toFixed(1) + " dB" : "";
  g.fillText((M && M.missing ? t("Missing file") + " · " : "") + (k.name || "") + gain, Math.max(x0, 0) + 5 * dpr, y0 + hh / 2);
  g.restore();
  if (sel) {
    const bx = SS_FBOX * dpr;
    g.fillStyle = TH.gold;
    g.fillRect(ssX(k.at + k.fin) * dpr - (k.fin ? bx / 2 : 0), y0 + hh, bx, bx);
    g.fillRect(ssX(k.at + k.len - k.fout) * dpr - (k.fout ? bx / 2 : bx), y0 + hh, bx, bx);
  }
}

function ssHit(x, y) {
  const s = ses.s, r = Math.floor(y / ssLane());
  if (r < 0 || r >= s.tracks.length) return { row: r };
  const tr = s.tracks[r];
  for (let i = tr.clips.length - 1; i >= 0; i--) {
    const k = tr.clips[i], x0 = ssX(k.at), x1 = ssX(k.at + k.len);
    if (x < x0 - 1 || x > x1 + 1) continue;
    const yy = y - r * ssLane() - 2;
    if (ses.clip === k.id && yy >= SS_HEADH && yy <= SS_HEADH + SS_FBOX + 2) {
      const fi = ssX(k.at + k.fin), fo = ssX(k.at + k.len - k.fout);
      if (Math.abs(x - fi) <= SS_FBOX || (k.fin === 0 && x >= x0 && x <= x0 + SS_FBOX)) return { row: r, tr, k, part: "fin" };
      if (Math.abs(x - fo) <= SS_FBOX || (k.fout === 0 && x <= x1 && x >= x1 - SS_FBOX)) return { row: r, tr, k, part: "fout" };
    }
    if (x - x0 < SS_EDGE && x1 - x0 > SS_EDGE * 3) return { row: r, tr, k, part: "l" };
    if (x1 - x < SS_EDGE && x1 - x0 > SS_EDGE * 3) return { row: r, tr, k, part: "r" };
    return { row: r, tr, k, part: "move" };
  }
  return { row: r, tr };
}

function ssEdges(skip) {
  const out = [0, ses.cursor];
  for (const tr of ses.s.tracks) for (const k of tr.clips) if (k.id !== skip) out.push(k.at, k.at + k.len);
  return out;
}

function ssSnapDelta(id, starts, dx, free) {
  if (free) return dx;
  const tol = SS_SNAP * ses.view.spp, E = ssEdges(id);
  let best = null;
  for (const p of starts) for (const e of E) { const d = e - (p + dx); if (Math.abs(d) <= tol && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
  return best === null ? dx : dx + best;
}

function ssMinLen() { return Math.max(1, Math.round(ssRate() * 0.01)); }

function ssDocLen(k) { const M = ses.docs.get(k.doc); return M && !M.missing ? M.len : k.from + k.len; }

function ssAutoHit(tr, row, x, y) {
  const pts = ssAuto(tr)[tr.view];
  for (let i = pts.length - 1; i >= 0; i--) if (Math.abs(ssX(pts[i][0]) - x) <= SS_PTR + 2 && Math.abs(ssAutoY(tr.view, pts[i][1], row) - y) <= SS_PTR + 2) return i;
  return -1;
}

function ssAutoDown(e, tr, row, x, y) {
  const cv = $("sesCv"), kind = tr.view, pts = ssAuto(tr)[kind];
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  ses.track = tr.id;
  let i = ssAutoHit(tr, row, x, y), added = false;
  if (i >= 0 && e.altKey) { pts.splice(i, 1); ses.apt = null; ssCommit(); return; }
  if (i < 0) {
    const f = Math.max(0, Math.round(ssF(x))), v = ssAutoV(kind, y, row), j = pts.findIndex(q => q[0] >= f);
    if (j >= 0 && pts[j][0] === f) { pts[j][1] = v; i = j; }
    else { i = j < 0 ? pts.length : j; pts.splice(i, 0, [f, v]); }
    added = true;
    ssMix();
  }
  ses.apt = { tr: tr.id, i };
  ses.drag = { kind: "apt", tr: tr.id, auto: kind, i, row, x0: x, y0: y, orig: pts[i].slice(), added, moved: false };
  ssHeads();
  ssDraw();
}

function ssDown(e) {
  if (!ses.open || e.button > 0) return;
  const cv = $("sesCv"), r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const ar = Math.floor(y / ssLane()), atr = ses.s.tracks[ar];
  if (atr && atr.view) { ssAutoDown(e, atr, ar, x, y); return; }
  ses.apt = null;
  const h = ssHit(x, y);
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  if (h.tr) ses.track = h.tr.id;
  if (!h.k) {
    ses.clip = null;
    const f = Math.max(0, Math.round(ssF(x)));
    ses.drag = { kind: "sel", anchor: f, x0: x, moved: false };
    ssHeads();
    ssButtons();
    ssDraw();
    return;
  }
  ses.clip = h.k.id;
  ses.drag = { kind: h.part, id: h.k.id, x0: x, y0: y, orig: Object.assign({}, h.k), cur: Object.assign({}, h.k), row: h.row, srcRow: h.row, moved: false };
  ssHeads();
  ssButtons();
  ssDraw();
}

function ssMove(e) {
  if (!ses.open) return;
  const cv = $("sesCv"), r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, d = ses.drag;
  if (!d) {
    const ar = Math.floor(y / ssLane()), atr = ses.s.tracks[ar];
    if (atr && atr.view) { cv.style.cursor = ssAutoHit(atr, ar, x, y) >= 0 ? "move" : "crosshair"; return; }
    const h = ssHit(x, y);
    cv.style.cursor = !h.k ? "text" : h.part === "l" || h.part === "r" ? "ew-resize" : h.part === "fin" || h.part === "fout" ? "col-resize" : "grab";
    return;
  }
  if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - (d.y0 || 0)) < 3) return;
  d.moved = true;
  if (d.kind === "apt") {
    const tr = ses.s.tracks.find(q => q.id === d.tr);
    if (!tr) return;
    const pts = ssAuto(tr)[d.auto], i = d.i, lo = i > 0 ? pts[i - 1][0] + 1 : 0, hi = i + 1 < pts.length ? pts[i + 1][0] - 1 : Infinity;
    pts[i] = [Math.max(lo, Math.min(hi, Math.round(ssF(x)))), ssAutoV(d.auto, y, d.row)];
    ssMix();
    ssHeads();
    ssDraw();
    return;
  }
  if (d.kind === "sel") {
    const f = Math.max(0, Math.round(ssF(x)));
    ses.sel = { a: Math.min(d.anchor, f), b: Math.max(d.anchor, f) };
    ssDraw();
    return;
  }
  const o = d.orig, dx = Math.round((x - d.x0) * ses.view.spp), min = ssMinLen(), c = d.cur, free = e.altKey;
  if (d.kind === "move") {
    let nd = ssSnapDelta(o.id, [o.at, o.at + o.len], dx, free);
    c.at = Math.max(0, o.at + nd);
    d.row = Math.max(0, Math.min(ses.s.tracks.length - 1, Math.floor(y / ssLane())));
    cv.style.cursor = "grabbing";
  } else if (d.kind === "l") {
    let nd = ssSnapDelta(o.id, [o.at], dx, free);
    nd = Math.max(-o.from, Math.min(o.len - min, nd));
    if (o.at + nd < 0) nd = -o.at;
    c.at = o.at + nd; c.from = o.from + nd; c.len = o.len - nd;
  } else if (d.kind === "r") {
    let nd = ssSnapDelta(o.id, [o.at + o.len], dx, free);
    nd = Math.max(min - o.len, Math.min(ssDocLen(o) - o.from - o.len, nd));
    c.len = o.len + nd;
  } else if (d.kind === "fin") {
    c.fin = Math.max(0, Math.min(c.len - c.fout, Math.round(ssF(x) - c.at)));
  } else if (d.kind === "fout") {
    c.fout = Math.max(0, Math.min(c.len - c.fin, Math.round(c.at + c.len - ssF(x))));
  }
  c.fin = Math.min(c.fin, c.len);
  c.fout = Math.min(c.fout, c.len - c.fin);
  ssDraw();
}

function ssUp(e) {
  const d = ses.drag;
  if (!d) return;
  ses.drag = null;
  if (d.kind === "apt") {
    const tr = ses.s.tracks.find(q => q.id === d.tr);
    if (tr && e.type === "pointercancel") {
      const pts = ssAuto(tr)[d.auto];
      if (d.added) pts.splice(d.i, 1); else pts[d.i] = d.orig;
      ses.apt = null;
      ssMix();
      ssDraw();
      return;
    }
    if (d.moved || d.added) ssCommit(); else ssDraw();
    return;
  }
  if (d.kind === "sel") {
    if (!d.moved) { ses.sel = { a: 0, b: 0 }; ses.cursor = d.anchor; if (ses.play.on) ssPlay(ses.cursor); }
    ssButtons();
    ssDraw();
    return;
  }
  if (e.type === "pointercancel") { ssDraw(); return; }
  if (!d.moved) {
    ses.cursor = Math.max(0, Math.round(ssF(d.x0)));
    if (ses.play.on) ssPlay(ses.cursor);
    ssButtons();
    ssDraw();
    return;
  }
  const hit = ssTrackOf(d.id);
  if (!hit) { ssDraw(); return; }
  Object.assign(hit.k, { at: d.cur.at, from: d.cur.from, len: d.cur.len, fin: d.cur.fin, fout: d.cur.fout });
  if (d.kind === "move" && d.row !== d.srcRow) {
    const to = ses.s.tracks[d.row];
    hit.tr.clips = hit.tr.clips.filter(k => k !== hit.k);
    to.clips.push(hit.k);
    to.clips.sort((a, b) => a.at - b.at);
    ses.track = to.id;
  } else hit.tr.clips.sort((a, b) => a.at - b.at);
  ssCommit();
}

function ssWheel(e) {
  if (!ses.open) return;
  e.preventDefault();
  const r = $("sesCv").getBoundingClientRect(), x = e.clientX - r.left;
  const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (horizontal) { ses.view.start += (e.deltaX || e.deltaY) * ses.view.spp; ssClamp(); ssDraw(); return; }
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  ssZoomAt(Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), ssF(x));
}

function ssSplit() {
  const hit = ses.clip && ssTrackOf(ses.clip);
  if (!hit) return;
  const k = hit.k, p = Math.round(ses.cursor) - k.at;
  if (p <= 0 || p >= k.len) { flash(t("Put the cursor inside the clip to split it.")); return; }
  const right = Object.assign({}, k, { id: ssNewId(), at: k.at + p, from: k.from + p, len: k.len - p, fin: 0, fout: Math.min(k.fout, k.len - p) });
  k.len = p;
  k.fout = 0;
  k.fin = Math.min(k.fin, p);
  hit.tr.clips.push(right);
  hit.tr.clips.sort((a, b) => a.at - b.at);
  ses.clip = right.id;
  ssCommit();
}

function ssDelete() {
  const hit = ses.clip && ssTrackOf(ses.clip);
  if (!hit) return;
  hit.tr.clips = hit.tr.clips.filter(k => k !== hit.k);
  ses.clip = null;
  ssCommit();
}

async function ssClipGain() {
  const hit = ses.clip && ssTrackOf(ses.clip);
  if (!hit) return;
  const v = await askForm(t("Clip gain"), `<label class="dfield"><span>${esc(t("Gain (dB)"))}</span><input name="g" value="${esc(String(hit.k.gain))}" spellcheck="false" autocomplete="off" inputmode="decimal"></label>`, { ok: t("apply"), setup: f => requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }) });
  if (!v) return;
  const g = Number(String(v.g).replace(",", "."));
  if (!Number.isFinite(g)) return;
  const k = ssTrackOf(hit.k.id);
  if (!k) return;
  k.k.gain = Math.max(-96, Math.min(24, Math.round(g * 10) / 10));
  ssCommit();
}

function ssTrackName(n) { return t("Track") + " " + n; }

async function ssAddDlg() {
  if (!ses.open) return;
  let docs = [];
  try { docs = (await call({ t: "list" })).docs.filter(d => !d.recording); } catch {}
  if (!docs.length) { tell(t("There are no files in Studio yet. Open or record one first.")); return; }
  const rows = docs.map(d => `<label class="sesdoc"><input type="checkbox" name="d_${esc(d.id)}"><span class="sdn">${esc(d.name)}</span><span class="sdi">${esc(((d.sampleRate || 0) / 1000).toLocaleString() + " kHz · " + (d.channels === 1 ? t("mono") : d.channels === 2 ? t("stereo") : d.channels + " ch") + " · " + fmtDur((d.len || d.frames || 0) / (d.sampleRate || 48000)))}</span></label>`).join("");
  const v = await askForm(t("Add files to the session"), `<div class="sesdocs">${rows}</div><div class="dnote">${esc(t("Each file becomes a new track, starting at the cursor."))}</div>`, { ok: t("add") });
  if (!v) return;
  const ids = docs.filter(d => v["d_" + d.id] === "on" || v["d_" + d.id] === true).map(d => d.id);
  for (const id of ids) await ssAddDoc(id);
}

async function ssAddDoc(id, at) {
  let p;
  try { p = (await call({ t: "sesdoc", id })).doc; } catch (e) { tell(String(e.message || e), t("Could not add the file")); return null; }
  if (p.missing) return null;
  if (ses.s.sr && p.meta.sampleRate !== ses.s.sr) {
    const ok = await ask(t("Different sample rate"), t("This session runs at {a} kHz and the file is at {b} kHz. Make a {a} kHz copy of the file for the session? The original stays as it is.").replaceAll("{a}", (ses.s.sr / 1000).toLocaleString()).replace("{b}", (p.meta.sampleRate / 1000).toLocaleString()), { ok: t("make a copy") });
    if (!ok) return null;
    let r;
    try { r = await ssConvert(p.id, ses.s.sr); } catch (e) { if ((e && e.message) !== "cancelled") tell(String(e.message || e), t("Could not convert the file")); return null; }
    p = (await call({ t: "sesdoc", id: r.meta.id })).doc;
  }
  ssUse(p);
  if (!ses.s.sr) ses.s.sr = p.meta.sampleRate;
  const tr = { id: ssNewId(), name: (p.meta.name || "").replace(/\.[^.]+$/, "") || ssTrackName(ses.s.tracks.length + 1), gain: 0, pan: 0, mute: false, solo: false, clips: [] };
  tr.clips.push({ id: ssNewId(), doc: p.id, at: Math.max(0, Math.round(at !== undefined ? at : ses.cursor)), from: 0, len: p.len, gain: 0, fin: 0, fout: 0, name: p.meta.name });
  ses.s.tracks.push(tr);
  ses.track = tr.id;
  ssCommit();
  if (ses.s.tracks.length === 1) ssZoomFit();
  return tr;
}

async function ssConvert(id, sr) {
  const jobId = "c" + Date.now();
  ses.conv = { id: jobId, frac: 0 };
  try { return await call({ t: "sesconv", id, sr, jobId }); }
  finally { ses.conv = null; $("stMsg").textContent = ""; }
}

function ssProg(m) {
  if (djProg(m)) return;
  if (ses.conv && m.id === ses.conv.id) { clearTimeout(ed.flashT); $("stMsg").textContent = t("Converting") + " · " + Math.round(m.frac * 100) + " %"; }
  if (ses.bounce && m.id === ses.bounce.id) { clearTimeout(ed.flashT); $("stMsg").textContent = t("Mixing down") + " · " + Math.round(m.frac * 100) + " %"; }
}

async function ssBounce(thenExport) {
  if (!ses.open || !ssLen()) return;
  await ssSave();
  const sel = ses.sel.b > ses.sel.a, jobId = "b" + Date.now();
  ses.bounce = { id: jobId };
  let r;
  try { r = await call({ t: "sesbounce", jobId, a: sel ? ses.sel.a : 0, b: sel ? ses.sel.b : ssLen(), name: ses.s.name + " (" + t("mix") + ")" }); }
  catch (e) { if ((e && e.message) !== "cancelled") tell(String(e.message || e), t("Could not mix down")); return; }
  finally { ses.bounce = null; $("stMsg").textContent = ""; }
  if (r.peak > 1) flash(t("The mix goes over full scale by {d} dB. Turn some tracks down, or use the limiter when exporting.").replace("{d}", (20 * Math.log10(r.peak)).toFixed(1)));
  await ssClose(true);
  await openDoc(r.meta.id);
  refreshFiles();
  if (thenExport) openExport();
  else if (!(r.peak > 1)) flash(t("Mixed down to a new file") + ": " + r.meta.name);
}

function ssHeads() {
  if (!ses.open) return;
  const box = $("sesHeads");
  box.innerHTML = "";
  box.style.height = Math.max(1, ses.s.tracks.length) * ssLane() + "px";
  ses.s.tracks.forEach((tr, r) => {
    const el = document.createElement("div");
    el.className = "sestrack" + (tr.id === ses.track ? " cur" : "");
    el.style.height = ssLane() + "px";
    el.dataset.id = tr.id;
    el.innerHTML = `<div class="st1"><i class="sdot" style="background:${tc(SS_COLORS[r % SS_COLORS.length])}"></i><button class="stn"></button><button class="str" title="${esc(t("Arm for recording"))}" aria-label="${esc(t("Arm for recording"))}">R</button><button class="stm" title="${esc(t("Mute"))}">M</button><button class="sts" title="${esc(t("Solo"))}">S</button><button class="sta"></button><button class="stf">FX</button><button class="x std" title="${esc(t("Remove the track"))}" aria-label="${esc(t("Remove the track"))}">×</button></div>`
      + `<label class="st2"><span>${esc(t("Vol"))}</span><input type="range" class="stg" min="-48" max="12" step="0.5"><b class="stgv"></b></label>`
      + `<label class="st2"><span>${esc(t("Pan"))}</span><input type="range" class="stp" min="-100" max="100" step="1"><b class="stpv"></b></label>`;
    el.querySelector(".stn").textContent = tr.name;
    el.querySelector(".str").classList.toggle("on", pc.arm === tr.id);
    el.querySelector(".str").addEventListener("click", () => pcArm(tr.id));
    if (pc.arm === tr.id) { const m = document.createElement("i"); m.className = "stin"; m.appendChild(document.createElement("b")); el.appendChild(m); }
    el.querySelector(".stn").title = t("Rename the track");
    el.querySelector(".stm").classList.toggle("on", tr.mute);
    el.querySelector(".sts").classList.toggle("on", tr.solo);
    const au = ssAuto(tr), sta = el.querySelector(".sta");
    sta.textContent = tr.view === "pan" ? "P" : tr.view === "vol" ? "V" : "A";
    sta.classList.toggle("on", !!tr.view);
    sta.classList.toggle("has", !!(au.vol.length || au.pan.length));
    sta.title = tr.view === "vol" ? t("Volume automation shown — click for pan") : tr.view === "pan" ? t("Pan automation shown — click to hide") : t("Show the automation");
    sta.setAttribute("aria-label", sta.title);
    const stf = el.querySelector(".stf"), fxOpen = typeof fx !== "undefined" && fx.target && fx.target.kind === "track" && fx.target.id === tr.id;
    stf.classList.toggle("has", !!tr.fx);
    stf.classList.toggle("byp", !!tr.fx && !tr.fx.on);
    stf.classList.toggle("on", !!fxOpen);
    stf.title = tr.fx ? (tr.fx.on ? t("Effects on this track — click to edit") : t("Effects bypassed — click to edit")) : t("Add effects to this track");
    stf.setAttribute("aria-label", stf.title);
    stf.addEventListener("click", () => fxSesToggle({ kind: "track", id: tr.id }));
    el.querySelector(".st2:nth-of-type(1)").classList.toggle("auto", au.vol.length > 0);
    el.querySelector(".st2:nth-of-type(2)").classList.toggle("auto", au.pan.length > 0);
    ssHeadVals(el, tr, ses.play.on ? ssPlayhead() : ses.cursor);
    const gi = el.querySelector(".stg"), pi = el.querySelector(".stp");
    const write = (kind, v) => {
      const at = Math.round(ssPlayhead()), T = ses.touch;
      if (!T || T.id !== tr.id || T.kind !== kind) {
        ses.touch = { id: tr.id, kind, pts: [], g0: tr.gain, p0: tr.pan };
        tr.touch = kind;
      }
      const L = ses.touch.pts, last = L[L.length - 1];
      if (!last || at - last[0] >= ssRate() * 0.02 || Math.abs(v - last[1]) >= (kind === "pan" ? 0.02 : 0.25)) L.push([at, v]);
      else last[1] = v;
      if (kind === "vol") tr.gain = v <= SM_FLOOR ? -96 : v; else tr.pan = v;
      ssMix();
    };
    const trim = (kind, v) => {
      if (!ses.trim || ses.trim.id !== tr.id || ses.trim.kind !== kind) ses.trim = { id: tr.id, kind, base: au[kind].map(q => q.slice()), ref: ssAutoVal(tr, kind, ses.cursor) };
      const [lo, hi] = ssAutoRange(kind), dv = v - ses.trim.ref;
      au[kind] = ses.trim.base.map(q => [q[0], Math.max(lo, Math.min(hi, q[1] + dv))]);
      ssMix();
      ssDraw();
    };
    const finish = () => {
      const T = ses.touch;
      if (T && T.id === tr.id) {
        const L = T.pts.slice().sort((a, b) => a[0] - b[0]);
        if (L.length) {
          const f0 = L[0][0], f1 = L[L.length - 1][0], keep = au[T.kind].filter(q => q[0] < f0 || q[0] > f1);
          au[T.kind] = keep.concat(L).sort((a, b) => a[0] - b[0]).filter((q, i, A) => i === 0 || q[0] !== A[i - 1][0]);
        }
        tr.gain = T.g0;
        tr.pan = T.p0;
        tr.touch = "";
        ses.touch = null;
      }
      ses.trim = null;
      ssCommit();
    };
    const onInput = (kind, v) => {
      if (ses.play.on && tr.view === kind) write(kind, v);
      else if (au[kind].length) trim(kind, v);
      else if (kind === "vol") tr.gain = v <= SM_FLOOR ? -96 : v;
      else tr.pan = v;
      if (!ses.touch) ssMix();
      ssHeadVals(el, tr, ses.play.on ? ssPlayhead() : ses.cursor, kind, v);
    };
    gi.addEventListener("input", () => onInput("vol", gi.value <= -48 ? SM_FLOOR : Number(gi.value)));
    gi.addEventListener("change", finish);
    gi.addEventListener("dblclick", () => { if (au.vol.length) return; tr.gain = 0; ssCommit(); });
    pi.addEventListener("input", () => onInput("pan", Number(pi.value) / 100));
    pi.addEventListener("change", finish);
    pi.addEventListener("dblclick", () => { if (au.pan.length) return; tr.pan = 0; ssCommit(); });
    sta.addEventListener("click", () => { tr.view = tr.view === "" || !tr.view ? "vol" : tr.view === "vol" ? "pan" : ""; ses.apt = null; ssSaveSoon(); ssHeads(); ssDraw(); });
    el.querySelector(".stm").addEventListener("click", () => { tr.mute = !tr.mute; ssCommit(); });
    el.querySelector(".sts").addEventListener("click", () => { tr.solo = !tr.solo; ssCommit(); });
    el.querySelector(".stn").addEventListener("click", () => ssRenameTrack(tr.id));
    el.querySelector(".std").addEventListener("click", () => ssRemoveTrack(tr.id));
    el.addEventListener("pointerdown", () => { if (ses.track !== tr.id) { ses.track = tr.id; box.querySelectorAll(".sestrack").forEach(x => x.classList.toggle("cur", x.dataset.id === tr.id)); ssDraw(); } });
    box.appendChild(el);
  });
}

function ssDbText(v) { return v <= SM_FLOOR || v <= -48 ? "−∞" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1); }
function ssPanText(v) { const p = Math.round(v * 100); return p === 0 ? "C" : (p < 0 ? "L" : "R") + Math.abs(p); }

function ssHeadVals(el, tr, f, kind, v) {
  const au = ssAuto(tr), gi = el.querySelector(".stg"), pi = el.querySelector(".stp");
  const vol = kind === "vol" ? v : tr.touch === "vol" ? tr.gain : au.vol.length ? smAt(au.vol, f) : tr.gain;
  const pan = kind === "pan" ? v : tr.touch === "pan" ? tr.pan : au.pan.length ? smAt(au.pan, f) : tr.pan;
  if (kind !== "vol") gi.value = String(Math.max(-48, vol));
  if (kind !== "pan") pi.value = String(Math.round(pan * 100));
  el.querySelector(".stgv").textContent = ssDbText(vol);
  el.querySelector(".stpv").textContent = ssPanText(pan);
}

function ssFollow(f) {
  if (!ses.open || !ses.s) return;
  const box = $("sesHeads");
  for (const tr of ses.s.tracks) {
    const au = ssAuto(tr);
    if (!au.vol.length && !au.pan.length) continue;
    const el = box.querySelector('.sestrack[data-id="' + CSS.escape(tr.id) + '"]');
    if (el && !(ses.touch && ses.touch.id === tr.id) && !(ses.trim && ses.trim.id === tr.id)) ssHeadVals(el, tr, f);
  }
}

async function ssRenameTrack(id) {
  const tr = ses.s.tracks.find(x => x.id === id);
  if (!tr) return;
  const v = await askForm(t("Rename the track"), `<label class="dfield"><span>${esc(t("Name"))}</span><input name="name" value="${esc(tr.name)}" spellcheck="false" autocomplete="off"></label>`, { ok: t("rename"), setup: f => requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }) });
  if (!v) return;
  const T = ses.s.tracks.find(x => x.id === id);
  if (!T) return;
  T.name = String(v.name || "").trim().slice(0, 80) || T.name;
  ssCommit();
}

async function ssRemoveTrack(id) {
  const tr = ses.s.tracks.find(x => x.id === id);
  if (!tr) return;
  if (tr.clips.length && !(await ask(t("Remove this track?"), t("Its clips leave the session. The files stay in Studio, and Undo brings the track back."), { ok: t("remove") }))) return;
  if (pc.rec && pc.rec.tr === id) ssStop();
  if (pc.arm === id) pcDisarm();
  ses.s.tracks = ses.s.tracks.filter(x => x.id !== id);
  if (ses.track === id) ses.track = ses.s.tracks[0] ? ses.s.tracks[0].id : null;
  if (ses.clip && !ssTrackOf(ses.clip)) ses.clip = null;
  ssCommit();
  fxSesSync();
}

async function ssRename() {
  if (!ses.open) return;
  const v = await askForm(t("Rename the session"), `<label class="dfield"><span>${esc(t("Name"))}</span><input name="name" value="${esc(ses.s.name)}" spellcheck="false" autocomplete="off"></label>`, { ok: t("rename"), setup: f => requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }) });
  if (!v || !ses.open) return;
  ses.s.name = String(v.name || "").trim().slice(0, 160) || ses.s.name;
  $("sesName").textContent = ses.s.name;
  ssCommit();
}

function ssMenu(e) {
  e.preventDefault();
  if (!ses.open) return;
  const cv = $("sesCv"), r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, h = ssHit(x, y);
  const arow = Math.floor(y / ssLane()), atr = ses.s.tracks[arow];
  if (h.k && !(atr && atr.view)) { ses.clip = h.k.id; ssButtons(); ssDraw(); }
  else { ses.cursor = Math.max(0, Math.round(ssF(x))); ssDraw(); }
  const items = [
    ses.play.on ? { label: t("Stop"), key: cmdKeyText("stop"), enabled: true, run: () => ssStop() } : { label: t("Play from here"), key: cmdKeyText("play"), enabled: true, run: () => ssPlay(ses.cursor) },
    "-"
  ];
  if (atr) {
    const au = ssAuto(atr), pi = atr.view ? ssAutoHit(atr, arow, x, y) : -1;
    if (pi >= 0) items.push({ label: t("Delete the point"), enabled: true, run: () => { au[atr.view].splice(pi, 1); ses.apt = null; ssCommit(); } });
    items.push({ label: atr.view === "vol" ? t("Hide the volume automation") : t("Show the volume automation"), enabled: true, run: () => { atr.view = atr.view === "vol" ? "" : "vol"; ssSaveSoon(); ssHeads(); ssDraw(); } },
      { label: atr.view === "pan" ? t("Hide the pan automation") : t("Show the pan automation"), enabled: true, run: () => { atr.view = atr.view === "pan" ? "" : "pan"; ssSaveSoon(); ssHeads(); ssDraw(); } },
      { label: t("Clear the volume automation"), enabled: au.vol.length > 0, run: () => { au.vol = []; ssCommit(); } },
      { label: t("Clear the pan automation"), enabled: au.pan.length > 0, run: () => { au.pan = []; ssCommit(); } }, "-");
  }
  if (h.k && !(atr && atr.view)) {
    items.push({ label: t("Split at the cursor"), key: cmdKeyText("sesSplit"), enabled: true, run: () => { ses.cursor = Math.round(ssF(x)); ssSplit(); } },
      { label: t("Clip gain…"), enabled: true, run: () => ssClipGain() },
      { label: t("Remove the clip"), key: cmdKeyText("delete"), enabled: true, run: () => ssDelete() },
      { label: t("Open the file"), enabled: !!(ses.docs.get(h.k.doc) && !ses.docs.get(h.k.doc).missing), run: () => ssOpenFile(h.k.doc) }, "-");
  }
  items.push({ label: t("New track"), enabled: true, run: () => pcNewTrack() }, { label: atr && pc.arm === atr.id ? t("Disarm the track") : t("Arm the track for recording"), enabled: !!atr && !pc.rec, run: () => pcArm(atr.id) }, { label: t("Recording in sessions…"), enabled: true, run: () => pcSettings() }, "-");
  items.push({ label: t("Add files…"), enabled: true, run: () => ssAddDlg() }, { label: t("Mix down to a new file"), enabled: ssLen() > 0, run: () => ssBounce(false) }, { label: t("Export…"), key: cmdKeyText("export"), enabled: ssLen() > 0, run: () => ssBounce(true) });
  ctxOpen(e.clientX, e.clientY, items, false);
}

async function ssOpenFile(id) {
  await ssClose(true);
  await openDoc(id);
}

function ssFilesTab() {
  const box = $("sesList");
  box.innerHTML = "";
  ssLoadList().then(list => {
    box.innerHTML = "";
    if (!list.length) { listNote(box, t("No sessions yet. A session lays out Studio files on tracks to mix them together.")); return; }
    for (const s of list) {
      const info = [s.sr ? (s.sr / 1000).toLocaleString() + " kHz" : "", s.tracks === 1 ? t("1 track") : t("{n} tracks").replace("{n}", s.tracks), s.sr ? fmtDur(s.len / s.sr) : ""].filter(Boolean).join(" · ");
      const row = rowEl(s.name, info, () => ssOpen(s.id));
      if (ses.open && ses.s && ses.s.id === s.id) row.classList.add("cur");
      const del = document.createElement("button");
      del.className = "x fdel";
      del.textContent = "×";
      del.title = t("Delete the session");
      del.setAttribute("aria-label", t("Delete the session"));
      del.addEventListener("click", async ev => {
        ev.stopPropagation();
        if (!(await ask(t("Delete this session?"), t("Only the session goes. Its files stay in Studio."), { ok: t("delete") }))) return;
        try { await call({ t: "sesdel", id: s.id }); } catch {}
        if (ses.open && ses.s && ses.s.id === s.id) await ssClose();
        ssFilesTab();
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  });
}

function wireSes() {
  const cv = $("sesCv");
  cv.addEventListener("pointerdown", ssDown);
  cv.addEventListener("pointermove", ssMove);
  cv.addEventListener("pointerup", ssUp);
  cv.addEventListener("pointercancel", ssUp);
  cv.addEventListener("wheel", ssWheel, { passive: false });
  cv.addEventListener("contextmenu", ssMenu);
  cv.addEventListener("dblclick", e => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, row = Math.floor(y / ssLane()), tr = ses.s && ses.s.tracks[row];
    if (tr && tr.view) { const i = ssAutoHit(tr, row, x, y); if (i >= 0) { ssAuto(tr)[tr.view].splice(i, 1); ses.apt = null; ssCommit(); } return; }
    const h = ssHit(x, y);
    if (h.k) ssClipGain();
  });
  const ru = $("sesRu");
  let rd = false;
  const at = e => { const r = ru.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const go = e => { ses.cursor = Math.max(0, Math.round(ssF(at(e).x))); ssDraw(); };
  ru.addEventListener("pointerdown", e => {
    if (!ses.open || e.button > 0) return;
    const p = at(e), h = ssMarkAt(p.x, p.y);
    ru.setPointerCapture(e.pointerId);
    if (h) { ses.mark = h.m.id; ses.mdrag = { id: h.m.id, x0: p.x, grab: p.x - ssX(h.m.at), at: h.m.at, moved: false }; ssDraw(); return; }
    rd = true;
    go(e);
  });
  ru.addEventListener("pointermove", e => {
    if (!ses.open) return;
    const p = at(e), d = ses.mdrag;
    if (d) {
      if (!d.moved && Math.abs(p.x - d.x0) < 3) return;
      d.moved = true;
      d.at = Math.max(0, Math.round(ssF(p.x - d.grab)));
      ssDraw();
      return;
    }
    if (rd) { go(e); return; }
    const h = ssMarkAt(p.x, p.y);
    ru.style.cursor = h ? "ew-resize" : "pointer";
    ru.title = h ? ssMarkText(h) : "";
  });
  const up = e => {
    const d = ses.mdrag;
    if (d) {
      ses.mdrag = null;
      const m = ses.open && (ses.s.marks || []).find(k => k.id === d.id);
      if (!m || e.type === "pointercancel") { ssDraw(); return; }
      if (d.moved) { m.at = d.at; ses.s.marks.sort((a, b) => a.at - b.at); ssCommit(); return; }
      ses.cursor = m.at;
      if (ses.play.on) ssPlay(ses.cursor);
      ssDraw();
      return;
    }
    if (rd && ses.play.on) ssPlay(ses.cursor);
    rd = false;
  };
  ru.addEventListener("pointerup", up);
  ru.addEventListener("pointercancel", up);
  ru.addEventListener("dblclick", e => { const p = at(e), h = ssMarkAt(p.x, p.y); if (h) ssMarkRename(h.m.id); });
  ru.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (!ses.open) return;
    const p = at(e), h = ssMarkAt(p.x, p.y);
    if (!h) return;
    ctxOpen(e.clientX, e.clientY, [{ label: t("Rename location") + " " + h.n, enabled: true, run: () => ssMarkRename(h.m.id) }, { label: t("Delete location") + " " + h.n, enabled: true, run: () => ssMarkDel(h.m.id) }], false);
  });
  ru.addEventListener("wheel", ssWheel, { passive: false });
  $("sesTools").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-cmd]");
    if (!b || b.disabled) return;
    ev.stopPropagation();
    b.blur();
    runCmdById(b.dataset.cmd);
  });
  $("sesName").addEventListener("click", ssRename);
  $("sesClose").addEventListener("click", () => ssClose());
  $("sesPlay").addEventListener("click", ssToggle);
  $("sesStop").addEventListener("click", () => ssStop());
  $("sesHome").addEventListener("click", ssHome);
  $("sesLoop").addEventListener("click", ssLoopToggle);
  $("sesZin").addEventListener("click", () => ssZoomAt(0.5));
  $("sesZout").addEventListener("click", () => ssZoomAt(2));
  $("sesZfit").addEventListener("click", ssZoomFit);
  $("sesNew").addEventListener("click", () => ssNewDlg());
  $("djOpen").addEventListener("click", () => djOpen());
  $("sesMeter").addEventListener("click", () => { ed.meter.clip = []; drawMeters(); });
  window.addEventListener("resize", () => { if (ses.open) { ssClamp(); ssDraw(); } });
}

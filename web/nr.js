const NR_DEF = { amount: 100, floor: 12, thr: 0, decay: 50, k: 7, n: 0, link: true, lo: 100, hi: 100, pts: [], scale: "log", profile: "print" };
const NR_FFTS = [0, 1024, 2048, 4096, 8192, 16384, 32768];
const NR_LO = 20;
const nr = { cfg: null, info: null, auto: null, aprog: null, stats: null, err: null, listen: "off", job: null, show: 0, drag: null, hover: -1, seq: 0, busy: false, again: false, cols: null, colKey: "", geo: null, fetchSeq: 0, done: null };

function nrLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioNr") || "null"); } catch {}
  nr.cfg = Object.assign({}, NR_DEF, v && typeof v === "object" ? v : {});
  if (!Array.isArray(nr.cfg.pts)) nr.cfg.pts = [];
  nr.cfg.pts = nr.cfg.pts.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
}

function nrSave() {
  try { localStorage.setItem("studioNr", JSON.stringify(nr.cfg)); } catch {}
}

function nrNyq() { return (ed.doc ? ed.doc.sampleRate : 44100) / 2; }
function nrAutoN() { const sr = ed.doc ? ed.doc.sampleRate : 44100; return sr <= 50000 ? 4096 : sr <= 100000 ? 8192 : 16384; }
function nrN() { return nr.cfg.n || nrAutoN(); }

function nrPts() {
  const c = nr.cfg, ny = nrNyq();
  return [[NR_LO, c.lo], ...c.pts.filter(p => p[0] > NR_LO && p[0] < ny).sort((x, y) => x[0] - y[0]), [ny, c.hi]];
}

function nrFlat() { const c = nr.cfg; return c.lo === 100 && c.hi === 100 && !c.pts.length; }

function nrWire() {
  const c = nr.cfg;
  return { n: c.n, k: c.k, floor: c.floor, amount: c.amount, thr: c.thr, decay: c.decay, link: c.link, curve: nrFlat() ? [] : nrPts(), profile: c.profile === "auto" ? "auto" : "print" };
}

function nrCurveAt(f) {
  const p = nrPts(), lf = Math.log(Math.max(1, f));
  if (f <= p[0][0]) return p[0][1];
  for (let i = 0; i < p.length - 1; i++) {
    if (f <= p[i + 1][0]) { const a = Math.log(p[i][0]), b = Math.log(p[i + 1][0]); return p[i][1] + (lf - a) / Math.max(1e-9, b - a) * (p[i + 1][1] - p[i][1]); }
  }
  return p[p.length - 1][1];
}

function nrIsAuto() { return nr.cfg.profile === "auto"; }

function nrUsable() {
  if (nrIsAuto()) return !!(ed.doc && nr.auto && nr.stats && !nr.err && nr.auto.segs.length);
  return !!(ed.doc && nr.info && nr.stats && !nr.err && nr.info.sr === ed.doc.sampleRate);
}

function nrAutoProg(m) {
  if (!nr.aprog || m.id !== nr.aprog.id) return;
  nr.aprog.frac = m.frac;
  if (rp.open && rp.tab === "nr") $("nrPrint").textContent = t("Finding the quiet parts…") + " " + Math.round(m.frac * 100) + " %";
}

function nrRange() {
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function nrErrText(m) {
  if (!m) return "";
  if (m === "print-none") return t("Capture a noise print first: select a stretch with noise only and press Capture noise print (Shift+P).");
  if (m.startsWith("print-rate:")) return t("The noise print was captured at {r} kHz. Capture one from this file.").replace("{r}", (Number(m.slice(11)) / 1000).toLocaleString());
  if (m.startsWith("print-short:")) return t("The noise print is too short for this FFT size. Capture a longer stretch of noise or pick a smaller FFT size.") + " (" + t("at least") + " " + fmtTime(Number(m.slice(12))) + ")";
  if (m === "changed") return t("The audio changed while it was processed. Run it again.");
  if (m === "auto-none") return t("No stretch with only noise was found: the quiet parts are silent or there are none. Capture a noise print instead.");
  return m;
}

function nrShow() {
  nr.cols = null;
  nrRender();
  nrFetch(true);
}

function nrHide() {
  if (nr.listen !== "off") nrListen("off");
}

async function nrFetch(open) {
  if (!ed.doc) return;
  const seq = ++nr.fetchSeq;
  try {
    if (nrIsAuto()) {
      const id = "a" + seq;
      nr.aprog = { id, frac: 0 };
      nr.stats = null;
      nrRender();
      const r = await call({ t: "npauto", id: ed.doc.id, jobId: id, cfg: { n: nrN(), k: nr.cfg.k } });
      if (seq !== nr.fetchSeq) return;
      nr.auto = r.info;
      nr.stats = r.info.segs.length ? r.stats : null;
      nr.err = r.info.segs.length ? null : "auto-none";
    } else {
      const r = await call({ t: "npget", cfg: { n: nrN(), k: nr.cfg.k } });
      if (seq !== nr.fetchSeq) return;
      nr.info = r.info;
      nr.stats = r.stats;
      nr.err = r.err || (r.info && ed.doc && r.info.sr !== ed.doc.sampleRate ? "print-rate:" + r.info.sr : null);
    }
    nr.cols = null;
  } catch (e) { if (seq === nr.fetchSeq && e.message !== "stale") nr.err = String(e.message || e); }
  finally { if (seq === nr.fetchSeq) nr.aprog = null; }
  if (!nrUsable() && nr.listen !== "off") nrListen("off");
  else if (open && nrUsable() && nr.listen === "off" && !nr.job) nrListen("proc");
  else if (nr.listen !== "off") nrSend();
  nrRender();
}

function nrSend() {
  if (!ed.doc) return;
  if (nr.busy) { nr.again = true; return; }
  nr.busy = true;
  call({ t: "fxcfg", kind: "nr", cfg: nrWire(), mode: nr.listen })
    .catch(e => { nr.listen = "off"; nr.err = String(e.message || e); nrRender(); })
    .finally(() => { nr.busy = false; if (nr.again) { nr.again = false; nrSend(); } });
}

function nrListen(mode) {
  nr.listen = mode;
  document.querySelectorAll("#nrListen button").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
  nrSend();
}

async function nrCapture() {
  if (!ed.doc) return;
  if (!selOn()) { tell(t("Select a stretch that holds only noise first, for example the lead-in groove or a gap between tracks."), t("Capture noise print")); return; }
  try {
    const r = await call({ t: "npcap", id: ed.doc.id, a: ed.sel.a, b: ed.sel.b, cfg: { n: nrN(), k: nr.cfg.k } });
    if (nrIsAuto()) { nr.cfg.profile = "print"; nrSave(); }
    nr.info = r.info;
    nr.stats = r.stats;
    nr.err = null;
    nr.cols = null;
    flash(t("Noise print captured") + " · " + fmtTime(r.info.len));
    nr.done = null;
    if (rp.open && rp.tab === "nr") {
      if (nr.listen === "off" && !nr.job) nrListen("proc"); else nrSend();
    }
    nrRender();
    redraw();
  } catch (e) {
    const m = String(e.message || e);
    tell(m.startsWith("print-short:") ? nrErrText(m) : m, t("Capture noise print"));
  }
}

async function nrApply() {
  if (!ed.doc || nr.job || !nrUsable()) return;
  const r = nrRange();
  if (r.b <= r.a) return;
  const id = "n" + (++nr.seq);
  nr.job = { id, frac: 0 };
  nr.done = null;
  const was = nr.listen;
  if (was !== "off") nrListen("off");
  nrRender();
  try {
    const res = await runEdit({ t: "fxapply", kind: "nr", jobId: id, ra: r.a, rb: r.b, cfg: nrWire() }, false, true);
    if (res && res.hist) { nr.done = { a: r.a, b: r.b }; flash(t("Noise reduction applied")); }
  } finally {
    nr.job = null;
    nrRender();
  }
}

function nrProg(m) {
  if (!nr.job || m.id !== nr.job.id) return;
  nr.job.frac = m.frac;
  const bar = $("nrBar");
  if (bar) bar.querySelector("i").style.width = Math.round(m.frac * 100) + "%";
  $("nrSum").textContent = t("Processing…") + " " + Math.round(m.frac * 100) + " %";
}

function nrDoc() {
  nr.cols = null;
  nr.auto = null;
  nr.done = null;
  if (nr.listen !== "off") nr.listen = "off";
  if (rp.open && rp.tab === "nr") nrFetch(true);
}

function nrSetDd(el, v) {
  const items = nrFftItems();
  const it = items.find(i => i.v === String(v)) || items[0];
  el.querySelector(".cur").textContent = it.label;
  el.dataset.v = it.v;
}

function nrFftItems() {
  return NR_FFTS.map(n => ({ v: String(n), label: n ? String(n) : t("Auto") + " (" + nrAutoN() + ")" }));
}

function nrRender() {
  const c = nr.cfg;
  if (!c || !$("nrBody")) return;
  const r = nrRange(), busy = !!nr.job, ok = nrUsable();
  $("nrAmt").value = c.amount;
  $("nrAmtV").textContent = Math.round(c.amount) + " %";
  $("nrFloor").value = c.floor;
  $("nrFloorV").textContent = c.floor + " dB";
  $("nrThr").value = c.thr;
  $("nrThrV").textContent = (c.thr > 0 ? "+" : "") + c.thr + " dB";
  $("nrDecay").value = c.decay;
  $("nrDecayV").textContent = Math.round(c.decay) + " %";
  $("nrPrec").value = c.k;
  $("nrPrecV").textContent = c.k;
  const dd = $("nrFft"), items = nrFftItems();
  if (!dd.dataset.ready) {
    dd.dataset.ready = "1";
    dd.innerHTML = `<div class="cur"></div><div class="list"></div>`;
    ddInit(dd, items, String(c.n), v => { nr.cfg.n = Number(v); nrSave(); nr.cols = null; nrFetch(false); });
  }
  dd.querySelectorAll(".ddi").forEach((d, i) => { d.textContent = items[i].label; });
  nrSetDd(dd, c.n);
  document.querySelectorAll("#nrLink button").forEach(b => { b.classList.toggle("on", (b.dataset.v === "link") === c.link); b.disabled = !ed.doc || ed.doc.channels === 1; });
  document.querySelectorAll("#nrScale button").forEach(b => b.classList.toggle("on", b.dataset.v === c.scale));
  const multi = nr.stats && nr.stats.mean.length > 1;
  $("nrShow").classList.toggle("hidden", !multi);
  document.querySelectorAll("#nrShow button").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === nr.show));
  $("nrCurveReset").disabled = nrFlat();
  document.querySelectorAll("#nrSrc button").forEach(b => b.classList.toggle("on", b.dataset.v === (nrIsAuto() ? "auto" : "print")));
  $("nrCapRow").classList.toggle("hidden", nrIsAuto());
  let p = "";
  if (nrIsAuto()) {
    const a = nr.auto;
    if (nr.aprog) p = t("Finding the quiet parts…") + " " + Math.round(nr.aprog.frac * 100) + " %";
    else if (a && a.segs.length) {
      p = (a.segs.length === 1 ? t("Learned from 1 quiet stretch") : t("Learned from {n} quiet stretches").replace("{n}", a.segs.length)) + " · " + fmtTime(a.total) + ". " + t("The profile follows the noise from one to the next.");
      if (a.clarity < 10) p += " " + t("No clear noise-only stretch here, so quiet music may count as noise. A noise print is safer.");
    } else p = t("Finds the stretches with only noise, such as the lead-in, gaps between tracks and the run-out, and follows the noise from one to the next.");
  } else if (!nr.info) p = t("No noise print yet. Select a stretch with noise only, at least half a second, such as the lead-in groove or a gap between tracks, then capture it.");
  else {
    const i = nr.info;
    p = t("Noise print") + ": " + fmtTime(Math.round(i.len * (ed.doc ? ed.doc.sampleRate : i.sr) / i.sr)) + " · " + (i.ch === 1 ? t("mono") : i.ch === 2 ? t("stereo") : i.ch + " ch") + " · " + (i.sr / 1000).toLocaleString() + " kHz";
    if (i.name) p += " · " + i.name;
  }
  $("nrPrint").textContent = p;
  $("nrRange").textContent = (r.sel ? t("Selection") : t("Whole file")) + " · " + fmtTime(r.a) + "–" + fmtTime(r.b);
  document.querySelectorAll("#nrListen button").forEach(b => { b.disabled = b.dataset.v !== "off" && (!ok || busy); b.classList.toggle("on", b.dataset.v === nr.listen); });
  $("nrApply").disabled = busy || !ok || r.b <= r.a;
  $("nrCap").disabled = busy;
  $("nrCancel").classList.toggle("hidden", !busy);
  $("nrBar").classList.toggle("hidden", !busy);
  if (!busy) $("nrBar").querySelector("i").style.width = "0%";
  let sum;
  if (busy) sum = t("Processing…") + " " + Math.round(nr.job.frac * 100) + " %";
  else if (nr.err) sum = nrErrText(nr.err);
  else if (nr.done) sum = t("Applied to") + " " + fmtTime(nr.done.a) + "–" + fmtTime(nr.done.b) + ". " + t("Undo brings the original back.");
  else if (ok) sum = t("Listen to Noise only to hear what would be removed. If music shows up there, lower Reduce by, or lower the curve at those frequencies.");
  else sum = "";
  $("nrSum").textContent = sum;
  nrDraw();
}

function nrGeo(cv) {
  const W = cv.clientWidth, H = cv.clientHeight;
  return { W, H, L: 30, R: 6, T: 6, B: 15, iw: Math.max(10, W - 36), ih: Math.max(10, H - 21) };
}

function nrX(f, g) {
  const ny = nrNyq();
  const u = nr.cfg.scale === "lin" ? f / ny : (Math.log(Math.max(NR_LO, f)) - Math.log(NR_LO)) / (Math.log(ny) - Math.log(NR_LO));
  return g.L + Math.max(0, Math.min(1, u)) * g.iw;
}

function nrF(x, g) {
  const ny = nrNyq(), u = Math.max(0, Math.min(1, (x - g.L) / g.iw));
  return nr.cfg.scale === "lin" ? Math.max(NR_LO, u * ny) : Math.exp(Math.log(NR_LO) + u * (Math.log(ny) - Math.log(NR_LO)));
}

function nrCols(g) {
  const st = nr.stats;
  if (!st) return null;
  const W = Math.round(g.iw), key = [W, nr.cfg.scale, st.n, nr.show, nrNyq()].join(":");
  if (nr.cols && nr.colKey === key) return nr.cols;
  const ch = Math.min(nr.show, st.mean.length - 1), sr = nrNyq() * 2, ref = st.n * st.n / 16;
  const m = new Float64Array(W), cnt = new Uint32Array(W), lo = new Float64Array(W).fill(Infinity), hi = new Float64Array(W).fill(-Infinity);
  for (let b = 1; b < st.bins; b++) {
    const f = b * sr / st.n;
    if (f < NR_LO) continue;
    const x = Math.min(W - 1, Math.floor(nrX(f, g) - g.L));
    m[x] += st.mean[ch][b];
    cnt[x]++;
    lo[x] = Math.min(lo[x], st.lo[ch][b]);
    hi[x] = Math.max(hi[x], st.hi[ch][b]);
  }
  const db = v => 10 * Math.log10(Math.max(v, 1e-30) / ref);
  const out = { m: new Float32Array(W), lo: new Float32Array(W), hi: new Float32Array(W), max: -Infinity, min: Infinity };
  let last = -1;
  for (let x = 0; x < W; x++) {
    if (!cnt[x]) continue;
    out.m[x] = db(m[x] / cnt[x]);
    out.lo[x] = db(lo[x]);
    out.hi[x] = db(hi[x]);
    out.max = Math.max(out.max, out.hi[x]);
    out.min = Math.min(out.min, out.lo[x]);
    if (last >= 0 && x - last > 1) for (let y = last + 1; y < x; y++) { const u = (y - last) / (x - last); for (const k of ["m", "lo", "hi"]) out[k][y] = out[k][last] + u * (out[k][x] - out[k][last]); }
    if (last < 0) for (let y = 0; y < x; y++) for (const k of ["m", "lo", "hi"]) out[k][y] = out[k][x];
    last = x;
  }
  if (last >= 0) for (let y = last + 1; y < W; y++) for (const k of ["m", "lo", "hi"]) out[k][y] = out[k][last];
  nr.cols = out;
  nr.colKey = key;
  return out;
}

function nrPctY(v, g) { return g.T + 4 + (1 - v / 100) * (g.ih - 8); }

function nrDraw() {
  const cv = $("nrGraph");
  if (!cv || !rp.open || rp.tab !== "nr") return;
  const dpr = window.devicePixelRatio || 1, g = nrGeo(cv);
  if (cv.width !== Math.round(g.W * dpr) || cv.height !== Math.round(g.H * dpr)) { cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.H * dpr); }
  nr.geo = g;
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, g.W, g.H);
  x.fillStyle = TH.graph;
  x.fillRect(g.L, g.T, g.iw, g.ih);
  const cols = nrCols(g);
  let top = -40, span = 80;
  if (cols && Number.isFinite(cols.max)) {
    top = Math.ceil((cols.max + 6) / 10) * 10;
    span = Math.max(40, Math.min(110, Math.ceil((top - cols.min + 6) / 10) * 10));
  }
  const yDb = v => g.T + (top - v) / span * g.ih;
  x.font = thFont(9);
  x.textBaseline = "middle";
  x.lineWidth = 1;
  const step = span > 70 ? 20 : 10;
  for (let v = top; v >= top - span; v -= step) {
    const y = Math.round(yDb(v)) + 0.5;
    x.strokeStyle = tw(0.06);
    x.beginPath(); x.moveTo(g.L, y); x.lineTo(g.L + g.iw, y); x.stroke();
    x.fillStyle = TH.glabel;
    x.textAlign = "right";
    x.fillText(String(v), g.L - 4, y);
  }
  const ny = nrNyq(), marks = nr.cfg.scale === "lin" ? [5000, 10000, 15000, 20000, 30000, 40000, 60000, 80000] : [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  for (const f of marks) {
    if (f >= ny * 0.98) continue;
    const xx = Math.round(nrX(f, g)) + 0.5;
    x.strokeStyle = tw(0.06);
    x.beginPath(); x.moveTo(xx, g.T); x.lineTo(xx, g.T + g.ih); x.stroke();
    x.fillStyle = TH.glabel;
    x.fillText(f >= 1000 ? f / 1000 + "k" : String(f), xx, g.H - 3);
  }
  x.save();
  x.beginPath();
  x.rect(g.L, g.T, g.iw, g.ih);
  x.clip();
  if (cols) {
    const W = cols.m.length;
    x.fillStyle = tc("ggold", 0.16);
    x.beginPath();
    for (let i = 0; i < W; i++) x.lineTo(g.L + i + 0.5, yDb(cols.hi[i]));
    for (let i = W - 1; i >= 0; i--) x.lineTo(g.L + i + 0.5, yDb(cols.lo[i]));
    x.closePath();
    x.fill();
    const line = (fn, style, dash) => {
      x.strokeStyle = style;
      x.setLineDash(dash || []);
      x.beginPath();
      for (let i = 0; i < W; i++) { const y = fn(i); if (i) x.lineTo(g.L + i + 0.5, y); else x.moveTo(g.L + i + 0.5, y); }
      x.stroke();
      x.setLineDash([]);
    };
    line(i => yDb(cols.m[i]), TH.ggold);
    if (nr.cfg.thr) line(i => yDb(cols.m[i] + nr.cfg.thr), tc("gred", 0.8), [3, 3]);
    line(i => yDb(cols.m[i] - nr.cfg.floor * nr.cfg.amount / 100 * nrCurveAt(nrF(g.L + i + 0.5, g)) / 100), tc("ggreen", 0.85), [2, 2]);
  } else {
    x.fillStyle = TH.glabel;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(t("No noise print"), g.L + g.iw / 2, g.T + g.ih / 2);
  }
  const pts = nrPts();
  x.strokeStyle = TH.gblue;
  x.lineWidth = 1.5;
  x.beginPath();
  for (let i = 0; i <= g.iw; i += 2) { const y = nrPctY(nrCurveAt(nrF(g.L + i, g)), g); if (i) x.lineTo(g.L + i, y); else x.moveTo(g.L + i, y); }
  x.stroke();
  x.lineWidth = 1;
  pts.forEach((p, i) => {
    const px = nrX(p[0], g), py = nrPctY(p[1], g), on = nr.drag && nr.drag.i === i || nr.hover === i;
    x.fillStyle = on ? TH.white : TH.gblue;
    x.fillRect(Math.round(px) - 3, Math.round(py) - 3, 6, 6);
  });
  x.restore();
  x.fillStyle = TH.gblue;
  x.textAlign = "right";
  x.textBaseline = "top";
  x.fillText("100%", g.L + g.iw - 2, g.T + 6);
}

function nrPctOf(y, g) { return Math.max(0, Math.min(100, (1 - (y - g.T - 4) / (g.ih - 8)) * 100)); }

function nrHit(px, py) {
  const g = nr.geo;
  if (!g) return -1;
  const pts = nrPts();
  for (let i = 0; i < pts.length; i++) if (Math.abs(nrX(pts[i][0], g) - px) <= 7 && Math.abs(nrPctY(pts[i][1], g) - py) <= 7) return i;
  return -1;
}

function nrSetPts(pts) {
  const c = nr.cfg, ny = nrNyq();
  c.lo = Math.round(pts[0][1]);
  c.hi = Math.round(pts[pts.length - 1][1]);
  c.pts = pts.slice(1, -1).map(p => [Math.round(p[0]), Math.round(p[1])]);
  for (const p of nr.cfg.pts) p[0] = Math.max(NR_LO + 1, Math.min(ny - 1, p[0]));
}

function nrCurveChanged() {
  nrSave();
  nrRender();
  if (nr.listen !== "off") nrSend();
}

function nrPointer(cv) {
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener("pointerdown", e => {
    if (!ed.doc || e.button > 0) return;
    const g = nr.geo, p = pos(e);
    if (!g || p.x < g.L - 4 || p.x > g.L + g.iw + 4 || p.y < g.T - 4 || p.y > g.T + g.ih + 4) return;
    let pts = nrPts(), i = nrHit(p.x, p.y);
    if (i < 0) {
      const f = nrF(p.x, g);
      if (f <= NR_LO * 1.02 || f >= nrNyq() * 0.99) return;
      pts.push([f, nrPctOf(p.y, g)]);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex(q => q[0] === f);
      nrSetPts(pts);
    }
    nr.drag = { i };
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
    nrCurveChanged();
  });
  cv.addEventListener("pointermove", e => {
    const g = nr.geo, p = pos(e);
    if (!g) return;
    if (!nr.drag) { const h = nrHit(p.x, p.y); if (h !== nr.hover) { nr.hover = h; cv.style.cursor = h >= 0 ? "grab" : "crosshair"; nrDraw(); } return; }
    const pts = nrPts(), i = nr.drag.i;
    if (i < 0 || i >= pts.length) return;
    const v = nrPctOf(p.y, g);
    pts[i][1] = v;
    if (i > 0 && i < pts.length - 1) pts[i][0] = Math.max(pts[i - 1][0] * 1.01, Math.min(pts[i + 1][0] / 1.01, nrF(p.x, g)));
    nrSetPts(pts);
    nrCurveChanged();
  });
  const end = () => { if (nr.drag) { nr.drag = null; nrDraw(); } };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", () => { if (!nr.drag && nr.hover >= 0) { nr.hover = -1; nrDraw(); } });
  cv.addEventListener("dblclick", e => {
    const p = pos(e), i = nrHit(p.x, p.y), pts = nrPts();
    if (i <= 0 || i >= pts.length - 1) return;
    pts.splice(i, 1);
    nrSetPts(pts);
    nr.hover = -1;
    nrCurveChanged();
  });
}

function drawNrPrint(g, W, H, dpr) {
  if (nrIsAuto()) {
    if (!nr.auto || !ed.doc) return;
    for (const s of nr.auto.segs) {
      const x0 = Math.floor(xOf(s.a) * dpr), x1 = Math.max(x0 + 1, Math.ceil(xOf(s.b) * dpr));
      if (x1 < 0 || x0 > W) continue;
      g.fillStyle = tc("ggold", 0.85);
      g.fillRect(x0, 0, x1 - x0, Math.round(4 * dpr));
      g.fillStyle = tc("ggold", 0.07);
      g.fillRect(x0, Math.round(4 * dpr), x1 - x0, H);
    }
    return;
  }
  const i = nr.info;
  if (!i || !ed.doc || i.doc !== ed.doc.id || i.b <= i.a) return;
  const x0 = Math.floor(xOf(i.a) * dpr), x1 = Math.max(x0 + 1, Math.ceil(xOf(i.b) * dpr));
  if (x1 < 0 || x0 > W) return;
  g.fillStyle = tc("ggold", 0.85);
  g.fillRect(x0, 0, x1 - x0, Math.round(4 * dpr));
  g.fillStyle = tc("ggold", 0.07);
  g.fillRect(x0, Math.round(4 * dpr), x1 - x0, H);
}

function wireNr() {
  nrLoad();
  const slider = (id, key, after) => {
    const el = $(id);
    el.addEventListener("input", () => { nr.cfg[key] = Number(el.value); nrSave(); if (after) after(); nrRender(); if (nr.listen !== "off") nrSend(); });
    el.addEventListener("change", () => el.blur());
  };
  slider("nrAmt", "amount");
  slider("nrFloor", "floor");
  slider("nrThr", "thr");
  slider("nrDecay", "decay");
  slider("nrPrec", "k", () => { nr.cols = null; clearTimeout(nr.precT); nr.precT = setTimeout(() => nrFetch(false), 150); });
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); nrSave(); nrRender(); });
  seg("nrLink", v => { nr.cfg.link = v === "link"; if (nr.listen !== "off") nrSend(); });
  seg("nrScale", v => { nr.cfg.scale = v === "lin" ? "lin" : "log"; nr.cols = null; });
  seg("nrShow", v => { nr.show = Number(v) || 0; nr.cols = null; });
  seg("nrListen", v => nrListen(v));
  seg("nrSrc", v => { nr.cfg.profile = v === "auto" ? "auto" : "print"; nr.cols = null; nr.err = null; nr.done = null; nrFetch(rp.open && rp.tab === "nr"); });
  $("nrCap").addEventListener("click", nrCapture);
  $("nrApply").addEventListener("click", nrApply);
  $("nrCancel").addEventListener("click", () => ed.worker.postMessage({ t: "fxcancel" }));
  $("nrCurveReset").addEventListener("click", () => { nr.cfg.lo = 100; nr.cfg.hi = 100; nr.cfg.pts = []; nrCurveChanged(); });
  $("nrDefaults").addEventListener("click", () => { const keep = { scale: nr.cfg.scale }; nr.cfg = Object.assign({}, NR_DEF, keep, { pts: [] }); nrSave(); nr.cols = null; nrFetch(false); nrRender(); });
  nrPointer($("nrGraph"));
  window.addEventListener("resize", () => { if (rp.open && rp.tab === "nr") { nr.cols = null; nrDraw(); } });
  document.addEventListener("i18n", () => { if (rp.open && rp.tab === "nr") nrRender(); });
}

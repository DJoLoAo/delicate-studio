const HUM_DEF = { f0: 50, n: 8, q: 30, gain: 30, slope: 0 };
const hum = { cfg: null, listen: "off", job: null, seq: 0, busy: false, again: false, found: null, finding: false, resp: null, respSeq: 0, respT: 0, done: null, err: null };

function humLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioHum") || "null"); } catch {}
  hum.cfg = Object.assign({}, HUM_DEF, v && typeof v === "object" ? v : {});
}

function humSave() {
  try { localStorage.setItem("studioHum", JSON.stringify(hum.cfg)); } catch {}
}

function humWire() { const c = hum.cfg; return { f0: c.f0, n: c.n, q: c.q, gain: c.gain, slope: c.slope }; }

function humRange() {
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function humShow() {
  humRender();
  humResp();
  if (!hum.job && hum.listen === "off") humListen("proc");
}

function humHide() {
  if (hum.listen !== "off") humListen("off");
}

function humDoc() {
  hum.found = null;
  hum.done = null;
  hum.err = null;
  hum.listen = "off";
  if (rp.open && rp.tab === "hum") humShow();
}

function humSend() {
  if (!ed.doc) return;
  if (hum.busy) { hum.again = true; return; }
  hum.busy = true;
  call({ t: "fxcfg", kind: "hum", cfg: humWire(), mode: hum.listen })
    .catch(e => { hum.listen = "off"; hum.err = String(e.message || e); humRender(); })
    .finally(() => { hum.busy = false; if (hum.again) { hum.again = false; humSend(); } });
}

function humListen(mode) {
  hum.listen = mode;
  document.querySelectorAll("#humListen button").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
  humSend();
}

function humChanged() {
  humSave();
  humRender();
  if (hum.listen !== "off") humSend();
  clearTimeout(hum.respT);
  hum.respT = setTimeout(humResp, 60);
}

function humFreqs() {
  const ny = (ed.doc ? ed.doc.sampleRate : 48000) / 2, hi = Math.min(2000, ny * 0.95), out = [];
  for (let i = 0; i <= 360; i++) out.push(20 * Math.pow(hi / 20, i / 360));
  for (let k = 1; k <= hum.cfg.n; k++) { const f = hum.cfg.f0 * k; if (f < hi) out.push(f); }
  return out.sort((a, b) => a - b);
}

async function humResp() {
  if (!ed.doc) return;
  const seq = ++hum.respSeq, freqs = humFreqs();
  try {
    const r = await call({ t: "humresp", cfg: humWire(), mode: "proc", freqs });
    if (seq === hum.respSeq) { hum.resp = { freqs, db: r.db }; humDraw(); }
  } catch {}
}

async function humFind() {
  if (!ed.doc || hum.finding) return;
  const r = humRange();
  const c = hum.cfg, preset = c.f0 >= 49.2 && c.f0 <= 50.8 || c.f0 >= 59.2 && c.f0 <= 60.8;
  hum.finding = true;
  humRender();
  try {
    const f = await call({ t: "humfind", id: ed.doc.id, a: r.sel ? r.a : 0, b: r.sel ? r.b : 0, center: preset ? 0 : c.f0 });
    hum.found = f;
    c.f0 = Math.round(f.f0 * 100) / 100;
    if (f.harmonics >= 1) c.n = f.harmonics;
    humChanged();
  } catch (e) {
    const m = String(e.message || e);
    tell(m === "hum-short" ? t("Select at least a second of audio to look for hum.") : m, t("Find hum"));
  } finally {
    hum.finding = false;
    humRender();
  }
}

async function humApply() {
  if (!ed.doc || hum.job) return;
  const r = humRange();
  if (r.b <= r.a) return;
  const id = "h" + (++hum.seq);
  hum.job = { id, frac: 0 };
  hum.done = null;
  if (hum.listen !== "off") humListen("off");
  humRender();
  try {
    const res = await runEdit({ t: "fxapply", kind: "hum", jobId: id, ra: r.a, rb: r.b, cfg: humWire() }, false, true);
    if (res && res.hist) { hum.done = { a: r.a, b: r.b }; flash(t("DeHummer applied")); }
  } finally {
    hum.job = null;
    humRender();
  }
}

function humProg(m) {
  if (!hum.job || m.id !== hum.job.id) return;
  hum.job.frac = m.frac;
  $("humBar").querySelector("i").style.width = Math.round(m.frac * 100) + "%";
  $("humSum").textContent = t("Processing…") + " " + Math.round(m.frac * 100) + " %";
}

function humRender() {
  const c = hum.cfg;
  if (!c || !$("humBody")) return;
  const r = humRange(), busy = !!hum.job;
  if (document.activeElement !== $("humF0")) $("humF0").value = c.f0.toFixed(2);
  document.querySelectorAll("#humPre button").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === c.f0));
  $("humN").value = c.n;
  $("humNV").textContent = c.n;
  $("humQ").value = c.q;
  $("humQV").textContent = c.q;
  $("humGain").value = c.gain;
  $("humGainV").textContent = c.gain + " dB";
  $("humSlope").value = c.slope;
  $("humSlopeV").textContent = (c.slope > 0 ? "+" : "") + c.slope + " %";
  $("humRange").textContent = (r.sel ? t("Selection") : t("Whole file")) + " · " + fmtTime(r.a) + "–" + fmtTime(r.b);
  $("humFind").disabled = hum.finding || busy;
  $("humFind").textContent = hum.finding ? t("Finding…") : t("Find");
  let info = "";
  const f = hum.found;
  if (f) {
    info = f.harmonics >= 1
      ? t("Found hum at {f} Hz with {n} harmonics standing out.").replace("{f}", (Math.round(f.f0 * 100) / 100).toFixed(2)).replace("{n}", f.harmonics)
      : t("The hum near {f} Hz is faint here. Select a quiet part such as the lead-in groove for a clearer reading.").replace("{f}", (Math.round(f.f0 * 100) / 100).toFixed(2));
  } else info = t("Find measures the exact hum frequency and how many harmonics stand out. Select a quiet part such as the lead-in groove first, or it looks at the first minute.");
  $("humInfo").textContent = info;
  document.querySelectorAll("#humListen button").forEach(b => { b.disabled = b.dataset.v !== "off" && busy; b.classList.toggle("on", b.dataset.v === hum.listen); });
  $("humApply").disabled = busy || !ed.doc || r.b <= r.a;
  $("humCancel").classList.toggle("hidden", !busy);
  $("humBar").classList.toggle("hidden", !busy);
  if (!busy) $("humBar").querySelector("i").style.width = "0%";
  let sum;
  if (busy) sum = t("Processing…") + " " + Math.round(hum.job.frac * 100) + " %";
  else if (hum.err) sum = hum.err;
  else if (hum.done) sum = t("Applied to") + " " + fmtTime(hum.done.a) + "–" + fmtTime(hum.done.b) + ". " + t("Undo brings the original back.");
  else sum = t("Listen to Hum only to hear what would be removed. If bass notes show up there, raise Q or lower Reduce by.");
  $("humSum").textContent = sum;
  humDraw();
}

function humDraw() {
  const cv = $("humGraph");
  if (!cv || !rp.open || rp.tab !== "hum") return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = { L: 30, R: 6, T: 6, B: 15 };
  g.iw = Math.max(10, W - g.L - g.R);
  g.ih = Math.max(10, H - g.T - g.B);
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  x.fillStyle = TH.graph;
  x.fillRect(g.L, g.T, g.iw, g.ih);
  const ny = (ed.doc ? ed.doc.sampleRate : 48000) / 2, hi = Math.min(2000, ny * 0.95);
  const xf = f => g.L + (Math.log(Math.max(20, f)) - Math.log(20)) / (Math.log(hi) - Math.log(20)) * g.iw;
  const span = Math.max(24, Math.ceil((hum.cfg.gain + 6) / 6) * 6);
  const yd = v => g.T + Math.min(1, Math.max(0, -v / span)) * g.ih;
  x.font = thFont(9);
  x.lineWidth = 1;
  x.textBaseline = "middle";
  x.textAlign = "right";
  for (let v = 0; v >= -span; v -= span > 36 ? 12 : 6) {
    const y = Math.round(yd(v)) + 0.5;
    x.strokeStyle = tw(0.06);
    x.beginPath(); x.moveTo(g.L, y); x.lineTo(g.L + g.iw, y); x.stroke();
    x.fillStyle = TH.glabel;
    x.fillText(String(v), g.L - 4, y);
  }
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  for (const f of [50, 100, 200, 500, 1000, 2000]) {
    if (f > hi) continue;
    const xx = Math.round(xf(f)) + 0.5;
    x.strokeStyle = tw(0.06);
    x.beginPath(); x.moveTo(xx, g.T); x.lineTo(xx, g.T + g.ih); x.stroke();
    x.fillStyle = TH.glabel;
    x.fillText(f >= 1000 ? f / 1000 + "k" : String(f), xx, H - 3);
  }
  x.save();
  x.beginPath();
  x.rect(g.L, g.T, g.iw, g.ih);
  x.clip();
  const f = hum.found;
  if (f && f.spec && f.spec.length) {
    let top = -Infinity;
    for (let b = 1; b < f.spec.length; b++) if (b * f.bin >= 20 && b * f.bin <= hi) top = Math.max(top, f.spec[b]);
    x.fillStyle = tc("ggold", 0.18);
    x.beginPath();
    x.moveTo(g.L, g.T + g.ih);
    let last = -1;
    for (let b = 1; b < f.spec.length; b++) {
      const fr = b * f.bin;
      if (fr < 20 || fr > hi) continue;
      const px = xf(fr);
      if (px - last < 0.5) continue;
      last = px;
      x.lineTo(px, g.T + Math.min(1, (top - f.spec[b]) / 60) * g.ih);
    }
    x.lineTo(g.L + g.iw, g.T + g.ih);
    x.closePath();
    x.fill();
  }
  if (hum.resp) {
    x.strokeStyle = TH.gblue;
    x.lineWidth = 1.5;
    x.beginPath();
    hum.resp.freqs.forEach((fr, i) => { const px = xf(fr), py = yd(hum.resp.db[i]); if (i) x.lineTo(px, py); else x.moveTo(px, py); });
    x.stroke();
  }
  x.restore();
}

function wireHum() {
  humLoad();
  const slider = (id, key) => {
    const el = $(id);
    el.addEventListener("input", () => { hum.cfg[key] = Number(el.value); humChanged(); });
    el.addEventListener("change", () => el.blur());
  };
  slider("humN", "n");
  slider("humQ", "q");
  slider("humGain", "gain");
  slider("humSlope", "slope");
  const setF0 = () => {
    const v = Number(String($("humF0").value).replace(",", "."));
    if (Number.isFinite(v) && v >= 10 && v <= 1000) { hum.cfg.f0 = Math.round(v * 100) / 100; hum.found = null; humChanged(); }
    else humRender();
  };
  $("humF0").addEventListener("change", setF0);
  $("humF0").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("humF0").blur(); } e.stopPropagation(); });
  $("humF0").addEventListener("blur", setF0);
  $("humPre").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; hum.cfg.f0 = Number(b.dataset.v); hum.found = null; humChanged(); });
  $("humListen").addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; humListen(b.dataset.v); });
  $("humFind").addEventListener("click", humFind);
  $("humApply").addEventListener("click", humApply);
  $("humCancel").addEventListener("click", () => ed.worker.postMessage({ t: "fxcancel" }));
  $("humDefaults").addEventListener("click", () => { hum.cfg = Object.assign({}, HUM_DEF); hum.found = null; humChanged(); });
  window.addEventListener("resize", () => { if (rp.open && rp.tab === "hum") humDraw(); });
  document.addEventListener("i18n", () => { if (rp.open && rp.tab === "hum") humRender(); });
}

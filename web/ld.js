const LD_DEF = { mode: "loud", preset: "club", target: -9, ceil: -1, style: "punchy", rel: 15, look: 2, peak: -0.1, peakKind: "tp", link: true, gain: 0 };
const LD_STYLES = { gentle: { look: 5, rel: 60 }, punchy: { look: 2, rel: 15 }, loud: { look: 1, rel: 6 } };
const LD_PRESETS = [
  { v: "club", label: "Club, loud master", lufs: -9 },
  { v: "loud", label: "Very loud", lufs: -7 },
  { v: "stream", label: "Streaming", lufs: -14 },
  { v: "apple", label: "Apple Music", lufs: -16 },
  { v: "ebu", label: "Broadcast (EBU R128)", lufs: -23 },
  { v: "custom", label: "Custom", lufs: null },
  { v: "ref", label: "Reference file", lufs: null }
];
const ld = { cfg: null, stats: null, measuring: null, fit: null, fitting: null, job: null, listen: "off", ref: null, seq: 0, busy: false, again: false, err: null, done: null, prog: 0, timer: 0 };

function ldLoad() {
  let v = null, r = null;
  try { v = JSON.parse(localStorage.getItem("studioLoud") || "null"); } catch {}
  try { r = JSON.parse(localStorage.getItem("studioLoudRef") || "null"); } catch {}
  ld.cfg = Object.assign({}, LD_DEF, v && typeof v === "object" ? v : {});
  if (!LD_PRESETS.some(p => p.v === ld.cfg.preset)) ld.cfg.preset = "custom";
  if (!["loud", "norm", "amp"].includes(ld.cfg.mode)) ld.cfg.mode = "loud";
  ld.ref = r && r.stats && Number.isFinite(r.stats.integrated) ? r : null;
}

function ldSave() {
  try { localStorage.setItem("studioLoud", JSON.stringify(ld.cfg)); } catch {}
}

function ldRange() {
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function ldKey() {
  const r = ldRange();
  return ed.doc ? [ed.doc.id, ed.ver, r.a, r.b].join(":") : "";
}

function ldFitKey() {
  const c = ld.cfg;
  return [ldKey(), c.target, c.ceil, c.rel, c.look].join(":");
}

function ldStatsLive() {
  return ld.stats && ld.stats.key === ldKey() ? ld.stats : null;
}

function ldFitLive() {
  return ld.fit && ld.fit.key === ldFitKey() ? ld.fit : null;
}

function ldMax(v) {
  const f = (v || []).filter(x => x !== null && Number.isFinite(x));
  return f.length ? Math.max(...f) : null;
}

function ldGains() {
  const c = ld.cfg, s = ldStatsLive();
  if (c.mode === "amp") return { gain: c.gain, gains: null };
  if (!s) return null;
  if (c.mode === "norm") {
    const pk = c.peakKind === "tp" ? s.tp : s.sp;
    if (c.link || !ed.doc || ed.doc.channels < 2) { const m = ldMax(pk); return m === null ? null : { gain: c.peak - m, gains: null }; }
    if (pk.some(v => v === null)) return null;
    const gains = pk.map(v => c.peak - v);
    return { gain: Math.max(...gains), gains };
  }
  if (s.integrated === null) return null;
  const f = ldFitLive();
  return { gain: f ? f.gain : c.target - s.integrated, gains: null };
}

function ldWire() {
  const c = ld.cfg, g = ldGains() || { gain: 0, gains: null };
  return { gain: g.gain, gains: g.gains, ceil: c.ceil, look: c.look, rel: c.rel, lim: c.mode === "loud" };
}

function ldShow() {
  ldRender();
  ldAuto();
  if (!ld.job && ld.listen === "off") ldListen("proc");
}

function ldHide() {
  if (ld.listen !== "off") ldListen("off");
  clearTimeout(ld.timer);
}

function ldDoc() {
  ld.stats = null;
  ld.fit = null;
  ld.done = null;
  ld.err = null;
  ld.listen = "off";
  if (rp.open && rp.tab === "ld") ldShow();
}

function ldAfterEdit() {
  if (rp.open && rp.tab === "ld") { ldRender(); ldAuto(); }
}

function ldAuto() {
  clearTimeout(ld.timer);
  ld.timer = setTimeout(() => { if (rp.open && rp.tab === "ld" && !ldStatsLive() && !ld.measuring && !ld.job && !ld.fitting) ldMeasure(); }, 250);
}

function ldSend() {
  if (!ed.doc) return;
  if (ld.busy) { ld.again = true; return; }
  ld.busy = true;
  call({ t: "fxcfg", kind: "ld", cfg: ldWire(), mode: ld.listen })
    .catch(e => { ld.listen = "off"; ld.err = String(e.message || e); ldRender(); })
    .finally(() => { ld.busy = false; if (ld.again) { ld.again = false; ldSend(); } });
}

function ldListen(mode) {
  ld.listen = mode;
  document.querySelectorAll("#ldListen button").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
  ldSend();
}

function ldChanged() {
  ldSave();
  ldRender();
  if (ld.listen !== "off") ldSend();
}

function ldErrText(m) {
  if (m === "ld-silent") return t("This range is silent, so there is no loudness to match.");
  if (m === "ld-ref") return t("That file could not be read.");
  if (m === "locked") return t("That file is open in another Studio tab.");
  return m;
}

function ldMeasure() {
  if (!ed.doc) return Promise.resolve();
  if (ld.measuring) return ld.measuring.p;
  const r = ldRange(), key = ldKey(), id = "l" + (++ld.seq);
  ld.prog = 0;
  ld.err = null;
  const p = (async () => {
    try {
      const res = await call({ t: "ldmeasure", id: ed.doc.id, a: r.sel ? r.a : 0, b: r.sel ? r.b : 0, jobId: id });
      if (key === ldKey()) { ld.stats = Object.assign({ key }, res.stats); if (ld.listen !== "off") ldSend(); }
    } catch (e) {
      const m = String(e.message || e);
      if (m !== "cancelled" && m !== "stale") ld.err = ldErrText(m);
    } finally {
      ld.measuring = null;
      ldRender();
      if (rp.open && rp.tab === "ld" && !ldStatsLive() && !ld.err) ldAuto();
    }
  })();
  ld.measuring = { id, key, p };
  ldRender();
  return p;
}

async function ldDoFit() {
  const s = ldStatsLive();
  if (!s || s.integrated === null) throw new Error("ld-silent");
  const r = ldRange(), key = ldFitKey(), id = "f" + (++ld.seq), c = ld.cfg;
  ld.fitting = { id };
  ld.prog = 0;
  ldRender();
  try {
    const res = await call({ t: "ldfit", id: ed.doc.id, a: r.sel ? r.a : 0, b: r.sel ? r.b : 0, lin: s.integrated, target: c.target, cfg: { ceil: c.ceil, rel: c.rel, look: c.look }, jobId: id });
    if (key === ldFitKey()) ld.fit = Object.assign({ key }, res);
    return ld.fit;
  } finally {
    ld.fitting = null;
    ldRender();
  }
}

async function ldCheck() {
  if (!ed.doc || ld.fitting || ld.job) return;
  try {
    if (!ldStatsLive()) await ldMeasure();
    await ldDoFit();
    if (ld.listen !== "off") ldSend();
  } catch (e) {
    const m = String(e.message || e);
    if (m !== "cancelled" && m !== "stale") { ld.err = ldErrText(m); ldRender(); }
  }
}

async function ldApply() {
  if (!ed.doc || ld.job || ld.fitting || ld.measuring) return;
  const r = ldRange();
  if (r.b <= r.a) return;
  ld.err = null;
  ld.done = null;
  try {
    if (ld.cfg.mode !== "amp" && !ldStatsLive()) await ldMeasure();
    if (ld.cfg.mode !== "amp" && !ldStatsLive()) return;
    if (ld.cfg.mode === "loud" && !ldFitLive()) await ldDoFit();
  } catch (e) {
    const m = String(e.message || e);
    if (m !== "cancelled" && m !== "stale") { ld.err = ldErrText(m); ldRender(); }
    return;
  }
  const g = ldGains();
  if (!g) return;
  const id = "a" + (++ld.seq), before = ldStatsLive(), fit = ldFitLive();
  ld.job = { id, frac: 0 };
  if (ld.listen !== "off") ldListen("off");
  ldRender();
  try {
    const res = await runEdit({ t: "fxapply", kind: "ld", op: ld.cfg.mode, jobId: id, ra: r.a, rb: r.b, cfg: ldWire() }, false, true);
    if (res && res.hist) {
      ld.done = { mode: ld.cfg.mode, gain: g.gain, before: before ? before.integrated : null, fit };
      flash(t(ld.cfg.mode === "loud" ? "Loudness matched" : ld.cfg.mode === "norm" ? "Normalized" : "Amplified"));
    }
  } finally {
    ld.job = null;
    ldRender();
    ldAuto();
  }
}

function ldProg(m) {
  const j = ld.job && m.id === ld.job.id ? ld.job : null;
  if (j) j.frac = m.frac;
  else if (!((ld.measuring && m.id === ld.measuring.id) || (ld.fitting && m.id === ld.fitting.id))) return;
  ld.prog = m.frac;
  const bar = $("ldBar");
  if (bar) bar.querySelector("i").style.width = Math.round(m.frac * 100) + "%";
  const sum = $("ldSum");
  if (sum) sum.textContent = ldBusyText();
}

function ldBusyText() {
  const p = " " + Math.round(ld.prog * 100) + " %";
  if (ld.job) return t("Processing…") + p;
  if (ld.fitting) return t("Finding the gain for the target…") + p;
  if (ld.measuring) return t("Measuring…") + p;
  return "";
}

async function ldPickRef() {
  if (!ed.doc) return;
  try { const r = await call({ t: "list" }); ed.docs = r.docs; } catch {}
  const docs = (ed.docs || []).filter(d => d.id !== ed.doc.id);
  if (!docs.length) { tell(t("Open or import the digital file you want to match first, then pick it here."), t("Reference file")); return; }
  const html = `<div class="ldrefs">` + docs.map(d => `<button type="button" class="ldref" data-id="${esc(d.id)}"><span>${esc(d.name)}</span><span class="snote">${esc(((d.sampleRate || 0) / 1000).toLocaleString() + " kHz · " + fmtDur((d.len || d.frames || 0) / (d.sampleRate || 48000)))}</span></button>`).join("") + `</div><div class="dnote">${esc(t("Measured from the file as it was imported."))}</div>`;
  let pick = null;
  const v = await askForm(t("Match the loudness of"), html, { ok: t("measure"), setup: f => f.querySelectorAll(".ldref").forEach(b => b.addEventListener("click", () => { pick = b.dataset.id; f.querySelectorAll(".ldref").forEach(x => x.classList.toggle("on", x === b)); })), read: () => ({ id: pick }) });
  if (!v || !v.id) return;
  if (ld.measuring) await ld.measuring.p;
  const id = "r" + (++ld.seq);
  ld.measuring = { id, key: "ref", p: Promise.resolve() };
  ld.prog = 0;
  ld.err = null;
  ldRender();
  try {
    const res = await call({ t: "ldref", refId: v.id, jobId: id });
    if (res.stats.integrated === null) throw new Error("ld-silent");
    ld.ref = { id: res.ref.id, name: res.ref.name, stats: res.stats };
    try { localStorage.setItem("studioLoudRef", JSON.stringify(ld.ref)); } catch {}
    ld.cfg.preset = "ref";
    ld.cfg.target = Math.round(res.stats.integrated * 10) / 10;
    ld.fit = null;
  } catch (e) {
    const m = String(e.message || e);
    if (m !== "cancelled") ld.err = ldErrText(m);
  } finally {
    ld.measuring = null;
    ldChanged();
  }
}

function ldDb(v, unit) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " " + unit;
}

function ldRender() {
  const c = ld.cfg;
  if (!c || !$("ldBody") || !ed.doc) return;
  const r = ldRange(), s = ldStatsLive(), busy = !!(ld.job || ld.measuring || ld.fitting);
  $("ldRange").textContent = (r.sel ? t("Selection") : t("Whole file")) + " · " + fmtTime(r.a) + "–" + fmtTime(r.b);
  $("ldMeasure").disabled = busy;
  const rows = [
    ["Integrated", s ? ldDb(s.integrated, "LUFS") : "…"],
    ["True peak", s ? ldDb(ldMax(s.tp), "dBTP") : "…"],
    ["Short-term max", s ? ldDb(s.st, "LUFS") : "…"],
    ["Sample peak", s ? ldDb(ldMax(s.sp), "dBFS") : "…"],
    ["Loudness range", s ? (s.lra === null ? "—" : s.lra.toFixed(1) + " LU") : "…"]
  ];
  $("ldStats").innerHTML = rows.map(([k, v]) => `<div class="lst"><span>${esc(t(k))}</span><b>${esc(v)}</b></div>`).join("");
  document.querySelectorAll("#ldMode button").forEach(b => b.classList.toggle("on", b.dataset.v === c.mode));
  document.querySelectorAll("#ldBody .ldloud").forEach(el => el.classList.toggle("hidden", c.mode !== "loud"));
  document.querySelectorAll("#ldBody .ldnorm").forEach(el => el.classList.toggle("hidden", c.mode !== "norm"));
  document.querySelectorAll("#ldBody .ldamp").forEach(el => el.classList.toggle("hidden", c.mode !== "amp"));
  const pd = $("ldTarget");
  const it = LD_PRESETS.find(p => p.v === c.preset) || LD_PRESETS[5];
  pd.querySelector(".cur").textContent = t(it.label);
  pd.dataset.v = it.v;
  if (document.activeElement !== $("ldLufs")) $("ldLufs").value = c.target.toFixed(1);
  $("ldRefInfo").textContent = ld.ref ? ld.ref.name + " · " + ldDb(ld.ref.stats.integrated, "LUFS") + " · " + ldDb(ldMax(ld.ref.stats.tp), "dBTP") : t("Pick a digital file in Studio to match its loudness.");
  $("ldCeil").value = c.ceil;
  $("ldCeilV").textContent = ldDb(c.ceil, "dBTP");
  $("ldRel").value = c.rel;
  $("ldRelV").textContent = c.rel + " ms";
  $("ldLook").value = c.look;
  $("ldLookV").textContent = c.look + " ms";
  $("ldPeak").value = c.peak;
  $("ldPeakV").textContent = ldDb(c.peak, c.peakKind === "tp" ? "dBTP" : "dBFS");
  document.querySelectorAll("#ldStyle button").forEach(b => b.classList.toggle("on", b.dataset.v === c.style));
  document.querySelectorAll("#ldPeakKind button").forEach(b => b.classList.toggle("on", b.dataset.v === c.peakKind));
  document.querySelectorAll("#ldLink button").forEach(b => { b.classList.toggle("on", (b.dataset.v === "link") === c.link); b.disabled = ed.doc.channels === 1; });
  $("ldGain").value = c.gain;
  if (document.activeElement !== $("ldGainN")) $("ldGainN").value = c.gain.toFixed(1);
  $("ldCheck").disabled = busy || !s;
  document.querySelectorAll("#ldListen button").forEach(b => { b.disabled = b.dataset.v !== "off" && !!ld.job; b.classList.toggle("on", b.dataset.v === ld.listen); });
  $("ldApply").disabled = busy || r.b <= r.a || (c.mode !== "amp" && !s);
  $("ldCancel").classList.toggle("hidden", !busy);
  $("ldBar").classList.toggle("hidden", !busy);
  if (!busy) $("ldBar").querySelector("i").style.width = "0%";
  $("ldSum").textContent = busy ? ldBusyText() : ldSummary();
}

function ldSummary() {
  const c = ld.cfg, s = ldStatsLive(), g = ldGains(), f = ldFitLive(), d = ld.done;
  if (ld.err) return ld.err;
  if (d && !f && c.mode === d.mode) {
    const now = s && d.mode === "loud" ? " " + t("Now {v}.").replace("{v}", ldDb(s.integrated, "LUFS")) : "";
    return t("Applied {g}.").replace("{g}", ldDb(d.gain, "dB")) + now + " " + t("Undo brings the original back.");
  }
  if (!s && c.mode !== "amp") return t("Measuring…");
  if (c.mode === "amp") {
    const pk = s ? ldMax(s.sp) : null;
    if (pk !== null && pk + c.gain > 0) return t("Peaks will reach {v}. They are kept in the file, but most formats clip above 0 dBFS. Normalize or Match loudness keep them below.").replace("{v}", ldDb(pk + c.gain, "dBFS"));
    return t("Changes the level by {g}.").replace("{g}", ldDb(c.gain, "dB"));
  }
  if (c.mode === "norm") {
    if (!g) return "";
    return (g.gains ? t("Gains per channel:") + " " + g.gains.map(v => ldDb(v, "dB")).join(" / ") : t("Gain {g}.").replace("{g}", ldDb(g.gain, "dB"))) + " " + t("Loudness becomes {v}.").replace("{v}", ldDb(s.integrated === null ? null : s.integrated + (g.gains ? Math.min(...g.gains) : g.gain), "LUFS"));
  }
  if (s.integrated === null) return t("This range is silent, so there is no loudness to match.");
  if (f) {
    const lim = f.gr > 0.05 ? " " + t("The limiter takes up to {r} off the loudest peaks.").replace("{r}", f.gr.toFixed(1) + " dB") : "";
    if (!f.reached) return t("This audio only gets to {v} before the limiter works very hard (up to {r}). Pick a louder style, raise the ceiling or lower the target.").replace("{v}", ldDb(f.out, "LUFS")).replace("{r}", f.gr.toFixed(1) + " dB");
    return t("Gain {g} reaches {v}.").replace("{g}", ldDb(f.gain, "dB")).replace("{v}", ldDb(f.out, "LUFS")) + lim + (f.sampled ? " " + t("Worked out on samples spread over the file.") : "");
  }
  const need = c.target - s.integrated, tp = ldMax(s.tp);
  const lim = tp !== null && tp + need > c.ceil ? " " + t("The limiter will hold the peaks at {c}.").replace("{c}", ldDb(c.ceil, "dBTP")) : "";
  return t("Needs about {g} to reach {v}.").replace("{g}", ldDb(need, "dB")).replace("{v}", ldDb(c.target, "LUFS")) + lim + " " + t("Check works out the exact gain with the limiter.");
}

function toggleLoud() { if (rp.open && rp.tab === "ld") closeDiag(); else openRepair("ld"); }

function ldOpen(mode) {
  if (!ed.doc) return;
  if (ld.cfg.mode !== mode) { ld.cfg.mode = mode; ld.done = null; ldSave(); }
  if (rp.open && rp.tab === "ld") ldRender(); else openRepair("ld");
}

function wireLoud() {
  ldLoad();
  ddInit($("ldTarget"), LD_PRESETS.map(p => ({ v: p.v, label: p.label })), ld.cfg.preset, v => {
    if (v === "ref") { if (ld.ref) { ld.cfg.preset = "ref"; ld.cfg.target = Math.round(ld.ref.stats.integrated * 10) / 10; ldChanged(); } else ldPickRef(); return; }
    ld.cfg.preset = v;
    const p = LD_PRESETS.find(x => x.v === v);
    if (p && p.lufs !== null) ld.cfg.target = p.lufs;
    ldChanged();
  });
  const num = (id, key, lo, hi, after) => {
    const el = $(id);
    const set = () => {
      const v = Number(String(el.value).replace(",", ".").replace("−", "-"));
      if (Number.isFinite(v)) { ld.cfg[key] = Math.round(Math.max(lo, Math.min(hi, v)) * 10) / 10; if (after) after(); ldChanged(); } else ldRender();
    };
    el.addEventListener("change", set);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } e.stopPropagation(); });
  };
  num("ldLufs", "target", -40, -3, () => { const p = LD_PRESETS.find(x => x.lufs === ld.cfg.target); ld.cfg.preset = p ? p.v : "custom"; });
  num("ldGainN", "gain", -40, 40);
  const slider = (id, key) => {
    const el = $(id);
    el.addEventListener("input", () => { ld.cfg[key] = Number(el.value); ldChanged(); });
    el.addEventListener("change", () => el.blur());
  };
  slider("ldCeil", "ceil");
  slider("ldRel", "rel");
  slider("ldLook", "look");
  for (const id of ["ldRel", "ldLook"]) $(id).addEventListener("input", () => { const s = Object.keys(LD_STYLES).find(k => LD_STYLES[k].rel === ld.cfg.rel && LD_STYLES[k].look === ld.cfg.look); ld.cfg.style = s || "custom"; ldRender(); });
  slider("ldPeak", "peak");
  slider("ldGain", "gain");
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); ldChanged(); });
  seg("ldMode", v => { ld.cfg.mode = v; ld.done = null; });
  seg("ldPeakKind", v => { ld.cfg.peakKind = v; });
  seg("ldStyle", v => { ld.cfg.style = v; Object.assign(ld.cfg, LD_STYLES[v]); });
  seg("ldLink", v => { ld.cfg.link = v === "link"; });
  $("ldListen").addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; ldListen(b.dataset.v); });
  $("ldMeasure").addEventListener("click", () => { ld.stats = null; ldMeasure(); });
  $("ldCheck").addEventListener("click", ldCheck);
  $("ldReport").addEventListener("click", repOpen);
  $("ldRef").addEventListener("click", ldPickRef);
  $("ldApply").addEventListener("click", ldApply);
  $("ldCancel").addEventListener("click", () => { ed.worker.postMessage({ t: "ldcancel" }); ed.worker.postMessage({ t: "fxcancel" }); });
  $("ldDefaults").addEventListener("click", () => { const mode = ld.cfg.mode; ld.cfg = Object.assign({}, LD_DEF, { mode }); ld.fit = null; ldChanged(); });
  document.addEventListener("i18n", () => { if (rp.open && rp.tab === "ld") ldRender(); });
}

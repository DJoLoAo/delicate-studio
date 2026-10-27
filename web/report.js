const RP_PLATFORMS = [
  { v: "spotify", label: "Spotify", lufs: -14, mode: "peak" },
  { v: "spotifyLoud", label: "Spotify, Loud", lufs: -11, mode: "limit" },
  { v: "spotifyQuiet", label: "Spotify, Quiet", lufs: -19, mode: "peak" },
  { v: "apple", label: "Apple Music", lufs: -16, mode: "down" },
  { v: "youtube", label: "YouTube", lufs: -14, mode: "down" },
  { v: "tidal", label: "TIDAL", lufs: -14, mode: "peak" },
  { v: "amazon", label: "Amazon Music", lufs: -14, mode: "peak" },
  { v: "deezer", label: "Deezer", lufs: -15, mode: "peak" },
  { v: "soundcloud", label: "SoundCloud", lufs: -14, mode: "peak" },
  { v: "ebu", label: "EBU R128 broadcast", lufs: -23, mode: "spec", tol: 0.5, tp: -1 },
  { v: "atsc", label: "ATSC A/85 broadcast", lufs: -24, mode: "spec", tol: 2, tp: -2 },
  { v: "podcast", label: "Podcast", lufs: -16, mode: "spec", tol: 1, tp: -1 }
];
const rep = { open: false, r: null, job: null, frac: 0, err: "", plat: "spotify", hover: -1 };

function repLoad() {
  try { const v = localStorage.getItem("studioReportPlat"); if (RP_PLATFORMS.some(p => p.v === v)) rep.plat = v; } catch {}
}

function repDb(v, unit, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d === undefined ? 1 : d) + (unit ? " " + unit : "");
}

function repTp(r) {
  const v = r.chans.map(c => c.tp).filter(x => x !== null);
  return v.length ? Math.max(...v) : null;
}

function repPlat(r, p) {
  const I = r.integrated, tp = repTp(r);
  if (I === null) return { gain: null, after: null, state: "silent", text: t("silent") };
  if (p.mode === "spec") {
    const ok = Math.abs(I - p.lufs) <= p.tol, pk = tp === null || tp <= p.tp;
    const why = [];
    if (!ok) why.push(t("loudness {v}").replace("{v}", repDb(I - p.lufs, "LU") + " " + t("off target")));
    if (!pk) why.push(t("true peak above {v}").replace("{v}", repDb(p.tp, "dBTP")));
    return { gain: p.lufs - I, after: tp, state: ok && pk ? "ok" : "bad", text: ok && pk ? t("meets the spec") : why.join(" · ") };
  }
  let g = p.lufs - I;
  if (g > 0 && p.mode === "down") g = 0;
  if (g > 0 && p.mode === "peak" && tp !== null) g = Math.max(0, Math.min(g, -1 - tp));
  const after = tp === null ? null : tp + g;
  const lim = p.mode === "limit" && after !== null && after > -1;
  let text = Math.abs(g) < 0.05 ? t("plays as it is") : g < 0 ? t("turned down {v}").replace("{v}", repDb(-g, "dB").replace("+", "")) : t("turned up {v}").replace("{v}", repDb(g, "dB").replace("+", ""));
  if (p.mode === "peak" && p.lufs - I > g + 0.05) text += " · " + t("held back by its peaks");
  if (lim) text += " · " + t("the player's limiter catches the peaks");
  const hot = after !== null && after > -1 && !lim;
  if (hot) text += " · " + t("peaks above −1 dBTP can distort in the lossy stream");
  return { gain: g, after: lim ? -1 : after, state: hot ? "warn" : "ok", text };
}

function repRange() {
  const s = ed.sel && ed.sel.b > ed.sel.a;
  return { sel: s, a: s ? ed.sel.a : 0, b: s ? ed.sel.b : ed.doc.frames };
}

async function repOpen() {
  if (!ed.doc) return;
  rep.open = true;
  $("lrep").classList.remove("hidden");
  await repRun();
}

function repClose() {
  rep.open = false;
  $("lrep").classList.add("hidden");
  if (rep.job) ed.worker.postMessage({ t: "repcancel" });
}

async function repRun() {
  if (!ed.doc) return;
  const g = repRange(), id = "rep" + Date.now().toString(36);
  rep.job = { id, doc: ed.doc.id, g };
  rep.frac = 0;
  rep.err = "";
  rep.r = null;
  repRender();
  try {
    const r = await call({ t: "ldreport", id: ed.doc.id, a: g.sel ? g.a : 0, b: g.sel ? g.b : 0, jobId: id });
    if (!rep.job || rep.job.id !== id) return;
    rep.r = Object.assign(r, { doc: ed.doc.id, sel: g.sel, when: new Date() });
  } catch (e) {
    if (!rep.job || rep.job.id !== id) return;
    const m = String(e.message || e);
    rep.err = m === "cancelled" ? "" : m === "nothing" ? t("There is nothing to measure.") : m;
  }
  rep.job = null;
  repRender();
}

function repProg(m) {
  if (!rep.job || m.id !== rep.job.id) return false;
  rep.frac = m.frac;
  const bar = $("lrBar");
  if (bar) bar.querySelector("i").style.width = Math.round(m.frac * 100) + "%";
  return true;
}

function repAt(sec) {
  return `<button class="lrat" data-at="${sec}" title="${esc(t("Go there"))}">${esc(fmtTime(rep.r.a + Math.round(sec * rep.r.sr)))}</button>`;
}

function repChName(k, n) {
  if (n === 1) return t("mono");
  if (n === 2) return k ? "R" : "L";
  return String(k + 1);
}

function repRender() {
  if (!rep.open) return;
  const r = rep.r, busy = !!rep.job;
  $("lrAgain").disabled = busy;
  $("lrCopy").disabled = !r;
  $("lrSave").disabled = !r;
  $("lrBar").classList.toggle("hidden", !busy);
  if (!busy) $("lrBar").querySelector("i").style.width = "0%";
  const name = r ? r.name : ed.doc ? ed.doc.name : "";
  const g = r ? { sel: r.sel, a: r.a, b: r.b } : rep.job ? rep.job.g : null;
  $("lrWhat").textContent = name + (g ? " · " + (g.sel ? t("Selection") : t("Whole file")) + " " + fmtTime(g.a) + "–" + fmtTime(g.b) : "");
  if (!r) {
    $("lrBody").innerHTML = `<div class="snote">${esc(rep.err || (busy ? t("Measuring…") : ""))}</div>`;
    return;
  }
  const big = [
    ["Integrated", repDb(r.integrated, "LUFS")],
    ["Loudness range", r.lra === null ? "—" : r.lra.toFixed(1) + " LU"],
    ["True peak", repDb(repTp(r), "dBTP")],
    ["Short-term max", repDb(r.st, "LUFS"), r.st !== null ? r.stAt : null],
    ["Momentary max", repDb(r.mom, "LUFS"), r.mom !== null ? r.momAt : null]
  ];
  const n = r.chans.length;
  const row = (label, f) => `<tr><th>${esc(t(label))}</th>${r.chans.map(c => `<td>${f(c)}</td>`).join("")}</tr>`;
  const bits = c => c.bits >= 32 ? t("float") : c.bits ? c.bits + " " + t("bit") : "—";
  const p = RP_PLATFORMS.find(x => x.v === rep.plat) || RP_PLATFORMS[0];
  const plats = RP_PLATFORMS.map(q => {
    const o = repPlat(r, q);
    return `<tr class="lrp${q.v === p.v ? " on" : ""}" data-p="${q.v}"><th>${esc(t(q.label))}</th><td>${esc(repDb(q.lufs, "LUFS"))}</td><td>${esc(o.gain === null || q.mode === "spec" ? "—" : repDb(o.gain, "dB"))}</td><td>${esc(repDb(o.after, "dBTP"))}</td><td class="lrs ${o.state}">${esc(o.text)}</td></tr>`;
  }).join("");
  $("lrBody").innerHTML = `<div class="lrbig">${big.map(([k, v, at]) => `<div class="lst"><span>${esc(t(k))}</span><b>${esc(v)}</b>${at !== null && at !== undefined ? repAt(at) : ""}</div>`).join("")}</div>
<canvas id="lrGraph" title="${esc(t("Short-term loudness over time. Click to go there."))}"></canvas>
<div class="lrtw"><table class="lrt"><tr><th></th>${r.chans.map((c, k) => `<th>${esc(repChName(k, n))}</th>`).join("")}</tr>
${row("True peak", c => esc(repDb(c.tp, "dBTP")) + (c.tp !== null ? " " + repAt(c.tpAt) : ""))}
${row("Sample peak", c => esc(repDb(c.sp, "dBFS")) + (c.sp !== null ? " " + repAt(c.spAt) : ""))}
${row("RMS", c => esc(repDb(c.rms, "dBFS")))}
${row("DC offset", c => esc(repDb(c.dc * 100, "%", 3)))}
${row("Clipped runs", c => `<span class="${c.clips ? "lrbad" : ""}">${c.clips}</span>`)}
${row("Over 0 dBFS", c => `<span class="${c.overs ? "lrbad" : ""}">${c.overs}</span>`)}
${row("Bits in use", c => esc(bits(c)))}
</table></div>
<div class="snote">${esc(t("{sr} kHz · {ch} · stored as {b} · {len}").replace("{sr}", (r.sr / 1000).toLocaleString()).replace("{ch}", n === 1 ? t("mono") : n === 2 ? t("stereo") : n + " ch").replace("{b}", r.bits ? r.bits + "-bit" : "—").replace("{len}", fmtDur(r.secs)))}</div>
<div class="lrh">${esc(t("Where it plays"))}</div>
<div class="lrtw"><table class="lrt lrpl"><tr><th></th><th>${esc(t("Target"))}</th><th>${esc(t("Change"))}</th><th>${esc(t("Peak after"))}</th><th></th></tr>${plats}</table></div>
<div class="snote">${esc(t("Published targets as of 2026; the platforms play the file at their level and do not change it. Click a row to draw its target on the graph."))}</div>`;
  repGraph();
}

function repGraph() {
  const cv = $("lrGraph"), r = rep.r;
  if (!cv || !r) return;
  const { g, W, H } = scFit(cv);
  const L = 30, B = 14, T = 6, iw = W - L - 6, ih = H - T - B;
  g.fillStyle = TH.graph;
  g.fillRect(0, 0, W, H);
  const v = r.curve.filter(x => x !== null);
  const p = RP_PLATFORMS.find(x => x.v === rep.plat) || RP_PLATFORMS[0];
  const hi = Math.min(0, Math.ceil((Math.max(p.lufs, ...v, r.integrated ?? -60) + 3) / 6) * 6);
  const lo = Math.max(-72, Math.floor((Math.min(p.lufs, ...v, r.integrated ?? -20) - 6) / 6) * 6);
  const yd = d => T + (hi - Math.max(lo, Math.min(hi, d))) / (hi - lo) * ih;
  const span = Math.max(1, r.secs), xs = s => L + s / span * iw;
  g.font = thFont(9);
  g.textAlign = "right";
  g.textBaseline = "middle";
  g.lineWidth = 1;
  for (let d = hi; d >= lo; d -= 6) {
    const y = Math.round(yd(d)) + 0.5;
    g.strokeStyle = tw(0.06);
    g.beginPath(); g.moveTo(L, y); g.lineTo(L + iw, y); g.stroke();
    g.fillStyle = TH.glabel;
    g.fillText(String(d), L - 4, y);
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].find(s => span / s <= 8) || 3600;
  for (let s = 0; s <= span; s += step) { const x = xs(s); g.fillStyle = TH.glabel; g.textAlign = x > W - 24 ? "right" : "center"; g.fillText(fmtDur(s), Math.min(x, W - 2), H - 2); }
  const line = (d, col, dash) => { if (d === null) return; g.save(); g.setLineDash(dash); g.strokeStyle = col; g.beginPath(); g.moveTo(L, yd(d)); g.lineTo(L + iw, yd(d)); g.stroke(); g.restore(); };
  line(p.lufs, tc("ggold", 0.9), [4, 3]);
  line(r.integrated, tc("gblue", 0.8), [1, 2]);
  g.strokeStyle = TH.gblue;
  g.lineWidth = 1.4;
  g.beginPath();
  let pen = false;
  r.curve.forEach((d, k) => {
    if (d === null) { pen = false; return; }
    const x = xs(k + 3), y = yd(d);
    if (pen) g.lineTo(x, y); else g.moveTo(x, y);
    pen = true;
  });
  g.stroke();
  if (rep.hover >= 0 && r.curve[rep.hover] !== undefined) {
    const x = xs(rep.hover + 3), d = r.curve[rep.hover];
    g.strokeStyle = tw(0.3);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ih); g.stroke();
    g.fillStyle = TH.white || TH.glabel;
    g.textAlign = x > W / 2 ? "right" : "left";
    g.fillText(fmtDur(rep.hover) + "–" + fmtDur(rep.hover + 3) + " · " + repDb(d, "LUFS"), x + (x > W / 2 ? -6 : 6), T + 10);
  }
}

function repText() {
  const r = rep.r;
  if (!r) return "";
  const n = r.chans.length, out = [];
  out.push(t("Loudness report") + " — " + r.name);
  out.push((r.sel ? t("Selection") : t("Whole file")) + " " + fmtTime(r.a) + "–" + fmtTime(r.b) + " · " + (r.sr / 1000).toLocaleString() + " kHz · " + (n === 1 ? t("mono") : n === 2 ? t("stereo") : n + " ch") + " · " + r.when.toISOString().slice(0, 16).replace("T", " "));
  out.push("");
  out.push(t("Integrated") + ": " + repDb(r.integrated, "LUFS"));
  out.push(t("Loudness range") + ": " + (r.lra === null ? "—" : r.lra.toFixed(1) + " LU"));
  out.push(t("True peak") + ": " + repDb(repTp(r), "dBTP"));
  out.push(t("Short-term max") + ": " + repDb(r.st, "LUFS") + (r.st !== null ? " @ " + fmtTime(r.a + Math.round(r.stAt * r.sr)) : ""));
  out.push(t("Momentary max") + ": " + repDb(r.mom, "LUFS") + (r.mom !== null ? " @ " + fmtTime(r.a + Math.round(r.momAt * r.sr)) : ""));
  out.push("");
  r.chans.forEach((c, k) => {
    out.push(repChName(k, n) + ": " + [t("True peak") + " " + repDb(c.tp, "dBTP"), t("Sample peak") + " " + repDb(c.sp, "dBFS"), "RMS " + repDb(c.rms, "dBFS"), t("DC offset") + " " + repDb(c.dc * 100, "%", 3), t("Clipped runs") + " " + c.clips, t("Over 0 dBFS") + " " + c.overs, t("Bits in use") + " " + (c.bits >= 32 ? t("float") : c.bits)].join(" · "));
  });
  out.push("");
  for (const q of RP_PLATFORMS) {
    const o = repPlat(r, q);
    out.push(t(q.label) + " (" + repDb(q.lufs, "LUFS") + "): " + o.text + (q.mode !== "spec" && o.gain !== null ? " · " + repDb(o.gain, "dB") : "") + " · " + t("Peak after") + " " + repDb(o.after, "dBTP"));
  }
  return out.join("\n");
}

async function repCopy() {
  try { await navigator.clipboard.writeText(repText()); flash(t("Report copied")); }
  catch { await tell(t("The browser did not allow copying. Save it as text instead.")); }
}

function repSave() {
  const r = rep.r;
  if (!r) return;
  const base = r.name.replace(/\.[a-z0-9]{2,5}$/i, "");
  const a = document.createElement("a"), url = URL.createObjectURL(new Blob([repText() + "\n"], { type: "text/plain;charset=utf-8" }));
  a.href = url;
  a.download = (xpClean(base + " loudness") || "loudness") + ".txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  flash(t("Saved") + " " + a.download);
}

function repDocChanged() {
  if (!rep.open) return;
  if (!ed.doc) { repClose(); return; }
  if (rep.r && rep.r.doc !== ed.doc.id && !rep.job) { rep.r = null; repRun(); }
}

function wireReport() {
  repLoad();
  $("lrX").addEventListener("click", repClose);
  winDrag($("lrep"), "studioReportPos");
  $("lrAgain").addEventListener("click", repRun);
  $("lrCopy").addEventListener("click", repCopy);
  $("lrSave").addEventListener("click", repSave);
  $("lrBody").addEventListener("click", e => {
    const at = e.target.closest("[data-at]");
    if (at && ed.doc && rep.r && rep.r.doc === ed.doc.id) { jumpTo(rep.r.a + Number(at.dataset.at) * rep.r.sr, false); return; }
    const pr = e.target.closest("tr[data-p]");
    if (pr) { rep.plat = pr.dataset.p; try { localStorage.setItem("studioReportPlat", rep.plat); } catch {} repRender(); }
  });
  $("lrBody").addEventListener("pointermove", e => {
    if (e.target.id !== "lrGraph" || !rep.r) return;
    const b = e.target.getBoundingClientRect(), x = e.clientX - b.left, iw = b.width - 36;
    const s = (x - 30) / iw * Math.max(1, rep.r.secs);
    const k = Math.round(s - 3);
    const h = k >= 0 && k < rep.r.curve.length ? k : -1;
    if (h !== rep.hover) { rep.hover = h; repGraph(); }
  });
  $("lrBody").addEventListener("pointerleave", () => { if (rep.hover >= 0) { rep.hover = -1; repGraph(); } }, true);
  $("lrBody").addEventListener("pointerdown", e => {
    if (e.target.id !== "lrGraph" || !rep.r || !ed.doc || rep.r.doc !== ed.doc.id) return;
    const b = e.target.getBoundingClientRect(), s = Math.max(0, Math.min(rep.r.secs, (e.clientX - b.left - 30) / (b.width - 36) * Math.max(1, rep.r.secs)));
    jumpTo(rep.r.a + s * rep.r.sr, false);
  });
  window.addEventListener("resize", () => { if (rep.open) repGraph(); });
  document.addEventListener("i18n", () => { if (rep.open) repRender(); });
}

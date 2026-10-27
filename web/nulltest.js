const nl = { open: false, other: null, align: true, gain: false, r: null, job: null, err: "", docs: [] };

function nlLoad() {
  try {
    const v = JSON.parse(localStorage.getItem("studioNull") || "null");
    if (v && typeof v === "object") { nl.align = v.align !== false; nl.gain = !!v.gain; nl.other = typeof v.other === "string" ? v.other : null; }
  } catch {}
}

function nlSave() {
  try { localStorage.setItem("studioNull", JSON.stringify({ align: nl.align, gain: nl.gain, other: nl.other })); } catch {}
}

function nlErr(m) {
  return ({
    "null-rate": t("The two files need the same sample rate. Convert one of them first."),
    "null-ch": t("The two files need the same number of channels."),
    "null-self": t("Pick another file to compare with."),
    "null-gone": t("That file is no longer in Studio."),
    recording: t("That file is still recording."),
    nothing: t("There is nothing to compare."),
    locked: t("That file is open in another tab.")
  })[m] || m;
}

function nlOthers() {
  return (nl.docs || []).filter(d => ed.doc && d.id !== ed.doc.id);
}

function nlDocLabel(d) {
  return d.name + " · " + ((d.sampleRate || 0) / 1000).toLocaleString() + " kHz · " + (d.channels === 1 ? t("mono") : d.channels === 2 ? t("stereo") : d.channels + " ch");
}

async function nlOpen() {
  if (!ed.doc) return;
  nl.open = true;
  $("nullw").classList.remove("hidden");
  try { nl.docs = (await call({ t: "list" })).docs; ed.docs = nl.docs; } catch { nl.docs = ed.docs || []; }
  const others = nlOthers();
  if (!others.some(d => d.id === nl.other)) {
    const same = others.find(d => d.sampleRate === ed.doc.sampleRate && d.channels === ed.doc.channels);
    nl.other = same ? same.id : others.length ? others[0].id : null;
  }
  nl.r = null;
  nl.err = "";
  nlRender();
}

function nlClose() {
  nl.open = false;
  $("nullw").classList.add("hidden");
  if (nl.job) ed.worker.postMessage({ t: "nullcancel" });
}

function nlRange() {
  const s = ed.sel && ed.sel.b > ed.sel.a;
  return { sel: s, a: s ? ed.sel.a : 0, b: s ? ed.sel.b : ed.doc.frames };
}

async function nlRun(make) {
  if (!ed.doc || !nl.other || nl.job) return;
  const g = nlRange(), id = "nul" + Date.now().toString(36);
  nl.job = { id, make: !!make };
  nl.err = "";
  if (!make) nl.r = null;
  nlRender();
  let r = null;
  try {
    r = await call({ t: "nulltest", id: ed.doc.id, other: nl.other, a: g.sel ? g.a : 0, b: g.sel ? g.b : 0, align: nl.align, gain: nl.gain, make: !!make, jobId: id });
  } catch (e) {
    const m = String(e.message || e);
    nl.err = m === "cancelled" ? "" : nlErr(m);
  }
  nl.job = null;
  if (r) {
    r.doc = ed.doc.id;
    r.sel = g.sel;
    if (r.made) {
      nlRender();
      await openDoc(r.made.id);
      if (typeof refreshFiles === "function") refreshFiles();
      flash(t("The difference is open as a new file") + ": " + r.made.name);
      nlClose();
      return;
    }
    nl.r = r;
  }
  nlRender();
}

function nlProg(m) {
  if (!nl.job || m.id !== nl.job.id) return false;
  const bar = $("nlBar");
  if (bar) bar.querySelector("i").style.width = Math.round(m.frac * 100) + "%";
  return true;
}

function nlAt(f) {
  return f >= 0 ? `<button class="lrat" data-f="${f}" title="${esc(t("Go there"))}">${esc(fmtTime(f))}</button>` : "—";
}

function nlVerdict(r) {
  const all0 = r.chans.every(c => c.zero), leveled = Math.abs(r.gain) > 1e-9;
  const below = rel => rel > 0.05 ? t("{r} louder than the file").replace("{r}", repDb(rel, "dB").replace("+", "")) : t("{r} below the file").replace("{r}", repDb(-rel, "dB").replace("+", ""));
  if (all0 && leveled) return { cls: "ok", text: t("Identical once the level is matched ({g}).").replace("{g}", repDb(r.gain, "dB", 2)) };
  if (all0 && r.overlap < r.b - r.a) return { cls: "ok", text: t("Bit-identical where they overlap.") };
  if (all0 && r.sel) return { cls: "ok", text: t("Bit-identical in this range.") };
  if (all0 && r.lag === 0 && r.lenA === r.lenB) return { cls: "ok", text: t("Bit-identical. Every sample is the same.") };
  if (all0) return { cls: "ok", text: t("Bit-identical once lined up.") };
  const pk = Math.max(...r.chans.map(c => c.peak === null ? -Infinity : c.peak));
  if (pk <= -138) return { cls: "ok", text: t("Identical except for rounding: the difference stays below {v}.").replace("{v}", repDb(pk, "dBFS")) };
  const rel = Math.max(...r.chans.map(c => c.rel === null ? -Infinity : c.rel));
  if (rel <= -60) return { cls: "warn", text: t("Nearly identical: the difference peaks at {v}, {r}.").replace("{v}", repDb(pk, "dBFS")).replace("{r}", below(rel)) };
  return { cls: "bad", text: t("They differ: the difference peaks at {v}, {r}.").replace("{v}", repDb(pk, "dBFS")).replace("{r}", rel === -Infinity ? "—" : below(rel)) };
}

function nlRender() {
  if (!nl.open) return;
  const busy = !!nl.job, others = nlOthers();
  const items = others.map(d => ({ v: d.id, label: nlDocLabel(d) }));
  fxDd($("nlOther"), items.length ? items : [{ v: "", label: t("Open or import a second file first") }], v => { if (!v) return; nl.other = v; nl.r = null; nlSave(); nlRender(); });
  const cur = others.find(d => d.id === nl.other);
  $("nlOther").querySelector(".cur").textContent = cur ? nlDocLabel(cur) : t("Open or import a second file first");
  document.querySelectorAll("#nlAlign button").forEach(b => b.classList.toggle("on", (b.dataset.v === "on") === nl.align));
  document.querySelectorAll("#nlGain button").forEach(b => b.classList.toggle("on", (b.dataset.v === "on") === nl.gain));
  const g = ed.doc ? nlRange() : null;
  $("nlWhat").textContent = ed.doc ? ed.doc.name + " · " + (g.sel ? t("Selection") : t("Whole file")) + " " + fmtTime(g.a) + "–" + fmtTime(g.b) : "";
  $("nlGo").disabled = busy || !cur;
  $("nlMake").disabled = busy || !nl.r;
  $("nlBar").classList.toggle("hidden", !busy);
  if (!busy) $("nlBar").querySelector("i").style.width = "0%";
  const r = nl.r;
  if (!r) {
    $("nlBody").innerHTML = `<div class="snote">${esc(nl.err || (busy ? t("Comparing…") : t("Studio subtracts the other file from this one, sample by sample. What is left is the difference: silence means they are the same.")))}</div>`;
    return;
  }
  const v = nlVerdict(r), sr = r.sr, n = r.chans.length;
  const ms = x => (x / sr * 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " ms";
  const lagText = !nl.align ? t("not lined up, compared as they are") : !r.aligned ? t("could not line them up, compared as they are") : r.lag === 0 ? t("already in line") : (r.lag > 0 ? t("{f} starts {n} samples ({ms}) later") : t("{f} starts {n} samples ({ms}) earlier")).replace("{f}", r.other.name).replace("{n}", Math.abs(r.lag).toLocaleString()).replace("{ms}", ms(Math.abs(r.lag)));
  const notes = [];
  if (r.overlap < r.b - r.a) notes.push(t("{s} of this file have nothing to compare with in the other.").replace("{s}", fmtDur((r.b - r.a - r.overlap) / sr)));
  if (r.lenB !== r.lenA && !r.sel) notes.push(t("The other file is {s} {w}.").replace("{s}", fmtTime(Math.abs(r.lenB - r.lenA))).replace("{w}", r.lenB > r.lenA ? t("longer") : t("shorter")));
  const row = (label, f) => `<tr><th>${esc(t(label))}</th>${r.chans.map(c => `<td>${f(c)}</td>`).join("")}</tr>`;
  $("nlBody").innerHTML = `<div class="nlverd ${v.cls}">${esc(v.text)}</div>
<div class="lrbig"><div class="lst"><span>${esc(t("Offset"))}</span><b>${esc(lagText)}</b></div>${nl.gain ? `<div class="lst"><span>${esc(t("Gain matched"))}</span><b>${esc(repDb(r.gain, "dB", 3))}</b></div>` : ""}</div>
<div class="lrtw"><table class="lrt"><tr><th></th>${r.chans.map((c, k) => `<th>${esc(repChName(k, n))}</th>`).join("")}</tr>
${row("Difference peak", c => c.zero ? "—" : esc(repDb(c.peak, "dBFS")) + " " + nlAt(c.peakAt))}
${row("Difference RMS", c => c.zero ? "—" : esc(repDb(c.rms, "dBFS")))}
${row("Below the file", c => c.zero ? esc(t("silent")) : c.rel === null ? "—" : esc(c.rel > 0.05 ? t("{r} louder").replace("{r}", repDb(c.rel, "dB").replace("+", "")) : repDb(-c.rel, "dB").replace("+", "")))}
${row("First difference", c => c.zero ? "—" : nlAt(c.first))}
</table></div>
${notes.map(x => `<div class="snote">${esc(x)}</div>`).join("")}`;
}

function nlDocChanged() {
  if (!nl.open) return;
  if (!ed.doc) { nlClose(); return; }
  if (nl.r && nl.r.doc !== ed.doc.id) { nl.r = null; nlRender(); }
}

function wireNull() {
  nlLoad();
  $("nlX").addEventListener("click", nlClose);
  winDrag($("nullw"), "studioNullPos");
  $("nlGo").addEventListener("click", () => nlRun(false));
  $("nlMake").addEventListener("click", () => nlRun(true));
  $("nlAlign").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; nl.align = b.dataset.v === "on"; nl.r = null; nlSave(); nlRender(); });
  $("nlGain").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; nl.gain = b.dataset.v === "on"; nl.r = null; nlSave(); nlRender(); });
  $("nlBody").addEventListener("click", e => {
    const at = e.target.closest("[data-f]");
    if (at && ed.doc && nl.r && nl.r.doc === ed.doc.id) jumpTo(Number(at.dataset.f), false);
  });
  document.addEventListener("i18n", () => { if (nl.open) nlRender(); });
}

const TX_CHUNK = 30, TX_LOOK = 5, TX_RATE = 16000;
const TX_LANGS = [
  { v: "auto", label: "Detect the language" }, { v: "de", label: "Deutsch" }, { v: "en", label: "English" }, { v: "fr", label: "Français" },
  { v: "es", label: "Español" }, { v: "it", label: "Italiano" }, { v: "pt", label: "Português" }, { v: "hi", label: "हिन्दी" },
  { v: "nl", label: "Nederlands" }, { v: "pl", label: "Polski" }, { v: "tr", label: "Türkçe" }, { v: "ja", label: "日本語" }
];
const tx = { open: false, loading: false, doc: "", data: null, job: null, q: "", lang: "auto", prompt: "", timer: 0, now: -1, follow: true };

function txLoadCfg() {
  try { const c = JSON.parse(localStorage.getItem("studioTx") || "{}"); if (TX_LANGS.some(l => l.v === c.lang)) tx.lang = c.lang; tx.prompt = String(c.prompt || "").slice(0, 400); } catch {}
}

function txSaveCfg() { try { localStorage.setItem("studioTx", JSON.stringify({ lang: tx.lang, prompt: tx.prompt })); } catch {} }

function txT(f, sr, sep) {
  const ms = Math.max(0, Math.round(f / sr * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000, p = (v, n) => String(v).padStart(n || 2, "0");
  return p(h) + ":" + p(m) + ":" + p(s) + sep + p(r, 3);
}

function txShort(f, sr) {
  const s = Math.max(0, Math.round(f / sr)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s % 60).padStart(2, "0");
}

async function txLoad() {
  if (!ed.doc || tx.loading) return;
  if (tx.doc === ed.doc.id && tx.data) return;
  const id = ed.doc.id;
  tx.loading = true;
  tx.doc = id;
  tx.data = null;
  let d = null;
  try { d = (await call({ t: "txget", id })).tx; } catch {}
  tx.loading = false;
  if (tx.doc === id) tx.data = d;
}

async function txShow() {
  tx.open = true;
  await txLoad();
  txRender();
  clearInterval(tx.timer);
  tx.timer = setInterval(txTick, 150);
}

function txHide() {
  tx.open = false;
  clearInterval(tx.timer);
  tx.timer = 0;
}

function txRange() {
  const d = ed.doc, on = ed.sel.b > ed.sel.a;
  return on ? { a: Math.floor(ed.sel.a), b: Math.floor(ed.sel.b), sel: true } : { a: 0, b: d.frames, sel: false };
}

async function txMono(d, a, b) {
  const n = b - a, out = new Float32Array(n), STEP = 1 << 20;
  for (let s = a; s < b; s += STEP) {
    const k = Math.min(STEP, b - s), r = await call({ t: "read", id: d.id, start: s, count: k }), g = r.count, ch = d.channels;
    for (let i = 0; i < g; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += r.data[c * g + i];
      out[s - a + i] = v / ch;
    }
  }
  return out;
}

function txCut(x, sr, from) {
  const W = Math.max(1, Math.round(sr / 20));
  let best = x.length, low = Infinity;
  for (let s = Math.max(0, from); s + W <= x.length; s += W) {
    let e = 0;
    for (let i = s; i < s + W; i++) e += x[i] * x[i];
    if (e < low) { low = e; best = s + (W >> 1); }
  }
  return best;
}

async function txWav(x, sr) {
  const len = Math.max(1, Math.ceil(x.length * TX_RATE / sr)), oc = new OfflineAudioContext(1, len, TX_RATE);
  const buf = oc.createBuffer(1, x.length, sr);
  buf.copyToChannel(x, 0);
  const src = oc.createBufferSource();
  src.buffer = buf;
  src.connect(oc.destination);
  src.start();
  const y = (await oc.startRendering()).getChannelData(0), out = new ArrayBuffer(44 + y.length * 2), v = new DataView(out);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); v.setUint32(4, 36 + y.length * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, TX_RATE, true); v.setUint32(28, TX_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, y.length * 2, true);
  for (let i = 0; i < y.length; i++) { const s = Math.max(-1, Math.min(1, y[i])); v.setInt16(44 + i * 2, Math.round(s * 32767), true); }
  return out;
}

function txErr(code, body) {
  const e = body && body.error;
  if (code === 401) return t("Log in again to transcribe.");
  if (e === "offline") return t("The transcription service on the server is not running.");
  if (e === "busy") return t("The server is busy with other transcriptions. Try again in a few minutes.");
  return t("The server could not transcribe this part") + " (" + code + (e ? " " + e : "") + ")";
}

async function txRun() {
  if (!ed.doc || tx.job) return;
  const d = ed.doc, sr = d.sampleRate, R = txRange(), segs = [];
  if (R.b - R.a < sr * 0.5) { flash(t("Too short to transcribe.")); return; }
  const job = { cancel: false, frac: 0 };
  tx.job = job;
  txRender();
  let lang = "", prompt = tx.prompt;
  try {
    for (let a = R.a; a < R.b && !job.cancel;) {
      const end = Math.min(R.b, a + TX_CHUNK * sr), x = await txMono(d, a, end);
      const cut = end < R.b ? txCut(x, sr, x.length - TX_LOOK * sr) : x.length, b = a + cut;
      const wav = await txWav(x.subarray(0, cut), sr);
      if (job.cancel || !ed.doc || ed.doc.id !== d.id) break;
      const q = "?lang=" + encodeURIComponent(lang || tx.lang) + (prompt ? "&prompt=" + encodeURIComponent(prompt.slice(-200)) : "");
      const r = await fetch("/api/studio/transcribe" + q, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      let j = null;
      try { j = await r.json(); } catch {}
      if (!r.ok || !j) throw new Error(txErr(r.status, j));
      if (!lang && j.language && tx.lang === "auto") lang = j.language;
      for (const s of j.segments || []) {
        const text = String(s.text || "").trim();
        if (!text) continue;
        const fa = a + Math.round(s.a * sr), fb = Math.min(b, a + Math.round(s.b * sr));
        const words = (s.words || []).map(w => ({ w: String(w.w), a: a + Math.round(w.a * sr), b: Math.min(b, a + Math.round(w.b * sr)), p: Math.round((w.p || 0) * 100) / 100 })).filter(w => w.w.trim());
        segs.push({ a: fa, b: Math.max(fa, fb), text, words });
        prompt = (prompt + " " + text).slice(-400);
      }
      a = b;
      job.frac = (a - R.a) / (R.b - R.a);
      txProg();
    }
    if (job.cancel) { flash(t("Transcription cancelled")); return; }
    const keep = tx.data && R.sel && tx.doc === d.id ? tx.data.segs.filter(s => s.b <= R.a || s.a >= R.b) : [];
    const data = { v: 1, lang: lang || tx.lang, made: Date.now(), hist: ed.histIdx, sr, segs: keep.concat(segs).sort((x, y) => x.a - y.a) };
    await call({ t: "txput", id: d.id, tx: data });
    if (ed.doc && ed.doc.id === d.id) { tx.doc = d.id; tx.data = data; }
    flash(t("{n} lines transcribed").replace("{n}", segs.length));
  } catch (e) { tell(String(e.message || e), t("Could not transcribe")); }
  finally { if (tx.job === job) tx.job = null; txRender(); }
}

function txProg() {
  const j = tx.job, bar = $("txBar");
  if (!bar) return;
  bar.classList.toggle("hidden", !j);
  bar.firstElementChild.style.width = j ? Math.round(j.frac * 100) + "%" : "0";
}

function txSeek(f) {
  if (!ed.doc) return;
  if (ed.play.on) startPlay(f);
  else { ed.cursor = f; ensureVisible(f); redraw(); }
}

function txMatch(s) { const q = tx.q.trim().toLowerCase(); return !q || s.text.toLowerCase().includes(q) || s.words.some(w => w.w.toLowerCase().includes(q)); }

function txRender() {
  const body = $("txBody");
  if (!body || !tx.open) return;
  const d = ed.doc;
  if (d && tx.doc !== d.id) { txLoad().then(() => { if (tx.open && ed.doc && tx.doc === ed.doc.id) txRender(); }); }
  const D = tx.data && d && tx.doc === d.id ? tx.data : null;
  $("txRangeT").textContent = d ? (ed.sel.b > ed.sel.a ? t("Selection") + " · " + fmtDur((ed.sel.b - ed.sel.a) / d.sampleRate) : t("Whole file") + " · " + fmtDur(d.frames / d.sampleRate)) : "";
  $("txGo").disabled = !!tx.job || !d;
  $("txCancel").classList.toggle("hidden", !tx.job);
  txProg();
  const has = !!(D && D.segs.length);
  for (const id of ["txSrt", "txVtt", "txTxt", "txMarks", "txClear"]) $(id).disabled = !has;
  const note = $("txNote");
  note.textContent = tx.job ? t("Transcribing on the Studio server…") : !D ? t("Speech to text runs on the Studio server with Whisper. The audio goes to your own server only.") : (D.hist !== ed.histIdx ? t("The file was edited after the transcript was made; times may be off.") + " " : "") + t("{n} lines · language {l}").replace("{n}", D.segs.length).replace("{l}", D.lang || "?");
  const list = $("txList");
  list.textContent = "";
  if (!D) return;
  const q = tx.q.trim().toLowerCase();
  let shown = 0;
  D.segs.forEach((s, i) => {
    if (!txMatch(s)) return;
    shown++;
    const row = document.createElement("div");
    row.className = "txseg";
    row.dataset.i = i;
    const tb = document.createElement("button");
    tb.className = "txt";
    tb.type = "button";
    tb.textContent = txShort(s.a, D.sr);
    tb.addEventListener("click", () => txSeek(s.a));
    row.appendChild(tb);
    const p = document.createElement("span");
    p.className = "txp";
    const words = s.words.length ? s.words : [{ w: s.text, a: s.a, b: s.b, p: 1 }];
    words.forEach(w => {
      const sp = document.createElement("span");
      sp.className = "txw" + (w.p < 0.4 ? " low" : "") + (q && w.w.toLowerCase().includes(q) ? " hit" : "");
      sp.textContent = w.w;
      sp.dataset.a = w.a;
      sp.addEventListener("click", () => txSeek(w.a));
      p.appendChild(sp);
    });
    row.appendChild(p);
    list.appendChild(row);
  });
  if (!shown) list.appendChild(Object.assign(document.createElement("div"), { className: "snote", textContent: t("Nothing found") }));
  tx.now = -1;
  txTick();
}

function txTick() {
  if (tx.open && ed.doc && tx.doc !== ed.doc.id && !tx.loading) { txRender(); return; }
  if (!tx.open || !ed.doc || !tx.data || tx.doc !== ed.doc.id) return;
  const f = ed.play.on ? playhead() : ed.cursor, S = tx.data.segs;
  let i = -1;
  for (let k = 0; k < S.length; k++) { if (S[k].a <= f) i = k; else break; }
  if (i >= 0 && f > S[i].b + tx.data.sr * 2) i = -1;
  const list = $("txList");
  if (i !== tx.now) {
    list.querySelectorAll(".txseg.now").forEach(e => e.classList.remove("now"));
    const row = list.querySelector('.txseg[data-i="' + i + '"]');
    if (row) { row.classList.add("now"); if (ed.play.on && tx.follow) row.scrollIntoView({ block: "nearest" }); }
    tx.now = i;
  }
  list.querySelectorAll(".txw.on").forEach(e => e.classList.remove("on"));
  if (i >= 0) {
    const row = list.querySelector('.txseg[data-i="' + i + '"]');
    if (row) { let on = null; for (const w of row.querySelectorAll(".txw")) { if (Number(w.dataset.a) <= f) on = w; else break; } if (on) on.classList.add("on"); }
  }
}

function txName(ext) { return (ed.doc ? ed.doc.name.replace(/\.[^.]+$/, "") : "transcript") + "." + ext; }

function txFile(kind) {
  const D = tx.data;
  if (!D || !D.segs.length) return;
  let text = "";
  if (kind === "srt") text = D.segs.map((s, i) => (i + 1) + "\n" + txT(s.a, D.sr, ",") + " --> " + txT(s.b, D.sr, ",") + "\n" + s.text + "\n").join("\n");
  else if (kind === "vtt") text = "WEBVTT\n\n" + D.segs.map(s => txT(s.a, D.sr, ".") + " --> " + txT(s.b, D.sr, ".") + "\n" + s.text + "\n").join("\n");
  else text = D.segs.map(s => "[" + txShort(s.a, D.sr) + "] " + s.text).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([text], { type: kind === "vtt" ? "text/vtt" : "text/plain" })), a = document.createElement("a");
  a.href = url;
  a.download = txName(kind);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function txMarks() {
  const D = tx.data;
  if (!D || !D.segs.length || !ed.doc) return;
  const n = D.segs.length;
  if (n > 200 && !(await ask(t("Add {n} markers?").replace("{n}", n), t("One point marker per line of the transcript."), { ok: t("add") }))) return;
  const r = await runEdit({ t: "edit", op: "markpoints", points: D.segs.map(s => ({ a: s.a, name: s.text })) }, false, true);
  if (r) flash(t("{n} markers added").replace("{n}", n));
}

async function txClear() {
  if (!tx.data || !ed.doc) return;
  if (!(await ask(t("Remove the transcript?"), t("The transcript of this file is deleted. The audio stays as it is."), { ok: t("remove") }))) return;
  await call({ t: "txput", id: ed.doc.id, tx: null });
  tx.data = null;
  txRender();
}

function txInit() {
  txLoadCfg();
  ddInit($("txLang"), TX_LANGS, tx.lang, v => { tx.lang = v; txSaveCfg(); });
  $("txPrompt").value = tx.prompt;
  $("txGo").addEventListener("click", txRun);
  $("txCancel").addEventListener("click", () => { if (tx.job) tx.job.cancel = true; });
  $("txPrompt").addEventListener("change", () => { tx.prompt = $("txPrompt").value.slice(0, 400); txSaveCfg(); });
  $("txPrompt").addEventListener("keydown", e => e.stopPropagation());
  $("txQ").addEventListener("input", () => { tx.q = $("txQ").value; txRender(); });
  $("txQ").addEventListener("keydown", e => e.stopPropagation());
  $("txSrt").addEventListener("click", () => txFile("srt"));
  $("txVtt").addEventListener("click", () => txFile("vtt"));
  $("txTxt").addEventListener("click", () => txFile("txt"));
  $("txMarks").addEventListener("click", txMarks);
  $("txClear").addEventListener("click", txClear);
}

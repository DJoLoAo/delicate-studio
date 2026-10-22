const REC_DEF = { dev: "", chans: "1-2", rate: "device", monitor: false, pre: 2, autoStart: false, autoStop: false, thr: -45, after: 5 };
const REC_RING = 1 << 21;
const REC_RATES = ["device", "44100", "48000", "88200", "96000", "176400", "192000"];
const rc = { cfg: null, open: false, worker: null, ctx: null, stream: null, nodes: [], mon: null, devs: [], devChans: 2, devRate: 0, sr: 0, ch: 0, phase: "idle", frames: 0, marks: 0, dropped: 0, err: null, note: null, label: "", busy: false, meter: null, live: [], liveSr: 0, free: null, freeT: 0, raf: 0, last: null, src: null, tok: 0, extMon: true, take: "" };

function recLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioRec") || "null"); } catch {}
  rc.cfg = Object.assign({}, REC_DEF, v && typeof v === "object" ? v : {});
  if (!REC_RATES.includes(String(rc.cfg.rate))) rc.cfg.rate = "device";
  rc.cfg.rate = String(rc.cfg.rate);
  if (![0, 2, 5, 10].includes(rc.cfg.pre)) rc.cfg.pre = 2;
  if (![3, 5, 10, 20].includes(rc.cfg.after)) rc.cfg.after = 5;
  rc.cfg.thr = Math.max(-70, Math.min(-20, Number(rc.cfg.thr) || -45));
}

function recSave() {
  try { localStorage.setItem("studioRec", JSON.stringify(rc.cfg)); } catch {}
}

function recBusy() { return rc.phase === "rec" || rc.phase === "wait"; }

function recPending() { return !!(rc.src && rc.src.pending); }

function recMonOn() { return rc.src && rc.src.kind === "ext" ? rc.extMon : rc.cfg.monitor; }

function recCanShare() { return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !window.matchMedia("(pointer: coarse)").matches; }

function recSrcName(s) {
  if (s.kind === "ext") return t("Tab") + (s.title ? ": " + s.title : "");
  return s.surf === "monitor" ? t("Screen") : s.surf === "window" ? t("Window") : t("Browser tab");
}

async function recGranted() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state === "granted"; } catch { return false; }
}

function recWire() {
  const c = rc.cfg;
  return { pre: c.pre, autoStart: c.autoStart, autoStop: c.autoStop, thr: c.thr, after: c.after };
}

function recWorker() {
  if (rc.worker) return rc.worker;
  rc.worker = new Worker("/rec-worker.js");
  rc.worker.onmessage = e => recMsg(e.data);
  return rc.worker;
}

function recErr(m) {
  if (m === "quota") return t("Browser storage is full. The recording was saved up to this point.");
  if (m === "input") return t("Choose an input first.");
  if (m === "busy") return t("A recording is running.");
  return m;
}

function recMsg(m) {
  if (m.t === "rstat") {
    const was = rc.phase;
    rc.phase = m.phase;
    rc.frames = m.frames;
    rc.marks = m.marks;
    rc.dropped = m.dropped;
    if (was === "wait" && m.phase === "rec") rc.live = [];
    recTop();
    recRender();
    return;
  }
  if (m.t === "rpk") { for (const v of m.pk) rc.live.push(v); return; }
  if (m.t === "rdone") { recDone(m); return; }
  if (m.t === "rerror") { rc.err = recErr(m.msg); recRender(); return; }
  if (m.t === "rrecovered") {
    if (!m.list.length) return;
    refreshFiles();
    tell(m.list.map(r => r.name + " · " + fmtDur(r.frames / r.sampleRate)).join("\n"), t("Recovered an interrupted recording"));
  }
}

function recMap() {
  const n = rc.devChans, c = String(rc.cfg.chans);
  const pair = c.match(/^(\d+)-(\d+)$/);
  if (pair) { const a = +pair[1] - 1; if (a + 1 < n) return [a, a + 1]; }
  else if (/^\d+$/.test(c) && +c >= 1 && +c <= n) return [+c - 1];
  return n >= 2 ? [0, 1] : [0];
}

function recChoices() {
  const n = rc.devChans, out = [];
  for (let i = 1; i < n; i += 2) out.push({ v: i + "-" + (i + 1), label: i + "–" + (i + 1) + " " + t("stereo") });
  for (let i = 1; i <= n; i++) out.push({ v: String(i), label: i + " " + t("mono") });
  return out;
}

function recDd(el, items, value, onChange) {
  const key = JSON.stringify([items, value]);
  if (el._k === key) return;
  el._k = key;
  const cur = el.querySelector(".cur"), list = el.querySelector(".list");
  const it = items.find(i => i.v === value) || items[0];
  cur.textContent = it ? it.label : "";
  el.dataset.v = it ? it.v : "";
  list.innerHTML = "";
  for (const i of items) {
    const d = document.createElement("div");
    d.className = "ddi";
    d.textContent = i.label;
    d.dataset.v = i.v;
    d.addEventListener("click", ev => { ev.stopPropagation(); el.classList.remove("open"); onChange(i.v); });
    list.appendChild(d);
  }
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    cur.addEventListener("click", ev => {
      ev.stopPropagation();
      if (el.classList.contains("off")) return;
      document.querySelectorAll(".dd.open").forEach(o => { if (o !== el) o.classList.remove("open"); });
      el.classList.toggle("open");
    });
  }
}

async function recDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    rc.devs = all.filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d, i) => ({ v: d.deviceId, label: d.label || t("Input") + " " + (i + 1) }));
  } catch { rc.devs = []; }
}

function recStopInput() {
  rc.tok++;
  rc.src = null;
  for (const n of rc.nodes) { try { n.disconnect(); } catch {} }
  rc.nodes = [];
  rc.mon = null;
  if (rc.stream) for (const tr of rc.stream.getTracks()) { try { tr.stop(); } catch {} }
  rc.stream = null;
  if (rc.ctx) { try { rc.ctx.close(); } catch {} }
  rc.ctx = null;
  rc.meter = null;
  if (rc.worker) rc.worker.postMessage({ t: "disarm" });
  if (!recBusy()) rc.phase = "idle";
}

async function recDevStream() {
  const c = rc.cfg;
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 8 } };
  if (c.dev) audio.deviceId = { exact: c.dev };
  if (c.rate !== "device") audio.sampleRate = { ideal: Number(c.rate) };
  try { return { stream: await navigator.mediaDevices.getUserMedia({ audio }), src: null }; }
  catch (e) {
    if (!(c.dev && (e.name === "OverconstrainedError" || e.name === "NotFoundError"))) throw e;
    c.dev = "";
    recSave();
    delete audio.deviceId;
    return { stream: await navigator.mediaDevices.getUserMedia({ audio }), src: null };
  }
}

async function recDisplayStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }, selfBrowserSurface: "exclude", systemAudio: "include", surfaceSwitching: "exclude", preferCurrentTab: false });
  const v = stream.getVideoTracks()[0], surf = v && v.getSettings ? v.getSettings().displaySurface || "" : "";
  for (const tr of stream.getVideoTracks()) tr.stop();
  if (!stream.getAudioTracks().length) {
    for (const tr of stream.getTracks()) tr.stop();
    throw new Error(t("No sound was shared. Pick a tab and keep sharing its audio switched on."));
  }
  return { stream, src: { kind: "display", surf } };
}

function recExtErr(e) {
  const s = String(e || "");
  if (/active stream/i.test(s)) return t("This tab is already being recorded.");
  if (s === "gone" || s === "none") return t("The tab to record was closed.");
  if (/chrome:|chrome pages|cannot be captured/i.test(s)) return t("Chrome does not allow recording this page.");
  return t("The tab could not be captured. Click the Studio extension on that tab again.");
}

async function recExtStream(prev) {
  const r = await extCall({ t: "stream" }, 6000);
  if (!r || !r.id) throw new Error(recExtErr(r && r.error));
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: r.id } } }); }
  catch (e) { throw new Error(recExtErr(e && e.message)); }
  return { stream, src: { kind: "ext", title: prev && prev.kind === "ext" ? prev.title : "" } };
}

function recInErr(kind, e) {
  if (!kind && e && e.name === "NotAllowedError") return t("Studio is not allowed to use an input. Allow the microphone for this site in the browser's site settings, then try again.");
  if (!kind && e && e.name === "NotFoundError") return t("No audio input found. Connect an interface, a phono preamp or a microphone.");
  return String((e && e.message) || e);
}

async function recInput(kind) {
  if (recBusy() || rc.busy) return false;
  rc.busy = true;
  rc.err = null;
  const prev = rc.src;
  recStopInput();
  recRender();
  const c = rc.cfg;
  let back = false;
  try {
    const got = kind === "display" ? await recDisplayStream() : kind === "ext" ? await recExtStream(prev) : await recDevStream();
    const stream = got.stream, tr = stream.getAudioTracks()[0], st = tr && tr.getSettings ? tr.getSettings() : {};
    rc.stream = stream;
    rc.src = got.src;
    rc.label = rc.src ? recSrcName(rc.src) : (tr && tr.label) || "";
    rc.devChans = Math.max(1, Math.min(8, st.channelCount || 2));
    rc.devRate = st.sampleRate || 0;
    const rate = c.rate === "device" ? (st.sampleRate || 48000) : Number(c.rate);
    let ctx;
    try { ctx = new AudioContext({ sampleRate: rate, latencyHint: "interactive" }); } catch { ctx = new AudioContext({ latencyHint: "interactive" }); }
    rc.ctx = ctx;
    rc.sr = ctx.sampleRate;
    await ctx.audioWorklet.addModule("/rec-worklet.js");
    const map = recMap();
    rc.ch = map.length;
    const data = new SharedArrayBuffer(REC_RING * map.length * 4), ctrl = new SharedArrayBuffer(8 * 4);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "studio-rec", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: rc.devChans, channelCountMode: "explicit", channelInterpretation: "discrete", processorOptions: { data, ctrl, size: REC_RING, map } });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    const split = ctx.createChannelSplitter(rc.devChans), merge = ctx.createChannelMerger(2), mon = ctx.createGain();
    mon.gain.value = recMonOn() ? 1 : 0;
    src.connect(split);
    split.connect(merge, map[0], 0);
    split.connect(merge, map[map.length - 1], 1);
    merge.connect(mon);
    mon.connect(ctx.destination);
    rc.nodes = [src, node, sink, split, merge, mon];
    rc.mon = mon;
    rc.meter = { pk: new Float32Array(rc.ch), hold: new Float32Array(rc.ch), holdT: new Float64Array(rc.ch), clip: new Uint8Array(rc.ch) };
    node.port.onmessage = e => recMeter(e.data);
    const tok = rc.tok;
    if (tr) tr.addEventListener("ended", () => recEnded(tok));
    recWorker().postMessage({ t: "arm", data, ctrl, size: REC_RING, ch: rc.ch, sr: rc.sr, cfg: recWire() });
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
    await recDevices();
    if (!rc.src && !rc.cfg.dev && tr) { const s = tr.getSettings ? tr.getSettings().deviceId : ""; if (s && rc.devs.some(d => d.v === s)) rc.cfg.dev = s; }
    recFree();
  } catch (e) {
    recStopInput();
    if (kind === "ext" && prev && prev.kind === "ext") rc.src = Object.assign({}, prev, { pending: true });
    if (kind === "display" && e && e.name === "NotAllowedError") back = true;
    else rc.err = recInErr(kind, e);
  } finally {
    rc.busy = false;
    recRender();
  }
  if (back) await recResume();
  return !!rc.ctx;
}

async function recResume() {
  if (!rc.open || rc.ctx || rc.busy || recPending() || !(await recGranted())) return false;
  return recInput();
}

function recEnded(tok) {
  if (tok !== rc.tok) return;
  if (recBusy()) { rc.worker.postMessage({ t: "stop", reason: "ended" }); return; }
  recStopInput();
  rc.err = t("The input was disconnected.");
  recRender();
}

async function recFree() {
  try { const e = await navigator.storage.estimate(); rc.free = Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch { rc.free = null; }
  rc.freeT = Date.now();
  recRender();
}

function recMeter(m) {
  const M = rc.meter;
  if (!M) return;
  const now = performance.now();
  for (let k = 0; k < M.pk.length; k++) {
    const v = m.pk[k] || 0;
    M.pk[k] = Math.max(v, M.pk[k] * 0.82);
    if (v >= M.hold[k] || now - M.holdT[k] > 1500) { M.hold[k] = v; M.holdT[k] = now; }
    if (m.clip[k] > 0) M.clip[k] = 1;
  }
  if (!rc.raf) rc.raf = requestAnimationFrame(recDraw);
}

function recDb(v) { return v > 0 ? 20 * Math.log10(v) : -Infinity; }

function recDraw() {
  rc.raf = 0;
  if (!rc.open) return;
  recDrawMeter();
  recDrawWave();
  if (recBusy()) $("recTime").textContent = recClock();
}

function recDrawMeter() {
  const cv = $("recMt"), M = rc.meter;
  if (!cv) return;
  const dpr = canvasFit(cv), g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  const n = M ? M.pk.length : 2, scaleH = 13 * dpr * thFs(), clipW = 12 * dpr * thFs(), barW = W - clipW - 3 * dpr;
  const rowH = Math.max(3 * dpr, (H - scaleH - (n + 1) * 2 * dpr) / n);
  const xOfDb = db => Math.max(0, Math.min(1, (db + 60) / 60)) * barW;
  for (let k = 0; k < n; k++) {
    const y = 2 * dpr + k * (rowH + 2 * dpr);
    g.fillStyle = TH.meterBg;
    g.fillRect(0, y, barW, rowH);
    if (M) {
      const grad = g.createLinearGradient(0, 0, barW, 0);
      grad.addColorStop(0, TH.blue);
      grad.addColorStop(xOfDb(-18) / barW, TH.blue);
      grad.addColorStop(xOfDb(-12) / barW, TH.gold);
      grad.addColorStop(xOfDb(-3) / barW, TH.pink);
      grad.addColorStop(1, TH.peak);
      g.fillStyle = grad;
      g.fillRect(0, y, xOfDb(recDb(M.pk[k])), rowH);
      const h = recDb(M.hold[k]);
      if (h > -60) { g.fillStyle = TH.ink; g.fillRect(xOfDb(h) - dpr, y, 2 * dpr, rowH); }
    }
    g.fillStyle = M && M.clip[k] ? TH.peak : TH.meterOff;
    g.fillRect(W - clipW, y, clipW, rowH);
  }
  g.font = thFont(8.5, dpr);
  g.textBaseline = "bottom";
  g.textAlign = "center";
  g.fillStyle = TH.label2;
  for (const db of [-60, -48, -36, -24, -18, -12, -6, -3, 0]) {
    const x = xOfDb(db);
    g.fillRect(x, H - scaleH, Math.max(1, dpr), 3 * dpr);
    g.fillText(db === 0 ? "0" : String(db), Math.min(Math.max(x, 8 * dpr), barW - 4 * dpr), H);
  }
  if (M) $("recPk").textContent = M.hold.length ? (Math.max(...Array.from(M.hold).map(recDb)) > -100 ? Math.max(...Array.from(M.hold).map(recDb)).toFixed(1) + " dBFS" : "−∞ dBFS") : "";
}

function recDrawWave() {
  const cv = $("recWave");
  if (!cv) return;
  const dpr = canvasFit(cv), g = cv.getContext("2d"), W = cv.width, H = cv.height, mid = H / 2;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  g.fillStyle = tw(0.1);
  g.fillRect(0, Math.round(mid), W, Math.max(1, dpr));
  const L = rc.live, pairs = L.length / 2;
  if (!pairs || !rc.sr) return;
  const span = Math.max(30, Math.ceil(rc.frames / rc.sr)), per = (span * rc.sr / 256) / W;
  const first = Math.max(0, Math.floor(pairs - W * per));
  g.fillStyle = tc("pink", 0.85);
  for (let x = 0; x < W; x++) {
    const a = Math.floor(first + x * per), b = Math.min(pairs, Math.floor(first + (x + 1) * per));
    if (a >= pairs) break;
    let mn = 0, mx = 0;
    for (let i = a; i < Math.max(a + 1, b); i++) { const lo = L[i * 2], hi = L[i * 2 + 1]; if (lo < mn) mn = lo; if (hi > mx) mx = hi; }
    const y0 = mid - mx * (mid - dpr), y1 = mid - mn * (mid - dpr);
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function recClock() {
  const s = rc.sr ? rc.frames / rc.sr : 0, h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.floor(s % 60);
  return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function recTop() {
  const b = $("recBtn");
  if (!b) return;
  b.classList.toggle("on", recBusy());
  b.classList.toggle("wait", rc.phase === "wait");
  $("recT").textContent = recBusy() ? (rc.phase === "wait" ? t("waiting") : recClock()) : "";
}

function recName() {
  if (rc.src && rc.src.kind === "ext" && rc.src.title) return rc.src.title.slice(0, 80);
  const d = new Date(), p = v => String(v).padStart(2, "0");
  return t("Recording") + " " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "." + p(d.getMinutes());
}

function recSummary() {
  if (rc.err) return rc.err;
  if (rc.busy) return t("Opening the input…");
  if (recPending()) return t("Press Record to record {n}.").replace("{n}", rc.src.title || t("the tab"));
  if (!rc.ctx) return t("Choose an input. Studio records into a new file in your browser storage, safe against crashes.");
  if (rc.phase === "wait") return t("Waiting for the level to rise above {v}…").replace("{v}", rc.cfg.thr + " dBFS");
  if (rc.phase === "rec") {
    const parts = [t("Recording")];
    if (rc.marks) parts.push(rc.marks === 1 ? t("1 marker") : t("{n} markers").replace("{n}", rc.marks));
    if (rc.cfg.autoStop) parts.push(t("stops after {s} s of silence").replace("{s}", rc.cfg.after));
    return parts.join(" · ");
  }
  if (rc.note) return rc.note;
  const lat = rc.ctx ? Math.round(((rc.ctx.baseLatency || 0) + (rc.ctx.outputLatency || 0)) * 1000) : 0;
  return t("Ready.") + (recMonOn() && lat ? " " + t("Monitoring delay about {ms} ms.").replace("{ms}", lat) : "");
}

function recRender() {
  if (!rc.cfg || !$("rec")) return;
  const c = rc.cfg, busy = recBusy(), on = (id, v) => document.querySelectorAll("#" + id + " button").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
  const devs = [{ v: "", label: t("Default input") }].concat(rc.devs);
  if (recCanShare()) devs.push({ v: "display", label: rc.src && rc.src.kind === "display" ? recSrcName(rc.src) : t("A browser tab or window…") });
  if (rc.src && rc.src.kind === "ext") devs.push({ v: "ext", label: recSrcName(rc.src) });
  recDd($("recDev"), devs, rc.src ? rc.src.kind : c.dev, v => { if (v === "display" || v === "ext") { recInput(v); return; } c.dev = v; recSave(); recInput(); });
  recDd($("recCh"), recChoices(), recMap().length === 2 ? (recMap()[0] + 1) + "-" + (recMap()[1] + 1) : String(recMap()[0] + 1), v => { c.chans = v; recSave(); recInput(); });
  recDd($("recRate"), REC_RATES.map(v => ({ v, label: v === "device" ? t("As the device") + (rc.devRate ? " · " + (rc.devRate / 1000).toLocaleString() + " kHz" : "") : (Number(v) / 1000).toLocaleString() + " kHz" })), c.rate, v => { c.rate = v; recSave(); recInput(); });
  for (const id of ["recDev", "recCh", "recRate"]) $(id).classList.toggle("off", busy);
  on("recMon", recMonOn() ? 1 : 0);
  $("recMonNote").textContent = t(rc.src && rc.src.kind === "ext" ? "Chrome mutes the tab while Studio records it; this plays it back." : rc.src && rc.src.kind === "display" ? "The shared tab keeps playing by itself; leave this off." : "Use headphones to avoid feedback.");
  const k = ex.keys || {}, kp = [t("Chrome extension connected.")];
  if (k["rec-toggle"]) kp.push(t("{k} starts and stops, from any app.").replace("{k}", k["rec-toggle"]));
  if (k["rec-marker"]) kp.push(t("{k} sets a marker.").replace("{k}", k["rec-marker"]));
  $("recExt").textContent = kp.join(" ");
  $("recExtRow").classList.toggle("hidden", !ex.on);
  on("recPre", c.pre);
  on("recStart", c.autoStart ? 1 : 0);
  on("recStop", c.autoStop ? 1 : 0);
  on("recAfter", c.after);
  $("recThr").value = c.thr;
  $("recThrV").textContent = c.thr + " dBFS";
  document.querySelectorAll("#rec .recauto").forEach(el => el.classList.toggle("hidden", !c.autoStart && !c.autoStop));
  document.querySelectorAll("#rec .recafter").forEach(el => el.classList.toggle("hidden", !c.autoStop));
  $("recName").placeholder = recName();
  $("recName").disabled = busy;
  const go = $("recGo");
  go.textContent = busy ? t("Stop") : t("Record");
  go.classList.toggle("stop", busy);
  go.disabled = !rc.ctx && !busy && !recPending();
  $("recMark").disabled = rc.phase !== "rec";
  $("recCancel").classList.toggle("hidden", !busy);
  $("recAllow").classList.toggle("hidden", !!rc.ctx || rc.busy || recPending());
  $("recTime").textContent = recClock();
  const bytesMin = rc.sr * Math.max(1, rc.ch) * 4 * 60;
  const free = rc.free !== null ? " · " + t("{f} free, about {m}").replace("{f}", fmtBytes(rc.free)).replace("{m}", fmtDur(rc.free / bytesMin * 60)) : "";
  $("recInfo").textContent = rc.ctx ? (rc.sr / 1000).toLocaleString() + " kHz · " + rc.ch + " ch · 32-bit float · " + fmtBytes(bytesMin) + " " + t("per minute") + free : "";
  $("recSize").textContent = busy && rc.phase === "rec" ? fmtBytes(rc.frames * rc.ch * 4) : "";
  const warn = rc.dropped > 0 ? " " + t("{s} s of audio were lost because the browser fell behind.").replace("{s}", (rc.dropped / Math.max(1, rc.sr)).toFixed(2)) : "";
  $("recSum").textContent = recSummary() + warn;
  if (busy && Date.now() - rc.freeT > 10000) recFree();
  extStatus();
}

async function recOpen(noInput) {
  recWorker();
  if (!rc.open) {
    closePopovers();
    rc.open = true;
    $("rec").classList.remove("hidden");
    extKeys();
  }
  recRender();
  if (noInput !== true && !(await recResume()) && !rc.ctx) { await recDevices(); recRender(); }
  if (!rc.raf) rc.raf = requestAnimationFrame(recDraw);
}

function recClose() {
  rc.open = false;
  $("rec").classList.add("hidden");
  if (!recBusy()) recStopInput();
}

function recToggle() { if (rc.open) recClose(); else recOpen(); }

async function recGo() {
  if (recBusy()) { rc.worker.postMessage({ t: "stop" }); return; }
  if (!rc.open) await recOpen(recPending());
  if (!rc.ctx && !(await recInput(recPending() ? rc.src.kind : undefined))) return;
  rc.err = null;
  rc.note = null;
  rc.live = [];
  rc.frames = 0;
  rc.dropped = 0;
  rc.take = $("recName").value.trim() || recName();
  rc.worker.postMessage({ t: "start", name: rc.take, device: rc.label, cfg: recWire() });
  call({ t: "persist" }).catch(() => {});
}

function recMark() { if (rc.phase === "rec") { rc.worker.postMessage({ t: "mark" }); flash(t("Marker") + " " + (rc.marks + 1)); } }

async function recCancel() {
  if (!recBusy()) return;
  if (!(await ask(t("Discard this recording?"), t("The recording so far will be removed."), { ok: t("Discard") }))) return;
  rc.worker.postMessage({ t: "cancel" });
}

async function recDone(m) {
  recTop();
  if (m.empty) {
    rc.note = m.reason === "cancel" ? t("The recording was discarded.") : t("Nothing was recorded.");
    recRender();
    return;
  }
  const meta = m.meta;
  rc.last = meta;
  $("recName").value = "";
  const how = m.reason === "silence" ? t("Stopped after {s} s of silence.").replace("{s}", rc.cfg.after) + " " : m.reason === "quota" ? t("Browser storage is full. The recording was saved up to this point.") + " " : m.reason === "ended" ? t("The input was disconnected. The recording was saved up to this point.") + " " : "";
  rc.note = how + t("Saved as {n}, {d}.").replace("{n}", meta.name).replace("{d}", fmtDur(meta.frames / meta.sampleRate));
  recRender();
  refreshFiles();
  if (m.reason !== "quota") recClose();
  await openDoc(meta.id);
  flash(t("Recorded") + " " + meta.name + " · " + fmtDur(meta.frames / meta.sampleRate));
}

function wireRec() {
  recLoad();
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); recSave(); if (rc.worker) rc.worker.postMessage({ t: "cfg", cfg: recWire() }); recRender(); });
  seg("recMon", v => { if (rc.src && rc.src.kind === "ext") rc.extMon = v === "1"; else rc.cfg.monitor = v === "1"; if (rc.mon) rc.mon.gain.value = recMonOn() ? 1 : 0; });
  seg("recPre", v => { rc.cfg.pre = Number(v); });
  seg("recStart", v => { rc.cfg.autoStart = v === "1"; });
  seg("recStop", v => { rc.cfg.autoStop = v === "1"; });
  seg("recAfter", v => { rc.cfg.after = Number(v); });
  const thr = $("recThr");
  thr.addEventListener("input", () => { rc.cfg.thr = Number(thr.value); $("recThrV").textContent = rc.cfg.thr + " dBFS"; recSave(); if (rc.worker) rc.worker.postMessage({ t: "cfg", cfg: recWire() }); });
  thr.addEventListener("change", () => thr.blur());
  $("recName").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("recName").blur(); } e.stopPropagation(); });
  $("recGo").addEventListener("click", recGo);
  $("recMark").addEventListener("click", recMark);
  $("recCancel").addEventListener("click", recCancel);
  $("recAllow").addEventListener("click", () => recInput());
  $("recX").addEventListener("click", recClose);
  $("recBtn").addEventListener("click", recToggle);
  $("recBtn2").addEventListener("click", () => recOpen());
  $("rec").addEventListener("click", e => { if (e.target === $("rec") && !recBusy()) recClose(); });
  $("recMt").addEventListener("click", () => { if (rc.meter) { rc.meter.clip.fill(0); rc.meter.hold.fill(0); } });
  window.addEventListener("beforeunload", e => { if (recBusy()) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("pagehide", () => { rc.tok++; });
  document.addEventListener("i18n", () => { recRender(); recTop(); });
  window.addEventListener("themechange", () => { if (rc.open && !rc.raf) rc.raf = requestAnimationFrame(recDraw); });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", async () => { await recDevices(); recRender(); });
  setTimeout(() => recWorker().postMessage({ t: "recover" }), 1500);
  setInterval(() => { if (rc.open && !rc.raf) rc.raf = requestAnimationFrame(recDraw); }, 250);
}

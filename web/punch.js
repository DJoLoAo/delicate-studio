const PC_DEF = { pre: 2, post: 1, mon: true, off: 0 };
const PC_XF = 0.005;
const pc = { cfg: null, arm: null, ctx: null, nodes: [], stream: null, ring: null, worker: null, ch: 0, inLat: 0, label: "", rec: null, fin: null, wait: null, lvl: 0, clip: false, busy: false, mods: new WeakSet(), tok: 0 };

function pcLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioPunch") || "null"); } catch {}
  pc.cfg = Object.assign({}, PC_DEF, v && typeof v === "object" ? v : {});
  if (![0, 1, 2, 4].includes(pc.cfg.pre)) pc.cfg.pre = 2;
  if (![0, 1, 2].includes(pc.cfg.post)) pc.cfg.post = 1;
  pc.cfg.mon = pc.cfg.mon !== false;
  pc.cfg.off = Math.max(-500, Math.min(500, Number(pc.cfg.off) || 0));
}

function pcSave() { try { localStorage.setItem("studioPunch", JSON.stringify(pc.cfg)); } catch {} }

function pcRate() { return ses.s && ses.s.sr ? ses.s.sr : ed.ctx ? ed.ctx.sampleRate : 48000; }

function pcLatency(sr) {
  const c = ed.ctx;
  const s = (c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0) + pc.inLat + pc.cfg.off / 1000;
  return Math.round(s * sr);
}

function pcWorker() {
  if (pc.worker) return pc.worker;
  pc.worker = new Worker("/rec-worker.js");
  pc.worker.onmessage = e => pcMsg(e.data);
  return pc.worker;
}

function pcMsg(m) {
  if (m.t === "rstat") { if (m.phase === "rec" && pc.wait) { const w = pc.wait; pc.wait = null; w(true); } return; }
  if (m.t === "rdone") { pcDone(m); return; }
  if (m.t === "rerror") {
    if (pc.wait) { const w = pc.wait; pc.wait = null; w(false); }
    tell(recErr(m.msg), t("Recording stopped"));
  }
}

function pcStopInput() {
  pc.tok++;
  for (const n of pc.nodes) { try { n.disconnect(); } catch {} }
  pc.nodes = [];
  if (pc.stream) for (const tr of pc.stream.getTracks()) { try { tr.stop(); } catch {} }
  pc.stream = null;
  pc.ring = null;
  pc.ctx = null;
  pc.mon = null;
  pc.lvl = 0;
  pc.clip = false;
  if (pc.worker && !pc.rec && !pc.fin) pc.worker.postMessage({ t: "disarm" });
}

async function pcInput() {
  const sr = pcRate();
  await ensureAudioFor(sr, 2);
  const ctx = ed.ctx;
  if (ctx.sampleRate !== sr) throw new Error(t("This browser cannot record at {r} kHz here.").replace("{r}", (sr / 1000).toLocaleString()));
  if (pc.ctx === ctx && pc.stream && pc.stream.getAudioTracks().some(x => x.readyState === "live")) return;
  pcStopInput();
  const tok = pc.tok, stream = (await recDevStream()).stream;
  if (tok !== pc.tok) { for (const x of stream.getTracks()) x.stop(); throw new Error("cancelled"); }
  const tr = stream.getAudioTracks()[0], st = tr && tr.getSettings ? tr.getSettings() : {};
  const n = Math.max(1, Math.min(8, st.channelCount || 2)), map = recMap(n);
  if (!pc.mods.has(ctx)) { await ctx.audioWorklet.addModule("/rec-worklet.js"); pc.mods.add(ctx); }
  const data = new SharedArrayBuffer(REC_RING * map.length * 4), ctrl = new SharedArrayBuffer(8 * 4);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "studio-rec", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: n, channelCountMode: "explicit", channelInterpretation: "discrete", processorOptions: { data, ctrl, size: REC_RING, map } });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  const split = ctx.createChannelSplitter(n), merge = ctx.createChannelMerger(2), mon = ctx.createGain();
  mon.gain.value = pc.cfg.mon ? 1 : 0;
  src.connect(split);
  split.connect(merge, map[0], 0);
  split.connect(merge, map[map.length - 1], 1);
  merge.connect(mon);
  mon.connect(ctx.destination);
  node.port.onmessage = e => pcMeter(e.data);
  pc.nodes = [src, node, sink, split, merge, mon];
  pc.mon = mon;
  pc.stream = stream;
  pc.ctx = ctx;
  pc.ch = map.length;
  pc.ring = { ctrl: new Int32Array(ctrl) };
  pc.inLat = Number(st.latency) > 0 && Number(st.latency) < 1 ? Number(st.latency) : 0;
  pc.label = (tr && tr.label) || "";
  if (tr) tr.addEventListener("ended", () => { if (tok !== pc.tok) return; if (pc.rec) ssStop(); pcDisarm(); tell(t("The input was disconnected.")); });
  pc.armT = performance.now();
  pcWorker().postMessage({ t: "arm", data, ctrl, size: REC_RING, ch: pc.ch, sr, cfg: { pre: 0, autoStart: false, autoStop: false, thr: -45, after: 5 } });
}

function pcMeter(m) {
  let v = 0;
  for (const x of m.pk) v = Math.max(v, x);
  pc.lvl = Math.max(v, pc.lvl * 0.8);
  if (m.clip && Array.from(m.clip).some(x => x > 0)) pc.clip = true;
  const b = pc.arm && document.querySelector('.sestrack[data-id="' + CSS.escape(pc.arm) + '"] .stin b');
  if (!b) return;
  const db = pc.lvl > 0 ? 20 * Math.log10(pc.lvl) : -96;
  b.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
  b.parentElement.classList.toggle("clip", pc.clip);
}

async function pcArm(id) {
  if (pc.rec || pc.fin || pc.busy) return;
  if (pc.arm === id) { pcDisarm(); return; }
  if (recBusy()) { tell(t("A recording is running.")); return; }
  pc.arm = id;
  pc.busy = true;
  ssHeads();
  try { await pcInput(); }
  catch (e) {
    pc.arm = null;
    pcStopInput();
    if ((e && e.message) !== "cancelled") tell(recInErr(undefined, e), t("Could not open the input"));
  } finally { pc.busy = false; ssHeads(); ssDraw(); }
}

function pcDisarm() {
  if (pc.rec) return;
  pc.arm = null;
  pcStopInput();
  if (ses.open) { ssHeads(); ssDraw(); }
}

function pcNewTrack() {
  if (!ses.open) return null;
  const tr = { id: ssNewId(), name: ssTrackName(ses.s.tracks.length + 1), gain: 0, pan: 0, mute: false, solo: false, clips: [], takes: [] };
  ses.s.tracks.push(tr);
  ses.track = tr.id;
  ssCommit();
  return tr;
}

async function pcGo() {
  if (!ses.open) return;
  if (pc.rec) { ssStop(); return; }
  if (pc.fin || pc.busy) return;
  if (recBusy()) { tell(t("A recording is running.")); return; }
  let tr = pc.arm && ses.s.tracks.find(x => x.id === pc.arm);
  if (!tr) {
    tr = ses.s.tracks.find(x => x.id === ses.track) || pcNewTrack();
    await pcArm(tr.id);
    if (pc.arm !== tr.id) return;
  } else if (pc.ctx !== ed.ctx) {
    pc.busy = true;
    try { await pcInput(); } catch (e) { pc.busy = false; pcDisarm(); tell(recInErr(undefined, e), t("Could not open the input")); return; }
    pc.busy = false;
  }
  const sr = ed.ctx.sampleRate;
  if (!ses.s.sr) { ses.s.sr = sr; ssSaveSoon(); ed.worker.postMessage({ t: "sesmix", s: ses.s }); }
  if (ses.play.on) ssStop();
  const sel = ses.sel.b > ses.sel.a, a = Math.round(sel ? ses.sel.a : ses.cursor), b = sel ? Math.round(ses.sel.b) : -1;
  const from = Math.max(0, a - Math.round(pc.cfg.pre * sr)), end = b >= 0 ? b + Math.round(pc.cfg.post * sr) : Math.max(ssLen(), a) + sr * 3600 * 4;
  const n = (tr.takes || []).length + 1, name = (ses.s.name + " – " + tr.name + " – " + t("take") + " " + n).slice(0, 120);
  pc.busy = true;
  const wait = 300 - (performance.now() - (pc.armT || 0));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const ok = await new Promise(res => { pc.wait = res; pcWorker().postMessage({ t: "start", name, device: pc.label, cfg: { pre: 0, autoStart: false, autoStop: false, thr: -45, after: 5 } }); setTimeout(() => { if (pc.wait === res) { pc.wait = null; res(false); } }, 5000); });
  pc.busy = false;
  if (!ok) { tell(t("The recording could not start.")); return; }
  pc.rec = { tr: tr.id, a, b, from, end, sr, n, P: null, D: null };
  Atomics.store(ed.ring.ctrl, 0, 0);
  ses.play = { on: true, start: from, end, loop: false, off: 0, t0: performance.now() };
  ed.worker.postMessage({ t: "sesplay", start: from, end, loop: false, off: 0, rec: true, punch: { tr: tr.id, a, b } });
  ssButtons();
  ssDraw();
  if (!ses.ticking) { ses.ticking = true; ssTick(); }
}

function pcTick(ph) {
  const R = pc.rec;
  if (!R || R.P !== null || !ed.ring || !pc.ring) return;
  if (Atomics.load(ed.ring.ctrl, 2) > 0 && ph >= R.a) { R.P = Atomics.load(ed.ring.ctrl, 6); R.D = Atomics.load(pc.ring.ctrl, 3); }
}

function pcEnd(pos) {
  const R = pc.rec;
  if (!R) return;
  pc.rec = null;
  const out = R.b >= 0 ? Math.min(R.b, Math.floor(pos)) : Math.floor(pos);
  if (out - R.a < Math.round(R.sr * 0.05)) {
    pc.worker.postMessage({ t: "cancel" });
    pc.fin = { cancel: true };
    flash(t("Stopped before the punch-in point. Nothing was recorded."));
    return;
  }
  const P = R.P !== null ? R.P : Atomics.load(ed.ring.ctrl, 6), D = R.D !== null ? R.D : Atomics.load(pc.ring.ctrl, 3);
  pc.fin = { R, out, P, D, lat: pcLatency(R.sr) };
  pc.worker.postMessage({ t: "stop" });
}

function pcTakeAt(from, inAt, D, P, lat) { return from + ((inAt + D - P) | 0) - lat; }

async function pcDone(m) {
  const F = pc.fin;
  pc.fin = null;
  if (!F || F.cancel || m.empty) { if (ses.open) { ssMix(); ssDraw(); } return; }
  const meta = m.meta, R = F.R;
  refreshFiles();
  if (!ses.open) return;
  let p;
  try { p = (await call({ t: "sesdoc", id: meta.id })).doc; } catch (e) { tell(String(e.message || e), t("Could not add the take")); return; }
  if (!ses.open || p.missing) return;
  ssUse(p);
  const tr = ses.s.tracks.find(x => x.id === R.tr) || pcNewTrack();
  const tk = { id: ssNewId(), doc: meta.id, at: pcTakeAt(R.from, m.inAt | 0, F.D, F.P, F.lat), len: meta.frames, n: R.n, name: t("Take") + " " + R.n };
  if (!pcPlace(tr, tk, R.a, F.out)) { flash(t("The take did not reach the punch range.")); ssMix(); ssDraw(); return; }
  ses.track = tr.id;
  ssCommit();
  const warn = m.dropped > 0 ? " · " + t("{s} s of audio were lost because the browser fell behind.").replace("{s}", (m.dropped / R.sr).toFixed(2)) : "";
  flash(t("{t} recorded on {n}").replace("{t}", tk.name).replace("{n}", tr.name) + " · " + fmtDur((F.out - R.a) / R.sr) + warn);
}

function pcPlace(tr, tk, a0, b0) {
  const sr = ssRate(), X = Math.max(2, Math.round(sr * PC_XF)), h = X >> 1;
  const a = Math.max(a0, tk.at, 0), b = Math.min(b0, tk.at + tk.len);
  if (b - a < X * 2) return false;
  const out = [];
  let left = false, right = false;
  for (const k of tr.clips) {
    const e = k.at + k.len;
    if (e <= a || k.at >= b) { out.push(k); continue; }
    if (k.at < a) {
      const len = Math.min(Math.min(a + h, e) - k.at, ssDocLen(k) - k.from);
      out.push(Object.assign({}, k, { len, fin: Math.min(k.fin, len), fout: 0 }));
      left = true;
    }
    if (e > b) {
      const st = Math.max(b - h, k.at), d = st - k.at, len = e - st;
      out.push(Object.assign({}, k, { id: ssNewId(), at: st, from: k.from + d, len, fin: 0, fout: Math.min(k.fout, len) }));
      right = true;
    }
  }
  const s = Math.max(tk.at, 0, left ? a - h : a), e = Math.min(tk.at + tk.len, right ? b + h : b);
  out.push({ id: ssNewId(), doc: tk.doc, at: s, from: s - tk.at, len: e - s, gain: 0, fin: left ? 0 : X, fout: right ? 0 : X, name: tk.name });
  tr.clips = out.sort((p, q) => p.at - q.at);
  if (!Array.isArray(tr.takes)) tr.takes = [];
  tr.takes.push(tk);
  return true;
}

function pcDraw(g, dpr, W, H) {
  const tr = pc.arm, r = tr ? ses.s.tracks.findIndex(x => x.id === tr) : -1;
  if (r < 0) return;
  const L = ssLane() * dpr, y = r * L;
  const R = pc.rec;
  const a = R ? R.a : ses.sel.b > ses.sel.a ? ses.sel.a : ses.cursor, b = R ? R.b : ses.sel.b > ses.sel.a ? ses.sel.b : -1;
  g.fillStyle = tc("pink", 0.9);
  const xa = Math.round(ssX(a) * dpr);
  if (xa >= 0 && xa <= W) g.fillRect(xa, y, Math.max(1, dpr) * 2, L - dpr);
  if (b >= 0) { const xb = Math.round(ssX(b) * dpr); if (xb >= 0 && xb <= W) g.fillRect(xb - dpr, y, Math.max(1, dpr) * 2, L - dpr); }
  if (!R) return;
  const ph = ssPlayhead();
  if (ph <= a) return;
  const e = b >= 0 ? Math.min(ph, b) : ph, x0 = Math.max(0, ssX(a) * dpr), x1 = Math.min(W, ssX(e) * dpr);
  if (x1 <= x0) return;
  g.fillStyle = tc("pink", 0.22);
  g.fillRect(x0, y + 2 * dpr, x1 - x0, L - 4 * dpr);
  g.fillStyle = tc("pink", 0.95);
  g.font = thFont(9.5, dpr);
  g.textAlign = "left";
  g.textBaseline = "top";
  g.fillText(t("Recording") + " · " + t("take") + " " + R.n, x0 + 5 * dpr, y + 5 * dpr);
}

async function pcSettings() {
  if (!pc.cfg) pcLoad();
  const c = pc.cfg;
  const auto = ed.ctx ? Math.round(((ed.ctx.outputLatency || 0) + (ed.ctx.baseLatency || 0) + pc.inLat) * 1000) : null;
  const field = (label, inner) => `<div class="dfield"><span>${esc(t(label))}</span>${inner}</div>`;
  const html = field("Pre-roll", segHtml("pre", [["0", "off"], ["1", "1 s"], ["2", "2 s"], ["4", "4 s"]], String(c.pre)))
    + field("Post-roll", segHtml("post", [["0", "off"], ["1", "1 s"], ["2", "2 s"]], String(c.post)))
    + field("Hear the input", segHtml("mon", [["1", "on"], ["0", "off"]], c.mon ? "1" : "0"))
    + `<label class="dfield"><span>${esc(t("Extra offset (ms)"))}</span><input name="off" value="${esc(String(c.off))}" inputmode="decimal" spellcheck="false" autocomplete="off"></label>`
    + `<div class="dnote">${esc(t("Arm a track with R. With a time selection, Record plays from the pre-roll, records the selection and plays on for the post-roll; without one it records from the cursor until you stop. Each pass is kept as a take, and the track gets the new take inside the punch range with short crossfades."))}</div>`
    + `<div class="dnote">${esc(auto === null ? t("Takes are moved earlier by the delay the browser reports for playback and input, plus the extra offset. Use headphones.") : t("Takes are moved earlier by {a} ms, the delay the browser reports for playback and input, plus the extra offset. Use headphones.").replace("{a}", auto))}</div>`;
  const v = await askForm(t("Recording in sessions"), html, { ok: t("save"), setup: segSetup, read: () => segRead(document.querySelector("#dlg .dform")) });
  if (!v) return;
  c.pre = [0, 1, 2, 4].includes(Number(v.pre)) ? Number(v.pre) : c.pre;
  c.post = [0, 1, 2].includes(Number(v.post)) ? Number(v.post) : c.post;
  c.mon = v.mon !== "0";
  const off = Number(String(v.off).replace(",", "."));
  if (Number.isFinite(off)) c.off = Math.max(-500, Math.min(500, Math.round(off * 10) / 10));
  pcSave();
  if (pc.mon) pc.mon.gain.value = c.mon ? 1 : 0;
}

function wirePunch() {
  pcLoad();
  $("sesRec").addEventListener("click", e => { e.currentTarget.blur(); pcGo(); });
  $("sesRec").addEventListener("contextmenu", e => { e.preventDefault(); pcSettings(); });
  window.addEventListener("pagehide", () => { pc.tok++; });
}

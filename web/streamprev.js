const SV_PLATFORMS = [
  { v: "spotify", plat: "spotify", label: "Spotify", real: "Ogg Vorbis 160 kbps", codec: "opus", kbps: 160 },
  { v: "spotifyHi", plat: "spotify", label: "Spotify, Very high", real: "Ogg Vorbis 320 kbps", codec: "opus", kbps: 320 },
  { v: "apple", plat: "apple", label: "Apple Music", real: "AAC 256 kbps", codec: "aac", kbps: 256 },
  { v: "youtube", plat: "youtube", label: "YouTube", real: "Opus about 130 kbps", codec: "opus", kbps: 128 },
  { v: "soundcloud", plat: "soundcloud", label: "SoundCloud", real: "Opus 64 kbps", codec: "opus", kbps: 64 },
  { v: "deezer", plat: "deezer", label: "Deezer Free", real: "MP3 128 kbps (subscribers get FLAC)", codec: "opus", kbps: 128 }
];
const SV_MAX = 120;
const sv = { open: false, plat: "spotify", job: null, err: "", r: null, ctx: null, nodes: null, mode: "plat", playing: false, t0: 0, off: 0, raf: 0, stats: null };

function svLoad() {
  try { const v = localStorage.getItem("studioStreamPlat"); if (SV_PLATFORMS.some(p => p.v === v)) sv.plat = v; } catch {}
}

function svPlat() { return SV_PLATFORMS.find(p => p.v === sv.plat) || SV_PLATFORMS[0]; }

function svRange() {
  const F = ed.doc.frames, sr = ed.doc.sampleRate;
  if (ed.sel && ed.sel.b > ed.sel.a) return { sel: true, a: ed.sel.a, b: Math.min(ed.sel.b, ed.sel.a + SV_MAX * sr) };
  const a = Math.min(ed.cursor || 0, Math.max(0, F - sr)), b = Math.min(F, a + 30 * sr);
  return { sel: false, a, b };
}

async function svOpen() {
  if (!ed.doc) return;
  if (ed.play.on) stopPlay();
  sv.open = true;
  $("svw").classList.remove("hidden");
  svRender();
  await svPrepare();
}

function svClose() {
  svStop();
  sv.open = false;
  sv.job = null;
  sv.r = null;
  $("svw").classList.add("hidden");
}

async function svCodec(p, ch) {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") return null;
  const tries = p.codec === "aac" ? [{ codec: "mp4a.40.2", name: "AAC" }, { codec: "opus", name: "Opus" }] : [{ codec: "opus", name: "Opus" }];
  for (const c of tries) {
    const cfg = { codec: c.codec, sampleRate: 48000, numberOfChannels: ch, bitrate: p.kbps * 1000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return Object.assign({ name: c.name }, { cfg }); } catch {}
  }
  return null;
}

async function svRead(a, b) {
  const ch = ed.doc.channels, n = b - a, out = Array.from({ length: ch }, () => new Float32Array(n));
  const STEP = 1 << 20;
  for (let s = a; s < b; s += STEP) {
    const k = Math.min(STEP, b - s), r = await call({ t: "read", id: ed.doc.id, start: s, count: k });
    const d = r.data, got = r.count;
    for (let c = 0; c < ch; c++) out[c].set(d.subarray(c * got, c * got + got), s - a);
  }
  return out;
}

async function svTo48(planes, sr) {
  const ch = planes.length, n = planes[0].length;
  if (sr === 48000) return planes;
  const len = Math.ceil(n * 48000 / sr), oc = new OfflineAudioContext(ch, len, 48000);
  const buf = oc.createBuffer(ch, n, sr);
  planes.forEach((p, c) => buf.copyToChannel(p, c));
  const src = oc.createBufferSource();
  src.buffer = buf;
  src.connect(oc.destination);
  src.start();
  const r = await oc.startRendering();
  return Array.from({ length: ch }, (_, c) => r.getChannelData(c).slice());
}

async function svEncode(planes, codec) {
  const ch = planes.length, n = planes[0].length, chunks = [];
  let dcfg = null, err = null;
  const enc = new AudioEncoder({ output: (c, meta) => { chunks.push(c); if (meta && meta.decoderConfig) dcfg = meta.decoderConfig; }, error: e => { err = e; } });
  enc.configure(codec.cfg);
  const B = 4800;
  for (let s = 0; s < n; s += B) {
    const k = Math.min(B, n - s), data = new Float32Array(k * ch);
    for (let c = 0; c < ch; c++) data.set(planes[c].subarray(s, s + k), c * k);
    const ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: k, numberOfChannels: ch, timestamp: Math.round(s / 48 * 1000), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 64) await new Promise(r => setTimeout(r, 0));
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
  const out = Array.from({ length: ch }, () => new Float32Array(n + 48000));
  let pos = 0, derr = null;
  const dec = new AudioDecoder({
    output: ad => {
      const k = ad.numberOfFrames, tmp = new Float32Array(k);
      for (let c = 0; c < ch; c++) {
        ad.copyTo(tmp, { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: "f32-planar" });
        if (pos + k <= out[c].length) out[c].set(tmp, pos);
      }
      pos += k;
      ad.close();
    },
    error: e => { derr = e; }
  });
  dec.configure(dcfg || { codec: codec.cfg.codec, sampleRate: 48000, numberOfChannels: ch });
  for (const c of chunks) dec.decode(c);
  await dec.flush();
  dec.close();
  if (derr) throw derr;
  return { planes: out, len: pos, bytes: chunks.reduce((v, c) => v + c.byteLength, 0) };
}

function svAlign(x, y) {
  const n = Math.min(16384, x.length);
  let at = 0, e0 = 0;
  for (let i = 0; i < n; i++) e0 += Math.abs(x[i]);
  const start = e0 > 1e-3 ? 0 : Math.floor(x.length / 3);
  let best = -Infinity;
  for (let lag = 0; lag <= 4096; lag++) {
    let s = 0;
    for (let i = 0; i < n; i += 2) s += x[start + i] * (y[start + i + lag] || 0);
    if (s > best) { best = s; at = lag; }
  }
  return at;
}

async function svPrepare() {
  if (!ed.doc || !sv.open) return;
  svStop();
  const p = svPlat(), g = svRange(), doc = ed.doc, id = Date.now();
  sv.job = { id };
  sv.err = "";
  sv.r = null;
  svRender();
  try {
    const codec = await svCodec(p, doc.channels);
    if (!codec) throw new Error(t("This browser cannot encode audio for the preview."));
    if (!sv.stats || sv.stats.doc !== doc.id || sv.stats.ver !== ed.histIdx) {
      const st = (await call({ t: "ldmeasure", id: doc.id, a: 0, b: 0, jobId: "sv" + id })).stats;
      sv.stats = { doc: doc.id, ver: ed.histIdx, st };
    }
    if (!sv.job || sv.job.id !== id) return;
    const st = sv.stats.st, lev = repPlat({ integrated: st.integrated, chans: st.tp.map(v => ({ tp: v })) }, RP_PLATFORMS.find(q => q.v === p.plat));
    const gain = lev.gain === null ? 0 : lev.gain;
    const raw = await svRead(g.a, g.b);
    const x48 = await svTo48(raw, doc.sampleRate);
    if (!sv.job || sv.job.id !== id) return;
    const e = await svEncode(x48, codec);
    if (!sv.job || sv.job.id !== id) return;
    const lag = svAlign(x48[0], e.planes[0]), n = x48[0].length, lin = Math.pow(10, gain / 20);
    const enc = e.planes.map(q => q.subarray(lag, lag + n));
    let pk = 0, dpk = 0, d2 = 0, x2 = 0;
    const diff = x48.map((q, c) => {
      const d = new Float32Array(n), y = enc[c];
      for (let i = 0; i < n; i++) {
        const yv = (y[i] || 0) * lin, a = yv < 0 ? -yv : yv;
        if (a > pk) pk = a;
        d[i] = q[i] - (y[i] || 0);
        const da = d[i] < 0 ? -d[i] : d[i];
        if (da > dpk) dpk = da;
        d2 += d[i] * d[i];
        x2 += q[i] * q[i];
      }
      return d;
    });
    sv.r = { doc: doc.id, a: g.a, b: g.b, sel: g.sel, p, codec: codec.name, kbps: p.kbps, gain, lev, n, x: x48, y: enc, d: diff, peak: pk > 0 ? 20 * Math.log10(pk) : null, rel: x2 > 0 && d2 > 0 ? 10 * Math.log10(d2 / x2) : null, kb: e.bytes / 1024 };
  } catch (err) {
    if (sv.job && sv.job.id === id) sv.err = String(err.message || err);
  }
  if (sv.job && sv.job.id === id) sv.job = null;
  svRender();
}

function svBuffers() {
  const r = sv.r, ctx = sv.ctx, ch = r.x.length;
  const mk = planes => { const b = ctx.createBuffer(ch, r.n, 48000); planes.forEach((q, c) => b.copyToChannel(q, c)); return b; };
  return { x: mk(r.x), y: mk(r.y), d: mk(r.d) };
}

function svLevels() {
  const r = sv.r, lin = Math.pow(10, r.gain / 20);
  return { orig: sv.mode === "orig" ? 1 : 0, plat: sv.mode === "plat" ? lin : 0, diff: sv.mode === "diff" ? lin : 0, origAt: sv.mode === "origAt" ? lin : 0 };
}

function svApply(now) {
  if (!sv.nodes) return;
  const l = svLevels(), t0 = sv.ctx.currentTime + (now ? 0 : 0.01);
  const set = (node, v) => { node.gain.cancelScheduledValues(sv.ctx.currentTime); node.gain.setTargetAtTime(v, t0, 0.008); };
  set(sv.nodes.gx, l.orig + l.origAt);
  set(sv.nodes.gy, l.plat);
  set(sv.nodes.gd, l.diff);
}

function svPlay() {
  if (!sv.r) return;
  if (ed.play.on) stopPlay();
  if (!sv.ctx) sv.ctx = new AudioContext({ sampleRate: 48000 });
  sv.ctx.resume();
  svStopNodes();
  const b = svBuffers(), ctx = sv.ctx, start = ctx.currentTime + 0.03;
  const mk = buf => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; const g = ctx.createGain(); g.gain.value = 0; s.connect(g).connect(ctx.destination); return { s, g }; };
  const X = mk(b.x), Y = mk(b.y), D = mk(b.d);
  sv.nodes = { srcs: [X.s, Y.s, D.s], gx: X.g, gy: Y.g, gd: D.g };
  const off = Math.max(0, Math.min(sv.off, sv.r.n / 48000 - 0.01));
  for (const s of sv.nodes.srcs) s.start(start, off);
  sv.t0 = start - off;
  sv.playing = true;
  const l = svLevels();
  sv.nodes.gx.gain.value = l.orig + l.origAt;
  sv.nodes.gy.gain.value = l.plat;
  sv.nodes.gd.gain.value = l.diff;
  svTick();
  svRender();
}

function svStopNodes() {
  if (!sv.nodes) return;
  for (const s of sv.nodes.srcs) { try { s.stop(); } catch {} s.disconnect(); }
  sv.nodes = null;
}

function svStop() {
  if (sv.playing && sv.ctx && sv.r) sv.off = svPos();
  svStopNodes();
  sv.playing = false;
  cancelAnimationFrame(sv.raf);
  if (sv.open) svRender();
}

function svPos() {
  if (!sv.r) return 0;
  const len = sv.r.n / 48000;
  if (!sv.playing || !sv.ctx) return sv.off;
  return ((sv.ctx.currentTime - sv.t0) % len + len) % len;
}

function svTick() {
  cancelAnimationFrame(sv.raf);
  if (!sv.playing || !sv.open) return;
  const el = $("svPos");
  if (el && sv.r) { const p = svPos(); el.value = String(Math.round(p / (sv.r.n / 48000) * 1000)); $("svPosV").textContent = fmtTime(sv.r.a + Math.round(p * ed.doc.sampleRate)); }
  sv.raf = requestAnimationFrame(svTick);
}

function svRender() {
  if (!sv.open) return;
  const p = svPlat(), r = sv.r, busy = !!sv.job;
  fxDd($("svPlat"), SV_PLATFORMS.map(q => ({ v: q.v, label: t(q.label) })), v => { sv.plat = v; try { localStorage.setItem("studioStreamPlat", v); } catch {} svPrepare(); });
  $("svPlat").querySelector(".cur").textContent = t(p.label);
  const g = ed.doc ? svRange() : null;
  $("svWhat").textContent = ed.doc ? ed.doc.name + " · " + (g.sel ? t("Selection") : t("30 s from the cursor")) + " " + fmtTime(g.a) + "–" + fmtTime(g.b) : "";
  document.querySelectorAll("#svMode button").forEach(b => { b.classList.toggle("on", b.dataset.v === sv.mode); b.disabled = !r; });
  $("svPlay").disabled = !r;
  $("svPlay").textContent = sv.playing ? t("stop") : t("play");
  $("svAgain").disabled = busy;
  $("svPos").disabled = !r;
  if (!r) $("svPosV").textContent = "";
  if (busy || !r) {
    $("svInfo").innerHTML = `<div class="snote">${esc(sv.err || (busy ? t("Encoding the preview…") : ""))}</div>`;
    return;
  }
  const real = p.codec === "aac" && r.codec === "AAC" ? t("{c} at {k} kbps, as {p} plays it.").replace("{c}", "AAC").replace("{k}", r.kbps).replace("{p}", t(p.label)) : t("{p} streams {real}; Studio uses {c} at {k} kbps as a stand-in.").replace("{p}", t(p.label)).replace("{real}", p.real).replace("{c}", r.codec).replace("{k}", r.kbps);
  const rows = [
    ["Level on the platform", r.lev.text],
    ["Change", repDb(r.gain, "dB")],
    ["Peak after encoding", repDb(r.peak, "dBFS")],
    ["What the codec takes away", r.rel === null ? "—" : t("{v} below the music").replace("{v}", repDb(-r.rel, "dB").replace("+", ""))]
  ];
  const hot = r.peak !== null && r.peak > 0;
  $("svInfo").innerHTML = `<div class="snote">${esc(real)}</div><div class="lrtw"><table class="lrt svt">${rows.map(([k, v]) => `<tr><th>${esc(t(k))}</th><td>${esc(v)}</td></tr>`).join("")}</table></div>${hot ? `<div class="nlverd bad">${esc(t("The encoded stream goes over full scale by {v}: players without headroom will clip it. Lower the true-peak ceiling of the master.").replace("{v}", repDb(r.peak, "dB").replace("+", "")))}</div>` : ""}`;
}

function svDocChanged() {
  if (!sv.open) return;
  if (!ed.doc) { svClose(); return; }
  if (sv.r && sv.r.doc !== ed.doc.id) { svStop(); sv.r = null; sv.off = 0; svPrepare(); }
}

function wireStream() {
  svLoad();
  $("svX").addEventListener("click", svClose);
  winDrag($("svw"), "studioStreamPos");
  $("svPlay").addEventListener("click", () => { if (sv.playing) svStop(); else svPlay(); });
  $("svAgain").addEventListener("click", () => { sv.off = 0; svPrepare(); });
  $("svMode").addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; sv.mode = b.dataset.v; svApply(); svRender(); });
  $("svPos").addEventListener("input", () => {
    if (!sv.r) return;
    sv.off = Number($("svPos").value) / 1000 * (sv.r.n / 48000);
    $("svPosV").textContent = fmtTime(sv.r.a + Math.round(sv.off * ed.doc.sampleRate));
    if (sv.playing) svPlay();
  });
  $("svw").addEventListener("keydown", e => {
    if (e.target.matches("input")) e.stopPropagation();
    if (e.key === " " && sv.r) { e.preventDefault(); e.stopPropagation(); if (sv.playing) svStop(); else svPlay(); }
  });
  document.addEventListener("i18n", () => { if (sv.open) svRender(); });
}

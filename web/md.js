const MD_DEF = { range: "voice", sens: 50, minLen: 60, follow: true, bend: false, bpm: 120, quant: "off", folder: "" };
const MD_RANGES = [
  { v: "voice", label: "Voice and lead · C2–C6", lo: 36, hi: 84 },
  { v: "bass", label: "Bass · E1–C4", lo: 28, hi: 60 },
  { v: "high", label: "High, whistle · C4–C8", lo: 60, hi: 108 },
  { v: "full", label: "Everything · E1–C7", lo: 28, hi: 96 }
];
const MD_LENS = [30, 60, 100, 150, 250];
const MD_QUANT = ["off", "32", "16", "8"];
const MD_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const md = { cfg: null, res: null, job: null, prog: 0, err: null, seq: 0, listen: "off", rev: 0, saving: false, saved: null };

function mdLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioMidi") || "null"); } catch {}
  md.cfg = Object.assign({}, MD_DEF, v && typeof v === "object" ? v : {});
  if (!MD_RANGES.some(r => r.v === md.cfg.range)) md.cfg.range = MD_DEF.range;
  if (!MD_LENS.includes(md.cfg.minLen)) md.cfg.minLen = MD_DEF.minLen;
  if (!MD_QUANT.includes(md.cfg.quant)) md.cfg.quant = "off";
  md.cfg.bpm = mdBpm(md.cfg.bpm);
}

function mdSave() {
  try { localStorage.setItem("studioMidi", JSON.stringify(md.cfg)); } catch {}
}

function mdBpm(v) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(Math.max(20, Math.min(300, x)) * 100) / 100 : 120;
}

function mdHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function mdName(p) { return MD_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1); }

function mdRange() {
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function mdLive() {
  const r = md.res;
  return r && ed.doc && r.doc === ed.doc.id && r.key === audioKey() ? r : null;
}

function mdGrid() {
  return md.cfg.quant === "off" ? 0 : 60 / md.cfg.bpm * 4 / Number(md.cfg.quant);
}

function mdNotes() {
  const r = mdLive();
  if (!r) return [];
  const g = mdGrid(), out = [];
  for (const n of r.notes) {
    let s = n.s, e = n.e;
    if (g) {
      s = Math.round(s / g) * g;
      e = Math.round(e / g) * g;
      if (e <= s) e = s + g;
    }
    const prev = out[out.length - 1];
    if (prev && prev.e > s) {
      prev.e = s;
      if (prev.e <= prev.s) out.pop();
    }
    out.push({ s, e, p: n.p, v: n.v, os: n.s, oe: n.e });
  }
  for (const n of out) { n.a = r.a + Math.round(n.s * r.sr); n.b = r.a + Math.round(n.e * r.sr); }
  return out;
}

function mdErrText(m) {
  if (m === "nothing") return t("Select some audio first.");
  if (m === "stale") return t("The file changed. Convert again.");
  if (m === "login") return t("Log in again to save to the Locker.");
  if (m === "locker-full") return t("The Locker is full. The file was not saved there.");
  return m;
}

function mdProg(m) {
  if (!md.job || m.id !== md.job.id) return;
  md.prog = m.frac || 0;
  const bar = $("mdBar");
  if (bar) bar.querySelector("i").style.width = Math.round(md.prog * 100) + "%";
  $("mdSum").textContent = t("Listening for the melody…") + " " + Math.round(md.prog * 100) + " %";
}

async function mdConvert() {
  if (!ed.doc || md.job) return;
  const r = mdRange();
  if (r.b <= r.a) return;
  const R = MD_RANGES.find(x => x.v === md.cfg.range) || MD_RANGES[0];
  const id = "m" + (++md.seq), key = audioKey();
  md.job = { id };
  md.prog = 0;
  md.err = null;
  md.saved = null;
  if (md.listen !== "off") mdListen("off");
  mdRender();
  try {
    const res = await call({ t: "midiscan", id: ed.doc.id, a: r.a, b: r.b, chans: ed.chans, fmin: mdHz(R.lo - 0.5), fmax: mdHz(R.hi + 0.5), sens: md.cfg.sens / 100, minLen: md.cfg.minLen / 1000, follow: md.cfg.follow, jobId: id });
    md.res = { doc: ed.doc.id, key, a: res.a, b: res.b, sr: ed.doc.sampleRate, notes: res.notes.map(n => ({ s: n[0], e: n[1], p: n[2], v: n[3] })), track: res.track, t0: res.t0, dt: res.dt, tuning: res.tuning, sel: r.sel };
    md.rev++;
    if (!SPV.on) spToggle();
  } catch (e) {
    const m = String(e.message || e);
    if (m !== "cancelled") md.err = mdErrText(m);
  } finally {
    md.job = null;
    mdRender();
    redraw();
  }
}

function mdChanged() {
  mdSave();
  md.rev++;
  md.saved = null;
  mdRender();
  redraw();
  if (md.listen !== "off") mdSend();
}

function mdSend() {
  if (!ed.worker) return;
  const notes = md.listen === "off" ? [] : mdNotes().map(n => [n.a, n.b, n.p, n.v]);
  ed.worker.postMessage({ t: "mdlisten", mode: md.listen, notes });
}

function mdListen(mode) {
  md.listen = mode;
  mdSend();
  document.querySelectorAll("#mdListen button").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
}

function mdShow() { mdRender(); }

function mdHide() { if (md.listen !== "off") mdListen("off"); }

function mdDoc() {
  md.res = null;
  md.err = null;
  md.saved = null;
  md.rev++;
  if (md.listen !== "off") mdListen("off");
  if (rp.open && rp.tab === "md") mdRender();
}

function mdAfterEdit() {
  if (md.listen !== "off" && !mdLive()) mdListen("off");
  md.rev++;
  if (rp.open && rp.tab === "md") mdRender();
}

function mdVlq(n, out) {
  const b = [n & 127];
  while ((n = Math.floor(n / 128)) > 0) b.unshift((n & 127) | 128);
  out.push(...b);
}

function mdFileName() {
  const r = mdLive(), base = (ed.doc ? ed.doc.name : "melody").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "melody";
  if (!r || !r.sel) return base + ".mid";
  const f = v => fmtTime(v).replace(/[:.]/g, "-");
  return base + " " + f(r.a) + "–" + f(r.b) + ".mid";
}

function mdSmf(notes, r, cfg, name) {
  const ppq = 480, tps = ppq * cfg.bpm / 60, tk = s => Math.max(0, Math.round(s * tps));
  const ev = [];
  const add = (tick, o, bytes) => ev.push({ tick, o, bytes });
  const nm = Array.from(new TextEncoder().encode(name)).slice(0, 120), len = [];
  mdVlq(nm.length, len);
  add(0, 0, [0xff, 0x03, ...len, ...nm]);
  const us = Math.round(60e6 / cfg.bpm);
  add(0, 0, [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255]);
  add(0, 0, [0xff, 0x58, 0x04, 4, 2, 24, 8]);
  if (cfg.bend) for (const b of [[0xb0, 101, 0], [0xb0, 100, 0], [0xb0, 6, 2], [0xb0, 38, 0], [0xb0, 101, 127], [0xb0, 100, 127]]) add(0, 1, b);
  for (const n of notes) {
    const a = tk(n.s), b = Math.max(a + 1, tk(n.e));
    if (cfg.bend) add(a, 2, [0xe0, 0, 64]);
    add(a, 3, [0x90, n.p, n.v]);
    add(b, 1, [0x80, n.p, 0]);
    if (!cfg.bend || !r.track) continue;
    let last = 8192;
    const k0 = Math.max(0, Math.ceil((n.os - r.t0) / r.dt)), k1 = Math.min(r.track.length, Math.floor((n.oe - r.t0) / r.dt));
    for (let k = k0; k < k1; k++) {
      const m = r.track[k];
      if (!Number.isFinite(m) || Math.abs(m - n.p) > 2) continue;
      const v = Math.max(0, Math.min(16383, 8192 + Math.round((m - n.p) / 2 * 8191)));
      if (Math.abs(v - last) < 64) continue;
      const tt = tk(n.s + (r.t0 + k * r.dt - n.os));
      if (tt >= b) break;
      last = v;
      add(Math.max(a, tt), 4, [0xe0, v & 127, v >> 7]);
    }
  }
  ev.sort((x, y) => x.tick - y.tick || x.o - y.o);
  const trk = [];
  let prev = 0;
  for (const e of ev) { mdVlq(e.tick - prev, trk); for (const v of e.bytes) trk.push(v); prev = e.tick; }
  trk.push(0, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 255, 0x4d, 0x54, 0x72, 0x6b, (trk.length >>> 24) & 255, (trk.length >> 16) & 255, (trk.length >> 8) & 255, trk.length & 255];
  const out = new Uint8Array(head.length + trk.length);
  out.set(head, 0);
  out.set(trk, head.length);
  return out;
}

function mdBytes() {
  const r = mdLive();
  if (!r) return null;
  return mdSmf(mdNotes(), r, md.cfg, mdFileName().replace(/\.mid$/, ""));
}

function mdDownload() {
  const bytes = mdBytes();
  if (!bytes) return;
  const a = document.createElement("a"), url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  a.href = url;
  a.download = mdFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  flash(t("Saved") + " " + a.download);
}

async function mdUpload(bytes, name) {
  const folder = String(md.cfg.folder || "").split("/").map(x => x.trim()).filter(x => x && x !== "." && x !== "..").join("/");
  const pre = folder ? folder + "/" : "", stem = name.replace(/\.mid$/i, "");
  let taken = new Set();
  try {
    const r = await fetch("/api/locker/files?prefix=" + encodeURIComponent(pre + stem), { cache: "no-store" });
    if (r.ok) taken = new Set(((await r.json()).files || []).map(f => f.path));
  } catch {}
  let path = pre + name;
  for (let i = 2; taken.has(path); i++) path = pre + stem + " (" + i + ").mid";
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(b => b.toString(16).padStart(2, "0")).join("");
  let r = await fetch("/api/locker/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, size: bytes.length, sha256: sha }) });
  if (r.status === 401) throw new Error("login");
  if (r.status === 402) throw new Error("locker-full");
  if (!r.ok) throw new Error("locker " + r.status);
  const st = await r.json();
  if (st.duplicate) return st.path;
  const off = st.offset || 0;
  if (off < bytes.length) {
    r = await fetch("/api/locker/upload/" + st.id, { method: "PATCH", headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(off) }, body: bytes.slice(off) });
    if (r.status === 401) throw new Error("login");
    if (!r.ok) throw new Error("locker " + r.status);
  }
  r = await fetch("/api/locker/upload/" + st.id + "/finish", { method: "POST" });
  if (r.status === 402) throw new Error("locker-full");
  if (!r.ok) throw new Error("locker " + r.status);
  return (await r.json()).path;
}

async function mdLocker() {
  const bytes = mdBytes();
  if (!bytes || md.saving) return;
  md.saving = true;
  md.err = null;
  mdRender();
  try {
    const path = await mdUpload(bytes, mdFileName());
    md.saved = path;
    flash(t("Saved in the Locker") + ": " + path);
  } catch (e) {
    md.err = mdErrText(String(e.message || e));
  } finally {
    md.saving = false;
    mdRender();
  }
}

function mdSummary() {
  if (md.err) return md.err;
  if (md.job) return t("Listening for the melody…") + " " + Math.round(md.prog * 100) + " %";
  const r = mdLive();
  if (!r) return md.res ? t("The audio changed since the conversion. Convert again to update the notes.") : t("Converts the melody, one note at a time, into MIDI notes. They appear on the spectrogram.");
  const ns = mdNotes();
  if (!ns.length) return t("No melody found here. Try another range or a higher sensitivity.");
  let lo = 127, hi = 0;
  for (const n of ns) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
  const c = Math.round(r.tuning * 100);
  const tune = md.cfg.follow ? " · " + t("tuning {c} cents").replace("{c}", (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c)) : "";
  const saved = md.saved ? " · " + t("in the Locker as {p}").replace("{p}", md.saved) : "";
  return t("{n} notes").replace("{n}", ns.length) + " · " + mdName(lo) + "–" + mdName(hi) + tune + saved;
}

function mdRender() {
  const c = md.cfg;
  if (!c || !$("mdBody") || !ed.doc) return;
  const r = mdRange(), live = mdLive(), busy = !!md.job;
  $("mdRangeT").textContent = (r.sel ? t("Selection") : t("Whole file")) + " · " + fmtTime(r.a) + "–" + fmtTime(r.b);
  const dd = $("mdTrack"), it = MD_RANGES.find(x => x.v === c.range) || MD_RANGES[0];
  dd.querySelector(".cur").textContent = t(it.label);
  dd.dataset.v = it.v;
  $("mdSens").value = c.sens;
  $("mdSensV").textContent = c.sens;
  const on = (id, v) => document.querySelectorAll("#" + id + " button").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
  on("mdMin", c.minLen);
  on("mdFollow", c.follow ? 1 : 0);
  on("mdBend", c.bend ? 1 : 0);
  on("mdQuant", c.quant);
  if (document.activeElement !== $("mdBpmN")) $("mdBpmN").value = String(c.bpm);
  if (document.activeElement !== $("mdFolder")) $("mdFolder").value = c.folder;
  document.querySelectorAll("#mdListen button").forEach(b => { b.disabled = b.dataset.v !== "off" && !live; b.classList.toggle("on", b.dataset.v === md.listen); });
  $("mdDl").disabled = !live || busy;
  $("mdEdit").disabled = !live || busy;
  $("mdLock").disabled = !live || busy || md.saving;
  $("mdConvert").disabled = busy || r.b <= r.a;
  $("mdClear").disabled = !md.res || busy;
  $("mdCancel").classList.toggle("hidden", !busy);
  $("mdBar").classList.toggle("hidden", !busy);
  if (!busy) $("mdBar").querySelector("i").style.width = "0%";
  $("mdSum").textContent = mdSummary();
}

function mdOverlay(g, G) {
  const r = mdLive();
  if (!r) return;
  const { W, ch, laneH, dpr } = G, ns = mdNotes(), sr = r.sr;
  const x0 = frameAt(0), x1 = frameAt(W / dpr);
  g.save();
  for (let k = 0; k < ch; k++) {
    g.beginPath();
    g.rect(0, k * laneH, W, laneH);
    g.save();
    g.clip();
    g.strokeStyle = tc("ice", 0.8);
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    for (const n of ns) {
      if (n.b < x0 || n.a > x1) continue;
      const kA = Math.max(0, Math.ceil((n.os - r.t0) / r.dt)), kB = Math.min(r.track.length, Math.floor((n.oe - r.t0) / r.dt));
      const step = Math.max(1, Math.floor((kB - kA) / Math.max(1, (xOf(n.b) - xOf(n.a)) * 2)));
      let pen = false;
      for (let i = kA; i < kB; i += step) {
        const m = r.track[i];
        if (!Number.isFinite(m) || Math.abs(m - n.p) > 2) { pen = false; continue; }
        const x = xOf(n.a) * dpr + (r.t0 + i * r.dt - n.os) * sr / ed.view.spp * dpr, y = spY(G, mdHz(m + r.tuning), k);
        if (pen) g.lineTo(x, y); else g.moveTo(x, y);
        pen = true;
      }
    }
    g.stroke();
    g.font = thFont(9, dpr);
    g.textBaseline = "bottom";
    g.textAlign = "left";
    for (const n of ns) {
      if (n.b < x0 || n.a > x1) continue;
      const xa = xOf(n.a) * dpr, xb = xOf(n.b) * dpr;
      const ya = spY(G, mdHz(n.p + 0.5 + r.tuning), k), yb = spY(G, mdHz(n.p - 0.5 + r.tuning), k);
      const h = Math.max(3 * dpr, yb - ya), y = (ya + yb) / 2 - h / 2;
      g.fillStyle = tc("gold", 0.38);
      g.fillRect(xa, y, Math.max(dpr, xb - xa), h);
      g.fillStyle = TH.gold;
      g.fillRect(xa, y, Math.max(dpr, 1.5 * dpr), h);
      if (xb - xa > 26 * dpr) { g.fillStyle = TH.ink; g.fillText(mdName(n.p), xa + 3 * dpr, y - dpr); }
    }
    g.restore();
  }
  g.restore();
}

function toggleMidi() { if (rp.open && rp.tab === "md") closeDiag(); else openRepair("md"); }

function wireMidi() {
  mdLoad();
  ddInit($("mdTrack"), MD_RANGES.map(r => ({ v: r.v, label: r.label })), md.cfg.range, v => { md.cfg.range = v; mdChanged(); });
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); mdChanged(); });
  seg("mdMin", v => { md.cfg.minLen = Number(v); });
  seg("mdFollow", v => { md.cfg.follow = v === "1"; });
  seg("mdBend", v => { md.cfg.bend = v === "1"; });
  seg("mdQuant", v => { md.cfg.quant = v; });
  const sens = $("mdSens");
  sens.addEventListener("input", () => { md.cfg.sens = Number(sens.value); $("mdSensV").textContent = md.cfg.sens; mdSave(); });
  sens.addEventListener("change", () => sens.blur());
  const bpm = $("mdBpmN");
  bpm.addEventListener("change", () => { md.cfg.bpm = mdBpm(String(bpm.value).replace(",", ".")); mdChanged(); });
  bpm.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); bpm.blur(); } e.stopPropagation(); });
  const fold = $("mdFolder");
  fold.addEventListener("change", () => { md.cfg.folder = fold.value.trim(); mdSave(); });
  fold.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fold.blur(); } e.stopPropagation(); });
  $("mdListen").addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; mdListen(b.dataset.v); });
  $("mdConvert").addEventListener("click", mdConvert);
  $("mdCancel").addEventListener("click", () => ed.worker.postMessage({ t: "mdcancel" }));
  $("mdDl").addEventListener("click", mdDownload);
  $("mdLock").addEventListener("click", mdLocker);
  $("mdEdit").addEventListener("click", prFromMelody);
  $("mdClear").addEventListener("click", () => { md.res = null; md.saved = null; if (md.listen !== "off") mdListen("off"); md.rev++; mdRender(); redraw(); });
  $("mdDefaults").addEventListener("click", () => { const folder = md.cfg.folder; md.cfg = Object.assign({}, MD_DEF, { folder }); mdChanged(); });
  document.addEventListener("i18n", () => { if (rp.open && rp.tab === "md") mdRender(); });
}

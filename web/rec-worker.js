const BLOCK = 65536, BUCKET = 256, BPB = BLOCK / BUCKET, CHUNK = 8192, PRE_MAX = 10;
const R = { phase: "idle", ring: null, timer: 0, ch: 0, sr: 0, pre: null, preW: 0, preN: 0, tmp: null, cfg: null, doc: null, statT: 0, dropped: 0, err: null };

const enc = o => new TextEncoder().encode(JSON.stringify(o));

async function studioDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("studio", { create: true });
}

async function docsDir() {
  return (await studioDir()).getDirectoryHandle("docs", { create: true });
}

function putAt(h, data, at) {
  if (h.write(data, { at }) !== data.byteLength) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
}

async function writeFile(dir, name, data) {
  const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    putAt(h, data, 0);
    h.flush();
  } finally { h.close(); }
}

async function readJson(dir, name) {
  const f = await (await dir.getFileHandle(name)).getFile();
  return JSON.parse(await f.text());
}

function biquad(type, f, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * Math.SQRT1_2);
  const a0 = 1 + a;
  const b = type === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * c / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function bq(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

function cleanCfg(c) {
  const o = c && typeof c === "object" ? c : {};
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return { pre: num(o.pre, 0, PRE_MAX, 2), autoStart: !!o.autoStart, autoStop: !!o.autoStop, thr: num(o.thr, -80, -6, -45), after: num(o.after, 1, 60, 5) };
}

function post(m, transfer) { postMessage(m, transfer || []); }

function status(force) {
  const now = Date.now();
  if (!force && now - R.statT < 100) return;
  R.statT = now;
  const d = R.doc;
  post({ t: "rstat", phase: R.phase, frames: d ? d.total : 0, marks: d ? d.marks.length : 0, dropped: R.dropped, id: d ? d.id : null });
}

function arm(m) {
  if (R.phase === "rec" || R.phase === "wait") throw new Error("busy");
  disarm();
  const ch = m.ch | 0, sr = m.sr | 0;
  if (!(ch >= 1 && ch <= 8 && sr >= 8000)) throw new Error("input");
  R.ring = { data: new Float32Array(m.data), ctrl: new Int32Array(m.ctrl), size: m.size };
  R.ch = ch;
  R.sr = sr;
  R.pre = Array.from({ length: ch }, () => new Float32Array(sr * PRE_MAX + CHUNK));
  R.preW = 0;
  R.preN = 0;
  R.tmp = Array.from({ length: ch }, () => new Float32Array(CHUNK));
  R.dropped = 0;
  R.settle = Math.round(sr * 0.25);
  R.cfg = cleanCfg(m.cfg);
  Atomics.store(R.ring.ctrl, 2, Atomics.load(R.ring.ctrl, 1));
  R.phase = "armed";
  R.timer = setInterval(() => { try { drain(); } catch (e) { fail(e); } }, 10);
  status(true);
}

function disarm() {
  if (R.timer) clearInterval(R.timer);
  R.timer = 0;
  R.ring = null;
  if (R.phase === "armed") R.phase = "idle";
}

function fail(e) {
  const msg = e && (e.name === "QuotaExceededError" || e.message === "quota") ? "quota" : String((e && e.message) || e);
  post({ t: "rerror", msg });
  if (R.doc && R.phase === "rec") stop(msg === "quota" ? "quota" : "error").catch(() => {});
}

function drain() {
  const ring = R.ring;
  if (!ring) return;
  const ctrl = ring.ctrl, S = ring.size, M = S - 1, w = Atomics.load(ctrl, 1);
  let r = Atomics.load(ctrl, 2), avail = (w - r) | 0;
  if (avail < 0) { r = w; avail = 0; }
  if (avail > S) { R.dropped += avail - S; r = (w - S) | 0; avail = S; }
  while (avail > 0) {
    const n = Math.min(avail, CHUNK);
    for (let k = 0; k < R.ch; k++) {
      const t = R.tmp[k], base = k * S;
      for (let i = 0; i < n; i++) t[i] = ring.data[base + ((r + i) & M)];
    }
    consume(R.tmp, n);
    r = (r + n) | 0;
    avail -= n;
  }
  Atomics.store(ctrl, 2, r);
  if (R.doc && R.phase === "rec" && Date.now() - R.doc.saved > 1000) checkpoint();
  status(false);
}

function prePush(x, n) {
  const cap = R.pre[0].length;
  for (let k = 0; k < R.ch; k++) {
    const p = R.pre[k], s = x[k];
    for (let i = 0; i < n; i++) p[(R.preW + i) % cap] = s[i];
  }
  R.preW = (R.preW + n) % cap;
  R.preN = Math.min(cap, R.preN + n);
}

function preTake(count) {
  const cap = R.pre[0].length, n = Math.min(count, R.preN), start = (R.preW - n + cap) % cap;
  const out = Array.from({ length: R.ch }, () => new Float32Array(n));
  for (let k = 0; k < R.ch; k++) for (let i = 0; i < n; i++) out[k][i] = R.pre[k][(start + i) % cap];
  return { x: out, n };
}

function consume(x, n) {
  if (R.settle > 0) {
    const k = Math.min(n, R.settle);
    R.settle -= k;
    if (k === n) return;
    for (let c = 0; c < R.ch; c++) x[c].copyWithin(0, k, n);
    n -= k;
  }
  if (R.phase === "armed" || R.phase === "wait") {
    prePush(x, n);
    if (R.phase !== "wait") return;
    const thr = Math.pow(10, R.cfg.thr / 20);
    let at = -1;
    for (let i = 0; i < n && at < 0; i++) for (let k = 0; k < R.ch; k++) { const v = x[k][i]; if (v > thr || v < -thr) { at = i; break; } }
    if (at < 0) return;
    const back = (n - at) + Math.round(R.cfg.pre * R.sr);
    const p = preTake(back);
    R.phase = "rec";
    R.doc.startedAt = Date.now();
    append(p.x, 0, p.n);
    R.doc.lastLoud = R.doc.total;
    status(true);
    return;
  }
  if (R.phase !== "rec") return;
  append(x, 0, n);
  if (R.cfg.autoStop) {
    const thr = Math.pow(10, R.cfg.thr / 20), d = R.doc;
    for (let i = n - 1; i >= 0; i--) {
      let loud = false;
      for (let k = 0; k < R.ch; k++) { const v = x[k][i]; if (v > thr || v < -thr) { loud = true; break; } }
      if (loud) { d.lastLoud = d.total - n + i + 1; break; }
    }
    if (d.total - d.lastLoud > R.cfg.after * R.sr) stop("silence").catch(fail);
  }
}

function append(x, off, n) {
  const d = R.doc, ch = R.ch, inv = 1 / ch;
  let done = 0;
  while (done < n) {
    const run = Math.min(n - done, BLOCK - d.fill);
    for (let k = 0; k < ch; k++) d.block.set(x[k].subarray(off + done, off + done + run), k * BLOCK + d.fill);
    for (let i = 0; i < run; i++) {
      let m = 0, mn = Infinity, mx = -Infinity;
      for (let k = 0; k < ch; k++) { const v = x[k][off + done + i]; m += v; if (v < mn) mn = v; if (v > mx) mx = v; }
      m *= inv;
      const l = bq(d.lp, m), h = bq(d.hp, m), md = m - l - h;
      d.bl += l * l; d.bm += md * md; d.bh += h * h;
      if (mn < d.lmn) d.lmn = mn;
      if (mx > d.lmx) d.lmx = mx;
      if (++d.bn === BUCKET) {
        const k = d.bandK % BPB;
        d.band[k * 3] = Math.sqrt(d.bl / BUCKET);
        d.band[k * 3 + 1] = Math.sqrt(d.bm / BUCKET);
        d.band[k * 3 + 2] = Math.sqrt(d.bh / BUCKET);
        d.bl = d.bm = d.bh = 0;
        d.bn = 0;
        d.bandK++;
        d.live.push(d.lmn, d.lmx);
        d.lmn = Infinity;
        d.lmx = -Infinity;
      }
    }
    d.fill += run;
    d.total += run;
    done += run;
    if (d.fill === BLOCK) flushSlot();
  }
  if (d.live.length >= 64) livePost();
}

function livePost() {
  const d = R.doc;
  if (!d || !d.live.length) return;
  const pk = Float32Array.from(d.live);
  d.live.length = 0;
  post({ t: "rpk", pk }, [pk.buffer]);
}

function slotPeaks(block, fill, ch) {
  const pk = new Float32Array(ch * BPB * 2);
  for (let c = 0; c < ch; c++) {
    const base = c * BLOCK;
    for (let k = 0; k < BPB; k++) {
      const s0 = k * BUCKET, s1 = Math.min(s0 + BUCKET, fill);
      let mn = 0, mx = 0;
      if (s1 > s0) {
        mn = Infinity; mx = -Infinity;
        for (let i = base + s0; i < base + s1; i++) { const v = block[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      pk[(c * BPB + k) * 2] = mn;
      pk[(c * BPB + k) * 2 + 1] = mx;
    }
  }
  return pk;
}

function flushSlot() {
  const d = R.doc, ch = R.ch;
  if (d.bn > 0 && d.fill < BLOCK) {
    const k = d.bandK % BPB;
    d.band[k * 3] = Math.sqrt(d.bl / d.bn);
    d.band[k * 3 + 1] = Math.sqrt(d.bm / d.bn);
    d.band[k * 3 + 2] = Math.sqrt(d.bh / d.bn);
  }
  putAt(d.pool, new Uint8Array(d.block.buffer), d.slot * BLOCK * ch * 4);
  putAt(d.pkh, new Uint8Array(slotPeaks(d.block, d.fill, ch).buffer), d.slot * ch * BPB * 2 * 4);
  putAt(d.bdh, new Uint8Array(d.band.buffer), d.slot * BPB * 3 * 4);
  d.slot++;
  d.fill = 0;
  d.block.fill(0);
  d.band.fill(0);
}

function metaOf(d, extra) {
  return Object.assign({ v: 1, id: d.id, name: d.name, ext: "", size: d.total * R.ch * 4, sampleRate: R.sr, channels: R.ch, bits: 32, frames: d.total, blockFrames: BLOCK, slots: Math.ceil(d.total / BLOCK), created: d.created, opened: Date.now(), readOnly: false, source: { kind: "recording", device: d.device }, marks: d.marks.slice() }, extra || {});
}

function checkpoint() {
  const d = R.doc, ch = R.ch;
  if (d.fill > 0) for (let k = 0; k < ch; k++) putAt(d.pool, new Uint8Array(d.block.buffer, k * BLOCK * 4, d.fill * 4), (d.slot * BLOCK * ch + k * BLOCK) * 4);
  d.pool.flush();
  d.pkh.flush();
  d.bdh.flush();
  d.mh.truncate(0);
  putAt(d.mh, enc(metaOf(d, { recording: true, beat: Date.now() })), 0);
  d.mh.flush();
  d.saved = Date.now();
}

async function start(m) {
  if (!R.ring) throw new Error("input");
  if (R.phase === "rec" || R.phase === "wait") return;
  R.cfg = cleanCfg(m.cfg);
  const dir = await docsDir(), id = crypto.randomUUID(), docDir = await dir.getDirectoryHandle(id, { create: true });
  const open = async name => (await docDir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  const d = { id, dir: docDir, name: String(m.name || "Recording").slice(0, 120) || "Recording", device: String(m.device || "").slice(0, 120), created: Date.now(), total: 0, fill: 0, slot: 0, block: new Float32Array(BLOCK * R.ch), band: new Float32Array(BPB * 3), bandK: 0, bl: 0, bm: 0, bh: 0, bn: 0, lp: biquad("lp", 200, R.sr), hp: biquad("hp", 2500, R.sr), lmn: Infinity, lmx: -Infinity, live: [], marks: [], lastLoud: 0, saved: 0, startedAt: 0 };
  try {
    d.pool = await open("pool.f32");
    d.pkh = await open("peaks.f32");
    d.bdh = await open("bands.f32");
    d.mh = await open("meta.json");
  } catch (e) {
    for (const h of [d.pool, d.pkh, d.bdh, d.mh]) { if (h) { try { h.close(); } catch {} } }
    try { await dir.removeEntry(id, { recursive: true }); } catch {}
    throw e;
  }
  R.doc = d;
  putAt(d.mh, enc(metaOf(d, { recording: true, beat: Date.now() })), 0);
  d.mh.flush();
  d.saved = Date.now();
  if (R.cfg.autoStart) {
    R.phase = "wait";
  } else {
    R.phase = "rec";
    d.startedAt = Date.now();
    const p = preTake(Math.round(R.cfg.pre * R.sr));
    d.inAt = (Atomics.load(R.ring.ctrl, 2) - p.n + R.settle) | 0;
    append(p.x, 0, p.n);
    d.lastLoud = d.total;
  }
  status(true);
}

function closeDoc(d) {
  for (const h of [d.pool, d.pkh, d.bdh, d.mh]) { if (h) { try { h.close(); } catch {} } }
}

async function stop(reason) {
  const d = R.doc;
  if (!d) return;
  if (R.phase === "wait") {
    R.doc = null;
    R.phase = R.ring ? "armed" : "idle";
    closeDoc(d);
    try { await (await docsDir()).removeEntry(d.id, { recursive: true }); } catch {}
    post({ t: "rdone", empty: true, reason });
    status(true);
    return;
  }
  let meta = null, err = null;
  const frames = reason === "silence" ? Math.min(d.total, d.lastLoud + Math.round(R.sr)) : d.total;
  try {
    livePost();
    if (d.fill > 0) flushSlot();
    const slots = Math.ceil(frames / BLOCK);
    d.pkh.truncate(slots * R.ch * BPB * 2 * 4);
    d.bdh.truncate(slots * BPB * 3 * 4);
    d.pool.flush();
    d.pkh.flush();
    d.bdh.flush();
    d.total = frames;
    d.marks = d.marks.filter(a => a <= frames);
    meta = metaOf(d);
    d.mh.truncate(0);
    putAt(d.mh, enc(meta), 0);
    d.mh.flush();
  } catch (e) { err = e; }
  R.doc = null;
  R.phase = R.ring ? "armed" : "idle";
  closeDoc(d);
  if (err) post({ t: "rerror", msg: err.name === "QuotaExceededError" || err.message === "quota" ? "quota" : String(err.message || err) });
  else if (frames === 0) {
    try { await (await docsDir()).removeEntry(d.id, { recursive: true }); } catch {}
    post({ t: "rdone", empty: true, reason });
  } else post({ t: "rdone", meta, reason, dropped: R.dropped, inAt: d.inAt });
  status(true);
}

async function cancel() {
  const d = R.doc;
  if (!d) return;
  R.doc = null;
  R.phase = R.ring ? "armed" : "idle";
  closeDoc(d);
  try { await (await docsDir()).removeEntry(d.id, { recursive: true }); } catch {}
  post({ t: "rdone", empty: true, reason: "cancel" });
  status(true);
}

function mark() {
  const d = R.doc;
  if (!d || R.phase !== "rec") return;
  d.marks.push(d.total);
  status(true);
}

async function recoverOne(docDir, meta) {
  const ch = meta.channels, frames = Math.max(0, Math.floor(meta.frames || 0)), slots = Math.ceil(frames / BLOCK);
  const open = async name => (await docDir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  const pool = await open("pool.f32"), pkh = await open("peaks.f32"), bdh = await open("bands.f32");
  try {
    const have = Math.min(Math.floor(pkh.getSize() / (ch * BPB * 2 * 4)), Math.floor(bdh.getSize() / (BPB * 3 * 4)), slots);
    const block = new Float32Array(BLOCK * ch), sr = meta.sampleRate;
    for (let s = have; s < slots; s++) {
      block.fill(0);
      pool.read(new Uint8Array(block.buffer), { at: s * BLOCK * ch * 4 });
      const fill = Math.min(BLOCK, frames - s * BLOCK);
      for (let k = 0; k < ch; k++) block.fill(0, k * BLOCK + fill, (k + 1) * BLOCK);
      putAt(pool, new Uint8Array(block.buffer), s * BLOCK * ch * 4);
      putAt(pkh, new Uint8Array(slotPeaks(block, fill, ch).buffer), s * ch * BPB * 2 * 4);
      const lp = biquad("lp", 200, sr), hp = biquad("hp", 2500, sr), band = new Float32Array(BPB * 3);
      for (let k = 0; k < BPB; k++) {
        let bl = 0, bm = 0, bh = 0, n = 0;
        for (let i = k * BUCKET; i < Math.min(fill, (k + 1) * BUCKET); i++) {
          let m = 0;
          for (let c = 0; c < ch; c++) m += block[c * BLOCK + i];
          m /= ch;
          const l = bq(lp, m), h = bq(hp, m), md = m - l - h;
          bl += l * l; bm += md * md; bh += h * h; n++;
        }
        if (n) { band[k * 3] = Math.sqrt(bl / n); band[k * 3 + 1] = Math.sqrt(bm / n); band[k * 3 + 2] = Math.sqrt(bh / n); }
      }
      putAt(bdh, new Uint8Array(band.buffer), s * BPB * 3 * 4);
    }
    pkh.truncate(slots * ch * BPB * 2 * 4);
    bdh.truncate(slots * BPB * 3 * 4);
    pool.flush(); pkh.flush(); bdh.flush();
  } finally { pool.close(); pkh.close(); bdh.close(); }
  const out = Object.assign({}, meta, { slots, frames, size: frames * ch * 4, recovered: true });
  delete out.recording;
  delete out.beat;
  await writeFile(docDir, "meta.json", enc(out));
  return out;
}

async function recover() {
  const dir = await docsDir(), found = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "directory" || (R.doc && R.doc.id === name)) continue;
    let meta;
    try { meta = await readJson(h, "meta.json"); } catch { continue; }
    if (!meta || !meta.recording || Date.now() - (meta.beat || 0) < 15000) continue;
    try {
      if (!(meta.frames > 0)) { await dir.removeEntry(name, { recursive: true }); continue; }
      const m = await recoverOne(h, meta);
      found.push({ id: m.id, name: m.name, frames: m.frames, sampleRate: m.sampleRate });
    } catch {}
  }
  post({ t: "rrecovered", list: found });
}

async function handle(m) {
  if (m.t === "arm") return arm(m);
  if (m.t === "disarm") { if (R.phase !== "rec" && R.phase !== "wait") disarm(); return; }
  if (m.t === "cfg") { R.cfg = cleanCfg(m.cfg); return; }
  if (m.t === "start") return start(m);
  if (m.t === "stop") { drain(); return stop(m.reason === "ended" ? "ended" : "user"); }
  if (m.t === "cancel") return cancel();
  if (m.t === "mark") { drain(); mark(); return; }
  if (m.t === "recover") return recover();
}

onmessage = e => { handle(e.data).catch(fail); };

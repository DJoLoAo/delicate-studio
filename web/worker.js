const BLOCK = 65536;
const BUCKET = 256;
const BPB = BLOCK / BUCKET;
const CHUNK = 4096;
const READ_AHEAD = 8 << 20;

let wasmModule = null;
let cur = null;
let ring = null;
let play = null;
let fillTimer = 0;
let cancelImport = false;
let importing = Promise.resolve();
let downloadCtl = null;
const CT_EXT = { "audio/flac": "flac", "audio/x-flac": "flac", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav", "audio/aiff": "aiff", "audio/x-aiff": "aiff", "audio/ogg": "ogg", "audio/x-caf": "caf" };

async function tmpDir() {
  const root = await navigator.storage.getDirectory();
  const studio = await root.getDirectoryHandle("studio", { create: true });
  return studio.getDirectoryHandle("tmp", { create: true });
}

async function clearTmp() {
  try {
    const dir = await tmpDir();
    const names = [];
    for await (const [name] of dir.entries()) names.push(name);
    for (const n of names) { try { await dir.removeEntry(n); } catch {} }
  } catch {}
}

const tmpReady = clearTmp();

async function download(req, url, name) {
  await tmpReady;
  const ctl = new AbortController();
  downloadCtl = ctl;
  let res;
  try { res = await fetch(url, { signal: ctl.signal, credentials: "same-origin", cache: "no-store" }); }
  catch (e) { throw new Error(cancelImport ? "cancelled" : "network"); }
  if (res.status === 401) throw new Error("login");
  if (!res.ok || !res.body) throw new Error("download failed (" + res.status + ")");
  const total = Number(res.headers.get("content-length")) || 0;
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const dir = await tmpDir();
  const tmpName = crypto.randomUUID();
  const fh = await dir.getFileHandle(tmpName, { create: true });
  const h = await fh.createSyncAccessHandle();
  let got = 0, last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { throw new Error(cancelImport ? "cancelled" : "network"); }
      if (chunk.done) break;
      h.write(chunk.value, { at: got });
      got += chunk.value.length;
      const now = performance.now();
      if (now - last > 150) { last = now; postMessage({ t: "progress", req, name, phase: "download", frac: total ? Math.min(1, got / total) : 0, bytes: got, total }); }
      if (cancelImport) { ctl.abort(); throw new Error("cancelled"); }
    }
    h.flush();
  } catch (e) {
    try { h.close(); } catch {}
    try { await dir.removeEntry(tmpName); } catch {}
    throw e;
  } finally { downloadCtl = null; }
  h.close();
  if (total && got < total) { try { await dir.removeEntry(tmpName); } catch {} throw new Error("network"); }
  const file = await fh.getFile();
  return { file, type, tmpName };
}

async function docsDir() {
  const root = await navigator.storage.getDirectory();
  const studio = await root.getDirectoryHandle("studio", { create: true });
  return studio.getDirectoryHandle("docs", { create: true });
}

async function module() {
  if (!wasmModule) wasmModule = await WebAssembly.compileStreaming(fetch("/studio/studio-dsp.wasm"));
  return wasmModule;
}

async function syncHandle(fileHandle, readOnly) {
  if (readOnly) {
    try { return await fileHandle.createSyncAccessHandle({ mode: "read-only" }); } catch {}
  }
  return fileHandle.createSyncAccessHandle();
}

function errText(e) {
  const m = String(e && e.message || e);
  if (e && e.name === "NoModificationAllowedError") return "locked";
  if (e && e.name === "QuotaExceededError") return "quota";
  return m;
}

async function readJson(dir, name) {
  const f = await (await dir.getFileHandle(name)).getFile();
  return JSON.parse(await f.text());
}

async function writeFile(dir, name, data) {
  const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(data instanceof ArrayBuffer ? new Uint8Array(data) : data, { at: 0 });
    h.flush();
  } finally { h.close(); }
}

async function readFloat(dir, name) {
  const f = await (await dir.getFileHandle(name)).getFile();
  return new Float32Array(await f.arrayBuffer());
}

function biquad(type, f, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * Math.SQRT1_2);
  const a0 = 1 + a;
  const b = type === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * c / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function timelinePeaks(slotPeaks, ch, slots) {
  const buckets = slots * BPB;
  const out = new Float32Array(ch * buckets * 2);
  for (let s = 0; s < slots; s++) {
    for (let c = 0; c < ch; c++) {
      const src = ((s * ch + c) * BPB) * 2, dst = (c * buckets + s * BPB) * 2;
      out.set(slotPeaks.subarray(src, src + BPB * 2), dst);
    }
  }
  return out;
}

async function closeCur() {
  stopPlay();
  if (cur && cur.pool) { try { cur.pool.close(); } catch {} }
  cur = null;
}

async function importFile(req, file, opts) {
  opts = opts || {};
  const displayName = opts.name || file.name;
  const dir = await docsDir();
  const id = crypto.randomUUID();
  const docDir = await dir.getDirectoryHandle(id, { create: true });
  let pool = null;
  try {
    pool = await (await docDir.getFileHandle("pool.f32", { create: true })).createSyncAccessHandle();
    const mod = await module();
    const reader = new FileReaderSync();
    let mem = null, bytesSeen = 0, cBuf = null, cStart = 0, cLen = 0;
    const inst = await WebAssembly.instantiate(mod, { env: {
      read_at(pos, ptr, len) {
        let out = 0;
        while (out < len) {
          const at = pos + out;
          if (!cBuf || at < cStart || at >= cStart + cLen) {
            if (at >= file.size) break;
            cBuf = new Uint8Array(reader.readAsArrayBuffer(file.slice(at, Math.min(file.size, at + READ_AHEAD))));
            cStart = at;
            cLen = cBuf.length;
            if (!cLen) break;
          }
          const off = at - cStart, n = Math.min(len - out, cLen - off);
          new Uint8Array(mem.buffer, ptr + out, n).set(cBuf.subarray(off, off + n));
          out += n;
        }
        if (pos + out > bytesSeen) bytesSeen = pos + out;
        return out;
      },
      byte_len() { return file.size; }
    } });
    const x = inst.exports;
    mem = x.memory;
    const err = () => new TextDecoder().decode(new Uint8Array(mem.buffer, x.dec_error_ptr(), x.dec_error_len()));
    const ext = (opts.ext || (displayName.includes(".") ? displayName.split(".").pop() : "") || "").toLowerCase();
    const eb = new TextEncoder().encode(ext), ep = x.mem_alloc(eb.length);
    new Uint8Array(mem.buffer, ep, eb.length).set(eb);
    if (x.dec_open(ep, eb.length) !== 0) throw new Error(err());
    const sr = x.dec_sample_rate(), ch = x.dec_channels(), bits = x.dec_bits(), declared = x.dec_frames();
    if (!sr || !ch) throw new Error("unsupported file");
    const block = new Float32Array(BLOCK * ch);
    const slotBytes = BLOCK * ch * 4;
    const peakChunks = [], bandChunks = [];
    let fill = 0, slot = 0, total = 0;
    const lp = biquad("lp", 200, sr), hp = biquad("hp", 2500, sr);
    let bl = 0, bm = 0, bh = 0, bn = 0;
    let bandSlot = new Float32Array(BPB * 3), bandK = 0;
    const pushBand = () => {
      const k = bandK % BPB;
      bandSlot[k * 3] = Math.sqrt(bl / bn);
      bandSlot[k * 3 + 1] = Math.sqrt(bm / bn);
      bandSlot[k * 3 + 2] = Math.sqrt(bh / bn);
      bl = bm = bh = 0; bn = 0;
      bandK++;
      if (bandK % BPB === 0) { bandChunks.push(bandSlot); bandSlot = new Float32Array(BPB * 3); }
    };
    const flushSlot = () => {
      pool.write(new Uint8Array(block.buffer), { at: slot * slotBytes });
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
      peakChunks.push(pk);
      slot++;
      fill = 0;
      block.fill(0);
    };
    let lastPost = 0, lastYield = performance.now();
    for (;;) {
      const n = x.dec_next();
      if (n < 0) throw new Error(err());
      if (n === 0) break;
      const src = new Float32Array(mem.buffer, x.dec_buf(), n * ch);
      const lb0 = lp.b0, lb1 = lp.b1, lb2 = lp.b2, la1 = lp.a1, la2 = lp.a2;
      const hb0 = hp.b0, hb1 = hp.b1, hb2 = hp.b2, ha1 = hp.a1, ha2 = hp.a2;
      let lx1 = lp.x1, lx2 = lp.x2, ly1 = lp.y1, ly2 = lp.y2, hx1 = hp.x1, hx2 = hp.x2, hy1 = hp.y1, hy2 = hp.y2;
      const inv = 1 / ch, r = n;
      for (let i = 0; i < n; i++) {
        let m = src[i];
        for (let c = 1; c < ch; c++) m += src[c * r + i];
        m *= inv;
        const l = lb0 * m + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2;
        lx2 = lx1; lx1 = m; ly2 = ly1; ly1 = l;
        const h = hb0 * m + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
        hx2 = hx1; hx1 = m; hy2 = hy1; hy1 = h;
        const md = m - l - h;
        bl += l * l; bm += md * md; bh += h * h;
        if (++bn === BUCKET) pushBand();
      }
      lp.x1 = lx1; lp.x2 = lx2; lp.y1 = ly1; lp.y2 = ly2; hp.x1 = hx1; hp.x2 = hx2; hp.y1 = hy1; hp.y2 = hy2;
      let done = 0;
      while (done < n) {
        const run = Math.min(n - done, BLOCK - fill);
        for (let c = 0; c < ch; c++) block.set(src.subarray(c * n + done, c * n + done + run), c * BLOCK + fill);
        fill += run; done += run;
        if (fill === BLOCK) flushSlot();
      }
      total += n;
      const now = performance.now();
      if (now - lastPost > 150) {
        lastPost = now;
        postMessage({ t: "progress", req, name: displayName, phase: "decode", frac: declared > 0 ? Math.min(1, total / declared) : Math.min(1, bytesSeen / file.size) });
      }
      if (now - lastYield > 120) {
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
        if (cancelImport) throw new Error("cancelled");
      }
    }
    x.dec_close();
    if (total === 0) throw new Error("no audio in file");
    if (bn > 0) pushBand();
    if (fill > 0) flushSlot();
    if (bandK % BPB !== 0) bandChunks.push(bandSlot);
    pool.flush();
    pool.close();
    pool = null;
    const slots = slot;
    const slotPeaks = new Float32Array(slots * ch * BPB * 2);
    peakChunks.forEach((p, i) => slotPeaks.set(p, i * ch * BPB * 2));
    const bands = new Float32Array(slots * BPB * 3);
    bandChunks.forEach((b, i) => { if (i < slots) bands.set(b, i * BPB * 3); });
    await writeFile(docDir, "peaks.f32", slotPeaks);
    await writeFile(docDir, "bands.f32", bands);
    const source = opts.source || { kind: "local", lastModified: file.lastModified || 0 };
    const meta = { v: 1, id, name: displayName, ext, size: file.size, sampleRate: sr, channels: ch, bits, frames: total, blockFrames: BLOCK, slots, created: Date.now(), opened: Date.now(), readOnly: source.kind === "library" || source.kind === "locker", source };
    await writeFile(docDir, "meta.json", new TextEncoder().encode(JSON.stringify(meta)));
    return meta;
  } catch (e) {
    if (pool) { try { pool.close(); } catch {} }
    try { await dir.removeEntry(id, { recursive: true }); } catch {}
    throw e;
  }
}

async function openDoc(id) {
  const dir = await docsDir();
  const docDir = await dir.getDirectoryHandle(id);
  const meta = await readJson(docDir, "meta.json");
  const slotPeaks = await readFloat(docDir, "peaks.f32");
  const bands = await readFloat(docDir, "bands.f32");
  await closeCur();
  const pool = await syncHandle(await docDir.getFileHandle("pool.f32"), true);
  meta.opened = Date.now();
  try { await writeFile(docDir, "meta.json", new TextEncoder().encode(JSON.stringify(meta))); } catch {}
  cur = { meta, pool, dir: docDir };
  return { meta, peaks: timelinePeaks(slotPeaks, meta.channels, meta.slots), bands };
}

function readPlanar(start, count, out, outStride) {
  const m = cur.meta, ch = m.channels;
  for (let c = 0; c < ch; c++) {
    let done = 0;
    while (done < count) {
      const f = start + done;
      if (f >= m.frames || f < 0) { out.fill(0, c * outStride + done, c * outStride + count); break; }
      const s = Math.floor(f / BLOCK), off = f % BLOCK;
      const run = Math.min(count - done, BLOCK - off, m.frames - f);
      const view = new Uint8Array(out.buffer, out.byteOffset + (c * outStride + done) * 4, run * 4);
      cur.pool.read(view, { at: (s * BLOCK * ch + c * BLOCK + off) * 4 });
      done += run;
    }
  }
}

async function listDocs() {
  const dir = await docsDir();
  const docs = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "directory") continue;
    try { docs.push(await readJson(h, "meta.json")); } catch {}
  }
  docs.sort((a, b) => (b.opened || 0) - (a.opened || 0));
  let usage = 0, quota = 0, persisted = false;
  try { const e = await navigator.storage.estimate(); usage = e.usage || 0; quota = e.quota || 0; } catch {}
  try { persisted = await navigator.storage.persisted(); } catch {}
  return { docs, usage, quota, persisted };
}

function stopPlay() {
  if (fillTimer) { clearInterval(fillTimer); fillTimer = 0; }
  if (ring) Atomics.store(ring.ctrl, 0, 0);
  play = null;
}

function srcPos(w) {
  const len = play.end - play.start;
  return play.loop ? play.start + ((w + play.off) % len) : play.start + w;
}

function fillRing() {
  if (!play || !cur || !ring) return;
  const ctrl = ring.ctrl, R = ring.size, ch = cur.meta.channels;
  const len = play.end - play.start;
  for (let guard = 0; guard < 64; guard++) {
    const w = Atomics.load(ctrl, 1), r = Atomics.load(ctrl, 2);
    const free = R - (w - r);
    if (free < CHUNK) return;
    if (!play.loop && w >= len) return;
    let n = Math.min(CHUNK, free);
    if (!play.loop) n = Math.min(n, len - w);
    let done = 0;
    while (done < n) {
      const p = srcPos(w + done);
      const run = play.loop ? Math.min(n - done, play.end - p) : n - done;
      readPlanar(p, run, play.tmp, CHUNK);
      for (let c = 0; c < ch; c++) {
        const tmpOff = c * CHUNK;
        for (let i = 0; i < run; i++) ring.data[c * R + ((w + done + i) % R)] = play.tmp[tmpOff + i];
      }
      done += run;
    }
    Atomics.store(ctrl, 1, w + n);
  }
}

function startPlay(start, end, loop, off) {
  stopPlay();
  if (!cur || !ring) return;
  const m = cur.meta;
  start = Math.max(0, Math.min(Math.floor(start), m.frames));
  end = Math.max(start, Math.min(Math.floor(end), m.frames));
  if (end - start < 1) return;
  play = { start, end, loop: !!loop, off: loop ? Math.max(0, Math.min(end - start - 1, Math.floor(off || 0))) : 0, tmp: new Float32Array(CHUNK * m.channels) };
  const ctrl = ring.ctrl;
  Atomics.store(ctrl, 1, 0);
  Atomics.store(ctrl, 2, 0);
  Atomics.store(ctrl, 4, 0);
  Atomics.store(ctrl, 5, loop ? -1 : end - start);
  fillRing();
  Atomics.add(ctrl, 3, 1);
  Atomics.store(ctrl, 0, 1);
  fillTimer = setInterval(() => {
    if (!play) return;
    const st = Atomics.load(ring.ctrl, 0);
    if (st !== 1) { stopPlay(); return; }
    try { fillRing(); } catch (e) { stopPlay(); postMessage({ t: "playerror", msg: errText(e) }); }
  }, 8);
}

onmessage = async e => {
  const m = e.data;
  try {
    if (m.t === "cancel") { cancelImport = true; if (downloadCtl) downloadCtl.abort(); return; }
    if (m.t === "ring") { ring = { data: new Float32Array(m.data), ctrl: new Int32Array(m.ctrl), size: m.size }; return; }
    if (m.t === "play") { startPlay(m.start, m.end, m.loop, m.off); return; }
    if (m.t === "stop") { stopPlay(); return; }
    if (m.t === "list") { postMessage(Object.assign({ t: "list", req: m.req }, await listDocs())); return; }
    if (m.t === "persist") { let ok = false; try { ok = await navigator.storage.persist(); } catch {} postMessage({ t: "persist", req: m.req, ok }); return; }
    if (m.t === "import") {
      const job = importing.then(async () => {
        let tmp = null;
        try {
          cancelImport = false;
          let file = m.file, opts = {};
          if (m.url) {
            postMessage({ t: "progress", req: m.req, name: m.name, phase: "download", frac: 0, bytes: 0, total: 0 });
            const d = await download(m.req, m.url, m.name);
            tmp = d.tmpName;
            file = d.file;
            const ext = m.ext || CT_EXT[d.type] || "";
            opts = { name: m.name + (ext && !m.name.toLowerCase().endsWith("." + ext) ? "." + ext : ""), ext, source: m.source };
          }
          const meta = await importFile(m.req, file, opts);
          const r = await openDoc(meta.id);
          postMessage({ t: "opened", req: m.req, meta: r.meta, peaks: r.peaks, bands: r.bands }, [r.peaks.buffer, r.bands.buffer]);
        } catch (err) { postMessage({ t: "error", req: m.req, msg: errText(err), name: m.file ? m.file.name : m.name }); }
        if (tmp) { try { await (await tmpDir()).removeEntry(tmp); } catch {} }
      });
      importing = job;
      return;
    }
    if (m.t === "open") {
      await importing;
      const r = await openDoc(m.id);
      postMessage({ t: "opened", req: m.req, meta: r.meta, peaks: r.peaks, bands: r.bands }, [r.peaks.buffer, r.bands.buffer]);
      return;
    }
    if (m.t === "close") { await closeCur(); postMessage({ t: "closed", req: m.req }); return; }
    if (m.t === "remove") {
      await importing;
      if (cur && cur.meta.id === m.id) await closeCur();
      const dir = await docsDir();
      await dir.removeEntry(m.id, { recursive: true });
      postMessage({ t: "removed", req: m.req, id: m.id });
      return;
    }
    if (m.t === "read") {
      if (!cur || cur.meta.id !== m.id) { postMessage({ t: "samples", req: m.req, id: m.id, start: m.start, count: 0, data: new Float32Array(0) }); return; }
      const count = Math.max(0, Math.min(m.count, 4194304));
      const data = new Float32Array(count * cur.meta.channels);
      readPlanar(m.start, count, data, count);
      postMessage({ t: "samples", req: m.req, id: m.id, start: m.start, count, data }, [data.buffer]);
      return;
    }
  } catch (err) {
    postMessage({ t: "error", req: m.req, msg: errText(err) });
  }
};

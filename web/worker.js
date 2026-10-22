importScripts("/edit.js", "/trcore.js");

const BLOCK = 65536;
const BUCKET = 256;
const BPB = BLOCK / BUCKET;
const CHUNK = 4096;
const READ_AHEAD = 8 << 20;
const MAT = 1 << 16;
const HIST_MAX = 500;
const BACKUP_EVERY = 25;
const BACKUPS = 5;

let wasmModule = null;
let cur = null;
let ring = null;
let play = null;
let fillTimer = 0;
let cancelImport = false;
let importing = Promise.resolve();
let downloadCtl = null;
let clip = null;
let q = Promise.resolve();
const lingering = new Map();
const CT_EXT = { "audio/flac": "flac", "audio/x-flac": "flac", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav", "audio/aiff": "aiff", "audio/x-aiff": "aiff", "audio/ogg": "ogg", "audio/x-caf": "caf" };

function enqueue(fn) {
  const p = q.then(fn);
  q = p.catch(() => {});
  return p;
}

async function studioDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("studio", { create: true });
}

async function tmpDir() {
  return (await studioDir()).getDirectoryHandle("tmp", { create: true });
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
      putAt(h, chunk.value, got);
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
  return (await studioDir()).getDirectoryHandle("docs", { create: true });
}

async function wasmMod() {
  if (!wasmModule) wasmModule = await WebAssembly.compileStreaming(fetch("/studio-dsp.wasm"));
  return wasmModule;
}

async function syncHandle(fileHandle, readOnly) {
  if (readOnly) {
    try { return await fileHandle.createSyncAccessHandle({ mode: "read-only" }); } catch {}
  }
  return fileHandle.createSyncAccessHandle();
}

async function exclusive(fh) {
  for (let i = 0; ; i++) {
    try { return await fh.createSyncAccessHandle(); }
    catch (e) { if (e.name !== "NoModificationAllowedError" || i >= 8) throw e; await new Promise(r => setTimeout(r, 200)); }
  }
}

function putAt(h, data, at) {
  if (h.write(data, { at }) !== data.byteLength) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
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

const enc = o => new TextEncoder().encode(JSON.stringify(o));

async function writeFile(dir, name, data) {
  const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    putAt(h, data instanceof ArrayBuffer ? new Uint8Array(data) : data, 0);
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

function clampI(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(Number(v) || 0))); }

function summer(sr) {
  return { lp: biquad("lp", 200, sr), hp: biquad("hp", 2500, sr), mn: Infinity, mx: -Infinity, l: 0, m: 0, h: 0, k: 0, pk: [], bd: [] };
}

function sumFeed(S, d, n) {
  const lp = S.lp, hp = S.hp, pk = S.pk, bd = S.bd;
  const lb0 = lp.b0, lb1 = lp.b1, lb2 = lp.b2, la1 = lp.a1, la2 = lp.a2;
  const hb0 = hp.b0, hb1 = hp.b1, hb2 = hp.b2, ha1 = hp.a1, ha2 = hp.a2;
  let lx1 = lp.x1, lx2 = lp.x2, ly1 = lp.y1, ly2 = lp.y2, hx1 = hp.x1, hx2 = hp.x2, hy1 = hp.y1, hy2 = hp.y2;
  let mn = S.mn, mx = S.mx, bl = S.l, bm = S.m, bh = S.h, k = S.k;
  for (let i = 0; i < n; i++) {
    const v = d[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    const l = lb0 * v + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2;
    lx2 = lx1; lx1 = v; ly2 = ly1; ly1 = l;
    const h = hb0 * v + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
    hx2 = hx1; hx1 = v; hy2 = hy1; hy1 = h;
    const md = v - l - h;
    bl += l * l; bm += md * md; bh += h * h;
    if (++k === BUCKET) {
      pk.push(mn, mx);
      bd.push(Math.sqrt(bl / k), Math.sqrt(bm / k), Math.sqrt(bh / k));
      mn = Infinity; mx = -Infinity; bl = bm = bh = 0; k = 0;
    }
  }
  lp.x1 = lx1; lp.x2 = lx2; lp.y1 = ly1; lp.y2 = ly2; hp.x1 = hx1; hp.x2 = hx2; hp.y1 = hy1; hp.y2 = hy2;
  S.mn = mn; S.mx = mx; S.l = bl; S.m = bm; S.h = bh; S.k = k;
}

function sumEnd(S) {
  if (S.k) {
    S.pk.push(S.mn, S.mx);
    S.bd.push(Math.sqrt(S.l / S.k), Math.sqrt(S.m / S.k), Math.sqrt(S.h / S.k));
  }
  return { pk: Float32Array.from(S.pk), bd: Float32Array.from(S.bd) };
}

function poolRead(d, c, f, n, out, off) {
  const ch = d.meta.channels;
  let done = 0;
  while (done < n) {
    const p = f + done, s = Math.floor(p / BLOCK), o = p % BLOCK;
    const run = Math.min(n - done, BLOCK - o);
    d.pool.read(new Uint8Array(out.buffer, out.byteOffset + (off + done) * 4, run * 4), { at: (s * BLOCK * ch + c * BLOCK + o) * 4 });
    done += run;
  }
}

function readSrcOf(d, src, c, f, n, out, off) {
  if (n <= 0) return;
  if (src === 0) { poolRead(d, c, f, n, out, off); return; }
  const a = d.allocs[src];
  d.heap.read(new Uint8Array(out.buffer, out.byteOffset + off * 4, n * 4), { at: (a[0] + f) * 4 });
}

function readSrc(src, c, f, n, out, off) { readSrcOf(cur, src, c, f, n, out, off); }

function readClip(start, count, out, stride) {
  const c = cur;
  for (let k = 0; k < c.lists.length; k++) readList(c.lists[k], c.cum[k], start, count, out, k * stride, readSrc);
}

function allocBegin() {
  return { off: cur.heapEnd, n: 0, S: summer(cur.meta.sampleRate) };
}

function allocPush(w, d, n) {
  putAt(cur.heap, new Uint8Array(d.buffer, d.byteOffset, n * 4), (w.off + w.n) * 4);
  sumFeed(w.S, d, n);
  w.n += n;
  cur.heapEnd = w.off + w.n;
}

function allocEnd(w) {
  const s = sumEnd(w.S);
  const both = new Float32Array(s.pk.length + s.bd.length);
  both.set(s.pk);
  both.set(s.bd, s.pk.length);
  const pkOff = cur.pkEnd;
  putAt(cur.hpk, new Uint8Array(both.buffer), pkOff * 4);
  cur.pkEnd += both.length;
  const id = cur.allocs.length;
  cur.allocs.push([w.off, w.n, pkOff]);
  cur.sums[id] = s;
  return id;
}

function allocData(d) {
  const w = allocBegin();
  allocPush(w, d, d.length);
  return allocEnd(w);
}

function makeIo() {
  return {
    sampleRate: cur.meta.sampleRate,
    srcLen: src => src === 0 ? cur.meta.frames : cur.allocs[src][1],
    read: (src, c, f, n) => { const out = new Float32Array(n); readSrc(src, c, f, n, out, 0); return out; },
    alloc: allocData
  };
}

function origLists(meta) {
  return Array.from({ length: meta.channels }, (_, c) => [[0, c, 0, meta.frames]]);
}

function setLists(lists) {
  cur.marks = cur.hist[cur.idx].marks;
  cur.lists = lists;
  cur.cum = lists.map(cumOf);
  cur.len = clipLen(lists[0]);
}

function edgeOf(seg) {
  if (seg[0] === SIL) return null;
  const key = seg[0] + ":" + seg[1] + ":" + seg[2] + ":" + seg[3];
  let e = cur.edges.get(key);
  if (e) return e;
  const st = seg[2], end = st + seg[3];
  const h1 = Math.min(end, Math.ceil(st / BUCKET) * BUCKET), t0 = Math.max(h1, Math.floor(end / BUCKET) * BUCKET);
  e = [Infinity, -Infinity, Infinity, -Infinity];
  const buf = new Float32Array(BUCKET);
  const mm = (f, n, k) => {
    readSrc(seg[0], seg[1], f, n, buf, 0);
    for (let i = 0; i < n; i++) { const v = buf[i]; if (v < e[k]) e[k] = v; if (v > e[k + 1]) e[k + 1] = v; }
  };
  if (h1 > st) mm(st, h1 - st, 0);
  if (end > t0) mm(t0, end - t0, 2);
  cur.edges.set(key, e);
  return e;
}

function histInfo(h) {
  return { op: h.op, a: h.a, b: h.b, n: h.n || 0, ch: h.ch || null, t: h.t, mk: h.mk || null };
}

function clipInfo() {
  return clip ? { n: clip.n, ch: clip.ch, sr: clip.sr } : null;
}

function statePayload(have, extra) {
  const c = cur;
  const allocs = [];
  for (let id = Math.max(1, have || 1); id < c.allocs.length; id++) {
    const s = c.sums[id];
    allocs.push({ id, n: c.allocs[id][1], pk: s.pk, bd: s.bd });
  }
  c.ver++;
  return Object.assign({ len: c.len, lists: c.lists, edges: c.lists.map(l => l.map(edgeOf)), allocs, hist: c.hist.map(histInfo), idx: c.idx, marks: c.marks, ver: c.ver, clip: clipInfo(), saveErr: c.saveErr }, extra || {});
}

function validLists(lists, meta, allocs) {
  if (!Array.isArray(lists) || lists.length !== meta.channels) return false;
  let len = -1;
  for (const list of lists) {
    if (!Array.isArray(list) || !list.length) return false;
    let n = 0;
    for (const s of list) {
      if (!Array.isArray(s) || s.length !== 4 || !s.every(Number.isInteger) || s[3] <= 0 || s[2] < 0) return false;
      if (s[0] === SIL) { n += s[3]; continue; }
      if (s[0] === 0) { if (s[1] < 0 || s[1] >= meta.channels || s[2] + s[3] > meta.frames) return false; }
      else { const a = allocs[s[0]]; if (!a || s[1] !== 0 || s[2] + s[3] > a[1]) return false; }
      n += s[3];
    }
    if (len >= 0 && n !== len) return false;
    len = n;
  }
  return len > 0;
}

function validMarks(marks, len) {
  if (!Array.isArray(marks)) return false;
  const ids = new Set(), nums = new Set();
  for (const m of marks) {
    if (!m || !Number.isInteger(m.id) || !Number.isInteger(m.n) || m.n < 1 || ids.has(m.id) || nums.has(m.n)) return false;
    if (!["point", "range", "view"].includes(m.kind) || !Number.isInteger(m.a) || m.a < 0 || m.a > len) return false;
    if (m.kind === "range" && (!Number.isInteger(m.b) || m.b <= m.a || m.b > len)) return false;
    ids.add(m.id); nums.add(m.n);
  }
  return true;
}

function rebuild(j, meta, heapFrames, pkFloats) {
  try {
    if (!j || j.v !== 1 || !Array.isArray(j.allocs) || j.allocs[0] !== null || !Array.isArray(j.hist) || !j.hist.length) return null;
    const allocs = j.allocs;
    for (let i = 1; i < allocs.length; i++) {
      const a = allocs[i];
      if (!Array.isArray(a) || a.length !== 3 || !a.every(Number.isInteger) || a[1] <= 0 || a[0] + a[1] > heapFrames || a[2] + Math.ceil(a[1] / BUCKET) * 5 > pkFloats) return null;
    }
    const pick = h => ({ op: String(h.op || ""), a: h.a | 0, b: h.b | 0, n: h.n | 0, ch: h.ch || null, mk: h.mk || null, t: h.t || 0, before: h.before || null, after: h.after || null });
    let prev = origLists(meta), prevMarks = Array.isArray(j.hist[0].m) ? j.hist[0].m : [];
    if (!validMarks(prevMarks, meta.frames)) return null;
    const hist = [Object.assign(pick(j.hist[0]), { lists: prev, marks: prevMarks })];
    for (let i = 1; i < j.hist.length; i++) {
      const h = j.hist[i];
      let lists;
      if (h.full) lists = h.full.map(l => l.map(s => s.slice()));
      else if (Array.isArray(h.d) && h.d.length === meta.channels) lists = h.d.map((d, k) => applyDiff(prev[k], d));
      else return null;
      if (!validLists(lists, meta, allocs)) return null;
      const marks = Array.isArray(h.m) ? h.m : prevMarks;
      if (marks !== prevMarks && !validMarks(marks, clipLen(lists[0]))) return null;
      hist.push(Object.assign(pick(h), { lists, marks, d: h.full ? null : h.d, full: !!h.full }));
      prev = lists;
      prevMarks = marks;
    }
    if (!Number.isInteger(j.idx) || j.idx < 0 || j.idx >= hist.length) return null;
    return { allocs, hist, idx: j.idx, seq: j.seq };
  } catch { return null; }
}

async function loadEdits(dir, meta, heapFrames, pkFloats) {
  const names = ["edits-a.json", "edits-b.json"];
  for (let i = 0; i < BACKUPS; i++) names.push("edits-bak-" + i + ".json");
  const found = [];
  let broken = false;
  for (const nm of names) {
    let fh;
    try { fh = await dir.getFileHandle(nm); } catch { continue; }
    try {
      const j = JSON.parse(await (await fh.getFile()).text());
      if (j && Number.isFinite(j.seq)) found.push({ nm, j }); else broken = true;
    } catch { broken = true; }
  }
  found.sort((x, y) => y.j.seq - x.j.seq);
  for (let i = 0; i < found.length; i++) {
    const st = rebuild(found[i].j, meta, heapFrames, pkFloats);
    if (st) return Object.assign(st, { recovered: broken || i > 0 && found[0].j.seq > st.seq });
    broken = true;
  }
  return { recovered: broken && found.length > 0 };
}

async function persistNow(c) {
  c.heap.flush();
  c.hpk.flush();
  c.seq++;
  const body = enc({
    v: 1, seq: c.seq, id: c.meta.id, allocs: c.allocs, idx: c.idx,
    hist: c.hist.map((h, i) => {
      const o = { op: h.op, a: h.a, b: h.b, n: h.n || 0, ch: h.ch || null, t: h.t, before: h.before, after: h.after };
      if (h.mk) o.mk = h.mk;
      if (i > 0) { if (h.full) o.full = h.lists; else o.d = h.d; }
      if (i === 0 ? h.marks.length : h.full || h.marks !== c.hist[i - 1].marks) o.m = h.marks;
      return o;
    })
  });
  await writeFile(c.dir, c.seq % 2 ? "edits-a.json" : "edits-b.json", body);
  if (c.seq % BACKUP_EVERY === 0) await writeFile(c.dir, "edits-bak-" + ((c.seq / BACKUP_EVERY) % BACKUPS) + ".json", body);
  c.meta.len = c.len;
  c.meta.edits = c.idx;
  c.meta.heapBytes = c.heapEnd * 4;
  await writeFile(c.dir, "meta.json", enc(c.meta));
}

function persist() {
  const c = cur;
  c.dirty = true;
  if (c.saving) return c.saving;
  c.saving = (async () => {
    while (c.dirty) {
      c.dirty = false;
      try { await persistNow(c); c.saveErr = null; } catch (e) { c.saveErr = errText(e); }
    }
    c.saving = null;
  })();
  return c.saving;
}

function pushHist(info, lists, before, after, marks) {
  const c = cur;
  c.hist.length = c.idx + 1;
  const prev = c.hist[c.idx].lists;
  const d = lists.map((l, k) => diffList(prev[k], l));
  c.hist.push(Object.assign({ t: Date.now(), lists, marks: marks || mapMarks(c.hist[c.idx].marks, info), d, full: false, before, after }, info));
  if (c.hist.length > HIST_MAX + 1) {
    c.hist.splice(1, 1);
    c.hist[1].full = true;
    c.hist[1].d = null;
  }
  c.idx = c.hist.length - 1;
  setLists(lists);
}

function chanLabel(chans) {
  const ch = chans.length;
  const on = chans.map((v, i) => v ? i : -1).filter(i => i >= 0);
  if (ch === 2) return on[0] === 0 ? "L" : "R";
  return on.map(i => i + 1).join(",");
}

function snapZero(pos, chans, dir, side, ms) {
  const c = cur, w = Math.max(1, Math.round(c.meta.sampleRate * (ms || 10) / 1000));
  const a0 = Math.max(0, pos - w), a1 = Math.min(c.len, pos + w);
  if (a1 - a0 < 2) return { p: pos, d: 0 };
  const n = a1 - a0, buf = new Float32Array(n), m = new Float32Array(n);
  for (let k = 0; k < chans.length; k++) {
    if (!chans[k]) continue;
    readList(c.lists[k], c.cum[k], a0, n, buf, 0, readSrc);
    for (let i = 0; i < n; i++) m[i] += buf[i];
  }
  let best = -1, bestD = Infinity, bestDir = 0;
  for (let i = 1; i < n; i++) {
    const x = m[i - 1], y = m[i];
    const dd = x < 0 && y >= 0 ? 1 : x > 0 && y <= 0 ? -1 : 0;
    if (!dd || (dir && dd !== dir)) continue;
    const p = a0 + i, dist = Math.abs(p - pos);
    if ((side > 0 && p < pos) || (side < 0 && p > pos)) continue;
    if (dist < bestD) { bestD = dist; best = p; bestDir = dd; }
  }
  return best < 0 ? { p: pos, d: 0 } : { p: best, d: bestDir };
}

async function dropClipFiles() {
  try {
    const d = await studioDir();
    for (const n of ["clipboard.json", "clipboard.f32"]) { try { await d.removeEntry(n); } catch {} }
  } catch {}
}

async function setClip(a, b, chans) {
  const lists = opCopy(cur.lists, a, b, chans);
  clip = { sr: cur.meta.sampleRate, ch: lists.length, n: b - a, doc: cur.meta.id, lists, cum: lists.map(cumOf), file: false };
  await dropClipFiles();
}

async function loadClip() {
  try {
    const d = await studioDir();
    const j = await readJson(d, "clipboard.json");
    const f = await (await d.getFileHandle("clipboard.f32")).getFile();
    if (j.sr > 0 && j.ch > 0 && j.n > 0 && f.size === j.ch * j.n * 4) clip = { sr: j.sr, ch: j.ch, n: j.n, file: true, cache: new Map() };
  } catch {}
}

const clipReady = loadClip();

async function materializeClip() {
  const cb = clip;
  const d = await studioDir();
  const h = await (await d.getFileHandle("clipboard.f32", { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    const buf = new Float32Array(MAT);
    for (let k = 0; k < cb.ch; k++) {
      for (let f = 0; f < cb.n; f += MAT) {
        const n = Math.min(MAT, cb.n - f);
        readList(cb.lists[k], cb.cum[k], f, n, buf, 0, readSrc);
        putAt(h, new Uint8Array(buf.buffer, 0, n * 4), (k * cb.n + f) * 4);
      }
    }
    h.flush();
  } finally { h.close(); }
  await writeFile(d, "clipboard.json", enc({ sr: cb.sr, ch: cb.ch, n: cb.n }));
  clip = { sr: cb.sr, ch: cb.ch, n: cb.n, file: true, cache: new Map() };
}

async function clipAlloc(k) {
  const cb = clip, key = cur.meta.id + ":" + k;
  if (cb.file && cb.cache.has(key)) {
    const id = cb.cache.get(key);
    if (cur.allocs[id] && cur.allocs[id][1] === cb.n) return id;
  }
  const h = cb.file ? await (await (await studioDir()).getFileHandle("clipboard.f32")).createSyncAccessHandle() : null;
  try {
    const w = allocBegin(), buf = new Float32Array(MAT), acc = new Float32Array(MAT);
    const chans = k >= 0 ? [k] : Array.from({ length: cb.ch }, (_, i) => i);
    for (let f = 0; f < cb.n; f += MAT) {
      const n = Math.min(MAT, cb.n - f);
      acc.fill(0, 0, n);
      for (const kk of chans) {
        if (h) h.read(new Uint8Array(buf.buffer, 0, n * 4), { at: (kk * cb.n + f) * 4 });
        else readList(cb.lists[kk], cb.cum[kk], f, n, buf, 0, readSrc);
        for (let i = 0; i < n; i++) acc[i] += buf[i];
      }
      if (chans.length > 1) { const g = 1 / chans.length; for (let i = 0; i < n; i++) acc[i] *= g; }
      allocPush(w, acc, n);
    }
    const id = allocEnd(w);
    if (cb.file) cb.cache.set(key, id);
    return id;
  } finally { if (h) h.close(); }
}

async function clipLists(targets) {
  const cb = clip, K = cb.ch, T = targets.length;
  const out = [], made = new Map();
  for (let i = 0; i < T; i++) {
    const k = K === T ? i : K === 1 ? 0 : T === 1 ? -1 : i % K;
    if (!made.has(k)) made.set(k, !cb.file && k >= 0 ? cb.lists[k].map(s => s.slice()) : [[await clipAlloc(k), 0, 0, cb.n]]);
    out.push(made.get(k));
  }
  return out;
}

async function applyEdit(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  await clipReady;
  const ch = c.meta.channels, sr = c.meta.sampleRate, F = c.len;
  const X = Math.max(0, Math.round((Number(m.xfade) || 0) * sr / 1000));
  const chans = Array.isArray(m.chans) && m.chans.length === ch && m.chans.some(Boolean) ? m.chans.map(Boolean) : new Array(ch).fill(true);
  const all = chans.every(Boolean);
  let a = clampI(m.a, 0, F), b = clampI(m.b, 0, F);
  if (b < a) [a, b] = [b, a];
  const selOn = b > a;
  let pos = selOn ? a : clampI(m.cursor, 0, F);
  const before = { a, b, cursor: clampI(m.cursor, 0, F) };
  if (m.snap) {
    if (selOn) {
      const sa = snapZero(a, chans, 0), sb = snapZero(b, chans, sa.d);
      if (sb.p > sa.p) { a = sa.p; b = sb.p; pos = a; }
    } else pos = snapZero(pos, chans, 0).p;
  }
  const need = () => { if (!selOn) throw new Error("nosel"); };
  const label = all ? null : chanLabel(chans);
  let lists, info, after;
  switch (m.op) {
    case "copy":
      need();
      await setClip(a, b, chans);
      return { t: "copied", clip: clipInfo(), sel: { a, b, cursor: a } };
    case "delete":
    case "cut":
      need();
      if (all && b - a >= F) throw new Error("empty");
      if (m.op === "cut") await setClip(a, b, chans);
      lists = all ? opDelete(c.lists, a, b, X, c.io) : opSilence(c.lists, a, b, chans, X, c.io);
      info = { op: m.op, a, b, n: 0, ch: label };
      after = all ? { a, b: a, cursor: a } : { a, b, cursor: a };
      break;
    case "silence":
      need();
      lists = opSilence(c.lists, a, b, chans, X, c.io);
      info = { op: "silence", a, b, n: 0, ch: label };
      after = { a, b, cursor: a };
      break;
    case "crop":
      need();
      if (a === 0 && b === F) throw new Error("nothing");
      lists = opCrop(c.lists, a, b);
      info = { op: "crop", a, b, n: 0, ch: null };
      after = { a: 0, b: 0, cursor: 0 };
      break;
    case "insert": {
      const n = clampI(m.n, 0, sr * 3600 * 6);
      if (n < 1) throw new Error("nothing");
      const ins = Array.from({ length: ch }, () => [[SIL, 0, 0, n]]);
      lists = opInsert(c.lists, pos, ins, X, c.io);
      info = { op: "insert", a: pos, b: pos, n, ch: null };
      after = { a: pos, b: pos + n, cursor: pos };
      break;
    }
    case "paste": {
      if (!clip || (!clip.file && clip.doc !== c.meta.id)) throw new Error("noclip");
      if (clip.sr !== sr) throw new Error("rate:" + clip.sr);
      const targets = [];
      chans.forEach((v, k) => { if (v) targets.push(k); });
      const src = await clipLists(targets);
      const n = clip.n;
      if (all) {
        const p0 = selOn ? a : pos, p1 = selOn ? b : pos;
        lists = opReplace(c.lists, p0, p1, src, X, c.io);
        info = { op: "paste", a: p0, b: p1, n, ch: null };
        after = { a: p0, b: p0 + n, cursor: p0 };
      } else {
        const ins = new Array(ch).fill(null);
        targets.forEach((k, i) => { ins[k] = src[i]; });
        const end = Math.min(F, pos + n);
        if (end <= pos) throw new Error("nothing");
        lists = opOverwrite(c.lists, pos, ins, X, c.io);
        info = { op: "paste", a: pos, b: end, n: end - pos, ch: label };
        after = { a: pos, b: end, cursor: pos };
      }
      break;
    }
    case "heal": {
      need();
      lists = await healSel(c, a, b, chans);
      info = { op: "heal", a, b, n: 0, ch: label };
      after = { a, b, cursor: a };
      break;
    }
    case "spheal":
    case "spdel": {
      const r = await shApply(c, m);
      lists = r.lists;
      info = { op: m.op === "spdel" ? "spdel" : m.src === "brush" ? "spot" : "spheal", a: r.a, b: r.b, n: r.clicks, ch: r.ch };
      after = { a: before.a, b: before.b, cursor: before.cursor };
      break;
    }
    case "markadd":
    case "markset":
    case "markdel":
    case "marktracks": {
      const r = markOp(m, before);
      pushHist(r.info, c.lists, before, before, r.marks);
      persist();
      return statePayload(m.have, { t: "state", sel: null, mark: r.id });
    }
    default:
      throw new Error("unknown edit");
  }
  pushHist(info, lists, before, after);
  persist();
  return statePayload(m.have, { t: "state", sel: after });
}

function markOp(m, before) {
  const c = cur, F = c.len, marks = c.marks;
  const used = new Set(marks.map(x => x.n));
  const freeN = () => { let n = 1; while (used.has(n)) n++; return n; };
  const shape = (x, src) => {
    const kind = ["point", "range", "view"].includes(src.kind) ? src.kind : x.kind;
    const out = Object.assign({}, x, { kind });
    if (src.name !== undefined) out.name = String(src.name).slice(0, 120);
    if (src.view !== undefined) out.view = src.view && Number.isFinite(src.view.start) && Number.isFinite(src.view.spp) && src.view.spp > 0 ? { start: src.view.start, spp: src.view.spp } : null;
    if (src.chans !== undefined) out.chans = Array.isArray(src.chans) && src.chans.length === c.meta.channels && src.chans.some(Boolean) ? src.chans.map(Boolean) : null;
    if (src.a !== undefined) out.a = clampI(src.a, 0, F);
    if (src.b !== undefined) out.b = clampI(src.b, 0, F);
    if (kind === "view") { out.a = 0; delete out.b; }
    else if (kind === "point") delete out.b;
    else { if (!(out.b > out.a)) throw new Error("nosel"); }
    return out;
  };
  if (m.op === "marktracks") {
    const keep = marks.filter(x => x.kind !== "range"), taken = new Set(keep.map(x => x.n)), add = [];
    let id = 1, n = 1;
    for (const h of c.hist) for (const x of h.marks) if (x.id >= id) id = x.id + 1;
    for (const tr of Array.isArray(m.tracks) ? m.tracks.slice(0, 300) : []) {
      const a = clampI(tr && tr.a, 0, F), b = clampI(tr && tr.b, 0, F);
      if (!(b > a)) continue;
      while (taken.has(n)) n++;
      if (n > 999) break;
      const mk = shape({ id: id++, n, kind: "range", a, b, name: "", view: null, chans: null }, { name: tr.name || "" });
      const tag = trTagClean(tr.tag);
      if (tag) mk.tag = tag;
      taken.add(n);
      add.push(mk);
    }
    if (!add.length) throw new Error("nosel");
    return { id: add[0].id, marks: keep.concat(add).sort((x, y) => x.n - y.n), info: { op: "marktracks", a: add[0].a, b: add[add.length - 1].b, n: add.length, ch: null, mk: { n: add.length, name: "", kind: "range", removed: marks.length - keep.length } } };
  }
  if (m.op === "markadd") {
    let id = 1;
    for (const h of c.hist) for (const x of h.marks) if (x.id >= id) id = x.id + 1;
    const want = Number.isInteger(m.mark && m.mark.n) && m.mark.n > 0 && m.mark.n <= 999 && !used.has(m.mark.n) ? m.mark.n : freeN();
    const mk = shape({ id, n: want, kind: "point", a: 0, name: "", view: null, chans: null }, m.mark || {});
    const out = marks.concat([mk]).sort((x, y) => x.n - y.n);
    return { id, marks: out, info: { op: "markadd", a: mk.a, b: mk.b || mk.a, n: 0, ch: null, mk: { n: mk.n, name: mk.name, kind: mk.kind } } };
  }
  const old = marks.find(x => x.id === m.markId);
  if (!old) throw new Error("stale");
  if (m.op === "markdel") return { id: old.id, marks: marks.filter(x => x !== old), info: { op: "markdel", a: old.a, b: old.b || old.a, n: 0, ch: null, mk: { n: old.n, name: old.name, kind: old.kind } } };
  const patch = m.mark || {};
  const mk = shape(old, patch);
  if (Number.isInteger(patch.n) && patch.n !== old.n) { if (patch.n < 1 || patch.n > 999 || used.has(patch.n)) throw new Error("number"); mk.n = patch.n; }
  const what = mk.a !== old.a || mk.b !== old.b ? "move" : mk.name !== old.name ? "rename" : "change";
  return { id: old.id, marks: marks.map(x => x === old ? mk : x).sort((x, y) => x.n - y.n), info: { op: "markset", a: mk.a, b: mk.b || mk.a, n: 0, ch: null, mk: { n: mk.n, name: mk.name, kind: mk.kind, was: what === "rename" ? old.name : null, what } } };
}

function adjustSel(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const ch = c.meta.channels;
  const chans = Array.isArray(m.chans) && m.chans.length === ch && m.chans.some(Boolean) ? m.chans.map(Boolean) : new Array(ch).fill(true);
  let a = clampI(m.a, 0, c.len), b = clampI(m.b, 0, c.len);
  if (b <= a) throw new Error("nosel");
  const inward = m.mode === "in";
  const sa = snapZero(a, chans, 0, inward ? 1 : -1, 50), sb = snapZero(b, chans, sa.d, inward ? -1 : 1, 50);
  if (sb.p > sa.p) { a = sa.p; b = sb.p; }
  return { t: "adjusted", a, b };
}

function moveHist(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const from = c.idx;
  let to = m.t === "undo" ? from - 1 : m.t === "redo" ? from + 1 : clampI(m.idx, 0, c.hist.length - 1);
  to = clampI(to, 0, c.hist.length - 1);
  if (to === from) return statePayload(m.have, { t: "state", sel: null });
  c.idx = to;
  setLists(c.hist[to].lists);
  persist();
  const sel = to < from ? c.hist[to + 1].before : c.hist[to].after;
  return statePayload(m.have, { t: "state", sel });
}

function closeHandles(c) {
  for (const h of [c.pool, c.heap, c.hpk]) { if (h) { try { h.close(); } catch {} } }
}

async function closeCur() {
  stopPlay();
  const c = cur;
  if (!c) return;
  if (RP.job) RP.job.cancel = true;
  RP.scan = null;
  RP.listen = "off";
  if (FX.job) FX.job.cancel = true;
  FX.mode = "off";
  FX.pv = null;
  NR.auto = null;
  if (MDJ.job) MDJ.job.cancel = true;
  MDL.mode = "off";
  MDL.notes = [];
  if (c.saving) { try { await c.saving; } catch {} }
  if (clip && !clip.file && clip.doc === c.meta.id) { try { await materializeClip(); } catch { clip = null; } }
  if (c.busy > 0) lingering.set(c.meta.id, c); else closeHandles(c);
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
    const mod = await wasmMod();
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
      putAt(pool, new Uint8Array(block.buffer), slot * slotBytes);
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


async function openDoc(id, have) {
  const dir = await docsDir();
  const docDir = await dir.getDirectoryHandle(id);
  const meta = await readJson(docDir, "meta.json");
  if (meta.recording) throw new Error("recording");
  const slotPeaks = await readFloat(docDir, "peaks.f32");
  const bands = await readFloat(docDir, "bands.f32");
  if (cur && cur.meta.id === id) return { meta: cur.meta, peaks: timelinePeaks(slotPeaks, cur.meta.channels, cur.meta.slots), bands, state: statePayload(have || 1), recovered: false };
  await closeCur();
  if (lingering.has(id)) {
    cur = lingering.get(id);
    lingering.delete(id);
    cur.meta.opened = Date.now();
    return { meta: cur.meta, peaks: timelinePeaks(slotPeaks, cur.meta.channels, cur.meta.slots), bands, state: statePayload(have || 1), recovered: false };
  }
  await clipReady;
  const pool = await syncHandle(await docDir.getFileHandle("pool.f32"), true);
  let heap = null, hpk = null;
  try {
    heap = await exclusive(await docDir.getFileHandle("heap.f32", { create: true }));
    hpk = await exclusive(await docDir.getFileHandle("heap.pk", { create: true }));
  } catch (e) {
    for (const h of [pool, heap]) { if (h) { try { h.close(); } catch {} } }
    throw e;
  }
  const heapFrames = Math.floor(heap.getSize() / 4), pkFloats = Math.floor(hpk.getSize() / 4);
  const st = await loadEdits(docDir, meta, heapFrames, pkFloats);
  cur = { meta, pool, heap, hpk, dir: docDir, heapEnd: heapFrames, pkEnd: pkFloats, allocs: [null], sums: [null], hist: null, idx: 0, seq: 0, lists: null, cum: null, len: 0, edges: new Map(), ver: 0, saving: null, dirty: false, saveErr: null, busy: 0 };
  if (st.hist) {
    cur.allocs = st.allocs;
    cur.hist = st.hist;
    cur.idx = st.idx;
    cur.seq = st.seq;
    const all = new Float32Array(pkFloats);
    if (pkFloats) hpk.read(new Uint8Array(all.buffer), { at: 0 });
    for (let i = 1; i < st.allocs.length; i++) {
      const a = st.allocs[i], n0 = Math.ceil(a[1] / BUCKET);
      cur.sums[i] = { pk: all.slice(a[2], a[2] + n0 * 2), bd: all.slice(a[2] + n0 * 2, a[2] + n0 * 5) };
    }
  } else {
    const rm = Array.isArray(meta.marks) ? meta.marks.filter(a => Number.isFinite(a) && a >= 0 && a <= meta.frames).slice(0, 999) : [];
    cur.hist = [{ op: "open", a: 0, b: 0, n: 0, ch: null, t: meta.created || Date.now(), lists: origLists(meta), marks: rm.map((a, i) => ({ id: i + 1, n: i + 1, kind: "point", a: Math.round(a), name: "", view: null, chans: null })), d: null, full: false, before: null, after: null }];
  }
  setLists(cur.hist[cur.idx].lists);
  cur.io = makeIo();
  meta.opened = Date.now();
  meta.len = cur.len;
  try { await writeFile(docDir, "meta.json", enc(meta)); } catch {}
  return { meta, peaks: timelinePeaks(slotPeaks, meta.channels, meta.slots), bands, state: statePayload(have || 1), recovered: !!st.recovered };
}

async function listDocs() {
  const dir = await docsDir();
  const docs = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "directory") continue;
    if (cur && cur.meta.id === name) { docs.push(Object.assign({}, cur.meta, { len: cur.len })); continue; }
    try { const m = await readJson(h, "meta.json"); if (!m.recording) docs.push(m); } catch {}
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
    const lim = FX.mode !== "off" ? Math.min(R, Math.max(4 * CHUNK, Math.round(cur.meta.sampleRate * 0.5))) : R;
    const free = lim - (w - r);
    if (free < CHUNK) return;
    if (!play.loop && w >= len) return;
    let n = Math.min(CHUNK, free);
    if (!play.loop) n = Math.min(n, len - w);
    let done = 0;
    while (done < n) {
      const p = srcPos(w + done);
      const run = play.loop ? Math.min(n - done, play.end - p) : n - done;
      readClip(p, run, play.tmp, CHUNK);
      if (FX.mode !== "off") fxView(p, run, play.tmp, CHUNK);
      else if (RP.listen !== "off") rpOverlay(p, run, play.tmp, CHUNK);
      if (MDL.mode !== "off") mdSynth(p, run, play.tmp, CHUNK);
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
  const F = cur.len;
  start = Math.max(0, Math.min(Math.floor(start), F));
  end = Math.max(start, Math.min(Math.floor(end), F));
  if (end - start < 1) return;
  play = { start, end, loop: !!loop, off: loop ? Math.max(0, Math.min(end - start - 1, Math.floor(off || 0))) : 0, tmp: new Float32Array(CHUNK * cur.meta.channels) };
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

const XP = { jobs: [], running: null, dsp: null };
const SHAPES = { off: [], light: [1], strong: [2.033, -2.165, 1.959, -1.59, 0.6149] };

async function exportsDir() {
  return (await studioDir()).getDirectoryHandle("exports", { create: true });
}

const exportsReady = (async () => {
  try {
    const d = await exportsDir();
    const names = [];
    for await (const [n] of d.entries()) names.push(n);
    for (const n of names) { try { await d.removeEntry(n); } catch {} }
  } catch {}
})();

async function dspExports() {
  if (!XP.dsp) {
    const inst = await WebAssembly.instantiate(await wasmMod(), { env: { read_at: () => 0, byte_len: () => 0 } });
    XP.dsp = inst.exports;
  }
  return XP.dsp;
}

function dspError(x) {
  return new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.dec_error_ptr(), x.dec_error_len()));
}

function xorshift(seed) {
  let v = (seed >>> 0) || 0x9e3779b9;
  return () => { v ^= v << 13; v >>>= 0; v ^= v >>> 17; v ^= v << 5; v >>>= 0; return v / 4294967296; };
}

function tagList(v) {
  const out = [];
  for (const p of Array.isArray(v) ? v.slice(0, 64) : []) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const k = String(p[0]).toUpperCase().replace(/[^A-Z0-9 _]/g, "").trim().slice(0, 40), val = String(p[1]).replace(/\u0000/g, "").trim().slice(0, 1000);
    if (k && val) out.push([k, val]);
  }
  return out;
}

function picOf(p) {
  if (!p || !p.data) return null;
  const data = p.data instanceof ArrayBuffer ? new Uint8Array(p.data) : ArrayBuffer.isView(p.data) ? new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) : null;
  if (!data || !data.length || data.length > 4 << 20) return null;
  return { mime: /^image\/(jpeg|png)$/.test(p.mime) ? p.mime : "image/jpeg", w: Math.max(0, p.w | 0), h: Math.max(0, p.h | 0), data };
}

function flacMeta(tags, pic) {
  const enc = new TextEncoder(), blocks = [];
  if (tags.length) {
    const vendor = enc.encode("Delicate Studio"), items = tags.map(([k, v]) => enc.encode(k + "=" + v));
    const b = new Uint8Array(8 + vendor.length + items.reduce((s, x) => s + 4 + x.length, 0)), v = new DataView(b.buffer);
    let o = 0;
    v.setUint32(o, vendor.length, true); o += 4; b.set(vendor, o); o += vendor.length;
    v.setUint32(o, items.length, true); o += 4;
    for (const it of items) { v.setUint32(o, it.length, true); o += 4; b.set(it, o); o += it.length; }
    blocks.push([4, b]);
  }
  if (pic) {
    const mime = enc.encode(pic.mime), b = new Uint8Array(32 + mime.length + pic.data.length), v = new DataView(b.buffer);
    let o = 0;
    for (const n of [3, mime.length]) { v.setUint32(o, n); o += 4; }
    b.set(mime, o); o += mime.length;
    for (const n of [0, pic.w, pic.h, 24, 0, pic.data.length]) { v.setUint32(o, n); o += 4; }
    b.set(pic.data, o);
    blocks.push([6, b]);
  }
  const out = new Uint8Array(blocks.reduce((s, x) => s + 4 + x[1].length, 0));
  let o = 0;
  blocks.forEach(([type, b], i) => {
    out[o] = (i === blocks.length - 1 ? 0x80 : 0) | type;
    out[o + 1] = (b.length >> 16) & 255; out[o + 2] = (b.length >> 8) & 255; out[o + 3] = b.length & 255;
    out.set(b, o + 4);
    o += 4 + b.length;
  });
  return out;
}

function wavInfo(tags) {
  const map = { TITLE: "INAM", ARTIST: "IART", ALBUM: "IPRD", DATE: "ICRD", GENRE: "IGNR", TRACKNUMBER: "ITRK" }, got = {}, enc = new TextEncoder();
  for (const [k, v] of tags) { const id = map[k]; if (id) got[id] = got[id] ? got[id] + "; " + v : v; }
  if (!Object.keys(got).length) return new Uint8Array(0);
  got.ISFT = "Delicate Studio";
  const parts = Object.entries(got).map(([id, v]) => [id, enc.encode(v)]);
  const body = parts.reduce((s, [, d]) => s + 8 + d.length + 1 + ((d.length + 1) & 1), 4);
  const out = new Uint8Array(8 + body), dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, "LIST"); dv.setUint32(4, body, true); tag(8, "INFO");
  let o = 12;
  for (const [id, d] of parts) {
    tag(o, id); dv.setUint32(o + 4, d.length + 1, true);
    out.set(d, o + 8);
    o += 8 + d.length + 1 + ((d.length + 1) & 1);
  }
  return out;
}

function wavHeader(frames, ch, rate, bits, float, extra) {
  const bps = bits >> 3, align = ch * bps, data = frames * align, pad = data % 2;
  const ext = !float && ch > 2;
  const fmtLen = float ? 18 : ext ? 40 : 16, factLen = float ? 12 : 0;
  const size = 12 + 36 + 8 + fmtLen + factLen + 8;
  const riff = size - 8 + data + pad + (extra || 0), rf64 = riff > 0xFFFFFFFF;
  const b = new ArrayBuffer(size), v = new DataView(b);
  let o = 0;
  const tag = t => { for (let i = 0; i < 4; i++) v.setUint8(o++, t.charCodeAt(i)); };
  const u16 = n => { v.setUint16(o, n, true); o += 2; };
  const u32 = n => { v.setUint32(o, n, true); o += 4; };
  const u64 = n => { v.setUint32(o, n % 4294967296, true); v.setUint32(o + 4, Math.floor(n / 4294967296), true); o += 8; };
  tag(rf64 ? "RF64" : "RIFF"); u32(rf64 ? 0xFFFFFFFF : riff); tag("WAVE");
  if (rf64) { tag("ds64"); u32(28); u64(riff); u64(data); u64(frames); u32(0); }
  else { tag("JUNK"); u32(28); o += 28; }
  tag("fmt "); u32(fmtLen); u16(float ? 3 : ext ? 0xFFFE : 1); u16(ch); u32(rate); u32(rate * align); u16(align); u16(bits);
  if (float) u16(0);
  if (ext) { u16(22); u16(bits); u32(ch >= 32 ? 0xFFFFFFFF : (2 ** ch) - 1); for (const x of [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]) v.setUint8(o++, x); }
  if (float) { tag("fact"); u32(4); u32(frames > 0xFFFFFFFF ? 0xFFFFFFFF : frames); }
  tag("data"); u32(rf64 ? 0xFFFFFFFF : data);
  return { bytes: new Uint8Array(b), pad };
}

function xpost(job, extra) {
  postMessage(Object.assign({ t: "xjob", id: job.id, state: job.state, frac: job.frac || 0 }, extra || {}));
}

function releaseDoc(c) {
  c.busy--;
  if (c.busy <= 0 && lingering.get(c.meta.id) === c && cur !== c) { lingering.delete(c.meta.id); closeHandles(c); }
}

async function renderJob(job) {
  const c = job.c, ch = c.meta.channels, rateIn = c.meta.sampleRate, f = job.fmt;
  const rateOut = f.rate || rateIn, flac = f.type === "flac", float = !flac && f.bits === 32;
  const bits = float ? 32 : f.bits, total = job.b - job.a;
  const outFrames = rateOut === rateIn ? total : Math.ceil(total * rateOut / rateIn);
  const reader = (src, sc, fr, n, out, off) => readSrcOf(c, src, sc, fr, n, out, off);
  const cum = job.lists.map(cumOf);
  const gain = Math.pow(10, (Number(job.master.gain) || 0) / 20);
  const dith = !float && job.master.dither !== "off";
  let h = dith ? (SHAPES[job.master.shaping] || []) : [];
  if (job.master.shaping === "strong" && rateOut > 50000) h = SHAPES.light;
  const nh = h.length, err = Array.from({ length: ch }, () => new Float64Array(Math.max(1, nh))), head = new Int32Array(ch);
  const rnd = xorshift(Date.now() ^ job.seed);
  const scale = Math.pow(2, bits - 1), qmax = scale - 1, qmin = -scale;
  const x = await dspExports();
  await exportsReady;
  const dir = await exportsDir();
  const fh = await dir.getFileHandle(job.file, { create: true });
  const hd = await fh.createSyncAccessHandle();
  let fileOff = 0, peak = 0, clipped = 0, last = performance.now(), lastPost = 0, meta = null, info = null;
  const OB = 1 << 22, ob = new Uint8Array(OB), ob16 = new Int16Array(ob.buffer), ob32 = new Float32Array(ob.buffer);
  let o = 0;
  const flush = () => { if (o) { putAt(hd, ob.subarray(0, o), fileOff); fileOff += o; o = 0; } };
  const block = 4096;
  let fi = 0, flIn = null;
  const flFrame = () => {
    const n = x.fl_frame(fi);
    if (n < 0) throw new Error(dspError(x));
    if (o + n > OB) flush();
    ob.set(new Uint8Array(x.memory.buffer, x.fl_out(), n), o);
    o += n;
    fi = 0;
  };
  try {
    hd.truncate(0);
    if (flac) {
      if (x.fl_open(rateOut, ch, bits, block) !== 0) throw new Error(dspError(x));
      meta = flacMeta(job.tags, job.pic);
      const n = x.fl_header(meta.length ? 0 : 1);
      if (n < 0) throw new Error(dspError(x));
      putAt(hd, new Uint8Array(x.memory.buffer, x.fl_out(), n).slice(), 0);
      fileOff = n;
      if (meta.length) { putAt(hd, meta, fileOff); fileOff += meta.length; }
    } else {
      info = wavInfo(job.tags);
      const w = wavHeader(outFrames, ch, rateOut, bits, float, info.length);
      putAt(hd, w.bytes, 0);
      fileOff = w.bytes.length;
      job.pad = w.pad;
    }
    const push = (pl, stride, st, k) => {
      if (!flac && o + k * ch * 4 > OB) flush();
      if (flac && !flIn) flIn = new Int32Array(x.memory.buffer, x.fl_in(), block * ch);
      for (let i = st; i < st + k; i++) {
        for (let cc = 0; cc < ch; cc++) {
          const v = pl[cc * stride + i];
          const av = v < 0 ? -v : v;
          if (av > peak) peak = av;
          if (float) { ob32[o >> 2] = v; o += 4; continue; }
          let w = v * scale;
          if (nh) { const e = err[cc]; let p = head[cc]; for (let j = 0; j < nh; j++) { w -= h[j] * e[p]; p = p === 0 ? nh - 1 : p - 1; } }
          let qv = Math.floor(w + (dith ? rnd() - rnd() : 0) + 0.5);
          if (qv > qmax) { qv = qmax; clipped++; } else if (qv < qmin) { qv = qmin; clipped++; }
          if (nh) { let ev = qv - w; ev = ev > 4 ? 4 : ev < -4 ? -4 : ev; const p = head[cc] = head[cc] + 1 === nh ? 0 : head[cc] + 1; err[cc][p] = ev; }
          if (flac) { flIn[fi++] = qv; }
          else if (bits === 16) { ob16[o >> 1] = qv; o += 2; }
          else { ob[o] = qv & 255; ob[o + 1] = (qv >> 8) & 255; ob[o + 2] = (qv >> 16) & 255; o += 3; }
        }
        if (flac && fi === block * ch) { flFrame(); flIn = new Int32Array(x.memory.buffer, x.fl_in(), block * ch); }
      }
    };
    const tick = async done => {
      const now = performance.now();
      if (now - last < 24) return;
      job.frac = Math.min(1, done / Math.max(1, outFrames));
      if (now - lastPost > 150) { lastPost = now; xpost(job); }
      await new Promise(r => setTimeout(r, 0));
      last = performance.now();
      if (job.cancel) throw new Error("cancelled");
    };
    if (rateOut === rateIn) {
      const CH = 65536, buf = new Float32Array(CH * ch);
      for (let pos = 0; pos < total;) {
        const k = Math.min(CH, total - pos);
        for (let cc = 0; cc < ch; cc++) readList(job.lists[cc], cum[cc], job.a + pos, k, buf, cc * CH, reader);
        if (gain !== 1) for (let cc = 0; cc < ch; cc++) { const b0 = cc * CH; for (let i = 0; i < k; i++) buf[b0 + i] *= gain; }
        push(buf, CH, 0, k);
        pos += k;
        await tick(pos);
      }
    } else {
      if (x.rs_open(rateIn, rateOut, ch) !== 0) throw new Error(dspError(x));
      const need = x.rs_need(), sIn = x.rs_in_stride(), sOut = x.rs_out_stride();
      let skip = x.rs_delay(), pos = 0, emitted = 0, tmp = null;
      while (emitted < outFrames) {
        const take = Math.max(0, Math.min(need, total - pos));
        const inV = new Float32Array(x.memory.buffer, x.rs_in(), sIn * ch);
        for (let cc = 0; cc < ch; cc++) {
          if (take) readList(job.lists[cc], cum[cc], job.a + pos, take, inV, cc * sIn, reader);
          inV.fill(0, cc * sIn + take, cc * sIn + need);
          if (gain !== 1) for (let i = 0; i < take; i++) inV[cc * sIn + i] *= gain;
        }
        pos += take;
        const k = x.rs_process(need);
        if (k < 0) throw new Error(dspError(x));
        const outV = new Float32Array(x.memory.buffer, x.rs_out(), sOut * ch);
        let st = 0;
        if (skip) { st = Math.min(skip, k); skip -= st; }
        const m = Math.min(k - st, outFrames - emitted);
        if (m > 0) {
          if (!tmp || tmp.length < m * ch) tmp = new Float32Array(Math.max(m, need * 2) * ch);
          for (let cc = 0; cc < ch; cc++) tmp.set(outV.subarray(cc * sOut + st, cc * sOut + st + m), cc * m);
          flIn = null;
          push(tmp, m, 0, m);
          emitted += m;
        }
        await tick(emitted);
      }
      x.rs_close();
    }
    if (flac) {
      if (fi) flFrame();
      flush();
      const n = x.fl_header(meta.length ? 0 : 1);
      if (n < 0) throw new Error(dspError(x));
      putAt(hd, new Uint8Array(x.memory.buffer, x.fl_out(), n).slice(), 0);
      x.fl_close();
    } else {
      if (job.pad) { if (o + 1 > OB) flush(); ob[o++] = 0; }
      flush();
      if (info.length) { putAt(hd, info, fileOff); fileOff += info.length; }
    }
    hd.flush();
    let sha = null;
    if (job.dest.kind === "locker") {
      job.state = "hashing"; job.frac = 0; xpost(job);
      const CAP = 1 << 22, ptr = x.sha_open(CAP);
      for (let at = 0; at < fileOff;) {
        const n = Math.min(CAP, fileOff - at);
        hd.read(new Uint8Array(x.memory.buffer, ptr, n), { at });
        x.sha_update(n);
        at += n;
        job.frac = at / fileOff;
        await tick(0);
      }
      sha = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.sha_hex(), 64));
    }
    hd.close();
    return { size: fileOff, peak, clipped, frames: outFrames, rate: rateOut, sha };
  } catch (e) {
    try { hd.close(); } catch {}
    try { x.fl_close(); x.rs_close(); } catch {}
    try { await dir.removeEntry(job.file); } catch {}
    throw e;
  }
}

async function lockerUpload(job, res) {
  const dir = await exportsDir();
  const file = await (await dir.getFileHandle(job.file)).getFile();
  const folder = String(job.dest.folder || "").split("/").map(x => x.trim()).filter(x => x && x !== "." && x !== "..").join("/");
  const base = job.name.replace(/[\\/]/g, "-"), dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : "";
  let taken = new Set();
  try {
    const r = await fetch("/api/locker/files?prefix=" + encodeURIComponent((folder ? folder + "/" : "") + stem), { cache: "no-store" });
    if (r.ok) taken = new Set(((await r.json()).files || []).map(f => f.path));
  } catch {}
  let path = (folder ? folder + "/" : "") + base;
  for (let i = 2; taken.has(path); i++) path = (folder ? folder + "/" : "") + stem + " (" + i + ")" + ext;
  let r = await fetch("/api/locker/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, size: file.size, sha256: res.sha }) });
  if (r.status === 401) throw new Error("login");
  if (r.status === 402) { const q = await r.json().catch(() => ({})); throw Object.assign(new Error("locker-full"), { quota: q }); }
  if (!r.ok) throw new Error("locker " + r.status + " " + (await r.text()).slice(0, 120));
  const start = await r.json();
  if (start.duplicate) return { path: start.path, file: start.file || null, duplicate: true };
  let off = start.offset || 0;
  job.state = "uploading";
  const CHUNK = 16 << 20;
  while (off < file.size) {
    if (job.cancel) { fetch("/api/locker/upload/" + start.id, { method: "DELETE" }).catch(() => {}); throw new Error("cancelled"); }
    job.frac = off / file.size;
    xpost(job);
    r = await fetch("/api/locker/upload/" + start.id, { method: "PATCH", headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(off) }, body: file.slice(off, Math.min(file.size, off + CHUNK)) });
    if (r.status === 409) { off = (await r.json()).offset; continue; }
    if (r.status === 401) throw new Error("login");
    if (!r.ok) throw new Error("locker " + r.status);
    off = (await r.json()).offset;
  }
  job.state = "verifying"; job.frac = 1; xpost(job);
  r = await fetch("/api/locker/upload/" + start.id + "/finish", { method: "POST" });
  if (r.status === 402) throw new Error("locker-full");
  if (!r.ok) throw new Error("locker " + r.status + " " + (await r.text()).slice(0, 120));
  const j = await r.json();
  return { path: j.path, file: j.file || null, duplicate: false };
}

async function pumpExport() {
  if (XP.running) return;
  for (;;) {
    const job = XP.jobs.find(j => j.state === "queued");
    if (!job) break;
    XP.running = job;
    job.state = "rendering"; job.frac = 0; xpost(job);
    const t0 = performance.now();
    try {
      const res = await renderJob(job);
      let up = null;
      if (job.dest.kind === "locker") up = await lockerUpload(job, res);
      job.state = "done"; job.frac = 1;
      xpost(job, { size: res.size, peak: res.peak, clipped: res.clipped, frames: res.frames, rate: res.rate, sha: res.sha, file: job.file, locker: up, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      job.state = e.message === "cancelled" ? "cancelled" : "failed";
      xpost(job, { error: errText(e), quota: e.quota || null });
      if (job.dest.kind === "locker") { try { await (await exportsDir()).removeEntry(job.file); } catch {} }
    }
    releaseDoc(job.c);
    job.c = null;
    job.lists = null;
    XP.running = null;
  }
}

function queueExport(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const a = clampI(m.a, 0, c.len), b = clampI(m.b, 0, c.len);
  if (b <= a) throw new Error("nosel");
  const f = m.fmt || {};
  const type = f.type === "flac" ? "flac" : "wav";
  const bits = type === "flac" ? (f.bits === 16 ? 16 : 24) : [16, 24, 32].includes(f.bits) ? f.bits : 24;
  const rate = [0, 44100, 48000, 88200, 96000, 176400, 192000].includes(f.rate) ? f.rate : 0;
  const job = { id: m.jobId, c, lists: c.lists, a, b, name: String(m.name || "export"), fmt: { type, bits, rate }, master: m.master || {}, dest: m.dest || { kind: "download" }, tags: tagList(m.tags), pic: type === "flac" ? picOf(m.pic) : null, file: m.jobId + "." + type, state: "queued", frac: 0, seed: XP.jobs.length * 7919 };
  c.busy = (c.busy || 0) + 1;
  XP.jobs.push(job);
  xpost(job);
  pumpExport();
  return { t: "queued", id: job.id };
}

const RP = { scan: null, job: null, listen: "off" };
const RP_MAX = 50000;

function sliceFast(list, cum, a, b) {
  const out = [];
  let lo = 0, hi = list.length - 1, i = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cum[m] <= a) { i = m; lo = m + 1; } else hi = m - 1; }
  for (; i < list.length && cum[i] < b; i++) {
    const s = list[i], s0 = cum[i], s1 = s0 + s[3];
    const from = Math.max(a, s0), to = Math.min(b, s1);
    if (to > from) out.push([s[0], s[1], s[0] === SIL ? 0 : s[2] + (from - s0), to - from]);
  }
  return mergeList(out);
}

function sameRange(l1, c1, l2, c2, a, b) {
  if (l1 === l2) return true;
  const x = sliceFast(l1, c1, a, b), y = sliceFast(l2, c2, a, b);
  return x.length === y.length && x.every((s, i) => sameSeg(s, y[i]));
}

function rpValidate() {
  const sc = RP.scan, c = cur;
  if (!sc || !c || sc.docId !== c.meta.id) return 0;
  if (sc.checked === c.ver) return sc.stale;
  let stale = 0;
  for (const e of sc.events) {
    e.ok = !!e.data && e.rep.every(k => sameRange(sc.lists[k], sc.cums[k], c.lists[k], c.cum[k], Math.max(0, e.a - sc.p), e.b + sc.p));
    if (!e.ok) stale++;
  }
  sc.checked = c.ver;
  sc.stale = stale;
  return stale;
}

function rpSummary() {
  const sc = RP.scan;
  if (!sc || !cur || sc.docId !== cur.meta.id) return null;
  rpValidate();
  return { kind: sc.kind || "click", a: sc.a, b: sc.b, link: sc.link, sens: sc.sens, maxMs: sc.maxMs, tol: sc.tol, minRun: sc.minRun, verdict: sc.verdict, levels: sc.levels, peak: sc.peak, stale: sc.stale, capped: sc.capped, events: sc.events.map(e => ({ a: e.a, b: e.b, s: Math.round(e.s * 10) / 10, det: e.det, ok: e.ok, x: !e.data, long: !!e.long })) };
}

function rpGroups(evs, ctxOf, F) {
  const groups = [];
  let i = 0;
  while (i < evs.length) {
    let j = i, hi = evs[i].b + ctxOf(evs[i]);
    while (j + 1 < evs.length && evs[j + 1].a - ctxOf(evs[j + 1]) < hi) { j++; hi = Math.max(hi, evs[j].b + ctxOf(evs[j])); }
    groups.push({ lo: Math.max(0, evs[i].a - ctxOf(evs[i])), hi: Math.min(F, hi), evs: evs.slice(i, j + 1) });
    i = j + 1;
  }
  return groups;
}

function rpSolve(x, c, lists, cums, k, lo, hi, gaps, p, seed, clip) {
  const n = hi - lo, ptr = x.rp_buf(n);
  const buf = new Float32Array(n);
  readList(lists[k], cums[k], lo, n, buf, 0, (src, ch, f, m, out, off) => readSrcOf(c, src, ch, f, m, out, off));
  new Float32Array(x.memory.buffer, ptr, n).set(buf);
  const mask = new Uint8Array(x.memory.buffer, x.rp_mask(), n);
  mask.fill(0);
  for (const [ga, gb] of gaps) mask.fill(1, ga - lo, gb - lo);
  if ((clip ? x.cl_fill(n, p) : x.rp_fill(n, p, seed)) !== 0) return null;
  const at = x.rp_buf(n);
  return new Float32Array(x.memory.buffer, at, n).slice();
}

async function rpScanClip(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  if (RP.job) RP.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  RP.job = job;
  const x = await dspExports();
  const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len;
  const lists = c.lists, cums = lists.map(cumOf);
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  const tol = Math.max(0.05, Math.min(10, Number(m.tol) || 1)) / 100, minRun = clampI(m.minRun || 2, 1, 32);
  const maxRun = Math.round(sr * 0.02), B = 65536, pad = maxRun + 1;
  const total = Math.max(1, (b - a) * ch);
  const tick = async (done, phase) => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "dprog", id: job.id, frac: Math.min(1, [0, 0.3, 0.75][phase] + [0.3, 0.45, 0.25][phase] * done) }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  const rd = (src, cc, f, mm, out, off) => readSrcOf(c, src, cc, f, mm, out, off);
  const buf = new Float32Array(B + pad + 1);
  const top = new Array(ch).fill(0), bot = new Array(ch).fill(0);
  let done = 0;
  for (let k = 0; k < ch; k++) {
    for (let s0 = a; s0 < b; s0 += B) {
      const n = Math.min(B, b - s0);
      readList(lists[k], cums[k], s0, n, buf, 0, rd);
      let hi = top[k], lo = bot[k];
      for (let i = 0; i < n; i++) { const v = buf[i]; if (v > hi) hi = v; else if (-v > lo) lo = -v; }
      top[k] = hi;
      bot[k] = lo;
      done += n;
      await tick(done / total, 0);
    }
  }
  const runs = Array.from({ length: ch }, () => []);
  let ntop = 0, nbel = 0, eq = 0, count = 0, capped = false;
  done = 0;
  for (let k = 0; k < ch && !capped; k++) {
    const t1 = top[k] * (1 - tol), t4 = top[k] * (1 - 4 * tol), b1 = bot[k] * (1 - tol), b4 = bot[k] * (1 - 4 * tol);
    for (let s0 = a; s0 < b; s0 += B) {
      const from = Math.max(a, s0 - 1), to = Math.min(b, s0 + B + pad), n = to - from;
      readList(lists[k], cums[k], from, n, buf, 0, rd);
      const own0 = s0 - from, own1 = Math.min(B, b - s0) + own0;
      for (let i = own0; i < own1; i++) {
        const v = buf[i];
        if (v >= t1 || -v >= b1) { ntop++; if (v === top[k] || -v === bot[k]) eq++; }
        else if (v >= t4 || -v >= b4) nbel++;
      }
      wasmF32(x, x.rp_buf(n), n).set(buf.subarray(0, n));
      const cnt = x.cl_runs(n, top[k], bot[k], tol, minRun);
      if (cnt < 0) throw new Error(dspError(x));
      const out = wasmF32(x, x.dc_out(), cnt * 4);
      for (let i = 0; i < cnt; i++) {
        const st = out[i * 4], en = out[i * 4 + 1];
        if (st < own0 || st >= own1 || (st === 0 && from < s0)) continue;
        runs[k].push({ a: from + st, b: from + en });
        count++;
      }
      if (count > RP_MAX) { capped = true; break; }
      done += Math.min(B, b - s0);
      await tick(done / total, 1);
    }
  }
  const verdict = count >= 3 && (eq - 2 * ch >= 6 || ntop >= 2 * nbel && count >= 6);
  let events = [];
  if (verdict) {
    runs.forEach((l, k) => l.forEach(r => { const det = new Array(ch).fill(false); det[k] = true; events.push({ a: r.a, b: r.b, s: 0, det, rep: [k], long: r.b - r.a > maxRun }); }));
    events.sort((p, q) => p.a - q.a || p.rep[0] - q.rep[0]);
    if (events.length > RP_MAX) { events = events.slice(0, RP_MAX); capped = true; }
  }
  const p = x.cl_order(sr);
  const ctxOf = e => x.rp_context(p, e.b - e.a, 0);
  let solved = 0, peak = 0;
  for (let k = 0; k < ch; k++) {
    const mine = events.filter(e => e.rep[0] === k && !e.long);
    const lvl = Math.max(top[k], bot[k]) || 1;
    for (const g of rpGroups(mine, ctxOf, F)) {
      const lo = Math.max(0, Math.min(g.lo, g.evs[0].a - p)), hi = Math.min(F, Math.max(g.hi, g.evs[g.evs.length - 1].b + p));
      const okEdge = g.evs[0].a - lo >= p && hi - g.evs[g.evs.length - 1].b >= p;
      const y = okEdge ? rpSolve(x, c, lists, cums, k, lo, hi, g.evs.map(e => [e.a, e.b]), p, 0, true) : null;
      for (const e of g.evs) {
        if (!y) { e.bad = true; continue; }
        e.data = new Array(ch).fill(null);
        e.data[k] = y.slice(e.a - lo, e.b - lo);
        let mx = 0;
        for (const v of e.data[k]) mx = Math.max(mx, Math.abs(v));
        e.s = 20 * Math.log10(Math.max(1e-9, mx / lvl));
        peak = Math.max(peak, mx);
      }
      solved += g.evs.length;
      await tick(solved / Math.max(1, events.length), 2);
    }
  }
  for (const e of events) if (e.bad || e.long || !e.data || !e.data[e.rep[0]]) e.data = null;
  if (RP.job === job) RP.job = null;
  const maxLen = events.reduce((v, e) => Math.max(v, e.b - e.a), 1);
  const db = v => v > 0 ? Math.round(20 * Math.log10(v) * 100) / 100 : -120;
  RP.scan = { kind: "clip", docId: c.meta.id, lists, cums, events, link: false, tol: tol * 100, minRun, a, b, p, capped, maxLen, checked: -1, stale: 0, verdict, levels: { top: top.map(db), bot: bot.map(db) }, peak: db(peak) };
  return { t: "dresult", id: job.id, diag: rpSummary() };
}

async function rpScan(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  if (RP.job) RP.job.cancel = true;
  const job = { id: m.jobId, cancel: false };
  RP.job = job;
  const x = await dspExports();
  const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len;
  const lists = c.lists, cums = lists.map(cumOf);
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  const sens = Math.max(0, Math.min(100, Number(m.sens) || 50)), maxMs = Math.max(0.2, Math.min(20, Number(m.maxMs) || 5));
  const link = ch === 1 || m.link !== false;
  const M = sr <= 50000 ? 2048 : sr <= 100000 ? 4096 : 8192, B = 65536;
  const total = Math.max(1, (b - a) * ch);
  const tick = async (done, phase) => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "dprog", id: job.id, frac: phase * 0.8 + (phase ? 0.2 : 0.8) * done }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  job.last = 0;
  const found = Array.from({ length: ch }, () => []);
  let done = 0, count = 0, capped = false;
  const buf = new Float32Array(B + 2 * M);
  for (let k = 0; k < ch && !capped; k++) {
    for (let s0 = a; s0 < b; s0 += B) {
      const lo = Math.max(0, s0 - M), hi = Math.min(F, s0 + B + M), n = hi - lo;
      readList(lists[k], cums[k], lo, n, buf, 0, (src, cc, f, mm, out, off) => readSrcOf(c, src, cc, f, mm, out, off));
      const ptr = x.rp_buf(n);
      new Float32Array(x.memory.buffer, ptr, n).set(buf.subarray(0, n));
      const cnt = x.dc_scan(n, sr, sens, maxMs);
      if (cnt < 0) throw new Error(dspError(x));
      const out = new Float32Array(x.memory.buffer, x.dc_out(), cnt * 4);
      for (let i = 0; i < cnt; i++) {
        const st = lo + out[i * 4], en = lo + out[i * 4 + 1];
        if (st >= s0 && st < Math.min(s0 + B, b) && en <= b) { found[k].push({ a: st, b: en, s: out[i * 4 + 2] }); count++; }
      }
      if (count > RP_MAX) { capped = true; break; }
      done += Math.min(B, b - s0);
      await tick(done / total, 0);
    }
  }
  let events = [];
  if (link) {
    const all = [];
    found.forEach((l, k) => l.forEach(e => all.push(Object.assign({ k }, e))));
    all.sort((p, q) => p.a - q.a);
    const near = Math.max(2, Math.round(sr / 11025));
    for (const e of all) {
      const last = events[events.length - 1];
      if (last && e.a <= last.b + near) { last.b = Math.max(last.b, e.b); last.s = Math.max(last.s, e.s); last.det[e.k] = true; }
      else { const det = new Array(ch).fill(false); det[e.k] = true; events.push({ a: e.a, b: e.b, s: e.s, det }); }
    }
    for (const e of events) e.rep = Array.from({ length: ch }, (_, k) => k);
  } else {
    found.forEach((l, k) => l.forEach(e => { const det = new Array(ch).fill(false); det[k] = true; events.push({ a: e.a, b: e.b, s: e.s, det, rep: [k] }); }));
    events.sort((p, q) => p.a - q.a || p.rep[0] - q.rep[0]);
  }
  if (events.length > RP_MAX) { events = events.slice(0, RP_MAX); capped = true; }
  const p = x.rp_order(sr, 0, 0);
  const ctxOf = e => x.rp_context(p, e.b - e.a, 0);
  let solved = 0;
  for (let k = 0; k < ch; k++) {
    const mine = events.filter(e => e.rep.includes(k));
    for (const g of rpGroups(mine, ctxOf, F)) {
      const lo = Math.max(0, Math.min(g.lo, g.evs[0].a - p)), hi = Math.min(F, Math.max(g.hi, g.evs[g.evs.length - 1].b + p));
      const okEdge = g.evs[0].a - lo >= p && hi - g.evs[g.evs.length - 1].b >= p;
      const y = okEdge ? rpSolve(x, c, lists, cums, k, lo, hi, g.evs.map(e => [e.a, e.b]), p, 0) : null;
      for (const e of g.evs) {
        if (!e.data) e.data = new Array(ch).fill(null);
        if (y) e.data[k] = y.slice(e.a - lo, e.b - lo);
        else e.bad = true;
      }
      solved += g.evs.length;
      await tick(solved / Math.max(1, events.length * (link ? ch : 1)), 1);
    }
  }
  for (const e of events) if (e.bad || !e.data || e.rep.some(k => !e.data[k])) e.data = null;
  if (RP.job === job) RP.job = null;
  const maxLen = events.reduce((v, e) => Math.max(v, e.b - e.a), 1);
  RP.scan = { docId: c.meta.id, lists, cums, events, link, sens, maxMs, a, b, p, capped, maxLen, checked: -1, stale: 0 };
  return { t: "dresult", id: job.id, diag: rpSummary() };
}

function rpRepair(m) {
  const c = cur, sc = RP.scan;
  if (!c || c.meta.id !== m.id || !sc || sc.docId !== c.meta.id) throw new Error("stale");
  rpValidate();
  const pick = Array.isArray(m.idx) ? new Set(m.idx) : null;
  const chosen = sc.events.filter((e, i) => (!pick || pick.has(i)) && e.ok && e.data);
  if (!chosen.length) throw new Error("nothing");
  const ch = c.meta.channels;
  const w = allocBegin();
  const raw = Array.from({ length: ch }, () => []);
  for (const e of chosen) for (const k of e.rep) { raw[k].push([e.a, e.b, w.n]); allocPush(w, e.data[k], e.b - e.a); }
  const id = allocEnd(w);
  const spans = raw.map(l => l.length ? l.map(([a, b, off]) => [a, b, [[id, 0, off, b - a]]]) : null);
  const lists = opPatch(c.lists, spans);
  const before = { a: clampI(m.sel && m.sel.a, 0, c.len), b: clampI(m.sel && m.sel.b, 0, c.len), cursor: clampI(m.cursor, 0, c.len) };
  pushHist({ op: sc.kind === "clip" ? "declip" : "repair", a: chosen[0].a, b: chosen[chosen.length - 1].b, n: chosen.length, ch: null }, lists, before, before);
  persist();
  const gone = new Set(chosen);
  sc.events = sc.events.filter(e => !gone.has(e));
  sc.checked = -1;
  return statePayload(m.have, { t: "state", sel: null, diag: rpSummary() });
}

function rpOverlay(p0, run, tmp, stride) {
  const sc = RP.scan, c = cur;
  if (!sc || !c || sc.docId !== c.meta.id || RP.listen === "off") return;
  rpValidate();
  const ev = sc.events, removed = RP.listen === "removed", ch = c.meta.channels, from = p0 - sc.maxLen;
  let lo = 0, hi = ev.length - 1, i = ev.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ev[mid].a > from) { i = mid; hi = mid - 1; } else lo = mid + 1; }
  if (removed) {
    const keep = [];
    for (let j = i; j < ev.length && ev[j].a < p0 + run; j++) keep.push(ev[j]);
    const diff = new Float32Array(run * ch);
    for (const e of keep) {
      if (!e.ok) continue;
      for (const k of e.rep) {
        const d = e.data[k], s = Math.max(p0, e.a), t = Math.min(p0 + run, e.b);
        for (let q = s; q < t; q++) diff[k * run + q - p0] += tmp[k * stride + q - p0] - d[q - e.a];
      }
    }
    for (let k = 0; k < ch; k++) for (let q = 0; q < run; q++) tmp[k * stride + q] = diff[k * run + q];
    return;
  }
  for (let j = i; j < ev.length && ev[j].a < p0 + run; j++) {
    const e = ev[j];
    if (!e.ok) continue;
    for (const k of e.rep) {
      const d = e.data[k], s = Math.max(p0, e.a), t = Math.min(p0 + run, e.b);
      for (let q = s; q < t; q++) tmp[k * stride + q - p0] = d[q - e.a];
    }
  }
}

async function healSel(c, a, b, chans) {
  const sr = c.meta.sampleRate, F = c.len, m = b - a;
  if (m > Math.round(sr * SH_TIME)) throw new Error("heal-long");
  if (m > Math.round(sr * 0.1)) return shTime(c, a, b, chans);
  const x = await dspExports();
  const p = x.rp_order(sr, m, 1);
  const ctx = Math.min(x.rp_context(p, m, 1), sr);
  const lo = Math.max(0, a - ctx), hi = Math.min(F, b + ctx);
  if (a - lo < p || hi - b < p) throw new Error("heal-edge");
  const w = allocBegin();
  const spans = new Array(c.meta.channels).fill(null);
  for (let k = 0; k < chans.length; k++) {
    if (!chans[k]) continue;
    const seed = m > sr * 0.0015 ? ((a * 2654435761 + k * 40503) >>> 0) || 1 : 0;
    const y = rpSolve(x, c, c.lists, c.cum, k, lo, hi, [[a, b]], p, seed);
    if (!y) throw new Error("heal-failed");
    const off = w.n;
    allocPush(w, y.subarray(a - lo, b - lo), m);
    spans[k] = off;
  }
  const id = allocEnd(w);
  return opPatch(c.lists, spans.map(off => off === null ? null : [[a, b, [[id, 0, off, m]]]]));
}

const SH_TIME = 4, SH_LIMIT = 60, SH_SHORT = 0.12, SH_SENS = 60;

function shN(sr, un) {
  const auto = sr <= 50000 ? 2048 : sr <= 100000 ? 4096 : 8192;
  const v = Number(un);
  return Math.max(1024, Math.min(8192, v > 0 && (v & (v - 1)) === 0 ? v : auto));
}

function shU(f, un, sr, log) {
  const nyq = sr / 2;
  if (!log) return f / nyq;
  const lo = Math.max(20, sr / un);
  return Math.log(Math.max(f, 1e-9) / lo) / Math.log(nyq / lo);
}

function shF(u, un, sr, log) {
  const nyq = sr / 2;
  if (u <= 0.001) return 0;
  if (u >= 0.999) return nyq;
  if (!log) return nyq * u;
  const lo = Math.max(20, sr / un);
  return lo * Math.pow(nyq / lo, u);
}

function shShapes(raw, ch, F, un, sr, log) {
  const out = [], num = v => Number.isFinite(Number(v)) ? Number(v) : NaN;
  for (const s of Array.isArray(raw) ? raw.slice(0, 64) : []) {
    if (!s || typeof s !== "object") continue;
    const chs = Array.isArray(s.ch) && s.ch.length === ch ? s.ch.map(Boolean) : new Array(ch).fill(true);
    if (!chs.some(Boolean)) continue;
    if (s.kind === "rect") {
      const a = num(s.a), b = num(s.b), f0 = num(s.f0), f1 = num(s.f1);
      if (![a, b, f0, f1].every(Number.isFinite)) continue;
      out.push({ kind: "rect", a: Math.max(0, Math.min(a, b)), b: Math.min(F, Math.max(a, b)), f0: Math.max(0, Math.min(f0, f1)), f1: Math.min(sr / 2, Math.max(f0, f1)), ch: chs });
      continue;
    }
    if (s.kind !== "poly" && s.kind !== "brush") continue;
    const pts = (Array.isArray(s.pts) ? s.pts.slice(0, 8000) : []).map(q => Array.isArray(q) ? [num(q[0]), num(q[1])] : [NaN, NaN]).filter(q => q.every(Number.isFinite)).map(([t, f]) => [Math.max(-F, Math.min(2 * F, t)), Math.max(0, Math.min(1, shU(Math.max(0, f), un, sr, log)))]);
    if (!pts.length || (s.kind === "poly" && pts.length < 3)) continue;
    if (s.kind === "poly") { out.push({ kind: "poly", pts, ch: chs }); continue; }
    const rx = Math.max(1, num(s.rx) || 0), ru = Math.max(0.001, Math.min(0.5, num(s.ru) || 0));
    out.push({ kind: "brush", pts, rx, ru, ch: chs });
  }
  return out;
}

function shSpan(s) {
  if (s.kind === "rect") return [s.a, s.b];
  let a = Infinity, b = -Infinity;
  for (const p of s.pts) { a = Math.min(a, p[0]); b = Math.max(b, p[0]); }
  return s.kind === "brush" ? [a - s.rx, b + s.rx] : [a, b];
}

function shCross(pts, x) {
  const ys = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    if ((p[0] <= x && q[0] > x) || (q[0] <= x && p[0] > x)) ys.push(p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]));
  }
  return ys.sort((u, v) => u - v);
}

function shRaster(shapes, k, n, H, sr, un, log) {
  const bins = n / 2 + 1, bw = sr / n, rows = new Map();
  const addHz = (J, f0, f1) => {
    if (J < 0) return;
    if (f1 < f0) [f0, f1] = [f1, f0];
    let k0 = Math.max(0, Math.ceil(f0 / bw - 0.5)), k1 = Math.min(bins - 1, Math.floor(f1 / bw + 0.5));
    if (k1 < k0) k0 = k1 = Math.min(bins - 1, Math.max(0, Math.round((f0 + f1) / 2 / bw)));
    let l = rows.get(J);
    if (!l) rows.set(J, l = []);
    l.push([k0, k1]);
  };
  const addU = (J, u0, u1) => addHz(J, shF(Math.max(0, Math.min(u0, u1)), un, sr, log), shF(Math.min(1, Math.max(u0, u1)), un, sr, log));
  for (const s of shapes) {
    if (!s.ch[k]) continue;
    if (s.kind === "rect") {
      for (let J = Math.ceil((s.a - H / 2) / H); J <= Math.floor((s.b + H / 2) / H); J++) addHz(J, s.f0, s.f1);
      continue;
    }
    if (s.kind === "poly") {
      const [x0, x1] = shSpan(s);
      for (let J = Math.ceil((x0 - H / 2) / H); J <= Math.floor((x1 + H / 2) / H); J++) {
        const t = J * H;
        for (const xl of [t - H / 2, t, t + H / 2]) {
          if (xl < x0 || xl > x1) continue;
          const ys = shCross(s.pts, xl);
          for (let i = 0; i + 1 < ys.length; i += 2) addU(J, ys[i], ys[i + 1]);
        }
        let lo = Infinity, hi = -Infinity;
        for (const p of s.pts) if (p[0] >= t - H / 2 && p[0] <= t + H / 2) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
        if (hi >= lo) addU(J, lo, hi);
      }
      continue;
    }
    const dabs = [s.pts[0]];
    for (let i = 1; i < s.pts.length; i++) {
      const p = s.pts[i - 1], q = s.pts[i], d = Math.hypot((q[0] - p[0]) / s.rx, (q[1] - p[1]) / s.ru), m = Math.max(1, Math.ceil(d * 3));
      for (let j = 1; j <= m; j++) dabs.push([p[0] + (q[0] - p[0]) * j / m, p[1] + (q[1] - p[1]) * j / m]);
    }
    for (const p of dabs) {
      for (let J = Math.ceil((p[0] - s.rx - H / 2) / H); J <= Math.floor((p[0] + s.rx + H / 2) / H); J++) {
        const dt = Math.max(0, Math.abs(J * H - p[0]) - H / 2);
        if (dt > s.rx) continue;
        const hh = s.ru * Math.sqrt(1 - (dt / s.rx) ** 2);
        addU(J, p[1] - hh, p[1] + hh);
      }
    }
  }
  for (const [J, l] of rows) {
    l.sort((p, q) => p[0] - q[0]);
    const m = [l[0].slice()];
    for (let i = 1; i < l.length; i++) { const last = m[m.length - 1]; if (l[i][0] <= last[1] + 1) last[1] = Math.max(last[1], l[i][1]); else m.push(l[i].slice()); }
    rows.set(J, m);
  }
  return rows;
}

function shRegion(x, c, k, J0, J1, rowsOf, mode, gain, seed, n) {
  const H = x.sh_hop(), C = x.sh_context() + 1, bins = n / 2 + 1;
  const fa = J0 - C, frames = J1 - J0 + 1 + 2 * C, s0 = fa * H - n / 2, len = (frames - 1) * H + n;
  const buf = new Float32Array(len);
  readList(c.lists[k], c.cum[k], s0, len, buf, 0, (src, cc, f, m, out, off) => readSrcOf(c, src, cc, f, m, out, off));
  wasmF32(x, x.sh_buf(len), len).set(buf);
  const mp = x.sh_mask(frames);
  const mask = new Uint8Array(x.memory.buffer, mp, frames * bins);
  let any = false;
  for (let J = J0; J <= J1; J++) {
    const l = rowsOf(J);
    if (!l) continue;
    const base = (J - fa) * bins;
    for (const [k0, k1] of l) { mask.fill(1, base + k0, base + k1 + 1); any = true; }
  }
  if (!any) return null;
  const r = x.sh_run(frames, mode, gain, seed >>> 0 || 1);
  if (r < 0) throw new Error(dspError(x));
  if (r !== 0) return null;
  const sp = x.sh_span();
  const span = new Uint32Array(x.memory.buffer, sp, 2), a = span[0], b = span[1];
  const A = Math.max(0, s0 + a), B = Math.min(c.len, s0 + b);
  if (B <= A) return null;
  const op = x.sh_out();
  return { a: A, b: B, data: new Float32Array(x.memory.buffer, op, len).slice(A - s0, B - s0) };
}

function shGroup(x, c, k, J0, J1, rowsOf, mode, gain, seed, n) {
  const H = x.sh_hop(), most = Math.max(64, Math.floor(6 * c.meta.sampleRate / H));
  if (J1 - J0 + 1 <= most) return shRegion(x, c, k, J0, J1, rowsOf, mode, gain, seed, n);
  const parts = [];
  for (let j = J0; j <= J1; j += most) { const r = shRegion(x, c, k, j, Math.min(J1, j + most - 1), rowsOf, mode, gain, seed + j, n); if (r) parts.push(r); }
  if (!parts.length) return null;
  const A = Math.min(...parts.map(p => p.a)), B = Math.max(...parts.map(p => p.b));
  const orig = new Float32Array(B - A), data = new Float32Array(B - A);
  readList(c.lists[k], c.cum[k], A, B - A, orig, 0, (src, cc, f, m, out, off) => readSrcOf(c, src, cc, f, m, out, off));
  data.set(orig);
  for (const p of parts) for (let i = 0; i < p.data.length; i++) data[p.a - A + i] += p.data[i] - orig[p.a - A + i];
  return { a: A, b: B, data };
}

function shClicks(x, c, k, t0, t1) {
  const sr = c.meta.sampleRate, F = c.len, M = sr <= 50000 ? 2048 : sr <= 100000 ? 4096 : 8192;
  const lo = Math.max(0, Math.floor(t0) - M), hi = Math.min(F, Math.ceil(t1) + M), n = hi - lo;
  if (n <= 0) return null;
  const buf = new Float32Array(n);
  readList(c.lists[k], c.cum[k], lo, n, buf, 0, (src, cc, f, m, out, off) => readSrcOf(c, src, cc, f, m, out, off));
  wasmF32(x, x.rp_buf(n), n).set(buf);
  const cnt = x.dc_scan(n, sr, SH_SENS, 20);
  if (cnt <= 0) return null;
  const out = wasmF32(x, x.dc_out(), cnt * 4), hits = [];
  for (let i = 0; i < cnt; i++) {
    const a = lo + out[i * 4], b = lo + out[i * 4 + 1];
    if (b > t0 && a < t1) { const last = hits[hits.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else hits.push([a, b]); }
  }
  if (!hits.length) return null;
  const p = x.rp_order(sr, 0, 0), ctx = x.rp_context(p, hits.reduce((v, h) => Math.max(v, h[1] - h[0]), 1), 0);
  const ra = Math.max(0, hits[0][0] - ctx), rb = Math.min(F, hits[hits.length - 1][1] + ctx);
  if (hits[0][0] - ra < p || rb - hits[hits.length - 1][1] < p) return null;
  const y = rpSolve(x, c, c.lists, c.cum, k, ra, rb, hits, p, 0);
  if (!y) return null;
  return hits.map(([a, b]) => ({ a, b, data: y.slice(a - ra, b - ra) }));
}

function shPatch(c, parts) {
  const ch = c.meta.channels, w = allocBegin(), spans = Array.from({ length: ch }, () => []);
  for (let k = 0; k < ch; k++) for (const p of parts[k]) { spans[k].push([p.a, p.b, w.n]); allocPush(w, p.data, p.data.length); }
  const id = allocEnd(w);
  return opPatch(c.lists, spans.map(l => l.length ? l.sort((p, q) => p[0] - q[0]).map(([a, b, off]) => [a, b, [[id, 0, off, b - a]]]) : null));
}

async function shTime(c, a, b, chans) {
  const x = await dspExports(), sr = c.meta.sampleRate, n = shN(sr, 0);
  if (x.sh_open(n) !== 0) throw new Error(dspError(x));
  const H = x.sh_hop(), all = [[0, n / 2]];
  const J0 = Math.ceil((a - n / 4) / H), J1 = Math.floor((b + n / 4) / H);
  const parts = chans.map((on, k) => {
    if (!on) return [];
    const r = shGroup(x, c, k, Math.max(0, J0), J1, () => all, 1, 1, ((a * 2654435761 + k * 40503) >>> 0) || 1, n);
    return r ? [r] : [];
  });
  if (!parts.some(l => l.length)) throw new Error("heal-failed");
  return shPatch(c, parts);
}

async function shApply(c, m) {
  const x = await dspExports(), sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len;
  const un = shN(sr, m.un), log = m.log !== false, n = un;
  if (x.sh_open(n) !== 0) throw new Error(dspError(x));
  const H = x.sh_hop(), C = x.sh_context() + 1;
  const shapes = shShapes(m.shapes, ch, F, Number(m.un) || n, sr, log);
  if (!shapes.length) throw new Error("nothing");
  let t0 = Infinity, t1 = -Infinity;
  for (const s of shapes) { const [p, q] = shSpan(s); t0 = Math.min(t0, p); t1 = Math.max(t1, q); }
  if (t1 - t0 > SH_LIMIT * sr) throw new Error("spec-long");
  const del = m.op === "spdel", parts = Array.from({ length: ch }, () => []);
  let clicks = 0, A = Infinity, B = -Infinity;
  for (let k = 0; k < ch; k++) {
    const rows = shRaster(shapes, k, n, H, sr, Number(m.un) || n, log);
    if (!rows.size) continue;
    const Js = [...rows.keys()].sort((p, q) => p - q), groups = [];
    for (const J of Js) { const g = groups[groups.length - 1]; if (g && J - g.J1 <= 2 * C + 2) g.J1 = J; else groups.push({ J0: J, J1: J }); }
    for (const g of groups) {
      let got = null;
      if (!del && (g.J1 - g.J0 + 1) * H <= SH_SHORT * sr) {
        got = shClicks(x, c, k, g.J0 * H - H / 2, g.J1 * H + H / 2);
        if (got) clicks += got.length;
      }
      if (!got) { const r = shGroup(x, c, k, g.J0, g.J1, J => rows.get(J), del ? 2 : 0, del ? 0 : 1, ((g.J0 * 2654435761 + k * 40503) >>> 0) || 1, n); got = r ? [r] : []; }
      for (const p of got) { parts[k].push(p); A = Math.min(A, p.a); B = Math.max(B, p.b); }
    }
  }
  if (!parts.some(l => l.length)) throw new Error(del ? "nothing" : "spot-nothing");
  const touched = parts.map(l => l.length > 0);
  return { lists: shPatch(c, parts), a: Math.round(A), b: Math.round(B), clicks, ch: touched.every(Boolean) ? null : chanLabel(touched) };
}

function wasmF32(x, ptr, n) { return new Float32Array(x.memory.buffer, ptr, n); }

const NR = { print: null, loaded: null, stats: null, auto: null };
const FX = { mode: "off", kind: "nr", raw: null, pv: null, job: null, graph: 0 };
const NR_MAX = 20;
const NR_FEED = 8192;

function nrFft(n, sr) {
  const v = Number(n) || 0;
  if (v >= 1024 && v <= 32768 && (v & (v - 1)) === 0) return v;
  return sr <= 50000 ? 4096 : sr <= 100000 ? 8192 : 16384;
}

function nrCfg(m, sr) {
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const o = m && typeof m === "object" ? m : {};
  const curve = Array.isArray(o.curve) ? o.curve.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)).slice(0, 64) : [];
  return { n: nrFft(o.n, sr), k: Math.round(num(o.k, 3, 16, 7)), floor: num(o.floor, 0, 40, 12), amount: num(o.amount, 0, 100, 100) / 100, thr: num(o.thr, -10, 10, 0), decay: num(o.decay, 0, 100, 50) / 100, link: o.link !== false, curve, auto: o.profile === "auto" };
}

function nrCurveBins(pts, bins, sr, n) {
  const out = new Float32Array(bins).fill(1);
  const p = pts.map(([f, v]) => [Math.log(Math.max(1, f)), Math.max(0, Math.min(100, v)) / 100]).sort((x, y) => x[0] - y[0]);
  if (!p.length) return out;
  let j = 0;
  for (let b = 0; b < bins; b++) {
    const lf = Math.log(Math.max(1, b * sr / n));
    while (j < p.length - 1 && p[j + 1][0] <= lf) j++;
    if (lf <= p[0][0]) out[b] = p[0][1];
    else if (j >= p.length - 1) out[b] = p[p.length - 1][1];
    else { const t = (lf - p[j][0]) / Math.max(1e-9, p[j + 1][0] - p[j][0]); out[b] = p[j][1] + t * (p[j + 1][1] - p[j][1]); }
  }
  return out;
}

function nrLoadPrint() {
  if (!NR.loaded) NR.loaded = (async () => {
    try {
      const dir = await studioDir();
      const meta = await readJson(dir, "noiseprint.json");
      if (!meta || !(meta.ch >= 1 && meta.ch <= 8) || !(meta.len > 0) || !(meta.sr > 0)) return;
      const buf = await readFloat(dir, "noiseprint.f32");
      if (buf.length !== meta.ch * meta.len || NR.print) return;
      NR.print = { sr: meta.sr, ch: meta.ch, len: meta.len, name: String(meta.name || ""), doc: String(meta.doc || ""), a: meta.a || 0, b: meta.b || 0, t: meta.t || 0, data: Array.from({ length: meta.ch }, (_, c) => buf.subarray(c * meta.len, (c + 1) * meta.len)) };
    } catch {}
  })();
  return NR.loaded;
}

async function nrSavePrint() {
  const P = NR.print, dir = await studioDir();
  const all = new Float32Array(P.ch * P.len);
  P.data.forEach((d, c) => all.set(d, c * P.len));
  await writeFile(dir, "noiseprint.f32", new Uint8Array(all.buffer));
  await writeFile(dir, "noiseprint.json", enc({ sr: P.sr, ch: P.ch, len: P.len, name: P.name, doc: P.doc, a: P.a, b: P.b, t: P.t }));
}

function nrStats(x, n, k) {
  const P = NR.print, bins = n / 2 + 1, key = n + ":" + k;
  if (!P) throw new Error("print-none");
  if (NR.stats && NR.stats.key === key && NR.stats.p === P) return NR.stats;
  const st = { key, p: P, n, k, bins, mean: [], lo: [], hi: [], frames: 0 };
  for (let c = 0; c < P.ch; c++) {
    wasmF32(x, x.np_buf(P.len), P.len).set(P.data[c]);
    const fr = P.len >= n ? x.np_stats(P.len, n, k) : -1;
    if (fr < 8) throw new Error("print-short:" + (n + 8 * Math.floor(n / k)));
    const o = wasmF32(x, x.np_out(), bins * 3);
    st.mean.push(o.slice(0, bins));
    st.lo.push(o.slice(bins, 2 * bins));
    st.hi.push(o.slice(2 * bins));
    st.frames = fr;
  }
  NR.stats = st;
  return st;
}

function nrLam(st, c, ch) {
  if (st.mean.length === ch || st.mean.length === 1) return st.mean[Math.min(c, st.mean.length - 1)];
  if (ch === 1) {
    const o = new Float32Array(st.bins);
    for (const m of st.mean) for (let b = 0; b < st.bins; b++) o[b] += m[b] / st.mean.length;
    return o;
  }
  return st.mean[Math.min(c, st.mean.length - 1)];
}

function nrTune(x, slot, cfg, only) {
  if (x.nr_set(slot, cfg.floor, cfg.amount, cfg.thr, cfg.decay, cfg.link ? 1 : 0, only ? 1 : 0) !== 0) throw new Error(dspError(x));
}

function nrSetup(x, slot, cfg, ch, sr, only) {
  let st;
  if (cfg.auto) {
    if (!NR.auto || NR.auto.doc !== cur || NR.auto.lists !== cur.lists) throw new Error("stale");
    st = nrAutoStats(x, cfg.n, cfg.k);
    if (!st.pts.length) throw new Error("auto-none");
  } else {
    const P = NR.print;
    if (!P) throw new Error("print-none");
    if (P.sr !== sr) throw new Error("print-rate:" + P.sr);
    st = nrStats(x, cfg.n, cfg.k);
  }
  if (x.nr_open(slot, ch, sr, cfg.n, cfg.k) !== 0) throw new Error(dspError(x));
  for (let c = 0; c < ch; c++) wasmF32(x, x.nr_print(slot, c), st.bins).set(cfg.auto ? nrAutoLam(st, 0, c) : nrLam(st, c, ch));
  wasmF32(x, x.nr_curve(slot), st.bins).set(nrCurveBins(cfg.curve, st.bins, sr, cfg.n));
  nrTune(x, slot, cfg, only);
  return { n: cfg.n, k: cfg.k, hop: x.nr_hop(slot), bins: st.bins, auto: cfg.auto ? st : null };
}

function nrInfo() {
  const P = NR.print;
  return P ? { sr: P.sr, ch: P.ch, len: P.len, name: P.name, doc: P.doc, a: P.a, b: P.b, t: P.t } : null;
}

function nrStatsOut(st) {
  return { n: st.n, k: st.k, bins: st.bins, frames: st.frames, mean: st.mean, lo: st.lo, hi: st.hi };
}

function humCfg(m) {
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const o = m && typeof m === "object" ? m : {};
  return { f0: num(o.f0, 10, 1000, 50), n: Math.round(num(o.n, 1, 30, 8)), q: num(o.q, 5, 200, 30), gain: num(o.gain, 0, 60, 30), slope: num(o.slope, -100, 100, 0) / 100 };
}

function humWarm(h, sr) { return Math.ceil(sr * Math.min(4, 5 * h.q / (Math.PI * h.f0))); }

function humTune(x, slot, raw, only) {
  const h = humCfg(raw);
  if (x.dh_set(slot, h.f0, h.n, h.q, h.gain, h.slope, only ? 1 : 0) < 0) throw new Error(dspError(x));
  return h;
}

function fxApi(x, kind, slot) {
  if (kind === "ld") return { reset: () => x.lim_reset(slot), inp: m => x.lim_in(slot, m), run: m => x.lim_run(slot, m), out: () => x.lim_out(slot) };
  return kind === "hum"
    ? { reset: () => x.dh_reset(slot), inp: m => x.dh_in(slot, m), run: m => x.dh_run(slot, m), out: () => x.dh_out(slot) }
    : { reset: () => x.nr_reset(slot), inp: m => x.nr_in(slot, m), run: m => x.nr_run(slot, m), out: () => x.nr_out(slot) };
}

function fxKind(k) { return k === "hum" || k === "ld" ? k : "nr"; }

function ldCfg(m, ch) {
  const o = m && typeof m === "object" ? m : {};
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const gains = Array.isArray(o.gains) && o.gains.length === ch ? o.gains.map(v => num(v, -60, 60, 0)) : null;
  return { gain: num(o.gain, -60, 60, 0), gains, ceil: num(o.ceil, -12, 0, -1), look: num(o.look, 1, 20, 5), rel: num(o.rel, 5, 1000, 25), lim: o.lim !== false };
}

function ldTune(x, slot, raw, ch) {
  const cfg = ldCfg(raw, ch);
  const lat = x.lim_set(slot, cfg.gain, cfg.ceil, cfg.look, cfg.rel, cfg.lim ? 1 : 0);
  if (lat < 0) throw new Error(dspError(x));
  if (cfg.gains) cfg.gains.forEach((g, k) => x.lim_gain(slot, k, g));
  return lat;
}

function fxSetup(x, kind, slot, raw, c, only) {
  const sr = c.meta.sampleRate, ch = c.meta.channels;
  if (kind === "ld") {
    if (x.lim_open(slot, ch, sr) !== 0) throw new Error(dspError(x));
    const lat = ldTune(x, slot, raw, ch);
    return { warm: lat + Math.round(sr * 0.3), key: "ld" };
  }
  if (kind === "hum") {
    if (x.dh_open(slot, ch, sr) !== 0) throw new Error(dspError(x));
    const h = humTune(x, slot, raw, only);
    return { warm: humWarm(h, sr), key: "hum" };
  }
  const cfg = nrCfg(raw, sr);
  const s = nrSetup(x, slot, cfg, ch, sr, only);
  return { warm: s.n + 16 * s.hop, key: cfg.n + ":" + cfg.k + (cfg.auto ? ":auto" : ""), bins: s.bins, n: s.n, curveKey: JSON.stringify(cfg.curve), auto: s.auto };
}

function fxPreview(x, c) {
  const kind = FX.kind, only = FX.mode === "noise";
  const cfg = kind === "nr" ? nrCfg(FX.raw, c.meta.sampleRate) : null;
  const key = kind === "nr" ? cfg.n + ":" + cfg.k + (cfg.auto ? ":auto" : "") : kind;
  const ref = kind === "nr" ? (cfg.auto ? NR.auto : NR.print) : null;
  let pv = FX.pv;
  if (!pv || pv.doc !== c || pv.kind !== kind || pv.key !== key || pv.ref !== ref || (cfg && cfg.auto && pv.autoKey !== NR.auto.key)) {
    const s = fxSetup(x, kind, 0, FX.raw, c, only);
    pv = FX.pv = { doc: c, kind, x, key, ref, autoKey: NR.auto ? NR.auto.key : "", auto: s.auto || null, warm: s.warm, bins: s.bins, n: s.n, curveKey: s.curveKey, api: fxApi(x, kind, 0), ch: c.meta.channels, q: null, qStart: 0, qOff: 0, qLen: 0, drop: 0, inPos: 0, ver: -1 };
    return;
  }
  if (kind === "hum") pv.warm = humWarm(humTune(x, 0, FX.raw, only), c.meta.sampleRate);
  else if (kind === "ld") pv.warm = ldTune(x, 0, FX.raw, c.meta.channels) + Math.round(c.meta.sampleRate * 0.3);
  else {
    const curveKey = JSON.stringify(cfg.curve);
    if (pv.curveKey !== curveKey) {
      wasmF32(x, x.nr_curve(0), pv.bins).set(nrCurveBins(cfg.curve, pv.bins, c.meta.sampleRate, pv.n));
      pv.curveKey = curveKey;
    }
    nrTune(x, 0, cfg, only);
  }
  pv.ver = -1;
}

async function fxConfig(m) {
  const mode = ["proc", "noise"].includes(m.mode) ? m.mode : "off";
  FX.raw = m.cfg || null;
  FX.kind = fxKind(m.kind);
  const c = cur;
  if (mode === "off" || !c) { FX.mode = "off"; FX.pv = null; ringFlush(); return { t: "fxok", info: nrInfo() }; }
  if (FX.kind === "nr") await nrLoadPrint();
  if (FX.kind === "nr" && nrCfg(FX.raw, c.meta.sampleRate).auto) await nrAutoFind(c, m.jobId);
  const x = await dspExports();
  if (cur !== c) return { t: "fxok", info: nrInfo() };
  FX.mode = mode;
  try { fxPreview(x, c); }
  catch (e) { FX.mode = "off"; FX.pv = null; ringFlush(); throw e; }
  ringFlush();
  return { t: "fxok", info: nrInfo() };
}

function fxSeek(pv, p0) {
  const o = Math.max(0, p0 - pv.warm);
  pv.api.reset();
  if (!pv.q) pv.q = Array.from({ length: pv.ch }, () => new Float32Array(1 << 17));
  pv.inPos = o;
  pv.qStart = p0;
  pv.qOff = 0;
  pv.qLen = 0;
  pv.drop = p0 - o;
  pv.ver = cur.ver;
}

function fxFeed(pv) {
  const x = pv.x, ch = pv.ch, m = NR_FEED;
  if (pv.auto) fxLam(x, 0, pv.auto, pv.inPos + m / 2, ch);
  const inb = wasmF32(x, pv.api.inp(m), m * ch);
  readClip(pv.inPos, m, inb, m);
  pv.inPos += m;
  const made = pv.api.run(m);
  if (made < 0) throw new Error(dspError(x));
  const out = wasmF32(x, pv.api.out(), made * ch);
  const from = Math.min(made, pv.drop);
  pv.drop -= from;
  const add = made - from;
  if (!add) return;
  if (pv.qOff + pv.qLen + add > pv.q[0].length) {
    for (const q of pv.q) q.copyWithin(0, pv.qOff, pv.qOff + pv.qLen);
    pv.qOff = 0;
  }
  for (let k = 0; k < ch; k++) pv.q[k].set(out.subarray(k * made + from, (k + 1) * made), pv.qOff + pv.qLen);
  pv.qLen += add;
}

function fxView(p0, run, tmp, stride) {
  const pv = FX.pv, c = cur;
  if (!pv || pv.doc !== c) return;
  if (pv.ver !== c.ver || p0 < pv.qStart || p0 > pv.qStart + pv.qLen) fxSeek(pv, p0);
  const skip = p0 - pv.qStart;
  if (skip > 0) { pv.qOff += skip; pv.qLen -= skip; pv.qStart = p0; }
  while (pv.qLen < run) fxFeed(pv);
  for (let k = 0; k < pv.ch; k++) {
    const q = pv.q[k], o = k * stride;
    for (let i = 0; i < run; i++) tmp[o + i] = q[pv.qOff + i];
  }
}

function ringFlush() {
  if (!play || !ring || !cur) return;
  const ctrl = ring.ctrl, w = Atomics.load(ctrl, 1), r = Atomics.load(ctrl, 2);
  const keep = Math.max(2048, Math.round(cur.meta.sampleRate * 0.06));
  if (w - r <= keep) return;
  Atomics.store(ctrl, 1, r + keep);
  if (Atomics.load(ctrl, 2) > r + keep - 256) { Atomics.store(ctrl, 1, w); return; }
  try { fillRing(); } catch (e) { stopPlay(); postMessage({ t: "playerror", msg: errText(e) }); }
}

const AUTO_STEP = 0.5, AUTO_ABOVE = 3, AUTO_DRIFT = 8, AUTO_SPAN = 10, AUTO_SEGS = 200;

async function nrAutoFind(c, id) {
  const A = NR.auto;
  if (A && A.doc === c && A.lists === c.lists) return A;
  const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len, lists = c.lists, cums = c.cum;
  const H = Math.max(1, Math.round(sr * AUTO_STEP)), W = 2 * H, nb = Math.ceil(F / H);
  const e = new Float64Array(nb);
  const w0 = 2 * Math.PI * 40 / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const b0 = (1 + cs) / 2 / a0, b1 = -(1 + cs) / a0, a1 = -2 * cs / a0, a2 = (1 - al) / a0;
  let z1 = 0, z2 = 0, last = 0;
  const B = 65536, mono = new Float32Array(B), tmp = new Float32Array(B);
  const rd = (src, cc, f, n, out, off) => readSrcOf(c, src, cc, f, n, out, off);
  for (let s0 = 0; s0 < F; s0 += B) {
    const n = Math.min(B, F - s0);
    mono.fill(0, 0, n);
    for (let k = 0; k < ch; k++) {
      readList(lists[k], cums[k], s0, n, tmp, 0, rd);
      for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch;
    }
    for (let i = 0; i < n; i++) {
      const v = mono[i], y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b0 * v - a2 * y;
      e[Math.floor((s0 + i) / H)] += y * y;
    }
    const now = performance.now();
    if (now - last > 120) {
      last = now;
      postMessage({ t: "aprog", id, frac: (s0 + n) / F });
      await new Promise(r => setTimeout(r, 0));
      if (cur !== c || c.lists !== lists) throw new Error("stale");
    }
  }
  const L = [];
  for (let i = 0; i + 1 < nb || (nb === 1 && i === 0); i++) {
    const span = Math.min(W, F - i * H);
    L.push({ a: i * H, b: i * H + span, db: 10 * Math.log10(((e[i] + (i + 1 < nb ? e[i + 1] : 0)) / Math.max(1, span)) + 1e-30) });
    if (nb === 1) break;
  }
  const valid = L.filter(w => w.db > -110 && w.b - w.a >= H);
  const segs = [];
  let clarity = 0;
  if (valid.length) {
    const min = Math.min(...valid.map(w => w.db));
    const sorted = valid.map(w => w.db).sort((p, q) => p - q);
    clarity = sorted[Math.floor(sorted.length / 2)] - min;
    const R = Math.round(AUTO_SPAN / AUTO_STEP);
    for (let i = 0; i < valid.length; i++) {
      const w = valid[i];
      if (w.db > min + AUTO_DRIFT) continue;
      let local = Infinity;
      for (let j = Math.max(0, i - R); j <= Math.min(valid.length - 1, i + R); j++) if (Math.abs(valid[j].a - w.a) <= AUTO_SPAN * sr) local = Math.min(local, valid[j].db);
      if (w.db > local + AUTO_ABOVE) continue;
      const lastSeg = segs[segs.length - 1];
      if (lastSeg && w.a <= lastSeg.b) lastSeg.b = Math.max(lastSeg.b, w.b);
      else segs.push({ a: w.a, b: w.b });
    }
  }
  let keep = segs.filter(s => s.b - s.a >= sr * 0.5);
  if (keep.length > AUTO_SEGS) { const step = keep.length / AUTO_SEGS; keep = Array.from({ length: AUTO_SEGS }, (_, i) => keep[Math.floor(i * step)]); }
  NR.auto = { doc: c, lists, sr, ch, segs: keep, clarity, key: "", stats: null };
  return NR.auto;
}

function nrAutoStats(x, n, k) {
  const A = NR.auto, key = n + ":" + k;
  if (A.key === key) return A.stats;
  const c = A.doc, bins = n / 2 + 1, sr = A.sr, ch = A.ch;
  const rd = (src, cc, f, m, out, off) => readSrcOf(c, src, cc, f, m, out, off);
  const pts = [];
  for (const s of A.segs) {
    const len = Math.min(s.b - s.a, Math.round(sr * NR_MAX));
    if (len < n) continue;
    const mean = [];
    let ok = true;
    for (let q = 0; q < ch && ok; q++) {
      const buf = new Float32Array(len);
      readList(A.lists[q], A.lists[q] === c.lists[q] ? c.cum[q] : cumOf(A.lists[q]), s.a, len, buf, 0, rd);
      wasmF32(x, x.np_buf(len), len).set(buf);
      const fr = x.np_stats(len, n, k);
      if (fr < 8) { ok = false; break; }
      mean.push(wasmF32(x, x.np_out(), bins).slice());
    }
    if (ok) pts.push({ c: (s.a + s.b) / 2, a: s.a, b: s.b, mean });
  }
  const avg = [], lo = [], hi = [];
  for (let q = 0; q < ch; q++) {
    const m = new Float32Array(bins), l = new Float32Array(bins).fill(Infinity), h = new Float32Array(bins);
    for (const p of pts) for (let b = 0; b < bins; b++) { const v = p.mean[q][b]; m[b] += v / pts.length; if (v < l[b]) l[b] = v; if (v > h[b]) h[b] = v; }
    avg.push(m); lo.push(l); hi.push(h);
  }
  A.key = key;
  A.stats = { n, k, bins, pts, mean: avg, lo, hi, frames: pts.length };
  return A.stats;
}

function nrAutoLam(st, pos, q) {
  const p = st.pts;
  if (p.length === 1 || pos <= p[0].c) return p[0].mean[q];
  if (pos >= p[p.length - 1].c) return p[p.length - 1].mean[q];
  let i = 1;
  while (i < p.length - 1 && p[i].c < pos) i++;
  const u = (pos - p[i - 1].c) / Math.max(1, p[i].c - p[i - 1].c), A = p[i - 1].mean[q], B = p[i].mean[q];
  const out = new Float32Array(st.bins);
  for (let b = 0; b < st.bins; b++) out[b] = Math.exp((1 - u) * Math.log(A[b] + 1e-30) + u * Math.log(B[b] + 1e-30));
  return out;
}

function fxLam(x, slot, st, pos, ch) {
  for (let q = 0; q < ch; q++) wasmF32(x, x.nr_print(slot, q), st.bins).set(nrAutoLam(st, pos, q));
  x.nr_prep(slot);
}

async function nrAutoGet(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const A = await nrAutoFind(c, m.jobId);
  const x = await dspExports();
  const cfg = nrCfg(m.cfg, c.meta.sampleRate);
  const st = nrAutoStats(x, cfg.n, cfg.k);
  const total = st.pts.reduce((v, p) => v + Math.min(p.b - p.a, A.sr * NR_MAX), 0);
  return { t: "npauto", info: { segs: st.pts.map(p => ({ a: p.a, b: p.b })), clarity: Math.round(A.clarity * 10) / 10, total }, stats: { n: st.n, k: st.k, bins: st.bins, frames: st.frames, mean: st.mean, lo: st.lo, hi: st.hi } };
}

async function nrCapture(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  await nrLoadPrint();
  const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len;
  const a = clampI(m.a, 0, F), b = clampI(m.b, 0, F);
  if (b <= a) throw new Error("nosel");
  const len = Math.min(b - a, Math.round(sr * NR_MAX));
  const data = Array.from({ length: ch }, (_, k) => { const buf = new Float32Array(len); readList(c.lists[k], c.cum[k], a, len, buf, 0, readSrc); return buf; });
  const x = await dspExports();
  const prev = { print: NR.print, stats: NR.stats };
  NR.print = { sr, ch, len, name: c.meta.name || "", doc: c.meta.id, a, b: a + len, t: Date.now(), data };
  NR.stats = null;
  let st;
  try { st = nrStats(x, nrFft(m.cfg && m.cfg.n, sr), Math.round(Math.max(3, Math.min(16, Number(m.cfg && m.cfg.k) || 7)))); }
  catch (e) { NR.print = prev.print; NR.stats = prev.stats; throw e; }
  if (FX.mode !== "off" && FX.kind === "nr" && cur === c) { try { fxPreview(x, c); ringFlush(); } catch { FX.mode = "off"; FX.pv = null; } }
  await nrSavePrint();
  return { t: "npinfo", info: nrInfo(), stats: nrStatsOut(st) };
}

async function nrGet(m) {
  await nrLoadPrint();
  const out = { t: "npinfo", info: nrInfo(), stats: null, err: null };
  if (!NR.print) return out;
  const sr = cur ? cur.meta.sampleRate : NR.print.sr;
  try { out.stats = nrStatsOut(nrStats(await dspExports(), nrFft(m.cfg && m.cfg.n, sr), Math.round(Math.max(3, Math.min(16, Number(m.cfg && m.cfg.k) || 7))))); }
  catch (e) { out.err = errText(e); }
  return out;
}

function nrRollback(c, s) {
  if (cur !== c || c.ver !== s.ver || c.allocs.length < s.allocs) return;
  c.allocs.length = s.allocs;
  c.sums.length = s.allocs;
  c.heapEnd = s.heapEnd;
  c.pkEnd = s.pkEnd;
  try { c.heap.truncate(s.heapEnd * 4); c.hpk.truncate(s.pkEnd * 4); } catch {}
}

async function fxApply(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const kind = fxKind(m.kind);
  if (kind === "nr") await nrLoadPrint();
  if (kind === "nr" && nrCfg(m.cfg, c.meta.sampleRate).auto) await nrAutoFind(c, m.jobId);
  const x = await dspExports();
  if (cur !== c) throw new Error("stale");
  const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len;
  const a = clampI(m.ra, 0, F), b = m.rb > m.ra ? clampI(m.rb, 0, F) : F;
  if (b <= a) throw new Error("nothing");
  const chans = Array.isArray(m.chans) && m.chans.length === ch && m.chans.some(Boolean) ? m.chans.map(Boolean) : new Array(ch).fill(true);
  const s = fxSetup(x, kind, 1, m.cfg, c, false);
  const api = fxApi(x, kind, 1);
  const lists = c.lists, cums = c.cum;
  const rd = (src, cc, f, n, out, off) => readSrcOf(c, src, cc, f, n, out, off);
  const o = Math.max(0, a - s.warm);
  if (FX.job) FX.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  FX.job = job;
  const snap = { allocs: c.allocs.length, heapEnd: c.heapEnd, pkEnd: c.pkEnd, ver: c.ver };
  const xf = a > 0 || b < F ? Math.min(Math.round(sr * 0.02), Math.floor((b - a) / 4)) : 0;
  const orig = pos => Array.from({ length: ch }, (_, k) => { const v = new Float32Array(xf); readList(lists[k], cums[k], pos, xf, v, 0, rd); return v; });
  const fa = xf && a > 0 ? orig(a) : null, fb = xf && b < F ? orig(b - xf) : null;
  const CH = Math.min(1 << 20, b - a);
  const bufs = Array.from({ length: ch }, () => new Float32Array(CH));
  const segs = Array.from({ length: ch }, () => []);
  let fill = 0, pos = a;
  const flush = () => {
    if (!fill) return;
    for (let k = 0; k < ch; k++) if (chans[k]) segs[k].push([allocData(bufs[k].subarray(0, fill)), 0, 0, fill]);
    pos += fill;
    fill = 0;
  };
  const tick = async frac => {
    const now = performance.now();
    if (now - job.last > 100) { job.last = now; postMessage({ t: "nprog", id: job.id, frac }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  const FEED = 65536;
  let inPos = o, outPos = o;
  api.reset();
  try {
    while (outPos < b) {
      if (s.auto) fxLam(x, 1, s.auto, inPos + FEED / 2, ch);
      const inb = wasmF32(x, api.inp(FEED), FEED * ch);
      for (let k = 0; k < ch; k++) readList(lists[k], cums[k], inPos, FEED, inb, k * FEED, rd);
      inPos += FEED;
      const made = api.run(FEED);
      if (made < 0) throw new Error(dspError(x));
      const out = wasmF32(x, api.out(), made * ch);
      let j = Math.max(outPos, a);
      const j1 = Math.min(outPos + made, b);
      while (j < j1) {
        const take = Math.min(j1 - j, CH - fill);
        for (let k = 0; k < ch; k++) {
          if (!chans[k]) continue;
          const d = bufs[k], off = k * made + (j - outPos);
          d.set(out.subarray(off, off + take), fill);
          if (fa) for (let q = Math.max(j, a); q < Math.min(j + take, a + xf); q++) { const w = (q - a + 0.5) / xf, i = fill + q - j; d[i] = fa[k][q - a] + (d[i] - fa[k][q - a]) * w; }
          if (fb) for (let q = Math.max(j, b - xf); q < Math.min(j + take, b); q++) { const w = (b - q - 0.5) / xf, i = fill + q - j, v0 = fb[k][q - b + xf]; d[i] = v0 + (d[i] - v0) * w; }
        }
        fill += take;
        j += take;
        if (fill === CH) flush();
      }
      outPos += made;
      await tick((outPos - o) / Math.max(1, b - o));
    }
    flush();
    if (pos !== b || cur !== c || c.lists !== lists) throw new Error("changed");
  } catch (e) {
    if (FX.job === job) FX.job = null;
    nrRollback(c, snap);
    throw e;
  }
  if (FX.job === job) FX.job = null;
  return enqueue(() => {
    if (cur !== c || c.lists !== lists) { nrRollback(c, snap); throw new Error("changed"); }
    const next = opPatch(c.lists, segs.map((l, k) => chans[k] ? [[a, b, l]] : null));
    const before = { a: clampI(m.a, 0, c.len), b: clampI(m.b, 0, c.len), cursor: clampI(m.cursor, 0, c.len) };
    const op = kind === "ld" ? (["loud", "norm", "amp"].includes(m.op) ? m.op : "amp") : kind;
    pushHist({ op, a, b, n: kind === "ld" ? Math.round(ldCfg(m.cfg, ch).gain * 10) / 10 : 0, ch: chans.every(Boolean) ? null : chanLabel(chans) }, next, before, before);
    persist();
    return statePayload(m.have, { t: "state", sel: null });
  });
}

async function humFind(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len;
  const a = clampI(m.a, 0, F), b = Math.min(clampI(m.b > m.a ? m.b : F, 0, F), a + sr * 60);
  const len = b - a;
  if (len < sr) throw new Error("hum-short");
  const x = await dspExports();
  const mono = wasmF32(x, x.np_buf(len), len);
  mono.fill(0);
  const tmp = new Float32Array(len);
  for (let k = 0; k < ch; k++) {
    readList(c.lists[k], c.cum[k], a, len, tmp, 0, readSrc);
    for (let i = 0; i < len; i++) mono[i] += tmp[i] / ch;
  }
  const n = x.dh_find(len, sr, Number(m.center) > 0 ? Number(m.center) : 0);
  if (n < 0) throw new Error("hum-short");
  const o = wasmF32(x, x.dh_found(), n).slice();
  return { t: "humfound", a, b, f0: o[0], score: o[1], harmonics: o[2], bin: o[3], prom: o.slice(4, 34), spec: o.slice(34) };
}

async function humResp(m) {
  const sr = cur ? cur.meta.sampleRate : 48000;
  const x = await dspExports();
  if (!FX.graph || FX.graph !== sr) { if (x.dh_open(2, 1, sr) !== 0) throw new Error(dspError(x)); FX.graph = sr; }
  humTune(x, 2, m.cfg, m.mode === "noise");
  const f = Array.isArray(m.freqs) ? m.freqs.slice(0, 2048) : [];
  return { t: "humresp", db: Float32Array.from(f, v => x.dh_resp(2, Number(v) || 1)) };
}

const SP = { gen: 0 };
const SP_TILE = 128;

async function spTiles(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id || c.ver !== m.ver) return;
  const gen = m.gen;
  SP.gen = gen;
  const x = await dspExports();
  const n = m.n, rows = m.rows, spp = m.spp, half = n / 2;
  if (SP.gen !== gen) return;
  if (x.sp_open(n) !== 0 || x.sp_rows(rows, c.meta.sampleRate, m.log ? 1 : 0) !== 0) { postMessage({ t: "specerr", gen, msg: dspError(x) }); return; }
  const lists = c.lists, cums = c.cum, ver = c.ver;
  const rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
  const per = spp <= n / 4 ? 1 : Math.min(4, Math.ceil(spp / (n / 2)));
  let last = performance.now();
  for (const [T, k] of m.tiles) {
    if (SP.gen !== gen || cur !== c || c.lists !== lists || c.ver !== ver) return;
    if (k < 0 || k >= lists.length) continue;
    const f0 = T * SP_TILE * spp, span = SP_TILE * spp, cnt = SP_TILE * per;
    const offs = new Uint32Array(cnt);
    let seg;
    if (span + n <= 1 << 20) {
      const a = Math.floor(f0) - half, len = Math.ceil(span) + n + 2;
      seg = new Float32Array(len);
      readList(lists[k], cums[k], a, len, seg, 0, rd);
      for (let col = 0; col < SP_TILE; col++) for (let i = 0; i < per; i++) offs[col * per + i] = Math.max(0, Math.min(len - n, Math.round(f0 + (col + (i + 0.5) / per) * spp) - half - a));
    } else {
      seg = new Float32Array(cnt * n);
      for (let col = 0; col < SP_TILE; col++) for (let i = 0; i < per; i++) {
        const j = col * per + i;
        readList(lists[k], cums[k], Math.round(f0 + (col + (i + 0.5) / per) * spp) - half, n, seg, j * n, rd);
        offs[j] = j * n;
      }
    }
    wasmF32(x, x.sp_seg(seg.length), seg.length).set(seg);
    const op = x.sp_offs(cnt);
    new Uint32Array(x.memory.buffer, op, cnt).set(offs);
    const len = x.sp_run(SP_TILE, per, m.top, m.range);
    if (len < 0) { postMessage({ t: "specerr", gen, msg: dspError(x) }); return; }
    const ip = x.sp_img();
    const data = new Uint8Array(x.memory.buffer, ip, len).slice();
    postMessage({ t: "spectile", id: c.meta.id, ver, gen, key: m.key, T, k, data }, [data.buffer]);
    const now = performance.now();
    if (now - last > 12) { await new Promise(r => setTimeout(r, 0)); last = performance.now(); }
  }
}

const MDJ = { job: null };
const MDL = { mode: "off", notes: [], buf: null };

function mdJob(m, c) {
  if (MDJ.job) MDJ.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  MDJ.job = job;
  job.tick = async frac => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "mprog", id: job.id, frac: Math.min(1, frac) }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  job.end = () => { if (MDJ.job === job) MDJ.job = null; };
  return job;
}

async function mdScan(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const x = await dspExports(), ch = c.meta.channels, F = c.len;
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  if (b <= a) throw new Error("nothing");
  const use = [];
  for (let k = 0; k < ch; k++) if (!Array.isArray(m.chans) || m.chans[k] !== false) use.push(k);
  if (!use.length) use.push(0);
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const fmin = num(m.fmin, 20, 4000, 63.5), fmax = num(m.fmax, fmin * 1.6, 8000, Math.max(fmin * 1.6, 1076));
  const job = mdJob(m, c), lists = c.lists, ver = c.ver, n = use.length;
  try {
    if (x.md_open(n, c.meta.sampleRate, fmin, fmax) !== 0) throw new Error(dspError(x));
    const B = 65536, rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
    for (let s = a; s < b; s += B) {
      const k = Math.min(B, b - s);
      const p = x.md_in(k, n);
      const inb = new Float32Array(x.memory.buffer, p, k * n);
      use.forEach((ci, j) => readList(lists[ci], c.cum[ci], s, k, inb, j * k, rd));
      if (x.md_feed(k) !== 0) throw new Error(dspError(x));
      await job.tick(0.9 * (s + k - a) / (b - a));
    }
    if (c.lists !== lists) throw new Error("stale");
    const cnt = x.md_finish(num(m.sens, 0, 1, 0.5), num(m.minLen, 0.01, 2, 0.06), m.follow === false ? 0 : 1);
    if (cnt < 0) throw new Error(dspError(x));
    const ip = x.md_info();
    const info = Array.from(new Float64Array(x.memory.buffer, ip, 4));
    const np = x.md_notes();
    const nv = cnt ? Array.from(new Float64Array(x.memory.buffer, np, cnt * 4)) : [];
    const frames = Math.max(0, Math.round(info[3]));
    const tp = x.md_track();
    const track = new Float32Array(frames);
    if (frames) track.set(new Float32Array(x.memory.buffer, tp, frames));
    x.md_close();
    const notes = [];
    for (let i = 0; i < cnt; i++) notes.push([nv[i * 4], nv[i * 4 + 1], Math.round(nv[i * 4 + 2]), Math.round(nv[i * 4 + 3])]);
    await job.tick(1);
    return { t: "midinotes", a, b, ver, notes, track, tuning: info[0], t0: info[1], dt: info[2] };
  } finally { job.end(); }
}

function mdClean(list) {
  const out = [];
  for (const n of Array.isArray(list) ? list : []) {
    if (!Array.isArray(n) || n.length < 4) continue;
    const a = Math.floor(Number(n[0])), b = Math.floor(Number(n[1])), p = Math.round(Number(n[2])), v = Math.round(Number(n[3]));
    if (!(b > a) || !(p >= 0 && p <= 127)) continue;
    out.push([a, b, p, Math.max(1, Math.min(127, v || 100))]);
  }
  out.sort((x, y) => x[0] - y[0]);
  return out;
}

function mdSynth(p0, run, tmp, stride) {
  const c = cur, ch = c.meta.channels, sr = c.meta.sampleRate, p1 = p0 + run, N = MDL.notes;
  if (!MDL.buf || MDL.buf.length < run) MDL.buf = new Float32Array(Math.max(run, 8192));
  const syn = MDL.buf;
  syn.fill(0, 0, run);
  const att = Math.max(1, Math.round(sr * 0.006)), rel = Math.max(1, Math.round(sr * 0.04));
  let lo = 0, hi = N.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (N[mid][1] + rel <= p0) lo = mid + 1; else hi = mid; }
  for (let j = lo; j < N.length; j++) {
    const n = N[j];
    if (n[0] >= p1) break;
    const w = 2 * Math.PI * 440 * Math.pow(2, (n[2] - 69) / 12) / sr, amp = 0.2 * n[3] / 127;
    const i0 = Math.max(p0, n[0]), i1 = Math.min(p1, n[1] + rel);
    for (let i = i0; i < i1; i++) {
      const t = i - n[0];
      let e = t < att ? t / att : 1;
      if (i >= n[1]) e *= 1 - (i - n[1]) / rel;
      const ph = w * t;
      syn[i - p0] += amp * e * (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph));
    }
  }
  const only = MDL.mode === "midi";
  for (let k = 0; k < ch; k++) {
    const o = k * stride;
    for (let i = 0; i < run; i++) tmp[o + i] = only ? syn[i] : tmp[o + i] * 0.6 + syn[i];
  }
}

const TRJ = { job: null };

async function trScan(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const ch = c.meta.channels, F = c.len, sr = c.meta.sampleRate;
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  const hop = Math.max(1, Math.round(sr * TR_HOP)), n = Math.floor((b - a) / hop);
  if (n < 50) throw new Error("short");
  if (TRJ.job) TRJ.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  TRJ.job = job;
  const lists = c.lists, ver = c.ver, pw = new Float64Array(n);
  const W = 1024, buf = new Float32Array(hop * W), rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
  try {
    for (let w0 = 0; w0 < n; w0 += W) {
      const nw = Math.min(W, n - w0), s = a + w0 * hop;
      for (let ci = 0; ci < ch; ci++) {
        readList(lists[ci], c.cum[ci], s, nw * hop, buf, 0, rd);
        for (let i = 0; i < nw; i++) {
          let p = 0;
          for (let j = i * hop, e = j + hop; j < e; j++) { const v = buf[j]; p += v * v; }
          pw[w0 + i] += p;
        }
      }
      const now = performance.now();
      if (now - job.last > 120) { job.last = now; postMessage({ t: "tprog", id: job.id, frac: (w0 + nw) / n }); await new Promise(r => setTimeout(r, 0)); }
      if (job.cancel || cur !== c) throw new Error("cancelled");
    }
    if (c.lists !== lists) throw new Error("stale");
    const db = new Float32Array(n), q = 1 / (hop * ch);
    for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(pw[i] * q + 1e-12);
    return { t: "trenv", a, b, hop, sr, ver, env: trMedian(db, 25) };
  } finally { if (TRJ.job === job) TRJ.job = null; }
}

function trTagClean(t) {
  if (!t || typeof t !== "object") return null;
  const out = {};
  for (const k of ["name", "pos", "title", "artist", "album", "albumArtist", "year", "label", "catno", "country", "genre", "style", "format", "release", "cover"]) {
    const v = t[k];
    if (v !== undefined && v !== null && v !== "") out[k] = String(v).slice(0, k === "cover" ? 600 : 200);
  }
  return Object.keys(out).length ? out : null;
}

const LD = { job: null };

function ldStatsOut(x) {
  const n = x.lm_stats();
  if (n < 0) throw new Error(dspError(x));
  const p = x.lm_out(), v = Array.from(new Float64Array(x.memory.buffer, p, n)), ch = (n - 5) / 2;
  const db = a => a > 0 ? 20 * Math.log10(a) : -Infinity;
  const fin = a => Number.isFinite(a) ? Math.round(a * 100) / 100 : null;
  return { integrated: fin(v[0]), lra: fin(v[1]), st: fin(v[2]), mom: fin(v[3]), tp: v.slice(5, 5 + ch).map(a => fin(db(a))), sp: v.slice(5 + ch, 5 + 2 * ch).map(a => fin(db(a))), secs: v[4] / 10 };
}

function ldJob(m, c) {
  if (LD.job) LD.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  LD.job = job;
  job.tick = async (frac, phase) => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "lprog", id: job.id, frac: Math.min(1, frac), phase: phase || 0 }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || (c && cur !== c)) throw new Error("cancelled");
  };
  job.end = () => { if (LD.job === job) LD.job = null; };
  return job;
}

async function ldFeed(x, ch, a, b, read, job, w0, w1) {
  const B = 65536;
  for (let s = a; s < b; s += B) {
    const n = Math.min(B, b - s);
    const p = x.lm_in(n, ch);
    const inb = new Float32Array(x.memory.buffer, p, n * ch);
    read(s, n, inb);
    if (x.lm_feed(n) !== 0) throw new Error(dspError(x));
    await job.tick(w0 + (w1 - w0) * (s + n - a) / Math.max(1, b - a));
  }
}

async function ldMeasure(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const x = await dspExports(), ch = c.meta.channels, F = c.len;
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  if (b <= a) throw new Error("nothing");
  const job = ldJob(m, c), lists = c.lists, ver = c.ver;
  try {
    if (x.lm_open(ch, c.meta.sampleRate) !== 0) throw new Error(dspError(x));
    const rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
    await ldFeed(x, ch, a, b, (s, n, out) => { for (let k = 0; k < ch; k++) readList(lists[k], c.cum[k], s, n, out, k * n, rd); }, job, 0, 1);
    if (c.lists !== lists) throw new Error("stale");
    return { t: "ldstats", a, b, ver, stats: ldStatsOut(x) };
  } finally { job.end(); }
}

async function ldRef(m) {
  if (cur && cur.meta.id === m.refId) throw new Error("ld-self");
  const dir = await docsDir();
  let docDir, meta, pool = null;
  try {
    docDir = await dir.getDirectoryHandle(String(m.refId));
    meta = await readJson(docDir, "meta.json");
  } catch { throw new Error("ld-ref"); }
  const x = await dspExports(), ch = meta.channels, F = meta.frames;
  const job = ldJob(m, null);
  try {
    try { pool = await syncHandle(await docDir.getFileHandle("pool.f32"), true); } catch { throw new Error("locked"); }
    const d = { meta, pool };
    if (x.lm_open(ch, meta.sampleRate) !== 0) throw new Error(dspError(x));
    await ldFeed(x, ch, 0, F, (s, n, out) => { for (let k = 0; k < ch; k++) poolRead(d, k, s, n, out, k * n); }, job, 0, 1);
    return { t: "ldstats", ref: { id: meta.id, name: meta.name, sr: meta.sampleRate }, stats: ldStatsOut(x) };
  } finally {
    if (pool) { try { pool.close(); } catch {} }
    job.end();
  }
}

async function ldPass(x, c, lists, segs, raw, job, w0, w1) {
  const ch = c.meta.channels, sr = c.meta.sampleRate, B = 32768;
  if (x.lim_open(2, ch, sr) !== 0) throw new Error(dspError(x));
  ldTune(x, 2, raw, ch);
  if (x.lm_open(ch, sr) !== 0) throw new Error(dspError(x));
  const rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
  const total = segs.reduce((v, s) => v + s[1] - s[0], 0);
  let done = 0;
  for (const [s0, s1, pre] of segs) {
    x.lim_reset(2);
    let inPos = pre, outPos = pre;
    while (outPos < s1) {
      const ip = x.lim_in(2, B);
      const inb = new Float32Array(x.memory.buffer, ip, B * ch);
      for (let k = 0; k < ch; k++) readList(lists[k], c.cum[k], inPos, B, inb, k * B, rd);
      inPos += B;
      const made = x.lim_run(2, B);
      if (made < 0) throw new Error(dspError(x));
      const lo = Math.max(outPos, s0), hi = Math.min(outPos + made, s1);
      if (hi > lo) {
        const n = hi - lo, op = x.lim_out(2), out = new Float32Array(x.memory.buffer, op, made * ch).slice();
        const mp = x.lm_in(n, ch), stage = new Float32Array(x.memory.buffer, mp, n * ch);
        for (let k = 0; k < ch; k++) stage.set(out.subarray(k * made + lo - outPos, k * made + hi - outPos), k * n);
        if (x.lm_feed(n) !== 0) throw new Error(dspError(x));
        done += n;
      }
      outPos += made;
      await job.tick(w0 + (w1 - w0) * done / Math.max(1, total), 1);
    }
  }
  const st = ldStatsOut(x);
  return { out: st.integrated, gr: x.lim_gr(2), tp: Math.max(...st.tp.map(v => v === null ? -Infinity : v)) };
}

async function ldFit(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const x = await dspExports(), sr = c.meta.sampleRate, F = c.len;
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  const lin = Number(m.lin), target = Number(m.target);
  if (!Number.isFinite(lin)) throw new Error("ld-silent");
  if (!Number.isFinite(target)) throw new Error("nothing");
  const job = ldJob(m, c), lists = c.lists;
  try {
    const len = b - a, piece = 10 * sr;
    let segs;
    if (len <= 3 * 60 * sr) segs = [[a, b, a]];
    else {
      segs = [];
      for (let i = 0; i < 18; i++) { const s0 = a + Math.round(i * (len - piece) / 17); segs.push([s0, s0 + piece, Math.max(a, s0 - sr)]); }
    }
    const raw = Object.assign({}, m.cfg, { lim: true });
    let gain = target - lin, prev = null, best = null, iters = 0;
    for (; iters < 7; iters++) {
      const r = await ldPass(x, c, lists, segs, Object.assign({}, raw, { gain }), job, iters / 7, (iters + 1) / 7);
      if (!Number.isFinite(r.out)) throw new Error("ld-silent");
      best = { gain, out: r.out, gr: r.gr, tp: r.tp };
      if (Math.abs(r.out - target) < 0.05) break;
      const slope = prev && Math.abs(gain - prev.gain) > 1e-3 ? Math.max(0.05, Math.min(1, (r.out - prev.out) / (gain - prev.gain))) : 1;
      if (prev && slope < 0.08 && r.out < target - 0.3) break;
      prev = { gain, out: r.out };
      const next = Math.min(36, gain + Math.min(12, (target - r.out) / slope));
      if (Math.abs(next - gain) < 0.01) break;
      gain = next;
    }
    if (c.lists !== lists) throw new Error("stale");
    return { t: "ldfit", a, b, ver: c.ver, gain: Math.round(best.gain * 100) / 100, out: Math.round(best.out * 100) / 100, gr: Math.round(best.gr * 10) / 10, tp: Math.round(best.tp * 100) / 100, reached: Math.abs(best.out - target) < 0.3, sampled: segs.length > 1 };
  } finally { job.end(); }
}

function opened(req, r) {
  postMessage({ t: "opened", req, meta: r.meta, peaks: r.peaks, bands: r.bands, state: r.state, recovered: r.recovered }, [r.peaks.buffer, r.bands.buffer]);
}

async function handle(m) {
  if (m.t === "cancel") { cancelImport = true; if (downloadCtl) downloadCtl.abort(); return; }
  if (m.t === "ring") { ring = { data: new Float32Array(m.data), ctrl: new Int32Array(m.ctrl), size: m.size }; return; }
  if (m.t === "play") { startPlay(m.start, m.end, m.loop, m.off); return; }
  if (m.t === "stop") { stopPlay(); return; }
  if (m.t === "read") {
    if (!cur || cur.meta.id !== m.id) { postMessage({ t: "samples", req: m.req, id: m.id, ver: -1, start: m.start, count: 0, data: new Float32Array(0) }); return; }
    const start = Math.max(0, Math.floor(m.start)), count = Math.max(0, Math.min(Math.floor(m.count), 4194304, cur.len - start));
    const data = new Float32Array(count * cur.meta.channels);
    if (count) readClip(start, count, data, count);
    postMessage({ t: "samples", req: m.req, id: m.id, ver: cur.ver, start, count, data }, [data.buffer]);
    return;
  }
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
        opened(m.req, await enqueue(() => openDoc(meta.id)));
      } catch (err) { postMessage({ t: "error", req: m.req, msg: errText(err), name: m.file ? m.file.name : m.name }); }
      if (tmp) { try { await (await tmpDir()).removeEntry(tmp); } catch {} }
    });
    importing = job;
    return;
  }
  if (m.t === "open") { await importing; opened(m.req, await enqueue(() => openDoc(m.id))); return; }
  if (m.t === "close") { await enqueue(closeCur); postMessage({ t: "closed", req: m.req }); return; }
  if (m.t === "remove") {
    await importing;
    await enqueue(async () => {
      if ((cur && cur.meta.id === m.id && cur.busy > 0) || lingering.has(m.id)) throw new Error("exporting");
      if (cur && cur.meta.id === m.id) await closeCur();
      await (await docsDir()).removeEntry(m.id, { recursive: true });
    });
    postMessage({ t: "removed", req: m.req, id: m.id });
    return;
  }
  if (m.t === "edit") { postMessage(Object.assign({ req: m.req }, await enqueue(() => applyEdit(m)))); return; }
  if (m.t === "undo" || m.t === "redo" || m.t === "jump") { postMessage(Object.assign({ req: m.req }, await enqueue(() => moveHist(m)))); return; }
  if (m.t === "export") { postMessage(Object.assign({ req: m.req }, await enqueue(() => queueExport(m)))); return; }
  if (m.t === "xcancel") { const j = XP.jobs.find(x => x.id === m.id); if (j) { j.cancel = true; if (j.state === "queued") { j.state = "cancelled"; xpost(j); releaseDoc(j.c); j.c = null; j.lists = null; } } return; }
  if (m.t === "xremove") {
    const i = XP.jobs.findIndex(x => x.id === m.id);
    if (i >= 0 && !["queued", "rendering", "hashing", "uploading", "verifying"].includes(XP.jobs[i].state)) { const j = XP.jobs.splice(i, 1)[0]; try { await (await exportsDir()).removeEntry(j.file); } catch {} }
    return;
  }
  if (m.t === "dscan") {
    try { postMessage(Object.assign({ req: m.req }, await (m.kind === "clip" ? rpScanClip(m) : rpScan(m)))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "dcancel") { if (RP.job) RP.job.cancel = true; return; }
  if (m.t === "drepair") { postMessage(Object.assign({ req: m.req }, await enqueue(() => rpRepair(m)))); return; }
  if (m.t === "dlisten") { RP.listen = ["repaired", "removed"].includes(m.mode) ? m.mode : "off"; return; }
  if (m.t === "dclear") { RP.scan = null; RP.listen = "off"; return; }
  if (m.t === "dstate") { postMessage({ t: "dresult", req: m.req, diag: rpSummary() }); return; }
  if (m.t === "npget" || m.t === "npcap" || m.t === "npauto" || m.t === "fxcfg" || m.t === "humfind" || m.t === "humresp") {
    const f = { npget: nrGet, npcap: nrCapture, npauto: nrAutoGet, fxcfg: fxConfig, humfind: humFind, humresp: humResp }[m.t];
    try { postMessage(Object.assign({ req: m.req }, await f(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "spec") { await spTiles(m); return; }
  if (m.t === "ldmeasure" || m.t === "ldref" || m.t === "ldfit") {
    const f = { ldmeasure: ldMeasure, ldref: ldRef, ldfit: ldFit }[m.t];
    try { postMessage(Object.assign({ req: m.req }, await f(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "ldcancel") { if (LD.job) LD.job.cancel = true; return; }
  if (m.t === "midiscan") {
    try { postMessage(Object.assign({ req: m.req }, await mdScan(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "mdcancel") { if (MDJ.job) MDJ.job.cancel = true; return; }
  if (m.t === "trscan") {
    try { postMessage(Object.assign({ req: m.req }, await trScan(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "trcancel") { if (TRJ.job) TRJ.job.cancel = true; return; }
  if (m.t === "mdlisten") { MDL.mode = ["midi", "both"].includes(m.mode) ? m.mode : "off"; MDL.notes = MDL.mode === "off" ? [] : mdClean(m.notes); ringFlush(); return; }
  if (m.t === "fxapply") { postMessage(Object.assign({ req: m.req }, await fxApply(m))); return; }
  if (m.t === "fxcancel") { if (FX.job) FX.job.cancel = true; return; }
  if (m.t === "adjust") { postMessage(Object.assign({ req: m.req }, await enqueue(() => adjustSel(m)))); return; }
  if (m.t === "flush") { await enqueue(async () => { if (cur && cur.saving) await cur.saving; }); postMessage({ t: "flushed", req: m.req, err: cur ? cur.saveErr : null }); return; }
}

onmessage = e => {
  const m = e.data;
  handle(m).catch(err => postMessage({ t: "error", req: m.req, msg: errText(err) }));
};

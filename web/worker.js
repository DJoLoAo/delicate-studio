importScripts("/studio/edit.js");

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
  return (await studioDir()).getDirectoryHandle("docs", { create: true });
}

async function wasmMod() {
  if (!wasmModule) wasmModule = await WebAssembly.compileStreaming(fetch("/studio/studio-dsp.wasm"));
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

function poolRead(c, f, n, out, off) {
  const ch = cur.meta.channels;
  let done = 0;
  while (done < n) {
    const p = f + done, s = Math.floor(p / BLOCK), o = p % BLOCK;
    const run = Math.min(n - done, BLOCK - o);
    cur.pool.read(new Uint8Array(out.buffer, out.byteOffset + (off + done) * 4, run * 4), { at: (s * BLOCK * ch + c * BLOCK + o) * 4 });
    done += run;
  }
}

function readSrc(src, c, f, n, out, off) {
  if (n <= 0) return;
  if (src === 0) { poolRead(c, f, n, out, off); return; }
  const a = cur.allocs[src];
  cur.heap.read(new Uint8Array(out.buffer, out.byteOffset + off * 4, n * 4), { at: (a[0] + f) * 4 });
}

function readClip(start, count, out, stride) {
  const c = cur;
  for (let k = 0; k < c.lists.length; k++) readList(c.lists[k], c.cum[k], start, count, out, k * stride, readSrc);
}

function allocBegin() {
  return { off: cur.heapEnd, n: 0, S: summer(cur.meta.sampleRate) };
}

function allocPush(w, d, n) {
  cur.heap.write(new Uint8Array(d.buffer, d.byteOffset, n * 4), { at: (w.off + w.n) * 4 });
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
  cur.hpk.write(new Uint8Array(both.buffer), { at: pkOff * 4 });
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
        h.write(new Uint8Array(buf.buffer, 0, n * 4), { at: (k * cb.n + f) * 4 });
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
    case "markadd":
    case "markset":
    case "markdel": {
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

async function closeCur() {
  stopPlay();
  const c = cur;
  if (!c) return;
  if (c.saving) { try { await c.saving; } catch {} }
  if (clip && !clip.file && clip.doc === c.meta.id) { try { await materializeClip(); } catch { clip = null; } }
  for (const h of [c.pool, c.heap, c.hpk]) { if (h) { try { h.close(); } catch {} } }
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


async function openDoc(id, have) {
  const dir = await docsDir();
  const docDir = await dir.getDirectoryHandle(id);
  const meta = await readJson(docDir, "meta.json");
  const slotPeaks = await readFloat(docDir, "peaks.f32");
  const bands = await readFloat(docDir, "bands.f32");
  await closeCur();
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
  cur = { meta, pool, heap, hpk, dir: docDir, heapEnd: heapFrames, pkEnd: pkFloats, allocs: [null], sums: [null], hist: null, idx: 0, seq: 0, lists: null, cum: null, len: 0, edges: new Map(), ver: 0, saving: null, dirty: false, saveErr: null };
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
    cur.hist = [{ op: "open", a: 0, b: 0, n: 0, ch: null, t: meta.created || Date.now(), lists: origLists(meta), marks: [], d: null, full: false, before: null, after: null }];
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
      readClip(p, run, play.tmp, CHUNK);
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
      if (cur && cur.meta.id === m.id) await closeCur();
      await (await docsDir()).removeEntry(m.id, { recursive: true });
    });
    postMessage({ t: "removed", req: m.req, id: m.id });
    return;
  }
  if (m.t === "edit") { postMessage(Object.assign({ req: m.req }, await enqueue(() => applyEdit(m)))); return; }
  if (m.t === "undo" || m.t === "redo" || m.t === "jump") { postMessage(Object.assign({ req: m.req }, await enqueue(() => moveHist(m)))); return; }
  if (m.t === "adjust") { postMessage(Object.assign({ req: m.req }, await enqueue(() => adjustSel(m)))); return; }
  if (m.t === "flush") { await enqueue(async () => { if (cur && cur.saving) await cur.saving; }); postMessage({ t: "flushed", req: m.req, err: cur ? cur.saveErr : null }); return; }
}

onmessage = e => {
  const m = e.data;
  handle(m).catch(err => postMessage({ t: "error", req: m.req, msg: errText(err) }));
};
